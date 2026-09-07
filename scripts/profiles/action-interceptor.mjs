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
import { RulesIndex } from "../rules/rules-index.mjs";
import { readMechanics, compareToBook, isCantrip, filterForCantrip } from "../rules/rules-compare.mjs";
import { resolveItem, printSnapshot } from "../inference/snapshot.mjs";

// ⚠️ HARDCODED. This file is reached from the entry file; importing MODULE_ID
// back would be a cycle, and a const read at top level inside a cycle throws at
// load and kills the module (2026-08-28).
const MODULE_ID = "ace-qol";
const LOG = `${MODULE_ID} | reading`;

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

  // ⚠️🔴 THE KEY WAS THE ACTIVITY ID, AND dnd5e GIVES 518 OF ITS 659
  // SHIPPED SPELLS THE SAME ONE. Counted straight out of the two shipped spell
  // books on 2026-09-07:
  //     distinct activity ids across 817 activities : 276
  //     dnd5eactivity000 -> 518 spells
  //     dnd5eactivity100 ->  12   dnd5eactivity200 -> 10   dnd5eactivity300 -> 4
  // Fear and Cone of Cold are both dnd5eactivity000, in BOTH editions.
  //
  // A Map keyed on that id can therefore hold ONE of those 518 spells at a
  // time. Every press destroyed the last one. Johnny cast Cone of Cold, opened
  // the report and was shown Fear, and I spent two turns explaining a table
  // that was structurally incapable of showing him anything else.
  //
  // ⚠️ AND IT WAS NOT ONLY THE REPORT. `claim` and `readingFor` looked up by
  // the same key, so a pipeline claiming one spell marked a different one.
  //
  // The log is the record: one entry per press, in order, nothing overwritten.
  /** Every press this session, oldest first. */
  static _log = [];

  /** Newest reading per item-and-activity, for the pipelines to read. */
  static _byKey = new Map();

  /** How many presses to keep. Old ones fall off the front and the report says so. */
  static logCap = 500;

  /** How many presses have fallen off the front. */
  static _dropped = 0;

  /**
   * The lookup key for a pipeline asking "what did you read for this?".
   *
   * ⚠️ THE ITEM IS PART OF THE KEY. The activity id alone is not unique
   * across items and never was.
   */
  static _keyFor(activity) {
    const uuid = activity?.item?.uuid ?? activity?.parent?.uuid ?? "";
    return `${uuid}::${activity?.id ?? ""}`;
  }

  /** Presses still waiting to see something happen. */
  static _inFlight = new Set();

  static _witnessesWired = false;

  /**
   * How long to wait for something to appear before calling it silence.
   * A static rather than a const so the self-test can shorten it: a watchdog
   * that is never exercised is the same as no watchdog.
   */
  static silenceMs = 2500;

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
    // ⚠️ INDEX, THEN WARM. Indexing gives us the names; warming pulls the
    // actual book entry for everything anybody in this world can press, so that
    // at press time the books are a memory read rather than a fetch that
    // arrives after the decision has already been made.
    RulesIndex.build()
      .then(() => RulesIndex.warm())
      .catch(err =>
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
    // ⚠️ NOT EVERY WORKING BUTTON POSTS A CARD. A buff that lands as an
    // effect and a summon that puts a creature on the board are both plainly
    // "something happened", and calling either of them a dead button would be
    // crying wolf at his table — which is the fastest way to make him stop
    // reading these, exactly like the "areas that are never drawn" card.
    Hooks.on("createActiveEffect", saw("an effect was applied"));
    Hooks.on("createToken", saw("a creature appeared"));
    // ⚠️🔴 A DIALOG WAITING FOR HIM IS NOT A DEAD BUTTON. Caught live on
    // the first real press: Aura of Vitality opened dnd5e's own cast dialog,
    // sat there waiting for him to choose a slot, and ACE called it dead two
    // and a half seconds later. dnd5e's usage dialog is an ActivityUsageDialog,
    // not a DialogV2, so the witness above never saw it.
    //
    // Every subclass gets its own render hook name, so all of them are listed:
    // a summon, an enchant, an order and a transform each open their own.
    for (const cls of ["ActivityUsageDialog", "SummonUsageDialog", "EnchantUsageDialog",
                       "OrderUsageDialog", "TransformUsageDialog", "Dialog5e"]) {
      Hooks.on(`render${cls}`, saw("a cast dialog opened and is waiting for you"));
    }
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
    const r = ActionInterceptor._byKey.get(ActionInterceptor._keyFor(activity));
    if (r) r.claimedBy = String(who ?? "someone");
  }

  /** The answer for an activity, for any pipeline that wants it. */
  static readingFor(activity) {
    return ActionInterceptor._byKey.get(ActionInterceptor._keyFor(activity)) ?? null;
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
    const edition = _safe(() => RulesBrain.resolveEdition(item, actor), "2014");

    // ⚠️🔴 ONE DECIDER, AND IT ALREADY EXISTED. `SpellPipeline._getEntry`
    // IS the question "what is this item": it tries the curated registry first,
    // then a shape a human corrected by hand, then works it out from the item,
    // and caches the result. Every pipeline that resolves anything already asks
    // it.
    //
    // The first version of this file, written four hours before this line,
    // asked `RulesBrain.lookup` (eighteen environment entries) and then
    // `classifyItem` raw — skipping the 124-entry registry AND the learned
    // store. So it would have reported a shape for Aura of Vitality that
    // disagreed with the shape actually used to resolve it, and printed that
    // disagreement into his console as though it were the truth.
    //
    // That is two answers to one question, which is the exact fault this whole
    // night was spent finding. Written down here because I did it again while
    // fixing it: it is not enough to know the rule.
    const entry = _safe(() => SpellPipeline._getEntry(item), null);
    const shape = entry?.shape ?? null;
    const source = !entry ? "unknown"
                 : entry.corrected ? "corrected-by-you"
                 : entry.inferred  ? "worked-out"
                 : "curated";
    const confidence = entry?.inferred ? (entry.confidence ?? "worked-out") : source;

    // The environment/space rules record, which is a DIFFERENT question from
    // the shape and is kept beside it rather than confused with it.
    const curated = _safe(() => RulesBrain.lookup(item, { actor }), null);

    const reading = {
      id: activity.id,
      at: Date.now(),
      actor, actorName: actor.name,
      item, itemName: item.name, itemType: item.type,
      activityType: aType,
      edition,
      shape, source, confidence,
      // ⚠️ THE WHOLE READING TRAVELS, NOT JUST THE LABEL. Johnny, 2026-09-05:
      // "It read everything and used almost none of it." Everything the engine
      // worked out is published here so a consumer is not limited to one word
      // from a list, and so `game.aceQol.readings()` can show him what it knew.
      facts: entry?.facts ?? null,
      evidence: entry?.evidence ?? null,
      usedBook: entry?.usedBook ?? false,
      bookFilled: entry?.bookFilled ?? [],
      owner: _ownerOf(item, aType),
      profile,
      curated,
      book: null,
      disagreements: [],
      claimedBy: null,
      sawSomething: false,
    };
    ActionInterceptor._log.push(reading);
    ActionInterceptor._byKey.set(ActionInterceptor._keyFor(activity), reading);
    while (ActionInterceptor._log.length > ActionInterceptor.logCap) {
      ActionInterceptor._log.shift();
      ActionInterceptor._dropped++;
    }

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
      // ⚠️ A BLANK CLAIM IS NOT THE FAULT, AND MUST NOT READ AS ONE. Every
      // module was grepped on 2026-09-07: the heal pipeline is the only thing
      // in this suite that ever claims a press. So "nothing claimed it" was
      // true of almost every button in the game and sent him hunting a cause
      // that was never there.
      const why = reading.claimedBy
        ? `${reading.claimedBy} took it and produced nothing`
        : `no pipeline reported taking it (only the heal pipeline reports today, `
          + `so that alone is not the fault)`;
      const shapeSays = reading.shape
        ? `ACE read it as "${reading.shape}"`
        : `ACE could not work out what it does`;

      console.error(`${LOG} | DEAD BUTTON: "${reading.itemName}" (${reading.actorName}) — `
        + `${why}. ${shapeSays}; expected owner ${reading.owner}; `
        + `${reading.edition} rules.`);
      ui.notifications?.error(
        `${reading.itemName} did nothing. ${why}. See the console for what ACE read it as.`,
        { permanent: true });
    }, ActionInterceptor.silenceMs);
  }

  /* ── Report ────────────────────────────────────────────────────────────── */

  /**
   * `game.aceQol.readings()` — a snapshot of one thing, then the press log.
   *
   * Johnny, 2026-09-07: *"why does it read things in fucking rows? Why can't it
   * take a snapshot and say, okay, this is Cone of Cold, this is how it
   * functions?"* It can, and it always could: the engine has answered all eight
   * questions on every press since it was built and this function threw seven
   * of them away to print one word per column.
   *
   * ⚠️ AN OPTION IT DOES NOT UNDERSTAND SAYS SO. I told him
   * `readings({ raw: true })` would tell him if there were no such option. It
   * took no arguments at all and swallowed it without a word, which is the
   * silent refusal this codebase has a standing rule against.
   *
   * @param {object|string} [opts]  an item/name/uuid, or an options object
   */
  static report(opts = {}) {
    // A bare name is the common case: readings("Cone of Cold").
    if (typeof opts === "string" || (opts && typeof opts === "object" && opts.system)) {
      opts = { item: opts };
    }
    const KNOWN = new Set(["item", "log", "why", "limit"]);
    const unknown = Object.keys(opts ?? {}).filter(k => !KNOWN.has(k));
    if (unknown.length) {
      console.warn([
        `${LOG} | readings() does not understand `
          + `${unknown.map(k => `"${k}"`).join(", ")} and ignored it. It takes:`,
        `    item   a spell name, a uuid or an item (default: the last button pressed)`,
        `    log    false to hide the press list`,
        `    why    false to drop the evidence lines`,
        `    limit  how many presses to list (default 20)`,
      ].join("\n"));
    }

    const log = ActionInterceptor._log;
    const last = log[log.length - 1] ?? null;

    /* ── The snapshot ── */
    const asked = opts?.item ?? null;
    const found = resolveItem(asked, { lastPress: last });
    let text = null;
    if (!found.item) {
      // ⚠️ NOT SILENT, AND NOT A GUESS. It says where it looked.
      console.warn(`${LOG} | ${found.note}`);
    } else {
      const uuid = found.item?.uuid ?? null;
      const press = asked
        ? ([...log].reverse().find(r => r.item === found.item
            || (uuid && r.item?.uuid === uuid)) ?? null)
        : last;
      console.log(`${LOG} | ${found.note}`);
      text = printSnapshot(found.item,
        { actor: found.actor, press, why: opts?.why !== false }).text;
    }

    /* ── The press log ── */
    const limit = Number.isFinite(opts?.limit) ? Math.max(1, Math.trunc(opts.limit)) : 20;
    const shown = log.slice(-limit);
    const rows = shown.map(r => ({
      at: _safe(() => new Date(r.at).toLocaleTimeString(), ""),
      actor: r.actorName, item: r.itemName, type: `${r.itemType}/${r.activityType}`,
      edition: r.edition, shape: r.shape ?? "?", from: r.source,
      owner: r.owner, book: r.book?.status ?? "?",
      disagreements: r.disagreements.length,
      claimedBy: r.claimedBy ?? "-",
      appeared: r.sawSomething || "NOTHING",
    }));

    if (opts?.log !== false) {
      if (!log.length) {
        console.log(`${LOG} | no button has been pressed yet this session.`);
      } else {
        const dropped = ActionInterceptor._dropped;
        console.log(`${LOG} | ${log.length} press(es) held`
          + `${dropped ? `, ${dropped} older one(s) already dropped` : ""}`
          + `${log.length > limit ? `, showing the last ${limit}` : ""}`
          + `. Ask about any one of them with:  game.aceQol.readings("<name>")`);
        console.table(rows);
      }
    }

    return { snapshot: text, presses: rows, held: log.length,
             dropped: ActionInterceptor._dropped };
  }
}

function _safe(fn, fallback) {
  try { return fn(); } catch (_) { return fallback; }
}
