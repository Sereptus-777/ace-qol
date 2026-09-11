// ─── Which of a save's own effects land on a failure, and which on a success ─
//
// ⚠️🔴 ACE PUT CONDITIONS ON PEOPLE, AND NEVER THE SPELL'S OWN EFFECT. Johnny,
// 2026-09-11: Ray of Enfeeblement landed on Neferon, he failed, and the card
// said "Neferon failed and ACE applied nothing." True, and for a reason that
// covered a whole class. The 2024 Ray gives no condition on a failure. It gives
// an effect, "Enervated": disadvantage on Strength rolls and minus 1d8 on damage.
// ACE read conditions out of the spell's words and out of an effect's statuses,
// and had no step that put the effect itself on anybody. dnd5e's own "apply"
// button is on the usage card, and ACE hides that card. Measured across the
// books, seven other 2024 spells lost their result the same way: Calm Emotions,
// Enlarge/Reduce, Enthrall, Flesh to Stone, Mind Sliver, Phantasmal Killer and
// Synaptic Static.
//
// ⚠️ AND dnd5e'S DATA CANNOT SAY WHICH EFFECT IS WHICH. The Ray carries two
// effects and marks BOTH "not applied on a successful save". One of them, "Brief
// Enfeeblement", is exactly what a successful save does. dnd5e leaves the GM to
// click the right one; ACE cannot click, so it reads the spell's own sentences.
// An effect whose words sit after "On a successful save" is the success one.
// Anything the words do not clearly place keeps what the data says.
//
// ⚠️ THIS FILE DECIDES WHICH, AND APPLIES NOTHING. The save engine applies.
// Its imports import nothing, so this cannot start an import cycle.
// ──────────────────────────────────────────────────────────────────────────────

import { readActivities } from "../read-activities.mjs";
import { plainSpellText } from "./spell-text.mjs";

// A sentence that opens with the outcome of THE SAVE. Only at the start of a
// sentence ("ending the spell on a success" sits inside the Ray's failure
// clause), and only a save: Entangle's "On a success, it frees itself" is the
// result of an Athletics check, not of the saving throw.
const SUCCESS_LEAD = /^(?:on\s+a\s+successful\s+(?:save|saving\s+throw)\b|if\s+(?:the\s+|a\s+|that\s+)?(?:target|creature|it)\s+succeeds\s+on\s+(?:the|its|this|that|a)\s+(?:save|saving\s+throw)\b|a\s+(?:target|creature)\s+that\s+succeeds\s+on\s+(?:the|its|this|that|a)\s+(?:save|saving\s+throw)\b)/i;
const FAIL_LEAD = /^(?:on\s+a\s+failed\s+(?:save|saving\s+throw)\b|on\s+a\s+failure\s*,|if\s+(?:the\s+|a\s+|that\s+)?(?:target|creature|it)\s+fails\b|a\s+(?:target|creature)\s+that\s+fails\b)/i;
// Where the spell stops describing this cast and starts describing a bigger one.
const END_LEAD = /^(?:using\s+a\s+higher[- ]level\s+spell\s+slot|at\s+higher\s+levels|cantrip\s+upgrade)\b/i;

// Words that every clause shares, so they say nothing about which one it is.
const STOP = new Set(("the a an and or of to in on it its is for that this with as by at be has have "
  + "can any each until from your you spell target targets creature creatures save saving throw "
  + "throws turn turns end start next also").split(" "));

const words = (s) => new Set((String(s ?? "").toLowerCase().match(/[a-z0-9]+/g) ?? [])
  .filter(w => w.length > 2 && !STOP.has(w)));

/** How much of an effect's own wording turns up in one clause, 0 to 1. */
function share(sig, clause) {
  if (!sig.size || !clause) return 0;
  const c = words(clause);
  let n = 0;
  for (const w of sig) if (c.has(w)) n++;
  return n / sig.size;
}

/**
 * The spell's sentences, sorted by the outcome they describe.
 *
 * ⚠️🔴 A SUCCESS CLAUSE IS ONE SENTENCE, AND IT CLAIMS NOTHING AFTER IT. The
 * first version let the sentences that followed "On a successful save" join it,
 * and measured across the books it moved seven failure effects onto a success.
 * Enlarge/Reduce says "On a successful save, the spell has no effect" and then
 * spends two paragraphs describing Enlarge and Reduce; Sunburst's success
 * sentence is followed by what happens to a creature that is still Blinded.
 * Those later sentences describe the failure, or the spell, not the success.
 *
 * ⚠️ A FAILURE CLAUSE DOES RUN ON. Enervated's rules take three sentences
 * ("During that time...", "The target repeats the save..."), and letting them
 * count toward the failure only ever makes a success harder to claim, which is
 * the safe direction: what the words cannot clearly place stays where the
 * spell's data puts it.
 *
 * @param {string} html  the description
 * @returns {{preamble: string, success: string, fail: string}}
 */
export function outcomeClauses(html) {
  const text = plainSpellText(html);
  const sentences = text.split(/(?<=[.!?])\s+(?=[A-Z0-9"'“])/);
  const out = { preamble: [], success: [], fail: [] };
  let mode = "preamble";
  for (const raw of sentences) {
    const s = raw.trim();
    if (!s) continue;
    if (END_LEAD.test(s)) break;
    if (SUCCESS_LEAD.test(s)) { out.success.push(s); mode = "preamble"; continue; }
    if (FAIL_LEAD.test(s)) { out.fail.push(s); mode = "fail"; continue; }
    out[mode].push(s);
  }
  return { preamble: out.preamble.join(" "), success: out.success.join(" "),
           fail: out.fail.join(" ") };
}

/**
 * Every effect a save activity puts on its target, and on which result.
 *
 * @param {Item|object} item
 * @param {object} [opts]
 * @param {string|null} [opts.activityId]  only this activity's effects
 * @param {number|null} [opts.castLevel]   the slot it was cast with, for
 *                                         effects dnd5e only applies at some levels
 * @returns {Array<{id: string, name: string, effect: object,
 *                  on: "fail"|"success"|"both", why: string,
 *                  statuses: string[], changes: number, descriptionOnly: boolean}>}
 */
export function readSaveOutcomeEffects(item, { activityId = null, castLevel = null } = {}) {
  const out = [];
  try {
    // The item's own effects, in whichever shape this copy is in.
    const raw = item?.effects;
    const list = Array.isArray(raw?.contents) ? raw.contents
      : (typeof raw?.values === "function" ? [...raw.values()]
        : (Array.isArray(raw) ? raw : []));
    const byId = new Map();
    for (const e of list) {
      if (!e || typeof e !== "object") continue;   // a compendium copy stores ids only
      const id = e.id ?? e._id;
      if (id) byId.set(String(id), e);
    }
    if (!byId.size) return out;

    const acts = readActivities(item).filter(a => a?.type === "save"
      && (!activityId || String(a?.id ?? a?._id ?? "") === String(activityId)));
    if (!acts.length) return out;

    const clauses = outcomeClauses(item?.system?.description?.value ?? "");
    const level = Number.isFinite(Number(castLevel)) && castLevel !== null ? Number(castLevel) : null;
    const seen = new Set();

    for (const act of acts) {
      for (const ref of (Array.isArray(act?.effects) ? act.effects : [])) {
        const id = String(ref?._id ?? ref?.id ?? "");
        if (!id || seen.has(id)) continue;
        const eff = byId.get(id);
        // ⚠️ A TRANSFER EFFECT RIDES ON WHOEVER CARRIES THE ITEM. It is never
        // put on a target; doing so would hand the victim the item's own buff.
        if (!eff || eff.transfer === true) continue;

        // dnd5e applies some effects only at certain slot levels.
        if (level !== null) {
          const min = Number(ref?.level?.min), max = Number(ref?.level?.max);
          if ((Number.isFinite(min) && level < min) || (Number.isFinite(max) && level > max)) continue;
        }
        seen.add(id);

        const st = eff.statuses;
        const statuses = (st instanceof Set ? [...st] : (Array.isArray(st) ? st : []))
          .map(s => String(s ?? "").trim().toLowerCase()).filter(Boolean);
        const changes = Array.isArray(eff.changes) ? eff.changes.length : 0;

        const sig = words(plainSpellText(eff.description ?? "") || eff.name);
        const sScore = share(sig, clauses.success);
        const fScore = share(sig, clauses.fail);

        let on, why;
        if (ref?.onSave === true) {
          on = "both";
          why = "the spell's data applies it on a successful save as well";
        } else if (clauses.success && sScore >= 0.6 && sScore >= fScore + 0.25) {
          on = "success";
          why = `its words are what a successful save does (${Math.round(sScore * 100)}% of them `
            + `against ${Math.round(fScore * 100)}% for a failure), though the data does not say so`;
        } else {
          on = "fail";
          why = clauses.success
            ? "its words are not what a successful save does, so it goes on a failure"
            : "the spell's data applies it on a failed save";
        }
        out.push({ id, name: String(eff.name ?? "an effect"), effect: eff, on, why,
                   statuses, changes, descriptionOnly: !changes && !statuses.length });
      }
    }
  } catch (err) {
    // ⚠️ NEVER SILENT. An empty answer here is a spell whose result never lands.
    console.warn(`ace-qol | could not read which of "${item?.name ?? "an item"}"'s effects `
      + `land on a save:`, err);
  }
  return out;
}

/**
 * What a failed save and a successful one actually put on the creature.
 *
 * ⚠️🔴 SEVERAL EFFECTS ON ONE RESULT ARE A MENU, NOT A SET. Measured across
 * every save spell dnd5e ships, whenever one activity names two or more effects
 * for a failure, they are alternatives and exactly one of them happens:
 *     Prismatic Spray   indigo OR violet, by a d8 for each creature
 *     Divine Word       deafened, OR blinded too, OR stunned too, OR dead, by HP
 *     Symbol, Eyebite   the glyph or the gaze the caster picks
 *     Blindness/Deafness, Contagion, Enlarge/Reduce, Calm Emotions   the caster's pick
 * The only effects that stack with a failure are the ones the data marks as
 * applying on either result (Flesh to Stone's "Unable to Move", Irresistible
 * Dance's "Short Dance"). Putting every alternative on at once is how a failed
 * 2024 Divine Word would mark the creature DEAD, and how everyone who failed
 * Prismatic Spray was Restrained AND Blinded.
 *
 * ⚠️ WHAT EVERY ALTERNATIVE SHARES STILL HAPPENS. Contagion poisons whichever
 * ability the caster picks, so Poisoned lands and only the choice waits.
 *
 * @returns {{rows: object[], fail: object[], success: object[],
 *            alternatives: boolean, options: string[], shared: string[]}}
 *   `fail` and `success` are the effects to put on for each result; `shared`
 *   is the statuses every alternative carries.
 */
export function readSaveOutcome(item, opts = {}) {
  const rows = readSaveOutcomeEffects(item, opts);
  const failOnly = rows.filter(r => r.on === "fail");
  const both = rows.filter(r => r.on === "both");
  const alternatives = failOnly.length >= 2;
  let shared = [];
  if (alternatives) {
    const sets = failOnly.map(r => new Set(r.statuses));
    shared = [...sets[0]].filter(s => sets.every(set => set.has(s)));
  }
  return {
    rows,
    fail: alternatives ? both : [...failOnly, ...both],
    success: [...rows.filter(r => r.on === "success"), ...both],
    alternatives,
    options: alternatives ? failOnly.map(r => r.name) : [],
    shared,
  };
}
