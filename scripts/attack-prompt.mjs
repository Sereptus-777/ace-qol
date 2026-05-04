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
 * @param {number} [fallbackMs] - override the configured delay (ms)
 * @returns {Promise<void>}
 */
export async function awaitDsnRoll(fallbackMs = null) {
  if (!game.dice3d) return; // DSN not active or disabled
  let ms = fallbackMs;
  if (ms == null) {
    try { ms = game.settings.get(MODULE_ID, "dsnRevealDelayMs"); } catch { ms = 2000; }
  }
  if (!Number.isFinite(ms) || ms <= 0) return;
  return new Promise(r => setTimeout(r, ms));
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
    console.warn(`${MODULE_ID} | Attack prompt failed:`, err);
    return suggested ?? "normal"; // fail-safe: use suggestion
  }
}
