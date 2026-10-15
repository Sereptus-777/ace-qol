// ─── ACE: QOL — WHAT THE TABLE SEES: one function, every card ───────────────
//
// His rules, 2026-10-11:
//
//   "A player who does not own the actor sees the die and the word: the face,
//    the number on it, saved or failed, and the damage that landed with its
//    type, as in 5 fire. ... One function decides this. The public HTML and the
//    message flags both go through it. A hidden div is not hidden. A render
//    hook is not hidden. If the number is in the flags, it is on the table."
//
//   and, the same morning, whose a number is:
//
//   "A player character's formula and DC are not a secret. The whole table
//    sees them. A creature's bonus, DC, AC, and hit points stay on my screen
//    only."
//
//   "The numbers on my cards have to survive a reload of this browser. A
//    different computer can live without them. This one cannot."
//
//   "A player character's AC and hit points stay on my screen, same as a
//    creature's. The whole table sees a party member's formula and DC, the die,
//    the word, and the damage that landed. Nothing else."
//
//   and from the live test that afternoon, what "formula" means:
//
//   "A party member's save row is the die and PASS or FAIL. Jeth and the Steel
//    Defender are showing Dex, proficiency, cover, and 9 + 11 = 20 on the
//    player's screen. That is not the spell. Chudd's DC 17 stays."
//
//   So a party member's formula is the spell's: its DC and its damage dice. The
//   arithmetic of anybody's d20 (an attack, a save, a check, a contest) is the
//   GM's, a party member's included.
//
// ⚠️🔴 WHY IT CANNOT LIVE ON THE MESSAGE AT ALL. PROVEN from Foundry 13.351's
// own server code, 2026-10-11:
//   - every ChatMessage, WHISPERS INCLUDED, is dumped to every client when the
//     world loads (packages/world.mjs: ChatMessage.dump() with no user filter)
//     and broadcast to every socket when it is created or changed
//     (server-backend.mjs: broadcast.emit("modifyDocument")). A whisper is only
//     hidden by the chat log's display.
//   - every Setting and every world document goes to every client the same way,
//     and a compendium read checks no permission. There is nowhere in Foundry's
//     database a player cannot read.
//   - a module socket message sent with {recipients} reaches ONLY those users,
//     and the server appends the sender's own id (sockets.mjs handleCustomSocket).
//
// So this is the one function. It runs on the client that posts or changes an
// ACE card, BEFORE anything leaves that client (preCreate/preUpdateChatMessage;
// client-backend.mjs sends whatever those hooks leave on the document):
//   1. a party member's DC and damage formula stay on the card: the whole table
//      reads them;
//   2. every other marked part of the HTML (any d20's bonus and total, any AC,
//      any hit points, a creature's number, a trap's, the GM's tools) is cut out
//      and replaced by an empty slot;
//   3. every secret field in the flags is cut out the same way, by the same rule;
//   4. the dice rolled stay, the arithmetic around them does not;
//   5. what was cut goes, by socket, ONLY to the GM. The GM's screen puts it back
//      into its own copy of the message and keeps it in this browser's own
//      store, so every reader on the GM's side works untouched and a reload of
//      the GM's browser puts every number back.
//
// What is the table's is decided here and nowhere else. The cards already mark
// their numbers and say whose they are (bonusSpan, dcSpan, acSpan,
// .ace-qol-gm-only, the GM controls); this file is what makes those marks mean
// "not sent" instead of "not shown".
// ──────────────────────────────────────────────────────────────────────────────

// ⚠️ ONE FILE, TWO MODULES. ACE QOL registers this; ACE Forge carries a copy
// byte for byte (tools/table-view-selftest.mjs fails if they differ) and
// registers it only when QOL is not running, so Forge sold alone still keeps
// its numbers off the table. Whichever registered it owns the socket and the
// flag the card's key rides on.
let MODULE_ID = "ace-qol";
let SOCKET = `module.${MODULE_ID}`;
const ACE_NAMESPACES = ["ace-qol", "ace-artificer", "ace-engine", "ace-envoy"];

/* ═══ 1. WHICH PARTS ARE NOT THE TABLE'S ════════════════════════════════════ */

/** The GM's alone, whoever the card is about. */
const GM_CLASSES = Object.freeze([
  "ace-qol-gm-only",          // the GM half of every black card
  "ace-qol-dmg-gm-controls",  // a damage card's hit points, Apply, ¼ ½ 1 2
  "ace-qol-save-dc",          // a DC nobody at the table is rolling yet
  "ace-qol-dmg-truth-only",   // raw → final, the resistance word
  "truth-row",
  "forge-gm-only",            // Forge's DC, formulas and GM buttons
]);

/**
 * The arithmetic of a d20: an attack's, a save's, a check's, a contest's. The
 * GM's, whoever rolled it (his rule, 2026-10-11: "A party member's save row is
 * the die and PASS or FAIL... That is not the spell."). They still say whose
 * they are (data-bonus-actor); nothing here asks.
 */
const D20_CLASSES = Object.freeze([
  "ace-qol-bonus",            // bonusSpan: the arithmetic of a roll
  "ace-qol-formula-pill",     // "Dex +5 | Prof +3 = 8"
]);

/**
 * A modifier chip on a damage card: the damage formula. One that names nobody
 * is the card's own creature's: the attacker's +4 STR on the attacker's card.
 * A chip on an attack card sits inside its d20 wrapper and goes with it.
 */
const CHIP_CLASSES = Object.freeze([
  "ace-qol-mod-labeled",      // +4 STR, PROF, MAGIC
  "ace-qol-mod-chip",
  "ace-qol-mod-plain",        // an unlabelled flat modifier is still a bonus
  // A save's own named sum (his rule, 2026-10-12): the table's for a party
  // member's own save, the GM's for a creature's.
  "ace-qol-save-bonus",
]);

/**
 * Flag fields that hold a number, at any depth, and whose number each kind is.
 *
 * ⚠️ WHOSE IS DECIDED BY WHAT THE FIELD MEASURES, NOT BY THE ROW IT SITS IN. A
 * Fireball's row for Jeth carries Lamia's DC; a player's attack card carries
 * the ogre's AC and the ogre's hit points. Read by the row alone, both hand a
 * creature's number to the table because a player character's name is beside it.
 */
/**
 * A DC is the caster's: the creature a card names as its caster
 * (`casterActorId`, and a card that carries that field and leaves it empty has
 * a caster nobody recorded, so the GM's), else the creature the card is about at
 * its top. Never the speaker: a card about the creature escaping a grapple is
 * not the grappler's.
 */
const DC_FLAG_KEYS = Object.freeze(new Set(["dc", "saveDC"]));
/** A trap's or a hidden thing's: never a player character's. */
const GM_FLAG_KEYS = Object.freeze(new Set([
  "disarmDC", "perceptionDC", "detectionDC", "secretDC", "spotDC", "threshold",
  "trap", "trapData",
]));
/**
 * A defence: an AC, hit points, a resistance. The GM's, whoever's it is, a party
 * member's included (his rule, 2026-10-11: "A player character's AC and hit points stay on my screen").
 */
const DEFENCE_FLAG_KEYS = Object.freeze(new Set([
  "ac", "effectiveAC", "defenses", "damageModifiers",
  "hp", "currentHP", "maxHP", "currentHp", "maxHp", "currentTempHp", "projectedHp",
  "preHP", "preTempHP", "hpBefore", "hpAfter", "tempBefore", "tempAfter", "preDamageHp",
]));
/**
 * The dice a card rolled and their formula: whoever made the card (its caster
 * or attacker), even in a row named for the creature they landed on. A
 * damage row is named for its target and carries the attacker's 2d6 + 4.
 */
const DICE_FLAG_KEYS = Object.freeze(new Set([
  "raw", "totalRaw", "formula", "formulas",
  // under other names (audit, 2026-10-11): a damage part's ability and magic
  // bonus and its roll terms (damage-card-renderer), a heal's roll (heal-pipeline),
  // an area's damage (concentration-widget), a save card's rolled damage (save-engine)
  "_modMeta", "terms", "rollFormula", "rollTotal", "damageFormula", "damageRawTotal", "baseDamageTotal",
]));
/**
 * A total: the creature the very object holding it names (a contest side, a
 * repeat save), else whoever made the card (a damage part's total).
 */
const TOTAL_FLAG_KEYS = Object.freeze(new Set(["total"]));
/**
 * The arithmetic of a d20: the GM's, a party member's included (his rule,
 * 2026-10-11: "A party member's save row is the die and PASS or FAIL").
 */
const ROLL_FLAG_KEYS = Object.freeze(new Set([
  // a bonus, a modifier, the parts of a roll
  "saveMod", "saveModBase", "saveModBonus", "coverBonus", "saveBonuses", "saveBonusUsed",
  "saveParts", "modifier",
  // a total of one creature's own roll
  // (not "rolled": the damage button card uses it as a yes/no "already rolled")
  "saveTotal", "bestTotal", "attackTotal",
]));

export const SECRET_FLAG_KEYS = Object.freeze(new Set([
  ...DC_FLAG_KEYS, ...GM_FLAG_KEYS, ...DEFENCE_FLAG_KEYS, ...DICE_FLAG_KEYS, ...TOTAL_FLAG_KEYS,
  ...ROLL_FLAG_KEYS,
]));

const VOID_TAGS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link",
  "meta", "source", "track", "wbr"]);
const OPEN_TAG = /<([a-zA-Z][\w-]*)((?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+))?)*)\s*(\/?)>/g;
const ATTR = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
const SLOT = /<([a-zA-Z][\w-]*) data-ace-slot="([\w-]+)"><\/\1>/g;

/** Nobody is a player character until Foundry says so (a test passes its own). */
const NOBODY = () => false;

function attrsOf(text) {
  const out = {};
  for (const m of String(text ?? "").matchAll(ATTR)) {
    out[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? "";
  }
  return out;
}

/**
 * Whose an element is: "gm", an actor id, or null when it is nobody's (the
 * table's: a name, a die, a word).
 */
export function audienceOf(attrs, cardActor = null) {
  const cls = new Set(String(attrs.class ?? "").split(/\s+/).filter(Boolean));
  if (attrs["data-ace-secret"] === "gm") return "gm";
  // A creature's own roll, marked by Forge's trap and disarm rows: a d20's
  // bonus and total, the GM's whoever it is.
  if (attrs["data-ace-secret-owner"]) return "gm";
  if (GM_CLASSES.some(c => cls.has(c))) return "gm";
  // An AC is the GM's, a party member's included (his rule, 2026-10-11: "A player character's AC and hit points stay on my screen").
  if (cls.has("ace-qol-ac")) return "gm";
  // A DC is the caster's.
  if (cls.has("ace-qol-dc")) return attrs["data-dc-owner"] || "gm";
  if (D20_CLASSES.some(c => cls.has(c))) return "gm";
  if (CHIP_CLASSES.some(c => cls.has(c))) return attrs["data-bonus-actor"] || cardActor || "gm";
  return null;
}

/**
 * THE RULE. A number that names one of the party here (its spell's DC, its
 * damage formula) is the table's (null); every other number is the GM's. A d20's
 * arithmetic, an AC and hit points never get here as anybody's: they are the
 * GM's before this is asked.
 */
export function tableOrGM(aud, isTable = NOBODY) {
  if (aud === null || aud === undefined) return null;
  if (aud !== "gm" && isTable(aud)) return null;
  return "gm";
}

/** Where an element that opens at `from` closes, or -1. */
function closeOf(html, tag, from) {
  const re = new RegExp(`<(/?)${tag}\\b(?:"[^"]*"|'[^']*'|[^'">])*>`, "gi");
  re.lastIndex = from;
  let depth = 1;
  let m;
  while ((m = re.exec(html))) {
    if (m[1]) { if (--depth === 0) return re.lastIndex; }
    else if (!/\/\s*>$/.test(m[0])) depth++;
  }
  return -1;
}

let _slotSeq = 0;
function newSlotId() {
  _slotSeq = (_slotSeq + 1) % 1e6;
  return `${Date.now().toString(36)}${_slotSeq.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * Cut every part of a card's HTML that is not the table's.
 * @returns {{html: string, slots: Array<{id:string, aud:"gm", html:string}>}}
 */
export function splitHtml(html, { cardActor = null, makeId = newSlotId, isTable = NOBODY } = {}) {
  const src = String(html ?? "");
  const slots = [];
  let out = "";
  let pos = 0;
  OPEN_TAG.lastIndex = 0;
  let m;
  while ((m = OPEN_TAG.exec(src))) {
    const aud = tableOrGM(audienceOf(attrsOf(m[2]), cardActor), isTable);
    if (!aud) continue;                       // the table's: keep reading inside it
    const tag = m[1].toLowerCase();
    const selfClosed = m[3] === "/" || VOID_TAGS.has(tag);
    let end = selfClosed ? OPEN_TAG.lastIndex : closeOf(src, tag, OPEN_TAG.lastIndex);
    // ⚠️ A SECRET THAT NEVER CLOSES TAKES THE REST WITH IT. Unbalanced markup
    // must never leave a number public because the parser lost its place.
    if (end < 0) end = src.length;
    const id = makeId();
    const holder = selfClosed ? "span" : tag;
    out += src.slice(pos, m.index) + `<${holder} data-ace-slot="${id}"></${holder}>`;
    slots.push({ id, aud, html: src.slice(m.index, end) });
    pos = end;
    OPEN_TAG.lastIndex = end;
  }
  return { html: out + src.slice(pos), slots };
}

/** Put back the slots this client holds. */
export function fillHtml(html, slots) {
  const byId = new Map((slots ?? []).map(s => [s.id, s.html]));
  return String(html ?? "").replace(SLOT, (whole, _tag, id) => byId.get(id) ?? whole);
}

/** Does this HTML still have a slot nothing filled? */
export function hasEmptySlots(html) {
  SLOT.lastIndex = 0;
  return SLOT.test(String(html ?? ""));
}

const isPlain = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const named = (v) => (typeof v === "string" && v) ? v : null;

/** A secret value: {__aud: "gm", v}. */
const isLeaf = (o) => isPlain(o) && typeof o.__aud === "string" && "v" in o;

/**
 * Split flags into what the table may see and an overlay of what it may not.
 * The overlay mirrors the shape; an array is an {__arr: {index: overlay}} so a
 * merge goes by index and never replaces the public array; each secret is a
 * leaf {__aud: "gm", v}.
 *
 * @param {*} value
 * @param {string} [card]  whose card it is: the caster or attacker ("gm" if nobody)
 * @param {object} [o]
 * @param {Function} [o.isTable]  is this actor id one of the party?
 * @param {string} [o.ns]  the flag namespace (Forge's DCs are always a trap's)
 */
export function splitFlags(value, card = "gm", { isTable = NOBODY, ns = null } = {}) {
  const fallback = card || "gm";
  return splitIn(value, { maker: fallback, caster: "gm", depth: 0, isTable, ns });
}

function splitIn(value, ctx) {
  if (Array.isArray(value)) {
    const pub = [];
    const arr = {};
    let any = false;
    value.forEach((v, i) => {
      const r = splitIn(v, { ...ctx, depth: ctx.depth + 1 });
      pub.push(r.pub);
      if (r.sec !== undefined) { arr[i] = r.sec; any = true; }
    });
    return { pub, sec: any ? { __arr: arr } : undefined };
  }
  if (isPlain(value)) {
    // The creatures this object names, and the creature at the top of the card,
    // the one who made it.
    const actorId = named(value.actorId);
    const target = named(value.targetActorId) ?? named(value.targetId);
    const top = ctx.depth === 0;
    // A card that names its caster decides its DCs and its dice by that name,
    // even an empty one; otherwise the creature at the top of the card.
    const namesCaster = "casterActorId" in value;
    const caster = namesCaster ? (named(value.casterActorId) ?? "gm") : (top ? (actorId ?? "gm") : ctx.caster);
    const maker = namesCaster ? (named(value.casterActorId) ?? "gm") : (top ? (actorId ?? ctx.maker) : ctx.maker);
    const own = actorId ?? target;
    const inner = { ...ctx, maker, caster, depth: ctx.depth + 1 };
    const pub = {};
    const sec = {};
    let any = false;
    for (const [k, v] of Object.entries(value)) {
      if (!k.startsWith("-=") && SECRET_FLAG_KEYS.has(k)) {
        const whose = flagWhose(k, { ns: ctx.ns, maker, caster, own });
        if (tableOrGM(whose, ctx.isTable) === null) { pub[k] = v; continue; }
        sec[k] = { __aud: "gm", v };
        any = true;
        continue;
      }
      const r = splitIn(v, inner);
      pub[k] = r.pub;
      if (r.sec !== undefined) { sec[k] = r.sec; any = true; }
    }
    return { pub, sec: any ? sec : undefined };
  }
  return { pub: value, sec: undefined };
}

/** Whose one secret field is, by what it measures. */
function flagWhose(key, { ns, maker, caster, own }) {
  // Forge's numbers are a trap's, a hidden door's, or a d20 rolled against one.
  if (ns === "ace-artificer") return "gm";
  if (GM_FLAG_KEYS.has(key) || DEFENCE_FLAG_KEYS.has(key) || ROLL_FLAG_KEYS.has(key)) return "gm";
  if (DC_FLAG_KEYS.has(key)) return caster;
  if (DICE_FLAG_KEYS.has(key)) return maker;
  // A total in an object that names its own creature is that creature's d20 (a
  // contest side, a repeat save): the GM's. One in a damage part is the dice.
  if (TOTAL_FLAG_KEYS.has(key)) return own ? "gm" : maker;
  return "gm";
}

/** Lay an overlay back over flags (a copy; neither input changes). */
export function mergeOverlay(target, overlay) {
  if (overlay === undefined) return target;
  if (isLeaf(overlay)) return overlay.v;
  if (isPlain(overlay) && overlay.__arr && Array.isArray(target)) {
    const out = target.slice();
    for (const [i, sec] of Object.entries(overlay.__arr)) out[i] = mergeOverlay(out[i], sec);
    return out;
  }
  if (isPlain(overlay) && isPlain(target)) {
    const out = { ...target };
    for (const [k, v] of Object.entries(overlay)) out[k] = mergeOverlay(out[k], v);
    return out;
  }
  if (isPlain(overlay) && overlay.__arr) return target;   // the array is gone; nothing to lay it on
  return overlay;
}

/** The dice of a roll and nothing else: the faces are the table's, the sum is not. */
export function diceOnlyRoll(rollData) {
  try {
    const data = typeof rollData === "string" ? JSON.parse(rollData) : (rollData?.toJSON?.() ?? rollData);
    const dice = (data?.terms ?? []).filter(t => Array.isArray(t?.results) && Number.isFinite(t?.faces));
    if (!dice.length) return null;
    const terms = [];
    dice.forEach((t, i) => {
      if (i) terms.push({ class: "OperatorTerm", options: {}, evaluated: true, operator: "+" });
      terms.push(t);
    });
    const total = dice.reduce((sum, t) => sum + t.results
      .filter(r => r.active !== false && !r.discarded).reduce((a, r) => a + (Number(r.result) || 0), 0), 0);
    const formula = dice.map(t => `${t.number ?? t.results.length}d${t.faces}${(t.modifiers ?? []).join("")}`)
      .join(" + ");
    return { class: "Roll", options: {}, dice: [], formula, terms, total, evaluated: true };
  } catch (_) {
    return null;
  }
}

/* ═══ 2. THE ONE FUNCTION ═══════════════════════════════════════════════════ */

/** Is this an ACE card? Anything else (the system's own cards) is not touched. */
export function isAceData(data) {
  const flags = data?.flags ?? {};
  if (ACE_NAMESPACES.some(ns => flags[ns] && Object.keys(flags[ns]).length)) return true;
  return /ace-qol-|forge-|data-ace-secret/.test(String(data?.content ?? "") + String(data?.flavor ?? ""));
}

/**
 * Split one card, or one change to a card, into what goes on the message and
 * what goes only to the GM.
 *
 * @param {object} data  any of {content, flavor, flags, rolls, whisper}
 * @param {object} [o]
 * @param {string|null} [o.cardActor]  whose card it is, when an element names nobody
 * @param {boolean} [o.gmOnly]  a card only GMs receive: all of it is the GM's
 * @param {Function} [o.isTable]  is this actor id one of the party?
 * @returns {{pub: object, secret: {slots: Array, flags: object|undefined, rolls: Array|undefined}}}
 */
export function forTable(data, { cardActor = null, gmOnly = false, makeId = newSlotId, isTable = NOBODY } = {}) {
  const pub = {};
  const secret = { slots: [], flags: undefined, rolls: undefined };
  for (const field of ["content", "flavor"]) {
    if (typeof data?.[field] !== "string") continue;
    if (gmOnly && data[field].trim()) {
      // ⚠️ A WHISPER TO THE GM IS STILL SENT TO EVERY PLAYER. Its words are the
      // GM's, so all of them are a slot.
      const id = makeId();
      pub[field] = `<div data-ace-slot="${id}"></div>`;
      secret.slots.push({ id, aud: "gm", html: data[field] });
      continue;
    }
    const r = splitHtml(data[field], { cardActor, makeId, isTable });
    pub[field] = r.html;
    secret.slots.push(...r.slots);
  }
  if (data?.flags !== undefined) {
    const flags = {};
    for (const [ns, v] of Object.entries(data.flags ?? {})) {
      if (!ACE_NAMESPACES.includes(ns) || !isPlain(v)) { flags[ns] = v; continue; }
      // ⚠️ A CARD WHISPERED TO THE GM: ITS ROUTING STAYS, ITS NUMBERS GO. It is
      // often posted BY a player (a refused press, a looted item), and that
      // player's own screen still reads its routing fields. Every number in it
      // is the GM's alone, a player character's included.
      const r = gmOnly
        ? splitFlags(v, "gm", { ns })
        : splitFlags(v, named(v.actorId) ?? cardActor ?? "gm", { isTable, ns });
      flags[ns] = r.pub;
      if (r.sec !== undefined) (secret.flags ??= {})[ns] = r.sec;
    }
    pub.flags = flags;
    // Where the change landed, so the GM lays the new numbers exactly there and
    // clears what the change replaced (an array that lost its secrets, a deleted
    // field). Secret values ride along inside it, so it goes to GMs only.
    secret.flagChange = data.flags;
  }
  if (Array.isArray(data?.rolls) && data.rolls.length) {
    pub.rolls = data.rolls.map(diceOnlyRoll).filter(Boolean).map(r => JSON.stringify(r));
    secret.rolls = data.rolls.map(r => (typeof r === "string" ? r : JSON.stringify(r?.toJSON?.() ?? r)));
  }
  return { pub, secret };
}

/** What one user gets back: the GM, everything that was cut; a player, nothing. */
export function shareFor(user, secret) {
  if (!secret || !user?.isGM) return null;
  const any = (secret.slots?.length ?? 0) || secret.flags !== undefined || secret.rolls !== undefined
    || secret.flagChange !== undefined;
  return any ? secret : null;
}

/* ═══ 3. IN FOUNDRY: THE HOOKS, THE SOCKET, THE STORE ═══════════════════════ */

/**
 * The GM's screen keeps every card's numbers in this browser's own store
 * (IndexedDB), so a reload of this browser puts them all back. A player's
 * screen keeps nothing.
 */
const TableStore = {
  _db: null,
  _cache: new Map(),       // messageId -> {slots, flags, rolls}
  _pending: new Map(),     // tableKey  -> {slots, flags, rolls, at}
  _ready: null,
  loaded: false,

  _key(id) { return `${game.world?.id ?? "world"}:${id}`; },

  open() {
    if (this._ready) return this._ready;
    this._ready = new Promise((resolve) => {
      const done = () => { this.loaded = true; resolve(); };
      try {
        const req = globalThis.indexedDB.open("ace-qol-table", 1);
        req.onupgradeneeded = () => req.result.createObjectStore("secrets");
        req.onsuccess = () => {
          this._db = req.result;
          const prefix = `${game.world?.id ?? "world"}:`;
          const tx = this._db.transaction("secrets", "readonly");
          const cur = tx.objectStore("secrets").openCursor();
          cur.onsuccess = () => {
            const c = cur.result;
            if (!c) return done();
            if (String(c.key).startsWith(prefix)) this._cache.set(String(c.key).slice(prefix.length), c.value);
            c.continue();
          };
          cur.onerror = () => {
            console.warn(`${MODULE_ID} | could not read the card numbers this browser kept:`, cur.error);
            done();
          };
        };
        req.onerror = () => {
          console.warn(`${MODULE_ID} | this browser would not open its store, so the numbers kept for `
            + `this screen last only until it reloads:`, req.error);
          done();
        };
      } catch (err) {
        console.warn(`${MODULE_ID} | no browser store here, so the numbers kept for this screen last `
          + `only until it reloads:`, err);
        done();
      }
    });
    return this._ready;
  },

  get(id) { return this._cache.get(id) ?? null; },

  /** Write through to the store once it is open: a card posted early is not lost. */
  _write(fn) {
    const go = () => {
      if (!this._db) return;   // the open already said why
      try {
        const tx = this._db.transaction("secrets", "readwrite");
        tx.onerror = () => console.warn(`${MODULE_ID} | this browser did not keep a card's numbers:`, tx.error);
        fn(tx.objectStore("secrets"));
      } catch (err) {
        console.warn(`${MODULE_ID} | could not keep a card's numbers in this browser:`, err);
      }
    };
    if (this._db) go();
    else this.open().then(go);
  },

  /**
   * Lay a new share over what this screen already holds for that card. Slots
   * accumulate; restore() drops the ones the card no longer shows.
   */
  put(id, share) {
    if (!id || !share) return null;
    const had = this._cache.get(id) ?? { slots: [], flags: undefined, rolls: undefined };
    const slots = new Map((had.slots ?? []).map(s => [s.id, s]));
    for (const s of share.slots ?? []) slots.set(s.id, s);
    const next = {
      slots: [...slots.values()],
      flags: nextFlagOverlay(had.flags, share),
      rolls: share.rolls ?? had.rolls,
    };
    this._cache.set(id, next);
    const key = this._key(id);
    this._write(store => store.put(next, key));
    return next;
  },

  drop(id) {
    this._cache.delete(id);
    const key = this._key(id);
    this._write(store => store.delete(key));
  },
};

/**
 * The overlay after one change: wherever the change wrote, the overlay becomes
 * the change's own overlay there (or nothing, when the new value has no
 * secrets); everywhere else it is untouched. A `-=` deletion takes its numbers
 * with it.
 */
export function applyOverlayChange(old, change, neu) {
  const out = (isPlain(old) && !old.__arr && !isLeaf(old)) ? { ...old } : {};
  for (const [k, v] of Object.entries(change ?? {})) {
    if (k.startsWith("-=")) { delete out[k.slice(2)]; continue; }
    if (isLeaf(neu?.[k])) {
      // A write INTO a secret object ("flags.x.trap.armed") changes that field and
      // keeps the rest of it; a write of the whole value replaces it.
      const had = out[k];
      out[k] = (isLeaf(had) && isPlain(had.v) && isPlain(neu[k].v) && isPlain(v))
        ? { __aud: neu[k].__aud, v: mergePlain(had.v, neu[k].v) }
        : neu[k];
      continue;
    }
    if (isPlain(v) && !(isPlain(neu?.[k]) && neu[k].__arr)) {
      const r = applyOverlayChange(out[k], v, isPlain(neu?.[k]) ? neu[k] : undefined);
      if (Object.keys(r).length) out[k] = r;
      else delete out[k];
    } else if (neu && k in neu) out[k] = neu[k];
    else delete out[k];
  }
  return out;
}

function mergePlain(a, b) {
  const out = { ...a };
  for (const [k, v] of Object.entries(b ?? {})) {
    if (k.startsWith("-=")) { delete out[k.slice(2)]; continue; }
    out[k] = (isPlain(out[k]) && isPlain(v)) ? mergePlain(out[k], v) : v;
  }
  return out;
}

/** Lay one overlay over another, leaf by leaf (a holder with no change shape). */
function layOverlay(had, next) {
  if (next === undefined) return had;
  if (isLeaf(next) || !isPlain(next) || !isPlain(had) || isLeaf(had)) return next;
  if (next.__arr || had.__arr) {
    if (!(next.__arr && had.__arr)) return next;
    const arr = { ...had.__arr };
    for (const [i, o] of Object.entries(next.__arr)) arr[i] = layOverlay(arr[i], o);
    return { __arr: arr };
  }
  const out = { ...had };
  for (const [k, o] of Object.entries(next)) out[k] = layOverlay(out[k], o);
  return out;
}

function nextFlagOverlay(had, share) {
  if (share.flagChange === undefined) return share.flags !== undefined ? layOverlay(had, share.flags) : had;
  const out = { ...(had ?? {}) };
  for (const [ns, change] of Object.entries(share.flagChange ?? {})) {
    if (!ACE_NAMESPACES.includes(ns) || !isPlain(change)) continue;
    const r = applyOverlayChange(out[ns], change, share.flags?.[ns]);
    if (Object.keys(r).length) out[ns] = r;
    else delete out[ns];
  }
  return out;
}

/** The actor an id names: an actor id, a uuid, or a token on any scene. */
function actorOf(id) {
  try {
    if (!id || id === "gm") return null;
    const actor = game.actors?.get(id);
    if (actor) return actor;
    if (String(id).includes(".")) {
      const doc = fromUuidSync?.(id);
      return doc?.documentName === "Actor" ? doc : (doc?.actor ?? null);
    }
    for (const scene of game.scenes ?? []) {
      const token = scene.tokens?.get(id);
      if (token) return token.actor ?? null;
    }
  } catch (_) { /* not a creature this world knows: the GM's */ }
  return null;
}

/**
 * One of the party: a creature a player owns. Its formula and DC are the
 * table's (his rule, 2026-10-11: "A player character's formula and DC are not a
 * secret. The whole table sees them."); its AC and hit points are the GM's like
 * anybody's. Anything no player owns is a creature, and all of its numbers are
 * the GM's.
 *
 * ⚠️ THE SAME TEST THE CARDS ALREADY DRAW BY (chat-render-utils isPartyActor,
 * his rule of 2026-10-06): owned by a player, not "is a character sheet". A
 * player's familiar or summon is the party's; a villain built on a character
 * sheet is not. A cut and a reveal that asked two different questions would
 * leave a number in the HTML and hidden, which is exactly what he ruled out.
 */
export function isParty(id) {
  const actor = actorOf(id);
  if (!actor) return false;
  try {
    return (game.users ?? []).some(u => !u.isGM && actor.testUserPermission(u, "OWNER"));
  } catch (_) {
    return false;
  }
}

/** The creature a card is about, for an element that names nobody. */
function cardActorOf(doc) {
  try {
    for (const ns of ACE_NAMESPACES) {
      const id = doc?.flags?.[ns]?.actorId;
      if (id) return id;
    }
    return doc?.speaker?.actor ?? null;
  } catch (_) {
    return null;
  }
}

/**
 * ⚠️ A PLAYER'S SCREEN REMEMBERS WHAT IT CUT, UNTIL THE GM HAS IT. A card a
 * player posts while the GM's browser is reloading (or not here yet) reaches no
 * GM, and a socket message sent before the GM's screen is listening is dropped.
 * The player's screen keeps what it cut from its own cards, in memory only and
 * only for this session, and hands it over when the GM's screen asks.
 */
const PostedHere = {
  _byMessage: new Map(),   // messageId -> [secret, ...] in the order they were cut
  _byKey: new Map(),       // tableKey  -> secret, until the card exists
  _limit: 300,
  keep(messageId, secret) {
    if (!messageId || !secret) return;
    const list = this._byMessage.get(messageId) ?? [];
    this._byMessage.delete(messageId);
    this._byMessage.set(messageId, [...list, secret]);
    while (this._byMessage.size > this._limit) this._byMessage.delete(this._byMessage.keys().next().value);
  },
};

/** Send what was cut to every GM whose screen is here. */
function deliver(secret, { messageId = null, tableKey = null } = {}) {
  if (!shareFor({ isGM: true }, secret)) return;
  const gms = (game.users ?? []).filter(u => u.active && u.isGM && u.id !== game.user.id);
  for (const gm of gms) {
    game.socket.emit(SOCKET, { type: "aceTable", messageId, tableKey, share: secret }, { recipients: [gm.id] });
  }
}

/**
 * Redraw a card only where this screen has drawn it or is drawing it now.
 * ⚠️ ui.chat.updateMessage POSTS a card it cannot find (chat.mjs #updateMessage
 * → #postOne), so asking it to redraw a card that is not drawn puts that card,
 * however old, at the bottom of the log. `logged` is set the moment the log
 * starts drawing a card (#postOne, #doRenderBatch), and a redraw queued now
 * runs after that drawing finishes.
 */
function redrawIfDrawn(message) {
  try {
    if (!message?.logged || !message.visible) return;
    ui.chat?.updateMessage?.(message)?.catch?.(err =>
      console.warn(`${MODULE_ID} | could not redraw a card with its numbers on this screen:`, err));
  } catch (err) {
    console.warn(`${MODULE_ID} | could not redraw a card with its numbers on this screen:`, err);
  }
}

/** Put a card's numbers back into THIS screen's copy of it, and redraw it. */
function restore(message, { redraw = true } = {}) {
  const held = TableStore.get(message?.id);
  if (!held) return false;
  try {
    const src = message._source ?? {};
    const change = {};
    // The slots the card shows now. A redraw replaces its slots, so the old ones
    // are dropped here, while this copy still carries the public placeholders.
    const shown = new Set();
    for (const field of ["content", "flavor"]) {
      for (const m of String(src[field] ?? "").matchAll(SLOT)) shown.add(m[2]);
    }
    if (shown.size && held.slots?.some(s => !shown.has(s.id))) {
      held.slots = held.slots.filter(s => shown.has(s.id));
      TableStore.put(message.id, { slots: [] });
    }
    if (held.slots?.length) {
      for (const field of ["content", "flavor"]) {
        if (typeof src[field] !== "string") continue;
        const filled = fillHtml(src[field], held.slots);
        if (filled !== src[field]) change[field] = filled;
      }
    }
    if (held.flags) change.flags = mergeOverlay(foundry.utils.deepClone(src.flags ?? {}), held.flags);
    if (held.rolls?.length) change.rolls = held.rolls;
    if (!Object.keys(change).length) return false;
    // ⚠️ updateSource, never update: this is THIS screen's copy. Nothing is sent.
    message.updateSource(change, { recursive: false });
    if (redraw) redrawIfDrawn(message);
    return true;
  } catch (err) {
    console.warn(`${MODULE_ID} | could not put a card's numbers back on this screen:`, err);
    return false;
  }
}

/** The posting client: split before anything is sent. */
function onPreCreate(doc, data, options, userId) {
  if (userId !== game.user?.id || options?.temporary) return;
  if (!isAceData(doc._source)) return;
  try {
    const gmOnly = (doc.whisper?.length ?? 0) > 0
      && doc.whisper.every(id => game.users?.get(id)?.isGM);
    const src = doc.toObject();
    const { pub, secret } = forTable(src, { cardActor: cardActorOf(src), gmOnly, isTable: isParty });
    const tableKey = foundry.utils.randomID();
    pub.flags = foundry.utils.mergeObject(pub.flags ?? {}, { [MODULE_ID]: { tableKey } });
    doc.updateSource(pub, { recursive: false });
    const mine = shareFor(game.user, secret);
    if (mine) TableStore._pending.set(tableKey, { ...mine, at: Date.now() });
    else if (shareFor({ isGM: true }, secret)) PostedHere._byKey.set(tableKey, secret);
    deliver(secret, { tableKey });
  } catch (err) {
    // ⚠️🔴 NEVER POST THE NUMBERS BECAUSE THE SPLIT FAILED. Refusing the card is
    // loud and costs one card; posting it whole puts every number on the table.
    console.error(`${MODULE_ID} | a card could not be split for the table, so it was not posted:`, err);
    ui.notifications?.error("ACE: a card could not be made safe for the table and was not posted. See the console.");
    return false;
  }
}

/** The changing client: split the change before it is sent. */
function onPreUpdate(doc, changes, options, userId) {
  if (userId !== game.user?.id) return;
  if (!isAceData(doc._source) && !isAceData(changes)) return;
  const touched = ["content", "flavor", "flags", "rolls"].some(k => k in changes);
  if (!touched) return;
  try {
    const gmOnly = (doc.whisper?.length ?? 0) > 0 && doc.whisper.every(id => game.users?.get(id)?.isGM);
    const part = {};
    for (const k of ["content", "flavor", "flags", "rolls"]) if (k in changes) part[k] = changes[k];
    const { pub, secret } = forTable(part, { cardActor: cardActorOf(doc), gmOnly, isTable: isParty });
    for (const [k, v] of Object.entries(pub)) changes[k] = v;
    const mine = shareFor(game.user, secret);
    if (mine) TableStore.put(doc.id, mine);
    else if (shareFor({ isGM: true }, secret)) PostedHere.keep(doc.id, secret);
    deliver(secret, { messageId: doc.id });
  } catch (err) {
    console.error(`${MODULE_ID} | a change to a card could not be split for the table, so it was not `
      + `made:`, err);
    ui.notifications?.error("ACE: a card change could not be made safe for the table and was not sent. See the console.");
    return false;
  }
}

function onCreate(message) {
  const key = message?.flags?.[MODULE_ID]?.tableKey;
  if (key && TableStore._pending.has(key)) {
    const share = TableStore._pending.get(key);
    TableStore._pending.delete(key);
    TableStore.put(message.id, share);
  }
  if (key && PostedHere._byKey.has(key)) {
    PostedHere.keep(message.id, PostedHere._byKey.get(key));
    PostedHere._byKey.delete(key);
  }
  restore(message);
}

function onUpdate(message) { restore(message); }

function onDelete(message) {
  TableStore.drop(message?.id);
  PostedHere._byMessage.delete(message?.id);
}

function onSocket(data, senderId) {
  if (data?.type === "aceTable") return receiveShare(data, senderId);
  if (data?.type === "aceTableAsk") return answerAsk(data, senderId);
  return undefined;
}

/** On the GM's screen: the numbers a card's poster cut from it. */
function receiveShare(data, senderId) {
  if (!game.user?.isGM) return;
  const sender = game.users?.get(senderId);
  if (!sender) return;
  const share = data.share;
  if (!share) return;
  // The numbers for a card must come from its author or a GM.
  if (data.messageId) {
    const msg = game.messages?.get(data.messageId);
    if (msg && !sender.isGM && msg.author?.id !== senderId) {
      console.warn(`${MODULE_ID} | ${sender.name} sent numbers for a card they did not post; refused.`);
      return;
    }
    TableStore.put(data.messageId, share);
    if (msg) restore(msg);
    return;
  }
  if (data.tableKey) {
    const msg = game.messages?.find(m => m.flags?.[MODULE_ID]?.tableKey === data.tableKey);
    if (msg) {
      if (!sender.isGM && msg.author?.id !== senderId) return;
      TableStore.put(msg.id, share);
      restore(msg);
    } else {
      TableStore._pending.set(data.tableKey, { ...share, at: Date.now(), from: senderId });
    }
  }
}

/**
 * On a player's screen: the GM's screen has come up without the numbers of
 * cards this player posted. Hand over what this screen cut from them, in the
 * order it was cut.
 */
function answerAsk(data, senderId) {
  if (game.user?.isGM) return;
  if (!game.users?.get(senderId)?.isGM) return;
  for (const id of (Array.isArray(data.ids) ? data.ids : []).slice(-500)) {
    for (const share of PostedHere._byMessage.get(id) ?? []) {
      game.socket.emit(SOCKET, { type: "aceTable", messageId: id, share }, { recipients: [senderId] });
    }
  }
}

/** Does a card still carry a hole where a number was cut? */
function wasCut(message) {
  return !!message.flags?.[MODULE_ID]?.tableKey
    || hasEmptySlots(message._source?.content) || hasEmptySlots(message._source?.flavor);
}

/**
 * On load, on the GM's screen: put back every number this browser kept, redraw
 * the cards already drawn, and ask each player who is here for the numbers of
 * the cards they posted while this screen was away.
 */
async function onReady() {
  await TableStore.open();
  if (!game.user?.isGM) {
    // A player's screen holds nothing (his rule, 2026-10-11: a creature's
    // numbers "stay on my screen only"). Anything an earlier version kept here
    // goes.
    for (const id of [...TableStore._cache.keys()]) TableStore.drop(id);
    return;
  }
  for (const message of game.messages ?? []) {
    if (TableStore.get(message.id)) restore(message);
  }
  // Keep only what belongs to messages that still exist.
  for (const id of [...TableStore._cache.keys()]) if (!game.messages?.get(id)) TableStore.drop(id);

  const askOf = new Map();
  for (const message of game.messages ?? []) {
    if (TableStore.get(message.id) || !wasCut(message)) continue;
    const author = message.author;
    if (!author || author.isGM || !author.active) continue;
    if (!askOf.has(author.id)) askOf.set(author.id, []);
    askOf.get(author.id).push(message.id);
  }
  for (const [userId, ids] of askOf) {
    game.socket.emit(SOCKET, { type: "aceTableAsk", ids: ids.slice(-500) }, { recipients: [userId] });
  }

  // ⚠️ ASK THE BROWSER TO KEEP THE STORE. Until it agrees, a browser short of
  // disk may clear a site's store; a reload never does.
  try {
    const kept = await globalThis.navigator?.storage?.persist?.();
    if (kept === false) {
      console.warn(`${MODULE_ID} | this browser keeps the GM's card numbers through a reload, but has not `
        + `agreed to keep them if it clears site data to free disk space.`);
    }
  } catch (err) {
    console.warn(`${MODULE_ID} | could not ask this browser to keep the GM's card numbers:`, err);
  }
}

/**
 * At render: fill any slot this screen holds that the copy did not have yet
 * (a share that landed after the card was drawn), and say so on the GM's
 * screen when a card's numbers were kept on another computer.
 */
export function fillRendered(message, el) {
  try {
    const held = TableStore.get(message?.id);
    const byId = new Map((held?.slots ?? []).map(s => [s.id, s.html]));
    let empty = 0;
    for (const holder of el?.querySelectorAll?.("[data-ace-slot]") ?? []) {
      const html = byId.get(holder.dataset.aceSlot);
      if (html === undefined) { empty++; continue; }
      const t = document.createElement("template");
      t.innerHTML = html;
      holder.replaceWith(t.content);
    }
    // Not before this browser's store has been read: a card drawn while it is
    // still loading is redrawn once it has (onReady).
    if (empty && game.user?.isGM && TableStore.loaded && !el.querySelector(".ace-qol-table-missing")) {
      const note = document.createElement("div");
      note.className = "ace-qol-table-missing";
      note.textContent = "The GM's numbers for this card were kept on the computer that ran it, not this one.";
      (el.querySelector(".message-content") ?? el).append(note);
    }
  } catch (err) {
    console.warn(`${MODULE_ID} | could not fill a card's numbers on this screen:`, err);
  }
}

export const TableView = {
  forTable, splitHtml, fillHtml, splitFlags, mergeOverlay, diceOnlyRoll, audienceOf, shareFor,
  isAceData, fillRendered, isParty,
  /** This screen's own copy of a card's numbers, if it holds them. */
  held(messageId) { return TableStore.get(messageId); },

  /**
   * Register once, at init: nothing may post before the split is in place.
   * @param {object} [o]
   * @param {string} [o.moduleId]  the module that owns it here ("ace-qol", or
   *        "ace-artificer" when Forge runs without QOL)
   * @param {boolean} [o.render]   also fill and reveal at render, for a module
   *        with no chrome pass of its own (QOL's registerAceChrome does both)
   * @param {Function} [o.onRender] the module's one chat helper
   *        (onRenderChatMessage in its foundry-compat.mjs), which picks the hook
   *        Foundry 13 or 14 fires. Handed in because this file is one file in two
   *        modules, byte for byte, and imports nothing.
   */
  register({ moduleId = "ace-qol", render = false, onRender = null } = {}) {
    if (this._registered) return;
    this._registered = true;
    MODULE_ID = moduleId;
    SOCKET = `module.${MODULE_ID}`;
    if (render) {
      const listen = (typeof onRender === "function") ? onRender : (fn) => {
        console.warn(`${MODULE_ID} | the table view was registered without its module's chat `
          + `helper, so it listens on renderChatMessageHTML, which Foundry 13 and 14 both fire.`);
        Hooks.on("renderChatMessageHTML", fn);
      };
      listen((message, el) => {
        fillRendered(message, el);
        if (game.user?.isGM) {
          for (const g of el?.querySelectorAll?.(".ace-qol-gm-only, .ace-qol-dmg-gm-controls, .forge-gm-only") ?? []) {
            g.setAttribute("data-ace-gm", "true");
          }
        }
      });
    }
    Hooks.on("preCreateChatMessage", onPreCreate);
    Hooks.on("preUpdateChatMessage", onPreUpdate);
    Hooks.on("createChatMessage", onCreate);
    Hooks.on("updateChatMessage", onUpdate);
    Hooks.on("deleteChatMessage", onDelete);
    Hooks.once("setup", () => { TableStore.open(); });
    Hooks.once("ready", () => {
      game.socket?.on(SOCKET, onSocket);
      onReady().catch(err => console.warn(`${MODULE_ID} | could not put the cards' numbers back:`, err));
    });
    console.log(`${MODULE_ID} | the table sees the die, the word, the damage that landed, and a party `
      + `member's formula and DC; every other number goes only to the GM, kept in the GM's browser.`);
  },
};
