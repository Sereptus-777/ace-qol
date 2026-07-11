// ─── ACE: QOL — Action Interceptor (Phase 0: the universal audit) ─────────────
//
// "Every button push is ours and we're going to look at it." This module is
// the PROOF of that claim: it hooks the earliest dnd5e activity-use point —
// dnd5e.preUseActivity fires for EVERY activity on EVERY actor, including
// activities used by SUMMONED creatures (the Summon Fey's own Darkness cast
// flows through here on whichever client drives it) — and records what it saw.
//
// Phase 0 contract: OBSERVE, NEVER STEER.
//   • Never returns false (never cancels a use).
//   • Never mutates the usage config.
//   • Everything wrapped so a failure here can never break a cast.
//   • Output is console.debug (invisible unless the console's Verbose level
//     is on) — except an unknown ACTIVITY TYPE, which warns once per session:
//     that's a coverage hole in the engine and we want to hear about it.
//
// What each sighting records:
//   actor → item → activity type → which ACE system is expected to own it →
//   whether the rules brain has a data entry for it → the attacker profile
//   (exercising Phase 0's formalized shape on live traffic).
// ──────────────────────────────────────────────────────────────────────────────

import { MODULE_ID } from "../ace-qol.mjs";
import { buildAttackerProfile } from "./attacker-profile.mjs";
import { RulesBrain } from "../rules/rules-brain.mjs";

// dnd5e 5.x activity types we know exist. Anything outside this set is a
// coverage hole worth a one-time warning.
const KNOWN_ACTIVITY_TYPES = new Set([
  "attack", "cast", "check", "damage", "enchant", "forward",
  "heal", "order", "save", "summon", "transform", "utility",
]);

// Which ACE system is expected to own each activity type today. Informational —
// this is the audit's map of the engine, printed with each sighting.
const EXPECTED_OWNER = {
  attack: "attack-pipeline",
  save: "save-engine",
  damage: "spell-auto-damage / damage-engine",
  heal: "heal-pipeline",
  cast: "spell-pipeline",
  summon: "dnd5e native (+ token-art / engine hooks)",
  utility: "rules-brain (space entry) or dnd5e native",
  enchant: "dnd5e native",
  check: "dnd5e native",
  forward: "dnd5e native (delegates to linked activity)",
  order: "dnd5e native",
  transform: "transformation-engine",
};

export class ActionInterceptor {

  /** Activity types we've already warned about this session. */
  static _warnedTypes = new Set();

  /** Spell/item names whose rules-data coverage gap we've already noted. */
  static _rollingCount = 0;

  static register() {
    Hooks.on("dnd5e.preUseActivity", (activity, _usageConfig) => {
      try {
        ActionInterceptor._observe(activity);
      } catch (err) {
        // The audit must NEVER interfere with play.
        console.debug(`${MODULE_ID} | [interceptor] observe failed (non-fatal):`, err);
      }
      // No return value — never cancels, never steers.
    });

    console.log(`${MODULE_ID} | ActionInterceptor online — universal action audit (Phase 0)`);
  }

  static _observe(activity) {
    const item = activity?.item;
    const actor = activity?.actor ?? item?.actor;
    if (!item || !actor) return;

    const aType = String(activity?.type ?? "unknown");

    // ── Coverage hole: an activity type we don't know about ──
    if (!KNOWN_ACTIVITY_TYPES.has(aType) && !ActionInterceptor._warnedTypes.has(aType)) {
      ActionInterceptor._warnedTypes.add(aType);
      console.warn(
        `${MODULE_ID} | [interceptor] UNKNOWN activity type "${aType}" `
        + `(${actor.name} → "${item.name}") — the engine has no classification for this. `
        + `Add it to KNOWN_ACTIVITY_TYPES + EXPECTED_OWNER once triaged.`
      );
    }

    // ── The sighting — one compact debug line per button push ──
    const profile = buildAttackerProfile(actor, { item, activity });
    let rules = null;
    try { rules = RulesBrain.lookup(item, { actor }); } catch (_) {}

    ActionInterceptor._rollingCount++;
    console.debug(
      `${MODULE_ID} | [interceptor #${ActionInterceptor._rollingCount}] `
      + `${actor.name} uses "${item.name}" [${item.type}/${aType}] `
      + `owner=${EXPECTED_OWNER[aType] ?? "?"} `
      + `edition=${profile?.edition ?? "?"} `
      + `rules-entry=${rules ? "YES" : "no"} `
      + `gate=${profile?.gate?.ok === false ? `BLOCKED(${profile.gate.reason})` : "ok"}`,
      { profile, rules }
    );
  }
}
