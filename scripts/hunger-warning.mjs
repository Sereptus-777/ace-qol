// ─── ACE QOL — Telling them before it bites ──────────────────────────────────
//
// Hunger and thirst were tracked and their consequences applied, and NOTHING
// ever said a word until a level of exhaustion landed on somebody at a long
// rest. Silent punishment reads as a bug: the GM sees a debuff appear with no
// warning, and the player has no chance to act on the information their
// character absolutely would have.
//
// So: one card at dawn, listing anybody who is going without, how many days,
// and how close they are to the line. It fires off the day rollover, not off
// the rest, because that is the point — you learn you are in trouble BEFORE
// the rest, while there is still a day to hunt, forage or ration.
//
// ⚠️ THE LIMITS ARE IMPORTED, NEVER RESTATED. `daysWithoutFood` lives in
// sustenance.mjs and is the same function the exhaustion maths uses. A warning
// that computes the threshold its own way will eventually disagree with the
// thing it is warning about, and the version that says "you are fine" while
// exhaustion lands is worse than no warning at all. One function, both callers.
//
// ⚠️ GM-ONLY, WHISPERED. A public card announcing every PC's hunger would hand
// players information about each other that their characters may not have, and
// it is the GM who decides what the party notices.

import { MODULE_ID } from "./ace-qol.mjs";
import { daysWithoutFood } from "./sustenance.mjs";

const LOG = `${MODULE_ID} | Hunger`;

/** Party PCs, the same set the meal resolver feeds. */
function _partyActors() {
  try {
    const out = [];
    for (const u of game.users ?? []) {
      const a = u.character;
      if (a && !out.includes(a)) out.push(a);
    }
    // Fall back to owned player characters if nobody has an assigned actor.
    if (!out.length) {
      for (const a of game.actors ?? []) {
        if (a.type === "character" && a.hasPlayerOwner) out.push(a);
      }
    }
    return out;
  } catch (_) { return []; }
}

function _conMod(actor) {
  return Number(actor?.system?.abilities?.con?.mod) || 0;
}

export const HungerWarning = {
  register() {
    Hooks.on(`${MODULE_ID}.dayChanged`, (info) => {
      try { HungerWarning.report(info); }
      catch (err) { console.warn(`${LOG} | dawn report failed:`, err); }
    });
    console.debug(`${LOG} | watching for the day to turn`);
  },

  /**
   * Who is in trouble, and how much? Returns the rows so this is testable
   * without a chat card, and posts the card as a side effect.
   */
  report() {
    if (game.users?.activeGM !== game.user) return [];
    let enabled = true;
    try { enabled = game.settings.get(MODULE_ID, "sustenanceEnabled") !== false; } catch (_) {}
    if (!enabled) return [];

    const rows = [];
    for (const actor of _partyActors()) {
      const hungry  = Number(actor.getFlag(MODULE_ID, "daysHungry"))  || 0;
      const thirsty = Number(actor.getFlag(MODULE_ID, "daysThirsty")) || 0;
      if (!hungry && !thirsty) continue;

      const limit = daysWithoutFood(_conMod(actor));
      const parts = [];
      let severity = "warn";

      if (hungry) {
        const left = limit - hungry;
        if (left > 0) {
          parts.push(`${hungry} day${hungry === 1 ? "" : "s"} without food — ${left} more before exhaustion`);
        } else {
          severity = "bad";
          parts.push(`${hungry} days without food — PAST the ${limit}-day limit, exhaustion each day now`);
        }
      }
      if (thirsty) {
        // RAW is harsh: one day costs a level, two costs two.
        severity = "bad";
        parts.push(thirsty >= 2
          ? `${thirsty} days without water — 2 levels of exhaustion owed`
          : `1 day without water — a level of exhaustion owed`);
      }
      rows.push({ name: actor.name, hungry, thirsty, limit, severity, parts });
    }

    if (rows.length) HungerWarning._card(rows);
    else console.debug(`${LOG} | dawn: nobody going without.`);
    return rows;
  },

  _card(rows) {
    const esc = (s) => foundry.utils.escapeHTML(String(s ?? ""));
    const body = rows.map(r => `
      <div style="padding:6px 0;border-top:1px solid #3a3122;">
        <div style="color:${r.severity === "bad" ? "#e08a7a" : "#d4af37"};font-weight:700;font-size:16px;">
          ${esc(r.name)}
        </div>
        <div style="color:#c9bd94;font-size:15px;line-height:1.5;">
          ${r.parts.map(p => esc(p)).join("<br>")}
        </div>
      </div>`).join("");

    // ⚠️ Dark wrapper. Foundry's card background is light parchment and ACE's
    // cream/gold text is invisible on it — the house rule after several
    // unreadable cards. Body text at 15-16px because this sits over Foundry's
    // own chrome.
    const content = `
      <div style="background:#0f1014;border:1px solid #3a3122;border-left:4px solid #d4af37;
                  border-radius:5px;padding:12px 14px;">
        <div style="font-size:18px;font-weight:700;color:#d4af37;margin-bottom:2px;">A new day</div>
        ${body}
        <div style="margin-top:8px;color:#8a8168;font-size:13px;">
          Rations, foraging or a hunt today will clear this before the next long rest.
        </div>
      </div>`;

    ChatMessage.create({
      content,
      whisper: ChatMessage.getWhisperRecipients("GM").map(u => u.id),
      flags: { [MODULE_ID]: { type: "hungerWarning" } },
    }).catch(err => console.warn(`${LOG} | could not post the dawn card:`, err));

    console.log(`${LOG} | dawn: ${rows.length} character(s) going without.`);
  },
};
