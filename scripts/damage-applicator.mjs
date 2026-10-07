// ─── ACE: QOL — Damage Applicator ────────────────────────────────────────────
// HP mutation: apply damage, undo damage, per-type toggle, override multipliers,
// add target / cleave. Owns the override cache and actor resolution.
// ──────────────────────────────────────────────────────────────────────────────

import { MODULE_ID } from "./ace-qol.mjs";
import { DamageCalculator } from "./damage-calculator.mjs";
import { DamageCardRenderer } from "./damage-card-renderer.mjs";
import { DamageConstants } from "./damage-engine.mjs";
import { TransformationEngine } from "./transformation-engine.mjs";
// The One Road: hit points land through the hit-point door and cards through
// the card door (Phase 3, 2026-09-14). Read at function time only.
import { HpDoor, CardDoor } from "./road/doors.mjs";
// What an attack's recipe lets land on each target's result, asked at APPLY.
import { whatLands } from "./road/what-lands.mjs";
import { faceOf } from "./face.mjs";

/**
 * Per-actor write queue for hit-point changes.
 *
 * ⚠️ APPLYING DAMAGE IS READ-MODIFY-WRITE, AND IT WAS NOT SERIALISED
 * (Grok audit 2026-08-18). `applyHPDamage` reads `hp.value`, fires
 * `dnd5e.preApplyDamage` (which listeners may await), computes the new total
 * from the value it read, and writes. Two applications landing together on the
 * same creature both read 50, both compute 40, and both write 40 — ten damage
 * simply gone, with no error and nothing in the log to notice.
 *
 * That is not exotic. It is a GM double-clicking APPLY ALL, two damage cards
 * resolved back to back, an area spell and an opportunity attack in the same
 * beat, or a rider firing while the parent hit applies.
 *
 * Every HP mutation now chains behind the previous one FOR THAT ACTOR, and the
 * current total is re-read INSIDE the critical section. Different creatures
 * still apply in parallel — the lock is per actor, not global.
 */
const _hpQueues = new Map();   // actorId → Promise

function _withActorHpLock(actor, fn) {
  const id = actor?.id ?? actor?.uuid ?? "unknown";
  const prev = _hpQueues.get(id) ?? Promise.resolve();
  // ⚠️ Chain off a SETTLED promise. A rejection upstream must not poison the
  // queue for every later application on this creature.
  const next = prev.catch(() => {}).then(fn);
  _hpQueues.set(id, next.catch(() => {}));
  return next;
}

export class DamageApplicator {

  /** In-memory override cache for per-row damage multipliers.
   *  Key: `${messageId}|${tokenDocId}` → multiplier (number) or "removed" */
  static overrideCache = new Map();

  // ═══════════════════════════════════════════════════════════════════════════
  //  Universal HP Mutator — Single Source of Truth
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * THE single helper for applying damage to an actor's HP.
   *
   * Every damage path in ace-qol should funnel through here. Owns:
   *   1. Computing newHP = max(0, currentHP - damage)
   *   2. Polymorph excess-damage capture (RAW carryover)
   *   3. The actual actor.update() write
   *   4. Optional pre-update return value with computed newHP for callers
   *      that need to display "X → Y" before the await
   *
   * Replaces a previously-scattered pattern across damage-applicator,
   * save-engine, post-hit-saves, heal-card-renderer, overtime-engine, etc.
   *
   * @param {Actor}   actor       — the target whose HP we're mutating
   * @param {number}  damageAmount — raw incoming damage (positive integer)
   * @param {object}  [opts]
   * @param {string}  [opts.label] — optional label for the console log line
   * @param {boolean} [opts.skipPolymorphCapture] — skip excess capture (rare)
   * @returns {Promise<{currentHP, newHP, excess, applied}>}
   *   Returns the resolved values so callers can render UI BEFORE awaiting
   *   the actor.update if they want. `applied` is the actual update Promise.
   */
  static async applyHPDamage(actor, damageAmount, opts = {}) {
    // ── v0.4.22 GM-only guard ──
    // Defense-in-depth: Foundry's permission system blocks the actual
    // actor.update() call for non-owners, but the front-half of this
    // function (calculating excess, etc.) and any side-effects in the
    // calling chain should never fire for non-GMs.
    if (!game.user.isGM) {
      console.warn(`${MODULE_ID} | applyHPDamage called by non-GM (${game.user.name}) — blocked`);
      return { currentHP: actor?.system?.attributes?.hp?.value ?? 0, newHP: actor?.system?.attributes?.hp?.value ?? 0, excess: 0, applied: Promise.resolve() };
    }

    // Serialise every HP mutation for this creature — see _withActorHpLock.
    return _withActorHpLock(actor, async () => {
    let damage      = Math.max(0, Number(damageAmount) || 0);
    // ⚠️ READ INSIDE THE LOCK. Reading before the queue is what lost the update.
    const currentHP = Number(actor?.system?.attributes?.hp?.value ?? 0);

    // ── 🔴 ACE DAMAGE MUST ANNOUNCE ITSELF (audit fix, 2026-08-07) ──────────
    // Everything below this line writes hit points with a raw actor.update, so
    // dnd5e's own "damage is being applied" notification NEVER fired for the
    // most common event in the game — an APPLY ALL from the damage card.
    //
    // That single gap silently killed SIX features that all listen for it:
    //   • Heavy Armor Master  — the -3 reduction never applied. The feat was dead.
    //   • Massive-damage instant death (PHB 197) — never fired on a normal hit.
    //   • Hide reveals on damage — a hidden creature stayed hidden after being hit.
    //   • Charm break / Dominate re-save on damage.
    //   • Forge's per-item on-hit FX.
    //   • (heal side, below) Sword of Wounding's heal-block.
    //
    // condition-raw-hooks.mjs found this on 2026-06-24 and patched ONE consumer
    // (waking a sleeper). Nobody went back for the other eight listeners.
    //
    // Emitted with Hooks.call and the identical (actor, amount, updates, options)
    // signature dnd5e uses, so a listener that MUTATES options.damages (Heavy
    // Armor Master) or RETURNS FALSE (a hard cancel) behaves exactly as it would
    // on a system-routed hit. We re-read the damages afterwards and honour both.
    const _damages = Array.isArray(opts.damages) && opts.damages.length
      ? opts.damages.map(d => ({ ...d }))
      : [{ value: damage, type: (Array.isArray(opts.types) ? opts.types[0] : opts.types) || "none", properties: new Set() }];
    const _updates = {};
    try {
      const proceed = Hooks.call("dnd5e.preApplyDamage", actor, damage, _updates, {
        ...(opts.hookOptions ?? {}),
        damages: _damages,
        aceQol: true,          // listeners can tell ACE's emission from dnd5e's own
      });
      if (proceed === false) {
        console.log(`${MODULE_ID} | applyHPDamage: a listener cancelled the damage on ${actor?.name}.`);
        return { currentHP, newHP: currentHP, excess: 0, applied: false, tempUsed: 0, newTemp: Number(actor?.system?.attributes?.hp?.temp ?? 0) };
      }
      // Honour reductions a listener wrote back into the damage entries.
      const reduced = _damages.reduce((sum, d) => sum + Math.max(0, Number(d?.value) || 0), 0);
      if (Number.isFinite(reduced) && reduced !== damage) {
        console.log(`${MODULE_ID} | applyHPDamage: a listener adjusted the damage on ${actor?.name}: ${damage} → ${reduced}.`);
        damage = Math.max(0, reduced);
      }
    } catch (err) {
      // A broken listener must never stop damage landing.
      console.warn(`${MODULE_ID} | applyHPDamage: a dnd5e.preApplyDamage listener threw (damage still applies):`, err);
    }
    const tempHP    = Math.max(0, Number(actor?.system?.attributes?.hp?.temp ?? 0));

    // ── Temp HP absorbs first (RAW, 2014 + 2024) ──
    // "If you have temporary hit points and take damage, the temporary hit points
    //  are lost first, and any leftover damage carries over to your normal HP."
    const tempUsed  = Math.min(tempHP, damage);
    const newTemp   = tempHP - tempUsed;
    const toRealHP  = damage - tempUsed;                  // damage remaining past temp HP
    const newHP     = Math.max(0, currentHP - toRealHP);
    const excess    = Math.max(0, toRealHP - currentHP);  // carryover past real HP (polymorph)

    // ── Polymorph excess-damage capture (RAW carryover) ──
    // If this hit drops a polymorphed creature to 0, stash the excess so
    // TransformationEngine._handleZeroHPRevert can apply it to the
    // original form's HP. Belt-and-suspenders w/ dnd5e.preApplyDamage.
    if (excess > 0 && !opts.skipPolymorphCapture) {
      try { TransformationEngine.recordPendingExcess?.(actor, excess); } catch (_) {}
    }

    // ── The actual write ──
    // v0.7.21: pass `dnd5e.concentrationCheck: false` so dnd5e's vanilla
    // challengeConcentration card is suppressed. We post our own (with proper
    // PC roll button + NPC auto-roll + fail-cascades-dependents) below.
    // The escape hatch lives at dnd5e.mjs ~line 26287 (HP-update handler).
    // v0.7.68: also pass `aceQol.fullDamage` (TOTAL damage, pre-temp-HP) so the
    // patched Actor.update wrapper computes the concentration DC from TOTAL damage
    // — RAW: temp HP does NOT lower the concentration DC, and a save still fires
    // even when temp HP absorbs the whole hit (Sage Advice). Write hp.temp only
    // when temp was actually consumed (keeps the update diff clean otherwise).
    const updateData = { "system.attributes.hp.value": newHP };
    if (tempUsed > 0) updateData["system.attributes.hp.temp"] = newTemp;
    const updatePromise = actor.update(
      updateData,
      { dnd5e: { concentrationCheck: false }, aceQol: { fullDamage: damage } }
    );

    if (opts.label) {
      const tempNote = tempUsed > 0 ? ` [temp ${tempHP}→${newTemp}, absorbed ${tempUsed}]` : "";
      console.log(`${MODULE_ID} | applyHPDamage [${opts.label}]: ${actor.name} ${currentHP} → ${newHP}${tempNote}${excess > 0 ? ` (excess ${excess} captured)` : ""}`);
    }

    await updatePromise;

    // ── FX chokepoint ── Every ACE damage path (APPLY ALL, Cleave, save-for-half)
    // funnels through this one write, so it's the only place the auto-animation
    // layer can RELIABLY hear "damage landed" — including the save-for-half path
    // that writes HP raw and fires none of dnd5e's own damage hooks. Carries the
    // damage type(s) the caller passed (opts.types) so the impact can be themed.
    // Cosmetic only — must never break the damage write.
    if (damage > 0) {
      try {
        Hooks.callAll(`${MODULE_ID}.hpApplied`, {
          actor,
          amount: damage,
          types: Array.isArray(opts.types) ? opts.types : (opts.types ? [opts.types] : []),
          label: opts.label ?? null,
        });
      } catch (_) { /* never let FX break a damage write */ }
    }

    // Concentration check fires GLOBALLY from the patched Actor.update wrapper
    // (see ace-qol.mjs init), using aceQol.fullDamage for a RAW-correct DC.
    // Don't call it explicitly here — would double-fire.

    return { currentHP, newHP, excess, applied: true, tempUsed, newTemp };
    });   // ← end per-actor HP lock
  }

  /**
   * v0.7.21 — ACE-owned concentration save on damage.
   * Detects concentrating status and asks dnd5e for the DC (its own rule for
   * the world's edition). A creature somebody plays is asked once for this hit
   * in the roll box (concentration-prompt.mjs); any other rolls at once. A
   * failure is ended by the check gate's one outcome listener.
   *
   * Skips silently if actor isn't concentrating (there is nothing to check).
   */
  static async _triggerAceConcentrationCheck(actor, damage) {
    if (!actor?.effects) return;
    const concEffect = actor.effects.find?.(e =>
      e.statuses?.has?.("concentration") || e.statuses?.has?.("concentrating"));
    if (!concEffect) return;

    // ⚠️ dnd5e's OWN RULE, BOTH EDITIONS (2026-09-19). This was
    // `max(10, floor(damage / 2))`, which is the 2014 rule only: the 2024 rules
    // cap the DC at 30, and dnd5e's getConcentrationDC does exactly that for a
    // "modern" world. Asking dnd5e keeps the two from drifting apart again.
    const dc = typeof actor.getConcentrationDC === "function"
      ? actor.getConcentrationDC(damage)
      : Math.max(10, Math.floor(damage / 2));
    const conMod = actor.system?.abilities?.con?.mod ?? 0;
    const conSaveBonus = Number(actor.system?.abilities?.con?.bonuses?.save ?? 0);
    const profBonus = actor.system?.attributes?.prof ?? 0;
    // Concentration uses CON save; proficiency comes from War Caster / class /
    // Resilient feat — read the actor's CON save proficiency.
    const isProficient = (actor.system?.abilities?.con?.proficient ?? 0) > 0;
    const profPart = isProficient ? ` + ${profBonus}` : "";
    const bonusPart = conSaveBonus ? ` + ${conSaveBonus}` : "";
    const formula = `1d20 + ${conMod}${profPart}${bonusPart}`;

    const isPc = actor.type === "character" || actor.hasPlayerOwner;
    const concName = concEffect.name || "Concentrating";

    if (isPc) {
      // ⚠️ ONE CHECK FOR THIS HIT, ASKED IN THE ROLL BOX (Johnny, 2026-09-19:
      // "One check per damage event. Button dies after the roll. Same d20
      // widget as the save popout."). This posted a public card whose button
      // remembered nothing, so a second click rolled a second save for the same
      // hit. The prompt now carries its own state and is asked of the one who
      // answers for the creature (concentration-prompt.mjs).
      try {
        const { ConcentrationPrompt } = await import("./concentration-prompt.mjs");
        await ConcentrationPrompt.ask(actor, { damage, dc, effect: concEffect });
      } catch (err) {
        console.error(`${MODULE_ID} | ${actor.name}'s concentration check (DC ${dc}, ${concName}) could not be asked:`, err);
        // dc-ok: damage is applied on the GM's client, so this error is his to read.
        ui.notifications?.error(`ACE could not ask ${actor.name}'s concentration check (DC ${dc}). `
          + `Roll it from the sheet; the console has why.`);
      }
    } else {
      // NPC path — auto-roll, show result, on fail delete the effect.
      //
      // ⚠️🔴 THIS ROLLED A FLAT d20 AND IGNORED ADVANTAGE. It built
      // "1d20 + CON + prof" as a string and threw it with a bare Roll, so a
      // monster with advantage on concentration saves — a Warcaster-equivalent
      // trait, an effect, a legendary feature — rolled straight. The PC button
      // was fixed to go through `rollConcentration` in 0.15.2; this branch was
      // the other half of the same bug.
      //
      // ⚠️ NO PROMPT FOR AN NPC. Asking `configure:false` and `create:false`
      // is exactly how the check gate recognises an engine rolling for itself,
      // so it stands aside and dnd5e resolves the advantage from the
      // concentration attribute AND the Constitution save, as RAW requires.
      const npcRolls = await actor.rollConcentration?.({ target: dc },
                                                       { configure: false },
                                                       { create: false });
      const roll = (Array.isArray(npcRolls) ? npcRolls[0] : npcRolls)
        ?? await new Roll(formula).evaluate();   // only if the method is gone
      const total = Number(roll?.total);
      if (!Number.isFinite(total)) {
        // ⚠️ NEVER LET A CONCENTRATION CHECK EVAPORATE. A monster that keeps
        // concentration because the roll silently failed is a spell that never
        // ends, and nobody at the table would ever know why.
        console.error(`${MODULE_ID} | ${actor.name}'s concentration roll produced nothing; `
          + `concentration left in place.`);
        ui.notifications?.error(`${actor.name}: the concentration check did not roll. `
          + `Concentration was left as it was — see the console.`);
        return;
      }
      const passed = total >= dc;
      const resultColor = passed ? "#7ec97e" : "#e57373";
      const resultLabel = passed ? "MAINTAINED" : "BROKEN";

      const html = `
        <div style="background:linear-gradient(180deg,#1a1410 0%,#0f0a08 100%);
                    border:2px solid ${resultColor};
                    border-radius:6px;
                    padding:10px 12px;
                    color:#f0e4c0;
                    font-family:'Signika','Helvetica Neue',sans-serif;">
          <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;row-gap:4px;
                      font-size:14px;font-weight:700;color:${resultColor};
                      text-transform:uppercase;letter-spacing:0.6px;
                      border-bottom:1px solid #4a3a28;
                      padding-bottom:6px;margin-bottom:6px;">
            <i class="fas fa-brain" style="font-size:16px;color:${resultColor};flex-shrink:0;"></i>
            <span style="flex:1 1 auto;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">CONCENTRATION ${resultLabel}</span>
          </div>
          <div style="font-size:13px;color:#e8d49a;margin-bottom:4px;">
            <strong>${actor.name}</strong> ${passed ? "held" : "lost"} concentration on <em>${concName}</em>.
          </div>
          <div style="font-size:12px;color:#c0b288;">
            Save: <strong>${total}</strong> vs DC <strong>${dc}</strong> — ${passed ? "SUCCESS" : "FAIL"}
          </div>
        </div>
      `;
      try {
        // The card carries its own roll, and Dice So Nice throws it as the card
        // is drawn; nothing lands from the card itself.
        await CardDoor.post({
          speaker: ChatMessage.getSpeaker({ actor }),
          content: html,
          rolls: [roll],
        });
      } catch (err) {
        console.warn(`${MODULE_ID} | the concentration result card for ${actor.name} could not be posted:`, err);
      }

      if (!passed) {
        // ⚠️🔴 THE EFFECT IS NOT DELETED HERE ANY MORE — ONE WRITER ONLY.
        // Now that this branch rolls through `rollConcentration`, the single
        // listener in `check-gate.mjs` (`_registerConcentrationOutcome`) fires
        // on `dnd5e.rollConcentrationV2` and ends it. Deleting here as well
        // would be two writers on one decision, which is how a corpse kept its
        // concentration and a live caster lost it twice.
        console.log(`${MODULE_ID} | Concentration BROKEN: ${actor.name} failed `
          + `(${total} vs DC ${dc}) — the outcome listener ends it.`);
      } else {
        console.log(`${MODULE_ID} | Concentration MAINTAINED: ${actor.name} passed concentration save (${total} vs DC ${dc})`);
      }
    }
  }

  /**
   * THE single helper for healing. Mirror of applyHPDamage.
   * Clamps to max HP. No polymorph excess capture (healing doesn't trigger
   * carryover). Used by heal-card-renderer + heal-pipeline.
   *
   * @param {Actor}  actor      — target
   * @param {number} healAmount — positive integer
   * @param {object} [opts]
   * @param {string} [opts.label]
   * @param {Actor|string} [opts.healer] — the creature that did it. A creature
   *        healing ITSELF passes itself: that is an answer, and the record needs
   *        it. Leaving it out means nobody knows, and nothing is credited.
   * @returns {Promise<{currentHP, newHP, applied, healedAmount}>}
   */
  static async applyHPHeal(actor, healAmount, opts = {}) {
    // ── v0.4.22 GM-only guard ──
    if (!game.user.isGM) {
      console.warn(`${MODULE_ID} | applyHPHeal called by non-GM (${game.user.name}) — blocked`);
      return { currentHP: actor?.system?.attributes?.hp?.value ?? 0, newHP: actor?.system?.attributes?.hp?.value ?? 0, applied: Promise.resolve(), healedAmount: 0 };
    }

    // ⚠️ SAME QUEUE AS DAMAGE, NOT A SEPARATE ONE. Healing is the same
    // read-modify-write on the same field. A heal and a hit resolving together
    // lose one of the two just as surely as two hits do, and an area heal plus
    // a lingering-damage tick in the same beat is an ordinary round.
    return _withActorHpLock(actor, async () => {
    const heal      = Math.max(0, Number(healAmount) || 0);
    const currentHP = Number(actor?.system?.attributes?.hp?.value ?? 0);
    const maxHP     = Number(actor?.system?.attributes?.hp?.max ?? 0);

    // ── HEALS ANNOUNCE THEMSELVES TOO (audit fix, 2026-08-07) ──────────────
    // dnd5e represents healing as NEGATIVE damage through the same
    // notification, and Sword of Wounding blocks a heal by returning false to
    // it. This path wrote hit points raw, so a creature with open wounds could
    // be healed by ACE's per-type undo, regeneration, or an aura — the exact
    // thing the wound is supposed to prevent.
    //
    // ⚠️ EXCEPT A CORRECTION, WHICH IS NOT A HEAL (same day, second pass).
    // An UNDO is the GM rewinding the ledger, not the creature recovering. If it
    // went through the notification, a target with open wounds would make the
    // UNDO button silently do nothing — the GM clicks, hit points don't move,
    // and it looks like the button is broken. It would also wake sleepers and
    // trip on-heal riders for an event that never happened in the fiction.
    // `opts.correction` says "put it back", and nothing gets a vote.
    if (opts.correction === true) {
      console.log(`${MODULE_ID} | applyHPHeal: CORRECTION (${opts.label ?? "undo"}) — restoring ${heal} to ${actor?.name}, not announced as healing.`);
    } else {
      try {
        const proceed = Hooks.call("dnd5e.preApplyDamage", actor, -heal, {}, {
          damages: [{ value: -heal, type: "healing", properties: new Set() }],
          isHealing: true,
          aceQol: true,
        });
        if (proceed === false) {
          console.log(`${MODULE_ID} | applyHPHeal: a listener blocked the heal on ${actor?.name} (e.g. Sword of Wounding).`);
          return { currentHP, newHP: currentHP, healedAmount: 0, applied: false };
        }
      } catch (err) {
        console.warn(`${MODULE_ID} | applyHPHeal: a dnd5e.preApplyDamage listener threw (heal still applies):`, err);
      }
    }
    const newHP     = Math.min(maxHP, currentHP + heal);
    const healedAmount = newHP - currentHP;

    await actor.update({ "system.attributes.hp.value": newHP });

    if (opts.label) {
      console.log(`${MODULE_ID} | applyHPHeal [${opts.label}]: ${actor.name} ${currentHP} → ${newHP} (+${healedAmount})`);
    }

    // ── ANNOUNCE THE HEAL ────────────────────────────────────────────────
    // ⚠️ There was no hook here, so nothing outside this file could know a heal
    // had happened or to WHOM. ACE Engine's only record of healing was a
    // running total on the healer's own sheet: it knew Chudd had healed 240
    // points and had no idea a single one of them went to a dying enemy.
    //
    // Johnny, 2026-08-21, on healing Vilnius in the Amber Temple to keep him
    // alive: "is it recorded?" It was not. His history holds Vilnius BEGGING to
    // be spared and no record that anyone spared him.
    //
    // ⚠️ Corrections are flagged, not hidden. An undo restoring hit points is
    // not an act of mercy and must never be logged as one.
    if (healedAmount > 0) {
      try {
        /* ⚠️🔴 THE HEAL NOW SAYS WHO DID IT (2026-10-04). It never did, and the
           one listener on this signal had to GUESS: it scanned the last few chat
           messages for heal-shaped words and took the speaker's name. So
           Escher's own regeneration, which has no healer at all, was credited to
           whatever card had been posted a moment earlier, and ACE's reputation
           ladder moved for a monster healing itself.

           `opts.healer` is the creature that did it, as an Actor or an id. A
           creature's own regeneration passes itself, which is the whole point:
           self is an answer, and it is not the same answer as "nobody knows". */
        const healerActor = opts.healer?.id ? opts.healer
          : (typeof opts.healer === "string" ? game.actors?.get(opts.healer) ?? null : null);
        const healerActorId = healerActor?.id ?? (typeof opts.healer === "string" ? opts.healer : null);
        Hooks.callAll(`${MODULE_ID}.healApplied`, {
          actor,
          tokenDocId: opts.tokenDocId ?? null,
          amount: healedAmount,
          currentHP, newHP,
          label: opts.label ?? "",
          healerActorId,
          healerName: healerActor?.name ?? opts.healerName ?? "",
          // ⚠️ THE CREATURE'S OWN DOING. Either it was named as its own healer,
          // or no healer was named and the label says where it came from.
          selfHeal: (!!healerActorId && healerActorId === actor?.id)
            || (!opts.healer && /^\s*regenerat/i.test(opts.label ?? "")),
          isCorrection: !!opts.isCorrection || /undo|correction|restore/i.test(opts.label ?? ""),
          wasDying: currentHP <= 0,
        });
      } catch (err) {
        console.warn(`${MODULE_ID} | a healApplied listener threw (the heal still applied):`, err);
      }
    }

    return { currentHP, newHP, healedAmount, applied: true };
    });   // ← end per-actor HP lock (shared with applyHPDamage)
  }

  /**
   * Describe damage by TYPE for the dnd5e notification.
   *
   * Heavy Armor Master reduces bludgeoning / piercing / slashing by 3 EACH and
   * skips anything magical, so it needs the per-type split and the magical flag
   * — a single lumped total tells it nothing. Everything else that listens only
   * needs the total, so this is the one caller-supplied detail that matters.
   *
   * @param {Array}  components  the card's damage components ({type, final})
   * @param {number} multiplier  the row's override (¼ / ½ / 1 / 2×)
   * @param {Item|null} item     the attacking item, for the magical check
   */
  static describeDamages(components, multiplier = 1, item = null) {
    // "Magical" is what stops HAM reducing a +1 sword. Read it off the item:
    // dnd5e marks a magic weapon with a magical bonus and/or the "mgc" property.
    let magical = false;
    try {
      const props = item?.system?.properties;
      magical = Number(item?.system?.magicalBonus ?? 0) > 0
             || props?.has?.("mgc") === true
             || (Array.isArray(props) && props.includes("mgc"));
    } catch (_) { /* unknown → treated as non-magical */ }

    const out = [];
    for (const c of (components ?? [])) {
      const value = Math.floor((Number(c?.final) || 0) * multiplier);
      if (value <= 0) continue;
      out.push({
        value,
        type: String(c?.type ?? "none").toLowerCase(),
        properties: magical ? new Set(["mgc"]) : new Set(),
      });
    }
    return out;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Actor Resolution
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Resolve the correct actor for a damage entry.
   * For unlinked tokens, we need the token's synthetic actor, not the base world actor.
   */
  static resolveTargetActor(entry) {
    const scene = game.scenes.get(entry.sceneId) ?? canvas.scene;
    if (scene) {
      const tokenDoc = scene.tokens?.get(entry.tokenDocId);
      if (tokenDoc?.actor) return tokenDoc.actor;
    }

    const canvasToken = canvas.tokens?.get(entry.tokenDocId);
    if (canvasToken?.actor) return canvasToken.actor;

    return game.actors.get(entry.targetId);
  }

  /**
   * Which rows of an attack's damage card its recipe lets land on one target's
   * result (The One Road, Phase 3, 2026-09-14). Johnny: "APPLY must not take
   * 'whatever the card listed' as the only truth."
   *
   * A row the recipe dealt on the hit lands on a hit or a critical hit; the item's
   * crit dice land only on a critical hit. What the run added and the recipe never
   * named (a smite, Hex, Sneak Attack) lands as the run added it. A card with no
   * attack recipe on it (a save's, an automatic spell's, one posted before this)
   * lands its rows as listed.
   *
   * @returns {{recipe: object|null, verdict: object|null, refusal: (c: object) => string|null}}
   *   `refusal` is null for a row that lands, and why not for one that does not
   */
  static _recipeGate(flags, entry) {
    const recipe = flags?.recipe ?? null;
    if (recipe?.decidedBy?.kind !== "attack") return { recipe: null, verdict: null, refusal: () => null };
    const verdict = whatLands(recipe, { result: entry?.result ?? "hit" });
    const struck = verdict.result === "hit" || verdict.result === "critical";
    const hitDeals = struck && (recipe.onHit ?? []).some(o => o?.kind === "damage");
    const critDeals = verdict.result === "critical" && verdict.extras.length > 0;
    const on = String(verdict.label ?? "no result").toLowerCase();
    return {
      recipe, verdict,
      refusal: (c) => {
        if (c?.recipePart === "onHit" && !hitDeals) return `its recipe deals no damage on a ${on}`;
        if (c?.recipePart === "onCrit" && !critDeals) return `its recipe adds the item's crit dice only on a critical hit, and this was a ${on}`;
        return null;
      },
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Apply Damage to All Targets
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Apply damage to all targets from a damage card.
   *
   * v0.4.22: GM-only guard at function entry.
   *   Foundry permission system blocks the actual actor.update() for non-
   *   owners, but the front-half of this function (flag updates, override
   *   cache writes, button-state changes) runs unguarded on any client
   *   that clicks APPLY ALL. This guard prevents that defense-in-depth gap.
   */
  static async applyDamage(message) {
    if (!game.user.isGM) {
      console.warn(`${MODULE_ID} | applyDamage called by non-GM (${game.user.name}) — blocked. APPLY ALL must run on the GM client.`);
      return;
    }

    const flags = message.flags?.[MODULE_ID];
    const data = flags?.damageResults;
    if (!data?.length) return;

    // Resolved ONCE for the whole card — the magical flag is per-item, not
    // per-target, and fromUuidSync on every row would be wasteful.
    let _srcItem = null;
    try { if (flags.itemUuid) _srcItem = fromUuidSync?.(flags.itemUuid) ?? null; }
    catch (_) { _srcItem = null; }
    // Who dealt it, for the signal the door sends (ace-engine credits the damage).
    const _srcActor = flags.actorId ? (game.actors?.get?.(flags.actorId) ?? null) : null;
    // A damage card from before its recipe travelled with it: said, not guessed at.
    if (flags.type === "damageResult" && flags.recipe === undefined) {
      console.log(`${MODULE_ID} | APPLY ALL: this damage card carries no attack recipe (it was posted before `
        + `ace-qol 0.34.20), so its rows land as listed.`);
    }

    let applied = 0;
    for (const entry of data) {
      const cacheKey = `${message.id}|${entry.tokenDocId}`;
      const cachedValue = DamageApplicator.overrideCache.get(cacheKey);

      // Skip removed targets
      if (cachedValue === "removed") {
        DamageApplicator.overrideCache.delete(cacheKey);
        continue;
      }

      const actor = DamageApplicator.resolveTargetActor(entry);
      if (!actor) {
        console.warn(`${MODULE_ID} | Could not find actor for token ${entry.tokenDocId}`);
        continue;
      }

      // ── Component-level APPLY ALL ──
      // Only sum components that haven't been individually applied (greyed out).
      const appliedComps = flags?.appliedComps?.[entry.tokenDocId] ?? [];
      const override = (typeof cachedValue === "number") ? cachedValue : 1;
      let damageToApply = 0;
      const components = entry.components ?? [];
      const typesApplied = new Set();

      // ⚠️ THE RECIPE, NOT ONLY THE CARD (The One Road, Phase 3, 2026-09-14). A row
      // the attack's recipe does not land on this target's result does not go on,
      // whatever the card lists; what the run added (a smite, Hex) goes on as listed.
      const gate = DamageApplicator._recipeGate(flags, entry);
      const refused = new Set();
      components.forEach((c, i) => {
        const why = gate.refusal(c);
        if (!why || appliedComps.includes(i)) return;
        refused.add(i);
        console.warn(`${MODULE_ID} | APPLY ALL: ${entry.name} does not take ${c.final} ${c.type} (${c.name}): ${why}.`);
      });

      for (let i = 0; i < components.length; i++) {
        if (appliedComps.includes(i)) {
          console.log(`${MODULE_ID} | APPLY ALL: skipping comp ${i} (${components[i].type}) — already applied individually`);
          continue;
        }
        if (refused.has(i)) continue;
        const compDmg = Math.floor(components[i].final * override);
        damageToApply += compDmg;
        if (compDmg > 0 && components[i].type) typesApplied.add(String(components[i].type).toLowerCase());
        console.log(`${MODULE_ID} | APPLY ALL: comp ${i} (${components[i].final} ${components[i].type} × ${override}) = ${compDmg}`);
      }

      console.log(`${MODULE_ID} | APPLY ALL total for ${entry.name}: ${damageToApply} (override=${override}, ${appliedComps.length} comps already applied)`);

      if (damageToApply <= 0) {
        console.log(`${MODULE_ID} | Skipping ${entry.name} — all components already applied`);
        DamageApplicator.overrideCache.delete(cacheKey);
        applied++;
        continue;
      }

      // ── Route through the canonical helper ──
      // applyHPDamage owns the math (newHP = max(0, current - dmg)), the
      // polymorph excess-damage capture (RAW carryover for transformations
      // that drop to 0), the actor.update write, and the diagnostic log.
      // We used to inline all three of those here, which duplicated logic
      // and meant any future change to the polymorph rules needed two
      // edits. Grok audit catch.
      // The components that are ACTUALLY being applied on this pass (already-
      // applied ones are excluded above), each at this row's override.
      //
      // ⚠️ THROUGH THE HIT-POINT DOOR (The One Road, Phase 3, 2026-09-14). The
      // door owns the write (applyHPDamage: temporary hit points first, a
      // listener may cancel, the polymorph carry-over), describes the damage by
      // type with the item's magic for Heavy Armor Master, and sends the one
      // damage-applied signal, with the real hit-point movement in it and who
      // dealt it. APPLY ALL used to write and signal on its own, so a hit landed
      // by a different road than a save.
      let _pending = components.filter((_, i) => !appliedComps.includes(i) && !refused.has(i))
        .map(c => ({ ...c, final: Math.floor((Number(c.final) || 0) * override) }));
      // ⚠️🔴 THIS WRITER NEVER ASKED FOR A REACTION (2026-09-17). His table,
      // twice: a Fireball on Aryel, APPLY pressed, no Absorb Elements box, no
      // line in the console. The save card's own APPLY was taught to ask in
      // 0.34.51 and the table said it still did not, because damage reaches a
      // creature by more than one door and this is another of them. A card the
      // renderer built has already asked (it says so), so it is not asked
      // twice; anything else is asked here, before the hit points move.
      if (!entry?.reactionsAsked) {
        _pending = await DamageApplicator._askDamageReactions(actor, _pending, {
          token: (canvas.scene?.tokens?.get?.(entry?.tokenDocId)?.object ?? null), source: _srcActor, item: _srcItem, where: "APPLY ALL",
        });
      }
      const _landed = await HpDoor.damage(actor, _pending, {
        tokenDocId: entry.tokenDocId, item: _srcItem, source: _srcActor, label: `APPLY ALL ${entry.name}`,
      });
      // What the hit points ACTUALLY moved by — after temp-HP absorption and
      // after any listener reduction. This is what UNDO must give back; the
      // nominal damage figure would over-heal. (audit fix 2026-08-07)
      const _realDelta = Number(_landed?.hpDelta) || 0;
      if (_landed?.applied !== true) {
        console.warn(`${MODULE_ID} | APPLY ALL: ${damageToApply} damage to ${entry.name} did not land: `
          + `${_landed?.total ? "a listener refused it, or this is not the GM's screen" : "nothing above 0 to apply"}.`);
      }

      // Track what APPLY ALL applied: mark all remaining comps as applied in flags.
      // A row the recipe refused stays unapplied, and says why if pressed alone.
      const allIndices = components.map((_, i) => i).filter(i => !refused.has(i));
      const prevPerType = flags?.perTypeApplied?.[entry.tokenDocId] ?? 0;
      const perCompUpdate = {};
      for (let i = 0; i < components.length; i++) {
        if (appliedComps.includes(i) || refused.has(i)) continue;
        const compDmg = Math.floor(components[i].final * override);
        perCompUpdate[`flags.${MODULE_ID}.perCompApplied.${entry.tokenDocId}.${i}`] = compDmg;
      }
      const _prevDelta = flags?.hpDelta?.[entry.tokenDocId] ?? 0;
      await message.update({
        [`flags.${MODULE_ID}.appliedComps.${entry.tokenDocId}`]: allIndices,
        [`flags.${MODULE_ID}.perTypeApplied.${entry.tokenDocId}`]: prevPerType + damageToApply,
        /* ⚠️ KEPT FOR THE CARD'S OTHER READERS ONLY. UNDO ALL no longer reads
           either of these: it adds back what each switch recorded taking, in
           `perCompApplied` just above, so a card cannot have a total that
           disagrees with its own pills (2026-10-06). */
        [`flags.${MODULE_ID}.hpDelta.${entry.tokenDocId}`]: _prevDelta + _realDelta,
        ...perCompUpdate,
      });

      DamageApplicator.overrideCache.delete(cacheKey);
      applied++;
    }

    ui.notifications.info(`ACE QOL: Damage applied to ${applied} target(s).`);

    // ── v0.7.21: Clear targeting after APPLY ALL ──
    // Fireball + other AOE save spells leave game.user.targets populated
    // with every affected token through the save card + damage card flow.
    // Once damage is applied, the spell is fully resolved — clear targets
    // so the next cast / attack starts fresh. Matches the SpellPipeline's
    // 1500ms post-card clear pattern for distribute shapes (Magic Missile).
    setTimeout(() => {
      try {
        const held = [...(game.user?.targets ?? [])];
        // ONE TARGET STAYS (his rule, 2026-09-29). Two or more clear when the
        // resolve is done, exactly as they always have.
        if (held.length === 1) {
          console.log(`${MODULE_ID} | one target (${held[0]?.name ?? "it"}) stays after APPLY ALL.`);
          return;
        }
        for (const t of held) {
          t.setTarget?.(false, { user: game.user, releaseOthers: false, groupSelection: false });
        }
        game.user?.targets?.clear?.();
      } catch (_) { /* non-fatal */ }
    }, 500);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Undo Damage
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Undo damage — restore HP to pre-damage values.
   */
  /**
   * Make the card show what the record says, and nothing else.
   *
   * His rule, 2026-10-06: "The pills and UNDO ALL read one record: which types
   * are on. After every press, the hit points, the look of each pill, and the
   * undo button all match that record. They do not keep their own copies."
   *
   * ⚠️ THE PILLS AND THE BUTTON ARE A VIEW OF THE RECORD, NOT A SECOND COPY OF
   * IT. Each press used to set its own class and the undo button was dressed in
   * one place and undressed in another, so a press that changed the record and a
   * repaint that did not run left the card telling him something untrue. This is
   * the only thing that paints either of them.
   *
   * ⚠️ IDLE IS NOT GREY (his rule: "When none are on, the button is idle: it is
   * not gray, and it does not still say it is undoing something"). A disabled,
   * faded UNDO ALL reads as broken. It stays lit and simply has nothing to do.
   */
  static syncSwitches(message, root) {
    try {
      if (!root?.querySelectorAll) return 0;
      const onFor = message.flags?.[MODULE_ID]?.appliedComps ?? {};
      let anyOn = 0;

      for (const pill of root.querySelectorAll("[data-action='aceQolApplyType']")) {
        const tid = pill.closest(".ace-qol-dmg-target-row")?.dataset?.tokenDocId;
        const idx = parseInt(pill.dataset.compIndex);
        const on = (onFor[tid] ?? []).includes(idx);
        pill.classList.toggle("ace-qol-dmg-type-applied", on);
        if (on) anyOn++;
      }

      const undoBtn = root.querySelector("[data-action='aceQolUndoDamage']");
      if (undoBtn) {
        undoBtn.disabled = false;
        undoBtn.style.opacity = "";
        undoBtn.classList.toggle("ace-qol-btn-has-undo", anyOn > 0);
        // ⚠️ THE WORDS NEVER CHANGE (his rule: "UNDO ALL stays the words UNDO ALL").
        undoBtn.innerHTML = '<i class="fas fa-undo"></i> UNDO ALL';
        undoBtn.title = anyOn
          ? `Put back ${anyOn} damage type${anyOn === 1 ? "" : "s"}`
          : "Nothing on this card is applied";
      }
      return anyOn;
    } catch (err) {
      console.warn(`${MODULE_ID} | could not make the damage card match its own record, so a `
        + `pill may be showing the wrong state:`, err);
      return 0;
    }
  }

  static async undoDamage(message) {
    // ── v0.4.22 GM-only guard ──
    if (!game.user.isGM) {
      console.warn(`${MODULE_ID} | undoDamage called by non-GM (${game.user.name}) — blocked.`);
      return;
    }

    const data = message.getFlag(MODULE_ID, "damageResults");
    if (!data?.length) return;

    /* ⚠️ NOTHING ON MEANS NOTHING TO DO, AND IT SAYS SO (his rule, 2026-10-06: "A
       pill that was turned off by pressing it leaves the button idle too."). The
       button is lit rather than greyed, so it can be pressed with every switch
       off; that is not an error and it must not heal anybody. */
    const _anyOn = Object.values(message.flags?.[MODULE_ID]?.appliedComps ?? {})
      .some(list => (list ?? []).length > 0);
    if (!_anyOn) {
      console.log(`${MODULE_ID} | UNDO ALL: no damage type on this card is applied, so there is `
        + `nothing to put back.`);
      return;
    }

    /* ── UNDO ALL PUTS BACK EVERY SWITCH THAT IS ON, EACH ONCE ───────────────
       His rule, 2026-10-06: "It adds back every type that is currently applied,
       each amount once, and returns every one of those pills to ready."

       ⚠️🔴 IT USED TO GIVE BACK A RUNNING TOTAL, NOT THE TYPES. The amount came
       from `hpDelta`, a per-creature tally kept in step by hand on every press,
       with `perTypeApplied` as a fallback for older cards. Two more numbers that
       could drift from the switches they claimed to describe, and when they did
       the only symptom was a creature's hit points quietly ending up wrong.

       It reads the switches now. `perCompApplied` records what each one actually
       took when it was pressed - the pill's own amount, or the reduced amount if
       APPLY ALL landed it at a quarter or a half - so the sum is exact, a type
       that was never applied contributes nothing, and the arithmetic is addition
       rather than a ledger. */
    const _flags    = message.flags?.[MODULE_ID] ?? {};
    const _onComps  = _flags.appliedComps ?? {};
    const _tookEach = _flags.perCompApplied ?? {};
    const _perType  = _flags.perTypeApplied ?? {};

    let undoneCount = 0;
    for (const entry of data) {
      const actor = DamageApplicator.resolveTargetActor(entry);
      if (!actor) {
        console.warn(`${MODULE_ID} | no creature could be found for token ${entry.tokenDocId}, so `
          + `nothing was put back for ${entry.name}.`);
        continue;
      }

      const on = _onComps[entry.tokenDocId] ?? [];
      const took = _tookEach[entry.tokenDocId] ?? {};
      let giveBack = 0;
      const named = [];
      for (const idx of on) {
        const amount = Number(took[idx]);
        if (!Number.isFinite(amount) || amount <= 0) continue;
        giveBack += amount;
        named.push(`${amount} ${entry.components?.[idx]?.type ?? "damage"}`);
      }

      /* ⚠️ A CARD WRITTEN BEFORE THE SWITCHES HAS NO PER-TYPE RECORD, and its
         running total is the only thing it ever kept. Used only when there is no
         switch record at all, and it says which it used, because "it gave back
         the wrong amount" and "it gave back an old card's amount" must never read
         the same in the console. */
      let source = "the switches that are on";
      if (!giveBack && !on.length) {
        giveBack = Number(_perType[entry.tokenDocId]) || 0;
        source = "the running total on a card older than the switches";
      }

      if (!(giveBack > 0)) {
        console.log(`${MODULE_ID} | UNDO ALL: nothing on this card is applied to ${entry.name}, `
          + `so its hit points are left alone.`);
        continue;
      }

      const { currentHP, newHP } = await DamageApplicator.applyHPHeal(actor, giveBack, {
        label: `UNDO ALL ${entry.name}`,
        correction: true,   // rewinding the ledger, not healing — nothing may block it
      });
      console.log(`${MODULE_ID} | UNDO ALL on ${entry.name}: ${giveBack} back`
        + `${named.length ? ` (${named.join(" + ")})` : ""}, from ${source}. `
        + `HP ${currentHP} to ${newHP}.`);
      undoneCount++;
    }


    /* ⚠️🔴 `{}` DOES NOT CLEAR A FLAG. IT MERGES INTO IT (found 2026-10-06, from
       his log: "UNDO ALL restored Vilnius from 34 to 40, then the next press took
       the 'bludgeoning switch off' path and healed 0, 40 to 40. The switch was
       still on after UNDO ALL.").

       `Document#update` runs `mergeObject(this.toObject(), data, {recursive: true,
       performDeletions: true})`, and a recursive merge of `{}` into an object
       changes nothing at all. So this block has written four empty objects over
       four full ones since the day it was written and cleared none of them: the
       hit points went back, the record still said bludgeoning was on, and the next
       press took the OFF path and tried to give six more to a creature already at
       full. Foundry's own spelling for a delete is `-=key`, which is the one thing
       this never used.

       The record is deleted now, and everything the card shows is repainted from
       it. There is one record and nothing keeps a copy. */
    await message.update({
      [`flags.${MODULE_ID}.-=appliedComps`]: null,
      [`flags.${MODULE_ID}.-=perCompApplied`]: null,
      [`flags.${MODULE_ID}.-=perTypeApplied`]: null,
      [`flags.${MODULE_ID}.-=hpDelta`]: null,
      [`flags.${MODULE_ID}.applied`]: false,
    });

    for (const card of document.querySelectorAll(
      `[data-message-id="${message.id}"] .ace-qol-damage-card, `
      + `[data-message-id="${message.id}"] .ace-qol-merge-card`)) {
      DamageApplicator.syncSwitches(message, card);
      // The other cards' own markers, which are not switches.
      card.querySelectorAll(".applied, .struck, .consumed, .ace-qol-applied").forEach(el => {
        el.classList.remove("applied", "struck", "consumed", "ace-qol-applied");
      });
      card.querySelectorAll("[style*='line-through']").forEach(el => {
        el.style.textDecoration = "";
      });
      const applyBtn = card.querySelector("[data-action='aceQolApplyDamage']");
      if (applyBtn) {
        applyBtn.disabled = false;
        applyBtn.textContent = applyBtn.textContent.replace(/applied\s*✓?/i, "").trim() || "APPLY ALL";
        applyBtn.classList.remove("applied", "ace-qol-btn-applied");
      }
      card.querySelectorAll("[data-action='aceQolApplyTarget']").forEach(btn => {
        btn.disabled = false;
        btn.classList.remove("applied", "ace-qol-btn-applied");
      });
    }

    if (undoneCount) ui.notifications.info(`ACE QOL: Damage undone for ${undoneCount} target(s). Card reset — you can re-apply.`);
  }

  /**
   * Ask the creature's reactions about damage that is about to land.
   *
   * ⚠️ ONE HELPER FOR EVERY DOOR ON THIS CARD, so the two writers here - and
   * any added later - ask the same reader the attack card and the save card
   * ask, with the same refusals in the log. Uncanny Dodge is skipped: it
   * answers an ATTACK you can see, and this path cannot tell that it was one.
   *
   * Takes and returns `[{ type, final }]`, the hit-point door's own shape.
   * Never loses damage: if anything throws, what came in goes out.
   */
  static async _askDamageReactions(actor, finals, { token = null, source = null, item = null, where = "" } = {}) {
    try {
      const reactionEng = game.aceQol?.reactionEngine ?? null;
      if (!reactionEng?.checkPreDamageReactions) {
        console.warn(`${MODULE_ID} | ${actor?.name ?? "that creature"} could not be offered a reaction `
          + `(${where}): the reaction engine is not on the API.`);
        return finals;
      }
      if (!finals?.length) return finals;
      const comps = finals.map(f => ({ type: f.type, total: Number(f.final) || 0 }));
      const res = await reactionEng.checkPreDamageReactions(comps, actor,
        token ?? actor?.getActiveTokens?.()?.[0] ?? null, source, item, null,
        { skipUncannyDodge: true, stage: "door" });
      if (!res?.absorbed) return finals;
      const back = (res.modifiedComponents ?? comps).map(c => ({ type: c.type, final: Math.max(0, Number(c.total) || 0) }));
      console.log(`${MODULE_ID} | ${actor.name} absorbed that damage (${where}): `
        + `${comps.reduce((n, c) => n + c.total, 0)} becomes ${back.reduce((n, c) => n + c.final, 0)}.`);
      // Keep whatever else the door reads off each part (magic, recipe part).
      return finals.map((f, i) => ({ ...f, final: back[i]?.final ?? f.final }));
    } catch (err) {
      console.warn(`${MODULE_ID} | the reaction check for ${actor?.name} (${where}) failed, `
        + `so the full damage lands:`, err);
      return finals;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Add Target / Cleave
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Add a new target to an existing damage card (ADD TARGET or CLEAVE).
   * Reads raw components from flags, assesses new target's defenses,
   * calculates adjusted damage, appends row to DOM, updates message flags.
   */
  static async addTargetToCard(message, el, token, isCleave = false, overkillAmount = 0, overkillComponents = null, cleaveMeta = null) {
    const flags = message.flags?.[MODULE_ID];
    if (!flags) return;

    // ── Permission guard: route non-author/non-GM clicks through GM via socket ──
    // Foundry's permission model only allows a chat message to be updated by
    // its author or by a GM. When a PLAYER clicks CLEAVE on a damage card
    // that was created on the GM client (which is the normal flow for our
    // forwarded-attack pipeline), the player can't call message.update().
    // Route the request to the GM, who performs the update on their side.
    // The flag change propagates back via Foundry's standard sync and every
    // client re-renders with the new target row + greyed-out CLEAVE button.
    const isAuthor = message.author?.id === game.user.id;
    if (!game.user.isGM && !isAuthor) {
      try {
        const tokenDocId = token.document?.id ?? token.id;
        const sceneId = token.document?.parent?.id ?? canvas.scene?.id;
        game.socket?.emit?.(`module.${MODULE_ID}`, {
          type:              "addCleaveTarget",
          fromUserId:        game.user.id,
          messageId:         message.id,
          sceneId,
          tokenDocId,
          isCleave,
          overkillAmount,
          overkillComponents,
        });
        console.log(`${MODULE_ID} | Player ${game.user.name} emitted addCleaveTarget socket request (msg=${message.id}, token=${tokenDocId})`);
      } catch (err) {
        console.warn(`${MODULE_ID} | addCleaveTarget socket emit failed:`, err);
      }
      return;  // GM will perform the actual update + propagate to all clients
    }

    const actor = token.actor;
    if (!actor) {
      ui.notifications.warn("ACE QOL: Selected token has no actor.");
      return;
    }

    // Check if this token is already in the card
    const existing = flags.damageResults?.find(r => r.tokenDocId === (token.document?.id ?? token.id));
    if (existing) {
      ui.notifications.warn(`ACE QOL: ${token.name} is already in this damage card.`);
      return;
    }

    // Retrieve the attacking item for bypass checks
    const attackItem = flags.itemUuid ? await fromUuid(flags.itemUuid) : null;

    // Assess new target's defenses
    const damageModifiers = DamageCalculator.getTargetDamageModifiers(actor, attackItem);

    let components;
    if (isCleave && overkillAmount > 0) {
      const srcComponents = overkillComponents ?? flags.rawComponents ?? [];
      const totalSrc = srcComponents.reduce((s, c) => s + (c.final ?? c.raw ?? 0), 0);
      components = srcComponents.map(c => {
        const srcVal = c.final ?? c.raw ?? 0;
        const proportion = totalSrc > 0 ? srcVal / totalSrc : 0;
        const cleaveRaw = Math.max(0, Math.round(overkillAmount * proportion));
        return { name: c.name, type: c.type, raw: cleaveRaw, total: cleaveRaw, recipePart: c.recipePart ?? null };
      });
      let sum = components.reduce((s, c) => s + c.raw, 0);
      if (sum !== overkillAmount && components.length) {
        components[0].raw += (overkillAmount - sum);
        components[0].total = components[0].raw;
      }
    } else {
      const rawComponents = flags.rawComponents ?? [];
      components = rawComponents.map(c => ({ name: c.name, type: c.type, raw: c.raw, total: c.raw, recipePart: c.recipePart ?? null }));
    }

    // Apply new target's defenses
    const applied = DamageCalculator.applyDamageModifiers(components, damageModifiers);
    const totalFinal = applied.reduce((s, c) => s + c.final, 0);

    const currentHP = actor.system?.attributes?.hp?.value ?? 0;
    const maxHP = actor.system?.attributes?.hp?.max ?? 0;
    const tokenDocId = token.document?.id ?? token.id;
    const img = faceOf(actor);

    // Build row HTML and insert into the targets container
    const rowHtml = DamageCardRenderer.buildTargetRowHtml({
      tokenDocId,
      actorId: actor.id,
      sceneId: canvas.scene?.id,
      name: token.name,
      img,
      currentHP,
      maxHP,
      totalFinal,
      isCrit: false,
      components: applied,
    });

    const targetsDiv = el.querySelector(".ace-qol-dmg-targets");
    if (targetsDiv) {
      targetsDiv.insertAdjacentHTML("beforeend", rowHtml);
      // Wire the new row's buttons — caller must pass the wireOverrideButtons function
    }

    // Update message flags with the new target
    const existingResults = [...(flags.damageResults ?? [])];
    existingResults.push({
      targetId: actor.id,
      tokenId: token.id,
      tokenDocId,
      sceneId: canvas.scene?.id,
      isLinked: token.document?.actorLink ?? false,
      totalFinal,
      currentHP,
      maxHP,
      name: token.name,
      img,
      components: applied.map(c => ({ name: c.name, type: c.type, raw: c.raw, final: c.final, modifier: c.modifier,
        recipePart: c.recipePart ?? null })),
      // The same attack's result, which APPLY asks the recipe about: a cleave is a
      // hit on its second creature; an added target takes the card's own result.
      result: isCleave ? "hit" : (flags.damageResults?.[0]?.result ?? "hit"),
      isCleave: isCleave,
    });

    // Persist the new target on the message. If this was a cleave (mastery
    // or overkill), also set the `cleaveFired` flag so the CLEAVE button
    // greys out for every client on subsequent renders. When mastery cleave
    // passes cleaveMeta, ALSO stamp the cleaved target's name + whether the
    // pick was automatic — render handler uses these to show a clarifying
    // "Cleaved to <name>" caption to both GM and player.
    const updatePayload = { [`flags.${MODULE_ID}.damageResults`]: existingResults };
    if (isCleave) {
      updatePayload[`flags.${MODULE_ID}.cleaveFired`] = true;
      if (cleaveMeta) {
        updatePayload[`flags.${MODULE_ID}.cleaveTargetName`] = cleaveMeta.targetName ?? token.name;
        updatePayload[`flags.${MODULE_ID}.cleaveAutoPicked`] = !!cleaveMeta.autoPicked;
      }
    }
    await message.update(updatePayload);
    console.log(`${MODULE_ID} | ${isCleave ? "CLEAVE" : "ADD"}: ${token.name} added to damage card (${totalFinal} damage)`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Override Buttons + Per-Type Toggle Wiring
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Wire per-row override and remove buttons on a damage card.
   * Safe to call multiple times — skips already-wired buttons.
   */
  static wireOverrideButtons(el, message) {
    // Override multiplier buttons (¼, ½, 1, 2×)
    const overrideBtns = el.querySelectorAll?.("[data-action='aceQolDmgOverride']");
    for (const btn of (overrideBtns ?? [])) {
      if (btn.dataset.wired) continue;
      btn.dataset.wired = "1";

      // ── Restore visual state from in-memory cache ──
      const tokenDocId = btn.dataset.tokenDocId;
      const multiplier = parseFloat(btn.dataset.multiplier);
      const cacheKey = `${message.id}|${tokenDocId}`;
      const cached = DamageApplicator.overrideCache.get(cacheKey);
      if (typeof cached === "number" && cached === multiplier) {
        const ovrLine = btn.closest(".ace-qol-dmg-ovr-line");
        if (ovrLine) {
          ovrLine.querySelectorAll(".ace-qol-dmg-ovr").forEach(b => b.classList.remove("ace-qol-dmg-ovr-active"));
          btn.classList.add("ace-qol-dmg-ovr-active");
        }
        const row = btn.closest(".ace-qol-dmg-target-row");
        if (row) DamageApplicator.updateDmgRowDisplay(row, tokenDocId, cached, message.flags?.[MODULE_ID]);
      }

      btn.addEventListener("click", () => {
        const tokenDocId = btn.dataset.tokenDocId;
        const multiplier = parseFloat(btn.dataset.multiplier);
        if (!tokenDocId || isNaN(multiplier)) return;

        const ovrLine = btn.closest(".ace-qol-dmg-ovr-line");
        if (ovrLine) {
          ovrLine.querySelectorAll(".ace-qol-dmg-ovr").forEach(b => b.classList.remove("ace-qol-dmg-ovr-active"));
          btn.classList.add("ace-qol-dmg-ovr-active");
        }

        const cacheKey = `${message.id}|${tokenDocId}`;
        DamageApplicator.overrideCache.set(cacheKey, multiplier);

        const row = btn.closest(".ace-qol-dmg-target-row");
        if (row) DamageApplicator.updateDmgRowDisplay(row, tokenDocId, multiplier, message.flags?.[MODULE_ID]);
      });
    }

    // Remove buttons (×)
    const removeBtns = el.querySelectorAll?.("[data-action='aceQolDmgRemove']");
    for (const btn of (removeBtns ?? [])) {
      if (btn.dataset.wired) continue;
      btn.dataset.wired = "1";
      btn.addEventListener("click", () => {
        const tokenDocId = btn.dataset.tokenDocId;
        const row = btn.closest(".ace-qol-dmg-target-row");
        if (row) {
          row.style.display = "none";
          row.dataset.removed = "1";
        }
        const cacheKey = `${message.id}|${tokenDocId}`;
        DamageApplicator.overrideCache.set(cacheKey, "removed");
      });
    }

    // Portrait/name click → select + pan to token
    const rows = el.querySelectorAll?.(".ace-qol-dmg-target-row");
    for (const row of (rows ?? [])) {
      const img = row.querySelector(".ace-qol-dmg-tgt-img");
      const nameEl = row.querySelector(".ace-qol-dmg-tgt-name");
      const tokenDocId = row.dataset.tokenDocId;
      if (!tokenDocId || row.dataset.clickWired) continue;
      row.dataset.clickWired = "1";
      const clickHandler = () => {
        const scene = canvas.scene;
        if (!scene) return;
        const tokenDoc = scene.tokens.get(tokenDocId);
        const token = tokenDoc?.object;
        if (!token) return;
        token.control({ releaseOthers: true });
        canvas.animatePan({ x: token.center.x, y: token.center.y, duration: 250 });
      };
      if (img) img.addEventListener("click", clickHandler);
      if (nameEl) nameEl.addEventListener("click", clickHandler);
    }

    // ── Update HP + damage display from flags on every re-render ──
    const mFlags = message.flags?.[MODULE_ID] ?? {};
    const perTypeApplied = mFlags.perTypeApplied ?? {};
    const appliedCompsMap = mFlags.appliedComps ?? {};
    const damageResults = mFlags.damageResults ?? [];
    for (const row of (el.querySelectorAll?.(".ace-qol-dmg-target-row") ?? [])) {
      const tokenDocId = row.dataset?.tokenDocId;
      if (!tokenDocId) continue;
      const appliedAmount = perTypeApplied[tokenDocId] ?? 0;
      const entry = damageResults.find(r => r.tokenDocId === tokenDocId);
      if (!entry) continue;

      const origHP = entry.currentHP;
      const maxHP = entry.maxHP ?? origHP;
      const appliedIndices = appliedCompsMap[tokenDocId] ?? [];

      const remainingDamage = (entry.components ?? []).reduce((sum, c, i) => {
        if (appliedIndices.includes(i)) return sum;
        return sum + (c.final ?? 0);
      }, 0);

      const currentLiveHP = Math.max(0, origHP - appliedAmount);
      const projectedHP = Math.max(0, currentLiveHP - remainingDamage);
      const isDead = projectedHP <= 0;

      // ⚠️ THE RED "n DMG" LINE IS GONE (his rule, 2026-09-30), so there is no
      // number here to rewrite. What it said is said twice over already: the
      // pill names what landed and the HP line says what it did. Kept as a
      // conditional rather than deleted blind, so a card rendered by an older
      // version still updates.
      const dmgSpan = row.querySelector(".ace-qol-dmg-row-dmg");
      if (dmgSpan && appliedAmount > 0) dmgSpan.textContent = remainingDamage;

      const hpLine = row.querySelector(".ace-qol-dmg-row-hp");
      if (hpLine && appliedAmount > 0) {
        hpLine.innerHTML = `HP: <span class="ace-qol-hp-cur">${currentLiveHP}</span> → <span class="ace-qol-hp-new${isDead ? ' ace-qol-hp-dead' : ''}">${projectedHP}</span><span class="ace-qol-hp-max">/${maxHP}</span>`;
      }
    }

    /* ── EACH TYPE LINE IS ITS OWN SWITCH ────────────────────────────────────
       His rule, 2026-10-06: "Throw out the apply and undo math. Each
       ace-qol-dmg-type-line is its own switch. Its amount is its
       data-damage-amount. Its type is its data-damage-type... A type starts
       ready. Pressing its pill subtracts its amount from the token, once.
       Pressing that pill again does not subtract it again. Undoing that type adds
       exactly that amount back, once, and the pill returns to the ready state it
       had before it was pressed. Undoing force does not touch bludgeoning."

       ⚠️🔴 WHAT WAS THROWN OUT, AND WHY. This path kept FOUR ledgers in step by
       hand on every press: `appliedComps` (which), `perCompApplied` (how much
       each), `perTypeApplied` (the running total), and `hpDelta` (what the hit
       points really moved by), plus an override multiplier read out of a cache
       and deleted after use, plus an `applied` flag recomputed from whether every
       pill happened to be on. Eight numbers describing two states. Any one of
       them drifting - a clamp at full hit points, an override that outlived its
       press, a reaction that halved the landing - put the card and the creature
       out of step, and the only way back was UNDO ALL.

       There is ONE ledger now: which components are on, per token. The amount is
       the number on the pill, which is the number the table read; subtract it to
       turn the switch on, add the same number back to turn it off. Nothing is
       recomputed, so nothing can disagree. */
    /* ⚠️ THE CARD IS PAINTED FROM THE RECORD ON EVERY RENDER, including the
       first. A reload, a flag change on another client and a fresh draw all come
       through here, and all three must show the same thing the record says. */
    DamageApplicator.syncSwitches(message, el);

    const typeLines = el.querySelectorAll?.("[data-action='aceQolApplyType']");
    for (const line of (typeLines ?? [])) {
      if (line.dataset.wired) continue;
      line.dataset.wired = "1";


      line.addEventListener("click", async () => {
        // ⚠️ GM ONLY AT THE DOOR, not only in the CSS that hides the pill. A
        // crafted click, devtools or another module can reach this handler, and a
        // player owns their own actor so the write would go through. (Grok, v0.7.8)
        if (!game.user.isGM) {
          console.warn(`${MODULE_ID} | a damage switch was clicked by ${game.user.name}, `
            + `who is not the GM. Nothing was changed.`);
          return;
        }

        const amount = parseInt(line.dataset.damageAmount);
        const dmgType = String(line.dataset.damageType ?? "damage");
        const idx = parseInt(line.dataset.compIndex);
        const row = line.closest(".ace-qol-dmg-target-row");
        const tokenDocId = row?.dataset?.tokenDocId;
        // ⚠️ SAID, NOT SWALLOWED. A switch that does nothing and explains nothing
        // is the failure this suite has paid for more than once.
        if (!tokenDocId) {
          console.warn(`${MODULE_ID} | a ${dmgType} switch has no creature on its row, so it `
            + `cannot change anybody's hit points.`);
          return;
        }
        if (!Number.isFinite(amount) || amount <= 0) {
          console.warn(`${MODULE_ID} | the ${dmgType} switch carries no amount `
            + `("${line.dataset.damageAmount}"), so there is nothing to take off or put back.`);
          return;
        }
        const entry = (message.flags?.[MODULE_ID]?.damageResults ?? [])
          .find(r => r.tokenDocId === tokenDocId);
        const actor = entry ? DamageApplicator.resolveTargetActor(entry) : null;
        if (!actor) {
          console.warn(`${MODULE_ID} | no creature could be found for this row, so the ${dmgType} `
            + `switch did nothing.`);
          ui.notifications.warn("ACE QOL: could not find that creature, so nothing was changed.");
          return;
        }

        // ⚠️ ONE PRESS AT A TIME, PER SWITCH. Two clicks a few milliseconds apart
        // both read the same flags and both wrote, which is how a type came off
        // twice. The guard is on the element, so force and bludgeoning are still
        // independent of each other.
        if (line.dataset.busy) return;
        line.dataset.busy = "1";
        try {
          const applied = message.flags?.[MODULE_ID]?.appliedComps?.[tokenDocId] ?? [];
          const isOn = applied.includes(idx);
          const hpOf = () => Number(actor?.system?.attributes?.hp?.value ?? 0);
          const before = hpOf();

          if (isOn) {
            /* ── OFF: put back exactly what the pill says, once ────────────────
               "Undoing a type that was never applied does nothing" is the `isOn`
               test above, and "undoing force does not touch bludgeoning" is this
               writing only its own index. */
            await DamageApplicator.applyHPHeal(actor, amount, {
              label: `${dmgType} switch off`,
              correction: true,   // rewinding the ledger, not healing: nothing may block it
            });
            await message.update({
              [`flags.${MODULE_ID}.appliedComps.${tokenDocId}`]: applied.filter(i => i !== idx),
              [`flags.${MODULE_ID}.perCompApplied.${tokenDocId}.${idx}`]: null,
              [`flags.${MODULE_ID}.applied`]: false,
            });
            DamageApplicator.syncSwitches(message, line.closest(".ace-qol-damage-card") ?? el);
            console.log(`${MODULE_ID} | ${entry.name}: ${amount} ${dmgType} put back. `
              + `HP ${before} to ${hpOf()}.`);
            ui.notifications.info(`${entry.name}: ${amount} ${dmgType} put back.`);
            return;
          }

          /* ── ON: take the pill's own amount off, once ──────────────────────
             ⚠️ THE RECIPE STILL HAS ITS SAY (The One Road, phase 3). A component
             the attack's recipe does not land on this target's result is not
             applied by hand either. */
          const refusal = DamageApplicator._recipeGate(message.flags?.[MODULE_ID], entry)
            .refusal(entry.components?.[idx]);
          if (refusal) {
            console.warn(`${MODULE_ID} | ${entry.name} does not take this ${dmgType}: ${refusal}.`);
            ui.notifications.warn(`ACE QOL: ${entry.name} does not take this ${dmgType}: ${refusal}.`);
            return;
          }

          // ⚠️ THROUGH THE HIT-POINT DOOR, like APPLY ALL. The door owns the
          // write, carries what dealt it (a +1 sword's slashing is magical), and
          // sends the one damage-applied signal that regeneration listens for.
          const srcFlags = message.flags?.[MODULE_ID] ?? {};
          let srcItem = null;
          try { if (srcFlags.itemUuid) srcItem = fromUuidSync?.(srcFlags.itemUuid) ?? null; }
          catch (_) { srcItem = null; }
          await HpDoor.damage(actor, [{ type: dmgType.toLowerCase(), final: amount }], {
            tokenDocId, item: srcItem,
            source: srcFlags.actorId ? (game.actors?.get?.(srcFlags.actorId) ?? null) : null,
            label: `${dmgType} switch on`,
          });

          /* ⚠️ ONE RECORD OF WHAT WAS TAKEN, and here it IS `data-damage-amount`.
             UNDO ALL reads this so it gives back each type exactly once and
             exactly what came off, including a component APPLY ALL landed at a
             quarter or a half. It is the only number kept beside the ledger. */
          await message.update({
            [`flags.${MODULE_ID}.appliedComps.${tokenDocId}`]: [...applied, idx],
            [`flags.${MODULE_ID}.perCompApplied.${tokenDocId}.${idx}`]: amount,
          });
          DamageApplicator.syncSwitches(message, line.closest(".ace-qol-damage-card") ?? el);
          console.log(`${MODULE_ID} | ${entry.name}: ${amount} ${dmgType} taken off. `
            + `HP ${before} to ${hpOf()}.`);
          ui.notifications.info(`${entry.name}: ${amount} ${dmgType}.`);
        } catch (err) {
          console.error(`${MODULE_ID} | the ${dmgType} switch threw, so the card and the creature `
            + `may now disagree. Check ${entry?.name}'s hit points:`, err);
        } finally {
          delete line.dataset.busy;
        }
      });
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Override Display Update
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Update a target row's damage and HP display after an override click.
   */
  static updateDmgRowDisplay(row, tokenDocId, multiplier, flags) {
    const result = flags?.damageResults?.find(r => r.tokenDocId === tokenDocId);
    if (!result) return;

    const baseDmg = result.totalFinal;
    const newDamage = Math.floor(baseDmg * multiplier);
    const currentHP = result.currentHP;
    const newHP = Math.max(0, currentHP - newDamage);
    const isDead = newHP <= 0;

    // No red "n DMG" line to rewrite any more; an older card still has one.
    const dmgSpan = row.querySelector(".ace-qol-dmg-row-dmg");
    if (dmgSpan) dmgSpan.textContent = newDamage;

    const hpSpan = row.querySelector(".ace-qol-dmg-row-hp");
    if (hpSpan) {
      // ⚠️ AND IT KEEPS THE MAXIMUM. He asked for "HP 10 → 5/82" kept, and this
      // line dropped the /82 the moment a multiplier was pressed — the one place
      // the HP line is rebuilt. Same shape as the first render, spaces included.
      const _max = result.maxHP ?? currentHP;
      hpSpan.innerHTML = `HP: <span class="ace-qol-hp-cur">${currentHP}</span> → `
        + `<span class="ace-qol-hp-new${isDead ? ' ace-qol-hp-dead' : ''}">${newHP}</span>`
        + `<span class="ace-qol-hp-max">/${_max}</span>`;
    }

    const skull = row.querySelector(".ace-qol-dmg-skull");
    if (skull) skull.style.display = isDead ? "" : "none";
  }
}
