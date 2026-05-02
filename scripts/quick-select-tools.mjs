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

// ─── DOM-level reordering: move our buttons to the end of the toolbar ──
// V13 uses object-key insertion order to render tools, but other modules
// register their tools at unpredictable times — sometimes after us. The
// only way to guarantee our buttons land at the very bottom is to grab
// the rendered DOM elements and append() them (which moves them) to the
// end of their parent container after every render of SceneControls.
Hooks.on("renderSceneControls", (_app, htmlOrJq) => {
  try {
    if (!game.user?.isGM) return;
    const root = htmlOrJq?.[0] ?? htmlOrJq; // Accept jQuery or HTMLElement
    if (!root?.querySelectorAll) return;

    // V13 may use `data-tool`, `data-name`, or just `name` to identify a tool
    // button. Try each selector in order; first non-empty match wins.
    const aceOrder = ["ace-select-pcs", "ace-select-npcs", "ace-select-hostile",
                      "ace-select-friendly", "ace-select-neutral", "ace-select-all"];
    const selectors = [
      '[data-tool^="ace-select-"]',
      '[data-name^="ace-select-"]',
      '[name^="ace-select-"]',
      'button[id^="ace-select-"]',
    ];
    let ourButtons = null;
    let matchedAttr = "data-tool";
    for (const sel of selectors) {
      const found = root.querySelectorAll(sel);
      if (found?.length) {
        ourButtons = found;
        matchedAttr = sel.match(/\[([\w-]+)/)?.[1] ?? "data-tool";
        break;
      }
    }
    if (!ourButtons?.length) return;

    // Move our buttons to the end of their parent container, in canonical
    // order. appendChild on an already-parented node MOVES it (doesn't clone).
    const parent = ourButtons[0].parentNode;
    if (!parent) return;
    for (const name of aceOrder) {
      const el = parent.querySelector(`[${matchedAttr}="${name}"]`);
      if (el) parent.appendChild(el);
    }
  } catch (err) {
    console.warn(`${MODULE_ID} | Quick select DOM reorder failed (non-fatal):`, err);
  }
});

export class QuickSelectTools {

  constructor() {
    if (!game.user.isGM) return;
    _quickSelectInstance = this;

    console.log(`${MODULE_ID} | Quick select tools registered`);

    // Direct mutation: V13 already built ui.controls.controls during init,
    // and our hook missed that one fire. Inject directly into the live data
    // structure now, then trigger a render so the buttons paint.
    setTimeout(() => this._postInitInject(), 200);

    // Diagnostic so we can confirm our tools landed in the data structure.
    setTimeout(() => this._diagnose(), 800);
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

    const makeBtn = (name, title, icon, filterFn, order) => ({
      name,
      title,
      icon,
      button: true,
      visible: true,
      order,
      onClick:  () => selectByFilter(filterFn),
      onChange: () => selectByFilter(filterFn),
    });

    // Use very high `order` values so V13's tool sort places these AFTER all
    // other modules' tools (Sequencer, Token Manager, BG3 HUD, etc.). We saw
    // 900-905 land mid-list because some modules register higher orders.
    const tools = [
      makeBtn("ace-select-pcs",      "Select all Player Characters on this scene",   "fas fa-users",
        t => t.actor?.type === "character" && t.actor?.hasPlayerOwner, 99001),
      makeBtn("ace-select-npcs",     "Select all NPCs on this scene",                "fas fa-skull",
        t => t.actor?.type === "npc", 99002),
      makeBtn("ace-select-hostile",  "Select all Hostile tokens (red disposition)",  "fas fa-fire",
        t => t.document?.disposition === -1, 99003),
      makeBtn("ace-select-friendly", "Select all Friendly tokens (green disposition)","fas fa-handshake",
        t => t.document?.disposition === 1, 99004),
      makeBtn("ace-select-neutral",  "Select all Neutral tokens (yellow disposition)","fas fa-circle-half-stroke",
        t => t.document?.disposition === 0, 99005),
      makeBtn("ace-select-all",      "Select ALL tokens on this scene",              "fas fa-globe",
        () => true, 99006),
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
