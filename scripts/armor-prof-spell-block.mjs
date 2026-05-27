// ─── ACE QOL — Non-Proficient Armor Spell Block ────────────────────────────
//
// RAW (PHB p.144): "If you wear armor that you lack proficiency with, you
// have disadvantage on any ability check, saving throw, or attack roll
// that involves Strength or Dexterity, AND YOU CAN'T CAST SPELLS."
//
// The attack-roll disadvantage piece is in combat-state.assess (v0.7.6).
// This file enforces the spell-cast block via dnd5e.preUseActivity —
// returns false to cancel the activity before the dialog or usage message.
//
// PC-only — NPCs typically have no populated `armorProf` array, so we'd
// false-positive on every spellcasting monster (every Lich, every Mage,
// every dragon with armored hide). Skip.
//
// Toggle via the `armorProfSpellBlock` setting (default ON, RAW-strict).
// ───────────────────────────────────────────────────────────────────────────

import { MODULE_ID } from "./ace-qol.mjs";
import { QolSettings } from "./settings.mjs";

// dnd5e 5.x stores armor item type as a long-form string ("light" /
// "medium" / "heavy") and the matching proficiency key as short-form
// ("lgt" / "med" / "hvy"). Map between them. Same mapping used in
// combat-state.mjs for the attack-roll disadvantage check.
const ARMOR_TYPE_TO_PROF = { light: "lgt", medium: "med", heavy: "hvy" };

export class ArmorProfSpellBlock {

  static init() {
    Hooks.on("dnd5e.preUseActivity", (activity /*, usageConfig, dialogConfig, messageConfig */) => {
      try {
        // Setting gate — opt-out for tables that house-rule around this.
        if (QolSettings.get?.("armorProfSpellBlock") === false) return;

        const item = activity?.item;
        if (!item || item.type !== "spell") return;
        const actor = activity?.actor ?? item?.actor;
        if (!actor) return;

        // PC-only gate. NPCs without an armorProf array would all trip
        // this check and be unable to cast their innate spells.
        if (actor.type !== "character") return;

        // Find equipped body armor (shields excluded — separate ruleset).
        let equippedArmor = null;
        try {
          equippedArmor = actor.items?.find?.(it =>
            it.type === "equipment"
            && it.system?.equipped === true
            && ARMOR_TYPE_TO_PROF[it.system?.armor?.type]
          ) ?? null;
        } catch (_) { /* defensive — malformed item shouldn't block casts */ }
        if (!equippedArmor) return;

        const profKey = ARMOR_TYPE_TO_PROF[equippedArmor.system.armor.type];
        const profs = actor.system?.traits?.armorProf?.value;
        const hasProf = (profs?.has?.(profKey) === true)
                     || (Array.isArray(profs) && profs.includes(profKey));
        if (hasProf) return;

        // Block. ui.notifications.error so the user sees WHY their spell
        // didn't fire — a silent cancel is a UX trap.
        ui.notifications?.error(
          `${actor.name} cannot cast spells while wearing ${equippedArmor.name} ` +
          `— no ${equippedArmor.system.armor.type}-armor proficiency (RAW PHB p.144).`
        );
        console.log(`${MODULE_ID} | ArmorProfSpellBlock: blocked ${actor.name} from casting "${item.name}" — wearing ${equippedArmor.name} (no ${equippedArmor.system.armor.type} proficiency)`);
        return false; // sync-cancels the activity
      } catch (err) {
        console.warn(`${MODULE_ID} | ArmorProfSpellBlock check threw — fail-open (cast permitted):`, err);
      }
    });
  }
}
