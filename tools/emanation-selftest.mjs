// ─── A spell that radiates from you is not placed by you ─────────────────────
//
// ⚠️🔴 THE PROMPT CAME BACK BECAUSE OF A FIX MADE THE SAME NIGHT. The old test
// was `entry.shape !== "self"` and nothing else. Once the registry started
// matching his "(Legacy)" names again, Aura of Vitality's shape became
// "emanation-heal" — correct, and instantly invisible to a test that knew one
// word. He was asked to place a circle centred on his own body.
//
// ⚠️🔴 AND THE OPPOSITE MISTAKE IS WORSE. Burning Hands is ALSO range self with
// a template, and its 15 foot cone has to be aimed. Suppressing that prompt
// would fire every cone in the game down the x-axis and look like the spell had
// picked its own targets. The dividing line is direction: a circle centred on
// you is the same circle whichever way you face.
//
// Run:  node tools/emanation-selftest.mjs
globalThis.CONFIG = { DND5E: { areaTargetTypes: {
  radius:   { template: "circle" },
  sphere:   { template: "circle" },
  cylinder: { template: "circle" },
  cone:     { template: "cone" },
  line:     { template: "ray" },
  cube:     { template: "rect" },
} } };
globalThis.canvas = { tokens: { placeables: [] }, scene: null };
globalThis.ui = { notifications: { info: () => {}, warn: () => {}, error: () => {} } };
globalThis.Hooks = { on: () => {}, once: () => {}, off: () => {}, callAll: () => {}, call: () => true };
globalThis.game = { settings: { get: () => true, register: () => {} }, socket: { emit: () => {}, on: () => {} },
                    modules: { get: () => ({ active: false }) }, user: { isGM: true } };
globalThis.PIXI = { Graphics: class {}, BLEND_MODES: { ADD: 1 } };
class _App { static DEFAULT_OPTIONS = {}; constructor() {} render() {} close() {} }
globalThis.foundry = {
  utils: { escapeHTML: (x) => String(x), mergeObject: (a, b) => ({ ...a, ...b }),
           deepClone: (o) => o, randomID: () => "id", getRoute: (p) => p },
  applications: { api: { ApplicationV2: _App, DialogV2: { wait: async () => null },
                         HandlebarsApplicationMixin: (B) => class extends B {} },
                  ux: {}, apps: {}, handlebars: {} },
};

const { emanatesFromCaster, CASTER_CENTRED_SHAPES, burstFor } = await import(
  "file:///D:/FoundryVTT/Data/modules/ace-qol/scripts/caster-emanation.mjs");
const { DAMAGE_THEME, DEFAULT_COLOR, HEAL_COLOR } = await import(
  "file:///D:/FoundryVTT/Data/modules/ace-qol/scripts/ace-fx.mjs");

let pass = 0, fail = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log((ok ? "  ok   " : "  FAIL ") + String(label).padEnd(60)
    + "got " + JSON.stringify(got) + ", want " + JSON.stringify(want));
};

const act = ({ type = "radius", size = 30, units = "self" } = {}) => ({
  range: { units },
  target: { template: type ? { type, size } : {} },
  item: { name: "x", system: { range: { units }, target: { template: { type, size } } } },
});

console.log("\nA CIRCLE CENTRED ON YOU IS NEVER PLACED BY YOU");
check("an entry that states an emanation",
  emanatesFromCaster({ shape: "emanation-heal", emanation: { radiusFt: 30 } }, act()).yes, true);
check("and its radius comes back",
  emanatesFromCaster({ emanation: { radiusFt: 30 } }, act()).radiusFt, 30);
// ⚠️ THE SHAPE THAT BROKE IT. "self" used to be the only word this understood.
check('the old word "self" still works',
  emanatesFromCaster({ shape: "self" }, act()).yes, true);
check('and so does "emanation-heal", which is what broke it',
  emanatesFromCaster({ shape: "emanation-heal" }, act()).yes, true);
check('and "aura"', emanatesFromCaster({ shape: "aura" }, act()).yes, true);
// ⚠️ AND WITH NO ENTRY AT ALL. His homebrew and anything the registry has never
// heard of must behave the same — that is the "any self-emanating thing" he asked for.
check("no entry at all: range self plus a radius is an emanation",
  emanatesFromCaster(null, act()).yes, true);
check("a sphere counts", emanatesFromCaster(null, act({ type: "sphere" })).yes, true);
check("so does a cylinder", emanatesFromCaster(null, act({ type: "cylinder" })).yes, true);

console.log("\nBUT A SHAPE WITH A DIRECTION KEEPS ITS PROMPT");
// ⚠️🔴 BURNING HANDS. Range self, 15 foot cone, and it must be aimed.
check("a cone from self is still placed by hand",
  emanatesFromCaster(null, act({ type: "cone", size: 15 })).yes, false);
check("and it says why", /has to be aimed/.test(
  emanatesFromCaster(null, act({ type: "cone", size: 15 })).why), true);
check("a line from self is still placed by hand",
  emanatesFromCaster(null, act({ type: "line", size: 30 })).yes, false);
check("a cube is still placed by hand",
  emanatesFromCaster(null, act({ type: "cube", size: 15 })).yes, false);
// ⚠️ EVEN WHEN THE ENTRY CALLS IT SELF. A "self" spell with a cone is still a
// cone; the shape word must not beat the geometry.
check("an entry saying self does NOT un-aim a cone",
  emanatesFromCaster({ shape: "self" }, act({ type: "cone", size: 15 })).yes, false);

console.log("\nAND A SPELL AIMED SOMEWHERE ELSE IS UNTOUCHED");
check("a 60 foot sphere is placed where he wants it",
  emanatesFromCaster(null, act({ units: "ft" })).yes, false);
check("something with no template at all is not our business",
  emanatesFromCaster(null, act({ type: "" })).yes, false);

console.log("\nAN UNKNOWN SHAPE ASKS HIM, RATHER THAN GUESSING");
// ⚠️ King's Ghostly Howl, 2026-07-28: it carries template type "emanation", a
// word that does not exist in dnd5e 5.x. Assuming a circle would drop an
// un-aimable area on the caster's head; the prompt is the safe answer.
check("a template type dnd5e does not know keeps the prompt",
  emanatesFromCaster({ shape: "self" }, act({ type: "emanation" })).yes, false);

console.log("\nTHE LIST IS A TABLE, SO ADDING TO IT IS THE FIX");
check("the caster-centred shapes are enumerated, not hardcoded in a branch",
  [...CASTER_CENTRED_SHAPES].sort(), ["aura", "emanation-heal", "self"]);

console.log("\nTHE WAVE IS COLOUR-CODED TO WHAT THE SPELL DOES");
// ⚠️🔴 AND IT IS THE WAVE ACE ALREADY HAD. `AceFX.ghostlyWave` was built
// for the Spectral Wolf King's howl in July and tuned twice by him: "push it,
// visual waves go out 30 feet", then "I wish it was more like a waveform... it
// could last for one second longer". I did not grep for it, drew a 400-pixel
// JB2A explosion instead, and he got a poof he described as three feet across.
{
  const hex = (n) => "#" + Number(n).toString(16).padStart(6, "0");
  // ⚠️ HEALING BEATS EVERYTHING ON THE SAME ITEM.
  check("healing is green", hex(burstFor({ heals: true }).color), hex(HEAL_COLOR));
  check("healing beats a damage type on the same item",
    hex(burstFor({ heals: true, damageTypes: ["fire"] }).color), hex(HEAL_COLOR));

  check("necrotic takes the necrotic colour",
    hex(burstFor({ damageTypes: ["necrotic"] }).color), hex(DAMAGE_THEME.necrotic));
  check("fire takes the fire colour",
    hex(burstFor({ damageTypes: ["fire"] }).color), hex(DAMAGE_THEME.fire));
  check("cold takes the cold colour",
    hex(burstFor({ damageTypes: ["cold"] }).color), hex(DAMAGE_THEME.cold));
  check("a damage type is read case-insensitively",
    hex(burstFor({ damageTypes: ["Necrotic"] }).color), hex(DAMAGE_THEME.necrotic));

  // ⚠️ EVERY dnd5e DAMAGE TYPE HAS A COLOUR, or somebody's spell washes out
  // the same neutral blue as a buff and the colour stops meaning anything.
  const uncoloured = ["acid","bludgeoning","cold","fire","force","lightning","necrotic",
                      "piercing","poison","psychic","radiant","slashing","thunder"]
    .filter(t => DAMAGE_THEME[t] === undefined);
  check("every damage type in the game has a colour", uncoloured, []);

  // ⚠️ A BUFF IS NOT AN EXPLOSION.
  check("nothing stated gets the neutral arcane wave",
    hex(burstFor({}).color), hex(DEFAULT_COLOR));
  check("and it says why",
    burstFor({}).why, "it neither heals nor damages, so it gets the neutral arcane wave");
}

console.log("");
console.log(pass + " passed, " + fail + " failed");
if (fail) process.exitCode = 1;
