// ─── ACE: QOL — THE FORMULA THAT MADE THE NUMBER ─────────────────────────────
//
// ⚠️ HIS RULE, 2026-09-29: "Save required, save result, attack, check, auto-escape
// whisper: print the formula that made the number, not just the total." For
// Escher's Dexterity save that is:
//
//     Dex 1 (-5) + proficiency +3 = -2
//
// then the d20 and the final total against the DC.
//
// ⚠️ NOTHING IS INVENTED. Every part comes off the sheet and nothing else does:
// the ability score and its modifier, proficiency when the sheet says this
// creature is proficient, the ability's own save or check bonus when it is set,
// and the actor's global bonus when it has one. A part that is zero or absent is
// not printed, because a chip saying "+0 item" is a lie about the sheet.
//
// ⚠️ AND PROFICIENCY IS NEVER HIDDEN INSIDE THE ABILITY. "DEX -2" tells him
// nothing; "Dex 1 (-5) + proficiency +3 = -2" tells him why a creature with a
// Dexterity of 1 is not as hopeless as it looks. They are separate parts.
//
// ⚠️ IT DOES NOT DO THE ARITHMETIC OVER. The total it prints is the sum of the
// parts it found; where a caller already has dnd5e's own number, it says so when
// the two disagree rather than quietly printing its own.
//
// ⚠️ EVERYTHING IT DRAWS STAYS INSIDE ITS PILL. The row is flex with wrap and
// every chip has a min-height rather than a fixed one, so a long formula grows
// downward instead of running off the card (his standing rule).
// ──────────────────────────────────────────────────────────────────────────────

const MODULE_ID = "ace-qol";

const ABILITY_NAME = { str: "Str", dex: "Dex", con: "Con", int: "Int", wis: "Wis", cha: "Cha" };

const signed = (n) => `${n >= 0 ? "+" : "−"}${Math.abs(Number(n) || 0)}`;

/** A number out of a bonus field that may be "", "0", "+2" or a formula. */
function flatBonus(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return 0;
  const n = Number(s);
  if (Number.isFinite(n)) return n;
  // Anything with dice or a reference in it is not a flat part; it is said by
  // name instead of guessed at.
  return null;
}

/**
 * The parts behind a saving throw, read from the creature's own sheet.
 *
 * @param {Actor} actor
 * @param {string} ability   "dex"
 * @returns {{parts: Array<{label: string, value: number, why: string}>, total: number}}
 */
/* ═══════════════════════════════════════════════════════════════════════
   THE SHORT KIND, AND NOTHING ELSE (his rule, 2026-09-30)

     Wrong:  + Cloak of Protection +1
     Right:  +1 cloak

   "the short kind, then nothing else. prof · cloak · ring · amulet · circlet ·
    stone · Bless · Guidance. A spell or condition uses that short name. An item
    uses its type, never the title. If you cannot map it, print +1 only and put
    the real name in the console."

   ⚠️🔴 THIS IS A TABLE, NOT A GUESS. My first pass printed the effect's own
   name, so a save read "+ Cloak of Protection +1" and the card grew a title in
   the middle of a sum. The table below is the whole vocabulary; anything it does
   not know prints its NUMBER ALONE and says in the console what it actually
   found, so the gap is visible and he can tell me the word to add.
   ═══════════════════════════════════════════════════════════════════════ */

/** His vocabulary. A new word goes in here and nowhere else. */
const SHORT_KIND = [
  [/\bcloak\b/i,    "cloak"],
  [/\bring\b/i,     "ring"],
  [/\bamulet\b/i,   "amulet"],
  [/\bcirclet\b/i,  "circlet"],
  [/\bstone\b/i,    "stone"],
  [/\bbless\b/i,    "Bless"],
  [/\bguidance\b/i, "Guidance"],
];

/**
 * The short kind for whatever grants a bonus, or null when the table does not
 * know it.
 *
 * Tested against the effect's own name AND the name of the item or spell it came
 * from, because either can be the recognisable one: an effect called "Protection"
 * from an item called "Cloak of Protection" maps on the ITEM, and a condition ACE
 * put on called "Bless" maps on itself.
 */
function shortKindOf(effect) {
  const names = [];
  try {
    if (effect?.name) names.push(String(effect.name));
    const origin = effect?.origin;
    if (origin && typeof fromUuidSync === "function") {
      const resolved = fromUuidSync(origin);
      const item = resolved?.item ?? resolved;
      if (item?.name) names.push(String(item.name));
    }
  } catch (_) { /* whatever name we already have is what gets tested */ }
  for (const n of names) {
    for (const [re, kind] of SHORT_KIND) if (re.test(n)) return { kind, from: n };
  }
  return { kind: null, from: names.join(" / ") || "nothing named it" };
}

/**
 * WHAT IS GIVING THIS BONUS: its short kind, or nothing at all.
 *
 * A save bonus beyond the ability and its proficiency lives in a formula field on
 * the sheet, and the field does not know what put it there. The EFFECT does: an
 * active effect granting it carries a change whose key is that very field.
 *
 * @param {Actor} actor
 * @param {string[]} keys  the change keys that would grant it
 * @returns {string|null} the short kind, or null so the part prints its number alone
 */
function grantedBy(actor, keys) {
  try {
    const want = keys.map(k => String(k).toLowerCase());
    const kinds = [];
    const unmapped = [];
    for (const e of (actor?.effects?.contents ?? actor?.effects ?? [])) {
      if (e?.disabled) continue;                       // switched off grants nothing
      let mine = false;
      for (const c of (e?.changes ?? [])) {
        if (want.includes(String(c?.key ?? "").toLowerCase())) { mine = true; break; }
      }
      if (!mine) continue;
      const { kind, from } = shortKindOf(e);
      if (kind) kinds.push(kind);
      else unmapped.push(from);
    }
    if (unmapped.length) {
      console.log(`${MODULE_ID} | ${actor?.name}'s bonus from ${unmapped.join(", ")} has no short `
        + `kind in the table, so the card prints its number alone. Add a word to SHORT_KIND `
        + `in roll-formula.mjs to name it.`);
    }
    // Several things stacking into one field: name them all rather than pick one.
    const shown = [...new Set(kinds)];
    return shown.length ? shown.join(" ") : null;
  } catch (err) {
    console.log(`${MODULE_ID} | could not read what grants ${actor?.name}'s save bonus, so the `
      + `card prints its number alone:`, err);
    return null;
  }
}

export function explainSave(actor, ability) {
  const ab = String(ability ?? "").toLowerCase();
  const a = actor?.system?.abilities?.[ab];
  const parts = [];
  if (!a) return { parts, total: 0 };

  const score = Number(a.value);
  const mod = Number.isFinite(Number(a.mod)) ? Number(a.mod)
    : Math.floor((Number.isFinite(score) ? score : 10) - 10) / 2 | 0;
  parts.push({
    label: Number.isFinite(score) ? `${ABILITY_NAME[ab] ?? ab.toUpperCase()} ${score}` : (ABILITY_NAME[ab] ?? ab.toUpperCase()),
    value: mod, why: "ability",
  });

  // ⚠️ PROFICIENCY IS ITS OWN PART. `proficient` is 0, 1 or 0.5 on a sheet.
  const profMult = Number(a.proficient ?? 0);
  const prof = Number(actor?.system?.attributes?.prof ?? 0);
  if (profMult > 0 && prof) {
    const v = Math.floor(prof * profMult);
    if (v) parts.push({ label: "prof", value: v, why: "proficient in this save" });
  }

  const own = flatBonus(a.bonuses?.save);
  if (own) {
    const by = grantedBy(actor, [`system.abilities.${ab}.bonuses.save`]);
    if (!by) {
      console.log(`${MODULE_ID} | ${actor?.name}'s ${ab.toUpperCase()} save carries ${signed(own)} `
        + `that no active effect claims, so the card prints the number alone rather than naming `
        + `something that is not there.`);
    }
    parts.push({ label: by, value: own, why: "on the ability itself" });
  }
  else if (own === null) {
    console.log(`${MODULE_ID} | ${actor?.name}'s ${ab.toUpperCase()} save bonus is a formula `
      + `("${a.bonuses?.save}"), so it is left off the card rather than guessed at.`);
  }

  const global = flatBonus(actor?.system?.bonuses?.abilities?.save);
  if (global) {
    const by = grantedBy(actor, ["system.bonuses.abilities.save"]);
    if (!by) {
      console.log(`${MODULE_ID} | ${actor?.name} carries ${signed(global)} on every save that no `
        + `active effect claims, so the card prints the number alone.`);
    }
    parts.push({ label: by, value: global, why: "on the creature" });
  }

  return { parts, total: parts.reduce((n, p) => n + p.value, 0) };
}

/**
 * The parts behind an ability check or a skill check.
 *
 * @param {Actor} actor
 * @param {object} o
 * @param {string} [o.ability]  "str"
 * @param {string} [o.skill]    "ath" — when given, its own ability and proficiency win
 */
export function explainCheck(actor, { ability = null, skill = null } = {}) {
  const parts = [];
  const sk = skill ? actor?.system?.skills?.[skill] : null;
  const ab = String((sk?.ability ?? ability) ?? "").toLowerCase();
  const a = actor?.system?.abilities?.[ab];
  if (!a) return { parts, total: 0 };

  const score = Number(a.value);
  const mod = Number(a.mod);
  parts.push({
    label: Number.isFinite(score) ? `${ABILITY_NAME[ab] ?? ab.toUpperCase()} ${score}` : (ABILITY_NAME[ab] ?? ab.toUpperCase()),
    value: Number.isFinite(mod) ? mod : 0, why: "ability",
  });

  const prof = Number(actor?.system?.attributes?.prof ?? 0);
  const mult = Number((sk ? sk.value : a.proficient) ?? 0);
  if (mult > 0 && prof) {
    const v = Math.floor(prof * mult);
    // ⚠️ EXPERTISE IS SAID BY ITS NAME. A multiplier of 2 is not "proficiency
    // twice"; he asked for why each part is there.
    const label = mult >= 2 ? "expertise" : mult < 1 ? "half prof" : "prof";
    if (v) parts.push({ label, value: v, why: skill ? "proficient in this skill" : "proficient" });
  }

  const own = flatBonus(sk ? sk.bonuses?.check : a.bonuses?.check);
  // The short kind, or its number alone: the same rule as a save extra.
  if (own) parts.push({ label: grantedBy(actor, [`system.abilities.${ab}.bonuses.check`]),
                        value: own, why: "on the sheet" });

  const global = flatBonus(actor?.system?.bonuses?.abilities?.check);
  if (global) parts.push({ label: grantedBy(actor, ["system.bonuses.abilities.check"]),
                          value: global, why: "on the creature" });

  return { parts, total: parts.reduce((n, p) => n + p.value, 0) };
}

/**
 * The parts as one line of text: "Dex 1 (-5) + proficiency +3 = -2".
 *
 * @param {Array} parts
 * @param {number} [total]  what the caller believes the bonus is; when it differs
 *   from the sum of the parts, the caller's number is shown and the difference is
 *   named, because dnd5e may know of something this reader cannot see.
 */
export function formulaText(parts, total = null) {
  if (!parts?.length) return "";
  // ⚠️ HIS SHAPE, EXACTLY (2026-09-30: "Order: number then label. +1 cloak.
  // +3 prof. +2 Bless."):
  //
  //     Wis 16 (+3) = +3
  //     Dex 1 (−5) +3 prof = +0
  //     Wis 16 (+3) +1 cloak = +4
  //
  // The first part carries its modifier in brackets beside the score. Every part
  // after it is its signed number and then its short label, and the sign on the
  // number is the only joiner, so a penalty reads "−2 cover" with no stray plus
  // in front of it.
  //
  // ⚠️ A PART WITH NO LABEL PRINTS ITS NUMBER ALONE. That is the honest answer
  // for a bonus whose source the table cannot map to a short kind: the number is
  // real, the name is not known, and the console carries what was found.
  const shown = parts.map((p, i) => {
    if (i === 0) {
      return p.why === "ability" ? `${p.label} (${signed(p.value)})` : `${p.label} ${signed(p.value)}`;
    }
    return p.label ? `${signed(p.value)} ${p.label}` : signed(p.value);
  });
  const sum = parts.reduce((n, p) => n + p.value, 0);
  const end = Number.isFinite(Number(total)) ? Number(total) : sum;
  const line = `${shown.join(" ")} = ${signed(end)}`;
  // ⚠️🔴 THE ARGUMENT ABOUT THE NUMBER IS NOT FOR THE CARD (his rule,
  // 2026-09-29: "Never print '+2 more than the sheet shows' or any book-vs-sheet
  // note. That note is for the console, not chat.").
  //
  // It printed on the card, in the middle of the formula, and it is a note to ME
  // about a disagreement between what the roll used and what the sheet adds up to.
  // The table gets the number; the console gets the argument.
  if (Number.isFinite(Number(total)) && Number(total) !== sum) {
    console.log(`ace-qol | the roll used ${signed(Number(total))} where this sheet adds up to `
      + `${signed(sum)} (${signed(Number(total) - sum)}). The card shows what the roll used: `
      + `${line}`);
  }
  return line;
}

/**
 * The formula as a pill for a card.
 *
 * ⚠️ IT WRAPS. flex + wrap, min-height, overflow-wrap — a long formula grows
 * downward and never leaves the card or clips its own text.
 */
export function formulaPill(parts, { total = null, label = "" } = {}) {
  const text = formulaText(parts, total);
  if (!text) return "";
  const esc = (v) => foundry.utils.escapeHTML(String(v ?? ""));
  return `<div class="ace-qol-formula-pill">`
    + (label ? `<span class="ace-qol-formula-label">${esc(label)}</span>` : "")
    + `<span class="ace-qol-formula-text">${esc(text)}</span>`
    + `</div>`;
}

/** The whole line for a roll: the formula, the die, the total, and the verdict. */
export function rollLineHtml({ parts, bonus = null, d20 = null, total = null, dc = null,
    passed = null, label = "" } = {}) {
  const esc = (v) => foundry.utils.escapeHTML(String(v ?? ""));
  const bits = [formulaPill(parts, { total: bonus, label })];
  if (d20 != null || total != null) {
    const verdict = passed === true ? "PASS" : passed === false ? "FAIL" : "";
    const colour = passed === true ? "#9bcc4a" : passed === false ? "#d98b46" : "#d4af37";
    bits.push(`<div class="ace-qol-formula-pill">`
      + `<span class="ace-qol-formula-label">roll</span>`
      + `<span class="ace-qol-formula-text">`
      + (d20 != null ? `d20 ${esc(d20)}` : "")
      + (d20 != null && bonus != null ? ` ${signed(bonus)}` : "")
      + (total != null ? ` = <b style="color:${colour};">${esc(total)}</b>` : "")
      + (dc != null ? ` vs DC ${esc(dc)}` : "")
      + (verdict ? ` <b style="color:${colour};">${verdict}</b>` : "")
      + `</span></div>`);
  }
  return `<div class="ace-qol-formula-row">${bits.join("")}</div>`;
}
