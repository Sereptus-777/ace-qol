// ─── ACE: QOL — Spell Registry: Attack-Multi Shape ────────────────────────────
// Shape = N units, each requiring its OWN ranged spell attack roll, split
// across targets Magic-Missile-style (the Phase 4 promise from v0.7.74).
//
// The picker is the distribute +/- counter UI; the resolver rolls one d20 per
// unit against its target's AC (advantage/disadvantage fed by CombatState's
// situational brain — darkness, devil's sight, prone, the works), posts a
// volley card with every to-hit visible, then routes the beams that HIT into
// the normal damage-card flow (player-rolls-own + GM-guarded apply).
//
// RAW anchors:
//   • Eldritch Blast (2014 + 2024): "a beam... at higher levels: two beams at
//     5th level, three at 11th, four at 17th. You can direct the beams at the
//     same target or at different ones. Make a separate attack roll for each."
//     CHARACTER level, not slot level — it's a cantrip.
//   • Scorching Ray (2014 + 2024): "three rays... make a ranged spell attack
//     for each ray" — +1 ray per slot level above 2nd.
//   • Crits double the unit's DICE (baked per crit beam by the resolver).
//   • Agonizing Blast adds CHA per beam ON A HIT (resolver adds it per hit).
// ──────────────────────────────────────────────────────────────────────────────

export const ATTACK_MULTI_SPELLS = {

  "eldritch blast": {
    shape: "attack-multi",
    range: 120,
    // Cantrip — beam count scales by CHARACTER level (1 / 2@5 / 3@11 / 4@17).
    countResolver: (_castLevel, charLevel) => {
      const L = Number(charLevel) || 1;
      return L >= 17 ? 4 : L >= 11 ? 3 : L >= 5 ? 2 : 1;
    },
    unit: { formula: "1d10", type: "force", attackRoll: true },
    unitNoun: "beam",
    picker: { allowSelf: false, excludeDead: true },
    schoolIcon: "icons/magic/lightning/bolt-strike-purple.webp",
    flavorOnConfirm: "Crackling beams of eldritch energy — a separate ranged spell attack per beam.",
  },

  "scorching ray": {
    shape: "attack-multi",
    range: 120,
    // 3 rays at 2nd; +1 per slot level above 2nd (both editions).
    countResolver: (castLevel) => 3 + Math.max(0, (Number(castLevel) || 2) - 2),
    unit: { formula: "2d6", type: "fire", attackRoll: true },
    unitNoun: "ray",
    picker: { allowSelf: false, excludeDead: true },
    schoolIcon: "icons/magic/fire/beam-jet-stream-embers.webp",
    flavorOnConfirm: "Rays of fire streak toward their marks — a separate ranged spell attack per ray.",
  },
};

/** Validate one attack-multi entry — shape, unit, resolver sanity. */
export function validateAttackMultiEntry(name, e) {
  const problems = [];
  if (e.shape !== "attack-multi") problems.push(`${name}: shape must be "attack-multi"`);
  if (typeof e.countResolver !== "function") problems.push(`${name}: countResolver required`);
  if (!e.unit?.formula) problems.push(`${name}: unit.formula required`);
  if (!e.unit?.type) problems.push(`${name}: unit.type required`);
  if (e.unit?.attackRoll !== true) problems.push(`${name}: unit.attackRoll must be true (that's the whole shape)`);
  if (!Number.isFinite(e.range) || e.range <= 0) problems.push(`${name}: range must be a positive number`);
  if (!e.unitNoun) problems.push(`${name}: unitNoun required (beam/ray — drives the picker copy)`);
  return problems;
}

export function validateAllAttackMultiSpells() {
  const problems = [];
  for (const [name, e] of Object.entries(ATTACK_MULTI_SPELLS)) {
    problems.push(...validateAttackMultiEntry(name, e));
  }
  return problems;
}
