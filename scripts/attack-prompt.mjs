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
export async function awaitDsnRoll(fallbackMs = null, { messageId = null } = {}) {
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
