// ─── ACE: QOL — Combat Actions (Disengage / Dodge / Help / Ready) ────────────
// PHB 192-193: standard combat actions beyond Attack/Cast.
//
//   DISENGAGE: your movement doesn't provoke opportunity attacks for the
//              rest of this turn.
//   DODGE:     until your next turn, attacks against you have disadvantage
//              (if you can see the attacker), and you have advantage on
//              DEX saves. Lost if incapacitated or speed = 0.
//   HELP:      target an ally adjacent to a creature; the next attack roll
//              against that creature by your ally has advantage (if made
//              before the start of your next turn).
//   READY:     declare a trigger + reaction. When trigger fires, use the
//              prepared reaction. Costs your reaction.
//
// All four are tracked via Active Effects with statuses Set so other modules
// (and the dnd5e attack flow) can react. Effects auto-expire at the start of
// the actor's next turn (duration tracker / our own cleanup).
//
// API
//   game.aceQol.combatActions.disengage(token)
//   game.aceQol.combatActions.dodge(token)
//   game.aceQol.combatActions.help(token, allyToken, targetToken)
//   game.aceQol.combatActions.ready(token, trigger, reactionDescription)
//
// Effects added to TARGET actor:
//   "ace-qol Disengage"  — flags.ace-qol.disengage = true
//   "ace-qol Dodge"      — flags.ace-qol.dodge     = true
//   "ace-qol Helped"     — flags.ace-qol.helpedBy  = allyId (on the FOE)
//                          + flags.ace-qol.helpedAttackerId = ally
//   "ace-qol Ready"      — flags.ace-qol.ready     = { trigger, description }
// ──────────────────────────────────────────────────────────────────────────────

import { MODULE_ID } from "./ace-qol.mjs";
import { QolSettings } from "./settings.mjs";

// Hardcoded literal — TDZ-safe (see stealth-engine.mjs comment)
const FLAG_NS = "ace-qol";

export class CombatActions {

  static init() {
    // Auto-expire all four action effects at the start of the actor's next turn
    Hooks.on("combatTurnChange", async (combat /*, prior, current */) => {
      try {
        if (!game.user.isGM) return;
        const prior = combat?.previous?.combatantId
          ? combat?.combatants?.get?.(combat.previous.combatantId)
          : null;
        if (!prior?.actor) return;
        await CombatActions._clearTurnActions(prior.actor);
      } catch (err) {
        console.warn(`${MODULE_ID} | CombatActions cleanup threw:`, err);
      }
    });

    console.debug(`${MODULE_ID} | CombatActions online`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Public API
  // ═══════════════════════════════════════════════════════════════════════════

  static async disengage(tokenOrDoc) {
    const actor = (tokenOrDoc?.actor ?? tokenOrDoc?.document?.actor);
    if (!actor) return null;
    return CombatActions._applyEffect(actor, {
      name: "Disengage",
      icon: "icons/skills/movement/feet-winged-glowing-yellow.webp",
      flagKey: "disengage",
      description: "Your movement doesn't provoke opportunity attacks for the rest of this turn (PHB 192).",
      icon_emoji: "🏃",
    });
  }

  static async dodge(tokenOrDoc) {
    const actor = (tokenOrDoc?.actor ?? tokenOrDoc?.document?.actor);
    if (!actor) return null;
    // Speed-0 / incapacitated guard
    const speed = Number(actor.system?.attributes?.movement?.walk ?? 0);
    if (speed <= 0) {
      ui.notifications?.warn(`${actor.name} cannot Dodge — speed is 0.`);
      return null;
    }
    if (actor.statuses?.has?.("incapacitated")) {
      ui.notifications?.warn(`${actor.name} cannot Dodge — incapacitated.`);
      return null;
    }
    return CombatActions._applyEffect(actor, {
      name: "Dodge",
      icon: "icons/skills/movement/feet-armored-walking.webp",
      flagKey: "dodge",
      description: "Until your next turn: attacks against you have disadvantage (if you see attacker), and DEX saves are at advantage (PHB 192).",
      icon_emoji: "🛡️",
    });
  }

  static async help(tokenOrDoc, allyTokenOrDoc, targetTokenOrDoc) {
    const helper = (tokenOrDoc?.actor ?? tokenOrDoc?.document?.actor);
    const ally   = (allyTokenOrDoc?.actor ?? allyTokenOrDoc?.document?.actor);
    const foe    = (targetTokenOrDoc?.actor ?? targetTokenOrDoc?.document?.actor);
    if (!helper || !ally || !foe) {
      ui.notifications?.error("Help action requires a helper, an ally, and a target.");
      return null;
    }
    // Apply effect to the FOE (advantage on next attack against it by the ally)
    return CombatActions._applyEffect(foe, {
      name: `Helped by ${helper.name}`,
      icon: "icons/skills/social/diplomacy-handshake.webp",
      flagKey: "helpedAttackerId",
      flagValue: ally.id,
      description: `Next attack against this target by ${ally.name} has advantage (PHB 192).`,
      icon_emoji: "🤝",
    });
  }

  static async ready(tokenOrDoc, trigger, reactionDescription) {
    const actor = (tokenOrDoc?.actor ?? tokenOrDoc?.document?.actor);
    if (!actor) return null;
    return CombatActions._applyEffect(actor, {
      name: "Ready",
      icon: "icons/skills/melee/strike-sword-ready.webp",
      flagKey: "ready",
      flagValue: { trigger: trigger ?? "(unspecified trigger)", description: reactionDescription ?? "(unspecified reaction)" },
      description: `Ready: when "${trigger}" — ${reactionDescription} (PHB 193).`,
      icon_emoji: "⏱️",
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Internal
  // ═══════════════════════════════════════════════════════════════════════════

  static async _applyEffect(actor, opts) {
    try {
      const effData = {
        name: `ACE: ${opts.name}`,
        icon: opts.icon,
        img:  opts.icon,
        origin: actor.uuid,
        duration: { rounds: 1, startRound: game.combat?.round, startTurn: game.combat?.turn },
        flags: {
          [FLAG_NS]: {
            combatAction:  true,
            actionName:    opts.name,
            [opts.flagKey]: opts.flagValue ?? true,
          },
        },
      };
      const created = await actor.createEmbeddedDocuments("ActiveEffect", [effData]);
      // Chat card
      await ChatMessage.create({
        speaker: ChatMessage.getSpeaker({ actor }),
        content: `<div class="ace-qol-action-card"><strong>${opts.icon_emoji ?? ""} ${actor.name} ${opts.name}</strong><br/>${opts.description}</div>`,
        flags: { [MODULE_ID]: { type: "combatAction", action: opts.name, actorId: actor.id } },
      });
      return created?.[0] ?? null;
    } catch (err) {
      console.warn(`${MODULE_ID} | _applyEffect ${opts.name} failed:`, err);
      return null;
    }
  }

  /**
   * Delete all ACE-applied combat-action effects on this actor.
   * Called from combatTurnChange when this actor's turn ends.
   */
  static async _clearTurnActions(actor) {
    try {
      const effects = (actor.effects?.contents ?? []).filter(e =>
        e?.flags?.[FLAG_NS]?.combatAction === true
      );
      if (!effects.length) return;
      const ids = effects.map(e => e.id);
      await actor.deleteEmbeddedDocuments("ActiveEffect", ids);
    } catch (err) {
      console.warn(`${MODULE_ID} | _clearTurnActions failed for ${actor?.name}:`, err);
    }
  }
}
