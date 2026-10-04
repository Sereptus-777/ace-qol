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
import { registerChatCardHandler } from "./chat-render-utils.mjs";
import { awaitDsnRoll } from "./attack-prompt.mjs";
import { abilityMod } from "./rolldata-utils.mjs";
// The one reader for what made a number (roll-formula.mjs).
import { explainCheck, formulaPill } from "./roll-formula.mjs";
// Lucky (2014) and the halfling's Lucky. See luck.mjs.
import { withHalflingLuck, againstDC as luckAgainstDC } from "./luck.mjs";

// The one d20 widget (dice-face.mjs): the same dice the save cards and the roll
// popout use. Its size here is 34, as it always was.
import { aceD20FaceImg as _aceD20Face } from "./dice-face.mjs";
const aceD20FaceImg = (face, { size = 34, glow = true } = {}) => _aceD20Face(face, { size, glow });

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
    // Both render hooks + a sweep of cards that were drawn before this
    // registered. See chat-render-utils — the raw hooks leave those
    // undecorated forever, which is how GM-only content reached a player.
    registerChatCardHandler((msg, html) => this._wireCard(msg, html), "break-free cards");

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
      // ⚠️ A GRAPPLE IS HELD TOO (2026-09-29). This looked only at restrained, so a
      // grapple carrying a break-free stamp was never seen and the escape never
      // came round. Both are "something has hold of you".
      return e.statuses?.has?.("restrained") === true
          || e.statuses?.has?.("grappled") === true;
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
      // ⚠️🔴 NO PICKER FOR A GRAPPLE (his rule, 2026-09-29): "do not ask Strength
      // or Dexterity. Roll the higher of the victim's Strength (Athletics) and
      // Dexterity (Acrobatics) against the stamped DC." A stamp that says `auto`
      // rolls itself and whispers the answer. Everything that does NOT say it —
      // Web, the net, the Entangling Rope — keeps the button it has always had,
      // because those cost an action somebody has to decide to spend.
      /* ⚠️🔴 A GRAPPLE IS NOT ROLLED FOR THEM ANY MORE (his rule,
         2026-10-04, reversing 2026-09-29). That day an escape "asked nobody":
         this rolled the better of Athletics and Acrobatics at the start of the
         turn and whispered the answer. It asks now, because the creature has a
         real choice to make with that action — swing at what is holding it, or
         get out — and rolling the escape took the choice away. `grapple-turn.mjs`
         owns that box and the squeeze that comes before it; everything else that
         holds a creature (Web, a net, the Entangling Rope) keeps this prompt. */
      if (meta.auto) {
        console.log(`${MODULE_ID} | BreakFree: ${actor.name}'s "${meta.label ?? "hold"}" is a grapple, `
          + `so the held-turn box asks it rather than this rolling for them.`);
        continue;
      }
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
      // ⚠️ ONE ABILITY OR A CHOICE OF TWO (2026-09-29). A rope or a net names the
      // one check its own words name, and that is what `ability` has always been.
      // Escaping a GRAPPLE is Athletics or Acrobatics and the held creature
      // chooses, so a stamp may carry `abilities` as well. Nothing that stamps
      // only `ability` behaves any differently: the list falls back to it.
      const abilityLabel = CONFIG.DND5E?.abilities?.[meta.ability]?.label
        ?? String(meta.ability).toUpperCase();
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
            <span>Spend your <b>action</b> to try to break free — a <b>${abilityLabel} check</b><span class="ace-qol-dc" data-dc-roller="${actor?.id ?? ""}"> vs <b style="color:#cfe8a0;">DC ${meta.dc}</b></span>.</span>
          </div>
          <div style="display:flex;gap:8px;padding:0 12px 12px;flex-wrap:wrap;">
            <button class="ace-qol-breakfree-go" data-effect-id="${eff.id}" data-actor-uuid="${actor.uuid}"
                    data-token-id="${tokenId ?? ""}" data-scene-id="${sceneId ?? ""}" data-item-uuid="${meta.itemUuid ?? ""}"
                    data-ability="${meta.ability}" data-dc="${meta.dc}" data-label="${foundry.utils.escapeHTML(meta.label || "")}"
                    style="flex:1 1 auto;min-width:118px;display:flex;align-items:center;justify-content:center;gap:9px;padding:9px;color:#14140c;background:#9bcc4a;border:none;border-radius:6px;cursor:pointer;line-height:1.05;">
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

  /**
   * Roll the check vs DC; free the creature on a success.
   *
   * ⚠️ ONE ROLL PATH, TWO WAYS IN. A pressed button hands over its dataset; the
   * automatic escape hands over the same fields as a plain object. Duplicating
   * this for the auto path would have been two rollers drifting apart, which is
   * the fault the whole suite is built to avoid. `btn` is a DOM element in the
   * first case and undefined in the second, so every DOM touch below is guarded.
   */
  static async _attempt(btn, instruction = null) {
    const d = instruction ?? btn?.dataset ?? {};
    const actorUuid = d.actorUuid;
    const effectId  = d.effectId;
    const ability   = d.ability;
    const skill     = d.skill || null;      // a grapple escapes with a SKILL
    const whisperTo = d.whisperTo || null;  // an automatic escape is whispered
    const dc        = Number(d.dc);
    const label     = d.label || "the restraint";

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
      const id = btn?.closest?.(".chat-message")?.dataset?.messageId;
      return id ? game.messages.get(id) : null;
    })();
    if (promptMsg?.getFlag?.(MODULE_ID, "breakFreeResolved")) {
      btn?.closest?.(".ace-qol-breakfree-card")?.style.setProperty("opacity", "0.5");
      if (btn) btn.disabled = true;
      return;
    }

    const eff = actor.effects?.get?.(effectId);
    if (!eff) {
      btn?.closest?.(".ace-qol-breakfree-card")?.style.setProperty("opacity", "0.5");
      if (btn) ui.notifications?.info("ACE QOL — that restraint is already gone.");
      return;
    }

    if (btn) {
      btn.disabled = true;
      btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Rolling…';
    }

    // Raw ability CHECK (1d20 + ability modifier). Prefer dnd5e's own roller so
    // bonuses / advantage flags apply; fall back to a plain Roll. Capture the
    // d20 FACE too so the result card can show the real die (the player needs
    // to see what they rolled — the die used to just vanish).
    let total = 0;
    let dieFace = null;
    let bfRoll = null;
    const _grabFace = (roll) => roll?.dice?.[0]?.total
      ?? roll?.terms?.find?.(t => t?.faces === 20)?.results?.[0]?.result
      ?? null;
    try {
      let roll = null;
      // ACE owns the pause — dnd5e's roll dialog must never appear. In dnd5e
      // 5.x the SECOND arg is the DIALOG config (`{configure:false}`) and the
      // THIRD is the message config (`{create:false}`); passing
      // `{chatMessage:false}` as the 2nd arg silently let the dialog through.
      // (Suite-wide dialog sweep, 2026-07-27.)
      if (skill && typeof actor.rollSkill === "function") {
        // Athletics or Acrobatics, whichever this creature is better at. ACE owns
        // the pause here too: no dnd5e dialog, no chat message of its own.
        const r = await actor.rollSkill({ skill }, { configure: false }, { create: false });
        roll = Array.isArray(r) ? r[0] : r;
      } else if (typeof actor.rollAbilityCheck === "function") {
        const r = await actor.rollAbilityCheck({ ability }, { configure: false }, { create: false });
        roll = Array.isArray(r) ? r[0] : r;
      } else if (typeof actor.rollAbilityTest === "function") {
        roll = await actor.rollAbilityTest(ability, { chatMessage: false, fastForward: true });
      } else {
        roll = await (new Roll(withHalflingLuck(`1d20 + ${abilityMod(actor.getRollData?.() ?? {}, ability)}`, actor))).evaluate();
      }
      total = roll?.total ?? 0;
      dieFace = _grabFace(roll);
      bfRoll = roll;
    } catch (_) {
      try {
        const roll = await (new Roll(withHalflingLuck(`1d20 + ${abilityMod(actor.getRollData?.() ?? {}, ability)}`, actor))).evaluate();
        total = roll.total;
        dieFace = _grabFace(roll);
        bfRoll = roll;
      } catch (__) { total = 0; }
    }

    // Lock the prompt (so it can't be rolled again from another screen) and let
    // the 3D dice finish settling before the result card reveals pass/fail.
    if (promptMsg) { try { await promptMsg.setFlag(MODULE_ID, "breakFreeResolved", true); } catch (err) { console.warn(`ace-qol | a setFlag did not save:`, err); } }
    try { await awaitDsnRoll(); } catch (_) {}

    // LUCKY (2014): an escape check about to fail, before the hold stays (luck.mjs).
    try {
      const lk = await luckAgainstDC({ actor, kind: "check",
        what: `${String(ability).toUpperCase()} check to break free (DC ${dc})`,
        roll: bfRoll, total, d20: dieFace, dc, dice: "show" });
      if (lk.spent) { total = lk.total; dieFace = lk.d20; }
    } catch (err) {
      console.warn(`${MODULE_ID} | BreakFree: Lucky could not be offered on ${actor?.name}'s check; it stands as rolled:`, err);
    }

    const passed = total >= dc;
    const modPart = (dieFace != null) ? (() => { const m = total - dieFace; const s = m >= 0 ? "+" : ""; return m === 0 ? "" : ` ${s}${m}`; })() : "";
    const abilityLabel = skill
      ? `${CONFIG.DND5E?.skills?.[skill]?.label ?? String(skill).toUpperCase()} check`
      : `${CONFIG.DND5E?.abilities?.[ability]?.label ?? String(ability).toUpperCase()} check`;

    if (passed) {
      // EVERYTHING THAT GRAB PUT ON COMES OFF (2026-09-29, his table: a chain's
      // Grapple row lands Grappled AND Restrained, and a successful escape used to
      // delete only the effect it was stamped on, leaving the creature Restrained
      // by a grapple that was already over).
      //
      // The ids were recorded when the grab landed, so this can only ever remove
      // what that grab created. A Restrained held by Web, or by anything else, is
      // not in the list and is never touched.
      const alsoHeld = Array.isArray(d.holds) ? d.holds
        : (Array.isArray(eff.flags?.[MODULE_ID]?.breakFree?.holds)
            ? eff.flags[MODULE_ID].breakFree.holds : []);
      const ids = [...new Set([eff.id, ...alsoHeld.map(h => h?.id).filter(Boolean)])];
      const freed = [];
      for (const id of ids) {
        const e = actor.effects?.get?.(id);
        if (!e) continue;
        try { await e.delete(); freed.push(e.name ?? id); }
        catch (_) { /* already gone */ }
      }
      // WHAT THE STAMP HELD, WHAT CAME OFF, WHAT IS LEFT (his rule, 2026-09-29).
      const stillOn = (actor.effects?.contents ?? [])
        .filter(e => !e.disabled)
        .map(e => `${e.name ?? "?"}=${e.id}`);
      console.log(`${MODULE_ID} | BreakFree: ${actor.name} broke out of ${label}.`
        + ` The stamp held ${ids.join(", ") || "nothing"};`
        + ` deleted ${freed.join(", ") || "nothing"};`
        + ` left on ${actor.name}: ${stillOn.join(", ") || "nothing"}.`)
      // Clear the persistent Forge animation (the frozen rope). Try the precise
      // item-name end first; then sweep ANY forge:persist:* effect bound to the
      // freed token — robust even if the flag predates itemUuid tracking.
      try {
        const seqMgr = globalThis.Sequencer?.EffectManager ?? window.Sequencer?.EffectManager;
        if (seqMgr) {
          const itemUuid = d.itemUuid;
          if (itemUuid) { try { await seqMgr.endEffects({ name: `forge:persist:${itemUuid}` }); } catch (_) {} }
          const tokDoc = d.sceneId
            ? game.scenes.get(d.sceneId)?.tokens?.get(d.tokenId)
            : canvas.scene?.tokens?.get(d.tokenId);
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

    // THE PARTS BEHIND THE BONUS (his rule, 2026-09-29): what was rolled, which
    // score, and why each piece of it is there. Read off the sheet, nothing
    // invented; if it cannot be read the card is exactly what it was.
    let formulaFor = "";
    try {
      const { parts } = explainCheck(actor, skill ? { skill } : { ability });
      formulaFor = formulaPill(parts, { total: (dieFace != null) ? (total - dieFace) : null,
        label: skill ? "check" : "ability" });
    } catch (err) {
      console.warn(`${MODULE_ID} | BreakFree: could not read what made ${actor?.name}'s `
        + `bonus, so the card shows the roll alone:`, err);
    }

    const color = passed ? "#9bcc4a" : "#d98b46";
    const verdict = passed
      ? `Broke free of ${foundry.utils.escapeHTML(label)}!`
      : `The ${foundry.utils.escapeHTML(label)} holds — still entangled.`;
    await ChatMessage.create({
      speaker: ChatMessage.getSpeaker({ actor }),
      ...(whisperTo?.length ? { whisper: whisperTo } : {}),
      content: `
        <div style="border:1px solid ${color}55;border-radius:8px;padding:12px 14px;background:linear-gradient(180deg,#14140c,#0c0c08);font-family:'Signika',sans-serif;">
          <div style="display:flex;align-items:center;gap:10px;">
            ${aceD20FaceImg(dieFace, { size: 38, glow: true })}
            <span style="color:#e8e6d8;font-size:16px;line-height:1.25;">
              <b>${foundry.utils.escapeHTML(actor.name)}</b> — ${abilityLabel}<br/>
              <b style="color:#fff;font-size:18px;">${dieFace ?? total}</b><span style="color:#b9a978;">${modPart} =</span> <b style="color:${color};font-size:18px;">${total}</b> <span class="ace-qol-dc" data-dc-roller="${actor?.id ?? ""}"><span style="color:#b9a978;">vs DC ${dc}</span></span>
            </span>
          </div>
          <div style="margin-top:7px;color:${color};font-weight:700;font-size:15px;">${verdict}</div>
          ${formulaFor}
        </div>`,
      /* ⚠️🔴 DO NOT HIDE THE ESCAPE CHECK (his rule, 2026-10-04): "It is the
         target's check, not a second attack." ACE hides every chat card that
         carries a dnd5e flag and no ACE type of its own, and every suppressor in
         this suite reads that same marker. The escape result is ACE's own card
         about the held creature's own check, so it says so and nothing can
         mistake it for the system's leftovers. */
      flags: { [MODULE_ID]: { type: "breakFreeResult", passed, dc } },
    });

    // Grey out the prompt now that it's resolved.
    btn?.closest?.(".ace-qol-breakfree-card")?.style.setProperty("opacity", "0.6");
    if (btn) btn.innerHTML = passed ? '<i class="fas fa-check"></i> Free' : '<i class="fas fa-xmark"></i> Held';
    return { passed, total, dieFace, dc };
  }

  /**
   * The automatic escape: no dialog, no buttons, no question.
   *
   * ⚠️ HIS RULE, 2026-09-29: "Roll the higher of the victim's Strength (Athletics)
   * and Dexterity (Acrobatics) against the stamped DC. One whisper to the victim's
   * owners: what was rolled, which score, pass or fail."
   *
   * ⚠️ THE BETTER SKILL, NOT THE BETTER ABILITY. Athletics and Acrobatics carry
   * proficiency and expertise; a rogue with Acrobatics expertise and a middling
   * DEX beats their own raw Strength. The totals dnd5e has already worked out are
   * what is compared, so every bonus on the sheet counts.
   */
  static async _autoAttempt(actor, combatant, eff, meta, round, turn) {
    try {
      await eff.update({
        [`flags.${MODULE_ID}.breakFree.promptedRound`]: round,
        [`flags.${MODULE_ID}.breakFree.promptedTurn`]: turn,
      });
      const skills = actor.system?.skills ?? {};
      const ath = Number(skills.ath?.total ?? skills.ath?.mod);
      const acr = Number(skills.acr?.total ?? skills.acr?.mod);
      const haveAth = Number.isFinite(ath), haveAcr = Number.isFinite(acr);
      let skill = null, ability = meta.ability || "str";
      if (haveAth || haveAcr) {
        skill = (!haveAcr || (haveAth && ath >= acr)) ? "ath" : "acr";
        ability = skill === "ath" ? "str" : "dex";
      } else {
        // No skill block at all (a bare NPC): fall back to the raw ability, and
        // say so rather than pretending a skill was rolled.
        const rd = actor.getRollData?.() ?? {};
        ability = (abilityMod(rd, "dex") > abilityMod(rd, "str")) ? "dex" : "str";
        console.log(`${MODULE_ID} | BreakFree: ${actor.name} has no Athletics or Acrobatics on `
          + `its sheet, so its escape is a raw ${ability.toUpperCase()} check.`);
      }
      const owners = game.users?.filter(u => u.active
        && (u.isGM || actor.testUserPermission?.(u, "OWNER"))).map(u => u.id) ?? [];
      const tokenId = combatant?.token?.id ?? combatant?.tokenId ?? null;
      const sceneId = combatant?.token?.parent?.id ?? canvas.scene?.id ?? null;
      console.log(`${MODULE_ID} | BreakFree: ${actor.name} tries to escape "${meta.label}" `
        + `automatically — ${skill ? (skill === "ath" ? "Athletics" : "Acrobatics") : ability.toUpperCase()} `
        + `vs DC ${meta.dc}. Nobody is asked.`);
      await this._attempt(null, {
        actorUuid: actor.uuid, effectId: eff.id, ability, skill,
        dc: meta.dc, label: meta.label || "the grapple",
        itemUuid: meta.itemUuid ?? null, tokenId, sceneId,
        whisperTo: owners.length ? owners : [game.user.id],
      });
    } catch (err) {
      console.warn(`${MODULE_ID} | BreakFree: the automatic escape for ${actor?.name} failed, `
        + `so it stays held:`, err);
    }
  }
}
