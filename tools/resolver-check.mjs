// ─── Does the resolver put the Dexterity behind the rapier? ──────────────────
//
// ⚠️🔴 WHAT THIS IS PROVING. Neither profile can answer this alone. The rapier
// reports `finesse: true` and asks for no ability. The fighter reports STR +2
// and DEX +4. Only the pairing produces "+4, because finesse takes the better
// one" — and until 2026-08-26 there was nowhere in ACE that pairing lived, so
// every pipeline worked it out again, differently.
//
// Johnny, 2026-08-25: "That puts the dexterity behind the rapier attack... Does
// his strength matter when it's a rapier because he's using it as a finesse
// weapon? Strength doesn't matter in this case. His DEX does."
//
// ⚠️ EVERY CASE ASSERTS THE REASON, NOT JUST THE NUMBER. A resolver that
// returns 4 for the wrong reason will return the wrong number the moment the
// weapon changes. The `because` string is the part that has to be right.
//
// ⚠️ THE RESOLVER IS IMPORTED, NEVER RETYPED.
//
// Run:  node tools/resolver-check.mjs
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const { resolveAbility, resolveProficiency, resolveMastery, resolveGate, resolveAttack } =
  await import(pathToFileURL(path.join(here, "..", "scripts", "profiles", "resolver.mjs")).href);

/** A minimal attacker profile, shaped like the real one. */
const attacker = (o = {}) => ({
  name: o.name ?? "Jeth",
  canAct: o.canAct ?? true,
  cannotActBecause: o.cannotActBecause ?? "",
  gate: o.gate ?? { ok: true },
  edition: o.edition ?? "2014",
  prof: o.prof ?? 3,
  casterLevel: o.casterLevel ?? 0,
  casterLevelSource: o.casterLevelSource ?? "n/a",
  abilityMod: (k) => (o.mods ?? { str: 2, dex: 4 })[k] ?? 0,
  // ⚠️ dnd5e's REAL keys, taken from his character sheets: "sim" and "mar".
  // A bench that used the long words would pass while the shipped code matched
  // nothing on live data.
  weaponProficiencies: new Set(o.weaponProfs ?? ["sim", "mar"]),
  masteryWeapons: new Set(o.masteries ?? []),
  creature: { spellcasting: o.spellcasting ?? null, di: new Set(), dr: new Set(), dv: new Set() },
  resources: { spellSlots: o.slots ?? {} },
});

/** A minimal attack profile. */
const attack = (o = {}) => ({
  name: o.name ?? "Rapier +3",
  isSpell: o.isSpell ?? false,
  isCantrip: o.isCantrip ?? false,
  rollsToHit: o.rollsToHit ?? true,
  attackKind: o.attackKind ?? "mwak",
  abilityOverride: o.abilityOverride ?? null,
  // ⚠️ dnd5e's COMPUTED answer. The bench supplies it because the resolver
  // defers to it — a bench that omitted it would be testing the fallback and
  // reporting it as the primary.
  abilitySystemResolved: o.abilitySystemResolved ?? null,
  abilitiesAvailable: o.abilitiesAvailable ?? [],
  finesse: o.finesse ?? false,
  magicBonus: o.magicBonus ?? 0,
  baseItem: o.baseItem ?? "rapier",
  proficiencyRequired: o.proficiencyRequired ?? "martial",
  itemProficiency: o.itemProficiency ?? null,
  masteryDeclared: o.masteryDeclared ?? null,
  damageParts: o.damageParts ?? [],
  reachFt: o.reachFt ?? 5,
  rangeNormal: o.rangeNormal ?? 0,
  rangeLong: o.rangeLong ?? 0,
  consumesSpellSlot: o.consumesSpellSlot ?? false,
  spellLevel: o.spellLevel ?? null,
  components: o.components ?? { v: true, s: true, m: false },
  // ⚠️ INJECTED, so the bench can test the pact rule without standing up
  // Foundry. In the game this is looked up through game.aceQol.
  abilityOverrideRule: o.abilityOverrideRule ?? null,
});

let ok = true;
const check = (title, got, want, why) => {
  const pass = Object.entries(want).every(([k, v]) =>
    typeof v === "string" ? String(got[k] ?? "").includes(v) : got[k] === v);
  if (!pass) ok = false;
  console.log("");
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${title}`);
  for (const [k, v] of Object.entries(got)) {
    if (want[k] !== undefined) console.log(`        ${k}: ${JSON.stringify(v)}`);
  }
  console.log(`        ${why}`);
  if (!pass) console.log(`        EXPECTED ${JSON.stringify(want)}`);
};

console.log("");
console.log("THE RESOLVER — WHICH ABILITY, AND WHY?");
console.log("=".repeat(78));

check("Jeth's finesse rapier: STR +2, DEX +4 (dnd5e resolved it)",
  resolveAbility(attack({ finesse: true, abilitySystemResolved: "dex",
                          abilitiesAvailable: ["str", "dex"] }), attacker()),
  { ability: "dex", abilityMod: 4, because: "finesse" },
  "the rapier does not know whose hand it is in; the fighter does not know the weapon is finesse");

check("The same fighter, a NON-finesse greatsword",
  resolveAbility(attack({ finesse: false, baseItem: "greatsword",
                          abilitySystemResolved: "str" }), attacker()),
  { ability: "str", abilityMod: 2, because: "STR" },
  "no finesse, so Strength — even though Dexterity is higher");

check("A finesse weapon in the hands of a STRONGER fighter",
  resolveAbility(attack({ finesse: true, abilitySystemResolved: "str",
                          abilitiesAvailable: ["str", "dex"] }), attacker({ mods: { str: 5, dex: 1 } })),
  { ability: "str", abilityMod: 5, because: "finesse" },
  "finesse takes the BETTER one, which is not always Dexterity");

check("A Battle Smith's weapon that asks for INT outright",
  resolveAbility(attack({ abilityOverride: "int", abilitySystemResolved: "int", finesse: true }),
                 attacker({ mods: { str: 2, dex: 4, int: 5 } })),
  { ability: "int", abilityMod: 5, because: "overrides to INT" },
  "an explicit request beats the finesse rule");

check("The Lich's Eldritch Blast",
  resolveAbility(attack({ isSpell: true, attackKind: "rsak", baseItem: null,
                          abilitySystemResolved: "cha" }),
                 attacker({ spellcasting: "cha", mods: { cha: 9 } })),
  { ability: "cha", abilityMod: 9, because: "spell attack" },
  "a spell attack uses the caster's own spellcasting ability");

check("An old item shape where dnd5e resolves nothing",
  resolveAbility(attack({ finesse: true, abilitySystemResolved: null }), attacker()),
  { ability: "dex", abilityMod: 4, because: "dnd5e resolved no ability" },
  "ACE's ladder answers and says it had to — the fallback never pretends to be the primary");

check("The system and ACE DISAGREE — reported, never silently resolved",
  resolveAbility(attack({ finesse: true, abilitySystemResolved: "str",
                          abilitiesAvailable: ["str", "dex"] }), attacker({ mods: { str: 1, dex: 4 } })),
  { ability: "str", disagreement: "ACE would have chosen DEX" },
  "the system wins, but the divergence is on the record instead of buried");

check("A Hexblade warlock: CHA 20, STR 8, swinging a longsword",
  resolveAbility(attack({ finesse: false, abilitySystemResolved: "str", baseItem: "longsword",
      abilityOverrideRule: { ability: "cha", mod: 5, why: "Hex Warrior" } }),
    attacker({ mods: { str: -1, dex: 1, cha: 5 } })),
  { ability: "cha", abilityMod: 5, because: "Hex Warrior", overrodeSystem: true },
  "dnd5e offers only STR for a longsword — Charisma is a CHARACTER rule it cannot see");

check("The same warlock when Strength is actually BETTER",
  resolveAbility(attack({ finesse: false, abilitySystemResolved: "str", baseItem: "longsword",
      abilityOverrideRule: { ability: "cha", mod: 1, why: "Pact of the Blade" } }),
    attacker({ mods: { str: 5, cha: 1 } })),
  { ability: "str", abilityMod: 5 },
  "RAW says the warlock CAN use Charisma, not must — nobody picks the worse modifier");

console.log("");
console.log("PROFICIENCY — DOES THE BONUS APPLY?");
console.log("=".repeat(78));

check("Ireena: her sheet lists only [sim, mar], swinging a rapier",
  resolveProficiency(attack(), attacker()),
  { applies: true, bonus: 3, because: 'martial weapons ("mar")' },
  "dnd5e stores the categories abbreviated — the long words match nothing");

check("Jeth: [sim, rapier, scimitar, ...] — the weapon named specifically",
  resolveProficiency(attack({ baseItem: "rapier" }),
                     attacker({ weaponProfs: ["sim", "rapier", "scimitar", "longbow"] })),
  { applies: true, bonus: 3, because: "trained with rapier specifically" },
  "a specific weapon beats needing the whole category");

check("A NON-proficient magic battleaxe (live, 2026-08-13)",
  resolveProficiency(attack({ itemProficiency: { hasProficiency: false, flat: 0 } }), attacker()),
  { applies: false, bonus: 0, because: "the item itself says" },
  "the item's own block outranks the category — the card was adding PROF anyway");

check("A monster with no proficiency traits at all, using its own claws",
  resolveProficiency(attack({ proficiencyRequired: "natural", baseItem: null }),
                     attacker({ weaponProfs: [] })),
  { applies: true, bonus: 3, because: "no weapon proficiencies at all" },
  "an empty trait list is not a statement that a bear cannot use its own paws");

check("A wizard swinging a martial weapon they never learned",
  resolveProficiency(attack(), attacker({ weaponProfs: ["sim"] })),
  { applies: false, bonus: 0, because: "not trained" },
  "trained with simple weapons only");

console.log("");
console.log("MASTERY — OFFERED BY THE WEAPON, LEARNED BY THE CREATURE");
console.log("=".repeat(78));

check("2024 table, Vex rapier, trained with rapiers",
  resolveMastery(attack({ masteryDeclared: "vex" }),
                 attacker({ edition: "2024", masteries: ["rapier"] })),
  { applies: true, mastery: "vex", because: "trained in mastery with rapier" },
  "both halves true, so it applies");

check("2024 table, Vex rapier, NOT trained with rapiers",
  resolveMastery(attack({ masteryDeclared: "vex" }),
                 attacker({ edition: "2024", masteries: ["longsword"] })),
  { applies: false, because: "has not trained mastery with rapier" },
  "the weapon offers it; the creature never learned it");

check("2014 table, an imported item that carries a mastery field",
  resolveMastery(attack({ masteryDeclared: "vex" }),
                 attacker({ edition: "2014", masteries: ["rapier"] })),
  { applies: false, because: "2024 rule" },
  "mastery does not exist on a 2014 table, whatever the import put on the item");

console.log("");
console.log("THE GATE — CAN IT GO AHEAD AT ALL?");
console.log("=".repeat(78));

check("A dead attacker",
  resolveGate(attack(), attacker({ canAct: false, cannotActBecause: "dead" }), null, null),
  { ok: false, because: "cannot act: dead" },
  "the dead Specter, refused by name");

check("A verbal spell cast inside Silence",
  resolveGate(attack({ isSpell: true }), attacker(), { attackerSilenced: true }, null),
  { ok: false, because: "silenced space" },
  "a fact about the SPACE, not about the caster");

check("An ordinary swing",
  resolveGate(attack(), attacker(), { attackerSilenced: false }, null),
  { ok: true },
  "nothing in the way");

console.log("");
console.log("THE WHOLE PLAN — ONE RAPIER SWING, NO DICE");
console.log("=".repeat(78));

const plan = resolveAttack({
  attacker: attacker({ edition: "2024", masteries: ["rapier"] }),
  attack: attack({ finesse: true, abilitySystemResolved: "dex",
    abilitiesAvailable: ["str", "dex"], magicBonus: 3, masteryDeclared: "vex",
    damageParts: [{ number: 1, denomination: 8, bonus: "", types: ["piercing"], source: "the activity" }] }),
  environment: { distanceFt: 5, gridUnits: "ft", coverAcBonus: 0, coverLevel: "No Cover",
    elevationDeltaFt: 0, attackerSilenced: false },
  target: { name: "Gorath", ac: 15, isDead: false, creature: { di: new Set(), dr: new Set(), dv: new Set() } },
});

const wantBonus = 4 + 3 + 3;   // DEX 4, prof 3, magic 3
const planOk = plan.ok && plan.attackBonus === wantBonus && plan.ability === "dex"
  && plan.effectiveAC === 15 && plan.inRange === true && plan.masteryApplies === true;
if (!planOk) ok = false;
console.log("");
console.log(`  ${planOk ? "PASS" : "FAIL"}  every number settled before a die is thrown`);
console.log(`        +${plan.attackBonus} to hit: `
  + plan.attackBonusParts.map(p => `${p.value >= 0 ? "+" : ""}${p.value} ${p.label}`).join(", "));
console.log(`        ability: ${plan.ability} — ${plan.abilityBecause}`);
console.log(`        vs AC ${plan.effectiveAC} · ${plan.rangeBecause}`);
console.log(`        mastery: ${plan.masteryBecause}`);
if (!planOk) console.log(`        EXPECTED +${wantBonus}, dex, AC 15, in range, mastery applies`);

console.log("");
console.log("=".repeat(78));
console.log(ok
  ? "ALL PASS — the resolver answers what neither profile could answer alone."
  : "FAILURES ABOVE");
process.exit(ok ? 0 : 1);
