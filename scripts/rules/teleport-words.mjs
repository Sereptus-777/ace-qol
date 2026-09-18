// ─── ACE: QOL — Which Teleport is this? Asked of the item, never the name alone ─
//
// 2026-09-18, Johnny: "TWO different Teleports. Read the item on the token."
//
//   A) A MONSTER'S FEATURE. The arcanaloth (and the hydroloth, the yagnoloth, the
//      marilith, Glasstaff, the gynosphinx...) "teleports, along with any
//      equipment it is wearing or carrying, up to 60 feet to an unoccupied space
//      it can see". A hop across the map: no spell, no slot, no d100, and
//      Counterspell has nothing to counter. 2014 says 60 feet as an action; the
//      2024 arcanaloth says 30 feet as a bonus action. The distance is read from
//      the item's own words and the action from its own activity, so each copy
//      is its own edition, whatever the world is set to.
//
//   B) THE 7TH-LEVEL SPELL named Teleport: you and up to eight willing creatures
//      to a destination you know, and a d100 on the book's table.
//
// "Do not treat Neferon's feature as the 7th-level spell." A feature is never
// the spell here, whatever it is called. And a feature named Teleport whose
// words do something else (the balor moving a willing demon, the unicorn taking
// passengers a mile) is neither, and is left exactly as it was.
//
// ⚠️ IT IMPORTS ONLY THE NAME READER. The spell pipeline asks this while it
// decides what an item is, and a shared leaf that imports a sibling is how an
// import cycle kills the module at load.
// ──────────────────────────────────────────────────────────────────────────────

import { spellKey } from "./spell-name.mjs";

/**
 * The monster's hop, in its own words: teleports (optionally "along with any
 * equipment it is wearing or carrying") up to N feet to an unoccupied space it
 * (he, she, they) can see. Nothing about taking anybody else along.
 */
const HOP = /\bteleports?\b\s*,?(?:\s*along with any equipment (?:it|he|she|they) (?:is|are) wearing or carrying\s*,?)?\s+up to\s+(\d+)\s*(?:feet|foot|ft\.?)\s+to\s+an?\s+unoccupied space\s+(?:it|he|she|they)\s+can see\b/i;

/** Description HTML to plain words, enrichers and tags gone. */
function plain(html) {
  return String(html ?? "")
    .replace(/\[\[[^\]]*\]\]/g, " ")
    .replace(/@\w+\[[^\]]*\](?:\{([^}]*)\})?/g, (_m, label) => label ?? " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** The first activity's own range in feet, when it names one. */
function activityFeet(item, activity) {
  const acts = activity ? [activity]
    : (item?.system?.activities?.contents ?? Object.values(item?.system?.activities ?? {}));
  for (const a of acts) {
    const r = a?.range;
    if (!r || r.units !== "ft") continue;
    const v = Number(r.value);
    if (Number.isFinite(v) && v > 0) return v;
  }
  return null;
}

/**
 * Which Teleport, if any, is this item?
 *
 * @param {Item} item
 * @param {object} [activity]
 * @returns {{kind: "hop", feet: number, words: string}
 *         | {kind: "spell", level: number}
 *         | null}
 */
export function readTeleport(item, activity = null) {
  if (!item) return null;

  // B) The spell: a spell, named Teleport, of 7th level. Not Teleportation
  // Circle (a different name once the suffixes are stripped), and never a
  // feature, however it is named.
  if (item.type === "spell") {
    if (spellKey(item.name) !== "teleport") return null;
    const level = Number(item.system?.level);
    if (level !== 7) return null;
    return { kind: "spell", level };
  }

  // A) The hop: a creature's feature whose own words say so, and say nothing
  // else.
  //
  // ⚠️ ONLY A PURE HOP (2026-09-18). His world has about sixty features that
  // teleport "up to N feet to an unoccupied space it can see", and a third of
  // them do something more in the same breath: the blink dog bites, the
  // nycaloth turns invisible, the drow's Shadow Step needs darkness at both
  // ends, a fey spirit's mood fires, a dolphin takes a passenger, and the
  // lich's Deathly Teleport and Vecna's Vile Teleport deal damage around where
  // they were. Taking those over for the hop alone would drop the rest, so
  // they are left exactly as they were, and only a feature whose words are the
  // hop and nothing more is read as one.
  if (item.type !== "feat") return null;
  const acts = item?.system?.activities?.contents ?? Object.values(item?.system?.activities ?? {});
  if (!acts.length) return null;
  for (const a of acts) {
    if (a?.type !== "utility") return null;
    if ((a?.effects?.length ?? 0) > 0) return null;
  }
  const name = String(item.name ?? "").replace(/[^\p{L}\p{N}]+/gu, " ").trim().toLowerCase();
  const sentences = plain(item.system?.description?.value)
    .split(/(?<=[.!?])\s+/)
    .map(s => s.trim())
    .filter(Boolean)
    // dnd5e's "The [[lookup @name]] uses [[lookup @item.name]]." once its
    // enrichers are gone, and an importer's repeat of the feature's own name.
    .filter(s => !/^the\s+uses\s*\.?$/i.test(s))
    .filter(s => s.replace(/[^\p{L}\p{N}]+/gu, " ").trim().toLowerCase() !== name);
  if (sentences.length !== 1) return null;
  const only = sentences[0];
  const m = HOP.exec(only);
  if (!m) return null;
  // Before the hop, only who does it ("The arcanaloth magically", "Glasstaff",
  // "The sphinx can"); after it, only the full stop.
  const before = only.slice(0, m.index).trim();
  const after = only.slice(m.index + m[0].length).trim();
  if (after && !/^[.!]$/.test(after)) return null;
  if (before.split(/\s+/).length > 5 || /[,;:]/.test(before)) return null;
  const said = Number(m[1]);
  const feet = Number.isFinite(said) && said > 0 ? said : activityFeet(item, activity);
  if (!feet) return null;
  return { kind: "hop", feet, words: m[0] };
}
