// ─── Can the engine see an area at all? ─────────────────────────────────────
//
// ⚠️🔴 THE BUG. Johnny, 2026-09-07, after Fear did nothing when he pressed it:
// *"I thought we built an engine to look at every time I push a fucking
// button."* It did look. It could not see.
//
// His Fear activity carried, plainly:
//     range:  { units: "self" }
//     target: { template: { type: "cone", size: 30, units: "ft" },
//               override: false, prompt: true }
//
// The line that gathers templates read one only from an activity marked
// `override: true`, and fell back to the ITEM's `system.target.template`.
// A spell item has no `system.target` at all — dnd5e's SpellData schema defines
// `range` and never defines `target` — so the fallback could never hold
// anything. Every spell whose activity says `override: false`, which is nearly
// all of them, was read as having no area whatsoever.
//
// ⚠️ `override: false` MEANS "I DO NOT OVERRIDE THE ITEM", NOT "I HAVE NOTHING".
// This is the same trap already written up from 2026-08-28, where reading it as
// on/off made every rapier self-targeting. The guard is CORRECT for range,
// because an item really does have its own range to fall back to. It was copied
// to templates, where the fallback is structurally impossible.
//
// Run:  node tools/template-sight-selftest.mjs

let pass = 0, fail = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log((ok ? "  ok   " : "  FAIL ") + String(label).padEnd(62)
    + "got " + JSON.stringify(got) + ", want " + JSON.stringify(want));
};

const { readActionFacts } = await import(
  "file:///D:/FoundryVTT/Data/modules/ace-qol/scripts/inference/action-facts.mjs");
const readAction = (item) => readActionFacts(item);

// A spell shaped exactly like the real thing: no system.target, everything on
// the activity, override false.
const spell = (name, { units = "self", template = null, save = "wis",
                       damage = [], description = "" } = {}) => ({
  name, type: "spell",
  system: {
    level: 3, school: "enc", properties: new Set(),
    range: { units, value: null },
    duration: { units: "inst", value: null },
    description: { value: description },
    // ⚠️ NO `target` HERE, ON PURPOSE. That is the whole point: dnd5e spells
    // do not have one, and a harness that invented one would hide the bug.
    // ⚠️🔴 A MAP, NOT AN ARRAY. The bug this file exists for was
    // `Object.values()` on a Collection returning []. A harness that hands over
    // a plain array cannot see that, and would have passed all along.
    activities: new Map(Object.entries({ a1: {
      type: save ? "save" : "utility",
      range: { units, value: null, override: false },
      target: {
        override: false,
        prompt: true,
        affects: { count: null },
        ...(template ? { template } : {}),
      },
      ...(save ? { save: { ability: new Set([save]), dc: { calculation: "spellcasting" } } } : {}),
      damage: { parts: damage },
    } })),
  },
});

const CONE30 = { type: "cone", size: 30, units: "ft" };

console.log("\nFEAR, EXACTLY AS IT SITS ON HIS SHEET");
{
  const facts = readAction(spell("Fear", { template: CONE30 }));
  // ⚠️🔴 Before this fix, delivery.template was null and the shape was "self".
  check("the cone is seen at all", !!facts?.delivery?.template, true);
  check("its shape", facts?.delivery?.template?.shape, "cone");
  check("its size", facts?.delivery?.template?.size, 30);
  // Range self PLUS a template is an emanation, which is the correct reading:
  // it radiates from the caster rather than being thrown somewhere.
  check("delivered as an emanation, not a self-buff", facts?.delivery?.kind, "emanation");
}

console.log("\nAND THE SAME SPELL WITH NO CONE IS STILL SELF");
{
  // ⚠️ THE ONE THAT MUST NOT BREAK. Divine Favor and Second Wind are range self
  // with no area, and calling them areas would put a crosshair in front of a
  // spell with nothing to place.
  const facts = readAction(spell("Divine Favour", { template: null }));
  check("no template invented", facts?.delivery?.template, null);
  check("still delivered as self", facts?.delivery?.kind, "self");
}

console.log("\nAN OVERRIDING ACTIVITY STILL WINS");
{
  const item = spell("Odd Spell", { template: CONE30 });
  item.system.activities.set("a2", {
    type: "save",
    range: { units: "self", override: false },
    target: { override: true, template: { type: "radius", size: 15, units: "ft" },
              affects: { count: null } },
    save: { ability: new Set(["dex"]), dc: {} },
    damage: { parts: [] },
  });
  const facts = readAction(item);
  check("the one that claims authority is used", facts?.delivery?.template?.shape, "radius");
  check("at its own size", facts?.delivery?.template?.size, 15);
}

console.log("\nA THROWN AREA IS AN AREA, NOT AN EMANATION");
{
  const facts = readAction(spell("Fireball", {
    units: "ft", template: { type: "sphere", size: 20, units: "ft" }, save: "dex" }));
  check("it puts an area on the map", facts?.delivery?.kind, "area");
  check("with the sphere it declares", facts?.delivery?.template?.shape, "sphere");
}

console.log("\nAND NOTHING BREAKS WHEN THERE ARE NO ACTIVITIES AT ALL");
{
  const bare = { name: "Note", type: "spell",
    system: { range: {}, duration: {}, description: { value: "" },
              properties: new Set(), activities: new Map() } };
  const facts = readAction(bare);
  check("no template", facts?.delivery?.template, null);
  check("and it does not throw", typeof facts?.delivery?.kind, "string");
}

console.log("\nA CONDITION IS A NAME, NOT AN OBJECT");
{
  // ⚠️🔴 CAUGHT IN THE ENGINE'S OWN WORDS ON 2026-09-07: asked what Fear does,
  // it answered *"its text can leave a target [object Object]"*. The description
  // parser returns `{ condition, requiresSave }` per condition and every reader
  // downstream treated the list as strings.
  //
  // Not cosmetic: the classifier builds a spell's effect from the first entry,
  // so the key it wrote was an object rather than "frightened", and the learned
  // store fingerprints an item by joining the same list, so every
  // condition-applying item in the world shared one value on that field.
  const { readActionFacts, describeActionFacts } = await import(
    "file:///D:/FoundryVTT/Data/modules/ace-qol/scripts/inference/action-facts.mjs");
  const item = spell("Fear", { template: CONE30 });
  const parsed = { conditions: [{ condition: "frightened", requiresSave: true }] };
  const facts = readActionFacts(item, { parsed });

  check("the list holds names", facts?.change?.conditions, ["frightened"]);
  check("nothing stringifies to an object",
    /\[object Object\]/.test(describeActionFacts(facts)), false);
  check("and the save flag is still available beside it",
    facts?.change?.conditionDetails?.[0]?.requiresSave, true);

  // A parser that already hands over plain strings must not be broken by the fix.
  const plain = readActionFacts(item, { parsed: { conditions: ["prone"] } });
  check("a plain string list still reads", plain?.change?.conditions, ["prone"]);
}

console.log("\nTHE CONDITION IS DATA, NOT PROSE");
{
  // ⚠️🔴 WHAT THIS EXISTS TO STOP. Johnny, 2026-09-08: a Specter failed Fear on
  // a natural 1 and was not frightened. His console: "parsed 0 condition(s)".
  // The only reader was the DESCRIPTION parser, so an item with a thin or
  // re-written description applied nothing at all, however correctly it was
  // built — and dnd5e states it on the item the whole time.
  const { readAppliedConditions } = await import(
    "file:///D:/FoundryVTT/Data/modules/ace-qol/scripts/read-activities.mjs");
  const { readActionFacts } = await import(
    "file:///D:/FoundryVTT/Data/modules/ace-qol/scripts/inference/action-facts.mjs");

  // Shaped the way a LIVE item is: statuses are a Set, activities are a Map.
  const withEffect = (name, effects, actEffects) => {
    const it = spell(name, { template: CONE30, save: "wis" });
    it.effects = effects;
    it.system.activities.get("a1").effects = actEffects;
    it.system.description = { value: "" };   // nothing for the parser to find
    return it;
  };

  const fear = withEffect("Fear",
    [{ _id: "e1", name: "Fear", statuses: new Set(["frightened"]), disabled: false }],
    [{ _id: "e1", onSave: false }]);
  check("the condition is found on the item's effect",
    readAppliedConditions(fear).map(c => c.condition), ["frightened"]);
  // ⚠️ `onSave: false` MEANS "not applied on a success", so it applies on a FAIL.
  check("and it is save-gated because the activity says so",
    readAppliedConditions(fear)[0]?.requiresSave, true);
  check("the facts carry it with an empty description",
    readActionFacts(fear).change.conditions, ["frightened"]);

  // Hypnotic Pattern's one effect carries two statuses.
  const hypnotic = withEffect("Hypnotic Pattern",
    [{ _id: "e1", name: "Hypnotized", statuses: new Set(["charmed", "incapacitated"]),
       disabled: false }],
    [{ _id: "e1", onSave: false }]);
  check("both statuses on one effect are read",
    readAppliedConditions(hypnotic).map(c => c.condition), ["charmed", "incapacitated"]);

  // ⚠️ A TRANSFER EFFECT RIDES ON THE CARRIER, NOT THE VICTIM. Applying a
  // cloak's own passive bonus to whoever it is used against would be nonsense.
  const cloak = withEffect("Cloak of Something",
    [{ _id: "e1", name: "Warm", statuses: new Set(["blessed"]), disabled: false,
       transfer: true }],
    [{ _id: "e1", onSave: false }]);
  check("a transfer effect is not applied to a target", readAppliedConditions(cloak), []);

  // ⚠️ AND A DISABLED ONE IS NOT AN ANSWER EITHER.
  const off = withEffect("Off",
    [{ _id: "e1", name: "Fear", statuses: new Set(["frightened"]), disabled: true }],
    [{ _id: "e1", onSave: false }]);
  check("a disabled effect is ignored", readAppliedConditions(off), []);

  // ⚠️ `onSave: true` means it lands EVEN ON A SUCCESS, so it is not save-gated.
  const always = withEffect("Always",
    [{ _id: "e1", name: "Marked", statuses: new Set(["marked"]), disabled: false }],
    [{ _id: "e1", onSave: true }]);
  check("an effect that lands on a success is not save-gated",
    readAppliedConditions(always)[0]?.requiresSave, false);

  // A compendium copy stores only ids in `effects`; there is nothing to read,
  // and reading it must not throw or invent anything.
  const bare = withEffect("Bare", ["e1"], [{ _id: "e1", onSave: false }]);
  check("an id-only effects array reads as nothing", readAppliedConditions(bare), []);
  check("and nothing throws on rubbish", readAppliedConditions(null), []);
}

console.log("");
console.log(pass + " passed, " + fail + " failed");
if (fail) process.exitCode = 1;
