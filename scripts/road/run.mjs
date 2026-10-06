// ─── ACE: QOL — A TRIGGER RUNS THE CAST'S OWN RECIPE ─────────────────────────
//
// The One Road, Phase 5 (2026-09-15). Johnny: "Concentration area tracker and
// repeating-save engine become trigger SOURCES. They call run(recipe, trigger).
// They do not decide what lands."
//
// A press is not the only way onto the road. Four more ways exist, and every one
// of them is the SAME spell catching somebody again:
//
//   enter-area     it walked into the area
//   start-of-turn  it began its turn in the area
//   end-of-turn    it ended its turn in the area
//   move-through   it moved through the area (Spike Growth, per five feet)
//
// ⚠️🔴 THE RE-CATCH USED TO BE A SECOND SPELL. The area tracker kept its own
// ability, its own DC, its own damage types and its own formula, read at the
// cast from the sheet, and handed those to a save card with NO recipe. A card
// with no recipe asks whatLands about nothing, so a creature that walked into
// Blade Barrier and failed took ZERO damage from a card showing 6d10 force, and
// the spell's own effect (the 2024 Spirit Guardians' halved speed) never went on
// at all. Spike Growth read `system.damage.parts`, a field dnd5e 5.x does not
// fill, and fell back to a hardcoded 2d4 piercing that it applied straight to
// the actor, past the hit-point door, on a card that was never the card door's.
//
// So the trigger no longer decides anything. It says WHO and WHEN; the recipe
// says WHAT, exactly as it did at the press, and whatLands is still the only
// decider. A recipe carries its own re-catch list, read from the item's words at
// the press (`recatch`), so a trigger that this spell does not answer is refused
// here and says so.
//
// ⚠️ IMPORTS ONLY THE ROAD. The doors, whatLands and the dice wait. The save
// engine arrives as an argument, because it imports half the suite and a leaf
// that reached back for it would close an import cycle at load (2026-09-06).
// ──────────────────────────────────────────────────────────────────────────────

import { whatLands, automaticOutcomes } from "./what-lands.mjs";
import { CardDoor, ConditionDoor, HpDoor } from "./doors.mjs";
import { safeShowForRoll, awaitDiceSettle } from "../dsn-utils.mjs";
import { faceOf } from "../face.mjs";

const MODULE_ID = "ace-qol";
const LOG = "ace-qol | road";

/**
 * The ways a lasting area or a lasting condition catches somebody again, and,
 * since 2026-09-19, the two ways a creature's own words catch the ones around
 * it with nobody pressing anything: "dies" (a death burst) and "aura" (a body
 * that burns on its turn). Johnny: "No button."
 */
export const TRIGGERS = Object.freeze(["enter-area", "start-of-turn", "end-of-turn", "move-through", "dies", "aura"]);

/** What the card says happened, in plain words. */
const WORDS = Object.freeze({
  "enter-area":    "moved into it",
  "start-of-turn": "started its turn in it",
  "end-of-turn":   "ended its turn in it",
  "move-through":  "moved through it",
  "dies":          "was caught when it died",
  "aura":          "was beside it on its turn",
});

/** RAW: a move-through area deals its damage for every five feet moved in it. */
export const FEET_PER_TICK = 5;

/** The words for a trigger, for a card or a log line. */
export function triggerWords(trigger) {
  return WORDS[trigger] ?? String(trigger ?? "");
}

/**
 * Does this recipe catch anyone on this trigger?
 *
 * ⚠️ THE RECIPE ANSWERS, NOT THE ENGINE THAT NOTICED THE MOVE. `recatch` is read
 * from the item's own words at the press: the 2014 Spirit Guardians catches on
 * entering and at the start of a turn, the 2024 one on entering and at the end,
 * and Blade Barrier the same as the 2024 copy. An engine that fired "start of
 * turn" at all of them would be playing the 2014 rules at a 2024 table.
 *
 * @returns {{ok: boolean, why: string}}
 */
export function catchesOn(recipe, trigger, { whenSilent = false } = {}) {
  if (!recipe) return { ok: false, why: "there is no recipe to run" };
  const list = Array.isArray(recipe.recatch) ? recipe.recatch : [];
  if (!TRIGGERS.includes(trigger)) return { ok: false, why: `"${trigger}" is not one of the road's triggers` };
  if (list.includes(trigger)) return { ok: true, why: "" };
  // A death burst and a burning body are fired by the creature's own words,
  // read by the engine that fires them (rules/creature-words.mjs): the recipe
  // says what lands, never whether its creature died or took a turn.
  if (trigger === "dies" || trigger === "aura") return { ok: true, why: "" };
  // ⚠️ A RECIPE THAT NAMES NONE DOES NOT SILENCE THE AREA. `recatch` is read from
  // the item's own sentences, and plenty of areas his table plays every week say
  // it somewhere this reader does not claim: Web's walk-in sentence belongs to its
  // Caught button, Stinking Cloud's and Entangle's rest on ACE's timing table.
  // Refusing those would take a working spell off the board to make a rule look
  // tidy, so a silent recipe leaves the timing to the engine that noticed the move
  // and says so. What LANDS is still the recipe's, which is the whole phase.
  if (!list.length && whenSilent) {
    return { ok: true, why: "its words name no re-catch, so the area's own timing asked for this one" };
  }
  return { ok: false, why: list.length
    ? `its words catch on ${list.join(", ")}, not on ${trigger}`
    : `its words say nothing about catching anyone again` };
}

/** The damage a recipe lands with no roll to decide it, from the one list whatLands reads. */
function automaticDamage(recipe) {
  return automaticOutcomes(recipe).filter(o => o?.kind === "damage" && String(o.formula ?? "").trim());
}

/**
 * Run one trigger on one creature, through the cast's own recipe.
 *
 * The source says who and when. This says nothing about either: it asks the
 * recipe what this trigger lands and puts it through the doors, the same way the
 * press does.
 *
 * @param {object} recipe            the recipe frozen at the press
 * @param {"enter-area"|"start-of-turn"|"end-of-turn"|"move-through"} trigger
 * @param {object} ctx
 * @param {Item}   ctx.item          the spell or feature that is catching them
 * @param {Actor}  ctx.actor         its caster
 * @param {Token}  ctx.token         the creature it caught
 * @param {object} [ctx.saveEngine]  the live save engine, for a recipe with a save
 * @param {string} [ctx.activityId]  the activity the press used
 * @param {number} [ctx.castLevel]   the slot it was cast with
 * @param {number} [ctx.saveDC]      the DC worked out at the press, for a recipe
 *                                   whose own DC is a calculation ("spellcasting")
 * @param {number} [ctx.feet]        how far it moved inside the area (move-through)
 * @param {string} [ctx.templateId]  the area it is standing in
 * @returns {Promise<{ran: boolean, why: string, kind?: string, total?: number}>}
 */
export async function run(recipe, trigger, ctx = {}) {
  const { item, actor, token, saveEngine = null, activityId = null, castLevel = null,
          saveDC = null, feet = 0, templateId = null, skipDelay = true, fromTiming = false } = ctx;
  const who = token?.name ?? token?.actor?.name ?? "a creature";
  const what = item?.name ?? "an area";
  // What happened, for the card and the console: the trigger's own words, or the
  // caller's when it knows better ("was beside the salamander as its turn ended").
  const happened = ctx.happened ?? triggerWords(trigger);

  const may = catchesOn(recipe, trigger, { whenSilent: fromTiming });
  if (may.ok && may.why) console.log(`${LOG} | ${what}: ${may.why}.`);
  if (!may.ok && recipe) {
    // ⚠️ SILENCE IS A BUG. A trigger that runs nothing says why, every time, so
    // "it caught nobody" and "ACE could not read it" never look the same.
    //
    // ⚠️🔴 AND A REFUSAL IS AN ANSWER, NOT A SHRUG. `refused` tells the engine
    // that noticed the move that the spell's own words have spoken: it must not
    // fall back to its old reading and ask for the save anyway, or the 2024 Blade
    // Barrier would still catch a creature at the start of its turn, which is the
    // 2014 rule for a different spell.
    console.log(`${LOG} | ${what}: ${who} ${happened}, and nothing was run: ${may.why}.`);
    return { ran: false, refused: true, why: may.why };
  }
  if (!may.ok) return { ran: false, refused: false, why: may.why };
  if (!token?.actor) return { ran: false, why: "that creature has no actor" };

  const kind = recipe.decidedBy?.kind ?? "nothing";

  // ── A recipe decided by a save: the save engine runs it, with the recipe ──
  //
  // ⚠️ THE SAME CARD THE PRESS POSTS. It rolls the recipe's dice, asks whatLands
  // for each creature's share, lands the hit points and every condition on the
  // result through the doors, and carries the recipe so the player's own roll on
  // another client decides the same way.
  if (kind === "save") {
    const post = saveEngine?.postSaveCard?.bind(saveEngine);
    // ⚠️ WHO ROLLS IT IS THE SAME RULE AS EVERYWHERE ELSE (his, 2026-07-25): a
    // creature somebody owns rolls its own dice on that player's client; a GM's
    // own NPC rolls at once, so a turn never waits on nobody.
    const rollNow = ctx.rollNow ?? !token.actor?.hasPlayerOwner;
    const fast = saveEngine?._fastResolveSingleNpcSave?.bind(saveEngine);
    if (typeof post !== "function") {
      console.warn(`${LOG} | ${what}: ${who} ${happened}, but the save engine is not here, `
        + `so no save was asked.`);
      return { ran: false, why: "the save engine is not on the road here" };
    }
    const ability = String(recipe.decidedBy?.ability ?? "").trim();
    // ⚠️ A DC THAT IS A CALCULATION IS NOT A NUMBER. "from spellcasting" is what
    // the recipe stores; the number it came to at the press is the one the whole
    // table already saw, so that is the one a re-catch uses.
    const dcFromRecipe = Number(recipe.decidedBy?.dc);
    const dc = Number.isFinite(dcFromRecipe) && dcFromRecipe > 0 ? dcFromRecipe : Number(saveDC);
    if (!ability || !Number.isFinite(dc) || dc <= 0) {
      console.warn(`${LOG} | ${what}: ${who} ${happened}, but its save has `
        + `${ability ? "no DC" : "no ability"}, so nothing was asked.`);
      return { ran: false, why: ability ? "its save has no DC" : "its save has no ability" };
    }
    console.log(`${LOG} | ${what}: ${who} ${happened} — its own recipe's `
      + `${ability.toUpperCase()} DC ${dc} save, ${trigger}.`);
    if (rollNow && typeof fast === "function") {
      await fast(item, actor, token, {
        saveAbility: ability,
        saveDC: dc,
        isSpell: item?.type === "spell",
        recipe,
        activityId,
        activity: null,
        spellLevel: castLevel,
        timing: null,
        skipDelay,
      });
      return { ran: true, why: `its ${ability.toUpperCase()} save, ${trigger}`, kind, rolled: true };
    }
    await post(item, actor, [token], {
      saveAbility: ability,
      saveDC: dc,
      isSpell: item?.type === "spell",
      recipe,
      activityId,
      spellLevel: castLevel,
      templateId,
      trigger,
      skipDelay,
    });
    return { ran: true, why: `its ${ability.toUpperCase()} save, ${trigger}`, kind, rolled: false };
  }

  // ── A recipe nothing rolls against: it just happens ───────────────────────
  //
  // Spike Growth and Cloud of Daggers have no save at all. What lands is what
  // the recipe says lands, rolled here, shared out by whatLands (an automatic
  // recipe lets all of it through) and landed through the doors.
  if (kind === "automatic") {
    const rows = automaticDamage(recipe);
    const lands = whatLands(recipe, { passed: false });
    if (!rows.length && !lands.conditions.length && !lands.effects.length) {
      console.log(`${LOG} | ${what}: ${who} ${happened}, and its recipe puts nothing on anyone.`);
      return { ran: false, why: "its recipe lands nothing" };
    }

    // ⚠️ EVERY FIVE FEET IS EVERY FIVE FEET, AND EACH ONE ROLLS ITS OWN DICE.
    // `5 * (2d4)` rolls two dice and multiplies; the rules ask for 2d4 again for
    // each five feet, which is a different spread and the one the table sees.
    const ticks = trigger === "move-through"
      ? Math.floor(Math.max(0, Number(feet) || 0) / FEET_PER_TICK)
      : 1;
    if (trigger === "move-through" && ticks < 1) {
      console.log(`${LOG} | ${what}: ${who} moved less than ${FEET_PER_TICK} feet inside it, so nothing was rolled.`);
      return { ran: false, why: `it moved less than ${FEET_PER_TICK} feet inside it` };
    }

    const rolled = [];
    for (const row of rows) {
      const formula = ticks > 1
        ? Array(ticks).fill(`(${row.formula})`).join(" + ")
        : row.formula;
      try {
        const roll = new Roll(formula, actor?.getRollData?.() ?? {});
        await roll.evaluate();
        safeShowForRoll(roll, `${what} ${trigger}`);
        rolled.push({ total: Number(roll.total) || 0, type: row.types?.[0] ?? null, formula, roll });
      } catch (err) {
        console.warn(`${LOG} | ${what}: could not roll "${formula}" for ${who}:`, err);
      }
    }
    // ⚠️ NOTHING LANDS BEFORE THE DICE (his rule). The doors wait as well; this
    // wait is for the card's own words, which read the totals.
    if (rolled.length) await awaitDiceSettle();

    const verdict = whatLands(recipe, { passed: false, rolled: rolled.map(r => ({ total: r.total, type: r.type })) });
    // ⚠️ THORNS AND BLADES ARE NOT MAGICAL WEAPONS. An Iron Golem's immunity to
    // nonmagical bludgeoning, piercing and slashing covers a spell's spikes: they
    // are not attacks at all. This is the reading the movement damage has always
    // used, kept.
    let finals = HpDoor.preview(token.actor, verdict.damage.map(d => ({ amount: d.amount, type: d.type })),
      { item, treatAsNonMagical: true });
    // ⚠️ THE SAME QUESTION EVERY OTHER DOOR ASKS (2026-09-17). A creature
    // walking through Wall of Fire takes fire damage, and Absorb Elements answers
    // fire from any source. This door landed it without asking, like the save
    // card and the damage card did until tonight. Loaded lazily: the reaction
    // helper lives beside the damage card, and the road must not import it at
    // the top of the file.
    // ⚠️ NOTHING IS ASKED WHILE THE DICE ARE STILL ROLLING (his rule). The
    // settle above only runs when something was rolled; a reaction prompt is an
    // answer somebody gives to a number, so it waits for that number here, on
    // its own, whatever came before. A settle with no dice in the air returns
    // at once.
    await awaitDiceSettle();
    try {
      const { DamageApplicator } = await import("../damage-applicator.mjs");
      finals = await DamageApplicator._askDamageReactions(token.actor, finals, {
        token, source: actor, item, where: `${what} (${happened})`,
      });
    } catch (err) {
      console.warn(`${MODULE_ID} | could not ask ${token.actor?.name}'s reactions about that damage, `
        + `so it lands in full:`, err);
    }
    const landed = await HpDoor.damage(token.actor, finals, {
      dice: rolled.length > 0, item, source: actor, tokenDocId: token.document?.id ?? null,
      label: `${what} (${happened})`,
    });

    // ⚠️ THE SOURCE TRAVELS WITH THE CONDITION. A ward that names a material
    // ("webs of any sort") can only answer when it can see what this was made of.
    const warded = [];
    for (const c of [...verdict.conditions, ...verdict.effects]) {
      if (!c?.key) continue;
      const res = await ConditionDoor.apply(token.actor, c.key,
        c.duration ? { duration: c.duration } : {}, { dice: rolled.length > 0, item });
      if (res?.warded) warded.push({ key: c.key, source: res.source, why: res.why });
    }

    await _postAutomaticCard({ item, actor, token, trigger, happened, ticks, rolled, finals, landed, verdict, warded, dice: rolled.length > 0 });
    return { ran: true, why: `its own damage, ${trigger}`, kind, total: landed?.total ?? 0 };
  }

  console.log(`${LOG} | ${what}: ${who} ${happened}, and a recipe decided by `
    + `${kind} has nothing to run on a trigger.`);
  return { ran: false, why: `it is decided by ${kind}` };
}

/**
 * What a repeat save does to a condition, decided by the recipe (Hold Person's
 * end-of-turn save, Phase 5).
 *
 * ⚠️ THE RECIPE ALREADY SAYS THIS. A condition is on the failure list and not on
 * the success list, so a made save ends it and a failed one leaves it. The repeat
 * engine used to answer "passed, so delete it" on its own, which is the same
 * answer for Hold Person and the wrong one for anything whose words keep a
 * condition on a made save.
 *
 * @param {object} recipe
 * @param {object} o
 * @param {string} o.key      the condition or effect this save is against
 * @param {boolean} o.passed  the save, after the reaction window
 * @returns {{decided: boolean, ends: boolean, why: string}}  decided false means
 *   the recipe does not name this condition, so the engine keeps its own answer
 */
export function repeatOutcome(recipe, { key, passed } = {}) {
  const want = String(key ?? "").trim().toLowerCase();
  if (!recipe || !want) return { decided: false, ends: !!passed, why: "no recipe names this condition" };
  const named = (v) => [...v.conditions, ...v.effects].some(c => String(c?.key ?? "").toLowerCase() === want);
  const onFail = whatLands(recipe, { passed: false });
  const onPass = whatLands(recipe, { passed: true });
  if (!named(onFail) && !named(onPass)) {
    return { decided: false, ends: !!passed, why: `its recipe does not name "${key}"` };
  }
  const stays = passed ? named(onPass) : named(onFail);
  return { decided: true, ends: !stays,
    why: passed
      ? (stays ? "its recipe keeps it on a made save" : "its recipe puts it on only a failed save")
      : (stays ? "its recipe puts it on a failed save" : "its recipe takes it off on a failed save") };
}

/**
 * The card for damage nothing rolled against.
 *
 * ⚠️🔴 IT IS THE DAMAGE CARD NOW (his rule, 2026-10-05): "Fire Aura posts
 * through the same damage-card builder as a hit. The title row is Fire Aura and
 * the dice, 2d6, on that same row. The next row names who was beside the
 * bearer. Then the dice images and the total, then the resist line, then the hit
 * points, the same block a hit card ends with."
 *
 * This function used to write its own markup: the same facts in a worse shape,
 * with the dice as text instead of their faces and no hit-point block at the
 * end of it at all. A salamander's aura and a claw's hit are both "this creature
 * took this damage" and there is one card for that.
 *
 * ⚠️ NOTHING THE OLD CARD SAID IS LOST. The conditions it landed and anything
 * that refused one travel in `extras`, which the builder draws under the
 * creature's row, so Web still says "not restrained" and why.
 */
async function _postAutomaticCard({ item, actor, token, trigger, happened = null, ticks, rolled, finals, landed, verdict, warded = [], dice }) {
  try {
    const esc = (s) => foundry.utils.escapeHTML(String(s ?? ""));
    const total = finals.reduce((sum, f) => sum + (Number(f.final) || 0), 0);
    const tokenDoc = token?.document ?? token;
    const targetActor = token?.actor ?? tokenDoc?.actor ?? null;
    if (!targetActor) {
      console.warn(`${LOG} | ${item?.name}: no creature behind that token, so no card was posted.`);
      return;
    }

    /* ⚠️ THE DICE, ON THE TITLE ROW. One formula per part, as rolled: a hold
       that carries two kinds reads "3d6 + 2d6". */
    const titleNote = rolled.map(r => r.formula).join(" + ");

    /* ⚠️ WHO IT REACHED, in the words the trigger already had. */
    const subLine = `${tokenDoc?.name ?? targetActor.name} ${happened ?? triggerWords(trigger)}`
      + `${trigger === "move-through" ? ` (${ticks} × ${FEET_PER_TICK} feet)` : ""}.`;

    /* ⚠️ EACH PART KEEPS ITS OWN ROLL, or the card cannot draw the dice. The
       faces come off the Roll object, so it travels with the component. */
    const comps = finals.map((f, i) => {
      const r = rolled[i] ?? null;
      return {
        name: item?.name ?? "Damage",
        type: f.type ?? "damage",
        raw: Number(r?.total ?? f.amount ?? f.final) || 0,
        final: Number(f.final) || 0,
        formula: r?.formula ?? "",
        roll: r?.roll ?? null,
        modifier: f.modifier ?? "normal",
      };
    });

    /* ⚠️ THE HIT POINTS IT HAD BEFORE, so the line reads 52 → 45 and not
       45 → 45. The door hands back what it wrote. */
    const hp = targetActor.system?.attributes?.hp ?? {};
    const before = Number(landed?.result?.currentHP ?? hp.value ?? 0);
    const hpDelta = Number(landed?.hpDelta ?? 0);

    const refused = new Set((warded ?? []).map(w => String(w.key)));
    const conditions = [...verdict.conditions, ...verdict.effects]
      .map(c => c?.key).filter(Boolean).filter(k => !refused.has(String(k))).map(esc);
    // ⚠️ A SILENT SKIP IS THE SAME AS A BROKEN FEATURE. Whatever refused it is
    // named on the card, in the words of the thing that did it.
    const wardRows = (warded ?? []).map(w =>
      `<div class="ace-qol-dmg-ward-line">not ${esc(w.key)} &middot; <span>${esc(w.why)}</span></div>`).join("");
    const extras = (conditions.length || wardRows)
      ? `<div class="ace-qol-dmg-extras">`
        + `${conditions.length ? `<div class="ace-qol-dmg-cond-line">${conditions.join(", ")}</div>` : ""}`
        + `${wardRows}</div>`
      : null;

    /* ⚠️ WHO MAY SEE IT (his rule): the creature that took it, the creature
       that caused it, and every GM. Nobody else, and a table with no player
       owner on either side leaves it GM-only. */
    const seers = new Set((game.users?.filter?.(u => u.isGM) ?? []).map(u => u.id));
    for (const a of [targetActor, actor]) {
      for (const u of (game.users ?? [])) {
        if (u.isGM) continue;
        if (a?.testUserPermission?.(u, "OWNER")) seers.add(u.id);
      }
    }

    const { DamageCardRenderer } = await import("../damage-card-renderer.mjs");
    await DamageCardRenderer.postDamageCard(item, actor, [{
      targetToken: token,
      targetActor,
      target: {
        name: tokenDoc?.name ?? targetActor.name,
        img: faceOf(targetActor),
        currentHP: before,
        maxHP: Number(hp.max ?? 0),
      },
      totalFinal: total,
      totalRaw: comps.reduce((sum, c) => sum + c.raw, 0),
      isCrit: false,
      hitResult: "hit",
      components: comps,
      reactionsAsked: true,
    }], null, null, null, null, {
      titleNote,
      subLine,
      extras,
      // Not a swing: no CLEAVE, no PUSH.
      offerMeleeExtras: false,
      whisper: [...seers],
      // Nothing is offered that has already happened: the door landed it above.
      alreadyTaken: landed?.applied
        ? { [tokenDoc?.id ?? token?.id]: hpDelta }
        : null,
    });
    void dice;   // the card door waits for the damage dice inside the builder
  } catch (err) {
    console.warn(`${LOG} | could not post the card for ${item?.name}:`, err);
  }
}
