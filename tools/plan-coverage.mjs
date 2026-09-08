// ─── Can a plan replace the sixteen shape words? ────────────────────────────
//
// Johnny, 2026-09-07: *"Figure out how we're going to do this without building
// entries for every spell."*
//
// This is the measurement that settles it. It reads every spell dnd5e ships,
// builds a plan for each from the item alone, and reports four things:
//
//   1. how many produce a complete, runnable plan with no entry
//   2. where the plan disagrees with one of the 110 hand-written entries
//   3. how many spells the CURRENT system silently robs of their initial save
//   4. what is left over, named, so nothing hides in a percentage
//
// ⚠️ IT WRITES NOTHING AND TOUCHES NO WORLD DATA. It reads the shipped
// compendiums out of the system folder.
//
// Run:  node tools/plan-coverage.mjs
// ──────────────────────────────────────────────────────────────────────────────

import { pathToFileURL } from "node:url";
import { existsSync, cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const QOL = "D:/FoundryVTT/Data/modules/ace-qol";
const SYSTEM = "D:/FoundryVTT/Data/systems/dnd5e";
const LEVELDB = "D:/FoundryVTT/Foundry Virtual Tabletop/resources/app/node_modules/classic-level/index.js";

if (!existsSync(LEVELDB)) {
  console.log("classic-level not found beside Foundry; nothing to read.");
  process.exit(0);
}
const { ClassicLevel } = await import(pathToFileURL(LEVELDB).href);

/* ── Enough of Foundry to load the readers ─────────────────────────────── */
globalThis.Hooks = { on: () => {}, once: () => {}, off: () => {}, callAll: () => {}, call: () => true };
globalThis.ui = { notifications: { info: () => {}, warn: () => {}, error: () => {} } };
globalThis.CONFIG = { DND5E: { abilities: {}, skills: {}, damageTypes: {}, senses: {} },
  statusEffects: [] };
globalThis.foundry = { utils: { escapeHTML: String, deepClone: (o) => o,
  mergeObject: (a, b) => ({ ...a, ...b }), getProperty: () => null }, applications: { api: {}, ux: {} } };
globalThis.game = { settings: { get: () => "2024", register: () => {} },
  i18n: { localize: (k) => k }, actors: [], scenes: [], user: { isGM: true } };
globalThis.canvas = { grid: { size: 100, distance: 5 }, tokens: { placeables: [] } };

const { readActionFacts } = await import(pathToFileURL(`${QOL}/scripts/inference/action-facts.mjs`).href);
const { planFor, initialSaveOwed, areaLingers } = await import(
  pathToFileURL(`${QOL}/scripts/inference/spell-plan.mjs`).href);
const { DescriptionParser } = await import(pathToFileURL(`${QOL}/scripts/description-parser.mjs`).href);
const { getSpellTiming, TIMING } = await import(
  pathToFileURL(`${QOL}/scripts/spell-timing.mjs`).href);
const { classifyItem } = await import(pathToFileURL(`${QOL}/scripts/inference/classify-item.mjs`).href);
const { SPELL_REGISTRY } = await import(
  pathToFileURL(`${QOL}/scripts/spell-pipeline/registry/_index.mjs`).href);

/* ── Shape an on-disk document the way Foundry hands one over ──────────── */
const live = (doc) => ({ ...doc,
  system: { ...doc.system,
    properties: new Set(doc.system?.properties ?? []),
    activities: new Map(Object.entries(doc.system?.activities ?? {})) } });

const PACKS = [`${SYSTEM}/packs/spells`, `${SYSTEM}/packs/spells24`];

/* ── Walk ──────────────────────────────────────────────────────────────── */
let total = 0, complete = 0, passive = 0, incomplete = 0;
const gapReasons = new Map();
const incompleteNames = [];
const robbed = [];        // owed an initial save the save engine was not posting
const waits = [];         // its text really does wait for you to walk in
const areaGoes = [];      // its area resolves once and is taken off the map
const areaStays = [];     // its area is stated to last
const areaUnsure = [];    // its text does not say, so it is left where it lands
const disagreements = [];
const withEntry = { total: 0, agree: 0 };

const bump = (m, k) => m.set(k, (m.get(k) ?? 0) + 1);

// Which shape words mean "the pipeline does nothing itself".
const NO_OP_SHAPES = new Set(["template-save", "template-trigger", "template-pool",
                              "attack-single", "aura"]);

// ⚠️ FOUNDRY HOLDS A LOCK ON ITS OWN PACKS WHILE IT IS RUNNING, and he will
// almost always have it open. Reading a copy costs a second and means this can
// be run without shutting his game down.
const scratch = mkdtempSync(join(tmpdir(), "ace-plan-"));
const openPack = async (path) => {
  try {
    const db = new ClassicLevel(path, { valueEncoding: "json" });
    await db.open();
    return db;
  } catch (err) {
    if (String(err?.cause?.code ?? err?.code) !== "LEVEL_LOCKED"
        && !/LOCK/i.test(String(err?.cause ?? err))) throw err;
    const copy = join(scratch, path.split(/[\\/]/).pop());
    // ⚠️ THE LOCK FILE IS THE ONE THING THAT CANNOT BE COPIED, because it is
    // the file being held. Everything else is ordinary LevelDB data.
    cpSync(path, copy, { recursive: true, filter: (s) => !/[\\/]LOCK$/i.test(s) });
    const db = new ClassicLevel(copy, { valueEncoding: "json" });
    await db.open();
    return db;
  }
};

for (const path of PACKS) {
  if (!existsSync(path)) { console.log(`missing pack: ${path}`); continue; }
  const db = await openPack(path);
  for await (const [key, doc] of db.iterator()) {
    if (!key.startsWith("!items!") || doc?.type !== "spell") continue;
    total++;
    const item = live(doc);

    let parsed = null, timing = null;
    try { parsed = DescriptionParser.parse(item); } catch (_) { }
    try { timing = getSpellTiming(item); } catch (_) { }
    const facts = (() => { try { return readActionFacts(item, { parsed }); } catch (_) { return null; } })();
    const plan = planFor(item, { facts, parsed, timing });

    if (plan.passive) { passive++; continue; }
    if (plan.complete) complete++;
    else {
      incomplete++;
      incompleteNames.push(doc.name);
      for (const g of plan.gaps) bump(gapReasons, g.replace(/"[^"]*"/g, '"..."'));
    }

    /* ── 3. Spells whose initial save the save engine was dropping ──────
       Reproduces the exact branch in save-engine._onTemplateResolved rather
       than a proxy for it: a persistent area spell, not area-denial, whose
       timing is neither ENTER_START nor ENTER_END, posts no card at all. */
    const isArea = !!plan.place?.template;
    const forcesSave = plan.decide?.kind === "save";
    const persistent = timing && !timing.isInstant;
    const enterTrigger = timing?.timing === TIMING.ENTER_START
                      || timing?.timing === TIMING.ENTER_END;
    const areaDenial = timing?.family === "areaDenial";
    if (isArea && forcesSave && persistent && !enterTrigger && !areaDenial) {
      const owed = initialSaveOwed(item, { hasSave: true });
      if (owed === true || owed === "unknown") {
        robbed.push({ name: doc.name, save: plan.decide.ability?.toUpperCase(),
                      why: owed === true ? "its text says so" : "its text does not say",
                      timing: `${timing?.timing}${timing?.unclassified ? " (a guess)" : ""}` });
      } else {
        waits.push(doc.name);
      }
    }

    /* ── 4. Does the AREA last, or only what it did to people? ────────── */
    if (isArea && persistent) {
      const shape = plan.place?.template?.shape ?? null;
      const lasts = areaLingers(item, { hasTemplate: true, shape });
      const row = `${doc.name} (${shape})`;
      if (lasts === false) areaGoes.push(row);
      else if (lasts === true) areaStays.push(row);
      else areaUnsure.push(row);
    }

    /* ── 2. Where a plan disagrees with a hand-written entry ────────────── */
    const entryName = String(doc.name).toLowerCase().replace(/\s*\(legacy\)\s*$/, "").trim();
    const entry = SPELL_REGISTRY?.[entryName];
    if (entry?.shape) {
      withEntry.total++;
      const agrees = planAgreesWithShape(plan, entry.shape);
      if (agrees) withEntry.agree++;
      else disagreements.push({ name: doc.name, entry: entry.shape, plan: describeShort(plan) });
    }
  }
  await db.close();
}
try { rmSync(scratch, { recursive: true, force: true }); } catch (_) { }

/** Does the plan describe the same resolution the entry's shape names? */
function planAgreesWithShape(plan, shape) {
  if (!plan?.complete) return false;
  const area = !!plan.place.template;
  const picked = plan.who.kind === "picked";
  const self = plan.place.kind === "self" || plan.who.kind === "the caster";
  const save = plan.decide.kind === "save";
  const attack = plan.decide.kind === "attack";
  const heals = !!(plan.apply.healing || plan.apply.damage.length === 0 && plan.apply.heals);
  const healsAny = !!plan.apply.healing;
  switch (shape) {
    case "template-save":
    case "template-trigger":
    case "template-pool":  return area;
    case "template-heal":  return area && healsAny;
    case "emanation-heal": return plan.place.kind === "emanation" && healsAny;
    case "aura":           return plan.place.kind === "emanation" || area;
    case "self":           return self;
    case "touch":          return plan.place.kind === "touch";
    case "save-single":    return picked && save;
    case "save-area":      return area && save;
    case "multi-buff":     return picked || self;
    case "multi-heal":     return picked && healsAny;
    case "distribute":     return picked;
    case "chained":        return picked;
    case "attack-single":  return attack;
    case "attack-multi":   return attack;
    default:               return false;
  }
}

function describeShort(plan) {
  if (!plan?.complete) return `no plan (${plan?.gaps?.[0] ?? "unreadable"})`;
  const p = plan.place, d = plan.decide;
  return `${p.template ? `${p.template.shape} ${p.template.size}ft` : p.kind}`
    + ` + ${d.kind === "save" ? `${d.ability?.toUpperCase()} save` : d.kind}`;
}

/* ── Report ────────────────────────────────────────────────────────────── */
const pct = (n) => `${String(n).padStart(3)} (${String(Math.round((n / total) * 100)).padStart(2)}%)`;

console.log("");
console.log("CAN A PLAN REPLACE THE SIXTEEN SHAPE WORDS?");
console.log("=".repeat(74));
console.log(`spells read from dnd5e's own books   : ${total}`);
console.log(`  a complete plan, from the item     : ${pct(complete)}`);
console.log(`  passive, no button to press        : ${pct(passive)}`);
console.log(`  cannot be planned, dnd5e keeps it  : ${pct(incomplete)}`);

console.log("");
console.log("WHY THE REST CANNOT BE PLANNED");
console.log("-".repeat(74));
if (!gapReasons.size) console.log("  nothing: every spell planned.");
for (const [reason, n] of [...gapReasons].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(n).padStart(3)}  ${reason}`);
}
if (incompleteNames.length) {
  console.log(`  they are: ${incompleteNames.slice(0, 20).join(", ")}`
    + `${incompleteNames.length > 20 ? `, +${incompleteNames.length - 20} more` : ""}`);
}

console.log("");
console.log("PERSISTENT AREA SPELLS AND THEIR INITIAL SAVE");
console.log("-".repeat(74));
console.log("  A persistent area spell posted an initial card only when its timing was");
console.log("  ENTER_START or ENTER_END. spell-timing DEFAULTS an unknown one to");
console.log("  START_OF_TURN, so these carried a saving throw nothing ever rolled.");
console.log("");
console.log(`  now save when it lands   : ${robbed.length}`);
console.log(`  really do wait for entry : ${waits.length}  (${waits.slice(0, 8).join(", ")}${
  waits.length > 8 ? ", ..." : ""})`);
console.log("");
for (const r of robbed.slice(0, 25)) {
  console.log(`    ${r.name.padEnd(28)} ${String(r.save).padEnd(4)} ${r.why.padEnd(24)} timing ${r.timing}`);
}
if (robbed.length > 25) console.log(`    +${robbed.length - 25} more`);

console.log("");
console.log("DOES THE AREA ITSELF LAST?");
console.log("-".repeat(74));
console.log("  A spell's duration is not its area's duration. Fear is a minute of");
console.log("  FRIGHTENED on people, not a minute of cone on the map.");
console.log("");
console.log(`  its text says the area lasts : ${areaStays.length}`);
console.log(`  resolves once, area removed  : ${areaGoes.length}  `
  + `${[...new Set(areaGoes)].join(", ")}`);
console.log(`  text does not say, left alone: ${areaUnsure.length}  (unchanged behaviour)`);
console.log("");
console.log("THE PLAN VERSUS THE 110 HAND-WRITTEN ENTRIES");
console.log("-".repeat(74));
console.log(`  shipped spells that have an entry  : ${withEntry.total}`);
console.log(`  plan describes the same resolution : ${withEntry.agree}`);
console.log(`  disagreements                      : ${disagreements.length}`);
for (const d of disagreements.slice(0, 30)) {
  console.log(`    ${d.name.padEnd(30)} entry says ${String(d.entry).padEnd(17)} plan says ${d.plan}`);
}
if (disagreements.length > 30) console.log(`    +${disagreements.length - 30} more`);
console.log("");
