// ─── ACE QOL — Sunken floors ──────────────────────────────────────────────────
//
// Lets a creature stand BELOW zero elevation and still be seen.
//
// ⚠️ THE BUG, confirmed live 2026-08-13. Johnny built a cellar at -30 ft, walked
// Firaxis into it, and the token became a dark silhouette — visible only because
// the PC glow ring is drawn separately. Every property said the token was fine:
// `visible: true`, `renderable: true`, `meshAlpha: 1`, texture loaded. It was
// not hidden. It was being drawn UNDERNEATH THE MAP.
//
// Foundry's primary canvas group sorts everything it draws by elevation:
//
//     PrimaryCanvasGroup.BACKGROUND_ELEVATION = 0
//     sort: ((a.elevation || 0) - (b.elevation || 0))
//
// The scene background sits at 0. A token at -30 sorts below it and renders
// behind the scenery. Nothing is broken — it does exactly what it says. But it
// makes a cellar, a ravine, a pit or a sunken shrine unusable by default, and it
// fails in the worst way: no error, no warning, a creature simply not on screen
// while every property insists it is there.
//
// ⚠️ SANCTIONED OVERRIDE, NOT A HACK. Foundry's own source says so, verbatim:
//
//     "Allow API users to override the default elevation of the background
//      layer. This is a temporary solution until more formal support for scene
//      levels is added in a future release."
//
// ⚠️ I ABANDONED THIS THEORY ONCE AND SHOULD NOT HAVE. Johnny said other tokens
// at -30 were visible, so I deleted this file unbuilt. They were visible for the
// same reason Firaxis was — a glow ring drawn outside the sorted group. The
// original reasoning was right; the counter-evidence was misread. Kept here so
// nobody unpicks it a third time.
//
// ⚠️ AND DELETING IT LEFT THREE DANGLING IMPORTS that would have stopped ace-qol
// loading entirely. Never remove a module without grepping for its references.
// ──────────────────────────────────────────────────────────────────────────────

// ⚠️ Local — importing MODULE_ID from ace-qol.mjs forms the cycle that made every
// token unclickable on 2026-08-11.
const MODULE_ID = "ace-qol";
const LOG = "ace-qol | SunkenFloors";

/**
 * How far below the map the background sits.
 *
 * ⚠️ DEEP, BUT FINITE. Foundry reserves `-Infinity` for its own deepest layer,
 * and matching it would put the background into a tie it should not be in.
 * Ten thousand feet is deeper than any dungeon anyone draws, and still sorts
 * predictably against real numbers.
 */
export const BACKGROUND_DEPTH = -10000;

export class SunkenFloors {

  /** Push the background down. Returns true if it is now deep enough. */
  static apply() {
    let ok = false;

    // 1. The class default — governs every canvas drawn from here on.
    try {
      const G = foundry?.canvas?.groups?.PrimaryCanvasGroup;
      if (G) {
        if (G.BACKGROUND_ELEVATION > BACKGROUND_DEPTH) {
          G.BACKGROUND_ELEVATION = BACKGROUND_DEPTH;
          console.log(`${LOG} | background default set to ${BACKGROUND_DEPTH} ft.`);
        }
        ok = true;
      } else {
        console.warn(`${LOG} | PrimaryCanvasGroup not found — creatures below 0 ft will render under the map.`);
      }
    } catch (err) {
      console.warn(`${LOG} | could not set the background default:`, err);
    }

    // 2. ⚠️ THE MESH ALREADY ON SCREEN. The background takes its elevation when
    // it is CREATED, so changing the class default does nothing to a scene that
    // is already drawn — the very scene Johnny is looking at. Fix the live one
    // too, then re-sort, or the change appears not to work until a scene change.
    try {
      const bg = canvas?.primary?.background;
      if (bg && bg.elevation > BACKGROUND_DEPTH) {
        bg.elevation = BACKGROUND_DEPTH;
        canvas.primary.sortDirty = true;
        canvas.primary.sortChildren?.();
        console.log(`${LOG} | live background re-sorted — anyone standing below ground is visible again.`);
      }
    } catch (err) {
      console.warn(`${LOG} | could not re-sort the live background (a scene reload will fix it):`, err);
    }

    return ok;
  }

  static register() {
    if (game?.ready) SunkenFloors.apply();
    else Hooks.once("ready", () => SunkenFloors.apply());

    // ⚠️ RE-ASSERT ON EVERY DRAW. A scene loaded before we ran, or another
    // module resetting the static, would silently put the map back on top of
    // anyone standing in a cellar.
    Hooks.on("canvasReady", () => SunkenFloors.apply());

    console.log(`${LOG} | online`);
  }
}
