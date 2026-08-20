// ─── ACE QOL — The day turning over ──────────────────────────────────────────
//
// The Clock counts minutes. Nothing in ACE ever noticed a DAY passing, which is
// why four separate time features could not be built: starvation warnings,
// forced-march exhaustion, torches burning down, and verifying a long rest
// actually took eight hours all need "a new day began" or "N hours have passed"
// as a thing that can be reacted to.
//
// ⚠️ THIS DOES NOT BUILD A CALENDAR, DELIBERATELY. dnd5e 5.x already ships the
// Calendar of Harptos and Foundry exposes `game.time.components`, which hands
// back {year, day, month, dayOfMonth, dayOfWeek, season} against whatever
// calendar the world is configured with. A previous attempt at this wrote a
// harptos.mjs BEFORE looking, and about 90% of it was redundant — the file was
// deleted on 2026-08-19 having never been imported by anything. Read the
// system's clock; do not invent one.
//
// ⚠️ ONE WRITER. The day marker is world-scoped state, so only the active GM
// advances it. Two clients both deciding "a new day started" would double every
// consequence hung off this hook — the split-brain shape that produced the
// save-template bug on 2026-08-15.
//
// ⚠️ TIME RUNS BACKWARDS SOMETIMES. A GM correcting a mistake, or Foundry's own
// calendar HUD reverse button, moves world time DOWN. That is not a new day and
// must fire nothing; it silently resets the marker instead.

import { MODULE_ID } from "./ace-qol.mjs";

// ⚠️🔴 LITERAL STRING, NOT THE IMPORTED MODULE_ID. Every file in this folder
// does the same, and this is why: ace-qol.mjs imports this file, and this file
// imports MODULE_ID back from ace-qol.mjs. ES modules evaluate every import
// BEFORE the importing module's own body runs, so at the moment this line
// executes `export const MODULE_ID` has not been assigned yet and reading it
// throws "Cannot access 'MODULE_ID' before initialization".
//
// That throw happens at MODULE LOAD, which kills the WHOLE of ace-qol - no
// settings registered, no subsystems, the module simply absent from Foundry's
// settings list while still showing as enabled. Shipped exactly that way on
// 2026-08-19. Inside a function it is fine; at module scope it is fatal.
const LOG = "ace-qol | Day";

/** How many whole days a TimeComponents pair is apart. Calendar-aware. */
function _dayIndex(c) {
  if (!c) return null;
  const year = Number(c.year) || 0;
  const day  = Number(c.day)  || 0;
  // `day` is days completed WITHIN the year, so a year length is needed to make
  // this monotonic. Foundry does not expose one directly on components, so the
  // comparison is (year, day) lexicographic rather than a single number. Any
  // year change is a new day by definition.
  return { year, day };
}

function _isLater(a, b) {
  if (!a || !b) return false;
  if (a.year !== b.year) return a.year > b.year;
  return a.day > b.day;
}

export const DayRollover = {
  _last: null,

  /**
   * Start watching. Call from init or ready — it takes its baseline from the
   * current time either way and never fires on the first read.
   */
  init() {
    try {
      this._last = _dayIndex(game.time?.components);
      Hooks.on("updateWorldTime", () => {
        try { this._check(); } catch (err) { console.warn(`${LOG} | check failed:`, err); }
      });
      console.debug(`${LOG} | watching (baseline ${JSON.stringify(this._last)})`);
    } catch (err) {
      console.warn(`${LOG} | could not start:`, err);
    }
  },

  /** Read the clock; fire if the calendar day advanced. */
  _check() {
    // Only the active GM decides. Everyone else just tracks quietly so their
    // own baseline stays correct if they are later promoted.
    const now = _dayIndex(game.time?.components);
    if (!now) return;
    const prev = this._last;
    this._last = now;
    if (!prev) return;

    if (!_isLater(now, prev)) {
      // Same day, or the GM rewound. Neither is an event.
      return;
    }
    if (game.users?.activeGM !== game.user) return;

    // How many days? A long march or a downtime jump can cross several at once,
    // and every consequence downstream needs to apply that many times rather
    // than once. Within a year this is exact; across a year boundary it falls
    // back to 1 because Foundry does not expose the year length here, and
    // guessing a wrong number is worse than under-counting a rare case.
    const days = (now.year === prev.year) ? (now.day - prev.day) : 1;

    const c = game.time.components;
    console.log(`${LOG} | a new day: ${days} day(s) passed → ${JSON.stringify({ year: c.year, day: c.day, month: c.month, dayOfMonth: c.dayOfMonth })}`);

    Hooks.callAll(`${MODULE_ID}.dayChanged`, {
      days,
      from: prev,
      to: now,
      components: c,
    });
  },

  /** What day is it, in whatever calendar this world uses? Plain English. */
  describe() {
    try {
      const c = game.time.components;
      const cal = game.time.calendar;
      const month = cal?.months?.values?.[c.month]?.name ?? `month ${c.month + 1}`;
      const wd    = cal?.days?.values?.[c.dayOfWeek]?.name ?? "";
      const season = cal?.seasons?.values?.[c.season]?.name ?? "";
      const hh = String(c.hour).padStart(2, "0");
      const mm = String(c.minute).padStart(2, "0");
      return `${wd ? wd + ", " : ""}${month} ${c.dayOfMonth + 1}, year ${c.year} — ${hh}:${mm}${season ? ` (${season})` : ""}`;
    } catch (_) {
      return "unknown";
    }
  },
};
