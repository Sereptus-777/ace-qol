// ─── ACE: QOL — A PLAN, NOT A LABEL ─────────────────────────────────────────
//
// Johnny, 2026-09-07: *"I told you before we have all the information. You're
// telling me we cannot build an action based on the information. We have to
// write fucking entries for fucking every fucking spell. Figure out how we're
// going to do this without building entries for every spell."*
//
// He is right, and it is measurable. Every spell dnd5e ships was put through
// the reader and asked whether the item alone answers the three things you need
// in order to execute it:
//
//     spells read from dnd5e's own books        : 659
//       1. somewhere to put it                  : 647 (98%)
//       2. a way to decide it                   : 659 (100%)
//       3. something to then do                 : 659 (100%)
//       ALL THREE, resolvable with no entry     : 647 (98%)
//
// There are 110 hand-written entries. Entries are not what is missing.
//
// ⚠️🔴 WHAT IS BROKEN IS THAT THE DISPATCHER SWITCHES ON A WORD. Sixteen shape
// names and a `switch`, so resolving a spell depends on the classifier picking
// the right one of sixteen. Pick wrong and the spell lands in a resolver built
// for a different kind of spell and dies quietly.
//
// The sixteen are not sixteen categories. They are sixteen points in a grid the
// reader already fills in on every press, which is why the label is redundant:
//
//     where it lands    self, emanation, an area to place, ranged, touch
//     who is caught     everyone inside it, or N targets you pick
//     how it is decided a save and which ability, an attack, or automatic
//     what it does      damage, healing, a condition, an effect, a summon
//     does it continue  instant, timed, concentration, re-catches on entry
//
// `template-save` is area + save + damage. `multi-heal` is picked + automatic +
// healing. `template-trigger` is area + save + condition + lasting. All sixteen
// fall out of those five columns.
//
// ⚠️🔴 AND THE TWO-WAY BRANCH IS THE FEAR BUG. classify-item asks spell-timing
// whether a spell "catches creatures entering it", and answers EITHER
// "template-trigger" OR "template-save", never both. But a spell that re-catches
// does not stop having an initial save: everyone standing in Moonbeam when it
// lands saves, and so does everyone who walks into it afterwards.
//
// Worse, spell-timing DEFAULTS an unknown persistent area spell to start-of-turn
// and flags the answer `unclassified`. classify-item read that default as though
// it were evidence. So Fear, which is not in that table, became a re-catching
// area with no initial save at all, dispatched to a resolver that is a
// deliberate no-op, and nothing ever rolled. It is one spell out of a class:
// any persistent area spell missing from that table lands the same way.
//
// Here those are two separate columns. A plan always carries the initial
// decision, and re-catching is recorded beside it with how confident we are.
//
// ⚠️ THIS FILE DECIDES NOTHING AND RUNS NOTHING. It reads an item and says what
// would have to happen. Executing the plan is a later phase, deliberately, so
// this can be measured against his whole world first.
//
// ⚠️ IMPORTS TWO FILES, and neither imports anything that imports them back.
// Everything else is handed IN, so this cannot start an import cycle.
// ──────────────────────────────────────────────────────────────────────────────

import { readActionFacts } from "./action-facts.mjs";
// The words, with dnd5e's enrichers spelled out. Shared with the facts reader and
// the save-outcome reader, so all three read the same sentences.
import { expandEnrichers as _expand, plainSpellText as _strip } from "./spell-text.mjs";

const _s = (v) => String(v ?? "").trim().toLowerCase();
const _n = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);

/** Ranges that are a note to read the paragraph rather than a distance. */
const UNPLACEABLE = new Set(["unlimited", "unstated", "special", "none"]);

/** Shapes that are a direction you fired in, not a place that stays. */
const ONE_SHOT_SHAPES = new Set(["cone", "line", "ray"]);

/* ── 1. WHERE IT LANDS ─────────────────────────────────────────────────── */

function planPlace(facts, gaps, why) {
  const d = facts?.delivery ?? {};
  const t = d.template ?? null;
  const usable = t && _s(t.shape) && Number(t.size) > 0;

  if (usable && _s(d.kind) === "emanation") {
    why.push(`a ${t.shape} of ${t.size} ${t.units || "ft"} centred on the caster`);
    return { kind: "emanation", template: t, originatesOn: "the caster", rangeFt: 0 };
  }
  if (usable) {
    const reach = _n(d.rangeFt);
    why.push(`a ${t.shape} of ${t.size} ${t.units || "ft"}`
      + `${reach ? `, placed within ${reach} feet` : ""}`);
    return { kind: "area", template: t, originatesOn: "a point you choose", rangeFt: reach };
  }
  // A template that names a shape but no size cannot be drawn, and drawing a
  // zero-foot cone is worse than standing aside.
  if (t && !usable) {
    gaps.push(`its area names a ${t.shape || "shape"} with no size, so there is `
      + `nothing to draw`);
  }

  switch (_s(d.kind)) {
    case "self":
      why.push("it stays on the caster");
      return { kind: "self", template: null, originatesOn: "the caster", rangeFt: 0 };
    case "touch":
      why.push("it is delivered by touch");
      return { kind: "touch", template: null, originatesOn: "the caster", rangeFt: 5 };
    case "ranged":
    case "reach": {
      const ft = _n(d.rangeFt) ?? _n(d.reachFt);
      if (ft === null) { gaps.push("nothing states how far it reaches"); return null; }
      why.push(`targets within ${ft} feet`);
      return { kind: "targets", template: null, originatesOn: "the caster", rangeFt: ft };
    }
    default:
      // ⚠️ NAME THE REASON. "Could not plan it" and "it does nothing" must never
      // print the same, which is the oldest standing rule in this codebase.
      gaps.push(UNPLACEABLE.has(_s(d.kind))
        ? `its reach is "${d.kind}", which is a note to read its own text rather `
          + `than a distance anything can measure`
        : `nothing states where it lands`);
      return null;
  }
}

/* ── 2. WHO IS CAUGHT ──────────────────────────────────────────────────── */

function planWho(facts, place, apply, decide, gaps, why) {
  const s = facts?.scope ?? {};
  const count0 = _n(s.count);

  if (place?.template) {
    // ⚠️ A ROLL FORCED ON SOMEBODY MEANS EVERYONE STANDING IN IT. Fireball,
    // Fear, Cloudkill, Prismatic Spray: no choosing, the area decides.
    const forcedOnOthers = decide?.kind === "save" || decide?.kind === "attack"
      || (apply?.damage?.length ?? 0) > 0;

    // ⚠️🔴 UNLESS THE SPELL'S OWN WORDS HAND THE CHOICE TO THE CASTER. Slow is
    // "up to six creatures of your choice in a 40-foot Cube", and Sleep and
    // Weird are "each creature of your choice" in theirs. dnd5e's sheet marks
    // none of the three as a choice, so reading the sheet alone said "everyone
    // inside" and Slow caught the caster's own allies standing in the cube. The
    // words are read in action-facts, where every other fact about the item is.
    if (forcedOnOthers && s.allowsChoice) {
      // The number comes from the words ("up to six") or the area's own count.
      // Never from a second activity's target: Weird's end-of-turn save names
      // one creature, and capping the whole sphere at one would be a new bug.
      const n = s.choiceCount ?? (_s(s.kind) === "area" && count0 > 0 ? count0 : null);
      why.push(n ? `you pick up to ${n} from inside the area`
                 : "you pick which creatures inside the area it affects");
      return { kind: "picked inside the area", count: n,
               creatureType: s.creatureType ?? null, youChoose: true,
               choiceWords: s.choiceWords ?? null };
    }
    if (forcedOnOthers) {
      // ⚠️ A SPELL THAT LETS THE CASTER SPARE SOME STILL CATCHES THE REST.
      // Spirit Guardians "can designate creatures to be unaffected by it". It is
      // recorded rather than dropped, so nothing downstream mistakes it for a
      // plain everyone-inside area and catches the people the caster spared.
      why.push(s.spares ? "everyone inside the area is caught, except creatures the caster spares"
                        : "everyone inside the area is caught");
      return { kind: "everyone inside", count: null,
               creatureType: s.creatureType ?? null, youChoose: false,
               mayExclude: !!s.spares,
               choiceWords: s.spares ? (s.choiceWords ?? null) : null };
    }

    // ⚠️🔴 AN EMANATION THAT ASKS NOTHING OF ANYBODY IS NOT AN AREA. Detect
    // Magic and Detect Evil and Good are range self AND carry a 30 foot radius,
    // and they do nothing to anyone: the caster senses outward. classify-item
    // already draws this line, and a plan that drew it differently would be two
    // answers to one question, which is the fault this whole rebuild exists for.
    const touchesOthers = (apply?.conditions?.length ?? 0) > 0
      || !!apply?.healing || (apply?.damage?.length ?? 0) > 0;
    if (!touchesOthers) {
      why.push("it senses outward and asks nothing of anyone, so only the caster is affected");
      return { kind: "the caster", count: 1, creatureType: null,
               youChoose: false, sensesOutward: true };
    }

    // ⚠️ AN AREA CAN BE WHERE YOU MAY CHOOSE FROM RATHER THAN WHO IS CAUGHT.
    // Mass Cure Wounds is "up to six creatures in a 30 foot sphere", and Aura
    // of Vitality is one creature per turn inside 30 feet. Reading either as
    // "everyone inside" heals the enemy standing in it.
    if (_s(s.kind) === "one" || _s(s.kind) === "several" || count0) {
      const n = count0 && count0 > 1 ? count0 : 1;
      why.push(`you pick ${n === 1 ? "one" : n} from inside the area`);
      return { kind: "picked inside the area", count: n,
               creatureType: s.creatureType ?? null, youChoose: true };
    }

    why.push("everyone inside the area is caught");
    return { kind: "everyone inside", count: null,
             creatureType: s.creatureType ?? null, youChoose: false };
  }
  if (place?.kind === "self" || _s(s.kind) === "self") {
    why.push("it acts on the caster");
    return { kind: "the caster", count: 1, creatureType: null, youChoose: false };
  }
  const count = _n(s.count);
  if (_s(s.kind) === "several" && count > 1) {
    why.push(`you pick ${count}`);
    return { kind: "picked", count, creatureType: s.creatureType ?? null, youChoose: true };
  }
  if (_s(s.kind) === "one" || count === 1) {
    why.push("you pick one");
    return { kind: "picked", count: 1, creatureType: s.creatureType ?? null, youChoose: true };
  }
  // ⚠️ A REACHABLE SPELL WITH NO STATED COUNT IS ONE TARGET, NOT NONE. dnd5e
  // routinely leaves the count blank on a single-target spell; reading that as
  // "nobody" is how a working spell becomes a dead button.
  if (place?.kind === "targets" || place?.kind === "touch") {
    why.push("nothing states a count, so it is read as one target");
    return { kind: "picked", count: 1, creatureType: s.creatureType ?? null,
             youChoose: true, assumed: true };
  }
  gaps.push("nothing states who it lands on");
  return null;
}

/* ── 3. HOW IT IS DECIDED ──────────────────────────────────────────────── */

function planDecide(facts, gaps, why) {
  const r = facts?.resolution ?? {};
  switch (_s(r.kind)) {
    case "save":
      if (!r.saveAbility) { gaps.push("it forces a save but names no ability"); return null; }
      why.push(`a ${String(r.saveAbility).toUpperCase()} save`
        + `${r.onSave === "half" ? ", half damage on a success" : ""}`);
      return { kind: "save", ability: _s(r.saveAbility), dc: _n(r.dc),
               dcFrom: r.dcFrom ?? null, onSave: r.onSave ?? "none",
               fromText: !!r.fromText };
    case "attack":
      why.push(r.attacks > 1 ? `${r.attacks} attack rolls` : "an attack roll");
      return { kind: "attack", melee: !!r.melee, attacks: Math.max(1, _n(r.attacks) ?? 1),
               ability: r.ability ?? null };
    case "automatic":
      why.push("nothing is rolled; it simply applies");
      return { kind: "automatic" };
    case "none":
      // A passive is not a button. It is not a gap either.
      return { kind: "passive" };
    default:
      gaps.push("nothing states how it is decided");
      return null;
  }
}

/* ── 4. WHAT IT DOES ───────────────────────────────────────────────────── */

function planApply(facts, why) {
  const c = facts?.change ?? {};
  const damage = (c.damage ?? []).map(d => ({ formula: d.formula, types: d.types ?? [],
                                              scales: !!d.scales }));
  const parts = [];
  if (damage.length) parts.push(damage.map(d => d.formula).join(" + "));
  if (c.heals) parts.push(c.healing?.formula ? `${c.healing.formula} healing` : "healing");
  if (c.conditions?.length) parts.push(c.conditions.join(" and "));
  if (!c.conditions?.length && c.appliesEffect) parts.push("an effect");
  if (c.summons) parts.push("a creature on the board");
  if (parts.length) why.push(parts.join(", "));
  else if (c.descriptiveOnly) why.push("only what its own text says");

  return {
    damage,
    healing: c.healing ?? null,
    conditions: [...(c.conditions ?? [])],
    conditionDetails: [...(c.conditionDetails ?? [])],
    effect: !!c.appliesEffect,
    summon: !!c.summons,
    descriptiveOnly: !!c.descriptiveOnly,
    // ⚠️ HALF ON A SUCCESS IS PART OF THE PAYLOAD, NOT THE ROLL. Dropping it is
    // how a Fireball takes a target from full to nothing on a made save.
    halfOnSave: facts?.interference?.halfOnSave ?? false,
  };
}

/* ── Does the area catch you when it lands, or only when you walk in? ──── */

// ⚠️🔴 dnd5e's 2024 TEXT IS NOT PROSE UNTIL FOUNDRY ENRICHES IT. Fireball's
// description on disk begins "[[lookup @labels.description.affects capitalize]]
// in a [[lookup @labels.description.template]]", and the words "each creature"
// appear nowhere in it. `_expand` and `_strip`, imported above from
// spell-text.mjs, write the enrichers out as the words dnd5e renders.

/**
 * A sentence that gates its save on walking into the area or starting a turn
 * standing in it. This is what "re-catches" means.
 *
 * ⚠️🔴 AN ESCAPE IS NOT A RE-CATCH, AND CONFLATING THEM MISREAD SEVEN SPELLS.
 * Slow says "the target repeats the save at the END of each of its turns"; that
 * is the victim shaking the spell off, not the cube catching somebody new, and
 * counting it made Slow a lingering trigger area. Fear's "if the creature ends
 * its turn where it can't see you, it makes a Wisdom saving throw" is the same
 * thing. An end-of-turn save belongs to `repeatSave`, which the facts already
 * read from stated text and never guess at.
 */
const GATED = /\b(?:enters?|entering|moves? into|moves? within|starts? its turn|starts? their turn|for the first time on a turn)\b/i;

/**
 * A sentence whose SUBJECT is a group, which is what an area save reads like.
 *
 * ⚠️🔴 "IN THE AREA" IS THE WRONG TEST, and trying it first proved it. Real
 * rules text puts anything it likes between the noun and the area:
 *     "Each Humanoid in a 20-foot-radius Sphere..."        Calm Emotions
 *     "each creature on the ground in the area makes..."   Earthquake
 *     "Each creature (other than you) in the area..."      Entangle
 *     "Each creature under the cloud when it appears..."   Storm of Vengeance
 *
 * What actually separates an area save from every other save in a spell's text
 * is that the sentence is ABOUT a group. Compare the ones that must not count,
 * where the save belongs to somebody the spell singles out later:
 *     "the attacker must succeed on a CON save"            Holy Aura
 *     "If you probe deeper, the target makes a WIS save"   Detect Thoughts
 *     "A creature can make a DEX save to grab a fixed..."  Reverse Gravity
 *     "The target makes a Dexterity saving throw"          Conjure Celestial
 *
 * So: strip any leading "When ...," or "If ...," clause, then ask whether what
 * remains begins with each / every / any / all.
 */
const LEADING_CLAUSE = /^(?:when|if|at|on|until|while|after|before)\b[^,]{0,120},\s*/i;

/**
 * Who is being asked to roll, taken from the words BEFORE the forcing verb.
 *
 * ⚠️ "STARTS WITH EACH" IS TOO NARROW, and the book proves it in four places:
 *     "A creature in the area when you cast the spell must succeed..."  Entangle
 *     "The target and each creature within 5 feet of it must succeed"   Ice Knife
 * while these, which must NOT count, are singular things the spell has already
 * singled out, and carry no group word before the verb at all:
 *     "The target makes a Dexterity saving throw"          Conjure Celestial
 *     "the attacker must succeed on a CON saving throw"    Holy Aura
 *     "A Frightened target makes a WIS saving throw at the end of each of its
 *      turns"                                              Weird's escape clause
 * That last one is why the group word has to be found before the verb rather
 * than anywhere in the sentence: its "each" belongs to "each of its turns".
 */
const GROUP_MARKER = /\b(?:each|every|any|all)\b|\ba\s+creature\b|\bcreatures\b/i;

/**
 * The sentence forces the roll rather than offering it.
 *
 * ⚠️ FAERIE FIRE NEVER SAYS "MUST". It says "Each creature in the Cube is also
 * outlined if it FAILS a Dexterity saving throw", and a pattern that only knew
 * "must succeed" and "makes a save" read the whole spell as asking nobody
 * anything. "can make" stays out on purpose: Reverse Gravity OFFERS a save to
 * grab something on the way up, and an offer is not a card.
 */
const FORCED = /\bmust\s+(?:\w+\s+){0,2}(?:succeed|make)\b|\bmakes?\s+(?:a|an|another)\s+[\w-]+\s+(?:saving\s+throw|save)\b|\bfails?\s+(?:a|an|the)\s+[\w-]+\s+(?:saving\s+throw|save)\b/i;

// ⚠️ THE ADVERB NEARLY COST GREASE ITS SECOND HALF. Its follow-up sentence is
// "A creature that enters the area or ends its turn there must ALSO succeed on
// that save", and a pattern demanding "must succeed on" back to back missed it,
// so the spell read as catching who was standing there and nobody afterwards.
const SAVE_PHRASE = /\bsaving\s+throw\b|\bmust\s+(?:\w+\s+){0,2}succeed\s+on\b|\bmakes?\s+(?:a|another)\s+\w+\s+save\b|\bon\s+(?:that|this)\s+save\b/i;

/**
 * Read the rules text for WHEN an area asks for its saving throw.
 *
 * ⚠️🔴 THIS IS THE ANSWER SPELL-TIMING GUESSES AT. Its heuristic sends any
 * persistent area spell with concentration to start-of-turn and marks the answer
 * `unclassified`; classify-item then read that guess as a finding, so every area
 * spell missing from its hand-written table lost its initial save.
 *
 * The text says it plainly, and the two cases read completely differently:
 *
 *   Fear      "Each creature in a 30-foot Cone must succeed on a Wisdom save"
 *   Moonbeam  "When the Cylinder appears, each creature in it makes a CON save"
 *   Grease    "When the grease appears, each creature standing in its area..."
 *                ...and also "A creature that enters the area or ends its turn"
 *   Sleet     "When a creature enters the Cylinder for the first time on a turn
 *              or starts its turn there, it must succeed on a DEX save"
 *   Stinking  "Each creature that starts its turn in the Sphere must succeed"
 *
 * Grease is why these are two answers and not one: it catches who is standing
 * there AND who walks in later.
 *
 * @returns {{initial: boolean|null, recatch: boolean|null, evidence: string[]}}
 *          `null` means the text does not say, which is not the same as "no".
 */
export function readAreaTiming(html) {
  const text = _strip(html);
  if (!text) return { initial: null, recatch: null, evidence: [] };

  let initial = null, recatch = null, sawSave = false;
  const evidence = [];
  // Sentences, keeping it simple: rules text is written in short ones.
  for (const raw of text.split(/(?<=[.!?])\s+/)) {
    const s = raw.trim();
    if (!s || !SAVE_PHRASE.test(s)) continue;
    sawSave = true;

    // ⚠️ A SENTENCE CAN BE BOTH, which is why these are not an if/else.
    // Grease says "When the grease appears, each creature standing in its area
    // must succeed", and then "A creature that enters the area or ends its turn
    // there must ALSO succeed on that save".
    if (GATED.test(s)) recatch = true;

    const body = s.replace(LEADING_CLAUSE, "");
    const forced = FORCED.exec(body);
    const before = forced ? body.slice(0, forced.index) : "";
    // ⚠️ AN OFFER IS NOT A CARD. Reverse Gravity says "A creature CAN MAKE a
    // Dexterity saving throw to grab a fixed object it can reach"; the same
    // words as a forced save with one auxiliary in front of them, and a card
    // for everyone in the area would be wrong.
    const offered = /\b(?:can|may|could|might)\s*$/i.test(before);
    if (forced && !offered && !GATED.test(body) && GROUP_MARKER.test(before)) {
      initial = true;
      evidence.push(`"${s.slice(0, 110)}"`);
    }
  }
  return { initial, recatch, sawSave, evidence };
}

/* ── Does the AREA last, or only what it did to people? ────────────────── */

/** The words a spell uses for the space it occupies. */
const AREA_NOUN = /\b(?:area|cube|sphere|cylinder|cone|line|wall|walls|webs?|fog|mist|cloud|smoke|gas|ice|flames?|grease|spikes?|ground|terrain|square|space|barrier|dome|zone|storm|vines?|plants?|tentacles?|darkness|silence|light|globe|sheet|blade|water|sleet|swarm|circle)\b/i;

/**
 * Words that mean a PERSON is what lasts, not the ground.
 *
 * ⚠️🔴 THE SENTENCE THAT NEARLY GOT THIS WRONG. 2014 Fear reads "Each creature
 * in a 30-foot cone must succeed on a Wisdom saving throw or drop whatever it is
 * holding and become Frightened FOR THE DURATION." It contains an area word
 * ("cone") and a duration phrase, and it is not about the cone at all: the cone
 * is where you stood, and the minute belongs to the frightened creature.
 */
const PERSON_WORD = /\b(?:creatures?|targets?|condition|frightened|charmed|poisoned|restrained|prone|blinded|deafened|paralyz(?:ed|es)|stunned|incapacitated|unconscious|invisible)\b/i;

/** A phrase that pins something to the spell's clock. */
const LASTS = /\bfor\s+the\s+duration\b|\buntil\s+the\s+spell\s+ends\b|\blasts?\s+(?:for\s+the\s+duration|until)\b|\bremains?\s+(?:for|until)\b|\bfor\s+the\s+spell'?s?\s+duration\b/i;

/** A phrase that says the area is gone the moment it has done its work. */
const VANISHES = /\bfor\s+a\s+moment\s+and\s+(?:then\s+)?vanish|\bvanishes?\s+immediately\b|\bdisappears?\s+immediately\b|\bappears?\s+for\s+an?\s+instant\b/i;

/**
 * Does the area itself stay on the map, or does only its effect on people last?
 *
 * ⚠️🔴 THE SPELL'S DURATION IS NOT THE AREA'S DURATION, AND CONFLATING THEM IS
 * WHY FEAR'S CONE PLAYED FOR FIVE MINUTES. Fear is "1 minute, concentration",
 * and every one of those seconds belongs to the FRIGHTENED CONDITION on the
 * creatures it caught:
 *
 *     "Each creature in a 30-foot Cone must succeed on a Wisdom saving throw or
 *      drop whatever it is holding and have the Frightened condition FOR THE
 *      DURATION."
 *
 * There is no lingering Fear cone. Nothing walks into one. But the cone was
 * judged persistent, so the template was never auto-deleted, and the Forge FX
 * anchored to that template never ended.
 *
 * ⚠️ THE ONES THAT REALLY DO LINGER ALL SAY SO, ABOUT THE SPACE:
 *     Web          "The webs fill a 20-foot Cube there for the duration"
 *     Sleet Storm  "Until the spell ends, sleet falls in a Cylinder"
 *     Cloudkill    "The fog lasts for the duration"
 *     Spike Growth "The area becomes Difficult Terrain for the duration"
 * and the ones that do not are silent about the space, or say it outright:
 *     Hypnotic P.  "The pattern appears for a moment and vanishes"
 *
 * @returns {{lingers: boolean|null, evidence: string[]}} null = its text does
 *          not say, which is not the same as "no".
 */
export function readAreaPersistence(html) {
  const text = _strip(html);
  if (!text) return { lingers: null, evidence: [] };

  let lingers = null;
  const evidence = [];
  for (const raw of text.split(/(?<=[.!?])\s+/)) {
    const s = raw.trim();
    if (!s) continue;
    if (VANISHES.test(s)) {
      evidence.push(`"${s.slice(0, 110)}"`);
      return { lingers: false, evidence };
    }
    // ⚠️ IT IS NOT ENOUGH FOR BOTH TO BE IN THE SENTENCE. What matters is WHAT
    // is being timed, so only the words right beside the duration phrase get a
    // vote. An area word there means the ground lasts; a person word there
    // means the creature does.
    const m = LASTS.exec(s);
    if (!m) continue;
    // "Until the spell ends, sleet falls in a Cylinder" puts the phrase first,
    // so when there is nothing in front of it, read what comes after.
    // ⚠️ THE WHOLE CLAUSE IN FRONT OF IT, not a fixed number of characters.
    // Gust of Wind opens "A line of strong wind 60 feet long and 10 feet wide
    // blasts from you in a direction you choose for the spell's duration": the
    // word "line" is ninety characters from the phrase that times it.
    const before = s.slice(0, m.index);
    const window = before.trim() ? before : s.slice(m.index + m[0].length);
    if (!AREA_NOUN.test(window) || PERSON_WORD.test(window)) continue;
    lingers = true;
    evidence.push(`"${s.slice(0, 110)}"`);
  }
  return { lingers, evidence };
}

/**
 * Should this spell's area be taken off the map once it has resolved?
 *
 * @param {object} item
 * @param {object} [opts]
 * @param {boolean} [opts.hasTemplate]  whether it puts an area on the map at all
 * @returns {true|false|"unknown"}
 */
export function areaLingers(item, { hasTemplate = true, shape = null } = {}) {
  if (!hasTemplate) return false;
  const t = readAreaPersistence(item?.system?.description?.value);
  if (t.lingers === true) return true;
  if (t.lingers === false) return false;

  // ⚠️ A CONE OR A LINE IS A MOMENT, NOT A PLACE. Checked against every
  // cone-or-line spell in both books that carries a lasting duration, seven of
  // them, and the text settles all seven the same way this does:
  //     Earthquake, Gust of Wind, Passwall, Sunbeam   say the area lasts
  //     Colour Spray, Dragon's Breath, Fear           say nothing about it,
  //                                                   and none of them lingers
  // Nothing walks into a Fear cone afterwards. Every other shape falls through
  // to "unknown", which changes nothing about how it behaves today.
  if (ONE_SHOT_SHAPES.has(_s(shape))) return false;
  return "unknown";
}


/**
 * Does anybody standing in this area save the moment it lands?
 *
 * ⚠️🔴 THE QUESTION THAT WAS NEVER ASKED, AND THE ONE THAT KILLED FEAR. An
 * area spell either catches whoever is standing there when it appears, or it
 * only catches whoever walks in afterwards, and the sheet does not record which.
 * The text does, in one sentence, and the save engine had no way to ask.
 *
 * ⚠️ THREE ANSWERS, NEVER TWO. "Its text does not say" is not "no". Where the
 * text is silent the RAW default holds: a spell that forces a save at all
 * catches who is in it, which is how every instant area spell in the game works
 * and is the reading that cannot silently do nothing.
 *
 * ⚠️ ONE DECIDER. The plan and the save engine both call this rather than each
 * working it out, which is the fault this whole rebuild exists to end.
 *
 * @param {object} item
 * @param {object} [opts]
 * @param {boolean} [opts.hasSave]  whether anything forces a saving throw
 * @returns {true|false|"unknown"}
 */
export function initialSaveOwed(item, { hasSave = true } = {}) {
  if (!hasSave) return false;
  const t = readAreaTiming(item?.system?.description?.value);
  if (t.initial === true) return true;
  // It says only "when you enter, or start your turn here". Standing in it when
  // it lands is neither, so nobody saves yet. Web, Sleet Storm, Stinking Cloud.
  if (t.recatch === true) return false;
  // ⚠️🔴 THE TEXT NAMES A SAVE, AND IT IS NOT THE AREA'S. Holy Aura saves
  // the ATTACKER who hits somebody in the aura. Detect Thoughts saves the mind
  // you probe. Conjure Celestial saves whoever the spirit attacks. Reverse
  // Gravity offers an optional grab. Wall of Stone saves a creature the wall
  // would enclose. Every one of them is a real save on the sheet, and posting a
  // card for everyone standing in the area would be a card that should not
  // exist — which is the same fault as the silence, wearing the other face.
  if (t.sawSave) return false;
  // The text names no saving throw at all, yet the sheet carries one. Nothing
  // to read, so RAW's ordinary reading holds: it catches who is in it.
  return "unknown";
}

/* ── 5. DOES IT KEEP WORKING ───────────────────────────────────────────── */

/**
 * ⚠️🔴 RE-CATCHING IS A SEPARATE QUESTION FROM THE INITIAL SAVE, AND TREATING
 * THEM AS ONE IS THE FEAR BUG. classify-item chooses BETWEEN "resolves once
 * when it lands" and "catches creatures entering it", and Moonbeam does both.
 *
 * ⚠️ AND AN UNCLASSIFIED DEFAULT IS NOT EVIDENCE. spell-timing defaults an
 * unknown persistent area spell to start-of-turn and marks the answer
 * `unclassified`. That default was being read as a finding, so every persistent
 * area spell missing from its table lost its initial save.
 */
function planPersist(facts, timing, item, decide, why) {
  const d = facts?.duration ?? {};
  const t = timing ?? null;
  const said = _s(t?.timing);
  const stated = !!(t?.fromTable || t?.fromFlag || t?.fromParsing) && !t?.unclassified;
  const looksLikeRecatch = said.includes("enter") || said.includes("start")
    || said.includes("end");

  // ⚠️ THE TEXT OUTRANKS THE GUESS. spell-timing's heuristic is a default; the
  // spell's own words are evidence.
  const fromText = readAreaTiming(item?.system?.description?.value);

  let recatches = false, confidence = "no";
  if (fromText.recatch === true) { recatches = true; confidence = "stated in its text"; }
  else if (stated && looksLikeRecatch) { recatches = true; confidence = "stated"; }
  else if (stated) { recatches = false; confidence = "stated"; }
  else if (looksLikeRecatch) {
    // Assumed, and SAID to be assumed. It never suppresses the initial save.
    recatches = true; confidence = "assumed";
  }

  const initialSave = initialSaveOwed(item, { hasSave: decide?.kind === "save" });
  const shape = facts?.delivery?.template?.shape ?? null;
  const areaLasts = areaLingers(item, { hasTemplate: !!shape, shape });

  if (recatches) {
    why.push(`creatures entering it are caught again (${confidence})`);
  }
  if (initialSave === true) why.push("whoever is in it when it lands saves too");
  else if (initialSave === false && recatches) why.push("nobody saves until they walk in");
  const conc = !!d.concentration;
  if (conc) why.push("concentration");

  return {
    kind: _s(d.kind) || "instant",
    value: _n(d.value), units: _s(d.units) || null,
    concentration: conc,
    recatches, recatchConfidence: confidence,
    // true / false / "unknown" — three answers, never two.
    initialSave, initialSaveEvidence: fromText.evidence,
    // ⚠️ THE SPELL'S DURATION IS NOT THE AREA'S DURATION. Fear is a minute of
    // FRIGHTENED on people, not a minute of cone on the map.
    areaLasts,
    followsCaster: !!t?.followsCaster,
    // An escape at the end of each turn, only ever taken from stated text.
    repeatSave: facts?.interference?.repeatSave ?? null,
  };
}

/* ── The plan ──────────────────────────────────────────────────────────── */

/**
 * What would have to happen for this item to resolve, worked out from the item.
 *
 * @param {object} item
 * @param {object} [opts]
 * @param {object} [opts.facts]   readActionFacts(item), if already read
 * @param {object} [opts.parsed]  DescriptionParser.parse(item), if available
 * @param {object} [opts.timing]  getSpellTiming(item), if available
 * @returns {object} the five columns, `complete`, and `gaps` in plain English
 */
export function planFor(item, { facts = null, parsed = null, timing = null } = {}) {
  const gaps = [];
  const why = { place: [], who: [], decide: [], apply: [], persist: [] };

  let f = facts;
  if (!f) { try { f = readActionFacts(item, { parsed }); } catch (_) { f = null; } }
  if (!f?.readable) {
    return { name: item?.name ?? null, complete: false, facts: f ?? null,
             place: null, who: null, decide: null, apply: null, persist: null,
             gaps: [f?.error ? `the item could not be read: ${f.error}`
                             : "the item could not be read"],
             why };
  }

  // ⚠️ ORDER MATTERS. Who is caught depends on whether anything is forced on
  // them, so what it does and how it is decided are worked out first.
  const place = planPlace(f, gaps, why.place);
  const apply = planApply(f, why.apply);
  const decide = planDecide(f, gaps, why.decide);
  const who = planWho(f, place, apply, decide, gaps, why.who);
  const persist = planPersist(f, timing, item, decide, why.persist);

  // ⚠️ A PASSIVE IS NOT AN INCOMPLETE PLAN. It has no button to press, so
  // reporting it as a failure would bury the real ones.
  const passive = decide?.kind === "passive";
  const complete = !!(place && who && decide) && !passive;

  return {
    name: item?.name ?? null,
    itemType: _s(item?.type) || null,
    complete, passive, gaps, why,
    place, who, decide, apply, persist,
    facts: f,
  };
}

/**
 * Settle the one fork that killed Fear, and ONLY where the spell's own text
 * settles it.
 *
 * ⚠️🔴 THE FORK. classify-item asks spell-timing whether a spell "catches
 * creatures entering it" and answers EITHER template-trigger OR template-save.
 * spell-timing has a hand-written table and, for anything missing from it, a
 * heuristic that DEFAULTS to start-of-turn. So a default was choosing between
 * two resolvers, and Fear lost its saving throw to it.
 *
 * ⚠️ IT ANSWERS ONLY WHEN THE TEXT DOES, AND STAYS SILENT OTHERWISE. Measured
 * across both books, letting it answer everywhere would move Slow, Weird and
 * Flaming Sphere on the strength of the same guess it exists to overrule.
 * Returning null leaves the existing answer exactly as it is.
 *
 * @param {object} plan
 * @returns {"template-save"|"template-trigger"|null} null = no opinion
 */
export function templateForkFromPlan(plan) {
  const s = plan?.persist;
  if (!s) return null;

  // ⚠️ NOTHING RE-CATCHES IN AN AREA THAT IS NOT THERE. A cone is a direction
  // you fired in; Fear's frightened creatures last a minute, its cone does not.
  if (s.areaLasts === false) return "template-save";

  // The spell says in its own words whether walking in catches you.
  if (s.recatchConfidence === "stated in its text") {
    return s.recatches ? "template-trigger" : "template-save";
  }
  return null;
}

/**
 * Which of the pipeline's resolvers this plan describes.
 *
 * ⚠️🔴 THE SHAPE IS A CONSEQUENCE OF THE PLAN, NOT A GUESS THAT PRECEDES IT.
 * Johnny, 2026-09-07: *"we have all the information."* The sixteen shape words
 * are sixteen points in the five columns above, so the word can be worked out
 * rather than decided, and the fork that killed Fear disappears with it:
 * "does it re-catch" and "does its area last" are separate questions, and only
 * a spell that answers yes to BOTH is a lingering trigger.
 *
 * ⚠️ NULL MEANS ACE DOES NOT CLAIM IT, WHICH IS SAFE. dnd5e resolves an
 * unclaimed spell on its own sheet and that works. Claiming one and then
 * mishandling it is the failure this whole rebuild exists to end, so anything
 * that does not clearly match a resolver's contract returns null.
 *
 * @param {object} plan  from `planFor`
 * @returns {string|null}
 */
export function shapeFromPlan(plan) {
  if (!plan || plan.passive || !plan.complete) return null;
  const { place, who, decide, apply, persist } = plan;
  const tmpl = place?.template ?? null;
  const heals = !!(apply?.healing || apply?.heals);
  const onCasterOnly = who?.kind === "the caster";

  if (apply?.summon) return "summon";

  // ── Healing that covers ground ──
  // ⚠️ THE EMANATION TEST NEEDS BOTH HALVES. Second Wind heals and is self
  // ranged and is not an emanation: it has no radius.
  if (heals && tmpl && place.kind === "emanation") return "emanation-heal";
  if (heals && tmpl) return "template-heal";

  // ── Areas that ask something of the people standing in them ──
  // ⚠️ AN EMANATION THAT ASKS NOTHING OF ANYBODY IS NOT AN AREA. Detect Magic
  // carries a 30 foot radius and does nothing to anyone in it.
  if (tmpl && !heals && !onCasterOnly
      && (decide?.kind === "save" || (apply?.damage?.length ?? 0) > 0
          || place.kind === "area")) {
    // ⚠️🔴 TWO QUESTIONS, AND THE OLD CODE ASKED ONE. A lingering trigger has
    // to BOTH re-catch creatures AND still be there to re-catch them in. Fear
    // re-catches (its frightened creatures re-save to shake it off) and its cone
    // is gone the moment it lands, so it is not a trigger area at all: it is an
    // area that resolved once, which is what nobody ever rolled for.
    // ⚠️🔴 AND AN ASSUMED RE-CATCH MAY NOT DECIDE IT. spell-timing's heuristic
    // guess is what started all of this; letting it back in here would make
    // Slow, Weird and Flaming Sphere lingering trigger areas on the strength of
    // the same default. Recorded as an assumption, never acted on as one.
    const lingeringTrigger = persist?.recatches === true
      && persist?.recatchConfidence !== "assumed"
      && persist?.areaLasts !== false;
    return lingeringTrigger ? "template-trigger" : "template-save";
  }

  if (decide?.kind === "attack") return decide.attacks > 1 ? "attack-multi" : "attack-single";

  if (decide?.kind === "save") return (who?.count ?? 1) > 1 ? "save-area" : "save-single";

  // ⚠️ SELF BEFORE THE EFFECT CHECK, AND THE ORDER IS THE WHOLE POINT. Divine
  // Favour and Fire Shield apply an effect and act only on the caster; testing
  // for an effect first puts a target picker in front of a spell with nobody
  // to pick.
  if (onCasterOnly || place.kind === "self" || place.kind === "emanation") return "self";

  // ⚠️ ORDERED BY WHAT THE RESOLVERS DO, NOT BY WHAT THEY ARE CALLED. In this
  // pipeline "touch" means pick one adjacent creature and heal or hurt it, and
  // "multi-buff" means pick creatures and leave something on them. Stoneskin
  // and Death Ward are delivered by touch and are buffs.
  if (apply?.effect) return "multi-buff";
  if (heals) return (who?.kind === "picked inside the area" || (who?.count ?? 1) > 1)
    ? "multi-heal" : "touch";
  if (place.kind === "touch") return "touch";

  return null;
}

/**
 * The plan as sentences a human can check, in the same voice as the snapshot.
 *
 * @param {object} plan
 * @returns {string}
 */
export function describePlan(plan) {
  if (!plan) return "  no plan";
  if (plan.passive) {
    return "  PLAN\n    nothing to run: it is always in effect, with no button to press.";
  }
  if (!plan.complete) {
    return ["  PLAN", "    cannot be run from the item alone:",
      ...plan.gaps.map(g => `      - ${g}`),
      "    dnd5e resolves it natively, which is the safe answer."].join("\n");
  }

  const p = plan.place, w = plan.who, d = plan.decide, a = plan.apply, s = plan.persist;
  const where = p.kind === "emanation"
      ? `a ${p.template.shape} of ${p.template.size} ${p.template.units || "ft"} on the caster`
    : p.kind === "area"
      ? `a ${p.template.shape} of ${p.template.size} ${p.template.units || "ft"}`
        + `${p.rangeFt ? ` placed within ${p.rangeFt} ft` : ""}`
    : p.kind === "self" ? "the caster"
    : p.kind === "touch" ? "one creature you touch"
    : `${w.count === 1 ? "one target" : `${w.count} targets`} within ${p.rangeFt} ft`;

  // ⚠️ "HALF ON A SUCCESS" ON A SPELL WITH NO DAMAGE IS NOISE. Fear inflicts a
  // condition and nothing else; dnd5e still marks its save block half, so
  // printing it there says something untrue about how the spell resolves.
  const decided = d.kind === "save"
      ? `${d.ability.toUpperCase()} save${d.dc ? ` DC ${d.dc}` : ""}`
        + `${d.onSave === "half" && a.damage.length ? ", half on a success" : ""}`
    : d.kind === "attack" ? (d.attacks > 1 ? `${d.attacks} attack rolls` : "an attack roll")
    : "automatic";

  const does = [
    a.damage.length ? a.damage.map(x => x.formula).join(" + ") : null,
    a.healing?.formula ? `${a.healing.formula} healing` : (a.heals ? "healing" : null),
    a.conditions.length ? a.conditions.join(" and ") : null,
    !a.conditions.length && a.effect ? "an effect" : null,
    a.summon ? "a summoned creature" : null,
  ].filter(Boolean).join(", ") || (a.descriptiveOnly ? "only what its text says" : "nothing recorded");

  const lasts = s.kind === "instant" ? "once, and it is over"
    : `${s.value ? `${s.value} ${s.units}` : s.kind}`
      + `${s.concentration ? ", concentration" : ""}`;

  const lines = [
    "  PLAN",
    `    put              ${where}`,
    `    catch            ${w.kind}${w.assumed ? " (count not stated, read as one)" : ""}`,
    `    decide with      ${decided}`,
    `    then apply       ${does}`,
    `    lasts            ${lasts}`,
  ];

  // ⚠️🔴 THE LINE THAT WOULD HAVE CAUGHT FEAR. Whether anybody saves when it
  // lands is its own sentence, printed for every area spell, so it can never
  // again be mistaken for the question about re-catching.
  if (p.template) {
    lines.push(`    on arrival       ${
      s.initialSave === true ? "everyone already inside saves now"
      : s.initialSave === false ? "nobody saves until they enter or start a turn in it"
      : s.initialSave === "unknown" ? "its text does not say, so everyone inside saves now"
      : "nothing to save against"}`);
  }
  if (p.template) {
    lines.push(`    the area itself  ${
      s.areaLasts === true ? "stays on the map until the spell ends"
      : s.areaLasts === false ? "is gone the moment it resolves"
      : "its text does not say, so it is left where it lands"}`);
  }
  if (s.recatches) {
    lines.push(`    and again        creatures entering it, or starting their turn `
      + `in it, are caught again (${s.recatchConfidence})`);
  }
  if (s.repeatSave) lines.push(`    escape           another save at ${s.repeatSave}`);

  return lines.join("\n");
}
