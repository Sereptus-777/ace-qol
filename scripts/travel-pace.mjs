// ─── ACE QOL — Movement as time ───────────────────────────────────────────────
//
// Johnny, 2026-08-09: "What about movement? That's got to be wired in there.
// Otherwise, this is all useless."
//
// He is right — this is the piece that makes the clock move by PLAYING rather
// than by remembering to click. Walk the party down a corridor and the day gets
// shorter on its own.
//
// ⚠️ NOTHING EVER ASKS THE PLAYER HOW FAST THEY ARE WALKING. Pace is a scene
// property the GM sets once. Movement is measured silently and ACCUMULATED —
// see the buffer in `movement-clock.mjs`. A prompt on every token drag would be
// unusable, and advancing the clock on every step would fire the world-time
// hooks dozens of times a minute.
//
// ═══ THE THREE WAYS THIS FEATURE BECOMES A BUG ════════════════════════════════
//
//   1. COMBAT. Foundry already bills six seconds a round. Charging for movement
//      during a fight bills it twice. Movement time SUSPENDS in combat.
//
//   2. THE GM STAGING A SCENE. Dragging tokens into place, nudging one a foot,
//      hauling a group into position — none of that is the party walking. Only
//      PLAYER-OWNED tokens accrue time, and there is a pause switch.
//
//   3. THE PARTY MOVES TOGETHER. Four PCs walking down the same corridor is one
//      walk, not four. Distance is taken from the FURTHEST traveller in a
//      window, never the sum.
//
// LEAF MODULE — pure maths, no Foundry calls. Provable outside the app.
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Speeds, in feet per minute, BY WHERE YOU ARE.
 *
 * ⚠️ RAW TRAVEL PACE IS FOR ROADS. Fast 400 / normal 300 / slow 200 describe
 * walking somewhere all day, unbothered. They are NOT the speed of advancing
 * into a corridor with a torch up and a weapon out. I first shipped the road
 * numbers for dungeons and Johnny caught it immediately: "100 ft in 30 seconds
 * in a dungeon… that just doesn't seem right." It isn't — that is a brisk
 * stroll. Nobody crosses a dungeon like that.
 *
 * So a dungeon is ONE STEP SLOWER at every pace. 100 ft/min also makes the
 * arithmetic legible at the table: a hundred feet is a minute.
 *
 * Older editions solved this by folding all the caution INTO one very slow rate
 * (120 feet per ten-minute turn — about 12 ft/min). We do not, because we bill
 * searching, listening and door-forcing SEPARATELY. Bundling caution into the
 * walk as well would charge for it twice.
 */
export const PACE_SETS = {
  dungeon: {
    cautious: { feetPerMinute: 100, perception:  0, label: "Cautious",
                note: "Advancing carefully — weapons ready, checking corners." },
    normal:   { feetPerMinute: 200, perception:  0, label: "Pressing on",
                note: "Moving without much care for what is ahead." },
    hurried:  { feetPerMinute: 300, perception: -5, label: "Hurrying",
                note: "Running the halls — −5 passive Perception." },
  },
  overland: {
    cautious: { feetPerMinute: 200, perception:  0, label: "Slow",
                note: "RAW slow pace — stealth is possible." },
    normal:   { feetPerMinute: 300, perception:  0, label: "Normal",
                note: "RAW normal pace." },
    hurried:  { feetPerMinute: 400, perception: -5, label: "Fast",
                note: "RAW fast pace — −5 passive Perception." },
  },
};

/** Back-compat alias — the dungeon set is what most scenes use. */
export const PACES = PACE_SETS.dungeon;

export const DEFAULT_PACE = "cautious";

/**
 * Scene kinds. A town is not a dungeon and an ocean is not either.
 * `costsTime: false` means movement here is narrative — wandering a market does
 * not tick a clock, and pretending it does just annoys the GM.
 */
export const SCENE_KINDS = {
  dungeon:  { costsTime: true,  set: "dungeon",  pace: "cautious", label: "Dungeon or interior" },
  overland: { costsTime: true,  set: "overland", pace: "normal",   label: "Overland travel" },
  town:     { costsTime: false, set: "dungeon",  pace: "normal",   label: "Town or social" },
};

/** The pace table in force for a scene kind. */
export function paceSetFor(sceneKind = "dungeon") {
  return PACE_SETS[SCENE_KINDS[sceneKind]?.set ?? "dungeon"];
}

/** Minutes taken to cover a distance at a pace. */
export function minutesForDistance(feet, paceKey = DEFAULT_PACE, sceneKind = "dungeon") {
  const set = paceSetFor(sceneKind);
  const pace = set[paceKey] ?? set[DEFAULT_PACE];
  const ft = Math.max(0, Number(feet) || 0);
  return ft / pace.feetPerMinute;
}

export function perceptionPenalty(paceKey = DEFAULT_PACE, sceneKind = "dungeon") {
  const set = paceSetFor(sceneKind);
  return (set[paceKey] ?? set[DEFAULT_PACE]).perception;
}

/**
 * Should this particular movement accrue time at all?
 *
 * @param {object} ctx
 * @param {boolean} ctx.inCombat        a combat is running
 * @param {boolean} ctx.paused          the GM switched movement-time off
 * @param {boolean} ctx.playerOwned     a player owns this token
 * @param {boolean} ctx.sceneCostsTime  from SCENE_KINDS
 * @param {boolean} [ctx.teleported]    a scene change / place, not a walk
 * @returns {{count: boolean, reason: string}}
 */
export function shouldCount(ctx = {}) {
  if (ctx.inCombat)        return { count: false, reason: "combat already bills six seconds a round" };
  if (ctx.paused)          return { count: false, reason: "movement time is paused" };
  if (!ctx.sceneCostsTime) return { count: false, reason: "this scene does not charge for movement" };
  if (!ctx.playerOwned)    return { count: false, reason: "not a player-owned token" };
  if (ctx.teleported)      return { count: false, reason: "placed, not walked" };
  return { count: true, reason: "" };
}

/**
 * Roll several tokens' movement into one journey.
 *
 * ⚠️ THE FURTHEST TRAVELLER, NOT THE SUM. Four characters walking the same
 * corridor took one walk. Summing would make a party of four burn time four
 * times as fast as a lone adventurer for covering identical ground — the same
 * mistake the shared turn window exists to prevent, in a different costume.
 *
 * @param {Array<{id:string, feet:number}>} legs
 * @returns {{feet:number, byToken:object}}
 */
export function journeyDistance(legs) {
  const byToken = {};
  for (const leg of legs ?? []) {
    const id = String(leg?.id ?? "");
    if (!id) continue;
    byToken[id] = (byToken[id] ?? 0) + Math.max(0, Number(leg.feet) || 0);
  }
  const feet = Object.values(byToken).reduce((max, v) => Math.max(max, v), 0);
  return { feet, byToken };
}

/** Straight-line distance between two points, in feet. */
export function feetBetween(a, b, gridSize, gridDistance = 5) {
  const gs = Number(gridSize) || 100;
  const dx = (Number(b?.x) || 0) - (Number(a?.x) || 0);
  const dy = (Number(b?.y) || 0) - (Number(a?.y) || 0);
  const pixels = Math.hypot(dx, dy);
  return (pixels / gs) * (Number(gridDistance) || 5);
}
