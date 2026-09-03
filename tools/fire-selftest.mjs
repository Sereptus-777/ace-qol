// ─── Does fire burn for the right length, and spread the right distance? ─────
//
// ⚠️ THE FUEL MODEL IS THE ONLY GENUINELY NEW THING IN THE FIRE ENGINE, so it
// is the thing that gets tested. Everything else is a call into machinery that
// already has its own tests: the clock, the overtime engine, regions.
//
// Run:  node tools/fire-selftest.mjs
globalThis.canvas = { grid: { size: 100 }, ready: false, tokens: { placeables: [], controlled: [] },
  scene: { grid: { distance: 5, size: 100 }, name: "test", id: "s1", tokens: [], regions: [] } };
globalThis.game = { ready: false, combat: null, time: { worldTime: 0 },
  settings: { get: () => false, register: () => {} },
  user: { isGM: true }, users: { activeGM: null }, actors: [], i18n: { localize: (k) => k },
  modules: { get: () => null } };
globalThis.Hooks = { on: () => {}, once: () => {}, off: () => {}, callAll: () => {}, call: () => true };
globalThis.CONFIG = { DND5E: {}, statusEffects: [], Canvas: { polygonBackends: {} }, Item: {}, Token: {} };
globalThis.ui = { notifications: { info: () => {}, warn: () => {}, error: () => {} } };
class _App {}
globalThis.Actor = class {};
globalThis.foundry = {
  utils: { escapeHTML: (s) => String(s), deepClone: (o) => JSON.parse(JSON.stringify(o)),
           mergeObject: (a, b) => ({ ...a, ...b }) },
  applications: { api: { ApplicationV2: _App, HandlebarsApplicationMixin: (C) => C, DialogV2: null },
                  ux: { TextEditor: { implementation: { enrichHTML: async (h) => h } } } },
};
globalThis.ChatMessage = { create: async () => {}, getSpeaker: () => ({}) };

const { FireEngine, FUELS, IGNITION } = await import(
  "file:///D:/FoundryVTT/Data/modules/ace-qol/scripts/fire-engine.mjs");

let pass = 0, fail = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log((ok ? "  ok   " : "  FAIL ") + label.padEnd(58) + "got " + JSON.stringify(got) + ", want " + JSON.stringify(want));
};

console.log("\nTHE FUEL TABLE SAYS WHAT WAS AGREED");
check("bare stone burns about two minutes", FUELS.stone.minutes, 2);
check("dry grass burns ten", FUELS.grass.minutes, 10);
check("timber burns thirty", FUELS.timber.minutes, 30);
check("a pool of oil burns three, and hot", [FUELS.oil.minutes, FUELS.oil.damage], [3, "2d6"]);

console.log("\nWHAT CANNOT CARRY A FIRE DOES NOT SPREAD");
// ⚠️ THE CASE HE RAISED HIMSELF: "obviously, rock isn't going to burn too long".
check("bare stone spreads nowhere", FUELS.stone.spreadFtPerMin, 0);
check("a pool of oil spreads nowhere", FUELS.oil.spreadFtPerMin, 0);
check("dry grass runs fastest", FUELS.grass.spreadFtPerMin > FUELS.timber.spreadFtPerMin, true);

console.log("\nWHAT LIT IT CHANGES THE BITE, NEVER THE CLOCK");
// A Fireball does not make a corpse contain more fuel than a torch does.
check("no ignition source carries a duration", Object.values(IGNITION).every(s => s.minutes === undefined), true);
check("a spell hits harder than a torch", IGNITION.spell.damageBonus > IGNITION.torch.damageBonus, true);

console.log("\nGROWING AN AREA — measured from the ORIGINAL, never compounded");
const circle = { type: "circle", x: 500, y: 500, radius: 100 };   // 100px = 5 ft
check("a circle grown 5 feet gains one square of radius",
  FireEngine._grownShape(circle, 5).radius, 200);
check("grown 15 feet, three squares",
  FireEngine._grownShape(circle, 15).radius, 400);
// ⚠️ THE BUG THIS GUARDS. Growing the already-grown shape compounds, and a
// fire that eats the map cannot be un-eaten once it is written to the scene.
check("the original is never mutated", circle.radius, 100);
check("growing by zero is the same shape",
  FireEngine._grownShape(circle, 0).radius, 100);

const rect = { type: "rectangle", x: 0, y: 0, width: 200, height: 200 };
const grown = FireEngine._grownShape(rect, 5);
check("a rectangle grows on every side",
  [grown.x, grown.y, grown.width, grown.height], [-100, -100, 400, 400]);

console.log("\nSPREAD IS CAPPED BY WHAT THERE IS TO BURN");
const cap = (fuelId, ign) => {
  const f = FUELS[fuelId], s = IGNITION[ign];
  return f.maxSpreadFt > 0 ? f.maxSpreadFt + s.headStartFt : 0;
};
check("a grass fire lit by a torch stops at 60 feet", cap("grass", "torch"), 60);
check("a Fireball gives it a 10 foot head start", cap("grass", "spell"), 70);
check("stone never spreads however it was lit", cap("stone", "spell"), 0);

console.log("\nHOW LONG IS SAID IN ENGLISH");
const say = (secs) => FireEngine._describeRemaining({ endsAt: secs });
check("half an hour", say(1800), "it will burn for about 30 minutes");
check("an hour", say(3600), "it will burn for about 1 hour");
check("an hour and a half", say(5400), "it will burn for about 1 hour 30 minutes");
check("one minute is singular", say(60), "it will burn for about 1 minute");
// ⚠️ "0 minutes" would read as broken. It has to say something true instead.
check("almost out", say(20), "it will burn out within the minute");
check("already over", say(-100), "it will burn out within the minute");

console.log("");
console.log(pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
