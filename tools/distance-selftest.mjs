// ─── Does distance read where the token IS, or where it was leaving? ────────
//
// ⚠️ EVERY CASE HERE IS THE BUG THAT MADE THE AURAS FEEL BROKEN FOR DAYS.
// `_rectOf` read `token.x` first. In Foundry V13 `PlaceableObject#x` is
// literally `return this._bounds.x` — the display bounds, which the movement
// animation drives frame by frame. The document is set immediately.
//
// The aura engine recomputes 80ms after a move. A token crossing one 332-pixel
// square animates for far longer than that, so every recompute measured the
// square the token was leaving. Johnny: "If I move another token in, it doesn't
// draw it right away until I move another token." It was checking every move.
// It was measuring the previous one.
//
// Run:  node tools/distance-selftest.mjs
// geometry-utils imports settings.mjs, whose chain registers Foundry hooks at
// load. Stub the platform rather than pretend this module is a leaf.
globalThis.canvas = { grid: { size: 100 }, ready: false,
  scene: { grid: { distance: 5, size: 100 }, name: "test", id: "s1" },
  tokens: { placeables: [] } };
globalThis.game = { ready: false, combat: null, time: { worldTime: 0 },
  settings: { get: () => false, register: () => {} },
  user: { isGM: true }, users: [], actors: [], i18n: { localize: (k) => k } };
globalThis.Hooks = { on: () => {}, once: () => {}, off: () => {}, callAll: () => {} };
globalThis.CONFIG = { DND5E: {}, statusEffects: [], Canvas: { polygonBackends: {} } };
globalThis.ui = { notifications: { info: () => {}, warn: () => {}, error: () => {} } };
class _App {}
globalThis.foundry = {
  utils: { escapeHTML: (s) => String(s), deepClone: (o) => o, mergeObject: (a, b) => ({ ...a, ...b }) },
  applications: { api: { ApplicationV2: _App, HandlebarsApplicationMixin: (C) => C },
                  ux: { TextEditor: { implementation: { enrichHTML: async (h) => h } } } },
};
globalThis.ChatMessage = { create: async () => {}, getSpeaker: () => ({}) };

const { aceDistanceFt, aceTokenGapFt } = await import(
  "file:///D:/FoundryVTT/Data/modules/ace-qol/scripts/geometry-utils.mjs");

let pass = 0, fail = 0;
const check = (label, got, want) => {
  const ok = got === want;
  ok ? pass++ : fail++;
  console.log((ok ? "  ok   " : "  FAIL ") + label.padEnd(62) + "got " + got + ", want " + want);
};

/**
 * A token placeable the way Foundry actually presents one mid-move: the
 * document already at the destination, the display bounds still lagging.
 */
const token = ({ docX, docY, drawnX, drawnY, w = 1, h = 1 }) => ({
  x: drawnX, y: drawnY,                       // the animated position
  document: { x: docX, y: docY, width: w, height: h, elevation: 0 },
});

const still = (x, y, w = 1, h = 1) => token({ docX: x, docY: y, drawnX: x, drawnY: y, w, h });

console.log("\nSTATIONARY TOKENS — the baseline, and it always worked");
check("adjacent creatures are 5 feet apart",
  aceDistanceFt(still(0, 0), still(100, 0)), 5);
check("one empty square between them is 10 feet",
  aceDistanceFt(still(0, 0), still(200, 0)), 10);
check("diagonally adjacent is 5 feet",
  aceDistanceFt(still(0, 0), still(100, 100)), 5);
check("four squares away is 25 feet",
  aceDistanceFt(still(0, 0), still(500, 0)), 25);

console.log("\nMID-MOVE — the document has arrived, the sprite has not");
// Somebody steps from 4 squares out to 1 square out. The animation has barely
// started, so the drawn position is still way out at the old spot.
const arriving = token({ docX: 200, docY: 0, drawnX: 500, drawnY: 0 });
check("measures the square it MOVED TO, not the one it left",
  aceDistanceFt(still(0, 0), arriving), 10);

// And the reverse: stepping out of range while the sprite is still inside.
const leaving = token({ docX: 500, docY: 0, drawnX: 100, drawnY: 0 });
check("a creature stepping OUT is already out",
  aceDistanceFt(still(0, 0), leaving), 25);

console.log("\nTHE CASE THAT BROKE THE AURAS");
// A 10-foot aura. The token has arrived one square away, which is 10 feet and
// inside. Reading the sprite would put it at 25 feet and outside.
const inside = token({ docX: 200, docY: 0, drawnX: 500, drawnY: 0 });
check("a creature that just stepped into a 10 foot aura is inside it",
  aceDistanceFt(still(0, 0), inside) <= 10, true);

console.log("\nBOTH TOKENS MOVING AT ONCE");
const a = token({ docX: 0, docY: 0, drawnX: 900, drawnY: 900 });
const b = token({ docX: 100, docY: 0, drawnX: 1500, drawnY: 900 });
check("two creatures mid-move are measured where they landed",
  aceDistanceFt(a, b), 5);

console.log("\nLARGE CREATURES STILL MEASURE FROM THEIR EDGES");
check("a 2x2 creature touching a medium one is 5 feet",
  aceDistanceFt(still(0, 0, 2, 2), still(200, 0)), 5);

console.log("\nTHE GAP ITSELF");
check("adjacent creatures have no gap between them",
  aceTokenGapFt(still(0, 0), still(100, 0)), 0);
check("one square between them is a 5 foot gap",
  aceTokenGapFt(still(0, 0), still(200, 0)), 5);

console.log("");
console.log("THE TABLE'S DIAGONAL RULE IS READ, NOT ASSUMED");
// ⚠️ Johnny's own board, 2026-09-01: one diagonal square between Firaxis and
// Chudd. Under the PHB rule that is 10 feet. Under the DMG's optional rule the
// second diagonal costs 10, so it is 15 — which is what his ruler said while
// ACE said 10. Neither was broken; they were following different rules, and
// ACE was not reading the setting at all.
const setRule = (v) => {
  globalThis.game.settings.get = (ns, key) =>
    (ns === "core" && key === "gridDiagonals") ? v : false;
};

setRule(0);   // EQUIDISTANT — every diagonal 5 feet
check("equidistant: two diagonal steps is 10 feet",
  aceDistanceFt(still(0, 0), still(200, 200)), 10);
check("equidistant: four diagonal steps is 20 feet",
  aceDistanceFt(still(0, 0), still(400, 400)), 20);

setRule(4);   // ALTERNATING_1 — 5, 10, 5, 10
check("alternating: two diagonal steps is 15 feet",
  aceDistanceFt(still(0, 0), still(200, 200)), 15);
check("alternating: four diagonal steps is 30 feet",
  aceDistanceFt(still(0, 0), still(400, 400)), 30);
check("alternating: a STRAIGHT line is unaffected",
  aceDistanceFt(still(0, 0), still(400, 0)), 20);
check("alternating: one diagonal is still 5 feet",
  aceDistanceFt(still(0, 0), still(100, 100)), 5);

setRule(3);   // RECTILINEAR — a diagonal costs two squares
check("rectilinear: one diagonal step costs two squares",
  aceDistanceFt(still(0, 0), still(100, 100)), 10);

setRule(undefined);   // nothing set
check("an unreadable setting falls back to the PHB default",
  aceDistanceFt(still(0, 0), still(200, 200)), 10);

console.log("");
console.log(pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
