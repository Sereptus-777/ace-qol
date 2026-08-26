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
import { hasTurns } from "./action-economy.mjs";

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

        // ⚠️🔴 NO TURNS, NO ACTION ECONOMY. The whole rule is "you cannot
        // cast another levelled spell on the same TURN". Outside combat there
        // are no turns, so there is nothing to be on the same one as.
        //
        // Johnny, 2026-08-24, testing spells on Varek Thalor: "it says he's
        // already taking a turn casting the spell. Outside of combat, that
        // cannot happen... you can cast as many spells as you have ready."
        //
        // The old code only skipped RECORDING the cast out of combat and still
        // ran the check, so a stale flag from a previous fight kept refusing
        // spells with no fight anywhere in sight.
        if (!hasTurns(actor)) return;

        const allowed = BonusSpellRule._evaluate(actor, activity, item);
        if (allowed.ok) {
          // Permitted — but only record the cast if we're actually in an
          // active combat. Out-of-combat casts shouldn't leave state on
          // the actor (that flag would persist past the next combat start
          // and falsely block the actor's first bonus-action spell of the
          // new combat — exactly the v0.7.15-reported bug).
          if (game.combat?.started) {
            BonusSpellRule._recordCast(actor, activity, item);
          }
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

    // Reset per-turn state as turns change.
    //
    // ⚠️🔴 TWO BUGS LIVED HERE AND TOGETHER THEY WEDGED A CASTER SHUT.
    // Johnny, mid-session 2026-08-24: "Cyrax is trying to cast sacred flame and
    // it's saying that he already cast a spell, which he hasn't. His turn just
    // started."
    //
    // 1. WRITTEN TO ONE DOCUMENT, CLEARED ON ANOTHER. `_recordCast` sets the
    //    flag on the CASTING actor, which for an unlinked token is that token's
    //    own synthetic copy. This cleared it with `game.actors.get(actorId)`,
    //    which returns the BASE world actor — a different document. For every
    //    unlinked creature the flag was set and then never cleared, so the
    //    second spell they ever cast was refused, for ever. Same family as the
    //    two-writers fall bug (2026-08-14): the write and the clear have to
    //    address the same object or the state is immortal.
    //
    // 2. READ `combat.previous` INSTEAD OF THE ARGUMENTS THE HOOK HANDS OVER.
    //    Foundry calls combat hooks BEFORE the update lands, so state read off
    //    the combat object inside them describes the turn that is ENDING — the
    //    exact trap written up on 2026-08-07, where six listeners acted on the
    //    wrong creature. `combatTurnChange` passes `prior` and `current`
    //    precisely so nobody has to guess; this ignored both.
    //
    // ⚠️ AND IT NOW CLEARS THE CREATURE WHOSE TURN IS STARTING, not only the
    // one that just ended. Clearing on the way out depends on a clean exit from
    // every turn — a reload, a crashed round, a creature removed from the
    // tracker mid-fight, and the flag survives into their next turn. Clearing on
    // the way IN cannot be skipped, because a turn beginning is the only moment
    // the budget is definitionally empty.
    const _clearTurnState = (combatant, why) => {
      try {
        // THE COMBATANT'S OWN ACTOR — resolves an unlinked token to the copy
        // that actually holds the flag. Never `game.actors.get`.
        const actor = combatant?.actor ?? null;
        if (!actor) return;
        if (actor.getFlag?.(FLAG_NS, FLAG_KEY) === undefined) return;
        actor.unsetFlag(FLAG_NS, FLAG_KEY).catch(() => {});
        console.log(`${MODULE_ID} | bonus-action budget reset for ${actor.name} (${why}).`);
      } catch (_) { /* non-fatal — never break a turn change */ }
    };

    Hooks.on("combatTurnChange", (combat, prior, current) => {
      try {
        const priorC = prior?.combatantId ? combat?.combatants?.get?.(prior.combatantId) : null;
        const currentC = current?.combatantId ? combat?.combatants?.get?.(current.combatantId) : null;
        if (priorC) _clearTurnState(priorC, "their turn ended");
        if (currentC) _clearTurnState(currentC, "their turn began");
      } catch (_) { /* non-fatal */ }
    });

    // Combat START: wipe the flag for every combatant. This catches the case
    // where an actor cast a bonus-action spell out of combat (older versions
    // wrote state in that path) or where a fresh combat begins with stale
    // flags on its combatants from a previous combat. Without this, the
    // affected combatant's first bonus-action spell of the new combat would
    // be incorrectly blocked.
    Hooks.on("combatStart", (combat) => {
      try {
        for (const c of combat?.combatants?.contents ?? []) {
          if (c.actor?.getFlag?.(FLAG_NS, FLAG_KEY) !== undefined) {
            c.actor.unsetFlag(FLAG_NS, FLAG_KEY).catch(() => {});
          }
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

    const state = actor.getFlag(FLAG_NS, FLAG_KEY) ?? { castCount: 0, hadBonusActionLeveled: false, hadActionSpell: false };

    // Out of combat: no enforcement (turns are undefined)
    if (!game.combat || !game.combat.started) {
      return { ok: true };
    }

    // First spell of the turn → always allowed.
    if (state.castCount === 0) return { ok: true };

    // ── One Action-cast spell per turn (you have ONE Action) ──
    // Blocks a SECOND action-cast spell this turn — INCLUDING a second cantrip.
    // An action-cast spell uses your Action, and you get one Action per turn.
    // Action Surge / extra actions are the exception: turn off "strict" for
    // those turns. This is the "two cantrips in a turn" block (Johnny 2026-07-13).
    if (isAction && state.hadActionSpell) {
      return {
        ok: false,
        reason: `${actor.name} already cast a spell with their Action this turn — you only get one Action, so a second action-cast spell (even a cantrip) isn't allowed without Action Surge or similar.`,
      };
    }

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
      const isAction  = castType === "action";
      const prior = actor.getFlag(FLAG_NS, FLAG_KEY) ?? { castCount: 0, hadBonusActionLeveled: false, hadActionSpell: false };
      await actor.setFlag(FLAG_NS, FLAG_KEY, {
        castCount: (prior.castCount ?? 0) + 1,
        hadBonusActionLeveled: prior.hadBonusActionLeveled || (isBonus && !isCantrip),
        hadActionSpell: prior.hadActionSpell || isAction,
        lastSpellId: item.id,
        lastSpellName: item.name,
        lastCastType: castType,
      });
    } catch (err) {
      console.warn(`${MODULE_ID} | BonusSpellRule._recordCast failed:`, err);
    }
  }
}
