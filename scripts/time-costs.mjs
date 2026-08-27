// ─── ACE QOL — THE CLOCK: what things cost, and the one place time is spent ───
//
// Johnny, 2026-08-09: "we really have to start thinking about anything that we
// do here now and all the features that we have, and hook them into the time
// thing… we really have to hook shit in."
//
// He is right, and the reason it has to be ONE table rather than a number
// inside each feature is not tidiness. It is that the two rules below are
// unenforceable if advances are scattered:
//
//   1. NOTHING ADVANCES THE CLOCK SILENTLY. Every spend names itself.
//   2. NOTHING COSTS TIME TWICE.
//
// Rule 2 is the whole engineering problem, and it has two distinct halves:
//
//   a) COMBAT. dnd5e sets `CONFIG.time.roundTime = 6`, so Foundry already
//      advances world time six seconds per round. A two-hour table fight is
//      thirty seconds in the fiction. If this module ALSO charged for actions
//      during a fight, every combat would cost time twice. So we refuse to
//      spend while a combat is running — see `resolveSpend`.
//
//   b) THE PARTY ACTS TOGETHER. Four characters searching one room is ONE
//      ten-minute turn, not forty minutes. Without that, a party of four burns
//      time four times faster than a lone adventurer, which is absurd and is
//      instantly obvious at the table. Handled by the turn window below.
//
// LEAF MODULE — imports nothing. Every rule here is provable outside Foundry.
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Everything in ACE that costs time, in one table.
 *
 * `shared: true` means the whole party can do it in the same window — four
 * people searching a room, or bedding down for the night. `shared: false` means
 * it is one person's work and a second person doing it costs its own time.
 */
export const TIME_COSTS = {
  // ── Exploring ──────────────────────────────────────────────────────────
  "search.quick":     { minutes: 5,   shared: true,  label: "A quick look round",        note: "disadvantage" },
  "search.normal":    { minutes: 10,  shared: true,  label: "Searching the area" },
  "search.thorough":  { minutes: 15,  shared: true,  label: "Going over everything",     note: "advantage" },
  "listen.door":      { minutes: 1,   shared: true,  label: "Listening at the door" },
  "door.force":       { minutes: 10,  shared: false, label: "Forcing the door" },
  "lock.pick":        { minutes: 10,  shared: false, label: "Picking the lock" },
  "trap.disarm":      { minutes: 10,  shared: false, label: "Disarming the trap" },
  "trap.set":         { minutes: 10,  shared: false, label: "Setting a trap" },
  "loot.body":        { minutes: 10,  shared: true,  label: "Searching the bodies" },

  // ── Walking. Minutes come from distance and pace, never from this table —
  //    see travel-pace.mjs. Listed so the registry is a complete picture, and
  //    marked shared because the party walks together.
  // ⚠️ NOT `shared`. "The party walks together" is TRUE, and it is already
  // handled where it belongs — `journeyDistance` takes the FURTHEST traveller,
  // so four PCs down one corridor produce one distance. Marking travel shared
  // as WELL made every walk within 90 s of the last one ride free: Johnny
  // walked 300 feet and the clock moved half a minute. Two consecutive journeys
  // are two journeys; the shared turn is for four people declaring the SAME
  // action at the SAME moment, which walking never is.
  "travel":           { minutes: null, shared: false, label: "Travelling",
                        dynamic: "distance / pace" },

  // ── Light ──────────────────────────────────────────────────────────────
  "torch.light":      { minutes: 0,   shared: true,  label: "Lighting a light" },

  // ── Butchering. Time comes from the carcass, not this table — the size
  //    ladder lives in sustenance.mjs. Listed here so the registry is a
  //    complete picture of what costs time.
  "harvest":          { minutes: null, shared: false, label: "Butchering the kill",
                        dynamic: "sustenance.harvestMinutes" },

  // ── Camp and sustenance ────────────────────────────────────────────────
  "camp.make":        { minutes: 30,  shared: true,  label: "Making camp" },
  "camp.break":       { minutes: 30,  shared: true,  label: "Breaking camp" },
  "meal.cold":        { minutes: 10,  shared: true,  label: "Eating cold rations" },
  "meal.hot":         { minutes: 60,  shared: true,  label: "Cooking a hot meal" },
  "forage":           { minutes: 60,  shared: true,  label: "Foraging" },
  "hunt":             { minutes: 180, shared: false, label: "Hunting" },

  // ── Rest. RAW, and the two most-used entries in the table. ────────────
  "rest.short":       { minutes: 60,  shared: true,  label: "A short rest" },
  "rest.long":        { minutes: 480, shared: true,  label: "A long rest" },

  // ── Talking. Costs whatever it actually took — see conversation-app.mjs,
  //    whose idle timeout is also the cap on this.
  "conversation":     { minutes: null, shared: true, label: "In conversation",
                        dynamic: "elapsed real time" },
};

/** Minutes for a key, or null when the caller must supply it. */
export function costOf(key) {
  const entry = TIME_COSTS[key];
  if (!entry) return null;
  return entry.minutes;
}

export function labelOf(key) {
  return TIME_COSTS[key]?.label ?? key;
}

export function isShared(key) {
  return TIME_COSTS[key]?.shared === true;
}

/**
 * How long the party's shared turn stays open, in REAL milliseconds.
 * Long enough that four players each clicking Search ride the same turn;
 * short enough that a search ten minutes later at the table is its own turn.
 */
export const PARTY_TURN_REAL_MS = 90_000;

/* ─── The turn window ────────────────────────────────────────────────────── */

/**
 * Decide what a spend actually costs, given what the party is already doing.
 *
 * @param {object} state
 * @param {number|null} state.windowOpenedAt   world time (s) the window opened
 * @param {number} state.windowMinutes         how long that window covers
 * @param {boolean} state.inCombat             is a combat running right now
 * @param {number} state.now                   current world time, in seconds
 * @param {object} spend
 * @param {string} spend.key
 * @param {number} [spend.minutes]             overrides the table (harvest, talk)
 * @param {boolean} [spend.force]              spend even during combat
 *
 * @returns {{advanceMinutes:number, reason:string, refused:boolean,
 *            window:{openedAt:number, minutes:number}|null, rode:boolean}}
 */
export function resolveSpend(state, spend) {
  const key = String(spend?.key ?? "");
  const entry = TIME_COSTS[key];

  // ⚠️ `Number(null)` is 0, and `Number.isFinite(0)` is true. Coercing a
  // dynamic entry's null cost would make it silently FREE instead of refused —
  // the exact silent-zero this module exists to prevent. Test for a real number
  // before any arithmetic touches it.
  const supplied = spend?.minutes;
  const tabled   = entry?.minutes;
  const minutes =
    (typeof supplied === "number" && Number.isFinite(supplied)) ? supplied :
    (typeof tabled   === "number" && Number.isFinite(tabled))   ? tabled   : NaN;

  if (!Number.isFinite(minutes)) {
    return { advanceMinutes: 0, refused: true, rode: false, window: null,
             reason: `"${key}" has no time cost and none was supplied` };
  }

  // ⚠️ RULE 2a — combat already bills six seconds a round. Never double-charge.
  if (state?.inCombat && !spend?.force) {
    return { advanceMinutes: 0, refused: true, rode: false,
             window: state?.windowOpenedAt != null
               ? { openedAt: state.windowOpenedAt, minutes: state.windowMinutes } : null,
             reason: "combat is running — the round timer is already spending time" };
  }

  if (minutes <= 0) {
    return { advanceMinutes: 0, refused: false, rode: false,
             window: state?.windowOpenedAt != null
               ? { openedAt: state.windowOpenedAt, minutes: state.windowMinutes } : null,
             reason: "costs no appreciable time" };
  }

  // ⚠️ THE PARTY TURN IS ANCHORED TO REAL TIME AT THE TABLE, NOT WORLD TIME.
  // Anchoring it to world time is broken, and subtly: the first search charges
  // ten minutes, which immediately advances world time PAST its own window, so
  // the window is shut before the second player can ride it — Rule 2b would
  // never fire in a real game. Worse, if you widen the comparison to keep it
  // open, riding free costs nothing, so world time never moves, so the window
  // never closes, and every shared action is free forever.
  //
  // What the window actually means is "the party is declaring this together,
  // right now, at the table" — and that is wall-clock simultaneity. Real time
  // always moves forward on its own, so it cannot leak.
  //
  // ⚠️ My first test suite passed only because it hand-set `now` to a value the
  // real code can never produce. A green test proving an impossible state is
  // worse than no test.
  const nowReal = Number(state?.nowReal) || 0;
  const openedAt = state?.windowOpenedAt;
  const openMins = Number(state?.windowMinutes) || 0;
  const windowOpen = openedAt != null && (nowReal - Number(openedAt)) < PARTY_TURN_REAL_MS;

  // ⚠️ RULE 2b — a shared action inside an open turn rides along free.
  if (windowOpen && isShared(key)) {
    if (minutes <= openMins) {
      return { advanceMinutes: 0, refused: false, rode: true,
               window: { openedAt: Number(openedAt), minutes: openMins },
               reason: `the party is already spending ${openMins} min on this` };
    }
    // Longer than the turn — stretch it, and only charge the difference.
    const extra = minutes - openMins;
    return { advanceMinutes: extra, refused: false, rode: true,
             window: { openedAt: Number(openedAt), minutes },
             reason: `stretches the party's turn from ${openMins} to ${minutes} min` };
  }

  // A fresh window — but ONLY a shared action opens one.
  // ⚠️ A solo action must not open a turn either, or it discounts whatever
  // comes next: a 0.5-minute walk opening a window meant a following 10-minute
  // search "stretched" it and charged 9.5. Solo work leaves the party turn
  // exactly as it found it.
  if (!isShared(key)) {
    return { advanceMinutes: minutes, refused: false, rode: false,
             window: openedAt != null ? { openedAt: Number(openedAt), minutes: openMins } : null,
             reason: labelOf(key) };
  }
  return { advanceMinutes: minutes, refused: false, rode: false,
           window: { openedAt: nowReal, minutes },
           reason: labelOf(key) };
}

/** Human phrasing for a duration. "1 hour 30 minutes", not "90". */
export function describeMinutes(mins) {
  const m = Math.max(0, Math.round(Number(mins) || 0));
  if (m === 0) return "no time at all";
  if (m < 60) return `${m} minute${m === 1 ? "" : "s"}`;
  const h = Math.floor(m / 60), rem = m % 60;
  const hp = `${h} hour${h === 1 ? "" : "s"}`;
  return rem ? `${hp} ${rem} minute${rem === 1 ? "" : "s"}` : hp;
}
