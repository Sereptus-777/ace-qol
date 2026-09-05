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

console.log("\nHEALING THAT COVERS GROUND, WORKED OUT WITHOUT THE NAME");
// ⚠️🔴 THE ANSWER TO "WHY COULDN'T IT FIGURE IT OUT FROM THE DESCRIPTION?"
// The pipeline dispatches sixteen shapes; the classifier was permitted
// fourteen. `emanation-heal` and `template-heal` were not words it could say,
// so Aura of Vitality could only ever come back "self" no matter how perfectly
// its text was read, and Mass Cure Wounds threw its 30-foot sphere away.
//
// These cases use a NONSENSE NAME on purpose. If they pass, the engine worked
// it out from the item, which is the entire point.
{
  const heal = (over = {}) => ({
    name: "Nameless Homebrew",
    type: "spell",
    system: {
      level: 3,
      properties: ["concentration"],
      range: over.range ?? { units: "self" },
      target: over.target ?? { template: { type: "sphere", size: 30 } },
      description: { value: "" },
      activities: { a: {
        type: "heal", activation: { type: "action" },
        range: over.range ?? { units: "self" },
        target: over.target ?? { template: { type: "sphere", size: 30 } },
        healing: { number: 2, denomination: 6, types: ["healing"] },
      } },
    },
  });

  check("healing that radiates from the caster is an emanation heal",
    classifyItem(heal()).shape, "emanation-heal");
  check("and it says why, in plain words",
    /radiates healing 30 feet from the caster/.test(
      classifyItem(heal()).evidence.join(" ")), true);
  check("healing inside an area it places is a template heal",
    classifyItem(heal({ range: { units: "ft", value: 60 } })).shape, "template-heal");
  // ⚠️ SECOND WIND IS SELF-RANGED HEALING AND IS NOT AN EMANATION. It has no
  // radius. Widening this to "heals and is self" would swallow it and hang a
  // zero-foot aura on a fighter catching their breath.
  check("self healing with no radius stays self",
    classifyItem(heal({ target: { affects: { type: "self" } } })).shape, "self");
  // ⚠️ AND WITH NO TARGET BLOCK AT ALL IT IS "touch", WHICH IS RIGHT. An item
  // that states no target and no radius has not said it is an emanation, and
  // reading one into it would hang a zero-foot aura on a fighter catching their
  // breath. My first version of this case asserted "self" and the engine was
  // the one that had it right.
  check("healing with no target stated at all is a touch, not an aura",
    classifyItem(heal({ target: {} })).shape, "touch");
  // ⚠️ AND AN EMANATION THAT DOES NOT HEAL IS UNTOUCHED. Detect Magic is
  // range self with a 30-foot radius and asks nothing of anyone inside it.
  check("a non-healing emanation is still the caster's own spell",
    classifyItem({ name: "y", type: "spell", system: { level: 1, properties: [],
      range: { units: "self" }, target: { template: { type: "sphere", size: 30 } },
      description: { value: "" },
      activities: { a: { type: "utility", activation: { type: "action" },
        range: { units: "self" },
        target: { template: { type: "sphere", size: 30 } } } } } }).shape, "self");
}

console.log("\nTHE BOOK IS READ BEFORE THE DECISION, NOT AFTER IT");
// ⚠️🔴 HIS EXACT COMPLAINT, 2026-09-05: "It did not compare it to the
// actual spell itself that we have in memory, or somewhere on the disk." The
// book was being opened AFTER the shape was decided, only to complain about
// differences. These cases prove it now decides with it.
{
  const thin = { name: "Aura of Vitality", type: "spell", system: {
    level: 3, properties: [], range: { units: "self" }, target: {},
    description: { value: "" },
    activities: { a: { type: "heal", activation: { type: "action" },
      range: { units: "self" }, target: {} } } } };

  // The book's copy: complete, the way the compendium ships it.
  const book = { name: "Aura of Vitality", type: "spell", system: {
    level: 3, properties: ["concentration"],
    range: { units: "self" }, target: { template: { type: "sphere", size: 30 } },
    description: { value: "" },
    activities: { a: { type: "heal", activation: { type: "bonus" },
      range: { units: "self" }, target: { template: { type: "sphere", size: 30 } },
      healing: { number: 2, denomination: 6, types: ["healing"] } } } } };

  check("on its own, a stripped item cannot be an aura",
    classifyItem(thin).shape, "touch");
  check("with the book, it is an emanation heal",
    classifyItem(thin, { book }).shape, "emanation-heal");
  check("and the radius came from the book",
    classifyItem(thin, { book }).entry?.emanation?.radiusFt, 30);
  check("and so did the dice",
    classifyItem(thin, { book }).entry?.heal?.formula(), "2d6");
  // ⚠️ EVERY FILL IS NAMED. A shape that only came out right because the
  // book supplied the radius must not read like it came off his own item.
  check("it says the book filled the gap",
    /his copy did not say/.test(classifyItem(thin, { book }).evidence.join(" ")), true);

  // ⚠️🔴 HIS ITEM WINS WHERE IT SPEAKS. Overwriting a stated value with a
  // canonical one is the Spare the Dying mistake: I believed the book over his
  // sheet and had him change items that were already right.
  const bigger = JSON.parse(JSON.stringify(thin));
  bigger.system.target = { template: { type: "sphere", size: 60 } };
  bigger.system.activities.a.target = { template: { type: "sphere", size: 60 } };
  check("a radius HE states is not overwritten by the book",
    classifyItem(bigger, { book }).entry?.emanation?.radiusFt, 60);
}

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
