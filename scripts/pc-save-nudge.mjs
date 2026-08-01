// ─── ACE: QOL — "Player hasn't rolled" GM nudge ───────────────────────────────
// THE one place ACE handles "we are waiting on a human being".
//
// The rule (Johnny, standing): a connected player's dice are THEIRS. ACE never
// auto-rolls a save for a player who is online — it waits, indefinitely, for
// them to press their own button. But a player can walk away, and the table
// should not be held hostage by an empty chair. So after a grace period the GM
// — and only the GM — gets a small whispered card naming who we're waiting on,
// with a ROLL FOR THEM button.
//
// WHY THIS FILE EXISTS (2026-07-28). That behaviour was built once, inside
// repeating-save-engine.mjs, for repeating saves only — and then described as
// though it covered every save. It didn't. The MAIN save flow posted its player
// prompts and waited forever with no timer at all, so an ordinary spell save
// against two logged-in players simply hung, with no way to hand it back to the
// GM. Johnny sat there for two minutes waiting for a nudge that was never
// wired. Building the same behaviour twice is how that happens, so it is built
// ONCE here and every waiting path calls it.
//
// The engines differ in how they finish a save — the repeating engine resolves
// a socket promise, the main engine rolls on the GM's behalf — so each supplies
// its own callback. The timer, the card, the button and the retirement are
// shared, which is the part that was diverging.
// ──────────────────────────────────────────────────────────────────────────────

import { MODULE_ID } from "./ace-qol.mjs";

export class PcSaveNudge {

  /** How long a player gets before the GM is offered the roll. */
  static DELAY_MS = 30000;

  /** key → { timer, callback, context } — GM-client only; the GM is who clicks. */
  static _pending = new Map();

  /**
   * Keys the GM resolved by pressing ROLL FOR THEM.
   *
   * Needed because the GM's roll goes on to post a normal save result, which
   * fires the same "player rolled" path a real player roll does — so the result
   * handler would come along afterwards and stamp the card
   * "The player rolled it themselves." They didn't; the GM did. Claiming
   * otherwise on a card the GM is reading is worse than saying nothing.
   * (Johnny 2026-07-28: "They didn't roll it themselves. I did.")
   */
  static _gmResolved = new Map();   // key → target name, kept briefly after the click

  static _wired = false;

  /** Register the ROLL FOR THEM button handler. Idempotent. */
  static init() {
    if (PcSaveNudge._wired) return;
    PcSaveNudge._wired = true;

    const onRender = (message, html) => {
      if (message?.flags?.[MODULE_ID]?.type !== "pcSaveNudge") return;
      const el = html instanceof HTMLElement ? html : html?.[0] ?? html;
      const btn = el?.querySelector?.("[data-action='ace-nudge-roll']");
      if (!btn || btn.dataset.aceWired) return;
      btn.dataset.aceWired = "1";
      btn.addEventListener("click", async (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        const key = btn.dataset.key;
        btn.disabled = true;
        btn.innerHTML = `<i class="fas fa-hourglass-half"></i> ROLLING…`;
        const entry = PcSaveNudge._pending.get(key);
        if (!entry?.callback) {
          // The GM reloaded, or the save already settled — the in-memory
          // callback is gone. Say so plainly instead of dying silently.
          ui.notifications?.warn("That save is no longer pending (or this client reloaded). Roll it from the save card.");
          await PcSaveNudge.disarm(key, "No longer pending.");
          return;
        }
        try {
          // Claim it BEFORE rolling — the roll posts a save result, which trips
          // the result handler's disarm before this line would ever run.
          PcSaveNudge._gmResolved.set(key, entry.context?.targetName ?? "");
          // Forget the claim once every disarm for this save has gone through,
          // so the map can't grow across a long session.
          setTimeout(() => PcSaveNudge._gmResolved.delete(key), 30000);
          await entry.callback();
          await PcSaveNudge.disarm(key, `${entry.context?.targetName ?? "Target"}'s save was rolled by the GM.`);
        } catch (err) {
          PcSaveNudge._gmResolved.delete(key);
          console.error(`${MODULE_ID} | ROLL FOR THEM failed:`, err);
          ui.notifications?.error("Rolling that save failed — see console.");
          btn.disabled = false;
          btn.innerHTML = `<i class="fas fa-dice-d20"></i> ROLL FOR THEM`;
        }
      });
    };
    Hooks.on("renderChatMessageHTML", onRender);
    Hooks.on("renderChatMessage", onRender);

    console.debug(`${MODULE_ID} | PC save nudge online — every waiting save hands back to the GM after ${PcSaveNudge.DELAY_MS / 1000}s`);
  }

  /**
   * Start waiting on a player. Safe to call from any client — only the active
   * GM actually arms a timer, since the GM is who the card is for.
   *
   * @param {object}   o
   * @param {string}   o.key          Unique id for this wait (cast id + token id).
   * @param {string}   o.targetName   The creature that must save.
   * @param {string}   o.playerName   The human being we're waiting on.
   * @param {string}   o.abilityLabel e.g. "Dexterity"
   * @param {number}   o.dc
   * @param {string}   [o.sourceName] The spell/ability name.
   * @param {Function} o.onRoll       Called when the GM presses ROLL FOR THEM.
   */
  static arm({ key, targetName, playerName, abilityLabel, dc, sourceName = "", onRoll }) {
    try {
      if (!key || typeof onRoll !== "function") return;
      if (game.users?.activeGM !== game.user) return;   // only the GM waits
      if (PcSaveNudge._pending.has(key)) return;        // already armed

      const context = { targetName, playerName, abilityLabel, dc, sourceName };
      const timer = setTimeout(() => {
        PcSaveNudge._postCard(key).catch(err =>
          console.warn(`${MODULE_ID} | nudge card failed (non-fatal):`, err));
      }, PcSaveNudge.DELAY_MS);

      PcSaveNudge._pending.set(key, { timer, callback: onRoll, context });
    } catch (err) {
      console.warn(`${MODULE_ID} | nudge arm failed (non-fatal):`, err);
    }
  }

  /** The player rolled (or the save resolved some other way) — stand down. */
  static async disarm(key, note = "") {
    try {
      const entry = PcSaveNudge._pending.get(key);
      if (entry?.timer) clearTimeout(entry.timer);
      PcSaveNudge._pending.delete(key);

      // If the GM pressed the button, the truth is "the GM rolled it" — no
      // matter what the caller thinks happened. The result handler fires on
      // the GM's roll too and would otherwise overwrite the card with a claim
      // the GM can see is false.
      let final = note;
      if (PcSaveNudge._gmResolved.has(key)) {
        const target = PcSaveNudge._gmResolved.get(key) || entry?.context?.targetName || "";
        final = target ? `${target}'s save was rolled by the GM.` : "Rolled by the GM.";
      }
      if (final) await PcSaveNudge._retireCard(key, final);
    } catch (err) {
      console.warn(`${MODULE_ID} | nudge disarm failed (non-fatal):`, err);
    }
  }

  /** Cancel every outstanding wait (scene change, combat end, reload cleanup). */
  static disarmAll() {
    for (const [, entry] of PcSaveNudge._pending) {
      if (entry?.timer) clearTimeout(entry.timer);
    }
    PcSaveNudge._pending.clear();
  }

  // ═══════════════════════════════════════════════════════════════════════════

  static async _postCard(key) {
    const entry = PcSaveNudge._pending.get(key);
    if (!entry) return;                       // rolled during the grace period
    const c = entry.context ?? {};
    const source = c.sourceName ? `<b>${foundry.utils.escapeHTML(c.sourceName)}</b> — ` : "";
    const html = `
      <div class="ace-qol-nudge">
        <div class="ace-qol-nudge-head">
          <i class="fas fa-hourglass-half"></i> ${source}waiting on ${foundry.utils.escapeHTML(c.playerName ?? "a player")}
        </div>
        <div class="ace-qol-nudge-body">
          <b>${foundry.utils.escapeHTML(c.targetName ?? "Target")}</b> hasn't rolled their
          ${foundry.utils.escapeHTML(c.abilityLabel ?? "")} save (DC ${c.dc ?? "?"}) yet.
        </div>
        <button type="button" class="ace-qol-nudge-btn" data-action="ace-nudge-roll" data-key="${key}">
          <i class="fas fa-dice-d20"></i> ROLL FOR THEM
        </button>
      </div>`;
    await ChatMessage.create({
      content: html,
      whisper: ChatMessage.getWhisperRecipients("GM").map(u => u.id),
      flags: { [MODULE_ID]: { type: "pcSaveNudge", nudgeKey: key } },
    });
  }

  /** Retire a posted card so a stale button can never imply it's still live. */
  static async _retireCard(key, note) {
    try {
      const msg = game.messages?.contents?.slice(-50).reverse()
        .find(m => m.flags?.[MODULE_ID]?.type === "pcSaveNudge"
                && m.flags?.[MODULE_ID]?.nudgeKey === key);
      if (!msg) return;
      await msg.update({
        content: `<div class="ace-qol-nudge"><div class="ace-qol-nudge-body">
          <i class="fas fa-check"></i> ${foundry.utils.escapeHTML(note)}</div></div>`,
      });
    } catch (err) {
      console.warn(`${MODULE_ID} | couldn't retire nudge card (non-fatal):`, err);
    }
  }
}
