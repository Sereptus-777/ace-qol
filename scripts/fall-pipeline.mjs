// ─── ACE QOL — The fall, from the edge to the floor ───────────────────────────
//
// Wires the pure rules in `falling.mjs` to the table:
//   1. Someone leaves a raised region and there is air under them.
//   2. Anything that catches them for free (flying, a Ring of Feather Falling)
//      stops here — no prompt, no fuss.
//   3. THE GM IS ASKED, ONCE. "Did he fall, or climb down?" Default: fall.
//   4. Everyone within 60 ft who could cast Feather Fall gets the window.
//   5. Damage, and prone.
//
// ⚠️ WHY THE GM IS ASKED. The staircase off Johnny's balcony and the balcony
// rail produce an identical region exit and an identical elevation change.
// Nothing in the data distinguishes them. Guessing "fall" every time means a
// player eats 3d6 walking downstairs; guessing "climbed" means nobody ever
// falls. So we ask — but only on drops of 10 ft or more, and the default is the
// dramatic one, because that is the case worth interrupting for.
// ──────────────────────────────────────────────────────────────────────────────

import { MODULE_ID } from "./ace-qol.mjs";
import {
  resolveFall, autoNegates, slowFallReduction, landingElevation,
  MIN_FALL_FT, FEATHER_FALL_RANGE_FT,
} from "./falling.mjs";
import { aceDistanceFt } from "./geometry-utils.mjs";
import { buildTargetProfile } from "./profiles/target-profile.mjs";
import { CombatContext } from "./combat-context.mjs";
import { DamageCardRenderer } from "./damage-card-renderer.mjs";
import { DamageCalculator } from "./damage-calculator.mjs";

const LOG = "ace-qol | Falling";

export class FallPipeline {

  /**
   * A token just left a raised place. Decide whether that was a fall.
   *
   * @param {TokenDocument} tokenDoc
   * @param {number} fromFt  the elevation they were at
   * @param {number} toFt    the elevation the region is putting them at
   */
  static async onLeftHeight(tokenDoc, fromFt, toFt) {
    try {
      if (game.users?.activeGM !== game.user) return;      // one client decides
      const drop = (Number(fromFt) || 0) - (Number(toFt) || 0);
      if (drop < MIN_FALL_FT) {
        console.debug(`${LOG} | ${tokenDoc?.name} dropped ${drop} ft — under the ${MIN_FALL_FT} ft minimum, RAW says nothing happens.`);
        return;
      }

      const actor = tokenDoc?.actor;
      if (!actor) {
        console.warn(`${LOG} | ${tokenDoc?.name} has no actor — cannot resolve a fall for it.`);
        return;
      }

      // ⚠️ READ THE FALLER AS A REAL TARGET, NOT AD HOC.
      // Johnny, 2026-08-12: "the fall target has to be completely read for
      // resistance and any other thing — just like a target in battle but with
      // appropriate handlers."
      //
      // `buildTargetProfile` wraps `Situation.readCreature`, so this one call
      // brings conditions, senses, speeds, damage traits (di/dr/dv), condition
      // immunities (ci), magic and legendary resistance, and concentration —
      // and it ANSWERS QUESTIONS rather than handing back raw structures.
      // Its own comment records why that matters: six files had each grown
      // their own condition-immunity reader, and the save pipeline read none.
      // Yesterday this file became the seventh by calling
      // `CombatContext.conditionImmune` directly. Ask the profile.
      const profile = buildTargetProfile(actor, { token: tokenDoc.object ?? tokenDoc });

      // ── Free catches: no prompt, no reaction, nothing spent ──────────────
      const auto = autoNegates(actor);
      if (auto.negated) {
        console.log(`${LOG} | ${tokenDoc.name} left a ${drop} ft height but ${auto.reason} — no fall.`);
        return;
      }

      // ── Where do they actually land? Not necessarily the floor. ──────────
      //
      // ⚠️🔴 THE DEFAULT IS `toFt`, NOT ZERO. This method used to pass a
      // hardcoded 0 as the fallback landing height, and that made it contradict
      // itself inside ten lines: `drop` above is fromFt - toFt, so stepping from
      // 0 ft into a room whose floor is -30 ft passed the minimum-fall gate as a
      // 30 ft drop — and then `distance` came out as 0 - 0 = 0 and the whole
      // thing bailed. Live on 2026-08-19: "left 0 ft but the computed fall is
      // only 0 ft (0 ground region(s) beneath)" while Forge had, one line
      // earlier, moved the same token from 0 to -30.
      //
      // The caller ALREADY resolved the destination. ground-level.mjs reads the
      // region behaviour, sets the token's elevation to it, and passes it here
      // as toFt. Re-deriving that from scene geometry and then trusting the
      // re-derivation over the answer we were handed is how a fall silently
      // becomes no fall: any failure in the region scan reads as "flat ground".
      //
      // The scan stays, but as a REFINEMENT only — it exists to catch an
      // intermediate ledge between the height they left and the floor they were
      // heading for. It can no longer zero out a fall by finding nothing.
      const grounds = FallPipeline._groundsBelow(tokenDoc, fromFt);
      const landsAt = landingElevation(grounds, fromFt, Number(toFt) || 0);
      const distance = fromFt - landsAt;
      if (distance < MIN_FALL_FT) {
        // ⚠️ NEVER BAIL SILENTLY HERE. This was a bare `return`, and on
        // 2026-08-13 creatures walked off a balcony to -30 ft with no prompt and
        // nothing logged anywhere — "no fall" and "the fall logic gave up" were
        // indistinguishable. Say which, and say enough to act on.
        console.warn(`${LOG} | ${tokenDoc.name} left ${fromFt} ft but the computed fall is only ${distance} ft ` +
          `(landing worked out as ${landsAt} ft from ${grounds.length} ground region(s) beneath). No prompt. ` +
          `If that is wrong, the region underneath is not being detected — run game.aceQol.falling.explain(token.document, ${fromFt}).`);
        return;
      }

      // ── The one question the software cannot answer ──────────────────────
      const fell = await FallPipeline._askGm(tokenDoc, distance);
      if (!fell) {
        console.log(`${LOG} | GM says ${tokenDoc.name} climbed down — no fall.`);
        return;
      }

      // ── Feather Fall window ─────────────────────────────────────────────
      const caught = await FallPipeline._offerFeatherFall(tokenDoc, distance);

      // ── Slow Fall is the FALLER's own reaction, and only matters if
      //    nobody caught them.
      const slowFallFt = caught ? 0 : slowFallReduction(actor);

      const result = resolveFall({ from: fromFt, to: landsAt, caught, slowFallFt });
      await FallPipeline._resolve(tokenDoc, result, { caught, slowFallFt, landsAt, profile });
    } catch (err) {
      console.error(`${LOG} | fall handling failed — the token still moved.`, err);
    }
  }

  /**
   * Why did (or didn't) a fall happen? Returns plain English.
   *
   * ⚠️ BUILT BECAUSE THE PIPELINE BAILED SILENTLY. On 2026-08-13 creatures were
   * stepping off a balcony and simply arriving at -30 ft with no prompt and
   * nothing logged. Every early return in `onLeftHeight` was a bare `return`,
   * so "no fall" and "the fall logic gave up" looked identical from the outside.
   * Call this instead of guessing:
   *
   *     game.aceQol.falling.explain(canvas.tokens.controlled[0].document, 0)
   *
   * @param {TokenDocument} tokenDoc
   * @param {number} fromFt   the height they left
   * @param {number} [toFt]   the height they were heading for. Defaults to the
   *                          token's CURRENT elevation, because by the time
   *                          anyone runs this the move has already happened and
   *                          that is exactly where the ground-level behaviour
   *                          put them. Passing 0 here instead was what made the
   *                          live path and this diagnostic disagree.
   */
  static explain(tokenDoc, fromFt = 0, toFt = Number(tokenDoc?.elevation) || 0) {
    const out = [];
    const say = (t) => { out.push(t); return out; };
    try {
      const actor = tokenDoc?.actor;
      if (!actor) return say("No actor on that token — nothing can fall.");

      say(`Creature: ${actor.name}, currently at ${tokenDoc.elevation} ft, treated as leaving ${fromFt} ft.`);

      const drop = (Number(fromFt) || 0) - (Number(tokenDoc.elevation) || 0);
      say(`Raw drop: ${drop} ft (minimum for any fall is ${MIN_FALL_FT} ft).`);
      if (drop < MIN_FALL_FT) return say("STOPS HERE: the drop is under the minimum, so RAW says nothing happens.");

      const auto = autoNegates(actor);
      if (auto.negated) return say(`STOPS HERE: no fall because it ${auto.reason}.`);
      say("Not flying, hovering, or wearing Feather Fall.");

      const grounds = FallPipeline._groundsBelow(tokenDoc, fromFt);
      say(`ACE ground-level regions found beneath it: ${grounds.length}` +
          (grounds.length ? ` (floors at ${grounds.map(g => g.elevation + " ft").join(", ")})` : ""));

      // ⚠️ Same default as the live path. A diagnostic that computes it
      // differently is worse than none — it describes a code path nobody runs.
      const landsAt = landingElevation(grounds, fromFt, Number(toFt) || 0);
      const distance = fromFt - landsAt;
      say(`Lands at ${landsAt} ft, so the fall is ${distance} ft.`
          + (grounds.length ? "" : ` (no region detected beneath, so this used the destination height ${Number(toFt) || 0} ft that the ground-level behaviour resolved)`));
      if (distance < MIN_FALL_FT) {
        return say("STOPS HERE: after working out what is underneath, the fall is under the minimum. " +
                   "If that looks wrong, the region beneath is not being detected — check its shape and that it carries the ACE Ground Level behaviour.");
      }

      say(`WOULD PROMPT: a ${distance} ft fall, ${Math.min(20, Math.floor(distance / 10))}d6 bludgeoning if it lands.`);
      return out;
    } catch (err) {
      return say(`The check itself threw: ${err?.message ?? err}`);
    }
  }

  /**
   * Is this point horizontally inside the region?
   *
   * ⚠️ 🔴 DO NOT USE `region.testPoint({…, elevation})` FOR THIS. Found live
   * 2026-08-13, and it silently killed every fall into a sunken area.
   *
   * Foundry's `testPoint` reads `point.elevation` and checks it against the
   * REGION'S OWN vertical band — `(bottom <= elevation) && (elevation <= top)`.
   * A region's bottom defaults to **0**, so probing at the region's floor
   * height of −30 was rejected before the polygon was ever consulted. The
   * pipeline concluded there was no ground below, put the landing at the scene
   * floor, computed a drop of zero, and returned. No error, no log, no prompt —
   * Johnny walked a character off a balcony repeatedly and nothing happened.
   *
   * The region's vertical band answers "where does this region EXIST". We are
   * asking "is this floor UNDER that point". Different question, so ask the
   * polygon directly.
   */
  static _pointInRegion(region, centre, elev) {
    try {
      if (region?.polygonTree?.testPoint) return !!region.polygonTree.testPoint(centre);
    } catch (_) { /* fall through to the compatible probe */ }
    try {
      // Probe at an elevation the region will actually accept, so the answer
      // reflects the polygon rather than the band.
      const bottom = Number(region?.elevation?.bottom);
      const probe = Number.isFinite(bottom) ? bottom : elev;
      return !!region?.testPoint?.({ ...centre, elevation: probe });
    } catch (_) { return false; }
  }

  /** Every ACE ground-level region under this point, with its floor height. */
  static _groundsBelow(tokenDoc, fromFt) {
    const out = [];
    try {
      const scene = tokenDoc?.parent;
      const centre = { x: tokenDoc.x + (tokenDoc.width * (scene.grid?.size ?? 100)) / 2,
                       y: tokenDoc.y + (tokenDoc.height * (scene.grid?.size ?? 100)) / 2 };
      for (const region of scene?.regions ?? []) {
        for (const b of region.behaviors ?? []) {
          if (b.type !== "ace-artificer.groundLevel" || b.disabled) continue;
          const elev = Number(b.system?.elevation) || 0;
          if (elev >= fromFt) continue;                     // not below them
          if (!FallPipeline._pointInRegion(region, centre, elev)) continue;
          out.push({ elevation: elev });
        }
      }
    } catch (err) {
      console.warn(`${LOG} | could not read what is below — assuming the scene floor.`, err);
    }
    return out;
  }

  /** "Did he fall, or climb down?" — Fall is the default. */
  static async _askGm(tokenDoc, distance) {
    const name = foundry.utils.escapeHTML(tokenDoc.name ?? "Someone");
    // ⚠️ WRAP THE BODY IN A DARK CONTAINER. Foundry's Dialog has a LIGHT
    // parchment background, so #f0e4c0 body text on it is very nearly
    // invisible — which is exactly what shipped first and exactly what the
    // standing rule warns about. Every ACE feature dialog gets the dark wrapper
    // so our own palette works; never light-on-light.
    const content = `
      <div style="background:#0f1014;border:1px solid #3a3122;border-left:4px solid #d4af37;
                  border-radius:5px;padding:14px 16px;line-height:1.55;">
        <div style="font-size:19px;font-weight:700;color:#d4af37;margin-bottom:6px;">${name} left a ${distance} ft height</div>
        <div style="color:#c9bd94;font-size:16px;">Was that a fall, or did they take a safe way down —
        stairs, a ladder, a rope?</div>
      </div>`;
    return new Promise((resolve) => {
      let done = false;
      const finish = (v) => { if (!done) { done = true; resolve(v); } };
      new Dialog({
        title: "A long way down",
        content,
        buttons: {
          fall:  { label: `They fall — ${distance} ft`, icon: '<i class="fas fa-arrow-down"></i>',
                   callback: () => finish(true) },
          climb: { label: "They climbed down safely", icon: '<i class="fas fa-shoe-prints"></i>',
                   callback: () => finish(false) },
        },
        default: "fall",
        // ⚠️ Closing the dialog means FALL. The default must be the dramatic
        // reading, or an ignored prompt silently cancels the rule.
        close: () => finish(true),
      }).render(true);
    });
  }

  /**
   * Offer Feather Fall to anyone in range who could actually cast it.
   * @returns {Promise<boolean>} did somebody catch them
   */
  static async _offerFeatherFall(tokenDoc, distance) {
    try {
      const falling = tokenDoc.object;
      const candidates = [];
      for (const t of canvas.tokens?.placeables ?? []) {
        if (!t?.actor || t.id === tokenDoc.id) continue;
        if (aceDistanceFt(t, falling) > FEATHER_FALL_RANGE_FT) continue;
        const spell = (t.actor.items ?? []).find(i =>
          i.type === "spell" && /^feather\s*fall$/i.test(String(i.name ?? "")));
        if (!spell) continue;

        // ⚠️ A REACTOR MUST BE ABLE TO ACT. An unconscious, paralyzed, stunned
        // or petrified wizard cannot cast Feather Fall — and prompting their
        // player to do it is worse than not offering at all. `canAct` is the
        // established reader (it gates the action economy and lets free/passive
        // uses through). The ONE GATE write-up names "0 canAct" as the proof
        // that the save engine was not reading its targets; this is the same
        // omission on the reaction side.
        const able = CombatContext.canAct(t.actor, { activationType: "reaction", isSpell: true, item: spell });
        if (able?.ok === false) {
          console.log(`${LOG} | ${t.name} has Feather Fall but cannot act (${able.reason ?? "incapacitated"}) — not offered.`);
          continue;
        }

        // A dead creature catches nobody.
        const theirs = buildTargetProfile(t.actor, { token: t });
        if (theirs?.hasCondition?.("dead") || Number(t.actor.system?.attributes?.hp?.value) <= 0) continue;

        candidates.push({ token: t, spell });
      }
      if (!candidates.length) return false;

      console.log(`${LOG} | ${candidates.length} creature(s) could catch ${tokenDoc.name}.`);

      // Ask them in turn; the first yes ends it — Feather Fall from two casters
      // is two slots for one outcome.
      for (const { token, spell } of candidates) {
        const said = await FallPipeline._askReactor(token, tokenDoc, distance, spell);
        if (said) {
          await ChatMessage.create({
            content: `<div style="padding:6px 2px;font-size:14px;line-height:1.5">
              <strong>${foundry.utils.escapeHTML(token.name)}</strong> catches
              <strong>${foundry.utils.escapeHTML(tokenDoc.name)}</strong> with
              <em>Feather Fall</em> — they drift the ${distance} ft and land on their feet.</div>`,
            speaker: { alias: "Feather Fall" },
          });
          return true;
        }
      }
    } catch (err) {
      console.warn(`${LOG} | the Feather Fall window failed — the fall still resolves.`, err);
    }
    return false;
  }

  /** One reactor's prompt, routed to whoever owns them. */
  static async _askReactor(reactorToken, fallingDoc, distance, spell) {
    const { ReactionEngine } = await import("./reaction-engine.mjs");
    const data = {
      type: "featherFall",
      title: "Feather Fall?",
      description: `${fallingDoc.name} is falling ${distance} feet.`,
      details: "Your reaction. They drift gently down and take no damage.",
      acceptLabel: "Cast Feather Fall",
      declineLabel: "Let them fall",
      icon: spell?.img ?? "icons/magic/air/wind-swirl-gray.webp",
      accentColor: "#9ad0ff",
      reactorActorName: reactorToken.actor?.name,
      reactorActorImg: reactorToken.actor?.img,
      reactorIsNpc: reactorToken.actor?.type !== "character",
    };
    try {
      return !!(await ReactionEngine.showReactionDialog(data));
    } catch (err) {
      console.warn(`${LOG} | could not prompt ${reactorToken.name} — treated as a decline.`, err);
      return false;
    }
  }

  /**
   * Damage, prone, and a REAL damage card.
   *
   * ⚠️ THIS USES THE SUITE'S DAMAGE CARD, NOT A BESPOKE ONE.
   * Johnny, 2026-08-11: "We have a damage pipeline. Why did you have to build a
   * whole new chat card?" He was right. The first version applied damage
   * immediately and printed a hand-made card, which cost:
   *   • APPLY ALL / UNDO ALL          • per-component override
   *   • resistant / immune / vulnerable badges, GM-only
   *   • the token portrait, current → new hit points, death shading
   *
   * All of that lives in `DamageApplicator` and is driven ENTIRELY by message
   * flags — `damageResults` plus the two buttons. It needs no attacker and no
   * item, so a fall fits it exactly. We build the same flags, reuse
   * `DamageCardRenderer.buildTargetRowHtml` for the row, and every behaviour
   * comes along for free.
   *
   * ⚠️ DAMAGE IS NO LONGER APPLIED IMMEDIATELY. It waits for APPLY ALL, like
   * every other damage in the system. Prone still lands at once — being knocked
   * down is the fall itself, not its damage.
   */
  /**
   * Can this creature be knocked prone at all?
   *
   * Prefers the target profile — `Situation.readCreature` is THE reader, and it
   * already normalises dnd5e's shapes. Falls back to reading the actor's own
   * condition immunities so a caller that forgets to pass a profile still gets
   * the right answer rather than silently knocking a gibbering mouther down.
   *
   * ⚠️ IMMUNITY IS A **Set** IN dnd5e 5.x, not an Array. `Array.from` handles
   * both; `.includes` on a Set silently reports "not immune" for everything.
   */
  static _cannotBeProne(actor, profile = null) {
    try {
      if (profile?.immuneToCondition?.("prone")) return true;
      const ci = actor?.system?.traits?.ci?.value;
      return Array.from(ci ?? []).map(v => String(v).toLowerCase()).includes("prone");
    } catch (err) {
      // ⚠️ Never let a failed READ decide a rule. If we cannot tell, the RAW
      // default applies: a falling creature lands prone.
      console.warn(`${LOG} | could not read prone immunity for ${actor?.name} — assuming it CAN be knocked prone.`, err);
      return false;
    }
  }

  static async _resolve(tokenDoc, result, { caught, slowFallFt, landsAt, profile = null } = {}) {
    const actor = tokenDoc?.actor;
    const name = foundry.utils.escapeHTML(tokenDoc.name ?? "Someone");

    if (result.negated) {
      await FallPipeline._noteCard(tokenDoc, result.distanceFt,
        result.reason || "No damage.", "#7fc98b");
      return;
    }

    let roll = null;
    try {
      roll = await new Roll(result.formula).evaluate();
      try {
        game.aceQol?.dice?.show?.(roll, "falling");
        await game.aceQol?.dice?.settle?.(3000);
      } catch (_) { /* the fall still resolves without an animation */ }
    } catch (err) {
      console.error(`${LOG} | the falling damage roll failed — nothing applied.`, err);
      ui.notifications?.error(`${name}'s fall did not roll. See the console.`);
      return;
    }

    // ── Prone lands now; the damage waits for APPLY ALL ──────────────────
    //
    // RAW: a creature that falls lands prone. It is part of the fall itself,
    // not a consequence of the damage — so it resolves BEFORE the card is
    // built, and the card only claims "Lands prone" once the status is verified
    // on the creature. (That verification is what exposed the ghost bug.)
    //
    // ⚠️ NOT EVERY CREATURE CAN BE KNOCKED PRONE. Anything with prone in its
    // condition immunities — oozes and other formless things, and a fair few
    // aberrations — simply does not go down, and the fall still hurts.
    if (result.prone && FallPipeline._cannotBeProne(actor, profile)) {
      console.log(`${LOG} | ${name} cannot be knocked prone — the fall still deals damage.`);
      result.prone = false;
    }
    // Already down? Leave it alone; toggling would stand them up.
    if (result.prone && actor?.statuses?.has?.("prone")) {
      console.log(`${LOG} | ${name} was already prone.`);
    }
    if (result.prone) {
      try {
        if (typeof actor?.toggleStatusEffect !== "function") {
          throw new Error("Actor#toggleStatusEffect is not a function on this actor");
        }
        if (!actor.statuses?.has?.("prone")) await actor.toggleStatusEffect("prone", { active: true });
        if (!actor.statuses?.has?.("prone")) {
          console.error(`${LOG} | prone did NOT stick on ${name}.`);
          result.prone = false;
        }
      } catch (err) {
        console.error(`${LOG} | could not apply prone to ${name}:`, err);
        result.prone = false;
      }
    }

    // ── Classify the bludgeoning against this creature ────────────────────
    // ⚠️ ASK THE EXISTING CLASSIFIER. It normalises dnd5e 5.x Sets vs older
    // Arrays — reading `traits.dr.value` by hand is what silently sent immunity
    // detection down the "normal damage" path before.
    let modifier = "normal", final = roll.total;
    try {
      const mods = DamageCalculator.getTargetDamageModifiers(actor);
      const m = mods?.bludgeoning?.modifier;
      if (m === "immune")     { modifier = "immune";     final = 0; }
      else if (m === "resistant")  { modifier = "resistant";  final = Math.floor(roll.total / 2); }
      else if (m === "vulnerable") { modifier = "vulnerable"; final = roll.total * 2; }
    } catch (err) {
      console.warn(`${LOG} | could not classify bludgeoning for ${name} — treating as normal.`, err);
    }

    const hp = profile?.hp ?? {
      value: Number(actor?.system?.attributes?.hp?.value) || 0,
      max: Number(actor?.system?.attributes?.hp?.max) || 0,
    };
    // ⚠️ CARRY THE ROLL. The card's dice faces are rendered from
    // `component.roll.terms` — without it the card printed a bare number and no
    // dice at all, which is exactly what Johnny saw on 2026-08-12.
    const components = [{
      name: `Fall — ${result.distanceFt} ft`,
      type: "bludgeoning", raw: roll.total, final, modifier,
      formula: result.formula, roll,
    }];

    // ⚠️ PORTRAIT, NOT TOKEN ART. `tokenDoc.texture.src` is the battle-map
    // image, and for a creature that just landed prone that is now the PRONE
    // art — a card full of upside-down figures. The actor portrait is the face.
    // Token art only stands in when there is no portrait at all.
    const portraitImg = actor?.img || tokenDoc.texture?.src || "icons/svg/mystery-man.svg";

    const row = DamageCardRenderer.buildTargetRowHtml({
      tokenDocId: tokenDoc.id, actorId: actor?.id, sceneId: tokenDoc.parent?.id,
      name: tokenDoc.name, img: portraitImg,
      currentHP: hp.value, maxHP: hp.max, totalFinal: final, isCrit: false, components,
    });

    // The dice-and-total row, through the SAME renderer every other ACE damage
    // card uses — configured die colour, crit labels, type totals, all shared.
    const diceRows = DamageCardRenderer.buildComponentRowsHtml(components, {
      baseName: components[0].name,   // the header already names the fall
    });

    const notes = [];
    if (slowFallFt > 0) notes.push(`Slow Fall absorbs ${slowFallFt} ft.`);
    if (result.prone)   notes.push("Lands prone.");

    // ⚠️ 🔴 THE STRUCTURE HERE IS LOAD-BEARING — it is not decoration.
    // Found live 2026-08-12: the GM could not press APPLY ALL / UNDO ALL, and a
    // PLAYER could see both buttons. One cause for both.
    //
    //   • `type: "damageResult"` — damage-engine's card handler opens with a
    //     whitelist check on this exact field. Without it the handler returns on
    //     its FIRST LINE, so the buttons never get a click listener (dead for
    //     the GM) and the hide-GM-controls pass never runs (visible to players).
    //     The flags looked complete; the one field the gate reads was missing.
    //
    //   • `.ace-qol-dmg-gm-controls` and `.ace-qol-dmg-targets` — those exact
    //     class names are what the handler hides from non-GMs. Inline styles do
    //     nothing for it.
    //
    //   • `.ace-qol-damage-card` and the shared button classes — otherwise the
    //     card is unstyled, which is why it lacked ACE's black background and
    //     did not read as ours.
    await ChatMessage.create({
      speaker: ChatMessage.getSpeaker({ token: tokenDoc }),
      content: `<div class="ace-qol-damage-card">
          <div class="ace-qol-dmg-header">
            <img src="${portraitImg}" class="ace-qol-dmg-item-img" alt="" />
            <strong class="ace-qol-dmg-item-name">${name} falls ${result.distanceFt} ft</strong>
          </div>
          <div class="ace-qol-dmg-roll-section">
            <div class="ace-qol-dmg-components">${diceRows}</div>
          </div>
          <div class="ace-qol-dmg-targets">${row}</div>
          ${notes.length ? `<div class="ace-qol-dmg-source-caption" style="color:#b3a888;">${notes.join(" ")}</div>` : ""}
          <div class="ace-qol-dmg-gm-controls">
            <div class="ace-qol-dmg-actions">
              <button class="ace-qol-btn ace-qol-btn-apply" data-action="aceQolApplyDamage">
                <i class="fas fa-heart-crack"></i> APPLY ALL
              </button>
              <button class="ace-qol-btn ace-qol-btn-undo" data-action="aceQolUndoDamage" disabled>
                <i class="fas fa-undo"></i> UNDO ALL
              </button>
            </div>
          </div>
        </div>`,
      flags: {
        [MODULE_ID]: {
          // ⚠️ THE GATE. damage-engine.mjs only decorates cards whose type is in
          // its whitelist. Leave this out and every button on this card is dead.
          type: "damageResult",
          // The shape DamageApplicator reads. No item, no attacker — a fall has
          // neither, and neither is required.
          damageResults: [{
            targetId: actor?.id, tokenId: tokenDoc.id, tokenDocId: tokenDoc.id,
            sceneId: tokenDoc.parent?.id, isLinked: tokenDoc.actorLink ?? false,
            totalFinal: final, currentHP: hp.value, maxHP: hp.max,
            name: tokenDoc.name, img: portraitImg,
            components: components.map(({ roll: _r, ...rest }) => rest),  // a Roll does not belong in flags
          }],
          totalRaw: roll.total,
          aceFall: { distanceFt: result.distanceFt, landsAt, caught: !!caught, slowFallFt },
        },
      },
    });
  }

  /** A short card for a fall that did no damage at all. */
  static async _noteCard(tokenDoc, distanceFt, text, colour = "#b3a888") {
    const name = foundry.utils.escapeHTML(tokenDoc.name ?? "Someone");
    await ChatMessage.create({
      speaker: ChatMessage.getSpeaker({ token: tokenDoc }),
      content: `<div style="border-left:4px solid #d4af37;padding:12px 16px;background:#191b22;border-radius:5px;">
          <div style="color:#d4af37;font-size:15px;letter-spacing:.08em;text-transform:uppercase;font-weight:700;">Falling</div>
          <div style="color:#f5ead0;font-size:19px;line-height:1.45;margin-top:5px;">${name} falls ${distanceFt} ft</div>
          <div style="color:${colour};margin-top:4px;">${foundry.utils.escapeHTML(text)}</div>
        </div>`,
    });
  }
}
