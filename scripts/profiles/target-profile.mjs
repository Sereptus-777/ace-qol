// ─── ACE: QOL — Target Profile (Phase 0 of the rules engine) ──────────────────
//
// The defense-side twin of attacker-profile: the formalized "who is being
// acted on" snapshot. Same design contract:
//
//   • PURE + READ-ONLY — building never mutates, rolls, or writes.
//   • NO NEW RULES LOGIC — assembled from the proven readers
//     (Situation.readCreature for the creature snapshot; dnd5e system data
//     for AC/HP). CombatState.assess remains the PAIRWISE evaluator
//     (advantage/disadvantage between a specific attacker and this target);
//     this profile is the target's own state independent of any attacker.
//   • NULL-SAFE + SERIALIZABLE CORE (live refs carried separately).
//
// Consumers today: the interceptor audit (Phase 0) and the rules brain
// (Phase 1). Phase 2's sight evaluator reads creature.senses from here when
// deciding who can see whom through obscured spaces.
// ──────────────────────────────────────────────────────────────────────────────

import { Situation } from "../situation.mjs";

/**
 * Build the target-side profile for one creature.
 *
 * @param {Actor5e} actor                          the targeted creature
 * @param {object}  opts
 * @param {Token|TokenDocument} [opts.token]       its token (resolved if omitted)
 * @returns {object|null} the TargetProfile, or null when there is no actor
 */
export function buildTargetProfile(actor, { token = null } = {}) {
  if (!actor) return null;

  const creature = Situation.readCreature(actor, token) ?? {};
  const resolvedToken = creature.token ?? token ?? null;
  const sys = actor.system ?? {};

  return {
    kind: "target-profile",
    schema: 1,

    // identity
    actorId: actor.id ?? null,
    actorUuid: actor.uuid ?? null,
    tokenId: resolvedToken?.id ?? resolvedToken?.document?.id ?? null,
    name: creature.name ?? actor.name ?? "Creature",
    isPC: actor.type === "character",
    disposition: resolvedToken?.document?.disposition ?? resolvedToken?.disposition ?? null,

    // live references (same-client only — NOT serializable)
    ref: actor,
    token: resolvedToken,

    // the full creature snapshot — conditions, senses, speeds,
    // damage/condition traits (di/dr/dv/ci), magic + legendary resistance,
    // concentration — Situation.readCreature's shape
    creature,

    // core defense numbers (base values; cover and situational AC deltas are
    // pairwise facts and stay with CombatState.assess / CoverEngine)
    ac: Number(sys.attributes?.ac?.value ?? 10) || 10,
    hp: {
      value: Number(sys.attributes?.hp?.value ?? 0) || 0,
      max: Number(sys.attributes?.hp?.max ?? 0) || 0,
      temp: Number(sys.attributes?.hp?.temp ?? 0) || 0,
    },

    // saving-throw modifiers by ability — plain data for save executors
    saves: Object.fromEntries(
      Object.entries(sys.abilities ?? {}).map(([k, a]) => [k, Number(a?.save?.value ?? a?.save ?? a?.mod ?? 0) || 0])
    ),
  };
}
