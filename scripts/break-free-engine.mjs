// ─── ACE: QOL — Break-Free Engine ────────────────────────────────────────────
// Action-economy escape for "restrained by ropes / net / vines" effects
// (Entangling Rope, the Net weapon, Entangle, and similar homebrew). RAW: the
// trapped creature can spend its ACTION to make an ability CHECK (Strength by
// default) against the effect's DC; on a success it breaks free.
//
// Distinct from the Repeating-Save engine (which auto-rolls a SAVE at end of
// turn for save-ends spells like Hold Person). Break-free is PLAYER-INITIATED:
//
//   1. save-engine applies the Restrained condition on a failed initial save
//      and stamps `flags.ace-qol.breakFree` on the effect:
//        { ability:"str", dc:15, label:"Entangling Rope", appliedRound, appliedTurn, stampedAt }
//   2. At the START of the trapped creature's turn (combatTurn), this engine
//      posts a prompt card to its owner — "spend your action to try to break
//      free (Strength DC 15)". The initial save already happened on the cast,
//      so the first prompt is the creature's NEXT turn (we skip the turn the
//      effect was applied).
//   3. The owner clicks "Break Free" → we roll an ability CHECK vs the DC,
//      post the result, and on a success delete the effect (its persistent
//      Forge animation clears via the existing deleteActiveEffect cleanup).
//
// Multi-GM safe: the auto-prompt is posted only by the active GM. The resolve
// roll runs on whoever clicks (owner or GM).
// ──────────────────────────────────────────────────────────────────────────────

import { MODULE_ID } from "./ace-qol.mjs";
import { awaitDsnRoll } from "./attack-prompt.mjs";

// Real black-d20 die art (per-face) with a gold glow — the same dice the save
// cards use, so a break-free Strength check shows the player exactly what they
// rolled instead of a flat fist icon. Falls back to a Font Awesome d20 if the
// image asset is missing.
const ACE_DICE_DIR = "modules/ace-qol/Assets/Dice%20Dice/BD20";
function aceD20FaceImg(face, { size = 34, glow = true } = {}) {
  const n = Number(face);
  const valid = Number.isInteger(n) && n >= 1 && n <= 20;
  const src = `${ACE_DICE_DIR}/BD20-${valid ? n : 20}_nobg.png`;
  const icon = Math.round(size * 0.74);
  const glowSpan = glow
    ? `<span style="position:absolute;width:${size}px;height:${size}px;border-radius:50%;background:radial-gradient(circle,rgba(212,175,55,0.60) 0%,rgba(212,175,55,0.22) 48%,transparent 72%);"></span>`
    : "";
  const shadow = glow ? "filter:drop-shadow(0 0 3px rgba(212,175,55,0.75));" : "";
  return `<span style="position:relative;display:inline-flex;align-items:center;justify-content:center;width:${size}px;height:${size}px;flex-shrink:0;vertical-align:middle;">`
    + glowSpan
    + `<img src="${src}" alt="d20${valid ? " " + n : ""}" style="position:relative;width:${size}px;height:${size}px;object-fit:contain;${shadow}" `
    + `onerror="this.style.display='none';this.nextElementSibling.style.display='inline-block';" />`
    + `<i class="fas fa-dice-d20" style="display:none;position:relative;color:#d4af37;font-size:${icon}px;"></i>`
    + `</span>`;
}

export class BreakFreeEngine {

  static init() {
    if (this._initialized) return;
    this._initialized = true;

    // Prompt at the START of the turn. Use the SAME hooks the OverTime/regen
    // engine uses — they fire reliably at turn-start here. (combatTurn fired
    // too late, as the turn was LEAVING, so the card showed after the turn.)
    // combatTurnChange gives the turn-starting combatant; updateCombat is the
    // backstop. The prompted-round/turn guard prevents a double prompt.
    Hooks.on("combatTurnChange", (combat, prior, current) => {
      try { this._onTurnStart(combat, current?.combatantId ?? null); }
      catch (err) { console.warn(`${MODULE_ID} | BreakFree.combatTurnChange failed:`, err); }
    });
    Hooks.on("updateCombat", (combat, changes) => {
      if (!changes || (!("turn" in changes) && !("round" in changes))) return;
      try { this._onTurnStart(combat, combat.turns?.[combat.turn]?.id ?? null); }
      catch (err) { console.warn(`${MODULE_ID} | BreakFree.updateCombat failed:`, err); }
    });

    // Resolve button clicks on the prompt card.
    Hooks.on("renderChatMessage",    (msg, html) => this._wireCard(msg, html));
    Hooks.on("renderChatMessageHTML", (msg, html) => this._wireCard(msg, html));

    console.log(`${MODULE_ID} | BreakFreeEngine online — action-to-escape prompts at start of turn.`);
  }

  /** Whose turn just STARTED → offer a break-free attempt for its restraints. */
  static _onTurnStart(combat, combatantId) {
    if (game.users?.activeGM !== game.user) return;   // post the prompt once
    if (!combat?.started) return;
    const combatant = (combatantId ? combat.turns?.find(c => c.id === combatantId) : null)
                   ?? combat.turns?.[combat.turn];
    const actor = combatant?.actor;
    if (!actor) return;

    const tagged = (actor.effects?.contents ?? []).filter(e => {
      if (!e.flags?.[MODULE_ID]?.breakFree?.ability) return false;
      // Only prompt when the effect is ACTIVELY restraining the creature right
      // now. A stray/orphaned break-free flag — left by a since-removed
      // restraint or a mis-applied effect — must never trigger a phantom
      // "break free" on a creature who isn't entangled (not even the caster who
      // is merely concentrating, or a token nowhere near the web). The flag's
      // presence alone is not enough; the effect must currently impose the
      // Restrained status and be live (not disabled / suppressed).
      if (e.disabled || e.isSuppressed) return false;
      return e.statuses?.has?.("restrained") === true;
    });
    if (!tagged.length) return;

    // Skip dead/unconscious creatures — they can't act to break free.
    const hp = actor.system?.attributes?.hp?.value ?? 1;
    if (hp <= 0 || actor.statuses?.has?.("dead") || actor.statuses?.has?.("unconscious")) return;

    const round = combat.round ?? 0;
    const turn  = combat.turn ?? 0;
    for (const eff of tagged) {
      const meta = eff.flags[MODULE_ID].breakFree;
      // Don't prompt on the same turn the effect was applied — the initial save
      // already resolved when it was cast. First prompt is the NEXT turn.
      if (meta.appliedRound === round && meta.appliedTurn === turn) continue;
      // Don't double-prompt for the same effect on the same turn.
      if (meta.promptedRound === round && meta.promptedTurn === turn) continue;
      // SYNCHRONOUS race guard. Both turn hooks (combatTurnChange + updateCombat)
      // fire near-simultaneously; the async flag write below can't dedupe in
      // time, so without this we post two cards. This blocks the second fire
      // instantly, in-memory.
      const gk = `${combat.id}:${round}:${turn}:${eff.id}`;
      if (this._promptGuard?.has(gk)) continue;
      (this._promptGuard ??= new Set()).add(gk);
      if (this._promptGuard.size > 300) this._promptGuard = new Set([gk]);  // bound it
      this._postPrompt(actor, combatant, eff, meta, round, turn);
    }
  }

  /** Post the "spend your action to break free" prompt to the creature's owner. */
  static async _postPrompt(actor, combatant, eff, meta, round, turn) {
    try {
      // Stamp prompted-turn so a second turn-hook fire this turn won't repeat it.
      await eff.update({
        [`flags.${MODULE_ID}.breakFree.promptedRound`]: round,
        [`flags.${MODULE_ID}.breakFree.promptedTurn`]: turn,
      });

      const tokenId = combatant?.token?.id ?? combatant?.tokenId ?? null;
      const sceneId = combatant?.token?.parent?.id ?? canvas.scene?.id ?? null;
      const abilityLabel = CONFIG.DND5E?.abilities?.[meta.ability]?.label ?? meta.ability.toUpperCase();
      const img = actor.img || "icons/svg/mystery-man.svg";

      const content = `
        <div class="ace-qol-breakfree-card" style="border:1px solid #6b8e23;border-radius:8px;overflow:hidden;background:linear-gradient(180deg,#14140c,#0c0c08);font-family:'Signika',sans-serif;">
          <div style="display:flex;align-items:center;gap:12px;padding:11px 14px;background:rgba(107,142,35,0.18);border-bottom:1px solid rgba(107,142,35,0.4);">
            <img src="${img}" style="width:48px;height:48px;border-radius:8px;border:1px solid #6b8e23;flex-shrink:0;object-fit:cover;" />
            <div>
              <div style="color:#cfe8a0;font-weight:700;font-size:18px;">${foundry.utils.escapeHTML(actor.name)} is entangled</div>
              <div style="color:#9bb37a;font-size:14px;">${foundry.utils.escapeHTML(meta.label || "Restrained")}</div>
            </div>
          </div>
          <div style="display:flex;align-items:center;gap:12px;padding:12px 14px;color:#e8e6d8;font-size:16px;line-height:1.35;">
            ${aceD20FaceImg(20, { size: 38, glow: true })}
            <span>Spend your <b>action</b> to try to break free — a <b>${abilityLabel} check</b> vs <b style="color:#cfe8a0;">DC ${meta.dc}</b>.</span>
          </div>
          <div style="display:flex;gap:8px;padding:0 12px 12px;">
            <button class="ace-qol-breakfree-go" data-effect-id="${eff.id}" data-actor-uuid="${actor.uuid}"
                    data-token-id="${tokenId ?? ""}" data-scene-id="${sceneId ?? ""}" data-item-uuid="${meta.itemUuid ?? ""}"
                    data-ability="${meta.ability}" data-dc="${meta.dc}" data-label="${foundry.utils.escapeHTML(meta.label || "")}"
                    style="flex:1;display:flex;align-items:center;justify-content:center;gap:9px;padding:9px;color:#14140c;background:#9bcc4a;border:none;border-radius:6px;cursor:pointer;line-height:1.05;">
              <i class="fas fa-hand-fist" style="font-size:17px;"></i>
              <span style="display:flex;flex-direction:column;align-items:center;">
                <span style="font-size:16px;font-weight:700;">Break Free</span>
                <span style="font-size:11px;font-weight:600;opacity:0.8;">uses action</span>
              </span>
            </button>
            <button class="ace-qol-breakfree-skip" style="padding:9px 12px;font-size:14px;color:#cfe8a0;background:transparent;border:1px solid #4a5a28;border-radius:6px;cursor:pointer;">
              Stay
            </button>
          </div>
        </div>`;

      // Whisper to the creature's owners + GMs so only the relevant table sees it.
      const owners = game.users?.filter(u => u.active && (u.isGM || actor.testUserPermission?.(u, "OWNER"))).map(u => u.id) ?? [];
      await ChatMessage.create({
        content,
        speaker: ChatMessage.getSpeaker({ actor }),
        whisper: owners.length ? owners : [game.user.id],
        flags: { [MODULE_ID]: { type: "breakFreePrompt", effectId: eff.id } },
      });
    } catch (err) {
      console.warn(`${MODULE_ID} | BreakFree prompt failed for ${actor?.name}:`, err);
    }
  }

  /** Wire the Break Free / Stay buttons on a posted prompt card. */
  static _wireCard(message, html) {
    if (message?.flags?.[MODULE_ID]?.type !== "breakFreePrompt") return;
    const root = html instanceof HTMLElement ? html : html?.[0];
    if (!root) return;

    // Already attempted (resolved on ANY client) → show it spent + lock both
    // buttons, so it can't be rolled a second time from another screen.
    if (message.getFlag?.(MODULE_ID, "breakFreeResolved")) {
      root.querySelector(".ace-qol-breakfree-card")?.style.setProperty("opacity", "0.5");
      root.querySelectorAll("button").forEach(b => { b.disabled = true; });
      return;
    }

    const skipBtn = root.querySelector(".ace-qol-breakfree-skip");
    if (skipBtn && !skipBtn.dataset.wired) {
      skipBtn.dataset.wired = "1";
      skipBtn.addEventListener("click", () => {
        skipBtn.closest(".ace-qol-breakfree-card")?.style.setProperty("opacity", "0.5");
        skipBtn.disabled = true;
      });
    }

    const goBtn = root.querySelector(".ace-qol-breakfree-go");
    if (goBtn && !goBtn.dataset.wired) {
      goBtn.dataset.wired = "1";
      goBtn.addEventListener("click", () => this._attempt(goBtn));
    }
  }

  /** Roll the ability check vs DC; free the creature on a success. */
  static async _attempt(btn) {
    const actorUuid = btn.dataset.actorUuid;
    const effectId  = btn.dataset.effectId;
    const ability   = btn.dataset.ability;
    const dc        = Number(btn.dataset.dc);
    const label     = btn.dataset.label || "the restraint";

    const actor = await fromUuid(actorUuid).then(d => d?.actor ?? d).catch(() => null);
    if (!actor) { ui.notifications?.warn("ACE QOL — couldn't find the creature to break free."); return; }
    // Only an owner or a GM may roll the attempt.
    if (!game.user.isGM && !actor.testUserPermission?.(game.user, "OWNER")) {
      ui.notifications?.warn("ACE QOL — only the creature's owner (or the GM) can attempt the break-free.");
      return;
    }

    // One attempt only. If this prompt was already rolled (e.g. the GM rolled
    // it, then the player clicks their own copy of the same whispered card),
    // bail — the resolve flag is on the message so every client locks together.
    const promptMsg = (() => {
      const id = btn.closest?.(".chat-message")?.dataset?.messageId;
      return id ? game.messages.get(id) : null;
    })();
    if (promptMsg?.getFlag?.(MODULE_ID, "breakFreeResolved")) {
      btn.closest(".ace-qol-breakfree-card")?.style.setProperty("opacity", "0.5");
      btn.disabled = true;
      return;
    }

    const eff = actor.effects?.get?.(effectId);
    if (!eff) {
      btn.closest(".ace-qol-breakfree-card")?.style.setProperty("opacity", "0.5");
      ui.notifications?.info("ACE QOL — that restraint is already gone.");
      return;
    }

    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Rolling…';

    // Raw ability CHECK (1d20 + ability modifier). Prefer dnd5e's own roller so
    // bonuses / advantage flags apply; fall back to a plain Roll. Capture the
    // d20 FACE too so the result card can show the real die (the player needs
    // to see what they rolled — the die used to just vanish).
    let total = 0;
    let dieFace = null;
    const _grabFace = (roll) => roll?.dice?.[0]?.total
      ?? roll?.terms?.find?.(t => t?.faces === 20)?.results?.[0]?.result
      ?? null;
    try {
      let roll = null;
      if (typeof actor.rollAbilityCheck === "function") {
        const r = await actor.rollAbilityCheck({ ability }, { chatMessage: false });
        roll = Array.isArray(r) ? r[0] : r;
      } else if (typeof actor.rollAbilityTest === "function") {
        roll = await actor.rollAbilityTest(ability, { chatMessage: false });
      } else {
        roll = await (new Roll(`1d20 + @abilities.${ability}.mod`, actor.getRollData())).evaluate();
      }
      total = roll?.total ?? 0;
      dieFace = _grabFace(roll);
    } catch (_) {
      try {
        const roll = await (new Roll(`1d20 + @abilities.${ability}.mod`, actor.getRollData())).evaluate();
        total = roll.total;
        dieFace = _grabFace(roll);
      } catch (__) { total = 0; }
    }

    // Lock the prompt (so it can't be rolled again from another screen) and let
    // the 3D dice finish settling before the result card reveals pass/fail.
    if (promptMsg) { try { await promptMsg.setFlag(MODULE_ID, "breakFreeResolved", true); } catch (_) {} }
    try { await awaitDsnRoll(); } catch (_) {}

    const passed = total >= dc;
    const modPart = (dieFace != null) ? (() => { const m = total - dieFace; const s = m >= 0 ? "+" : ""; return m === 0 ? "" : ` ${s}${m}`; })() : "";
    const abilityLabel = CONFIG.DND5E?.abilities?.[ability]?.label ?? ability.toUpperCase();

    if (passed) {
      try { await eff.delete(); } catch (_) { /* already gone */ }
      // Clear the persistent Forge animation (the frozen rope). Try the precise
      // item-name end first; then sweep ANY forge:persist:* effect bound to the
      // freed token — robust even if the flag predates itemUuid tracking.
      try {
        const seqMgr = globalThis.Sequencer?.EffectManager ?? window.Sequencer?.EffectManager;
        if (seqMgr) {
          const itemUuid = btn.dataset.itemUuid;
          if (itemUuid) { try { await seqMgr.endEffects({ name: `forge:persist:${itemUuid}` }); } catch (_) {} }
          const tokDoc = btn.dataset.sceneId
            ? game.scenes.get(btn.dataset.sceneId)?.tokens?.get(btn.dataset.tokenId)
            : canvas.scene?.tokens?.get(btn.dataset.tokenId);
          const tokObj = tokDoc?.object ?? actor.getActiveTokens?.()?.[0];
          if (tokObj && typeof seqMgr.getEffects === "function") {
            for (const e of (seqMgr.getEffects({ object: tokObj }) ?? [])) {
              const nm = e?.data?.name ?? e?.name ?? "";
              if (typeof nm === "string" && nm.startsWith("forge:persist:")) {
                try { await seqMgr.endEffects({ name: nm }); } catch (_) {}
              }
            }
          }
        }
      } catch (_) { /* best-effort FX cleanup */ }
    }

    const color = passed ? "#9bcc4a" : "#d98b46";
    const verdict = passed
      ? `Broke free of ${foundry.utils.escapeHTML(label)}!`
      : `The ${foundry.utils.escapeHTML(label)} holds — still entangled.`;
    await ChatMessage.create({
      speaker: ChatMessage.getSpeaker({ actor }),
      content: `
        <div style="border:1px solid ${color}55;border-radius:8px;padding:12px 14px;background:linear-gradient(180deg,#14140c,#0c0c08);font-family:'Signika',sans-serif;">
          <div style="display:flex;align-items:center;gap:10px;">
            ${aceD20FaceImg(dieFace, { size: 38, glow: true })}
            <span style="color:#e8e6d8;font-size:16px;line-height:1.25;">
              <b>${foundry.utils.escapeHTML(actor.name)}</b> — ${abilityLabel} check<br/>
              <b style="color:#fff;font-size:18px;">${dieFace ?? total}</b><span style="color:#b9a978;">${modPart} =</span> <b style="color:${color};font-size:18px;">${total}</b> <span style="color:#b9a978;">vs DC ${dc}</span>
            </span>
          </div>
          <div style="margin-top:7px;color:${color};font-weight:700;font-size:15px;">${verdict}</div>
        </div>`,
    });

    // Grey out the prompt now that it's resolved.
    btn.closest(".ace-qol-breakfree-card")?.style.setProperty("opacity", "0.6");
    btn.innerHTML = passed ? '<i class="fas fa-check"></i> Free' : '<i class="fas fa-xmark"></i> Held';
  }
}
