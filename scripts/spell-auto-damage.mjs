// ─── ACE: QOL — Spell Auto-Damage Pipeline ───────────────────────────────────
// Handles damage-type spell activities that have NO attack roll AND NO save.
// Magic Missile, Witch Bolt initial hit, Inflict Wounds (some implementations),
// and any custom AI-generated "auto-hit" damage spell falls into this category.
//
// Without this handler, the vanilla dnd5e flow rolls damage natively but
// completely bypasses our resistance / immunity / vulnerability checks. A
// flesh golem that's immune to force damage would still take full damage
// from Magic Missile. The Shield reaction would never fire on the target.
//
// Pipeline:
//   1. Hook dnd5e.preUseActivity, filter to spell items with activity
//      type === "damage" (not "attack", not "save", not "heal").
//   2. Read user-targeted tokens (game.user.targets).
//   3. Cancel the vanilla flow (return false) so dnd5e doesn't post its own
//      damage card without our resistance gates.
//   4. Roll the activity's damage formula ONCE per target — each gets their
//      own DSN animation, own resistance/immunity application, own card row.
//   5. Build a synthetic hits[] (no attack roll, hitResult: "hit") and route
//      through the existing DamageCardRenderer pipeline so the damage card,
//      apply/undo buttons, override widgets, and post-hit save processing
//      all work identically to a weapon-attack damage card.
//
// Limitations:
//   - Magic Missile's "distribute darts among multiple targets" UI is NOT
//     replicated. Each user-targeted token takes the FULL spell damage.
//     If the player wants per-dart distribution, they target one creature
//     at a time and re-cast (slot consumption is handled by dnd5e since we
//     don't cancel that path).
//   - Spells that have BOTH damage and a save (Phantasmal Killer style)
//     still go through save-engine, not this path. We filter that out.
// ──────────────────────────────────────────────────────────────────────────────

import { MODULE_ID } from "./ace-qol.mjs";
import { QolSettings } from "./settings.mjs";
import { DamageCalculator } from "./damage-calculator.mjs";
import { DamageCardRenderer } from "./damage-card-renderer.mjs";
import { getSpellTiming, TIMING } from "./spell-timing.mjs";
import { MagicMissilePicker } from "./magic-missile-picker.mjs";

export class SpellAutoDamage {

  constructor() {
    // Dedup tracker — identity-based WeakSet on Activity references.
    // `dnd5e.postCreateUsageMessage` can fire more than once for the same
    // cast in setups where another module re-posts the usage message
    // (Auto-Animations, custom macros, etc.). Without dedup, our handler
    // posts the damage card twice — same Activity, same target list,
    // double damage on apply. WeakSet by Activity ref catches the second
    // fire; refs go out of scope when the activity is GC'd, so no leak.
    this._handledActivities = new WeakSet();
    this._registerHooks();
  }

  _registerHooks() {
    // ── KILL SWITCH: setting `spellAutoDamageEnabled` (default true) ──
    // When OFF, our pipeline doesn't intercept anything. dnd5e handles
    // auto-hit damage spells natively. Use this if our suppression
    // misbehaves and you need a clean fallback at the table.
    if (QolSettings.get?.("spellAutoDamageEnabled") === false) {
      console.log(`${MODULE_ID} | SpellAutoDamage DISABLED via setting — dnd5e handles auto-damage spells natively`);
      return;
    }

    // ── Mark cast active EARLY (preUseActivity) so the rollDamage
    //    prototype patch knows to suppress the dialog + chat card.
    Hooks.on("dnd5e.preUseActivity", (activity, usageConfig) => {
      if (!SpellAutoDamage._isAutoHitDamageSpell(activity)) return;
      const actor = activity?.item?.actor;
      const itemId = activity?.item?.id;
      if (!actor) return;
      SpellAutoDamage._markActiveCast(actor.id, itemId);

      // Capture cast level (slot level used) for upcast handling.
      // Magic Missile at level 3 = 5 darts; Bless at level 3 = 1 extra target.
      // dnd5e's usageConfig has spell.level when upcast.
      const castLevel = usageConfig?.spell?.level
                     ?? activity?.item?.system?.level
                     ?? 1;
      SpellAutoDamage._castLevels.set(
        SpellAutoDamage._key(actor.id, itemId),
        castLevel
      );

      // ── Clear stale targets BEFORE AA's cast-time hook fires ─────────
      // Magic Missile (and any other picker-owned spell) re-picks targets
      // via its own UI. Without clearing first, AA's cast-time hook sees
      // last cast's targets and animates against the wrong creatures
      // BEFORE the picker even opens. Clear so AA fires empty at cast
      // time; the resolver re-sets targets AFTER the picker confirms.
      try {
        if (SpellAutoDamage._isMagicMissile(activity)) {
          SpellAutoDamage._clearUserTargets();
        }
      } catch (err) {
        console.warn(`${MODULE_ID} | preUseActivity target-clear failed (non-fatal):`, err);
      }

      // Auto-clear after 5s — covers slot dialog wait + cast finalize.
      setTimeout(() => {
        SpellAutoDamage._unmarkActiveCast(actor.id, itemId);
        SpellAutoDamage._castLevels.delete(SpellAutoDamage._key(actor.id, itemId));
      }, 5000);
    });

    // ── Re-capture cast level AFTER the slot dialog confirms ─────────
    // preUseActivity above runs BEFORE the activation dialog, so its
    // usageConfig.spell.level is still the default (= item base level).
    // dnd5e.useActivity fires AFTER the user picks a slot. Overwrite
    // the cached cast level with the real upcast level so Magic Missile
    // at slot 5 → 7 darts, not 3.
    Hooks.on("dnd5e.useActivity", (activity, usageConfig) => {
      if (!SpellAutoDamage._isAutoHitDamageSpell(activity)) return;
      const actor = activity?.item?.actor;
      const itemId = activity?.item?.id;
      if (!actor) return;
      const resolvedLevel = Number(
        usageConfig?.spell?.level
        ?? activity?.usage?.spellLevel
        ?? activity?.item?.system?.level
        ?? 1
      );
      SpellAutoDamage._castLevels.set(
        SpellAutoDamage._key(actor.id, itemId),
        resolvedLevel
      );
      if (SpellAutoDamage._isMagicMissile(activity)) {
        console.log(`${MODULE_ID} | Magic Missile: cast level resolved to ${resolvedLevel} via useActivity`);
      }
    });

    // ── Post our damage card AFTER cast is confirmed ──
    // dnd5e has consumed the slot, posted the usage card, fired its
    // cast-time hooks (AA's animation triggers from those). Now we
    // post our damage card.
    Hooks.on("dnd5e.postCreateUsageMessage", (activity, message) => {
      if (!SpellAutoDamage._isAutoHitDamageSpell(activity)) return;
      const actor = activity?.item?.actor;
      if (!actor) return;
      // Dedup: same Activity ref → already handled this fire of the hook
      if (activity && this._handledActivities.has(activity)) {
        console.log(`${MODULE_ID} | SpellAutoDamage: duplicate postCreateUsageMessage for ${activity.item?.name} — skipped`);
        return;
      }
      if (activity) this._handledActivities.add(activity);
      this._handleDamageSpell(activity, null, message)
        .catch(err => console.error(`${MODULE_ID} | SpellAutoDamage handler threw:`, err));
    });

    // ── Suppress dnd5e's damage flow via prototype patch ──
    // dnd5e 5.3.1 has NO preRollDamage hook (only post-roll
    // rollDamage / rollDamageV2). The damage dialog is opened inside
    // activity.rollDamage(). To stop both the dialog AND the
    // resulting chat card, we wrap rollDamage on the damage-activity
    // prototype: if our marker is active, return [] (empty rolls,
    // no dialog, no chat). Otherwise call the original.
    SpellAutoDamage._patchActivityRollDamage();

    // Belt-and-suspenders: chat-message suppressor for any path that
    // bypasses our prototype patch (custom activity subclasses, etc.)
    Hooks.on("preCreateChatMessage", (msg, data) => {
      if (!data?.flags?.dnd5e?.activity) return;
      const flagActorId = data.flags.dnd5e.activity?.actor;
      const flagItemId  = data.flags.dnd5e.activity?.item;
      if (!flagActorId) return;
      if (!SpellAutoDamage._isCastActive(flagActorId, flagItemId)) return;

      const isDamageRoll = (data.rolls?.length ?? 0) > 0
        && (data.flags.dnd5e.roll?.type === "damage"
            || data.flags.dnd5e.activity?.type === "damage");
      if (!isDamageRoll) return;
      return false;
    });

    // ── v0.7.17b — Suppress dnd5e's vanilla "Consume Resource" activation
    //    card for spells our pipeline owns. The user is mid-spell — the
    //    "spell description + Consume Resource button" card is noise.
    //    Currently only Magic Missile is pipeline-owned; this list will
    //    grow as the unified spell pipeline (SPELL_PIPELINE_ARCHITECTURE.md)
    //    is built out.
    Hooks.on("preCreateChatMessage", (msg, data) => {
      try {
        // Vanilla activation cards have flags.dnd5e.activity AND no rolls.
        // Don't gate on system.spellLevel — it isn't always populated at
        // preCreateChatMessage time for the activation card path.
        const activityFlag = data?.flags?.dnd5e?.activity;
        if (!activityFlag) return;
        const hasRolls = (data.rolls?.length ?? 0) > 0;
        if (hasRolls) return; // damage roll card — that's our card, not vanilla

        const flagActorId = activityFlag.actor;
        const flagItemId  = activityFlag.item;
        if (!flagActorId || !flagItemId) return;
        const actor = game.actors.get(flagActorId);
        const item  = actor?.items?.get(flagItemId);
        if (!item || item.type !== "spell") return;

        // Pipeline-owned spell list. Expand as new shapes ship.
        const name = String(item.name ?? "").trim().toLowerCase();
        // v0.7.20 Phase 2.5: only suppress for shapes where the pipeline
        // actually posts its OWN enriched chat card. Shapes that delegate to
        // existing engines (template-save, template-trigger, aura, chained)
        // need dnd5e's activation card to remain so the existing engines
        // (save-engine, spell-auras, concentration-widget) can pick it up.
        const pipeline = globalThis.game?.aceQol?.SpellPipeline;
        if (!pipeline?.ownsSpell?.(item)) return;
        const entry = pipeline._getEntry?.(item);
        const PIPELINE_POSTS_OWN_CARD = new Set([
          "distribute", "self", "multi-buff", "multi-heal", "touch", "save-single",
        ]);
        if (!PIPELINE_POSTS_OWN_CARD.has(entry?.shape)) return;

        console.log(`${MODULE_ID} | Suppressing vanilla activation card for "${item.name}" (pipeline owns the cast)`);
        return false; // cancel message creation
      } catch (err) {
        console.warn(`${MODULE_ID} | activation-card suppressor failed (non-fatal):`, err);
      }
    });

    console.debug(`${MODULE_ID} | Spell auto-damage pipeline online (prototype patch active)`);
  }

  /**
   * Monkey-patch CONFIG.DND5E.activityTypes.damage.documentClass.prototype.rollDamage
   * so we can intercept damage activity rolls without canceling the cast.
   *
   * Called once during init. Idempotent — checks for prior patch via flag.
   * Wrap in try/catch — if dnd5e changes the prototype shape, fail-open
   * (vanilla flow continues, our card just shows "Roll Damage" without
   * suppression and the user gets the double-prompt they're trying to
   * avoid; minor regression, no crash).
   */
  static _patchActivityRollDamage() {
    try {
      const damageActivityClass = CONFIG.DND5E?.activityTypes?.damage?.documentClass;
      if (!damageActivityClass?.prototype) return;
      if (damageActivityClass.prototype._aceQolRollDamagePatched) return;

      const original = damageActivityClass.prototype.rollDamage;
      damageActivityClass.prototype.rollDamage = async function (...args) {
        try {
          // Widget-owned spells — concentration-widget applies the damage
          // per its own trigger (entry / start-of-turn / movement). The
          // dnd5e damage activity should NEVER fire its own dialog or
          // chat card. Suppress unconditionally so the popup never
          // appears, even if the GM clicks the spell card's DAMAGE
          // button by habit.
          try {
            const item = this?.item;
            if (item) {
              const timing = getSpellTiming(item);
              const fam = timing?.family;
              const isWidgetOwned = timing?.timing === TIMING.NO_SAVE_AUTO
                                 || fam === "areaDenialAuto"
                                 || fam === "areaDenial";
              if (isWidgetOwned) {
                console.log(`${MODULE_ID} | rollDamage suppressed for ${item.name} (widget-owned: ${fam ?? "NO_SAVE_AUTO"})`);
                return [];
              }
            }
          } catch (_) { /* fall through to active-cast check */ }

          const actorId = this?.actor?.id ?? this?.item?.actor?.id;
          const itemId  = this?.item?.id;
          if (actorId && SpellAutoDamage._isCastActive(actorId, itemId)) {
            console.log(`${MODULE_ID} | rollDamage suppressed for ${this?.item?.name} (ace-qol owns this cast)`);
            return []; // skip dialog + chat creation
          }
        } catch (_) { /* fall through to original */ }
        return original.apply(this, args);
      };
      damageActivityClass.prototype._aceQolRollDamagePatched = true;
      console.log(`${MODULE_ID} | activity.rollDamage prototype patch applied`);
    } catch (err) {
      console.warn(`${MODULE_ID} | activity.rollDamage patch failed (non-fatal — vanilla flow will run):`, err);
    }
  }

  /**
   * Detect whether this activity is an AUTO-HIT, NO-SAVE damage spell.
   * Returns true ONLY when:
   *   - The parent item is a spell (item.type === "spell")
   *   - The activity type is "damage" (not "attack", "save", "heal", "summon")
   *   - The activity has no attack roll definition
   *   - The activity has no save definition
   */
  static _isAutoHitDamageSpell(activity) {
    try {
      if (!activity) return false;
      const item = activity.item;
      if (!item || item.type !== "spell") return false;

      // ── v0.7.18: pipeline takes precedence over the auto-damage fork ──
      // If the unified spell pipeline owns this spell (via SPELL_REGISTRY),
      // skip auto-damage entirely — pipeline.mjs will dispatch it via the
      // shape resolver. Without this guard, BOTH systems would fire for
      // Magic Missile and the player would see two pickers.
      try {
        // Static import would create a circular dep at module-load time;
        // resolve lazily via the global registered on game.aceQol.
        const pipeline = globalThis.game?.aceQol?.SpellPipeline;
        if (pipeline?.ownsSpell?.(item)) return false;
      } catch (_) { /* if pipeline isn't registered yet, fall through */ }

      // ── Magic Missile special case (v0.7.17b — 2026-06-07) ─────────
      // dnd5e 5.x stores Magic Missile as a "utility" activity type,
      // not "damage". Our standard filter below would reject utility
      // activities and the picker would never open. Allow Magic Missile
      // through regardless of activity type — _handleDamageSpell has a
      // Magic Missile fork that uses _getMagicMissileBase (with safe
      // fallback to 1d4+1 force), so we don't need damage parts on the
      // activity object itself.
      //
      // NOTE: With v0.7.18's pipeline-precedence guard above, this branch
      // is only the fallback for setups where the pipeline isn't loaded
      // or Magic Missile isn't registered. In normal v0.7.18+ flow,
      // Magic Missile is owned by the pipeline and this branch doesn't fire.
      if (SpellAutoDamage._isMagicMissile(activity)) {
        return true;
      }
      // ───────────────────────────────────────────────────────────────

      const type = activity.type ?? activity.constructor?.metadata?.type ?? "";
      if (type !== "damage") return false;

      // Defensive — if the activity has an attack or save block, it's not auto-hit
      if (activity.attack?.ability) return false;
      if (activity.save?.ability) return false;

      // Must have actual damage parts
      const parts = activity.damage?.parts ?? [];
      if (!parts.length) return false;

      return true;
    } catch (err) {
      console.warn(`${MODULE_ID} | _isAutoHitDamageSpell check failed:`, err);
      return false;
    }
  }

  /**
   * Detect Magic Missile (or homebrew variant matching by name).
   * RAW: 3 darts at L1, +1 per slot level above 1st. Each dart auto-hits a
   * creature of the caster's choice within range, dealing 1d4+1 force damage.
   * Player distributes darts across any number of visible targets.
   *
   * Match strategy:
   *   - Item must be an auto-hit damage spell (already filtered upstream)
   *   - Name must match "Magic Missile" (case-insensitive, trim)
   *
   * Homebrew variants with the same name still trigger — we use the spell's
   * own damage formula and type, so a "fire darts" reskin works correctly.
   */
  static _isMagicMissile(activity) {
    try {
      const item = activity?.item;
      if (!item) return false;
      const name = String(item.name ?? "").trim().toLowerCase();
      return name === "magic missile";
    } catch (_) {
      return false;
    }
  }

  /**
   * Pull the per-dart damage formula and type from the spell item.
   * Magic Missile RAW is "1d4+1 force" per dart. Homebrew variants may
   * differ — we read the FIRST damage part and use it as the per-dart base.
   *
   * Returns { perDartFormula: string, type: string } — e.g. { "1d4 + 1", "force" }.
   * Returns null if the spell has no parseable damage part.
   */
  static _getMagicMissileBase(activity) {
    try {
      const parts = activity?.damage?.parts ?? [];
      if (!parts.length) return null;
      const first = parts[0];

      // dnd5e 5.x object-shape damage parts
      let formula = "1d4 + 1";
      let type = "force";

      if (typeof first === "object" && first !== null) {
        // Try the standard shape
        if (first.custom?.enabled && first.custom?.formula) {
          formula = first.custom.formula;
        } else if (first.bonus || first.number || first.denomination) {
          // Construct from structured fields: e.g. {number: 1, denomination: 4, bonus: "1"}
          const num = Number(first.number ?? 1);
          const den = Number(first.denomination ?? 4);
          const bonus = String(first.bonus ?? "1").trim();
          formula = `${num}d${den}${bonus ? ` + ${bonus}` : ""}`;
        }
        // Type can be Set, Array, or scalar
        const t = first.types ?? first.type;
        if (t instanceof Set) type = [...t][0] ?? "force";
        else if (Array.isArray(t)) type = t[0] ?? "force";
        else if (typeof t === "string") type = t;
      } else if (Array.isArray(first)) {
        // Legacy [formula, type] tuple
        formula = String(first[0] ?? "1d4 + 1");
        type = String(first[1] ?? "force");
      }

      return { perDartFormula: formula, type };
    } catch (err) {
      console.warn(`${MODULE_ID} | _getMagicMissileBase parse failed:`, err);
      return { perDartFormula: "1d4 + 1", type: "force" };
    }
  }

  /**
   * Build the damage formula for N darts.
   *   - If "Roll each dart separately" setting is ON:
   *       returns "(1d4+1) + (1d4+1) + (1d4+1)" — N grouped rolls
   *   - Otherwise (default — combined):
   *       returns "3d4 + 3" — single multi-die roll, mathematically
   *       equivalent expected value, faster, less variance.
   */
  static _formulaForDarts(perDartFormula, darts) {
    const rollPerDart = QolSettings.get?.("magicMissilePerDartRoll") === true;
    if (rollPerDart) {
      return Array.from({ length: darts }, () => `(${perDartFormula})`).join(" + ");
    }
    // Combined: try to multiply N*X + N*Y from a "XdY + Z" shape
    // Parse "1d4 + 1" → multiply die count and bonus by N
    const m = String(perDartFormula).match(/^\s*(\d+)d(\d+)\s*(?:([+\-])\s*(\d+))?\s*$/);
    if (m) {
      const baseDice = parseInt(m[1], 10);
      const die = parseInt(m[2], 10);
      const sign = m[3] || "+";
      const bonus = m[4] ? parseInt(m[4], 10) : 0;
      const totalDice = baseDice * darts;
      const totalBonus = bonus * darts;
      if (totalBonus === 0) return `${totalDice}d${die}`;
      return `${totalDice}d${die} ${sign} ${totalBonus}`;
    }
    // Unparseable shape — fall back to grouped sum (still works, just verbose)
    return Array.from({ length: darts }, () => `(${perDartFormula})`).join(" + ");
  }

  /**
   * Clear all of game.user.targets via per-Token setTarget(false).
   * Used:
   *   1) BEFORE picker opens — so AA's cast-time hook can't fire on
   *      stale targets from a previous cast
   *   2) AFTER resolver completes — so the game state is clean and
   *      the player's next action (attack, save, etc.) starts fresh
   *
   * Foundry V13: the old game.user.updateTokenTargets() helper is gone;
   * use Token#setTarget per token. Safe / non-fatal on errors.
   */
  static _clearUserTargets() {
    try {
      const targets = Array.from(game.user.targets ?? []);
      if (targets.length === 0) return;
      for (const tok of targets) {
        try {
          tok.setTarget(false, { user: game.user, releaseOthers: false, groupSelection: false });
        } catch (_) { /* per-token failure is non-fatal */ }
      }
    } catch (err) {
      console.warn(`${MODULE_ID} | _clearUserTargets failed (non-fatal):`, err);
    }
  }

  // ── Active-cast tracker (used to suppress vanilla damage cards) ──
  // Static map so any chat-message hook fired anywhere in the system can
  // check "is this damage card from a spell I'm currently handling?".
  static _activeCasts = new Map();
  // ── Cast-level tracker (used for upcast-aware dart count, etc.) ──
  // Populated in preUseActivity, drained in _handleDamageSpell, cleaned up
  // by the same auto-clear timer that handles _activeCasts.
  static _castLevels = new Map();
  static _key(actorId, itemId) { return `${actorId ?? ""}|${itemId ?? ""}`; }
  static _markActiveCast(actorId, itemId) { SpellAutoDamage._activeCasts.set(SpellAutoDamage._key(actorId, itemId), Date.now()); }
  static _unmarkActiveCast(actorId, itemId) { SpellAutoDamage._activeCasts.delete(SpellAutoDamage._key(actorId, itemId)); }
  static _isCastActive(actorId, itemId) {
    const ts = SpellAutoDamage._activeCasts.get(SpellAutoDamage._key(actorId, itemId));
    if (!ts) return false;
    // Stale-entry sweep
    if (Date.now() - ts > 10000) {
      SpellAutoDamage._activeCasts.delete(SpellAutoDamage._key(actorId, itemId));
      return false;
    }
    return true;
  }

  /**
   * Run the spell damage pipeline:
   *   1. Collect targets (user.targets, fall back to single-target dialog).
   *   2. Build synthetic hits[] (no attack roll, hitResult: "hit").
   *   3. Route through DamageCardRenderer.postDamageButton so all the
   *      existing damage card UX (apply/undo, override, per-type clicks,
   *      post-hit saves, riders) works.
   */
  async _handleDamageSpell(activity, usageConfig, message = null) {
    const item  = activity.item;
    const actor = item?.actor;
    if (!actor) return;

    // ── v0.7.17b — Wait for any in-flight reaction (Counterspell) to ──
    // resolve before doing anything. If the user counterspells, bail.
    // The barrier was created in reaction-engine's preUseActivity hook.
    // If no barrier exists (cantrip, non-spell, etc.), this returns
    // { abort: false } immediately and we proceed normally.
    try {
      const { ReactionEngine } = await import("./reaction-engine.mjs");
      const reactionResult = await ReactionEngine.awaitCastBarrier(activity);
      if (reactionResult.abort) {
        console.log(`${MODULE_ID} | SpellAutoDamage: aborting ${item.name} — ${reactionResult.reason}${reactionResult.counterspeller ? ` (by ${reactionResult.counterspeller})` : ""}`);
        SpellAutoDamage._unmarkActiveCast(actor.id, item?.id);
        return;
      }
    } catch (err) {
      // Non-fatal: if the barrier check itself fails, fall through to
      // normal cast handling. Worst case: cast proceeds even if user
      // attempted counterspell. Log so we can diagnose.
      console.warn(`${MODULE_ID} | SpellAutoDamage: reaction barrier check failed (non-fatal, falling through):`, err);
    }

    // Spells whose damage application is owned by concentration-widget — we
    // must NOT defer to vanilla dnd5e here, otherwise the damage roll dialog
    // pops up at cast time (the "4d4 slashing" popup the user has to
    // dismiss every cast). Keep the active-cast mark in place so the
    // rollDamage prototype patch silently suppresses the dialog + chat card.
    //
    // Covers:
    //   - NO_SAVE_AUTO (Spike Growth, Wall of Thorns): per-5ft movement damage
    //   - areaDenialAuto (Cloud of Daggers): per-entry / per-start-of-turn damage
    //   - areaDenial    (Stinking Cloud, Cloudkill, etc): handled via save flow,
    //                    no cast-time damage roll
    try {
      const timing = getSpellTiming(item);
      const fam = timing?.family;
      const isWidgetOwned = timing?.timing === TIMING.NO_SAVE_AUTO
                         || fam === "areaDenialAuto"
                         || fam === "areaDenial";
      if (isWidgetOwned) {
        console.log(`${MODULE_ID} | SpellAutoDamage: ${item.name} is widget-owned (${fam ?? "NO_SAVE_AUTO"}) — suppressing dnd5e damage flow (concentration-widget applies damage per trigger)`);
        return; // leave mark active; rollDamage prototype patch returns [] silently
      }
    } catch (err) {
      console.warn(`${MODULE_ID} | SpellAutoDamage: widget-owned check failed`, err);
    }

    // ── Magic Missile fork ───────────────────────────────────────────
    // Magic Missile distributes N darts (3 + upcast levels) across one or
    // more visible targets. Open the MagicMissilePicker for assignment,
    // then build per-target synthetic hits with damage = dartCount × base.
    if (SpellAutoDamage._isMagicMissile(activity)) {
      // Cast level resolution chain — VERIFIED against dnd5e 5.x source
      // (dnd5e.mjs:17131-17133): the system stamps the slot level at
      // `message.system.spellLevel`. The save-engine path
      // `message.flags.dnd5e.use.spellLevel` is NOT populated for spell
      // usage messages — that's a different stamp used for enchantment.
      // Fall through to a few other paths if the canonical one ever changes.
      const messageSystemLevel = message?.system?.spellLevel;
      const messageFlagLevel = message?.flags?.dnd5e?.use?.spellLevel
                            ?? message?.flags?.dnd5e?.use?.level;
      const cachedLevel = SpellAutoDamage._castLevels.get(SpellAutoDamage._key(actor.id, item?.id));
      const activityLevel = activity?.usage?.spellLevel ?? activity?.usage?.value;
      let consumeLevel = null;
      try {
        const slotKey = activity?.consumption?.spellSlot ?? activity?.usage?.consume?.spellSlot;
        if (typeof slotKey === "string") {
          const m = slotKey.match(/^spell(\d+)$/);
          if (m) consumeLevel = parseInt(m[1], 10);
        }
      } catch (_) { /* non-fatal */ }
      const castLevel = Number(
        messageSystemLevel
        ?? messageFlagLevel
        ?? cachedLevel
        ?? activityLevel
        ?? consumeLevel
        ?? item?.system?.level
        ?? 1
      );
      const dartCount = 3 + Math.max(0, castLevel - 1);

      console.log(`${MODULE_ID} | Magic Missile cast-level sources — msg.system:${messageSystemLevel} msg.flag:${messageFlagLevel} cached:${cachedLevel} activity:${activityLevel} consume:${consumeLevel} base:${item?.system?.level} → resolved:${castLevel} → ${dartCount} darts`);

      const base = SpellAutoDamage._getMagicMissileBase(activity)
                ?? { perDartFormula: "1d4 + 1", type: "force" };

      console.log(`${MODULE_ID} | Magic Missile: ${dartCount} darts (cast level ${castLevel}, per-dart ${base.perDartFormula} ${base.type})`);

      let distribution = await MagicMissilePicker.pick({
        spellItem:   item,
        casterActor: actor,
        dartCount,
        rangeFt:     120,
      });

      if (!distribution || distribution.size === 0) {
        // Cancelled / no targets assigned — abort the spell entirely.
        // The spell slot was already consumed by dnd5e during the cast
        // dialog confirmation. We can't refund automatically (dnd5e has
        // no undo hook for slot consumption), so warn the player.
        SpellAutoDamage._unmarkActiveCast(actor.id, item?.id);
        ui.notifications?.info(
          `${item.name}: cancelled. Spell slot was already consumed — restore it manually if you didn't mean to cast.`
        );
        console.log(`${MODULE_ID} | Magic Missile: picker cancelled — no damage card posted (slot consumed)`);
        return;
      }

      // ── RAW: Shield negates Magic Missile entirely ──
      // Shield's PHB text (2014+2024): "you take no damage from magic missile."
      // For each target with Shield available + reaction unspent + slot, prompt
      // them. Accepting nullifies ALL their darts (no AC math — total immunity).
      // Targets who shield are removed from the distribution before damage rolls.
      try {
        const reactionEng = game.aceQol?.reactionEngine;
        if (reactionEng?.checkMagicMissileShield) {
          distribution = await reactionEng.checkMagicMissileShield(distribution, actor, item);
          if (!distribution || distribution.size === 0) {
            // Every target shielded — abort the damage card.
            SpellAutoDamage._unmarkActiveCast(actor.id, item?.id);
            ui.notifications?.info(`${item.name}: all targets cast Shield — no damage applied.`);
            console.log(`${MODULE_ID} | Magic Missile: all targets shielded — damage card aborted`);
            return;
          }
        }
      } catch (err) {
        console.warn(`${MODULE_ID} | Magic Missile Shield check failed (non-blocking):`, err);
      }

      const mmHits = [];
      let firstHit = true;
      for (const [targetActor, darts] of distribution.entries()) {
        if (!targetActor || darts <= 0) continue;
        const token = targetActor.getActiveTokens?.()?.[0]
                   ?? canvas.tokens?.placeables.find(t => t.actor?.id === targetActor.id)
                   ?? null;
        if (!token) continue;
        const formula = SpellAutoDamage._formulaForDarts(base.perDartFormula, darts);
        mmHits.push({
          target: {
            name:      token.name ?? targetActor.name,
            img:       targetActor.img ?? token.document?.texture?.src,
            currentHP: targetActor.system?.attributes?.hp?.value ?? 0,
            maxHP:     targetActor.system?.attributes?.hp?.max ?? 0,
          },
          targetActor: targetActor,
          targetToken: token,
          hitResult:   "hit",
          d20Result:   null,
          isCritRoll:  false,
          damageModifiers: DamageCalculator.getTargetDamageModifiers(targetActor, item),
          name: token.name ?? targetActor.name,
          img:  targetActor.img ?? token.document?.texture?.src,
          ac:   targetActor.system?.attributes?.ac?.value ?? 0,
          // ── The Magic Missile override the DamageCalculator looks for ──
          magicMissileOverride: {
            formula,
            type:   base.type,
            darts,
          },
          // Empowered Evocation (Wizard Evocation 10+) RAW: "one damage
          // roll of any wizard evocation spell." Apply to the FIRST target
          // only — a deterministic choice. If the player wants EE on a
          // different target, the override widget in the damage card lets
          // them manually rearrange.
          applyEmpoweredEvocation: firstHit,
        });
        firstHit = false;
      }

      if (!mmHits.length) {
        SpellAutoDamage._unmarkActiveCast(actor.id, item?.id);
        console.warn(`${MODULE_ID} | Magic Missile: picker returned distribution but no tokens resolved — aborted`);
        return;
      }

      // ── Trigger Automated Animations (post-picker) ───────────────────
      // AA fires at cast time (preUseActivity), but at that moment the
      // player hasn't picked targets yet, so the trajectory animation
      // can't render. Re-trigger AA now that the dart distribution is
      // known. Uses AA's public API: window.AutomatedAnimations.playAnimation
      // (sourceToken, item, options). AA reads targets from game.user.targets.
      // Honors the user's AA color/sound/scale config for Magic Missile.
      try {
        const aa = globalThis.AutomatedAnimations ?? window.AutomatedAnimations;
        if (aa?.playAnimation) {
          const casterToken =
            actor.getActiveTokens?.()?.[0] ??
            canvas.tokens?.placeables.find(t => t.actor?.id === actor.id) ??
            null;
          const targetTokens = mmHits
            .map(h => h.targetToken)
            .filter(Boolean);
          if (casterToken && targetTokens.length > 0) {
            // Foundry V13: use per-Token setTarget. The old
            // game.user.updateTokenTargets() helper was removed.
            // 1) release current targets that aren't in our new set
            const newIds = new Set(targetTokens.map(t => t.id));
            for (const prev of Array.from(game.user.targets ?? [])) {
              if (!newIds.has(prev.id)) {
                prev.setTarget(false, { user: game.user, releaseOthers: false, groupSelection: false });
              }
            }
            // 2) target the new set (additive — AA reads game.user.targets)
            for (const t of targetTokens) {
              t.setTarget(true, { user: game.user, releaseOthers: false, groupSelection: false });
            }
            aa.playAnimation(casterToken, item);
            console.log(`${MODULE_ID} | Magic Missile: triggered AA animation (${targetTokens.length} targets)`);
          } else {
            console.warn(`${MODULE_ID} | Magic Missile: AA skipped — no caster token or no targets`);
          }
        }
      } catch (err) {
        console.warn(`${MODULE_ID} | Magic Missile AA trigger failed (non-fatal):`, err);
      }
      // ─────────────────────────────────────────────────────────────────

      console.log(`${MODULE_ID} | Magic Missile: routing ${mmHits.length} target(s) with custom dart distribution`);
      try {
        await DamageCardRenderer.postDamageButton(item, actor, mmHits);
      } catch (err) {
        console.error(`${MODULE_ID} | Magic Missile postDamageButton failed:`, err);
        SpellAutoDamage._unmarkActiveCast(actor.id, item?.id);
      }

      // ── Clear targets after damage card posts ────────────────────────
      // Now that the spell is fully resolved, leave game.user.targets
      // empty so the player's NEXT action (sword swing, save throw, etc.)
      // doesn't accidentally still target the creatures we just hit with
      // Magic Missile. Mirror this pattern in all future picker-owned
      // spells via the unified pipeline (per SPELL_PIPELINE_ARCHITECTURE.md).
      // Small delay so the AA trajectory animation has time to read targets
      // before they vanish.
      setTimeout(() => SpellAutoDamage._clearUserTargets(), 1500);

      return;
    }
    // ── /Magic Missile fork ──────────────────────────────────────────

    const targets = [...(game.user.targets ?? [])];
    if (!targets.length) {
      // No targets — let vanilla flow proceed (dnd5e may prompt the user to
      // pick a target). We unmark so the suppressor doesn't block the
      // resulting damage card.
      SpellAutoDamage._unmarkActiveCast(actor.id, item?.id);
      console.log(`${MODULE_ID} | SpellAutoDamage: ${item.name} cast with no targets — deferring to vanilla flow`);
      return;
    }

    // Build synthetic hits — every targeted token takes the full damage
    // (auto-hit, no roll). Each gets per-target resistance/immunity applied.
    const hits = targets.map(token => {
      const tActor = token.actor;
      return {
        target:        { name: token.name, img: token.actor?.img ?? token.document?.texture?.src, currentHP: tActor?.system?.attributes?.hp?.value ?? 0, maxHP: tActor?.system?.attributes?.hp?.max ?? 0 },
        targetActor:   tActor,
        targetToken:   token,
        hitResult:     "hit",
        d20Result:     null,                // auto-hit — no attack roll
        isCritRoll:    false,
        damageModifiers: tActor ? DamageCalculator.getTargetDamageModifiers(tActor, item) : {},
        // Standard token info for the renderer
        name:          token.name,
        img:           token.actor?.img ?? token.document?.texture?.src,
        ac:            tActor?.system?.attributes?.ac?.value ?? 0,
      };
    });

    console.log(`${MODULE_ID} | SpellAutoDamage: routing ${item.name} → ${hits.length} target(s)`);

    // Route through the existing damage card pipeline — gives us the
    // ROLL DAMAGE button + per-target apply/undo/override widgets for free.
    try {
      await DamageCardRenderer.postDamageButton(item, actor, hits);
    } catch (err) {
      console.error(`${MODULE_ID} | SpellAutoDamage postDamageButton failed:`, err);
      // On crash, unmark so the user isn't stuck without a damage card
      SpellAutoDamage._unmarkActiveCast(actor.id, item?.id);
    }
  }
}
