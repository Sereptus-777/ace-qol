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

/* ── DOES ANYBODY SAVE WHEN IT LANDS ────────────────────────────────────── */
console.log("\nREADING THE TEXT FOR WHEN THE AREA ASKS");
{
  const { readAreaTiming, initialSaveOwed } = await import(
    "file:///D:/FoundryVTT/Data/modules/ace-qol/scripts/inference/spell-plan.mjs");

  // ⚠️ THE REAL SENTENCES, COPIED OUT OF dnd5e's OWN 2024 BOOK. A harness that
  // invents its own phrasing proves nothing about his game.
  const TEXTS = {
    Fear: "Each creature in a 30-foot Cone must succeed on a Wisdom saving throw "
      + "or drop whatever it is holding and have the Frightened condition for the duration.",
    Moonbeam: "A silvery beam of pale light shines down in a 5-foot-radius Cylinder. "
      + "When the Cylinder appears, each creature in it makes a Constitution saving throw.",
    Grease: "Nonflammable grease covers the ground in a 10-foot square. When the grease "
      + "appears, each creature standing in its area must succeed on a Dexterity saving "
      + "throw or have the Prone condition. A creature that enters the area or ends its "
      + "turn there must also succeed on that save or fall Prone.",
    "Stinking Cloud": "You create a 20-foot-radius Sphere of gas. Each creature that "
      + "starts its turn in the Sphere must succeed on a Constitution saving throw.",
    "Sleet Storm": "Until the spell ends, sleet falls in a Cylinder. When a creature "
      + "enters the Cylinder for the first time on a turn or starts its turn there, it "
      + "must succeed on a Dexterity saving throw or have the Prone condition.",
    "Spike Growth": "The ground sprouts hard spikes. When a creature moves into or "
      + "within the area, it takes damage for every 5 feet it travels.",
  };

  check("Fear catches whoever is standing in the cone",
    readAreaTiming(TEXTS.Fear).initial, true);
  check("so does Moonbeam, which says when it appears",
    readAreaTiming(TEXTS.Moonbeam).initial, true);
  // ⚠️ GREASE IS WHY THESE ARE TWO ANSWERS AND NOT ONE. It catches who is
  // standing there AND who walks in later.
  check("Grease catches who is standing there", readAreaTiming(TEXTS.Grease).initial, true);
  check("and also who walks in", readAreaTiming(TEXTS.Grease).recatch, true);

  check("Stinking Cloud waits for your turn",
    readAreaTiming(TEXTS["Stinking Cloud"]).initial, null);
  check("Sleet Storm waits for you to enter",
    readAreaTiming(TEXTS["Sleet Storm"]).initial, null);
  check("and both are recorded as re-catching",
    [readAreaTiming(TEXTS["Stinking Cloud"]).recatch,
     readAreaTiming(TEXTS["Sleet Storm"]).recatch], [true, true]);
  check("a spell with no save at all claims neither",
    readAreaTiming(TEXTS["Spike Growth"]),
    { initial: null, recatch: null, sawSave: false, evidence: [] });

  // ⚠️🔴 dnd5e's 2024 TEXT IS NOT PROSE UNTIL FOUNDRY ENRICHES IT. Fireball's
  // description on disk never contains the words "each creature".
  const fireballRaw = "<p>A bright streak flashes from you to a point you choose within "
    + "range. [[lookup @labels.description.affects capitalize]] in a "
    + "[[lookup @labels.description.template]] centered on that point makes a Dexterity "
    + "saving throw, taking 8d6 Fire damage on a failed save.</p>";
  check("the 2024 lookup form is expanded, not read as silence",
    readAreaTiming(fireballRaw).initial, true);

  const refRaw = "<p>Each creature in the area must succeed on a Wisdom saving throw or "
    + "have the &Reference[frightened apply=false] condition.</p>";
  check("a Reference tag does not break the sentence",
    readAreaTiming(refRaw).initial, true);
}

console.log("\nA SAVE THAT BELONGS TO SOMEBODY ELSE IS NOT AN AREA SAVE");
{
  const { readAreaTiming } = await import(
    "file:///D:/FoundryVTT/Data/modules/ace-qol/scripts/inference/spell-plan.mjs");

  // ⚠️🔴 "IN THE AREA" IS THE WRONG TEST, and trying it first proved it. Every
  // sentence below is copied out of dnd5e's 2024 book. The left column is what
  // RAW says, checked by hand.
  const CASES = [
    // Area saves the engine must post when the spell lands.
    [true, "Calm Emotions", "Each Humanoid in a 20-foot-radius Sphere centered on a "
      + "point you choose within range must succeed on a Charisma saving throw."],
    [true, "Earthquake", "When you cast this spell and at the end of each of your turns "
      + "for the duration, each creature on the ground in the area makes a Dexterity "
      + "saving throw."],
    [true, "Entangle", "Each creature (other than you) in the area when you cast the "
      + "spell must succeed on a Strength saving throw or have the restrained condition."],
    [true, "Storm of Vengeance", "Each creature under the cloud when it appears must "
      + "succeed on a Constitution saving throw or take 2d6 Thunder damage."],
    [true, "Blade Barrier", "Any creature in the wall's space makes a Dexterity saving throw."],
    [true, "Slow", "Each target must succeed on a Wisdom saving throw or be affected "
      + "by this spell for the duration."],
    // ⚠️ FAERIE FIRE NEVER SAYS "MUST" ANYWHERE IN ITS TEXT.
    [true, "Faerie Fire", "Each creature in the Cube is also outlined if it fails a "
      + "Dexterity saving throw."],
    // ⚠️ NOT EVERY AREA SAVE OPENS WITH THE GROUP.
    [true, "Ice Knife", "The target and each creature within 5 feet of it must succeed "
      + "on a Dexterity saving throw or take 2d6 Cold damage."],
    [true, "Entangle 2014", "A creature in the area when you cast the spell must succeed "
      + "on a Strength saving throw or be Restrained by the entangling Plants."],

    // Saves that belong to somebody the spell singles out later. Posting a card
    // for everyone standing in the area would be a card that should not exist.
    [false, "Holy Aura", "In addition, when a Fiend or an Undead hits an affected "
      + "creature with a melee attack roll, the attacker must succeed on a Constitution "
      + "saving throw or have the Blinded condition."],
    [false, "Detect Thoughts", "If you probe deeper, the target makes a Wisdom saving throw."],
    [false, "Conjure Celestial", "The target makes a Dexterity saving throw, taking 6d12 "
      + "Radiant damage on a failed save."],
    // ⚠️ AN OFFER IS NOT A CARD. The same words as a forced save with one
    // auxiliary in front of them, and a group subject to boot.
    [false, "Reverse Gravity", "A creature can make a Dexterity saving throw to grab a "
      + "fixed object it can reach, thus avoiding the fall upward."],
    [false, "Forcecage", "If the creature tries to use teleportation or interplanar "
      + "travel to leave, it must first make a saving throw."],
    [false, "Phantasmal Force", "The target can use its action to examine the illusion "
      + "and make an Intelligence saving throw."],
    [false, "Wall of Stone", "If a creature would be surrounded on all sides by the wall, "
      + "that creature can make a Dexterity saving throw."],
    // ⚠️ "at the end of each of its turns" contains the word "each". A looser
    // test that only looked for that word anywhere would call this an area save.
    [false, "Weird's escape clause", "A Frightened target makes a Wisdom saving throw at "
      + "the end of each of its turns."],
  ];
  for (const [want, name, text] of CASES) {
    check(`${name}`, readAreaTiming(text).initial === true, want);
  }
}

console.log("\nTHREE ANSWERS, NEVER TWO");
{
  const { initialSaveOwed } = await import(
    "file:///D:/FoundryVTT/Data/modules/ace-qol/scripts/inference/spell-plan.mjs");
  const withText = (t) => ({ system: { description: { value: t } } });

  check("a spell that forces no save owes none",
    initialSaveOwed(withText("Each creature in the area is blinded."), { hasSave: false }), false);
  check("a text that says so owes one",
    initialSaveOwed(withText("Each creature in the Cone must succeed on a Wisdom saving throw.")),
    true);
  check("a text that only names entry owes none yet",
    initialSaveOwed(withText("Each creature that starts its turn in the Sphere must succeed "
      + "on a Constitution saving throw.")), false);
  // ⚠️🔴 A SAVE THAT BELONGS TO SOMEBODY ELSE IS NOT THE AREA'S. Holy Aura
  // saves the ATTACKER who hits someone in the aura. A card for everyone
  // standing in it is a card that should not exist, which is the same fault as
  // the silence wearing the other face.
  check("a save the text pins on somebody else owes none",
    initialSaveOwed(withText("When a Fiend or an Undead hits an affected creature with "
      + "a melee attack roll, the attacker must succeed on a Constitution saving throw.")),
    false);

  // ⚠️ SILENCE IS ITS OWN ANSWER, AND IT MUST NOT READ AS "NO". A sheet that
  // carries a save whose text never mentions one leaves nothing to read, and
  // reporting that as "no save" is how a working spell becomes a dead button.
  check("a text that names no save at all is unknown, not no",
    initialSaveOwed(withText("A shimmering barrier springs into being.")), "unknown");
  check("and no text at all is unknown too", initialSaveOwed({}), "unknown");
}

console.log("\nAND THE PLAN SAYS IT OUT LOUD");
{
  const fear = spell("Fear", { template: CONE30, save: "wis",
    duration: "minute", durationValue: 1, concentration: true });
  fear.system.description.value = "Each creature in a 30-foot Cone must succeed on a "
    + "Wisdom saving throw or have the Frightened condition for the duration.";
  const plan = planFor(fear, { timing: timing("startOfTurn", { unclassified: true }) });
  check("Fear's initial save is owed", plan.persist.initialSave, true);
  check("and the plan prints it",
    /on arrival\s+everyone already inside saves now/.test(describePlan(plan)), true);

  const web = spell("Web", { units: "ft", value: 60,
    template: { type: "cube", size: 20, units: "ft" }, save: "dex",
    duration: "hour", durationValue: 1, concentration: true });
  web.system.description.value = "Each creature that starts its turn in the webs or that "
    + "enters them during its turn must make a Dexterity saving throw.";
  const webPlan = planFor(web, { timing: timing("enterStart", { fromTable: true }) });
  check("Web owes no initial save", webPlan.persist.initialSave, false);
  check("and the plan says nobody saves yet",
    /on arrival\s+nobody saves until they enter/.test(describePlan(webPlan)), true);
}

console.log("\nTHE SAVE ENGINE'S BRANCH ONLY EVER ADDS");
{
  // ⚠️🔴 THE SAFETY PROPERTY, WRITTEN AS A TEST. save-engine changed
  //     (triggerOnEnter)            && tokens && !areaDenial
  // to  (triggerOnEnter || textNow) && tokens && !areaDenial
  // A card that was posted before must still be posted. Nothing may stop.
  const before = (enter, tokens, denial) => enter && tokens && !denial;
  const after = (enter, textNow, tokens, denial) => (enter || textNow) && tokens && !denial;
  let regressions = 0, additions = 0;
  for (const enter of [true, false]) {
    for (const textNow of [true, false]) {
      for (const tokens of [true, false]) {
        for (const denial of [true, false]) {
          const b = before(enter, tokens, denial);
          const a = after(enter, textNow, tokens, denial);
          if (b && !a) regressions++;
          if (!b && a) additions++;
        }
      }
    }
  }
  check("no case that posted a card stops posting one", regressions, 0);
  check("and it does add cards where the text asks", additions > 0, true);
}

console.log("");
console.log(pass + " passed, " + fail + " failed");
if (fail) process.exitCode = 1;
