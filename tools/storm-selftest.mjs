// ─── The Stormforger: flight arithmetic and where a space gets drawn ─────────
//
// ⚠️ EVERY CASE IN THE FLIGHT SECTION IS THE BUG JOHNNY HIT ON 2026-09-03. His
// wielder was standing at elevation -30, the staff caps the climb at 30 feet,
// he typed 45, and the token was written to 30 — thirty feet above the map's
// zero rather than thirty feet above HIM. Then Aerial Descent put him at 0,
// which is thirty feet above the floor he had been standing on.
//
// ⚠️ AND THE POLYGON CASE IS THE ONE THAT WOULD HAVE SHIPPED BROKEN. On a
// gridded scene Foundry snaps a circular template and hands back polygon points
// with no radius and no x/y at all, so a reader that checks radius first draws
// nothing on every map he owns.
//
// Run:  node tools/storm-selftest.mjs
globalThis.game = { settings: { get: () => false, register: () => {} }, user: { isGM: true, targets: new Set() },
  modules: { get: () => ({ active: true }) }, i18n: { localize: (k) => k }, time: { worldTime: 0 } };
globalThis.Hooks = { on: () => {}, once: () => {}, off: () => {}, callAll: () => {} };
globalThis.ui = { notifications: { info: () => {}, warn: () => {}, error: () => {} } };
globalThis.CONFIG = { Actor: {}, Token: {}, Item: {} };
// Enough of Foundry for the import chain to load. `ApplicationV2` has to be a
// real class: several ACE files extend it at module scope, so an undefined
// stands in the extends clause and the whole import throws before any test runs.
class _App { static DEFAULT_OPTIONS = {}; constructor() {} render() {} close() {} }
globalThis.foundry = {
  utils: { escapeHTML: (s) => String(s), getRoute: (p) => p, mergeObject: (a, b) => ({ ...a, ...b }),
           deepClone: (o) => JSON.parse(JSON.stringify(o ?? null)), randomID: () => "id" },
  applications: {
    api: { DialogV2: { wait: async () => null }, ApplicationV2: _App,
           HandlebarsApplicationMixin: (B) => class extends B {} },
    ux: {}, apps: {}, handlebars: {},
  },
};
globalThis.canvas = { grid: { size: 100, distance: 5 }, scene: { regions: [] } };

const { FlightVisuals } = await import(
  "file:///D:/FoundryVTT/Data/modules/ace-qol/scripts/flight-visuals.mjs");
const { SpaceEffects } = await import(
  "file:///D:/FoundryVTT/Data/modules/ace-qol/scripts/rules/space-effects.mjs");

let pass = 0, fail = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log((ok ? "  ok   " : "  FAIL ") + String(label).padEnd(58)
    + "got " + JSON.stringify(got) + ", want " + JSON.stringify(want));
};

console.log("\nTHE CLIMB IS RELATIVE — his exact numbers first");
check("at -30, climbing 30, ends at 0", FlightVisuals.climbTo(-30, 30), 0);
check("he typed 45 and the staff caps the CLIMB at 30",
  FlightVisuals.climbTo(-30, 45, 30), 0);
check("at 0, climbing 30, ends at 30", FlightVisuals.climbTo(0, 30), 30);
check("on a balcony at 30, climbing 30, ends at 60", FlightVisuals.climbTo(30, 30), 60);
check("Levitate's 20 caps the climb, not the altitude",
  FlightVisuals.climbTo(-30, 60, 20), -10);

console.log("\nAND A CLIMB NEVER GOES DOWN");
check("a negative climb is a climb of nothing", FlightVisuals.climbTo(-30, -50), -30);
check("no cap means no cap", FlightVisuals.climbTo(0, 400, null), 400);
check("a climb of zero leaves them where they are", FlightVisuals.climbTo(-30, 0), -30);
check("garbage in is not a silent zero", Number.isNaN(FlightVisuals.climbTo(-30, "x")), true);

console.log("\nLANDING FINDS THE FLOOR, NOT THE ORIGIN");
check("the floor beneath wins over everything",
  FlightVisuals.landingElevation([{ elevation: -30 }], 0), { ft: -30, how: "the floor beneath them" });
check("the HIGHEST floor below, not the deepest",
  FlightVisuals.landingElevation([{ elevation: -30 }, { elevation: -60 }, { elevation: -45 }], null).ft, -30);
check("no floor recorded -> where they took off from",
  FlightVisuals.landingElevation([], -30), { ft: -30, how: "where they took off from" });
check("a takeoff from zero is still an answer",
  FlightVisuals.landingElevation([], 0).ft, 0);
check("nothing known at all -> the scene floor, and it says so",
  FlightVisuals.landingElevation([], null), { ft: 0, how: "the scene floor, having nothing better to go on" });
check("a junk floor list does not become NaN",
  FlightVisuals.landingElevation([{ elevation: "deep" }], -30).ft, -30);

console.log("\nTAKE OFF AND COME BACK — the round trip he actually ran");
{
  const start = -30;
  const up = FlightVisuals.climbTo(start, 45, 30);          // he typed 45
  const down = FlightVisuals.landingElevation([], start).ft; // no ground regions on that map
  check("rises to 0 and returns to -30", [up, down], [0, -30]);
}

console.log("\nWHERE A SPACE GETS DRAWN");
// ⚠️ THE POLYGON IS THE NORMAL CASE on a gridded scene. A square traced
// clockwise from (100,100) to (500,500): centre (300,300), 400 across.
check("a grid-snapped circle arrives as polygon points",
  SpaceEffects._spaceFxGeometry({ shapes: [{ type: "polygon",
    points: [100, 100, 500, 100, 500, 500, 100, 500] }] }),
  { x: 300, y: 300, size: 400 });
check("a euclidean circle is centre + radius",
  SpaceEffects._spaceFxGeometry({ shapes: [{ type: "circle", x: 300, y: 300, radius: 200 }] }),
  { x: 300, y: 300, size: 400 });
// ⚠️ A RECTANGLE'S x/y IS ITS CORNER, a circle's is its centre. Reading them
// the same way puts a cube's picture half a cube off.
check("a rectangle is corner + size, so the centre is offset",
  SpaceEffects._spaceFxGeometry({ shapes: [{ type: "rectangle", x: 100, y: 100, width: 400, height: 400 }] }),
  { x: 300, y: 300, size: 400 });
check("a non-square rectangle is sized by its longer side",
  SpaceEffects._spaceFxGeometry({ shapes: [{ type: "rectangle", x: 0, y: 0, width: 200, height: 600 }] }),
  { x: 100, y: 300, size: 600 });
check("the drawn placeable is the LAST resort, not the first",
  SpaceEffects._spaceFxGeometry({ shapes: [], object: { bounds: { x: 0, y: 0, width: 400, height: 400 } } }),
  { x: 200, y: 200, size: 400 });
check("no shape and no sprite is null, not a guess",
  SpaceEffects._spaceFxGeometry({ shapes: [] }), null);
check("a degenerate polygon does not become a zero-size effect",
  SpaceEffects._spaceFxGeometry({ shapes: [{ points: [10, 10, 10, 10] }] }), null);

console.log("");
console.log(pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
