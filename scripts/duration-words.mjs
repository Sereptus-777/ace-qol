// ─── HOW LONG IT LASTS, IN ENGLISH ───────────────────────────────────────────
//
// His save-card shell, 2026-09-29: the line under the result reads "Charmed — 1
// hour", and on the player's own screen "You are Charmed for 1 hour." So a
// duration has to come out as words, not as a badge.
//
// ⚠️ ONE READER, TWO SHAPES. The transformation engine already had its own
// `_formatDuration` giving "1hr" for a compact badge, which is a different job
// and a fine one. Two private formatters for the same question is the drift that
// keeps costing sessions, so both shapes live here: `durationWords` for a
// sentence, `durationShort` for a badge, one place to fix when either is wrong.
//
// Nothing here rounds a duration into a lie: 90 minutes is "90 minutes", not
// "2 hours", because a creature whose charm ends in 90 minutes is not charmed
// for two hours.

/** Plural without the "(s)" that reads like a form. */
function n(value, word) {
  const v = Math.round(value * 100) / 100;
  return `${v} ${word}${v === 1 ? "" : "s"}`;
}

/**
 * A duration as a sentence would say it: "1 hour", "10 minutes", "6 seconds",
 * "8 hours", "2 days".
 *
 * @param {number|null|undefined} seconds
 * @returns {string} "" when there is no duration to name, so a caller can write
 *   `${words ? ` — ${words}` : ""}` and get nothing rather than "— instant"
 */
export function durationWords(seconds) {
  const s = Number(seconds);
  if (!Number.isFinite(s) || s <= 0) return "";
  if (s < 60) return n(s, "second");
  if (s < 3600) {
    const m = s / 60;
    // A round number of minutes says minutes; anything else keeps its seconds
    // rather than being rounded into a time that is not the time.
    return Number.isInteger(m) ? n(m, "minute") : `${Math.floor(m)} min ${s % 60} s`;
  }
  if (s < 86400) {
    const h = s / 3600;
    return Number.isInteger(h) ? n(h, "hour") : n(h, "hour");
  }
  const d = s / 86400;
  return Number.isInteger(d) ? n(d, "day") : n(d, "day");
}

/** The same duration as a compact badge: "1hr", "10min", "6s", "2d". */
export function durationShort(seconds) {
  const s = Number(seconds);
  if (!Number.isFinite(s) || s <= 0) return "instant";
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}min`;
  if (s < 86400) return `${Math.round(s / 3600 * 10) / 10}hr`;
  return `${Math.round(s / 86400)}d`;
}

/**
 * Rounds, as a duration in seconds. dnd5e stores some conditions as rounds and
 * a round is six seconds, so "10 rounds" is the minute the books mean.
 */
export function roundsToSeconds(rounds) {
  const r = Number(rounds);
  return Number.isFinite(r) && r > 0 ? r * 6 : 0;
}

/**
 * Whatever a condition or effect carries, as seconds: `{seconds}` first, then
 * `{rounds}`, then `{turns}` (one turn of one round). 0 when it names none.
 */
export function durationSecondsOf(duration) {
  if (!duration) return 0;
  const sec = Number(duration.seconds);
  if (Number.isFinite(sec) && sec > 0) return sec;
  const rounds = roundsToSeconds(duration.rounds);
  if (rounds > 0) return rounds;
  return roundsToSeconds(duration.turns);
}
