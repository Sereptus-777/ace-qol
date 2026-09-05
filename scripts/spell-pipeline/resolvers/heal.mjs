// ─── ACE: QOL — Pipeline Resolver: Heal ───────────────────────────────────────
// Single-target heal (Cure Wounds touch, Healing Word ranged) and multi-target
// heal (Mass Cure Wounds, Mass Healing Word). Rolls the entry's heal formula
// per target, applies HP via actor.applyDamage(-amount), posts heal card.
//
// Formula resolution: entry.heal.formula is a function (castLvl, spellMod) → string
// that returns a dice formula. Examples:
//   Cure Wounds: (lvl, mod) => `${lvl}d8 + ${mod}`
//   Heal:        (lvl, mod) => `${70 + (lvl - 6) * 10}`  (flat HP, +10/upcast)
// ──────────────────────────────────────────────────────────────────────────────

import { MODULE_ID } from "../../ace-qol.mjs";
import { safeShowForRoll } from "../../dsn-utils.mjs";

export class HealResolver {

  static async runSingle(ctx, result) {
    const target = result?.target ?? result?.targets?.[0];
    if (!target) {
      console.warn(`${MODULE_ID} | HealResolver.runSingle: no target`);
      return;
    }
    return HealResolver._heal(ctx, [target], false);
  }

  static async runMulti(ctx, result) {
    const targets = result?.targets ?? [];
    if (!targets.length) {
      console.warn(`${MODULE_ID} | HealResolver.runMulti: no targets`);
      return;
    }
    return HealResolver._heal(ctx, targets, true);
  }

  // ─── Core ──────────────────────────────────────────────────────────────────

  static async _heal(ctx, targets, isMulti) {
    const { entry, item, actor, castLevel, spellMod } = ctx;
    const formulaFn = entry.heal?.formula;
    if (typeof formulaFn !== "function") {
      console.error(`${MODULE_ID} | HealResolver: entry for "${item.name}" missing heal.formula function`);
      return;
    }

    const formula = formulaFn(castLevel, spellMod);
    const isRevive = entry.heal?.revivesDead === true;       // Revivify, Raise Dead
    const isStabilize = entry.heal?.stabilizes === true;     // Spare the Dying
    const clearStatuses = Array.isArray(entry.heal?.clearStatuses) ? entry.heal.clearStatuses : null;

    // ⚠️🔴 ONE ROLL OR ONE EACH, AND THE SPELL DECIDES.
    //
    // This rolled fresh dice for every target with a comment claiming that was
    // RAW. For a mass heal it is not. "Each target regains Hit Points equal to
    // 5d8 plus your spellcasting ability modifier" is one roll shared by all of
    // them — the same convention as area damage, and what dnd5e's own
    // implementation does. Rolling per target hands one ally a 9 and another a
    // 34 off a single wave of healing energy.
    //
    // ⚠️ BUT IT IS NOT TRUE OF EVERYTHING HERE, which is why it is a per-entry
    // flag and not a blanket change. Nothing else in the registry heals several
    // creatures with dice, so today this only moves the two mass words — but a
    // future spell that genuinely rolls per creature keeps working by saying
    // nothing.
    const rollOnce = entry.heal?.rollOnce === true;
    let sharedRoll = null;
    if (rollOnce && targets.length > 1) {
      sharedRoll = await new Roll(formula, actor.getRollData()).evaluate();
      console.log(`${MODULE_ID} | ${item.name}: one roll of ${formula} = ${sharedRoll.total}, `
        + `applied to ${targets.length} creature(s).`);
    }

    const results = [];

    for (const c of targets) {
      const targetActor = c.actor;
      if (!targetActor) continue;
      try {
        // ── v0.7.21 — Pre-heal cleanup for revive spells ──
        // Revivify, Raise Dead, Resurrection clear the "dead" status before
        // any HP application — otherwise dnd5e would clamp HP to 0 again.
        if (isRevive) {
          const deadEffect = targetActor.effects?.find(e =>
            e.statuses?.has?.("dead") || String(e.name ?? "").toLowerCase() === "dead"
          );
          if (deadEffect) {
            try { await deadEffect.delete(); } catch (_) { /* non-fatal */ }
          }
        }

        // One shared roll where the spell says so; otherwise fresh per target.
        const roll = sharedRoll ?? await new Roll(formula, actor.getRollData()).evaluate();
        const healAmount = Math.max(0, roll.total);
        const beforeHP = targetActor.system?.attributes?.hp?.value ?? 0;
        const maxHP = targetActor.system?.attributes?.hp?.max ?? 0;
        const newHP = Math.min(maxHP, beforeHP + healAmount);
        const actualHealed = newHP - beforeHP;

        // For stabilize-only spells (Spare the Dying), don't change HP at all
        // but DO clear death saves and the unconscious-from-0-HP status.
        const updateData = isStabilize ? {} : { "system.attributes.hp.value": newHP };

        // ── v0.7.21 — Death-save clearing ──
        // Any heal (or stabilize) that brings a creature from 0 HP back to
        // positive (or stabilizes them at 0) MUST clear the death save
        // tracker. Otherwise dnd5e UI still shows pending death saves.
        if (beforeHP <= 0 || isStabilize) {
          updateData["system.attributes.death.success"] = 0;
          updateData["system.attributes.death.failure"] = 0;
        }

        if (Object.keys(updateData).length) {
          await targetActor.update(updateData);
        }

        // ── v0.7.21 — Post-heal status cleanup ──
        // When a creature goes from 0 HP → positive HP, clear unconscious
        // (the "fell at 0 HP" condition, not the spell-induced one). For
        // Greater/Lesser Restoration, the entry can list explicit statuses
        // to clear (charmed, paralyzed, etc.).
        if ((beforeHP <= 0 && newHP > 0) || isStabilize) {
          // Clear automatic-unconscious-at-0-HP effect
          const unconsciousEffects = targetActor.effects?.filter(e =>
            e.statuses?.has?.("unconscious") || String(e.name ?? "").toLowerCase() === "unconscious"
          ) ?? [];
          for (const uc of unconsciousEffects) {
            try { await uc.delete(); } catch (_) { /* non-fatal */ }
          }
        }
        if (clearStatuses?.length) {
          for (const statusKey of clearStatuses) {
            const eff = targetActor.effects?.find(e =>
              e.statuses?.has?.(statusKey)
              || e.flags?.[MODULE_ID]?.conditionKey === statusKey
              || String(e.name ?? "").toLowerCase() === String(statusKey).replace(/_/g, " ").toLowerCase()
            );
            if (eff) {
              try { await eff.delete(); } catch (_) { /* non-fatal */ }
            }
          }
        }

        results.push({
          name: c.name,
          img: c.img,
          formula,
          rolled: roll.total,
          healed: actualHealed,
          beforeHP,
          afterHP: isStabilize ? beforeHP : newHP,
          maxHP,
          stabilized: isStabilize,
          revived: isRevive && beforeHP <= 0 && newHP > 0,
          clearedStatuses: clearStatuses ?? [],
        });

        try {
          // Sound: rolling-the-dice + heal pop (optional, depends on dnd5e SFX config)
          safeShowForRoll(roll, "healing");
        } catch (_) { /* non-fatal */ }
      } catch (err) {
        console.error(`${MODULE_ID} | HealResolver: roll/apply failed for ${c.name}:`, err);
      }
    }

    await HealResolver._postChatCard(item, actor, results, castLevel, isMulti);
  }

  static async _postChatCard(item, caster, results, castLevel, isMulti) {
    if (!results.length) return;
    const accent = "#7ec97e";
    const totalHealed = results.reduce((s, r) => s + r.healed, 0);
    const targetRows = results.map(r => {
      const hpLine = r.stabilized
        ? `STABILIZED at ${r.beforeHP}/${r.maxHP}`
        : r.revived
          ? `REVIVED — HP ${r.beforeHP} → <strong style="color:#7ec97e;">${r.afterHP}</strong> / ${r.maxHP}`
          : `HP ${r.beforeHP} → <strong style="color:#7ec97e;">${r.afterHP}</strong> / ${r.maxHP}`;
      const numberCol = r.stabilized
        ? `<i class="fas fa-shield-heart" style="font-size:18px;color:${accent};"></i>`
        : `<div style="font-size:18px;font-weight:700;color:${accent};">+${r.healed}</div>`;
      const clearedLine = r.clearedStatuses?.length
        ? `<div style="font-size:11px;color:#9ec99e;font-style:italic;margin-top:2px;">Cleared: ${r.clearedStatuses.join(", ")}</div>`
        : "";
      return `
        <div style="display:flex;align-items:center;gap:8px;padding:6px 8px;background:rgba(126,201,126,0.10);border-radius:4px;margin-bottom:4px;min-width:0;">
          <img src="${r.img || "icons/svg/heal.svg"}" style="width:36px;height:36px;border-radius:50%;object-fit:cover;border:1px solid #5a8a5a;flex-shrink:0;" />
          <div style="flex:1 1 auto;min-width:0;color:#e8d49a;overflow:hidden;">
            <div style="font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${r.name}</div>
            <div style="font-size:12px;color:#c0b288;">${hpLine}</div>
            ${clearedLine}
          </div>
          <div style="flex-shrink:0;">${numberCol}</div>
        </div>
      `;
    }).join("");

    const html = `
      <div style="background:linear-gradient(180deg,#101a10 0%,#080f08 100%);
                  border:2px solid ${accent};
                  border-radius:6px;
                  padding:12px 14px;
                  color:#f0e4c0;
                  font-family:'Signika','Helvetica Neue',sans-serif;">
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;row-gap:4px;
                    font-size:15px;font-weight:700;color:${accent};
                    text-transform:uppercase;letter-spacing:0.6px;
                    border-bottom:1px solid #2a4a2a;
                    padding-bottom:6px;margin-bottom:8px;">
          <img src="${item.img || "icons/svg/heal.svg"}" style="width:24px;height:24px;border-radius:3px;object-fit:cover;flex-shrink:0;" />
          <span style="flex:1 1 auto;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${item.name.toUpperCase()}${castLevel > (item.system?.level ?? 1) ? ` (L${castLevel})` : ""}</span>
          <span style="font-size:14px;flex-shrink:0;">+${totalHealed} total</span>
        </div>
        ${targetRows}
      </div>
    `;
    try {
      await ChatMessage.create({
        speaker: ChatMessage.getSpeaker({ actor: caster }),
        content: html,
        flavor: `${item.name} healed ${results.length} target${results.length === 1 ? "" : "s"} for ${totalHealed} total`,
      });
    } catch (err) {
      console.warn(`${MODULE_ID} | HealResolver: chat post failed:`, err);
    }
  }
}
