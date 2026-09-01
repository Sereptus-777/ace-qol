// ─── Borrowing 1,293 human-picked animations ────────────────────────────────
//
// Johnny, 2026-08-28: "this is where Chris' pre-mades and JB2A itself are
// invaluable. I trust that they picked the right animation because they're
// humans. Get the animation references from them on my JB2A library. I just cast
// Color Spray, and it didn't have anything."
//
// ⚠️🔴 WHY COLOR SPRAY PLAYED NOTHING, AND IT IS NOT A MISSING ANIMATION.
// His Automated Animations database DOES have Color Spray, curated, pointing at
// a cone breath-weapon in multi-colour. It is filed under `templatefx`, which is
// the category that fires when a MEASURED TEMPLATE is created.
//
// ACE resolves Color Spray as `multi-buff` — RAW, because it is a 6d10 hit-point
// pool where the GM picks who drops, not a save. That is correct, and it means
// no cone template is ever placed. AA is called, finds only a template entry,
// has no template to hang it on, and plays nothing. Nothing is broken. The
// animation simply had nothing to attach to.
//
// ⚠️ SO THIS IS NOT A SECOND ANIMATION SYSTEM. Every spell ACE resolves with a
// TEMPLATE keeps using Automated Animations exactly as it does today. This only
// covers the ones ACE resolves with a PICKER, which AA cannot reach — and it
// uses AA's OWN curated choices to do it, so the picture is identical either way.
//
// ⚠️ AND IT NEVER DOUBLE-PLAYS. Two animations for one cast is worse than none:
// Johnny's standing rule is one sound for the source and one for the primary,
// and anything more is too many. The caller decides which system owns the cast,
// once, before either fires.
//
// ⚠️ IT READS HIS LIVE DATABASE, NOT A COPY. Baking 1,293 paths into ACE would
// go stale the moment he edits one, and would ship somebody else's curation
// inside our module. This reads what is installed on his machine, so his edits
// win and nothing of theirs is redistributed.
//
// HOW A PATH IS BUILT. Records carry either an explicit `customPath`
// (376 of 1,293) or AA's menu choices, which AA itself resolves as
// `autoanimations.{section}.{menuType}.{animation}.{variant}.{color}` and
// registers into Sequencer's database. Both end up as a Sequencer database key.

const AA_MODULE = "autoanimations";

/** The six categories AA keeps, in the order worth searching for a picker cast. */
const CATEGORIES = ["ontoken", "range", "melee", "templatefx", "aefx", "preset"];

const _norm = (s) => String(s ?? "").toLowerCase()
  .replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();

/** name -> {record, category}, built once per session. */
let _index = null;

/**
 * Read every curated record out of Automated Animations' own settings.
 *
 * ⚠️ THE SETTINGS ARE JSON STRINGS, NOT OBJECTS. Reading them as objects yields
 * an empty list and looks exactly like "he has no animations configured", which
 * is a believable lie about his setup.
 */
export function buildIndex({ force = false } = {}) {
  if (_index && !force) return _index;
  const index = new Map();
  let read = 0, failed = 0;

  for (const cat of CATEGORIES) {
    let rows = [];
    try {
      const raw = game.settings.get(AA_MODULE, `aaAutorec-${cat}`);
      const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
      rows = Array.isArray(parsed) ? parsed : Object.values(parsed ?? {});
    } catch (err) {
      failed++;
      // ⚠️ "COULD NOT READ IT" IS NOT "THERE ARE NONE". Said out loud, because
      // silence here would read as a GM who never configured any animations.
      console.warn(`ace-qol | could not read Automated Animations' "${cat}" list; `
        + `spells in that category will not animate through ACE:`, err);
      continue;
    }
    for (const rec of rows) {
      const key = _norm(rec?.label);
      if (!key) continue;
      read++;
      // First category wins: CATEGORIES is ordered so the entries meant for a
      // creature-to-creature cast are preferred over the template ones.
      if (!index.has(key)) index.set(key, { record: rec, category: cat });
    }
  }

  _index = index;
  console.log(`ace-qol | read ${read} curated animation(s) from Automated Animations `
    + `across ${CATEGORIES.length - failed} categor(ies)`);
  return _index;
}

/** Forget the index, so an edit in AA's own menus is picked up. */
export function invalidate() { _index = null; }

/**
 * The Sequencer database key for one record's primary video, or null.
 *
 * ⚠️ IT VERIFIES THE KEY EXISTS. A path built from menu choices that Sequencer
 * does not know produces a silent no-op inside Sequencer, which is the same
 * invisible failure as playing nothing at all. Better to return null and let the
 * caller say why.
 */
export function pathFor(video) {
  try {
    if (!video) return null;
    if (video.customPath) return video.customPath;

    const { dbSection, menuType, animation, variant, color } = video;
    if (!dbSection || !animation) return null;

    // AA's own construction, from its bundle:
    //   autoanimations.{section}.{menuType}.{animation}.{variant}[.{color}]
    const withColor = ["autoanimations", dbSection, menuType, animation, variant, color]
      .filter(Boolean).join(".");
    const withoutColor = ["autoanimations", dbSection, menuType, animation, variant]
      .filter(Boolean).join(".");

    for (const candidate of [withColor, withoutColor]) {
      try {
        if (Sequencer?.Database?.entryExists?.(candidate)) return candidate;
      } catch (_) { /* fall through to the next candidate */ }
    }

    // ⚠️🔴 THE CURATED COLOUR OFTEN DOES NOT EXIST, AND THAT KILLED MAGIC MISSILE.
    // His record asks for `magicmissile / 01 / purple`. JB2A ships Magic Missile
    // in blue and darkred only. The key never resolved, so one of the most basic
    // spells in the game played nothing at all, silently.
    //
    // JB2A does not ship every colour for every animation, and an autorec record
    // can outlive the pack it was picked against. Asking Sequencer what actually
    // exists under the parent is the difference between the right animation in
    // the wrong colour and no animation whatsoever.
    try {
      const parent = ["autoanimations", dbSection, menuType, animation, variant]
        .filter(Boolean).join(".");
      const under = Sequencer?.Database?.getPathsUnder?.(parent) ?? [];
      if (under.length) {
        const pick = `${parent}.${under[0]}`;
        console.warn(`ace-qol | "${animation}" has no "${color}" in this JB2A install `
          + `(it has ${under.join(", ")}). Using ${under[0]} rather than playing nothing.`);
        return pick;
      }
    } catch (_) { /* nothing under it either; fall through and say so */ }

    return null;
  } catch (err) {
    console.warn("ace-qol | could not work out an animation path:", err);
    return null;
  }
}

/**
 * Everything ACE needs to play the curated animation for one item.
 *
 * @param {Item|object} item
 * @returns {{path, sound, options, category, label, secondary}|null}
 */
export function animationFor(item) {
  try {
    const hit = buildIndex().get(_norm(item?.name));
    if (!hit) return null;

    const rec = hit.record;
    const path = pathFor(rec.primary?.video);
    if (!path) return null;

    const s = rec.primary?.sound;
    const opt = rec.primary?.options ?? {};

    // ⚠️ ONE SOUND FOR THE SOURCE, ONE FOR THE PRIMARY, AND NO MORE. His rule,
    // stated 2026-08-27: "if it plays anything other than that, then it's too
    // many." AA records can carry a repeat count on their sound; it is read and
    // deliberately capped.
    const sound = s?.enable
      ? { file: s.file, volume: Number(s.volume ?? 0.75) || 0.75,
          delay: Number(s.delay ?? 0) || 0 }
      : null;

    const sec = rec.secondary?.enable ? pathFor(rec.secondary.video) : null;

    return {
      label: rec.label,
      category: hit.category,
      path,
      sound,
      secondary: sec,
      options: {
        scale:        Number(opt.scale ?? 1) || 1,
        opacity:      Number(opt.opacity ?? 1) || 1,
        playbackRate: Number(opt.playbackRate ?? 1) || 1,
        delay:        Number(opt.delay ?? 0) || 0,
        rotate:       Number(opt.rotate ?? 0) || 0,
        tint:         opt.tint ? opt.tintColor : null,
        persistent:   !!opt.persistent,
        elevation:    Number(opt.elevation ?? 0) || 0,
        zIndex:       Number(opt.zIndex ?? 1) || 1,
      },
    };
  } catch (err) {
    console.warn(`ace-qol | could not find a curated animation for "${item?.name}":`, err);
    return null;
  }
}

/**
 * Why is this spell not animating? Answered in plain English, at the console.
 *
 * ⚠️ THREE DIFFERENT PROBLEMS WITH THREE DIFFERENT FIXES, and one silent
 * failure for all of them is what made Colour Spray take an evening to explain.
 * Nobody curated it, the curated path is not in this JB2A install, or ACE never
 * asked because a template already owns the cast.
 */
export function whyNoAnimation(item) {
  const out = [];
  try {
    const key = _norm(item?.name);
    const hit = buildIndex().get(key);
    if (!hit) {
      out.push(`Automated Animations has no entry called "${item?.name}". `
        + `Nobody has curated one, so there is nothing for ACE to borrow.`);
      return _say(out);
    }
    out.push(`Automated Animations has it, filed under "${hit.category}".`);

    const v = hit.record.primary?.video ?? {};
    if (v.customPath) {
      out.push(`It points straight at "${v.customPath}".`);
    } else {
      out.push(`It is built from menu choices: `
        + [v.dbSection, v.menuType, v.animation, v.variant, v.color].filter(Boolean).join(" / ") + ".");
    }

    const path = pathFor(v);
    if (!path) {
      out.push(`That asset is NOT in this JB2A install, so nothing can play. `
        + `Either the library is missing that pack, or the curated choice is stale.`);
      return _say(out);
    }
    out.push(`It resolves to "${path}", which this install does contain.`);

    const entry = game.aceQol?.SpellPipeline?._getEntry?.(item);
    const shape = entry?.shape ?? null;
    if (!shape) {
      out.push(`ACE has no plan for this item, so dnd5e runs it and Automated `
        + `Animations animates it the way it always has. ACE stays out of it.`);
    } else if (shape === "template-save" || shape === "template-trigger") {
      out.push(`ACE resolves it as "${shape}", which puts a real template on the `
        + `map, so Automated Animations owns the animation and ACE plays nothing. `
        + `If you see none, the problem is in AA rather than in ACE.`);
    } else {
      out.push(`ACE resolves it as "${shape}", which uses a target picker and `
        + `creates no template — so ACE plays this one itself.`);
    }
    return _say(out);
  } catch (err) {
    out.push(`could not be checked: ${err?.message ?? err}`);
    return _say(out);
  }
}

function _say(lines) {
  for (const l of lines) console.log("ace-qol | " + l);
  return lines;
}

/** Counts, for the boot line and for answering "does it know this spell". */
export function summary() {
  try {
    const idx = buildIndex();
    return { total: idx.size };
  } catch (_) { return { total: 0 }; }
}
