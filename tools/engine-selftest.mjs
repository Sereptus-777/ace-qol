// ─── Does the inference engine still read the world correctly? ──────────────
//
// ⚠️ EVERY CASE HERE IS A BUG THAT ACTUALLY HAPPENED while building this, not a
// hypothetical. The rapier targeting nobody, Second Wind losing its range, the
// nine touch-delivered buffs routed to the wrong resolver, Magic Resistance
// reported as doing nothing, Scorching Ray firing one ray. Each one looked fine
// and each one was wrong.
//
// Run:  node tools/engine-selftest.mjs
const B = "D:/FoundryVTT/Data/modules/ace-qol/scripts";
const { readActionFacts } = await import(`file:///${B}/inference/action-facts.mjs`);
const { classifyItem }    = await import(`file:///${B}/inference/classify-item.mjs`);
const { readWeather }     = await import(`file:///${B}/rules/weather.mjs`);

let pass = 0, fail = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass++; else fail++;
  console.log((ok ? "  ok   " : "  FAIL ") + label.padEnd(58)
    + "got " + JSON.stringify(got) + ", want " + JSON.stringify(want));
};

// ── Items shaped exactly like the real ones in his world ────────────────────
const rapier = { name: "Rapier", type: "weapon", system: {
  range: { value: null, long: null, units: "ft", reach: 5 },
  properties: ["fin", "rch"],
  damage: { base: { number: 1, denomination: 8, types: ["piercing"] } },
  activities: { a: { type: "attack",
    activation: { type: "action" },
    attack: { ability: "dex", type: { value: "melee", classification: "weapon" } },
    damage: { includeBase: true, parts: [] },
    // The override trap: says "self" and means "ask the item".
    range: { override: false, units: "self" },
    target: { override: false, affects: {}, template: {} } } } } };

const magicResistance = { name: "Magic Resistance", type: "feat",
  system: { uses: { spent: null, recovery: [] }, properties: [], activities: {} } };

const secondWind = { name: "Second Wind", type: "feat", system: {
  uses: { max: "2", recovery: [{ period: "sr", type: "formula" }] },
  activities: { a: { type: "heal", activation: { type: "bonus" },
    range: { units: "self", override: false },
    target: { affects: { type: "self" }, override: false } } } } };

const scorchingRay = { name: "Scorching Ray", type: "spell", system: {
  level: 2, range: { value: "120", units: "ft" }, duration: { units: "inst" },
  description: { value: "<p>You create three rays of fire and hurl them at targets.</p>" },
  activities: { a: { type: "attack", activation: { type: "action" },
    attack: { type: { value: "ranged", classification: "spell" } },
    damage: { parts: [{ number: 2, denomination: 6, types: ["fire"] }] } } } } };

const fireball = { name: "Fireball", type: "spell", system: {
  level: 3, range: { value: "150", units: "ft" }, duration: { units: "inst" },
  target: { template: { type: "sphere", size: "20", units: "ft" } },
  activities: { a: { type: "save", activation: { type: "action" },
    save: { ability: "dex", dc: { calculation: "spellcasting" } },
    damage: { onSave: "half", parts: [{ number: 8, denomination: 6, types: ["fire"] }] } } } } };

const heroism = { name: "Heroism", type: "spell", system: {
  level: 1, range: { units: "touch" }, duration: { value: "1", units: "minute" },
  target: { affects: { type: "creature", count: "1" }, template: {} },
  activities: { a: { type: "utility", activation: { type: "action" },
    effects: [{ _id: "abc" }] } } } };

console.log("\nTHE OVERRIDE TRAP: an activity saying 'self' means 'ask the item'");
const rf = readActionFacts(rapier);
check("a rapier reaches 5 feet, not 'self'", rf.delivery.kind, "reach");
check("a rapier reaches 5 feet", rf.delivery.rangeFt, 5);
check("a rapier lands on one creature, not nobody", rf.scope.kind, "one");
check("a rapier's damage comes off the item", rf.change.damage[0]?.formula, "1d8");
check("a rapier is an attack", classifyItem(rapier).shape, "attack-single");

console.log("\nA FEAT HAS NO ITEM-LEVEL RANGE, SO THE ACTIVITY IS ALL THERE IS");
const sw = readActionFacts(secondWind);
check("Second Wind acts on self", sw.scope.kind, "self");
check("Second Wind costs a bonus action", sw.cost.action, "bonus");
check("Second Wind is a self spell, not a heal picker", classifyItem(secondWind).shape, "self");

console.log("\nNO ACTIVITY IS NOT NO ANSWER");
const mr = readActionFacts(magicResistance);
check("Magic Resistance is passive", mr.trigger.kind, "passive");
check("it is not reported as doing nothing", mr.change.descriptiveOnly, true);
check("it has no pipeline shape, and says so", classifyItem(magicResistance).shape, null);
check("and that is a confident answer, not a failure",
  classifyItem(magicResistance).confidence, "high");

console.log("\nCOUNTS THE SHEET DOES NOT CARRY COME FROM THE PROSE");
check("Scorching Ray fires three rays", readActionFacts(scorchingRay).resolution.attacks, 3);
check("so it is a multi-attack", classifyItem(scorchingRay).shape, "attack-multi");

console.log("\nAREAS");
const fb = readActionFacts(fireball);
check("Fireball is a 20 foot sphere", fb.delivery.template?.size, 20);
check("decided by a save", fb.resolution.saveAbility, "dex");
check("half on a save", fb.resolution.onSave, "half");
check("instant area resolves once", classifyItem(fireball).shape, "template-save");
check("a lasting area keeps catching people",
  classifyItem(fireball, { timing: { timing: "enter+startOfTurn" } }).shape, "template-trigger");

console.log("\nA BUFF DELIVERED BY TOUCH IS A BUFF, NOT A TOUCH SPELL");
check("Heroism is a buff", classifyItem(heroism).shape, "multi-buff");

console.log("\nWEATHER");
const clear = readWeather({ name: "Tser Pool Camp" });
check("silence is 'nobody said', never 'clear'", clear.known, false);
check("and it imposes nothing", clear.effects.rangedWeaponDisadvantage, false);

const storm = readWeather({ name: "Deck", weather: "rainStorm" });
check("a rainstorm is known", storm.known, true);
check("strong wind spoils ranged weapon attacks", storm.effects.rangedWeaponDisadvantage, true);
check("heavy rain heavily obscures", storm.effects.heavilyObscured, true);

const drizzle = readWeather({ name: "Road", weather: "rain" });
check("plain rain does NOT obscure", drizzle.effects.heavilyObscured, false);
check("plain rain does NOT spoil archery", drizzle.effects.rangedWeaponDisadvantage, false);

const ice = readWeather({ name: "Cliff" }, ["ice"]);
check("icy ground is known even with no weather set", ice.known, true);
check("and calls for a DC 10 check", ice.effects.slipperyGround?.dc, 10);
check("once per turn, not per square", ice.effects.slipperyGround?.oncePerTurn, true);

const named = readWeather({ name: "The Blizzard Pass" });
check("a scene name is a source when the field is empty", named.kind, "snow");
check("and a blizzard is cold", named.cold, true);

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
