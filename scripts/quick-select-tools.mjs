// ─── ACE: QOL — Quick Select Tools ───────────────────────────────────────────
// Adds GM-only buttons to the Token layer toolbar for one-click selection of
// PCs, NPCs, hostile/friendly/neutral disposition, or all tokens on the scene.
//
// V13 only fires `getSceneControlButtons` once at init (before our instance
// exists), so we register the hook at module-load time AND directly mutate
// ui.controls.controls.tokens.tools after ready as a belt-and-suspenders
// approach. The hook handles future renders; the direct mutation handles the
// current already-rendered controls.
// ──────────────────────────────────────────────────────────────────────────────

import { MODULE_ID } from "./ace-qol.mjs";
// One list owns both where these sit and what their number is.
import { aceToolOrder } from "./token-tools-order.mjs";

let _quickSelectInstance = null;

// ─── Module-load: register hook before V13's first _prepareControls fires ──
// If we end up active before init finishes, the hook fires with controls
// during V13 init and our buffered tool definitions get inserted naturally.
Hooks.on("getSceneControlButtons", (controls) => {
  try {
    QuickSelectTools._injectIntoControls(controls);
  } catch (err) {
    console.error(`${MODULE_ID} | Quick select tools hook injection failed:`, err);
  }
});

/* ⚠️🔴 THE ORDER IS NOT THIS FILE'S ANY MORE (his rule, 2026-10-05).
   There was a `renderSceneControls` pin here that moved these six to the end on
   every render, and its list named only these six, so the outline toggle and the
   two party buttons kept sliding. party-transfer.mjs had a second pin that ran
   after this one by import order, which is a race that settles, not an order.
   token-tools-order.mjs owns the one list and both hooks now. */

export class QuickSelectTools {

  constructor() {
    if (!game.user.isGM) return;
    _quickSelectInstance = this;

    console.debug(`${MODULE_ID} | Quick select tools registered`);

    // v0.7.21: poll-until-ready instead of fixed 200ms timer.
    // On cold cache (F5 reload), ui.controls.controls isn't always populated
    // within 200ms — the inject would silently no-op and the tool buttons
    // would only appear on the SECOND module reload. (Audit-mandated
    // 2026-06-09 — same "first cast/load fails, second works" pattern.)
    const _waitForControls = (attempt = 0, maxAttempts = 50) => {
      if (ui.controls?.controls) {
        this._postInitInject();
        // Diagnostic after one more tick so the inject result is visible
        setTimeout(() => this._diagnose(), 100);
        return;
      }
      if (attempt >= maxAttempts) {
        console.warn(`${MODULE_ID} | Quick select: ui.controls.controls never became available after ${maxAttempts * 100}ms`);
        return;
      }
      setTimeout(() => _waitForControls(attempt + 1, maxAttempts), 100);
    };
    _waitForControls();
  }

  _postInitInject() {
    try {
      const ctrl = ui.controls?.controls;
      if (!ctrl) {
        console.warn(`${MODULE_ID} | Quick select: ui.controls.controls not yet available`);
        return;
      }
      QuickSelectTools._injectIntoControls(ctrl);

      // Re-render the toolbar so the new buttons appear immediately
      try {
        ui.controls.render?.();
      } catch (renderErr) {
        console.warn(`${MODULE_ID} | Quick select: render failed (non-fatal):`, renderErr);
      }
    } catch (err) {
      console.error(`${MODULE_ID} | Quick select _postInitInject failed:`, err);
    }
  }

  _diagnose() {
    try {
      const ctrl = ui.controls?.controls;
      const tokenGroup = ctrl?.tokens ?? ctrl?.token;
      const toolsContainer = tokenGroup?.tools;
      const aceTools = toolsContainer
        ? (Array.isArray(toolsContainer)
            ? toolsContainer.filter(t => t?.name?.startsWith?.("ace-select-")).map(t => t.name)
            : Object.keys(toolsContainer).filter(k => k.startsWith("ace-select-")))
        : [];
      const tokenToolKeys = toolsContainer
        ? (Array.isArray(toolsContainer)
            ? toolsContainer.map(t => t?.name)
            : Object.keys(toolsContainer))
        : [];
      const apiVersion = (typeof toolsContainer === "object" && !Array.isArray(toolsContainer)) ? "v13-objectmap" : (Array.isArray(toolsContainer) ? "v12-array" : "unknown");
      console.log(`${MODULE_ID} | Quick select diagnostic — apiVersion=${apiVersion} aceTools=[${aceTools.join(",")}] allTokenTools=[${tokenToolKeys.join(",")}]`);
    } catch (err) {
      console.warn(`${MODULE_ID} | Quick select diagnostic failed:`, err);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Tool injection (static so the early hook can call it before instance exists)
  // ═══════════════════════════════════════════════════════════════════════════

  static _injectIntoControls(controls) {
    if (!controls) return;
    if (!game.user?.isGM) return;

    // Find the token control group (v12: array of groups, v13: object map)
    let tokenGroup;
    if (Array.isArray(controls)) {
      tokenGroup = controls.find(c => c.name === "token" || c.name === "tokens");
    } else if (typeof controls === "object") {
      tokenGroup = controls.tokens ?? controls.token;
    }
    if (!tokenGroup) return;

    // Build the tool definitions
    const selectByFilter = (filterFn) => {
      if (_quickSelectInstance) {
        _quickSelectInstance.selectByFilter(filterFn);
      } else {
        QuickSelectTools._fallbackSelect(filterFn);
      }
    };

    const makeBtn = (name, title, icon, filterFn) => ({
      name,
      title,
      icon,
      button: true,
      visible: true,
      // ⚠️ NOT A NUMBER TYPED HERE. Four files typed their own and two matched.
      order: aceToolOrder(name),
      // ⚠️🔴 ONE HANDLER. Foundry V13 fires BOTH `onClick` and `onChange`
      // for a button tool, so every one of these selected twice — which is why
      // Johnny's console read "Selected 9 tokens" two times from one press.
      onChange: () => selectByFilter(filterFn),
    });

    // The numbers are very high so V13's tool sort places these AFTER every
    // other module's tools (Sequencer, Token Manager, BG3 HUD); 900-905 landed
    // mid-list because some modules register higher. They come off the one list
    // in token-tools-order.mjs, in the order he wants to see them.
    const tools = [
      makeBtn("ace-select-pcs",      "Select all Player Characters on this scene",   "fas fa-users",
        t => t.actor?.type === "character" && t.actor?.hasPlayerOwner),
      makeBtn("ace-select-npcs",     "Select all NPCs on this scene",                "fas fa-skull",
        t => t.actor?.type === "npc"),
      // ⚠️🔴 NOT A FLAME. This was `fas fa-fire`, identical to the fire
      // engine's own tool, so he pressed it expecting to set something alight
      // and selected every hostile on the scene instead — twice.
      makeBtn("ace-select-hostile",  "Select all Hostile tokens (red disposition)",  "fas fa-hand-fist",
        t => t.document?.disposition === -1),
      makeBtn("ace-select-friendly", "Select all Friendly tokens (green disposition)","fas fa-handshake",
        t => t.document?.disposition === 1),
      makeBtn("ace-select-neutral",  "Select all Neutral tokens (yellow disposition)","fas fa-circle-half-stroke",
        t => t.document?.disposition === 0),
      makeBtn("ace-select-all",      "Select ALL tokens on this scene",              "fas fa-globe",
        () => true),
    ];

    // v12 (array) vs v13 (object map) tool insertion
    if (Array.isArray(tokenGroup.tools)) {
      // Strip any existing copies of our buttons so we can re-push to the end
      tokenGroup.tools = tokenGroup.tools.filter(t => !t?.name?.startsWith?.("ace-select-"));
      tokenGroup.tools.push(...tools);
    } else if (tokenGroup.tools && typeof tokenGroup.tools === "object") {
      // V13 renders tools in object-key insertion order, NOT by `order` field.
      // Delete any prior copies of our keys, then re-insert so they land at
      // the very end of Object.keys() — which is the bottom of the toolbar.
      for (const tool of tools) {
        if (tool.name in tokenGroup.tools) delete tokenGroup.tools[tool.name];
      }
      for (const tool of tools) {
        tokenGroup.tools[tool.name] = tool;
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Selection
  // ═══════════════════════════════════════════════════════════════════════════

  selectByFilter(filterFn) {
    if (!canvas?.tokens?.placeables) return;
    const matching = canvas.tokens.placeables.filter(t => {
      try { return filterFn(t); } catch { return false; }
    });

    if (!matching.length) {
      ui.notifications?.info("ACE QOL | No matching tokens on this scene.");
      return;
    }

    canvas.tokens.releaseAll();
    for (const token of matching) {
      try { token.control({ releaseOthers: false }); } catch (_) { /* skip uncontrollable */ }
    }

    ui.notifications?.info(
      `ACE QOL | Selected ${matching.length} token${matching.length === 1 ? "" : "s"}.`
    );
  }

  // Static fallback used when the hook fires before our instance is created
  static _fallbackSelect(filterFn) {
    if (!canvas?.tokens?.placeables) return;
    const matching = canvas.tokens.placeables.filter(t => {
      try { return filterFn(t); } catch { return false; }
    });
    if (!matching.length) {
      ui.notifications?.info("ACE QOL | No matching tokens on this scene.");
      return;
    }
    canvas.tokens.releaseAll();
    for (const token of matching) {
      try { token.control({ releaseOthers: false }); } catch (_) { /* skip */ }
    }
    ui.notifications?.info(`ACE QOL | Selected ${matching.length} token${matching.length === 1 ? "" : "s"}.`);
  }
}
