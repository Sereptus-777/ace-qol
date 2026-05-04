// ─── ACE: QOL — Initiative Tools ─────────────────────────────────────────────
// One-click bulk-roll initiative for NPCs and PCs from the combat tracker.
//
// Adds two buttons to the Combat Tracker header:
//   - "Roll All NPCs"  — rolls initiative for every NPC combatant who hasn't
//                        already rolled (skips PCs)
//   - "Roll All PCs"   — sends a whisper to each PC's owner with a "Roll
//                        Initiative" link, OR (if `pcInitiativeAutoRoll`
//                        setting on) rolls all PCs server-side
//
// dnd5e provides `combatant.rollInitiative()` which respects feats (Alert
// adds +5), proficiency, and Initiative bonuses. We just batch-call it.
//
// SETTINGS
//   - showInitiativeButtons (Boolean, default true)
//   - pcInitiativeAutoRoll  (Boolean, default false — players prefer rolling)
// ──────────────────────────────────────────────────────────────────────────────

import { MODULE_ID } from "./ace-qol.mjs";
import { QolSettings } from "./settings.mjs";

export class InitiativeTools {

  static init() {
    // Inject buttons into the rendered combat tracker
    const _bindButtons = (app, html) => {
      try {
        if (!QolSettings.get?.("showInitiativeButtons")) return;
        const root = html instanceof HTMLElement ? html : (html?.[0] ?? html);
        if (!root || typeof root.querySelector !== "function") return;
        // Avoid double-render (Foundry re-renders the tracker on combat updates)
        if (root.querySelector?.(".ace-qol-init-tools")) return;
        // Find a stable insertion point — the encounter controls or header
        const header = root.querySelector?.("header.combat-tracker-header")
                    ?? root.querySelector?.(".combat-tracker-header")
                    ?? root.querySelector?.("nav.encounters")
                    ?? root.querySelector?.(".encounters")
                    ?? root.querySelector?.("section.directory-header")
                    ?? root.firstElementChild;
        if (!header) return;

        const wrapper = document.createElement("div");
        wrapper.className = "ace-qol-init-tools";
        wrapper.style.cssText = "display:flex;gap:6px;padding:4px 8px;border-bottom:1px solid #d4af37;background:#1a1a1f;";
        wrapper.innerHTML = `
          <button type="button" class="ace-qol-btn" data-action="aceQolRollAllNpcs"
                  style="flex:1;background:#3a2010;color:#ffd87a;border:1px solid #d4af37;padding:4px 6px;border-radius:3px;cursor:pointer;font-size:11px;font-weight:600;">
            <i class="fas fa-dice-d20"></i> Roll NPCs
          </button>
          <button type="button" class="ace-qol-btn" data-action="aceQolRollAllPcs"
                  style="flex:1;background:#1a2030;color:#88c8ff;border:1px solid #2a4060;padding:4px 6px;border-radius:3px;cursor:pointer;font-size:11px;font-weight:600;">
            <i class="fas fa-dice-d20"></i> Roll PCs
          </button>
        `;
        header.parentNode?.insertBefore(wrapper, header.nextSibling);

        wrapper.querySelector("[data-action='aceQolRollAllNpcs']")?.addEventListener("click", () =>
          InitiativeTools.rollAllNpcs());
        wrapper.querySelector("[data-action='aceQolRollAllPcs']")?.addEventListener("click", () =>
          InitiativeTools.rollAllPcs());
      } catch (err) {
        console.warn(`${MODULE_ID} | InitiativeTools button bind threw:`, err);
      }
    };

    Hooks.on("renderCombatTracker", _bindButtons);

    console.log(`${MODULE_ID} | InitiativeTools online`);
  }

  /**
   * Roll initiative for every NPC combatant in the current encounter who
   * hasn't already rolled.
   */
  static async rollAllNpcs() {
    if (!game.user.isGM) {
      ui.notifications?.warn("Only the GM can roll NPC initiative in bulk.");
      return;
    }
    const combat = game.combat;
    if (!combat) {
      ui.notifications?.warn("No active combat encounter.");
      return;
    }
    const targets = (combat.combatants?.contents ?? []).filter(c =>
      c.actor && !c.actor.hasPlayerOwner && c.initiative === null
    );
    if (!targets.length) {
      ui.notifications?.info("All NPCs already rolled initiative.");
      return;
    }
    for (const c of targets) {
      try { await c.rollInitiative(); } catch (err) {
        console.warn(`${MODULE_ID} | NPC initiative roll failed for ${c.name}:`, err);
      }
    }
    ui.notifications?.info(`Rolled initiative for ${targets.length} NPC${targets.length === 1 ? "" : "s"}.`);
  }

  /**
   * Roll initiative for every PC combatant. Whispers each PC's owner if
   * `pcInitiativeAutoRoll` is OFF, else rolls server-side.
   */
  static async rollAllPcs() {
    if (!game.user.isGM) {
      ui.notifications?.warn("Only the GM can issue PC initiative prompts.");
      return;
    }
    const combat = game.combat;
    if (!combat) {
      ui.notifications?.warn("No active combat encounter.");
      return;
    }
    const targets = (combat.combatants?.contents ?? []).filter(c =>
      c.actor?.hasPlayerOwner && c.initiative === null
    );
    if (!targets.length) {
      ui.notifications?.info("All PCs already rolled initiative.");
      return;
    }

    const autoRoll = !!QolSettings.get?.("pcInitiativeAutoRoll");
    if (autoRoll) {
      for (const c of targets) {
        try { await c.rollInitiative(); } catch (err) {
          console.warn(`${MODULE_ID} | PC initiative roll failed for ${c.name}:`, err);
        }
      }
      ui.notifications?.info(`Auto-rolled initiative for ${targets.length} PC${targets.length === 1 ? "" : "s"}.`);
    } else {
      // Whisper each PC's owner with a roll prompt
      const grouped = new Map(); // ownerUserId → combatants[]
      for (const c of targets) {
        const owner = game.users?.find(u => !u.isGM && c.actor.testUserPermission?.(u, "OWNER"));
        if (!owner) continue;
        if (!grouped.has(owner.id)) grouped.set(owner.id, []);
        grouped.get(owner.id).push(c);
      }
      for (const [userId, combatants] of grouped) {
        const names = combatants.map(c => c.name).join(", ");
        await ChatMessage.create({
          whisper: [userId, ...game.users.filter(u => u.isGM).map(u => u.id)],
          content: `<div class="ace-qol-init-prompt" style="background:#1a2030;border:1px solid #2a4060;padding:8px 10px;border-radius:4px;">
            <strong style="color:#88c8ff;">⏱️ Initiative Prompt</strong><br/>
            Roll initiative for: <strong>${names}</strong><br/>
            <em style="color:#aaa;font-size:11px;">Click your token in the tracker, then click the d20 icon — or use a macro.</em>
          </div>`,
          flags: { [MODULE_ID]: { type: "initiativePrompt" } },
        });
      }
      ui.notifications?.info(`Whispered initiative prompts to ${grouped.size} player${grouped.size === 1 ? "" : "s"}.`);
    }
  }
}
