// ─── ACE QOL — Walking spends the day ─────────────────────────────────────────
//
// Johnny, 2026-08-10: "Every time a token moves, is it going to ask them, 'How
// fast are you moving?'… I don't want any pop-ups every time."
//
// ═══ IT NEVER ASKS. HERE IS HOW ══════════════════════════════════════════════
//
//   • PACE IS A SCENE PROPERTY, set once by the GM (Cautious / Pressing on /
//     Hurrying) and remembered on the scene. Players are never asked anything.
//
//   • MOVEMENT IS ACCUMULATED, NOT SPENT PER STEP. Every move drops its
//     distance into a buffer. Nothing happens to the clock yet.
//
//   • THE BUFFER SETTLES when the party stops moving for a few seconds, or when
//     something else needs the clock to be accurate (a search, a rest, combat
//     starting). Then ONE advance happens and one line is logged.
//
// ⚠️ WHY NOT ADVANCE ON EVERY MOVE. `game.time.advance` writes a world setting
// and fires `updateWorldTime` for every client. Dragging a party of four across
// a room is dozens of writes — each one re-rendering the calendar, ticking
// torches down, and running every duration check in the system. It would also
// bury the time log under a hundred four-second entries. Accumulate, then
// settle once.
//
// ⚠️ THE PARTY MOVES TOGETHER. Distance for a settling window is the FURTHEST
// traveller, never the sum — see `journeyDistance`. Four people down one
// corridor took one walk.
// ──────────────────────────────────────────────────────────────────────────────

import { MODULE_ID } from "./ace-qol.mjs";
import { TheClock } from "./the-clock.mjs";
import {
  SCENE_KINDS, DEFAULT_PACE, paceSetFor,
  minutesForDistance, shouldCount, journeyDistance, feetBetween,
} from "./travel-pace.mjs";

const LOG = "ace-qol | Movement";

/** How long the party must stand still before the buffer settles. */
const SETTLE_MS = 4000;

/** Below this, it is a nudge into position rather than a journey. */
const MIN_FEET = 5;

export class MovementClock {
  /** Legs walked since the last settle: [{id, feet}] */
  static _legs = [];

  /**
   * Distance carried over from settles that came to less than a whole minute.
   *
   * ⚠️ THIS MUST BE A SCALAR, NOT A LEG. It was first stored as a leg with a
   * fake token id, which was silently fatal: `journeyDistance` takes the
   * FURTHEST traveller (a max, deliberately — four PCs down one corridor is one
   * walk), so the carry COMPETED with the next step instead of adding to it.
   * Walking 20 ft eight times left the journey pinned at 20 ft and charged
   * nothing, forever. Johnny walked well past 100 ft and no time ever passed.
   */
  static _carryFeet = 0;
  static _timer = null;
  static _paused = false;

  /* ─── Scene configuration (read, never asked) ───────────────────────── */

  static sceneKind(scene = canvas?.scene) {
    const k = scene?.getFlag?.(MODULE_ID, "sceneKind");
    return SCENE_KINDS[k] ? k : "dungeon";
  }

  static scenePace(scene = canvas?.scene) {
    const p = scene?.getFlag?.(MODULE_ID, "pace");
    const set = paceSetFor(this.sceneKind(scene));
    return set[p] ? p : (SCENE_KINDS[this.sceneKind(scene)]?.pace ?? DEFAULT_PACE);
  }

  static get paused() { return this._paused; }
  static setPaused(v) {
    this._paused = !!v;
    if (this._paused) this._discard("movement time paused");
    console.log(`${LOG} | movement time ${this._paused ? "PAUSED" : "resumed"}`);
  }

  /* ─── Collecting ────────────────────────────────────────────────────── */

  /**
   * A token finished moving. Decide whether it counts, and buffer it.
   * Deliberately cheap — this runs on every token update in the world.
   */
  static onTokenMoved(tokenDoc, changes) {
    try {
      if (!game.user.isGM) return;              // the GM's client owns the clock
      if (!("x" in changes) && !("y" in changes)) return;

      // Walking can be switched off on its own — some tables want searches and
      // rests to cost time but not footsteps.
      try {
        if (game.settings.get(MODULE_ID, "clockMovementEnabled") === false) return;
      } catch (_) { /* setting not registered yet — carry on */ }

      const scene = tokenDoc?.parent;
      if (!scene || scene.id !== canvas?.scene?.id) return;

      const kind = this.sceneKind(scene);
      const gate = shouldCount({
        inCombat: TheClock.inCombat,
        paused: this._paused,
        playerOwned: this._isPlayerOwned(tokenDoc),
        sceneCostsTime: SCENE_KINDS[kind]?.costsTime !== false,
        teleported: changes?.[MODULE_ID]?.teleport === true,
      });
      if (!gate.count) {
        console.log(`${LOG} | ${tokenDoc.name}: not counted — ${gate.reason}`);
        return;
      }

      // ⚠️ WHERE IT CAME FROM MUST BE STAMPED, NOT INFERRED.
      // `preUpdateToken` stamps the pre-move position. If that stamp is missing
      // for any reason, `tokenDoc.x` in THIS hook is already the NEW position,
      // so from === to, the distance is zero, and the move is silently dropped.
      // That is indistinguishable from a broken feature, so say so out loud.
      const stamped = tokenDoc._acePriorX !== undefined && tokenDoc._acePriorY !== undefined;
      const from = { x: tokenDoc._acePriorX ?? tokenDoc.x, y: tokenDoc._acePriorY ?? tokenDoc.y };
      const to   = { x: changes.x ?? tokenDoc.x, y: changes.y ?? tokenDoc.y };
      const feet = feetBetween(from, to, scene.grid?.size, scene.grid?.distance);

      if (!stamped) {
        console.warn(`${LOG} | ${tokenDoc.name}: no pre-move position was stamped — ` +
          `measured ${Math.round(feet)} ft, which may be wrong. preUpdateToken did not fire first.`);
      }

      if (feet < MIN_FEET) {
        console.log(`${LOG} | ${tokenDoc.name}: ${Math.round(feet)} ft — under the ${MIN_FEET} ft floor, treated as a nudge.`);
        return;
      }

      // Clear the stamp so a later move that arrives WITHOUT a fresh one is
      // caught by the warning above instead of silently reusing a stale square.
      delete tokenDoc._acePriorX;
      delete tokenDoc._acePriorY;

      this._legs.push({ id: tokenDoc.id, feet });
      console.log(`${LOG} | ${tokenDoc.name}: +${Math.round(feet)} ft buffered (${this._legs.length} leg(s), ${Math.round(this._carryFeet)} ft carried) — settling in ${SETTLE_MS / 1000}s`);
      this._restartTimer();
    } catch (err) {
      // Movement must never break because timekeeping threw.
      console.warn(`${LOG} | could not measure a move — not charged.`, err);
    }
  }

  /** Does a real player own this token? The GM's own NPCs do not count. */
  static _isPlayerOwned(tokenDoc) {
    const actor = tokenDoc?.actor;
    if (!actor) return false;
    return (game.users ?? []).some(u => !u.isGM && actor.testUserPermission(u, "OWNER"));
  }

  static _restartTimer() {
    if (this._timer) clearTimeout(this._timer);
    this._timer = setTimeout(() => this.settle(), SETTLE_MS);
  }

  static _discard(why) {
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    if (this._legs.length || this._carryFeet) {
      console.log(`${LOG} | dropped ${this._legs.length} buffered leg(s) + ${Math.round(this._carryFeet)} ft carried — ${why}`);
    }
    this._legs = [];
    this._carryFeet = 0;
  }

  /* ─── Settling ──────────────────────────────────────────────────────── */

  /**
   * Spend the buffered walking. Safe to call at any time — other features call
   * this before doing something that needs the clock to be accurate.
   */
  static async settle(reason = "the party stopped moving") {
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    if (!this._legs.length) return null;
    if (!game.user.isGM) { this._legs = []; return null; }

    const legs = this._legs;
    this._legs = [];

    // ⚠️ Furthest traveller, never the sum — then ADD whatever was carried
    // over from previous sub-minute settles.
    const { feet: walked } = journeyDistance(legs);
    const feet = walked + this._carryFeet;
    if (feet < MIN_FEET) { this._carryFeet = feet; return null; }

    const kind = this.sceneKind();
    const pace = this.scenePace();
    const minutes = minutesForDistance(feet, pace, kind);
    const seconds = Math.round(minutes * 60);

    // ⚠️ ADVANCE SECONDS, NOT WHOLE MINUTES.
    // This used to charge only complete minutes and bank the remainder, which
    // meant you could walk 95 ft of a dungeon — most of a level — and watch the
    // clock do absolutely nothing. Johnny: "it is not working at 100, even
    // though it says banked 95". The arithmetic was right and the behaviour was
    // useless: with no visible movement there is no way to tell a working
    // feature from a dead one. World time holds seconds perfectly well; the
    // only thing whole minutes ever protected was the readability of the log,
    // and that is handled below instead.
    if (seconds < 1) { this._carryFeet = feet; return null; }

    const speed = paceSetFor(kind)[pace]?.feetPerMinute ?? "?";
    const detail = `${Math.round(feet)} ft at ${speed} ft/min`;

    // Log a line only once the walking adds up to something worth reading, but
    // ALWAYS move the clock. Short hops still count; they just do not each earn
    // their own entry in the session report.
    this._sinceLogged = (this._sinceLogged ?? 0) + seconds;
    const worthALine = this._sinceLogged >= 60;
    if (worthALine) this._sinceLogged = 0;

    const spent = await TheClock.spend("travel", {
      minutes: seconds / 60, detail, quiet: true, silentLog: !worthALine,
    });

    // ⚠️ ONLY FORGET THE DISTANCE ONCE THE CLOCK HAS ACTUALLY TAKEN IT.
    // The carry used to be zeroed BEFORE the spend, so any walk the clock
    // declined — refused mid-combat, or (the real case) swallowed by a party
    // turn — vanished. The party walked and the ground they covered was simply
    // deleted. Hand it back if it was not charged, so nothing is ever lost.
    if (spent && !spent.refused && (spent.advanceMinutes > 0 || spent.delegated)) {
      this._carryFeet = 0;
    } else {
      this._carryFeet = feet;
      this._sinceLogged = Math.max(0, (this._sinceLogged ?? 0) - seconds);
      console.log(`${LOG} | ${Math.round(feet)} ft NOT charged (${spent?.reason ?? "no result"}) — kept for next time.`);
      return spent;
    }

    console.log(`${LOG} | ${detail} — ${seconds}s${worthALine ? "" : " (accruing)"}`);
    return spent;
  }

  /* ─── Wiring ────────────────────────────────────────────────────────── */

  static register() {
    // Remember where a token was BEFORE the update, so we can measure the leg.
    Hooks.on("preUpdateToken", (tokenDoc, changes) => {
      if (("x" in changes) || ("y" in changes)) {
        tokenDoc._acePriorX = tokenDoc.x;
        tokenDoc._acePriorY = tokenDoc.y;
      }
    });

    Hooks.on("updateToken", (tokenDoc, changes) => this.onTokenMoved(tokenDoc, changes));

    // Combat starting invalidates whatever was buffered — the party is not
    // strolling any more, and those seconds are about to be billed by rounds.
    Hooks.on("combatStart", () => this._discard("combat started"));

    // Changing scene ends the journey; unsettled legs belong to the old map.
    Hooks.on("canvasReady", () => this._discard("scene changed"));

    console.log(`${LOG} | online — walking accrues silently and settles ${SETTLE_MS / 1000}s after the party stops.`);
  }
}
