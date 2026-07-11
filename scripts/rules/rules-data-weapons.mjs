// ─── ACE: QOL — Rules Data: Weapons (weapons converge onto the brain) ─────────
//
// Weapon quirks as DATA, served by the same deterministic lookup the spells
// use. Two new entry fields (schema v2):
//
//   attack: {                       // consumed by CombatState.assess
//     disadvantageWithinFt: 5,      // Lance: disadvantage inside this range
//   }
//   onHit: [                        // consumed by the post-hit flow — applied
//     { type: "condition",          // to every HIT target, immunity-checked,
//       condition: "restrained",    // NO save (save-gated effects use
//       note: "escape …" }          // postHitSave instead)
//   ]
//   postHitSave: {                  // authoritative save spec — OVERRIDES the
//     dc: 11, ability: "con",       // description parser when present. Same
//     failEffect: [...],            // normalized bag the parser produces, so
//     halfOnSuccess: true,          // it flows the one existing path.
//   }
//
// SRD weapon properties (finesse, reach, thrown, versatile…) stay with dnd5e
// and the attack pipeline — entries here are only for quirks the system does
// NOT model.
// ──────────────────────────────────────────────────────────────────────────────

export const WEAPON_RULES = {

  // ── Net — SRD ────────────────────────────────────────────────────────────────
  // "A Large or smaller creature hit by a net is restrained until it is freed.
  //  … A creature can use its action to make a DC 10 Strength check, freeing
  //  itself or another creature within its reach on a success. Dealing 5
  //  slashing damage to the net (AC 10) also frees the creature."
  // A hit does NO damage — the restraint IS the weapon. Huge+ creatures and
  // formless ones are unaffected (v1 applies to all; GM adjudicates size —
  // noted so the whisper says so).
  "net": {
    srd: true,
    weapon: true,
    onHit: [
      { type: "condition", condition: "restrained", note: "escape: action, DC 10 STR check — or deal 5 slashing to the net (AC 10)" },
    ],
    notes: "Large or smaller targets only (RAW) — GM releases oversized catches. No damage on hit; no effect on a miss.",
  },

  // ── Lance — SRD (2014 wording) ──────────────────────────────────────────────
  // "You have disadvantage when you use a lance to attack a target within
  //  5 feet of you. Also, a lance requires two hands to wield when you aren't
  //  mounted."
  "lance": {
    srd: true,
    weapon: true,
    attack: { disadvantageWithinFt: 5 },
    notes: "Two-hands-unless-mounted is not modeled (mount state unreadable v1). 2024 replaced this quirk with weapon mastery — the entry is edition-shared until that diverges in play.",
  },
};

/** Light validation for weapon entries — mirrors the spell validator's spirit. */
export function validateWeaponRuleEntry(name, entry) {
  const problems = [];
  if (!entry || typeof entry !== "object") return [`${name}: entry is not an object`];
  if (entry.attack?.disadvantageWithinFt != null && !(Number(entry.attack.disadvantageWithinFt) > 0))
    problems.push(`${name}: attack.disadvantageWithinFt must be a positive number`);
  for (const fx of (entry.onHit ?? [])) {
    if (fx.type === "condition" && !fx.condition) problems.push(`${name}: onHit condition entry missing condition`);
    if (fx.type === "damage" && !fx.formula) problems.push(`${name}: onHit damage entry missing formula`);
  }
  if (entry.postHitSave && (!(Number(entry.postHitSave.dc) > 0) || !entry.postHitSave.ability))
    problems.push(`${name}: postHitSave needs dc>0 + ability`);
  return problems;
}

export function validateAllWeaponRules() {
  const all = [];
  for (const [name, entry] of Object.entries(WEAPON_RULES)) {
    all.push(...validateWeaponRuleEntry(name, entry));
  }
  return all;
}
