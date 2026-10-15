// ─── ACE QOL — Exhaustion, written the sheet's way ───────────────────────────
//
// His find, 2026-10-12: "Jeth's panel says Exhaustion level 5 and the Exhaustion
// switch on his sheet is off. The plus and minus are only changing the panel."
// And the rule: the cold and the panel write the sheet's own exhaustion, the way
// the sheet's own control writes it, so the switch is on and the sheet and the
// panel say the same number. The system applies its own penalty; ACE adds no
// second effect and never writes speed.
//
// PROVEN FROM dnd5e 5.3.3:
//   • The sheet's pips write `system.attributes.exhaustion` (BaseActorSheet
//     #togglePip → submit). Its `_onUpdate` then syncs ONE effect with the fixed
//     id ActiveEffect5e.ID.EXHAUSTION: creates it, sets its level flag, or
//     deletes it at 0. That sync is not awaited by the update.
//   • The level the sheet, the panel and every penalty read is DERIVED from that
//     effect's flag (AttributesFields.prepareExhaustionLevel), disabled or not.
//   • The sheet's Exhaustion switch is that effect, existing and NOT disabled.
//
// ⚠️🔴 SO A SWITCHED-OFF EFFECT IS THE GHOST. A disabled exhaustion effect still
// carries its level, so the panel says 5 and the 2014 table still takes his walk
// to 0, while the switch reads off. dnd5e's sync only ever updates the level on
// it; it never turns it back on. Every write here ends with the condition on.
// (The same ghost as 2026-08-12: a disabled condition is a condition nothing can
// see and nothing can clear.)
//
// ⚠️ A WRITE OF THE SAME NUMBER IS NO UPDATE. A level stored on the sheet with
// no condition does nothing when written again, so the condition is made here,
// the way dnd5e makes it.
//
// IMPORTS NOTHING. Read from the effects panel and the cold alike.

const LOG = "ace-qol | Exhaustion";

export function exhaustionMax() {
  return Number(CONFIG.DND5E?.conditionTypes?.exhaustion?.levels) || 6;
}

function _effectId() {
  return CONFIG.ActiveEffect?.documentClass?.ID?.EXHAUSTION ?? "dnd5eexhaustion0";
}

/** The number stored on the sheet's own field. */
export function storedExhaustion(actor) {
  const v = Number(foundry.utils.getProperty(actor?._source ?? {}, "system.attributes.exhaustion"));
  return Number.isFinite(v) ? v : 0;
}

/** The level the system is applying: the one the sheet and the panel show. */
export function exhaustionLevel(actor) {
  const v = actor?.system?.attributes?.exhaustion;
  if (v === undefined || v === null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * What this level does, in the rules the system is applying.
 *
 * ⚠️ THE WORLD'S RULES DECIDE, NOT THE ROW. dnd5e applies the 2024 table (−2 on
 * every d20 roll and −5 feet per level) only when its Rules Version setting is
 * 2024, and the 2014 table otherwise; a row saying one while the sheet applies
 * the other would be a lie on the panel. His words are the 2024 line.
 */
export function exhaustionWords(level) {
  const n = Number(level) || 0;
  if (n <= 0) return "";
  if (n >= exhaustionMax()) return "Death.";
  const modern = (globalThis.dnd5e?.settings?.rulesVersion ?? "legacy") === "modern";
  if (modern) return `−${2 * n} on every roll, −${5 * n} feet of speed.`;
  const said = [];
  if (n >= 3) said.push("disadvantage on ability checks, attack rolls and saving throws");
  else if (n >= 1) said.push("disadvantage on ability checks");
  if (n >= 4) said.push("hit point maximum halved");
  if (n >= 5) said.push("speed 0");
  else if (n >= 2) said.push("speed halved");
  const line = said.join("; ");
  return `${line[0].toUpperCase()}${line.slice(1)}.`;
}

/** Wait, briefly, for dnd5e's own sync to land after the sheet's write. */
async function _settle(actor, level, ms = 2000) {
  const id = _effectId();
  const ok = () => {
    const eff = actor.effects?.get(id);
    return level <= 0 ? !eff : (!!eff && Number(eff.getFlag("dnd5e", "exhaustionLevel")) === level);
  };
  const end = Date.now() + ms;
  while (!ok() && Date.now() < end) await new Promise(r => setTimeout(r, 50));
  return ok();
}

/**
 * The condition on the sheet, on, at this level. Made the way dnd5e makes it
 * when there is none; switched back on when it was off.
 * @returns {Promise<string>} what it did, in words, or "" when it was already right
 */
export async function ensureExhaustionCondition(actor, level) {
  const id = _effectId();
  const eff = actor?.effects?.get(id);
  if (level <= 0) {
    if (!eff) return "";
    await eff.delete();
    return "took the Exhaustion condition off";
  }
  if (!eff) {
    const AE = ActiveEffect.implementation;
    const made = await AE.fromStatusEffect("exhaustion", { parent: actor });
    made.updateSource({ "flags.dnd5e.exhaustionLevel": level });
    try {
      await AE.create(made, { parent: actor, keepId: true });
    } catch (err) {
      // dnd5e's own sync may have landed in between; that one is the condition.
      if (!actor.effects?.get(id)) throw err;
      return ensureExhaustionCondition(actor, level);
    }
    return `put the Exhaustion condition on at level ${level}`;
  }
  const wasOff = !!eff.disabled;
  const change = {};
  if (wasOff) change.disabled = false;
  if (Number(eff.getFlag("dnd5e", "exhaustionLevel")) !== level) change["flags.dnd5e.exhaustionLevel"] = level;
  if (!Object.keys(change).length) return "";
  await eff.update(change);
  return wasOff ? `switched the Exhaustion condition back on at level ${level}`
    : `set the Exhaustion condition to level ${level}`;
}

/**
 * Set a creature's exhaustion: the sheet's own field first, exactly as its pips
 * write it, then the condition made sure of.
 * @returns {Promise<boolean>} true when the sheet now says `level`
 */
export async function writeExhaustion(actor, level, why = "", { cause = null } = {}) {
  if (!actor) return false;
  const next = Math.max(0, Math.min(exhaustionMax(), Math.round(Number(level) || 0)));
  const before = exhaustionLevel(actor) ?? 0;
  try {
    if (storedExhaustion(actor) !== next) {
      await actor.update({ "system.attributes.exhaustion": next });
      await _settle(actor, next);
    }
    const fixed = await ensureExhaustionCondition(actor, next);
    // ⚠️ THE REASON IS ON THE CREATURE (his rule, 2026-10-13: "Its description
    // says Extreme cold or Extreme heat, matching the hazard that last changed
    // it"). The same one condition, its description naming the cause.
    if (cause && next > 0) {
      const eff = actor.effects?.get(_effectId());
      if (eff && eff.description !== cause) await eff.update({ description: cause });
    }
    console.log(`${LOG} | ${actor.name}: ${before} → ${next}${why ? ` (${why})` : ""}`
      + `${fixed ? `; also ${fixed}, which the sheet's own write had not` : ""}.`);
    return true;
  } catch (err) {
    console.error(`${LOG} | ${actor.name}'s exhaustion could not be set to ${next}:`, err);
    ui.notifications?.error(`${actor.name}'s exhaustion could not be set to ${next}. See the console.`);
    return false;
  }
}

/**
 * A level the sheet already holds, made real: a switched-off condition comes back
 * on, and a number stored with no condition gets the condition. Never lowers or
 * raises a level. GM only.
 * @returns {Promise<string>} what it did, or ""
 */
export async function repairExhaustion(actor) {
  if (!game.user?.isGM || !actor) return "";
  if (exhaustionLevel(actor) === null) return "";
  try {
    const eff = actor.effects?.get(_effectId());
    const level = eff ? (Number(eff.getFlag("dnd5e", "exhaustionLevel")) || storedExhaustion(actor))
                      : storedExhaustion(actor);
    if (level <= 0) return "";
    const fixed = await ensureExhaustionCondition(actor, level);
    if (fixed) console.log(`${LOG} | ${actor.name} held exhaustion ${level} with the condition `
      + `${eff ? "switched off" : "missing"}; ${fixed}.`);
    return fixed;
  } catch (err) {
    console.warn(`${LOG} | could not put ${actor?.name}'s exhaustion condition right:`, err);
    return "";
  }
}

/**
 * Every creature whose sheet holds a level it is not applying: the world's
 * actors, and the unlinked tokens on the active scene. Active GM, once.
 */
export async function sweepExhaustion() {
  if (game.users?.activeGM !== game.user) return [];
  const fixed = [];
  const actors = [...(game.actors ?? [])];
  for (const doc of game.scenes?.active?.tokens ?? []) if (!doc.actorLink && doc.actor) actors.push(doc.actor);
  for (const actor of actors) {
    const did = await repairExhaustion(actor);
    if (did) fixed.push(`${actor.name}: ${did}`);
  }
  console.log(`${LOG} | sweep: ${fixed.length ? fixed.join("; ") : "every stored level already has its condition"}.`);
  return fixed;
}

/**
 * The sheet's switch turned off is exhaustion gone, so the stored number goes too.
 *
 * ⚠️ dnd5e's switch deletes the condition and leaves the field it was made from,
 * so the sheet would say none while the field still said 5, and the repair above
 * would put the 5 back. Only an ON condition deleted on this screen counts: a
 * level written to 0 has already cleared the field, and a switched-off one is the
 * ghost the repair turns back on.
 */
export function registerExhaustion() {
  Hooks.on("deleteActiveEffect", (effect, _options, userId) => {
    try {
      if (userId !== game.userId) return;
      if (effect?.id !== _effectId() || effect.disabled) return;
      const actor = effect.parent;
      if (!(actor instanceof Actor) || storedExhaustion(actor) <= 0) return;
      actor.update({ "system.attributes.exhaustion": 0 })
        .then(() => console.log(`${LOG} | ${actor.name}: the Exhaustion condition was taken off, so the sheet's level is 0 too.`))
        .catch(err => console.warn(`${LOG} | ${actor.name}'s Exhaustion condition came off but its level could not be cleared:`, err));
    } catch (err) {
      console.warn(`${LOG} | could not follow an Exhaustion condition coming off:`, err);
    }
  });
  if (game.users?.activeGM === game.user) {
    sweepExhaustion().catch(err => console.warn(`${LOG} | the startup sweep failed:`, err));
  }
}
