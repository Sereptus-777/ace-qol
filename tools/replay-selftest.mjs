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
import { existsSync, cpSync, mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
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
// ⚠️ FOUNDRY'S COLLECTIONS ARE ITERABLE, AND THE STAND-IN'S WERE NOT. A boot
// sweep that walks `game.actors` or `game.scenes` (the reaction engine clears a
// stale "reaction used" flag on every creature at startup) threw
// "object is not iterable" from an unhandled promise, which killed the whole
// replay several checks later, nowhere near the cause (2026-09-16).
globalThis.game = { ready: true, packs: [], user: GM, users: Object.assign([GM], { activeGM: GM }),
  actors: { get: (id) => ACTORS.get(id) ?? null, contents: [], find: (fn) => [...ACTORS.values()].find(fn),
    [Symbol.iterator]: function* () { yield* ACTORS.values(); } },
  items: { get: () => null },
  scenes: { get: () => null, contents: [], [Symbol.iterator]: function* () {} },
  combat: null, time: { worldTime: 1000 },
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
// ⚠️🔴 TWO QUIETS AT ONCE KEPT THE CONSOLE SHUT FOR GOOD (2026-09-18). Each one
// saved the console as it found it and put that back when it finished. The
// countered-Fireball pin runs one while another is still going, so the second
// saved the FIRST one's muffler, finished last, and put the muffler back:
// every console.log after it, the golden record's list of changed items and
// the closing summary included, went into a counter. The release check said
// "read every change above" over a list that never printed. The first one in
// now keeps what it found, the last one out puts that back, and one that
// leaves while another still runs leaves the silence to it.
let quietDepth = 0, quietOuter = null;
const quiet = async (fn) => {
  const keep = { log: console.log, debug: console.debug, info: console.info, warn: console.warn };
  if (quietDepth++ === 0) quietOuter = keep;
  console.log = console.debug = console.info = () => { chatter.log++; };
  console.warn = (...a) => { chatter.warn++; if (chatter.samples.length < 5) chatter.samples.push(a.map(String).join(" ").slice(0, 240)); };
  try { return await fn(); } finally {
    if (--quietDepth === 0) Object.assign(console, quietOuter);
    else if (keep !== quietOuter) Object.assign(console, keep);
  }
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

/* ── PHASE 6d: ABSORB ELEMENTS ─────────────────────────────────────────────── */
// Johnny, 2026-09-17: "PHASE 6d - Absorb Elements only. Then stop." Fire, cold,
// lightning, acid or thunder hits Jebidiah; she holds Absorb Elements, a slot
// and a free reaction; a box asks. Yes spends the slot and the reaction, halves
// the damage she just took, and her next melee hit adds 1d6 of that type. No
// takes it in full. If she cannot use the spell, no box, and the console says why.
//
// ⚠️ THE +1d6 HAD NEVER BEEN DEALT. The reaction wrote a flag promising it and
// nothing in the suite ever read it. These pins drive the real reaction and the
// real damage roll that now reads it.
console.log(`\nPHASE 6d: ABSORB ELEMENTS`);
{
  const MOD = "ace-qol";
  const { ReactionEngine } = await import(`${MODULE}/scripts/reaction-engine.mjs`);
  const { DamageCalculator } = await import(`${MODULE}/scripts/damage-calculator.mjs`);
  const { CardDoor: Door6d } = await import(`${MODULE}/scripts/road/doors.mjs`);

  const keep6d = { post: Door6d.post, combat: game.combat, combats: game.combats,
    reactions: SETTINGS.get("ace-qol.enableReactions"), ae: SETTINGS.get("ace-qol.autoAbsorbElements") };
  SETTINGS.set("ace-qol.enableReactions", true);
  SETTINGS.set("ace-qol.autoAbsorbElements", true);
  Door6d.post = async (data) => ({ id: "ae-card", ...data });
  const made6d = [];

  try {
    const absorb = (prepared = 1) => ({ id: `it-ae-${prepared}`, name: "Absorb Elements", type: "spell", img: "",
      system: { level: 1, method: "spell", prepared, activities: [] } });
    const jeb = (id, { items = [absorb()], slots = 2, statuses = [], flags = {} } = {}) => {
      const a = { id, name: "Jebidiah", type: "character", img: "", documentName: "Actor", uuid: `Actor.${id}`,
        statuses: new Set(statuses), effects: [], items, hasPlayerOwner: true,
        system: { attributes: { hp: { value: 40, max: 40 } }, spells: { spell1: { value: slots, max: 3 } } },
        flags: { [MOD]: { ...flags } },
        getFlag: (scope, key) => a.flags?.[scope]?.[key],
        setFlag: async (scope, key, v) => { (a.flags[scope] ??= {})[key] = v; return a; },
        unsetFlag: async (scope, key) => { delete a.flags?.[scope]?.[key]; return a; },
        createEmbeddedDocuments: async () => [],
        update: async (u) => { for (const [k, v] of Object.entries(u)) {
          const path = k.split("."); let o = a;
          for (const s2 of path.slice(0, -1)) o = (o[s2] ??= {});
          o[path[path.length - 1]] = v; } return a; },
        getActiveTokens: () => [],
        getRollData: () => ({}),
      };
      ACTORS.set(id, a);
      made6d.push(a);
      return a;
    };
    const fire = () => [{ type: "fire", total: 28 }];

    const engine = new ReactionEngine();
    let answer = true;
    const asked = [];
    engine._promptReaction = async (o) => { asked.push(o.reactorActor?.name); return { accepted: answer, choiceData: { slotLevel: 1 } }; };
    engine._checkUncannyDodge = async () => ({ used: false });

    // ── 2 + 3. Fireball, the box, and Yes halves the fire ──
    {
      const her = jeb("ae-yes");
      answer = true;
      const atAsk = asked.length;
      const out = await quiet(() => engine.checkPreDamageReactions(fire(), her, null, null, null, true));
      const fireLeft = out?.modifiedComponents?.find(c => c.type === "fire")?.total;
      check("2+3. Fireball hits Jebidiah: the box asks, and Yes spends her slot and reaction and halves the fire she just took (Phase 6d)",
        asked.length - atAsk === 1 && fireLeft === 14
          && her.system.spells.spell1.value === 1 && her.flags[MOD]?.reactionUsed === true
          && her.flags[MOD]?.absorbElementsBonus?.type === "fire",
        `asked: ${asked.length - atAsk}; fire 28 -> ${fireLeft}; slots ${her.system.spells.spell1.value} of 3; `
          + `reaction ${her.flags[MOD]?.reactionUsed ? "spent" : "free"}; stored: ${her.flags[MOD]?.absorbElementsBonus?.formula ?? "nothing"} ${her.flags[MOD]?.absorbElementsBonus?.type ?? ""}`);
    }

    // ── 4. No: full damage, nothing stored ──
    {
      const her = jeb("ae-no");
      answer = false;
      const out = await quiet(() => engine.checkPreDamageReactions(fire(), her, null, null, null, true));
      const fireLeft = out?.modifiedComponents?.find(c => c.type === "fire")?.total;
      check("4. No: she takes the full 28 fire, keeps her slot and reaction, and nothing is stored for later (Phase 6d)",
        fireLeft === 28 && her.system.spells.spell1.value === 2
          && !her.flags[MOD]?.reactionUsed && !her.flags[MOD]?.absorbElementsBonus,
        `fire ${fireLeft}; slots ${her.system.spells.spell1.value}; reaction ${her.flags[MOD]?.reactionUsed ? "spent" : "free"}; `
          + `stored: ${her.flags[MOD]?.absorbElementsBonus ? "something (wrong)" : "nothing"}`);
    }

    // ── 5. No box, and the console says why ──
    {
      const said = [];
      const keepLog = console.log;
      console.log = (...a) => { said.push(a.join(" ")); };
      const atAsk = asked.length;
      try {
        answer = true;
        await engine.checkPreDamageReactions(fire(), jeb("ae-noslot", { slots: 0 }), null, null, null, true);
        await engine.checkPreDamageReactions(fire(), jeb("ae-unprep", { items: [absorb(0)] }), null, null, null, true);
        await engine.checkPreDamageReactions(fire(), jeb("ae-stunned", { statuses: ["stunned"] }), null, null, null, true);
        await engine.checkPreDamageReactions(fire(), jeb("ae-none", { items: [] }), null, null, null, true);
        await engine.checkPreDamageReactions([{ type: "slashing", total: 10 }], jeb("ae-sword"), null, null, null, true);
      } finally { console.log = keepLog; }
      const lines = said.filter(l => /Absorb Elements:/.test(l));
      check("5. no slot, not prepared, stunned: no box, and each one says why in the console (Phase 6d)",
        asked.length === atAsk
          && lines.some(l => /no 1st-level or higher slot/.test(l))
          && lines.some(l => /not prepared/.test(l))
          && lines.some(l => /out of the fight/.test(l)),
        `boxes shown: ${asked.length - atAsk}; the console: ${lines.map(l => l.replace(/^.*Absorb Elements: /, "")).join(" | ")}`);
      check("and somebody who never had the spell, or a sword cut, is not even mentioned (Phase 6d)",
        lines.length === 3, `${lines.length} line(s) for five hits`);
    }

    // ── HIS TABLE: a Fireball's SAVE CARD never asked ──
    // Johnny, 2026-09-17: "Aryel has Absorb Elements on her sheet. Neferon
    // Fireball. She failed the Dex save. Fire went on her. No Absorb Elements
    // box. Console has zero Absorb lines." Zero lines is the tell - not a
    // refusal, a check that never ran. The attack card asks before every hit;
    // the save card went straight to the hit-point door. This drives the real
    // APPLY ALL with the real reaction engine and pins what reaches the door.
    {
      const { SaveEngine: SE } = await import(`${MODULE}/scripts/save-engine.mjs`);
      const { HpDoor } = await import(`${MODULE}/scripts/road/doors.mjs`);
      const aryel = jeb("ae-aryel");
      aryel.name = "Aryel";
      const tokenDoc = { id: "tok-aryel", actor: aryel, object: { id: "tok-aryel", name: "Aryel", actor: aryel } };
      const keepScenes = game.scenes;
      game.scenes = { get: () => ({ tokens: { get: (id) => (id === "tok-aryel" ? tokenDoc : null) } }),
        contents: [], [Symbol.iterator]: function* () {} };
      const keepApi = game.aceQol?.reactionEngine;
      game.aceQol = game.aceQol ?? {};
      game.aceQol.reactionEngine = engine;

      const reached = [];
      const keepDoor = HpDoor.damage;
      HpDoor.damage = async (actor, finals) => { reached.push({ who: actor.name, finals }); return { hpDelta: 0 }; };

      const card = (id) => ({ id, flags: { [MOD]: {
          damageResults: [{ tokenDocId: "tok-aryel", targetId: aryel.id, sceneId: "s",
            byType: [{ type: "fire", value: 28 }], totalFinal: 28 }],
          damageTypes: ["fire"], itemUuid: null, actorId: null } },
        update: async () => ({}) });
      const saves = Object.create(SE.prototype);

      answer = true;
      const atAsk = asked.length;
      await quiet(() => saves._applyAllSaveDamage(card("m-yes")));
      const landedYes = reached.at(-1)?.finals?.find(f => f.type === "fire")?.final;
      check("HIS TABLE: a Fireball's save card now asks Absorb Elements BEFORE the hit points move, and Yes halves what lands (2026-09-17)",
        asked.length - atAsk === 1 && landedYes === 14
          && aryel.system.spells.spell1.value === 1 && aryel.flags[MOD]?.reactionUsed === true,
        `asked: ${asked.length - atAsk}; fire reaching the hit-point door: ${landedYes ?? "nothing"} of 28; `
          + `slots ${aryel.system.spells.spell1.value}; reaction ${aryel.flags[MOD]?.reactionUsed ? "spent" : "free"}`);

      // Spent now: the next Fireball lands in full and the console says why.
      const said = [];
      const keepLog = console.log;
      const fight = { started: true, round: 1, turn: 0, combatants: { contents: [{ actorId: aryel.id, actor: aryel }] } };
      game.combats = { contents: [fight] };
      console.log = (...a) => { said.push(a.join(" ")); };
      try { await saves._applyAllSaveDamage(card("m-spent")); }
      finally { console.log = keepLog; }
      game.combats = keep6d.combats;
      const landedSpent = reached.at(-1)?.finals?.find(f => f.type === "fire")?.final;
      check("and with her reaction spent the next one lands in full, and the console says why (2026-09-17)",
        landedSpent === 28 && said.some(l => /Absorb Elements: Aryel is not asked - its reaction is already spent/.test(l)),
        `fire reaching the door: ${landedSpent}; the console: ${said.filter(l => /Absorb/.test(l)).join(" | ") || "nothing (wrong)"}`);

      HpDoor.damage = keepDoor;
      game.scenes = keepScenes;
      if (keepApi === undefined) delete game.aceQol.reactionEngine; else game.aceQol.reactionEngine = keepApi;
    }

    // ── EVERY DOOR ASKS: his table, the second time ──
    // Johnny, 2026-09-17: "Absorb Elements does not appear at all... 0.34.51
    // claimed APPLY ALL asks the reaction reader. At this table it does not."
    // Damage reaches a creature by more than one door. Four of them write hit
    // points - the save card, the damage card's APPLY ALL, its per-type Apply,
    // and the road's triggers - and before tonight only the attack card's BUILD
    // asked anybody anything. They now share one helper, and it is pinned here
    // through the damage card's own writers, not the one I pinned last time.
    {
      const { DamageApplicator } = await import(`${MODULE}/scripts/damage-applicator.mjs`);
      const { HpDoor: Door2 } = await import(`${MODULE}/scripts/road/doors.mjs`);
      const keepApi2 = game.aceQol?.reactionEngine;
      game.aceQol = game.aceQol ?? {};
      game.aceQol.reactionEngine = engine;

      // The shared helper, as every door calls it.
      const her = jeb("ae-door");
      her.name = "Aryel";
      answer = true;
      const atAsk = asked.length;
      const out = await quiet(() => DamageApplicator._askDamageReactions(her, [{ type: "fire", final: 28 }],
        { where: "a pin" }));
      check("THE SHARED HELPER EVERY DAMAGE DOOR NOW CALLS asks Absorb Elements and hands back the halved fire (2026-09-17)",
        asked.length - atAsk === 1 && out?.[0]?.final === 14,
        `asked ${asked.length - atAsk}; 28 fire -> ${out?.[0]?.final}`);

      // A card whose damage type is spelled "Fire" - capital F, as some
      // importers write it - is still fire. The old test compared the raw
      // label and went quiet.
      const her2 = jeb("ae-door2");
      her2.name = "Aryel";
      const atAsk2 = asked.length;
      const out2 = await quiet(() => DamageApplicator._askDamageReactions(her2, [{ type: "Fire", final: 20 }],
        { where: "a pin" }));
      check("and a damage type written \"Fire\" with a capital is still fire, so she is still asked (2026-09-17)",
        asked.length - atAsk2 === 1 && out2?.[0]?.final === 10,
        `asked ${asked.length - atAsk2}; 20 Fire -> ${out2?.[0]?.final}`);

      // She holds the spell but the card's damage has no elemental type: that
      // is a refusal, and it is SAID, not a blank console.
      const her3 = jeb("ae-door3");
      her3.name = "Aryel";
      const said = [];
      const keepLog = console.log;
      console.log = (...a) => { said.push(a.join(" ")); };
      try { await DamageApplicator._askDamageReactions(her3, [{ type: "none", final: 20 }], { where: "a pin" }); }
      finally { console.log = keepLog; }
      check("a card whose damage carries no elemental type is a refusal she hears about, not a blank console (2026-09-17)",
        said.some(l => /Absorb Elements: Aryel is not asked - this damage is none/.test(l)),
        `the console: ${said.filter(l => /Absorb/.test(l)).join(" | ") || "nothing (wrong)"}`);

      // The damage card's APPLY ALL, driven for real: an entry the card did NOT
      // already ask about is asked; one it did ask about is not asked again.
      const reached2 = [];
      const keepDoor2 = Door2.damage;
      Door2.damage = async (actor, finals) => { reached2.push(finals.reduce((n, f) => n + (Number(f.final) || 0), 0)); return { hpDelta: 0 }; };
      const keepResolve = DamageApplicator.resolveTargetActor;
      const her4 = jeb("ae-door4"); her4.name = "Aryel";
      DamageApplicator.resolveTargetActor = () => her4;
      const cardOf = (asked2) => ({ id: `m-dmg-${asked2}`, flags: { [MOD]: {
          damageResults: [{ tokenDocId: "tok-a4", targetId: her4.id, name: "Aryel",
            components: [{ name: "Fireball", type: "fire", raw: 28, final: 28 }],
            totalFinal: 28, reactionsAsked: asked2 }] } },
        update: async () => ({}), setFlag: async () => ({}) });
      const atAsk4 = asked.length;
      await quiet(() => DamageApplicator.applyDamage(cardOf(false)));
      const askedUnmarked = asked.length - atAsk4;
      const landedUnmarked = reached2.at(-1);
      her4.flags[MOD].reactionUsed = false;
      her4.system.spells.spell1.value = 2;
      const atAsk5 = asked.length;
      await quiet(() => DamageApplicator.applyDamage(cardOf(true)));
      const askedMarked = asked.length - atAsk5;
      DamageApplicator.resolveTargetActor = keepResolve;
      Door2.damage = keepDoor2;
      check("the damage card's APPLY ALL asks when the card has not, and never asks twice when it already did (2026-09-17)",
        askedUnmarked === 1 && landedUnmarked === 14 && askedMarked === 0,
        `not yet asked: box ${askedUnmarked ? "shown" : "NOT shown (wrong)"}, ${landedUnmarked} reached the door; `
          + `already asked at build: ${askedMarked ? "asked AGAIN (wrong)" : "not asked again"}`);

      if (keepApi2 === undefined) delete game.aceQol.reactionEngine; else game.aceQol.reactionEngine = keepApi2;
    }

    // ── THE BUTTON HE ACTUALLY PRESSES ──
    // Johnny, 2026-09-17, the third time: "The path is
    // SaveEngine._completeSaveResultsPhase2 -> _rollSpellDamage ->
    // SaveActivity.rollDamage. That is not APPLY ALL on a damage card. You still
    // have not hooked the button I actually press." My two pins before this one
    // drove APPLY buttons. This one drives the ROLL DAMAGE handler itself, so it
    // cannot pass on a door he never uses.
    {
      const { SaveEngine: SE2 } = await import(`${MODULE}/scripts/save-engine.mjs`);
      const aryel2 = jeb("ae-phase2");
      aryel2.name = "Aryel";
      const tokenDoc2 = { id: "tok-p2", actor: aryel2, object: { id: "tok-p2", name: "Aryel", actor: aryel2 } };
      const keepScenes2 = game.scenes;
      game.scenes = { get: () => ({ tokens: { get: (id) => (id === "tok-p2" ? tokenDoc2 : null) } }),
        contents: [], [Symbol.iterator]: function* () {} };
      const keepApi3 = game.aceQol?.reactionEngine;
      game.aceQol = game.aceQol ?? {};
      game.aceQol.reactionEngine = engine;

      const saves2 = Object.create(SE2.prototype);
      saves2._rollSpellDamage = async () => [{ total: 28, type: "fire", formula: "8d6" }];
      saves2._buildPhase2CardHtml = () => "<div>phase 2</div>";
      saves2._deleteInstantTemplate = async () => {};
      const fireball = { id: "it-fb-p2", name: "Fireball", type: "spell", uuid: "Item.fb-p2", system: { level: 3 } };
      const keepFromUuid = globalThis.fromUuid;
      globalThis.fromUuid = async () => fireball;

      let written = null;
      const msg = { id: "m-phase2",
        flags: { [MOD]: { phase: 1, hasDamage: true, itemUuid: fireball.uuid, itemId: fireball.id, actorId: null,
          saveAbility: "dex", saveDC: 15, halfOnSave: true, damageTypes: ["fire"], isSpell: true, spellLevel: 3,
          // A Fireball's recipe, as the card carries one: a Dex save, the fire on
          // a failure, half on a success. Without it the row reads as 0 damage
          // and there is nothing to be asked about.
          recipe: { decidedBy: { kind: "save", ability: "dex" },
            onFail: [{ kind: "damage", formula: "8d6", type: "fire", onSuccess: "half" }], onSuccess: [] },
          allResults: [{ actorId: aryel2.id, tokenDocId: "tok-p2", sceneId: "s", passed: false,
            currentHP: 40, damageModifiers: {} }] } },
        update: async (u) => { written = u; return msg; } };

      answer = true;
      const atAsk = asked.length;
      let err = null;
      try { await quiet(() => saves2._completeSaveResultsPhase2(msg)); } catch (e) { err = e; }
      const row = written?.[`flags.${MOD}.damageResults`]?.[0] ?? null;
      check("THE BUTTON HE PRESSES: rolling a Fireball's damage on the save card asks Aryel for Absorb Elements before anything lands, and the halved fire is what the card now carries (2026-09-17)",
        !err && asked.length - atAsk === 1 && row?.totalFinal === 14 && row?.reactionsAsked === true,
        err ? `threw: ${err?.message ?? err}`
          : `asked: ${asked.length - atAsk}; the row the card stored: ${row ? `${row.totalFinal} (asked ${row.reactionsAsked})` : "none"}`);

      globalThis.fromUuid = keepFromUuid;
      game.scenes = keepScenes2;
      if (keepApi3 === undefined) delete game.aceQol.reactionEngine; else game.aceQol.reactionEngine = keepApi3;
    }

    // ── 3b. Her next melee HIT adds the stored 1d6 fire, on her turn ──
    {
      const her = jeb("ae-hit");
      her.flags[MOD].absorbElementsBonus = { type: "fire", formula: "1d6", slotLevel: 1, round: 3 };
      const dagger = { id: "it-dagger", name: "Dagger", type: "weapon", img: "", actor: her,
        system: { activities: { a1: { id: "a1", type: "attack", attack: { type: { value: "melee" } } } } } };
      const fight = { started: true, round: 4, turn: 0, combatant: { actor: her } };
      game.combat = fight;
      let comps = [];
      const keepRoll = DamageCalculator.rollWithCrit;
      DamageCalculator.rollWithCrit = async (formula) => ({ formula, total: 4, normalTotal: 4, critTotal: 0, roll: null });
      const keepRoad = DamageCalculator._attackRoad;
      DamageCalculator._attackRoad = async () => null;
      try {
        comps = await quiet(() => DamageCalculator.rollDamageComponents(dagger, her, {}, false, "double", "a1"));
      } catch (_) { comps = []; }
      DamageCalculator.rollWithCrit = keepRoll;
      DamageCalculator._attackRoad = keepRoad;
      const extra = (comps ?? []).find(c => c.name === "Absorb Elements");
      check("3. her next melee hit, on her own turn, adds the stored 1d6 fire to that hit, and the spell ends (Phase 6d)",
        !!extra && extra.type === "fire" && extra.formula === "1d6" && !her.flags[MOD]?.absorbElementsBonus,
        `on the hit: ${extra ? `+${extra.total} ${extra.type} (${extra.formula})` : "nothing added (wrong)"}; `
          + `still stored afterwards: ${her.flags[MOD]?.absorbElementsBonus ? "yes (wrong)" : "no"}`);
      game.combat = keep6d.combat;
    }

    // ── And not on somebody else's turn, and not a round late ──
    {
      const her = jeb("ae-late");
      her.flags[MOD].absorbElementsBonus = { type: "fire", formula: "1d6", slotLevel: 1, round: 3 };
      const dagger = { id: "it-dagger2", name: "Dagger", type: "weapon", img: "", actor: her,
        system: { activities: { a1: { id: "a1", type: "attack", attack: { type: { value: "melee" } } } } } };
      const keepRoll = DamageCalculator.rollWithCrit;
      DamageCalculator.rollWithCrit = async (formula) => ({ formula, total: 4, normalTotal: 4, critTotal: 0, roll: null });
      const keepRoad = DamageCalculator._attackRoad;
      DamageCalculator._attackRoad = async () => null;
      const other = { id: "ae-other", name: "somebody else" };
      game.combat = { started: true, round: 3, turn: 1, combatant: { actor: other } };
      let a = [];
      try { a = await quiet(() => DamageCalculator.rollDamageComponents(dagger, her, {}, false, "double", "a1")); } catch (_) {}
      const onOthers = !(a ?? []).some(c => c.name === "Absorb Elements") && !!her.flags[MOD]?.absorbElementsBonus;
      game.combat = { started: true, round: 6, turn: 0, combatant: { actor: her } };
      let b = [];
      try { b = await quiet(() => DamageCalculator.rollDamageComponents(dagger, her, {}, false, "double", "a1")); } catch (_) {}
      const tooLate = !(b ?? []).some(c => c.name === "Absorb Elements") && !her.flags[MOD]?.absorbElementsBonus;
      DamageCalculator.rollWithCrit = keepRoll;
      DamageCalculator._attackRoad = keepRoad;
      game.combat = keep6d.combat;
      check("and it is not spent on somebody else's turn, and it runs out once her next turn has gone by (Phase 6d)",
        onOthers && tooLate,
        `a hit during somebody else's turn: ${onOthers ? "nothing added, still stored" : "WRONG"}; `
          + `three rounds later: ${tooLate ? "ran out unused" : "still added (wrong)"}`);
    }
  } finally {
    Door6d.post = keep6d.post;
    game.combat = keep6d.combat;
    game.combats = keep6d.combats;
    for (const [k, v] of Object.entries({ "ace-qol.enableReactions": keep6d.reactions,
      "ace-qol.autoAbsorbElements": keep6d.ae })) {
      if (v === undefined) SETTINGS.delete(k); else SETTINGS.set(k, v);
    }
    for (const a of made6d) ACTORS.delete(a.id);
  }
}

/* ── PHASE 6c: THE OPPORTUNITY ATTACK ────────────────────────────────────── */
// Johnny, 2026-09-17: "PHASE 6c - opportunity attack only. Then stop." Somebody
// leaves a creature's reach on foot; that creature can act, has a reaction and
// has something to swing, so it is asked. Yes swings once, on the same road as
// any other attack. Disengage, a teleport, a spent reaction or a creature that
// is out of the fight get no pop-up, and the log says which.
//
// ⚠️ THE MACHINERY WAS ALREADY THERE, as it was for Shield and Counterspell. The
// detection is thorough - edge-to-edge reach in three dimensions, sub-cell
// snapping, Polearm Master on both editions, forced movement excluded - and Take
// OA already fires a real attack through the pipeline. What it did not have was
// the teleport rule, the two shared readers, and a word for any of its refusals.
console.log(`\nPHASE 6c: THE OPPORTUNITY ATTACK`);
{
  const MOD = "ace-qol";
  const { OAPrompt } = await import(`${MODULE}/scripts/oa-prompt.mjs`);

  const keep6c = { placed: [...canvas.tokens.placeables], combats: game.combats,
    prompt: OAPrompt._postPromptCard, scene: canvas.scene,
    on: SETTINGS.get("ace-qol.opportunityAttackPrompt"),
    reach: SETTINGS.get("ace-qol.opportunityAttackReach") };
  SETTINGS.set("ace-qol.opportunityAttackPrompt", true);
  SETTINGS.set("ace-qol.opportunityAttackReach", 5);
  canvas.tokens.placeables.length = 0;
  const made6c = [];
  const offered = [];
  OAPrompt._postPromptCard = async (reactorActor) => { offered.push(reactorActor?.name ?? "?"); };

  try {
    // A weapon as a sheet carries one: an attack activity that is not ranged is
    // what makes it swingable (see _isMeleeCapable).
    const sword = { id: "it-oa-sword", name: "Longsword", type: "weapon", img: "",
      system: { equipped: true, type: { value: "martialM" },
        activities: { a1: { type: "attack", attack: { type: { value: "melee" } } } } } };
    const fighter = (id, name, { at = [0, 0], disposition = -1, statuses = [],
      hp = 30, items = [sword], flags = {} } = {}) => {
      const a = { id, name, type: "npc", img: "", documentName: "Actor", uuid: `Actor.${id}`,
        statuses: new Set(statuses), effects: { contents: [] }, items, hasPlayerOwner: false,
        system: { attributes: { hp: { value: hp, max: 30 } }, abilities: {}, details: {} },
        flags: { [MOD]: { ...flags } },
        getFlag: (scope, key) => a.flags?.[scope]?.[key],
        setFlag: async (scope, key, v) => { (a.flags[scope] ??= {})[key] = v; return a; },
        getActiveTokens: () => canvas.tokens.placeables.filter(t => t.actor?.id === id),
      };
      ACTORS.set(id, a);
      made6c.push(a);
      const doc = { id: `tok-${id}`, actorId: id, actor: a, name, x: at[0], y: at[1],
        width: 1, height: 1, elevation: 0, hidden: false, disposition,
        texture: { src: "" }, movement: { action: "walk" } };
      const tok = { id: `tok-${id}`, name, actor: a, document: doc, x: at[0], y: at[1],
        w: 100, h: 100, center: { x: at[0] + 50, y: at[1] + 50 } };
      doc.object = tok;
      canvas.tokens.placeables.push(tok);
      return a;
    };

    // Neferon stands still; somebody walks out of his reach.
    const neferon = fighter("oa-neferon", "Neferon", { at: [0, 0], disposition: -1 });
    const walker  = fighter("oa-walker", "the one walking away", { at: [100, 0], disposition: 1 });
    const walkerDoc = canvas.tokens.placeables.find(t => t.actor?.id === walker.id).document;
    const away = { x: 500, y: 0 };

    const said = [];
    const withLog = async (fn) => {
      const keepLog = console.log;
      console.log = (...a) => { said.push(a.join(" ")); };
      try { return await fn(); } finally { console.log = keepLog; }
    };

    // ── 1. He is asked ──
    offered.length = 0; said.length = 0;
    await withLog(() => OAPrompt._checkProvocations(walkerDoc, away));
    check("1. somebody walks out of Neferon's reach and Neferon is asked (Phase 6c)",
      offered.length === 1 && offered[0] === "Neferon",
      `offered to: ${offered.join(", ") || "nobody"}`);

    // ── 4a. Disengage ──
    offered.length = 0; said.length = 0;
    walker.effects.contents = [{ flags: { [MOD]: { disengage: true } }, disabled: false }];
    await withLog(() => OAPrompt._checkProvocations(walkerDoc, away));
    check("4. Disengage: no pop-up, and the log says that is why (Phase 6c)",
      offered.length === 0 && said.some(l => /Disengaged/.test(l)),
      `offered: ${offered.length}; the log said: ${said.join(" | ") || "nothing"}`);
    walker.effects.contents = [];

    // ── 4b. A teleport out ──
    offered.length = 0; said.length = 0;
    walkerDoc.movement = { action: "displace" };
    await withLog(() => OAPrompt._checkProvocations(walkerDoc, away));
    check("4. Misty Step out of reach: no pop-up, because a teleport is not moving out of anybody's reach (Phase 6c)",
      offered.length === 0 && said.some(l => /displace/.test(l)),
      `offered: ${offered.length}; the log said: ${said.join(" | ") || "nothing"}`);
    walkerDoc.movement = { action: "walk" };

    // ── 4c. The reaction is already spent, in a fight ──
    offered.length = 0; said.length = 0;
    const fight = { started: true, round: 1, turn: 0,
      combatants: { contents: [{ actorId: neferon.id, actor: neferon }] } };
    game.combats = { contents: [fight] };
    neferon.flags[MOD].reactionUsed = true;
    await withLog(() => OAPrompt._checkProvocations(walkerDoc, away));
    check("4. his reaction is already spent this round: no pop-up, and the log says which (Phase 6c)",
      offered.length === 0 && said.some(l => /reaction is already spent/.test(l)),
      `offered: ${offered.length}; the log said: ${said.join(" | ") || "nothing"}`);

    // ⚠️ AND OUT OF COMBAT THAT FLAG MEANS NOTHING, because nothing ever clears
    // it outside a fight - the hook that clears it is the turn change.
    offered.length = 0; said.length = 0;
    game.combats = { contents: [] };
    await withLog(() => OAPrompt._checkProvocations(walkerDoc, away));
    check("and out of combat a stale reaction flag does not forbid it forever (Phase 6c)",
      offered.length === 1,
      `offered: ${offered.join(", ") || "nobody"}`);
    neferon.flags[MOD].reactionUsed = false;
    game.combats = { contents: [fight] };

    // ── 5. Out of the fight ──
    for (const st of ["dead", "unconscious", "stunned", "paralyzed", "petrified", "incapacitated"]) {
      offered.length = 0;
      neferon.statuses = new Set([st]);
      // A real corpse is at zero hit points as well as carrying the status, and
      // the shared reader asks about both - a stand-in that sets only the status
      // is not the shape his world has.
      neferon.system.attributes.hp.value = (st === "dead" || st === "unconscious") ? 0 : 30;
      await withLog(() => OAPrompt._checkProvocations(walkerDoc, away));
      if (offered.length) {
        check(`5. a ${st} creature is not asked for an opportunity attack (Phase 6c)`, false,
          `offered to ${offered.join(", ")}`);
        break;
      }
    }
    neferon.statuses = new Set();
    neferon.system.attributes.hp.value = 30;
    check("5. dead, unconscious, stunned, paralyzed, petrified and incapacitated are all refused, by the one reader (Phase 6c)",
      true, "none of the six is asked");

    // ── Nothing to swing ──
    offered.length = 0; said.length = 0;
    neferon.items = [];
    await withLog(() => OAPrompt._checkProvocations(walkerDoc, away));
    check("a creature with nothing to swing is not asked, and the log says so (Phase 6c)",
      offered.length === 0 && said.some(l => /nothing to swing/.test(l)),
      `offered: ${offered.length}; the log said: ${said.join(" | ") || "nothing"}`);
    neferon.items = [sword];

    // ── 3. Walking INTO reach, or an ally leaving, is not a provocation ──
    offered.length = 0;
    await withLog(() => OAPrompt._checkProvocations(walkerDoc, { x: 100, y: 0 }));
    check("3. staying inside his reach provokes nothing (Phase 6c)",
      offered.length === 0, `offered: ${offered.length}`);

    // ── 2. Yes swings for real, on the same road as any other attack ──
    {
      const src = readFileSync(`${ROOT}/Data/modules/ace-qol/scripts/oa-prompt.mjs`, "utf8");
      const fires = /fireOAAttack\(reactor, moverToken\)/.test(src);
      const spends = /setFlag\?\.\(MODULE_ID, "reactionUsed", true\)/.test(src);
      const body = src.slice(src.indexOf("static async fireOAAttack"));
      const realAttack = /item\.use\(|use\(\{/.test(body.slice(0, 3000));
      check("2. Take OA fires a real attack through the pipeline and spends the reaction; it does not just announce one (Phase 6c)",
        fires && spends && realAttack,
        `the button calls the attack: ${fires}; the reaction is spent: ${spends}; `
          + `it uses the weapon rather than only firing a hook: ${realAttack}`);
    }

    // ── WHO SEES THE CARD: one person, and only them ──
    // Johnny, 2026-09-18: "Opportunity attack posts in GM chat AND the player's
    // chat when the owner is connected. Owner connected: box / card only on
    // that player's client. Nothing in GM chat. Owner offline or no owner: GM
    // gets it. Same rule you already use for Counterspell."
    //
    // ⚠️ FOUNDRY DECIDES WHO SEES A WHISPER, SO THE PIN ASKS FOUNDRY'S RULE, as
    // V13 writes it (client/documents/chat-message.mjs, `get visible`): a
    // whispered card that is not a roll is drawn for its AUTHOR and its
    // recipients, nobody else. A card whose author is not set was written by
    // the client that posted it, which is the GM's.
    {
      const seenBy = (card, user) => {
        const whisper = card?.whisper ?? [];
        if (!whisper.length) return true;
        return (card.author ?? GM.id) === user.id || whisper.includes(user.id);
      };
      const TOMMY = { id: "oa-tommy", isGM: false, name: "Tommy", active: true };
      const keepWho = { users: game.users, messages: game.messages, create: ChatMessage.create, gmActive: GM.active };
      game.users = Object.assign([GM, TOMMY],
        { activeGM: GM, get: (id) => [GM, TOMMY].find(u => u.id === id) ?? null });
      GM.active = true;
      const post = keep6c.prompt;
      let made = null;
      ChatMessage.create = async (d) => (made = await keepWho.create(d));
      try {
        const jeb = fighter("oa-jeb", "Jebidiah", { at: [200, 0], disposition: 1 });
        jeb.ownership = { default: 0, [TOMMY.id]: 3 };
        jeb.hasPlayerOwner = true;
        const jebDoc = canvas.tokens.placeables.find(t => t.actor?.id === jeb.id).document;
        const nefDoc = canvas.tokens.placeables.find(t => t.actor?.id === neferon.id).document;

        // Tommy is connected: the card is his alone.
        said.length = 0;
        await withLog(() => post(jeb, neferon, jebDoc, nefDoc));
        const mine = made;
        check("a connected player's opportunity attack is on that player's screen only, and not in the GM's chat (2026-09-18)",
          !!mine && seenBy(mine, TOMMY) && !seenBy(mine, GM),
          `Tommy sees it: ${seenBy(mine, TOMMY)}; the GM sees it: ${seenBy(mine, GM)} `
            + `(written as ${mine?.author ?? "the GM"}, whispered to ${(mine?.whisper ?? []).join(", ") || "everybody"})`);
        check("and the log says who was asked and why (2026-09-18)",
          said.some(l => /Tommy owns it and is connected/.test(l)),
          `the log: ${said.filter(l => /opportunity attack/.test(l)).join(" | ") || "nothing"}`);

        // The GM's client holds the card it does not draw, and flips it when
        // Tommy's answer comes back over the socket.
        game.messages = { get: (id) => (mine?.id === id ? mine : null) };
        await withLog(() => OAPrompt.resolveOAPrompt(mine?.id, "passed"));
        check("when Tommy answers, the GM's client still flips his card, without ever drawing it (2026-09-18)",
          /Passed/.test(String(mine?.content ?? "")),
          /Passed/.test(String(mine?.content ?? "")) ? "his card now reads Passed" : "his card was never flipped");

        // Tommy is offline: the GM gets it, and Tommy does not come back to it.
        TOMMY.active = false;
        made = null;
        await withLog(() => post(jeb, neferon, jebDoc, nefDoc));
        check("her owner offline: the GM gets it, and the offline owner does not come back to a stale card (2026-09-18)",
          !!made && seenBy(made, GM) && !seenBy(made, TOMMY),
          `the GM sees it: ${seenBy(made, GM)}; Tommy sees it: ${seenBy(made, TOMMY)}`);

        // Nobody owns it: the GM gets it.
        made = null;
        await withLog(() => post(neferon, jeb, nefDoc, jebDoc));
        check("no player owns it: the GM gets it (2026-09-18)",
          !!made && seenBy(made, GM) && !seenBy(made, TOMMY),
          `the GM sees it: ${seenBy(made, GM)}; Tommy sees it: ${seenBy(made, TOMMY)}`);

        // The same answer Counterspell gets, because it is the same file.
        const { ReactionEngine: RE6c } = await import(`${MODULE}/scripts/reaction-engine.mjs`);
        const eng6c = new RE6c();
        const answers = [];
        for (const [online, who, want] of [[true, jeb, TOMMY.id], [false, jeb, GM.id], [true, neferon, GM.id]]) {
          TOMMY.active = online;
          answers.push(eng6c._getOwnerUserId(who) === want);
        }
        const src = readFileSync(`${ROOT}/Data/modules/ace-qol/scripts/oa-prompt.mjs`, "utf8");
        check("the same rule as Counterspell: both ask one file and route the same three cases the same way (2026-09-18)",
          answers.every(Boolean) && /from "\.\/who-answers\.mjs"/.test(src),
          `Counterspell's routing: ${answers.map(a => (a ? "same" : "DIFFERENT")).join(", ")}; `
            + `the OA asks the shared file: ${/from "\.\/who-answers\.mjs"/.test(src)}`);

        // One GM posts it. The hook fires on every client, and two GMs each
        // posting a card put the same question in front of the player twice.
        const at = src.indexOf('Hooks.on("updateToken"');
        const hookHead = at >= 0 ? src.slice(at, at + 700) : "";
        const oneGM = /game\.users\?\.activeGM !== game\.user\) return;/.test(hookHead)
          && !/if \(!game\.user\.isGM\) return;/.test(hookHead);
        check("only one GM posts the card, so a player is never asked the same thing twice (2026-09-18)",
          oneGM,
          !hookHead ? "the updateToken hook was not found"
            : oneGM ? "the detector runs on the active GM only" : "the detector runs on EVERY GM, so two GMs post two cards");
      } finally {
        game.users = keepWho.users;
        game.messages = keepWho.messages;
        ChatMessage.create = keepWho.create;
        if (keepWho.gmActive === undefined) delete GM.active; else GM.active = keepWho.gmActive;
      }
    }
  } finally {
    OAPrompt._postPromptCard = keep6c.prompt;
    game.combats = keep6c.combats;
    canvas.scene = keep6c.scene;
    canvas.tokens.placeables.length = 0;
    canvas.tokens.placeables.push(...keep6c.placed);
    for (const [k, v] of Object.entries({ "ace-qol.opportunityAttackPrompt": keep6c.on,
      "ace-qol.opportunityAttackReach": keep6c.reach })) {
      if (v === undefined) SETTINGS.delete(k); else SETTINGS.set(k, v);
    }
    for (const a of made6c) ACTORS.delete(a.id);
  }
}

/* ── FEATHER FALL, THROUGH THE ONE REACTION DOOR ────────────────────────── */
// Found 2026-09-18 while fixing the red banner, and every fault is pinned here:
//  - the box had never opened: its details were a sentence, the box maps a
//    list of rows, and the throw was caught as "treated as a decline";
//  - its answer was read with `!!`, and the box answers with an object on a
//    yes and a no alike, so "Let them fall" would have caught them;
//  - it bypassed the one reaction door, so the box would open on the GM's
//    screen and never on the caster's player's;
//  - nothing spent the reaction or the slot;
//  - an exact name match never found a 2014 "Feather Fall (Legacy)";
//  - the one falling could not catch itself, which both editions allow;
//  - the 2024 spell's "a creature you can see" was never asked.
// This drives the real offer and the real door; only the two ends of the door
// (this screen, or a player's over the socket) and the card are stood in.
console.log(`\nFEATHER FALL, THROUGH THE ONE REACTION DOOR`);
{
  const MOD = "ace-qol";
  const { FallPipeline } = await import(`${MODULE}/scripts/fall-pipeline.mjs`);
  const { ReactionEngine: REff } = await import(`${MODULE}/scripts/reaction-engine.mjs`);
  const { CardDoor: DoorFF } = await import(`${MODULE}/scripts/road/doors.mjs`);

  const keepFF = { placed: [...canvas.tokens.placeables], users: game.users, api: game.aceQol?.reactionEngine,
    post: DoorFF.post, gmActive: GM.active, log: console.log, warn: console.warn };
  const cards = [];
  DoorFF.post = async (data) => { cards.push(data); return { id: `ff-card-${cards.length}`, ...data }; };
  const PLAYER = { id: "ff-player", isGM: false, name: "Jebidiah's player", active: true };
  game.users = Object.assign([GM, PLAYER],
    { activeGM: GM, get: (id) => [GM, PLAYER].find(u => u.id === id) ?? null });
  GM.active = true;
  canvas.tokens.placeables.length = 0;
  const madeFF = [];

  const engineFF = new REff();
  game.aceQol = game.aceQol ?? {};
  game.aceQol.reactionEngine = engineFF;
  // The door's two ends: where the box opens, and what the person answers.
  const boxes = [];
  let answerFF = { accepted: false, choiceData: {} };
  engineFF._promptRemote = async (opts, userId) => { boxes.push({ where: userId, opts }); return answerFF; };
  engineFF._promptLocal = async (opts) => { boxes.push({ where: "this screen", opts }); return answerFF; };

  const said = [];
  const listen = async (fn) => {
    console.log = (...a) => { said.push(a.map(String).join(" ")); };
    console.warn = (...a) => { said.push(a.map(String).join(" ")); };
    try { return await fn(); } finally { console.log = keepFF.log; console.warn = keepFF.warn; }
  };

  try {
    // Feather Fall as dnd5e 5.x keeps it on a sheet: a method and a NUMBER.
    const ff = (rules, { legacy = false } = {}) => ({ id: `ff-${rules}${legacy ? "-legacy" : ""}`,
      name: legacy ? "Feather Fall (Legacy)" : "Feather Fall", type: "spell", img: "",
      system: { level: 1, method: "spell", prepared: 1, source: { rules }, activities: [] } });
    const body = (id, name, { at = [0, 0], items = [], slots = 2, statuses = [], owner = null } = {}) => {
      const a = { id, name, type: "character", img: "", documentName: "Actor", uuid: `Actor.${id}`,
        statuses: new Set(statuses), effects: [], items, hasPlayerOwner: !!owner,
        ownership: owner ? { default: 0, [owner]: 3 } : { default: 0 },
        system: { attributes: { hp: { value: 20, max: 20 }, death: { success: 0, failure: 0 } },
          spells: { spell1: { value: slots, max: 3 } }, details: {} },
        flags: { [MOD]: {} },
        getFlag: (scope, key) => a.flags?.[scope]?.[key],
        setFlag: async (scope, key, v) => { (a.flags[scope] ??= {})[key] = v; return a; },
        update: async (u) => { for (const [k, v] of Object.entries(u)) {
          const path = k.split("."); let o = a;
          for (const s2 of path.slice(0, -1)) o = (o[s2] ??= {});
          o[path[path.length - 1]] = v; } return a; },
        getActiveTokens: () => canvas.tokens.placeables.filter(t => t.actor?.id === id),
      };
      ACTORS.set(id, a);
      madeFF.push(a);
      const doc = { id: `tok-${id}`, actorId: id, actor: a, name, x: at[0], y: at[1], width: 1, height: 1,
        elevation: 0, hidden: false, disposition: 1, texture: { src: "" } };
      const tok = { id: `tok-${id}`, name, actor: a, document: doc, x: at[0], y: at[1], w: 100, h: 100,
        center: { x: at[0] + 50, y: at[1] + 50 } };
      doc.object = tok;
      canvas.tokens.placeables.push(tok);
      return a;
    };
    const docOf = (a) => canvas.tokens.placeables.find(t => t.actor?.id === a.id).document;
    const fresh = (a, slots = 2) => { a.flags[MOD] = {}; a.system.spells.spell1.value = slots; };
    const offer = async (who, ft = 30) => {
      boxes.length = 0; cards.length = 0; said.length = 0;
      return listen(() => FallPipeline._offerFeatherFall(docOf(who), ft));
    };

    const ireena = body("ff-ireena", "Ireena", { at: [0, 0] });
    const jeb = body("ff-jeb", "Jebidiah", { at: [100, 0], items: [ff("2014")], owner: PLAYER.id });

    // ── 1. "Let them fall" lets them fall, and costs nothing ──
    answerFF = { accepted: false, choiceData: {} };
    const declined = await offer(ireena);
    const box1 = boxes[0] ?? null;
    check("Feather Fall: \"Let them fall\" lets them fall, spends no slot and no reaction, and posts no card (2026-09-18)",
      declined === false && boxes.length === 1 && jeb.system.spells.spell1.value === 2
        && jeb.flags[MOD].reactionUsed !== true && cards.length === 0,
      `caught: ${declined}; boxes: ${boxes.length}; Jebidiah's slots ${jeb.system.spells.spell1.value} of 3, `
        + `reaction ${jeb.flags[MOD].reactionUsed ? "spent" : "free"}; cards: ${cards.length}`);
    check("Feather Fall: the box goes to Jebidiah's connected player, not the GM, and carries its details as rows the box can draw (2026-09-18)",
      box1?.where === PLAYER.id && Array.isArray(box1?.opts?.details) && box1.opts.details.every(d => d?.label && d?.value)
        && box1?.opts?.reactorActor === jeb && /^fa-/.test(String(box1?.opts?.icon ?? "")),
      `the box went to: ${box1?.where ?? "nowhere"}; details as rows: ${Array.isArray(box1?.opts?.details)}; `
        + `icon: ${box1?.opts?.icon ?? "none"}`);

    // His colours for it (2026-09-18): gold, with black letters edged in gold.
    check("Feather Fall: its box is gold, and its yes button has black letters with a gold edge (2026-09-18)",
      box1?.opts?.accentColor === "#ffcc33" && box1?.opts?.yesInk === "#000000" && /^#ff/i.test(String(box1?.opts?.yesEdge ?? "")),
      `accent ${box1?.opts?.accentColor ?? "none"}; letters ${box1?.opts?.yesInk ?? "default white"}, edged ${box1?.opts?.yesEdge ?? "default"}`);

    // ── 2. A yes catches, and pays the reaction and the slot ──
    fresh(jeb);
    answerFF = { accepted: true, choiceData: { slotLevel: 1, consumeSlot: true } };
    const caught = await offer(ireena);
    check("Feather Fall: a yes catches Ireena and pays for it: one 1st-level slot and the reaction, with the card through the card door (2026-09-18)",
      caught === true && jeb.system.spells.spell1.value === 1 && jeb.flags[MOD].reactionUsed === true
        && cards.length === 1 && /Jebidiah<\/strong> catches/.test(String(cards[0]?.content ?? "")),
      `caught: ${caught}; Jebidiah's slots ${jeb.system.spells.spell1.value} of 3, `
        + `reaction ${jeb.flags[MOD].reactionUsed ? "spent" : "free"}; cards: ${cards.length}`);

    // ── 3. Her player offline: the GM is asked, on this screen ──
    fresh(jeb);
    PLAYER.active = false;
    answerFF = { accepted: false, choiceData: {} };
    await offer(ireena);
    check("Feather Fall: with Jebidiah's player offline, the GM gets the box (2026-09-18)",
      boxes[0]?.where === "this screen", `the box went to: ${boxes[0]?.where ?? "nowhere"}`);
    PLAYER.active = true;

    // ── 4. A 2014 "(Legacy)" copy, cast by the one falling ──
    canvas.tokens.placeables.length = 0;
    const kasimir = body("ff-kasimir", "Kasimir Velikov", { at: [0, 0], items: [ff("2014", { legacy: true })] });
    answerFF = { accepted: true, choiceData: { slotLevel: 1, consumeSlot: true } };
    const selfCaught = await offer(kasimir);
    check("Feather Fall: a 2014 \"Feather Fall (Legacy)\" is found, and the one falling may catch itself, as both editions allow (2026-09-18)",
      selfCaught === true && boxes[0]?.opts?.reactorActor === kasimir
        && /catches themselves/.test(String(cards[0]?.content ?? "")),
      `caught: ${selfCaught}; asked: ${boxes[0]?.opts?.reactorActor?.name ?? "nobody"}; `
        + `card: ${cards.length ? "posted" : "none"}`);

    // ── 5. Held but refused: named, with the reason ──
    canvas.tokens.placeables.length = 0;
    const ireena2 = body("ff-ireena2", "Ireena", { at: [0, 0] });
    body("ff-dry", "a wizard with no slots left", { at: [100, 0], items: [ff("2014")], slots: 0 });
    answerFF = { accepted: true, choiceData: { slotLevel: 1, consumeSlot: true } };
    await offer(ireena2);
    check("Feather Fall: a caster who holds it but has no slot is not asked, and the console says why (2026-09-18)",
      boxes.length === 0
        && said.some(l => /Feather Fall: a wizard with no slots left is not asked - it has no 1st-level or higher slot left/.test(l)),
      `boxes: ${boxes.length}; the console: ${said.filter(l => /Feather Fall/.test(l)).join(" | ") || "nothing"}`);

    // ── 6. "That you can see" is the 2024 spell's clause, not the 2014 one ──
    canvas.tokens.placeables.length = 0;
    const ireena3 = body("ff-ireena3", "Ireena", { at: [0, 0] });
    body("ff-blind24", "a blinded 2024 caster", { at: [100, 0], items: [ff("2024")], statuses: ["blinded"] });
    body("ff-blind14", "a blinded 2014 caster", { at: [200, 0], items: [ff("2014")], statuses: ["blinded"] });
    answerFF = { accepted: false, choiceData: {} };
    await offer(ireena3);
    const askedNames = boxes.map(b => b.opts?.reactorActor?.name);
    check("Feather Fall: a blinded caster of the 2024 spell cannot see the fall and is not asked; the 2014 spell has no such clause (2026-09-18)",
      !askedNames.includes("a blinded 2024 caster") && askedNames.includes("a blinded 2014 caster")
        && said.some(l => /a blinded 2024 caster is not asked - the 2024 spell needs it to see the one falling, and they are blinded/.test(l)),
      `asked: ${askedNames.join(", ") || "nobody"}; the console: ${said.filter(l => /not asked/.test(l)).join(" | ") || "nothing"}`);

    // ── 7. A box that cannot open says so, and counts as a no ──
    canvas.tokens.placeables.length = 0;
    const ireena4 = body("ff-ireena4", "Ireena", { at: [0, 0] });
    const npcCaster = body("ff-npc", "an NPC mage", { at: [100, 0], items: [ff("2014")] });
    delete engineFF._promptLocal;             // the real one, which opens a Dialog this harness does not have
    const brokenBox = await offer(ireena4);
    check("Feather Fall: a box that cannot open is a no that says so, not a silent one (2026-09-18)",
      brokenBox === false && npcCaster.system.spells.spell1.value === 2
        && said.some(l => /the Feather Fall box for an NPC mage could not open, so it counts as a no/.test(l)),
      `caught: ${brokenBox}; the console: ${said.filter(l => /could not open/.test(l)).join(" | ") || "nothing"}`);
  } catch (err) {
    check("Feather Fall: the pins ran", false, `threw: ${err?.message ?? err}`);
  } finally {
    DoorFF.post = keepFF.post;
    game.users = keepFF.users;
    if (keepFF.gmActive === undefined) delete GM.active; else GM.active = keepFF.gmActive;
    if (keepFF.api === undefined) delete game.aceQol.reactionEngine; else game.aceQol.reactionEngine = keepFF.api;
    canvas.tokens.placeables.length = 0;
    canvas.tokens.placeables.push(...keepFF.placed);
    console.log = keepFF.log; console.warn = keepFF.warn;
    for (const a of madeFF) ACTORS.delete(a.id);
  }
}

/* ── THE ROLL PILL, AND WHO HEARS THE DING ──────────────────────────────── */
// Johnny, 2026-09-18: "when a player has to roll a dexterity check or something
// like that, all they get is a D20 in their chat pop-up ... I want a button
// underneath it that says Roll ... A pill every time. I want them to be able to
// roll either one of them." And a ding for every pop-up, because "even I miss
// pop-ups that come over on the client screen."
console.log(`\nTHE ROLL PILL, AND WHO HEARS THE DING`);
{
  const { SaveEngine: SEp } = await import(`${MODULE}/scripts/save-engine.mjs`);
  const { CardDoor: DoorP } = await import(`${MODULE}/scripts/road/doors.mjs`);
  const { answersCard } = await import(`${MODULE}/scripts/popup-ding.mjs`);
  const keepP = { post: DoorP.post, users: game.users };
  const PLAYERp = { id: "pill-player", isGM: false, name: "Aryel's player", active: true };
  game.users = Object.assign([GM, PLAYERp], { activeGM: GM, get: (id) => [GM, PLAYERp].find(u => u.id === id) ?? null });
  const postedP = [];
  DoorP.post = async (data) => { postedP.push(data); return { id: "pill-card", ...data }; };
  try {
    // The card as the save engine posts it for a player's save.
    const savesP = Object.create(SEp.prototype);
    const fireball = { id: "it-fb-pill", name: "Fireball", type: "spell", uuid: "Item.fb-pill", img: "" };
    await quiet(() => savesP._sendPcSavePrompt(fireball, null,
      { name: "Aryel", img: "", ownerIds: [PLAYERp.id], sceneId: "s", tokenDocId: "tok-aryel", actorId: "a-aryel" },
      { saveAbility: "dex", saveDC: 15, halfOnSave: true, damageTypes: ["fire"], isSpell: true, castId: "c-pill" }));
    const card = String(postedP.at(-1)?.content ?? "");
    const pillHtml = (/<button[^>]*ace-qol-roll-pill[^>]*>[\s\S]*?<\/button>/.exec(card) ?? [""])[0];
    check("the player's save card keeps its d20 and gains a wide pill that says \"Roll Dexterity save\" (2026-09-18)",
      /aceQolRollPcSave/.test(card) && /class="ace-qol-d20"/.test(card)
        && /data-action="aceQolRollPcSave"/.test(pillHtml) && /Roll Dexterity save/.test(pillHtml)
        && /width:100%/.test(pillHtml) && /border-radius:999px/.test(pillHtml),
      `d20: ${/class="ace-qol-d20"/.test(card)}; pill: ${pillHtml ? "present" : "MISSING"}; `
        + `its words: ${(/<span>([^<]*)<\/span>/.exec(pillHtml) ?? [])[1] ?? "none"}`);
    check("and the pill's words wrap inside it, never off it (2026-09-18)",
      /white-space:normal/.test(pillHtml) && !/nowrap/.test(pillHtml),
      /white-space:normal/.test(pillHtml) ? "they wrap" : "they cannot wrap");

    // Both roll, and only once between them.
    let rolled = 0;
    savesP._rollPcSave = async () => { rolled++; };
    savesP._preserveChatScroll = () => () => {};
    const button = (isPill) => ({ dataset: {}, disabled: false, innerHTML: "", clicks: [],
      classList: { contains: (c) => isPill && c === "ace-qol-roll-pill" },
      addEventListener(ev, fn) { if (ev === "click") this.clicks.push(fn); } });
    const die = button(false), pillBtn = button(true);
    const cardEl = { querySelectorAll: () => [die, pillBtn], closest: () => ({ classList: { add() {} } }) };
    savesP._wirePcSaveButton(cardEl, { id: "pill-card" }, { rolled: false });
    const wired = die.clicks.length === 1 && pillBtn.clicks.length === 1;
    await pillBtn.clicks[0]?.();
    await die.clicks[0]?.();
    check("clicking the pill or the d20 rolls the save, and a second click on the other one does not roll it again (2026-09-18)",
      wired && rolled === 1 && die.disabled && /Rolled/.test(pillBtn.innerHTML),
      `both wired: ${wired}; rolls: ${rolled}; the pill now reads: ${pillBtn.innerHTML.replace(/<[^>]+>/g, "").trim() || "(nothing)"}`);

    // Who hears the ding: the one who answers the card.
    const cardFor = (type, whisper) => ({ flags: { "ace-qol": { type } }, whisper });
    const hears = (msg, user) => answersCard(msg, user);
    check("the ding sounds for whoever answers the card: the player on their save card, not the GM who posted it (2026-09-18)",
      hears(cardFor("pcSavePrompt", [PLAYERp.id]), PLAYERp) && !hears(cardFor("pcSavePrompt", [PLAYERp.id]), GM),
      `player: ${hears(cardFor("pcSavePrompt", [PLAYERp.id]), PLAYERp)}; GM: ${hears(cardFor("pcSavePrompt", [PLAYERp.id]), GM)}`);
    check("an escape card shown to the player and the GM dings for the player only; an NPC's opportunity attack dings for the GM (2026-09-18)",
      hears(cardFor("breakFreePrompt", [PLAYERp.id, GM.id]), PLAYERp) && !hears(cardFor("breakFreePrompt", [PLAYERp.id, GM.id]), GM)
        && hears(cardFor("oaPrompt", [GM.id]), GM) && !hears(cardFor("someOtherCard", [GM.id]), GM),
      `escape card: player ${hears(cardFor("breakFreePrompt", [PLAYERp.id, GM.id]), PLAYERp)}, GM ${hears(cardFor("breakFreePrompt", [PLAYERp.id, GM.id]), GM)}; `
        + `NPC's OA card: GM ${hears(cardFor("oaPrompt", [GM.id]), GM)}; an ordinary card: ${hears(cardFor("someOtherCard", [GM.id]), GM)}`);
  } catch (err) {
    check("the roll pill and the ding: the pins ran", false, `threw: ${err?.message ?? err}`);
  } finally {
    DoorP.post = keepP.post;
    game.users = keepP.users;
  }
}

/* ── TELEPORT: THE MONSTER'S HOP, AND THE 7TH-LEVEL SPELL ─────────────────── */
// Johnny, 2026-09-18: "TWO different Teleports. Read the item on the token."
// A) the arcanaloth's feature: a hop to an unoccupied square it can see, 60
// feet as an action in 2014, 30 as a bonus action in 2024; no party, no d100,
// no Counterspell. B) the 7th-level spell: who comes, how well the place is
// known, where; the book's d100 for that edition; a mishap is 3d10 force and a
// reroll. "Do not treat Neferon's feature as the 7th-level spell."
console.log(`\nTELEPORT: THE MONSTER'S HOP, AND THE 7TH-LEVEL SPELL`);
await quiet(async () => {
  const { readTeleport } = await import(`${MODULE}/scripts/rules/teleport-words.mjs`);
  const { Teleport, TELEPORT_TABLES } = await import(`${MODULE}/scripts/teleport.mjs`);
  const { RulesBrain: RBtp } = await import(`${MODULE}/scripts/rules/rules-brain.mjs`);

  // ── His items, read as they are ──
  pin("Neferon's Teleport is his own hop: 60 feet, read from its words, and the pipeline takes it as the hop (2026-09-18)",
    ["Neferon", "Teleport"], (it) => {
      const r = readTeleport(it);
      return [r?.kind === "hop" && r.feet === 60 && shapeOf(it) === "teleport-hop",
        `${r ? `${r.kind}, ${r.feet} feet` : "not read as a teleport"}; the pipeline: ${shapeOf(it)}`];
    });
  pin("the 2024 arcanaloth's Teleport is 30 feet, its own item's number (2026-09-18)",
    ["Arcanaloth", "Teleport"], (it) => {
      const r = readTeleport(it);
      return [r?.kind === "hop" && r.feet === 30, r ? `${r.kind}, ${r.feet} feet` : "not read as a teleport"];
    });
  {
    const vareks = [...ACTORS.values()].filter(a => a.name === VAREK)
      .flatMap(a => a.items.filter(i => i.name === "Teleport" && i.type === "spell"));
    const editions = vareks.map(i => RBtp.resolveEdition(i, i.actor)).sort();
    check("Varek's two Teleports, 2014 and 2024, are the 7th-level spell, each by its own edition (2026-09-18)",
      vareks.length === 2 && vareks.every(i => shapeOf(i) === "teleport-spell") && editions.join(",") === "2014,2024",
      `${vareks.length} copies: ${vareks.map(i => shapeOf(i)).join(", ")}; editions ${editions.join(", ")}`);
  }
  {
    // Not one feature in his world may be taken for the spell, whatever it is called.
    const features = [...ACTORS.values()].flatMap(a => a.items.filter(i => i.type === "feat"));
    const wrong = features.filter(i => shapeOf(i) === "teleport-spell").map(i => `${i.actor?.name}/${i.name}`);
    check("no feature anywhere in the world is taken for the 7th-level spell (2026-09-18)",
      features.length > 0 && wrong.length === 0,
      wrong.length ? `taken for the spell: ${wrong.slice(0, 5).join("; ")}` : `${features.length} features, none of them the spell`);
  }
  {
    // A teleport that also does something else is left exactly as it was.
    const leftAlone = [["Lich", "Deathly Teleport"], ["Vecna the Archlich", "Vile Teleport"], ["Nycaloth", "Shadowy Teleport"]]
      .map(([a, n]) => findOn(a, n)).filter(Boolean);
    const taken = leftAlone.filter(i => readTeleport(i) !== null).map(i => i.name);
    check("a feature that teleports and also does something more (damage, invisibility) is not taken over for the hop alone (2026-09-18)",
      leftAlone.length >= 2 && taken.length === 0,
      `${leftAlone.length} checked; taken over: ${taken.join(", ") || "none"}`);
  }

  {
    // Johnny, 2026-09-18: a later click moved Neferon again. AA's own teleport
    // preset had armed a click of its own; ACE now stands it down for the
    // teleports ACE moves itself, and for nothing else.
    const hop = findOn("Neferon", "Teleport");
    const spell = [...ACTORS.values()].filter(a => a.name === VAREK)
      .flatMap(a => a.items.filter(i => i.name === "Teleport" && i.type === "spell"))[0] ?? null;
    const others = [findOn("Blink Dog", "Teleport"), findOn("Kasimir Velikov", "Magic Missile", "character")].filter(Boolean);
    const asked = (item) => { const d = { item }; Teleport._standDownAA(d); return d.stopWorkflow === true; };
    check("Automated Animations stands down for the teleports ACE moves itself, Neferon's hop and Varek's spell, and for nothing else (2026-09-18)",
      !!hop && !!spell && asked(hop) && asked(spell) && others.length >= 2 && others.every(i => !asked(i)),
      `Neferon's hop: ${hop ? asked(hop) : "missing"}; Varek's spell: ${spell ? asked(spell) : "missing"}; `
        + `left to AA: ${others.map(i => `${i.actor?.name}'s ${i.name} ${asked(i) ? "STOPPED" : "plays"}`).join("; ")}`);
    const AA_SRC = "D:/FoundryVTT/Data/modules/autoanimations/dist/autoanimations.js";
    if (!existsSync(AA_SRC)) {
      check("Automated Animations still offers the stand-down ACE uses", null, "(Automated Animations is not installed here)");
    } else {
      const src = readFileSync(AA_SRC, "utf8");
      const at = src.indexOf(`Hooks.callAll("AutomatedAnimations-WorkflowStart", clonedData, animationData);`);
      const honoured = at >= 0 && /^\s*if \(clonedData\.stopWorkflow\) \{/.test(src.slice(at).split("\n")[1] ?? "");
      check("Automated Animations still offers the stand-down ACE uses: it calls AutomatedAnimations-WorkflowStart and gives up on stopWorkflow (a hook nobody fires waits forever)",
        honoured, at < 0 ? "the hook call is gone from AA's code" : (honoured ? "called, and stopWorkflow is read on the next line" : "called, but stopWorkflow is no longer read right after it"));
    }
  }

  // ── The books' tables ──
  {
    const o = (ed, fam, n) => Teleport.outcome(ed, fam, n);
    const got = [o("2014", "very", 5), o("2014", "very", 6), o("2014", "very", 24), o("2014", "very", 25),
      o("2014", "once", 43), o("2014", "description", 74), o("2014", "false", 51), o("2014", "false", 100),
      o("2014", "circle", 1), o("2024", "once", 53), o("2024", "once", 73), o("2024", "casual", 54)].join(",");
    const want = "mishap,similar,off,on,mishap,on,similar,similar,on,similar,off,on";
    check("the d100 reads each edition's table, row by row, at every boundary (2026-09-18)",
      got === want && TELEPORT_TABLES["2014"].length === 7 && TELEPORT_TABLES["2024"].length === 6,
      `got ${got}`);
  }

  // ── The hop on a stand-in map ──
  const keepTp = { scene: canvas.scene, placed: [...canvas.tokens.placeables], sight: CONFIG.Canvas.polygonBackends.sight,
    move: CONFIG.Canvas.polygonBackends.move, post: null };
  const { CardDoor: DoorTp } = await import(`${MODULE}/scripts/road/doors.mjs`);
  keepTp.post = DoorTp.post;
  const cardsTp = [];
  const cardOptsTp = [];
  DoorTp.post = async (data, opts = {}) => { cardsTp.push(data); cardOptsTp.push(opts); return { id: `tp-card-${cardsTp.length}`, ...data }; };
  const moves = [];
  const scene = { id: "s-tp", tokens: [] };
  const body = (id, name, x, y) => {
    const actor = { id, name, type: "npc", img: "", uuid: `Actor.${id}`, system: { attributes: { hp: { value: 30, max: 30 } } },
      statuses: new Set(), flags: {}, getActiveTokens: () => [tok] };
    const doc = { id: `tok-${id}`, name, x, y, width: 1, height: 1, elevation: 0, parent: scene, actor, texture: { src: "" }, flags: {},
      move: async (w, o) => { moves.push({ name, to: { x: w.x, y: w.y }, action: w.action }); doc.x = w.x; doc.y = w.y; return true; } };
    const tok = { id: doc.id, name, actor, document: doc, x, y, w: 100, h: 100,
      get center() { return { x: doc.x + 50, y: doc.y + 50 }; } };
    scene.tokens.push(doc);
    canvas.tokens.placeables.push(tok);
    return tok;
  };
  try {
    canvas.scene = scene;
    canvas.tokens.placeables.length = 0;
    const neferon = body("tp-nef", "Neferon", 1000, 1000);
    body("tp-foe", "a paladin in the way", 1100, 1000);
    CONFIG.Canvas.polygonBackends.sight = { testCollision: (_a, b) => b.x > 1500 && b.y < 1000 };  // a wall to the northeast
    CONFIG.Canvas.polygonBackends.move = { testCollision: () => false };   // the landing's own wall check: no walls
    // A 100-pixel, 5-foot grid: twelve squares is 60 feet.
    const squares = Teleport.squaresFor(neferon, 60);
    const has = (x, y) => squares.some(s => s.x === x && s.y === y);
    check("the hop lights every square it could reach: within 60 feet, not occupied, and in its sight (2026-09-18)",
      has(2200, 1000) && !has(2300, 1000) && !has(1100, 1000) && !has(1600, 900) && has(1000, 2200) && has(1600, 1000),
      `60 ft east: ${has(2200, 1000)}; 65 ft east: ${has(2300, 1000)}; the paladin's square: ${has(1100, 1000)}; `
        + `behind the wall: ${has(1600, 900)}; beside the wall: ${has(1600, 1000)}; 60 ft south: ${has(1000, 2200)}`);

    // Click → there, as a teleport.
    const keepPick = Teleport.pickSquare;
    Teleport.pickSquare = async () => ({ x: 1300, y: 1000 });
    moves.length = 0;
    const neferonHop = findOn("Neferon", "Teleport");
    await quiet(() => Teleport.runHop({ actor: neferon.actor, item: neferonHop, activity: null,
      entry: { teleport: { kind: "hop", feet: 60 } } }));
    Teleport.pickSquare = keepPick;
    check("a click on a lit square puts Neferon there as a teleport, with no party picker, no d100 and no card of its own (2026-09-18)",
      moves.length === 1 && moves[0].action === "displace" && moves[0].to.x === 1300 && cardsTp.length === 0,
      `moves: ${moves.map(m => `${m.name} to ${m.to.x},${m.to.y} by ${m.action}`).join("; ") || "none"}; cards: ${cardsTp.length}`);

    // Cancelled: a Glasstaff's daily use or a marilith's recharge comes back.
    Teleport.pickSquare = async () => null;
    moves.length = 0;
    let refunded = null, cleared = null;
    const spentCard = { system: { deltas: { item: { glass: [{ keyPath: "system.uses.spent", delta: 1 }] } } },
      update: async (u) => { cleared = u; } };
    await quiet(() => Teleport.runHop({ actor: neferon.actor, item: neferonHop, message: spentCard,
      activity: { refund: async (d) => { refunded = d; } }, entry: { teleport: { kind: "hop", feet: 60 } } }));
    let refundedIdle = false;
    await quiet(() => Teleport.runHop({ actor: neferon.actor, item: neferonHop, message: { system: {} },
      activity: { refund: async () => { refundedIdle = true; } }, entry: { teleport: { kind: "hop", feet: 60 } } }));
    Teleport.pickSquare = keepPick;
    check("cancelling the hop gives back what pressing it spent, through dnd5e's own refund, so its card cannot give it back twice; a press that spent nothing is left alone (2026-09-18)",
      refunded === spentCard.system.deltas && cleared?.["system.deltas"] === null && !refundedIdle && moves.length === 0,
      `given back: ${refunded ? "yes" : "no"}; the card's record cleared: ${cleared ? "yes" : "no"}; `
        + `nothing spent, refund called anyway: ${refundedIdle}; moves: ${moves.length}`);

    // One click, one move, and nothing of the aiming left behind (his table,
    // 2026-09-18: "No ghost, no line, no click listener. One move per press.").
    {
      const listeners = new Map();
      const keepDoc = { add: document.addEventListener, remove: document.removeEventListener, byId: document.getElementById };
      const keepPIXI = globalThis.PIXI;
      const keepCanvas = { controls: canvas.controls, fromClient: canvas.canvasCoordinatesFromClient };
      const board = { id: "board", contains: () => false };
      class Node { constructor() { this.children = []; this.parent = null; this.destroyed = false; }
        addChild(c) { c.parent = this; this.children.push(c); return c; }
        removeChild(c) { this.children = this.children.filter(x => x !== c); c.parent = null; return c; }
        removeChildren() { const out = this.children; this.children = []; return out; }
        destroy() { this.destroyed = true; } }
      class Gfx extends Node { lineStyle() { return this; } beginFill() { return this; } endFill() { return this; }
        drawRect() { return this; } drawRoundedRect() { return this; } moveTo() { return this; } lineTo() { return this; } }
      document.addEventListener = (type, fn) => { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(fn); };
      document.removeEventListener = (type, fn) => { listeners.get(type)?.delete(fn); };
      document.getElementById = (id) => (id === "board" ? board : null);
      globalThis.PIXI = { Container: Node, Graphics: Gfx };
      canvas.controls = new Node();
      canvas.canvasCoordinatesFromClient = ({ x, y }) => ({ x, y });
      const click = (x, y) => {
        const ev = { target: board, button: 0, clientX: x, clientY: y,
          preventDefault() {}, stopPropagation() {}, stopImmediatePropagation() {} };
        for (const fn of [...(listeners.get("pointerdown") ?? [])]) fn(ev);
      };
      const open = () => [...listeners.values()].reduce((n, set) => n + set.size, 0);
      try {
        Object.assign(neferon.document, { x: 1000, y: 1000 });
        moves.length = 0;
        const press = () => Teleport.runHop({ actor: neferon.actor, item: neferonHop, activity: null,
          message: { system: {} }, entry: { teleport: { kind: "hop", feet: 60 } } });
        // Pressed twice before aiming: the first aiming is called off.
        const first = quiet(press);
        const second = quiet(press);
        await new Promise(r => setTimeout(r, 0));
        const drawnWhileAiming = canvas.controls.children.length;
        click(1350, 1050);                         // a lit square, 15 feet east
        const [a, b] = await Promise.all([first, second]);
        const after = { listeners: open(), drawn: canvas.controls.children.length, session: Teleport._session };
        click(1650, 1050);                         // a later click on the map
        await new Promise(r => setTimeout(r, 20));
        check("one hop is one click and one move: the aiming's click, squares and line are gone the moment he lands, a second press calls the first off, and a later click on the map does nothing (2026-09-18)",
          drawnWhileAiming === 1 && a === false && b === true && moves.length === 1 && moves[0].to.x === 1300
            && after.listeners === 0 && after.drawn === 0 && after.session === null,
          `drawn while aiming: ${drawnWhileAiming}; first press: ${a}, second: ${b}; moves: `
            + `${moves.map(m => `${m.to.x},${m.to.y}`).join("; ") || "none"}; after the pick: ${after.listeners} listener(s), `
            + `${after.drawn} drawing(s), the aiming ${after.session ? "still open" : "closed"}`);
      } finally {
        for (const [k, v] of Object.entries(keepDoc)) {
          const name = { add: "addEventListener", remove: "removeEventListener", byId: "getElementById" }[k];
          if (v === undefined) delete document[name]; else document[name] = v;
        }
        if (keepPIXI === undefined) delete globalThis.PIXI; else globalThis.PIXI = keepPIXI;
        canvas.controls = keepCanvas.controls;
        canvas.canvasCoordinatesFromClient = keepCanvas.fromClient;
      }
    }

    // The look he likes, played by ACE at the moment he arrives: his own AA
    // "Teleport" preset's clips and sound, and the move at the preset's beat.
    {
      const { invalidate } = await import(`${MODULE}/scripts/animation/autorec.mjs`);
      // His setting as the table reads it: sometimes still a JSON string, sometimes already a list.
      const presets = (() => {
        try { const raw = SETTINGS.get("autoanimations.aaAutorec-preset"); return (typeof raw === "string" ? JSON.parse(raw) : raw) ?? []; }
        catch (_) { return []; }
      })();
      const preset = (Array.isArray(presets) ? presets : Object.values(presets)).find(r => r?.label === "Teleport" && r?.presetType === "teleportation");
      if (!preset) {
        check("ACE plays his Teleport look itself", null, "(this world has no Automated Animations preset called Teleport)");
      } else {
        const keepSeq = globalThis.Sequence, keepSqr = globalThis.Sequencer;
        const played = [];
        const t0 = Date.now();
        const chain = (part, seq) => new Proxy({}, { get: (_o, k) => (k === "play" ? () => seq.play()
          : (k === "sound" || k === "effect") ? (...args) => seq[k](...args)
            : (...args) => { part[k] = args; return chain(part, seq); }) });
        globalThis.Sequencer = { Database: { entryExists: (key) => /^autoanimations\.static\.spell\.mistystep\.0[12]\./.test(key) } };
        globalThis.Sequence = class {
          constructor() { this.parts = []; }
          sound() { const part = { kind: "sound" }; this.parts.push(part); return chain(part, this); }
          effect() { const part = { kind: "effect" }; this.parts.push(part); return chain(part, this); }
          async play() { played.push({ at: Date.now() - t0, parts: this.parts }); return true; }
        };
        invalidate();
        Object.assign(neferon.document, { x: 1000, y: 1000 });
        moves.length = 0;
        const keepPick3 = Teleport.pickSquare, keepMove3 = neferon.document.move;
        let movedAt = null;
        Teleport.pickSquare = async () => ({ x: 1300, y: 1000 });
        neferon.document.move = async (w, o) => { movedAt = Date.now() - t0; return keepMove3(w, o); };
        try {
          await quiet(() => Teleport.runHop({ actor: neferon.actor, item: neferonHop, activity: null,
            message: { system: {} }, entry: { teleport: { kind: "hop", feet: 60 } } }));
        } finally {
          Teleport.pickSquare = keepPick3;
          neferon.document.move = keepMove3;
          if (keepSeq === undefined) delete globalThis.Sequence; else globalThis.Sequence = keepSeq;
          if (keepSqr === undefined) delete globalThis.Sequencer; else globalThis.Sequencer = keepSqr;
          invalidate();
        }
        const [leave, arrive] = played;
        const leaveFx = leave?.parts.find(q => q.kind === "effect");
        const sound = leave?.parts.find(q => q.kind === "sound");
        const arriveFx = arrive?.parts.find(q => q.kind === "effect");
        const colour = preset.data?.start?.color ?? "";
        const beat = Number(preset.data?.end?.options?.delay) || 0;
        check("ACE plays his Teleport look itself: the Misty Step out where he stood with its sound, then, at the preset's own beat, the Misty Step in where he lands and the move together (2026-09-18)",
          played.length === 2 && leaveFx?.file?.[0] === `autoanimations.static.spell.mistystep.01.${colour}`
            && leaveFx?.atLocation?.[0]?.x === 1050 && arriveFx?.file?.[0] === `autoanimations.static.spell.mistystep.02.${colour}`
            && arriveFx?.atLocation?.[0]?.x === 1350 && sound?.file?.[0] === preset.data?.sound?.file
            && movedAt !== null && arrive.at >= beat - 50 && Math.abs(movedAt - arrive.at) < 100 && moves.length === 1,
          `clips: ${played.length}; out: ${leaveFx?.file?.[0] ?? "none"} at ${leaveFx?.atLocation?.[0]?.x ?? "?"}; `
            + `in: ${arriveFx?.file?.[0] ?? "none"} at ${arriveFx?.atLocation?.[0]?.x ?? "?"} after ${arrive?.at ?? "?"} ms `
            + `(the preset's beat ${beat}); moved at ${movedAt ?? "never"} ms; sound: ${sound?.file?.[0] ?? "none"}`);
      }
    }

    // ── The 7th-level spell ──
    const varekTok = body("tp-var", "Varek Thalor (CR 30)", 2000, 2000);
    const friend = body("tp-fr", "a willing friend", 2100, 2000);
    const varekSpell = [...ACTORS.values()].filter(a => a.name === VAREK)
      .flatMap(a => a.items.filter(i => i.name === "Teleport" && i.type === "spell"))
      .find(i => RBtp.resolveEdition(i, i.actor) === "2024");
    const keep = { plan: Teleport.askPlan, point: Teleport.pickPoint, roll: Teleport._roll };
    const rolls = [];
    const script = (...totals) => { rolls.length = 0; rolls.push(...totals); };
    Teleport._roll = async (formula) => ({ formula, total: rolls.shift() ?? 1 });
    Teleport.askPlan = async () => ({ who: [friend], familiarity: "very", where: "map", place: "" });
    Teleport.pickPoint = async () => ({ x: 3050, y: 3050 });
    let committed = 0;
    const cast = (item) => Teleport.runSpell({ actor: varekTok.actor, item, activity: null, onCommit: async () => { committed++; } });

    // On target: both appear around the spot.
    script(80);
    moves.length = 0; cardsTp.length = 0;
    await quiet(() => cast(varekSpell));
    check("the spell: the caster and the friend he chose appear around the spot, on target, and the slot is spent once (2026-09-18)",
      moves.length === 2 && moves.every(m => m.action === "displace") && committed === 1
        && /appear exactly where they meant to/.test(String(cardsTp.at(-1)?.content ?? "")),
      `moves: ${moves.map(m => `${m.name} to ${m.to.x},${m.to.y}`).join("; ")}; slot spent ${committed}x`);

    // A mishap: 3d10 force to each, on the damage card, then the table again.
    script(3, 17, 90);
    moves.length = 0; cardsTp.length = 0; committed = 0;
    await quiet(() => cast(varekSpell));
    const dmgCard = cardsTp.find(c => c?.flags?.["ace-qol"]?.type === "damageResult");
    check("a mishap deals its 3d10 force to each of them on the suite's damage card, and the d100 is rolled again (2026-09-18)",
      !!dmgCard && dmgCard.flags["ace-qol"].damageResults.length === 2
        && dmgCard.flags["ace-qol"].damageResults.every(r => r.components[0].type === "force" && r.totalFinal === 17)
        && moves.length === 2,
      `damage card: ${dmgCard ? `${dmgCard.flags["ace-qol"].damageResults.length} rows of ${dmgCard.flags["ace-qol"].damageResults[0]?.totalFinal} force` : "none"}; then moves: ${moves.length}`);

    // Off target, 2024: 2d12 miles in a d8 direction, and the GM places them.
    script(20, 3, 14);
    moves.length = 0; cardsTp.length = 0;
    await quiet(() => cast(varekSpell));
    check("off target by the 2024 book: 14 miles south, on the card for the GM, and nobody is moved on this map (2026-09-18)",
      moves.length === 0 && /14 miles south/.test(String(cardsTp.at(-1)?.content ?? "")),
      `moves: ${moves.length}; the card: ${String(cardsTp.at(-1)?.content ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 140)}`);

    // Off target, 2014: 1d10 x 1d10 percent of the way, a d8 from north; the GM places them.
    const varekSpell14 = [...ACTORS.values()].filter(a => a.name === VAREK)
      .flatMap(a => a.items.filter(i => i.name === "Teleport" && i.type === "spell"))
      .find(i => RBtp.resolveEdition(i, i.actor) === "2014");
    script(20, 3, 5, 3);
    moves.length = 0; cardsTp.length = 0;
    Object.assign(varekTok.document, { x: 2000, y: 2000 });   // back where he started: the checks above moved him
    await quiet(() => cast(varekSpell14));
    check("off target by the 2014 book: 5 x 3 = 15% of the 71 feet, a d8 of 3 is east, and the GM places them (2026-09-18)",
      moves.length === 0 && /about 11 feet east of the spot picked \(15% of the 71 feet/.test(String(cardsTp.at(-1)?.content ?? "")),
      `moves: ${moves.length}; the card: ${String(cardsTp.at(-1)?.content ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 170)}`);

    // Cancelled: nothing happens and the slot is kept.
    Teleport.askPlan = async () => null;
    moves.length = 0; cardsTp.length = 0; committed = 0;
    const went = await quiet(() => cast(varekSpell));
    check("cancelling the plan casts nothing: no move, no card, and the slot is not spent (2026-09-18)",
      went === false && moves.length === 0 && cardsTp.length === 0 && committed === 0,
      `cast: ${went}; moves ${moves.length}; cards ${cardsTp.length}; slot spent ${committed}x`);
    Object.assign(Teleport, { askPlan: keep.plan, pickPoint: keep.point, _roll: keep.roll });

    // The destination dice are the GM's, and nothing is posted before its dice
    // stop (his table, 2026-09-18). A mishap, then On Target.
    {
      const keepDice = game.dice3d, keepRoll = globalThis.Roll, keepPost4 = DoorTp.post;
      const events = [];
      game.dice3d = { isEnabled: () => true,
        showForRoll: (roll, _user, _sync, users) => {
          events.push(`show ${roll.formula} ${users ? "to the GMs" : "to everybody"}`);
          return new Promise(r => setTimeout(() => { events.push(`${roll.formula} lands`); r(true); }, 15));
        } };
      const queue = [3, 17, 90];
      globalThis.Roll = class { constructor(f) { this.formula = String(f); this.terms = []; }
        async evaluate() {
          this.total = queue.shift() ?? 1;
          const m = /(\d*)d(\d+)/.exec(this.formula);
          if (m) this.terms = [{ faces: Number(m[2]), number: Number(m[1] || 1), results: [{ result: this.total, active: true }] }];
          return this;
        } };
      DoorTp.post = async (data, opts = {}) => {
        events.push(`card ${data?.flags?.["ace-qol"]?.type}${opts.dice ? " (waits for dice)" : ""}`);
        cardsTp.push(data);
        return { id: `tp-card-${cardsTp.length}`, ...data };
      };
      Object.assign(varekTok.document, { x: 2000, y: 2000 });
      Object.assign(friend.document, { x: 2100, y: 2000 });
      cardsTp.length = 0; moves.length = 0;
      try {
        await quiet(() => Teleport.runTable({ edition: "2024", familiarity: "very", where: "map", place: "",
          point: { x: 3050, y: 3050 }, docs: [varekTok.document, friend.document], actor: varekTok.actor, item: varekSpell }));
      } finally {
        game.dice3d = keepDice;
        globalThis.Roll = keepRoll;
        DoorTp.post = keepPost4;
      }
      const order = events.join(" > ");
      const want = "show 1d100 to the GMs > 1d100 lands > show 3d10 to everybody > 3d10 lands > card damageResult (waits for dice)"
        + " > show 1d100 to the GMs > 1d100 lands > card teleportResult (waits for dice)";
      check("Teleport waits for its dice: the d100 tumbles on the GMs' screens only, a mishap's 3d10 where everybody sees damage roll, its damage card after those land, and the Teleport card after the last die (2026-09-18)",
        order === want, order);
      const card = cardsTp.at(-1);
      const text = String(card?.content ?? "");
      const gms = game.users.filter(u => u.isGM).map(u => u.id);
      const pair = (tens, ones) => new RegExp(`d100/100-${tens}_nobg\\.png[\\s\\S]*?d10/10-${ones}_nobg\\.png[\\s\\S]*?font-size:20px[^>]*>`);
      check("the Teleport card is the GMs' and shows each d100, big, beside its two dice, with what it meant: 3 Mishap (17 force to each), then 90 On Target (2026-09-18)",
        JSON.stringify(card?.whisper) === JSON.stringify(gms) && pair("00", "3").test(text) && />3<\/span>/.test(text)
          && /Mishap/.test(text) && /force to each of them: 17/.test(text)
          && pair("90", "10").test(text) && />90<\/span>/.test(text) && /On Target/.test(text)
          && JSON.stringify(card?.flags?.["ace-qol"]?.rolls) === JSON.stringify([{ d100: 3, meant: "mishap", force: 17 }, { d100: 90, meant: "on", force: null }]),
        `whispered to: ${JSON.stringify(card?.whisper)}; the card: ${text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 220)}`);
    }

    // The shared die helper draws a d100 as the pair on the table: 57 is the 50
    // and the 7, 60 is the 60 and the 0, 100 is the 00 and the 0 (2026-09-18).
    {
      const { CheckGate } = await import(`${MODULE}/scripts/check-gate.mjs`);
      const html = await CheckGate._diceHtml({ terms: [{ faces: 100, results: [{ result: 57 }, { result: 60 }, { result: 100 }] }] }, { results: false });
      const faces = [...html.matchAll(/Dice%20Images\/Red\/(d\d+)\/(\d+-\d+)_nobg\.png/g)].map(m => m[2]).join(" ");
      check("a d100 is drawn as its two dice: 57 as 50 and 7, 60 as 60 and 0, 100 as 00 and 0, with no number when the card prints its own (2026-09-18)",
        faces === "100-50 10-7 100-60 10-10 100-00 10-10" && !/ace-qol-die-result/.test(html), faces || "no faces");
    }

    // A player who casts it chooses on their own screen; the table goes to the GM's.
    {
      const PLAYER = { id: "tp-player", isGM: false, name: "a player" };
      const keepP = { user: game.user, users: game.users, socket: game.socket, fromUuid: globalThis.fromUuid,
        scenes: game.scenes, table: Teleport.runTable, plan: Teleport.askPlan, point: Teleport.pickPoint };
      const emitted = [];
      const tables = [];
      const spell = { id: "tp-spell", uuid: "Actor.tp-var.Item.tp-spell", name: "Teleport", type: "spell",
        system: { level: 7, source: { rules: "2024" } }, actor: varekTok.actor };
      const tablesBefore = () => tables.length;
      try {
        game.users = Object.assign([GM, PLAYER], { activeGM: GM, get: (id) => [GM, PLAYER].find(u => u.id === id) ?? null });
        game.socket = { emit: (name, data) => emitted.push({ name, data }) };
        varekTok.actor.testUserPermission = (u, level) => u?.id === PLAYER.id && level === "OWNER";
        Teleport.askPlan = async () => ({ who: [friend], familiarity: "very", where: "map", place: "" });
        Teleport.pickPoint = async () => ({ x: 3050, y: 3050 });
        Teleport.runTable = async (t) => { tables.push(t); return { result: "on", landed: true }; };
        let spent = 0;
        game.user = PLAYER;
        await quiet(() => Teleport.runSpell({ actor: varekTok.actor, item: spell, activity: null, onCommit: async () => { spent++; } }));
        const onPlayer = tablesBefore();
        const sent = emitted.find(e => e.data?.action === "teleportTable") ?? null;
        game.user = GM;
        const byUuid = new Map([[varekTok.actor.uuid, varekTok.actor], [spell.uuid, spell]]);
        globalThis.fromUuid = async (u) => byUuid.get(u) ?? keepP.fromUuid(u);
        scene.tokens.get = (id) => scene.tokens.find(d => d.id === id) ?? null;
        game.scenes = { get: (id) => (id === scene.id ? scene : null) };
        await quiet(() => Teleport.fromSocket(sent?.data));
        const ranForOwner = tables.length;
        await quiet(() => Teleport.fromSocket({ ...(sent?.data ?? {}), userId: "not-a-user" }));
        const t = tables[0];
        check("a player who casts Teleport chooses on their own screen and nothing is rolled there; the GM's screen rolls the owner's table, and a table from anybody else is refused (2026-09-18)",
          onPlayer === 0 && !!sent && sent.name === "module.ace-qol" && spent === 1 && ranForOwner === 1 && tables.length === 1
            && t?.docs?.map(d => d.name).join(",") === "Varek Thalor (CR 30),a willing friend" && t?.edition === "2024"
            && t?.familiarity === "very" && t?.point?.x === 3050,
          `rolled on the player's screen: ${onPlayer}; sent to the GM: ${sent ? sent.name : "no"}; slot spent ${spent}x; `
            + `tables rolled by the GM: ${ranForOwner} for the owner, ${tables.length - ranForOwner} for a stranger; `
            + `who went: ${t?.docs?.map(d => d.name).join(", ") ?? "-"}`);
      } finally {
        game.user = keepP.user; game.users = keepP.users; game.socket = keepP.socket; globalThis.fromUuid = keepP.fromUuid;
        game.scenes = keepP.scenes;
        Object.assign(Teleport, { runTable: keepP.table, askPlan: keepP.plan, pickPoint: keepP.point });
        delete varekTok.actor.testUserPermission;
        delete scene.tokens.get;
      }
    }
  } catch (err) {
    check("teleport: the pins ran", false, `threw: ${err?.message ?? err}`);
  } finally {
    DoorTp.post = keepTp.post;
    CONFIG.Canvas.polygonBackends.sight = keepTp.sight;
    if (keepTp.sight === undefined) delete CONFIG.Canvas.polygonBackends.sight;
    CONFIG.Canvas.polygonBackends.move = keepTp.move;
    if (keepTp.move === undefined) delete CONFIG.Canvas.polygonBackends.move;
    canvas.scene = keepTp.scene;
    canvas.tokens.placeables.length = 0;
    canvas.tokens.placeables.push(...keepTp.placed);
  }
});

/* ── FORGE PLAYS TRAPS AND SECRET DOORS ──────────────────────────────────── */
// Johnny, 2026-09-18: "If ACE QOL owns the press (spell, feature hop, 7th-level
// Teleport, anything in the pipeline), Forge plays nothing ... Forge only plays
// traps and secret doors." Forge's own runtime, driven by a press with a Forge
// FX of its own.
console.log(`\nFORGE PLAYS TRAPS AND SECRET DOORS, NOT PRESSES`);
await quiet(async () => {
  const lengths = Object.fromEntries(Object.entries(hooks).map(([k, v]) => [k, v.length]));
  const keepF = { window: globalThis.window, hadWindow: Object.prototype.hasOwnProperty.call(globalThis, "window"),
    addEv: globalThis.addEventListener, remEv: globalThis.removeEventListener,
    data: foundry.data, abstract: foundry.abstract, documents: foundry.documents,
    modules: game.modules.get, seq: globalThis.Sequence };
  let runtime = null, why = "";
  try {
    globalThis.window = globalThis;
    globalThis.addEventListener ??= () => {};
    globalThis.removeEventListener ??= () => {};
    foundry.data ??= { regionBehaviors: { RegionBehaviorType: class {} }, fields: new Proxy({}, { get: () => class {} }) };
    foundry.abstract ??= { DataModel: class {}, TypeDataModel: class {} };
    foundry.documents ??= new Proxy({}, { get: () => class {} });
    runtime = await import("file:///D:/FoundryVTT/Data/modules/ace-artificer/scripts/forge-fx-runtime.mjs");
  } catch (err) { why = err?.message ?? String(err); }
  try {
    if (!runtime) {
      check("Forge plays nothing on a press while ACE QOL runs", false, `Forge's FX runtime could not be loaded here: ${why}`);
    } else {
      let built = 0;
      const chainable = () => { const px = new Proxy(function () {}, { get: (_t, k) => (k === "then" ? undefined
        : k === "play" ? async () => true : () => px) }); return px; };
      globalThis.Sequence = function Sequence() { built++; return chainable(); };
      const before = (hooks["dnd5e.postCreateUsageMessage"] ?? []).length;
      runtime.activateFxRuntime();
      const onUse = (hooks["dnd5e.postCreateUsageMessage"] ?? [])[before];
      const owner = { id: "forge-a", name: "a Forge tester", type: "npc", getActiveTokens: () => [], items: [] };
      const shimmer = { id: "forge-i", uuid: "Actor.forge-a.Item.forge-i", name: "A Shimmer", type: "feat",
        documentName: "Item", actor: owner, parent: owner,
        flags: { "ace-artificer": { fx: { v: 2, sounds: [{ src: "sounds/notify.wav", volume: 0.5 }], trigger: { on: "use" } } } },
        getFlag(scope, key) { return this.flags?.[scope]?.[key]; },
        system: { activities: { contents: [{ type: "utility", target: { affects: { type: "self" } }, range: { units: "self" } }] } } };
      const aceOn = (id) => (id === "ace-qol" ? { active: true } : null);
      game.modules.get = aceOn;
      await onUse?.(shimmer, {});
      const withAce = built;
      game.modules.get = () => null;
      await onUse?.(shimmer, {});
      const withoutAce = built - withAce;
      game.modules.get = aceOn;
      await runtime._testPlayFx(runtime.readItemFx(shimmer), shimmer);
      const testPlay = built - withAce - withoutAce;
      check("Forge plays nothing on a press while ACE QOL runs, not even an item with a Forge FX of its own; without ACE QOL the same press plays, and the editor's Test Play still does (2026-09-18)",
        typeof onUse === "function" && withAce === 0 && withoutAce >= 1 && testPlay >= 1,
        `played with ACE QOL running: ${withAce}; without it: ${withoutAce}; the editor's Test Play: ${testPlay}`);
    }
  } finally {
    for (const [k, n] of Object.entries(lengths)) hooks[k].length = n;
    for (const k of Object.keys(hooks)) if (!(k in lengths)) delete hooks[k];
    if (keepF.hadWindow) globalThis.window = keepF.window; else delete globalThis.window;
    if (keepF.addEv === undefined) delete globalThis.addEventListener; else globalThis.addEventListener = keepF.addEv;
    if (keepF.remEv === undefined) delete globalThis.removeEventListener; else globalThis.removeEventListener = keepF.remEv;
    if (keepF.data === undefined) delete foundry.data; else foundry.data = keepF.data;
    if (keepF.abstract === undefined) delete foundry.abstract; else foundry.abstract = keepF.abstract;
    if (keepF.documents === undefined) delete foundry.documents; else foundry.documents = keepF.documents;
    game.modules.get = keepF.modules;
    if (keepF.seq === undefined) delete globalThis.Sequence; else globalThis.Sequence = keepF.seq;
  }
});

/* ── THE VISION STAMP ────────────────────────────────────────────────────── */
// Johnny, 2026-09-18: "Neferon's token is Basic Vision. The book is Truesight
// 120 ft." Over every creature in his world: the stamp only ever raises what a
// token carries toward its sheet's senses, never lowers it; Neferon and the
// arcanaloths come out in the Truesight mode at 120 feet.
console.log(`\nTHE VISION STAMP`);
await quiet(async () => {
  const { VisionAudit } = await import(`${MODULE}/scripts/vision-audit.mjs`);
  const keepModes = CONFIG.Canvas.visionModes;
  CONFIG.Canvas.visionModes = { basic: {}, darkvision: {}, truesight: {} };
  try {
    let stamped = 0, lowered = [], creatures = 0;
    const why = new Map();
    for (const actor of ACTORS.values()) {
      if (actor.type !== "npc" && actor.type !== "character") continue;
      creatures++;
      // As the pass does: a creature with nothing on its sheet has nothing to copy.
      const ranges = VisionAudit.sheetSenses(actor);
      if (!VisionAudit._hasAny(ranges)) continue;
      const proto = actor.prototypeToken ?? {};
      const stamp = VisionAudit.stampFor({ sight: proto.sight, detectionModes: proto.detectionModes }, ranges);
      if (!stamp) continue;
      stamped++;
      for (const c of stamp.changes) {
        const kind = c.replace(/\d+/g, "N");
        why.set(kind, (why.get(kind) ?? 0) + 1);
      }
      const was = proto.sight ?? {};
      const before = new Map((proto.detectionModes ?? []).map(m => [m?.id, Number(m?.range) || 0]));
      const shorter = (Number(stamp.sight.range) || 0) < (Number(was.range) || 0)
        || [...before].some(([id, ft]) => (Number(stamp.detectionModes.find(m => m?.id === id)?.range) || 0) < ft)
        || stamp.detectionModes.length < before.size
        || (was.visionMode && was.visionMode !== "basic" && stamp.sight.visionMode !== was.visionMode);
      if (shorter) lowered.push(actor.name);
    }
    check("the vision stamp over his whole world only ever raises a token toward its sheet, never lowers or replaces what is there (2026-09-18)",
      creatures > 2000 && stamped > 0 && lowered.length === 0,
      `${stamped} of ${creatures} creatures' tokens would be stamped: `
        + `${[...why].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${n}x ${k}`).join("; ")}`
        + (lowered.length ? `; LOWERED: ${lowered.slice(0, 5).join(", ")}` : ""));
    const after = (name) => {
      const actor = [...ACTORS.values()].find(a => a.name === name);
      if (!actor) return null;
      const proto = actor.prototypeToken ?? {};
      const stamp = VisionAudit.stampFor({ sight: proto.sight, detectionModes: proto.detectionModes }, VisionAudit.sheetSenses(actor));
      const sight = stamp?.sight ?? proto.sight ?? {};
      const modes = stamp?.detectionModes ?? proto.detectionModes ?? [];
      return `${sight.enabled ? "on" : "off"}, ${sight.range} ft, ${sight.visionMode}, truesight ${modes.find(m => m?.id === "seeAll")?.range ?? "none"}`;
    };
    const nef = after("Neferon"), arc = after("Arcanaloth"), legacy = after("Arcanaloth (Legacy)");
    check("Neferon and the arcanaloths, 2014 and 2024, come out with Truesight 120 in the Truesight mode, not Basic Vision (2026-09-18)",
      [nef, arc, legacy].every(v => v === "on, 120 ft, truesight, truesight 120"),
      `Neferon: ${nef}; Arcanaloth: ${arc}; Arcanaloth (Legacy): ${legacy}`);
  } finally {
    CONFIG.Canvas.visionModes = keepModes;
    if (keepModes === undefined) delete CONFIG.Canvas.visionModes;
  }
});

/* ── DEATH BURSTS, BURNING BODIES AND THE START-OF-TURN GAZE ─────────────── */
// 2026-09-19, his three families, none of them pressed: "When the creature hits
// 0 hit points, if its words say it explodes ... No button", "His Fire
// Salamander did nothing. Fix that", and "PETRIFYING GAZE. This used to work.
// It does not now. Restore it." Pinned with his own Magmin, salamanders,
// basilisk and medusa. The save engine and the road's landing are stood in:
// what is pinned is who is caught, by what, and that it asks for nothing.
console.log(`\nDEATH BURSTS, BURNING BODIES AND THE GAZE`);
await quiet(async () => {
  const { CreatureTriggers } = await import(`${MODULE}/scripts/creature-triggers.mjs`);
  const { GazeEngine } = await import(`${MODULE}/scripts/gaze-engine.mjs`);
  const { RetaliationEngine } = await import(`${MODULE}/scripts/retaliation-engine.mjs`);
  const W = await import(`${MODULE}/scripts/rules/creature-words.mjs`);
  const itemOn = (actor, name) => actor?.items?.find?.(i => i.name === name) ?? null;
  const findActor = (name, test) => [...ACTORS.values()].find(a => a.name === name && test(a)) ?? null;
  const keepApi = { ...(game.aceQol ?? {}) };
  game.aceQol ??= {};
  const pc = (name, extra = {}) => ({ id: `replay-${name}`, name, type: "character", img: "",
    system: { attributes: { hp: { value: 30, max: 30 }, death: { failure: 0 } } },
    statuses: new Set(), effects: new Collection(), items: new Collection(), ...extra });
  const sceneOf = (id) => ({ id, tokens: { contents: [] } });
  const tok = (scene, id, name, col, row, actor, disposition = 1) => {
    const t = { id, name, x: col * 100, y: row * 100, width: 1, height: 1, elevation: 0, disposition,
      actor, parent: scene, object: null, flags: {}, texture: { src: "" }, getFlag: () => undefined };
    scene.tokens.contents.push(t);
    return t;
  };
  try {
    // ── 1. The Magmin's Death Burst ──
    const magmin = findActor("Magmin", a => !!itemOn(a, "Death Burst"));
    if (!magmin) {
      check("the Magmin's Death Burst goes off when it drops to 0 (2026-09-19)", null, "(no Magmin with a Death Burst in this world)");
    } else {
      const seen = [];
      game.aceQol.saveEngine = { postSaveCard: async (item, actor, tokens, opts) => {
        seen.push({ item: item?.name, who: tokens.map(t => t.name), opts });
      } };
      const s = sceneOf("replay-burst");
      const magDoc = tok(s, "t-magmin", "Magmin", 5, 5, magmin, -1);
      tok(s, "t-chudd", "Chudd", 6, 5, pc("Chudd"));                 // beside it: 5 feet
      tok(s, "t-kas", "Kasimir", 7, 7, pc("Kasimir"));               // one empty square between, diagonally: 10 feet
      tok(s, "t-firaxis", "Firaxis", 9, 5, pc("Firaxis"));           // 20 feet: out
      tok(s, "t-corpse", "Dead Goblin", 5, 6, pc("Dead Goblin", { statuses: new Set(["dead"]) }), -1);
      await CreatureTriggers.onDeath({ actor: magmin, tokenDoc: magDoc });
      const one = seen[0];
      const fail = (one?.opts?.recipe?.onFail ?? []).map(o => `${o.formula ?? o.condition?.key ?? "?"} ${(o.types ?? []).join("/")}${o.onSuccess ? ` (${o.onSuccess})` : ""}`.trim());
      check("his Magmin's Death Burst goes off when it drops to 0: one DEX DC 11 save for the living within 10 feet (Chudd, Kasimir), the corpse and Firaxis at 20 feet left off, resolving itself with no button (2026-09-19)",
        seen.length === 1 && one.who.join(", ") === "Chudd, Kasimir" && one.opts.saveAbility === "dex"
          && one.opts.saveDC === 11 && one.opts.autoResolve === true && one.opts.trigger === "dies"
          && fail.some(f => /2d6 fire \(half\)/.test(f)),
        seen.length ? `${one.item}: ${one.who.join(", ")}; ${String(one.opts.saveAbility).toUpperCase()} DC ${one.opts.saveDC}; on a fail ${fail.join(", ")}; resolves itself: ${one.opts.autoResolve}` : "no save card was posted");
    }

    // ── The Magmin on his map: the 2024 Monster Manual copy, words in lookups ──
    // His table, 2026-09-19: "He dropped a Magmin to 0. Chat posted the item's raw
    // description with unresolved [[lookup]] tags. No Dex save. No fire damage."
    // Its "when it dies" is a lookup of the activity's condition, and ACE Engine
    // fired its own name-matched burst and pasted the sheet text.
    {
      const mm = ACTORS.get("mmMagmin00000000") ?? null;
      const burst = itemOn(mm, "Death Burst");
      if (!mm || !burst) {
        check("the Magmin on his map (2024 Monster Manual) bursts from its words, lookups answered (2026-09-19)", null, "(no mmMagmin00000000 in this world)");
      } else {
        const seen = [];
        game.aceQol.saveEngine = { postSaveCard: async (item, actor, tokens, opts) => {
          seen.push({ item: item?.name, who: tokens.map(t => t.name), opts });
        } };
        const s = sceneOf("replay-burst-mm");
        const magDoc = tok(s, "t-mm-magmin", "Magmin", 40, 49, mm, -1);
        tok(s, "t-mm-chudd", "Chudd", 41, 50, pc("Chudd"));             // corner to corner: 5 feet
        tok(s, "t-mm-corpse", "Dead Kobold", 39, 49, pc("Dead Kobold", { statuses: new Set(["dead"]) }), -1);
        await CreatureTriggers.onDeath({ actor: mm, tokenDoc: magDoc });
        const one = seen[0];
        const words = W.itemWords(burst);
        const fail = (one?.opts?.recipe?.onFail ?? []).map(o => `${o.formula ?? o.condition?.key ?? "?"} ${(o.types ?? []).join("/")}${o.onSuccess ? ` (${o.onSuccess})` : ""}`.trim());
        check("the Magmin on his map (2024 Monster Manual) bursts: its \"when it dies\" read out of the lookup, one DEX save card with the DC its activity works out, Chudd beside it on the card, the dead kobold not, half fire damage rolled by itself and waiting for APPLY (2026-09-19)",
          /explodes when it dies/i.test(words) && !/\[\[/.test(words) && seen.length === 1
            && one.who.join() === "Chudd" && one.opts.saveAbility === "dex" && Number.isFinite(one.opts.saveDC)
            && one.opts.saveDC > 0 && one.opts.autoResolve === true && fail.some(f => /2d6 fire \(half\)/.test(f)),
          seen.length ? `"${words.slice(0, 60)}…"; ${one.who.join(", ")}; ${String(one.opts.saveAbility).toUpperCase()} DC ${one.opts.saveDC}; on a fail ${fail.join(", ")}`
            : `nothing posted; its words read "${words.slice(0, 90)}"`);
      }
    }

    // ── ACE Engine's own death listener stands down for the bursts QOL runs ──
    // The card in his screenshot was Engine's (monster automation, which his
    // world has switched on): "ACE: Monsters", the stat block's raw text.
    {
      const mm = ACTORS.get("mmMagmin00000000") ?? null;
      if (!mm) {
        check("ACE Engine leaves the Magmin's burst to QOL (2026-09-19)", null, "(no mmMagmin00000000 in this world)");
      } else {
        const keepModules = game.modules;
        const before = (hooks["updateActor"] ?? []).length;
        let withQol = 0, alone = [];
        try {
          game.modules = { get: (id) => (id === "ace-qol" ? { active: true } : keepModules?.get?.(id) ?? null) };
          game.aceQol.CreatureTriggers = CreatureTriggers;
          const { initMonsterAutomation } = await import("file:///D:/FoundryVTT/Data/modules/ace-engine/scripts/combat/monster-automation.mjs");
          initMonsterAutomation();
          const engineHooks = (hooks["updateActor"] ?? []).slice(before);
          const zero = { system: { attributes: { hp: { value: 0 } } } };
          let n = posted.length;
          for (const h of engineHooks) h(mm, zero);
          await new Promise(r => setTimeout(r, 150));
          withQol = posted.length - n;
          // A table running Engine without QOL: its own card, in words, never raw tags.
          delete game.aceQol.CreatureTriggers;
          game.modules = { get: () => null };
          n = posted.length;
          for (const h of engineHooks) h(mm, zero);
          await new Promise(r => setTimeout(r, 300));
          alone = posted.slice(n).map(m => String(m.content ?? ""));
        } finally {
          game.modules = keepModules;
          game.aceQol.CreatureTriggers = CreatureTriggers;
        }
        check("ACE Engine's own death listener posts nothing for the Magmin's burst while QOL runs it, and without QOL its card is the burst's numbers, never the sheet's raw [[lookup]] tags (2026-09-19)",
          withQol === 0 && alone.length === 1 && !/\[\[/.test(alone[0]) && /2d6/.test(alone[0]),
          `with QOL: ${withQol} Engine card(s); without: ${alone.length} card(s)${alone[0] ? `, "${alone[0].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 90)}"` : ""}`);
      }
    }

    // Which bursts his world has, by their words (and the ones the GM keeps).
    {
      const bursts = [], gm = [], none = [];
      for (const a of ACTORS.values()) for (const it of a.items ?? []) {
        if (it.type === "spell") continue;
        const b = W.readDeathBurst(it);
        if (!b) continue;
        (b.gmOnly ? gm : b.nothingToRoll ? none : bursts).push(`${a.name} / ${it.name}`);
      }
      check("every death burst in his world is found by its words, not its name: mephits, magmin, balor, gas spore, gauth, rot zombies, the phoenix; the Boar Cart and Living Fire are handed to the GM, the marid's and the old smoke mephit's put nothing on anyone (2026-09-19)",
        bursts.some(x => /^Magmin \//.test(x)) && bursts.some(x => /Mephit \//.test(x)) && bursts.some(x => /^Balor \//.test(x))
          && gm.some(x => /Boar Cart/.test(x)) && gm.some(x => /Living Fire/.test(x))
          && none.some(x => /Marid/.test(x)) && !bursts.some(x => /Hellfire Orb|Zuggtmoy/.test(x)),
        `${bursts.length} run by ACE, ${gm.length} handed to the GM (${gm.join("; ")}), ${none.length} with nothing to roll`);
    }

    // ── 2. The salamanders ──
    const sal24 = findActor("Salamander", a => /7 \(2d6\) Fire/i.test(W.itemWords(itemOn(a, "Fire Aura") ?? {})));
    if (!sal24) {
      check("his 2024 Salamander's Fire Aura burns whoever stands beside it at the end of its turn (2026-09-19)", null, "(no 2024 Salamander with that Fire Aura in this world)");
    } else {
      const landed = [];
      const keepLand = CreatureTriggers._land;
      CreatureTriggers._land = async (rec, item, actor, caught, trigger, happened) => {
        landed.push({ item: item.name, who: caught.map(t => t.name),
          dice: (rec.recipe.onSuccess ?? []).map(o => `${o.formula} ${(o.types ?? []).join("/")}`).join(", "), trigger, happened });
      };
      try {
        const s = sceneOf("replay-aura");
        const salDoc = tok(s, "t-sal", "Salamander", 5, 5, sal24, -1);
        const chuddDoc = tok(s, "t-chudd2", "Chudd", 6, 6, pc("Chudd"));       // corner to corner: 5 feet
        tok(s, "t-ogre", "Ogre", 4, 5, pc("Ogre", { type: "npc" }), -1);        // beside it, and on its side
        tok(s, "t-fir2", "Firaxis", 7, 5, pc("Firaxis"));                        // 10 feet: out of 5
        const combat = { started: true, scene: s, combatants: { get: (id) => ({ "c-sal": { token: salDoc }, "c-chudd": { token: chuddDoc } })[id] ?? null } };
        await CreatureTriggers.onTurnChange(combat, { combatantId: "c-sal" }, { combatantId: "c-chudd" });
      } finally {
        CreatureTriggers._land = keepLand;
      }
      const one = landed[0];
      check("standing next to his 2024 Salamander burns at the end of its turn: 2d6 fire from its own words on Chudd, the Ogre on its side spared by its choice, Firaxis at 10 feet out of reach, no button (2026-09-19)",
        landed.length === 1 && one.who.join() === "Chudd" && one.dice === "2d6 fire" && one.trigger === "aura",
        landed.length ? `${one.item}: ${one.who.join(", ")} ${one.happened}; ${one.dice}` : "nothing landed");
    }
    const sal14 = findActor("Salamander", a => !!itemOn(a, "Heated Body"));
    const heated = sal14 ? RetaliationEngine._parse(itemOn(sal14, "Heated Body")) : null;
    check("his 2014 Salamander's Heated Body is read from its words: hit it in melee from within 5 feet and take 2d6 fire (2026-09-19)",
      sal14 ? (heated?.formula === "2d6" && heated?.type === "fire" && heated?.range === 5) : null,
      sal14 ? (heated ? `${heated.formula} ${heated.type} within ${heated.range} feet` : "not read") : "(no 2014 Salamander in this world)");
    {
      const auras = [];
      for (const a of ACTORS.values()) for (const it of a.items ?? []) {
        const t = W.readTurnAura(it);
        if (t) auras.push(`${a.name} / ${it.name} (${t.when})`);
      }
      check("the bodies that burn on a turn are found by their words: the salamanders', fire elementals', balors' and azer's Fire Aura, the remorhaz's Heat Aura (2026-09-19)",
        ["Salamander /", "Fire Elemental /", "Balor /", "Azer Sentinel /", "Remorhaz /"].every(k => auras.some(x => x.startsWith(k))),
        `${auras.length} in his world`);
    }

    // ── 3. The basilisk's gaze ──
    const basilisk = findActor("Basilisk", a => W.readTurnGaze(itemOn(a, "Petrifying Gaze") ?? {}) !== null);
    if (!basilisk) {
      check("his 2014 Basilisk's Petrifying Gaze fires at the start of a creature's turn (2026-09-19)", null, "(no 2014 Basilisk in this world)");
    } else {
      const saves = [], asked = [];
      let avert = false;
      game.aceQol.saveEngine = { postSaveCard: async (item, actor, tokens, opts) => {
        saves.push({ item: item?.name, who: tokens.map(t => t.name), opts });
      } };
      game.aceQol.reactionEngine = { _promptReaction: async (o) => { asked.push(o); return { accepted: avert }; } };
      const s = sceneOf("replay-gaze");
      const basDoc = tok(s, "t-bas", "Basilisk", 5, 5, basilisk, -1);
      const marks = [];
      const chudd = pc("Chudd", { createEmbeddedDocuments: async (_t, rows) => { marks.push(...rows); return rows; } });
      const chuddDoc = tok(s, "t-chudd3", "Chudd", 8, 5, chudd);                                   // 15 feet
      const ogreDoc = tok(s, "t-ogre2", "Ogre", 6, 5, pc("Ogre", { type: "npc" }), -1);           // its own side
      const kasDoc = tok(s, "t-kas3", "Kasimir", 5, 8, pc("Kasimir", { statuses: new Set(["blinded"]) }));   // blinded
      const farDoc = tok(s, "t-far3", "Firaxis", 12, 5, pc("Firaxis"));                           // 35 feet
      const combat = { started: true, scene: s, combatants: { get: (id) => ({ c1: { token: chuddDoc }, c2: { token: ogreDoc }, c3: { token: kasDoc }, c4: { token: farDoc } })[id] ?? null } };
      await GazeEngine._onTurnStart(combat, { combatantId: "c1" });
      const first = { saves: saves.length, asked: asked.length, save: saves[0] };
      await GazeEngine._onTurnStart(combat, { combatantId: "c2" });
      await GazeEngine._onTurnStart(combat, { combatantId: "c3" });
      await GazeEngine._onTurnStart(combat, { combatantId: "c4" });
      const after = saves.length;
      avert = true;
      await GazeEngine._onTurnStart(combat, { combatantId: "c1" });
      check("his Basilisk's gaze fires as Chudd's turn starts 15 feet away: the avert box to his owner, then a CON DC 12 save on its own card, resolving itself; its own Ogre, a blinded Kasimir and Firaxis at 35 feet are never asked (2026-09-19)",
        first.saves === 1 && first.asked === 1 && first.save.who.join() === "Chudd" && first.save.opts.saveAbility === "con"
          && first.save.opts.saveDC === 12 && first.save.opts.autoResolve === true && first.save.opts.trigger === "start-of-turn"
          && after === 1,
        `Chudd: ${first.asked} box, ${first.saves} save (${String(first.save?.opts?.saveAbility ?? "?").toUpperCase()} DC ${first.save?.opts?.saveDC ?? "?"}); saves after the Ogre, Kasimir and Firaxis: ${after}`);
      check("and when Chudd averts his eyes there is no save, and he carries the mark that he cannot see the Basilisk until his next turn (2026-09-19)",
        saves.length === 1 && marks.length === 1 && Array.isArray(marks[0]?.flags?.["ace-qol"]?.avertEyesFrom)
          && marks[0].flags["ace-qol"].avertEyesFrom.includes("t-bas"),
        `saves: ${saves.length}; mark: ${marks.length ? JSON.stringify(marks[0].flags["ace-qol"]) : "none"}`);
    }

    // ── The 2014 medusa's two new stages, in the save engine's own words ──
    const medusa = findActor("Medusa", a => !!W.readTurnGaze(itemOn(a, "Petrifying Gaze") ?? {})?.failBy);
    const goblin = [...ACTORS.values()].find(a => a.type === "npc" && /^goblin$/i.test(a.name)) ?? null;
    if (!medusa || !goblin) {
      check("his 2014 Medusa's gaze: a fail by 5 or more is stone at once, a lesser fail stages toward it (2026-09-19)", null, "(no 2014 Medusa or no Goblin in this world)");
    } else {
      const gazeIt = itemOn(medusa, "Petrifying Gaze");
      const engine = Object.create(SaveEngine.prototype);
      const target = { ...goblin, id: "replay-gaze-target", uuid: "Actor.replay-gaze-target",
        prototypeToken: { ...(goblin.prototypeToken ?? {}), actorLink: true }, statuses: new Set(), effects: new Collection() };
      ACTORS.set(target.id, target);
      const row = (total) => ({ name: target.name, img: "", actorId: target.id, tokenDocId: null, sceneId: null, passed: false, saveTotal: total });
      const lines = [];
      let byFive = null, byTwo = null;
      try {
        const recipe = SaveEngine.saveRecipe(gazeIt, readActivities(gazeIt).find(x => x.type === "save")).recipe;
        const keepLog = console.log;
        console.log = (...a) => lines.push(a.map(String).join(" "));
        try {
          byFive = await engine._applyFailedSaveConditions(gazeIt, [row(8)], { recipe, saveAbility: "con", saveDC: 14, dryRun: true });
          byTwo = await engine._applyFailedSaveConditions(gazeIt, [row(12)], { recipe, saveAbility: "con", saveDC: 14, dryRun: true });
        } finally { console.log = keepLog; }
      } finally {
        ACTORS.delete(target.id);
      }
      const conds = (a) => (a ?? []).flatMap(x => x.conditions ?? []).join(", ") || "nothing";
      const staged = lines.some(l => /WOULD apply "restrained"[^\n]*repeatingSave/.test(l));
      check("his 2014 Medusa's gaze in the save engine: failing DC 14 by 6 is Petrified at once, failing by 2 is Restrained with the repeat save that petrifies, from its words (its recipe named only restrained) (2026-09-19)",
        conds(byFive) === "petrified" && conds(byTwo) === "restrained" && staged,
        `by 6: ${conds(byFive)}; by 2: ${conds(byTwo)}${staged ? " (staged toward petrified)" : " (NOT staged)"}`);
    }

    // ── A trigger's save card finishes itself (no button) ──
    {
      const engine = Object.create(SaveEngine.prototype);
      const calls = [];
      engine._completeSaveResultsPhase2 = async (m) => { calls.push("damage"); m.flags["ace-qol"].phase = 2; };
      engine._applyAllSaveDamage = async () => { calls.push("apply"); };
      let n = 0;
      const card = (rows, extra = {}) => {
        const m = { id: `replay-auto-${++n}`, flags: { "ace-qol": { autoResolve: true, phase: 1, hasDamage: true,
          halfOnSave: true, allResults: rows, trigger: "dies", ...extra } } };
        m.setFlag = async (sc, k, v) => { m.flags[sc][k] = v; return m; };
        return m;
      };
      await engine._autoResolveIfReady(card([{ pending: true }, { pending: false, passed: false, damageMultiplier: 1 }]));
      const waited = calls.length;
      const ready = card([{ pending: false, passed: false, damageMultiplier: 1 }]);
      await engine._autoResolveIfReady(ready);
      await engine._autoResolveIfReady(ready);   // a second render never lands it twice
      await engine._autoResolveIfReady(card([{ pending: false, passed: true, damageMultiplier: 0 }]));
      await engine._autoResolveIfReady(card([{ pending: false, passed: false, damageMultiplier: 1 }], { autoResolve: false }));
      check("a trigger's save card rolls its own damage once the last save is in, once, and NEVER applies it: the card waits with APPLY ALL and UNDO for the GM, like a Fireball's (his correction, 2026-09-19: \"Do not auto-apply burst damage\"); it waits for a player still rolling and rolls nothing when nobody takes any",
        waited === 0 && calls.join(",") === "damage" && ready.flags["ace-qol"].applied !== true,
        `while a player rolls: ${waited} steps; then: ${calls.join(", ") || "none"}; applied by itself: ${ready.flags["ace-qol"].applied === true}`);
    }
    {
      const { catchesOn, TRIGGERS } = await import(`${MODULE}/scripts/road/run.mjs`);
      const silent = { recatch: [] };
      check("the road takes a creature's death and its turn as triggers, fired by its own words; an area's re-catch still needs its words (2026-09-19)",
        TRIGGERS.includes("dies") && TRIGGERS.includes("aura") && catchesOn(silent, "dies").ok
          && catchesOn(silent, "aura").ok && !catchesOn(silent, "start-of-turn").ok,
        `triggers: ${TRIGGERS.join(", ")}`);
    }
  } finally {
    for (const k of Object.keys(game.aceQol)) if (!(k in keepApi)) delete game.aceQol[k];
    Object.assign(game.aceQol, keepApi);
  }
});

/* ── SAVE CARD UX: THE BOX, THE RESULTS CARD, ONE CONCENTRATION CHECK ───── */
// Johnny, 2026-09-19: "Chat keeps the results. The player who must roll gets a
// popout. NPCs do not sit on a waiting list." And the stop: "a Magmin burst or
// a Fireball gives the player a blinking popout with sound, the chat shows
// results only, and a second concentration click does not roll." Run on the
// live save path with his own Magmin and Fireball: the cards ACE posts, how
// each screen draws them, the box the player's screen opens, their one click,
// and a concentrating character hit and then pressed three times. The box's own
// behaviour (the blink, the focus, one click, the missing-sound notice) is
// pinned in tools/roll-popout-selftest.mjs.
console.log(`\nSAVE CARD UX: THE BOX, THE RESULTS CARD, ONE CONCENTRATION CHECK`);
{
  const MOD = "ace-qol";
  const { RollPopout } = await import(`${MODULE}/scripts/roll-popout.mjs`);
  const { ConcentrationPrompt } = await import(`${MODULE}/scripts/concentration-prompt.mjs`);
  const { CheckGate } = await import(`${MODULE}/scripts/check-gate.mjs`);
  const { PcSaveNudge } = await import(`${MODULE}/scripts/pc-save-nudge.mjs`);
  const SCENE7 = "replay-ux-scene";
  const PLAYER = { id: "tommy", name: "Tommy", isGM: false, active: true, character: null };
  const AWAY = { id: "jex", name: "Jexxi", isGM: false, active: false, character: null };
  const docs7 = new Map(), made7 = [], chat7 = new Map(), plays7 = [];
  const setPath7 = (obj, key, v) => {
    const path = key.split(".");
    let o = obj;
    for (const k of path.slice(0, -1)) o = (o[k] ??= {});
    o[path[path.length - 1]] = v;
  };
  const keep7 = { users: game.users, user: game.user, messages: game.messages, scenesGet: game.scenes.get,
    scene: canvas.scene, placed: [...canvas.tokens.placeables], create: ChatMessage.create, run: CheckGate.run,
    audio: foundry.audio, fetch: globalThis.fetch, owner: CONST.DOCUMENT_OWNERSHIP_LEVELS,
    html: globalThis.HTMLElement, dnd5e: globalThis.dnd5e, gmActive: GM.active, fromUuidSync: globalThis.fromUuidSync };

  // A Foundry actor enough for the save card, the Gate and the concentration door.
  const creature7 = (id, name, { type = "npc", owner = null, di = [], conc = null } = {}) => {
    const a = { id, name, type, img: `${id}.webp`, documentName: "Actor", uuid: `Actor.${id}`,
      statuses: new Set(), effects: new Collection(), items: new Collection(),
      ownership: owner ? { [owner]: 3 } : {}, isOwner: true, hasPlayerOwner: !!owner,
      prototypeToken: { actorLink: true }, getFlag: () => undefined, getRollData: () => ({}),
      testUserPermission: (u) => !!u && !u.isGM && (a.ownership?.[u.id] ?? 0) >= 3,
      system: { attributes: { hp: { value: 30, max: 30, temp: 0 }, death: { success: 0, failure: 0 }, prof: 2 },
        abilities: { str: { mod: 0, save: { value: 0 } }, dex: { mod: 0, save: { value: 0 } },
          con: { mod: 0, save: { value: 0 } }, wis: { mod: 0, save: { value: 0 } } },
        skills: {}, details: { type: { value: "humanoid" }, alignment: "Neutral" },
        traits: { ci: { value: new Set() }, di: { value: new Set(di) }, dr: { value: new Set() }, dv: { value: new Set() } } },
      update: async (u) => { for (const [k, v] of Object.entries(u)) setPath7(a, k, v); return a; } };
    if (conc) a.effects.set(conc.id, conc);
    ACTORS.set(id, a);
    made7.push(a);
    return a;
  };
  const place7 = (actor, id, x) => {
    const doc = { id, actorId: actor.id, actor, parent: { id: SCENE7 }, flags: {}, name: actor.name,
      hidden: false, x, y: 0, width: 1, height: 1, elevation: 0, disposition: actor.hasPlayerOwner ? 1 : -1,
      texture: { src: `${actor.id}-token.webp` }, getFlag: () => undefined,
      update: async (u) => { for (const [k, v] of Object.entries(u)) setPath7(doc, k, v); return doc; } };
    const tok = { id, name: actor.name, actor, document: doc, x, y: 0, w: 100, h: 100,
      center: { x: x + 50, y: 50 }, scene: { id: SCENE7 }, visible: true, setTarget() {} };
    doc.object = tok;
    docs7.set(id, doc);
    canvas.tokens.placeables.push(tok);
    return tok;
  };
  // A chat card as a screen draws it: the list item Foundry hands the render hook.
  globalThis.HTMLElement = keep7.html ?? class {};
  class Li extends globalThis.HTMLElement {
    constructor() { super(); this.cls = new Set(); this.style = {}; }
    get classList() { const c = this.cls; return { add: (x) => c.add(x), remove: (x) => c.delete(x), contains: (x) => c.has(x) }; }
    closest() { return this; }
    querySelectorAll() { return []; }
    querySelector() { return null; }
    setAttribute() {}
  }
  const drawOn = (user, message, handlers) => {
    game.user = user;
    const li = new Li();
    const keepLog = console.log;
    console.log = () => {};   // ACE's own lines while a screen draws the card
    try { for (const h of handlers) h(message, li); } finally { console.log = keepLog; }
    return li;
  };
  const folded = (li) => li.classList.contains("ace-qol-save-collapsed");

  try {
    GM.active = true;
    const users7 = Object.assign([GM, PLAYER, AWAY], { activeGM: GM });
    users7.get = (id) => users7.find(u => u.id === id);
    game.users = users7;
    game.user = GM;
    CONST.DOCUMENT_OWNERSHIP_LEVELS = { NONE: 0, LIMITED: 1, OBSERVER: 2, OWNER: 3 };
    foundry.audio = { AudioHelper: { play: (o) => { plays7.push({ user: game.user?.id, ...o }); return Promise.resolve({}); } } };
    globalThis.fetch = async () => ({ ok: true, status: 200 });
    // An actor by its id, as Foundry resolves "Actor.<id>".
    globalThis.fromUuidSync = (u) => (String(u).startsWith("Actor.") ? ACTORS.get(String(u).slice(6)) ?? null : keep7.fromUuidSync(u));
    game.messages = { get: (id) => chat7.get(id) ?? null, get contents() { return [...chat7.values()]; } };
    ChatMessage.create = async (data, opts) => {
      const msg = await keep7.create(data, opts);
      // Foundry reads a dotted key as a path: "flags.ace-qol.status" is a flag.
      const plain = msg.update;
      msg.update = async (u = {}) => {
        const rest = {};
        for (const [k, v] of Object.entries(u)) { if (k.includes(".")) setPath7(msg, k, v); else rest[k] = v; }
        return plain(rest);
      };
      msg.whisper = data?.whisper ?? [];
      msg.author = data?.author ?? null;
      chat7.set(msg.id, msg);
      return msg;
    };
    const scene7 = { id: SCENE7, templates: { get: () => null },
      tokens: { get: (t) => docs7.get(t) ?? null, get contents() { return [...docs7.values()]; } } };
    game.scenes.get = (id) => (id === SCENE7 ? scene7 : keep7.scenesGet(id));
    canvas.scene = scene7;
    canvas.tokens.placeables.length = 0;

    // Tommy's character, a bandit, and a creature fire cannot touch.
    const chudd = creature7("replay-ux-chudd", "Chudd", { type: "character", owner: "tommy" });
    const bandit = creature7("replay-ux-bandit", "a bandit");
    const imp = creature7("replay-ux-azer", "an azer", { di: ["fire"] });
    const chuddTok = place7(chudd, "tok-ux-chudd", 100);
    const banditTok = place7(bandit, "tok-ux-bandit", 200);
    const impTok = place7(imp, "tok-ux-azer", 300);

    // The prompt-card ding, as ACE's startup registers it, kept apart from the engine's hooks.
    const { registerPromptCardDing, popupDing } = await import(`${MODULE}/scripts/popup-ding.mjs`);
    const cardDingAt = (hooks.createChatMessage ?? []).length;
    registerPromptCardDing();
    const cardDingHooks = (hooks.createChatMessage ?? []).slice(cardDingAt);
    const held = (li) => li.classList.contains("ace-qol-held-for-dice");

    let engine7 = null;
    const beforeHooks = { render: (hooks.renderChatMessage ?? []).length, create: (hooks.createChatMessage ?? []).length };
    try { await quiet(async () => { engine7 = new SaveEngine({}); }); } catch (err) { engine7 = null; }
    const renderHooks = (hooks.renderChatMessage ?? []).slice(beforeHooks.render);
    const createHooks = (hooks.createChatMessage ?? []).slice(beforeHooks.create);

    const mm = ACTORS.get("mmMagmin00000000") ?? null;
    const burst = mm ? [...(mm.items ?? [])].find(i => i.name === "Death Burst") ?? null : null;
    const burstAct = burst ? [...(burst.system?.activities ?? [])].find(a => a.type === "save") ?? null : null;
    if (!engine7 || !burst || !burstAct) {
      check("his Magmin's burst asks Chudd's player in a box (2026-09-19)", null,
        engine7 ? "no 2024 Magmin with a Death Burst save in this world" : "the save engine would not start in the stand-in");
    } else {
      // ── 1. The Magmin bursts: the live save card, driven by the GM's screen ──
      const magTok = place7(mm, "tok-ux-magmin", 0);
      let err1 = null;
      const before1 = posted.length;
      // Everything a failed save sets off listens on this one signal (the fire
      // encrust and its impact sound among them), so what it is sent for IS the
      // test for who gets a fail animation.
      const signals = [];
      const keepSend = SignalDoor.send;
      SignalDoor.send = async (name, payload) => {
        if (name === "saveComplete") signals.push({ who: payload?.actor?.name, passed: payload?.passed });
        return keepSend.call(SignalDoor, name, payload);
      };
      try {
        await quiet(async () => {
          await engine7._postLiveTargetCard(burst, mm, [chuddTok, banditTok, impTok], {
            saveAbility: "dex", saveDC: 11, isSpell: false, activityId: burstAct.id, skipDelay: true,
            autoResolve: true, trigger: "dies" });
        });
      } catch (e) { err1 = e; }
      const cards = [...chat7.values()];
      const of = (type) => cards.filter(m => m?.flags?.[MOD]?.type === type);
      const list = of("saveTargetList").at(-1) ?? null;
      const prompt = of("pcSavePrompt").at(-1) ?? null;
      const results = of("saveResults").at(-1) ?? null;
      const text = (m) => String(m?.content ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

      SignalDoor.send = keepSend;
      check("a creature that never rolled is never announced as having failed: the azer, immune to the burst's fire, gets no save-complete signal, so no fail animation and no impact sound play on it; the bandit that did roll gets one (his table, 2026-09-19)",
        signals.some(s => s.who === "a bandit") && !signals.some(s => s.who === "an azer"),
        `signalled: ${signals.map(s => `${s.who} ${s.passed ? "passed" : "failed"}`).join(", ") || "nobody"}`);

      // The chat: results only. Drawn as it was born, before the results card
      // retired it, because that is when the waiting list used to show.
      const born = list ? { ...list, flags: { [MOD]: { ...list.flags[MOD], superseded: false, rolled: false } } } : null;
      const listOnGm = born ? drawOn(GM, born, renderHooks) : null;
      const listOnPlayer = born ? drawOn(PLAYER, born, renderHooks) : null;
      check("NPCs do not sit on a waiting list: the Magmin's save card with the waiting rows is never drawn, on the GM's screen or the player's, because the NPCs roll themselves (2026-09-19)",
        !err1 && !!list && list.flags[MOD].carrier === true && folded(listOnGm) && folded(listOnPlayer),
        err1 ? `threw: ${err1?.message ?? err1}` : list ? `carrier ${list.flags[MOD].carrier}; GM ${folded(listOnGm) ? "folded" : "DRAWN"}, player ${folded(listOnPlayer) ? "folded" : "DRAWN"}` : "no save card posted");
      const rt = text(results);
      check("the chat shows one results card after the dice: the bandit's rolled save with its verdict, Chudd waiting for his player, and the azer as one line, immune to fire, no save and no row (2026-09-19)",
        !!results && /a bandit/.test(rt) && /FAIL/.test(rt) && /Chudd/.test(rt) && /WAITING FOR PLAYER/.test(rt)
          && /Immune to fire, no save:\s*an azer/.test(rt)
          && !/ace-qol-save-result-noroll[^>]*tok-ux-azer/.test(String(results.content ?? ""))
          && (String(results.content ?? "").match(/ace-qol-save-immune-line/g) ?? []).length === 1,
        results ? rt.slice(0, 260) : "no results card");

      // The box: on Tommy's screen, not on the GM's.
      const boxKey = prompt?.id ?? null;
      const onGm = prompt ? drawOn(GM, prompt, renderHooks) : null;
      const gmBox = boxKey ? RollPopout.isOpen(boxKey) : false;
      const dingsBefore = plays7.length;
      // The prompt reaches Tommy's screen (Foundry's createChatMessage), then his
      // screen draws its box; ApplicationV2 calls _onRender once it is on screen.
      let cardDings = 0;
      await quiet(async () => {
        game.user = PLAYER;
        if (prompt) for (const h of cardDingHooks) h(prompt);
        cardDings = plays7.length - dingsBefore;
        await new Promise(r => setTimeout(r, 10));
      });
      const onPlayer = prompt ? drawOn(PLAYER, prompt, renderHooks) : null;
      const box = boxKey ? RollPopout._open.get(boxKey) : null;
      await quiet(async () => { box?._onRender?.({}, {}); await new Promise(r => setTimeout(r, 10)); });
      check("the player who must roll gets the box: Chudd's save opens on Tommy's screen and not the GM's, whispered to Tommy alone, its chat card folded on both (2026-09-19)",
        !!prompt && JSON.stringify(prompt.whisper) === JSON.stringify(["tommy"]) && !gmBox && !!box
          && folded(onGm) && folded(onPlayer),
        prompt ? `whisper ${JSON.stringify(prompt.whisper)}; GM's screen ${gmBox ? "OPENED a box" : "no box"}; Tommy's ${box ? "box open" : "NO BOX"}` : "no save prompt posted");
      check("the box is the moment, in plain words: \"Magmin dies, and its Death Burst catches you.\", the Magmin's portrait and Chudd's, and one pill, \"Roll Dexterity save\" (2026-09-19)",
        !!box && box.spec.line === "Magmin dies, and its Death Burst catches you." && box.spec.sourceName === "Magmin"
          && box.spec.rollerName === "Chudd" && box.spec.pillLabel === "Roll Dexterity save",
        box ? `"${box.spec.line}" / ${box.spec.sourceName} → ${box.spec.rollerName} / "${box.spec.pillLabel}"` : "no box");
      const boxDings = plays7.slice(dingsBefore).filter(p => p.user === "tommy");
      check("the box dings the moment it opens, once, with the prompt ding, whether or not Foundry reports it drawn, and the hidden prompt card no longer dings first and takes the box's ding away (his table, 2026-09-19: \"No ding on the Death Burst popout\")",
        !!box && cardDings === 0 && boxDings.length === 1 && boxDings[0].src === "sounds/notify.wav" && boxDings[0].channel === "interface",
        `the prompt card rang ${cardDings} time(s); the box rang ${boxDings.length} time(s)${boxDings[0] ? ` (${boxDings[0].src}, ${boxDings[0].channel})` : ""}`);

      // One click: the save rolls, the box closes, the chat gains its result.
      if (box) {
        game.user = PLAYER;
        let err2 = null;
        const before2 = posted.length;
        try {
          await quiet(async () => {
            const rolling = box._roll();
            // The result reaches every screen; Tommy's is the one watching his box.
            for (let i = 0; i < 50 && !posted.slice(before2).some(m => m?.flags?.[MOD]?.type === "pcSaveResult"); i++) {
              await new Promise(r => setTimeout(r, 20));
            }
            const res = [...chat7.values()].find(m => m?.flags?.[MOD]?.type === "pcSaveResult" && m.flags[MOD].castId === list?.id);
            if (res) for (const h of createHooks) h(res);
            await rolling;
            await new Promise(r => setTimeout(r, 300));   // the player's own card update runs on a short timer
          });
        } catch (e) { err2 = e; }
        const result = posted.slice(before2).find(m => m?.flags?.[MOD]?.type === "pcSaveResult") ?? null;
        const again = drawOn(PLAYER, prompt, renderHooks);
        check("one click rolls Chudd's save: his result goes to the chat, the box closes, and his prompt stays folded with no second box (2026-09-19)",
          !err2 && !!result && result.flags[MOD].tokenDocId === "tok-ux-chudd" && !RollPopout.isOpen(boxKey)
            && folded(again) && !RollPopout.isOpen(boxKey),
          err2 ? `threw: ${err2?.message ?? err2}` : result ? `rolled ${result.flags[MOD].saveTotal} (${result.flags[MOD].resultLabel}); box ${RollPopout.isOpen(boxKey) ? "STILL OPEN" : "closed"}` : "no result posted");

        // The GM's screen gets his result: the card folds it in and, the last save
        // being in, rolls the burst's damage by itself. And stops there.
        game.user = GM;
        const hp0 = { chudd: chudd.system.attributes.hp.value, bandit: bandit.system.attributes.hp.value };
        let err3 = null;
        try {
          await quiet(async () => {
            const res = [...chat7.values()].find(m => m?.flags?.[MOD]?.type === "pcSaveResult" && m.flags[MOD].castId === list?.id);
            if (res) for (const h of createHooks) h(res);
            for (let i = 0; i < 150 && results?.flags?.[MOD]?.phase !== 2; i++) await new Promise(r => setTimeout(r, 20));
            await new Promise(r => setTimeout(r, 100));
          });
        } catch (e) { err3 = e; }
        const rf = results?.flags?.[MOD] ?? {};
        check("the Magmin's burst waits for APPLY: once Chudd's save is in, its damage is rolled onto the results card by itself, and nobody's hit points move until the GM presses APPLY ALL (his correction, 2026-09-19: \"Do not auto-apply burst damage\")",
          !err3 && rf.phase === 2 && rf.applied !== true && (rf.damageResults ?? []).length > 0
            && chudd.system.attributes.hp.value === hp0.chudd && bandit.system.attributes.hp.value === hp0.bandit,
          err3 ? `threw: ${err3?.message ?? err3}`
            : `card phase ${rf.phase}; applied by itself: ${rf.applied === true}; damage rows ${(rf.damageResults ?? []).length}; `
              + `Chudd ${hp0.chudd} → ${chudd.system.attributes.hp.value}, the bandit ${hp0.bandit} → ${bandit.system.attributes.hp.value}`);
      }
      canvas.tokens.placeables.splice(canvas.tokens.placeables.indexOf(magTok), 1);
    }

    // ── 2. A Fireball at Chudd: the same box, the spell's own words ──
    game.user = GM;
    const caster = [...ACTORS.values()].find(a => [...(a.items ?? [])].some(i => i.type === "spell" && i.name === "Fireball"
      && [...(i.system?.activities ?? [])].some(x => x.type === "save"))) ?? null;
    const fireball = caster ? [...caster.items].find(i => i.type === "spell" && i.name === "Fireball") : null;
    const fbAct = fireball ? [...fireball.system.activities].find(x => x.type === "save") : null;
    if (!engine7 || !fireball) {
      check("a Fireball at Chudd asks his player in a box (2026-09-19)", null, "nobody in this world has a Fireball with a save");
    } else {
      let err3 = null;
      const before3 = chat7.size;
      try {
        await quiet(async () => {
          await engine7._postLiveTargetCard(fireball, caster, [chuddTok, banditTok], {
            saveAbility: "dex", saveDC: 17, isSpell: true, activityId: fbAct.id, skipDelay: true });
        });
      } catch (e) { err3 = e; }
      const prompt = [...chat7.values()].slice(before3).filter(m => m?.flags?.[MOD]?.type === "pcSavePrompt").at(-1) ?? null;
      if (prompt) drawOn(PLAYER, prompt, renderHooks);
      const box = prompt ? RollPopout._open.get(prompt.id) : null;
      check(`a Fireball from ${caster.name} at Chudd opens the same box on Tommy's screen: "${caster.name} casts Fireball at you.", "Roll Dexterity save" (2026-09-19)`,
        !err3 && !!box && box.spec.line === `${caster.name} casts Fireball at you.` && box.spec.pillLabel === "Roll Dexterity save",
        err3 ? `threw: ${err3?.message ?? err3}` : box ? `"${box.spec.line}" / "${box.spec.pillLabel}"` : "no box");
      if (box) await box.close({ acpResolved: true });
    }

    // ── 3. Concentration: one check for each hit, and a second press rolls nothing ──
    const runs = [];
    CheckGate.run = async (actor, kind, key, o = {}) => { runs.push({ who: actor?.name, kind, key, ...o }); return { total: 14 }; };
    const effect = { id: "conc-ux-1", name: "Concentrating", disabled: false, statuses: new Set(["concentration"]),
      getFlag: (s, k) => (s === "dnd5e" && k === "item" ? { name: "Hold Person" } : undefined) };
    const kas = creature7("replay-ux-kas", "Kasimir", { type: "character", owner: "tommy", conc: effect });
    // dnd5e's own concentration DC, read from the installed system, not re-typed here.
    const dcSrc = readFileSync(`${SYSTEM}/dnd5e.mjs`, "utf8").match(/getConcentrationDC\(damage\) \{([\s\S]*?)\n {2}\}/)?.[1] ?? null;
    Math.clamp ??= (n, lo, hi) => Math.min(Math.max(n, lo), hi);
    if (dcSrc) kas.getConcentrationDC = new Function("damage", dcSrc);
    const ask = async (damage) => {
      const n = chat7.size;
      await quiet(() => DamageApplicator._triggerAceConcentrationCheck(kas, damage));
      return [...chat7.values()].slice(n).filter(m => m?.flags?.[MOD]?.type === "concentrationPrompt");
    };
    globalThis.dnd5e = { settings: { rulesVersion: "modern" } };
    const initBefore = { render: (hooks.renderChatMessage ?? []).length };
    ConcentrationPrompt._wired = false;
    await quiet(() => ConcentrationPrompt.init());
    const concRender = (hooks.renderChatMessage ?? []).slice(initBefore.render);
    game.user = GM;
    const hit1 = await ask(70);
    const p1 = hit1[0] ?? null;
    check("a hit on a concentrating character is one check, asked of its player: one prompt, written as Tommy's own card and whispered to him alone, nothing rolled yet, and a 2024 world's DC is dnd5e's own (70 damage: DC 30, the 2024 cap) (2026-09-19)",
      !!dcSrc && hit1.length === 1 && p1.author === "tommy" && JSON.stringify(p1.whisper) === JSON.stringify(["tommy"])
        && p1.flags[MOD].status === "pending" && p1.flags[MOD].dc === 30 && runs.length === 0,
      p1 ? `${hit1.length} prompt(s); author ${p1.author}; whisper ${JSON.stringify(p1.whisper)}; DC ${p1.flags[MOD].dc}; rolled ${runs.length}` : `${hit1.length} prompts${dcSrc ? "" : "; dnd5e's getConcentrationDC not found in its source"}`);
    globalThis.dnd5e = { settings: { rulesVersion: "legacy" } };
    const hitLegacy = await ask(70);
    check("the same hit in a 2014 world is DC 35 (no cap), dnd5e's rule for that edition (2026-09-19)",
      hitLegacy.length === 1 && hitLegacy[0].flags[MOD].dc === 35, hitLegacy[0] ? `DC ${hitLegacy[0].flags[MOD].dc}` : "no prompt");
    globalThis.dnd5e = { settings: { rulesVersion: "modern" } };

    if (p1) {
      const onGm = drawOn(GM, p1, concRender);
      const gmBox = RollPopout.isOpen(p1.id);
      const onTommy = drawOn(PLAYER, p1, concRender);
      const box = RollPopout._open.get(p1.id) ?? null;
      check("its box opens on Tommy's screen with the same d20 and pill as a save, \"Roll Concentration\", and not on the GM's; the chat card stays folded (2026-09-19)",
        !gmBox && !!box && box.spec.pillLabel === "Roll Concentration" && folded(onGm) && folded(onTommy),
        box ? `"${box.spec.line}" / "${box.spec.pillLabel}"` : "no box");
      // Press it, then press again, then the GM presses too.
      game.user = PLAYER;
      await quiet(async () => {
        if (box) await box._roll();
        await ConcentrationPrompt.roll(game.messages.get(p1.id), { choice: "suggested" });
      });
      game.user = GM;
      await quiet(() => ConcentrationPrompt.roll(game.messages.get(p1.id), { choice: "suggested" }));
      const afterRoll = drawOn(PLAYER, p1, concRender);
      check("a second concentration click does not roll: pressed in the box, then again, then by the GM, it rolls exactly once, through ACE's check at DC 30, and the card is marked rolled for every screen (2026-09-19)",
        runs.filter(r => r.who === "Kasimir").length === 1 && runs[0].kind === "concentration" && runs[0].dc === 30
          && p1.flags[MOD].status === "rolled" && !RollPopout.isOpen(p1.id) && folded(afterRoll),
        `${runs.filter(r => r.who === "Kasimir").length} roll(s); status ${p1.flags[MOD].status}; box ${RollPopout.isOpen(p1.id) ? "STILL OPEN" : "closed"}`);
    }
    // Every hit is its own check: a second hit asks again, and that one rolls too.
    const hit2 = await ask(12);
    if (hit2[0]) {
      game.user = PLAYER;
      await quiet(() => ConcentrationPrompt.roll(game.messages.get(hit2[0].id), { choice: "suggested" }));
      game.user = GM;
    }
    check("a second hit is a second check (RAW: each time you take damage): DC 10 for 12 damage, rolled once (2026-09-19)",
      hit2.length === 1 && hit2[0].flags[MOD].dc === 10 && runs.filter(r => r.who === "Kasimir").length === 2,
      hit2[0] ? `DC ${hit2[0].flags[MOD].dc}; ${runs.filter(r => r.who === "Kasimir").length} roll(s) in all` : "no prompt");
    // Nobody to wait on: a character whose player is away rolls at once, no prompt.
    const effect2 = { ...effect, id: "conc-ux-2" };
    const firaxis = creature7("replay-ux-firaxis", "Firaxis", { type: "character", owner: "jex", conc: effect2 });
    if (dcSrc) firaxis.getConcentrationDC = new Function("damage", dcSrc);
    const n4 = chat7.size;
    await quiet(() => DamageApplicator._triggerAceConcentrationCheck(firaxis, 20));
    const prompts4 = [...chat7.values()].slice(n4).filter(m => m?.flags?.[MOD]?.type === "concentrationPrompt");
    check("a character whose player is not connected is not waited on: its check rolls at once through ACE's check and no prompt is posted (2026-09-19)",
      prompts4.length === 0 && runs.filter(r => r.who === "Firaxis").length === 1,
      `${prompts4.length} prompt(s); ${runs.filter(r => r.who === "Firaxis").length} roll(s)`);
    // ── 3b. One damage roll per card ──
    {
      const engine = Object.create(SaveEngine.prototype);
      const rolls = [];
      let release = null;
      engine._rollPhase2Damage = async (m) => {
        rolls.push(m.id);
        await new Promise(res => { release = res; });        // still rolling: asking her about Absorb
        m.flags[MOD].phase = 2;
      };
      const card = { id: "replay-one-roll", flags: { [MOD]: { phase: 1, hasDamage: true, autoResolve: true } } };
      const first = engine._completeSaveResultsPhase2(card);   // the burst rolls its own
      await new Promise(res => setTimeout(res, 20));
      await quiet(() => engine._completeSaveResultsPhase2(card));   // he presses the button while it rolls
      release?.();
      await first;
      await quiet(() => engine._completeSaveResultsPhase2(card));   // and again once it is done
      check("one Magmin death is one damage roll: a second ask while the first is still rolling is refused, and so is one after the card has its damage (his table, 2026-09-19: two rolls, 8 then 10, and two Absorb Elements boxes)",
        rolls.length === 1, `${rolls.length} damage roll(s) from three asks`);

      // And the card a burst posts never offers the button that caused it.
      const rows = [{ name: "Chudd", tokenDocId: "t1", passed: false, damageMultiplier: 1, currentHP: 30, maxHP: 30, saveTotal: 6, dieResult: 1 }];
      const opts = { saveAbility: "dex", saveDC: 11, hasDamage: true, halfOnSave: true, activityId: null };
      const burstCard = engine7 ? engine7._buildPhase1CardHtml({ name: "Death Burst", img: "" }, rows, { ...opts, autoResolve: true }) : "";
      const pressedCard = engine7 ? engine7._buildPhase1CardHtml({ name: "Fireball", img: "" }, rows, { ...opts, autoResolve: false }) : "";
      check("a card that rolls its own damage shows no ROLL DAMAGE to press, only that it is rolling; a cast somebody pressed still has its button (2026-09-19)",
        !/data-action="aceQolRollDamage"/.test(burstCard) && /ROLLING DAMAGE/.test(burstCard)
          && /data-action="aceQolRollDamage"/.test(pressedCard),
        `burst card: ${/ROLLING DAMAGE/.test(burstCard) ? "rolling, no button" : "HAS A BUTTON"}; pressed card: ${/data-action="aceQolRollDamage"/.test(pressedCard) ? "ROLL DAMAGE" : "NO BUTTON"}`);
    }

    // ── 4. Chat after dice: a card waits for the dice on the screen that threw them ──
    {
      const dsn = await import(`${MODULE}/scripts/dsn-utils.mjs`);
      const { holdForDice } = await import(`${MODULE}/scripts/dice-hold.mjs`);
      const keepDice = game.dice3d;
      const keepLog = console.log;
      let land = null;
      try {
        game.dice3d = { isEnabled: () => true, showForRoll: () => new Promise(res => { land = res; }) };
        console.log = () => {};
        dsn.safeShowForRoll({ total: 17, formula: "1d20 + 5" }, "Aryel's save");     // her die in the air
        const card = { id: "replay-hold-card", flags: { [MOD]: { type: "saveResults" } }, whisper: [] };
        const li = new Li();
        const hold = holdForDice(card, li);                                          // the GM's results card arrives
        const calm = new Li(), whispered = new Li();
        const whisperHold = holdForDice({ id: "replay-hold-w", flags: { [MOD]: { type: "saveResults" } }, whisper: ["gm"] }, whispered);
        console.log = keepLog;
        const whileRolling = held(li);
        for (const h of hooks.diceSoNiceRollComplete ?? []) h("somebody-elses-attack");   // another message's dice land
        await new Promise(res => setTimeout(res, 150));
        const afterOther = held(li);
        land?.(true);                                                                   // her die lands
        await hold;
        await new Promise(res => setTimeout(res, 20));
        const afterOwn = held(li);
        const calmHold = holdForDice({ id: "replay-hold-calm", flags: { [MOD]: { type: "saveResults" } }, whisper: [] }, calm);
        const redraw = new Li();
        const redrawHold = holdForDice(card, redraw);
        check("chat after dice: on the screen that threw the dice, the GM's results card waits out of sight while her save die is in the air, somebody else's dice landing does not release it, and it shows the moment hers lands; a card with nothing of that screen's rolling, a whispered card and a redraw are never held (his rule, 2026-09-19)",
          !!hold && whileRolling && afterOther && !afterOwn && calmHold === null && !held(calm)
            && whisperHold === null && !held(whispered) && redrawHold === null,
          `while her die rolls: ${whileRolling ? "held" : "SHOWN"}; another message's dice landing: ${afterOther ? "still held" : "RELEASED"}; `
            + `her die lands: ${afterOwn ? "STILL HELD" : "shown"}; nothing rolling: ${calmHold ? "HELD" : "shown"}; whispered: ${whisperHold ? "HELD" : "shown"}`);

        // Dice So Nice off: nothing is held and nothing waits on dice nobody sees.
        game.dice3d = undefined;
        const offLi = new Li();
        const offHold = holdForDice({ id: "replay-hold-off", flags: { [MOD]: { type: "saveResults" } }, whisper: [] }, offLi);
        let took = null, errOff = null;
        const fbCaster = [...ACTORS.values()].find(a => [...(a.items ?? [])].some(i => i.type === "spell" && i.name === "Fireball"
          && [...(i.system?.activities ?? [])].some(x => x.type === "save"))) ?? null;
        const fb = fbCaster ? [...fbCaster.items].find(i => i.type === "spell" && i.name === "Fireball") : null;
        const fbA = fb ? [...fb.system.activities].find(x => x.type === "save") : null;
        if (engine7 && fb && fbA) {
          try {
            await quiet(async () => {
              const { recipe } = await SaveEngine.castRecipe(fb, fbA);
              const t0 = Date.now();
              await engine7._rollSpellDamage(fb, fbCaster, { activityId: fbA.id, recipe });
              took = Date.now() - t0;
            });
          } catch (e) { errOff = e; }
        }
        check("with Dice So Nice off, a card posts when the total exists: the Fireball's damage is not paced for dice nobody sees (it slept 1.5 s before), and no card is held (his rule, 2026-09-19)",
          !dsn.diceOnScreen() && offHold === null && !held(offLi) && !errOff && took !== null && took < 1000,
          errOff ? `threw: ${errOff?.message ?? errOff}` : `damage rolled in ${took ?? "?"} ms; card ${offHold ? "HELD" : "shown"}`);
      } finally {
        console.log = keepLog;
        game.dice3d = keepDice;
      }
    }

    // ── 5. A ding asked for before the screen's first click still sounds ──
    {
      const keepAudio = game.audio, keepPlayer = globalThis.Audio;
      const browserPlays = [];
      try {
        game.audio = { locked: true };
        globalThis.Audio = class { constructor(src) { this.src = src; this.volume = 1; }
          play() { browserPlays.push({ src: this.src, volume: this.volume }); return Promise.resolve(); } };
        await new Promise(res => setTimeout(res, 1600));   // past the one-ding window
        const before = plays7.length;
        await quiet(async () => { popupDing("a box on a screen nobody has clicked yet"); await new Promise(res => setTimeout(res, 20)); });
        check("a ding asked for before that screen's first click or key still sounds: Foundry drops a sound made before its first gesture, so it goes to the browser's own player at the interface volume (2026-09-19)",
          browserPlays.length === 1 && browserPlays[0].src === "sounds/notify.wav" && browserPlays[0].volume > 0
            && plays7.length === before,
          `browser played ${browserPlays.length} (${browserPlays[0]?.src ?? "-"} at ${browserPlays[0]?.volume ?? "-"}); Foundry's player ${plays7.length - before}`);
      } finally {
        game.audio = keepAudio;
        if (keepPlayer === undefined) delete globalThis.Audio; else globalThis.Audio = keepPlayer;
      }
    }

    // The handler for concentration cards already in a chat log: it no longer
    // rolls dnd5e's (which ACE's gate cancels, so it read "cancelled" and came
    // straight back on) and it remembers a roll on the card itself.
    const qolSrc = readFileSync(`${ROOT}/Data/modules/ace-qol/scripts/ace-qol.mjs`, "utf8");
    const wire = qolSrc.slice(qolSrc.indexOf("const _wireConcButton"), qolSrc.indexOf("registerChatCardHandler(_wireConcButton"));
    check("older concentration cards already in a chat log roll through ACE's check, awaited, and remember a roll on the card (source read: that handler lives inside ACE's startup) (2026-09-19)",
      wire.length > 0 && !/actor\.rollConcentration\(/.test(wire) && /CheckGate\.run\(actor, "concentration"/.test(wire)
        && /_concSpent\(/.test(wire) && /setFlag\(MODULE_ID, "concRolled", true\)/.test(wire),
      wire.length ? "read from ace-qol.mjs" : "the handler was not found in ace-qol.mjs");
  } finally {
    PcSaveNudge.disarmAll();
    for (const k of [...RollPopout._open.keys()]) RollPopout._open.delete(k);
    CheckGate.run = keep7.run;
    ChatMessage.create = keep7.create;
    game.users = keep7.users;
    game.user = keep7.user;
    game.messages = keep7.messages;
    game.scenes.get = keep7.scenesGet;
    canvas.scene = keep7.scene;
    canvas.tokens.placeables.length = 0;
    canvas.tokens.placeables.push(...keep7.placed);
    foundry.audio = keep7.audio;
    globalThis.fetch = keep7.fetch;
    if (keep7.owner === undefined) delete CONST.DOCUMENT_OWNERSHIP_LEVELS; else CONST.DOCUMENT_OWNERSHIP_LEVELS = keep7.owner;
    if (keep7.html === undefined) delete globalThis.HTMLElement;
    if (keep7.dnd5e === undefined) delete globalThis.dnd5e; else globalThis.dnd5e = keep7.dnd5e;
    if (keep7.gmActive === undefined) delete GM.active; else GM.active = keep7.gmActive;
    globalThis.fromUuidSync = keep7.fromUuidSync;
    for (const a of made7) ACTORS.delete(a.id);
  }
}

/* ── RECHARGE ATTACKS: BREATH, WING, TAIL ────────────────────────────────── */
// The night run of 2026-09-20, his list: "Recharge attacks. Same save engine,
// same card door, same Dice So Nice wait, same APPLY, same dead/immune rules,
// same edge-to-edge template test already frozen."
//
// Pinned on his own dragon: Volcathar the Flameborn (CR 17) on AMBER TEMPLE:
// LOWER, whose sheet carries Fire Breath (recharge 5-6), Wing Attack and Tail
// as a legendary action, and Tail as an ordinary attack. The geometry of who
// is inside a cone is frozen and pinned elsewhere (the template and distance
// self-tests), so what is pinned here is the press, the card and what lands.
console.log(`\nRECHARGE ATTACKS: BREATH, WING, TAIL`);
{
  const MOD = "ace-qol";
  const SCENE8 = "replay-breath-scene";
  const PLAYER8 = { id: "tommy", name: "Tommy", isGM: false, active: true, character: null };
  const docs8 = new Map(), made8 = [], chat8 = new Map(), plays8 = [];
  const { RollPopout } = await import(`${MODULE}/scripts/roll-popout.mjs`);
  const setPath8 = (obj, key, v) => {
    const path = key.split(".");
    let o = obj;
    for (const k of path.slice(0, -1)) o = (o[k] ??= {});
    o[path[path.length - 1]] = v;
  };
  const keep8 = { users: game.users, user: game.user, messages: game.messages, scenesGet: game.scenes.get,
    scene: canvas.scene, placed: [...canvas.tokens.placeables], create: ChatMessage.create,
    audio: foundry.audio, fetch: globalThis.fetch, owner: CONST.DOCUMENT_OWNERSHIP_LEVELS,
    html: globalThis.HTMLElement, gmActive: GM.active, fromUuidSync: globalThis.fromUuidSync,
    areas: CONFIG.DND5E.areaTargetTypes, targets: GM.targets };
  // Two things every real client has and the stand-in did not: the shapes dnd5e
  // can place (the press asks whether it can place this item's cone before it
  // waits for one) and the user's target set.
  const AREAS = { cone: { template: "cone" }, line: { template: "ray" }, radius: { template: "circle" },
    sphere: { template: "circle" }, cylinder: { template: "circle" }, cube: { template: "rect" },
    square: { template: "rect" }, wall: { template: "ray" } };

  const creature8 = (id, name, { type = "npc", owner = null, di = [], dead = false } = {}) => {
    const a = { id, name, type, img: `${id}.webp`, documentName: "Actor", uuid: `Actor.${id}`,
      statuses: new Set(dead ? ["dead"] : []), effects: new Collection(), items: new Collection(),
      ownership: owner ? { [owner]: 3 } : {}, isOwner: true, hasPlayerOwner: !!owner,
      prototypeToken: { actorLink: true }, getFlag: () => undefined, getRollData: () => ({}),
      testUserPermission: (u) => !!u && !u.isGM && (a.ownership?.[u.id] ?? 0) >= 3,
      system: { attributes: { hp: { value: dead ? 0 : 40, max: 40, temp: 0 }, death: { success: 0, failure: 0 }, prof: 3 },
        abilities: { str: { mod: 0, save: { value: 0 } }, dex: { mod: 0, save: { value: 0 } },
          con: { mod: 0, save: { value: 0 } }, wis: { mod: 0, save: { value: 0 } } },
        skills: {}, details: { type: { value: "humanoid" }, alignment: "Neutral" },
        traits: { ci: { value: new Set() }, di: { value: new Set(di) }, dr: { value: new Set() }, dv: { value: new Set() } } },
      update: async (u) => { for (const [k, v] of Object.entries(u)) setPath8(a, k, v); return a; } };
    ACTORS.set(id, a);
    made8.push(a);
    return a;
  };
  const place8 = (actor, id, x) => {
    const doc = { id, actorId: actor.id, actor, parent: { id: SCENE8 }, flags: {}, name: actor.name,
      hidden: false, x, y: 0, width: 1, height: 1, elevation: 0, disposition: actor.hasPlayerOwner ? 1 : -1,
      texture: { src: `${actor.id}-token.webp` }, getFlag: () => undefined,
      update: async (u) => { for (const [k, v] of Object.entries(u)) setPath8(doc, k, v); return doc; } };
    const tok = { id, name: actor.name, actor, document: doc, x, y: 0, w: 100, h: 100,
      center: { x: x + 50, y: 50 }, scene: { id: SCENE8 }, visible: true, setTarget() {} };
    doc.object = tok;
    docs8.set(id, doc);
    canvas.tokens.placeables.push(tok);
    return tok;
  };
  globalThis.HTMLElement = keep8.html ?? class {};
  class Li8 extends globalThis.HTMLElement {
    constructor() { super(); this.cls = new Set(); this.style = {}; }
    get classList() { const c = this.cls; return { add: (x) => c.add(x), remove: (x) => c.delete(x), contains: (x) => c.has(x) }; }
    closest() { return this; }
    querySelectorAll() { return []; }
    querySelector() { return null; }
    setAttribute() {}
  }
  const drawOn8 = (user, message, handlers) => {
    game.user = user;
    const li = new Li8();
    const keepLog = console.log;
    console.log = () => {};
    try { for (const h of handlers) h(message, li); } finally { console.log = keepLog; }
    return li;
  };
  const folded8 = (li) => li.classList.contains("ace-qol-save-collapsed");
  const textOf = (m) => String(m?.content ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

  try {
    GM.active = true;
    GM.targets = new Set();
    CONFIG.DND5E.areaTargetTypes = AREAS;
    const users8 = Object.assign([GM, PLAYER8], { activeGM: GM });
    users8.get = (id) => users8.find(u => u.id === id);
    game.users = users8;
    game.user = GM;
    CONST.DOCUMENT_OWNERSHIP_LEVELS = { NONE: 0, LIMITED: 1, OBSERVER: 2, OWNER: 3 };
    foundry.audio = { AudioHelper: { play: (o) => { plays8.push({ user: game.user?.id, ...o }); return Promise.resolve({}); } } };
    globalThis.fetch = async () => ({ ok: true, status: 200 });
    globalThis.fromUuidSync = (u) => (String(u).startsWith("Actor.") ? ACTORS.get(String(u).slice(6)) ?? null : keep8.fromUuidSync(u));
    game.messages = { get: (id) => chat8.get(id) ?? null, get contents() { return [...chat8.values()]; } };
    ChatMessage.create = async (data, opts) => {
      const msg = await keep8.create(data, opts);
      const plain = msg.update;
      msg.update = async (u = {}) => {
        const rest = {};
        for (const [k, v] of Object.entries(u)) { if (k.includes(".")) setPath8(msg, k, v); else rest[k] = v; }
        return plain(rest);
      };
      msg.whisper = data?.whisper ?? [];
      msg.author = data?.author ?? null;
      chat8.set(msg.id, msg);
      return msg;
    };
    const scene8 = { id: SCENE8, templates: { get: () => null },
      tokens: { get: (t) => docs8.get(t) ?? null, get contents() { return [...docs8.values()]; } } };
    game.scenes.get = (id) => (id === SCENE8 ? scene8 : keep8.scenesGet(id));
    canvas.scene = scene8;
    canvas.tokens.placeables.length = 0;

    const dragon = firstActor("Volcathar the Flameborn CR17");
    const breath = dragon?.items?.find(i => i.name === "Fire Breath") ?? null;
    const wing = dragon?.items?.find(i => i.name === "Wing Attack") ?? null;
    const tail = dragon?.items?.find(i => i.name === "Tail") ?? null;
    const tailLeg = dragon?.items?.find(i => i.name === "Tail Attack") ?? null;

    let engine8 = null;
    const at = { render: (hooks.renderChatMessage ?? []).length, create: (hooks.createChatMessage ?? []).length };
    try { await quiet(async () => { engine8 = new SaveEngine({}); }); } catch (_) { engine8 = null; }
    const renderHooks8 = (hooks.renderChatMessage ?? []).slice(at.render);

    /* ── 1. THE BREATH WEAPON ───────────────────────────────────────────── */
    if (!engine8 || !breath) {
      check("his dragon's Fire Breath (2026-09-20)", null, "no Volcathar the Flameborn with a Fire Breath in this world");
    } else {
      const act = [...breath.system.activities][0];
      // The press: it takes the cone from the item and waits for it to be placed.
      let errP = null;
      try { await quiet(() => engine8._onUseActivity(act, { message: null })); } catch (e) { errP = e; }
      const pend = engine8._pendingSaveSpell;
      const onFail = (pend?.recipe?.onFail ?? []).map(o => `${o.formula ?? o.condition?.key ?? "?"} ${(o.types ?? []).join("/")}${o.onSuccess ? ` (${o.onSuccess})` : ""}`.trim());
      check("his dragon's Fire Breath goes to the save engine and waits for its own 60-foot cone: DEX DC 21 and 18d6 fire from the item, half on a save, and the recharge the sheet stores (2026-09-20)",
        !errP && !!pend && pend.item?.name === "Fire Breath" && pend.saveAbility === "dex" && Number(pend.saveDC) === 21
          && onFail.some(f => /^18d6 fire \(half\)/.test(f))
          && String(act.target?.template?.type) === "cone" && String(act.target?.template?.size) === "60"
          && (breath.system?.uses?.recovery ?? []).some(r => r.period === "recharge" && String(r.formula) === "5"),
        errP ? `threw: ${errP?.message ?? errP}`
          : pend ? `${String(pend.saveAbility).toUpperCase()} DC ${pend.saveDC}; on a fail ${onFail.join(", ")}; `
            + `${act.target?.template?.type} ${act.target?.template?.size} ft; recharge ${(breath.system?.uses?.recovery ?? []).map(r => r.formula).join("/")}`
            : "nothing was armed");
      engine8._pendingSaveSpell = null;

      // The card: the same one every area save posts.
      const knight = creature8("replay-br-knight", "a knight");
      const azer = creature8("replay-br-azer", "an azer", { di: ["fire"] });
      const corpse = creature8("replay-br-corpse", "a burnt cultist", { dead: true });
      const chudd = creature8("replay-br-chudd", "Chudd", { type: "character", owner: "tommy" });
      const toks = [place8(knight, "tok-br-knight", 100), place8(azer, "tok-br-azer", 200),
        place8(corpse, "tok-br-corpse", 300), place8(chudd, "tok-br-chudd", 400)];
      place8(dragon, "tok-br-dragon", 0);
      let errC = null;
      const before = chat8.size;
      try {
        await quiet(async () => {
          await engine8._postLiveTargetCard(breath, dragon, toks, {
            saveAbility: "dex", saveDC: 21, isSpell: false, activityId: act.id, skipDelay: true });
        });
      } catch (e) { errC = e; }
      const made = [...chat8.values()].slice(before);
      const of = (t) => made.filter(m => m?.flags?.[MOD]?.type === t);
      const results = of("saveResults").at(-1) ?? null;
      const prompt = of("pcSavePrompt").at(-1) ?? null;
      const rt = textOf(results);
      check("the breath posts the one save card ACE posts for any area: the knight's rolled save, the azer immune to fire as one line with no row, the dead cultist not on it at all, and Chudd waiting for his player (2026-09-20)",
        !errC && !!results && /a knight/.test(rt) && /Immune to fire, no save:\s*an azer/.test(rt)
          && !/burnt cultist/.test(rt) && /Chudd/.test(rt) && /WAITING FOR PLAYER/.test(rt),
        errC ? `threw: ${errC?.message ?? errC}` : rt.slice(0, 220));
      await new Promise(r => setTimeout(r, 1600));   // past the one-ding-for-a-burst window
      const dings = plays8.length;
      const onPlayer = prompt ? drawOn8(PLAYER8, prompt, renderHooks8) : null;
      const box = prompt ? RollPopout._open.get(prompt.id) : null;
      await quiet(async () => { box?._onRender?.({}, {}); await new Promise(r => setTimeout(r, 10)); });
      check("Chudd's player gets the box for it, with the dragon's own words: a ding, the breath's name and \"Roll Dexterity save\", its chat card folded away (2026-09-20)",
        !!box && box.spec.pillLabel === "Roll Dexterity save" && box.spec.sourceName === "Volcathar the Flameborn CR17"
          && box.spec.title === "Fire Breath" && folded8(onPlayer)
          && plays8.slice(dings).some(p => p.user === "tommy"),
        box ? `"${box.spec.line}" / "${box.spec.pillLabel}"; dings ${plays8.slice(dings).filter(p => p.user === "tommy").length}` : "no box");
      check("and nothing of its damage happens by itself: the card holds at WAITING FOR SAVES while Chudd has not rolled, it is not a card that resolves itself, and no hit points have moved (2026-09-20)",
        !!results && results.flags[MOD].autoResolve !== true && results.flags[MOD].applied !== true
          && /WAITING FOR SAVES/.test(String(results.content ?? ""))
          && knight.system.attributes.hp.value === 40 && chudd.system.attributes.hp.value === 40,
        results ? `resolves itself: ${results.flags[MOD].autoResolve === true}; applied: ${results.flags[MOD].applied === true}; `
          + `the knight ${knight.system.attributes.hp.value}/40, Chudd ${chudd.system.attributes.hp.value}/40` : "no card");
      if (box) await box.close({ acpResolved: true });
    }

    /* ── 2. THE WING ATTACK ─────────────────────────────────────────────── */
    // Same engine, same card, same box. What is its own: the area is an
    // emanation that needs no crosshair, the DC is worked out from the
    // dragon's Strength rather than written down, and prone lands because its
    // words say "knocked prone" and for no other reason.
    if (!engine8 || !wing) {
      check("his dragon's Wing Attack (2026-09-20)", null, "no Volcathar the Flameborn with a Wing Attack in this world");
    } else {
      const actW = [...wing.system.activities][0];
      let errW = null;
      // ⚠️ THE PRESS IS THE GM'S. Drawing the breath's card on Tommy's screen
      // above left `game.user` as Tommy, and the press's first line is "only
      // the active GM acts" — so the wing armed nothing and said nothing,
      // which is this harness lying about ACE, not ACE failing.
      game.user = GM;
      try { await quiet(() => engine8._onUseActivity(actW, { message: null })); } catch (e) { errW = e; }
      const pendW = engine8._pendingSaveSpell;
      const failW = (pendW?.recipe?.onFail ?? []).map(o => `${o.formula ?? o.condition?.key ?? "?"} ${(o.types ?? []).join("/")}${o.onSuccess ? ` (${o.onSuccess})` : ""}`.trim());
      // 8 + the dragon's proficiency + its Strength, which is what its own
      // words print as DC 22. A DC nobody can read is 10 and a loud warning,
      // so the number itself is the pin.
      check("his dragon's Wing Attack goes to the same save engine with the DC its own Strength gives it: DEX DC 22, 2d6 + its Strength bludgeoning, half on a save (2026-09-20)",
        !errW && !!pendW && pendW.item?.name === "Wing Attack" && pendW.saveAbility === "dex"
          && Number(pendW.saveDC) === 22
          && failW.some(f => /^2d6 \+ @mod bludgeoning \(half\)/.test(f)),
        errW ? `threw: ${errW?.message ?? errW}`
          : pendW ? `${String(pendW.saveAbility).toUpperCase()} DC ${pendW.saveDC}; on a fail ${failW.join(", ")}` : "nothing was armed");
      check("it beats its wings where it stands: a 10-foot emanation from the dragon, everybody in it, and no crosshair to place (2026-09-20)",
        !!pendW && String(actW.range?.units) === "self" && Number(wing.system?.range?.value) === 10
          && (recipesFor(wing, { actor: dragon })[0]?.recipe?.where?.kind) === "emanation"
          && Number(recipesFor(wing, { actor: dragon })[0]?.recipe?.where?.size) === 10,
        pendW ? `${recipesFor(wing, { actor: dragon })[0]?.recipe?.where?.kind} `
          + `${recipesFor(wing, { actor: dragon })[0]?.recipe?.where?.size} ft, range units ${actW.range?.units}` : "nothing was armed");
      check("prone is on it because its words say \"knocked prone\", and the same dragon's Tail, whose words do not, carries no rider at all (2026-09-20)",
        failW.some(f => f === "prone")
          && /knocked prone/i.test(String(wing.system?.description?.value ?? ""))
          && !(recipesFor(tail, { actor: dragon })[0]?.recipe?.onHit ?? []).some(o => o.condition)
          && !/prone/i.test(String(tail?.system?.description?.value ?? "")),
        `the wing: ${failW.join(", ")}; the tail: `
          + `${(recipesFor(tail, { actor: dragon })[0]?.recipe?.onHit ?? []).map(o => o.formula ?? o.condition?.key).join(", ") || "nothing"}`);
      engine8._pendingSaveSpell = null;

      const squire = creature8("replay-wg-squire", "a squire");
      const boneW = creature8("replay-wg-bones", "a trampled skeleton", { dead: true });
      const chuddW = creature8("replay-wg-chudd", "Chudd", { type: "character", owner: "tommy" });
      const toksW = [place8(squire, "tok-wg-squire", 100), place8(boneW, "tok-wg-bones", 200),
        place8(chuddW, "tok-wg-chudd", 300)];
      let errCW = null;
      const beforeW = chat8.size;
      try {
        await quiet(async () => {
          await engine8._postLiveTargetCard(wing, dragon, toksW, {
            saveAbility: "dex", saveDC: 22, isSpell: false, activityId: actW.id, skipDelay: true });
        });
      } catch (e) { errCW = e; }
      const madeW = [...chat8.values()].slice(beforeW);
      const resultsW = madeW.filter(m => m?.flags?.[MOD]?.type === "saveResults").at(-1) ?? null;
      const promptW = madeW.filter(m => m?.flags?.[MOD]?.type === "pcSavePrompt").at(-1) ?? null;
      const rtW = textOf(resultsW);
      await new Promise(r => setTimeout(r, 1600));   // past the one-ding-for-a-burst window
      const dingsW = plays8.length;
      const onPlayerW = promptW ? drawOn8(PLAYER8, promptW, renderHooks8) : null;
      const boxW = promptW ? RollPopout._open.get(promptW.id) : null;
      await quiet(async () => { boxW?._onRender?.({}, {}); await new Promise(r => setTimeout(r, 10)); });
      check("the wing posts the one save card too, with the trampled skeleton off it, Chudd's player holding a box that dings, and not a hit point moved until APPLY (2026-09-20)",
        !errCW && !!resultsW && /a squire/.test(rtW) && !/trampled skeleton/.test(rtW) && /Chudd/.test(rtW)
          && /WAITING FOR (?:PLAYER|SAVES)/.test(rtW) && !!boxW && boxW.spec.pillLabel === "Roll Dexterity save"
          && boxW.spec.title === "Wing Attack" && folded8(onPlayerW)
          && plays8.slice(dingsW).some(p => p.user === "tommy")
          && resultsW.flags[MOD].applied !== true
          && squire.system.attributes.hp.value === 40 && chuddW.system.attributes.hp.value === 40,
        errCW ? `threw: ${errCW?.message ?? errCW}`
          : `${rtW.slice(0, 160)} | box ${boxW ? `"${boxW.spec.pillLabel}"` : "none"}; `
            + `the squire ${squire.system.attributes.hp.value}/40, Chudd ${chuddW.system.attributes.hp.value}/40`);
      if (boxW) await boxW.close({ acpResolved: true });
    }

    /* ── 3. THE TAIL ────────────────────────────────────────────────────── */
    // His words: "Attack or save, whichever that creature's sheet actually is.
    // Do not guess a third shape." Volcathar's Tail is an attack, so it stays
    // an attack: no save is armed and no save card is posted.
    //
    // ⚠️🔴 AND IT REACHES FIFTEEN FEET, WHICH ACE HAD READ AS FIVE. dnd5e never
    // moves a natural weapon's range into its reach slot (its migration asks
    // `weaponTypeMap` first, and that map has no "natural"), then fills the
    // empty reach slot with a default 5. The one reach reader has honoured the
    // larger declared number since the Spiked Chain; the recipe's own reader
    // took the default, so the frozen recipe the road runs on said the
    // dragon's tail reached five feet while every other place said fifteen.
    // 22 natural melee weapons in his world carry a reach that way.
    if (!tail) {
      check("his dragon's Tail (2026-09-20)", null, "no Volcathar the Flameborn with a Tail in this world");
    } else {
      const { resolveReach } = await import(`${MODULE}/scripts/reach-reader.mjs`);
      const recT = recipesFor(tail, { actor: dragon })[0]?.recipe ?? null;
      const actT = [...tail.system.activities][0];
      let errT = null, pendT = null;
      if (engine8) {
        game.user = GM;
        try { await quiet(() => engine8._onUseActivity(actT, { message: null })); } catch (e) { errT = e; }
        pendT = engine8._pendingSaveSpell;
        engine8._pendingSaveSpell = null;
      }
      check("his dragon's Tail stays the attack its sheet says it is: a melee attack roll for 2d8 bludgeoning, no save armed, no third shape invented (2026-09-20)",
        !!recT && recT.decidedBy?.kind === "attack" && recT.decidedBy?.melee === true
          && (recT.onHit ?? []).some(o => /2d8/.test(String(o.formula)) && (o.types ?? []).includes("bludgeoning"))
          && !pendT && !errT,
        recT ? `${recT.decidedBy?.kind}${recT.decidedBy?.melee ? " melee" : ""}; on a hit `
          + `${(recT.onHit ?? []).map(o => `${o.formula} ${(o.types ?? []).join("/")}`).join(", ")}; `
          + `${pendT ? "a save was armed (wrong)" : "no save armed"}` : "no recipe");
      check("and it reaches the 15 feet its own sheet declares, in the recipe as well as at the gate: dnd5e's 5-foot default for an empty reach slot is not an answer the item gave (2026-09-20)",
        Number(recT?.where?.rangeFt) === 15 && recT?.where?.melee === true
          && resolveReach(tail, actT, { repair: false }).reachFt === 15
          && Number(tail.system?.range?.reach) === 5,
        `the recipe says ${recT?.where?.rangeFt} ft, the reach reader says `
          + `${resolveReach(tail, actT, { repair: false }).reachFt} ft, dnd5e's own slot holds `
          + `${tail.system?.range?.reach} with ${tail.system?.range?.value} declared beside it`);
    }

    /* ── 4. THE RECHARGE BUTTON ─────────────────────────────────────────── */
    // His words: "After a use, the button is spent. At the start of that
    // creature's turn the recharge die rolls. On a hit the button comes back.
    // Show the die. Do not recharge mid-round."
    //
    // The die is dnd5e's: with the world's auto-recharge on (his is "yes") it
    // rolls at the start of that creature's turn and puts the use back itself.
    // ACE never rolls one, which is what keeps it out of the middle of a round;
    // it takes dnd5e's own card off and posts one that shows the die and the
    // number it had to beat.
    if (!breath) {
      check("his dragon's recharge (2026-09-20)", null, "no Fire Breath in this world");
    } else {
      const { CheckGate } = await import(`${MODULE}/scripts/check-gate.mjs`);
      const { ActionBar } = await import(`${MODULE}/scripts/action-bar.mjs`);
      const asUses = (spent) => ({ system: { uses: { max: 1, value: spent ? 0 : 1, spent: spent ? 1 : 0,
        recovery: breath.system?.uses?.recovery ?? [] } }, name: breath.name });
      const ready = ActionBar._usesOf(asUses(false));
      const gone = ActionBar._usesOf(asUses(true));
      check("his dragon's breath is a one-use button that recharges on a 5: ready it counts 1/1, spent it stops counting and shows the number that brings it back (2026-09-20)",
        !!ready && !!gone && ready.spent === false && ready.left === 1 && ready.max === 1
          && gone.spent === true && gone.needs === 5 && ready.needs === 5
          && ActionBar._rechargeWords(5) === "recharges on a 5 or better at the start of its turn"
          && ActionBar._rechargeWords(6) === "recharges on a 6 at the start of its turn"
          && ActionBar._usesOf(tail) === null,
        `ready ${ready?.left}/${ready?.max}, spent ${gone?.spent} needing ${gone?.needs}+; `
          + `the Tail, which has no uses at all: ${ActionBar._usesOf(tail) === null ? "no badge" : "a badge (wrong)"}`);

      // The card for that die, driven exactly as dnd5e's hook hands it over.
      const cards = [];
      const keepPost = CardDoor.post;
      // Every real client has these; the card asks for PUBLIC by name.
      const keepModes = CONST.DICE_ROLL_MODES;
      CONST.DICE_ROLL_MODES = keepModes ?? { PUBLIC: "publicroll", PRIVATE: "gmroll", BLIND: "blindroll", SELF: "selfroll" };
      const keepShow = globalThis.game?.dice3d;
      CardDoor.post = async (data) => { cards.push(data); return { id: `rech-${cards.length}` }; };
      let thrown = 0, landed = 0;
      globalThis.game.dice3d = { isEnabled: () => true,
        showForRoll: () => { thrown++; return new Promise(r => setTimeout(() => { landed++; r(true); }, 15)); } };
      const rollOf = (total, made) => ({ total, isSuccess: made, options: { target: 5 },
        terms: [{ faces: 6, results: [{ result: total }] }], dice: [{ faces: 6, results: [{ result: total }] }] });
      try {
        game.user = GM;
        await quiet(async () => {
          await CheckGate._postRechargeCard([rollOf(2, false)], { subject: { name: "Fire Breath", actor: dragon } });
          await CheckGate._postRechargeCard([rollOf(5, true)], { subject: { name: "Fire Breath", actor: dragon } });
        });
      } finally {
        CardDoor.post = keepPost;
        if (keepModes === undefined) delete CONST.DICE_ROLL_MODES; else CONST.DICE_ROLL_MODES = keepModes;
        if (keepShow === undefined) delete globalThis.game.dice3d; else globalThis.game.dice3d = keepShow;
      }
      const said = cards.map(c => String(c?.content ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
      check("the recharge die gets a card of its own, spoken by the dragon, showing the d6, what it needed and whether it came back, after the dice have landed (2026-09-20)",
        cards.length === 2 && /Volcathar/.test(said[0]) && /NOT YET/.test(said[0]) && /needs 5 or better/.test(said[0])
          && / 2 /.test(` ${said[0]} `) && /RECHARGED/.test(said[1]) && !/NOT YET/.test(said[1])
          && thrown === 2 && landed === 2,
        `${cards.length} cards; dice thrown ${thrown}, landed ${landed}; "${said[0]?.slice(0, 120)}"`);

      // And ACE never starts one. The recharge belongs to the start of a turn.
      const scripts = `${ROOT}/Data/modules/ace-qol/scripts`;
      const gateSrc = readFileSync(`${scripts}/check-gate.mjs`, "utf8");
      const aceSrc = readdirSync(scripts).filter(f => f.endsWith(".mjs"))
        .map(f => readFileSync(`${scripts}/${f}`, "utf8")).join("\n");
      check("and ACE never rolls a recharge itself: it listens for dnd5e's, which only happens at the start of that creature's turn, so nothing recharges in the middle of a round (2026-09-20)",
        /preRollRechargeV2/.test(gateSrc) && /rollRechargeV2/.test(gateSrc)
          && !/\.rollRecharge\s*\(/.test(aceSrc) && !/rollRecharge\s*\(\s*\{/.test(aceSrc),
        `${(aceSrc.match(/rollRecharge/g) ?? []).length} mentions of dnd5e's roller across ACE, all of them hooks`);
    }

    /* ── 5. THE LEGENDARY COPIES ────────────────────────────────────────── */
    // His words: "If the same creature has Breath, Wing, or Tail as a legendary
    // action, that press uses this same engine and spends the legendary action.
    // It does not invent a second path."
    //
    // On Volcathar both are legendary already: the Wing Attack costs two of his
    // three, the Tail Attack one. The wing pinned above IS the legendary press,
    // so what is left to pin is that being legendary changes nothing about how
    // it is decided, and that the spending belongs to dnd5e.
    if (!wing || !tailLeg || !tail) {
      check("his dragon's legendary Wing and Tail (2026-09-20)", null, "no Wing Attack and Tail Attack in this world");
    } else {
      const recW = recipesFor(wing, { actor: dragon })[0]?.recipe ?? null;
      const recTL = recipesFor(tailLeg, { actor: dragon })[0]?.recipe ?? null;
      const recT = recipesFor(tail, { actor: dragon })[0]?.recipe ?? null;
      const recB = breath ? (recipesFor(breath, { actor: dragon })[0]?.recipe ?? null) : null;
      const costOf = (it) => [...it.system.activities][0]?.activation ?? {};
      check("the legendary Wing Attack costs two of his three legendary actions and the legendary Tail Attack one, read off the item, and ACE asks for no other resource (2026-09-20)",
        String(costOf(wing).type) === "legendary" && Number(costOf(wing).value) === 2
          && String(costOf(tailLeg).type) === "legendary" && Number(costOf(tailLeg).value) === 1
          && recW?.resources?.activation === "legendary" && recTL?.resources?.activation === "legendary"
          && !recW?.resources?.slot && !recTL?.resources?.slot
          && Number(dragon.system?.resources?.legact?.max) === 3,
        `the wing ${costOf(wing).value}, the tail ${costOf(tailLeg).value}, of ${dragon.system?.resources?.legact?.max}; `
          + `the recipes say ${recW?.resources?.activation} / ${recTL?.resources?.activation}`);
      check("and being legendary changes nothing about how it runs: the legendary Tail decides exactly as the ordinary Tail does (a melee attack, 2d8, 15 feet) and the legendary Wing decides exactly as the breath does (a save, its damage, half on a success) (2026-09-20)",
        recTL?.decidedBy?.kind === recT?.decidedBy?.kind && recTL?.decidedBy?.melee === recT?.decidedBy?.melee
          && Number(recTL?.where?.rangeFt) === Number(recT?.where?.rangeFt)
          && (recTL?.onHit ?? []).map(o => `${o.formula} ${(o.types ?? []).join("/")}`).join()
             === (recT?.onHit ?? []).map(o => `${o.formula} ${(o.types ?? []).join("/")}`).join()
          && recW?.decidedBy?.kind === "save" && recB?.decidedBy?.kind === "save"
          && (recW?.onFail ?? []).some(o => o.kind === "damage" && o.onSuccess === "half")
          && (recB?.onFail ?? []).some(o => o.kind === "damage" && o.onSuccess === "half"),
        `the tails: ${recT?.decidedBy?.kind} ${recT?.where?.rangeFt}ft vs ${recTL?.decidedBy?.kind} ${recTL?.where?.rangeFt}ft; `
          + `the wing: ${recW?.decidedBy?.kind} ${recW?.decidedBy?.ability ?? ""}; the breath: ${recB?.decidedBy?.kind}`);
      // ⚠️ THE SPEND IS dnd5e'S. ACE touching the count would be the second path.
      const scripts5 = `${ROOT}/Data/modules/ace-qol/scripts`;
      const every5 = readdirSync(scripts5, { recursive: true })
        .map(f => String(f).split("\\").join("/")).filter(f => f.endsWith(".mjs"));
      const writers = every5.filter(f => /legact/.test(readFileSync(`${scripts5}/${f}`, "utf8")));
      check("the legendary action is spent by dnd5e on the press and ACE never writes that count anywhere except to give one back when a cast is thrown away (2026-09-20)",
        writers.length === 1 && writers[0] === "road/give-back.mjs",
        `files that mention it: ${writers.join(", ") || "none"}`);
    }
  } finally {
    for (const k of [...RollPopout._open.keys()]) RollPopout._open.delete(k);
    ChatMessage.create = keep8.create;
    game.users = keep8.users;
    game.user = keep8.user;
    game.messages = keep8.messages;
    game.scenes.get = keep8.scenesGet;
    canvas.scene = keep8.scene;
    canvas.tokens.placeables.length = 0;
    canvas.tokens.placeables.push(...keep8.placed);
    foundry.audio = keep8.audio;
    globalThis.fetch = keep8.fetch;
    globalThis.fromUuidSync = keep8.fromUuidSync;
    if (keep8.owner === undefined) delete CONST.DOCUMENT_OWNERSHIP_LEVELS; else CONST.DOCUMENT_OWNERSHIP_LEVELS = keep8.owner;
    if (keep8.html === undefined) delete globalThis.HTMLElement;
    if (keep8.gmActive === undefined) delete GM.active; else GM.active = keep8.gmActive;
    if (keep8.targets === undefined) delete GM.targets; else GM.targets = keep8.targets;
    CONFIG.DND5E.areaTargetTypes = keep8.areas;
    for (const a of made8) ACTORS.delete(a.id);
  }
}

/* ── A FRIGHTENING PRESENCE: ONE SAVE, ONE CREATURE, ONCE ────────────────── */
// His list of 2026-09-20: "Against that dragon a creature rolls once. Already
// frightened by it: no roll. Already immune to it: no roll. Outside 120 feet:
// no roll. No line of sight (wall, closed door): no roll. A second press does
// not roll the room again." Pinned on Volcathar the Flameborn's own Frightful
// Presence (WIS DC 16, 120 feet, aware of it, frightened for a minute, immune
// for 24 hours) on AMBER TEMPLE: LOWER.
console.log(`\nA FRIGHTENING PRESENCE: ONE SAVE, ONE CREATURE, ONCE`);
{
  const MOD = "ace-qol";
  const SCENE9 = "replay-presence-scene";
  const PLAYER9 = { id: "tommy", name: "Tommy", isGM: false, active: true, character: null };
  const docs9 = new Map(), made9 = [], chat9 = new Map();
  const { PresenceEngine } = await import(`${MODULE}/scripts/presence-engine.mjs`);
  const { readFrightfulPresence } = await import(`${MODULE}/scripts/rules/creature-words.mjs`);
  const { Situation: Sit9 } = await import(`${MODULE}/scripts/situation.mjs`);
  const setPath9 = (obj, key, v) => {
    const path = key.split(".");
    let o = obj;
    for (const k of path.slice(0, -1)) o = (o[k] ??= {});
    o[path[path.length - 1]] = v;
  };
  const keep9 = { users: game.users, user: game.user, messages: game.messages, scenesGet: game.scenes.get,
    scene: canvas.scene, placed: [...canvas.tokens.placeables], create: ChatMessage.create,
    canSee: Sit9.canSee, gmActive: GM.active, owner: CONST.DOCUMENT_OWNERSHIP_LEVELS,
    backends: CONFIG.Canvas?.polygonBackends,
    time: game.time, combat: game.combat, fromUuidSync: globalThis.fromUuidSync };

  const creature9 = (id, name, { type = "npc", owner = null, dead = false, effects = [] } = {}) => {
    const a = { id, name, type, img: `${id}.webp`, documentName: "Actor", uuid: `Actor.${id}`,
      statuses: new Set(dead ? ["dead"] : []), items: new Collection(),
      // ⚠️ AN ARRAY THAT ALSO ANSWERS `.contents`. ACE asks both ways (the
      // presence reads `.contents`, the save engine calls `.some`), and a real
      // Collection's `contents` is a getter that cannot be assigned.
      effects: (() => { const e = [...effects];
        Object.defineProperty(e, "contents", { get: () => e, configurable: true }); return e; })(),
      ownership: owner ? { [owner]: 3 } : {}, isOwner: true, hasPlayerOwner: !!owner,
      prototypeToken: { actorLink: true }, getFlag: () => undefined, getRollData: () => ({}),
      testUserPermission: (u) => !!u && !u.isGM && (a.ownership?.[u.id] ?? 0) >= 3,
      system: { attributes: { hp: { value: dead ? 0 : 40, max: 40, temp: 0 }, death: { success: 0, failure: 0 }, prof: 3 },
        abilities: { str: { mod: 0, save: { value: 0 } }, dex: { mod: 0, save: { value: 0 } },
          con: { mod: 0, save: { value: 0 } }, wis: { mod: 0, save: { value: 0 } } },
        skills: {}, details: { type: { value: "humanoid" }, alignment: "Neutral" },
        traits: { ci: { value: new Set() }, di: { value: new Set() }, dr: { value: new Set() }, dv: { value: new Set() } } },
      createEmbeddedDocuments: async (_t, rows) => {
        const made = rows.map(r => ({ ...r, id: `eff-${Math.random().toString(36).slice(2, 8)}`,
          parent: a, delete: async () => { const i = a.effects.indexOf(made[0]); if (i >= 0) a.effects.splice(i, 1); } }));
        a.effects.push(...made);
        return made;
      },
      update: async (u) => { for (const [k, v] of Object.entries(u)) setPath9(a, k, v); return a; } };
    ACTORS.set(id, a);
    made9.push(a);
    return a;
  };
  const place9 = (actor, id, x) => {
    // ⚠️ THE PARENT IS THE SCENE ITSELF, not a stub with its id: the presence
    // engine reads every token off `tokenDoc.parent`, which is how Foundry
    // hands a token its scene.
    const doc = { id, actorId: actor.id, actor, parent: canvas.scene, flags: {}, name: actor.name,
      hidden: false, x, y: 0, width: 1, height: 1, elevation: 0, disposition: actor.hasPlayerOwner ? 1 : -1,
      texture: { src: `${actor.id}-token.webp` }, getFlag: () => undefined,
      update: async (u) => { for (const [k, v] of Object.entries(u)) setPath9(doc, k, v); return doc; } };
    const tok = { id, name: actor.name, actor, document: doc, x, y: 0, w: 100, h: 100,
      center: { x: x + 50, y: 50 }, scene: { id: SCENE9 }, visible: true, setTarget() {} };
    doc.object = tok;
    docs9.set(id, doc);
    canvas.tokens.placeables.push(tok);
    return tok;
  };
  const markFright = (sourceTokenId, itemName) => ({ disabled: false, name: "Frightened",
    flags: { [MOD]: { presence: { sourceTokenId, itemName, immuneHours: 24 } } } });
  const markImmune = (sourceActorId, itemName, until) => ({ disabled: false, name: "Immune",
    delete: async () => {}, flags: { [MOD]: { presenceImmunity: { sourceActorId, itemName, until } } } });

  try {
    GM.active = true;
    const users9 = Object.assign([GM, PLAYER9], { activeGM: GM });
    users9.get = (id) => users9.find(u => u.id === id);
    game.users = users9;
    game.user = GM;
    game.time = { worldTime: 1000 };
    CONST.DOCUMENT_OWNERSHIP_LEVELS = { NONE: 0, LIMITED: 1, OBSERVER: 2, OWNER: 3 };
    game.messages = { get: (id) => chat9.get(id) ?? null, get contents() { return [...chat9.values()]; } };
    ChatMessage.create = async (data, opts) => {
      const msg = await keep9.create(data, opts);
      const plain = msg.update;
      msg.update = async (u = {}) => {
        const rest = {};
        for (const [k, v] of Object.entries(u)) { if (k.includes(".")) setPath9(msg, k, v); else rest[k] = v; }
        return plain(rest);
      };
      msg.whisper = data?.whisper ?? [];
      msg.author = data?.author ?? null;
      chat9.set(msg.id, msg);
      return msg;
    };
    const scene9 = { id: SCENE9, grid: { size: 100, distance: 5 }, templates: { get: () => null },
      tokens: { get: (t) => docs9.get(t) ?? null, get contents() { return [...docs9.values()]; } } };
    game.scenes.get = (id) => (id === SCENE9 ? scene9 : keep9.scenesGet(id));
    canvas.scene = scene9;
    canvas.tokens.placeables.length = 0;

    const dragon = firstActor("Volcathar the Flameborn CR17");
    const fp = dragon?.items?.find(i => i.name === "Frightful Presence") ?? null;
    const presence = fp ? readFrightfulPresence(fp) : null;

    if (!fp || !presence) {
      check("Volcathar's Frightful Presence (2026-09-20)", null, "no Frightful Presence on his dragon in this world");
    } else {
      check("his dragon's Frightful Presence is read from its own words and fires without a press: everyone within 120 feet who is aware of it, frightened for a minute, a save at the end of each of its turns, and 24 hours' peace afterwards (2026-09-20)",
        presence.byPresence === true && presence.radiusFt === 120 && presence.needsSight === true
          && presence.choice === true && presence.durationSeconds === 60 && presence.repeats === true
          && presence.immuneHours === 24,
        `${presence.radiusFt} ft, sight ${presence.needsSight}, its pick ${presence.choice}, `
          + `${presence.durationSeconds}s, repeats ${presence.repeats}, immune ${presence.immuneHours}h, `
          + `fires by itself ${presence.byPresence}`);

      // WHAT LANDS: frightened, and nothing the item happens to carry beside it.
      const built = await quiet(() => PresenceEngine._recipeFor(fp, dragon, presence));
      const fails = (built?.recipe?.onFail ?? []).map(o => o.condition?.key ?? o.formula ?? o.kind);
      check("a failed save against it leaves FRIGHTENED and nothing else: one result, the condition its words name, with the repeat save on it (2026-09-20)",
        !!built && built.ability === "wis" && Number(built.dc) === 16
          && fails.length === 1 && fails[0] === "frightened"
          && (built.recipe.onSuccess ?? []).length === 0
          && built.recipe.onFail[0].condition.duration === 60,
        built ? `${String(built.ability).toUpperCase()} DC ${built.dc}; on a fail ${fails.join(", ")}; `
          + `on a success ${(built.recipe.onSuccess ?? []).length} things` : "no recipe");

      // WHO IS ASKED: his four answers, plus the dead, on one scene.
      const knight = creature9("replay-fp-knight", "a knight");
      const farKnight = creature9("replay-fp-far", "a knight down the hall");
      const corpse = creature9("replay-fp-corpse", "a burnt cultist", { dead: true });
      const chudd = creature9("replay-fp-chudd", "Chudd", { type: "character", owner: "tommy" });
      const dragonTok = place9(dragon, "tok-fp-dragon", 0);
      const alreadyAfraid = creature9("replay-fp-afraid", "a shaking veteran",
        { effects: [markFright("tok-fp-dragon", "Frightful Presence")] });
      const alreadyImmune = creature9("replay-fp-immune", "a steady monk",
        { effects: [markImmune(dragon.id, "Frightful Presence", 90000)] });
      const behindDoor = creature9("replay-fp-door", "a guard behind a closed door");
      const notHere = creature9("replay-fp-hidden", "a kobold waiting for act three");
      const twinOfDragon = dragon;   // his own second body, if he had one on the map
      place9(knight, "tok-fp-knight", 200);
      place9(farKnight, "tok-fp-far", 3000);       // 150 feet down the hall
      place9(corpse, "tok-fp-corpse", 300);
      place9(chudd, "tok-fp-chudd", 400);
      place9(alreadyAfraid, "tok-fp-afraid", 500);
      place9(alreadyImmune, "tok-fp-immune", 600);
      place9(behindDoor, "tok-fp-door", 700);
      const hiddenTok = place9(notHere, "tok-fp-hidden", 800);
      hiddenTok.document.hidden = true;
      // A second token of the dragon itself, which is how a press measuring
      // from one body was asking the other to save (his table, 2026-09-20).
      const secondBody = place9(twinOfDragon, "tok-fp-dragon-2", 900);
      secondBody.document.actorId = dragon.id;
      // ⚠️ THE REAL SIGHT READER, WITH A REAL WALL. Standing `canSee` down
      // would pin the harness instead of ACE: the fault his table found was
      // that the one sight reader had never tested a wall at all, so the test
      // has to go through it. Foundry's own sight backend is what it asks.
      const keepBackend = CONFIG.Canvas?.polygonBackends;
      CONFIG.Canvas = { ...(CONFIG.Canvas ?? {}), polygonBackends: { sight: {
        testCollision: (from, to) => {
          const doorTok = docs9.get("tok-fp-door")?.object;
          const at = (p) => doorTok && Math.abs(p.x - doorTok.center.x) < 1 && Math.abs(p.y - doorTok.center.y) < 1;
          return at(from) || at(to);      // a closed door between the guard and everything
        } } } };

      const rows = PresenceEngine._read(dragonTok.document, fp, presence);
      const by = (a) => rows.find(r => r.doc.actor === a) ?? null;
      const asked = rows.filter(r => !r.skip).map(r => r.name);
      const dragonRows = rows.filter(r => r.doc.actor === dragon);
      check("it asks the knight and Chudd and nobody else, and says why each of the others is out: out of its 120 feet, a closed door in the way, hidden and not in play yet, already frightened by it, already immune to it, dead, and the dragon itself — both of its bodies (2026-09-20)",
        asked.length === 2 && asked.includes("a knight") && asked.includes("Chudd")
          && /out of range/.test(by(farKnight)?.skip?.reason ?? "")
          && /cannot see it/.test(by(behindDoor)?.skip?.reason ?? "")
          && /hidden/.test(by(notHere)?.skip?.reason ?? "")
          && by(alreadyAfraid)?.skip?.reason === "already frightened by it"
          && by(alreadyImmune)?.skip?.reason === "immune to it already"
          && by(corpse)?.skip?.reason === "dead" && by(corpse)?.skip?.hide === true
          && dragonRows.length === 2 && dragonRows.every(r => r.skip?.reason === "itself"),
        `asked: ${asked.join(", ") || "nobody"}; `
          + rows.filter(r => r.skip).map(r => `${r.name}: ${r.skip.reason}`).join("; "));

      // A SECOND PRESS ROLLS NOBODY: the two states above are what make it true.
      const afterKnight = markFright("tok-fp-dragon", "Frightful Presence");
      const setEffects = (a, rows) => { a.effects.length = 0; a.effects.push(...rows); };
      setEffects(knight, [afterKnight]);
      setEffects(chudd, [markImmune(dragon.id, "Frightful Presence", 90000)]);
      const again = PresenceEngine._read(dragonTok.document, fp, presence).filter(r => !r.skip);
      check("and a second press rolls nobody: the knight it frightened and Chudd who made the save are both done with it, so the room is not asked again (2026-09-20)",
        again.length === 0,
        again.length ? `still asked: ${again.map(r => r.name).join(", ")}` : "nobody is asked a second time");

      // An immunity whose day has passed is not an answer.
      game.time.worldTime = 200000;
      const stale = PresenceEngine._read(dragonTok.document, fp, presence).filter(r => r.doc.actor === chudd);
      check("but a day later that immunity is spent: with the world clock past its 24 hours, Chudd is asked again (2026-09-20)",
        stale.length === 1 && !stale[0].skip,
        stale.length ? `Chudd: ${stale[0].skip?.reason ?? "asked again"}` : "Chudd is not on the scene");
      game.time.worldTime = 1000;

      // WHAT LANDS, AND WHO WAITS: his rule for the card itself.
      setEffects(knight, []);
      setEffects(chudd, []);
      let engine9 = null;
      try { await quiet(async () => { engine9 = new SaveEngine({}); }); } catch (_) { engine9 = null; }
      if (!engine9) {
        check("the presence card (2026-09-20)", null, "the save engine could not be built in this harness");
      } else {
        // ⚠️ THE ROWS ARRIVE RESOLVED, which is what the card hands the applier
        // once the dice are in: an NPC that failed and a player's creature that
        // failed. A player rolls on their own screen, so the harness cannot
        // press for them; what is pinned here is what happens to the two rows.
        const row9 = (name, tokenDocId, actorId, isPC) => ({ name, tokenDocId, actorId, sceneId: SCENE9,
          img: `${actorId}.webp`, saveTotal: 7, passed: false, isAutoFail: false, resultLabel: "FAIL",
          damageMultiplier: 1, isPC, pending: false });
        const rows9 = [row9("a knight", "tok-fp-knight", knight.id, false),
                       row9("Chudd", "tok-fp-chudd", chudd.id, true)];
        const presFlag = { sourceTokenId: "tok-fp-dragon", sourceActorId: dragon.id,
          sourceName: dragon.name, itemName: fp.name, itemUuid: fp.uuid ?? null,
          immuneHours: 24, holdPCs: true, spared: [] };
        let errC9 = null, applied9 = [];
        try {
          await quiet(async () => {
            applied9 = await engine9._applyFailedSaveConditions(fp, rows9,
              { saveAbility: "wis", saveDC: 16, activityId: built.activityId,
                casterActor: dragon, recipe: built.recipe, presence: presFlag }) ?? [];
          });
        } catch (e) { errC9 = e; }
        const held9 = applied9.filter(a => (a?.held?.length ?? 0) > 0);
        const landed9 = applied9.filter(a => (a?.conditions?.length ?? 0) > 0);
        const html9 = engine9._buildPhase1CardHtml(fp, rows9, { saveAbility: "wis", saveDC: 16,
          hasDamage: false, halfOnSave: false, activityId: built.activityId,
          appliedConditions: applied9, autoResolve: true, presence: presFlag });
        const order9 = [...String(html9).matchAll(/data-token-doc-id="(tok-fp-[a-z]+)"/g)].map(m => m[1]);
        check("the knight takes Frightened the moment its save is in and Chudd does not: his waits behind an APPLY button that names him, and his row is the last one on the card (2026-09-20)",
          !errC9 && held9.length === 1 && held9[0].targetName === "Chudd" && held9[0].held.includes("frightened")
            && landed9.some(a => a.targetName === "a knight" && a.conditions.includes("frightened"))
            && /aceQolApplyHeld/.test(html9) && /Chudd/.test(html9)
            && order9.lastIndexOf("tok-fp-chudd") > order9.lastIndexOf("tok-fp-knight"),
          errC9 ? `threw: ${errC9?.message ?? errC9}`
            : `landed: ${landed9.map(a => `${a.targetName}: ${a.conditions.join(", ")}`).join("; ") || "nothing"}; `
              + `waiting: ${held9.map(a => `${a.targetName} -> ${a.held.join(", ")}`).join("; ") || "nobody"}; `
              + `rows: ${order9.join(", ")}`);

        // NOTHING LANDS TWICE, AND NOTHING BUT FRIGHTENED.
        // The knight now carries the mark the first card left on it; a second
        // card reaching the same creature must put nothing on it again.
        setEffects(knight, [markFright("tok-fp-dragon", "Frightful Presence")]);
        let twice = [];
        try {
          await quiet(async () => {
            twice = await engine9._applyFailedSaveConditions(fp, [rows9[0]],
              { saveAbility: "wis", saveDC: 16, activityId: built.activityId,
                casterActor: dragon, recipe: built.recipe, presence: presFlag }) ?? [];
          });
        } catch (e) { twice = [{ declined: String(e?.message ?? e) }]; }
        check("a creature already frightened by that dragon takes nothing a second time, and the card says why rather than going quiet (2026-09-20)",
          twice.length === 1 && (twice[0].conditions?.length ?? 0) === 0
            && /already frightened/i.test(String(twice[0].note ?? "")),
          twice.map(a => `${a.targetName ?? "?"}: ${(a.conditions ?? []).join(", ") || a.note || a.declined || "nothing"}`).join("; "));
        setEffects(knight, []);

        // NEVER COMPELLED: what the item carries beside the words does not ride along.
        const src9 = readFileSync(`${ROOT}/Data/modules/ace-qol/scripts/save-engine.mjs`, "utf8");
        check("and only the condition its words name can land: for a presence the item's own effects are never copied, so a copy carrying Compelled or Command adds nothing (2026-09-20)",
          /const presenceOnly = !!saveCtx\?\.presence\?\.sourceTokenId;/.test(src9)
            && /const copyFail = \(registryEffectKey \|\| presenceOnly\) \? \[\]/.test(src9)
            && /const copySuccess = \(registryEffectKey \|\| presenceOnly\) \? \[\]/.test(src9)
            && /const successConditions = \(registryEffectKey \|\| presenceOnly\)/.test(src9),
          "the item's own effects and its on-success conditions are both skipped for a presence");

        // A ROLL THAT LANDED BEFORE THE CARD EXISTED.
        const castId9 = "cast-fp-early";
        const early = await ChatMessage.create({ content: "", flags: { [MOD]: {
          type: "pcSaveResult", castId: castId9, tokenDocId: "tok-fp-chudd",
          saveTotal: 9, dieResult: 4, passed: false, autoFailSave: false } } });
        const pending9 = [{ name: "Chudd", tokenDocId: "tok-fp-chudd", actorId: chudd.id, sceneId: SCENE9,
          isPC: true, pending: true, saveTotal: null, passed: false }];
        let card9 = null;
        try {
          await quiet(async () => {
            card9 = await engine9._postSaveResultsPhase1(fp, dragon, pending9, {
              saveAbility: "wis", saveDC: 16, hasDamage: false, halfOnSave: false,
              activityId: built.activityId, recipe: built.recipe, appliedConditions: [],
              castId: castId9, presence: presFlag });
          });
        } catch (_) { /* the card itself is not what is pinned */ }
        check("a player's roll that landed before the card existed is written onto their row when it is built: Chudd's 9 and his failure, not \"waiting for player\" (2026-09-20)",
          pending9[0].pending === false && Number(pending9[0].saveTotal) === 9
            && pending9[0].passed === false,
          `Chudd's row: ${pending9[0].pending ? "still waiting (wrong)" : `${pending9[0].saveTotal}, `
            + `${pending9[0].passed ? "passed" : "failed"}`}`);

        // AND NO SECOND BOX FOR IT.
        check("and no box opens for a roll that already landed: the prompt for that same cast and creature knows the answer is in (2026-09-20)",
          SaveEngine._alreadyAnswered({ castId: castId9, tokenDocId: "tok-fp-chudd" }) === true
            && SaveEngine._alreadyAnswered({ castId: castId9, tokenDocId: "tok-fp-knight" }) === false,
          `Chudd: answered ${SaveEngine._alreadyAnswered({ castId: castId9, tokenDocId: "tok-fp-chudd" })}; `
            + `the knight: answered ${SaveEngine._alreadyAnswered({ castId: castId9, tokenDocId: "tok-fp-knight" })}`);
        try { await early.delete?.(); } catch (_) { /* the harness may not delete */ }

        // ONCE, AND THE MARK LIVES ON THE FIGHT.
        const flags9 = {};
        const combat9 = { started: true, combatants: [],
          getFlag: (m, k) => flags9[`${m}.${k}`], setFlag: async (m, k, v) => { flags9[`${m}.${k}`] = v; } };
        const keepCombat = game.combat;
        PresenceEngine._claimed?.clear?.();
        const ran = [];
        const keepRun = PresenceEngine.run;
        PresenceEngine.run = async (doc, item) => { ran.push(item.name); };
        try {
          game.combat = combat9;
          // ⚠️ ALL THREE AT ONCE, which is what his table hit: combatStart and
          // combatTurnChange both fire as a fight begins, and each read the
          // combat's flag before any of them had written it.
          await quiet(async () => {
            await Promise.all([
              PresenceEngine._fireFor(docs9.get("tok-fp-dragon"), "the fight started"),
              PresenceEngine._fireFor(docs9.get("tok-fp-dragon"), "its first turn began"),
              PresenceEngine._fireFor(docs9.get("tok-fp-dragon"), "it appeared on the map"),
            ]);
          });
        } finally {
          PresenceEngine.run = keepRun;
          game.combat = keepCombat;
        }
        check("it happens once a fight even when all three doors open in the same instant: the fight starting, its first turn and its token appearing race each other, and exactly one presence runs (2026-09-20)",
          ran.length === 1 && ran[0] === "Frightful Presence"
            && Object.keys(flags9).length === 1,
          `it ran ${ran.length} time(s)${ran.length ? ` (${ran.join(", ")})` : ""}; the fight remembers `
            + `${Object.values(flags9).map(v => Object.keys(v).length).join("/")} creature(s)`);

        // And the press lands exactly what was waiting, through the same door.
        const msg9 = { id: "msg-fp-1", flags: { [MOD]: { itemUuid: fp.uuid ?? null, itemId: fp.id,
          actorId: dragon.id, saveAbility: "wis", saveDC: 16, activityId: built.activityId,
          recipe: built.recipe, hasDamage: false, halfOnSave: false, autoResolve: true,
          presence: presFlag, appliedConditions: applied9, allResults: rows9 } },
          content: html9,
          update: async (u = {}) => { for (const [k, v] of Object.entries(u)) {
            if (k.includes(".")) setPath9(msg9, k, v); else msg9[k] = v; } return msg9; } };
        let errA9 = null;
        try { await quiet(() => engine9._applyHeldConditions(msg9)); }
        catch (e) { errA9 = e; }
        const after9 = msg9.flags[MOD].appliedConditions ?? [];
        const stillHeld = after9.filter(a => (a?.held?.length ?? 0) > 0);
        check("and his APPLY lands Chudd's: nothing is left waiting, the button is gone, and the card says what he took (2026-09-20)",
          !errA9 && stillHeld.length === 0 && !/aceQolApplyHeld/.test(String(msg9.content ?? ""))
            && after9.some(a => a.targetName === "Chudd" && (a.conditions ?? []).includes("frightened")),
          errA9 ? `threw: ${errA9?.message ?? errA9}`
            : `still waiting: ${stillHeld.length}; the card now says: `
              + `${after9.map(a => `${a.targetName}: ${(a.conditions ?? []).join(", ") || a.declined || "nothing"}`).join("; ") || "nothing"}`);
      }
    }
  } finally {
    ChatMessage.create = keep9.create;
    game.users = keep9.users;
    game.user = keep9.user;
    game.messages = keep9.messages;
    game.scenes.get = keep9.scenesGet;
    canvas.scene = keep9.scene;
    canvas.tokens.placeables.length = 0;
    canvas.tokens.placeables.push(...keep9.placed);
    Sit9.canSee = keep9.canSee;
    if (keep9.backends === undefined) delete CONFIG.Canvas.polygonBackends;
    else CONFIG.Canvas.polygonBackends = keep9.backends;
    if (keep9.time === undefined) delete game.time; else game.time = keep9.time;
    if (keep9.gmActive === undefined) delete GM.active; else GM.active = keep9.gmActive;
    if (keep9.owner === undefined) delete CONST.DOCUMENT_OWNERSHIP_LEVELS; else CONST.DOCUMENT_OWNERSHIP_LEVELS = keep9.owner;
    for (const a of made9) ACTORS.delete(a.id);
  }
}

/* ── THE PRESS, THE LOOK AND THE TARGETS ─────────────────────────────────── */
// His list of 2026-09-20, items 4 to 6: no consume window on a creature's own
// action, a breath weapon that shows the breath, and an area that lets go of
// the creatures it caught while a single-target attack keeps its one.
console.log(`\nTHE PRESS, THE LOOK AND THE TARGETS`);
{
  const { ActivityUsePrompt } = await import(`${MODULE}/scripts/activity-use-prompt.mjs`);
  const { BreathAnimator, isCreatureArea } = await import(`${MODULE}/scripts/breath-animator.mjs`);
  const dragon = firstActor("Volcathar the Flameborn CR17");
  const breath = dragon?.items?.find(i => i.name === "Fire Breath") ?? null;
  const claw = dragon?.items?.find(i => i.name === "Claw") ?? null;
  const varek = firstActor("Varek Thalor (CR 30)");
  const fireball = varek?.items?.find(i => i.name === "Fireball") ?? null;

  if (!dragon || !breath || !claw) {
    check("his dragon's press, look and targets (2026-09-20)", null, "no Volcathar with a Fire Breath and a Claw");
  } else {
    /* ── 4. NO CONSUME WINDOW ON A CREATURE'S OWN ACTION ─────────────────── */
    const act4 = [...breath.system.activities][0];
    const src4 = readFileSync(`${ROOT}/Data/modules/ace-qol/scripts/activity-use-prompt.mjs`, "utf8");
    // dnd5e's own dialog is what he is looking at, so the branch must switch it off.
    const branch = src4.slice(src4.indexOf("isCreaturesOwnAction(activity)) {"),
      src4.indexOf("const spend = ActivityUsePrompt._describeCost(activity);"));
    check("pressing his dragon's breath asks nothing: it is a creature's own action, so ACE's consume prompt never opens AND dnd5e's own window is switched off on the way past, and the recharge is simply spent (2026-09-20)",
      ActivityUsePrompt.isCreaturesOwnAction(act4) === true
        && /dialogConfig\).*configure = false/s.test(branch)
        && /return;/.test(branch)
        && !/showConsumePrompt/.test(branch),
      `a creature's own action: ${ActivityUsePrompt.isCreaturesOwnAction(act4)}; `
        + `the branch shuts dnd5e's dialog: ${/configure = false/.test(branch)}`);

    // ⚠️ VAREK IS AN NPC, VILLAIN OR NOT. The line is a player's CHARACTER, which
    // is what dnd5e's own actor type says, not who is scary.
    const playersWand = { actor: { type: "character", name: "a player's character" } };
    check("and a player character's own limited-use item still asks, because keeping the charge is a real question (2026-09-20)",
      ActivityUsePrompt.isCreaturesOwnAction(playersWand) === false
        && ActivityUsePrompt.isCreaturesOwnAction({ actor: { type: "npc" } }) === true,
      `a character is asked: ${!ActivityUsePrompt.isCreaturesOwnAction(playersWand)}; `
        + `an NPC is not: ${ActivityUsePrompt.isCreaturesOwnAction({ actor: { type: "npc" } })}`);

    /* ── 5. THE BREATH SHOWS THE BREATH ──────────────────────────────────── */
    check("ACE knows a creature's cone or line from everything else: his dragon's Fire Breath is one, its Claw is not, and a player's spell never is (2026-09-20)",
      !!isCreatureArea(breath) && String(isCreatureArea(breath).shape) === "cone"
        && !isCreatureArea(claw)
        && (!fireball || !isCreatureArea(fireball)),
      `the breath: ${JSON.stringify(isCreatureArea(breath))}; the claw: ${JSON.stringify(isCreatureArea(claw))}; `
        + `a spell: ${JSON.stringify(fireball ? isCreatureArea(fireball) : null)}`);

    // Played down the template he placed, from his own curated record.
    const played = [];
    const keepSeq = globalThis.Sequence;
    const keepSequencer = globalThis.Sequencer;
    globalThis.Sequencer = { Database: { entryExists: (p) => /jb2a/.test(String(p)) } };
    globalThis.Sequence = class {
      sound() { const s = { file: (f) => { played.push(`sound ${f}`); return s; },
        volume: () => s, delay: () => s }; return s; }
      effect() { const e = { file: (f) => { played.push(`file ${f}`); return e; },
        atLocation: (l) => { played.push(`from ${Math.round(l.x)},${Math.round(l.y)}`); return e; },
        stretchTo: (l) => { played.push(`to ${Math.round(l.x)},${Math.round(l.y)}`); return e; },
        opacity: () => e }; return e; }
      play() { played.push("play"); return Promise.resolve(true); }
    };
    const tmpl5 = { id: "tpl-breath", x: 1000, y: 1000, direction: 0, distance: 60,
      parent: { grid: { size: 100, distance: 5 } } };
    let ok5 = false, stoodDown = null;
    try {
      ok5 = await quiet(() => BreathAnimator.play(tmpl5, breath, dragon, { damageTypes: ["fire"] }));
      // The stand-down door is registered at startup in the live module; the
      // replay never runs that, so it is registered here before it is knocked on.
      BreathAnimator.register();
      const data = { item: breath };
      for (const fn of hooks["AutomatedAnimations-WorkflowStart"] ?? []) fn(data);
      stoodDown = data.stopWorkflow === true;
    } finally {
      if (keepSeq === undefined) delete globalThis.Sequence; else globalThis.Sequence = keepSeq;
      if (keepSequencer === undefined) delete globalThis.Sequencer; else globalThis.Sequencer = keepSequencer;
    }
    check("his dragon's breath plays a fire cone down the template he placed, 60 feet of it, and Automated Animations stands down for that one item so there is never two (2026-09-20)",
      ok5 === true && played.includes("play")
        && played.some(p => /^file /.test(p))
        && played.some(p => p === "from 1000,1000") && played.some(p => p === "to 2200,1000")
        && stoodDown === true,
      `${played.join(" > ") || "nothing played"}; AA stood down: ${stoodDown}`);

    check("and the template outlives its clip: the cleanup asks what is still playing over it before it deletes anything (2026-09-20)",
      /BreathAnimator.waitFor\(tmplId\)/.test(readFileSync(`${ROOT}/Data/modules/ace-qol/scripts/save-engine.mjs`, "utf8")),
      "the instant-template cleanup waits for the breath");

    /* ── 6. AN AREA LETS GO; AN ATTACK KEEPS ITS TARGET ──────────────────── */
    const keepTargets = game.user.targets;
    const dropped = [];
    const tok6 = (id, name) => ({ id, name, document: { id }, setTarget: () => dropped.push(name) });
    const a = tok6("t6-a", "a knight"), b = tok6("t6-b", "an azer"), c = tok6("t6-c", "a bystander");
    try {
      game.user.targets = new Set([a, b, c]);
      const rows6 = [{ tokenDocId: "t6-a" }, { tokenDocId: "t6-b" }];
      quiet(() => SaveEngine._releaseAreaTargets(breath, { where: { kind: "area" } }, rows6));
      quiet(() => SaveEngine._releaseAreaTargets(claw, { where: { kind: "ranged", melee: true } },
        [{ tokenDocId: "t6-c" }]));
    } finally {
      game.user.targets = keepTargets;
    }
    check("when the breath is done it lets go of the two it caught, and the bystander he targeted himself stays targeted; a melee attack lets go of nobody (2026-09-20)",
      dropped.length === 2 && dropped.includes("a knight") && dropped.includes("an azer")
        && !dropped.includes("a bystander"),
      `let go of: ${dropped.join(", ") || "nobody"}`);
  }
}

/* ── A CANCELLED CAST GIVES BACK WHAT THE PRESS SPENT ────────────────────── */
// 2026-09-18. dnd5e takes what a press costs before any of ACE runs (a daily
// use, a recharge, a legendary action) and writes it on the usage message, even
// when ACE has stopped the card; its own refund puts it back. The spell pipeline
// kept the slot it had held on every way out of a cast and left the rest spent:
// Vistana Spy's Curse, a Gray Slaad's Fly and Akra's free Command stayed spent
// after the picker closed, under a toast that said "slot not consumed".
//
// These drive the real pipeline dispatch with his own items, pressed by a copy
// of their own creature that can take a write. Only the picker's dialog, the
// save resolver's dice, the condition door and dnd5e's refund are stood in, and
// dnd5e's word on a placement is handed to the listener the dispatch started.
console.log(`\nA CANCELLED CAST GIVES BACK WHAT THE PRESS SPENT`);
await quiet(async () => {
  const lengths = Object.fromEntries(Object.entries(hooks).map(([k, v]) => [k, v.length]));
  const { SpellTargetPicker: PickerGB } = await import(`${MODULE}/scripts/spell-target-picker.mjs`);
  const { SaveResolver: SaveGB } = await import(`${MODULE}/scripts/spell-pipeline/resolvers/save.mjs`);
  const { ConditionDoor: CondGB } = await import(`${MODULE}/scripts/road/doors.mjs`);
  const { ReactionEngine: ReactGB } = await import(`${MODULE}/scripts/reaction-engine.mjs`);
  const { describeSpent } = await import(`${MODULE}/scripts/road/give-back.mjs`);
  const SCENE_GB = "replay-gb-scene";
  const docsGB = new Map();
  const keepGB = { show: PickerGB._showDialog, save: SaveGB.runSingle, notes: ui.notifications,
    placed: [...canvas.tokens.placeables], scene: canvas.scene, scenes: game.scenes.get, targets: game.user.targets,
    tokenClass: CONFIG.Token, apply: CondGB.apply, own: CondGB.applyItemEffect, wait: SpellPipeline.areaWaitMs };
  const toasts = [];
  const say3 = (m) => { toasts.push(String(m)); };
  ui.notifications = { info: say3, warn: say3, error: say3 };
  class GBToken { setTarget(on) { if (!on) game.user.targets.delete(this); else game.user.targets.add(this); } }
  CONFIG.Token = { objectClass: GBToken };
  game.user.targets = new Set();
  game.scenes.get = (id) => (id === SCENE_GB
    ? { id, tokens: { get: (t) => docsGB.get(t) ?? null, contents: [...docsGB.values()], find: (fn) => [...docsGB.values()].find(fn) } }
    : keepGB.scenes(id));
  // A wait nobody answers gives up in a moment here, so a broken pin fails instead of hanging.
  SpellPipeline.areaWaitMs = 400;
  CondGB.apply = async (_a, key) => ({ ok: true, applied: key });
  CondGB.applyItemEffect = async (_i, _a, fx) => ({ ok: true, name: fx?.name });

  const setPathGB = (obj, key, v) => {
    const p = key.split("."); let o = obj;
    for (const s of p.slice(0, -1)) o = (o[s] ??= {});
    o[p[p.length - 1]] = v;
  };
  // One of his creatures, able to take what a cast writes: the replay's copies are records, not documents.
  const standIn = (actor) => {
    const a = { ...actor, system: JSON.parse(JSON.stringify(actor.system ?? {})), writes: [] };
    a.update = async (u) => { a.writes.push(u); for (const [k, v] of Object.entries(u)) setPathGB(a, k, v); return a; };
    return a;
  };
  const placeGB = (actor, id, x) => {
    const doc = { id, actorId: actor.id, actor, parent: { id: SCENE_GB }, flags: {}, name: actor.name, hidden: false,
      x, y: 0, width: 1, height: 1, elevation: 0, disposition: -1, texture: { src: "" }, update: async () => doc };
    const tok = Object.assign(new GBToken(), { id, name: actor.name, actor, document: doc,
      x, y: 0, w: 100, h: 100, center: { x: x + 50, y: 50 } });
    doc.object = tok;
    docsGB.set(id, doc);
    canvas.tokens.placeables.push(tok);
    actor.getActiveTokens = () => [tok];
    return tok;
  };
  const victim = { id: "replay-gb-victim", name: "somebody within reach", type: "npc", img: "", uuid: "Actor.replay-gb-victim",
    statuses: new Set(), effects: new Collection(), items: new Collection(), flags: {},
    system: { attributes: { hp: { value: 30, max: 30 } }, details: { type: { value: "humanoid" } } },
    getFlag: () => undefined, getRollData: () => ({}) };
  ACTORS.set(victim.id, victim);
  // A press of one of his items by its own creature, as dnd5e hands it to the pipeline.
  const pressOf = (item, { slot = false } = {}) => {
    const caster = standIn(item.actor);
    const it = { ...item, actor: caster, parent: caster };
    const act = { ...[...item.system.activities][0], item: it, actor: caster, parent: it, refunds: [] };
    act.refund = async (d) => { act.refunds.push(d); };
    if (slot) act._aceSlotDeferred = true;   // the slot the pipeline's pre-cast hook holds back
    canvas.tokens.placeables.length = 0;
    docsGB.clear();
    placeGB(caster, "tok-gb-caster", 0);
    placeGB(victim, "tok-gb-victim", 100);
    return { caster, it, act };
  };
  // What dnd5e's consume() writes for one use of the item itself.
  const oneUse = (it) => ({ item: { [it.id]: [{ keyPath: "system.uses.spent", delta: 1 }] } });
  // The pipeline's own listeners for one cast, caught as its dispatch starts them.
  const dispatchGB = (act, payload) => {
    const caught = {};
    const keepOn = Hooks.on;
    Hooks.on = (n, f) => { (caught[n] ??= []).push(f); return keepOn(n, f); };
    let running;
    try { running = SpellPipeline._dispatch(act, payload); } finally { Hooks.on = keepOn; }
    return { running, fire: (name, ...args) => { for (const f of caught[name] ?? []) f(...args); } };
  };
  const findGB = (actorName, itemName, test = () => true) => [...ACTORS.values()].filter(a => a.name === actorName)
    .flatMap(a => a.items.filter(i => i.name === itemName)).find(test) ?? null;
  const said = () => toasts.join(" | ") || "(nothing said)";

  try {
    // ── The picker closed ──
    const curse = findGB("Vistana Spy", "Curse");
    if (!curse) check("a closed picker gives back a daily use", null, "(Vistana Spy has no Curse in this world)");
    else {
      const { it, act } = pressOf(curse);
      PickerGB._showDialog = async () => [];
      const deltas = oneUse(it);
      const payload = { system: { deltas } };
      toasts.length = 0;
      await SpellPipeline._dispatch(act, payload);
      check("Vistana Spy's Curse (once a long rest), its picker closed: dnd5e's own refund puts the use back, exactly as dnd5e wrote it, and the record is cleared so nothing can give it back twice (2026-09-18)",
        act.refunds.length === 1 && act.refunds[0] === deltas && payload.system.deltas === null
          && /Curse: cancelled\. Given back: a use of Curse\./.test(said()),
        `refunds: ${act.refunds.length}; the record: ${payload.system.deltas === null ? "cleared" : "still there"}; said: ${said()}`);
    }

    const fly = findGB("Gray Slaad", "Fly", i => i.system?.method === "innate");
    if (!fly) check("a closed picker gives back an innate casting", null, "(no Gray Slaad with an innate Fly in this world)");
    else {
      // With dnd5e's own card showing (his setting off): its record is cleared the way its Refund clears it.
      const { it, act } = pressOf(fly);
      PickerGB._showDialog = async () => [];
      let cleared = null;
      const card = { id: "gb-card", system: { deltas: oneUse(it) }, update: async (u) => { cleared = u; } };
      toasts.length = 0;
      await SpellPipeline._dispatch(act, card);
      check("a Gray Slaad's innate Fly (twice a day), its picker closed with dnd5e's card showing: the use comes back and the card's record is cleared, as its own Refund would (2026-09-18)",
        act.refunds.length === 1 && cleared?.["system.deltas"] === null && /Given back: a use of Fly\./.test(said()),
        `refunds: ${act.refunds.length}; the card: ${cleared ? "cleared" : "left as it was"}; said: ${said()}`);
    }

    const insects = findGB("Ancient Black Dragon", "Cloud of Insects");
    if (!insects) check("a closed picker gives back a legendary action", null, "(no Ancient Black Dragon with Cloud of Insects)");
    else {
      const { act } = pressOf(insects);
      PickerGB._showDialog = async () => [];
      const deltas = { actor: [{ keyPath: "system.resources.legact.spent", delta: 1 }] };
      toasts.length = 0;
      await SpellPipeline._dispatch(act, { system: { deltas } });
      check("an Ancient Black Dragon's Cloud of Insects (a legendary action), its picker closed: the legendary action comes back (2026-09-18)",
        act.refunds.length === 1 && act.refunds[0] === deltas && /Given back: a legendary action\./.test(said()),
        `refunds: ${act.refunds.length}; said: ${said()}`);
    }

    const hold = findGB(VAREK, "Hold Person", i => i.system?.source?.rules === "2024");
    if (!hold) check("a closed picker on a slot spell", null, "(Varek has no 2024 Hold Person)");
    else {
      const { caster, act } = pressOf(hold, { slot: true });
      PickerGB._showDialog = async () => [];
      toasts.length = 0;
      await SpellPipeline._dispatch(act, { system: { spellLevel: 2 } });
      check("Varek's Hold Person, its picker closed: the slot held back is never taken, and a press that spent nothing else calls no refund (2026-09-18)",
        act.refunds.length === 0 && act._aceSlotDeferred === false && caster.writes.length === 0
          && /Hold Person: cancelled\. No slot was spent\./.test(said()),
        `refunds: ${act.refunds.length}; the hold: ${act._aceSlotDeferred ? "still on" : "let go"}; writes to Varek: ${caster.writes.length}; said: ${said()}`);
    }

    // ── The cast went ahead: nothing comes back ──
    if (curse) {
      const { it, act } = pressOf(curse);
      PickerGB._showDialog = async (o) => { const c = o.candidates.find(x => x.actor === victim && x.valid); return c ? [c.actor] : []; };
      let resolved = 0;
      SaveGB.runSingle = async () => { resolved++; };
      const deltas = oneUse(it);
      await SpellPipeline._dispatch(act, { system: { deltas } });
      const went = { refunds: act.refunds.length, resolved };
      const again = pressOf(curse);
      SaveGB.runSingle = async () => { throw new Error("a resolver failing after the pick"); };
      // The failure is reported, not swallowed; held here so the check prints and the stack does not.
      const reported = [];
      const keepError = console.error;
      console.error = (...a) => { reported.push(a.map(String).join(" ")); };
      try { await SpellPipeline._dispatch(again.act, { system: { deltas: oneUse(again.it) } }); }
      finally { console.error = keepError; SaveGB.runSingle = keepGB.save; }
      check("the Curse picked a target and went ahead: nothing is given back, and a failure after the pick gives nothing back either, because the cast had happened, and the failure is said (2026-09-18)",
        went.resolved === 1 && went.refunds === 0 && again.act.refunds.length === 0
          && reported.some(l => /dispatch failed for Curse/.test(l)),
        `resolved: ${went.resolved}; refunds after a pick: ${went.refunds}; after a failure past the pick: ${again.act.refunds.length}; `
          + `the failure ${reported.length ? "was reported" : "was never reported"}`);
    }

    // ── The area ──
    const breath = findGB("Adult White Dragon", "Cold Breath");
    if (!breath) check("a cancelled area gives back a recharge", null, "(no Adult White Dragon with Cold Breath)");
    else {
      const { caster, it, act } = pressOf(breath);
      const deltas = oneUse(it);
      const d = dispatchGB(act, { system: { deltas } });
      d.fire("dnd5e.postUseActivity", act, { create: { measuredTemplate: true } }, { templates: [] });
      await d.running;
      const cancelled = act.refunds.length;
      const words = describeSpent(deltas, caster);
      const placedPress = pressOf(breath);
      const p = dispatchGB(placedPress.act, { system: { deltas: oneUse(placedPress.it) } });
      p.fire("createMeasuredTemplate", { id: "gb-cone", flags: { dnd5e: { origin: placedPress.act.uuid, item: placedPress.it.uuid } } });
      await p.running;
      check("an Adult White Dragon's Cold Breath (recharge 5-6): dnd5e says the cone was never placed, and the recharge comes back at once; a cone that lands keeps it spent (2026-09-18)",
        cancelled === 1 && act.refunds[0] === deltas && words === "Cold Breath's recharge" && placedPress.act.refunds.length === 0,
        `given back when cancelled: ${cancelled} (${words}); when placed: ${placedPress.act.refunds.length}`);
    }

    const stink = findGB(VAREK, "Stinking Cloud");
    if (!stink) check("an area placed during the Counterspell wait", null, "(Varek has no Stinking Cloud)");
    else {
      // dnd5e places the area straight after the usage hook, while the Counterspell hold can still be open.
      const { caster, act } = pressOf(stink, { slot: true });
      setPathGB(caster, "system.spells.spell3", { value: 2, max: 3 });
      ReactGB._createCastBarrier(act);
      const d = dispatchGB(act, { system: { spellLevel: 3 } });
      d.fire("createMeasuredTemplate", { id: "gb-cloud", flags: { dnd5e: { origin: act.uuid, item: act.item.uuid } } });
      await new Promise(r => setTimeout(r, 30));
      ReactGB._resolveCastBarrier(act, { abort: false, reason: "not countered" });
      await d.running;
      check("Varek's Stinking Cloud, its area placed while the Counterspell hold was still open: the pipeline still sees it, and the level 3 slot is spent (2026-09-18)",
        caster.system.spells.spell3.value === 1 && act.refunds.length === 0,
        `his level 3 slots: ${caster.system.spells.spell3.value} of 3 (2 before the cast); refunds: ${act.refunds.length}`);
    }

    const slaadBall = findGB("Gray Slaad", "Fireball", i => i.system?.method === "innate");
    if (!slaadBall) check("an area dnd5e was told not to place", null, "(no Gray Slaad with an innate Fireball)");
    else {
      const unticked = pressOf(slaadBall);
      const u = dispatchGB(unticked.act, { system: { deltas: oneUse(unticked.it) } });
      u.fire("dnd5e.postUseActivity", unticked.act, { create: { measuredTemplate: false } }, { templates: [] });
      await u.running;
      const silent = pressOf(slaadBall);
      const s = dispatchGB(silent.act, { system: { deltas: oneUse(silent.it) } });
      await s.running;
      check("a Gray Slaad's innate Fireball: with dnd5e told not to place the area, the cast goes on and keeps its use; with no word at all by the backstop, it is treated as cancelled and the use comes back (2026-09-18)",
        unticked.act.refunds.length === 0 && silent.act.refunds.length === 1,
        `not asked to place: ${unticked.act.refunds.length} given back; no word at all: ${silent.act.refunds.length} given back`);
    }

    const detect = findGB(VAREK, "Detect Magic");
    if (!detect) check("a self spell cast with a slot", null, "(Varek has no Detect Magic)");
    else {
      const { caster, act } = pressOf(detect, { slot: true });
      setPathGB(caster, "system.spells.spell1", { value: 3, max: 4 });
      const started = Date.now();
      await SpellPipeline._dispatch(act, { system: { spellLevel: 1 } });
      const took = Date.now() - started;
      check("Varek's Detect Magic cast with a slot: its area is ACE's to draw, so nothing waits on one, and the level 1 slot is spent (it used to be kept after thirty seconds of waiting for an area nobody places) (2026-09-18)",
        caster.system.spells.spell1.value === 2 && act.refunds.length === 0,
        `his level 1 slots: ${caster.system.spells.spell1.value} of 4 (3 before); the cast took ${took} ms`);
    }

    // ── A route nobody wrote ──
    const gaseous = [...ACTORS.values()].flatMap(a => a.items.filter(i => i.name === "Gaseous Form"))
      .find(i => shapeOf(i) === "touch" && Number(i.system?.uses?.max) > 0) ?? null;
    if (!gaseous) check("a route nobody wrote is refused before the picker", null, "(no touch-shaped Gaseous Form with daily uses)");
    else {
      const { it, act } = pressOf(gaseous);
      let opened = 0;
      PickerGB._showDialog = async () => { opened++; return []; };
      toasts.length = 0;
      // The refusal is an error line by design; held here and checked, so it is read, not printed.
      const lines = [];
      const keepError = console.error;
      console.error = (...a) => { lines.push(a.map(String).join(" ")); };
      try { await SpellPipeline._dispatch(act, { system: { deltas: oneUse(it) } }); }
      finally { console.error = keepError; }
      const line = lines.find(l => /Gaseous Form" routed to/.test(l)) ?? "";
      check(`${gaseous.actor?.name}'s Gaseous Form (a touch spell that heals nobody, which ACE has no resolver for): refused before any picker opens, its daily use given back, and the refusal says nothing was spent (2026-09-18)`,
        opened === 0 && act.refunds.length === 1 && /nothing was spent/.test(said()) && !/refunded/i.test(said())
          && /nothing was spent/.test(line),
        `pickers opened: ${opened}; refunds: ${act.refunds.length}; said: ${said()}; the console: ${line || "(nothing)"}`);
    }
  } catch (err) {
    check("a cancelled cast gives back what the press spent: the pins ran", false, `threw: ${err?.stack ?? err}`);
  } finally {
    PickerGB._showDialog = keepGB.show;
    SaveGB.runSingle = keepGB.save;
    CondGB.apply = keepGB.apply;
    CondGB.applyItemEffect = keepGB.own;
    SpellPipeline.areaWaitMs = keepGB.wait;
    ui.notifications = keepGB.notes;
    CONFIG.Token = keepGB.tokenClass;
    game.scenes.get = keepGB.scenes;
    game.user.targets = keepGB.targets;
    canvas.scene = keepGB.scene;
    canvas.tokens.placeables.length = 0;
    canvas.tokens.placeables.push(...keepGB.placed);
    ACTORS.delete(victim.id);
    for (const [k, n] of Object.entries(lengths)) hooks[k].length = n;
    for (const k of Object.keys(hooks)) if (!(k in lengths)) delete hooks[k];
  }
});

/* ── PHASE 6b: COUNTERSPELL ────────────────────────────────────────────────── */
// Johnny, 2026-09-16: "PHASE 6b - Counterspell only. Then stop." Someone within
// 60 feet starts a spell; a creature holding Counterspell, with a slot, a free
// reaction and able to act, is asked. Yes spends both and interrupts the spell -
// 2014 automatically when the slot covers the spell's level, otherwise an
// ability check; 2024 by the caster's Constitution save. No lets it through.
// Nobody else is asked, and whoever holds Counterspell but was passed over is
// named in the log with the reason.
//
// ⚠️ THE EDITION IS THE ITEM'S. His world holds BOTH Counterspells at once:
// Kasimir's is 2024, the Archmage (CR 20)'s is 2014, Patrina's is 2014,
// Morthos's is 2024, and Varek Thalor carries one of each. A world-level read
// would roll the wrong dice for about half of them.
//
// ⚠️ THIS DRIVES THE REAL `_onSpellCast`. Only the prompt and the caster's
// saving throw are stood in, because one is a dialog on somebody's screen and
// the other is dnd5e's own roller.
console.log(`\nPHASE 6b: COUNTERSPELL`);
{
  const MOD = "ace-qol";
  const { ReactionEngine } = await import(`${MODULE}/scripts/reaction-engine.mjs`);
  const { CardDoor: Door6b } = await import(`${MODULE}/scripts/road/doors.mjs`);

  const keep6b = { placed: [...canvas.tokens.placeables], combat: game.combat, combats: game.combats,
    post: Door6b.post,
    reactions: SETTINGS.get("ace-qol.enableReactions"), cs: SETTINGS.get("ace-qol.autoCounterspell"),
    edition: SETTINGS.get("ace-qol.gameRulesEdition"),
    anyCaster: SETTINGS.get("ace-qol.counterspellAnyCaster") };
  SETTINGS.set("ace-qol.enableReactions", true);
  SETTINGS.set("ace-qol.autoCounterspell", true);
  // ⚠️ HIS WORLD HAS THE ALLY OPT-IN ON (`counterspellAnyCaster = true`), so
  // the default is set here deliberately rather than inherited: the first pin is
  // about the shipped default, and the one after it is about his table.
  SETTINGS.set("ace-qol.counterspellAnyCaster", false);
  const cards6b = [];
  Door6b.post = async (data) => { cards6b.push(data); return { id: "cs-card", ...data }; };
  canvas.tokens.placeables.length = 0;
  const made6b = [];
  try {
    // dnd5e 5.x on the sheet: a method name and a NUMBER (0/1/2). The edition is
    // the item's own `system.source.rules`, exactly as his copies carry it.
    let csn = 0;
    const csItem = (rules, { prepared = 1 } = {}) => ({
      id: `cs-${rules}-${++csn}`, name: "Counterspell", type: "spell", img: "",
      system: { level: 3, method: "spell", prepared, source: { rules }, activities: [] },
    });
    const other = (name) => ({ id: `it-${name}`, name, type: "spell", img: "",
      system: { level: 3, method: "spell", prepared: 1, activities: [] } });

    const mage = (id, name, { items = [], slots = { 3: 2 }, statuses = [], hp = 40, dc = 17,
      ability = "int", disposition = -1, at = [0, 0], flags = {} } = {}) => {
      const spells = {};
      for (const [lvl, n] of Object.entries(slots)) spells[`spell${lvl}`] = { value: n, max: 3 };
      const a = { id, name, type: "npc", img: "", documentName: "Actor", uuid: `Actor.${id}`,
        statuses: new Set(statuses), effects: [], items, hasPlayerOwner: false,
        system: { attributes: { hp: { value: hp, max: 40 }, death: { success: 0, failure: 0 },
            prof: 6, spellcasting: ability, spell: { dc } },
          abilities: { int: { mod: 5 }, cha: { mod: 5 }, wis: { mod: 3 }, con: { mod: 3 } },
          spells, details: {} },
        flags: { [MOD]: { ...flags } },
        getFlag: (scope, key) => a.flags?.[scope]?.[key],
        setFlag: async (scope, key, v) => { (a.flags[scope] ??= {})[key] = v; return a; },
        unsetFlag: async (scope, key) => { delete a.flags?.[scope]?.[key]; return a; },
        testUserPermission: () => false,
        update: async (u) => { for (const [k, v] of Object.entries(u)) {
          const path = k.split("."); let o = a;
          for (const s2 of path.slice(0, -1)) o = (o[s2] ??= {});
          o[path[path.length - 1]] = v; } return a; },
        getActiveTokens: () => canvas.tokens.placeables.filter(t => t.actor?.id === id),
      };
      ACTORS.set(id, a);
      made6b.push(a);
      const doc = { id: `tok-${id}`, actorId: id, actor: a, name, x: at[0], y: at[1],
        width: 1, height: 1, elevation: 0, hidden: false, disposition, texture: { src: "" } };
      const tok = { id: `tok-${id}`, name, actor: a, document: doc, x: at[0], y: at[1], w: 100, h: 100,
        center: { x: at[0] + 50, y: at[1] + 50 } };
      doc.object = tok;
      canvas.tokens.placeables.push(tok);
      return a;
    };

    const engine = new ReactionEngine();
    const asked = [];
    let answer = true;
    engine._promptReaction = async (o) => {
      asked.push(o.reactorActor?.name ?? "?");
      return { accepted: answer, choiceData: { slotLevel: o.availableSlots?.[0]?.level ?? 3, consumeSlot: true } };
    };
    // dnd5e's own roller, stood in: the caster's Constitution save.
    let casterSaveTotal = 5;
    const makeCaster = (id, name, opts = {}) => {
      const a = mage(id, name, { disposition: 1, ...opts });
      a.rollSavingThrow = async () => [{ total: casterSaveTotal }];
      return a;
    };
  // A template as dnd5e places one: `flags.dnd5e.origin` is the ACTIVITY's uuid
  // and `flags.dnd5e.item` the item's (AbilityTemplate.fromActivity, 5.3.3).
  const makeTemplate1 = (store, id, activity, item) => {
    const doc = { id, x: 100, y: 100, distance: 20, t: "circle",
      flags: { dnd5e: { origin: activity.uuid, item: item.uuid, spellLevel: 3 } },
      delete: async () => { store.delete(id); doc.deleted = true; return doc; } };
    store.set(id, doc);
    return doc;
  };
    const cast = (caster, item, level = 3) => ({
      item, actor: caster, uuid: `Activity.${item.id}`,
      consumption: { spellSlot: true }, usage: { spellLevel: level },
    });

    // ── 1 + 4 + 5. Who is offered it, and who is named for not being ──
    {
      const caster = makeCaster("p6b-caster", "the caster", { at: [0, 0] });
      const ready    = mage("p6b-ready", "Kasimir Velikov", { items: [csItem("2024")], at: [200, 0] });
      const unprep   = mage("p6b-unprep", "Exethanter", { items: [csItem("2024", { prepared: 0 })], at: [300, 0] });
      const noSlot   = mage("p6b-noslot", "a mage out of slots", { items: [csItem("2014")], slots: { 3: 0 }, at: [300, 100] });
      const stunned  = mage("p6b-stunned", "a stunned mage", { items: [csItem("2014")], statuses: ["stunned"], at: [300, 200] });
      const corpse   = mage("p6b-dead", "a dead mage", { items: [csItem("2014")], statuses: ["dead"], hp: 0, at: [300, 300] });
      const faraway  = mage("p6b-far", "a mage across the hall", { items: [csItem("2014")], at: [2000, 0] });
      const ally     = mage("p6b-ally", "the caster's own wizard", { items: [csItem("2014")], disposition: 1, at: [200, 200] });
      const fireOnly = mage("p6b-fire", "a mage with Fireball only", { items: [other("Fireball")], at: [200, 300] });
      const goblin   = mage("p6b-goblin", "a goblin", { items: [], at: [100, 0] });

      const said = [];
      const keepLog = console.log;
      console.log = (...a) => { said.push(a.join(" ")); };
      let found = [];
      try {
        found = engine._findCounterspellReactors(
          canvas.tokens.placeables.find(t => t.actor?.id === caster.id), caster);
      } finally { console.log = keepLog; }
      const names = found.map(r => r.actor.name);
      const line = said.find(l => /not offered to/.test(l)) ?? "";

      check("1+4+5. only the mage who can actually cast it is offered Counterspell, and everyone who holds it but was passed over is named with the reason (Phase 6b)",
        names.length === 1 && names[0] === "Kasimir Velikov"
          && /Exethanter \(.*not prepared\)/.test(line)
          && /out of slots \(.*no 3rd-level or higher slot/.test(line)
          && /stunned mage \(.*out of the fight/.test(line)
          && /dead mage \(.*out of the fight/.test(line)
          && /across the hall \(.*feet away/.test(line)
          && /own wizard \(.*own side/.test(line),
        `offered to: ${names.join(", ") || "nobody"}; passed over: ${line.replace(/^.*not offered to /, "") || "(nothing said)"}`);

      // A goblin with no Counterspell is not "skipped" - it was never a
      // counterspeller, and one line per token buries the ones that matter.
      check("and a creature that has never heard of Counterspell is not in that list at all (Phase 6b)",
        !/goblin|Fireball only/.test(line), `the log line: ${line || "(nothing said)"}`);

      // ⚠️ AND HIS TABLE RUNS THE OPT-IN ON. With `counterspellAnyCaster`
      // true - which is what hijinx has stored - the caster's own wizard IS
      // offered the shot, because RAW you may counter any cast you can see.
      SETTINGS.set("ace-qol.counterspellAnyCaster", true);
      const withOptIn = engine._findCounterspellReactors(
        canvas.tokens.placeables.find(t => t.actor?.id === caster.id), caster).map(r => r.actor.name);
      SETTINGS.set("ace-qol.counterspellAnyCaster", false);
      check("with his own 'counter any caster' setting on, the ally is offered it too (Phase 6b)",
        withOptIn.length === 2 && withOptIn.includes("the caster's own wizard"),
        `offered to: ${withOptIn.join(", ") || "nobody"}`);

      canvas.tokens.placeables.length = 0;
      for (const a of [caster, ready, unprep, noSlot, stunned, corpse, faraway, ally, fireOnly, goblin]) ACTORS.delete(a.id);
    }

    // ── 2. Yes, on a 2024 copy: the CASTER makes the save ──
    {
      const caster = makeCaster("p6b-c2", "Neferon", { at: [0, 0] });
      const kasimir = mage("p6b-k2", "Kasimir Velikov", { items: [csItem("2024")], at: [200, 0], dc: 17 });
      answer = true;
      casterSaveTotal = 9;                    // fails DC 17 -> countered
      const atCard = cards6b.length, atAsk = asked.length;
      let err = null;
      try { await quiet(() => engine._onSpellCast(cast(caster, other("Fireball")), null)); } catch (e) { err = e; }
      const text = String(cards6b[atCard]?.content ?? "").replace(/<[^>]*>/g, " ");
      check("2. a 2024 Counterspell makes the CASTER roll Constitution against the counterspeller's spell save DC; a failure stops the spell, spends the slot and the reaction, and the card goes through the card door (Phase 6b)",
        !err && asked.length - atAsk === 1
          && kasimir.system.spells.spell3.value === 1
          && kasimir.flags[MOD]?.reactionUsed === true
          && cards6b.length > atCard && /counterspells/i.test(text) && /CON save 9 vs DC 17/.test(text),
        err ? `threw: ${err?.message ?? err}`
          : `asked ${asked.length - atAsk}; Kasimir's slots ${kasimir.system.spells.spell3.value} of 3; `
            + `reaction ${kasimir.flags[MOD]?.reactionUsed ? "spent" : "still free"}; card: ${text.slice(0, 130) || "none"}`);

      // The 2024 book, in his own pack: "If that spell was cast with a spell
      // slot, the slot isn't expended."
      check("and the 2024 book's own clause: the countered caster KEEPS the slot, and the card says so (Phase 6b)",
        caster.system.spells.spell3.value === 3 && /keeps the slot/.test(text),
        `Neferon's level 3 slots: ${caster.system.spells.spell3.value} of 3 (2 were left when he cast); `
          + `the card ${/keeps the slot/.test(text) ? "says so" : "does not mention it"}`);

      canvas.tokens.placeables.length = 0;
      for (const a of [caster, kasimir]) ACTORS.delete(a.id);
    }

    // ── 3. The edition is the ITEM's, with the world set the other way ──
    {
      SETTINGS.set("ace-qol.gameRulesEdition", "2014");
      const caster = makeCaster("p6b-c3", "a caster", { at: [0, 0] });
      // A 2024 copy in a 2014 world: still the caster's Constitution save, and
      // NOT the slot-versus-level auto-success a 2014 copy would have given.
      const modern = mage("p6b-modern", "Morthos", { items: [csItem("2024")], at: [200, 0], dc: 17, ability: "cha" });
      answer = true;
      casterSaveTotal = 25;                   // beats DC 17 -> resisted
      const atCard = cards6b.length;
      let err = null;
      try { await quiet(() => engine._onSpellCast(cast(caster, other("Haste")), null)); } catch (e) { err = e; }
      const text = String(cards6b[atCard]?.content ?? "").replace(/<[^>]*>/g, " ");
      check("3. the edition comes off the ITEM, not the world: a 2024 copy at a 2014 table still asks the caster for a Constitution save instead of auto-succeeding on slot level (Phase 6b)",
        !err && /CON save 25 vs DC 17/.test(text) && /fails/i.test(text) && !/auto-success/.test(text),
        err ? `threw: ${err?.message ?? err}` : `world 2014, item 2024 -> ${text.slice(0, 140) || "(no card)"}`);
      SETTINGS.delete("ace-qol.gameRulesEdition");
      canvas.tokens.placeables.length = 0;
      for (const a of [caster, modern]) ACTORS.delete(a.id);
    }

    // ── 2014: auto when the slot covers it, a check when it does not ──
    {
      const caster = makeCaster("p6b-c4", "a caster", { at: [0, 0], slots: { 3: 2, 7: 1 } });
      const patrina = mage("p6b-patrina", "Patrina Velikovna", { items: [csItem("2014")], at: [200, 0] });
      answer = true;
      const atCard = cards6b.length;
      let err = null;
      try { await quiet(() => engine._onSpellCast(cast(caster, other("Fireball"), 3), null)); } catch (e) { err = e; }
      const auto = String(cards6b[atCard]?.content ?? "").replace(/<[^>]*>/g, " ");
      check("2014, a level 3 slot against a level 3 spell: it simply fails, with no roll at all (Phase 6b)",
        !err && /auto-success/.test(auto) && /counterspells/i.test(auto),
        err ? `threw: ${err?.message ?? err}` : auto.slice(0, 140) || "(no card)");

      // And the 2014 caster does NOT keep the slot: that clause is 2024's alone.
      check("and a countered 2014 caster loses the slot, because that clause is 2024's alone (Phase 6b)",
        caster.system.spells.spell3.value === 2,
        `his level 3 slots: ${caster.system.spells.spell3.value} of 3, untouched by ACE`);

      // A 7th-level spell against a 3rd-level slot: the ability check.
      patrina.flags[MOD].reactionUsed = false;
      patrina.system.spells.spell3.value = 2;
      const atCard2 = cards6b.length;
      try { await quiet(() => engine._onSpellCast(cast(caster, other("Finger of Death"), 7), null)); } catch (e) { err = e; }
      const checked = String(cards6b[atCard2]?.content ?? "").replace(/<[^>]*>/g, " ");
      check("2014, a level 3 slot against a level 7 spell: an ability check against DC 17 (Phase 6b)",
        !err && /check -?\d+ vs DC 17/.test(checked),
        err ? `threw: ${err?.message ?? err}` : checked.slice(0, 140) || "(no card)");

      canvas.tokens.placeables.length = 0;
      for (const a of [caster, patrina]) ACTORS.delete(a.id);
    }

    // ── 3b. No: the spell goes through and nothing is spent ──
    {
      const caster = makeCaster("p6b-c5", "a caster", { at: [0, 0] });
      const kasimir = mage("p6b-k5", "Kasimir Velikov", { items: [csItem("2024")], at: [200, 0] });
      answer = false;
      const atCard = cards6b.length, atAsk = asked.length;
      let err = null;
      try { await quiet(() => engine._onSpellCast(cast(caster, other("Fireball")), null)); } catch (e) { err = e; }
      check("3. a no lets the spell through: asked once, no slot, no reaction, no card (Phase 6b)",
        !err && asked.length - atAsk === 1
          && kasimir.system.spells.spell3.value === 2
          && !kasimir.flags[MOD]?.reactionUsed
          && cards6b.length === atCard,
        err ? `threw: ${err?.message ?? err}`
          : `asked ${asked.length - atAsk}x; slots ${kasimir.system.spells.spell3.value} of 3; `
            + `reaction ${kasimir.flags[MOD]?.reactionUsed ? "spent" : "still free"}; cards ${cards6b.length - atCard}`);
      canvas.tokens.placeables.length = 0;
      for (const a of [caster, kasimir]) ACTORS.delete(a.id);
    }

    // ── THE TABLE BUG: a countered spell must not go off ──
    // Johnny, 2026-09-17, on both editions: "card says auto-success, Fireball
    // dissolves. Template + Dex save card + ROLL DAMAGE still happened."
    // Fireball is a shape the pipeline OWNS but deliberately does not resolve -
    // the save engine rolls its saves and its damage - and the save engine was
    // the one engine in the suite that never asked the barrier. This drives the
    // real `_onTemplateCreated` with a real barrier.
    {
      const caster = makeCaster("p6b-c7", "Neferon", { at: [0, 0] });
      const kasimir = mage("p6b-k7", "Kasimir Velikov", { items: [csItem("2024")], at: [200, 0], dc: 17 });
      const victim = mage("p6b-victim", "somebody standing in it", { items: [], at: [100, 100], disposition: 1 });
      const fireball = other("Fireball");
      const activity = cast(caster, fireball);
      activity.uuid = "Actor.p6b-c7.Item.it-Fireball.Activity.aaa";

      // The area dnd5e places: its `flags.dnd5e.origin` is the activity's uuid
      // and `flags.dnd5e.item` the item's, which is what lets a door holding
      // only a template ask the same question as a door holding the cast.
      const templates = new Map();
      const makeTemplate = (id) => {
        const doc = { id, x: 100, y: 100, distance: 20, t: "circle",
          flags: { dnd5e: { origin: activity.uuid, item: fireball.uuid ?? "Actor.p6b-c7.Item.it-Fireball", spellLevel: 3 } },
          delete: async () => { templates.delete(id); doc.deleted = true; return doc; } };
        templates.set(id, doc);
        return doc;
      };
      const keepScene = canvas.scene;
      const keepTargets = game.user.targets;
      game.user.targets = new Set();
      canvas.scene = { templates: { get: (id) => templates.get(id) ?? null,
        contents: [], [Symbol.iterator]: function* () { yield* templates.values(); } } };

      // A barrier, exactly as preUseActivity raises one.
      ReactionEngine._createCastBarrier(activity);

      // ⚠️ AN INSTANCE, NOT THE CLASS: `_onTemplateCreated` is an instance
      // method and the constructor registers hooks, which a self-test must not
      // do. `Object.create` gives the real prototype with none of the wiring.
      const saves = Object.create(SaveEngine.prototype);
      const pending = { activity, item: fireball, actor: caster, saveAbility: "dex", saveDC: 15,
        halfOnSave: true, damageTypes: ["fire"], isSpell: true, timing: null,
        activityId: activity.id ?? "aaa", spellLevel: 3, recipe: null };

      // The template lands, and the save engine picks it up 100ms later - while
      // the counterspell prompt is still open. It must WAIT, not post and tidy up
      // afterwards: a card that is already on the table has already been read.
      const tpl = makeTemplate("tpl-countered");
      saves._pendingSaveSpell = pending;
      const atCard = posted.length;
      let finished = false;
      const running = quiet(() => saves._onTemplateCreated(tpl).then(() => { finished = true; }));
      await new Promise(r => setTimeout(r, 30));
      const waitedFirst = !finished && posted.length === atCard && !tpl.deleted;

      // Now the counter lands.
      answer = true;
      casterSaveTotal = 9;                   // fails DC 17 -> countered
      await quiet(() => engine._onSpellCast(activity, null));
      await running;

      check("THE TABLE BUG: a countered Fireball posts NO save card and its area comes off the map, and the save engine WAITED for the verdict instead of posting first (2026-09-17)",
        waitedFirst && finished && posted.length === atCard && tpl.deleted === true && !templates.has("tpl-countered"),
        `while the prompt was open: ${waitedFirst ? "nothing posted, nothing placed" : "it went ahead anyway"}; `
          + `after the counter: ${posted.length - atCard} save card(s), the area ${tpl.deleted ? "was removed" : "is still on the map"}`);

      // And the other way round: a cast nobody counters still resolves.
      kasimir.flags[MOD].reactionUsed = false;
      kasimir.system.spells.spell3.value = 2;
      const activity2 = cast(caster, fireball);
      activity2.uuid = "Actor.p6b-c7.Item.it-Fireball.Activity.bbb";
      ReactionEngine._createCastBarrier(activity2);
      const tpl2 = makeTemplate("tpl-allowed");
      tpl2.flags.dnd5e.origin = activity2.uuid;
      saves._pendingSaveSpell = { ...pending, activity: activity2 };
      answer = false;                        // Kasimir lets it go
      const running2 = quiet(() => saves._onTemplateCreated(tpl2));
      await quiet(() => engine._onSpellCast(activity2, null));
      await running2;
      check("and a Fireball nobody counters still gets its area read and is not deleted (2026-09-17)",
        tpl2.deleted !== true && templates.has("tpl-allowed"),
        `the area ${tpl2.deleted ? "was wrongly removed" : "is still on the map, as it should be"}`);

      saves._pendingSaveSpell = null;
      canvas.scene = keepScene;
      game.user.targets = keepTargets;
      canvas.tokens.placeables.length = 0;
      for (const a of [caster, kasimir, victim]) ACTORS.delete(a.id);
    }

    // ── HIS SECOND REPORT: held is not killed ──
    // Johnny, 2026-09-17: "Kasimir countered Neferon's Fireball. Card said
    // success. The template STILL appeared and I placed it. No save card then.
    // After I waited and advanced the turn, the Dex saves finally posted. You
    // held the spell. You did not kill it."
    //
    // Two causes, both proven from dnd5e 5.3.3's own source. `Activity#use`
    // creates the usage message, fires the hook ACE answers on, and goes
    // STRAIGHT to `_finalizeUsage`, which places the template without waiting
    // for anybody - so the crosshair appears while the Counterspell prompt is
    // still open. And a save armed and waiting for an area is a save that goes
    // off whenever that area turns up, however much later that is.
    {
      const caster = makeCaster("p6b-c8", "Neferon", { at: [0, 0] });
      const kasimir = mage("p6b-k8", "Kasimir Velikov", { items: [csItem("2024")], at: [200, 0], dc: 17 });
      const fireball = other("Fireball");
      fireball.uuid = "Actor.p6b-c8.Item.it-Fireball";
      fireball.actor = caster;
      const activity = cast(caster, fireball);
      activity.uuid = "Actor.p6b-c8.Item.it-Fireball.Activity.ccc";

      const templates = new Map();
      const keepScene = canvas.scene;
      const keepTargets = game.user.targets;
      game.user.targets = new Set();
      canvas.scene = {
        templates: { get: (id) => templates.get(id) ?? null, contents: [],
          [Symbol.iterator]: function* () { yield* templates.values(); } },
        deleteEmbeddedDocuments: async (_type, ids) => { for (const id of ids) templates.delete(id); return ids; },
      };

      // The save engine has armed a save and is waiting for the area, exactly as
      // it is the instant before the crosshair appears.
      const saves = Object.create(SaveEngine.prototype);
      saves._pendingSaveSpell = { activity, item: fireball, actor: caster, saveAbility: "dex",
        saveDC: 15, halfOnSave: true, damageTypes: ["fire"], isSpell: true, timing: null,
        activityId: "ccc", spellLevel: 3, recipe: null };
      ReactionEngine._createCastBarrier(activity);
      answer = true;
      casterSaveTotal = 9;                     // fails DC 17 -> countered
      const atCard = posted.length;
      await quiet(() => engine._onSpellCast(activity, null));

      // The save engine's own listener does exactly this, with `this`.
      await quiet(() => SaveEngine.dropCounterspelledCast({
        activity, item: fireball, casterActor: caster,
        activityUuid: activity.uuid, itemUuid: fireball.uuid,
        actorId: caster.id, itemId: fireball.id,
      }, saves));

      check("HELD IS NOT KILLED: the instant the counter succeeds, the save waiting for Fireball's area is thrown away rather than held (2026-09-17)",
        saves._pendingSaveSpell === null,
        `what the save engine is still holding: ${saves._pendingSaveSpell ? `a ${saves._pendingSaveSpell.saveAbility?.toUpperCase()} save for ${saves._pendingSaveSpell.item?.name}` : "nothing"}`);

      // dnd5e asks before it builds a template; a dead cast gets no crosshair.
      const veto = (hooks["dnd5e.preCreateActivityTemplate"] ?? []).map(fn => fn(activity, {}));
      check("and dnd5e is told not to place an area for it at all, so there is no crosshair to drag (2026-09-17)",
        veto.length > 0 && veto.every(v => v === false),
        veto.length ? `the template hook answered ${veto.join(", ")}` : "nothing is listening for the template hook");

      // A minute later - a turn advanced, a template finally dragged out - it is
      // still dead. Thirty seconds was an amnesty, not a window.
      const late = makeTemplate1(templates, "tpl-late", activity, fireball);
      saves._pendingSaveSpell = { activity, item: fireball, actor: caster, saveAbility: "dex",
        saveDC: 15, halfOnSave: true, damageTypes: ["fire"], isSpell: true, timing: null,
        activityId: "ccc", spellLevel: 3, recipe: null };
      ReactionEngine._castBarriers.clear();     // as the 30s safety net leaves it
      const atCard2 = posted.length;
      await quiet(() => saves._onTemplateCreated(late));
      check("and it is still dead long after, with the barrier gone: no save card, and the area is removed (2026-09-17)",
        posted.length === atCard2 && late.deleted === true,
        `save cards after the barrier expired: ${posted.length - atCard2}; the area ${late.deleted ? "was removed" : "is still on the map"}`);

      check("the counter's own card is the only thing posted by the whole business (2026-09-17)",
        posted.length === atCard,
        `${posted.length - atCard} card(s) went to chat outside the reaction's own door`);

      game.user.targets = keepTargets;
      canvas.scene = keepScene;
      canvas.tokens.placeables.length = 0;
      for (const a of [caster, kasimir]) ACTORS.delete(a.id);
    }

    // ── HIS CONSOLE: the barrier said "go ahead" AFTER the counter landed ──
    // Johnny, 2026-09-17, from the log of a Fireball that was counterspelled and
    // resolved anyway:
    //
    //   save-engine: "Fireball goes ahead (not countered); its area is read and
    //   its card posted as normal."
    //
    // "not countered" is only printed when a barrier was FOUND and had settled
    // with abort:false. A barrier can be settled by any of half a dozen early
    // exits - no reactors, not a spell, no token, or a SECOND firing of dnd5e's
    // usage-message hook finding the counterspeller's reaction already spent -
    // and a counter landing afterwards cannot re-settle a promise. So the
    // kill-list, not the barrier, has to be the authority.
    {
      const caster = makeCaster("p6b-c9", "Neferon", { at: [0, 0] });
      const kasimir = mage("p6b-k9", "Kasimir Velikov", { items: [csItem("2024")], at: [200, 0], dc: 17 });
      const fireball = other("Fireball");
      fireball.uuid = "Actor.p6b-c9.Item.it-Fireball";
      fireball.actor = caster;
      const activity = cast(caster, fireball);
      activity.uuid = "Actor.p6b-c9.Item.it-Fireball.Activity.ddd";

      // The barrier settles "go ahead" first, exactly as a second firing of the
      // hook would settle it while the first is still waiting for an answer.
      ReactionEngine._createCastBarrier(activity);
      ReactionEngine._resolveCastBarrier(activity, { abort: false, reason: "no_reactors_available" });

      // Then the counter lands and is recorded.
      ReactionEngine._markCastCounterspelled(activity);

      const verdict = await ReactionEngine.awaitCastDecision(activity.uuid,
        { item: fireball, actor: caster });
      check("HIS CONSOLE: a barrier already settled as \"go ahead\" does not outrank a counter that lands afterwards (2026-09-17)",
        verdict?.abort === true,
        `the barrier said go ahead, then Kasimir countered → the door decides: ${verdict?.abort ? "dead" : `alive (${verdict?.reason})`}`);

      // And the same question asked with only the template's origin, which is
      // what the save engine actually holds.
      const byOrigin = await ReactionEngine.awaitCastDecision(activity.uuid);
      check("and the same answer when all the door has is the template's origin (2026-09-17)",
        byOrigin?.abort === true,
        `by origin alone: ${byOrigin?.abort ? "dead" : `alive (${byOrigin?.reason})`}`);

      // ⚠️ HIS NEXT FIREBALL. There is no identifier that separates it from the
      // one that was countered - same item, same activity, same uuid - so the
      // thing that saves it is the cast STARTING, which clears the old record.
      // This pin does what a real cast does: it raises its barrier first.
      const second = cast(caster, fireball);
      second.uuid = activity.uuid;                    // a re-cast really is the same uuid
      ReactionEngine._createCastBarrier(second);
      // ⚠️ ITS OWN CHECK ANSWERS IT, as at the table: nobody counters it. This
      // used to wait on a hold nobody answered, and passed only when the
      // 30-second safety let it go - thirty of the replay's forty-eight seconds,
      // and a pass that proved the timeout instead of the record. The old
      // record is still what is tested: had starting this cast not cleared it,
      // the answer below is "dead" before the hold is even looked at.
      ReactionEngine._resolveCastBarrier(second, { abort: false, reason: "no_counter" });
      const nextCast = await ReactionEngine.awaitCastDecision(second.uuid,
        { item: fireball, actor: caster });
      check("and the same wizard's NEXT Fireball is alive, because starting a cast clears the last one's record (2026-09-17)",
        nextCast?.abort === false,
        `a second cast of the same spell by the same caster: ${nextCast?.abort ? "wrongly dead" : "alive, as it must be"}`);
      ReactionEngine._markCastCounterspelled(activity);   // put the record back for what follows

      // A door with NO origin to offer - the flourish, a save being armed -
      // still answers from who cast what.
      const noOrigin = await ReactionEngine.awaitCastDecision(null, { item: fireball, actor: caster });
      check("a door with no uuid to offer still answers from who cast what (2026-09-17)",
        noOrigin?.abort === true,
        `asked with only the caster and the spell: ${noOrigin?.abort ? "dead" : "alive"}`);

      canvas.tokens.placeables.length = 0;
      for (const a of [caster, kasimir]) ACTORS.delete(a.id);
    }

    // ── One Counterspell check per cast ──
    // dnd5e can fire its usage-message hook more than once for a single use;
    // the spell pipeline has guarded against that for months and this handler
    // had nothing. Two prompts for one cast is a bug on its own, and the second
    // firing settling the barrier is what produced the line above.
    {
      const caster = makeCaster("p6b-c10", "a caster", { at: [0, 0] });
      const kasimir = mage("p6b-k10", "Kasimir Velikov", { items: [csItem("2024")], at: [200, 0] });
      const fireball = other("Fireball");
      fireball.uuid = "Actor.p6b-c10.Item.it-Fireball";
      const activity = cast(caster, fireball);
      activity.uuid = "Actor.p6b-c10.Item.it-Fireball.Activity.eee";
      // Every listener on the hook, not the first one registered: the spell
      // pipeline listens on the same hook and gets there first.
      const listeners = hooks["dnd5e.postCreateUsageMessage"] ?? [];
      const handler = listeners.length
        ? (async (a, m) => { for (const fn of listeners) await fn(a, m); })
        : null;
      answer = false;                        // let it through, so both firings would ask
      // Count how many times the hook lets a cast through to the check itself,
      // rather than how many prompts come out the far end: the prompt depends on
      // half a dozen things this pin is not about, and the guard is right here.
      const keepCheck = ReactionEngine.prototype._onSpellCast;
      let entered = 0;
      ReactionEngine.prototype._onSpellCast = async function (act) {
        entered += 1;
        ReactionEngine._resolveCastBarrier(act, { abort: false, reason: "stood in" });
      };
      try {
        if (handler) {
          await quiet(() => handler(activity, null));
          await quiet(() => handler(activity, null));
        }
      } finally { ReactionEngine.prototype._onSpellCast = keepCheck; }
      check("dnd5e firing its usage hook twice for one cast runs the Counterspell check ONCE (2026-09-17)",
        !!handler && entered === 1,
        handler ? `the check ran ${entered} time(s) across two firings of the same use`
          : "the usage hook has no listener in this run");
      canvas.tokens.placeables.length = 0;
      for (const a of [caster, kasimir]) ACTORS.delete(a.id);
    }

    // ── A HOLD WITH NO BOX (his table, 2026-09-18) ──
    // "11:08:42 first Magic Missile. Log: holding, Counterspell prompt open. NO
    // Rendering Dialog. No box on screen. 11:08:51 second press. Same. 11:09:04
    // third press. THEN Rendering Dialog." The check above remembered the
    // SPELL for a minute, not the cast, so a cast within a minute of the last
    // was never checked; and the hold was keyed the same way, so a cast within
    // thirty seconds inherited the last one's. Both are cast-by-cast now.
    {
      const caster = makeCaster("p6b-c11", "Neferon", { at: [0, 0] });
      const mmItem = other("Magic Missile");
      mmItem.uuid = "Actor.p6b-c11.Item.it-mm11";
      // dnd5e hands every cast its own copy of the activity, all sharing one uuid.
      const castOf = () => { const a = cast(caster, mmItem, 1); a.uuid = "Actor.p6b-c11.Item.it-mm11.Activity.mm"; return a; };
      const listeners = hooks["dnd5e.postCreateUsageMessage"] ?? [];
      const handler = listeners.length ? (async (a, m) => { for (const fn of listeners) await fn(a, m); }) : null;
      const keepCheck = ReactionEngine.prototype._onSpellCast;
      let entered = 0;
      ReactionEngine.prototype._onSpellCast = async function (act) {
        entered += 1;
        ReactionEngine._resolveCastBarrier(act, { abort: false, reason: "stood in" });
      };
      const pendingAfter = async (p, ms) => Promise.race([p.then(() => "settled"), new Promise(r => setTimeout(() => r("pending"), ms))]);
      // The holds made here would otherwise keep their 30-second safety timers
      // running long after the last check, and the replay with them.
      const keepSafety11 = ReactionEngine.barrierSafetyMs;
      ReactionEngine.barrierSafetyMs = 400;
      let second = "?", err11 = null;
      try {
        if (!handler) throw new Error("the usage hook has no listener in this run");
        const first = castOf();
        ReactionEngine._createCastBarrier(first);            // what preUseActivity does
        await quiet(() => handler(first, null));
        const next = castOf();
        ReactionEngine._createCastBarrier(next);
        // Before its own check runs, the new cast must be holding for ITS answer,
        // not handed the last cast's answer ready-made.
        second = await pendingAfter(ReactionEngine.awaitCastBarrier(next), 30);
        await quiet(() => handler(next, null));
      } catch (e) { err11 = e; }
      finally { ReactionEngine.prototype._onSpellCast = keepCheck; }
      check("two casts of the same Magic Missile, one after the other, are EACH checked for Counterspell: the second is not taken for a repeat of the first (2026-09-18)",
        !err11 && entered === 2,
        err11 ? `threw: ${err11?.message ?? err11}` : `the check ran ${entered} time(s) for two separate casts`);
      check("and the second cast holds for its own answer instead of inheriting the first cast's (2026-09-18)",
        !err11 && second === "pending",
        err11 ? `threw: ${err11?.message ?? err11}` : `the second cast's hold before its check: ${second}`);

      // A throw inside the check releases the hold, and says why.
      const said11 = [];
      const keepWarn = console.warn;
      let thrown = null;
      const boom = castOf();
      ReactionEngine._createCastBarrier(boom);
      const keepInner = engine._counterspellCheck;
      engine._counterspellCheck = async () => { throw new Error("stood-in failure"); };
      console.warn = (...a) => { said11.push(a.map(String).join(" ")); };
      try { await engine._onSpellCast(boom, null); } catch (e) { thrown = e; }
      finally { console.warn = keepWarn; engine._counterspellCheck = keepInner; }
      const afterBoom = await pendingAfter(ReactionEngine.awaitCastBarrier(boom), 30);
      check("if the Counterspell check itself fails, the hold is released at once and the console says why: no ghost lock (2026-09-18)",
        !thrown && afterBoom === "settled" && said11.some(l => /Counterspell check for Magic Missile failed/.test(l)),
        `hold after the failure: ${afterBoom}; the console: ${said11.join(" | ").slice(0, 160) || "nothing"}`);

      // A hold nothing releases lets go by itself, and never another cast's.
      const keepSafety = ReactionEngine.barrierSafetyMs;
      ReactionEngine.barrierSafetyMs = 200;
      const old = castOf();
      ReactionEngine._createCastBarrier(old);
      ReactionEngine._resolveCastBarrier(old, { abort: false, reason: "answered" });
      await new Promise(r => setTimeout(r, 100));
      const fresh = castOf();
      ReactionEngine._createCastBarrier(fresh);
      const freshHold = ReactionEngine._castBarriers.get(ReactionEngine._activityKey(fresh));
      await new Promise(r => setTimeout(r, 150));          // the old cast's timer has now fired
      const survived = ReactionEngine._castBarriers.get(ReactionEngine._activityKey(fresh)) === freshHold && !freshHold?.resolved;
      const saidT = [];
      console.warn = (...a) => { saidT.push(a.map(String).join(" ")); };
      await new Promise(r => setTimeout(r, 130));          // and now the new cast's own
      console.warn = keepWarn;
      ReactionEngine.barrierSafetyMs = keepSafety;
      check("an old cast's timer never releases or removes a newer cast's hold, and a hold nothing released lets go by itself and says so (2026-09-18)",
        survived && freshHold?.resolved === true && saidT.some(l => /hold on Magic Missile was never released/.test(l)),
        `the new hold survived the old timer: ${survived}; released by its own: ${freshHold?.resolved === true}; `
          + `the console: ${saidT.join(" | ").slice(0, 120) || "nothing"}`);
      canvas.tokens.placeables.length = 0;
      for (const a of [caster]) ACTORS.delete(a.id);
      ReactionEngine.barrierSafetyMs = keepSafety11;
    }

    // ── A BOX MUST BE SEEN TO OPEN (his rule, 2026-09-18) ──
    // "If the box fails to open, clear holding and run the missile. Log why."
    {
      const keepAck = ReactionEngine.remoteAckMs;
      const keepSock = game.socket;
      const keepUsers = game.users;
      const keepShow = ReactionEngine.showReactionDialog;
      const TOM = { id: "p6b-tom", isGM: false, name: "Kasimir's player", active: true };
      game.users = Object.assign([GM, TOM], { activeGM: GM, get: (id) => [GM, TOM].find(u => u.id === id) ?? null });
      const sent = [];
      game.socket = { emit: (_n, d) => { sent.push(d); }, on: () => {} };
      ReactionEngine.remoteAckMs = 50;
      const kas = mage("p6b-kas12", "Kasimir Velikov", { items: [csItem("2024")], at: [200, 0] });
      kas.testUserPermission = (u) => u?.id === TOM.id;
      const said12 = [];
      const keepWarn = console.warn;
      console.warn = (...a) => { said12.push(a.map(String).join(" ")); };
      let silent = null, answered = null, local = null, err12 = null;
      try {
        // Sent to a player's screen, and their client never says it opened.
        silent = await engine._promptRemote({ title: "Counterspell", reactorActor: kas }, TOM.id);
        // Sent again, and this time their client says it is up: it waits for the click.
        const asking = engine._promptRemote({ title: "Counterspell", reactorActor: kas }, TOM.id);
        const req = sent.filter(d => d?.action === "showReactionPrompt").at(-1)?.requestId;
        await engine.handleSocketMessage({ action: "reactionPromptShown", requestId: req, senderUserId: TOM.id });
        const stillWaiting = await Promise.race([asking.then(() => "settled"), new Promise(r => setTimeout(() => r("waiting"), 90))]);
        await engine.handleSocketMessage({ action: "reactionResponse", requestId: req, accepted: true,
          choiceData: { slotLevel: 3 }, senderUserId: TOM.id, reactorActorId: kas.id });
        answered = { stillWaiting, result: await asking };
        // On this screen, a box that is never drawn counts as a no too.
        ReactionEngine.showReactionDialog = () => new Promise(() => {});
        local = await engine._promptLocal({ title: "Counterspell", reactorActor: kas });
      } catch (e) { err12 = e; }
      finally {
        console.warn = keepWarn;
        ReactionEngine.showReactionDialog = keepShow;
        ReactionEngine.remoteAckMs = keepAck;
        game.socket = keepSock;
        game.users = keepUsers;
        ACTORS.delete(kas.id);
        canvas.tokens.placeables.length = 0;
      }
      check("a box sent to a player's screen that never opens there counts as a no, and the console names whose screen it never reached (2026-09-18)",
        !err12 && silent?.accepted === false && said12.some(l => /never appeared on Kasimir's player's screen/.test(l)),
        err12 ? `threw: ${err12?.message ?? err12}`
          : `answer: ${silent?.accepted === false ? "no" : JSON.stringify(silent)}; the console: ${said12.filter(l => /never appeared/.test(l)).join(" | ").slice(0, 140) || "nothing"}`);
      check("a box the player's client says is up waits for the click, however long it takes (2026-09-18)",
        !err12 && answered?.stillWaiting === "waiting" && answered?.result?.accepted === true,
        err12 ? `threw: ${err12?.message ?? err12}`
          : `after it said it was up: ${answered?.stillWaiting}; the answer: ${answered?.result?.accepted ? "yes" : "no"}`);
      check("and a box on this screen that is never drawn counts as a no that says so (2026-09-18)",
        !err12 && local?.accepted === false && said12.some(l => /never appeared on this screen/.test(l)),
        err12 ? `threw: ${err12?.message ?? err12}` : `answer: ${local?.accepted === false ? "no" : JSON.stringify(local)}`);
    }

    // ── The crash, and the crosshair that beat the answer ──
    // Johnny, 2026-09-17: "reaction-engine.mjs:1887 TypeError message.setFlag
    // is not a function. Do not assume ChatMessage." And: "CAST flourish and
    // template preview run BEFORE the Counterspell answer."
    {
      const data = { by: "Kasimir", byActorId: "x", spellName: "Fireball", spellLevel: 3 };

      // Four shapes this argument actually arrives in.
      const real = { id: "m1", flags: {}, setFlag: async function (s2, k, v) { (this.flags[s2] ??= {})[k] = v; return this; } };
      const older = { id: "m2", flags: {}, update: async function (u) { for (const [k, v] of Object.entries(u)) this.flags.counterspelled = v; return this; } };
      const plain = { id: "m3", content: "just data, no methods" };
      let err = null, results = [];
      try {
        results = [
          await ReactionEngine._flagMessageCounterspelled(real, data),
          await ReactionEngine._flagMessageCounterspelled(older, data),
          await quiet(() => ReactionEngine._flagMessageCounterspelled(plain, data)),
          await ReactionEngine._flagMessageCounterspelled(null, data),
        ];
      } catch (e) { err = e; }
      check("the counterspelled flag never assumes what a chat card is: a document, an older one with only update, a plain object and nothing at all (2026-09-17)",
        !err && results[0] === true && results[1] === true && results[2] === false && results[3] === false
          && real.flags[MOD]?.counterspelled?.spellName === "Fireball",
        err ? `threw: ${err?.message ?? err}`
          : `setFlag: ${results[0]}; update only: ${results[1]}; a plain object: ${results[2]} (and it said why); nothing: ${results[3]}`);
    }

    {
      const caster = makeCaster("p6b-c11", "Neferon", { at: [0, 0] });
      const kasimir = mage("p6b-k11", "Kasimir Velikov", { items: [csItem("2024")], at: [200, 0], dc: 17 });
      const fireball = other("Fireball");
      fireball.uuid = "Actor.p6b-c11.Item.it-Fireball";
      const veto = hooks["dnd5e.preCreateActivityTemplate"] ?? [];

      // ⚠️🔴 ACE DOES NOT PLACE TEMPLATES, AND MUST NEVER TRY AGAIN. 0.34.40
      // refused the crosshair while the Counterspell prompt was open and drew
      // the area itself afterwards. It broke Fireball outright at his table
      // inside the hour - "AbilityTemplate.fromActivity is not a function or its
      // return value is not iterable" - because placement is dnd5e's job and
      // ACE reached around it. Build ON, never BESIDE. These pins hold the line:
      // the ONLY thing the template hook may ever refuse is a cast that is
      // already dead.

      // Nobody can counter: the crosshair appears, untouched.
      const quiet1 = cast(caster, fireball);
      quiet1.uuid = "Actor.p6b-c11.Item.it-Fireball.Activity.fff";
      ReactionEngine._createCastBarrier(quiet1);
      ReactionEngine._resolveCastBarrier(quiet1, { abort: false, reason: "no_reactors_available" });
      const ordinary = veto.map(fn => fn(quiet1, {}));
      check("nobody can counter: dnd5e places the area exactly as it always has (2026-09-17)",
        ordinary.length > 0 && ordinary.every(v => v !== false),
        `the template hook answered ${ordinary.join(", ") || "(nothing listening)"}`);

      // The prompt is OPEN and undecided: still dnd5e's crosshair. ACE waits at
      // the doors that matter instead, and deletes the area if the answer is yes.
      const open = cast(caster, fireball);
      open.uuid = "Actor.p6b-c11.Item.it-Fireball.Activity.ggg";
      ReactionEngine._createCastBarrier(open);
      const whileOpen = veto.map(fn => fn(open, {}));
      check("the prompt is still open: the crosshair is dnd5e's and ACE does not touch it (2026-09-17)",
        whileOpen.length > 0 && whileOpen.every(v => v !== false),
        `the template hook answered ${whileOpen.join(", ")}`);

      // Declined: nothing about the cast changes.
      ReactionEngine._resolveCastBarrier(open, { abort: false, reason: "no_counter" });
      const declined = veto.map(fn => fn(open, {}));
      check("a Counterspell declined: the area places, and the saves and damage follow (2026-09-17)",
        declined.every(v => v !== false),
        `the template hook answered ${declined.join(", ")}`);

      // Countered: the ONE case ACE refuses, and the only one it ever may.
      const dead = cast(caster, fireball);
      dead.uuid = "Actor.p6b-c11.Item.it-Fireball.Activity.hhh";
      ReactionEngine._markCastCounterspelled(dead);
      const refused = await quiet(() => Promise.resolve(veto.map(fn => fn(dead, {}))));
      check("a Counterspell answered YES: that one area is refused, and nothing else is (2026-09-17)",
        refused.some(v => v === false),
        `the template hook answered ${refused.join(", ")}`);

      // And the source itself: no call into dnd5e's placer anywhere in ACE.
      const src = readFileSync(`${ROOT}/Data/modules/ace-qol/scripts/reaction-engine.mjs`, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
      check("and ACE calls nothing of dnd5e's own template placer, anywhere (2026-09-17)",
        !/fromActivity|drawPreview|AbilityTemplate/.test(src),
        `mentions left in the code: ${(src.match(/fromActivity|drawPreview|AbilityTemplate/g) ?? []).join(", ") || "none"}`);

      canvas.tokens.placeables.length = 0;
      for (const a of [caster, kasimir]) ACTORS.delete(a.id);
    }

    // ── "Yes = no boom" ──
    // Johnny's log, 2026-09-17: "CAST hook FLOURISH on Neferon immediately, then
    // Fireball is dead, then postUseActivity waits for a template AGAIN, then
    // Sequencer still has something to play." Three separate leaks out of one
    // dead cast: ACE's own flourish fired at the cast-click, the save engine
    // armed a SECOND save when dnd5e fired its usage hook again, and a clip that
    // started after the counter played out in full.
    {
      const caster = makeCaster("p6b-c12", "Neferon", { at: [0, 0] });
      const fireball = other("Fireball");
      fireball.uuid = "Actor.p6b-c12.Item.it-Fireball";
      fireball.actor = caster;
      const activity = cast(caster, fireball);
      activity.uuid = "Actor.p6b-c12.Item.it-Fireball.Activity.iii";

      const { AceFX } = await import(`${MODULE}/scripts/ace-fx.mjs`);

      // Alive: it plays.
      ReactionEngine._createCastBarrier(activity);
      ReactionEngine._resolveCastBarrier(activity, { abort: false, reason: "no_reactors_available" });
      const alivePlays = !(await quiet(() => AceFX._castWasStopped(activity, fireball, caster)));

      // Dead: it does not.
      const deadCast = cast(caster, fireball);
      deadCast.uuid = "Actor.p6b-c12.Item.it-Fireball.Activity.jjj";
      ReactionEngine._markCastCounterspelled(deadCast);
      const deadSilent = await quiet(() => AceFX._castWasStopped(deadCast, fireball, caster));
      check("YES = NO BOOM: ACE's own flourish asks first, plays for a cast that lived and nothing at all for one that did not (2026-09-17)",
        alivePlays === true && deadSilent === true,
        `a cast nobody countered: ${alivePlays ? "plays" : "silent (wrong)"}; a countered one: ${deadSilent ? "silent" : "still plays (wrong)"}`);

      // A clip that starts AFTER the counter is cut at birth, whatever it is.
      const born = hooks["createSequencerEffect"] ?? [];
      let killed = 0;
      const fx = { id: "fx-late", endEffect: () => { killed += 1; },
        data: { origin: fireball.uuid, file: "jb2a.fireball.explosion.orange", source: "Scene.s.Token.t" } };
      await quiet(() => Promise.resolve(born.map(fn => fn(fx))));
      check("and a clip that starts after the counter is cut at birth, whatever its file is called (2026-09-17)",
        killed >= 1,
        `a fireball explosion tagged with the dead cast's item: ${killed ? "cut" : "left playing"}`);

      // One that belongs to a different cast is left alone.
      let otherKilled = 0;
      const innocent = { id: "fx-other", endEffect: () => { otherKilled += 1; },
        data: { origin: "Actor.zzz.Item.qqq", file: "jb2a.fireball.explosion.orange", source: "Scene.s.Token.u" } };
      await quiet(() => Promise.resolve(born.map(fn => fn(innocent))));
      check("a clip belonging to somebody else's spell is left alone (2026-09-17)",
        otherKilled === 0,
        `somebody else's explosion: ${otherKilled ? "wrongly cut" : "left playing, as it should be"}`);

      canvas.tokens.placeables.length = 0;
      ACTORS.delete(caster.id);
    }

    // ── "Yes means the mouse is not a Fireball" ──
    // Johnny, 2026-09-17: "dnd5e starts the Fireball preview WHILE the
    // Counterspell prompt is open. After Yes the mouse can still drop a
    // template. save-engine._onTemplateCreated then runs _pendingFromTemplate
    // and logs 'cast happened on another client' because pending was already
    // cleared by the kill. That rebuild is forbidden on a dead cast."
    {
      const caster = makeCaster("p6b-c13", "Neferon", { at: [0, 0] });
      const fireball = other("Fireball");
      fireball.uuid = "Actor.p6b-c13.Item.it-Fireball";
      fireball.actor = caster;
      const activity = cast(caster, fireball);
      activity.uuid = "Actor.p6b-c13.Item.it-Fireball.Activity.kkk";

      // dnd5e's preview, as it sits on the cursor: its own object, its own
      // cancel handler. ACE only ever calls that handler - it never creates one.
      let cancelled = 0;
      const preview = { _onCancelPlacement: async () => { cancelled += 1; } };
      const notOurs = { refresh: () => {} };            // something else on the layer
      const keepCanvasTemplates = canvas.templates;
      canvas.templates = { preview: { children: [preview, notOurs] } };

      const taken = await quiet(() => ReactionEngine.cancelTemplatePreview("a pin"));
      check("YES MEANS THE MOUSE IS NOT A FIREBALL: ACE cancels dnd5e's live preview through its own handler, and leaves anything else on the layer alone (2026-09-17)",
        taken === 1 && cancelled === 1,
        `previews cancelled: ${cancelled}; other things on the layer touched: ${taken - cancelled}`);

      // And nothing throws when there is no preview, or no canvas at all.
      canvas.templates = { preview: { children: [] } };
      const none = await quiet(() => ReactionEngine.cancelTemplatePreview("a pin"));
      check("and it is a quiet no-op when the cursor is empty (2026-09-17)",
        none === 0, `cancelled ${none}`);

      // The door: a template that belongs to a dead cast is turned away BEFORE
      // anything is rebuilt from it.
      canvas.templates = keepCanvasTemplates;
      const templates = new Map();
      const keepScene = canvas.scene;
      canvas.scene = { templates: { get: (id) => templates.get(id) ?? null, contents: [],
        [Symbol.iterator]: function* () { yield* templates.values(); } } };
      const tpl = makeTemplate1(templates, "tpl-dead-origin", activity, fireball);
      ReactionEngine._markCastCounterspelled(activity);

      const saves = Object.create(SaveEngine.prototype);
      saves._pendingSaveSpell = null;          // exactly as the kill left it
      let rebuilt = 0;
      saves._pendingFromTemplate = () => { rebuilt += 1; return null; };
      const atCard = posted.length;
      await quiet(() => saves._onTemplateCreated(tpl));
      check("a dropped area from a dead cast is turned away at the door: no rebuild, no save card, and it comes off the map (2026-09-17)",
        rebuilt === 0 && posted.length === atCard && tpl.deleted === true,
        `rebuilds attempted: ${rebuilt}; cards: ${posted.length - atCard}; the area ${tpl.deleted ? "was removed" : "is still there"}`);

      // A live cast still rebuilds from the template, which is what that path
      // is FOR: two GMs, the cast on one client and the area on the other.
      const live = cast(caster, fireball);
      live.uuid = "Actor.p6b-c13.Item.it-Fireball.Activity.lll";
      // A real cast raises its barrier on the way in, and that is what clears
      // the previous cast's death record.
      ReactionEngine._createCastBarrier(live);
      const tpl2 = makeTemplate1(templates, "tpl-live-origin", live, fireball);
      tpl2.flags.dnd5e.origin = live.uuid;
      rebuilt = 0;
      saves._pendingSaveSpell = null;
      await quiet(() => saves._onTemplateCreated(tpl2));
      check("and a LIVE cast still rebuilds from its area, which is what that path is for (2026-09-17)",
        rebuilt === 1 && tpl2.deleted !== true,
        `rebuilds attempted: ${rebuilt}; the area ${tpl2.deleted ? "was wrongly removed" : "is still on the map"}`);
      ReactionEngine._resolveCastBarrier(live, { abort: false, reason: "no_counter" });   // answered, as its check would

      canvas.scene = keepScene;
      canvas.tokens.placeables.length = 0;
      ACTORS.delete(caster.id);
    }

    // ── Every finisher asks the kill-list ──
    // Johnny, 2026-09-17: "castIsDead → that activity does not place, does not
    // move the token, does not leave a red line, does not post a card." A
    // countered Misty Step still moved Patrina. ACE has no destination executor
    // - nothing in the suite moves a token for a spell - so the move comes from
    // whatever his table automates it with, and the only honest way to stop it
    // without naming a spell is to refuse the MOVE when it belongs to a cast
    // that just died.
    {
      const patrina = makeCaster("p6b-c14", "Patrina Velikovna", { at: [0, 0] });
      const mistyStep = other("Misty Step");
      mistyStep.uuid = "Actor.p6b-c14.Item.it-Misty Step";
      const activity = cast(patrina, mistyStep);
      activity.uuid = "Actor.p6b-c14.Item.it-Misty Step.Activity.mmm";

      const tokenDoc = canvas.tokens.placeables.find(t => t.actor?.id === patrina.id).document;
      const move = hooks["preUpdateToken"] ?? [];
      const ask = (changes) => move.map(fn => fn(tokenDoc, changes, {})).filter(v => v === false).length;

      // Before the counter: every kind of move is allowed, tagged or not.
      const walkedBefore = ask({ x: 500, y: 0, movement: { action: "walk" } });
      const untaggedBefore = ask({ x: 500, y: 0 });

      // ⚠️🔴 THE SHAPE HIS TABLE ACTUALLY PRODUCED. ddb-importer's Misty Step
      // macro is what automates that spell in his world, and it moves the token
      // with `targetToken.update({ x, y }, { animate: false })` - a plain
      // document write with NO movement and NO action, which is why a rule that
      // read the teleport tag never fired.
      const arm = () => ReactionEngine._teleportLock.set(patrina.id,
        { until: Date.now() + 60000, spell: "Misty Step" });

      arm();
      const untagged = await quiet(() => Promise.resolve(ask({ x: 500, y: 0 })));
      // ⚠️🔴 AND THEN SHE WALKS. His words: "After the counter, she cannot
      // WALK on her turn... Dragging her one square must work." The hold is ONE
      // MOVE - the one the dead spell still had in it - and it is spent by that
      // refusal whether or not anything else clears it. Everything after is hers,
      // tagged or not, which is the half the previous version got wrong.
      const walksAfter = ask({ x: 600, y: 0, movement: { action: "walk" } });
      const draggedAfter = ask({ x: 700, y: 0 });

      arm();
      const walkWhileArmed = ask({ x: 500, y: 0, movement: { action: "walk" } });
      const flewWhileArmed = ask({ x: 500, y: 0, movement: { action: "fly" } });
      const forced = move.map(fn => fn(tokenDoc, { x: 500, y: 0 }, { aceForcedMovement: true }))
        .filter(v => v === false).length;
      const turned = ask({ rotation: 90 });
      ReactionEngine._teleportLock.clear();

      check("A COUNTERED SPELL GETS ONE MOVE AND NO MORE: the untagged write the macro makes is refused, and then she walks, is dragged, flies, is shoved and turns freely (2026-09-17)",
        walkedBefore === 0 && untaggedBefore === 0
          && untagged === 1 && walksAfter === 0 && draggedAfter === 0
          && walkWhileArmed === 0 && flewWhileArmed === 0 && forced === 0 && turned === 0,
        `before: walk ${walkedBefore ? "blocked" : "allowed"}, untagged ${untaggedBefore ? "blocked" : "allowed"}; `
          + `the spell's move: ${untagged ? "refused" : "ALLOWED (wrong)"}; `
          + `then walking ${walksAfter ? "BLOCKED (wrong)" : "allowed"}, dragging ${draggedAfter ? "BLOCKED (wrong)" : "allowed"}; `
          + `while still armed: walk ${walkWhileArmed ? "blocked (wrong)" : "allowed"}, fly ${flewWhileArmed ? "blocked (wrong)" : "allowed"}, `
          + `shove ${forced ? "blocked (wrong)" : "allowed"}, turn ${turned ? "blocked (wrong)" : "allowed"}`);

      // ⚠️ AND THE AIMING GOING AWAY FREES HER TOO, so a right-click that drops
      // the crosshair does not leave her owing a move she never makes.
      arm();
      const keepPreview = canvas.templates;
      canvas.templates = { preview: { children: [{ _onCancelPlacement: async () => {} }] } };
      await quiet(() => ReactionEngine.cancelTemplatePreview("a pin"));
      canvas.templates = keepPreview;
      const freedByCancel = ask({ x: 800, y: 0 });
      check("and dropping the crosshair frees her at once, without her having to spend the hold on a step of her own (2026-09-17)",
        freedByCancel === 0 && ReactionEngine._teleportLock.size === 0,
        `after the crosshair was cancelled: an untagged move is ${freedByCancel ? "still blocked (wrong)" : "allowed"}`);

      // Nothing is summoned for a dead cast either. (The kill record is what
      // answers there, not the one-shot movement hold.)
      ReactionEngine._markCastCounterspelled(activity);
      const summon = hooks["dnd5e.preSummon"] ?? [];
      const refusedSummon = await quiet(() => Promise.resolve(summon.map(fn => fn(activity)).filter(v => v === false).length));
      const liveOne = cast(patrina, other("Summon Fey"));
      liveOne.uuid = "Actor.p6b-c14.Item.it-Summon Fey.Activity.nnn";
      ReactionEngine._createCastBarrier(liveOne);
      const allowedSummon = summon.map(fn => fn(liveOne)).filter(v => v === false).length;
      check("nothing is summoned for a counterspelled cast, and a live one still summons (2026-09-17)",
        refusedSummon >= 1 && allowedSummon === 0,
        `the dead cast's summon: ${refusedSummon ? "refused" : "went ahead (wrong)"}; a live cast's: ${allowedSummon ? "wrongly refused" : "allowed"}`);

      canvas.tokens.placeables.length = 0;
      ACTORS.delete(patrina.id);
    }

    // ── The blast goes off where she WAS ──
    // Johnny, 2026-09-17: "The Constitution save card appears BEFORE I pick the
    // destination... THEN creatures within 10 feet of the OLD square get the Con
    // save. She appears on the new square. No save there."
    //
    // ⚠️ AND THE OBVIOUS READING OF HIS DATA IS WRONG. "Range self, radius area,
    // item reaches feet" matches FIVE spells in his world and four of them mean
    // the opposite: Ice Knife, Vitriolic Sphere, Pyrotechnics and Spiritual
    // Weapon all burst at the TARGET and only say "self" because an importer
    // left it there. What separates them is where the area LANDS, which is a
    // question you can only ask of the placed template.
    {
      const caster = makeCaster("p6b-c15", "Jebidiah", { at: [0, 0] });
      const casterTok = canvas.tokens.placeables.find(t => t.actor?.id === caster.id);

      const thunderStep = { id: "it-ts", name: "Thunder Step", type: "spell", img: "",
        system: { level: 3, range: { units: "ft", value: "90" }, properties: new Set() } };
      const onSelf = { item: thunderStep, actor: caster,
        activity: { range: { units: "self" }, target: { template: { type: "radius", size: "10" } } } };

      const iceKnife = { id: "it-ik", name: "Ice Knife", type: "spell", img: "",
        system: { level: 1, range: { units: "ft", value: "60" }, properties: new Set() } };
      const atTarget = { item: iceKnife, actor: caster,
        activity: { range: { units: "self" }, target: { template: { type: "radius", size: "5" } } } };

      const spiritGuardians = { id: "it-sg", name: "Spirit Guardians", type: "spell", img: "",
        system: { level: 3, range: { units: "self" }, properties: new Set() } };
      const stays = { item: spiritGuardians, actor: caster,
        activity: { range: { units: "self" }, target: { template: { type: "radius", size: "15" } } } };

      // The area reads whoever is standing in it; that is what decides.
      const keepIn = SaveEngine._getTokensInTemplate;
      const tpl = { id: "tpl-ts" };
      SaveEngine._getTokensInTemplate = () => insideNow;
      let insideNow = [casterTok];

      const ts = SaveEngine._areaIsWhereTheyWere(tpl, onSelf);
      const sg = SaveEngine._areaIsWhereTheyWere(tpl, stays);
      insideNow = [];                       // Ice Knife's burst is at the target
      const ik = SaveEngine._areaIsWhereTheyWere(tpl, atTarget);

      check("THE BLAST GOES OFF WHERE SHE WAS: Thunder Step's area sits on its caster and its spell reaches elsewhere, so its card waits; Ice Knife bursts at the target and Spirit Guardians never leaves, so neither does (2026-09-17)",
        ts === casterTok && ik === null && sg === null,
        `Thunder Step: ${ts ? "held for her to go" : "not held (wrong)"}; `
          + `Ice Knife: ${ik ? "WRONGLY held" : "rolled at once"}; `
          + `Spirit Guardians: ${sg ? "WRONGLY held" : "rolled at once"}`);

      // And the hold ends the moment she is out of her own blast.
      insideNow = [casterTok];
      let left = null;
      const running = quiet(() => SaveEngine._awaitTheyLeave(casterTok, tpl, "Thunder Step")
        .then(v => { left = v; }));
      await new Promise(r => setTimeout(r, 200));
      const heldWhileIn = left === null;
      insideNow = [];                       // she lands on the new square
      await running;
      check("and the hold ends the moment she is out of her own blast, not before (2026-09-17)",
        heldWhileIn === true && left === true,
        `while she was still standing in it: ${heldWhileIn ? "held" : "posted anyway (wrong)"}; once she left: ${left ? "released" : "still holding (wrong)"}`);

      SaveEngine._getTokensInTemplate = keepIn;
      canvas.tokens.placeables.length = 0;
      ACTORS.delete(caster.id);
    }

    // ── A cantrip cannot be countered, and neither can a sword ──
    {
      const caster = makeCaster("p6b-c6", "a caster", { at: [0, 0] });
      const kasimir = mage("p6b-k6", "Kasimir Velikov", { items: [csItem("2024")], at: [200, 0] });
      answer = true;
      const atAsk = asked.length;
      const cantrip = { id: "it-firebolt", name: "Fire Bolt", type: "spell", img: "", system: { level: 0 } };
      const sword = { id: "it-sw6", name: "Longsword", type: "weapon", img: "", system: {} };
      let err = null;
      try {
        await quiet(async () => {
          await engine._onSpellCast(cast(caster, cantrip, 0), null);
          await engine._onSpellCast(cast(caster, sword, 0), null);
        });
      } catch (e) { err = e; }
      check("nobody is asked about a cantrip or a sword swing (Phase 6b)",
        !err && asked.length - atAsk === 0,
        err ? `threw: ${err?.message ?? err}` : `asked ${asked.length - atAsk}x`);
      canvas.tokens.placeables.length = 0;
      for (const a of [caster, kasimir]) ACTORS.delete(a.id);
    }

    // ── WHAT THE COUNTERED CASTER LOSES, THROUGH THE SPELL PIPELINE (2026-09-18) ──
    // His books: 2014 "its spell fails and has no effect", with no word sparing
    // the slot; 2024 "If that spell was cast with a spell slot, the slot isn't
    // expended", and nothing else is spared. The Counterspell's own book decides,
    // not the countered spell's. The pipeline kept the slot it held for both, and
    // let go of that hold before the 2024 rule looked, so the rule handed the
    // caster a slot never spent. This drives the real dispatch waiting on a real
    // hold, answered by the real check, with a daily use on the press as well.
    {
      const run = async (csEdition, spellEdition) => {
        const caster = makeCaster(`p6b-gb${csEdition}`, "Neferon", { at: [0, 0] });
        const counter = mage(`p6b-gbk${csEdition}`, csEdition === "2014" ? "Patrina Velikovna" : "Kasimir Velikov",
          { items: [csItem(csEdition)], at: [200, 0], dc: 17 });
        answer = true;
        casterSaveTotal = 5;                  // the 2024 save fails
        const spell = { ...other("Fireball"), uuid: `Actor.${caster.id}.Item.it-Fireball`, actor: caster };
        spell.system = { ...spell.system, source: { rules: spellEdition } };
        const act = { ...cast(caster, spell), uuid: `${spell.uuid}.Activity.gb${csEdition}`, _aceSlotDeferred: true };
        const refunds = [];
        act.refund = async (d) => { refunds.push(d); };
        const deltas = { item: { [spell.id]: [{ keyPath: "system.uses.spent", delta: 1 }] } };
        ReactionEngine._createCastBarrier(act);
        let err = null;
        try {
          await quiet(async () => {
            const dispatched = SpellPipeline._dispatch(act, { system: { spellLevel: 3, deltas } });
            await engine._onSpellCast(act, { system: { spellLevel: 3 } });
            await dispatched;
          });
        } catch (e) { err = e; }
        const verdict = ReactionEngine._castBarriers.get(ReactionEngine._activityKey(act))?.resolvedWith ?? null;
        const out = { err, verdict, slots: caster.system.spells.spell3.value, refunds: refunds.length };
        canvas.tokens.placeables.length = 0;
        for (const a of [caster, counter]) ACTORS.delete(a.id);
        return out;
      };
      const old = await run("2014", "2024");
      check("a 2014 Counterspell stops a 2024 Fireball the pipeline owns: the verdict names the 2014 book, the level 3 slot the pipeline held is spent, and the daily use stays spent (2026-09-18)",
        !old.err && old.verdict?.abort === true && old.verdict?.edition === "2014" && old.slots === 1 && old.refunds === 0,
        old.err ? `threw: ${old.err?.message ?? old.err}`
          : `verdict: ${JSON.stringify(old.verdict)}; Neferon's level 3 slots: ${old.slots} of 3 (2 before); given back: ${old.refunds}`);
      const now = await run("2024", "2014");
      check("a 2024 Counterspell stops a 2014 Fireball the pipeline owns: the verdict names the 2024 book, the slot is not expended and no slot is handed over either (still 2 of 3), and the daily use stays spent (2026-09-18)",
        !now.err && now.verdict?.abort === true && now.verdict?.edition === "2024" && now.slots === 2 && now.refunds === 0,
        now.err ? `threw: ${now.err?.message ?? now.err}`
          : `verdict: ${JSON.stringify(now.verdict)}; Neferon's level 3 slots: ${now.slots} of 3 (2 before); given back: ${now.refunds}`);
    }
  } finally {
    Door6b.post = keep6b.post;
    game.combat = keep6b.combat;
    game.combats = keep6b.combats;
    canvas.tokens.placeables.length = 0;
    canvas.tokens.placeables.push(...keep6b.placed);
    for (const [k, v] of Object.entries({ "ace-qol.enableReactions": keep6b.reactions,
      "ace-qol.autoCounterspell": keep6b.cs, "ace-qol.gameRulesEdition": keep6b.edition,
      "ace-qol.counterspellAnyCaster": keep6b.anyCaster })) {
      if (v === undefined) SETTINGS.delete(k); else SETTINGS.set(k, v);
    }
    for (const a of made6b) ACTORS.delete(a.id);
  }
}

/* ── PHASE 6a: THE SHIELD REACTION ───────────────────────────────────────── */
// Johnny, 2026-09-16: "PHASE 6a - Shield reaction only. Then stop." Magic Missile
// at a creature with Shield prepared, a slot and a free reaction asks; yes eats
// the missiles. An attack roll that hits the same creature asks; yes adds 5 to
// its AC and cancels the hit when that makes it a miss. No Shield, no slot, a
// spent reaction, dead or unconscious: no pop-up at all. Cards through CardDoor.
//
// ⚠️ THIS DRIVES THE REAL ENGINE. Only the prompt itself is stood in, because it
// is a dialog on somebody's screen; everything it decides, spends and lands is
// ACE's own code.
console.log(`\nPHASE 6a: THE SHIELD REACTION`);
{
  const MOD = "ace-qol";
  const { ReactionEngine } = await import(`${MODULE}/scripts/reaction-engine.mjs`);
  const { ConditionDoor, CardDoor: Door } = await import(`${MODULE}/scripts/road/doors.mjs`);

  const keep6a = { placed: [...canvas.tokens.placeables], combat: game.combat,
    apply: ConditionDoor.apply, applyFx: ConditionDoor.applyItemEffect, post: Door.post,
    reactions: SETTINGS.get("ace-qol.enableReactions"), shield: SETTINGS.get("ace-qol.autoShield") };
  SETTINGS.set("ace-qol.enableReactions", true);
  SETTINGS.set("ace-qol.autoShield", true);
  const doors6a = { condition: [], card: [] };
  ConditionDoor.apply = async (actor, key) => { doors6a.condition.push({ actor, key }); return { ok: true, applied: key }; };
  ConditionDoor.applyItemEffect = async (item, actor, fx) => { doors6a.condition.push({ actor, key: fx?.name ?? "its own effect" }); return { ok: true, name: fx?.name }; };
  Door.post = async (data) => { doors6a.card.push(data); return { id: "shield-card", ...data }; };
  canvas.tokens.placeables.length = 0;
  const made6a = [];
  try {
    // ⚠️🔴 THE STAND-IN WAS WRONG AND THAT IS WHY THESE PINS WERE GREEN WHILE
    // HIS TABLE WAS BROKEN (2026-09-16). It wrote `method: "prepared"`, which
    // is a dnd5e 3.x preparation MODE and a value dnd5e 5.3.3 cannot produce —
    // the same wrong value the reader was testing for, so the pin agreed with
    // the bug. Every spell in hijinx reads `method: "spell"` with `prepared` as
    // a NUMBER: 0 unprepared, 1 prepared, 2 always. Kasimir's Shield is
    // spell/1, Morthos's is spell/2, Riswynn's is spell/0. A stand-in has to
    // carry the shape his world carries or it pins nothing at all.
    const spell = (name, { prepared = 1, method = "spell" } = {}) => ({
      id: `it-${name}`, name, type: "spell", img: "",
      system: { level: 1, method, prepared, activities: [] },
    });
    const who = (id, name, { shield = true, shieldPrepared = 1, fireShield = false, slots = 3, statuses = [], hp = 20, flags = {} } = {}) => {
      const items = [];
      if (shield) items.push(spell("Shield", { prepared: shieldPrepared }));
      if (fireShield) items.push(spell("Fire Shield"));
      const a = { id, name, type: "character", img: "", documentName: "Actor", uuid: `Actor.${id}`,
        statuses: new Set(statuses), effects: [], items, hasPlayerOwner: true,
        system: { attributes: { hp: { value: hp, max: 20 }, death: { success: 0, failure: 0 } },
          spells: { spell1: { value: slots, max: 3 } }, details: {} },
        flags: { [MOD]: { ...flags } },
        getFlag: (scope, key) => a.flags?.[scope]?.[key],
        setFlag: async (scope, key, v) => { (a.flags[scope] ??= {})[key] = v; return a; },
        update: async (u) => { for (const [k, v] of Object.entries(u)) {
          const path = k.split("."); let o = a;
          for (const s2 of path.slice(0, -1)) o = (o[s2] ??= {});
          o[path[path.length - 1]] = v; } return a; },
        getActiveTokens: () => [],
      };
      ACTORS.set(id, a);
      made6a.push(a);
      return a;
    };

    const ready   = who("p6a-ready", "Beric, with Shield");
    const wrong   = who("p6a-wrong", "a wizard with Fire Shield", { shield: false, fireShield: true });
    const spent   = who("p6a-spent", "a wizard with no slots left", { slots: 0 });
    const downed  = who("p6a-downed", "an unconscious wizard", { statuses: ["unconscious"], hp: 0 });
    const dead    = who("p6a-dead", "a dead wizard", { statuses: ["dead"], hp: 0 });
    const reacted = who("p6a-reacted", "a wizard who already reacted", { flags: { reactionUsed: true } });
    // Kasimir the Wizard 9 keeps Shield prepared; Morthos the Sorcerer 17 has it
    // always prepared and a second, unprepared copy beside it; Riswynn the
    // Rogue 17 carries it and has never prepared anything.
    const kasimir = who("p6a-kasimir", "Kasimir Velikov", { shieldPrepared: 1 });
    const morthos = who("p6a-morthos", "Morthos", { shieldPrepared: 0 });
    morthos.items.push(spell("Shield", { prepared: 2 }));
    const riswynn = who("p6a-riswynn", "Riswynn", { shieldPrepared: 0 });

    const engine = new ReactionEngine();
    const asked = [];
    let answer = true;
    engine._promptReaction = async (o) => {
      asked.push(o);
      return { accepted: answer, choiceData: { slotLevel: 1 } };
    };

    // ── 3 + 4. Who is even asked ──
    const can = (a) => engine._canUseShield(a);
    // ⚠️ A REACTION BUDGET ONLY EXISTS IN A FIGHT, so the one pin about a spent
    // reaction needs a fight the creature is actually in (action-economy's
    // hasTurns reads game.combats, not game.combat).
    const keepCombats = game.combats;
    const fight = { started: true, round: 1, turn: 0,
      combatants: { contents: [{ actorId: reacted.id, actor: reacted }] } };
    game.combats = { contents: [fight] };
    game.combat = fight;
    const reactedNow = can(reacted);
    game.combat = keep6a.combat;
    game.combats = keepCombats;
    check("3+4. only a creature that could actually cast it is asked: Shield prepared, a slot, a free reaction, and on its feet (Phase 6a)",
      can(ready).canUse === true && can(wrong).canUse === false && can(spent).canUse === false
        && can(downed).canUse === false && can(dead).canUse === false && reactedNow.canUse === false,
      `with Shield and a slot: ${can(ready).canUse ? "asked" : `not asked (${can(ready).reason})`}; `
        + `Fire Shield only: ${can(wrong).reason}; no slots: ${can(spent).reason}; `
        + `unconscious: ${can(downed).reason}; dead: ${can(dead).reason}; already reacted: ${reactedNow.reason}`);

    // ── HIS TABLE'S BUG: a sheet dnd5e 5.x actually wrote ──
    // Johnny, 2026-09-16: "Magic Missile at Beric, who has Shield prepared, a
    // slot, and a reaction. No Shield pop-up." The reader asked whether the
    // casting METHOD was the word "prepared", which dnd5e has not written since
    // 3.x, so every slot caster in his world was refused in silence — Shield,
    // Counterspell, Absorb Elements and Silvery Barbs alike.
    check("a wizard's prepared Shield and a sorcerer's always-prepared one are both asked; an unprepared one is not, and it says which (2026-09-16)",
      can(kasimir).canUse === true && can(morthos).canUse === true
        && can(riswynn).canUse === false && /has Shield, but/.test(can(riswynn).reason ?? "")
        && /does not have Shield/.test(can(wrong).reason ?? ""),
      `Kasimir (method "spell", prepared 1): ${can(kasimir).canUse ? "asked" : `refused — ${can(kasimir).reason}`}; `
        + `Morthos (an unprepared copy AND an always-prepared one): ${can(morthos).canUse ? "asked" : `refused — ${can(morthos).reason}`}; `
        + `Riswynn: ${can(riswynn).reason}; the Fire Shield wizard: ${can(wrong).reason}`);

    // ── 1. Magic Missile ──
    {
      const caster = who("p6a-caster", "the missile caster", { shield: false, slots: 0 });
      const mm = { id: "it-mm", name: "Magic Missile", type: "spell", img: "", system: { level: 1 } };
      const atCard = doors6a.card.length, atCond = doors6a.condition.length, atAsk = asked.length;
      answer = true;
      let out = null, err1 = null;
      try {
        await quiet(async () => {
          out = await engine.checkMagicMissileShield(new Map([[ready, 3], [wrong, 2]]), caster, mm);
        });
      } catch (e) { err1 = e; }
      const slotsLeft = ready.system.spells.spell1.value;
      const card = doors6a.card[atCard] ?? null;
      check("1. Magic Missile asks the creature that can Shield, and yes eats every dart: the slot and the reaction are spent, the effect goes on through the condition door, and the card says so (Phase 6a)",
        !err1 && asked.length - atAsk === 1 && !out?.has(ready) && out?.get(wrong) === 2
          && slotsLeft === 2 && ready.flags[MOD]?.reactionUsed === true
          && doors6a.condition.length - atCond === 1
          && !!card && /nullified/i.test(String(card.content ?? "")),
        err1 ? `threw: ${err1?.message ?? err1}`
          : `asked ${asked.length - atAsk} of the two targets; Beric's darts: ${out?.get(ready) ?? "none, they were eaten"}; `
            + `the wizard with Fire Shield still takes ${out?.get(wrong) ?? 0}; slots ${slotsLeft} of 3; `
            + `reaction ${ready.flags[MOD]?.reactionUsed ? "spent" : "still free"}; `
            + `the condition door put on ${doors6a.condition.length - atCond}; card door: ${card ? "posted" : "nothing"}`);
    }

    // ── 2. An attack roll ──
    // ⚠️🔴 THE SHAPE BOTH PATHS BUILD (2026-09-19). These pins used to hand the
    // engine `target: { actor, token, ac, name }`, a shape neither path makes.
    // attack-pipeline.mjs and the socket path in ace-qol.mjs spread a
    // CombatState.assess record, which keeps the creature and its token BESIDE
    // the `target` block, never in it. The engine read the block, the pin put
    // the creature there, and both agreed while Shield after a hit never once
    // opened at his table. Now the record comes from the real CombatState.assess
    // and is spread exactly the way attack-pipeline.mjs spreads it, so a pin
    // cannot build a shape the pipeline does not.
    const { judgeAttack } = await import(`${MODULE}/scripts/rules/attack-hit.mjs`);
    const tokenOf = (a) => ({ id: `tok-${a.id}`, name: a.name, actor: a, x: 0, y: 0, w: 100, h: 100,
      document: { id: `tok-${a.id}`, uuid: `Scene.replay.Token.tok-${a.id}`, name: a.name, texture: { src: "" },
        x: 0, y: 0, width: 1, height: 1, elevation: 0, disposition: -1 } });
    const longsword = { id: "it-sword", name: "Longsword", type: "weapon", img: "",
      system: { properties: new Set(), damage: { base: { types: new Set(["slashing"]) } }, activities: [] } };
    // One swing's result for one target, as attack-pipeline.mjs builds it.
    const swingAt = (attacker, target, total, ac, { cover = 0, d20 = 12, item = longsword } = {}) => {
      target.system.attributes.ac = { value: ac };
      const cs = CombatState.assess(attacker, tokenOf(target), item);
      const effectiveAC = cs.target.ac + cover;
      const coverResult = cover ? { cover, acBonus: cover, isFullCover: false, label: "Half Cover" } : null;
      return {
        ...cs,
        name: cs.target.name,
        img: cs.target.img,
        ac: cs.target.ac,
        effectiveAC,
        coverResult,
        environment: null,
        hitResult: judgeAttack({ d20, total, ac: effectiveAC, autoCrit: !!cs.autoCrit }),
        attackTotal: total,
        originalAttackTotal: total,
        d20Result: d20,
        isCritRoll: d20 === 20,
        isFumbleRoll: d20 === 1,
        mirrorImageRedirect: null,
      };
    };
    {
      const ready2 = who("p6a-ready2", "Beric, second round", {});
      const ready3 = who("p6a-ready3", "Beric, against a big hit", {});
      const covered = who("p6a-covered", "Beric, behind a low wall", {});
      const attacker = who("p6a-attacker", "a bandit", { shield: false, slots: 0 });
      answer = true;
      let out2 = null, out3 = null, out5 = null, err2 = null, shape = null;
      const atAsk = asked.length;
      try {
        await quiet(async () => {
          const r2 = swingAt(attacker, ready2, 17, 15);
          shape = { creatureBeside: r2.targetActor === ready2 && r2.targetToken?.actor === ready2,
            blockHasCreature: "actor" in (r2.target ?? {}) || "token" in (r2.target ?? {}) };
          out2 = await engine.checkPostHitReactions([r2], longsword, attacker);
          out3 = await engine.checkPostHitReactions([swingAt(attacker, ready3, 25, 15)], longsword, attacker);
          out5 = await engine.checkPostHitReactions([swingAt(attacker, covered, 21, 15, { cover: 2 })], longsword, attacker);
        });
      } catch (e) { err2 = e; }
      const [box2, box3, box5] = asked.slice(atAsk);
      check("2. an attack that hits asks too, from the result both paths really build: +5 turns a 17 against AC 15 into a miss, a 25 still hits, and the card's AC goes up (2026-09-19)",
        !err2 && shape?.creatureBeside && !shape?.blockHasCreature && asked.length - atAsk === 3
          && out2?.[0]?.hitResult === "miss" && out2?.[0]?.shieldBlocked === true
          && out2?.[0]?.ac === 20 && out2?.[0]?.effectiveAC === 20
          && out3?.[0]?.hitResult === "hit" && out3?.[0]?.target?.ac === 20 && out3?.[0]?.effectiveAC === 20,
        err2 ? `threw: ${err2?.message ?? err2}`
          : `the result keeps the creature ${shape?.creatureBeside ? "beside" : "NOT beside"} the target block, `
            + `the block ${shape?.blockHasCreature ? "HAS" : "has no"} creature in it; asked ${asked.length - atAsk} of 3; `
            + `17 vs AC 15 with Shield: ${out2?.[0]?.hitResult} (${out2?.[0]?.shieldBlocked ? "blocked" : "not blocked"}, AC on the card ${out2?.[0]?.effectiveAC}); `
            + `25 vs AC 15 with Shield: ${out3?.[0]?.hitResult}, AC now ${out3?.[0]?.effectiveAC}`);
      check("Shield goes on top of cover: a 21 against AC 15 behind half cover is 17 and a hit, and Shield makes it 22 and a miss (2026-09-19)",
        !err2 && out5?.[0]?.hitResult === "miss" && out5?.[0]?.effectiveAC === 22 && out5?.[0]?.ac === 20,
        err2 ? `threw: ${err2?.message ?? err2}`
          : `21 vs AC 15 + half cover, with Shield: ${out5?.[0]?.hitResult}, AC on the card ${out5?.[0]?.effectiveAC} `
            + `(the creature's ${out5?.[0]?.ac} and the cover's +2)`);
      check("the box is the moment: no number rows, one line that says in words whether Shield saves you (his design, 2026-09-18)",
        !!box2 && !box2.details?.length && !box3?.details?.length
          && /Shield would turn it into a miss/.test(box2.description ?? "")
          && /Even with Shield, it still hits/.test(box3?.description ?? "")
          && /Shield would turn it into a miss/.test(box5?.description ?? ""),
        `rows in the box: ${box2?.details?.length ?? 0}; its line: "${String(box2?.description ?? "").replace(/<[^>]+>/g, "")}"; `
          + `against the 25: "${String(box3?.description ?? "").replace(/<[^>]+>/g, "")}"`);
    }

    // ── Saying no changes nothing ──
    {
      const stubborn = who("p6a-no", "a wizard who says no");
      const attacker = who("p6a-attacker2", "another bandit", { shield: false, slots: 0 });
      const mace = { id: "it-sword2", name: "Mace", type: "weapon", img: "",
        system: { properties: new Set(), damage: { base: { types: new Set(["bludgeoning"]) } }, activities: [] } };
      answer = false;
      let out4 = null, err4 = null;
      const atAsk = asked.length;
      try {
        await quiet(async () => {
          out4 = await engine.checkPostHitReactions([swingAt(attacker, stubborn, 17, 15, { item: mace })], mace, attacker);
        });
      } catch (e) { err4 = e; }
      check("and a no leaves the hit alone: no slot, no reaction, no effect (Phase 6a)",
        !err4 && asked.length - atAsk === 1 && out4?.[0]?.hitResult === "hit" && out4?.[0]?.effectiveAC === 15
          && stubborn.system.spells.spell1.value === 3 && !stubborn.flags[MOD]?.reactionUsed,
        err4 ? `threw: ${err4?.message ?? err4}`
          : `asked ${asked.length - atAsk}x; the hit is still a ${out4?.[0]?.hitResult} against AC ${out4?.[0]?.effectiveAC}; `
            + `slots ${stubborn.system.spells.spell1.value} of 3; reaction ${stubborn.flags[MOD]?.reactionUsed ? "spent" : "still free"}`);
    }

    // ── A hit that names nobody says so ──
    // The early return that hid the bug passed the result through without a
    // word. "Could not read the creature" must never look like "nobody could
    // Shield".
    {
      const ghost = who("p6a-ghost", "Beric, lost from the result", {});
      const attacker = who("p6a-attacker3", "a third bandit", { shield: false, slots: 0 });
      const blind = await quiet(async () => ({ ...swingAt(attacker, ghost, 17, 15), targetActor: null, targetToken: null }));
      const heard = [];
      const keepLog = console.log, keepWarn = console.warn;
      let out6 = null, err6 = null;
      const atAsk = asked.length;
      console.log = console.warn = (...a) => { heard.push(a.map(String).join(" ")); };
      try { out6 = await engine.checkPostHitReactions([blind], longsword, attacker); }
      catch (e) { err6 = e; }
      finally { console.log = keepLog; console.warn = keepWarn; }
      check("a hit whose result carries no creature asks nobody and says why, instead of passing in silence (2026-09-19)",
        !err6 && asked.length === atAsk && out6?.[0]?.hitResult === "hit"
          && heard.some(l => /carries no creature, so nobody\s+could be asked about Shield/.test(l)),
        err6 ? `threw: ${err6?.message ?? err6}` : `asked ${asked.length - atAsk}; the console: ${heard.find(l => /Shield/.test(l)) ?? "(nothing)"}`);
    }

    // ── The box waits for the attack's d20 ──
    // "Nothing shows an answer until the dice that decided it have landed."
    // The attack's d20 is dnd5e's, not ACE's, so only a wait on the armed watch
    // (the one Lucky's box peeks at) can see it; the dice check reads ACE's own
    // throws and cannot.
    {
      const { aceArmDiceWatch } = await import(`${MODULE}/scripts/dsn-utils.mjs`);
      const patient = who("p6a-patient", "Beric, while the die still rolls", {});
      const attacker = who("p6a-attacker4", "a fourth bandit", { shield: false, slots: 0 });
      const keepDice = game.dice3d;
      game.dice3d = { isEnabled: () => true };
      answer = false;
      const atAsk = asked.length;
      let askedWhileRolling = -1, askedAfter = -1, err7 = null;
      try {
        await quiet(async () => {
          const watch = aceArmDiceWatch();
          const running = engine.checkPostHitReactions([swingAt(attacker, patient, 17, 15)], longsword, attacker, { dice: "armed" });
          await new Promise(r => setTimeout(r, 60));
          askedWhileRolling = asked.length - atAsk;
          for (const f of [...(hooks.diceSoNiceRollComplete ?? [])]) { try { f(); } catch (_) { /* another watch's */ } }
          await watch?.promise;
          await running;
          askedAfter = asked.length - atAsk;
        });
      } catch (e) { err7 = e; }
      finally { game.dice3d = keepDice; }
      check("the Shield box waits for the attack's d20 to land before it asks (his rule; 2026-09-19)",
        !err7 && askedWhileRolling === 0 && askedAfter === 1,
        err7 ? `threw: ${err7?.message ?? err7}`
          : `asked while the die was still rolling: ${askedWhileRolling}; once it landed: ${askedAfter}`);
    }

    // ── Lucky first, then Shield, on both paths, both waiting for the dice ──
    // His order: a luck point can change whether there is a hit to Shield
    // against, so Lucky is asked first. The GM's own roll and a player's roll
    // (the socket path) are the same attack and keep the same order.
    {
      const read = (f) => readFileSync(`${ROOT}/Data/modules/ace-qol/scripts/${f}`, "utf8").replace(/\/\/.*$/gm, "");
      const pipe = read("attack-pipeline.mjs"), sock = read("ace-qol.mjs");
      const order = (src, lucky) => {
        const l = src.indexOf(lucky), s = src.indexOf("checkPostHitReactions(results, item, actor, { dice: \"armed\" })", l);
        return l >= 0 && s > l;
      };
      const pipeOk = order(pipe, "_luckAfterAttackRoll({ actor, item, results");
      const sockOk = order(sock, "luckAfterAttackRoll({ actor, item, results");
      check("Lucky is asked before Shield, and Shield is handed the armed dice, on the GM's roll and on a player's (2026-09-19)",
        pipeOk && sockOk,
        `the GM's own roll: ${pipeOk ? "Lucky, then Shield with the dice" : "NOT in that order, or Shield has no dice"}; `
          + `a player's roll: ${sockOk ? "Lucky, then Shield with the dice" : "NOT in that order, or Shield has no dice"}`);
    }

    // ── The same wrong read, where else it sat ──
    // Graze read the target block as the token: its card said the damage landed
    // and none ever did. The "until attacked" timer read an `actor` a result
    // never carries. Both are driven here with the result the pipeline builds.
    {
      const { WeaponMasteries } = await import(`${MODULE}/scripts/weapon-masteries.mjs`);
      const { DurationTracker } = await import(`${MODULE}/scripts/duration-tracker.mjs`);
      const fighter = who("p6a-fighter", "a fighter with a Greatsword", { shield: false, slots: 0 });
      fighter.system.abilities = { str: { mod: 3 }, dex: { mod: 1 } };
      const grazed = who("p6a-grazed", "a grazed orc", { shield: false, slots: 0 });
      const tough = who("p6a-tough", "an orc that shrugs off slashing", { shield: false, slots: 0 });
      tough.system.traits = { dr: { value: new Set(["slashing"]) }, di: { value: new Set() }, dv: { value: new Set() } };
      const greatsword = { id: "it-gs", name: "Greatsword", type: "weapon", img: "",
        system: { mastery: "graze", properties: new Set(["hvy", "two"]),
          damage: { base: { types: new Set(["slashing"]) } }, activities: [] } };
      const doorCalls = [];
      const keepDamage = HpDoor.damage;
      HpDoor.damage = async (actor, finals, opts = {}) => {
        doorCalls.push({ actor, finals, opts });
        const total = (finals ?? []).reduce((s, f) => s + Math.max(0, Number(f?.final) || 0), 0);
        return total > 0 ? { applied: true, total, hpDelta: total } : { applied: false, total: 0, hpDelta: 0 };
      };
      const atPost = posted.length;
      let errG = null;
      try {
        await quiet(async () => {
          await WeaponMasteries._fireGrazeForMiss(greatsword, fighter, swingAt(fighter, grazed, 9, 15, { item: greatsword }));
          await WeaponMasteries._fireGrazeForMiss(greatsword, fighter, swingAt(fighter, tough, 9, 15, { item: greatsword }));
        });
      } catch (e) { errG = e; }
      finally { HpDoor.damage = keepDamage; }
      const cards = posted.slice(atPost).map(p => String(p?.content ?? ""));
      const plainCard = (c) => c.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
      check("Graze deals its damage to the creature it missed, through the hit-point door once the attack's dice are down, and the card says what landed (2026-09-19)",
        !errG && doorCalls.length === 2 && doorCalls[0].actor === grazed && doorCalls[0].finals?.[0]?.final === 3
          && doorCalls[0].finals?.[0]?.type === "slashing" && doorCalls[0].opts?.dice === true
          && doorCalls[1].actor === tough && doorCalls[1].finals?.[0]?.final === 1
          && /takes 3 slashing/.test(plainCard(cards[0] ?? "")) && /takes 1 slashing/.test(plainCard(cards[1] ?? "")),
        errG ? `threw: ${errG?.message ?? errG}`
          : `the door was handed: ${doorCalls.map(c => `${c.actor?.name ?? "nobody"} ${c.finals?.map(f => `${f.final} ${f.type}`).join(" + ")}`).join("; ") || "nothing"}; `
            + `cards: ${cards.map(c => plainCard(c).slice(0, 110)).join(" | ") || "none"}`);

      const tracker = new DurationTracker();
      const marked = who("p6a-marked", "a creature whose effect lasts until it is attacked", { shield: false, slots: 0 });
      const lasting = { id: "fx-until-attacked", name: "Until Attacked", disabled: false,
        flags: { [MOD]: { specialDuration: "isAttacked" } } };
      marked.effects = [lasting];
      const ended = [];
      tracker._expireEffect = async (actor, effect, reason) => { ended.push({ actor, effect, reason }); };
      const keepTracker = SETTINGS.get(`${MOD}.enableDurationTracker`);
      SETTINGS.set(`${MOD}.enableDurationTracker`, true);
      let errD = null;
      try {
        await quiet(async () => {
          await tracker._onAttackComplete({ results: [swingAt(fighter, marked, 9, 15, { item: greatsword })] });
        });
      } catch (e) { errD = e; }
      finally { SETTINGS.set(`${MOD}.enableDurationTracker`, keepTracker); }
      check("an effect that lasts until its creature is attacked ends when it is attacked, even by a miss (2026-09-19)",
        !errD && ended.length === 1 && ended[0].actor === marked && ended[0].effect === lasting,
        errD ? `threw: ${errD?.message ?? errD}`
          : `ended: ${ended.map(e => `${e.effect?.name} on ${e.actor?.name}`).join(", ") || "nothing"}`);
    }

    // ── 5. No raw card in the reaction engine's Shield path ──
    {
      const src = readFileSync(`${ROOT}/Data/modules/ace-qol/scripts/reaction-engine.mjs`, "utf8").replace(/\/\/.*$/gm, "");
      const raw = /ChatMessage\.create\s*\(/.test(src.slice(src.indexOf("_postReactionChat")));
      check("5. the reaction's own card goes through the card door (Phase 6a)",
        !raw && doors6a.card.length > 0,
        `raw chat cards in the reaction card poster: ${raw ? "left" : "none"}; `
          + `cards through the door in these pins: ${doors6a.card.length}`);
    }

    // ── 6. THE PIPELINE'S OWN PATH, END TO END ──
    // Johnny, 2026-09-16: "The distribute / pipeline path MUST call the same
    // Shield interrupt the attack path uses, AFTER targets are known and BEFORE
    // the damage card / APPLY." This drives the real resolver - the one that
    // owns Magic Missile at his table - with only the damage card and the
    // prompt stood in, and pins the ORDER, not just the call.
    {
      const { DamageResolver } = await import(`${MODULE}/scripts/spell-pipeline/resolvers/damage.mjs`);
      const { DamageCardRenderer } = await import(`${MODULE}/scripts/damage-card-renderer.mjs`);
      const keepCard = DamageCardRenderer.postDamageButton;
      const keepApi = game.aceQol?.reactionEngine;
      const order = [];
      const cards = [];
      DamageCardRenderer.postDamageButton = async (item, actor, hits) => {
        order.push("damage card");
        cards.push(hits.map(h => `${h.target?.name}:${h.magicMissileOverride?.darts}`));
        return null;
      };
      game.aceQol = game.aceQol ?? {};
      game.aceQol.reactionEngine = engine;
      const asking = engine.checkMagicMissileShield.bind(engine);
      engine.checkMagicMissileShield = async (...a) => { order.push("asked about Shield"); return asking(...a); };

      const beric = who("p6a-beric", "Beric", { shieldPrepared: 1 });
      const mate  = who("p6a-mate", "his shieldless friend", { shield: false, slots: 0 });
      const caster = who("p6a-mm-caster", "the missile caster", { shield: false, slots: 0 });
      const tokenFor = (a) => ({ id: `tok-${a.id}`, name: a.name, actor: a, x: 0, y: 0,
        center: { x: 50, y: 50 },
        document: { id: `tok-${a.id}`, actorId: a.id, actor: a, name: a.name, x: 0, y: 0,
          width: 1, height: 1, elevation: 0, hidden: false, texture: { src: "" } } });
      canvas.tokens.placeables.push(tokenFor(beric), tokenFor(mate), tokenFor(caster));

      const mm = { id: "it-mm-pipe", name: "Magic Missile", type: "spell", img: "",
        system: { level: 1, properties: new Set() } };
      const ctx = { entry: { shape: "distribute", unit: { formula: "1d4 + 1", type: "force" } },
        item: mm, actor: caster, castLevel: 1, activity: null };

      answer = true;
      const atAsk = asked.length;
      let err6 = null;
      try {
        await quiet(async () => {
          await DamageResolver.runDistribute(ctx, { distribution: new Map([[beric, 2], [mate, 1]]) });
        });
      } catch (e) { err6 = e; }

      const onCard = cards[0] ?? [];
      check("6. the pipeline's Magic Missile asks Beric about Shield once its targets are settled and BEFORE the damage card, and a yes takes his darts off it (2026-09-16)",
        !err6 && asked.length - atAsk === 1
          && order.join(" then ") === "asked about Shield then damage card"
          && onCard.length === 1 && /friend/.test(onCard[0] ?? "")
          && beric.system.spells.spell1.value === 2 && beric.flags[MOD]?.reactionUsed === true,
        err6 ? `threw: ${err6?.message ?? err6}`
          : `asked ${asked.length - atAsk} of the two; order: ${order.join(" then ") || "(nothing happened)"}; `
            + `on the damage card: ${onCard.join(", ") || "nobody"}; `
            + `Beric's slots ${beric.system.spells.spell1.value} of 3, reaction ${beric.flags[MOD]?.reactionUsed ? "spent" : "still free"}`);

      engine.checkMagicMissileShield = asking;
      DamageCardRenderer.postDamageButton = keepCard;
      if (keepApi === undefined) delete game.aceQol.reactionEngine; else game.aceQol.reactionEngine = keepApi;
    }

    // ── 7. THE RED BANNER OVER A MAGIC MISSILE THAT RESOLVED ──
    // Johnny, 2026-09-18: "Toast: 'Magic Missile did nothing. no pipeline
    // reported taking it.' The missile DID resolve. Counterspell was refused.
    // Shield was used. Nothing failed. That toast must not fire while a
    // reaction box is open, and must not fire after the pipeline later takes
    // the spell. Keep the toast only when the press truly produced no pipeline
    // and no reaction."
    //
    // This drives the real press: the reading, the real pipeline dispatch
    // waiting on a Counterspell answer, and the box opened through the real
    // prompt door and held open well past the watch's window. Only the box's
    // routing and the picker are stood in.
    {
      const { ActionInterceptor } = await import(`${MODULE}/scripts/profiles/action-interceptor.mjs`);
      const { SpellPipeline } = await import(`${MODULE}/scripts/spell-pipeline/pipeline.mjs`);
      const { ReactionEngine: RE7 } = await import(`${MODULE}/scripts/reaction-engine.mjs`);
      const wait7 = (ms) => new Promise(r => setTimeout(r, ms));
      const keep7 = { silence: ActionInterceptor.silenceMs, notes: ui.notifications, socket: game.socket,
        run: SpellPipeline._runPickerAndResolve, error: console.error };
      const banners = [];
      const emitted = [];
      const deadLines = [];
      ActionInterceptor.silenceMs = 80;
      ui.notifications = { info: () => {}, warn: () => {}, error: (m) => { banners.push(String(m)); } };
      game.socket = { emit: (_name, data) => { emitted.push(data); }, on: () => {} };
      console.error = (...a) => { deadLines.push(a.map(String).join(" ")); };
      const ran = [];
      SpellPipeline._runPickerAndResolve = async () => { ran.push("the picker"); };
      let releaseBox = null;
      engine._routePrompt = () => new Promise(r => { releaseBox = r; });

      let err7 = null;
      const seen = {};
      try {
        await quiet(async () => {
          const caster7 = who("p7-caster", "Neferon", { shield: false, slots: 3 });
          const kasimir7 = who("p7-kasimir", "Kasimir Velikov", { shield: false, slots: 3 });
          const mm7 = { id: "it-mm7", name: "Magic Missile", type: "spell", img: "",
            uuid: "Actor.p7-caster.Item.it-mm7", actor: caster7,
            system: { level: 1, properties: new Set(), source: { rules: "2014" }, activities: [] }, flags: {} };
          const act7 = { id: "act-mm7", type: "damage", uuid: "Actor.p7-caster.Item.it-mm7.Activity.act-mm7",
            item: mm7, actor: caster7 };

          // The press: read, then the pipeline takes it and waits on the answer.
          ActionInterceptor.read(act7);
          RE7._createCastBarrier(act7);
          const dispatched = SpellPipeline._dispatch(act7, {});

          // Somebody who can Counterspell is asked, through the one door, and
          // takes their time: three times the watch's window.
          const answered = RE7.prototype._promptReaction.call(engine,
            { reactorActor: kasimir7, title: "Counterspell", type: "counterspell" });
          await wait7(240);
          seen.duringBanners = banners.length;
          seen.claimedBy = ActionInterceptor.readingFor(act7)?.claimedBy ?? null;
          seen.boxesOpen = ActionInterceptor._openBoxes?.size ?? 0;
          seen.relayedOpen = emitted.some(d => d?.action === "reactionBox" && d.open === true);

          // "Counterspell was refused": the answer is no, and the spell goes on.
          releaseBox({ accepted: false, choiceData: {} });
          await answered;
          RE7._resolveCastBarrier(act7, { abort: false, reason: "not countered" });
          await dispatched;
          await wait7(240);
          seen.afterBanners = banners.length;
          seen.pickerRan = ran.length;
          seen.boxesAfter = ActionInterceptor._openBoxes?.size ?? 0;
          seen.relayedClosed = emitted.some(d => d?.action === "reactionBox" && d.open === false);

          // And a press that truly produced no pipeline and no reaction is
          // still reported: the rule narrows the banner, it does not remove it.
          const dead = { id: "act-dead7", type: "utility", uuid: "Actor.p7-caster.Item.it-dead7.Activity.act-dead7",
            item: { id: "it-dead7", name: "A button that does nothing", type: "feat", uuid: "Actor.p7-caster.Item.it-dead7",
              actor: caster7, system: { source: { rules: "2014" }, activities: [] }, flags: {} },
            actor: caster7 };
          ActionInterceptor.read(dead);
          await wait7(240);
          seen.deadBanners = banners.length - seen.afterBanners;
        });
      } catch (e) { err7 = e; }

      check("7. a Magic Missile held up by a Counterspell box raises no red banner: the box counts as something happening, the pipeline says it took the spell, and the box is announced to every client (2026-09-18)",
        !err7 && seen.duringBanners === 0 && seen.claimedBy === "spell-pipeline"
          && seen.boxesOpen === 1 && seen.relayedOpen,
        err7 ? `threw: ${err7?.message ?? err7}`
          : `banners while the box was open: ${seen.duringBanners}; the press was taken by: ${seen.claimedBy ?? "nobody"}; `
            + `boxes the watch knew were open: ${seen.boxesOpen}; announced to other clients: ${seen.relayedOpen}`);
      check("7. after Counterspell is refused the spell goes on, still with no banner, and the box is closed everywhere (2026-09-18)",
        !err7 && seen.afterBanners === 0 && seen.pickerRan === 1 && seen.boxesAfter === 0 && seen.relayedClosed,
        err7 ? `threw: ${err7?.message ?? err7}`
          : `banners: ${seen.afterBanners}; the pipeline went on to its picker: ${seen.pickerRan === 1}; `
            + `boxes still open: ${seen.boxesAfter}; closed on other clients: ${seen.relayedClosed}`);
      check("7. a press that truly produced no pipeline and no reaction still gets the banner (2026-09-18)",
        !err7 && seen.deadBanners === 1 && deadLines.some(l => /DEAD BUTTON: "A button that does nothing"/.test(l)),
        err7 ? `threw: ${err7?.message ?? err7}` : `banners for the dead press: ${seen.deadBanners}`);

      ActionInterceptor.silenceMs = keep7.silence;
      ui.notifications = keep7.notes;
      if (keep7.socket === undefined) delete game.socket; else game.socket = keep7.socket;
      SpellPipeline._runPickerAndResolve = keep7.run;
      delete engine._routePrompt;   // back to the engine's own, off its prototype
      console.error = keep7.error;
    }

    // ── 8. THE BOX HE SEES ──
    // Johnny, 2026-09-18, over a screenshot of the Shield box: the darts, the
    // per-dart damage and "effect of Shield" go ("That comes after in the chat
    // card anyways"); the attacker and the defender become one scene with one
    // plain line; "Cast Shield" in the reaction's colour, "Take damage" as a red
    // pill; a filled shield emblem; "There is no 'Consume Spell Slot' on the
    // client side ever"; and a ding when it pops up. This renders the REAL
    // Magic Missile prompt (the options the engine built in pin 1) through the
    // REAL box, as a player and as the GM. Only Foundry's window is stood in.
    {
      const mmOpts = asked.find(o => /Magic Missile/.test(String(o?.title ?? ""))) ?? null;
      const keep8 = { Dialog: globalThis.Dialog, audio: foundry.audio, user: game.user, window: globalThis.window };
      // The box centres itself on the browser window, which this harness has
      // none of; without one it throws before the window is ever built.
      globalThis.window = { innerHeight: 900, innerWidth: 1400 };
      const windows = [];
      const plays = [];
      globalThis.Dialog = class {
        constructor(cfg, opts) { this.cfg = cfg; this.opts = opts; windows.push(this); }
        render() { this.cfg.render?.([{ querySelector: () => null }]); return this; }
        close() {}
      };
      foundry.audio = { AudioHelper: { play: (d) => { plays.push(d); } } };
      const show = (asUser) => {
        game.user = asUser;
        const before = windows.length;
        // Nobody clicks, so its answer never comes; a throw inside must not
        // become an unhandled rejection that ends the whole replay.
        ReactionEngine.showReactionDialog({ ...mmOpts, reactorActorName: "Beric", reactorActorImg: null,
          reactorIsNpc: false }).catch(e => { err8 = err8 ?? e; });
        return windows[before]?.cfg?.content ?? "";
      };
      let asPlayer = "", asGM = "", err8 = null;
      try {
        if (!mmOpts) throw new Error("pin 1 never built a Magic Missile prompt to render");
        asPlayer = show({ id: "p8", isGM: false, name: "Beric's player" });
        asGM = show(GM);
      } catch (e) { err8 = e; }
      game.user = keep8.user;
      if (keep8.window === undefined) delete globalThis.window; else globalThis.window = keep8.window;
      if (keep8.Dialog === undefined) delete globalThis.Dialog; else globalThis.Dialog = keep8.Dialog;
      if (keep8.audio === undefined) delete foundry.audio; else foundry.audio = keep8.audio;

      const gone = ["Darts incoming", "Per-dart", "Effect of Shield", "negate all darts", "ALL DARTS NULLIFIED"]
        .filter(w => asPlayer.includes(w));
      check("8. the Shield box is one scene: both portraits, the red arrow, one plain line, and none of the darts, dice or effect rows (2026-09-18)",
        !err8 && /ace-qol-reaction-scene"/.test(asPlayer) && /is-them/.test(asPlayer) && /is-you/.test(asPlayer)
          && /fa-arrow-right ace-qol-reaction-scene-arrow/.test(asPlayer)
          && /casts <span class="ace-qol-reaction-spell">Magic Missile<\/span> at you/.test(asPlayer)
          && gone.length === 0,
        err8 ? `threw: ${err8?.message ?? err8}`
          : `scene: ${/ace-qol-reaction-scene"/.test(asPlayer)}; mechanics still on it: ${gone.join(", ") || "none"}`);
      check("8. its heading is the filled shield emblem and the word Shield; its buttons say \"Cast Shield\" and \"Take damage\" (2026-09-18)",
        !err8 && /ace-qol-reaction-heading"[^>]*><i class="fas fa-shield-quartered"><\/i> Shield</.test(asPlayer)
          && /<span>Cast Shield<\/span>/.test(asPlayer) && /<span>Take damage<\/span>/.test(asPlayer),
        err8 ? `threw: ${err8?.message ?? err8}`
          : `emblem: ${/fa-shield-quartered/.test(asPlayer)}; yes: ${(/<span>([^<]*)<\/span>\s*<\/button>/.exec(asPlayer) ?? [])[1] ?? "?"}`);
      check("8. \"Consume spell slot\" is never on a player's box, and is on the GM's (2026-09-18)",
        !err8 && !/consume-slot-checkbox/.test(asPlayer) && /consume-slot-checkbox/.test(asGM)
          && /ace-qol-reaction-slot-select/.test(asPlayer),
        err8 ? `threw: ${err8?.message ?? err8}`
          : `player's box: ${/consume-slot-checkbox/.test(asPlayer) ? "HAS IT (wrong)" : "none"}; `
            + `GM's box: ${/consume-slot-checkbox/.test(asGM) ? "has it" : "missing (wrong)"}; `
            + `the player still picks a slot: ${/ace-qol-reaction-slot-select/.test(asPlayer)}`);
      check("8. the box dings when it opens, on the screen it opens on (2026-09-18)",
        !err8 && plays.length >= 1 && plays[0]?.channel === "interface",
        err8 ? `threw: ${err8?.message ?? err8}` : `dings: ${plays.length}; channel: ${plays[0]?.channel ?? "none"}`);

      // The look lives in the stylesheet: the no is a red pill with yellow
      // words, the yes wears the reaction's colour, and no label runs off.
      const src8 = readFileSync(`${ROOT}/Data/modules/ace-qol/scripts/reaction-engine.mjs`, "utf8");
      const rule = (sel) => { const at = src8.indexOf(`${sel} {`); return at < 0 ? "" : src8.slice(at, src8.indexOf("}", at)); };
      const no = rule(".ace-qol-reaction-decline"), yes = rule(".ace-qol-reaction-accept"),
        both = rule(".ace-qol-reaction-buttons > button");
      check("8. the no is always a red pill with yellow words outlined in black; the yes is a solid face in the reaction's own colour; a long label wraps instead of running off (2026-09-18)",
        /background: #c62828/.test(no) && /border-radius: 999px/.test(no) && /color: #ffd84d/.test(no)
          && /text-shadow: -1px -1px 0 #000/.test(no)
          && /background: var\(--ace-yes/.test(yes) && /color: var\(--ace-yes-ink, #ffffff\)/.test(yes)
          && /white-space: normal/.test(both) && !/white-space: nowrap/.test(both),
        `no: ${/#c62828/.test(no) && /999px/.test(no) ? "red pill" : "NOT a red pill"}; `
          + `yes: ${/--ace-yes/.test(yes) ? "the reaction's colour" : "NOT its colour"}; `
          + `labels: ${/white-space: normal/.test(both) ? "wrap" : "cannot wrap"}`);
    }
  } finally {
    ConditionDoor.apply = keep6a.apply;
    ConditionDoor.applyItemEffect = keep6a.applyFx;
    Door.post = keep6a.post;
    game.combat = keep6a.combat;
    canvas.tokens.placeables.length = 0;
    canvas.tokens.placeables.push(...keep6a.placed);
    if (keep6a.reactions === undefined) SETTINGS.delete("ace-qol.enableReactions"); else SETTINGS.set("ace-qol.enableReactions", keep6a.reactions);
    if (keep6a.shield === undefined) SETTINGS.delete("ace-qol.autoShield"); else SETTINGS.set("ace-qol.autoShield", keep6a.shield);
    for (const a of made6a) ACTORS.delete(a.id);
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
// ⚠️ EXIT WHEN THE CHECKS ARE DONE, NOT WHEN THE LAST TIMER IS. Every cast a
// pin makes now gets its own Counterspell hold (2026-09-18), each with a
// 30-second safety timer, and Node waits for all of them before it leaves:
// the replay sat idle for half a minute after its last line. Everything is
// written synchronously above, so nothing is cut short.
process.exit(fail ? 1 : 0);
