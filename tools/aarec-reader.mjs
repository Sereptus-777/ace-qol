import { pathToFileURL } from "node:url";
const { ClassicLevel } = await import(pathToFileURL("D:/FoundryVTT/Foundry Virtual Tabletop/resources/app/node_modules/classic-level/index.js").href);
export async function readAutorec(path) {
  const db = new ClassicLevel(path, { valueEncoding: "json" });
  await db.open();
  const out = {};
  for await (const [k, v] of db.iterator()) {
    const key = String(v?.key ?? "");
    if (!key.startsWith("autoanimations.aaAutorec-")) continue;
    const cat = key.slice("autoanimations.aaAutorec-".length);
    try {
      const parsed = typeof v.value === "string" ? JSON.parse(v.value) : v.value;
      out[cat] = Array.isArray(parsed) ? parsed : Object.values(parsed ?? {});
    } catch (_) { out[cat] = []; }
  }
  await db.close();
  return out;
}
