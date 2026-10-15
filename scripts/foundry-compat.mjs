// ─── ACE QOL — one place for every name Foundry 14 changes ────────────────────
//
// His rule, 2026-10-14: "Start making ACE load on Foundry 13 and 14... Each of
// these keeps working on 13 and uses the 14 name when that name exists."
//
// Four names change between 13 and 14. Each one is chosen HERE and nowhere else,
// so no call site carries its own copy of the choice:
//
//   1. onRenderChatMessage   renderChatMessageHTML, else renderChatMessage.
//   2. regionTestPoint       RegionDocument#testPoint, else the placeable's.
//   3. currentMessageMode /  the messageMode setting and ChatMessage.applyMode,
//      messageModeName /     else the rollMode setting and applyRollMode.
//      applyMessageMode
//   4. deleteKey             the `_del` operator, else the `-=key` spelling.
//
// Proved from Foundry 13.351's own source (client/documents/chat-message.mjs,
// region.mjs, canvas/placeables/region.mjs, common/constants.mjs) and from the
// Foundry 14.368 API pages (ChatMessage.applyMode; applyDataOperators). Nothing
// here is a guess at a 14 name: a 14 name is used only when it is THERE.
//
// ⚠️ Imports nothing on purpose: the entry file imports the files that import
// this, and a cycle read at load kills the whole module (2026-09-06).
// ──────────────────────────────────────────────────────────────────────────────

const TAG = "ace-qol | Foundry 13/14";

/* ── 1. Chat cards ──────────────────────────────────────────────────────── */

let _saidUnreadable = false;

/**
 * Register a chat-card render listener on the hook this Foundry fires.
 *
 * Foundry 13 and 14 fire `renderChatMessageHTML` with an HTMLElement. Foundry 13
 * ALSO fires the deprecated `renderChatMessage` (with jQuery) whenever anything
 * listens to it, so registering both runs every listener twice. One hook, picked
 * by the generation. The listener is always handed an HTMLElement, whichever hook
 * fired, so no listener has to handle jQuery.
 *
 * Call it at init or later: before init Foundry has not said which version it is.
 *
 * @param {(message: ChatMessage, element: HTMLElement, context?: object) => void} handler
 * @returns {{hook: string, id: number}|null}
 */
export function onRenderChatMessage(handler) {
  if (typeof handler !== "function") {
    console.warn(`${TAG} | a chat render listener was registered with no function; nothing registered.`);
    return null;
  }
  const hook = chatRenderHook();
  const id = Hooks.on(hook, (message, html, ...rest) => handler(message, html?.jquery ? html[0] : html, ...rest));
  return { hook, id };
}

/** The chat-card render hook this Foundry fires, for anything that has to name it. */
export function chatRenderHook() {
  // The generation, not `isNewerVersion(game.version, "13")`: that comparison is
  // false on a 13.0 and would pick the old name on the very version it guards.
  const generation = game?.release?.generation ?? parseInt(game?.version) ?? 0;
  if (!Number.isFinite(generation) && !_saidUnreadable) {
    _saidUnreadable = true;
    console.warn(`${TAG} | could not read Foundry's generation, so chat listeners are on `
      + `the old renderChatMessage hook.`);
  }
  return generation >= 13 ? "renderChatMessageHTML" : "renderChatMessage";
}

/* ── 2. Regions ─────────────────────────────────────────────────────────── */

/**
 * Is this point, at this elevation, inside the region?
 *
 * Foundry 13 and 14 ask the DOCUMENT: `RegionDocument#testPoint(point)` takes one
 * elevated point. The placeable's `Region#testPoint(point, elevation)` is the
 * deprecated shim (13 to 15) and is only the fallback for a document without it.
 * `region` may be the document or the placeable. Throws what Foundry throws; the
 * caller decides what an unanswerable region means.
 *
 * @param {RegionDocument|Region} region
 * @param {{x: number, y: number, elevation?: number}} point
 */
export function regionTestPoint(region, { x, y, elevation = 0 }) {
  const doc = region?.document ?? region;
  if (typeof doc?.testPoint === "function") return !!doc.testPoint({ x, y, elevation });
  const placeable = doc?.object ?? region;
  if (typeof placeable?.testPoint === "function") return !!placeable.testPoint({ x, y }, elevation);
  return false;
}

/* ── 3. Who sees a message ──────────────────────────────────────────────── */

// Foundry 13's names and Foundry 14's for the same four modes. 13's
// applyRollMode and 14's applyMode describe them identically: public (nobody
// whispered), self (whispered to the roller), gm (whispered to the GMs) and
// blind (whispered to the GMs, hidden from the roller).
const OLD_TO_NEW = Object.freeze({ publicroll: "public", selfroll: "self", gmroll: "gm", blindroll: "blind" });
const NEW_TO_OLD = Object.freeze({ public: "publicroll", self: "selfroll", gm: "gmroll", blind: "blindroll" });

function _isFourteen() {
  return typeof globalThis.ChatMessage?.applyMode === "function";
}

/** The mode the table has chosen: the messageMode setting where it exists, else rollMode. */
export function currentMessageMode() {
  const key = game?.settings?.settings?.has?.("core.messageMode") ? "messageMode" : "rollMode";
  return game.settings.get("core", key);
}

/**
 * A mode's name in the words this Foundry uses. Takes either spelling
 * ("gm" or "gmroll"), so the choice lives here and not at each call site.
 * @param {"public"|"self"|"gm"|"blind"|"publicroll"|"selfroll"|"gmroll"|"blindroll"} mode
 */
export function messageModeName(mode) {
  const m = String(mode ?? "");
  return _isFourteen() ? (OLD_TO_NEW[m] ?? m) : (NEW_TO_OLD[m] ?? m);
}

/**
 * Apply a visibility mode to a chat message's data, with whichever of
 * ChatMessage.applyMode (14) or applyRollMode (13) this Foundry has. Left out,
 * the table's own mode is used.
 * @param {object} chatData
 * @param {string} [mode]
 * @returns {object} chatData
 */
export function applyMessageMode(chatData, mode = currentMessageMode()) {
  const name = messageModeName(mode);
  if (_isFourteen()) return globalThis.ChatMessage.applyMode(chatData, name);
  return globalThis.ChatMessage.applyRollMode(chatData, name);
}

/* ── 4. Deleting a key ──────────────────────────────────────────────────── */

/**
 * An update that DELETES one key. A recursive merge of `{}` clears nothing on
 * 13 (the damage card's UNDO ALL, 2026-10-06), and 14 replaces the `-=key`
 * spelling with a ForcedDeletion operator, the `_del` value. `_del` is used when
 * this Foundry has it; on 13 it does not, and `-=key` is the operator that works.
 *
 * @param {string} path  the full dotted path, e.g. "flags.ace-qol.hpDelta"
 * @returns {object}     spread it into the update
 */
export function deleteKey(path) {
  const p = String(path ?? "");
  const del = globalThis._del;
  if (del !== undefined) return { [p]: del };
  const dot = p.lastIndexOf(".");
  return { [`${p.slice(0, dot + 1)}-=${p.slice(dot + 1)}`]: null };
}
