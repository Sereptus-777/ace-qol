import { pathToFileURL } from "node:url";
const { ClassicLevel } = await import(pathToFileURL("D:/FoundryVTT/Foundry Virtual Tabletop/resources/app/node_modules/classic-level/index.js").href);
const { evaluateCondition } = await import(
  "file:///D:/FoundryVTT/Data/modules/ace-qol/scripts/profiles/condition-evaluator.mjs");

const HINTS = [/\bagainst\b/i, /\bwhile\b/i, /\bwhen\b/i, /\bif\b/i, /\bunless\b/i,
               /\bonly\b/i, /\bversus\b/i, /\bvs\.?\b/i, /\bduring\b/i, /\bon a\b/i];
const strip = h => String(h ?? "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();

let total = 0, withChanges = 0, conditional = 0, settled = 0, unknown = 0, unconditional = 0;
const byRule = new Map(), unsettled = new Map();

// A target that exists, so rules can return true/false instead of "not recorded".
const ctx = { target: { creatureType: "undead", size: "med", hp: { value: 10, max: 30 },
                        hasCondition: () => false },
              attacker: { hasCondition: () => false, hp: { value: 20, max: 20 } },
              attack: { attackKind: "mwak", damageTypes: ["slashing"] },
              environment: { lightAtTarget: "bright", terrainAtTarget: { kinds: [] } } };

for (const path of [process.argv[2], process.argv[3]]) {
  const db = new ClassicLevel(path, { valueEncoding: "json" });
  await db.open();
  // ⚠️ EFFECTS LIVE UNDER THEIR OWN KEYS in this store, not embedded in the
  // parent's `.effects` array. Reading the parent returned 0 of 4,430 - a
  // checker confidently reporting nothing, which is worse than no checker.
  for await (const [k, e] of db.iterator()) {
    if (!k.includes(".effects!")) continue;
    {
      total++;
      const changes = Array.isArray(e.changes) ? e.changes : [];
      if (!changes.length) continue;
      withChanges++;
      const hay = `${e.name ?? ""} ${strip(e.description)}`;
      if (!HINTS.some(re => re.test(hay))) continue;
      conditional++;
      const r = evaluateCondition(hay.slice(0, 240), ctx);
      if (r.verdict === "unconditional") { unconditional++; continue; }
      if (r.verdict === "unknown") {
        unknown++;
        const key = (e.name ?? "(unnamed)").slice(0, 40);
        unsettled.set(key, (unsettled.get(key) ?? 0) + 1);
      } else {
        settled++;
        byRule.set(r.rule, (byRule.get(r.rule) ?? 0) + 1);
      }
    }
  }
  await db.close();
}
console.log("Active Effects across your world      : " + total);
console.log("  that actually change something      : " + withChanges);
console.log("  whose wording is conditional        : " + conditional);
console.log("    ACE can now settle                : " + settled);
console.log("    turned out unconditional          : " + unconditional);
console.log("    still needs a human               : " + unknown);
console.log("");
console.log("settled by which rule:");
for (const [k, v] of [...byRule].sort((a,b) => b[1]-a[1])) console.log("   " + String(k).padEnd(26) + v);
console.log("");
console.log("most common wording it cannot settle yet:");
for (const [k, v] of [...unsettled].sort((a,b) => b[1]-a[1]).slice(0, 12)) {
  console.log("   " + String(v).padStart(4) + "  " + k);
}
