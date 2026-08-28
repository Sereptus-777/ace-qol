import { pathToFileURL } from "node:url";
import { readFileSync } from "node:fs";
const { ClassicLevel } = await import(pathToFileURL("D:/FoundryVTT/Foundry Virtual Tabletop/resources/app/node_modules/classic-level/index.js").href);
const { classifyItem } = await import(
  "file:///D:/FoundryVTT/Data/modules/ace-qol/scripts/inference/classify-item.mjs");

const reg = JSON.parse(readFileSync(process.argv[4], "utf8"));
const norm = s => String(s ?? "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
const curated = new Set(Object.keys(reg).map(norm));

const seen = new Map();     // normalised name -> {name, type, level, curated, result}
async function sweep(path, prefix) {
  const db = new ClassicLevel(path, { valueEncoding: "json" });
  await db.open();
  for await (const [k, it] of db.iterator(prefix ? { gte: prefix, lte: prefix + "\uffff" } : {})) {
    if (it?.type !== "spell" && it?.type !== "feat") continue;
    const n = norm(it.name);
    if (!n || seen.has(n)) continue;
    seen.set(n, { name: it.name, type: it.type, level: Number(it.system?.level ?? -1),
                  curated: curated.has(n), result: classifyItem(it) });
  }
  await db.close();
}
await sweep(process.argv[2], "!actors.items!");
await sweep(process.argv[3], null);

const rows = [...seen.values()];
const planned = rows.filter(r => r.result.shape);
const byShape = new Map(), byConf = new Map();
for (const r of planned) {
  byShape.set(r.result.shape, (byShape.get(r.result.shape) ?? 0) + 1);
  byConf.set(r.result.confidence, (byConf.get(r.result.confidence) ?? 0) + 1);
}
const newlyPlanned = planned.filter(r => !r.curated);

console.log("UNIQUE spells and features across your world: " + rows.length);
console.log("  hand-written registry entries covering them : " + rows.filter(r => r.curated).length);
console.log("  the engine can plan on its own              : " + planned.length);
console.log("  of those, NEVER curated by anyone           : " + newlyPlanned.length);
console.log("  it declines and hands to the generic engine : " + (rows.length - planned.length));
console.log("");
console.log("confidence:  " + [...byConf].map(([k, v]) => k + " " + v).join("   "));
console.log("");
console.log("shapes it worked out:");
for (const [k, v] of [...byShape].sort((a, b) => b[1] - a[1])) console.log("   " + k.padEnd(18) + v);

// Does it agree with the humans where both have an opinion?
const both = planned.filter(r => r.curated);
let agree = 0; const disagree = [];
for (const r of both) {
  const want = reg[Object.keys(reg).find(k => norm(k) === norm(r.name))]?.[1];
  if (!want || want === "?") continue;
  if (want === r.result.shape) agree++; else disagree.push([r.name, want, r.result.shape]);
}
console.log("");
console.log("AGREEMENT with the hand-written entries: " + agree + " of " + (agree + disagree.length));
if (disagree.length) {
  console.log("disagreements (curated wins in production, listed so they can be judged):");
  for (const [n, want, got] of disagree.slice(0, 25)) {
    console.log("   " + n.padEnd(30) + "human says " + want.padEnd(17) + "engine says " + got);
  }
  if (disagree.length > 25) console.log("   ... and " + (disagree.length - 25) + " more");
}
