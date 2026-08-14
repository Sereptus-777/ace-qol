// ─── ACE: QOL — Loot Framing ──────────────────────────────────────────────────
// What a dead creature leaves behind is not always "loot in its pockets."
//
// A Stone Golem is animated rock built to guard something. It has no purse, no
// belt, and no reason to own anything — so a card reading "Loot — Stone Golem"
// over 2,500 gp and a Belt of Dwarvenkind is telling the table a lie about the
// fiction. (Johnny, 2026-08-08: "I thought a Stone Golem was like a controlled
// being that a magic user created.")
//
// This module decides the WORDS. It does not decide what drops — the loot
// engine and Forge's item filler already have their own creature-type rules.
// Its only job is to make sure that whatever ends up on the card is described
// honestly: carried, guarded, undissolved, or simply left behind.
//
// LEAF MODULE — imports nothing, so it can be pulled in from anywhere in
// ace-qol (loot-engine, lootable-tile, death-pipeline) with no cycle risk.
// ──────────────────────────────────────────────────────────────────────────────

/** Ordinary gear-users: humanoid, undead, fiend, celestial, fey, giant, dragon,
 *  monstrosity, aberration. A skeleton carries grave goods; a vampire owns
 *  things; a dragon's hoard is genuinely its own. Nothing to reframe. */
export const DEFAULT_FRAMING = Object.freeze({
  verb:    "Loot",
  note:    "",
  carried: true,
});

/**
 * Creature types whose drop is NOT "what it was carrying."
 *
 * `verb`    — replaces "Loot" in the card title and dialog header
 * `note`    — one plain-English line under the name saying why
 * `carried` — false means the fiction is "found with it", not "carried by it"
 */
const FRAMING_BY_TYPE = Object.freeze({
  construct: {
    verb:    "Salvage",
    note:    "Construct — not carried. Recovered from the wreckage, or from whatever it was set to guard.",
    carried: false,
  },
  ooze: {
    verb:    "Undigested",
    note:    "Ooze — undissolved remains of what it engulfed.",
    carried: false,
  },
  plant: {
    verb:    "Remains",
    note:    "Plant — tangled in the growth rather than carried.",
    carried: false,
  },
  beast: {
    verb:    "Remains",
    note:    "Beast — not carried. Found on the body.",
    carried: false,
  },
  elemental: {
    verb:    "Residue",
    note:    "Elemental — left behind as the form collapsed.",
    carried: false,
  },
  swarm: {
    verb:    "Remains",
    note:    "Swarm — scattered through what is left.",
    carried: false,
  },
});

/**
 * Read a creature type off anything that might carry one: a live Actor, a
 * TokenDocument's actor, or a stored loot snapshot that recorded it at death.
 *
 * Returns a lowercase type string, or "" when it genuinely cannot be read —
 * NEVER a guess. An unknown type falls through to the default framing, which
 * is the same wording ACE has always used, so a failed read changes nothing.
 *
 * @param {object|null} source  Actor, {system:{details:{type:{value}}}}, or a
 *                              snapshot carrying `creatureType`
 * @returns {string}
 */
export function readCreatureType(source) {
  if (!source) return "";
  // Snapshot shape — stamped at death so the wording survives the actor.
  if (typeof source.creatureType === "string") return source.creatureType.toLowerCase();
  const raw = source.system?.details?.type;
  if (typeof raw === "string") return raw.toLowerCase();
  if (typeof raw?.value === "string") return raw.value.toLowerCase();
  return "";
}

/**
 * The framing for a creature type.
 * @param {string} creatureType  lowercase 5e type, or "" / unknown
 * @returns {{verb: string, note: string, carried: boolean}}
 */
export function lootFraming(creatureType) {
  const key = String(creatureType ?? "").toLowerCase().trim();
  return FRAMING_BY_TYPE[key] ?? DEFAULT_FRAMING;
}

/**
 * Card / dialog title for a creature. "Loot — Goblin", "Salvage — Stone Golem".
 * @param {string} name
 * @param {string} creatureType
 * @returns {string}
 */
export function lootTitle(name, creatureType) {
  const { verb } = lootFraming(creatureType);
  return `${verb} — ${name}`;
}
