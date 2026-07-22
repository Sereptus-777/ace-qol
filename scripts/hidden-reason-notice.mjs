// ─────────────────────────────────────────────────────────────────────────
//  hidden-reason-notice.mjs
//
//  GM heads-up when ACE hides a situational reason from a PLAYER.
//
//  When a player's attack would "obviously" earn advantage (they're standing in
//  magical darkness) but ACE withholds it for a reason that would reveal a
//  creature's hidden senses (the target's truesight / devil's sight), the
//  player sees only a vague mystery line — never the real reason. This module
//  is how the GM still finds out: a GM-only pop-up AND a GM-whisper chat-card
//  record, fired from the player's roll over the socket.
//
//  THREE GATES (all enforced at the emit site in ace-qol.mjs):
//    1. Only when a PLAYER rolled — a GM-roller already sees the reason inline
//       in their own attack prompt, so no redundant pop-up.
//    2. Only when a reason was ACTUALLY hidden — never on a plain empty roll.
//    3. De-duped per encounter — the same attacker → target → reason fires ONCE
//       per combat, so a goblin hacking at the same target every round doesn't
//       nag. New attacker, new target, or new reason = a fresh notice.
// ─────────────────────────────────────────────────────────────────────────
import { MODULE_ID } from "./ace-qol.mjs";

// Player-facing mystery lines, rotated at random so the same situation twice in
// a row doesn't read as a canned string. NONE of these reveal the real reason —
// that's the whole point. (Johnny's picks, #9 flavour: quiet, deliberate.)
export const HIDDEN_REASON_LINES = [
  "Something hidden turns the odds. The GM's silence is deliberate.",
  "Something unseen shifts the odds. Your GM isn't saying what.",
  "A hidden factor turns against you — the GM's silence is on purpose.",
  "Something you can't see tips the balance, and the GM means to keep it that way.",
  "The odds just moved. Your GM knows why, and won't tell.",
  "Something hidden weighs on this roll. The GM's quiet is a choice.",
  "An unseen force turns the odds. The GM holds the answer close.",
  "Something works beneath the surface — your GM's silence says enough.",
  "The balance shifts for reasons unspoken. The GM keeps them.",
  "Something concealed changes the math. The GM stays silent on purpose.",
  "A hidden hand turns the odds, and the GM guards its name.",
];

/** One mystery line at random (never throws). */
export function pickHiddenReasonLine() {
  try {
    return HIDDEN_REASON_LINES[Math.floor(Math.random() * HIDDEN_REASON_LINES.length)];
  } catch (_) {
    return HIDDEN_REASON_LINES[0];
  }
}

// ── Gate #3: de-dupe. One notice per (combat, attacker, target, reason). ──
const _seen = new Set();
function _dedupeKey(p) {
  return [
    p?.combatId ?? "no-combat",
    p?.attackerId ?? "?",
    p?.targetId ?? "?",
    (p?.realReasons ?? []).join("|"),
  ].join("::");
}
// Fresh fight, fresh notices.
Hooks.on("deleteCombat", () => _seen.clear());

const _esc = (s) => foundry.utils.escapeHTML(String(s ?? ""));

/**
 * Shared inner HTML for both the pop-up and the chat-card record. Dialogs pop
 * over Foundry's chrome, so they use bigger fonts per the ACE UI contrast rule
 * (dark wrapper + min sizes); the chat card sits inside styled chat, so it runs
 * a touch smaller.
 */
function _noticeHTML(payload, { forDialog }) {
  const { attackerName, targetName, realReasons = [], playerLine } = payload;
  const reasonList = realReasons.map(r => `<li style="margin:2px 0;">${_esc(r)}</li>`).join("");
  const body = forDialog ? 16 : 13;
  const head = forDialog ? 18 : 14;
  return `
    <div style="background:#14100a;border:1px solid #6b5a2e;border-radius:6px;padding:${forDialog ? 14 : 10}px;color:#f0e4c0;font-size:${body}px;line-height:1.45;">
      <div style="font-size:${head}px;font-weight:bold;color:#d4af37;margin-bottom:6px;display:flex;align-items:center;gap:6px;">
        <i class="fas fa-eye-slash"></i> Hidden From Players
      </div>
      <div style="margin-bottom:8px;">
        <span style="color:#e8c9a0;font-weight:bold;">${_esc(attackerName)}</span>
        <i class="fas fa-arrow-right" style="margin:0 5px;color:#c0b288;"></i>
        <span style="color:#e8a0a0;font-weight:bold;">${_esc(targetName)}</span>
      </div>
      <div style="color:#c0b288;font-size:${body - 1}px;margin-bottom:2px;">The players can't see this:</div>
      <ul style="margin:0 0 8px 18px;padding:0;">${reasonList}</ul>
      <div style="color:#c0b288;font-size:${body - 1}px;margin-bottom:2px;">On the player's card:</div>
      <div style="font-style:italic;color:#b9b090;">&ldquo;${_esc(playerLine)}&rdquo;</div>
    </div>
  `;
}

/**
 * GM-side handler (called from the socket listener, activeGM-gated). Shows the
 * pop-up AND drops the GM-whisper record card. De-dupes per encounter.
 */
export function showGmHiddenReasonNotice(payload) {
  try {
    if (!game.user?.isGM) return;          // belt-and-suspenders (emit is activeGM-gated)
    const key = _dedupeKey(payload);
    if (_seen.has(key)) return;            // gate #3 — one per encounter matchup
    _seen.add(key);

    // 1) Persistent GM-only record card — scroll-back history after the fight.
    try {
      ChatMessage.create({
        content: _noticeHTML(payload, { forDialog: false }),
        whisper: game.users.filter(u => u.isGM).map(u => u.id),
        flags: { [MODULE_ID]: { type: "hiddenReasonNotice" } },
      });
    } catch (e) { console.warn(`${MODULE_ID} | hidden-reason chat card failed:`, e); }

    // 2) In-your-face pop-up — non-blocking, dismissible, impossible to miss.
    try {
      const DV2 = foundry.applications?.api?.DialogV2;
      if (DV2) {
        new DV2({
          window: { title: "ACE — Hidden Modifier (GM only)", icon: "fas fa-eye-slash" },
          classes: ["ace-qol-hidden-reason-dialog"],
          content: _noticeHTML(payload, { forDialog: true }),
          buttons: [{ action: "ok", label: "Got it", icon: "fas fa-check", default: true }],
          position: { width: 460 },
          modal: false,
          rejectClose: false,
        }).render(true);
      } else if (typeof Dialog !== "undefined") {
        new Dialog({
          title: "ACE — Hidden Modifier (GM only)",
          content: _noticeHTML(payload, { forDialog: true }),
          buttons: { ok: { label: "Got it" } },
          default: "ok",
        }).render(true);
      }
    } catch (e) { console.warn(`${MODULE_ID} | hidden-reason pop-up failed:`, e); }
  } catch (err) {
    console.warn(`${MODULE_ID} | showGmHiddenReasonNotice threw (non-fatal):`, err);
  }
}
