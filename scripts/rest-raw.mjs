// ─── ACE QOL — The rest rules dnd5e does not enforce ─────────────────────────
//
// dnd5e 5.x already does the mechanical half of a rest well: durations per
// variant (normal 60/480, gritty 480/10080, epic 1/60), hit dice, hit points,
// spell slots, and exhaustionDelta -1 on a long rest. None of that is
// re-implemented here.
//
// What it does NOT check is the three conditions RAW puts on a long rest, all
// of which are GM-facing judgement calls today:
//
//   1. "You can't benefit from more than one Long Rest in a 24-hour period."
//   2. "You must have at least 1 Hit Point at the start of the rest."
//   3. "If the rest is interrupted by strenuous activity — at least 1 hour of
//      walking, fighting, casting spells, or similar adventuring activity —
//      you must restart the rest to gain any benefit from it."
//
// ⚠️ IDENTICAL IN BOTH EDITIONS. The 2014 PHB (p.186) and the 2024 PHB state
// these three in the same terms, so there is no edition gate here and adding
// one would be inventing a difference that does not exist. What DOES differ is
// exhaustion itself (2014's table of six effects vs 2024's flat -2 per level),
// and that is dnd5e's job, not ours.
//
// ⚠️ WE WARN, WE DO NOT VETO — except where the rules leave no room. Rule 2 is
// absolute and blockable. Rule 1 has legitimate table exceptions (a GM ruling
// a rest in a time-dilated demiplane, gritty-realism variants) so it asks. Rule
// 3 cannot be detected reliably at all — a GM knows what "strenuous" means and
// software does not — so it reports what it saw and lets the GM decide.

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
const LOG = "ace-qol | Rest";
const DAY_SECONDS = 24 * 60 * 60;

/** When did this creature last finish a long rest, in world seconds? */
function _lastLongRest(actor) {
  const v = Number(actor?.getFlag?.(MODULE_ID, "lastLongRestWorldTime"));
  return Number.isFinite(v) ? v : null;
}

export const RestRaw = {

  register() {
    // ── Rule 2 + Rule 1: checked BEFORE the rest resolves ──
    Hooks.on("dnd5e.preRestCompleted", (actor, result, config) => {
      try { return RestRaw._preCheck(actor, result, config); }
      catch (err) {
        // ⚠️ A thrown check must never block a rest. If our rule cannot run,
        // the table's rest still happens — failing closed here would mean a bug
        // in ACE stops the party sleeping.
        console.warn(`${LOG} | pre-rest check threw; allowing the rest.`, err);
        return true;
      }
    });

    // ── Stamp the completion so rule 1 has something to measure from ──
    Hooks.on("dnd5e.restCompleted", async (actor, result, config) => {
      try {
        if (!game.user.isGM) return;
        const long = (config?.type ?? result?.type) === "long" || result?.longRest === true;
        if (!long) return;
        await actor.setFlag(MODULE_ID, "lastLongRestWorldTime", game.time?.worldTime ?? 0);
      } catch (err) {
        console.warn(`${LOG} | could not stamp the long rest:`, err);
      }
    });

    console.debug(`${LOG} | RAW rest conditions active`);
  },

  /**
   * @returns {boolean} false blocks the rest.
   */
  _preCheck(actor, result, config) {
    const long = (config?.type ?? result?.type) === "long" || result?.longRest === true;
    if (!long) return true;

    // ── Rule 2: at least 1 HP at the start. Absolute — no ruling needed. ──
    const hp = Number(actor?.system?.attributes?.hp?.value);
    if (Number.isFinite(hp) && hp <= 0) {
      ui.notifications?.warn(
        `${actor.name} is at 0 hit points and cannot benefit from a long rest. ` +
        `RAW: a creature must have at least 1 hit point at the start of the rest.`);
      console.log(`${LOG} | long rest BLOCKED for ${actor.name} — 0 HP at the start.`);
      return false;
    }

    // ── Rule 1: one long rest per 24 hours. Asks, does not veto. ──
    const last = _lastLongRest(actor);
    const now  = game.time?.worldTime ?? 0;
    if (last !== null && (now - last) < DAY_SECONDS) {
      const hours = Math.floor((now - last) / 3600);
      const mins  = Math.floor(((now - last) % 3600) / 60);
      const since = hours ? `${hours}h ${mins}m` : `${mins}m`;
      // ⚠️ Console + toast, not a blocking dialog. dnd5e's pre-hook is
      // synchronous, so a confirm() here cannot be awaited — returning false
      // would silently veto a rest the GM may well intend to allow.
      ui.notifications?.warn(
        `${actor.name} last finished a long rest ${since} ago. RAW allows only one ` +
        `long rest per 24 hours — this one gives no benefit unless you rule otherwise.`);
      console.warn(`${LOG} | ${actor.name} is resting again after only ${since}. RAW: one long rest per 24 hours.`);
    }

    // ── Rule 3: report what the clock saw. Never blocks. ──
    RestRaw._reportInterruption(actor, config);
    return true;
  },

  /**
   * Did anything happen during the rest that RAW would call strenuous?
   *
   * ⚠️ THIS CANNOT BE DECIDED IN SOFTWARE AND DOES NOT TRY. "At least 1 hour of
   * walking, fighting, casting spells, or similar adventuring activity" needs a
   * human to weigh "similar". What IS knowable is whether a combat ran while
   * the rest was in progress, which is the overwhelmingly common case, so that
   * is what gets said — as information, not a verdict.
   */
  _reportInterruption(actor, config) {
    try {
      if (!game.combat?.started) return;
      const mins = Number(config?.duration) || 0;
      ui.notifications?.info(
        `Combat is running while ${actor.name} takes a ${mins ? mins + "-minute " : ""}long rest. ` +
        `RAW: an hour of fighting interrupts it and the rest must start over — your call.`);
      console.log(`${LOG} | ${actor.name} rested with a combat active — flagged for the GM, not blocked.`);
    } catch (_) { /* reporting must never break a rest */ }
  },

  /** Console helper: why was (or wasn't) this rest allowed? */
  explain(actor) {
    const out = [];
    if (!actor) return ["No actor — pass one, e.g. canvas.tokens.controlled[0].actor"];
    const hp = Number(actor?.system?.attributes?.hp?.value);
    out.push(`${actor.name}: ${hp} hit point(s) — ${hp > 0 ? "may rest" : "CANNOT benefit from a long rest (RAW: needs at least 1)"}`);
    const last = _lastLongRest(actor);
    if (last === null) out.push("No long rest recorded yet, so the 24-hour rule cannot bite.");
    else {
      const since = (game.time?.worldTime ?? 0) - last;
      const h = Math.floor(since / 3600);
      out.push(`Last long rest ${h}h ago — ${since >= DAY_SECONDS ? "clear of the 24-hour rule" : "INSIDE the 24-hour window, RAW gives no benefit"}`);
    }
    out.push(game.combat?.started ? "A combat is running — an hour of it would interrupt the rest." : "No combat running.");
    out.forEach(l => console.log(`${LOG} | ${l}`));
    return out;
  },
};
