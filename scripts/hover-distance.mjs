// ─── How far is that, measured the way the rules measure it ─────────────────
//
// Johnny, 2026-09-01: "put in the lines up so I have my own hover distance in
// this module."
//
// ⚠️🔴 THE POINT IS NOT THE LABEL, IT IS THAT IT CANNOT LIE. He was running a
// third-party hover-distance module, and it spent two days telling him numbers
// that disagreed with the engine deciding his auras: 20 feet for a creature at
// 10, 15 for a diagonal ACE called 10. Neither was broken - they were measuring
// with different rules, and there was no way to tell from the board which one
// to believe.
//
// So this reads `aceDistanceFt`, the same function the aura engine, every spell
// range and every reach check use. If the label says 10 feet, the rules agree it
// is 10 feet, because it is the same answer from the same code. That is the only
// reason for ACE to own this at all.
//
// ⚠️ IT DOES NOT MEASURE, IT REPORTS. There is no geometry in this file. The
// moment a second implementation of "how far apart are these" exists, the two
// drift, and that drift is exactly what cost the last two days.
import { MODULE_ID } from "./ace-qol.mjs";
import { QolSettings } from "./settings.mjs";
import { aceDistanceFt } from "./geometry-utils.mjs";

const TAG = () => `${MODULE_ID} | hover distance`;

export class HoverDistance {
  static _label = null;
  static _hovered = null;

  /** Font size that stays readable on any grid, including his 332px one. */
  static _fontSize() {
    const gs = canvas?.grid?.size ?? 100;
    return Math.round(Math.max(18, Math.min(64, gs * 0.16)));
  }

  static _ensureLabel() {
    if (this._label && !this._label.destroyed) return this._label;
    const size = this._fontSize();
    this._label = new PIXI.Text("", {
      fontSize: size,
      fontFamily: "Signika, sans-serif",
      fill: 0xffffff,
      stroke: 0x000000,
      strokeThickness: Math.max(4, Math.round(size / 5)),
      fontWeight: "bold",
      align: "center",
    });
    this._label.anchor.set(0.5, 1);
    this._label.eventMode = "none";   // never eat a click
    this._label.zIndex = 1000;
    try { canvas.interface.addChild(this._label); }
    catch (_) { try { canvas.tokens.addChild(this._label); } catch (_) { /* no canvas */ } }
    return this._label;
  }

  /**
   * Which token are we measuring FROM?
   *
   * ⚠️ THE CONTROLLED TOKEN, AND ONLY ONE. Measuring from several at once would
   * need several labels, and a number on screen with no stated origin is worse
   * than no number. With nothing selected there is no question to answer.
   */
  static _origin() {
    const controlled = canvas?.tokens?.controlled ?? [];
    return controlled.length === 1 ? controlled[0] : null;
  }

  static show(token) {
    try {
      if (QolSettings.get?.("hoverDistance") === false) return this.hide();
      const from = this._origin();
      if (!from || !token || token.id === from.id) return this.hide();

      const ft = aceDistanceFt(from, token);
      if (!Number.isFinite(ft)) {
        // ⚠️ "COULD NOT MEASURE" MUST NOT LOOK LIKE A DISTANCE. Show nothing
        // rather than a number nobody can trust.
        console.warn(`${TAG()} | could not measure from "${from.name}" to `
          + `"${token.name}", so no distance is shown.`);
        return this.hide();
      }

      const units = canvas?.scene?.grid?.units || "ft";
      const label = this._ensureLabel();
      label.style.fontSize = this._fontSize();
      label.text = `${ft} ${units}`;

      // Sit just above the hovered token so it never covers the art.
      const gs = canvas?.grid?.size ?? 100;
      const w = (token.document?.width ?? 1) * gs;
      label.position.set((token.document?.x ?? 0) + w / 2,
                         (token.document?.y ?? 0) - 4);
      label.visible = true;
      this._hovered = token.id;
    } catch (err) {
      console.warn(`${TAG()} | failed to show a distance:`, err);
      this.hide();
    }
  }

  static hide() {
    try {
      if (this._label && !this._label.destroyed) this._label.visible = false;
      this._hovered = null;
    } catch (_) { /* nothing to hide */ }
  }

  static destroy() {
    try {
      if (this._label && !this._label.destroyed) {
        this._label.parent?.removeChild(this._label);
        this._label.destroy();
      }
    } catch (_) { /* already gone */ }
    this._label = null;
    this._hovered = null;
  }

  /**
   * ⚠️ `canvasReady` MAY ALREADY HAVE FIRED. Every ACE subsystem starts from the
   * entry file's own ready handler, so a listener registered here would be
   * waiting on an event already in the past - the bug that left the aura ring
   * layer permanently unattached on 2026-08-27.
   */
  static register() {
    Hooks.on("hoverToken", (token, hovered) => {
      if (hovered) HoverDistance.show(token);
      else if (HoverDistance._hovered === token?.id) HoverDistance.hide();
    });

    // Selecting a different token changes what the number means, and a stale
    // one is worse than none.
    Hooks.on("controlToken", () => HoverDistance.hide());
    Hooks.on("canvasTearDown", () => HoverDistance.destroy());

    // A token moving under the cursor changes the answer.
    Hooks.on("updateToken", (doc) => {
      try {
        if (!HoverDistance._hovered) return;
        const t = canvas?.tokens?.get?.(HoverDistance._hovered);
        if (t) HoverDistance.show(t);
      } catch (_) { /* non-fatal */ }
    });

    console.log(`${TAG()} | registered — measured with the same function the `
      + `rules use, so the label and the engine cannot disagree.`);
  }
}
