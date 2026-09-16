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
globalThis.canvas = { grid: { size: 100, distance: 5 }, scene: null, tokens: { placeables: [], controlled: [],
  // TokenLayer#get: the placeable with this document id, as Foundry's canvas finds it.
  get(id) { return this.placeables.find(t => t.id === id || t.document?.id === id) ?? null; } } };
globalThis.CONST = { ACTIVE_EFFECT_MODES: { ADD: 2, CUSTOM: 0, OVERRIDE: 5 }, GRID_SNAPPING_MODES: {} };
// ⚠️ A CARD FOUNDRY MADE CAN BE WRITTEN ON. ACE stamps a save card with flags
// after posting it (whose roll is still owed, which cast it belongs to), and a
// stand-in card with no setFlag threw where a table never would.
globalThis.ChatMessage = { create: async (data) => {
  const msg = { id: `msg${posted.length + 1}`, ...data, flags: data?.flags ?? {} };
  msg.setFlag = async (scope, key, value) => {
    const path = String(key).split(".");
    let o = (msg.flags[scope] ??= {});
    for (const k of path.slice(0, -1)) o = (o[k] ??= {});
    o[path[path.length - 1]] = value;
    return msg;
  };
  msg.getFlag = (scope, key) => String(key).split(".").reduce((o, k) => o?.[k], msg.flags?.[scope]);
  msg.update = async (u = {}) => {
    if (u.content !== undefined) msg.content = u.content;
    for (const [scope, v] of Object.entries(u.flags ?? {})) msg.flags[scope] = { ...(msg.flags[scope] ?? {}), ...v };
    return msg;
  };
  // ⚠️ THE RECORD KEEPS WHAT WAS POSTED, not the card object: pins read these as
  // the data ACE handed Foundry. The flags object is shared, so a later setFlag
  // shows up here exactly as it does on a real card.
  posted.push(data);
  return msg;
}, getSpeaker: () => ({}) };
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
      // A die term's own total, as Foundry's DiceTerm has one: a crit rule adds them up.
      terms.push({ faces: Number(faces), number: count, total: keep ? 1 : count,
        results: Array.from({ length: count }, () => ({ result: 1, active: true })) });
      return String(keep ? 1 : count);
    });
    let total = 0, sign = 1;
    // ⚠️ BRACKETS ARE A SUM, NOT A NUMBER. "(2d4) + (2d4)" is how the rules ask
    // for a die per five feet, and Foundry rolls each bracket on its own; the
    // stand-in read "(2)" as NaN and totalled nothing (Phase 5, 2026-09-15).
    for (const tok of expr.replace(/[()\s]/g, "").split(/([+-])/)) {
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
  recipesFor, recipeLine, formulaValue, whatLands, HpDoor, SignalDoor, untilDiceLand, CombatState, guardianCastActivity,
  RulesIndex, bookReview, fullDamageSaves, PressGate, DamageCalculator, DamageApplicator, DamageCardRenderer,
  CardDoor, recipeForActivity, loadBookFor, isFollowUp;
try {
  ({ readPrismaticWall } = await import(`${MODULE}/scripts/rules/prismatic-wall.mjs`));
  ({ PrismaticWallEngine } = await import(`${MODULE}/scripts/prismatic-wall-engine.mjs`));
  ({ RepeatingSaveEngine } = await import(`${MODULE}/scripts/repeating-save-engine.mjs`));
  ({ guardianCastActivity } = await import(`${MODULE}/scripts/rules/spirit-guardians.mjs`));
  ({ SpellPipeline } = await import(`${MODULE}/scripts/spell-pipeline/pipeline.mjs`));
  ({ SaveEngine } = await import(`${MODULE}/scripts/save-engine.mjs`));
  ({ PostHitSaves } = await import(`${MODULE}/scripts/post-hit-saves.mjs`));
  ({ DescriptionParser } = await import(`${MODULE}/scripts/description-parser.mjs`));
  ({ readSaveOutcome } = await import(`${MODULE}/scripts/inference/save-outcome-effects.mjs`));
  ({ readActivities, readAppliedConditions } = await import(`${MODULE}/scripts/read-activities.mjs`));
  ({ decideActivityChoice, upCanBeSeen, spellIsUp } = await import(`${MODULE}/scripts/activity-choice.mjs`));
  ({ aceStripEnrichers } = await import(`${MODULE}/scripts/description-reader.mjs`));
  ({ recipesFor, recipeLine, bookReview, fullDamageSaves, recipeForActivity, loadBookFor, isFollowUp }
    = await import(`${MODULE}/scripts/inference/recipe.mjs`));
  ({ RulesIndex } = await import(`${MODULE}/scripts/rules/rules-index.mjs`));
  ({ formulaValue } = await import(`${MODULE}/scripts/inference/formula-value.mjs`));
  ({ whatLands } = await import(`${MODULE}/scripts/road/what-lands.mjs`));
  ({ HpDoor, SignalDoor, untilDiceLand, CardDoor } = await import(`${MODULE}/scripts/road/doors.mjs`));
  ({ DamageCalculator } = await import(`${MODULE}/scripts/damage-calculator.mjs`));
  ({ DamageApplicator } = await import(`${MODULE}/scripts/damage-applicator.mjs`));
  ({ DamageCardRenderer } = await import(`${MODULE}/scripts/damage-card-renderer.mjs`));
  ({ CombatState } = await import(`${MODULE}/scripts/combat-state.mjs`));
  ({ PressGate } = await import(`${MODULE}/scripts/gate/press-gate.mjs`));
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
/** dnd5e's offersBaseDamage: a weapon always, a consumable only as ammunition. */
const offersBaseDamage = (type, system) => type === "weapon" || (type === "consumable" && system?.type?.value === "ammo");
/** DamageData#formula is empty only with no custom formula, no dice and no bonus. */
const baseFormulaOf = (base) => !!base && !!((base.custom?.enabled && String(base.custom.formula ?? "").trim())
  || (Number(base.number) && Number(base.denomination)) || String(base.bonus ?? "").trim());
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
  // ⚠️ dnd5e LOADS AN ATTACK WITH ITS WEAPON'S BASE DAMAGE IN FRONT (09-14):
  // AttackActivityData#prepareFinalData puts the item's base damage at the head of
  // the attack's damage parts, marked `base`, when the activity includes it and the
  // item offers one (a weapon always; ammunition as ammunition). The live recipe
  // read it twice; the stored copy here never had it, so the replay could not see.
  if (a.type === "attack" && out.damage?.includeBase !== false && offersBaseDamage(type, system)) {
    const base = system.damage?.base;
    if (baseFormulaOf(base)) {
      const d = plain(out.damage) ? { ...out.damage } : { parts: [] };
      d.parts = [{ ...copy(base), base: true, locked: true }, ...(Array.isArray(d.parts) ? d.parts : [])];
      out.damage = d;
    }
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
    spellIsUp: up, upCanBeSeen: () => upCanBeSeen(item, readActivities(item)),
    // A spell whose own rule says what a fresh press means (2026-09-16).
    oneCast: () => guardianCastActivity(item, readActivities(item)) });
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
// what is checked. (Phase 3: at the table this save runs on the save engine,
// pinned under PHASE 3 below. With no save engine on the API, as here, the
// post-hit card still asks it: the fallback this block pins.)
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

  // ── A save whose sheet says "full" stays none-on-success, and is named ──
  // Johnny, 2026-09-14: "Leave the 12 'full' saves as none-on-success. Do not add
  // a third onSuccess value. Keep the names on the review list."
  {
    const stored = [];   // read straight from the stored items, not through ACE
    for (const a of ACTORS.values()) {
      for (const it of a.items) {
        for (const raw of Object.values(it._source?.system?.activities ?? {})) {
          if (raw?.type === "save" && raw?.damage?.onSave === "full" && (raw?.damage?.parts ?? []).length) {
            stored.push(`${a.name} / ${it.name}`);
          }
        }
      }
    }
    let listed = [];
    await quiet(async () => { listed = await fullDamageSaves([...ACTORS.values()]); });
    const sorted = (xs) => JSON.stringify([...xs].sort());
    // "no damage": the book's save carries none at all (2024 Wrathful Smite puts it on the hit).
    const notNone = listed.filter(f => f.takes !== "none" && f.takes !== "no damage");
    check("every damaging save whose sheet says full is on the review list, and takes none on a made save (Phase 1)",
      stored.length ? (sorted(stored) === sorted(listed.map(f => `${f.actor} / ${f.name}`)) && !notNone.length) : null,
      stored.length ? `${listed.length} listed of ${stored.length} stored`
        + (notNone.length ? `; not none: ${notNone.map(f => `${f.actor} / ${f.name} takes ${f.takes} (${f.from})`).join("; ")}`
          : "; each takes none") : "no save in this world says full");
  }

  // ── A creature's own feature is never matched to a book by its name ──
  // Johnny, 2026-09-14: "Creature features stay on the creature's own sheet. No
  // MM-template matching by feature name." The recipe, the spell pipeline's own
  // reading and the book check all ask the books reader the same question.
  {
    const bite = RulesIndex.lookup("Bite", { edition: "2024" });
    const templates = (RulesIndex._status?.packs ?? []).filter(p => p.skipped).map(p => p.id);
    const read = [];
    await quiet(async () => {
      for (const a of ACTORS.values()) {
        if (a.type === "character") continue;
        for (const it of a.items) {
          if (it.type === "spell") continue;
          try { if (SpellPipeline._getEntry(it)?.usedBook) read.push(`${a.name} / ${it.name}`); }
          catch (_) { /* an entry that cannot be read uses no book */ }
        }
      }
    });
    check("no creature-feature template pack answers a name: the Monster Manual's Bite is never found (Phase 1)",
      templates.includes("dnd-monster-manual.features") && !(bite.hits ?? []).some(h => templates.includes(h.pack)),
      `Bite: ${bite.status}; template packs left out: ${templates.join(", ") || "none"}`);
    check("no creature's own feature is read from a book by its name, in the spell pipeline either (Phase 1)",
      read.length === 0, read.length ? `${read.length}, e.g. ${read.slice(0, 3).join("; ")}` : "none");
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

/* ── PHASE 2: THE ONE GATE, AND DO IT ANYWAY ─────────────────────────────── */
// Johnny, 2026-09-14: "Next phase is only the gate + Do it anyway. Same rule: one
// done-check, then stop." The done-check, as stated to him: the replay pins the
// one gate refusing, each by its rule's name: a paralyzed caster; a spell cast
// in armor the caster can't wear; a second levelled spell in one turn; Hold
// Vampires with no vampire in reach; Hold Person on a non-humanoid; an ordinary
// revive on a creature killed for good. Also: the old separate press hooks are
// gone, and Do it anyway lets that same press through once, logged, with the
// overrule on its card.
console.log(`\nPHASE 2: ONE GATE, AND DO IT ANYWAY`);
{
  const MOD = "ace-qol";
  const tick = () => new Promise(r => setTimeout(r, 0));
  const actsOf = (it) => [...(it?.system?.activities ?? [])];
  const firstOfType = (it, type) => actsOf(it).find(a => a.type === type) ?? null;
  const tokenOf = (actor, flags = {}) => {
    const document = { id: `tok-${actor.id}`, actorId: actor.id, actor, parent: { id: "replay-scene" },
      flags, x: 0, y: 0, width: 1, height: 1, elevation: 0 };
    return { id: document.id, name: actor.name, actor, document, x: 0, y: 0, w: 100, h: 100, setTarget() {} };
  };
  const toasts = [];
  const keepWarn = ui.notifications.warn;
  ui.notifications.warn = (m) => { toasts.push(String(m)); };
  // What the rules say about a press, with these targets, and nothing done.
  const judged = async (activity, targets = []) => {
    const user = game.user;
    user.targets = new Set(targets);
    let said = [];
    try { await quiet(async () => { said = PressGate.judge(PressGate.contextFor(activity, {}), null); }); }
    finally { delete user.targets; }
    return said;
  };
  // One press through the gate, as dnd5e hands it over, with these targets.
  const pressGate = async (activity, targets = []) => {
    const before = posted.length;
    const messageConfig = {};
    const user = game.user;
    let answer, said = [];
    user.targets = new Set(targets);
    try {
      await quiet(async () => {
        said = PressGate.judge(PressGate.contextFor(activity, {}), PressGate._passFor(activity.uuid));
        answer = PressGate.onPress(activity, {}, {}, messageConfig);
        await tick(); await tick();
      });
    } finally { delete user.targets; }
    const card = posted.slice(before).find(p => p.flags?.[MOD]?.type === "gateRefusal") ?? null;
    const rules = card?.flags?.[MOD]?.gate?.rules ?? [];
    return { answer, said, card, messageConfig, ids: rules.map(r => r.id), rules };
  };
  const refusedOnlyBy = (r, id) => r.answer === false && r.ids.length === 1 && r.ids[0] === id
    && !!r.rules[0]?.name && !!r.rules[0]?.why;
  const told = (r) => (r.card ? r.rules.map(x => `${x.name}: ${x.why}`).join(" | ")
    : `not refused (${r.said.map(s => s.rule.id).join(", ") || "no rule spoke"})`);

  const varek = firstActor(VAREK);
  const holdPerson = varek ? [...varek.items].find(i => i.type === "spell" && /^hold person\b/i.test(i.name)) : null;
  const holdSave = firstOfType(holdPerson, "save");
  const wolf = firstActor("Wolf");

  try {
    // ── 1. A paralyzed caster ──
    if (holdSave) {
      varek.statuses.add("paralyzed");
      let r;
      try { r = await pressGate(holdSave); } finally { varek.statuses.delete("paralyzed"); }
      check("1. a paralyzed caster is refused by the one gate, by its rule's name (Phase 2)",
        refusedOnlyBy(r, "cannot-act"), `${varek.name}, ${holdPerson.name}: ${told(r)}`);
    } else check("1. a paralyzed caster is refused by the one gate (Phase 2)", null, "Varek has no Hold Person");

    // ── 2. A spell cast in armor the caster cannot wear ──
    // A character with no heavy armor proficiency, in plate, casting a levelled
    // spell the gate otherwise lets through.
    const armorProfs = (a) => {
      const v = a.system?.traits?.armorProf?.value;
      return new Set(Array.isArray(v) ? v : (v instanceof Set ? [...v] : []));
    };
    const wearers = [...ACTORS.values()].filter(a => a.type === "character" && !armorProfs(a).has("hvy"))
      .sort((x, y) => (y.name === "Kasimir Velikov") - (x.name === "Kasimir Velikov"));
    let wearer = null, wearerSpell = null, wearerAct = null;
    for (const a of wearers) {
      for (const sp of [...a.items].filter(i => i.type === "spell" && Number(i.system?.level) > 0)) {
        const act = actsOf(sp)[0];
        if (act && !(await judged(act)).length) { wearer = a; wearerSpell = sp; wearerAct = act; break; }
      }
      if (wearerAct) break;
    }
    if (wearerAct) {
      const plate = { id: "replay-plate", name: "Plate Armor", type: "equipment",
        system: { equipped: true, armor: { type: "heavy" } } };
      wearer.items.set(plate.id, plate);
      let r;
      try { r = await pressGate(wearerAct); } finally { wearer.items.delete(plate.id); }
      check("2. a spell cast in armor the caster cannot wear is refused, by its rule's name (Phase 2)",
        refusedOnlyBy(r, "armor"), `${wearer.name} in plate, no heavy armor proficiency, ${wearerSpell.name}: ${told(r)}`);
    } else check("2. a spell cast in armor the caster cannot wear is refused (Phase 2)", null,
      "no character without heavy armor proficiency has a levelled spell the gate otherwise allows");

    // ── 3. A second levelled spell in one turn ──
    if (holdSave) {
      const keep = { combats: game.combats, combat: game.combat, getFlag: varek.getFlag,
        rule: SETTINGS.get("ace-qol.bonusActionSpellRule"), strict: SETTINGS.get("ace-qol.bonusActionSpellStrict") };
      game.combats = { contents: [{ started: true, combatants: { contents: [{ actorId: varek.id, actor: varek }] } }] };
      game.combat = { started: true, round: 1, turn: 0 };
      // Misty Step, a levelled bonus-action spell, already cast this turn.
      varek.getFlag = (s, k) => ((s === "ace-qol" && k === "bonusSpellTurn")
        ? { castCount: 1, hadBonusActionLeveled: true, hadActionSpell: false, lastSpellName: "Misty Step", lastCastType: "bonus" }
        : keep.getFlag(s, k));
      // The rule as it ships: on, and strict. His own world's values are shown beside the verdict.
      SETTINGS.set("ace-qol.bonusActionSpellRule", true);
      SETTINGS.set("ace-qol.bonusActionSpellStrict", true);
      let r;
      try { r = await pressGate(holdSave); }
      finally {
        game.combats = keep.combats; game.combat = keep.combat; varek.getFlag = keep.getFlag;
        for (const [k, v] of [["ace-qol.bonusActionSpellRule", keep.rule], ["ace-qol.bonusActionSpellStrict", keep.strict]]) {
          if (v === undefined) SETTINGS.delete(k); else SETTINGS.set(k, v);
        }
      }
      check("3. a second levelled spell in one turn is refused, by its rule's name (Phase 2)",
        refusedOnlyBy(r, "bonus-action-spell"), `${varek.name}, ${holdPerson.name} after Misty Step: ${told(r)}`
          + ` (his world: the rule ${keep.rule ?? "unset, so on"}, strict ${keep.strict ?? "unset, so on"})`);
    }

    // ── 4. Hold Vampires with no vampire in reach ──
    const syrax = firstActor("Syrax Razeson");
    const symbol = syrax ? [...syrax.items].find(i => /holy symbol of ravenkind/i.test(i.name)) : null;
    const holdVampires = actsOf(symbol).find(a => /hold\s*vampires/i.test(a.name ?? "")) ?? null;
    if (holdVampires && wolf) {
      canvas.tokens.placeables.push(tokenOf(syrax), tokenOf(wolf));
      let r;
      try { r = await pressGate(holdVampires); } finally { canvas.tokens.placeables.length = 0; }
      check("4. Hold Vampires with no vampire in reach is refused, by its rule's name (Phase 2)",
        refusedOnlyBy(r, "holy-symbol"), `${syrax.name}, with only a Wolf on the map: ${told(r)}`);
    } else check("4. Hold Vampires with no vampire in reach is refused (Phase 2)", null, "no Holy Symbol's Hold Vampires, or no Wolf");

    // ── 5. Hold Person on a non-humanoid ──
    if (holdSave && wolf) {
      const r = await pressGate(holdSave, [tokenOf(wolf)]);
      check("5. Hold Person on a non-humanoid is refused, by its rule's name (Phase 2)",
        refusedOnlyBy(r, "creature-type"), `${varek.name} at a Wolf: ${told(r)}`);
    }

    // ── 6. An ordinary revive on a creature killed for good ──
    // A revive the gate lets through on a creature that is only dead, then the
    // same press on one killed for good.
    const ORDINARY = /^(revivify|raise dead|resurrection|reincarnate)\b/i;
    const victim = [...ACTORS.values()].find(a => a.type === "npc" && String(a.system?.details?.type?.value ?? "") === "humanoid");
    const revivers = [...ACTORS.values()]
      .map(a => ({ a, it: [...a.items].find(i => i.type === "spell" && ORDINARY.test(i.name)) }))
      .filter(x => x.it).sort((x, y) => (y.a.name === VAREK) - (x.a.name === VAREK));
    let reviver = null, reviveAct = null;
    if (victim) {
      for (const x of revivers) {
        const act = actsOf(x.it)[0];
        if (act && !(await judged(act, [tokenOf(victim, { [MOD]: { isDead: true } })])).length) { reviver = x; reviveAct = act; break; }
      }
    }
    if (reviveAct) {
      const dead = tokenOf(victim, { [MOD]: { isDead: true, permanentlyDead: true, deathReason: "beheaded by a vorpal sword" } });
      const r = await pressGate(reviveAct, [dead]);
      check("6. an ordinary revive on a creature killed for good is refused, by its rule's name (Phase 2)",
        refusedOnlyBy(r, "killed-for-good"), `${reviver.a.name}'s ${reviver.it.name} on ${victim.name}: ${told(r)}`);
    } else check("6. an ordinary revive on a creature killed for good is refused (Phase 2)", null,
      victim ? "no revive spell the gate otherwise allows" : "no humanoid creature to revive");

    // ── A heal pressed with nobody targeted still reaches the heal picker ──
    // Before the gate, the heal pipeline took a heal over before the target
    // check ever ran. The gate's first cut refused such a heal ("select a
    // target first"); with the heal pipeline off, dnd5e's own flow runs and the
    // check stands, as it did before.
    {
      const heals = [];
      for (const a of ACTORS.values()) {
        for (const it of a.items) {
          if (it.type !== "spell") continue;
          for (const act of actsOf(it)) if (act.type === "heal" && !act.target?.template?.type) heals.push({ a, it, act });
        }
      }
      const refusedHeals = async () => {
        const out = [];
        for (const h of heals) {
          const said = await judged(h.act);
          if (said.some(s => s.rule.id === "targets" && s.verdict.refuse)) out.push(`${h.a.name} / ${h.it.name}`);
        }
        return out;
      };
      const keepHeal = SETTINGS.get("ace-qol.enableHealPipeline");
      let whenOn = [], whenOff = [];
      try {
        SETTINGS.set("ace-qol.enableHealPipeline", true);
        whenOn = await refusedHeals();
        SETTINGS.set("ace-qol.enableHealPipeline", false);
        whenOff = await refusedHeals();
      } finally {
        if (keepHeal === undefined) SETTINGS.delete("ace-qol.enableHealPipeline");
        else SETTINGS.set("ace-qol.enableHealPipeline", keepHeal);
      }
      check("a heal pressed with nobody targeted still reaches the heal picker; the gate refuses it only with the heal pipeline off, as before (Phase 2)",
        heals.length ? (whenOn.length === 0 && whenOff.length > 0) : null,
        heals.length ? `${heals.length} heal casts; refused with the heal pipeline on: ${whenOn.length}`
          + (whenOn.length ? ` (${whenOn.slice(0, 3).join("; ")})` : "")
          + `; with it off: ${whenOff.length}, e.g. ${whenOff.slice(0, 2).join("; ")}` : "no heal spell in this world");
    }

    // ── The refusal notice says why, in plain words ──
    check("the refusal notice says why in plain words, and where it went (Phase 2)",
      toasts.some(t => /was not used\./.test(t) && /Do it anyway is on the card/.test(t)),
      toasts.length ? toasts[toasts.length - 1] : "no notice was shown");

    // ── The old separate press hooks are gone ──
    {
      const read = (f) => readFileSync(`${ROOT}/Data/modules/ace-qol/scripts/${f}`, "utf8");
      const HOOK = /Hooks\.on\(\s*["']dnd5e\.preUseActivity["']/;
      const homes = ["combat-context.mjs", "armor-prof-spell-block.mjs", "bonus-spell-rule.mjs", "holy-symbol.mjs", "engagement-gate.mjs"];
      const still = homes.filter(f => HOOK.test(read(f)));
      const entry = read("ace-qol.mjs");
      if (/STRICT_RAW_REVIVES|WEAKER_REVIVES/.test(entry)) still.push("the revive hook in ace-qol.mjs");
      if (/EngagementGate\.registerHooks/.test(entry)) still.push("the engagement hook in ace-qol.mjs");
      check("the old separate press hooks are gone: can't act, armor, bonus action, Holy Symbol, engagement, revive (Phase 2)",
        !still.length, still.length ? `still hooked: ${still.join(", ")}` : "none of the six registers a press hook any more");
      const reading = entry.indexOf("ActionInterceptor.register()");
      const gateAt = entry.indexOf("PressGate.register()");
      const between = reading >= 0 && gateAt > reading ? entry.slice(reading, gateAt).replace(/\/\/.*$/gm, "") : null;
      check("the one gate registers straight after the reading, before any other handler may cancel a press (Phase 2)",
        between !== null && !/Hooks\.on\(|preUseActivity/.test(between),
        between === null ? "the gate is not registered after the reading" : "at init, right behind the reading");
    }

    // ── Do it anyway ──
    if (holdSave && wolf) {
      const PLAYER = { id: "replay-player", isGM: false, name: "a player" };
      const keep = { users: game.users, messages: game.messages, use: holdSave.use, log: console.log, user: game.user };
      const cards = new Map();
      game.users = Object.assign([GM, PLAYER], { activeGM: GM, get: (id) => [GM, PLAYER].find(u => u.id === id) ?? null });
      game.messages = { get: (id) => cards.get(id) ?? null };
      const asCard = (data, id) => {
        const card = { id, ...data, flags: JSON.parse(JSON.stringify(data.flags ?? {})),
          update: async (u) => {
            if (u.content !== undefined) card.content = u.content;
            for (const [scope, v] of Object.entries(u.flags ?? {})) {
              card.flags[scope] = { ...(card.flags[scope] ?? {}), ...JSON.parse(JSON.stringify(v)) };
            }
            return card;
          } };
        cards.set(id, card);
        return card;
      };
      const wolfTok = tokenOf(wolf);
      const presses = [];
      // dnd5e's use(), as far as the gate sees it: the press, and when it goes ahead, its use.
      holdSave.use = async () => {
        const messageConfig = {};
        const user = game.user;
        user.targets = new Set([wolfTok]);
        let answer;
        try { answer = PressGate.onPress(holdSave, {}, {}, messageConfig); } finally { delete user.targets; }
        presses.push({ answer, messageConfig, by: user.id });
        if (answer !== false) await PressGate.onUsed(holdSave, {});
        return answer;
      };
      const statusOf = (card) => ({ flags: { [MOD]: { gate: { status: card.flags[MOD].gate.status } } } });
      const logs = [];
      // The gate's log and its warnings, held for the verdict rather than printed.
      const keepWarnLog = console.warn;
      const capture = async (fn) => {
        console.log = console.warn = (...a) => { logs.push(a.map(String).join(" ")); };
        try { return await fn(); } finally { console.log = keep.log; console.warn = keepWarnLog; }
      };
      try {
        // The GM's own press.
        const first = await pressGate(holdSave, [wolfTok]);
        const card = first.card ? asCard(first.card, "replay-gate-card") : null;
        let overruled = false, afterPlayer = -1;
        if (card) {
          await capture(async () => {
            overruled = await PressGate.doItAnyway(card);
            await PressGate._onCardUpdated(card, statusOf(card), {}, PLAYER.id);
            afterPlayer = presses.length;
            await PressGate._onCardUpdated(card, statusOf(card), {}, GM.id);
          });
        }
        const through = presses[0] ?? null;
        const stamp = through?.messageConfig?.data?.flags?.[MOD]?.gateOverruled ?? null;
        const flavor = String(through?.messageConfig?.data?.flavor ?? "");
        const gate = card?.flags?.[MOD]?.gate ?? {};
        check("Do it anyway is on the card for the GM only, and only a GM's overrule presses again: a player's mark does nothing (Phase 2)",
          first.answer === false && !!card && /class="ace-qol-gm-only"/.test(first.card.content)
            && /data-action="aceQolGateAnyway"/.test(first.card.content) && overruled === true && afterPlayer === 0,
          `refused: ${first.answer === false}; the button GM-only: ${/ace-qol-gm-only/.test(first.card?.content ?? "")}; `
            + `overruled: ${overruled}; presses after a player's mark: ${afterPlayer}`);
        check("Do it anyway lets that same press through, with the overrule on its card, logged (Phase 2)",
          presses.length === 1 && through.answer !== false && stamp?.byName === "GM"
            && /ACE was overruled by GM/.test(flavor) && /Creature type/.test(flavor)
            && gate.status === "used" && gate.overruledByName === "GM" && /Overruled by GM, and used/.test(card.content)
            && logs.some(l => /OVERRULED by GM/.test(l)) && logs.some(l => /was used, as GM ruled/.test(l)),
          `pressed again: ${presses.length}, ${through ? (through.answer === false ? "refused" : "went through") : "never"}; `
            + `usage message: ${flavor.replace(/<[^>]+>/g, "") || "no note"}; refusal card: ${gate.status}, by ${gate.overruledByName ?? "nobody"}; `
            + `logged: ${logs.filter(l => /OVERRULED|was used, as/.test(l)).length} lines`);
        const again = await pressGate(holdSave, [wolfTok]);
        check("once: the same press, pressed after it was used, is refused again (Phase 2)",
          refusedOnlyBy(again, "creature-type") && !PressGate._passes.has(holdSave.uuid), told(again));

        // A player's press goes to the GM to approve, and comes back to the player's side.
        game.user = PLAYER;
        const theirs = await pressGate(holdSave, [wolfTok]);
        const noticed = toasts[toasts.length - 1] ?? "";
        const card2 = theirs.card ? asCard(theirs.card, "replay-gate-card-2") : null;
        const before = presses.length;
        if (card2) {
          await capture(async () => {
            game.user = GM;
            await PressGate.doItAnyway(card2);
            game.user = PLAYER;
            await PressGate._onCardUpdated(card2, statusOf(card2), {}, GM.id);
          });
        }
        const back = presses[before] ?? null;
        check("a player's refused press goes to the GM to approve, and the GM's overrule presses it on the player's side (Phase 2)",
          theirs.answer === false && JSON.stringify(theirs.card?.whisper) === JSON.stringify([GM.id])
            && theirs.card?.flags?.[MOD]?.gate?.byGM === false && /gone to the GM to approve/.test(noticed)
            && back?.by === PLAYER.id && back.answer !== false,
          `whispered to: ${JSON.stringify(theirs.card?.whisper)}; notice: ${noticed}; `
            + `pressed again by: ${back?.by ?? "nobody"}, ${back ? (back.answer === false ? "refused" : "went through") : ""}`);
      } finally {
        game.users = keep.users; game.messages = keep.messages; holdSave.use = keep.use;
        console.log = keep.log; game.user = keep.user;
      }
    }
  } finally {
    ui.notifications.warn = keepWarn;
  }
}

/* ── PHASE 3: ATTACKS ON THE ROAD ───────────────────────────────────────── */
// Johnny, 2026-09-14: "PHASE 3 — ATTACKS ONLY. Then stop." Done when the replay
// pins, on his world: 1. a mundane weapon attack (sheet recipe), hit damage
// through HpDoor; 2. a weapon with extra damage on the item, the extra dice on the
// recipe, not a side engine; 3. a spell attack whose recipe is the book's, the
// sheet the instance, the actor item not written; 4. a crit, onCrit extras only on
// a crit; 5. a hit-then-save rider as recipe.then, a new run on the same road that
// whatLands owns; 6. cards in files touched go through CardDoor; 7. dice wait in
// the door if thrown, land at once if not.
console.log(`\nPHASE 3: ATTACKS ON THE ROAD`);
{
  const MOD = "ace-qol";
  const RULE = "maxPlusRoll";
  const actsOf = (it) => [...(it?.system?.activities ?? [])];
  const attackOf = (it) => actsOf(it).find(a => a.type === "attack") ?? null;
  const hitOn = (extra = {}) => ({ hitResult: "hit", attacker: { bonuses: [] }, damageModifiers: {}, ...extra });
  const rolledFor = async (it, isCrit = false) => {
    let comps = [];
    await quiet(async () => {
      comps = await DamageCalculator.rollDamageComponents(it, it.actor, hitOn(), isCrit, RULE, attackOf(it)?.id ?? null);
    });
    return comps;
  };
  const recipeOf = async (it) => {
    let built = null;
    await quiet(async () => {
      await loadBookFor(it, { actor: it.actor });
      built = recipeForActivity(it, attackOf(it), { actor: it.actor });
    });
    return built;
  };
  const dmgTypes = (outs) => (outs ?? []).filter(o => o.kind === "damage").map(o => (o.types ?? []).join("/") || "untyped");
  const dmgSaid = (outs) => (outs ?? []).filter(o => o.kind === "damage")
    .map(o => `${o.formula} ${(o.types ?? []).join("/") || "untyped"}`).join(", ") || "-";
  const said = (comps) => comps.map(c => `${c.name}: ${c.formula} ${c.type} = ${c.total}`).join("; ") || "nothing";

  // ── 1. A mundane weapon attack from its own sheet; its hit through the hit-point door ──
  const berserker = firstActor("Berserker");
  const axe = berserker ? [...berserker.items].find(i => i.type === "weapon" && /^greataxe$/i.test(i.name)) : null;
  if (axe && attackOf(axe)) {
    const built = await recipeOf(axe);
    const comps = await rolledFor(axe);
    const own = comps.filter(c => c.name === axe.name);
    // APPLY on its damage card, as the GM presses it, on a stand-in creature.
    const hp = { value: 30, max: 30, temp: 0 };
    const victim = { id: "replay-hit-target", name: "a test creature", type: "npc", system: { attributes: { hp }, traits: {} },
      statuses: new Set(), effects: new Collection(), getFlag: () => undefined,
      update: async (u) => {
        if ("system.attributes.hp.value" in u) hp.value = u["system.attributes.hp.value"];
        if ("system.attributes.hp.temp" in u) hp.temp = u["system.attributes.hp.temp"];
        return victim;
      } };
    const total = own.reduce((s, c) => s + c.total, 0);
    const card = { id: "replay-damage-card", update: async () => card, flags: { [MOD]: {
      type: "damageResult", itemUuid: axe.uuid, actorId: berserker.id,
      damageResults: [{ targetId: victim.id, tokenId: "tok-victim", tokenDocId: "tok-victim", name: victim.name, totalFinal: total,
        components: own.map(c => ({ name: c.name, type: c.type, raw: c.total, final: c.total, modifier: "normal" })) }] } } };
    const doorCalls = [], sent = [];
    const keepDoor = HpDoor.damage, keepCallAll = Hooks.callAll;
    let applyErr = null;
    HpDoor.damage = async (...a) => { doorCalls.push(a); return keepDoor.apply(HpDoor, a); };
    Hooks.callAll = (name, payload) => { sent.push({ name, payload }); };
    ACTORS.set(victim.id, victim);
    try { await quiet(async () => { await DamageApplicator.applyDamage(card); }); }
    catch (err) { applyErr = err; }
    finally { HpDoor.damage = keepDoor; Hooks.callAll = keepCallAll; ACTORS.delete(victim.id); }
    const sig = sent.find(s => s.name === `${MOD}.damageApplied`)?.payload ?? null;
    check("1. a mundane weapon attack lands its sheet recipe's damage, and APPLY puts it on through the hit-point door (Phase 3)",
      !applyErr && built?.recipe?.evidence?.includes("item") && !built?.book && own.length > 0
        && JSON.stringify(own.map(c => c.type)) === JSON.stringify(dmgTypes(built.recipe.onHit))
        && doorCalls.length === 1 && hp.value === 30 - total && sig?.sourceItem === axe && sig?.sourceActor === berserker,
      applyErr ? `APPLY threw: ${applyErr?.message ?? applyErr}`
        : `${berserker.name}'s ${axe.name}: recipe on hit ${dmgSaid(built?.recipe?.onHit)} (from ${built?.book ? "the book" : "the sheet"}); `
          + `the hit: ${said(comps)}; through the door ${doorCalls.length}x, hit points 30 to ${hp.value}; `
          + `signal: ${sig ? `${sig.hpDelta} moved, dealt by ${sig.sourceActor?.name ?? "nobody"} with ${sig.sourceItem?.name ?? "nothing"}` : "none"}`);
  } else check("1. a mundane weapon attack (Phase 3)", null, "no Berserker's Greataxe in this world");

  // ── 2. A weapon's extra damage: on its recipe, from the item's own dice ──
  const firaxis = firstActor("Firaxis Greenbeard");
  const brand = firaxis ? [...firaxis.items].find(i => i.type === "weapon" && /^frost brand/i.test(i.name)) : null;
  if (brand && attackOf(brand)) {
    const built = await recipeOf(brand);
    const comps = await rolledFor(brand);
    const own = comps.filter(c => c.name === brand.name);
    const others = comps.filter(c => c.name !== brand.name);
    const onHit = dmgTypes(built?.recipe?.onHit);
    check("2. a weapon's extra damage is on its recipe and lands from the item's own dice, no side engine: the Frost Brand's cold (Phase 3)",
      onHit.length >= 2 && onHit.includes("cold") && JSON.stringify(own.map(c => c.type)) === JSON.stringify(onHit) && !others.length,
      `${firaxis.name}'s ${brand.name}: recipe on hit ${dmgSaid(built?.recipe?.onHit)}; the hit: ${said(comps)}`);
  } else check("2. a weapon with extra damage on the item (Phase 3)", null, "no Frost Brand in this world");

  // ── 3. A spell attack: the book is the recipe, the sheet this cast, the item unwritten ──
  const boltCaster = firstActor(VAREK);
  const bolt = boltCaster ? [...boltCaster.items].find(i => i.type === "spell" && /^fire bolt$/i.test(i.name)
    && String(i.system?.source?.rules) === "2024") : null;
  if (bolt && attackOf(bolt)) {
    const before = JSON.stringify(bolt._source);
    const built = await recipeOf(bolt);
    const comps = await rolledFor(bolt);
    const after = JSON.stringify(bolt._source);
    const own = comps.filter(c => c.name === bolt.name);
    check("3. a spell attack takes its recipe from the book and its dice from the sheet, and the item is not written: Fire Bolt (Phase 3)",
      !!built?.book && built.recipe.evidence.includes("book") && dmgTypes(built.recipe.onHit).join() === "fire"
        && own.length === 1 && own[0].type === "fire" && before === after,
      `${boltCaster.name}'s ${bolt.name}: recipe from ${built?.book?.pack ?? "the sheet"}, on hit ${dmgSaid(built?.recipe?.onHit)}; `
        + `the hit: ${said(comps)}; the item untouched: ${before === after}`);
  } else check("3. a spell attack (Phase 3)", null, "Varek has no 2024 Fire Bolt");

  // ── 4. A crit: the item's crit dice from its recipe, only on a crit ──
  const king = firstActor("King");
  const vicious = king ? [...king.items].find(i => i.type === "weapon" && /^vicious greatsword$/i.test(i.name)) : null;
  if (vicious && attackOf(vicious)) {
    const built = await recipeOf(vicious);
    const onHitComps = await rolledFor(vicious, false);
    const onCritComps = await rolledFor(vicious, true);
    const critRows = (cs) => cs.filter(c => / \(critical\)$/.test(c.name));
    const wordRows = (cs) => cs.filter(c => / \(crit bonus\)$/.test(c.name));
    const extra = critRows(onCritComps)[0];
    // Every item of his with crit dice: what its data says, and what ACE's words
    // reader read as a crit bonus. Before Phase 3 the words' reading was what
    // landed; now the data does, and the words stand down.
    const critInfo = [...ACTORS.values()].flatMap(a => [...a.items]
      .filter(i => actsOf(i).some(x => x.type === "attack" && String(x.damage?.critical?.bonus ?? "").trim()))
      .map(i => {
        const data = actsOf(i).filter(x => x.type === "attack")
          .map(x => String(x.damage?.critical?.bonus ?? "").trim()).filter(Boolean);
        let words = [];
        try {
          words = (DescriptionParser.parse(i).bonusDamage ?? []).filter(b => b.triggersOnCrit)
            .map(b => `${b.formula}${b.requiresCreatureTypes?.length ? ` against ${b.requiresCreatureTypes.join("/")}` : ""}`);
        } catch (_) { words = ["(could not be read)"]; }
        return `${a.name}'s ${i.name}: data ${data.join(" / ")}, words ${words.join(" / ") || "none"}`;
      }));
    check("4. a crit adds the item's crit dice from its recipe, once; a plain hit does not: King's Vicious Greatsword (Phase 3)",
      dmgTypes(built?.recipe?.onCrit).length === 1 && !critRows(onHitComps).length && critRows(onCritComps).length === 1
        && extra?.formula === "2d6" && extra?.total === 2 && extra?.type === "slashing" && !wordRows(onCritComps).length,
      `recipe on crit ${dmgSaid(built?.recipe?.onCrit)}; a hit: ${said(onHitComps)}; a crit: ${said(onCritComps)}; `
        + `every item with crit dice: ${critInfo.join("; ")}`);
  } else check("4. a crit (Phase 3)", null, "no King's Vicious Greatsword in this world");

  // ── 5. The claw's poison save: the recipe's `then`, a new run on the save engine ──
  const neferon = firstActor("Neferon");
  const claws = neferon ? [...neferon.items].find(i => i.name === "Claws") : null;
  const goblin = [...ACTORS.values()].find(a => a.type === "npc" && /^goblin$/i.test(a.name)) ?? null;
  if (claws && goblin) {
    let road = null;
    await quiet(async () => { road = await DamageCalculator._attackRoad(claws, neferon, null); });
    const then = road?.recipe?.then?.[0] ?? null;
    const calls = [];
    const keep = { aceQol: game.aceQol, scenes: game.scenes.get, delay: SETTINGS.get("ace-qol.npcDamageAnimationDelay") };
    const tokenDoc = { id: "tok-goblin", actor: goblin, parent: { id: "replay-scene" } };
    tokenDoc.object = { id: tokenDoc.id, document: tokenDoc, actor: goblin, scene: { id: "replay-scene" }, name: goblin.name };
    game.aceQol = { ...(keep.aceQol ?? {}), saveEngine: { postSaveCard: async (...a) => { calls.push(a); } } };
    game.scenes.get = (id) => (id === "replay-scene" ? { id, tokens: { get: (t) => (t === tokenDoc.id ? tokenDoc : null) } } : null);
    SETTINGS.set("ace-qol.npcDamageAnimationDelay", 0);
    const before = posted.length;
    let dice = [], runErr = null;
    try {
      await quiet(async () => {
        await PostHitSaves.checkPostHitEffects(claws, neferon, [{ hitResult: "hit", actorId: goblin.id, tokenDocId: tokenDoc.id,
          sceneId: "replay-scene", name: goblin.name, img: "", targetActor: { id: goblin.id } }], []);
        const engine = Object.create(SaveEngine.prototype);
        dice = await engine._rollSpellDamage(claws, neferon, { recipe: then, activityId: null });
      });
    } catch (err) { runErr = err; }
    finally {
      game.aceQol = keep.aceQol; game.scenes.get = keep.scenes;
      if (keep.delay === undefined) SETTINGS.delete("ace-qol.npcDamageAnimationDelay");
      else SETTINGS.set("ace-qol.npcDamageAnimationDelay", keep.delay);
    }
    const ownCard = posted.slice(before).find(p => p?.flags?.[MOD]?.type === "postHitSave");
    const opts = calls[0]?.[3] ?? {};
    const rolledNow = dice.map(d => ({ total: d.total, type: d.type }));
    const failed = then ? whatLands(then, { passed: false, rolled: rolledNow }) : null;
    const made = then ? whatLands(then, { passed: true, rolled: rolledNow }) : null;
    check("5. a claw's poison save is the recipe's `then`, a new run on the save engine that whatLands decides: Neferon's Claws (Phase 3)",
      !runErr && isFollowUp(then) && then.decidedBy?.ability === "con" && then.decidedBy?.dc === 14
        && calls.length === 1 && JSON.stringify(opts.recipe) === JSON.stringify(then)
        && opts.saveAbility === "con" && opts.saveDC === 14 && opts.activityId === null && !ownCard
        && dice.length === 1 && dice[0].type === "poison" && dice[0].total === 3
        && failed?.damage?.[0]?.amount === 3 && made?.damage?.[0]?.amount === 1,
      runErr ? `threw: ${runErr?.message ?? runErr}`
        : `then: ${then ? `${then.decidedBy.ability} DC ${then.decidedBy.dc}, on a failure ${dmgSaid(then.onFail)}` : "none"}; `
          + `handed to the save engine ${calls.length}x${ownCard ? ", and its own card posted as well" : ""}; `
          + `its dice: ${dice.map(d => `${d.formula} ${d.type} = ${d.total}`).join(", ") || "none"}; `
          + `a failure takes ${failed?.damage?.[0]?.amount ?? "?"}, a success ${made?.damage?.[0]?.amount ?? "?"}`);
  } else check("5. a hit-then-save rider (Phase 3)", null, "no Neferon's Claws or Goblin in this world");

  // ── 6. Every card in the files Phase 3 touched goes through the card door ──
  {
    const code = (f) => readFileSync(`${ROOT}/Data/modules/ace-qol/scripts/${f}`, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    const touched = ["damage-card-renderer.mjs", "damage-applicator.mjs", "post-hit-saves.mjs", "damage-calculator.mjs",
      "save-engine.mjs", "road/what-lands.mjs", "inference/recipe.mjs", "inference/action-facts.mjs",
      // Phase 3, the live hit on its recipe (0.34.20):
      "merge-card.mjs", "damage-engine.mjs", "ace-qol.mjs"];
    const raw = touched.map(f => [f, (code(f).match(/ChatMessage\.create\(/g) ?? []).length]).filter(([, n]) => n);
    const door = (code("road/doors.mjs").match(/ChatMessage\.create\(/g) ?? []).length;
    check("6. every card in the files Phase 3 touched goes through the card door; no new raw card (Phase 3)",
      !raw.length && door === 1,
      raw.length ? `raw cards left: ${raw.map(([f, n]) => `${f} ${n}`).join(", ")}`
        : `none left in ${touched.length} files; the card door is the one place a card is created (${door})`);
  }

  // ── 7. The dice: waited for in the door when thrown; landing at once when not ──
  if (axe) {
    const { safeShowForRoll } = await import(`${MODULE}/scripts/dsn-utils.mjs`);
    const spied = [];
    const keepPost = CardDoor.post;
    let cardErr = null;
    CardDoor.post = async (data, o = {}) => {
      spied.push({ type: data?.flags?.[MOD]?.type ?? null, dice: o?.dice ?? false });
      return keepPost.call(CardDoor, data, o);
    };
    try {
      await quiet(async () => {
        await DamageCardRenderer.postDamageButton(axe, berserker, [hitOn({ name: "a test creature" })], [], attackOf(axe)?.id ?? null);
        await DamageCardRenderer.postDamageCard(axe, berserker, [{
          target: { name: "a test creature", img: "", currentHP: 30, maxHP: 30 },
          targetToken: { id: "tok-victim", document: { id: "tok-victim" } }, targetActor: { id: "replay-hit-target" },
          isCrit: false, totalRaw: 1, totalFinal: 1,
          components: [{ name: axe.name, type: "slashing", raw: 1, final: 1, total: 1, modifier: "normal", formula: "1d12" }] }], RULE);
      });
    } catch (err) { cardErr = err; }
    finally { CardDoor.post = keepPost; }
    const button = spied.find(s => s.type === "damageButton"), result = spied.find(s => s.type === "damageResult");
    // And the door itself, with dice that take a moment to land.
    const keepDice = game.dice3d, keepCreate = ChatMessage.create;
    const thrown = { n: 0, landed: 0 };
    game.dice3d = { isEnabled: () => true,
      showForRoll: () => { thrown.n++; return new Promise(r => setTimeout(() => { thrown.landed++; r(true); }, 15)); } };
    let rollingAtCreate = null, waited = null, atOnce = null;
    ChatMessage.create = async (data) => { rollingAtCreate = thrown.n - thrown.landed; return keepCreate(data); };
    try {
      await quiet(async () => {
        safeShowForRoll({ total: 3 }, "the damage dice");
        await CardDoor.post({ content: "a damage card" }, { dice: true });
        waited = rollingAtCreate;
        safeShowForRoll({ total: 3 }, "someone else's dice");
        await CardDoor.post({ content: "a ROLL DAMAGE button" });
        atOnce = rollingAtCreate;
      });
      await new Promise(r => setTimeout(r, 40));
    } finally { game.dice3d = keepDice; ChatMessage.create = keepCreate; }
    check("7. the damage card waits in the card door for its thrown dice; the ROLL DAMAGE card, with none thrown, lands at once (Phase 3)",
      !cardErr && button?.dice === false && result?.dice === true && waited === 0 && atOnce === 1,
      cardErr ? `a card threw: ${cardErr?.message ?? cardErr}`
        : `ROLL DAMAGE card: dice ${button?.dice}; damage card: dice ${result?.dice}; `
          + `dice still rolling when the damage card was created: ${waited}; when the button was: ${atOnce}`);
  }

  // ── 8. The live hit lands its recipe's onHit: what its words give the hit, and nothing else ──
  // Johnny, 2026-09-14: "The live hit must use recipe onHit / onCrit for what dice
  // and extras land." The Neogi's words: "Hit: 1d6 + 3 piercing damage plus 4d6
  // poison damage"; the damage roll's old guess left the poison off every bite.
  // The Aurochs's: an extra 2d8 only after it moved 20 feet straight at the target.
  {
    const itemOf = (actorName, itemName) => [...ACTORS.values()].filter(a => a.name === actorName)
      .map(a => a.items.find(i => i.name === itemName)).find(Boolean) ?? null;
    const neogiBite = itemOf("Neogi", "Bite"), aurochsGore = itemOf("Aurochs", "Gore");
    if (neogiBite && aurochsGore) {
      const nBuilt = await recipeOf(neogiBite), nComps = await rolledFor(neogiBite);
      const aBuilt = await recipeOf(aurochsGore), aComps = await rolledFor(aurochsGore);
      const nOwn = nComps.filter(c => c.name === neogiBite.name), aOwn = aComps.filter(c => c.name === aurochsGore.name);
      const aNote = (aBuilt?.recipe?.onHit ?? []).find(o => o.kind === "note" && /2d8 piercing/.test(o.condition?.key ?? ""));
      check("8. the live hit lands its recipe's onHit: the Neogi's poison its words put on the hit, not the Aurochs's charge (Phase 3)",
        JSON.stringify(nOwn.map(c => c.type).sort()) === JSON.stringify(["piercing", "poison"])
          && nOwn.every(c => c.recipePart === "onHit")
          && aOwn.length === 1 && aOwn[0].type === "piercing" && aOwn[0].recipePart === "onHit" && !!aNote,
        `Neogi's Bite: recipe on hit ${dmgSaid(nBuilt?.recipe?.onHit)}; the hit: ${said(nComps)}. `
          + `Aurochs's Gore: recipe on hit ${dmgSaid(aBuilt?.recipe?.onHit)}; the hit: ${said(aComps)}; `
          + `the GM is told: ${aNote ? String(aNote.condition.key).slice(0, 90) : "nothing"}`);
    } else check("8. the live hit lands its recipe's onHit (Phase 3)", null, "no Neogi's Bite or Aurochs's Gore in this world");
  }

  // ── 9. APPLY asks the attack's recipe, not only the card ──
  // Johnny: "APPLY must not take 'whatever the card listed' as the only truth."
  // The Berserker's Greataxe through ROLL DAMAGE and the damage card the way the
  // table posts them, then APPLY; then the same card with a crit row put on a
  // plain hit, which the recipe does not land.
  if (axe) {
    const hp9 = { value: 30, max: 30, temp: 0 };
    const victim9 = { id: "replay-apply-target", name: "a test creature", type: "npc", documentName: "Actor",
      system: { attributes: { hp: hp9 }, traits: {} }, statuses: new Set(), effects: new Collection(), getFlag: () => undefined,
      update: async (u) => {
        if ("system.attributes.hp.value" in u) hp9.value = u["system.attributes.hp.value"];
        if ("system.attributes.hp.temp" in u) hp9.temp = u["system.attributes.hp.temp"];
        return victim9;
      } };
    const hit9 = hitOn({ name: victim9.name, target: { name: victim9.name, img: "", currentHP: 30, maxHP: 30 },
      targetActor: victim9, targetToken: { id: "tok-apply", document: { id: "tok-apply" } } });
    const spied9 = [];
    const keepPost9 = CardDoor.post;
    let err9 = null;
    CardDoor.post = async (data, o = {}) => { spied9.push(data); return keepPost9.call(CardDoor, data, o); };
    ACTORS.set(victim9.id, victim9);
    try {
      await quiet(async () => {
        await DamageCardRenderer.postDamageButton(axe, berserker, [hit9], [], attackOf(axe)?.id ?? null);
        const btn = spied9.find(d => d?.flags?.[MOD]?.type === "damageButton");
        if (!btn) throw new Error("no ROLL DAMAGE card was posted");
        await DamageCardRenderer.postPreRolledDamageCard({ id: "replay-roll-button", flags: btn.flags, speaker: {} },
          btn.flags[MOD], { skipDice: true });
      });
    } catch (err) { err9 = err; }
    finally { CardDoor.post = keepPost9; }
    const f9 = spied9.find(d => d?.flags?.[MOD]?.type === "damageResult")?.flags?.[MOD] ?? null;
    const applyOn = async (flags) => {
      hp9.value = 30; hp9.temp = 0;
      const card = { id: "replay-damage-card-9", flags: { [MOD]: flags }, update: async () => card };
      await quiet(async () => { await DamageApplicator.applyDamage(card); });
      return 30 - hp9.value;
    };
    let onHitTotal = null, plainTook = null, tamperedTook = null;
    if (!err9 && f9) {
      try {
        onHitTotal = (f9.damageResults?.[0]?.components ?? []).filter(c => c.recipePart === "onHit")
          .reduce((s, c) => s + (Number(c.final) || 0), 0);
        plainTook = await applyOn(JSON.parse(JSON.stringify(f9)));
        const tampered = JSON.parse(JSON.stringify(f9));
        tampered.damageResults[0].components.push({ name: `${axe.name} (critical)`, type: "slashing", raw: 5, final: 5,
          modifier: "normal", recipePart: "onCrit" });
        tamperedTook = await applyOn(tampered);
      } catch (err) { err9 = err; }
    }
    ACTORS.delete(victim9.id);
    check("9. APPLY asks the attack's recipe, not only the card: a crit row on a plain hit is refused (Phase 3)",
      !err9 && f9?.recipe?.decidedBy?.kind === "attack" && f9.damageResults?.[0]?.result === "hit"
        && onHitTotal > 0 && plainTook === onHitTotal && tamperedTook === onHitTotal,
      err9 ? `threw: ${err9?.message ?? err9}`
        : `the damage card carries ${f9?.recipe ? "the Greataxe's recipe" : "no recipe"} and the result `
          + `"${f9?.damageResults?.[0]?.result}"; APPLY took ${plainTook} (the hit's ${onHitTotal}); `
          + `with a crit row added to that plain hit, it took ${tamperedTook}`);
  }

  // ── 10. A save after a hit that fails into damage AND a condition lands both ──
  // Johnny, 2026-09-14: "whatLands(recipe, fail) returns damage AND conditions.
  // Live apply must run both doors ... Damage does not skip conditions. Ever."
  // The Green Abishai's Fiendish Claw: "or take 3d10 poison damage and become
  // poisoned for 1 minute", its dice written as dnd5e's enricher, which the reader
  // used to lose. On the save engine: the condition door when the save resolves,
  // the hit-point door at APPLY ALL, both from whatLands on the card's recipe. On
  // the old after-hit card: the same answer, from whatLands as well.
  {
    const abishai = [...ACTORS.values()].find(a => a.name === "Green Abishai") ?? null;
    const claw10 = abishai ? abishai.items.find(i => i.name === "Fiendish Claw") : null;
    if (!claw10) {
      check("10. a save after a hit fails into damage and a condition (Phase 3)", null, "no Green Abishai's Fiendish Claw in this world");
    } else {
      const { ConditionDoor } = await import(`${MODULE}/scripts/road/doors.mjs`);
      let road10 = null;
      await quiet(async () => { road10 = await DamageCalculator._attackRoad(claw10, abishai, null); });
      const then10 = road10?.recipe?.then?.[0] ?? null;
      const failDmg = (then10?.onFail ?? []).find(o => o.kind === "damage") ?? null;
      const failCond = (then10?.onFail ?? []).find(o => o.kind === "condition" && o.condition?.key === "poisoned") ?? null;
      // A creature on a stand-in scene, found the way the save engine finds one.
      const hp10 = { value: 40, max: 40, temp: 0 };
      const victim10 = { id: "replay-then-target", name: "a test creature", type: "npc", documentName: "Actor",
        system: { attributes: { hp: hp10 }, abilities: { con: { save: { value: 0 }, mod: 0 } },
          traits: { ci: { value: [] }, di: { value: [] }, dr: { value: [] }, dv: { value: [] } } },
        statuses: new Set(), effects: new Collection(), getFlag: () => undefined, prototypeToken: { actorLink: true },
        update: async (u) => {
          if ("system.attributes.hp.value" in u) hp10.value = u["system.attributes.hp.value"];
          if ("system.attributes.hp.temp" in u) hp10.temp = u["system.attributes.hp.temp"];
          return victim10;
        } };
      const tokenDoc10 = { id: "tok-then", actor: victim10, actorId: victim10.id, actorLink: true, parent: { id: "replay-scene" } };
      const keep10 = { scenes: game.scenes.get, cond: ConditionDoor.apply, hp: HpDoor.damage };
      const condCalls = [], hpCalls = [];
      game.scenes.get = (id) => (id === "replay-scene"
        ? { id, tokens: { get: (t) => (t === tokenDoc10.id ? tokenDoc10 : null), contents: [tokenDoc10] } } : null);
      ConditionDoor.apply = async (actor, key) => { condCalls.push({ actor: actor?.name, key }); return { ok: true, applied: key }; };
      HpDoor.damage = async (actor, finals) => {
        hpCalls.push({ actor: actor?.name, finals });
        return { applied: true, total: (finals ?? []).reduce((s, f) => s + (Number(f.final) || 0), 0), hpDelta: 0 };
      };
      ACTORS.set(victim10.id, victim10);
      const row10 = { name: victim10.name, tokenDocId: tokenDoc10.id, sceneId: "replay-scene", actorId: victim10.id,
        passed: false, saveTotal: 1 };
      let err10 = null, engineConds = [], engineHp = [], oldConds = [], oldCard = null;
      try {
        await quiet(async () => {
          const engine = Object.create(SaveEngine.prototype);
          // The save engine: the condition door when the save resolves...
          await engine._applyFailedSaveConditions(claw10, [row10], { recipe: then10, saveAbility: "con",
            saveDC: then10?.decidedBy?.dc ?? 16, activityId: null, casterActor: abishai });
          engineConds = condCalls.splice(0);
          // ...and the hit-point door at APPLY ALL, from the same recipe.
          const dice10 = await engine._rollSpellDamage(claw10, abishai, { recipe: then10, activityId: null });
          const { finals, total } = SaveEngine._damageForRow(row10, dice10, then10);
          const card10 = { id: "replay-then-card", update: async () => card10, flags: { [MOD]: {
            itemUuid: claw10.uuid, actorId: abishai.id,
            damageResults: [{ targetId: victim10.id, tokenDocId: tokenDoc10.id, sceneId: "replay-scene", totalFinal: total,
              byType: finals.filter(f => f.final > 0).map(f => ({ type: f.type, value: f.final })) }] } } };
          await engine._applyAllSaveDamage(card10);
          engineHp = hpCalls.splice(0);
          // The old after-hit card, which asks whatLands too now.
          const before10 = posted.length;
          await PostHitSaves.rollPostHitSaves({ flags: { [MOD]: {
            save: PostHitSaves.riderSavesFor(claw10, abishai, { quiet: true }).saves?.[0] ?? null,
            recipe: then10, conditions: [], effectTable: null,
            targets: [{ tokenDocId: tokenDoc10.id, actorId: victim10.id, sceneId: "replay-scene", name: victim10.name, img: "" }],
            itemUuid: claw10.uuid, itemId: claw10.id, actorId: abishai.id } } });
          oldConds = condCalls.splice(0);
          oldCard = posted.slice(before10).find(p => p?.flags?.[MOD]?.type === "postHitSaveResult") ?? null;
        });
      } catch (err) { err10 = err; }
      finally {
        game.scenes.get = keep10.scenes; ConditionDoor.apply = keep10.cond; HpDoor.damage = keep10.hp;
        ACTORS.delete(victim10.id);
      }
      const engineHpTypes = engineHp.flatMap(c => (c.finals ?? []).filter(f => Number(f.final) > 0).map(f => f.type));
      const oldDmg = oldCard?.flags?.[MOD]?.damageResults?.[0]?.components ?? [];
      const said10 = then10 ? `${then10.decidedBy.ability} DC ${then10.decidedBy.dc}, on a failure `
        + (then10.onFail ?? []).map(o => (o.kind === "damage" ? `${o.formula} ${(o.types ?? []).join("/")}` : o.condition?.key)).join(", ") : "none";
      check("10. a save after a hit that fails into damage and a condition lands both, on the save engine and the old card (Phase 3)",
        !err10 && failDmg?.formula === "3d10" && (failDmg?.types ?? []).includes("poison") && !!failCond
          && engineConds.some(c => c.key === "poisoned") && engineHpTypes.includes("poison")
          && oldConds.some(c => c.key === "poisoned") && oldDmg.some(c => c.type === "poison" && Number(c.final) > 0),
        err10 ? `threw: ${err10?.message ?? err10}`
          : `Green Abishai's Fiendish Claw, then: ${said10}; save engine: condition door ${engineConds.map(c => c.key).join(", ") || "never"}, `
            + `hit-point door ${engineHpTypes.join(", ") || "never"}; old card: condition door ${oldConds.map(c => c.key).join(", ") || "never"}, `
            + `damage on its card ${oldDmg.map(c => `${c.final} ${c.type}`).join(", ") || "none"}`);
    }
  }
}

/* ── SPIRIT GUARDIANS 2024, THE PICKERS AND THE CARD ────────────────────── */
// Johnny, 2026-09-16, with the picker open on a corpse and gold spirits around a
// Neutral Evil caster: one set of picker rules for every spell (the living for a
// damage, heal or "who is safe" list, the dead for a life restore, and refused
// means HIDDEN, not dimmed); no dead creature on a save or damage card at all;
// and Spirit Guardians 2024 run properly: ask who is safe, catch every living
// creature that is not spared, once a turn, in the damage and the colour its
// caster's alignment calls for.
console.log(`\nSPIRIT GUARDIANS 2024, THE PICKERS AND THE CARD`);
{
  const MOD = "ace-qol";
  const { lifeStateOf, pickable } = await import(`${MODULE}/scripts/road/picker-rule.mjs`);
  const { SpellTargetPicker } = await import(`${MODULE}/scripts/spell-target-picker.mjs`);
  const { guardianFlavour, narrowDamageTypes, isSpiritGuardians, guardianDamage } =
    await import(`${MODULE}/scripts/rules/spirit-guardians.mjs`);
  const { ConcentrationWidget } = await import(`${MODULE}/scripts/concentration-widget.mjs`);
  const { getSpellTiming } = await import(`${MODULE}/scripts/spell-timing.mjs`);
  const { catchesOn } = await import(`${MODULE}/scripts/road/run.mjs`);

  const SCENE6 = "replay-sg-scene";
  const docs6 = new Map();
  const setPath6 = (obj, key, v) => {
    const path = key.split(".");
    let o = obj;
    for (const k of path.slice(0, -1)) o = (o[k] ??= {});
    o[path[path.length - 1]] = v;
  };
  const creature6 = (id, name, { type = "npc", hp = 30, statuses = [], death = null } = {}) => {
    const a = { id, name, type, img: "", documentName: "Actor", uuid: `Actor.${id}`,
      statuses: new Set(statuses), effects: new Collection(), items: new Collection(),
      isOwner: true, hasPlayerOwner: type === "character", prototypeToken: { actorLink: true },
      getFlag: () => undefined, getRollData: () => ({}),
      system: { attributes: { hp: { value: hp, max: 30, temp: 0 }, death: death ?? { success: 0, failure: 0 }, prof: 2 },
        abilities: { str: { mod: 0, save: { value: 0 } }, dex: { mod: 0, save: { value: 0 } },
          con: { mod: 0, save: { value: 0 } }, wis: { mod: 0, save: { value: 0 } } },
        skills: {}, details: { type: { value: "humanoid" }, alignment: "Neutral" },
        traits: { ci: { value: [] }, di: { value: [] }, dr: { value: [] }, dv: { value: [] } } },
      update: async (u) => { for (const [k, v] of Object.entries(u)) setPath6(a, k, v); return a; } };
    ACTORS.set(id, a);
    return a;
  };
  const place6 = (actor, id, { flags = {}, x = 0 } = {}) => {
    const doc = { id, actorId: actor.id, actor, parent: { id: SCENE6 }, flags, name: actor.name,
      hidden: false, x, y: 0, width: 1, height: 1, elevation: 0, disposition: -1, texture: { src: "" },
      update: async (u) => { for (const [k, v] of Object.entries(u)) setPath6(doc, k, v); return doc; } };
    const tok = { id, name: actor.name, actor, document: doc, x, y: 0, w: 100, h: 100,
      center: { x: x + 50, y: 50 }, scene: { id: SCENE6 }, visible: true, setTarget() {} };
    doc.object = tok;
    docs6.set(id, doc);
    canvas.tokens.placeables.push(tok);
    return tok;
  };

  const keep6 = { placed: [...canvas.tokens.placeables], scenes: game.scenes.get,
    show: SpellTargetPicker._showDialog, scene: canvas.scene, messages: game.messages };
  // A table always has a chat log; the save card reads it to find a player's own
  // roll, and an absent one made the card's roll throw where a table never would.
  game.messages = { contents: [], get: () => null };
  const shown6 = [];
  let choose6 = () => [];
  SpellTargetPicker._showDialog = async (o) => { shown6.push(o); return choose6(o); };
  canvas.tokens.placeables.length = 0;
  const made6 = [];
  try {
    const varek = firstActor(VAREK);
    const alive = creature6("replay-sg-alive", "a standing bandit");
    const dying = creature6("replay-sg-dying", "a dying knight", { type: "character", hp: 0, statuses: ["unconscious"] });
    const dead = creature6("replay-sg-dead", "a dead bandit", { hp: 0 });
    const lost = creature6("replay-sg-lost", "a beheaded bandit", { hp: 0 });
    const far = creature6("replay-sg-far", "a bandit down the hall");
    made6.push(alive, dying, dead, lost, far);
    const varekTok = varek ? place6(varek, "tok-sg-varek") : null;
    const aliveTok = place6(alive, "tok-sg-alive");
    const dyingTok = place6(dying, "tok-sg-dying");
    const deadTok = place6(dead, "tok-sg-dead", { flags: { [MOD]: { isDead: true } } });
    const lostTok = place6(lost, "tok-sg-lost", { flags: { [MOD]: { isDead: true, permanentlyDead: true } } });
    const farTok = place6(far, "tok-sg-far", { x: 4000 });
    const scene6 = { id: SCENE6, templates: { get: () => null },
      tokens: { get: (t) => docs6.get(t) ?? null, contents: [...docs6.values()] } };
    game.scenes.get = (id) => (id === SCENE6 ? scene6 : keep6.scenes(id));
    // ⚠️ A TABLE ALWAYS HAS A SCENE. The save card walks it to find each target's
    // own token, and a null scene made the card's own roll throw where a table
    // never would.
    canvas.scene = scene6;

    // ── 1. One set of rules, four lists ──
    const life = (tok) => lifeStateOf(tok.actor, tok.document);
    const may = (kind, tok) => pickable(kind, life(tok)).ok;
    const four = (tok) => ["harm", "heal", "exclude", "revive"].filter(k => may(k, tok)).join(", ") || "none";
    check("1. one set of picker rules: a damage, heal or who-is-safe list takes the living and the dying at 0 hit points and never the dead; a life-restore list takes the dead alone, killed for good included (09-16)",
      may("harm", aliveTok) && may("heal", aliveTok) && may("exclude", aliveTok) && !may("revive", aliveTok)
        && may("harm", dyingTok) && may("heal", dyingTok) && may("exclude", dyingTok) && !may("revive", dyingTok)
        && !may("harm", deadTok) && !may("heal", deadTok) && !may("exclude", deadTok) && may("revive", deadTok)
        && !may("harm", lostTok) && !may("heal", lostTok) && !may("exclude", lostTok) && may("revive", lostTok),
      `standing: ${four(aliveTok)}; dying at 0: ${four(dyingTok)}; dead: ${four(deadTok)}; killed for good: ${four(lostTok)}`);

    // ── 2. The list hides by life and dims by range ──
    if (!varekTok) {
      check("2. the picker hides the dead and dims the distant (09-16)", null, "Varek has no token to measure from");
    } else {
      const rows = (kind) => SpellTargetPicker._buildCandidates(varekTok, varek, 30, false, kind)
        .filter(c => c.lifeOk);
      const harm = rows("harm"), revive = rows("revive"), safe = rows("exclude");
      const on = (list, a) => list.find(c => c.actor === a) ?? null;
      check("2. the same list every time: the dead are not on a damage or who-is-safe list, the living are not on a life-restore list, and somebody too far away is still on it, dimmed (09-16)",
        !!on(harm, alive) && !!on(harm, dying) && !on(harm, dead) && !on(harm, lost)
          && !!on(revive, dead) && !!on(revive, lost) && !on(revive, alive) && !on(revive, dying)
          && !!on(safe, alive) && !!on(safe, dying) && !on(safe, dead)
          && !!on(harm, far) && on(harm, far).valid === false && /out of spell range/.test(on(harm, far).why ?? ""),
        `a damage list: ${harm.map(c => c.name).join(", ") || "nobody"}; a life-restore list: ${revive.map(c => c.name).join(", ") || "nobody"}; `
          + `a who-is-safe list: ${safe.map(c => c.name).join(", ") || "nobody"}; `
          + `the one down the hall: ${on(harm, far) ? `on the list, ${on(harm, far).valid ? "pickable" : on(harm, far).why}` : "not on the list"}`);
    }

    // ── 3. No dead creature on a save card ──
    const guardians = varek ? [...varek.items].find(i => i.type === "spell" && /^spirit guardians$/i.test(i.name)
      && i.system?.source?.rules === "2024") ?? null : null;
    const guardAct = guardians ? [...(guardians.system?.activities ?? [])].find(a => a.type === "save") ?? null : null;
    let engine6 = null;
    try { engine6 = new SaveEngine({}); } catch (err) { engine6 = null; }
    if (!engine6 || !guardians || !guardAct) {
      check("3. the dead get no row on a save card (09-16)", null,
        engine6 ? "Varek has no 2024 Spirit Guardians" : "the save engine would not start in the stand-in");
    } else {
      const before = posted.length;
      let err3 = null;
      try {
        await quiet(async () => {
          await engine6._postLiveTargetCard(guardians, varek, [aliveTok, deadTok, lostTok, dyingTok], {
            saveAbility: "wis", saveDC: 21, isSpell: true, activityId: guardAct.id, skipDelay: true,
          });
        });
      } catch (e) { err3 = e; }
      const card = posted.slice(before).find(m => m?.flags?.[MOD]?.type === "saveTargets" || /save/i.test(String(m?.flags?.[MOD]?.type ?? "")));
      const named = (m) => String(m?.content ?? "").replace(/<[^>]+>/g, " ");
      const text = named(card);
      const onlyDead = posted.slice(before).length;
      // A card for nobody but the dead is not posted at all.
      const before2 = posted.length;
      try { await quiet(async () => {
        await engine6._postLiveTargetCard(guardians, varek, [deadTok], {
          saveAbility: "wis", saveDC: 21, isSpell: true, activityId: guardAct.id, skipDelay: true });
      }); } catch (e) { err3 = err3 ?? e; }
      const posted2 = posted.slice(before2).length;
      check("3. a save card carries the living and the dying and no dead creature at all, and a card asked only about the dead is never posted (09-16)",
        !err3 && !!card && /standing bandit/.test(text) && /dying knight/.test(text)
          && !/dead bandit/.test(text) && !/beheaded bandit/.test(text) && posted2 === 0,
        err3 ? `threw: ${err3?.message ?? err3}`
          : `${onlyDead} card(s) posted for four creatures; it names: `
            + `${["standing bandit", "dying knight", "dead bandit", "beheaded bandit"].filter(n => new RegExp(n).test(text)).join(", ") || "nobody"}; `
            + `asked only about a corpse it posted ${posted2}`);
    }

    // ── 4. Spirit Guardians: who is safe, and the spared are spared ──
    if (!guardians || !guardAct || !varekTok) {
      check("4. Spirit Guardians asks who is safe and spares them (09-16)", null, "Varek has no 2024 Spirit Guardians");
    } else {
      const who = SaveEngine._areaWhoRule(guardians);
      // The tracker the cast builds, with the answer written on its area.
      const handed6 = [];
      const engine = {
        postSaveCard: async (item, actor, tokens, opts) => { handed6.push({ how: "card", tokens, opts }); },
        _fastResolveSingleNpcSave: async (item, actor, token, opts) => { handed6.push({ how: "rolled", token, opts }); },
      };
      const widget = new ConcentrationWidget(engine);
      const templateDoc = { id: "tpl-sg-1", parent: { id: SCENE6 }, t: "circle", x: 0, y: 0, distance: 15,
        flags: { [MOD]: { excluded: [aliveTok.id] } }, object: null };
      let recipe = null;
      await quiet(async () => {
        await loadBookFor(guardians, { actor: varek });
        recipe = recipeForActivity(guardians, guardAct, { actor: varek })?.recipe ?? null;
        widget._onPersistentSpellCreated({
          item: guardians, actor: varek, templateDoc, timing: getSpellTiming(guardians),
          saveAbility: "wis", saveDC: 21, halfOnSave: true, damageTypes: [], tokens: [],
          recipe, activityId: guardAct.id, castLevel: 5,
        });
      });
      const tracker = widget._activeSpells.get(templateDoc.id) ?? null;
      const at = handed6.length;
      // ⚠️ ONCE A TURN NEEDS A TURN. The cap is keyed on whose turn it is, and out
      // of combat there is none, so the rule is pinned where it lives: in a round.
      const keepCombat = game.combat;
      game.combat = { started: true, round: 3, turn: 1 };
      await quiet(async () => {
        await widget._onTokenEnteredTemplate(tracker, aliveTok, { phase: "entry" });   // marked safe
        await widget._onTokenEnteredTemplate(tracker, dyingTok, { phase: "entry" });   // 0 HP, still caught
        await widget._onTokenEnteredTemplate(tracker, dyingTok, { phase: "endOfTurn" }); // same turn: once only
      });
      game.combat = keepCombat;
      const runs = handed6.slice(at);
      check("4. the creatures the caster marked safe are spared for good, a creature at 0 hit points is still caught, and one turn is one save (09-16)",
        who.kind === "exclude" && !!tracker && tracker.exemptTokenIds.has(aliveTok.id)
          && runs.length === 1 && (runs[0].token === dyingTok || runs[0].tokens?.[0] === dyingTok),
        `its area rule: ${who.kind} (${who.why}); the tracker spares ${[...(tracker?.exemptTokenIds ?? [])].length} creature(s); `
          + `the one marked safe walked in, the dying one walked in and then ended its turn there: `
          + `${runs.length} save(s) asked${runs.length ? ` (${runs.map(r => r.token?.name ?? r.tokens?.map(t => t.name).join("/")).join(", ")})` : ""}`);
    }

    // ── 6. Dropping concentration takes the light off the map ──
    if (!guardians || !guardAct || !varekTok) {
      check("6. dropping concentration ends the aura and what it put on (09-16)", null, "Varek has no 2024 Spirit Guardians");
    } else {
      const ended = [];
      const keepSeq = globalThis.Sequencer;
      globalThis.Sequencer = { EffectManager: { endEffects: (o) => { ended.push(o); } } };
      const engine = { postSaveCard: async () => {}, _fastResolveSingleNpcSave: async () => {} };
      const widget = new ConcentrationWidget(engine);
      // The creature standing in it, carrying what the spell put on: the effect
      // is tagged with this spell's concentration origin, as the door tags it.
      const halfSpeed = { id: "eff-half-speed", name: "Half Speed", statuses: new Set(),
        flags: { [MOD]: { concentrationOrigin: { casterId: varek.id, spellName: guardians.name, spellItemId: guardians.id } } } };
      alive.effects.set(halfSpeed.id, halfSpeed);
      const deleted = [];
      alive.deleteEmbeddedDocuments = async (type, ids) => {
        for (const id of ids) { deleted.push(id); alive.effects.delete(id); }
        return [];
      };
      const templateDoc = { id: "tpl-sg-end", parent: { id: SCENE6 }, t: "circle", x: 0, y: 0, distance: 15,
        flags: {}, object: null, delete: async () => {} };
      let recipe = null;
      await quiet(async () => {
        await loadBookFor(guardians, { actor: varek });
        recipe = recipeForActivity(guardians, guardAct, { actor: varek })?.recipe ?? null;
        widget._onPersistentSpellCreated({
          item: guardians, actor: varek, templateDoc, timing: getSpellTiming(guardians),
          saveAbility: "wis", saveDC: 21, halfOnSave: true, damageTypes: [], tokens: [],
          recipe, activityId: guardAct.id, castLevel: 5,
        });
      });
      const tracker = widget._activeSpells.get(templateDoc.id) ?? null;
      // Concentration breaks: the effect that carried it is deleted.
      const conc = { name: `Concentrating: ${guardians.name}`, uuid: "Actor.varek.ActiveEffect.conc1",
        statuses: new Set(["concentration"]), parent: varek };
      await quiet(async () => {
        widget._onEffectRemoved(conc);
        for (let i = 0; i < 20; i++) await new Promise(r => setTimeout(r, 0));
      });
      globalThis.Sequencer = keepSeq;
      const byName = ended.find(o => o?.name === `ace-qol-guardians-${templateDoc.id}`) ?? null;
      const byOrigin = ended.find(o => o?.origin === conc.uuid) ?? null;
      check("6. dropping concentration takes the aura off the map the same moment the effect goes, by ACE's own name and by whatever another module hung on that effect, and what the emanation put on comes off with it (09-16)",
        !!tracker && !!byName && !!byOrigin && deleted.includes(halfSpeed.id)
          && !widget._activeSpells.has(templateDoc.id),
        `ended: ${ended.map(o => o?.name ?? o?.origin ?? "?").join(", ") || "nothing"}; `
          + `the spell's own effect on the bandit: ${deleted.includes(halfSpeed.id) ? "removed" : "left on"}; `
          + `the tracker is ${widget._activeSpells.has(templateDoc.id) ? "still there" : "gone"}`);

      // And the caster is never caught by his own emanation, whatever the
      // placed-area setting says.
      const keepSetting = SETTINGS.get("ace-qol.excludeCasterFromTemplates");
      SETTINGS.set("ace-qol.excludeCasterFromTemplates", false);
      const templateDoc2 = { id: "tpl-sg-caster", parent: { id: SCENE6 }, t: "circle", x: 0, y: 0, distance: 15,
        flags: {}, object: null, delete: async () => {} };
      await quiet(async () => {
        widget._onPersistentSpellCreated({
          item: guardians, actor: varek, templateDoc: templateDoc2, timing: getSpellTiming(guardians),
          saveAbility: "wis", saveDC: 21, halfOnSave: true, damageTypes: [], tokens: [],
          recipe, activityId: guardAct.id, castLevel: 5,
        });
      });
      const tracker2 = widget._activeSpells.get(templateDoc2.id) ?? null;
      if (keepSetting === undefined) SETTINGS.delete("ace-qol.excludeCasterFromTemplates");
      else SETTINGS.set("ace-qol.excludeCasterFromTemplates", keepSetting);
      check("6b. the caster of a self-centred emanation is exempt from it even with the placed-area setting turned off (09-16)",
        !!tracker2 && tracker2.exemptTokenIds.has(varekTok.id),
        `with "exclude the caster from templates" off, ${varek.name} is `
          + `${tracker2?.exemptTokenIds?.has(varekTok.id) ? "still exempt from his own spirits" : "caught by his own spirits"}`);
    }

    // ── 7. An empty aura is still the spell ──
    {
      const { concentrationHoldsAPlace } = await import(`${MODULE}/scripts/rules/concentration-place.mjs`);
      const hold = varek ? [...varek.items].find(i => i.type === "spell" && /^hold person$/i.test(i.name)) ?? null : null;
      const conc = (item) => ({ name: `Concentrating: ${item?.name}`, flags: { dnd5e: { item: { uuid: item?.uuid } } } });
      const tpl = (item) => [{ flags: { dnd5e: { item: item?.uuid } } }];
      let onMap = null, tracked = null, byRecipe = null, held = null, err7 = null;
      try {
        await quiet(async () => {
          if (guardians) {
            onMap = await concentrationHoldsAPlace(conc(guardians), { casterActor: varek, templates: tpl(guardians) });
            tracked = await concentrationHoldsAPlace(conc(guardians), { casterActor: varek, templates: [],
              tracked: [{ actor: varek, item: guardians }] });
            byRecipe = await concentrationHoldsAPlace(conc(guardians), { casterActor: varek, templates: [], tracked: [] });
          }
          // Hold Person holds a creature, not a place: when its target shakes it
          // off, the caster must still be let go of it.
          if (hold) held = await concentrationHoldsAPlace(conc(hold), { casterActor: varek, templates: [], tracked: [] });
        });
      } catch (e) { err7 = e; }
      check("7. an emanation with nobody in it is still the spell: its area on the map, ACE running it, or its own recipe each hold the concentration up, and a spell that holds a creature still lets go when the last one shakes it off (09-16)",
        !err7 && !!guardians && !!onMap && !!tracked && !!byRecipe && held === null,
        err7 ? `threw: ${err7?.message ?? err7}`
          : `${guardians?.name ?? "Spirit Guardians"}: with its area on the map — ${onMap ?? "it ends"}; `
            + `with ACE running it — ${tracked ?? "it ends"}; with neither — ${byRecipe ?? "it ends"}; `
            + `${hold ? `${hold.name}: ${held ?? "it ends when its last target is free, as it must"}` : "no Hold Person to read"}`);
    }

    // ── 8. The 2014 copy: its own triggers ──
    // Johnny, 2026-09-16: "2014 Spirit Guardians only... Save when a creature
    // enters (first time that turn) or STARTS its turn in the aura. Do NOT save
    // just because the caster walked the aura onto them (2014). Do NOT use
    // end-of-turn. Empty aura does NOT end concentration."
    {
      const owner14 = [...ACTORS.values()].find(a => [...(a.items ?? [])].some(i =>
        i.type === "spell" && /^spirit guardians$/i.test(i.name) && i.system?.source?.rules === "2014")) ?? null;
      const sg14 = owner14 ? [...owner14.items].find(i => i.type === "spell"
        && /^spirit guardians$/i.test(i.name) && i.system?.source?.rules === "2014") : null;
      const act14 = sg14 ? [...(sg14.system?.activities ?? [])].find(a => a.type === "save") ?? null : null;
      if (!sg14 || !act14) {
        check("8. the 2014 Spirit Guardians catches on entering and at the start of a turn (09-16)", null,
          "no 2014 Spirit Guardians in this world");
      } else {
        let recipe14 = null;
        await quiet(async () => {
          await loadBookFor(sg14, { actor: owner14 });
          recipe14 = recipeForActivity(sg14, act14, { actor: owner14 })?.recipe ?? null;
        });
        const said = recipe14?.recatch ?? [];
        const asks = (t) => catchesOn(recipe14, t).ok;
        const who14 = SaveEngine._areaWhoRule(sg14);

        // A tracker for it, and a creature the aura is walked onto.
        const handed14 = [];
        const engine14 = {
          postSaveCard: async (item, actor, tokens, opts) => { handed14.push({ how: "card", tokens, opts }); },
          _fastResolveSingleNpcSave: async (item, actor, token, opts) => { handed14.push({ how: "rolled", token, opts }); },
        };
        const widget14 = new ConcentrationWidget(engine14);
        const tplDoc14 = { id: "tpl-sg-2014", parent: { id: SCENE6 }, t: "circle", x: 0, y: 0, distance: 15,
          flags: {}, object: null, delete: async () => {} };
        await quiet(async () => {
          widget14._onPersistentSpellCreated({
            item: sg14, actor: owner14, templateDoc: tplDoc14, timing: getSpellTiming(sg14),
            saveAbility: "wis", saveDC: 15, halfOnSave: true, damageTypes: [], tokens: [],
            recipe: recipe14, activityId: act14.id, castLevel: 3,
          });
        });
        const tracker14 = widget14._activeSpells.get(tplDoc14.id) ?? null;
        if (tracker14) tracker14.followsCaster = true;   // an emanation centred on its caster
        const at14 = handed14.length;
        const keepCombat14 = game.combat;
        game.combat = { started: true, round: 2, turn: 0 };
        await quiet(async () => {
          // The caster walks his spirits onto a creature standing still.
          tracker14.tokens = [];
          tracker14.tokensInside = new Set();
          const keepGet = SaveEngine._getTokensInTemplate;
          SaveEngine._getTokensInTemplate = () => [aliveTok];
          try { await widget14._onTemplateMove(tplDoc14); }
          finally { SaveEngine._getTokensInTemplate = keepGet; }
        });
        const onWalkOver = handed14.length - at14;
        // ...and the same creature at the start of its own turn.
        await quiet(async () => { await widget14._onTokenEnteredTemplate(tracker14, aliveTok, { phase: "startOfTurn" }); });
        game.combat = keepCombat14;
        const onItsTurn = handed14.length - at14 - onWalkOver;

        // Its concentration stands with nobody in it.
        let stands14 = null;
        await quiet(async () => {
          const { concentrationHoldsAPlace } = await import(`${MODULE}/scripts/rules/concentration-place.mjs`);
          stands14 = await concentrationHoldsAPlace(
            { name: `Concentrating: ${sg14.name}`, flags: { dnd5e: { item: { uuid: sg14.uuid } } } },
            { casterActor: owner14, templates: [], tracked: [{ actor: owner14, item: sg14 }] });
        });

        check("8. the 2014 Spirit Guardians catches a creature that walks in and one that starts its turn in it, never at the end of a turn, and never for being walked onto; it asks who is safe first, and an empty aura still holds its concentration (09-16)",
          asks("enter-area") && asks("start-of-turn") && !asks("end-of-turn")
            && who14.kind === "exclude" && onWalkOver === 0 && onItsTurn === 1 && !!stands14,
          `${owner14.name}'s 2014 copy: its words catch on ${said.join(", ") || "nothing"}; `
            + `end of turn is ${asks("end-of-turn") ? "asked" : "refused"}; who is safe: ${who14.kind}; `
            + `walked onto a standing creature: ${onWalkOver} save(s); that creature's own turn start: ${onItsTurn} save(s); `
            + `empty aura: ${stands14 ?? "concentration would end"}`);

        // Its damage is its caster's alignment, and a sheet that carries both
        // halves rolls one of them.
        const both = [{ type: "radiant", total: 3, roll: {} }, { type: "necrotic", total: 3, roll: {} }];
        const evilPick = guardianDamage(both.map(c => ({ ...c })), { name: "an evil caster", system: { details: { alignment: "Neutral Evil" } } });
        const goodPick = guardianDamage(both.map(c => ({ ...c })), { name: "a good caster", system: { details: { alignment: "Lawful Good" } } });
        const onlyRadiant = guardianDamage([{ type: "radiant", total: 3, roll: {} }], { name: "an evil caster", system: { details: { alignment: "Neutral Evil" } } });
        check("8b. a 2014 sheet that stores both halves of the spell's choice rolls one of them, and a sheet that stores only radiant still turns fiendish for an evil caster (09-16)",
          evilPick.kept.length === 1 && evilPick.kept[0].type === "necrotic" && evilPick.dropped.length === 1
            && goodPick.kept.length === 1 && goodPick.kept[0].type === "radiant"
            && onlyRadiant.kept.length === 1 && onlyRadiant.kept[0].type === "necrotic",
          `both halves on the sheet: an evil caster deals ${evilPick.kept.map(c => c.type).join("/")} `
            + `(dropping ${evilPick.dropped.map(c => c.type).join("/") || "nothing"}), a good one ${goodPick.kept.map(c => c.type).join("/")}; `
            + `a radiant-only sheet cast by an evil caster deals ${onlyRadiant.kept.map(c => c.type).join("/")}`);
      }
    }

    // ── 9. A fresh press never asks between one cast and its nameless twin ──
    {
      const all = [...ACTORS.values()].flatMap(a => [...(a.items ?? [])].map(i => ({ a, i })));
      const dup = all.find(x => isSpiritGuardians(x.i) && guardianCastActivity(x.i, readActivities(x.i))) ?? null;
      const twoWays = all.find(x => /^wall of fire$/i.test(x.i?.name ?? "")
        && readActivities(x.i).filter(v => v?.consumption?.spellSlot !== false
          && String(v?.name ?? "").trim()).length > 1) ?? null;
      const pressed = dup ? press(dup.i) : null;
      const stillAsks = twoWays ? press(twoWays.i) : null;
      check("9. a press with the aura not up runs the cast instead of asking between it and its nameless twin, and a spell with two ways to cast that both carry names still asks (09-16)",
        !!dup && /^uses /.test(pressed ?? "") && !/utility/i.test(pressed ?? "")
          && (!twoWays || /^asks:/.test(stillAsks ?? "")),
        dup ? `${dup.a.name}'s ${dup.i.name}: ${pressed}; `
            + `${twoWays ? `${twoWays.a.name}'s ${twoWays.i.name}: ${stillAsks}` : "no two-named-cast spell to compare"}`
          : "no Spirit Guardians in this world carries the same cast twice");
    }

    // ── 5. Whose spirits are these ──
    {
      // ⚠️ THE RULE, NOT HIS SHEET. Varek read Neutral Evil in the morning and
      // Neutral Good by lunchtime (his world, his call), so pinning the mapping to
      // whoever happens to be evil today pins the table instead of the code. Two
      // stand-in casters carry the two alignments; his own sheets are reported
      // beside them so the line still says what his table will see.
      const evilOne = { name: "an evil caster", system: { details: { alignment: "Neutral Evil" } } };
      const goodOne = { name: "a good caster", system: { details: { alignment: "Lawful Good" } } };
      const blank = { name: "a caster with no alignment on its sheet", system: { details: {} } };
      const evil = guardianFlavour(evilOne);
      const good = guardianFlavour(goodOne);
      const none = guardianFlavour(blank);
      const narrowed = guardians ? narrowDamageTypes(guardians, evilOne, ["necrotic", "radiant"]) : [];
      const narrowedGood = guardians ? narrowDamageTypes(guardians, goodOne, ["necrotic", "radiant"]) : [];
      const untouched = narrowDamageTypes({ name: "Fireball" }, evilOne, ["fire"]);
      const varekNow = guardianFlavour(firstActor(VAREK));
      check("5. the spirits wear their caster's alignment: an evil caster deals necrotic behind the dark red ring, anyone else radiant behind the blue-gold one, and no other spell's damage is touched (09-16)",
        !!guardians && isSpiritGuardians(guardians)
          && evil.side === "evil" && evil.damageType === "necrotic" && evil.file === "jb2a.spirit_guardians.dark_red.ring"
          && good.side === "holy" && good.damageType === "radiant" && good.file === "jb2a.spirit_guardians.blueyellow.ring"
          && none.damageType === "radiant"
          && narrowed.length === 1 && narrowed[0] === "necrotic"
          && narrowedGood.length === 1 && narrowedGood[0] === "radiant"
          && untouched.length === 1 && untouched[0] === "fire",
        `evil: ${evil.damageType}, ${evil.colour}; good: ${good.damageType}, ${good.colour}; `
          + `a blank sheet: ${none.damageType}; its two types narrow to ${narrowed.join("/") || "nothing"} for an evil caster `
          + `and ${narrowedGood.join("/") || "nothing"} for a good one; a Fireball still deals ${untouched.join("/")}; `
          + `his own sheet today: ${firstActor(VAREK)?.name} is ${varekNow.alignment || "unset"} (${varekNow.damageType}, ${varekNow.colour})`);
    }

  } finally {
    SpellTargetPicker._showDialog = keep6.show;
    game.scenes.get = keep6.scenes;
    canvas.scene = keep6.scene;
    game.messages = keep6.messages;
    canvas.tokens.placeables.length = 0;
    canvas.tokens.placeables.push(...keep6.placed);
    for (const a of made6) ACTORS.delete(a.id);
  }
}

/* ── PHASE 5: AREA AND TURN TRIGGERS ──────────────────────── */
// Johnny, 2026-09-15: "PHASE 5 — area / turn triggers only. Then STOP." Done when
// the replay pins: 1. an emanation catches on entering and on the turn its own
// words name, running the SAME recipe as the cast; 2. Blade Barrier's walk-in and
// end of turn the same; 3. a creature moving through Spike Growth takes the
// recatch, per five feet, through the doors; 4. Hold Person's end-of-turn repeat
// asks the recipe, not the repeater's own rule; 5. the cards these touch go
// through the card door.
//
// ⚠️ WHAT IS REAL HERE AND WHAT IS STOOD IN. The area tracker, the road's run(),
// whatLands, the doors and the repeat engine's decision are ACE's own code on his
// own items. The save engine is stood in for the two save pins, so what is pinned
// there is exactly what Phase 5 changed: which recipe, which ability and which DC
// the trigger hands over, plus what that recipe makes a failed save take, read
// from the save engine's real damage rule. Spike Growth's pin is end to end: its
// recipe, its dice, the hit-point door and the card door.
console.log(`\nPHASE 5: AREA AND TURN TRIGGERS`);
{
  const MOD = "ace-qol";
  const { ConcentrationWidget } = await import(`${MODULE}/scripts/concentration-widget.mjs`);
  const { run: runTrigger, catchesOn, repeatOutcome, FEET_PER_TICK } = await import(`${MODULE}/scripts/road/run.mjs`);
  const { ConditionDoor } = await import(`${MODULE}/scripts/road/doors.mjs`);
  const { getSpellTiming } = await import(`${MODULE}/scripts/spell-timing.mjs`);

  const varek = firstActor(VAREK);
  const spellOf = (rx, ed = null) => (varek ? [...varek.items].find(i => i.type === "spell" && rx.test(i.name)
    && (!ed || i.system?.source?.rules === ed)) ?? null : null);
  const actsOf = (it) => [...(it?.system?.activities ?? [])];
  const recipeOf = async (item, activity) => {
    if (!item || !activity) return null;
    await loadBookFor(item, { actor: item.actor ?? null });
    return recipeForActivity(item, activity, { actor: item.actor ?? null })?.recipe ?? null;
  };

  // A stand-in scene: a token the tracker can catch, and a template to stand in.
  const SCENE5 = "replay-p5-scene";
  const docs5 = new Map();
  const setPath5 = (obj, key, v) => {
    const path = key.split(".");
    let o = obj;
    for (const k of path.slice(0, -1)) o = (o[k] ??= {});
    o[path[path.length - 1]] = v;
  };
  const creature5 = (id, name, { type = "npc", hp = 40, max = 40 } = {}) => {
    const a = { id, name, type, img: "", documentName: "Actor", uuid: `Actor.${id}`, statuses: new Set(),
      effects: new Collection(), items: new Collection(), isOwner: true, hasPlayerOwner: type === "character",
      prototypeToken: { actorLink: true }, getFlag: () => undefined, getRollData: () => ({}),
      system: { attributes: { hp: { value: hp, max, temp: 0 }, death: { success: 0, failure: 0 }, prof: 2 },
        abilities: { str: { mod: 0, save: { value: 0 } }, dex: { mod: 0, save: { value: 0 } },
          con: { mod: 0, save: { value: 0 } }, wis: { mod: 0, save: { value: 0 } } },
        skills: {}, details: { type: { value: "humanoid" } },
        traits: { ci: { value: [] }, di: { value: [] }, dr: { value: [] }, dv: { value: [] } } },
      applyDamage: async (n) => { applied5.push(n); return a; },
      update: async (u) => { for (const [k, v] of Object.entries(u)) setPath5(a, k, v); return a; } };
    ACTORS.set(id, a);
    return a;
  };
  const place5 = (actor, id) => {
    const doc = { id, actorId: actor.id, actor, parent: { id: SCENE5 }, flags: {}, name: actor.name,
      hidden: false, x: 0, y: 0, width: 1, height: 1, elevation: 0, disposition: -1, texture: { src: "" },
      update: async (u) => { for (const [k, v] of Object.entries(u)) setPath5(doc, k, v); return doc; } };
    const tok = { id, name: actor.name, actor, document: doc, x: 0, y: 0, w: 100, h: 100, center: { x: 50, y: 50 },
      scene: { id: SCENE5 }, setTarget() {} };
    doc.object = tok;
    docs5.set(id, doc);
    canvas.tokens.placeables.push(tok);
    return tok;
  };

  const applied5 = [];
  const keep5 = { placed: [...canvas.tokens.placeables], scenes: game.scenes.get, posted: posted.length,
    damage: HpDoor.damage, apply: ConditionDoor.apply, post: CardDoor.post, scene: canvas.scene };
  const doorCalls = { damage: [], condition: [], card: [] };
  HpDoor.damage = async (actor, finals, o = {}) => { doorCalls.damage.push({ actor, finals, o }); return { applied: true, total: (finals ?? []).reduce((t, f) => t + (Number(f.final) || 0), 0), hpDelta: 0 }; };
  ConditionDoor.apply = async (actor, key, opts, o) => { doorCalls.condition.push({ actor, key, opts }); return { ok: true, applied: key }; };
  CardDoor.post = async (data, o = {}) => { doorCalls.card.push({ data, o }); return { id: `p5-card-${doorCalls.card.length}`, ...data }; };
  canvas.tokens.placeables.length = 0;
  const made5 = [];
  try {
    const bandit = creature5("replay-p5-bandit", "a bandit in the way");
    made5.push(bandit);
    const banditTok = place5(bandit, "tok-p5-bandit");
    game.scenes.get = (id) => (id === SCENE5
      ? { id, templates: { get: () => null }, tokens: { get: (t) => docs5.get(t) ?? null, contents: [...docs5.values()] } }
      : keep5.scenes(id));

    // The save engine, stood in: it records exactly what the trigger hands it.
    const handed = [];
    const engine5 = {
      postSaveCard: async (item, actor, tokens, opts) => { handed.push({ how: "card", item, tokens, opts }); },
      _fastResolveSingleNpcSave: async (item, actor, token, opts) => { handed.push({ how: "rolled", item, token, opts }); },
    };
    const widget = new ConcentrationWidget(engine5);
    const trackerFor = async (item, activity, { saveAbility = null, saveDC = null, castLevel = null } = {}) => {
      const recipe = await recipeOf(item, activity);
      const templateDoc = { id: `tpl-${item.id}-${activity?.id ?? "x"}`, parent: { id: SCENE5 }, t: "circle",
        x: 0, y: 0, distance: 15, flags: {}, object: null };
      await quiet(async () => {
        widget._onPersistentSpellCreated({
          item, actor: varek, templateDoc, timing: getSpellTiming(item),
          saveAbility, saveDC, halfOnSave: true, damageTypes: [], tokens: [],
          recipe, activityId: activity?.id ?? null, castLevel,
        });
      });
      return { tracker: widget._activeSpells.get(templateDoc.id) ?? null, recipe };
    };

    // ── 1. An emanation: the same recipe as the cast, on its own triggers ──
    const guardians = spellOf(/^spirit guardians$/i, "2024") ?? spellOf(/^spirit guardians$/i);
    const guardAct = actsOf(guardians).find(a => a.type === "save") ?? actsOf(guardians)[0] ?? null;
    if (!varek || !guardAct) {
      check("1. an emanation catches again on its own recipe (Phase 5)", null, "Varek has no Spirit Guardians");
    } else {
      const { tracker, recipe } = await trackerFor(guardians, guardAct, { saveAbility: "wis", saveDC: 21, castLevel: 5 });
      const at = handed.length;
      let err1 = null;
      try {
        await quiet(async () => { await widget._onTokenEnteredTemplate(tracker, banditTok, { phase: "entry" }); });
      } catch (e) { err1 = e; }
      const seen = handed[at] ?? null;
      const said = recipe?.recatch ?? [];
      // Its own words name the turn it catches on; the other one is refused.
      const asks = (t) => catchesOn(recipe, t).ok;
      const wrongTurn = said.includes("end-of-turn") ? "start-of-turn" : "end-of-turn";
      check("1. an emanation catches everyone who walks in with the cast's own recipe, on the turn its own words name (Phase 5)",
        !err1 && !!seen && seen.opts?.recipe === recipe && seen.opts?.saveAbility === recipe?.decidedBy?.ability
          && seen.opts?.saveDC === 21 && seen.opts?.activityId === guardAct.id && seen.opts?.spellLevel === 5
          && seen.how === "rolled" && asks("enter-area") && !asks(wrongTurn),
        err1 ? `threw: ${err1?.message ?? err1}`
          : `${guardians.name} (${guardians.system?.source?.rules ?? "?"}): the bandit walked in and `
            + `${seen ? `it ${seen.how === "rolled" ? "rolled its own save" : "was asked to roll"} `
              + `${seen.opts?.saveAbility ?? "?"} DC ${seen.opts?.saveDC ?? "?"} on ${seen.opts?.recipe === recipe ? "the cast's own recipe" : "a different recipe"}, `
              + `slot ${seen.opts?.spellLevel ?? "none"}` : "nothing was asked"}; `
            + `its words catch on ${said.join(", ") || "nothing of their own"}, and ${wrongTurn} is ${asks(wrongTurn) ? "also asked" : "refused"}`);
    }

    // ── 2. Blade Barrier: the walk-in and the end of turn, same recipe ──
    const blade = spellOf(/^blade barrier$/i);
    const bladeAct = actsOf(blade).find(a => a.type === "save") ?? null;
    if (!varek || !bladeAct) {
      check("2. Blade Barrier's walk-in runs the cast's recipe (Phase 5)", null, "Varek has no Blade Barrier");
    } else {
      const { tracker, recipe } = await trackerFor(blade, bladeAct, { saveAbility: "dex", saveDC: 21, castLevel: 6 });
      const at = handed.length;
      let err2 = null;
      try {
        await quiet(async () => {
          await widget._onTokenEnteredTemplate(tracker, banditTok, { phase: "entry" });
          await widget._onTokenEnteredTemplate(tracker, banditTok, { phase: "endOfTurn" });
          await widget._onTokenEnteredTemplate(tracker, banditTok, { phase: "startOfTurn" });
        });
      } catch (e) { err2 = e; }
      const runs = handed.slice(at);
      // ⚠️🔴 AND WHAT THAT RECIPE MAKES IT TAKE. A re-catch card used to carry no
      // recipe at all, and a card with no recipe asks whatLands about nothing: the
      // creature that failed took ZERO of the 6d10 its own card was showing.
      const failed = { passed: false };
      const rolled = [{ total: 6, type: "force" }];
      const withRecipe = SaveEngine._damageForRow(failed, rolled, recipe).total;
      const withNone = SaveEngine._damageForRow(failed, rolled, null).total;
      const made = SaveEngine._damageForRow({ passed: true }, rolled, recipe).total;
      check("2. Blade Barrier catches a creature that walks in and one that ends its turn there, on the cast's recipe, and that recipe is what its damage comes from (Phase 5)",
        !err2 && runs.length === 2 && runs.every(r => r.opts?.recipe === recipe && r.opts?.saveAbility === "dex" && r.opts?.saveDC === 21)
          && withRecipe === 6 && withNone === 0 && made === 3,
        err2 ? `threw: ${err2?.message ?? err2}`
          : `${blade.name}: its words catch on ${(recipe?.recatch ?? []).join(", ") || "nothing"}; `
            + `walked in, ended its turn there and started its turn there gave ${runs.length} run(s) `
            + `(${runs.map(r => `${r.opts?.saveAbility} DC ${r.opts?.saveDC}`).join("; ") || "none"}); `
            + `6 rolled force on a failed save: ${withRecipe} with its recipe, ${withNone} with none, ${made} on a made save`);
    }

    // ── 3. Spike Growth: per five feet, through the doors ──
    const spike = spellOf(/^spike growth$/i);
    const spikeAct = actsOf(spike)[0] ?? null;
    if (!varek || !spikeAct) {
      check("3. Spike Growth takes its recatch per five feet (Phase 5)", null, "Varek has no Spike Growth");
    } else {
      const { tracker, recipe } = await trackerFor(spike, spikeAct, { castLevel: 2 });
      const atD = doorCalls.damage.length, atC = doorCalls.card.length, atA = applied5.length;
      let err3 = null;
      try { await quiet(async () => { await widget._applyMovementDamage(tracker, banditTok, 10); }); }
      catch (e) { err3 = e; }
      const hit = doorCalls.damage[atD] ?? null;
      const card = doorCalls.card[atC] ?? null;
      const total = (hit?.finals ?? []).reduce((t, f) => t + (Number(f.final) || 0), 0);
      // Every die rolls 1, so 2d4 twice is 4, and it is piercing, from the recipe.
      check("3. a creature moving through Spike Growth takes its recipe's damage once for every five feet, through the hit-point door, on a card the card door posted (Phase 5)",
        !err3 && !!hit && total === 4 && (hit.finals ?? []).every(f => f.type === "piercing")
          && hit.o?.dice === true && !!card && card.data?.flags?.[MOD]?.type === "areaTrigger"
          && card.o?.dice === true && applied5.length === atA,
        err3 ? `threw: ${err3?.message ?? err3}`
          : `${spike.name}: its words catch on ${(recipe?.recatch ?? []).join(", ") || "nothing"}; `
            + `10 feet inside it = ${Math.floor(10 / FEET_PER_TICK)} lots of its own ${(recipe?.onSuccess ?? []).find(o => o.kind === "damage")?.formula ?? "?"}; `
            + `the hit-point door took ${total} ${(hit?.finals ?? []).map(f => f.type).join("/") || "nothing"} `
            + `(waited for its dice: ${hit?.o?.dice === true ? "yes" : "no"}); card door: ${card ? "posted" : "nothing"}; `
            + `the old straight-to-the-actor path ran ${applied5.length - atA} time(s)`);
    }

    // ── 4. A repeat save asks the recipe, not the repeater ──
    const hold = spellOf(/^hold person$/i);
    const holdAct = actsOf(hold).find(a => a.type === "save") ?? null;
    const guard2 = spellOf(/^spirit guardians$/i, "2024");
    const guard2Act = actsOf(guard2).find(a => a.type === "save") ?? null;
    if (!holdAct) {
      check("4. Hold Person's repeat save asks the recipe (Phase 5)", null, "Varek has no Hold Person");
    } else {
      const holdRecipe = await recipeOf(hold, holdAct);
      const guardRecipe = guard2Act ? await recipeOf(guard2, guard2Act) : null;
      const paralysed = { id: "eff-p5", name: "Paralyzed", statuses: new Set(["paralyzed"]) };
      const meta = { ability: "wis", dc: 21, trigger: "endOfTurn", recipe: holdRecipe };
      const onMade = RepeatingSaveEngine._endsOnThisSave(paralysed, meta, true);
      const onFailed = RepeatingSaveEngine._endsOnThisSave(paralysed, meta, false);
      // An effect on BOTH results stays on a made save: the 2024 Spirit Guardians
      // halves a creature's speed whether it saves or not.
      const halfSpeed = { id: "eff-p5b", name: "Half Speed", statuses: new Set() };
      const stays = guardRecipe
        ? RepeatingSaveEngine._endsOnThisSave(halfSpeed, { ability: "wis", dc: 21, recipe: guardRecipe }, true)
        : null;
      // With no recipe the engine keeps its own answer, as every effect stamped
      // before today has.
      const old = RepeatingSaveEngine._endsOnThisSave(paralysed, { ability: "wis", dc: 21 }, true);
      const stamped = /repeatingSaveMeta = \(repeatTrigger[\s\S]{0,1200}?recipe:\s*recipe \?\? null/
        .test(readFileSync(`${ROOT}/Data/modules/ace-qol/scripts/save-engine.mjs`, "utf8"));
      check("4. a repeat save asks the recipe what its result means: Hold Person's paralysis ends on a made save, an effect the recipe keeps on both results does not, and an effect stamped before today keeps the old answer (Phase 5)",
        onMade.decided === true && onMade.ends === true && onFailed.decided === true && onFailed.ends === false
          && (!guardRecipe || (stays?.decided === true && stays?.ends === false))
          && old.decided === false && old.ends === true && stamped,
        `${hold.name}: a made save ${onMade.ends ? "ends" : "keeps"} the paralysis (${onMade.why}), a failed one `
          + `${onFailed.ends ? "ends" : "keeps"} it (${onFailed.why}); `
          + `${guardRecipe ? `the 2024 Spirit Guardians' Half Speed on a made save: ${stays?.ends ? "ends" : "stays"} (${stays?.why})` : "no 2024 Spirit Guardians to read"}; `
          + `an effect with no recipe: ${old.ends ? "ends on a made save, as before" : "changed"}; `
          + `the condition's stamp carries its recipe: ${stamped ? "yes" : "no"}`);
    }

    // ── 5. The road's own card is the card door's, and nothing else's ──
    {
      const src = readFileSync(`${ROOT}/Data/modules/ace-qol/scripts/road/run.mjs`, "utf8").replace(/\/\/.*$/gm, "");
      const raw = /ChatMessage\.create\s*\(/.test(src);
      const doors = /CardDoor\.post\(/.test(src) && /HpDoor\.damage\(/.test(src) && /ConditionDoor\.apply\(/.test(src);
      check("5. every card a trigger posts goes through the card door, and every landing through its own door (Phase 5)",
        !raw && doors && doorCalls.card.length > 0,
        `run.mjs: raw chat cards ${raw ? "left" : "none"}; it lands through the card, hit-point and condition doors: ${doors ? "yes" : "no"}; `
          + `cards posted through the card door in these pins: ${doorCalls.card.length}`);
    }
  } finally {
    HpDoor.damage = keep5.damage;
    ConditionDoor.apply = keep5.apply;
    CardDoor.post = keep5.post;
    game.scenes.get = keep5.scenes;
    canvas.tokens.placeables.length = 0;
    canvas.tokens.placeables.push(...keep5.placed);
    for (const a of made5) ACTORS.delete(a.id);
  }
}

/* ── PHASE 4: HEALS, SELF, UTILITY, CONTESTS ─────────────────────────────── */
// Johnny, 2026-09-15: "PHASE 4 — heals, self, utility, contests. Then stop." Done
// when the replay pins, on the live path: 1. Cure Wounds pressed with nobody
// targeted opens the picker, a creature at 0 hit points and unconscious is a valid
// target, and the dead are not needed for a heal; 2. a self buff applies through
// ConditionDoor with no extra targeting; 3. Grapple and Shove: 2014 a contest, 2024
// a Strength or Dexterity save, the edition from the item; 4. Raise Dead's picker
// includes the dead, killed for good included, the gate still refuses Killed for
// good, and Do it anyway still works; 5. cards touched go through CardDoor. Each
// runs ACE's own code (the gate's press, the spell pipeline's dispatch, the
// pickers, the resolvers, the contest, the save roll, the heal pipeline's hooks)
// on a stand-in scene; only the dialogs are stood in.
console.log(`\nPHASE 4: HEALS, SELF, UTILITY, CONTESTS`);
{
  const MOD = "ace-qol";
  const tick = () => new Promise(r => setTimeout(r, 0));
  const actsOf = (it) => [...(it?.system?.activities ?? [])];
  const { SpellTargetPicker } = await import(`${MODULE}/scripts/spell-target-picker.mjs`);
  const { HealTargetPicker } = await import(`${MODULE}/scripts/heal-target-picker.mjs`);
  const { HealPipeline } = await import(`${MODULE}/scripts/heal-pipeline.mjs`);
  const { CheckGate } = await import(`${MODULE}/scripts/check-gate.mjs`);
  const { ConditionDoor } = await import(`${MODULE}/scripts/road/doors.mjs`);
  const { rulesActionSave } = await import(`${MODULE}/scripts/inference/recipe.mjs`);

  // ── A stand-in scene: tokens the pickers, the gate and the doors find ──
  const SCENE = "replay-p4-scene";
  const docs = new Map();
  const setPath = (obj, key, v) => {
    const path = key.split(".");
    let o = obj;
    for (const p of path.slice(0, -1)) o = (o[p] ??= {});
    o[path[path.length - 1]] = v;
  };
  // ⚠️ A TOKEN CLASS, BECAUSE THE DEAD-TOKEN LOCK PATCHES ONE. It wraps setTarget
  // on CONFIG.Token.objectClass, and that patch is what stood in front of Raise
  // Dead's picker on 2026-09-15: it bails out of the targeting call to ask the GM
  // whether he meant that corpse, so the reticle he had just chosen never landed.
  // A stand-in token carrying its own setTarget would never meet the patch, and
  // the pin would pass on a road he cannot drive.
  class ReplayToken {
    setTarget(on, o = {}) {
      if (!on) { game.user.targets.delete(this); return; }
      if (o.releaseOthers) game.user.targets.clear();
      game.user.targets.add(this);
    }
  }
  const place = (actor, id, flags = {}) => {
    const doc = { id, actorId: actor.id, actor, parent: { id: SCENE }, flags, name: actor.name, hidden: false,
      x: 0, y: 0, width: 1, height: 1, elevation: 0, disposition: actor.type === "character" ? 1 : -1, texture: { src: "" },
      update: async (u) => { for (const [k, v] of Object.entries(u)) setPath(doc, k, v); return doc; } };
    const tok = Object.assign(new ReplayToken(), { id, name: actor.name, actor, document: doc,
      x: 0, y: 0, w: 100, h: 100, center: { x: 50, y: 50 } });
    doc.object = tok;
    docs.set(id, doc);
    canvas.tokens.placeables.push(tok);
    return tok;
  };
  const creature = (id, name, { type = "npc", hp = 30, max = 30, statuses = [], abilities = {}, skills = {}, death = null } = {}) => {
    const effects = new Collection();
    const a = { id, name, type, img: "", documentName: "Actor", uuid: `Actor.${id}`, statuses: new Set(statuses), effects,
      system: { attributes: { hp: { value: hp, max, temp: 0 }, death: death ?? { success: 0, failure: 0 }, prof: 2 },
        abilities: { str: { mod: 0, value: 10, save: { value: 0 } }, dex: { mod: 0, value: 10, save: { value: 0 } },
          con: { mod: 0, value: 10, save: { value: 0 } }, ...abilities },
        skills, details: { type: { value: "humanoid" } },
        traits: { ci: { value: [] }, di: { value: [] }, dr: { value: [] }, dv: { value: [] } } },
      items: new Collection(), isOwner: true, hasPlayerOwner: type === "character", prototypeToken: { actorLink: true },
      getFlag: () => undefined, getRollData: () => ({}),
      update: async (u) => { for (const [k, v] of Object.entries(u)) setPath(a, k, v); return a; } };
    for (const s of statuses) {
      const eff = { id: `eff-${id}-${s}`, name: s, statuses: new Set([s]), disabled: false,
        delete: async () => { effects.delete(eff.id); a.statuses.delete(s); return eff; } };
      effects.set(eff.id, eff);
    }
    ACTORS.set(id, a);
    return a;
  };

  const varek = firstActor(VAREK);
  const spell = (rx, ed) => (varek ? [...varek.items].find(i => i.type === "spell" && rx.test(i.name)
    && (!ed || i.system?.source?.rules === ed)) ?? null : null);
  const keep = { scenes: game.scenes.get, placed: [...canvas.tokens.placeables], show: SpellTargetPicker._showDialog,
    targets: game.user.targets, users: game.users, messages: game.messages, heal: SETTINGS.get("ace-qol.enableHealPipeline"),
    tokenClass: CONFIG.Token, confirm: foundry.applications.api.DialogV2.confirm };
  // The corpse question, live on the path, and every time it is asked, recorded.
  const asked = [];
  CONFIG.Token = { objectClass: ReplayToken };
  foundry.applications.api.DialogV2.confirm = async (o) => { asked.push(String(o?.window?.title ?? "a question")); return false; };
  const { DeadTokenLock } = await import(`${MODULE}/scripts/dead-token-lock.mjs`);
  await quiet(async () => { DeadTokenLock.register(); });
  // The picker's dialog, stood in: it records what it was given and picks as told.
  const shown = [];
  let choose = () => [];
  SpellTargetPicker._showDialog = async (o) => { shown.push(o); return choose(o); };
  game.scenes.get = (id) => (id === SCENE
    ? { id, tokens: { get: (t) => docs.get(t) ?? null, contents: [...docs.values()], find: (fn) => [...docs.values()].find(fn) } }
    : keep.scenes(id));
  game.user.targets = new Set();
  canvas.tokens.placeables.length = 0;
  const made = [];
  try {
    const varekTok = varek ? place(varek, "tok-varek") : null;
    const dying = creature("replay-p4-dying", "a dying ally", { type: "character", hp: 0, statuses: ["unconscious"],
      death: { success: 1, failure: 1 } });
    const ally = creature("replay-p4-ally", "a standing ally", { type: "character", hp: 20 });
    const corpse = creature("replay-p4-corpse", "a dead bandit", { hp: 0, max: 11 });
    const lost = creature("replay-p4-lost", "a beheaded bandit", { hp: 0, max: 11 });
    made.push(dying, ally, corpse, lost);
    place(dying, "tok-dying");
    place(ally, "tok-ally");
    place(corpse, "tok-corpse", { [MOD]: { isDead: true } });
    const lostTok = place(lost, "tok-lost", { [MOD]: { isDead: true, permanentlyDead: true, deathReason: "beheaded by a vorpal sword" } });
    const rowFor = (seen, a) => seen?.candidates?.find(c => c.actor === a) ?? null;
    const said = (c) => (!c ? "not offered" : c.valid ? `can be picked${c.badge ? ` (${c.badge})` : ""}` : `cannot (${c.why})`);

    // ── 1. Cure Wounds, pressed with nobody targeted ──
    const cure = spell(/^cure wounds$/i, "2024");
    const cureAct = actsOf(cure).find(a => a.type === "heal") ?? null;
    if (!varekTok || !cureAct) {
      check("1. Cure Wounds pressed with nobody targeted opens the picker (Phase 4)", null, "Varek has no 2024 Cure Wounds");
    } else {
      let gateSaid = [];
      await quiet(async () => { gateSaid = PressGate.judge(PressGate.contextFor(cureAct, {}), null); });
      const heals = [];
      const keepHeal = HpDoor.heal;
      HpDoor.heal = async (actor, amount, o) => { heals.push({ actor, amount }); return keepHeal.call(HpDoor, actor, amount, o); };
      choose = (o) => { const c = o.candidates.find(x => x.actor === dying && x.valid); return c ? [c.actor] : []; };
      const before = posted.length, at = shown.length;
      let err1 = null;
      try { await quiet(async () => { await SpellPipeline._dispatch(cureAct, { system: { spellLevel: 1 } }); }); }
      catch (e) { err1 = e; }
      finally { HpDoor.heal = keepHeal; }
      const seen = shown[at] ?? null;
      const card = posted.slice(before).find(p => /CURE WOUNDS/.test(String(p?.content ?? ""))) ?? null;
      const hp = dying.system.attributes;
      check("1. Cure Wounds pressed with nobody targeted opens the picker; a dying ally at 0 hit points can be picked, the dead cannot; the heal lands through the hit-point door (Phase 4)",
        !err1 && !gateSaid.some(s => s.verdict.refuse || s.verdict.ask) && !!seen && seen.preSelected.size === 0
          && rowFor(seen, dying)?.valid === true && !rowFor(seen, corpse)
          && heals.length === 1 && heals[0].actor === dying && hp.hp.value > 0 && hp.death.success === 0 && hp.death.failure === 0
          && !dying.statuses.has("unconscious") && !!card,
        err1 ? `threw: ${err1?.message ?? err1}`
          : `${varek.name}'s Cure Wounds: the gate ${gateSaid.length ? gateSaid.map(s => s.rule.id).join(", ") : "said nothing"}; `
            + `picker ${seen ? "opened" : "never opened"} with ${seen?.preSelected?.size ?? 0} picked beforehand; `
            + `the dying ally ${said(rowFor(seen, dying))}; the dead bandit ${said(rowFor(seen, corpse))} `
            + `(09-16: a corpse is off a heal list, not dimmed on it); `
            + `hit-point door ${heals.length}x, hit points 0 to ${hp.hp.value}, death saves ${hp.death.success}/${hp.death.failure}, `
            + `unconscious ${dying.statuses.has("unconscious") ? "still on" : "off"}; card ${card ? "posted" : "missing"}`);
    }

    // ── 2. A self buff, through the condition door, with no targeting ──
    const shield = spell(/^shield$/i, "2024");
    const armor = spell(/^mage armor$/i, "2024");
    const shieldAct = actsOf(shield)[0] ?? null, armorAct = actsOf(armor)[0] ?? null;
    if (!varekTok || !shieldAct || !armorAct) {
      check("2. a self buff goes on through the condition door (Phase 4)", null, "Varek has no 2024 Shield or Mage Armor");
    } else {
      const doorCalls = [];
      const keepDoor = { apply: ConditionDoor.apply, own: ConditionDoor.applyItemEffect };
      ConditionDoor.apply = async (actor, key) => { doorCalls.push({ how: "ACE's effect", actor, key }); return { ok: true, applied: key }; };
      ConditionDoor.applyItemEffect = async (item, actor, fx) => { doorCalls.push({ how: "its own effect", actor, key: fx?.name }); return { ok: true, name: fx?.name }; };
      const before = posted.length, at = shown.length;
      let err2 = null;
      try {
        await quiet(async () => {
          await SpellPipeline._dispatch(shieldAct, { system: { spellLevel: 1 } });
          await SpellPipeline._dispatch(armorAct, { system: { spellLevel: 1 } });
        });
      } catch (e) { err2 = e; }
      finally { ConditionDoor.apply = keepDoor.apply; ConditionDoor.applyItemEffect = keepDoor.own; }
      const cards = posted.slice(before).filter(p => /SHIELD|MAGE ARMOR/.test(String(p?.content ?? "")));
      check("2. a self buff goes on its caster through the condition door with no targeting: Shield, and the 2024 Mage Armor's own effect from its book (Phase 4)",
        !err2 && shown.length === at && doorCalls.length === 2 && doorCalls.every(c => c.actor === varek) && cards.length === 2
          && doorCalls.some(c => c.key === "Mage Armor" && c.how === "its own effect"),
        err2 ? `threw: ${err2?.message ?? err2}`
          : `${doorCalls.map(c => `${c.key} through the condition door (${c.how}) on ${c.actor?.name ?? "nobody"}`).join("; ") || "the door was never used"}; `
            + `pickers opened: ${shown.length - at}; cards: ${cards.length}`);
    }

    // ── 3. Grapple and shove, by the item's edition ──
    const holder = (name, rx) => [...ACTORS.values()].filter(a => a.name === name).map(a => [...a.items].find(i => rx.test(i.name))).find(Boolean) ?? null;
    const grapple14 = holder("Ireena Kolyana", /^grapple$/i);
    const g14Act = actsOf(grapple14)[0] ?? null;
    const strike24 = holder("Virric Vaesoldandros", /^unarmed strike/i);
    const g24Act = actsOf(strike24).find(a => a.type === "save" && /^grapple$/i.test(a.name ?? "")) ?? null;
    const strikeK = holder("Kasimir Velikov", /^unarmed strike/i);
    const gKAct = actsOf(strikeK).find(a => a.type === "utility" && /^grapple$/i.test(a.name ?? "")) ?? null;
    if (!g14Act || !g24Act || !gKAct) {
      check("3. grapple and shove by edition (Phase 4)", null, "Ireena's Grapple, Virric's or Kasimir's Unarmed Strike is missing");
    } else {
      let r14 = null, r24 = null, rK = null;
      await quiet(async () => {
        r14 = recipeForActivity(grapple14, g14Act, { actor: grapple14.actor })?.recipe ?? null;
        r24 = recipeForActivity(strike24, g24Act, { actor: strike24.actor })?.recipe ?? null;
        rK = recipeForActivity(strikeK, gKAct, { actor: strikeK.actor })?.recipe ?? null;
      });
      // The 2014 contest, live, against a clumsy goblin and a nimble one.
      const clumsy = creature("replay-p4-clumsy", "a clumsy goblin", { skills: { ath: { total: -3 }, acr: { total: -2 } } });
      const nimble = creature("replay-p4-nimble", "a nimble goblin", { skills: { ath: { total: 0 }, acr: { total: 9 } } });
      const quick = creature("replay-p4-quick", "a quick bandit", {
        abilities: { str: { mod: -1, value: 8, save: { value: -1 } }, dex: { mod: 4, value: 18, save: { value: 4 } } } });
      made.push(clumsy, nimble, quick);
      const clumsyTok = place(clumsy, "tok-clumsy"), nimbleTok = place(nimble, "tok-nimble");
      place(quick, "tok-quick");
      const condCalls = [];
      const keepApply = ConditionDoor.apply;
      ConditionDoor.apply = async (actor, key) => { condCalls.push({ actor, key }); return { ok: true, applied: key }; };
      let lostC = null, heldC = null, saved = null, err3 = null;
      try {
        await quiet(async () => {
          game.user.targets = new Set([clumsyTok]);
          lostC = await CheckGate.runContest(g14Act, r14);
          game.user.targets = new Set([nimbleTok]);
          heldC = await CheckGate.runContest(g14Act, r14);
          game.user.targets = new Set();
          // The 2024 save, live: each creature uses its better save.
          const engine = Object.create(SaveEngine.prototype);
          saved = await engine._rollSingleSave({ name: quick.name, tokenDocId: "tok-quick", sceneId: SCENE, actorId: quick.id,
            autoFailSave: false }, "str/dex", 13, r24, strike24.actor?.id ?? null, {});
        });
      } catch (e) { err3 = e; }
      finally { ConditionDoor.apply = keepApply; game.user.targets = new Set(); }
      const ruleSave = rulesActionSave(strikeK, gKAct, strikeK.actor);
      const onFail = (r) => (r?.onFail ?? []).map(o => o.condition?.key).filter(Boolean).join(", ") || "-";
      check("3. grapple and shove by the item's edition: Ireena's 2014 Grapple is a contest, each creature using its better check; the 2024 Grapple a Strength or Dexterity save, each creature using its better save (Phase 4)",
        !err3 && grapple14.system?.source?.rules === "2014" && r14?.decidedBy?.kind === "contest"
          && /ath vs ath\/acr/.test(r14.decidedBy.check ?? "") && onFail(r14) === "grappled"
          && strike24.system?.source?.rules === "2024" && r24?.decidedBy?.kind === "save" && r24.decidedBy.ability === "str/dex"
          && rK?.decidedBy?.kind === "save" && rK.decidedBy.ability === "str/dex" && onFail(rK) === "grappled" && !!ruleSave
          && lostC?.stood === false && lostC.target?.key === "acr" && condCalls.some(c => c.actor === clumsy && c.key === "grappled")
          && heldC?.stood === true && heldC.target?.key === "acr" && !condCalls.some(c => c.actor === nimble)
          && saved?.ability === "dex" && saved?.saveTotal === 5,
        err3 ? `threw: ${err3?.message ?? err3}`
          : `Ireena's Grapple (${grapple14.system?.source?.rules}): ${r14?.decidedBy?.kind} (${r14?.decidedBy?.check ?? "-"}), on a loss ${onFail(r14)}; `
            + `the clumsy goblin used ${lostC?.target?.key} ${lostC?.target?.total} against ${lostC?.grappler?.total} and ${lostC?.stood ? "held" : "lost"}, `
            + `put on: ${condCalls.filter(c => c.actor === clumsy).map(c => c.key).join(", ") || "nothing"}; `
            + `the nimble one used ${heldC?.target?.key} ${heldC?.target?.total} and ${heldC?.stood ? "held" : "lost"}. `
            + `Virric's Grapple (${strike24.system?.source?.rules}): save ${r24?.decidedBy?.ability}; Kasimir's bare Grapple: save ${rK?.decidedBy?.ability} `
            + `DC ${ruleSave?.dc?.value ?? "none"}, on a failure ${onFail(rK)}; the quick bandit saved with ${saved?.ability ?? "?"}, ${saved?.saveTotal ?? "?"} against 13`);
    }

    // ── 4. Raise Dead: the dead offered, Killed for good refused, Do it anyway ──
    const raise = spell(/^raise dead$/i, "2024");
    const raiseAct = actsOf(raise)[0] ?? null;
    if (!varekTok || !raiseAct) {
      check("4. Raise Dead's picker includes the dead (Phase 4)", null, "Varek has no 2024 Raise Dead");
    } else {
      const cards = new Map();
      game.users = Object.assign([GM], { activeGM: GM, get: (id) => (id === GM.id ? GM : null) });
      game.messages = { get: (id) => cards.get(id) ?? null };
      const presses = [];
      const keepUse = raiseAct.use;
      // dnd5e's use(), as far as the gate sees it: the press, and its use when it goes ahead.
      raiseAct.use = async () => {
        const messageConfig = {};
        let answer;
        await quiet(async () => { answer = PressGate.onPress(raiseAct, {}, {}, messageConfig); });
        presses.push({ answer, aimedAt: [...game.user.targets].map(t => t.name) });
        if (answer !== false) await quiet(async () => { await PressGate.onUsed(raiseAct, {}); });
        return answer;
      };
      choose = (o) => { const c = o.candidates.find(x => x.actor === lost && x.valid); return c ? [c.actor] : []; };
      const before = posted.length, at = shown.length;
      let first, overruled = false, err4 = null;
      try {
        await quiet(async () => { first = PressGate.onPress(raiseAct, {}, {}, {}); });
        for (let i = 0; i < 50 && !presses.length; i++) await tick();
        for (let i = 0; i < 10; i++) await tick();
        const refusal = posted.slice(before).find(p => p?.flags?.[MOD]?.type === "gateRefusal") ?? null;
        if (refusal) {
          const card = { id: "replay-p4-refusal", ...refusal, flags: JSON.parse(JSON.stringify(refusal.flags ?? {})),
            update: async (u) => {
              if (u.content !== undefined) card.content = u.content;
              for (const [scope, v] of Object.entries(u.flags ?? {})) card.flags[scope] = { ...(card.flags[scope] ?? {}), ...JSON.parse(JSON.stringify(v)) };
              return card;
            } };
          cards.set(card.id, card);
          await quiet(async () => {
            overruled = await PressGate.doItAnyway(card);
            await PressGate._onCardUpdated(card, { flags: { [MOD]: { gate: { status: card.flags[MOD].gate.status } } } }, {}, GM.id);
          });
        }
      } catch (e) { err4 = e; }
      finally { raiseAct.use = keepUse; }
      const offered = shown[at] ?? null;
      const refusal = posted.slice(before).find(p => p?.flags?.[MOD]?.type === "gateRefusal") ?? null;
      const refusedBy = (refusal?.flags?.[MOD]?.gate?.rules ?? []).map(r => r.name).join(", ");
      // The spell pipeline takes the corpse the gate judged, and asks nobody again.
      const at2 = shown.length;
      const askedDuringPick = asked.length;
      let piped = null;
      game.user.targets = new Set([lostTok]);
      await quiet(async () => {
        piped = await SpellPipeline._pickTargets({ entry: SpellPipeline._getEntry(raise), item: raise, actor: varek, castLevel: 5 }, "single-adjacent");
      });
      // And it lands: back with 1 hit point (both editions), through the hit-point door.
      const revived = [];
      const keepHeal4 = HpDoor.heal;
      HpDoor.heal = async (actor, amount, o) => { revived.push({ actor, amount, o }); return keepHeal4.call(HpDoor, actor, amount, o); };
      game.user.targets = new Set([lostTok]);
      try { await quiet(async () => { await SpellPipeline._dispatch(raiseAct, { system: { spellLevel: 5 } }); }); }
      finally { HpDoor.heal = keepHeal4; }
      game.user.targets = new Set();
      // A damage spell's picker still offers no corpse.
      const harm = SpellTargetPicker._buildCandidates(varekTok, varek, 60, false, "harm");
      const harmRow = (a) => harm.find(c => c.actor === a) ?? null;
      check("4. Raise Dead pressed with nobody targeted offers the dead, killed for good included; the gate still refuses Killed for good, and Do it anyway presses it through once (Phase 4)",
        !err4 && first === false && !!offered && rowFor(offered, corpse)?.valid === true && rowFor(offered, lost)?.valid === true
          && !rowFor(offered, ally) && !rowFor(offered, dying)
          && askedDuringPick === 0 && presses[0]?.aimedAt?.length === 1
          && presses[0]?.answer === false && refusedBy === "Killed for good"
          && overruled === true && presses.length === 2 && presses[1].answer !== false
          && lostTok.document.flags[MOD].permanentlyDead === false
          && piped?.targets?.[0]?.actor === lost && shown.length === at2
          && revived.length === 1 && revived[0].actor === lost && revived[0].o?.revive === true && lost.system.attributes.hp.value === 1
          && harmRow(corpse)?.valid === false && harmRow(lost)?.valid === false,
        err4 ? `threw: ${err4?.message ?? err4}`
          : `${varek.name}'s Raise Dead: the picker ${offered ? "opened" : "never opened"}; the dead bandit ${said(rowFor(offered, corpse))}; `
            + `the beheaded one ${said(rowFor(offered, lost))}; the standing ally ${said(rowFor(offered, ally))}; `
            + `the dying ally ${said(rowFor(offered, dying))}; it asked "are you sure" ${askedDuringPick}x while picking; `
            + `pressed again at ${presses[0]?.aimedAt?.join(", ") || "nobody"}: ${presses[0] ? (presses[0].answer === false ? `refused (${refusedBy || "no card"})` : "went through") : "never"}; `
            + `Do it anyway: ${overruled ? "overruled" : "not"}, pressed ${presses.length - 1}x after, the lock ${lostTok.document.flags[MOD].permanentlyDead ? "still on" : "off"}; `
            + `the pipeline took ${piped?.targets?.[0]?.name ?? "nobody"} and opened ${shown.length - at2} more picker(s); `
            + `Raise Dead brought it back with ${lost.system.attributes.hp.value} hit point(s) through the hit-point door (${revived.length}x); `
            + `a damage spell offers the dead bandit: ${harmRow(corpse)?.valid ? "yes" : "no"}, the beheaded one: ${harmRow(lost)?.valid ? "yes" : "no"}`);
    }

    // ── 6. The list is the dead, and ACE's own pick is never questioned ──
    // Johnny, 2026-09-15, with the modal standing over the picker: *"'Specter is
    // dead. Are you sure you want to target it?' It cancels the cast and refunds
    // the slot... It's a whole different ball game if I'm picking."* And: *"only
    // the dead should be in the list for targets."*
    if (varekTok) {
      const raise6 = spell(/^raise dead$/i, "2024") ?? spell(/^raise dead$/i);
      const heal6 = spell(/^cure wounds$/i, "2024") ?? spell(/^cure wounds$/i);
      const at6 = shown.length;
      let reviveList = null, healList = null, err6 = null;
      choose = () => [];
      try {
        await quiet(async () => {
          if (raise6) await SpellTargetPicker.pick({ spellItem: raise6, casterActor: varek, maxTargets: 1, rangeFt: 5, allowSelf: false, kind: "revive" });
          reviveList = shown[at6] ?? null;
          if (heal6) await SpellTargetPicker.pick({ spellItem: heal6, casterActor: varek, maxTargets: 1, rangeFt: 60, allowSelf: false, kind: "heal" });
          healList = shown[at6 + 1] ?? null;
        });
      } catch (e) { err6 = e; }
      const names = (seen) => (seen?.candidates ?? []).map(c => c.name).join(", ") || "nobody";
      const on = (seen, a) => !!(seen?.candidates ?? []).find(c => c.actor === a);
      const rowOf = (seen, a) => (seen?.candidates ?? []).find(c => c.actor === a) ?? null;
      // A stray click on the canvas is still asked about: the lock is for the mouse.
      const askedBefore = asked.length;
      game.user.targets = new Set();
      await quiet(async () => { lostTok.setTarget(true, {}); });
      const strayAsked = asked.length - askedBefore;
      const strayLanded = game.user.targets.has(lostTok);
      game.user.targets = new Set();
      check("6. Raise Dead lists the dead and nobody else, a heal still takes the dying, and ACE's own pick is never asked to confirm a corpse, though a stray click on one still is (09-15)",
        !err6 && !!reviveList && on(reviveList, corpse) && on(reviveList, lost)
          && !on(reviveList, ally) && !on(reviveList, dying) && !on(reviveList, varek)
          && !!healList && on(healList, dying) && on(healList, ally)
          && rowOf(healList, dying)?.valid === true && !on(healList, corpse)
          && strayAsked === 1 && strayLanded === false,
        err6 ? `threw: ${err6?.message ?? err6}`
          : `Raise Dead's list: ${names(reviveList)}; the heal's list: ${names(healList)} `
            + `(the dying ally ${rowOf(healList, dying)?.valid ? "can be healed" : "cannot"}, `
            + `the dead bandit ${on(healList, corpse) ? "is on the list" : "is not on the list at all"}); `
            + `a stray click on the beheaded bandit asked ${strayAsked}x and targeted ${strayLanded ? "it anyway" : "nothing until answered"}`);
    }

    // ── 5. Cards through the card door; the heal pipeline steers, never cancels ──
    {
      const read = (f) => readFileSync(`${ROOT}/Data/modules/ace-qol/scripts/${f}`, "utf8").replace(/\/\/.*$/gm, "");
      const files = ["heal-pipeline.mjs", "heal-card-renderer.mjs", "spell-pipeline/resolvers/heal.mjs",
        "spell-pipeline/resolvers/self.mjs", "check-gate.mjs"];
      const raw = files.filter(f => /ChatMessage\.create\s*\(/.test(read(f)));
      // A heal the heal pipeline owns (not the spell pipeline's), aimed at a creature, not a pool.
      let owned = null;
      for (const a of ACTORS.values()) {
        for (const it of a.items ?? []) {
          if (it.type === "spell" || SpellPipeline.owns?.(it)) continue;
          const act = actsOf(it).find(x => x.type === "heal" && !x.target?.template?.type
            && String(x.target?.affects?.type ?? "creature") !== "self" && !x.consumption?.scaling?.allowed);
          if (act) { owned = { a, it, act }; break; }
        }
        if (owned) break;
      }
      let steered = null, ownPick = null, err5 = null;
      if (owned) {
        const pre0 = (hooks["dnd5e.preUseActivity"] ?? []).length, post0 = (hooks["dnd5e.postUseActivity"] ?? []).length;
        const keepPick = HealTargetPicker.pick;
        SETTINGS.set("ace-qol.enableHealPipeline", true);
        try {
          await quiet(async () => {
            const hp5 = new HealPipeline();
            const pre = (hooks["dnd5e.preUseActivity"] ?? []).slice(pre0).pop();
            const post = (hooks["dnd5e.postUseActivity"] ?? []).slice(post0).pop();
            const usageConfig = { consume: { resources: true, spellSlot: false } }, dialogConfig = { configure: true }, messageConfig = {};
            const answer = pre?.(owned.act, usageConfig, dialogConfig, messageConfig);
            steered = { answer, usageConfig, dialogConfig, messageConfig, held: hp5._held.has(owned.act.uuid) };
            // Its own picker, with the same rule: the dying may be healed, the dead may not.
            HealTargetPicker.pick = async (activity, classification) => {
              const rows = HealTargetPicker._buildCandidates(activity.actor, varekTok, { ...classification, rangeFt: Infinity });
              ownPick = { dying: rows.find(r => r.token?.actor === dying) ?? null, corpse: rows.find(r => r.token?.actor === corpse) ?? null };
              return [];
            };
            post?.(owned.act, usageConfig);
            for (let i = 0; i < 50 && !ownPick; i++) await tick();
          });
        } catch (e) { err5 = e; }
        finally {
          HealTargetPicker.pick = keepPick;
          if (keep.heal === undefined) SETTINGS.delete("ace-qol.enableHealPipeline"); else SETTINGS.set("ace-qol.enableHealPipeline", keep.heal);
        }
      }
      check("5. every card these touched goes through the card door, and the heal pipeline steers dnd5e's use instead of cancelling it (Phase 4)",
        !raw.length && !!owned && !err5 && steered?.answer !== false && steered?.usageConfig?.subsequentActions === false
          && steered?.usageConfig?.consume?.resources === false && steered?.messageConfig?.create === false && steered?.held === true
          && ownPick?.dying?.valid === true && !ownPick?.corpse,
        err5 ? `threw: ${err5?.message ?? err5}`
          : `raw ChatMessage.create left: ${raw.join(", ") || "none"}; `
            + (owned ? `${owned.a.name}'s ${owned.it.name}: the press ${steered?.answer === false ? "was CANCELLED" : "went on"}, `
              + `dnd5e's own roll after ${steered?.usageConfig?.subsequentActions === false ? "off" : "on"}, its resources ${steered?.usageConfig?.consume?.resources === false ? "held" : "spent at once"}, `
              + `its usage card ${steered?.messageConfig?.create === false ? "not made" : "made"}; its picker: the dying ally ${ownPick?.dying?.valid ? "can be healed" : `cannot (${ownPick?.dying?.reason ?? "absent"})`}, `
              + `the dead bandit ${ownPick?.corpse?.valid ? "can be healed" : `cannot (${ownPick?.corpse?.reason ?? "absent"})`}`
              : "no heal the heal pipeline owns in this world"));
    }
  } finally {
    SpellTargetPicker._showDialog = keep.show;
    game.scenes.get = keep.scenes;
    canvas.tokens.placeables.length = 0;
    canvas.tokens.placeables.push(...keep.placed);
    if (keep.targets === undefined) delete game.user.targets; else game.user.targets = keep.targets;
    game.users = keep.users;
    game.messages = keep.messages;
    if (keep.tokenClass === undefined) delete CONFIG.Token; else CONFIG.Token = keep.tokenClass;
    foundry.applications.api.DialogV2.confirm = keep.confirm;
    for (const a of made) ACTORS.delete(a.id);
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
