// ─── THE SAVE LINE IS THE ROLL ───────────────────────────────────────────────
//
// His Lightning Bolt card, 2026-10-01:
//
//   "The formula is not the roll. Jeth's 23 is right: Dex 20 is +5, proficiency
//    +4 is +9, die plus 9 is 23, and the card printed D20 + 0. Escher printed
//    Dex 1 (-5) +3 prof = D20 + 0 while the die shows 1 = 1. Gorgon and the
//    Cloud Giant printed Dex +0 and added +2. Print the die, then every bonus
//    and where it came from... Evasion is not a save bonus."
//
// Two causes, and his five rows name both:
//
//   · COVER. dnd5e adds it to every Dexterity save (`abl.saveBonus = saveBonusAbl
//     + saveBonus + cover`) and the card never looked for it. Escher −5 +3 +2 = 0,
//     the Gorgon +0 +2 = +2, the Cloud Giant the same. Every one of his
//     disagreements reconciles the moment cover is on the line.
//   · `Number(null)` IS 0. The rows pass `total: null` for "the roll has not
//     said", and `Number.isFinite(Number(null))` is true, so a row whose die
//     never travelled printed "= D20 + 0" over a 23.
//
// Run:  node tools/save-line-selftest.mjs
import { readFileSync } from "node:fs";

globalThis.game = {
  settings: { get: () => false, register: () => {} },
  i18n: { localize: (s) => s },
  actors: { get: () => null }, scenes: { get: () => null },
};
globalThis.Hooks = { on: () => {}, once: () => {}, callAll: () => {} };
globalThis.ui = {};
globalThis.CONFIG = { DND5E: { abilities: {} } };

const { explainSave, formulaText, rolledLineText } = await import(
  "file:///D:/FoundryVTT/Data/modules/ace-qol/scripts/roll-formula.mjs");
const engine = readFileSync("D:/FoundryVTT/Data/modules/ace-qol/scripts/save-engine.mjs", "utf8");

let pass = 0, fail = 0;
const check = (label, ok, detail = "") => {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${String(label).padEnd(62)} ${detail}`);
};

/**
 * A sheet, as dnd5e prepares one. `save.value` is the system's own answer and
 * is what the roll uses: mod + every bonus + proficiency.
 */
const sheet = ({ name, ab = "dex", score, mod, prof = 0, profMult = 0,
                 cover = 0, coverStatus = null, own = "", global = "" }) => {
  const saveValue = mod + Math.floor(prof * profMult) + cover
    + (Number(own) || 0) + (Number(global) || 0);
  return {
    name, effects: [], coverBonus: coverStatus ? cover : 0,
    statuses: new Set(coverStatus ? [coverStatus] : []),
    system: {
      abilities: { [ab]: { value: score, mod, proficient: profMult,
        save: { value: saveValue }, bonuses: { save: own } } },
      attributes: { prof, ac: { cover: coverStatus ? 0 : cover } },
      bonuses: { abilities: { save: global } },
    },
  };
};

console.log("\nHIS FIVE ROWS, AND THE LINE EACH ONE GETS");
{
  // Escher: Dex 1 (−5), proficient +3, behind half cover.
  const escher = sheet({ name: "Escher", score: 1, mod: -5, prof: 3, profMult: 1,
    cover: 2, coverStatus: "coverHalf" });
  const { parts, total } = explainSave(escher, "dex");
  check("Escher's parts add up to the +0 his roll used", total === 0, `total ${total}`);
  check("cover is named by which cover it is",
    parts.find(p => p.label === "cover")?.why === "half cover");
  check("and his line is the names, the numbers and the total",
    rolledLineText(parts, { total: 1 }) === "Dex −5 | Prof +3 | Cover +2 = 1",
    rolledLineText(parts, { total: 1 }));

  /* ⚠️ HIS THREE LINES, WORD FOR WORD (2026-10-01). */
  const jeth = sheet({ name: "Jeth", score: 20, mod: 5, prof: 4, profMult: 1 });
  check("Jeth is Dex +5 | Prof +4 = 14",
    rolledLineText(explainSave(jeth, "dex").parts, { total: 14 }) === "Dex +5 | Prof +4 = 14",
    rolledLineText(explainSave(jeth, "dex").parts, { total: 14 }));

  const gorgon = sheet({ name: "Gorgon", score: 11, mod: 0, cover: 2, coverStatus: "coverHalf" });
  check("the Gorgon is Dex +0 | Cover +2 = 6",
    rolledLineText(explainSave(gorgon, "dex").parts, { total: 6 }) === "Dex +0 | Cover +2 = 6",
    rolledLineText(explainSave(gorgon, "dex").parts, { total: 6 }));

  const cloud = sheet({ name: "Cloud Giant", score: 10, mod: 0, cover: 2, coverStatus: "coverHalf" });
  check("the Cloud Giant is Dex +0 | Cover +2 = 20",
    rolledLineText(explainSave(cloud, "dex").parts, { total: 20 }) === "Dex +0 | Cover +2 = 20",
    rolledLineText(explainSave(cloud, "dex").parts, { total: 20 }));

  /* ⚠️ "Virric has nothing to add, so he gets no line." */
  const virric = sheet({ name: "Virric", score: 10, mod: 0 });
  check("Virric has nothing to add, so he gets no line",
    rolledLineText(explainSave(virric, "dex").parts, { total: 11 }) === "",
    `"${rolledLineText(explainSave(virric, "dex").parts, { total: 11 })}"`);
}

console.log("\nHIS EXAMPLE: A CLOAK AND A FEAT ON ONE LINE");
{
  // "Dex is +5, proficiency is +9, has a cloak of protection +3, and a feat
  // that gives it -2." (2026-10-02)
  //
  // ⚠️ THE FEAT CAME OUT AS "Bonus" THE FIRST TIME I RAN THIS. The word was
  // missing from the vocabulary because the edit that added it went through a
  // heredoc that ate the backslashes, so the search string held a real
  // backspace and the replace quietly matched nothing. This pin is why that
  // cannot happen again unnoticed.
  const jeth = {
    name: "Jeth", statuses: new Set(), coverBonus: 0,
    effects: [
      { name: "Cloak of Protection", changes: [{ key: "system.abilities.dex.bonuses.save" }] },
      { name: "Feat: Unlucky", changes: [{ key: "system.bonuses.abilities.save" }] },
    ],
    system: {
      abilities: { dex: { value: 20, mod: 5, proficient: 1, save: { value: 15 }, bonuses: { save: "3" } } },
      attributes: { prof: 9, ac: {} },
      bonuses: { abilities: { save: "-2" } },
    },
  };
  const { parts, total } = explainSave(jeth, "dex");
  check("the four parts come to +15", total === 15, `total ${total}`);
  check("and the line names each one in a word, in order",
    rolledLineText(parts, { total: 27 }) === "Dex +5 | Prof +9 | Cloak +3 | Feat −2 = 27",
    rolledLineText(parts, { total: 27 }));
  check("a penalty keeps its own sign and no stray plus in front of it",
    /\| Feat −2 /.test(rolledLineText(parts, { total: 27 })));
}

console.log("\nONE WORD, AND ONLY WHEN HE HAS IT");
{
  const withCloak = sheet({ name: "Ireena", score: 14, mod: 2, prof: 3, profMult: 1, own: "1" });
  const line = rolledLineText(explainSave(withCloak, "dex").parts, { total: 15 });
  const jethLine = rolledLineText(explainSave(
    sheet({ name: "Jeth", score: 20, mod: 5, prof: 4, profMult: 1 }), "dex").parts, { total: 14 });
  check("a bonus he has is on the line, as one word", /\| \w+ \+1/.test(line), line);
  /* ⚠️🔴 AND NOTHING ABOUT WHAT HE DOES NOT HAVE (his correction: "No ability
     score, no repeated die, no sentence about a ring he does not have"). */
  check("no sentence about a ring he does not have", !/ring|cloak or feat/i.test(jethLine), jethLine);
  check("no ability score on the line", !/Dex \d\d|Dex 1\b/.test(line + " " + jethLine));
  check("and no die repeated on it", !/d20/.test(line + " " + jethLine), line);
}

console.log("\nTHE PIPE IS THE ONLY GOLD");
{
  const css = readFileSync("D:/FoundryVTT/Data/modules/ace-qol/styles/ace-qol.css", "utf8");
  const at = css.indexOf(".ace-qol-formula-pipe");
  check("the pipe is its own element, so it can be the one gold thing",
    at > 0 && /#8b6914/.test(css.slice(at, at + 200)));
  check("the rolled pill drops the gold wash and the gold frame",
    /\.ace-qol-formula-pill\.ace-qol-formula-rolled \{[^}]*rgba\(255, 255, 255, 0\.04\)/s.test(css));
  check("a row with nothing to add draws no pill at all",
    rolledLineText(explainSave(sheet({ name: "Virric", score: 10, mod: 0 }), "dex").parts,
      { total: 11 }) === "");
  /* ⚠️ A ZERO BESIDE SOMETHING REAL STAYS: his own Gorgon keeps it. */
  check("and a zero beside something real stays, his Gorgon",
    rolledLineText(explainSave(sheet({ name: "Gorgon", score: 11, mod: 0, cover: 2,
      coverStatus: "coverHalf" }), "dex").parts, { total: 6 }).startsWith("Dex +0 |"));
}

console.log("\nCOVER IS A DEXTERITY SAVE AND NOTHING ELSE");
{
  const wis = sheet({ name: "Ismark", ab: "wis", score: 14, mod: 2, cover: 2, coverStatus: "coverHalf" });
  check("a Wisdom save takes no cover",
    !explainSave(wis, "wis").parts.some(p => p.label === "cover"),
    explainSave(wis, "wis").parts.map(p => p.label).join(", "));
  /* ⚠️ HIS RULE, SAME MESSAGE: "Evasion is not a save bonus. It changes the
     damage after the roll." It has never been one here, and this pin is what
     keeps it that way. */
  const anyEvasion = ["evasion", "superSaver"].some(w =>
    explainSave(sheet({ name: "Rogue", score: 18, mod: 4 }), "dex")
      .parts.some(p => String(p.label ?? "").toLowerCase().includes(w.toLowerCase())));
  check("evasion is never a part of a save", !anyEvasion);
}

console.log("\nWHAT THE SHEET CANNOT NAME IS STILL SAID");
{
  const odd = sheet({ name: "Rahadin", score: 16, mod: 3 });
  odd.system.abilities.dex.save.value = 8;   // dnd5e knows +8; the parts reach +3
  const { parts, total } = explainSave(odd, "dex");
  check("the difference is on the card, not dropped", total === 8, `total ${total}`);
  check("and it is labelled honestly",
    parts.some(p => p.label === "not on the sheet" && p.value === 5),
    parts.map(p => `${p.label} ${p.value}`).join(", "));
}

console.log("\nNULL IS NOT ZERO");
{
  const jeth = sheet({ name: "Jeth", score: 20, mod: 5, prof: 4, profMult: 1 });
  const { parts } = explainSave(jeth, "dex");
  /* ⚠️🔴 THE LINE THAT PRINTED "= D20 + 0" OVER A 23. */
  check("an unknown total falls back to the sheet, not to zero",
    formulaText(parts, null).endsWith("= D20 + 9"), formulaText(parts, null));
  check("and a real zero still prints as zero",
    formulaText(parts, 0).endsWith("= D20 + 0"), formulaText(parts, 0));
}

console.log("\nONE READER FOR THE DIE");
{
  /* ⚠️ THE ROW, THE REBUILT ROW AND THE LINE EACH TOOK THE DIE THEIR OWN WAY.
     That is why a player's row could show a bare total with no picture while the
     line under it printed a different sum. */
  check("the reader exists and works out a missing face",
    /static _rollReadingFor\(r, opts = \{\}\) \{/.test(engine)
    && /const face = total - sheet;/.test(engine));
  check("a face outside 1..20 is refused rather than drawn",
    /face < 1 \|\| face > 20/.test(engine));
  check("nothing reads the die its own way any more",
    !/const d20Face = r\.dieResult \?\? r\.roll\?\.dice/.test(engine)
    && !/const d20 = r\.dieResult \?\? r\.roll\?\.dice/.test(engine),
    "no second reader left");
  check("both row renderers ask it",
    (engine.match(/SaveEngine\._rollReadingFor\(r, opts\)/g) ?? []).length >= 3,
    `${(engine.match(/SaveEngine\._rollReadingFor\(r, opts\)/g) ?? []).length} call sites`);
  check("and the line it draws is the rolled one, which can come back empty",
    /return rolledPill\(parts, \{/.test(engine) && /label: "save",/.test(engine));
  /* ⚠️ A FACE THAT IS MERELY PLAUSIBLE IS A PICTURE OF A DIE NOBODY THREW.
     Bless adds 1d4, so the total stops being the face plus a number. */
  check("a Bless die in the bonus refuses the working-out",
    /const rolledBonus = \(r\?\.saveBonuses \?\? \[\]\)\.find/.test(engine)
    && /which is its own die/.test(engine));
}

console.log("");
console.log(pass + " passed, " + fail + " failed");
if (fail) process.exitCode = 1;
