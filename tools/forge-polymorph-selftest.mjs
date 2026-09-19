// ─── Forge's polymorph trap: its save comes back, and nothing lands first ─────
//
// ⚠️ WHY THIS EXISTS. Proven from the code on 2026-09-19: with ACE QOL running,
// Forge's polymorph trap never resolved a single save. It asked dnd5e for the
// save with the dialog suppressed but a chat card still wanted, and ACE's check
// gate cancels exactly that save and rolls it through its own pause and card.
// dnd5e then hands its caller null, so every creature in the glyph came back
// "the saving throw could not be rolled" while ACE posted a card nobody acted
// on. The same hole had just made the concentration button re-arm itself
// (0.34.74). And a luck point spent on a save through ACE's own door changed
// the total on the card but not the roll anybody got back.
//
// This runs the shipped code: Forge's polymorph pipeline and its dice wait,
// ACE's check gate, its luck, its dice helpers and its picker rule. Two things
// are stood in, and the real one is read each time to keep the stand-in honest:
//   • dnd5e's save, by a copy of what the installed system does, after every
//     fact the copy leans on is read out of that system's own source, so a
//     dnd5e that changes fails here instead of passing against a stale copy;
//   • ACE's card door, which pulls in the whole module, by a card that does
//     what the real one does in the same order (throw the dice, wait for them,
//     post), with the real one read to prove that order.
//
// Run:  node tools/forge-polymorph-selftest.mjs
import { readFileSync } from "node:fs";

const ROOT = "D:/FoundryVTT/Data";
const QOL = `${ROOT}/modules/ace-qol/scripts`;
const FORGE = `${ROOT}/modules/ace-artificer/scripts`;
const url = (p) => `file:///${p}`;

let pass = 0, fail = 0;
const check = (label, ok, detail = "") => {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${detail ? `   (${detail})` : ""}`);
};

/** A function's source, from its signature to its closing brace. */
function bodyOf(src, prefix) {
  const at = src.indexOf(prefix);
  if (at < 0) return "";
  const open = src.indexOf(") {", at);
  if (open < 0) return "";
  let depth = 0;
  for (let i = open + 2; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") { depth--; if (depth === 0) return src.slice(at, i + 1); }
  }
  return "";
}
/** Comments out, so a rule cannot be "present" in prose. */
const bare = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
const flat = (s) => s.replace(/\s+/g, " ");

/* ── What dnd5e does with a save, read from the installed system ─────────── */
console.log("\nWHAT dnd5e DOES WITH A SAVE, READ FROM THE INSTALLED SYSTEM");
const sysSrc = readFileSync(`${ROOT}/systems/dnd5e/dnd5e.mjs`, "utf8");
const sysVersion = /"version":\s*"([^"]+)"/.exec(readFileSync(`${ROOT}/systems/dnd5e/system.json`, "utf8"))?.[1] ?? "?";
const d20Test = flat(bodyOf(sysSrc, "async #rollD20Test("));
const buildConfigure = flat(bodyOf(sysSrc, "static async buildConfigure("));
const buildPost = flat(bodyOf(sysSrc, "static async buildPost("));
check(`a saving throw's hook names end "SavingThrow", "d20Test" (dnd5e ${sysVersion})`,
  d20Test.includes(`const name = type === "check" ? "AbilityCheck" : "SavingThrow";`)
    && d20Test.includes(`rollConfig.hookNames = [...(config.hookNames ?? []), name, "d20Test"];`),
  d20Test ? "read from #rollD20Test" : "#rollD20Test was not found in dnd5e.mjs");
check("its chat card is asked for unless the caller says create: false",
  d20Test.includes("const messageConfig = foundry.utils.mergeObject({ create: true,"),
  "the message config starts from create: true and takes the caller's on top");
check("a hook on the d20 test that answers false stops the roll, and it sees the caller's own dialog flag",
  buildConfigure.includes("if ( Hooks.call(`dnd5e.preRoll${hookName.capitalize()}V2`, config, dialog, message) === false ) return [];")
    && buildConfigure.indexOf("=== false ) return [];") < buildConfigure.indexOf("this.applyKeybindings(config, dialog, message);"),
  "the pre-roll hooks run before dnd5e fills in any default");
check("and when that stops it, dnd5e hands its caller null",
  d20Test.includes("if ( !rolls.length ) return null;"), "read from #rollD20Test");
check("every roll-configuration hook gets the rolls and the config, and may refuse",
  buildConfigure.includes("const name = `dnd5e.post${hookName.capitalize()}RollConfiguration`;")
    && buildConfigure.includes("if ( Hooks.call(name, rolls, config, dialog, message) === false ) return [];"),
  "read from buildConfigure");
check("the card is created only when create is not false",
  buildPost.includes(`message[message.create !== false ? "document" : "data"] = await this.toMessage(`),
  "read from buildPost");

/* ── Foundry, as much of it as these files touch ─────────────────────────── */
const HOOKS = new Map();
const hookErrors = [];
let hookSeq = 0;
globalThis.Hooks = {
  on(name, fn) { const id = ++hookSeq; if (!HOOKS.has(name)) HOOKS.set(name, []); HOOKS.get(name).push({ id, fn }); return id; },
  once(name, fn) { const id = Hooks.on(name, (...a) => { Hooks.off(name, id); return fn(...a); }); return id; },
  off(name, key) {
    const list = HOOKS.get(name) ?? [];
    const i = list.findIndex(h => h.id === key || h.fn === key);
    if (i >= 0) list.splice(i, 1);
  },
  // Foundry's own contract: in the order registered, stopping at the first false.
  call(name, ...args) {
    for (const h of [...(HOOKS.get(name) ?? [])]) {
      try { if (h.fn(...args) === false) return false; } catch (err) { hookErrors.push({ name, err }); }
    }
    return true;
  },
  callAll(name, ...args) {
    for (const h of [...(HOOKS.get(name) ?? [])]) {
      try { h.fn(...args); } catch (err) { hookErrors.push({ name, err }); }
    }
    return true;
  },
};
globalThis.window = globalThis;
globalThis.addEventListener = () => {};
globalThis.document = {
  addEventListener() {}, querySelector: () => null, querySelectorAll: () => [],
  createElement: () => ({ style: {}, classList: { add() {} }, appendChild() {}, setAttribute() {} }),
  head: { appendChild() {} }, body: { appendChild() {} },
};
class _App {}
globalThis.foundry = {
  utils: {
    escapeHTML: (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])),
    deepClone: (o) => structuredClone(o), mergeObject: (a, b) => Object.assign(a, b),
  },
  applications: { api: { ApplicationV2: _App, HandlebarsApplicationMixin: (C) => C, DialogV2: class {} }, ux: {}, sheets: {} },
  data: { regionBehaviors: { RegionBehaviorType: class {} }, fields: new Proxy({}, { get: () => class {} }) },
};
const CONST_BASE = {
  DOCUMENT_OWNERSHIP_LEVELS: { NONE: 0, LIMITED: 1, OBSERVER: 2, OWNER: 3 },
  DICE_ROLL_MODES: { PUBLIC: "publicroll", PRIVATE: "gmroll", BLIND: "blindroll", SELF: "selfroll" },
};
globalThis.CONST = new Proxy(CONST_BASE, { get: (t, k) => (k in t ? t[k] : new Proxy({}, { get: () => 0 })) });
globalThis.CONFIG = {
  DND5E: { abilities: { wis: { label: "Wisdom" }, dex: { label: "Dexterity" }, con: { label: "Constitution" } } },
  Actor: { documentClass: class { async rollInitiativeDialog() {} } },
};
const toasts = [];
globalThis.ui = { notifications: {
  info: (m) => toasts.push(["info", m]), warn: (m) => toasts.push(["warn", m]), error: (m) => toasts.push(["error", m]) } };

// What happened, in the order it happened: dice thrown and landed, cards, beasts.
const timeline = [];
const note = (what) => timeline.push(what);
const at = (prefix) => timeline.findIndex(t => t.startsWith(prefix));
const DSN_MS = 30;

const GM = { id: "gm", name: "Johnny", isGM: true, active: true };
const users = Object.assign([GM], { get: (id) => users.find(u => u.id === id) ?? null });
const MESSAGES = new Map();
let msgSeq = 0;
const SETTINGS = { "ace-artificer.polymorphMethod": "visual" };
globalThis.game = {
  user: GM, users, actors: [], time: { worldTime: 0 },
  i18n: { localize: (k) => k, format: (k) => k },
  settings: { get: (m, k) => SETTINGS[`${m}.${k}`], register: () => {} },
  modules: new Map([["ace-qol", { id: "ace-qol", active: true }]]),
  messages: { get: (id) => MESSAGES.get(id) ?? null },
  // Dice So Nice: a thrown roll lands DSN_MS later and says so.
  dice3d: {
    isEnabled: () => true,
    showForRoll: (roll) => {
      note(`dice thrown ${roll.id}`);
      return new Promise((r) => setTimeout(() => { note(`dice landed ${roll.id}`); r(true); }, DSN_MS));
    },
  },
};

const forgeCards = [];
globalThis.ChatMessage = {
  getSpeaker: ({ actor } = {}) => ({ alias: actor?.name ?? "" }),
  create: async (data = {}) => {
    const id = `msg-${++msgSeq}`;
    const msg = { id, ...data, author: { id: game.user.id }, timestamp: Date.now() };
    MESSAGES.set(id, msg);
    if (Array.isArray(data.rolls) && data.rolls.length) {
      // A card carrying its rolls is animated by Dice So Nice on its own.
      note(`dnd5e card ${data.flavor}`);
      setTimeout(() => { note(`dice landed on ${data.flavor}`); Hooks.callAll("diceSoNiceRollComplete", id); }, DSN_MS);
    } else if (data.flags?.["ace-artificer"]?.isTrapCard) {
      note("forge card");
      forgeCards.push(msg);
    } else {
      note(`card ${id}`);
    }
    return msg;
  },
};

/** An evaluated d20 roll the way these files read one. */
function fakeRoll(face, mod, { id, target = null } = {}) {
  return {
    id, formula: `1d20 + ${mod}`, total: face + mod, _evaluated: true,
    options: { target, advantageMode: 0 },
    dice: [{ faces: 20, total: face, results: [{ result: face, active: true }] }],
    terms: [{ faces: 20, total: face, results: [{ result: face, active: true }] }],
    configureModifiers() {},
  };
}
// A luck die (luck.mjs rolls `new Roll("1d20")`).
const LUCK_DICE = [];
globalThis.Roll = class {
  constructor(formula) { this.formula = formula; this.options = {}; }
  async evaluate() {
    const face = LUCK_DICE.shift();
    if (face == null) throw new Error("the test gave no luck die to roll");
    Object.assign(this, fakeRoll(face, 0, { id: `luck die ${face}` }));
    return this;
  }
};

/** dnd5e's saving throw, as the facts read above say it runs. */
const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
async function dnd5eSave(actor, config = {}, dialog = {}, message = {}) {
  const rollConfig = { ...config, subject: actor };
  rollConfig.hookNames = [...(config.hookNames ?? []), "SavingThrow", "d20Test"];
  const dialogConfig = { ...dialog };
  const messageConfig = { create: true,
    data: { flags: { dnd5e: { messageType: "roll", roll: { ability: config.ability, type: "save" } } } }, ...message };
  rollConfig.hookNames = [...rollConfig.hookNames, ""];
  for (const h of rollConfig.hookNames) {
    if (Hooks.call(`dnd5e.preRoll${cap(h)}`, rollConfig, dialogConfig, messageConfig) === false) return null;
    if (Hooks.call(`dnd5e.preRoll${cap(h)}V2`, rollConfig, dialogConfig, messageConfig) === false) return null;
  }
  const face = actor._faces.shift();
  if (face == null) throw new Error(`${actor.name} was asked for more saves than the test gave it`);
  const mod = Number(actor.system.abilities[config.ability]?.save?.value) || 0;
  const roll = fakeRoll(face, mod, { id: `${actor.name}'s save`, target: config.target ?? null });
  for (const h of rollConfig.hookNames) {
    if (Hooks.call(`dnd5e.post${cap(h)}RollConfiguration`, [roll], rollConfig, dialogConfig, messageConfig) === false) return null;
  }
  if (messageConfig.create !== false) {
    await ChatMessage.create({ rolls: [roll], flavor: `${actor.name}'s save`, flags: messageConfig.data.flags });
  }
  Hooks.callAll("dnd5e.rollSavingThrow", [roll], { ability: config.ability, subject: actor });
  return [roll];
}

/** A creature standing in the glyph: its actor and its token. */
function creature(name, { type = "npc", wis = 0, faces = [], hp = 10, dead = false, failures = 0, tokenFlags = {}, items = [] } = {}) {
  const id = name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const actor = {
    id, name, type, uuid: `Actor.${id}`, documentName: "Actor",
    statuses: new Set(dead ? ["dead"] : []),
    system: {
      attributes: { hp: { value: hp, max: Math.max(hp, 10) }, death: { success: 0, failure: failures } },
      abilities: { wis: { mod: wis, save: { value: wis, roll: { mode: 0 } } } },
    },
    effects: [], items: [], flags: {}, ownership: {},
    getFlag: (s, k) => actor.flags?.[s]?.[k],
    setFlag: async (s, k, v) => { (actor.flags[s] ??= {})[k] = v; },
    unsetFlag: async (s, k) => { delete actor.flags?.[s]?.[k]; },
    getActiveTokens: () => [],
    _faces: [...faces],
  };
  for (const it of items) { it.actor = actor; actor.items.push(it); }
  actor.rollSavingThrow = (c, d, m) => dnd5eSave(actor, c, d, m);
  const tokenDoc = {
    id: `tok-${id}`, name, actor, flags: tokenFlags, texture: { src: `${id}.webp` },
    update: async (u) => { note(`transform ${name}`); if (u?.["texture.src"]) tokenDoc.texture.src = u["texture.src"]; return tokenDoc; },
  };
  return { actor, tokenDoc };
}

const luckSpent = [];
/** The 2014 Lucky feat, three points, none spent. */
function luckyFeat() {
  const it = { type: "feat", name: "Lucky", uuid: "Item.lucky-2014",
    system: { type: { value: "feat" }, source: { rules: "2014" }, uses: { max: 3, spent: 0 } } };
  it.update = async (u) => {
    luckSpent.push(u);
    if ("system.uses.spent" in u) it.system.uses.spent = u["system.uses.spent"];
    return it;
  };
  return it;
}
// ACE's reaction door: the owner says yes to Lucky, and keeps the better die.
const boxes = [];
const reactionEngine = {
  _promptReaction: async (o) => {
    boxes.push({ type: o.type, who: o.reactorActor?.name });
    if (o.type === "lucky") return { accepted: true, choiceData: { luckSpent: false } };
    if (o.type === "luckyChoice") {
      const better = (o.choices ?? []).find(c => c.tone === "better") ?? o.choices?.[0];
      return { accepted: true, choiceData: { choice: better?.id } };
    }
    return { accepted: false };
  },
};

const logged = [];
const text = (x) => {
  if (x instanceof Error) return x.message;
  if (typeof x === "string") return x;
  try { return JSON.stringify(x); } catch (_) { return String(x); }
};
/** Run with the modules' own console lines kept for the checks, not printed. */
async function quiet(fn) {
  const keep = { log: console.log, warn: console.warn, debug: console.debug, info: console.info, error: console.error };
  for (const lvl of Object.keys(keep)) console[lvl] = (...a) => logged.push({ lvl, text: a.map(text).join(" ") });
  try { return await fn(); } finally { Object.assign(console, keep); }
}
const template = (id) => ({ id, update: async () => { note(`template ${id} spent`); } });
const trapDef = { name: "Polymorph Glyph", saveDC: 15, saveAbility: "wis", oneShot: true, description: "",
  tileTexture: "icons/svg/trap.svg" };

/* ── The shipped code ────────────────────────────────────────────────────── */
const { CheckGate } = await import(url(`${QOL}/check-gate.mjs`));
const { lifeStateOf } = await import(url(`${QOL}/road/picker-rule.mjs`));
const { safeShowForRoll, awaitDiceSettle } = await import(url(`${QOL}/dsn-utils.mjs`));
const { PolymorphPipeline } = await quiet(() => import(url(`${FORGE}/polymorph-pipeline.mjs`)));
const { forgeWatchMessageDice } = await import(url(`${FORGE}/dice-wait.mjs`));

game.aceQol = { reactionEngine, earlier: "kept" };
await quiet(async () => CheckGate.register());
const gateErrors = () => hookErrors.filter(e => e.name === "dnd5e.preRollD20TestV2");

console.log("\nACE'S GATE PUBLISHES A DOOR BESIDE ITSELF");
check("registering the gate publishes its door for the sibling modules: run, and the total its card shows",
  typeof game.aceQol?.checks?.run === "function" && typeof game.aceQol?.checks?.totalOf === "function",
  `checks: ${Object.keys(game.aceQol?.checks ?? {}).join(", ") || "missing"}`);
check("and it adds to what is already on the API rather than replacing it",
  game.aceQol.earlier === "kept" && game.aceQol.reactionEngine === reactionEngine,
  "an entry made before the gate registered is still there");

/* ── 1. The cause ────────────────────────────────────────────────────────── */
console.log("\nTHE CAUSE: ACE'S GATE TAKES A SAVE THAT ASKS FOR A CARD, AND dnd5e HANDS BACK NOTHING");
{
  const realRun = CheckGate.run;
  const took = [];
  CheckGate.run = async (actor, kind, key, o = {}) => { took.push({ who: actor?.name, kind, key, dc: o.dc }); return null; };
  const goblin = creature("Goblin", { faces: [5, 5] });
  let old, both;
  try {
    old = await quiet(() => goblin.actor.rollSavingThrow({ ability: "wis", target: 15 }, { configure: false }));
    both = await quiet(() => goblin.actor.rollSavingThrow({ ability: "wis", target: 15 }, { configure: false }, { create: false }));
  } finally { CheckGate.run = realRun; }
  check("Forge's old call (no dialog, but a card) is taken by the gate and dnd5e hands Forge null",
    old === null && took.length === 1 && took[0].kind === "save" && took[0].key === "wis" && took[0].dc === 15,
    `dnd5e returned ${old === null ? "null" : JSON.stringify(old)}; the gate took ${took.length}`);
  check("the same save asking for neither a dialog nor a card is let through with its roll",
    Array.isArray(both) && both[0]?.total === 5 && took.length === 1 && gateErrors().length === 0,
    Array.isArray(both) ? `rolled ${both[0]?.total}` : "nothing came back");
}

/* ── 2. With ACE QOL ─────────────────────────────────────────────────────── */
console.log("\nWITH ACE QOL: THE GLYPH'S SAVES GO THROUGH ACE'S DOOR, AND NOTHING LANDS BEFORE THEIR DICE");
const realPostCard = CheckGate._postCard;
const aceCards = [];
CheckGate._postCard = async ({ actor, roll, total = null, extra = "" }) => {
  if (roll) { safeShowForRoll(roll, "save card"); await awaitDiceSettle(); }
  const verdict = /SUCCESS|FAILURE/.exec(String(extra))?.[0] ?? null;
  const t = total ?? roll?.total ?? null;
  note(`ace card ${actor?.name} ${t} ${verdict}`);
  aceCards.push({ who: actor?.name, total: t, verdict });
};
const door = game.aceQol.checks;
const doorRun = door.run;
const doorCalls = [];
door.run = async (actor, kind, key, o = {}) => { doorCalls.push({ who: actor?.name, kind, key, ...o }); return doorRun(actor, kind, key, o); };
{
  const kobold = creature("Kobold", { faces: [4] });
  const cleric = creature("Cleric", { type: "character", wis: 5, faces: [14] });
  const chudd = creature("Chudd", { type: "character", wis: 2, faces: [7], items: [luckyFeat()] });
  LUCK_DICE.push(16);
  const corpse = creature("Bandit", { hp: 0, dead: true });
  timeline.length = 0; forgeCards.length = 0;
  let err = null;
  try {
    await quiet(() => PolymorphPipeline.fireTrap(trapDef,
      [kobold.tokenDoc, cleric.tokenDoc, chudd.tokenDoc, corpse.tokenDoc], template("glyph-1")));
  } catch (e) { err = e; }
  const card = String(forgeCards[0]?.content ?? "");
  const asked = doorCalls.map(c => c.who);
  check("every living creature in the glyph is asked through ACE's door: a Wisdom save at DC 15, its own advantage, no pause",
    !err && asked.join(",") === "Kobold,Cleric,Chudd"
      && doorCalls.every(c => c.kind === "save" && c.key === "wis" && c.dc === 15 && c.choice === "suggested"),
    err ? `threw: ${err.message}` : `asked ${asked.join(", ") || "nobody"}`);
  check("the dead are never asked, never on the card, and the log names them",
    !asked.includes("Bandit") && !/Bandit/.test(card) && logged.some(l => /no save asked of Bandit/.test(l.text)),
    asked.includes("Bandit") ? "the corpse was asked to save" : "not asked");
  const k = { thrown: at("dice thrown Kobold's save"), landed: at("dice landed Kobold's save"),
    ace: at("ace card Kobold 4 FAILURE"), beast: at("transform Kobold"), forge: at("forge card") };
  check("the Kobold rolls 4: its die lands, ACE's card says FAILURE, and only then is it a beast, then Forge's card",
    k.thrown >= 0 && k.thrown < k.landed && k.landed < k.ace && k.ace < k.beast && k.beast < k.forge,
    `order ${JSON.stringify(k)}`);
  check("the Cleric rolls 19: ACE's card says SUCCESS and it stays itself",
    aceCards.some(c => c.who === "Cleric" && c.total === 19 && c.verdict === "SUCCESS") && at("transform Cleric") < 0,
    at("transform Cleric") >= 0 ? "it was turned into a beast" : "unchanged");
  const chuddCard = aceCards.find(c => c.who === "Chudd");
  check("Chudd (2014 Lucky) rolls 9, about to fail: he is asked, spends a point, keeps the luck die's 16, and ACE's card says 18 SUCCESS after that die lands",
    boxes.some(b => b.type === "lucky" && b.who === "Chudd") && luckSpent.some(u => u["system.uses.spent"] === 1)
      && chuddCard?.total === 18 && chuddCard?.verdict === "SUCCESS"
      && at("dice landed luck die 16") >= 0 && at("dice landed luck die 16") < at("ace card Chudd"),
    chuddCard ? `card ${chuddCard.total} ${chuddCard.verdict}` : "no card for Chudd");
  check("and Forge decides on that same 18: Chudd stays himself, and the GM's card says saved (18)",
    at("transform Chudd") < 0 && /Chudd<\/strong>[^<]*saved \(18\)/.test(card),
    at("transform Chudd") >= 0 ? "Forge polymorphed him on the roll's own 9" : "unchanged");
  check("Forge's card goes to the GM alone and lists what the dice said",
    JSON.stringify(forgeCards[0]?.whisper) === JSON.stringify(["gm"])
      && /Kobold<\/strong>[^<]*failed \(4\)/.test(card) && /Cleric<\/strong>[^<]*saved \(19\)/.test(card),
    forgeCards.length ? "posted" : "no card");
  check("and no save was rolled through dnd5e's own card while ACE was running",
    at("dnd5e card") < 0 && gateErrors().length === 0, at("dnd5e card") >= 0 ? "dnd5e posted a card" : "none");
}
door.run = doorRun;

/* ── 3. An older ACE QOL: the gate, no door ─────────────────────────────── */
console.log("\nWITH AN OLDER ACE QOL (THE GATE, NO DOOR): NO CARD ASKED FOR, AND FORGE THROWS THE DICE");
{
  const keepDoor = game.aceQol.checks;
  delete game.aceQol.checks;
  const realRun = CheckGate.run;
  const took = [];
  CheckGate.run = async (actor) => { took.push(actor?.name); return null; };
  const orc = creature("Orc", { faces: [3] });
  timeline.length = 0; forgeCards.length = 0;
  let err = null;
  try { await quiet(() => PolymorphPipeline.fireTrap(trapDef, [orc.tokenDoc], template("glyph-2"))); }
  catch (e) { err = e; }
  finally { CheckGate.run = realRun; game.aceQol.checks = keepDoor; }
  check("the gate lets Forge's save through: it asks for neither a dialog nor a card",
    !err && took.length === 0, err ? `threw: ${err.message}` : `the gate took ${took.length}`);
  check("so dnd5e posts no card, and Forge throws the save's dice itself",
    at("dnd5e card") < 0 && at("dice thrown Orc's save") >= 0, `timeline: ${timeline.join(" | ")}`);
  check("the Orc (3 against DC 15) is a beast only after that die lands",
    at("dice landed Orc's save") >= 0 && at("dice landed Orc's save") < at("transform Orc") && at("transform Orc") < at("forge card"),
    `timeline: ${timeline.join(" | ")}`);
}

/* ── 4. Forge alone ─────────────────────────────────────────────────────── */
console.log("\nFORGE ALONE: dnd5e ROLLS WITH ITS OWN CARD, AND THE POLYMORPH WAITS FOR THAT CARD'S DICE");
{
  game.modules.get("ace-qol").active = false;
  const gateHooks = HOOKS.get("dnd5e.preRollD20TestV2") ?? [];
  HOOKS.set("dnd5e.preRollD20TestV2", []);
  try {
    const gnoll = creature("Gnoll", { faces: [2] });
    timeline.length = 0; forgeCards.length = 0;
    await quiet(() => PolymorphPipeline.fireTrap(trapDef, [gnoll.tokenDoc], template("glyph-3")));
    check("dnd5e rolls the save and posts its own card, as it always did without ACE QOL",
      at("dnd5e card Gnoll's save") >= 0, `timeline: ${timeline.join(" | ")}`);
    check("the Gnoll (2 against DC 15) is a beast only after that card's dice land",
      at("dnd5e card Gnoll's save") < at("dice landed on Gnoll's save") && at("dice landed on Gnoll's save") < at("transform Gnoll"),
      `timeline: ${timeline.join(" | ")}`);

    // A save window closed without a roll: dnd5e returns null.
    const pixie = creature("Pixie");
    pixie.actor.rollSavingThrow = async () => null;
    timeline.length = 0; forgeCards.length = 0;
    await quiet(() => PolymorphPipeline.fireTrap(trapDef, [pixie.tokenDoc], template("glyph-4")));
    check("a save that never rolled is not a failure: nobody becomes a beast, and the GM's card says why",
      at("transform") < 0 && /Pixie<\/strong>[^<]*the saving throw could not be rolled/.test(String(forgeCards[0]?.content ?? "")),
      at("transform") >= 0 ? "the Pixie was polymorphed on no roll" : "unchanged");
    const longTimers = [];
    const realSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = (fn, ms, ...a) => { if (Number(ms) >= 20000) longTimers.push(ms); return realSetTimeout(fn, ms, ...a); };
    try { await quiet(() => PolymorphPipeline._rollSave(pixie.actor, "wis", 15)); }
    finally { globalThis.setTimeout = realSetTimeout; }
    const w = forgeWatchMessageDice();
    w.cancel();
    const t0 = Date.now();
    await w.untilDiceLand();
    check("and nothing is left counting twenty seconds for dice that are not coming",
      longTimers.length === 0 && Date.now() - t0 < 1000,
      longTimers.length ? `${longTimers.length} long timer(s) set after the cancel` : "the wait returned at once");
  } finally {
    HOOKS.set("dnd5e.preRollD20TestV2", gateHooks);
    game.modules.get("ace-qol").active = true;
  }
}

/* ── 5. One answer everywhere ───────────────────────────────────────────── */
console.log("\nONE ANSWER EVERYWHERE: THE TOTAL THE CARD SHOWS, AND WHO IS DEAD");
{
  const lucky = fakeRoll(7, 2, { id: "t1" });
  Object.defineProperty(lucky, "_aceLuck", { value: { total: 18, d20: 16 }, enumerable: false });
  check("a roll a luck point changed stands at the card's total, not at the dice it was rolled with",
    CheckGate.totalOf(lucky) === 18, `totalOf ${CheckGate.totalOf(lucky)}, the roll itself ${lucky.total}`);
  check("an ordinary roll stands at its own total, and no roll is null, never NaN",
    CheckGate.totalOf(fakeRoll(12, 0, { id: "t2" })) === 12 && CheckGate.totalOf(null) === null,
    `${CheckGate.totalOf(fakeRoll(12, 0, { id: "t3" }))} and ${CheckGate.totalOf(null)}`);

  const qolSrc = readFileSync(`${QOL}/ace-qol.mjs`, "utf8");
  const wire = bare(qolSrc.slice(qolSrc.indexOf("const _wireConcButton"), qolSrc.indexOf("registerChatCardHandler(_wireConcButton")));
  check("the old concentration button reads the total its card shows, so MAINTAINED or BROKEN matches the card after a luck point (source read: it lives inside ACE's startup)",
    wire.length > 0 && /CheckGate\.totalOf\(roll\)/.test(wire) && !/roll\?\.total\b/.test(wire),
    wire.length ? "read from ace-qol.mjs" : "the handler was not found in ace-qol.mjs");
  const post = bare(bodyOf(readFileSync(`${QOL}/check-gate.mjs`, "utf8"), "static async _postCard("));
  const [show, settle, posted] = ["safeShowForRoll(", "await awaitDiceSettle(", "CardDoor.post("].map(s => post.indexOf(s));
  check("the real card throws its roll's dice and waits for them before it posts, the order the stand-in above keeps",
    show >= 0 && show < settle && settle < posted, `positions ${show}, ${settle}, ${posted}`);
  const forgeSrc = bare(readFileSync(`${FORGE}/polymorph-pipeline.mjs`, "utf8"));
  check("Forge decides against the door's total, never the roll's own",
    /door\.totalOf\(roll\)/.test(forgeSrc), "read from polymorph-pipeline.mjs");

  const kinds = [
    ["the Dead status", creature("A", { hp: 0, dead: true })],
    ["three failed death saves", creature("B", { type: "character", hp: 0, failures: 3 })],
    ["ACE's death mark on the token", creature("C", { hp: 0, tokenFlags: { "ace-qol": { isDead: true } } })],
    ["killed for good", creature("D", { hp: 0, tokenFlags: { "ace-qol": { permanentlyDead: true } } })],
    ["a character dying at 0 with two failures", creature("E", { type: "character", hp: 0, failures: 2 })],
    ["a creature at 0 that nothing marked", creature("F", { hp: 0 })],
    ["a living creature", creature("G", { hp: 7 })],
  ];
  const disagree = kinds.filter(([, c]) =>
    PolymorphPipeline._isDead(c.actor, c.tokenDoc) !== (lifeStateOf(c.actor, c.tokenDoc).state === "dead")).map(([w]) => w);
  check("Forge's dead is ACE's dead: the same answer as ACE's picker rule for every kind of creature",
    disagree.length === 0, disagree.length ? `they disagree on: ${disagree.join("; ")}` : `${kinds.length} kinds agree`);
}
CheckGate._postCard = realPostCard;

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
