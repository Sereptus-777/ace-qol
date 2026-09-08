// ─── The classifier's shape versus the plan's, for every shipped spell ───────
//
// ⚠️🔴 THIS IS THE MEASUREMENT THAT STOPPED ME SWITCHING WHOLESALE. Phase 3
// was going to be "the plan decides the shape, entries demoted to overrides".
// Run against both books it moved 145 spells, and reading them showed the plan
// is not ready to own that decision yet:
//
//    50  (none) -> summon        ACE has no summon resolver. Claiming these is
//                                exactly the 0.14.2 bug: "my druid, I can't
//                                find where I can summon fey anymore."
//    28  template-save -> self   Alarm, Minor Illusion, Fabricate. A placed
//                                area that asks nothing of anybody is not the
//                                caster; ACE should claim none of them.
//    21  (none) -> self          Misty Step, Goodberry, Divine Smite. They work
//                                today through dnd5e.
//     3  touch -> (none)         Heal, Mass Heal, Power Word Heal, lost.
//
// So the shape mapping is kept HERE, measured and unwired, and only the one
// fork the plan is demonstrably better at is live in classify-item.
//
// Run:  node tools/shape-diff.mjs
import { pathToFileURL } from "node:url";
import { existsSync, cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const LEVELDB = "D:/FoundryVTT/Foundry Virtual Tabletop/resources/app/node_modules/classic-level/index.js";
const { ClassicLevel } = await import(pathToFileURL(LEVELDB).href);

globalThis.Hooks = { on: () => {}, once: () => {}, off: () => {}, callAll: () => {}, call: () => true };
globalThis.ui = { notifications: { info: () => {}, warn: () => {}, error: () => {} } };
globalThis.CONFIG = { DND5E: { abilities: {}, skills: {}, damageTypes: {}, senses: {} }, statusEffects: [] };
globalThis.foundry = { utils: { escapeHTML: String, deepClone: (o) => o,
  mergeObject: (a, b) => ({ ...a, ...b }), getProperty: () => null }, applications: { api: {}, ux: {} } };
globalThis.game = { settings: { get: () => "2024", register: () => {} },
  i18n: { localize: (k) => k }, actors: [], scenes: [], user: { isGM: true } };
globalThis.canvas = { grid: { size: 100, distance: 5 }, tokens: { placeables: [] } };

const Q = "D:/FoundryVTT/Data/modules/ace-qol/scripts";
const { readActionFacts } = await import(pathToFileURL(`${Q}/inference/action-facts.mjs`).href);
const { planFor, shapeFromPlan } = await import(pathToFileURL(`${Q}/inference/spell-plan.mjs`).href);
const { classifyItem } = await import(pathToFileURL(`${Q}/inference/classify-item.mjs`).href);
const { DescriptionParser } = await import(pathToFileURL(`${Q}/description-parser.mjs`).href);
const { getSpellTiming } = await import(pathToFileURL(`${Q}/spell-timing.mjs`).href);

const live = (doc) => ({ ...doc, system: { ...doc.system,
  properties: new Set(doc.system?.properties ?? []),
  activities: new Map(Object.entries(doc.system?.activities ?? {})) } });

const scratch = mkdtempSync(join(tmpdir(), "ace-shape-"));
const openPack = async (path) => {
  try { const db = new ClassicLevel(path, { valueEncoding: "json" }); await db.open(); return db; }
  catch (_) {
    const copy = join(scratch, path.split(/[\\/]/).pop());
    cpSync(path, copy, { recursive: true, filter: (s) => !/[\\/]LOCK$/i.test(s) });
    const db = new ClassicLevel(copy, { valueEncoding: "json" }); await db.open(); return db;
  }
};

let same = 0, bothNull = 0;
const diffs = new Map();       // "old -> new" : [names]
for (const p of ["D:/FoundryVTT/Data/systems/dnd5e/packs/spells",
                 "D:/FoundryVTT/Data/systems/dnd5e/packs/spells24"]) {
  if (!existsSync(p)) continue;
  const db = await openPack(p);
  for await (const [k, doc] of db.iterator()) {
    if (!k.startsWith("!items!") || doc?.type !== "spell") continue;
    const item = live(doc);
    let parsed = null, timing = null;
    try { parsed = DescriptionParser.parse(item); } catch (_) { }
    try { timing = getSpellTiming(item); } catch (_) { }
    const facts = (() => { try { return readActionFacts(item, { parsed }); } catch (_) { return null; } })();

    const old = (() => { try { return classifyItem(item, { parsed, timing }).shape ?? null; }
                         catch (_) { return null; } })();
    const plan = planFor(item, { facts, parsed, timing });
    const now = shapeFromPlan(plan);

    if (old === now) { old === null ? bothNull++ : same++; continue; }
    const key = `${old ?? "(none)"}  ->  ${now ?? "(none)"}`;
    if (!diffs.has(key)) diffs.set(key, []);
    diffs.get(key).push(doc.name);
  }
  await db.close();
}
try { rmSync(scratch, { recursive: true, force: true }); } catch (_) { }

const total = same + bothNull + [...diffs.values()].reduce((n, a) => n + a.length, 0);
console.log(`spells read           : ${total}`);
console.log(`same shape            : ${same}`);
console.log(`neither claims it     : ${bothNull}`);
console.log(`different             : ${total - same - bothNull}`);
console.log("");
for (const [k, names] of [...diffs].sort((a, b) => b[1].length - a[1].length)) {
  console.log(`${String(names.length).padStart(3)}  ${k}`);
  console.log(`     ${[...new Set(names)].slice(0, 12).join(", ")}`);
}
