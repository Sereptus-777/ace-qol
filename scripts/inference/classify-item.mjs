// ─── What IS this thing? Worked out, not looked up ──────────────────────────
//
// ⚠️🔴 THE REGISTRY IS A CACHE, NOT THE PRODUCT. `SpellPipeline._getEntry` is a
// pure name lookup: if the name is not one of the 125 keys somebody typed by
// hand, it returns null and ACE has no plan. That is why every gap has been
// closed by writing another entry, and why the answer to "will my Lich's ninth
// level spells work" was a list of names.
//
// Johnny, 2026-08-28: "I'm not trying to sit here and patch every goddamn spell.
// I'm trying to build the engine that looks at it and says, this is what's going
// to happen."
//
// ⚠️ ONE READER, ONE DECIDER. This file used to dig through the item itself,
// alongside action-facts.mjs doing the same digging for a different purpose.
// Two readers of one item drift apart exactly the way ACE's two template
// geometries did, so this now DECIDES from the eight answers and reads nothing
// on its own.
//
// A curated entry always wins where one exists: those encode rulings no
// structure can express. This covers everything else.
//
// ⚠️ IT SAYS "I DO NOT KNOW". A confident wrong shape is worse than none:
// nothing falls through to the generic engine, which already handles any
// save-and-damage item competently. Declining is a real answer.
import { readActionFacts } from "./action-facts.mjs";

/** Shapes the pipeline can actually dispatch. Anything else is not a plan. */
export const KNOWN_SHAPES = new Set([
  "save-single", "save-area", "template-save", "template-trigger",
  "attack-single", "attack-multi", "multi-buff", "multi-heal",
  "touch", "self", "distribute", "chained", "summon",
  // ⚠️ `template-pool` is dispatchable, so a human may correct a reading to it,
  // but nothing INFERS it: a hit-point pool is a per-spell ruling that appears
  // nowhere in an item's data. Colour Spray's sheet claims a Constitution save
  // it does not have.
  "template-pool",
]);

/**
 * Work out what happens when this button is pushed.
 *
 * @param {object} item             raw item data (a Foundry Item works too)
 * @param {object} [opts]
 * @param {object} [opts.parsed]    DescriptionParser.parse(item), when available
 * @param {object} [opts.timing]    getSpellTiming(item), when available. This is
 *                                  the ONLY thing that separates an area which
 *                                  resolves once from one that keeps catching
 *                                  people, and it is not in the sheet.
 * @param {object} [opts.facts]     pre-read facts, to avoid reading twice
 * @returns {{shape, entry, confidence, evidence, facts}}
 */
export function classifyItem(item, { parsed = null, timing = null, facts = null } = {}) {
  const f = facts ?? readActionFacts(item, { parsed });
  const why = [...(f.evidence ?? [])];
  let assumed = false;

  try {
    if (!f.readable) return { shape: null, confidence: "low", evidence: why, facts: f };

    let shape = null;
    const { trigger, scope, delivery, resolution, change, duration, interference } = f;

    // ⚠️ A PASSIVE IS NOT A PLAN. Magic Resistance and Pack Tactics are real and
    // matter enormously, but nothing is ever "cast" and there is nothing for the
    // pipeline to dispatch. They belong to the attacker and target profiles,
    // which read them when somebody else acts. Saying so beats inventing a shape.
    if (trigger.kind === "passive") {
      why.push("it is always on rather than used, so it belongs to the creature's "
        + "profile and not to an action pipeline");
      return { shape: null, confidence: "high", passive: true, evidence: why, facts: f };
    }

    if (change.summons) {
      shape = "summon";

    // ── AREAS ────────────────────────────────────────────────────────────
    // ⚠️ AN EMANATION THAT ASKS NOTHING OF ANYBODY IS NOT AN AREA. Detect Magic
    // and Detect Evil and Good are range self AND carry a radius template, and
    // they do nothing to anyone: they are the caster sensing outward. Spirit
    // Guardians is also range self with a template and very much IS an area,
    // because it has a save and deals damage. That is the dividing line.
    } else if (delivery.template && !change.heals
               && (resolution.kind === "save" || change.damage.length
                   || delivery.kind === "area")) {
      // ⚠️ INSTANT-VERSUS-TRIGGER IS NOT IN THE SHEET. Faerie Fire, Stinking
      // Cloud and Moonbeam have identical duration, concentration and save data
      // and resolve completely differently. The difference lives in the rules
      // text, which spell-timing.mjs already reads. Ask it rather than guess.
      const t = String(timing?.timing ?? "").toLowerCase();
      if (t) {
        const triggers = t.includes("enter") || t.includes("start");
        shape = triggers ? "template-trigger" : "template-save";
        why.push(triggers
          ? "its text catches creatures entering it and starting their turn in it"
          : "its text resolves once, when it lands");
      } else if (duration.kind === "instant") {
        shape = "template-save";
      } else {
        shape = "template-trigger";
        assumed = true;
        why.push("nothing states whether it re-catches creatures, so its lasting "
          + "duration was used to assume it does");
      }

    // ── ATTACK ROLLS ─────────────────────────────────────────────────────
    } else if (resolution.kind === "attack") {
      shape = resolution.attacks > 1 ? "attack-multi" : "attack-single";

    // ── SAVING THROWS ────────────────────────────────────────────────────
    } else if (resolution.kind === "save") {
      shape = (scope.count ?? 1) > 1 ? "save-area" : "save-single";
      if (resolution.fromText) assumed = true;

    // ⚠️ SELF COMES BEFORE THE EFFECT CHECK, AND THE ORDER IS THE WHOLE POINT.
    // Divine Favor, Comprehend Languages and Fire Shield all apply an effect and
    // all act only on the caster. Testing "does it apply an effect" first calls
    // them buffs and puts a target picker in front of a spell with nobody to
    // pick. The registry has always called these "self" for exactly that reason.
    // ⚠️ AN EMANATION THAT ASKS NOTHING OF ANYBODY IS THE CASTER, NOT AN AREA.
    // Detect Magic and Detect Evil and Good carry a 30 foot radius template and
    // do nothing to anyone inside it: the caster is sensing outward. They fell
    // past the area branch correctly and then landed on "buff" because they
    // apply an effect, which puts a target picker in front of a spell with
    // nobody to pick.
    } else if (scope.kind === "self" || delivery.kind === "emanation") {
      shape = "self";
      if (delivery.kind === "emanation" && scope.kind !== "self") {
        why.push("it radiates from the caster and asks nothing of anyone in range, "
          + "so it is the caster's own spell and needs no target picker");
      }

    // ⚠️ THESE TWO ARE ORDERED BY WHAT THE SHAPES DO, NOT WHAT THEY ARE CALLED,
    // AND GUESSING FROM THE NAMES COST A ROUND OF THIS. In the pipeline,
    // `touch` means "pick one adjacent creature, then heal or damage it", and
    // `multi-buff` means "pick creatures and apply an effect". So the question
    // is not how far away the target is, it is whether the thing leaves
    // something behind. Stoneskin, Heroism, Barkskin, Death Ward, Freedom of
    // Movement, Resistance and Protection from Evil are all delivered by touch
    // and all leave an effect: they are buffs, and routing them by their range
    // sent nine spells to the wrong resolver at once.
    } else if (change.appliesEffect) {
      shape = "multi-buff";

    // ⚠️ AN AREA THAT HEALS IS NOT AN AREA ATTACK. Mass Cure Wounds carries a
    // 30 foot radius and was being read as a template that lands on people,
    // which routes healing through the damage-shaped path.
    } else if (change.heals) {
      shape = (scope.kind === "several" || scope.kind === "area") ? "multi-heal" : "touch";

    } else if (delivery.kind === "touch") {
      shape = "touch";

    } else {
      why.push("nothing about it says how it resolves: no area, no attack roll, "
        + "no saving throw, no healing and no effect");
      return { shape: null, confidence: "low", evidence: why, facts: f };
    }

    if (!KNOWN_SHAPES.has(shape)) {
      why.push(`worked out "${shape}", which the pipeline cannot dispatch`);
      return { shape: null, confidence: "low", evidence: why, facts: f };
    }

    // ── The entry, in the exact shape the registry hands back ────────────
    const entry = { shape, inferred: true };
    if (delivery.rangeFt) entry.range = delivery.rangeFt;
    if (resolution.saveAbility) {
      entry.save = {
        ability: resolution.saveAbility,
        onFail: change.conditions.length ? "effect" : "damage",
      };
      if (resolution.onSave === "half") entry.save.half = true;
      // ⚠️ NO REPEATED SAVE IS EVER INFERRED. "Repeats its save at the end of its
      // turn" is a per-spell ruling. Guessing it either robs a creature of its
      // only escape or hands it one it never had, and both are invisible.
      if (interference.repeatSave) entry.save.repeatAt = interference.repeatSave;
    }
    if (change.conditions.length) entry.effect = { key: change.conditions[0] };
    if (duration.concentration) entry.concentration = true;
    if (delivery.needs.length) entry.requires = delivery.needs;
    if (interference.creatureTypeLimit) entry.onlyAffects = interference.creatureTypeLimit;

    return {
      shape, entry, facts: f,
      confidence: assumed ? "medium" : "high",
      evidence: why,
    };
  } catch (err) {
    why.push(`could not be classified: ${err?.message ?? err}`);
    return { shape: null, confidence: "low", evidence: why, facts: f };
  }
}

/** One line a human can read, for the log and the review screen. */
export function describeClassification(result, itemName = "this") {
  if (result?.passive) {
    return `"${itemName}" is always on rather than used. It has no pipeline shape, `
      + `and the attacker and target profiles read it when somebody acts.`;
  }
  if (!result?.shape) {
    return `ACE could not work out how "${itemName}" resolves: `
      + (result?.evidence?.slice(-1)[0] ?? "no reason recorded")
      + ". It runs through the generic engine instead.";
  }
  return `ACE read "${itemName}" as ${result.shape} (${result.confidence} confidence): `
    + result.evidence.join("; ") + ".";
}
