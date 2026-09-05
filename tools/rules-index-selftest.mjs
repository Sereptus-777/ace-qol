// ─── Does the engine open the right book, and does it only speak when it should?
//
// The two things this guards, both of them scars:
//
// ⚠️🔴 A DISAGREEMENT REPORTED ON A CORRECT ITEM IS WORSE THAN NO CHECK AT ALL.
// On 2026-09-05 I reported Spare the Dying's 120 feet as an importer's default,
// believed my own audit over his sheet, and handed him a snippet that changed
// items that were already right. A cantrip's range and dice are SUPPOSED to
// grow. Anything that scales with level is not compared on a cantrip.
//
// ⚠️🔴 2014 AND 2024 ARE DIFFERENT SPELLS. Colour Spray is a hit-point pool in
// one and a Constitution save in the other, and I once called his correct 2024
// sheet "a phantom save an importer invented" and wrote three guards against
// it. The two editions are indexed apart and a lookup must never cross over.
//
// Run:  node tools/rules-index-selftest.mjs
globalThis.game = { ready: true, packs: [] };
globalThis.Hooks = { on: () => {}, once: () => {}, off: () => {}, callAll: () => {} };
globalThis.ui = { notifications: { info: () => {}, warn: () => {}, error: () => {} } };
globalThis.fromUuid = async () => null;

const { RulesIndex } = await import(
  "file:///D:/FoundryVTT/Data/modules/ace-qol/scripts/rules/rules-index.mjs");
const { readMechanics, compareToBook, isCantrip, filterForCantrip } = await import(
  "file:///D:/FoundryVTT/Data/modules/ace-qol/scripts/rules/rules-compare.mjs");

let pass = 0, fail = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log((ok ? "  ok   " : "  FAIL ") + String(label).padEnd(60)
    + "got " + JSON.stringify(got) + ", want " + JSON.stringify(want));
};

/* ── Names ──────────────────────────────────────────────────────────────── */
console.log("\nAN ITEM'S NAME, AS THE BOOK WOULD PRINT IT");
check("a Legacy suffix comes off", RulesIndex.bookName("Aura of Vitality (Legacy)"), "aura of vitality");
check("a usage note comes off", RulesIndex.bookName("Frightful Presence (1/Day)"), "frightful presence");
check("a bracketed edition comes off", RulesIndex.bookName("Sleep [2024]"), "sleep");
check("a curly apostrophe is straightened", RulesIndex.bookName("Bigby\u2019s Hand"), "bigby's hand");
check("spacing collapses", RulesIndex.bookName("  Mass   Cure  Wounds "), "mass cure wounds");
check("an empty name is empty, not undefined", RulesIndex.bookName(null), "");
// ⚠️ THE BONUS IS STRIPPED ONLY AS A FALLBACK, and never in the shared
// normaliser: a curated registry entry is allowed to be about one magic weapon.
check("the base name keeps its bonus at first", RulesIndex.bookName("Rapier +3"), "rapier +3");
check("and the bonus can be stripped on the retry", RulesIndex._withoutBonus("rapier +3"), "rapier");
check("nothing to strip returns null", RulesIndex._withoutBonus("rapier"), null);

/* ── Indexing ───────────────────────────────────────────────────────────── */
const pack = (collection, label, packageType, names, type = "spell") => ({
  documentName: "Item",
  collection,
  metadata: { packageType, label },
  getIndex: async () => names.map((n, i) => ({
    _id: `id${i}`, name: n, type, uuid: `Compendium.${collection}.id${i}`,
  })),
});

game.packs = [
  pack("dnd5e.spells",   "Spells (SRD)", "system", ["Cure Wounds", "Sleep"]),
  pack("dnd5e.spells24", "Spells",       "system", ["Cure Wounds", "Sleep"]),
  pack("dnd5e.items",    "Items (SRD)",  "system", ["Rapier"], "weapon"),
  pack("world.myspells", "My Imports",   "world",  ["Frostbite"]),
  // ⚠️ A PACK THAT WILL NOT OPEN MUST NOT LOOK LIKE AN EMPTY ONE.
  { documentName: "Item", collection: "broken.pack", metadata: { packageType: "module" },
    getIndex: async () => { throw new Error("corrupt"); } },
  // Not an Item pack — a stat block's features are published separately.
  { documentName: "Actor", collection: "dnd5e.monsters", metadata: { packageType: "system" },
    getIndex: async () => [{ _id: "a", name: "Lich", type: "npc" }] },
];
const status = await RulesIndex.build();

console.log("\nTHE TWO EDITIONS ARE INDEXED APART");
check("both editions were built", [status.counts["2014"] > 0, status.counts["2024"] > 0], [true, true]);
check("the broken pack was recorded, not swallowed", status.failed.length, 1);
check("actor packs are not indexed", status.packs.some(p => p.id === "dnd5e.monsters"), false);
check("a 2014 lookup lands in the 2014 book",
  RulesIndex.lookup("Cure Wounds", { edition: "2014" }).hits[0].pack, "dnd5e.spells");
check("a 2024 lookup lands in the 2024 book",
  RulesIndex.lookup("Cure Wounds", { edition: "2024" }).hits[0].pack, "dnd5e.spells24");

console.log("\nAND HIS OWN IMPORTS ARE FOUND FROM EITHER EDITION");
// A world pack carries the edition on each ITEM, not on the pack, so filing it
// under one edition would hide half his library from half his items.
check("a world import is found under 2014",
  RulesIndex.lookup("Frostbite", { edition: "2014" }).status, "found");
check("and under 2024",
  RulesIndex.lookup("Frostbite", { edition: "2024" }).status, "found");

console.log("\nNOT FINDING SOMETHING IS A REAL ANSWER");
// ⚠️ A Pathfinder spell dropped in by accident is not broken. It comes back
// "none", the engine reads the item itself, and the button works.
const miss = RulesIndex.lookup("Hydraulic Push", { edition: "2014" });
check("an unknown spell is 'none', not an error", miss.status, "none");
check("and it says what happens next", /reads the item itself/.test(miss.note), true);
check("a magic weapon falls back to its base",
  RulesIndex.lookup("Rapier +3", { edition: "2014" }).hits[0].name, "Rapier");
check("and the lookup reports which key it used",
  RulesIndex.lookup("Rapier +3", { edition: "2014" }).key, "rapier");

console.log("\n'NOT BUILT' AND 'NOT FOUND' MUST NEVER READ THE SAME");
// One means his homebrew is fine; the other means every comparison in the game
// is dead and somebody should be told. Same lesson as the silent catch.
const saved = RulesIndex._byEdition;
RulesIndex._byEdition = null;
check("an unbuilt index says so", RulesIndex.lookup("Cure Wounds").status, "unbuilt");
RulesIndex._byEdition = saved;

/* ── Reading ────────────────────────────────────────────────────────────── */
const spell = (over = {}) => ({
  name: over.name ?? "Cure Wounds",
  type: "spell",
  system: {
    level: over.level ?? 1,
    properties: over.props ?? ["vocal", "somatic"],
    activities: { contents: [{
      type: over.actType ?? "heal",
      range: over.range ?? { units: "touch" },
      healing: over.healing ?? { number: 2, denomination: 8, types: ["healing"] },
      damage: over.damage ?? { parts: [] },
      save: over.save ?? {},
      target: over.target ?? {},
    }] },
  },
});

console.log("\nONE READER, RUN OVER HIS ITEM AND OVER THE BOOK");
const mine = readMechanics(spell());
check("it reads the healing dice", mine.healing.formula, "2d8");
check("it reads touch range as a word, not a number", mine.range, "touch");
check("it reads concentration off the properties",
  readMechanics(spell({ props: ["concentration"] })).concentration, true);
check("a Set of properties is handled, not just an array",
  readMechanics(spell({ props: new Set(["concentration"]) })).concentration, true);
check("a Set of save abilities is handled",
  readMechanics(spell({ actType: "save", save: { ability: new Set(["dex"]) } })).save, ["dex"]);

console.log("\nWHAT IT SAYS WHEN THEY AGREE, AND WHEN THEY DO NOT");
check("identical copies produce nothing",
  compareToBook(readMechanics(spell()), readMechanics(spell())).count, 0);
// ⚠️ THIS IS THE REAL ONE. His 2024 Cure Wounds was healing 1d8 for months and
// nothing anywhere disagreed with itself, because the item was internally
// consistent. Only the book catches it.
const healDiff = compareToBook(
  readMechanics(spell({ healing: { number: 1, denomination: 8, types: ["healing"] } })),
  readMechanics(spell()), { edition: "2024" });
check("a halved healing die is caught", healDiff.count, 1);
check("and it is said in plain English", healDiff.lines[0],
  "Your copy heals 1d8; the 2024 book says 2d8.");

const areaDiff = compareToBook(
  readMechanics(spell({ target: { template: { type: "sphere", size: 40 } } })),
  readMechanics(spell({ target: { template: { type: "sphere", size: 20 } } })));
check("a wrong area size is caught", areaDiff.lines[0],
  "Your copy's sphere is 40 feet; the 2014 book says 20 feet.");

const concDiff = compareToBook(
  readMechanics(spell({ props: [] })),
  readMechanics(spell({ props: ["concentration"] })));
check("a missing concentration is caught", concDiff.lines[0],
  "Your copy does not need concentration; the 2014 book says it does.");

console.log("\nA BLANK FIELD IS NOT A DISAGREEMENT");
// ⚠️ Half the SRD entries leave a field blank that his import fills in.
// Reporting every one of those is a wall he stops reading, which is exactly how
// the "areas that are never drawn" card ended up ignored.
check("book says nothing about the area, so nothing is said",
  compareToBook(readMechanics(spell({ target: { template: { type: "sphere", size: 40 } } })),
                readMechanics(spell())).count, 0);
check("book states no level, so nothing is said",
  compareToBook(readMechanics(spell({ level: 3 })),
                readMechanics({ name: "x", type: "spell", system: { activities: { contents: [] } } })).count, 0);
check("formula spacing is not a disagreement",
  compareToBook(readMechanics(spell({ healing: { formula: "2d8 + 3" } })),
                readMechanics(spell({ healing: { formula: "2d8+3" } }))).count, 0);

console.log("\nA CANTRIP IS SUPPOSED TO GROW, AND IS NOT ACCUSED OF IT");
// ⚠️🔴 SPARE THE DYING, 2026-09-05. Its range doubles at 5th, 11th and 17th, so
// a Cleric 17's 120 feet is CORRECT. I reported it as an importer's default and
// had him change items that were right.
const cantrip = { name: "Spare the Dying", type: "spell", system: { level: 0,
  properties: [], activities: { contents: [{ type: "utility", range: { units: "ft", value: 120 } }] } } };
const bookCantrip = { name: "Spare the Dying", type: "spell", system: { level: 0,
  properties: [], activities: { contents: [{ type: "utility", range: { units: "ft", value: 30 } }] } } };
check("it knows a cantrip when it sees one", isCantrip(cantrip), true);
const raw = compareToBook(readMechanics(cantrip), readMechanics(bookCantrip), { edition: "2024" });
check("the raw compare does see the range gap", raw.count, 1);
const filtered = filterForCantrip(raw);
check("but a cantrip is not accused of scaling", filtered.count, 0);
check("and the drop is counted, not hidden", filtered.droppedForScaling, 1);
// ⚠️ It is still checked for the things that do NOT scale.
const concCantrip = compareToBook(
  readMechanics({ name: "c", type: "spell", system: { level: 0, properties: [],
    activities: { contents: [{ type: "utility" }] } } }),
  readMechanics({ name: "c", type: "spell", system: { level: 0, properties: ["concentration"],
    activities: { contents: [{ type: "utility" }] } } }));
check("a cantrip is still checked for concentration",
  filterForCantrip(concCantrip).count, 1);

console.log("");
console.log(pass + " passed, " + fail + " failed");
if (fail) process.exitCode = 1;
