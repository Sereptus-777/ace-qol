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
import { SpellPipeline } from "../pipeline.mjs";
import { SaveResolver } from "./save.mjs";

export class BuffResolver {

  /**
   * Apply the entry's effect to each target in the picker result.
   * @param {object} ctx - { entry, item, actor, castLevel, ... }
   * @param {object} result - { targets: candidate[] } from UnifiedSpellPicker._showMultiPicker
   */

  /**
   * Resolve an HP-pool spell (2014 Sleep, Color Spray).
   *
   * RAW: roll the pool, then starting with the creature that has the LOWEST
   * current hit points, subtract each creature's current HP from the pool.
   * A creature whose HP the pool can cover is affected; the moment the pool
   * cannot cover the next creature, the spell stops — it does not skip ahead
   * to a smaller one further down the list.
   *
   * ⚠️ THE ORDER IS THE RULE, not a nicety. Sorting by lowest HP first is what
   * makes Sleep a crowd-clearer rather than a boss-killer, and it is exactly
   * what the old implementation threw away by applying to everyone picked.
   *
   * Undead and creatures immune to being charmed are unaffected by Sleep and
   * do not consume any of the pool.
   *
   * @returns {Array|null} the creatures the pool actually covered
   */
  static async _applyHpPool(ctx, result) {
    const { entry, item, actor, castLevel } = ctx;
    const cfg = entry.hpPool ?? {};
    try {
      // Pool formula, scaled for upcasting (Sleep: 5d8 + 2d8 per level above 1st).
      const base = cfg.formula ?? "5d8";
      const perLevel = cfg.perLevel ?? null;
      const extra = (perLevel && castLevel > (cfg.baseLevel ?? 1))
        ? ` + ${castLevel - (cfg.baseLevel ?? 1)}${perLevel}` : "";
      const roll = await new Roll(`${base}${extra}`).evaluate();
      let pool = roll.total;

      try { game.aceQol?.dice?.show?.(roll, "sleep-pool"); } catch (_) {}

      // Eligibility: undead / charm-immune are simply not affected.
      const eligible = [];
      const immune = [];
      for (const c of (result?.targets ?? [])) {
        const a = c.actor;
        if (!a) continue;
        const type = String(a.system?.details?.type?.value ?? "").toLowerCase();
        const ci = Array.from(a.system?.traits?.ci?.value ?? [])
          .map(v => String(v).toLowerCase());
        if ((cfg.excludeTypes ?? []).includes(type) || ci.includes("charmed")) { immune.push(c); continue; }
        eligible.push(c);
      }

      // Lowest current HP first.
      eligible.sort((x, y) =>
        (x.actor.system?.attributes?.hp?.value ?? 0) - (y.actor.system?.attributes?.hp?.value ?? 0));

      const affected = [];
      const spared = [];
      for (const c of eligible) {
        const hp = Number(c.actor.system?.attributes?.hp?.value ?? 0) || 0;
        if (hp <= pool) { pool -= hp; affected.push(c); }
        else { spared.push(c); break; }             // RAW: stop, do not skip ahead
      }

      const say = (list) => list.map(c => c.actor?.name ?? "?").join(", ") || "nobody";
      console.log(`${MODULE_ID} | ${item.name}: pool ${roll.total} (${roll.formula}) → affected ${say(affected)}` +
        `${spared.length ? ` | not enough left for ${say(spared)}` : ""}` +
        `${immune.length ? ` | unaffected: ${say(immune)}` : ""}`);

      await ChatMessage.create({
        speaker: ChatMessage.getSpeaker({ actor }),
        flavor: `${item.name} — ${roll.total} hit points of sleep`,
        content: `<div class="ace-qol-sleep-pool">` +
          `<p><strong>${roll.formula}</strong> → <strong>${roll.total}</strong> HP pool, lowest hit points first.</p>` +
          `<p><strong>Affected:</strong> ${say(affected)}</p>` +
          (spared.length ? `<p><strong>Pool ran out at:</strong> ${say(spared)}</p>` : "") +
          (immune.length ? `<p><strong>Unaffected:</strong> ${say(immune)}</p>` : "") +
          `</div>`,
      });

      return affected;
    } catch (err) {
      // ⚠️ Never silently fall through to "everyone sleeps" — that IS the bug.
      console.error(`${MODULE_ID} | ${item?.name}: HP pool failed to resolve — nobody affected:`, err);
      ui.notifications?.error(`ACE: ${item?.name} could not roll its HP pool. Resolve manually.`);
      return [];
    }
  }

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

    // ── Save-gated debuffs (Bane, Faerie Fire) ──
    // RAW: each target makes a saving throw and the effect lands ONLY on a
    // FAILED save (entry.save.onSuccess === "negate"). Route through the save
    // engine + SaveResolver's effect-on-fail machinery instead of applying the
    // effect to every target unconditionally. Beneficial buffs (Bless, Aid,
    // Haste, …) have no entry.save and keep the unconditional apply below.
    if (entry.save?.ability) {
      return BuffResolver._runMultiWithSave(ctx, result);
    }

    // ── HP-POOL spells (2014 Sleep, Color Spray) ────────────────────────
    // These have no save. Instead the spell rolls a pool of hit points and
    // works its way UP from the lowest-HP creature until the pool runs out.
    // Without that, "multi-buff with no save" means every creature the GM
    // picked drops unconditionally — so a 1st-level Sleep put a 40 HP boss
    // to sleep. (Grok audit 2026-08-18.)
    if (entry.hpPool) {
      const pooled = await BuffResolver._applyHpPool(ctx, result);
      if (pooled) result.targets = pooled;          // survivors are filtered OUT
      if (!result.targets?.length) return;          // pool covered nobody
    }

    // Find the caster's concentration effect for this spell — needed to wire
    // the dependentOn link so target buffs auto-delete when caster ends concentration.
    // v0.7.21: uses shared SpellPipeline.findCasterConcentrationFor (audit dedup).
    const casterConcEffect = SpellPipeline.findCasterConcentrationFor(actor, item);

    const applied = [];
    const failed = [];
    for (const c of targets) {
      const targetActor = c.actor;
      if (!targetActor) continue;
      try {
        // ── v0.7.21 — Replace, don't stack on re-cast ──
        // If the target already has THIS spell's effect (e.g. re-casting Haste
        // on the same target), delete the old one cleanly first. Flag it as a
        // replacement so dependent post-end hooks (e.g. Haste → Lethargy)
        // know to skip — the spell didn't ACTUALLY end, it's being refreshed.
        //
        // Also clear any "post-end" debuff that lingered from a prior cast
        // ending (Haste Lethargy is the canonical case). RAW: when you re-Haste
        // a target, you're not also stacking Lethargy on them.
        const existingSame = targetActor.effects?.find(e =>
          e.flags?.[MODULE_ID]?.conditionKey === effectKey
          || String(e.name ?? "").toLowerCase().trim() === String(effectKey).replace(/_/g, " ").toLowerCase().trim()
        );
        if (existingSame) {
          try {
            await existingSame.setFlag(MODULE_ID, "_replacedNotEnded", true);
          } catch (_) { /* non-fatal */ }
          try { await existingSame.delete(); } catch (_) { /* non-fatal */ }
        }
        // Haste-specific: clear the Lethargy debuff if applying fresh Haste
        if (effectKey === "haste") {
          const lethargy = targetActor.effects?.find(e =>
            e.flags?.[MODULE_ID]?.conditionKey === "haste_lethargy"
            || String(e.name ?? "").toLowerCase().trim() === "haste lethargy"
          );
          if (lethargy) {
            try { await lethargy.delete(); } catch (_) { /* non-fatal */ }
          }
        }

        const targetEffect = await ConditionLibrary.applyEffect(targetActor, effectKey, {
          castLevel,
          spellItem: item,
          spellLevel: castLevel,
          sourceActorId: actor.id,
          origin: item.uuid,  // tag the buff with the spell's UUID
        });

        // ── Wire dependentOn link so dnd5e auto-deletes the buff when the
        //    caster's concentration ends. v0.7.21: format MUST match what
        //    the legacy `_applySpellEffectWithConcentration` uses — a single
        //    UUID string at `flags.dnd5e.dependentOn`, NOT an array of
        //    relationship objects. dnd5e's concentration teardown follows
        //    the string-uuid form to find dependent effects to delete.
        //    Also stamp our own concentrationOrigin flag for traceability
        //    (mirrors the legacy stamp pattern so existing scans still work).
        // ALWAYS stamp our own concentrationOrigin tag for concentration buffs.
        // The concentration-end sweep (dropConcentrationLinkedEffects) finds the
        // ally's buff PURELY by this tag, so it must be present even when the
        // caster-concentration lookup raced and returned null (dnd5e 5.x
        // activity-origin timing). The dnd5e dependentOn link is added as a BONUS
        // when we have the conc effect, but our sweep is the authoritative
        // cleanup — it must never depend on that link. (Audit 2026-06-27, P0.)
        const isConcentrationBuff = entry.effect?.duration === "concentration";
        if (targetEffect && isConcentrationBuff) {
          try {
            const update = {
              [`flags.${MODULE_ID}.concentrationOrigin`]: {
                casterId:       actor.id,
                spellName:      item.name,
                spellItemId:    item.id,
                concEffectUuid: casterConcEffect?.uuid ?? null,
                stampedAt:      Date.now(),   // protects a fresh re-cast from the old cast's in-flight sweep
              },
            };
            if (casterConcEffect) update["flags.dnd5e.dependentOn"] = casterConcEffect.uuid;
            await targetEffect.update(update);
            console.debug(`${MODULE_ID} | BuffResolver: tagged ${targetActor.name}'s ${effectKey} as ${actor.name}'s concentration${casterConcEffect ? ` + dnd5e link (${casterConcEffect.uuid})` : " (sweep-only — conc effect not found yet)"}`);
          } catch (err) {
            console.warn(`${MODULE_ID} | BuffResolver: concentration tag/link failed (non-fatal):`, err);
          }
        }

        applied.push(c);
      } catch (err) {
        console.error(`${MODULE_ID} | BuffResolver: applyEffect failed for ${targetActor.name}:`, err);
        failed.push(c);
      }
    }

    console.debug(`${MODULE_ID} | BuffResolver: ${item.name} applied "${effectKey}" to ${applied.length}/${targets.length} targets (conc-linked: ${!!casterConcEffect})`);

    await BuffResolver._postChatCard(item, actor, applied, failed, castLevel, entry);
  }

  /**
   * Save-gated multi-target debuff (Bane, Faerie Fire). RAW: each target makes
   * a saving throw and the effect lands ONLY on a failure. Reuses the save
   * engine (NPC auto-roll / PC prompt / the save card) and SaveResolver's
   * tested per-target effect-on-fail + concentration-link machinery — the
   * effect is NEVER applied unconditionally. No "applied to N" summary card is
   * posted: the save card itself is the result display.
   */
  static async _runMultiWithSave(ctx, result) {
    const { entry, item, actor, castLevel, spellMod } = ctx;
    const candidates = (result?.targets ?? []).filter(c => c?.actor);
    if (!candidates.length) {
      console.warn(`${MODULE_ID} | BuffResolver._runMultiWithSave: no targets for "${item.name}"`);
      return;
    }

    // Resolve token placeables for the save engine (defensive: a candidate may
    // carry .token, else fall back to the actor's active token).
    const tokens = candidates
      .map(c => c.token ?? c.actor.getActiveTokens?.()?.[0])
      .filter(Boolean);
    if (!tokens.length) {
      console.warn(`${MODULE_ID} | BuffResolver._runMultiWithSave: no tokens resolved for "${item.name}"`);
      return;
    }

    const saveAbility = entry.save?.ability ?? "wis";
    const saveDC = SaveResolver._computeSaveDC(actor, item, spellMod);

    const saveEngine = game.aceQol?.saveEngine;
    if (saveEngine?.postSaveCard) {
      try {
        await saveEngine.postSaveCard(item, actor, tokens, {
          saveAbility, saveDC,
          halfOnSave: false,        // condition-only: a success fully negates, no damage
          damageTypes: [],
          isSpell: item.type === "spell",
          timing: { isInstant: true, isPersistent: false },
          activityId: ctx.activity?.id,
          spellLevel: castLevel,
        });
      } catch (err) {
        console.error(`${MODULE_ID} | BuffResolver._runMultiWithSave: postSaveCard failed for "${item.name}":`, err);
      }
    } else {
      console.warn(`${MODULE_ID} | BuffResolver._runMultiWithSave: saveEngine.postSaveCard unavailable`);
    }

    // Apply the effect ONLY on a failed save, per target — reuses SaveResolver's
    // saveComplete listener (concentration link + replace-on-recast included).
    if (entry.effect?.key) {
      for (const tk of tokens) SaveResolver._wireEffectOnFail(tk, entry, castLevel, item, actor);
    }
  }

  // _findCasterConcentrationFor moved to SpellPipeline.findCasterConcentrationFor
  // (audit dedup 2026-06-08). All call sites now reference the shared helper.

  static async _postChatCard(item, caster, applied, failed, castLevel, entry) {
    const accent = "#c9a76b";
    const targetRows = applied.map(c => `
      <div style="display:flex;align-items:center;gap:8px;padding:5px 8px;background:rgba(201,167,107,0.08);border-radius:4px;margin-bottom:3px;min-width:0;">
        <img src="${c.img || "icons/svg/mystery-man.svg"}" style="width:32px;height:32px;border-radius:50%;object-fit:cover;border:1px solid #6b5230;flex-shrink:0;" />
        <span style="flex:1 1 auto;min-width:0;color:#e8d49a;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${c.name}</span>
        <i class="fas fa-check" style="color:#7ec97e;font-size:14px;flex-shrink:0;"></i>
      </div>
    `).join("");

    const html = `
      <div style="background:linear-gradient(180deg,#1a1410 0%,#0f0a08 100%);
                  border:2px solid ${accent};
                  border-radius:6px;
                  padding:12px 14px;
                  color:#f0e4c0;
                  font-family:'Signika','Helvetica Neue',sans-serif;">
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;row-gap:4px;
                    font-size:15px;font-weight:700;color:${accent};
                    text-transform:uppercase;letter-spacing:0.6px;
                    border-bottom:1px solid #4a3a28;
                    padding-bottom:6px;margin-bottom:8px;">
          <img src="${item.img || "icons/svg/spell.svg"}" style="width:24px;height:24px;border-radius:3px;object-fit:cover;flex-shrink:0;" />
          <span style="flex:1 1 auto;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${item.name.toUpperCase()}${castLevel > (item.system?.level ?? 1) ? ` (L${castLevel})` : ""}</span>
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
