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

const { aceDistanceFt, aceTokenGapFt, aceNoteTokenPosition, aceForgetTokenPosition,
        aceTokenSpace, aceSpaceDistanceFt } =
  await import("file:///D:/FoundryVTT/Data/modules/ace-qol/scripts/geometry-utils.mjs");
const { isTokenInTemplate } = await import("file:///D:/FoundryVTT/Data/modules/ace-qol/scripts/template-geometry.mjs");

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
let _nextId = 0;
const token = ({ docX, docY, drawnX, drawnY, w = 1, h = 1, id }) => ({
  x: drawnX, y: drawnY,                       // the animated position
  document: { id: id ?? `t${++_nextId}`, x: docX, y: docY, width: w, height: h, elevation: 0 },
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
// ⚠️ BUT TOUCHING IS 5 FEET UNDER EVERY RULE (Johnny, 2026-09-18): "If any edge
// or corner of their spaces touch, that is 5 feet on a square grid." This pin
// used to want 10, which put a creature corner to corner out of a 5-foot reach.
check("rectilinear: corner to corner is still 5 feet (touching)",
  aceDistanceFt(still(0, 0), still(100, 100)), 5);
check("rectilinear: one empty diagonal square between costs two squares a step",
  aceDistanceFt(still(0, 0), still(200, 200)), 20);

setRule(undefined);   // nothing set
check("an unreadable setting falls back to the PHB default",
  aceDistanceFt(still(0, 0), still(200, 200)), 10);

console.log("");
console.log("HIS SKELETON AND KOBOLD (2026-09-18): A PICTURE OFF ITS SQUARE IS STILL IN IT");
// ⚠️ Read from his world, scene "AMBER TEMPLE: LOWER", grid 200 pixels:
//   Skeleton Sword & Shield (1)  x=7400 y=9400   on its square (col 37, row 47)
//   Kobold Warrior (1)           x=7599 y=9159   1 px left of col 38, 41 px above row 46
// Johnny: "Skeleton in the square that touches the kobold's square at the
// corner. ACE says 10 feet. It is 5 feet. He can melee."
setRule(0);
globalThis.canvas.grid.size = 200;
const skeleton = still(7400, 9400);
const kobold = still(7599, 9159);
check("the skeleton and the kobold, corner to corner, are 5 feet apart",
  aceDistanceFt(skeleton, kobold), 5);
check("the same both ways round",
  aceDistanceFt(kobold, skeleton), 5);
check("the kobold stands in column 38, row 46 (Foundry's own squares)",
  JSON.stringify((({ x, y }) => [x / 200, y / 200])(aceTokenSpace(kobold))), JSON.stringify([38, 46]));
check("a 5-foot melee reach includes it", aceDistanceFt(skeleton, kobold) <= 5, true);
check("and there is no gap between their spaces",
  aceTokenGapFt(skeleton, kobold), 0);

// A picture half a square off picks the square Foundry does: the one holding
// the point half a square in from its top-left corner.
check("99 pixels off (just under half) is still the same square",
  aceDistanceFt(still(7400, 9400), still(7699, 9200)), 5);
check("101 pixels off (just over half) is the next square: 10 feet",
  aceDistanceFt(still(7400, 9400), still(7701, 9200)), 10);
check("a Large (2x2) picture off the grid still fills four whole squares",
  aceDistanceFt(still(7400, 9400), still(7630, 9020, 2, 2)), 5);
check("a Tiny (half square) creature still fills its whole square",
  aceDistanceFt(still(7400, 9400), still(7650, 9250, 0.5, 0.5)), 5);
check("two squares off the grid in both directions are still 5 feet when they touch",
  aceDistanceFt(still(7430, 9381), still(7610, 9190)), 5);

console.log("");
console.log("THE OPPORTUNITY ATTACK AND THE TEMPLATE ASK THE SAME SPACE");
// The opportunity attack measures a move by the mover's space before and after.
const koboldDoc = kobold.document;
const before = aceTokenSpace(koboldDoc, { x: 7599, y: 9159, elevation: 0 });
const after = aceTokenSpace(koboldDoc, { x: 7999, y: 8959, elevation: 0 });
const skel = aceTokenSpace(skeleton);
check("the kobold starts in the skeleton's reach (5 feet)", aceSpaceDistanceFt(before, skel), 5);
check("and stepping two squares off takes it out (15 feet)", aceSpaceDistanceFt(after, skel), 15);
check("a mover that never left a corner square is still in reach",
  aceSpaceDistanceFt(aceTokenSpace(koboldDoc, { x: 7610, y: 9170 }), skel), 5);

// A 5-foot square template touching the skeleton's square from the right catches
// the kobold's SQUARE by its corner, not the picture 41 pixels above it.
const square = { x: 7600, y: 9400, shape: {
  x: 0, y: 0, width: 200, height: 200,
  contains: (px, py) => px >= 0 && px <= 200 && py >= 0 && py <= 200,
} };
check("a template edge on the kobold's square catches it, off-grid picture and all",
  isTokenInTemplate(kobold, square, null, { ignoreElevation: true }), true);
globalThis.canvas.grid.size = 100;

console.log("");
console.log("THE UPDATE OUTRANKS THE DOCUMENT");
// ⚠️ THE CASE THE V13 FIX ABOVE DID NOT COVER, AND IT COST TWO MORE DAYS.
// Johnny's log, 2026-09-02: the aura engine read x=15604 for Virric 400ms after
// updateToken announced x=15936, with the document and the sprite AGREEING on
// the old number. Reading `document.x` cannot help when the document itself is
// the thing lagging. The hook writes down what the update said; distance reads
// that in preference.
setRule(0);
// His board is a 332px grid; this one is 100px, so the same geometry is used
// with round numbers. Firaxis at the origin, Virric two squares across and one
// down (10 feet, inside), stepping out to three squares across (15 feet).
const src    = still(0, 0);
const lagged = token({ docX: 200, docY: 100, drawnX: 200, drawnY: 100, id: "virric" });

check("without a note, a lagging document is believed (the old square)",
  aceDistanceFt(src, lagged), 10);

aceNoteTokenPosition("virric", { x: 300, y: 100 });
check("the update said he stepped out, so he is 15 feet away and OUTSIDE",
  aceDistanceFt(src, lagged), 15);
check("...and that is still true on a second read",
  aceDistanceFt(src, lagged), 15);

// The note must die the moment the document catches up, or it becomes a
// permanent lie about a token that has since moved somewhere else entirely.
const caughtUp = token({ docX: 300, docY: 100, drawnX: 300, drawnY: 100, id: "virric" });
check("once the document agrees, the note is consumed",
  aceDistanceFt(src, caughtUp), 15);
const movedBack = token({ docX: 200, docY: 100, drawnX: 200, drawnY: 100, id: "virric" });
check("a later move is measured from the document, not the dead note",
  aceDistanceFt(src, movedBack), 10);

// A note about one token must never be applied to another.
aceNoteTokenPosition("virric", { x: 900, y: 100 });
const other = token({ docX: 200, docY: 100, drawnX: 200, drawnY: 100, id: "chudd" });
check("a note is keyed to its own token and leaks to nobody",
  aceDistanceFt(src, other), 10);
aceForgetTokenPosition("virric");
check("a forgotten note leaves the document in charge",
  aceDistanceFt(src, lagged), 10);

console.log("");
console.log("ELEVATION COMES FROM THE UPDATE TOO");
// A creature that flies while it moves must not be measured at its old height.
// ⚠️ 3D IS EXPLICIT HERE ONLY BECAUSE THE HARNESS STUBS EVERY SETTING TO false.
// Live it is on unless the table turns `raw3dDistance` off.
check("on the ground he is 10 feet away",
  aceDistanceFt(src, lagged, { threeD: true }), 10);
aceNoteTokenPosition("virric", { x: 200, y: 100, elevation: 30 });
check("thirty feet straight up is thirty feet away, not ten",
  aceDistanceFt(src, lagged, { threeD: true }), 30);
check("and an elevation-only note is NOT mistaken for the document catching up",
  aceDistanceFt(src, lagged, { threeD: true }), 30);
aceForgetTokenPosition("virric");

console.log("");
console.log(pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
