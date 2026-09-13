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
rmSync(scratch, { recursive: true, force: true });

// ⚠️ HIS SETTINGS, NOT DEFAULTS. A shape he corrected by hand lives in a world
// setting, and the replay has to see the same corrections his table does.
const SETTINGS = new Map();
for (const [k, v] of settingRows) {
  if (!k.startsWith("!settings!") || !v?.key) continue;
  let val = v.value;
  try { val = JSON.parse(v.value); } catch (_) { /* a plain string */ }
  SETTINGS.set(v.key, val);
}

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
  readActivities, readAppliedConditions, decideActivityChoice, upCanBeSeen, aceStripEnrichers;
try {
  ({ SpellPipeline } = await import(`${MODULE}/scripts/spell-pipeline/pipeline.mjs`));
  ({ SaveEngine } = await import(`${MODULE}/scripts/save-engine.mjs`));
  ({ PostHitSaves } = await import(`${MODULE}/scripts/post-hit-saves.mjs`));
  ({ DescriptionParser } = await import(`${MODULE}/scripts/description-parser.mjs`));
  ({ readSaveOutcome } = await import(`${MODULE}/scripts/inference/save-outcome-effects.mjs`));
  ({ readActivities, readAppliedConditions } = await import(`${MODULE}/scripts/read-activities.mjs`));
  ({ decideActivityChoice, upCanBeSeen } = await import(`${MODULE}/scripts/activity-choice.mjs`));
  ({ aceStripEnrichers } = await import(`${MODULE}/scripts/description-reader.mjs`));
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
function liveItem(raw, actor) {
  const uuid = `${actor.uuid}.Item.${raw._id}`;
  const item = { ...raw, id: raw._id, uuid, actor, parent: actor, flags: raw.flags ?? {},
    getFlag: (s, k) => raw.flags?.[s]?.[k], getRollData: () => ({}) };
  // ⚠️ A LIVE ITEM IS NOT ITS STORED COPY: a save's abilities are a Set live.
  const acts = new Collection(Object.entries(raw.system?.activities ?? {}).map(([k, a]) => {
    const id = a._id ?? k;
    return [id, { ...a, id, uuid: `${uuid}.Activity.${id}`, item, actor, parent: item,
      save: a.save ? { ...a.save, ability: asSet(a.save.ability) } : a.save }];
  }));
  const effects = new Collection((effectsByItem.get(`${actor.id}.${raw._id}`) ?? []).map(e => [e._id,
    { ...e, id: e._id, uuid: `${uuid}.ActiveEffect.${e._id}`, statuses: new Set(e.statuses ?? []),
      toObject() { return JSON.parse(JSON.stringify({ ...e, statuses: [...(e.statuses ?? [])] })); } }]));
  item.effects = effects;
  item.system = { ...raw.system, properties: new Set(raw.system?.properties ?? []), activities: acts };
  ITEMS.set(uuid, item);
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
      }
    });
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
console.log(`  (known open: ${codes} items whose hover, before the full text is ready, still shows raw codes)`);

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
