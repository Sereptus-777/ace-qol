// ─── Can any enricher syntax reach a screen? ─────────────────────────────────
//
// Johnny, 2026-09-03, looking at a beholder's lair action in the action bar:
// "It says the lookup name part. I don't want to ever see that in any of our
// shit."
//
// ⚠️ THE FAILURE PATHS ARE THE POINT. When enrichment works, the placeholder
// becomes the name and there is nothing to test. What matters is what reaches
// the screen when it has NOT run: a cold cache, no enricher, a thrown enricher.
// Every one of those must strip the syntax, never show it.
//
// Run:  node tools/description-selftest.mjs
globalThis.game = { ready: true, settings: { get: () => false, register: () => {} },
  user: { isGM: true }, users: [], actors: [], modules: { get: () => null } };
globalThis.Hooks = { on: () => {}, once: () => {}, off: () => {}, callAll: () => {} };
globalThis.ui = { notifications: { info: () => {}, warn: () => {}, error: () => {} } };
globalThis.foundry = { applications: { ux: {} }, utils: { escapeHTML: (s) => String(s) } };
globalThis.canvas = { grid: { size: 100 } };

const { aceStripEnrichers, aceDescriptionText, aceDescriptionTextSync, aceDescriptionFloorHtml } =
  await import("file:///D:/FoundryVTT/Data/modules/ace-qol/scripts/description-reader.mjs");

let pass = 0, fail = 0;
const check = (label, got, want) => {
  const ok = got === want;
  ok ? pass++ : fail++;
  console.log((ok ? "  ok   " : "  FAIL ") + label.padEnd(56) + "got " + JSON.stringify(got) + ", want " + JSON.stringify(want));
};
const hasBrackets = (s) => /\[\[|\]\]|@[A-Za-z]+\[/.test(s);

console.log("\nTHE EXACT STRING HE SAW");
// From his beholder's lair action.
const lair = "<p>A beholder's central lair is a large cavern. [[lookup @name]] attacks from above.</p>";
check("the lookup placeholder is gone",
  hasBrackets(aceStripEnrichers(lair)), false);
check("and the sentence around it survives",
  aceStripEnrichers(lair).includes("attacks from above"), true);

console.log("\nEVERY ENRICHER SHAPE dnd5e USES");
const cases = [
  ["[[/damage 2d6 fire]]",                    "a damage command"],
  ["[[/save dex 15]]",                        "a save command"],
  ["[[1d6+2]]",                               "an inline roll"],
  ["[[lookup @name]]",                        "the lookup"],
  ["[[/check int 12]]",                       "a check command"],
  ["@UUID[Item.abc123]{Sword of Wounding}",   "a labelled reference"],
  ["@UUID[Item.abc123]",                      "an unlabelled reference"],
  ["@Check[dex]",                             "a bare check enricher"],
  ["&Reference[condition=prone]{Prone}",      "an ampersand reference"],
];
for (const [src, what] of cases) {
  check(`${what} leaves nothing bracketed`, hasBrackets(aceStripEnrichers(src)), false);
}

console.log("\nA LABEL IS THE READABLE ANSWER, SO IT IS KEPT");
// ⚠️ Deleting the label too would turn "you may use @UUID[...]{Sword of
// Wounding}" into "you may use", which is worse than the brackets were.
check("the label survives its reference",
  aceStripEnrichers("Attune to @UUID[Item.x]{Sword of Wounding} first.").trim(),
  "Attune to Sword of Wounding first.");
check("an ampersand reference keeps its label too",
  aceStripEnrichers("You are &Reference[condition=prone]{Prone} until dawn.").trim(),
  "You are Prone until dawn.");

console.log("\nHIS PRISMATIC WALL, AS THE BOOK STORES IT");
// Johnny, 2026-09-11: "&Reference[BrightLight]" on his hover, and the table of
// layers run into one line. The book stores the ampersand encoded.
const wall = "<p>If you position the wall in a space occupied by a creature, the spell ends instantly without effect.</p>"
  + "<p>The wall sheds &amp;Reference[BrightLight] within 100 feet and &amp;Reference[DimLight] for an additional "
  + "100 feet. The creature must succeed on a Constitution saving throw or have the &amp;Reference[Blinded apply=false] "
  + "condition for 1 minute.</p><table><tr><th>Order</th><th>Effects</th></tr><tr><td>1</td><td>Red.</td></tr></table>";
check("an encoded reference is spelled out, never shown", /Reference/.test(aceStripEnrichers(wall)), false);
check("as the rule it names", aceStripEnrichers(wall).includes("sheds Bright Light within 100 feet"), true);
check("a condition reference drops its switches", aceStripEnrichers(wall).includes("have the Blinded condition"), true);
const wallItem = { uuid: "Item.wall", name: "Prismatic Wall", system: { description: { value: wall } } };
const flat = aceDescriptionTextSync(wallItem);
check("paragraphs do not run together when flattened", flat.includes("without effect. The wall"), true);
check("nor do table cells", /Order\s+Effects\s+1\s+Red/.test(flat), true);
check("the hover's fallback keeps its paragraphs and its table",
  /<\/p><p>[\s\S]*<table>/.test(aceDescriptionFloorHtml({ ...wallItem, uuid: "Item.wall2" })), true);

console.log("\nEVERY dnd5e COMMAND AS THE WORDS IT PRINTS");
check("a save", aceStripEnrichers("must succeed on a [[/save ability=con dc=14]] or").trim(),
  "must succeed on a DC 14 Constitution saving throw or");
check("an older save", aceStripEnrichers("a [[/save dex 15]] or").trim(), "a DC 15 Dexterity saving throw or");
check("a save with its own label", aceStripEnrichers("Constitution Saving Throw: [[/save con 12 format=long]]{ DC 12}.").trim(),
  "Constitution Saving Throw: DC 12.");
check("damage", aceStripEnrichers("takes [[/damage 2d6 type=fire average=true]] damage").trim(), "takes 2d6 fire damage");
check("an inline roll keeps its dice", aceStripEnrichers("taking 10 ([[/r 3d6]]) poison damage").trim(),
  "taking 10 (3d6) poison damage");
check("a check", aceStripEnrichers("a [[/skill skill=prc dc=13]] reveals it").trim(), "a DC 13 Perception check reveals it");
check("the creature's name, when it is known", aceStripEnrichers("[[lookup @name]] attacks.", { name: "Neferon" }).trim(),
  "Neferon attacks.");
check("dnd5e's whole attack line leaves nothing half-printed",
  aceStripEnrichers("[[/attack extended]]. [[/damage extended]]. The target must succeed").trim(), "The target must succeed");

console.log("\nWHAT HIS WORLD ACTUALLY HOLDS: NESTED AND BROKEN ENRICHERS");
// ⚠️ Magic Missile's own text, on fifteen copies in hijinx: a roll whose label
// is a lookup. One pass handed the label back with the lookup still inside.
check("a lookup inside a roll's label is spelled out too",
  aceStripEnrichers("<p>[[2 + @item.level]]{Level [[lookup @item.level]] darts}</p>", { level: 1 }), "<p>Level 1 darts</p>");
check("and with no level known, nothing bracketed is left",
  hasBrackets(aceStripEnrichers("[[2 + @item.level]]{Level [[lookup @item.level]] darts}")), false);
check("an enricher missing a bracket keeps its label",
  aceStripEnrichers("The [[Lookup @Name Lowercase]{monster} can't take this action again").trim(),
  "The monster can't take this action again");
check("a stray pair of brackets in a sentence is dropped",
  aceStripEnrichers("The rust monster makes one attack and uses twice]].").trim(),
  "The rust monster makes one attack and uses twice.");

console.log("\nTHE COLD READ — no cache, no enricher available");
// This is the path the action bar takes before priming finishes, and the path
// EVERY caller takes on a Foundry with no TextEditor.
const item = {
  uuid: "Item.test1", name: "Lair Action",
  system: { description: { value: lair } },
};
const cold = aceDescriptionTextSync(item);
check("nothing bracketed reaches the caller", hasBrackets(cold), false);
check("it is flattened to prose", /</.test(cold), false);
check("and it still reads as a sentence", cold.includes("central lair"), true);

console.log("\nTHE ENRICHER THROWING MUST NOT PUT BRACKETS ON SCREEN");
globalThis.foundry.applications.ux.TextEditor = {
  implementation: { enrichHTML: async () => { throw new Error("boom"); } },
};
const thrown = await aceDescriptionText({ ...item, uuid: "Item.test2" });
check("a thrown enricher still strips", hasBrackets(thrown), false);
check("and says something rather than nothing", thrown.length > 20, true);

console.log("\nWHEN IT WORKS, THE NAME COMES BACK");
globalThis.foundry.applications.ux.TextEditor = {
  implementation: { enrichHTML: async (raw) => raw.replace(/\[\[lookup @name\]\]/g, "Thorne Blackshroud") },
};
const good = await aceDescriptionText({ ...item, uuid: "Item.test3" });
check("the placeholder became the creature's name",
  good.includes("Thorne Blackshroud"), true);
check("nothing bracketed left either", hasBrackets(good), false);

console.log("\nEMPTY IS EMPTY, NOT A GUESS");
check("no description gives an empty string",
  aceDescriptionTextSync({ uuid: "Item.none", system: {} }), "");

console.log("\nTHE LIMIT CUTS ON A WORD, NEVER MID-SYLLABLE");
const longItem = { uuid: "Item.long", system: { description: { value:
  "<p>" + "The beholder considers its options carefully and at length. ".repeat(6) + "</p>" } } };
const cut = aceDescriptionTextSync(longItem, { limit: 60 });
check("it stops at or under the limit plus the ellipsis", cut.length <= 61, true);
check("and does not end mid-word", /\s\S+…$/.test(cut) === false || cut.endsWith("…"), true);

console.log("");
console.log(pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
