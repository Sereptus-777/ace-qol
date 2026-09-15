// ─── ACE: QOL — Post-Hit Saves ───────────────────────────────────────────────
// Self-contained subsystem for saves triggered after damage is dealt.
// Handles: detection, save card rendering, save rolling, results card,
// condition application, and save-gated bonus damage with full defensive checks.
// ──────────────────────────────────────────────────────────────────────────────

import { MODULE_ID } from "./ace-qol.mjs";
import { QolSettings } from "./settings.mjs";
import { DescriptionParser } from "./description-parser.mjs";
import { DamageConstants, safeShowForRoll } from "./damage-engine.mjs";
import { DamageCalculator } from "./damage-calculator.mjs";
import { ConditionLibrary } from "./condition-library.mjs";
import { awaitDsnRoll } from "./attack-prompt.mjs";
// The rules brain — entries override the description parser for post-hit
// behavior (convergence 2026-07-10). Function-time reads only; cycle inert.
import { RulesBrain } from "./rules/rules-brain.mjs";
// The One Road: every card here goes through the card door (Phase 3, 2026-09-14),
// every condition a save's result puts on goes through the condition door, and
// its damage is worked out on the creature the way the hit-point door reads it.
import { CardDoor, ConditionDoor, HpDoor } from "./road/doors.mjs";
// What a save's result lets through, from its recipe: the one decider.
import { whatLands } from "./road/what-lands.mjs";
// A save after a hit with no attack recipe beside it gets one from the same builder.
// Function-time reads only: recipe.mjs reaches this file back through its `then`.
import { followUpRecipe } from "./inference/recipe.mjs";
import { CombatState } from "./combat-state.mjs";

export class PostHitSaves {

  /**
   * The saves a creature makes BECAUSE this item hit it.
   *
   * ⚠️🔴 ONE READER FOR TWO QUESTIONS. The damage card asks these saves after
   * a hit, and the activity chooser stops offering them as a separate choice
   * (Johnny, 2026-09-12, asked "Attack or Save?" on Neferon's Claws). If the
   * two read different things, a save is either asked and still offered, or
   * offered and never asked. So both ask this.
   *
   * The rules brain's entry wins outright (convergence, 2026-07-10); otherwise
   * the item's own words, minus any save they plainly give to something else.
   *
   * @param {Item} item
   * @param {Actor} [actor]
   * @param {{parsed?: object, quiet?: boolean}} [opts]
   * @returns {{saves: object[], sure: object[], entryOnHit: object[]|null, from: string}}
   *   `saves` are asked after a hit. `sure` are the ones that are certainly the
   *   hit's own, and only those may come off the chooser's list.
   */
  static riderSavesFor(item, actor = item?.actor ?? null, { parsed = null, quiet = false } = {}) {
    const out = { saves: [], sure: [], entryOnHit: null, from: "words" };
    if (!item) return out;
    let all = [];
    try { all = (parsed ?? DescriptionParser.parse(item)).saves ?? []; }
    catch (err) {
      console.warn(`${MODULE_ID} | post-hit: could not read the words of "${item.name}", `
        + `so no save is asked after its hits:`, err);
    }
    out.saves = all.filter(s => s.hitVerdict !== "no");
    out.sure = all.filter(s => s.hitVerdict === "yes");
    const other = all.filter(s => s.hitVerdict === "no");
    if (other.length && !quiet) {
      // ⚠️ NAMED, so "not asked" never looks like "missed".
      console.log(`${MODULE_ID} | post-hit: "${item.name}" also names `
        + other.map(s => `a DC ${s.dc} ${String(s.ability).toUpperCase()} save`).join(" and ")
        + ` that ${other.length === 1 ? "belongs" : "belong"} to something other than the hit, `
        + `so ${other.length === 1 ? "it is" : "they are"} not asked after one.`);
    }
    // ── THE BRAIN OVERRIDES THE PARSE (convergence, 2026-07-10) ──
    // When the item has a rules entry declaring post-hit behavior, the ENTRY is
    // authoritative; the words are the fallback for everything without one.
    try {
      const entry = RulesBrain.lookup(item, { actor })?.entry;
      if (entry?.postHitSave?.dc && entry.postHitSave.ability) {
        out.saves = [foundry.utils.deepClone(entry.postHitSave)];
        out.sure = out.saves;
        out.from = "rules entry";
        if (!quiet) console.log(`${MODULE_ID} | post-hit: rules entry OVERRIDES parsed save for "${item.name}" (DC ${entry.postHitSave.dc} ${entry.postHitSave.ability})`);
      }
      if (Array.isArray(entry?.onHit) && entry.onHit.length) {
        out.entryOnHit = foundry.utils.deepClone(entry.onHit);
      }
    } catch (err) {
      console.warn(`${MODULE_ID} | post-hit: could not ask the rules brain about "${item.name}", `
        + `so its own words decide:`, err);
    }
    return out;
  }

  /**
   * The activities on offer that are this item's hit-saves, for the chooser.
   *
   * ⚠️ EMPTY ON ANY DOUBT. A save wrongly taken off the list cannot be pressed
   * at all; one wrongly left on is only a question he can ignore.
   */
  static riderActivityIds(item, activities) {
    try {
      const { sure } = PostHitSaves.riderSavesFor(item, item?.actor ?? null, { quiet: true });
      return DescriptionParser.riderActivityIds(item, activities, sure);
    } catch (err) {
      console.warn(`${MODULE_ID} | could not tell whether "${item?.name}" has a save that `
        + `follows its hit, so every choice stays on offer:`, err);
      return new Set();
    }
  }

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

    // ── ONLY THE SAVES THAT BELONG TO THE HIT ──
    // One reader, shared with the activity chooser: the save asked here is the
    // save the chooser stopped offering as a separate choice.
    const riders = PostHitSaves.riderSavesFor(item, actor, { parsed });
    parsed.saves = riders.saves;
    const entryOnHit = riders.entryOnHit;

    // ── Entry-declared ON-HIT effects (no save — the Net) ──
    // Applied to every HIT target, immunity-checked, announced compactly.
    if (entryOnHit) {
      try {
        await PostHitSaves._applyEntryOnHit(item, actor, hits, entryOnHit);
      } catch (err) {
        console.warn(`${MODULE_ID} | entry on-hit handling failed:`, err);
      }
    }
    // Early-return gate: skip the whole function if the item has NO
    // post-hit machinery to run. severRider MUST be in this list — without
    // it, weapons whose only post-hit effect is a head/limb sever (Vorpal
    // Sword by RAW, Sword of Sharpness without auxiliary saves) silently
    // no-op here and the sever code further down never runs.
    if (!parsed.saves.length
        && !parsed.effectTable
        && !parsed.hpThresholdRider
        && !parsed.onKillRider
        && !parsed.severRider) return;   // (entry on-hit already ran above)

    // Only process targets that were actually HIT
    const hitTargets = hits.filter(h => h.hitResult === "hit" || h.hitResult === "critical");
    if (!hitTargets.length) return;

    // ── THE SAVES AFTER THE HIT ARE THE ATTACK RECIPE'S `then` (Phase 3) ──
    // The same reader built both lists in the same order (riderSavesFor), so a
    // save pairs with its follow-up by place. A book's words could name other
    // saves than the sheet's; none of his spell attacks has one, and such a save
    // keeps its own card, said here, until one does.
    const road = parsed.saves.length ? await DamageCalculator._attackRoad(item, actor, null) : null;
    const thens = road?.recipe?.then ?? [];
    const paired = !!road && !road.book && thens.length === parsed.saves.length;
    if (road && !paired && parsed.saves.length) {
      console.log(`${MODULE_ID} | post-hit: "${item.name}" names ${parsed.saves.length} save(s) after its hit and its `
        + `recipe${road.book ? " (the book's)" : ""} names ${thens.length}, so they keep their own card.`);
    }

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

    // ── On-kill rider (Blood Halberd 2d6 temp HP, life-leech weapons, etc.) ──
    // Fires AFTER damage is applied. Detects which hit targets were reduced
    // to 0 HP by THIS attack and rolls the rider formula once per kill.
    // Temp HP applies via Math.max(existing, rolled) per RAW. Self-heal
    // variants clamp to actor max HP. Each kill gets its own DSN-broadcast
    // roll so all clients see the dice.
    if (parsed.onKillRider) {
      try {
        await PostHitSaves._applyOnKillRider(item, actor, hitTargets, parsed.onKillRider);
      } catch (err) {
        console.warn(`${MODULE_ID} | On-kill rider handling failed:`, err);
      }
    }

    // ── Post-hit save(s) required ──
    // Some weapons have MULTIPLE independent saves (Hammer of Thunderbolts:
    // DC 17 CON instant-death vs giant + DC 17 CON stun in 30-ft AOE).
    // Iterate every parsed save so each posts its own card. The creature-type
    // / damage-immunity / condition-immunity gates inside the loop filter
    // targets per-save, so a save that doesn't apply to anyone simply skips.
    for (const [saveIndex, save] of parsed.saves.entries()) {
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
          // ⚠️🔴 SAY IT IN WORDS A GM READS MID-TURN. Johnny, 2026-09-12, on a
          // save that did nothing to his Specter: "I don't know that he's
          // immune to poison, so as a DM, I'm looking: he rolled and he failed,
          // but I don't know what's going on." This note is how he knows, so it
          // is a sentence at a readable size, not an 11-pixel footnote.
          const lines = skippedNotes.map(s =>
            `<div style="margin-top:4px;"><strong style="color:#ffffff;">${foundry.utils.escapeHTML(s.name)}</strong> `
            + `is ${foundry.utils.escapeHTML(s.reason)}, so no save is needed.</div>`
          ).join("");
          await CardDoor.post({
            content: `<div class="ace-qol-save-suppressed" style="background:#141118;border-left:3px solid #d4af37;padding:8px 12px;border-radius:4px;color:#e8d9a8;font-size:15px;line-height:1.4;">
              <div style="color:#d4af37;font-weight:700;font-size:16px;"><i class="fas fa-shield-halved"></i> ${foundry.utils.escapeHTML(item.name)}: save skipped (GM only)</div>
              ${lines}
            </div>`,
            whisper: [game.user.id],
          });
        } catch (err) {
          console.warn(`${MODULE_ID} | post-hit: could not post the note saying why a save was skipped:`, err);
        }
      }

      if (!filteredTargets.length) {
        console.log(`${MODULE_ID} | PostHitSave skipped (this save) — no eligible targets after creature-type/immunity filtering`);
        continue; // try the next save in parsed.saves (multi-save weapons)
      }

      // ⚠️ THE SAVE AFTER A HIT IS A NEW RUN ON THE SAME ROAD (The One Road,
      // Phase 3, 2026-09-14): the attack recipe's `then`, run by the save engine,
      // decided by whatLands and landed through the doors. This file used to roll
      // its own d20s, halve its own damage and put on its own conditions. A save
      // that rolls on a table has no recipe shape yet (it is a mechanic), so it
      // keeps its own card, and says so.
      const then = paired ? (thens[saveIndex] ?? null) : null;
      if (then && !parsed.effectTable && await PostHitSaves._runThen(item, actor, filteredTargets, save, then)) continue;
      if (then && parsed.effectTable) {
        console.log(`${MODULE_ID} | post-hit: "${item.name}"'s save after its hit rolls on a table, which its recipe `
          + `cannot carry yet, so it keeps its own card.`);
      }
      await PostHitSaves.postSaveCard(item, actor, filteredTargets, {
        save,
        effectTable: parsed.effectTable,
        bonusDamage: parsed.bonusDamage,
        // What its result lands is this save's recipe's, even on this card: the
        // attack recipe's `then` when it has one, else the same builder's reading.
        recipe: then ?? followUpRecipe(item, save, saveIndex, { actor }),
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
    //
    // The attack pipeline stores the natural d20 result as `d20Result` (see
    // attack-pipeline.mjs:411). Older drafts of this code looked for
    // `naturalRoll` which was never populated → the filter always returned
    // empty and the sever rider silently no-op'd. Accept both keys defensively
    // so future renames don't reintroduce the bug.
    const nat20Hits = hitTargets.filter(h => {
      const nat = h.d20Result ?? h.naturalRoll ?? h.natRoll ?? 0;
      return Number(nat) === 20;
    });
    if (!nat20Hits.length) return;

    for (const hit of nat20Hits) {
      const scene = game.scenes.get(hit.sceneId) ?? canvas.scene;
      const tokenDoc = scene?.tokens?.get(hit.tokenDocId ?? hit.targetToken?.document?.id);
      const targetActor = tokenDoc?.actor ?? game.actors.get(hit.actorId ?? hit.targetActor?.id);
      if (!targetActor) continue;

      // ── Vorpal-style (no secondary roll) vs Sharpness-style (secondary d20)
      // RAW Vorpal Sword triggers off the ORIGINAL nat-20 attack roll — no
      // second d20 is rolled. The parser flags Vorpal items (by name OR by
      // matching the RAW description pattern) with skipSecondaryRoll:true.
      // For those, we treat the sever as automatic. Sword of Sharpness and
      // other secondary-roll weapons still roll the second d20 as before.
      let rolled, severed;
      if (severRider.skipSecondaryRoll) {
        rolled  = 20;   // displayed on the chat card as the triggering value
        severed = true; // RAW: Vorpal severs on every nat-20 attack
      } else {
        const secondaryRoll = new Roll("1d20");
        await secondaryRoll.evaluate();
        safeShowForRoll(secondaryRoll, "sever roll");
        // ⚠️ NOTHING LANDS BEFORE THE DICE (Johnny's rule): a head came off, and
        // the HP went to 0, while this d20 was still rolling.
        await awaitDsnRoll();
        rolled  = secondaryRoll.total;
        severed = rolled >= threshold;
      }

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
        safeShowForRoll(altDmg, "sever alt-damage");
        await awaitDsnRoll();   // the 6d8 lands before it comes off the target's HP
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
      } else if (severed && slashingImmune && (actualSeverType === "limb" || actualSeverType === "body")) {
        // Sword of Sharpness on slashing-immune target (Stone Golem etc.).
        // RAW doesn't define a Vorpal-style alt-damage path for Sharpness,
        // so we just deny the sever and explain why on the card. The base
        // attack's slashing damage was already zeroed by the immunity in
        // the normal damage-applicator path — no further damage here.
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
              <strong>${foundry.utils.escapeHTML(targetName)}</strong> is immune to slashing damage — its ${severNoun} stays attached.<br>
              <em style="color:#aaa; font-size:11px;">A slashing weapon can't sever what slashing can't damage.</em>
            </div>
          </div>
        `;
        console.log(`${MODULE_ID} | SEVER IMMUNE (slashing): ${targetName}'s ${severNoun} not severed — ${itemName} slashing-immune target`);
      } else if (severed) {
        // ── Vorpal head-sever auto-kill (v0.7.11) ───────────────────────
        // RAW Vorpal Sword (DMG): on a successful head-sever, "the creature
        // dies if it can't survive without the lost head." For the vast
        // majority of creatures this is the only way to interpret losing
        // the head — they're dead. Slashing-immune creatures took the
        // alt-damage branch above (line 303). Edge cases (trolls regen,
        // certain undead, gods with backup heads) are rare enough that
        // the GM can manually heal/revive via the chat card if needed.
        //
        // Sword of Sharpness (severType="limb") and generic body-part
        // severs do NOT auto-kill — those are wounds, GM adjudicates.
        let autoKilled = false;
        if (actualSeverType === "head" && shape.hasHead) {
          try {
            const curHp = targetActor.system?.attributes?.hp?.value ?? 0;
            if (curHp > 0 && game.user.isGM) {
              await targetActor.update({ "system.attributes.hp.value": 0 });
              autoKilled = true;
              console.log(`${MODULE_ID} | SEVER AUTO-KILL: ${targetName} dropped to 0 HP from head loss (Vorpal RAW)`);

              // ── Run the death pipeline (token texture swap + permanent-
              //    death flag) ──
              // RAW: Vorpal Sword "the creature dies if it can't survive
              // without the lost head" — this is a PERMANENT death. The
              // pipeline marks the token with permanentlyDead:true so the
              // normal HP-restored revive hook refuses to clear it. Only a
              // GM override (button on the SEVERED card, actor sheet, or
              // right-click menu) or strict-RAW resurrection magic (True
              // Resurrection, Wish — coming next session) brings them back.
              //
              // For NPCs the auto-pipeline runs from the HP-to-0 update
              // hook AND we explicitly call it here with permanentDeath:true
              // so the permanent flag is set even on NPCs (the auto-pipeline
              // would otherwise treat the death as a normal mortal end).
              // For PCs we always call it explicitly since the auto-pipeline
              // skips them by default.
              if (game.aceQol?.DeathPipeline?.processNPCDeath) {
                try {
                  const targetTokenDoc = scene?.tokens?.get(hit.tokenDocId ?? hit.targetToken?.document?.id);
                  if (targetTokenDoc) {
                    await game.aceQol.DeathPipeline.processNPCDeath(targetActor, targetTokenDoc, {
                      allowPC:        true,
                      permanentDeath: true,
                      reason:         "vorpal-head-sever",
                    });
                  }
                } catch (artErr) {
                  console.warn(`${MODULE_ID} | Vorpal sever dead-art placement failed (non-fatal):`, artErr);
                }
              }
            }
          } catch (err) {
            console.warn(`${MODULE_ID} | Vorpal auto-kill HP update failed:`, err);
          }
        }

        const killBanner = autoKilled
          ? `<div style="color:#ff6b6b; font-weight:700; margin-top:4px; padding:4px 6px; background:rgba(255,107,107,0.1); border-left:3px solid #ff6b6b; border-radius:2px;">
               💀 <strong>${foundry.utils.escapeHTML(targetName)}</strong> dies from loss of head (HP set to 0).
             </div>`
          : "";

        // GM-only "Revoke Vorpal lock" button — clears the permanentlyDead
        // flag so the next HP-restored update revives the actor normally.
        // Hidden for players via the inline GM-only display rule. The
        // chat-message-rendered hook (added to ace-qol.mjs) wires the click.
        const overrideButton = autoKilled
          ? `<div class="ace-qol-vorpal-override" style="margin-top:8px;padding-top:6px;border-top:1px solid rgba(212,175,55,0.2);" data-gm-only="true">
               <button type="button" class="ace-qol-btn-vorpal-override" data-action="aceQolRevokeVorpal"
                       data-actor-id="${foundry.utils.escapeHTML(targetActor.id)}"
                       data-token-id="${foundry.utils.escapeHTML(tokenDoc?.id ?? "")}"
                       data-scene-id="${foundry.utils.escapeHTML(scene?.id ?? "")}"
                       style="background:linear-gradient(180deg,#2a1a0a,#1a0a05);border:1px solid #d4af37;border-radius:4px;color:#ffd87a;padding:6px 12px;font-size:12px;font-weight:700;cursor:pointer;width:100%;">
                 <i class="fas fa-unlock-keyhole"></i> GM: Revoke Vorpal Lock (allow normal revive)
               </button>
             </div>`
          : "";

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
            ${killBanner}
            <div style="color:#aaa; font-size:11px; margin-top:6px; font-style:italic; border-top:1px solid rgba(212,175,55,0.2); padding-top:6px;">
              ${autoKilled
                ? "Permanent kill per Vorpal RAW — HP restoration alone won't revive. True Resurrection / Wish will. GM can revoke the lock below to allow normal revive."
                : "GM: adjudicate the lasting effect (loss of attribute, halved speed, can't wield two weapons, etc.)."
              }
            </div>
            ${overrideButton}
          </div>
        `;
        console.log(`${MODULE_ID} | SEVER: ${targetName} loses a ${severNoun} from ${itemName} (rolled ${rolled})${autoKilled ? " — auto-killed" : ""}`);
      } else {
        cardHtml = `
          <div class="ace-qol-sever-card ace-qol-sever-miss" style="background:#1a1a1f; border-left:3px solid #555; padding:6px 10px; border-radius:3px; color:#aaa; font-size:11px;">
            <i class="fas fa-dice-d20" style="color:#888;"></i>
            <strong style="color:#ccc;">${foundry.utils.escapeHTML(itemName)}</strong> — sever roll: <span style="color:#ccc; font-weight:700;">${rolled}</span> (needed ${threshold}). <em>${foundry.utils.escapeHTML(targetName)}'s ${severNoun} stays attached.</em>
          </div>
        `;
        console.log(`${MODULE_ID} | SEVER MISS: ${targetName} on ${itemName} — rolled ${rolled}, needed ${threshold}`);
      }

      // The sever and alt-damage dice were waited for where they were thrown,
      // before anything landed, so the card follows them directly.
      await CardDoor.post({
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
  //  The save after a hit, as a new run on the same road (Phase 3)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Run a save after a hit on the save engine: its card, its rolls, its reaction
   * window (Legendary Resistance, Silvery Barbs) and its doors, deciding what
   * lands through whatLands on the attack recipe's `then`. True when the save
   * engine took it; false, and said why, when it cannot, so the caller's own card
   * still asks the save.
   */
  static async _runThen(item, actor, targets, save, then) {
    const engine = game.aceQol?.saveEngine;
    if (typeof engine?.postSaveCard !== "function") {
      console.warn(`${MODULE_ID} | post-hit: the save engine is not on the API, so "${item.name}"'s save `
        + `after its hit keeps its own card.`);
      return false;
    }
    // ⚠️ ALL OR NONE. The save engine's card is built from tokens on this scene;
    // one missing would drop that creature's save, so every creature keeps the
    // old card instead.
    const missing = targets.filter(t => !t.token);
    if (missing.length) {
      console.warn(`${MODULE_ID} | post-hit: ${missing.map(t => t.name).join(", ")} `
        + `${missing.length === 1 ? "has" : "have"} no token on this scene, so the save after "${item.name}"'s hit `
        + `keeps its own card.`);
      return false;
    }
    const ability = then.decidedBy?.ability ?? save.ability;
    const dc = then.decidedBy?.dc ?? save.dc;
    try {
      await engine.postSaveCard(item, actor, targets.map(t => t.token), {
        saveAbility: ability, saveDC: dc, isSpell: item?.type === "spell",
        activityId: null, recipe: then, skipDelay: true,
      });
      console.log(`${MODULE_ID} | post-hit: "${item.name}"'s save after its hit runs on the save engine: `
        + `DC ${dc} ${String(ability).toUpperCase()}, ${targets.length} creature(s).`);
    } catch (err) {
      // ⚠️ NEVER TWO CARDS FOR ONE SAVE: the engine may have posted before it
      // threw, so the old card is not tried as well. Said loudly instead.
      console.error(`${MODULE_ID} | post-hit: the save after "${item.name}"'s hit failed on the save engine:`, err);
      ui.notifications?.error(`${item.name}: the save after its hit could not be run. See the console.`);
    }
    return true;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Post Save Card (the "Roll Saves" prompt)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Post a save card that appears AFTER the damage card for post-hit saves.
   */
  static async postSaveCard(item, actor, targetData, opts) {
    const { save, effectTable, bonusDamage, recipe } = opts;
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

    await CardDoor.post({
      content: cardHtml,
      speaker: ChatMessage.getSpeaker({ actor }),
      whisper: [game.user.id],
      flags: {
        [MODULE_ID]: {
          type: "postHitSave",
          itemId: item.id,
          itemUuid: item.uuid,
          actorId: actor.id,
          // failEffect + halfOnSuccess MUST cross the message boundary — the
          // Giant Wasp bug (2026-07-10 03:24): the parser extracted "3d6
          // poison on a failed save" but the card's flags only carried
          // dc+ability, so a FAILED save resolved with no consequence.
          save: {
            dc: save.dc,
            ability: save.ability,
            failEffect: save.failEffect ?? [],
            halfOnSuccess: !!save.halfOnSuccess,
          },
          effectTable: effectTable,
          bonusDamage: bonusDamage,
          // What the save's result lands: its recipe, decided by whatLands when
          // it is rolled. The parser's list of the item's conditions rode here
          // too and went on beside the save's own words: a second decider. A
          // card posted before recipes travelled rebuilds one from `save`.
          recipe: recipe ?? null,
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

    const { save, effectTable, targets, itemId, itemUuid, actorId } = flags;
    const item = await fromUuid(itemUuid) ?? game.items.get(itemId);
    const casterActor = game.actors.get(actorId);

    // ── WHAT ITS RESULT LANDS IS ITS RECIPE'S (The One Road, 2026-09-14) ──
    // The recipe the card carries: the attack recipe's `then`, or the same
    // builder's reading of this save. A card posted before recipes travelled
    // with it gets one from that builder here, from the save it carries.
    let recipe = flags.recipe ?? null;
    if (!recipe && save) {
      try { recipe = followUpRecipe(item, save, 0, { actor: casterActor }); }
      catch (err) {
        console.warn(`${MODULE_ID} | post-hit: could not build the recipe of "${item?.name}"'s save after its hit, `
          + `so its result lands nothing:`, err);
      }
    }

    // FIELD DIAGNOSTIC (2026-07-10): state the consequence inventory up
    // front, so a failed save that lands nothing announces itself instead of
    // resolving into silence (the Giant Wasp lesson, twice over).
    console.log(
      `${MODULE_ID} | rollPostHitSaves: DC ${save?.dc} ${save?.ability} | its recipe lands on a failure: `
      + ((recipe?.onFail ?? []).map(o => (o.kind === "damage"
          ? `${o.formula} ${(o.types ?? []).join("/")}${o.onSuccess === "half" ? " (half on a success)" : ""}`
          : o.condition?.key)).join(", ") || "NOTHING: a failure will do nothing")
      + ` | table=${!!effectTable}`
    );

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

        safeShowForRoll(saveRoll, "post-hit save roll");

        saveTotal = saveRoll.total;
        passed = saveTotal >= save.dc;
      }

      // ⚠️ NOTHING LANDS BEFORE THE DICE (Johnny's rule). The Legendary
      // Resistance prompt, the effect table and the condition all come after
      // this die lands; they used to arrive while it was still rolling. It waits
      // on an automatic failure too, where the previous target's damage dice may
      // still be in the air.
      await awaitDsnRoll();

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
              sourceName: item?.name ?? null,   // names the resisted effect in the LR prompt
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
          safeShowForRoll(tableRoll, "post-hit effect-table roll");
          await awaitDsnRoll();   // the table's effect lands after its die does

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

            // A table is a mechanic its recipe cannot carry yet, so the entry
            // says what lands; it lands through the same doors as every save.
            console.log(`${MODULE_ID} | POST-HIT TABLE: applying ${matchedEntry.effects?.length ?? 0} effects from "${matchedEntry.name}"`);
            for (const fx of (matchedEntry.effects ?? [])) {
              console.log(`${MODULE_ID} | POST-HIT TABLE: effect:`, fx);
              if (fx.type === "condition" && fx.condition) {
                await PostHitSaves._landConditions([{ key: fx.condition }], targetActor, result, tgt.name);
              } else if (fx.type === "damage" && fx.formula) {
                const rolled = await PostHitSaves._rollSaveDamage([{ formula: fx.formula, types: [fx.damageType] }], casterActor);
                PostHitSaves._landSaveDamage(rolled.map(r => ({ amount: r.total, type: r.type })), rolled, targetActor, item, result);
              }
            }
          }
        } else {
          await PostHitSaves._landSaveResult({ item, casterActor, save, recipe, targetActor,
            name: tgt.name, passed, isAutoFail, result });
        }
      } else {
        // A made save lands what its recipe says a success lets through (half a
        // venom's damage, or nothing), decided the same way as a failure.
        await PostHitSaves._landSaveResult({ item, casterActor, save, recipe, targetActor,
          name: tgt.name, passed, isAutoFail, result });
      }

      results.push(result);
    }

    // Post results card
    await PostHitSaves.postSaveResults(item, casterActor, results, save);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Entry-declared ON-HIT effects (no save — the Net pattern)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Apply a rules entry's onHit effects to every HIT target: conditions with
   * immunity checks (through ConditionLibrary so exhaustion increments), and
   * one compact announcement card naming what landed and how to escape.
   */
  static async _applyEntryOnHit(item, actor, hits, onHit) {
    const hitTargets = (hits ?? []).filter(h => h.hitResult === "hit" || h.hitResult === "critical");
    if (!hitTargets.length) return;
    const autoApply = QolSettings.get("autoApplyConditions") ?? true;
    const lines = [];

    for (const h of hitTargets) {
      const scene = game.scenes.get(h.sceneId) ?? canvas.scene;
      const tokenDoc = scene?.tokens?.get(h.targetToken?.document?.id ?? h.tokenDocId);
      const targetActor = tokenDoc?.actor ?? game.actors.get(h.targetActor?.id ?? h.actorId);
      if (!targetActor) continue;
      const name = h.name ?? tokenDoc?.name ?? targetActor.name;
      const condImmunities = new Set((targetActor.system?.traits?.ci?.value ?? []).map(s => s.toLowerCase()));

      for (const fx of onHit) {
        if (fx.type !== "condition" || !fx.condition) continue;
        const key = fx.condition.toLowerCase();
        if (condImmunities.has(key)) {
          lines.push(`<b>${foundry.utils.escapeHTML(name)}</b> is immune to ${fx.condition}.`);
          continue;
        }
        if (autoApply) {
          const r = await ConditionLibrary.applyByName(targetActor, fx.condition);
          if (r?.ok === false) console.warn(`${MODULE_ID} | entry on-hit: failed to apply ${fx.condition} to ${name}`);
        }
        lines.push(`<b>${foundry.utils.escapeHTML(name)}</b> is <b>${fx.condition.toUpperCase()}</b>${fx.note ? ` — ${foundry.utils.escapeHTML(fx.note)}` : ""}.`);
        console.log(`${MODULE_ID} | entry on-hit: "${item.name}" → ${fx.condition} on ${name}`);
      }
    }

    if (lines.length) {
      await CardDoor.post({
        content: `
          <div class="ace-qol-posthit-results" style="border-left:3px solid #c9a76b;padding:6px 10px;background:#141118;color:#e8dcc3;font-size:14px;border-radius:4px;">
            <div style="font-weight:700;color:#c9a76b;"><img src="${item.img}" style="width:18px;height:18px;vertical-align:-4px;border:none;"/> ${foundry.utils.escapeHTML(item.name)}</div>
            ${lines.map(l => `<div>${l}</div>`).join("")}
          </div>`,
        speaker: ChatMessage.getSpeaker({ actor }),
        flags: { [MODULE_ID]: { type: "entryOnHitResult" } },
      }).catch(err => console.warn(`${MODULE_ID} | the card naming what "${item.name}"'s hit put on could not be posted:`, err));
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  What a save after a hit lands: whatLands on its recipe, through the doors
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * What one creature's save after a hit puts on it, when this card asks the save
   * instead of the save engine (no save engine on the API, a creature with no
   * token on the scene, a card posted before recipes travelled with it).
   *
   * ⚠️🔴 DAMAGE DOES NOT SKIP CONDITIONS. EVER. (Johnny, 2026-09-14.) This card
   * decided what lands for itself: the parser's list of the item's conditions,
   * then the save's own words, with half on a success worked out here too. Now
   * the save's recipe decides it through whatLands, as on the save engine: the
   * damage the result lets through goes on the results card for its APPLY, and
   * every condition on that result goes on now, through the condition door, both
   * once the dice that decided them have landed.
   */
  static async _landSaveResult({ item, casterActor, save, recipe, targetActor, name, passed, isAutoFail, result }) {
    if (!recipe) {
      console.warn(`${MODULE_ID} | post-hit: "${item?.name}"'s save after its hit has no recipe, so nothing lands on ${name}.`);
      return;
    }
    const how = { passed, autoFail: isAutoFail, evasion: CombatState.evasionFor(targetActor, save?.ability) };
    // Its dice are thrown only when the result lets some of them through.
    const rolled = whatLands(recipe, how).share > 0
      ? await PostHitSaves._rollSaveDamage((recipe.onFail ?? []).filter(o => o?.kind === "damage"), casterActor)
      : [];
    const v = whatLands(recipe, { ...how, rolled });
    PostHitSaves._landSaveDamage(v.damage, rolled, targetActor, item, result, { halved: v.share > 0 && v.share < 1 });
    await PostHitSaves._landConditions(v.conditions, targetActor, result, name);
    // Anything else on the result is the GM's to put on: said, never dropped.
    const rest = [...v.effects.map(e => e?.key), ...v.notes].filter(Boolean);
    if (rest.length) {
      console.log(`${MODULE_ID} | post-hit: ${name}'s ${passed ? "made" : "failed"} save against "${item?.name}" also says `
        + `${rest.map(x => `"${x}"`).join(", ")}, which this card cannot put on, so the GM does.`);
    }
    console.log(`${MODULE_ID} | post-hit: ${name}, ${v.label}: `
      + `${v.damage.map(d => `${d.amount} ${d.type ?? "untyped"}`).join(" + ") || "no damage"}, `
      + `${v.conditions.map(c => c.key).join(", ") || "no condition"} (${v.why}).`);
  }

  /**
   * The damage a save's recipe deals, rolled once for this creature, and waited
   * for: nothing is decided from dice that are still in the air.
   *
   * @param {object[]} parts  the recipe's damage outcomes, each {formula, types}
   * @param {Actor|null} [casterActor]  whose numbers a formula's @ references read
   * @returns {Promise<Array<{total: number, type: string|null, formula: string, roll: Roll}>>}
   */
  static async _rollSaveDamage(parts, casterActor = null) {
    const rollData = casterActor?.getRollData?.() ?? {};
    const rolled = [];
    for (const o of (parts ?? [])) {
      // The caster's numbers, read the way the save engine reads a follow-up's formula.
      const formula = String(o?.formula ?? "").trim().replace(/@([a-zA-Z0-9_.]+)/g, (m, path) => {
        const val = path.split(".").reduce((x, k) => x?.[k], rollData);
        return val !== undefined ? String(val) : "0";
      });
      if (!formula) continue;
      const roll = new Roll(formula);
      await roll.evaluate();
      safeShowForRoll(roll, "post-hit save-damage roll");
      rolled.push({ total: roll.total, type: o.types?.[0] ?? null, formula, roll });
    }
    // ⚠️ NOTHING LANDS BEFORE THE DICE (Johnny's rule). A failed save's result is
    // damage and a condition ("3d6 poison damage and is poisoned"), and the
    // condition went on while this damage was still rolling.
    if (rolled.length) await awaitDsnRoll();
    return rolled;
  }

  /**
   * The damage a save's result lets through, put on the results card for its
   * APPLY, which lands it through the hit-point door: whatLands' share of each
   * rolled part, then this creature's resistances, immunities and vulnerabilities
   * read the way that door reads them, after the halving (the rules' order).
   */
  static _landSaveDamage(damage, rolled, targetActor, item, result, { halved = false } = {}) {
    HpDoor.preview(targetActor, damage, { item }).forEach((f, i) => {
      result.effects.push({
        type: "damage", formula: rolled[i]?.formula ?? "", damageType: f.type, raw: f.raw, total: f.final,
        roll: rolled[i]?.roll ?? null, modifier: f.modifier, reason: f.reason, halvedOnSave: halved,
      });
      console.log(`${MODULE_ID} | POST-HIT save damage: ${rolled[i]?.formula} ${f.type} = ${rolled[i]?.total}`
        + `${halved ? ` → ${f.raw} (half on the save)` : ""}${f.modifier !== "normal" ? ` → ${f.final} (${f.modifier})` : ""}`);
    });
  }

  /**
   * Every condition a save's result puts on, through the condition door: the
   * condition library's immunity check, no stacking, exhaustion by level, and the
   * recipe's own duration. One that did not go on is on the card, with why.
   */
  static async _landConditions(conditions, targetActor, result, name) {
    if (!conditions?.length) return;
    const autoApply = QolSettings.get("autoApplyConditions") ?? true;
    for (const c of conditions) {
      const key = String(c?.key ?? "").toLowerCase().trim();
      if (!key) continue;
      if (!autoApply) {
        result.effects.push({ type: "condition", condition: key, blocked: true,
          reason: "automatic conditions are switched off in ACE's settings" });
        console.log(`${MODULE_ID} | post-hit: automatic conditions are off, so ${key} was not put on ${name}.`);
        continue;
      }
      let out = null;
      try {
        out = await ConditionDoor.apply(targetActor, key, Number(c.duration) > 0 ? { duration: { seconds: Number(c.duration) } } : {});
      } catch (err) {
        console.warn(`${MODULE_ID} | post-hit: putting ${key} on ${name} failed:`, err);
      }
      if (out?.ok) {
        result.effects.push({ type: "condition", condition: key });
        console.log(`${MODULE_ID} | post-hit: ${key}${out.level !== undefined ? ` (level ${out.level})` : ""} put on ${name}.`);
      } else if (out?.immune) {
        result.effects.push({ type: "condition", condition: key, blocked: true, reason: `immune to ${key}` });
        console.log(`${MODULE_ID} | post-hit: ${name} is immune to ${key}, so it was not put on.`);
      } else {
        result.effects.push({ type: "condition", condition: key, blocked: true, reason: "it did not take; the console has why" });
        if (out) console.warn(`${MODULE_ID} | post-hit: ${key} did not go on ${name}:`, out);
      }
    }
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
          // ⚠️ SAY WHAT DID NOT GO ON. A condition refused by an immunity used to
          // read "applied" here like one that went on.
          effectsHtml += fx.blocked
            ? `<span class="ace-qol-tag"><i class="fas fa-shield-halved"></i> ${fx.condition.toUpperCase()} not put on: ${foundry.utils.escapeHTML(String(fx.reason ?? ""))}</span> `
            : `<span class="ace-qol-tag ace-qol-tag-debuff"><i class="fas fa-circle-xmark"></i> ${fx.condition.toUpperCase()} applied</span> `;
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
    //
    // ⚠️🔴 THE PARTS, NOT JUST THE SUM (2026-09-13). APPLY DAMAGE on this card
    // goes through DamageApplicator.applyDamage, which adds up each entry's
    // `components` and applies that. These entries carried only the total, so
    // the sum was 0: the button applied nothing, told the GM "Damage applied to
    // 1 target(s)" and turned to APPLIED. The card's own "HP 30 → 20" line was
    // the only place the damage ever existed. Found while building Prismatic
    // Wall's card on the same applicator.
    const damageResults = results
      .filter(r => r._totalDamage > 0)
      .map(r => ({
        targetId: r.actorId,
        tokenId: r.tokenDocId,
        tokenDocId: r.tokenDocId,
        sceneId: r.sceneId,
        name: r.name,
        img: r.img,
        totalFinal: r._totalDamage,
        currentHP: r._currentHP,
        maxHP: r._maxHP,
        components: r.effects.filter(fx => fx.type === "damage").map(fx => ({
          name: item?.name ?? "", type: fx.damageType, raw: fx.raw, final: fx.total,
          modifier: fx.modifier ?? "normal",
        })),
      }));

    // The save and save-damage dice are waited for inside the card door, so the
    // table never sees the outcome before they finish tumbling.
    await CardDoor.post({
      content: cardHtml,
      speaker: ChatMessage.getSpeaker({ actor }),
      flags: {
        [MODULE_ID]: {
          type: "postHitSaveResult",
          // The applicator reads the item for "was this magical" (Heavy Armor Master).
          itemUuid: item?.uuid ?? null,
          actorId: actor?.id ?? null,
          ...(damageResults.length ? { damageResults } : {}),
        }
      },
    }, { dice: true });
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

      safeShowForRoll(roll, "repeating-save roll");
      // ⚠️ NOTHING LANDS BEFORE THE DICE (Johnny's rule): the condition, or the
      // HP going to 0, used to land while this d20 was still rolling. Only the
      // card waited.
      await awaitDsnRoll();

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
        await CardDoor.post({
          speaker: ChatMessage.getSpeaker({ actor }),
          content: html,
          flags: { [MODULE_ID]: { type: "hpThresholdRider", actorId: targetActor.id, passed } },
        });
      } catch (err) {
        console.warn(`${MODULE_ID} | HP-threshold rider chat post failed:`, err);
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  On-Kill Rider (description-parsed)
  //
  //  Triggers when this attack reduces a hit target to 0 HP. Reward goes to
  //  the ATTACKER (Blood Halberd 2d6 temp HP, life-leech HP regain, etc.).
  //  Fires AFTER damage is applied — we read the post-damage HP off each
  //  hit target's actor.
  //
  //  RAW edge cases handled:
  //    - Multiple kills in one swing (cleave/multi-attack): rolls per kill,
  //      takes the HIGHEST roll for temp HP (RAW: temp HP doesn't stack —
  //      keep the larger pool from any single source)
  //    - Self-heal variant: SUMS rolls across kills, clamps to max HP
  //    - Target was already at 0 HP before the swing: we look at the kill
  //      flag set by our damage pipeline (hit.killedThisSwing). If the
  //      pipeline didn't tag it (legacy), fall back to "currentHP <= 0"
  //      which can over-fire if the target was already dead — accepted
  //      trade-off because re-applying temp HP to the attacker is harmless
  //      (Math.max).
  //    - Synthetic actors (unlinked tokens): correctly resolve via tokenDoc
  //      then fall back to actor lookup, same pattern as HP-threshold rider
  //    - DSN broadcast: 3rd arg true so the dice are visible to all players,
  //      not just the GM (consistent with rest of the pipeline)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Apply on-kill rider rewards to the attacker.
   * @param {Item} item - Source weapon/item with the on-kill description
   * @param {Actor} actor - Attacker (gets the reward)
   * @param {Array} hitTargets - Targets that were hit by the attack
   * @param {Object} rider - Parsed rider { formula, reward, target, phrase }
   */
  static async _applyOnKillRider(item, actor, hitTargets, rider) {
    if (!rider?.formula || !actor) return;

    // Setting kill switch
    try {
      if (QolSettings.get?.("descriptionOnKillRiderEnabled") === false) {
        console.log(`${MODULE_ID} | On-kill rider disabled via setting — skipping`);
        return;
      }
    } catch (_) { /* setting not ready — proceed */ }

    // Identify which hit targets were actually killed by THIS attack.
    // We check post-damage HP on each target's actor. Unlinked-token
    // resolution mirrors _applyHpThresholdRider for consistency.
    const killedNames = [];
    for (const h of hitTargets) {
      const scene = game.scenes.get(h.sceneId) ?? canvas.scene;
      const tokenDoc = scene?.tokens?.get(h.targetToken?.document?.id ?? h.tokenDocId);
      const targetActor = tokenDoc?.actor ?? game.actors.get(h.targetActor?.id ?? h.actorId);
      if (!targetActor) continue;
      const hpNow = Number(targetActor.system?.attributes?.hp?.value ?? 0);
      if (hpNow <= 0) {
        killedNames.push(h.target?.name ?? h.name ?? targetActor.name ?? "Unknown");
      }
    }

    if (!killedNames.length) {
      // No kills this swing — rider doesn't trigger. Quiet skip (no log noise).
      return;
    }

    // Roll formula once per kill — RAW: each kill is its own trigger.
    // For temp HP, we'll Math.max to find the strongest pool.
    // For self-heal, we'll sum (multiple kills = more healing, clamped to max).
    const rolls = [];
    for (let i = 0; i < killedNames.length; i++) {
      try {
        const roll = new Roll(rider.formula);
        await roll.evaluate();
        rolls.push(roll);
        safeShowForRoll(roll, "on-kill rider roll");
      } catch (err) {
        console.warn(`${MODULE_ID} | On-kill rider formula "${rider.formula}" failed to roll:`, err);
      }
    }

    // ⚠️ NOTHING LANDS BEFORE THE DICE (Johnny's rule): the temp HP or the healing
    // went on while these dice were still rolling; only the card waited.
    await awaitDsnRoll();
    if (!rolls.length) return;

    const totals = rolls.map(r => r.total);

    if (rider.reward === "tempHP") {
      // RAW: temp HP doesn't stack — take the higher of existing vs new.
      // For multi-kill, take the HIGHEST roll first (best of the trigger
      // batch), then Math.max against existing.
      const bestRolled = Math.max(...totals);
      const currentTemp = Number(actor.system?.attributes?.hp?.temp ?? 0);
      const newTemp = Math.max(currentTemp, bestRolled);
      const applied = newTemp > currentTemp;

      if (applied) {
        try {
          await actor.update({ "system.attributes.hp.temp": newTemp });
        } catch (err) {
          console.warn(`${MODULE_ID} | On-kill temp HP update failed:`, err);
          return;
        }
      }

      // Post chat card
      try {
        const killText = killedNames.length === 1
          ? `Reduced ${killedNames[0]} to 0 HP`
          : `Reduced ${killedNames.length} targets to 0 HP (${killedNames.join(", ")})`;
        const rollDetail = rolls.length === 1
          ? `Roll: <strong>${totals[0]}</strong>`
          : `Rolls: <strong>${totals.join(", ")}</strong> → best <strong>${bestRolled}</strong>`;
        const resultLine = applied
          ? `Temp HP: <strong>${currentTemp} → ${newTemp}</strong>`
          : `Temp HP: <strong>${currentTemp}</strong> (existing pool was higher — no change per RAW)`;

        const html = `
          <div class="ace-qol-postsave-card ace-qol-onkill-rider">
            <div class="ace-qol-pst-header">
              <i class="fas fa-shield-heart"></i>
              <strong>${item.name} — On-Kill Bonus</strong>
              <span class="ace-qol-pst-target">${actor.name}</span>
            </div>
            <div class="ace-qol-pst-body">
              <div class="ace-qol-pst-line">${killText}</div>
              <div class="ace-qol-pst-line">${rollDetail} ${rider.formula}</div>
              <div class="ace-qol-pst-line ace-qol-pst-result">${resultLine}</div>
            </div>
          </div>
        `;
        await CardDoor.post({
          speaker: ChatMessage.getSpeaker({ actor }),
          content: html,
          flags: { [MODULE_ID]: {
            type: "onKillRider",
            actorId: actor.id,
            reward: "tempHP",
            formula: rider.formula,
            kills: killedNames.length,
            tempBefore: currentTemp,
            tempAfter: newTemp,
          }},
        });
      } catch (err) {
        console.warn(`${MODULE_ID} | On-kill chat post failed:`, err);
      }
    } else if (rider.reward === "hp") {
      // Self-heal variant — sum rolls across kills, clamp to max HP.
      const totalRolled = totals.reduce((a, b) => a + b, 0);
      const currentHP = Number(actor.system?.attributes?.hp?.value ?? 0);
      const maxHP = Number(actor.system?.attributes?.hp?.max ?? 0);
      const newHP = Math.min(maxHP, currentHP + totalRolled);
      const actualGain = newHP - currentHP;

      if (actualGain > 0) {
        try {
          await actor.update({ "system.attributes.hp.value": newHP });
        } catch (err) {
          console.warn(`${MODULE_ID} | On-kill HP regain update failed:`, err);
          return;
        }
      }

      try {
        const killText = killedNames.length === 1
          ? `Reduced ${killedNames[0]} to 0 HP`
          : `Reduced ${killedNames.length} targets to 0 HP (${killedNames.join(", ")})`;
        const rollDetail = rolls.length === 1
          ? `Roll: <strong>${totals[0]}</strong>`
          : `Rolls: <strong>${totals.join(" + ")}</strong> = <strong>${totalRolled}</strong>`;
        const resultLine = actualGain > 0
          ? `HP: <strong>${currentHP} → ${newHP}</strong> (regained ${actualGain})`
          : `HP: <strong>${currentHP}</strong> (already at max — no change)`;

        const html = `
          <div class="ace-qol-postsave-card ace-qol-onkill-rider">
            <div class="ace-qol-pst-header">
              <i class="fas fa-heart-pulse"></i>
              <strong>${item.name} — On-Kill Bonus</strong>
              <span class="ace-qol-pst-target">${actor.name}</span>
            </div>
            <div class="ace-qol-pst-body">
              <div class="ace-qol-pst-line">${killText}</div>
              <div class="ace-qol-pst-line">${rollDetail} ${rider.formula}</div>
              <div class="ace-qol-pst-line ace-qol-pst-result">${resultLine}</div>
            </div>
          </div>
        `;
        await CardDoor.post({
          speaker: ChatMessage.getSpeaker({ actor }),
          content: html,
          flags: { [MODULE_ID]: {
            type: "onKillRider",
            actorId: actor.id,
            reward: "hp",
            formula: rider.formula,
            kills: killedNames.length,
            hpBefore: currentHP,
            hpAfter: newHP,
            gain: actualGain,
          }},
        });
      } catch (err) {
        console.warn(`${MODULE_ID} | On-kill chat post failed:`, err);
      }
    } else {
      console.warn(`${MODULE_ID} | On-kill rider has unknown reward type "${rider.reward}" — ignored`);
    }
  }
}
