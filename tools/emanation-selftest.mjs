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

const { emanatesFromCaster, CASTER_CENTRED_SHAPES, burstFor } = await import(
  "file:///D:/FoundryVTT/Data/modules/ace-qol/scripts/caster-emanation.mjs");

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

console.log("\nTHE BURST IS COLOUR-CODED TO WHAT THE SPELL DOES");
// ⚠️ HEALING WINS OVER EVERYTHING. Aura of Vitality is why this exists, and
// a spell that restores hit points is green whatever else it carries.
check("healing is the green healing burst",
  burstFor({ heals: true }).key, "jb2a.healing_generic.burst.greenorange");
check("healing beats a damage type on the same item",
  burstFor({ heals: true, damageTypes: ["fire"] }).key, "jb2a.healing_generic.burst.greenorange");

check("necrotic is purple",  burstFor({ damageTypes: ["necrotic"] }).key,  "jb2a.explosion.01.purple");
check("fire is orange",      burstFor({ damageTypes: ["fire"] }).key,      "jb2a.explosion.01.orange");
check("cold is blue",        burstFor({ damageTypes: ["cold"] }).key,      "jb2a.explosion.01.blue");
check("poison is green",     burstFor({ damageTypes: ["poison"] }).key,    "jb2a.explosion.01.green");
check("radiant is yellow",   burstFor({ damageTypes: ["radiant"] }).key,   "jb2a.explosion.01.yellow");
check("psychic is purple",   burstFor({ damageTypes: ["psychic"] }).key,   "jb2a.explosion.01.purple");
check("a damage type is read case-insensitively",
  burstFor({ damageTypes: ["Necrotic"] }).key, "jb2a.explosion.01.purple");
check("an unknown damage type still gets a damage burst",
  burstFor({ damageTypes: ["chocolate"] }).key, "jb2a.explosion.01.orange");

// ⚠️ A BUFF IS NOT AN EXPLOSION. Detect Magic bursting like a fireball would
// tell the table something violent had happened.
check("nothing stated gets a neutral flare, not an explosion",
  burstFor({}).key, "jb2a.healing_generic.burst.bluewhite");
check("and it says why", burstFor({}).why, "it neither heals nor damages, so it gets a neutral flare");

console.log("\nEVERY FALLBACK FILE IS ONE THAT ACTUALLY EXISTS");
// ⚠️🔴 READ OFF HIS DISK, NOT REMEMBERED. A Sequencer database key that has
// been renamed falls back to a file path, and a path that does not exist is a
// spell with no picture and a console warning nobody reads. These are checked
// against the installed library.
{
  const fs = await import("node:fs");
  const cases = [{ heals: true }, {}, { damageTypes: ["necrotic"] }, { damageTypes: ["fire"] },
                 { damageTypes: ["cold"] }, { damageTypes: ["poison"] },
                 { damageTypes: ["radiant"] }, { damageTypes: ["nonsense"] }];
  const missing = cases.map(c => burstFor(c).file)
    .filter(f => !fs.existsSync("D:/FoundryVTT/Data/" + f));
  check("every burst falls back to a file that is installed", missing, []);
}

console.log("");
console.log(pass + " passed, " + fail + " failed");
if (fail) process.exitCode = 1;
