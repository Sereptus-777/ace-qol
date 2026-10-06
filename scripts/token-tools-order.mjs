// ─── ONE ORDER FOR ACE'S TOKEN BUTTONS, OWNED IN ONE PLACE ───────────────────
//
// His rule, 2026-10-05: "every ACE token button locked in one order... The order
// is one list, owned in one place, not three hooks appending whenever they load."
//
// ⚠️🔴 THREE FILES WERE EACH PINNING THEIR OWN BUTTONS and the result depended on
// which one was imported last. Foundry V13 draws token tools in OBJECT-KEY
// order and ignores the `order` field entirely, so whoever inserted last won:
//
//   quick-select-tools.mjs  moved six buttons to the end on every render, and
//                           its list named only those six.
//   party-transfer.mjs      moved its two to the end AFTER that, and said in a
//                           comment that it works because of the import order.
//   disposition-outline.mjs pinned nothing at all, so the outline toggle slid
//                           wherever the last insert left it.
//
// Three listeners appending in import order is not an order, it is a race that
// happens to settle. There is one list below, one DOM pin and one key reorder,
// and the files that own the buttons no longer have an opinion about where they
// sit. Adding a button is adding a name to the list.
//
// A LEAF: imports nothing of ACE's, so anything may read the list.
// ──────────────────────────────────────────────────────────────────────────────

const MODULE_ID = "ace-qol";

/**
 * Every ACE button on the Token controls, top to bottom, exactly as he wants
 * them. The last name is the last button.
 */
export const ACE_TOKEN_TOOL_ORDER = Object.freeze([
  "ace-select-pcs",
  "ace-select-npcs",
  "ace-select-hostile",
  "ace-select-friendly",
  "ace-select-neutral",
  "ace-select-all",
  "ace-disposition-outline",
  "ace-party-transfer",
  "ace-party-place",
  "ace-set-fire",
  "ace-douse-fire",
  "ace-undo-fire",
  "ace-perception-reset",
]);

/** The first number. Everything after it is this plus a position in the list. */
const FIRST_ORDER = 99001;

/**
 * A button's `order`, taken from its place in the list above.
 *
 * ⚠️🔴 THE NUMBERS USED TO BE WRITTEN IN FOUR FILES AND TWO OF THEM WERE
 * THE SAME: `ace-select-all` and `ace-disposition-outline` both carried 99006
 * (his find, 2026-10-05). Two tools sharing a number is two tools fighting over
 * one slot in anything that sorts by it. Asking the list is the only way they
 * cannot collide: the sequence IS the list, so the order on the screen, the
 * order after a reload and the number on the tool can never disagree.
 *
 * @param {string} name
 * @returns {number} its number, or one past the end for anything not listed
 */
export function aceToolOrder(name) {
  const i = ACE_TOKEN_TOOL_ORDER.indexOf(name);
  if (i < 0) {
    console.warn(`${MODULE_ID} | "${name}" is not in ACE_TOKEN_TOOL_ORDER, so it has no place `
      + `of its own and goes after everything that does. Add it to the list.`);
    return FIRST_ORDER + ACE_TOKEN_TOOL_ORDER.length;
  }
  return FIRST_ORDER + i;
}

/** The token control group, by SHAPE and not by version string. */
function tokenGroupOf(controls) {
  if (!controls) return null;
  if (Array.isArray(controls)) return controls.find(c => c.name === "token" || c.name === "tokens") ?? null;
  if (typeof controls === "object") return controls.tokens ?? controls.token ?? null;
  return null;
}

/**
 * Put the keys in the list's order, so a reload matches the screen.
 *
 * ⚠️ V13 RENDERS BY KEY ORDER. Deleting and re-inserting is the only way to
 * move a tool; the `order` field on a tool is not read for this toolbar.
 */
export function orderAceTokenTools(controls) {
  try {
    const group = tokenGroupOf(controls);
    const tools = group?.tools;
    if (!tools) return;

    if (Array.isArray(tools)) {
      // The old array shape: pull ours out, then push them back in order.
      const mine = [];
      for (const name of ACE_TOKEN_TOOL_ORDER) {
        const found = tools.find(t => t?.name === name);
        if (found) mine.push(found);
      }
      if (!mine.length) return;
      group.tools = tools.filter(t => !ACE_TOKEN_TOOL_ORDER.includes(t?.name)).concat(mine);
      return;
    }

    if (typeof tools !== "object") return;
    const mine = [];
    for (const name of ACE_TOKEN_TOOL_ORDER) {
      if (!(name in tools)) continue;
      mine.push([name, tools[name]]);
      delete tools[name];
    }
    for (const [name, tool] of mine) tools[name] = tool;
  } catch (err) {
    console.warn(`${MODULE_ID} | could not put the token buttons in order (they still work):`, err);
  }
}

/**
 * Move the rendered buttons into the list's order, last one last.
 *
 * `appendChild` on a node that already has a parent MOVES it, so walking the
 * list in order and appending each one leaves them in exactly that order.
 */
export function pinAceTokenTools(root) {
  try {
    if (!game.user?.isGM || !root?.querySelector) return;
    for (const name of ACE_TOKEN_TOOL_ORDER) {
      const el = root.querySelector(`[data-tool="${name}"], [data-name="${name}"], [name="${name}"]`);
      if (el?.parentNode) el.parentNode.appendChild(el);
    }
  } catch (err) {
    console.warn(`${MODULE_ID} | could not pin the token buttons in place (non-fatal):`, err);
  }
}

/* ⚠️ REGISTERED AT IMPORT, AND THIS FILE IS IMPORTED AFTER THE ONES THAT BUILD
   THE BUTTONS, so both listeners run last and the order is the final word.
   `getSceneControlButtons` fires once, during init, long before any ready
   handler: a listener added later is a listener for an event that has already
   happened (the same disease as `Hooks.once("ready")` from inside ready). */
Hooks.on("getSceneControlButtons", (controls) => orderAceTokenTools(controls));
Hooks.on("renderSceneControls", (_app, htmlOrJq) => pinAceTokenTools(htmlOrJq?.[0] ?? htmlOrJq));
