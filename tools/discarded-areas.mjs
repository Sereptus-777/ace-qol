// Which ACE entries throw away geometry the spell actually has?
import { pathToFileURL } from "node:url";
import { readFileSync } from "node:fs";
const { ClassicLevel } = await import(pathToFileURL("D:/FoundryVTT/Foundry Virtual Tabletop/resources/app/node_modules/classic-level/index.js").href);
const norm = s => String(s ?? "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
const reg = JSON.parse(readFileSync(process.argv[3], "utf8"));
// ⚠️ KEEP THIS IN STEP WITH spell-animator.mjs AND
// geometry-contradiction-check.mjs. A checker with a stale list of what
// counts as "draws an area" reports a fixed spell as still broken, which is
// how a green tool starts arguing for undoing live code.
const TEMPLATE_SHAPES = new Set(["template-save", "template-trigger", "template-pool"]);

const seen = new Map();
const db = new ClassicLevel(process.argv[2], { valueEncoding: "json" });
await db.open();
for await (const [k, it] of db.iterator({ gte: "!actors.items!", lte: "!actors.items!\uffff" })) {
  if (it?.type !== "spell" && it?.type !== "feat") continue;
  const n = norm(it.name);
  if (seen.has(n)) continue;
  const t = it.system?.target?.template ?? {};
  seen.set(n, { name: it.name, tmpl: t.type || null, size: t.size || null });
}
await db.close();

const lost = [];
for (const [name, v] of Object.entries(reg)) {
  const shape = v[1];
  const item = seen.get(norm(name));
  if (!item?.tmpl) continue;                 // the spell has no geometry to lose
  if (TEMPLATE_SHAPES.has(shape)) continue;  // ACE places it, fine
  lost.push({ name: item.name, shape, tmpl: item.tmpl, size: item.size });
}
console.log("ACE entries whose spell DECLARES an area that ACE never draws: " + lost.length);
console.log("");
console.log("SPELL".padEnd(28) + "ITS REAL AREA".padEnd(18) + "WHAT ACE DOES INSTEAD");
console.log("-".repeat(74));
for (const r of lost.sort((a,b) => a.name.localeCompare(b.name))) {
  console.log(r.name.padEnd(28) + `${r.tmpl} ${r.size} feet`.padEnd(18) + r.shape);
}
