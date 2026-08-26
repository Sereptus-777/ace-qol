// ─── ACE: QOL — How far does this weapon reach? One answer, one reader ────────
//
// ⚠️🔴 WHY THIS FILE EXISTS. On 2026-08-25 I gave the attacker profile its own
// reach reader — a naive one that read the range slot and stopped. The attack
// pipeline already had a proper resolver that checks the activity, checks the
// item, falls back to the statblock text, honours the reach property, and
// converts metric. Two readers means the profile and the pipeline can disagree
// about how far a Spiked Chain reaches, and the day they do, the console line
// says one number while the range check uses another. That is worse than no
// profile at all, because the log becomes a liar.
//
// Johnny, 2026-08-25: "Put the reach resolver also on the attacker profile."
// So the resolver moved HERE, and both call it. There is one answer.
//
// ⚠️ IT ALSO ENDS A CIRCULAR IMPORT. `reach-repair.mjs` was importing the
// description parser out of `attack-pipeline.mjs` while the pipeline
// dynamically imported the repair back. Both now depend on this leaf instead.
//
// ⚠️ WE READ THE ITEM, NOT THE SYSTEM. Every number below comes out of the
// item's own stored data. No dnd5e helper is called, including for units —
// that conversion is arithmetic, and doing it ourselves keeps ACE free of a
// dependency it does not need.
// ──────────────────────────────────────────────────────────────────────────────

import { MODULE_ID } from "./ace-qol.mjs";

/**
 * Convert a distance to FEET, which is what the canvas measures in.
 *
 * ⚠️ D&D's metric convention is 1.5 m to 5 ft, NOT a true 3.28. Using the real
 * ratio would silently shrink every reach on a metric table.
 *
 * @returns {number} feet, or 0 for anything that is not a positive number
 */
export function toFeet(n, units) {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return 0;
  const u = String(units || "ft").toLowerCase();
  if (u === "m" || u === "meter" || u === "meters" || u === "metre" || u === "metres") return v * (5 / 1.5);
  if (u === "km") return v * 1000 * (5 / 1.5);
  if (u === "mi" || u === "mile" || u === "miles") return v * 5280;
  return v;   // ft, or an unknown unit we must not silently mangle
}

/**
 * Pull a reach out of an item's own description text.
 *
 * Every dnd5e statblock renders melee attacks as "reach 10 ft." — a fixed
 * phrase with a number after it. This looks for exactly that and nothing else.
 * It is called ONLY when the item's reach field and its activity are both
 * empty, so a well-formed item never touches this path.
 *
 * ⚠️ THE FIRST MATCH WINS, DELIBERATELY. An item whose description covers
 * several attacks (a multiattack blurb) can mention two reaches. Guessing which
 * belongs to THIS activity from prose is exactly the inference this function
 * refuses to make — the first is the best available answer and the caller says
 * out loud that it came from the description.
 *
 * @returns {number} reach in FEET, or 0 when the description says nothing
 */
export function reachFromDescription(sys, fallbackUnits, convert = toFeet) {
  try {
    const raw = String(sys?.description?.value ?? "");
    if (!raw) return 0;
    // Strip tags so "reach 10 ft." split across markup still reads as one phrase.
    const text = raw.replace(/<[^>]+>/g, " ").replace(/&nbsp;/gi, " ").replace(/\s+/g, " ");
    const m = text.match(/\breach\s+(\d+(?:\.\d+)?)\s*(ft\.?|feet|foot|m\.?|meters?|metres?)?/i);
    if (!m) return 0;
    const units = (m[2] || fallbackUnits || "ft").replace(/\.$/, "");
    return Math.round(convert(m[1], units));
  } catch (_) {
    return 0;
  }
}

/**
 * How far can this item reach, and where did that number come from?
 *
 * ⚠️ THE SOURCE IS PART OF THE ANSWER. "5 ft because the item says so" and
 * "5 ft because nothing said anything" are completely different facts, and
 * printing them the same way is how an empty data slot passed for a deliberate
 * five-foot weapon for months.
 *
 * @param {Item5e}   item             the weapon / spell / feature
 * @param {Activity} [activity]       the dnd5e activity, when there is one
 * @param {object}   [opts]
 * @param {boolean}  [opts.repair]    queue a write-back when the number had to
 *                                    come from the description (default true)
 * @returns {{reachFt:number, source:string, units:string}}
 */
export function resolveReach(item, activity = null, { repair = true } = {}) {
  const sys = item?.system ?? {};
  const range = activity?.range ?? sys.range ?? {};
  const itemRange = sys.range ?? {};
  const units = range.units || itemRange.units || "ft";
  const longRange = Number(range.long ?? 0) || 0;
  const props = sys.properties ? new Set(sys.properties) : new Set();

  // ── ⚠️🔴 MELEE REACH LIVES IN ITS OWN SLOT, AND WE WERE READING THE WRONG
  //    ONE (2026-08-23) ──────────────────────────────────────────────────────
  //
  // Johnny's Spiked Chain says "reach 10 ft." on the item, and ACE refused the
  // attack with "out of range — 10ft away (melee reach 5ft)".
  //
  // The item's range block has FOUR slots: value, long, reach, units. Melee
  // reach is in `reach`. The old code only ever read `value`, found it empty for
  // every melee weapon, and fell back to assuming five feet.
  //
  // It was not always empty. dnd5e ships a migration whose own description is
  // "migrate the range value to the reach field for melee weapons without the
  // thrown property" — so the number was MOVED out from under us and every melee
  // weapon in the world was rewritten. Nothing threw, because an empty slot and
  // a deliberate five-foot weapon look identical from here. Same class as the
  // renamed-method drift of 08-12: the platform moved something, we kept reading
  // the old place, and "nothing there" was treated as an answer instead of a
  // question.

  // 1. The weapon's own reach — the authoritative slot.
  let reachFt = toFeet(itemRange.reach, itemRange.units || units);
  let source = reachFt > 0 ? "the item's reach field" : "";

  // 2. The activity may override the item. dnd5e back-fills an overriding
  //    activity's value from its reach, so honour whichever it actually holds.
  //
  //    ⚠️ ONLY WHEN THERE IS ACTUALLY AN ACTIVITY. With no activity, `range`
  //    above already fell back to the item's own block, so this step was
  //    re-reading the item and then crediting the activity for it. The number
  //    was right and the explanation was a lie, which is the worse half: the
  //    source string is what tells a GM WHERE to go and fix the item, and it
  //    was sending them to a field that did not exist. Caught by
  //    tools/reach-agreement-check.mjs the day this file was written.
  const activityRange = activity?.range ?? null;
  const activityReach = activityRange ? toFeet(activityRange.reach, units) : 0;
  if (activityReach > 0) {
    reachFt = activityReach;
    source = "the activity's reach field";
  }

  // 3. Nothing declared in EITHER field? Read the description.
  //
  //    ⚠️ THIS IS A LAST RESORT AND IT ONLY RUNS WHEN THE SLOT IS EMPTY.
  //    Johnny, 2026-08-23: "if it has an empty reach box, read the
  //    description... usually it will be in the description or somewhere else
  //    on the item." He is right, and his own Spiked Chain proves it: the sheet
  //    reads "Melee Attack Roll: +9, reach 10 ft., one target."
  //
  //    ⚠️ READING A DESCRIPTION IS NORMALLY A MISTAKE and this is the narrow
  //    exception. A description names a creature's ENEMIES, its origins, its
  //    rivals — inferring identity from it is what tagged nine of Johnny's
  //    anti-undead orders as undead. What makes this safe is that we are not
  //    inferring anything: we are reading a NUMBER that sits immediately after
  //    the word "reach", a fixed phrase every statblock uses. No judgement.
  //
  //    ⚠️ AND IT SAYS SO OUT LOUD. Falling back to prose is a sign the item's
  //    data is incomplete, and a GM who can see that can fix the item once
  //    instead of wondering why one weapon behaves oddly forever.
  if (reachFt <= 0) {
    const described = reachFromDescription(sys, itemRange.units || units, toFeet);
    if (described > 0) {
      reachFt = described;
      source = "the item's description";
      console.log(`${MODULE_ID} | "${item?.name}" has no reach set on the item, but its description says `
        + `reach ${described}ft. Using that.`);

      // ⚠️ AND FIX IT PROPERLY, once. Reading the description saves this swing;
      // writing the field saves every future one and makes dnd5e's own sheet,
      // tooltip and every other module agree. Queued rather than written here —
      // the caller may be mid-roll, the write is async, and a PLAYER swinging a
      // monster's weapon has no permission to write to it, so doing it inline
      // would race the attack and succeed on one client only.
      //
      // ⚠️ THE PROFILE MUST NOT QUEUE IT. A profile is pure and read-only by
      // contract, and it is built more than once per attack — repairing from
      // there would fire the same write several times per swing. The pipeline
      // asks for the repair; the profile asks for the number.
      if (repair) {
        import("./reach-repair.mjs")
          .then(({ queueReachHeal }) => queueReachHeal(item))
          .catch(() => { /* the runtime fallback already handled this swing */ });
      }
    }
  }

  // 4. Still nothing? The reach PROPERTY, then 5 ft — the same default dnd5e
  //    itself uses when the slot is empty.
  if (reachFt <= 0) {
    reachFt = props.has("rch") ? 10 : 5;
    source = props.has("rch") ? "the reach property" : "the 5 ft default (nothing declared it)";
  }

  // 5. Honor an activity's OWN declared range. A "melee spell attack" can
  //    legitimately reach 30ft — dnd5e mislabels some ranged cantrips (Produce
  //    Flame) as melee spell attacks. Gate by the real range, not a hardcoded 5,
  //    so we never block a spell the caster can throw across the room.
  //    (2026-06-28) — kept, but it may only ever EXTEND the reach. It used to
  //    overwrite it, which would hand a 10ft chain a 5ft range whenever the
  //    activity happened to carry one.
  const declared = toFeet(range.value, units);
  if (declared > reachFt && longRange === 0) {
    reachFt = declared;
    // Same care as step 2: name the place the number actually came from.
    source = activityRange ? "the activity's declared range" : "the item's declared range";
  }

  return { reachFt: Math.round(reachFt), source, units };
}
