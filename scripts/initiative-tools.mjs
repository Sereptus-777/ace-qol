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

    console.debug(`${MODULE_ID} | InitiativeTools online`);
  }

  /**
   * Get the encounter, creating it if there is not one yet.
   *
   * ⚠️🔴 THE WHOLE POINT OF PRESSING "ROLL INITIATIVE" IS TO START THE FIGHT.
   * Johnny, 2026-09-06: *"PCs and even NPCs cannot just roll initiative and
   * start an encounter... I need to fucking start by initiative, not by me
   * creating an encounter."* Three separate places in ACE answered a press with
   * some version of "there is no encounter, make one first", which turns the
   * one gesture the table actually performs into a prerequisite for itself.
   * RAW, any combatant can initiate: the assassin out of stealth, the knife in
   * the tavern. Rolling IS the start.
   *
   * @returns {Promise<Combat|null>}
   */
  static async ensureCombat() {
    if (game.combat) return game.combat;
    if (!game.user.isGM) {
      // A player has no permission to create the document. The patched
      // `Actor#rollInitiative` routes that through the GM by socket, so the
      // single-creature paths still work; a bulk roll is GM-only anyway.
      ui.notifications?.warn("Only the GM can open a new encounter from here.");
      return null;
    }
    const scene = canvas?.scene ?? game.scenes?.viewed;
    if (!scene) {
      ui.notifications?.error("ACE: cannot start an encounter — no scene is being viewed.");
      return null;
    }
    try {
      // ⚠️ `getDocumentClass` RATHER THAN THE BARE `Combat` GLOBAL. Foundry V13
      // still exposes the legacy globals, V14 does not, and this is the call
      // core itself makes.
      const cls = foundry.utils.getDocumentClass?.("Combat") ?? globalThis.Combat;
      return await cls.create({ scene: scene.id, active: true });
    } catch (err) {
      console.error(`${MODULE_ID} | could not open an encounter:`, err);
      ui.notifications?.error("ACE: could not open an encounter — see the console.");
      return null;
    }
  }

  /**
   * Put the creatures of one kind into the encounter.
   *
   * ⚠️ SELECTION FIRST, THE SCENE SECOND, AND IT SAYS WHICH. A GM with tokens
   * selected means those tokens. A GM with nothing selected pressing "Roll
   * NPCs" means the fight in front of him. Guessing silently between those two
   * is how a button becomes untrustworthy, so the notification names what it
   * used and how many it added.
   *
   * ⚠️ AN EXISTING ROSTER IS NEVER INVADED. This only runs when the encounter
   * has nobody of that kind in it. A GM who deliberately left two of the four
   * wolves out keeps them out.
   *
   * @param {Combat} combat
   * @param {"npc"|"pc"} kind
   * @returns {Promise<{added:number, from:string}>}
   */
  static async _populate(combat, kind) {
    const wantsPC = kind === "pc";
    const isKind = (actor) => !!actor && (!!actor.hasPlayerOwner === wantsPC);

    const controlled = (canvas?.tokens?.controlled ?? []).filter(t => isKind(t.actor));
    const from = controlled.length ? "the tokens you have selected" : "every one on this scene";
    const pool = controlled.length
      ? controlled
      : (canvas?.tokens?.placeables ?? []).filter(t => isKind(t.actor));

    const toCreate = [];
    for (const t of pool) {
      if (t.inCombat) continue;
      toCreate.push({
        tokenId: t.id,
        sceneId: t.scene?.id ?? canvas.scene?.id,
        actorId: t.actor?.id,
        // ⚠️ A HIDDEN TOKEN STAYS HIDDEN. An ambush that announces itself in
        // the tracker is not an ambush. `preCreateCombatant` may hide NPCs on
        // top of this when the GM has asked for that.
        hidden: !!t.document?.hidden,
      });
    }
    if (!toCreate.length) return { added: 0, from };
    try {
      await combat.createEmbeddedDocuments("Combatant", toCreate);
    } catch (err) {
      console.error(`${MODULE_ID} | could not add ${kind} combatants:`, err);
      ui.notifications?.error(`ACE: could not add those creatures to the encounter — see the console.`);
      return { added: 0, from };
    }
    return { added: toCreate.length, from };
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
    // ⚠️ PRESSING THIS IS HOW THE FIGHT STARTS. It used to answer "No active
    // combat encounter." and stop, which made the roll depend on the thing the
    // roll is supposed to cause.
    const combat = await InitiativeTools.ensureCombat();
    if (!combat) return;

    // ⚠️ "NOBODY IS HERE" AND "EVERYBODY HAS ROLLED" ARE DIFFERENT ANSWERS.
    // This used to filter straight to the unrolled ones and, on an empty list,
    // say "All NPCs already rolled initiative." An encounter containing no NPCs
    // at all produced that exact sentence — so Johnny (2026-08-14) hit a button
    // on an EMPTY combat and was told everyone had already rolled. He could see
    // the tracker was empty, which made the module look broken and untrustworthy
    // for something it simply mis-worded. Count the roster first, then decide.
    const rosterOf = () => (combat.combatants?.contents ?? []).filter(c =>
      c.actor && !c.actor.hasPlayerOwner
    );
    let npcs = rosterOf();
    if (!npcs.length) {
      const { added, from } = await InitiativeTools._populate(combat, "npc");
      if (!added) {
        ui.notifications?.warn("There are no NPC tokens to add — drop them on the scene, or select the ones you want.");
        return;
      }
      ui.notifications?.info(`Opened the encounter with ${added} NPC${added === 1 ? "" : "s"} from ${from}.`);
      npcs = rosterOf();
    }
    const targets = npcs.filter(c => c.initiative === null);
    if (!targets.length) {
      ui.notifications?.info(`All ${npcs.length} NPC${npcs.length === 1 ? " has" : "s have"} already rolled initiative.`);
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
    const combat = await InitiativeTools.ensureCombat();
    if (!combat) return;

    // ⚠️ Same distinction as rollAllNpcs — see the note there. An empty encounter
    // must never be reported as "everyone has already rolled".
    const rosterOf = () => (combat.combatants?.contents ?? []).filter(c => c.actor?.hasPlayerOwner);
    let pcs = rosterOf();
    if (!pcs.length) {
      const { added, from } = await InitiativeTools._populate(combat, "pc");
      if (!added) {
        ui.notifications?.warn("There are no player-character tokens to add — drop them on the scene, or select the ones you want.");
        return;
      }
      ui.notifications?.info(`Opened the encounter with ${added} player character${added === 1 ? "" : "s"} from ${from}.`);
      pcs = rosterOf();
    }
    const targets = pcs.filter(c => c.initiative === null);
    if (!targets.length) {
      ui.notifications?.info(`All ${pcs.length} PC${pcs.length === 1 ? " has" : "s have"} already rolled initiative.`);
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
