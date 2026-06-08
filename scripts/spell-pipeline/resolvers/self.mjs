// ─── ACE: QOL — Pipeline Resolver: Self ───────────────────────────────────────
// Self spells apply an ActiveEffect to the caster directly — no picker.
// Mage Armor, Shield, Mirror Image, Stoneskin, Blur, Greater Invisibility (self),
// Foresight, Fly (self), Spider Climb, Longstrider, Sanctuary (on self).
//
// Effect application goes through ConditionLibrary.applyEffect(actor, key, opts)
// which manages duration, concentration, icon, and statuses uniformly.
// ──────────────────────────────────────────────────────────────────────────────

import { MODULE_ID } from "../../ace-qol.mjs";
import { ConditionLibrary } from "../../condition-library.mjs";

export class SelfResolver {

  /**
   * Run a self-shape spell — apply the registry entry's `effect` to the caster.
   * @param {object} ctx - { entry, item, actor, castLevel, ... }
   */
  static async run(ctx) {
    const { entry, item, actor, castLevel } = ctx;
    if (!actor) return;

    const effectKey = entry.effect?.key;
    if (!effectKey) {
      console.warn(`${MODULE_ID} | SelfResolver: registry entry for "${item.name}" missing effect.key — falling through to dnd5e default`);
      return;
    }

    try {
      // Pass cast level so the effect can scale (e.g. Aid +5/+10/+15 by upcast)
      await ConditionLibrary.applyEffect(actor, effectKey, {
        castLevel,
        spellItem: item,
        spellLevel: castLevel,
      });
      console.debug(`${MODULE_ID} | SelfResolver: applied "${effectKey}" to ${actor.name} (L${castLevel})`);

      // Post a small confirmation chat card
      await SelfResolver._postChatCard(item, actor, castLevel, entry);
    } catch (err) {
      console.error(`${MODULE_ID} | SelfResolver: applyEffect failed for "${item.name}":`, err);
    }
  }

  static async _postChatCard(item, actor, castLevel, entry) {
    const accent = "#c9a76b";
    const flavor = entry.flavorOnConfirm || `${actor.name} casts ${item.name} on themselves.`;
    const html = `
      <div style="background:linear-gradient(180deg,#1a1410 0%,#0f0a08 100%);
                  border:2px solid ${accent};
                  border-radius:6px;
                  padding:12px 14px;
                  color:#f0e4c0;
                  font-family:'Signika','Helvetica Neue',sans-serif;">
        <div style="display:flex;align-items:center;gap:10px;
                    font-size:15px;font-weight:700;color:${accent};
                    text-transform:uppercase;letter-spacing:0.6px;
                    border-bottom:1px solid #4a3a28;
                    padding-bottom:6px;margin-bottom:8px;">
          <img src="${item.img || "icons/svg/spell.svg"}" style="width:24px;height:24px;border-radius:3px;object-fit:cover;" />
          <span>${item.name.toUpperCase()}${castLevel > (item.system?.level ?? 1) ? ` (L${castLevel})` : ""}</span>
        </div>
        <div style="font-size:14px;line-height:1.5;color:#f0e4c0;">
          <strong style="color:#e8d49a;">${actor.name}</strong> ${flavor.replace(`${actor.name}`, "").trim() || "is affected."}
        </div>
      </div>
    `;
    try {
      await ChatMessage.create({
        speaker: ChatMessage.getSpeaker({ actor }),
        content: html,
        flavor,
      });
    } catch (err) {
      console.warn(`${MODULE_ID} | SelfResolver: chat post failed:`, err);
    }
  }
}
