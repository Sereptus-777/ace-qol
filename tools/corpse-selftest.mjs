// ─── A corpse is not a threat, and a corpse is not cover ────────────────────
//
// ⚠️🔴 THE BUG THIS EXISTS FOR. Johnny, 2026-09-06: *"I had a guy trying to
// throw a spear across a dead guy onto a live guy. It said he had disadvantage
// because the fucking dead guy was in his way, but obviously, if he's dead,
// he's not in his way."* And a minute later: *"and the same goes for cover.
// He's not covered or anything."*
//
// ⚠️ IT IS THE DEAD DRAGON AGAIN, FOUR DAYS LATER. On 2026-09-02 a dead shadow
// dragon attacked a player and hit, because the check asked
// `statuses.has("dead")` and ACE's own death pipeline REMOVES that status so
// the skull does not stack on the corpse artwork. That lesson was written down
// and exactly one site was converted. The positional rules — ranged-in-melee,
// Pack Tactics, Aura of Protection — kept their own status lists, and the cover
// engine asked the hit points but never the flag.
//
// ⚠️ SO THE FLAG CASE IS THE ONE THAT MATTERS MOST HERE. A body at zero hit
// points was already handled in some places. A body ACE flagged as dead whose
// token still reports hit points — a swapped-in corpse, a linked actor healed
// back at the sheet — was handled in none of them.
//
// Run:  node tools/corpse-selftest.mjs
globalThis.Hooks = { on: () => {}, once: () => {}, off: () => {}, callAll: () => {} };
globalThis.document = { querySelectorAll: () => [], querySelector: () => null };
globalThis.CONFIG = { DND5E: { abilities: {}, skills: {} }, statusEffects: [],
  Canvas: { polygonBackends: { move: { testCollision: () => false } } } };
globalThis.ui = { notifications: { info: () => {}, warn: () => {}, error: () => {} } };
class _App { static DEFAULT_OPTIONS = {}; constructor() {} render() {} close() {} }
globalThis.foundry = {
  utils: { escapeHTML: (s) => String(s), deepClone: (o) => o, randomID: () => "id",
           mergeObject: (a, b) => ({ ...a, ...b }), getDocumentClass: () => null },
  applications: { api: { ApplicationV2: _App, DialogV2: { wait: async () => null },
                         HandlebarsApplicationMixin: (C) => C },
                  ux: { TextEditor: { implementation: { enrichHTML: async (h) => h } } },
                  apps: {}, handlebars: {} },
  canvas: { geometry: { Ray: class { constructor(a, b) {
    this.A = a; this.B = b; this.distance = Math.hypot(b.x - a.x, b.y - a.y); } } } },
};
globalThis.ChatMessage = { create: async () => {}, getSpeaker: () => ({}) };
globalThis.CONST = { ACTIVE_EFFECT_MODES: { ADD: 2 } };
globalThis.canvas = { ready: true, scene: { id: "s1", name: "Barovia", grid: { distance: 5 } },
  grid: { size: 100, distance: 5 }, tokens: { placeables: [], controlled: [] },
  walls: { objects: { children: [] } } };
globalThis.game = { combat: null, ready: true, time: { worldTime: 0 },
  settings: { get: () => true, set: async () => {}, register: () => {} },
  user: { isGM: true }, users: [], actors: [], scenes: [], i18n: { localize: (k) => k } };

let pass = 0, fail = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log((ok ? "  ok   " : "  FAIL ") + String(label).padEnd(62)
    + "got " + JSON.stringify(got) + ", want " + JSON.stringify(want));
};

// ── Tokens. Grid is 100px, a square is 5 feet, so 100px apart is adjacent. ──
let n = 0;
const tok = (name, gx, gy, {
  hp = 10, foe = false, statuses = [], flagDead = false, size = 1, type = "npc",
} = {}) => {
  const id = `t${++n}`;
  const actor = {
    id: `a${n}`, name, type,
    system: { attributes: { hp: { value: hp } } },
    statuses: new Set(statuses),
    items: [], effects: [],
    getActiveTokens: () => [placeable],
    getFlag: () => undefined,
  };
  const doc = {
    id, name, x: gx * 100, y: gy * 100, width: size, height: size,
    disposition: foe ? -1 : 1, elevation: 0, hidden: false,
    flags: flagDead ? { "ace-qol": { isDead: true } } : {},
    actor,
  };
  const placeable = { id, name, document: doc, actor, x: doc.x, y: doc.y,
                      w: size * 100, h: size * 100, inCombat: false, scene: { id: "s1" } };
  doc.object = placeable;
  return placeable;
};
const place = (...tokens) => { canvas.tokens.placeables = tokens; };

const { isDead, isOutOfTheFight, deathState } = await import(
  "file:///D:/FoundryVTT/Data/modules/ace-qol/scripts/is-down.mjs");

console.log("\nTHE READER ITSELF");
{
  check("a live creature is not dead", isDead(tok("Live", 0, 0)), false);
  check("nought hit points is dead", isDead(tok("Body", 0, 0, { hp: 0 })), true);
  // ⚠️🔴 THE CASE EVERY OLD SITE MISSED.
  check("ACE's own flag is dead even with hit points showing",
    isDead(tok("Corpse", 0, 0, { hp: 22, flagDead: true })), true);
  check("a PC at nought is worded as bleeding out, not dead",
    deathState(tok("Virric", 0, 0, { hp: 0, type: "character" })), "at 0 hit points");
  // ⚠️ A thing with no hit points at all is not a corpse.
  const vehicle = tok("Cart", 0, 0);
  vehicle.actor.system.attributes.hp.value = undefined;
  check("a creature with no hit points at all is not a corpse", isDead(vehicle), false);
  check("a paralysed creature is out of the fight",
    isOutOfTheFight(tok("Held", 0, 0, { statuses: ["paralyzed"] })), true);
  // ⚠️ Blinded is NOT out of the fight; it is the other half of the ranged rule.
  check("a blinded creature is still in the fight",
    isOutOfTheFight(tok("Blind", 0, 0, { statuses: ["blinded"] })), false);
}

const { CombatState } = await import(
  "file:///D:/FoundryVTT/Data/modules/ace-qol/scripts/combat-state.mjs");

console.log("\nTHROWING A SPEAR OVER A BODY");
{
  const archer = tok("Fraxis", 0, 0);
  const corpse = tok("Dead Guy", 1, 0, { foe: true, hp: 0 });
  place(archer, corpse);
  check("a corpse beside you does not spoil the throw",
    CombatState._hasHostileWithinReach(archer.actor, 5), false);
}
{
  const archer = tok("Fraxis", 0, 0);
  const swapped = tok("Swapped Corpse", 1, 0, { foe: true, hp: 22, flagDead: true });
  place(archer, swapped);
  check("nor does a flagged body that still shows hit points",
    CombatState._hasHostileWithinReach(archer.actor, 5), false);
}
{
  // ⚠️🔴 THE ONE THAT MUST NOT BREAK. Take this away and every archer in the
  // game shoots out of a melee for free.
  const archer = tok("Fraxis", 0, 0);
  const orc = tok("Orc", 1, 0, { foe: true });
  place(archer, orc);
  check("a LIVE enemy beside you still gives disadvantage",
    CombatState._hasHostileWithinReach(archer.actor, 5), true);
}
{
  const archer = tok("Fraxis", 0, 0);
  const blind = tok("Blinded Orc", 1, 0, { foe: true, statuses: ["blinded"] });
  place(archer, blind);
  // ⚠️ THE OTHER HALF OF THE SAME RAW CLAUSE, and it is separate from being
  // out of the fight on purpose: a blinded enemy is still swinging at you, it
  // just cannot see you, so it does not spoil your aim.
  check("an enemy who cannot see you does not spoil your aim",
    CombatState._hasHostileWithinReach(archer.actor, 5), false);
}
{
  const archer = tok("Fraxis", 0, 0);
  const far = tok("Orc", 2, 0, { foe: true });
  place(archer, far);
  check("an enemy ten feet away is not in your face",
    CombatState._hasHostileWithinReach(archer.actor, 5), false);
}
{
  // ⚠️ RAW: the creature you are shooting AT counts. The old second copy of
  // this rule excluded it, which is backwards.
  const archer = tok("Fraxis", 0, 0);
  const orc = tok("Orc", 1, 0, { foe: true });
  place(archer, orc);
  check("the target itself counts, and the two helpers now agree",
    CombatState._isHostileNearAttacker(archer.actor, orc, 5), true);
}

console.log("\nA BODY IS NOT AN ALLY EITHER");
{
  const rogue = tok("Jeth", 0, 0);
  const target = tok("Lord Soth", 2, 0, { foe: true });
  const deadFriend = tok("Dorian", 3, 0, { hp: 0 });
  place(rogue, target, deadFriend);
  check("a dead ally beside the target grants nothing",
    CombatState._isAllyNearTarget(rogue.actor, target, 5), false);
  const flagged = tok("Dorian", 3, 0, { hp: 14, flagDead: true });
  place(rogue, target, flagged);
  check("nor does a flagged body still showing hit points",
    CombatState._isAllyNearTarget(rogue.actor, target, 5), false);
  const alive = tok("Deeds", 3, 0);
  place(rogue, target, alive);
  check("a LIVE ally beside the target still counts",
    CombatState._isAllyNearTarget(rogue.actor, target, 5), true);
}

const { CoverEngine } = await import(
  "file:///D:/FoundryVTT/Data/modules/ace-qol/scripts/cover-engine.mjs");

console.log("\nAND A BODY IS NOT COVER");
{
  const archer = tok("Fraxis", 0, 0);
  const target = tok("Live Guy", 4, 0, { foe: true });
  const between = tok("In The Way", 2, 0, { foe: true });
  place(archer, target, between);
  check("a living creature in the line still gives half cover",
    CoverEngine._checkCreatureCover(archer, target) > 0, true);

  const body = tok("Dead Guy", 2, 0, { foe: true, hp: 0 });
  place(archer, target, body);
  check("a corpse in the line gives none",
    CoverEngine._checkCreatureCover(archer, target), 0);

  const swapped = tok("Swapped Corpse", 2, 0, { foe: true, hp: 22, flagDead: true });
  place(archer, target, swapped);
  check("nor does a flagged body that still shows hit points",
    CoverEngine._checkCreatureCover(archer, target), 0);

  // ⚠️ THE OLD `?? 0` READ "NO HIT POINTS AT ALL" AS DEAD, so a creature whose
  // sheet has no hp block silently stopped being cover.
  const noHp = tok("Animated Armour", 2, 0, { foe: true });
  noHp.actor.system.attributes.hp.value = undefined;
  place(archer, target, noHp);
  check("a creature with no hit-point block is still cover",
    CoverEngine._checkCreatureCover(archer, target) > 0, true);
}

// ─── The layer a body sits on, and the badge that sat on top of it ─────────
//
// ⚠️ THESE READ THE SOURCE, AND THAT IS THE RIGHT TOOL FOR THEM. Draw order
// and a CSS property are not things a stubbed canvas can prove — what can go
// wrong is somebody editing the line back out, which is exactly what a source
// assertion catches. Same reasoning as hook-check and card-wrap-check.
import { readFileSync } from "node:fs";
const src = (f) => readFileSync(`D:/FoundryVTT/Data/modules/ace-qol/scripts/${f}`, "utf8");

console.log("\nA BODY GOES UNDER THE LIVING");
{
  const death = src("death-pipeline.mjs");
  const m = death.match(/const CORPSE_SORT = (-?\d+);/);
  check("the corpse layer is defined", !!m, true);
  // ⚠️🔴 IT MUST BE NEGATIVE. A living token defaults to sort 0, so anything
  // at 0 or above leaves the body on top and the whole point is lost.
  check("and it is below where the living sit", Number(m?.[1]) < 0, true);
  check("the death update actually applies it",
    /sort: CORPSE_SORT/.test(death), true);
  // ⚠️🔴 `sort`, NEVER `elevation`. Elevation is a rules input in this suite
  // — areas have height — so dropping a body's elevation would take it out of
  // every template and reach check on the board.
  check("and it never touches elevation to do it",
    /elevation:\s*-/.test(death), false);
  check("the snapshot remembers the layer it came from",
    /sort:\s+tokenDoc\.sort/.test(death), true);
  check("and revive puts it back",
    /tokenUpdate\.sort = Number\.isFinite\(snap\.sort\)/.test(src("ace-qol.mjs")), true);
}

console.log("\nAND THE LOOT BADGE DOES NOT EAT THE CLICK");
{
  const loot = src("lootable-tile.mjs");
  // The badge sits dead centre on the body at 75% of a square. Interactive,
  // it owns every gesture that starts in the middle of a token: select, drag,
  // and the reticle a player needs to heal a downed friend.
  check("the badge declares pointer-events: none",
    /pointer-events: none;/.test(loot), true);
  check("and it is not left interactive anywhere",
    /pointer-events: auto;/.test(loot), false);
  check("and the badge no longer binds its own click",
    /icon\.addEventListener\("click"/.test(loot), false);
  // ⚠️ The capability is not lost: right-click on the body is the primary
  // path and predates the badge.
  check("right-click on the body is still wired",
    /_openLootDialog/.test(loot), true);
}

console.log("\nA PLAYER AIMS AT A BODY WITHOUT BEING ASKED");
{
  const lock = src("dead-token-lock.mjs");
  check("the confirm is gated to the GM",
    /game\.user\?\.isGM[\s\S]*?&& !context\?\.aceDeadTargetConfirmed/.test(lock), true);
}

console.log("");
console.log(pass + " passed, " + fail + " failed");
if (fail) process.exitCode = 1;
