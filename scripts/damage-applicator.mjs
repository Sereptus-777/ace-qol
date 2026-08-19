// ─── ACE: QOL — Damage Applicator ────────────────────────────────────────────
// HP mutation: apply damage, undo damage, per-type toggle, override multipliers,
// add target / cleave. Owns the override cache and actor resolution.
// ──────────────────────────────────────────────────────────────────────────────

import { MODULE_ID } from "./ace-qol.mjs";
import { DamageCalculator } from "./damage-calculator.mjs";
import { DamageCardRenderer } from "./damage-card-renderer.mjs";
import { DamageConstants } from "./damage-engine.mjs";
import { TransformationEngine } from "./transformation-engine.mjs";

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
   * Detects concentrating status, computes DC = max(10, floor(damage/2)),
   * routes through save-engine for the visual card, and on fail deletes the
   * Concentrating effect (cascading dependent cleanup via dnd5e).
   *
   * Skips silently if actor isn't concentrating.
   */
  static async _triggerAceConcentrationCheck(actor, damage) {
    if (!actor?.effects) return;
    const concEffect = actor.effects.find?.(e =>
      e.statuses?.has?.("concentration") || e.statuses?.has?.("concentrating"));
    if (!concEffect) return;

    const dc = Math.max(10, Math.floor(damage / 2));
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
    const accent = "#ab47bc";

    if (isPc) {
      // PC path — post a card with a roll button. The GM clicks it (or the
      // PC owner does) to roll. On fail, the effect deletes.
      const html = `
        <div style="background:linear-gradient(180deg,#1a1410 0%,#0f0a08 100%);
                    border:2px solid ${accent};
                    border-radius:6px;
                    padding:12px 14px;
                    color:#f0e4c0;
                    font-family:'Signika','Helvetica Neue',sans-serif;">
          <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;row-gap:4px;
                      font-size:14px;font-weight:700;color:${accent};
                      text-transform:uppercase;letter-spacing:0.6px;
                      border-bottom:1px solid #4a3a28;
                      padding-bottom:6px;margin-bottom:8px;">
            <i class="fas fa-brain" style="font-size:16px;color:${accent};flex-shrink:0;"></i>
            <span style="flex:1 1 auto;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">CONCENTRATION CHECK — ${actor.name.toUpperCase()}</span>
            <span style="font-size:13px;color:#e8d49a;flex-shrink:0;">DC ${dc}</span>
          </div>
          <div style="font-size:13px;color:#c0b288;margin-bottom:8px;">
            <strong>${actor.name}</strong> took <strong>${damage}</strong> damage while concentrating on <em>${concName}</em>.
          </div>
          <button class="ace-qol-conc-roll-btn"
                  data-action="aceQolRollConcSave"
                  data-actor-uuid="${actor.uuid}"
                  data-effect-id="${concEffect.id}"
                  data-dc="${dc}"
                  data-formula="${formula}"
                  style="width:100%;padding:8px;font-size:14px;font-weight:700;
                         background:${accent};color:#fff;border:none;border-radius:4px;
                         cursor:pointer;letter-spacing:0.5px;">
            ROLL CONCENTRATION SAVE (CON ${conMod >= 0 ? "+" : ""}${conMod}${isProficient ? " + prof" : ""})
          </button>
        </div>
      `;
      try {
        await ChatMessage.create({
          speaker: ChatMessage.getSpeaker({ actor }),
          content: html,
          flavor: `${actor.name} concentration check vs DC ${dc}`,
        });
      } catch (_) { /* non-fatal */ }
    } else {
      // NPC path — auto-roll, show result, on fail delete the effect.
      const roll = await new Roll(formula).evaluate();
      const total = roll.total;
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
        await ChatMessage.create({
          speaker: ChatMessage.getSpeaker({ actor }),
          content: html,
          rolls: [roll],
        });
      } catch (_) { /* non-fatal */ }

      if (!passed) {
        // Delete the Concentrating effect — dnd5e auto-cleans dependents
        try {
          await concEffect.delete();
          console.log(`${MODULE_ID} | Concentration BROKEN: ${actor.name} failed concentration save (${total} vs DC ${dc}) — effect deleted`);
        } catch (err) {
          console.warn(`${MODULE_ID} | Failed to delete concentration effect:`, err);
        }
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

      for (let i = 0; i < components.length; i++) {
        if (appliedComps.includes(i)) {
          console.log(`${MODULE_ID} | APPLY ALL: skipping comp ${i} (${components[i].type}) — already applied individually`);
          continue;
        }
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
      // applied ones are excluded above), described by type so Heavy Armor
      // Master and anything else type-aware can act on them.
      const _pending = components.filter((_, i) => !appliedComps.includes(i));
      const _hpBefore = Number(actor?.system?.attributes?.hp?.value ?? 0);
      await DamageApplicator.applyHPDamage(actor, damageToApply, {
        label: `APPLY ALL ${entry.name}`,
        types: [...typesApplied],
        damages: DamageApplicator.describeDamages(_pending, override, _srcItem),
      });
      // What the hit points ACTUALLY moved by — after temp-HP absorption and
      // after any listener reduction. This is what UNDO must give back; the
      // nominal damage figure would over-heal. (audit fix 2026-08-07)
      const _hpAfter = Number(actor?.system?.attributes?.hp?.value ?? 0);
      const _realDelta = Math.max(0, _hpBefore - _hpAfter);

      // Signal the damage types this creature just took, so the OverTime engine
      // can honor RAW regeneration shut-offs (a troll that took fire/acid, or a
      // vampire that took radiant, doesn't regenerate at the start of its next turn).
      try {
        Hooks.callAll(`${MODULE_ID}.damageApplied`, {
          actor, tokenDocId: entry.tokenDocId, types: [...typesApplied],
        });
      } catch (_) { /* non-fatal */ }

      // Track what APPLY ALL applied: mark all remaining comps as applied in flags
      const allIndices = components.map((_, i) => i);
      const prevPerType = flags?.perTypeApplied?.[entry.tokenDocId] ?? 0;
      const perCompUpdate = {};
      for (let i = 0; i < components.length; i++) {
        if (appliedComps.includes(i)) continue;
        const compDmg = Math.floor(components[i].final * override);
        perCompUpdate[`flags.${MODULE_ID}.perCompApplied.${entry.tokenDocId}.${i}`] = compDmg;
      }
      const _prevDelta = flags?.hpDelta?.[entry.tokenDocId] ?? 0;
      await message.update({
        [`flags.${MODULE_ID}.appliedComps.${entry.tokenDocId}`]: allIndices,
        [`flags.${MODULE_ID}.perTypeApplied.${entry.tokenDocId}`]: prevPerType + damageToApply,
        // The true hit-point movement, which is what UNDO gives back.
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
        for (const t of [...(game.user?.targets ?? [])]) {
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
  static async undoDamage(message) {
    // ── v0.4.22 GM-only guard ──
    if (!game.user.isGM) {
      console.warn(`${MODULE_ID} | undoDamage called by non-GM (${game.user.name}) — blocked.`);
      return;
    }

    const data = message.getFlag(MODULE_ID, "damageResults");
    if (!data?.length) return;

    // ── 🔴 UNDO GIVES BACK WHAT IT TOOK (audit fix, 2026-08-07) ────────────
    // This used to set hit points back to `entry.currentHP` — the snapshot taken
    // when the CARD WAS CREATED. An absolute restore, not a relative one, so
    // anything that touched the creature in between was silently erased:
    //
    //   goblin at 30 → apply 10 (now 20) → steps in a trap for 5 (now 15)
    //   → click UNDO on the old card → goblin goes back to 30. Trap damage gone.
    //
    // Same for two damage cards in flight, and for a card where only ONE damage
    // type was applied (undo handed back the full pre-card total regardless).
    //
    // `hpDelta` records the TRUE hit-point movement at apply time — after temp
    // HP absorbed its share and after any listener reduction — so healing it
    // back is exact. The per-type undo directly below already worked this way;
    // this brings UNDO ALL into line with it.
    const _flags     = message.flags?.[MODULE_ID] ?? {};
    const _hpDeltas  = _flags.hpDelta ?? {};
    const _perType   = _flags.perTypeApplied ?? {};

    let undoneCount = 0;
    for (const entry of data) {
      const actor = DamageApplicator.resolveTargetActor(entry);
      if (!actor) {
        console.warn(`${MODULE_ID} | Could not find actor for undo on token ${entry.tokenDocId}`);
        continue;
      }

      // Preference order: the true movement → the nominal applied total (cards
      // created before this fix) → nothing at all. A card that was never applied
      // has nothing to undo, and must NOT be treated as "restore to snapshot".
      let giveBack = Number(_hpDeltas[entry.tokenDocId]);
      let source   = "true hit-point movement";
      if (!Number.isFinite(giveBack)) {
        giveBack = Number(_perType[entry.tokenDocId]);
        source   = "applied total (card predates the hpDelta fix)";
      }
      if (!Number.isFinite(giveBack) || giveBack <= 0) {
        console.log(`${MODULE_ID} | UNDO: nothing was applied to ${entry.name} on this card — leaving its hit points alone.`);
        continue;
      }

      const { currentHP, newHP } = await DamageApplicator.applyHPHeal(actor, giveBack, {
        label: `UNDO ${entry.name}`,
        correction: true,   // rewinding the ledger, not healing — nothing may block it
      });
      console.log(`${MODULE_ID} | UNDO on ${actor.name}: gave back ${giveBack} (${source}) — ${currentHP} → ${newHP}`);
      undoneCount++;
    }

    // Clear ALL tracking flags so the card returns to completely fresh state
    await message.update({
      [`flags.${MODULE_ID}.perTypeApplied`]: {},
      [`flags.${MODULE_ID}.appliedComps`]: {},
      [`flags.${MODULE_ID}.perCompApplied`]: {},
      [`flags.${MODULE_ID}.hpDelta`]: {},
      [`flags.${MODULE_ID}.applied`]: false,
    });

    // Direct DOM reset — flag updates alone don't trigger the strikethroughs
    // and "applied" badges to clear, because the message content was set at
    // create-time and re-rendering doesn't regenerate it from flag state.
    // Match every card instance for this message (sidebar + popouts) and
    // strip the visual "applied" markers.
    const cards = document.querySelectorAll(`[data-message-id="${message.id}"] .ace-qol-damage-card, [data-message-id="${message.id}"] .ace-qol-merge-card`);
    cards.forEach(card => {
      // Remove .applied / .struck / .consumed classes from anything that
      // might be carrying a strikethrough or grayout style
      card.querySelectorAll(".applied, .struck, .consumed, .ace-qol-applied").forEach(el => {
        el.classList.remove("applied", "struck", "consumed", "ace-qol-applied");
      });
      // Also strip inline text-decoration: line-through
      card.querySelectorAll("[style*='line-through']").forEach(el => {
        el.style.textDecoration = "";
      });
      // Re-enable the APPLY ALL button if it was disabled
      const applyBtn = card.querySelector("[data-action='aceQolApplyDamage']");
      if (applyBtn) {
        applyBtn.disabled = false;
        applyBtn.textContent = applyBtn.textContent.replace(/applied\s*✓?/i, "").trim() || "APPLY ALL";
        applyBtn.classList.remove("applied", "ace-qol-btn-applied");
      }
      // Re-enable per-target apply buttons
      card.querySelectorAll("[data-action='aceQolApplyTarget']").forEach(btn => {
        btn.disabled = false;
        btn.classList.remove("applied", "ace-qol-btn-applied");
      });
    });

    if (undoneCount) ui.notifications.info(`ACE QOL: Damage undone for ${undoneCount} target(s). Card reset — you can re-apply.`);
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
        return { name: c.name, type: c.type, raw: cleaveRaw, total: cleaveRaw };
      });
      let sum = components.reduce((s, c) => s + c.raw, 0);
      if (sum !== overkillAmount && components.length) {
        components[0].raw += (overkillAmount - sum);
        components[0].total = components[0].raw;
      }
    } else {
      const rawComponents = flags.rawComponents ?? [];
      components = rawComponents.map(c => ({ name: c.name, type: c.type, raw: c.raw, total: c.raw }));
    }

    // Apply new target's defenses
    const applied = DamageCalculator.applyDamageModifiers(components, damageModifiers);
    const totalFinal = applied.reduce((s, c) => s + c.final, 0);

    const currentHP = actor.system?.attributes?.hp?.value ?? 0;
    const maxHP = actor.system?.attributes?.hp?.max ?? 0;
    const tokenDocId = token.document?.id ?? token.id;
    const img = token.document?.texture?.src || actor.img || "icons/svg/mystery-man.svg";

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
      components: applied.map(c => ({ name: c.name, type: c.type, raw: c.raw, final: c.final, modifier: c.modifier })),
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

      const dmgSpan = row.querySelector(".ace-qol-dmg-row-dmg");
      if (dmgSpan && appliedAmount > 0) {
        dmgSpan.textContent = remainingDamage;
      }

      const hpLine = row.querySelector(".ace-qol-dmg-row-hp");
      if (hpLine && appliedAmount > 0) {
        hpLine.innerHTML = `HP: <span class="ace-qol-hp-cur">${currentLiveHP}</span> → <span class="ace-qol-hp-new${isDead ? ' ace-qol-hp-dead' : ''}">${projectedHP}</span><span class="ace-qol-hp-max">/${maxHP}</span>`;
      }
    }

    // ── Per-type damage TOGGLE (click to apply, click again to undo) ──
    const typeLines = el.querySelectorAll?.("[data-action='aceQolApplyType']");
    for (const line of (typeLines ?? [])) {
      if (line.dataset.wired) continue;
      line.dataset.wired = "1";

      // Restore visual state from flags
      const row = line.closest(".ace-qol-dmg-target-row");
      const tokenDocId = row?.dataset?.tokenDocId;
      const compIndex = parseInt(line.dataset.compIndex);
      const appliedComps = message.flags?.[MODULE_ID]?.appliedComps?.[tokenDocId] ?? [];
      if (appliedComps.includes(compIndex)) {
        line.classList.add("ace-qol-dmg-type-applied");
      }

      line.addEventListener("click", async () => {
        // GM-only at function entry — defense-in-depth (v0.7.8).
        // Buttons are hidden for non-GM via CSS in damage-engine.mjs, but
        // a crafted DOM click, devtools, or module interference can still
        // reach this handler. The actor.update + message.update calls
        // below would partially go through (player owns their own actor =
        // permission allowed) and the front-half flag manipulation runs
        // unguarded regardless. Grok audit catch.
        if (!game.user.isGM) {
          console.warn(`${MODULE_ID} | per-type damage toggle clicked by non-GM (${game.user.name}) — blocked.`);
          return;
        }

        const baseAmount = parseInt(line.dataset.damageAmount);
        const dmgType = line.dataset.damageType;
        const idx = parseInt(line.dataset.compIndex);
        if (isNaN(baseAmount) || baseAmount <= 0) return;

        const row = line.closest(".ace-qol-dmg-target-row");
        const tokenDocId = row?.dataset?.tokenDocId;
        if (!tokenDocId) return;

        const currentApplied = message.flags?.[MODULE_ID]?.appliedComps?.[tokenDocId] ?? [];
        const entry = message.flags?.[MODULE_ID]?.damageResults?.find(r => r.tokenDocId === tokenDocId);
        if (!entry) return;
        const actor = DamageApplicator.resolveTargetActor(entry);
        if (!actor) {
          ui.notifications.warn(`ACE QOL: Could not find actor for token.`);
          return;
        }

        // ════════════════════════════════════════════════════════════════
        //  TOGGLE OFF — undo this type's damage
        // ════════════════════════════════════════════════════════════════
        if (currentApplied.includes(idx)) {
          const appliedAmount = message.flags?.[MODULE_ID]?.perCompApplied?.[tokenDocId]?.[idx] ?? 0;
          if (appliedAmount <= 0) {
            console.warn(`${MODULE_ID} | Toggle-off: no recorded amount for comp ${idx} (${dmgType})`);
            return;
          }

          // Route through the canonical helper (clamps to max HP, owns
          // the actor.update). Refactored from inline math for the same
          // reason APPLY ALL was refactored in v0.7.3: single source of
          // truth for HP mutation. Grok audit follow-on.
          const { currentHP, newHP: restoredHP } = await DamageApplicator.applyHPHeal(actor, appliedAmount, {
            label: `per-type UNDO ${dmgType}`,
            correction: true,   // rewinding the ledger, not healing — nothing may block it
          });

          const newApplied = currentApplied.filter(i => i !== idx);
          const prevTotal = message.flags?.[MODULE_ID]?.perTypeApplied?.[tokenDocId] ?? 0;
          const _prevDelta3 = message.flags?.[MODULE_ID]?.hpDelta?.[tokenDocId] ?? 0;
          // What the heal ACTUALLY put back (it clamps at max hit points).
          const _restored   = Math.max(0, Number(restoredHP) - Number(currentHP));
          const flagUpdate = {
            [`flags.${MODULE_ID}.appliedComps.${tokenDocId}`]: newApplied,
            [`flags.${MODULE_ID}.perTypeApplied.${tokenDocId}`]: Math.max(0, prevTotal - appliedAmount),
            [`flags.${MODULE_ID}.perCompApplied.${tokenDocId}.${idx}`]: null,
            // Take the same amount back off the true-movement tally, so a later
            // UNDO ALL doesn't hand this component's hit points back twice.
            [`flags.${MODULE_ID}.hpDelta.${tokenDocId}`]: Math.max(0, _prevDelta3 - _restored),
          };
          if (message.flags?.[MODULE_ID]?.applied) {
            flagUpdate[`flags.${MODULE_ID}.applied`] = false;
          }
          await message.update(flagUpdate);

          console.log(`${MODULE_ID} | Per-type UNDO: comp ${idx} (${appliedAmount} ${dmgType}) from ${entry.name}: HP ${currentHP} → ${restoredHP}`);
          line.classList.remove("ace-qol-dmg-type-applied");
          ui.notifications.info(`ACE QOL: Undid ${appliedAmount} ${dmgType} damage from ${entry.name} (${currentHP} → ${restoredHP})`);
          return;
        }

        // ════════════════════════════════════════════════════════════════
        //  TOGGLE ON — apply this type's damage
        // ════════════════════════════════════════════════════════════════
        const cacheKey = `${message.id}|${tokenDocId}`;
        const override = DamageApplicator.overrideCache.get(cacheKey);
        const amount = (typeof override === "number")
          ? Math.floor(baseAmount * override)
          : baseAmount;

        // Route through the canonical helper — owns the HP math, the
        // polymorph excess-damage capture, and the actor.update. Replaces
        // inline duplication (same fix pattern as APPLY ALL in v0.7.3).
        // Grok audit follow-on.
        // ONE typed entry — Heavy Armor Master needs to know this is (say)
        // 7 slashing from a non-magical weapon, not just "7 damage".
        const _comp = entry.components?.[idx] ?? null;
        const _hpBefore = Number(actor?.system?.attributes?.hp?.value ?? 0);
        const { currentHP, newHP } = await DamageApplicator.applyHPDamage(actor, amount, {
          label: `per-type ${dmgType}`,
          types: [String(dmgType).toLowerCase()],
          damages: _comp
            ? DamageApplicator.describeDamages([{ ...(_comp), final: amount }], 1, null)
            : [{ value: amount, type: String(dmgType).toLowerCase(), properties: new Set() }],
        });
        const _realDelta = Math.max(0, _hpBefore - Number(actor?.system?.attributes?.hp?.value ?? 0));

        // Feed the OverTime regeneration shut-off tracker (RAW: a creature that
        // took its weakness this round doesn't regenerate at its next turn).
        try {
          if (amount > 0 && dmgType) {
            Hooks.callAll(`${MODULE_ID}.damageApplied`, { actor, tokenDocId, types: [String(dmgType).toLowerCase()] });
          }
        } catch (_) { /* non-fatal */ }

        const prevApplied = message.flags?.[MODULE_ID]?.perTypeApplied?.[tokenDocId] ?? 0;
        const overrideLabel = (typeof override === "number" && override !== 1) ? ` (×${override})` : "";
        console.log(`${MODULE_ID} | Per-type apply: comp ${idx} (${amount} ${dmgType}${overrideLabel}) to ${entry.name}: HP ${currentHP} → ${newHP}`);

        const updatedComps = [...currentApplied, idx];
        const _prevDelta2 = message.flags?.[MODULE_ID]?.hpDelta?.[tokenDocId] ?? 0;
        await message.update({
          [`flags.${MODULE_ID}.perTypeApplied.${tokenDocId}`]: prevApplied + amount,
          [`flags.${MODULE_ID}.appliedComps.${tokenDocId}`]: updatedComps,
          [`flags.${MODULE_ID}.perCompApplied.${tokenDocId}.${idx}`]: amount,
          // Keep the true-movement tally in step so a later UNDO ALL is exact.
          [`flags.${MODULE_ID}.hpDelta.${tokenDocId}`]: _prevDelta2 + _realDelta,
        });

        DamageApplicator.overrideCache.delete(cacheKey);
        line.classList.add("ace-qol-dmg-type-applied");
        ui.notifications.info(`ACE QOL: Applied ${amount} ${dmgType} damage to ${entry.name} (${currentHP} → ${newHP})`);

        // If ALL types now applied, mark fully applied
        const totalComps = el.querySelectorAll("[data-action='aceQolApplyType']");
        const allDone = [...totalComps].every(l => {
          const ci = parseInt(l.dataset.compIndex);
          const tid = l.closest(".ace-qol-dmg-target-row")?.dataset?.tokenDocId;
          const ac = message.flags?.[MODULE_ID]?.appliedComps?.[tid] ?? updatedComps;
          return ac.includes(ci);
        });
        if (allDone) {
          await message.setFlag(MODULE_ID, "applied", true);
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

    const dmgSpan = row.querySelector(".ace-qol-dmg-row-dmg");
    if (dmgSpan) dmgSpan.textContent = newDamage;

    const hpSpan = row.querySelector(".ace-qol-dmg-row-hp");
    if (hpSpan) {
      hpSpan.innerHTML = `HP: <span class="ace-qol-hp-cur">${currentHP}</span>→<span class="ace-qol-hp-new${isDead ? ' ace-qol-hp-dead' : ''}">${newHP}</span>`;
    }

    const skull = row.querySelector(".ace-qol-dmg-skull");
    if (skull) skull.style.display = isDead ? "" : "none";
  }
}
