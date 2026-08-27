// ─── ACE: QOL — Ranged-Spell Bonus Heuristic ──────────────────────────────────
// Punch-list #17 (Produce Flame / Stormforger +2, live game 2026-06-28):
// some spells ship mislabeled as MELEE spell attacks while having a real
// ranged distance (Produce Flame: melee-tagged, 30-ft range). dnd5e keys the
// actor's "+X to ranged spell attacks" bonus off that label, so a staff's
// ranged-spell bonus never lands on the roll even though the cast is plainly
// ranged.
//
// The heuristic (Johnny's pick over silently retagging item data): a SPELL
// attack tagged melee whose range is beyond touch (> 5 feet) is treated as
// RANGED for attack bonuses — the actor's ranged-spell-attack bonus is added
// to the roll at build time. The item is never modified.
//
// Guards:
//   • spells only, melee-spell-attack label only, range > 5 feet only
//   • skipped when the actor ALSO has a melee-spell-attack bonus (dnd5e
//     already applied one; adding ours would double-dip)
//   • idempotent per roll config (dual-hook safe)
//
// A correctly-tagged ranged spell (Fire Bolt, Eldritch Blast) is untouched —
// dnd5e handles those natively.
// ──────────────────────────────────────────────────────────────────────────────

import { MODULE_ID } from "./ace-qol.mjs";

export class RangedSpellBonus {

  static register() {
    Hooks.on("dnd5e.preRollAttackV2", (config) => {
      try {
        RangedSpellBonus._apply(config);
      } catch (err) {
        console.warn(`${MODULE_ID} | ranged-spell bonus heuristic failed (non-fatal):`, err);
      }
    });
    console.debug(`${MODULE_ID} | RangedSpellBonus online — mislabeled melee spells with real range get ranged-attack bonuses`);
  }

  static _apply(config) {
    if (config?._aceRangedSpellBonusApplied) return;

    const activity = config?.subject;
    const item = activity?.item;
    const actor = activity?.actor ?? item?.actor;
    if (!item || item.type !== "spell" || !actor) return;

    // Melee-spell-attack label with an actual ranged distance = the mislabel.
    const actionType = activity?.actionType ?? item.system?.actionType ?? "";
    if (actionType !== "msak") return;
    const rangeVal = Number(activity?.range?.value ?? item.system?.range?.value ?? 0);
    if (!(rangeVal > 5)) return;

    // The actor's ranged-spell-attack bonus (e.g. Stormforger's +2).
    const rsakBonus = String(actor.system?.bonuses?.rsak?.attack ?? "").trim();
    if (!rsakBonus || rsakBonus === "0") return;

    // If a melee-spell bonus ALSO exists, dnd5e already applied one — adding
    // ours on top would double-dip. (An item granting both sets both.)
    const msakBonus = String(actor.system?.bonuses?.msak?.attack ?? "").trim();
    if (msakBonus && msakBonus !== "0") return;

    const roll = config.rolls?.[0];
    if (!Array.isArray(roll?.parts)) return;

    roll.parts.push(rsakBonus);
    config._aceRangedSpellBonusApplied = true;
    console.log(
      `${MODULE_ID} | ranged-spell heuristic: "${item.name}" is melee-tagged with a ${rangeVal}-ft range — `
      + `applied the ranged-spell attack bonus (${rsakBonus}) for ${actor.name}`
    );
  }
}
