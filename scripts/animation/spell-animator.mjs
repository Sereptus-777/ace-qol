// ─── Playing the curated animation for a picker-resolved spell ──────────────
//
// See autorec.mjs for why this exists. Short version: a spell ACE resolves with
// a target PICKER never creates a template, and Automated Animations' entry for
// it is often a `templatefx`, which needs one. Colour Spray was curated, correct,
// and invisible.
//
// ⚠️ ONE SYSTEM OWNS EACH CAST, DECIDED BEFORE EITHER FIRES. Two animations for
// one spell is worse than none. If the SHAPE actually creates a template,
// Automated Animations owns it and ACE plays nothing; otherwise ACE plays. The
// decision is made once, in `whoOwnsThisCast`, and both callers read it.
// (It reads the shape, not the item. See the note on TEMPLATE_SHAPES for why
// reading the item got this exactly backwards on the first attempt.)
//
// ⚠️ ONE SOUND FOR THE SOURCE AND ONE FOR THE PRIMARY. Johnny's rule, and the
// reason a curated record's sound `repeat` is read and then ignored.
//
// ⚠️ IT NEVER STOPS A SPELL. Every failure path here logs and returns; a missing
// animation must never be the reason a Colour Spray does not blind anybody.
const MODULE_ID = "ace-qol";

import { animationFor } from "./autorec.mjs";

/**
 * Shapes whose resolution actually PUTS A TEMPLATE ON THE MAP.
 *
 * ⚠️🔴 THE QUESTION IS WHAT THE CAST CREATES, NOT WHAT THE ITEM DECLARES,
 * AND I GOT THIS BACKWARDS FIRST. His Colour Spray DOES declare a 15 foot cone
 * on its sheet - `target.template.type: "cone"` - so a check that read the item
 * concluded "Automated Animations owns this" and changed nothing at all.
 *
 * But ACE resolves Colour Spray as `multi-buff`, RAW, because it is a 6d10
 * hit-point pool where the GM picks who drops rather than a saving throw. The
 * picker path never creates a MeasuredTemplate. AA’s entry for it is a
 * `templatefx`, which fires on template CREATION. Declared but never created is
 * exactly the gap the animation fell into.
 *
 * So: the SHAPE decides, because the shape is what determines whether a template
 * is ever made.
 */
// ⚠️ `template-pool` BELONGS HERE, AND LEAVING IT OUT WOULD PLAY THE ANIMATION
// TWICE. Colour Spray now draws its cone again, so Automated Animations sees a
// real template and animates it the way it always meant to. If ACE also played
// the borrowed copy, one cast would fire two cones and two sounds — which is
// worse than the silence this whole thread started with.
const TEMPLATE_SHAPES = new Set(["template-save", "template-trigger", "template-pool"]);

/**
 * Which system should animate this cast?
 *
 * ⚠️ DECIDED ONCE, BEFORE EITHER FIRES. Two animations for one spell is
 * worse than none.
 *
 * @param {Item}   item
 * @param {object} [entry] the pipeline entry, curated or worked out
 * @returns {"automated-animations"|"ace"}
 */
export function whoOwnsThisCast(item, entry = null) {
  try {
    const shape = String(entry?.shape ?? "");
    if (TEMPLATE_SHAPES.has(shape)) return "automated-animations";
    if (shape) return "ace";

    // No entry at all means the pipeline is not driving this cast, so dnd5e runs
    // it normally and Automated Animations sees it the way it always has.
    return "automated-animations";
  } catch (_) {
    // ⚠️ Unknown errs towards AA, which risks playing NOTHING rather than
    // playing twice. Silence is recoverable; a double is what he notices.
    return "automated-animations";
  }
}

/**
 * Play the curated animation for a picker-resolved spell.
 *
 * @param {object} p
 * @param {Token}  p.casterToken
 * @param {Item}   p.item
 * @param {Token[]} [p.targets]  resolved targets, for a caster-to-target throw
 * @returns {Promise<boolean>} whether anything played
 */
export async function playCuratedAnimation({ casterToken, item, targets = [] } = {}) {
  try {
    if (!casterToken || !item) return false;
    // ⚠️🔴 `Sequence` IS THE CONSTRUCTOR. `Sequencer` IS THE NAMESPACE.
    // This checked `typeof Sequencer` and then called `new Sequencer.Sequence()`,
    // so the guard passed (the namespace exists, it holds Database) and the very
    // next line threw "Sequencer.Sequence is not a constructor" on every cast.
    // Magic Missile resolved its curated animation correctly and then died one
    // line later. Every other file in the suite already used `new Sequence()`.
    //
    // Guard on the thing actually being called, never on its neighbour.
    if (typeof Sequence === "undefined") {
      console.warn(`${MODULE_ID} | Sequencer is not available, so "${item.name}" `
        + `cannot be animated by ACE.`);
      return false;
    }

    const anim = animationFor(item);
    if (!anim) {
      // ⚠️ SAY WHICH OF THE TWO IT IS. "Nobody curated this spell" and "the path
      // they curated does not exist in the installed library" are different
      // problems with different fixes, and one message for both hides that.
      console.log(`${MODULE_ID} | no curated animation resolves for "${item.name}" `
        + `(either Automated Animations has no entry for it, or the one it has `
        + `points at an asset this JB2A install does not contain).`);
      return false;
    }

    const o = anim.options;
    const seq = new Sequence();

    // ── The sound: one, at the source ─────────────────────────────────────
    if (anim.sound?.file) {
      seq.sound()
        .file(anim.sound.file)
        .volume(anim.sound.volume)
        .delay(anim.sound.delay);
    }

    const aim = targets.filter(Boolean);

    // ── The primary effect ────────────────────────────────────────────────
    // A ranged or melee record is a throw from the caster at somebody. Anything
    // else lands on the caster's own square, which is right for a cone, a burst
    // and an aura alike.
    const isThrown = (anim.category === "range" || anim.category === "melee") && aim.length;

    if (isThrown) {
      for (const t of aim) {
        const e = seq.effect().file(anim.path).atLocation(casterToken).stretchTo(t);
        _applyOptions(e, o);
      }
    } else {
      const e = seq.effect().file(anim.path).atLocation(casterToken);
      // ⚠️ A CONE MUST POINT WHERE HE AIMED IT. Rotating only when there is
      // exactly one target left Colour Spray - which blinds a whole group -
      // firing due east no matter where the group was standing, which reads as
      // broken far more loudly than no animation at all. Aim at the middle of
      // everyone caught.
      if (aim.length === 1) {
        try { e.rotateTowards(aim[0]); } catch (_) {}
      } else if (aim.length > 1) {
        try {
          const pts = aim.map(t => t.center ?? { x: t.x, y: t.y }).filter(p => Number.isFinite(p?.x));
          if (pts.length) {
            e.rotateTowards({
              x: pts.reduce((s, p) => s + p.x, 0) / pts.length,
              y: pts.reduce((s, p) => s + p.y, 0) / pts.length,
            });
          }
        } catch (_) { /* an un-rotated cone still beats no cone */ }
      }
      _applyOptions(e, o);
    }

    // ── The secondary, when the curator asked for one ─────────────────────
    if (anim.secondary && aim.length) {
      for (const t of aim) {
        const e = seq.effect().file(anim.secondary).atLocation(t).scale(o.scale);
        if (o.tint) { try { e.tint(o.tint); } catch (_) {} }
      }
    }

    await seq.play();
    console.log(`${MODULE_ID} | played the curated animation for "${item.name}" `
      + `(${anim.category}: ${anim.path})`);
    return true;
  } catch (err) {
    console.warn(`${MODULE_ID} | the animation for "${item?.name}" failed `
      + `(the spell itself is unaffected):`, err);
    return false;
  }
}

/** Apply the curator's own options to one effect. */
function _applyOptions(e, o) {
  try {
    if (o.scale && o.scale !== 1) e.scale(o.scale);
    if (o.opacity && o.opacity !== 1) e.opacity(o.opacity);
    if (o.playbackRate && o.playbackRate !== 1) e.playbackRate(o.playbackRate);
    if (o.delay) e.delay(o.delay);
    if (o.rotate) e.rotate(o.rotate);
    if (o.tint) e.tint(o.tint);
    if (o.elevation) e.elevation(o.elevation);
    if (o.zIndex && o.zIndex !== 1) e.zIndex(o.zIndex);
    // ⚠️ PERSISTENT IS DELIBERATELY NOT HONOURED HERE. A persistent effect from
    // AA is attached to a template it manages and removes with that template.
    // ACE is animating a cast that has NO template, so a persistent effect would
    // be left on the canvas with nothing that ever cleans it up.
  } catch (err) {
    console.warn(`${MODULE_ID} | some animation options could not be applied:`, err);
  }
}
