// ─── ACE: QOL — Target State Nullification Walker ────────────────────────────
// The framework. Given an actor + the merged NULLIFICATION_REGISTRY, walks
// the actor's effects, items, and features against each registry entry and
// produces a structured `nullifications` object the damage / save / attack
// pipelines all respect.
//
// Used by TargetState.assess() — single point of integration. Both the
// attack-pipeline (weapons) and the spell-pipeline (spells) feed through
// TargetState.assess, so this walker's results apply uniformly to BOTH.
//
// Entry schema (see registry/*.mjs for examples):
//
// {
//   name: "Shield",                       // primary match name (case-insensitive)
//   aliases: ["Shield Spell"],            // optional alternate names
//   matchType: "effect" | "item" | "feature",
//   itemType: "spell" | "equipment" | "weapon" | "feat" | undefined,
//   equipped: true,                       // for items: must be equipped to apply
//   identified: true,                     // for items: must be identified (default true)
//
//   nullifications: {
//     spellImmune: ["magic missile"],     // by spell name (case-insensitive)
//     damage: { force: "resistant" },     // override damage modifier per type
//                                          // values: "immune" | "resistant" | "vulnerable" | "normal"
//     saves: {                             // save-roll modifiers
//       advantage: ["spell", "wis"],      //   advantage on rolls matching these tags
//       disadvantage: ["str"],            //   disadvantage on rolls matching these tags
//       autoPass: ["death"],              //   auto-success on these saves
//       autoFail: [],
//       bonus: { all: "+1" },              //   flat bonus to listed save types
//     },
//     conditions: { immune: ["charmed", "frightened"] },
//     attacks: {
//       disadvantageVs: true,             //   attackers have disadvantage vs me
//       advantageVs: false,
//       cantTarget: ["fiend"],            //   listed creature types can't attack me
//     },
//     death: {
//       wardActive: true,                 //   Death Ward — next reduction-to-0 sets to 1 HP
//     },
//     ac: { bonus: 1 },                   //   flat AC bonus
//     hp: { maxBonus: 5 },                //   max HP bonus
//     stats: { str: 19 },                 //   ability score override (max with existing)
//     reactions: {
//       canCounterAttack: true,           //   informational
//     },
//     special: {                          //   freeform flags for the damage card / engines
//       silveryBarbsTriggers: true,       //   examples
//     },
//   },
//
//   source: "PHB p.275",                  // documentation
//   byEdition: {                          // optional edition overrides
//     legacy: { ... },
//     modern: { ... },
//   },
// }
//
// MERGE BEHAVIOR — when multiple entries fire on the same target:
//   - Booleans: OR (true wins)
//   - Arrays: union (dedup)
//   - Damage maps: most restrictive wins (immune > resistant > normal > vulnerable)
//   - AC bonus: SUM
//   - HP max bonus: SUM
//   - Save bonus: SUM (per-type)
//   - Stat overrides: MAX
// ──────────────────────────────────────────────────────────────────────────────

import { MODULE_ID } from "../ace-qol.mjs";
import { NULLIFICATION_REGISTRY } from "./_index.mjs";
import { CombatState } from "../combat-state.mjs";

const DEBUG = false;

export class NullificationWalker {

  /**
   * Walk the registry against an actor. Returns the merged nullifications object.
   * Safe to call on any actor — returns an empty (all-false) object if no matches.
   *
   * @param {Actor} actor
   * @param {object} opts — { item, isSpell, isMelee, damageTypes, edition }
   * @returns {object} nullifications (see schema above)
   */
  static walk(actor, opts = {}) {
    const out = NullificationWalker._emptyNullifications();
    if (!actor) return out;

    const edition = opts.edition ?? NullificationWalker._getEdition();

    // Build lookup sets for the actor's content
    const effectNames = new Set();
    const effectMap = new Map(); // name → effect object
    for (const e of actor.effects ?? []) {
      if (e.disabled) continue;
      const n = String(e.name ?? "").trim().toLowerCase();
      if (n) {
        effectNames.add(n);
        effectMap.set(n, e);
      }
    }

    const itemMap = new Map(); // name → item object
    for (const i of actor.items ?? []) {
      const n = String(i.name ?? "").trim().toLowerCase();
      if (n) itemMap.set(n, i);
    }

    // Walk the registry
    for (const entry of NULLIFICATION_REGISTRY) {
      const matched = NullificationWalker._matches(entry, actor, { effectNames, effectMap, itemMap, edition });
      if (!matched) continue;

      // Apply edition override on the matched entry, if any
      const effectiveEntry = NullificationWalker._applyEdition(entry, edition);
      NullificationWalker._merge(out, effectiveEntry.nullifications ?? {}, entry.name);

      if (DEBUG) console.debug(`${MODULE_ID} | NullificationWalker: ${actor.name} matches "${entry.name}"`);
    }

    return out;
  }

  // ─── Match logic ──────────────────────────────────────────────────────────

  static _matches(entry, actor, ctx) {
    const names = [entry.name, ...(entry.aliases ?? [])]
      .map(n => String(n ?? "").trim().toLowerCase())
      .filter(Boolean);

    if (entry.matchType === "effect") {
      for (const n of names) {
        if (ctx.effectNames.has(n)) return true;
      }
      return false;
    }

    if (entry.matchType === "item") {
      for (const n of names) {
        const item = ctx.itemMap.get(n);
        if (!item) continue;
        if (entry.itemType && item.type !== entry.itemType) continue;
        if (entry.equipped === true && !item.system?.equipped) continue;
        // Identification check — most magic items only work when identified
        if (entry.identified !== false) {
          const idStatus = item.system?.identified;
          if (idStatus === false) continue;
        }
        // Attunement check — most attunement items only work when attuned
        if (entry.requiresAttunement === true) {
          const attuned = item.system?.attunement === 2 || item.system?.attuned === true;
          if (!attuned) continue;
        }
        return true;
      }
      return false;
    }

    if (entry.matchType === "feature") {
      // Features are stored as items with type "feat" or "race" or "subclass"
      for (const n of names) {
        const item = ctx.itemMap.get(n);
        if (!item) continue;
        if (item.type !== "feat" && item.type !== "race" && item.type !== "subclass" && item.type !== "class" && item.type !== "background") continue;
        // Optional level check for features
        if (entry.minLevel != null) {
          const actorLevel = NullificationWalker._actorLevel(actor, entry.classMatch);
          if (actorLevel < entry.minLevel) continue;
        }
        // Optional rage / state requirement (e.g., Rage Resistance requires raging)
        if (entry.requiresStatus) {
          const statuses = actor.statuses ?? new Set();
          if (!statuses.has(entry.requiresStatus)) continue;
        }
        return true;
      }
      return false;
    }

    return false;
  }

  // ─── Edition handling ─────────────────────────────────────────────────────

  static _getEdition() {
    // Honors the ACE QOL gameRulesEdition master override; falls back to
    // legacy (2014) when undetectable — was previously a raw dnd5e read that
    // ignored the override AND wrongly defaulted to "modern".
    return CombatState.getActiveRulesVersion();
  }

  static _applyEdition(entry, edition) {
    const override = entry.byEdition?.[edition];
    if (!override) return entry;
    return { ...entry, ...override, nullifications: { ...entry.nullifications, ...override.nullifications } };
  }

  // ─── Merge logic ──────────────────────────────────────────────────────────

  static _merge(out, add, sourceName) {
    if (!add) return;

    // spellImmune — array union
    if (add.spellImmune?.length) {
      for (const s of add.spellImmune) {
        const k = String(s).toLowerCase().trim();
        if (!out.spellImmune.includes(k)) out.spellImmune.push(k);
        if (!out.spellImmuneSources[k]) out.spellImmuneSources[k] = [];
        if (!out.spellImmuneSources[k].includes(sourceName)) out.spellImmuneSources[k].push(sourceName);
      }
    }

    // damage — most-restrictive wins per type
    if (add.damage) {
      const rank = { vulnerable: 0, normal: 1, resistant: 2, immune: 3 };
      for (const [type, mod] of Object.entries(add.damage)) {
        const t = String(type).toLowerCase();
        const existing = out.damage[t] ?? "normal";
        if ((rank[mod] ?? 1) > (rank[existing] ?? 1)) {
          out.damage[t] = mod;
          out.damageSources[t] = sourceName;
        }
      }
    }

    // saves — advantage/disadvantage merge as union; bonuses sum
    if (add.saves) {
      for (const k of ["advantage", "disadvantage", "autoPass", "autoFail"]) {
        for (const s of (add.saves[k] ?? [])) {
          const t = String(s).toLowerCase();
          if (!out.saves[k].includes(t)) out.saves[k].push(t);
        }
      }
      if (add.saves.bonus) {
        for (const [type, bonus] of Object.entries(add.saves.bonus)) {
          out.saves.bonus[type] = (out.saves.bonus[type] ?? "") + (out.saves.bonus[type] ? " + " : "") + bonus;
        }
      }
    }

    // conditions — array union
    if (add.conditions) {
      for (const c of (add.conditions.immune ?? [])) {
        const t = String(c).toLowerCase();
        if (!out.conditions.immune.includes(t)) out.conditions.immune.push(t);
      }
    }

    // attacks — booleans OR; arrays union
    if (add.attacks) {
      if (add.attacks.disadvantageVs) out.attacks.disadvantageVs = true;
      if (add.attacks.advantageVs) out.attacks.advantageVs = true;
      for (const c of (add.attacks.cantTarget ?? [])) {
        const t = String(c).toLowerCase();
        if (!out.attacks.cantTarget.includes(t)) out.attacks.cantTarget.push(t);
      }
    }

    // death — booleans OR
    if (add.death) {
      if (add.death.wardActive) out.death.wardActive = true;
    }

    // AC bonus — SUM
    if (add.ac?.bonus) out.ac.bonus = (out.ac.bonus ?? 0) + Number(add.ac.bonus ?? 0);

    // HP max bonus — SUM
    if (add.hp?.maxBonus) out.hp.maxBonus = (out.hp.maxBonus ?? 0) + Number(add.hp.maxBonus ?? 0);

    // Stat overrides — MAX (Belt of Giant Strength etc.)
    if (add.stats) {
      out.stats = out.stats ?? {};
      for (const [stat, value] of Object.entries(add.stats)) {
        out.stats[stat] = Math.max(out.stats[stat] ?? 0, Number(value ?? 0));
      }
    }

    // special — copy through (caller checks specific flags)
    if (add.special) {
      out.special = out.special ?? {};
      for (const [k, v] of Object.entries(add.special)) {
        out.special[k] = v; // last-write-wins; sources are tracked via specialSources
        out.specialSources = out.specialSources ?? {};
        if (!out.specialSources[k]) out.specialSources[k] = [];
        if (!out.specialSources[k].includes(sourceName)) out.specialSources[k].push(sourceName);
      }
    }

    // Track every source for diagnostics + the damage card
    if (!out._matchedSources.includes(sourceName)) out._matchedSources.push(sourceName);
  }

  static _emptyNullifications() {
    return {
      spellImmune: [],
      spellImmuneSources: {},
      damage: {},
      damageSources: {},
      saves: { advantage: [], disadvantage: [], autoPass: [], autoFail: [], bonus: {} },
      conditions: { immune: [] },
      attacks: { disadvantageVs: false, advantageVs: false, cantTarget: [] },
      death: { wardActive: false },
      ac: { bonus: 0 },
      hp: { maxBonus: 0 },
      stats: {},
      special: {},
      specialSources: {},
      _matchedSources: [],
    };
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  static _actorLevel(actor, classMatch) {
    if (!actor?.items) return 0;
    if (!classMatch) return actor.system?.details?.level ?? 0;

    // classMatch: a string (e.g. "Rogue") or array of strings — find class items
    const matches = Array.isArray(classMatch) ? classMatch : [classMatch];
    const matchSet = new Set(matches.map(m => String(m).toLowerCase()));
    let lvl = 0;
    for (const item of actor.items) {
      if (item.type !== "class") continue;
      const name = String(item.name ?? "").toLowerCase();
      if (matchSet.has(name)) lvl += Number(item.system?.levels ?? 0);
    }
    return lvl;
  }
}
