// ─── ACE: QOL — Getting off the ground, and looking like it ─────────────────
//
// Johnny, 2026-09-06, after Tarakamedes' dark gift gave Firaxis a flying speed:
// *"When he pushes that fucking dark gift feature or icon, or whatever feature,
// then he's got to be asked for elevation."* And: *"We need some sort of
// indication that he is flying, although we can't use that same animation there
// with the whirlwind. We've got to come up with something else."*
//
// ⚠️ A FLYING SPEED IS NOT BEING IN THE AIR. That is the whole reason this
// exists. Foundry stores a flying speed as a number on the sheet and never asks
// the question that matters at the table, which is "how high are you". The
// speed says he CAN go up; nothing was putting him up.
//
// ⚠️ IT IS NOT WIRED TO ONE ITEM. Anything with a flying speed gets the control,
// through the token HUD, and any item can raise the prompt on its own by
// carrying the `flightControl` flag. Hard-coding the dark gift would mean doing
// this again for Fly, for a broom, for a griffon, and for the next dark gift.
//
// ⚠️ THE INDICATOR IS A SHADOW, NOT AN ANIMATION. He already has a whirlwind on
// screen for something else and two swirling effects would read as the same
// thing. A soft dark ellipse behind the token, drifting further below the
// creature as it climbs, is what the eye already reads as height in every
// illustration ever drawn, it costs one sprite, and it cannot be mistaken for a
// spell effect.
//
// ⚠️ AND IT IS A CHILD OF THE TOKEN AT INDEX 0, which is the pattern the stone
// backdisc uses. Drawing on a canvas layer means owning the layering, the pan,
// the zoom and the teardown; a child of the token gets all four free and can
// never be left behind on the map.
// ──────────────────────────────────────────────────────────────────────────────

import { onCanvasReady } from "./ready-utils.mjs";

// ⚠️🔴 DECLARED HERE, NEVER IMPORTED FROM THE ENTRY FILE. `ace-qol.mjs`
// imports this module, so importing `MODULE_ID` back out of it is a cycle, and
// a top-level template string reading it throws "cannot access before
// initialization" at load. That does not break this file, it kills the WHOLE
// module: the entry file dies on the way in and nothing after it registers.
//
// This is written down as a lesson from 2026-08-28 and I did it again on
// 2026-09-06. The self-tests caught it; his world would have caught it worse.
// Every leaf in this suite declares the id locally for exactly this reason.
const MODULE_ID = "ace-qol";
const LOG = `${MODULE_ID} | flight`;
const MARK = "aceFlightShadow";
const LABEL = "aceFlightLabel";

export class FlightControl {

  /** The creature's flying speed in feet, or 0. */
  static flySpeed(actor) {
    const raw = actor?.system?.attributes?.movement?.fly;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }

  static canFly(actor) { return FlightControl.flySpeed(actor) > 0; }

  /* ── The question ──────────────────────────────────────────────────────── */

  /**
   * "How high?"
   *
   * ⚠️ A DARK WRAPPER, BECAUSE FOUNDRY'S DIALOG IS LIGHT PARCHMENT. ACE's own
   * colours are invisible on it, which is a standing rule in this suite and a
   * lesson every dialog that ignored it had to relearn.
   *
   * ⚠️ AND IT SUGGESTS, IT DOES NOT POLICE. The quick buttons are built from the
   * creature's own speed, and the box accepts anything. A creature can be thrown
   * higher than it can fly, and telling a GM his number is illegal is the kind
   * of automation that gets switched off.
   */
  static async askHeight(token) {
    const actor = token?.actor;
    if (!actor) return null;
    const speed = FlightControl.flySpeed(actor);
    const now = Number(token.document?.elevation ?? 0) || 0;
    const esc = (v) => foundry.utils.escapeHTML(String(v ?? ""));

    const steps = [...new Set([0, 10, 20, Math.round(speed / 2), speed]
      .filter(v => Number.isFinite(v) && v >= 0))].sort((a, b) => a - b);

    const content = `
      <div style="background:linear-gradient(180deg,#15110d 0%,#0c0a08 100%);
                  border:2px solid #d4af37;border-radius:8px;padding:16px 18px;
                  color:#f0e4c0;font-family:'Signika','Helvetica Neue',sans-serif;">
        <div style="font-size:18px;font-weight:600;color:#ffd970;margin-bottom:6px;">
          ${esc(token.name)} takes to the air</div>
        <div style="font-size:16px;line-height:1.5;margin-bottom:12px;">
          Flying speed <strong>${speed || "none"}</strong> feet.
          Currently at <strong>${now}</strong> feet.</div>
        <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px;">
          ${steps.map(v => `<button type="button" data-ft="${v}" class="ace-fly-step"
             style="flex:1 1 auto;min-width:64px;background:#2a2118;color:#ffd970;
                    border:1px solid #d4af37;border-radius:4px;padding:6px 8px;
                    font-size:16px;cursor:pointer;">${v === 0 ? "Land" : `${v} ft`}</button>`).join("")}
        </div>
        <label style="display:flex;align-items:center;gap:8px;font-size:16px;">
          <span>Or set exactly</span>
          <input type="number" name="ft" value="${now}" step="5"
                 style="flex:1;background:#0c0a08;color:#f0e4c0;border:1px solid #6b5a2e;
                        border-radius:4px;padding:6px 8px;font-size:16px;">
          <span>feet</span>
        </label>
      </div>`;

    return foundry.applications.api.DialogV2.wait({
      window: { title: "ACE — Altitude" },
      position: { width: 460 },
      content,
      buttons: [
        { action: "set", label: "Set", default: true,
          callback: (_ev, _btn, dialog) => {
            const el = dialog.element ?? dialog;
            return Number(el.querySelector('input[name="ft"]')?.value ?? 0) || 0;
          } },
        { action: "cancel", label: "Cancel", callback: () => null },
      ],
      render: (_ev, dialog) => {
        const el = dialog.element ?? dialog;
        for (const b of el.querySelectorAll(".ace-fly-step")) {
          b.addEventListener("click", (ev) => {
            ev.preventDefault();
            const box = el.querySelector('input[name="ft"]');
            if (box) box.value = b.dataset.ft;
          });
        }
      },
      rejectClose: false,
    }).catch(() => null);
  }

  /** Ask, then move. Returns the height set, or null if nothing happened. */
  static async prompt(token) {
    try {
      if (!token?.document) return null;
      const ft = await FlightControl.askHeight(token);
      if (ft === null || ft === undefined) return null;
      await token.document.update({ elevation: ft });
      ui.notifications?.info(ft > 0
        ? `${token.name} is flying at ${ft} feet.`
        : `${token.name} is back on the ground.`);
      return ft;
    } catch (err) {
      // ⚠️ SAY IT. A control that silently does nothing is worse than no control.
      console.error(`${LOG} | could not set the altitude for ${token?.name}:`, err);
      ui.notifications?.error(`ACE: could not change ${token?.name}'s altitude — see the console.`);
      return null;
    }
  }

  /* ── The indicator ─────────────────────────────────────────────────────── */

  static _clear(token) {
    for (const key of [MARK, LABEL]) {
      const old = token?.[key];
      if (!old) continue;
      // ⚠️ DETACH FIRST, THEN DESTROY. PIXI's destroy does remove a child from
      // its parent, and relying on that makes the cleanup depend on an
      // internal we do not own. Seventeen copies of one aura ring on one token
      // (2026-09-02) came from exactly this kind of trust.
      try { token.removeChild?.(old); } catch (_) { /* not attached */ }
      try { old.destroy({ children: true }); } catch (_) { /* already gone */ }
      token[key] = null;
    }
  }

  /**
   * A shadow behind the token that falls further as it climbs, and the height
   * in feet above it.
   *
   * ⚠️ SIZE AND OFFSET COME FROM THE MESH, not from the grid. A Huge dragon and
   * a rat both need a shadow that belongs to them, and reading `getSize()`
   * multiplied by scale is how every previous overlay in this suite ended up
   * the wrong size on a scaled token.
   */
  static draw(token) {
    try {
      if (!token?.document || token.destroyed) return;
      FlightControl._clear(token);

      const ft = Number(token.document.elevation ?? 0) || 0;
      if (ft <= 0) return;                      // on the ground: nothing to draw

      const w = token.mesh?.width  || token.w || canvas.grid.size;
      const h = token.mesh?.height || token.h || canvas.grid.size;

      // How far the shadow falls, how small it gets, and how faint.
      //
      // ⚠️🔴 EVERY ONE OF THESE MUST KEEP MOVING WITH HEIGHT. The first
      // version used a straight line with a hard cap, and the cap bit at about
      // thirty-seven feet — so a creature hovering at forty and a creature at two
      // hundred drew an identical shadow, which is the one thing this is for.
      // A saturating curve never stops responding and never runs off the map.
      const drop = h * (0.18 + 0.72 * (1 - Math.exp(-ft / 80)));
      const shrink = 0.45 + 0.55 * Math.exp(-ft / 120);
      const alpha = 0.18 + 0.24 * Math.exp(-ft / 150);

      const g = new PIXI.Graphics();
      g.eventMode = "none";                     // a ghost, never a click target
      g.interactiveChildren = false;
      g.beginFill(0x000000, alpha);
      g.drawEllipse(w / 2, (h / 2) + drop, (w / 2) * shrink * 0.85, (h / 2) * shrink * 0.35);
      g.endFill();
      // ⚠️ INDEX 0: behind the creature's art, exactly like the stone backdisc.
      try { token.addChildAt(g, 0); } catch (_) { token.addChild(g); }
      token[MARK] = g;

      const style = new PIXI.TextStyle({
        fontFamily: "Signika, sans-serif", fontSize: Math.max(14, canvas.grid.size * 0.22),
        fill: "#ffd970", stroke: "#000000", strokeThickness: 4, fontWeight: "600",
      });
      const t = new PIXI.Text(`▲ ${ft} ft`, style);
      t.eventMode = "none";
      t.anchor.set(0.5, 1);
      t.position.set(w / 2, -4);
      token.addChild(t);
      token[LABEL] = t;
    } catch (err) {
      console.warn(`${LOG} | could not draw the flight marker on ${token?.name}:`, err);
    }
  }

  static refreshAll() {
    for (const t of (canvas?.tokens?.placeables ?? [])) FlightControl.draw(t);
  }

  /* ── Wiring ────────────────────────────────────────────────────────────── */

  static register() {
    // The marker follows the number, wherever the number came from: this
    // control, the elevation box on the HUD, a region, another module.
    Hooks.on("updateToken", (doc, changes) => {
      if (changes?.elevation === undefined && changes?.texture === undefined
          && changes?.width === undefined && changes?.height === undefined) return;
      const token = doc?.object;
      if (token) FlightControl.draw(token);
    });
    Hooks.on("deleteToken", (doc) => { if (doc?.object) FlightControl._clear(doc.object); });
    Hooks.on("drawToken", (token) => FlightControl.draw(token));
    onCanvasReady(() => FlightControl.refreshAll(), "the flight markers");

    // ── The button on the token HUD ──
    // ⚠️ EVERYTHING THAT CAN FLY, not one item. A griffon, a broom, the Fly
    // spell and the dark gift are the same question.
    Hooks.on("renderTokenHUD", (hud, html) => {
      try {
        const token = hud?.object;
        if (!FlightControl.canFly(token?.actor)) return;
        const root = html instanceof HTMLElement ? html : (html?.[0] ?? html);
        const col = root?.querySelector(".col.left") ?? root?.querySelector(".left");
        if (!col || col.querySelector(".ace-flight-btn")) return;
        const b = document.createElement("button");
        b.type = "button";
        b.className = "control-icon ace-flight-btn";
        b.dataset.tooltip = "ACE — Altitude";
        b.innerHTML = `<i class="fas fa-feather-pointed"></i>`;
        b.addEventListener("click", (ev) => {
          ev.preventDefault(); ev.stopPropagation();
          FlightControl.prompt(token);
        });
        col.appendChild(b);
      } catch (err) {
        console.warn(`${LOG} | could not add the altitude button:`, err);
      }
    });

    // ── An item can raise the question itself ──
    // ⚠️ A FLAG, NOT A NAME. Any item carrying `flightControl` asks for a height
    // when it is used, so the dark gift, a potion of flying and a homebrew broom
    // all work without a line of code each.
    Hooks.on("dnd5e.postUseActivity", (activity) => {
      try {
        const item = activity?.item;
        if (item?.getFlag?.(MODULE_ID, "flightControl") !== true) return;
        const token = item.actor?.getActiveTokens?.()?.[0];
        if (!token) {
          ui.notifications?.warn(`${item.actor?.name ?? "That creature"} has no token on this scene, `
            + `so there is nothing to raise.`);
          return;
        }
        FlightControl.prompt(token);
      } catch (err) {
        console.warn(`${LOG} | flight-control item hook failed:`, err);
      }
    });

    console.log(`${LOG} | online — altitude on the token HUD for anything with a flying `
      + `speed, and a shadow that falls further the higher it gets`);
  }
}
