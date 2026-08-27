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
    // Rule 2 — an existing value is never touched.
    if (Number(sys.range?.reach) > 0) return 0;
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
    const ft = proposedReachFor(item);
    if (!ft) return;
    _queued.add(uuid);

    // ⚠️ AFTER THE ROLL, NOT DURING IT. A document update inside the pre-roll
    // hook races the attack it is meant to be helping.
    setTimeout(async () => {
      try {
        await item.update({ "system.range.reach": ft });
        console.log(`${LOG} | Wrote reach ${ft} feet onto "${item.name}" — its description said so and the field was empty. `
          + `dnd5e's own sheet and tooltip will now agree.`);
        ui.notifications?.info(`ACE: set "${item.name}" reach to ${ft} feet from its description.`);
      } catch (err) {
        console.warn(`${LOG} | Could not write reach onto "${item?.name}":`, err);
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
    if (Number(sys.range?.reach) > 0) return;
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

  // ⚠️ ONE UPDATE PER OWNER. A world with many of these would otherwise fire a
  // document write per weapon, each broadcast to every connected client.
  const byActor = new Map();
  const loose = [];
  for (const r of rows) {
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

  console.log(`${LOG} | ${done} weapon(s) repaired${failed ? `, ${failed} FAILED` : ""}.`);
  ui.notifications?.info(`ACE: wrote the reach onto ${done} weapon(s). Their sheets now show it correctly.`);
  return { checked, rows, ambiguous, repaired: done, failed };
}
