// ─── Does the refill tool find exactly the emptied spells, and write only what
//     it should? ──────────────────────────────────────────────────────────────
//
// Johnny, 2026-09-11: spells across the hijinx world carried effects with
// nothing in them (Varek Thalor's Enervated had none of its six rules).
// scripts/refill-spell-effects.mjs puts them back from the books.
//
// ⚠️ A TOOL THAT WRITES TO HIS WORLD IS RUN HERE FIRST, FOR REAL, AGAINST A COPY.
// This loads the actual tool, hands it the real books and a copy of his real
// actors, and records every write it asks for instead of making it. Then it
// checks the writes: only empty effects, only rules and missing duration, the
// before-values carried in the same write, and an undo that puts them back.
//
// ⚠️ AND IT NAMES EVERY SPELL IT LEAVES ALONE, WITH THE REASON. The first
// measurement matched effects by id alone and counted 111 spells; the tool also
// demands the same spell name and a book copy that really has the rules. Every
// spell in the gap between the two is printed with the reason, so a difference
// is read, not assumed. (Its first run found the tool trusting a Monster Manual
// copy that was itself empty.)
//
// ⚠️ IT WRITES NOTHING. His world is read from a copy of its files.
//
// Run:  node tools/refill-selftest.mjs [world]      (default: hijinx)
// ──────────────────────────────────────────────────────────────────────────────

import { pathToFileURL } from "node:url";
import { existsSync, cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";

const WORLD = process.argv[2] ?? "hijinx";
const LEVELDB = "D:/FoundryVTT/Foundry Virtual Tabletop/resources/app/node_modules/classic-level/index.js";
if (!existsSync(LEVELDB)) { console.log("classic-level not found beside Foundry; nothing to read."); process.exit(0); }
const { ClassicLevel } = await import(pathToFileURL(LEVELDB).href);

const scratch = mkdtempSync(join(tmpdir(), "ace-refill-"));
let n = 0;
async function rows(path) {
  const dst = join(scratch, `db${n++}`);
  cpSync(path, dst, { recursive: true, filter: (s) => basename(s) !== "LOCK" });
  const db = new ClassicLevel(dst, { valueEncoding: "json" });
  await db.open();
  const out = [];
  for await (const kv of db.iterator()) out.push(kv);
  await db.close();
  return out;
}

/** An effect the way Foundry hands one over. */
const liveEffect = (e, uuid) => ({ ...e, id: e._id, uuid,
  toObject() { return JSON.parse(JSON.stringify({ ...e, changes: this.changes, flags: this.flags })); } });
const collection = (list) => ({ contents: list, get: (id) => list.find(x => x.id === id) ?? null });
const norm = (s) => String(s ?? "").toLowerCase().replace(/\s*\((legacy|2014|2024)\)\s*$/, "")
  .replace(/[^a-z0-9]+/g, " ").trim();

/* ── The books, as Foundry compendium packs ─────────────────────────────── */
const PACKS = {
  "dnd5e.spells": "D:/FoundryVTT/Data/systems/dnd5e/packs/spells",
  "dnd5e.spells24": "D:/FoundryVTT/Data/systems/dnd5e/packs/spells24",
  "dnd-players-handbook.spells": "D:/FoundryVTT/Data/modules/dnd-players-handbook/packs/spells",
};
const packs = new Map();
const rulesById = new Map();         // effect id -> rules in some book copy
const bookByName = new Map();        // name -> [book item]
for (const [id, path] of Object.entries(PACKS)) {
  if (!existsSync(join(path, "CURRENT"))) continue;
  const items = new Map(), effs = new Map();
  for (const [k, v] of await rows(path)) {
    if (k.startsWith("!items!")) items.set(v._id, v);
    else if (k.startsWith("!items.effects!")) {
      const itemId = k.slice("!items.effects!".length).split(".")[0];
      if (!effs.has(itemId)) effs.set(itemId, []);
      effs.get(itemId).push(v);
      rulesById.set(v._id, Math.max(rulesById.get(v._id) ?? 0, (v.changes ?? []).length));
    }
  }
  const docs = new Map();
  for (const it of items.values()) {
    const uuid = `Compendium.${id}.Item.${it._id}`;
    const doc = { ...it, id: it._id, uuid,
      effects: collection((effs.get(it._id) ?? []).map(e => liveEffect(e, `${uuid}.ActiveEffect.${e._id}`))) };
    docs.set(it._id, doc);
    if (!bookByName.has(norm(it.name))) bookByName.set(norm(it.name), []);
    bookByName.get(norm(it.name)).push(doc);
  }
  packs.set(id, { collection: id, docs,
    getIndex: async () => [...items.values()].map(it => ({ _id: it._id, name: it.name, type: it.type,
      system: { source: { rules: it.system?.source?.rules ?? null } } })) });
}

/* ── His world's actors, recording every write instead of making it ─────── */
const writes = [];
const actorRows = await rows(`D:/FoundryVTT/Data/worlds/${WORLD}/data/actors`);
rmSync(scratch, { recursive: true, force: true });
const actorsById = new Map(), itemsByKey = new Map(), effsByKey = new Map();
for (const [k, v] of actorRows) {
  if (k.startsWith("!actors!")) actorsById.set(v._id, v);
  else if (k.startsWith("!actors.items!")) itemsByKey.set(k.slice("!actors.items!".length), v);
  else if (k.startsWith("!actors.items.effects!")) {
    const [a, i] = k.slice("!actors.items.effects!".length).split(".");
    const key = `${a}.${i}`;
    if (!effsByKey.has(key)) effsByKey.set(key, []);
    effsByKey.get(key).push(v);
  }
}
const actors = [];
for (const a of actorsById.values()) {
  const items = [];
  for (const [key, it] of itemsByKey) {
    if (!key.startsWith(`${a._id}.`)) continue;
    const uuid = `Actor.${a._id}.Item.${it._id}`;
    const effects = (effsByKey.get(key) ?? []).map(e => liveEffect(e, `${uuid}.ActiveEffect.${e._id}`));
    const item = { ...it, id: it._id, uuid, _actor: a, effects: collection(effects),
      async updateEmbeddedDocuments(type, updates) {
        // ⚠️ THE EXACT ITEM, not "an item with that name on an actor with that
        // name": two creatures here are called Empyrean, and Varek carries two
        // Raise Deads.
        writes.push({ actor: a, item, type, updates,
          apply() {
            for (const u of updates) {
              const e = effects.find(x => x.id === u._id);
              if (!e) continue;
              if ("changes" in u) e.changes = u.changes;
              e.flags = { ...(e.flags ?? {}), "ace-qol": { ...(e.flags?.["ace-qol"] ?? {}),
                refilled: u["flags.ace-qol.refilled"] } };
            }
          } });
        return updates;
      } };
    items.push(item);
  }
  actors.push({ id: a._id, name: a.name, items: collection(items) });
}

/* ── Enough of Foundry for the tool ─────────────────────────────────────── */
const cards = [];
globalThis.game = { user: { isGM: true }, users: Object.assign([], { filter: () => [] }),
  actors: { contents: actors }, scenes: { contents: [] },
  packs: { get: (id) => packs.get(id) ?? null } };
globalThis.ui = { notifications: { info: () => {}, warn: () => {}, error: () => {} } };
globalThis.foundry = { utils: { deepClone: (o) => JSON.parse(JSON.stringify(o)),
  escapeHTML: (x) => String(x ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;") } };
globalThis.ChatMessage = { create: async (m) => { cards.push(m); return m; } };
// Only book spells resolve here. A uuid into a Monster Manual creature returns
// nothing, which in Foundry would be that creature's own (sometimes empty) copy;
// the tool must fall through to the spell books either way.
globalThis.fromUuid = async (uuid) => {
  const m = String(uuid).match(/^Compendium\.(.+)\.Item\.([^.]+)$/);
  return m ? (packs.get(m[1])?.docs.get(m[2]) ?? null) : null;
};
const tables = [];
const realTable = console.table;
console.table = (t) => { tables.push(t); };

const { refillSpellEffects } = await import(
  pathToFileURL("D:/FoundryVTT/Data/modules/ace-qol/scripts/refill-spell-effects.mjs").href);

let pass = 0, fail = 0;
const check = (label, got, want) => {
  const ok = got === want;
  ok ? pass++ : fail++;
  console.log((ok ? "  ok   " : "  FAIL ") + label.padEnd(66) + `got ${got}, want ${want}`);
};

/* ── 1. Look first ──────────────────────────────────────────────────────── */
console.log(`1. LOOKING AT ${WORLD.toUpperCase()}`);
const preview = await refillSpellEffects();
check("looking writes nothing", writes.length, 0);
check("and posts no card", cards.length, 0);
console.log(`     found ${preview.found} empty effect(s) in ${preview.spells} spell(s) on ${preview.creatures} creature(s)`);
check("it finds the 111 spells measured on 2026-09-11", preview.spells, 111);
check("on the same 18 creatures, two pairs of which share a name", preview.creatures, 18);

// The id-only count, done again here, and every difference named.
const byIdOnly = new Map();   // item -> actor
for (const a of actors) for (const it of a.items.contents) {
  if (it.effects.contents.some(e => !(e.changes ?? []).length && (rulesById.get(e.id) ?? 0) > 0)) byIdOnly.set(it, a);
}
const found = new Set((tables[0] ?? []).map(r => `${r.creature}|${r.spell}`));
const gap = [...byIdOnly].filter(([it, a]) => !found.has(`${a.name}|${it.name}`));
console.log(`     the id-only count flags ${byIdOnly.size} item(s); the tool leaves ${gap.length} of them alone:`);
let unexplained = 0;
for (const [it, a] of gap) {
  const hollowIds = it.effects.contents.filter(e => !(e.changes ?? []).length && (rulesById.get(e.id) ?? 0) > 0).map(e => e.id);
  const named = bookByName.get(norm(it.name)) ?? [];
  let why;
  if (it.type !== "spell") why = `it is a ${it.type}, not a spell: its effect id only happens to match one`;
  else if (!named.length) why = "no book spell has that name, so the id match is a coincidence";
  else if (!named.some(d => hollowIds.some(id => d.effects.get(id)))) why = "the book spell by that name carries different effects";
  else { why = "NOT EXPLAINED"; unexplained++; }
  console.log(`       ${a.name} / ${it.name}: ${why}`);
}
check("every spell the tool leaves alone has a reason", unexplained, 0);
const extra = [...found].filter(k => ![...byIdOnly].some(([it, a]) => `${a.name}|${it.name}` === k));
check("and it touches nothing the id-only count would not", extra.length, 0);

/* ── 2. Refill ──────────────────────────────────────────────────────────── */
console.log("\n2. REFILLING");
const done = await refillSpellEffects({ apply: true });
const updates = writes.flatMap(w => w.updates.map(u => ({ ...u, _actor: w.actor.name, _item: w.item.name })));
check("every effect it found was written", done.written, preview.found);
check("every write puts rules back", updates.every(u => Array.isArray(u.changes) && u.changes.length > 0), true);
const allowed = new Set(["_id", "changes", "duration.seconds", "duration.rounds", "duration.turns",
  "flags.ace-qol.refilled", "_actor", "_item"]);
check("and writes nothing but rules, missing duration, and its own record",
  updates.every(u => Object.keys(u).every(k => allowed.has(k))), true);
check("every write carries what it replaced",
  updates.every(u => Array.isArray(u["flags.ace-qol.refilled"]?.before?.changes)), true);
const enervated = updates.find(u => u._actor === "Varek Thalor (CR 30)" && u._item === "Ray of Enfeeblement"
  && u.changes.length === 6);
check("Varek's Enervated gets its six rules back", !!enervated, true);
check("and its one-minute duration", enervated?.["duration.seconds"], 60);
const hag = updates.find(u => u._actor === "Night Hag" && u._item === "Phantasmal Killer");
check("the Night Hag's Phantasmal Killer is refilled from the spell book", !!hag, true);
check("the only writes are to effects", writes.every(w => w.type === "ActiveEffect"), true);
check("one card tells the GM what changed", cards.length, 1);

/* ── 3. Undo ────────────────────────────────────────────────────────────── */
console.log("\n3. PUTTING IT BACK");
for (const w of writes) w.apply();
const written = writes.length;
writes.length = 0;
const undone = await refillSpellEffects({ undo: true });
const back = writes.flatMap(w => w.updates);
check(`undo puts every one back (${written} item write(s) made)`, undone.restored, done.written);
check("each with its rules emptied again, as it was", back.every(u => Array.isArray(u.changes) && u.changes.length === 0), true);
check("and its record removed", back.every(u => "flags.ace-qol.-=refilled" in u), true);
const enBack = back.find(u => u._id === enervated?._id && "duration.seconds" in u);
check("Varek's Enervated loses the minute it did not have", enBack?.["duration.seconds"], null);

console.table = realTable;
console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
