// ─── ACE QOL — Which picture is this creature? ───────────────────────────────
//
// ONE rule for the two places that choose art by creature: the corpse it
// leaves (death-pipeline.mjs) and the picture of it lying down (prone-art.mjs).
// They were two ladders that each stopped at the first rung that answered, so
// a plain type file beat the picture he had drawn for the creature.
//
// ⚠️🔴 Johnny, 2026-09-18: "Specific art loses to a generic type file.
// Neferon: dead-arcanaloth-fiend exists. It used dead-fiend. Draft Horse:
// dead-horse exists. It used a generic beast." His rules:
//   • More specific filename wins. Always.
//   • Count every word: name, then type, then subtype.
//   • Do not stop at the first type hit.
//
// So the words of the creature's name, its type and its subtype are all
// counted, every file that shares one is a candidate, and the candidates are
// COMPARED, never taken in turn. The more specific picture wins:
//   1. more words of the creature's own NAME ("Draft Horse": draft, horse),
//   2. then more words of what it was MADE FROM (Neferon's actor was imported
//      as an Arcanaloth),
//   3. then a picture of exactly this creature before one that is also about
//      something else (every word of the file is one of the creature's),
//   4. then its SUBTYPE or race before its TYPE: dead-elf for Kasimir, who is
//      an elf, beats the plain Dead-Humanoid; the type file is the generic one,
//   5. then the fewest words the creature does not have, then art made for the
//      purpose (prone- over no prefix over dead-), and equals at random so
//      nine goblins are not identical.
//
// ⚠️ THE GENERIC TYPE FILE NEVER BEATS A MORE SPECIFIC PICTURE, AND A WORD
// BORROWED FROM ANOTHER CREATURE NEVER BEATS AN EXACT ONE. Taking the type
// before the subtype, as a straight ladder, gave Kasimir, Rahadin and Patrina
// Dead-Humanoid with dead-elf in the folder: his bug again. Taking the subtype
// before the type with no fit rule is what gave forty-one humans, Ezmerelda
// among them, the human hag's corpse (their subtype is "human").
//
// ⚠️ "SPECIFIC" IS MEASURED AGAINST THE CREATURE, NOT BY THE LENGTH OF THE
// FILENAME. dead-arcanaloth-fiend wins for Neferon because it has two of his
// words, arcanaloth and fiend, where dead-fiend has one. For an Imp it has the
// same one word plus a word that is some other creature's, so the Imp keeps
// dead-fiend (the 2026-09-06 check that must not break). Measured by length
// alone, every beast in his world would have become a displacer beast and
// every wolf the Animal Lord.
//
// ⚠️ A NAME WORD THAT IS ANOTHER CREATURE TYPE IS AN ADJECTIVE. Counting every
// word of "Giant Frog" would make it a dead giant. "Giant" is a creature type
// and the frog is a beast, so the word never earns a match on its own; it only
// settles a tie, so a file named for the whole "giant frog" still beats a plain
// "frog". A Frost Giant keeps the word, and a Giant Spider finds
// `dead-giant spider` by "spider".
//
// ⚠️ A JOB IS NOT A CREATURE. Counting every word matched Lord Soth, the Mummy
// Lord and the Skull Lord to `dead-Animal Lord (Wolf)`, every Guard Drake to
// `dead-guard`, the Star Spawn to `dead-vampire-spawn` and the Phantom Warrior
// to `dead-drow-warrior`. Words for a job, a rank, age or sex (lord, guard,
// warrior, spawn, knight, cleric, female...) say what a creature DOES, so they
// match only a picture filed under the creature's own type: his Dead folder is
// sorted by type, and a Town Guard (humanoid) still gets `Humanoid/dead-guard`.
// A creature word (goblin, gnoll, drow) is never checked that way, because his
// folders follow the 2024 types and a 2014 goblin is a humanoid filed under Fey.
//
// Pure: nothing here touches Foundry at load, so the self-tests run it on his
// real folders.
// ──────────────────────────────────────────────────────────────────────────────

/** What a token texture can be: a still image. */
export const IMAGE_FILES = /\.(png|webp|jpe?g|gif|avif)$/i;
/** What a corpse tile can be: an image, a vector, or a video. */
export const TILE_FILES = /\.(png|webp|jpe?g|gif|avif|svg|webm|mp4|m4v|ogv)$/i;

const RANK = { prone: 3, plain: 2, dead: 1 };

/** Words that say nothing about which creature a picture shows. */
const STOP = new Set(["the", "and", "of", "an", "to", "in", "on", "at", "by", "or", "cr",
  "legacy", "variant", "any", "dead", "corpse", "prone"]);

/** What a creature does or where it stands among its kind, never what it is. */
const ROLES = new Set(["lord", "lady", "king", "queen", "prince", "princess", "chief", "chieftain",
  "captain", "commander", "general", "leader", "boss", "master", "matron", "elder", "elite",
  "champion", "warlord", "warrior", "soldier", "guard", "guardian", "sentry", "sentinel", "knight",
  "scout", "archer", "skirmisher", "raider", "brute", "hunter", "stalker", "assassin", "priest",
  "cleric", "acolyte", "cultist", "fanatic", "zealot", "shaman", "mage", "wizard", "sorcerer",
  "warlock", "monk", "adept", "apprentice", "servant", "minion", "spawn", "thrall", "female",
  "male", "young", "adult", "ancient", "greater", "lesser", "spirit"]);

/** The creature types as adjectives: "Aberrant Spirit" is not an aberrant cultist. */
const TYPE_ADJECTIVES = new Set(["aberrant", "bestial", "draconic", "fiendish", "infernal", "monstrous"]);

/** dnd5e's creature types, from the live config when there is one. */
const TYPES = ["aberration", "beast", "celestial", "construct", "dragon", "elemental", "fey",
  "fiend", "giant", "humanoid", "monstrosity", "ooze", "plant", "undead"];
function creatureTypes() {
  const live = Object.keys(globalThis.CONFIG?.DND5E?.creatureTypes ?? {});
  return new Set(live.length ? live : TYPES);
}

/**
 * The words in a name: lower case, split on anything that is not a letter or a
 * digit. Numbers (variant numbers, "CR 16"), single letters ("Goblin A") and
 * the words above are dropped; "Ox" is a word. "Baba Lysaga's Hut" gives
 * "lysagas", the same as the D&D Beyond importer's "baba-lysagas-creeping-hut".
 */
export function wordsOf(text) {
  return String(text ?? "").toLowerCase().replace(/['’]/g, "")
    .split(/[^a-z0-9]+/)
    .filter(w => w.length > 1 && !/^\d+$/.test(w) && !STOP.has(w));
}

/** What a file is, read from how it is named: art made for lying down (`prone-`), a corpse (`dead-`), or neither. */
export function artKind(stem) {
  if (/^prone[-_ ]*/i.test(stem)) return "prone";
  if (/^dead[-_ ]+/i.test(stem)) return "dead";
  return "plain";
}

export function newArtIndex() {
  return { entries: [], byWord: new Map(), paths: new Set(), files: 0, byKind: { prone: 0, dead: 0, plain: 0 } };
}

/**
 * Add one file. Its words are its name without the `prone-`/`dead-` prefix:
 * `dead-arcanaloth-fiend.png` is arcanaloth and fiend, `dead-fiend-11.png` is
 * fiend (a numbered variant of dead-fiend).
 * @returns {object|null} the entry, or null when it is not art or has no words
 */
export function addArt(index, path, { media = IMAGE_FILES } = {}) {
  if (!path || !media.test(String(path)) || index.paths.has(path)) return null;
  const raw = String(path).split("/").pop().replace(/\.[^.]+$/, "");
  let stem = raw;
  try { stem = decodeURIComponent(raw); } catch (_) { /* a stray % in a filename is still a filename */ }
  const kind = artKind(stem);
  const words = [...new Set(wordsOf(stem.replace(/^prone[-_ ]*/i, "").replace(/^dead[-_ ]+/i, "")))];
  if (!words.length) return null;
  // Filed under a creature type (Assets/Dead/Humanoid/...)? Then that is its type.
  let folder = String(path).split("/").slice(-2, -1)[0] ?? "";
  try { folder = decodeURIComponent(folder); } catch (_) { /* a stray % is still a name */ }
  folder = folder.toLowerCase();
  const entry = { path, kind, rank: RANK[kind], words, type: creatureTypes().has(folder) ? folder : null };
  index.paths.add(path);
  index.entries.push(entry);
  index.files++;
  index.byKind[kind]++;
  for (const w of words) {
    if (!index.byWord.has(w)) index.byWord.set(w, []);
    index.byWord.get(w).push(entry);
  }
  return entry;
}

export function indexArt(paths, opts = {}) {
  const index = newArtIndex();
  for (const p of (paths ?? [])) addArt(index, p, opts);
  return index;
}

/**
 * What the creature was made from, as its importers and Foundry recorded it.
 *
 * ⚠️ NEFERON IS AN ARCANALOTH AND HIS NAME DOES NOT SAY SO. His sheet is named
 * Neferon, typed fiend (yugoloth), and Plutonium recorded the import as
 * "arcanaloth_mm". Foundry records a compendium drop as its source entry, whose
 * name is loaded with the pack's index at startup; the D&D Beyond importer
 * records the monster's page. A GM's own answer (the `creatureBase` flag) is
 * read first.
 */
export function madeFrom(actor) {
  const out = [];
  try {
    const base = actor?.getFlag?.("ace-qol", "creatureBase");
    if (typeof base === "string" && base.trim()) out.push(base);
  } catch (err) {
    console.warn("ace-qol | art | could not read the creatureBase flag:", err);
  }
  const uuid = actor?._stats?.compendiumSource ?? actor?.flags?.core?.sourceId;
  if (typeof uuid === "string" && uuid.startsWith("Compendium.")) {
    const resolve = globalThis.foundry?.utils?.fromUuidSync
      ?? (typeof globalThis.fromUuidSync === "function" ? globalThis.fromUuidSync : null);
    try {
      const source = resolve?.(uuid, { strict: false });
      if (typeof source?.name === "string") out.push(source.name);
    } catch (err) {
      console.warn(`ace-qol | art | could not read ${actor?.name}'s compendium source ${uuid}:`, err);
    }
  }
  const hash = actor?.flags?.plutonium?.hash;
  if (typeof hash === "string" && hash) {
    let h = hash;
    try { h = decodeURIComponent(hash); } catch (_) { /* an undecodable hash is still readable as it is */ }
    out.push(h.replace(/_[^_]*$/, ""));                  // "arcanaloth_mm" → "arcanaloth"
  }
  const url = actor?.flags?.monsterMunch?.url;
  if (typeof url === "string" && url.includes("/monsters/")) {
    out.push(url.split("/").pop().replace(/^\d+-/, "").replace(/-/g, " "));   // "16844-draft-horse"
  }
  return out;
}

/**
 * The creature's words, level by level, in the order they are counted.
 * @param {Actor} actor
 * @param {{names?: string[]}} [opts]  more names it goes by (a token's own name)
 */
export function creatureWords(actor, { names = [] } = {}) {
  const types = creatureTypes();
  const rawType = actor?.system?.details?.type;
  const typeValue = typeof rawType === "string" ? rawType
    : (rawType?.value === "custom" ? rawType?.custom : rawType?.value);
  const own = new Set(wordsOf(typeValue));
  const soft = new Set();
  const roles = new Set();
  const named = (texts) => new Set(texts.flatMap(t => wordsOf(t)).filter(w => {
    if ((types.has(w) && !own.has(w)) || TYPE_ADJECTIVES.has(w)) {
      soft.add(w);                                      // "giant" in Giant Frog
      return false;
    }
    if (ROLES.has(w)) roles.add(w);                     // "guard" in Guard Drake
    return true;
  }));
  // ⚠️ dnd5e 5.x keeps the race as the species ITEM once prepared, and as its
  // raw id when that item is missing.
  const race = actor?.system?.details?.race;
  const raceName = typeof race === "string" ? (/^[A-Za-z0-9]{16}$/.test(race) ? "" : race) : race?.name;
  const subtype = typeof rawType === "string" ? "" : rawType?.subtype;
  return {
    levels: [
      { label: "name", words: named([actor?.name, actor?.prototypeToken?.name, ...names]) },
      { label: "made from", words: named(madeFrom(actor)) },
      { label: "type", words: own },
      { label: "subtype", words: new Set([...wordsOf(subtype), ...wordsOf(raceName)]) },
    ],
    /** Words of its name that only describe it ("giant" in Giant Frog): never a match on their own. */
    soft,
    /** Words of its name for a job or rank: a match only with a picture of its own type. */
    roles,
    /** Its type, lower case ("" when the sheet has none). */
    type: String(rawType?.value ?? (typeof rawType === "string" ? rawType : "")).toLowerCase(),
  };
}

/** The creature's words as one line for the console: "name: neferon; made from: arcanaloth; ...". */
export function describeWords(creature) {
  return creature.levels.filter(l => l.words.size)
    .map(l => `${l.label}: ${[...l.words].join(", ")}`).join("; ") || "no words at all";
}

/**
 * Every file that shares a word with the creature, best first.
 * @returns {{entry, counts: number[], extra: number}[]}
 */
export function rankArt(index, creature) {
  const levels = creature.levels;
  const all = new Set(levels.flatMap(l => [...l.words]));
  const soft = creature.soft ?? new Set();
  const roles = creature.roles ?? new Set();
  const seen = new Set();
  const scored = [];
  for (const w of all) {
    for (const entry of (index?.byWord?.get?.(w) ?? [])) {
      if (seen.has(entry)) continue;
      seen.add(entry);
      // A job word counts only for a picture of the creature's own type.
      const sameType = !entry.type || !creature.type || entry.type === creature.type;
      const counts = (x, set) => set.has(x) && (sameType || !roles.has(x));
      const score = {
        entry,
        counts: levels.map(l => entry.words.filter(x => counts(x, l.words)).length),
        extra: entry.words.filter(x => !all.has(x) && !soft.has(x)).length,
        soft: entry.words.filter(x => soft.has(x) || (!sameType && roles.has(x))).length,
      };
      if (score.counts.some(c => c > 0)) scored.push(score);
    }
  }
  return scored.sort(compareArt);
}

/** Best first. `counts` is [name, made from, type, subtype], as in creatureWords. */
export function compareArt(a, b) {
  const [aName, aMade, aType, aSub] = a.counts;
  const [bName, bMade, bType, bSub] = b.counts;
  if (aName !== bName) return bName - aName;              // its own name
  if (aMade !== bMade) return bMade - aMade;              // what it was made from
  const aExact = a.extra === 0, bExact = b.extra === 0;
  if (aExact !== bExact) return aExact ? -1 : 1;          // a picture of exactly this
  if (aSub !== bSub) return bSub - aSub;                  // its subtype, more specific
  if (aType !== bType) return bType - aType;              // than its type
  if (a.extra !== b.extra) return a.extra - b.extra;
  if (a.soft !== b.soft) return b.soft - a.soft;
  return b.entry.rank - a.entry.rank;
}

/** The most specific level a score matched at: name, made from, subtype, type. */
const SPECIFIC = [0, 1, 3, 2];

/**
 * The picture for this creature, or null. Several equally good files (the
 * numbered variants of one picture) are picked from at random.
 * @returns {{path: string, level: string, words: string[], tied: number} | null}
 */
export function bestArt(index, creature, { rand = Math.random } = {}) {
  const ranked = rankArt(index, creature);
  if (!ranked.length) return null;
  const top = ranked.filter(s => compareArt(s, ranked[0]) === 0);
  const pick = top[Math.min(top.length - 1, Math.floor(rand() * top.length))];
  const at = SPECIFIC.find(i => pick.counts[i] > 0);
  return { path: pick.entry.path, level: creature.levels[at]?.label ?? "", words: pick.entry.words,
    counts: pick.counts, tied: top.length };
}
