// ─── The replay: what he has already seen working, put through ACE again ────
//
// Johnny, 2026-09-11: "It's like every attack, every spell attack, every
// fucking spell, every feature. We have to go through it one by one. When we do
// a sweep or something like that, all the rest of it gets fucking lost, and we
// have to redo simple spells like magic missile, fireball."
//
// Two halves:
//
//   PINNED   two lists, kept apart. SEEN AT THE TABLE: things he confirmed
//            working in his game, with the date he said so. FIXED, NOT YET
//            SEEN: my fixes he has not tried yet. A pinned check that fails
//            is a regression, full stop; the label says whose word it rests on.
//
//   GOLDEN   every item on every creature in his world, put through ACE's own
//            deciders (what a press means, who owns the spell, what each save
//            does on a failure, which saves follow a hit, who an area catches,
//            what a hover shows) and compared with the last accepted run. Any
//            change anywhere is listed, item by item, before a release. It is
//            read, not assumed: each change is either the fix I meant or a
//            regression I did not.
//
// ⚠️ WHAT THIS CANNOT SEE. It runs ACE's real code under a stand-in for
// Foundry, on a copy of his real items. It cannot see a hook dnd5e stopped
// firing, a card that draws wrong, or timing at the table. hook-check.py and
// card-wrap-check.py cover the first two; the third needs a live game.
//
// ⚠️ IT WRITES NOTHING TO HIS WORLD. The world is read from a copy of its
// files. The golden record lives OUTSIDE the repository, because it is made of
// his campaign: D:/FoundryVTT/ACE-Replay/.
//
// Run:  node tools/replay-selftest.mjs [world]            compare with the last accepted run
//       node tools/replay-selftest.mjs [world] --accept   the listed changes are meant; record them
// ──────────────────────────────────────────────────────────────────────────────

import { pathToFileURL } from "node:url";
import { existsSync, cpSync, mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";

const argv = process.argv.slice(2);
const opt = (name) => { const i = argv.indexOf(name); return i >= 0 ? (argv[i + 1] ?? "") : null; };
const ACCEPT = argv.includes("--accept");
// --show "Neferon / Claws|Fireball": print what ACE decides for matching items, and stop.
const SHOW = opt("--show");
const WORLD = argv.find((a, i) => !a.startsWith("--") && argv[i - 1] !== "--show") ?? "hijinx";
const ROOT = "D:/FoundryVTT";
const SYSTEM = `${ROOT}/Data/systems/dnd5e`;
const WORLD_DATA = `${ROOT}/Data/worlds/${WORLD}/data`;
const LEVELDB = `${ROOT}/Foundry Virtual Tabletop/resources/app/node_modules/classic-level/index.js`;
const GOLDEN_DIR = `${ROOT}/ACE-Replay`;
const GOLDEN = `${GOLDEN_DIR}/golden-${WORLD}.json`;
const MODULE = "file:///D:/FoundryVTT/Data/modules/ace-qol";

if (!existsSync(LEVELDB) || !existsSync(join(WORLD_DATA, "actors", "CURRENT"))) {
  console.log(`(no copy of ${WORLD} to replay on this machine; nothing was checked)`);
  process.exit(0);
}
const { ClassicLevel } = await import(pathToFileURL(LEVELDB).href);

/* ── His world, read from a copy ────────────────────────────────────────── */
const scratch = mkdtempSync(join(tmpdir(), "ace-replay-"));
async function rows(path, name) {
  if (!existsSync(join(path, "CURRENT"))) return [];
  const dst = join(scratch, name);
  cpSync(path, dst, { recursive: true, filter: (s) => basename(s) !== "LOCK" });
  const db = new ClassicLevel(dst, { valueEncoding: "json" });
  await db.open();
  const out = [];
  for await (const kv of db.iterator()) out.push(kv);
  await db.close();
  return out;
}
const actorRows = await rows(join(WORLD_DATA, "actors"), "actors");
const settingRows = await rows(join(WORLD_DATA, "settings"), "settings");

// ⚠️ HIS SETTINGS, NOT DEFAULTS. A shape he corrected by hand lives in a world
// setting, and the replay has to see the same corrections his table does.
const SETTINGS = new Map();
for (const [k, v] of settingRows) {
  if (!k.startsWith("!settings!") || !v?.key) continue;
  let val = v.value;
  try { val = JSON.parse(v.value); } catch (_) { /* a plain string */ }
  SETTINGS.set(v.key, val);
}

// ⚠️ THE BOOKS, AS HIS TABLE LOADS THEM (The One Road, 2026-09-14). A named
// official spell or feature takes its recipe from its book, and his sheet is
// only this cast's instance. The books reader indexes every Item pack Foundry
// hands it at boot: the system's, every active module's and his world's. The
// same packs are read here, from a copy, so the replay reads what the cast reads.
const readJson = (path) => { try { return JSON.parse(readFileSync(path, "utf8")); } catch (_) { return null; } };
const packSources = [];
for (const p of readJson(`${SYSTEM}/system.json`)?.packs ?? []) {
  if (p.type === "Item") packSources.push({ packageType: "system", packageName: "dnd5e", dir: SYSTEM, pack: p });
}
for (const [id, on] of Object.entries(SETTINGS.get("core.moduleConfiguration") ?? {})) {
  const dir = `${ROOT}/Data/modules/${id}`;
  const m = on ? readJson(`${dir}/module.json`) : null;
  for (const p of m?.packs ?? []) {
    if (p.type === "Item") packSources.push({ packageType: "module", packageName: id, dir, pack: p, protected: m.protected === true });
  }
}
for (const p of readJson(`${ROOT}/Data/worlds/${WORLD}/world.json`)?.packs ?? []) {
  if (p.type === "Item") packSources.push({ packageType: "world", packageName: WORLD, dir: `${ROOT}/Data/worlds/${WORLD}`, pack: p });
}
const BOOK_PACKS = [];
for (const s of packSources) {
  const collection = `${s.packageType === "world" ? "world" : s.packageName}.${s.pack.name}`;
  BOOK_PACKS.push({ ...s, collection, label: s.pack.label ?? collection,
    rows: await rows(join(s.dir, s.pack.path ?? `packs/${s.pack.name}`), `pack-${collection}`) });
}
rmSync(scratch, { recursive: true, force: true });

/** dnd5e's own list of activation types, read from the installed system. */
function activationTypes() {
  const src = readFileSync(`${SYSTEM}/dnd5e.mjs`, "utf8");
  const at = src.indexOf("DND5E.activityActivationTypes = {");
  if (at < 0) throw new Error("dnd5e's activation types are not where they were in dnd5e.mjs");
  const block = src.slice(at, src.indexOf("\n};", at));
  const out = {};
  let key = null;
  for (const line of block.split("\n")) {
    const m = line.match(/^ {2}(\w+): \{/);
    if (m) { key = m[1]; out[key] = { passive: false }; continue; }
    if (key && /passive:\s*true/.test(line)) out[key].passive = true;
  }
  return out;
}

/* ── Enough of Foundry for ACE's deciders to run ─────────────────────────── */
const GM = { id: "gm", isGM: true, name: "GM" };
const ACTORS = new Map();
const ITEMS = new Map();
const posted = [];
globalThis.game = { ready: true, packs: [], user: GM, users: Object.assign([GM], { activeGM: GM }),
  actors: { get: (id) => ACTORS.get(id) ?? null, contents: [], find: (fn) => [...ACTORS.values()].find(fn) },
  items: { get: () => null }, scenes: { get: () => null }, combat: null, time: { worldTime: 1000 },
  settings: { get: (m, k) => SETTINGS.get(`${m}.${k}`), set: async () => {}, register: () => {} },
  i18n: { localize: (k) => k, format: (k) => k }, modules: { get: () => null } };
const hooks = {};
globalThis.Hooks = { on: (n, f) => { (hooks[n] ??= []).push(f); }, once: () => {}, off: () => {},
  call: () => true, callAll: () => {} };
globalThis.ui = { notifications: { info: () => {}, warn: () => {}, error: () => {} } };
globalThis.CONFIG = { DND5E: {
  abilities: { str: { label: "Strength" }, dex: { label: "Dexterity" }, con: { label: "Constitution" },
    int: { label: "Intelligence" }, wis: { label: "Wisdom" }, cha: { label: "Charisma" } },
  skills: {}, damageTypes: {}, senses: {}, spellSchools: {}, conditionTypes: {},
  individualTargetTypes: {}, areaTargetTypes: {}, activityActivationTypes: activationTypes() },
  statusEffects: [], Canvas: { polygonBackends: {} } };
class _App { static DEFAULT_OPTIONS = {}; constructor() {} render() {} close() {} }
const esc = (x) => String(x ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;")
  .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const getProperty = (o, path) => String(path ?? "").split(".").reduce((x, k) => (x == null ? undefined : x[k]), o);
globalThis.foundry = {
  utils: { getProperty, setProperty: () => {}, escapeHTML: esc,
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
globalThis.canvas = { grid: { size: 100, distance: 5 }, scene: null, tokens: { placeables: [], controlled: [] } };
globalThis.CONST = { ACTIVE_EFFECT_MODES: { ADD: 2, CUSTOM: 0, OVERRIDE: 5 }, GRID_SNAPPING_MODES: {} };
globalThis.ChatMessage = { create: async (data) => { posted.push(data);
  return { id: `msg${posted.length}`, ...data, flags: data?.flags ?? {} }; }, getSpeaker: () => ({}) };
globalThis.fromUuid = async (u) => ITEMS.get(u) ?? null;
globalThis.fromUuidSync = (u) => ITEMS.get(u) ?? null;
// ⚠️ EVERY DIE ROLLS A 1. The least a roll can do, and the same on every run,
// so a replayed save always fails and its failure is what gets checked.
globalThis.Roll = class Roll {
  constructor(formula) { this.formula = String(formula ?? "0"); this.terms = []; }
  async evaluate() {
    const terms = [];
    const expr = this.formula.replace(/(\d*)d(\d+)(k[hl]\d*)?/gi, (_m, n, faces, keep) => {
      const count = Number(n || 1);
      terms.push({ faces: Number(faces), number: count,
        results: Array.from({ length: count }, () => ({ result: 1, active: true })) });
      return String(keep ? 1 : count);
    });
    let total = 0, sign = 1;
    for (const tok of expr.replace(/\s+/g, "").split(/([+-])/)) {
      if (tok === "+") sign = 1; else if (tok === "-") sign = -1;
      else if (tok) total += sign * (Number(tok) || 0);
    }
    this.total = total; this.terms = terms; this._evaluated = true;
    return this;
  }
};

/** A Foundry Collection: a Map that iterates its values, as Foundry's does. */
class Collection extends Map {
  *[Symbol.iterator]() { yield* this.values(); }
  get contents() { return [...this.values()]; }
  find(fn) { return this.contents.find(fn); }
  filter(fn) { return this.contents.filter(fn); }
  some(fn) { return this.contents.some(fn); }
  map(fn) { return this.contents.map(fn); }
}

let SpellPipeline, SaveEngine, PostHitSaves, DescriptionParser, readSaveOutcome,
  readActivities, readAppliedConditions, decideActivityChoice, upCanBeSeen, aceStripEnrichers,
  readPrismaticWall, PrismaticWallEngine, RepeatingSaveEngine, spellIsUp,
  recipesFor, recipeLine, formulaValue, whatLands, HpDoor, SignalDoor, untilDiceLand, CombatState,
  RulesIndex, bookReview;
try {
  ({ readPrismaticWall } = await import(`${MODULE}/scripts/rules/prismatic-wall.mjs`));
  ({ PrismaticWallEngine } = await import(`${MODULE}/scripts/prismatic-wall-engine.mjs`));
  ({ RepeatingSaveEngine } = await import(`${MODULE}/scripts/repeating-save-engine.mjs`));
  ({ SpellPipeline } = await import(`${MODULE}/scripts/spell-pipeline/pipeline.mjs`));
  ({ SaveEngine } = await import(`${MODULE}/scripts/save-engine.mjs`));
  ({ PostHitSaves } = await import(`${MODULE}/scripts/post-hit-saves.mjs`));
  ({ DescriptionParser } = await import(`${MODULE}/scripts/description-parser.mjs`));
  ({ readSaveOutcome } = await import(`${MODULE}/scripts/inference/save-outcome-effects.mjs`));
  ({ readActivities, readAppliedConditions } = await import(`${MODULE}/scripts/read-activities.mjs`));
  ({ decideActivityChoice, upCanBeSeen, spellIsUp } = await import(`${MODULE}/scripts/activity-choice.mjs`));
  ({ aceStripEnrichers } = await import(`${MODULE}/scripts/description-reader.mjs`));
  ({ recipesFor, recipeLine, bookReview } = await import(`${MODULE}/scripts/inference/recipe.mjs`));
  ({ RulesIndex } = await import(`${MODULE}/scripts/rules/rules-index.mjs`));
  ({ formulaValue } = await import(`${MODULE}/scripts/inference/formula-value.mjs`));
  ({ whatLands } = await import(`${MODULE}/scripts/road/what-lands.mjs`));
  ({ HpDoor, SignalDoor, untilDiceLand } = await import(`${MODULE}/scripts/road/doors.mjs`));
  ({ CombatState } = await import(`${MODULE}/scripts/combat-state.mjs`));
} catch (err) {
  console.log("could not load ACE under the stand-in:", err?.stack ?? err);
  process.exit(2);
}

/* ── His creatures, the way Foundry hands them over ──────────────────────── */
const itemsByActor = new Map(), effectsByItem = new Map(), rawActors = [];
for (const [k, v] of actorRows) {
  if (k.startsWith("!actors!")) rawActors.push(v);
  else if (k.startsWith("!actors.items!")) {
    const a = k.slice("!actors.items!".length).split(".")[0];
    if (!itemsByActor.has(a)) itemsByActor.set(a, []);
    itemsByActor.get(a).push(v);
  } else if (k.startsWith("!actors.items.effects!")) {
    const [a, i] = k.slice("!actors.items.effects!".length).split(".");
    const key = `${a}.${i}`;
    if (!effectsByItem.has(key)) effectsByItem.set(key, []);
    effectsByItem.get(key).push(v);
  }
}
const asSet = (v) => new Set(Array.isArray(v) ? v : (v instanceof Set ? [...v] : (v ? [v] : [])));

// ⚠️ A STORED ITEM IS NOT A LOADED ONE (09-13). At load dnd5e 5.3.3 gives a
// weapon that is not a ranged type its reach, 5 feet or 10 with the reach
// property (WeaponData prepareDerivedData), fills every activity that does not
// override from its item's activation, duration, range and target (the
// activity's prepareFinalData, `_setOverride`), and turns a save DC's "initial"
// into the caster's spellcasting for a spell (SaveActivity prepareData). This
// copy skipped all three, so the replay read Varek's Counterspell as an action
// and a longsword as reaching nowhere, while his table reads a reaction and five
// feet. It also works target counts and area sizes out from their formulas
// (TargetField.prepareData, 09-14): Fog Cloud's "20 * @item.level" is a 20-foot
// sphere at the table, and was no size at all here.
const ITEM_FIELDS = { spell: ["activation", "duration", "range", "target"], weapon: ["range"] };
const WEAPON_ATTACK = { simpleM: "melee", simpleR: "ranged", martialM: "melee", martialR: "ranged",
  siege: "ranged" };
const plain = (v) => !!v && typeof v === "object" && !Array.isArray(v) && !(v instanceof Set);
const copy = (v) => JSON.parse(JSON.stringify(v));
/** foundry.utils.mergeObject with its defaults: the source's values win, objects merge. */
function mergeInto(target, source) {
  for (const [k, v] of Object.entries(source ?? {})) {
    if (plain(v) && plain(target[k])) mergeInto(target[k], v);
    else target[k] = plain(v) ? copy(v) : v;
  }
  return target;
}
// The roll data dnd5e fills those formulas from, as far as his items use it:
// the spell's level, ability modifiers, the spellcasting modifier and class
// scale values (Krusk's "@scale.paladin.aura"). A reference left out counts as
// 0, which is what dnd5e does with one it cannot find.
const SCALES = new Map();
function scaleValues(actorId) {
  if (SCALES.has(actorId)) return SCALES.get(actorId);
  const out = {};
  const items = itemsByActor.get(actorId) ?? [];
  const advancementOf = (it) => (Array.isArray(it.system?.advancement) ? it.system.advancement
    : Object.values(it.system?.advancement ?? {}));
  const levelsOf = (id) => Number(items.find(i => i.type === "class"
    && i.system?.identifier === id)?.system?.levels) || 0;
  for (const it of items) {
    if (it.type !== "class" && it.type !== "subclass") continue;
    const id = it.system?.identifier;
    if (!id) continue;
    const level = it.type === "class" ? (Number(it.system?.levels) || 0) : levelsOf(it.system?.classIdentifier);
    for (const adv of advancementOf(it)) {
      if (adv?.type !== "ScaleValue" || !adv.configuration?.identifier) continue;
      // ScaleValueAdvancement#valueForLevel: the entry for the highest level at or below his.
      const scale = adv.configuration.scale ?? {};
      const at = Object.keys(scale).reverse().find(l => Number(l) <= level);
      const value = at === undefined ? null : scale[at]?.value;
      if (value !== null && value !== undefined) (out[id] ??= {})[adv.configuration.identifier] = value;
    }
  }
  SCALES.set(actorId, out);
  return out;
}
function rollDataFor(actor, raw) {
  const abilities = {};
  for (const [k, a] of Object.entries(actor.system?.abilities ?? {})) {
    const v = Number(a?.value);
    abilities[k] = { value: v, mod: Number.isFinite(v) ? Math.floor((v - 10) / 2) : 0 };
  }
  return { abilities, scale: scaleValues(actor.id), item: { level: Number(raw.system?.level) || 0 },
           attributes: { spell: { mod: abilities[actor.system?.attributes?.spellcasting]?.mod ?? 0 },
                         movement: { ...(actor.system?.attributes?.movement ?? {}) } } };
}
/** TargetField.prepareData: a count or size written as a formula is worked out at load. */
function preparedTarget(target, rollData) {
  if (!plain(target)) return target;
  const t = { ...target, affects: { ...(target.affects ?? {}) }, template: { ...(target.template ?? {}) } };
  const atLoad = (v) => {
    if (!v) return v;                        // dnd5e leaves a blank alone
    const { value } = formulaValue(v, rollData);
    return value === null ? v : value;       // one it cannot work out stays as written
  };
  const type = t.affects.type;
  t.affects.count = (type && type !== "self") ? atLoad(t.affects.count) : null;
  if (t.template.type) {
    t.template.count ||= "1";
    for (const k of ["count", "size", "width", "height"]) t.template[k] = atLoad(t.template[k]);
  } else {
    t.template.count = t.template.size = t.template.width = t.template.height = null;
  }
  return t;
}

/** dnd5e's own movement units, read from the installed system: a range in one of these has a number. */
function movementUnits() {
  const src = readFileSync(`${SYSTEM}/dnd5e.mjs`, "utf8");
  const at = src.indexOf("DND5E.movementUnits = {");
  if (at < 0) throw new Error("dnd5e's movement units are not where they were in dnd5e.mjs");
  const block = src.slice(at, src.indexOf("\n};", at));
  const units = new Set([...block.matchAll(/^ {2}(\w+):/gm)].map(m => m[1]));
  if (!units.has("ft")) throw new Error(`dnd5e's movement units read as ${[...units].join(", ") || "nothing"}, without feet`);
  // Each unit's factor to feet, as dnd5e writes it ("5_280", "10 / 3").
  const num = (s) => Number(String(s).replace(/_/g, ""));
  const factors = {};
  for (const m of block.matchAll(/^ {2}(\w+): \{[^}]*?conversion: ([\d_.]+)(?: \/ ([\d_.]+))?/gm)) {
    factors[m[1]] = { conversion: m[3] ? num(m[2]) / num(m[3]) : num(m[2]) };
  }
  if (factors.ft?.conversion !== 1 || factors.mi?.conversion !== 5280) {
    throw new Error(`dnd5e's unit factors read as ${JSON.stringify(factors)}, not feet 1 and miles 5280`);
  }
  return { units, factors };
}
const { units: MOVEMENT_UNITS, factors: MOVEMENT_FACTORS } = movementUnits();
// dnd5e's own unit factors, as its CONFIG carries them at the table.
CONFIG.DND5E.movementUnits = MOVEMENT_FACTORS;
/**
 * RangeField.prepareData: a range in movement units is worked out from its
 * formula at load (Hammer's Aquatic Charge is "@attributes.movement.swim");
 * any other range, self or touch or special, keeps no number.
 */
function preparedRange(range, rollData) {
  if (!plain(range)) return range;
  const r = { ...range };
  if (MOVEMENT_UNITS.has(r.units)) {
    if (r.value) {
      const { value } = formulaValue(r.value, rollData);
      if (value !== null) r.value = value;
    }
  } else r.value = null;
  return r;
}

function loadedSystem(raw, rollData) {
  const system = { ...(raw.system ?? {}) };
  if (raw.type === "spell" && plain(system.target)) system.target = preparedTarget(system.target, rollData);
  if (raw.type === "spell" && plain(system.range)) system.range = preparedRange(system.range, rollData);
  if (raw.type === "weapon" && plain(system.range)) {
    const range = { ...system.range };
    const rch = (raw.system?.properties ?? []).includes("rch");
    if (WEAPON_ATTACK[system.type?.value] === "ranged") range.reach = null;
    // A blank is empty once loaded: dnd5e's number field reads "" as null.
    else if (range.reach === null || range.reach === undefined || range.reach === "") {
      const units = range.units || "ft";
      if (units === "ft") range.reach = rch ? 10 : 5;
      else if (units === "m") range.reach = rch ? 3 : 1.5;
    }
    system.range = range;
  }
  return system;
}
function loadedActivity(a, type, system, rollData) {
  const out = { ...a };
  for (const key of ITEM_FIELDS[type] ?? []) {
    if (!plain(system[key])) continue;
    const own = plain(a[key]) ? copy(a[key]) : {};
    if (!own.override) mergeInto(own, system[key]);
    out[key] = own;
  }
  if (plain(out.target)) out.target = preparedTarget(out.target, rollData);
  if (plain(out.range)) {
    const r = out.range = { ...out.range };
    if ((r.long ?? 0) > (r.value ?? 0)) r.value = r.long;
    else if (r.reach && !r.value) r.value = r.reach;
    out.range = preparedRange(r, rollData);
  }
  const calc = out.save?.dc?.calculation;
  if (plain(out.save?.dc) && (calc === undefined || calc === "initial")) {
    out.save = { ...out.save, dc: { ...out.save.dc, calculation: type === "spell" ? "spellcasting" : "" } };
  }
  // ⚠️ dnd5e FILLS A SAVE'S MISSING "ON A SAVE" WITH "half": its schema's initial
  // value (dnd5e.mjs, SaveActivityData: onSave required, initial "half"). Twelve
  // of his save activities store none, and the live item says half for them.
  if (a.type === "save") {
    const d = plain(out.damage) ? { ...out.damage } : { parts: [] };
    if (d.onSave === undefined || d.onSave === null || d.onSave === "") d.onSave = "half";
    out.damage = d;
  }
  return out;
}

// A book entry is held by no creature: its roll data has none of a creature's numbers.
const BOOK_HOLDER = { id: "(book)", system: {} };
/** An item as Foundry hands it over: loaded the way dnd5e loads it, its effects beside it. */
function loadItem(raw, { uuid, actor = null, effectRows = [], extra = {} }) {
  // `_source` is the stored copy, as on a live document.
  const item = { ...raw, _source: raw, id: raw._id, uuid, actor, parent: actor, flags: raw.flags ?? {},
    getFlag: (s, k) => raw.flags?.[s]?.[k], getRollData: () => ({}), ...extra };
  const rollData = rollDataFor(actor ?? BOOK_HOLDER, raw);
  const system = loadedSystem(raw, rollData);
  // ⚠️ A LIVE ITEM IS NOT ITS STORED COPY: a save's abilities are a Set live.
  const acts = new Collection(Object.entries(raw.system?.activities ?? {}).map(([k, stored]) => {
    const a = loadedActivity(stored, raw.type, system, rollData);
    const id = a._id ?? k;
    return [id, { ...a, _source: stored, id, uuid: `${uuid}.Activity.${id}`, item, actor, parent: item,
      save: a.save ? { ...a.save, ability: asSet(a.save.ability) } : a.save }];
  }));
  const effects = new Collection(effectRows.map(e => [e._id,
    { ...e, id: e._id, uuid: `${uuid}.ActiveEffect.${e._id}`, statuses: new Set(e.statuses ?? []),
      toObject() { return JSON.parse(JSON.stringify({ ...e, statuses: [...(e.statuses ?? [])] })); } }]));
  item.effects = effects;
  item.system = { ...system, properties: new Set(raw.system?.properties ?? []), activities: acts };
  return item;
}
function liveItem(raw, actor) {
  const item = loadItem(raw, { uuid: `${actor.uuid}.Item.${raw._id}`, actor,
    effectRows: effectsByItem.get(`${actor.id}.${raw._id}`) ?? [] });
  ITEMS.set(item.uuid, item);
  return item;
}
for (const raw of rawActors) {
  const actor = { ...raw, id: raw._id, uuid: `Actor.${raw._id}`, system: raw.system ?? {},
    flags: raw.flags ?? {}, statuses: new Set(), effects: new Collection(),
    getFlag: (s, k) => raw.flags?.[s]?.[k], getRollData: () => ({}) };
  const list = (itemsByActor.get(raw._id) ?? []).map(it => liveItem(it, actor));
  actor.items = new Collection(list.map(i => [i.id, i]));
  ACTORS.set(actor.id, actor);
}

const firstActor = (name) => [...ACTORS.values()].find(a => a.name === name) ?? null;
const find = (actorName, itemName) => firstActor(actorName)?.items.find(i => i.name === itemName) ?? null;
const passive = (a) => !!CONFIG.DND5E.activityActivationTypes?.[a?.activation?.type]?.passive;
const label = (a) => (a ? (a.name || a.type) : "nothing");
/** The dialog dnd5e would show: every usable activity, in its own sort order. */
const dialogOrder = (item) => [...readActivities(item)].sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0));
// ⚠️ NOTHING IS UP IN A REPLAY. There is no table, so every spell is read as
// freshly pressed; `up` asks what the same press would offer while it is up.
const choose = (item, up = false) => {
  const offered = dialogOrder(item);
  return decideActivityChoice({ item, activities: readActivities(item), offeredIds: offered.map(a => a.id),
    isMachinery: passive, riderIds: () => PostHitSaves.riderActivityIds(item, offered),
    owns: () => SpellPipeline.owns(item), resolvesItself: () => SpellPipeline.resolvesItself(item),
    spellIsUp: up, upCanBeSeen: () => upCanBeSeen(item, readActivities(item)) });
};
const press = (item) => {
  const acts = readActivities(item);
  if (acts.length < 2) return acts.length ? `uses ${label(acts[0])}` : "nothing to press";
  const d = choose(item);
  return d.kind === "fire" ? `uses ${label(d.activity) ?? d.activityId}`
    : d.kind === "ask" ? `asks: ${d.choices.map(label).join(" | ")}`
    : d.kind === "reveal" ? "shows dnd5e's own list" : "closes the list";
};

// ⚠️ ACE TALKS WHILE IT READS, thousands of lines over a whole world. Held
// back while the deciders run, counted, and the first few shown at the end.
const chatter = { log: 0, warn: 0, samples: [] };
const quiet = async (fn) => {
  const keep = { log: console.log, debug: console.debug, info: console.info, warn: console.warn };
  console.log = console.debug = console.info = () => { chatter.log++; };
  console.warn = (...a) => { chatter.warn++; if (chatter.samples.length < 5) chatter.samples.push(a.map(String).join(" ").slice(0, 240)); };
  try { return await fn(); } finally { Object.assign(console, keep); }
};

// The verdicts are printed on the real console even while ACE's chatter is held.
const say = console.log.bind(console);
let pass = 0, fail = 0, skip = 0;
const check = (label, ok, detail) => {
  if (ok === null) { skip++; say("  skip " + String(label).padEnd(70) + detail); return; }
  ok ? pass++ : fail++;
  say((ok ? "  ok   " : "  FAIL ") + String(label).padEnd(70) + detail);
};

/* ── The books reader, on the same packs ────────────────────────────────── */
// The index is built from stand-ins for his packs, the way it is at his table's
// boot. A book entry is loaded the way dnd5e loads a compendium item, held by no
// creature, and every entry counts as in memory: a replayed press is read the
// way the cast reads it, after the book was brought in for that cast.
const BOOK_RAW = new Map();                  // uuid -> { raw, effects, pack }
const packStandIns = BOOK_PACKS.map(bp => {
  const effects = new Map();
  for (const [k, v] of bp.rows) {
    if (!k.startsWith("!items.effects!")) continue;
    const itemId = k.slice("!items.effects!".length).split(".")[0];
    if (!effects.has(itemId)) effects.set(itemId, []);
    effects.get(itemId).push(v);
  }
  const index = [];
  for (const [k, v] of bp.rows) {
    if (!k.startsWith("!items!")) continue;
    const uuid = `Compendium.${bp.collection}.Item.${v._id}`;
    BOOK_RAW.set(uuid, { raw: v, effects: effects.get(v._id) ?? [], pack: bp.collection });
    index.push({ _id: v._id, name: v.name, type: v.type, uuid, flags: v.flags ?? {},
      system: { source: v.system?.source ?? {} } });
  }
  return { documentName: "Item", collection: bp.collection, getIndex: async () => index,
    metadata: { packageType: bp.packageType, packageName: bp.packageName, label: bp.label, name: bp.pack.name } };
});
class BookDocs extends Map {
  has(uuid) { return super.has(uuid) || BOOK_RAW.has(uuid); }
  get(uuid) {
    if (!super.has(uuid) && BOOK_RAW.has(uuid)) {
      const { raw, effects, pack } = BOOK_RAW.get(uuid);
      super.set(uuid, loadItem(raw, { uuid, effectRows: effects, extra: { pack } }));
    }
    return super.get(uuid);
  }
}
{
  const keep = { packs: game.packs, modules: game.modules };
  const modules = new Map(BOOK_PACKS.filter(b => b.packageType === "module")
    .map(b => [b.packageName, { id: b.packageName, active: true, protected: !!b.protected }]));
  // Only while the index is built: nothing else in the replay has seen a pack or a module.
  game.packs = packStandIns;
  game.modules = { get: (id) => modules.get(id) ?? null };
  let status = null;
  try { await quiet(async () => { status = await RulesIndex.build(); }); }
  finally { Object.assign(game, keep); }
  RulesIndex._docs = new BookDocs();
  const byUuid = (u) => ITEMS.get(u) ?? (BOOK_RAW.has(u) ? RulesIndex._docs.get(u) : null);
  globalThis.fromUuid = async (u) => byUuid(u);
  globalThis.fromUuidSync = (u) => byUuid(u);
  const books = (status?.packs ?? []).filter(p => p.official).map(p => p.id);
  say(`\nTHE BOOKS: ${status?.packs?.length ?? 0} item packs indexed, ${status?.counts?.["2014"] ?? 0} names under 2014 `
    + `and ${status?.counts?.["2024"] ?? 0} under 2024. Books: ${books.join(", ") || "none"}; `
    + `his D&D Beyond imports of a named book count item by item`
    + `${status?.failed?.length ? `. ${status.failed.length} would not open: ${status.failed.map(f => f.id).join(", ")}` : ""}.`);
}

/* ── --show: what ACE decides for the items asked about ─────────────────── */
if (SHOW !== null) {
  const wants = SHOW.toLowerCase().split("|").map(s => s.trim()).filter(Boolean);
  let shown = 0;
  await quiet(async () => {
    for (const actor of ACTORS.values()) {
      for (const item of actor.items) {
        const who = `${actor.name} / ${item.name}`;
        if (!wants.some(w => who.toLowerCase().includes(w))) continue;
        shown++;
        say(`${who}  [${item.type}${item.system?.source?.rules ? `, ${item.system.source.rules}` : ""}]`);
        try {
          for (const [k, v] of Object.entries(recordFor(item))) {
            say(`  ${k}: ${Array.isArray(v) ? v.join("\n      ") : v}`);
          }
        } catch (err) { say(`  could not be read: ${err?.message ?? err}`); }
      }
    }
  });
  say(shown ? `\n${shown} shown` : `nothing in ${WORLD} matches "${SHOW}"`);
  process.exit(0);
}

/* ── --followups: every spell that lists a later step beside its cast ───── */
// A later step is an activity dnd5e marks as using no spell slot on a spell
// that also has one that does: Prismatic Wall's saves, Moonbeam's move.
if (argv.includes("--followups")) {
  const table = new Map();
  await quiet(async () => {
    for (const actor of ACTORS.values()) {
      for (const item of actor.items) {
        if (item.type !== "spell" || !(Number(item.system?.level) > 0)) continue;
        const acts = readActivities(item).filter(a => !passive(a));
        const casts = acts.filter(a => a?.consumption?.spellSlot !== false);
        const later = acts.filter(a => a?.consumption?.spellSlot === false);
        if (!casts.length || !later.length) continue;
        const key = `${item.name} [${item.system?.source?.rules ?? "?"}]`;
        const d = item.system?.duration ?? {};
        const bits = [
          `lasts ${d.value ?? ""} ${d.units || "?"}`.replace(/\s+/g, " "),
          item.system?.properties?.has?.("concentration") ? "concentration" : "",
          acts.some(a => a.target?.template?.type) ? "area" : "",
          (item.effects?.contents ?? []).filter(e => !e.transfer).length ? "effects" : "",
          acts.some(a => a.type === "summon") ? "summons" : "",
          SpellPipeline.owns(item) ? (SpellPipeline.resolvesItself(item) ? "ACE resolves it" : "ACE hands it off") : "ACE does not own it",
          `casts: ${casts.map(label).join(", ")}`,
          `later: ${later.map(a => `${label(a)} (${a.type}, ${a.activation?.type || "no activation"})`).join("; ")}`,
        ].filter(Boolean);
        if (!table.has(key)) table.set(key, new Set());
        table.get(key).add(bits.join(" | "));
      }
    }
  });
  for (const [k, s] of [...table.entries()].sort()) say(`${k}\n  ${[...s].join("\n  ")}`);
  say(`\n${table.size} spells list a later step beside their cast`);
  process.exit(0);
}

/* ── PINNED ─────────────────────────────────────────────────────────────── */
// ⚠️🔴 TWO LISTS, KEPT APART ON PURPOSE. "Seen at the table" is his word that
// it worked, with the date he said it. "Fixed, not yet seen" is only my word.
// The first version of this file put this week's fixes under "things he has
// seen work", and I repeated that to him; he had seen none of them. A fix is
// not a confirmation. (His confirmations were gathered on 2026-09-12 from the
// memory folder, 60 session summaries and his own messages since 30 April.)
const findOn = (actorName, itemName, type = null) => [...ACTORS.values()]
  .filter(a => a.name === actorName && (!type || a.type === type))
  .map(a => a.items.find(i => i.name === itemName)).find(Boolean) ?? null;
const pin = (label, [actorName, itemName, type = null], test) => {
  const item = findOn(actorName, itemName, type);
  if (!item) return check(label, null, `(${actorName} has no "${itemName}" in this world)`);
  try { const [ok, detail] = test(item); check(label, ok, detail); }
  catch (err) { check(label, false, `threw: ${err?.message ?? err}`); }
};
const shapeOf = (it) => SpellPipeline._getEntry(it)?.shape ?? "no entry";
const failNames = (it) => readActivities(it).filter(a => a.type === "save")
  .flatMap(a => readSaveOutcome(it, { activityId: a.id }).fail.map(r => r.name));
const firstSaveOutcome = (it) => {
  const sv = readActivities(it).find(a => a.type === "save");
  return sv ? readSaveOutcome(it, { activityId: sv.id }) : null;
};
const castsItself = (it) => [press(it).startsWith("uses ") && SpellPipeline.resolvesItself(it),
  `${press(it)}; ${shapeOf(it)}`];
const toSaveEngine = (it) => [SpellPipeline.owns(it) && !SpellPipeline.resolvesItself(it),
  `${shapeOf(it)}; ${press(it)}`];

// The spell pipeline's own verdict on dnd5e's damage roll: false means it
// refuses the roll. Refusing a Fireball's roll is what lost its upcast dice.
let preDamage = [];
await quiet(async () => {
  const before = (hooks["dnd5e.preRollDamageV2"] ?? []).length;
  SpellPipeline.initialize();
  preDamage = (hooks["dnd5e.preRollDamageV2"] ?? []).slice(before);
});
const refusesDnd5eDamage = (item) => preDamage.some(h => {
  try { return h({ subject: { item } }) === false; } catch (_) { return false; }
});
const VAREK = "Varek Thalor (CR 30)";

console.log(`\nPINNED, SEEN AT THE TABLE (his word, and the date he said it)`);
await quiet(async () => {
  pin("Magic Missile casts without asking, ACE throws the darts (06-07, 08-25)",
    ["Kasimir Velikov", "Magic Missile", "character"], castsItself);
  pin("the Lich's Magic Missile, the same (09-01)", ["Lich (Legacy)", "Magic Missile"], castsItself);
  pin("the Flameskull's Magic Missile, the same (08-26)", ["Flameskull", "Magic Missile"], castsItself);
  pin("Eldritch Blast: ACE rolls every beam itself (08-26, 08-27)", ["Lich (Legacy)", "Eldritch Blast"],
    (it) => [SpellPipeline.ownsAttackRoll(it), shapeOf(it)]);
  pin("Fireball goes to the save engine (05-05 to 08-27; Kasimir's copy)",
    ["Kasimir Velikov", "Fireball", "character"], toSaveEngine);
  pin("Cone of Cold goes to the save engine (05-05; Kasimir's copy)",
    ["Kasimir Velikov", "Cone of Cold", "character"], toSaveEngine);
  pin("Ghostly Howl: ACE resolves King's Wisdom save (07-11 to 09-06)", ["King", "Ghostly Howl"],
    (it) => { const sv = readActivities(it).find(a => a.type === "save");
      return [shapeOf(it) === "save-area" && SpellPipeline.resolvesItself(it) && !!sv?.save?.ability?.has("wis"),
        `${shapeOf(it)}; ${[...(sv?.save?.ability ?? [])].join("/")} save`]; });
  pin("Frostbite: a failed save leaves the target Frostbitten (06-30, 07-11)", ["Chudd Buckland", "Frostbite"],
    (it) => { const f = failNames(it); return [f.some(n => /frostbit/i.test(n)), f.join(", ") || "nothing on a failure"]; });
  pin("Moonbeam stays on the map and keeps working (05-05, 08-27; Chudd's copy)", ["Chudd Buckland", "Moonbeam"],
    (it) => [shapeOf(it) === "template-trigger", shapeOf(it)]);
  pin("Aura of Vitality: ACE's own aura heal (09-05)", ["Firaxis Greenbeard", "Aura of Vitality (Legacy)"],
    (it) => [shapeOf(it) === "emanation-heal" && SpellPipeline.resolvesItself(it), shapeOf(it)]);
  pin("Healing Light: ACE's own heal, no dnd5e dialog (07-11)", ["Syrax Razeson", "Healing Light"],
    (it) => [SpellPipeline.resolvesItself(it), `${shapeOf(it)}; ${press(it)}`]);
  pin("the Holy Symbol of Ravenkind offers its three powers (06-10, 06-11)", ["Syrax Razeson", "Holy Symbol of Ravenkind"],
    (it) => { const p = press(it); return [/Hold Vampires/.test(p) && /Sunlight/.test(p) && /Turn Undead/.test(p), p]; });
  pin("and a failed Hold Vampires save paralyzes (06-10)", ["Syrax Razeson", "Holy Symbol of Ravenkind"],
    (it) => { const f = failNames(it); return [f.some(n => /paraly/i.test(n)), f.join(", ") || "nothing on a failure"]; });
  pin("Jeth's Spiked Chain asks the DC 14 Dexterity save after a hit (03-23)", ["Jeth", "Spiked Chain"],
    (it) => { const s = PostHitSaves.riderSavesFor(it, it.actor, { quiet: true }).saves;
      return [s.some(x => x.ability === "dex" && x.dc === 14), s.map(x => `${x.ability} ${x.dc} ${x.hitVerdict ?? ""}`).join(", ") || "none"]; });
});

console.log(`\nPINNED, FIXED BUT NOT YET SEEN AT THE TABLE`);
await quiet(async () => {
  pin("Neferon's Claws attacks when pressed, no Attack or Save question (09-12)", ["Neferon", "Claws"],
    (it) => { const p = press(it); return [p === "uses attack", p]; });
  pin("Neferon's Claws: its hit asks the Con save with 3d6 poison in it (09-12)", ["Neferon", "Claws"],
    (it) => { const s = PostHitSaves.riderSavesFor(it, it.actor, { quiet: true }).saves;
      const txt = s.map(x => `${x.ability} ${x.dc} ${x.failEffect.map(e => `${e.formula} ${e.damageType}`).join(",")} half=${x.halfOnSuccess}`).join("; ");
      return [s.length === 1 && s[0].ability === "con" && s[0].failEffect[0]?.damageType === "poison" && s[0].halfOnSuccess, txt]; });
  pin("the Forge Devil's slug asks none of its menu's other saves (09-12)", ["Forge Devil", "Master of Metal"],
    (it) => { const s = PostHitSaves.riderSavesFor(it, it.actor, { quiet: true }).saves;
      return [s.length === 0, s.map(x => `${x.ability} ${x.hitVerdict}`).join(", ") || "none asked"]; });
  for (const spell of ["Fireball", "Lightning Bolt", "Cone of Cold", "Wall of Fire"]) {
    pin(`${spell}: dnd5e rolls the damage, so upcast dice count (09-11)`, [VAREK, spell],
      (it) => [!refusesDnd5eDamage(it), refusesDnd5eDamage(it) ? "the pipeline refuses dnd5e's roll" : "left to dnd5e"]);
  }
  pin("Magic Missile's stray dnd5e damage roll is still refused (09-11)", ["Kasimir Velikov", "Magic Missile", "character"],
    (it) => [refusesDnd5eDamage(it), refusesDnd5eDamage(it) ? "refused" : "dnd5e would roll a stray d4"]);
  pin("Prismatic Wall with no wall up offers only its two casts (09-13)", [VAREK, "Prismatic Wall"],
    (it) => { const p = press(it); return [p === "asks: Create Wall | Create Globe", p]; });
  pin("with the wall up: its two saves first, casting again underneath (09-13)", [VAREK, "Prismatic Wall"],
    (it) => { const d = choose(it, true);
      const rows = (d.choices ?? []).map(a => `${d.recastIds?.has(a.id) ? "again: " : ""}${label(a)}`).join(" | ");
      return [d.kind === "ask" && rows === "Blinding Save | Traversal Save | again: Create Wall | again: Create Globe", rows || d.kind]; });
  pin("Prismatic Wall: ACE reads its seven layers from Varek's copy (09-13)", [VAREK, "Prismatic Wall"],
    (it) => { const w = readPrismaticWall(it);
      const dmg = w.layers.filter(l => l.kind === "damage").map(l => `${l.formula} ${l.type}`).join(", ");
      return [w.dc === 22 && w.bandFt === 20 && w.blindSeconds === 60
        && dmg === "12d6 fire, 12d6 acid, 12d6 lightning, 12d6 poison, 12d6 cold"
        && w.layers.slice(5).map(l => l.kind).join(",") === "restrained,blinded",
        `DC ${w.dc}; ${dmg}; then ${w.layers.slice(5).map(l => l.kind).join(", ")}; ${w.bandFt} feet; blind ${w.blindSeconds}s`]; });
  pin("and from the Lich's copy, whose table is only embedded (09-13)", ["Lich (Legacy)", "Prismatic Wall"],
    (it) => { const w = readPrismaticWall(it);
      const dmg = w.layers.filter(l => l.kind === "damage").map(l => `${l.formula} ${l.type}`).join(", ");
      return [dmg === "12d6 fire, 12d6 acid, 12d6 lightning, 12d6 poison, 12d6 cold", dmg]; });
  pin("Prismatic Wall: a condition it left on a creature does not make it up (09-13)", [VAREK, "Prismatic Wall"],
    (it) => { const left = { tokens: [{ effects: [{ origin: it.uuid, name: "Restrained (Prismatic Wall, indigo)" }] }] };
      const noWall = spellIsUp(it, left);
      const withWall = spellIsUp(it, { ...left, templates: [{ flags: { dnd5e: { item: it.uuid } } }] });
      return [!noWall && withWall, `no wall, Neferon Restrained: ${noWall ? "up" : "not up"}; wall on the map: ${withWall ? "up" : "not up"}`]; });
  // Later steps on spells nobody named an owner for: the first copy in his
  // world that carries the step is the one checked.
  const withStep = (itemName, step) => [...ACTORS.values()].flatMap(a => [...a.items])
    .find(i => i.name === itemName && readActivities(i).some(x => step.test(x.name ?? ""))) ?? null;
  const pinStep = (label, itemName, step, test) => {
    const item = withStep(itemName, step);
    if (!item) return check(label, null, `(no "${itemName}" with that step in this world)`);
    try { const [ok, detail] = test(item); check(label, ok, detail); }
    catch (err) { check(label, false, `threw: ${err?.message ?? err}`); }
  };
  const rowsWhileUp = (it) => { const d = choose(it, true); return [d, (d.choices ?? []).map(label)]; };
  pinStep("Moonbeam while it is up: pressing it offers the move (09-13)", "Moonbeam", /move/i,
    (it) => { const [d, rows] = rowsWhileUp(it); return [d.kind === "ask" && rows.some(r => /move/i.test(r)), rows.join(" | ") || d.kind]; });
  pinStep("Heat Metal while it is up: reheating, not a second cast (09-13)", "Heat Metal", /reheat|bonus action damage/i,
    (it) => { const [d, rows] = rowsWhileUp(it); return [d.kind === "ask" && rows.some(r => /reheat|bonus action damage/i.test(r)), rows.join(" | ") || d.kind]; });
  pinStep("Finger of Death's zombie stays on the list: nothing to see it by (09-13)", "Finger of Death", /zombie/i,
    (it) => { const p = press(it); return [/Raise Zombie/.test(p), p]; });
  pinStep("Freezing Sphere's held globe stays on the list: it is instant (09-13)", "Freezing Sphere", /held globe/i,
    (it) => { const p = press(it); return [/Throw Held Globe/.test(p), p]; });
  pin("Prismatic Spray: a failure is one colour, not all of them (09-11)", [VAREK, "Prismatic Spray"],
    (it) => { const o = firstSaveOutcome(it);
      return [!!o?.alternatives, o ? `one of several: ${o.alternatives}; lands on everyone: ${o.shared.join(", ") || "nothing"}` : "no save"]; });
  pin("Divine Word: one result by hit points, never dead for all (09-11)", [VAREK, "Divine Word"],
    (it) => { const o = firstSaveOutcome(it);
      return [!!o?.alternatives && !o.shared.includes("dead"), o ? `one of several: ${o.alternatives}; shared: ${o.shared.join(", ") || "nothing"}` : "no save"]; });
  pin("Ray of Enfeeblement: a failed save puts its own effect on (09-11)", [VAREK, "Ray of Enfeeblement"],
    (it) => { const f = failNames(it); return [f.length > 0, f.join(", ") || "no effect of its own on a failure"]; });
});

// ⚠️ THROUGH THE DAMAGE CARD'S OWN DOOR, not just its reader: the claw lands
// on a Specter and on a creature that is not immune, and what gets posted is
// what is checked.
{
  const claws = findOn("Neferon", "Claws");
  const specter = [...ACTORS.values()].find(a => a.name === "Specter") ?? null;
  const plain = [...ACTORS.values()].find(a => a.type === "npc" && /^goblin$/i.test(a.name))
    ?? [...ACTORS.values()].find(a => a.type === "npc"
      && !(a.system?.traits?.di?.value ?? []).includes("poison") && a.system?.abilities?.con);
  const hitOn = (actor) => [{ hitResult: "hit", actorId: actor.id, tokenDocId: `tok-${actor.id}`,
    name: actor.name, img: "", targetActor: { id: actor.id } }];
  if (!claws || !specter || !plain) {
    check("Neferon's Claws through the damage card", null, "(Neferon, a Specter or a plain creature is missing)");
  } else {
    await quiet(async () => {
      posted.length = 0;
      await PostHitSaves.checkPostHitEffects(claws, claws.actor, hitOn(specter), []);
      const note = posted.find(m => /save skipped/i.test(m?.content ?? ""));
      const card = posted.find(m => m?.flags?.["ace-qol"]?.type === "postHitSave");
      check("a Specter hit by the claw is not asked a pointless save (09-12)", !card && !!note,
        note ? "the GM is told: immune to poison" : (card ? "a save card was posted anyway" : "nothing was posted at all"));
      check("and the note names the Specter and why (09-12)", /Specter<\/strong> is immune to poison/.test(note?.content ?? ""),
        (note?.content ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 120));

      posted.length = 0;
      await PostHitSaves.checkPostHitEffects(claws, claws.actor, hitOn(plain), []);
      const card2 = posted.find(m => m?.flags?.["ace-qol"]?.type === "postHitSave");
      const fx = card2?.flags?.["ace-qol"]?.save;
      check(`the same claw on a ${plain.name} asks for the save (09-12)`, !!card2, card2 ? "save card posted" : "no save card");
      check("and the card carries the poison (09-12)", fx?.failEffect?.[0]?.formula === "3d6" && fx?.failEffect?.[0]?.damageType === "poison",
        JSON.stringify(fx?.failEffect ?? null));
      if (card2) {
        posted.length = 0;
        const rolled = await Promise.race([
          PostHitSaves.rollPostHitSaves({ flags: card2.flags }).then(() => "done"),
          new Promise(r => setTimeout(() => r("timeout"), 8000))]);
        const result = posted.find(m => m?.flags?.["ace-qol"]?.type === "postHitSaveResult");
        const dmg = result?.flags?.["ace-qol"]?.damageResults?.[0]?.totalFinal ?? null;
        check("a failed save rolls the poison and offers to apply it (09-12)",
          rolled === "done" && /poison/.test(result?.content ?? "") && dmg === 3,
          rolled === "timeout" ? "the roll never finished" : `poison on the card: ${/poison/.test(result?.content ?? "")}, damage ${dmg} (every die a 1)`);
        // ⚠️ APPLY adds up the parts. A card carrying only its total applied
        // nothing and said APPLIED (found 2026-09-13).
        const entry = result?.flags?.["ace-qol"]?.damageResults?.[0];
        const parts = (entry?.components ?? []).reduce((s, c) => s + (Number(c.final) || 0), 0);
        check("and APPLY on that card has the parts to apply, not only the sum (09-13)",
          !!entry && parts > 0 && parts === entry.totalFinal,
          entry ? `${(entry.components ?? []).length} part(s) adding to ${parts}; the card's total ${entry.totalFinal}` : "no damage on the card");
      }
    });
  }
}

// ⚠️ PRISMATIC WALL THROUGH ITS OWN DOORS. A creature walking up to Varek's
// wall, through it and around it, on a stand-in scene; the indigo layer's score
// over the creature's turns; the violet layer's save when Varek's turn comes
// round; and the layers' own card. What the engine decides, and what it posts,
// is what is checked.
{
  // The whole card as words. (Cut short, the violet card's last clause fell off
  // the end and the check read a failure that was not there.)
  const text = (m) => String(m?.content ?? "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
  const wallItem = findOn(VAREK, "Prismatic Wall");
  const walkerActor = [...ACTORS.values()].find(a => a.type === "npc" && /^goblin$/i.test(a.name))
    ?? [...ACTORS.values()].find(a => a.type === "npc" && Number(a.system?.attributes?.hp?.value) > 0);
  if (!wallItem || !walkerActor) {
    check("Prismatic Wall through its own doors", null, "(Varek's wall or a plain creature is missing)");
  } else {
    // Varek's wall: 90 feet running east along y = 0, as dnd5e places a wall.
    const scene = { id: "scPW", grid: { size: 100, distance: 5 }, templates: new Collection(), tokens: new Collection() };
    const tdoc = { id: "tplPW", t: "ray", x: 0, y: 0, distance: 90, direction: 0, elevation: 0, parent: scene,
      _stats: { createdTime: 1 },
      flags: { dnd5e: { item: wallItem.uuid, dimensions: { height: 30 } },
        "ace-qol": { prismaticWall: { designated: true, casterTokenId: "tokVarek", exemptTokenIds: ["tokAlly"], exemptActorIds: [] } } } };
    scene.templates.set(tdoc.id, tdoc);
    const tokenOf = (id, actor) => ({ id, name: actor.name, actor, actorId: actor.id, actorLink: false,
      x: 0, y: 0, width: 1, height: 1, elevation: 0, parent: scene, texture: {} });
    const walker = tokenOf("tokGob", walkerActor);
    const ally = tokenOf("tokAlly", walkerActor);
    const varekTok = tokenOf("tokVarek", wallItem.actor);
    scene.tokens.set(walker.id, walker);

    const calls = [];
    const keep = { light: PrismaticWallEngine.resolveLight, layers: PrismaticWallEngine.resolveLayers,
      save: PrismaticWallEngine._rollSave, sight: CONFIG.Canvas.polygonBackends.sight,
      roll: RepeatingSaveEngine._obtainReSaveRoll };
    CONFIG.Canvas.polygonBackends.sight = { testCollision: () => false };   // nothing hides the wall
    let n = 0;
    const walk = async (tok, pts, extra = {}) => {
      calls.length = 0;
      await PrismaticWallEngine._onMove(tok, { id: `mv${++n}`, origin: pts[0], passed: { waypoints: pts.slice(1) }, ...extra }, {});
      return calls.join(", ") || "nothing";
    };
    await quiet(async () => {
      PrismaticWallEngine.resolveLight = async (_w, t, how) => { calls.push(`light ${t.id} ${how}`); };
      PrismaticWallEngine.resolveLayers = async (_w, t) => { calls.push(`layers ${t.id}`); };
      let got = await walk(walker, [{ x: 900, y: -1200 }, { x: 900, y: -500 }]);
      check("walking up to 20 feet of Varek's wall asks for the light's save (09-13)", got === "light tokGob moves", got);
      got = await walk(walker, [{ x: 900, y: -1200 }, { x: 900, y: -600 }]);
      check("stopping 25 feet away asks nothing (09-13)", got === "nothing", got);
      got = await walk(walker, [{ x: 900, y: -1200 }, { x: 900, y: 300 }]);
      check("walking through: the light, then the seven layers (09-13)", got === "light tokGob moves, layers tokGob", got);
      got = await walk(walker, [{ x: 900, y: -1200 }, { x: 2100, y: -1200 }, { x: 2100, y: 300 }]);
      check("around the far end: the light, and no layers (09-13)", got === "light tokGob moves", got);
      got = await walk(ally, [{ x: 900, y: -1200 }, { x: 900, y: 300 }]);
      check("a creature Varek named walks through untouched (09-13)", got === "nothing", got);
      got = await walk(varekTok, [{ x: 900, y: -1200 }, { x: 900, y: 300 }]);
      check("and so does Varek himself (09-13)", got === "nothing", got);
      got = await walk(walker, [{ x: 900, y: -1200 }, { x: 900, y: 300 }], { method: "undo" });
      check("undoing a move asks nothing (09-13)", got === "nothing", got);
      walkerActor.statuses.add("blinded");
      got = await walk(walker, [{ x: 900, y: -1200 }, { x: 900, y: 300 }]);
      walkerActor.statuses.delete("blinded");
      check("a blinded creature: no light, but still the layers (09-13)", got === "layers tokGob", got);
      Object.assign(PrismaticWallEngine, { resolveLight: keep.light, resolveLayers: keep.layers });
    });

    // The conditions it leaves, through the repeating-save engine.
    const made = [];
    walkerActor.createEmbeddedDocuments = async (_t, data) => { made.push(...data); return data; };
    const setPath = (obj, path, v) => { const ks = path.split("."); let o = obj;
      for (const k of ks.slice(0, -1)) o = (o[k] ??= {}); o[ks.at(-1)] = v; };
    const effect = (id, name, status, meta) => {
      const eff = { id, name, statuses: new Set([status]), origin: null, disabled: false,
        flags: { "ace-qol": { repeatingSave: meta } },
        update: async (u) => { for (const [k, v] of Object.entries(u)) setPath(eff, k, v); return eff; },
        delete: async () => { walkerActor.effects.delete(id); return eff; } };
      walkerActor.effects.set(id, eff);
      return eff;
    };
    const rolls = [];
    RepeatingSaveEngine._obtainReSaveRoll = async () => {
      const total = rolls.shift() ?? 1;
      return { total, natural: Math.max(1, Math.min(20, total - 2)) };
    };
    await quiet(async () => {
      const indigo = effect("effIndigo", "Restrained (Prismatic Wall, indigo)", "restrained",
        { ability: "con", dc: 22, trigger: "endOfTurn", spellName: "Prismatic Wall (indigo layer)",
          tally: { need: 3, successes: 0, failures: 0 }, onFailureApply: "petrified" });
      const score = () => { const t = walkerActor.effects.get("effIndigo")?.flags?.["ace-qol"]?.repeatingSave?.tally;
        return t ? `${t.successes} up, ${t.failures} down` : "gone"; };
      posted.length = 0;
      rolls.push(5);
      await RepeatingSaveEngine._rollAndResolve(walkerActor, indigo, "combatTurn");
      check("indigo: a failed save is counted, not the end (09-13)",
        score() === "0 up, 1 down" && /1 failure so far/.test(text(posted.at(-1))), `${score()}; the card: ${text(posted.at(-1))}`);
      rolls.push(25);
      await RepeatingSaveEngine._rollAndResolve(walkerActor, indigo, "combatTurn");
      check("indigo: a success is counted as well (09-13)", score() === "1 up, 1 down", score());
      rolls.push(5, 5);
      await RepeatingSaveEngine._rollAndResolve(walkerActor, indigo, "combatTurn");
      await RepeatingSaveEngine._rollAndResolve(walkerActor, indigo, "combatTurn");
      const stone = made.some(e => [...(e.statuses ?? [])].includes("petrified"));
      check("indigo: the third failure turns it to stone (09-13)", score() === "gone" && stone,
        `${score()}; Petrified put on: ${stone}; the card: ${text(posted.at(-1))}`);

      const varek = wallItem.actor;
      effect("effViolet", "Blinded (Prismatic Wall, violet)", "blinded",
        { ability: "wis", dc: 22, trigger: "startOfCasterTurn", casterActorId: varek.id, casterTokenId: null,
          casterName: varek.name, once: true, spellName: "Prismatic Wall (violet layer)",
          onFailureNote: "it is sent to another plane of existence of the GM's choosing. ACE has not moved the token." });
      const combat = { started: true, scene,
        combatants: new Collection([["cWalker", { actor: walkerActor, tokenId: "tokGob" }],
                                    ["cVarek", { actor: varek, tokenId: "tokVarek" }]]) };
      posted.length = 0;
      rolls.push(5);
      await RepeatingSaveEngine._processCasterTurnStart(combat, { combatantId: "cWalker" });
      check("violet: nothing at the start of the creature's own turn (09-13)",
        !!walkerActor.effects.get("effViolet") && !posted.length, walkerActor.effects.get("effViolet") ? "still Blinded, no card" : "ended early");
      await RepeatingSaveEngine._processCasterTurnStart(combat, { combatantId: "cVarek" });
      check("violet: at the start of Varek's turn one save, and a failure sends it away (09-13)",
        !walkerActor.effects.get("effViolet") && /another plane/.test(text(posted.at(-1))), text(posted.at(-1)) || "no card");

      // The layers' own card, with every save failed and every die a 1.
      posted.length = 0;
      made.length = 0;
      PrismaticWallEngine._rollSave = async () => ({ total: 3, natural: 1, passed: false,
        advReasons: [], disReasons: [], superSaver: false });
      const wall = PrismaticWallEngine._wallsOn(scene)[0];
      await PrismaticWallEngine.resolveLayers(wall, walker);
      const card = posted.find(m => m?.flags?.["ace-qol"]?.type === "prismaticTraversal");
      const entry = card?.flags?.["ace-qol"]?.damageResults?.[0];
      const parts = (entry?.components ?? []).map(c => `${c.final} ${c.type}`).join(", ");
      check("through the wall: one card, five layers of damage APPLY can use (09-13)",
        !!entry && entry.components.length === 5 && entry.components.every(c => c.final === 12) && entry.totalFinal === 60,
        parts ? `${parts}; total ${entry.totalFinal}` : "no damage on the card");
      const put = made.map(e => `${e.name}: ${e.flags?.["ace-qol"]?.repeatingSave?.trigger}`).join("; ");
      check("and its indigo and violet layers put their conditions on, each with its own save (09-13)",
        /Restrained \(Prismatic Wall, indigo\): endOfTurn/.test(put) && /Blinded \(Prismatic Wall, violet\): startOfCasterTurn/.test(put),
        put || "nothing put on");

      // A save the gate never let roll is not a failed save: nothing lands.
      posted.length = 0;
      made.length = 0;
      PrismaticWallEngine._rollSave = async () => ({ total: null, natural: null, passed: false, noRoll: true,
        why: "a stand-in reason", advReasons: [], disReasons: [], superSaver: false });
      await PrismaticWallEngine.resolveLayers(wall, walker);
      const unrolled = posted.find(m => m?.flags?.["ace-qol"]?.type === "prismaticTraversal");
      check("a save that was never rolled lands nothing: no damage, no conditions (09-13)",
        !!unrolled && !unrolled.flags["ace-qol"].damageResults && made.length === 0 && /NO ROLL/.test(unrolled.content ?? ""),
        unrolled ? `damage on the card: ${!!unrolled.flags["ace-qol"].damageResults}; conditions put on: ${made.length}` : "no card");

      // The light, through its real door: a failed save, and a minute of blindness.
      posted.length = 0;
      made.length = 0;
      PrismaticWallEngine._rollSave = async () => ({ total: 4, natural: 2, passed: false,
        advReasons: [], disReasons: [], superSaver: false });
      await PrismaticWallEngine.resolveLight(wall, walker, "moves");
      const light = posted.find(m => m?.flags?.["ace-qol"]?.type === "prismaticLight");
      const blind = made.find(e => [...(e.statuses ?? [])].includes("blinded"));
      check("the light: a failed save, Blinded for a minute, and its card says so (09-13)",
        !!light && blind?.duration?.seconds === 60 && /Blinded for 1 minute/.test(text(light)),
        light ? `${text(light).slice(0, 140)}; the blindness lasts ${blind?.duration?.seconds ?? "?"}s` : "no card");

      // ⚠️ ONE LAYER AT A TIME, AND NOTHING LANDS BEFORE ITS DICE (his rule, and
      // his screenshot of 2026-09-13: indigo's Restrained and violet's Blinded on
      // Neferon with the whole wall's dice still in the air). Here the dice take a
      // few milliseconds to land, and every save rolled and every condition put on
      // notes how many dice were still rolling at that moment. All must say none.
      const { safeShowForRoll } = await import(`${MODULE}/scripts/dsn-utils.mjs`);
      const keepDice = game.dice3d, keepMake = walkerActor.createEmbeddedDocuments;
      const dice = { thrown: 0, landed: 0 };
      const rolling = () => dice.thrown - dice.landed;
      const steps = [];
      game.dice3d = {
        isEnabled: () => true,
        showForRoll: () => { dice.thrown++; return new Promise(r => setTimeout(() => { dice.landed++; r(true); }, 15)); },
      };
      walkerActor.createEmbeddedDocuments = async (_t, data) => {
        for (const d of data) steps.push(`${d.name} went on with ${rolling()} dice rolling`);
        made.push(...data);
        return data;
      };
      PrismaticWallEngine._rollSave = async (_w, _t, _a, _dc, label) => {
        steps.push(`${label} was rolled with ${rolling()} dice rolling`);
        safeShowForRoll({ total: 3 }, "the save's own d20");
        return { total: 3, natural: 1, passed: false, advReasons: [], disReasons: [], superSaver: false };
      };
      posted.length = 0;
      made.length = 0;
      await PrismaticWallEngine.resolveLayers(wall, walker);
      const early = steps.filter(s => !/ 0 dice rolling$/.test(s));
      check("through the wall: one layer at a time, and no condition goes on while its dice roll (09-13)",
        steps.length === 9 && !early.length && rolling() === 0,
        early.length ? early.join("; ") : `${steps.length} steps (want 9: seven saves, two conditions)`);
      steps.length = 0;
      await PrismaticWallEngine.resolveLight(wall, walker, "moves");
      const earlyLight = steps.filter(s => !/ 0 dice rolling$/.test(s));
      check("the light: its Blinded goes on only after the save die lands (09-13)",
        steps.length === 2 && !earlyLight.length, steps.join("; ") || "nothing happened");
      game.dice3d = keepDice;
      walkerActor.createEmbeddedDocuments = keepMake;
    });
    Object.assign(PrismaticWallEngine, { _rollSave: keep.save });
    RepeatingSaveEngine._obtainReSaveRoll = keep.roll;
    CONFIG.Canvas.polygonBackends.sight = keep.sight;
    delete walkerActor.createEmbeddedDocuments;
    for (const id of ["effIndigo", "effViolet"]) walkerActor.effects.delete(id);
  }
}

// ⚠️ THE RULE HE ASKED FOR, 2026-09-13: "yes, enforce it". A wall placed
// through a creature's space ends at once, and the caster is not asked who is
// spared; one run along the line between two squares stands in neither.
{
  const wallItem = findOn(VAREK, "Prismatic Wall");
  const standing = [...ACTORS.values()].find(a => a.type === "npc" && /^goblin$/i.test(a.name))
    ?? [...ACTORS.values()].find(a => a.type === "npc" && Number(a.system?.attributes?.hp?.value) > 0);
  if (!wallItem || !standing) {
    check("a wall placed through a creature's space ends (09-13)", null, "(Varek's wall or a plain creature is missing)");
  } else {
    const words = (m) => String(m?.content ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    const scene = { id: "scPW3", grid: { size: 100, distance: 5 }, templates: new Collection(), tokens: new Collection() };
    scene.tokens.set("tokStand", { id: "tokStand", name: standing.name, actor: standing, actorId: standing.id,
      actorLink: false, x: 500, y: 0, width: 1, height: 1, elevation: 0, hidden: false, parent: scene, flags: {} });
    const wallAt = (id, y) => ({ id, t: "ray", x: 0, y, distance: 90, direction: 0, elevation: 0, parent: scene,
      flags: { dnd5e: { item: wallItem.uuid, dimensions: { height: 30 } } }, deleted: false,
      async delete() { this.deleted = true; return this; } });
    const keepDesignate = PrismaticWallEngine.designate;
    let asked = 0;
    await quiet(async () => {
      PrismaticWallEngine.designate = async () => { asked++; return null; };
      posted.length = 0;
      const through = wallAt("tplThrough", 50);     // down the middle of the goblin's row
      await PrismaticWallEngine._onTemplateCreated(through, game.user.id);
      check("a wall placed through a creature's space ends at once, and nobody is asked who is spared (09-13)",
        through.deleted && asked === 0 && /ends at once without effect/.test(words(posted.at(-1))),
        `removed: ${through.deleted}; asked: ${asked}; the card: ${words(posted.at(-1)).slice(0, 150) || "none"}`);
      const beside = wallAt("tplBeside", 100);      // along the line between two rows
      await PrismaticWallEngine._onTemplateCreated(beside, game.user.id);
      check("a wall along the line between two squares stands in neither, and the caster is asked (09-13)",
        !beside.deleted && asked === 1, `removed: ${beside.deleted}; asked: ${asked}`);
    });
    PrismaticWallEngine.designate = keepDesignate;
  }
}

/* ── GOLDEN: every item in his world, against the last accepted run ─────── */
function partLabel(p) {
  const n = Number(p?.number ?? 0), d = Number(p?.denomination ?? 0);
  const dice = (n && d) ? `${n}d${d}${p?.bonus ? `+${p.bonus}` : ""}` : (p?.custom?.formula || "");
  const types = [...(p?.types ?? [])].join("/");
  return [dice, types].filter(Boolean).join(" ") || "?";
}
function recordFor(item) {
  const r = {};
  const acts = readActivities(item);
  r.press = press(item);
  if (item.type === "spell" || item.type === "feat") {
    const e = SpellPipeline._getEntry(item);
    if (e) r.pipeline = `${e.shape ?? "no shape"}${e.corrected ? " (corrected)" : e.inferred ? " (worked out)" : ""}; `
      + (SpellPipeline.owns(item) ? (SpellPipeline.resolvesItself(item) ? "resolves it itself" : "hands it off") : "not owned");
  }
  const saves = acts.filter(a => a.type === "save");
  if (saves.length) {
    r.saves = saves.map(a => {
      const abil = [...(a.save?.ability ?? [])].join("/") || "?";
      const dc = a.save?.dc?.calculation
        ? `${a.save.dc.calculation}${a.save.dc.formula ? ` (${a.save.dc.formula})` : ""}` : (a.save?.dc?.formula || "?");
      const dmg = (a.damage?.parts ?? []).map(partLabel).join(" + ");
      let out;
      try {
        const o = readSaveOutcome(item, { activityId: a.id });
        const f = o.fail.map(x => x.name).join(", "), s = o.success.map(x => x.name).join(", ");
        out = `${f ? `fail: ${f}` : "fail: nothing of its own"}${o.alternatives ? " (one of these)" : ""}${s ? `; success: ${s}` : ""}`;
      } catch (err) { out = `outcome unreadable: ${err?.message ?? err}`; }
      return `${label(a)}: ${abil} DC ${dc}; ${dmg || "no damage"}`
        + `${a.damage?.onSave ? ` (${a.damage.onSave} on a save)` : ""}; ${out}`;
    });
  }
  if (acts.some(a => a.type === "attack")) {
    const hs = PostHitSaves.riderSavesFor(item, item.actor, { quiet: true }).saves;
    if (hs.length) r.afterHit = hs.map(s => `${s.ability} DC ${s.dc} (${s.hitVerdict ?? "rules entry"})`
      + `${(s.failEffect ?? []).length ? `: ${s.failEffect.map(e => e.type === "damage" ? `${e.formula} ${e.damageType}` : e.condition).join(", ")}` : ""}`
      + `${s.halfOnSuccess ? ", half on a save" : ""}`);
  }
  const conds = readAppliedConditions(item);
  if (conds.length) r.conditions = conds.map(c => `${c.condition}${c.requiresSave ? "" : " (even on a save)"}`).join(", ");
  if (item.type === "spell" && acts.some(a => a.target?.template?.type)) {
    const w = SaveEngine._areaWhoRule(item);
    r.area = `${w?.kind ?? "?"}${w?.count ? ` ${w.count}` : ""}`;
  }
  const floor = aceStripEnrichers(item.system?.description?.value ?? "");
  if (/\[\[|\]\]|Reference\[|@[A-Za-z]+\[/.test(floor)) r.hover = "shows codes";
  // ⚠️ THE ONE ROAD, PHASE 0: every activity's full recipe, or why it has none.
  try {
    r.recipes = recipesFor(item, { actor: item.actor }).map(recipeLine);
  } catch (err) {
    r.recipes = [`no recipe because building it failed: ${err?.message ?? err}`];
  }
  return r;
}

console.log(`\nGOLDEN, in ${WORLD}: EVERY ITEM, AGAINST THE LAST ACCEPTED RUN`);
const now = { world: WORLD, made: new Date().toISOString(), items: {} };
let errors = 0;
await quiet(async () => {
  for (const actor of ACTORS.values()) {
    for (const item of actor.items) {
      if (!readActivities(item).length) continue;
      const key = `${actor.id}.${item.id}`;
      try { now.items[key] = { who: `${actor.name} / ${item.name}`, ...recordFor(item) }; }
      catch (err) { errors++; now.items[key] = { who: `${actor.name} / ${item.name}`, error: String(err?.message ?? err) }; }
    }
  }
});
const count = Object.keys(now.items).length;
const codes = Object.values(now.items).filter(r => r.hover === "shows codes").length;
console.log(`  ${count} items read on ${ACTORS.size} creatures${errors ? `, ${errors} could not be read` : ""}.`);
// ⚠️ PINNED AT ZERO SINCE 2026-09-13. It was 2,758 on the first run, which is
// how "&Reference[BrightLight]" reached his hover of Prismatic Wall.
check("no hover shows raw codes, even before its full text is ready", codes === 0,
  codes ? `${codes} items still do` : `${count} items clean`);

// ⚠️ THE ONE ROAD, PHASE 0 (2026-09-13). His words: "Hijinx replay: every item
// gets that recipe, or a named 'no recipe because…'. Blade Barrier must show
// recatch." The golden below pins every line; these say what must be true.
{
  const recs = Object.values(now.items);
  const lines = recs.flatMap(r => r.recipes ?? []);
  const missing = recs.filter(r => !Array.isArray(r.recipes) || !r.recipes.length).map(r => r.who);
  const broke = lines.filter(l => /building it failed/.test(l));
  // Every named reason, counted, so each kind can be read rather than assumed.
  const reasons = new Map();
  for (const l of lines) {
    const m = l.match(/: (no recipe because .*?)(?: · not in the recipe|$)/);
    if (m) {
      const k = m[1].replace(/"[^"]*"/g, "\"…\"").replace(/at (?:Compendium|Item)\.[^,\s]+/, "at <uuid>");
      reasons.set(k, (reasons.get(k) ?? 0) + 1);
    }
  }
  // ⚠️ EVERY ITEM, not only the ones with something to press, which the golden keeps.
  let pressless = 0, all = 0;
  await quiet(async () => {
    for (const actor of ACTORS.values()) {
      for (const item of actor.items) {
        all++;
        if (readActivities(item).length) continue;
        const r = recipesFor(item, { actor });
        if (r.length === 1 && r[0].none) pressless++;
        else missing.push(`${actor.name} / ${item.name}`);
      }
    }
  });
  const nones = [...reasons.values()].reduce((a, b) => a + b, 0);
  check("every item has a full recipe, or a named reason it has none (Phase 0)",
    !missing.length && !broke.length,
    missing.length || broke.length
      ? `${missing.length} with nothing: ${missing.slice(0, 3).join("; ")}; `
        + `${broke.length} failed: ${broke.slice(0, 3).join(" | ")}`
      : `${lines.length - nones} recipes and ${nones} named reasons on ${recs.length} items; `
        + `${pressless} more of his ${all} items have nothing to press, and each says so`);
  for (const [why, n] of [...reasons].sort((a, b) => b[1] - a[1])) console.log(`      ${n} x ${why}`);

  const full = lines.filter(l => !/: no recipe because /.test(l));
  const FIELDS = ["key", "trigger", "where", "who", "decided", "on hit", "on crit", "on miss", "on fail",
    "on success", "then", "scaling", "lasts", "recatch", "interrupts", "mechanic", "animation",
    "resources", "confidence"];
  const short = full.filter(l => FIELDS.some(f => !l.includes(`· ${f} `)));
  check("every recipe carries every field, not a shape word (Phase 0)", !short.length,
    short.length ? `${short.length} lines miss a field, e.g. ${short[0]}` : `${full.length} full recipes`);

  const varek = ACTORS.get("2Z79PRegaAESfrGH");
  const itemOf = (actor, re) => (actor ? [...actor.items].find(i => re.test(String(i.name))) : null);
  const thorian = firstActor("Thorian Vex");
  let bb = [], dis = [], sg = [];
  await quiet(async () => {
    const bbItem = itemOf(varek, /^blade barrier/i), disItem = itemOf(varek, /^disintegrate/i);
    const sgItem = itemOf(thorian, /^spirit guardians/i);
    bb = bbItem ? recipesFor(bbItem, { actor: varek }) : [];
    dis = disItem ? recipesFor(disItem, { actor: varek }) : [];
    sg = sgItem ? recipesFor(sgItem, { actor: thorian }) : [];
  });
  // ⚠️ HIS COPY IS THE 2024 SPELL, AND ITS OWN WORDS DECIDE (09-13): "Any creature
  // in the wall's space makes a Dexterity saving throw", and "a creature also
  // makes that save if it enters the wall's space or ends it turn there". The
  // 2014 spell's "starts its turn there" is not in it. The first version of this
  // check asked for the 2014 triggers and was wrong, not the reader.
  const bbR = bb.map(x => x.recipe).filter(Boolean);
  check("Blade Barrier shows recatch: entering the wall, and ending a turn in it (2024, Phase 0)",
    bb.length === 2 && bbR.length === 2 && bbR.every(r => r.recatch.includes("enter-area")
      && r.recatch.includes("end-of-turn") && !r.recatch.includes("start-of-turn")),
    bb.map(recipeLine).join(" || ") || "Varek's Blade Barrier is not in this world");
  check("Blade Barrier: all in the wall save as it appears; 6d10 force, half on a success (2024, Phase 0)",
    bbR.length === 2 && bbR.every(r => r.who?.kind === "all-in-area"
      && r.onFail.some(o => o.kind === "damage" && o.formula === "6d10" && o.types.includes("force")
        && o.onSuccess === "half")),
    bb.map(x => `${x.label}: who ${x.recipe?.who?.kind}; fail ${JSON.stringify(x.recipe?.onFail)}`)
      .join(" || ") || "not found");
  // And a 2014 spell reads the 2014 way, from its own words: nobody saves as it
  // appears, only whoever enters it or starts a turn in it.
  const sgR = sg.map(x => x.recipe).filter(Boolean);
  check("Spirit Guardians (2014): whoever enters or starts a turn in it, nobody as it appears (Phase 0)",
    sgR.length === 1 && sgR[0].who?.kind === "enters-later"
      && sgR[0].recatch.join(",") === "enter-area,start-of-turn",
    sg.map(recipeLine).join(" || ") || "Thorian Vex's Spirit Guardians is not in this world");
  const disR = dis[0]?.recipe;
  check("Disintegrate: a DEX save, 10d6 + 40 force on a failure, nothing on a success (Phase 0)",
    dis.length === 1 && disR?.decidedBy?.kind === "save" && disR.decidedBy.ability === "dex"
      && disR.onFail.some(o => o.kind === "damage" && o.formula === "10d6 + 40" && o.types.includes("force")
        && o.onSuccess === "none")
      && !disR.onSuccess.length && disR.mechanic === "disintegrate",
    dis.map(recipeLine).join(" || ") || "Varek's Disintegrate is not in this world");

  // 09-14, after Johnny asked what "where unknown" meant: every unknown names its
  // reason, a place stated only in a creature's words is read, an escape does not
  // carry the walk-in rule, and formula sizes are worked out as dnd5e does.
  const silent = lines.filter(l => /no reason recorded/.test(l));
  check("every unknown says why (Phase 0)", !silent.length,
    silent.length ? `${silent.length} say nothing, e.g. ${silent[0]}` : "each names its reason");
  let web = [], fog = [], flail = [], multi = [], sending = [], hold = [];
  const gnoll = firstActor("Gnoll Fang of Yeenoghu"), giant = firstActor("Stone Giant");
  await quiet(async () => {
    const of = (actor, re) => { const it = itemOf(actor, re); return it ? recipesFor(it, { actor }) : []; };
    web = of(varek, /^web$/i);
    fog = of(varek, /^fog cloud$/i);
    sending = of(varek, /^sending$/i);
    hold = of(varek, /^hold person$/i);
    flail = of(gnoll, /^bone flail$/i);
    multi = of(giant, /^multiattack$/i);
  });
  const byLabel = (recs, name) => recs.find(x => x.label === name)?.recipe;
  check("Web: Caught catches whoever walks in; Break Free, the escape, does not (Phase 0)",
    !!byLabel(web, "Caught")?.recatch.includes("enter-area") && byLabel(web, "Break Free")?.recatch.length === 0,
    web.map(recipeLine).join(" || ") || "Varek's Web is not in this world");
  const fogR = fog[0]?.recipe;
  check("Fog Cloud: a 20-foot sphere worked out as dnd5e does, 20 ft more per slot (Phase 0)",
    fogR?.where?.shape === "sphere" && fogR.where.size === 20 && /\+20ft area/.test(fogR.scaling?.step ?? ""),
    fog.map(recipeLine).join(" || ") || "Varek's Fog Cloud is not in this world");
  const flailR = flail[0]?.recipe;
  check("The Gnoll Fang's Bone Flail reaches 10 feet, read from its words (Phase 0)",
    !!flailR?.where?.melee && flailR.where.rangeFt === 10 && flailR.evidence.includes("description"),
    flail.map(recipeLine).join(" || ") || "the Gnoll Fang's Bone Flail is not in this world");
  check("A Multiattack is named, not unknown (Phase 0)",
    multi.length > 0 && multi.every(x => /Multiattack/.test(x.none ?? "")),
    multi.map(recipeLine).join(" || ") || "the Stone Giant's Multiattack is not in this world");
  check("Sending reaches without limit (Phase 0)", sending[0]?.recipe?.where?.unlimited === true,
    sending.map(recipeLine).join(" || ") || "Varek's Sending is not in this world");
  check("Hold Person gains a target for each slot above its own (Phase 0)",
    /\+1 target\b/.test(hold[0]?.recipe?.scaling?.step ?? ""),
    hold.map(recipeLine).join(" || ") || "Varek's Hold Person is not in this world");
}

// ⚠️ THE ONE ROAD, PHASE 1 (2026-09-14): what a save lands is decided from its
// recipe, by one decider (road/what-lands.mjs). Section 16: "Done when the
// replay pins Disintegrate, Fireball, Hold Person and Blade Barrier's cast save."
{
  const varek = ACTORS.get("2Z79PRegaAESfrGH");
  const saveRecipe = (re) => {
    const it = varek ? [...varek.items].find(i => re.test(String(i.name))) : null;
    return it ? recipesFor(it, { actor: varek }).find(x => x.recipe?.decidedBy?.kind === "save")?.recipe ?? null : null;
  };
  let dis = null, fire = null, hold = null, wall = null;
  await quiet(async () => {
    dis = saveRecipe(/^disintegrate/i);
    fire = saveRecipe(/^fireball/i);
    hold = saveRecipe(/^hold person/i);
    wall = saveRecipe(/^blade barrier/i);
  });
  const lands = (r, passed, total, type) => (r ? whatLands(r, { passed, rolled: total ? [{ total, type }] : [] }) : null);
  const amounts = (o) => (o ? o.damage.map(d => `${d.amount} ${d.type}`).join(", ") || "no damage" : "no recipe");
  let failed = lands(dis, false, 75, "force"), made = lands(dis, true, 75, "force");
  check("Disintegrate: a failed save lands its 10d6 + 40 force, a made one nothing (Phase 1)",
    failed?.damage[0]?.amount === 75 && failed.damage[0].type === "force" && !!made && made.damage.every(d => d.amount === 0),
    `failed: ${amounts(failed)}; made: ${amounts(made)}`);
  failed = lands(fire, false, 29, "fire");
  made = lands(fire, true, 29, "fire");
  check("Fireball: a failed save lands all of it, a made one half, rounded down (Phase 1)",
    failed?.damage[0]?.amount === 29 && made?.damage[0]?.amount === 14, `failed: ${amounts(failed)}; made: ${amounts(made)}`);
  failed = lands(hold, false);
  made = lands(hold, true);
  check("Hold Person: a failed save lands Paralyzed, ending on its end-of-turn save; a made one nothing (Phase 1)",
    !!failed?.conditions.some(c => c.key === "paralyzed" && /end of each of its turns/.test(c.ends ?? ""))
      && !!made && !made.conditions.length,
    `failed: ${JSON.stringify(failed?.conditions ?? null)}; made: ${JSON.stringify(made?.conditions ?? null)}`);
  failed = lands(wall, false, 33, "force");
  made = lands(wall, true, 33, "force");
  check("Blade Barrier's cast save: all in the wall, failed 33 force, made 16 (Phase 1)",
    wall?.who?.kind === "all-in-area" && failed?.damage[0]?.amount === 33 && made?.damage[0]?.amount === 16,
    `who ${wall?.who?.kind}; failed: ${amounts(failed)}; made: ${amounts(made)}`);

  // ── Half on a success: each activity's own data, never another save's words ──
  const itemOf = (actorRe, itemRe, keep = () => true) => {
    for (const a of ACTORS.values()) {
      if (!actorRe.test(String(a.name))) continue;
      for (const it of a.items) if (itemRe.test(String(it.name)) && keep(it)) return it;
    }
    return null;
  };
  const onSuccessOf = (it) => {
    const out = {};
    if (!it) return out;
    for (const rec of recipesFor(it, { actor: it.actor })) {
      const d = rec.recipe?.onFail?.find(o => o.kind === "damage");
      if (d) out[rec.label] = d.onSuccess ?? "none";
    }
    return out;
  };
  let weird = {}, shade = {};
  await quiet(async () => {
    weird = onSuccessOf(itemOf(/^varek thalor/i, /^weird$/i));
    shade = onSuccessOf(itemOf(/^shade tyrant/i, /^black charge$/i));
  });
  const said = (o) => Object.entries(o).map(([k, v]) => `${k}: ${v}`).join("; ") || "not in this world";
  check("a sentence about one save does not decide another: Weird's end-of-turn save takes nothing on a success (Phase 1)",
    weird.save === "half" && weird["End of Turn Save"] === "none", said(weird));
  check("the Shade Tyrant's evading save takes nothing on a success, its bracing save half, each by its own data (Phase 1)",
    shade.Evade === "none" && shade.Brace === "half", said(shade));

  // ── The save engine reads the same recipe (one reading, 2026-09-14) ──
  const saveAct = (re) => {
    const it = varek ? [...varek.items].find(i => re.test(String(i.name))) : null;
    return { it, a: it ? readActivities(it).find(x => x.type === "save") ?? null : null };
  };
  const rules = {};
  await quiet(async () => {
    for (const [k, re] of Object.entries({ dis: /^disintegrate/i, fire: /^fireball/i, hold: /^hold person/i, wall: /^blade barrier/i })) {
      const { it, a } = saveAct(re);
      rules[k] = it && a ? SaveEngine.saveDamageRule(it, a) : null;
    }
  });
  const ruleLine = (x) => (x ? `${x.damageTypes.join("/") || "no damage"}${x.halfOnSave ? ", half on a save" : ", nothing on a save"}`
    + `${x.recipe ? "" : " (NOT read from its recipe)"}` : "not in this world");
  check("the save engine reads Disintegrate's damage from its recipe: force, nothing on a save (Phase 1)",
    !!rules.dis?.recipe && rules.dis.damageTypes.join() === "force" && rules.dis.halfOnSave === false, ruleLine(rules.dis));
  check("the save engine reads Fireball's damage from its recipe: fire, half on a save (Phase 1)",
    !!rules.fire?.recipe && rules.fire.damageTypes.join() === "fire" && rules.fire.halfOnSave === true, ruleLine(rules.fire));
  check("the save engine reads Hold Person from its recipe: no damage (Phase 1)",
    !!rules.hold?.recipe && rules.hold.damageTypes.length === 0, ruleLine(rules.hold));
  check("the save engine reads Blade Barrier's cast save from its recipe: force, half on a save (Phase 1)",
    !!rules.wall?.recipe && rules.wall.damageTypes.join() === "force" && rules.wall.halfOnSave === true, ruleLine(rules.wall));

  // ── The slot a spell was cast with reaches its damage roll ──
  const fireIt = saveAct(/^fireball/i).it;
  const cantrip = varek ? [...varek.items].find(i => i.type === "spell" && Number(i.system?.level) === 0) : null;
  const lv = fireIt ? {
    raised: SaveEngine._castLevelFrom({ item: { type: "spell", system: fireIt.system, flags: { dnd5e: { scaling: 2 } } } }),
    stamped: SaveEngine._castLevelFrom({ item: fireIt }, { message: { system: { spellLevel: 6 } } }),
    own: SaveEngine._castLevelFrom({ item: fireIt }),
    template: SaveEngine._castLevelFromTemplate({ flags: { "ace-qol": { castLevel: 5 }, dnd5e: { spellLevel: 3 } } }, fireIt),
    dnd5eOnly: SaveEngine._castLevelFromTemplate({ flags: { dnd5e: { spellLevel: 3 } } }, fireIt),
    at5: SaveEngine._damageRollConfig(fireIt, 5), at3: SaveEngine._damageRollConfig(fireIt, 3),
  } : null;
  check("the slot a spell was cast with reaches its damage roll: Fireball from a 5th-level slot scales by 2 (Phase 1)",
    !!lv && lv.raised === 5 && lv.stamped === 6 && lv.own === 3 && lv.template === 5 && lv.dnd5eOnly === 3
      && lv.at5.scaling === 2 && lv.at5.aceQol?.ownRoll === true && lv.at3.scaling === undefined,
    lv ? `dnd5e's raised copy: ${lv.raised}; its message says 6: ${lv.stamped}; nothing said: ${lv.own}; `
      + `a template ACE stamped 5: ${lv.template}; dnd5e's note only: ${lv.dnd5eOnly}; scaling at 5th: ${lv.at5.scaling}, at 3rd: ${lv.at3.scaling}`
      : "Varek's Fireball is not in this world");
  check("a cantrip's damage is left to dnd5e's own scaling by the caster's level (Phase 1)",
    cantrip ? SaveEngine._damageRollConfig(cantrip, 5).scaling === undefined : null,
    cantrip ? `${cantrip.name}: no slot scaling sent` : "Varek has no cantrip");

  // ── The spell pipeline refuses dnd5e's loose die, never ACE's own roll ──
  const disIt = saveAct(/^disintegrate/i).it;
  const refuses = (cfg) => (disIt ? SpellPipeline._refusesNativeDamage({ subject: { item: disIt }, ...cfg }) : null);
  check("the spell pipeline never refuses ACE's own damage roll for a spell it resolves itself (Disintegrate) (Phase 1)",
    !!disIt && SpellPipeline.resolvesItself(disIt) === true && refuses({}) === true && refuses({ aceQol: { ownRoll: true } }) === false,
    `it resolves Disintegrate itself: ${disIt ? SpellPipeline.resolvesItself(disIt) : "?"}; dnd5e's own roll refused: ${refuses({})}; `
      + `ACE's own roll refused: ${refuses({ aceQol: { ownRoll: true } })}`);

  // ── One reading of what a card row takes, for the card and APPLY ALL ──
  // The row carries its save's result; what that lets through is whatLands', on the recipe.
  const resists = { fire: { modifier: "resistant", reason: "Resists fire" } };
  const fr = SaveEngine._damageForRow({ passed: true, damageModifiers: resists }, [{ total: 29, type: "fire" }], fire);
  const frFailed = SaveEngine._damageForRow({ passed: false, damageModifiers: resists }, [{ total: 29, type: "fire" }], fire);
  const drMade = SaveEngine._damageForRow({ passed: true }, [{ total: 75, type: "force" }], dis);
  check("a card row: a made Fireball on a creature that resists fire takes 7 of 29, a failed one 14 (each halving rounds down) (Phase 1)",
    fr.total === 7 && fr.finals[0]?.modifier === "resistant" && frFailed.total === 14,
    `made ${fr.total} (${fr.finals.map(f => `${f.final} ${f.type}, ${f.modifier}`).join("; ")}); failed ${frFailed.total}`);
  check("a card row: a made Disintegrate takes none of its 75, as its recipe says (Phase 1)",
    drMade.total === 0, `${drMade.total}`);
  const ov = SaveEngine._overriddenFinals({ baseDamageTotal: 15, damageComponentTotals: [{ total: 7, type: "fire" }, { total: 8, type: "cold" }] }, 0.5);
  check("the GM's half on a 7 fire + 8 cold row lands 7, the card's number, and keeps both types (Phase 1)",
    ov.reduce((s, f) => s + f.final, 0) === 7 && ov.map(f => f.type).join() === "fire,cold", ov.map(f => `${f.final} ${f.type}`).join(", "));

  // ── The live save path decides through whatLands, on the save's recipe ──
  // Johnny, 2026-09-14: "Live saves call whatLands(recipe, { passed, rolled,
  // evasion }), then HpDoor / ConditionDoor / SignalDoor", and "save-engine must
  // not compute half/none or 'skip conditions because there is damage' on its
  // own." A save rolled the way the card rolls it, and what a failure puts on (a
  // dry run of the same code, which writes nothing), on a linked copy of a Goblin.
  {
    const engine = Object.create(SaveEngine.prototype);        // its hooks are never registered
    const goblin = [...ACTORS.values()].find(a => a.type === "npc" && /^goblin$/i.test(a.name)
      && Number(a.system?.attributes?.hp?.value) > 0) ?? null;
    const burstIt = itemOf(/^varek thalor/i, /^sunburst$/i);
    const holdIt = saveAct(/^hold person/i).it;
    if (!goblin || !dis || !fire || !hold || !holdIt) {
      check("the live save path through whatLands (Phase 1)", null,
        "(a Goblin, or Varek's Disintegrate, Fireball or Hold Person, is missing)");
    } else {
      const target = { ...goblin, id: "replay-save-target", uuid: "Actor.replay-save-target",
        prototypeToken: { ...(goblin.prototypeToken ?? {}), actorLink: true }, statuses: new Set(), effects: new Collection() };
      ACTORS.set(target.id, target);
      const tgt = (extra = {}) => ({ name: target.name, img: "", actorId: target.id, tokenDocId: null, sceneId: null, ...extra });
      const got = {};
      try {
        await quiet(async () => {
          const high = [{ value: 60 }];
          got.disMade = await engine._rollSingleSave(tgt({ saveBonuses: high }), "dex", 23, dis, null, { isMultiTarget: true });
          got.fireMade = await engine._rollSingleSave(tgt({ saveBonuses: high }), "dex", 23, fire, null, { isMultiTarget: true });
          got.fireFailed = await engine._rollSingleSave(tgt(), "dex", 23, fire, null, { isMultiTarget: true });
          got.autoFail = await engine._rollSingleSave(tgt({ autoFailSave: true }), "dex", 23, fire, null, {});
          const failedRow = { ...tgt(), passed: false };
          const burst = burstIt ? SaveEngine.saveRecipe(burstIt, readActivities(burstIt).find(x => x.type === "save")).recipe : null;
          got.burst = burstIt ? await engine._applyFailedSaveConditions(burstIt, [failedRow],
            { recipe: burst, saveAbility: "con", saveDC: 23, dryRun: true }) : null;
          got.hold = await engine._applyFailedSaveConditions(holdIt, [failedRow],
            { recipe: hold, saveAbility: "wis", saveDC: 23, dryRun: true });
        });
      } finally {
        ACTORS.delete(target.id);
      }
      const rowSaid = (r) => (r ? `${r.resultLabel}, takes ${r.damageMultiplier}` : "no row");
      check("a save rolled for the card takes its label and share from whatLands: Disintegrate made, none; Fireball made, half; failed or auto-failed, all (Phase 1)",
        got.disMade?.passed === true && got.disMade.resultLabel === "PASS (NO DMG)" && got.disMade.damageMultiplier === 0
          && got.fireMade?.passed === true && got.fireMade.resultLabel === "PASS (HALF)" && got.fireMade.damageMultiplier === 0.5
          && got.fireFailed?.passed === false && got.fireFailed.resultLabel === "FAIL" && got.fireFailed.damageMultiplier === 1
          && got.autoFail?.resultLabel === "AUTO-FAIL" && got.autoFail.damageMultiplier === 1,
        `Disintegrate made: ${rowSaid(got.disMade)}; Fireball made: ${rowSaid(got.fireMade)}; failed: ${rowSaid(got.fireFailed)}; auto-failed: ${rowSaid(got.autoFail)}`);
      const landed = (a) => (a ? (a.flatMap(x => x.conditions ?? []).join(", ")
        || a.map(x => x.declined ?? x.handedOff ?? "").filter(Boolean).join("; ") || "nothing") : "not in this world");
      check("a failed Sunburst gets its Blinded as well as its radiant damage: damage no longer keeps a condition off (Phase 1)",
        got.burst ? got.burst.some(x => (x.conditions ?? []).includes("blinded")) : null, landed(got.burst));
      check("a failed Hold Person gets Paralyzed from its recipe (Phase 1)",
        !!got.hold?.some(x => (x.conditions ?? []).includes("paralyzed")), landed(got.hold));
    }
  }

  // ── The book is the recipe for a named official spell; the sheet is this cast ──
  // Johnny, 2026-09-14: "Pack is the recipe. Sheet is the instance. Do NOT update
  // the actor item when they differ. Log: edition, name, actor, what the pack
  // says, what the sheet says. Put it on the review list."
  {
    const banish = itemOf(/^varek thalor/i, /^banishment$/i, it => String(it.system?.source?.rules) === "2024");
    const sheetRange = (it) => readActivities(it).find(a => a.type === "save")?.range?.value ?? null;
    let rec = null, note = null, before = null, after = null;
    if (banish) {
      before = JSON.stringify(banish._source);
      await quiet(async () => {
        rec = recipesFor(banish, { actor: banish.actor }).find(x => x.recipe?.decidedBy?.kind === "save") ?? null;
      });
      after = JSON.stringify(banish._source);
      note = bookReview().find(b => b.name === banish.name && b.actorId === banish.actor?.id) ?? null;
    }
    const where = note?.differences?.find(d => d.field === "where");
    check("a named official spell takes its recipe from the book and keeps its sheet: Varek's 2024 Banishment reads the book's 30 feet, his sheet still says 60 (Phase 1)",
      banish ? (!!rec?.recipe?.evidence?.includes("book") && rec.recipe.where?.rangeFt === 30
        && sheetRange(banish) === 60 && before === after) : null,
      banish ? `recipe from ${rec?.book?.pack ?? "the sheet"}: ${rec?.recipe?.where?.rangeFt ?? "?"} feet; `
        + `the sheet: ${sheetRange(banish)} feet; the sheet untouched: ${before === after}` : "Varek has no 2024 Banishment");
    check("and the difference is on the review list: edition, name, creature, what the book says and what the sheet says (Phase 1)",
      banish ? (note?.edition === "2024" && note.actor === banish.actor?.name && !!note.pack
        && where?.book === "ranged 30ft" && where?.sheet === "ranged 60ft") : null,
      note ? `${note.edition}, ${note.name}, ${note.actor}, ${note.pack}: `
        + note.differences.map(d => `${d.field}: the book says ${d.book}; the sheet says ${d.sheet}`).join("; ") : "no review entry");
    // A name does not say which creature's feature it is: the Monster Manual's
    // feature pack holds a template Bite of 1d4 piercing.
    const bites = [...ACTORS.values()].filter(a => a.name === "Wolf").flatMap(a => [...a.items].filter(i => i.name === "Bite"));
    let fromBook = [];
    await quiet(async () => {
      fromBook = bites.filter(b => recipesFor(b, { actor: b.actor }).some(x => x.recipe?.evidence?.includes("book")));
    });
    check("a creature's feature is never read from a same-named book template: every Wolf's Bite is its own (Phase 1)",
      bites.length ? fromBook.length === 0 : null,
      bites.length ? `${bites.length} Wolf Bites, ${fromBook.length} read from a book` : "no Wolf in this world");
  }

  // ── Evasion is a Dexterity rule ──
  const evader = [...ACTORS.values()].find(a => [...(a.items ?? [])].some(i => /^evasion\b/i.test(String(i.name))));
  check("Evasion counts for a Dexterity save and not for a Wisdom one (Phase 1)",
    evader ? (CombatState.evasionFor(evader, "dex") === true && CombatState.evasionFor(evader, "wis") === false) : null,
    evader ? `${evader.name}: Dexterity ${CombatState.evasionFor(evader, "dex")}, Wisdom ${CombatState.evasionFor(evader, "wis")}`
      : "nobody in this world has Evasion");

  // ── The doors (section 11) ──
  const sent = [];
  const keepCallAll = Hooks.callAll;
  Hooks.callAll = (name, payload) => { sent.push({ name, payload }); };
  try {
    const t0 = Date.now();
    await untilDiceLand(false);
    const waited = Date.now() - t0;
    let refused = null;
    await quiet(async () => { refused = await SignalDoor.send("madeUpSignal", {}); });
    const hp = { value: 30, max: 30, temp: 0 };
    const creature = { id: "replay-door-test", name: "a test creature", system: { attributes: { hp } },
      update: async (u) => {
        if ("system.attributes.hp.value" in u) hp.value = u["system.attributes.hp.value"];
        if ("system.attributes.hp.temp" in u) hp.temp = u["system.attributes.hp.temp"];
        return creature;
      } };
    let landed = null;
    await quiet(async () => {
      landed = await HpDoor.damage(creature, [{ type: "fire", final: 14 }], { tokenDocId: "t1", item: fireIt, source: varek, label: "replay" });
    });
    const sig = sent.find(s => s.name === "ace-qol.damageApplied")?.payload ?? null;
    check("a door with no dice to wait for lands at once (frozen note 4) (Phase 1)", waited < 50, `${waited} ms`);
    check("the signal door refuses a signal The One Road does not name (frozen note 5) (Phase 1)",
      refused === false && !sent.some(s => s.name === "ace-qol.madeUpSignal"), `it answered ${refused}`);
    check("save damage through the hit-point door moves the hit points and says so, naming who dealt it (Phase 1)",
      landed?.applied === true && hp.value === 16 && sig?.hpDelta === 14 && sig?.sourceActor === varek && sig?.types?.join() === "fire",
      `applied: ${landed?.applied}; hit points 30 to ${hp.value}; signal: `
        + (sig ? `${sig.hpDelta} moved, dealt by ${sig.sourceActor?.name ?? "nobody"}, ${sig.types?.join("/")}` : "none sent"));
  } finally {
    Hooks.callAll = keepCallAll;
  }
}

let golden = null;
if (existsSync(GOLDEN)) {
  try { golden = JSON.parse(readFileSync(GOLDEN, "utf8")); }
  catch (err) { console.log(`  the last accepted run could not be read (${err.message}); it will be replaced.`); }
}
const record = (why) => {
  mkdirSync(GOLDEN_DIR, { recursive: true });
  writeFileSync(GOLDEN, JSON.stringify(now, null, 1));
  console.log(`  recorded as the accepted run (${why}): ${GOLDEN}`);
};
if (!golden) {
  record("the first run on this machine");
} else {
  const changed = [], added = [], removed = [];
  for (const [key, rec] of Object.entries(now.items)) {
    const old = golden.items?.[key];
    if (!old) { added.push(rec.who); continue; }
    const fields = [...new Set([...Object.keys(old), ...Object.keys(rec)])].filter(f => f !== "who")
      .filter(f => JSON.stringify(old[f] ?? null) !== JSON.stringify(rec[f] ?? null));
    if (fields.length) changed.push({ who: rec.who, fields: fields.map(f => ({ f, was: old[f] ?? null, now: rec[f] ?? null })) });
  }
  for (const [key, rec] of Object.entries(golden.items ?? {})) if (!now.items[key]) removed.push(rec.who);
  if (!changed.length && !added.length && !removed.length) {
    check(`every item decides exactly as it did on ${String(golden.made).slice(0, 10)}`, true, `${count} items`);
  } else {
    console.log(`  ${changed.length} changed, ${added.length} new, ${removed.length} gone since ${String(golden.made).slice(0, 16)}:`);
    for (const c of changed) {
      console.log(`    ${c.who}`);
      for (const { f, was, now: is } of c.fields) {
        console.log(`      ${f}:`);
        console.log(`        was  ${JSON.stringify(was)}`);
        console.log(`        now  ${JSON.stringify(is)}`);
      }
    }
    if (added.length) console.log(`    new: ${added.slice(0, 30).join("; ")}${added.length > 30 ? ` (+${added.length - 30} more)` : ""}`);
    if (removed.length) console.log(`    gone: ${removed.slice(0, 30).join("; ")}${removed.length > 30 ? ` (+${removed.length - 30} more)` : ""}`);
    if (ACCEPT) record("every change above is meant");
    else check("nothing changed that was not meant", false,
      "read every change above; if each is meant, run again with --accept");
  }
}
if (chatter.warn) {
  console.log(`\n  (ACE warned ${chatter.warn} times while reading; the first few:)`);
  for (const s of chatter.samples) console.log(`    ${s}`);
}

console.log("");
console.log(pass + " passed, " + fail + " failed" + (skip ? `, ${skip} skipped` : ""));
process.exitCode = fail ? 1 : 0;
