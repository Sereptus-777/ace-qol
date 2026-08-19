// ─── ACE QOL — THE CLOCK (Foundry side) ───────────────────────────────────────
//
// The single place ACE advances world time. Every feature that costs time calls
// `TheClock.spend(...)` and nothing calls `game.time.advance` directly.
//
// The rules live in `time-costs.mjs` as pure functions so they can be proved
// outside Foundry. This file is only the plumbing: permissions, state, the
// socket hop, and telling the human what just happened.
//
// ⚠️ ONLY A GM CAN WRITE WORLD TIME. `game.time.advance` writes the `core.time`
// world setting, which Foundry refuses for players. A player clicking Search
// must therefore ASK the GM, exactly like the save and search paths already do.
// And the GM must verify the sender rather than trust the payload — a socket
// message is just data a client chose to send.
// ──────────────────────────────────────────────────────────────────────────────

import { MODULE_ID } from "./ace-qol.mjs";
import { resolveSpend, labelOf, describeMinutes, TIME_COSTS } from "./time-costs.mjs";

const LOG = "ace-qol | TheClock";

/** Anything longer than this gets an "are you sure" with what it will end. */
const CONFIRM_THRESHOLD_MIN = 60;

export class TheClock {
  static SOCKET_ACTION = "clockSpend";

  /**
   * The party's current turn window. Deliberately in memory, not a setting:
   * it describes what is happening in the next few minutes of play, and a
   * stale one surviving a reload would silently make the next action free.
   */
  static _window = { openedAt: null, minutes: 0 };

  /** Everything spent this session, so the GM can see where the day went. */
  static _log = [];

  /* ─── Reading the world ─────────────────────────────────────────────── */

  static get now() { return Number(game.time?.worldTime) || 0; }

  /** Is ACE allowed to touch the clock at all? Defaults to yes if unreadable. */
  static _enabled() {
    try { return game.settings.get(MODULE_ID, "clockEnabled") !== false; }
    catch (_) { return true; }
  }

  /**
   * Is a combat actually running? Only a STARTED combat bills round time —
   * an encounter sitting in the tracker with no initiative rolled does not,
   * so exploring beside one must still cost time.
   */
  static get inCombat() {
    return (game.combats?.contents ?? []).some(c => c.started && c.scene?.id === canvas?.scene?.id)
        || (game.combat?.started === true);
  }

  static get state() {
    return {
      windowOpenedAt: this._window.openedAt,
      windowMinutes:  this._window.minutes,
      inCombat:       this.inCombat,
      now:            this.now,
      // Real wall-clock time — the party turn is table simultaneity, not
      // world time. See PARTY_TURN_REAL_MS in time-costs.mjs.
      nowReal:        Date.now(),
    };
  }

  /* ─── Spending ──────────────────────────────────────────────────────── */

  /**
   * Spend time for something the party did.
   *
   * @param {string} key            a key from TIME_COSTS
   * @param {object} [opts]
   * @param {number} [opts.minutes] required for dynamic costs (harvest, talk)
   * @param {string} [opts.detail]  "the deer", "the north corridor"
   * @param {boolean} [opts.force]  spend even during combat
   * @param {boolean} [opts.quiet]  no chat card (console + log only)
   * @returns {Promise<object>} the resolution, so callers can report honestly
   */
  static async spend(key, opts = {}) {
    // ⚠️ THE MASTER SWITCH, HONOURED HERE AND NOWHERE ELSE. Every consumer
    // funnels through this method, so one check turns the whole subsystem off.
    // Checking it per-feature would inevitably miss a path that kept writing.
    if (!this._enabled()) {
      return { advanceMinutes: 0, refused: true, rode: false, window: null,
               reason: "time tracking is switched off in ACE QOL settings" };
    }

    const decision = resolveSpend(this.state, { key, minutes: opts.minutes, force: opts.force });

    // ⚠️ REPORT THE OUTCOME, NOT THE INTENTION. Callers show the user what
    // came back from here — never "that took 10 minutes" before asking.
    if (decision.refused) {
      console.warn(`${LOG} | refused "${key}": ${decision.reason}`);
      return decision;
    }

    if (decision.window) this._window = { ...decision.window };

    if (decision.advanceMinutes <= 0) {
      // Rode along on the party's turn, or genuinely free. Still worth saying
      // so — a GM who sees nothing happen assumes the feature is broken.
      console.log(`${LOG} | "${key}" cost nothing — ${decision.reason}`);
      if (!opts.quiet && decision.rode) {
        ui.notifications?.info(`${labelOf(key)} — no extra time; ${decision.reason}.`);
      }
      return decision;
    }

    // Players cannot write world time. Ask the GM and let them run this path.
    if (!game.user.isGM) {
      game.socket.emit(`module.${MODULE_ID}`, {
        action: this.SOCKET_ACTION,
        userId: game.user.id,
        key, minutes: opts.minutes, detail: opts.detail, force: opts.force, quiet: opts.quiet,
      });
      console.log(`${LOG} | not a GM — asked the GM to spend ${decision.advanceMinutes} min for "${key}"`);
      return { ...decision, delegated: true };
    }

    await this._apply(decision, key, opts);
    return decision;
  }

  /** GM-side: actually move the clock. */
  static async _apply(decision, key, opts = {}) {
    const mins = decision.advanceMinutes;

    // A big jump will expire effects. Say what, BEFORE doing it.
    if (mins >= CONFIRM_THRESHOLD_MIN && !opts.force) {
      const doomed = this._effectsEndingWithin(mins);
      if (doomed.length) {
        console.log(`${LOG} | ${describeMinutes(mins)} will end: ${doomed.join(", ")}`);
        ui.notifications?.warn(
          `${describeMinutes(mins)} passes — this ends ${doomed.length} effect${doomed.length === 1 ? "" : "s"}: ${doomed.slice(0, 4).join(", ")}${doomed.length > 4 ? "…" : ""}`);
      }
    }

    try {
      // ⚠️ SECONDS, NOT MINUTES. Callers may pass a fraction — walking 95 ft at
      // 100 ft/min is 0.95 of a minute, and `{minute: 0.95}` would be floored
      // away to nothing by Foundry, which is exactly how the clock appeared
      // dead while the party crossed a dungeon.
      await game.time.advance({ second: Math.round(mins * 60) });
    } catch (err) {
      // Never let a failed advance look like a success.
      console.error(`${LOG} | FAILED to advance the clock by ${mins} min for "${key}".`, err);
      ui.notifications?.error(`The clock did not move — ${labelOf(key)} was not charged. See the console.`);
      return;
    }

    const entry = {
      key, minutes: mins, detail: opts.detail ?? "",
      label: labelOf(key), at: this.now,
    };
    // `silentLog` folds small accruals into the previous entry of the same kind
    // rather than filling the report with one line per footstep. The TIME is
    // always spent — only the bookkeeping is condensed.
    const prev = this._log[this._log.length - 1];
    if (opts.silentLog && prev?.key === key) {
      prev.minutes += mins;
      prev.detail = opts.detail ?? prev.detail;
      prev.at = this.now;
    } else {
      this._log.push(entry);
    }
    console.log(`${LOG} | +${mins} min — ${entry.label}${entry.detail ? ` (${entry.detail})` : ""}`);

    if (!opts.quiet) {
      ui.notifications?.info(`${entry.label}${entry.detail ? ` — ${entry.detail}` : ""}: ${describeMinutes(mins)} passes.`);
    }
  }

  /**
   * Names of active effects that would end inside the given span.
   * Best-effort and read-only — this is a courtesy warning, never a gate.
   */
  static _effectsEndingWithin(minutes) {
    const out = [];
    const seconds = minutes * 60;
    try {
      for (const actor of game.actors ?? []) {
        for (const eff of actor.effects ?? []) {
          if (eff.disabled) continue;
          const remaining = Number(eff.duration?.remaining);
          if (Number.isFinite(remaining) && remaining > 0 && remaining <= seconds) {
            out.push(`${eff.name} (${actor.name})`);
          }
        }
      }
    } catch (err) {
      console.warn(`${LOG} | could not read effect durations — warning skipped, not suppressed.`, err);
    }
    return out;
  }

  /* ─── The session log ───────────────────────────────────────────────── */

  /** What the day cost, itemised. This is what makes a GM trust the clock. */
  static report() {
    if (!this._log.length) return "No time has been spent through ACE this session.";
    const total = this._log.reduce((n, e) => n + e.minutes, 0);
    const lines = this._log.map(e =>
      `  ${describeMinutes(e.minutes).padStart(18)}  ${e.label}${e.detail ? ` — ${e.detail}` : ""}`);
    return `Time spent this session: ${describeMinutes(total)}\n${lines.join("\n")}`;
  }

  static clearWindow() { this._window = { openedAt: null, minutes: 0 }; }

  /* ─── Wiring ────────────────────────────────────────────────────────── */

  static register() {
    // A combat starting or ending invalidates the party's turn window — the
    // party is no longer "spending ten minutes on this", they are fighting.
    Hooks.on("combatStart", () => this.clearWindow());
    Hooks.on("deleteCombat", () => this.clearWindow());

    console.log(`${LOG} | online — ${Object.keys(TIME_COSTS).length} costed actions registered.`);
  }

  /**
   * GM-side socket handler. ⚠️ Verify the sender is a real, present user before
   * moving the world clock on their say-so.
   */
  static async onSocket(payload) {
    if (!game.user.isGM) return;

    // ⚠️🔴 THE PAYLOAD USED TO NAME ITS OWN PRICE (Brock audit, 2026-08-19).
    // `minutes` and `force` were taken straight from the wire, so any client
    // could advance world time by any amount. That is not a cosmetic clock:
    // world time expires conditions and spell durations, moves daylight, and
    // decides when a rest is available. A player could skip a night, burn off
    // a curse, or push a hunt past dawn from their own console.
    //
    // The fix is not a bigger number check. It is that THE COST TABLE IS THE
    // AUTHORITY, not the message. For every key with a fixed cost the payload's
    // minutes are ignored outright, which removes the attack from most of the
    // table. Only genuinely dynamic keys (travel, harvest, conversation) carry
    // a number, and those are clamped.
    const sender = game.users?.get(payload?.userId);
    if (!sender) {
      console.warn(`${LOG} | ignored a time request from an unknown user.`);
      return;
    }
    if (sender.isGM) {
      console.warn(`${LOG} | refused a time request claiming GM "${sender.name}" — a GM spends locally.`);
      return;
    }
    if (!sender.active) {
      console.warn(`${LOG} | refused a time request from "${sender.name}", who is not connected.`);
      return;
    }

    const entry = TIME_COSTS[payload?.key];
    if (!entry) {
      console.warn(`${LOG} | refused a time request from "${sender.name}" — "${payload?.key}" is not a known action.`);
      return;
    }

    // Fixed-cost key: the table decides, full stop.
    let minutes = payload?.minutes;
    if (Number.isFinite(entry.minutes)) {
      minutes = undefined;
    } else {
      // Dynamic key. It must be a real number, and it is capped at the longest
      // legitimate entry in the table (a long rest, 480 minutes) so no single
      // player action can advance more than a day's worth of world time.
      const asked = Number(minutes);
      if (!Number.isFinite(asked) || asked < 0) {
        console.warn(`${LOG} | refused "${payload.key}" from "${sender.name}" — no usable duration.`);
        return;
      }
      const CAP = 480;
      if (asked > CAP) {
        console.warn(`${LOG} | clamped "${payload.key}" from "${sender.name}": asked ${asked} min, capped at ${CAP}.`);
      }
      minutes = Math.min(asked, CAP);
    }

    await this.spend(payload.key, {
      minutes,
      detail: typeof payload.detail === "string" ? payload.detail.slice(0, 200) : undefined,
      // ⚠️ `force` means "spend even during combat", which is a GM override.
      // A player asking for it is asking to bypass the combat guard.
      force: false,
      quiet: !!payload.quiet,
    });
  }
}
