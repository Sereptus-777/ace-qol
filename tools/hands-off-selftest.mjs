// ─── A spell the pipeline owns but hands off: is it still resolved? ─────────
//
// Johnny, 2026-09-11: Varek cast Prismatic Wall and nothing happened. No wall,
// no card, no error. The pipeline "owned" the spell, and four places treated
// that as "the pipeline will finish it":
//   1. the activity chooser skipped the question and took the Blinding Save
//   2. the save engine stood aside for a pipeline that had nothing to do
//   3. the pipeline held back a spell slot for a save that costs none, and then
//      charged it (7th level)
//   4. the pipeline cancelled dnd5e's damage roll, which is the roll the save
//      engine makes for Fireball, so a Fireball upcast lost its extra dice
//
// All four now ask one question, SpellPipeline.resolvesItself. This loads the
// REAL pipeline, registers its REAL hooks, and drives them with the real spells
// out of the 2024 book.
//
// ⚠️ IT WRITES NOTHING AND TOUCHES NO WORLD DATA.
//
// Run:  node tools/hands-off-selftest.mjs
// ──────────────────────────────────────────────────────────────────────────────

import { pathToFileURL } from "node:url";
import { existsSync, cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";

const SYSTEM = "D:/FoundryVTT/Data/systems/dnd5e";
const LEVELDB = "D:/FoundryVTT/Foundry Virtual Tabletop/resources/app/node_modules/classic-level/index.js";
if (!existsSync(LEVELDB)) { console.log("classic-level not found beside Foundry; nothing to read."); process.exit(0); }
const { ClassicLevel } = await import(pathToFileURL(LEVELDB).href);

/* ── Enough of Foundry for the pipeline to load and register ───────────── */
const GM = { id: "gm", isGM: true, name: "GM" };
globalThis.game = { ready: true, packs: [], user: GM, users: Object.assign([GM], { activeGM: GM }),
  actors: { get: () => null, contents: [] }, scenes: { get: () => null }, combat: null,
  time: { worldTime: 0 }, settings: { get: () => true, set: async () => {}, register: () => {} },
  i18n: { localize: (k) => k }, modules: { get: () => null } };
const hooks = {};
globalThis.Hooks = { on: (n, f) => { (hooks[n] ??= []).push(f); return hooks[n].length; },
  once: () => {}, off: () => {}, call: () => true, callAll: () => {} };
globalThis.ui = { notifications: { info: () => {}, warn: () => {}, error: () => {} } };
globalThis.CONFIG = { DND5E: { abilities: {}, skills: {}, damageTypes: {}, senses: {},
  areaTargetTypes: {}, activityActivationTypes: {} }, statusEffects: [], Canvas: { polygonBackends: {} } };
class _App { static DEFAULT_OPTIONS = {}; constructor() {} render() {} close() {} }
globalThis.foundry = {
  utils: { getProperty: () => null, setProperty: () => {}, escapeHTML: (x) => String(x ?? ""),
    mergeObject: (a, b) => ({ ...a, ...b }), deepClone: (o) => JSON.parse(JSON.stringify(o)),
    randomID: () => "id", getRoute: (p) => p, isEmpty: (o) => !o || !Object.keys(o).length },
  applications: { api: { ApplicationV2: _App, DialogV2: { wait: async () => null },
    HandlebarsApplicationMixin: (B) => class extends B {} },
    ux: { TextEditor: { implementation: { enrichHTML: async (h) => h } } },
    apps: {}, handlebars: {}, instances: new Map() },
  dice: { terms: {} },
  canvas: { placeables: { MeasuredTemplate: class {} } },
};
globalThis.document = { querySelectorAll: () => [], querySelector: () => null,
  createElement: () => ({ style: {}, classList: { add() {} }, setAttribute() {}, appendChild() {} }) };
globalThis.canvas = { grid: { size: 100, distance: 5 }, scene: null, tokens: { placeables: [] } };
globalThis.CONST = { ACTIVE_EFFECT_MODES: { ADD: 2, CUSTOM: 0, OVERRIDE: 5 }, GRID_SNAPPING_MODES: {} };
globalThis.ChatMessage = { create: async () => {}, getSpeaker: () => ({}) };
globalThis.fromUuid = async () => null;
globalThis.fromUuidSync = () => null;

let SpellPipeline, HANDS_OFF_SHAPES;
try {
  ({ SpellPipeline, HANDS_OFF_SHAPES } = await import(
    "file:///D:/FoundryVTT/Data/modules/ace-qol/scripts/spell-pipeline/pipeline.mjs"));
} catch (err) {
  console.log("could not load the pipeline under stubs:", err?.message ?? err);
  process.exit(2);
}

/* ── The real spells ────────────────────────────────────────────────────── */
const scratch = mkdtempSync(join(tmpdir(), "ace-handsoff-"));
const book = new Map();
{
  const dst = join(scratch, "spells24");
  cpSync(`${SYSTEM}/packs/spells24`, dst, { recursive: true, filter: (s) => basename(s) !== "LOCK" });
  const db = new ClassicLevel(dst, { valueEncoding: "json" });
  await db.open();
  const effs = new Map(), items = [];
  for await (const [k, v] of db.iterator()) {
    if (k.startsWith("!items!")) items.push(v);
    else if (k.startsWith("!items.effects!")) {
      const id = k.slice("!items.effects!".length).split(".")[0];
      if (!effs.has(id)) effs.set(id, []);
      effs.get(id).push(v);
    }
  }
  await db.close();
  for (const it of items) book.set(it.name, { doc: it, effects: effs.get(it._id) ?? [] });
}
rmSync(scratch, { recursive: true, force: true });

const actor = { id: "v", name: "Varek Thalor", type: "npc",
  system: { spells: { spell7: { value: 1, max: 1 } }, attributes: {} }, effects: { contents: [] }, items: [] };
function live(name) {
  const src = book.get(name);
  if (!src) throw new Error(`"${name}" is not in the 2024 book`);
  const item = { ...src.doc, id: src.doc._id, uuid: `Actor.v.Item.${src.doc._id}`, actor,
    effects: src.effects, getFlag: () => undefined };
  const acts = new Map(Object.entries(src.doc.system?.activities ?? {})
    .map(([k, a]) => [k, { ...a, id: a._id ?? k, uuid: `${item.uuid}.Activity.${a._id ?? k}`, item }]));
  item.system = { ...src.doc.system, properties: new Set(src.doc.system?.properties ?? []), activities: acts };
  return item;
}
const activityNamed = (item, n) => [...item.system.activities.values()].find(a => a.name === n);

let pass = 0, fail = 0;
const check = (label, got, want) => {
  const ok = got === want;
  ok ? pass++ : fail++;
  console.log((ok ? "  ok   " : "  FAIL ") + label.padEnd(66) + `got ${got}, want ${want}`);
};

/* ── 1. Who resolves what ───────────────────────────────────────────────── */
console.log("1. DOES THE PIPELINE FINISH IT, OR HAND IT OFF?");
const wall = live("Prismatic Wall"), fireball = live("Fireball"), mm = live("Magic Missile");
check("the pipeline owns Prismatic Wall", SpellPipeline.owns(wall), true);
check("as a shape it hands off", HANDS_OFF_SHAPES.has(SpellPipeline._getEntry(wall)?.shape), true);
check("so it does not resolve Prismatic Wall itself", SpellPipeline.resolvesItself(wall), false);
check("the pipeline owns Fireball", SpellPipeline.owns(fireball), true);
check("and hands it to the save engine", SpellPipeline.resolvesItself(fireball), false);
check("Magic Missile it resolves itself", SpellPipeline.resolvesItself(mm), true);

/* ── 2. The spell slot ──────────────────────────────────────────────────── */
console.log("\n2. THE SPELL SLOT");
const before = (hooks["dnd5e.preUseActivity"] ?? []).length;
SpellPipeline.initialize();
const preUse = (hooks["dnd5e.preUseActivity"] ?? []).slice(before);
const preDmg = hooks["dnd5e.preRollDamageV2"] ?? [];
check("the pipeline registers its pre-cast hook", preUse.length > 0, true);
const blind = activityNamed(wall, "Blinding Save");
const uBlind = { consume: { spellSlot: false } };   // what dnd5e hands over for a free follow-up
for (const h of preUse) h(blind, uBlind);
check("a follow-up that costs nothing is not held for a slot", !!blind._aceSlotDeferred, false);
const create = activityNamed(wall, "Create Wall");
const uCreate = { consume: { spellSlot: true } };   // what dnd5e hands over for a real cast
for (const h of preUse) h(create, uCreate);
check("the real cast still holds its slot until the wall lands", create._aceSlotDeferred, true);
check("and tells dnd5e not to take it yet", uCreate.consume.spellSlot, false);
await SpellPipeline._commitSlotOnTemplatePlaced(blind, 7);
check("nothing is charged for the Blinding Save", actor.system.spells.spell7.value, 1);

/* ── 3. The damage roll ─────────────────────────────────────────────────── */
console.log("\n3. THE DAMAGE ROLL");
const verdict = (item) => preDmg.map(h => h({ subject: { item } })).some(r => r === false);
check("Fireball's damage roll is left alone (the save engine makes it)", verdict(fireball), false);
check("Prismatic Wall's is left alone too", verdict(wall), false);
check("Magic Missile's stray native roll is still refused", verdict(mm), true);

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
