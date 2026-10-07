// ─── SOOT MASK SELF-TEST ──────────────────────────────────────────────────────
//
// Pins the two masks a ragged burn gets, against the SHIPPED functions.
//
// THE ASH, his rule of 2026-10-07: "The soot alpha is the straight-line distance
// to the nearest empty pixel. One rule for a square hole and for an L. A pixel
// inside the empty region is 0, all the way to the edge of that region. The edge
// itself is 0. From there, alpha climbs to 255 over one cell and no further. One
// cell is the image width divided by 9. Check it by averaging alpha on a 9 by 9
// before you call it done." His two tables are below, read off the 9 by 9. A
// straight side reads about 127, an outside corner about 188, and a cell touched
// by empty on two sides about 84.
//
// THE FIRE keeps the four-by-four cell rule with the whole-cell ramp: "50 pixels
// across every fade cell, solid against the burned square and gone at the clear."
//
// One square is 200 pixels, his scene's grid.
//
//   node tools/soot-mask-selftest.mjs
// ──────────────────────────────────────────────────────────────────────────────

import { FirePaint } from "../scripts/fire-paint.mjs";

let passed = 0, failed = 0;
const check = (name, ok, detail = "") => {
  if (ok) { passed++; return; }
  failed++;
  console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ""}`);
};

const GS = 200;

function build(burnedList, cols, rows, mode, extra = {}) {
  const burned = new Set(burnedList.map(([c, r]) => `${c},${r}`));
  const W = cols * GS, H = rows * GS;
  const mask = FirePaint.sootMask({ burned, cols, rows, sq: GS, W, H, mode, scale: 1, ...extra });
  const at = (x, y) => mask[Math.floor(y) * W + Math.floor(x)];
  const nine = FirePaint.nineByNine(mask, W, H);
  return { mask, W, H, at, nine };
}

/** Does a 9x9 reading match his table, every cell within `tol`? */
function tableMatches(nine, want, tol = 2) {
  const bad = [];
  for (let r = 0; r < 9; r++) for (let c = 0; c < 9; c++) {
    if (Math.abs(nine[r][c] - want[r][c]) > tol) bad.push(`(${r},${c}) read ${nine[r][c]}, want ${want[r][c]}`);
  }
  return bad;
}

/* ═══ ASH: the 15-foot square, 600 ═════════════════════════════════════════ */
{
  // Nine squares, the centre one empty. The centre cell of the 9x9 is the hole.
  const ring = [];
  for (let c = 0; c < 3; c++) for (let r = 0; r < 3; r++) if (!(c === 1 && r === 1)) ring.push([c, r]);
  const { W, H, nine, at } = build(ring, 3, 3, "ash", { band: false });
  check("600: the image is 600 by 600", W === 600 && H === 600);
  const want = Array.from({ length: 9 }, () => Array(9).fill(255));
  want[3][3] = 188; want[3][4] = 127; want[3][5] = 188;
  want[4][3] = 127; want[4][4] = 0;   want[4][5] = 127;
  want[5][3] = 188; want[5][4] = 127; want[5][5] = 188;
  const bad = tableMatches(nine, want);
  check("600: the 9 by 9 reads his table (188 127 188 / 127 0 127 / 188 127 188, 255 elsewhere)",
    bad.length === 0, bad.slice(0, 6).join("; ") + "\n" + FirePaint.nineByNineText(nine));
  // The hole is a hard 0 to its edge, and the climb is a straight line.
  check("600: the centre of the hole is 0", at(300, 300) === 0);
  check("600: the hole's edge is 0", at(300, 267) === 0 && at(267, 300) === 0, `${at(300, 267)} / ${at(267, 300)}`);
  check("600: half a cell out from the side it is about half", Math.abs(at(300, 233) - 0.5) < 0.04, `${at(300, 233)}`);
  check("600: one cell out it is 255 and no further climbing", at(300, 199) === 1 && at(300, 150) === 1);
  check("600: a corner climbs on the diagonal: past one cell on the diagonal is 255, inside it is not",
    at(218, 218) === 1 && at(250, 250) < 0.5 && at(250, 250) > 0.2, `${at(218, 218)} / ${at(250, 250)}`);
  const run = []; for (let y = 266; y >= 200; y -= 2) run.push(at(300, y));
  check("600: the climb never steps down on the way out", run.every((v, i) => i === 0 || v >= run[i - 1] - 1e-6));
}

/* ═══ ASH: the 10-foot L, 400 ══════════════════════════════════════════════ */
{
  // The ash is the L; the empty square is the bottom-left, and its far
  // three-by-three block is the hole.
  const { W, H, nine, at } = build([[0, 0], [1, 0], [1, 1]], 2, 2, "ash", { band: false });
  check("400: the image is 400 by 400", W === 400 && H === 400);
  const want = Array.from({ length: 9 }, () => Array(9).fill(255));
  want[5] = [127, 127, 127, 188, 255, 255, 255, 255, 255];
  want[6] = [0, 0, 0, 128, 255, 255, 255, 255, 255];
  want[7] = [0, 0, 0, 128, 255, 255, 255, 255, 255];
  want[8] = [0, 0, 0, 128, 255, 255, 255, 255, 255];
  const bad = tableMatches(nine, want);
  check("400: the 9 by 9 reads his table (255 for five rows, then 127 127 127 188, then 0 0 0 128)",
    bad.length === 0, bad.slice(0, 6).join("; ") + "\n" + FirePaint.nineByNineText(nine));
  // A straight side: the hole's right edge is one vertical line.
  const edgeX = [];
  for (let y = 270; y < 400; y += 10) { let x = 0; while (x < 400 && at(x, y) === 0) x++; edgeX.push(x); }
  check("400: the hole's side is straight (the same x on every row)", new Set(edgeX).size === 1, edgeX.join(","));
  check("400: inside the hole is a hard 0, not 5", at(20, 380) === 0 && at(130, 270) === 0 && at(66, 333) === 0);
  // Pixel row 266 straddles the hole's true edge at 266.67: a third of it is
  // hole and the rest is the first half-pixel of climb, so it averages to one
  // count. The first row wholly inside is exactly 0.
  check("400: the row above the hole climbs: the edge is 0, half at half a cell, 255 at one cell",
    at(66, 266) <= 2 / 255 && at(66, 267) === 0 && Math.abs(at(66, 244) - 0.5) < 0.05 && at(66, 221) === 1,
    `${at(66, 266)} / ${at(66, 267)} / ${at(66, 244)} / ${at(66, 221)}`);
  check("400: the ash stays 255 wherever the climb would reach it", at(100, 100) === 1 && at(300, 300) === 1);
  // His pass criteria, in his words.
  const sides = [nine[5][0], nine[5][1], nine[5][2], nine[6][3], nine[7][3], nine[8][3]];
  check("400: no side under 126 (a side under 128 means the fade is too long; 127.5 rounds either way)",
    sides.every(v => v >= 126), sides.join(","));
  const past = [nine[4][0], nine[4][1], nine[4][2], nine[6][4], nine[7][4], nine[8][4], nine[4][4]];
  check("400: every cell past the side is 255 (under 255 means the fade ran too far)", past.every(v => v === 255), past.join(","));
  check("400: no second band of 200s anywhere", nine.flat().every(v => v === 0 || v === 255 || (v > 100 && v < 200)));
}

/* ═══ ASH: wider than three squares, the climb still reaches 255 at the ash ═ */
{
  // Found by the adversarial pass: with the cell fixed at W/9 and the band a
  // third of a square, a four-square box climbed only to 189 before the ash
  // and jumped. The cell is the smaller of the two now.
  for (const n of [4, 6]) {
    const ring = [];
    for (let c = 0; c < n; c++) for (let r = 0; r < n; r++) if (c === 0 || r === 0 || c === n - 1 || r === n - 1) ring.push([c, r]);
    const { at, W } = build(ring, n, n, "ash", { band: false });
    const y = Math.floor(W / 2);
    // Walk from the hole out to the ash along one row and record the biggest
    // one-pixel jump. The climb is 66.67 px long, so a step is at most 4 counts.
    let maxStep = 0, prev = at(300, y);
    for (let x = 299; x >= 180; x--) { const v = at(x, y); maxStep = Math.max(maxStep, Math.abs(v - prev) * 255); prev = v; }
    check(`${n}x${n} ring: no hard step where the fade meets the ash (biggest one-pixel jump under 6 counts)`,
      maxStep < 6, `biggest jump ${maxStep.toFixed(1)} counts`);
    check(`${n}x${n} ring: the last empty pixel before the ash is 255`, at(200, y) > 0.99, `${at(200, y)}`);
    check(`${n}x${n} ring: the hole is a hard 0`, at(300, y) === 0 && at(y, y) === 0);
  }
}

/* ═══ ASH: a cell touched by empty on two sides reads about 84 ═════════════ */
{
  // A 3x3 box whose empty ground is an L: the north row, the west column and
  // the far corner are ash, so the hole is an L with a sharp inside corner, and
  // the band cell nestled in that corner is touched by the hole on two sides.
  const burned = [[0, 0], [1, 0], [2, 0], [0, 1], [0, 2], [2, 2]];
  const { nine, at } = build(burned, 3, 3, "ash", { band: false });
  // Find it: a band cell with 0 on two adjacent sides (any orientation).
  let corner = null;
  const zero = (r, c) => r >= 0 && r < 9 && c >= 0 && c < 9 && nine[r][c] === 0;
  for (let r = 0; r < 9 && !corner; r++) for (let c = 0; c < 9 && !corner; c++) {
    const v = nine[r][c];
    if (!(v > 0 && v < 255)) continue;
    const pairs = [[[-1, 0], [0, -1]], [[-1, 0], [0, 1]], [[1, 0], [0, -1]], [[1, 0], [0, 1]]];
    if (pairs.some(([a, bb]) => zero(r + a[0], c + a[1]) && zero(r + bb[0], c + bb[1]))) corner = [r, c];
  }
  check("inside corner: there is a cell touched by empty on two sides", !!corner,
    FirePaint.nineByNineText(nine));
  if (corner) {
    const v = nine[corner[0]][corner[1]];
    check("inside corner: it reads about 84, and that 84 is correct", Math.abs(v - 84) <= 6,
      `${v} at (${corner[0]},${corner[1]})
` + FirePaint.nineByNineText(nine));
  }
  check("inside corner: the hole is a hard 0 with a sharp corner (the cell diagonal to it is 0 too)",
    corner ? at(300, 300) === 0 : false);
}

/* ═══ ASH: the 220 band ════════════════════════════════════════════════════
   His rule, 2026-10-07: "Any pixel that is already under 255 stays exactly as
   it is... A pixel that is 255 becomes 220 when either of these is true: 1. It
   is inside one cell of a pixel that is not 255... Count the diagonal... Use a
   square step, not a circle, so the whole cell reads 220 and not a mix. 2. It
   sits in the outside cell of the image... A 255 that only touches other 255s,
   and is not on that outside cell, stays 255." His two tables are below; the
   fade cells in them are whatever the fade is, and must not move. */
{
  // The top-right L: the hole is the top-right block.
  const bare = build([[0, 0], [0, 1], [1, 1]], 2, 2, "ash", { band: false });
  const { mask, nine, at } = build([[0, 0], [0, 1], [1, 1]], 2, 2, "ash");
  const F = -1;                                   // a fade cell: stays whatever it was
  const want = [
    [220, 220, 220, 220, 220, F,   0,   0,   0],
    [220, 255, 255, 255, 220, F,   0,   0,   0],
    [220, 255, 255, 255, 220, F,   0,   0,   0],
    [220, 255, 255, 255, 220, F,   F,   F,   F],
    [220, 255, 255, 255, 220, 220, 220, 220, 220],
    [220, 255, 255, 255, 255, 255, 255, 255, 220],
    [220, 255, 255, 255, 255, 255, 255, 255, 220],
    [220, 255, 255, 255, 255, 255, 255, 255, 220],
    [220, 220, 220, 220, 220, 220, 220, 220, 220],
  ];
  const bad = [];
  for (let r = 0; r < 9; r++) for (let c = 0; c < 9; c++) {
    const w = want[r][c], v = nine[r][c];
    if (w === F) { if (!(v > 0 && v < 255)) bad.push(`(${r},${c}) read ${v}, want a fade value`); }
    else if (Math.abs(v - w) > 1) bad.push(`(${r},${c}) read ${v}, want ${w}`);
  }
  check("band L: the 9 by 9 reads his table (220 ring and edge, 255 inside, the fade and the hole as they were)",
    bad.length === 0, bad.slice(0, 8).join("; ") + "\n" + FirePaint.nineByNineText(nine));
  let moved = 0;
  for (let i = 0; i < mask.length; i++) if (bare.mask[i] < 1 && mask[i] !== bare.mask[i]) moved++;
  check("band L: every pixel under 255 stays exactly as it was", moved === 0, `${moved} fade pixels changed`);
  check("band L: a 255 that only touches 255s stays 255", at(300, 300) === 1 && at(100, 300) === 1);
  // The mask is a Float32Array, so 220/255 is compared within a float's rounding.
  const is220 = (v) => Math.abs(v - 220 / 255) < 1e-6;
  check("band L: the diagonal cell (4,4) is 220 whole, not a mix",
    is220(at(178, 178)) && is220(at(221, 221)) && is220(at(200, 200)),
    `${at(178, 178)} / ${at(221, 221)} / ${at(200, 200)}`);
  check("band L: the outer cell is 220 on every side", is220(at(2, 200)) && is220(at(397, 200))
    && is220(at(200, 2)) && is220(at(200, 397)));
  check("band L: no pixel is a mix of 220 and 255", mask.every(v => v < 1 - 1e-6 || v === 1 || is220(v)));
}
{
  // The 15-foot square, same rule.
  const ring = [];
  for (let c = 0; c < 3; c++) for (let r = 0; r < 3; r++) if (!(c === 1 && r === 1)) ring.push([c, r]);
  const bare = build(ring, 3, 3, "ash", { band: false });
  const { mask, nine, at } = build(ring, 3, 3, "ash");
  const F = -1;
  const want = [
    [220, 220, 220, 220, 220, 220, 220, 220, 220],
    [220, 255, 255, 255, 255, 255, 255, 255, 220],
    [220, 255, 220, 220, 220, 220, 220, 255, 220],
    [220, 255, 220, F,   F,   F,   220, 255, 220],
    [220, 255, 220, F,   0,   F,   220, 255, 220],
    [220, 255, 220, F,   F,   F,   220, 255, 220],
    [220, 255, 220, 220, 220, 220, 220, 255, 220],
    [220, 255, 255, 255, 255, 255, 255, 255, 220],
    [220, 220, 220, 220, 220, 220, 220, 220, 220],
  ];
  const bad = [];
  for (let r = 0; r < 9; r++) for (let c = 0; c < 9; c++) {
    const w = want[r][c], v = nine[r][c];
    if (w === F) { if (!(v > 0 && v < 255)) bad.push(`(${r},${c}) read ${v}, want a fade value`); }
    else if (Math.abs(v - w) > 1) bad.push(`(${r},${c}) read ${v}, want ${w}`);
  }
  check("band 600: the 9 by 9 reads his table (the ring around the hole and the outside edge 220)",
    bad.length === 0, bad.slice(0, 8).join("; ") + "\n" + FirePaint.nineByNineText(nine));
  let moved = 0;
  for (let i = 0; i < mask.length; i++) if (bare.mask[i] < 1 && mask[i] !== bare.mask[i]) moved++;
  check("band 600: the fade and the hole stay exactly as they were", moved === 0, `${moved} changed`);
  check("band 600: the 255 cells between the edge and the ring are 255", at(100, 100) === 1 && at(100, 300) === 1 && at(300, 100) === 1);
  const is220 = (v) => Math.abs(v - 220 / 255) < 1e-6;
  check("band 600: the corner of the ring is 220 whole (counts the diagonal)",
    is220(at(134, 134)) && is220(at(199, 199)) && is220(at(466, 466)),
    `${at(134, 134)} / ${at(199, 199)} / ${at(466, 466)}`);
}

/* ═══ FIRE: the four-by-four cell rule, the whole cell as the ramp ═════════ */
{
  const { at, mask } = build([[0, 0], [1, 0], [0, 1]], 2, 2, "fire");
  const cellCentre = (c, r, cr, cc) => [c * GS + cc * 50 + 25, r * GS + cr * 50 + 25];
  check("fire L: every burned pixel is 1", at(199, 299) === 1 && at(299, 199) === 1 && at(100, 100) === 1);
  check("fire L: the far corner cell (3,3) is gone", at(...cellCentre(1, 1, 3, 3)) === 0);
  check("fire L: cell (2,2) is gone; only (1,1) is turned on", at(...cellCentre(1, 1, 2, 2)) === 0);
  check("fire L: cell (1,1) is on", at(251, 251) > 0);
  check("fire L: solid against the burned square", at(300, 201) > 0.95, `${at(300, 201)}`);
  check("fire L: about half way across the cell at 25 in", Math.abs(at(300, 225) - 0.5) < 0.08, `${at(300, 225)}`);
  check("fire L: still fading at 45 in", at(300, 245) > 0.02, `${at(300, 245)}`);
  check("fire L: gone at the clear cell", at(300, 251) < 0.03, `${at(300, 251)}`);
  check("fire L: the canvas is neither blank nor solid", mask.some(v => v === 0) && mask.some(v => v === 1));
}
{
  const { at, nine } = build([[0, 0]], 2, 1, "fire");
  check("fire one side: the west edge is on at the ash", at(201, 100) > 0.9);
  check("fire one side: cell (1,1) is NOT turned on", at(275, 75) === 0);
  void nine;
}
{
  const ring = [];
  for (let c = 0; c < 3; c++) for (let r = 0; r < 3; r++) if (!(c === 1 && r === 1)) ring.push([c, r]);
  const { at } = build(ring, 3, 3, "fire");
  check("fire room: the inner four cells stay gone", at(300, 300) === 0 && at(260, 260) === 0 && at(340, 340) === 0);
  check("fire room: the ring is on at every ash edge", at(300, 201) > 0.9 && at(300, 398) > 0.9 && at(201, 300) > 0.9 && at(398, 300) > 0.9);
}
{
  const { at } = build([[0, 0], [0, 2]], 1, 3, "fire");
  check("fire north and south: both edges on, no inner cell", at(100, 201) > 0.9 && at(100, 398) > 0.9 && at(75, 275) === 0 && at(125, 325) === 0);
}
{
  const { at } = build([[0, 0], [3, 3]], 4, 4, "fire");
  check("fire: an empty square touching nothing burned is gone", at(225, 225) === 0);
}

console.log(`\nSOOT MASK: ${passed} passed, ${failed} failed.`);
if (failed) process.exit(1);
