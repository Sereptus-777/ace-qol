// ─── ACE: QOL — A card waits for the dice on the screen that threw them ─────
//
// Johnny, 2026-09-19: "CHAT AFTER DICE. On the rolling client's screen, no
// public card (save result, damage, "hit dice") until diceSoNiceRollComplete
// on that client. If Dice So Nice is off, post when the total exists."
//
// A card this screen posts itself already waits for this screen's dice
// (dsn-utils, awaitDiceSettle). What that cannot stop is a card ANOTHER screen
// posts arriving here while this screen's own dice are in the air. His table,
// 13:29 on 2026-09-19: Aryel's box opened at 13:29:08.9, the GM's screen rolled
// the NPC saves and posted the Fireball's results card at 13:29:15.7, and
// Aryel's own save posted at 13:29:19.9. The results card landed on her screen
// while she was rolling.
//
// So on a screen that threw dice, a NEW public ACE card is held out of sight
// until those dice have landed, then shown. Nothing is held when Dice So Nice
// is off (no dice are thrown, so none are in flight) or when this screen has
// nothing rolling. A card already on screen that redraws is left alone, so
// nothing blinks out.
//
// ⚠️ LEAVES ONLY. Both imports are leaves, so no import cycle reaches here.
// ──────────────────────────────────────────────────────────────────────────────

import { registerChatCardHandler } from "./chat-render-utils.mjs";
import { diceInFlight, awaitDiceSettle } from "./dsn-utils.mjs";

const MODULE_ID = "ace-qol";
const LOG = "ace-qol | dice first";
const HELD = "ace-qol-held-for-dice";

/** Messages this screen has drawn before: only a new card is held. */
const _seen = new Set();
/** messageId → the landing its card is waiting for (the log copy and the notification copy share it). */
const _holds = new Map();

/**
 * Decide for one drawn card: show it, or hold it until this screen's dice land.
 * Exported for the self-test; the render hook below is its only caller in play.
 *
 * @param {ChatMessage} message
 * @param {HTMLElement} li   the drawn card
 * @returns {Promise<void>|null} the landing it waits for, or null when shown at once
 */
export function holdForDice(message, li) {
  const id = message?.id;
  if (!id || !li) return null;
  // ACE's own cards, and only the ones the whole table sees.
  if (!message.flags?.[MODULE_ID]) { _seen.add(id); return null; }
  if ((message.whisper?.length ?? 0) > 0) { _seen.add(id); return null; }

  let hold = _holds.get(id) ?? null;
  if (!hold && !_seen.has(id) && diceInFlight()) {
    const what = message.flags[MODULE_ID].type ?? "an ACE card";
    console.log(`${LOG} | "${what}" arrived while this screen's dice are still rolling; it shows when they land.`);
    hold = awaitDiceSettle().finally(() => _holds.delete(id));
    _holds.set(id, hold);
  }
  _seen.add(id);
  if (!hold) return null;

  li.classList?.add?.(HELD);
  hold.then(() => {
    // Keep the log at the bottom if it was there while the card was hidden.
    let atBottom = false;
    try { atBottom = !!globalThis.ui?.chat?.isAtBottom; } catch (_) { atBottom = false; }
    li.classList?.remove?.(HELD);
    if (atBottom) {
      try { globalThis.ui?.chat?.scrollBottom?.({ popout: false }); } catch (_) { /* scrolling is a courtesy */ }
    }
  });
  return hold;
}

/** Register the hold on every ACE card this screen draws. */
export function registerCardsWaitForDice() {
  registerChatCardHandler((message, html) => {
    try {
      const el = html instanceof HTMLElement ? html : (html?.[0] ?? html);
      const li = el?.closest?.(".chat-message") ?? el;
      holdForDice(message, li);
    } catch (err) {
      // A card that could not be held is shown, never lost.
      console.warn(`${LOG} | could not hold a card for this screen's dice; it shows now:`, err);
    }
  }, "cards that wait for this screen's dice");
}

export const _test = { HELD, _seen, _holds };
