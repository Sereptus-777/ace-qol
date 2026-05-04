// ─── ACE: QOL — Opportunity Attack Prompt ────────────────────────────────────
// PHB 195: "You can make an opportunity attack when a hostile creature that
// you can see moves out of your reach. To make the opportunity attack, you
// use your reaction to make one melee attack against the provoking creature."
//
// Detection:
//   - Hook updateToken (position changes during a token move).
//   - For each token-on-canvas: if it is hostile to the moving token AND
//     was within reach BEFORE the move AND is no longer within reach AFTER,
//     they get an OA prompt.
//   - Skip if mover has Disengaged this turn (CombatActions flag).
//   - Skip if reactor has used reaction this round (ReactionEngine).
//   - Skip if reactor is incapacitated/can't see.
//
// Result:
//   - GM sees a chat-card prompt: "[Reactor] can make an OA against [Mover]?"
//   - Click "Take OA" → marks reaction used, fires the configured ace-qol
//     opportunityAttack hook (other systems / macros consume it).
//   - Click "Pass" → no action.
//
// SETTINGS
//   - opportunityAttackPrompt (Boolean, default true)
//   - opportunityAttackReach  (Number, default 5 — feet, override for reach
//     weapons but most actors use 5)
// ──────────────────────────────────────────────────────────────────────────────

import { MODULE_ID } from "./ace-qol.mjs";
import { QolSettings } from "./settings.mjs";

// Hardcoded literal — TDZ-safe (see stealth-engine.mjs comment)
const FLAG_NS = "ace-qol";

export class OAPrompt {

  static init() {
    Hooks.on("updateToken", async (tokenDoc, changes /*, opts, userId */) => {
      try {
        if (!game.user.isGM) return;
        if (!QolSettings.get?.("opportunityAttackPrompt")) return;
        const movedX = changes.x !== undefined;
        const movedY = changes.y !== undefined;
        if (!movedX && !movedY) return;
        await OAPrompt._checkProvocations(tokenDoc, changes);
      } catch (err) {
        console.warn(`${MODULE_ID} | OA detection threw:`, err);
      }
    });

    console.log(`${MODULE_ID} | OAPrompt online`);
  }

  static async _checkProvocations(moverDoc, changes) {
    const moverActor = moverDoc?.actor;
    if (!moverActor) return;

    // ── Mover-state guards: skip OA detection entirely ──
    // Dead / unconscious / petrified / 0-HP creatures don't provoke OAs
    // when the GM drags their corpse around the map. RAW: an OA triggers
    // when a hostile creature MOVES out of reach — corpses aren't moving
    // willingly. Same for incapacitated / paralyzed / stunned (can't take
    // actions, but the body still being shoved doesn't provoke an OA in
    // any reasonable interpretation).
    const skipStatuses = ["dead", "unconscious", "petrified", "incapacitated",
                          "paralyzed", "stunned"];
    const moverStatuses = moverActor.statuses ?? new Set();
    for (const s of skipStatuses) {
      if (moverStatuses.has?.(s)) return;
    }
    // 0-HP guard: dnd5e doesn't always set "dead" status when HP = 0
    // (especially for NPCs whose death-pipeline removed the token but
    // left a synthetic actor). Belt-and-suspenders: skip on 0 HP.
    const hp = Number(moverActor.system?.attributes?.hp?.value ?? 0);
    if (hp <= 0) return;

    // Disengage skips OAs entirely
    const hasDisengage = (moverActor.effects?.contents ?? []).some(e =>
      e?.flags?.[FLAG_NS]?.disengage === true && !e.disabled
    );
    if (hasDisengage) return;

    // Compute pre/post positions
    const fromX = (moverDoc.x ?? 0);
    const fromY = (moverDoc.y ?? 0);
    const toX   = (changes.x ?? fromX);
    const toY   = (changes.y ?? fromY);

    // Token center offsets
    const w = (moverDoc.width  ?? 1) * (canvas.scene?.grid?.size ?? 100);
    const h = (moverDoc.height ?? 1) * (canvas.scene?.grid?.size ?? 100);
    const fromCenter = { x: fromX + w / 2, y: fromY + h / 2 };
    const toCenter   = { x: toX   + w / 2, y: toY   + h / 2 };

    const moverDisp = moverDoc.disposition ?? 0;
    const placeables = canvas.tokens?.placeables ?? [];
    const reachFt = Number(QolSettings.get?.("opportunityAttackReach") ?? 5);
    const gridSize = canvas.scene?.grid?.size ?? 100;
    const ftPerGrid = canvas.scene?.grid?.distance ?? 5;
    const reachPx = (reachFt / ftPerGrid) * gridSize;

    for (const t of placeables) {
      if (!t.actor) continue;
      if (t.id === moverDoc.id) continue;
      const td = t.document;
      // Hostile to mover (opposite disposition, NOT neutral 0)
      if (td.disposition === moverDisp) continue;
      if (td.disposition === 0) continue;

      // Reactor can't make OAs if incapacitated, blinded, etc.
      if (t.actor.statuses?.has?.("incapacitated") || t.actor.statuses?.has?.("unconscious")
       || t.actor.statuses?.has?.("paralyzed") || t.actor.statuses?.has?.("petrified")
       || t.actor.statuses?.has?.("stunned") || t.actor.statuses?.has?.("blinded")) continue;

      // Reactor's reach already used? (reaction-engine flag)
      if (t.actor.getFlag?.(FLAG_NS, "reactionUsed") === true) continue;

      const reactorCenter = {
        x: td.x + ((td.width  ?? 1) * gridSize) / 2,
        y: td.y + ((td.height ?? 1) * gridSize) / 2,
      };
      const distBefore = Math.hypot(fromCenter.x - reactorCenter.x, fromCenter.y - reactorCenter.y);
      const distAfter  = Math.hypot(toCenter.x   - reactorCenter.x, toCenter.y   - reactorCenter.y);

      // Was within reach AND now isn't = provoking
      if (distBefore <= reachPx && distAfter > reachPx) {
        await OAPrompt._postPromptCard(t.actor, moverActor, td, moverDoc);
      }
    }
  }

  static async _postPromptCard(reactorActor, moverActor, reactorTokenDoc, moverTokenDoc) {
    const reactorId = reactorActor.id;
    const moverId   = moverActor.id;
    const html = OAPrompt._renderCardHtml(reactorActor.name, moverActor.name, reactorId, moverId, "pending");

    // Whisper recipients: GM(s) + the reactor's player owner (if any).
    // For GM-controlled NPCs, only the GM sees the prompt. PCs reactors
    // include their owner so the player can decide. This prevents the
    // table's other players from seeing irrelevant OA prompts.
    const recipients = new Set();
    for (const u of game.users) if (u.isGM) recipients.add(u.id);
    if (reactorActor.hasPlayerOwner) {
      for (const [uid, level] of Object.entries(reactorActor.ownership ?? {})) {
        if (uid === "default") continue;
        if (level >= 3) recipients.add(uid); // 3 = OWNER
      }
    }
    await ChatMessage.create({
      content: html,
      speaker: ChatMessage.getSpeaker({ actor: reactorActor }),
      whisper: [...recipients],
      flags: { [MODULE_ID]: { type: "oaPrompt", reactorId, moverId, status: "pending" } },
    });
  }

  /**
   * Single source of truth for OA card HTML.
   * status: "pending" | "taken" | "passed"
   */
  static _renderCardHtml(reactorName, moverName, reactorId, moverId, status) {
    const isPending = status === "pending";
    const verdictHtml = status === "taken"
      ? `<div style="color:#d4af37;font-weight:600;font-size:12px;margin-top:8px;"><i class="fas fa-bolt"></i> Reaction used</div>`
      : status === "passed"
      ? `<div style="color:#888;font-weight:600;font-size:12px;margin-top:8px;font-style:italic;">Passed — no action</div>`
      : "";
    const buttonsHtml = isPending ? `
      <div style="display:flex;gap:6px;margin-top:8px;">
        <button type="button" class="ace-qol-btn"
                data-action="aceQolTakeOA"
                data-reactor-id="${reactorId}"
                data-mover-id="${moverId}"
                style="background:#3a2010;color:#ffd87a;border:1px solid #d4af37;padding:4px 10px;border-radius:3px;cursor:pointer;font-size:12px;font-weight:600;">
          <i class="fas fa-bolt"></i> Take OA
        </button>
        <button type="button" class="ace-qol-btn"
                data-action="aceQolPassOA"
                data-reactor-id="${reactorId}"
                data-mover-id="${moverId}"
                style="background:#1a1a1f;color:#aaa;border:1px solid #555;padding:4px 10px;border-radius:3px;cursor:pointer;font-size:12px;">
          Pass
        </button>
      </div>` : "";
    return `
      <div class="ace-qol-oa-card" style="background:linear-gradient(180deg,#1a1416 0%,#241a1d 100%);border:2px solid #d4af37;border-radius:6px;padding:10px 12px;">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:6px;">
          <i class="fas fa-bolt" style="color:#d4af37;font-size:18px;"></i>
          <strong style="color:#ffd87a;font-size:13px;text-transform:uppercase;letter-spacing:0.5px;">Opportunity Attack</strong>
        </div>
        <div style="color:#cfcfd0;font-size:12px;line-height:1.4;">
          <strong>${reactorName}</strong> can make an OA against <strong>${moverName}</strong>.
        </div>
        ${verdictHtml}
        ${buttonsHtml}
      </div>
    `;
  }

  /**
   * Resolve an OA prompt — updates the chat MESSAGE itself (so all clients
   * re-render with the resolved state) AND fires the appropriate side
   * effects (mark reaction used, fire cross-module hook).
   * @param {string} messageId
   * @param {"taken"|"passed"} status
   */
  static async resolveOAPrompt(messageId, status) {
    const msg = game.messages?.get?.(messageId);
    if (!msg) return;
    const flags = msg.flags?.[MODULE_ID];
    if (flags?.type !== "oaPrompt") return;
    if (flags?.status && flags.status !== "pending") return; // already resolved

    const reactorId = flags.reactorId;
    const moverId   = flags.moverId;
    const reactor   = game.actors.get(reactorId);
    const mover     = game.actors.get(moverId);
    const reactorName = reactor?.name ?? "Reactor";
    const moverName   = mover?.name ?? "Target";

    if (status === "taken" && reactor) {
      // Mark reaction used + fire cross-module hook (reaction-engine, etc.)
      try {
        await reactor.setFlag?.(MODULE_ID, "reactionUsed", true);
        Hooks.callAll(`${MODULE_ID}.opportunityAttack`, reactor.id);
      } catch (_) { /* non-fatal */ }
    }

    // Re-render the card content with the resolved state. ALL clients with
    // visibility see this update via the standard chat-message render flow.
    const newHtml = OAPrompt._renderCardHtml(reactorName, moverName, reactorId, moverId, status);
    try {
      await msg.update({
        content: newHtml,
        [`flags.${MODULE_ID}.status`]: status,
        [`flags.${MODULE_ID}.resolvedAt`]: Date.now(),
      });
    } catch (err) {
      console.warn(`${MODULE_ID} | OA prompt resolve update failed:`, err);
    }
  }
}

// ── Bind click handlers via renderChatMessage / renderChatMessageHTML ────────
// Both Take OA and Pass call resolveOAPrompt → the message's content + flags
// update, every client re-renders the resolved state. No more local-only
// DOM mutation that left other clients showing the active button.
//
// Permission gate: only the GM can resolve the prompt (matches the rest of
// our reaction-engine model). For PC reactors, the player still sees the
// prompt but the GM clicks the button. Future enhancement could allow the
// PC's owner to click their own.
const _bindOAButtons = (message, html) => {
  try {
    const root = html instanceof HTMLElement ? html : (html?.[0] ?? html);
    if (!root || typeof root.querySelectorAll !== "function") return;
    const handleClick = async (ev, status) => {
      ev.preventDefault();
      if (!game.user.isGM) {
        ui.notifications?.warn("Only the GM can resolve OA prompts.");
        return;
      }
      const btn = ev.currentTarget;
      btn.disabled = true; // immediate local feedback
      // Find the message id from the chat message DOM (or the message
      // arg from the renderChatMessage hook). Fallback to walking up to
      // the .chat-message[data-message-id] element.
      const chatEl = btn.closest?.(".chat-message");
      const msgId = message?.id ?? chatEl?.dataset?.messageId;
      if (!msgId) {
        console.warn(`${MODULE_ID} | OA resolve: could not find messageId`);
        btn.disabled = false;
        return;
      }
      // Use the OAPrompt class's resolve method (single source of truth).
      try {
        const { OAPrompt } = await import("/modules/ace-qol/scripts/oa-prompt.mjs");
        await OAPrompt.resolveOAPrompt(msgId, status);
      } catch (err) {
        console.warn(`${MODULE_ID} | OA resolveOAPrompt threw:`, err);
        btn.disabled = false;
      }
    };
    for (const btn of root.querySelectorAll("[data-action='aceQolTakeOA']")) {
      if (btn.dataset.aceQolBound === "1") continue;
      btn.dataset.aceQolBound = "1";
      btn.addEventListener("click", (ev) => handleClick(ev, "taken"));
    }
    for (const btn of root.querySelectorAll("[data-action='aceQolPassOA']")) {
      if (btn.dataset.aceQolBound === "1") continue;
      btn.dataset.aceQolBound = "1";
      btn.addEventListener("click", (ev) => handleClick(ev, "passed"));
    }
  } catch (err) { /* non-fatal */ }
};

Hooks.on("renderChatMessage",     _bindOAButtons); // V12
Hooks.on("renderChatMessageHTML", _bindOAButtons); // V13
