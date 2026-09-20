// ─── ACE: QOL — What a creature's own words say fires by itself ─────────────
//
// Johnny, 2026-09-19. Three feature families, none of them pressed by anyone:
//
//   DEATH BURST / DEATH THROES  "When the creature hits 0 hit points, if its
//     words say it explodes / bursts / death throes: area, damage, save,
//     conditions, all from that item's words. No button. Detect by the words,
//     not a name list."
//   HEATED BODY / FIRE AURAS    "anything whose words say: you take fire when
//     you touch it, hit it with melee, or start your turn next to it. That
//     trigger runs with no button."
//   PETRIFYING GAZE             "Start of a creature's turn, in range, can see
//     the gazer: CON save. Fail: Restrained (or what that copy's words say).
//     Second fail while still restrained: Petrified. Avert eyes if the words
//     give that choice."
//
// This file only READS. It says which of those an item's words describe and
// what the sentence that says it gives: the area, the timing, who is caught,
// the dice written there. The recipe (inference/recipe.mjs) still says what a
// save decides; the engines that fire these say WHEN and WHO.
//
// ⚠️ THE SENTENCE, NOT THE NAME. Four names in his world are "Death Burst" and
// one of them only leaves a cloud behind; "Hellfire Orb" explodes and is an
// action; Zuggtmoy's spores burst out of her. What decides is a sentence that
// ties the explosion to the creature dying.
//
// ⚠️ A LEAF: IMPORTS NOTHING, so every engine and the replay can read it.
// ──────────────────────────────────────────────────────────────────────────────

/** The conditions a sentence can name, the damage types, and the words of a save. */
const CONDITIONS = new Set(["blinded", "charmed", "deafened", "frightened", "grappled", "incapacitated",
  "invisible", "paralyzed", "petrified", "poisoned", "prone", "restrained", "stunned", "unconscious"]);

const DAMAGE_TYPES = new Set(["acid", "bludgeoning", "cold", "fire", "force", "lightning", "necrotic",
  "piercing", "poison", "psychic", "radiant", "slashing", "thunder"]);

const SAVES = /\bsaving throw\b|\bDC \d+\b|\bmust succeed on\b/i;

/* ═══ The words, as a person reads them ═══════════════════════════════════ */

/**
 * An item's description as plain words: tags gone, references read as their
 * label, and the dice an enricher carries kept where the sentence has them.
 *
 *   "&Reference[restrained]{restrained}"          → "restrained"
 *   "[[lookup @name lowercase]]{monster}"          → "monster"
 *   "[[lookup @target.template.size activity=…]]" → "" (the number is on the activity)
 *   "[[/damage 3d6 type=fire]]"                    → "3d6 fire"
 *   "[[/damage average]]"                          → "(damage)"
 *   "[[/save con 14 format=long]]{ DC 14}"         → " DC 14"
 *
 * ⚠️🔴 A LOOKUP IS PART OF THE SENTENCE (2026-09-19). The 2024 Monster Manual's
 * Magmin says "The monster explodes [[lookup @activation.condition
 * activity=1SfqWSp7RSyHgG4b]]", and that lookup is "when it dies": the one
 * thing that makes it a death burst lived inside a tag this reader threw away.
 * So the Magmin on his map dropped to 0 and nothing burst. Given the item, a
 * lookup reads the way dnd5e renders it: the activity's own field, the
 * creature's name, the case it asks for; the tag's {label} only when nothing
 * answers.
 *
 * @param {string} html
 * @param {{item?: Item}} [ctx]  the item the words belong to, to answer its lookups
 */
export function plainWords(html, { item = null } = {}) {
  let s = String(html ?? "");
  s = s.replace(/\[\[lookup\s+@([\w.]+)([^\]]*)\]\](?:\{([^}]*)\})?/gi,
    (_m, path, opts, label) => lookupText(item, path, opts, label));
  s = s.replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
    .replace(/&#39;|&apos;/gi, "'").replace(/&quot;/gi, "\"");
  // A labelled reference or enricher reads as its label.
  s = s.replace(/(?:&|@)\w+\[[^\]]*\]\{([^}]*)\}/g, "$1");
  s = s.replace(/(?:&|@)\w+\[([^\]|]*)[^\]]*\]/g, "$1");
  s = s.replace(/\[\[[^\]]*\]\]\{([^}]*)\}/g, "$1");
  // Damage enrichers keep their dice and type; a bare one keeps its place.
  s = s.replace(/\[\[\/(?:damage|dmg)\s+([^\]]*?)\]\]/gi, (_m, body) => {
    const dice = String(body).match(/\d*d\d+(?:\s*[+-]\s*\d+)?/i)?.[0];
    const type = String(body).match(/type=([a-z]+)/i)?.[1];
    return dice ? `${dice}${type ? ` ${type}` : ""}` : "(damage)";
  });
  s = s.replace(/\[\[\/(?:damage|dmg)\]\]/gi, "(damage)");
  s = s.replace(/\[\[\/save\b([^\]]*)\]\]/gi, (_m, body) => {
    const dc = String(body).match(/\bdc=(\d+)/i)?.[1] ?? String(body).match(/\b(\d+)\b/)?.[1];
    return dc ? ` DC ${dc} saving throw` : " a saving throw";
  });
  s = s.replace(/\[\[[^\]]*\]\]/g, "");
  return s.replace(/\s+/g, " ").trim();
}

/** The words of an item, its lookups answered from the item itself. */
export function itemWords(item) {
  return plainWords(item?.system?.description?.value ?? "", { item });
}

/** One activity of an item by id, from a live collection or stored data. */
function activityOf(item, id) {
  const acts = item?.system?.activities;
  if (!acts) return null;
  if (id) return acts.get?.(id) ?? acts[id] ?? null;
  const list = [...(acts.values?.() ?? Object.values(acts))];
  return list[0] ?? null;
}

const pathGet = (o, path) => String(path).split(".").reduce((x, k) => (x == null ? undefined : x[k]), o);

/**
 * What a "[[lookup @path ...]]" says for this item, the way dnd5e renders it:
 * with `activity=`, that activity's field; "@name" the creature's name, "@item.x"
 * the item's; a bare activity field ("@save.dc.value") from its first activity.
 * Case options apply. Nothing found: the tag's {label}, or nothing.
 */
function lookupText(item, path, opts = "", label = "") {
  const o = String(opts ?? "");
  const act = activityOf(item, o.match(/\bactivity=([\w-]+)/i)?.[1] ?? null);
  let v;
  if (/\bactivity=/i.test(o)) v = pathGet(act, path);
  else if (path === "name") v = item?.actor?.name ?? item?.parent?.name ?? null;
  else if (path.startsWith("item.")) v = pathGet(item, path.slice(5));
  else if (/^(?:activation|save|target|range|duration|damage|uses)\b/.test(path)) v = pathGet(activityOf(item, null), path);
  if (v === undefined || v === null || v === "" || typeof v === "object") return String(label ?? "");
  let text = String(v);
  if (/\blowercase\b/i.test(o)) text = text.toLowerCase();
  else if (/\buppercase\b/i.test(o)) text = text.toUpperCase();
  else if (/\bcapitalize\b/i.test(o)) text = text.charAt(0).toUpperCase() + text.slice(1);
  return text;
}

/**
 * The sentences, split where a sentence really ends. "5 ft. of it" does not
 * end one, and neither does a decimal.
 */
export function sentencesOf(text) {
  return String(text ?? "")
    .replace(/\b(ft|in|lb|no|vs|approx|e\.g|i\.e)\./gi, "$1․")
    .split(/(?<=[.!?])\s+(?=[A-Z0-9(])/)
    .map(x => x.replace(/․/g, ".").trim())
    .filter(Boolean);
}

/** A number of feet written in words: "10 ft.", "30 feet", "a 20-foot Emanation", "60-foot-radius". */
export function feetIn(sentence) {
  const s = String(sentence ?? "");
  const m = s.match(/(\d+)\s*-?\s*(?:ft\b\.?|feet\b|foot\b)/i);
  return m ? Number(m[1]) : null;
}

/**
 * The dice a sentence writes: "takes 13 (3d8) Fire damage", "take 4 (1d8)
 * slashing damage", "takes 10 (3d6 fire) damage". Empty when the sentence only
 * has the placeholder an enricher left, so the item's own damage is used.
 *
 * @returns {Array<{formula: string, type: string|null}>}
 */
export function diceIn(sentence) {
  const out = [];
  const s = String(sentence ?? "");
  const re = /(\d*d\d+(?:\s*[+-]\s*\d+)?)(?:\s+([a-z]+))?\)?\s*(?:([a-z]+)\s+)?damage/gi;
  let m;
  while ((m = re.exec(s))) {
    const type = [m[2], m[3]].map(t => String(t ?? "").toLowerCase())
      .find(t => DAMAGE_TYPES.has(t)) ?? null;
    out.push({ formula: m[1].replace(/\s+/g, ""), type });
  }
  return out;
}

/* ═══ Is this a passive trait? ═════════════════════════════════════════════ */

/**
 * A trait nobody presses: no activity, or none that costs an action, a bonus
 * action, a reaction or a legendary action. Cloud Prison and Deadly Nightshade
 * say "starts its turn within 10 feet of the cloud", and they are legendary
 * actions that make the cloud: the cloud catches people, the dragon-sage's body
 * does not.
 */
export function isPassive(item) {
  const PRESSED = new Set(["action", "bonus", "reaction", "legendary", "lair", "mythic", "crew"]);
  const acts = item?.system?.activities;
  const list = acts ? [...(acts.values?.() ?? Object.values(acts))] : [];
  return !list.some(a => PRESSED.has(String(a?.activation?.type ?? "").toLowerCase()));
}

/* ═══ 1. A death burst ═════════════════════════════════════════════════════ */

const DIES = /\b(?:dies|is reduced to 0 hit points|drops to 0 hit points|is killed)\b/i;
const BURSTS = /\b(?:explodes?|explosion|bursts?|death throes)\b/i;

/**
 * Does this item's words make the creature burst when it dies?
 *
 * The sentence has to tie the two together: "When the magmin dies, it explodes
 * in a burst of fire and magma", "The mephit explodes when it dies", "The gas
 * spore bursts when it dies", "When the rot zombie is reduced to 0 hit points,
 * it explodes". The sentences after it (who saves, what it deals) belong to it.
 *
 * @returns {null|{sentence: string, words: string, radiusFt: number|null,
 *   nothingToRoll?: boolean, gmOnly?: string}}
 *   `radiusFt` from the words when they give it (the activity's area otherwise);
 *   `gmOnly` names a burst ACE cannot run and says why; `nothingToRoll` a burst
 *   whose words put nothing on anyone (the marid's burst of water and foam).
 */
export function readDeathBurst(item) {
  const words = itemWords(item);
  if (!words) return null;
  const sents = sentencesOf(words);
  // The death and the explosion in one sentence, or the explosion in the very
  // next one ("When the Boar Cart is reduced to 0 hit points, roll a d6. ...
  // explode"). A name alone ("Death Burst") never fires it: the Smoke Mephit's
  // older copy is named that and only leaves a cloud behind.
  let i = sents.findIndex(s => DIES.test(s) && BURSTS.test(s));
  if (i < 0) i = sents.findIndex((s, k) => DIES.test(s) && /\bexplode/i.test(sents[k + 1] ?? ""));
  if (i < 0) {
    const named = BURSTS.test(String(item?.name ?? ""));
    const k = named ? sents.findIndex(s => DIES.test(s)) : -1;
    if (k < 0) return null;
    // Named like one and says what happens at death, but no explosion: said, never run.
    return { sentence: sents[k], words: sents.slice(k).join(" "), radiusFt: null, nothingToRoll: true,
      notABurst: true };
  }
  const sentence = sents[i];
  const rest = sents.slice(i).join(" ");
  // Where it reaches: the burst's own sentences, the first number of feet.
  const reach = sents.slice(i, i + 3).map(feetIn).find(n => Number.isFinite(n)) ?? null;
  const out = { sentence, words: rest, radiusFt: reach };
  if (/\broll a d\d+\b|\bon a roll of\b/i.test(rest)) {
    out.gmOnly = "its words make the explosion depend on a die roll, so the GM runs it";
  } else if (/\bat the start of its next turn\b/i.test(sentence + " " + (sents[i + 1] ?? ""))
             && /\bexplode\b/i.test(rest)) {
    out.gmOnly = "its words make it explode on a later turn, so the GM runs it";
  } else if (/\b(?:in|fills) the room\b/i.test(rest)) {
    out.gmOnly = "its words reach \"the room\", which ACE cannot measure, so the GM runs it";
  }
  const saves = /\bsaving throw\b|\bsave\b|\bDC \d+/i.test(rest);
  const damages = /\bdamage\b/i.test(rest);
  const conditions = /\b(?:blinded|charmed|deafened|frightened|grappled|incapacitated|paralyzed|petrified|poisoned|prone|restrained|stunned|unconscious)\b/i.test(rest);
  if (!saves && !damages && !conditions) out.nothingToRoll = true;
  return out;
}

/* ═══ 2. A body that burns on a turn ══════════════════════════════════════ */

/**
 * Does this item's words burn the creatures around it on a turn?
 *
 *   "At the end of each of the salamander's turns, each creature of the
 *    salamander's choice in a 5-foot Emanation originating from the salamander
 *    takes 7 (2d6) Fire damage."                      → its own turn, ends
 *   "At the start of each of the balor's turns, each creature within 5 feet of
 *    it takes 10 (3d6) fire damage"                    → its own turn, starts
 *   "A creature that starts its turn within 5 feet of the X takes ..."
 *                                                       → the other creature's turn
 *
 * A burning TARGET ("the target takes 1d6 fire damage at the end of each of its
 * turns") is not this: nobody else is caught, only the one that was set alight.
 *
 * @returns {null|{when: "own-end"|"own-start"|"their-start", radiusFt: number|null,
 *   choice: boolean, unlessIncapacitated: boolean, dice: Array<{formula,type}>, sentence: string}}
 */
export function readTurnAura(item) {
  if (!isPassive(item)) return null;
  const words = itemWords(item);
  if (!words) return null;
  const sents = sentencesOf(words);
  for (const s of sents) {
    const own = s.match(/\bat the (start|end) of each of (?:the )?[\w' -]+?'s turns\b/i)
      ?? s.match(/\bat the (start|end) of each of its turns\b/i);
    const caught = /\beach (?:creature|\w+)\b[^.]*?\b(?:within \d+\s*(?:ft\.?|feet)|in an? \d*\s*-?\s*foot emanation|-foot emanation)/i.test(s)
      || /\beach (?:creature|\w+)\b[^.]*\bemanation\b/i.test(s);
    const next = sents[sents.indexOf(s) + 1] ?? "";
    const saves = SAVES.test(s) || (/\bon a failed save\b/i.test(next) && SAVES.test(`${s} ${next}`));
    if (own && caught && /\btakes?\b|\bmust (?:succeed|make)\b/i.test(s)) {
      return {
        when: own[1].toLowerCase() === "start" ? "own-start" : "own-end",
        radiusFt: feetIn(s),
        choice: /\bof (?:the )?[\w' -]+?'s choice\b|\bof its choice\b/i.test(s),
        unlessIncapacitated: /\bunless (?:the )?[\w' -]+? (?:has the )?incapacitated\b/i.test(`${s} ${next}`),
        dice: diceIn(s),
        save: saves,
        sentence: s,
        placeholder: placeholderIndex(sents, s),
      };
    }
    const theirs = s.match(/\b(?:a|any|each) creature (?:that )?starts its turn within (\d+)\s*(?:ft\.?|feet) of (?:the |it\b)/i);
    if (theirs && /\btakes?\b|\bmust (?:succeed|make)\b/i.test(s) && /\bdamage\b/i.test(`${s} ${next}`)) {
      return {
        when: "their-start",
        radiusFt: Number(theirs[1]),
        choice: false,
        unlessIncapacitated: /\bunless (?:the )?[\w' -]+? (?:has the )?incapacitated\b/i.test(`${s} ${next}`),
        dice: diceIn(s),
        save: saves,
        sentence: s,
        placeholder: placeholderIndex(sents, s),
      };
    }
  }
  return null;
}

/**
 * Which "(damage)" placeholder of the item's words this sentence holds, when
 * the dice live on the activity: the 2014 balor's Fire Aura says "(damage)"
 * twice, once for the aura and once for a touch, and its activity carries two
 * 3d6 parts in the same order.
 * @returns {number|null}
 */
function placeholderIndex(sents, sentence) {
  if (!/\(damage\)/.test(sentence)) return null;
  let n = 0;
  for (const x of sents) {
    if (x === sentence) return n;
    n += (x.match(/\(damage\)/g) ?? []).length;
  }
  return null;
}

/* ═══ 3. A gaze at the start of a turn ════════════════════════════════════ */

/**
 * Does this item's words force a save on a creature that starts its turn near
 * it, the way a 2014 basilisk's or medusa's gaze does?
 *
 *   "If a creature starts its turn within 30 ft. of the basilisk and the two of
 *    them can see each other, the basilisk can force the creature to make a DC
 *    12 Constitution saving throw if the basilisk isn't incapacitated."
 *   "When a creature that can see the medusa's eyes starts its turn within 30
 *    ft. of the medusa, the medusa can force it to make a DC 14 Constitution
 *    saving throw if the medusa isn't incapacitated and can see the creature."
 *
 * The 2024 copies are a bonus-action cone with a recharge: pressed, never this.
 *
 * @returns {null|{rangeFt: number, needsSight: boolean, avert: boolean,
 *   failBy: {n: number, condition: string}|null, escalates: string|null, sentence: string}}
 */
export function readTurnGaze(item) {
  if (!isPassive(item)) return null;
  const words = itemWords(item);
  if (!words) return null;
  const sents = sentencesOf(words);
  const i = sents.findIndex(s => /\bstarts its turn within (\d+)\s*(?:ft\.?|feet)\b/i.test(s)
    && /\bcan force\b/i.test(s) && /\bsaving throw\b|\bsave\b/i.test(s));
  if (i < 0) return null;
  const sentence = sents[i];
  return {
    rangeFt: Number(sentence.match(/\bstarts its turn within (\d+)/i)[1]),
    needsSight: /\bcan see each other\b|\bcan see (?:the [\w' -]+?'s eyes|it|the creature)\b/i.test(sentence),
    avert: /\bavert(?:s)? its eyes\b/i.test(words),
    failBy: readFailBy(item),
    escalates: readEscalation(item),
    sentence,
  };
}

/**
 * "If the saving throw fails by 5 or more, the creature is instantly petrified."
 * @returns {null|{n: number, condition: string}}
 */
export function readFailBy(item) {
  const words = itemWords(item);
  const m = words.match(/\bfails? (?:the (?:saving throw|save) )?by (\d+) or more,?\s+([^.]*)/i);
  if (!m) return null;
  const rest = m[2];
  const cond = rest.match(/\b(?:is|becomes|has the)\s+(?:instantly\s+|immediately\s+)?([a-z]+)\b/i)?.[1]?.toLowerCase();
  if (cond && CONDITIONS.has(cond)) return { n: Number(m[1]), condition: cond };
  // "the creature is reduced to 0 hit points": not a condition, and the GM's.
  return { n: Number(m[1]), condition: null, other: rest.replace(/^(?:the creature|it)\s+/i, "").trim() };
}

/**
 * What a creature that is turning to stone becomes when its repeat save fails:
 * "It must repeat the saving throw at the end of its next turn ... On a
 * failure, the creature is petrified", "becoming petrified on a failure",
 * "Second Failure: The target has the Petrified condition".
 * @returns {string|null}
 */
export function readEscalation(item) {
  const words = itemWords(item);
  if (!/\brepeats? the sav(?:ing throw|e)\b/i.test(words) && !/\bsecond failure\b/i.test(words)) return null;
  const m = words.match(/\b(?:on a failure,? (?:the (?:creature|target) )?(?:is|becomes)|becoming|second failure:? (?:the target )?has the)\s+([a-z]+)\b/i);
  const cond = m?.[1]?.toLowerCase() ?? null;
  return cond && cond !== "the" ? cond : null;
}

/* ═══ 4. A frightening presence ═══════════════════════════════════════════ */

// The sentence that makes it one: everyone within so many feet of the creature
// saves or is frightened. Both editions write it, and neither is read by name.
//
//   2014: "Each creature of the dragon's choice that is within 120 feet of the
//          dragon and aware of it must succeed on a DC 21 Wisdom saving throw
//          or become frightened for 1 minute."
//   2014: "Each non-undead creature within 60 ft. of the ghost that can see it
//          must succeed on a DC 13 Wisdom saving throw or be frightened..."
//   2024: "Wisdom Saving Throw: DC 21, each creature in a 120-foot Emanation
//          originating from the dragon. Failure: ... Frightened ..."
const FEET_NEAR = /\bwithin (\d+)\s*(?:ft\.?|feet)\b|\b(\d+)[- ]foot emanation\b|\b(\d+)[- ]foot radius\b/i;
const FRIGHTENS = /\bfrightened\b/i;
// Who it leaves out: "Each non-undead creature", "each creature that isn't a construct".
const NOT_A = /\beach\s+non-([a-z]+)\s+creature\b|\beach creature that (?:isn't|is not) an?\s+([a-z]+)\b/i;
// Whose choice it is: "of the dragon's choice", "of its choice".
const ITS_CHOICE = /\bof (?:the [\w' -]+?'s|its|his|her|their) choice\b/i;
// What it needs of the victim: seeing it, or merely knowing it is there.
const MUST_SEE = /\bthat can see it\b|\bcan see the [\w' -]+\b|\baware of it\b|\bcan see and hear\b/i;
// How long the fear lasts, and how long the creature is safe afterwards.
const FOR_MINUTES = /\bfor (\d+) minutes?\b/i;
const UNTIL_NEXT_TURN = /\buntil the end of (?:its|their) next turn\b/i;
const IMMUNE_HOURS = /\bimmune to [^.]*?\bfor (?:the next )?(\d+) hours?\b/i;
const REPEATS = /\brepeats? the sav(?:ing throw|e)\b|\bcan repeat the sav/i;
// ⚠️ SOMETHING THE CREATURE DOES IS NOT SOMETHING IT IS. A Cloaker moans, a
// Sphinx roars, a Shadow Mastiff howls, a bard plays Pipes of Haunting: all of
// them frighten a room full of creatures with a saving throw, and every one is
// an act, taken when its owner chooses. A presence is the creature itself, and
// it is the only one of them that may fire without a press.
const AN_ACT = /\b(?:hears?|hearing|moans?|roars?|howls?|shouts?|screams?|shrieks?|wails?|bellows?|emits?|exhales?|utters?|speaks?|plays?|blasts?|presents?)\b/i;
// ⚠️ "YOU" IS A PLAYER'S OWN FEATURE. Monster words are third person; a feature
// written at its owner ("you present your holy symbol") is Akra's Channel
// Divinity, and nothing of hers may go off on its own.
const SECOND_PERSON = /\byou\b|\byour\b/i;

/**
 * Does this item's words frighten everyone near the creature?
 *
 * ⚠️ NEVER BY NAME. "Frightful Presence" is what most of them are called and
 * three of his are not (Horrifying Visage, Frightening Presence, and a bite
 * that frightens the bystanders). The words decide, the same way the death
 * burst and the gaze do.
 *
 * ⚠️ AND NEVER A SPELL. Fear, Cause Fear and Eyebite frighten from a spell
 * list; they are cast, they have their own rules, and they do not hand out a
 * 24-hour immunity to themselves.
 *
 * @returns {null|{radiusFt: number, needsSight: boolean, choice: boolean,
 *   excludes: string|null, durationSeconds: number|null, repeats: boolean,
 *   immuneHours: number|null, sentence: string}}
 */
export function readFrightfulPresence(item) {
  if (!item || item.type === "spell") return null;
  const words = itemWords(item);
  if (!words || !FRIGHTENS.test(words)) return null;
  const sents = sentencesOf(words);
  // The sentence that says both "near me" and "saves", in either order.
  const i = sents.findIndex(s => FEET_NEAR.test(s) && SAVES.test(s)
    && (FRIGHTENS.test(s) || FRIGHTENS.test(sents[sents.indexOf(s) + 1] ?? "")));
  if (i < 0) return null;
  const sentence = sents[i];
  const m = sentence.match(FEET_NEAR);
  const radiusFt = Number(m?.[1] ?? m?.[2] ?? m?.[3] ?? 0);
  if (!(radiusFt > 0)) return null;
  // ⚠️ A REACH IS NOT A PRESENCE. The Feyr's Frightful Bite frightens everyone
  // within 10 feet of ITSELF when it hits, which is a rider on an attack and
  // belongs to the attack's own card, not to a presence that fires on sight.
  if (/\bhit:/i.test(sentence) || /\bmelee (?:weapon )?attack\b/i.test(sentence)) return null;

  const not = words.match(NOT_A);
  const mins = words.match(FOR_MINUTES);
  const hours = words.match(IMMUNE_HOURS);
  const needsSight = MUST_SEE.test(sentence) || MUST_SEE.test(words);
  return {
    radiusFt,
    /**
     * ⚠️ DOES IT FIRE BY ITSELF? Only a presence does, and 131 items in his
     * world write an area fear save. Being frightening by merely being there
     * is: seeing it (or being aware of it) is what does it, no act of the
     * creature's is named, its words are about IT rather than about "you", and
     * it hands out the immunity that says a creature only faces it once.
     *
     * Everything else is still read — the picker and the card are the same —
     * but it waits for a press, because its owner chooses when to do it.
     */
    byPresence: needsSight && !!hours && !AN_ACT.test(words) && !SECOND_PERSON.test(words),
    needsSight,
    choice: ITS_CHOICE.test(sentence),
    excludes: (not?.[1] ?? not?.[2] ?? null)?.toLowerCase() ?? null,
    durationSeconds: mins ? Number(mins[1]) * 60 : (UNTIL_NEXT_TURN.test(words) ? null : 60),
    repeats: REPEATS.test(words),
    // ⚠️ THE HOURS COME FROM THE WORDS. Every copy of this in his world says 24,
    // and a copy that says something else gets what it says, not what the
    // common one says. No immunity sentence at all means no immunity.
    immuneHours: hours ? Number(hours[1]) : null,
    sentence,
  };
}

/* ═══ A recipe from the words, when the item has nothing to press ════════ */

/**
 * The smallest recipe the road can run for damage nothing rolls against,
 * built from the dice a sentence writes. Only ever for an item with no
 * activity to read: a 2024 Fire Aura imported without one.
 */
export function wordsRecipe(label, dice) {
  return {
    decidedBy: { kind: "automatic" },
    onSuccess: (dice ?? []).map(d => ({ kind: "damage", formula: d.formula, types: d.type ? [d.type] : [] })),
    onFail: [], onHit: [], onCrit: [], onMiss: [],
    recatch: [], who: { kind: "all-in-area" }, where: { kind: "self" },
    label, fromWords: true,
  };
}
