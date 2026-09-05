// ─── ACE: QOL — THE READING. One question, asked once, before anything acts ──
//
// Johnny, 2026-09-05, after an hour spent finding out why three heal spells did
// nothing: "Any time I push a button, I want the engine to kick in to read what
// that button is, what it does, where it belongs, what it is, what type it is,
// what it affects, the whole thing."
//
// ⚠️🔴 THIS FILE USED TO BE AN OBSERVER THAT NEVER SPOKE. Its contract said
// "OBSERVE, NEVER STEER", it printed one line at console.debug, and console.debug
// is the Verbose level, which is off by default. So it worked out what every
// button was, every time, and threw the answer away where nobody could see it
// and nothing could use it. A layer nothing calls is the same bug wearing a hat.
//
// ⚠️🔴 AND IT WAS NOT EVEN UNIVERSAL. It registered at ace-qol.mjs line 2103.
// The heal pipeline registers at line 1871 and returns false, and Foundry's
// `Hooks.call` STOPS THE ENTIRE CHAIN at the first false. So this audit had
// never once seen a heal in its life. It now registers at INIT, ahead of every
// ready-time handler, so nothing can cancel a cast before the engine has said
// what the thing is.
//
// What it does now, in order, on every button press:
//   1. Works out what the item is, from the item itself.
//   2. Asks the books what it should be — 2014 and 2024 kept apart.
//   3. Reports any disagreement between the two, in plain English, on screen.
//      ⚠️ THE ITEM ALWAYS WINS THE ROLL. A disagreement is a sentence, never
//      an edit and never a different die.
//   4. Publishes the answer so the pipelines can read it instead of each
//      working it out again and getting a different result.
//   5. Watches. If nobody claims the button and nothing appears on screen, it
//      SAYS SO, naming the item. Silence stops being possible.
//
// It still never cancels and never steers.
// ──────────────────────────────────────────────────────────────────────────────

import { buildAttackerProfile } from "./attacker-profile.mjs";
import { RulesBrain } from "../rules/rules-brain.mjs";
import { SpellPipeline } from "../spell-pipeline/pipeline.mjs";
import { classifyItem } from "../inference/classify-item.mjs";
import { RulesIndex } from "../rules/rules-index.mjs";
import { readMechanics, compareToBook, isCantrip, filterForCantrip } from "../rules/rules-compare.mjs";

// ⚠️ HARDCODED. This file is reached from the entry file; importing MODULE_ID
// back would be a cycle, and a const read at top level inside a cycle throws at
// load and kills the module (2026-08-28).
const MODULE_ID = "ace-qol";
const LOG = `${MODULE_ID} | reading`;

/** How long to wait for something to appear before calling it silence. */
const SILENCE_MS = 2500;

// dnd5e 5.x activity types we know exist. Anything outside this set is a
// coverage hole worth a one-time warning.
const KNOWN_ACTIVITY_TYPES = new Set([
  "attack", "cast", "check", "damage", "enchant", "forward",
  "heal", "order", "save", "summon", "transform", "utility",
]);

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

/**
 * Who is ACTUALLY going to handle this action?
 *
 * ⚠️🔴 THE TABLE ABOVE ANSWERS FROM THE ACTIVITY TYPE ALONE, AND THAT IS NOT
 * WHO HANDLES IT. Eldritch Blast is an "attack" activity, so this said
 * `owner=attack-pipeline` on every cast while the SPELL pipeline rolled every
 * beam. Johnny read that line hunting the duplicate-picker bug on 2026-08-25
 * and it pointed him at the wrong file. Ask the owner, then fall back.
 */
function _ownerOf(item, aType) {
  try {
    if (SpellPipeline.owns(item)) {
      return SpellPipeline.ownsAttackRoll(item)
        ? "spell-pipeline (native attack roll suppressed)"
        : "spell-pipeline";
    }
  } catch (_) { /* fall through to the guess */ }
  return EXPECTED_OWNER[aType] ?? "?";
}

export class ActionInterceptor {

  /** Activity types we've already warned about this session. */
  static _warnedTypes = new Set();

  /** Items whose book disagreement has already been reported this session. */
  static _reportedDisagreements = new Set();

  static _rollingCount = 0;

  /** The most recent reading per activity id, for the pipelines to read. */
  static _readings = new Map();

  /** Presses still waiting to see something happen. */
  static _inFlight = new Set();

  static _witnessesWired = false;

  /* ── Boot ──────────────────────────────────────────────────────────────── */

  static register() {
    // ⚠️ FIRST IN THE CHAIN, BY REGISTERING AT INIT. Every other handler on
    // this event registers during ready. Foundry runs them in registration
    // order and stops dead at the first `false`, so being first is the only
    // way to be certain the engine has spoken before anything cancels.
    Hooks.on("dnd5e.preUseActivity", (activity, _usageConfig) => {
      try {
        ActionInterceptor.read(activity);
      } catch (err) {
        // ⚠️ THE READING MUST NEVER INTERFERE WITH PLAY, but it must not be
        // silent about its own failure either: a reading that did not happen
        // means the pipelines below are back to guessing.
        console.error(`${LOG} | could not read this action (play continues, pipelines `
          + `fall back to their own guesses):`, err);
      }
      // No return value — never cancels, never steers.
    });

    ActionInterceptor._wireWitnesses();

    // The books, indexed in the background. Nothing waits on it: a press that
    // lands before it finishes gets "the index is not ready", which is a real
    // answer, not a wrong one.
    RulesIndex.build().catch(err =>
      console.error(`${LOG} | the rules index failed to build — book checking is off:`, err));

    console.log(`${LOG} | online — every button is read before anything may cancel it`);
  }

  /**
   * Anything that counts as "something happened".
   *
   * ⚠️ SHEET RE-RENDERS ARE DELIBERATELY NOT WITNESSES. A sheet redraws for a
   * dozen unrelated reasons and would mask a genuinely dead button, which is
   * the whole thing this is here to catch.
   */
  static _wireWitnesses() {
    if (ActionInterceptor._witnessesWired) return;
    ActionInterceptor._witnessesWired = true;
    const saw = (why) => () => {
      for (const r of ActionInterceptor._inFlight) if (!r.sawSomething) r.sawSomething = why;
    };
    Hooks.on("createChatMessage", saw("a chat card appeared"));
    Hooks.on("createMeasuredTemplate", saw("a template was placed"));
    Hooks.on("renderDialogV2", saw("a dialog opened"));
    Hooks.on("renderRollConfigurationDialog", saw("a roll dialog opened"));
  }

  /* ── The reading ───────────────────────────────────────────────────────── */

  /**
   * A pipeline saying "this one is mine".
   *
   * ⚠️ CLAIMING IS NOT DOING. A claim only stops the silence warning if
   * something also appears; a pipeline that claims a button and then produces
   * nothing is exactly the heal pipeline's template branch, and that must still
   * be reported. So a claim is recorded and NAMED in the warning rather than
   * suppressing it.
   */
  static claim(activity, who) {
    const r = ActionInterceptor._readings.get(activity?.id);
    if (r) r.claimedBy = String(who ?? "someone");
  }

  /** The answer for an activity, for any pipeline that wants it. */
  static readingFor(activity) {
    return ActionInterceptor._readings.get(activity?.id) ?? null;
  }

  static read(activity) {
    const item = activity?.item;
    const actor = activity?.actor ?? item?.actor;
    if (!item || !actor) return null;

    const aType = String(activity?.type ?? "unknown");

    // ── Coverage hole: an activity type we don't know about ──
    if (!KNOWN_ACTIVITY_TYPES.has(aType) && !ActionInterceptor._warnedTypes.has(aType)) {
      ActionInterceptor._warnedTypes.add(aType);
      console.warn(`${LOG} | UNKNOWN activity type "${aType}" (${actor.name} → "${item.name}") `
        + `— the engine has no classification for this.`);
    }

    const profile = _safe(() => buildAttackerProfile(actor, { item, activity }), null);
    const curated = _safe(() => RulesBrain.lookup(item, { actor }), null);
    const edition = _safe(() => RulesBrain.resolveEdition(item, actor), "2014");

    // ⚠️ THE CURATED ENTRY WINS WHERE ONE EXISTS — it encodes rulings no
    // structure can express (Colour Spray's hit-point pool is not in any
    // field). Everything else is WORKED OUT from the item, which is the whole
    // point: a hand-written list of 124 spells can never cover his world.
    let shape = curated?.entry?.shape ?? null;
    let source = shape ? "curated" : null;
    let confidence = shape ? "curated" : null;
    if (!shape) {
      const worked = _safe(() => classifyItem(item), null);
      shape = worked?.shape ?? null;
      confidence = worked?.confidence ?? null;
      source = shape ? "worked-out" : "unknown";
    }

    const reading = {
      id: activity.id,
      at: Date.now(),
      actor, actorName: actor.name,
      item, itemName: item.name, itemType: item.type,
      activityType: aType,
      edition,
      shape, source, confidence,
      owner: _ownerOf(item, aType),
      profile,
      curated,
      book: null,
      disagreements: [],
      claimedBy: null,
      sawSomething: false,
    };
    ActionInterceptor._readings.set(activity.id, reading);

    ActionInterceptor._rollingCount++;
    console.log(`${LOG} | #${ActionInterceptor._rollingCount} ${actor.name} used "${item.name}" `
      + `[${item.type}/${aType}] — ${edition} rules, shape=${shape ?? "unknown"} (${source}), `
      + `owner=${reading.owner}`);

    // ── The book check and the silence watch, both off the critical path ──
    ActionInterceptor._checkAgainstBooks(reading).catch(err =>
      console.warn(`${LOG} | book check failed for "${item.name}":`, err));
    ActionInterceptor._watchForSilence(reading);

    return reading;
  }

  /* ── Do the books agree? ───────────────────────────────────────────────── */

  static async _checkAgainstBooks(reading) {
    const { item, edition } = reading;
    const found = await RulesIndex.find(item.name, { edition, type: item.type });
    reading.book = { status: found.status, note: found.note,
                     name: found.hits?.[0]?.name ?? null,
                     pack: found.hits?.[0]?.packLabel ?? null };

    // ⚠️ NOT IN THE BOOKS IS NORMAL, NOT BROKEN. Homebrew, third-party, a
    // Pathfinder spell dropped in by accident: the engine reads the item and
    // the button works. Nothing is said to him about it.
    if (found.status !== "found" || !found.doc) return;

    const mine = readMechanics(item);
    const theirs = readMechanics(found.doc);
    let result = compareToBook(mine, theirs, { edition });

    // ⚠️🔴 A CANTRIP IS SUPPOSED TO GROW. Spare the Dying's range doubles at
    // 5th, 11th and 17th, so a Cleric 17's 120 feet is CORRECT — and on
    // 2026-09-05 I reported exactly that as an importer's default and had him
    // change items that were already right.
    if (isCantrip(item)) result = filterForCantrip(result);

    reading.disagreements = result.lines;
    if (!result.lines.length) return;

    // Once per item per session. The same spell cast eight times in a fight
    // must not produce eight identical warnings.
    const key = `${item.uuid ?? item.id}|${edition}`;
    if (ActionInterceptor._reportedDisagreements.has(key)) return;
    ActionInterceptor._reportedDisagreements.add(key);

    console.warn(`${LOG} | "${item.name}" (${reading.actorName}) disagrees with the `
      + `${edition} book:\n  ` + result.lines.join("\n  ")
      + `\n  The item is what was cast — ACE changed nothing.`);
    ui.notifications?.warn(
      `${item.name}: ${result.lines[0]}${result.lines.length > 1
        ? ` (+${result.lines.length - 1} more, see the console)` : ""}`,
      { permanent: false });
  }

  /* ── Silence is a bug ──────────────────────────────────────────────────── */

  static _watchForSilence(reading) {
    ActionInterceptor._inFlight.add(reading);
    setTimeout(() => {
      ActionInterceptor._inFlight.delete(reading);
      if (reading.sawSomething) return;

      // ⚠️ NAME THE ITEM, THE OWNER AND THE REASON. "Nothing happened" on its
      // own is the same silence in a nicer font.
      const why = reading.claimedBy
        ? `${reading.claimedBy} took it and produced nothing`
        : `nothing in ACE claimed it`;
      const shapeSays = reading.shape
        ? `ACE read it as "${reading.shape}"`
        : `ACE could not work out what it does`;

      console.error(`${LOG} | DEAD BUTTON: "${reading.itemName}" (${reading.actorName}) — `
        + `${why}. ${shapeSays}; expected owner ${reading.owner}; `
        + `${reading.edition} rules.`);
      ui.notifications?.error(
        `${reading.itemName} did nothing. ${why}. See the console for what ACE read it as.`,
        { permanent: true });
    }, SILENCE_MS);
  }

  /* ── Report ────────────────────────────────────────────────────────────── */

  /** `game.aceQol.readings()` — what the engine has seen this session. */
  static report() {
    const rows = [...ActionInterceptor._readings.values()].map(r => ({
      actor: r.actorName, item: r.itemName, type: `${r.itemType}/${r.activityType}`,
      edition: r.edition, shape: r.shape ?? "?", from: r.source,
      owner: r.owner, book: r.book?.status ?? "?",
      disagreements: r.disagreements.length,
      claimedBy: r.claimedBy ?? "-",
      appeared: r.sawSomething || "NOTHING",
    }));
    console.table(rows);
    return rows;
  }
}

function _safe(fn, fallback) {
  try { return fn(); } catch (_) { return fallback; }
}
