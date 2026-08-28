// ─── Does the effects layer read what an effect actually does? ──────────────
// ⚠️ Every case is the shape of a real dnd5e effect, because the whole point is
// that no profile read `.changes` at all until 2026-08-28.
const { readEffects, modifiersFor } = await import(
  "file:///D:/FoundryVTT/Data/modules/ace-qol/scripts/profiles/effects-reader.mjs");

let pass = 0, fail = 0;
const check = (l, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log((ok ? "  ok   " : "  FAIL ") + l.padEnd(56) + "got " + JSON.stringify(got) + ", want " + JSON.stringify(want));
};

const actor = (effects) => ({ name: "Test", effects });

const bless = { name: "Bless", disabled: false, description: "",
  changes: [{ key: "system.bonuses.abilities.save", mode: 2, value: "+1d4" },
            { key: "system.bonuses.mwak.attack", mode: 2, value: "+1d4" }] };
const shield = { name: "Shield of Faith", disabled: false, description: "",
  changes: [{ key: "system.attributes.ac.bonus", mode: 2, value: "+2" }] };
const slayer = { name: "Undead Slayer", disabled: false,
  description: "<p>+2 to attack rolls against undead.</p>",
  changes: [{ key: "system.bonuses.mwak.attack", mode: 2, value: "+2" }] };
const offEffect = { name: "Unattuned Ring", disabled: true, description: "",
  changes: [{ key: "system.attributes.ac.bonus", mode: 2, value: "+1" }] };
const marker = { name: "Prone", disabled: false, description: "", changes: [] };

console.log("\nIT READS WHAT AN EFFECT DOES, NOT JUST ITS NAME");
const r = readEffects(actor([bless, shield]));
check("Bless and Shield of Faith give three modifiers", r.modifiers.length, 3);
check("the AC one is grouped as ac", r.byGroup.ac?.length, 1);
check("the save one is grouped as save", r.byGroup.save?.length, 1);
check("Bless's value survives", r.byGroup.save[0].value, "+1d4");

console.log("\nA CONDITIONAL IS CARRIED, NEVER ASSUMED");
const c = readEffects(actor([slayer]));
check("an 'against undead' effect is flagged conditional", c.conditionalCount, 1);
const split = modifiersFor(c, "attack");
check("it is NOT in the always-applies list", split.always.length, 0);
check("it IS handed back for judging", split.conditional.length, 1);

console.log("\nSWITCHED OFF IS NOT APPLYING");
const o = readEffects(actor([offEffect]));
check("a disabled effect modifies nothing", o.modifiers.length, 0);
check("but it is still reported separately", o.suppressed.length, 1);

console.log("\nA CONDITION MARKER IS NOT A MODIFIER");
check("Prone carries no changes, so no modifiers", readEffects(actor([marker])).modifiers.length, 0);

console.log("\nUNREADABLE IS NOT EMPTY");
const bad = readEffects({ name: "Broken", get effects() { throw new Error("boom"); } });
check("a throw reports readable:false", bad.readable, false);
check("and does not claim nothing modifies it", bad.problems.length > 0, true);

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
