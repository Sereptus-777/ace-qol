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

export class BreakFreeEngine {

  static init() {
    if (this._initialized) return;
    this._initialized = true;

    // Prompt at the START of each combatant's turn.
    Hooks.on("combatTurn", (combat) => {
      try { this._onCombatTurn(combat); }
      catch (err) { console.warn(`${MODULE_ID} | BreakFree.combatTurn failed:`, err); }
    });
    Hooks.on("combatRound", (combat) => {
      try { this._onCombatTurn(combat); }
      catch (err) { console.warn(`${MODULE_ID} | BreakFree.combatRound failed:`, err); }
    });

    // Resolve button clicks on the prompt card.
    Hooks.on("renderChatMessage",    (msg, html) => this._wireCard(msg, html));
    Hooks.on("renderChatMessageHTML", (msg, html) => this._wireCard(msg, html));

    console.log(`${MODULE_ID} | BreakFreeEngine online — action-to-escape prompts at start of turn.`);
  }

  /** Whose turn just STARTED → offer a break-free attempt for its restraints. */
  static _onCombatTurn(combat) {
    if (game.users?.activeGM !== game.user) return;   // post the prompt once
    if (!combat?.started) return;
    const combatant = combat.turns?.[combat.turn];
    const actor = combatant?.actor;
    if (!actor) return;

    const tagged = (actor.effects?.contents ?? []).filter(e => e.flags?.[MODULE_ID]?.breakFree?.ability);
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
          <div style="display:flex;align-items:center;gap:10px;padding:10px 12px;background:rgba(107,142,35,0.18);border-bottom:1px solid rgba(107,142,35,0.4);">
            <img src="${img}" style="width:38px;height:38px;border-radius:50%;border:1px solid #6b8e23;flex-shrink:0;" />
            <div>
              <div style="color:#cfe8a0;font-weight:700;font-size:15px;">${foundry.utils.escapeHTML(actor.name)} is entangled</div>
              <div style="color:#9bb37a;font-size:13px;">${foundry.utils.escapeHTML(meta.label || "Restrained")}</div>
            </div>
          </div>
          <div style="padding:10px 12px;color:#e8e6d8;font-size:14px;line-height:1.4;">
            Spend your <b>action</b> to try to break free — a <b>${abilityLabel} check</b> vs <b>DC ${meta.dc}</b>.
          </div>
          <div style="display:flex;gap:8px;padding:0 12px 12px;">
            <button class="ace-qol-breakfree-go" data-effect-id="${eff.id}" data-actor-uuid="${actor.uuid}"
                    data-token-id="${tokenId ?? ""}" data-scene-id="${sceneId ?? ""}"
                    data-ability="${meta.ability}" data-dc="${meta.dc}" data-label="${foundry.utils.escapeHTML(meta.label || "")}"
                    style="flex:1;padding:9px;font-size:15px;font-weight:700;color:#14140c;background:#9bcc4a;border:none;border-radius:6px;cursor:pointer;">
              <i class="fas fa-hand-fist"></i> Break Free (uses action)
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
    const eff = actor.effects?.get?.(effectId);
    if (!eff) {
      btn.closest(".ace-qol-breakfree-card")?.style.setProperty("opacity", "0.5");
      ui.notifications?.info("ACE QOL — that restraint is already gone.");
      return;
    }

    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Rolling…';

    // Raw ability CHECK (1d20 + ability modifier). Prefer dnd5e's own roller so
    // bonuses / advantage flags apply; fall back to a plain Roll.
    let total = 0;
    try {
      if (typeof actor.rollAbilityCheck === "function") {
        const r = await actor.rollAbilityCheck({ ability }, { chatMessage: false });
        const roll = Array.isArray(r) ? r[0] : r;
        total = roll?.total ?? 0;
      } else if (typeof actor.rollAbilityTest === "function") {
        const roll = await actor.rollAbilityTest(ability, { chatMessage: false });
        total = roll?.total ?? 0;
      } else {
        const roll = await (new Roll(`1d20 + @abilities.${ability}.mod`, actor.getRollData())).evaluate();
        total = roll.total;
      }
    } catch (_) {
      try {
        const roll = await (new Roll(`1d20 + @abilities.${ability}.mod`, actor.getRollData())).evaluate();
        total = roll.total;
      } catch (__) { total = 0; }
    }

    const passed = total >= dc;
    const abilityLabel = CONFIG.DND5E?.abilities?.[ability]?.label ?? ability.toUpperCase();

    if (passed) {
      try { await eff.delete(); } catch (_) { /* already gone */ }
    }

    const color = passed ? "#9bcc4a" : "#d98b46";
    const verdict = passed
      ? `Broke free of ${foundry.utils.escapeHTML(label)}!`
      : `The ${foundry.utils.escapeHTML(label)} holds — still entangled.`;
    await ChatMessage.create({
      speaker: ChatMessage.getSpeaker({ actor }),
      content: `
        <div style="border:1px solid ${color}55;border-radius:8px;padding:10px 12px;background:linear-gradient(180deg,#14140c,#0c0c08);font-family:'Signika',sans-serif;">
          <div style="display:flex;align-items:center;gap:8px;">
            <i class="fas fa-hand-fist" style="color:${color};font-size:16px;"></i>
            <span style="color:#e8e6d8;font-size:14px;"><b>${foundry.utils.escapeHTML(actor.name)}</b> — ${abilityLabel} check
              <b style="color:${color};">${total}</b> vs DC ${dc}</span>
          </div>
          <div style="margin-top:5px;color:${color};font-weight:700;font-size:14px;">${verdict}</div>
        </div>`,
    });

    // Grey out the prompt now that it's resolved.
    btn.closest(".ace-qol-breakfree-card")?.style.setProperty("opacity", "0.6");
    btn.innerHTML = passed ? '<i class="fas fa-check"></i> Free' : '<i class="fas fa-xmark"></i> Held';
  }
}
