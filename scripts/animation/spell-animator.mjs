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
// ⚠️ Read inside a function, never at load: both of these sit in import cycles
// through the entry file, and a top-level read of one is how a module dies on
// the way in (2026-08-28, again 2026-09-06).
import { aceDrawsOnBody, LEFT_TO_JB2A } from "../condition-visuals.mjs";
import { spellKey } from "../rules/spell-name.mjs";
import { conditionStatuses } from "../condition-library.mjs";
// The cast flourish, for the one kind of spell that has no other picture at the cast.
import { AceFX, DAMAGE_THEME } from "../ace-fx.mjs";

/* ── ACE DRAWS THE CONDITION. NOBODY ELSE PAINTS IT ON THE TOKEN ─────────────
 *
 * His table, 2026-09-30: *"spell-animator does not play a JB2A condition clip
 * for Charm Person. ACE already draws the hearts. Cast flourish is fine.
 * On-token condition is not."* And again, 2026-10-11: *"Charm Person, and any
 * spell whose only clip is a condition badge, still gets a flourish at the
 * cast... The flourish is not that badge. Do not put the ring back on a spell
 * that already has its own clip."* So the flourish plays HERE, in place of the
 * refused badge, and nowhere else (ace-fx.mjs no longer fires on its own).
 *
 * ⚠️🔴 AND FOR CHARM PERSON THE SEPTEMBER 30 NOTE IS WRONG (his rule,
 * 2026-10-12: "He wants the JB2A hearts going around the token. He does not want
 * the hearts ACE draws on the body. Play the JB2A clip."). ACE no longer draws
 * charmed (condition-visuals.mjs, LEFT_TO_JB2A), so its badge is not refused
 * here and plays at the cast, and Charm Person gets no flourish: it has its own
 * clip. The rule below still holds for every condition ACE does draw.
 *
 * Automated Animations' curated record for Charm Person is
 * `jb2a.condition.boon.01.014.red` — a looping badge that sits ON the creature,
 * which is the same job as ACE's drifting hearts. Borrowing AA's choice, which
 * is the whole point of this file, borrowed that too, so a second caster's charm
 * put a red JB2A ring on Escher beside the pink coat ACE had already drawn.
 *
 * So the record's own asset family decides: the `condition` family is the
 * on-token picture, and ACE draws every condition in BODY_VISUAL_STATUSES on the
 * body. When the spell's landing condition is one of those, ACE's drawing is the
 * clip and the borrowed copy is not played.
 *
 * ⚠️ AND ONLY THEN. A condition asset curated for something ACE does NOT draw
 * (Bless, Bane, a buff with no status of its own) still plays, because refusing
 * it would leave that spell with no picture at all.
 */
function aceAlreadyDrawsThis(entry, path) {
  try {
    if (!/(^|[.\-_/])condition([.\-_/]|$)/i.test(String(path ?? ""))) return null;
    const key = String(entry?.effect?.key ?? "").toLowerCase().trim();
    if (!key) return null;
    // Only what ACE draws itself. Charmed is the JB2A hearts (2026-10-12).
    const drawn = conditionStatuses(key).filter(s => aceDrawsOnBody(s));
    return drawn.length ? drawn : null;
  } catch (_) {
    return null;     // unreadable: play it, rather than silently play nothing
  }
}

/* ── AND AUTOMATED ANIMATIONS IS TOLD, NOT JUST OUT-VOTED ────────────────────
 *
 * ⚠️🔴 THIS FILE DECIDED WHO OWNS A CAST AND THEN NEVER TOLD THE OTHER SIDE.
 * `whoOwnsThisCast` picks ACE or AA and both CALLERS read it — but AA has its own
 * trigger on the item's use, which nothing here has ever stood down. So there are
 * three roads a JB2A condition badge can reach the token by, and his rule needed
 * all three shut:
 *
 *   1  ACE playing AA's record itself          → refused above (0.67.0)
 *   2  AA playing off the EFFECT created       → switched off on the effect (0.66.0)
 *   3  AA playing off the ITEM at cast time    → this, the one still open
 *
 * Narrow on purpose: AA is stood down only for a cast whose curated record is an
 * on-token picture of a condition ACE draws itself. Every other cast is AA's as
 * it always was, because standing AA down for a spell ACE has no picture for
 * would leave the table with nothing.
 */
export function registerAaStandDown() {
  Hooks.on("AutomatedAnimations-WorkflowStart", (data) => {
    try {
      const subject = data?.item ?? null;
      if (!subject) return;

      // ── 1. AA PLAYING A CONDITION OFF ITS EFFECT ────────────────────────
      //
      // ⚠️🔴 THIS IS THE ROAD 0.67.0 MISSED, AND IT IS THE ONE HE SAW. AA's
      // `createActiveEffects` calls `AAHandler.make({ item: effect,
      // activeEffect: true })`, so on this hook `data.item` is an ACTIVE EFFECT,
      // not an item. The old code asked the spell registry for an entry, got
      // null for an effect, and returned — so AA went on to play
      // `static conditions heart pink` on the token beside ACE's own hearts.
      //
      // Now: an effect that puts on a condition ACE draws gets no AA picture at
      // all, whoever created it and whatever record AA chose for it. Bless and
      // Bane carry no body-visual status, so they are untouched, which is his
      // rule for them.
      if (data?.activeEffect === true || subject?.documentName === "ActiveEffect") {
        const statuses = [...(subject.statuses ?? [])].map(s => String(s).toLowerCase());
        // ⚠️🔴 CHARMED IS AA'S OWN CLIP NOW (his rule, 2026-10-12: "He wants the
        // JB2A hearts going around the token."): only what ACE draws stands AA down.
        const drawn = statuses.filter(s => aceDrawsOnBody(s));
        if (!drawn.length) {
          // One clip on the token however many sources (his rule, 2026-09-30): a
          // creature already charmed by another effect gets no second one.
          const jb2a = statuses.filter(s => LEFT_TO_JB2A.has(s));
          const others = (subject.parent?.effects?.contents ?? []).filter(e => e.id !== subject.id && !e.disabled);
          if (!jb2a.length || !others.some(e => jb2a.some(s => e.statuses?.has?.(s)))) return;
          data.stopWorkflow = true;
          console.log(`${MODULE_ID} | Automated Animations stands down for "${subject.name ?? subject.label}": `
            + `${subject.parent?.name ?? "this creature"} is already ${jb2a.join(", ")} and has its clip.`);
          return;
        }
        data.stopWorkflow = true;
        console.log(`${MODULE_ID} | Automated Animations stands down for the effect `
          + `"${subject.name ?? subject.label}": it puts on ${drawn.join(", ")}, which ACE draws on `
          + `the body. One clip on the token, however many sources put it there.`);
        return;
      }

      const entry = globalThis.game?.aceQol?.SpellPipeline?._getEntry?.(subject) ?? null;
      if (!entry) return;

      // ── 2. A CAST ACE OWNS: AUTOMATED ANIMATIONS IS ACTUALLY STOPPED ────
      //
      // ⚠️🔴 THE OWNER WAS DECIDED AND THE OTHER SIDE WAS NEVER TOLD (his rule,
      // 2026-10-11: "ACE only stands it down for a condition badge, so a heal and
      // a save spell get AA's clip and ACE's clip. One owner per cast, decided
      // before either plays, and the other one is actually stopped."). AA plays a
      // heal or a damaging spell when its dice are rolled (its dnd5e.rollDamageV2
      // hook), so Cure Wounds' heal roll played AA's clip and then ACE played its
      // own. The same answer both sides read, whoOwnsThisCast, stops AA here for
      // every workflow of a cast ACE owns: the use, the attack and the damage.
      if (whoOwnsThisCast(subject, entry) === "ace") {
        data.stopWorkflow = true;
        console.log(`${MODULE_ID} | Automated Animations stands down for "${subject.name}": ACE owns `
          + `this cast and plays its one clip at the cast. One owner, one clip, one sound.`);
        return;
      }

      // ── 3. AA PLAYING A CONDITION BADGE OFF THE ITEM'S USE ──────────────
      const anim = animationFor(subject);
      const drawn = aceAlreadyDrawsThis(entry, anim?.path);
      if (!drawn) return;
      data.stopWorkflow = true;
      console.log(`${MODULE_ID} | Automated Animations stands down for "${subject.name}": its record `
        + `is an on-token condition badge (${anim.path}) and ACE draws ${drawn.join(", ")} on the `
        + `body itself. One picture of a condition, not two.`);
    } catch (err) {
      console.warn(`${MODULE_ID} | could not stand Automated Animations down for a condition `
        + `badge, so it may play one:`, err);
    }
  });
  console.debug(`${MODULE_ID} | ACE draws its own conditions; AA's badge for one of them is `
    + `stood down, on the effect and on the cast.`);
}

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

/** The JB2A condition family: a badge that sits on the creature. */
const CONDITION_FAMILY = /(^|[.\-_/])condition([.\-_/]|$)/i;

/* ⚠️🔴 ACE'S OWN LOOKS, BY SPELL (his rule, 2026-10-12: "Frostbite plays the
   silhouette you drew, on the target, inside its square... The clip that plays
   is the Frostbite silhouette made for this spell, the one that is yours."). The
   frost crust masked to the creature's own picture was made for Frostbite in
   June (ace-fx.mjs); it lost its trigger when the save-time crust went, and with
   it Frostbite's picture. A look here is that spell's clip, played at the cast
   on each target. The borrowed record, if there is one, still plays with it,
   fitted to the target's square. Keyed by the spell's name, its edition suffix
   taken off. */
const ACE_LOOKS = Object.freeze({
  frostbite: { silhouette: "cold" },
});

/** ACE's own look for this spell, or null. */
export function aceLookFor(item) {
  try { return ACE_LOOKS[spellKey(item?.name)] ?? null; } catch (_) { return null; }
}

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
    // ⚠️ ACE OWNS A CAST ONLY WHEN IT HAS THE CLIP TO PLAY (2026-10-11). Owning
    // means Automated Animations is stopped, and stopping it for a spell ACE has
    // no clip for would leave the table with nothing.
    // A spell with ACE's own look is ACE's, record or none (2026-10-12).
    if (shape) return (animationFor(item) || aceLookFor(item)) ? "ace" : "automated-animations";

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
export async function playCuratedAnimation({ casterToken, item, targets = [], entry = null } = {}) {
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
    const look = aceLookFor(item);
    const aimed = targets.filter(Boolean);
    // ACE's own look, on every target, at the cast (the frost silhouette).
    const playLook = () => {
      if (!look?.silhouette) return false;
      let any = false;
      for (const t of aimed) any = AceFX.silhouetteBroadcast(t, DAMAGE_THEME[look.silhouette]) || any;
      if (any) console.log(`${MODULE_ID} | "${item.name}" plays ACE's own ${look.silhouette} silhouette `
        + `on ${aimed.map(t => t.name).join(", ")}, inside each one's square.`);
      return any;
    };
    if (!anim && look) {
      console.log(`${MODULE_ID} | "${item.name}" has no Automated Animations record; ACE's own look is its clip.`);
      return playLook();
    }
    if (!anim) {
      // ⚠️ SAY WHICH OF THE TWO IT IS. "Nobody curated this spell" and "the path
      // they curated does not exist in the installed library" are different
      // problems with different fixes, and one message for both hides that.
      console.log(`${MODULE_ID} | no curated animation resolves for "${item.name}" `
        + `(either Automated Animations has no entry for it, or the one it has `
        + `points at an asset this JB2A install does not contain).`);
      return false;
    }

    // ── ACE ALREADY DRAWS THIS ONE ────────────────────────────────────────
    const drawn = aceAlreadyDrawsThis(entry, anim.path);
    if (drawn) {
      console.log(`${MODULE_ID} | the curated record for "${item.name}" is an on-token condition `
        + `clip (${anim.path}), and ACE draws ${drawn.join(", ")} on the body itself. It is not `
        + `played here: one picture of a condition, not two. The cast flourish plays instead.`);
      return AceFX.castFlourish(casterToken, item);
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
    // ⚠️🔴 AN ON-TOKEN RECORD LANDS ON THE TARGET (his table, 2026-10-11: Cure
    // Wounds' second clip "lands off the target and it has its own sound"). Its
    // record is AA's "ontoken" kind, which AA plays on the creature it is about;
    // this played every non-throw on the caster's own square.
    const onTarget = anim.category === "ontoken" && aim.length;
    /* ⚠️🔴 A CLIP THAT BELONGS ON THE CREATURE IS FITTED TO ITS SQUARE (his rule,
       2026-10-12: "If the ice disk is still in the sequence, it is the same size
       as the target's square and it does not hang outside it. It is never 30
       feet."). Played at its own size, Frostbite's impact was a 30-foot disk and
       Charm Person's hearts would be the same. A spell with ACE's own look, a
       record its curator masked to the token, and a condition clip are fitted:
       scaled to the token by the record's size and masked to it when asked.
       Every other on-token record plays as it always has. */
    const fitted = onTarget && (!!look || !!o.masked || CONDITION_FAMILY.test(String(anim.path ?? "")));

    if (onTarget) {
      for (const t of aim) {
        const e = seq.effect().file(anim.path).atLocation(t);
        _applyOptions(e, o, fitted ? t : null);
      }
    } else if (isThrown) {
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
        const e = seq.effect().file(anim.secondary).atLocation(t);
        if (fitted) { try { e.scaleToObject(o.size || 1); } catch (_) { e.scale(o.scale); } }
        else e.scale(o.scale);
        if (o.tint) { try { e.tint(o.tint); } catch (_) {} }
      }
    }

    await seq.play();
    console.log(`${MODULE_ID} | played the curated animation for "${item.name}" `
      + `(${anim.category}: ${anim.path}${fitted ? ", fitted to each target's square" : ""})`);
    playLook();
    return true;
  } catch (err) {
    console.warn(`${MODULE_ID} | the animation for "${item?.name}" failed `
      + `(the spell itself is unaffected):`, err);
    return false;
  }
}

/**
 * Apply the curator's own options to one effect.
 * @param {Token|null} [fitTo]  fit it to this creature's square instead of its own size
 */
function _applyOptions(e, o, fitTo = null) {
  try {
    if (fitTo) {
      e.scaleToObject(o.size || 1);
      if (o.masked) e.mask(fitTo);
    } else if (o.scale && o.scale !== 1) e.scale(o.scale);
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
