// ═══════════════════════════════════════════════════════════════════════════
//  TRAP GEOMETRY SELF-TEST — the footprint is the footprint
// ───────────────────────────────────────────────────────────────────────────
//  2026-09-25. A Foundry rect template is defined by a corner, an angle and a
//  DIAGONAL. Three places in Forge read that diagonal as if it were the side:
//  the trigger, the red outline, and the centre the padlock hangs from.
//
//  The damage: a 2×2 pit trap triggered across 14 feet instead of 10, so Jexxi
//  set it off standing on the rim outside the picture; the outline was drawn
//  41% too big and sat outside the trap it was outlining; and the padlock hung
//  off the top-left corner because there was no rect case in the centre helper
//  at all, so it returned the origin.
//
//  ⚠️ THE REAL FUNCTIONS, out of the module.
// ═══════════════════════════════════════════════════════════════════════════

import { readFileSync } from "node:fs";

const SRC = "D:/FoundryVTT/Data/modules/ace-artificer/scripts/template-geometry.mjs";
const code = readFileSync(SRC, "utf8").replace(/^export /gm, "");
const { rectExtent, templateCenter, templateContains } =
    new Function(code + "\nreturn { rectExtent, templateCenter, templateContains };")();

let passed = 0, failed = 0;
const check = (what, ok, detail = "") => {
    if (ok) { passed++; console.log(`  ok   ${what}`); }
    else { failed++; console.log(`  FAIL ${what}${detail ? `  ${detail}` : ""}`); }
};

console.log("\nTRAP GEOMETRY: THE FOOTPRINT IS THE FOOTPRINT");

// His scene: 140px squares, 5 ft each.
const GRID = 140, FT = 5, pxPerFt = GRID / FT;

// A 2×2 trap as Forge now places it: corner at (0,0), 45°, diagonal 10√2 ft.
const trap2x2 = { t: "rect", x: 0, y: 0, direction: 45, distance: 2 * FT * Math.SQRT2 };

{
    const r = rectExtent(trap2x2, pxPerFt);
    check("a 2×2 trap is two squares across, not two-point-eight",
        Math.abs(r.w - 2 * GRID) < 1 && Math.abs(r.h - 2 * GRID) < 1,
        `got ${(r.w / GRID).toFixed(2)}×${(r.h / GRID).toFixed(2)} squares`);
}

{
    const c = templateCenter(trap2x2, pxPerFt);
    check("and its centre is its middle, where the padlock hangs, not its corner",
        Math.abs(c.x - GRID) < 1 && Math.abs(c.y - GRID) < 1,
        `got (${Math.round(c.x)}, ${Math.round(c.y)}), expected (${GRID}, ${GRID})`);
}

// ── The rim, which is the one that went off under him ────────────────────
{
    const inside = templateContains(trap2x2, GRID, GRID, pxPerFt, FT);          // dead centre
    const corner = templateContains(trap2x2, 2 * GRID - 1, 2 * GRID - 1, pxPerFt, FT); // just inside the far corner
    const rim    = templateContains(trap2x2, 2 * GRID + 10, GRID, pxPerFt, FT); // a step outside the right edge
    const below  = templateContains(trap2x2, GRID, 2 * GRID + 10, pxPerFt, FT); // a step below it
    const old    = 2 * FT * Math.SQRT2 * pxPerFt;                               // what the old maths covered

    check("standing in it sets it off", inside);
    check("standing in its far corner sets it off", corner);
    check("standing a step outside its edge does NOT set it off",
        !rim && !below, "this is the one that fired on him");
    check("and the area the old maths covered really was 41% too big",
        Math.abs(old / (2 * GRID) - Math.SQRT2) < 0.01,
        `old side ${(old / GRID).toFixed(2)} squares vs the real 2`);
}

// ── The shapes that are not squares still behave ─────────────────────────
{
    const circle = { t: "circle", x: 0, y: 0, distance: 10 };   // 10 ft radius
    check("a circle still measures from its own centre",
        templateContains(circle, 0, 0, pxPerFt, FT)
          && templateContains(circle, 10 * pxPerFt - 1, 0, pxPerFt, FT)
          && !templateContains(circle, 10 * pxPerFt + 5, 0, pxPerFt, FT));

    const ray = { t: "ray", x: 0, y: 0, direction: 0, distance: 20, width: 5 };
    check("a ray is still a strip along its own direction",
        templateContains(ray, 10 * pxPerFt, 0, pxPerFt, FT)
          && !templateContains(ray, 25 * pxPerFt, 0, pxPerFt, FT));
}

// ── A 1×1 and a 3×3, because his sizes are squares now ───────────────────
for (const n of [1, 3]) {
    const t = { t: "rect", x: 0, y: 0, direction: 45, distance: n * FT * Math.SQRT2 };
    const r = rectExtent(t, pxPerFt);
    const c = templateCenter(t, pxPerFt);
    check(`a ${n}×${n} trap covers ${n}×${n} squares and centres on its middle`,
        Math.abs(r.w - n * GRID) < 1 && Math.abs(c.x - n * GRID / 2) < 1,
        `got ${(r.w / GRID).toFixed(2)} squares, centre x ${Math.round(c.x)}`);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
