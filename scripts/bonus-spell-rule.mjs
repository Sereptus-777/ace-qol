// ─── ACE: QOL — Bonus Action Spell Rule (RAW) ────────────────────────────────
// PHB 202 (and SRD): "A spell cast with a bonus action is especially swift.
// You must use a bonus action on your turn to cast the spell, provided that
// you haven't already taken a bonus action this turn. You can't cast another
// spell during the same turn, except for a cantrip with a casting time of
// 1 action."
//
// SHIPPING:
//   1. Track spells cast per actor per turn (transient, cleared on turn end)
//   2. Pre-flight check via dnd5e.preUseActivity:
//      - If casting a LEVELED bonus-action spell, and ANY other spell was cast
//        this turn → BLOCK with "Bonus action spell rule" toast
//      - If casting ANY leveled spell after a bonus-action spell was cast this
//        turn → BLOCK
//      - Cantrips with 1-action casting time are always allowed (the RAW
//        carve-out) but only AFTER a bonus action leveled spell — they don't
//        consume the bonus action slot
//   3. Setting `bonusActionSpellRule` (default true): master enable
//   4. Setting `bonusActionSpellStrict` (default true): when off, only warns
//      via toast and does NOT block (table-style override)
//
// CONFIGURATION:
//   - World setting `bonusActionSpellRule` (Boolean, default true)
//   - World setting `bonusActionSpellStrict` (Boolean, default true)
//
// IMPLEMENTATION DETAILS:
//   - State key: `actor.flags.ace-qol.bonusSpellTurn` = combat round.turn key
//     reset whenever round.turn changes (handled in updateCombat hook)
//   - State value: { castCount: number, hadBonusActionLeveled: boolean }
// ──────────────────────────────────────────────────────────────────────────────

import { MODULE_ID } from "./ace-qol.mjs";
import { QolSettings } from "./settings.mjs";

const FLAG_NS  = "ace-qol";
const FLAG_KEY = "bonusSpellTurn";

export class BonusSpellRule {

  static init() {
    Hooks.on("dnd5e.preUseActivity", (activity, usageConfig /*, dialogConfig, messageConfig */) => {
      try {
        if (!QolSettings.get?.("bonusActionSpellRule")) return;
        const item = activity?.item;
        if (!item || item.type !== "spell") return;
        const actor = activity?.actor ?? item?.actor;
        if (!actor) return;

        const allowed = BonusSpellRule._evaluate(actor, activity, item);
        if (allowed.ok) {
          // Permitted — record the cast so subsequent casts on this turn
          // can be evaluated against it.
          BonusSpellRule._recordCast(actor, activity, item);
          return;
        }

        // Not allowed — surface to the GM and (if strict) block the cast.
        const strict = QolSettings.get?.("bonusActionSpellStrict") !== false;
        if (strict) {
          ui.notifications?.error(`Bonus Action Spell Rule: ${allowed.reason}`);
          return false; // sync-cancels the activity
        } else {
          ui.notifications?.warn(`(Allowed by table style) Bonus Action Spell Rule: ${allowed.reason}`);
          BonusSpellRule._recordCast(actor, activity, item);
        }
      } catch (err) {
        console.warn(`${MODULE_ID} | BonusSpellRule check threw — fail-open:`, err);
      }
    });

    // Reset per-turn state at end of each combatant's turn
    Hooks.on("combatTurnChange", (combat /*, prior, current */) => {
      try {
        const priorActorId = combat?.previous?.combatantId
          ? combat?.combatants?.get?.(combat.previous.combatantId)?.actorId
          : null;
        if (priorActorId) {
          const priorActor = game.actors.get(priorActorId);
          if (priorActor) priorActor.unsetFlag(FLAG_NS, FLAG_KEY).catch(() => {});
        }
      } catch (_) { /* non-fatal */ }
    });

    // Belt-and-suspenders: also clear when combat ends (out-of-combat casts
    // shouldn't accumulate state)
    Hooks.on("deleteCombat", (combat) => {
      try {
        for (const c of combat?.combatants?.contents ?? []) {
          c.actor?.unsetFlag(FLAG_NS, FLAG_KEY).catch(() => {});
        }
      } catch (_) { /* non-fatal */ }
    });

    console.debug(`${MODULE_ID} | BonusSpellRule online`);
  }

  /**
   * Returns { ok: bool, reason: string, isCantripAction: bool, isBonusLeveled: bool }
   */
  static _evaluate(actor, activity, item) {
    const isCantrip = (item.system?.level ?? 0) === 0;
    const castType  = activity?.activation?.type ?? item?.system?.activation?.type ?? "action";
    const isBonus   = castType === "bonus";
    const isAction  = castType === "action";

    const state = actor.getFlag(FLAG_NS, FLAG_KEY) ?? { castCount: 0, hadBonusActionLeveled: false };

    // Out of combat: no enforcement (turns are undefined)
    if (!game.combat || !game.combat.started) {
      return { ok: true };
    }

    // Allowed cases:
    //   - First spell of the turn → always allowed
    //   - Cantrip with 1-action cast → always allowed (RAW carve-out)
    //   - Leveled bonus-action spell as the FIRST spell of the turn → allowed
    if (state.castCount === 0) return { ok: true };
    if (isCantrip && isAction)  return { ok: true };

    // Block cases:
    //   - Already cast a bonus-action LEVELED spell, and trying to cast a
    //     LEVELED spell of any kind → BLOCK
    if (state.hadBonusActionLeveled && !isCantrip) {
      return {
        ok: false,
        reason: `${actor.name} already cast a bonus-action spell this turn. RAW only allows a cantrip (1 action) afterward — not a leveled spell.`,
      };
    }
    //   - Already cast a leveled spell (any timing), and trying to cast a
    //     LEVELED bonus-action spell → BLOCK
    if (isBonus && !isCantrip && state.castCount > 0) {
      return {
        ok: false,
        reason: `${actor.name} already cast a spell this turn. A leveled bonus-action spell cannot be cast in the same turn as another spell.`,
      };
    }
    //   - Cantrip-as-bonus is unusual — let it through unless RAW collisions
    //     above triggered. Most bonus-action cantrips (Magic Stone, Mind
    //     Sliver in some edition variants) follow the same rule, but treating
    //     them as cantrips keeps Healing Word + cantrip combos legal.

    return { ok: true };
  }

  static async _recordCast(actor, activity, item) {
    try {
      const isCantrip = (item.system?.level ?? 0) === 0;
      const castType  = activity?.activation?.type ?? item?.system?.activation?.type ?? "action";
      const isBonus   = castType === "bonus";
      const prior = actor.getFlag(FLAG_NS, FLAG_KEY) ?? { castCount: 0, hadBonusActionLeveled: false };
      await actor.setFlag(FLAG_NS, FLAG_KEY, {
        castCount: (prior.castCount ?? 0) + 1,
        hadBonusActionLeveled: prior.hadBonusActionLeveled || (isBonus && !isCantrip),
        lastSpellId: item.id,
        lastSpellName: item.name,
        lastCastType: castType,
      });
    } catch (err) {
      console.warn(`${MODULE_ID} | BonusSpellRule._recordCast failed:`, err);
    }
  }
}
