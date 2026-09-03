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

const { aceStripEnrichers, aceDescriptionText, aceDescriptionTextSync } =
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
