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

console.log("");
console.log(pass + " passed, " + fail + " failed");
if (fail) process.exitCode = 1;
