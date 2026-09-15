// ─── ACE: QOL — Pipeline Resolver: Heal ───────────────────────────────────────
// Single-target heal (Cure Wounds touch, Healing Word ranged) and multi-target
// heal (Mass Cure Wounds, Mass Healing Word), and the revives, the stabilise and
// the restorations the registry shapes as touch heals.
//
// THE ONE ROAD, PHASE 4 (2026-09-15): the healing is the used activity's own,
// rolled by dnd5e with the slot's scaling: the item's reading, and for a named
// official spell the same numbers as its book entry. It lands through the
// hit-point door, and the card through the card door. The registry's hand-written
// formula, entry.heal.formula(castLvl, spellMod), is used only when the activity
// rolls nothing of its own (Raise Dead's "Revive" carries no healing, Spare the
// Dying and the restorations none at all).
// ──────────────────────────────────────────────────────────────────────────────

import { MODULE_ID } from "../../ace-qol.mjs";
import { safeShowForRoll, awaitDiceSettle } from "../../dsn-utils.mjs";
import { HpDoor, ConditionDoor, CardDoor } from "../../road/doors.mjs";

export class HealResolver {

  static async runSingle(ctx, result) {
    const target = result?.target ?? result?.targets?.[0];
    if (!target) {
      console.warn(`${MODULE_ID} | HealResolver.runSingle: no target`);
      return;
    }
    return HealResolver._heal(ctx, [target], false);
  }

  static async runMulti(ctx, result) {
    const targets = result?.targets ?? [];
    if (!targets.length) {
      console.warn(`${MODULE_ID} | HealResolver.runMulti: no targets`);
      return;
    }
    return HealResolver._heal(ctx, targets, true);
  }

  // ─── Core ──────────────────────────────────────────────────────────────────

  /**
   * The healing the used activity rolls itself, through dnd5e, scaled by the
   * slot it was cast with. Null when it rolls nothing of its own.
   */
  static async _activityRoll(ctx) {
    const { activity, item, castLevel } = ctx;
    if (typeof activity?.rollDamage !== "function") return null;
    try {
      // The same roll config the save engine gives a spell's damage: the slot's
      // scaling, and the mark the pipeline's roll guard lets through.
      const { SaveEngine } = await import("../../save-engine.mjs");
      const rolls = await activity.rollDamage(SaveEngine._damageRollConfig(item, castLevel),
        { configure: false }, { create: false });
      return (Array.isArray(rolls) ? rolls : []).find(r => Number.isFinite(Number(r?.total))) ?? null;
    } catch (err) {
      console.warn(`${MODULE_ID} | ${item?.name}: dnd5e could not roll its own healing, so the registry's formula is used:`, err);
      return null;
    }
  }

  static async _heal(ctx, targets, isMulti) {
    const { entry, item, actor, castLevel, spellMod } = ctx;
    const formulaFn = entry.heal?.formula;
    const isRevive = entry.heal?.revivesDead === true;       // Revivify, Raise Dead
    const isStabilize = entry.heal?.stabilizes === true;     // Spare the Dying
    const clearStatuses = Array.isArray(entry.heal?.clearStatuses) ? entry.heal.clearStatuses : null;

    // One roll for one creature: the activity's own, else the registry's formula.
    let from = null;
    const rollOne = async () => {
      const own = await HealResolver._activityRoll(ctx);
      if (own) { from = "the spell"; return own; }
      if (typeof formulaFn !== "function") return null;
      from = "ACE's registry";
      return new Roll(formulaFn(castLevel, spellMod), actor.getRollData()).evaluate();
    };

    // ⚠️🔴 ONE ROLL OR ONE EACH, AND THE SPELL DECIDES. "Each target regains Hit
    // Points equal to 5d8 plus your spellcasting ability modifier" is one roll
    // shared by all of them, the same convention as area damage and what dnd5e's
    // own implementation does. A per-entry flag, so a spell that genuinely rolls
    // per creature keeps working by saying nothing.
    const rollOnce = entry.heal?.rollOnce === true;
    const sharedRoll = (rollOnce && targets.length > 1) ? await rollOne() : null;

    // ⚠️🔴 NOTHING LANDS BEFORE THE DICE (Johnny's rule). Every roll is made and
    // thrown first, the dice land, and only then does anything touch a creature.
    const rollFor = new Map();
    for (const c of targets) {
      if (!c.actor) continue;
      try {
        const roll = sharedRoll ?? await rollOne();
        if (roll) rollFor.set(c, roll);
      } catch (err) {
        console.error(`${MODULE_ID} | HealResolver: the roll failed for ${c.name}:`, err);
      }
    }
    if (!rollFor.size) {
      console.error(`${MODULE_ID} | HealResolver: "${item.name}" rolls no healing of its own and its registry entry has no formula; nothing was healed.`);
      ui.notifications?.error(`${item.name}: ACE found no healing to roll. Nothing was healed; see the console.`);
      return;
    }
    for (const thrown of new Set(rollFor.values())) {
      try { safeShowForRoll(thrown, "healing"); } catch (_) { /* non-fatal */ }
    }
    await awaitDiceSettle();
    console.log(`${MODULE_ID} | ${item.name}: healing from ${from}: `
      + [...new Set(rollFor.values())].map(r => `${r.formula} = ${r.total}`).join("; "));

    const results = [];
    for (const c of targets) {
      const targetActor = c.actor;
      const roll = rollFor.get(c);
      if (!targetActor || !roll) continue;               // its roll failed above, and said so
      try {
        const temp = String(roll.options?.type ?? "") === "temphp";
        // Through the hit-point door: a revive takes Dead off first, a creature
        // brought up from 0 stops dying, a stabilise moves no hit points.
        const landed = await HpDoor.heal(targetActor, Math.max(0, Number(roll.total) || 0),
          { temp, revive: isRevive, stabilize: isStabilize });
        const cleared = [];
        if (landed.applied && clearStatuses?.length) {
          for (const key of clearStatuses) {
            try { if (await ConditionDoor.remove(targetActor, key)) cleared.push(key); }
            catch (err) { console.warn(`${MODULE_ID} | ${item.name}: could not take ${key} off ${c.name}:`, err); }
          }
        }
        results.push({
          name: c.name,
          img: c.img,
          formula: roll.formula,
          rolled: roll.total,
          healed: landed.healed,
          beforeHP: landed.before,
          afterHP: landed.after,
          maxHP: targetActor.system?.attributes?.hp?.max ?? 0,
          temp,
          stabilized: isStabilize && landed.applied,
          revived: isRevive && landed.before <= 0 && landed.after > 0,
          clearedStatuses: cleared,
          notApplied: landed.applied ? null : (landed.why ?? (temp ? "it already had as many temporary hit points" : "nothing changed")),
        });
      } catch (err) {
        console.error(`${MODULE_ID} | HealResolver: could not heal ${c.name}:`, err);
      }
    }

    await HealResolver._postChatCard(item, actor, results, castLevel, isMulti);
  }

  static async _postChatCard(item, caster, results, castLevel, isMulti) {
    if (!results.length) return;
    const accent = "#7ec97e";
    const esc = (s) => foundry.utils.escapeHTML(String(s ?? ""));
    const totalHealed = results.reduce((s, r) => s + (r.notApplied ? 0 : r.healed), 0);
    const targetRows = results.map(r => {
      const hpLine = r.notApplied
        ? `<span style="color:#e8c46a;">Not applied: ${esc(r.notApplied)}.</span>`
        : r.stabilized
          ? `STABILIZED at ${r.beforeHP}/${r.maxHP}, still unconscious`
          : r.revived
            ? `REVIVED — HP ${r.beforeHP} → <strong style="color:#7ec97e;">${r.afterHP}</strong> / ${r.maxHP}`
            : r.temp
              ? `Temporary HP ${r.beforeHP} → <strong style="color:#7ec97e;">${r.afterHP}</strong>`
              : `HP ${r.beforeHP} → <strong style="color:#7ec97e;">${r.afterHP}</strong> / ${r.maxHP}`;
      const numberCol = r.stabilized
        ? `<i class="fas fa-shield-heart" style="font-size:18px;color:${accent};"></i>`
        : `<div style="font-size:18px;font-weight:700;color:${accent};">+${r.notApplied ? 0 : r.healed}</div>`;
      const clearedLine = r.clearedStatuses?.length
        ? `<div style="font-size:14px;color:#9ec99e;font-style:italic;margin-top:2px;">Cleared: ${esc(r.clearedStatuses.join(", "))}</div>`
        : "";
      return `
        <div style="display:flex;align-items:center;gap:8px;padding:6px 8px;background:rgba(126,201,126,0.10);border-radius:4px;margin-bottom:4px;min-width:0;flex-wrap:wrap;">
          <img src="${r.img || "icons/svg/heal.svg"}" style="width:36px;height:36px;border-radius:50%;object-fit:cover;border:1px solid #5a8a5a;flex-shrink:0;" />
          <div style="flex:1 1 160px;min-width:0;color:#e8d49a;">
            <div style="font-weight:600;overflow-wrap:anywhere;">${esc(r.name)}</div>
            <div style="font-size:14px;color:#c0b288;">${hpLine}</div>
            ${clearedLine}
          </div>
          <div style="flex-shrink:0;">${numberCol}</div>
        </div>
      `;
    }).join("");

    const html = `
      <div style="background:linear-gradient(180deg,#101a10 0%,#080f08 100%);
                  border:2px solid ${accent};
                  border-radius:6px;
                  padding:12px 14px;
                  color:#f0e4c0;
                  font-family:'Signika','Helvetica Neue',sans-serif;">
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;row-gap:4px;
                    font-size:15px;font-weight:700;color:${accent};
                    text-transform:uppercase;letter-spacing:0.6px;
                    border-bottom:1px solid #2a4a2a;
                    padding-bottom:6px;margin-bottom:8px;">
          <img src="${item.img || "icons/svg/heal.svg"}" style="width:24px;height:24px;border-radius:3px;object-fit:cover;flex-shrink:0;" />
          <span style="flex:1 1 auto;min-width:0;overflow-wrap:anywhere;">${esc(item.name.toUpperCase())}${castLevel > (item.system?.level ?? 1) ? ` (L${castLevel})` : ""}</span>
          <span style="font-size:14px;flex-shrink:0;">+${totalHealed} total</span>
        </div>
        ${targetRows}
      </div>
    `;
    // Through the card door. The healing dice were waited for before anything landed.
    try {
      await CardDoor.post({
        speaker: ChatMessage.getSpeaker({ actor: caster }),
        content: html,
        flavor: `${item.name} healed ${results.length} target${results.length === 1 ? "" : "s"} for ${totalHealed} total`,
      });
    } catch (err) {
      console.warn(`${MODULE_ID} | HealResolver: the healing card could not be posted; the healing still landed:`, err);
    }
  }
}
