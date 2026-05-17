// ============================================================================
//  ACE QOL — Sword of Wounding (DMG magic item)
//
//  RAW: "When you hit a creature with an attack using this magic sword, you
//  can wound the target. At the start of each of the wounded creature's
//  turns, it takes 1d4 necrotic damage for each time you've wounded it,
//  and it can then make a Constitution saving throw (DC 15), ending the
//  effect of all such wounds on itself on a success."
//
//  Implementation:
//   • Hook ace-qol.attackComplete — detect a hit by an item whose name
//     contains "Sword of Wounding" and bump the target's wound counter
//     (flags.ace-qol.wounding.stacks).
//   • Hook combatTurnChange — when the wounded actor's turn begins, roll
//     1d4 per stack, apply necrotic damage, then post a DC 15 CON save
//     card via the save engine. On save success, the actor's wound flag
//     is cleared (via the save's pass callback, simpler: GM just removes
//     the effect manually for now and the save card noting it).
//
//  The Medicine-check escape hatch (DC 15 ally Medicine check) is left to
//  GM judgement — surfaced in the wound chat card.
// ============================================================================

const MODULE_ID = "ace-qol";
const TAG       = `${MODULE_ID} | Wounding`;

const FLAG_KEY  = "wounding";  // flags.ace-qol.wounding = { stacks, sourceUuid }

export class SwordOfWounding {
  static _initialized = false;

  static init() {
    if (this._initialized) return;
    this._initialized = true;

    Hooks.on(`${MODULE_ID}.attackComplete`, (data) => {
      try { this._onAttackComplete(data); }
      catch (err) { console.warn(`${TAG} | attackComplete handler failed:`, err); }
    });

    // At the start of a wounded creature's turn: apply DoT + CON save card.
    Hooks.on("combatTurnChange", (combat /*, prior, current */) => {
      if (!game.user.isGM) return;
      try {
        const currentActorId = combat?.combatant?.actorId
                            ?? combat?.combatants?.get?.(combat?.current?.combatantId)?.actorId
                            ?? null;
        if (!currentActorId) return;
        const currentActor = game.actors.get(currentActorId);
        if (!currentActor) return;
        this._tickWoundedTurn(currentActor);
      } catch (err) {
        console.warn(`${TAG} | combatTurnChange handler failed:`, err);
      }
    });

    // Auto-clear wounds when the wounded actor passes their CON save.
    // Listens to the existing ace-qol.saveComplete hook. We use a 30-second
    // window between "wounding save card posted" and "save resolved" to
    // avoid clearing wounds on incidental other-CON-saves the actor might
    // roll for other effects.
    Hooks.on(`${MODULE_ID}.saveComplete`, async ({ actor, saveAbility, passed }) => {
      if (!game.user.isGM) return;
      try {
        if (!actor || saveAbility !== "con" || !passed) return;
        const wound = actor.getFlag?.(MODULE_ID, FLAG_KEY);
        if (!wound || typeof wound !== "object") return;
        const promptedAt = wound.savePromptedAt;
        if (!promptedAt || (Date.now() - promptedAt) > 30000) return;
        await this.clearWounds(actor);
      } catch (err) {
        console.warn(`${TAG} | save-callback clear failed:`, err);
      }
    });

    console.log(`${TAG} | Sword of Wounding DoT online.`);
  }

  static async _onAttackComplete({ item, actor, hits }) {
    if (!game.user.isGM) return;
    if (!item || !hits?.length) return;
    const nameLower = String(item.name ?? "").toLowerCase();
    if (!nameLower.includes("sword of wounding") && !nameLower.includes("wounding")) return;
    if (!nameLower.includes("wounding")) return;
    // Avoid name-collision false positives — require "wound" substring AND
    // either "sword" or the word "wound" in a magic-item-shaped name.
    if (!/(sword|blade|axe|spear|mace).*wound|wound.*(sword|blade|axe|spear|mace)|wounding/i.test(item.name ?? "")) return;

    for (const hit of hits) {
      const target = hit?.target;
      const tgtActor = target?.actor;
      if (!tgtActor) continue;
      const existing = tgtActor.getFlag?.(MODULE_ID, FLAG_KEY) ?? { stacks: 0, sourceUuid: null };
      const newStacks = (existing.stacks ?? 0) + 1;
      try {
        await tgtActor.setFlag(MODULE_ID, FLAG_KEY, {
          stacks:     newStacks,
          sourceUuid: actor?.uuid ?? null,
          sourceName: actor?.name ?? null,
        });
        this._postWoundedCard(actor, target, newStacks);
      } catch (err) {
        console.warn(`${TAG} | failed to set wounding flag:`, err);
      }
    }
  }

  static async _tickWoundedTurn(actor) {
    const wound = actor.getFlag?.(MODULE_ID, FLAG_KEY);
    if (!wound || typeof wound !== "object") return;
    const stacks = Number(wound.stacks) || 0;
    if (stacks <= 0) return;

    // Roll 1d4 per stack
    const roll = await new Roll(`${stacks}d4`).evaluate();
    const total = roll.total;

    try {
      await actor.applyDamage([{ value: total, type: "necrotic" }]);
    } catch (err) {
      console.warn(`${TAG} | applyDamage failed (no-op, continuing):`, err);
    }

    // Post a tick card + a CON save prompt
    const sourceName = wound.sourceName ?? "the wielder";
    ChatMessage.create({
      content: `<div class="ace-qol-card" style="background:#160808; border:2px solid #a03030; border-radius:6px; padding:10px 12px;">
        <div style="display:flex; align-items:center; gap:10px; margin-bottom:4px;">
          <i class="fas fa-droplet" style="color:#ff7878; font-size:18px;"></i>
          <strong style="color:#ffc8c8;">Wounding — DoT tick</strong>
        </div>
        <div style="color:#e8d8d8; font-size:12px; line-height:1.45;">
          <strong>${foundry.utils.escapeHTML(actor.name)}</strong> takes
          <strong>${total} necrotic</strong> (${stacks}d4) from open wounds dealt by ${foundry.utils.escapeHTML(sourceName)}.
          <br><em style="color:#ccaaaa; font-size:11px;">Make a DC 15 CON save to close all wounds (or an ally within 5 ft can use an Action to make a DC 15 Medicine check).</em>
        </div>
      </div>`,
      speaker: ChatMessage.getSpeaker({ actor }),
      flags: { [MODULE_ID]: { type: "woundingTick", stacks } },
    });

    // Fire a CON save card via the save engine. Stamp savePromptedAt on
    // the wound flag so the saveComplete listener can auto-clear wounds if
    // the actor's CON save passes within the 30-second window.
    try {
      const tokenOnCanvas = canvas.tokens?.placeables?.find(t => t.actor?.id === actor.id);
      const saveEngine = game.aceQol?.saveEngine;
      if (tokenOnCanvas && saveEngine?.postSaveCard) {
        await actor.setFlag(MODULE_ID, FLAG_KEY, {
          ...wound,
          savePromptedAt: Date.now(),
        });
        await saveEngine.postSaveCard(
          { name: "Wounding (DC 15 CON to close)", uuid: null, system: {}, type: "feat" },
          actor,
          [tokenOnCanvas],
          {
            saveAbility: "con",
            saveDC: 15,
            halfOnSave: false,
            damageTypes: ["none"],
            isSpell: false,
            timing: { timing: "INSTANT" },
            activityId: null,
            spellLevel: null,
            skipDelay: true,
          }
        );
      }
    } catch (err) {
      console.warn(`${TAG} | save card post failed (manual prompt only):`, err);
    }
  }

  static _postWoundedCard(attacker, targetToken, stacks) {
    const tgtName = foundry.utils.escapeHTML(targetToken?.name ?? "the target");
    const attName = foundry.utils.escapeHTML(attacker?.name ?? "the attacker");
    ChatMessage.create({
      content: `<div class="ace-qol-card" style="background:#160808; border:2px solid #a03030; border-radius:6px; padding:10px 12px;">
        <div style="display:flex; align-items:center; gap:10px; margin-bottom:4px;">
          <i class="fas fa-droplet" style="color:#ff7878; font-size:18px;"></i>
          <strong style="color:#ffc8c8;">Wounding — Inflicted</strong>
          <span style="color:#888; font-size:11px; margin-left:auto;">stack ${stacks}</span>
        </div>
        <div style="color:#e8d8d8; font-size:12px; line-height:1.45;">
          ${attName} wounds <strong>${tgtName}</strong> — they will take <strong>${stacks}d4 necrotic</strong> at the start of each of their turns.
          <br><em style="color:#ccaaaa; font-size:11px;">A DC 15 CON save (start of turn) or DC 15 Medicine check (ally Action) closes all wounds.</em>
        </div>
      </div>`,
      speaker: ChatMessage.getSpeaker({ actor: attacker }),
      flags: { [MODULE_ID]: { type: "woundingInflicted", stacks } },
    });
  }

  /** Manual API to clear wounds (called by GM or save-engine callback). */
  static async clearWounds(actor, opts = {}) {
    if (!actor) return false;
    if (!actor.getFlag?.(MODULE_ID, FLAG_KEY)) return false;
    await actor.unsetFlag(MODULE_ID, FLAG_KEY);
    if (!opts.silent) {
      ChatMessage.create({
        content: `<div class="ace-qol-card" style="background:#08160a; border:2px solid #4caf50; border-radius:6px; padding:8px 10px;">
          <strong style="color:#a3e8a3;"><i class="fas fa-bandage"></i> Wounds Closed</strong>
          <div style="color:#d8e8d8; font-size:12px; margin-top:3px;">
            ${foundry.utils.escapeHTML(actor.name)}'s wounds knit shut.
          </div>
        </div>`,
        speaker: ChatMessage.getSpeaker({ actor }),
      });
    }
    return true;
  }
}
