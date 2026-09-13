// ─── Which activity does a press mean? Every rule, one case each ────────────
//
// The chooser broke three times in a fortnight: Magic Missile asked which row,
// Prismatic Wall took its Blinding Save, and Neferon's Claws asked "Attack or
// Save?". Its rules now live in scripts/activity-choice.mjs as one decision
// with no page behind it, and this pins every rule in it.
//
// Run:  node tools/activity-choice-selftest.mjs
// ──────────────────────────────────────────────────────────────────────────────

const { decideActivityChoice } = await import(
  "file:///D:/FoundryVTT/Data/modules/ace-qol/scripts/activity-choice.mjs");

let pass = 0, fail = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log((ok ? "  ok   " : "  FAIL ") + String(label).padEnd(62)
    + "got " + JSON.stringify(got) + ", want " + JSON.stringify(want));
};
const PASSIVE = new Set(["special", "turnStart", "turnEnd", "encounter", "shortRest", "longRest"]);
const isMachinery = (a) => PASSIVE.has(a?.activation?.type);
const act = (id, type, extra = {}) => ({ id, type, name: "", activation: { type: "action" },
  consumption: { spellSlot: true, targets: [] }, ...extra });
const decide = (item, acts, over = {}) => decideActivityChoice({
  item, activities: acts, offeredIds: acts.map(a => a.id), isMachinery,
  riderIds: new Set(), owns: false, resolvesItself: false, ...over });
const show = (d) => d.kind === "fire" ? `fire ${d.activity?.name || d.activity?.type || d.activityId}`
  : d.kind === "ask" ? `ask ${d.choices.map(a => a.name || a.type).join("|")}` : d.kind;

console.log("\nA SPELL ACE CASTS ITSELF NEVER ASKS WHICH ROW");
{
  const mm = { name: "Magic Missile", type: "spell" };
  const acts = [act("d", "damage"), act("u", "utility", { name: "Use" }),
    act("b1", "damage", { name: "Magic Missile Bolt", activation: { type: "special" } }),
    act("b2", "damage", { name: "Magic Missile Bolt: Flat", activation: { type: "special" } })];
  const d = decide(mm, acts, { owns: true, resolvesItself: true });
  check("Magic Missile casts its damage row without asking", show(d), "fire damage");
  check("and says it hid the two bolts", /hid 2 internal activities/.test(d.notes.join(" ")), true);
}

console.log("\nA WALL OR A GLOBE IS A REAL CHOICE");
{
  const wall = { name: "Prismatic Wall", type: "spell" };
  const free = { activation: { type: "" }, consumption: { spellSlot: false, targets: [] } };
  const acts = [act("w", "utility", { name: "Create Wall" }), act("g", "utility", { name: "Create Globe" }),
    act("b", "save", { name: "Blinding Save", ...free }), act("t", "save", { name: "Traversal Save", ...free })];
  const d = decide(wall, acts, { owns: true, resolvesItself: false });
  // ⚠️ STILL LISTS THE TWO SAVES. They come off when ACE rolls them itself;
  // until then this is the only way to roll them at all.
  check("Prismatic Wall asks, and the caster picks", show(d),
    "ask Create Wall|Create Globe|Blinding Save|Traversal Save");
  check("different names are not called duplicates", d.duplicates, { twins: [], clones: [] });
}

console.log("\nA SAVE THAT FOLLOWS A HIT IS NOT A CHOICE");
{
  const claws = { name: "Claws", type: "weapon" };
  const acts = [act("atk", "attack"), act("sv", "save")];
  const d = decide(claws, acts, { riderIds: new Set(["sv"]) });
  check("Neferon's Claws just attacks", show(d), "fire attack");
  check("and says why the Save is not offered", /not offering "Save"/.test(d.notes.join(" ")), true);
  // ⚠️ NEVER SWALLOW THE ACTION: if the rider were all there was, it stays.
  const onlySave = decide(claws, [act("sv", "save"), act("sv2", "save")], { riderIds: new Set(["sv", "sv2"]) });
  check("a list made only of riders is not emptied", onlySave.kind, "ask");
}

console.log("\nGENUINE CHOICES STAY CHOICES");
{
  const staff = { name: "Staff of the Stormforger", type: "weapon" };
  const acts = [act("a", "attack", { name: "Tornado Takedown" }), act("b", "utility", { name: "Aerial Ascension" }),
    act("c", "utility", { name: "Aerial Descent" }), act("d", "save", { name: "Thunderstorm of Misery" })];
  const d = decide(staff, acts);
  check("the Stormforger's four abilities are offered", show(d),
    "ask Tornado Takedown|Aerial Ascension|Aerial Descent|Thunderstorm of Misery");
  check("and are not called duplicates", d.duplicates, { twins: [], clones: [] });
  const dup = decide({ name: "Imported Missile", type: "spell" }, [act("x", "damage"), act("y", "damage")]);
  check("two unnamed rows with the same cost are flagged", dup.duplicates.clones.length, 1);
}

console.log("\nONE THING TO DO IS NOT A QUESTION");
{
  const sword = { name: "Longsword", type: "weapon" };
  check("a lone attack is pressed", show(decide(sword, [act("a", "attack")])), "fire attack");
  const d = decide({ name: "Dagger", type: "weapon" },
    [act("a", "attack"), act("m", "damage", { activation: { type: "special" } })]);
  check("an attack beside machinery is pressed without asking", show(d), "fire attack");
}

console.log("\nWHAT HAPPENS WHEN NOTHING ABOVE DECIDES");
{
  const smite = { name: "Divine Smite rider", type: "weapon" };
  check("a weapon's rider dialog is closed", decide(smite, [act("d", "damage")]).kind, "close");
  const sym = { name: "Holy Symbol", type: "equipment", flags: { "ace-artificer": { appliedTemplate: "x" } } };
  check("a Forge-templated item shows its own list", decideActivityChoice({ item: sym, activities: null,
    offeredIds: [], isMachinery }).kind, "reveal");
  const spell = { name: "Some Spell", type: "spell" };
  const first = decideActivityChoice({ item: spell, activities: null, offeredIds: ["first", "second"], isMachinery });
  check("a spell with no list to read presses its first button", [first.kind, first.activityId], ["fire", "first"]);
  check("a spell with no buttons shows dnd5e's list", decideActivityChoice({ item: spell, activities: null,
    offeredIds: [], isMachinery }).kind, "reveal");
  check("any other item with no list shows dnd5e's list", decideActivityChoice({ item: { name: "Rod", type: "equipment" },
    activities: null, offeredIds: [], isMachinery }).kind, "reveal");
}

console.log("\nTHE QUESTIONS ARE ONLY ASKED WHEN THEY MATTER");
{
  let asked = 0;
  decide({ name: "Longsword", type: "weapon" }, [act("a", "attack")],
    { owns: () => { asked++; return false; }, resolvesItself: () => { asked++; return false; } });
  check("the spell pipeline is not consulted for a lone attack", asked, 0);
}

console.log("");
console.log(pass + " passed, " + fail + " failed");
process.exitCode = fail ? 1 : 0;
