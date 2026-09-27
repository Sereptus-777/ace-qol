// ─── A WEAPON'S DAMAGE CARRIES EVERYTHING THE ACTIVITY GIVES IT ─────────────
//
// ⚠️ WHY THIS EXISTS. Three nights of his table, one weapon, three separate holes,
// every one of them silent (2026-09-26 and 27, Jeth's Bladed Whip (Rare) v3):
//
//   1. THE ABILITY MODIFIER. ACE handed getDamageConfig the ITEM's roll data.
//      dnd5e sets `mod` in exactly one place, Activity#getRollData (dnd5e.mjs:17836),
//      and getDamageConfig only builds its own when handed none (`rollData ??=`,
//      dnd5e.mjs:12543). So passing the item's in did not merely miss the modifier,
//      it stopped dnd5e from working it out: `@mod` went into the formula and
//      resolved against a roll data with no such key, which is zero. Every weapon
//      in his world swung at +0 while its to-hit was correct, because getAttackData
//      asks for its own roll data and takes none from us.
//
//   2. THE OFF-HAND STRIP. dnd5e remembers the last attack mode on the item and
//      silently reuses it (dnd5e.mjs:28461). His whip carries `attackMode: "offhand"`
//      from a swing months ago, so every press since was rolled off-hand, the
//      modifier was stripped from its damage RAW, and nothing on screen said so.
//      ACE now decides off-hand from the turn's own facts: the first weapon a
//      creature attacks with is its action weapon and is never an off-hand swing.
//
//   3. THE MAGIC BONUS. The card read its +1 off `system.magicalBonus` while the
//      roll never carried it, because the whip requires attunement and is not
//      attuned, so dnd5e withholds it (magicAvailable, dnd5e.mjs:13862). A correct
//      total looked short by one and the only explanation was a console line.
//
// ⚠️ WHAT IS REAL HERE. DamageCalculator.rollDamageComponents, the recipe reader,
// _landRecipeHit, the off-hand mark and MultiattackEngine's own trigger are ACE's
// shipped code. The activity is stood in, and it behaves the way dnd5e's does,
// including the three gates above, each quoted at its line. Jeth's abilities and
// his equipped weapons are read from hijinx when this machine has it; a machine
// without his world uses the same numbers so the pins still mean something.
//
// Every die shows its lowest face, so the totals are exact and the same every run.
import { existsSync, mkdtempSync, cpSync } from "node:fs";
import { join, basename } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

const MODULE = "file:///D:/FoundryVTT/Data/modules/ace-qol";
const WORLD = "D:/FoundryVTT/Data/worlds/hijinx/data";
const LEVELDB = "D:/FoundryVTT/Foundry Virtual Tabletop/resources/app/node_modules/classic-level/index.js";
const DIE = 1;                    // every die shows a 1

let pass = 0, fail = 0;
const check = (label, ok, detail = "") => {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${String(label).padEnd(58)} ${detail}`);
};

/* ══ the least Foundry these files need to load ═══════════════════════════ */
const hooks = new Map();
globalThis.Hooks = {
  on: (n, fn) => { if (!hooks.has(n)) hooks.set(n, []); hooks.get(n).push(fn); },
  once: () => {}, callAll: () => {}, call: () => true,
};
globalThis.CONFIG = { DND5E: { abilities: { str: {}, dex: {}, con: {}, int: {}, wis: {}, cha: {} },
  damageTypes: {}, healingTypes: {}, itemProperties: {} }, Dice: {} };
globalThis.ui = { notifications: { warn: () => {}, error: () => {}, info: () => {} } };
const el = () => ({ classList: { add() {}, remove() {}, contains: () => false }, dataset: {}, style: {},
  children: [], appendChild() {}, remove() {}, setAttribute() {}, getAttribute: () => null,
  addEventListener() {}, querySelector: () => null, querySelectorAll: () => [], closest: () => null,
  insertAdjacentHTML() {}, textContent: "", innerHTML: "" });
globalThis.document = { querySelector: () => null, querySelectorAll: () => [], createElement: el,
  body: el(), head: el(), addEventListener() {} };
globalThis.window = globalThis;
class AppStub { static DEFAULT_OPTIONS = {}; static PARTS = {}; render() {} close() {} }
globalThis.foundry = {
  applications: { api: { ApplicationV2: AppStub, HandlebarsApplicationMixin: (b) => b, DialogV2: AppStub },
    ux: { TextEditor: { implementation: { enrichHTML: async (s) => s } } }, sheets: {},
    handlebars: { renderTemplate: async () => "" } },
  appv1: { api: { Application: AppStub, Dialog: AppStub, FormApplication: AppStub } },
  abstract: { DataModel: AppStub, TypeDataModel: AppStub }, data: { fields: {} },
  documents: { collections: {} }, canvas: { placeables: {} },
  utils: {
    getProperty: (o, p) => p.split(".").reduce((x, k) => x?.[k], o),
    setProperty: (o, p, v) => { const ks = p.split("."); let x = o;
      for (const k of ks.slice(0, -1)) x = (x[k] ??= {}); x[ks.at(-1)] = v; return true; },
    deepClone: (o) => (o && typeof o === "object" ? structuredClone(o) : o),
    mergeObject: (a, b) => ({ ...a, ...b }), randomID: () => "x",
  },
};
globalThis.game = { ready: true, user: { isGM: true, id: "gm" }, users: [],
  settings: { get: () => undefined, set: async () => {}, register: () => {} },
  modules: new Map(), system: { id: "dnd5e", version: "5.x" }, actors: new Map(), items: new Map(),
  i18n: { localize: (k) => k, format: (k) => k, getListFormatter: () => ({ format: (a) => a.join(", ") }) },
  combat: null, combats: [], time: { worldTime: 0 } };
globalThis.canvas = { ready: false, tokens: { placeables: [] }, scene: null, grid: {}, dimensions: {} };
globalThis.fromUuid = async () => null;
globalThis.fromUuidSync = () => null;
globalThis.Roll = class Roll {
  constructor(formula, data) { this.formula = String(formula ?? "0"); this.data = data ?? {}; this.terms = []; }
  get isDeterministic() { return !/\d*d\d+/i.test(this.formula); }
  async evaluate() {
    const terms = [];
    // @refs resolve from the data handed in; an unknown one is 0, as Foundry does.
    let expr = String(this.formula).replace(/@([a-zA-Z_][\w.]*)/g, (_m, path) =>
      String(Number(path.split(".").reduce((x, k) => x?.[k], this.data)) || 0));
    expr = expr.replace(/(\d*)d(\d+)/gi, (_m, n, faces) => {
      const count = Number(n || 1);
      terms.push({ faces: Number(faces), number: count, total: count * DIE,
        results: Array.from({ length: count }, () => ({ result: DIE, active: true })) });
      return String(count * DIE);
    });
    let total = 0, sign = 1;
    for (const tok of expr.replace(/[()\s]/g, "").split(/([+-])/)) {
      if (tok === "+") sign = 1; else if (tok === "-") sign = -1;
      else if (tok) total += sign * (Number(tok) || 0);
    }
    this.total = total; this.terms = terms; this._evaluated = true;
    return this;
  }
};

/* ══ Jeth, from his world when this machine has it ════════════════════════ */
let STR = 4, DEX = 5, fromWorld = false, storedMode = null;
if (existsSync(join(WORLD, "actors", "CURRENT")) && existsSync(LEVELDB)) {
  const { ClassicLevel } = await import(pathToFileURL(LEVELDB).href);
  const dst = join(mkdtempSync(join(tmpdir(), "ace-wdm-")), "actors");
  cpSync(join(WORLD, "actors"), dst, { recursive: true, filter: (s) => basename(s) !== "LOCK" });
  const db = new ClassicLevel(dst, { valueEncoding: "json" });
  await db.open();
  let jethId = null, jeth = null;
  for await (const [k, v] of db.iterator()) {
    if (v?.name === "Jeth" && v?.type === "character") { jeth = v; jethId = k.split("!")[2]; }
  }
  if (jeth) {
    // Ability MODIFIERS are derived at load; the stored row keeps values.
    const m = (a) => Number(a?.mod ?? Math.floor((Number(a?.value ?? 10) - 10) / 2));
    STR = m(jeth.system?.abilities?.str);
    DEX = m(jeth.system?.abilities?.dex);
    fromWorld = true;
    for await (const [k, v] of db.iterator()) {
      if (!k.startsWith("!actors.items!") || !k.includes(jethId)) continue;
      if (!/Bladed Whip/.test(v?.name ?? "")) continue;
      const last = v.flags?.dnd5e?.last ?? {};
      storedMode = Object.values(last)[0]?.attackMode ?? null;
    }
  }
  await db.close();
}
const BEST = Math.max(STR, DEX);
console.log(`\nA WEAPON'S DAMAGE CARRIES EVERYTHING THE ACTIVITY GIVES IT`);
console.log(`  Jeth: STR ${STR >= 0 ? "+" : ""}${STR}, DEX ${DEX >= 0 ? "+" : ""}${DEX}`
  + `${fromWorld ? " (read from hijinx)" : " (his world is not on this machine; the same numbers stood in)"}`);
console.log(`  every die shows a ${DIE}\n`);

/* ══ an activity that behaves the way dnd5e's does ════════════════════════ */
const actor = {
  id: "jeth", name: "Jeth", type: "character", uuid: "Actor.jeth",
  system: { abilities: { str: { mod: STR }, dex: { mod: DEX } },
    attributes: { prof: 4, hp: { value: 50, max: 50 } }, bonuses: {} },
  items: [], effects: [], statuses: new Set(), flags: {},
  getFlag: () => undefined, setFlag: async () => {}, unsetFlag: async () => {},
  getRollData: () => ({ abilities: actor.system.abilities, attributes: actor.system.attributes, prof: 4 }),
};

const damagePart = (spec) => {
  const [dice, type] = spec.split(" ");
  const m = /^(\d*)d(\d+)$/.exec(dice);
  return { number: m ? Number(m[1] || 1) : null, denomination: m ? Number(m[2]) : null,
    bonus: "", types: new Set([type]), custom: { enabled: !m, formula: m ? "" : dice },
    scaledFormula: () => (m ? `${Number(m[1] || 1)}d${m[2]}` : dice) };
};

/**
 * A LIVE dnd5e 5.x weapon. prepareFinalData (dnd5e.mjs:28157) has already
 * unshifted the base part into the activity's parts and marked it base, which is
 * why a stored `parts: []` is not what the roll-time code sees.
 */
function weapon({ name, base, extras = [], magic = 0, finesse = false,
                  attunement = "", attuned = false }) {
  const basePart = { ...damagePart(base), base: true };
  const extraParts = extras.map(damagePart);
  const mgc = magic > 0;
  const item = {
    id: `it-${name}`, name, type: "weapon", img: "", uuid: `Item.it-${name}`, actor,
    // ⚠️ EQUIPPED, or the pop-up's pairable list is empty and the last pin below
    // passes for the wrong reason: nothing offered rather than the right thing.
    system: { properties: new Set([...(finesse ? ["fin"] : []), ...(mgc ? ["mgc"] : []), "lgt"]),
      equipped: true, actionType: "mwak", magicalBonus: magic, attunement, attuned,
      // dnd5e.mjs:13862, copied exactly.
      get magicAvailable() { return (attuned || attunement !== "required") && mgc; },
      type: { value: "martialM" }, offersBaseDamage: true, isVersatile: false,
      damage: { base: { ...basePart }, versatile: { types: new Set() } }, activities: null },
    getRollData: () => ({ ...actor.getRollData(), item: { ...item.system } }),
    getFlag: () => undefined,
  };
  const activity = {
    id: `act-${name}`, type: "attack", item, actor,
    attack: { type: { classification: "weapon", value: "melee" }, ability: "" },
    damage: { includeBase: true, parts: [basePart, ...extraParts] },
    // dnd5e.mjs:28005 — an unset ability resolves to the better available one.
    get ability() { return finesse ? (DEX >= STR ? "dex" : "str") : "str"; },
    // dnd5e.mjs:17832 — the ONE place a top-level mod is set.
    getRollData() {
      const rd = item.getRollData();
      rd.activity = { ...this };
      rd.mod = actor.system.abilities?.[this.ability]?.mod ?? 0;
      return rd;
    },
    // dnd5e.mjs:12539 — note the `??=`: a roll data handed in stops the line above.
    getDamageConfig(config = {}, { rollData } = {}) {
      if (!this.damage?.parts) return { rolls: [], ...config };
      const out = { ...config };
      rollData ??= this.getRollData();
      out.rolls = this.damage.parts
        .map((d, i) => this._processDamagePart(d, out, rollData, i))
        .filter(d => d.parts.length);
      return out;
    },
    // dnd5e.mjs:28324 — the weapon branch: @mod, then @magicalBonus if available.
    _processDamagePart(damage, rollConfig, rollData) {
      const scaled = damage.scaledFormula();
      const roll = { parts: scaled ? [scaled] : [], data: { ...rollData }, base: !!damage.base,
        options: { type: [...damage.types][0], types: [...damage.types], properties: [] } };
      if (!damage.base) return roll;                 // an extra part takes no modifier
      if (!/\d*d\d+/i.test(roll.parts[0] ?? "")) return roll;   // a flat value takes none
      if (!roll.parts.some(p => p.includes("@mod"))) roll.parts.push("@mod");
      if (magic && item.system.magicAvailable) {
        roll.parts.push("@magicalBonus");
        roll.data.magicalBonus = magic;
      }
      return roll;
    },
  };
  item.system.activities = new Map([[activity.id, activity]]);
  actor.items.push(item);
  return { item, activity };
}

const { DamageCalculator } = await import(`${MODULE}/scripts/damage-calculator.mjs`);
const { CombatState } = await import(`${MODULE}/scripts/combat-state.mjs`);
const { MultiattackEngine } = await import(`${MODULE}/scripts/multiattack-engine.mjs`);

async function rolled(made) {
  const comps = await DamageCalculator.rollDamageComponents(
    made.item, actor, { hit: true }, false, "raw", made.activity.id);
  return { comps, total: comps.reduce((n, c) => n + (Number(c.total) || 0), 0), meta: comps[0]?._modMeta };
}

/* ══ 1. THE ABILITY MODIFIER ══════════════════════════════════════════════ */
console.log("THE ABILITY MODIFIER REACHES THE DAMAGE");
{
  const whip = weapon({ name: "Bladed Whip", base: "1d4 slashing", magic: 1, finesse: true,
    attunement: "required", attuned: true });
  const rapier = weapon({ name: "Rapier", base: "1d8 piercing", finesse: true });
  const flat = weapon({ name: "Bite (flat)", base: "1 piercing" });

  const w = await rolled(whip);
  check("the whip's hit is its die + the finesse modifier + its magic bonus",
    w.total === DIE + BEST + 1, `${w.comps[0]?.formula} = ${w.total}, wanted ${DIE + BEST + 1}`);
  check("the modifier lands ONCE, not twice",
    w.total !== DIE + BEST + BEST + 1, `twice would be ${DIE + BEST + BEST + 1}`);

  const r = await rolled(rapier);
  check("a rapier is its die + the modifier",
    r.total === DIE + BEST, `${r.comps[0]?.formula} = ${r.total}, wanted ${DIE + BEST}`);

  // ⚠️ dnd5e gives no modifier to a damage with no dice, and neither does ACE.
  const f = await rolled(flat);
  check("a flat 1 stays 1: a dice-less damage takes no modifier",
    f.total === 1, `${f.comps[0]?.formula} = ${f.total}`);

  // ⚠️ THE SHAPE THAT CAUSED IT. An activity with no getRollData is the old
  // behaviour: ACE keeps the item's roll data, which has no `mod` at all.
  const bare = weapon({ name: "Whip (no activity roll data)", base: "1d4 slashing", finesse: true });
  delete bare.activity.getRollData;
  const b = await rolled(bare);
  check("and without the activity's roll data the modifier is gone, as it was",
    b.total === DIE, `${b.comps[0]?.formula} = ${b.total}: this is the bug, pinned so it cannot come back quietly`);
}

/* ══ 2. THE MAGIC BONUS, AND WHAT THE CARD SAYS ═══════════════════════════ */
console.log("\nA MAGIC BONUS THE WIELDER IS NOT ENTITLED TO IS NOT PRINTED");
{
  const notAttuned = weapon({ name: "Whip (not attuned)", base: "1d4 slashing", magic: 1,
    finesse: true, attunement: "required", attuned: false });
  const attuned = weapon({ name: "Whip (attuned)", base: "1d4 slashing", magic: 1,
    finesse: true, attunement: "required", attuned: true });
  const noAttuneNeeded = weapon({ name: "Rapier +3", base: "1d8 piercing", magic: 3, finesse: true });

  const n = await rolled(notAttuned);
  check("an unattuned item that requires attunement gives no bonus",
    n.total === DIE + BEST, `${n.comps[0]?.formula} = ${n.total}, wanted ${DIE + BEST}`);
  check("and the card says NO MAGIC with the reason, instead of printing the bonus",
    n.meta?.magicBonus === 0 && n.meta?.magicWithheld === "not attuned",
    `magicBonus=${n.meta?.magicBonus}, withheld="${n.meta?.magicWithheld}", stored=${n.meta?.magicStored}`);

  const a = await rolled(attuned);
  check("attuned, the bonus lands and the card prints it",
    a.total === DIE + BEST + 1 && a.meta?.magicBonus === 1 && !a.meta?.magicWithheld,
    `${a.comps[0]?.formula} = ${a.total}, MAGIC=${a.meta?.magicBonus}`);

  const m = await rolled(noAttuneNeeded);
  check("a magic weapon needing no attunement keeps its bonus with nothing ticked",
    m.total === DIE + BEST + 3 && m.meta?.magicBonus === 3,
    `${m.comps[0]?.formula} = ${m.total}`);
}

/* ══ 3. EVERY PART THE ACTIVITY HAS ═══════════════════════════════════════ */
console.log("\nEVERY TYPED PART THE ACTIVITY CARRIES KEEPS ITS OWN LINE");
{
  // 509 weapons in hijinx carry an extra typed part like this one.
  const bite = weapon({ name: "Bite (poison)", base: "1d6 piercing", extras: ["2d6 poison"] });
  const b = await rolled(bite);
  check("a second damage type is its own component, with its own type",
    b.comps.length === 2 && b.comps.some(c => c.type === "piercing") && b.comps.some(c => c.type === "poison"),
    b.comps.map(c => `${c.formula}=${c.total} ${c.type}`).join(" | "));
  check("the base part takes the modifier and the extra part does not",
    b.total === DIE + STR + 2 * DIE, `${b.total}, wanted ${DIE + STR + 2 * DIE}`);
}

/* ══ 4. OFF-HAND IS THE TURN'S ANSWER, NOT THE ITEM'S MEMORY ══════════════ */
console.log("\nA SHEET PRESS IS MAIN-HAND, WHATEVER THE ITEM REMEMBERS");
if (storedMode) console.log(`  (his whip still stores attackMode "${storedMode}")`);
{
  MultiattackEngine.init();
  const trigger = (hooks.get("dnd5e.rollAttackV2") ?? [])[0];
  // Only these two in his hands, so the offer pin below names the weapon it means
  // instead of reaching one of the earlier sections' stand-ins.
  actor.items.length = 0;
  const whip = weapon({ name: "Whip (press)", base: "1d4 slashing", magic: 1, finesse: true });
  const dagger = weapon({ name: "Dagger (second hand)", base: "1d4 piercing", finesse: true });
  const reset = () => { MultiattackEngine._actionWeapon.clear();
    for (const i of actor.items) CombatState.clearOffhandSwing(i.uuid); };
  const swing = (made, mode) => trigger([{ options: { attackMode: mode } }],
    { subject: { item: made.item, actor, id: made.activity.id } });

  check("the trigger is registered at all", !!trigger, trigger ? "dnd5e.rollAttackV2" : "nothing listening");
  if (trigger) {
    reset();
    swing(whip, "offhand");            // dnd5e asking off-hand off the remembered flag
    check("a press of the action weapon is main-hand even when dnd5e asks off-hand",
      CombatState.isOffhandSwing(whip.item.uuid) === false);

    swing(dagger, "offhand");           // a genuine second weapon
    check("a DIFFERENT weapon asking for off-hand still is off-hand",
      CombatState.isOffhandSwing(dagger.item.uuid) === true);
    check("and the action weapon beside it is still main-hand",
      CombatState.isOffhandSwing(whip.item.uuid) === false);

    reset();
    CombatState.markOffhandSwing(whip.item.uuid);   // an off-hand swing seconds ago
    swing(whip, "oneHanded");                        // now it is his action
    check("a stale off-hand mark cannot bleed into a main-hand press",
      CombatState.isOffhandSwing(whip.item.uuid) === false);

    reset();
    MultiattackEngine._inFlight.add(actor.id);
    CombatState.markOffhandSwing(dagger.item.uuid);  // what _fireAttack does
    swing(dagger, "oneHanded");
    MultiattackEngine._inFlight.delete(actor.id);
    check("the pop-up's own off-hand button wins even when it goes first",
      CombatState.isOffhandSwing(dagger.item.uuid) === true);

    // And the offer: never the weapon he just attacked with.
    reset();
    swing(whip, "offhand");
    const offers = MultiattackEngine._getBonusAttacks(actor);
    const off = offers.find(o => o.kind === "offhand");
    check("the pop-up offers a DIFFERENT weapon, never the one he attacked with",
      !!off && off.id !== whip.item.id, off ? `offers ${off.name}` : "offered nothing at all");
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
// A timer in the import chain keeps node alive; the pins are done.
process.stdout.write("", () => process.exit(fail ? 1 : 0));
