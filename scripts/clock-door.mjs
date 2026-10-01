// ─── ACE: QOL — NOBODY MOVES A CLOCK THAT IS ALREADY RUNNING ─────────────────
//
// His table, 2026-10-01, for the third time: *"Kasimir's charm still set both
// bars to 1 hour. The rescue-anchor fix did not hold. A new source starts at 1
// hour. It must not write seconds, startTime, or the bar onto any other effect."*
//
// ⚠️🔴 I HAVE NAMED THE WRITER TWICE AND BEEN WRONG TWICE. First the twin
// refresh, which I then made prove its source. Then duration-tracker's rescue
// anchor, which I then stopped touching ACE's own conditions. The bars still
// both read an hour, which means the write is somewhere I have not read, and
// guessing a third time is not a plan.
//
// So this is a DOOR rather than another guess. `preUpdateActiveEffect` sees every
// write to every effect from every source — ACE, dnd5e, a macro, another module —
// before it lands. An anchor that is already set is a fact about when something
// began, and nothing may move it except the caster who owns it:
//
//   · `duration.startTime` on an effect that already has one → REFUSED, with the
//     old value, the new value, and the stack that tried it
//   · the same write marked `aceClock: true` → allowed, because that is the one
//     path entitled to it: the same caster recasting, which is a refresh
//   · an effect with no anchor yet → allowed, and said out loud; that is a clock
//     being started, not moved
//   · `duration.seconds` changing on an ACE condition → allowed and reported,
//     because a GM editing a duration on the sheet is doing something legitimate
//     and this door is about the ANCHOR, which is the thing that silently resets
//     a bar to full
//
// ⚠️ IT REPORTS THE STACK. The point of a door is that the next report names the
// writer instead of costing another round of reading. Even when it refuses, the
// line says who tried.
// ──────────────────────────────────────────────────────────────────────────────

const MODULE_ID = "ace-qol";
const LOG = "ace-qol | clock door";

/** Where the write came from, as a few readable frames. */
function whoTried() {
  try {
    const raw = String(new Error("trace").stack ?? "");
    return raw.split("\n").slice(2, 7)
      .map(l => l.trim().replace(/^at\s+/, "").replace(/\?[0-9a-f]+/g, ""))
      .filter(Boolean).join(" ← ");
  } catch (_) {
    return "an unreadable stack";
  }
}

export function registerClockDoor() {
  if (globalThis.__aceClockDoor) return;
  globalThis.__aceClockDoor = true;

  Hooks.on("preUpdateActiveEffect", (effect, changes, options = {}) => {
    try {
      const key = effect?.flags?.[MODULE_ID]?.conditionKey ?? null;
      if (!key) return;                               // not one of ACE's conditions

      const next = changes?.duration ?? {};
      const hasAnchorChange = Object.prototype.hasOwnProperty.call(next, "startTime")
        || Object.prototype.hasOwnProperty.call(changes ?? {}, "duration.startTime");
      const nextStart = next.startTime ?? changes?.["duration.startTime"];
      const was = effect?.duration?.startTime ?? null;

      // A length change is reported and allowed: the GM's own sheet does that.
      const nextSecs = next.seconds ?? changes?.["duration.seconds"];
      if (nextSecs !== undefined && Number(nextSecs) !== Number(effect?.duration?.seconds ?? 0)) {
        console.log(`${LOG} | "${effect.name}" on ${effect.parent?.name}: its length is being changed `
          + `from ${effect?.duration?.seconds ?? "none"}s to ${nextSecs}s by ${whoTried()}`);
      }

      if (!hasAnchorChange || nextStart === undefined) return;

      // A clock being STARTED is not a clock being moved.
      if (was == null) {
        console.log(`${LOG} | "${effect.name}" on ${effect.parent?.name} is being anchored for the `
          + `first time at ${nextStart}. That is a clock starting, which is allowed.`);
        return;
      }
      if (Number(nextStart) === Number(was)) return;   // no change at all

      // The one path entitled to move it: the caster who owns it, recasting.
      if (options?.aceClock === true) {
        console.log(`${LOG} | "${effect.name}" on ${effect.parent?.name}: its own caster recast it, `
          + `so its clock restarts at ${nextStart} (was ${was}).`);
        return;
      }

      // ⚠️ REFUSED. Strip the anchor out of the update rather than vetoing the
      // whole write: whatever else that update was doing is probably right, and
      // the one thing that must not happen is the clock moving.
      delete next.startTime;
      if (changes) delete changes["duration.startTime"];
      if (changes?.duration && !Object.keys(changes.duration).length) delete changes.duration;
      console.warn(`${LOG} | REFUSED a write that would have moved "${effect.name}" on `
        + `${effect.parent?.name} from startTime ${was} to ${nextStart}. An anchor that is already `
        + `set says when that condition began, and only the caster who owns it may restart it `
        + `(a refresh passes aceClock). This is the write that kept putting two charms on one `
        + `clock. It came from: ${whoTried()}`);
    } catch (err) {
      console.warn(`${LOG} | could not check a duration write, so it was allowed:`, err);
    }
  });

  console.log(`${MODULE_ID} | the clock door is open: an anchor that is already set is not moved by `
    + `anybody but the caster who owns it, and a refusal names what tried.`);
}
