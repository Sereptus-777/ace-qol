// ─── Does the reaction reset reach the creatures on the board? ──────────────
//
// ⚠️🔴 THE BUG THIS EXISTS FOR. Johnny, mid-session on 2026-09-06: *"I need to
// reset the reactions on every token on the board."* He needed a console
// snippet because ACE's own bulk reset could not do it. It walked `game.actors`
// and nothing else.
//
// An unlinked token does not use its world actor. It carries an ActorDelta, and
// `token.actor` is a synthetic built from base merged with delta, so a flag set
// through it is stored on the DELTA. `game.actors` never sees that. So the one
// routine written to guarantee a clean slate at world startup and at combat end
// cleared the PCs and left every unlinked NPC holding a spent reaction, through
// the end of the fight and through a reload.
//
// ⚠️ AND THE FIX MUST NOT COST A THOUSAND ACTORS. Reading `tokenDoc.actor`
// MATERIALISES the synthetic. Over every token in every scene that is thousands
// of constructions to discover almost none have the flag, so the stored delta
// is read first and the actor is only built for the ones that say yes. The stub
// below FAILS THE TEST if the loop touches the actor of a token whose delta is
// clean, because a correct answer bought at that price is the scene-switch lag
// he is already chasing.
//
// Run:  node tools/reaction-reset-selftest.mjs
globalThis.canvas = { grid: { size: 100, distance: 5 }, ready: false,
  scene: { grid: { distance: 5, units: "ft" }, name: "test", id: "s1" },
  tokens: { placeables: [] } };
globalThis.Hooks = { on: () => {}, once: () => {}, off: () => {}, callAll: () => {} };
globalThis.CONFIG = { DND5E: {}, statusEffects: [], Canvas: { polygonBackends: {} } };
globalThis.ui = { notifications: { info: () => {}, warn: () => {}, error: () => {} } };
class _App { static DEFAULT_OPTIONS = {}; constructor() {} render() {} close() {} }
globalThis.foundry = {
  utils: { escapeHTML: (s) => String(s), deepClone: (o) => o, randomID: () => "id",
           mergeObject: (a, b) => ({ ...a, ...b }) },
  applications: { api: { ApplicationV2: _App, DialogV2: { wait: async () => null },
                         HandlebarsApplicationMixin: (C) => C },
                  ux: { TextEditor: { implementation: { enrichHTML: async (h) => h } } },
                  apps: {}, handlebars: {} },
};
globalThis.ChatMessage = { create: async () => {}, getSpeaker: () => ({}) };
globalThis.CONST = { ACTIVE_EFFECT_MODES: { ADD: 2 } };
globalThis.game = { combat: null, time: { worldTime: 0 }, ready: false,
  settings: { get: () => undefined, register: () => {} },
  user: { isGM: true }, users: [], actors: [], scenes: [],
  i18n: { localize: (k) => k } };

const NS = "ace-qol", FLAG = "reactionUsed";

let pass = 0, fail = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log((ok ? "  ok   " : "  FAIL ") + String(label).padEnd(60)
    + "got " + JSON.stringify(got) + ", want " + JSON.stringify(want));
};

// ── The smallest thing that behaves like an actor for flag purposes ──
const makeActor = (name, uuid, used) => {
  const flags = used ? { [NS]: { [FLAG]: true } } : {};
  return {
    name, uuid, flags,
    getFlag: (ns, key) => flags?.[ns]?.[key],
    unsetFlag: async (ns, key) => { delete flags?.[ns]?.[key]; },
  };
};

// A token whose synthetic actor is built ON ACCESS, and which records that it
// was asked. That access is the cost this fix must not pay in bulk.
const makeUnlinked = (name, sceneName, used) => {
  const t = {
    name, isLinked: false, built: 0,
    _source: { delta: { flags: used ? { [NS]: { [FLAG]: true } } : {} } },
    _actor: null,
  };
  Object.defineProperty(t, "actor", { get() {
    t.built += 1;
    // ⚠️ The synthetic is base MERGED WITH delta, so it reports the flag the
    // delta holds, and its unset writes back to the delta.
    t._actor ??= {
      name, uuid: `Scene.${sceneName}.Token.${name}`,
      getFlag: (ns, key) => t._source.delta.flags?.[ns]?.[key],
      unsetFlag: async (ns, key) => { delete t._source.delta.flags?.[ns]?.[key]; },
    };
    return t._actor;
  } });
  return t;
};

const { ReactionEngine } = await import(
  "file:///D:/FoundryVTT/Data/modules/ace-qol/scripts/reaction-engine.mjs");
const engine = new ReactionEngine();

console.log("\nTHE CREATURE ON THE BOARD IS THE ONE THAT HAD THE REACTION");
{
  const pc = makeActor("Virric", "Actor.pc1", true);
  const base = makeActor("Shadow", "Actor.npc1", false);
  const wolf = makeUnlinked("Shadow Wolf", "Barovia", true);
  const quiet = makeUnlinked("Bystander", "Barovia", false);
  game.actors = [pc, base];
  game.scenes = [{ name: "Barovia", tokens: [wolf, quiet] }];

  await engine._resetAllReactionFlags("self-test");

  check("the PC flag is cleared", pc.getFlag(NS, FLAG), undefined);
  check("the unlinked token on the board is cleared too",
    wolf._source.delta.flags?.[NS]?.[FLAG], undefined);
  check("a token that never used its reaction is left alone",
    quiet._source.delta.flags?.[NS]?.[FLAG], undefined);
  // ⚠️🔴 THE COST GUARD. Building the synthetic for every token in the world is
  // the wrong way to get the right answer.
  check("the clean token's actor was never built", quiet.built, 0);
  check("and the dirty one was built exactly once", wolf.built, 1);
}

console.log("\nEVERY SCENE, NOT JUST THE ONE HE IS LOOKING AT");
{
  // A fight that ended on a scene he has since left is precisely the state
  // this routine exists to clean up.
  const away = makeUnlinked("Lich", "Amber Temple", true);
  game.actors = [];
  game.scenes = [{ name: "Barovia", tokens: [] }, { name: "Amber Temple", tokens: [away] }];

  await engine._resetAllReactionFlags("self-test");
  check("a token on an unviewed scene is cleared",
    away._source.delta.flags?.[NS]?.[FLAG], undefined);
}

console.log("\nONE ACTOR IS ONE WRITE, HOWEVER MANY TOKENS IT HAS");
{
  const shared = makeActor("Bandit", "Actor.bandit", true);
  let unsets = 0;
  const realUnset = shared.unsetFlag;
  shared.unsetFlag = async (...a) => { unsets += 1; return realUnset(...a); };
  const linked = (n) => ({ name: n, isLinked: true, _source: { delta: {} },
    get actor() { throw new Error("a linked token must not be materialised here"); } });
  game.actors = [shared];
  game.scenes = [{ name: "Barovia", tokens: [linked("Bandit A"), linked("Bandit B")] }];

  await engine._resetAllReactionFlags("self-test");
  check("the shared actor is unset once, not once per token", unsets, 1);
}

console.log("\nA CREATURE WHOSE FLAG CAME FROM ITS BASE IS STILL CLEARED");
{
  // ⚠️ The world-actor pass runs FIRST on purpose: a synthetic inherits its
  // base flags, so clearing the base removes the inherited one and the token
  // pass is left with only genuinely token-local flags to find.
  const base = makeActor("Ghoul", "Actor.ghoul", true);
  const tok = makeUnlinked("Ghoul", "Barovia", false);
  game.actors = [base];
  game.scenes = [{ name: "Barovia", tokens: [tok] }];

  await engine._resetAllReactionFlags("self-test");
  check("the base actor is cleared", base.getFlag(NS, FLAG), undefined);
  check("so the token inherits nothing and is never built", tok.built, 0);
}

console.log("\nA CREATURE WE CANNOT WRITE TO DOES NOT STOP THE SWEEP");
{
  const denied = { name: "Foreign", uuid: "Actor.foreign",
    getFlag: () => true,
    unsetFlag: async () => { throw new Error("User lacks permission to update"); } };
  const after = makeActor("Deeds", "Actor.deeds", true);
  game.actors = [denied, after];
  game.scenes = [];

  await engine._resetAllReactionFlags("self-test");
  check("the actor after the refusal is still cleared", after.getFlag(NS, FLAG), undefined);
}

/* ── ONE TYPE, ONE EFFECT, AND IT COMES OFF AT HER TURN ──────────────────── */
// His table, 2026-09-19: four "Absorb Elements (fire)" stacked on Aryel, each
// with a round left. "One type, one effect. A second absorb of fire refreshes
// that effect ... If her reaction is already spent this round, do not offer
// Absorb Elements again. When her turn starts, that effect comes off once."
console.log("\nABSORB ELEMENTS: ONE FIRE EFFECT, NOT FOUR");
{
  // A creature whose effects behave like Foundry's: a collection with create and delete.
  const makeWithEffects = (name) => {
    const effects = [];
    let n = 0;
    const a = {
      name, uuid: `Actor.${name}`, flags: {},
      effects,
      getFlag: (ns, k) => a.flags?.[ns]?.[k],
      setFlag: async (ns, k, v) => { (a.flags[ns] ??= {})[k] = v; },
      unsetFlag: async (ns, k) => { delete a.flags?.[ns]?.[k]; },
      createEmbeddedDocuments: async (type, rows) => {
        for (const r of rows) {
          const e = { ...r, id: `e${++n}`, update: async (u) => Object.assign(e, u) };
          effects.push(e);
        }
        return rows;
      },
      deleteEmbeddedDocuments: async (type, ids) => {
        for (const id of ids) {
          const i = effects.findIndex(e => e.id === id);
          if (i >= 0) effects.splice(i, 1);
        }
        return ids;
      },
    };
    return a;
  };
  const fireNames = (a) => a.effects.filter(e => e.flags?.[NS]?.reaction === "absorbElements").map(e => e.name);

  game.combat = { round: 3, turn: 1 };
  const aryel = makeWithEffects("Aryel");
  await engine._applyAbsorbElementsEffect(aryel, "fire");
  await engine._applyAbsorbElementsEffect(aryel, "fire");
  await engine._applyAbsorbElementsEffect(aryel, "fire");
  check("three absorbs of fire leave one effect", fireNames(aryel), ["Absorb Elements (fire)"]);
  game.combat = { round: 5, turn: 0 };
  await engine._applyAbsorbElementsEffect(aryel, "fire");
  check("the fourth refreshes that one to this round", aryel.effects[0].duration?.startRound, 5);
  await engine._applyAbsorbElementsEffect(aryel, "cold");
  check("a different element gets its own effect",
    fireNames(aryel), ["Absorb Elements (fire)", "Absorb Elements (cold)"]);

  // Four already on her sheet (what he was looking at) all come off at her turn.
  const stacked = makeWithEffects("Aryel (already stacked)");
  for (let i = 0; i < 4; i++) {
    stacked.effects.push({ id: `old${i}`, name: "Absorb Elements (fire)",
      flags: { [NS]: { type: "reactionEffect", reaction: "absorbElements", damageType: "fire", autoRemove: true } } });
  }
  stacked.effects.push({ id: "conc", name: "Concentrating: Globe of Invulnerability", flags: {} });
  const came = await ReactionEngine._clearReactionEffects(stacked);
  check("at the start of her turn every one of them comes off", came, 4);
  check("and nothing else on her does", stacked.effects.map(e => e.name),
    ["Concentrating: Globe of Invulnerability"]);

  // A box already open for her IS her reaction: she is not asked twice.
  const busy = makeWithEffects("Aryel (deciding)");
  check("with no box open her reaction is free", engine._hasUsedReaction(busy), false);
  const claim = ReactionEngine._claimDeciding(busy);
  check("while her box is open her reaction is already claimed", engine._hasUsedReaction(busy), true);
  ReactionEngine._releaseDeciding(claim);
  check("and free again once she has answered it", engine._hasUsedReaction(busy), false);
  game.combat = null;
}

console.log("");
console.log(pass + " passed, " + fail + " failed");
if (fail) process.exitCode = 1;
