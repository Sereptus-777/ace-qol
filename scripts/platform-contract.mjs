// ─── ACE QOL — Platform API contract ──────────────────────────────────────────
//
// 🔴 WHY THIS EXISTS
//
// On 2026-08-12 an audit found SIX live faults with one shared cause: ACE was
// calling dnd5e methods that dnd5e 5.x had renamed, and nothing anywhere said
// so. The worst of them:
//
//   • `actor.rollAbilitySave?.(…)` — renamed to `rollSavingThrow` in 5.x. The
//     optional-call returned `undefined` instead of throwing, the result fell
//     through to `?? 0`, and EVERY OverTime saving throw scored 0 and failed.
//     A burning creature could never put itself out. The card printed a
//     confident "FAIL" next to it. It had been doing that for months.
//
//   • `actor.rollSkillV2?.(…)` — never existed in 5.x. The Hide action fell
//     through to the 4.x signature and rolled a BARE d20: no Stealth
//     proficiency, no Dexterity. A rogue with +11 hid on a flat die.
//
// Neither is visible to any tool we run. `node --check` sees valid syntax.
// ESLint's `no-undef` sees a property on a runtime object, not an identifier.
// The tests pass because the code never throws. The only way to catch this
// class is to STATE what we depend on and check it against the running system.
//
// ⚠️ THIS IS A REPORT, NOT A GATE. It never blocks, never patches, never
// disables a feature. It prints — loudly, once, at startup, to the GM — so that
// a platform rename is a message on day one instead of a mystery weeks later.
// Foundry V14 and dnd5e 6.x will do this to us again; when they do, this is the
// thing that says which call went quiet.
//
// See lesson_the_silent_catch_is_the_bug.md and
// lesson_logs_and_cards_must_report_outcome.md.
// ──────────────────────────────────────────────────────────────────────────────

const MODULE_ID = "ace-qol";
const LOG = "ace-qol | PlatformContract";

/**
 * Everything ACE calls on a dnd5e Actor. `renamedFrom` records the name that
 * USED to work, so the console line can say what to search for.
 *
 * Add a row whenever you write a new call against a system API. The cost is one
 * line; the alternative is another silent month.
 */
export const ACTOR_METHODS = [
  { name: "rollSavingThrow",  renamedFrom: "rollAbilitySave", used: "saves, overtime effects, traps, Dominate re-saves" },
  { name: "rollAbilityCheck", renamedFrom: "rollAbilityTest", used: "breaking free of a grapple or restraint" },
  { name: "rollSkill",        used: "the Hide action, searching" },
  { name: "rollDeathSave",    used: "death saves" },
  { name: "rollConcentration",used: "concentration checks" },
  { name: "applyDamage",      used: "THE damage chokepoint — every point of damage ACE deals" },
  { name: "toggleStatusEffect", used: "applying and clearing every condition" },
  { name: "getRollData",      used: "every formula ACE builds" },
];

/** Everything ACE calls on a Foundry TokenDocument or Token. */
export const TOKEN_METHODS = [
  { name: "setFlag",    used: "hidden state, loot snapshots, identity" },
  { name: "unsetFlag",  used: "clearing the above" },
  { name: "toggleCombat", optional: true, used: "combat toggling" },
];

/** Globals and namespaced calls ACE cannot work without. */
export const GLOBALS = [
  { path: "CONFIG.Canvas.polygonBackends.move.testCollision",
    used: "wall checks — party transfer, secret doors, line of sight",
    note: "canvas.walls.checkCollision does NOT exist in V13; this is THE call" },
  { path: "CONFIG.DND5E.abilities",  used: "ability labels on every card" },
  { path: "CONFIG.DND5E.skills",     used: "skill labels" },
  { path: "CONFIG.statusEffects",    used: "condition icons and ids" },
  { path: "foundry.data.regionBehaviors.RegionBehaviorType",
    used: "Forge's Ground Level and Trap region behaviours" },
];

/** Walk a dotted path without throwing. */
function at(path) {
  try {
    return path.split(".").reduce((o, k) => (o == null ? o : o[k]), globalThis);
  } catch (_) { return undefined; }
}

/**
 * Check the contract against what is actually loaded.
 * @returns {{missing: object[], checked: number}}
 */
export function checkContract() {
  const missing = [];
  let checked = 0;

  // A representative Actor and Token to probe. Prototypes would be cleaner, but
  // dnd5e subclasses by actor type, so a real document is the honest test.
  const actor = game.actors?.find(a => a.type === "npc") ?? game.actors?.contents?.[0] ?? null;
  const tokenDoc = canvas?.scene?.tokens?.contents?.[0]
    ?? game.scenes?.contents?.flatMap(s => s.tokens?.contents ?? [])?.[0]
    ?? null;

  if (actor) {
    for (const m of ACTOR_METHODS) {
      checked++;
      if (typeof actor[m.name] !== "function") missing.push({ ...m, on: "Actor" });
    }
  }
  if (tokenDoc) {
    for (const m of TOKEN_METHODS) {
      checked++;
      if (m.optional) continue;
      if (typeof tokenDoc[m.name] !== "function") missing.push({ ...m, on: "TokenDocument" });
    }
  }
  for (const g of GLOBALS) {
    checked++;
    if (at(g.path) === undefined) missing.push({ ...g, name: g.path, on: "global" });
  }

  return { missing, checked };
}

export class PlatformContract {

  /**
   * Run the check and print the result. Safe to call by hand at any time —
   * `game.aceQol.contract.report()` — so verifying it does not mean scrolling
   * back through a session's worth of console.
   * @param {boolean} [toast]  raise a GM notification when something is missing
   * @returns {{missing: object[], checked: number}}
   */
  static report({ toast = true } = {}) {
    const result = checkContract();
    const { missing, checked } = result;

    if (!missing.length) {
      console.log(`${LOG} | ✅ ${checked} platform APIs present — dnd5e ${game.system?.version}, Foundry ${game.version}.`);
      return result;
    }

    // ⚠️ NAME THE FEATURE, NOT JUST THE METHOD. "rollSavingThrow is missing"
    // means nothing on its own; "saves, overtime effects, traps" is what says
    // which part of the game just went quiet.
    console.error(`${LOG} | ${missing.length} of ${checked} platform APIs ACE depends on are MISSING on dnd5e ${game.system?.version} / Foundry ${game.version}:`);
    for (const m of missing) {
      const was = m.renamedFrom ? `  (this was called "${m.renamedFrom}" in dnd5e 4.x)` : "";
      console.error(`  • ${m.on}.${m.name} — needed for: ${m.used}${was}`);
      if (m.note) console.error(`      ${m.note}`);
    }
    if (toast) {
      ui.notifications?.error(
        `ACE: ${missing.length} game-system function${missing.length === 1 ? "" : "s"} ACE relies on ${missing.length === 1 ? "is" : "are"} missing — some automation will silently do nothing. See the console (F12).`,
        { permanent: true });
    }
    return result;
  }

  static register() {
    const run = () => {
      try {
        if (game.users?.activeGM !== game.user) return;
        PlatformContract.report();
      } catch (err) {
        console.error(`${LOG} | contract check failed:`, err);
      }
    };

    // ⚠️ 🔴 SAME TRAP AS THE GHOST SWEEPER (2026-08-12). `register()` runs from
    // INSIDE ace-qol's ready handler, so `Hooks.once("ready", …)` here would
    // wait on an event that has already fired and never run. The proof was that
    // this report only ever appeared when it was called by hand from the
    // console — never at load. A boot check that does not run at boot is worse
    // than none, because its silence reads as a pass.
    if (game.ready) run();
    else Hooks.once("ready", run);

    console.log(`${LOG} | online`);
  }
}
