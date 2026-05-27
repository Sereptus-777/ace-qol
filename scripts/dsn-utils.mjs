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
