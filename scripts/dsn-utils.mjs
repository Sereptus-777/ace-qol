// ─── ACE QOL — Dice So Nice utilities ─────────────────────────────────────
//
// Dependency-free helpers for invoking Dice So Nice from anywhere in the
// codebase. This module imports NOTHING from other ace-qol files so it can
// be safely imported from anywhere — including concentration-widget.mjs,
// which is itself imported by ace-qol.mjs (the main entry) and would
// create a circular dependency if it tried to import from damage-engine.mjs
// (which imports MODULE_ID from ace-qol.mjs).
//
// MODULE_ID is hardcoded here for the same reason concentration-widget.mjs
// hardcodes it: this file sits at the leaf of the dependency graph.
// ───────────────────────────────────────────────────────────────────────────

const MODULE_ID = "ace-qol";

/**
 * safeShowForRoll — the canonical fire-and-forget Dice So Nice display.
 *
 * The ONLY sanctioned way to invoke DSN from inside ace-qol's damage /
 * save / attack / fumble / concentration flows. Replaces ~13 inline
 * implementations that each had subtly different try/catch and optional-
 * chaining patterns, a few of which had hang risks (Grok audit caught
 * the last batch in v0.7.2).
 *
 * Guards against every known failure mode:
 *   - DSN not loaded            → game.dice3d undefined → optional chain
 *   - DSN half-broken           → game.dice3d.showForRoll undefined → optional chain
 *   - DSN throws synchronously  → outer try/catch
 *   - DSN returns rejected promise → inner .catch
 *   - DSN returns a non-thenable → optional .catch
 *
 * Never returns an awaitable. Callers that do `await safeShowForRoll(...)`
 * will await `undefined`, which is a no-op — but the contract is that this
 * function is sync and the call to DSN itself is fire-and-forget. Production
 * has bitten us with awaited DSN promises hanging the entire damage pipeline
 * when the renderer was broken (v0.4.21, 4+ live hangs in a single combat).
 *
 * @param {Roll}   roll    — Foundry Roll instance to animate
 * @param {string} [label] — short tag for diagnostic logs (e.g. "save roll")
 */
export function safeShowForRoll(roll, label = "dice animation") {
  if (!roll) return;
  try {
    const p = game.dice3d?.showForRoll?.(roll, game.user, true);
    p?.catch?.(err =>
      console.warn(`${MODULE_ID} | DSN ${label} rejected (non-fatal):`, err?.message ?? err)
    );
  } catch (err) {
    console.warn(`${MODULE_ID} | DSN ${label} threw (non-fatal):`, err?.message ?? err);
  }
}

/**
 * awaitDiceSettle — pause briefly so the 3D dice animation can finish
 * before the next chat card posts.
 *
 * Solves a polish bug: result cards (attack hit/miss, damage totals,
 * save outcomes, sever results) were appearing in chat at the SAME TIME
 * as the dice were still tumbling, which made the table see the answer
 * before the dice settled — anti-climactic. This helper inserts a small
 * delay between the dice show and the chat card post.
 *
 * IMPORTANT: this is a fixed-time delay, NOT an await of the DSN promise.
 * Awaiting DSN directly caused a production hang in v0.4.21 when the GM's
 * DSN renderer was broken (the promise never resolved). A fixed timer is
 * immune to renderer breakage — it always resolves cleanly.
 *
 *   - No DSN installed / DSN disabled → no wait (returns immediately)
 *   - DSN running                     → wait the configured duration
 *
 * Default 1800ms covers a typical d20 roll's settle time. Complex multi-
 * die rolls (8d6 fireball) may need a touch longer; pass a higher maxMs.
 *
 * @param {number} [maxMs=1800] — milliseconds to wait
 * @returns {Promise<void>}
 */
export async function awaitDiceSettle(maxMs = 1800) {
  try {
    if (!game?.dice3d?.isEnabled?.()) return;
  } catch (_) { return; }
  return new Promise(resolve => setTimeout(resolve, maxMs));
}
