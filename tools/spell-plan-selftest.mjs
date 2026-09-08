// ─── A plan, built from the item, with no entry written for it ──────────────
//
// Johnny, 2026-09-07: *"I told you before we have all the information... Figure
// out how we're going to do this without building entries for every spell."*
//
// ⚠️🔴 THE ONE THIS EXISTS TO STOP. classify-item asks spell-timing whether a
// spell "catches creatures entering it" and then answers EITHER
// "template-trigger" OR "template-save", never both. A spell that re-catches
// does not stop having an initial save: everyone standing in Moonbeam when it
// lands saves, and so does everyone who walks in afterwards.
//
// And spell-timing DEFAULTS an unknown persistent area spell to start-of-turn,
// marking the answer `unclassified`. That default was read as evidence. Measured
// against dnd5e's own books, 60 shipped spells carry a real saving throw that
// nothing ever rolls because of it. Fear is one of the sixty.
//
// So: the initial decision and the re-catching are separate columns here, and no
// amount of uncertainty about the second may erase the first.
//
// Run:  node tools/spell-plan-selftest.mjs

let pass = 0, fail = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log((ok ? "  ok   " : "  FAIL ") + String(label).padEnd(60)
    + "got " + JSON.stringify(got) + ", want " + JSON.stringify(want));
};

const { planFor, describePlan } = await import(
  "file:///D:/FoundryVTT/Data/modules/ace-qol/scripts/inference/spell-plan.mjs");

/**
 * A spell shaped the way dnd5e really ships them: no `system.target`, targeting
 * and saves on the activity, `override: false`, activities in a Map.
 */
const spell = (name, {
  units = "self", value = null, template = null, save = null, halfOnSave = false,
  damage = [], healing = null, count = null, affects = null, duration = "inst",
  durationValue = null, concentration = false,
} = {}) => ({
  name, type: "spell",
  system: {
    level: 3, school: "evo", properties: new Set(concentration ? ["concentration"] : []),
    range: { units, value },
    duration: { units: duration, value: durationValue, concentration },
    description: { value: "" },
    activities: new Map(Object.entries({ a1: {
      type: save ? "save" : (healing ? "heal" : "utility"),
      range: { units, value, override: false },
      target: {
        override: false, prompt: true,
        affects: { count, type: affects },
        ...(template ? { template } : {}),
      },
      ...(save ? { save: { ability: new Set([save]), dc: { calculation: "spellcasting" } } } : {}),
      damage: { parts: damage, onSave: halfOnSave ? "half" : "none" },
      ...(healing ? { healing } : {}),
    } })),
  },
});

const CONE30 = { type: "cone", size: 30, units: "ft" };
const RADIUS30 = { type: "radius", size: 30, units: "ft" };
const D8 = [{ number: 8, denomination: 8, types: ["cold"] }];

// spell-timing's answer, in its real shape. `unclassified` is the flag that
// marks a default rather than a finding.
const timing = (t, { fromTable = false, unclassified = false } = {}) =>
  ({ timing: t, fromTable, fromFlag: false, fromParsing: false, unclassified,
     isInstant: t === "instant", isPersistent: t !== "instant", followsCaster: false });

/* ── FEAR ───────────────────────────────────────────────────────────────── */
console.log("\nFEAR, THE SPELL THAT DID NOTHING");
{
  // Exactly as it sits on his sheet: range self, a 30 foot cone on the activity,
  // a WIS save, an effect, one minute, and NOT in spell-timing's table.
  const item = spell("Fear", { template: CONE30, save: "wis",
    duration: "minute", durationValue: 1, concentration: true });
  const plan = planFor(item, { timing: timing("startOfTurn", { unclassified: true }) });

  check("it can be run from the item alone", plan.complete, true);
  check("the cone is where it lands", plan.place.template?.shape, "cone");
  check("centred on the caster", plan.place.kind, "emanation");
  check("everyone standing in it is caught", plan.who.kind, "everyone inside");

  // ⚠️🔴 THE ASSERTION THAT MATTERS. This is the save nothing rolled.
  check("there IS an initial save", plan.decide.kind, "save");
  check("and it is the one the item states", plan.decide.ability, "wis");

  // ⚠️ AND THE RE-CATCH IS RECORDED BESIDE IT, NEVER INSTEAD OF IT.
  check("re-catching is recorded separately", plan.persist.recatches, true);
  check("and honestly labelled as an assumption",
    plan.persist.recatchConfidence, "assumed");
}

console.log("\nAN ASSUMPTION CANNOT ERASE A STATED SAVE");
{
  // The same spell whatever spell-timing says: unknown, known-instant, or
  // known-persistent. The save is on the item, so it survives all three.
  const item = spell("Fear", { template: CONE30, save: "wis",
    duration: "minute", durationValue: 1 });
  for (const [label, t] of [
    ["nothing known", timing("startOfTurn", { unclassified: true })],
    ["known to re-catch", timing("startOfTurn", { fromTable: true })],
    ["known to resolve once", timing("instant", { fromTable: true })],
    ["no timing at all", null],
  ]) {
    check(`the save survives when ${label}`,
      planFor(item, { timing: t }).decide.kind, "save");
  }
  check("a stated re-catch is labelled stated",
    planFor(item, { timing: timing("startOfTurn", { fromTable: true }) })
      .persist.recatchConfidence, "stated");
  check("and a stated instant does not invent one",
    planFor(item, { timing: timing("instant", { fromTable: true }) })
      .persist.recatches, false);
}

/* ── THE OTHER FOUR COLUMNS ─────────────────────────────────────────────── */
console.log("\nWHERE IT LANDS");
{
  check("a thrown area is placed at a point",
    planFor(spell("Fireball", { units: "ft", value: 150, template: RADIUS30,
      save: "dex", damage: D8 })).place.kind, "area");
  check("with the range it may be thrown",
    planFor(spell("Fireball", { units: "ft", value: 150, template: RADIUS30,
      save: "dex", damage: D8 })).place.rangeFt, 150);
  check("a touch spell is touch",
    planFor(spell("Cure Wounds", { units: "touch", healing: { number: 2, denomination: 8 } }))
      .place.kind, "touch");
  check("a self buff stays on the caster",
    planFor(spell("Shield", { units: "self" })).place.kind, "self");
}

console.log("\nWHO IS CAUGHT");
{
  // ⚠️🔴 AN EMANATION THAT ASKS NOTHING OF ANYBODY IS NOT AN AREA. Detect Magic
  // is range self with a 30 foot radius and does nothing to anyone in it.
  const detect = planFor(spell("Detect Magic", { template: RADIUS30 }));
  check("a sensing emanation catches nobody", detect.who.kind, "the caster");
  check("and still knows its radius, so it can be drawn",
    detect.place.template?.size, 30);

  // ⚠️ AN AREA CAN BE WHERE YOU CHOOSE FROM. Mass Cure Wounds is "up to six
  // creatures in a 30 foot sphere"; catching everyone heals the enemy in it.
  const mass = planFor(spell("Mass Cure Wounds", { units: "ft", value: 60,
    template: RADIUS30, healing: { number: 3, denomination: 8 }, count: 6 }));
  check("a choosing area lets you pick", mass.who.kind, "picked inside the area");
  check("as many as it says", mass.who.count, 6);

  // ⚠️ A REACHABLE SPELL WITH NO STATED COUNT IS ONE TARGET, NOT NONE. Reading
  // a blank count as "nobody" is how a working spell becomes a dead button.
  const one = planFor(spell("Ray of Frost", { units: "ft", value: 60, damage: D8 }));
  check("a blank count reads as one target", one.who.count, 1);
  check("and says that it assumed it", one.who.assumed, true);
}

console.log("\nWHAT IT DOES");
{
  const fb = planFor(spell("Fireball", { units: "ft", value: 150, template: RADIUS30,
    save: "dex", damage: D8, halfOnSave: true }));
  check("the damage is carried", fb.apply.damage[0]?.formula, "8d8");
  // ⚠️ HALF ON A SUCCESS IS PART OF THE PAYLOAD. Dropping it takes a target from
  // full to nothing on a save they made.
  check("and half on a success travels with it", fb.apply.halfOnSave, true);
}

/* ── WHEN IT CANNOT BE PLANNED ──────────────────────────────────────────── */
console.log("\nWHAT IT WILL NOT GUESS AT");
{
  // ⚠️ "COULD NOT PLAN IT" AND "IT DOES NOTHING" MUST NEVER PRINT THE SAME.
  const sending = planFor(spell("Sending", { units: "any" }));
  check("an unlimited range is not planned", sending.complete, false);
  check("and the reason is in words",
    /note to read its own text/.test(sending.gaps.join(" ")), true);
  check("the description says dnd5e keeps it",
    /dnd5e resolves it natively/.test(describePlan(sending)), true);

  // A template naming a shape with no size cannot be drawn.
  const noSize = planFor(spell("Odd", { template: { type: "cube", size: 0, units: "ft" } }));
  check("a sizeless area is refused", noSize.complete, false);
  check("and says so plainly",
    /no size, so there is nothing to draw/.test(noSize.gaps.join(" ")), true);
}

console.log("\nAND IT NEVER THROWS ON RUBBISH");
{
  for (const [label, input] of [
    ["null", null], ["a number", 7], ["an empty object", {}],
    ["an item with no system", { name: "Bare", type: "spell" }],
  ]) {
    let threw = false, plan = null;
    try { plan = planFor(input); } catch (_) { threw = true; }
    check(`${label} does not throw`, threw, false);
    check(`${label} is reported, not silently empty`, (plan?.gaps?.length ?? 0) > 0
      || plan?.complete === false, true);
  }
}

console.log("");
console.log(pass + " passed, " + fail + " failed");
if (fail) process.exitCode = 1;
