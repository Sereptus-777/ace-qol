// ─── ACE: QOL — "This is Cone of Cold, and this is how it functions" ────────
//
// Johnny, 2026-09-07: *"why does it read things in fucking rows? Why can't it
// take a snapshot and say, okay, this is Cone of Cold, this is how it
// functions?"*
//
// ⚠️🔴 IT ALWAYS COULD, AND NOTHING EVER ASKED IT TO. `describeActionFacts`
// has been in the inference engine since the engine was built. It turns a
// reading into eight lines of plain English. Every module in this suite was
// grepped: it is exported onto the API and there is not one caller. The report
// he was reading flattened the whole picture into one word per column and threw
// the rest away, which is the same fault he named on 2026-09-05 in different
// words: *"It read everything and used almost none of it."*
//
// ⚠️ AND IT MUST NOT NEED A PRESS. An engine you can only interrogate by
// setting the thing off is not an engine you can audit. Everything here reads
// an item cold, changes nothing, and works whether or not the button has ever
// been touched.
//
// ⚠️ FULLY SYNCHRONOUS, ON PURPOSE. `RulesIndex.lookup` is an in-memory read;
// only `RulesIndex.find` loads a document. Asking the books for a status
// therefore costs nothing and never triggers the index build, so this can be
// typed into the console and answer on the same line.
//
// ⚠️ MODULE_ID IS HARDCODED, matching the convention throughout this codebase:
// this file is reached from the entry file, so importing it back is a cycle and
// a const read at top level inside a cycle throws at load (2026-08-28).
// ──────────────────────────────────────────────────────────────────────────────

const MODULE_ID = "ace-qol";
const LOG = `${MODULE_ID} | snapshot`;

import { readActionFacts, describeActionFacts } from "./action-facts.mjs";
import { planFor, describePlan } from "./spell-plan.mjs";
import { DescriptionParser } from "../description-parser.mjs";
import { getSpellTiming } from "../spell-timing.mjs";
import { SpellPipeline } from "../spell-pipeline/pipeline.mjs";
import { RulesIndex } from "../rules/rules-index.mjs";
import { RulesBrain } from "../rules/rules-brain.mjs";

const _safe = (fn, fallback) => { try { return fn(); } catch (_) { return fallback; } };

const ITEM_KINDS = new Set(["spell", "feat", "weapon", "consumable", "equipment", "tool"]);

/* ── Finding the thing he means ─────────────────────────────────────────── */

/**
 * Turn whatever he typed into an item.
 *
 * Accepts nothing (the last button pressed), an Item, a uuid, or a name.
 *
 * ⚠️ IT SAYS WHERE IT LOOKED. "Not found" and "I did not look" are different
 * answers and must never print the same, which is the standing rule in this
 * codebase and the reason three sessions were lost.
 *
 * @returns {{item: object|null, actor: object|null, note: string,
 *            candidates: object[]}}
 */
export function resolveItem(what, { lastPress = null } = {}) {
  const none = (note, candidates = []) => ({ item: null, actor: null, note, candidates });

  // 1. Nothing at all: the most recent press.
  if (what === undefined || what === null || what === "") {
    if (lastPress?.item) {
      return { item: lastPress.item, actor: lastPress.actor ?? null,
               note: `the last button pressed (${lastPress.actorName})`, candidates: [] };
    }
    return none("nothing has been pressed yet this session, so there is no "
      + "last button to describe. Name a spell instead.");
  }

  // 2. An item handed over directly.
  if (typeof what === "object") {
    if (what?.system && what?.name) {
      return { item: what, actor: what.actor ?? null, note: "the item you handed over",
               candidates: [] };
    }
    return none("that object is not an item: it has no name and no system data.");
  }

  const text = String(what).trim();
  if (!text) return none("an empty name cannot be looked up.");

  // 3. A uuid.
  if (text.includes(".")) {
    const doc = _safe(() => globalThis.fromUuidSync?.(text), null);
    if (doc?.system && doc?.name) {
      return { item: doc, actor: doc.actor ?? null, note: `the item at ${text}`, candidates: [] };
    }
  }

  // 4. A name. Nearest first: what he has selected, then the party, then the world.
  const wanted = text.toLowerCase();
  const seen = new Set();
  const hits = [];
  const sweep = (actors, where) => {
    for (const actor of actors) {
      for (const item of (actor?.items ?? [])) {
        if (!ITEM_KINDS.has(item?.type)) continue;
        const name = String(item?.name ?? "").toLowerCase();
        // ⚠️ HIS 2014 ITEMS ARE NAMED "(Legacy)". Matching the raw name only
        // is the fault from 2026-09-05 that made every Legacy spell miss its
        // own registry entry, so a prefix match counts.
        const exact = name === wanted;
        if (!exact && !name.startsWith(wanted)) continue;
        if (seen.has(item.uuid ?? item.id)) continue;
        seen.add(item.uuid ?? item.id);
        hits.push({ item, actor, where, exact });
      }
    }
  };

  const controlled = _safe(() => (globalThis.canvas?.tokens?.controlled ?? [])
    .map(t => t?.actor).filter(Boolean), []);
  sweep(controlled, "the token you have selected");

  const party = _safe(() => (globalThis.game?.actors ?? [])
    .filter(a => a?.type === "character" && a.hasPlayerOwner), []);
  sweep(party, "a player character");

  sweep(_safe(() => [...(globalThis.game?.actors ?? [])], []), "an actor in the sidebar");

  if (!hits.length) {
    const where = [controlled.length ? `the ${controlled.length} token(s) you have selected` : null,
                   party.length ? `${party.length} player character(s)` : null,
                   `${_safe(() => (globalThis.game?.actors ?? []).length ?? 0, 0)} actor(s) in the sidebar`]
      .filter(Boolean).join(", ");
    return none(`nothing named "${text}" is on ${where}. `
      + `Compendium items are not searched: open the sheet and pass the item itself.`);
  }

  hits.sort((a, b) => (b.exact - a.exact));
  const pick = hits[0];
  const note = hits.length === 1
    ? `${pick.item.name}, on ${pick.actor?.name ?? "an actor"} (${pick.where})`
    : `${pick.item.name}, on ${pick.actor?.name ?? "an actor"} (${pick.where}). `
      + `${hits.length - 1} other copy/copies exist: `
      + hits.slice(1, 5).map(h => `${h.item.name} on ${h.actor?.name ?? "?"}`).join(", ");
  return { item: pick.item, actor: pick.actor ?? null, note, candidates: hits };
}

/* ── The snapshot ──────────────────────────────────────────────────────── */

/**
 * Everything ACE understands about one item, as text.
 *
 * @param {object} item
 * @param {object} [opts]
 * @param {object|null} [opts.actor]  who is holding it, for the header
 * @param {object|null} [opts.press]  the reading from a real press, if there is one
 * @param {boolean} [opts.why]        include the evidence for every line
 * @returns {{lines: string[], text: string, facts: object|null}}
 */
export function snapshot(item, { actor = null, press = null, why = true } = {}) {
  const lines = [];
  const holder = actor ?? item?.actor ?? press?.actor ?? null;

  const parsed = _safe(() => DescriptionParser.parse(item), null);
  const timing = _safe(() => getSpellTiming(item), null);
  const facts = _safe(() => readActionFacts(item, { parsed }), null);
  const edition = press?.edition
    ?? _safe(() => RulesBrain.resolveEdition(item, holder), null);

  // ── Header ──
  const kind = [item?.type, press?.activityType ? `${press.activityType} activity` : null]
    .filter(Boolean).join(", ");
  lines.push("");
  lines.push(`${item?.name ?? "this item"}`);
  lines.push([kind, holder?.name, edition ? `${edition} rules` : null]
    .filter(Boolean).join("   |   "));
  lines.push("─".repeat(64));

  // ── The eight questions, in his engine's own words ──
  if (!facts) {
    lines.push("  the inference engine could not read this item at all.");
  } else {
    const described = _safe(() => describeActionFacts(facts), null);
    if (described) {
      // The first line is just the name, which the header already carries.
      lines.push(...String(described).split("\n").slice(1));
    } else {
      lines.push("  the engine read this item but could not put it into words.");
    }
  }

  // ── What would have to happen for it to resolve ──
  //
  // ⚠️ THE PLAN IS BUILT FROM THE ITEM, NOT FROM AN ENTRY. Measured against
  // dnd5e's own books, 647 of 659 spells give a complete one with no entry
  // written for them at all. Nothing runs it yet: it prints so it can be argued
  // with before it is trusted.
  const plan = _safe(() => planFor(item, { facts, parsed, timing }), null);
  if (plan) {
    lines.push("");
    lines.push(...String(describePlan(plan)).split("\n"));
  }

  // ── How it will actually be resolved ──
  const entry = press ? { shape: press.shape, source: press.source }
    : _safe(() => {
        const e = SpellPipeline._getEntry(item);
        if (!e) return null;
        return { shape: e.shape ?? null,
                 source: e.corrected ? "corrected-by-you"
                       : e.inferred ? "worked-out" : "curated" };
      }, null);
  const owner = press?.owner ?? _safe(() => SpellPipeline.owns(item) ? "spell-pipeline" : null, null);

  lines.push("");
  lines.push("  HOW ACE RESOLVES IT");
  lines.push(`    shape         ${entry?.shape ?? "no shape: nothing in ACE will resolve this"}`
    + `${entry?.source ? ` (${entry.source})` : ""}`);
  lines.push(`    owner         ${owner ?? "nothing in ACE owns it; dnd5e resolves it natively"}`);

  // ── The books ──
  const book = press?.book ?? _safe(() => {
    const res = RulesIndex.lookup(item?.name, { edition: edition ?? "2014", type: item?.type });
    return { status: res.status, note: res.note, name: res.hits?.[0]?.name ?? null };
  }, null);
  const bookLine = !book ? "could not be checked"
    : book.status === "found" ? `found in the ${edition ?? "?"} books`
    : book.status === "unbuilt" ? "the rules index has not finished building"
    : book.note || book.status;
  lines.push(`    book          ${bookLine}`);

  const disagreements = press?.disagreements ?? [];
  lines.push(`    disagreements ${disagreements.length
    ? disagreements.join("; ")
    : "none: the item and the book say the same thing"}`);

  // ── What happened when he actually pressed it ──
  if (press) {
    const when = _safe(() => new Date(press.at).toLocaleTimeString(), "");
    lines.push("");
    lines.push(`  WHEN YOU PRESSED IT${when ? `, ${when}` : ""}`);
    // ⚠️ A DASH HERE IS NOT EVIDENCE OF ANYTHING. Every module was grepped on
    // 2026-09-07: the heal pipeline is the only thing in the suite that ever
    // claims a press. For every other button a blank claim is the normal state,
    // so saying "nothing claimed it" without that caveat reads as a fault and
    // sends him hunting one that is not there.
    lines.push(`    claimed by    ${press.claimedBy
      ?? "nobody (only the heal pipeline reports a claim today, so this is "
         + "expected for everything else)"}`);
    lines.push(`    appeared      ${press.sawSomething || "NOTHING, which is a dead button"}`);
  } else {
    lines.push("");
    lines.push("  This has not been pressed this session. Everything above was read "
      + "cold, off the item.");
  }

  // ── Why it read that way ──
  const evidence = facts?.evidence ?? [];
  if (why && evidence.length) {
    lines.push("");
    lines.push("  WHY IT READ IT THAT WAY");
    for (const e of evidence.slice(0, 12)) lines.push(`    - ${e}`);
    if (evidence.length > 12) lines.push(`    - (${evidence.length - 12} more)`);
  }
  lines.push("");

  return { lines, text: lines.join("\n"), facts, plan };
}

/** Print a snapshot and hand back the data behind it. */
export function printSnapshot(item, opts = {}) {
  const out = snapshot(item, opts);
  console.log(out.text);
  return out;
}
