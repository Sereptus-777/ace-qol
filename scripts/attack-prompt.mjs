// ─── ACE: QOL — Attack Prompt ─────────────────────────────────────────────────
// Two pieces of UX wired into the weapon-attack flow:
//
//   1. showCenterToast(message)
//      Centered fade-in/out notice. Used for "select a target" nudge.
//
//   2. showAdvantagePrompt({ attacker, target, suggested, reasons })
//      Three-button dialog (Advantage / Normal / Disadvantage). The button
//      ace-qol auto-detected is pre-focused so Enter accepts the suggestion.
//
// Returns one of: "advantage" | "normal" | "disadvantage" | null (cancelled).
// ──────────────────────────────────────────────────────────────────────────────

import { MODULE_ID } from "./ace-qol.mjs";

/**
 * Wait for Dice So Nice to finish animating before posting result cards.
 * Hides the result number while dice are still tumbling so it's not spoiled.
 *
 * EVENT-BASED (punch-list #14, "do it right" — 2026-07-10): resolves the
 * moment DSN reports the animation complete, so one quick d20 reveals fast
 * and a fistful of damage dice gets its full tumble. The configured delay is
 * now only a CAP — if DSN never fires (3D disabled for this roll, module
 * mid-toggle, animation skipped), the cap resolves and nothing ever hangs.
 * Worst case equals the old fixed-delay behavior; typical case is faster
 * AND spoiler-proof.
 *
 * @param {number} [fallbackMs] - override the configured cap (ms)
 * @param {object} [opts]
 * @param {string} [opts.messageId] - only accept DSN completion for this
 *                 chat message (omit = first completion after we start waiting)
 * @returns {Promise<void>}
 */
export async function awaitDsnRoll(fallbackMs = null, { messageId = null, useArmed = false } = {}) {
  // ⚠️🔴 THIS USED TO BE A TIMER RACING A HOOK, AND THE TIMER USUALLY WON.
  // It resolved on whichever came first: diceSoNiceRollComplete, or a flat
  // 3-second cap. So on a big handful of dice or a slow renderer the card
  // appeared while the dice were still rolling - the exact thing Johnny asked
  // me to actually verify rather than assume (2026-08-21).
  //
  // Meanwhile dsn-utils.mjs already had the correct implementation, waiting on
  // the promises Dice So Nice itself resolves when the dice stop. It was in use
  // by the save and damage paths and NOT by the attack path, so attacks - the
  // most-watched rolls at the table - had the weakest check in the suite.
  // One delegation fixes all ten call sites.
  const { awaitDiceSettle } = await import("./dsn-utils.mjs");
  return awaitDiceSettle(fallbackMs ?? undefined, { messageId, useArmed });
}

/** @deprecated kept only so the old body is not resurrected by accident. */
async function _awaitDsnRollLegacy(fallbackMs = null, { messageId = null } = {}) {
  if (!game.dice3d) return; // DSN not active or disabled
  let cap = fallbackMs;
  if (cap == null) {
    try { cap = game.settings.get(MODULE_ID, "dsnRevealDelayMs"); } catch { cap = 3000; }
  }
  if (!Number.isFinite(cap) || cap <= 0) return;

  return new Promise((resolve) => {
    let done = false;
    let hookId = null;
    const finish = () => {
      if (done) return;
      done = true;
      try { if (hookId != null) Hooks.off("diceSoNiceRollComplete", hookId); } catch (_) { /* non-fatal */ }
      resolve();
    };
    try {
      // Subscribe FIRST — shrinks the finished-before-we-listened race; that
      // race degrades to the old fixed-delay wait, never worse.
      hookId = Hooks.on("diceSoNiceRollComplete", (completedId) => {
        if (messageId && completedId && completedId !== messageId) return;
        // A beat of grace so the last die visually settles before the card.
        setTimeout(finish, 150);
      });
    } catch (_) { /* listener failed → the cap below still resolves */ }
    setTimeout(finish, cap);
  });
}

/**
 * Show a centered toast that fades out after `durationMs`.
 */
export function showCenterToast(message, durationMs = 2500) {
  const toast = document.createElement("div");
  toast.className = "ace-qol-center-toast";
  toast.textContent = message;
  document.body.appendChild(toast);

  requestAnimationFrame(() => toast.classList.add("show"));

  setTimeout(() => {
    toast.classList.add("hide");
    setTimeout(() => toast.remove(), 300);
  }, durationMs);
}

/**
 * Pending user choices keyed by actor id. Set by the prompt, consumed by the
 * preRollAttackV2 hook in attack-pipeline.mjs.
 */
export const pendingAttackChoices = new Map();

/**
 * ACE's OWN consumption prompt — replaces dnd5e's "Consume Item Use?" dialog.
 * (Johnny 2026-07-27. ACE owns every pause — see feedback_gm_attack_dialog_stays.)
 *
 * @returns {Promise<"consume"|"free"|null>} null = cancelled
 */
export async function showConsumePrompt({ itemName, activityName, itemImg = null, cost = 0, available = null, max = null, label = "uses", summary = "" }) {
  const esc = foundry.utils.escapeHTML;
  const enough = available == null || available >= cost;
  const isGM = !!game.user?.isGM;
  const blurb = String(summary ?? "").trim();

  // ── THE ABILITY IS THE BUTTON (Johnny 2026-07-28, from the mockup) ──
  // The old shape was three competing pills in a footer — Use / Use without
  // spending / Cancel — which made "what does this do" the smallest thing on
  // screen. Now there is ONE thing to press and it names the ability itself,
  // with the cost and what's left underneath it.
  // "5 of 5 charges left" was printing `available` on BOTH sides, so it read
  // N of N no matter how many had been spent. The right-hand number is the
  // MAXIMUM. With no max known, just say how many are left. (2026-07-29)
  const remain = available != null
    ? `${available}${max != null ? ` of ${max}` : ""} ${esc(label)} left`
    : "";
  const costLine = cost > 0
    ? `Spends ${cost}${remain ? ` · ${remain}` : ""}`
    : (available != null ? `${available} ${esc(label)} available` : "");

  const content = `
    <div class="ace-qol-act-picker">
      <div class="ace-qol-act-head">
        ${itemImg ? `<img src="${itemImg}" alt="">` : ""}
        <span>${esc(itemName ?? "Item")}</span>
      </div>

      <button type="button" class="ace-qol-use-primary" data-action="ace-use">
        <span class="ace-qol-use-primary-name">${esc(activityName ?? "Use")}</span>
        ${costLine ? `<span class="ace-qol-use-primary-cost">${costLine}</span>` : ""}
      </button>

      ${(isGM && cost > 0) ? `
      <label class="ace-qol-use-consume">
        <input type="checkbox" name="aceConsume" checked>
        <span>Consume item use</span>
      </label>` : ""}

      ${blurb ? `<div class="ace-qol-consume-blurb">${blurb}</div>` : ""}
      ${enough ? "" : `<div class="ace-qol-consume-warn"><i class="fas fa-triangle-exclamation"></i> Not enough ${esc(label)} — using it anyway won't spend any.</div>`}
    </div>`;

  try {
    return await new Promise((resolve) => {
      let settled = false;
      const done = (v) => { if (!settled) { settled = true; resolve(v); } };

      const dlg = new foundry.applications.api.DialogV2({
        window: { title: esc(itemName ?? "Use Ability") },
        classes: ["ace-qol-adv-dialog", "ace-qol-use-dialog"],
        content,
        // ONE footer control. The thin red cancel bar is the standard bottom of
        // every ACE dialog now — same place, same colour, every time.
        buttons: [{ action: "cancel", label: "Cancel" }],
        submit: () => done(null),
        position: { width: 430 },
      });

      dlg.addEventListener?.("close", () => done(null));

      dlg.render({ force: true }).then(() => {
        const root = dlg.element;
        const btn = root?.querySelector?.("[data-action='ace-use']");
        if (!btn) { done("consume"); return; }   // markup failed — never swallow the action
        btn.addEventListener("click", (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          // The check mark IS the "use without spending" choice — unticking it
          // is the GM's override. Players never see it and always consume.
          const box = root?.querySelector?.("input[name='aceConsume']");
          const consume = box ? !!box.checked : true;
          done(consume ? "consume" : "free");
          dlg.close();
        });
      }).catch((err) => {
        console.error(`${MODULE_ID} | showConsumePrompt render failed:`, err);
        done("consume");
      });
    });
  } catch (err) {
    console.error(`${MODULE_ID} | showConsumePrompt failed:`, err);
    return "consume";   // fail toward the normal behavior, never swallow the action
  }
}

/**
 * ACE's OWN activity picker — replaces dnd5e's ActivityChoiceDialog.
 * (Johnny 2026-07-27: "This looks suspiciously like D&D 5e's pop-up." ACE owns
 * every pause — see feedback_gm_attack_dialog_stays.)
 *
 * dnd5e's dialog stays hidden (ACE's CSS already hides .activity-choice) and
 * the caller clicks the chosen row's hidden button, so dnd5e's own use-flow is
 * preserved exactly — we only replace the chrome.
 *
 * @param {object}   opts
 * @param {string}   opts.itemName
 * @param {string}   [opts.itemImg]
 * @param {{id:string,label:string,type:string}[]} opts.activities
 * @returns {Promise<string|null>} chosen activity id, or null if cancelled
 */
export async function showActivityChoice({ itemName, itemImg = null, activities = [], uses = null }) {
  const ICON = {
    attack:  "fa-solid fa-crosshairs",
    save:    "fa-solid fa-hand-sparkles",
    damage:  "fa-solid fa-burst",
    heal:    "fa-solid fa-heart-pulse",
    utility: "fa-solid fa-wand-sparkles",
    summon:  "fa-solid fa-ghost",
    enchant: "fa-solid fa-hat-wizard",
    check:   "fa-solid fa-dice-d20",
  };
  // Each row shows its OWN cost — you can see what every ability spends before
  // you pick one, instead of finding out in a second dialog afterwards.
  const rows = activities.map(a => `
    <button type="button" class="ace-qol-act-row" data-act-id="${a.id}">
      <i class="${ICON[a.type] ?? "fa-solid fa-circle-dot"}"></i>
      <span class="ace-qol-act-name">${foundry.utils.escapeHTML(a.label)}</span>
      ${a.cost ? `<span class="ace-qol-act-cost">${a.cost}</span>` : ""}
      <span class="ace-qol-act-type">${foundry.utils.escapeHTML(a.type ?? "")}</span>
    </button>`).join("");

  // ONE dialog (Johnny 2026-07-27: "it's not a separate thing; it's just a check
  // mark"). The consume toggle lives here, ticked by default, so picking an
  // ability IS the whole interaction — no second "Consume Item Use?" step.
  // GM ONLY (Johnny 2026-07-28). Whether an ability spends a charge is a GM
  // bookkeeping decision, not a question to put in front of a player — they
  // press the ability, it costs what it costs. Players get the ability list and
  // nothing else; their use always consumes normally.
  const usesLine = (uses && game.user?.isGM)
    ? `<label class="ace-qol-act-consume">
         <input type="checkbox" name="aceConsume" checked>
         <span>Consume charges</span>
         <span class="ace-qol-act-pool">${uses.value ?? "?"} / ${uses.max ?? "?"} left</span>
       </label>`
    : "";

  const content = `
    <div class="ace-qol-act-picker">
      <div class="ace-qol-act-head">
        ${itemImg ? `<img src="${itemImg}" alt="">` : ""}
        <span>${foundry.utils.escapeHTML(itemName ?? "Item")}</span>
      </div>
      <div class="ace-qol-act-rows">${rows}</div>
      ${usesLine}
    </div>`;

  try {
    return await new Promise((resolve) => {
      let settled = false;
      const done = (v) => { if (!settled) { settled = true; resolve(v); } };
      const dlg = new foundry.applications.api.DialogV2({
        window: { title: "Choose an Action" },
        classes: ["ace-qol-adv-dialog"],
        content,
        buttons: [{ action: "cancel", label: "Cancel", icon: "fa-solid fa-xmark" }],
        submit: () => done(null),
        position: { width: 420 },
      });
      dlg.addEventListener?.("close", () => done(null));
      dlg.render({ force: true }).then(() => {
        const root = dlg.element;
        for (const btn of root?.querySelectorAll?.(".ace-qol-act-row") ?? []) {
          btn.addEventListener("click", (ev) => {
            ev.preventDefault();
            const consume = root?.querySelector?.('input[name="aceConsume"]');
            // Returns the choice AND the consume decision in one shot.
            done({ id: btn.dataset.actId, consume: consume ? !!consume.checked : true });
            dlg.close();
          });
        }
      });
    });
  } catch (err) {
    console.error(`${MODULE_ID} | showActivityChoice failed:`, err);
    return null;   // caller falls back to dnd5e's own dialog
  }
}

/**
 * ACE's OWN save prompt — the save-side twin of showAdvantagePrompt. dnd5e's
 * "Constitution Saving Throw" dialog must NEVER appear (Johnny 2026-07-27:
 * ACE owns every pause); this is what the roller sees instead. Returns
 * "advantage" | "normal" | "disadvantage" | null (Esc = cancel).
 *
 * @param {object} opts
 * @param {string} opts.creature      whose save it is
 * @param {string} opts.abilityLabel  e.g. "Constitution"
 * @param {number} opts.dc            the DC
 * @param {string} opts.sourceName    what they're saving against (spell/effect)
 * @param {string} [opts.suggested]   ACE's computed mode
 * @param {object[]} [opts.reasons]   [{reason}] why
 * @param {boolean} [opts.isPC]
 */
export async function showSavePrompt({ creature, abilityLabel, dc, sourceName, suggested = "normal", reasons = [], isPC = false, registerAs = null }) {
  const reasonText = reasons.length
    ? reasons.map(r => r.reason ?? r).filter(Boolean).join(" • ")
    : "No situational modifiers detected";
  const suggestedLabel = suggested === "advantage" ? "ADVANTAGE"
                       : suggested === "disadvantage" ? "DISADVANTAGE" : "NORMAL";
  const cls = isPC ? "ace-qol-adv-pc" : "ace-qol-adv-npc";
  const content = `
    <div class="ace-qol-adv-prompt">
      <div class="ace-qol-adv-targets">
        <span class="ace-qol-adv-attacker ${cls}">${foundry.utils.escapeHTML(creature)}</span>
        <i class="fas fa-shield-halved"></i>
        <span class="ace-qol-adv-target">${foundry.utils.escapeHTML(abilityLabel)} save vs DC ${dc}</span>
      </div>
      <div class="ace-qol-adv-suggested">
        ACE-QOL Suggests: <strong class="ace-qol-adv-${suggested}">${suggestedLabel}</strong>
      </div>
      <div class="ace-qol-adv-reason">${foundry.utils.escapeHTML(sourceName ? `${sourceName} — ${reasonText}` : reasonText)}</div>
    </div>`;
  const buttons = [
    { action: "advantage",    label: "Advantage",    icon: "fa-solid fa-arrow-up",   default: suggested === "advantage" },
    { action: "normal",       label: "Normal",       icon: "fa-solid fa-equals",     default: suggested === "normal" },
    { action: "disadvantage", label: "Disadvantage", icon: "fa-solid fa-arrow-down", default: suggested === "disadvantage" },
  ];
  try {
    const result = await foundry.applications.api.DialogV2.wait({
      window: { title: "Saving Throw" },
      classes: ["ace-qol-adv-dialog"],
      content, buttons,
      rejectClose: false,
      position: { width: 440 },
      render: (event, dialog) => {
        const root = dialog?.element ?? event?.currentTarget ?? document;
        const btn = root.querySelector?.(`button[data-action="${suggested}"]`);
        if (btn) btn.classList.add("ace-qol-suggested-btn");
        // Hand the live dialog to the caller so it can be closed remotely (the
        // GM rolling this save instead must retire the player's prompt).
        try { registerAs?.(dialog); } catch (_) { /* optional */ }
      },
    });
    return result ?? null;
  } catch (err) {
    console.error(`${MODULE_ID} | showSavePrompt FAILED — falling back to "${suggested}"`, err?.message ?? err);
    return suggested ?? "normal";
  }
}

/**
 * The same three-button pause, for an ability check or a skill check.
 *
 * ⚠️🔴 WRITTEN BECAUSE THE ROLL WENT PAST HIM IN SILENCE. Johnny, 2026-09-04:
 * "the guy that's inside the lich did a Perception check, and it just
 * automatically rolled disadvantage. It didn't show up in the chat."
 *
 * The step before this was worse in the other direction — dnd5e's own dialog,
 * which is not ours and which he should never see. Suppressing it left a roll
 * that happened with no pause and no card, which is the same bug as a silent
 * early return: right answer, no evidence.
 *
 * ⚠️ IT IS THE SAME PROMPT AS A SAVING THROW ON PURPOSE. `showSavePrompt` right
 * above this is the shape the table already knows: the creature, what is being
 * rolled, what ACE thinks and why, and three buttons with ACE's answer already
 * lit. A check is the same event with a different name, so it gets the same
 * pause rather than a second design.
 *
 * Returns "advantage" | "normal" | "disadvantage", or null if cancelled.
 */
export async function showCheckPrompt({ creature, checkLabel, suggested = "normal",
                                        reasons = [], isPC = false, modifier = null }) {
  const reasonText = reasons.length
    ? reasons.map(r => r.reason ?? r).filter(Boolean).join(" • ")
    : "Nothing on this creature changes this check";
  const suggestedLabel = suggested === "advantage" ? "ADVANTAGE"
                       : suggested === "disadvantage" ? "DISADVANTAGE" : "NORMAL";
  const cls = isPC ? "ace-qol-adv-pc" : "ace-qol-adv-npc";
  const mod = Number.isFinite(Number(modifier))
    ? ` ${Number(modifier) >= 0 ? "+" : ""}${Number(modifier)}` : "";
  const content = `
    <div class="ace-qol-adv-prompt">
      <div class="ace-qol-adv-targets">
        <span class="ace-qol-adv-attacker ${cls}">${foundry.utils.escapeHTML(creature)}</span>
        <i class="fas fa-dice-d20"></i>
        <span class="ace-qol-adv-target">${foundry.utils.escapeHTML(checkLabel)}${mod}</span>
      </div>
      <div class="ace-qol-adv-suggested">
        ACE-QOL Suggests: <strong class="ace-qol-adv-${suggested}">${suggestedLabel}</strong>
      </div>
      <div class="ace-qol-adv-reason">${foundry.utils.escapeHTML(reasonText)}</div>
    </div>`;
  const buttons = [
    { action: "advantage",    label: "Advantage",    icon: "fa-solid fa-arrow-up",   default: suggested === "advantage" },
    { action: "normal",       label: "Normal",       icon: "fa-solid fa-equals",     default: suggested === "normal" },
    { action: "disadvantage", label: "Disadvantage", icon: "fa-solid fa-arrow-down", default: suggested === "disadvantage" },
  ];
  try {
    const result = await foundry.applications.api.DialogV2.wait({
      window: { title: "Check" },
      classes: ["ace-qol-adv-dialog"],
      content, buttons,
      rejectClose: false,
      position: { width: 440 },
      render: (event, dialog) => {
        const root = dialog?.element ?? event?.currentTarget ?? document;
        root.querySelector?.(`button[data-action="${suggested}"]`)?.classList.add("ace-qol-suggested-btn");
      },
    });
    return result ?? null;
  } catch (err) {
    console.error(`${MODULE_ID} | showCheckPrompt FAILED — falling back to "${suggested}"`, err?.message ?? err);
    return suggested;
  }
}

/**
 * Full ACE attack pause for ONE attack: assess attacker vs target (advantage /
 * disadvantage + reasons, hidden-reason handling), show the three-button ACE
 * prompt, return the choice ("advantage" | "normal" | "disadvantage") or null
 * if cancelled. Extracted from the weapon Item.use path (2026-07-26) so weapons
 * AND spell attacks — and any future attack shape — share ONE identical pause.
 * The caller stores the choice in pendingAttackChoices and re-fires the roll.
 */
export async function promptAttackChoice(actor, targetToken, item) {
  let suggested = "normal";
  let reasons   = [];
  try {
    const { CombatState } = await import("./combat-state.mjs");
    const { pickHiddenReasonLine } = await import("./hidden-reason-notice.mjs");
    const cs = CombatState.assess(actor, targetToken, item);
    suggested = cs?.finalRollMode || "normal";
    // SHOW THE WORK, always (2026-07-10): a "normal" produced by advantage and
    // disadvantage CANCELING is a rules outcome the table deserves to see.
    const advS = cs?.advantageSources ?? [], disS = cs?.disadvantageSources ?? [];
    const allNotes = cs?.situationalNotes ?? [];
    // gmOnly notes: the GM always sees them; players get a mystery line and the
    // GM gets the socket heads-up. (HARD RULE — no setting.)
    const revealNotes = game.user.isGM;
    const visibleNotes = allNotes.filter(n => revealNotes || !n.gmOnly);
    const suppressed = revealNotes ? [] : allNotes.filter(n => n.gmOnly);

    if (suggested === "advantage")         reasons = advS;
    else if (suggested === "disadvantage") reasons = disS;
    else if (advS.length || disS.length)   reasons = [...advS.map(s => ({ reason: `ADV: ${s.reason}` })),
                                                      ...disS.map(s => ({ reason: `DIS: ${s.reason}` })),
                                                      { reason: "→ they cancel: straight roll (RAW)" }];
    else if (visibleNotes.length)          reasons = visibleNotes.map(n => ({ reason: n.text }));
    else if (suppressed.length)            reasons = [{ reason: pickHiddenReasonLine() }];
    else                                   reasons = [];

    // GM heads-up when a player's prompt hid a reason (GM-roller sees it inline).
    if (suppressed.length && !game.user.isGM) {
      try {
        game.socket.emit(`module.${MODULE_ID}`, {
          action:       "gmHiddenReason",
          attackerName: actor.token?.name ?? actor.name ?? "Attacker",
          targetName:   targetToken?.actor?.name ?? targetToken?.name ?? "Target",
          realReasons:  suppressed.map(n => n.text),
          playerLine:   reasons[0]?.reason ?? "",
          attackerId:   actor.id,
          targetId:     targetToken?.actor?.id ?? targetToken?.id ?? null,
          combatId:     game.combat?.id ?? null,
        });
      } catch (e) { console.warn(`${MODULE_ID} | gmHiddenReason emit failed:`, e); }
    }
  } catch (err) {
    console.warn(`${MODULE_ID} | CombatState.assess failed in prompt:`, err);
  }

  return showAdvantagePrompt({
    attacker:     actor.token?.name ?? actor.name ?? "Attacker",
    target:       targetToken?.actor?.name ?? targetToken?.name ?? "Target",
    suggested,
    reasons,
    attackerIsPC: !!actor?.hasPlayerOwner,
    targetIsPC:   !!targetToken?.actor?.hasPlayerOwner,
  });
}

/**
 * Show the three-button advantage prompt. Pre-focuses the ace-qol-suggested
 * mode so pressing Enter accepts it.
 *
 * @param {object}   opts
 * @param {string}   opts.attacker        - attacker display name
 * @param {string}   opts.target          - target display name
 * @param {string}   opts.suggested       - "advantage" | "normal" | "disadvantage"
 * @param {object[]} opts.reasons         - [{ reason: string }, ...] for the badge text
 * @param {boolean}  opts.attackerIsPC    - true if attacker is player-owned (green vs red)
 * @param {boolean}  opts.targetIsPC      - true if target is player-owned
 * @returns {Promise<"advantage"|"normal"|"disadvantage"|null>}
 */
export async function showAdvantagePrompt({ attacker, target, suggested, reasons = [], attackerIsPC = false, targetIsPC = false }) {
  const reasonText = reasons.length
    ? reasons.map(r => r.reason ?? r).filter(Boolean).join(" • ")
    : "No situational modifiers detected";

  const suggestedLabel = suggested === "advantage"    ? "ADVANTAGE"
                       : suggested === "disadvantage" ? "DISADVANTAGE"
                                                      : "NORMAL";

  const attackerCls = attackerIsPC ? "ace-qol-adv-pc" : "ace-qol-adv-npc";
  const targetCls   = targetIsPC   ? "ace-qol-adv-pc" : "ace-qol-adv-npc";

  const content = `
    <div class="ace-qol-adv-prompt">
      <div class="ace-qol-adv-targets">
        <span class="ace-qol-adv-attacker ${attackerCls}">${foundry.utils.escapeHTML(attacker)}</span>
        <i class="fas fa-arrow-right"></i>
        <span class="ace-qol-adv-target ${targetCls}">${foundry.utils.escapeHTML(target)}</span>
      </div>
      <div class="ace-qol-adv-suggested">
        ACE-QOL Suggests: <strong class="ace-qol-adv-${suggested}">${suggestedLabel}</strong>
      </div>
      <div class="ace-qol-adv-reason">${foundry.utils.escapeHTML(reasonText)}</div>
    </div>
  `;

  const buttons = [
    {
      action: "advantage",
      label: "Advantage",
      icon: "fa-solid fa-arrow-up",
      default: suggested === "advantage",
    },
    {
      action: "normal",
      label: "Normal",
      icon: "fa-solid fa-equals",
      default: suggested === "normal",
    },
    {
      action: "disadvantage",
      label: "Disadvantage",
      icon: "fa-solid fa-arrow-down",
      default: suggested === "disadvantage",
    },
  ];

  try {
    const result = await foundry.applications.api.DialogV2.wait({
      window: { title: "Attack Roll" },
      classes: ["ace-qol-adv-dialog"],
      content,
      buttons,
      rejectClose: false, // Esc resolves to null, not throw
      position: { width: 420 },
      render: (event, dialog) => {
        // Pin a persistent class to the suggested button so the highlight
        // survives focus changes (Foundry's .default class can be focus-tied).
        const root = dialog?.element ?? event?.currentTarget ?? document;
        const btn = root.querySelector?.(`button[data-action="${suggested}"]`);
        if (btn) btn.classList.add("ace-qol-suggested-btn");
      },
    });
    return result ?? null;
  } catch (err) {
    // ── v0.4.22: improved error visibility ──
    // Previous behavior silently fell back to the suggested mode if the
    // dialog rendered with an error. That meant a subtle CSS or module
    // conflict could quietly apply ADVANTAGE or DISADVANTAGE without the
    // GM/player ever knowing. Now we log full context AND show a toast
    // so the issue is visible at the table.
    const fallback = suggested ?? "normal";
    console.error(`${MODULE_ID} | showAdvantagePrompt FAILED — falling back to "${fallback}"`, {
      attacker,
      target,
      suggested,
      reasons,
      attackerIsPC,
      targetIsPC,
      error: err?.message ?? err,
      stack: err?.stack?.substring(0, 600),
    });
    try {
      ui.notifications?.warn(
        `ACE QOL: attack prompt error — using "${fallback}" mode for ${attacker}'s attack on ${target}. Check console for details.`,
        { permanent: false }
      );
    } catch (_) { /* notifications API unavailable */ }
    return fallback;
  }
}
