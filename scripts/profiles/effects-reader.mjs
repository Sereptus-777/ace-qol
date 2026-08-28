// ─── What is modifying this creature right now, and by how much ─────────────
//
// ⚠️🔴 NO PROFILE READ AN EFFECT'S CHANGES. Counted 2026-08-28: attacker-profile
// had one reference to `.effects` and none to `statuses`; target-profile had
// zero of both; and NOTHING in the profiles directory read `.changes` at all.
//
// They knew NAMED CONDITIONS - prone, blinded, frightened - through Situation.
// They knew nothing about what an arbitrary Active Effect actually does. So the
// Gate could not see Bless's +1d4, Shield of Faith's +2 AC, a magic item's
// resistance, or any homebrew effect on any sheet in his world. Every bonus and
// penalty in the game was invisible to the thing that decides rolls.
//
// ⚠️ A LAYER, NOT A FIFTH PROFILE. An effect has no independent existence: it is
// always an effect ON something or FROM somewhere. As a peer profile every
// consumer would have to ask "whose effects?" first. As a layer, each profile
// supplies its own source and gets back the same shaped answer.
//
//     attacker profile  -> the acting creature's own effects
//     target profile    -> the target's own effects
//     environment       -> regions, auras in range, templates over the square
//
// ⚠️ IT REPORTS, THE GATE DECIDES, AND THAT IS NOT A STYLE CHOICE. dnd5e effect
// changes are key, mode and value. There is NO field for "only against undead"
// or "only while raging" - that condition lives in prose, in a module flag, or
// nowhere. So this returns modifiers WITH their conditions attached and never a
// single number. Returning "your bonus is +4" would be confidently wrong on
// every conditional effect in his world, and invisibly so.
//
// ⚠️ AND THE ENVIRONMENT MUST NOT REPEAT WHAT IS ALREADY ON A SHEET. ACE's aura
// engine writes REAL Active Effects onto tokens. If the target profile reports
// "+3 to saves" and the environment also reports "you are standing in an aura
// granting +3 to saves", the Gate adds six. Both sources are real, the number is
// plausible, and nobody would catch it without doing the arithmetic by hand.

const MODULE_ID = "ace-qol";

/** dnd5e change keys worth naming, grouped by what they touch. */
const KEY_GROUPS = [
  [/system\.bonuses\.(mwak|rwak|msak|rsak|abilities)\.attack/i, "attack"],
  [/system\.bonuses\.(mwak|rwak|msak|rsak)\.damage/i,           "damage"],
  [/system\.bonuses\.abilities\.save/i,                          "save"],
  [/system\.bonuses\.abilities\.check/i,                         "check"],
  [/system\.attributes\.ac\./i,                                  "ac"],
  [/system\.abilities\.\w+\.save/i,                              "save"],
  [/system\.abilities\.\w+\.bonuses/i,                           "ability"],
  [/system\.attributes\.movement/i,                              "movement"],
  [/system\.traits\.(dr|di|dv)/i,                                "resistance"],
  [/system\.traits\.ci/i,                                        "conditionImmunity"],
  [/system\.attributes\.hp/i,                                    "hitPoints"],
  [/system\.bonuses\.spell/i,                                    "spellDC"],
];

/**
 * Wording that means an effect only applies sometimes. dnd5e models none of it,
 * so it is read from the effect's own name and description.
 *
 * ⚠️ THIS LIST FINDS CONDITIONALS, IT DOES NOT EVALUATE THEM. Deciding whether
 * "against undead" applies needs the target, which is the Gate's job.
 */
const CONDITIONAL_HINTS = [
  /\bagainst\b/i, /\bwhile\b/i, /\bwhen\b/i, /\bif\b/i, /\bunless\b/i,
  /\bonly\b/i, /\bversus\b/i, /\bvs\.?\b/i, /\bduring\b/i, /\bon a\b/i,
];

const _s = (v) => String(v ?? "");

function _group(key) {
  for (const [re, name] of KEY_GROUPS) if (re.test(_s(key))) return name;
  return "other";
}

function _looksConditional(effect, change) {
  const hay = `${_s(effect?.name)} ${_s(effect?.description).replace(/<[^>]*>/g, " ")}`;
  if (CONDITIONAL_HINTS.some(re => re.test(hay))) return hay.trim().slice(0, 240);
  // A formula referencing the target or a roll is conditional by construction.
  if (/@target|@item|@attack/i.test(_s(change?.value))) return _s(change.value);
  return null;
}

/**
 * Everything modifying one creature.
 *
 * @param {Actor} actor
 * @param {object} [opts]
 * @param {boolean} [opts.includeSuppressed]  report effects that exist but are
 *                                            disabled or unequipped, separately
 * @returns {{modifiers, byGroup, suppressed, conditionalCount, problems, readable}}
 */
export function readEffects(actor, { includeSuppressed = true } = {}) {
  const modifiers = [];
  const suppressed = [];
  const problems = [];

  try {
    const effects = actor?.effects ?? [];
    for (const e of effects) {
      try {
        // ⚠️ `disabled` and `isSuppressed` are DIFFERENT and both matter. A
        // disabled effect was switched off; a suppressed one belongs to an item
        // that is not equipped or not attuned. Neither applies, and reporting
        // them as applying would inflate every number on the sheet.
        const off = e.disabled === true || e.isSuppressed === true;
        const changes = Array.isArray(e.changes) ? e.changes : [];
        if (!changes.length) continue;   // a pure condition marker, not a modifier

        for (const c of changes) {
          const row = {
            effect: _s(e.name),
            effectId: e.id ?? null,
            origin: _s(e.origin) || null,
            key: _s(c.key),
            group: _group(c.key),
            mode: Number(c.mode ?? 0),
            value: _s(c.value),
            priority: Number(c.priority ?? 0) || 0,
            // ⚠️ Carried, never resolved here. See the header.
            conditional: _looksConditional(e, c),
          };
          if (off) { if (includeSuppressed) suppressed.push(row); }
          else modifiers.push(row);
        }
      } catch (err) {
        problems.push(`the effect "${_s(e?.name) || "(unnamed)"}" could not be read: ${err?.message ?? err}`);
      }
    }
  } catch (err) {
    // ⚠️ "COULD NOT READ" IS NOT "NOTHING IS MODIFYING THIS CREATURE". The
    // second is a believable lie that makes every roll look correct.
    console.warn(`${MODULE_ID} | could not read the effects on "${actor?.name}":`, err);
    return { modifiers: [], byGroup: {}, suppressed: [], conditionalCount: 0,
             problems: [`the effect list could not be read: ${err?.message ?? err}`],
             readable: false };
  }

  const byGroup = {};
  for (const m of modifiers) (byGroup[m.group] ??= []).push(m);

  return {
    modifiers, byGroup, suppressed,
    conditionalCount: modifiers.filter(m => m.conditional).length,
    problems,
    readable: true,
  };
}

/**
 * Modifiers touching one thing, split into the ones that always apply and the
 * ones somebody has to judge.
 *
 * @param {object} read   the result of readEffects
 * @param {string} group  "attack" | "save" | "ac" | "damage" | ...
 */
export function modifiersFor(read, group) {
  const rows = read?.byGroup?.[group] ?? [];
  return {
    always: rows.filter(r => !r.conditional),
    conditional: rows.filter(r => r.conditional),
  };
}

/** Plain sentences for a card or the console. */
export function describeEffects(read, actorName = "this creature") {
  if (!read?.readable) return `The effects on ${actorName} could not be read.`;
  if (!read.modifiers.length) {
    return `Nothing is modifying ${actorName}`
      + (read.suppressed.length
        ? `, though ${read.suppressed.length} effect(s) are switched off or unequipped.`
        : ".");
  }
  const lines = [`${read.modifiers.length} thing(s) are modifying ${actorName}:`];
  for (const [group, rows] of Object.entries(read.byGroup)) {
    lines.push(`  ${group}: ` + rows.map(r =>
      `${r.effect} (${r.value})${r.conditional ? " — only sometimes" : ""}`).join(", "));
  }
  if (read.conditionalCount) {
    lines.push(`  ${read.conditionalCount} of them only apply in certain circumstances, `
      + `which nothing in the item data records. Those are listed, never assumed.`);
  }
  return lines.join("\n");
}
