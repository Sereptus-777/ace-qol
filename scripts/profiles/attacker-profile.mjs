// ─── ACE: QOL — Attacker Profile (Phase 0 of the rules engine) ────────────────
//
// THE formalized "who is acting, with what" snapshot. This is the stable,
// documented vocabulary every rules-engine layer speaks — the rules brain,
// the sight evaluator, the interceptor audit, and (eventually) the executors
// all read THIS shape instead of poking at raw actor/item internals.
//
// DESIGN CONTRACT (Phase 0):
//   • PURE + READ-ONLY. Building a profile never mutates anything, never
//     rolls anything, never writes a flag. It only LOOKS.
//   • NO NEW RULES LOGIC. Every field is assembled from the proven readers —
//     Situation.readCreature (creature snapshot), CombatContext (gates,
//     components, edition), CombatState (edition resolution). This file
//     formalizes their OUTPUT; it does not re-derive anything. When a reader
//     improves, every profile consumer improves for free.
//   • NULL-SAFE. A missing actor/item yields a minimal-but-valid profile;
//     consumers never need to guard every field.
//   • SERIALIZABLE CORE. `ref`/`token` carry live documents for same-client
//     consumers; everything else is plain data safe to ship over the socket
//     (the GM enforces, players trigger — profiles must survive the crossing).
//
// Fields are grouped: identity → edition → creature → action → gates.
// ──────────────────────────────────────────────────────────────────────────────

import { CombatState } from "../combat-state.mjs";
import { CombatContext } from "../combat-context.mjs";
import { Situation } from "../situation.mjs";

/**
 * Build the attacker-side profile for one action.
 *
 * @param {Actor5e} actor              the acting creature
 * @param {object}  opts
 * @param {Token|TokenDocument} [opts.token]     acting token (resolved if omitted)
 * @param {Item5e}  [opts.item]                  the weapon / spell / feature being used
 * @param {Activity} [opts.activity]             the dnd5e activity (when available)
 * @returns {object|null} the AttackerProfile, or null when there is no actor
 */
export function buildAttackerProfile(actor, { token = null, item = null, activity = null } = {}) {
  if (!actor) return null;

  // ── creature snapshot — the proven reader owns this ──
  const creature = Situation.readCreature(actor, token) ?? {};
  const resolvedToken = creature.token ?? token ?? null;

  // ── edition — actor-aware (ACE override → dnd5e setting → marker sniff) ──
  let edition = "2014";
  try { edition = CombatState.getActiveEdition(actor) ?? "2014"; } catch (_) {}

  // ── action normalization — plain facts about WHAT is being used ──
  const sys = item?.system ?? {};
  const action = item ? {
    name: item.name ?? "",
    normalizedName: String(item.name ?? "").toLowerCase().trim(),
    uuid: item.uuid ?? null,
    itemType: item.type ?? "",                       // "weapon" | "spell" | "feat" | ...
    activityType: activity?.type ?? null,            // "attack" | "save" | "damage" | "utility" | ...
    activationType: activity?.activation?.type ?? sys.activation?.type ?? null,
    isSpell: item.type === "spell",
    isWeapon: item.type === "weapon",
    level: Number(sys.level ?? 0) || 0,              // spell level (0 = cantrip / non-spell)
    school: sys.school ?? null,
    // The feature's OWN edition outranks the world's (mixed-edition worlds are
    // real — the Pact of the Blade lesson, 2026-07-09).
    sourceRules: String(sys.source?.rules ?? "") || null,
    concentration: !!(sys.properties?.has?.("concentration") || sys.duration?.concentration),
    components: CombatContext._components(item),      // { v, s, m }
    // Target/area declaration as dnd5e knows it — the rules entry may disagree;
    // that disagreement is exactly what the discrepancy report surfaces.
    target: {
      templateType: sys.target?.template?.type ?? null,   // "sphere" | "cube" | "cone" | ...
      templateSize: Number(sys.target?.template?.size ?? 0) || null,  // ft
      affectsType: sys.target?.affects?.type ?? null,
    },
    range: {
      value: Number(sys.range?.value ?? 0) || null,
      units: sys.range?.units ?? null,
    },
  } : null;

  // ── hard gates — CAN this creature act at all? (shared brain) ──
  let gate = { ok: true };
  try {
    gate = CombatContext.canAct(actor, {
      isSpell: item?.type === "spell",
      item,
      activationType: action?.activationType ?? "action",
    }) ?? { ok: true };
  } catch (_) {}

  return {
    kind: "attacker-profile",
    schema: 1,

    // identity
    actorId: actor.id ?? null,
    actorUuid: actor.uuid ?? null,
    tokenId: resolvedToken?.id ?? resolvedToken?.document?.id ?? null,
    name: creature.name ?? actor.name ?? "Creature",
    isPC: actor.type === "character",
    disposition: resolvedToken?.document?.disposition ?? resolvedToken?.disposition ?? null,

    // rules context
    edition,                                          // "2014" | "2024"

    // live references (same-client consumers only — NOT serializable)
    ref: actor,
    token: resolvedToken,

    // the full creature snapshot (conditions, senses incl. devilsSight,
    // speeds, defenses, concentration) — Situation.readCreature's shape
    creature,

    // what they're doing
    action,

    // can they even do it
    gate,
  };
}
