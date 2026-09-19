// ─── ACE: QOL — Reaction Engine ─────────────────────────────────────────────
// Automates D&D 5e reactions: Shield, Counterspell, Absorb Elements,
// Legendary Resistance, Silvery Barbs, Cutting Words, and OA tracking.
//
// Design:
//   - Each combatant gets ONE reaction per round (PHB 2024/2014 rule).
//   - Reactions reset at the START of each combatant's turn.
//   - Prompts are socket-routed to the owning player (or GM for NPCs).
//   - Timeout: configurable (default 10s), auto-decline on expiry.
//   - All checks are defensive: reaction used? spell prepared? slots? range?
//
// Integration points (called from other engines):
//   AttackPipeline → checkPostHitReactions()   — Shield
//   SaveEngine     → checkPostSaveReactions()  — Legendary Resistance, Silvery Barbs
//   SpellCast hook → checkPreSpellReactions()   — Counterspell
//   DamageEngine   → checkPreDamageReactions()  — Absorb Elements
//   AttackPipeline → checkPostAttackReactions() — Silvery Barbs (on attack success)
//   AttackPipeline → checkPreFinalizeReactions() — Cutting Words (on attack roll)
// ──────────────────────────────────────────────────────────────────────────────

// NOTE: MODULE_ID hardcoded to avoid circular import (ace-qol.mjs imports us)
const MODULE_ID = "ace-qol";
import { QolSettings } from "./settings.mjs";
// The shared "why didn't that happen" reporters. ONE implementation for the
// whole roll path - these methods used to hold a second copy, which is the
// "built beside instead of on" mistake this codebase has paid for before.
import { gateOff as _gateOff, cannotDo as _cannotDo } from "./why-not.mjs";
// Wait for the condition, not for the clock. See wait-for.mjs.
import { waitUntil } from "./wait-for.mjs";
import { CombatState } from "./combat-state.mjs";
import { hasTurns } from "./action-economy.mjs";
// ⚠️ THE ONE SPELL-NAME KEY. "Fire Shield" contains "shield" (2026-09-16).
import { spellKey } from "./rules/spell-name.mjs";
// ⚠️ THE ONE READER for "does this creature hold that spell, ready to cast".
// The copy that used to live in this file asked for a dnd5e 3.x mode name and
// so refused every slot caster in the world. See rules/spell-ready.mjs.
import { hasReadySpell } from "./rules/spell-ready.mjs";
// ⚠️ THE ONE READER FOR "is this creature out of the fight": dead, unconscious,
// incapacitated, paralyzed, stunned or petrified. None of them take reactions.
import { isOutOfTheFight } from "./is-down.mjs";
// ⚠️ THE ONE EDITION READER. The ITEM's own ruleset wins over the world's
// setting, and it has to: his world holds both editions of Counterspell side by
// side, and Varek carries one of each.
import { RulesBrain } from "./rules/rules-brain.mjs";
// ⚠️ THE ONE ANSWER TO "who decides this creature's reaction": its connected
// player, else the GM. The opportunity attack asks the same file, so the two
// cannot route differently again (2026-09-18).
import { whoAnswers } from "./who-answers.mjs";
// The ding a box makes on the screen of whoever has to answer it.
import { popupDing } from "./popup-ding.mjs";

// ═══════════════════════════════════════════════════════════════════════════════
//  Constants
// ═══════════════════════════════════════════════════════════════════════════════

const SOCKET_NAME = `module.${MODULE_ID}`;
const FLAG_REACTION_USED = "reactionUsed";

/** Elemental damage types that trigger Absorb Elements */
const ABSORB_ELEMENT_TYPES = new Set(["acid", "cold", "fire", "lightning", "thunder"]);

/** Default timeout for reaction prompts (seconds) */
const DEFAULT_TIMEOUT = 10;

// ═══════════════════════════════════════════════════════════════════════════════
//  ReactionEngine
// ═══════════════════════════════════════════════════════════════════════════════

export class ReactionEngine {

  /**
   * v0.7.17b — Cast barrier registry (2026-06-07).
   * Map of activity-ref → { promise, resolve, resolved, createdAt }.
   *
   * Why this exists:
   *   Foundry's Hooks.on fires every listener in parallel. The Counterspell
   *   handler in _onSpellCast is `async` and awaits the user's prompt — but
   *   the other listeners on the same hook (SpellAutoDamage, Forge FX,
   *   AA triggers, dnd5e's own chat-card creation) DON'T wait. They race
   *   ahead and post the damage card / play the animation BEFORE the user
   *   has even clicked the Counterspell prompt. Result: clicking "Cast
   *   Counterspell" appeared to do nothing because the spell already fully
   *   resolved.
   *
   * The fix:
   *   At `dnd5e.preUseActivity` (which fires BEFORE postCreateUsageMessage),
   *   reaction-engine creates a barrier Promise and stores it keyed by the
   *   activity object reference. Other engines call
   *   `ReactionEngine.awaitCastBarrier(activity)` at the top of their
   *   postCreateUsageMessage handler and await the promise before doing
   *   anything. Reaction-engine resolves the barrier once the user has
   *   decided — with { abort: true } on a successful counterspell,
   *   { abort: false } otherwise. Downstream handlers bail or proceed
   *   based on the abort flag.
   *
   * Safety net: every barrier auto-resolves after 30s in case the
   * reaction handler never finishes (timeout, error, etc.).
   */
  static _castBarriers = new Map();

  /** Reaction boxes opened on this client, for their ids (see _announceBox). */
  static _boxCounter = 0;

  /** A cast's hold lets go by itself after this long if nothing released it. */
  static barrierSafetyMs = 30000;

  /**
   * How long a box sent to somebody else's screen has to say it opened. With
   * no word in that time it counts as a box that failed to open (2026-09-18).
   */
  static remoteAckMs = 5000;

  /**
   * v0.7.265 — Counterspell NATIVE-resolution cleanup.
   * The cast barrier stops ACE's OWN downstream engines when a spell is
   * countered — but dnd5e resolves SUMMONS and zone TEMPLATES natively, which
   * ACE never touches, so the barrier can't stop them and the summoned
   * creature / template lands anyway. This kill-list records recently
   * counterspelled casts. A reactive sweep (in _onSpellCast) deletes anything
   * already placed; postSummon / createMeasuredTemplate hooks delete anything
   * that lands AFTER the async counter prompt resolves (the common case — the
   * prompt usually finishes after dnd5e has already summoned). Match is by the
   * casting item's uuid, carried on summoned tokens (flags.dnd5e.summon.origin)
   * and templates (flags.dnd5e.origin).
   */
  static _counterspelledCasts = [];   // [{ itemUuid, activityUuid, actorId, itemId, casterName, casterTokenUuid, expiresAt }]
  /**
   * The one move a countered spell still had in it: actorId -> { until, spell }.
   *
   * ⚠️🔴 ONE MOVE, NOT TEN MINUTES. Johnny, 2026-09-17: "After the counter,
   * she cannot WALK on her turn. The untagged-write block is still on. That lock
   * is only for the countered teleport finishing." He is right, and the previous
   * version was worse than the bug it fixed: it read the kill record, which
   * lives ten minutes so a card or a template can still be recognised, and used
   * it to refuse writes for that whole time. A creature that has just been
   * counterspelled is not under arrest.
   *
   * So the lock is armed by the counter, spent by the first refused write, and
   * dropped when the aiming gear goes away or the backstop expires - whichever
   * comes first. After that every write is hers again.
   */
  static _teleportLock = new Map();

  /** One Counterspell check per cast: key -> when it was checked. */
  static _castsChecked = new Map();
  static _recentSummonFx = [];        // [{ id, srcUuid, expiresAt }] — summon Sequencer effects seen at creation, for post-counter cleanup

  static _markCastCounterspelled(activity) {
    try {
      const itemUuid = activity?.item?.uuid ?? null;
      const activityUuid = activity?.uuid ?? null;
      // ⚠️🔴 THE ACTOR AND THE ITEM, NOT ONLY THE UUIDS (2026-09-17).
      // dnd5e CLONES the item at the top of `Activity#use` and runs the whole
      // cast on the clone, so the uuid a barrier was keyed on and the uuid
      // stamped on a template do not always survive the journey. Who cast what
      // always does. This is the match that cannot drift.
      const casterActor = activity?.item?.actor ?? activity?.actor ?? null;
      const actorId = casterActor?.id ?? null;
      const itemId = activity?.item?.id ?? null;
      if (!itemUuid && !activityUuid && !(actorId && itemId)) return;
      // Caster's token uuid — some summon animations (Automated Animations) play
      // ON THE CASTER with origin=null, so we clean those up by source token.
      let casterTokenUuid = null;
      try { casterTokenUuid = casterActor?.getActiveTokens?.()?.[0]?.document?.uuid ?? null; } catch (_) {}
      ReactionEngine._counterspelledCasts.push({
        itemUuid, activityUuid, actorId, itemId, casterTokenUuid,
        // ⚠️ WHEN, NOT ONLY WHETHER. The ten-minute life is right for a card, a
        // template or a clip - all of which belong to this cast and nothing
        // else. It is far too long for a MOVE: a creature that legitimately
        // teleports nine minutes later would be frozen in place. The move guard
        // reads this instead.
        at: Date.now(),
        casterName: activity?.item?.actor?.name ?? "?",
        // ⚠️🔴 THIRTY SECONDS WAS NOT A WINDOW, IT WAS AN AMNESTY. Johnny,
        // 2026-09-17: "After I waited and advanced the turn, the Dex saves
        // finally posted." A countered spell does not come back to life because
        // half a minute passed. Ten minutes outlives any placement, any dialog
        // left open, and a turn or two of a real table.
        expiresAt: Date.now() + 600000,
      });
      console.log(`${MODULE_ID} | "${activity?.item?.name ?? "that cast"}" is dead. `
        + `Nothing further resolves for it: no template, no save, no damage, no card.`);
    } catch (_) { /* non-fatal */ }
  }

  /**
   * Write the counterspelled flag on the cast's own chat card.
   *
   * ⚠️🔴 "message" IS WHATEVER THE CALLER HAD, NOT A ChatMessage (2026-09-17).
   * `message.setFlag is not a function` at his table. This argument arrives from
   * three places and only one of them is guaranteed to be a document: dnd5e's
   * own hook hands one over, the legacy path passes null, and the player-cast
   * socket path looks one up by id and can come back with nothing. On some
   * builds the hook hands over the message DATA rather than the document. A
   * thrown TypeError here lands in the middle of the countered branch, which is
   * the worst possible place for one.
   *
   * So: resolve it to a real document if we can, use setFlag if it exists, fall
   * back to a plain update, and if neither is there say so and carry on. The
   * flag is a convenience for other engines; the kill-list is the authority, and
   * nothing downstream depends on this line succeeding.
   */
  static async _flagMessageCounterspelled(message, data) {
    try {
      let doc = message ?? null;
      // A bare id, or something with one that is not a document.
      if (doc && typeof doc.setFlag !== "function" && typeof doc.update !== "function") {
        const id = typeof doc === "string" ? doc : (doc.id ?? doc._id ?? null);
        doc = id ? (globalThis.game?.messages?.get?.(id) ?? null) : null;
      }
      if (!doc) {
        ReactionEngine._sdebug("[COUNTER] no chat card to flag for this cast (the kill-list still has it)");
        return false;
      }
      if (typeof doc.setFlag === "function") {
        await doc.setFlag(MODULE_ID, "counterspelled", data);
        return true;
      }
      if (typeof doc.update === "function") {
        await doc.update({ [`flags.${MODULE_ID}.counterspelled`]: data });
        return true;
      }
      console.warn(`${MODULE_ID} | the cast's chat card could not be flagged as counterspelled `
        + `(it is a ${typeof doc}, not a document). The counter still stands - the kill-list is what decides.`);
      return false;
    } catch (err) {
      console.warn(`${MODULE_ID} | could not flag the cast's chat card as counterspelled; `
        + `the counter still stands:`, err);
      return false;
    }
  }

  /**
   * Was this creature's cast called off moments ago, in the window where the
   * spell's own finishing touches are still arriving?
   *
   * ⚠️🔴 A COUNTERED MISTY STEP STILL MOVED PATRINA (Johnny, 2026-09-17).
   * The card was right, the save was gone, and the token still went. ACE has no
   * destination executor - nothing in this suite moves a token for a spell - so
   * the move comes from whatever his table has automating it, and the only
   * honest way to stop that without naming a spell is to refuse the MOVE ITSELF
   * when it belongs to a cast that just died.
   *
   * ⚠️ WHICH IS WHY IT IS A NARROW WINDOW AND A TELEPORT ONLY. "This creature
   * was countered at some point in the last ten minutes" must never stop it
   * walking. A teleport-tagged move by the caster, within seconds of its own
   * spell being countered, is the spell finishing - and nothing else looks like
   * that.
   *
   * @param {Actor} actor
   * @param {number} [withinMs]
   */
  static castJustDied(actor, withinMs = 6000) {
    // ⚠️ THE CALLER SETS THE WINDOW. An untagged move is the spell finishing
    // however long the person took to click, so that caller asks for the
    // record's whole life; anything judged on the instant asks for seconds.
    try {
      const id = actor?.id ?? null;
      if (!id) return null;
      const now = Date.now();
      return ReactionEngine._counterspelledCasts.find(c =>
        c.actorId === id && c.expiresAt > now && (now - (c.at ?? 0)) <= withinMs) ?? null;
    } catch (_) { return null; }
  }

  /**
   * Take the spell off the mouse.
   *
   * ⚠️🔴 AFTER A YES, THE CURSOR WAS STILL CARRYING A FIREBALL. Johnny,
   * 2026-09-17: "dnd5e starts the Fireball preview WHILE the Counterspell prompt
   * is open. After Yes the mouse can still drop a template." It can, because
   * `Activity#use` goes straight from the usage message to `#placeTemplate`
   * without awaiting anything, and `drawPreview` then sits on a promise waiting
   * for a click that may come long after the spell is dead.
   *
   * ⚠️ THIS CANCELS, IT DOES NOT PLACE. ACE has no business creating a
   * template - it tried that in 0.34.40 and broke Fireball outright. Cancelling
   * a preview is the same thing a right-click does, through the system's own
   * handler, on the system's own object. Nothing is created, nothing is aimed,
   * and if dnd5e ever renames that handler this quietly does nothing rather than
   * throwing in the middle of a counter.
   */
  static async cancelTemplatePreview(why = "the cast was counterspelled") {
    try {
      const previews = [...(globalThis.canvas?.templates?.preview?.children ?? [])];
      let cancelled = 0;
      for (const preview of previews) {
        if (typeof preview?._onCancelPlacement !== "function") continue;
        try {
          await preview._onCancelPlacement(new Event("contextmenu"));
          cancelled += 1;
        } catch (_) { /* the reject is the cancel; there is nothing to catch */ }
      }
      if (cancelled) {
        console.log(`${MODULE_ID} | took the area off the cursor (${cancelled}) - ${why}.`);
        // ⚠️ NOTHING LEFT TO AIM MEANS NOTHING LEFT TO REFUSE. If the crosshair
        // is gone the spell cannot finish, so the hold on the caster's movement
        // has no job left and is dropped rather than waiting to be spent on a
        // step she takes herself.
        ReactionEngine._teleportLock.clear();
      }
      return cancelled;
    } catch (err) {
      console.warn(`${MODULE_ID} | could not take the area off the cursor; right-click to drop it:`, err);
      return 0;
    }
  }

  /**
   * PUBLIC. Is this cast dead - counterspelled, and therefore finished?
   *
   * ⚠️ FOUR WAYS TO RECOGNISE IT, because one was not enough. An activity
   * uuid, an item uuid that a template's origin begins with, or the plain fact
   * of WHO cast WHAT. The last one is the one that cannot drift: dnd5e clones
   * the item for the duration of a cast, so uuids can differ between the moment
   * a barrier is raised and the moment a template carries an origin, while the
   * actor and the item id never do.
   *
   * @param {{origin?: string, item?: Item, actor?: Actor, activity?: object}} what
   */
  static castIsDead(what = {}) {
    const now = Date.now();
    ReactionEngine._counterspelledCasts = ReactionEngine._counterspelledCasts.filter(c => c.expiresAt > now);
    if (!ReactionEngine._counterspelledCasts.length) return false;

    const activity = what.activity ?? null;
    const item = what.item ?? activity?.item ?? null;
    const actor = what.actor ?? item?.actor ?? activity?.actor ?? null;
    const origin = what.origin ?? activity?.uuid ?? null;
    const itemUuid = item?.uuid ?? null;
    const actorId = actor?.id ?? null;
    const itemId = item?.id ?? null;

    // ⚠️🔴 A UUID CANNOT TELL TWO CASTS OF ONE SPELL APART, AND I BUILT A
    // RULE ON THE BELIEF THAT IT COULD (2026-09-17, caught by the replay inside
    // a minute). When the same wizard casts Fireball again, it is the same item
    // and the same activity, so the SAME activity uuid: there is no identifier
    // anywhere that separates this cast from the last one. The only thing that
    // does is a new cast starting, which is why `_createCastBarrier` clears the
    // record for that creature and that item - see the note there. That is the
    // protection for his next Fireball, and it is the only one available.
    //
    // So all four routes stand, and a door may ask with whatever it has: a
    // template carries the activity's uuid, an animation is tagged with the
    // item's, and the flourish and the save being armed have neither and offer
    // who cast what instead.
    return ReactionEngine._counterspelledCasts.some(c => {
      if (c.activityUuid && origin && origin === c.activityUuid) return true;
      if (c.itemUuid && typeof origin === "string" && origin.startsWith(c.itemUuid)) return true;
      if (c.itemUuid && itemUuid && itemUuid === c.itemUuid) return true;
      if (c.actorId && c.itemId && actorId && itemId && c.actorId === actorId && c.itemId === itemId) return true;
      return false;
    });
  }

  /** True if `origin` (a token/template dnd5e origin string) traces to a
   *  recently counterspelled cast. Prunes expired entries as it scans. */
  static _isCounterspelledOrigin(origin) {
    if (!origin) return false;
    return ReactionEngine.castIsDead({ origin });
  }

  /**
   * v0.7.265 — Reactive sweep: on a successful counter, delete anything dnd5e
   * already resolved natively for THIS cast that the barrier can't stop —
   * summoned tokens + the cast's own zone template. Straggler hooks catch
   * whatever lands after this runs. GM-only (deletes need GM perms).
   */
  static async _sweepCounterspelledResolution(activity) {
    try {
      // SILENT-OK: not the active GM; this hook fires on every connected client and only one may act
      if (game.users?.activeGM !== game.user) return;
      const itemUuid = activity?.item?.uuid ?? null;
      const activityUuid = activity?.uuid ?? null;
      const matches = (origin) => !!origin && typeof origin === "string" && (
        (activityUuid && origin === activityUuid) ||
        (itemUuid && origin.startsWith(itemUuid))
      );

      // 1) Summoned tokens.
      const tokenIds = [];
      for (const t of (canvas?.scene?.tokens ?? [])) {
        const so = t.actor?.getFlag?.("dnd5e", "summon.origin") ?? t.actor?.flags?.dnd5e?.summon?.origin;
        if (matches(so)) tokenIds.push(t.id);
      }
      if (tokenIds.length) {
        await canvas.scene.deleteEmbeddedDocuments("Token", tokenIds);
        ReactionEngine._sdebug(`[COUNTER-CLEANUP] deleted ${tokenIds.length} summoned token(s)`);
      }

      // 2) Zone template(s), and anything else aiming this cast.
      //
      // ⚠️🔴 A TEMPLATE THAT IS NOT dnd5e'S STILL BELONGS TO SOMEBODY
      // (2026-09-17). His red targeting line came from ddb-importer's own macro,
      // which draws a range circle flagged `spellEffects.<name> = actorId` - no
      // `flags.dnd5e.origin` anywhere on it, so a sweep that only reads dnd5e's
      // flag left it on the map with nothing to clear it but the click we are
      // trying to prevent.
      //
      // ⚠️ MATCHED BY THE CASTER'S OWN ID, NOT BY A MODULE OR A SPELL NAME. A
      // template that names this creature, placed for a cast of theirs that has
      // just been counterspelled, is that cast's aiming gear whoever drew it.
      // Nothing here knows or cares which module or which spell.
      const casterId = (activity?.item?.actor ?? activity?.actor)?.id ?? null;
      const namesTheCaster = (flags) => {
        if (!casterId || !flags || typeof flags !== "object") return false;
        for (const ns of Object.values(flags)) {
          if (!ns || typeof ns !== "object") continue;
          for (const v of Object.values(ns)) if (v === casterId) return true;
        }
        return false;
      };
      const tplIds = [];
      for (const tpl of (canvas?.scene?.templates ?? [])) {
        if (matches(tpl?.flags?.dnd5e?.origin) || namesTheCaster(tpl?.flags)) tplIds.push(tpl.id);
      }
      if (tplIds.length) {
        await canvas.scene.deleteEmbeddedDocuments("MeasuredTemplate", tplIds);
        ReactionEngine._sdebug(`[COUNTER-CLEANUP] deleted ${tplIds.length} template(s)`);
      }

      // 3) End any Sequencer effects tied to this cast. Automated Animations
      //    plays a summon flourish (JB2A) via .origin(item.uuid), so a countered
      //    summon's animation would otherwise linger on the caster with no fey.
      ReactionEngine._endCounterspelledCastEffects();
    } catch (err) {
      console.warn(`${MODULE_ID} | counterspell cleanup sweep failed (non-fatal):`, err);
    }
  }

  /** v0.7.273 — End Sequencer effects tied to a counterspelled cast. Two match
   *  routes, because animation modules tag effects inconsistently:
   *    (a) origin — some modules set `.origin(item.uuid)`; match it directly.
   *    (b) Automated Animations plays a summon flourish ON THE CASTER'S token
   *        with origin=null (proven via live probe: file
   *        "autoanimations.static.magicsign.conjuration…", source = caster token).
   *        So also end any conjuration/summon-type effect SOURCED at the
   *        counterspelled caster's token. The file/name pattern keeps it off
   *        ACE's own counterspell bursts (jb2a.shield / jb2a.healing_generic,
   *        which don't match) and off unrelated caster auras.
   *  Ends by effect id (precise) via endEffects, which broadcasts the removal to
   *  every client. Fire-and-forget. No-op without Sequencer / when nothing is
   *  pending. */
  static _endCounterspelledCastEffects() {
    try {
      const EM = globalThis.Sequencer?.EffectManager;
      if (!EM?.getEffects || !EM?.endEffects) return;
      const now = Date.now();
      const casts = ReactionEngine._counterspelledCasts.filter(c => c.expiresAt > now);
      if (!casts.length) return;
      const casterUuids = new Set(casts.map(c => c.casterTokenUuid).filter(Boolean));
      const SUMMON_FX = /conjuration|summon|magic.?sign|portal|autoanimations\.static/i;
      const toEnd = [];
      for (const fx of (EM.getEffects() ?? [])) {
        const d = fx?.data ?? {};
        // ⚠️ ANY CLIP THAT BELONGS TO A DEAD CAST, not only one whose file name
        // looks like a summon. Johnny, 2026-09-17: "Dead cast = no flourish."
        // Automated Animations tags what it plays with the item's uuid, and an
        // activity's uuid begins with its item's, so a prefix is the honest
        // match - the same one the kill-list itself uses.
        const originHit = !!d.origin && casts.some(c =>
          (c.activityUuid && d.origin === c.activityUuid)
          || (c.itemUuid && String(d.origin).startsWith(c.itemUuid)));
        const srcUuid = (typeof d.source === "string" ? d.source : d.source?.uuid) ?? null;
        const summonHit = srcUuid && casterUuids.has(srcUuid) && SUMMON_FX.test(`${d.file ?? ""} ${d.name ?? ""}`);
        if ((originHit || summonHit) && fx.id) toEnd.push(fx.id);
      }
      // Also end summon FX RECORDED at creation from these casters — AA plays its
      // persistent sign on the CAST, often before the counter resolves, so the
      // live getEffects() scan alone can miss it (already fired, still on screen).
      if (toEnd.length) EM.endEffects({ effects: toEnd });
      // Recorded-at-creation summon FX from these casters (AA fires its sign on
      // the CAST, so the live scan above can miss it). End by object ref, which
      // doesn't need an id that may not be set yet.
      const recorded = ReactionEngine._recentSummonFx.filter(e => e.expiresAt > now && casterUuids.has(e.srcUuid));
      for (const e of recorded) ReactionEngine._killSummonEffect(e);
      if (recorded.length) {
        const done = new Set(recorded);
        ReactionEngine._recentSummonFx = ReactionEngine._recentSummonFx.filter(e => !done.has(e));
      }
      if (toEnd.length || recorded.length) {
        console.log(`${MODULE_ID} | [COUNTER-CLEANUP] killed summon FX — live=${toEnd.length} recorded=${recorded.length}`);
      }
    } catch (err) { console.warn(`${MODULE_ID} | counterspell Sequencer-FX cleanup failed (non-fatal):`, err); }
  }

  /** End a recorded summon effect by whatever handle we have — the CanvasEffect's
   *  own endEffect() (needs no id) first, then EffectManager by id as a fallback.
   *  Both broadcast/clear locally; belt-and-suspenders. */
  static _killSummonEffect(rec) {
    try { rec?.effect?.endEffect?.(); } catch (_) {}
    try {
      const id = rec?.id ?? rec?.effect?.id ?? rec?.effect?.data?._id ?? null;
      if (id) globalThis.Sequencer?.EffectManager?.endEffects?.({ effects: [id] });
    } catch (_) {}
  }

  /**
   * v0.7.21 — Generate a stable key for the activity.
   * UUID-first; composite fallback when UUID is missing. The previous code
   * fell back to the activity object reference, which collided on parallel
   * casts (macros, rapid actions) when both casts hit the object-ref bucket
   * → Counterspell could resolve the wrong cast, refunding the wrong slot or
   * tearing down the wrong concentration. (Audit-mandated 2026-06-08.)
   *
   * The composite fallback includes a per-activity timestamp stamped at
   * preUseActivity (`activity._aceCastStamp`, also set by SpellPipeline).
   * If both UUID and stamp are missing — extremely unusual — we generate a
   * one-shot stamp here so the key is at least unique per cast attempt.
   */
  static _activityKey(activity) {
    if (!activity) return null;
    if (activity.uuid) return activity.uuid;
    // Stamp the activity if it isn't already, so subsequent lookups land on
    // the same key.
    if (!activity._aceCastStamp) {
      activity._aceCastStamp = `${performance.now?.() ?? Math.random()}`;
    }
    const actorId = activity?.item?.actor?.id ?? "";
    const itemId  = activity?.item?.id ?? "";
    return `${actorId}|${itemId}|${activity._aceCastStamp}`;
  }

  /**
   * Create a barrier for the given activity. Called in preUseActivity.
   * Idempotent — calling twice for the same activity is a no-op.
   */
  static _createCastBarrier(activity) {
    if (!activity) return;
    // ⚠️🔴 A FRESH CAST CLEARS THE OLD DEATH RECORD. Recognising a dead cast
    // by WHO cast WHAT is what makes it survive dnd5e cloning the item mid-cast,
    // and it is also what would kill the NEXT Fireball the same wizard throws.
    // A cast beginning is the one unambiguous signal that the previous one is
    // finished with, so the record for that creature and that item goes here and
    // nowhere else. (Caught by the replay's own "a Fireball nobody counters"
    // pin the moment the wider match went in, 2026-09-17.)
    try {
      const actorId = (activity?.item?.actor ?? activity?.actor)?.id ?? null;
      const itemId = activity?.item?.id ?? null;
      if (actorId && itemId) {
        const before = ReactionEngine._counterspelledCasts.length;
        ReactionEngine._counterspelledCasts = ReactionEngine._counterspelledCasts
          .filter(c => !(c.actorId === actorId && c.itemId === itemId));
        if (before !== ReactionEngine._counterspelledCasts.length) {
          ReactionEngine._sdebug(`[BARRIER] a new cast of ${activity?.item?.name ?? "that item"} `
            + `clears the counterspelled record of the last one`);
        }
      }
    } catch (_) { /* non-fatal */ }
    const key = ReactionEngine._activityKey(activity);
    const name = activity?.item?.name ?? "that spell";

    // ⚠️🔴 A NEW CAST GETS A NEW HOLD (his table, 2026-09-18): "11:08:42 first
    // Magic Missile. Log: holding, Counterspell prompt open. NO Rendering
    // Dialog. No box on screen. 11:08:51 second press. Same. 11:09:04 third
    // press. THEN Rendering Dialog." The key is the activity's uuid, which is
    // the SAME for every cast of that spell by that creature, and this used to
    // return early whenever a hold for the key existed. For thirty seconds after
    // a cast, the next cast inherited the last one's hold, already settled, so
    // it was never checked for Counterspell at all. After that the hold was new
    // but the check skipped it as "a second firing of the same use" (see
    // _claimCheck), so nothing ever let go of it: a hold with no box.
    //
    // A settled hold belongs to a cast that is over, so a new cast replaces it.
    // An unsettled one means that cast is still waiting on somebody's answer,
    // and a second press of the same spell waits for that same answer rather
    // than opening a second box or skipping the question.
    const old = ReactionEngine._castBarriers.get(key) ?? null;
    if (old && !old.resolved) {
      if (Date.now() - old.createdAt > 1000) {
        console.log(`${MODULE_ID} | ${name} was cast again while the last cast is still `
          + `${old.asking ? `waiting on ${old.asking}'s Counterspell answer` : "being checked for Counterspell"}; `
          + `this cast waits for the same answer.`);
      }
      return;
    }
    let resolveFn;
    const promise = new Promise(r => { resolveFn = r; });
    const entry = { promise, resolve: resolveFn, resolved: false, resolvedWith: null, createdAt: Date.now(),
      // Has the Counterspell check started for this cast (see _claimCheck), and
      // who is being asked right now (see _onSpellCast)?
      checked: false, asking: null };
    ReactionEngine._castBarriers.set(key, entry);
    ReactionEngine._sdebug(`[BARRIER] CREATE for ${name} on ${activity?.item?.actor?.name ?? '?'} — key=${typeof key === "string" ? key : "[obj]"} map size now ${ReactionEngine._castBarriers.size}`);
    // Safety net: a hold nothing ever released lets go by itself, and SAYS so.
    // ⚠️ BOUND TO THIS HOLD, NOT TO THE KEY. It used to look the key up when it
    // fired, so the timer of an old cast could settle, or delete, the hold of a
    // newer cast of the same spell.
    setTimeout(() => {
      if (!entry.resolved) {
        console.warn(`${MODULE_ID} | the Counterspell hold on ${name} was never released, so it lets go `
          + `now, after ${Math.round(ReactionEngine.barrierSafetyMs / 1000)} seconds, and the spell goes ahead.`);
        entry.resolve({ abort: false, reason: "timeout" });
        entry.resolved = true;
        entry.resolvedWith = { abort: false, reason: "timeout" };
      }
      if (ReactionEngine._castBarriers.get(key) === entry) ReactionEngine._castBarriers.delete(key);
    }, ReactionEngine.barrierSafetyMs);
  }

  /**
   * Should this caller run the Counterspell check for this cast? True once
   * per cast.
   *
   * ⚠️🔴 THE CAST, NOT THE SPELL. This used to remember the activity's uuid
   * for a full minute, and that uuid is the same for every cast of the spell,
   * so any cast within a minute of the last one was taken for "a second firing
   * of the same use" and never checked (his table, 2026-09-18). The spell
   * pipeline hit the same trap in July: a uuid belongs to every cast forever.
   * The hold is made once per cast, so it carries the mark instead. A second
   * firing of the same use finds its own hold already checked; the next cast
   * has a new hold. Only a cast with no hold at all falls back to the uuid, for
   * a moment short enough that no real cast could follow inside it.
   *
   * @param {object} activity
   * @returns {boolean}
   */
  static _claimCheck(activity) {
    const key = ReactionEngine._activityKey(activity);
    if (!key) return true;
    const entry = ReactionEngine._castBarriers.get(key);
    if (entry) {
      if (entry.checked) return false;
      entry.checked = true;
      return true;
    }
    const seen = ReactionEngine._castsChecked.get(key);
    if (seen && (Date.now() - seen) < 1500) return false;
    ReactionEngine._castsChecked.set(key, Date.now());
    if (ReactionEngine._castsChecked.size > 200) {
      const cutoff = Date.now() - 60000;
      for (const [k, t] of ReactionEngine._castsChecked) if (t < cutoff) ReactionEngine._castsChecked.delete(k);
    }
    return true;
  }

  /**
   * Resolve a barrier. Called by reaction-engine after the user decides
   * (or when reaction-engine bails because no reactors / not a spell / etc.).
   */
  static _resolveCastBarrier(activity, result) {
    if (!activity) {
      ReactionEngine._sdebug(`[BARRIER] RESOLVE skipped — no activity`);
      return;
    }
    const key = ReactionEngine._activityKey(activity);
    const b = ReactionEngine._castBarriers.get(key);
    if (!b) {
      ReactionEngine._sdebug(`[BARRIER] RESOLVE skipped — no barrier for ${activity?.item?.name ?? '?'} (map size: ${ReactionEngine._castBarriers.size})`);
      return;
    }
    if (b.resolved) {
      ReactionEngine._sdebug(`[BARRIER] RESOLVE skipped — already resolved with ${JSON.stringify(b.resolvedWith)}, new request was ${JSON.stringify(result)}`);
      return;
    }
    b.resolve(result);
    b.resolved = true;
    b.resolvedWith = result;
    ReactionEngine._sdebug(`[BARRIER] RESOLVE for ${activity?.item?.name ?? '?'} with ${JSON.stringify(result)}`);
  }

  /**
   * PUBLIC API. Other engines call this at the top of their
   * postCreateUsageMessage handler to wait for reaction resolution.
   *
   * @param {object} activity   the dnd5e activity object
   * @returns {Promise<{abort: boolean, reason: string}>}
   *   abort:true  → the cast was counterspelled; the caller should bail.
   *   abort:false → no reaction or reaction failed; proceed normally.
   */
  static async awaitCastBarrier(activity) {
    if (!activity) {
      ReactionEngine._sdebug(`[BARRIER] await — no activity`);
      return { abort: false, reason: "no_activity" };
    }
    const key = ReactionEngine._activityKey(activity);
    const b = ReactionEngine._castBarriers.get(key);
    if (!b) {
      ReactionEngine._sdebug(`[BARRIER] await — no barrier for ${activity?.item?.name ?? '?'} (key=${typeof key === "string" ? key : "[obj]"}, map size: ${ReactionEngine._castBarriers.size})`);
      return { abort: false, reason: "no_barrier" };
    }
    ReactionEngine._sdebug(`[BARRIER] AWAITING ${activity?.item?.name ?? '?'} (currently resolved: ${b.resolved})`);
    const result = await b.promise;
    ReactionEngine._sdebug(`[BARRIER] await returned ${JSON.stringify(result)} for ${activity?.item?.name ?? '?'}`);
    return result;
  }

  /**
   * PUBLIC. Has this cast been called off, and if the answer is not in yet,
   * wait for it.
   *
   * ⚠️🔴 WHY THIS EXISTS. Johnny, 2026-09-17, table-proven on both editions:
   * "Patrina 2014: card says auto-success, Fireball dissolves. Template + Dex
   * save card + ROLL DAMAGE still happened." The counter landed, said so, and
   * the spell went off anyway - because Fireball is a shape the pipeline owns
   * but deliberately does not resolve ("the save engine rolls the saves and the
   * damage"), and the save engine was the one engine in the suite that never
   * asked the barrier. It read the template, waited 100ms for the shape and
   * posted the card, while the counterspell prompt was still open on somebody's
   * screen.
   *
   * ⚠️ IT TAKES A UUID, WHICH IS THE WHOLE POINT. The engines that already
   * asked had the activity object in hand. A template does not: it carries
   * `flags.dnd5e.origin`, which dnd5e sets to the activity's uuid (and
   * `flags.dnd5e.item` to the item's). That string is the barrier's own key, so
   * the door that has only a template can ask the same question as the door
   * that has the whole cast.
   *
   * @param {object|string} activityOrUuid  an activity, or an activity uuid
   * @returns {Promise<{abort: boolean, reason: string}>}
   */
  static async awaitCastDecision(activityOrUuid, what = {}) {
    const isText = typeof activityOrUuid === "string";
    const uuid = isText ? activityOrUuid : (activityOrUuid?.uuid ?? null);
    if (!activityOrUuid && !what.item) return { abort: false, reason: "nothing to wait for" };

    // Already dead: the counter landed before this door was reached. No wait.
    const who = { origin: uuid, item: what.item ?? null, actor: what.actor ?? null,
      activity: isText ? null : activityOrUuid };
    if (ReactionEngine.castIsDead(who)) return { abort: true, reason: "counterspelled" };

    const key = isText ? activityOrUuid : ReactionEngine._activityKey(activityOrUuid);
    const barrier = key ? ReactionEngine._castBarriers.get(key) : null;
    // ⚠️🔴 A BARRIER THAT ALREADY SAID "GO AHEAD" IS NOT THE LAST WORD. It
    // can be settled by any of half a dozen early exits - no reactors, not a
    // spell, no token - and a counter landing afterwards cannot re-settle a
    // promise. The kill-list can still be written, and IT is the authority.
    // This is why the check below the wait exists as well as the one above it.
    if (barrier) {
      // ⚠️ SAY THAT YOU ARE WAITING. A door that holds for four seconds while
      // somebody decides looks identical to a door that has hung, and a door
      // that never waited at all looks identical to one that waited and was
      // told to go ahead. Both were guesses at this table; neither has to be.
      if (!barrier.resolved) {
        // ⚠️ SAY WHAT IT IS ACTUALLY WAITING ON. This said "a Counterspell
        // prompt is open" whether one was or not, and on 2026-09-18 none was:
        // the line he read was the only sign of a hold with no box behind it.
        console.log(`${MODULE_ID} | holding: ${barrier.asking
          ? `${barrier.asking} is being asked whether to Counterspell this cast`
          : "the Counterspell check for this cast has not finished yet"}. Nothing resolves until it does.`);
      }
      const result = await barrier.promise;
      if (result?.abort) return result;
    }

    // ⚠️ ASK AGAIN AFTER THE WAIT. The counter is recorded on the kill-list at
    // the same moment the barrier resolves, and on a player's cast the GM's
    // client records it with no barrier of its own to resolve. One of the two
    // always knows.
    if (ReactionEngine.castIsDead(who)) return { abort: true, reason: "counterspelled" };
    return { abort: false, reason: barrier ? "not countered" : "no barrier was raised for this cast" };
  }

  // ── v0.7.280 — Relay the counter to the CASTER's client for FX cleanup ──
  //  The summon-PLACEMENT gate (0.7.274) was reverted — delaying placeSummons to
  //  wait for the counter broke dnd5e's summon↔concentration link. But the
  //  caster's client still needs to KNOW a summon cast was countered, because AA
  //  plays its animation where the CASTER is (the player's screen for a player
  //  cast) and the counterspelled registry is otherwise GM-only. The GM relays the
  //  verdict over the socket; this records it here so the summon-FX listener +
  //  cleanup can end AA's animation on the caster's side. Player-side only — the
  //  GM already has it via _markCastCounterspelled.
  static _resolveSummonVerdict(activity, result) {
    try {
      // SILENT-OK: player-side only; the GM already recorded this via _markCastCounterspelled
      if (!result?.abort || game.user.isGM) return;
      const casterActor = activity?.item?.actor ?? activity?.actor ?? null;
      const casterTokenUuid = casterActor?.getActiveTokens?.()?.[0]?.document?.uuid ?? null;
      if (!ReactionEngine._counterspelledCasts.some(c => c.activityUuid && c.activityUuid === activity?.uuid)) {
        ReactionEngine._counterspelledCasts.push({
          itemUuid: activity?.item?.uuid ?? null,
          activityUuid: activity?.uuid ?? null,
          casterTokenUuid,
          casterName: casterActor?.name ?? "?",
          expiresAt: Date.now() + 30000,
        });
      }
      ReactionEngine._endCounterspelledCastEffects();   // end any AA FX already on screen
    } catch (_) { /* non-fatal */ }
  }

  constructor() {
    /** Pending reaction prompts awaiting player response.
     *  v0.4.22.12: switched from plain object to Map for cleaner
     *  iteration semantics + protection against prototype-key
     *  collisions (e.g. requestId === "constructor"). */
    this._pendingRequests = new Map();

    /** Counter for unique request IDs */
    this._requestCounter = 0;

    /** v0.4.22.12: WeakSet of activity references already processed by
     *  the V2 `postCreateUsageMessage` hook. The legacy `useActivity`
     *  hook checks this Set and bails if the activity was already
     *  handled — replaces the broken
     *  `_lastCounterspellCheck = ${id}-${Date.now()}` debounce, where
     *  the timestamp made every key unique and the dedup never fired. */
    this._handledActivityRefs = new WeakSet();

    this._registerHooks();
    this._registerSocketHandlers();

    // Auto-decline pending requests when the target player disconnects, so
    // the spell pipeline never hangs waiting for a player who is gone.
    Hooks.on("updateUser", (user, changes) => {
      if (changes.active !== false) return;
      for (const [reqId, pending] of this._pendingRequests.entries()) {
        if (pending.targetUserId === user.id) {
          console.log(`${MODULE_ID} | ReactionEngine: auto-declining pending reaction for disconnected user ${user.name}`);
          this._pendingRequests.delete(reqId);
          pending.resolve({ accepted: false, choiceData: {} });
        }
      }
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Hook Registration — Reaction Tracking (Turn Reset)
  // ═══════════════════════════════════════════════════════════════════════════

  _registerHooks() {
    // ── Reset reaction at the START of each combatant's turn ──
    //
    // ⚠️ THIS USED TO LISTEN TO `combatTurn`, AND IT RESET THE WRONG CREATURE.
    // Proven from Foundry V13's own source (client/documents/combat.mjs:291):
    //
    //     Hooks.callAll("combatTurn", this, updateData, updateOptions);
    //     await this.update(updateData, updateOptions);
    //
    // The hook fires BEFORE the update lands, so `combat.current` still points
    // at the combatant whose turn is ENDING. So every turn we cleared the
    // reaction of the creature just finishing — who had already had their
    // chance — while the creature actually starting its turn kept its spent
    // flag. A creature that used a reaction before its own turn (opportunity
    // attack, Shield, Counterspell, Absorb Elements) could not react again
    // until the top of the NEXT round, when the combatRound sweep below
    // happened to clear everyone. RAW: you get it back at the start of YOUR
    // turn. Silently denied reactions, all fight.
    //
    // `combatTurnChange` fires from `_manageTurnEvents` AFTER the state has
    // moved, and hands the new state in directly — the same hook, and the same
    // reasoning, as the turn-end work elsewhere in the suite. It also fires no
    // matter HOW the turn changed (clicking a combatant in the tracker, a
    // module writing combat.turn), which the four nextTurn/previousTurn call
    // sites never covered. (audit F-022, 2026-08-07)
    Hooks.on("combatTurnChange", (combat, prior, current) => {
      // SILENT-OK: not the active GM; this hook fires on every connected client and only one may act
      if (game.users?.activeGM !== game.user) return;  // activeGM: reaction reset writes must only fire once
      this._resetCurrentCombatantReaction(combat, current);
    });

    // ── Reset ALL combatants' reactions on round change ──
    // RAW: reactions refresh at the start of each creature's turn. When a
    // GM advances by whole round (Next Round button), per-turn-start hooks
    // for individual combatants may not fire — so every combatant's reaction
    // would stay stale. Refresh everyone in the combat. v0.7.21 fix.
    Hooks.on("combatRound", async (combat, updateData, opts) => {
      // SILENT-OK: not the active GM; this hook fires on every connected client and only one may act
      if (game.users?.activeGM !== game.user) return;  // activeGM: reaction reset writes must only fire once
      try {
        const cleared = [];
        for (const c of combat.combatants ?? []) {
          const actor = c.actor;
          if (!actor) continue;
          if (actor.getFlag(MODULE_ID, FLAG_REACTION_USED)) {
            await actor.unsetFlag(MODULE_ID, FLAG_REACTION_USED);
            cleared.push(actor.name);
          }
        }
        if (cleared.length) {
          console.log(`${MODULE_ID} | combatRound: refreshed reactions for ${cleared.length} combatants: ${cleared.join(", ")}`);
        }
      } catch (err) {
        console.warn(`${MODULE_ID} | combatRound reaction-reset failed:`, err);
      }
    });

    // ── v0.4.22.12: Reset all reactionUsed flags when combat ends ──
    // Without this, an actor's `reactionUsed` flag persists across
    // combats. Next combat, they'd appear to have already used their
    // reaction even though it's a new fight.
    Hooks.on("deleteCombat", () => {
      // SILENT-OK: not the active GM; this hook fires on every connected client and only one may act
      if (game.users?.activeGM !== game.user) return;  // activeGM: reaction flag clear must only run once
      this._resetAllReactionFlags("combat ended");
    });

    // ── Reset reaction on a SHORT or LONG rest (Johnny's houserule) ──
    // RAW already refreshes reactions every turn/round in combat; this makes a
    // rest ALSO clear the flag so a creature can never be stranded "reaction
    // used" OUT of combat (a fight that ended without deleteCombat, a bench
    // test, etc.). dnd5e fires `restCompleted` for BOTH rest types
    // (config.type = "short" | "long"), and only on the RESTING actor's own
    // client — so the owner clears its own flag; no activeGM gate (that would
    // miss player rests, whose hook never fires on the GM's client).
    Hooks.on("dnd5e.restCompleted", async (actor, result, config) => {
      try {
        // SILENT-OK: only the resting actor's own client clears its own flag; a GM gate would miss player rests
        if (!actor?.isOwner) return;
        if (actor.getFlag(MODULE_ID, FLAG_REACTION_USED)) {
          await actor.unsetFlag(MODULE_ID, FLAG_REACTION_USED);
          this._debug(`Reaction RESET: ${actor.name} (${config?.type ?? "rest"} rest)`);
        }
      } catch (err) {
        console.warn(`${MODULE_ID} | rest reaction-reset failed:`, err);
      }
    });

    // ── v0.7.265 — Counterspell native-resolution cleanup (stragglers) ──
    // dnd5e summons/templates usually land AFTER the async counter prompt
    // resolves. These GM-only hooks delete anything whose origin traces to a
    // counterspelled cast (paired with the reactive sweep in _onSpellCast for
    // anything already placed by the time the counter lands).
    Hooks.on("dnd5e.postSummon", async (activity, _profile, createdTokens) => {
      try {
        // SILENT-OK: not the active GM; this hook fires on every connected client and only one may act
        if (game.users?.activeGM !== game.user) return;
        const origin = activity?.item?.uuid ?? activity?.uuid;
        if (!ReactionEngine._isCounterspelledOrigin(origin)) return;
        const ids = (createdTokens ?? []).map(t => t?.id ?? t?.document?.id).filter(Boolean);
        if (ids.length) {
          await canvas?.scene?.deleteEmbeddedDocuments("Token", ids);
          ReactionEngine._sdebug(`[COUNTER-CLEANUP] postSummon deleted ${ids.length} straggler token(s)`);
        }
      } catch (err) { console.warn(`${MODULE_ID} | postSummon cleanup failed (non-fatal):`, err); }
    });

    // ── v0.7.271 — Late-placement straggler (the player-cast gap) ──
    // dnd5e.postSummon fires on the CLIENT that placed the summon, so a summon a
    // PLAYER casts and places AFTER the counter resolves never reaches the GM-only
    // cleanup above → a "zombie" fey lands with the caster no longer concentrating.
    // createToken is BROADCAST to every client, so it DOES fire on the GM here no
    // matter who dropped the token — match the summoned actor's origin to a
    // counterspelled cast and delete it GM-side. Cheap no-op when nothing was
    // counterspelled recently (the length guard skips the timer entirely).
    Hooks.on("createToken", (tokenDoc) => {
      if (!ReactionEngine._counterspelledCasts.length) return;   // nothing pending — fast exit
      setTimeout(async () => {
        try {
          // SILENT-OK: not the active GM; this hook fires on every connected client and only one may act
          if (game.users?.activeGM !== game.user) return;
          const fresh = canvas?.scene?.tokens?.get?.(tokenDoc.id);
          if (!fresh) return;
          const origin = fresh.actor?.getFlag?.("dnd5e", "summon.origin")
                      ?? fresh.actor?.flags?.dnd5e?.summon?.origin;
          if (!ReactionEngine._isCounterspelledOrigin(origin)) return;
          await fresh.delete();
          ReactionEngine._endCounterspelledCastEffects();   // also cut AA's on-drop summon flourish
          ReactionEngine._sdebug(`[COUNTER-CLEANUP] deleted late-placed summon token ${tokenDoc.id} (counterspelled cast)`);
        } catch (err) { console.warn(`${MODULE_ID} | createToken cleanup failed (non-fatal):`, err); }
      }, 150);
    });

    // ⚠️🔴 NO CROSSHAIR FOR A SPELL THAT IS ALREADY DEAD (2026-09-17).
    // Johnny: "The template STILL appeared and I placed it." It did, and dnd5e
    // is not at fault: `Activity#use` creates the usage message, fires the hook
    // ACE answers on, and then goes straight to `_finalizeUsage` and places the
    // template WITHOUT waiting for anything - our counterspell prompt is still
    // open at that moment. dnd5e offers exactly one way to stop it, and this is
    // it: `preCreateActivityTemplate` takes a false and the template is never
    // built. (Proven in the 5.3.3 source, AbilityTemplate.fromActivity.)
    Hooks.on("dnd5e.preCreateActivityTemplate", (activity) => {
      try {
        if (ReactionEngine.castIsDead({ activity })) {
          console.log(`${MODULE_ID} | "${activity?.item?.name ?? "that cast"}" was counterspelled, `
            + `so there is no area to place.`);
          return false;
        }
        // ⚠️🔴 AND ACE DOES NOT PLACE TEMPLATES. It tried, for one version, and
        // it broke Fireball outright: 0.34.40 refused the crosshair while the
        // Counterspell prompt was open and drew the area itself afterwards
        // through the system's own placer. His table, within the hour:
        // "AbilityTemplate.fromActivity is not a function or its return value is
        // not iterable. Fireball template will not place."
        //
        // The lesson is older than the bug and it is written down: build ON,
        // never BESIDE. Placing an area is dnd5e's job, it has always done it
        // correctly, and taking it over to win a few hundred milliseconds cost
        // him the spell entirely. The crosshair may appear while the prompt is
        // open - dnd5e places the area right after the usage message and does
        // not await the hook ACE answers on, so there is no honest way to stop
        // that without taking placement away from it. What ACE can do, and does,
        // is make sure that area never becomes anything: it is deleted the
        // moment the counter lands, no save card is posted for it, and nothing
        // is played. A crosshair that leads nowhere is a great deal better than
        // a Fireball that cannot be cast.
        return true;
      } catch (_) { return true; }
    });

    // ⚠️🔴 A COUNTERED SPELL DOES NOT MOVE THE TOKEN (2026-09-17). His rule:
    // "castIsDead → that activity does not place, does not move the token, does
    // not leave a red line, does not post a card." This is the move finisher.
    // It refuses ONLY a teleport-tagged move, ONLY by the creature whose own
    // cast was just counterspelled, and ONLY within seconds of it - so walking
    // away, being shoved, and a legitimate Misty Step a minute later are all
    // untouched. No spell is named anywhere in it: Foundry tags the movement and
    // the kill-list says whose cast died.
    Hooks.on("preUpdateToken", (tokenDoc, changes, opts) => {
      try {
        if (changes?.x === undefined && changes?.y === undefined) return true;

        // ⚠️🔴 THE TAG WAS NOT THERE. 0.34.45 refused only a move Foundry had
        // tagged as a teleport, and his table proved that wrong the same day:
        // Jebidiah's counterspelled Misty Step moved him anyway, with no
        // "displace" anywhere in the log. The reason is in ddb-importer's own
        // macro, which is what automates that spell in his world: it draws a
        // red-bordered range circle, hangs `Hooks.once("createMeasuredTemplate")`
        // on the next template placed, and then calls
        //
        //     targetToken.update({ x, y }, { animate: false })
        //
        // A plain document update. No movement, no action, no tag of any kind -
        // so a rule that reads the tag can never see it.
        //
        // ⚠️ SO THE RULE READS WHAT A WALK HAS, NOT WHAT A TELEPORT HAS. Foundry
        // V13 tags every move a PERSON makes - dragging, the ruler, the arrow
        // keys - with a movement action. Code that writes coordinates straight
        // onto the document carries none. A creature whose own cast was just
        // counterspelled does not get moved by code finishing that spell, and
        // walking away on its own two feet is untouched, because walking is
        // tagged and this only refuses what is not.
        //
        // ⚠️ AND ACE'S OWN FORCED MOVEMENT IS EXEMPT. A shove or a push from the
        // weapon masteries carries `aceForcedMovement`; that is somebody else
        // moving the creature, not its dead spell finishing.
        if (opts?.aceForcedMovement === true) return true;
        const WALKED = ["walk", "fly", "swim", "burrow", "climb", "crawl", "jump"];
        const action = String(changes?.movement?.action ?? tokenDoc?.movement?.action ?? "");
        if (WALKED.includes(action)) return true;

        // ⚠️🔴 ONE MOVE, AND THEN SHE IS FREE. This used to ask the kill
        // record, which lives ten minutes, and so kept her standing still for
        // the rest of the fight. The lock the counter armed is spent here,
        // whether or not anything else ever clears it.
        const actorId = tokenDoc?.actor?.id ?? null;
        const lock = actorId ? ReactionEngine._teleportLock.get(actorId) : null;
        if (!lock) return true;
        if (Date.now() > lock.until) { ReactionEngine._teleportLock.delete(actorId); return true; }
        ReactionEngine._teleportLock.delete(actorId);
        console.log(`${MODULE_ID} | ${tokenDoc?.name ?? "that creature"} stays where it is: `
          + `${lock.spell} was counterspelled and this move carries no action, so it is that spell `
          + `finishing. The hold is spent - the next move is hers.`);
        ui.notifications?.info(`${tokenDoc?.name ?? "The caster"} does not move - ${lock.spell} was counterspelled.`);
        return false;
      } catch (err) {
        console.warn(`${MODULE_ID} | could not check that move against a counterspelled cast, `
          + `so it is allowed:`, err);
        return true;
      }
    });

    // ⚠️ THE SUMMON FINISHER. Deleting a creature after it has appeared is a
    // poor second to never placing it, and dnd5e asks first.
    Hooks.on("dnd5e.preSummon", (activity) => {
      try {
        if (!ReactionEngine.castIsDead({ activity })) return true;
        console.log(`${MODULE_ID} | "${activity?.item?.name ?? "that cast"}" was counterspelled, `
          + `so nothing is summoned for it.`);
        return false;
      } catch (_) { return true; }
    });

    // ⚠️🔴 AND THE RED CIRCLE THAT ARRIVES AFTER THE ANSWER (2026-09-17). The
    // counter's sweep looks at what is on the map at the moment it lands, and
    // the aiming gear for a spell can be drawn a moment LATER - the macro runs
    // as the activity finishes, and the answer can beat it there. A template
    // that names a caster whose cast has just died is that cast's aiming gear,
    // whoever drew it and whatever namespace they flagged it with.
    Hooks.on("createMeasuredTemplate", (tdoc) => {
      try {
        if (!ReactionEngine._teleportLock.size) return;
        const flags = tdoc?.flags ?? {};
        let ownerId = null;
        for (const [actorId] of ReactionEngine._teleportLock) {
          for (const ns of Object.values(flags)) {
            if (!ns || typeof ns !== "object") continue;
            for (const v of Object.values(ns)) if (v === actorId) { ownerId = actorId; break; }
            if (ownerId) break;
          }
          if (ownerId) break;
        }
        if (!ownerId) return;
        const lock = ReactionEngine._teleportLock.get(ownerId);
        setTimeout(async () => {
          try {
            if (game.users?.activeGM !== game.user) return;
            const live = canvas?.scene?.templates?.get?.(tdoc.id);
            if (live) await live.delete();
            console.log(`${MODULE_ID} | took away the aiming circle for ${lock?.spell ?? "a counterspelled spell"}, `
              + `which was drawn after the answer.`);
          } catch (err) {
            const msg = String(err?.message ?? err ?? "");
            if (!/does not exist/i.test(msg)) {
              console.warn(`${MODULE_ID} | could not remove that aiming circle:`, err);
            }
          }
        }, 50);
      } catch (_) { /* non-fatal */ }
    });

    // Aiming gear gone, hold gone: she walks.
    Hooks.on("deleteMeasuredTemplate", (tdoc) => {
      try {
        if (!ReactionEngine._teleportLock.size) return;
        const flags = tdoc?.flags ?? {};
        for (const [actorId] of [...ReactionEngine._teleportLock]) {
          for (const ns of Object.values(flags)) {
            if (!ns || typeof ns !== "object") continue;
            for (const v of Object.values(ns)) {
              if (v !== actorId) continue;
              ReactionEngine._teleportLock.delete(actorId);
              console.log(`${MODULE_ID} | the aiming for that counterspelled spell is gone, `
                + `so nothing is holding that creature in place any more.`);
              return;
            }
          }
        }
      } catch (_) { /* non-fatal */ }
    });

    // flags.dnd5e.origin populates ~async on V13, so re-check on a short delay.
    Hooks.on("createMeasuredTemplate", (tdoc) => {
      setTimeout(async () => {
        try {
          // SILENT-OK: not the active GM; this hook fires on every connected client and only one may act
          if (game.users?.activeGM !== game.user) return;
          const fresh = canvas?.scene?.templates?.get?.(tdoc.id);
          if (!fresh || !ReactionEngine._isCounterspelledOrigin(fresh?.flags?.dnd5e?.origin)) return;
          await fresh.delete();
          ReactionEngine._sdebug(`[COUNTER-CLEANUP] deleted straggler template ${tdoc.id}`);
        } catch (err) { console.warn(`${MODULE_ID} | template cleanup failed (non-fatal):`, err); }
      }, 150);
    });

    // ── v0.7.278 — Kill AA's summon ANIMATION on a countered cast (sound is left
    // alone — Johnny prefers that to poking AA's internals). AA plays its
    // persistent conjuration sign on the CAST, which can be BEFORE the counter
    // resolves — so we can't match it to a counter at the moment it appears.
    // Instead: RECORD every summon-type Sequencer effect as it's created (id +
    // source token). When a counter lands, _endCounterspelledCastEffects ends the
    // recorded ones from that caster — the sign is persistent, so it vanishes.
    // Also end immediately if the caster's cast is ALREADY counterspelled (AA
    // fired after the counter). Near-zero cost; the record self-prunes.
    Hooks.on("createSequencerEffect", (fx) => {
      try {
        const d = fx?.data ?? {};
        const src = (typeof d.source === "string" ? d.source : d.source?.uuid) ?? null;
        // ⚠️ A CLIP FOR A CAST THAT IS ALREADY DEAD IS CUT AT BIRTH, whatever it
        // is. This used to look only for summon-shaped file names, so a cast
        // flourish that arrived a moment after the counter played out in full.
        // The origin says whose it is; nothing else has to be recognised.
        const origin = d.origin ?? null;
        if (origin && ReactionEngine._isCounterspelledOrigin(origin)) {
          console.log(`${MODULE_ID} | [COUNTER-CLEANUP] cutting a clip for a counterspelled cast `
            + `at the moment it starts: ${d.file ?? d.name ?? "?"}`);
          ReactionEngine._killSummonEffect({ effect: fx, id: fx.id ?? d._id ?? null });
          return;
        }
        const SUMMON_FX = /conjuration|summon|magic.?sign|portal|autoanimations\.static/i;
        if (!src || !SUMMON_FX.test(`${d.file ?? ""} ${d.name ?? ""}`)) return;   // NB: don't require fx.id — it isn't set yet at hook time
        const now = Date.now();
        ReactionEngine._recentSummonFx = ReactionEngine._recentSummonFx.filter(e => e.expiresAt > now);
        const rec = { effect: fx, id: fx.id ?? d._id ?? null, srcUuid: src, expiresAt: now + 8000 };
        ReactionEngine._recentSummonFx.push(rec);
        const casters = ReactionEngine._counterspelledCasts.filter(c => c.expiresAt > now).map(c => c.casterTokenUuid);
        if (casters.includes(src)) {
          console.log(`${MODULE_ID} | [COUNTER-CLEANUP] killing AA summon FX at creation (caster already countered): ${d.file ?? d.name ?? "?"}`);
          ReactionEngine._killSummonEffect(rec);
        }
      } catch (_) { /* non-fatal */ }
    });

    // ── v0.4.22.12: Reset all reactionUsed flags on world reload ──
    // The flag is stored on actor.flags so it persists across saves.
    // Without this cleanup, a session that ends mid-combat would
    // leave stale flags forever.
    // ⚠️🔴 THIS NEVER RAN. `Hooks.once("ready")` registered from INSIDE `ready`
    // waits on an event already in progress (2026-08-12 lesson). ReactionEngine
    // is constructed inside ace-qol.mjs's ready handler, so this reset has been
    // dead since it was written - meaning a session that ended mid-combat left
    // `reactionUsed` set on every creature that had reacted, FOREVER. Those
    // creatures could never take another reaction: no Shield, no Opportunity
    // Attack, no Counterspell, and nothing on screen to explain it.
    const _resetReactionFlagsOnBoot = () => {
      // SILENT-OK: GM-only handler; every client sees this hook and only the GM resolves it
      if (!game.user.isGM) return;
      this._resetAllReactionFlags("world startup");
    };
    if (game.ready) _resetReactionFlagsOnBoot();
    else Hooks.once("ready", _resetReactionFlagsOnBoot);

    // ── Track opportunity attacks as reaction usage ──
    // When an OA is made, mark the attacker's reaction as used.
    // We detect OAs via the dnd5e system's "opportunity" flag if available,
    // or via the custom hook other modules emit.
    Hooks.on(`${MODULE_ID}.opportunityAttack`, (actorId) => {
      // SILENT-OK: GM-only handler; every client sees this hook and only the GM resolves it
      if (!game.user.isGM) return;
      const actor = game.actors.get(actorId);
      if (actor) this._markReactionUsed(actor, "opportunityAttack");
    });

    // ── v0.7.17b — Cast barrier creation (preUseActivity) ──
    // Fires EARLIER than postCreateUsageMessage. Other engines (Spell-
    // AutoDamage, etc.) await this barrier in their postCreateUsageMessage
    // handlers so reactions resolve modally before downstream effects.
    Hooks.on("dnd5e.preUseActivity", (activity, usageConfig) => {
      // SILENT-OK: GM-only handler; every client sees this hook and only the GM resolves it
      if (!game.user.isGM) return;
        if (!QolSettings.get("enableReactions")) return this._gateOff("Counterspell", "enableReactions");
        if (!QolSettings.get("autoCounterspell")) return this._gateOff("Counterspell", "autoCounterspell");
      const item = activity?.item;
      if (!item || item.type !== "spell") return;
      const lvl = item.system?.level ?? 0;
      if (lvl === 0) return; // cantrips can't be counterspelled
      ReactionEngine._createCastBarrier(activity);
    });

    // ── Counterspell: detect spell casting ──
    // dnd5e 5.x fires postCreateUsageMessage for every activity use.
    // We check if it is a spell and look for Counterspell reactors.
    Hooks.on("dnd5e.postCreateUsageMessage", async (activity, message) => {
      this._debug(`[REACTION-V2-HOOK] entry for ${activity?.item?.name ?? '?'} isGM=${game.user.isGM} reactions=${QolSettings.get("enableReactions")} cs=${QolSettings.get("autoCounterspell")}`);
        if (!QolSettings.get("enableReactions")) return this._gateOff("Counterspell", "enableReactions");
        if (!QolSettings.get("autoCounterspell")) return this._gateOff("Counterspell", "autoCounterspell");
      if (activity?.item?.type !== "spell") return;
      if ((activity?.item?.system?.level ?? 0) === 0) return; // cantrips can't be countered

      // ── v0.7.268 — PLAYER cast path. This hook fires on the CASTER's client,
      // but the counterspell check must run GM-side: it routes prompts to each
      // reactor's owner and its cleanup deletes GM-owned summons/templates,
      // which a player client can't do. So when a PLAYER casts, socket the GM
      // the exact activity uuid; the GM reconstructs it with fromUuid and runs
      // the same _onSpellCast (mirrors ACE's existing player-cast save/heal
      // routing). GM casts fall through and run it directly. ──
      if (!game.user.isGM) {
        try {
          game.socket.emit(SOCKET_NAME, {
            action: "playerSpellCast",
            userId: game.user.id,   // ⚠️ the GM checks this owns the caster
            activityUuid: activity?.uuid ?? null,
            messageId: message?.id ?? null,
          });
        } catch (e) { console.warn(`${MODULE_ID} | playerSpellCast emit failed (non-fatal):`, e); }
        return;
      }

      // ⚠️🔴 ONE CHECK PER CAST. dnd5e can fire this hook more than once for
      // a single use - the spell pipeline has carried its own guard against
      // exactly that for months - and this handler had none. The second firing
      // finds the counterspeller's reaction already spent, exits with "no
      // reactors available", and RESOLVES THE CAST BARRIER WITH abort:false
      // while the first firing is still waiting for the human to answer. The
      // counter then lands, posts its card, and cannot re-resolve a promise
      // that has already settled. Straight from his console, 2026-09-17:
      // "Fireball goes ahead (not countered); its area is read and its card
      // posted as normal" - printed AFTER the card that said the Fireball
      // fizzled. (The kill-list is the authority now either way, but a second
      // Counterspell prompt for one cast is its own bug.)
      // ⚠️ ONCE PER CAST, not once per minute per spell (2026-09-18): see
      // _claimCheck. The minute-long window swallowed real casts and left
      // their holds with nothing to release them.
      if (!ReactionEngine._claimCheck(activity)) {
        this._debug(`[REACTION-V2-HOOK] ${activity?.item?.name ?? "that cast"} is already being `
          + `checked for Counterspell - this firing shares that answer`);
        return;
      }

      this._debug(`[REACTION-V2-HOOK] passed gates, calling _onSpellCast for ${activity?.item?.name ?? '?'}`);
      // Mark BEFORE processing so the legacy hook (which fires after
      // this synchronous return) sees the handled state.
      if (activity && typeof activity === "object") {
        this._handledActivityRefs.add(activity);
      }
      await this._onSpellCast(activity, message);
    });
    // Legacy fallback — only fires if dnd5e didn't emit postCreateUsageMessage
    // (older system versions). Defers one tick AND waits a short window so the
    // V2 hook can claim the activity. This prevents the prompt from appearing
    // BEFORE the spell's chat card renders (which happens at
    // dnd5e.postCreateUsageMessage, not dnd5e.useActivity). v0.7.21 fix.
    // ⚠️ DEAD AND SUPERSEDED. `dnd5e.useActivity` is not emitted by dnd5e
    // 5.3.3, so this has never run. Counterspell is handled by the LIVE
    // `dnd5e.postCreateUsageMessage` handler below, which is exactly what this
    // one's own comment says it wanted. Left in place rather than repointed:
    // waking it would prompt for Counterspell twice on every cast.
    // dead-hook-ok: superseded by the live postCreateUsageMessage handler below; waking it would prompt Counterspell twice per cast
    Hooks.on("dnd5e.useActivity", async (activity) => {
      // SILENT-OK: GM-only handler; every client sees this hook and only the GM resolves it
      if (!game.user.isGM) return;
      if (!QolSettings.get("enableReactions")) return this._gateOff("Counterspell", "enableReactions");
      if (!QolSettings.get("autoCounterspell")) return this._gateOff("Counterspell", "autoCounterspell");
      // ⚠️🔴 WATCH FOR THE CLAIM, DO NOT SLEEP THROUGH THE WINDOW.
      //
      // This used to sleep a flat 250ms and then check once. Every spell cast
      // on the GM's client paid that quarter second, and a table busy enough
      // to push postCreateUsageMessage past 250ms got Counterspell offered
      // TWICE for one cast - the exact double this guard exists to prevent.
      //
      // It now stops the moment the V2 hook marks the activity, normally
      // within one 20ms step, and the deadline can be 750ms because waiting
      // longer costs nothing when the condition is WATCHED rather than slept
      // through. If V2 never fires (older dnd5e), this legacy path proceeds
      // as it always did.
      if (activity && await waitUntil(
        () => this._handledActivityRefs.has(activity),
        { maxMs: 750, stepMs: 20, quiet: true,
          what: "the V2 postCreateUsageMessage hook claiming this cast" },
      )) return;   // V2 owns this cast; the legacy path must not run as well
      await this._onSpellCast(activity, null);
    });

    this._debug("Reaction engine hooks registered");
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Socket Handlers — Player ↔ GM Communication
  // ═══════════════════════════════════════════════════════════════════════════

  _registerSocketHandlers() {
    // Socket handlers are registered in ace-qol.mjs's ready hook.
    // This method is called by the main entry to get the handler function.
    // See integration notes at bottom of file.
  }

  /**
   * Handle incoming socket messages for the reaction engine.
   * Called from ace-qol.mjs socket handlers.
   * @param {object} payload - Socket payload
   * @returns {boolean} true if this engine handled the message
   */
  async handleSocketMessage(payload) {
    if (!payload?.action) return false;

    // ── Player responds to a reaction prompt ──
    if (payload.action === "reactionResponse") {
      const { requestId, accepted, choiceData, senderUserId, reactorActorId } = payload;
      const pending = this._pendingRequests.get(requestId);
      if (!pending) {
        return this._cannotCheck("a reaction response",
          "no prompt was waiting for it - it arrived late, or twice") ?? true;
      }

      // ⚠️🔴 THIS CHECK EXISTED SINCE v0.4.22.12 AND FAILED OPEN THREE WAYS
      // (Brock audit, 2026-08-19). All three are the same mistake: treating a
      // missing field as "nothing to verify" instead of "cannot verify".
      //
      //   1. The whole block hung off `if (senderUserId)`, so a payload that
      //      simply OMITTED the sender skipped every check below it. Leaving
      //      the field out was easier than forging it.
      //   2. A GM claim passed. Foundry attaches no trusted sender, so a
      //      player types the GM's id and is waved through. Every reaction
      //      prompt is sent to a specific player; a GM answers locally.
      //   3. A missing stored actor id skipped the ownership test.
      //
      // Now: the reply must name a real, non-GM user, the request must know
      // whose reaction it is, and that user must own the creature. Anything
      // missing is a refusal, not a pass.
      {
        const expectedActorId = pending.reactorActorId;
        const senderUser = senderUserId ? game.users?.get(senderUserId) : null;
        if (!senderUser) {
          console.warn(`${MODULE_ID} | Rejected reactionResponse — names no real user.`);
          return true;
        }

        // ⚠️ THE ADDRESSEE IS THE TEST, NOT "IS THEY A PLAYER". An earlier
        // version of this hardening refused every GM claim, on the reasoning
        // that reaction prompts go to players. That is true of the ordinary
        // path and FALSE of `forceGM` — Legendary Resistance deliberately
        // prompts a GM, and with a second GM connected that prompt goes over
        // the socket to them. Refusing their answer would have looked exactly
        // like "Legendary Resistance stopped working, sometimes", which is the
        // worst kind of bug: intermittent and dependent on who is logged in.
        //
        // The pending record already knows who was asked. Comparing against
        // that is both stronger than a role check and correct for forceGM.
        if (pending.targetUserId && senderUserId !== pending.targetUserId) {
          const asked = game.users?.get(pending.targetUserId)?.name ?? pending.targetUserId;
          console.warn(`${MODULE_ID} | Rejected reactionResponse — "${senderUser.name}" answered a ` +
            `prompt sent to "${asked}".`);
          return true;
        }

        // Ownership, only where it is meaningful: a player answering for a
        // creature must own it. A GM answering a forceGM prompt owns
        // everything by definition, and the addressee check above already
        // established it was sent to them.
        if (!senderUser.isGM) {
          if (!expectedActorId) {
            console.warn(`${MODULE_ID} | Rejected reactionResponse — the request did not record whose ` +
              `reaction it was, so there is nothing to check "${senderUser.name}" against.`);
            return true;
          }
          const actor = game.actors?.get(expectedActorId);
          if (!actor?.testUserPermission?.(senderUser, "OWNER")) {
            console.warn(`${MODULE_ID} | Rejected reactionResponse from ${senderUser.name}: does not own actor ${expectedActorId}`);
            return true;
          }
        }

        // Echo-actor sanity check: if responder echoed an actorId, it must
        // match the stored one.
        if (reactorActorId && expectedActorId && reactorActorId !== expectedActorId) {
          console.warn(`${MODULE_ID} | Rejected reactionResponse: actor mismatch ${reactorActorId} vs ${expectedActorId}`);
          return true;
        }
      }

      clearTimeout(pending.timeout);
      this._pendingRequests.delete(requestId);
      pending.resolve({ accepted: !!accepted, choiceData: choiceData ?? {} });
      return true;
    }

    // ── The other screen says the box is up (2026-09-18) ──
    // Without this the asker cannot tell a box that is waiting on a click from
    // one that never opened (see _promptRemote).
    if (payload.action === "reactionPromptShown") {
      const waiting = this._pendingRequests.get(payload.requestId);
      // SILENT-OK: an answer to somebody else's box; every client hears every socket message
      if (!waiting) return false;
      if (waiting.targetUserId && payload.senderUserId && waiting.targetUserId !== payload.senderUserId) return true;
      waiting.shown = true;
      return true;
    }

    // ── GM sends a reaction prompt to a player ──
    if (payload.action === "showReactionPrompt") {
      // Only the targeted player should handle this
      // SILENT-OK: this socket payload is addressed to a different user
      if (payload.targetUserId !== game.user.id) return true;
      // ⚠️ A BOX THAT CANNOT OPEN STILL ANSWERS. A throw here sent nothing
      // back, and the client that asked waited on the answer forever.
      let result;
      try {
        result = await ReactionEngine.showReactionDialog({
          ...payload.promptData,
          // The moment the box is drawn here, tell whoever asked.
          onShown: () => game.socket.emit(SOCKET_NAME, {
            action: "reactionPromptShown", requestId: payload.requestId, senderUserId: game.user.id }),
        });
      } catch (err) {
        console.warn(`${MODULE_ID} | the ${payload.promptData?.title ?? "reaction"} box for `
          + `${payload.promptData?.reactorActorName ?? "a creature"} could not open here, so it answers no:`, err);
        result = { accepted: false, choiceData: {} };
      }
      // ⚠️ THE SCREEN THAT SAYS YES SPENDS THE LUCK POINT (2026-09-18). A
      // player's screen asking about an NPC's Lucky cannot write that NPC's
      // feat; the GM who just said yes can, and a player saying yes owns theirs.
      if (result?.accepted && payload.promptData?.luckItemUuid) {
        try {
          const { spendLuckByUuid } = await import("./luck.mjs");
          const luckSpent = await spendLuckByUuid(payload.promptData.luckItemUuid);
          result = { ...result, choiceData: { ...(result.choiceData ?? {}), luckSpent } };
        } catch (err) {
          console.warn(`${MODULE_ID} | could not spend the luck point on this screen; the asking screen will try:`, err);
        }
      }
      // Send response back to GM. v0.4.22.12: include senderUserId
      // and reactorActorId so the GM-side handler can validate
      // ownership (defense in depth — a stolen requestId alone no
      // longer authenticates a response).
      game.socket.emit(SOCKET_NAME, {
        action: "reactionResponse",
        requestId: payload.requestId,
        accepted: result.accepted,
        choiceData: result.choiceData ?? {},
        senderUserId: game.user.id,
        reactorActorId: payload.promptData?.actorId ?? null,
      });
      return true;
    }

    return false;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Reaction State Management
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Check if an actor has already used their reaction this round.
   */
  _hasUsedReaction(actor) {
    if (!actor) return true;
    return !!actor.getFlag(MODULE_ID, FLAG_REACTION_USED);
  }

  /**
   * Mark an actor's reaction as used for this round.
   * @param {Actor} actor
   * @param {string} [reactionType]  e.g. "shield", "counterspell", "absorbElements", "opportunityAttack"
   * @param {Actor}  [targetActor]   the actor the reaction was used against (if applicable)
   */
  async _markReactionUsed(actor, reactionType = "unknown", targetActor = null) {
    if (!actor) return;
    await actor.setFlag(MODULE_ID, FLAG_REACTION_USED, true);
    Hooks.callAll(`${MODULE_ID}.reactionUsed`, { actor, reactionType, targetActor });
    this._debug(`Reaction USED: ${actor.name} (${reactionType})`);
  }

  /**
   * Reset reaction for the combatant whose turn is STARTING.
   *
   * @param {Combat} combat
   * @param {object} [current]  the turn state the hook handed us. Preferred over
   *   reading `combat.current` — see the combatTurnChange registration above for
   *   why reading it off the combat was resetting the wrong creature. Falls back
   *   to `combat.current` only for a caller that has nothing better.
   */
  async _resetCurrentCombatantReaction(combat, current = null) {
    const state = current ?? combat?.current;
    const combatantId = state?.combatantId;
    if (!combatantId) {
      return this._cannotCheck("the reaction reset",
        "the turn change named no combatant");
    }
    const combatant = combat?.combatants?.get(combatantId);
    // The TOKEN's actor, so one unlinked copy's reaction doesn't clear the
    // shared sidebar actor's flag for every other copy of that creature.
    const actor = combatant?.token?.actor ?? combatant?.actor;
    if (!actor) return;

    // Only reset if currently marked as used
    if (actor.getFlag(MODULE_ID, FLAG_REACTION_USED)) {
      await actor.unsetFlag(MODULE_ID, FLAG_REACTION_USED);
      this._debug(`Reaction RESET: ${actor.name} (start of turn)`);
    }
  }

  /**
   * v0.4.22.12: Bulk-reset every actor's reactionUsed flag.
   * Called on `ready` (world startup) and on `deleteCombat` (combat
   * ended). Ensures stale flags don't persist across saves or
   * between combats. GM-gated by callers.
   *
   * ⚠️🔴 `game.actors` DOES NOT CONTAIN THE CREATURES ON THE BOARD.
   * Johnny, 2026-09-06, mid-session: *"I need to reset the reactions on every
   * token on the board."* He needed a snippet because THIS did not do it.
   *
   * An unlinked token does not use its world actor. It carries an ActorDelta
   * and `token.actor` is a synthetic built from it, so `setFlag` writes to the
   * DELTA and the world actor never hears about it. This loop walked
   * `game.actors` and nothing else, which means for the entire life of the
   * feature it cleared LINKED actors — the PCs — and left every unlinked NPC
   * holding a spent reaction through combat end AND through a world reload.
   * The one boot reset written to guarantee a clean slate never touched the
   * creatures the reactions were mostly being spent by.
   *
   * ⚠️ EVERY SCENE, NOT JUST THE VIEWED ONE. A fight that ended on the scene he
   * has since left is exactly the state this exists to clean up, and the
   * combatants are still sitting there with the flag set.
   *
   * ⚠️ DEDUPED BY ACTOR UUID. A linked actor with six tokens is one actor and
   * one write; without this the count lies and the same unset fires six times.
   *
   * @param {string} reason  Human-readable trigger source for log line.
   */
  async _resetAllReactionFlags(reason) {
    const seen = new Set();
    let checked = 0, cleared = 0;

    const clear = async (actor, label) => {
      try {
        if (!actor || seen.has(actor.uuid)) return;
        seen.add(actor.uuid);
        checked += 1;
        if (!actor.getFlag(MODULE_ID, FLAG_REACTION_USED)) return;
        await actor.unsetFlag(MODULE_ID, FLAG_REACTION_USED);
        cleared += 1;
      } catch (err) {
        // Permission errors on actors we don't own are expected;
        // skip them silently. Genuine failures get logged.
        if (!String(err?.message ?? "").toLowerCase().includes("permission")) {
          console.warn(`${MODULE_ID} | _resetAllReactionFlags: failed to clear flag on ${label}:`, err);
        }
      }
    };

    // ── The world actors: every PC, and the base of every linked token ──
    // ⚠️ THIS PASS GOES FIRST ON PURPOSE. A synthetic actor is its base merged
    // with its delta, so clearing the base here removes any INHERITED flag and
    // leaves the token pass with only genuinely token-local ones to find.
    for (const actor of game.actors ?? []) await clear(actor, actor?.name);

    // ── And the creatures actually on the boards ──
    for (const scene of game.scenes ?? []) {
      for (const tokenDoc of scene.tokens ?? []) {
        // A linked token IS its world actor, already done above.
        if (tokenDoc.isLinked) continue;

        // ⚠️ READ THE STORED DELTA, DO NOT BUILD THE ACTOR TO ASK IT.
        // `tokenDoc.actor` MATERIALISES the synthetic actor for an unlinked
        // token, and this loop covers every scene in the world. Touching
        // `.actor` on all of them would construct thousands of actors to
        // discover that almost none of them have the flag. The delta's own
        // source data answers the question with a property read, and the
        // actor is only built for the handful that say yes.
        const stored = tokenDoc._source?.delta?.flags?.[MODULE_ID]?.[FLAG_REACTION_USED];
        if (!stored) continue;
        await clear(tokenDoc.actor, `${tokenDoc.name} on ${scene.name}`);
      }
    }

    if (cleared > 0) {
      this._debug(`Reaction flags reset on ${cleared} of ${checked} creature(s) (${reason})`);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  1. SHIELD — Post-Hit Reaction (after attack hits, before damage)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Check all hit targets for Shield spell availability.
   * Called from AttackPipeline after hit determination.
   *
   * @param {object[]} results - Attack results array from AttackPipeline
   *   Each: { hitResult, attackTotal, target: { actor, token, ac, name }, ... }
   * @param {Item} attackItem - The weapon/spell used to attack
   * @param {Actor} attacker - The attacking actor
   * @returns {object[]} Modified results array (hitResult may change to "miss" if Shield turns a hit into a miss)
   */
  async checkPostHitReactions(results, attackItem, attacker) {
    // ── ⚠️🔴 RETURN A COPY, NEVER THE CALLER'S OWN ARRAY ────────────────
    //
    // These two early returns used to hand back `results` — the very array the
    // caller passed in. The caller then did `results.length = 0` before
    // refilling from what it thought was a separate list, and because they were
    // ONE OBJECT it emptied both and put back nothing.
    //
    // Every attack card in the game disappeared, for any creature, on any
    // weapon, whenever reactions were switched off. It ended a live session on
    // 2026-08-24 and stayed invisible because nothing threw and nothing logged:
    // the roll happened, the loop ran, the builder was reached, and the results
    // had been deleted on the way.
    //
    // ⚠️ A COPY COSTS NOTHING AND CLOSES THE WHOLE CLASS. The caller is also
    // fixed to check identity, but a function that returns its own input while
    // the caller is entitled to mutate it is a trap for the next person too.
    if (!QolSettings.get("enableReactions")) {
      this._gateOff("post-hit reactions (Shield)", "enableReactions");
      return [...results];
    }
    if (!QolSettings.get("autoShield")) {
      this._gateOff("Shield", "autoShield");
      return [...results];
    }

    const modified = [];

    for (const result of results) {
      // Only check hits (not crits — Shield doesn't block nat 20)
      if (result.hitResult !== "hit") {
        modified.push(result);
        continue;
      }

      const targetActor = result.target?.actor;
      const targetToken = result.target?.token;
      if (!targetActor) { modified.push(result); continue; }

      // ── Can this target use Shield? ──
      // Same silence, same fix: say who was passed over and why. (2026-09-16)
      const shieldCheck = this._canUseShield(targetActor);
      if (!shieldCheck.canUse) {
        console.log(`${MODULE_ID} | Shield: ${targetActor.name} is not asked about the hit — `
          + `${shieldCheck.reason ?? "no reason given"}.`);
        modified.push(result);
        continue;
      }

      // ── Send prompt to the target's owner ──
      // v0.7.71 — pass attacker name + portrait so the reactor sees WHO is
      // hitting them, not just the description text. Knowing the attacker
      // changes the math (a Goblin's +4 doesn't deserve a slot; Strahd's +12
      // probably does).
      const attackerToken = attacker?.getActiveTokens?.()?.[0]
        ?? canvas.tokens?.placeables.find(t => t.actor?.id === attacker?.id)
        ?? null;
      const attackerImg = attackerToken?.document?.texture?.src
        ?? attacker?.img
        ?? attacker?.prototypeToken?.texture?.src
        ?? null;
      const promptResult = await this._promptReaction({
        reactorActor: targetActor,
        reactorToken: targetToken,
        attackerName: attacker?.name ?? "An attacker",
        attackerImg,
        type: "shield",
        title: "Shield Spell",
        heading: "Shield",
        description: `${foundry.utils.escapeHTML(attacker?.name ?? "An attacker")} hits you with `
          + `<span class="ace-qol-reaction-spell">${foundry.utils.escapeHTML(attackItem?.name ?? "an attack")}</span>`,
        details: [
          { label: "Attack Roll", value: result.attackTotal },
          { label: "Current AC", value: result.target.ac },
          { label: "AC with Shield", value: result.target.ac + 5 },
          { label: "Result", value: result.attackTotal >= (result.target.ac + 5) ? "STILL HITS" : "WOULD MISS", color: result.attackTotal >= (result.target.ac + 5) ? "#ef5350" : "#66bb6a" },
        ],
        acceptLabel: "Cast Shield",
        declineLabel: "No reaction",
        spellSlotLevel: 1,
        availableSlots: shieldCheck.slots,
        icon: "fa-shield-quartered",
        accentColor: "#42a5f5",
      });

      if (promptResult.accepted) {
        // ── Consume spell slot ──
        const slotLevel = promptResult.choiceData?.slotLevel ?? 1;
        await this._consumeSpellSlot(targetActor, slotLevel);

        // ── Mark reaction used ──
        await this._markReactionUsed(targetActor, "shield");

        // ── Apply Shield active effect (+5 AC until start of caster's next turn) ──
        await this._applyShieldEffect(targetActor, { castLevel: slotLevel });

        // ── Re-evaluate hit ──
        const newAC = result.target.ac + 5;
        if (result.attackTotal < newAC) {
          // Shield turned the hit into a miss!
          this._debug(`Shield BLOCKED: ${targetActor.name} (${result.attackTotal} vs AC ${newAC})`);
          result.hitResult = "miss";
          result.shieldBlocked = true;

          // Post chat notification
          await this._postReactionChat(targetActor, "Shield", `${targetActor.name} casts Shield! AC becomes ${newAC} — attack misses!`, "#42a5f5");
        } else {
          // Shield didn't prevent the hit but still grants +5 AC for the round
          this._debug(`Shield CAST but still hit: ${targetActor.name} (${result.attackTotal} vs AC ${newAC})`);
          result.target.ac = newAC; // Update AC for display
          await this._postReactionChat(targetActor, "Shield", `${targetActor.name} casts Shield! AC becomes ${newAC} — but the attack still hits (${result.attackTotal}).`, "#ef5350");
        }
      }

      modified.push(result);
    }

    return modified;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  1b. SHIELD vs MAGIC MISSILE — Auto-Hit Defense
  //
  //  Shield has a SPECIAL RAW clause: "you take no damage from magic missile."
  //  (2014 + 2024 PHB, identical wording.) Unlike normal attack-vs-Shield
  //  which is +5 AC math, Magic Missile vs Shield is ABSOLUTE — all darts
  //  on that target are nullified, no damage applies.
  //
  //  Magic Missile has no attack roll, so it bypasses checkPostHitReactions().
  //  This method is invoked from SpellAutoDamage's Magic Missile handler
  //  AFTER the picker confirms target distribution but BEFORE damage rolls.
  //
  //  Returns a filtered distribution Map with shielded targets removed.
  //  If every target shields, the returned Map is empty and the caller
  //  should abort the damage card entirely.
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Check each Magic Missile target for Shield availability and prompt.
   * @param {Map<Actor, number>} distribution - Map of targetActor → dart count
   * @param {Actor} caster - The Magic Missile caster
   * @param {Item} spellItem - The Magic Missile spell item
   * @returns {Promise<Map<Actor, number>>} Filtered distribution (shielded removed)
   */
  async checkMagicMissileShield(distribution, caster, spellItem) {
    if (!QolSettings.get("enableReactions")) {
      this._gateOff("Shield vs Magic Missile", "enableReactions");
      return distribution;
    }
    if (!QolSettings.get("autoShield")) {
      this._gateOff("Shield vs Magic Missile", "autoShield");
      return distribution;
    }
    if (!distribution || distribution.size === 0) return distribution;

    const modified = new Map();

    for (const [targetActor, darts] of distribution.entries()) {
      if (!targetActor || darts <= 0) {
        modified.set(targetActor, darts);
        continue;
      }

      // ── Can this target use Shield? (reaction unspent + prepared + slot) ──
      // ⚠️🔴 A SILENT DECLINE LOOKS EXACTLY LIKE A DEAD FEATURE. Johnny's
      // report, 2026-09-16: "No Shield pop-up... The reaction check never ran."
      // It ran. It refused, for a reason it never said out loud, on every
      // target, every time. Now it says who and why, so the next wrong reader
      // is one line in the log instead of a session.
      const shieldCheck = this._canUseShield(targetActor);
      if (!shieldCheck.canUse) {
        console.log(`${MODULE_ID} | Shield vs Magic Missile: ${targetActor.name} is not asked — `
          + `${shieldCheck.reason ?? "no reason given"}.`);
        modified.set(targetActor, darts);
        continue;
      }
      console.log(`${MODULE_ID} | Shield vs Magic Missile: asking ${targetActor.name} `
        + `(${darts} dart${darts !== 1 ? "s" : ""} incoming, ${shieldCheck.slots.length} slot level(s) to spend).`);

      const targetToken = targetActor.getActiveTokens?.()?.[0]
                       ?? canvas.tokens?.placeables.find(t => t.actor?.id === targetActor.id)
                       ?? null;

      // ── Prompt the target's owner ──
      // v0.7.71 — pass caster info as "attacker" so the prompt shows WHO
      // cast Magic Missile (same plumbing as the Shield post-hit prompt).
      const casterToken = caster?.getActiveTokens?.()?.[0]
        ?? canvas.tokens?.placeables.find(t => t.actor?.id === caster?.id)
        ?? null;
      const casterImg = casterToken?.document?.texture?.src
        ?? caster?.img
        ?? caster?.prototypeToken?.texture?.src
        ?? null;
      const promptResult = await this._promptReaction({
        reactorActor: targetActor,
        reactorToken: targetToken,
        attackerName: caster?.name ?? "A caster",
        attackerImg: casterImg,
        type: "shield",
        // The window's title bar keeps the full name; the box's own heading
        // is the reaction alone.
        title: "Shield — Magic Missile Defense",
        heading: "Shield",
        // ⚠️ THE MOMENT, NOT THE MECHANICS (his design, 2026-09-18): "we don't
        // need darts incoming, per-dart damage, and effect of shield. That comes
        // after in the chat card anyways." The dart count, the dice and the
        // "all darts nullified" row are gone from the box; the card after the
        // choice says what happened.
        description: `${foundry.utils.escapeHTML(caster?.name ?? "A caster")} casts `
          + `<span class="ace-qol-reaction-spell">Magic Missile</span> at you`,
        acceptLabel:    "Cast Shield",
        declineLabel:   "Take damage",
        spellSlotLevel: 1,
        availableSlots: shieldCheck.slots,
        // A filled heraldic shield, not the outlined half (his ask).
        icon:           "fa-shield-quartered",
        accentColor:    "#42a5f5",
      });

      if (promptResult.accepted) {
        // ── Consume slot, mark reaction, apply Shield effect ──
        const slotLevel = promptResult.choiceData?.slotLevel ?? 1;
        await this._consumeSpellSlot(targetActor, slotLevel);
        await this._markReactionUsed(targetActor, "shield");
        await this._applyShieldEffect(targetActor, { castLevel: slotLevel });

        // ── Visual flash on the absorbing token ──
        // JB2A free burst with PIXI pulse fallback. Same helper the passive
        // nullification sweep uses, so MM-vs-active-Shield and MM-vs-cast-Shield
        // share the same "absorbed it" visual language.
        try {
          // ⚠️ PATH WAS "../spell-pipeline/…" AND RESOLVED TO NOTHING (fixed
          // 2026-08-06). reaction-engine.mjs lives IN scripts/, so ".." climbs
          // out to the module root; the folder is scripts/spell-pipeline/. The
          // failed import landed in the catch below and was written off as
          // "non-fatal", so the Shield-absorbs-Magic-Missile flash has never
          // played once — silently, since a missing visual raises no complaint.
          // Found by resolving all 864 relative imports in the suite against
          // the filesystem; node --check never follows an import.
          const { AnimationHelper } = await import("./spell-pipeline/animation.mjs");
          AnimationHelper.flashNullification(targetToken, "#42a5f5").catch(() => {});
        } catch (err) {
          console.warn(`${MODULE_ID} | Shield nullification flash unavailable:`, err?.message ?? err);
        }

        // ── Post chat caption noting the negation ──
        await this._postReactionChat(
          targetActor,
          "Shield",
          `${targetActor.name} casts <strong>Shield</strong>! All ${darts} dart${darts !== 1 ? "s" : ""} from ${caster.name}'s Magic Missile are nullified — no damage taken.`,
          "#42a5f5"
        );

        this._debug(`Magic Missile Shield: ${targetActor.name} negated ${darts} darts`);

        // DON'T add this target to the modified distribution — they take no damage.
        // Their darts simply vanish (Shield doesn't redirect; the darts are absorbed).
      } else {
        // Declined or timeout — they take the darts.
        modified.set(targetActor, darts);
      }
    }

    return modified;
  }

  /**
   * Check if an actor can cast Shield as a reaction.
   * @returns {{ canUse: boolean, slots: object[], reason?: string }}
   */
  _canUseShield(actor) {
    // ⚠️🔴 A CORPSE IS NOT ASKED, AND NEITHER IS SOMEBODY UNCONSCIOUS. His list,
    // 2026-09-16: "Dead / unconscious: no pop-up." RAW it is broader than those
    // two and ACE already has the reader: Incapacitated takes away actions AND
    // reactions, and Paralyzed, Stunned, Petrified and Unconscious all carry
    // Incapacitated with them. A prompt that cannot legally be accepted is a
    // prompt that stops the table to be told no.
    if (isOutOfTheFight(actor)) {
      return { canUse: false, slots: [], reason: "it is out of the fight, so it takes no reactions" };
    }

    // Shield already active? (v0.7.18) — they're already protected, no point
    // in prompting them to cast it again (and would waste a reaction + slot).
    // Match by effect name; defense-in-depth for both "Shield" and "Shield Spell".
    try {
      const hasShieldActive = (actor.effects ?? []).some(e =>
        !e.disabled && /^shield(\s+spell)?$/i.test(String(e.name ?? "").trim())
      );
      if (hasShieldActive) return { canUse: false, slots: [], reason: "Shield already active" };
    } catch (_) { /* fall through */ }

    // Reaction already used?
    // ⚠️ A REACTION BUDGET IS A PER-ROUND BUDGET, and rounds only exist in a
    // fight. Out of combat the flag that records "used" is never cleared,
    // because the hook that clears it is `combatTurnChange` — so one reaction
    // taken outside a fight would forbid every reaction until somebody rolled
    // initiative. Same class as the bonus-action spell gate.
    if (hasTurns(actor) && this._hasUsedReaction(actor)) {
      return { canUse: false, slots: [], reason: "Reaction already used this round" };
    }

    // Has Shield prepared, known or always ready?
    // ⚠️ THE READER'S OWN WORDS, NOT "not prepared". "Beiro has Shield, but it
    // is on the sheet but not prepared" and "Beiro does not have Shield" are
    // two different facts, and printing one sentence for both is how this cost
    // a table session.
    const held = this._readySpell(actor, "Shield");
    if (!held.ok) return { canUse: false, slots: [], reason: held.why };

    // Has a spell slot of 1st level or higher?
    const slots = this._getAvailableSlots(actor, 1);
    if (!slots.length) return { canUse: false, slots: [], reason: "it has no 1st-level or higher slot left" };

    return { canUse: true, slots };
  }

  /**
   * Apply the Shield spell active effect to an actor.
   * +5 AC until start of the caster's next turn.
   */
  async _applyShieldEffect(actor, { castLevel = 1 } = {}) {
    // ⚠️🔴 THROUGH THE ONE DOOR, ON THE ROAD THE CAST TAKES (Phase 6a). This
    // built its own ActiveEffect and wrote it straight onto the actor, so the
    // spell's own effect was ignored, nothing waited for anything, and ACE's own
    // library entry for Shield - the one a deliberate cast uses - was bypassed.
    // The self resolver already reads a buff the right way round: the item's own
    // effect first, ACE's by key second. Same order here, same door.
    try {
      const { ConditionDoor } = await import("./road/doors.mjs");
      const item = (actor?.items ?? []).find(i => i.type === "spell" && spellKey(i.name) === "shield") ?? null;
      if (item) {
        let rows = [];
        try {
          const { SelfResolver } = await import("./spell-pipeline/resolvers/self.mjs");
          const activity = [...(item.system?.activities ?? [])][0] ?? null;
          rows = await SelfResolver._ownEffects(item, activity, actor, castLevel) ?? [];
        } catch (err) {
          console.warn(`${MODULE_ID} | could not read ${actor?.name}'s own Shield effect, so ACE's is used:`, err);
        }
        if (rows.length) {
          for (const fx of rows) {
            await ConditionDoor.applyItemEffect(item, actor, fx,
              { outcome: "success", caster: actor, castLevel });
          }
          this._debug(`Shield: ${actor.name} took its own effect through the condition door`);
          return true;
        }
      }
      const out = await ConditionDoor.apply(actor, "shield",
        { castLevel, spellItem: item ?? null, spellLevel: castLevel });
      if (out?.ok) {
        this._debug(`Shield: ACE's own effect went on ${actor.name} through the condition door`);
        return true;
      }
      console.warn(`${MODULE_ID} | Shield did not go on ${actor?.name} through the condition door `
        + `(${out?.immune ? "immune" : "refused"}); falling back to a plain +5.`);
    } catch (err) {
      console.warn(`${MODULE_ID} | the condition door could not put Shield on ${actor?.name}, `
        + `so a plain +5 is used instead:`, err);
    }
    return this._applyShieldEffectDirect(actor);
  }

  /** The old hand-rolled +5, kept as the last resort when the door refuses. */
  async _applyShieldEffectDirect(actor) {
    // Determine duration: until start of this actor's next turn
    // In combat, that's approximately 1 round from now
    const combat = game.combat;
    let duration = {};
    if (combat) {
      duration = {
        rounds: 1,
        startRound: combat.round,
        startTurn: combat.turn,
      };
    } else {
      // Out of combat, 6 seconds
      duration = { seconds: 6 };
    }

    const effectData = {
      name: "Shield",
      icon: "icons/magic/defensive/shield-barrier-flaming-diamond-blue.webp",
      origin: actor.uuid,
      duration,
      changes: [
        {
          key: "system.attributes.ac.bonus",
          mode: CONST.ACTIVE_EFFECT_MODES.ADD,
          value: "5",
          priority: 20,
        },
      ],
      flags: {
        [MODULE_ID]: {
          type: "reactionEffect",
          reaction: "shield",
          autoRemove: true,
        },
      },
    };

    await actor.createEmbeddedDocuments("ActiveEffect", [effectData]);
    this._debug(`Shield effect applied to ${actor.name}`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  2. COUNTERSPELL — Pre-Spell Reaction (when a creature casts a spell)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Internal handler for spell cast detection.
   * Checks for Counterspell reactors within 60 feet.
   */
  /**
   * The Counterspell check for one cast, with a guarantee: when it is over,
   * the cast's hold is released, whatever happened inside.
   *
   * ⚠️🔴 NO GHOST HOLDS (his rule, 2026-09-18): "If you set holding, a box must
   * be on someone's screen ... If the box fails to open, clear holding and run
   * the missile. Log why the box failed. Do not leave a ghost Counterspell
   * lock." Every way out of the check below releases the hold on purpose; a
   * throw anywhere inside it would have skipped all of them and left the spell
   * waiting on nothing for thirty seconds. This catches that, lets the spell
   * go ahead, and says why.
   */
  async _onSpellCast(activity, message) {
    const hold = ReactionEngine._castBarriers.get(ReactionEngine._activityKey(activity)) ?? null;
    const name = activity?.item?.name ?? "that spell";
    try {
      await this._counterspellCheck(activity, message);
    } catch (err) {
      console.warn(`${MODULE_ID} | the Counterspell check for ${name} failed, so nobody is asked and `
        + `the spell goes ahead:`, err);
    } finally {
      if (hold && !hold.resolved) {
        console.warn(`${MODULE_ID} | ${name}'s Counterspell hold was still on when its check ended; `
          + `released, and the spell goes ahead.`);
        hold.resolve({ abort: false, reason: "check_ended" });
        hold.resolved = true;
        hold.resolvedWith = { abort: false, reason: "check_ended" };
      }
    }
  }

  async _counterspellCheck(activity, message) {
    // EVERY exit point must resolve the cast barrier so downstream engines
    // (SpellAutoDamage, etc.) don't hang awaiting it.
    if (!activity?.item) {
      ReactionEngine._resolveCastBarrier(activity, { abort: false, reason: "no_item" });
      return;
    }
    const item = activity.item;
    const casterActor = activity.actor ?? item.actor;

    // Only react to spell-type items
    if (item.type !== "spell") {
      ReactionEngine._resolveCastBarrier(activity, { abort: false, reason: "not_spell" });
      return;
    }

    // Cantrips can't be counterspelled.
    // CRITICAL: counterspell RAW compares slot level to the level the spell was
    // CAST at (i.e. the upcasted level), NOT the spell's base level. A Haste
    // (base L3) upcast to L6 should require DC 16 against a L3 Counterspell —
    // not auto-succeed because 3 >= 3. Resolve the cast level from the activity
    // usage data; fall back to base level only if nothing else is available.
    // v0.7.21 fix.
    const baseLevel = item.system?.level ?? 0;
    if (baseLevel === 0) {
      ReactionEngine._resolveCastBarrier(activity, { abort: false, reason: "cantrip" });
      return;
    }
    const messageSystemLevel = Number(message?.system?.spellLevel ?? NaN);
    const messageFlagLevel   = Number(message?.flags?.dnd5e?.use?.spellLevel ?? NaN);
    const activityUsageLevel = Number(activity?.usage?.spellLevel ?? NaN);
    const spellLevel = Number.isFinite(messageSystemLevel) ? messageSystemLevel
                     : Number.isFinite(messageFlagLevel)   ? messageFlagLevel
                     : Number.isFinite(activityUsageLevel) ? activityUsageLevel
                     : baseLevel;
    this._debug(`Counterspell cast-level resolution: base=${baseLevel} msgSys=${messageSystemLevel} msgFlag=${messageFlagLevel} actUsage=${activityUsageLevel} → using ${spellLevel}`);

    // Get the caster's token
    const casterToken = this._getActorToken(casterActor);
    if (!casterToken) {
      ReactionEngine._resolveCastBarrier(activity, { abort: false, reason: "no_caster_token" });
      return;
    }

    // Find all eligible Counterspell reactors within 60 feet
    let reactors = this._findCounterspellReactors(casterToken, casterActor);
    // Drop reactors whose player owner isn't connected — an offline player can't
    // answer the pop-up, so we don't raise a dead prompt (Johnny 2026-07-13:
    // "block counterspell if the owner isn't logged in"). NPCs (GM-owned, no
    // player owner) stay — the GM is here to decide those. Gate: skipOfflineCounterspell.
    if (QolSettings.get?.("skipOfflineCounterspell") !== false) {
      const before = reactors.length;
      reactors = reactors.filter(r => ReactionEngine._reactorOwnerAvailable(r.actor));
      if (before !== reactors.length) {
        this._debug(`Counterspell: dropped ${before - reactors.length} reactor(s) — owner not connected.`);
      }
    }
    if (!reactors.length) {
      ReactionEngine._resolveCastBarrier(activity, { abort: false, reason: "no_reactors_available" });
      return;
    }

    this._debug(`Counterspell check: ${casterActor.name} casts ${item.name} (level ${spellLevel}), ${reactors.length} eligible reactors`);

    // Resolve the spell's targets so the prompt can show "casting Bless on
    // Varek Thalor" instead of just "casting Bless". Three sources, in order:
    //   1. dnd5e usage flag on the chat message (most reliable for the player
    //      who initiated the cast)
    //   2. activity.targets if the dnd5e activity carries them
    //   3. game.user.targets fallback on the caster's client
    let targetNames = "";
    try {
      const msgTargets = message?.flags?.dnd5e?.targets ?? message?.flags?.dnd5e?.use?.targets;
      if (Array.isArray(msgTargets) && msgTargets.length) {
        const names = msgTargets.map(t => {
          if (typeof t === "string") {
            const a = fromUuidSync?.(t);
            return a?.name ?? a?.actor?.name;
          }
          return t?.name ?? t?.actor?.name ?? t?.token?.name;
        }).filter(Boolean);
        if (names.length) targetNames = names.join(", ");
      }
      if (!targetNames) {
        const activityTargets = activity?.targets ?? [];
        const names = [...activityTargets].map(t => t?.actor?.name ?? t?.name).filter(Boolean);
        if (names.length) targetNames = names.join(", ");
      }
      if (!targetNames && game.user.targets?.size) {
        const names = [...game.user.targets].map(t => t.name).filter(Boolean);
        if (names.length) targetNames = names.join(", ");
      }
    } catch (_) { /* non-fatal — leave targetNames empty */ }

    // Build the detail rows. Target line only appears when we resolved at least one name.
    const detailRows = [
      { label: "Spell", value: item.name },
      { label: "Spell Level", value: spellLevel },
    ];
    if (targetNames) {
      detailRows.push({ label: "Target", value: targetNames });
    }
    detailRows.push({ label: "Range", value: "60 feet (must see caster)" });

    // ── v0.7.269 — SEQUENTIAL COUNTERSPELL CASCADE ──
    // RAW: every creature that can see the caster may try to counter the SAME
    // cast. So we don't fire all reactors at once and stop at the first to
    // click — we go ONE AT A TIME, closest first:
    //   • decline          → offer the next reactor
    //   • accept + SUCCESS  → spell countered, STOP (nobody else is prompted)
    //   • accept + FAIL     → the spell is still resolving, so offer the next
    // (Johnny 2026-07-22: Kasimir declines or whiffs → Syrax STILL gets his
    //  shot; if Kasimir lands it, Syrax is never bothered.) The cast barrier's
    //  30s safety net upstream still bounds the whole cascade.
    const orderedReactors = [...reactors].sort((a, b) => (a.distance ?? 0) - (b.distance ?? 0));

    const promptOpts = {
      type: "counterspell",
      title: "Counterspell",
      description: `<strong>${casterActor.name}</strong> is casting <strong>${item.name}</strong> (Level ${spellLevel} spell)${targetNames ? ` on <strong>${targetNames}</strong>` : ""}.`,
      details: detailRows,
      acceptLabel: "Cast Counterspell",
      declineLabel: "Let it go",
      spellSlotLevel: 3,
      icon: "fa-hand-sparkles",
      accentColor: "#ab47bc",
      // Pass extra data for slot picker
      extraData: { targetSpellLevel: spellLevel },
    };

    for (let i = 0; i < orderedReactors.length; i++) {
      const reactor = orderedReactors[i];

      // A failed counter earlier in this cascade already spent that reactor's
      // reaction (and a linked actor can appear on two tokens) — skip anyone
      // no longer holding a reaction.
      if (this._hasUsedReaction(reactor.actor)) continue;

      // The hold says who it is waiting on, so "holding" is never a claim that
      // a box is open when none is.
      const hold = ReactionEngine._castBarriers.get(ReactionEngine._activityKey(activity)) ?? null;
      if (hold) hold.asking = reactor.actor?.name ?? "a creature";
      let result;
      try {
        result = await this._promptReaction({
          ...promptOpts,
          reactorActor: reactor.actor,
          reactorToken: reactor.token,
          availableSlots: reactor.slots,
        });
      } finally {
        if (hold) hold.asking = null;
      }

      // Declined → pass the shot down the line to the next eligible reactor.
      if (!result.accepted) {
        this._debug(`Counterspell: ${reactor.actor.name} declined — cascading (${i + 1}/${orderedReactors.length}).`);
        continue;
      }

      const slotLevel = result.choiceData?.slotLevel ?? 3;
      // v0.7.21: honor the "Consume Spell Slot" checkbox from the dialog.
      // Defaults to true for PCs, false for NPCs (GM convenience). When
      // missing entirely (legacy callers / non-dialog paths), default true
      // so we don't accidentally make slots free.
      const consumeSlot = result.choiceData?.consumeSlot !== false;

      if (consumeSlot) {
        await this._consumeSpellSlot(reactor.actor, slotLevel);
      } else {
        this._debug(`Counterspell slot consumption SKIPPED for ${reactor.actor.name} (NPC default / checkbox off).`);
      }

      // Mark reaction used (still costs the reaction action regardless of slot consumption)
      await this._markReactionUsed(reactor.actor, "counterspell");

      // Determine success
      let countered = false;
      let checkResult = null;
      // ⚠️ The two editions roll DIFFERENT dice against DIFFERENT DCs, so the
      // card cannot describe the result with one hardcoded sentence. Each
      // branch says what it actually did.
      let resultLabel = null;

      // ⚠️ THE TWO EDITIONS RESOLVE COUNTERSPELL COMPLETELY DIFFERENTLY, and
      // ACE only implemented 2014 (Grok audit 2026-08-18). They are not a
      // tweak apart — the die is rolled by a different creature.
      //
      //   2014: the COUNTERSPELLER acts. Slot >= spell level auto-succeeds;
      //         otherwise they make a spellcasting ABILITY CHECK vs DC 10 +
      //         the spell's level.
      //   2024: the TARGET CASTER makes a CONSTITUTION SAVING THROW against
      //         the counterspeller's spell save DC. Fail = spell countered.
      //         There is no slot-level comparison and no auto-success at all;
      //         a 3rd-level Counterspell can stop a 9th-level spell, and an
      //         upcast one cannot "overpower" anything.
      //
      // Running 2014 rules at a 2024 table silently hands the advantage to
      // whoever has the bigger slot, which is exactly backwards.
      //
      // ⚠️🔴 AND THE EDITION IS THE ITEM'S, NOT THE WORLD'S (Phase 6b,
      // 2026-09-16). This asked the world which edition it was on. His world
      // holds BOTH Counterspells at once and has done for months: Kasimir's is
      // 2024, the Archmage (CR 20)'s is 2014, Patrina's is 2014, Morthos's is
      // 2024, and Varek Thalor carries ONE OF EACH. Whichever way a world-level
      // read answered, about half his counterspells would have rolled the wrong
      // dice against the wrong DC - and the two editions are not a tweak apart,
      // they are rolled by different creatures. The suite's one edition reader
      // takes `system.source.rules` off the item and only falls back to the
      // world when the item says nothing.
      const csItem = reactor.item ?? null;
      const edition = RulesBrain.resolveEdition(csItem, reactor.actor);
      this._debug(`Counterspell edition: ${edition} `
        + `(from ${csItem?.system?.source?.rules ? `${reactor.actor.name}'s own copy` : "the world, the item does not say"})`);
      let saveRoll = null;

      if (edition === "2024") {
        // The caster resists. DC is the COUNTERSPELLER's spell save DC, which
        // is what the 2024 item itself asks for: its save activity carries
        // `dc.calculation: "spellcasting"`.
        //
        // ⚠️ `attributes.spelldc` IS NOT A FIELD IN dnd5e 5.x. The string does
        // not appear anywhere in the system; the DC is `attributes.spell.dc`,
        // written by prepareSpellcastingAbility. The old order read the dead
        // name first and only landed on the right one by luck of the fallback
        // chain, and the `?? 13` at the end INVENTED a DC in silence when
        // neither could be read. The right field first, and a number nobody
        // could work out says so out loud.
        let counterDC = Number(reactor.actor.system?.attributes?.spell?.dc ?? NaN);
        if (!Number.isFinite(counterDC)) {
          const ability = this._getSpellcastingAbility(reactor.actor);
          const mod = Number(reactor.actor.system?.abilities?.[ability]?.mod ?? NaN);
          const prof = Number(reactor.actor.system?.attributes?.prof ?? NaN);
          if (Number.isFinite(mod) && Number.isFinite(prof)) {
            counterDC = 8 + mod + prof;
            console.warn(`${MODULE_ID} | Counterspell (2024): ${reactor.actor.name} has no spell save DC on `
              + `its sheet, so it was worked out from ${ability.toUpperCase()} and proficiency: DC ${counterDC}.`);
          } else {
            counterDC = 13;
            console.error(`${MODULE_ID} | Counterspell (2024): ${reactor.actor.name}'s spell save DC could not `
              + `be read OR worked out. DC 13 is a guess - check the sheet and resolve this one by hand.`);
            ui.notifications?.warn(`ACE: ${reactor.actor.name} has no spell save DC. Counterspell used DC 13.`);
          }
        }
        try {
          if (typeof casterActor.rollSavingThrow !== "function") {
            throw new Error("Actor#rollSavingThrow missing on this dnd5e build");
          }
          const result = await casterActor.rollSavingThrow(
            { ability: "con", target: counterDC },
            { configure: false },
            { create: false }
          );
          saveRoll = Array.isArray(result) ? result[0] : result;
        } catch (err) {
          console.warn(`${MODULE_ID} | Counterspell (2024): CON save failed to roll for ${casterActor.name}:`, err);
        }
        if (!saveRoll || typeof saveRoll.total !== "number") {
          // ⚠️ Never silently decide the spell resolved. Say why.
          console.error(`${MODULE_ID} | Counterspell (2024): no valid save from ${casterActor.name} — treating as NOT countered.`);
          ui.notifications?.warn(`ACE: ${casterActor.name}'s Counterspell save did not roll. Resolve manually.`);
          countered = false;
        } else {
          checkResult = saveRoll.total;
          // LUCKY (2014): the countered caster's save, about to fail (luck.mjs).
          try {
            const { againstDC } = await import("./luck.mjs");
            const lk = await againstDC({ actor: casterActor, kind: "save",
              what: `Constitution save against ${reactor.actor.name}'s Counterspell (DC ${counterDC})`,
              roll: saveRoll, total: checkResult, dc: counterDC, dice: "show" });
            if (lk.spent) checkResult = lk.total;
          } catch (err) {
            console.warn(`${MODULE_ID} | Counterspell (2024): Lucky could not be offered on ${casterActor.name}'s save; it stands as rolled:`, err);
          }
          countered = checkResult < counterDC;   // FAILED save = countered
          resultLabel = `${casterActor.name} CON save ${checkResult} vs DC ${counterDC}`;
          this._debug(`Counterspell 2024: ${resultLabel} → ${countered ? "COUNTERED" : "resisted"}`);
        }
      } else if (slotLevel >= spellLevel) {
        // 2014 auto-success: counterspell slot >= spell level
        countered = true;
        resultLabel = `auto-success — L${slotLevel} slot vs L${spellLevel} spell`;
        this._debug(`Counterspell AUTO-SUCCESS (2014): ${reactor.actor.name} (slot ${slotLevel} >= spell ${spellLevel})`);
      } else {
        // 2014 ability check: DC = 10 + spell level
        const dc = 10 + spellLevel;
        const spellcastingAbility = this._getSpellcastingAbility(reactor.actor);
        const abilityMod = reactor.actor.system?.abilities?.[spellcastingAbility]?.mod ?? 0;
        const profBonus = reactor.actor.system?.attributes?.prof ?? 0;

        // Check for Abjuration Wizard feature (adds proficiency to counterspell checks)
        const hasImprovedAbjuration = this._hasFeature(reactor.actor, "Improved Abjuration");

        // Roll the check. A halfling rerolls a natural 1 (luck.mjs).
        const { withHalflingLuck, againstDC } = await import("./luck.mjs");
        const roll = await new Roll(withHalflingLuck(`1d20 + ${abilityMod}${hasImprovedAbjuration ? ` + ${profBonus}` : ""}`, reactor.actor)).evaluate();
        checkResult = roll.total;
        // LUCKY (2014): the counterspeller's own check, about to fail.
        try {
          const lk = await againstDC({ actor: reactor.actor, kind: "check",
            what: `spellcasting check to counter a level ${spellLevel} spell (DC ${dc})`,
            roll, total: checkResult, dc, dice: "show" });
          if (lk.spent) checkResult = lk.total;
        } catch (err) {
          console.warn(`${MODULE_ID} | Counterspell (2014): Lucky could not be offered on ${reactor.actor.name}'s check; it stands as rolled:`, err);
        }
        countered = checkResult >= dc;

        resultLabel = `check ${checkResult} vs DC ${dc}`;
        this._debug(`Counterspell CHECK (2014): ${reactor.actor.name} rolled ${checkResult} vs DC ${dc} → ${countered ? "SUCCESS" : "FAIL"}`);
      }

      if (countered) {
        // ⚠️🔴 RECORD THE DEATH BEFORE ANYTHING ELSE, INCLUDING THE CARD.
        // Everything below this line awaits something - a chat card, a template
        // sweep, a concentration teardown, an animation - and while it does,
        // dnd5e is already placing the area and the save engine is already
        // reading it. Every one of those doors asks the kill-list. It has to be
        // written at the INSTANT the answer is yes, not at the end of the
        // tidying up. (2026-09-17: the save card posted while this branch was
        // still running.)
        ReactionEngine._markCastCounterspelled(activity);
        Hooks.callAll(`${MODULE_ID}.castCounterspelled`, {
          activity, item, casterActor,
          activityUuid: activity?.uuid ?? null,
          itemUuid: item?.uuid ?? null,
          actorId: casterActor?.id ?? null,
          itemId: item?.id ?? null,
        });
        ReactionEngine._resolveCastBarrier(activity, {
          abort: true, reason: "counterspelled", counterspeller: reactor.actor.name,
          // Which book's Counterspell stopped it: that book says what the
          // countered caster loses, and the spell pipeline reads it here
          // (2014 spends the slot it held; 2024 does not).
          edition,
        });
        // ⚠️ AND TAKE IT OFF THE MOUSE. dnd5e may already be waiting for a click
        // to drop this spell's area; after a Yes there is nothing to aim.
        // Arm the one move this spell still had in it (see _teleportLock).
        if (casterActor?.id) {
          ReactionEngine._teleportLock.set(casterActor.id,
            { until: Date.now() + 60000, spell: item?.name ?? "that spell" });
        }
        ReactionEngine.cancelTemplatePreview(`${item?.name ?? "that spell"} was counterspelled`);
        // ⚠️ AND AGAIN, TWICE, BECAUSE THE AIMING MAY NOT HAVE STARTED YET. What
        // automates a spell at his table can draw its own preview a moment AFTER
        // the counter resolves - the macro runs as the activity finishes, and
        // the answer can land first. One cancel at the instant of the verdict
        // catches a crosshair already up; these catch one that arrives straight
        // after. Cheap, and a no-op when the cursor is empty.
        for (const ms of [250, 1200]) {
          setTimeout(() => {
            ReactionEngine.cancelTemplatePreview(`${item?.name ?? "that spell"} was counterspelled`)
              .catch(() => {});
          }, ms);
        }

        // ── Mechanical line + randomized flavor line (v0.7.17b) ──
        const flavorOptions = [
          `${casterActor.name}'s ${item.name} unravels in their hands.`,
          `${casterActor.name}'s ${item.name} is unwoven before it can take form.`,
          `${casterActor.name}'s ${item.name} fizzles into shimmering blue motes.`,
          `${casterActor.name}'s ${item.name} crumbles back into raw arcane noise.`,
          `${casterActor.name}'s ${item.name} dissolves mid-cast, the weave torn apart.`,
        ];
        const flavorText = flavorOptions[Math.floor(Math.random() * flavorOptions.length)];
        const slotLine = edition === "2024" && activity?.consumption?.spellSlot !== false
          && activity?._aceSlotDeferred !== true && spellLevel > 0
          ? ` ${casterActor.name} keeps the slot.` : "";
        const mechanical = `${reactor.actor.name} counterspells ${casterActor.name}'s ${item.name}!`
          + `${resultLabel ? ` (${resultLabel})` : ""}${slotLine}`;
        const flavorBlock = `<div style="margin-top:10px;padding-top:8px;border-top:1px dashed #6b5230;font-size:15px;font-style:italic;color:#e1bee7;font-weight:600;">— ${flavorText}</div>`;
        await this._postReactionChat(reactor.actor, "Counterspell",
          `${mechanical}${flavorBlock}`,
          "#ab47bc");

        // Cancel the spell — set a flag that other engines can check.
        await ReactionEngine._flagMessageCounterspelled(message, {
          by: reactor.actor.name,
          byActorId: reactor.actor.id,
          spellName: item.name,
          spellLevel,
        });

        // ── v0.7.265 — Kill the native resolution the barrier can't stop:
        //    summoned creatures + this cast's own zone template. Mark the cast
        //    so stragglers (anything that lands after this) get deleted too, and
        //    sweep anything dnd5e already placed.
        await ReactionEngine._sweepCounterspelledResolution(activity);

        // ⚠️ 2024 ONLY: "If that spell was cast with a spell slot, the slot
        // isn't expended." That sentence is in the 2024 Counterspell in his own
        // books, right after the Constitution save, and it is not in the 2014
        // one - there, a countered spell is simply gone and so is the slot.
        if (edition === "2024") {
          await this._returnCounteredCasterSlot(casterActor, activity, spellLevel);
        }

        // ── v0.7.265 — End the caster's concentration on the countered spell.
        //    RAW: a countered spell fails entirely, so no concentration should
        //    linger. Registered spells get this from the pipeline, but NATIVE
        //    ones (Summon Fey) never hit it — so we do it here for EVERY
        //    counter. Idempotent (no-op if nothing to end). dnd5e can create
        //    the Concentrating effect a TICK after our barrier resolves, so
        //    retry once (same pattern the pipeline uses).
        try {
          const { SpellPipeline } = await import("./spell-pipeline/pipeline.mjs");
          await SpellPipeline._endConcentrationForCancelledSpell(casterActor, item);
          setTimeout(() => {
            SpellPipeline._endConcentrationForCancelledSpell(casterActor, item).catch(() => {});
          }, 400);
        } catch (err) {
          console.warn(`${MODULE_ID} | counterspell concentration cleanup failed (non-fatal):`, err);
        }

        // ── v0.7.17b — Play counterspell animations ──
        // Ward bubble on counterspeller (Varek) → 300ms wait → counter-burst
        // on the original caster (Kasimir). One animation per side, both
        // brief, total under 1.5s. Magic Missile's own trajectory animation
        // will be suppressed by SpellAutoDamage when it sees abort:true.
        try {
          await this._playCounterspellAnimations(reactor.actor, casterToken);
        } catch (err) {
          console.warn(`${MODULE_ID} | Counterspell animation failed (non-fatal):`, err);
        }

        // Emit hook for other systems to react
        Hooks.callAll(`${MODULE_ID}.spellCountered`, {
          caster: casterActor,
          spell: item,
          counterspeller: reactor.actor,
          slotUsed: slotLevel,
          checkResult,
        });

        // Spell is dead — nobody further down the cascade is prompted.
        // (The barrier was resolved at the top of this branch, before the card.)
        return;
      }

      // ── Failed counter — the spell is STILL being cast, so cascade to the
      //    NEXT reactor. Do NOT resolve the barrier here: that would let the
      //    cast resolve before the next reactor even answers. ──
      await this._postReactionChat(reactor.actor, "Counterspell",
        `${reactor.actor.name} attempts to counterspell ${casterActor.name}'s ${item.name} but fails!${resultLabel ? ` (${resultLabel})` : ""}`,
        "#ef5350");
      this._debug(`Counterspell: ${reactor.actor.name} failed — cascading to the next reactor if any.`);
    }

    // Every eligible reactor declined or whiffed — the cast goes through.
    ReactionEngine._resolveCastBarrier(activity, { abort: false, reason: "no_counter" });
  }

  /**
   * v0.7.17b — Play the two counterspell animations:
   *   1. Ward bubble on the counterspeller (visual: "I'm protected")
   *   2. After 300ms delay, counter-burst on the original caster (visual:
   *      "your spell unravels at your hands")
   *
   * Requires Sequencer + JB2A. Skips silently if either is missing.
   */
  async _playCounterspellAnimations(counterspellerActor, originalCasterToken) {
    // Sequencer is exposed at globalThis.Sequence (v3+) or window.Sequence.
    const Seq = globalThis.Sequence ?? window.Sequence;
    if (!Seq) {
      console.log(`${MODULE_ID} | Counterspell animation: Sequencer not active — skipping visuals`);
      return;
    }
    const counterspellerToken = this._getActorToken(counterspellerActor);
    if (!counterspellerToken || !originalCasterToken) {
      console.log(`${MODULE_ID} | Counterspell animation: missing tokens — skipping`);
      return;
    }

    // Defensive: only play files that actually exist in the user's
    // Sequencer database. Asset-missing failures leave broken sprites
    // that persist forever (the "circular twisting thing" bug). The
    // pre-check prevents that.
    const wardFile   = "jb2a.shield.03.intro.blue";
    const unravelFile = "jb2a.healing_generic.burst.bluewhite";
    const db = globalThis.Sequencer?.Database;
    const wardOK   = db?.entryExists?.(wardFile)   ?? false;
    const unravelOK = db?.entryExists?.(unravelFile) ?? false;
    if (!wardOK && !unravelOK) {
      console.log(`${MODULE_ID} | Counterspell animation: neither effect available in Sequencer DB — skipping`);
      return;
    }

    const seq = new Seq();
    if (wardOK) {
      // (1) Ward bubble on the counterspeller — brief blue shield flash
      seq.effect()
        .file(wardFile)
        .atLocation(counterspellerToken)
        .scaleToObject(2.0)
        .duration(1200)    // hard cap so a failed asset can't persist
        .fadeIn(150)
        .fadeOut(300);
      // (2) Pause so the cause-effect reads cleanly
      seq.wait(300);
    }
    if (unravelOK) {
      // (3) Unravel burst on the original caster — blue-white burst
      // visually reads as "your spell unravels at your hands"
      seq.effect()
        .file(unravelFile)
        .atLocation(originalCasterToken)
        .scaleToObject(1.8)
        .duration(1200)    // hard cap so a failed asset can't persist
        .fadeIn(100)
        .fadeOut(300);
    }
    seq.play();
  }

  /**
   * Called externally to check if a spell was counterspelled.
   * Other engines should call this after the spell cast to decide whether to proceed.
   * @param {ChatMessage} message - The usage message
   * @returns {boolean} true if the spell was countered
   */
  isSpellCountered(message) {
    return !!message?.flags?.[MODULE_ID]?.counterspelled;
  }

  /**
   * Find all creatures within 60 feet that can cast Counterspell.
   * Excludes the caster and allies of the caster.
   */
  _findCounterspellReactors(casterToken, casterActor) {
    const reactors = [];
    if (!canvas.tokens?.placeables) {
      return this._cannotCheck("Counterspell", "the canvas has no tokens yet") ?? reactors;
    }

    const casterDisposition = casterToken.document?.disposition ?? 1;
    // RAW opt-in (`counterspellAnyCaster`): offer against ANY caster you can
    // see, ally included. Default OFF = enemies-only. Read ONCE, defensively —
    // a settings hiccup must never throw and kill the whole counterspell check.
    let counterAnyCaster = false;
    try { counterAnyCaster = QolSettings.get("counterspellAnyCaster") === true; } catch (_) { counterAnyCaster = false; }

    // ⚠️🔴 EVERY REFUSAL HERE WAS SILENT (Phase 6b, 2026-09-16). Nine
    // `continue` statements and not one of them said a word, so "nobody was
    // offered Counterspell" and "nine people were offered it and every one was
    // turned down for a different reason" printed exactly the same thing:
    // nothing. Same shape as the Shield bug an hour earlier, and his rule: a
    // silent early return is indistinguishable from a broken feature.
    //
    // ⚠️ BUT A GOBLIN IS NOT "SKIPPED". Somebody who has never heard of
    // Counterspell is not a counterspeller who was passed over, and one line per
    // token on a crowded map buries the ones that matter. So the spell is looked
    // for FIRST: a creature that does not hold it leaves quietly, and everyone
    // who does hold it is accounted for out loud.
    const skipped = [];
    for (const token of canvas.tokens.placeables) {
      if (!token.actor) continue;
      if (token.actor.id === casterActor.id) continue;

      // Does it hold Counterspell at all? The one reader: an exact name key,
      // dnd5e 5.x's method and prepared number, every copy on the sheet.
      const held = this._readySpell(token.actor, "Counterspell");
      if (!held.ok && !held.item) continue;              // not a counterspeller

      const say = (why) => { skipped.push(`${token.name ?? token.actor.name} (${why})`); };
      if (!held.ok) { say(held.why); continue; }

      // Same disposition = ally, skip (enemies counter enemies) — unless the
      // RAW opt-in read above is on (counter ANY caster you can see).
      if (token.document?.disposition === casterDisposition && !counterAnyCaster) {
        say("it is on the caster's own side, and countering an ally is opt-in");
        continue;
      }

      // ⚠️ "ALIVE" WAS NOT THE QUESTION. This asked whether hit points were
      // above zero, which lets a Paralyzed, Stunned or Petrified creature be
      // asked for a reaction it cannot take: every one of those carries
      // Incapacitated, and Incapacitated takes reactions away. Same reader the
      // Shield prompt uses, so the two cannot drift apart.
      if (isOutOfTheFight(token.actor)) {
        say("it is out of the fight, so it takes no reactions");
        continue;
      }

      // ⚠️ A REACTION BUDGET IS A PER-ROUND BUDGET, AND ROUNDS ONLY EXIST IN
      // A FIGHT. Out of combat nothing clears the flag — the hook that clears it
      // is the turn change — so one counterspell outside a fight would forbid
      // every counterspell until somebody rolled initiative. Same guard as
      // `_canUseShield`, same reason.
      if (hasTurns(token.actor) && this._hasUsedReaction(token.actor)) {
        say("its reaction is already spent this round");
        continue;
      }

      // Must have a 3rd+ level spell slot
      const slots = this._getAvailableSlots(token.actor, 3);
      if (!slots.length) { say("it has no 3rd-level or higher slot left"); continue; }

      // Must be within 60 feet (Counterspell's range)
      const distance = CombatState._getDistance(token, casterToken);
      if (distance > 60) { say(`it is ${Math.round(distance)} feet away, and the spell reaches 60`); continue; }

      // Must have LINE OF SIGHT to the caster — RAW, you have to SEE the
      // creature casting. The 60 feet check alone let a reactor counterspell
      // through walls / a locked door, even ~200 feet away across rooms
      // (reported 2026-06-28). Test for a sight-blocking wall between the two
      // token centers. Optional-chained + try/caught so a Foundry API shift
      // can't break reactor detection — on any failure we fall through rather
      // than false-block a legitimate counterspell.
      try {
        const losBlocked = CONFIG.Canvas?.polygonBackends?.sight?.testCollision?.(
          token.center, casterToken.center, { type: "sight", mode: "any" }
        );
        if (losBlocked) { say("it cannot see the caster"); continue; }
      } catch (_) { /* LoS test unavailable — don't false-block */ }

      // ⚠️ THE ITEM TRAVELS WITH THE REACTOR. Which edition's Counterspell this
      // is depends on the copy in ITS hands, never on the world setting: his
      // world holds both, and Varek carries one of each.
      reactors.push({ actor: token.actor, token, slots, distance, item: held.item ?? null });
    }

    if (skipped.length) {
      const one = skipped.length === 1;
      console.log(`${MODULE_ID} | Counterspell: not offered to ${skipped.length} `
        + `${one ? "creature that holds" : "creatures that hold"} it — ${skipped.join("; ")}.`);
    }
    return reactors;
  }

  /**
   * True if this reactor can actually answer a reaction pop-up — either it's
   * GM-controlled (NPC, no player owner → the GM is here to decide) or at least
   * one of its player owners is currently connected. Blocks dead counterspell
   * prompts aimed at offline players (Johnny 2026-07-13). Fails OPEN on error so
   * a bug here never silently suppresses a legit reaction.
   */
  static _reactorOwnerAvailable(actor) {
    if (!actor) return false;
    try {
      const owners = game.users?.filter?.(u => u && !u.isGM && actor.testUserPermission?.(u, "OWNER")) ?? [];
      if (!owners.length) return true;          // NPC / GM-owned → GM handles it
      return owners.some(u => u.active);         // an owning player is connected
    } catch (_) {
      return true;   // never suppress a reaction on an error
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  3. ABSORB ELEMENTS — Pre-Damage Reaction (after damage type known)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Uncanny Dodge — halve the damage of one attack you can see coming.
   *
   * PHB Rogue 5: "When an attacker that you can see hits you with an attack
   * roll, you can use your reaction to halve the attack's damage against you."
   *
   * ⚠️ EVERY CLAUSE OF THAT SENTENCE IS A GATE, and they are all here:
   *   "an attacker"        - there has to be one; a trap or a falling rock is not
   *   "that you can see"   - line of sight FROM THE TARGET, and not blinded, and
   *                          the attacker not invisible or hidden
   *   "hits you"           - the attack landed
   *   "with an attack roll"- a saving-throw spell is not an attack roll
   *   "your reaction"      - costs it, and only in combat is there one to spend
   *   "halve the damage"   - ALL of it, every type, not just the weapon dice
   *
   * ⚠️ THE FEATURE IS READ FROM THE REGISTRY, NOT MATCHED BY NAME. The
   * class-features registry already knows what Uncanny Dodge is, including the
   * Rogue-5 requirement and any homebrew override, and `NullificationWalker` is
   * its reader. Name-matching here would drift from it the first time somebody
   * renamed the feature on a sheet.
   */
  async _checkUncannyDodge(damageComponents, targetActor, targetToken, attacker, attackItem, hit) {
    const no = { used: false, result: { modifiedComponents: damageComponents, absorbed: false } };

    // ⚠️🔴 EVERY REFUSAL BELOW SAYS WHY. This function used to hold SEVEN
    // silent `return no` paths, and on 2026-08-26 one of them ate the feature
    // outright. The post-roll caller passes the damage result as `hit`; a
    // damage result carried `isCrit` and no `hitResult`; and the line
    // `if (hit && !hit.hitResult) return no;` bailed on every hit in the game
    // without a word. Firaxis CRIT Jeth for 18 and Jeth was offered nothing,
    // twice, while I hunted the reaction engine's registration instead.
    //
    // ⚠️ THE ORDER IS THE DESIGN, not tidiness. OWNERSHIP IS CHECKED FIRST so
    // that everything after it can be loud without burying the console: a
    // creature who does not have Uncanny Dodge is the overwhelmingly common
    // case and stays at debug level, while a rogue who COULD have used it and
    // was not asked always states the reason at log level. A refusal nobody
    // can see is indistinguishable from a feature that is not wired up, and I
    // have now lost two test runs to exactly that confusion.
    const decline = (why, loud = true) => {
      const msg = `${MODULE_ID} | Uncanny Dodge not offered to `
        + `${targetActor?.name ?? "a target"}: ${why}`;
      if (loud) console.log(msg);
      else console.debug(msg);
      return no;
    };

    try {
      if (!targetActor || !targetToken) {
        return decline(!targetActor
          ? "the target actor could not be resolved"
          : "the target has no token on this scene");
      }

      // ⚠️🔴 DO NOT IMPORT THE REGISTRY WALKER FROM THIS FILE.
      // `walker.mjs` imports `ace-qol.mjs`, and `ace-qol.mjs` imports THIS
      // module — which is why the top of this file hardcodes MODULE_ID with a
      // comment saying so. Adding that import closed the cycle and took large
      // parts of the suite down mid-session (2026-08-24): spells stopped
      // resolving, templates appeared only sometimes. A circular import does
      // not throw a clean error, it leaves bindings undefined at evaluation
      // time, which is exactly what 'sometimes it works' looks like.
      //
      // `CombatState` is already imported here and already owns feature
      // detection, so the check goes through it. The class level is read the
      // same way Aura of Protection reads paladin levels: from the class item,
      // because multiclassing does not advance a class feature.
      // ⚠️🔴 ASK THE TARGET PROFILE, DO NOT RE-DERIVE IT HERE.
      //
      // This used to hunt the actor for a feature by name and dig the rogue
      // level out of the class items, at the moment damage landed, on every
      // target, on every roll. Johnny, 2026-08-26: "why isn't our target
      // pipeline picking up that Jeth has a reaction at his level and his class
      // and everything else?" It should, and now it does — the profile reports
      // what this creature OWNS and can AFFORD, and this function decides
      // whether it answers THIS hit, which is the pairing only it can judge.
      //
      // ⚠️ THE PROFILE ALREADY GATES ON ROGUE 5, per class and not character
      // level. One reader, so a multiclass rogue can never be judged two
      // different ways by two different features.
      // ⚠️🔴 IMPORTED LAZILY, AND THAT IS NOT FUSSINESS. A static import
      // here closes the cycle this whole file is built to avoid:
      //
      //     reaction-engine → target-profile → situation → ace-qol → reaction-engine
      //
      // ⚠️ AND THE HEADER'S CLAIM THAT THIS FILE HAS NO CYCLE IS ALREADY
      // FALSE. Mapping every static import on 2026-08-26 found 130+ cycles in
      // ace-qol, including one straight back into this file:
      //
      //     reaction-engine → settings → ace-qol → reaction-engine
      //
      // So hardcoding MODULE_ID here never actually kept this module out of the
      // loop. ES modules tolerate cycles; what broke on 08-24 was a binding
      // USED AT EVALUATION TIME inside one, not the loop existing. The lazy
      // import below is still right — it costs nothing and cannot participate
      // in evaluation-order problems — but it is a seatbelt, not the cure, and
      // saying otherwise would be the kind of confident-and-wrong comment that
      // sent me hunting the wrong file twice tonight.
      //
      // That is the same loop that took large parts of the suite down mid-game
      // on 2026-08-24 — spells stopped resolving, templates appeared only
      // sometimes. A circular import throws nothing; it leaves bindings
      // undefined at evaluation time, which is exactly what "sometimes it
      // works" looks like. The MODULE_ID at the top of this file is hardcoded
      // for the same reason.
      //
      // ⚠️ A DYNAMIC IMPORT INSIDE AN ASYNC FUNCTION IS SAFE, because the
      // module graph is fully evaluated long before any damage lands. I wrote
      // the static version first, in this file, two days after the cycle it
      // caused. Checked before shipping rather than after.
      let profile = null;
      try {
        const { buildTargetProfile } = await import("./profiles/target-profile.mjs");
        profile = buildTargetProfile(targetActor, { token: targetToken });
      } catch (err) {
        console.warn(`${MODULE_ID} | could not read the target profile:`, err);
      }

      const owns = profile?.reactiveDefences?.find(d => d.key === "uncannyDodge") ?? null;
      // Quiet: almost nothing on the board is a rogue of the right level.
      if (!owns) return decline("they do not have the feature (rogue level 5 or later)", false);

      // ── From here the creature genuinely owns it, so nothing is quiet ──

      // "your reaction" — outside a combat there are no turns to spend one on.
      if (!hasTurns(targetActor)) {
        return decline("they are not in the encounter, so they have no reaction to spend");
      }
      if (profile?.reactionSpent || this._hasUsedReaction(targetActor)) {
        return decline("their reaction is already spent this round");
      }

      // "an attacker" — a hazard with no creature behind it does not qualify.
      if (!attacker) {
        return decline("nothing is attacking; Uncanny Dodge answers an attacker, not a hazard");
      }

      // ── "when an attacker that you can see hits you with an attack" ──
      //
      // ⚠️ READ THE OUTCOME FROM EITHER SHAPE. Two different objects arrive
      // here as `hit`: the attack pipeline's hit record, which carries
      // `hitResult`, and the post-roll damage result, which was rebuilt
      // without it. The rebuild now carries it, and the fallback below stays
      // as a belt: a pre-rolled damage entry is only ever created inside
      // `for (const hit of hits)`, so its existence already means the attack
      // landed, and `isCrit` then separates a crit from an ordinary hit.
      const outcome = hit?.hitResult
        ?? (typeof hit?.isCrit === "boolean" ? (hit.isCrit ? "critical" : "hit") : null);

      if (hit && !outcome) {
        return decline("this damage carries no attack outcome, so it cannot be confirmed "
          + `as a hit that landed (fields present: ${Object.keys(hit).join(", ")})`);
      }
      if (outcome && outcome !== "hit" && outcome !== "critical") {
        return decline(`the attack resolved as "${outcome}", not a hit`);
      }

      // "that you can see"
      const visible = this._canTargetSeeAttacker(targetToken, attacker);
      if (!visible.can) return decline(visible.why);

      const total = damageComponents.reduce((sum, c) => sum + (c.total ?? c.raw ?? 0), 0);
      if (total <= 0) return decline("the hit deals no damage to halve");

      const halved = Math.floor(total / 2);
      const promptResult = await this._promptReaction({
        reactorActor: targetActor,
        reactorToken: targetToken,
        type: "uncannyDodge",
        title: "Uncanny Dodge",
        description: `<strong>${targetActor.name}</strong> is hit by <strong>${attacker?.name ?? "an attacker"}</strong>`
                   + `${attackItem?.name ? ` with ${attackItem.name}` : ""}. Roll with it?`,
        details: [
          { label: "Damage", value: `${total}` },
          { label: "If you dodge", value: `${halved} (halved)` },
          { label: "Cost", value: "Your reaction" },
        ],
        acceptLabel: `Halve it — take ${halved}`,
        declineLabel: `Take all ${total}`,
        icon: "fa-person-running",
        accentColor: "#9ecbff",
      });

      if (!promptResult.accepted) {
        // Their choice, not a failure - but it goes in the record, because
        // "no prompt appeared" and "the prompt was declined" look identical
        // from the outside and I have already chased that difference once.
        console.log(`${MODULE_ID} | Uncanny Dodge declined by ${targetActor.name}: `
          + `taking all ${total}.`);
        return no;
      }

      await this._markReactionUsed(targetActor, "uncannyDodge");

      // ⚠️ HALVE THE ATTACK, NOT EACH COMPONENT SEPARATELY. Rounding each
      // one down on its own loses a point per damage type: 7 slashing + 3 fire
      // is 10, halved is 5 — but floor(7/2) + floor(3/2) is 3 + 1 = 4. The
      // rogue would be silently robbed on every multi-type hit. Halve the
      // TOTAL, then distribute the loss across the components.
      let remaining = halved;
      const modifiedComponents = damageComponents.map((c, idx) => {
        const isLast = idx === damageComponents.length - 1;
        const raw = c.total ?? c.raw ?? 0;
        const share = isLast ? remaining : Math.floor(raw * halved / total);
        remaining -= share;
        return { ...c, total: Math.max(0, share), uncannyDodged: true };
      });

      console.log(`${MODULE_ID} | Uncanny Dodge: ${targetActor.name} halves ${total} to ${halved} `
        + `from ${attacker?.name ?? "an attacker"}.`);

      return { used: true, result: { modifiedComponents, absorbed: false, uncannyDodged: true } };
    } catch (err) {
      // ⚠️ FAIL OPEN AND LOUD. A reaction that throws must never eat the
      // damage roll — the hit still lands, at full value, and the console says
      // why rather than the rogue quietly losing the feature again.
      console.error(`${MODULE_ID} | Uncanny Dodge check failed — the hit lands in full:`, err);
      return no;
    }
  }

  /**
   * Can the TARGET see the attacker? Not "can the current client see them".
   *
   * ⚠️ `token.visible` IS THE WRONG TOOL HERE. It answers "can the person
   * sitting at this keyboard see it", and this runs on the GM's client, who can
   * usually see everything. A blinded rogue would be offered a reaction they are
   * not entitled to. This asks about the creatures instead: the target's own
   * senses, the attacker's own concealment, and a wall between them.
   */
  _canTargetSeeAttacker(targetToken, attacker, { seen = "the attacker", forWhat = "Uncanny Dodge" } = {}) {
    // ⚠️ ONE READER FOR "can this creature see that one". Feather Fall (2024:
    // "a creature you can see") asks it too, so the words name what is seen.
    try {
      const targetActor = targetToken?.actor;
      if (targetActor?.statuses?.has?.("blinded")) return { can: false, why: "they are blinded" };

      const attackerToken = attacker?.getActiveTokens?.(false, false)?.[0] ?? null;
      if (!attackerToken) return { can: true, why: "" };   // no token to hide behind

      const aActor = attackerToken.actor ?? attacker;
      if (aActor?.statuses?.has?.("invisible")) return { can: false, why: `${seen} is invisible` };
      if (attackerToken.document?.hidden) return { can: false, why: `${seen} is hidden from view` };

      // ⚠️ THE V13 COLLISION CALL, NAMED. `canvas.walls.checkCollision` does
      // NOT exist in V13 and `Ray` is not a global — both were tried and both
      // threw into a catch that reported "no wall", silently disabling wall
      // checks twice (2026-08-06).
      const backend = CONFIG.Canvas?.polygonBackends?.sight;
      if (typeof backend?.testCollision === "function") {
        const blocked = backend.testCollision(
          targetToken.center, attackerToken.center, { type: "sight", mode: "any" });
        if (blocked) return { can: false, why: "a wall is between them" };
      }
      return { can: true, why: "" };
    } catch (err) {
      // Cannot tell → allow. Losing the feature is worse than a rare wrong offer,
      // and the GM is watching the prompt either way.
      console.warn(`${MODULE_ID} | could not test line of sight for ${forWhat} — allowing:`, err);
      return { can: true, why: "" };
    }
  }

  /**
   * Check if a target can use Absorb Elements against incoming damage.
   * Called from DamageEngine before damage is applied.
   *
   * @param {object[]} damageComponents - Array of { type: string, total: number }
   * @param {Actor} targetActor - The target taking damage
   * @param {Token} targetToken - The target's token
   * @param {Actor} attacker - The attacking actor
   * @param {Item} attackItem - The weapon/spell that caused damage
   * @returns {{ modifiedComponents: object[], absorbed: boolean, absorbedType: string|null }}
   */
  async checkPreDamageReactions(damageComponents, targetActor, targetToken, attacker, attackItem, hit = null, opts = {}) {
    if (!QolSettings.get("enableReactions")) {
      this._gateOff("pre-damage reactions (Uncanny Dodge, Absorb Elements)", "enableReactions");
      return { modifiedComponents: damageComponents, absorbed: false };
    }

    // ── UNCANNY DODGE, offered before Absorb Elements ──────────────────────
    //
    // ⚠️🔴 THIS FEATURE HAD NEVER ONCE FIRED. `class-features-registry.mjs`
    // declared it on 2026-07 as `special: { uncannyDodge: true }` and NOTHING in
    // the entire suite ever read that flag. One declaration, zero consumers, so
    // every rogue in Johnny's campaign has taken full damage from every hit
    // since it was written. Johnny, 2026-08-24: "Uncanny Dodge should be firing
    // just like Counterspell does in the middle of combat. I don't know how we
    // missed that." It is the building-a-profile-is-not-consulting-it failure,
    // exactly.
    //
    // It goes FIRST because its trigger is narrower: a hit from an attack roll
    // by an attacker you can see. Absorb Elements answers any elemental damage
    // from any source. Both cost the same reaction, so whichever is offered and
    // taken locks the other out — and on a physical hit the rogue wants this one.
    // ⚠️🔴 DISABLED 2026-08-24, MID-SESSION, ON JOHNNY'S INSTRUCTION.
    //
    // Uncanny Dodge was added to this hot path the same day his spells stopped
    // producing damage cards - Magic Missile, Fireball and a magic staff all
    // silently doing nothing. This runs for EVERY target of EVERY damage roll
    // and it AWAITS a user prompt, so any path where that prompt fails to
    // resolve stalls the damage card forever and the spell looks dead.
    //
    // I have NOT proven that is the cause. That is exactly why it is off: the
    // damage pipeline is the single most load-bearing thing in the suite and it
    // does not get a suspect sitting inside it during a live game. His words:
    // "If it's the reaction-engine, then tear it out or whatever. Stop it,
    // block it. But figure out what it is."
    //
    // Restore by deleting this constant and its guard - the implementation
    // below is untouched and complete. Do NOT restore it without first
    // reproducing the original fault with it off, so we know what fixed what.
    // ⚠️🔴 THE KILL SWITCH IS GONE, AND THE SUSPECT WAS INNOCENT.
    //
    // `UNCANNY_DODGE_ENABLED = false` was set mid-session on 2026-08-24 because
    // this was the newest thing in the damage path on the night his spells
    // stopped producing cards, and the damage pipeline does not get a suspect
    // sitting in it during a live game. The comment above it said: do not
    // restore this without first reproducing the original fault with it off.
    //
    // That condition is now met. The fault was found on 2026-08-26 and it was
    // nothing to do with reactions: `checkPostHitReactions` returned the
    // CALLER'S OWN ARRAY on its early-return paths, and the caller wiped it
    // before refilling from itself. Introduced 2026-04-04, five months before
    // Uncanny Dodge existed. See tools/results-survival-check.mjs.
    //
    // ⚠️ SO THE FEATURE COMES BACK ON, and it is worth saying that it has
    // still NEVER RUN ONCE — declared in the registry in July, read by nothing,
    // then written properly and immediately switched off. Every rogue in the
    // campaign has taken full damage from every hit since it was written.
    // ⚠️🔴 NOT WHILE THE DICE ARE STILL IN THE CUP. The attack-card path
    // passes `skipUncannyDodge` because it runs BEFORE the player presses Roll
    // Damage — ACE pre-rolls behind the scenes, so offering "halve 14 to 7"
    // there asks somebody to react to dice nobody has seen thrown. It is called
    // again from `postPreRolledDamageCard`, once the damage is on screen.
    if (!opts.skipUncannyDodge) {
      const dodge = await this._checkUncannyDodge(
        damageComponents, targetActor, targetToken, attacker, attackItem, hit);
      if (dodge.used) return dodge.result;
    }

    if (!QolSettings.get("autoAbsorbElements")) {
      this._gateOff("Absorb Elements", "autoAbsorbElements");
      return { modifiedComponents: damageComponents, absorbed: false };
    }

    // ⚠️🔴 WHETHER SHE HOLDS IT IS ASKED FIRST NOW (2026-09-17, his table,
    // twice). "Console has zero Absorb lines" - and the reason it could be zero
    // for a creature holding the spell is that the elemental-damage test came
    // BEFORE the spell test and returned without a word. A card whose damage
    // did not read as fire - a type label spelled differently, "none" from an
    // importer, a total with no type at all - left Aryel unasked and the
    // console blank. For anybody who holds the spell, that is a refusal like
    // any other and it is said out loud.
    const heldFirst = this._readySpell(targetActor, "Absorb Elements");
    const typeOf = (c) => String(c?.type ?? "").trim().toLowerCase();
    const elementalComponents = damageComponents.filter(c => ABSORB_ELEMENT_TYPES.has(typeOf(c)));
    if (!elementalComponents.length) {
      // ⚠️ ONLY WHERE A MISLABELLED FIREBALL COULD HIDE. A sword cut on a
      // wizard is honest slashing and Absorb Elements was never going to answer
      // it; printing a line for every melee hit on every caster would bury the
      // one that matters. What deserves a line is damage whose type is MISSING
      // or not one dnd5e knows - "none", blank, a word an importer made up -
      // because that is exactly how real fire can arrive looking like nothing.
      // An empty table is no table: only consult it when it has entries, so a
      // missing registry can never make every type look suspicious.
      const table = globalThis.CONFIG?.DND5E?.damageTypes ?? null;
      const known = table && Object.keys(table).length ? table : null;
      const recognised = (t) => !!t && t !== "none" && (!known || (t in known));
      const suspicious = damageComponents.filter(c => !recognised(typeOf(c)));
      if (heldFirst.item && suspicious.length) {
        const kinds = [...new Set(damageComponents.map(c => typeOf(c) || "no type"))].join(", ");
        console.log(`${MODULE_ID} | Absorb Elements: ${targetActor.name} is not asked - this damage is `
          + `${kinds || "empty"}, and the spell only answers acid, cold, fire, lightning or thunder. `
          + `If this was elemental, the card lost its damage type.`);
      }
      return { modifiedComponents: damageComponents, absorbed: false };
    }

    // ⚠️🔴 EVERY "NO" HERE WAS SILENT (Phase 6d, 2026-09-17). His list: "If she
    // cannot use the spell, no box. Write why in the console." Five refusals and
    // not one said a word - the same shape as Shield, Counterspell and the
    // opportunity attack from the same week, and for the same reason it matters:
    // a silent refusal and a broken feature print the same thing.
    //
    // ⚠️ A CREATURE THAT NEVER HELD THE SPELL IS NOT "PASSED OVER". Only one
    // that holds it is named, or a Fireball through a crowd prints a line for
    // every goblin in it.
    const unchanged = { modifiedComponents: damageComponents, absorbed: false };
    const held = this._readySpell(targetActor, "Absorb Elements");
    if (!held.ok && !held.item) return unchanged;                 // never had it
    const say = (why) => {
      console.log(`${MODULE_ID} | Absorb Elements: ${targetActor.name} is not asked - ${why}.`);
      return unchanged;
    };
    if (!held.ok) return say(held.why);
    // The same reader Shield, Counterspell and the opportunity attack ask.
    if (isOutOfTheFight(targetActor)) return say("it is out of the fight, so it takes no reactions");
    // A reaction budget only exists inside a fight; out of combat the flag that
    // records it is never cleared.
    if (hasTurns(targetActor) && this._hasUsedReaction(targetActor)) {
      return say("its reaction is already spent this round");
    }

    const slots = this._getAvailableSlots(targetActor, 1);
    if (!slots.length) return say("it has no 1st-level or higher slot left");

    // Determine the dominant elemental damage type
    const dominantType = elementalComponents.reduce((a, b) => a.total >= b.total ? a : b).type;

    // Build damage breakdown for display
    const damageBreakdown = elementalComponents.map(c => `${c.total} ${c.type}`).join(", ");

    const promptResult = await this._promptReaction({
      reactorActor: targetActor,
      reactorToken: targetToken,
      type: "absorbElements",
      title: "Absorb Elements",
      description: `<strong>${targetActor.name}</strong> is about to take elemental damage from <strong>${attacker?.name ?? "a source"}</strong>.`,
      details: [
        { label: "Elemental Damage", value: damageBreakdown },
        { label: "Dominant Type", value: dominantType.charAt(0).toUpperCase() + dominantType.slice(1) },
        { label: "Resistance Granted", value: `${dominantType} (this hit only)` },
        { label: "Bonus Damage", value: `+1d6 ${dominantType} on next melee attack` },
      ],
      acceptLabel: "Absorb Elements",
      declineLabel: "No reaction",
      spellSlotLevel: 1,
      availableSlots: slots,
      icon: "fa-fire-flame-curved",
      accentColor: this._getElementColor(dominantType),
    });

    if (promptResult.accepted) {
      const slotLevel = promptResult.choiceData?.slotLevel ?? 1;

      // Consume spell slot
      await this._consumeSpellSlot(targetActor, slotLevel);

      // Mark reaction used
      await this._markReactionUsed(targetActor, "absorbElements");

      // Apply resistance to the elemental damage components (halve them)
      const modifiedComponents = damageComponents.map(c => {
        if (ABSORB_ELEMENT_TYPES.has(String(c?.type ?? "").trim().toLowerCase())) {
          return { ...c, total: Math.floor(c.total / 2), absorbElementsResisted: true };
        }
        return c;
      });

      // Apply bonus damage flag for next melee attack
      // Bonus dice scale with slot level: 1d6 base + 1d6 per level above 1st
      const bonusDice = slotLevel;
      // ⚠️🔴 THIS FLAG WAS WRITTEN AND NEVER READ (found 2026-09-17). Nothing
      // anywhere in the suite looked at it, so the "+1d6 on your next melee
      // attack" the card promised has never once been dealt. It is read now by
      // the damage roll itself - DamageCalculator.rollDamageComponents - which
      // is the one place a hit's damage is thrown, so the die lands with the
      // hit and a critical doubles it, as RAW says extra damage dice do.
      //
      // RAW (his own sheet): "the first time you hit with a melee attack ON
      // YOUR NEXT TURN, the target takes an extra 1d6 damage of the triggering
      // type, and the spell ends." So it records the round it was cast in, and
      // the reader refuses it once that next turn is over.
      await targetActor.setFlag(MODULE_ID, "absorbElementsBonus", {
        type: dominantType,
        formula: `${bonusDice}d6`,
        slotLevel,
        timestamp: Date.now(),
        round: game.combat?.round ?? null,
      });

      // Apply a visible effect so the player knows it's active
      await this._applyAbsorbElementsEffect(targetActor, dominantType);

      await this._postReactionChat(targetActor, "Absorb Elements",
        `${targetActor.name} absorbs the ${dominantType} energy! Resistance to ${dominantType} for this hit, +${bonusDice}d6 ${dominantType} on next melee attack.`,
        this._getElementColor(dominantType));

      return { modifiedComponents, absorbed: true, absorbedType: dominantType };
    }

    return { modifiedComponents: damageComponents, absorbed: false, absorbedType: null };
  }

  /**
   * Apply a temporary Absorb Elements active effect.
   */
  async _applyAbsorbElementsEffect(actor, damageType) {
    const combat = game.combat;
    const duration = combat
      ? { rounds: 1, startRound: combat.round, startTurn: combat.turn }
      : { seconds: 6 };

    const effectData = {
      name: `Absorb Elements (${damageType})`,
      icon: "icons/magic/defensive/shield-barrier-flaming-diamond-teal.webp",
      origin: actor.uuid,
      duration,
      flags: {
        [MODULE_ID]: {
          type: "reactionEffect",
          reaction: "absorbElements",
          damageType,
          autoRemove: true,
        },
      },
    };

    await actor.createEmbeddedDocuments("ActiveEffect", [effectData]);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  4. LEGENDARY RESISTANCE — Post-Save Reaction (NPC fails a save)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Check if any NPC that failed a save has Legendary Resistance.
   * Called from SaveEngine after saves are rolled.
   *
   * @param {object[]} saveResults - Array of save results
   *   Each: { tokenDocId, actorId, actor, name, total, dc, saved, ability }
   * @returns {object[]} Modified results (saved may flip to true)
   */
  async checkPostSaveReactions(saveResults) {
    if (!QolSettings.get("enableReactions")) {
      this._gateOff("post-save reactions", "enableReactions");
      return [...saveResults];
    }
    if (!QolSettings.get("autoLegendaryResistance")) {
      this._gateOff("Legendary Resistance", "autoLegendaryResistance");
      return [...saveResults];
    }

    const modified = [];

    for (const result of saveResults) {
      // Only check failures
      if (result.saved) { modified.push(result); continue; }

      // ── Gate: Legendary Resistance applies ONLY to an actual saving throw ──
      // Skip any result that didn't involve a save (no save ability or no DC) —
      // e.g. auto-applied / non-save effects that flow through this path. This
      // stops the LR prompt from popping when no save was ever called for.
      // (RAW: attacks never trigger LR either; those don't carry ability+dc.)
      if (!result.ability || !Number.isFinite(Number(result.dc))) {
        modified.push(result);
        continue;
      }

      // ── AND ONLY IF A DIE WAS ACTUALLY THROWN (2026-08-07) ──
      // A caller can hand over a row for a creature whose save was REFUSED
      // before the roll — dead, or immune to everything the power does (ACE's
      // Gate). Those carry a failed-looking shape with no total, and the checks
      // above wave them straight through: the GM gets "X failed a WIS save…
      // Roll vs DC: null vs 17" and can burn a Legendary Resistance charge on a
      // save that never happened. The save engine filters these out at source;
      // this is the belt, so a future caller can't reintroduce it.
      if (result.noRoll || result.pending || !Number.isFinite(Number(result.total))) {
        modified.push(result);
        continue;
      }

      const actor = result.actor ?? game.actors.get(result.actorId);
      if (!actor) { modified.push(result); continue; }

      // ── Check for Legendary Resistance ──
      const lrCheck = this._getLegendaryResistance(actor);
      if (!lrCheck.hasLR || lrCheck.usesRemaining <= 0) {
        modified.push(result);
        continue;
      }

      // Legendary Resistance does NOT cost a reaction — it's a separate resource.
      // So we don't check _hasUsedReaction for this one.

      // ── Prompt the GM ──
      // Mirrors the Counterspell prompt's contextual richness: names the effect
      // being resisted in the description + shows Effect / Save / Roll-vs-DC /
      // Uses-Remaining detail rows. Themed gold (crown + gold sparkles via
      // iconExtra) — the "legendary" cousin of Counterspell's purple sparkles.
      const abil = result.ability?.toUpperCase() ?? "???";
      const sourceName = result.sourceName ?? result.itemName ?? null;
      const description = sourceName
        ? `<strong>${actor.name}</strong> failed a ${abil} save against <strong>${sourceName}</strong>. Spend Legendary Resistance to succeed instead?`
        : `<strong>${actor.name}</strong> failed a ${abil} saving throw. Spend Legendary Resistance to succeed instead?`;
      const details = [];
      if (sourceName) details.push({ label: "Effect", value: sourceName });
      details.push({ label: "Save", value: abil });
      details.push({ label: "Roll vs DC", value: `${result.total} vs ${result.dc}` });
      details.push({ label: "Uses Remaining", value: `${lrCheck.usesRemaining} / ${lrCheck.usesMax}` });

      const promptResult = await this._promptReaction({
        reactorActor: actor,
        reactorToken: this._getActorToken(actor),
        type: "legendaryResistance",
        title: "Legendary Resistance",
        description,
        details,
        acceptLabel: `Use Legendary Resistance (${lrCheck.usesRemaining} left)`,
        declineLabel: "Accept Failure",
        icon: "fa-crown",
        iconExtra: "fa-hand-sparkles",   // gold sparkles alongside the crown (gold via accentColor)
        accentColor: "#ffd54f",
        forceGM: true, // Always prompt GM, even if NPC has a player owner
      });

      if (promptResult.accepted) {
        // Deduct one use
        await this._consumeLegendaryResistance(actor, lrCheck.item);

        // Flip the save to success
        result.saved = true;
        result.legendaryResistance = true;

        await this._postReactionChat(actor, "Legendary Resistance",
          `${actor.name} uses Legendary Resistance to succeed on the ${result.ability?.toUpperCase() ?? ""} saving throw! (${lrCheck.usesRemaining - 1} remaining)`,
          "#ffd54f");
      }

      modified.push(result);
    }

    return modified;
  }

  /**
   * Check if an actor has Legendary Resistance uses remaining.
   */
  _getLegendaryResistance(actor) {
    if (!actor?.items) return { hasLR: false, usesRemaining: 0, usesMax: 0, item: null };

    for (const item of actor.items) {
      const name = item.name?.toLowerCase() ?? "";
      if (name.includes("legendary resistance")) {
        const uses = item.system?.uses;
        if (uses) {
          return {
            hasLR: true,
            usesRemaining: uses.value ?? 0,
            usesMax: uses.max ?? 3,
            item,
          };
        }
        // No uses system — check for "3/Day" in description
        const desc = item.system?.description?.value ?? "";
        const match = desc.match(/(\d+)\/day/i);
        const max = match ? parseInt(match[1]) : 3;
        // Use flag to track consumption if item.uses doesn't exist
        const used = actor.getFlag(MODULE_ID, "legendaryResistanceUsed") ?? 0;
        return {
          hasLR: true,
          usesRemaining: Math.max(0, max - used),
          usesMax: max,
          item,
        };
      }
    }

    // Also check the legendary resistance count from system data (Foundry dnd5e stores this)
    const lr = actor.system?.resources?.legres;
    if (lr && lr.max > 0) {
      return {
        hasLR: true,
        usesRemaining: lr.value ?? 0,
        usesMax: lr.max,
        item: null, // system resource, not an item
      };
    }

    return { hasLR: false, usesRemaining: 0, usesMax: 0, item: null };
  }

  /**
   * Consume one Legendary Resistance use.
   */
  async _consumeLegendaryResistance(actor, lrItem) {
    if (lrItem?.system?.uses) {
      const current = lrItem.system.uses.value ?? 0;
      await lrItem.update({ "system.uses.value": Math.max(0, current - 1) });
    } else if (actor.system?.resources?.legres) {
      const current = actor.system.resources.legres.value ?? 0;
      await actor.update({ "system.resources.legres.value": Math.max(0, current - 1) });
    } else {
      // Fallback: track via flag
      const used = (actor.getFlag(MODULE_ID, "legendaryResistanceUsed") ?? 0) + 1;
      await actor.setFlag(MODULE_ID, "legendaryResistanceUsed", used);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  5. SILVERY BARBS — Post-Success Reaction (attack, save, or check succeeds)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Check if any creature can cast Silvery Barbs after a success.
   * Called from AttackPipeline (attack hits) or SaveEngine (save succeeds).
   *
   * @param {object} opts
   * @param {Actor} opts.actor - The creature that succeeded
   * @param {Token} opts.token - Their token
   * @param {string} opts.rollType - "attack"|"save"|"check"
   * @param {number} opts.total - The roll total
   * @param {number} opts.dc - The DC/AC that was met
   * @param {string} opts.description - e.g., "Goblin's attack roll" or "Dragon's WIS save"
   * @returns {{ rerolled: boolean, newTotal: number|null, barber: Actor|null }}
   */
  async checkSilveryBarbs(opts) {
    if (!QolSettings.get("enableReactions")) {
      this._gateOff("Silvery Barbs", "enableReactions");
      return { rerolled: false };
    }

    const { actor, token, rollType, total, dc, description } = opts;
    if (!actor || !token) {
      return this._cannotCheck("Silvery Barbs",
        `the roll named no ${!actor ? "actor" : "token"} to react to`)
        ?? { rerolled: false };
    }

    // Find eligible Silvery Barbs casters within 60 feet (opponents of the succeeding creature)
    const reactors = this._findSilveryBarbsReactors(token, actor);
    if (!reactors.length) return { rerolled: false };

    this._debug(`Silvery Barbs check: ${actor.name} ${rollType} succeeded (${total}), ${reactors.length} eligible reactors`);

    const result = await this._promptMultipleReactors(reactors, {
      type: "silveryBarbs",
      title: "Silvery Barbs",
      description: `<strong>${actor.name}</strong> succeeded on a ${rollType}!`,
      details: [
        { label: "Creature", value: actor.name },
        { label: "Roll Type", value: rollType.charAt(0).toUpperCase() + rollType.slice(1) },
        { label: "Total", value: total },
        { label: "Needed", value: dc ?? "N/A" },
      ],
      acceptLabel: "Cast Silvery Barbs (Force Reroll)",
      declineLabel: "Allow It",
      spellSlotLevel: 1,
      icon: "fa-wand-sparkles",
      accentColor: "#ce93d8",
    });

    if (result.accepted) {
      const reactor = result.reactor;
      const slotLevel = result.choiceData?.slotLevel ?? 1;

      // Consume spell slot
      await this._consumeSpellSlot(reactor.actor, slotLevel);

      // Mark reaction used
      await this._markReactionUsed(reactor.actor, "silveryBarbs");

      // Force reroll — roll a new d20 and take the lower
      const reroll = await new Roll("1d20").evaluate();
      const rerollD20 = reroll.total;

      // Reconstruct the total: replace the original d20 with the reroll
      // (we need the modifier portion: total - original d20)
      // Since we don't have the exact breakdown, we use the lower of the two totals
      // In practice, the reroll replaces the d20 — creature uses lower result
      // For simplicity, we treat this as: if reroll d20 < original implied d20, use reroll
      const originalD20Approx = total - (dc ? 0 : 0); // We need better data from caller
      // The correct approach: the creature rerolls the d20 and must use the new result
      // We pass back the reroll and let the caller compute
      const newTotal = total - 0 + 0; // Caller will need to recompute — see integration note

      await this._postReactionChat(reactor.actor, "Silvery Barbs",
        `${reactor.actor.name} casts Silvery Barbs! ${actor.name} must reroll (new d20: ${rerollD20}).`,
        "#ce93d8");

      // Emit hook for the ally advantage portion
      // Reactor chooses an ally within 30 feet to gain advantage on next roll
      Hooks.callAll(`${MODULE_ID}.silveryBarbsCast`, {
        caster: reactor.actor,
        target: actor,
        rerollD20,
      });

      return { rerolled: true, newD20: rerollD20, barber: reactor.actor };
    }

    return { rerolled: false };
  }

  /**
   * Find creatures that can cast Silvery Barbs against a succeeding creature.
   */
  _findSilveryBarbsReactors(successToken, successActor) {
    const reactors = [];
    if (!canvas.tokens?.placeables) {
      return this._cannotCheck("Silvery Barbs", "the canvas has no tokens yet") ?? reactors;
    }

    const successDisposition = successToken.document?.disposition ?? 1;

    for (const token of canvas.tokens.placeables) {
      if (!token.actor) continue;
      if (token.actor.id === successActor.id) continue;

      // Must be an opponent (different disposition)
      if (token.document?.disposition === successDisposition) continue;

      // Must be alive
      if ((token.actor.system?.attributes?.hp?.value ?? 1) <= 0) continue;

      // Must have reaction
      if (this._hasUsedReaction(token.actor)) continue;

      // Must have Silvery Barbs prepared
      if (!this._hasSpellPrepared(token.actor, "Silvery Barbs")) continue;

      // Must have a 1st+ level spell slot
      const slots = this._getAvailableSlots(token.actor, 1);
      if (!slots.length) continue;

      // Must be within 60 feet
      const distance = CombatState._getDistance(token, successToken);
      if (distance > 60) continue;

      reactors.push({ actor: token.actor, token, slots, distance });
    }

    return reactors;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  6. CUTTING WORDS (Lore Bard) — Pre-Finalize Reaction
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Check if a Lore Bard can use Cutting Words to reduce a roll.
   * Called from AttackPipeline (attack roll) or DamageEngine (damage roll).
   *
   * @param {object} opts
   * @param {Actor} opts.actor - The creature that rolled
   * @param {Token} opts.token - Their token
   * @param {string} opts.rollType - "attack"|"damage"|"check"
   * @param {number} opts.total - The roll total
   * @param {string} opts.description - Context string
   * @returns {{ reduced: boolean, reduction: number, newTotal: number }}
   */
  async checkCuttingWords(opts) {
    if (!QolSettings.get("enableReactions")) {
      this._gateOff("Cutting Words", "enableReactions");
      return { reduced: false, reduction: 0 };
    }

    const { actor, token, rollType, total, description } = opts;
    if (!actor || !token) {
      return this._cannotCheck("Cutting Words",
        `the roll named no ${!actor ? "actor" : "token"} to react to`)
        ?? { reduced: false, reduction: 0 };
    }

    // Find eligible Lore Bards within 60 feet
    const reactors = this._findCuttingWordsReactors(token, actor);
    if (!reactors.length) return { reduced: false, reduction: 0 };

    this._debug(`Cutting Words check: ${actor.name} ${rollType} (${total}), ${reactors.length} eligible bards`);

    const result = await this._promptMultipleReactors(reactors, {
      type: "cuttingWords",
      title: "Cutting Words",
      description: `<strong>${actor.name}</strong> rolled a ${total} on a ${rollType}.`,
      details: [
        { label: "Creature", value: actor.name },
        { label: "Roll Type", value: rollType.charAt(0).toUpperCase() + rollType.slice(1) },
        { label: "Total", value: total },
        { label: "Subtract", value: "Bardic Inspiration die" },
      ],
      acceptLabel: "Use Cutting Words",
      declineLabel: "Stay Quiet",
      icon: "fa-comment-slash",
      accentColor: "#ff8a65",
    });

    if (result.accepted) {
      const reactor = result.reactor;

      // Consume a Bardic Inspiration use
      await this._consumeBardicInspiration(reactor.actor);

      // Mark reaction used
      await this._markReactionUsed(reactor.actor, "cuttingWords");

      // Roll the Bardic Inspiration die
      const bardDie = this._getBardicInspirationDie(reactor.actor);
      const roll = await new Roll(bardDie).evaluate();
      const reduction = roll.total;
      const newTotal = total - reduction;

      await this._postReactionChat(reactor.actor, "Cutting Words",
        `${reactor.actor.name} uses Cutting Words! Subtracts ${reduction} (${bardDie}) from ${actor.name}'s ${rollType} (${total} → ${newTotal}).`,
        "#ff8a65");

      return { reduced: true, reduction, newTotal };
    }

    return { reduced: false, reduction: 0 };
  }

  /**
   * Find Lore Bards with Cutting Words and Bardic Inspiration uses.
   */
  _findCuttingWordsReactors(targetToken, targetActor) {
    const reactors = [];
    if (!canvas.tokens?.placeables) {
      return this._cannotCheck("Cutting Words", "the canvas has no tokens yet") ?? reactors;
    }

    const targetDisposition = targetToken.document?.disposition ?? 1;

    for (const token of canvas.tokens.placeables) {
      if (!token.actor) continue;
      if (token.actor.id === targetActor.id) continue;

      // Must be an opponent
      if (token.document?.disposition === targetDisposition) continue;

      // Must be alive
      if ((token.actor.system?.attributes?.hp?.value ?? 1) <= 0) continue;

      // Must have reaction
      if (this._hasUsedReaction(token.actor)) continue;

      // Must have Cutting Words feature (Lore Bard 3+)
      if (!this._hasFeature(token.actor, "Cutting Words")) continue;

      // Must have Bardic Inspiration uses
      const biUses = this._getBardicInspirationUses(token.actor);
      if (biUses <= 0) continue;

      // Must be within 60 feet
      const distance = CombatState._getDistance(token, targetToken);
      if (distance > 60) continue;

      reactors.push({ actor: token.actor, token, distance });
    }

    return reactors;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  7. OPPORTUNITY ATTACK TRACKING
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Mark that a creature made an opportunity attack (uses their reaction).
   * Call this from wherever OAs are detected.
   * @param {Actor} actor - The creature that made the OA
   */
  async trackOpportunityAttack(actor) {
    if (!actor) return;
    await this._markReactionUsed(actor, "opportunityAttack");
    this._debug(`Opportunity attack tracked: ${actor.name} (reaction consumed)`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Prompt System — Send Reaction Dialogs to Players
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Prompt a single reactor's owner for a reaction choice.
   * Routes to the correct player via socket, or shows locally for GM.
   *
   * @param {object} opts - Prompt configuration
   * @returns {Promise<{ accepted: boolean, choiceData: object }>}
   */
  async _promptReaction(opts) {
    // ⚠️🔴 A REACTION BOX IS SOMETHING HAPPENING, AND THE SILENCE WATCH MUST
    // KNOW (his table, 2026-09-18): "Toast: 'Magic Missile did nothing. no
    // pipeline reported taking it.' The missile DID resolve. Counterspell was
    // refused. Shield was used. Nothing failed." The spell pipeline waits for
    // the Counterspell answer before it opens its picker, the box is an old
    // style Dialog the watch never listened for, and a box on a player's
    // screen cannot be seen from the presser's client at all. So a Counterspell
    // box left open for more than 2.5 seconds was a red banner every time.
    //
    // This is the one door every reaction box goes through, local or remote,
    // so it announces the box to the watch here, and to every other client.
    const box = ReactionEngine._announceBox(opts);
    try {
      return await this._routePrompt(opts);
    } finally {
      ReactionEngine._announceBox(null, box);
    }
  }

  /**
   * Tell the silence watch, on this client and every other, that a reaction
   * box has opened or closed. Only the watch reads it: while a box is open no
   * button is called dead, and a box opening means the press it belongs to did
   * something.
   *
   * @param {object|null} opts   the prompt's options, when it opens
   * @param {string|null} closingId  the id it opened with, to close it
   * @returns {string} the box's id
   */
  static _announceBox(opts, closingId = null) {
    const id = closingId
      ?? `${game.user?.id ?? "?"}-${++ReactionEngine._boxCounter}-${Date.now()}`;
    const data = closingId
      ? { id, open: false }
      : { id, open: true, what: `${opts?.title ?? opts?.type ?? "a reaction"} for `
          + `${opts?.reactorActor?.name ?? opts?.reactorActorName ?? "a creature"}` };
    // The watch lives on this client too. Imported when needed, never at load:
    // the reading reaches the spell pipeline, which reaches back here.
    import("./profiles/action-interceptor.mjs")
      .then(({ ActionInterceptor }) => ActionInterceptor.reactionBox(data))
      .catch(err => console.warn(`${MODULE_ID} | could not tell the silence watch about a reaction box:`, err));
    try { game.socket?.emit?.(SOCKET_NAME, { action: "reactionBox", ...data }); }
    catch (err) { console.warn(`${MODULE_ID} | could not tell the other clients about a reaction box:`, err); }
    return id;
  }

  /** Where a reaction prompt goes: its owner's screen, or this one. */
  async _routePrompt(opts) {
    const { reactorActor, reactorToken, forceGM } = opts;
    // v0.7.21: reaction-prompt timeout REMOVED — reactions wait
    // indefinitely for an explicit user click. (See _promptLocal +
    // showReactionDialog for rationale.) Cast-barrier 30s safety net
    // upstream still prevents spell-pipeline hangs.

    // Determine who should see this prompt
    // ⚠️ `find(u => u.isGM)` returns the FIRST GM in the list, which need not be
    // the GM actually running this save. With two GMs connected that sent a
    // Legendary Resistance prompt across the socket to the other one for no
    // reason — the same split-brain class as the save-template bug on 08-15.
    // Prefer this client when it is a GM; only go remote if it genuinely is not.
    const ownerId = forceGM
      ? (game.user.isGM ? game.user.id : (game.users.activeGM?.id ?? game.users.find(u => u.isGM)?.id))
      : this._getOwnerUserId(reactorActor);

    // If the owner is the current user (GM or player), show locally
    if (ownerId === game.user.id) {
      return this._promptLocal(opts);
    }

    // Otherwise, send via socket to the owning player
    return this._promptRemote(opts, ownerId);
  }

  /**
   * Show a reaction prompt locally (this client).
   *
   * v0.7.21: outer auto-resolve timer REMOVED. The reaction dialog now waits
   * indefinitely for an explicit Accept/Decline click — RAW decisions
   * shouldn't be racing a stopwatch. (Cast-barrier 30s safety net still
   * exists upstream so the spell pipeline never hangs forever.)
   */
  async _promptLocal(opts) {
    // ── Detect PC vs NPC reactor so the dialog can default the
    // "Consume Spell Slot" checkbox appropriately. NPCs default OFF
    // (GM convenience — don't track NPC slot economy). PCs default ON.
    const reactorIsNpc = !opts.reactorActor?.hasPlayerOwner
                      && opts.reactorActor?.type !== "character";

    // ⚠️🔴 A BOX MUST BE SEEN TO OPEN (his rule, 2026-09-18): "If you set
    // holding, a box must be on someone's screen that same second. If the box
    // fails to open, clear holding and run the missile. Log why the box
    // failed." The box reports the moment it is drawn; if that has not happened
    // within remoteAckMs, it counts as a no and the console says why.
    let shown = false, settled = false, watchdog = null;
    const name = opts.reactorActor?.name ?? "a creature";
    const answer = ReactionEngine.showReactionDialog({
      ...opts,
      reactorActorName: opts.reactorActor?.name ?? opts.reactorActorName ?? "Reaction",
      reactorActorImg: opts.reactorActor?.img
        ?? opts.reactorToken?.document?.texture?.src
        ?? opts.reactorActorImg
        ?? null,
      // v0.7.71: forward attacker name + portrait (Shield prompt UX polish)
      attackerName: opts.attackerName ?? null,
      attackerImg:  opts.attackerImg  ?? null,
      reactorIsNpc,
      onShown: () => { shown = true; },
    }).catch(err => {
      // ⚠️ A BOX THAT CANNOT OPEN IS A "NO" THAT SAYS SO. This was a silent
      // decline. Feather Fall's box threw on every offer (in git since
      // 2026-08-14) and here that would have left no trace but the fall
      // itself (found 2026-09-18).
      console.warn(`${MODULE_ID} | the ${opts.title ?? "reaction"} box for `
        + `${name} could not open, so it counts as a no:`, err);
      return { accepted: false, choiceData: {} };
    }).finally(() => { settled = true; if (watchdog) clearTimeout(watchdog); });
    const neverShown = new Promise(res => {
      watchdog = setTimeout(() => {
        if (shown || settled) return;
        console.warn(`${MODULE_ID} | the ${opts.title ?? "reaction"} box for ${name} never appeared on this `
          + `screen within ${Math.round(ReactionEngine.remoteAckMs / 1000)} seconds, so it counts as a no.`);
        res({ accepted: false, choiceData: {} });
      }, ReactionEngine.remoteAckMs);
    });
    return Promise.race([answer, neverShown]);
  }

  /**
   * Send a reaction prompt to a remote player via socket.
   *
   * v0.7.21: outer auto-resolve timer REMOVED. The remote prompt waits
   * indefinitely for the player to click. (Cast-barrier safety net upstream
   * still prevents the spell pipeline from hanging.) `reactorIsNpc` is
   * computed locally and passed to the dialog for slot-checkbox default —
   * but remote prompts only fire for PC reactors, so this is effectively
   * always false on the receiving end.
   */
  async _promptRemote(opts, targetUserId) {
    return new Promise((resolve) => {
      const requestId = `reaction-${++this._requestCounter}-${Date.now()}`;
      this._pendingRequests.set(requestId, { resolve, reactorActorId: opts.reactorActor?.id, targetUserId,
        shown: false });

      // ⚠️🔴 THE OTHER SCREEN MUST SAY THE BOX OPENED (his rule, 2026-09-18).
      // This waited for the answer with no limit and no way to know the box was
      // ever drawn, so a player's client that never showed it held the spell
      // with nothing on anybody's screen. The player's client now says the
      // moment the box is up (reactionPromptShown); with no word inside
      // remoteAckMs the box counts as one that failed to open: a no, and the
      // console names whose screen it never reached.
      setTimeout(() => {
        const waiting = this._pendingRequests.get(requestId);
        if (!waiting || waiting.shown) return;
        this._pendingRequests.delete(requestId);
        const who = game.users?.get?.(targetUserId)?.name ?? "that player";
        console.warn(`${MODULE_ID} | the ${opts.title ?? "reaction"} box for ${opts.reactorActor?.name ?? "a creature"} `
          + `never appeared on ${who}'s screen (no word from their client in `
          + `${Math.round(ReactionEngine.remoteAckMs / 1000)} seconds), so it counts as a no.`);
        resolve({ accepted: false, choiceData: {} });
      }, ReactionEngine.remoteAckMs);

      const reactorIsNpc = !opts.reactorActor?.hasPlayerOwner
                        && opts.reactorActor?.type !== "character";

      // Send to player
      game.socket.emit(SOCKET_NAME, {
        action: "showReactionPrompt",
        targetUserId,
        requestId,
        promptData: {
          ...opts,
          // Serialize actor/token references (can't send full objects over socket)
          reactorActorId: opts.reactorActor?.id,
          reactorActorName: opts.reactorActor?.name,
          reactorActorImg: opts.reactorActor?.img ?? opts.reactorToken?.document?.texture?.src,
          reactorTokenId: opts.reactorToken?.id,
          // v0.7.71: attacker name + portrait (Shield prompt UX polish) — these
          // are already primitives/strings, so they survive the socket roundtrip.
          attackerName: opts.attackerName ?? null,
          attackerImg:  opts.attackerImg  ?? null,
          reactorIsNpc,
          // Strip non-serializable fields
          reactorActor: undefined,
          reactorToken: undefined,
        },
      });
    });
  }

  /**
   * Prompt multiple reactors simultaneously. First to accept wins.
   * Used for Counterspell and Silvery Barbs where multiple creatures may react.
   *
   * @param {object[]} reactors - Array of { actor, token, slots?, distance }
   * @param {object} promptOpts - Base prompt options (merged with reactor-specific data)
   * @returns {Promise<{ accepted: boolean, reactor: object|null, choiceData: object }>}
   */
  async _promptMultipleReactors(reactors, promptOpts) {
    if (!reactors.length) return { accepted: false, reactor: null, choiceData: {} };

    // If only one reactor, just prompt them directly
    if (reactors.length === 1) {
      const r = reactors[0];
      const result = await this._promptReaction({
        ...promptOpts,
        reactorActor: r.actor,
        reactorToken: r.token,
        availableSlots: r.slots,
      });
      return { ...result, reactor: result.accepted ? r : null };
    }

    // Multiple reactors: race them
    return new Promise((resolve) => {
      let resolved = false;
      const abortControllers = [];

      const onResult = (reactor, result) => {
        if (resolved) return;
        if (result.accepted) {
          resolved = true;
          // Cancel remaining prompts (they'll time out gracefully)
          resolve({ accepted: true, reactor, choiceData: result.choiceData });
        }
      };

      // Send prompts to all reactors
      const promises = reactors.map(async (r) => {
        const result = await this._promptReaction({
          ...promptOpts,
          reactorActor: r.actor,
          reactorToken: r.token,
          availableSlots: r.slots,
        });
        onResult(r, result);
        return result;
      });

      // If all decline, resolve as declined
      Promise.all(promises).then(() => {
        if (!resolved) {
          resolved = true;
          resolve({ accepted: false, reactor: null, choiceData: {} });
        }
      });
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Dialog UI — Reaction Prompt Renderer
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Render a reaction prompt dialog. Static — can be called on any client.
   * Matches the ACE QOL aesthetic (dark background, gold accents).
   *
   * @param {object} data - Prompt data
   * @returns {Promise<{ accepted: boolean, choiceData: object }>}
   */
  static showReactionDialog(data) {
    return new Promise((resolve) => {
      const {
        type, title, heading, description, details, acceptLabel, declineLabel,
        spellSlotLevel, availableSlots, icon, iconExtra, accentColor,
        reactorActorName, reactorActorImg, reactorIsNpc, extraData,
        // v0.7.71 — attacker portrait + name (Shield UX polish)
        attackerName, attackerImg,
        // A box's own letters on its yes button, and their edge. Unset: white
        // letters edged in a deeper shade of the face.
        yesInk, yesEdge,
        // A box that asks WHICH, not whether (Lucky's "which d20?", 2026-09-18):
        // one button per choice, [{ id, label, sub }], all in the box's colour.
        // The answer is { accepted: true, choiceData: { choice: id } }; closing
        // the box answers no.
        choices,
      } = data;

      const accent = accentColor ?? "#d4af37";
      // The yes button wears the reaction's own colour, deepened enough that
      // white words stay readable on it, and outlined in a deeper shade still.
      const yesFace = ReactionEngine._shade(accent, 0.72);
      const yesDeep = ReactionEngine._shade(accent, 0.3);
      const esc = (x) => foundry.utils.escapeHTML(String(x ?? ""));
      let resolved = false;

      // ── THE SCENE (his design, 2026-09-18) ──
      // "We've always got to think of the player and immersion, not just the
      // mechanical, official technical side of it." A box that has somebody on
      // the other side (the attacker, the caster) opens on the moment itself:
      // their portrait, the red arrow, yours, and one plain line saying what is
      // happening. The numbers belong on the chat card after the choice. It
      // replaces the old attacker row and the description underneath it.
      const scenePortrait = (img, name, side) => img
        ? `<img src="${img}" class="ace-qol-reaction-scene-portrait ${side}" alt="${esc(name)}" />`
        : `<span class="ace-qol-reaction-scene-portrait ${side} ace-qol-reaction-scene-initial">${esc(String(name ?? "?").charAt(0))}</span>`;
      const sceneHtml = attackerName ? `
        <div class="ace-qol-reaction-scene" style="border-color:${accent}; --ace-accent:${accent}">
          <div class="ace-qol-reaction-scene-row">
            <div class="ace-qol-reaction-scene-side">
              ${scenePortrait(attackerImg, attackerName, "is-them")}
              <span class="ace-qol-reaction-scene-name">${esc(attackerName)}</span>
            </div>
            <i class="fas fa-arrow-right ace-qol-reaction-scene-arrow"></i>
            <div class="ace-qol-reaction-scene-side">
              ${scenePortrait(reactorActorImg, reactorActorName, "is-you")}
              <span class="ace-qol-reaction-scene-name">${esc(reactorActorName ?? "You")} <span class="ace-qol-reaction-scene-you">(you)</span></span>
            </div>
          </div>
          <div class="ace-qol-reaction-scene-line">${description ?? ""}</div>
        </div>` : "";

      // ── Build details rows ──
      const detailRows = (details ?? []).map(d =>
        `<div class="ace-qol-reaction-detail">
          <span class="ace-qol-reaction-detail-label">${d.label}</span>
          <span class="ace-qol-reaction-detail-value" ${d.color ? `style="color:${d.color}"` : ""}>${d.value}</span>
        </div>`
      ).join("");

      // ── Build slot picker (if applicable) ──
      let slotPickerHtml = "";
      if (spellSlotLevel && availableSlots?.length) {
        const options = availableSlots.map(s => {
          const label = s.level === 1 ? "1st" : s.level === 2 ? "2nd" : s.level === 3 ? "3rd" : `${s.level}th`;
          const selected = s.level === spellSlotLevel ? "selected" : "";
          return `<option value="${s.level}" ${selected}>${label} level (${s.current}/${s.max})</option>`;
        }).join("");
        slotPickerHtml = `
          <div class="ace-qol-reaction-slot-picker">
            <label>Spell Slot:</label>
            <select class="ace-qol-reaction-slot-select">${options}</select>
          </div>`;
      }

      // ── v0.7.21: Consume Spell Slot checkbox ──
      // RAW: counterspell consumes a slot. For PCs, default ON (they pay
      // the cost). For NPCs, default OFF (GM convenience — don't track
      // NPC slot economy strictly; otherwise it's "cheating" the GM out
      // of unlimited NPC casts which is the normal table rule).
      // Only render the checkbox when a slot picker is present (i.e.
      // spell-slot-consuming reaction like Counterspell — Shield etc.
      // don't need this control).
      const consumeSlotDefault = reactorIsNpc ? "" : "checked";
      // ⚠️ THE GM'S BOX ONLY (his rule, 2026-09-18): "There is no 'Consume
      // Spell Slot' on the client side ever." It used to be drawn on a
      // player's box too, greyed out and marked GM-only, which is a control
      // the player can see and never use. A player's box has no such line: RAW
      // spends the slot, and the accept handler reads a missing box as "spend".
      // The GM, deciding for an NPC or for a player who is not connected, still
      // gets it, with an NPC starting unticked.
      const consumeSlotHtml = game.user.isGM && spellSlotLevel && availableSlots?.length ? `
        <div class="ace-qol-reaction-consume-slot">
          <label>
            <input type="checkbox" class="ace-qol-reaction-consume-slot-checkbox" ${consumeSlotDefault} />
            <span>Consume spell slot${reactorIsNpc ? " <em style='opacity:0.7;font-size:0.85em;'>(NPC default: off)</em>" : ""}</span>
          </label>
        </div>` : "";

      // ── The header ──
      // With a scene below it, the header is only the reaction's name and its
      // emblem: the scene already shows whose reaction this is, and showing the
      // same portrait and name twice was noise. A box with nobody on the other
      // side (Legendary Resistance, Cutting Words) keeps the reactor's portrait
      // and name here, because nothing else on it says who is deciding.
      const iconsHtml = `<i class="fas ${icon ?? "fa-bolt"}"></i>${iconExtra ? ` <i class="fas ${iconExtra}"></i>` : ""}`;
      const headerHtml = sceneHtml ? `
          <div class="ace-qol-reaction-header ace-qol-reaction-heading-only">
            <span class="ace-qol-reaction-heading" style="color:${accent}">${iconsHtml} ${heading ?? title}</span>
          </div>` : `
          <div class="ace-qol-reaction-header" style="border-color:${accent}">
            ${reactorActorImg ? `<img src="${reactorActorImg}" class="ace-qol-reaction-portrait" />` : ""}
            <div class="ace-qol-reaction-header-text">
              <span class="ace-qol-reaction-actor-name">${reactorActorName ?? "Unknown"}</span>
              <span class="ace-qol-reaction-type-label" style="color:${accent}">${iconsHtml} ${heading ?? title}</span>
            </div>
          </div>`;

      // ── Full dialog HTML ──
      // v0.7.21: countdown timer REMOVED. The user wants the reaction
      // decision to be binary (Accept / Decline) with no time pressure.
      // Upstream cast-barrier 30s safety net still prevents the spell
      // pipeline from hanging if the player walks away. (Asked for again on
      // 2026-09-18 and left off for now, his call.)
      //
      // ⚠️ THE NO IS ALWAYS THE RED PILL (his rule, 2026-09-18): "The red has
      // to be red, though, on the negative." The yes keeps each reaction's own
      // colour: Shield blue, Counterspell purple, Absorb Elements the element.
      const html = `
        <div class="ace-qol-reaction-prompt" data-reaction-type="${type}">
          ${headerHtml}
          <div class="ace-qol-reaction-body">
            ${sceneHtml || `<div class="ace-qol-reaction-description">${description}</div>`}
            ${detailRows ? `<div class="ace-qol-reaction-details">${detailRows}</div>` : ""}
            ${slotPickerHtml}
            ${consumeSlotHtml}
          </div>
          <div class="ace-qol-reaction-buttons">
            ${Array.isArray(choices) && choices.length ? choices.map(c => `
            <button class="ace-qol-reaction-accept ace-qol-reaction-choice" data-choice="${esc(c.id)}" style="--ace-yes:${yesFace}; --ace-yes-deep:${yesDeep}; --ace-yes-ink:${yesInk ?? "#ffffff"}; --ace-yes-edge:${yesEdge ?? yesDeep}">
              <i class="fas ${icon ?? "fa-check"}"></i><span>${esc(c.label)}${c.sub ? `<br><small style="font-size:14px;font-weight:500;opacity:0.9;">${esc(c.sub)}</small>` : ""}</span>
            </button>`).join("") : `
            <button class="ace-qol-reaction-accept" style="--ace-yes:${yesFace}; --ace-yes-deep:${yesDeep}; --ace-yes-ink:${yesInk ?? "#ffffff"}; --ace-yes-edge:${yesEdge ?? yesDeep}">
              <i class="fas ${icon ?? "fa-check"}"></i><span>${acceptLabel ?? "Use Reaction"}</span>
            </button>
            <button class="ace-qol-reaction-decline">
              <i class="fas fa-xmark"></i><span>${declineLabel ?? "Decline"}</span>
            </button>`}
          </div>
        </div>
      `;

      const dialog = new Dialog({
        title: `⚡ ${title} — ${reactorActorName ?? "Reaction"}`,
        content: html,
        buttons: {},
        render: (jq) => {
          const el = jq[0] ?? jq;

          // ⚠️ THE DING (his ask, 2026-09-18): "even I miss pop-ups that come
          // over on the client screen." This draws on the screen of whoever
          // decides, local or remote, so it dings there and nowhere else.
          popupDing(`the ${title ?? "reaction"} box`);
          // And it says it is up, so whoever asked knows a box is on a screen.
          try { data.onShown?.(); }
          catch (err) { console.warn(`${MODULE_ID} | could not report that the ${title ?? "reaction"} box opened:`, err); }

          // ── A box that asks which: every choice is its own answer ──
          el.querySelectorAll(".ace-qol-reaction-choice").forEach(btn => btn.addEventListener("click", () => {
            if (resolved) return;
            resolved = true;
            resolve({ accepted: true, choiceData: { choice: btn.dataset.choice } });
            dialog.close();
          }));

          // ── Accept button ──
          el.querySelector(".ace-qol-reaction-accept:not(.ace-qol-reaction-choice)")?.addEventListener("click", () => {
            if (resolved) return;
            resolved = true;

            const slotSelect = el.querySelector(".ace-qol-reaction-slot-select");
            const slotLevel = slotSelect ? parseInt(slotSelect.value) : (spellSlotLevel ?? null);
            const consumeBox = el.querySelector(".ace-qol-reaction-consume-slot-checkbox");
            // If the checkbox isn't shown at all (non-slot reactions like
            // Shield), default to true so spell-slot reactions don't
            // accidentally skip consumption. If shown, honor the checkbox.
            const consumeSlot = consumeBox ? consumeBox.checked : true;

            resolve({ accepted: true, choiceData: { slotLevel, consumeSlot } });
            dialog.close();
          });

          // ── Decline button ──
          el.querySelector(".ace-qol-reaction-decline")?.addEventListener("click", () => {
            if (resolved) return;
            resolved = true;
            resolve({ accepted: false, choiceData: {} });
            dialog.close();
          });
        },
        close: () => {
          if (!resolved) {
            resolved = true;
            resolve({ accepted: false, choiceData: {} });
          }
        },
      }, {
        classes: ["ace-qol-reaction-dialog"],
        width: 540,                     // v0.7.71: wider to fit 16px+ body text + attacker row
        height: "auto",
        // Center on screen — matches the advantage prompt placement so player
        // attention always lands at the same spot for time-critical decisions.
        top: Math.max(40, Math.floor(window.innerHeight / 2 - 280)),
        left: Math.max(20, Math.floor(window.innerWidth / 2 - 270)),
      });

      dialog.render(true);

      // The ding is played by the render callback above, through the one
      // helper every pop-up uses. This used to play its own quieter ping here
      // as well, through Foundry's old global name, so the box would have
      // sounded twice (2026-09-18).
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Chat Notifications — Reaction Outcome Messages
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Post a compact reaction notification to chat.
   */
  async _postReactionChat(actor, reactionName, text, accentColor = "#d4af37") {
    // v0.7.17b — inline-styled dark wrapper. The previous CSS-class
    // version inherited Foundry's parchment chat-card background and
    // rendered as light-on-light. Inline styles guarantee the brand
    // look regardless of upstream CSS scope.
    const html = `
      <div style="background:linear-gradient(180deg,#1a1410 0%,#0f0a08 100%);border:2px solid ${accentColor};border-radius:6px;padding:14px;color:#f0e4c0;font-family:'Signika','Helvetica Neue',sans-serif;box-shadow:0 0 12px ${accentColor}33;">
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;row-gap:4px;font-size:16px;font-weight:700;color:${accentColor};text-transform:uppercase;letter-spacing:0.6px;border-bottom:1px solid #4a3a28;padding-bottom:8px;margin-bottom:10px;">
          <i class="fas fa-bolt" style="font-size:18px;color:${accentColor};flex-shrink:0;"></i>
          <span style="flex:1 1 auto;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">REACTION — ${reactionName.toUpperCase()}</span>
        </div>
        <div style="font-size:16px;line-height:1.5;color:#f0e4c0;font-weight:500;">${text}</div>
      </div>
    `;

    // ⚠️ THE CARD DOOR, like every other card ACE posts (The One Road, §11).
    const { CardDoor } = await import("./road/doors.mjs");
    await CardDoor.post({
      content: html,
      speaker: ChatMessage.getSpeaker({ actor }),
      flags: {
        [MODULE_ID]: {
          type: "reactionNotification",
          reaction: reactionName.toLowerCase().replace(/\s+/g, "-"),
          actorId: actor.id,
        },
      },
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Utility — Spell/Feature/Slot Helpers
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Check if an actor has a spell prepared (or known, for spontaneous casters).
   */
  _hasSpellPrepared(actor, spellName) {
    return this._readySpell(actor, spellName).ok;
  }

  /**
   * The same question, with the answer's REASON kept.
   *
   * ⚠️🔴 THIS IS WHERE SHIELD DIED (2026-09-16). Both halves of the old reader
   * were wrong, and each one alone was enough to break it:
   *
   *   • It matched the name with `includes`, so Fire Shield, Shield of Faith
   *     and Shield Master all counted as Shield.
   *   • It asked whether the preparation mode was the string "prepared", which
   *     is a dnd5e 3.x value. Every spell in his world reads `method: "spell"`,
   *     so the reader fell out of the bottom and said no to every slot caster
   *     alive — for Shield, Counterspell, Absorb Elements and Silvery Barbs
   *     alike, on every path, attack and Magic Missile both.
   *
   * Both rules now live in `rules/spell-ready.mjs`, which is the only place in
   * the suite allowed to write them down.
   *
   * @returns {{ok: boolean, item: Item|null, why: string}}
   */
  _readySpell(actor, spellName) {
    return hasReadySpell(actor, spellName);
  }

  /**
   * Get available spell slots at or above a minimum level.
   * @returns {object[]} Array of { level, current, max, isPact }
   */
  _getAvailableSlots(actor, minLevel = 1) {
    const slots = [];
    const spells = actor.system?.spells ?? {};

    for (let level = minLevel; level <= 9; level++) {
      const slot = spells[`spell${level}`];
      if (slot && slot.value > 0 && slot.max > 0) {
        slots.push({ level, current: slot.value, max: slot.max });
      }
    }

    // Pact slots
    if (spells.pact?.value > 0 && spells.pact?.max > 0 && (spells.pact.level ?? 1) >= minLevel) {
      slots.push({
        level: spells.pact.level ?? 1,
        current: spells.pact.value,
        max: spells.pact.max,
        isPact: true,
      });
    }

    return slots;
  }

  /**
   * Consume a spell slot from an actor.
   */
  async _consumeSpellSlot(actor, level) {
    const spells = actor.system?.spells ?? {};

    // Try pact slots first if the level matches
    if (spells.pact?.value > 0 && (spells.pact.level ?? 1) === level) {
      await actor.update({ "system.spells.pact.value": spells.pact.value - 1 });
      this._debug(`Consumed pact slot (level ${level}) from ${actor.name}`);
      return;
    }

    // Regular spell slot
    const slotKey = `spell${level}`;
    const slot = spells[slotKey];
    if (slot?.value > 0) {
      await actor.update({ [`system.spells.${slotKey}.value`]: slot.value - 1 });
      this._debug(`Consumed level ${level} spell slot from ${actor.name} (${slot.value - 1} remaining)`);
    }
  }

  /**
   * Give back the slot a countered 2024 spell was cast with.
   *
   * ⚠️ ONLY WHAT WAS ACTUALLY SPENT. ACE defers the slot on the spells it
   * owns and commits it once the targets are settled, so on those casts nothing
   * has been taken yet and there is nothing to give back - handing one over
   * would be a free slot, which is worse than the bug it fixes. Two guards: the
   * deferral marker, and the activity's own word on whether it spends a slot at
   * all. It also refuses to push a creature above its own maximum.
   *
   * ⚠️ AND IT SAYS SO. A slot appearing on a sheet without a word is the kind
   * of thing a table notices three sessions later and cannot explain.
   */
  async _returnCounteredCasterSlot(casterActor, activity, spellLevel) {
    try {
      const level = Number(spellLevel ?? 0);
      if (!casterActor || !(level > 0)) return false;
      if (activity?._aceSlotDeferred === true) {
        this._debug(`Counterspell 2024: ${casterActor.name}'s slot was never spent (ACE had it deferred) - nothing to give back.`);
        return false;
      }
      if (activity?.consumption?.spellSlot === false) {
        this._debug(`Counterspell 2024: ${activity?.item?.name ?? "that cast"} spends no slot, so there is none to give back.`);
        return false;
      }

      const spells = casterActor.system?.spells ?? {};
      const pact = spells.pact;
      const regular = spells[`spell${level}`];
      // A warlock who spent a pact slot gets a pact slot back. Only when the
      // level matches and there is no ordinary slot of that level on the sheet,
      // so a multiclass with both is never handed the wrong one.
      const usePact = pact && Number(pact.level ?? 0) === level && !(Number(regular?.max ?? 0) > 0);
      const bucket = usePact ? pact : regular;
      const path = usePact ? "system.spells.pact.value" : `system.spells.spell${level}.value`;
      if (!bucket || !(Number(bucket.max ?? 0) > 0)) {
        this._debug(`Counterspell 2024: ${casterActor.name} has no level ${level} slots on the sheet - nothing to give back.`);
        return false;
      }
      const now = Number(bucket.value ?? 0);
      if (now >= Number(bucket.max)) {
        this._debug(`Counterspell 2024: ${casterActor.name} is already at ${now} of ${bucket.max} level ${level} slots - not going above the maximum.`);
        return false;
      }
      await casterActor.update({ [path]: now + 1 });
      console.log(`${MODULE_ID} | Counterspell (2024): ${casterActor.name} keeps the `
        + `${usePact ? "pact" : `level ${level}`} slot - the book says a countered spell does not expend it `
        + `(${now} to ${now + 1} of ${bucket.max}).`);
      return true;
    } catch (err) {
      console.warn(`${MODULE_ID} | Counterspell (2024): could not give `
        + `${casterActor?.name ?? "the caster"} their slot back; spend or restore it by hand:`, err);
      return false;
    }
  }

  /**
   * Check if an actor has a feature/class feature by name.
   */
  _hasFeature(actor, name) {
    if (!actor?.items) return false;
    const lcName = name.toLowerCase();
    for (const item of actor.items) {
      if ((item.type === "feat" || item.type === "class" || item.type === "subclass")
          && item.name?.toLowerCase().includes(lcName)) return true;
    }
    return false;
  }

  /**
   * Get the user ID of whoever decides this creature's reaction: its connected
   * player, else a connected GM, else this client.
   *
   * ⚠️ THE RULE LIVES IN who-answers.mjs NOW. It was written out here, and the
   * opportunity attack wrote a different one of its own (every GM plus every
   * owner), which is how an OA card reached the GM's chat as well as the
   * player's (his table, 2026-09-18). Both ask the one file now.
   */
  _getOwnerUserId(actor) {
    return whoAnswers(actor).user?.id ?? game.user.id;
  }

  /**
   * Get a token for an actor (first active token on the current scene).
   */
  _getActorToken(actor) {
    if (!actor) return null;
    const tokens = actor.getActiveTokens?.() ?? [];
    return tokens[0] ?? canvas.tokens?.placeables?.find(t => t.actor?.id === actor.id) ?? null;
  }

  /**
   * Get the spellcasting ability for an actor (INT, WIS, CHA, etc.)
   */
  _getSpellcastingAbility(actor) {
    // Check for explicitly set spellcasting ability
    const spellcastingAbility = actor.system?.attributes?.spellcasting;
    if (spellcastingAbility) return spellcastingAbility;

    // Infer from class
    const classAbilities = {
      wizard: "int", artificer: "int",
      cleric: "wis", druid: "wis", ranger: "wis", monk: "wis",
      bard: "cha", paladin: "cha", sorcerer: "cha", warlock: "cha",
    };

    for (const item of actor.items ?? []) {
      if (item.type === "class") {
        const className = item.name?.toLowerCase() ?? "";
        for (const [cls, ability] of Object.entries(classAbilities)) {
          if (className.includes(cls)) return ability;
        }
        // Check spellcasting.ability on the class item itself
        if (item.system?.spellcasting?.ability) return item.system.spellcasting.ability;
      }
    }

    // Fallback: use highest mental stat
    const abilities = actor.system?.abilities ?? {};
    const mental = [
      { key: "int", mod: abilities.int?.mod ?? 0 },
      { key: "wis", mod: abilities.wis?.mod ?? 0 },
      { key: "cha", mod: abilities.cha?.mod ?? 0 },
    ];
    return mental.reduce((a, b) => a.mod >= b.mod ? a : b).key;
  }

  /**
   * Get Bardic Inspiration remaining uses for an actor.
   */
  _getBardicInspirationUses(actor) {
    for (const item of actor.items ?? []) {
      const name = item.name?.toLowerCase() ?? "";
      if (name.includes("bardic inspiration") && item.system?.uses) {
        return item.system.uses.value ?? 0;
      }
    }
    return 0;
  }

  /**
   * Consume one Bardic Inspiration use.
   */
  async _consumeBardicInspiration(actor) {
    for (const item of actor.items ?? []) {
      const name = item.name?.toLowerCase() ?? "";
      if (name.includes("bardic inspiration") && item.system?.uses) {
        const current = item.system.uses.value ?? 0;
        if (current > 0) {
          await item.update({ "system.uses.value": current - 1 });
          this._debug(`Consumed Bardic Inspiration from ${actor.name} (${current - 1} remaining)`);
        }
        return;
      }
    }
  }

  /**
   * Get the Bardic Inspiration die size for a bard.
   */
  _getBardicInspirationDie(actor) {
    const bardLevel = this._getClassLevel(actor, "bard");
    if (bardLevel >= 15) return "1d12";
    if (bardLevel >= 10) return "1d10";
    if (bardLevel >= 5) return "1d8";
    return "1d6";
  }

  /**
   * Get a class level for an actor.
   */
  _getClassLevel(actor, className) {
    for (const item of actor.items ?? []) {
      if (item.type === "class" && item.name?.toLowerCase().includes(className.toLowerCase())) {
        return item.system?.levels ?? 0;
      }
    }
    return 0;
  }

  /**
   * Get the accent color for an element type (for Absorb Elements display).
   */
  /**
   * A colour made darker, for a button face or the outline on its words.
   * Takes "#rgb" or "#rrggbb"; anything else comes back as a dark neutral,
   * so a colour nobody expected can never paint white words on white.
   *
   * @param {string} hex
   * @param {number} factor  0 (black) to 1 (unchanged)
   * @returns {string}
   */
  static _shade(hex, factor = 0.72) {
    const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(hex ?? "").trim());
    if (!m) return "#2b2b30";
    const full = m[1].length === 3 ? m[1].split("").map(c => c + c).join("") : m[1];
    const k = Math.max(0, Math.min(1, Number(factor) || 0));
    const part = (i) => Math.round(parseInt(full.slice(i, i + 2), 16) * k).toString(16).padStart(2, "0");
    return `#${part(0)}${part(2)}${part(4)}`;
  }

  _getElementColor(type) {
    const colors = {
      acid:      "#c6ff00",
      cold:      "#81d4fa",
      fire:      "#ff6d00",
      lightning: "#ffd54f",
      thunder:   "#b39ddb",
    };
    return colors[type] ?? "#d4af37";
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Debug
  // ═══════════════════════════════════════════════════════════════════════════

  _debug(msg) {
    try {
      if (game.settings.get(MODULE_ID, "debugMode")) {
        console.log(`${MODULE_ID} | REACTION | ${msg}`);
      }
    } catch { /* settings not ready */ }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Why a reaction did not happen
  // ═══════════════════════════════════════════════════════════════════════════
  //
  // ⚠️🔴 THE WHOLE FILE USED TO REFUSE IN SILENCE. An audit on 2026-08-26
  // counted 38 early returns here that gave up without a word, and the same
  // week two of them cost real time:
  //
  //   · Switching "Enable Reactions" off made EVERY attack card in the game
  //     vanish, and nothing anywhere said the setting was involved. It ended
  //     a live session on 24 August.
  //   · Uncanny Dodge declined every hit for an hour because the object it
  //     was handed carried no attack outcome. No prompt, no warning, nothing
  //     to tell a broken feature from a feature deciding not to fire.
  //
  // ⚠️ BUT LOUD IS NOT THE ANSWER EVERYWHERE, and that distinction is the
  // point of having two helpers instead of one. Roughly half the early
  // returns in this file are "this event is not mine to handle" — wrong
  // client, not the active GM, not the targeted user. Those fire on every
  // client for every event, and making them speak would bury the console in
  // noise on every player's machine. Noise gets logging switched off, and
  // then nothing is reported at all. Those stay silent ON PURPOSE and are
  // marked so the next audit does not "fix" them.
  //
  // What speaks is: a setting that is off (once, so it cannot flood), and
  // something missing that should have been there (always, it is a defect).

  /**
   * A reaction is switched off by a setting. Said ONCE per feature per
   * session, so a hook that fires on every spell cast cannot flood the log,
   * while the answer to "why did Counterspell never come up" is still one
   * line in the console rather than a hunt through the settings menu.
   *
   * Returns undefined so a void guard can `return this._gateOff(...)`.
   */
  _gateOff(feature, settingKey) {
    return _gateOff(feature, settingKey);
  }

  /**
   * A reaction could not be checked because something it needs is absent.
   * Always says so: this is a defect, not a preference, and it is exactly
   * the case that reads as "the feature is broken" from the player's chair.
   */
  _cannotCheck(feature, what) {
    return _cannotDo(feature, what);
  }

  /** Static sibling of _debug — used by the static barrier methods
   *  (_createCastBarrier / _resolveCastBarrier / awaitCastBarrier),
   *  which have no `this`. Gated on debugMode so it's silent in production. */
  static _sdebug(msg) {
    try {
      if (game.settings.get(MODULE_ID, "debugMode")) {
        console.log(`${MODULE_ID} | REACTION | ${msg}`);
      }
    } catch { /* settings not ready */ }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
//
//  CSS — Reaction Dialog & Chat Styles
//
//  Add this to styles/ace-qol.css (or inject inline).
//  See the integration section at the bottom of this file for the full CSS block.
//
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Inject reaction engine CSS into the document head.
 * Called once during module initialization.
 */
export function injectReactionCSS() {
  if (document.getElementById("ace-qol-reaction-css")) return;

  const style = document.createElement("style");
  style.id = "ace-qol-reaction-css";
  style.textContent = `
/* ═══════════════════════════════════════════════════════════════════════════
   ACE QOL — Reaction Engine Styles
   ═══════════════════════════════════════════════════════════════════════════ */

/* ── Dialog Chrome ── */
.ace-qol-reaction-dialog .dialog-content { padding: 0; }
.ace-qol-reaction-dialog .window-content {
  background: linear-gradient(180deg, #111116 0%, #0c0c0f 100%);
}
.ace-qol-reaction-dialog .window-header {
  background: linear-gradient(180deg, #1a1a20 0%, #111116 100%) !important;
  border-bottom: 1px solid rgba(212,175,55,0.25) !important;
}

/* ── Prompt Container ── */
.ace-qol-reaction-prompt {
  padding: 0;
  font-family: 'Rajdhani', sans-serif;
}

/* ── Header (portrait + name + type) ──
   v0.7.71: bumped portrait + font sizes to meet CLAUDE.md §4b minimums
   (16px body / 18px heading) for any dialog popping over Foundry chrome. */
.ace-qol-reaction-header {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 14px;
  border-bottom: 2px solid rgba(212,175,55,0.3);
  background: linear-gradient(180deg, rgba(255,255,255,0.04) 0%, transparent 100%);
}
.ace-qol-reaction-portrait {
  width: 56px;
  height: 56px;
  border-radius: 50%;
  border: 2px solid rgba(212,175,55,0.4);
  object-fit: cover;
}
.ace-qol-reaction-header-text {
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.ace-qol-reaction-actor-name {
  font-size: 1.2rem;        /* ≈19px — heading */
  font-weight: 800;
  color: #f0e4c0;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}
.ace-qol-reaction-type-label {
  font-size: 1rem;          /* 16px — body */
  font-weight: 700;
  letter-spacing: 0.5px;
}
/* With a scene below it the header is the reaction's name and emblem alone
   (2026-09-18): the scene already shows whose reaction it is. */
.ace-qol-reaction-header.ace-qol-reaction-heading-only {
  padding: 14px 16px 4px;
  border-bottom: none;
  background: none;
}
.ace-qol-reaction-heading {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 1.3rem;        /* ≈21px — heading */
  font-weight: 800;
  letter-spacing: 0.5px;
}
.ace-qol-reaction-heading i {
  font-size: 1.5rem;
}

/* ── Body ── */
.ace-qol-reaction-body {
  padding: 12px 14px;
}
.ace-qol-reaction-description {
  font-size: 1rem;          /* 16px — body */
  color: #d4cdb8;
  margin-bottom: 10px;
  line-height: 1.5;
}

/* ── The scene (his design, 2026-09-18) ──
   Who is on the other side, the red arrow, and you, with one plain line under
   the portraits saying what is happening. It replaced the v0.7.71 attacker
   row and the description beneath it: a moment, not a form. The numbers go on
   the chat card after the choice. */
.ace-qol-reaction-scene {
  padding: 16px 12px 14px;
  margin-bottom: 10px;
  background: rgba(255,255,255,0.04);
  border: 1px solid;            /* colour set inline from the accent */
  border-radius: 10px;
}
.ace-qol-reaction-scene-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.ace-qol-reaction-scene-side {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  flex: 1 1 0;
  min-width: 0;
}
.ace-qol-reaction-scene-portrait {
  width: 84px;
  height: 84px;
  border-radius: 50%;
  object-fit: cover;
  border: 2px solid rgba(239,83,80,0.55);
  background: #1c1c22;
}
.ace-qol-reaction-scene-portrait.is-you {
  border-color: var(--ace-accent, #d4af37);
}
.ace-qol-reaction-scene-initial {
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 2rem;
  font-weight: 800;
  color: #f0e4c0;
}
.ace-qol-reaction-scene-name {
  font-size: 1.1rem;        /* ≈17.6px */
  font-weight: 800;
  color: #f0e4c0;
  text-align: center;
  line-height: 1.25;
  overflow-wrap: break-word;
  max-width: 100%;
}
.ace-qol-reaction-scene-you {
  font-weight: 600;
  color: #8fa3bd;
}
.ace-qol-reaction-scene-arrow {
  font-size: 2rem;
  color: #e5484d;
  flex-shrink: 0;
}
.ace-qol-reaction-scene-line {
  margin-top: 12px;
  text-align: center;
  font-size: 1.15rem;       /* ≈18px */
  color: #ebe6d8;
  line-height: 1.4;
}
.ace-qol-reaction-scene-line .ace-qol-reaction-spell {
  color: #9fd0ff;
  font-weight: 700;
}

.ace-qol-reaction-details {
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.ace-qol-reaction-detail {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 6px 10px;
  background: rgba(255,255,255,0.03);
  border-radius: 3px;
  border: 1px solid rgba(255,255,255,0.06);
}
.ace-qol-reaction-detail-label {
  font-size: 0.9rem;        /* 14.4px — hint */
  color: #a8a098;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  font-weight: 600;
}
.ace-qol-reaction-detail-value {
  font-size: 1.05rem;       /* ≈16.8px — body */
  color: #f0e4c0;
  font-weight: 700;
}

/* ── Slot Picker ──
   v0.7.71: bumped to body-size minimums per CLAUDE.md §4b. */
.ace-qol-reaction-slot-picker {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 10px;
  padding: 8px 10px;
  background: rgba(255,255,255,0.03);
  border-radius: 3px;
  border: 1px solid rgba(255,255,255,0.06);
}
.ace-qol-reaction-slot-picker label {
  font-size: 0.9rem;        /* 14.4px — hint */
  color: #a8a098;
  text-transform: uppercase;
  font-weight: 600;
  letter-spacing: 0.5px;
}
.ace-qol-reaction-slot-select {
  flex: 1;
  font-size: 1rem;          /* 16px — body */
  background: #1a1a1e;
  color: #f0e4c0;
  border: 1px solid #555;
  border-radius: 3px;
  padding: 5px 8px;
  font-weight: 600;
}

/* ── Consume Spell Slot Checkbox (v0.7.21) ── */
.ace-qol-reaction-consume-slot {
  margin-top: 6px;
  padding: 6px 8px;
  background: rgba(255,255,255,0.03);
  border-radius: 3px;
  border: 1px solid rgba(255,255,255,0.06);
}
.ace-qol-reaction-consume-slot label {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 1rem;          /* v0.7.71: 16px — body min */
  color: #e8e0c8;
  cursor: pointer;
  font-weight: 600;
}
.ace-qol-reaction-consume-slot input[type="checkbox"] {
  width: 16px;
  height: 16px;
  cursor: pointer;
  accent-color: #ab47bc;
}
/* ── Timer (legacy — preserved for any non-counterspell reactions
   that might still want a visible time pressure indicator in future.
   The counterspell flow no longer renders these elements as of v0.7.21.) ── */
.ace-qol-reaction-timer {
  position: relative;
  height: 20px;
  background: rgba(255,255,255,0.05);
  margin: 0 12px;
  border-radius: 2px;
  overflow: hidden;
}
.ace-qol-reaction-timer-bar {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  opacity: 0.3;
  border-radius: 2px;
}
.ace-qol-reaction-timer-text {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  font-size: 0.7rem;
  font-weight: 800;
  color: #aaa;
  letter-spacing: 1px;
}

/* ── Buttons ──
   v0.7.71: bumped to 16px min per CLAUDE.md §4b — the accept button
   especially needs to read clearly under time pressure. */
/* ⚠️🔴 ONE BUTTON HAD flex:1 AND THE OTHER HAD NOTHING.
   So the decline button took its natural width - and "TAKE ALL 14" is wide -
   while the accept button was squeezed into whatever was left. "HALVE IT -
   TAKE 7" then wrapped across FOUR lines and the row grew to ~86px tall to
   contain it. The height was never the problem; the crushed width was.

   Johnny's standing rule, 2026-08-23: WRAPPED ROWS, NEVER SQUEEZED COLUMNS.
   A row that cannot wrap destroys the text to fit - "necrotic" became
   nec/roti/c, and a struck 10 became a 1 over a 0. Here it destroyed the one
   control the player most needs to read under time pressure.

   ⚠️ EQUAL BASIS, NOT JUST EQUAL GROW. flex:1 alone still lets a wide
   label push its own button wider, because the default basis is the content.
   flex:1 1 0 makes both start from zero and share the space evenly, so the
   two buttons are the same width whatever the numbers say.

   ⚠️ AND NO BACKTICKS IN HERE. This CSS lives inside a JS template
   literal, so a backtick in a comment ends the string and the whole module
   stops parsing. Caught by node --check on the way in. */
.ace-qol-reaction-buttons {
  display: flex;
  gap: 10px;
  padding: 12px 14px;
  align-items: stretch;
}
.ace-qol-reaction-buttons > button {
  flex: 1 1 0;
  min-width: 0;              /* a flex child will not shrink below its content without this */
  min-height: 44px;          /* a comfortable click target, and no taller */
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  /* ⚠️ THE WORDS STAY ON THE BUTTON (2026-09-18). This was nowrap, and a
     label longer than its button ran off the edge of it: "Cast Shield
     (negate all darts)" did, on his screen. With both buttons on an equal
     basis a long label wraps between words onto a second line and the row
     grows, which is free; a word is never split. */
  white-space: normal;
  overflow-wrap: normal;
  text-align: center;
  line-height: 1.2;
}
/* ⚠️ THE YES WEARS THE REACTION'S OWN COLOUR, THE NO IS ALWAYS THE RED PILL
   (his rules, 2026-09-18). The yes: a solid face in the reaction's accent,
   deepened so white words read on it, the words outlined in a deeper shade
   still. The no: a red pill, yellow words outlined in black, the X kept.
   The outline is four hard text shadows, which every browser draws the same;
   a text stroke thins the letters where it is not supported.
   A box may choose its own letters and edge: Feather Fall's are black with a
   gold edge on its gold face (his pick, 2026-09-18). */
.ace-qol-reaction-accept {
  padding: 10px 18px;
  font-size: 1.1rem;        /* ≈17.6px */
  font-weight: 800;
  letter-spacing: 0.3px;
  background: var(--ace-yes, #3a6ea5);
  border: 1px solid var(--ace-yes-deep, #16304d);
  border-radius: 8px;
  color: var(--ace-yes-ink, #ffffff);
  text-shadow:
    -1px -1px 0 var(--ace-yes-edge, #16304d), 1px -1px 0 var(--ace-yes-edge, #16304d),
    -1px 1px 0 var(--ace-yes-edge, #16304d), 1px 1px 0 var(--ace-yes-edge, #16304d);
  cursor: pointer;
  transition: filter 0.15s ease;
}
.ace-qol-reaction-accept:hover {
  filter: brightness(1.15);
}
.ace-qol-reaction-decline {
  /* Width, height and wrapping all come from the shared rule above, so the two
     buttons cannot drift apart again the next time one of them is edited. */
  padding: 10px 18px;
  font-size: 1.1rem;        /* ≈17.6px */
  font-weight: 800;
  letter-spacing: 0.3px;
  background: #c62828;
  border: 1px solid #6d1010;
  border-radius: 999px;
  color: #ffd84d;
  text-shadow: -1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000, 1px 1px 0 #000;
  cursor: pointer;
  transition: filter 0.15s ease;
}
.ace-qol-reaction-decline:hover {
  filter: brightness(1.15);
}

/* ── Chat Notification Card ── */
.ace-qol-reaction-chat {
  border-left: 3px solid #d4af37;
  padding: 6px 10px;
  margin: 2px 0;
  background: linear-gradient(90deg, rgba(212,175,55,0.06) 0%, transparent 100%);
  border-radius: 0 4px 4px 0;
  font-family: 'Rajdhani', sans-serif;
}
.ace-qol-reaction-chat-header {
  font-size: 0.7rem;
  font-weight: 800;
  letter-spacing: 1px;
  text-transform: uppercase;
  margin-bottom: 2px;
}
.ace-qol-reaction-chat-body {
  font-size: 0.85rem;
  color: #e0e0e0;
  line-height: 1.4;
}
`;

  document.head.appendChild(style);
}

// ═══════════════════════════════════════════════════════════════════════════════
//
//  INTEGRATION GUIDE
//
//  Below are the exact edits needed in other files to wire up the ReactionEngine.
//  These are documented here for reference — apply them manually.
//
//  1. ace-qol.mjs — Import, init, socket handler, API exposure
//  2. attack-pipeline.mjs — Post-hit Shield check
//  3. save-engine.mjs — Post-save Legendary Resistance check
//  4. settings.mjs — New reaction settings
//
// ═══════════════════════════════════════════════════════════════════════════════
