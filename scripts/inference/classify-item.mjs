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
  "touch", "self", "distribute", "chained",
  // ⚠️🔴 THESE TWO WERE MISSING, AND THAT IS THE WHOLE ANSWER TO "WHY
  // COULDN'T IT WORK IT OUT FROM THE DESCRIPTION?".
  //
  // Johnny, 2026-09-05, on being told a name suffix was why Aura of Vitality
  // did nothing: "You're telling me that because the name wasn't quite right,
  // it couldn't figure out from the description or from the other data that
  // this was Aura of Vitality."
  //
  // He was right to push. The name was one bug. This was the real one: the
  // pipeline can dispatch SIXTEEN shapes and this list only permitted
  // FOURTEEN. `emanation-heal` and `template-heal` were not words the engine
  // was allowed to say, so no amount of reading the text could ever produce
  // them. Aura of Vitality's description states everything needed — radiates
  // from you, 30-foot radius, moves with you, 2d6 to one creature — and the
  // best answer available was "self". Mass Cure Wounds could never have been
  // worked out either.
  "emanation-heal", "template-heal",
  // ⚠️ `summon` IS DELIBERATELY NOT HERE ANY MORE. The pipeline has no
  // `case "summon"` at all, so an inferred summon reached the dispatch's
  // default arm, which warns and refunds the slot. Falling through to dnd5e,
  // which summons perfectly well on its own, is the honest outcome. (The
  // registry's own 11 summon entries still carry that shape and still reach
  // that default — flagged separately, not fixed blind.)
  // ⚠️ `template-pool` is dispatchable, so a human may correct a reading to it,
  // but nothing INFERS it: a hit-point pool is a per-spell ruling that appears
  // nowhere in an item's data. Colour Spray's sheet claims a Constitution save
  // it does not have.
  "template-pool",
]);

/**
 * Everything his item does not say, taken from the book entry for the same
 * spell in the same edition.
 *
 * ⚠️🔴 THE BOOK ARRIVED AFTER THE VERDICT, AND HE CAUGHT IT.
 * Johnny, 2026-09-05: "It did not compare it to the actual spell itself that we
 * have in memory, or somewhere on the disk, or somewhere in the monster manual."
 * He was right. The book was being opened after the shape had already been
 * decided, purely to complain about differences. It was an auditor, not a
 * source. This is the book being consulted BEFORE the decision.
 *
 * ⚠️ HIS ITEM ALWAYS WINS WHERE IT SPEAKS. Only silence is filled. His copy
 * is what is being cast, and a book value that overwrote a stated one would be
 * the Spare the Dying mistake again — where I believed a canonical number over
 * his sheet and had him change items that were already correct.
 *
 * ⚠️ AND EVERY FILL IS NAMED. A shape that came out right because the book
 * supplied the radius must not look like a shape read off his own item, or the
 * next person to debug it starts from a false picture.
 */
export function fillFromBook(mine, book) {
  const bookFacts = (() => {
    try { return readActionFacts(book); } catch (_) { return null; }
  })();
  if (!bookFacts?.readable) return mine;

  const why = [...(mine.evidence ?? [])];
  const took = [];
  const out = {
    ...mine,
    scope: { ...mine.scope }, delivery: { ...mine.delivery },
    resolution: { ...mine.resolution }, change: { ...mine.change },
    duration: { ...mine.duration },
  };

  // The radius. This is the one that matters most: without it a healing aura is
  // indistinguishable from a spell that only touches the caster.
  if (!out.delivery.template && bookFacts.delivery.template) {
    out.delivery.template = bookFacts.delivery.template;
    if (out.delivery.kind !== "emanation" && bookFacts.delivery.kind === "emanation") {
      out.delivery.kind = "emanation";
    }
    took.push(`its ${bookFacts.delivery.template.size ?? ""} foot `
      + `${bookFacts.delivery.template.type ?? "area"}`.replace(/\s+/g, " "));
  }
  if (out.delivery.rangeFt == null && bookFacts.delivery.rangeFt != null) {
    out.delivery.rangeFt = bookFacts.delivery.rangeFt;
    took.push(`its ${bookFacts.delivery.rangeFt} foot range`);
  }
  // What it does.
  if (!out.change.heals && bookFacts.change.heals) {
    out.change.heals = true;
    took.push("that it heals");
  }
  if (!out.change.healing && bookFacts.change.healing) {
    out.change.healing = bookFacts.change.healing;
    took.push(`its healing of ${bookFacts.change.healing.formula}`);
  }
  if (!out.change.damage.length && bookFacts.change.damage.length) {
    out.change.damage = bookFacts.change.damage;
    out.change.damageTypes = bookFacts.change.damageTypes;
    took.push(`its damage of ${bookFacts.change.damage.map(d => d.formula).join(" + ")}`);
  }
  // How it is decided.
  if (out.resolution.kind !== "save" && out.resolution.kind !== "attack"
      && (bookFacts.resolution.kind === "save" || bookFacts.resolution.kind === "attack")) {
    out.resolution = { ...bookFacts.resolution };
    took.push(bookFacts.resolution.kind === "save"
      ? `that it calls for a ${String(bookFacts.resolution.saveAbility ?? "").toUpperCase()} save`
      : "that it is an attack roll");
  }
  // How many, and for how long.
  if ((out.scope.count == null || out.scope.count <= 1) && (bookFacts.scope.count ?? 0) > 1) {
    out.scope.count = bookFacts.scope.count;
    out.scope.kind = bookFacts.scope.kind;
    took.push(`that it reaches ${bookFacts.scope.count} creatures`);
  }
  if (!out.duration.concentration && bookFacts.duration.concentration) {
    out.duration.concentration = true;
    took.push("that it needs concentration");
  }

  if (took.length) {
    why.push(`his copy did not say ${took.join(", ")}, so the `
      + `book entry was used for that`);
  }
  out.evidence = why;
  out.usedBook = took.length > 0;
  out.bookFilled = took;
  return out;
}

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
export function classifyItem(item, { parsed = null, timing = null, facts = null,
                                     book = null } = {}) {
  const mine = facts ?? readActionFacts(item, { parsed });
  const f = book ? fillFromBook(mine, book) : mine;
  const why = [...(f.evidence ?? [])];
  let assumed = false;

  try {
    if (!f.readable) return { shape: null, confidence: "low", evidence: why, facts: f };

    let shape = null;
    const { trigger, scope, delivery, resolution, change, duration, interference,
            cost } = f;

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

    // ── HEALING THAT COVERS GROUND ───────────────────────────────────────
    // ⚠️🔴 BOTH OF THESE USED TO FALL PAST EVERYTHING AND LAND WRONG.
    //
    // An emanation that heals hit the "self" branch below, because that branch
    // takes ANY emanation, and it sits above the healing check. So Aura of
    // Vitality — which is 30 feet of healing that follows the caster — was read
    // as a spell that acts only on the caster.
    //
    // And a template that heals was excluded from the area branch by its own
    // `!change.heals` guard, correctly, since healing is not an area attack —
    // but nothing caught it afterwards, so Mass Cure Wounds became a plain
    // "multi-heal" with its 30-foot sphere thrown away.
    //
    // ⚠️ THE EMANATION TEST COMES FIRST AND NEEDS BOTH HALVES. Second Wind
    // heals and is self-ranged, and it is not an emanation: it has no radius.
    // `delivery.kind` is only "emanation" when there is a template AND the
    // range is self, which is exactly the distinction.
    } else if (change.heals && delivery.kind === "emanation") {
      shape = "emanation-heal";
      why.push(`it radiates healing ${delivery.template?.size ?? ""} feet from the caster `
        + `and moves with them`.replace(/\s+/g, " "));

    } else if (change.heals && delivery.template) {
      shape = "template-heal";
      why.push(`it heals the creatures inside a ${delivery.template.size ?? ""} foot `
        + `${delivery.template.type ?? "area"} it places`.replace(/\s+/g, " "));

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
    // ⚠️🔴 A CORRECT SHAPE WITH NOTHING IN IT IS STILL A DEAD BUTTON. The
    // entry is what the resolver actually runs on. An emanation heal that
    // arrives without a radius has no aura to draw and nobody to offer, and a
    // template heal without dice rolls nothing — both would look like the shape
    // worked and the spell did not, which is the hardest kind of failure to see.
    if (delivery.template?.size != null) {
      if (shape === "emanation-heal") {
        entry.emanation = { radiusFt: delivery.template.size,
                            cost: cost?.action === "bonus" ? "bonus action" : "action" };
      } else {
        entry.expectedArea = { type: delivery.template.type ?? "sphere",
                               size: delivery.template.size };
      }
    }
    if (change.healing?.formula) {
      const dice = change.healing.formula;
      entry.heal = { formula: () => dice };
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
