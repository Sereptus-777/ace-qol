// ─── Prismatic Wall: where it stands, who it touches, what each layer costs ──
//
// Johnny, 2026-09-13: ACE rolls the wall's saves by itself when a creature comes
// within 20 feet of it or starts its turn there, and when one goes through it.
//
// This pins the three pure pieces:
//   the geometry   how far a creature is from the wall, whether a path came
//                  near it, whether a path went through it
//   the reading    the seven layers, read from the item, in both editions
//   the score      three of a kind for the indigo layer
// The engine that puts them on the table goes through its own door in the
// replay (tools/replay-selftest.mjs), on his real walls.
//
// Run:  node tools/prismatic-selftest.mjs
// ──────────────────────────────────────────────────────────────────────────────

const MOD = "file:///D:/FoundryVTT/Data/modules/ace-qol/scripts";
const { wallShapeOf, distanceToWallFt, wallCrossings, entersBand } = await import(`${MOD}/rules/wall-geometry.mjs`);
const { readPrismaticWall, isPrismaticWall, PRISMATIC_LAYERS } = await import(`${MOD}/rules/prismatic-wall.mjs`);
const { recordTallySave, describeTally } = await import(`${MOD}/rules/save-tally.mjs`);

let pass = 0, fail = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log((ok ? "  ok   " : "  FAIL ") + String(label).padEnd(66) + "got " + JSON.stringify(got) + ", want " + JSON.stringify(want));
};

// A 100-pixel, 5-foot square grid, the PHB's simple diagonals.
const GRID = { gridPx: 100, ftPerCell: 5, rule: "equidistant" };
const ALT = { ...GRID, rule: "alternating" };
// A 90-foot wall, 30 feet high, running east from the origin along y = 0.
const WALL = wallShapeOf({ t: "ray", x: 0, y: 0, distance: 90, direction: 0, elevation: 0,
  flags: { dnd5e: { dimensions: { height: 30 } } } }, GRID);
// A 15-foot-radius globe centred at (1000, 1000).
const GLOBE = wallShapeOf({ t: "circle", x: 1000, y: 1000, distance: 15, elevation: 0 }, GRID);
const sq = (x, y, bottom = 0) => ({ x, y, w: 100, h: 100, bottom, top: bottom + 5 });
const at = (x, y, extra = {}) => ({ x, y, bottom: 0, top: 5, ...extra });

console.log("\nTHE WALL, AS dnd5e DRAWS IT");
check("a ray becomes a line 90 feet long", [WALL.kind, WALL.b.x, WALL.b.y], ["line", 1800, 0]);
check("30 feet high from its base", [WALL.bottom, WALL.top], [0, 30]);
check("a circle becomes a globe of its radius", [GLOBE.kind, GLOBE.rFt], ["globe", 15]);

console.log("\nHOW FAR, COUNTED IN SQUARES");
check("a creature touching the wall", distanceToWallFt(WALL, sq(500, 0), GRID), 0);
check("one square away", distanceToWallFt(WALL, sq(500, 100), GRID), 5);
check("four squares away: 20 feet, inside the band", distanceToWallFt(WALL, sq(500, 400), GRID), 20);
check("five squares away: 25 feet, outside it", distanceToWallFt(WALL, sq(500, 500), GRID), 25);
check("past the far end, measured to the end", distanceToWallFt(WALL, sq(1900, 0), GRID), 5);
check("three diagonal squares off the end, simple rule", distanceToWallFt(WALL, sq(2100, 300), GRID), 15);
check("the same under the 5-10-5 rule", distanceToWallFt(WALL, sq(2100, 300), ALT), 20);
check("flying 40 feet up beside a 30-foot wall is 10 feet from it", distanceToWallFt(WALL, sq(500, 0, 40), GRID), 10);
check("a creature at the globe's centre is inside the band", distanceToWallFt(GLOBE, sq(950, 950), GRID) <= 20, true);
check("a creature 45 feet out from the globe's centre is not", distanceToWallFt(GLOBE, sq(1900, 950), GRID) > 20, true);

console.log("\nWENT THROUGH IT, OR DID NOT");
check("straight across", wallCrossings(WALL, [at(950, -300), at(950, 300)], GRID), 1);
check("across and back is two passes", wallCrossings(WALL, [at(950, -300), at(950, 300), at(950, -300)], GRID), 2);
check("around the end is none", wallCrossings(WALL, [at(950, -300), at(2050, -300), at(2050, 300), at(950, 300)], GRID), 0);
check("over the top of a 30-foot wall is none",
  wallCrossings(WALL, [at(950, -300, { bottom: 35, top: 40 }), at(950, 300, { bottom: 35, top: 40 })], GRID), 0);
check("a teleport to the far side is none", wallCrossings(WALL, [at(950, -300), at(950, 300, { teleport: true })], GRID), 0);
check("onto the wall and back off the same side is none",
  wallCrossings(WALL, [at(950, -300), at(950, 0), at(950, -300)], GRID), 0);
check("into the globe is one pass", wallCrossings(GLOBE, [at(1000, 400), at(1000, 1000)], GRID), 1);
check("straight through the globe is two", wallCrossings(GLOBE, [at(1000, 400), at(1000, 1600)], GRID), 2);
check("skirting the globe is none", wallCrossings(GLOBE, [at(1500, 400), at(1500, 1600)], GRID), 0);

console.log("\nCAME WITHIN 20 FEET");
const band = (path) => entersBand(WALL, path, 20, GRID, { w: 100, h: 100 });
check("walking up to four squares away arrives", band([at(950, -1150), at(950, -450)]), true);
check("stopping five squares away does not", band([at(950, -1150), at(950, -550)]), false);
check("walking along from past its start arrives on the way", band([at(-1500, -450), at(950, -450)]), true);
check("already near and staying near is not an arrival", band([at(950, -250), at(1250, -250)]), false);
check("stepping out and back in is", band([at(950, -250), at(950, -850), at(950, -250)]), true);

console.log("\nTHE LAYERS, READ FROM THE ITEM");
const TEXT_2014 = "<p>If another creature that can see the wall moves to within 20 feet of it or starts its turn there, "
  + "the creature must succeed on a Constitution saving throw or become Blinded for 1 minute.</p>"
  + ["Red|fire", "Orange|acid", "Yellow|lightning", "Green|poison", "Blue|cold"].map(s => {
    const [c, t] = s.split("|"); return `<p>${c}. The creature takes 10d6 ${t} damage on a failed save.</p>`; }).join("");
const w2014 = readPrismaticWall({ name: "Prismatic Wall", system: {
  source: { rules: "2014" }, duration: { value: "10", units: "minute" }, description: { value: TEXT_2014 },
  activities: { dnd5eactivity000: { _id: "dnd5eactivity000", type: "save",
    save: { ability: ["dex"], dc: { calculation: "spellcasting", formula: "" } },
    damage: { onSave: "half", parts: [{ number: 10, denomination: 6, bonus: "", types: [] }] } } } },
  actor: { system: { attributes: { spell: { dc: 19 } } } } });
check("2014: the caster's DC when the save leaves it to the caster", w2014.dc, 19);
check("2014: its one save is the traversal, and there is no blinding activity",
  [w2014.traversalActivityId, w2014.blindingActivityId], ["dnd5eactivity000", null]);
check("2014: seven layers, in the printed order", w2014.layers.map(l => l.key), PRISMATIC_LAYERS.map(l => l.key));
check("2014: 10d6 each, from its save", w2014.layers.filter(l => l.kind === "damage").map(l => l.formula), Array(5).fill("10d6"));
check("2014: the damage types from its own words", w2014.layers.filter(l => l.kind === "damage").map(l => `${l.type}/${l.typeFrom}`),
  ["fire/its text", "acid/its text", "lightning/its text", "poison/its text", "cold/its text"]);
check("2014: 20 feet, a minute of blindness, ten minutes standing", [w2014.bandFt, w2014.blindSeconds, w2014.durationSeconds], [20, 60, 600]);
check("2014: nothing it had to guess", w2014.problems, []);

const TABLE_2024 = "<p>If another creature that can see the wall moves within 20 feet of it or starts its turn there, the creature "
  + "must succeed on a Constitution saving throw or have the &amp;Reference[Blinded apply=false] condition for 1 minute.</p>"
  + "<table><tr><th>Order</th><th>Effects</th></tr>"
  + ["1|Red|Fire", "2|Orange|Acid", "3|Yellow|Lightning", "4|Green|Poison", "5|Blue|Cold"].map(s => {
    const [n, c, t] = s.split("|"); return `<tr><td>${n}</td><td>${c}. Failed Save: 12d6 ${t} damage. Successful Save: Half as much damage.</td></tr>`; }).join("")
  + "</table>";
const acts2024 = (dc) => ({
  Pm0Re9Gt8pJNaF1C: { _id: "Pm0Re9Gt8pJNaF1C", type: "save", name: "Blinding Save", save: { ability: new Set(["con"]), dc } },
  fxEIn0sNwZReZJhV: { _id: "fxEIn0sNwZReZJhV", type: "save", name: "Traversal Save", save: { ability: ["dex"], dc },
    damage: { onSave: "half", parts: [{ number: 12, denomination: 6, bonus: "", types: ["acid", "fire", "lightning", "poison", "cold"] }] } },
});
const varek = readPrismaticWall({ name: "Prismatic Wall", system: { source: { rules: "2024" },
  duration: { value: "10", units: "minute" }, description: { value: TABLE_2024 },
  activities: acts2024({ calculation: "", formula: "", value: 22 }) } });
check("2024 (Varek's copy): DC 22 from its own saves", varek.dc, 22);
check("2024: the blinding save and the traversal save found",
  [varek.blindingActivityId, varek.traversalActivityId], ["Pm0Re9Gt8pJNaF1C", "fxEIn0sNwZReZJhV"]);
check("2024: 12d6 each, typed from the table in its text",
  varek.layers.filter(l => l.kind === "damage").map(l => `${l.formula} ${l.type}`),
  ["12d6 fire", "12d6 acid", "12d6 lightning", "12d6 poison", "12d6 cold"]);
check("2024: indigo restrains and keeps score, violet blinds until the caster's turn",
  varek.layers.slice(5).map(l => `${l.kind}/${l.saveAbility}`), ["restrained/con", "blinded/wis"]);
check("2024: the &amp;Reference does not hide the minute of blindness", varek.blindSeconds, 60);
check("2024: nothing it had to guess", varek.problems, []);

const lich = readPrismaticWall({ name: "Prismatic Wall", system: { source: { rules: "2024" },
  duration: { value: "10", units: "minute" },
  description: { value: TABLE_2024.split("<table>")[0] + "<p>@Embed[Compendium.dnd5e.tables24.RollTable.phbPrismaticLaye]</p>" },
  activities: acts2024({ calculation: "spellcasting", formula: "" }) },
  actor: { system: { attributes: { spell: { dc: 20 } } } } });
check("2024 with the table only embedded (the Lich's copy): the printed order stands",
  lich.layers.filter(l => l.kind === "damage").map(l => `${l.type}/${l.typeFrom}`),
  ["fire/the printed table", "acid/the printed table", "lightning/the printed table", "poison/the printed table", "cold/the printed table"]);
check("and the dice still come from its save", lich.layers[0].formula, "12d6");
check("and the DC from its caster", lich.dc, 20);

const odd = readPrismaticWall({ name: "Prismatic Wall", system: { description: { value:
  TABLE_2024.replace("12d6 Fire", "12d6 Thunder") }, activities: acts2024({ value: 22 }) } });
check("a layer its words retype is read as written", odd.layers[0].type, "thunder");
check("and the mismatch with its save is said, not hidden", odd.problems.some(p => /red layer deals thunder/.test(p)), true);

check("his 2014 copies carry (Legacy) and are still the wall", isPrismaticWall({ name: "Prismatic Wall (Legacy)" }), true);
check("the system's identifier is enough on its own", isPrismaticWall({ name: "Mur prismatique", system: { identifier: "prismatic-wall" } }), true);
check("Prismatic Spray is not the wall", isPrismaticWall({ name: "Prismatic Spray" }), false);

console.log("\nTHREE OF A KIND");
const run = (seq) => seq.reduce((acc, p) => acc.outcome === "continues" ? recordTallySave(acc.tally, p) : acc,
  { tally: { need: 3, successes: 0, failures: 0 }, outcome: "continues" });
check("three successes end it", run([true, true, true]).outcome, "ends");
check("three failures turn it to stone", run([false, false, false]).outcome, "escalates");
check("they need not be in a row: S F S F S", run([true, false, true, false, true]).outcome, "ends");
check("F S F S F", run([false, true, false, true, false]).outcome, "escalates");
check("two of each is still going", run([true, false, true, false]).outcome, "continues");
check("the score, in words", describeTally({ successes: 1, failures: 2 }), "1 success and 2 failures so far");

console.log("");
console.log(pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
