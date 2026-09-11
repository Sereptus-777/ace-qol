// Stub the Foundry globals template-geometry.mjs reads, then exercise the maths.
globalThis.canvas = { grid: { size: 100 }, scene: { grid: { distance: 5 } } };
const ITEMS = new Map();
globalThis.fromUuidSync = (uuid) => ITEMS.get(uuid) ?? null;
const spell = (name, type, size) => {
  const uuid = "Item." + name;
  ITEMS.set(uuid, { name, system: { target: { template: { type, size } } } });
  return uuid;
};
const { verticalBand, isTokenInTemplate } =
  await import("file:///D:/FoundryVTT/Data/modules/ace-qol/scripts/template-geometry.mjs");

const tmpl = (uuid, distance, elevation) => ({
  id: "t" + Math.abs(distance) + elevation, flags: { dnd5e: { origin: uuid } },
  distance, elevation,
  // a generous circle so the 2D test always passes; we are testing height only
  shape: { contains: () => true }, x: 0, y: 0,
});
const token = (elevation, cells = 1) => ({ document: { x: 0, y: 0, width: cells, height: cells, elevation }, name: "test" });

let pass = 0, fail = 0;
const check = (label, got, want) => {
  const ok = got === want;
  if (ok) pass++; else fail++;
  console.log((ok ? "  ok   " : "  FAIL ") + label.padEnd(58) + "got " + got + ", want " + want);
};

const moonbeam = spell("Moonbeam", "cylinder", 5);
const fireball = spell("Fireball", "sphere", 20);
const guardians = spell("Spirit Guardians", "radius", 15);
const wallfire = spell("Wall of Fire", "wall", 60);
const mystery  = spell("Homebrew Pillar", "cylinder", 10);

console.log("\nMOONBEAM  cylinder, 40 feet high, cast at ground level");
const mb = tmpl(moonbeam, 5, 0);
console.log("  band =", JSON.stringify(verticalBand(mb)));
check("creature standing on the ground is in it", isTokenInTemplate(token(0), mb), true);
check("creature flying at 20 feet is still in it", isTokenInTemplate(token(20), mb), true);
check("creature flying at 45 feet is above it", isTokenInTemplate(token(45), mb), false);
check("dragon at 200 feet is above it", isTokenInTemplate(token(200, 3), mb), false);
check("creature at 38 feet clips the top", isTokenInTemplate(token(38), mb), true);

console.log("\nFIREBALL  20 foot sphere, detonated at 30 feet up");
const fb = tmpl(fireball, 20, 30);
console.log("  band =", JSON.stringify(verticalBand(fb)));
check("flyer level with the blast is caught", isTokenInTemplate(token(30), fb), true);
check("flyer 15 feet below is caught", isTokenInTemplate(token(15), fb), true);
check("creature on the ground is below it", isTokenInTemplate(token(0), fb), false);
check("flyer at 55 feet is above it", isTokenInTemplate(token(55), fb), false);

console.log("\nSPIRIT GUARDIANS  15 foot emanation on a caster at ground level");
const sg = tmpl(guardians, 15, 0);
check("creature on the ground is in it", isTokenInTemplate(token(0), sg), true);
check("flyer at 10 feet is in it", isTokenInTemplate(token(10), sg), true);
check("flyer at 40 feet is out of it", isTokenInTemplate(token(40), sg), false);

console.log("\nUNKNOWN HEIGHTS must never exclude anybody");
const wf = tmpl(wallfire, 60, 0);
check("wall: nobody excluded, flyer at 500 feet still in", isTokenInTemplate(token(500), wf), true);
check("wall band is null (unknown)", verticalBand(wf), null);
const hb = tmpl(mystery, 10, 0);
check("unlisted cylinder: nobody excluded", isTokenInTemplate(token(999), hb), true);
const noOrigin = { id: "z", flags: {}, distance: 20, elevation: 0, shape: { contains: () => true }, x: 0, y: 0 };
check("no origin flag at all: nobody excluded", isTokenInTemplate(token(999), noOrigin), true);

console.log("\nOPT-OUT");
check("ignoreElevation restores the old flat behaviour",
  isTokenInTemplate(token(200), mb, null, { ignoreElevation: true }), true);

/* ── HYPNOTIC PATTERN, 2026-09-10 ───────────────────────────────────────── */
console.log("\nA 30 FOOT CUBE IS 30 FEET TALL");
// ⚠️🔴 dnd5e builds a cube as a Foundry `rect` whose distance is the DIAGONAL:
// Math.hypot(size, size) at direction 45 (dnd5e.mjs, AbilityTemplate.fromActivity).
// Read as a height that made every 30 foot cube 42 feet tall, and the card said
// "the area reaches from 0 to 42 feet".
const hypnotic = spell("Hypnotic Pattern", "cube", 30);
const cube = { ...tmpl(hypnotic, Math.hypot(30, 30), 0), t: "rect", id: "cube30" };
const cb = verticalBand(cube);
check("the cube's bottom is its own elevation", cb?.bottom, 0);
check("and its top is 30 feet, not 42", cb?.top, 30);
check("a creature standing in it is in it", isTokenInTemplate(token(0), cube), true);
check("a flyer at 35 feet is above it", isTokenInTemplate(token(35), cube), false);

// ⚠️ THE ACTIVITY FIRST. The origin flag names the activity, and dnd5e 5.x
// keeps a spell's area there, not on the item.
ITEMS.set("Activity.hp", { item: { name: "Hypnotic Pattern", system: {} },
                           target: { template: { type: "cube", size: 30 } } });
const cubeAct = { ...tmpl("Activity.hp", Math.hypot(30, 30), 0), t: "rect", id: "cubeAct" };
check("the shape is read off the activity", verticalBand(cubeAct)?.top, 30);

console.log("\nTHE REPORT NAMES THE REASON THAT IS ACTUALLY TRUE");
{
  const { ElevationGate } = await import(
    "file:///D:/FoundryVTT/Data/modules/ace-qol/scripts/rules/elevation-gate.mjs");
  const mk = (name, elevation) => ({ id: name, name, actor: { id: "a-" + name },
    document: { x: 0, y: 0, width: 1, height: 1, elevation } });
  const specter = mk("Specter", 0);
  const bat = mk("Giant Bat", 40);
  const mole = mk("Burrower", -10);
  globalThis.canvas.tokens = { placeables: [specter, bat, mole] };
  const templateDoc = { object: cube };
  const edition = () => "2024";
  const why = (list, name) => list.find(o => o.token.name === name)?.why ?? null;

  // ⚠️🔴 THE CARD HE GOT. The Specter was at 0 feet inside a cube reaching
  // from 0 up, and it was called "below it". He was left out because the save
  // list came from leftover TARGETS, not from the area, and the report blamed
  // height for it. It must never call a creature inside the band below it.
  const fromTargets = ElevationGate.findOutOfReach(templateDoc, [], edition, null,
    { source: "targets" });
  check("a creature inside the band is not called below it", why(fromTargets, "Specter"),
    "not-targeted");
  check("a creature really above it is still called above", why(fromTargets, "Giant Bat"), "above");
  check("and one really below it is still called below", why(fromTargets, "Burrower"), "below");

  // ⚠️ AN AREA LIST THAT LEAVES OUT SOMEONE INSIDE IT IS ACE DISAGREEING WITH
  // ITSELF, and it is reported as exactly that rather than dressed up as height.
  const realError = console.error; let said = "";
  console.error = (...a) => { said += a.map(String).join(" "); };
  const fromArea = ElevationGate.findOutOfReach(templateDoc, [], edition, null, { source: "area" });
  console.error = realError;
  check("inside the area and at its height, yet left out, is 'missed'", why(fromArea, "Specter"),
    "missed");
  check("and that is said out loud, not blamed on height", /disagreement inside ACE/.test(said), true);

  // Somebody who WAS caught is never reported.
  const kept = ElevationGate.findOutOfReach(templateDoc, [specter], edition, null, { source: "area" });
  check("a creature on the save list is never reported", why(kept, "Specter"), null);

  // The caster's own exclusion explains itself.
  const casterOut = ElevationGate.findOutOfReach(templateDoc, [], edition, specter.actor,
    { source: "targets" });
  check("the caster is never reported", why(casterOut, "Specter"), null);
}

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
