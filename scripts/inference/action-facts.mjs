// ─── The eight questions every action answers ───────────────────────────────
//
// Johnny, 2026-08-28: "I'm trying to build the engine that looks at it and says,
// this is what's going to happen... the character just pushed a rapier attack.
// We know what rapiers are. Does this guy have this? Does the target have that?
// Are they in the rain? Are they slipping around? Is it snowing? How far is it?"
//
// ⚠️🔴 RANGE IS NOT A COMMONALITY. IT IS ONE ANSWER TO ONE OF THEM. Johnny threw
// out his own example the moment he looked at it, and he was right to: Magic
// Resistance has no range, a trait has no range, an aura has a radius, a touch
// spell has neither. Build the engine around a `range` field and every one of
// those becomes a special case, which is the one-at-a-time trap this whole file
// exists to escape.
//
// The thing they share is the QUESTION. Does this reach the target at all?
// Range answers it for a bow, radius for an aura, "touch" for Cure Wounds,
// "self" for Shield, "same plane" for Scrying, and "it is simply always on" for
// Magic Resistance. Five answer shapes, one question.
//
// So this module answers eight questions about ANY item — weapon, spell, feat,
// trait, monster action, aura — and every one of them is always answered, even
// when the answer is "nothing" or "not applicable":
//
//   1. trigger       what sets it off
//   2. cost          what it takes to use
//   3. scope         who or what it lands on
//   4. delivery      whether it arrives            <- range lives in here
//   5. resolution    how the outcome is decided
//   6. change        what actually changes
//   7. duration      how long the change lasts
//   8. interference  what can blunt or stop it
//
// ⚠️ THE ACTIVITY DOES NOT OWN THE RANGE. dnd5e stores `override: false` on an
// activity's range and target, meaning INHERIT FROM THE ITEM. A rapier's own
// activity reads `range: {units: "self"}` with override false, and reading that
// literally makes every rapier in the world a self-targeting action. The item is
// the source; an activity only speaks when it says it is overriding.
//
// ⚠️ NO ACTIVITY IS NOT NO ANSWER. Magic Resistance and Pack Tactics carry no
// activity, no activation and no target. They are not broken and they are not
// unreadable: they are PASSIVE, which is a perfectly good answer to question 1,
// and their effect is real even though nobody ever pushes a button. Treating
// "no activity" as "cannot read this" would throw away most of a monster's
// stat block.
//
// ⚠️ IMPORTS NOTHING. It reads a plain object, so the same code runs live in
// Foundry and runs offline over a copy of the world for measuring, and it can
// never join ace-qol.mjs's import cycles.

import { readActivities, readAppliedConditions } from "../read-activities.mjs";
// The spell's words with dnd5e's enrichers written out. Imports nothing.
import { plainSpellText } from "./spell-text.mjs";

const _s = (v) => String(v ?? "").trim().toLowerCase();
const _n = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const _arr = (v) => Array.isArray(v) ? v : (v instanceof Set ? [...v] : []);

/**
 * The one value out of a field that may be a string, a Set or an array.
 *
 * ⚠️🔴 dnd5e STORES A SAVE'S ABILITY AS A SET. `activity.save.ability` is a
 * SetField, so on a LIVE item it is a `Set`, while the same activity read out of
 * a compendium's JSON is an array. `String(new Set(["wis"]))` is "[object Set]",
 * which is not an ability, does not throw, and reads in a log as though the
 * spell forces a save against something called "[object set]".
 *
 * Found on 2026-09-07 by a self-test harness built to match the live shape
 * rather than the JSON one. Every measurement I had run until then went through
 * compendium JSON and could not have seen it.
 */
const _one = (v) => {
  if (v == null) return "";
  if (typeof v === "string") return v.trim().toLowerCase();
  if (v instanceof Set) return _one([...v][0]);
  if (Array.isArray(v)) return _one(v[0]);
  return _s(v);
};

/** dnd5e weapon/item property codes worth knowing by name. */
const PROP = {
  fin: "finesse", rch: "reach", thr: "thrown", two: "two-handed", ver: "versatile",
  amm: "ammunition", hvy: "heavy", lgt: "light", lod: "loading", rel: "reload",
  mgc: "magical", sil: "silvered", ada: "adamantine", foc: "focus",
  ritual: "ritual", concentration: "concentration", vocal: "verbal",
  somatic: "somatic", material: "material",
};

/**
 * The sensory and comprehension gates a thing can require. Read from the rules
 * text because dnd5e models none of them.
 *
 * ⚠️ THESE ARE THE QUIET REASON AN ACTION FAILS. A deafened target cannot be
 * commanded, a creature that does not share your language cannot be Suggested,
 * and a blinded caster cannot pick a target it must see. None of that is in the
 * item data anywhere, and without it the engine will happily resolve a Command
 * against a creature that never heard a word.
 */
const NEEDS_PATTERNS = [
  [/\bmust be able to hear\b|\bthat can hear\b|\bhears? you\b/i, "hearing"],
  [/\bmust be able to see\b|\bthat can see\b|\byou can see\b/i, "sight"],
  [/\bunderstand(?:s)? (?:your |the )?languages?\b|\bthat understands\b/i, "language"],
  [/\bclear path\b|\bunobstructed\b|\bline of effect\b/i, "lineOfEffect"],
];

/**
 * How many separate attacks, when the sheet does not say.
 *
 * ⚠️ SCORCHING RAY'S THREE RAYS ARE NOT IN ITS DATA ANYWHERE. The activity
 * carries one attack block, no count field, and 2d6 of fire. The word "three"
 * appears only in the sentence "You create three rays of fire". Structure
 * genuinely cannot answer this one, which is exactly the case Johnny asked the
 * description fallback to cover.
 */
const WORD_NUMBERS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
                       seven: 7, eight: 8, nine: 9, ten: 10 };
// ⚠️ WRITTEN CAREFULLY: `\b` IS A VALID PYTHON ESCAPE (backspace) AND `\d` IS NOT.
// Both of these patterns lost their word boundaries to a shell heredoc and
// shipped as literal BACKSPACE bytes - valid syntax, clean lint, and a regex
// that can never match what it was written to match. The \d and \s survived,
// which is what makes it look fine on a skim. control-char-check.py caught it.
const COUNT_PATTERNS = [
  /\b(one|two|three|four|five|six|seven|eight|nine|ten|\d{1,2})\s+(?:rays?|beams?|bolts?|darts?|missiles?)\b/i,
  /\bmake\s+(one|two|three|four|five|six|seven|eight|nine|ten|\d{1,2})\s+(?:\w+\s+){0,3}attacks?\b/i,
];
function countFromText(text) {
  for (const re of COUNT_PATTERNS) {
    const m = re.exec(text);
    if (!m) continue;
    const raw = String(m[1]).toLowerCase();
    const n = WORD_NUMBERS[raw] ?? Number(raw);
    if (Number.isFinite(n) && n > 1 && n <= 20) return n;
  }
  return null;
}

// ─── 1. WHAT SETS IT OFF ─────────────────────────────────────────────────────
function readTrigger(item, acts, why) {
  const activation = acts.find(a => _s(a?.activation?.type))?.activation
    ?? item?.system?.activation ?? null;
  const type = _s(activation?.type);
  const condition = String(activation?.condition ?? "").trim();

  if (!acts.length && !type) {
    why.push("nothing on it can be activated, so it is always on");
    return { kind: "passive", on: "always", detail: null, condition: null };
  }
  if (type === "reaction") {
    why.push(condition ? `it is a reaction to: ${condition}` : "it is a reaction");
    return { kind: "reaction", on: "reaction", detail: condition || null, condition: condition || null };
  }
  if (type === "legendary" || type === "lair" || type === "mythic") {
    why.push(`it is a ${type} action`);
    return { kind: "activated", on: type, detail: null, condition: condition || null };
  }
  if (!type) {
    why.push("it has something to do but names no activation, so it is treated as always on");
    return { kind: "passive", on: "always", detail: null, condition: null };
  }
  why.push(`it is used on purpose, costing ${type === "bonus" ? "a bonus action" : "an " + type}`);
  return { kind: "activated", on: type, detail: null, condition: condition || null };
}

// ─── 2. WHAT IT COSTS ────────────────────────────────────────────────────────
function readCost(item, acts, why) {
  const sys = item?.system ?? {};
  const activation = acts.find(a => _s(a?.activation?.type))?.activation ?? sys.activation ?? null;
  const action = _s(activation?.type) || "none";

  const uses = sys.uses ?? null;
  const maxUses = uses?.max ?? null;
  const recovery = _arr(uses?.recovery).map(r => _s(r?.period)).filter(Boolean);

  // Consumption is per-activity and is where ammunition, charges and hit dice live.
  const consumes = [];
  for (const a of acts) {
    for (const t of _arr(a?.consumption?.targets)) {
      const kind = _s(t?.type);
      if (kind) consumes.push({ kind, amount: String(t?.value ?? "").trim() || null });
    }
  }

  const isSpell = _s(item?.type) === "spell";
  const level = isSpell ? _n(sys.level) : null;
  // ⚠️🔴 `system.preparation` IS DEPRECATED AND DIES IN dnd5e 6.0. Verified in
  // the installed 5.3.3 source: SpellData#preparation logs a compatibility
  // warning and says to use `method` in its place, "until: DnD5e 6.0". Reading
  // only the old shape means this quietly starts answering null on the version
  // after next, and "not prepared" and "could not tell" would then be the same
  // answer. The new field first, the old one only as a fallback for data that
  // has not been migrated yet.
  const prepared = isSpell
    ? (_s(sys.method) || _s(sys.preparation?.mode) || null)
    : null;

  if (maxUses) why.push(`it has limited uses${recovery.length ? `, back on a ${recovery.join(" and ")}` : ""}`);
  if (isSpell && level === 0) why.push("it is a cantrip, so it costs no slot");
  else if (isSpell && level) why.push(`it spends a level ${level} slot`);

  return {
    action,
    slotLevel: level,
    preparation: prepared,
    maxUses: maxUses ? String(maxUses) : null,
    recovery,
    consumes,
    // ⚠️ RECHARGE IS A MONSTER'S WHOLE ECONOMY. A dragon's breath is not limited
    // by uses at all: it comes back on a d6. Missing it makes a legendary
    // creature either infinitely powerful or permanently spent.
    recharge: _s(sys.uses?.recovery?.find?.(r => _s(r?.period) === "recharge")?.formula)
      || _s(sys.recharge?.value) || null,
  };
}

// ─── 3. WHO OR WHAT IT LANDS ON ──────────────────────────────────────────────
// ⚠️🔴 THE SHEET SAYS "NO CHOICE" FOR SPELLS WHOSE WORDS GIVE ONE. dnd5e marks
// `affects.choice` on four area spells in all of its books. Slow's sheet says no
// choice while its text says "up to six creatures of your choice in a 40-foot
// Cube"; Sleep and Weird say "each creature of your choice" in theirs. Read the
// sheet alone and all three catch everyone standing in them, allies included.
//
// ⚠️ THE CHOICE HAS TO BE OF WHO IS IN THE AREA. Calm Emotions also says
// "creatures of your choice", about who its target stops being hostile toward,
// and that is not a choice of who the area catches. So every phrase here is tied
// to the area it chooses from: "... of your choice in a 40-foot Cube", "...
// you choose in the Emanation", "... within 30 feet of you".
const NUMBER_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
  eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };
const _NUM = "(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|\\d+)";
const _IN_AREA = "(?:with)?in\\s+(?:a|an|the|that|it|\\d+\\s*(?:feet|foot|ft))\\b";
const CHOICE_PICK = [
  new RegExp(`\\b(?:up\\s+to\\s+${_NUM}\\s+|each\\s+|any\\s+number\\s+of\\s+)?creatures?\\s+`
    + `(?:of\\s+your\\s+choice|you\\s+choose)(?:\\s+that\\s+you\\s+can\\s+see)?\\s+${_IN_AREA}`, "i"),
  new RegExp(`\\bchoose\\s+(?:up\\s+to\\s+)?${_NUM}\\s+creatures?\\s+${_IN_AREA}`, "i"),
];
// "you can designate creatures to be unaffected by it" (Spirit Guardians),
// "designate any creatures you choose, and the spell ignores them" (Cordon).
const CHOICE_SPARE = /\bdesignate\b[^.]{0,80}?\b(?:to\s+be\s+unaffected|unaffected\s+by|the\s+spell\s+ignores)\b/i;

/**
 * Whether the spell's own words let the caster choose who in its area it affects.
 *
 * @param {string} words  plain text, enrichers already written out
 * @returns {{choice: "pick"|"spare"|null, count: number|null, phrase: string|null}}
 */
function readChoiceWords(words) {
  const text = String(words ?? "");
  for (const re of CHOICE_PICK) {
    const m = text.match(re);
    if (m) {
      const raw = String(m[1] ?? "").toLowerCase();
      const count = raw ? (NUMBER_WORDS[raw] ?? _n(raw)) : null;
      return { choice: "pick", count, phrase: m[0] };
    }
  }
  const s = text.match(CHOICE_SPARE);
  if (s) return { choice: "spare", count: null, phrase: s[0] };
  return { choice: null, count: null, phrase: null };
}

function readScope(item, acts, why, words = "") {
  const sys = item?.system ?? {};
  // ⚠️ OVERRIDE IS A PRIORITY RULE, NOT AN ON/OFF SWITCH, AND READING IT AS
  // ON/OFF LOST REAL DATA. `override:true` means the activity replaces the
  // item's value. `override:false` means defer to the item - but a FEAT has no
  // item-level target at all, so deferring to nothing threw away the only
  // answer there was. Second Wind states `affects.type: "self"` on its activity
  // and nowhere else, and came back "lands on: none".
  // Order: an overriding activity, then the item, then any activity that
  // actually says something.
  const act = acts.find(a => a?.target?.override === true)
    ?? (_s(sys.target?.affects?.type) || _s(sys.target?.template?.type) ? null
        : acts.find(a => _s(a?.target?.affects?.type) || _s(a?.target?.template?.type)));
  const target = act?.target ?? sys.target ?? {};
  const affects = target.affects ?? {};
  const template = target.template ?? sys.target?.template ?? {};

  const count = _n(affects.count);
  const type = _s(affects.type) || null;
  const hasTemplate = !!_s(template.type);

  // ⚠️🔴 THE CHOICE IS A FACT ABOUT THE SPELL, NOT ABOUT ONE ACTIVITY. Weird and
  // Prismatic Spray carry a second activity (the end-of-turn save, the indigo
  // ray) that overrides its target to one creature, and the override rule above
  // picks that one. Reading the choice only when the chosen block had an area
  // lost Weird's "each creature of your choice" entirely. An area anywhere on the
  // item makes its words about who the area catches worth reading.
  const areaSomewhere = hasTemplate || !!_s(sys.target?.template?.type)
    || acts.some(a => _s(a?.target?.template?.type));
  const told = areaSomewhere ? readChoiceWords(words) : { choice: null, count: null, phrase: null };
  // ⚠️ A SPARE IS NOT A PICK, EVEN WHERE THE SHEET CALLS IT A CHOICE. The
  // Player's Handbook marks Spirit Guardians as a choice because its caster "can
  // designate creatures to be unaffected". The area still catches everyone else.
  const picks = told.choice === "pick" || (!!affects.choice && told.choice !== "spare");
  const choiceFacts = { spares: told.choice === "spare", choiceWords: told.phrase,
                        choiceCount: told.count };

  if (hasTemplate) {
    // ⚠️🔴 AN AREA CAN STILL STATE A COUNT, AND THIS WAS THROWING IT AWAY.
    // Mass Cure Wounds is "up to six creatures in a 30-foot-radius Sphere":
    // the sphere is where you may choose from, the six is how many you get.
    // Returning null here lost the six, so anything downstream had to read it
    // as "everyone standing in it" and would heal the enemy in the sphere.
    // ⚠️ A BLANK COUNT IS STORED AS "" AND READS AS 0, which is "not stated",
    // not "none". Treating it as a number lost the 2024 Slow's "up to six".
    const n = (count && count > 0 ? count : null) ?? told.count ?? null;
    if (picks) {
      why.push(n ? `it covers an area, and you pick up to ${n} from inside it`
                 : "it covers an area, and you pick which creatures in it are affected");
    } else if (count) {
      why.push(`it covers an area, and you pick ${count} from inside it`);
    } else {
      why.push(told.choice === "spare"
        ? "it covers an area, and you may spare creatures inside it"
        : "it covers an area rather than picking creatures");
    }
    return { kind: "area", count: n, creatureType: type, allowsChoice: picks, ...choiceFacts };
  }
  if (type === "self") {
    why.push("it acts on the user");
    return { kind: "self", count: 1, creatureType: null, allowsChoice: false };
  }
  if (count && count > 1) {
    why.push(`it picks ${count} ${type || "creature"}s`);
    return { kind: "several", count, creatureType: type, allowsChoice: picks, ...choiceFacts };
  }
  if (count === 1 || type) {
    why.push(`it picks one ${type || "creature"}`);
    return { kind: "one", count: 1, creatureType: type, allowsChoice: picks, ...choiceFacts };
  }
  return { kind: "none", count: null, creatureType: null, allowsChoice: picks, ...choiceFacts };
}

// ─── 4. WHETHER IT ARRIVES ───────────────────────────────────────────────────
function readDelivery(item, acts, text, why) {
  const sys = item?.system ?? {};
  // ⚠️ THE OVERRIDE TRAP, THE EXPENSIVE ONE. A rapier's attack activity reads
  // `range: {units: "self", override: false}`. Taken literally every rapier in
  // the world becomes a self-targeting action and no melee attack ever reaches
  // anybody. Only an activity that SAYS it overrides gets to speak.
  // ⚠️🔴 AN OVERRIDE THAT SAYS NOTHING MUST NOT WIN. Surfaced the moment
  // activities became visible at all: Hunter's Mark has a damage activity
  // marked `override: true` with units `"spec"` — "special, see the text" — and
  // Silent Image has a check activity the same. Those hijacked the range vote
  // and left the reading as "unstated" while the item's own 90 feet sat there
  // unused. While activities were invisible the blindness accidentally hid it.
  //
  // So an activity earns the override only when it states a distance somebody
  // could measure. `spec` and a blank are not distances; they are a note to
  // read the paragraph.
  // ⚠️ AN OVERRIDE MAY REFINE, IT MAY NOT BLUR. `spec` and `any` are not
  // distances, they are notes saying "read the paragraph" and "wherever". A
  // rider activity carrying one of those must not erase a concrete range the
  // item states: Hunter's Mark says 90 feet on the item and carries a damage
  // activity marked `override: true, units: "any"`, which turned a 90 foot
  // spell into an unlimited one the moment activities became visible.
  //
  // If the ITEM has no concrete range either, a vague activity is still better
  // than nothing and gets to speak.
  const VAGUE = new Set(["", "any", "spec", "special"]);
  const concrete = (r) => !VAGUE.has(_s(r?.units));
  const itemIsConcrete = concrete(sys.range);
  const act = acts.find(a => a?.range?.override === true
                          && (concrete(a.range) || !itemIsConcrete))
    ?? (itemIsConcrete ? null : acts.find(a => _s(a?.range?.units)));
  const range = act?.range ?? sys.range ?? {};

  const units = _s(range.units);
  const reach = _n(range.reach ?? sys.range?.reach);
  const value = _n(range.value);
  const long = _n(range.long);

  // ⚠️🔴 THE OVERRIDE TRAP AGAIN, AND THE TWO FIELDS ARE NOT SYMMETRICAL.
  //
  // This line was a copy of the range guard above, and for range that guard is
  // right: an item HAS its own `system.range`, so an activity that does not
  // override should fall back to it. A spell item has NO `system.target` at
  // all — proven from dnd5e's own SpellData schema, which defines `range` and
  // never defines `target`. Targeting lives entirely on activities in 5.x.
  //
  // So for a template the fallback could never contain anything, and every
  // spell whose activity says `override: false` — which is nearly all of them,
  // because false means "I do not override the item", not "I have no template"
  // — was read as having no area whatsoever.
  //
  // Johnny, 2026-09-07, after Fear did nothing at all: his item said cone, 30
  // feet, save, prompt true, and the classifier called it a self-buff. Not
  // because the cone was hidden, but because the one line that gathers it
  // refused to look at the activity carrying it. Cone of Cold escaped only by
  // having a hand-written registry entry and never reaching this code.
  //
  // ⚠️ AN OVERRIDING ACTIVITY STILL WINS. If one genuinely declares itself
  // authoritative, it is preferred; otherwise the first activity that actually
  // has a template speaks, and the item-level field remains the last resort for
  // the item types that really do have one (weapons, consumables, features).
  // ⚠️🔴 AND AN OVERRIDE WITH AN EMPTY TEMPLATE MUST NOT WIN EITHER. Same
  // shape as the range fault above, found the same way: an activity marked
  // `override: true` whose template has no `type` returned an empty object,
  // which is not nullish, so `??` stopped there and the item's real template
  // was never reached. Grease, Entangle and Minor Illusion all lost their area
  // that way. Every clause now has to produce a template that names a shape.
  const withShape = (a) => _s(a?.target?.template?.type) ? a.target.template : null;
  const tmplSrc = acts.filter(a => a?.target?.override === true).map(withShape).find(Boolean)
    ?? acts.map(withShape).find(Boolean)
    ?? (_s(sys.target?.template?.type) ? sys.target.template : null)
    ?? {};
  const tmplShape = _s(tmplSrc.type) || null;

  const needs = [];
  for (const [re, name] of NEEDS_PATTERNS) if (re.test(text)) needs.push(name);
  if (needs.length) why.push(`its text requires ${needs.join(" and ")}`);

  const template = tmplShape
    ? { shape: tmplShape, size: _n(tmplSrc.size), width: _n(tmplSrc.width), units: _s(tmplSrc.units) || "ft" }
    : null;

  let kind, rangeFt = null;
  // ⚠️🔴 A THROWN AREA STILL HAS A RANGE, AND IT WAS BEING DROPPED. This
  // branch set `kind` and never `rangeFt`, so all 145 area spells in dnd5e's
  // books came back with no distance at all: Fireball's 150 feet, gone. Nothing
  // downstream could tell whether the crosshair was even legal to place there.
  if (template && units === "self") { kind = "emanation"; why.push(`it radiates ${template.size} feet from the user`); }
  else if (template)                { kind = "area";      rangeFt = value ?? reach ?? null;
                                      why.push(`it puts a ${template.shape} of ${template.size} feet on the map`
                                        + `${value ? `, up to ${value} feet away` : ""}`); }
  else if (units === "self")        { kind = "self";      why.push("it does not have to travel anywhere"); }
  else if (units === "touch")       { kind = "touch";     why.push("it is delivered by touch"); }
  else if (units === "any" || units === "unlimited") { kind = "unlimited"; why.push("its range is unlimited"); }
  else if (reach)                   { kind = "reach";  rangeFt = reach; why.push(`it reaches ${reach} feet`); }
  else if (value)                   { kind = "ranged"; rangeFt = value;
                                      why.push(`it reaches ${value} feet${long ? `, ${long} at long range` : ""}`); }
  else if (units === "spec" || units === "special") {
    // ⚠️ "SEE THE TEXT" IS AN ANSWER, JUST NOT A NUMBER. Calling it "unstated"
    // reads as missing data and invites something downstream to guess.
    kind = "special"; why.push("its reach is described in its own text rather than as a distance");
  }
  else if (!acts.length)            { kind = "none";      why.push("it is always in effect and does not travel"); }
  else                              { kind = "unstated";  why.push("nothing states how far it reaches"); }

  return { kind, rangeFt, longRangeFt: long, reachFt: reach, template,
           needs, unitsRaw: units || null };
}

// ─── 5. HOW THE OUTCOME IS DECIDED ───────────────────────────────────────────
function readResolution(item, acts, parsed, text, why) {
  const attackAct = acts.find(a => _s(a?.type) === "attack");
  const saveAct   = acts.find(a => a?.save?.ability);

  if (attackAct) {
    const at = attackAct.attack ?? {};
    const melee = _s(at.type?.value) === "melee";
    const stated = _n(at.number);
    const fromText = stated ? null : countFromText(text);
    const count = stated ?? fromText ?? 1;
    why.push(count > 1
      ? `it makes ${count} attack rolls${fromText ? ", counted from its own text" : ""}`
      : `it is ${melee ? "a melee" : "a ranged"} attack roll`);
    return { kind: "attack", melee, ranged: !melee, ability: _one(at.ability) || null,
             attacks: Math.max(1, count), classification: _s(at.type?.classification) || null,
             saveAbility: null, dc: null, onSave: null };
  }
  if (saveAct) {
    const dc = saveAct.save?.dc ?? {};
    const half = _s(saveAct?.damage?.onSave) === "half";
    why.push(`the target rolls a ${_one(saveAct.save.ability).toUpperCase()} saving throw`);
    return { kind: "save", melee: false, ranged: false, ability: null, attacks: 0,
             saveAbility: _one(saveAct.save.ability),
             // Every ability named, for the rare activity that offers a choice.
             saveAbilities: _arr(saveAct.save.ability).map(a => _s(a)).filter(Boolean),
             dc: _n(dc.formula) ?? null, dcFrom: _s(dc.calculation) || null,
             onSave: half ? "half" : "none" };
  }
  // ⚠️ THE DESCRIPTION IS THE FALLBACK, NEVER THE OVERRULE. Monster stat blocks
  // and homebrew routinely state a save in prose and carry none in the data.
  if (parsed?.save?.ability) {
    why.push(`the sheet declares no saving throw; its text names a ${_one(parsed.save.ability).toUpperCase()} save`);
    return { kind: "save", melee: false, ranged: false, ability: null, attacks: 0,
             saveAbility: _one(parsed.save.ability), dc: _n(parsed.save.dc) ?? null,
             dcFrom: "description", onSave: parsed.halfOnSave ? "half" : "none", fromText: true };
  }
  if (!acts.length) {
    why.push("nothing is rolled for it; it simply applies");
    return { kind: "none", melee: false, ranged: false, attacks: 0, saveAbility: null, dc: null, onSave: null };
  }
  why.push("no attack roll and no saving throw: it takes effect automatically");
  return { kind: "automatic", melee: false, ranged: false, attacks: 0, saveAbility: null, dc: null, onSave: null };
}

// ─── 6. WHAT ACTUALLY CHANGES ────────────────────────────────────────────────
function readChange(item, acts, parsed, why) {
  const sys = item?.system ?? {};
  const damage = [];

  // A weapon's damage lives on the ITEM as `damage.base`, and its activity says
  // `includeBase: true` rather than repeating it. Read both or a rapier deals none.
  const base = sys.damage?.base;
  if (base && (_n(base.number) || String(base.custom?.formula ?? "").trim())) {
    damage.push({ formula: base.custom?.enabled ? String(base.custom.formula)
                    : `${base.number}d${base.denomination}`,
                  types: _arr(base.types), base: true });
  }
  for (const a of acts) {
    for (const p of _arr(a?.damage?.parts)) {
      damage.push({ formula: p.custom?.enabled ? String(p.custom.formula)
                      : `${p.number ?? ""}d${p.denomination ?? ""}${p.bonus ? ` + ${p.bonus}` : ""}`,
                    types: _arr(p.types),
                    scales: !!p.scaling?.mode });
    }
  }

  const heals = acts.some(a => _s(a?.type) === "heal");

  // ⚠️🔴 HOW MUCH IT HEALS, NOT JUST THAT IT DOES. `heals` was a bare
  // boolean, so a shape worked out from the item knew a spell restored hit
  // points and had no idea how many. An emanation heal or a template heal that
  // reaches the resolver without dice cannot roll anything, which would be a
  // dead button wearing a correct shape.
  let healing = null;
  for (const a of acts) {
    const h = a?.healing;
    if (!h) continue;
    const formula = h.custom?.enabled ? String(h.custom.formula)
      : (h.number && h.denomination)
        ? `${h.number}d${h.denomination}${h.bonus ? ` + ${h.bonus}` : ""}`
        : (h.formula ? String(h.formula) : null);
    if (!formula) continue;
    healing = { formula: formula.trim(), types: _arr(h.types),
                scales: !!h.scaling?.mode };
    break;
  }
  const summons = acts.some(a => _s(a?.type) === "summon");
  if (summons) why.push("it puts a creature on the board");
  const effectIds = acts.flatMap(a => _arr(a?.effects).map(e => e?._id).filter(Boolean));
  const ownEffects = _arr(item?.effects).length;
  // ⚠️🔴 THE PARSER RETURNS OBJECTS, NOT NAMES. `DescriptionParser` gives
  // `{ condition, requiresSave }` per condition, and every reader here treated
  // the list as strings. Found on 2026-09-07 in the engine's own explanation of
  // Fear, which read: *"its text can leave a target [object Object]"*.
  //
  // It was never only cosmetic. The classifier builds a spell's effect from
  // `change.conditions[0]`, so the key it wrote was an object rather than
  // "frightened", and the learned store fingerprints an item by joining the
  // same list, so every condition-applying item in the world shared one value
  // on that field and could not be told apart.
  //
  // Names here, details beside them for anything that needs the save flag.
  // ⚠️🔴 AND THE ITEM'S OWN EFFECTS COME FIRST, because they are DATA.
  // Fear's item carries an Active Effect with `statuses: ["frightened"]` and an
  // activity that names it with `onSave: false`. Reading only the description
  // meant a thin or re-written one applied nothing at all, however correctly
  // the item was built — which is exactly what happened to his Fear on
  // 2026-09-08: zero conditions parsed, a Specter that failed on a 1, nothing.
  const fromEffects = readAppliedConditions(item);
  const conditionDetails = [...fromEffects];
  const seenCond = new Set(fromEffects.map(c => String(c.condition)));
  for (const c of _arr(parsed?.conditions)) {
    const shaped = (typeof c === "string") ? { condition: c, requiresSave: false } : c;
    const key = String(shaped?.condition ?? "").trim().toLowerCase();
    if (!key || seenCond.has(key)) continue;
    seenCond.add(key);
    conditionDetails.push(shaped);
  }
  const conditions = conditionDetails.map(c => String(c.condition));
  if (fromEffects.length) {
    why.push(`its own effect${fromEffects.length > 1 ? "s" : ""} `
      + `${[...new Set(fromEffects.map(c => `"${c.effectName ?? c.condition}"`))].join(", ")} `
      + `appl${fromEffects.length > 1 ? "y" : "ies"} ${fromEffects.map(c => c.condition).join(" and ")}`);
  }

  if (damage.length) why.push(`it deals ${damage.map(d => d.formula + " " + (d.types[0] ?? "")).join(" and ").trim()}`);
  if (heals) why.push(healing ? `it restores ${healing.formula} hit points`
                             : "it restores hit points");
  if (conditions.length) why.push(`its text can leave a target ${conditions.join(" or ")}`);
  else if (effectIds.length || ownEffects) why.push("it applies a lasting effect");

  return {
    damage,
    damageTypes: [...new Set(damage.flatMap(d => d.types))],
    heals,
    healing,          // { formula, types, scales } or null
    summons,
    conditions,        // names, e.g. ["frightened"]
    conditionDetails,  // [{ condition, requiresSave }]
    appliesEffect: effectIds.length > 0 || ownEffects > 0,
    // A passive with no activity and no effect still DOES something, and the only
    // record of what is its own prose. Saying so is better than reporting nothing.
    descriptiveOnly: !damage.length && !heals && !summons && !conditions.length
      && !effectIds.length && !ownEffects,
  };
}

// ─── 7. HOW LONG THE CHANGE LASTS ────────────────────────────────────────────
function readDuration(item, acts, why) {
  const sys = item?.system ?? {};
  const d = sys.duration ?? {};
  const units = _s(d.units);
  const value = _n(d.value);
  const conc = !!d.concentration || _arr(sys.properties).includes("concentration");

  if (conc) why.push("it needs concentration, so anything that breaks that ends it");

  if (!units || units === "inst" || units === "instantaneous") {
    return { kind: "instant", value: null, units: null, concentration: conc };
  }
  if (units === "perm") { why.push("it lasts until something removes it");
    return { kind: "permanent", value: null, units: null, concentration: conc }; }
  if (units === "spec") { why.push("its duration is described in its own text rather than as a number");
    return { kind: "special", value: null, units: null, concentration: conc }; }
  if (units === "disp") { why.push("it lasts until dispelled");
    return { kind: "dispelled", value: null, units: null, concentration: conc }; }

  why.push(`it lasts ${value ?? ""} ${units}`.replace(/\s+/g, " ").trim());
  return { kind: "timed", value, units, concentration: conc };
}

// ─── 8. WHAT CAN BLUNT OR STOP IT ────────────────────────────────────────────
function readInterference(item, acts, parsed, change, resolution, why) {
  const sys = item?.system ?? {};
  const props = _arr(sys.properties).map(_s);
  const magical = props.includes("mgc") || _s(item?.type) === "spell";

  const out = {
    magical,
    // Damage types are the whole resistance and immunity conversation.
    damageTypes: change.damageTypes,
    // Conditions it inflicts are the whole condition-immunity conversation, and
    // this is the one the Gate needs BEFORE the roll, not after it.
    conditionsInflicted: change.conditions,
    // ⚠️ A REPEATED SAVE IS AN ESCAPE, AND GUESSING ONE EITHER ROBS A CREATURE
    // OF IT OR HANDS IT ONE IT NEVER HAD. Only ever taken from stated text.
    repeatSave: parsed?.repeatingSave?.at ?? null,
    halfOnSave: resolution.onSave === "half",
    bypassedBy: props.filter(p => ["sil", "ada", "mgc"].includes(p)).map(p => PROP[p] ?? p),
    // A creature type gate is why a Command does nothing to a skeleton.
    creatureTypeLimit: parsed?.targetTypeRestriction ?? null,
  };
  if (out.repeatSave) why.push(`the target gets another save at ${out.repeatSave}`);
  if (out.creatureTypeLimit) why.push(`it only works on ${out.creatureTypeLimit}`);
  return out;
}

/**
 * Answer all eight questions about any item.
 *
 * @param {object} item      raw item data (a Foundry Item works too)
 * @param {object} [opts]
 * @param {object} [opts.parsed]  DescriptionParser.parse(item) when available.
 *                                Passed IN so this module imports nothing.
 * @returns {object} the eight answers, plus `evidence` explaining every one.
 */
export function readActionFacts(item, { parsed = null } = {}) {
  const why = [];
  try {
    const sys = item?.system ?? {};
    // ⚠️🔴 THIS WAS `Object.values(sys.activities)`, WHICH IS ALWAYS EMPTY.
    // `activities` is a Collection, which is a Map, and Object.values on a Map
    // returns []. Every reader below — trigger, cost, scope, delivery,
    // resolution, change — has therefore been working from an empty list since
    // dnd5e 5.x moved targeting, ranges and saves onto activities. The whole
    // inference engine has been reading items with half the sheet invisible.
    const acts = readActivities(item);
    const text = String(sys.description?.value ?? "").replace(/<[^>]*>/g, " ");

    const trigger    = readTrigger(item, acts, why);
    const cost       = readCost(item, acts, why);
    const scope      = readScope(item, acts, why, plainSpellText(sys.description?.value ?? ""));
    const delivery   = readDelivery(item, acts, text, why);
    const resolution = readResolution(item, acts, parsed, text, why);
    const change     = readChange(item, acts, parsed, why);

    // ⚠️ AN ATTACK ROLL ALWAYS HAS SOMEBODY TO HIT. Weapons carry no
    // `affects` block at all - a rapier's target data is entirely blank - so the
    // scope read came back "none" for every weapon in the world. If a thing
    // makes an attack roll, it lands on one creature by definition.
    if (resolution.kind === "attack" && scope.kind === "none") {
      scope.kind = "one"; scope.count = 1;
      why.push("it makes an attack roll, so it lands on one creature");
    }
    const duration   = readDuration(item, acts, why);
    const interference = readInterference(item, acts, parsed, change, resolution, why);

    return {
      name: item?.name ?? null,
      itemType: _s(item?.type) || null,
      properties: _arr(sys.properties).map(p => PROP[_s(p)] ?? _s(p)),
      trigger, cost, scope, delivery, resolution, change, duration, interference,
      evidence: why,
      readable: true,
    };
  } catch (err) {
    // ⚠️ NEVER LET A READ FAILURE LOOK LIKE AN EMPTY ANSWER. "I could not read
    // this" and "this does nothing" must never print the same way; the second is
    // a believable lie about his data and has cost whole sessions before.
    return {
      name: item?.name ?? null, itemType: _s(item?.type) || null,
      readable: false, error: String(err?.message ?? err),
      evidence: [...why, `could not be read: ${err?.message ?? err}`],
    };
  }
}

/** The eight answers as sentences a human can check. */
export function describeActionFacts(f) {
  if (!f?.readable) return `"${f?.name ?? "this"}" could not be read: ${f?.error ?? "no reason recorded"}`;
  return [
    `${f.name}:`,
    `  sets off      ${f.trigger.kind}${f.trigger.condition ? ` (${f.trigger.condition})` : ""}`,
    `  costs         ${f.cost.action}${f.cost.slotLevel ? `, level ${f.cost.slotLevel} slot` : ""}${f.cost.recharge ? `, recharge ${f.cost.recharge}` : ""}`,
    `  lands on      ${f.scope.kind}${f.scope.count > 1 ? ` (${f.scope.count})` : ""}`,
    `  arrives by    ${f.delivery.kind}${f.delivery.rangeFt ? `, ${f.delivery.rangeFt} feet` : ""}${f.delivery.template ? `, ${f.delivery.template.shape} ${f.delivery.template.size} feet` : ""}${f.delivery.needs.length ? `, needs ${f.delivery.needs.join(" and ")}` : ""}`,
    `  decided by    ${f.resolution.kind}${f.resolution.saveAbility ? ` (${f.resolution.saveAbility.toUpperCase()})` : ""}${f.resolution.attacks > 1 ? ` x${f.resolution.attacks}` : ""}`,
    `  changes       ${[f.change.damage.length ? f.change.damage.map(d => d.formula).join(" + ") : null, f.change.heals ? "healing" : null, f.change.conditions.join("/") || null, f.change.appliesEffect ? "an effect" : null].filter(Boolean).join(", ")
        // ⚠️ "nothing recorded" READ AS "IT DOES NOTHING", which is a lie about
        // Magic Resistance and every other passive whose whole rule is prose.
        || (f.change.descriptiveOnly ? "only what its own text says, no mechanics on the sheet" : "nothing recorded")}`,
    `  lasts         ${f.duration.kind}${f.duration.value ? ` ${f.duration.value} ${f.duration.units}` : ""}${f.duration.concentration ? ", concentration" : ""}`,
    // ⚠️ SAY WHAT BLUNTS IT, NOT JUST THE WORD. This line used to print
    // "blunted by  frightened", which reads as the spell being weakened BY the
    // frightened condition. It means the opposite: a creature immune to
    // frightened shrugs it off.
    `  blunted by    ${[
      f.interference.damageTypes.length
        ? `resistance to ${f.interference.damageTypes.join("/")}` : null,
      f.interference.conditionsInflicted.length
        ? `immunity to ${f.interference.conditionsInflicted.join("/")}` : null,
      f.interference.repeatSave ? `another save at ${f.interference.repeatSave}` : null,
    ].filter(Boolean).join("; ") || "nothing recorded"}`,
  ].join("\n");
}
