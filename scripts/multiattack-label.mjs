// ─── ACE: QOL — Multiattack says how many ────────────────────────────────────
//
// Johnny, 2026-09-02: "There is a number that each creature has for what attacks
// it can make in multi-attack, and anywhere that I see multi-attack, I want to
// see that number. That's all I want."
//
// ⚠️🔴 THE NUMBER WAS ALREADY BEING WORKED OUT AND KEPT PRIVATE. The multiattack
// engine has parsed a creature's attack count since the day it was written, and
// spent it entirely on badging the buttons inside its own pop-up. Everywhere
// else — the item tooltip, the sheet, the hover — showed the imported
// description, which on his shadow dragon is the single sentence "The Shadow
// Dragon (Huge) uses Multiattack." That is the whole complaint: a feature that
// exists to say a number, showing everything except the number.
//
// This puts `MultiattackEngine.summaryFor` on screen wherever Multiattack is
// drawn by dnd5e:
//
//   • the rich item tooltip (Item5e#richTooltip -> system.richTooltip)
//   • any sheet row rendered for the item
//
// ⚠️ IT NEVER WRITES TO THE ITEM. Repairing the description would silently
// rewrite his creatures on load, which is the line the hollow-feature checker
// refuses to cross for exactly the same reason. This is presentation only, and
// deleting this file leaves his data untouched.
const MODULE_ID = "ace-qol";

import { MultiattackEngine } from "./multiattack-engine.mjs";

/** Multiattack in either edition, with or without a parenthetical rider. */
const MULTIATTACK_NAME = /^multi[\s-]?attack\b/i;

export class MultiattackLabel {

  static isMultiattack(item) {
    return item?.type === "feat" && MULTIATTACK_NAME.test(String(item?.name ?? ""));
  }

  /** "3 attacks: 2 Claw, 1 Bite", or null when this is not a Multiattack. */
  static labelFor(item) {
    try {
      if (!MultiattackLabel.isMultiattack(item)) return null;
      const s = MultiattackEngine.summaryFor?.(item.actor);
      return s ?? null;
    } catch (err) {
      console.warn(`${MODULE_ID} | could not label Multiattack:`, err);
      return null;
    }
  }

  /**
   * The banner injected at the top of a tooltip.
   *
   * ⚠️ THE LABEL IS ESCAPED BECAUSE IT IS BUILT FROM HIS ITEM NAMES. A weapon
   * called `Claw <of Rending>` would otherwise inject its angle brackets
   * straight into the tooltip markup. Caught auditing this, not in play.
   */
  static _html(summary) {
    const colour = summary.exact ? "#f0d98a" : "#c9b48a";
    const label = foundry.utils.escapeHTML(String(summary.label ?? ""));
    return `<div class="ace-qol-ma-count" style="
        margin:0 0 8px 0; padding:7px 10px; border-radius:5px;
        background:#1d1710; border:1px solid #6b5530;
        color:${colour}; font-size:15px; font-weight:700; line-height:1.35;">
        <i class="fas fa-burst" style="margin-right:6px;"></i>${label}
      </div>`;
  }

  static register() {
    // ── The rich item tooltip ────────────────────────────────────────────
    //
    // ⚠️ PATCHED ON THE CONFIGURED ITEM CLASS, NOT AN IMPORTED ONE. Whatever
    // Foundry has registered is what actually builds the tooltip; grabbing the
    // class by name would miss any module that swapped it, which is the same
    // reason the dead-token click patch reads CONFIG rather than assuming.
    try {
      const ItemClass = CONFIG?.Item?.documentClass;
      if (!ItemClass?.prototype) {
        console.warn(`${MODULE_ID} | no Item document class yet, so Multiattack `
          + `tooltips will not show their attack count.`);
      } else if (!ItemClass.prototype.__aceMultiattackCount) {
        const original = ItemClass.prototype.richTooltip;
        if (typeof original !== "function") {
          console.warn(`${MODULE_ID} | this dnd5e version has no rich item tooltip, `
            + `so the Multiattack count cannot be added to it.`);
        } else {
          ItemClass.prototype.richTooltip = async function (...args) {
            const result = await original.apply(this, args);
            try {
              const summary = MultiattackLabel.labelFor(this);
              if (summary && result?.content) {
                result.content = MultiattackLabel._html(summary) + result.content;
              }
            } catch (err) {
              // ⚠️ A BROKEN BANNER MUST NEVER COST HIM THE TOOLTIP ITSELF.
              console.warn(`${MODULE_ID} | could not add the attack count to this tooltip:`, err);
            }
            return result;
          };
          ItemClass.prototype.__aceMultiattackCount = true;
          console.log(`${MODULE_ID} | Multiattack tooltips now show how many attacks.`);
        }
      }
    } catch (err) {
      console.error(`${MODULE_ID} | Multiattack tooltip patch failed:`, err);
    }

    // ── Sheet rows ───────────────────────────────────────────────────────
    // The item list on a stat block shows the name and nothing else, so the
    // count goes beside the name there too.
    const decorate = (app, html) => {
      try {
        const root = (html instanceof HTMLElement) ? html : (html?.[0] ?? null);
        const actor = app?.document ?? app?.actor;
        if (!root || !actor?.items) return;
        for (const item of actor.items) {
          if (!MultiattackLabel.isMultiattack(item)) continue;
          const summary = MultiattackLabel.labelFor(item);
          if (!summary) continue;
          for (const row of root.querySelectorAll(`[data-item-id="${item.id}"]`)) {
            if (row.querySelector(".ace-qol-ma-inline")) continue;
            const nameEl = row.querySelector(".item-name, .name, .title") ?? row;
            const tag = document.createElement("span");
            tag.className = "ace-qol-ma-inline";
            tag.textContent = ` ×${summary.total}${summary.exact ? "" : "?"}`;
            tag.title = summary.label;
            Object.assign(tag.style, {
              color: summary.exact ? "#f0d98a" : "#c9b48a",
              fontWeight: "700", fontSize: "15px", marginLeft: "6px",
            });
            nameEl.appendChild(tag);
          }
        }
      } catch (err) {
        console.warn(`${MODULE_ID} | could not label Multiattack on this sheet:`, err);
      }
    };
    Hooks.on("renderActorSheet", decorate);
    Hooks.on("renderActorSheetV2", decorate);
  }
}
