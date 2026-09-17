// ─── ACE: QOL — ONE reader: can this creature cast that spell right now? ─────
//
// ⚠️🔴 WHY THIS FILE EXISTS. Johnny's table, 2026-09-16: "Magic Missile at
// Beric, who has Shield prepared, a slot, and a reaction. No Shield pop-up."
// The reaction engine was reached, the settings were on, and the pipeline
// called it in the right place. It asked whether the spell was prepared like
// this:
//
//     const mode = item.system.method ?? item.system.preparation?.mode;
//     if (mode === "prepared" && isPrepared) return true;
//
// `"prepared"` was a dnd5e 3.x preparation MODE. It is not a value dnd5e 5.x
// can ever produce. The system's own table of casting methods is
// `CONFIG.DND5E.spellcasting` and it holds exactly five keys: atwill, innate,
// ritual, pact and spell. A wizard's Shield is `method: "spell"`, which matched
// none of the branches, so the reader fell out of the bottom and said no.
//
// ⚠️ IT WAS NEVER ONE SPELL. That reader is the gate on Shield, Counterspell,
// Absorb Elements and Silvery Barbs alike, so on dnd5e 5.x not one of the four
// has ever offered itself to a slot caster. Every creature in his world that
// holds one of those spells - Varek, Kasimir, Morthos, Beiro, Zanna, Virric,
// every Mage, Archmage and Lich - reads `method: "spell"`. The only creatures
// it ever said yes to were innate casters, who then failed the slot check.
//
// ⚠️ AND IT WAS NEVER ONE READER. Three places in the suite carried their own
// copy of the same wrong value: this one, the action bar's "is it castable"
// hint, and the narrator's spell list. That is the whole argument for one file:
// a fourth private copy is how the drift started the first three times.
//
// ⚠️ IMPORTS ONE LEAF, DELIBERATELY. `spell-name.mjs` imports nothing, so this
// cannot sit in an import cycle and anything at all may depend on it. See
// lesson_module_id_at_top_level_kills_the_module.
// ──────────────────────────────────────────────────────────────────────────────

import { spellKey } from "./spell-name.mjs";

/** dnd5e 5.x preparation states, by the system's own numbers (0/1/2). */
const UNPREPARED = 0;

/**
 * What the item says about how it is cast, in either shape.
 *
 * ⚠️ 5.x FIRST, ALWAYS. `system.preparation` is deprecated: touching the name
 * at all builds a stack trace for the compatibility warning, and on a caster
 * carrying a full list that is hundreds of writes per redraw. It disappears
 * outright in dnd5e 6.0, at which point the old read returns undefined.
 */
export function preparationOf(item) {
  const sys = item?.system ?? {};
  const has5x = ("method" in sys) || ("prepared" in sys);
  const method = has5x ? sys.method : sys.preparation?.mode;
  const raw = has5x ? sys.prepared : sys.preparation?.prepared;
  // 5.x writes a number (0 unprepared, 1 prepared, 2 always). 3.x wrote a
  // boolean. Both answer the same question.
  const prepared = (raw === true) ? 1 : (raw === false ? 0 : Number(raw ?? 0));
  return { method: method ?? null, prepared, shape: has5x ? "5.x" : (sys.preparation ? "legacy" : "none") };
}

/**
 * Does this casting method need the spell prepared before it can be cast?
 *
 * Asked of the SYSTEM, not of a list written here, so a method a module adds
 * answers for itself. `prepares` is true for pact and spell; atwill, innate and
 * ritual do not prepare.
 */
function methodPrepares(method) {
  const table = globalThis.CONFIG?.DND5E?.spellcasting;
  const entry = table?.[method];
  if (entry) return entry.prepares === true;
  // No system table to ask (a self-test, or a method the system dropped): the
  // two that prepare are the two that have ever prepared.
  if (method === "spell" || method === "pact") return true;
  if (method === "prepared") return true;      // the 3.x mode name, still readable
  return false;
}

/**
 * Is this spell ready to cast right now, as far as preparation goes?
 *
 * Says nothing about slots, reactions, range or whether the creature is on its
 * feet. Those are separate questions with separate answers, and the caller asks
 * them; this one answers preparation and only preparation.
 *
 * @param {Item} item
 * @returns {{ready: boolean, why: string}}  `why` is written to be read aloud.
 */
export function spellReady(item) {
  if (!item) return { ready: false, why: "there is no such spell" };
  if (item.type !== "spell") return { ready: false, why: `${item.name} is not a spell` };

  const { method, prepared, shape } = preparationOf(item);

  // A cantrip is never prepared and never needs to be (the system's own
  // `countsPrepared` ignores level 0). Nothing in his world relies on this -
  // every cantrip he owns is already marked 1 or 2 - but it is the rule.
  if (Number(item.system?.level ?? 0) === 0) return { ready: true, why: "a cantrip is always ready" };

  // ⚠️ AN UNREADABLE SHEET IS NOT A REFUSAL. A spell with no preparation data
  // at all is a monster's spell-like ability or an importer's gap; refusing it
  // silently is precisely the bug this file was written for.
  if (!method) {
    return { ready: true, why: shape === "none"
      ? "the sheet says nothing about preparing it, so it is taken as ready"
      : "no casting method is recorded, so it is taken as ready" };
  }

  if (method === "ritual") {
    // Nothing in his world uses this method today. A spell in the ritual book
    // alone is cast as a ritual, ten minutes longer, so it is not something a
    // creature reaches for on its turn and certainly not as a reaction.
    return { ready: false, why: "it is in the ritual book only, so it is cast as a ritual" };
  }

  // ⚠️ THE TWO SHAPES DISAGREE ABOUT PACT, and the difference is real rather
  // than cosmetic. In the old shape a warlock's spell was mode "pact" and the
  // prepared flag beside it meant nothing, because a warlock knows its spells.
  // In dnd5e 5.x pact PREPARES: his world holds 51 pact spells marked always
  // prepared, 46 prepared and 14 that nobody prepared, and those 14 are a real
  // no. Reading the old shape by the new rule would refuse a warlock its own
  // spell list.
  if (shape === "legacy") {
    if (method === "always" || method === "atwill" || method === "innate" || method === "pact") {
      return { ready: true, why: `it is always ready (${method})` };
    }
    if (method === "prepared") {
      return prepared > UNPREPARED
        ? { ready: true, why: "prepared" }
        : { ready: false, why: "it is on the sheet but not prepared" };
    }
    return { ready: true, why: `no rule is written for "${method}", so it is taken as ready` };
  }

  if (!methodPrepares(method)) return { ready: true, why: `it is cast at will (${method})` };

  if (prepared > UNPREPARED) {
    return { ready: true, why: prepared >= 2 ? "always prepared" : "prepared" };
  }
  return { ready: false, why: "it is on the sheet but not prepared" };
}

/**
 * Does this creature hold that spell, ready to cast?
 *
 * ⚠️ EVERY COPY, NOT THE FIRST. Morthos carries two Shields and Beiro carries
 * two: one always-prepared and one unprepared. Stopping at the first copy found
 * would refuse him his own spell on a coin toss of item order.
 *
 * @param {Actor} actor
 * @param {string} name   plain spell name; suffixes an importer added are
 *                        stripped from both sides by `spellKey`.
 * @returns {{ok: boolean, item: Item|null, why: string}}
 */
export function hasReadySpell(actor, name) {
  const want = spellKey(name);
  if (!want) return { ok: false, item: null, why: "no spell was named" };
  const items = actor?.items;
  if (!items) return { ok: false, item: null, why: `${actor?.name ?? "it"} carries no items` };

  let held = null, heldWhy = "";
  for (const item of items) {
    if (item?.type !== "spell") continue;
    if (spellKey(item.name) !== want) continue;
    const verdict = spellReady(item);
    if (verdict.ready) return { ok: true, item, why: verdict.why };
    // Remember the best reason to say no, so "has it, unprepared" never prints
    // the same words as "does not have it".
    if (!held) { held = item; heldWhy = verdict.why; }
  }

  if (held) return { ok: false, item: held, why: `${actor?.name ?? "it"} has ${held.name}, but ${heldWhy}` };
  return { ok: false, item: null, why: `${actor?.name ?? "it"} does not have ${name}` };
}
