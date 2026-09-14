// ─── ACE: QOL — THE RECIPE: what a button is, in The One Road's frozen shape ─
//
// Johnny, 2026-09-13, freezing the design: "Reader prints a full recipe on every
// press (not a shape word). Hijinx replay: every item gets that recipe, or a
// named 'no recipe because…'. Blade Barrier must show recatch. Table play does
// not change."
//
// ⚠️ PHASE 0. THIS FILE DECIDES NOTHING AND RUNS NOTHING. It reads an item and
// writes down what pressing each of its activities would do. Nothing executes
// from it yet: the reader prints it and the replay pins it, so every recipe in
// his world can be argued with before anything is allowed to trust it.
//
// ⚠️🔴 THE FIELDS ARE FROZEN ("The One Road", sections 5 and 19). Do not add,
// rename or drop one, and put nothing else on a recipe. A spell that does not
// fit them is a mechanic (section 14), never a new field and never a new engine.
//
// ⚠️ ONE RECIPE PER ACTIVITY, READ BY THE READERS THAT ALREADY EXIST. The plan
// reader answers for an item, and one item can carry a wall and a ring, or an
// attack and a save. So each activity is read through a view of the item that
// holds only that activity. The readers are untouched, and the override rules
// they learned the hard way (08-28) come along with them.
//
// ⚠️ EVIDENCE IS ONLY WHAT IT WAS READ FROM, which here is the item and its own
// words. The pipeline's hand-typed entries and ACE's timing table are not the
// item, so a part that only they know is left OUT of the recipe and named beside
// it, where it can be seen and argued with instead of trusted.
//
// Conventions inside the frozen fields, so nobody reads them two ways:
//   - An automatic decision always succeeds, so what it does is its onSuccess.
//   - A damage outcome in onFail carries onSuccess "half" or "none": what the
//     same dice do on a made save. onSuccess lists only what a success adds.
//   - `then` recipes run after their parent's result: a save after a hit.
//   - An effect outcome and a note name themselves in condition.key; the frozen
//     outcome has no other place for a name.
//   - A value carries its qualifiers the way section 6's worked recipes do:
//     "up-to-N" with its N, "ranged" with its feet, a save with its DC.
//   - Situational modifiers are never here. They belong to the run (note 1).
//
// ⚠️ MODULE_ID IS HARDCODED. This file is reached from the entry file, and a
// const read at top level inside an import cycle throws at load (2026-08-28).
// ──────────────────────────────────────────────────────────────────────────────

import { readActivities, effectDuration } from "../read-activities.mjs";
import { readActionFacts } from "./action-facts.mjs";
import { planFor } from "./spell-plan.mjs";
import { readSaveOutcome } from "./save-outcome-effects.mjs";
import { plainSpellText } from "./spell-text.mjs";
import { getSpellTiming } from "../spell-timing.mjs";
import { DescriptionParser } from "../description-parser.mjs";
import { spellKey } from "../rules/spell-name.mjs";
import { isPrismaticWall } from "../rules/prismatic-wall.mjs";
import { RulesBrain } from "../rules/rules-brain.mjs";
import { PostHitSaves } from "../post-hit-saves.mjs";

const MODULE_ID = "ace-qol";

const _s = (v) => String(v ?? "").trim().toLowerCase();
const _n = (v) => (v === null || v === undefined || v === "" ? null
  : (Number.isFinite(Number(v)) ? Number(v) : null));
const _arr = (v) => (v instanceof Set ? [...v] : (Array.isArray(v) ? v : (v ? [v] : [])));
const _err = (err) => String(err?.message ?? err);

/** The triggers, in the order section 5 lists them. */
const TRIGGERS = [
  "press", "enter-area", "leave-area", "move-through", "cross",
  "start-of-turn", "end-of-turn", "reaction", "hit-by", "kill",
  "trap", "concentration-check", "time",
];
const inOrder = (set) => TRIGGERS.filter(t => set.has(t));

const KNOWN_ACTIVITY_TYPES = new Set([
  "attack", "cast", "check", "damage", "enchant", "forward",
  "heal", "order", "save", "summon", "transform", "utility",
]);

const UNIT_SECONDS = { turn: 6, round: 6, minute: 60, hour: 3600, day: 86400,
  month: 2592000, year: 31536000 };

// ⚠️ A MECHANIC IS NAMED, NEVER GUESSED FROM PROSE, and only the ones section 14
// lists. Matched on the name with "(Legacy)" and the like taken off, and on the
// item's identifier.
const MECHANIC_BY_NAME = {
  "time stop": "time-stop",
  "prismatic spray": "prismatic-spray",
  "counterspell": "slot-contest", "dispel magic": "slot-contest",
  "polymorph": "transform", "true polymorph": "transform", "wild shape": "transform",
  "find familiar": "summon", "animate dead": "summon",
  "glyph of warding": "delayed", "contingency": "delayed", "delayed blast fireball": "delayed",
  "teleport": "destination", "plane shift": "destination",
  "wish": "wish", "divine intervention": "wish",
  "disintegrate": "disintegrate",
};
// Section 14: a pool of hit points in 2014. The 2024 books rewrote both as saves.
const HP_POOL_2014 = new Set(["sleep", "color spray", "colour spray"]);

// The description parser's word for when a repeated save comes round.
const REPEAT_WORDS = { endofturn: "a save at the end of each of its turns",
                       ondamage: "a save each time it takes damage" };

/* ── Reading one activity at a time ───────────────────────────────────── */

/**
 * The item as if it carried only this one activity.
 *
 * ⚠️ A PLAIN OBJECT, NOT A COPY OF THE DOCUMENT. A Foundry document's getters
 * can read private fields, and those throw when called on anything but the
 * document itself. The readers need only these five things.
 */
function onlyActivity(item, activity) {
  const system = Object.create(item?.system ?? null, {
    activities: { value: [activity], enumerable: true },
  });
  return { name: item?.name ?? null, type: item?.type ?? null, flags: item?.flags ?? {},
           effects: item?.effects ?? null, system };
}

/** What every activity of one item shares: its words, its timing, its edition. */
function sharedReads(item, actor) {
  const left = [];
  const read = (what, fn, fallback) => {
    try { return fn(); } catch (err) {
      // ⚠️ NEVER SILENT: a part that could not be read is named beside the recipe.
      left.push(`${what} could not be read (${_err(err)})`);
      return fallback;
    }
  };
  return {
    parsed: read("its words", () => DescriptionParser.parse(item), null),
    timing: read("its timing", () => getSpellTiming(item), null),
    text: read("its text", () => plainSpellText(item?.system?.description?.value ?? ""), ""),
    // Never throws: it falls back to the world's rules itself.
    edition: RulesBrain.resolveEdition(item, actor),
    left,
  };
}

/** FNV-1a: a short, stable fingerprint of what the activity's facts are. */
function fingerprint(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

// Section 13: its type, save, damage, area, range and duration.
function factsPrint(item, activity, facts) {
  const r = facts?.resolution ?? {}, c = facts?.change ?? {}, d = facts?.delivery ?? {};
  return JSON.stringify({
    type: _s(activity?.type),
    activation: _s(activity?.activation?.type),
    resolution: [r.kind ?? null, r.saveAbility ?? null, r.dc ?? null, r.dcFrom ?? null,
                 r.onSave ?? null, r.attacks ?? null, !!r.melee],
    damage: (c.damage ?? []).map(x => [x.formula, _arr(x.types).map(_s).sort()]),
    healing: c.healing?.formula ?? null,
    conditions: _arr(c.conditions).map(_s).sort(),
    summons: !!c.summons, effect: !!c.appliesEffect,
    delivery: [d.kind ?? null, d.rangeFt ?? null, d.template?.shape ?? null, d.template?.size ?? null],
    scope: [facts?.scope?.kind ?? null, facts?.scope?.count ?? null],
    duration: [facts?.duration?.kind ?? null, facts?.duration?.value ?? null,
               facts?.duration?.units ?? null, !!facts?.duration?.concentration],
    level: _n(item?.system?.level),
  });
}

/* ── The item's own effects ────────────────────────────────────────────── */

function itemEffects(item) {
  const raw = item?.effects;
  const list = Array.isArray(raw?.contents) ? raw.contents
    : (typeof raw?.values === "function" ? [...raw.values()] : (Array.isArray(raw) ? raw : []));
  // A compendium copy stores only ids here; there is nothing to read.
  return list.filter(e => e && typeof e === "object");
}

/** The effects this activity names. A transfer effect rides on the carrier, never a target. */
function referencedEffects(item, activity) {
  const byId = new Map(itemEffects(item).map(e => [String(e.id ?? e._id ?? ""), e]));
  return _arr(activity?.effects).map(r => byId.get(String(r?._id ?? r?.id ?? "")))
    .filter(e => e && e.transfer !== true && e.disabled !== true);
}

/** Whether any activity on the item names an effect, which makes the unnamed ones someone else's. */
const anyActivityNamesEffects = (item) => readActivities(item).some(a => _arr(a?.effects).length);

/* ── Outcomes ──────────────────────────────────────────────────────────── */

const secondsOf = (d) => (!d ? null
  : (_n(d.seconds) ?? (_n(d.rounds) ? d.rounds * 6 : null) ?? (_n(d.turns) ? d.turns * 6 : null)));

const damageOut = (d, onSuccess = null) => ({
  kind: "damage", formula: String(d.formula ?? "").trim(),
  types: _arr(d.types).map(_s).filter(Boolean).sort(),
  ...(onSuccess ? { onSuccess } : {}),
});
const conditionOut = (key, { duration = null, ends = null } = {}) =>
  ({ kind: "condition", condition: { key, duration, ends } });
const effectOut = (name, { duration = null, ends = null } = {}) =>
  ({ kind: "effect", condition: { key: name, duration, ends } });
const noteOut = (text) => ({ kind: "note", condition: { key: text, duration: null, ends: null } });

/** What one of the item's effects puts on a creature: its conditions, or itself by name. */
function effectOutcomes(e, ends = null) {
  const st = e?.statuses;
  const statuses = (st instanceof Set ? [...st] : (Array.isArray(st) ? st : [])).map(_s).filter(Boolean);
  const duration = secondsOf(effectDuration(e));
  return statuses.length ? statuses.map(k => conditionOut(k, { duration, ends }))
                         : [effectOut(String(e?.name ?? "an effect"), { duration, ends })];
}

/**
 * The damage this activity rolls.
 *
 * ⚠️ A WEAPON'S OWN DAMAGE BELONGS TO ITS ATTACK. The facts reader adds the
 * weapon's base damage for the whole item, which is right for the item; seen one
 * activity at a time, a poison save on a dagger would otherwise deal the dagger.
 */
const damageRolled = (facts, activity) => (facts?.change?.damage ?? []).filter(d => !d.base
  || (_s(activity?.type) === "attack" && activity?.damage?.includeBase !== false));

/**
 * How a condition from a save ends, in the parser's own reading of the words.
 *
 * ⚠️ dnd5e HAS NO FIELD FOR A REPEATED SAVE. The parser names it as a trigger
 * word ("endOfTurn", "onDamage", or both joined by "|").
 */
function repeatSaveWords(parsed) {
  const t = String(parsed?.repeatingSave?.trigger ?? "").trim();
  if (!t) return null;
  return t.split("|").map(x => REPEAT_WORDS[_s(x)] ?? `a save (${x})`).join(", or ");
}

/* ── The columns ───────────────────────────────────────────────────────── */

function whereOf(plan, facts) {
  const place = plan.place;
  if (!place) return null;
  const t = place.template
    ? { shape: _s(place.template.shape) || null, size: _n(place.template.size),
        units: _s(place.template.units) || "ft" }
    : null;
  switch (place.kind) {
    case "self": return { kind: "self" };
    case "touch": return { kind: "touch" };
    case "emanation": return { kind: "emanation", ...t };
    case "area": return { kind: "area", ...t, rangeFt: _n(place.rangeFt) };
    // A reach is melee, whether the bite attacks or asks for a save.
    case "targets": return (_s(facts?.delivery?.kind) === "reach"
                            || (plan.decide?.kind === "attack" && plan.decide.melee))
      ? { kind: "ranged", rangeFt: _n(place.rangeFt), melee: true }
      : { kind: "ranged", rangeFt: _n(place.rangeFt) };
    default: return null;
  }
}

// When a lasting area catches someone again, in its own words.
const SAVE_OR_HURT = /\bsaving throw\b|\bsave\b|\bdamage\b/i;
const ENTERS = /\b(?:enters?|entering|moves? into)\b/i;
const STARTS = /\bstarts? (?:its|their|your) turn\b/i;
// "ends it turn there" is how the 2024 book prints Blade Barrier.
const ENDS_THERE = /\bends? (?:its|their|it) turn (?:there|in|within|inside)\b/i;
const MOVES_THROUGH = /\bfor (?:every|each) (?:\d+|five) (?:feet|foot)\b/i;

/**
 * The triggers that catch someone again, and where they were read from.
 *
 * ⚠️ ONLY A LASTING AREA RE-CATCHES, and only one that asks something of the
 * people in it. A cone is a moment (Fear, 09-07).
 *
 * ⚠️🔴 THE WORDS ARE READ HERE, NOT TAKEN FROM THE PLAN'S YES OR NO. The plan's
 * reader does not know "a creature also makes that save if it enters", which is
 * how the 2024 books write Blade Barrier and Moonbeam, so both fell back to ACE's
 * timing table, whose answer is the 2014 one: the start of a turn, where the 2024
 * words say the end. Changing the plan's reader changes today's table, so that
 * waits for the trigger phase; the recipe reads the sentences itself.
 */
function recatchOf(plan, timing, text, left) {
  const catches = plan.decide?.kind === "save" || (plan.apply?.damage?.length ?? 0) > 0;
  if (!plan.place?.template || plan.persist?.areaLasts === false || !catches) {
    return { triggers: [], fromText: false };
  }

  const out = new Set();
  for (const sentence of String(text ?? "").split(/(?<=[.!?])\s+/)) {
    if (!SAVE_OR_HURT.test(sentence)) continue;
    if (ENTERS.test(sentence)) out.add("enter-area");
    if (STARTS.test(sentence)) out.add("start-of-turn");
    if (ENDS_THERE.test(sentence)) out.add("end-of-turn");
    if (MOVES_THROUGH.test(sentence)) out.add("move-through");
  }
  if (out.size) return { triggers: inOrder(out), fromText: true };

  const said = _s(timing?.timing);
  const fromTiming = new Set();
  if (said.includes("enter")) fromTiming.add("enter-area");
  if (said.includes("startofturn")) fromTiming.add("start-of-turn");
  if (said.includes("endofturn")) fromTiming.add("end-of-turn");
  if (!fromTiming.size) return { triggers: [], fromText: false };
  if (timing?.fromFlag) return { triggers: inOrder(fromTiming), fromText: false };
  if (timing?.fromParsing) return { triggers: inOrder(fromTiming), fromText: true };
  left.push(`recatch ${inOrder(fromTiming).join(", ")} rests only on `
    + `${timing?.fromTable ? "ACE's own timing table" : "ACE's guess from its duration and area"}, `
    + `not on the item or its words`);
  return { triggers: [], fromText: false };
}

function whoOf(plan, recatch) {
  const w = plan.who;
  if (!w) return null;
  // ⚠️ NOBODY STANDING IN IT WHEN IT LANDS. Blade Barrier, Web, Sleet Storm:
  // only a creature that walks in, or starts its turn there, is caught.
  if (plan.place?.template && recatch.length && plan.persist?.initialSave === false) {
    return { kind: "enters-later" };
  }
  switch (w.kind) {
    case "the caster": return { kind: "caster" };
    case "everyone inside": return w.mayExclude ? { kind: "all-in-area", spares: true }
                                                : { kind: "all-in-area" };
    case "picked":
    case "picked inside the area": {
      const n = _n(w.count);
      return n === 1 ? { kind: "one" } : { kind: "up-to-N", n };
    }
    default: return null;
  }
}

function decidedOf(plan, activity) {
  if (_s(activity?.type) === "check") {
    const c = activity?.check ?? {};
    const skills = _arr(c.associated).map(_s).filter(Boolean);
    return { kind: "contest", check: skills.length ? skills.join("/") : (_s(c.ability) || null),
             dc: _s(c.dc?.calculation) || _n(c.dc?.formula) };
  }
  const d = plan.decide;
  if (!d || d.kind === "passive") return null;
  // ⚠️ A DC FROM SPELLCASTING HAS A BLANK FORMULA, WHICH THE FACTS READER TURNS
  // INTO 0. dnd5e uses the formula only when nothing calculates the DC.
  if (d.kind === "save") return { kind: "save", ability: d.ability || null,
                                  dc: d.dcFrom ? d.dcFrom : (d.dc || null) };
  if (d.kind === "attack") return { kind: "attack", melee: !!d.melee, attacks: d.attacks ?? 1 };
  return { kind: "automatic" };
}

/** What a save's result puts on the creature, from the save's own effects first. */
function saveOutcomes(item, activity, plan, facts, parsed) {
  const onSave = plan.decide?.onSave === "half" ? "half" : "none";
  const onFail = damageRolled(facts, activity).map(d => damageOut(d, onSave));
  const onSuccess = [];
  const ends = repeatSaveWords(parsed);
  let fromText = false;

  const o = readSaveOutcome(item, { activityId: activity?.id ?? activity?._id ?? null });
  for (const r of o.fail) onFail.push(...effectOutcomes(r.effect, ends));
  if (o.alternatives) {
    // ⚠️ SEVERAL EFFECTS ON A FAILURE ARE A MENU (09-11): what they share lands,
    // and the choice is named, never all of them at once.
    for (const k of o.shared) onFail.push(conditionOut(k, { ends }));
    onFail.push(noteOut(`one of: ${o.options.join(", ")}`));
  }
  for (const r of o.success) onSuccess.push(...effectOutcomes(r.effect, null));

  // ⚠️ A SPELL EMPTIED OF ITS EFFECTS STILL SAYS WHAT IT DOES. 111 of his spells
  // lost their effect data (09-11); their words still name the condition.
  if (!o.rows.length) {
    const named = anyActivityNamesEffects(item);
    for (const c of plan.apply?.conditionDetails ?? []) {
      if (c.fromEffect && named) continue;       // it belongs to the activity that names it
      onFail.push(conditionOut(_s(c.condition), { duration: secondsOf(c.duration), ends }));
      if (!c.fromEffect) fromText = true;
    }
  }
  if (onFail.some(x => x.condition?.ends)) fromText = true;
  return { onFail, onSuccess, fromText };
}

function severNote(sever) {
  const what = { head: "the head is cut off", limb: "a limb is cut off",
                 body: "part of the body is cut off" }[sever.severType] ?? "something is cut off";
  return sever.skipSecondaryRoll ? `on a natural 20, ${what}`
                                 : `on a natural 20, roll another d20: on a 20, ${what}`;
}

/** A save asked after a hit, as the recipe that runs after its parent's hit. */
function thenRecipe(r, i, parentKey, edition, source, byHand) {
  const half = r?.halfOnSuccess ? "half" : "none";
  const onFail = _arr(r?.failEffect).map(e => (e?.type === "damage"
    ? damageOut({ formula: e.formula, types: e.damageType }, half)
    : e?.type === "condition" ? conditionOut(_s(e.condition))
    : noteOut(String(e?.description ?? e?.type ?? "what its words say"))));
  const hurts = onFail.some(o => o.kind === "damage");
  return {
    key: `${parentKey} · then ${i + 1}`, edition, source,
    trigger: null, where: null, who: { kind: "one" },
    decidedBy: { kind: "save", ability: _s(r?.ability) || null, dc: _n(r?.dc) },
    onHit: [], onCrit: [], onMiss: [], onFail, onSuccess: [], then: [],
    scaling: null, lasts: null, recatch: [],
    interrupts: ["after-save-roll", ...(hurts ? ["after-damage-roll", "after-damage-taken"] : [])],
    mechanic: null, animation: null, resources: null,
    confidence: byHand ? "high" : "low",
    evidence: [byHand ? "human" : "description"],
  };
}

/** What an attack does on a hit, a critical and a miss, and the saves after a hit. */
function attackOutcomes(item, activity, plan, facts, s, actor, key, source, left) {
  const onHit = damageRolled(facts, activity).map(d => damageOut(d));
  const onCrit = [], onMiss = [];
  let fromText = false, byHand = false, then = [];

  for (const e of referencedEffects(item, activity)) onHit.push(...effectOutcomes(e));
  for (const c of plan.apply?.conditionDetails ?? []) {
    // A condition its words put on only with a save belongs to the save after the hit.
    if (c.fromEffect || c.requiresSave) continue;
    const k = _s(c.condition);
    if (onHit.some(o => o.condition?.key === k)) continue;
    onHit.push(conditionOut(k));
    fromText = true;
  }

  const sever = s.parsed?.severRider;
  if (sever) {
    onCrit.push(noteOut(severNote(sever)));
    if (sever.matchedBy !== "name") fromText = true;
  }
  // 2024 weapon mastery: a miss still deals the ability modifier.
  if (_s(item?.system?.mastery) === "graze") {
    onMiss.push({ kind: "damage", formula: "@mod",
                  types: _arr(item?.system?.damage?.base?.types).map(_s).filter(Boolean).sort() });
  }

  // ⚠️ ONE READER FOR THE SAVE AFTER A HIT (09-12): the damage card and the
  // activity chooser both ask this, so the recipe does too.
  const riders = PostHitSaves.riderSavesFor(item, actor, { parsed: s.parsed, quiet: true });
  if (riders.from === "rules entry" && !item?.flags?.[MODULE_ID]?.rulesEntry) {
    left.push("a save after a hit that only ACE's own rules library names");
  } else {
    byHand = riders.from === "rules entry";
    then = riders.saves.map((r, i) => thenRecipe(r, i, key, s.edition, source, byHand));
    if (then.length && !byHand) fromText = true;
  }
  return { onHit, onCrit, onMiss, then, fromText, byHand };
}

/** What an automatic activity does. It always succeeds. */
function automaticOutcomes(item, activity, plan, facts) {
  const a = plan.apply ?? {};
  const out = damageRolled(facts, activity).map(d => damageOut(d));
  let fromText = false;
  if (a.healing?.formula) {
    out.push({ kind: "heal", formula: String(a.healing.formula).trim(),
               types: _arr(a.healing.types).map(_s).filter(Boolean) });
  }
  const named = referencedEffects(item, activity);
  for (const e of named) out.push(...effectOutcomes(e));
  if (!named.length) {
    const others = anyActivityNamesEffects(item);
    for (const c of a.conditionDetails ?? []) {
      if (c.fromEffect && others) continue;
      const k = _s(c.condition);
      if (out.some(o => o.condition?.key === k)) continue;
      out.push(conditionOut(k, { duration: secondsOf(c.duration) }));
      if (!c.fromEffect) fromText = true;
    }
  }
  if (a.summon) out.push({ kind: "summon" });
  if (!out.length) {
    out.push(a.descriptiveOnly ? noteOut("only what its own words say") : { kind: "nothing" });
    if (a.descriptiveOnly) fromText = true;
  }
  return { out, fromText };
}

function scalingOf(item, activity) {
  const isSpell = _s(item?.type) === "spell";
  const level = _n(item?.system?.level);
  const parts = [..._arr(activity?.damage?.parts), ...(activity?.healing ? [activity.healing] : [])];
  if (isSpell && level === 0) {
    return parts.length ? { by: "character level", step: "more dice at 5th, 11th and 17th level" } : null;
  }
  const steps = [];
  for (const p of parts) {
    const sc = p?.scaling ?? {};
    if (!_s(sc.mode)) continue;
    const per = _s(sc.mode) === "half" ? " per two levels" : "";
    if (String(sc.formula ?? "").trim()) steps.push(`+${String(sc.formula).trim()}${per}`);
    else if (p?.denomination) steps.push(`+${_n(sc.number) ?? 1}d${p.denomination}${per}`);
  }
  // ⚠️ MORE TARGETS PER SLOT LIVE IN THE COUNT'S OWN FORMULA ("1 + @scaling"),
  // which a live item has already turned into a number. The stored one says it.
  const count = activity?._source?.target?.affects?.count ?? activity?.target?.affects?.count;
  if (typeof count === "string" && /@scaling/.test(count)) {
    const m = count.match(/^\s*\d+\s*\+\s*(\d*)\s*\*?\s*@scaling\s*$/);
    steps.push(m ? `+${m[1] || 1} target${(m[1] || "1") === "1" ? "" : "s"}` : `targets ${count.trim()}`);
  }
  if (!steps.length) return null;
  return { by: isSpell ? "slot level" : "level", step: steps.join(" and ") };
}

function lastsOf(plan) {
  const d = plan.persist ?? {};
  const units = _s(d.units);
  const secs = (d.value && UNIT_SECONDS[units]) ? d.value * UNIT_SECONDS[units] : null;
  if (d.concentration) return { kind: "concentration", seconds: secs };
  if (d.kind === "instant") return { kind: "instant" };
  if (d.kind === "permanent" || d.kind === "dispelled") return { kind: "until-dispelled" };
  return { kind: "timed", seconds: secs };
}

function mechanicOf(item, activity, edition) {
  if (isPrismaticWall(item)) return "prismatic-wall";
  const byName = spellKey(item?.name);
  const byId = _s(item?.system?.identifier).replace(/-/g, " ");
  if (edition === "2014" && (HP_POOL_2014.has(byName) || HP_POOL_2014.has(byId))) return "hp-pool";
  const named = MECHANIC_BY_NAME[byName] ?? MECHANIC_BY_NAME[byId] ?? null;
  if (named) return named;
  const t = _s(activity?.type);
  if (t === "summon") return "summon";
  if (t === "transform") return "transform";
  const when = _s(activity?.activation?.type);
  if (when === "legendary" || when === "lair") return when;
  return null;
}

function resourcesOf(item, activity, facts) {
  const c = facts?.cost ?? {};
  const level = _n(item?.system?.level);
  const method = _s(c.preparation);
  const slotted = _s(item?.type) === "spell" && level > 0 && activity?.consumption?.spellSlot !== false
    && method !== "atwill" && method !== "innate";
  return {
    activation: _s(activity?.activation?.type) || null,
    // The slot is chosen in dnd5e's own dialog: until then it is pending.
    slot: slotted ? { base: level, chosen: "pending" } : null,
    uses: c.maxUses ? { max: c.maxUses, recovery: c.recovery ?? [] } : null,
    recharge: c.recharge || null,
    consumes: c.consumes ?? [],
  };
}

function castName(activity) {
  const uuid = String(activity?.spell?.uuid ?? "").trim();
  if (!uuid) return "a spell it does not name";
  let name = null;
  try { name = globalThis.fromUuidSync?.(uuid, { strict: false })?.name ?? null; }
  catch (_) { name = null; }   // the uuid itself is still named below
  return name ? `"${name}"` : `the spell at ${uuid}`;
}

/* ── The recipe ────────────────────────────────────────────────────────── */

/**
 * The recipe for one activity, or the named reason it has none.
 *
 * @param {object} item
 * @param {object} activity
 * @param {object} [opts]
 * @param {object} [opts.actor]   who holds it
 * @param {object} [opts.shared]  what the item's activities share, when already read
 * @returns {{label: string, recipe?: object, none?: string, left: string[]}}
 *   `left` names what is true of the button but was not read from the item, so
 *   it is not on the recipe.
 */
export function recipeForActivity(item, activity, { actor = null, shared = null } = {}) {
  const holder = actor ?? item?.actor ?? null;
  const s = shared ?? sharedReads(item, holder);
  const label = String(activity?.name ?? "").trim() || _s(activity?.type) || "activity";
  const left = [...s.left];
  const none = (why) => ({ label, none: `no recipe because ${why}`, left });
  const type = _s(activity?.type);

  if (!KNOWN_ACTIVITY_TYPES.has(type)) return none(`ACE does not know the activity type "${activity?.type ?? ""}"`);
  if (type === "forward") return none("it triggers another of this item's activities, and that one's recipe is used");
  if (type === "cast") return none(`it casts ${castName(activity)}, and that spell's own recipe is used`);
  if (type === "order") return none("it is an order to a bastion facility, not an action at the table");

  const one = onlyActivity(item, activity);
  const facts = readActionFacts(one, { parsed: s.parsed });
  if (!facts?.readable) return none(`the item could not be read: ${facts?.error ?? "no reason recorded"}`);
  let plan;
  try { plan = planFor(one, { facts, parsed: s.parsed, timing: s.timing }); }
  catch (err) { return none(`its plan could not be worked out: ${_err(err)}`); }
  if (plan.passive) return none("nothing is rolled and nothing is applied: it is always in effect");

  const source = { item: item?.uuid ?? null, activity: activity?.id ?? activity?._id ?? null };
  const key = `${s.edition} · ${spellKey(item?.name) || "unnamed"} · `
    + fingerprint(factsPrint(item, activity, facts));
  const recatch = recatchOf(plan, s.timing, s.text, left);
  const where = whereOf(plan, facts);
  const who = whoOf(plan, recatch.triggers);
  const decidedBy = decidedOf(plan, activity);

  let onHit = [], onCrit = [], onMiss = [], onFail = [], onSuccess = [], then = [];
  let fromText = !!plan.decide?.fromText || recatch.fromText, byHand = false;
  try {
    if (decidedBy?.kind === "attack") {
      const a = attackOutcomes(item, activity, plan, facts, s, holder, key, source, left);
      ({ onHit, onCrit, onMiss, then } = a);
      fromText = fromText || a.fromText;
      byHand = a.byHand;
    } else if (decidedBy?.kind === "save") {
      const o = saveOutcomes(item, activity, plan, facts, s.parsed);
      ({ onFail, onSuccess } = o);
      fromText = fromText || o.fromText;
    } else if (decidedBy) {
      const o = automaticOutcomes(item, activity, plan, facts);
      onSuccess = o.out;
      fromText = fromText || o.fromText;
    }
  } catch (err) {
    return none(`what it does could not be read: ${_err(err)}`);
  }

  const everything = [...onHit, ...onCrit, ...onMiss, ...onFail, ...onSuccess,
                      ...then.flatMap(t => t.onFail)];
  const interrupts = [];
  if (decidedBy?.kind === "attack") interrupts.push("after-attack-roll");
  if (decidedBy?.kind === "save" || then.length) interrupts.push("after-save-roll");
  if (everything.some(o => o.kind === "damage")) interrupts.push("after-damage-roll", "after-damage-taken");

  const evidence = ["item"];
  if (fromText) evidence.push("description");
  if (byHand) evidence.push("human");
  // Section 13: a part only the words suggested makes the whole recipe low.
  const confidence = where && who && decidedBy && !(plan.gaps ?? []).length && !fromText
    ? "high" : "low";

  return {
    label,
    left,
    recipe: {
      key,
      edition: s.edition,
      source,
      trigger: facts.trigger?.kind === "reaction" ? "reaction" : "press",
      where, who, decidedBy,
      onHit, onCrit, onMiss, onFail, onSuccess, then,
      scaling: scalingOf(item, activity),
      lasts: lastsOf(plan),
      recatch: recatch.triggers,
      interrupts,
      mechanic: mechanicOf(item, activity, s.edition),
      animation: {
        // Note 2: whatever places an area owns its animation; ACE plays the rest.
        cast: (where?.kind === "area" || where?.kind === "emanation") ? "area-owner" : "ace-plays",
        // Chosen by the recipe first and the damage type second; none is stored yet.
        impact: { sound: null, crust: null },
      },
      resources: resourcesOf(item, activity, facts),
      confidence,
      evidence,
    },
  };
}

/**
 * Every activity's recipe for an item, or why it has none.
 *
 * @returns {Array<{label: string, recipe?: object, none?: string, left: string[]}>}
 */
export function recipesFor(item, { actor = null } = {}) {
  const acts = readActivities(item);
  if (!acts.length) {
    return [{ label: String(item?.name ?? "item"), none: "no recipe because nothing on it can be pressed", left: [] }];
  }
  const shared = sharedReads(item, actor ?? item?.actor ?? null);
  return acts.map(a => recipeForActivity(item, a, { actor, shared }));
}

/* ── Saying it in one line, every field present ────────────────────────── */

function outText(o) {
  const c = o?.condition ?? {};
  const extra = [c.duration ? `${c.duration}s` : null, c.ends ? `ends on ${c.ends}` : null]
    .filter(Boolean).join(", ");
  switch (o?.kind) {
    case "damage": return `${o.formula}${o.types?.length ? ` ${o.types.join("/")}` : ""}`
      + `${o.onSuccess ? ` (${o.onSuccess} on a success)` : ""}`;
    case "heal": return `heal ${o.formula}${o.types?.includes("temphp") ? " temporary" : ""}`;
    case "condition": return `${c.key ?? "?"}${extra ? ` (${extra})` : ""}`;
    case "effect": return `effect "${c.key ?? "?"}"${extra ? ` (${extra})` : ""}`;
    case "note": return `note: ${c.key ?? "?"}`;
    case "summon": return "a summoned creature";
    default: return o?.kind ?? "?";
  }
}
const list = (xs) => (xs?.length ? xs.map(outText).join(", ") : "-");

function whereText(w) {
  if (!w) return "unknown";
  if (w.kind === "area") return `area ${w.shape ?? "?"} ${w.size ?? "?"}${w.units ?? "ft"}`
    + `${w.rangeFt ? ` within ${w.rangeFt}ft` : ""}`;
  if (w.kind === "emanation") return `emanation ${w.shape ?? "?"} ${w.size ?? "?"}${w.units ?? "ft"}`;
  if (w.kind === "ranged") return `${w.melee ? "melee reach" : "ranged"} ${w.rangeFt ?? "?"}ft`;
  return w.kind;
}
function whoText(w) {
  if (!w) return "unknown";
  if (w.kind === "up-to-N") return `up-to-N ${w.n ?? "(any number)"}`;
  return `${w.kind}${w.spares ? " (the caster may spare some)" : ""}`;
}
function decidedText(d) {
  if (!d) return "unknown";
  const dc = (v) => (typeof v === "number" ? `DC ${v}` : v ? `DC from ${v}` : "DC not stated");
  if (d.kind === "save") return `save ${String(d.ability ?? "?").toUpperCase()} ${dc(d.dc)}`;
  if (d.kind === "attack") return `${d.melee ? "melee" : "ranged"} attack${d.attacks > 1 ? ` x${d.attacks}` : ""}`;
  if (d.kind === "contest") return `contest (${d.check ?? "a check"}${d.dc ? `, ${dc(d.dc)}` : ""})`;
  return d.kind;
}
function lastsText(l) {
  if (!l) return "-";
  if (l.kind === "until-dispelled") return "until dispelled";
  return `${l.kind}${l.seconds ? ` ${l.seconds}s` : ""}`;
}

/** Every field of a recipe, in the frozen order, "-" where it is empty. */
export function recipeLine(rec) {
  if (!rec) return "no recipe because it could not be built";
  const tail = rec.left?.length ? ` · not in the recipe: ${rec.left.join("; ")}` : "";
  if (rec.none) return `${rec.label}: ${rec.none}${tail}`;
  const r = rec.recipe;
  const then = r.then?.length
    ? r.then.map(t => `[${decidedText(t.decidedBy)}: fail ${list(t.onFail)}]`).join(" ") : "-";
  const res = r.resources ?? {};
  const resources = [res.activation ?? "no activation",
    res.slot ? `slot ${res.slot.base}+ (${res.slot.chosen})` : null,
    res.uses ? `${res.uses.max} uses` : null,
    res.recharge ? `recharge ${res.recharge}` : null].filter(Boolean).join(", ");
  const types = [...new Set([...r.onHit, ...r.onFail, ...r.onSuccess]
    .filter(o => o.kind === "damage").flatMap(o => o.types))];
  return [
    `${rec.label} · key ${r.key}`,
    `trigger ${r.trigger ?? "-"}`,
    `where ${whereText(r.where)}`,
    `who ${whoText(r.who)}`,
    `decided ${decidedText(r.decidedBy)}`,
    `on hit ${list(r.onHit)}`,
    `on crit ${list(r.onCrit)}`,
    `on miss ${list(r.onMiss)}`,
    `on fail ${list(r.onFail)}`,
    `on success ${list(r.onSuccess)}`,
    `then ${then}`,
    `scaling ${r.scaling ? `${r.scaling.by} ${r.scaling.step}` : "-"}`,
    `lasts ${lastsText(r.lasts)}`,
    `recatch ${r.recatch?.length ? r.recatch.join(", ") : "-"}`,
    `interrupts ${r.interrupts?.length ? r.interrupts.join(", ") : "-"}`,
    `mechanic ${r.mechanic ?? "-"}`,
    `animation cast ${r.animation?.cast ?? "-"}, impact ${types.length ? `by damage type (${types.join("/")})` : "-"}`,
    `resources ${resources}`,
    `confidence ${r.confidence} (${(r.evidence ?? []).join(" + ")})`,
  ].join(" · ") + tail;
}
