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
    const html = `
      <div class="ace-qol-oa-card" style="background:linear-gradient(180deg,#1a1416 0%,#241a1d 100%);border:2px solid #d4af37;border-radius:6px;padding:10px 12px;">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:6px;">
          <i class="fas fa-bolt" style="color:#d4af37;font-size:18px;"></i>
          <strong style="color:#ffd87a;font-size:13px;text-transform:uppercase;letter-spacing:0.5px;">Opportunity Attack</strong>
        </div>
        <div style="color:#cfcfd0;font-size:12px;line-height:1.4;">
          <strong>${reactorActor.name}</strong> can make an OA against <strong>${moverActor.name}</strong>.
        </div>
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
                  style="background:#1a1a1f;color:#aaa;border:1px solid #555;padding:4px 10px;border-radius:3px;cursor:pointer;font-size:12px;">
            Pass
          </button>
        </div>
      </div>
    `;
    await ChatMessage.create({
      content: html,
      speaker: ChatMessage.getSpeaker({ actor: reactorActor }),
      flags: { [MODULE_ID]: { type: "oaPrompt", reactorId, moverId } },
    });
  }
}

// ── Bind click handlers via renderChatMessage / renderChatMessageHTML ────────
const _bindOAButtons = (message, html) => {
  try {
    const root = html instanceof HTMLElement ? html : (html?.[0] ?? html);
    if (!root || typeof root.querySelectorAll !== "function") return;
    const takeBtns = root.querySelectorAll("[data-action='aceQolTakeOA']");
    const passBtns = root.querySelectorAll("[data-action='aceQolPassOA']");
    for (const btn of takeBtns) {
      if (btn.dataset.aceQolBound === "1") continue;
      btn.dataset.aceQolBound = "1";
      btn.addEventListener("click", async (ev) => {
        ev.preventDefault();
        if (!game.user.isGM) {
          ui.notifications?.warn("Only the GM can resolve OA prompts.");
          return;
        }
        btn.disabled = true;
        const reactorId = btn.dataset.reactorId;
        const reactor = game.actors.get(reactorId);
        if (reactor) {
          // Mark reaction used + fire the cross-module hook other engines
          // listen for (reaction-engine, etc.)
          await reactor.setFlag?.(MODULE_ID, "reactionUsed", true);
          Hooks.callAll(`${MODULE_ID}.opportunityAttack`, reactor.id);
        }
        btn.innerHTML = `<i class="fas fa-check"></i> Reaction used`;
      });
    }
    for (const btn of passBtns) {
      if (btn.dataset.aceQolBound === "1") continue;
      btn.dataset.aceQolBound = "1";
      btn.addEventListener("click", (ev) => {
        ev.preventDefault();
        btn.disabled = true;
        btn.textContent = "Passed";
      });
    }
  } catch (err) { /* non-fatal */ }
};

Hooks.on("renderChatMessage",     _bindOAButtons); // V12
Hooks.on("renderChatMessageHTML", _bindOAButtons); // V13
