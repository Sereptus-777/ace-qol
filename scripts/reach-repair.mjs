// ─── Write the reach into the item, not just into the moment ─────────────────
//
// ⚠️ WHY. ACE can already read a weapon's reach out of its description when the
// reach field is empty — that is what let Johnny's Spiked Chain hit at 10 feet
// again. But it only fixes the swing in front of it. The item stays wrong, so
// dnd5e's own sheet still says 5 feet, its tooltip still says 5 feet, every other
// module reading that weapon still says 5 feet, and ACE re-parses prose on every
// single attack forever.
//
// Johnny, 2026-08-23: "If we do find the field, which we clearly do in the
// description... why can't we write that to the item's field and have it in the
// item sidebar as well?"
//
// ⚠️🔴 THE DANGER, AND IT IS THE MIND FLAYERS SHAPE. Once a number is written
// into the proper slot, the description is never consulted again — so a wrong
// parse becomes permanent AND looks authoritative, because it now lives exactly
// where a correct value would live. A bad record that makes itself right cost
// hours on 08-22. Three rules follow from that:
//
//   1. ONLY WHEN THERE IS NOTHING TO GET WRONG. If a description names reach
//      more than once — a multiattack blurb covering a bite and a tail — we do
//      not write. Choosing between them is a guess, and this file does not
//      guess. The runtime fallback keeps handling those, out loud.
//
//   2. NEVER OVERWRITE A VALUE. Only an empty field is filled. A GM who typed
//      5 feet on purpose is never overruled.
//
//   3. NEVER DURING THE ROLL. The attack hook is mid-flight, the write is
//      async, and a PLAYER swinging a monster's weapon has no permission to
//      write to it — so it would fail on their client and succeed on the GM's.
//      That split-brain is how two GMs once produced no save templates at all.
//      The heal is queued and applied by the GM's client after the roll lands.
//
// ⚠️ AND IT REPORTS BEFORE IT WRITES. The bulk pass shows the whole list first.
// This is his data.
import { MODULE_ID } from "./ace-qol.mjs";
// ⚠️ FROM THE LEAF, NOT THE PIPELINE. This used to import the parser out of
// `attack-pipeline.mjs` while the pipeline dynamically imported this file back.
import { reachFromDescription } from "./reach-reader.mjs";

const LOG = "ace-qol | ReachRepair";

/** Feet, using D&D's own metric convention rather than the true ratio. */
function toFeet(n, units) {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return 0;
  const u = String(units || "ft").toLowerCase();
  if (["m", "meter", "meters", "metre", "metres"].includes(u)) return v * (5 / 1.5);
  return v;
}

/**
 * How many times this description names a reach.
 *
 * ⚠️ THE COUNT IS THE WHOLE SAFETY MECHANISM. One mention is a fact about this
 * weapon. Two is a passage describing several attacks, and picking one of them
 * is exactly the inference that must never be written to disk.
 */
function reachMentions(sys) {
  try {
    const raw = String(sys?.description?.value ?? "");
    if (!raw) return 0;
    const text = raw.replace(/<[^>]+>/g, " ").replace(/&nbsp;/gi, " ").replace(/\s+/g, " ");
    return (text.match(/\breach\s+\d/gi) ?? []).length;
  } catch (_) {
    return 0;
  }
}

/* ══ WHERE A REACH ACTUALLY LIVES ══════════════════════════════════

   His table, 2026-09-30: *"Spiked Chain. Description says reach 10 feet. Console
   says it wrote 10. The Attack activity Targeting range value is still empty. It
   is writing the old item.system.range field. That tab does not show that
   field."*

   ⚠️🔴 HE IS EXACTLY RIGHT, AND THE WRITE WENT NOWHERE. dnd5e 5.x keeps
   `range.reach` on the WEAPON data model only — `WeaponData.defineSchema` has
   `range: { value, long, reach, units }`. A FEAT has no `system.range` at all, and
   Spiked Chain is a feat (this file's own note says so: "the log says
   [feat/attack]"). So `item.update({"system.range.reach": 10})` on a feat set a
   key the schema does not define: the update resolved, nothing threw, the log
   said "Wrote reach 10", and the field stayed empty. A dead field refuses in
   silence — the same shape as the dnd5e 3.x value that refused every caster.

   And the reach was never re-read, so `proposedReachFor` proposed it again on
   every swing, forever.

   ⚠️ SO THE DESTINATION IS ASKED OF THE SCHEMA, NOT ASSUMED FROM THE TYPE.

     · an item whose schema really has `range.reach` (a weapon) → that field.
       dnd5e's own attack reads it: `getRangeLabel` composes "Reach 10 ft" from
       `item.system.range`, and the activity inherits it while its override is
       off. This is where a weapon's reach belongs and the Details tab shows it.

     · anything else (a feat, which is most statblock attacks) → the ATTACK
       ACTIVITY's own range: value and units. `canOverride` is
       `safePropertyExists(item.system, "range")`, so on a feat it is false, the
       override checkbox is not even drawn and that range IS the Targeting tab's
       Range value. His field.

   ⚠️ AND IT SAYS WHICH IT DID, OR THAT IT COULD NOT. His words: *"If that
   field cannot be written, log 'could not write reach on [item] — no activity
   range field' and do not log 'Wrote reach'."*
   ══════════════════════════════════════════════════════════════════════ */

/** Does this item's own data model really hold a melee reach? */
function itemHoldsReach(item) {
  try {
    return !!item?.system?.schema?.getField?.("range.reach");
  } catch (_) {
    return false;
  }
}

/** The one activity that attacks, or why there is not one. */
function attackActivityOf(item) {
  try {
    const all = [...(item?.system?.activities ?? [])].filter(a => a?.type === "attack");
    if (!all.length) return { activity: null, why: "it has no attack activity" };
    // ⚠️ SEVERAL ATTACKS IS RULE 1 AGAIN. One reach in the prose and two attacks
    // to hang it on is a choice, and this file does not guess.
    if (all.length > 1) {
      return { activity: null, why: `it has ${all.length} attack activities, so which one the `
        + `description means is a guess` };
    }
    return { activity: all[0], why: null };
  } catch (err) {
    return { activity: null, why: `its activities could not be read (${err?.message ?? err})` };
  }
}

/**
 * Where this item's reach goes, and what is in there now.
 *
 * @returns {{kind: "item"|"activity"|null, activity?: object, current: number, why?: string}}
 */
export function reachDestination(item) {
  if (itemHoldsReach(item)) {
    return { kind: "item", current: Number(item.system?.range?.reach) || 0 };
  }
  const { activity, why } = attackActivityOf(item);
  if (!activity) return { kind: null, current: 0, why };
  // The field the Targeting tab draws. No field, no write — and it says so
  // rather than reporting a success.
  const hasRange = !!activity.schema?.getField?.("range.value");
  if (!hasRange) return { kind: null, current: 0, why: "no activity range field" };
  const units = String(activity.range?.units ?? "").toLowerCase();
  const raw = Number(activity.range?.value);
  // A value in a unit that is not a length (self, touch, any) is not a reach.
  const current = (Number.isFinite(raw) && raw > 0) ? toFeet(raw, units || "ft") : 0;
  return { kind: "activity", activity, current };
}

/**
 * Should this weapon be repaired, and to what?
 * @returns {number} the reach in feet, or 0 when it must be left alone
 */
export function proposedReachFor(item) {
  try {
    // ⚠️🔴 THE READER ACCEPTS ANY ITEM; THE WRITER ONLY ACCEPTED WEAPONS.
    // Johnny's Spiked Chain is a FEATURE, not a weapon — the log says
    // `[feat/attack]` — so this refused to write, silently, forever. That is
    // why "no reach set on the item, but its description says reach 10 feet"
    // printed on every reload and every hover, months after the repair was
    // supposedly done. He spotted it: "I thought we wrote it before that if it
    // doesn't have a reach set, the first time that our code interjects it into
    // the item permanently."
    //
    // ⚠️ A MONSTER'S CLAW IS A FEAT TOO. Natural attacks, lair actions and
    // most statblock attacks are features, and they are exactly the items whose
    // reach lives in prose rather than in the field. Restricting the repair to
    // weapons excluded the majority of the things that need it.
    //
    // ⚠️ STILL NOTHING THAT CANNOT ATTACK. A spell, a piece of loot or a
    // background has no business gaining a melee reach field.
    if (!item) return 0;
    if (item.type !== "weapon" && item.type !== "feat") return 0;
    if (item.pack) return 0;                    // never write into a compendium
    const sys = item.system ?? {};
    // Rule 2 — an existing value is never touched. ⚠️ ASKED OF THE FIELD THAT
    // WILL ACTUALLY HOLD IT: this read `system.range.reach`, which a feat does
    // not have, so it was always 0 and the repair was proposed on every swing
    // for the rest of the session.
    const where = reachDestination(item);
    if (where.current > 0) return 0;
    // Rule 1 — ambiguity means hands off.
    if (reachMentions(sys) !== 1) return 0;
    const ft = reachFromDescription(sys, sys.range?.units || "ft", toFeet);
    // A described 5 feet on an empty field is the default anyway; writing it adds
    // nothing and touches his data for no gain.
    return ft > 5 ? ft : 0;
  } catch (_) {
    return 0;
  }
}

// ─── The automatic heal ──────────────────────────────────────────────────────

const _queued = new Set();
/** Items we have already said we cannot write, so the console says it once. */
const _refused = new Set();

/**
 * Write the reach where it actually lives.
 *
 * @returns {Promise<{ok: boolean, kind?: string, why?: string}>}
 */
export async function writeReach(item, ft) {
  const where = reachDestination(item);
  if (where.kind === "item") {
    await item.update({ "system.range.reach": ft });
    return { ok: true, kind: "the item's own reach field" };
  }
  if (where.kind === "activity") {
    // The Targeting tab's Range value, in feet. `override` is left alone: it only
    // decides whether an activity ignores an item range, and an item with no
    // range field has nothing to ignore (dnd5e's `canOverride` is false there,
    // which is why this field is the editable one on his sheet).
    await where.activity.update({ "range.value": String(ft), "range.units": "ft" });
    return { ok: true, kind: `the ${where.activity.name ?? "attack"} activity's range` };
  }
  return { ok: false, why: where.why ?? "no activity range field" };
}

/**
 * Remember that this weapon needs its reach written, and do it once the roll is
 * out of the way. Called from the attack pipeline when the description fallback
 * fires.
 */
export function queueReachHeal(item) {
  try {
    if (!game.user?.isGM) return;               // only the GM may write
    const uuid = item?.uuid;
    if (!uuid || _queued.has(uuid)) return;
    if (_refused.has(uuid)) return;             // already said why, once
    const ft = proposedReachFor(item);
    if (!ft) return;
    _queued.add(uuid);

    // ⚠️ AFTER THE ROLL, NOT DURING IT. A document update inside the pre-roll
    // hook races the attack it is meant to be helping.
    setTimeout(async () => {
      try {
        const done = await writeReach(item, ft);
        if (!done.ok) {
          // ⚠️ HIS WORDING, AND NOT A WORD ABOUT WRITING. A success line over a
          // write that went nowhere is what cost him this evening.
          console.warn(`${LOG} | could not write reach on ${item.name} — ${done.why}`);
          // Said once. It is the same answer on every swing, and a line per
          // swing is noise he has to read past.
          _refused.add(uuid);
          return;
        }
        console.log(`${LOG} | Wrote reach ${ft} feet onto "${item.name}", on ${done.kind} — its `
          + `description said so and the field was empty. dnd5e's own sheet and tooltip will now agree.`);
        ui.notifications?.info(`ACE: set "${item.name}" reach to ${ft} feet from its description.`);
      } catch (err) {
        console.warn(`${LOG} | Could not write reach onto "${item?.name}":`, err);
        _refused.add(uuid);
      } finally {
        _queued.delete(uuid);
      }
    }, 1500);
  } catch (err) {
    console.warn(`${LOG} | reach heal could not be queued:`, err);
  }
}

// ─── The bulk pass ───────────────────────────────────────────────────────────

/**
 * Every weapon in the world whose description names a reach its field is
 * missing. Reports only unless asked.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.fix=false]
 */
export async function repairWeaponReach({ fix = false } = {}) {
  if (!game.user?.isGM) {
    ui.notifications?.warn("Only the GM can repair weapon reach.");
    return { checked: 0, rows: [] };
  }

  const rows = [];
  const ambiguous = [];
  let checked = 0;

  const inspect = (item, ownerName) => {
    // ⚠️ SAME WIDENING AS THE SINGLE-ITEM WRITER. The bulk pass had the
    // identical weapon-only filter, so a sweep would have reported "nothing to
    // fix" while every feature-based attack in the world still had an empty
    // reach field. Fixing one and leaving the other is how a class of bug
    // survives its own repair.
    if (item?.type !== "weapon" && item?.type !== "feat") return;
    checked++;
    const sys = item.system ?? {};
    // ⚠️ THE FIELD THAT WILL HOLD IT, not the weapon field a feat does not have.
    if (reachDestination(item).current > 0) return;
    const mentions = reachMentions(sys);
    if (mentions > 1) {
      // ⚠️ NAMED, NOT SILENTLY SKIPPED. These are the ones a human has to
      // settle, and a repair that hides what it refused to touch is how a GM
      // ends up believing everything was handled.
      ambiguous.push({ item, ownerName, mentions });
      return;
    }
    const ft = proposedReachFor(item);
    if (ft) rows.push({ item, ownerName, ft });
  };

  for (const actor of (game.actors ?? [])) {
    for (const item of (actor.items ?? [])) inspect(item, actor.name);
  }
  // World items too — a weapon sitting in the Items sidebar is dragged onto
  // creatures later, so repairing it once fixes every future copy.
  for (const item of (game.items ?? [])) inspect(item, "Items sidebar");

  console.log(`${LOG} | ${checked} weapon(s) checked.`);
  if (ambiguous.length) {
    console.log(`${LOG} | ${ambiguous.length} left alone — their description names reach more than once, `
      + `so choosing one would be a guess. Set these by hand:`);
    for (const a of ambiguous) {
      console.log(`     "${a.item.name}" on ${a.ownerName} — ${a.mentions} reaches mentioned`);
    }
  }

  if (!rows.length) {
    console.log(`${LOG} | No weapon has a reach in its description that its field is missing.`);
    ui.notifications?.info("ACE: every weapon's reach field is already correct.");
    return { checked, rows: [], ambiguous };
  }

  console.log(`${LOG} | ${fix ? "WRITING" : "WOULD WRITE"} reach onto ${rows.length} weapon(s):`);
  for (const r of rows) {
    console.log(`     ${String(r.ft + " ft").padEnd(7)} "${r.item.name}"  (${r.ownerName})`);
  }

  if (!fix) {
    console.log(`${LOG} | Nothing was changed. Run again with { fix: true } to write them.`);
    ui.notifications?.warn(`ACE: ${rows.length} weapon(s) have a reach in their description but an empty reach field. `
      + `See the console (F12); nothing was changed.`);
    return { checked, rows, ambiguous };
  }

  // ⚠️ ONE UPDATE PER OWNER FOR THE ITEM FIELD. A world with many of these would
  // otherwise fire a document write per weapon, each broadcast to every client.
  // An activity's range is a pseudo-document update and goes one at a time,
  // because that is the only API dnd5e gives for it.
  const byActor = new Map();
  const loose = [];
  const viaActivity = [];
  for (const r of rows) {
    const where = reachDestination(r.item);
    if (where.kind === "activity") { viaActivity.push(r); continue; }
    if (where.kind !== "item") {
      console.warn(`${LOG} | could not write reach on ${r.item.name} — ${where.why ?? "no activity range field"}`);
      continue;
    }
    const parent = r.item.parent;
    if (parent?.updateEmbeddedDocuments) {
      if (!byActor.has(parent)) byActor.set(parent, []);
      byActor.get(parent).push({ _id: r.item.id, "system.range.reach": r.ft });
    } else loose.push(r);
  }

  let done = 0, failed = 0;
  for (const [actor, updates] of byActor) {
    try { await actor.updateEmbeddedDocuments("Item", updates); done += updates.length; }
    catch (err) { failed += updates.length; console.warn(`${LOG} | Could not repair on ${actor.name}:`, err); }
  }
  for (const r of loose) {
    try { await r.item.update({ "system.range.reach": r.ft }); done++; }
    catch (err) { failed++; console.warn(`${LOG} | Could not repair "${r.item.name}":`, err); }
  }
  for (const r of viaActivity) {
    try {
      const w = await writeReach(r.item, r.ft);
      if (w.ok) done++;
      else { failed++; console.warn(`${LOG} | could not write reach on ${r.item.name} — ${w.why}`); }
    } catch (err) {
      failed++;
      console.warn(`${LOG} | Could not repair "${r.item.name}":`, err);
    }
  }

  console.log(`${LOG} | ${done} weapon(s) repaired${failed ? `, ${failed} FAILED` : ""}.`);
  ui.notifications?.info(`ACE: wrote the reach onto ${done} weapon(s). Their sheets now show it correctly.`);
  return { checked, rows, ambiguous, repaired: done, failed };
}
