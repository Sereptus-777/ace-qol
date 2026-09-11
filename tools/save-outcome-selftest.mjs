// ─── Does every save spell in the books land the right effect, on the right
//     result, on the right creatures? ─────────────────────────────────────────
//
// Johnny, 2026-09-11: Ray of Enfeeblement did nothing to Neferon on a failed
// save, and Prismatic Spray rolled for one creature out of the two in its cone.
//
// Two readers answer those, and both are measured here against every spell dnd5e
// and the Player's Handbook ship, not against a handful of hand-built stubs:
//
//   1. which of a save's own effects go on a FAILURE and which on a SUCCESS
//      (inference/save-outcome-effects.mjs)
//   2. whether an area catches everyone in it, or lets the caster choose
//      (inference/action-facts.mjs readScope + spell-plan.mjs planWho)
//
// Then it pins the spells whose answers are known by hand, so a change that
// moves one of them fails loudly instead of quietly re-routing a spell.
//
// ⚠️ IT WRITES NOTHING AND TOUCHES NO WORLD DATA. It reads copies of the shipped
// compendiums, so it can run while Foundry holds its locks.
//
// Run:  node tools/save-outcome-selftest.mjs          (add --list to see every row)
// ──────────────────────────────────────────────────────────────────────────────

import { pathToFileURL } from "node:url";
import { existsSync, cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";

const QOL = "D:/FoundryVTT/Data/modules/ace-qol";
const SYSTEM = "D:/FoundryVTT/Data/systems/dnd5e";
const LEVELDB = "D:/FoundryVTT/Foundry Virtual Tabletop/resources/app/node_modules/classic-level/index.js";
const LIST = process.argv.includes("--list");

if (!existsSync(LEVELDB)) {
  console.log("classic-level not found beside Foundry; nothing to read.");
  process.exit(0);
}
const { ClassicLevel } = await import(pathToFileURL(LEVELDB).href);

/* ── Enough of Foundry to load the readers ─────────────────────────────── */
globalThis.Hooks = { on: () => {}, once: () => {}, off: () => {}, callAll: () => {}, call: () => true };
globalThis.ui = { notifications: { info: () => {}, warn: () => {}, error: () => {} } };
globalThis.CONFIG = { DND5E: { abilities: {}, skills: {}, damageTypes: {}, senses: {} }, statusEffects: [] };
globalThis.foundry = { utils: { escapeHTML: String, deepClone: (o) => o,
  mergeObject: (a, b) => ({ ...a, ...b }), getProperty: () => null }, applications: { api: {}, ux: {} } };
globalThis.game = { settings: { get: () => "2024", register: () => {} },
  i18n: { localize: (k) => k }, actors: [], scenes: [], user: { isGM: true } };
globalThis.canvas = { grid: { size: 100, distance: 5 }, tokens: { placeables: [] } };

const { readSaveOutcomeEffects, readSaveOutcome } = await import(
  pathToFileURL(`${QOL}/scripts/inference/save-outcome-effects.mjs`).href);
const { planFor } = await import(pathToFileURL(`${QOL}/scripts/inference/spell-plan.mjs`).href);
const { DescriptionParser } = await import(pathToFileURL(`${QOL}/scripts/description-parser.mjs`).href);
let SPELL_REGISTRY = {};
try {
  ({ SPELL_REGISTRY } = await import(pathToFileURL(`${QOL}/scripts/spell-pipeline/registry/_index.mjs`).href));
} catch (e) { console.log("(registry did not load under stubs: " + e.message + ")"); }
const regKey = (n) => String(n ?? "").toLowerCase().replace(/\s*\((legacy|2014|2024)\)\s*$/, "").trim();

/* ── The shipped books, shaped the way Foundry hands an item over ──────── */
const PACKS = [`${SYSTEM}/packs/spells`, `${SYSTEM}/packs/spells24`,
  "D:/FoundryVTT/Data/modules/dnd-players-handbook/packs/spells"];
const scratch = mkdtempSync(join(tmpdir(), "ace-outcome-"));
let n = 0;
const spells = [];
for (const p of PACKS) {
  if (!existsSync(join(p, "CURRENT"))) continue;
  const dst = join(scratch, `db${n++}`);
  cpSync(p, dst, { recursive: true, filter: (src) => basename(src) !== "LOCK" });
  const db = new ClassicLevel(dst, { valueEncoding: "json" });
  await db.open();
  const items = new Map(), effs = new Map();
  for await (const [k, v] of db.iterator()) {
    if (k.startsWith("!items!")) items.set(v._id, v);
    else if (k.startsWith("!items.effects!")) {
      const itemId = k.slice("!items.effects!".length).split(".")[0];
      if (!effs.has(itemId)) effs.set(itemId, []);
      effs.get(itemId).push(v);
    }
  }
  await db.close();
  for (const it of items.values()) {
    if (it.type !== "spell") continue;
    spells.push({ pack: basename(p) === "spells" && p.includes("players-handbook") ? "phb" : basename(p),
      item: { ...it, effects: effs.get(it._id) ?? [],
        system: { ...it.system, properties: new Set(it.system?.properties ?? []),
          activities: new Map(Object.entries(it.system?.activities ?? {})) } } });
  }
}
rmSync(scratch, { recursive: true, force: true });
console.log(`spells read from the books: ${spells.length}\n`);

let pass = 0, fail = 0;
const check = (label, got, want) => {
  const ok = got === want;
  ok ? pass++ : fail++;
  console.log((ok ? "  ok   " : "  FAIL ") + label.padEnd(66) + `got ${got}, want ${want}`);
};
const find = (name, rules) => spells.find(s => s.item.name === name
  && (!rules || s.item.system?.source?.rules === rules))?.item ?? null;

/* ── 1. Failure effects and success effects ─────────────────────────────── */
console.log("1. WHICH EFFECT GOES ON WHICH RESULT");
const tally = new Map();
const successRows = [], bothRows = [];
for (const { pack, item } of spells) {
  const rows = readSaveOutcomeEffects(item);
  for (const r of rows) {
    const kind = r.statuses.length && r.changes ? "condition+rules"
      : r.statuses.length ? "condition only" : r.changes ? "rules only" : "words only";
    const k = `${r.on.padEnd(7)} ${kind}`;
    tally.set(k, (tally.get(k) ?? 0) + 1);
    if (r.on === "success") successRows.push(`     ${pack.padEnd(8)} ${item.name.padEnd(28)} "${r.name}" (${r.why})`);
    if (r.on === "both") bothRows.push(`     ${pack.padEnd(8)} ${item.name.padEnd(28)} "${r.name}"`);
  }
}
for (const [k, v] of [...tally].sort()) console.log(`     ${k.padEnd(28)} ${v}`);
console.log(`\n   read as a SUCCESS effect from the spell's own words (${successRows.length}):`);
for (const r of successRows) console.log(r);
if (LIST) {
  console.log(`\n   applied on either result, as the data says (${bothRows.length}):`);
  for (const r of bothRows) console.log(r);
  // The two kinds the save engine handles differently, named so they can be read.
  console.log("\n   failure effects that carry a CONDITION AND RULES (the condition goes through the");
  console.log("   condition library; the rules go on as the spell's own effect):");
  for (const { pack, item } of spells) {
    for (const r of readSaveOutcomeEffects(item)) {
      if (r.on !== "fail" || !r.statuses.length || !r.changes) continue;
      const reg = SPELL_REGISTRY[regKey(item.name)] ? " [registry]" : "";
      console.log(`     ${pack.padEnd(8)} ${item.name.padEnd(28)} "${r.name}" ${r.statuses.join("+")} + ${r.changes} rule(s)${reg}`);
    }
  }
  console.log("\n   failure effects that are WORDS ONLY (put on as a reminder of what the spell does):");
  for (const { pack, item } of spells) {
    for (const r of readSaveOutcomeEffects(item)) {
      if (r.on !== "fail" || !r.descriptionOnly) continue;
      const reg = SPELL_REGISTRY[regKey(item.name)] ? " [registry]" : "";
      console.log(`     ${pack.padEnd(8)} ${item.name.padEnd(28)} "${r.name}"${reg}`);
    }
  }
}

const ray = find("Ray of Enfeeblement", "2024");
const rayRows = ray ? readSaveOutcomeEffects(ray) : [];
const on = (rows, name) => rows.find(r => r.name === name)?.on ?? "missing";
console.log("");
check("Ray of Enfeeblement 2024: Enervated goes on a failure", on(rayRows, "Enervated"), "fail");
check("Ray of Enfeeblement 2024: Brief Enfeeblement goes on a success", on(rayRows, "Brief Enfeeblement"), "success");
check("Enervated carries its six rules", rayRows.find(r => r.name === "Enervated")?.changes, 6);
const rayParsed = ray ? DescriptionParser.parse(ray) : null;
check("the Ray's text gives an end-of-turn repeat save", rayParsed?.repeatingSave?.trigger ?? "none", "endOfTurn");
const ps = find("Prismatic Spray", "2024");
const psRows = ps ? readSaveOutcomeEffects(ps) : [];
check("Prismatic Spray 2024: both of its effects carry a condition",
  psRows.length === 2 && psRows.every(r => r.statuses.length > 0), true);
const hold = find("Hold Person", "2024");
const holdRows = hold ? readSaveOutcomeEffects(hold) : [];
check("Hold Person 2024: its effect is a condition on a failure",
  holdRows.length > 0 && holdRows.every(r => r.on === "fail" && r.statuses.includes("paralyzed")), true);

// ── Several effects on one result are alternatives: only what they share lands ──
const outcome = (name, rules) => { const it = find(name, rules); return it ? readSaveOutcome(it) : null; };
const dw = outcome("Divine Word", "2024");
check("Divine Word 2024: its failure results are alternatives", dw?.alternatives, true);
check("Divine Word 2024: nothing is shared, so nothing lands on its own", dw?.shared.length, 0);
check("Divine Word 2024: and 'dead' is not put on anybody", dw?.fail.some(r => r.statuses.includes("dead")), false);
const con = outcome("Contagion", "2024");
check("Contagion 2024: alternatives, but every one of them poisons", con?.shared.join(","), "poisoned");
check("Prismatic Spray 2024: indigo and violet are alternatives", outcome("Prismatic Spray", "2024")?.alternatives, true);
check("Blindness/Deafness 2024: the caster's pick, not both", outcome("Blindness/Deafness", "2024")?.alternatives, true);
check("Enlarge/Reduce 2024: never both at once", outcome("Enlarge/Reduce", "2024")?.fail.length, 0);
check("Hypnotic Pattern 2024: one result, so it lands", outcome("Hypnotic Pattern", "2024")?.alternatives, false);
const rayO = outcome("Ray of Enfeeblement", "2024");
check("Ray 2024: Enervated on a failure", rayO?.fail.map(r => r.name).join(","), "Enervated");
check("Ray 2024: Brief Enfeeblement on a success", rayO?.success.map(r => r.name).join(","), "Brief Enfeeblement");
const fts = outcome("Flesh to Stone", "2024");
check("Flesh to Stone 2024: an either-result effect is not an alternative", fts?.alternatives, false);

/* ── 2. Who an area catches ─────────────────────────────────────────────── */
console.log("\n2. WHO AN AREA SPELL CATCHES");
const picked = [], spared = [];
let areaSaves = 0, everyone = 0, other = 0;
for (const { pack, item } of spells) {
  const acts = [...item.system.activities.values()];
  const hasSave = acts.some(a => a.type === "save");
  const hasTpl = acts.some(a => a?.target?.template?.type) || !!item.system?.target?.template?.type;
  if (!hasSave || !hasTpl) continue;
  areaSaves++;
  let plan = null;
  try { plan = planFor(item); } catch (e) { other++; continue; }
  const w = plan?.who;
  const reg = SPELL_REGISTRY[regKey(item.name)] ? ` [registry: ${SPELL_REGISTRY[regKey(item.name)].shape}]` : "";
  if (w?.kind === "picked inside the area") {
    picked.push(`     ${pack.padEnd(8)} ${item.name.padEnd(28)} up to ${w.count ?? "any number"}${reg}  "${w.choiceWords ?? "sheet"}"`);
  } else if (w?.kind === "everyone inside") {
    everyone++;
    if (w.mayExclude) spared.push(`     ${pack.padEnd(8)} ${item.name.padEnd(28)}${reg}  "${w.choiceWords}"`);
  } else other++;
}
console.log(`   area spells with a save: ${areaSaves}; everyone inside: ${everyone}; `
  + `caster picks: ${picked.length}; other: ${other}`);
console.log("   the caster picks who, from inside the area:");
for (const r of picked) console.log(r);
console.log("   everyone inside, but the caster may spare some (today's rule is kept for these):");
for (const r of spared) console.log(r);

const who = (name, rules) => { const it = find(name, rules); return it ? planFor(it)?.who : null; };
console.log("");
check("Prismatic Spray 2024 catches everyone in the cone", who("Prismatic Spray", "2024")?.kind, "everyone inside");
check("Prismatic Spray 2014 catches everyone in the cone", who("Prismatic Spray", "2014")?.kind, "everyone inside");
check("Fireball 2024 catches everyone", who("Fireball", "2024")?.kind, "everyone inside");
check("Hypnotic Pattern 2024 catches everyone", who("Hypnotic Pattern", "2024")?.kind, "everyone inside");
check("Cloudkill 2024 catches everyone", who("Cloudkill", "2024")?.kind, "everyone inside");
check("Fear 2024 catches everyone", who("Fear", "2024")?.kind, "everyone inside");
check("Slow 2024: the caster picks", who("Slow", "2024")?.kind, "picked inside the area");
check("Slow 2024: up to six", who("Slow", "2024")?.count, 6);
check("Slow 2014: the caster picks", who("Slow", "2014")?.kind, "picked inside the area");
check("Sleep 2024: the caster picks", who("Sleep", "2024")?.kind, "picked inside the area");
check("Sleep 2024: any number of them", who("Sleep", "2024")?.count, null);
check("Weird 2024: the caster picks", who("Weird", "2024")?.kind, "picked inside the area");
check("Calm Emotions 2024 is not a pick (its choice is about something else)",
  who("Calm Emotions", "2024")?.kind === "picked inside the area", false);
check("Spirit Guardians 2024 lets the caster spare creatures", who("Spirit Guardians", "2024")?.mayExclude, true);

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
