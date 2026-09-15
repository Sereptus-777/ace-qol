// ─── ACE: QOL — THE FOUR DOORS: the only ways anything lands ───────────────
//
// The One Road, section 11: "Every landing goes through one of four doors, and
// each door waits for the dice inside itself": a card, posted or redrawn; a
// condition or effect, on or off; hit points; a signal other features act on.
//
// Frozen note 4: "A door with no dice does not wait." An immune target, a spell
// with no save, an automatic heal: nothing was thrown, so the door lands at once
// and never sits on a hook for dice nobody threw (the twenty-second card of
// 4 September).
//
// Frozen note 5: only the named signals may be sent; any other is a regression.
//
// PHASE 1 (2026-09-14): saves land through these. Older paths still land their
// own way until their phase moves them here. Section 11: "Until every executor
// is on the road, the doors guard the old paths as well."
//
// ⚠️ MODULE_ID IS HARDCODED. This file is reached from the entry file, and a
// const read at top level inside an import cycle throws at load (2026-08-28).
// ──────────────────────────────────────────────────────────────────────────────

import { awaitDiceSettle } from "../dsn-utils.mjs";
import { DamageApplicator } from "../damage-applicator.mjs";
import { DamageCalculator } from "../damage-calculator.mjs";
import { ConditionLibrary } from "../condition-library.mjs";

const MODULE_ID = "ace-qol";

/** The signals The One Road names (section 11, frozen note 5). Any other is refused. */
export const SIGNALS = Object.freeze([
  "saveComplete", "damageApplied", "killLogged", "reactionUsed", "concentrationBroken",
  "attackResolved", "attackCancelled", "expectCard",
]);

/**
 * The dice that decided a landing, waited for inside the door.
 *
 * @param {boolean|{messageId?: string}} dice  true, or the chat message the dice
 *   came in on, when dice decided this landing; false when none were thrown
 */
export async function untilDiceLand(dice) {
  // ⚠️ NOTE 4: NOTHING THROWN, NOTHING WAITED FOR. A caller whose landing was
  // decided by dice says so; anything else lands at once and never sits on a
  // hook for dice nobody threw (the twenty-second card of 4 September).
  if (!dice) return;
  const messageId = typeof dice === "object" ? (dice.messageId ?? null) : null;
  await awaitDiceSettle(undefined, { messageId });
}

/* ── 1. A card ─────────────────────────────────────────────────────────── */

export class CardDoor {
  /** A new card, once the dice that decided it have landed. */
  static async post(data, { dice = false, options = {} } = {}) {
    await untilDiceLand(dice);
    return ChatMessage.create(data, options);
  }

  /** A card redrawn, once the dice that decided it have landed. */
  static async update(message, data, { dice = false } = {}) {
    await untilDiceLand(dice);
    return message?.update?.(data) ?? null;
  }
}

/* ── 2. A condition or effect ─────────────────────────────────────────── */

export class ConditionDoor {
  /** Whether the creature is immune to everything this condition is. */
  static immune(actor, key) {
    return ConditionLibrary.immuneTo(actor, key);
  }

  /**
   * A condition by its key, through the condition library: its immunity check,
   * no stacking, exhaustion by level, and its stamps (a duration, the caster's
   * concentration, the repeat save, break-free).
   *
   * @returns {Promise<{ok: boolean, applied: string|null, immune?: boolean}>}
   */
  static async apply(actor, key, options = {}, { dice = false } = {}) {
    await untilDiceLand(dice);
    return ConditionLibrary.applyByName(actor, key, options);
  }

  /** A condition taken off. */
  static async remove(actor, key, { dice = false } = {}) {
    await untilDiceLand(dice);
    return ConditionLibrary.removeEffect(actor, key);
  }

  /**
   * One of the item's own effects, put on a creature the way dnd5e's apply button
   * would: a copy, switched on, tied to the caster's concentration, carrying the
   * repeat save when it is the one that has it. Moved here from the save
   * engine's own copy on 2026-09-14, so this is the one place it happens.
   *
   * ⚠️ NO CONDITIONS RIDE ALONG. Statuses are stripped from the copy because a
   * condition always goes through `apply`, with its immunity check and its own
   * clean-up; putting it on twice would leave one behind.
   *
   * ⚠️ REPLACE, NEVER STACK. A second cast of the same spell on the same creature
   * removes the first copy before the fresh one goes on.
   *
   * @param {Item} item
   * @param {Actor} actor
   * @param {{id: string, name: string, effect: object}} fx  a row from readSaveOutcome
   * @returns {Promise<{ok: boolean, name: string, effect?: object, error?: string, dryRun?: boolean}>}
   */
  static async applyItemEffect(item, actor, fx, { outcome = "fail", caster = null,
      repeatingSave = null, endsWith = [], durationSeconds = null, castLevel = null,
      dryRun = false, linkConcentration = true, dice = false } = {}) {
    const name = String(fx?.name ?? "an effect");
    try {
      const src = fx?.effect;
      if (!src) return { ok: false, name, error: "the spell's effect could not be found" };
      const data = typeof src.toObject === "function" ? src.toObject() : JSON.parse(JSON.stringify(src));
      delete data._id;
      data.disabled = false;
      data.transfer = false;
      data.origin = src.uuid ?? item?.uuid ?? null;
      data.statuses = [];

      // Its own duration if it has one, else the spell's. Foundry stamps when it
      // started as the effect lands on the actor.
      const dur = { ...(data.duration ?? {}) };
      const own = ["seconds", "rounds", "turns"].some(k => Number(dur[k]) > 0);
      if (!own && Number(durationSeconds) > 0) dur.seconds = Number(durationSeconds);
      for (const k of ["startTime", "startRound", "startTurn", "combat"]) delete dur[k];
      data.duration = dur;

      const props = item?.system?.properties;
      const isConc = linkConcentration && !!caster && (props?.has?.("concentration")
        || (Array.isArray(props) && props.includes("concentration")));
      let concEffect = null;
      if (isConc) {
        try { concEffect = game.aceQol?.SpellPipeline?.findCasterConcentrationFor?.(caster, item) ?? null; }
        catch (_) { concEffect = null; }   // the ACE tag below still ends it with the spell
      }

      const flags = { ...(data.flags ?? {}) };
      flags.dnd5e = { ...(flags.dnd5e ?? {}) };
      // dnd5e removes a dependent when its parent goes, so this ends it with the
      // caster's concentration; ACE's own tag below is the sweep that never
      // depends on the parent being found in time.
      if (concEffect?.uuid) flags.dnd5e.dependentOn = concEffect.uuid;
      if (castLevel !== null && Number.isFinite(Number(castLevel))) flags.dnd5e.spellLevel = Number(castLevel);
      flags[MODULE_ID] = {
        ...(flags[MODULE_ID] ?? {}),
        spellEffect: { itemUuid: item?.uuid ?? null, effectId: fx.id, outcome,
                       endsWith: (endsWith ?? []).filter(Boolean), stampedAt: Date.now() },
      };
      if (isConc) {
        flags[MODULE_ID].concentrationOrigin = {
          casterId: caster?.id ?? null, spellName: item?.name ?? null, spellItemId: item?.id ?? null,
          concEffectUuid: concEffect?.uuid ?? null, stampedAt: Date.now(),
        };
      }
      if (repeatingSave?.trigger && repeatingSave?.ability && Number.isFinite(Number(repeatingSave?.dc))) {
        flags[MODULE_ID].repeatingSave = {
          ability: String(repeatingSave.ability).toLowerCase(),
          dc: Number(repeatingSave.dc),
          trigger: String(repeatingSave.trigger),
          spellName: item?.name ?? null,
          castWorldTime: Number(repeatingSave.castWorldTime ?? game.time?.worldTime ?? 0),
          durationSeconds: Number(repeatingSave.durationSeconds) || null,
          stampedAt: Date.now(),
        };
      }
      data.flags = flags;

      const rules = Array.isArray(data.changes) ? data.changes.length : 0;
      if (dryRun) {
        console.log(`${MODULE_ID} | whyNoCondition: ${item?.name} WOULD put its own effect "${name}" `
          + `on ${actor?.name} (${outcome}), ${rules ? `${rules} rule(s)` : "words only"}`
          + `${flags[MODULE_ID].repeatingSave ? ", with the repeat save" : ""}.`);
        return { ok: true, name, dryRun: true };
      }

      await untilDiceLand(dice);
      for (const e of (actor?.effects?.contents ?? [])) {
        const se = e.flags?.[MODULE_ID]?.spellEffect;
        if (se?.itemUuid === (item?.uuid ?? null) && se?.effectId === fx.id) {
          try { await e.delete(); } catch (_) { /* already gone */ }
        }
      }
      const created = await actor.createEmbeddedDocuments("ActiveEffect", [data]);
      const eff = created?.[0] ?? null;
      if (!eff) return { ok: false, name, error: "Foundry created nothing" };
      console.log(`${MODULE_ID} | ${item?.name}: put its own effect "${name}" on ${actor.name} (${outcome}), `
        + `${rules ? `${rules} rule(s)` : "words only"}`
        + `${concEffect ? ", ends with the caster's concentration" : ""}`
        + `${flags[MODULE_ID].repeatingSave ? `, repeat ${flags[MODULE_ID].repeatingSave.ability.toUpperCase()} save at the end of each turn` : ""}`
        + `${endsWith?.length ? ", ends with its condition" : ""}.`);
      return { ok: true, name, effect: eff };
    } catch (err) {
      console.warn(`${MODULE_ID} | ${item?.name}: could not put "${name}" on ${actor?.name}:`, err);
      return { ok: false, name, error: String(err?.message ?? err) };
    }
  }
}

/* ── 3. Hit points ─────────────────────────────────────────────────────── */

export class HpDoor {
  /**
   * What each type of damage comes to on this creature once its resistances,
   * immunities and vulnerabilities count. Changes nothing, so a card can show it
   * before anyone presses APPLY.
   *
   * @param {Actor|null} actor
   * @param {Array<{amount: number, type: string|null}>} parts
   * @param {object} [opts]
   * @param {Item} [opts.item]  what dealt it, for a magic weapon's bypasses
   * @param {object} [opts.mods]  the creature's modifiers as the Gate read them
   *   (type → {modifier, reason}); read from the creature when not given
   * @returns {Array<{type: string, raw: number, final: number, modifier: string, reason: string|null}>}
   */
  static preview(actor, parts, { item = null, treatAsNonMagical = false, mods = null } = {}) {
    const m = mods ?? DamageCalculator.getTargetDamageModifiers(actor, item, { treatAsNonMagical });
    return DamageCalculator.applyDamageModifiers((parts ?? []).map(p => ({
      name: p.type ?? "damage", type: p.type ?? "none", total: Math.max(0, Number(p.amount) || 0),
    })), m ?? {});
  }

  /**
   * Take damage off a creature, then say so with the damage-applied signal.
   * ⚠️ Save damage never sent that signal before this door (2026-09-14), so a
   * troll's regeneration and a sleeper's waking never heard a Fireball.
   *
   * @param {Actor} actor
   * @param {Array<{type: string, final: number}>} finals  what `preview` worked out
   * @returns {Promise<{applied: boolean, total: number, hpDelta: number, result?: object}>}
   *   hpDelta is what the hit points really moved by, after temporary hit points
   *   and any listener that reduced it: what UNDO gives back
   */
  static async damage(actor, finals, { dice = false, tokenDocId = null, item = null, source = null,
      label = "damage" } = {}) {
    await untilDiceLand(dice);
    const landed = (finals ?? []).filter(f => Math.max(0, Number(f?.final) || 0) > 0);
    const total = landed.reduce((sum, f) => sum + Number(f.final), 0);
    if (!actor || total <= 0) return { applied: false, total: 0, hpDelta: 0 };
    const types = [...new Set(landed.map(f => f.type).filter(Boolean))];
    // ⚠️ WHAT DEALT IT TRAVELS WITH IT. Heavy Armor Master takes 3 off only
    // nonmagical bludgeoning, piercing and slashing, and reads "magical" from the
    // damage's properties. This is the one description APPLY ALL has always
    // used, so a +1 sword's hit through this door still gets past it.
    const damages = DamageApplicator.describeDamages(landed, 1, item);
    const hp = () => Number(actor?.system?.attributes?.hp?.value ?? 0);
    const before = hp();
    const result = await DamageApplicator.applyHPDamage(actor, total, { label, types, damages });
    // ⚠️ ONLY A REAL WRITE SAYS DAMAGE LANDED. A call from a player's client is
    // refused and hands back a pending promise in `applied`, and a listener can
    // cancel the damage outright.
    if (result?.applied !== true) return { applied: false, total, hpDelta: 0, result };
    const hpDelta = Math.max(0, before - hp());
    // The fields hook-api.mjs promises, plus the ones APPLY ALL has always sent
    // and its listeners read: a multiattack's next swing, the PC stats.
    await SignalDoor.send("damageApplied", {
      actor, total, components: landed, sourceItem: item, sourceActor: source, tokenDocId, types,
      hpDelta, nominal: total, absorbed: hpDelta === 0, dead: hp() <= 0,
    });
    return { applied: true, total, hpDelta, result };
  }

  /**
   * Hit points back, through the one door (The One Road, Phase 4, 2026-09-15).
   * Up to the creature's maximum. Temporary hit points take the higher of the two
   * and never stack (RAW, both editions). A creature brought up from 0 stops dying:
   * its death saves clear and the Unconscious that 0 hit points put on it comes
   * off. A revive takes Dead off first, or dnd5e holds its hit points at 0. A
   * stabilise moves no hit points: the death saves clear and the creature stays
   * unconscious at 0 (Spare the Dying: stable, and still unconscious).
   *
   * ⚠️ NO SIGNAL. The One Road names none for healing (frozen note 5).
   *
   * @param {Actor} actor
   * @param {number} amount  the healing, already rolled and worked out
   * @returns {Promise<{applied: boolean, healed: number, before: number, after: number, temp?: boolean, why?: string}>}
   */
  static async heal(actor, amount, { temp = false, revive = false, stabilize = false, dice = false } = {}) {
    await untilDiceLand(dice);
    if (!actor) return { applied: false, healed: 0, before: 0, after: 0, why: "there is no creature to heal" };
    const hp = actor.system?.attributes?.hp ?? {};
    // ⚠️ SAID, NOT THROWN. Only a GM or the creature's own player can write its
    // hit points, and a permission error in the console is a heal that silently
    // never happened.
    if (!(game.user?.isGM || actor.isOwner)) {
      const now = Number((temp ? hp.temp : hp.value) ?? 0);
      return { applied: false, healed: 0, before: now, after: now, why: "only the GM can change this creature's hit points" };
    }
    const n = Math.max(0, Math.floor(Number(amount) || 0));
    if (temp) {
      const before = Math.max(0, Number(hp.temp ?? 0));
      const after = Math.max(before, n);
      if (after !== before) await actor.update({ "system.attributes.hp.temp": after });
      return { applied: after !== before, healed: after - before, before, after, temp: true };
    }
    if (revive) await takeOffAll(actor, "dead");
    const before = Number(hp.value ?? 0);
    const max = Number(hp.max ?? 0);
    const after = stabilize ? before : Math.min(max, before + n);
    const update = {};
    if (after !== before) update["system.attributes.hp.value"] = after;
    if (before <= 0 && (after > 0 || stabilize)) {
      update["system.attributes.death.success"] = 0;
      update["system.attributes.death.failure"] = 0;
    }
    if (Object.keys(update).length) await actor.update(update);
    if (before <= 0 && after > 0) await takeOffAll(actor, "unconscious");
    return { applied: true, healed: after - before, before, after };
  }
}

/** Every effect on a creature that carries this status, taken off. */
async function takeOffAll(actor, key) {
  const effects = actor?.effects?.contents ?? [...(actor?.effects ?? [])];
  const found = effects.filter(e => e?.statuses?.has?.(key) || String(e?.name ?? "").toLowerCase() === key);
  for (const e of found) {
    try { await e.delete(); }
    catch (err) { console.debug(`${MODULE_ID} | ${key} on ${actor?.name} was already gone:`, err?.message ?? err); }
  }
  return found.length;
}

/* ── 4. A signal ──────────────────────────────────────────────────────── */

export class SignalDoor {
  /**
   * One of the named signals, once the dice that decided it have landed.
   *
   * @returns {Promise<boolean>} false, and a console error, for a name The One
   *   Road does not name
   */
  static async send(name, payload, { dice = false } = {}) {
    if (!SIGNALS.includes(name)) {
      console.error(`${MODULE_ID} | the signal door refused "${name}": only the signals `
        + `The One Road names may be sent (frozen note 5).`);
      return false;
    }
    await untilDiceLand(dice);
    Hooks.callAll(`${MODULE_ID}.${name}`, payload);
    return true;
  }
}
