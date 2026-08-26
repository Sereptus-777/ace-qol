// ─── ACE: QOL — Attack Resolution Pipeline ───────────────────────────────────
// Hooks into D&D 5e attack rolls. When an attack lands:
//   1. Assess every target's full state
//   2. Determine hit/miss/crit per target
//   3. Hand off to damage calculation (Phase 4)
//
// This is the orchestrator — it connects the attack roll to the target state
// assessment and eventually to the damage pipeline.
// ──────────────────────────────────────────────────────────────────────────────

import { MODULE_ID } from "./ace-qol.mjs";
import { TargetState } from "./target-state.mjs";
import { CombatState } from "./combat-state.mjs";
import { QolSettings } from "./settings.mjs";
import { FlagsEngine } from "./flags-engine.mjs";
import { MergeCard } from "./merge-card.mjs";
import { CoverEngine } from "./cover-engine.mjs";
import { RiderEngine } from "./rider-engine.mjs";
import { pendingAttackChoices, awaitDsnRoll, showCenterToast, promptAttackChoice } from "./attack-prompt.mjs";
import { WeaponMasteries } from "./weapon-masteries.mjs";
import { CombatContext } from "./combat-context.mjs";
import { OA_IN_FLIGHT } from "./oa-transient.mjs";
// The two creature snapshots. This pipeline asks THESE what a creature is
// rather than reaching into actor.system and guessing at data shapes — the
// audit found the profile layer was built and never wired. (2026-07-28)
import { buildAttackerProfile, describeAttacker } from "./profiles/attacker-profile.mjs";
import { buildAttackProfile, describeAttack } from "./profiles/attack-profile.mjs";
import { resolveAttack } from "./profiles/resolver.mjs";
import { resolveReach } from "./reach-reader.mjs";
import { buildTargetProfile } from "./profiles/target-profile.mjs";
// The third profile of THE ONE GATE: what lies between the two creatures.
// Built PER TARGET inside the resolution loop, because distance, cover,
// light and elevation all belong to a PAIR, not to a swing.
import { buildEnvironmentProfile } from "./profiles/environment-profile.mjs";
import { SpellPipeline } from "./spell-pipeline/pipeline.mjs";
// Shared "why didn't that happen" reporters. why-not.mjs is a leaf that
// imports nothing, so it cannot join the static import cycles ace-qol.mjs
// sits at the centre of.
import { gateOff } from "./why-not.mjs";

// ─── Profile access for this pipeline (2026-07-28, re-cut 2026-08-25) ────────
//
// Cached per swing so a multi-beam attack (Eldritch Blast, Scorching Ray) builds
// each creature's snapshot once rather than once per beam.
//
// ⚠️🔴 IT USED TO EXPIRE ON A FOUR-SECOND TIMER, AND THAT WAS A BUG.
// A wall clock has nothing to do with when a creature's state changes. Four
// seconds is most of a turn: swing, get knocked prone, swing again inside the
// window, and the second swing reads the FIRST swing's conditions. A creature
// could be knocked out, restrained or KILLED between two rolls and the gate
// would still be looking at the healthy snapshot — which is precisely the
// failure THE ONE GATE exists to prevent, reintroduced by its own cache.
//
// Same shape as the five-second Magic Missile amnesia, and the same rule
// applies: no timers unless a timer genuinely makes sense. This one never did.
//
// ⚠️ SO THE SCOPE IS AN EVENT, NOT A DURATION. Every attack bumps the
// generation; entries stamped with an older one are never returned, whether
// that was four seconds ago or four minutes. Within one attack the snapshot is
// stable (all beams see the same creature, which is correct); across two
// attacks it is always rebuilt.
const _aceProfileCache = new Map();
let _aceProfileGen = 0;

/** Start a new profile generation. Called once per attack event. */
function _aceNewProfileGen() {
  _aceProfileGen++;
  _aceProfileCache.clear();
}

const _aceCached = (key, build) => {
  if (!key) return build();
  const stamped = `${_aceProfileGen}|${key}`;
  const hit = _aceProfileCache.get(stamped);
  if (hit) return hit;
  let p = null;
  try { p = build(); } catch (err) {
    console.warn(`${MODULE_ID} | profile build failed:`, err);
  }
  if (p) _aceProfileCache.set(stamped, p);
  return p;
};


/**
 * ⚠️🔴 REMOVED 2026-08-26 - THE RESOLVER OWNS THIS NOW.
 *
 * `_aceRealProfBonus` decided whether the proficiency bonus applied, from raw
 * item data, at two call sites. It has moved into `resolveProficiency` in
 * profiles/resolver.mjs, which asks the same questions in the same order AND
 * adds the one it never asked: is this creature actually trained with this
 * weapon? The old function handed out proficiency to anyone holding anything.
 *
 * ⚠️ THAT CHANGE NEARLY WENT OUT WRONG. The first version matched the
 * categories on "simple" and "martial"; dnd5e stores them as "sim" and "mar",
 * so it would have matched nothing and silently stripped the proficiency bonus
 * from every character whose sheet lists only categories. Found by reading his
 * actual character data before shipping. See tools/resolver-check.mjs.
 */

/**
 * Say that a swing is NOT going to happen after all.
 *
 * ⚠️🔴 A HOLD THAT IS NEVER RELEASED IS AN ANIMATION THAT NEVER PLAYS
 * AGAIN. Forge FX holds a weapon's effects until `attackCommitted`, so every
 * path that abandons an attack has to say so — otherwise a single out-of-range
 * click leaves that weapon silent for the rest of the session and the held
 * entry sits in a map forever.
 *
 * ⚠️ EVERY GIVE-UP PATH CALLS THIS. Out of range, cannot act, the melee
 * lockout, and Escape on the advantage prompt. If a new refusal is added and
 * this is not called from it, that weapon goes quiet — which is exactly the
 * class of silent failure that cost tonight.
 */
function _announceAttackCancelled(item, actor, why) {
  try {
    Hooks.callAll(`${MODULE_ID}.attackCancelled`, { item, actor, why });
  } catch (err) {
    console.warn(`${MODULE_ID} | attackCancelled listeners threw (non-fatal):`, err);
  }
}

/** The attacker's snapshot — ability mods, proficiency, conditions, gate. */
function _aceAttackerProfile(actor, item = null, activity = null, token = null) {
  if (!actor) return null;
  // ⚠️ THE TOKEN IS PART OF THE ANSWER, so it is part of the key. Elevation,
  // disposition and hidden are token facts, and nine unlinked goblins share one
  // actor — keying on the actor alone hands goblin #7 goblin #1's position.
  const tokenId = token?.document?.id ?? token?.id ?? "";
  const key = `atk:${actor.uuid ?? actor.id}:${tokenId}:${item?.id ?? ""}:${activity?.id ?? ""}`;
  return _aceCached(key, () => buildAttackerProfile(actor, { token, item, activity }));
}

/** The button's snapshot — reach, range, properties, damage, mastery offered. */
function _aceAttackProfile(item, activity = null) {
  if (!item) return null;
  const key = `act:${item.uuid ?? item.id}:${activity?.id ?? ""}`;
  // ⚠️ `repairReach: true` — this is a real swing, so an item whose reach
  // had to be read out of its description gets the field written back once.
  return _aceCached(key, () => buildAttackProfile(item, activity, { repairReach: true }));
}

/** The target's snapshot — ability mods, saves, immunities, conditions. */
function _aceTargetProfile(actor, token = null) {
  if (!actor) return null;
  const key = `tgt:${token?.document?.id ?? token?.id ?? actor.uuid ?? actor.id}`;
  return _aceCached(key, () => buildTargetProfile(actor, { token }));
}

export class AttackPipeline {

  /**
   * WHAT is giving this creature its attack bonus? Returns a short label for
   * the chat card ("STORMFORGER"), or null if nothing obvious grants one.
   *
   * Johnny, 2026-07-29, looking at a Fire Bolt card carrying his staff's +2:
   * "it says '+2 BONUS'. It doesn't say for what."
   *
   * The old code guessed from a hand-written list of buff names (Bless,
   * Bardic Inspiration, …). Anything not on the list — every magic item, every
   * piece of homebrew — fell through to a bare "BONUS". So instead of matching
   * names, ASK THE DATA: walk the active effects and find the one whose changes
   * actually write to an attack-bonus field. That names a homebrew ring as
   * readily as it names Bless, and needs no maintenance.
   *
   * Prefers the SOURCE ITEM's name over the effect's, because effects are often
   * named for their mechanic ("Ranged Spell Attack") while the item is what the
   * table recognises ("Staff of the Stormforger").
   */
  static _attackBonusSourceLabel(actor) {
    try {
      if (!actor) return null;
      // Every field dnd5e reads for an attack-roll bonus.
      const ATTACK_BONUS = /^system\.bonuses\.(mwak|rwak|msak|rsak)\.attack$|^system\.bonuses\.All$/i;

      for (const eff of actor.effects ?? []) {
        if (eff.disabled || eff.isSuppressed) continue;
        const hits = (eff.changes ?? []).some(c => ATTACK_BONUS.test(String(c?.key ?? "")));
        if (!hits) continue;

        // The item the effect came from, if we can reach it.
        let sourceName = null;
        try {
          const origin = eff.parent?.documentName === "Item" ? eff.parent : null;
          sourceName = origin?.name ?? null;
          if (!sourceName && eff.origin) {
            const doc = fromUuidSync?.(eff.origin);
            if (doc?.documentName === "Item") sourceName = doc.name;
          }
        } catch (_) { /* effect name will do */ }

        const label = AttackPipeline._shortSourceLabel(sourceName ?? eff.name);
        if (label) return label;
      }
    } catch (_) { /* naming a bonus must never break a card */ }
    return null;
  }

  /**
   * "Staff of the Stormforger" → "STORMFORGER".
   * Magic items are overwhelmingly "<thing> of <the> <Name>", and the tail is
   * the part a table actually says out loud. Chat chips are small, so this has
   * to stay short or it wraps and wrecks the row.
   */
  static _shortSourceLabel(raw) {
    try {
      let s = String(raw ?? "").trim();
      if (!s) return null;
      // Drop a leading item-type phrase: "Staff of the ", "Ring of ", …
      s = s.replace(/^(?:the\s+)?(?:staff|wand|rod|ring|amulet|cloak|robe|gauntlets?|boots|belt|helm|crown|orb|tome|blade|sword|axe|bow|shield|talisman|charm|periapt|circlet|bracers?)\s+of\s+(?:the\s+)?/i, "");
      s = s.replace(/^(?:the)\s+/i, "").trim();
      if (!s) return null;
      // Two words at most, and never long enough to break the chip row.
      const words = s.split(/\s+/).slice(0, 2).join(" ");
      const out = words.toUpperCase();
      return out.length > 14 ? out.slice(0, 14) : out;
    } catch (_) { return null; }
  }

  constructor() {
    /** @type {WeakSet<Roll>} v0.4.22.9 — dedupe Set keyed on Roll object
     *  reference. Replaces the v0.4.22 `_processedAttackKeys` Map which
     *  was keyed on `messageId|activityId|formula`. That key collided
     *  catastrophically: `messageId` is null at the rollAttackV2 hook
     *  stage (chat message hasn't been created yet), and `activityId +
     *  formula` is identical across every attack made with the same
     *  weapon. Every Jeth rapier swing within 10s produced the same
     *  key, so swings 2-N got silently deduped → "swing 1 fires, no
     *  cards on subsequent swings."
     *
     *  Roll-reference dedup is correct: the dual `rollAttackV2 +
     *  rollAttack` hooks fire with the SAME Roll instance, so
     *  `WeakSet.has(roll)` is true on the second fire. Distinct
     *  attacks produce distinct Roll instances, so they pass through.
     *  WeakSet auto-cleans when Roll references go out of scope —
     *  no memory leak, no TTL needed. */
    this._processedAttackRolls = new WeakSet();

    this._registerHooks();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Hook Registration
  // ═══════════════════════════════════════════════════════════════════════════

  _registerHooks() {
    // ── PRE-ROLL: Force advantage/disadvantage based on combat state ──
    // This fires BEFORE the dice roll — we can modify the roll config
    Hooks.on("dnd5e.preRollAttackV2", (config, dialog, message) => {
      return this._onPreAttackRoll(config, dialog, message);
    });

    // ── POST-ROLL: Assess results, post card ──
    //
    // v0.4.22.9: Dedupe via the Roll OBJECT REFERENCE, not a string key.
    // Both `rollAttackV2` and `rollAttack` hooks fire with the same Roll
    // instance for a given attack — WeakSet identity check catches the
    // duplicate. Distinct attacks have distinct Roll instances and pass
    // through. WeakSet auto-cleans when refs are GC'd; no TTL needed.
    //
    // Previous (v0.4.22) implementation used a string key
    // `messageId|activityId|formula`, which collided across every attack
    // made with the same weapon: `messageId` was null at this hook stage,
    // and `activityId + formula` are identical for repeat swings. Net
    // effect: only the first swing per ~10 seconds posted a card.
    const dedupedAttackHandler = (rolls, data) => {
      try {
        const rollRef = rolls?.[0];
        if (rollRef && typeof rollRef === "object") {
          if (this._processedAttackRolls.has(rollRef)) {
            // Silent dedupe — log only in debug
            try {
              if (game.settings.get(MODULE_ID, "debugMode")) {
                console.log(`${MODULE_ID} | rollAttack dedupe: dual-hook duplicate for Roll ${rollRef?.formula ?? "?"}`);
              }
            } catch (_) { /* setting not ready */ }
            return;
          }
          this._processedAttackRolls.add(rollRef);
        }
        // If rollRef is missing or non-object (shouldn't happen but safe),
        // we skip dedup — better to risk a duplicate card than to block
        // a legitimate attack.

        return this._onAttackRoll(rolls, data);
      } catch (err) {
        console.warn(`${MODULE_ID} | dedupedAttackHandler failed:`, err);
        return this._onAttackRoll(rolls, data);
      }
    };

    Hooks.on("dnd5e.rollAttackV2", dedupedAttackHandler);
    Hooks.on("dnd5e.rollAttack",   dedupedAttackHandler);

    // ── DIALOG RENDER: Swap the d20 icon with our BD20 dice image ──
    Hooks.on("renderApplication", (app, html) => this._onRenderRollDialog(app, html));
    Hooks.on("renderApplicationV2", (app, html) => this._onRenderRollDialog(app, html));

    console.debug(`${MODULE_ID} | Attack pipeline hooks registered (pre-roll + post-roll + dialog render)`);
  }

  /**
   * When the D&D 5e attack roll dialog renders, swap the d20 icon
   * with our BD20 dice PNG.
   */
  _onRenderRollDialog(app, html) {
    // ── v0.4.22 hardened ──
    // Tighter dialog-class detection (RollConfigurationDialog only) and
    // narrower image selector that requires the d20 alt/src match BEFORE
    // querying the DOM. Previous selector `ul.dice img, .dice img` could
    // pick up unrelated dice elements if Foundry/dnd5e refactor the dialog
    // structure. Now we scope to the recognized dnd5e dialog tree first
    // and short-circuit aggressively. Wrapped in try/catch so a CSS shift
    // can't break the entire render hook chain.
    try {
      const isRollDialog = app?.constructor?.name?.includes("RollConfigurationDialog")
        || app?.options?.classes?.includes?.("roll-configuration");
      if (!isRollDialog) return;

      const el = html instanceof HTMLElement ? html : html?.[0] ?? html;
      if (!el?.querySelectorAll) return;

      // Scope the search to the dialog's actual dice container — fall back
      // to the broader selector only if the scoped one finds nothing
      let diceImgs = el.querySelectorAll(".roll-configuration ul.dice img");
      if (!diceImgs.length) {
        diceImgs = el.querySelectorAll("ul.dice img");
      }

      for (const img of diceImgs) {
        // Only replace d20 icons (alt text or src containing "d20")
        const altLc = (img.alt ?? "").toLowerCase();
        const srcLc = (img.src ?? "").toLowerCase();
        const isD20 = altLc.includes("d20") || srcLc.includes("d20");
        if (!isD20) continue;

        // Skip if we already swapped (idempotent re-render guard)
        if (img.dataset.aceQolSwapped === "1") continue;

        img.src = `modules/ace-qol/Assets/Dice%20Dice/BD20/BD20-20_nobg.png`;
        img.style.filter = "drop-shadow(0 2px 4px rgba(0,0,0,0.5))";
        img.dataset.aceQolSwapped = "1";
      }
    } catch (err) {
      console.warn(`${MODULE_ID} | _onRenderRollDialog dice-icon swap failed (non-fatal):`, err?.message ?? err);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  PRE-ROLL: Force advantage/disadvantage based on combat state
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Called BEFORE the attack roll dice are thrown.
   * Assesses attacker + all targets, determines advantage/disadvantage,
   * and injects it into the roll configuration.
   *
   * dnd5e.preRollAttackV2 passes: (config, dialogConfig, messageConfig)
   * config.rolls[0] contains the roll config we can modify.
   */
  _onPreAttackRoll(config, dialog, message) {
    // Runs on ALL clients (GM + players) — handles advantage/disadvantage detection,
    // range checks, and incapacitation blocks. The pre-roll dialog is client-local.
    // The GM has switched ACE's hit checking off. That is them turning ACE OFF,
    // not ACE failing — dnd5e's own behaviour, dialog included, is correct here.
    if (!QolSettings.get("autoCheckHit")) {
      gateOff("automatic hit checking", "autoCheckHit");
      return;
    }

    // ⚠️ A NEW ATTACK IS A NEW READING OF EVERYONE. Nothing cached from the
    // previous swing may be reused, no matter how recently it was built.
    _aceNewProfileGen();

    // ── ⚠️🔴 SUPPRESS FIRST. EVERY EARLY RETURN BELOW USED TO LEAK. ─────
    //
    // dnd5e's Attack Roll window opens BY DEFAULT. Staying hidden is not a
    // setting we flip once — ACE has to flip this switch on every single swing,
    // and it used to do so near the END of this function, as a consequence of
    // having successfully handled the attack.
    //
    // So every check that bailed out early skipped it: no target, no item, no
    // actor, no activity. Johnny hit the no-target one and dnd5e's dialog
    // appeared, which his standing rule (2026-07-26) calls a defect outright:
    // "I want all attacks, spell attacks, weapon attacks, future attacks to go
    // through our pipeline, not DD5E."
    //
    // Making it a PRECONDITION instead of a consequence closes every one of
    // those paths at once — including paths nobody has written yet, which is the
    // whole point. Anything below this line may return freely.
    //
    // ⚠️ AND IT NO LONGER LIVES HERE AT ALL (2026-08-25). Hoisting it to the
    // top of this function closed every early return in THIS file, and did
    // nothing for the other two places that were also suppressing dialogs their
    // own way — one of which was a prototype patch driven by a five-second
    // timer, and that is what stopped Magic Missile working.
    //
    // dnd5e fires ONE hook for every roll it makes (`dnd5e.preRoll`, the
    // empty-suffix one, which is always appended to `config.hookNames`), so
    // there is exactly one place this decision can be made and it is
    // `dialog-suppression.mjs`. Do not re-add it here: three sites with a hole
    // between them is what we just finished removing.

    const subject = config?.subject;
    if (!subject) return;

    const item = subject.item;
    const actor = subject.actor;
    if (!item || !actor) return;

    // ── Block attacks from incapacitated attackers ──
    //
    // v0.4.22: alongside the center toast (auto-dismissing), also post a
    // `ui.notifications.warn` so the block reason persists in the Foundry
    // notification stack. Center toasts can be missed if the player isn't
    // looking at the screen center; the notification stays visible until
    // the user dismisses or another notification replaces it.
    // Hard gate — can the attacker even act? Shared brain (CombatContext.canAct),
    // identical to the spell path, so weapons and spells can never drift apart
    // again (the gap that let an incapacitated caster still cast). (2026-06-25)
    // ══ THE GATE — READ THE ATTACKER BEFORE THE DICE, NOT AFTER ═══════════
    //
    // ⚠️🔴 THIS IS THE HOOK THAT CAN STILL SAY NO. `_onAttackRoll` runs
    // after dnd5e has already rolled, so a refusal there leaves a bare d20 on
    // screen with nothing resolved. Everything the Gate decides belongs HERE.
    //
    // The profile carries the liveness gate, every condition, the edition, the
    // action's reach and properties, the action economy and any aura this
    // creature projects. It is read ONCE and handed down, so the range check,
    // the melee test and the console line can never disagree about the same
    // creature — which is the entire point of a gate.
    const attacker = _aceAttackerProfile(actor, item, subject ?? null);

    // The shared action gate lives inside the profile now; this reads the
    // answer rather than asking the same question a second time.
    if (attacker && !attacker.canAct) {
      const reason = attacker.cannotActBecause || attacker.gate?.reason
        || `${attacker.name} cannot act.`;
      console.warn(`${MODULE_ID} | Gate/attacker | BLOCKED: ${reason}`);
      showCenterToast(reason, 2500);
      ui.notifications?.warn(`ACE QOL: ${reason}`);
      _announceAttackCancelled(item, actor, reason);
      return false; // Block the roll
    }

    // ⚠️ SAY WHAT WAS READ, EVERY TIME. Johnny's definition of done: you name
    // a thing on the sheet, and I show you the console line where the pipeline
    // read it. Without this, "did it check the aura?" is answered by me reading
    // code and guessing, which is what the whole of 24 August was.
    // ⚠️ TWO LINES, ONE PER SUBJECT. The creature says what it is; the
    // button says what it is. Spliced together they produced
    // "Lich (Legacy): concentrating · reach 120 ft", which reads as though the
    // Lich has a 120-foot reach.
    const attack = _aceAttackProfile(item, subject);
    if (attacker) {
      console.log(`${MODULE_ID} | Gate/attacker | ${describeAttacker(attacker)}`);
      if (attack) console.log(`${MODULE_ID} | Gate/attack   | ${describeAttack(attack)}`);
      if (attack?.problems.length) {
        console.warn(`${MODULE_ID} | Gate/attack | could not read everything about `
          + `"${attack.name}": ${attack.problems.join("; ")}.`);
      }
      if (attacker.problems.length) {
        console.warn(`${MODULE_ID} | Gate/attacker | could not read everything about `
          + `${attacker.name}: ${attacker.problems.join("; ")}. `
          + `Anything below that depends on those fields is running blind.`);
      }
    }

    // ── ⚠️🔴 HANDS OFF A ROLL THAT IS ABOUT TO BE CANCELLED ────────────
    //
    // The spell pipeline rolls every beam of a multi-beam spell itself and then
    // cancels dnd5e's own attack roll. That cancelled roll still arrives HERE
    // first, with the targets already released — so this pipeline saw an attack
    // with nobody targeted and helpfully opened its "who are you hitting?"
    // picker for a roll that no longer existed.
    //
    // Johnny cast Eldritch Blast on 2026-08-25 and got the picker TWICE: the
    // spell pipeline's, which worked and dealt the damage, then a second one
    // that did nothing when he pressed it. "It does nothing." It could not do
    // anything — the roll behind it was already dead.
    //
    // ⚠️ ONE OWNER TEST, ASKED OF THE PIPELINE THAT OWNS IT. Copying the
    // condition here is how the two would drift the first time a new shape is
    // added over there.
    //
    // ⚠️🔴 SYNCHRONOUS, AND IT HAS TO BE. This handler cancels rolls by
    // returning false, and a hook that returns a Promise cannot cancel anything
    // — making this function async to allow a dynamic import would have quietly
    // disabled EVERY block in this file, including the incapacitated-attacker
    // gate. The import is static (checked: nothing under spell-pipeline/ imports
    // back into this file, so there is no cycle).
    // The Gate above has already read and reported this attacker, which is
    // what Johnny asked for on every button press. What gets skipped from
    // here down is the RESOLUTION half: targeting, the picker, hit checking
    // - all of which the spell pipeline is doing itself.
    try {
      if (SpellPipeline?.ownsAttackRoll?.(item)) {
        console.log(`${MODULE_ID} | "${item.name}" is owned by the spell pipeline — `
          + `the attack pipeline read it and stands down (no picker, no second prompt).`);
        return;
      }
    } catch (err) {
      // Absent and broken must not look the same. If the check itself failed we
      // carry on, because refusing every attack is far worse than one duplicate
      // prompt — but the reason is named rather than swallowed.
      console.warn(`${MODULE_ID} | could not ask the spell pipeline about `
        + `"${item.name}" — continuing as an ordinary attack:`, err);
    }

    // ── ⚠️ NO TARGET? ASK WHO, DON'T WALK AWAY. ───────────────────
    //
    // This used to return, which meant ACE had no idea who was being hit and
    // the roll went ahead with no pause at all. Johnny, 2026-08-23: "why don't
    // we put up the portrait picker? ... goblins can look exactly the same with
    // just small differences, and the player could still not be sure which one
    // he wants to attack. It delays the game."
    //
    // Refusing the attack was the other option and it is worse — it punishes a
    // click already made. The picker turns a dead end into the thing they
    // wanted, and it is the SAME picker spells already use, with distance and a
    // compass point on every row and the real token lighting up on hover.
    //
    // ⚠️ It cancels this roll and re-fires from the picker's own path, because
    // targeting has to be settled BEFORE advantage, range and cover are read —
    // all of which are computed below from the target.
    const targets = game.user.targets;
    if (!targets.size) {
      this._pickTargetThenRefire(config, message, actor, item, subject);
      return false;
    }

    // ── Melee multi-target lockout ──
    // A melee weapon swings at one creature unless the actor has a cleave-style
    // feature (Cleave, Great Weapon Master, Whirlwind Attack, etc.). If the GM
    // or player has multiple tokens targeted by accident, block the attack and
    // tell them to retarget. Skips when the actor genuinely has multi-target
    // melee features so Whirlwind/Cleave still work as designed.
    if (targets.size > 1 && AttackPipeline._isMeleeAttack(item, subject)
        && !AttackPipeline._actorHasMultiTargetMelee(actor, item)) {
      const msg = `Melee attack — only one target allowed (${targets.size} targeted; retarget single creature)`;
      showCenterToast(msg, 2500);
      ui.notifications?.warn(`ACE QOL: ${msg}`);
      this._debug(`Blocked: ${actor.name} melee attack with ${targets.size} targets, no cleave/whirlwind feature`);
      _announceAttackCancelled(item, actor, msg);
      return false; // Block the roll
    }

    // ── Range check: block attacks on out-of-range targets ──
    // SKIPPED for opportunity attacks. RAW, an OA "occurs right before the
    // creature leaves your reach" (PHB 195) — but by the time the OA is
    // clicked, the token has finished moving and sits out of reach, so this
    // check would wrongly cancel a legitimate swing. The OA was already
    // validated as in-reach at trigger time (that's what fired it), so we
    // trust that and don't re-measure. OA_IN_FLIGHT is set by
    // OAPrompt.fireOAAttack around item.use() on this same client. v0.7.23.
    // NB: firstTarget is declared at function scope (it's reused below for the
    // combat-state assessment) — only the range *check* is OA-gated. v0.7.24.
    const firstTarget = targets.first();
    if (!OA_IN_FLIGHT.has(actor.id)) {
      const rangeCheck = this._checkRange(actor, firstTarget, item, subject, attacker);
      if (rangeCheck.blocked) {
        const msg = `Out of range — ${rangeCheck.distanceFt}ft away (${rangeCheck.rangeDesc})`;
        showCenterToast(msg, 2500);
        ui.notifications?.warn(`ACE QOL: ${msg}`);
        _announceAttackCancelled(item, actor, msg);
        return false; // Block the roll
      }
    }

    // Assess combat state for the first target (primary target)
    // If multiple targets, use the first — advantage is per-attack, not per-target
    const combatState = CombatState.assess(actor, firstTarget, item);
    if (!combatState) {
      // Even without an assessment, dnd5e's config dialog must not render —
      // ACE owns the attack pause (Johnny 2026-07-26). Roll straight.
      // (Suppression is handled once, in dialog-suppression.mjs.)
      return;
    }

    // Store the combat state for the post-roll handler
    this._lastCombatState = combatState;
    this._lastCombatStates = CombatState.assessAll(actor, item);

    // ── ALL attacks pause on ACE's OWN prompt — dnd5e's dialog NEVER shows ──
    // (Johnny 2026-07-26: "all attacks, spell attacks, weapon attacks, future
    // attacks go through our pipeline, not DD5E.")
    // If this roll is about to open dnd5e's config dialog (dialog.configure is
    // not already false — i.e. nothing upstream fast-forwarded it: not the
    // weapon Item.use prompt path, not OA auto-fire, not a multiattack chain
    // swing, not our own re-fire), cancel it, show the ACE advantage prompt,
    // and re-fire fast-forwarded with the choice. This is the ONE choke point
    // every attack passes through, so it also catches paths that bypass the
    // Item.use patch (the BG3 HUD's cached reference — spell attacks' whole
    // problem, and stray weapon paths too).
    const userChoicePending = pendingAttackChoices.has(actor.id);
    if (!userChoicePending && dialog?.configure !== false
        && !OA_IN_FLIGHT.has(actor.id)
        && QolSettings.get("advantagePrompt") !== false) {
      this._promptThenRefire(config, message, actor, firstTarget, item, subject);
      return false; // cancel this roll — the re-fire carries the GM/player's choice
    }
    // ACE owns the pause — with a stored choice (or prompt disabled) the roll
    // proceeds now, and dnd5e's box stays suppressed either way.
    // (Suppression is handled once, in dialog-suppression.mjs.)

    // ── Inject advantage/disadvantage into the roll dialog + config ──
    // Set the dialog's default button so the correct mode is pre-selected
    // AND set it on the roll config for fast-forward rolls (no dialog)
    dialog.options = dialog.options ?? {};

    const rollConfig = config.rolls?.[0];

    // ── User prompt choice (from attack-prompt.mjs) overrides auto-detection ──
    const userChoice = pendingAttackChoices.get(actor.id);
    if (userChoice) {
      pendingAttackChoices.delete(actor.id);
      if (userChoice === "advantage") {
        dialog.options.defaultButton = "advantage";
        if (rollConfig?.options) rollConfig.options.advantage = true;
        config.advantage = true;
      } else if (userChoice === "disadvantage") {
        dialog.options.defaultButton = "disadvantage";
        if (rollConfig?.options) rollConfig.options.disadvantage = true;
        config.disadvantage = true;
      }
      // "normal" → leave config alone; dnd5e applyKeybindings sets NORMAL.
      this._debug(`PRE-ROLL: Using user prompt choice: ${userChoice}`);
      return;
    }

    if (combatState.finalRollMode === "advantage") {
      dialog.options.defaultButton = "advantage";
      // dnd5e applyKeybindings reads roll.options.advantage / config.advantage (booleans),
      // NOT advantageMode — it overwrites advantageMode based on those three sources.
      if (rollConfig?.options) rollConfig.options.advantage = true;
      config.advantage = true;

      this._debug(`PRE-ROLL: Setting ADVANTAGE for ${item.name} → ${firstTarget.actor?.name}`);
      for (const src of combatState.advantageSources) {
        this._debug(`  → ${src.reason}`);
      }
    } else if (combatState.finalRollMode === "disadvantage") {
      dialog.options.defaultButton = "disadvantage";
      if (rollConfig?.options) rollConfig.options.disadvantage = true;
      config.disadvantage = true;

      this._debug(`PRE-ROLL: Setting DISADVANTAGE for ${item.name} → ${firstTarget.actor?.name}`);
      for (const src of combatState.disadvantageSources) {
        this._debug(`  → ${src.reason}`);
      }
    }

    // Don't return false — let the roll continue
  }

  /**
   * How far this weapon can reach, in FEET.
   *
   * ⚠️ EXTRACTED 2026-08-23 so the range check and the target picker share
   * one answer. The picker uses it to decide who is close enough to be
   * offered at all; the range check uses it to decide whether a swing lands.
   * Those two must never disagree — a creature offered as a target and then
   * refused as out of range is a worse experience than either alone.
   */
  static _reachFor(item, subject) {
    // ⚠️ THE RESOLVER LIVES IN `reach-reader.mjs` NOW, so the attacker profile
    // and this pipeline can never disagree about how far a Spiked Chain reaches.
    // Everything it used to do lives there unchanged, with the reason for every
    // step. This path DOES ask for the repair: it is the one place we know a
    // real swing happened, and a profile is built more than once per attack.
    return resolveReach(item, subject, { repair: true }).reachFt;
  }

  /**
   * The cancelled roll's second act: show the ACE advantage prompt (shared with
   * the weapon path), stash the choice, then re-fire the SAME attack fast-
   * forwarded — the re-entry consumes the stored choice and dnd5e's dialog
   * stays suppressed. Esc on the prompt leaves the attack cancelled, exactly
   * like the weapon path. (2026-07-26 — ACE owns every attack pause.)
   */
  /**
   * Nobody is targeted — ask who, then run the attack again for real.
   *
   * ⚠️ IT SETS THE REAL TARGET, not a private note. Everything downstream —
   * advantage, cover, range, the damage card, the engagement gate — reads
   * `game.user.targets`. Stashing the choice somewhere of our own would mean
   * every one of those had to learn about it, and the ones that did not would
   * quietly disagree with the ones that did.
   *
   * ⚠️ THE RE-FIRE IS AN ORDINARY ATTACK. It goes back through this same hook
   * with a target set, so range, reach, advantage and ACE's own prompt all run
   * normally. No second code path to drift.
   */
  async _pickTargetThenRefire(config, message, actor, item, subject) {
    try {
      const { SpellTargetPicker } = await import("./spell-target-picker.mjs");

      // Reach decides who is even offered, so a reach weapon shows the
      // creatures it can genuinely hit rather than everything on the map.
      const reachFt = AttackPipeline._reachFor(item, subject);

      const token = await SpellTargetPicker.pickAttackTarget({
        weaponItem: item,
        attackerActor: actor,
        reachFt,
      });
      if (!token) {
        // ⚠️🔴 THIS IS A GIVE-UP PATH AND IT WAS NOT ANNOUNCING ITSELF.
        //
        // `token` is the target the GM picked, so no token means they closed
        // the picker. The sibling below (`_promptThenRefire`, Escape on the
        // advantage prompt) calls _announceAttackCancelled for exactly this
        // reason; this one never did. Forge holds a weapon's FX until
        // `attackCommitted`, keyed by item, so a dismissed picker left a hold
        // that nothing ever released — and that weapon stayed silent for the
        // rest of the session.
        //
        // The comment on _announceAttackCancelled says "EVERY GIVE-UP PATH
        // CALLS THIS". I wrote that sentence tonight and then missed this
        // path in the same change. Found by reading my own diff.
        //
        // ⚠️ AND THE MESSAGE HERE WAS WRONG. It said "the attacker has no
        // token on this scene", which describes a different failure entirely
        // and would send the next person hunting the attacker instead of the
        // picker. Closing a dialog is a CHOICE, not a fault, so it is a debug
        // line and not a warning.
        _announceAttackCancelled(item, actor, "the target picker was closed without picking");
        this._debug(`target picker closed for "${item.name}" — no attack, FX hold released`);
        return;   // cancelled — the attack stays cancelled
      }

      token.setTarget(true, { user: game.user, releaseOthers: true });

      const refire = {};
      for (const k of ["ammunition", "attackMode", "mastery"]) {
        if (config?.[k] !== undefined) refire[k] = config[k];
      }
      await subject.rollAttack(refire, { configure: false }, {});
    } catch (err) {
      console.warn(`${MODULE_ID} | ACE target picker/re-fire failed — attack cancelled:`, err);
    }
  }

  async _promptThenRefire(config, message, actor, targetToken, item, subject) {
    try {
      const choice = await promptAttackChoice(actor, targetToken, item);
      if (!choice) {
        // Esc — the attack stays cancelled, and anything holding an animation
        // for it has to be told, or that weapon never animates again.
        _announceAttackCancelled(item, actor, "the advantage prompt was dismissed");
        return;
      }
      pendingAttackChoices.set(actor.id, choice);
      // Carry over the parts of the original roll that were already decided
      // (ammo, attack mode, weapon mastery) so the re-fire is the same attack.
      const refire = {};
      for (const k of ["ammunition", "attackMode", "mastery"]) {
        if (config?.[k] !== undefined) refire[k] = config[k];
      }
      refire.event = { shiftKey: true, target: document.body };   // fast-forward
      await subject.rollAttack(refire, { configure: false }, {});
    } catch (err) {
      console.warn(`${MODULE_ID} | ACE attack prompt/re-fire failed — attack cancelled:`, err);
      try { pendingAttackChoices.delete(actor.id); } catch (_) {}
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  POST-ROLL: Attack Roll Handler
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Called when a D&D 5e attack roll completes.
   * Assesses all targets and determines hit/miss/crit.
   */
  async _onAttackRoll(rolls, data) {
    // SILENT-OK: GM-only handler; every client sees this hook
    if (!game.user.isGM) return;

    const subject = data?.subject;
    if (!subject) return;

    const item = subject.item;
    const actor = subject.actor;
    if (!item || !actor) return;

    // Check if auto-check hit is enabled
    if (!QolSettings.get("autoCheckHit")) {
      // ⚠️ RELEASE THE HOLD. Forge holds a weapon's FX from the moment the
      // item is used until ACE says the attack is committed. With hit checking
      // off, ACE never commits anything - so without this the hold is never
      // released and that weapon never animates again, for the whole session,
      // in a configuration that is otherwise perfectly valid.
      gateOff("automatic hit checking", "autoCheckHit");
      _announceAttackCancelled(item, actor, "ACE is not checking hits, so it resolves nothing");
      return;
    }

    const roll = rolls?.[0];
    if (!roll) {
      _announceAttackCancelled(item, actor, "the roll carried no dice");
      return;
    }

    // ══ THE GATE — READ THE ATTACKER BEFORE ANYTHING IS DECIDED ═══════
    //
    // ⚠️🔴 THIS PROFILE HAS BEEN BUILT ON EVERY ATTACK SINCE 2026-07-28 AND
    // ASKED FOR THREE NUMBERS. It carried the liveness gate, every condition,
    // the edition and the action gate, and this pipeline read proficiency and
    // two ability modifiers off it and threw the rest away. Johnny, 2026-08-25:
    // "When I push a button, a whole block of code should read the attacker's
    // profile, everything about them, and all the conditions... before anything
    // happens." It now does, and it says out loud what it read.
    //
    // ⚠️ BUILT IS NOT CONSULTED. That gap is what killed Uncanny Dodge and
    // Aura of Warding, both written correctly and read by nothing.
    // `tools/profile-consumers-check.py` goes red when a field the profile
    // reports has no reader anywhere in the suite.
    const attackerToken = subject?.token?.object
      ?? actor.getActiveTokens?.(false, false)?.[0]
      ?? null;
    const attacker = _aceAttackerProfile(actor, item, subject, attackerToken);

    // ⚠️🔴 THE LIVENESS GATE, WHICH EXISTED AND WAS NEVER ASKED HERE.
    // `_onPreAttackRoll` already blocks an incapacitated attacker before the
    // dice, which is the right place and stays the primary defence. This is the
    // backstop for everything that reaches the roll by another road — a macro,
    // a re-fire, a socket, an activity used straight off the sheet. The roll has
    // already happened by the time we are here, so it resolves nothing and says
    // why, rather than leaving a bare d20 on screen with no explanation.
    if (attacker && !attacker.canAct) {
      console.warn(`${MODULE_ID} | Gate/attacker | ${attacker.name} cannot act `
        + `(${attacker.cannotActBecause}) — nothing resolved from this roll.`);
      ui.notifications?.warn(`${attacker.name} cannot act: ${attacker.cannotActBecause}.`);
      // ⚠️ A REFUSED ATTACK IS STILL AN ABANDONED ATTACK. The Gate stopping
      // the swing is exactly the case Forge is waiting on - tell it, or the
      // weapon of anyone who was ever stunned mid-swing goes quiet for good.
      _announceAttackCancelled(item, actor, `${attacker.name} cannot act: ${attacker.cannotActBecause}`);
      return;
    }

    // ⚠️ SAY WHAT WAS READ, EVERY TIME. Johnny's definition of done: you name
    // a thing on the sheet, and I show you the console line where the pipeline
    // read it. Without this, "did it check the aura?" is answered by me reading
    // code and guessing, which is what the whole of 24 August was.
    // ⚠️ THE BACKSTOP DOES NOT NARRATE. The pre-roll gate has already
    // printed this creature's line for this swing; printing it again here put
    // the same sentence in the console twice for every attack, which is how a
    // log stops being read. It speaks only when it has something the pre-roll
    // line did not say.
    if (attacker?.problems.length) {
      console.warn(`${MODULE_ID} | Gate/attacker | could not read everything about `
        + `${attacker.name}: ${attacker.problems.join("; ")}. `
        + `Anything below that depends on those fields is running blind.`);
    }

    // ── ⚠️🔴 THE ATTACK IS COMMITTED. NOTHING CAN INTERRUPT IT NOW. ────
    //
    // Johnny, 2026-08-26: "I don't want the animation to play until the second
    // button has been pushed — the portrait picker closes, the
    // advantage/disadvantage button closes, the consume spell slot closes.
    // THEN I want the animation to run."
    //
    // He also asked which actions have no second button. The answer is that
    // enumerating them would be the wrong design: the list would be wrong the
    // day somebody adds a prompt, and an animation that waits for a button that
    // never comes never plays at all. So instead of a list, there is ONE signal,
    // fired from the one place every attack reaches with every pause behind it —
    // the roll itself. An attack with no prompt simply reaches it sooner.
    //
    // For the record, these reach it with NO second button, and they are
    // documentation rather than logic:
    //   • opportunity attacks (auto-fired the instant they trigger)
    //   • multiattack chain swings (the chain dialog already asked)
    //   • the re-fire after an advantage prompt (the choice is already made)
    //   • any table with the advantage prompt switched off
    //   • at-will cantrips on an already-selected target (no slot, no picker)
    //   • self-targeted spells (nothing to pick)
    //
    // ⚠️ EMITTED BEFORE THE TARGET CHECK, DELIBERATELY. A swing at nobody is
    // still a swing that happened, and its sound should still play.
    try {
      Hooks.callAll(`${MODULE_ID}.attackCommitted`, {
        item, actor, subject,
        targets: [...(game.user.targets ?? [])],
      });
    } catch (err) {
      console.warn(`${MODULE_ID} | attackCommitted listeners threw (non-fatal):`, err);
    }

    // Get targeted tokens
    const targets = game.user.targets;
    if (!targets.size) {
      this._debug("No targets selected — skipping attack resolution");
      return;
    }

    let attackTotal = roll.total;
    const d20Result = roll.dice?.[0]?.total ?? roll.result;
    const isCritRoll = d20Result === 20;
    const isFumbleRoll = d20Result === 1;

    // Determine attack type — use the activity's getter (handles thrown, spell, etc.)
    const actionType = subject.actionType ?? item.system?.actionType ?? "mwak";
    const isMelee = ["mwak", "msak"].includes(actionType);
    const isSpell = item.type === "spell" || ["msak", "rsak"].includes(actionType);

    // ── Optional Bonus Prompts (Bardic Inspiration, Lucky, etc.) ──
    // Check if the actor has any optional bonuses available for this attack roll.
    // Routing follows the roller (v0.7.22): this handler is GM-gated and the
    // dnd5e roll hook fires on the rolling client, so game.user.id IS the
    // roller. Passing it lets the prompt appear on the roller's screen when
    // "riderPromptsFollowRoller" is ON (default), instead of always jumping
    // to the actor's owning player.
    try {
      const optionalResult = await FlagsEngine.routeOptionalPrompt(
        actor, "attack", actionType, attackTotal, d20Result, game.user.id
      );
      if (optionalResult.bonuses.length > 0) {
        attackTotal = optionalResult.newTotal;
        this._debug(`Optional bonuses applied: ${optionalResult.bonuses.map(b => `${b.label} +${b.total}`).join(", ")} → new total ${attackTotal}`);
      }
    } catch (err) {
      console.warn(`${MODULE_ID} | Optional prompt failed (non-blocking):`, err);
    }

    // ── Precision Attack pre-resolution intercept (v0.7.14 F12) ──
    // Battle Master Fighter maneuver: declared AFTER the d20 lands but BEFORE
    // hit/miss is determined. Player sees their attack roll and decides whether
    // to spend a superiority die to push a marginal miss into a hit. Both 2014
    // and 2024 use this mid-roll timing — this is the load-bearing case for
    // having a pre-resolution intercept tier at all.
    try {
      const precisionBonus = await RiderEngine.promptPrecisionAttack(actor, attackTotal, d20Result);
      if (precisionBonus > 0) {
        attackTotal += precisionBonus;
        this._debug(`Precision Attack added: +${precisionBonus} → new total ${attackTotal}`);
      }
    } catch (err) {
      console.warn(`${MODULE_ID} | Precision Attack prompt failed (non-blocking):`, err);
    }

    // ── Use pre-roll combat states if available, otherwise assess now ──
    const combatStates = this._lastCombatStates?.length
      ? this._lastCombatStates
      : CombatState.assessAll(actor, item);

    // ── ⚠️🔴 SAY HOW MANY TARGETS THIS SWING IS ABOUT TO RESOLVE ──────
    //
    // Johnny swung a rapier at a targeted Arcanaloth and NO CHAT CARD APPEARED.
    // Chasing it took four dead theories, because every layer was silent: the
    // roll happened, the Gate printed, the card builder was reached and
    // returned instantly on an EMPTY results array, and nothing anywhere said
    // "I had nothing to resolve".
    //
    // ⚠️ AN EMPTY RESOLUTION IS A FINDING, NOT A NO-OP. A swing that lands on
    // nobody is either a bug or a fact the GM needs; either way it must never
    // be silent. This names where the states came from, because "the pre-roll
    // stored none" and "assessing them now found none" are different faults.
    const _statesFrom = this._lastCombatStates?.length ? "the pre-roll assessment" : "a fresh assessment";
    if (!combatStates.length) {
      console.warn(`${MODULE_ID} | ${actor.name}'s "${item.name}": `
        + `${_statesFrom} produced NO combat states, so there is nothing to resolve `
        + `and no card will post. Targets right now: `
        + `${[...(game.user.targets ?? [])].map(t => t.name).join(", ") || "(none)"}. `
        + `This is a bug — a targeted swing must always resolve to something.`);
    } else {
      this._debug(`${combatStates.length} combat state(s) from ${_statesFrom}`);
    }

    // ── Calculate cover for each target and build results ──
    const atkToken = CoverEngine.getAttackerToken(actor);
    const results = [];
    for (const cs of combatStates) {
      // ── Cover calculation: add AC bonus from cover ──
      let coverResult = null;
      let effectiveAC = cs.target.ac;
      try {
        if (QolSettings.get("enableCoverCalculation") && atkToken && cs.targetToken) {
          coverResult = CoverEngine.calculateCover(atkToken, cs.targetToken);
          if (coverResult.isFullCover) {
            this._debug(`COVER: ${cs.target.name} has FULL COVER — untargetable`);
          } else if (coverResult.acBonus > 0) {
            effectiveAC += coverResult.acBonus;
            this._debug(`COVER: ${cs.target.name} has ${coverResult.label} — AC ${cs.target.ac} → ${effectiveAC}`);
          }
          // Show visual indicator on target
          CoverEngine.showCoverIndicator(cs.targetToken, coverResult);
        }
      } catch (err) {
        console.warn(`${MODULE_ID} | Cover calculation failed (non-blocking):`, err);
      }

      // ── ⚠️🔴 THE SPACE BETWEEN THEM ───────────────────────────────────
      //
      // The environment profile answers the third question of THE ONE GATE:
      // not who is swinging and not who is being hit, but what is in between.
      // It was written on 2026-08-25 and, until now, imported by NOTHING —
      // 358 lines of correct code that no pipeline ever asked. That is the
      // exact failure the "a layer isn't done until its consumers are wired"
      // rule exists to prevent, and I wrote the rule down the same night.
      //
      // ⚠️ IT IS BUILT PER TARGET, NOT PER ATTACK. Distance, cover, light and
      // elevation are all properties of a PAIR. One profile per swing would
      // be right for the first target and wrong for every other one.
      //
      // ⚠️ COVER IS NOT APPLIED FROM HERE. CoverEngine above is the single
      // authority and has already adjusted effectiveAC; taking the profile's
      // coverAcBonus as well would silently double it. The profile reads the
      // same engine, so the two must agree — and if they ever stop agreeing,
      // that is a real defect and the cross-check below says so rather than
      // letting one of them quietly win.
      let env = null;
      try {
        env = buildEnvironmentProfile(atkToken, cs.targetToken);

        if (coverResult && env.coverAcBonus !== coverResult.acBonus) {
          console.warn(`${MODULE_ID} | the two cover readings disagree for `
            + `${cs.target.name}: CoverEngine says +${coverResult.acBonus} `
            + `(${coverResult.label}), the environment profile says `
            + `+${env.coverAcBonus} (${env.coverLevel}). CoverEngine's number `
            + `was used. One of the two paths has drifted.`);
        }

        // ── Is the target actually within reach or range? ────────────────
        //
        // ⚠️ NOTHING IN ACE CHECKED THIS. Chudd cast Frostbite at a creature
        // 60 ft away horizontally and 30 ft below him on 2026-08-26 and no
        // part of the suite objected. Distance was measured everywhere and
        // compared to the attack's own limit nowhere.
        //
        // ⚠️ IT REPORTS, IT DOES NOT REFUSE. A GM has every right to let a
        // shot go that the rules would not, and a pipeline that silently
        // blocks the swing would be worse than one that silently allows it.
        // The number and the limit go on the record; the call stays his.
        const _envAtk = _aceAttackProfile(item, subject);
        const _isRanged = _envAtk?.attackKind === "rwak" || _envAtk?.attackKind === "rsak"
          || (_envAtk?.rangeLong > 0);
        const _limit = _isRanged
          ? (_envAtk?.rangeLong || _envAtk?.rangeNormal || 0)
          : (_envAtk?.reachFt || 0);
        if (_limit > 0 && Number.isFinite(env.distanceFt)) {
          env.withinLimitFt = _limit;
          env.withinLimit = env.distanceFt <= _limit;
          if (!env.withinLimit) {
            console.warn(`${MODULE_ID} | ${cs.target.name} is ${env.distanceFt} `
              + `${env.gridUnits} away but ${item.name} reaches ${_limit} `
              + `${env.gridUnits}`
              + (env.elevationDeltaFt
                  ? ` (including ${Math.abs(env.elevationDeltaFt)} ${env.gridUnits} of elevation)`
                  : "")
              + `. The swing was allowed — this is a note, not a block.`);
          }
        }

        // Obscurement and blocked sight are the other two things that change
        // a roll and were never surfaced anywhere.
        if (env.heavilyObscuredAtTarget || env.sightBlocked === true) {
          this._debug(`ENVIRONMENT: ${cs.target.name} is `
            + `${env.sightBlocked === true ? "out of line of sight" : "heavily obscured"} `
            + `(light at target: ${env.lightAtTarget}, ${env.lightAtTargetBasis})`);
        }
        if (env.problems?.length) {
          this._debug(`ENVIRONMENT: could not read everything about the space to `
            + `${cs.target.name}: ${env.problems.join("; ")}`);
        }
      } catch (err) {
        // ⚠️ NEVER LOSE THE SWING OVER A MEASUREMENT. The attack is real and
        // the dice are rolled; a profile that throws must not delete a result.
        console.error(`${MODULE_ID} | the environment profile failed for `
          + `${cs.target?.name ?? "a target"} — the attack resolves without it:`, err);
        env = null;
      }

      // ── CUTTING WORDS — Lore Bard reaction to reduce attack roll ──
      // Must happen BEFORE hit determination since it changes the attack total.
      let adjustedAttackTotal = attackTotal;
      try {
        const reactionEng = game.aceQol?.reactionEngine;
        if (reactionEng && !isFumbleRoll && !isCritRoll) {
          const cwResult = await reactionEng.checkCuttingWords({
            actor: actor,
            token: atkToken,
            rollType: "attack",
            total: attackTotal,
            description: `${actor.name}'s attack with ${item.name}`,
          });
          if (cwResult.reduced) {
            adjustedAttackTotal = cwResult.newTotal;
            this._debug(`Cutting Words reduced attack total: ${attackTotal} → ${adjustedAttackTotal}`);
          }
        }
      } catch (err) {
        console.warn(`${MODULE_ID} | Cutting Words check failed (non-blocking):`, err);
      }

      // ── Mirror Image redirect (v0.7.15) ──
      // RAW: target with Mirror Image active rolls a d20 each time they're
      // attacked. Threshold 6/8/11 for 3/2/1 duplicates. On success, the
      // attack switches to a duplicate (AC 10 + DEX mod). If the attack hits
      // the duplicate, the duplicate is destroyed; the real target takes no
      // damage either way.
      // Note: this implementation does NOT yet honor blindsight / truesight /
      // see-illusions immunities — those are a tier-2 polish item.
      let mirrorImageRedirect = null;
      try {
        const targetActor = cs.targetActor ?? cs.target?.actor;
        const dupes = Number(targetActor?.getFlag?.(MODULE_ID, "mirrorImage") ?? 0);
        if (dupes > 0 && !isFumbleRoll && !coverResult?.isFullCover) {
          const threshold = dupes >= 3 ? 6 : dupes === 2 ? 8 : 11;
          const redirectRoll = await new Roll("1d20").evaluate();
          const redirectVal = redirectRoll.total;
          const isRedirected = redirectVal >= threshold;

          if (isRedirected) {
            // Duplicate's AC is 10 + the target's Dex mod — ask the target profile.
            const dexMod = _aceTargetProfile(targetActor)?.abilityMod("dex") ?? 0;
            const duplicateAC = 10 + dexMod;
            const hitDuplicate = adjustedAttackTotal >= duplicateAC;

            // Decrement duplicate count on hit (and remove the effect at 0).
            let newCount = dupes;
            if (hitDuplicate) {
              newCount = dupes - 1;
              try { await targetActor.setFlag(MODULE_ID, "mirrorImage", newCount); } catch (_) {}
              if (newCount === 0) {
                try {
                  const eff = targetActor.effects?.find(e => String(e.name ?? "").toLowerCase() === "mirror image");
                  if (eff) await eff.delete();
                  await targetActor.unsetFlag(MODULE_ID, "mirrorImage");
                } catch (_) {}
              }
            }

            mirrorImageRedirect = {
              rollResult: redirectVal,
              threshold,
              duplicatesBefore: dupes,
              duplicatesAfter: newCount,
              duplicateAC,
              hitDuplicate,
            };

            // Post a brief chat card so the table sees what happened.
            try {
              const remainingTxt = newCount === 0 ? "all duplicates destroyed — spell ends" : `${newCount} duplicate${newCount === 1 ? "" : "s"} remaining`;
              const outcomeTxt = hitDuplicate
                ? `<strong style="color:#d4af37;">duplicate destroyed</strong> — ${remainingTxt}`
                : `<strong style="color:#8eebff;">attack misses</strong> — duplicate not struck, ${dupes} duplicate${dupes === 1 ? "" : "s"} remaining`;
              ChatMessage.create({
                content: `
                  <div style="background:linear-gradient(180deg,#1a1416 0%,#241a30 100%);border:2px solid #8eebff;border-radius:6px;padding:8px 10px;color:#cfcfd0;font-size:12px;">
                    <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;">
                      <i class="fas fa-clone" style="color:#8eebff;font-size:16px;"></i>
                      <strong style="color:#8eebff;text-transform:uppercase;letter-spacing:0.5px;">Mirror Image</strong>
                    </div>
                    Attack on <strong>${targetActor.name}</strong> redirected (roll <strong>${redirectVal}</strong> vs threshold ${threshold}+).
                    Duplicate AC <strong>${duplicateAC}</strong> vs attack <strong>${adjustedAttackTotal}</strong> → ${outcomeTxt}.
                  </div>
                `,
                speaker: ChatMessage.getSpeaker({ actor: targetActor }),
              }).catch(() => {});
            } catch (_) { /* non-fatal */ }
          }
        }
      } catch (err) {
        console.warn(`${MODULE_ID} | Mirror Image redirect check failed (non-blocking):`, err);
      }

      // ── Determine hit/miss ──
      let hitResult;
      if (isFumbleRoll) {
        hitResult = "fumble";
      } else if (coverResult?.isFullCover) {
        hitResult = "miss"; // Full cover = can't be hit
      } else if (mirrorImageRedirect) {
        // Mirror Image redirected the attack to a duplicate — the real target
        // takes no damage regardless of whether the duplicate was hit.
        hitResult = "miss";
      } else if (isCritRoll) {
        hitResult = "critical";           // natural 20 always hits + crits
      } else if (adjustedAttackTotal >= effectiveAC) {
        // RAW: auto-crit conditions (melee vs paralyzed/unconscious, Assassinate
        // vs surprised, auto-crit flags) upgrade a HIT to a critical — they do
        // NOT make a miss into one. `cs.autoCrit` was tested BEFORE the AC
        // comparison, so a swing that missed an AC-18 target while it was Held
        // was reported as a CRIT and rolled doubled damage. (Audit, 2026-07-27.)
        hitResult = cs.autoCrit ? "critical" : "hit";
      } else {
        hitResult = "miss";
      }

      results.push({
        ...cs,           // full combat state (attacker + target + modifiers)
        name: cs.target.name,
        img: cs.target.img,
        ac: cs.target.ac,
        effectiveAC,
        coverResult,
        // The space between attacker and target, as measured for THIS pair.
        // Null only if the measurement itself threw, which is logged above.
        environment: env,
        hitResult,
        attackTotal: adjustedAttackTotal,
        originalAttackTotal: attackTotal,
        d20Result,
        isCritRoll,
        isFumbleRoll,
        mirrorImageRedirect,
      });
    }

    // Clear pre-roll cache
    this._lastCombatStates = null;
    this._lastCombatState = null;

    // ── POST-HIT REACTIONS (Shield, etc.) ──
    // Check before posting results so that Shield can change hits to misses.
    // The reactionEngine is accessed via the global API (avoids circular imports).
    const reactionEng = game.aceQol?.reactionEngine;
    if (reactionEng) {
      try {
        const modifiedResults = await reactionEng.checkPostHitReactions(results, item, actor);

        // ── ⚠️🔴 THIS DELETED EVERY ATTACK CARD IN THE GAME ─────────────
        //
        // `checkPostHitReactions` returns THE SAME ARRAY on its early-return
        // paths — `if (!enableReactions) return results;`. So `modifiedResults`
        // and `results` were one object, and this:
        //
        //     results.length = 0;              // empties BOTH — same reference
        //     results.push(...modifiedResults) // spreads what was just emptied
        //
        // wiped the results and put back nothing. An empty array is truthy, so
        // the guard let it through. One line later the card builder received
        // zero results and returned instantly, and no card appeared — ever,
        // for any creature, on any weapon.
        //
        // Johnny had `enableReactions` OFF, which is the exact path that
        // returns the original array. It ended a live session on 2026-08-24
        // and cost most of a night to find, because every layer was silent:
        // the roll happened, the Gate printed, the loop ran, the builder was
        // reached. Only the results had been deleted in between.
        //
        // ⚠️ NEVER MUTATE AN ARRAY YOU MIGHT HAVE HANDED OUT. The fix is to
        // treat the return as a value, not as permission to destroy the input:
        // if it is the same object there is nothing to do, and if it is a
        // different one it replaces the contents wholesale.
        if (Array.isArray(modifiedResults) && modifiedResults !== results) {
          results.length = 0;
          results.push(...modifiedResults);
        }

        // ⚠️ AND SAY SO IF A REACTION EVER EMPTIES A SWING. Shield can flip a
        // hit to a miss; it can never make a targeted attack resolve to
        // nothing. If that happens again it is a bug, and it announces itself
        // rather than quietly costing another evening.
        if (!results.length) {
          console.error(`${MODULE_ID} | post-hit reactions left "${item.name}" with NO results `
            + `where there were some before. That should be impossible — a reaction may change `
            + `an outcome, never delete it.`);
        }
      } catch (err) {
        console.error(`${MODULE_ID} | Post-hit reaction check failed:`, err);
      }
    }

    // ── SILVERY BARBS — force reroll on successful attacks ──
    // Opponents within 60ft can force the attacker to reroll the d20.
    if (reactionEng) {
      try {
        for (let i = 0; i < results.length; i++) {
          const r = results[i];
          if (r.hitResult !== "hit" && r.hitResult !== "critical") continue;
          const sbResult = await reactionEng.checkSilveryBarbs({
            actor: actor,
            token: atkToken,
            rollType: "attack",
            total: r.attackTotal,
            dc: r.effectiveAC,
            description: `${actor.name}'s attack against ${r.name}`,
          });
          if (sbResult.rerolled) {
            // Re-evaluate hit with new d20
            const newTotal = sbResult.newTotal ?? r.attackTotal;
            if (newTotal < r.effectiveAC && !r.isCritRoll) {
              results[i] = { ...r, hitResult: "miss", attackTotal: newTotal, silveryBarbsRerolled: true };
              this._debug(`Silvery Barbs: ${actor.name}'s attack rerolled → ${newTotal} vs AC ${r.effectiveAC} → MISS`);
            }
          }
        }
      } catch (err) {
        console.warn(`${MODULE_ID} | Silvery Barbs check failed (non-blocking):`, err);
      }
    }

    // ── Log results ──
    const hits = results.filter(r => r.hitResult === "hit" || r.hitResult === "critical");
    const misses = results.filter(r => r.hitResult === "miss" || r.hitResult === "fumble");

    this._debug(`Attack: ${item.name} (${attackTotal}) → ${hits.length} hits, ${misses.length} misses`);

    // ── Post attack results to chat ──
    // ── ⚠️🔴 A SWING MUST NEVER VANISH ────────────────────────────
    //
    // Johnny swung a rapier, a scimitar and a Spiked Chain on 2026-08-26 and
    // NO CHAT CARD APPEARED for any of them. The animation played, the Gate
    // printed both its lines, the multiattack chain resolved — and the card,
    // which is the only part he can actually see, was simply gone. Nothing in
    // the console said why, because a throw in here propagates into an awaited
    // call nobody catches and the swing evaporates.
    //
    // ⚠️ THIS IS THE SAME LESSON AS THE HALF-REGISTERED MODULE (08-09): a
    // broken thing must never look like a working one. If the card builder
    // fails, the GM is told, the console names the throw, and a plain fallback
    // card still posts with the roll on it — because a d20 that landed and
    // resolved is a fact about the game, and losing it silently is worse than
    // any formatting problem.
    try {
      // ⚠️ AND SAY IT AGAIN IF THE LOOP ITSELF DROPPED THEM. States in,
    // nothing out, is a different fault from having no states at all.
    if (combatStates.length && !results.length) {
      console.error(`${MODULE_ID} | ${actor.name}'s "${item.name}": `
        + `${combatStates.length} combat state(s) went into the resolution loop and `
        + `ZERO results came out. The card cannot build. This should be impossible.`);
    }

    await this._postAttackResults(item, actor, results, { isMelee, isSpell, roll, subject });
    } catch (err) {
      console.error(`${MODULE_ID} | THE ATTACK CARD FAILED TO BUILD for "${item?.name}". `
        + `The roll happened; only the card is missing. This is the bug:`, err);
      ui.notifications?.error(
        `ACE could not build the attack card for ${item?.name}. The console names the cause.`);
      // A bare card beats no card. It carries the totals ACE already resolved,
      // so the table can keep playing while this gets fixed.
      try {
        const rows = results.map(r =>
          `${r.name ?? "target"}: ${r.attackTotal ?? "?"} vs AC ${r.effectiveAC ?? r.ac ?? "?"}`
          + ` — ${String(r.hitResult ?? "?").toUpperCase()}`).join("<br>");
        await ChatMessage.create({
          speaker: ChatMessage.getSpeaker({ actor }),
          content: `<div><strong>${item?.name ?? "Attack"}</strong> `
            + `<em>(ACE fell back to a plain card — see the console)</em><br>${rows}</div>`,
        });
      } catch (fallbackErr) {
        console.error(`${MODULE_ID} | even the fallback card failed:`, fallbackErr);
      }
    }

    // ── RAW: Attack ends Invisibility spell (NOT Greater Invisibility) ──
    // Fires AFTER the attack results post so the order in chat reads:
    //   1. Attack results card
    //   2. "Invisibility ends" caption
    // Owner-permission gated inside the breaker; no-op for non-owners.
    // Setting `autoBreakInvisibility` controls this (default ON).
    try {
      const { InvisibilityBreaker } = await import("./invisibility-breaker.mjs");
      await InvisibilityBreaker.breakOnAttack(actor);
    } catch (err) {
      console.warn(`${MODULE_ID} | InvisibilityBreaker post-attack call threw:`, err);
    }

    // ── Store results for damage phase ──
    // The damage pipeline (Phase 4) will read this to apply damage
    this._lastAttackResults = results;
    this._lastAttackItem = item;
    this._lastAttackActor = actor;

    // Emit a hook that other modules/phases can listen to.
    // initiatorUserId: this local path only runs on the client that rolled
    // (_onAttackRoll is GM-gated and dnd5e roll hooks fire on the rolling
    // client), so game.user.id IS the user who pushed the attack button.
    // Player-rolled attacks arrive via the socket bridge instead, which
    // stamps the player's id (see ace-qol.mjs GM socket handler). Used by
    // the damage engine to route rider popups (Divine Smite etc.) to the
    // user who actually made the attack. v0.7.22.
    Hooks.callAll(`${MODULE_ID}.attackComplete`, {
      item,
      actor,
      results,
      hits,
      misses,
      actionType,
      subject,
      initiatorUserId: game.user.id,
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Chat Card — Attack Results
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Post a compact attack results card to chat.
   * Shows roll formula with modifier breakdown, big result number,
   * per-target hit/miss with state tags.
   */
  async _postAttackResults(item, actor, results, opts = {}) {
    if (!results.length) return;

    const r0 = results[0];
    const rollTotal = r0.attackTotal;
    const d20 = r0.d20Result;

    // ── Build modifier breakdown from the actual roll terms ──
    // Parse the roll formula to extract each modifier
    const formulaParts = [];
    const rollObj = opts.roll;

    // ── MERGE CARD: store attack data instead of posting separate card ──
    // When merge mode is enabled, we skip posting the attack card here.
    // Instead, we cache the attack results so the damage engine can build
    // a combined card when damage is calculated.
    if (MergeCard.isEnabled) {
      // Still build formula parts so the merge card can use them
      this._buildFormulaPartsForMerge(item, actor, results, opts);
      MergeCard.storeAttackResult({
        item, actor, results,
        roll: rollObj,
        opts,
        formulaParts: this._lastFormulaPartsHtml ?? "",
      });
      return; // Don't post the separate attack card
    }
    const rollFormula = rollObj?.formula ?? "";
    const rollTerms = rollObj?.terms ?? [];

    // ── Ability modifier — use the activity's computed ability (handles Battle Smith,
    //    finesse, spell attacks, thrown weapons, etc. automatically via the system) ──
    // Attacker numbers from the profile. This exact pair was duplicated at two
    // sites, both reading raw actor data — one reader now serves both.
    const _atk = _aceAttackerProfile(actor, item, opts.subject);
    const activity = opts.subject; // AttackActivity from dnd5e.rollAttackV2 hook

    // ══ ⚠️🔴 THE RESOLVER DECIDES; THIS CODE USED TO ═══════════════════
    //
    // Which ability, and whether proficiency applies, were worked out HERE, in
    // two places, from raw item and actor data. Neither the attacker nor the
    // attack can answer those alone — the rapier knows it is finesse and not
    // whose hand it is in; the fighter knows STR +2 and DEX +4 and not that the
    // weapon wants the better one. That pairing now has one home.
    //
    // Johnny, 2026-08-25: "That puts the dexterity behind the rapier attack."
    //
    // ⚠️ THE ANSWER IS UNCHANGED, THE REASON IS NEW. The resolver defers to
    // dnd5e's own computed ability wherever the system has one — it already
    // handles finesse, Battle Smith and Hexblade correctly — and supplies the
    // explanation. Where the two would disagree it says so instead of picking
    // silently. See tools/resolver-check.mjs.
    const _atkProf = _aceAttackProfile(item, activity);
    const _plan = resolveAttack({ attacker: _atk, attack: _atkProf });

    const profBonus = _plan.proficiencyApplies
      ? _plan.proficiencyBonus
      : 0;
    let resolvedAbility = _plan.ability ?? "";
    let abilityLabel = resolvedAbility.toUpperCase() || "";
    let abilityMod = Number(_plan.abilityMod) || 0;

    if (_plan.abilityBecause) {
      console.debug(`${MODULE_ID} | Resolver | ${item.name}: ${abilityLabel} `
        + `${abilityMod >= 0 ? "+" : ""}${abilityMod} — ${_plan.abilityBecause}`
        + (profBonus ? ` · proficiency +${profBonus} (${_plan.proficiencyBecause})` : "")
        + (_plan.proficiencyApplies ? "" : ` · NO proficiency: ${_plan.proficiencyBecause}`));
    }
    // ⚠️ A DISAGREEMENT IS NEVER BURIED. If ACE's own reasoning would have
    // picked a different ability than dnd5e did, that is either an odd item or
    // one of the two being wrong, and both deserve a look.
    if (_plan.abilityDisagreement) {
      console.warn(`${MODULE_ID} | Resolver | ${item.name}: dnd5e chose ${abilityLabel}, `
        + `but ${_plan.abilityDisagreement}`);
    }

    // Fallback only if activity wasn't available (e.g., old dnd5e version)
    if (!abilityLabel) {
      const actionType = activity?.actionType ?? item.system?.actionType ?? "mwak";
      const isFinesse = item.system?.properties?.has?.("fin");
      const isThrown = item.system?.properties?.has?.("thr");
      // The profile hands back plain numbers, not dnd5e ability objects — a
      // `.mod` here would read undefined and silently score every finesse
      // comparison as 0, picking the wrong ability without ever erroring.
      const strMod = _atk?.abilityMod("str") ?? 0;
      const dexMod = _atk?.abilityMod("dex") ?? 0;

      if (isFinesse) {
        if (dexMod > strMod) { abilityLabel = "DEX"; abilityMod = dexMod; }
        else { abilityLabel = "STR"; abilityMod = strMod; }
      } else if (isThrown && actionType === "rwak") {
        abilityLabel = "STR"; abilityMod = strMod;
      } else if (["rwak", "rsak"].includes(actionType)) {
        abilityLabel = "DEX"; abilityMod = dexMod;
      } else {
        abilityLabel = "STR"; abilityMod = strMod;
      }
    }

    // ⚠️🔴 THE PACT-WEAPON SWAP LIVES IN THE RESOLVER NOW.
    // This corrected the ability AFTER it had been derived, in two places, so
    // the stated reason said "a melee weapon attack, STR" while the roll
    // actually used Charisma. `resolveAbility` asks
    // `AttackAbilityResolver.getOverride` itself, so the number and the reason
    // now come out of one decision instead of two that could disagree.


    // Build the display formula
    const bd20Path = `modules/ace-qol/Assets/Dice%20Dice/BD20/BD20-${d20}_nobg.png`;
    formulaParts.push(
      `<span class="ace-qol-mod-die">`
      + `<img class="ace-qol-atk-d20-img" src="${bd20Path}" alt="d20" onerror="this.style.display='none';this.nextElementSibling.style.display='inline'">`
      + `<i class="fas fa-dice-d20 ace-qol-atk-d20-fallback" style="display:none"></i>`
      + `<span class="ace-qol-atk-d20-result">${d20}</span>`
      + `</span>`
    );
    // Always show the ability label so users know which stat is used (even when +0)
    formulaParts.push(`<span class="ace-qol-mod-chip"><span class="ace-qol-mod-num">${abilityMod >= 0 ? "+" : ""}${abilityMod}</span><span class="ace-qol-mod-label">${abilityLabel}</span></span>`);
    if (profBonus) {
      formulaParts.push(`<span class="ace-qol-mod-chip"><span class="ace-qol-mod-num">+${profBonus}</span><span class="ace-qol-mod-label">PROF</span></span>`);
    }

    // Check for magic bonus on the item
    // Coerce to number — dnd5e stores magicalBonus as a string in some
    // item schemas (Dawnbringer, etc.). Without coercion, downstream
    // math switches to string concatenation: 5 + 3 + "2" + 0 = "820".
    const magicBonus = Number(item.system?.magicalBonus) || 0;
    if (magicBonus) {
      formulaParts.push(`<span class="ace-qol-mod-chip"><span class="ace-qol-mod-num">+${magicBonus}</span><span class="ace-qol-mod-label ace-qol-mod-magic">MAGIC</span></span>`);
    }

    // Check for attack bonus from item
    const itemAtkBonus = item.system?.attack?.bonus ? parseInt(item.system.attack.bonus) || 0 : 0;
    if (itemAtkBonus) {
      formulaParts.push(`<span class="ace-qol-mod-chip"><span class="ace-qol-mod-num">+${itemAtkBonus}</span><span class="ace-qol-mod-label">ITEM</span></span>`);
    }

    // Delta detection — sum of displayed parts didn't match the actual roll
    // total. Common cases: summoned creatures with Match Proficiency adding a
    // spell-attack overlay, dnd5e Summon activity's `bonuses.attackDamage`,
    // active effects modifying attack rolls, etc. Show the unaccounted-for
    // chunk as a single labeled line so the breakdown still adds up.
    // Number()-coerce every input — defends against the magicalBonus
    // string-concat trap (see comment above) and any other field that
    // arrives as a string from DDB/legacy data.
    const displayedSum = (Number(abilityMod) || 0)
                       + (Number(profBonus) || 0)
                       + (Number(magicBonus) || 0)
                       + (Number(itemAtkBonus) || 0);
    const expectedBonus = (Number(rollTotal) || d20) - d20;
    const missingBonus = expectedBonus - displayedSum;
    if (missingBonus !== 0 && Number.isFinite(missingBonus)) {
      const isSummon = !!actor?.flags?.dnd5e?.summon;

      // ── Source attribution for the unaccounted-for modifier ──
      // Generic "+3 BONUS" is useless to the table — a DM or player looking
      // at the card has no idea WHERE that bonus came from. Walk the
      // actor's active effects to find a known buff source. Common ones
      // that add to attack rolls: Bless (1d4), Bardic Inspiration (d4-d12),
      // Inspiring Leader, Guidance (some tables), Aid (no but a flag-style
      // version exists). Add to this list as we encounter more in play.
      // NAME THE SOURCE FIRST (2026-07-29). Johnny, looking at a Fire Bolt card
      // carrying his staff's +2: "it says '+2 BONUS'. It doesn't say for what."
      // Ask which effect actually GRANTS an attack bonus rather than guessing
      // from a curated name list — that names a homebrew ring as readily as
      // Bless, and needs no maintenance.
      // Ask what ACTUALLY grants an attack bonus (walks the effects' changes),
      // then fall back to the curated buff names, then to a bare label.
      let label = AttackPipeline._attackBonusSourceLabel(actor);
      if (!label) {
        label = isSummon ? "SUMMON" : "BONUS";
        try {
          const effectNames = (actor?.effects ?? [])
            .filter(e => !e.disabled && !e.isSuppressed)
            .map(e => String(e.name ?? "").toLowerCase());
          // Order matters: more specific names checked first so partial-string
          // matches don't claim broader effects (e.g. "Bardic Inspiration"
          // before "Inspiration").
          if      (effectNames.some(n => n.includes("bardic inspiration"))) label = "INSPIRE";
          else if (effectNames.some(n => n.includes("bless")))              label = "BLESS";
          else if (effectNames.some(n => n.includes("guidance")))           label = "GUIDE";
          else if (effectNames.some(n => n.includes("inspiring leader")))   label = "LEADER";
          else if (effectNames.some(n => n.includes("haste")))              label = "HASTE";
          else if (effectNames.some(n => n.includes("enlarge")))            label = "ENLARGE";
          else if (effectNames.some(n => n.includes("hex"))
                   || effectNames.some(n => n.includes("hunter's mark")))   label = "MARK";
        } catch (_) { /* fall back to "BONUS" / "SUMMON" */ }
      }

      const _named = (label !== "BONUS" && label !== "SUMMON") ? " ace-qol-mod-source" : "";
      formulaParts.push(`<span class="ace-qol-mod-chip"><span class="ace-qol-mod-num">${missingBonus >= 0 ? "+" : ""}${missingBonus}</span><span class="ace-qol-mod-label${_named}">${label}</span></span>`);
    }

    const formulaStr = formulaParts.join(" ");

    // ── Roll mode indicator ──
    const rollModeLabel = r0.finalRollMode === "advantage" ? '<span class="ace-qol-roll-mode ace-qol-adv">ADV</span>'
                        : r0.finalRollMode === "disadvantage" ? '<span class="ace-qol-roll-mode ace-qol-disadv">DISADV</span>'
                        : "";

    // ── Hit result class for the big number ──
    const anyHit = results.some(r => r.hitResult === "hit" || r.hitResult === "critical");
    const anyCrit = results.some(r => r.hitResult === "critical");
    const resultClass = anyCrit ? "ace-qol-result-crit"
                      : anyHit ? "ace-qol-result-hit"
                      : "ace-qol-result-miss";

    // ── Target rows ──
    const targetRows = results.map(r => {
      const tags = CombatState.getSummaryTags(r);
      const tagHtml = tags.map(t =>
        `<span class="ace-qol-tag ace-qol-tag-${t.type}"><i class="fas ${t.icon}"></i> ${t.label}</span>`
      ).join("");

      const hitClass = r.hitResult === "critical" ? "ace-qol-crit"
                     : r.hitResult === "hit" ? "ace-qol-hit"
                     : r.hitResult === "fumble" ? "ace-qol-fumble"
                     : "ace-qol-miss";

      const hitLabel = r.hitResult === "critical" ? "CRIT!"
                     : r.hitResult === "hit" ? "HIT"
                     : r.hitResult === "fumble" ? "FUMBLE"
                     : "MISS";

      // ── Cover tag (shown next to AC when cover applies) ──
      const coverLabelShort = r.coverResult?.cover === 5 ? "¾ cover"
                            : r.coverResult?.cover === 2 ? "half cover"
                            : "cover";
      const coverTag = r.coverResult && r.coverResult.acBonus > 0
        ? `<span class="ace-qol-tag ace-qol-tag-cover" title="${r.coverResult.label} — ${r.coverResult.blockedPct}% line of sight blocked"><i class="fas fa-shield-alt"></i> +${r.coverResult.acBonus} AC for ${coverLabelShort}</span>`
        : r.coverResult?.isFullCover
        ? `<span class="ace-qol-tag ace-qol-tag-cover ace-qol-tag-cover-full" title="Full cover — line of sight completely blocked. Cannot be targeted."><i class="fas fa-shield-alt"></i> FULL COVER (untargetable)</span>`
        : "";
      const acDisplay = r.effectiveAC && r.effectiveAC !== r.ac
        ? `AC ${r.effectiveAC} <span class="ace-qol-atk-ac-bonus" title="Base AC ${r.ac} + Cover ${r.effectiveAC - r.ac}">+${r.effectiveAC - r.ac}</span>`
        : `AC ${r.ac}`;

      // ── Mirror Image redirect caption ──
      // When the attack was absorbed by an illusory duplicate, the row shows
      // MISS but without context the table sees "21 vs AC 13 = MISS" and is
      // confused why. Inject a small caption below the target row explaining
      // the redirect, with the same icy-blue color as the redirect chat card.
      let mirrorCaption = "";
      if (r.mirrorImageRedirect) {
        const mi = r.mirrorImageRedirect;
        // i18n: caption pulled from languages/en.json (and any other locale
        // files the user has installed). Falls back to the English literal
        // if the key is missing somehow.
        const key = mi.hitDuplicate
          ? "ACE_QOL.mirrorImage.redirectHitDestroyed"
          : "ACE_QOL.mirrorImage.redirectHitDodged";
        const outcome = game.i18n?.format?.(key, { ac: mi.duplicateAC })
                     ?? (mi.hitDuplicate
                         ? `Hit Mirror Image duplicate (AC ${mi.duplicateAC}) — duplicate destroyed`
                         : `Hit Mirror Image duplicate (AC ${mi.duplicateAC}) — duplicate dodged`);
        mirrorCaption = `<div class="ace-qol-atk-mirror-caption">→ ${outcome}</div>`;
      }

      return `
        <div class="ace-qol-atk-row">
          <div class="ace-qol-atk-target">
            <img src="${r.img || "icons/svg/mystery-man.svg"}" class="ace-qol-atk-img" />
            <span class="ace-qol-atk-name">${r.name}</span>
            <span class="ace-qol-atk-ac">${acDisplay}</span>
            <span class="ace-qol-atk-result ${hitClass}">${hitLabel}</span>
          </div>
          ${mirrorCaption}
          ${coverTag || tagHtml ? `<div class="ace-qol-atk-tags">${coverTag}${tagHtml}</div>` : ""}
        </div>
      `;
    }).join("");

    // Collapsible item details (embeds the dnd5e description + property tags)
    const itemDetailsHtml = await this._buildItemDetails(item);

    const cardHtml = `
      <div class="ace-qol-attack-card">
        <div class="ace-qol-atk-header">
          <img src="${item.img || "icons/svg/sword.svg"}" class="ace-qol-atk-item-img" />
          <strong class="ace-qol-atk-item-name">${item.name}</strong>
          <button type="button" class="ace-qol-atk-info-toggle" data-action="toggleItemDetails" title="Show item details" aria-expanded="false">
            <i class="fas fa-chevron-down"></i>
          </button>
          ${rollModeLabel}
        </div>
        <div class="ace-qol-atk-item-details ace-qol-collapsed">${itemDetailsHtml}</div>
        <div class="ace-qol-atk-roll">
          <span class="ace-qol-atk-formula">
            ${formulaStr}
            <span class="ace-qol-atk-result-chip">
              <span class="ace-qol-atk-equals">=</span>
              <span class="ace-qol-atk-total ${resultClass}">${rollTotal}</span>
            </span>
          </span>
        </div>
        <div class="ace-qol-atk-results">
          ${targetRows}
        </div>
      </div>
    `;

    // Wait for DSN dice to finish tumbling before posting the result card —
    // otherwise the chat card spoils the d20 result while dice are still rolling.
    await awaitDsnRoll();

    await ChatMessage.create({
      content: cardHtml,
      speaker: ChatMessage.getSpeaker({ actor }),
      flags: {
        [MODULE_ID]: {
          type: "attackResult",
          itemId: item.id,
          actorId: actor.id,
        }
      }
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Merge Card Support — Pre-build formula HTML for combined display
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Build the attack formula HTML string for the merge card.
   * Same logic as the formula builder in _postAttackResults, but stored
   * in this._lastFormulaPartsHtml for the MergeCard to consume.
   */
  _buildFormulaPartsForMerge(item, actor, results, opts) {
    const r0 = results[0];
    const d20 = r0.d20Result;
    const parts = [];

    // Same profile-sourced numbers as the first site above.
    // ⚠️ THE SAME PLAN, ASKED THE SAME WAY. This site and the one above were
    // two hand-written copies of the same derivation; that is how they drift.
    // Both call the resolver now.
    const _atk2 = _aceAttackerProfile(actor, item, opts.subject);
    const activity = opts.subject;
    const _plan2 = resolveAttack({
      attacker: _atk2,
      attack: _aceAttackProfile(item, activity),
    });

    const profBonus = _plan2.proficiencyApplies ? _plan2.proficiencyBonus : 0;
    let resolvedAbility2 = _plan2.ability ?? "";
    let abilityLabel = resolvedAbility2.toUpperCase() || "";
    let abilityMod = Number(_plan2.abilityMod) || 0;

    if (!abilityLabel) {
      const actionType = activity?.actionType ?? item.system?.actionType ?? "mwak";
      const isFinesse = item.system?.properties?.has?.("fin");
      const isThrown = item.system?.properties?.has?.("thr");
      // The profile hands back plain numbers, not dnd5e ability objects — a
      // `.mod` here would read undefined and silently score every finesse
      // comparison as 0, picking the wrong ability without ever erroring.
      const strMod = _atk2?.abilityMod("str") ?? 0;
      const dexMod = _atk2?.abilityMod("dex") ?? 0;
      if (isFinesse) {
        if (dexMod > strMod) { abilityLabel = "DEX"; abilityMod = dexMod; }
        else { abilityLabel = "STR"; abilityMod = strMod; }
      } else if (isThrown && actionType === "rwak") {
        abilityLabel = "STR"; abilityMod = strMod;
      } else if (["rwak", "rsak"].includes(actionType)) {
        abilityLabel = "DEX"; abilityMod = dexMod;
      } else {
        abilityLabel = "STR"; abilityMod = strMod;
      }
    }

    // ⚠️🔴 THE PACT-WEAPON SWAP LIVES IN THE RESOLVER NOW.
    // This corrected the ability AFTER it had been derived, in two places, so
    // the stated reason said "a melee weapon attack, STR" while the roll
    // actually used Charisma. `resolveAbility` asks
    // `AttackAbilityResolver.getOverride` itself, so the number and the reason
    // now come out of one decision instead of two that could disagree.


    const bd20Path = `modules/ace-qol/Assets/Dice%20Dice/BD20/BD20-${d20}_nobg.png`;
    parts.push(
      `<span class="ace-qol-mod-die">`
      + `<img class="ace-qol-atk-d20-img" src="${bd20Path}" alt="d20" onerror="this.style.display='none';this.nextElementSibling.style.display='inline'">`
      + `<i class="fas fa-dice-d20 ace-qol-atk-d20-fallback" style="display:none"></i>`
      + `<span class="ace-qol-atk-d20-result">${d20}</span>`
      + `</span>`
    );
    parts.push(`<span class="ace-qol-mod-chip"><span class="ace-qol-mod-num">${abilityMod >= 0 ? "+" : ""}${abilityMod}</span><span class="ace-qol-mod-label">${abilityLabel}</span></span>`);
    if (profBonus) {
      parts.push(`<span class="ace-qol-mod-chip"><span class="ace-qol-mod-num">+${profBonus}</span><span class="ace-qol-mod-label">PROF</span></span>`);
    }
    // Coerce magicalBonus to a number — dnd5e stores it as a string on some
    // items (e.g. Dawnbringer). Without coercion the delta math below uses
    // string concatenation and produces nonsense like "-810 BONUS".
    const magicBonus = Number(item.system?.magicalBonus) || 0;
    if (magicBonus) {
      parts.push(`<span class="ace-qol-mod-chip"><span class="ace-qol-mod-num">+${magicBonus}</span><span class="ace-qol-mod-label ace-qol-mod-magic">MAGIC</span></span>`);
    }
    const itemAtkBonus = item.system?.attack?.bonus ? parseInt(item.system.attack.bonus) || 0 : 0;
    if (itemAtkBonus) {
      parts.push(`<span class="ace-qol-mod-chip"><span class="ace-qol-mod-num">+${itemAtkBonus}</span><span class="ace-qol-mod-label">ITEM</span></span>`);
    }

    // Delta detection — same logic as _postAttackResults; Number()-coerce
    // every input to defend against string-concat traps.
    const rollTotal = Number(r0?.attackTotal);
    const displayedSum = (Number(abilityMod) || 0)
                       + (Number(profBonus) || 0)
                       + (Number(magicBonus) || 0)
                       + (Number(itemAtkBonus) || 0);
    const expectedBonus = (Number.isFinite(rollTotal) ? rollTotal : d20) - d20;
    const missingBonus = expectedBonus - displayedSum;
    if (missingBonus !== 0 && Number.isFinite(missingBonus)) {
      const isSummon = !!actor?.flags?.dnd5e?.summon;
      // Same attribution as the main card — this path was showing a bare
      // "+2 BONUS" too, and half-naming a modifier is worse than not naming it.
      const label = AttackPipeline._attackBonusSourceLabel(actor)
                 ?? (isSummon ? "SUMMON" : "BONUS");
      const _named = (label !== "BONUS" && label !== "SUMMON") ? " ace-qol-mod-source" : "";
      parts.push(`<span class="ace-qol-mod-chip"><span class="ace-qol-mod-num">${missingBonus >= 0 ? "+" : ""}${missingBonus}</span><span class="ace-qol-mod-label${_named}">${label}</span></span>`);
    }

    this._lastFormulaPartsHtml = parts.join(" ");
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Helpers
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Extract all damage types from an item (weapon or spell).
   * Reads from activities (dnd5e v4+) and legacy damage.parts.
   */
  _getItemDamageTypes(item) {
    const types = new Set();
    const sys = item.system ?? {};

    // Activities (dnd5e v4+)
    const activities = sys.activities;
    if (activities) {
      const actList = (typeof activities.forEach === "function")
        ? [...(activities.values?.() ?? activities)]
        : (typeof activities === "object" ? Object.values(activities) : []);

      for (const activity of actList) {
        if (!activity?.damage?.parts) continue;
        for (const part of activity.damage.parts) {
          if (part.types) {
            for (const t of part.types) types.add(t);
          }
        }
      }
    }

    // Legacy damage.parts
    if (sys.damage?.parts) {
      for (const part of sys.damage.parts) {
        if (part[1]) types.add(part[1]);
      }
    }

    // Weapon profile riders (from ACE Artificer)
    try {
      const profile = item.getFlag("ace-artificer", "profile");
      if (profile?.riders) {
        for (const rider of profile.riders) {
          if (rider.damageType) types.add(rider.damageType);
        }
      }
    } catch (err) { console.debug("ace-qol | AttackPipeline artificer rider read:", err); }

    // Bonus damage from active effects (e.g., Frost Brand's 2d6[cold])
    const bonusDmg = item.system?.bonuses?.mwak?.damage ?? "";
    const bracketMatch = bonusDmg.match(/\[(\w+)\]/g);
    if (bracketMatch) {
      for (const m of bracketMatch) {
        types.add(m.replace(/[\[\]]/g, ""));
      }
    }

    return [...types];
  }

  /**
   * Get the last attack results (for Phase 4 damage pipeline to consume).
   */
  getLastAttackResults() {
    return {
      results: this._lastAttackResults ?? [],
      item: this._lastAttackItem ?? null,
      actor: this._lastAttackActor ?? null,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Range Check
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Check if the target is within the weapon's range.
   * For weapons with both melee and ranged capability (e.g., thrown daggers),
   * auto-detect which mode based on distance:
   *   - Within reach → melee
   *   - Beyond reach but within range → ranged
   *   - Beyond all ranges → blocked
   *
   * @returns {{ blocked: boolean, distanceFt: number, rangeDesc: string, isRanged: boolean }}
   */

  /**
   * Detect whether an attack is melee. Checks the activity's actionType first
   * (mwak/msak), then range.units (touch/melee), then activity range value (≤ 5).
   * Throw weapons are NOT considered melee here — at long range they're rwak.
   * @param {Item} item
   * @param {Activity|object} subject - dnd5e activity (5.x) or null (legacy)
   * @returns {boolean}
   */
  static _isMeleeAttack(item, subject) {
    try {
      // Prefer the activity's resolved actionType (it knows about ranged/melee mode)
      const actionType = subject?.actionType ?? item?.system?.actionType ?? "";
      if (actionType === "mwak" || actionType === "msak") return true;

      // Activity-level range (dnd5e 5.x)
      const actRange = subject?.range ?? subject?.system?.range ?? null;
      if (actRange?.units === "touch" || actRange?.units === "self") return true;
      if (actRange?.units === "ft" && (actRange?.value ?? 0) <= 5 && (actRange?.value ?? 0) > 0) return true;

      // Item-level range fallback (legacy)
      const itemRange = item?.system?.range ?? {};
      if (itemRange.units === "touch") return true;
      if (itemRange.units === "ft" && (itemRange.value ?? 0) <= 5 && (itemRange.value ?? 0) > 0) return true;

      return false;
    } catch (err) {
      console.warn(`ace-qol | _isMeleeAttack failed:`, err);
      return false;
    }
  }

  /**
   * Detect whether the attacker has a multi-target melee feature that legitimately
   * lets them swing at more than one creature on a single attack action.
   * Recognizes: Cleave (weapon mastery + feat), Great Weapon Master, Whirlwind
   * Attack, and any UUID/identifier added to the world setting
   * `multiTargetMeleeFeatureIds`.
   *
   * v0.4.22 refactor — three-layer detection (was pure name-matching):
   *
   *   Layer 1: dnd5e weapon mastery property "cleave" on the swung weapon.
   *     If the weapon itself has the cleave mastery, the wielder gets the
   *     multi-target swing regardless of feats. (`item.system.properties`
   *     is a Set in dnd5e 5.x.)
   *
   *   Layer 2: feature identifier match on `system.identifier`.
   *     Stable across translations (the identifier stays in English even
   *     when the displayed name is translated). Catches:
   *       great-weapon-master, cleaving-attack, whirlwind-attack,
   *       improved-whirlwind-attack, cleave (the weapon mastery feat in
   *       homebrew rebrands)
   *
   *   Layer 3: world-configurable allow-list via `multiTargetMeleeFeatureIds`
   *     setting (Array<string>). GMs can drop in UUIDs, identifiers, or
   *     names to extend without code changes. Useful for homebrew or
   *     content packs.
   *
   *   Layer 4 (last resort): English name-matching, kept for back-compat
   *     with older worlds that don't have identifiers populated. Logged at
   *     debug level so brittle matches surface during diagnostic runs.
   *
   * Note: "Multiattack" is NOT included in any layer — that means "make N
   * attack rolls sequentially, each on its own target", not "one attack
   * hits N targets". Different mechanic.
   *
   * @param {Actor} actor - The attacking actor
   * @param {Item}  [weapon] - Optional: the specific weapon being swung,
   *                           used for Layer 1 weapon-mastery detection
   * @returns {boolean}
   */
  static _actorHasMultiTargetMelee(actor, weapon = null) {
    if (!actor?.items) return false;

    // ── Layer 1: weapon mastery "cleave" property on the active weapon ──
    // 2024 system data populates `cleave` in weapon system.properties for
    // cleave-mastery weapons (greataxe, halberd). This is the fast-path.
    try {
      const props = weapon?.system?.properties;
      const hasCleaveMastery = props?.has?.("cleave") === true
                            || (Array.isArray(props) && props.includes("cleave"));
      if (hasCleaveMastery) return true;
    } catch (_) { /* fall through */ }

    // ── Layer 1b: weapon-name → cleave mastery (2014 fallback + safety) ──
    // 2014 system data does NOT populate the `cleave` property even on
    // greataxe/halberd. To get the damage-card CLEAVE button to render in
    // 2014 mode with the override setting on, fall back to name-based
    // lookup. Gated by:
    //   - master mastery toggle is ON
    //   - rulesVersion is modern OR override setting is ON
    //   - actor actually has the Weapon Mastery class feature
    // All three gates must pass — otherwise the button stays hidden, which
    // is correct (the click handler would just bail anyway).
    try {
      const rv = CombatState.getActiveRulesVersion(actor);  // honors ACE gameRulesEdition override
      const allow2014 = game.settings.get?.(MODULE_ID, "weaponMasteryAllowIn2014") === true;
      const masteryEnabled = game.settings.get?.(MODULE_ID, "weaponMasteryEnabled") !== false;
      if (masteryEnabled && (rv !== "legacy" || allow2014)) {
        if (WeaponMasteries?.getMasteryFor?.(weapon) === "cleave"
            && WeaponMasteries?._actorHasMasteryFeature?.(actor)) {
          return true;
        }
      }
    } catch (_) { /* fall through */ }

    // ── Layer 3: world-configurable allow-list ──
    let allowList = [];
    try {
      const raw = game.settings.get(MODULE_ID, "multiTargetMeleeFeatureIds");
      if (Array.isArray(raw)) allowList = raw.map(s => String(s).toLowerCase());
    } catch (_) { /* setting may not be registered yet */ }

    // ── Layer 2 + 3 + 4: scan items ──
    const KNOWN_IDENTIFIERS = new Set([
      "great-weapon-master",
      "cleaving-attack",
      "cleave",
      "whirlwind-attack",
      "improved-whirlwind-attack",
    ]);

    for (const item of actor.items) {
      if (item.type !== "feat" && item.type !== "subclass" && item.type !== "class") continue;

      // Layer 2: stable identifier match
      const id = String(item.system?.identifier ?? "").toLowerCase();
      if (id && KNOWN_IDENTIFIERS.has(id)) return true;

      // Layer 3: world-configured allow-list (matches identifier, name, or UUID)
      if (allowList.length) {
        const uuid = String(item.uuid ?? "").toLowerCase();
        const name = String(item.name ?? "").toLowerCase();
        if (allowList.includes(id) || allowList.includes(name) || allowList.includes(uuid)) return true;
      }

      // Layer 4: legacy English name-matching (back-compat)
      const name = (item.name ?? "").toLowerCase();
      if (name.includes("cleave") || name.includes("cleaving")) {
        try {
          if (game.settings.get(MODULE_ID, "debugMode")) {
            console.log(`${MODULE_ID} | multi-target detection: matched "${item.name}" via legacy name-matching (no identifier set). Recommend setting system.identifier or adding to multiTargetMeleeFeatureIds.`);
          }
        } catch (_) {}
        return true;
      }
      if (name.includes("great weapon master")) return true;
      if (name.includes("whirlwind")) return true;
    }
    return false;
  }

  _checkRange(attackerActor, targetToken, item, subject = null, attacker = null) {
    // ══ EVERY FACT BELOW COMES OFF THE ATTACKER PROFILE ═══════════════════
    //
    // ⚠️ THE PROFILE IS PASSED IN, NOT REBUILT. The pre-roll gate already
    // read this creature; rebuilding here could read it a second time and, if
    // anything changed in between, quietly answer a different question than the
    // gate did. When no profile is handed down (the item-use wrapper in
    // `ace-qol.mjs` calls this with no activity), one is built from the item's
    // OWN first activity, so this check is never left reading an item that
    // dnd5e 5.x no longer stores the answers on.
    // ⚠️ RESOLVE THE ACTIVITY ONCE, AND USE THE SAME ONE EVERYWHERE BELOW.
    // The item-use wrapper in `ace-qol.mjs` calls this with no activity at all,
    // and in dnd5e 5.x the action type, the range and the reach all live on the
    // activity — so that path was classifying a swing from an item that no
    // longer stores the answers.
    const activity = subject ?? item?.system?.activities?.contents?.[0] ?? null;
    const profile = attacker ?? _aceAttackerProfile(attackerActor, item, activity);

    // ⚠️ THE PROFILE KNOWS WHICH TOKEN IS SWINGING. This used to take the
    // actor's first active token and, failing that, whatever the user happened
    // to have selected — so a GM with a different creature selected could have
    // the range measured from the wrong square entirely.
    const atkToken = profile?.token
                  ?? attackerActor.getActiveTokens?.()?.[0]
                  ?? canvas.tokens.controlled?.[0];
    if (!atkToken || !targetToken) return { blocked: false, distanceFt: 0, rangeDesc: "", isRanged: false };

    // Measure distance — edge-to-edge for correct Large/Huge/Gargantuan
    // handling, and elevation-aware, so a flying attacker is not in melee
    // reach of the ground just because the squares line up.
    let distanceFt = CombatState._getDistance(atkToken, targetToken);
    distanceFt = Math.round(distanceFt);

    const sys = item.system ?? {};

    // ⚠️🔴 THE ATTACK IS ITS OWN PROFILE NOW. This used to read
    // `profile.action` — 32 fields about a rapier that were living inside the
    // creature. Johnny, 2026-08-25: "There are two separate things here: the
    // attack and the attacker." Same numbers, asked of the right object.
    const act = _aceAttackProfile(item, activity);

    // dnd5e 5.x moved actionType + range onto the ACTIVITY. Reading only the
    // item here is why monster natural attacks (Ram/Bite/Claw — weapon type
    // "natural", actionType empty on the item) were classified "unknown" and
    // skipped the gate entirely. The profile already asked the activity first.
    const actionType  = activity?.actionType ?? sys.actionType ?? "";
    const normalRange = act ? (act.rangeNormal || 5) : (activity?.range?.value ?? sys.range?.value ?? 5);
    const longRange   = act ? act.rangeLong : (activity?.range?.long ?? sys.range?.long ?? 0);

    // ⚠️ ONE REACH RESOLVER, AND THE PROFILE ALREADY RAN IT. The target
    // picker, the chat card and the hover tooltip all read the same number from
    // `reach-reader.mjs`; asking again here is how four different answers to
    // "how far does this reach" got into the codebase in the first place.
    const props = act?.properties ?? (sys.properties ? new Set(sys.properties) : new Set());
    const meleeReach = act?.reachFt || AttackPipeline._reachFor(item, activity);

    // Classify melee via the shared, activity-aware helper, plus weapon type
    // (natural = monster attacks; simpleM/martialM = PC melee). isRanged covers
    // weapon attacks and spell attacks (rsak).
    const weaponType = sys.type?.value ?? "";
    const isThrown   = props.has("thr");
    const isMelee = AttackPipeline._isMeleeAttack(item, activity)
      || weaponType === "natural"
      || weaponType.includes("simpleM") || weaponType.includes("martialM");
    const isRanged = actionType === "rwak" || actionType === "rsak"
      || weaponType.includes("simpleR") || weaponType.includes("martialR");

    // Dual melee/ranged (thrown weapons like daggers, javelins, handaxes)
    if (isThrown || (isMelee && longRange > 0)) {
      if (distanceFt <= meleeReach) {
        // Within melee reach — treat as melee
        return { blocked: false, distanceFt, rangeDesc: `melee reach ${meleeReach}ft`, isRanged: false };
      } else if (distanceFt <= (longRange || normalRange)) {
        // Beyond melee but within thrown/ranged — treat as ranged
        return { blocked: false, distanceFt, rangeDesc: `thrown ${normalRange}/${longRange}ft`, isRanged: true };
      } else {
        // Beyond all ranges
        return { blocked: true, distanceFt, rangeDesc: `reach ${meleeReach}ft / thrown ${normalRange}/${longRange}ft`, isRanged: true };
      }
    }

    // Pure melee weapon (incl. monster natural attacks)
    if (isMelee && !isRanged) {
      if (distanceFt <= meleeReach) {
        return { blocked: false, distanceFt, rangeDesc: `melee reach ${meleeReach}ft`, isRanged: false };
      } else {
        return { blocked: true, distanceFt, rangeDesc: `melee reach ${meleeReach}ft`, isRanged: false };
      }
    }

    // Pure ranged weapon
    if (isRanged) {
      const maxRange = longRange || normalRange;
      if (distanceFt <= maxRange) {
        return { blocked: false, distanceFt, rangeDesc: `range ${normalRange}/${longRange}ft`, isRanged: true };
      } else {
        return { blocked: true, distanceFt, rangeDesc: `range ${normalRange}/${longRange}ft`, isRanged: true };
      }
    }

    // Genuinely unclassifiable — don't false-block a legitimate action.
    return { blocked: false, distanceFt, rangeDesc: "", isRanged: false };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Item Details (collapsible) — embeds the dnd5e item description + tags
  // ═══════════════════════════════════════════════════════════════════════════

  async _buildItemDetails(item) {
    const sys = item?.system ?? {};

    // Description: enrich so links / inline rolls / references resolve
    let desc = sys.description?.value ?? "";
    try {
      const TE = foundry.applications?.ux?.TextEditor?.implementation
              ?? globalThis.TextEditor;
      if (TE?.enrichHTML) {
        desc = await TE.enrichHTML(desc, {
          rollData: item.actor?.getRollData?.() ?? {},
          relativeTo: item,
          secrets: false,
        });
      }
    } catch (err) {
      console.warn(`${MODULE_ID} | enrichHTML failed for ${item.name}:`, err);
    }

    // Property tags — match what dnd5e shows on its item cards
    const tags = [];

    // Activation type (ACTION / BONUS / REACTION)
    const activationType = sys.activation?.type ?? sys.activities?.contents?.[0]?.activation?.type;
    if (activationType) tags.push(String(activationType).toUpperCase());

    // Range / reach
    // ⚠️🔴 THE CARD MUST NOT PRINT A DIFFERENT REACH THAN THE GATE USED.
    // This read the item's range slot only — no activity, no description
    // fallback — so a Spiked Chain whose reach lives in its description showed
    // no REACH tag at all while the range check happily used 10 ft. A card that
    // disagrees with the rule it is reporting is worse than a card with no tag.
    // ⚠️ `repair: false` — a card can re-render many times and rendering is
    // not a swing. The write-back belongs to the attack path.
    const reach     = resolveReach(item, sys.activities?.contents?.[0] ?? null, { repair: false }).reachFt;
    const rangeVal  = sys.range?.value;
    const rangeLong = sys.range?.long;
    const rangeUnits = sys.range?.units ?? "ft";
    if (reach && !rangeLong)            tags.push(`REACH ${reach} ${rangeUnits.toUpperCase()}`);
    else if (rangeVal && rangeLong)     tags.push(`RANGE ${rangeVal}/${rangeLong} ${rangeUnits.toUpperCase()}`);
    else if (rangeVal && !reach)        tags.push(`RANGE ${rangeVal} ${rangeUnits.toUpperCase()}`);

    if (sys.attuned || sys.attunement === "attuned")     tags.push("ATTUNED");
    if (sys.equipped)                                    tags.push("EQUIPPED");
    if (sys.proficient || sys.prof?.hasProficiency)      tags.push("PROFICIENT");
    if (sys.magicalBonus || sys.properties?.has?.("mgc")) tags.push("MAGICAL");

    // Weapon mastery (Sap, Vex, Topple, etc.)
    const mastery = sys.mastery;
    if (mastery) {
      const masteryLabel = CONFIG?.DND5E?.weaponMasteries?.[mastery]?.label
        ?? CONFIG?.DND5E?.weaponMasteries?.[mastery]
        ?? mastery;
      tags.push(`MASTERY: ${String(masteryLabel).toUpperCase()}`);
    }

    // Weapon properties (Finesse, Light, Versatile, Two-Handed, Heavy, Reach, etc.)
    const propsCfg = CONFIG?.DND5E?.itemProperties ?? {};
    const propsSet = sys.properties;
    if (propsSet) {
      const propIter = (propsSet instanceof Set) ? [...propsSet] : Object.keys(propsSet);
      for (const p of propIter) {
        const label = propsCfg[p]?.label ?? propsCfg[p] ?? p;
        // Skip the magical bookkeeping property (already shown as MAGICAL above)
        if (p === "mgc") continue;
        tags.push(String(label).toUpperCase());
      }
    }

    const tagsHtml = tags.length
      ? `<div class="ace-qol-atk-itemtags">${tags.map(t => `<span class="ace-qol-atk-itemtag">${t}</span>`).join("")}</div>`
      : "";

    return `<div class="ace-qol-atk-itemdesc">${desc || "<em>No description.</em>"}</div>${tagsHtml}`;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Debug
  // ═══════════════════════════════════════════════════════════════════════════

  _debug(msg) {
    try {
      if (game.settings.get(MODULE_ID, "debugMode")) {
        console.log(`${MODULE_ID} | ATK | ${msg}`);
      }
    } catch { /* settings not ready */ }
  }
}
