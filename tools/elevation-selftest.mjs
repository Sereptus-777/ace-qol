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

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
