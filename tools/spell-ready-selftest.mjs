// ─── Can this creature cast that spell right now? ────────────────────────────
//
// ⚠️ WHY THIS EXISTS. Johnny's table, 2026-09-16: "Magic Missile at Beric, who
// has Shield prepared, a slot, and a reaction. No Shield pop-up." The reaction
// engine's reader asked whether the casting method was the string "prepared".
// That is a dnd5e 3.x value. dnd5e 5.3.3 names its five methods in
// CONFIG.DND5E.spellcasting - atwill, innate, ritual, pact, spell - and keeps
// preparation as a number in CONFIG.DND5E.spellPreparationStates: 0 unprepared,
// 1 prepared, 2 always prepared.
//
// So a wizard's Shield reads `method: "spell", prepared: 1` and matched nothing.
// Shield, Counterspell, Absorb Elements and Silvery Barbs share that one reader,
// so not one of them has ever offered itself to a slot caster on 5.x.
//
// ⚠️ EVERY SHAPE BELOW IS TAKEN FROM HIS OWN WORLD, not invented: Kasimir the
// Wizard 9 (spell/1), Morthos the Sorcerer 17 and Beiro the Bard 17 (spell/2,
// each ALSO carrying a second unprepared copy), Riswynn the Rogue 17 (spell/0),
// Uraeus and the Couatl (innate/1), Virric's "Shield (Legacy)" (spell/2).
import { spellReady, preparationOf, hasReadySpell } from "../scripts/rules/spell-ready.mjs";

let pass = 0, fail = 0;
const check = (label, got, want) => {
  const ok = got === want;
  ok ? pass++ : fail++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${String(label).padEnd(70)} got ${got}, want ${want}`);
};

/** dnd5e 5.x on the sheet: a method name and a number. */
const spell = (name, method, prepared, level = 1) =>
  ({ type: "spell", name, system: { level, method, prepared } });
/** dnd5e 3.x, the shape his older imports used to carry. */
const old = (name, mode, prepared, level = 1) =>
  ({ type: "spell", name, system: { level, preparation: { mode, prepared } } });
const who = (name, ...items) => ({ name, items });

console.log("\nTHE SHAPES HIS WORLD ACTUALLY HAS (dnd5e 5.3.3)");
{
  check("Kasimir's Shield: a wizard's prepared spell is ready",
    spellReady(spell("Shield", "spell", 1)).ready, true);
  check("Morthos's Shield: a sorcerer's always-prepared spell is ready",
    spellReady(spell("Shield", "spell", 2)).ready, true);
  check("Riswynn's Shield: on the sheet, never prepared, is not",
    spellReady(spell("Shield", "spell", 0)).ready, false);
  check("Uraeus's Shield: innate needs no preparing",
    spellReady(spell("Shield", "innate", 1)).ready, true);
  check("an at-will spell needs no preparing",
    spellReady(spell("Shield", "atwill", 0)).ready, true);
  check("a warlock's pact spell, prepared, is ready",
    spellReady(spell("Shield", "pact", 1)).ready, true);
  check("a pact spell nobody prepared is not",
    spellReady(spell("Shield", "pact", 0)).ready, false);
  check("a ritual-book-only spell is not something you take as an action",
    spellReady(spell("Detect Magic", "ritual", 0)).ready, false);
  check("a cantrip is ready whatever the sheet says",
    spellReady(spell("Fire Bolt", "spell", 0, 0)).ready, true);
}

console.log("\nTHE OLD SHAPE STILL READS, BECAUSE HIS IMPORTS CARRIED IT");
{
  check("3.x prepared + true",  spellReady(old("Shield", "prepared", true)).ready, true);
  check("3.x prepared + false", spellReady(old("Shield", "prepared", false)).ready, false);
  check("3.x always",           spellReady(old("Shield", "always", false)).ready, true);
  check("3.x pact",             spellReady(old("Shield", "pact", false)).ready, true);
  check("the reader says which shape it read",
    preparationOf(spell("Shield", "spell", 1)).shape === "5.x"
      && preparationOf(old("Shield", "prepared", true)).shape === "legacy", true);
}

console.log("\nA SHEET THAT SAYS NOTHING IS NOT A REFUSAL");
{
  check("no preparation data at all: taken as ready",
    spellReady({ type: "spell", name: "Shield", system: { level: 1 } }).ready, true);
  check("and it says so in words",
    /taken as ready/.test(spellReady({ type: "spell", name: "Shield", system: { level: 1 } }).why), true);
  check("something that is not a spell is not a spell",
    spellReady({ type: "weapon", name: "Longsword" }).ready, false);
  check("nothing at all",  spellReady(null).ready, false);
}

console.log("\nEVERY COPY, NOT THE FIRST ONE FOUND");
{
  // Morthos and Beiro each carry two Shields: one unprepared, one always
  // prepared. Item order is not a rule.
  const morthos = who("Morthos", spell("Shield", "spell", 0), spell("Shield", "spell", 2));
  const backwards = who("Morthos", spell("Shield", "spell", 2), spell("Shield", "spell", 0));
  check("the unprepared copy first: still ready", hasReadySpell(morthos, "Shield").ok, true);
  check("the ready copy first: still ready",      hasReadySpell(backwards, "Shield").ok, true);
}

console.log("\nTHE NAME IS THE NAME");
{
  const virric = who("Virric", spell("Shield (Legacy)", "spell", 2));
  check("Virric's \"Shield (Legacy)\" is Shield", hasReadySpell(virric, "Shield").ok, true);
  const wrong = who("a wizard", spell("Fire Shield", "spell", 1), spell("Shield of Faith", "spell", 1));
  check("Fire Shield and Shield of Faith are not Shield", hasReadySpell(wrong, "Shield").ok, false);
}

console.log("\nTWO DIFFERENT NOES NEVER PRINT THE SAME SENTENCE");
{
  const has = hasReadySpell(who("Riswynn", spell("Shield", "spell", 0)), "Shield");
  const hasnt = hasReadySpell(who("a fighter", spell("Cure Wounds", "spell", 1)), "Shield");
  check("she has it, unprepared", /has Shield, but/.test(has.why), true);
  check("he does not have it",    /does not have Shield/.test(hasnt.why), true);
  check("and the two sentences differ", has.why !== hasnt.why, true);
}

console.log("\nTHE SYSTEM'S OWN TABLE ANSWERS FOR A METHOD WE HAVE NEVER SEEN");
{
  globalThis.CONFIG = { DND5E: { spellcasting: {
    atwill: {}, innate: {}, ritual: {}, pact: { prepares: true }, spell: { prepares: true },
    psionic: {},                       // a module's method that does not prepare
    tome: { prepares: true },          // a module's method that does
  } } };
  check("a module's non-preparing method is ready unprepared",
    spellReady(spell("Mind Thrust", "psionic", 0)).ready, true);
  check("a module's preparing method is not",
    spellReady(spell("Mind Thrust", "tome", 0)).ready, false);
  check("and it is, once prepared",
    spellReady(spell("Mind Thrust", "tome", 1)).ready, true);
  delete globalThis.CONFIG;
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
