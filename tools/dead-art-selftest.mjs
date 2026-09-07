// ─── Finding the right corpse ───────────────────────────────────────────────
//
// ⚠️🔴 THE BUG THIS EXISTS FOR. Johnny, 2026-09-06, killing an Arcanaloth:
// *"It must be going by type because it's given me the wrong dead token. It's
// given me dead-fiend every time."* He had `dead-arcanaloth-fiend.png` sitting
// in the folder. The matcher asked for `dead-arcanaloth`, the folder offered
// `dead-arcanaloth-fiend`, and nothing in between joined them up.
//
// ⚠️ THE MATCHER IS FORGIVING SO HE DOES NOT HAVE TO BE. Eighty-six files named
// five different ways. Any design where he must name files to a spec fails the
// next time he is tired, so a file now answers to each PART of its name.
//
// ⚠️ AND A FRAGMENT NEVER BEATS A REAL FILENAME. `dead-fiend.png` must win over
// the word "fiend" borrowed out of `dead-arcanaloth-fiend.png`. Get that
// backwards and a fragment quietly steals from art he made on purpose, which is
// worse than the original bug because it would look deliberate.
//
// Run:  node tools/dead-art-selftest.mjs
globalThis.Hooks = { on: () => {}, once: () => {}, off: () => {}, callAll: () => {} };
globalThis.document = { querySelectorAll: () => [], querySelector: () => null };
globalThis.CONFIG = { DND5E: {}, statusEffects: [], Canvas: { polygonBackends: {} } };
globalThis.ui = { notifications: { info: () => {}, warn: () => {}, error: () => {} } };
class _App { static DEFAULT_OPTIONS = {}; constructor() {} render() {} close() {} }
globalThis.foundry = {
  utils: { escapeHTML: (s) => String(s), deepClone: (o) => o, randomID: () => "id",
           mergeObject: (a, b) => ({ ...a, ...b }), getDocumentClass: () => null },
  applications: { api: { ApplicationV2: _App, DialogV2: { wait: async () => null },
                         HandlebarsApplicationMixin: (C) => C },
                  ux: { TextEditor: { implementation: { enrichHTML: async (h) => h } } },
                  apps: {}, handlebars: {} },
};
globalThis.ChatMessage = { create: async () => {}, getSpeaker: () => ({}) };
globalThis.CONST = { ACTIVE_EFFECT_MODES: { ADD: 2 } };
globalThis.canvas = { ready: true, scene: { id: "s1" }, grid: { size: 100, distance: 5 },
  tokens: { placeables: [], controlled: [] } };
globalThis.game = { combat: null, ready: true, actors: [], scenes: [],
  settings: { get: () => false, register: () => {} }, user: { isGM: true },
  users: [], i18n: { localize: (k) => k } };

let pass = 0, fail = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log((ok ? "  ok   " : "  FAIL ") + String(label).padEnd(60)
    + "got " + JSON.stringify(got) + ", want " + JSON.stringify(want));
};

const { DeathPipeline } = await import(
  "file:///D:/FoundryVTT/Data/modules/ace-qol/scripts/death-pipeline.mjs");

// His actual folder, as it stands tonight.
const FOLDER = [
  "dead-arcanaloth-fiend.png", "dead-fiend.png", "dead-fiend-11.png",
  "dead-beast.png", "dead-aberration.png", "dead-construct.png",
  "Dead-Rust Monster.png", "dead-ash zombie.png", "dead-bandit-human-11.png",
  "Dead-Hill-Giant.png", "dead-beholder.png",
];
const build = (files = FOLDER) => {
  const dp = new DeathPipeline();
  for (const f of files) dp._indexFile(`modules/ace-qol/Assets/Dead/${f}`);
  dp._cacheReady = true;
  return dp;
};
const npc = (name, { type = "", subtype = "", flags = {} } = {}) => ({
  name, type: "npc", hasPlayerOwner: false,
  system: { details: { type: { value: type, subtype } }, traits: {} },
  getFlag: (ns, k) => flags?.[k],
});
const file = (p) => String(p ?? "").split("/").pop();

console.log("\nTHE ONE THAT HAPPENED");
{
  const dp = build();
  const arc = npc("Arcanaloth", { type: "fiend", subtype: "Yugoloth" });
  // ⚠️🔴 Before tonight this returned dead-fiend-11.png.
  check("the Arcanaloth finds its own corpse", file(dp._resolveDeadArt(arc)),
    "dead-arcanaloth-fiend.png");
}

console.log("\nA REAL FILENAME ALWAYS BEATS A FRAGMENT");
{
  // ⚠️🔴 THE ONE THAT MUST NOT BREAK. "fiend" exists as a word inside
  // dead-arcanaloth-fiend AND as a file of its own. The file wins.
  const dp = build();
  const imp = npc("Imp", { type: "fiend" });
  check("a plain fiend still gets the fiend art",
    /^dead-fiend/.test(file(dp._resolveDeadArt(imp))), true);
}

console.log("\nSPACES AND CAPITALS IN FILENAMES STILL WORK");
{
  const dp = build();
  check("Rust Monster", file(dp._resolveDeadArt(npc("Rust Monster", { type: "monstrosity" }))),
    "Dead-Rust Monster.png");
  check("Hill Giant", file(dp._resolveDeadArt(npc("Hill Giant", { type: "giant" }))),
    "Dead-Hill-Giant.png");
  check("Ash Zombie", file(dp._resolveDeadArt(npc("Ash Zombie", { type: "undead" }))),
    "dead-ash zombie.png");
}

console.log("\nA FRAGMENT IS USED WHEN NOTHING BETTER EXISTS");
{
  // dead-bandit-human-11 contributes the word "bandit". A Bandit Captain with
  // no art of its own should land on it rather than on generic humanoid.
  const dp = build();
  check("Bandit Captain reaches the bandit art",
    /bandit/.test(file(dp._resolveDeadArt(npc("Bandit", { type: "humanoid" }))) ?? ""), true);
}

console.log("\nAND A HAND-PICKED CORPSE BEATS EVERY RULE");
{
  // ⚠️ THE ONLY WAY OUT OF A WRONG MATCH. Token art, portrait and prone art all
  // already save back to the sidebar actor; dead art had no equivalent at all.
  const dp = build();
  const arc = npc("Arcanaloth", { type: "fiend", subtype: "Yugoloth",
    flags: { deadArt: "modules/ace-qol/Assets/Dead/my-special-corpse.png" } });
  check("the chosen file wins", file(dp._resolveDeadArt(arc)), "my-special-corpse.png");
  // ⚠️ AND IT WORKS WITH AN EMPTY FOLDER, because a hand-picked path is not in
  // the index and must not depend on it.
  const bare = new DeathPipeline();
  check("even with no folder at all", file(bare._resolveDeadArt(arc)), "my-special-corpse.png");
}

console.log("\nWHAT IT WOULD HAVE WANTED, FOR THE LOG AND THE REPORT");
{
  // ⚠️ ONE LIST, TWO CONSUMERS. The fallback line and the ranked report must
  // name the same files, or the report sends him to draw something the matcher
  // will never ask for.
  check("Arcanaloth's keys, best first",
    DeathPipeline.deadArtKeysFor(npc("Arcanaloth", { type: "fiend", subtype: "Yugoloth" })),
    ["dead-arcanaloth", "dead-yugoloth", "dead-fiend"]);
  check("a numbered duplicate collapses to the creature",
    DeathPipeline.deadArtKeysFor(npc("Goblin 3", { type: "humanoid" })),
    ["dead-goblin-3", "dead-goblin", "dead-humanoid"]);
}

console.log("\nTHE REPORT RANKS WHAT TO DRAW NEXT");
{
  const dp = build();
  game.actors = [
    npc("Arcanaloth", { type: "fiend", subtype: "Yugoloth" }),
    npc("Mezzoloth", { type: "fiend", subtype: "Yugoloth" }),
    npc("Nycaloth", { type: "fiend", subtype: "Yugoloth" }),
    npc("Beholder", { type: "aberration" }),
  ];
  const { ranked, covered } = dp.deadArtReport({ log: false });
  const top = ranked[0];
  // ⚠️ THE POINT IS THE RANKING. One yugoloth file covers a whole family, and
  // that is the line worth an evening of art.
  check("the top suggestion is the yugoloth file", top?.file, "dead-yugoloth.png");
  check("and it names how many it covers", top?.covers, 2);
  check("the Arcanaloth is already covered by its own file",
    covered.some(c => c.name === "Arcanaloth"), true);
  check("and so is the beholder", covered.some(c => c.name === "Beholder"), true);
}

console.log("");
console.log(pass + " passed, " + fail + " failed");
if (fail) process.exitCode = 1;
