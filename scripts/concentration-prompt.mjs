// ─── ACE: QOL — Concentration: one check for each hit, asked in the roll box ──
//
// Johnny, 2026-09-19: "CONCENTRATION. One check per damage event. Button dies
// after the roll. Same d20 widget as the save popout." And the rule over all of
// it: "Chat keeps the results. The player who must roll gets a popout."
//
// WHAT IT WAS. Every hit on a concentrating character posted a PUBLIC card with
// a ROLL CONCENTRATION SAVE button, and the button remembered nothing. A roll
// greyed it out on the one screen that clicked it, and only until that card was
// drawn again; on every other screen (the GM's, the player's) it stayed live.
// So a second click on the same card rolled a second save for the same hit, and
// the second roll could end the spell the first one had kept.
//
// WHAT IT IS. Each hit is one prompt, and the prompt's own flag says whether it
// has been rolled. It is written as the answering player's own card, whispered
// to them alone (who-answers.mjs, the one rule every prompt asks), and their
// screen opens the roll box: the ding, the blinking d20 and pill, one click. The
// roll goes through ACE's check (CheckGate.run), which ends concentration on a
// failure in its one listener and posts the result card for the table. The
// prompt is marked rolled BEFORE the dice are thrown, so a second press on any
// screen, after a reload, or from the GM's ROLL FOR THEM finds it spent.
//
// With no connected player to ask (an NPC, or a character whose player is not
// here) nobody is waited on: it rolls at once, as the save engine does for an
// absent player.
//
// ⚠️ LEAVES ONLY AT LOAD. The damage door calls this, so the two modules that
// reach back into the rest of ACE (the card door, the GM nudge) are imported
// when a check happens, never at the top, and no import cycle can reach a
// top-level line (the 2026-08-28 lesson).
// ──────────────────────────────────────────────────────────────────────────────

import { registerChatCardHandler } from "./chat-render-utils.mjs";
import { RollPopout } from "./roll-popout.mjs";
import { popupDing } from "./popup-ding.mjs";
import { whoAnswers } from "./who-answers.mjs";
import { aceD20FaceImg } from "./dice-face.mjs";
import { CheckGate } from "./check-gate.mjs";
import { buttonFor as luckButtonFor, pressButton as luckPressButton } from "./luck.mjs";

// Hardcoded rather than imported, for the same reason as check-gate.mjs.
const MODULE_ID = "ace-qol";
const LOG = "ace-qol | concentration";
export const CONCENTRATION_PROMPT = "concentrationPrompt";
const ACCENT = "#ab47bc";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c]));

/** The creature's concentration effect, the one a hit tests. */
function concEffectOf(actor) {
  return actor?.effects?.find?.(e => !e?.disabled
    && (e.statuses?.has?.("concentration") || e.statuses?.has?.("concentrating"))) ?? null;
}

/** The spell being held, in words: dnd5e keeps it on the effect. */
function spellNameOf(effect) {
  try {
    const n = effect?.getFlag?.("dnd5e", "item")?.name;
    if (n) return String(n);
  } catch (_) { /* fall back to the effect's own name */ }
  return String(effect?.name ?? "a spell");
}

function actorOf(f) {
  try { return f?.actorUuid ? (globalThis.fromUuidSync?.(f.actorUuid) ?? null) : null; }
  catch (_) { return null; }
}

function artOf(actor) {
  return actor?.token?.texture?.src ?? actor?.getActiveTokens?.()?.[0]?.document?.texture?.src
    ?? actor?.img ?? "icons/svg/mystery-man.svg";
}

export class ConcentrationPrompt {
  /** Prompts this screen gave back to the chat (the box closed without a roll). */
  static _inChat = new Set();
  /** Prompts this screen is rolling right now, so a double click is one roll. */
  static _rolling = new Set();
  static _wired = false;

  static init() {
    if (ConcentrationPrompt._wired) return;
    ConcentrationPrompt._wired = true;

    // + sweeps cards drawn before this registered, which is how a check still
    // waiting after a reload opens its box again.
    registerChatCardHandler((message, html) => ConcentrationPrompt._onRender(message, html), "concentration prompts");

    Hooks.on("createChatMessage", (message) => {
      if (message?.flags?.[MODULE_ID]?.type !== CONCENTRATION_PROMPT) return;
      try { ConcentrationPrompt._open(message); }
      catch (err) { console.warn(`${LOG} | the box could not open for a new check:`, err); }
    });

    // Rolled anywhere: the box closes, and the GM's nudge for it stands down.
    Hooks.on("updateChatMessage", (message) => {
      const f = message?.flags?.[MODULE_ID];
      if (f?.type !== CONCENTRATION_PROMPT || f.status === "pending") return;
      if (game.user?.isGM) ConcentrationPrompt._disarm(message.id, "It was rolled.");
      // The screen rolling it closes its own box once the dice have landed.
      if (ConcentrationPrompt._rolling.has(message.id)) return;
      RollPopout.closeWhere((m, key) => key === message.id, `${f.spellName ?? "the"} concentration check was rolled`);
    });
    Hooks.on("deleteChatMessage", (message) => {
      if (message?.flags?.[MODULE_ID]?.type !== CONCENTRATION_PROMPT) return;
      RollPopout.closeWhere((m, key) => key === message.id, "its prompt was deleted");
      if (game.user?.isGM) ConcentrationPrompt._disarm(message.id, "Its prompt was deleted.");
    });
    console.debug(`${LOG} | concentration checks ask in the roll box`);
  }

  /**
   * One hit on a concentrating creature: its one check.
   *
   * @param {Actor} actor
   * @param {object} o
   * @param {number} o.damage  the whole hit, before temporary hit points (RAW)
   * @param {number} o.dc      worked out by dnd5e's own rule for this edition
   * @param {ActiveEffect} [o.effect]
   * @returns {Promise<{asked: boolean, rolled?: boolean, messageId?: string, why: string}>}
   */
  static async ask(actor, { damage, dc, effect = null } = {}) {
    const conc = effect ?? concEffectOf(actor);
    if (!actor || !conc) return { asked: false, why: "it is not concentrating" };
    const spellName = spellNameOf(conc);
    const who = whoAnswers(actor);

    if (!who.isPlayer || !who.user) {
      // Nobody to wait on. The check rolls now, exactly as a player's would.
      console.log(`${LOG} | ${actor.name} took ${damage} while concentrating on ${spellName}: `
        + `${who.why}, so its check (DC ${dc}) rolls now.`);
      const roll = await ConcentrationPrompt._rollCheck(actor, dc, "suggested");
      return { asked: false, rolled: !!roll, why: who.why };
    }

    const me = game.user;
    const data = {
      speaker: ChatMessage.getSpeaker({ actor, token: actor.token ?? undefined }),
      content: ConcentrationPrompt._cardHtml(actor, spellName),
      whisper: [who.user.id],
      flags: { [MODULE_ID]: {
        type: CONCENTRATION_PROMPT, status: "pending",
        actorUuid: actor.uuid, effectId: conc.id, dc, damage, spellName,
        answererId: who.user.id,
      } },
    };
    // ⚠️ WRITTEN AS THE PLAYER'S OWN CARD. Foundry draws a whisper for its
    // author too, so a card the GM's screen writes is the GM's card whatever the
    // list says (the 2026-09-18 lesson). As its author the player can also mark
    // it rolled. A GM may set the author; a player's screen may only write its own.
    if (me.isGM || who.user.id === me.id) data.author = who.user.id;
    else data.whisper = [who.user.id, me.id];

    const { CardDoor } = await import("./road/doors.mjs");
    const msg = await CardDoor.post(data);
    console.log(`${LOG} | ${actor.name} took ${damage} while concentrating on ${spellName}: `
      + `DC ${dc}, asked of ${who.user.name} (${who.why}).`);

    // The GM gets ROLL FOR THEM if nobody rolls it: the one nudge every roll
    // that waits on a person shares (pc-save-nudge.mjs).
    if (me.isGM && msg?.id) {
      try {
        const { PcSaveNudge } = await import("./pc-save-nudge.mjs");
        PcSaveNudge.arm({
          key: `conc:${msg.id}`,
          targetName: actor.token?.name ?? actor.name,
          playerName: who.user.name,
          abilityLabel: "Concentration",
          dc,
          sourceName: spellName,
          onRoll: () => ConcentrationPrompt.roll(game.messages.get(msg.id) ?? msg, { choice: "suggested" }),
        });
      } catch (err) {
        console.warn(`${LOG} | could not arm the GM's roll-for-them for ${actor.name}'s check:`, err);
      }
    }
    return { asked: true, messageId: msg?.id ?? null, why: who.why };
  }

  /**
   * Roll this hit's check, once.
   *
   * @param {ChatMessage} message   the prompt
   * @param {object} [o]
   * @param {"suggested"|"advantage"|"normal"|"disadvantage"} [o.choice]
   * @returns {Promise<Roll|null>}
   */
  static async roll(message, { choice = "suggested" } = {}) {
    const f = message?.flags?.[MODULE_ID];
    if (f?.type !== CONCENTRATION_PROMPT) return null;
    // ⚠️ THE BUTTON DIES AFTER THE ROLL (his rule). A spent check refuses, on
    // every screen, and says so rather than rolling a second save for one hit.
    if (f.status !== "pending" || ConcentrationPrompt._rolling.has(message.id)) {
      console.log(`${LOG} | a second press on the ${f.spellName ?? ""} check was refused: it was already rolled.`);
      ui.notifications?.info("That concentration check has already been rolled.");
      return null;
    }
    const actor = actorOf(f);
    if (!actor) {
      ui.notifications?.warn("ACE: the creature for that concentration check is gone.");
      return null;
    }
    if (!(actor.isOwner || game.user?.isGM)) {
      ui.notifications?.warn(`That concentration check is for ${actor.name}, which is not yours to roll.`);
      return null;
    }

    ConcentrationPrompt._rolling.add(message.id);
    try {
      // Spent BEFORE the dice are thrown, so a second press anywhere finds it spent.
      await ConcentrationPrompt._mark(message, "rolled");
      const stillHolding = !!actor.effects?.get?.(f.effectId) || (actor.concentration?.effects?.size ?? 0) > 0;
      if (!stillHolding) {
        await ConcentrationPrompt._mark(message, "ended");
        console.log(`${LOG} | ${actor.name} is no longer concentrating on ${f.spellName}; nothing to roll.`);
        ui.notifications?.info(`${actor.name} is no longer concentrating, so there is nothing to roll.`);
        return null;
      }
      const roll = await ConcentrationPrompt._rollCheck(actor, Number(f.dc), choice);
      if (!roll) {
        // Nothing rolled (a fault, said where it happened): the check is still owed.
        await ConcentrationPrompt._mark(message, "pending");
        return null;
      }
      return roll;
    } finally {
      ConcentrationPrompt._rolling.delete(message.id);
    }
  }

  /** ACE's own check: its outcome listener ends a failed concentration and its card shows the dice. */
  static async _rollCheck(actor, dc, choice) {
    try {
      return await CheckGate.run(actor, "concentration", "con", { dc, choice });
    } catch (err) {
      console.error(`${LOG} | ${actor?.name}'s concentration check could not roll:`, err);
      ui.notifications?.error(`${actor?.name ?? "A creature"}'s concentration check could not roll. `
        + `Concentration was left as it was; the console has why.`);
      return null;
    }
  }

  /** Write the prompt's state where every screen reads it. */
  static async _mark(message, status) {
    try {
      await message.update({ [`flags.${MODULE_ID}.status`]: status,
        [`flags.${MODULE_ID}.by`]: game.user?.id ?? null });
      return true;
    } catch (err) {
      // Still guarded on this screen by the rolling set; the log says why the
      // other screens were not told.
      console.warn(`${LOG} | could not mark the concentration check "${status}" for every screen:`, err);
      return false;
    }
  }

  static _disarm(messageId, note) {
    import("./pc-save-nudge.mjs")
      .then(({ PcSaveNudge }) => PcSaveNudge.disarm(`conc:${messageId}`, note))
      .catch(err => console.warn(`${LOG} | could not stand the GM's nudge down:`, err));
  }

  /** Is this screen the one that answers this prompt? */
  static _answersHere(f) {
    const actor = actorOf(f);
    if (!actor) return false;
    return whoAnswers(actor).user?.id === game.user?.id;
  }

  /**
   * Open the roll box for a check still waiting, on the screen that answers
   * it, once. Returns whether a box is open for it.
   */
  static _open(message) {
    try {
      const f = message?.flags?.[MODULE_ID];
      if (f?.type !== CONCENTRATION_PROMPT || f.status !== "pending") return false;
      const key = message.id;
      if (RollPopout.isOpen(key)) return true;
      if (ConcentrationPrompt._inChat.has(key)) return false;
      const actor = actorOf(f);
      if (!actor || !ConcentrationPrompt._answersHere(f)) return false;

      // What the creature itself brings to the roll (War Caster, an effect),
      // and the 2024 Lucky button, spent before it.
      let mode = "suggested";
      let lucky = null;
      try {
        const luck = luckButtonFor(actor);
        if (luck) {
          const hasDisadvantage = CheckGate.read(actor, "concentration", "con")?.mode < 0;
          lucky = {
            label: `Lucky: ${hasDisadvantage ? "cancel Disadvantage" : "Advantage"} (${luck.left} left)`,
            spentLabel: `Luck spent: this check rolls with ${hasDisadvantage ? "Disadvantage cancelled" : "Advantage"}`,
            onPress: async () => {
              const m = await luckPressButton(actor, { hasDisadvantage });
              if (!m) return false;
              mode = m;
              return true;
            },
          };
        }
      } catch (err) {
        console.warn(`${LOG} | could not read ${actor.name}'s Lucky feat for the box:`, err);
      }

      const opened = RollPopout.open({
        key,
        kind: "concentration",
        title: "Concentration",
        line: `You were hit while concentrating on ${f.spellName ?? "your spell"}.`,
        rollerName: actor.token?.name ?? actor.name,
        rollerImg: artOf(actor),
        pillLabel: "Roll Concentration",
        accent: "#c07ad0",
        match: { kind: "concentration", messageId: key },
        lucky,
        onRoll: async () => {
          const now = game.messages?.get?.(key) ?? message;
          const r = await ConcentrationPrompt.roll(now, { choice: mode });
          // Still owed after a fault: the box stays, its buttons live again.
          if (!r && game.messages?.get?.(key)?.flags?.[MODULE_ID]?.status === "pending") {
            throw new Error(`${actor.name}'s concentration check did not roll`);
          }
        },
        onDismiss: async () => ConcentrationPrompt._giveToChat(message),
      });
      if (!opened) {
        // No box: the card in the chat is the prompt, and it asks out loud.
        ConcentrationPrompt._giveToChat(message);
        popupDing(`${actor.name}'s concentration check (in the chat)`);
      }
      return opened;
    } catch (err) {
      console.warn(`${LOG} | the concentration box could not open; the check stays in the chat:`, err);
      ConcentrationPrompt._giveToChat(message);
      popupDing("a concentration check (in the chat)");
      return false;
    }
  }

  /** The box closed without a roll, or could not open: the check goes to the chat, wired. */
  static _giveToChat(message) {
    try {
      const f = message?.flags?.[MODULE_ID];
      const now = game.messages?.get?.(message?.id)?.flags?.[MODULE_ID] ?? f;
      if (now?.status !== "pending") return;
      ConcentrationPrompt._inChat.add(message.id);
      for (const li of document.querySelectorAll(`.chat-message[data-message-id="${message.id}"]`)) {
        li.classList.remove("ace-qol-save-collapsed");
        ConcentrationPrompt._wire(li, message);
      }
      ui.notifications?.info("ACE: your concentration check is waiting in the chat.");
    } catch (err) {
      console.warn(`${LOG} | could not put a concentration check back in the chat:`, err);
    }
  }

  static _onRender(message, html) {
    const f = message?.flags?.[MODULE_ID];
    if (f?.type !== CONCENTRATION_PROMPT) return;
    const el = html instanceof HTMLElement ? html : (html?.[0] ?? html);
    const li = el?.closest?.(".chat-message") ?? el;
    // The chat keeps the results: a prompt is folded away on every screen,
    // and a spent one stays folded (ACE's check card is its result).
    li?.classList?.add?.("ace-qol-save-collapsed");
    if (f.status !== "pending") return;
    if (!ConcentrationPrompt._inChat.has(message.id)) {
      if (ConcentrationPrompt._open(message)) return;
      if (!ConcentrationPrompt._inChat.has(message.id)) return;
    }
    li?.classList?.remove?.("ace-qol-save-collapsed");
    ConcentrationPrompt._wire(el, message);
  }

  /** The card's own die and pill: one roll, and dead from the press on. */
  static _wire(el, message) {
    const btns = [...(el?.querySelectorAll?.("[data-action='aceQolConcPromptRoll']") ?? [])];
    for (const b of btns) {
      if (b.dataset.aceWired === "1") continue;
      b.dataset.aceWired = "1";
      b.addEventListener("click", async (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        for (const x of btns) x.disabled = true;
        const pill = btns.find(x => x.classList.contains("ace-qol-roll-pill"));
        if (pill) pill.innerHTML = '<i class="fas fa-spinner fa-spin"></i> <span>Rolling…</span>';
        const roll = await ConcentrationPrompt.roll(game.messages?.get?.(message.id) ?? message, { choice: "suggested" });
        if (!roll && (game.messages?.get?.(message.id)?.flags?.[MODULE_ID]?.status === "pending")) {
          for (const x of btns) x.disabled = false;
          if (pill) pill.innerHTML = '<i class="fas fa-dice-d20"></i> <span>Roll Concentration</span>';
        }
      });
    }
  }

  /** The chat card: the same d20 and pill as the box, for when the box is not open. */
  static _cardHtml(actor, spellName) {
    const img = artOf(actor);
    const name = actor.token?.name ?? actor.name;
    return `
      <div class="ace-qol-pc-save-card ace-qol-conc-prompt" style="background:#0c0c10;border:1px solid ${ACCENT};border-radius:9px;overflow:hidden;font-family:'Signika',sans-serif;">
        <div style="padding:11px 15px;border-bottom:1px solid rgba(171,71,188,0.35);">
          <div style="color:#f0e4c0;font-weight:700;font-size:19px;line-height:1.15;">Concentration</div>
          <div style="color:#d9b3e6;font-size:15px;font-weight:600;margin-top:3px;">${esc(spellName)}</div>
        </div>
        <div style="display:flex;align-items:center;flex-wrap:wrap;gap:15px;padding:15px;">
          <div style="display:flex;flex-direction:column;align-items:center;gap:8px;flex-shrink:0;">
            <img src="${esc(img)}" style="width:54px;height:54px;border-radius:8px;border:1px solid ${ACCENT};object-fit:cover;" />
            <button type="button" class="ace-qol-btn" data-action="aceQolConcPromptRoll" title="Roll Concentration"
                    style="background:none;border:none;cursor:pointer;padding:0;display:inline-flex;">
              ${aceD20FaceImg(20, { size: 46, glow: true })}
            </button>
          </div>
          <div style="flex:1;min-width:0;">
            <div style="color:#fff;font-weight:700;font-size:18px;line-height:1.2;">${esc(name)}</div>
            <div style="color:#cdbf8f;font-size:16px;margin-top:5px;line-height:1.3;">You were hit while concentrating on ${esc(spellName)}.</div>
          </div>
        </div>
        <div style="padding:0 15px 15px;">
          <button type="button" class="ace-qol-btn ace-qol-roll-pill" data-action="aceQolConcPromptRoll"
                  style="width:100%;display:flex;align-items:center;justify-content:center;gap:10px;padding:12px 18px;background:${ACCENT};color:#ffffff;border:1px solid #6a1b7a;border-radius:999px;cursor:pointer;font-family:'Signika',sans-serif;font-size:18px;font-weight:700;line-height:1.25;white-space:normal;overflow-wrap:break-word;text-align:center;">
            <i class="fas fa-dice-d20" style="font-size:20px;flex-shrink:0;"></i>
            <span>Roll Concentration</span>
          </button>
        </div>
      </div>`;
  }
}

export const _test = { concEffectOf, spellNameOf };
