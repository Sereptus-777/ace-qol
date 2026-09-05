// ─── Does the registry audit actually find things, and only real things? ─────
//
// ⚠️🔴 A WRONG AUDIT IS WORSE THAN NO AUDIT. Four of ACE's own tools have given
// confident wrong numbers, and one of them argued for deleting live code. An
// audit that under-reports reads as "all clear" and an audit that over-reports
// gets ignored within a week — the "areas that are never drawn" card named four
// spells that were all correct and Johnny stopped reading it.
//
// So every case here is either a disagreement I know is real, or a shape that
// LOOKS like one and must not be reported.
//
// Run:  node tools/registry-audit-selftest.mjs
globalThis.Hooks = { on: () => {}, once: () => {}, off: () => {}, callAll: () => {} };
globalThis.ui = { notifications: { info: () => {}, warn: () => {}, error: () => {} } };
globalThis.CONFIG = { Actor: {}, Token: {}, Item: {}, DND5E: { skills: {}, abilities: {} } };
class _App { static DEFAULT_OPTIONS = {}; constructor() {} render() {} close() {} }
globalThis.foundry = {
  utils: { escapeHTML: (s) => String(s), mergeObject: (a, b) => ({ ...a, ...b }),
           deepClone: (o) => JSON.parse(JSON.stringify(o ?? null)) },
  applications: { api: { DialogV2: { wait: async () => null }, ApplicationV2: _App,
                         HandlebarsApplicationMixin: (B) => class extends B {} },
                  ux: {}, apps: {}, handlebars: {} },
};
globalThis.canvas = { grid: { size: 100, distance: 5 }, scene: { regions: [] } };

// ── The world under test ───────────────────────────────────────────────────
const ENTRIES = {};
const item = (name, opts = {}) => ({
  name, type: "spell",
  system: {
    level: opts.level ?? 5,
    source: { rules: opts.rules ?? "2024" },
    range: opts.range ?? { units: "ft", value: 60 },
    duration: { concentration: opts.conc === true },
    target: opts.area ? { template: { type: opts.area[0], size: String(opts.area[1]) } } : {},
    activities: opts.activities ?? {},
  },
});
const saveAct = (ability, asSet = false) => ({
  a: { type: "save", save: { ability: asSet ? new Set([ability]) : [ability] } },
});
const healAct = (n, d) => ({ a: { type: "heal", healing: { number: n, denomination: d } } });

let ITEMS = [];
globalThis.game = {
  settings: { get: () => false, register: () => {} },
  user: { isGM: true, id: "gm" }, users: [],
  i18n: { localize: (k) => k }, time: { worldTime: 0 },
  modules: { get: () => ({ active: true }) },
  items: [], actors: [{ items: [] }],
  aceQol: { SpellPipeline: { _getEntry: (it) => ENTRIES[String(it.name).toLowerCase()] ?? null } },
};

const { RegistryAudit } = await import(
  "file:///D:/FoundryVTT/Data/modules/ace-qol/scripts/registry-audit.mjs");

let pass = 0, fail = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log((ok ? "  ok   " : "  FAIL ") + String(label).padEnd(58)
    + "got " + JSON.stringify(got) + ", want " + JSON.stringify(want));
};

async function auditOf(items, entries) {
  ITEMS = items;
  game.items = items;
  game.actors = [{ items: [] }];
  for (const k of Object.keys(ENTRIES)) delete ENTRIES[k];
  Object.assign(ENTRIES, entries);
  const r = await RegistryAudit.run({ quiet: true });
  return r.rows.map(x => `${x.name}: ${x.issues.join(" | ")}`);
}

console.log("\nIT FINDS THE ONES THAT BIT US");
// ⚠️ THE REAL ONE. Mass Healing Word's entry carried 1d4 while his 2024 copy is
// 2d4 — half the healing, every cast, silently, for as long as it stood.
check("healing dice that disagree are caught",
  await auditOf([item("Mass Healing Word", { level: 3, activities: healAct(2, 4) })],
    { "mass healing word": { heal: { formula: () => "1d4 + 3" } } }),
  ["Mass Healing Word: healing: ACE rolls 1d4, the item says 2d4"]);
check("a save ability that disagrees is caught",
  await auditOf([item("Colour Spray", { activities: saveAct("con") })],
    { "colour spray": { save: { ability: "wis" } } }),
  ["Colour Spray: save: ACE says WIS, the item says CON"]);
check("a range that disagrees is caught",
  await auditOf([item("Mass Cure Wounds", { range: { units: "ft", value: 60 } })],
    { "mass cure wounds": { range: 30 } }),
  ["Mass Cure Wounds: range: ACE says 30 ft, the item says 60 ft"]);
check("concentration that disagrees is caught",
  await auditOf([item("Bless", { conc: false })], { "bless": { concentration: true } }),
  ["Bless: concentration: ACE says true, the item says false"]);
check("an area that disagrees is caught",
  await auditOf([item("Fireball", { area: ["sphere", 20] })],
    { "fireball": { expectedArea: { type: "sphere", size: 40 } } }),
  ["Fireball: area: ACE expects sphere 40 ft, the item declares sphere 20 ft"]);

console.log("\nAND IT DOES NOT INVENT ONES THAT ARE NOT THERE");
check("everything agreeing reports nothing",
  await auditOf([item("Mass Cure Wounds", { activities: healAct(5, 8), range: { units: "ft", value: 60 },
      area: ["sphere", 30] })],
    { "mass cure wounds": { range: 60, heal: { formula: () => "5d8 + 3" },
      expectedArea: { type: "sphere", size: 30 } } }),
  []);
// ⚠️ A SET, NOT A STRING. dnd5e 5.x stores save.ability as a Set; reading it as
// a string gives "undefined" and reports EVERY save spell as a disagreement.
check("a save ability stored as a Set is read, not misreported",
  await auditOf([item("Colour Spray", { activities: saveAct("con", true) })],
    { "colour spray": { save: { ability: "con" } } }),
  []);
// ⚠️ radius, sphere AND cylinder ARE ONE SHAPE UNDER THREE NAMES in dnd5e.
check("radius and sphere are not a disagreement",
  await auditOf([item("Spirit Guardians", { area: ["radius", 15] })],
    { "spirit guardians": { expectedArea: { type: "sphere", size: 15 } } }),
  []);
check("the modifier in a formula is ignored, only the dice compared",
  await auditOf([item("Mass Cure Wounds", { activities: healAct(5, 8) })],
    { "mass cure wounds": { heal: { formula: () => "5d8 + 7" } } }),
  []);
// ⚠️ AN ITEM THAT SAYS NOTHING IS NOT AN ITEM THAT DISAGREES. Half the library
// declares no template and no save; reporting those would bury the real ones.
check("an item that declares nothing is not reported",
  await auditOf([item("Mystery", {})],
    { "mystery": { save: { ability: "dex" }, heal: { formula: () => "2d6" },
                   expectedArea: { type: "sphere", size: 20 } } }),
  []);
check("a self-range spell is not compared against a number",
  await auditOf([item("Aura of Vitality", { range: { units: "self" } })],
    { "aura of vitality": { range: 30 } }),
  []);
// ⚠️🔴 THE ONE THAT CAUSED DAMAGE. This audit reported a Cleric 17's Spare
// the Dying at 120 feet as a disagreement, because ACE's entry held 5. The item
// was RIGHT: 2024 Spare the Dying is a cantrip whose range doubles at 5th, 11th
// and 17th level, so 15, 30, 60 and 120 are all correct depending on who is
// casting it. I believed the audit over his sheet and told him to change items
// that were already right. An audit confidently wrong about his data does not
// merely fail to help — it causes damage.
check("a CANTRIP's range is never compared, whatever the entry says",
  await auditOf([item("Spare the Dying", { level: 0, range: { units: "ft", value: 120 } })],
    { "spare the dying": { range: 5 } }),
  []);
check("but a levelled spell's range still is",
  await auditOf([item("Banishment", { level: 4, range: { units: "ft", value: 30 } })],
    { "banishment": { range: 60 } }),
  ["Banishment: range: ACE says 60 ft, the item says 30 ft"]);

check("an item with no ACE entry at all is skipped",
  await auditOf([item("Prayer of Healing", { activities: healAct(2, 8) })], {}),
  []);

console.log("\nIT SAYS WHAT IT LOOKED AT");
// ⚠️ A SILENT AUDIT THAT FINDS NOTHING IS INDISTINGUISHABLE FROM ONE THAT NEVER
// RAN. The counts are the proof it did.
{
  ITEMS = [item("A", {}), item("B", {}), { name: "C", type: "weapon", system: {} }];
  game.items = ITEMS;
  for (const k of Object.keys(ENTRIES)) delete ENTRIES[k];
  Object.assign(ENTRIES, { a: { range: 30 } });
  const r = await RegistryAudit.run({ quiet: true });
  check("counts the spells it read, not the weapons", r.checked, 2);
  check("counts how many carry an entry", r.withEntry, 1);
  check("and the report names the totals",
    /Read 2 distinct spells and feats\. 1 carry an ACE entry/.test(r.text), true);
}

console.log("\nTHE EDITION COMES FROM THE ITEM, NOT THE WORLD");
// ⚠️🔴 THE ROOT OF EVERY EDITION BUG TONIGHT. `_applyEdition` read the
// world setting and never looked at the item, so with the world on 2024 a 2014
// Evard's Black Tentacles took the 2024 Strength save while its own sheet says
// Dexterity. His library holds both copies of a dozen spells side by side.
{
  const { RulesBrain } = await import(
    "file:///D:/FoundryVTT/Data/modules/ace-qol/scripts/rules/rules-brain.mjs");
  const withRules = (r) => ({ system: { source: { rules: r } } });
  check("an item stamped 2014 is 2014", RulesBrain.resolveEdition(withRules("2014")), "2014");
  check("an item stamped 2024 is 2024", RulesBrain.resolveEdition(withRules("2024")), "2024");
  // ⚠️ AND ONLY THEN THE WORLD. An item that says nothing still has to get an
  // answer, and the world setting is the right fallback — it is just not the
  // first question.
  check("an item that says nothing falls back without throwing",
    ["2014", "2024"].includes(RulesBrain.resolveEdition({ system: {} })), true);
  check("garbage in the field does not become a third edition",
    ["2014", "2024"].includes(RulesBrain.resolveEdition(withRules("banana"))), true);
}

console.log("");
console.log(pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
