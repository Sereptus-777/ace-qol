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
/**
 * Animations currently in flight. `showForRoll` returns a promise that DSN
 * itself resolves when the dice finish tumbling — that promise IS the true
 * "dice have landed" signal, so we keep hold of every one and let
 * awaitDiceSettle wait on them. Entries remove themselves on settle, so this
 * is empty whenever nothing is rolling.
 */
const _inFlight = new Set();

export function safeShowForRoll(roll, label = "dice animation") {
  if (!roll) return;
  try {
    const p = game.dice3d?.showForRoll?.(roll, game.user, true);
    if (p && typeof p.then === "function") {
      // Track it so a card post can wait for THESE dice specifically rather
      // than guessing at a duration.
      _inFlight.add(p);
      const drop = () => _inFlight.delete(p);
      p.then(drop, drop);
      p.catch?.(err =>
        console.warn(`${MODULE_ID} | DSN ${label} rejected (non-fatal):`, err?.message ?? err)
      );
    }
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
 * HOW IT WAITS (this comment used to describe a fixed timer — it isn't one):
 * DSN's showForRoll returns a promise IT resolves when the dice stop tumbling.
 * safeShowForRoll keeps every one, so we wait on the ACTUAL animations, plus
 * DSN's diceSoNiceRollComplete hook for rolls that came in via a chat message.
 * Then `graceMs` so the last die stops visibly wobbling. Land in 900ms → the
 * card posts at 1400ms. No guessed duration anywhere.
 *
 * `maxMs` is a CEILING, not a wait. Awaiting DSN unguarded hung the whole
 * damage pipeline in v0.4.21 when a renderer broke and its promise never
 * resolved; the race makes that impossible — as long as the dice need, never
 * forever.
 *
 *   - No DSN installed / DSN disabled → returns immediately, no wait
 *   - Dice in flight                  → waits for them, then graceMs
 *   - Nothing in flight               → ~120ms probe, then graceMs
 *
 * ⚠️ Only rolls fired through safeShowForRoll are registered. A raw
 * game.dice3d.showForRoll call leaves this with nothing to wait on and the
 * card can beat its own dice. Six such sites were found and closed in 0.7.369
 * — if you add a seventh, this stops working for that roll silently.
 *
 * @param {number}  [maxMs=3000]        — ceiling, not a delay
 * @param {string}  [opts.messageId]    — only honour the hook for this message
 * @param {number}  [opts.graceMs=500]  — settle beat after the dice land
 * @returns {Promise<void>}
 */
export async function awaitDiceSettle(maxMs = 3000, { messageId = null, graceMs = 500 } = {}) {
  try {
    if (!game?.dice3d?.isEnabled?.()) return;
  } catch (_) { return; }

  // ── EVENT-BASED, NOT A GUESSED DELAY (2026-07-28) ──
  // This was a flat setTimeout: every card waited exactly 1800ms whether the
  // dice had landed or not. A slow renderer, a big handful of dice, or a
  // player's screen a beat behind the GM's and the card beat the dice to the
  // punch — the answer arriving before the roll, which is the one thing a
  // dice roll must never do. Fourth report from Johnny.
  //
  // Now we WAIT FOR THE DICE and cap it. `diceSoNiceRollComplete` fires when
  // the animation finishes; a beat of grace after that lets the last die stop
  // visibly wobbling. The cap exists because awaiting DSN unconditionally hung
  // the pipeline in v0.4.21 when a renderer broke — a timer can't hang, so the
  // race gives us "as long as it needs, never forever".
  // THE REAL SIGNAL: DSN's showForRoll returns a promise it resolves when the
  // dice have finished tumbling. safeShowForRoll keeps every one, so here we
  // simply wait for the actual animations to finish — no guessed duration.
  // The `diceSoNiceRollComplete` hook is a second signal for rolls that came
  // in through a chat message (which carry an id) rather than through us.
  const settled = new Promise((resolve) => {
    let done = false;
    let hookId = null;
    const finish = () => {
      if (done) return;
      done = true;
      try { if (hookId != null) Hooks.off("diceSoNiceRollComplete", hookId); } catch (_) {}
      // A beat of grace so the last die stops visibly wobbling before the
      // answer appears.
      setTimeout(resolve, graceMs);
    };

    // 1. Wait on the animations we started ourselves.
    const live = [..._inFlight];
    if (live.length) {
      Promise.allSettled(live).then(finish);
    }

    // 2. Also honour the completion hook (message-driven rolls).
    try {
      hookId = Hooks.on("diceSoNiceRollComplete", (completedId) => {
        if (messageId && completedId && completedId !== messageId) return;
        finish();
      });
    } catch (_) { /* listener failed → the cap below still resolves */ }

    // 3. Nothing in flight and no hook fired → nothing to wait for.
    if (!live.length) setTimeout(() => { if (!done) finish(); }, 120);
  });

  // A renderer that breaks mid-animation never resolves its promise and hung
  // the whole pipeline in v0.4.21. The cap makes that impossible: we wait as
  // long as the dice need, but never forever.
  //
  // ⚠️ THE CAP DEPENDS ON WHETHER WE HAVE A REAL SIGNAL (2026-08-21).
  // With live showForRoll promises in hand we KNOW dice are tumbling and we
  // know we will be told when they stop, so a 3-second cap is not a safety net
  // - it is a deadline that fires while the dice are still on screen. A big
  // damage handful on a slow renderer takes longer than that, and then the card
  // beats the dice, which is the one thing a roll must never do. Johnny asked
  // for "an actual check that the dice have stopped rolling, not a delay", and
  // this is where the delay was hiding.
  //
  // So: real promises in flight -> a long backstop that only catches a broken
  // renderer. Nothing in flight -> the short cap, because there is nothing to
  // wait for and the hook may never come.
  const hadRealSignal = _inFlight.size > 0;
  const capMs = hadRealSignal
    ? Math.max(15000, Number(maxMs) || 3000)
    : Math.max(250, Number(maxMs) || 3000);
  const cap = new Promise(resolve => setTimeout(() => {
    if (hadRealSignal) {
      console.warn(`${"ace-qol"} | dice never reported finishing after ${capMs}ms - releasing. ` +
        `If cards are beating the dice, the Dice So Nice renderer is the place to look.`);
    }
    resolve();
  }, capMs));
  return Promise.race([settled, cap]);
}
