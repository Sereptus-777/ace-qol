// ─── ACE: QOL — TARGET WARDS: does THIS effect land on THIS creature? ────────
//
// The One Road, the target profile's own question, asked BEFORE APPLY. A creature
// can carry a reason that an effect does not touch it, and that reason lives in
// the words of something it is wearing or something it is:
//
//   Cloak of Arachnida — "You can't be caught in webs of any sort and can move
//                         through webs as if they were Difficult Terrain."
//
// The cloak has NO active effect on it. None. The sentence is the whole item, so
// nothing in Foundry, dnd5e or ACE had ever stopped a web restraining Jeth while
// he wore it. That is the hollow-feature shape: a thing that reads as working and
// does nothing.
//
// ⚠️ A READER, NOT A LIST. Nothing here names a spell, and nothing here names the
// cloak. It reads the TARGET's own words for a ward, and the SOURCE's own words
// for whether the ward covers it. A new cloak, a new ring, a homebrew feat with
// the same sentence all work the day they are written.
//
// ⚠️🔴 AND IT IS DELIBERATELY NARROW, BECAUSE A LOOSE READING IS WORSE THAN NONE.
// A survey of hijinx found 40 sentences matching a plain "cannot be <condition>",
// and most of them are not wards on the bearer at all:
//
//   "Engulf: ... has the restrained condition, and takes acid damage"   ← inflicts it
//   "Swallow: ... the swallowed target is no longer Restrained"         ← about a victim
//   "Lair Actions: can't do so while incapacitated"                     ← a prerequisite
//   "Marshal Undead: can't use this trait if it has incapacitated"      ← a prerequisite
//   "Hag Covens: can't perform it while blinded"                        ← a prerequisite
//
// Granting immunity off any of those would be the same bug as the descriptions
// that named a faction's ENEMIES and got the faction tagged as undead. So a ward
// must be a statement about the bearer being unable to suffer the thing, the
// sentence must not be a prerequisite ("while/if/unless it has..."), and it must
// not be the sentence that applies the condition. Everything else is reported and
// nothing is assumed.
//
// ⚠️ GEAR HAS TO BE EARNED. A cloak in the pack wards nothing, and a Rare item
// that requires attunement wards nothing until it is attuned. That is the same
// entitlement dnd5e uses for a weapon's magic bonus (magicAvailable,
// dnd5e.mjs:13862), which is why an unattuned +1 whip deals no +1.
// ──────────────────────────────────────────────────────────────────────────────

// ⚠️ plainSpellText, NOT aceStripEnrichers. The latter takes the enrichers out and
// leaves every HTML tag standing, so "Difficult Terrain.</p> <p>" is not a sentence
// end and the whole item arrives as one blob. The first version of this reader
// found NOTHING on the cloak it was written for, because that blob opens with
// "While wearing it, you gain..." and got thrown out as a prerequisite.
import { plainSpellText } from "../inference/spell-text.mjs";

const MODULE_ID = "ace-qol";

/** Item types that only ward while they are worn or held. */
const WORN = new Set(["equipment", "weapon", "consumable", "tool", "container", "loot"]);

/**
 * The conditions a ward word covers.
 *
 * ⚠️ "CAUGHT" IS THE BOOK'S WORD FOR BEING HELD FAST. The cloak does not say
 * "restrained"; it says "caught in webs", and what a web does to a creature is
 * restrain it. Both editions' Web spell restrains, and a giant spider's web
 * attack restrains. So a ward against being caught covers the two conditions
 * that mean held: Restrained and Grappled. Nothing else is inferred from it.
 */
const WARD_WORDS = Object.freeze({
  caught:        ["restrained", "grappled"],
  restrained:    ["restrained"],
  grappled:      ["grappled"],
  charmed:       ["charmed"],
  frightened:    ["frightened"],
  poisoned:      ["poisoned"],
  blinded:       ["blinded"],
  deafened:      ["deafened"],
  paralyzed:     ["paralyzed"],
  petrified:     ["petrified"],
  stunned:       ["stunned"],
  prone:         ["prone"],
  incapacitated: ["incapacitated"],
});

const WARD_WORD_RE = new RegExp(`\\b(${Object.keys(WARD_WORDS).join("|")})\\b`, "gi");

/** A sentence that is a prerequisite for using something, not a ward on the bearer. */
const PREREQUISITE = /\b(?:while|whilst|if|unless|until|when)\b[^.]{0,60}\b(?:has|have|is|are|gains?|suffers?)\b/i;

/** A sentence that APPLIES the condition to somebody rather than warding it. */
const INFLICTS = /\b(?:has|have|gains?|gets?|suffers?|is given|takes on)\b\s+(?:the\s+)?[\w\s]{0,20}\bcondition\b|\bis\s+(?:restrained|grappled|paralyz|petrified|stunned|prone)\b/i;

/** The ward forms: a statement that the bearer cannot suffer the thing. */
const WARD_FORMS = [
  // "You can't be caught in webs of any sort"
  /\b(?:you|it|they|the wearer|the bearer|the wielder|\w+)\s+(?:can'?t|cannot)\s+be\s+(?:caught|held|trapped|snared)\s+(?:in|by)\s+([a-z]+)/i,
  // "can't be charmed or frightened", "cannot be blinded, charmed, deafened…"
  /\b(?:can'?t|cannot)\s+be\s+((?:[\w@=\[\]]+(?:,\s*|\s+or\s+|\s+and\s+|\s+))*[\w@=\[\]]+)/i,
  // "is immune to being charmed", "are immune to the poisoned condition"
  /\b(?:is|are)\s+immune\s+to\s+(?:being\s+|the\s+)?((?:[\w@=\[\]]+(?:,\s*|\s+or\s+|\s+and\s+|\s+))*[\w@=\[\]]+)/i,
];

/**
 * ⚠️ THE APOSTROPHE IS CURLY. His books are written with U+2019, so "can’t" is
 * not "can't" and the first version of this reader found nothing at all on a cloak
 * whose sentence it was built around. Every quote form is flattened first.
 */
const straighten = (t) => String(t ?? "").replace(/[‘’ʼ′]/g, "'")
  .replace(/[“”]/g, '"').replace(/[–—]/g, "-");

const plain = (item) => {
  try {
    return straighten(plainSpellText(item?.system?.description?.value ?? "") ?? "")
      .replace(/\s+/g, " ").trim();
  } catch (_) {
    return straighten(item?.system?.description?.value ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  }
};

/**
 * Is this item actually doing anything for its owner right now?
 *
 * A feature always is. Gear has to be worn, and a magic item that requires
 * attunement has to be attuned.
 *
 * @returns {{live: boolean, why: string}}
 */
export function wardIsLive(item) {
  const type = String(item?.type ?? "");
  if (!WORN.has(type)) return { live: true, why: "it is what the creature is" };
  const sys = item?.system ?? {};
  if (!sys.equipped) return { live: false, why: "it is not being worn" };
  if (String(sys.attunement ?? "") === "required" && sys.attuned !== true) {
    return { live: false, why: "it is not attuned" };
  }
  return { live: true, why: "it is worn" };
}

/**
 * Every ward the creature's own items and features state, in their own words.
 *
 * @param {Actor5e} actor
 * @returns {Array<{source: string, sourceType: string, sourceId: string|null,
 *   conditions: string[], material: string|null, sentence: string,
 *   live: boolean, liveWhy: string, conditional: boolean}>}
 *   `material` is the stuff the ward names, when it names one ("web"): the ward
 *   then covers only an effect made of that. `conditional` marks a ward whose own
 *   sentence puts a condition on itself; those are reported, never assumed.
 */
export function readWards(actor) {
  const out = [];
  const items = actor?.items?.contents ?? [...(actor?.items ?? [])];
  for (const item of items) {
    const type = String(item?.type ?? "");
    if (!WORN.has(type) && type !== "feat") continue;
    const text = plain(item);
    if (!text) continue;
    if (!/\b(?:can'?t|cannot|immune)\b/i.test(text)) continue;

    for (const sentence of text.split(/(?<=[.!?])\s+/)) {
      if (!/\b(?:can'?t|cannot|immune)\b/i.test(sentence)) continue;
      // Not a prerequisite for using the thing, and not the sentence that
      // inflicts the condition on somebody.
      if (PREREQUISITE.test(sentence)) continue;
      if (INFLICTS.test(sentence)) continue;

      for (const form of WARD_FORMS) {
        const m = form.exec(sentence);
        if (!m) continue;
        const named = String(m[1] ?? "");
        // The words this sentence actually wards against.
        const words = [...named.matchAll(WARD_WORD_RE)].map(x => x[1].toLowerCase());
        // A material ward: "caught in webs" names the stuff, not a condition.
        const caught = /\b(?:caught|held|trapped|snared)\s+(?:in|by)\s+([a-z]+)/i.exec(sentence);
        const material = caught ? caught[1].toLowerCase().replace(/s$/, "") : null;
        const conditions = material
          ? WARD_WORDS.caught
          : [...new Set(words.flatMap(w => WARD_WORDS[w] ?? []))];
        if (!conditions.length) continue;

        const live = wardIsLive(item);
        out.push({
          source: item.name ?? "something it carries",
          sourceType: type, sourceId: item.id ?? null,
          conditions, material,
          sentence: sentence.trim().slice(0, 220),
          live: live.live, liveWhy: live.why,
          // Its own sentence narrows it ("while it can see an ally"), so a person
          // decides, not this file.
          conditional: /\bwhile\b|\bas long as\b|\buntil\b/i.test(sentence) && !material,
        });
        break;                    // one ward per sentence
      }
    }
  }
  return out;
}

/**
 * The stuff an effect is made of, read from the thing that caused it.
 *
 * ⚠️ THE VOCABULARY IS THE WARD'S, NOT MINE. The ward says what it wards against
 * ("webs"), and this only asks whether the source is that. So no spell is named
 * anywhere, and a ward against ice, vines or tar works the day someone writes one.
 *
 * @param {Item} item     what caused the effect
 * @param {string} material   the stuff the ward names, singular ("web")
 */
export function sourceIsMadeOf(item, material) {
  if (!item || !material) return false;
  const stem = material.replace(/s$/, "");
  if (!stem || stem.length < 3) return false;
  const hay = `${item?.name ?? ""} ${plain(item)}`;
  return new RegExp(`\\b${stem}(?:s|bing|bed|by)?\\b`, "i").test(hay);
}

/**
 * Does anything this creature carries refuse this condition from this source?
 *
 * @param {Actor5e} actor
 * @param {string} condition   the condition about to land ("restrained")
 * @param {object} [opts]
 * @param {Item} [opts.item]   what is applying it, for a ward that names a material
 * @returns {{warded: boolean, source?: string, why?: string, sentence?: string,
 *            held?: object[]}}  `held` lists wards that did not fire and why, so a
 *   cloak in the pack is never mistaken for a cloak being worn.
 */
export function wardAgainst(actor, condition, { item = null } = {}) {
  const key = String(condition ?? "").toLowerCase();
  if (!actor || !key) return { warded: false };
  let wards;
  try { wards = readWards(actor); }
  catch (err) {
    console.warn(`${MODULE_ID} | the wards on ${actor?.name} could not be read, so nothing `
      + `was allowed to refuse this ${key}:`, err);
    return { warded: false };
  }
  const held = [];
  for (const w of wards) {
    if (!w.conditions.includes(key)) continue;
    if (!w.live) { held.push({ ...w, heldBecause: w.liveWhy }); continue; }
    // ⚠️ A GUESS IS NOT A RULING. A ward its own sentence narrows goes to the GM.
    if (w.conditional) { held.push({ ...w, heldBecause: "its own words narrow it, so a person decides" }); continue; }
    // A material ward covers only an effect made of that material.
    if (w.material && !sourceIsMadeOf(item, w.material)) {
      held.push({ ...w, heldBecause: `it wards against ${w.material}s, and this is not ${w.material}` });
      continue;
    }
    const why = w.material
      ? `${w.source}: it cannot be caught in ${w.material}s of any sort`
      : `${w.source}: it cannot be ${key}`;
    return { warded: true, source: w.source, sentence: w.sentence, why, ward: w, held };
  }
  return { warded: false, held };
}
