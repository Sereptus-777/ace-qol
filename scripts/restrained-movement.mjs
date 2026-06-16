// ─── ACE: QOL — Restrained Movement Lock ─────────────────────────────────────
// RAW: several conditions stop a creature moving under its own power —
// Restrained & Grappled (speed 0), and Paralyzed/Stunned/Unconscious/Petrified
// ("can't move"). This blocks a PLAYER from dragging a token they own while it's
// in any of those states. The GM is never blocked, so forced movement,
// repositioning, and narrative shoves all still work — and the creature moves
// normally again the moment the condition clears (e.g. it breaks free of the rope).
//
// Client-side by design: the block runs on the client that INITIATES the drag,
// so only the player trying to move their own restrained token is stopped. A
// GM-driven move (push/pull, drag-into-place) propagates to the player as an
// update authored by the GM, which this never touches.
//
// Setting `lockRestrainedMovement` (default ON) in the Combat Actions tab.
import { QolSettings } from "./settings.mjs";

const MODULE_ID = "ace-qol";
const TAG = `${MODULE_ID} | RestrainedMove`;

// Conditions that prevent a creature from moving under its own power (RAW):
//   • Restrained / Grappled — speed becomes 0.
//   • Paralyzed / Stunned / Unconscious / Petrified — "can't move" (explicit).
// Prone is intentionally NOT here — a prone creature can still crawl (half speed),
// so dragging it is legitimate. (Status ids are dnd5e's lowercase condition keys.)
const LOCK_STATUSES = ["restrained", "grappled", "paralyzed", "stunned", "unconscious", "petrified"];

export class RestrainedMovement {
  static init() {
    if (this._initialized) return;
    this._initialized = true;
    Hooks.on("preUpdateToken", (tokenDoc, changes, options, userId) => {
      try { return this._onPreUpdate(tokenDoc, changes, options, userId); }
      catch (err) { console.warn(`${TAG} | preUpdateToken failed (allowing move):`, err); return undefined; }
    });
    console.log(`${TAG} | online — restrained/grappled tokens locked from player-initiated movement.`);
  }

  static _onPreUpdate(tokenDoc, changes, options, userId) {
    // Only position changes matter.
    if (!("x" in changes) && !("y" in changes)) return;
    // The GM is never blocked — repositioning, forced movement, narrative moves.
    if (game.user.isGM) return;
    // Only act on the drag the CURRENT client initiated (so a GM-authored move
    // arriving on the player's client isn't blocked).
    if (userId && userId !== game.user.id) return;
    // Setting gate (default ON; missing/unregistered → treat as ON).
    try { if (QolSettings.get?.("lockRestrainedMovement") === false) return; } catch (_) {}

    const actor = tokenDoc.actor;
    const statuses = actor?.statuses;
    const locked = LOCK_STATUSES.find(s => statuses?.has?.(s));
    if (!locked) return;

    // Block it and tell the player why (info, not a warning — their token is
    // visibly wrapped, this just confirms it's intentional, not a glitch).
    const label = locked.charAt(0).toUpperCase() + locked.slice(1);
    try {
      ui.notifications?.info(`${tokenDoc.name} is ${label} — can't move until it's cleared. The GM can reposition it.`);
    } catch (_) {}
    console.log(`${TAG} | blocked player move of "${tokenDoc.name}" — ${locked}`);
    return false;   // cancel the update → token snaps back
  }
}
