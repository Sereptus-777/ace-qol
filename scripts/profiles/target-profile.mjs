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

    // ── ACCESSORS (2026-07-28) ─────────────────────────────────────────────
    // The profile previously exposed only raw structures, so every consumer
    // had to know where a fact lived and dig for it — which is exactly how six
    // different files ended up each reading condition immunity their own way,
    // and how the save pipeline ended up reading none of them. A profile that
    // can't ANSWER QUESTIONS is just a second copy of the actor. Ask it.
    //
    // These are methods, so they don't survive serialization — same contract
    // as `ref` and `token` above. The data fields remain the serializable core.

    /**
     * Is this creature immune to a condition? Checks the structured immunity
     * list AND the free-text custom field, which the structured reader drops —
     * a statblock that writes "petrification" in the custom box is still immune.
     */
    immuneToCondition(conditionId) {
      const id = String(conditionId ?? "").toLowerCase().trim();
      if (!id) return false;
      try {
        if (creature.ci?.has?.(id)) return true;
        const custom = String(sys.traits?.ci?.custom ?? "").toLowerCase();
        if (custom && custom.includes(id)) return true;
        // "petrification" in prose vs the "petrified" status id, and friends.
        const PROSE = {
          petrified: "petrification", paralyzed: "paralysis", poisoned: "poison",
          frightened: "frightened", charmed: "charm", stunned: "stun",
          blinded: "blind", deafened: "deafen", exhaustion: "exhaustion",
        };
        const alt = PROSE[id];
        if (alt && custom.includes(alt)) return true;
      } catch (_) { /* fall through */ }
      return false;
    },

    /** This creature's total modifier for a saving throw. */
    saveMod(ability) {
      const k = String(ability ?? "").toLowerCase();
      return Number(this.saves?.[k] ?? 0) || 0;
    },

    /**
     * RAW: Petrified, Paralyzed, Stunned and Unconscious all auto-fail Strength
     * and Dexterity saving throws. Asking the profile means every pipeline gets
     * this right instead of each one remembering (or not).
     */
    autoFailsSave(ability) {
      const k = String(ability ?? "").toLowerCase();
      if (k !== "str" && k !== "dex") return false;
      const c = creature.conditions ?? [];
      const has = (s) => (c.includes?.(s) ?? false) || (c.has?.(s) ?? false);
      return has("petrified") || has("paralyzed") || has("stunned") || has("unconscious");
    },


    /** Ability modifier. */
    abilityMod(key) { return Number(creature.abilities?.[String(key ?? "").toLowerCase()]?.mod ?? 0) || 0; },
    /** Raw ability score (for DCs computed off the score, not the mod). */
    abilityScore(key) { return Number(creature.abilities?.[String(key ?? "").toLowerCase()]?.score ?? 10) || 10; },
    /** Proficiency bonus. */
    get prof() { return Number(creature.prof ?? 0) || 0; },
    /** Exhaustion level. */
    get exhaustion() { return Number(creature.exhaustion ?? 0) || 0; },
    /** Size key ("tiny"|"sm"|"med"|"lg"|"huge"|"grg"). */
    get size() { return String(creature.size ?? "med"); },
    /** Creature type ("undead", "construct", …). */
    get creatureType() { return String(creature.type ?? ""); },
    /** Armour proficiencies, as a Set. */
    get armorProf() { return creature.armorProf ?? new Set(); },
    /** Current / max / temp hit points. */
    get hitPoints() { return creature.hp ?? { value: 0, max: 0, temp: 0 }; },
    /** Does this creature have a condition right now? */
    hasCondition(id) {
      const s = String(id ?? "").toLowerCase();
      const c = creature.conditions ?? [];
      return (c.includes?.(s) ?? false) || (c.has?.(s) ?? false);
    },

    /** Magic Resistance — advantage on saves against spells and magical effects. */
    get magicResistant() { return !!creature.magicResistance; },

    /** Remaining legendary resistances. */
    get legendaryResistances() { return Number(creature.legendaryResistance ?? 0) || 0; },

    // ── LIVENESS (2026-08-06, THE ONE GATE phase 0) ────────────────────────
    // A dead Specter rolled two saving throws against Petrifying Gaze and was
    // then told it was immune to the result. The save engine had never asked
    // whether the target was alive — every HP read in it existed to draw the
    // skull glyph and the HP arrow AFTER the roll.
    //
    // ⚠️ 0 HP IS NOT THE SAME THING AS DEAD, and getting this wrong breaks
    // the game in the opposite direction. RAW, both 2014 and 2024:
    //   • A MONSTER at 0 HP dies (unless the GM rules otherwise).
    //   • A PLAYER CHARACTER at 0 HP falls UNCONSCIOUS and is dying — still a
    //     legal target, still rolls saves, and auto-fails STR/DEX because it
    //     is unconscious (see autoFailsSave above). Gating PCs on HP would
    //     silently stop a downed party member being affected by anything,
    //     which is a worse bug than the one being fixed.
    // So the HP branch applies to NPCs only; the explicit `dead` marker
    // applies to everyone.

    /**
     * Is this creature dead? The `dead` status (what Foundry sets when a
     * combatant is marked defeated) is authoritative for anyone. Falling to
     * 0 HP additionally means death for non-player creatures.
     */
    get isDead() {
      if (this.hasCondition("dead")) return true;
      if (this.isPC) return false;              // downed PC ≠ dead — see above
      return (Number(this.hp?.value ?? 0) || 0) <= 0;
    },

    /**
     * Can this creature take an action or reaction right now? Not the same
     * question as `isDead` — an unconscious or paralyzed creature is alive and
     * can still be forced to make saving throws, but cannot ACT. Reaction-based
     * resolution (counterspell, Shield, Absorb Elements) must ask this one.
     */
    get canAct() {
      if (this.isDead) return false;
      return !(this.hasCondition("unconscious") || this.hasCondition("paralyzed")
            || this.hasCondition("stunned")     || this.hasCondition("petrified")
            || this.hasCondition("incapacitated"));
    },
  };
}
