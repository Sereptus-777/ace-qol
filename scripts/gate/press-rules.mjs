// ─── ACE: QOL — THE GATE'S NAMED RULES ────────────────────────────────────────
//
// The One Road, Phase 2 (2026-09-14): "Named rules; the separate armor,
// bonus-action, holy symbol, engagement and revive hooks move in and are
// deleted; Do it anyway; the refusal notice."
//
// Each rule here is one of those old hooks, asking the question it always
// asked. What changed is who acts on the answer: a rule no longer cancels a
// press by itself. It answers the one gate (press-gate.mjs), which is the only
// place a press is refused, the only place that says why, and the only place
// the GM can overrule.
//
// A rule reads the press and answers null (nothing to say) or ONE verdict:
//   { refuse: "why, in plain words", data }   the press stops; the GM may overrule
//   { note: "..." }                           the press goes ahead, with a note
//   { ask: async () => true | false }         the press waits on a question to the
//                                             presser; true presses it again
// and any verdict may carry onAllowed(): what happens along with the press when
// it goes ahead. A verdict's `name` replaces the rule's on the card.
//
// A rule may also have:
//   onOverride(data)  run on the GM's client when the GM overrules it, with the
//                     `data` its refusal stored on the card
//   afterUse(ctx)     run on the presser's client once the press has been used
//
// ⚠️ MODULE_ID IS HARDCODED, and the rules are built on first use, not at load.
// This file is reached from the entry file, and a top-level read of a binding
// inside an import cycle throws at load and takes the whole module with it
// (2026-08-28, again 2026-09-06).
// ──────────────────────────────────────────────────────────────────────────────

import { CombatContext } from "../combat-context.mjs";
import { findUnproficientArmor } from "../armor-prof-spell-block.mjs";
import { BonusSpellRule } from "../bonus-spell-rule.mjs";
import { hasTurns } from "../action-economy.mjs";
import { EngagementGate } from "../engagement-gate.mjs";
import { HolySymbol } from "../holy-symbol.mjs";
import { revokeVorpalLock } from "../death-pipeline.mjs";
import { CardDoor } from "../road/doors.mjs";
import { STRICT_REVIVES, ORDINARY_REVIVES, revivesTheDead } from "../road/picker-rule.mjs";

const MODULE_ID = "ace-qol";
const LOG = "ace-qol | gate";

// Vorpal RAW: a creature that lost its head comes back only through True
// Resurrection or Wish. The revive names live with the picker rule
// (road/picker-rule.mjs), so this lock and the picker that offers the dead read
// the same list.

/**
 * A world setting read the way Foundry answers it. Each rule's switch is
 * registered ON by default, and an unset setting is its default.
 */
function isOn(key) {
  try { return game.settings.get(MODULE_ID, key) !== false; }
  catch (_) { return true; }
}

function esc(s) { return foundry.utils.escapeHTML(String(s ?? "")); }
function gmIds() { return (game.users?.filter?.(u => u.isGM) ?? []).map(u => u.id); }

/**
 * The target picker for a press with nobody targeted: an attack spell, or a revive,
 * which is offered the dead (killed for good included). True when someone was picked.
 */
async function pickTargets({ activity, item, actor }, { kind = "harm" } = {}) {
  const { SpellTargetPicker } = await import("../spell-target-picker.mjs");
  // ⚠️ A REVIVE TOUCHES. Revivify, Raise Dead, Resurrection, Reincarnate and True
  // Resurrection are touch spells in both editions, whatever range a sheet stores:
  // his 2024 Raise Dead stores "self", which offered nobody but the caster.
  const rangeFt = kind === "revive" ? 5 : (Number(activity?.range?.value ?? item.system?.range?.value ?? 0) || null);
  const maxTargets = kind === "revive" ? 1 : (Number(activity?.target?.affects?.count) || 1);
  const picked = await SpellTargetPicker.pick({ spellItem: item, casterActor: actor, maxTargets, rangeFt, allowSelf: false, kind });
  if (!picked?.length) {
    console.log(`${LOG} | ${item.name}: nobody was picked, so it was not cast.`);
    return false;
  }
  // V13: no bulk target operations; set each picked token by itself.
  let first = true;
  for (const a of picked) {
    const tok = a?.getActiveTokens?.()?.[0]
      ?? canvas.tokens?.placeables.find(t => t.actor?.id === a?.id)
      ?? null;
    if (!tok) continue;
    tok.setTarget(true, { user: game.user, releaseOthers: first });
    first = false;
  }
  if (first) {
    ui.notifications?.warn(`${item.name}: the creature picked has no token on this scene, so it was not cast.`);
    return false;
  }
  return true;
}

/** True Resurrection or Wish lifts the lock. Only a GM can write a token's flags. */
async function clearLocks(spell, tokens) {
  if (!game.user?.isGM) {
    // A player's client cannot write the token, so the GM gets the one-click
    // clear (the existing Vorpal override button, wired for GMs only).
    for (const t of tokens) {
      await CardDoor.post({
        whisper: gmIds(),
        content: `<div style="background:#0a1a0a;border:2px solid #4c4;border-radius:6px;padding:8px 12px;color:#c8e8c8;">
          <div style="font-size:18px;font-weight:700;color:#aaffaa;">${esc(spell)} can bring ${esc(t.name)} back</div>
          <div style="font-size:16px;margin-top:4px;">By the rules it lifts the killed-for-good lock. Clear it so the healing takes.</div>
          <div class="ace-qol-vorpal-override" style="margin-top:8px;">
            <button type="button" class="ace-qol-btn-vorpal-override" data-action="aceQolRevokeVorpal"
              data-actor-id="${esc(t.actorId)}" data-token-id="${esc(t.tokenId)}" data-scene-id="${esc(t.sceneId)}"
              style="font-size:16px;">Clear the lock on ${esc(t.name)}</button>
          </div>
        </div>`,
        flags: { [MODULE_ID]: { type: "permanentDeathStrictClearAsk" } },
      });
    }
    return;
  }
  for (const t of tokens) {
    const tokenDoc = game.scenes?.get?.(t.sceneId)?.tokens?.get?.(t.tokenId) ?? null;
    if (!tokenDoc) {
      console.warn(`${LOG} | ${spell}: could not find ${t.name}'s token to lift its lock.`);
      continue;
    }
    await tokenDoc.update({ [`flags.${MODULE_ID}.permanentlyDead`]: false });
    await CardDoor.post({
      whisper: [game.user.id],
      content: `<div style="background:#0a1a0a;border:2px solid #4c4;border-radius:6px;padding:8px 12px;color:#c8e8c8;">
        <div style="font-size:18px;font-weight:700;color:#aaffaa;">Killed-for-good lock cleared</div>
        <div style="font-size:16px;margin-top:4px;">${esc(spell)} lifts it by the rules. ${esc(t.name)} can be revived by healing now.</div>
      </div>`,
      flags: { [MODULE_ID]: { type: "permanentDeathStrictClear" } },
    });
  }
}

let _rules = null;

/** The gate's rules, in the order the refusal card lists them. */
export function pressRules() {
  return (_rules ??= Object.freeze([

    // ── Cannot act (was combat-context's hook) ──
    // A weapon is judged inside the attack pipeline by the same canAct.
    {
      id: "cannot-act",
      name: "Cannot act",
      test({ item, actor, activity }) {
        if (!item || !actor || item.type === "weapon") return null;
        const verdict = CombatContext.canAct(actor, {
          isSpell: item.type === "spell",
          item,
          activationType: activity?.activation?.type ?? "action",
          verb: item.type === "spell" ? "cast" : "use that",
        });
        if (verdict.ok) return null;
        return { refuse: verdict.reason, name: verdict.condition ? "Cannot act" : "Cannot cast",
          data: { condition: verdict.condition ?? null } };
      },
    },

    // ── Armor it cannot wear (was armor-prof-spell-block's hook) ──
    {
      id: "armor",
      name: "Armor without proficiency",
      test({ item, actor }) {
        if (item?.type !== "spell" || !actor) return null;
        if (!isOn("armorProfSpellBlock")) return null;
        const armor = findUnproficientArmor(actor);
        if (!armor) return null;
        const kind = armor.system?.armor?.type ?? "that";
        return { refuse: `${actor.name} is wearing ${armor.name} without ${kind} armor proficiency, and cannot cast spells in it.`,
          data: { armor: armor.name } };
      },
    },

    // ── Spells in one turn (was bonus-spell-rule's hook) ──
    // ⚠️ NO TURNS, NO ACTION ECONOMY. Johnny, 2026-08-24, on Varek outside
    // combat: "you can cast as many spells as you have ready."
    {
      id: "bonus-action-spell",
      name: "Spells in one turn",
      test({ item, actor, activity }) {
        if (item?.type !== "spell" || !actor) return null;
        if (!isOn("bonusActionSpellRule")) return null;
        if (!hasTurns(actor)) return null;
        const verdict = BonusSpellRule._evaluate(actor, activity, item);
        if (verdict.ok) return null;
        if (!isOn("bonusActionSpellStrict")) return { note: `allowed by table style. ${verdict.reason}` };
        return { refuse: verdict.reason };
      },
      // ⚠️ RECORDED ONCE IT IS USED, NOT AT THE PRESS. Recorded at the press, a
      // press that is asked about and pressed again (the use prompt, a picker)
      // counted itself and then refused itself as a second spell.
      afterUse({ item, actor, activity }) {
        if (item?.type !== "spell" || !actor) return null;
        if (!isOn("bonusActionSpellRule")) return null;
        if (!hasTurns(actor) || !game.combat?.started) return null;
        return BonusSpellRule._recordCast(actor, activity, item);
      },
    },

    // ── Killed for good (was the revive hook in ace-qol.mjs) ──
    {
      id: "killed-for-good",
      name: "Killed for good",
      test({ item, targets }) {
        const spell = String(item?.name ?? "");
        if (!spell) return null;
        const strict = STRICT_REVIVES.some(rx => rx.test(spell));
        const ordinary = !strict && ORDINARY_REVIVES.some(rx => rx.test(spell));
        if (!strict && !ordinary) return null;
        const locked = (targets ?? []).filter(t => t?.document?.flags?.[MODULE_ID]?.permanentlyDead);
        if (!locked.length) return null;
        const tokens = locked.map(t => ({
          actorId: t.document.actorId ?? t.actor?.id ?? null,
          tokenId: t.document.id ?? t.id ?? null,
          sceneId: t.document.parent?.id ?? null,
          name: t.document.actor?.name ?? t.actor?.name ?? t.name ?? "a creature",
          reason: t.document.flags?.[MODULE_ID]?.deathReason ?? null,
        }));
        if (strict) return { onAllowed: () => clearLocks(spell, tokens) };
        const who = tokens.map(t => t.name + (t.reason ? ` (${t.reason})` : "")).join(", ");
        return { refuse: `${who} was killed for good. ${spell} cannot bring them back; only True Resurrection or Wish can.`,
          data: { tokens } };
      },
      // Overruled: the lock comes off, and the press goes through as pressed.
      async onOverride(data) {
        for (const t of data?.tokens ?? []) await revokeVorpalLock(t.actorId, t.tokenId, t.sceneId);
      },
    },

    // ── Targets (was the engagement gate's hook) ──
    {
      id: "targets",
      name: "Targets",
      test(ctx) {
        const { item, activity, actor, targets } = ctx;
        if (item?.type !== "spell" || !actor) return null;
        // ⚠️ A REVIVE PRESSED WITH NOBODY TARGETED PICKS FIRST (Phase 4, 2026-09-15).
        // The picker offers the dead, killed for good included, and picking presses
        // it again, so this gate sees who it is aimed at and Killed for good can
        // answer, with Do it anyway. The spell pipeline's own picker came after the
        // press, where the lock was never asked.
        if (revivesTheDead(item) && !targets.length) return { ask: () => pickTargets(ctx, { kind: "revive" }) };
        const block = EngagementGate._checkTargetRequirement(item, activity, targets, actor);
        if (!block?.blocked) return null;
        // An attack spell with nobody targeted opens the picker instead of
        // stopping dead (Fire Bolt, 2026-07-26). Picking presses it again.
        if (activity?.type === "attack" && !targets.length) return { ask: () => pickTargets(ctx) };
        return { refuse: block.reason };
      },
    },

    // ── Creature type (was the engagement gate's hook): Hold Person on a Wolf ──
    {
      id: "creature-type",
      name: "Creature type",
      test({ item, targets }) {
        const block = EngagementGate._checkCreatureTypeRestriction(item, targets);
        if (!block?.blocked) return null;
        return { refuse: block.reason, data: { tokens: (block.invalidTokens ?? []).map(t => t?.name ?? "a target") } };
      },
    },

    // ── Nobody in reach (was holy-symbol's hook) ──
    {
      id: "holy-symbol",
      name: "Nobody in reach",
      test({ activity }) {
        const reach = HolySymbol._eligibleFor(activity);
        if (!reach) return null;
        // ⚠️ WHAT ACE CANNOT TELL NEVER BLOCKS (section 9): no token, no reach.
        if (reach.cannotTell) return { note: reach.cannotTell };
        if (!reach.eligible.length) {
          return { refuse: `No ${reach.label} within ${reach.rangeFt} feet, so ${reach.power} affects no one.`,
            data: { power: reach.power, rangeFt: reach.rangeFt } };
        }
        return { onAllowed: () => HolySymbol._targetEligible(reach) };
      },
    },

    // ── Concentration (was the engagement gate's hook): a question, never a refusal ──
    {
      id: "concentration",
      name: "Concentration",
      test({ item, activity, actor }) {
        if (item?.type !== "spell" || !actor) return null;
        if (!EngagementGate._spellRequiresConcentration(item, activity)) return null;
        const current = EngagementGate._currentConcentrationSpellName(actor);
        if (!current || current === item.name) return null;   // the same spell again is a refresh
        return {
          ask: async () => {
            const yes = await EngagementGate._confirmBreakConcentrationDialog(item.name, current);
            if (!yes) ui.notifications?.info(`${item.name} was not cast: concentration on ${current} is kept.`);
            return yes;
          },
        };
      },
    },
  ]));
}
