// ─── ACE QOL — Disposition Outlines ──────────────────────────────────────────
//
// A heavy silhouette ring around every token you can see, coloured by what that
// creature is to you. Off by default; the GM flips it on when the floor is too
// dark to find anybody.
//
// Johnny, 2026-08-24, prepping the Amber Temple: "the floor is very dark. I
// don't have any trouble because I got PC glow turned on, but I think the guys
// are going to start to complain, especially when they get into a big battle in
// the middle of the room there."
//
// ═══ ⚠️🔴 THE RULE THAT MAKES THIS SAFE: IT DRAWS WHERE YOU CAN ALREADY SEE ═══
//
// He asked for one exclusion — no ring on an invisible token. That is correct
// but it is the SMALL half of the problem. A ring drawn on "every token on
// screen" also shows a player every creature standing behind a wall, waiting in
// the dark past their vision, or hiding. That leak is worse than the invisible
// one because it happens constantly and nobody notices it is happening: the
// players just quietly stop being surprised by anything, ever.
//
// So the gate is not "is it invisible". It is `token.visible` — Foundry's own
// per-client answer to "can THIS person see THIS token right now", which it
// already computes every time vision refreshes. Riding on it covers walls,
// darkness, vision range, detection modes, hiding AND invisibility with one
// condition instead of four, and it can never drift away from what the player
// is actually looking at, because it IS what the player is actually looking at.
//
// ⚠️ FAERIE FIRE WINS. Johnny: "obviously this is not to be used in conjunction
// with Faerie Fire." Both features hang an OutlineOverlayFilter on the same
// token mesh, so a token already lit by the spell gets no disposition ring —
// otherwise you get two rings fighting and the spell, which is a real mechanical
// effect granting advantage, would be indistinguishable from a torch setting.
//
// ⚠️ FOUNDRY-NATIVE FILTER ONLY, NEVER `PIXI.filters.*`. Those live in Token
// Magic FX, which we do not depend on and which is GPL. The construction below
// is lifted from `faerie-fire-fx.mjs`, which was proven live on 2026-06-26 —
// including the one that bites: pass ONLY `outlineColor` to `create()` and set
// `thickness` as a PROPERTY afterwards. Passing thickness into the constructor
// clobbers the filter's [x,y] array uniform with a scalar, and `apply()` then
// throws on EVERY frame and blacks out the canvas. That was the v0.7.96 crash.
// ──────────────────────────────────────────────────────────────────────────────

import { MODULE_ID } from "./ace-qol.mjs";
import { onCanvasReady } from "./ready-utils.mjs";

const LOG = "ace-qol | DispositionOutline";

/** How thick the ring is. "Heavy", per the request — Faerie Fire uses 2. */
const THICKNESS = 3;

/**
 * What a creature is to you.
 * ⚠️ Read from `CONST.TOKEN_DISPOSITIONS` rather than hard-coded numbers, so a
 * core renumbering is a missing key we can see rather than a silently wrong
 * colour on every hostile in the room.
 */
const DISPOSITION_COLORS = {
  hostile:  0xff3b30,   // red
  neutral:  0xffd60a,   // yellow
  friendly: 0x34c759,   // green
};

// ⚠️🔴 THESE TWO REGISTRATIONS RUN AT IMPORT, NOT FROM register().
//
// V13 fires `getSceneControlButtons` ONCE, during init. `register()` is called
// from ACE QOL's ready handler, which is long after that — so a toolbar hook
// added in there is registered against an event that has already happened and
// the button is never built. No error, no warning, just a control that does not
// exist. Johnny, 2026-08-24, after two reloads: "the token lines per demeanor
// are not working... I don't see anything."
//
// Same disease as `Hooks.once("ready")` from inside ready (2026-08-12), one
// event earlier. `party-transfer.mjs` already knew this and says so in a comment;
// this file was written without reading it. Registering at import time puts both
// hooks in place before Foundry has called either one.
Hooks.once("init", () => {
  try {
    // ⚠️ THE SWITCH HAS TO EXIST. A feature read through a try/catch that
    // returns a default is a feature with a toggle nobody can find - exactly how
    // `autoAnimations` ran for months with no way to turn it off.
    // Off by default: most sessions do not want rings on everything.
    game.settings.register(MODULE_ID, "dispositionOutline", {
      name: "Token Outlines",
      hint: "A heavy coloured ring around every token you can see: red for hostile, yellow for neutral, "
          + "green for friendly, and each player character in their own player's colour. Meant for dark "
          + "rooms and crowded fights. Nothing is ever outlined that you could not already see, so it "
          + "never reveals anyone hiding, invisible, or behind a wall. Toggle it live from the Token "
          + "toolbar. Default: OFF.",
      scope: "world", config: true, type: Boolean, default: false,
      onChange: () => DispositionOutline.refreshAll(),
    });
  } catch (err) {
    console.warn(`${MODULE_ID} | DispositionOutline: could not register its setting:`, err);
  }
});

// A toggle on the Token toolbar, because "the party just walked into a dark
// room" is not a moment to be opening a settings window.
Hooks.on("getSceneControlButtons", (controls) => {
  try {
    if (!game.user?.isGM) return;
    // ⚠️ TWO SHAPES, BOTH HANDLED BY SHAPE AND NOT BY VERSION STRING. V13
    // hands over an object keyed by control name whose `tools` is an object;
    // V12 handed over an array of controls each with a `tools` array. Lifted
    // from `party-transfer.mjs`, which is proven in Johnny's game.
    let group;
    if (Array.isArray(controls)) group = controls.find(c => c.name === "token" || c.name === "tokens");
    else if (controls && typeof controls === "object") group = controls.tokens ?? controls.token;
    if (!group) return;

    const tool = {
      name: "ace-disposition-outline",
      title: "Token Outlines - ring every token you can see, coloured by demeanour",
      icon: "fa-solid fa-circle-notch",
      toggle: true,
      active: DispositionOutline.enabled(),
      visible: true,
      order: 99006,
      onChange: () => DispositionOutline.toggle(),
    };

    if (Array.isArray(group.tools)) {
      group.tools = group.tools.filter(t => t?.name !== tool.name);
      group.tools.push(tool);
    } else if (group.tools && typeof group.tools === "object") {
      group.tools[tool.name] = tool;
    }
  } catch (err) {
    console.warn(`${MODULE_ID} | DispositionOutline: could not add the toolbar toggle `
      + `(the setting in Module Settings still works):`, err);
  }
});

export class DispositionOutline {

  /* ── Should this token wear a ring, and what colour? ──────────────────── */

  /**
   * The colour this token's ring should be for THIS client, or null for none.
   * Null is the normal answer for most tokens most of the time.
   */
  static _colorFor(token) {
    try {
      // ⚠️🔴 THE VISIBILITY GATE. Everything else is cosmetic; this is the one
      // that stops the feature being an aimbot. See the header.
      if (!token?.visible) return null;
      if (token.document?.hidden) return null;
      if (token.actor?.statuses?.has?.("invisible")) return null;

      // Faerie Fire owns the outline on this token while it is lit.
      if (token._aceFFFilter) return null;

      // A player character gets their own player's colour, so four PCs in a
      // scrum are four different rings rather than four identical green ones.
      const pcColor = DispositionOutline._playerColorFor(token);
      if (pcColor !== null) return pcColor;

      const D = CONST?.TOKEN_DISPOSITIONS ?? {};
      const d = token.document?.disposition;
      if (d === D.HOSTILE)  return DISPOSITION_COLORS.hostile;
      if (d === D.NEUTRAL)  return DISPOSITION_COLORS.neutral;
      if (d === D.FRIENDLY) return DISPOSITION_COLORS.friendly;
      // SECRET is a GM bookkeeping state, not a demeanour. No ring.
      return null;
    } catch (err) {
      console.debug(`${LOG} | could not read "${token?.name}":`, err);
      return null;
    }
  }

  /**
   * The owning player's colour for a player character, or null if this is not
   * one. Uses Foundry's own per-user colour, so it needs no table to maintain
   * and it already matches the colour that user's name appears in elsewhere.
   */
  static _playerColorFor(token) {
    try {
      const actor = token?.actor;
      if (actor?.type !== "character" || !actor.hasPlayerOwner) return null;
      const owner = game.users?.find?.(u => !u.isGM && actor.testUserPermission(u, "OWNER"));
      if (!owner) return null;
      return DispositionOutline._toHex(owner.color);
    } catch (_) { return null; }
  }

  /**
   * A Foundry user colour as 0xRRGGBB.
   * ⚠️ V13 hands this over as a Color object, V12 as a css string, and some
   * builds as a plain number. Named conversions for each rather than trusting
   * one shape — a wrong number here is an invisible ring, not an error.
   */
  static _toHex(color) {
    if (typeof color === "number" && Number.isFinite(color)) return color;
    const css = (typeof color === "string") ? color : (color?.css ?? String(color ?? ""));
    const m = /^#?([0-9a-f]{6})$/i.exec(css.trim());
    if (m) return parseInt(m[1], 16);
    const n = Number(color?.valueOf?.());
    return Number.isFinite(n) ? n : null;
  }

  /* ── The filter itself ────────────────────────────────────────────────── */

  static _filterClass() {
    return foundry?.canvas?.rendering?.filters?.OutlineOverlayFilter
        ?? globalThis.OutlineOverlayFilter
        ?? null;
  }

  /** 0xRRGGBB → normalised [r,g,b,a], the format OutlineOverlayFilter wants. */
  static _rgba(c, a = 1) {
    return [((c >> 16) & 0xff) / 255, ((c >> 8) & 0xff) / 255, (c & 0xff) / 255, a];
  }

  static _makeFilter(color) {
    const FilterClass = DispositionOutline._filterClass();
    if (!FilterClass) return null;
    let f = null;
    try {
      f = (typeof FilterClass.create === "function")
        ? FilterClass.create({ outlineColor: DispositionOutline._rgba(color), knockout: false })
        : new FilterClass();
    } catch (_) { f = null; }
    if (!f) return null;
    // ⚠️ PROPERTIES, NOT CONSTRUCTOR OPTIONS — see the header. This exact
    // sequence is what stopped the canvas going black in v0.7.96.
    try { f.thickness = THICKNESS; } catch (_) { /* absent on this build */ }
    try { f.knockout = false; }      catch (_) { /* keep the token art visible */ }
    try { f.wave = false; }          catch (_) { /* a steady ring, not a pulse */ }
    return f;
  }

  static _setColor(filter, color) {
    if (!filter) return;
    const rgba = DispositionOutline._rgba(color);
    try { filter.outlineColor = rgba; } catch (_) { /* not a setter here */ }
    try { if (filter.uniforms) filter.uniforms.outlineColor = rgba; } catch (_) { /* no uniforms */ }
  }

  /* ── Applying it ──────────────────────────────────────────────────────── */

  /**
   * Bring one token's ring into line with what it should be.
   *
   * ⚠️ CHEAP WHEN NOTHING CHANGED, ON PURPOSE. `refreshToken` fires on every
   * animation frame while a token is moving, so this runs hundreds of times a
   * second across a busy scene. Rebuilding a filter each time would tank the
   * canvas. Every branch below either does nothing or does the smallest
   * possible thing.
   */
  static refresh(token) {
    try {
      const mesh = token?.mesh;
      if (!mesh) return;                      // mid-draw; the next refresh gets it

      const want = DispositionOutline.enabled() ? DispositionOutline._colorFor(token) : null;
      const have = token._aceDispoFilter ?? null;

      if (want === null) {
        if (have) DispositionOutline.remove(token);
        return;
      }

      if (!have) {
        const filter = DispositionOutline._makeFilter(want);
        if (!filter) return;                  // no filter class on this build
        token._aceDispoFilter = filter;
        token._aceDispoColor = want;
        // APPEND. Never assign — Faerie Fire, Automated Animations and core all
        // hang their own filters here and an assignment would erase them.
        mesh.filters = [...(mesh.filters ?? []), filter];
        return;
      }

      // Re-attach after a full redraw dropped our filter off the mesh.
      const filters = mesh.filters ?? [];
      if (!filters.includes(have)) mesh.filters = [...filters, have];

      if (token._aceDispoColor !== want) {
        DispositionOutline._setColor(have, want);
        token._aceDispoColor = want;
      }
    } catch (err) {
      console.debug(`${LOG} | refresh failed for "${token?.name}" (non-fatal):`, err);
    }
  }

  static remove(token) {
    try {
      const filter = token?._aceDispoFilter;
      if (!filter) return;
      const mesh = token.mesh;
      if (mesh?.filters?.length) {
        const kept = mesh.filters.filter(f => f !== filter);
        mesh.filters = kept.length ? kept : null;
      }
      token._aceDispoFilter = null;
      token._aceDispoColor = null;
    } catch (err) {
      console.debug(`${LOG} | remove failed for "${token?.name}" (non-fatal):`, err);
    }
  }

  static refreshAll() {
    try {
      for (const token of (canvas?.tokens?.placeables ?? [])) DispositionOutline.refresh(token);
    } catch (err) {
      console.warn(`${LOG} | could not sweep the scene:`, err);
    }
  }

  /* ── The switch ───────────────────────────────────────────────────────── */

  static enabled() {
    try { return !!game.settings.get(MODULE_ID, "dispositionOutline"); }
    catch (_) { return false; }
  }

  static async toggle() {
    // ⚠️ ONLY THE GM WRITES A WORLD SETTING. A player clicking this would throw,
    // which is why the control is GM-only, but say it rather than fail silently
    // if it is ever reached another way.
    if (!game.user.isGM) {
      ui.notifications?.warn("Only the GM can switch the token outlines on or off.");
      return;
    }
    const next = !DispositionOutline.enabled();
    await game.settings.set(MODULE_ID, "dispositionOutline", next);
    DispositionOutline.refreshAll();
    // Repaint the toolbar so the button shows its own new state; without this
    // it keeps whatever `active` it was built with and reads as stuck.
    try { ui.controls?.render(); } catch (_) { /* cosmetic */ }
    ui.notifications?.info(`Token outlines ${next ? "ON" : "OFF"}.`);
  }

  /* ── Wiring ───────────────────────────────────────────────────────────── */

  static register() {
    // Every token, every frame it changes. `refresh` is a no-op when nothing
    // actually differs, which is the overwhelming majority of these calls.
    Hooks.on("refreshToken", (token) => DispositionOutline.refresh(token));

    // ⚠️ `sightRefresh` IS THE ONE THAT MATTERS. It fires after Foundry has
    // recomputed what this client can see — walls moved, a light went out, a
    // creature stepped out of the dark. Without it a ring would linger on a
    // creature that just walked behind a wall, which is precisely the leak this
    // feature has to avoid.
    Hooks.on("sightRefresh", () => DispositionOutline.refreshAll());
    onCanvasReady( () => DispositionOutline.refreshAll());

    // Disposition, hidden state and ownership all change the answer.
    Hooks.on("updateToken", (doc, changes) => {
      if (!("disposition" in changes || "hidden" in changes)) return;
      const token = doc.object;
      if (token) DispositionOutline.refresh(token);
    });
    Hooks.on("updateActor", () => DispositionOutline.refreshAll());
    for (const h of ["createActiveEffect", "deleteActiveEffect", "updateActiveEffect"]) {
      Hooks.on(h, () => DispositionOutline.refreshAll());
    }

    // ⚠️ `Hooks.once("ready")` FROM INSIDE ready NEVER FIRES — proven live
    // 2026-08-12. This registers from the entry file's own ready handler.
    if (game.ready) DispositionOutline.refreshAll();
    else Hooks.once("ready", () => DispositionOutline.refreshAll());

    console.log(`${LOG} | online — outlines ${DispositionOutline.enabled() ? "ON" : "OFF"}`);
  }
}
