// ─── ACE: QOL — The ground falls away when you climb ────────────────────────
//
// Johnny, 2026-09-06: *"when people were going up in elevation, other things
// weren't getting smaller, which really they should, right? Usually, when you
// put it at an elevation of 20 ft, you can already see the other icons, those
// tokens, getting smaller."* And later: *"I imagine it should be pure
// perspective... I imagine it would be like 2.5% smaller at 10 ft. Let's start
// there."*
//
// ⚠️ THE VIEWER IS THE TOKEN THAT WENT UP. That is the whole model, and his own
// description is what gave it away: he did not say the flying creature grows,
// he said everything else shrinks. So the camera rides with the creature he has
// selected, and anything BELOW it recedes by how far below it is. Nothing above
// him is touched, because you do not look down on what is over your head.
//
// ⚠️ MULTIPLICATIVE, NOT A STRAIGHT LINE. "2.5% smaller per ten feet" taken
// literally as subtraction reaches zero at four hundred feet and goes negative
// after that, which is a token turned inside out. Compounding gives the same
// 2.5% at the first step, keeps shrinking for ever, and never reaches zero.
//
// ⚠️🔴 IT IS A PICTURE, NOT A RULE. This touches the mesh and nothing else.
// The document's width, height and elevation are untouched, because those are
// rules inputs: distance, reach, templates and areas all measure from them. A
// creature that LOOKS small must still be exactly as hard to hit, as far away
// and as much in the fireball as it was. Every measurement in this suite reads
// the document, so scaling the drawing cannot reach them.
//
// ⚠️ AND FOUNDRY UNDOES IT CONSTANTLY. Mesh transforms are recomputed on every
// refresh, which is the same reason `condition-visuals` re-welds its filters on
// `refreshToken`. Reapplying there is the pattern that already works here.
// ──────────────────────────────────────────────────────────────────────────────

import { onCanvasReady } from "./ready-utils.mjs";

const MODULE_ID = "ace-qol";
const LOG = `${MODULE_ID} | perspective`;

// A floor, so a creature two thousand feet below is still a thing he can find
// and click rather than a speck. Purely practical.
const MIN_SCALE = 0.35;

export class Perspective {

  static _on = false;
  static _applied = new Set();     // token ids currently scaled

  static enabled() {
    try { return game.settings.get(MODULE_ID, "perspectiveScaling") === true; }
    catch (_) { return false; }
  }

  static perTenFeet() {
    try {
      const pct = Number(game.settings.get(MODULE_ID, "perspectivePercent"));
      return Number.isFinite(pct) && pct > 0 && pct < 50 ? pct : 2.5;
    } catch (_) { return 2.5; }
  }

  /**
   * The elevation the scene is being looked at from.
   *
   * ⚠️ THE HIGHEST THING HE HAS SELECTED, not the first. Selecting a flier and
   * a groundling together should look like standing with the flier; taking the
   * first of an unordered set would flip the whole view depending on click
   * order, which is the same arbitrary-set-order bug that cancelled an attack
   * at arm's length earlier today.
   */
  static viewerElevation() {
    const controlled = canvas?.tokens?.controlled ?? [];
    if (!controlled.length) return 0;
    let best = 0;
    for (const t of controlled) {
      const ft = Number(t?.document?.elevation ?? 0);
      if (Number.isFinite(ft) && ft > best) best = ft;
    }
    return best;
  }

  /**
   * How big something this far below the viewer should be drawn.
   *
   * @param {number} dropFt  how far BELOW the viewer, in feet
   */
  static scaleFor(dropFt) {
    if (!(dropFt > 0)) return 1;                 // at or above you: untouched
    const step = 1 - (Perspective.perTenFeet() / 100);
    return Math.max(MIN_SCALE, Math.pow(step, dropFt / 10));
  }

  static apply(token) {
    try {
      const mesh = token?.mesh;
      if (!mesh?.scale) return;
      const id = token.document?.id;

      if (!Perspective.enabled()) {
        if (Perspective._applied.has(id)) Perspective._reset(token);
        return;
      }

      const viewer = Perspective.viewerElevation();
      const mine = Number(token.document?.elevation ?? 0) || 0;
      const scale = Perspective.scaleFor(viewer - mine);

      if (scale === 1) { Perspective._reset(token); return; }

      // ⚠️ MULTIPLY THE SCALE FOUNDRY JUST SET, never assign a number. A token
      // can be scaled on its own sheet, and a big wolf shrunk to 0.9 flat would
      // silently lose that. Foundry has already applied the token's own scale
      // by the time refreshToken runs, so this rides on top of it.
      mesh.scale.set(mesh.scale.x * scale, mesh.scale.y * scale);
      Perspective._applied.add(id);
    } catch (err) {
      console.warn(`${LOG} | could not scale ${token?.name}:`, err);
    }
  }

  static _reset(token) {
    // Nothing to undo by hand: Foundry recomputes the mesh from the document on
    // the next refresh, and forgetting the token is what stops us re-applying.
    const id = token?.document?.id;
    if (id) Perspective._applied.delete(id);
    try { token.renderFlags?.set?.({ refreshSize: true }); } catch (_) { /* older build */ }
  }

  static refreshAll() {
    for (const t of (canvas?.tokens?.placeables ?? [])) {
      try { t.renderFlags?.set?.({ refreshSize: true }); } catch (_) { Perspective.apply(t); }
    }
  }

  static register() {
    try {
      game.settings.register(MODULE_ID, "perspectiveScaling", {
        name: "Perspective: the ground shrinks when you climb",
        hint: "While a flying creature is selected, everything below it is DRAWN smaller, "
            + "the further below it is. Nothing about the rules changes: distance, reach, "
            + "cover and areas all still measure from the real elevations.",
        scope: "user", config: true, type: Boolean, default: false,
        onChange: () => Perspective.refreshAll(),
      });
      game.settings.register(MODULE_ID, "perspectivePercent", {
        name: "Perspective: how much smaller per 10 feet",
        hint: "Compounding, so it never reaches zero. 2.5 means something 10 feet below is "
            + "drawn at 97.5%, and 100 feet below at about 78%.",
        scope: "user", config: true, type: Number, default: 2.5,
        range: { min: 0.5, max: 15, step: 0.5 },
        onChange: () => Perspective.refreshAll(),
      });
    } catch (_) { /* already registered */ }

    // ⚠️ REAPPLIED ON REFRESH, because Foundry recomputes the mesh from the
    // document constantly and would wipe this within a frame otherwise. Same
    // reason condition-visuals re-welds its filters here.
    Hooks.on("refreshToken", (token) => Perspective.apply(token));

    // The view changes when the selection changes, or when anything moves up
    // or down.
    Hooks.on("controlToken", () => Perspective.refreshAll());
    Hooks.on("updateToken", (doc, changes) => {
      if (changes?.elevation === undefined) return;
      Perspective.refreshAll();
    });
    onCanvasReady(() => Perspective.refreshAll(), "the perspective scaling");

    console.log(`${LOG} | online — off by default; while a flier is selected, `
      + `the ground below is drawn smaller`);
  }
}
