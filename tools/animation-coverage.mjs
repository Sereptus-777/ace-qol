// How many of the spells ACE resolves with a PICKER have a curated animation?
const { readAutorec } = await import("./aarec.mjs");
const { pathToFileURL } = await import("node:url");
const { readFileSync } = await import("node:fs");
const { ClassicLevel } = await import(pathToFileURL("D:/FoundryVTT/Foundry Virtual Tabletop/resources/app/node_modules/classic-level/index.js").href);

const norm = s => String(s ?? "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
const cats = await readAutorec(process.argv[2]);
const ORDER = ["ontoken", "range", "melee", "templatefx", "aefx", "preset"];
const index = new Map();
for (const cat of ORDER) for (const r of (cats[cat] ?? [])) {
  const k = norm(r?.label); if (k && !index.has(k)) index.set(k, { r, cat });
}

const reg = JSON.parse(readFileSync(process.argv[4], "utf8"));
const TEMPLATE_SHAPES = new Set(["template-save", "template-trigger"]);
const picker = Object.entries(reg).filter(([, v]) => !TEMPLATE_SHAPES.has(v[1]));

let has = 0, direct = 0, menu = 0;
const missing = [];
for (const [name] of picker) {
  const hit = index.get(norm(name));
  if (!hit) { missing.push(name); continue; }
  has++;
  if (hit.r.primary?.video?.customPath) direct++; else menu++;
}
console.log("ACE entries resolved by a PICKER (no template created): " + picker.length);
console.log("   have a human-curated animation : " + has);
console.log("      with a direct JB2A path     : " + direct);
console.log("      built from AA's menus       : " + menu);
console.log("   nobody curated                 : " + missing.length);
console.log("");
const cs = index.get("color spray");
console.log("COLOR SPRAY: " + (cs
  ? `found in ${cs.cat}, path = ` + (cs.r.primary.video.customPath
      || "autoanimations." + [cs.r.primary.video.dbSection, cs.r.primary.video.menuType,
          cs.r.primary.video.animation, cs.r.primary.video.variant, cs.r.primary.video.color].filter(Boolean).join("."))
      + (cs.r.primary.sound?.enable ? "\n             sound = " + cs.r.primary.sound.file : "")
  : "NOT FOUND"));
console.log("\nfirst 12 picker spells with no curated animation:");
for (const m of missing.slice(0, 12)) console.log("   " + m);
