// ─── "+2 versus undead" is a lookup, not a mystery ──────────────────────────
//
// ⚠️🔴 I SAID THIS COULD NOT BE DONE AND THE FIELD WAS ALREADY THERE. On
// 2026-08-28 the effects layer shipped reporting conditional modifiers as
// "somebody has to judge this", on the grounds that dnd5e stores no
// "only against undead" field. Johnny:
//
//   "Doesn't our attack and target profile read whether it's undead or not?
//    ... Why do you limit yourself so very often? ... +2 versus undead isn't
//    that hard to figure out whether it's undead or not."
//
// He was right. `creatureType` has been on BOTH profiles the whole time. The
// entire reason those profiles exist is to answer exactly this. Reporting the
// condition instead of evaluating it was not caution, it was the pipeline
// refusing to use what it already knew.
//
// So: the condition text is parsed into a predicate, and the predicate asks the
// profiles. Creature type, size, conditions on either creature, hit-point state,
// melee versus ranged, weapon versus spell, damage type, light level, underwater.
//
// ⚠️ THREE ANSWERS, NEVER TWO. `true`, `false`, and `unknown`. A few conditions
// genuinely cannot be settled from state - "once per turn", "if you have
// advantage", "at the GM's discretion" - and forcing those into true or false
// would silently add or remove a bonus nobody can see. Unknown is reported to
// the GM and stays out of the arithmetic.
//
// ⚠️ AND IT SAYS WHICH RULE FIRED. Every verdict carries the phrase it matched
// and the fact that settled it, so a wrong answer is a one-line fix rather than
// an evening of grep.

const MODULE_ID = "ace-qol";

const _s = (v) => String(v ?? "").toLowerCase().trim();

/** The twelve creature types, plus the plurals and adjectives people write. */
const CREATURE_TYPES = {
  aberration: ["aberration", "aberrations"],
  beast:      ["beast", "beasts", "animal", "animals"],
  celestial:  ["celestial", "celestials"],
  construct:  ["construct", "constructs"],
  dragon:     ["dragon", "dragons", "draconic"],
  elemental:  ["elemental", "elementals"],
  fey:        ["fey", "fae"],
  fiend:      ["fiend", "fiends", "demon", "demons", "devil", "devils"],
  giant:      ["giant", "giants"],
  humanoid:   ["humanoid", "humanoids"],
  monstrosity:["monstrosity", "monstrosities"],
  ooze:       ["ooze", "oozes"],
  plant:      ["plant", "plants"],
  undead:     ["undead", "zombie", "zombies", "skeleton", "skeletons", "vampire", "vampires"],
};

const SIZES = {
  tiny: ["tiny"], sm: ["small"], med: ["medium"],
  lg: ["large"], huge: ["huge"], grg: ["gargantuan", "huge or larger"],
};

// ⚠️ "bloodied" IS NOT IN THIS LIST ON PURPOSE. It is a hit-point STATE, not
// a status, and having it here made the generic condition rule claim
// "against bloodied creatures" first and then ask `hasCondition("bloodied")` -
// which is false on a creature at 8 of 30 hit points. It has its own rule below
// that reads the hit points, and falls back to a status only if a system happens
// to track one.
const CONDITIONS = ["blinded", "charmed", "deafened", "frightened", "grappled",
  "incapacitated", "invisible", "paralyzed", "petrified", "poisoned", "prone",
  "restrained", "stunned", "unconscious", "exhaustion"];

const DAMAGE_TYPES = ["acid", "bludgeoning", "cold", "fire", "force", "lightning",
  "necrotic", "piercing", "poison", "psychic", "radiant", "slashing", "thunder"];

/**
 * Build one alternation group from a word list.
 *
 * ⚠️ ESCAPE EACH WORD, THEN JOIN. The first version joined with a pipe and then
 * escaped the whole string, which escaped the pipes it had just added and turned
 * every alternation into one literal phrase. Seventeen of thirty-two tests failed
 * and the regexes still looked correct on a skim.
 *
 * ⚠️ LONGEST FIRST, so "vampires" is not eaten by "vampire" leaving a stray "s".
 */
const _alt = (words) => [...words]
  .sort((a, b) => b.length - a.length)
  .map(w => String(w).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
  .join("|");

/** Which creature type does this word mean? */
function _typeFromWord(word) {
  const w = _s(word);
  for (const [type, words] of Object.entries(CREATURE_TYPES)) {
    if (words.includes(w)) return type;
  }
  return null;
}

const ALL_TYPE_WORDS = Object.values(CREATURE_TYPES).flat();
const ALL_SIZE_WORDS = Object.values(SIZES).flat();

/**
 * The rules. Each one recognises a phrase and knows which profile answers it.
 *
 * ⚠️ ORDER MATTERS. The most specific phrasing wins, because "against a
 * frightened undead" must not be settled by whichever half matched first.
 */
const RULES = [
  // ── Who is being hit ────────────────────────────────────────────────────
  {
    id: "target-creature-type",
    re: new RegExp(`\\b(?:against|versus|vs\\.?|on)\\s+(?:a\\s+|an\\s+|the\\s+)?(${_alt(ALL_TYPE_WORDS)})\\b`, "i"),
    test: (m, ctx) => {
      const want = _typeFromWord(m[1]);
      const got = _s(ctx.target?.creatureType);
      if (!want) return { verdict: "unknown", why: `"${m[1]}" is not a creature type ACE knows` };
      if (!got) return { verdict: "unknown", why: `the target's creature type is not recorded on its sheet` };
      return { verdict: got === want, why: `the target is a ${got}, and this wants ${want}` };
    },
  },
  {
    id: "target-size",
    re: new RegExp(`\\b(?:against|versus|vs\\.?)\\s+(?:a\\s+|an\\s+)?(${_alt(ALL_SIZE_WORDS)})(?:\\s+or\\s+(larger|smaller))?\\b`, "i"),
    test: (m, ctx) => {
      const order = ["tiny", "sm", "med", "lg", "huge", "grg"];
      const want = Object.entries(SIZES).find(([, w]) => w.includes(_s(m[1])))?.[0];
      const got = _s(ctx.target?.size);
      if (!want || !got) return { verdict: "unknown", why: "the target's size is not recorded" };
      const wi = order.indexOf(want), gi = order.indexOf(got);
      if (m[2] === "larger")  return { verdict: gi >= wi, why: `the target is ${got}` };
      if (m[2] === "smaller") return { verdict: gi <= wi, why: `the target is ${got}` };
      return { verdict: gi === wi, why: `the target is ${got}` };
    },
  },
  {
    id: "target-condition",
    re: new RegExp(`\\b(?:against|versus|vs\\.?)\\s+(?:a\\s+|an\\s+)?(${_alt(CONDITIONS)})\\s*(?:creature|target|enemy|foe)?`, "i"),
    test: (m, ctx) => _conditionOn(ctx.target, m[1], "the target"),
  },
  {
    id: "target-condition-while",
    re: new RegExp(`\\b(?:while|when|if)\\s+the\\s+target\\s+is\\s+(${_alt(CONDITIONS)})\\b`, "i"),
    test: (m, ctx) => _conditionOn(ctx.target, m[1], "the target"),
  },
  {
    id: "target-bloodied",
    re: /\b(?:against|versus|vs\.?)\s+(?:a\s+)?bloodied\b|\bwhile the target is bloodied\b/i,
    test: (m, ctx) => _bloodied(ctx.target, "the target"),
  },

  // ── The state of whoever is acting ──────────────────────────────────────
  {
    id: "attacker-condition",
    re: new RegExp(`\\b(?:while|when|if)\\s+(?:you\\s+are|you're)\\s+(${_alt(CONDITIONS)})\\b`, "i"),
    test: (m, ctx) => _conditionOn(ctx.attacker, m[1], "you"),
  },
  {
    id: "attacker-bloodied",
    re: /\bwhile (?:you are|you're) bloodied\b/i,
    test: (m, ctx) => _bloodied(ctx.attacker, "you"),
  },
  {
    id: "attacker-raging",
    re: /\bwhile raging\b|\bwhen raging\b/i,
    test: (m, ctx) => _conditionOn(ctx.attacker, "rage", "you", { statusName: "rage" }),
  },

  // ── What kind of attack this is ─────────────────────────────────────────
  {
    id: "melee-only",
    re: /\b(?:with|on|for)\s+melee\b|\bmelee (?:weapon )?attacks?\b/i,
    test: (m, ctx) => {
      const k = _s(ctx.attack?.attackKind);
      if (!k) return { verdict: "unknown", why: "the kind of attack is not known here" };
      return { verdict: k.startsWith("m"), why: `this is a ${k.startsWith("m") ? "melee" : "ranged"} attack` };
    },
  },
  {
    id: "ranged-only",
    re: /\b(?:with|on|for)\s+ranged\b|\branged (?:weapon )?attacks?\b/i,
    test: (m, ctx) => {
      const k = _s(ctx.attack?.attackKind);
      if (!k) return { verdict: "unknown", why: "the kind of attack is not known here" };
      return { verdict: k.startsWith("r"), why: `this is a ${k.startsWith("r") ? "ranged" : "melee"} attack` };
    },
  },
  {
    id: "spell-only",
    re: /\bspell attacks?\b|\bwith spells?\b/i,
    test: (m, ctx) => {
      const k = _s(ctx.attack?.attackKind);
      if (!k) return { verdict: "unknown", why: "the kind of attack is not known here" };
      return { verdict: k.endsWith("sak"), why: `this is a ${k.endsWith("sak") ? "spell" : "weapon"} attack` };
    },
  },
  {
    id: "damage-type",
    re: new RegExp(`\\b(?:against|versus|vs\\.?|to)\\s+(${_alt(DAMAGE_TYPES)})\\s+damage\\b`, "i"),
    test: (m, ctx) => {
      const types = (ctx.attack?.damageTypes ?? []).map(_s);
      if (!types.length) return { verdict: "unknown", why: "this action's damage types are not known here" };
      return { verdict: types.includes(_s(m[1])), why: `this deals ${types.join(" and ")}` };
    },
  },

  // ── Where they are standing ─────────────────────────────────────────────
  {
    id: "light-level",
    re: /\bin (bright|dim|darkness|dark)\s*(?:light)?\b/i,
    test: (m, ctx) => {
      const want = _s(m[1]).replace("darkness", "dark");
      const got = _s(ctx.environment?.lightAtTarget);
      if (!got) return { verdict: "unknown", why: "the light where the target stands was not measured" };
      return { verdict: got === want, why: `the target is standing in ${got} light` };
    },
  },
  {
    id: "underwater",
    re: /\bunderwater\b|\bwhile submerged\b/i,
    test: (m, ctx) => {
      const kinds = ctx.environment?.terrainAtTarget?.kinds ?? [];
      if (!ctx.environment) return { verdict: "unknown", why: "there is no environment reading here" };
      const wet = kinds.some(k => ["water", "deep"].includes(_s(k)));
      return { verdict: wet, why: wet ? "the target is in water" : "the target is not in water" };
    },
  },

  // ── Genuinely not answerable from state ─────────────────────────────────
  // ⚠️ THESE ARE LISTED ON PURPOSE. Forcing them true or false would silently
  // add or remove a bonus nobody can see. They are named so a GM knows what is
  // outstanding rather than wondering what ACE quietly decided.
  {
    id: "once-per-turn",
    re: /\bonce per (?:turn|round)\b|\bfirst time (?:each|per) turn\b/i,
    test: () => ({ verdict: "unknown", why: "how many times this has fired this turn is not tracked here" }),
  },
  {
    id: "gm-discretion",
    re: /\bat the (?:GM|DM)'?s? discretion\b|\bif the (?:GM|DM)\b/i,
    test: () => ({ verdict: "unknown", why: "this is explicitly the GM's call" }),
  },
];

function _conditionOn(profile, word, who, { statusName = null } = {}) {
  const id = statusName ?? _s(word);
  if (!profile?.hasCondition) {
    return { verdict: "unknown", why: `whether ${who} is ${id} could not be read` };
  }
  try {
    const has = !!profile.hasCondition(id);
    return { verdict: has, why: `${who} ${has ? "is" : "is not"} ${id}` };
  } catch (err) {
    return { verdict: "unknown", why: `whether ${who} is ${id} could not be read: ${err?.message ?? err}` };
  }
}

function _bloodied(profile, who) {
  // A system that tracks Bloodied as a real status is believed outright.
  try {
    if (profile?.hasCondition?.("bloodied")) {
      return { verdict: true, why: `${who} is marked Bloodied` };
    }
  } catch (_) { /* fall through to the hit points, which are authoritative */ }

  const cur = Number(profile?.hp?.value ?? profile?.hp?.current);
  const max = Number(profile?.hp?.max);
  if (!Number.isFinite(cur) || !Number.isFinite(max) || max <= 0) {
    return { verdict: "unknown", why: `${who} hit points could not be read` };
  }
  const b = cur <= max / 2;
  return { verdict: b, why: `${who} ${b ? "is" : "is not"} bloodied (${cur} of ${max})` };
}

/**
 * Settle one conditional modifier.
 *
 * @param {string} text  the wording that made it conditional
 * @param {object} ctx   {attacker, target, attack, environment} profiles
 * @returns {{verdict: true|false|"unknown", rule, matched, why}}
 */
export function evaluateCondition(text, ctx = {}) {
  const hay = String(text ?? "");
  if (!hay.trim()) return { verdict: "unknown", rule: null, matched: null, why: "there is no condition text to read" };

  for (const rule of RULES) {
    let m = null;
    try { m = rule.re.exec(hay); } catch (_) { continue; }
    if (!m) continue;
    try {
      const r = rule.test(m, ctx);
      return { verdict: r.verdict, rule: rule.id, matched: m[0], why: r.why };
    } catch (err) {
      return { verdict: "unknown", rule: rule.id, matched: m[0],
               why: `the rule threw: ${err?.message ?? err}` };
    }
  }
  // ⚠️ NO RULE MATCHED IS NOT "IT APPLIES". An unrecognised condition stays out
  // of the arithmetic and gets named, so the gap is visible instead of guessed.
  return { verdict: "unknown", rule: null, matched: null,
           why: "ACE does not recognise this condition yet" };
}

/**
 * Settle a whole list of conditional modifiers.
 *
 * @returns {{applies, doesNotApply, unknown}}
 */
export function resolveConditionals(rows, ctx = {}) {
  const applies = [], doesNotApply = [], unknown = [];
  for (const row of (rows ?? [])) {
    const r = evaluateCondition(row.conditional, ctx);
    const out = { ...row, evaluation: r };
    if (r.verdict === true) applies.push(out);
    else if (r.verdict === false) doesNotApply.push(out);
    else unknown.push(out);
  }
  return { applies, doesNotApply, unknown };
}

/** Every condition shape ACE can settle, for the report and the self-test. */
export function knownConditionRules() {
  return RULES.map(r => r.id);
}
