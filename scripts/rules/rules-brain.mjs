// ─── ACE: QOL — Rules Brain (Phase 1: deterministic rules lookup) ─────────────
//
// The ONE place that answers "what do the RULES say this does?" — by lookup,
// never by inference. Design rules (agreed 2026-07-09, the architecture review):
//
//   • DETERMINISTIC. A spell is identified by normalized name + edition. No
//     pattern matching, no confidence scores, no clever guessing — guessing is
//     how silent wrong behavior happens (the Frostbite lesson).
//   • UNKNOWN = HANDS OFF. No entry → return null → callers run dnd5e's
//     default behavior UNCHANGED, and we log a coverage gap (once per name per
//     session, debug level). We never silently enforce an inference.
//   • EDITION: the ITEM'S own stated ruleset outranks the world's — mixed-
//     edition worlds are real (the Pact of the Blade lesson: a legacy-flagged
//     world whose PCs carry 2024-sourced features). Fallback is the actor-aware
//     world edition (ACE override → dnd5e setting → marker sniff).
//   • Entries may carry byEdition overrides; the brain returns the entry
//     already MERGED for the resolved edition, so consumers never re-resolve.
// ──────────────────────────────────────────────────────────────────────────────

import { MODULE_ID } from "../ace-qol.mjs";
import { CombatState } from "../combat-state.mjs";
import { SPELL_RULES, validateAllSpellRules, RULES_SCHEMA_VERSION } from "./rules-data-spells.mjs";
import { WEAPON_RULES, validateAllWeaponRules } from "./rules-data-weapons.mjs";

export class RulesBrain {

  /** Coverage gaps already logged this session (normalized names). */
  static _gapLogged = new Set();

  /** Normalize an item name into a rules key. Strips decorations that ride on
   *  monster/summon variants — "Darkness (1/Day)", "Darkness (Mirthful Only)",
   *  "Fog Cloud [Legacy]" all resolve to the same rule the plain spell uses.
   *  (The fey's decorated Darkness missing the engine, 2026-07-09.) */
  static normalizeName(name) {
    return String(name ?? "")
      .toLowerCase()
      .replace(/\s*\([^)]*\)\s*/g, " ")   // parentheticals: "(1/day)", "(mirthful only)"
      .replace(/\s*\[[^\]]*\]\s*/g, " ")  // brackets: "[legacy]", "[2024]"
      .replace(/\s+/g, " ")
      .trim();
  }

  /**
   * Resolve the governing edition for this item + actor.
   * The item's own source ruleset wins; else the actor-aware world edition.
   * @returns {"2014"|"2024"}
   */
  static resolveEdition(item, actor = null) {
    try {
      const src = String(item?.system?.source?.rules ?? "");
      if (src === "2024") return "2024";
      if (src === "2014") return "2014";
    } catch (_) {}
    try {
      return CombatState.getActiveEdition(actor ?? item?.actor) === "2024" ? "2024" : "2014";
    } catch (_) { return "2014"; }
  }

  /**
   * THE lookup. Returns the rules record for this item, merged for its
   * edition — or null when the rules model doesn't cover it (callers then
   * leave dnd5e's behavior alone).
   *
   * @param {Item5e} item
   * @param {object} opts   { actor } — for edition resolution
   * @returns {{ name:string, edition:"2014"|"2024", entry:object }|null}
   */
  static lookup(item, { actor = null } = {}) {
    if (!item) return null;
    const name = RulesBrain.normalizeName(item.name);
    if (!name) return null;

    // ── Per-item override — the manual authoring surface (Phase 4 seed) ──
    // A GM (or the Forge, later) can stamp a complete rules entry onto ANY
    // item via a module flag; it outranks the library entirely. This is how
    // odd-named or homebrew content joins the engine today, no code needed.
    try {
      const flagEntry = item.flags?.[MODULE_ID]?.rulesEntry;
      if (flagEntry && typeof flagEntry === "object") {
        return { name, edition: RulesBrain.resolveEdition(item, actor), entry: flagEntry };
      }
    } catch (_) {}

    const raw = SPELL_RULES[name] ?? WEAPON_RULES[name];
    if (!raw) {
      // Coverage gap — only worth noting for actual spells, once per session.
      if (item.type === "spell" && !RulesBrain._gapLogged.has(name)) {
        RulesBrain._gapLogged.add(name);
        console.debug(`${MODULE_ID} | [rules-brain] no rules entry for spell "${item.name}" — dnd5e default behavior stands (coverage gap noted)`);
      }
      return null;
    }

    const edition = RulesBrain.resolveEdition(item, actor);

    // Shallow-merge the edition override over the shared entry. byEdition is
    // rare — most SRD spells are mechanically identical across editions.
    let entry = raw;
    const override = raw.byEdition?.[edition];
    if (override && typeof override === "object") {
      entry = { ...raw, ...override, space: { ...(raw.space ?? {}), ...(override.space ?? {}) } };
    }

    return { name, edition, entry };
  }

  /** Convenience: does this item have a rules entry declaring SPACE properties? */
  static spaceEntry(item, opts = {}) {
    const hit = RulesBrain.lookup(item, opts);
    return hit?.entry?.space ? hit : null;
  }

  /** Boot-time self-check — malformed entries announce themselves at startup. */
  static selfCheck() {
    try {
      const problems = [...validateAllSpellRules(), ...validateAllWeaponRules()];
      if (problems.length) {
        console.warn(`${MODULE_ID} | [rules-brain] rules-data self-check found ${problems.length} problem(s):\n  - ${problems.join("\n  - ")}`);
      } else {
        const ns = Object.keys(SPELL_RULES).length, nw = Object.keys(WEAPON_RULES).length;
        console.log(`${MODULE_ID} | RulesBrain online — schema v${RULES_SCHEMA_VERSION}, ${ns} spell + ${nw} weapon rule entries, self-check clean`);
      }
    } catch (err) {
      console.warn(`${MODULE_ID} | [rules-brain] self-check threw (non-fatal):`, err);
    }
  }
}
