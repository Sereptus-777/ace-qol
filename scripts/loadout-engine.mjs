// ─── ACE: QOL — Loadout / Hands Enforcement ─────────────────────────────────
// Stops a character from "equipping" more than they could actually hold. The
// dnd5e equipped checkbox has no concept of hands, so a player can tick every
// weapon they own — javelin AND longsword AND a greatsword — and the engine
// then can't tell what's really in hand (this broke the opportunity-attack
// weapon picker: it offered weapons out of a bag of holding).
//
// RAW (2014 + 2024 share the same core):
//   • A creature has two hands. One-handed = 1 hand, two-handed = 2, versatile
//     = 1 (the two-handed grip is an attack-time choice, not an equip cost),
//     a shield = 1.
//   • So you can hold: two one-handed weapons, OR one two-handed weapon, OR a
//     one-handed weapon + shield.
//   • Wielding TWO one-handed weapons at once is two-weapon fighting — RAW it
//     requires both to be Light, unless you have the Dual Wielder feat.
//   • Natural weapons (claws/bite/slam) and unarmed strikes use no hands.
//
// Enforcement: when a CHARACTER tries to equip a weapon/shield that would break
// these rules, we cancel the equip and explain why. NPCs are left alone — their
// stat blocks legitimately carry several "equipped" weapons and are GM-managed.
//
// Per-creature override: set the flag `ace-qol.handCount` on an actor to raise
// the hand budget for exotic creatures (a marilith has six arms, a thri-kreen
// four). Master toggle: the `enforceLoadout` setting (default ON).
// ──────────────────────────────────────────────────────────────────────────────

import { MODULE_ID } from "./ace-qol.mjs";
import { QolSettings } from "./settings.mjs";
import { showCenterToast } from "./attack-prompt.mjs";

const FLAG_NS = "ace-qol";

export class LoadoutEngine {

  static init() {
    Hooks.on("preUpdateItem", (item, changes, options /*, userId */) => {
      try {
        return LoadoutEngine._onPreUpdateItem(item, changes, options);
      } catch (err) {
        // Never let our own bug block a legitimate equip.
        console.warn(`${MODULE_ID} | Loadout enforcement threw (non-fatal, allowing equip):`, err);
        return true;
      }
    });
    console.debug(`${MODULE_ID} | LoadoutEngine online`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Enforcement
  // ═══════════════════════════════════════════════════════════════════════════

  static _onPreUpdateItem(item, changes, options) {
    // Explicit programmatic bypass (for future automation that needs to force-equip).
    if (options?.aceLoadoutBypass) return true;
    if (!QolSettings.get?.("enforceLoadout")) return true;

    // Only act when the change is EQUIPPING something (false/undefined → true).
    if (changes?.system?.equipped !== true) return true;

    const actor = item.actor ?? item.parent;
    if (!actor) return true;

    // Characters only — NPC stat blocks legitimately list multiple equipped
    // weapons and are managed by the GM.
    if (actor.type !== "character") return true;

    // Only weapons and shields consume hands.
    const isShield = LoadoutEngine._isShield(item);
    if (item.type !== "weapon" && !isShield) return true;
    // Natural weapons / unarmed strikes never occupy hands.
    if (item.type === "weapon" && LoadoutEngine._isNaturalOrUnarmed(item)) return true;

    // Project the post-equip loadout: every currently-equipped hand item
    // (minus this one, in case it's already listed) plus the item being equipped.
    const projected = LoadoutEngine._equippedHandItems(actor)
      .filter(i => i.id !== item.id)
      .concat(item);

    const budget = LoadoutEngine._handBudget(actor);
    const handsUsed = projected.reduce((sum, i) => sum + LoadoutEngine._gripCost(i), 0);

    if (handsUsed > budget) {
      LoadoutEngine._block(actor, item,
        `that needs ${handsUsed} hands but only ${budget} ${budget === 1 ? "is" : "are"} free — unequip something first.`);
      return false;
    }

    // Two-weapon legality: two-plus equipped one-handed WEAPONS (not shields)
    // must all be Light, or the wielder needs the Dual Wielder feat.
    const oneHandedWeapons = projected.filter(i =>
      i.type === "weapon" && !LoadoutEngine._isShield(i) && LoadoutEngine._gripCost(i) === 1
    );
    if (oneHandedWeapons.length >= 2) {
      const allLight = oneHandedWeapons.every(i => i.system?.properties?.has?.("lgt"));
      if (!allLight && !LoadoutEngine._hasDualWielder(actor)) {
        LoadoutEngine._block(actor, item,
          `you can't wield two non-Light one-handed weapons at once — both must be Light (two-weapon fighting) or you need the Dual Wielder feat.`);
        return false;
      }
    }

    return true; // allowed
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Helpers
  // ═══════════════════════════════════════════════════════════════════════════

  /** Hand budget for this actor — default 2, override via flag `ace-qol.handCount`. */
  static _handBudget(actor) {
    const override = Number(actor.getFlag?.(FLAG_NS, "handCount"));
    return (Number.isFinite(override) && override > 0) ? override : 2;
  }

  /** How many hands an equipped item occupies. */
  static _gripCost(item) {
    if (LoadoutEngine._isShield(item)) return 1;
    if (item.type !== "weapon") return 0;
    if (LoadoutEngine._isNaturalOrUnarmed(item)) return 0;
    if (item.system?.properties?.has?.("two")) return 2; // two-handed
    return 1; // one-handed, versatile, or light
  }

  static _isShield(item) {
    if (item?.type !== "equipment") return false;
    return String(item.system?.type?.value ?? "").toLowerCase() === "shield"
        || String(item.system?.armor?.type ?? "").toLowerCase() === "shield";
  }

  static _isNaturalOrUnarmed(item) {
    if (String(item?.system?.type?.value ?? "").toLowerCase() === "natural") return true;
    const id = String(item?.system?.identifier ?? item?.system?.type?.baseItem ?? "").toLowerCase();
    return id === "unarmedstrike" || id === "unarmed" || /^unarmed strike$/i.test(String(item?.name ?? ""));
  }

  /** Currently-equipped items that occupy hands (manufactured weapons + shields). */
  static _equippedHandItems(actor) {
    return (actor.items ?? []).filter(i => {
      if (i.system?.equipped !== true) return false;
      if (i.system?.container) return false; // stowed in a bag/portable hole
      if (LoadoutEngine._isShield(i)) return true;
      if (i.type !== "weapon") return false;
      if (LoadoutEngine._isNaturalOrUnarmed(i)) return false;
      return true;
    });
  }

  static _hasDualWielder(actor) {
    return (actor.items ?? []).some(i =>
      i.type === "feat" && /dual\s*wielder/i.test(String(i.name ?? ""))
    );
  }

  static _block(actor, item, reason) {
    const msg = `${actor.name}: can't equip ${item.name} — ${reason}`;
    try { ui.notifications?.warn(`ACE QOL: ${msg}`); } catch (_) { /* noop */ }
    try { showCenterToast?.(msg, 3500); } catch (_) { /* noop */ }
  }
}
