// ─── Is this a real choice, or the same row twice? ───────────────────────────
//
// ⚠️ MEASURE A CHOOSER RULE AGAINST THE WHOLE WORLD BEFORE SHIPPING IT. This is
// the third chooser rule written for Johnny. The first moved 113 presses and
// trampled Command, Wall of Fire and Plane Shift; the second still moved 15; the
// only one that was right moved exactly the presses he was complaining about.
// So this file does two things, and the second matters more than the first: it
// pins the rule against the shapes he named, and then it runs the rule over
// every item in his world and every book on his shelf and reports the count.
//
// If that count moves, somebody widened a chooser rule, and the list below says
// whose press changed.
import { existsSync, cpSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { join, basename } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { oneRealChoice, pickTheRealOne } from "../scripts/rules/one-real-choice.mjs";

let pass = 0, fail = 0;
const check = (label, ok, detail) => {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${String(label).padEnd(72)} ${detail}`);
};
const act = (type, name, extra = {}) => ({ type, name, ...extra });

console.log("\nTHE SHAPES HE NAMED");
{
  // His Thunder Step, from the token that produced the bug.
  const thunderStep = [
    act("save", "", { target: { override: true, template: { type: "radius", size: "10" } },
      range: { units: "self", override: true }, damage: { parts: [{ number: 3, denomination: 10 }] } }),
    act("save", "", { target: { override: false }, range: { override: false },
      damage: { parts: [{ number: 3, denomination: 10 }] } }),
  ];
  check("Thunder Step's two blank Save rows are one thing twice",
    oneRealChoice(thunderStep).one === true, oneRealChoice(thunderStep).why);
  check("and the row that is run is the one that says where it lands, not the stub that inherits",
    pickTheRealOne(thunderStep) === thunderStep[0],
    "the 10-foot radius on self wins over the row that falls back to the item's 90 feet");

  // ⚠️ EVERY ONE OF THESE MUST STILL ASK. Three of the four are the same type as
  // each other, which is exactly why the rule reads the LABEL.
  const wallOfFire = [act("save", "Create Wall"), act("save", "Create Ring")];
  const command = ["Approach", "Drop", "Flee", "Grovel", "Halt"].map(n => act("save", n));
  const prismatic = [act("utility", "Create Wall"), act("utility", "Create Globe"),
    act("save", "Blinding Save"), act("save", "Traversal Save")];
  const planeShift = [act("attack", ""), act("save", "")];
  check("Wall of Fire still asks: wall or ring", oneRealChoice(wallOfFire).one === false, oneRealChoice(wallOfFire).why);
  check("Command still asks: five orders",     oneRealChoice(command).one === false, oneRealChoice(command).why);
  check("Prismatic Wall still asks: wall or globe", oneRealChoice(prismatic).one === false, oneRealChoice(prismatic).why);
  check("Plane Shift still asks: attack or save",  oneRealChoice(planeShift).one === false, oneRealChoice(planeShift).why);
}

console.log("\nTHE EDGES");
{
  check("one row is no dialog at all", oneRealChoice([act("save", "")]).one === false, "nothing to suppress");
  check("a blank row beside one called \"Save\" is still one thing",
    oneRealChoice([act("save", ""), act("save", "Save")]).one === true, "the name says only the type");
  check("a blank row beside one called \"Cast\" is still one thing",
    oneRealChoice([act("utility", ""), act("utility", "Cast")]).one === true, "\"Cast\" is dnd5e's word for pressing it");
  check("two rows both called \"Save\" are still one thing",
    oneRealChoice([act("save", "Save"), act("save", "Save")]).one === true, "identical labels");
  check("but a blank row beside TWO named ones is a choice",
    oneRealChoice([act("save", ""), act("save", "Create Wall"), act("save", "Create Ring")]).one === false,
    "two things are named");
  check("nothing at all does not throw", oneRealChoice(null).one === false, "no rows");
}

/* ── AND NOW HIS WHOLE WORLD ────────────────────────────────────────────── */
const ROOT = "D:/FoundryVTT";
const LEVELDB = `${ROOT}/Foundry Virtual Tabletop/resources/app/node_modules/classic-level/index.js`;
if (!existsSync(LEVELDB)) {
  console.log("\n(no copy of his world on this machine; the measurement was skipped)");
} else {
  const { ClassicLevel } = await import(pathToFileURL(LEVELDB).href);
  const scratch = mkdtempSync(join(tmpdir(), "ace-choice-"));
  let n = 0;
  const rows = async (path) => {
    if (!existsSync(join(path, "CURRENT"))) return [];
    const dst = join(scratch, `p${++n}`);
    try { cpSync(path, dst, { recursive: true, filter: (s) => basename(s) !== "LOCK" }); }
    catch (_) { return []; }
    try {
      const db = new ClassicLevel(dst, { valueEncoding: "json" });
      await db.open();
      const out = [];
      for await (const kv of db.iterator()) out.push(kv);
      await db.close();
      return out;
    } catch (_) { return []; }
  };

  // ⚠️ MACHINERY IS NOT A CHOICE, and the chooser drops it before it ever asks.
  // The measurement has to drop it too or it counts dialogs that never appear.
  const MACHINERY = new Set(["special", "turnStart", "turnEnd", "encounter", "shortRest", "longRest"]);
  const choosable = (item) => Object.values(item?.system?.activities ?? {})
    .filter(a => !MACHINERY.has(String(a?.activation?.type ?? "")));

  const quiet = [], asked = new Map();
  const consider = (where, item) => {
    if (item?.type !== "spell" && item?.type !== "feat" && item?.type !== "weapon"
      && item?.type !== "consumable" && item?.type !== "equipment") return;
    const rows2 = choosable(item);
    if (rows2.length < 2) return;
    const verdict = oneRealChoice(rows2);
    if (verdict.one) {
      const chosen = pickTheRealOne(rows2);
      quiet.push(`${item.name} (${where}) -> ${chosen?.name || chosen?.type}`);
    } else {
      asked.set(item.name, verdict.why);
    }
  };

  for (const [k, v] of await rows(`${ROOT}/Data/worlds/hijinx/data/actors`)) {
    if (k.startsWith("!actors.items!")) consider("a sheet", v);
  }
  for (const [k, v] of await rows(`${ROOT}/Data/worlds/hijinx/data/scenes`)) {
    const walk = (node) => {
      if (!node || typeof node !== "object") return;
      if (Array.isArray(node)) { for (const x of node) walk(x); return; }
      if (node.name && node.system?.activities) consider("a token", node);
      for (const val of Object.values(node)) walk(val);
    };
    walk(v);
  }
  const packDirs = [[`${ROOT}/Data/systems/dnd5e`, "system.json"]];
  for (const m of readdirSync(`${ROOT}/Data/modules`)) packDirs.push([`${ROOT}/Data/modules/${m}`, "module.json"]);
  for (const [dir, manifest] of packDirs) {
    let man = null;
    try { man = JSON.parse(readFileSync(join(dir, manifest), "utf8")); } catch (_) { continue; }
    for (const p of man.packs ?? []) {
      if (p.type !== "Item") continue;
      for (const [k, v] of await rows(join(dir, String(p.path ?? "").replace(/^\.\//, "")))) {
        consider(`${man.id}/${p.name}`, v);
      }
    }
  }

  console.log(`\nMEASURED AGAINST HIS WORLD AND EVERY BOOK ON THE SHELF`);
  console.log(`  presses that would stop asking: ${quiet.length}`);
  for (const q of [...new Set(quiet)].slice(0, 25)) console.log(`      ${q}`);
  if (new Set(quiet).size > 25) console.log(`      (and ${new Set(quiet).size - 25} more)`);
  console.log(`  presses that still ask: ${asked.size}`);

  for (const name of ["Wall of Fire", "Command", "Prismatic Wall", "Plane Shift"]) {
    const still = [...asked.keys()].some(k => k.toLowerCase().startsWith(name.toLowerCase()));
    check(`${name} still asks, measured in his own data`, still,
      still ? asked.get([...asked.keys()].find(k => k.toLowerCase().startsWith(name.toLowerCase()))) ?? "asks"
        : "it is NOT in the asking list any more - the rule has been widened too far");
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
