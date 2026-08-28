// ─── Can ACE settle "+2 versus undead"? ─────────────────────────────────────
//
// ⚠️ WRITTEN BECAUSE ACE SHIPPED SAYING IT COULD NOT. The effects layer reported
// conditional modifiers as "somebody has to judge this" while `creatureType` sat
// on both profiles the whole time. Every case here is a phrase that appears on
// real items.
//
// Run:  node tools/condition-selftest.mjs
const { evaluateCondition, resolveConditionals, knownConditionRules } = await import(
  "file:///D:/FoundryVTT/Data/modules/ace-qol/scripts/profiles/condition-evaluator.mjs");

let pass = 0, fail = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log((ok ? "  ok   " : "  FAIL ") + label.padEnd(58)
    + "got " + JSON.stringify(got) + ", want " + JSON.stringify(want));
};

// Profiles shaped like the real ones.
const creature = ({ type = "", size = "med", conditions = [], hp = { value: 30, max: 30 } } = {}) => ({
  creatureType: type, size, hp,
  hasCondition: (id) => conditions.includes(String(id).toLowerCase()),
});
const skeleton = creature({ type: "undead", size: "med" });
const ogre     = creature({ type: "giant", size: "lg" });
const wounded  = creature({ type: "humanoid", hp: { value: 8, max: 30 } });
const prone    = creature({ type: "humanoid", conditions: ["prone"] });

const V = (text, ctx) => evaluateCondition(text, ctx).verdict;

console.log("\nCREATURE TYPE — the one that started this");
check("+2 against undead, hitting a skeleton", V("+2 to attack rolls against undead.", { target: skeleton }), true);
check("+2 against undead, hitting an ogre", V("+2 to attack rolls against undead.", { target: ogre }), false);
check("versus fiends", V("Deals extra damage versus fiends.", { target: skeleton }), false);
check("'vs. dragons' phrasing is understood", V("+1 vs. dragons", { target: creature({ type: "dragon" }) }), true);
check("demons count as fiends", V("against demons", { target: creature({ type: "fiend" }) }), true);
check("an unrecorded creature type is unknown, not false",
  V("against undead", { target: creature({ type: "" }) }), "unknown");

console.log("\nSIZE");
check("against Large or larger, hitting an ogre", V("against Large or larger creatures", { target: ogre }), true);
check("against Large or larger, hitting a skeleton", V("against Large or larger creatures", { target: skeleton }), false);

console.log("\nCONDITIONS ON THE TARGET");
check("against prone creatures, target is prone", V("against prone creatures", { target: prone }), true);
check("against prone creatures, target is not", V("against prone creatures", { target: skeleton }), false);
check("while the target is frightened",
  V("while the target is frightened", { target: creature({ conditions: ["frightened"] }) }), true);

console.log("\nHIT POINTS");
check("against bloodied, target at 8 of 30", V("against bloodied creatures", { target: wounded }), true);
check("against bloodied, target at full", V("against bloodied creatures", { target: skeleton }), false);

console.log("\nWHAT KIND OF ATTACK");
check("melee only, on a melee swing", V("with melee weapons", { attack: { attackKind: "mwak" } }), true);
check("melee only, on a bow shot", V("with melee weapons", { attack: { attackKind: "rwak" } }), false);
check("ranged only, on a bow shot", V("ranged weapon attacks", { attack: { attackKind: "rwak" } }), true);
check("spell attacks, on a spell", V("spell attacks", { attack: { attackKind: "rsak" } }), true);
check("spell attacks, on a weapon", V("spell attacks", { attack: { attackKind: "mwak" } }), false);

console.log("\nDAMAGE TYPE");
check("vs fire damage, this deals fire",
  V("resistance to fire damage", { attack: { damageTypes: ["fire"] } }), true);
check("vs fire damage, this deals cold",
  V("resistance to fire damage", { attack: { damageTypes: ["cold"] } }), false);

console.log("\nWHERE THEY ARE STANDING");
check("in dim light, target is in dim",
  V("in dim light", { environment: { lightAtTarget: "dim" } }), true);
check("in dim light, target is in bright",
  V("in dim light", { environment: { lightAtTarget: "bright" } }), false);
check("underwater, target is in water",
  V("underwater", { environment: { terrainAtTarget: { kinds: ["water"] } } }), true);

console.log("\nWHAT IT HONESTLY CANNOT SETTLE");
check("once per turn stays unknown", V("once per turn", {}), "unknown");
check("GM discretion stays unknown", V("at the GM's discretion", {}), "unknown");
check("an unrecognised phrase stays unknown, never true",
  V("whenever the moon is gibbous", {}), "unknown");
check("no rule matched means no rule is claimed",
  evaluateCondition("whenever the moon is gibbous", {}).rule, null);

console.log("\nA WHOLE LIST AT ONCE");
const rows = [
  { effect: "Undead Slayer", value: "+2", conditional: "+2 to attack rolls against undead." },
  { effect: "Giant Bane",    value: "+2", conditional: "+2 against giants" },
  { effect: "Lucky Charm",   value: "+1", conditional: "once per turn" },
];
const r = resolveConditionals(rows, { target: skeleton });
check("one applies", r.applies.map(x => x.effect), ["Undead Slayer"]);
check("one does not", r.doesNotApply.map(x => x.effect), ["Giant Bane"]);
check("one is left for the GM", r.unknown.map(x => x.effect), ["Lucky Charm"]);

console.log("\nEVERY VERDICT SAYS WHY");
const e = evaluateCondition("+2 against undead", { target: ogre });
check("it names the rule that fired", e.rule, "target-creature-type");
check("and explains itself", /giant/.test(e.why), true);

console.log("\n" + knownConditionRules().length + " condition shapes understood");
console.log(pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
