// ─── Through the save engine's real door: what lands on a creature? ─────────
//
// Johnny, 2026-09-11: Ray of Enfeeblement failed on Neferon and the card said
// "ACE applied nothing", with a blank box where the reason should have been.
//
// The readers are measured in save-outcome-selftest.mjs. This one proves the
// part that actually touches a creature: SaveEngine._applyFailedSaveConditions,
// the one method every save path goes through, fed the REAL spells out of the
// books, against a creature that records every effect put on it. And the card
// builder, fed what that method hands back.
//
// ⚠️ WRITTEN BECAUSE A READER THAT IS RIGHT PROVES NOTHING ABOUT THE DOOR. The
// Gate's immunity rule passed its own tests on 2026-09-10 while the save engine
// dropped the fields it needed on the way there.
//
// ⚠️ IT WRITES NOTHING AND TOUCHES NO WORLD DATA. The creatures are stand-ins.
//
// Run:  node tools/effect-apply-selftest.mjs
// ──────────────────────────────────────────────────────────────────────────────

import { pathToFileURL } from "node:url";
import { existsSync, cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";

const SYSTEM = "D:/FoundryVTT/Data/systems/dnd5e";
const LEVELDB = "D:/FoundryVTT/Foundry Virtual Tabletop/resources/app/node_modules/classic-level/index.js";
if (!existsSync(LEVELDB)) { console.log("classic-level not found beside Foundry; nothing to read."); process.exit(0); }
const { ClassicLevel } = await import(pathToFileURL(LEVELDB).href);

/* ── Enough of Foundry for the save engine to load and run ─────────────── */
const SETTINGS = { autoApplyConditions: true };
const GM = { id: "gm", isGM: true, name: "GM" };
const SCENES = {};
globalThis.game = { ready: true, packs: [], user: GM, users: Object.assign([GM], { activeGM: GM }),
  actors: { get: () => null, contents: [] }, scenes: { get: (id) => SCENES[id] ?? null },
  combat: null, time: { worldTime: 1000 },
  settings: { get: (_m, k) => (k in SETTINGS ? SETTINGS[k] : true), register: () => {} },
  i18n: { localize: (k) => k }, modules: { get: () => null } };
const hooks = {};
globalThis.Hooks = { on: (n, f) => { (hooks[n] ??= []).push(f); }, once: () => {}, off: () => {},
  call: () => true, callAll: () => {} };
globalThis.ui = { notifications: { info: () => {}, warn: () => {}, error: () => {} } };
globalThis.CONFIG = { DND5E: { abilities: { con: { label: "Constitution" }, wis: { label: "Wisdom" },
  cha: { label: "Charisma" }, dex: { label: "Dexterity" } }, skills: {}, damageTypes: {}, senses: {} },
  statusEffects: [], Canvas: { polygonBackends: {} } };
class _App { static DEFAULT_OPTIONS = {}; constructor() {} render() {} close() {} }
const esc = (x) => String(x ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;")
  .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
globalThis.foundry = {
  utils: { getProperty: () => null, setProperty: () => {}, escapeHTML: esc,
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

let SaveEngine, ConditionLibrary;
try {
  ({ SaveEngine } = await import("file:///D:/FoundryVTT/Data/modules/ace-qol/scripts/save-engine.mjs"));
  ({ ConditionLibrary } = await import("file:///D:/FoundryVTT/Data/modules/ace-qol/scripts/condition-library.mjs"));
} catch (err) {
  console.log("could not load the save engine under stubs:", err?.message ?? err);
  process.exit(2);
}

/* ── The real spells, out of the books ──────────────────────────────────── */
const scratch = mkdtempSync(join(tmpdir(), "ace-door-"));
const book = new Map();
{
  const dst = join(scratch, "spells24");
  cpSync(`${SYSTEM}/packs/spells24`, dst, { recursive: true, filter: (s) => basename(s) !== "LOCK" });
  const db = new ClassicLevel(dst, { valueEncoding: "json" });
  await db.open();
  const items = new Map(), effs = new Map();
  for await (const [k, v] of db.iterator()) {
    if (k.startsWith("!items!")) items.set(v._id, v);
    else if (k.startsWith("!items.effects!")) {
      const id = k.slice("!items.effects!".length).split(".")[0];
      if (!effs.has(id)) effs.set(id, []);
      effs.get(id).push(v);
    }
  }
  await db.close();
  for (const it of items.values()) book.set(it.name, { doc: it, effects: effs.get(it._id) ?? [] });
}
rmSync(scratch, { recursive: true, force: true });

/** A spell the way Foundry hands one over: collections, Sets, uuids. */
function liveSpell(name, { hollow = false } = {}) {
  const src = book.get(name);
  if (!src) throw new Error(`"${name}" is not in the 2024 book`);
  const base = `Actor.v.Item.${src.doc._id}`;
  const effects = src.effects.map(e0 => {
    const e = hollow ? { ...e0, changes: [], duration: { startTime: null, combat: null } } : e0;
    return { ...e, id: e._id, uuid: `${base}.ActiveEffect.${e._id}`, statuses: new Set(e.statuses ?? []),
      toObject() { return JSON.parse(JSON.stringify({ ...e, statuses: [...(e.statuses ?? [])] })); } };
  });
  const acts = new Map(Object.entries(src.doc.system?.activities ?? {})
    .map(([k, a]) => [k, { ...a, id: a._id ?? k }]));
  return { ...src.doc, id: src.doc._id, uuid: base, actor: { id: "v", name: "Varek Thalor" },
    effects: { contents: effects, get: (id) => effects.find(x => x.id === id) },
    system: { ...src.doc.system, properties: new Set(src.doc.system?.properties ?? []), activities: acts },
    getFlag: () => undefined };
}
const firstSave = (item) => [...item.system.activities.values()].find(a => a.type === "save")?.id ?? null;

/** A creature that records everything put on it. */
let nextId = 0;
function creature(name) {
  const effects = [];
  const actor = { id: name, name, uuid: `Actor.${name}`, documentName: "Actor", type: "npc",
    statuses: new Set(), effects: { contents: effects, get: (id) => effects.find(e => e.id === id) },
    system: { attributes: { hp: { value: 50, max: 50 } } } };
  const make = (d) => {
    const id = `e${++nextId}`;
    const eff = { ...d, id, uuid: `${actor.uuid}.ActiveEffect.${id}`, parent: actor, disabled: false,
      statuses: new Set(d.statuses ?? []), flags: d.flags ?? {},
      async delete() { const i = effects.indexOf(eff); if (i >= 0) effects.splice(i, 1); eff.deleted = true; } };
    effects.push(eff);
    return eff;
  };
  actor.createEmbeddedDocuments = async (_type, datas) => datas.map(make);
  actor._place = make;
  const token = { id: `t-${name}`, name, actor, actorId: actor.id, actorLink: false };
  SCENES.s = SCENES.s ?? { tokens: { list: [], get(id) { return this.list.find(t => t.id === id) ?? null; },
    get contents() { return this.list; } } };
  SCENES.s.tokens.list.push(token);
  return actor;
}
const result = (actor, passed) => ({ name: actor.name, tokenDocId: `t-${actor.name}`, actorId: actor.id,
  sceneId: "s", passed, pending: false, saveTotal: passed ? 25 : 12, dieResult: passed ? 20 : 10 });

// The condition library stands in: it records what it was asked for, and places
// a condition effect the way the real one does, so "ends with" can be followed.
const asked = [];
ConditionLibrary.applyByName = async (actor, cond, opts) => {
  asked.push(`${actor.name}:${cond}`);
  actor._place({ name: cond, statuses: [cond],
    flags: { "ace-qol": { concentrationOrigin: opts?.concentrationOrigin ?? null } } });
  return { ok: true, applied: cond };
};
SaveEngine._targetProfileFor = () => ({ immuneToCondition: () => false, hp: { value: 50, max: 50 } });
const engine = Object.create(SaveEngine.prototype);
const varek = { id: "v", name: "Varek Thalor" };

let pass = 0, fail = 0;
const check = (label, got, want) => {
  const ok = got === want;
  ok ? pass++ : fail++;
  console.log((ok ? "  ok   " : "  FAIL ") + label.padEnd(70) + `got ${got}, want ${want}`);
};
const withTimeout = (p, what) => Promise.race([p,
  new Promise((_r, rej) => setTimeout(() => rej(new Error(`${what} never finished`)), 8000))]);
const apply = (item, results, extra = {}) => withTimeout(engine._applyFailedSaveConditions(item, results,
  { saveAbility: "con", saveDC: 22, activityId: firstSave(item), casterActor: varek, ...extra }), item.name);
const own = (actor, name) => actor.effects.contents.filter(e => e.name === name && e.flags?.["ace-qol"]?.spellEffect);

/* ── 1. Ray of Enfeeblement ─────────────────────────────────────────────── */
console.log("1. RAY OF ENFEEBLEMENT (2024), THE SPELL JOHNNY CAST");
const ray = liveSpell("Ray of Enfeeblement");
const neferon = creature("Neferon");
const a1 = await apply(ray, [result(neferon, false)]);
const env = own(neferon, "Enervated")[0];
check("a failed save puts Enervated on him", !!env, true);
check("with all six of its rules", env?.changes?.length, 6);
check("and no condition riding along on the copy", env?.statuses?.size, 0);
check("it carries the end-of-turn repeat save", String(env?.flags?.["ace-qol"]?.repeatingSave?.trigger ?? ""), "endOfTurn");
check("against the spell's Constitution DC", `${env?.flags?.["ace-qol"]?.repeatingSave?.ability}/${env?.flags?.["ace-qol"]?.repeatingSave?.dc}`, "con/22");
check("it is tied to Varek's concentration", env?.flags?.["ace-qol"]?.concentrationOrigin?.spellName, "Ray of Enfeeblement");
check("for its own one minute", env?.duration?.seconds, 60);
check("the success effect is NOT put on a failure", own(neferon, "Brief Enfeeblement").length, 0);
check("the card is told Enervated landed", a1.find(a => a.tokenDocId === "t-Neferon")?.conditions?.join(","), "Enervated");
check("and that counts as the spell taking hold", SaveEngine._anythingLanded(a1), true);
await apply(ray, [result(neferon, false)]);
check("a second cast replaces it, never stacks", own(neferon, "Enervated").length, 1);

const specter = creature("Specter");
const a2 = await apply(ray, [result(specter, true)]);
const brief = own(specter, "Brief Enfeeblement")[0];
check("a successful save puts Brief Enfeeblement on", !!brief, true);
check("with no repeat save", !!brief?.flags?.["ace-qol"]?.repeatingSave, false);
check("and not tied to concentration", !!brief?.flags?.["ace-qol"]?.concentrationOrigin, false);
check("Enervated is NOT put on a success", own(specter, "Enervated").length, 0);
check("the card shows it as a save that still got something", a2[0]?.onSuccess, true);
check("which does not keep a caster concentrating", SaveEngine._anythingLanded(a2), false);

const hollow = liveSpell("Ray of Enfeeblement", { hollow: true });
const imp = creature("Imp");
await apply(hollow, [result(imp, false)]);
const hEnv = own(imp, "Enervated")[0];
check("Varek's emptied copy still lands, as words only", hEnv?.changes?.length, 0);
check("and takes the spell's minute when it lost its own", hEnv?.duration?.seconds, 60);

/* ── 2. Several results for one failure ─────────────────────────────────── */
console.log("\n2. A FAILURE WITH SEVERAL POSSIBLE RESULTS");
asked.length = 0;
const dw = liveSpell("Divine Word");
const ogre = creature("Ogre");
const a3 = await apply(dw, [result(ogre, false)], { saveAbility: "cha" });
check("Divine Word asks the condition library for nothing", asked.join(","), "");
check("and puts nothing on him, dead least of all", ogre.effects.contents.length, 0);
check("the card says why, for the GM", /possible results/.test(a3[0]?.declined ?? ""), true);
check("which does not count as the spell taking hold", SaveEngine._anythingLanded(a3), false);

asked.length = 0;
const con = liveSpell("Contagion");
const goblin = creature("Goblin");
const a4 = await apply(con, [result(goblin, false)]);
check("Contagion still poisons: every alternative shares it", asked.join(","), "Goblin:poisoned");
check("and tells the GM the ability is the caster's pick", /possible results/.test(a4[0]?.note ?? ""), true);

/* ── 3. A condition and rules together ──────────────────────────────────── */
console.log("\n3. HYPNOTIC PATTERN: CONDITIONS PLUS A SPEED OF 0");
asked.length = 0;
const hp = liveSpell("Hypnotic Pattern");
const orc = creature("Orc");
await apply(hp, [result(orc, false)], { saveAbility: "wis" });
check("Charmed and Incapacitated go through the condition library",
  asked.slice().sort().join(","), "Orc:charmed,Orc:incapacitated");
const hyp = own(orc, "Hypnotized")[0];
check("its own rules go on as well", (hyp?.changes?.length ?? 0) > 0, true);
check("without the conditions a second time", hyp?.statuses?.size, 0);
check("tied to both conditions it came with", hyp?.flags?.["ace-qol"]?.spellEffect?.endsWith?.length, 2);
const charm = orc.effects.contents.find(e => e.statuses.has("charmed") && !e.flags?.["ace-qol"]?.spellEffect);
const incap = orc.effects.contents.find(e => e.statuses.has("incapacitated") && !e.flags?.["ace-qol"]?.spellEffect);
await charm.delete();
SaveEngine._endLinkedSpellEffects(charm);
await new Promise(r => setTimeout(r, 10));
check("while Incapacitated is still on, the speed stays", own(orc, "Hypnotized").length, 1);
await incap.delete();
SaveEngine._endLinkedSpellEffects(incap);
await new Promise(r => setTimeout(r, 10));
check("when the last of them comes off, the speed comes off too", own(orc, "Hypnotized").length, 0);

/* ── 4. Reasons, not blanks ─────────────────────────────────────────────── */
console.log("\n4. EVERY CREATURE THAT FAILED AND GOT NOTHING HAS A REASON");
const plain = { name: "Scorching Test", type: "spell", id: "p", uuid: "Actor.v.Item.p", actor: varek,
  effects: { contents: [], get: () => null }, getFlag: () => undefined,
  system: { properties: new Set(), duration: { units: "inst" },
    description: { value: "<p>The target makes a Dexterity saving throw, taking 2d6 fire damage on a failed save.</p>" },
    activities: new Map([["a", { id: "a", type: "save", save: { ability: ["dex"] }, effects: [] }]]) } };
const wolf = creature("Wolf");
const a5 = await apply(plain, [result(wolf, false)], { saveAbility: "dex" });
check("a spell that carries nothing says so", /gives nothing ACE can put on/.test(a5[0]?.declined ?? ""), true);
SETTINGS.autoApplyConditions = false;
const bat = creature("Bat");
const a6 = await apply(ray, [result(bat, false)]);
check("automatic conditions switched off says so", /switched off/.test(a6[0]?.declined ?? ""), true);
check("and puts nothing on", bat.effects.contents.length, 0);
SETTINGS.autoApplyConditions = true;
check("a creature that PASSED is never given a refusal line",
  SaveEngine._declinedFor([result(bat, true)], "x").length, 0);

/* ── 5. The card ────────────────────────────────────────────────────────── */
console.log("\n5. THE CARD");
let html = "";
try {
  html = engine._buildPhase1CardHtml(dw, [result(ogre, false)], { saveAbility: "cha", saveDC: 22,
    hasDamage: false, appliedConditions: a3, activityId: firstSave(dw) });
} catch (err) { console.log("  (card builder threw: " + (err?.message ?? err) + ")"); }
check("the reason is on the card", /failed, and ACE put nothing on it/.test(html), true);
check("in a line only a GM is shown", /class="ace-qol-gm-only/.test(html), true);
check("with no command box in it", /<code/.test(html), false);
let html2 = "";
try {
  html2 = engine._buildPhase1CardHtml(ray, [result(neferon, false)], { saveAbility: "con", saveDC: 22,
    hasDamage: false, appliedConditions: a1, activityId: firstSave(ray) });
} catch (err) { console.log("  (card builder threw: " + (err?.message ?? err) + ")"); }
check("a landed effect is named on the card", /Enervated/.test(html2), true);
check("and no refusal line when it landed", /ace-qol-gm-only ace-qol-save-gm-reason/.test(html2), false);

/* ── 6. Who an area catches ─────────────────────────────────────────────── */
console.log("\n6. WHO AN AREA CATCHES");
check("Prismatic Spray: the area decides", SaveEngine._areaWhoRule(liveSpell("Prismatic Spray")).kind, "everyone");
const slow = SaveEngine._areaWhoRule(liveSpell("Slow"));
check("Slow: the caster picks", slow.kind, "pick");
check("Slow: up to six", slow.count, 6);
check("Spirit Guardians: today's rule is kept", SaveEngine._areaWhoRule(liveSpell("Spirit Guardians")).kind, "legacy");

/* ── 7. Prismatic Wall: a spell with several saves ──────────────────────── */
console.log("\n7. PRISMATIC WALL: EACH SAVE IS ITS OWN RESULT");
const { effectDuration } = await import(
  "file:///D:/FoundryVTT/Data/modules/ace-qol/scripts/read-activities.mjs");
const told = [];
ConditionLibrary.applyByName = async (actor, cond, opts) => {
  told.push({ who: actor.name, cond, opts: opts ?? {} });
  actor._place({ name: cond, statuses: [cond], flags: {} });
  return { ok: true, applied: cond };
};
// The pipeline's worked-out guess for this spell carries "blinded" as its effect,
// exactly as it did at his table. A guess must not act as a ruling.
game.aceQol = { SpellPipeline: { _getEntry: (it) => (it?.name === "Prismatic Wall"
  ? { shape: "template-trigger", inferred: true, effect: { key: "blinded" } } : null) } };
const wallSpell = liveSpell("Prismatic Wall");
const saveId = (it, n) => [...it.system.activities.values()].find(a => a.name === n)?.id;
const troll = creature("Troll");
await apply(wallSpell, [result(troll, false)], { activityId: saveId(wallSpell, "Blinding Save") });
check("the Blinding Save puts on Blinded, and only Blinded", told.map(t => t.cond).join(","), "blinded");
check("for its own one minute", told[0]?.opts?.duration?.seconds, 60);
check("with no repeat save (that belongs to the Indigo layer)", !!told[0]?.opts?.repeatingSave, false);
told.length = 0;
const wallHollow = liveSpell("Prismatic Wall", { hollow: true });
const ghoul = creature("Ghoul");
await apply(wallHollow, [result(ghoul, false)], { activityId: saveId(wallHollow, "Blinding Save") });
check("Varek's copy, which lost the number, still lasts its minute",
  told[0]?.opts?.duration?.seconds, 60);
told.length = 0;
const wight = creature("Wight");
const a7 = await apply(wallSpell, [result(wight, false)],
  { activityId: saveId(wallSpell, "Traversal Save"), saveAbility: "dex" });
check("the Traversal Save puts on no layer by itself", told.length, 0);
check("and says the layer is the GM's to apply", /possible results/.test(a7[0]?.declined ?? ""), true);
game.aceQol = undefined;
check("the card names the spell as well as the save",
  engine._abilityLabel(wallSpell, saveId(wallSpell, "Blinding Save")), "Prismatic Wall: Blinding Save");
check("words are read when the number is gone",
  effectDuration({ duration: {}, description: "<p>Blinded for 1 minute.</p>" })?.seconds, 60);
check("and nothing is invented when neither says",
  effectDuration({ duration: {}, description: "<p>Until the start of your next turn.</p>" }), null);

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
