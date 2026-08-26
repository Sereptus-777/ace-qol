// ─── A caster is not asked which piston to fire ──────────────────────────────
//
// ⚠️🔴 WHAT THIS IS PROVING. dnd5e renders a button for EVERY activity on an
// item, including the internal ones a spell fires at itself. ACE showed all of
// them. Johnny's imported Magic Missile has four, and every single cast put
// this in front of him:
//
//     Damage  ·  Use  ·  Magic Missile Bolt  ·  Magic Missile Bolt: Flat
//
// The two "Bolt" rows carry activation type "special" — dnd5e's own marker for
// something that is not an action a person takes. They are the machinery that
// throws each dart. Asking the caster to choose one is asking which piston he
// would like to fire.
//
// The activities below are lifted verbatim from his world database, including
// the duplicate pair that the importer left behind. Tidy invented examples are
// exactly what let this ship.
//
// ⚠️ THE RULE IS ASKED OF THE SYSTEM, NOT KEPT IN A LIST. dnd5e already marks
// every non-action activation type. A hand-maintained copy here would go stale
// the first time the system adds a category, and a stale filter would start
// hiding real choices — worse than showing too many.
//
// Run:  node tools/activity-picker-check.mjs
const NL = String.fromCharCode(10);

// dnd5e's own activationTypes table, the passive flags exactly as it ships.
const CONFIG = {
  DND5E: {
    activityActivationTypes: {
      action: {}, bonus: {}, reaction: {}, minute: {}, hour: {}, day: {},
      longRest: { passive: true },
      shortRest: { passive: true },
      encounter: { passive: true },
      turnStart: { passive: true },
      turnEnd: { passive: true },
      special: { passive: true },
    },
  },
};

// The rule, as the shipped code applies it.
const isMachinery = (a) => {
  try { return !!CONFIG.DND5E?.activityActivationTypes?.[a?.activation?.type]?.passive; }
  catch (_) { return false; }
};
const filter = (offered) => {
  const real = offered.filter(a => !isMachinery(a));
  return real.length ? real : offered;
};

// Johnny's actual Magic Missile, read out of his world database.
const MAGIC_MISSILE = [
  { id: "damageMagicMissi", type: "damage",  name: null,
    activation: { type: "action" },  consumption: { spellSlot: true } },
  { id: "dnd5eactivity000", type: "utility", name: "",
    activation: { type: "action" },  consumption: { spellSlot: true } },
  { id: "zHpeqUnoKjOjo5aN", type: "damage",  name: "Magic Missile Bolt",
    activation: { type: "special" }, consumption: { spellSlot: false } },
  { id: "VH7HwxXvnFU22CxV", type: "damage",  name: "Magic Missile Bolt: Flat",
    activation: { type: "special" }, consumption: { spellSlot: false } },
];

const CASES = [
  {
    title: "Magic Missile — the four Johnny was shown every cast",
    offered: MAGIC_MISSILE,
    wantIds: ["damageMagicMissi", "dnd5eactivity000"],
    why: "the two 'special' bolts are machinery the spell fires itself",
  },
  {
    title: "A weapon with an attack and a turn-start rider",
    offered: [
      { id: "atk", type: "attack", activation: { type: "action" } },
      { id: "rid", type: "damage", activation: { type: "turnStart" } },
    ],
    wantIds: ["atk"],
    autoUse: true,
    why: "one real activity left, so it fires without a dialog",
  },
  {
    title: "A staff that can be swung OR channelled — a genuine choice",
    offered: [
      { id: "melee", type: "attack", activation: { type: "action" } },
      { id: "cast",  type: "save",   activation: { type: "action" } },
    ],
    wantIds: ["melee", "cast"],
    why: "both cost an action; the caster must choose and always could",
  },
  {
    title: "An item whose activities are ALL passive",
    offered: [
      { id: "a", type: "damage", activation: { type: "special" } },
      { id: "b", type: "damage", activation: { type: "turnEnd" } },
    ],
    wantIds: ["a", "b"],
    why: "filtering to nothing would swallow the press, so the list stands",
  },
  {
    title: "An activity with no activation block at all",
    offered: [
      { id: "bare", type: "utility" },
      { id: "act",  type: "attack", activation: { type: "action" } },
    ],
    wantIds: ["bare", "act"],
    why: "unknown is not the same as passive — never hide what we cannot classify",
  },
];

let ok = true;
console.log("");
console.log("ACTIVITY PICKER — WHAT DOES THE CASTER ACTUALLY GET ASKED?");
console.log("=".repeat(78));

for (const c of CASES) {
  const got = filter(c.offered).map(a => a.id);
  const same = got.length === c.wantIds.length && got.every((id, i) => id === c.wantIds[i]);
  const autoUse = got.length === 1 && c.offered.length > 1;
  const autoOk = c.autoUse === undefined || c.autoUse === autoUse;
  const pass = same && autoOk;
  if (!pass) ok = false;
  console.log("");
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${c.title}`);
  console.log(`        ${c.offered.length} offered -> ${got.length} shown: ${got.join(", ")}`);
  console.log(`        ${autoUse ? "no dialog, it just fires" : "the picker opens"}`);
  console.log(`        ${c.why}`);
  if (!same) console.log(`        EXPECTED ${c.wantIds.join(", ")}`);
}

// The duplicate warning: two action-cost, slot-spending activities on one item.
const casters = filter(MAGIC_MISSILE)
  .filter(a => a.consumption?.spellSlot && a.activation?.type === "action");
console.log("");
console.log("=".repeat(78));
const dupeSpotted = casters.length > 1;
if (!dupeSpotted) ok = false;
console.log(`  ${dupeSpotted ? "PASS" : "FAIL"}  the leftover duplicate is still detected and named`);
console.log(`        ${casters.length} activities cost an action AND spend a slot`);
console.log(`        ACE cannot guess which he meant, so it says so instead of hiding it`);

console.log("");
console.log(ok
  ? "ALL PASS — machinery hidden, single choices fired, real choices kept."
  : "FAILURES ABOVE — a caster is being asked the wrong question." + NL);
process.exit(ok ? 0 : 1);
