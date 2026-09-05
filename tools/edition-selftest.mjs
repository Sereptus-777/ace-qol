// ─── Which edition branch does a spell take, and does it take one at all? ────
//
// ⚠️🔴 THE REGISTRY SPEAKS TWO DIALECTS. Ten entries key their overrides
// `legacy` / `modern`; eleven key them "2014" / "2024". `getActiveRulesVersion`
// returns legacy/modern, so before 2026-09-05 the first ten fired and the other
// eleven never had — including four added the same night. Switching the lookup
// to `resolveEdition`, which returns 2014/2024, fixed those eleven and killed
// the ten. A straight trade of one silent breakage for another.
//
// ⚠️ SLEEP IS WHY IT MATTERS. Its 2014 branch is not a tweak, it is a different
// spell: no save at all and a 5d8 hit-point pool where 2024 has a Wisdom save.
// A 2014 caster was getting the 2024 rules outright, and nothing said so —
// a missing edition branch does not throw, does not warn, and does not change
// the shape of anything.
//
// ⚠️ AND THE ITEM DECIDES, NOT THE WORLD. His library holds both copies of a
// dozen spells side by side, so the world setting cannot be the answer.
//
// Run:  node tools/edition-selftest.mjs
globalThis.Hooks = { on: () => {}, once: () => {}, off: () => {}, callAll: () => {} };
globalThis.ui = { notifications: { info: () => {}, warn: () => {}, error: () => {} } };
globalThis.CONFIG = { Actor: {}, Token: {}, Item: {}, DND5E: { skills: {}, abilities: {} }, Dice: {} };
class _App { static DEFAULT_OPTIONS = {}; constructor() {} render() {} close() {} }
globalThis.foundry = {
  utils: { escapeHTML: (s) => String(s), mergeObject: (a, b) => ({ ...a, ...b }),
           deepClone: (o) => JSON.parse(JSON.stringify(o ?? null)) },
  applications: { api: { DialogV2: { wait: async () => null }, ApplicationV2: _App,
                         HandlebarsApplicationMixin: (B) => class extends B {} },
                  ux: {}, apps: {}, handlebars: {} },
};
globalThis.canvas = { grid: { size: 100, distance: 5 }, scene: { regions: [] } };
globalThis.game = { settings: { get: () => false, register: () => {} }, user: { isGM: true },
  users: [], i18n: { localize: (k) => k }, time: { worldTime: 0 },
  modules: { get: () => ({ active: true }) }, items: [], actors: [] };

const { SpellPipeline } = await import(
  "file:///D:/FoundryVTT/Data/modules/ace-qol/scripts/spell-pipeline/pipeline.mjs");
const { SPELL_REGISTRY } = await import(
  "file:///D:/FoundryVTT/Data/modules/ace-qol/scripts/spell-pipeline/registry/_index.mjs");

let pass = 0, fail = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log((ok ? "  ok   " : "  FAIL ") + String(label).padEnd(58)
    + "got " + JSON.stringify(got) + ", want " + JSON.stringify(want));
};
const item = (rules) => ({ system: { source: { rules } } });

console.log("\nBOTH DIALECTS FIRE, BECAUSE THE REGISTRY USES BOTH");
const oldStyle = { range: 60, byEdition: { legacy: { range: 90 }, modern: { range: 60 } } };
const newStyle = { range: 60, byEdition: { "2014": { range: 90 }, "2024": { range: 60 } } };
check("legacy/modern entry, 2014 item", SpellPipeline._applyEdition(oldStyle, item("2014")).range, 90);
check("legacy/modern entry, 2024 item", SpellPipeline._applyEdition(oldStyle, item("2024")).range, 60);
check("2014/2024 entry, 2014 item", SpellPipeline._applyEdition(newStyle, item("2014")).range, 90);
check("2014/2024 entry, 2024 item", SpellPipeline._applyEdition(newStyle, item("2024")).range, 60);

console.log("\nAND A BRANCH THAT ONLY EXISTS FOR ONE EDITION STILL WORKS");
// Sleep's shape: only the 2014 side is overridden, 2024 is the baseline.
const oneSided = { range: 60, save: { ability: "wis" },
  byEdition: { legacy: { range: 90, save: null, shape: "template-pool" } } };
check("2014 item takes the only branch there is",
  [SpellPipeline._applyEdition(oneSided, item("2014")).range,
   SpellPipeline._applyEdition(oneSided, item("2014")).shape], [90, "template-pool"]);
check("2024 item keeps the baseline untouched",
  [SpellPipeline._applyEdition(oneSided, item("2024")).range,
   SpellPipeline._applyEdition(oneSided, item("2024")).save?.ability], [60, "wis"]);

console.log("\nNOTHING SILLY GETS THROUGH");
check("an entry with no byEdition is returned as it is",
  SpellPipeline._applyEdition({ range: 30 }, item("2014")).range, 30);
// ⚠️ A MISSPELLED KEY MUST NOT SILENTLY BECOME THE OTHER EDITION'S RULES.
check("a key nothing recognises leaves the baseline alone",
  SpellPipeline._applyEdition({ range: 30, byEdition: { "5e2014": { range: 99 } } },
    item("2014")).range, 30);
check("an item that states no edition still resolves to something",
  [30, 99].includes(SpellPipeline._applyEdition(
    { range: 30, byEdition: { "2014": { range: 99 } } }, { system: {} }).range), true);

console.log("\nTHE REAL REGISTRY, NOT A STUB");
// ⚠️ EVERY KEY IN THE SHIPPED REGISTRY MUST BE ONE THE LOOKUP READS. This is the
// check that would have caught the whole thing on the day it was written.
const KNOWN = new Set(["2014", "2024", "legacy", "modern"]);
const bad = [];
for (const [name, entry] of Object.entries(SPELL_REGISTRY ?? {})) {
  for (const k of Object.keys(entry?.byEdition ?? {})) if (!KNOWN.has(k)) bad.push(`${name}.${k}`);
}
check("no entry keys an edition with a word nothing reads", bad, []);

// Sleep is the one that proved it, so it is pinned by name.
const sleep = SPELL_REGISTRY?.["sleep"];
check("Sleep still has a 2014 branch at all", !!(sleep?.byEdition?.legacy ?? sleep?.byEdition?.["2014"]), true);
check("and a 2014 caster gets the hit-point pool, not the Wisdom save",
  SpellPipeline._applyEdition(sleep, item("2014")).shape, "template-pool");
check("while a 2024 caster gets the save",
  SpellPipeline._applyEdition(sleep, item("2024")).save?.ability, "wis");

console.log("\nA SUFFIX MUST NOT BEAT THE WHOLE REGISTRY");
// ⚠️🔴 THIS COST MONTHS. The registry lookup was `name.trim().toLowerCase()`
// and nothing else, while his 2014 content is named "Aura of Vitality (Legacy)"
// and the entry is keyed "aura of vitality". It never matched. Every
// Legacy-suffixed spell in his world missed its own hand-written entry and fell
// through to the inference engine, which worked out a different shape — so Aura
// of Vitality read as "self" with "emanation-heal" sitting right there.
//
// Proven live on 2026-09-05: the console said shape=self (worked-out) for a
// spell with a complete curated entry.
{
  const spell = (name) => ({ name, type: "spell", system: { source: { rules: "2014" } } });
  check("the plain name still matches",
    SpellPipeline._getEntry(spell("Aura of Vitality"))?.shape, "emanation-heal");
  check("and so does the Legacy-suffixed one HE actually owns",
    SpellPipeline._getEntry(spell("Aura of Vitality (Legacy)"))?.shape, "emanation-heal");
  check("a suffix match is the CURATED entry, not a worked-out guess",
    SpellPipeline._getEntry(spell("Aura of Vitality (Legacy)"))?.inferred, undefined);
  check("Mass Cure Wounds (Legacy) finds its entry too",
    SpellPipeline._getEntry(spell("Mass Cure Wounds (Legacy)"))?.shape, "template-heal");
  check("and it still takes the 2014 branch after the rename",
    typeof SpellPipeline._getEntry(spell("Mass Cure Wounds (Legacy)"))?.heal?.formula, "function");
  // ⚠️ AND A NAME THAT IS GENUINELY NOT OURS STAYS NOT OURS. Stripping too
  // eagerly would hand a homebrew spell somebody else's rules.
  check("a spell nobody wrote an entry for is still unregistered",
    SpellPipeline._getEntry(spell("Grond's Bespoke Fireworks (Legacy)"))?.shape ?? null, null);
  check("the normaliser is the shared one",
    SpellPipeline._normalizedKey("Sleep (Legacy)"), "sleep");
}

console.log("");
console.log(pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
