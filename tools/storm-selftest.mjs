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
globalThis.CONFIG = { Actor: {}, Token: {}, Item: {},
  DND5E: { skills: { prc: { label: "Perception" }, ste: { label: "Stealth" } } } };
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
const { VisualOwnership } = await import(
  "file:///D:/FoundryVTT/Data/modules/ace-qol/scripts/visual-ownership.mjs");

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

console.log("\nHOW LOW MUST THE PICTURE SIT?");
// ⚠️🔴 `belowTokens()` IS A LAYER, NOT A HEIGHT. Sequencer implements it as
// sortLayer(600); Foundry V13 sorts by ELEVATION first and layer second, so a
// creature at -30 renders under an effect at 0 whatever layer it is on. Johnny
// cast Thunderstorm of Misery over a party thirty feet down and the storm sat
// on top of them.
{
  const g = 100;
  const tok = (x, y, elev) => ({ document: { id: `t${x}-${y}-${elev}`, x, y, width: 1, height: 1, elevation: elev } });
  const regionWith = (...tokens) => {
    globalThis.canvas = { grid: { size: g, distance: 5 }, tokens: { placeables: tokens },
                          scene: { regions: [] } };
    return { name: "storm", testPoint: () => true };
  };
  check("below the lowest creature it covers, with a margin",
    SpaceEffects._spaceFxElevation(regionWith(tok(0, 0, 0), tok(100, 0, -30))), -40);
  check("everyone at ground level still gets a gap",
    SpaceEffects._spaceFxElevation(regionWith(tok(0, 0, 0))), -10);
  check("a flier does not drag it upwards",
    SpaceEffects._spaceFxElevation(regionWith(tok(0, 0, 60), tok(100, 0, 0))), -10);
  // ⚠️ NOBODY INSIDE MEANS NOBODY TO BE UNDER. Returning a number there would
  // pin the storm to an elevation chosen from no evidence at all.
  check("nobody inside leaves the layer to decide",
    SpaceEffects._spaceFxElevation(regionWith()), null);
  globalThis.canvas = { grid: { size: 100, distance: 5 }, scene: { regions: [] } };
}

console.log("\nDOES THE SPACE OUTLIVE THE TEMPLATE THAT AIMED IT?");
// ⚠️ HIS EXACT CAST. The storm was created at world time 0 with a minute on
// it, and the save engine tidied the template away 26 seconds later. The region
// must still have 34 seconds left and must NOT be swept with the template.
check("34 seconds still on the clock when the template goes",
  SpaceEffects.timeLeft(60, 26), 34);
check("a concentration space has no clock, so it dies with its template",
  SpaceEffects.timeLeft(null, 26), null);
check("neither does one with no flag at all",
  SpaceEffects.timeLeft(undefined, 26), null);
// ⚠️ null AND 0 ARE DIFFERENT ANSWERS, and Number(null) is 0 — the same trap
// that capped every uncapped climb at zero an hour ago.
check("expiring exactly now is over, not a minute of life",
  SpaceEffects.timeLeft(26, 26), null);
check("already run out is over", SpaceEffects.timeLeft(10, 26), null);
check("a space created at world time 0 is not read as 'no clock'",
  SpaceEffects.timeLeft(0, -5), 5);
check("a junk expiry is treated as no clock, not as year zero",
  SpaceEffects.timeLeft("soon", 26), null);

console.log("\nWHO OWNS THE PICTURE? (Forge asks this before it invents one)");
// The Stormforger: four abilities, and only ONE of them makes a space.
const staff = { name: "Stormforger", system: { activities: { a: {}, b: {}, c: {}, d: {} } } };
const act = (name, type = "save") => ({ name, type, item: staff });
check("the storm is owned",
  VisualOwnership.owns(staff, act("Thunderstorm of Misery")).owned, true);
check("and it names what owns it",
  VisualOwnership.owns(staff, act("Thunderstorm of Misery")).by, "the storm space ACE draws on the map");
check("the takedown is owned by the tornado",
  VisualOwnership.owns(staff, act("Tornado Takedown")).by, "ACE's tornado whirlwind");
check("the ascension is owned by the flight visuals",
  VisualOwnership.owns(staff, act("Aerial Ascension", "utility")).by, "ACE's flight visuals");
check("the descent too",
  VisualOwnership.owns(staff, act("Aerial Descent", "utility")).by, "ACE's flight visuals");
// ⚠️ THE ITEM MUST NOT ANSWER FOR ALL FOUR. Asking "does this staff make a
// storm?" says yes for every ability on it, which is how pressing Tornado
// Takedown once played the storm's graphics (2026-07-29).
check("the item alone does not claim every ability it has",
  VisualOwnership.owns(staff, null).owned, false);
// A single-activity item IS its ability, so the item name is the right answer.
check("a one-ability item answers by its own name",
  VisualOwnership.owns({ name: "Fog Cloud", system: { activities: { a: {} } } }, null).owned, true);
check("something ACE has no picture for is not claimed",
  VisualOwnership.owns({ name: "Longsword", system: { activities: { a: {} } } },
    { name: "Attack", type: "attack" }).owned, false);
// ⚠️ AN ATTACK IS NEVER A TAKEOFF — a flying snake's bite must not be claimed.
check("a Flying Snake's bite is not a flight",
  VisualOwnership.owns({ name: "Flying Snake", system: { activities: { a: {} } } },
    { name: "Bite", type: "attack", item: { name: "Flying Snake" } }).owned, false);

console.log("\nTHE STORM DOES WHAT THE STAFF SAYS IT DOES");
const { SPELL_RULES, validateSpellRuleEntry } = await import(
  "file:///D:/FoundryVTT/Data/modules/ace-qol/scripts/rules/rules-data-spells.mjs");
const storm = SPELL_RULES["thunderstorm of misery"];
// ⚠️ THE ITEM SAYS "disadvantage on any perception checks". It does NOT say
// deafened, which in 5e AUTO-FAILS every check that requires hearing.
check("it does not deafen anybody", storm.space.stampInside, null);
check("it imposes disadvantage on Perception", storm.space.disadvantage, { skills: ["prc"] });
check("it still lightly obscures", storm.space.obscurement, "light");
check("and it still lasts a minute", storm.durationSeconds, 60);
check("the alias points at the same entry", SPELL_RULES["stormforger"], storm);
check("the entry is schema-clean", validateSpellRuleEntry("thunderstorm of misery", storm), []);
check("a made-up skill key is caught at boot, not at the table",
  validateSpellRuleEntry("bad", { space: { pierceBy: [], disadvantage: { skills: ["perception"] } } }).length, 1);
check("an empty skill list is a malformed entry, not a silent nothing",
  validateSpellRuleEntry("bad", { space: { pierceBy: [], disadvantage: { skills: [] } } }).length, 1);

console.log("");
console.log(pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
