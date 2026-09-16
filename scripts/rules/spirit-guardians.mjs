// ─── ACE: QOL — Spirit Guardians: whose spirits are these? ───────────────────
//
// Johnny, 2026-09-16: "ALIGNMENT (caster, not the targets). Good or neutral:
// radiant damage + gold/angelic animation. Evil: necrotic damage + red/fiendish
// animation. Varek is Neutral Evil: necrotic + red. Not gold."
//
// ⚠️ THE SPELL SAYS SO, IN BOTH EDITIONS. 2014: "If you are good or neutral,
// their spectral form appears angelic or fey... if you are evil, they appear
// fiendish", and the damage is radiant for the first and necrotic for the second.
// 2024 prints the same choice. His sheet carries BOTH types on one damage part,
// which is dnd5e's way of saying "one of these", and the first one in the set
// was winning: Varek, who is Neutral Evil, was dealing radiant and glowing gold.
//
// ⚠️ THE CASTER'S ALIGNMENT, NEVER THE TARGET'S. It is the caster's spirits.
//
// ⚠️ THE ANIMATION IS BORROWED, NOT INVENTED. Chris's premades reads the same
// field to choose necrotic over radiant, and the JB2A library he owns ships both
// colours of this exact spell. Evil takes the dark red one; anyone else takes the
// blue-gold one his Automated Animations has always played.
//
// ⚠️ IMPORTS ONE LEAF. `spellKey` is the one spell-name reader in the suite
// (a suffix like "(Legacy)" beat four private copies for months), and it imports
// nothing itself.
// ──────────────────────────────────────────────────────────────────────────────

import { spellKey } from "./spell-name.mjs";

/** The one name this rule answers to. */
export const SPIRIT_GUARDIANS = "spirit guardians";

/** Is this that spell, in either edition and whatever an importer suffixed it with? */
export function isSpiritGuardians(item) {
  try { return spellKey(item?.name ?? "") === SPIRIT_GUARDIANS; }
  catch (_) { return false; }
}

/**
 * The caster's alignment, as the sheet writes it: "Neutral Evil", "lawful good",
 * "True Neutral", "Any Alignment". Only the word "evil" changes anything here.
 */
export function alignmentOf(actor) {
  return String(actor?.system?.details?.alignment ?? "").trim();
}

/** Does this creature's own sheet call it evil? */
export function isEvil(actor) {
  return /\bevil\b/i.test(alignmentOf(actor));
}

/**
 * What this caster's guardians are: the damage they deal, the animation they
 * wear, and why, in words a card or a log line can print.
 *
 * ⚠️ AN UNSET OR "ANY" ALIGNMENT IS NOT EVIL. A blank sheet gets the angelic
 * form, which is the reading the table has always played, and the reason is said
 * out loud rather than left to look like a decision.
 *
 * @param {Actor} actor  the caster
 * @returns {{side: "evil"|"holy", damageType: "necrotic"|"radiant",
 *            file: string, colour: string, alignment: string, why: string}}
 */
export function guardianFlavour(actor) {
  const alignment = alignmentOf(actor);
  const evil = isEvil(actor);
  return {
    side: evil ? "evil" : "holy",
    damageType: evil ? "necrotic" : "radiant",
    colour: evil ? "dark_red" : "blueyellow",
    file: evil ? "jb2a.spirit_guardians.dark_red.ring" : "jb2a.spirit_guardians.blueyellow.ring",
    alignment,
    why: evil
      ? `${actor?.name ?? "the caster"} is ${alignment || "evil"}, so the spirits are fiendish: necrotic`
      : `${actor?.name ?? "the caster"} is ${alignment || "not evil"}, so the spirits are angelic: radiant`,
  };
}

/**
 * Which of a cast's rolled damage parts belong to THIS caster's spirits.
 *
 * ⚠️🔴 A 2014 SHEET CAN CARRY BOTH, AND ROLLING BOTH IS DOUBLE DAMAGE. Asha's
 * 2014 copy stores "3d8 radiant (Good or Neutral Alignment)" AND "3d8 necrotic
 * (Evil Alignment)" as two damage parts, which is the sheet writing the spell's
 * own either/or. dnd5e rolls every part it is given, so her Spirit Guardians was
 * dealing 6d8 to everyone. The caster's alignment picks one; the other never
 * happened, so its dice are never shown either.
 *
 * ⚠️ AND WHERE THE SHEET OFFERS ONLY ONE, IT IS THE ALIGNMENT'S. Thorian's copy
 * stores radiant alone; cast by an evil caster the spirits are fiendish and the
 * damage is necrotic, which is what both books print.
 *
 * @param {Array<{type: string}>} components  what was rolled
 * @param {Actor} casterActor
 * @returns {{kept: object[], dropped: object[], flavour: object}}
 */
export function guardianDamage(components, casterActor) {
  const flavour = guardianFlavour(casterActor);
  const rows = (components ?? []).filter(Boolean);
  const typeOf = (c) => String(c?.type ?? "").toLowerCase();
  const kinds = new Set(rows.map(typeOf));
  if (rows.length > 1 && kinds.size > 1) {
    const kept = rows.filter(c => typeOf(c) === flavour.damageType);
    if (kept.length) return { kept, dropped: rows.filter(c => !kept.includes(c)), flavour };
  }
  for (const c of rows) c.type = flavour.damageType;
  return { kept: rows, dropped: [], flavour };
}

/**
 * The damage types a cast really deals, where the item offers a choice this rule
 * makes. Anything else is handed straight back.
 *
 * ⚠️ IT ONLY EVER NARROWS. A spell whose part offers one type keeps it; a spell
 * this rule does not know is untouched. The narrowing matters beyond the words on
 * the card: the Gate reads these types to work out a creature's resistances, so a
 * devil that shrugs off necrotic must not be told it is facing radiant as well.
 */
export function narrowDamageTypes(item, casterActor, types) {
  const list = Array.isArray(types) ? types.filter(Boolean) : [];
  if (!isSpiritGuardians(item) || list.length < 2) return list;
  const want = guardianFlavour(casterActor).damageType;
  return list.includes(want) ? [want] : list;
}
