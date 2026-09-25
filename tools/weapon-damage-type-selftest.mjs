// ─── A weapon's damage type comes from `damage.base`, never `damage.parts` ───
//
// ⚠️🔴 THE BUG (proved 2026-09-25). dnd5e 5.3.3's weapon schema is
// `damage: { base, versatile }` (dnd5e.mjs, WeaponData#defineSchema) and its own
// migration lifts the old `parts[0]` into `base`, then discards the list. Of the
// 3,185 weapons in hijinx, 3,185 carry `base` and NOT ONE carries `parts`.
//
// Every read of a weapon's `system.damage.parts` therefore took its fallback in
// silence, and each fallback was a guess:
//
//   Sneak Attack          always "piercing"     — a scimitar's is slashing
//   Brutal Strike         always "bludgeoning"  — a greataxe's is slashing
//   Battle Master die     always "untyped"      — walks past resistance
//   Pact of the Blade box always "Normal (normal)"
//
// ⚠️ AND A SPELL HAS NO `system.damage` AT ALL — not an empty one, the field is
// absent from SpellData's schema. All 4,929 spells in his world confirm it.
//
// The shapes below are the real ones read out of hijinx on 2026-09-25, not
// invented: a typed weapon, the seven that declare two types, the 105 versatile
// weapons that leave `versatile.types` empty, the 92 magic wrappers with no
// declared type at all, and a live attack whose parts already hold the base.
//
// Run:  node tools/weapon-damage-type-selftest.mjs
// ──────────────────────────────────────────────────────────────────────────────

const M = "file:///D:/FoundryVTT/Data/modules/ace-qol/scripts/read-activities.mjs";
const { weaponDamageType, weaponDamageTypes, damageDice, firstDamage } = await import(M);

let pass = 0, fail = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log((ok ? "  ok   " : "  FAIL ") + String(label).padEnd(56)
    + "got " + JSON.stringify(got) + ", want " + JSON.stringify(want));
};

/** A damage block the way dnd5e stores one. `live` makes `types` a Set. */
const dmg = (number, denomination, types = [], { live = false, bonus = "" } = {}) => ({
  number, denomination, bonus, types: live ? new Set(types) : types,
  custom: { enabled: false, formula: "" }, scaling: { mode: "", number: null, formula: "" },
});
const weapon = (name, damage, activities = {}) => ({ name, type: "weapon", system: { damage, activities } });

// ── The shapes, straight out of his world ───────────────────────────────────
// Vicious Longsword: base 1d8 slashing, attack activity { includeBase: true, parts: [] }
const viciousLongsword = weapon("Vicious Longsword", { base: dmg(1, 8, ["slashing"]) },
  { a1: { id: "a1", type: "attack", damage: { critical: { bonus: "2d6" }, includeBase: true, parts: [] } } });
// Scimitar: the weapon Sneak Attack was called piercing on.
const scimitar = weapon("Scimitar", { base: dmg(1, 6, ["slashing"]) });
// Greataxe: the weapon Brutal Strike was called bludgeoning on.
const greataxe = weapon("Greataxe", { base: dmg(1, 12, ["slashing"]) });
// Javelin of Lightning: one of the seven that declare TWO types.
const javelinOfLightning = weapon("Javelin of Lightning", { base: dmg(1, 6, ["lightning", "piercing"]) });
// Longsword: one of the 105 versatile weapons. versatile.types is EMPTY on all of them.
const longsword = weapon("Longsword",
  { base: dmg(1, 8, ["slashing"]), versatile: dmg(1, 10, []) });
// Silvered Greataxe: one of the 92 that declare dice and NO type.
const silveredGreataxe = weapon("Silvered Greataxe", { base: dmg(1, 12, [], { bonus: "1" }) });
// Frost Brand: a wrapper with no dice and no type, whose only activity is an enchant.
const frostBrand = weapon("Frost Brand", { base: dmg(null, 0, []) },
  { e1: { id: "e1", type: "enchant", damage: null } });

console.log("\nA WEAPON'S OWN TYPE, FROM THE FIELD 5.x ACTUALLY USES");
check("Vicious Longsword", weaponDamageType(viciousLongsword), "slashing");
check("a scimitar's Sneak Attack is slashing", weaponDamageType(scimitar, null, "piercing"), "slashing");
check("a greataxe's Brutal Strike is slashing", weaponDamageType(greataxe, null, "bludgeoning"), "slashing");
check("a maneuver's die is typed, not untyped", weaponDamageType(greataxe, null, "untyped"), "slashing");

console.log("\nA LIVE ITEM KEEPS `types` IN A SET, SO `types[0]` IS UNDEFINED");
{
  const live = weapon("Rapier", { base: dmg(1, 8, ["piercing"], { live: true }) });
  check("the old read", live.system.damage.base.types[0], undefined);
  check("the one reader", weaponDamageType(live), "piercing");
}

console.log("\nVERSATILE INHERITS THE BASE'S TYPE (0 of 105 declare their own)");
check("a longsword is slashing either way", weaponDamageTypes(longsword), ["slashing"]);
{
  // A weapon that DOES declare a different versatile type is still answered.
  const odd = weapon("Odd Staff", { base: dmg(1, 6, []), versatile: dmg(1, 8, ["force"]) });
  check("and a weapon that declares one is heard", weaponDamageType(odd), "force");
}

console.log("\nTWO DECLARED TYPES: THE FIRST, AND THE CALLER'S GUESS IS NOT USED");
check("Javelin of Lightning", weaponDamageTypes(javelinOfLightning), ["lightning", "piercing"]);
check("the rider takes the first", weaponDamageType(javelinOfLightning, null, "piercing"), "lightning");

console.log("\nNO DECLARED TYPE IS THE ONLY TIME A FALLBACK IS RIGHT");
check("Silvered Greataxe declares none", weaponDamageTypes(silveredGreataxe), []);
check("so Brutal Strike says so", weaponDamageType(silveredGreataxe, null, "bludgeoning"), "bludgeoning");
check("Frost Brand's wrapper too", weaponDamageType(frostBrand, null, "slashing"), "slashing");
check("and with no fallback it says nothing", weaponDamageType(frostBrand), null);

console.log("\nTHE USED ACTIVITY WINS, BECAUSE LIVE IT ALREADY HOLDS THE BASE");
{
  // On a LIVE item dnd5e unshifts the weapon's base into the attack's parts,
  // marked `base` (AttackActivityData#prepareFinalData). A stored copy has not.
  const attack = { id: "a1", type: "attack", damage: { includeBase: true, parts: [
    { ...dmg(1, 8, ["slashing"], { live: true }), base: true, locked: true },
    dmg(2, 6, ["fire"], { live: true }),
  ] } };
  check("the base part answers first", weaponDamageType(viciousLongsword, attack), "slashing");
  check("and the rider's dice are seen too",
    weaponDamageTypes(viciousLongsword, attack), ["slashing", "fire"]);
  // A Flame Tongue's fire must NOT become the weapon's type when no activity is given.
  check("without the activity, the weapon's own", weaponDamageType(viciousLongsword), "slashing");
}

console.log("\nA STORED COPY'S ATTACK HAS EMPTY PARTS, AND THE ITEM STILL ANSWERS");
{
  const stored = viciousLongsword.system.activities.a1;
  check("parts is empty", stored.damage.parts, []);
  check("the item answers", weaponDamageType(viciousLongsword, stored), "slashing");
}

console.log("\nA PRE-5.x PAIR IS STILL READ");
check("[formula, type]", weaponDamageType({ name: "Old", system: { damage: {} } },
  { damage: { parts: [["1d6", "cold"]] } }), "cold");

console.log("\nA SPELL HAS NO `system.damage` — ITS DICE ARE ON ITS ACTIVITIES");
{
  const spikeGrowth = { name: "Spike Growth", type: "spell", system: { level: 2, school: "trs",
    activities: { d1: { id: "d1", type: "damage",
      damage: { parts: [dmg(2, 4, ["piercing"], { live: true })] } } } } };
  check("no damage on the item", spikeGrowth.system.damage, undefined);
  check("the dead read", spikeGrowth.system.damage?.parts?.[0]?.[0], undefined);
  check("the activity's dice", firstDamage(spikeGrowth), { formula: "2d4", types: ["piercing"], type: "piercing" });
  check("2d4 per five feet, not a hardcoded 2d4", firstDamage(spikeGrowth)?.formula, "2d4");
}

console.log("\nDICE THE WAY dnd5e WRITES THEM");
check("a custom formula wins", damageDice({ damage: { parts: [
  { custom: { enabled: true, formula: "3d6 + 2" }, number: 9, denomination: 9, types: ["fire"] }] } }),
  [{ formula: "3d6 + 2", types: ["fire"], type: "fire" }]);
check("a bonus is added", damageDice({ damage: { parts: [dmg(1, 8, ["radiant"], { bonus: "3" })] } }),
  [{ formula: "1d8 + 3", types: ["radiant"], type: "radiant" }]);
check("a part with no formula rolls nothing",
  damageDice({ damage: { parts: [dmg(null, null, ["fire"])] } }), []);
check("a bonus alone is a formula", damageDice({ damage: { parts: [dmg(null, null, [], { bonus: "@mod" })] } }),
  [{ formula: "@mod", types: [], type: null }]);

console.log("\nNOTHING THROWS ON NOTHING");
check("no item", weaponDamageTypes(null), []);
check("no system", weaponDamageTypes({ name: "x" }), []);
check("no damage block", weaponDamageTypes({ system: {} }), []);
check("no activity", damageDice(null), []);
check("firstDamage on an empty item", firstDamage({ system: {} }), null);

console.log(`\n${fail === 0 ? "ALL GREEN" : "FAILURES"}: ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
