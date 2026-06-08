// ─── ACE: QOL — Pipeline Resolver: Multi-Buff ─────────────────────────────────
// Apply an ActiveEffect to each of N selected targets.
// Bless, Bane, Faerie Fire, Aid, Beacon of Hope, Shield of Faith (single),
// Heroism, Resistance (cantrip via touch), Spirit Guardians targets.
//
// Concentration: registry entry's effect.duration === "concentration" → the
// effect is automatically tied to the caster's concentration via the dnd5e
// concentration system (handled inside ConditionLibrary.applyEffect).
// ──────────────────────────────────────────────────────────────────────────────

import { MODULE_ID } from "../../ace-qol.mjs";
import { ConditionLibrary } from "../../condition-library.mjs";

export class BuffResolver {

  /**
   * Apply the entry's effect to each target in the picker result.
   * @param {object} ctx - { entry, item, actor, castLevel, ... }
   * @param {object} result - { targets: candidate[] } from UnifiedSpellPicker._showMultiPicker
   */
  static async runMulti(ctx, result) {
    const { entry, item, actor, castLevel } = ctx;
    const targets = result?.targets ?? [];
    if (!targets.length) {
      console.warn(`${MODULE_ID} | BuffResolver.runMulti: no targets`);
      return;
    }

    const effectKey = entry.effect?.key;
    if (!effectKey) {
      console.warn(`${MODULE_ID} | BuffResolver: registry entry for "${item.name}" missing effect.key`);
      return;
    }

    const applied = [];
    const failed = [];
    for (const c of targets) {
      const targetActor = c.actor;
      if (!targetActor) continue;
      try {
        await ConditionLibrary.applyEffect(targetActor, effectKey, {
          castLevel,
          spellItem: item,
          spellLevel: castLevel,
          sourceActorId: actor.id,
        });
        applied.push(c);
      } catch (err) {
        console.error(`${MODULE_ID} | BuffResolver: applyEffect failed for ${targetActor.name}:`, err);
        failed.push(c);
      }
    }

    console.debug(`${MODULE_ID} | BuffResolver: ${item.name} applied "${effectKey}" to ${applied.length}/${targets.length} targets`);

    await BuffResolver._postChatCard(item, actor, applied, failed, castLevel, entry);
  }

  static async _postChatCard(item, caster, applied, failed, castLevel, entry) {
    const accent = "#c9a76b";
    const targetRows = applied.map(c => `
      <div style="display:flex;align-items:center;gap:8px;padding:5px 8px;background:rgba(201,167,107,0.08);border-radius:4px;margin-bottom:3px;">
        <img src="${c.img || "icons/svg/mystery-man.svg"}" style="width:32px;height:32px;border-radius:50%;object-fit:cover;border:1px solid #6b5230;" />
        <span style="flex:1;color:#e8d49a;font-weight:600;">${c.name}</span>
        <i class="fas fa-check" style="color:#7ec97e;font-size:14px;"></i>
      </div>
    `).join("");

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
        ${entry.flavorOnConfirm ? `<div style="font-size:13px;color:#c0b288;margin-bottom:8px;font-style:italic;">${entry.flavorOnConfirm}</div>` : ""}
        <div style="font-size:13px;color:#c0b288;margin-bottom:6px;">Applied to ${applied.length} target${applied.length === 1 ? "" : "s"}:</div>
        ${targetRows}
      </div>
    `;
    try {
      await ChatMessage.create({
        speaker: ChatMessage.getSpeaker({ actor: caster }),
        content: html,
        flavor: `${item.name} applied to ${applied.length} target${applied.length === 1 ? "" : "s"}`,
      });
    } catch (err) {
      console.warn(`${MODULE_ID} | BuffResolver: chat post failed:`, err);
    }
  }
}
