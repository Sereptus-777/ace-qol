// ─── The formula reader, against the formulas in his world (2026-09-14) ─────
//
// Every formula here is one hijinx stores for an area size or a target count.
// dnd5e works each out at load (replaceFormulaData, then prepareFormulaValue),
// a missing reference counting as 0; this pins that the recipe reader and the
// replay get the same numbers.
//
// Run:  node tools/formula-value-selftest.mjs
// ──────────────────────────────────────────────────────────────────────────────

const MODULE = "file:///D:/FoundryVTT/Data/modules/ace-qol";
const { formulaValue, growthPerLevel, arithmetic } = await import(`${MODULE}/scripts/inference/formula-value.mjs`);

let pass = 0, fail = 0;
const check = (label, got, want) => {
  const ok = got === want;
  if (ok) pass++; else fail++;
  console.log(`${ok ? "  ok  " : "  FAIL"} ${label}: ${got}${ok ? "" : ` (wanted ${want})`}`);
};
const at = (formula, data) => formulaValue(formula, data).value;

check("Fog Cloud at 1st level is a 20-foot sphere", at("20 * @item.level", { item: { level: 1 } }), 20);
check("Confusion at 4th is 10 feet", at("@item.level * 5 - 10", { item: { level: 4 } }), 10);
check("Creation at 5th is a 5-foot cube", at("5 * @item.level - 20", { item: { level: 5 } }), 5);
check("Hold Person at 2nd has 1 target", at("@item.level - 1", { item: { level: 2 } }), 1);
check("Bless at 1st has 3 targets", at("2 + @item.level", { item: { level: 1 } }), 3);
check("a missing reference counts as 0, as dnd5e does", at("1 + @scaling.increase * 2", {}), 1);
check("brackets and max", at("(max(1,@abilities.cha.mod))", { abilities: { cha: { mod: -1 } } }), 1);
check("Krusk's aura from his class scale", at("@scale.paladin.aura", { scale: { paladin: { aura: 10 } } }), 10);
check("a plain number", at("20", {}), 20);
check("dice are not plain arithmetic", arithmetic("2d6 + 3"), null);
check("words are not plain arithmetic", arithmetic("see text"), null);
check("a blank has no value", at("", {}), null);
check("Hold Person gains 1 target a slot", growthPerLevel("@item.level - 1", 2), 1);
check("Fog Cloud gains 20 feet a slot", growthPerLevel("20 * @item.level", 1), 20);
check("one that gains 3 a slot", growthPerLevel("1 + 3 * (@item.level - 7)", 7), 3);
check("the @scaling form grows too", growthPerLevel("1 + @scaling.increase * 2", 3), 2);
check("a class scale does not grow with the slot", growthPerLevel("@scale.paladin.aura", 1), null);
check("an ability does not grow with the slot", growthPerLevel("@item.level + @abilities.cha.mod", 1), null);
check("a plain number does not grow", growthPerLevel("3", 1), null);

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
