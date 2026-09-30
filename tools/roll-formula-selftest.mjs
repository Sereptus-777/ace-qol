// ─── THE FORMULA THAT MADE THE NUMBER, AND THE ART THAT STAYS DOWN ───────────
//
// Two of his rules from 2026-09-29.
//
// 1. "Print the formula that made the number, not just the total." For Escher's
//    Dexterity save that is "Dex 1 (-5) + proficiency +3 = -2", then the die and
//    the total against the DC. Nothing invented: a part that is not on the sheet
//    is not on the card, and proficiency is never hidden inside the ability.
//
// 2. "If the token already has that condition, do not change Token Art." Escher
//    was already Prone, a second Topple landed, the condition stayed on and the
//    STANDING art came back. A condition that lands twice REPLACES its own
//    record: the delete restores the picture while the create sees the swap flag
//    already set and correctly does nothing, so the restore wins.
import { existsSync, mkdtempSync, cpSync, readFileSync } from "node:fs";
import { join, basename } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

const MODULE = "file:///D:/FoundryVTT/Data/modules/ace-qol";
const WORLD = "D:/FoundryVTT/Data/worlds/hijinx/data";
const LEVELDB = "D:/FoundryVTT/Foundry Virtual Tabletop/resources/app/node_modules/classic-level/index.js";

let pass = 0, fail = 0;
const check = (label, ok, detail = "") => {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${String(label).padEnd(60)} ${detail}`);
};

globalThis.foundry = { utils: { escapeHTML: (v) => String(v ?? "")
  .replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])) } };
globalThis.game = { user: { isGM: true }, users: [], actors: new Map(), scenes: new Map() };

/* ══ Escher, from his world ═══════════════════════════════════════════════ */
let ESCHER = null;
if (existsSync(join(WORLD, "actors", "CURRENT")) && existsSync(LEVELDB)) {
  const { ClassicLevel } = await import(pathToFileURL(LEVELDB).href);
  const dst = join(mkdtempSync(join(tmpdir(), "ace-rf-")), "actors");
  cpSync(join(WORLD, "actors"), dst, { recursive: true, filter: (s) => basename(s) !== "LOCK" });
  const db = new ClassicLevel(dst, { valueEncoding: "json" });
  await db.open();
  for await (const [k, v] of db.iterator()) {
    if (k.includes(".items")) continue;
    if (/^escher$/i.test(v?.name ?? "")) { ESCHER = v; break; }
  }
  await db.close();
}

// dnd5e derives `mod` and `prof` at load; the stored row keeps the scores and
// the CR. Escher is Dex 1, proficient in Dexterity saves, CR 5 -> proficiency +3.
const dexScore = Number(ESCHER?.system?.abilities?.dex?.value ?? 1);
const dexProf  = Number(ESCHER?.system?.abilities?.dex?.proficient ?? 1);
const dexMod   = Math.floor((dexScore - 10) / 2);
const escher = { name: "Escher", system: {
  abilities: {
    dex: { value: dexScore, mod: dexMod, proficient: dexProf,
           bonuses: ESCHER?.system?.abilities?.dex?.bonuses ?? { save: "0", check: "" } },
    str: { value: 16, mod: 3, proficient: 0, bonuses: {} },
  },
  attributes: { prof: 3 },
  bonuses: { abilities: {} },
  skills: { ath: { ability: "str", value: 1 }, acr: { ability: "dex", value: 2 } },
} };

console.log(`\nTHE FORMULA THAT MADE THE NUMBER`);
console.log(`  ${ESCHER ? `Escher's own sheet: Dex ${dexScore}, proficient ${dexProf}, CR 5 so +3`
  : "his world is not on this machine; the same numbers stood in"}\n`);

const { explainSave, explainCheck, formulaText, formulaPill, rollLineHtml } =
  await import(`${MODULE}/scripts/roll-formula.mjs`);

/* ══ 1. HIS PIN, EXACTLY ═════════════════════════════════════════════════ */
{
  const { parts, total } = explainSave(escher, "dex");
  // ⚠️ THE WORD IS "prof" (his card, 2026-09-29: "Never write the word
  // 'proficiency'"). It is still its own part, named separately from the ability;
  // only what the card calls it changed.
  check("the save's parts are the ability and its proficiency, separately",
    parts.length === 2 && parts[0].why === "ability" && parts[1].label === "prof",
    parts.map(p => `${p.label} ${p.value}`).join(", "));
  check("his line, exactly", formulaText(parts, total),
    formulaText(parts, total) === "Dex 1 (\u22125) + proficiency +3 = \u22122"
      ? formulaText(parts, total) : `got "${formulaText(parts, total)}"`);
  check("and the total is -2, which is what the sheet already said", total === -2, `${total}`);
  check("proficiency is never folded into the ability",
    !/DEX \u22122/.test(formulaText(parts, total)), "it is its own part");
}

/* ══ 2. NOTHING IS INVENTED ══════════════════════════════════════════════ */
{
  const plain = { name: "Rat", system: { abilities: { dex: { value: 11, mod: 0, proficient: 0,
    bonuses: { save: "0" } } }, attributes: { prof: 2 }, bonuses: { abilities: {} } } };
  const { parts } = explainSave(plain, "dex");
  check("a creature with no proficiency gets no proficiency chip",
    parts.length === 1, parts.map(p => p.label).join(", "));
  check("and a bonus field of \"0\" is not a part either",
    !parts.some(p => /bonus/.test(p.label)), "zero is not a bonus");

  const bonused = { name: "Paladin", system: { abilities: { dex: { value: 14, mod: 2, proficient: 1,
    bonuses: { save: "+3" } } }, attributes: { prof: 3 },
    bonuses: { abilities: { save: "1" } } } };
  const b = explainSave(bonused, "dex");
  // ⚠️ THE LABEL IS THE SHORT KIND, OR NOTHING (his rule, 2026-09-30: "If you
  // cannot map it, print +1 only and put the real name in the console"). This
  // stand-in carries the bonus on its sheet with no active effect granting it, so
  // there is nothing to name: the part is real and its label is null.
  check("a real save bonus on the ability IS a part",
    b.parts.some(p => p.label === null && p.value === 3), formulaText(b.parts, b.total));
  check("and one on the creature is its own part beside it",
    b.parts.filter(p => p.label === null).length === 2, `${b.total} altogether`);
  check("an unnamed part prints its number alone, never a made-up word",
    / \+3 \+1 = /.test(formulaText(b.parts, b.total)), formulaText(b.parts, b.total));

  // A formula bonus cannot be added up, so it is left off and said in the log.
  const weird = { name: "Odd", system: { abilities: { dex: { value: 10, mod: 0, proficient: 0,
    bonuses: { save: "1d4" } } }, attributes: { prof: 2 }, bonuses: { abilities: {} } } };
  check("a bonus written as dice is left off rather than guessed at",
    !explainSave(weird, "dex").parts.some(p => /bonus/.test(p.label)), "said in the log instead");
}

/* ══ 3. CHECKS AND SKILLS ════════════════════════════════════════════════ */
{
  const ath = explainCheck(escher, { skill: "ath" });
  // Number then label: "+3 prof", not "+ prof +3" (his rule, 2026-09-30).
  check("a skill check reads its own ability and proficiency",
    formulaText(ath.parts, ath.total) === "Str 16 (+3) +3 prof = +6",
    formulaText(ath.parts, ath.total));
  const acr = explainCheck(escher, { skill: "acr" });
  check("expertise is named as expertise, not as proficiency twice",
    acr.parts.some(p => p.label === "expertise" && p.value === 6),
    formulaText(acr.parts, acr.total));
}

/* ══ 4. IT STAYS INSIDE ITS PILL ═════════════════════════════════════════ */
{
  const { parts, total } = explainSave(escher, "dex");
  const html = rollLineHtml({ parts, bonus: total, d20: 7, total: 5, dc: 14, passed: false,
    label: "save" });
  check("the row and the pill are both flex-wrap in the stylesheet",
    (() => {
      const css = readFileSync("D:/FoundryVTT/Data/modules/ace-qol/styles/ace-qol.css", "utf8");
      const at = css.indexOf(".ace-qol-formula-row");
      const block = css.slice(at, at + 1400);
      return /flex-wrap: wrap/.test(block) && /overflow-wrap: anywhere/.test(block)
        && /min-height/.test(block) && !/white-space: *nowrap/.test(block);
    })(), "wraps, min-height, no nowrap");
  check("the die, the total, the DC and the verdict are all on the line",
    /d20 7/.test(html) && /5/.test(html) && /vs DC 14/.test(html) && /FAIL/.test(html),
    "the roll reads end to end");
  check("and the formula is in it too, not just the total",
    /prof/.test(html) && /Dex 1/.test(html), "the parts are on the card");
  check("nothing is drawn outside a pill",
    (html.match(/ace-qol-formula-pill/g) ?? []).length === 2
    && /^<div class="ace-qol-formula-row">/.test(html), "two pills, one row");
}

/* ══ 5. ALREADY DOWN IS NOT GETTING UP ═══════════════════════════════════ */
console.log("\nA CONDITION ALREADY ON DOES NOT SWAP THE ART BACK");
{
  const src = readFileSync("D:/FoundryVTT/Data/modules/ace-qol/scripts/prone-art.mjs", "utf8");
  const at = src.indexOf("static async standUp");
  const body = src.slice(at, src.indexOf("static ", at + 10));
  check("standUp asks whether the creature is STILL prone before restoring",
    /statuses\?\.has\?\.\("prone"\)/.test(body), "read from the actor, after every effect has landed");
  check("and it returns without touching the texture when it is",
    /is still prone, so its art stays down/.test(body) && /return;/.test(body),
    "the picture stays down");
  check("the guard sits before the update, not after it",
    body.indexOf('statuses?.has?.("prone")') < body.indexOf('"texture.src": previous'),
    "nothing is written first");
  // And the other direction is already guarded: goProne refuses when the swap
  // flag is set, which is why the SECOND Topple never re-swapped anything.
  check("going down twice was already a no-op, which is why only the restore showed",
    /already down/.test(src), "goProne returns on the swap flag");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.stdout.write("", () => process.exit(fail ? 1 : 0));
