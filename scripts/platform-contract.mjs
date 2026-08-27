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

/**
 * DATA FIELDS ACE reads out of item and actor documents.
 *
 * ⚠️🔴 WHY THIS CATEGORY EXISTS (2026-08-23). Everything above checks that a
 * METHOD still exists. On 08-23 the same class of drift hit a FIELD instead,
 * and nothing here could see it.
 *
 * Johnny's Spiked Chain says "reach 10 feet." and ACE refused the attack with
 * "out of range — 10 feet away (melee reach 5 feet)". A weapon's range block has four
 * slots — value, long, reach, units — and melee reach lives in `reach`. ACE
 * read `value`. It had not always been wrong: dnd5e ships a migration whose own
 * description is "migrate the range value to the reach field for melee weapons
 * without the thrown property". The number was moved out from under us and
 * every melee weapon in the world was rewritten.
 *
 * Nothing threw. An empty slot and a genuine five-foot weapon are the same
 * thing from the reader's side, so the fallback to 5 feet looked like an answer
 * rather than a question. Months of reach weapons quietly not reaching.
 *
 * ⚠️ A MISSING FIELD IS AS SILENT AS A MISSING METHOD, AND MORE LIKELY. Methods
 * get renamed at major versions and make noise in release notes. Fields get
 * migrated quietly, because the system rewrites your data so ITS code keeps
 * working — and ours is left reading a slot that is now always empty.
 *
 * Add a row whenever you read a new field out of system data. One line.
 */
export const DATA_FIELDS = [
  { doc: "Item", type: "weapon", path: "range.reach",
    used: "melee reach — how far a reach weapon can actually hit",
    note: "dnd5e MIGRATED this out of range.value; reading value alone gives every reach weapon 5 feet" },
  { doc: "Item", type: "weapon", path: "range.value",  used: "ranged normal range" },
  { doc: "Item", type: "weapon", path: "range.long",   used: "ranged long range, and telling thrown from pure melee" },
  { doc: "Item", type: "weapon", path: "range.units",  used: "converting a metric table's reach to the feet the canvas measures in" },
  { doc: "Item", type: "weapon", path: "properties",   used: "reach, thrown, finesse, ammunition and the rest" },
  { doc: "Item", type: "weapon", path: "type.value",   used: "telling a monster's natural attack from a PC's martial weapon" },
];

/**
 * Does a field still exist in a document type's schema?
 *
 * ⚠️ IT RETURNS "unknown", NOT "missing", WHEN IT CANNOT TELL. If the schema
 * cannot be reached — a Foundry version that moved it, a system that does not
 * register data models — reporting every field as missing would produce a wall
 * of false alarms, and an audit that cries wolf is one nobody reads. A wrong
 * report is worse than no report.
 */
function fieldState({ doc, type, path }) {
  try {
    const model = CONFIG?.[doc]?.dataModels?.[type];
    const schema = model?.schema;
    if (!schema) return "unknown";
    if (typeof schema.getField === "function") {
      return schema.getField(path) ? "present" : "missing";
    }
    return "unknown";
  } catch (_) {
    return "unknown";
  }
}

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

  // ⚠️ Fields we READ, as opposed to methods we CALL. Only a definite "missing"
  // is reported; "unknown" means the schema could not be inspected and is
  // counted as unverified rather than guessed at.
  let unverified = 0;
  for (const f of DATA_FIELDS) {
    checked++;
    const state = fieldState(f);
    if (state === "missing") {
      missing.push({ ...f, name: `${f.type}.system.${f.path}`, on: `${f.doc} data` });
    } else if (state === "unknown") {
      unverified++;
    }
  }

  return { missing, checked, unverified };
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
    const { missing, checked, unverified = 0 } = result;

    // ⚠️ SAY WHAT COULD NOT BE CHECKED. A count of "all present" that quietly
    // includes rows nothing could inspect is the same lie as an audit claiming
    // coverage it did not have. Unverified is a third state, and it is printed.
    const unver = unverified
      ? ` (${unverified} data field${unverified === 1 ? "" : "s"} could not be inspected on this build and were NOT verified)`
      : "";

    if (!missing.length) {
      console.log(`${LOG} | ✅ ${checked - unverified} of ${checked} platform APIs confirmed present — dnd5e ${game.system?.version}, Foundry ${game.version}.${unver}`);
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
      // ⚠️ RED, AND IT STAYS UNTIL DISMISSED. Johnny, 2026-08-23: "I want that
      // as a red toast that stays on the screen... obviously attacking is the
      // important part in this whole game." A platform rename or a moved data
      // field silently disables automation, so the one thing that must not
      // happen is this scrolling past unread.
      //
      // ⚠️ IT NO LONGER CALLS EVERYTHING A "function". Data fields joined this
      // check on 08-23, and telling a GM a function is missing when a FIELD
      // moved sends them looking in the wrong place entirely.
      const _fields = missing.filter(m => String(m.on || "").endsWith("data")).length;
      const _fns = missing.length - _fields;
      const _what = _fields && _fns ? `${_fns} game-system function(s) and ${_fields} data field(s)`
                  : _fields        ? `${_fields} game-system data field(s)`
                  :                  `${_fns} game-system function(s)`;
      ui.notifications?.error(
        `ACE: ${_what} ACE relies on ${missing.length === 1 ? "is" : "are"} MISSING on this version of dnd5e. `
        + `Automation that uses ${missing.length === 1 ? "it" : "them"} will silently do nothing — attacks, saves and damage are affected. `
        + `See the console (F12) for exactly which.`,
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
