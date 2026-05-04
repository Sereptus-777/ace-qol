// ─── ACE: QOL — Post-Hit Saves ───────────────────────────────────────────────
// Self-contained subsystem for saves triggered after damage is dealt.
// Handles: detection, save card rendering, save rolling, results card,
// condition application, and save-gated bonus damage with full defensive checks.
// ──────────────────────────────────────────────────────────────────────────────

import { MODULE_ID } from "./ace-qol.mjs";
import { QolSettings } from "./settings.mjs";
import { DescriptionParser } from "./description-parser.mjs";
import { DamageConstants } from "./damage-engine.mjs";
import { DamageCalculator } from "./damage-calculator.mjs";
import { ConditionLibrary } from "./condition-library.mjs";

const PHYSICAL_TYPES = new Set(["bludgeoning", "piercing", "slashing"]);

export class PostHitSaves {

  // ═══════════════════════════════════════════════════════════════════════════
  //  Check for Post-Hit Effects
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * After damage is dealt, check the item description for additional effects:
   *   - Saving throws (DC 14 DEX save or be grappled)
   *   - Effect tables (roll d6: 1-2 Decay, 3-4 Grapple, 5-6 Topple)
   *   - Conditions to apply
   *   - Creature-type-gated bonus damage (Giant Slayer)
   */
  static async checkPostHitEffects(item, actor, hits, damageResults) {
    if (!item) return;

    const parsed = DescriptionParser.parse(item);
    if (!parsed.saves.length && !parsed.effectTable && !parsed.hpThresholdRider) return;

    // Only process targets that were actually HIT
    const hitTargets = hits.filter(h => h.hitResult === "hit" || h.hitResult === "critical");
    if (!hitTargets.length) return;

    // ── HP-threshold rider (Mace of Disruption / Smiting) ──
    // Fires AFTER damage is applied. For each hit target whose post-damage HP
    // is at-or-below the rider's threshold, prompt a save. On fail, apply
    // the effect ("destroyed" sets HP to 0; named conditions go through
    // ConditionLibrary).
    if (parsed.hpThresholdRider) {
      try {
        await PostHitSaves._applyHpThresholdRider(item, actor, hitTargets, parsed.hpThresholdRider);
      } catch (err) {
        console.warn(`${MODULE_ID} | HP-threshold rider handling failed:`, err);
      }
    }

    // ── Post-hit save(s) required ──
    // Some weapons have MULTIPLE independent saves (Hammer of Thunderbolts:
    // DC 17 CON instant-death vs giant + DC 17 CON stun in 30-ft AOE).
    // Iterate every parsed save so each posts its own card. The creature-type
    // / damage-immunity / condition-immunity gates inside the loop filter
    // targets per-save, so a save that doesn't apply to anyone simply skips.
    for (const save of parsed.saves) {
      const targetData = hitTargets.map(h => {
        const scene = game.scenes.get(h.sceneId) ?? canvas.scene;
        const tokenDoc = scene?.tokens?.get(h.targetToken?.document?.id ?? h.tokenDocId);
        const targetActor = tokenDoc?.actor ?? game.actors.get(h.targetActor?.id ?? h.actorId);
        const token = tokenDoc?.object;

        return {
          tokenDocId: tokenDoc?.id ?? h.tokenDocId ?? h.targetToken?.document?.id,
          actorId: targetActor?.id ?? h.actorId,
          sceneId: scene?.id,
          name: h.target?.name ?? h.name,
          img: h.target?.img ?? h.img,
          targetActor,
          token,
        };
      }).filter(t => t.targetActor);

      // ── Creature-type gating ──
      // If the save is conditional on a target type (e.g., "Giant Slayer
      // Spear: vs Giant the target must make a DC 15 STR save"), only fire
      // the save card against targets whose creature type matches. A Wolf
      // hit by a Giant Slayer should NOT roll a save — the qualifier is
      // an integral part of the effect, not a generic on-hit rider.
      let filteredTargets = targetData;
      const skippedNotes = [];

      if (save.requiredCreatureType) {
        const required = save.requiredCreatureType.toLowerCase();
        filteredTargets = filteredTargets.filter(t => {
          const td = t.targetActor?.system?.details?.type;
          const tType = (td?.value ?? "").toLowerCase();
          const tSubtype = (td?.subtype ?? "").toLowerCase();
          const matches = tType === required
                       || tType.includes(required)
                       || tSubtype.includes(required);
          if (!matches) skippedNotes.push({ name: t.name, reason: `not a ${required}` });
          return matches;
        });
      }

      // ── Damage-type immunity gating ──
      // If the save's failure effect is purely damage of one or more types
      // (e.g., "DC 14 CON save or take 2d6 cold damage") AND the target is
      // immune to ALL of those damage types, the save is meaningless — the
      // failure does nothing, so don't make them roll. If the failure also
      // includes a condition (prone, paralyzed, etc.), the save still
      // matters because the condition applies regardless of damage immunity.
      const failDamageTypes = (save.failEffect ?? [])
        .filter(e => e?.type === "damage" && typeof e.damageType === "string")
        .map(e => e.damageType.toLowerCase());
      const failConditions = (save.failEffect ?? [])
        .filter(e => e?.type === "condition" && typeof e.condition === "string")
        .map(e => e.condition.toLowerCase());
      const hasNonDamageNonConditionFail = (save.failEffect ?? [])
        .some(e => e?.type && e.type !== "damage" && e.type !== "condition");

      if (failDamageTypes.length > 0 && failConditions.length === 0 && !hasNonDamageNonConditionFail) {
        filteredTargets = filteredTargets.filter(t => {
          const mods = DamageCalculator.getTargetDamageModifiers(t.targetActor, item);
          const allImmune = failDamageTypes.every(dt => mods[dt]?.modifier === "immune");
          if (allImmune) {
            skippedNotes.push({
              name: t.name,
              reason: `immune to ${failDamageTypes.join("/")}`,
            });
            return false;
          }
          return true;
        });
      }

      // ── Condition-immunity gating ──
      // If the save's failure effect is purely conditions (e.g., "DC 17 WIS
      // save or be frightened") AND the target is immune to ALL of them,
      // the save is meaningless — the condition can't apply. Mace of Terror
      // vs a fey-immune-to-frightened target should not roll. Same shape as
      // the damage-immunity gate above. Targets get filtered out and the GM
      // gets a transparency note explaining why.
      // Reads `actor.system.traits.ci.value` (Condition Immunities, Foundry
      // dnd5e standard).
      if (failConditions.length > 0 && failDamageTypes.length === 0 && !hasNonDamageNonConditionFail) {
        filteredTargets = filteredTargets.filter(t => {
          const condImmunities = new Set((t.targetActor?.system?.traits?.ci?.value ?? []).map(s => String(s).toLowerCase()));
          const allImmune = failConditions.every(cond => condImmunities.has(cond));
          if (allImmune) {
            skippedNotes.push({
              name: t.name,
              reason: `immune to ${failConditions.join("/")}`,
            });
            return false;
          }
          return true;
        });
      }

      // ── GM-only transparency note (whispered) ──
      // Tells the GM exactly WHY a target was filtered out so the missing
      // save card doesn't look like a silent bug. NOT public — players see
      // the subtle italic flavor hint on the damage card instead, which
      // gives them a discovery prompt without revealing immunities verbatim.
      if (skippedNotes.length && game.user.isGM) {
        try {
          const lines = skippedNotes.map(s =>
            `<strong>${foundry.utils.escapeHTML(s.name)}</strong> — ${foundry.utils.escapeHTML(s.reason)}`
          ).join("<br>");
          await ChatMessage.create({
            content: `<div class="ace-qol-save-suppressed" style="background:#1a1a1f;border-left:3px solid #d4af37;padding:6px 10px;border-radius:3px;color:#aaa;font-size:11px;">
              <div style="color:#d4af37;font-weight:700;margin-bottom:3px;">🛡 ${foundry.utils.escapeHTML(item.name)} — save not required (GM)</div>
              <div>${lines}</div>
            </div>`,
            whisper: [game.user.id],
          });
        } catch (_) { /* note is informational only */ }
      }

      if (!filteredTargets.length) {
        console.log(`${MODULE_ID} | PostHitSave skipped (this save) — no eligible targets after creature-type/immunity filtering`);
        continue; // try the next save in parsed.saves (multi-save weapons)
      }

      await PostHitSaves.postSaveCard(item, actor, filteredTargets, {
        save,
        effectTable: parsed.effectTable,
        bonusDamage: parsed.bonusDamage,
        conditions: parsed.conditions,
      });
    }

    // ── Secondary-roll sever rider (Sword of Sharpness, Vorpal Sword) ──
    // After the save card(s), fire the sever mechanic for any target hit
    // by a NATURAL 20 attack. Rolls a fresh d20 per target; on a 20, posts
    // a SEVERED chat card with creature-shape immunity awareness (no head
    // → can't sever head, no limbs → can't sever limbs, etc.).
    if (parsed.severRider) {
      try {
        await PostHitSaves._runSeverRiders(item, actor, hitTargets, parsed.severRider);
      } catch (err) {
        console.error(`${MODULE_ID} | Sever rider failed:`, err);
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Sever Rider — secondary-roll mechanic (Sword of Sharpness / Vorpal Sword)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * For every target hit by a natural 20 attack, roll a secondary d20.
   * On a 20, post a SEVERED card (limb / head / body part). On any other
   * result, post a near-miss card with the roll value so the table sees
   * the d20 was attempted.
   *
   * Vorpal-style head-sever respects creature-shape immunity: if the target
   * has no head (oozes, swarms, certain elementals) the rider falls back to
   * the "lop off a portion of body" wording. Similarly, brainless creatures
   * can't be killed outright by head sever — we still announce the wound
   * but mark it as "no instant kill applied".
   *
   * @param {Item} item
   * @param {Actor} actor
   * @param {Array} hitTargets - the same hits[] used by checkPostHitEffects
   * @param {object} severRider - { triggerOn, secondaryDie, secondaryThreshold, severType, description }
   */
  static async _runSeverRiders(item, actor, hitTargets, severRider) {
    if (!severRider || !hitTargets?.length) return;
    const threshold = severRider.secondaryThreshold ?? 20;

    // Filter to natural-20 hits only — RAW these riders chain off "roll a 20
    // on the attack roll". Expanded crit ranges (Champion 19-20) do NOT
    // qualify — only literal d20 = 20.
    const nat20Hits = hitTargets.filter(h => (h.naturalRoll ?? 0) === 20);
    if (!nat20Hits.length) return;

    for (const hit of nat20Hits) {
      const scene = game.scenes.get(hit.sceneId) ?? canvas.scene;
      const tokenDoc = scene?.tokens?.get(hit.tokenDocId ?? hit.targetToken?.document?.id);
      const targetActor = tokenDoc?.actor ?? game.actors.get(hit.actorId ?? hit.targetActor?.id);
      if (!targetActor) continue;

      // Roll the secondary d20 with DSN animation
      const secondaryRoll = new Roll("1d20");
      await secondaryRoll.evaluate();
      try {
        if (game.dice3d) await game.dice3d.showForRoll(secondaryRoll, game.user, true);
      } catch (err) {
        console.warn(`${MODULE_ID} | Sever roll DSN display failed:`, err);
      }
      const rolled = secondaryRoll.total;
      const severed = rolled >= threshold;

      // Determine creature-shape compatibility for the sever target part.
      // The dnd5e creature type isn't authoritative for head/limb presence,
      // so we use simple heuristics on type/subtype/name. False positives are
      // harmless — falls back to "body" wording.
      const shape = PostHitSaves._creatureShapeOf(targetActor);
      let actualSeverType = severRider.severType;
      if (severRider.severType === "head" && !shape.hasHead) actualSeverType = "body";
      if (severRider.severType === "limb" && !shape.hasLimbs) actualSeverType = "body";

      // ── RAW immunity check (Vorpal Sword head-lop) ──
      // RAW: "A creature is immune to this effect if it is immune to slashing
      // damage, doesn't have or need a head, has legendary actions, or the GM
      // decides that the creature is too big for its head to be lopped off
      // with this weapon. Such a creature instead takes an extra 6d8 slashing
      // damage from the hit." (Vorpal Sword, DMG)
      //
      // We auto-detect slashing-damage IMMUNITY (resistance does NOT block
      // sever — only immunity does). For other immunity reasons (no head,
      // legendary, GM call), the GM still adjudicates from the chat card.
      let slashingImmune = false;
      try {
        const dmgInfo = targetActor.system?.traits?.di?.value
                     ?? targetActor.system?.traits?.di
                     ?? new Set();
        const di = dmgInfo instanceof Set ? [...dmgInfo] : (Array.isArray(dmgInfo) ? dmgInfo : []);
        slashingImmune = di.map(s => String(s).toLowerCase()).includes("slashing");
      } catch (_) { /* non-fatal */ }

      // Post the result card. ALWAYS public so the player at the table sees
      // the climactic roll (this is the iconic Sword of Sharpness moment).
      const targetName = hit.name ?? targetActor.name ?? "Target";
      const itemName = item.name ?? "Weapon";
      const severNoun = { head: "head", limb: "limb", body: "portion of body" }[actualSeverType] ?? "limb";

      let cardHtml;
      if (severed && slashingImmune && actualSeverType === "head") {
        // Vorpal RAW: slashing-immune target → lop denied, target instead
        // takes 6d8 slashing. Roll the 6d8 here and apply (respecting other
        // resistances/vulnerabilities — RAW makes no exception for them).
        const altDmg = new Roll("6d8");
        await altDmg.evaluate();
        try { if (game.dice3d) game.dice3d.showForRoll(altDmg, game.user, true).catch(() => {}); } catch (_) {}
        try {
          await targetActor.applyDamage?.(altDmg.total, 1);
        } catch (err) {
          console.warn(`${MODULE_ID} | Vorpal alt-damage application failed:`, err);
        }
        cardHtml = `
          <div class="ace-qol-sever-card ace-qol-sever-immune" style="background:#0f0a1a; border:2px solid #6c5ce7; border-radius:6px; padding:10px 12px; box-shadow:0 0 8px rgba(108,92,231,0.3);">
            <div style="display:flex; align-items:center; gap:10px; margin-bottom:6px;">
              <i class="fas fa-shield-halved" style="font-size:20px; color:#a29bfe;"></i>
              <strong style="color:#dfd9ff; font-size:14px;">
                ${foundry.utils.escapeHTML(itemName)} — IMMUNE (slashing immunity)
              </strong>
            </div>
            <div style="color:#cfcfd0; font-size:12px; line-height:1.45;">
              <strong>Sever roll:</strong> <span style="color:#a29bfe; font-weight:700;">${rolled}</span> (needed ${threshold})<br>
              <strong>${foundry.utils.escapeHTML(targetName)}</strong> is immune to slashing damage — head stays attached.<br>
              Takes <strong style="color:#ff6b6b;">${altDmg.total}</strong> slashing damage instead (6d8 RAW alternate).
            </div>
          </div>
        `;
        console.log(`${MODULE_ID} | SEVER IMMUNE (slashing): ${targetName} took ${altDmg.total} slashing instead of head loss`);
      } else if (severed) {
        cardHtml = `
          <div class="ace-qol-sever-card ace-qol-sever-success" style="background:linear-gradient(180deg,#2a0a0a 0%,#3a0e0e 50%,#2a0a0a 100%); border:2px solid #d4af37; border-radius:6px; padding:10px 12px; box-shadow:0 0 12px rgba(212,175,55,0.3);">
            <div style="display:flex; align-items:center; gap:10px; margin-bottom:6px;">
              <i class="fas fa-skull" style="font-size:20px; color:#d4af37;"></i>
              <strong style="color:#ffd87a; font-size:14px; text-shadow:0 0 8px rgba(255,200,80,0.4);">
                ${foundry.utils.escapeHTML(itemName)} — SEVERED
              </strong>
            </div>
            <div style="color:#cfcfd0; font-size:12px; line-height:1.45;">
              <strong>Sever roll:</strong> <span style="color:#ffd87a; font-weight:700;">${rolled}</span> (needed ${threshold})<br>
              <strong>${foundry.utils.escapeHTML(targetName)}</strong> loses a ${severNoun}.
              ${actualSeverType !== severRider.severType ? ` <em style="color:#aaa;">(creature has no ${severRider.severType} — ${severNoun} severed instead)</em>` : ""}
            </div>
            <div style="color:#aaa; font-size:11px; margin-top:6px; font-style:italic; border-top:1px solid rgba(212,175,55,0.2); padding-top:6px;">
              GM: adjudicate the lasting effect (loss of attribute, halved speed, can't wield two weapons, etc.).
            </div>
          </div>
        `;
        console.log(`${MODULE_ID} | SEVER: ${targetName} loses a ${severNoun} from ${itemName} (rolled ${rolled})`);
      } else {
        cardHtml = `
          <div class="ace-qol-sever-card ace-qol-sever-miss" style="background:#1a1a1f; border-left:3px solid #555; padding:6px 10px; border-radius:3px; color:#aaa; font-size:11px;">
            <i class="fas fa-dice-d20" style="color:#888;"></i>
            <strong style="color:#ccc;">${foundry.utils.escapeHTML(itemName)}</strong> — sever roll: <span style="color:#ccc; font-weight:700;">${rolled}</span> (needed ${threshold}). <em>${foundry.utils.escapeHTML(targetName)}'s ${severNoun} stays attached.</em>
          </div>
        `;
        console.log(`${MODULE_ID} | SEVER MISS: ${targetName} on ${itemName} — rolled ${rolled}, needed ${threshold}`);
      }

      await ChatMessage.create({
        content: cardHtml,
        speaker: ChatMessage.getSpeaker({ actor }),
        flags: {
          [MODULE_ID]: {
            type: "severResult",
            actorId: actor.id,
            itemUuid: item.uuid,
            targetActorId: targetActor.id,
            severed,
            rolled,
            threshold,
            severType: actualSeverType,
          },
        },
      });
    }
  }

  /**
   * Best-effort creature-shape detection for sever-target compatibility.
   * Returns {hasHead, hasLimbs}. Defaults to true/true for unknowns.
   *
   * Used so Vorpal Sword's "sever the head" doesn't try to sever the head
   * of a Gelatinous Cube or a Swarm of Insects (no central head).
   */
  static _creatureShapeOf(actor) {
    const type = String(actor?.system?.details?.type?.value ?? "").toLowerCase();
    const subtype = String(actor?.system?.details?.type?.subtype ?? "").toLowerCase();
    const name = String(actor?.name ?? "").toLowerCase();

    // Headless / shapeless creatures
    const headless = ["ooze", "plant", "elemental"];
    const swarmKeyword = subtype.includes("swarm") || name.includes("swarm");
    const isOoze = type === "ooze" || /\b(?:ooze|jelly|cube|pudding|slime)\b/.test(name);
    const isFormless = headless.includes(type) || swarmKeyword || isOoze;

    // Limbless creatures — most oozes, swarms, snakes, eyes, slimes
    const limbless = isFormless
      || /\b(?:snake|serpent|naga|wyrm|worm|leech|eye|beholder|tendril)\b/.test(name)
      || subtype.includes("snake") || subtype.includes("serpent");

    return {
      hasHead:  !isFormless,
      hasLimbs: !limbless,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Post Save Card (the "Roll Saves" prompt)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Post a save card that appears AFTER the damage card for post-hit saves.
   */
  static async postSaveCard(item, actor, targetData, opts) {
    const { save, effectTable, bonusDamage, conditions } = opts;
    const abilityLabel = CONFIG.DND5E?.abilities?.[save.ability]?.label ?? save.ability.toUpperCase();

    const targetRows = targetData.map(t => {
      const saveData = t.targetActor?.system?.abilities?.[save.ability]?.save;
      const saveMod = typeof saveData === "number" ? saveData : (saveData?.value ?? saveData?.mod ?? 0);
      return `
        <div class="ace-qol-save-target">
          <div class="ace-qol-save-target-header">
            <img src="${t.img || "icons/svg/mystery-man.svg"}" class="ace-qol-save-target-img" />
            <span class="ace-qol-save-target-name">${t.name}</span>
            <span class="ace-qol-save-target-mod">${save.ability.toUpperCase()} +${saveMod}</span>
          </div>
        </div>
      `;
    }).join("");

    const cardHtml = `
      <div class="ace-qol-save-card ace-qol-posthit-save">
        <div class="ace-qol-save-header">
          <img src="${item.img || "icons/svg/spell.svg"}" class="ace-qol-save-item-img" />
          <div>
            <strong class="ace-qol-save-item-name">${item.name} — Save Required</strong>
            <span class="ace-qol-save-dc">DC ${save.dc} ${abilityLabel} Save</span>
          </div>
        </div>
        <div class="ace-qol-save-targets">
          ${targetRows}
        </div>
        <div class="ace-qol-save-actions">
          <button class="ace-qol-btn ace-qol-btn-roll" data-action="aceQolRollPostHitSaves">
            <i class="fas fa-dice-d20"></i> ROLL SAVES
          </button>
        </div>
      </div>
    `;

    await ChatMessage.create({
      content: cardHtml,
      speaker: ChatMessage.getSpeaker({ actor }),
      whisper: [game.user.id],
      flags: {
        [MODULE_ID]: {
          type: "postHitSave",
          itemId: item.id,
          itemUuid: item.uuid,
          actorId: actor.id,
          save: { dc: save.dc, ability: save.ability },
          effectTable: effectTable,
          bonusDamage: bonusDamage,
          conditions: conditions.filter(c => c.requiresSave),
          targets: targetData.map(t => ({
            tokenDocId: t.tokenDocId,
            actorId: t.actorId,
            sceneId: t.sceneId,
            name: t.name,
            img: t.img,
          })),
        }
      }
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Roll Saves + Apply Effects
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * When GM clicks ROLL SAVES on a post-hit save card:
   * 1. Roll the save for each target
   * 2. If failed and there's an effect table, roll the table
   * 3. Apply conditions and/or bonus damage from the result
   * 4. Post results card
   */
  static async rollPostHitSaves(message) {
    const flags = message.flags?.[MODULE_ID];
    if (!flags) return;

    const { save, effectTable, bonusDamage, conditions, targets, itemId, itemUuid, actorId } = flags;
    const item = await fromUuid(itemUuid) ?? game.items.get(itemId);
    const casterActor = game.actors.get(actorId);

    const results = [];

    for (const tgt of targets) {
      const scene = game.scenes.get(tgt.sceneId) ?? canvas.scene;
      const tokenDoc = scene?.tokens?.get(tgt.tokenDocId);
      const targetActor = tokenDoc?.actor ?? game.actors.get(tgt.actorId);
      if (!targetActor) continue;

      // Check for auto-fail conditions
      const statuses = targetActor.statuses ?? new Set();
      const isAutoFail = (save.ability === "str" || save.ability === "dex")
        && (statuses.has("paralyzed") || statuses.has("stunned") || statuses.has("unconscious"));

      let saveTotal = 0;
      let passed = false;
      let saveRoll = null;

      if (isAutoFail) {
        saveTotal = 0;
        passed = false;
      } else {
        // Magic Resistance applies to saves vs SPELLS or magical effects.
        // Post-hit saves come from weapon RIDERS (Mace of Disruption, Wand
        // attacks with riders, etc.) — many of which ARE magical. The old
        // gate `item?.type === "spell"` was too narrow: a Wand of Magic
        // Missiles' rider hits a creature with MR but it didn't get the
        // advantage because the wand's item.type is "weapon" or "consumable".
        // Now: extend MR to magical items (mgc property) and spell-typed items.
        const isMagicalSource = item?.type === "spell"
          || item?.system?.properties?.includes?.("mgc")
          || item?.system?.properties?.has?.("mgc")
          || !!item?.system?.magicAvailable;
        const hasAdvantage = targetActor.flags?.["midi-qol"]?.advantage?.save?.[save.ability]
          || (statuses.has("magic-resistance") && isMagicalSource);
        const hasDisadvantage = (save.ability === "dex" && statuses.has("restrained"));

        let rollMode = "normal";
        if (hasAdvantage && !hasDisadvantage) rollMode = "advantage";
        else if (hasDisadvantage && !hasAdvantage) rollMode = "disadvantage";

        const saveRaw = targetActor.system?.abilities?.[save.ability]?.save;
        const saveMod = typeof saveRaw === "number" ? saveRaw : (saveRaw?.value ?? saveRaw?.mod ?? 0);
        const formula = rollMode === "advantage" ? `2d20kh + ${saveMod}`
                      : rollMode === "disadvantage" ? `2d20kl + ${saveMod}`
                      : `1d20 + ${saveMod}`;

        saveRoll = new Roll(formula);
        await saveRoll.evaluate();

        try { if (game.dice3d) await game.dice3d.showForRoll(saveRoll, game.user, true); } catch (err) { console.warn("ace-qol | PostHitSaves dice3d save roll display failed:", err); }

        saveTotal = saveRoll.total;
        passed = saveTotal >= save.dc;
      }

      // ── Legendary Resistance check ──
      // If the target failed AND it's a legendary creature with charges
      // remaining, the reaction engine may flip the result to a pass (and
      // burn one LR charge). Mirrors the spell-save handling in
      // save-engine.mjs:1256-1285. Without this, bosses can't burn LR to
      // shrug off Giant Slayer prone, Sword of Wounding, Mace of Disruption
      // destroy, Hammer of Thunderbolts stun — design-breaking for tier 3+.
      let usedLegendaryResistance = false;
      if (!passed && !isAutoFail) {
        const reactionEng = game.aceQol?.reactionEngine;
        if (reactionEng) {
          try {
            const enriched = [{
              name:    tgt.name,
              actorId: tgt.actorId,
              actor:   targetActor,
              ability: save.ability,
              dc:      save.dc,
              total:   saveTotal,
              saved:   passed,
              passed:  passed,
            }];
            const modified = await reactionEng.checkPostSaveReactions(enriched);
            if (modified?.[0]?.legendaryResistance && modified[0].saved) {
              passed = true;
              usedLegendaryResistance = true;
              console.log(`${MODULE_ID} | PostHitSave: ${tgt.name} burned Legendary Resistance to pass`);
            }
          } catch (err) {
            console.error(`${MODULE_ID} | Post-save reaction check failed for ${tgt.name}:`, err);
          }
        }
      }

      // ── Determine outcome ──
      const result = {
        name: tgt.name,
        img: tgt.img,
        tokenDocId: tgt.tokenDocId,
        actorId: tgt.actorId,
        sceneId: tgt.sceneId,
        saveTotal,
        passed,
        isAutoFail,
        saveRoll,
        legendaryResistance: usedLegendaryResistance,
        effects: [],
      };

      if (!passed) {
        // ── Failed save — check for effect table ──
        if (effectTable) {
          const tableRoll = new Roll(effectTable.die === "d6" ? "1d6" : `1${effectTable.die}`);
          await tableRoll.evaluate();
          try { if (game.dice3d) await game.dice3d.showForRoll(tableRoll, game.user, true); } catch (err) { console.warn("ace-qol | PostHitSaves dice3d table roll display failed:", err); }

          const tableResult = tableRoll.total;
          result.tableRoll = tableResult;
          result.tableDie = effectTable.die;

          console.log(`${MODULE_ID} | POST-HIT TABLE: ${tgt.name} failed save → rolled ${effectTable.die} = ${tableResult}`);
          console.log(`${MODULE_ID} | POST-HIT TABLE: entries:`, effectTable.entries.map(e => `[${e.range[0]}-${e.range[1]}] ${e.name}`).join(", "));

          const matchedEntry = effectTable.entries.find(e =>
            tableResult >= e.range[0] && tableResult <= e.range[1]
          );

          console.log(`${MODULE_ID} | POST-HIT TABLE: matched entry:`, matchedEntry ? `"${matchedEntry.name}" with ${matchedEntry.effects?.length ?? 0} effects` : "NO MATCH");

          if (matchedEntry) {
            result.tableEntry = matchedEntry.name;
            result.tableDesc = matchedEntry.description;

            const autoApply = QolSettings.get("autoApplyConditions") ?? true;
            console.log(`${MODULE_ID} | POST-HIT TABLE: applying ${matchedEntry.effects?.length ?? 0} effects from "${matchedEntry.name}" (autoApply=${autoApply})`);
            const condImmunities = new Set((targetActor.system?.traits?.ci?.value ?? []).map(s => s.toLowerCase()));
            for (const fx of matchedEntry.effects) {
              console.log(`${MODULE_ID} | POST-HIT TABLE: effect:`, fx);
              if (fx.type === "condition") {
                const condKey = (fx.condition ?? "").toLowerCase();
                if (condImmunities.has(condKey)) {
                  result.effects.push({ type: "condition", condition: fx.condition, blocked: true, reason: `Immune to ${fx.condition}` });
                  console.log(`${MODULE_ID} | POST-HIT TABLE: ${tgt.name} IMMUNE to "${fx.condition}" — skipped`);
                } else {
                  result.effects.push({ type: "condition", condition: fx.condition });
                  if (autoApply && tokenDoc?.actor) {
                    // Use ConditionLibrary.applyByName so exhaustion correctly
                    // INCREMENTS the actor's level counter rather than toggling
                    // the status off/on (toggle would always set level=1).
                    const r = await ConditionLibrary.applyByName(tokenDoc.actor, fx.condition);
                    if (r.ok) {
                      console.log(`${MODULE_ID} | POST-HIT TABLE: applied "${fx.condition}"${r.level !== undefined ? ` (level ${r.level})` : ""} to ${tgt.name}`);
                    }
                  }
                }
              } else if (fx.type === "damage") {
                await PostHitSaves._rollAndApplySaveDamage(fx, targetActor, item, result);
              }
            }
          }
        } else {
          // No table — apply fail conditions directly (e.g., Giant Slayer)
          const autoApply = QolSettings.get("autoApplyConditions") ?? true;
          const condImmunities = new Set((targetActor.system?.traits?.ci?.value ?? []).map(s => s.toLowerCase()));
          for (const cond of (conditions ?? [])) {
            const condKey = (cond.condition ?? "").toLowerCase();
            if (condImmunities.has(condKey)) {
              result.effects.push({ type: "condition", condition: cond.condition, blocked: true, reason: `Immune to ${cond.condition}` });
              console.log(`${MODULE_ID} | ${tgt.name} is IMMUNE to ${cond.condition} — skipped`);
            } else {
              result.effects.push({ type: "condition", condition: cond.condition });
              if (autoApply && tokenDoc?.actor) {
                // Routes through ConditionLibrary so exhaustion correctly
                // INCREMENTS rather than toggles. Other conditions fall
                // through to a normal toggleStatusEffect call.
                const r = await ConditionLibrary.applyByName(tokenDoc.actor, cond.condition);
                if (r.ok && r.level !== undefined) {
                  console.log(`${MODULE_ID} | Exhaustion increment for ${tgt.name} (level ${r.level})`);
                }
              }
            }
          }
        }
      }

      results.push(result);
    }

    // Post results card
    await PostHitSaves.postSaveResults(item, casterActor, results, save);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Save-Gated Damage (with full defensive profile check)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Roll save-gated damage and check target's defensive profile.
   * Pushes the result into result.effects.
   */
  static async _rollAndApplySaveDamage(fx, targetActor, item, result) {
    const dmgRoll = new Roll(fx.formula);
    await dmgRoll.evaluate();
    try { if (game.dice3d) await game.dice3d.showForRoll(dmgRoll, game.user, true); } catch (err) { console.warn("ace-qol | PostHitSaves dice3d damage roll display failed:", err); }

    const rawTotal = dmgRoll.total;
    let finalTotal = rawTotal;
    let dmgModifier = "normal";
    let dmgModReason = null;
    const tgtTraits = targetActor.system?.traits ?? {};
    const resistSet = new Set((tgtTraits.dr?.value ?? []).map(s => s.toLowerCase()));
    const immuneSet = new Set((tgtTraits.di?.value ?? []).map(s => s.toLowerCase()));
    const vulnSet = new Set((tgtTraits.dv?.value ?? []).map(s => s.toLowerCase()));
    const drBypasses = new Set(tgtTraits.dr?.bypasses ?? []);
    const diBypasses = new Set(tgtTraits.di?.bypasses ?? []);
    const dmgType = (fx.damageType ?? "").toLowerCase();

    // Determine weapon properties for bypass checks
    const riderItemProps = new Set(item?.system?.properties ?? []);
    const riderIsMagical = riderItemProps.has("mgc") || !!item?.system?.magicAvailable;
    const riderIsSilvered = riderItemProps.has("sil");
    const riderIsAdamantine = riderItemProps.has("ada");

    if (immuneSet.has(dmgType)) {
      if (PHYSICAL_TYPES.has(dmgType) && diBypasses.size > 0) {
        const bypassed = (diBypasses.has("mgc") && riderIsMagical)
                      || (diBypasses.has("sil") && riderIsSilvered)
                      || (diBypasses.has("ada") && riderIsAdamantine);
        if (!bypassed) {
          finalTotal = 0;
          dmgModifier = "immune";
          dmgModReason = `Immune to ${dmgType}`;
        }
      } else {
        finalTotal = 0;
        dmgModifier = "immune";
        dmgModReason = `Immune to ${dmgType}`;
      }
    } else if (resistSet.has(dmgType)) {
      if (PHYSICAL_TYPES.has(dmgType) && drBypasses.size > 0) {
        const bypassed = (drBypasses.has("mgc") && riderIsMagical)
                      || (drBypasses.has("sil") && riderIsSilvered)
                      || (drBypasses.has("ada") && riderIsAdamantine);
        if (!bypassed) {
          finalTotal = Math.floor(rawTotal / 2);
          dmgModifier = "resistant";
          dmgModReason = `Resists ${dmgType} (half damage)`;
        }
      } else {
        finalTotal = Math.floor(rawTotal / 2);
        dmgModifier = "resistant";
        dmgModReason = `Resists ${dmgType} (half damage)`;
      }
    } else if (vulnSet.has(dmgType)) {
      finalTotal = rawTotal * 2;
      dmgModifier = "vulnerable";
      dmgModReason = `VULNERABLE to ${dmgType} (double damage)`;
    }

    result.effects.push({
      type: "damage",
      formula: fx.formula,
      damageType: fx.damageType,
      raw: rawTotal,
      total: finalTotal,
      roll: dmgRoll,
      modifier: dmgModifier,
      reason: dmgModReason,
    });
    console.log(`${MODULE_ID} | POST-HIT TABLE: rolled ${fx.formula} ${fx.damageType} = ${rawTotal}${dmgModifier !== "normal" ? ` → ${finalTotal} (${dmgModifier})` : ""}`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Save Results Card
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Post the results card showing save outcomes, table rolls, and applied effects.
   */
  static async postSaveResults(item, actor, results, save) {
    const abilityLabel = CONFIG.DND5E?.abilities?.[save.ability]?.label ?? save.ability.toUpperCase();

    const hasDamage = results.some(r => r.effects.some(fx => fx.type === "damage"));

    const rows = results.map(r => {
      const passClass = r.passed ? "ace-qol-save-pass" : "ace-qol-save-fail";
      const resultLabel = r.isAutoFail ? "AUTO-FAIL" : r.passed ? "PASS" : "FAIL";
      const rollDisplay = r.isAutoFail ? "—" : r.saveTotal;

      let effectsHtml = "";
      if (r.tableEntry) {
        effectsHtml += `<div class="ace-qol-table-result">
          <i class="fas fa-dice-d6"></i> Rolled <strong>${r.tableRoll}</strong>: <strong>${r.tableEntry}</strong>
        </div>`;
      }

      for (const fx of r.effects) {
        if (fx.type === "condition") {
          effectsHtml += `<span class="ace-qol-tag ace-qol-tag-debuff"><i class="fas fa-circle-xmark"></i> ${fx.condition.toUpperCase()} applied</span> `;
        } else if (fx.type === "damage") {
          const color = DamageConstants.DAMAGE_COLORS[fx.damageType] ?? "#ccc";
          const modBadge = fx.modifier === "immune" ? '<span class="ace-qol-dmg-mod ace-qol-dmg-immune">IMMUNE</span>'
                         : fx.modifier === "resistant" ? '<span class="ace-qol-dmg-mod ace-qol-dmg-resist">½ RESIST</span>'
                         : fx.modifier === "vulnerable" ? '<span class="ace-qol-dmg-mod ace-qol-dmg-vuln">×2 VULN</span>'
                         : "";
          let displayTotal;
          if (fx.modifier === "immune") {
            displayTotal = `<span style="text-decoration: line-through; text-decoration-color: #ff1744; color: #ccc;">${fx.raw}</span> <strong style="color: #ff1744;">0</strong>`;
          } else if (fx.modifier !== "normal") {
            displayTotal = `<span style="text-decoration: line-through; text-decoration-color: #ff9100; color: #ccc;">${fx.raw}</span> <strong>${fx.total}</strong>`;
          } else {
            displayTotal = `${fx.total}`;
          }
          // Build dice display
          let fxDieDisplay = fx.formula;
          if (fx.roll?.terms) {
            const fxDice = [];
            for (const fxTerm of fx.roll.terms) {
              if (fxTerm.faces) {
                for (const fxR of (fxTerm.results ?? [])) {
                  const fxImgPath = DamageConstants.getDiceImagePath(fxTerm.faces, fxR.result);
                  const fxFallback = DamageConstants.DIE_ICONS[fxTerm.faces] ?? "fa-dice";
                  fxDice.push(
                    `<span class="ace-qol-die">`
                    + `<img class="ace-qol-die-img" src="${fxImgPath}" alt="d${fxTerm.faces}" onerror="this.style.display='none';this.nextElementSibling.style.display='inline'">`
                    + `<i class="fas ${fxFallback} ace-qol-die-fallback" style="display:none"></i>`
                    + `<span class="ace-qol-die-result">${fxR.result}</span>`
                    + `</span>`
                  );
                }
              }
            }
            if (fxDice.length) fxDieDisplay = fxDice.join(' <span class="ace-qol-dmg-plus">+</span> ');
          }
          // Use the shared horizontal-flow row class so dice + total wrap
          // gracefully on narrow chat panels (otherwise the damage type word
          // wraps character-by-character — "ne / cro / tic"). The
          // ace-qol-dmg-row class allows the chip to flow to a new line as a
          // whole unit when space is tight, and the total chip itself has
          // white-space: nowrap so it stays intact.
          effectsHtml += `<div class="ace-qol-dmg-component ace-qol-dmg-row" style="padding-left: 0;">
            ${fxDieDisplay}
            <span class="ace-qol-dmg-equals">=</span>
            <span class="ace-qol-dmg-value ace-qol-dmg-value-chip" style="color:${color}">${displayTotal} ${fx.damageType}</span>
            ${modBadge}
          </div>`;
        }
      }

      // HP line for targets that took damage
      const dmgEffects = r.effects.filter(fx => fx.type === "damage");
      const totalDamage = dmgEffects.reduce((sum, fx) => sum + fx.total, 0);
      let hpHtml = "";
      if (totalDamage > 0) {
        const scene = game.scenes.get(r.sceneId) ?? canvas.scene;
        const tokenDoc = scene?.tokens?.get(r.tokenDocId);
        const targetActor = tokenDoc?.actor ?? game.actors.get(r.actorId);
        const currentHP = targetActor?.system?.attributes?.hp?.value ?? 0;
        const maxHP = targetActor?.system?.attributes?.hp?.max ?? 0;
        const newHP = Math.max(0, currentHP - totalDamage);
        const isDead = newHP <= 0;
        r._currentHP = currentHP;
        r._maxHP = maxHP;
        r._totalDamage = totalDamage;
        hpHtml = `<div class="ace-qol-dmg-hp">HP: ${currentHP} → ${newHP}/${maxHP}${isDead ? " ☠" : ""}</div>`;
      }

      return `
        <div class="ace-qol-save-result-row">
          <div class="ace-qol-save-result-target">
            <img src="${r.img || "icons/svg/mystery-man.svg"}" class="ace-qol-save-target-img" />
            <span class="ace-qol-save-target-name">${r.name}</span>
            <span class="ace-qol-save-roll ${passClass}">${rollDisplay}</span>
            <span class="ace-qol-save-result-label ${passClass}">${resultLabel}</span>
          </div>
          ${effectsHtml ? `<div class="ace-qol-posthit-effects">${effectsHtml}</div>` : ""}
          ${hpHtml}
        </div>
      `;
    }).join("");

    const actionsHtml = hasDamage ? `
      <div class="ace-qol-dmg-actions">
        <button class="ace-qol-btn ace-qol-btn-apply" data-action="aceQolApplyDamage">
          <i class="fas fa-heart-crack"></i> Apply Damage
        </button>
        <button class="ace-qol-btn ace-qol-btn-undo" data-action="aceQolUndoDamage">
          <i class="fas fa-undo"></i> Undo
        </button>
      </div>` : "";

    const cardHtml = `
      <div class="ace-qol-save-results-card ace-qol-posthit-results">
        <div class="ace-qol-save-header">
          <img src="${item?.img || "icons/svg/spell.svg"}" class="ace-qol-save-item-img" />
          <div>
            <strong class="ace-qol-save-item-name">${item?.name ?? "Unknown"} — Save Results</strong>
            <span class="ace-qol-save-dc">DC ${save.dc} ${abilityLabel}</span>
          </div>
        </div>
        <div class="ace-qol-save-results">
          ${rows}
        </div>
        ${actionsHtml}
      </div>
    `;

    // Build damage results for Apply/Undo flags
    const damageResults = results
      .filter(r => r._totalDamage > 0)
      .map(r => ({
        targetId: r.actorId,
        tokenDocId: r.tokenDocId,
        sceneId: r.sceneId,
        totalFinal: r._totalDamage,
        currentHP: r._currentHP,
      }));

    await ChatMessage.create({
      content: cardHtml,
      speaker: ChatMessage.getSpeaker({ actor }),
      flags: {
        [MODULE_ID]: {
          type: "postHitSaveResult",
          ...(damageResults.length ? { damageResults } : {}),
        }
      },
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  HP-Threshold Rider — Mace of Disruption, Mace of Smiting
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * For each hit target whose post-damage HP is at-or-below the rider's
   * threshold (and matches the optional creature-type gate), roll a save
   * (NPCs auto-roll, PCs get a whispered prompt). On fail, apply the effect.
   *
   * Effects we handle explicitly:
   *   - "destroyed" — sets HP to 0 (instant death; for constructs/undead)
   *   - "stunned" / "paralyzed" / "frightened" / "blinded" / "deafened" /
   *     "poisoned" / "restrained" / "incapacitated" / "unconscious" /
   *     "charmed" / "grappled" / "petrified" — applied via ConditionLibrary
   *   - other: posted as plain text in the chat card; GM applies manually
   */
  static async _applyHpThresholdRider(item, actor, hitTargets, rider) {
    if (!rider || !Number.isFinite(rider.threshold) || !Number.isFinite(rider.dc)) return;

    for (const h of hitTargets) {
      // Mace of Smiting: only check on a nat-20 attack roll
      if (rider.onlyOnCrit && h.hitResult !== "critical") continue;

      const scene = game.scenes.get(h.sceneId) ?? canvas.scene;
      const tokenDoc = scene?.tokens?.get(h.targetToken?.document?.id ?? h.tokenDocId);
      const targetActor = tokenDoc?.actor ?? game.actors.get(h.targetActor?.id ?? h.actorId);
      if (!targetActor) continue;

      // Creature-type gate (Mace of Disruption: fiend OR undead)
      if (rider.requireType) {
        const targetType = String(targetActor.system?.details?.type?.value ?? "").toLowerCase();
        const gateTypes = rider.requireType.split("|");
        if (!gateTypes.includes(targetType)) continue;
      }

      // HP-after-damage gate
      const hpNow = Number(targetActor.system?.attributes?.hp?.value ?? 0);
      if (hpNow > rider.threshold) continue;

      // ── Roll the save (NPCs auto-roll; PC handling routes through the
      // existing whispered-prompt pipeline if available, but for now we
      // auto-roll and let the player counter via the GM if needed) ──
      const abilityKey = rider.ability;
      const saveBonus = Number(targetActor.system?.abilities?.[abilityKey]?.save?.value
                            ?? targetActor.system?.abilities?.[abilityKey]?.save
                            ?? 0);
      const roll = new Roll(`1d20 + ${saveBonus}`);
      await roll.evaluate();
      const passed = roll.total >= rider.dc;

      // Animate (DSN broadcast) — same pattern as save-engine
      try {
        if (game.dice3d) game.dice3d.showForRoll(roll, game.user, true).catch(() => {});
      } catch (_) { /* non-fatal */ }

      // Apply effect on fail
      let appliedEffect = null;
      if (!passed) {
        const effect = (rider.effect ?? "").toLowerCase();
        try {
          if (effect === "destroyed") {
            await targetActor.update({ "system.attributes.hp.value": 0 });
            appliedEffect = "Destroyed (HP set to 0)";
          } else if (["stunned","paralyzed","frightened","blinded","deafened","poisoned","restrained","incapacitated","unconscious","charmed","grappled","petrified","prone"].includes(effect)) {
            await ConditionLibrary.applyByName?.(targetActor, effect);
            appliedEffect = effect.charAt(0).toUpperCase() + effect.slice(1);
          } else {
            appliedEffect = effect; // unknown — log only, GM applies manually
          }
        } catch (err) {
          console.warn(`${MODULE_ID} | HP-threshold rider effect "${effect}" failed:`, err);
        }
      }

      // Post chat card showing the rider trigger + result
      try {
        const abilityLabel = CONFIG.DND5E?.abilities?.[abilityKey]?.label ?? abilityKey.toUpperCase();
        const resultLabel = passed ? "PASS — no effect" : (appliedEffect ? `FAIL — ${appliedEffect}` : "FAIL");
        const html = `
          <div class="ace-qol-postsave-card ace-qol-hp-threshold-rider">
            <div class="ace-qol-pst-header">
              <i class="fas fa-skull-crossbones"></i>
              <strong>${item.name} — HP Threshold</strong>
              <span class="ace-qol-pst-target">${h.target?.name ?? targetActor.name}</span>
            </div>
            <div class="ace-qol-pst-body">
              <div class="ace-qol-pst-line">HP ${hpNow} ≤ ${rider.threshold} → DC ${rider.dc} ${abilityLabel} save</div>
              <div class="ace-qol-pst-line">Roll: <strong>${roll.total}</strong> ${passed ? "✅" : "❌"}</div>
              <div class="ace-qol-pst-line ace-qol-pst-result">${resultLabel}</div>
            </div>
          </div>
        `;
        await ChatMessage.create({
          speaker: ChatMessage.getSpeaker({ actor }),
          content: html,
          flags: { [MODULE_ID]: { type: "hpThresholdRider", actorId: targetActor.id, passed } },
        });
      } catch (err) {
        console.warn(`${MODULE_ID} | HP-threshold rider chat post failed:`, err);
      }
    }
  }
}
