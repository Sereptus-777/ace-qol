// ─── Does every creature see what its statblock says? ───────────────────────
//
// Johnny, 2026-09-07: *"I want every token in my sidebar to be properly set up
// and working... their sight working and at a proper distance."*
//
// A dnd5e statblock says "darkvision 120 ft". That is a number on the ACTOR.
// Whether the TOKEN can see 120 feet in the dark is an entirely separate set of
// fields on the prototype, and nothing keeps the two in step. Imported monsters
// routinely have the sense written down and a token that sees nothing.
//
// ⚠️🔴 THE ASSERTIONS THAT MATTER ARE THE ONES ABOUT NOT WRITING. The night
// before this was written, a sweep of mine overwrote 1,073 documents and kept
// no record of what it replaced. So: the audit must change nothing, the repair
// must stash the old values in the SAME update, and undo must put them back
// exactly.
//
// Run:  node tools/vision-audit-selftest.mjs
globalThis.Hooks = { on: () => {}, once: () => {}, off: () => {}, callAll: () => {} };
globalThis.document = { querySelectorAll: () => [], querySelector: () => null };
globalThis.CONFIG = { DND5E: {}, statusEffects: [], Canvas: { polygonBackends: {} } };
globalThis.ui = { notifications: { info: () => {}, warn: () => {}, error: () => {} } };
globalThis.foundry = {
  utils: { deepClone: (o) => JSON.parse(JSON.stringify(o ?? null)),
           escapeHTML: (s) => String(s), mergeObject: (a, b) => ({ ...a, ...b }) },
  applications: { api: {}, ux: {}, apps: {}, handlebars: {} },
};
globalThis.canvas = { ready: true, scene: { id: "s1" }, tokens: { placeables: [] } };
globalThis.game = { ready: true, user: { isGM: true }, actors: [], scenes: [],
  settings: { get: () => true, register: () => {} } };

let pass = 0, fail = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log((ok ? "  ok   " : "  FAIL ") + String(label).padEnd(60)
    + "got " + JSON.stringify(got) + ", want " + JSON.stringify(want));
};

const { VisionAudit } = await import(
  "file:///D:/FoundryVTT/Data/modules/ace-qol/scripts/vision-audit.mjs");

// ⚠️🔴 dnd5e 5.3 MOVED THESE. `senses.darkvision` became
// `senses.ranges.darkvision`; the old path still answers through a shim that
// logs a deprecation on EVERY read, so auditing two thousand actors printed
// four warnings apiece. The harness builds BOTH shapes so the reader is proven
// against a migrated world and an unmigrated one.
const mk = (name, senses = {}, proto = {}, { legacy = false } = {}) => {
  const shaped = legacy ? { ...senses } : { ranges: { ...senses } };
  const actor = {
    name, type: "npc",
    system: { attributes: { senses: shaped } },
    prototypeToken: {
      sight: { enabled: false, range: 0, visionMode: "basic" },
      detectionModes: [],
      flags: {},
      ...proto,
    },
    updates: [],
    async update(data) {
      this.updates.push(data);
      const p = this.prototypeToken;
      if ("prototypeToken.sight.enabled" in data) p.sight.enabled = data["prototypeToken.sight.enabled"];
      if ("prototypeToken.sight.range" in data) p.sight.range = data["prototypeToken.sight.range"];
      if ("prototypeToken.sight.visionMode" in data) p.sight.visionMode = data["prototypeToken.sight.visionMode"];
      if ("prototypeToken.detectionModes" in data) p.detectionModes = data["prototypeToken.detectionModes"];
      for (const [k, v] of Object.entries(data)) {
        if (k.endsWith("visionBefore")) (p.flags["ace-qol"] ??= {}).visionBefore = v;
        if (k.includes("-=visionBefore")) delete p.flags["ace-qol"]?.visionBefore;
        if (k === "prototypeToken.sight" && v) p.sight = v;
      }
    },
  };
  return actor;
};

console.log("\nWHAT THE STATBLOCK ASKS FOR");
{
  const drow = mk("Drow", { darkvision: 120 });
  const want = VisionAudit.expected(drow);
  check("darkvision becomes the sight range", want.range, 120);
  check("and the darkvision vision mode", want.visionMode, "darkvision");

  const grimlock = mk("Grimlock", { blindsight: 30 });
  check("blindsight becomes a detection mode",
    VisionAudit.expected(grimlock).detectionModes, [{ id: "blindsight", enabled: true, range: 30 }]);

  const worm = mk("Purple Worm", { blindsight: 30, tremorsense: 60 });
  check("tremorsense uses Foundry's feelTremor",
    VisionAudit.expected(worm).detectionModes.map(m => m.id).sort(), ["blindsight", "feelTremor"]);

  const solar = mk("Solar", { truesight: 120, darkvision: 120 });
  check("truesight uses seeAll",
    VisionAudit.expected(solar).detectionModes.map(m => m.id), ["seeAll"]);
}

console.log("\nA CREATURE WITH NO DARKVISION IS NOT BROKEN");
{
  // ⚠️🔴 Sight range 0 on basic means "sees by light like everyone else", which
  // is correct for most humanoids. Reporting them would bury the real faults in
  // two thousand rows.
  const guard = mk("Guard", {}, { sight: { enabled: true, range: 0, visionMode: "basic" } });
  check("no faults", VisionAudit.faultsFor(guard), []);
}

console.log("\nWHAT IT CALLS A FAULT");
{
  const off = mk("Shadow", { darkvision: 60 },
    { sight: { enabled: false, range: 60, visionMode: "darkvision" } });
  check("sight switched off is named first",
    VisionAudit.faultsFor(off)[0], "sight is switched off");

  const short = mk("Ghoul", { darkvision: 60 },
    { sight: { enabled: true, range: 30, visionMode: "darkvision" } });
  check("a wrong range quotes both numbers",
    /30 ft, the statblock says 60 ft/.test(VisionAudit.faultsFor(short)[0]), true);

  const wrongMode = mk("Ghast", { darkvision: 60 },
    { sight: { enabled: true, range: 60, visionMode: "basic" } });
  check("the wrong vision mode is caught",
    /not darkvision/.test(VisionAudit.faultsFor(wrongMode)[0]), true);

  const noMode = mk("Grimlock", { blindsight: 30 },
    { sight: { enabled: true, range: 0, visionMode: "basic" } });
  check("a sense the token cannot use is caught",
    /blindsight 30 ft is on the sheet but the token cannot use it/
      .test(VisionAudit.faultsFor(noMode)[0]), true);
}

console.log("\nTHE AUDIT CHANGES NOTHING");
{
  // ⚠️🔴 THE ONE THAT MATTERS. It is a report. If it ever writes, it stops
  // being safe to run and he stops running it.
  const a = mk("Drow", { darkvision: 120 });
  const before = JSON.stringify(a.prototypeToken);
  game.actors = [a];
  const rows = VisionAudit.audit({ log: false });
  check("one creature reported", rows.length, 1);
  check("and nothing was written", JSON.stringify(a.prototypeToken), before);
  check("no update was even attempted", a.updates.length, 0);
}

console.log("\nREPAIR WRITES THE STATBLOCK'S OWN NUMBERS");
{
  const a = mk("Drow", { darkvision: 120 });
  game.actors = [a];
  await VisionAudit.repair();
  check("sight is on", a.prototypeToken.sight.enabled, true);
  check("range matches the sheet", a.prototypeToken.sight.range, 120);
  check("mode is darkvision", a.prototypeToken.sight.visionMode, "darkvision");
  check("and it is clean afterwards", VisionAudit.faultsFor(a), []);
}

console.log("\nAND IT SAVES WHAT IT REPLACED, IN THE SAME UPDATE");
{
  // ⚠️🔴 IN THE SAME UPDATE. A second write to record the old value can fail on
  // its own and leave a change with no undo, which is exactly how 1,073
  // documents became unrecoverable.
  const a = mk("Ghoul", { darkvision: 60 });
  game.actors = [a];
  await VisionAudit.repair();
  const write = a.updates[0];
  check("one update, not two", a.updates.length, 1);
  check("the old values rode along with it",
    !!write["prototypeToken.flags.ace-qol.visionBefore"], true);
  check("and they are the real old values",
    write["prototypeToken.flags.ace-qol.visionBefore"].sight.enabled, false);

  await VisionAudit.undo();
  check("undo puts sight back off", a.prototypeToken.sight.enabled, false);
  check("and the record is cleared",
    a.prototypeToken.flags["ace-qol"]?.visionBefore, undefined);
}

console.log("\nA DRY RUN WRITES NOTHING AT ALL");
{
  const a = mk("Drow", { darkvision: 120 });
  game.actors = [a];
  const out = await VisionAudit.repair({ dryRun: true });
  check("it counts what it would do", out.wouldChange, 1);
  check("and changes nothing", a.updates.length, 0);
}

console.log("\nANOTHER MODULE'S DETECTION MODE IS NOT DELETED");
{
  // ⚠️ Replacing the whole array would quietly remove anything we did not put
  // there, and he would never connect the loss to this.
  const a = mk("Drow", { darkvision: 120 },
    { detectionModes: [{ id: "someOtherModule", enabled: true, range: 40 }] });
  game.actors = [a];
  await VisionAudit.repair();
  check("the foreign mode survived",
    a.prototypeToken.detectionModes.some(m => m.id === "someOtherModule"), true);
}

console.log("\nBOTH SHAPES OF THE SENSES FIELD");
{
  // The world he is running today is migrated. A world that is not must still
  // audit correctly rather than silently report every creature as blind.
  const modern = mk("Drow", { darkvision: 120 });
  check("the current shape reads", VisionAudit._sense(modern, "darkvision"), 120);

  const old = mk("Drow", { darkvision: 120 }, {}, { legacy: true });
  check("and the pre-5.3 shape still reads", VisionAudit._sense(old, "darkvision"), 120);

  // ⚠️ A sense the creature does not have must read as zero in both shapes,
  // not as undefined and not as NaN.
  check("a missing sense is zero", VisionAudit._sense(modern, "truesight"), 0);
  check("and zero in the old shape too", VisionAudit._sense(old, "truesight"), 0);
  check("an actor with no senses at all is zero",
    VisionAudit._sense({ system: { attributes: {} } }, "darkvision"), 0);
}

// ── THE VISION STAMP (his table, 2026-09-18) ─────────────────────────────────
// "Neferon's token is Basic Vision. The book is Truesight 120 ft." The Monster
// Manual's own arcanaloth ships with sight off, range 0, Basic Vision and no
// senses, under a sheet that says truesight 120; a drop gave exactly that.
class StubVisionMode {
  static LIGHTING_LEVELS = { DIM: 1, BRIGHT: 2 };
  static LIGHTING_VISIBILITY = { REQUIRED: 2 };
  constructor(cfg) { Object.assign(this, cfg); }
}
foundry.canvas = { perception: { VisionMode: StubVisionMode } };
CONFIG.Canvas.visionModes = { basic: {}, darkvision: {} };
const settingsStore = new Map();
game.settings = { get: (_m, k) => settingsStore.get(k), set: async (_m, k, v) => { settingsStore.set(k, v); return v; },
  register: (_m, k, o) => { if (!settingsStore.has(k)) settingsStore.set(k, o?.default); } };
const hooks = {};
globalThis.Hooks.on = (name, fn) => { (hooks[name] ??= []).push(fn); };
const GM = { id: "gm", isGM: true, name: "GM" };
game.user = GM;
game.users = Object.assign([GM], { activeGM: GM });

// The MM's arcanaloth as it comes out of the pack, and a token drawn from it.
const mmArcanaloth = () => mk("Arcanaloth", { truesight: 120 },
  { sight: { enabled: false, range: 0, angle: 360, visionMode: "basic" }, detectionModes: [] });
const tokenOf = (actor, id) => {
  const src = { sight: JSON.parse(JSON.stringify(actor.prototypeToken.sight)),
    detectionModes: JSON.parse(JSON.stringify(actor.prototypeToken.detectionModes)), flags: {} };
  return { id, name: actor.name, actor, actorId: actor.id, _source: src, sight: src.sight, detectionModes: src.detectionModes,
    flags: src.flags, updates: [],
    async update(data) {
      this.updates.push(data);
      if (data.sight) this.sight = this._source.sight = data.sight;
      if (data.detectionModes) this.detectionModes = this._source.detectionModes = data.detectionModes;
    } };
};

console.log("\nTHE TRUESIGHT VISION MODE");
{
  VisionAudit.registerAtInit();
  const mode = CONFIG.Canvas.visionModes.truesight;
  check("a Truesight vision mode is registered at init", !!mode && mode.id === "truesight", true);
  check("named with dnd5e's own word for it", mode?.label, "DND5E.SenseTruesight");
  check("in colour, unlike darkvision", mode?.vision?.defaults?.saturation, 0);
  check("seeing the dark as darkvision does", mode?.lighting?.levels?.[StubVisionMode.LIGHTING_LEVELS.DIM],
    StubVisionMode.LIGHTING_LEVELS.BRIGHT);
  check("and the pass marker is registered", settingsStore.has("visionPass"), true);
}

console.log("\nA DROPPED ARCANALOTH HAS TRUESIGHT 120, NOT BASIC VISION");
{
  const arc = mmArcanaloth();
  arc.id = "arc1";
  game.actors = Object.assign([arc], { get: (id) => (id === "arc1" ? arc : null) });
  const tok = tokenOf(arc, "t1");
  await VisionAudit.stampToken(tok);
  check("sight is on", tok.sight.enabled, true);
  check("it sees 120 feet", tok.sight.range, 120);
  check("in the Truesight vision mode", tok.sight.visionMode, "truesight");
  check("and truesight is on it at 120 feet", tok.detectionModes, [{ id: "seeAll", enabled: true, range: 120 }]);
  check("one update, with what it was riding along",
    tok.updates.length === 1 && tok.updates[0]["flags.ace-qol.visionBefore"]?.sight?.enabled === false, true);
  check("the sidebar actor's token is stamped too, so the next drop is right",
    [arc.prototypeToken.sight.enabled, arc.prototypeToken.sight.range, arc.prototypeToken.sight.visionMode,
      arc.prototypeToken.detectionModes.map(m => `${m.id} ${m.range}`).join()], [true, 120, "truesight", "seeAll 120"]);
  const again = tokenOf(arc, "t2");
  await VisionAudit.stampToken(again);
  check("and the next drop needs nothing at all", again.updates.length, 0);
}

console.log("\nNEFERON: THE RANGE AND TRUESIGHT WERE THERE, THE MODE SAID BASIC");
{
  const nef = mk("Neferon", { truesight: 120 },
    { sight: { enabled: true, range: 120, visionMode: "basic" }, detectionModes: [{ id: "seeAll", range: 120, enabled: true }] });
  const stamp = VisionAudit.stampFor({ sight: nef.prototypeToken.sight, detectionModes: nef.prototypeToken.detectionModes },
    VisionAudit.sheetSenses(nef));
  check("only the vision mode changes", stamp?.changes, ["Truesight vision mode"]);
}

console.log("\nFILL, NEVER LOWER");
{
  const far = { sight: { enabled: true, range: 300, visionMode: "basic" }, detectionModes: [] };
  const s1 = VisionAudit.stampFor(far, { darkvision: 60 });
  check("a longer range is kept", s1?.sight?.range, 300);
  const chosen = { sight: { enabled: true, range: 60, visionMode: "monochromatic" }, detectionModes: [] };
  check("a vision mode somebody chose is kept", VisionAudit.stampFor(chosen, { darkvision: 60 }), null);
  const both = VisionAudit.stampFor({ sight: { enabled: true, range: 0, visionMode: "basic" }, detectionModes: [] },
    { darkvision: 120, truesight: 120 });
  check("darkvision and truesight alike stays Darkvision (his importers' way)", both?.sight?.visionMode, "darkvision");
  const longer = VisionAudit.stampFor({ sight: { enabled: true, range: 0, visionMode: "basic" }, detectionModes: [] },
    { darkvision: 60, truesight: 120 });
  check("truesight reaching farther than darkvision is Truesight, to its range",
    [longer?.sight?.visionMode, longer?.sight?.range], ["truesight", 120]);
  const shortSense = VisionAudit.stampFor({ sight: { enabled: true, range: 0, visionMode: "basic" },
    detectionModes: [{ id: "blindsight", range: 10, enabled: false }] }, { blindsight: 30 });
  check("a sense set too short or switched off is raised and switched on",
    shortSense?.detectionModes, [{ id: "blindsight", range: 30, enabled: true }]);
  check("a creature with no senses is left alone",
    VisionAudit.stampFor({ sight: { enabled: true, range: 0, visionMode: "basic" }, detectionModes: [] }, {}), null);
  const keep = CONFIG.Canvas.visionModes.truesight;
  delete CONFIG.Canvas.visionModes.truesight;
  check("without the Truesight mode, truesight still gets its range on Basic",
    VisionAudit.expectedFrom({ truesight: 120 }).visionMode, "basic");
  CONFIG.Canvas.visionModes.truesight = keep;
}

console.log("\nNO SENSES ON THE SHEET: THE BOOK'S COPY, BY EDITION");
{
  const index = [
    { name: "Wolf", system: { source: { rules: "2024", book: "MM 2024" }, attributes: { senses: { ranges: { darkvision: 60 } } } } },
    { name: "Wolf", system: { source: { rules: "2014", book: "MM" }, attributes: { senses: { ranges: {} } } } },
    { name: "Steam Mephit", system: { source: { rules: "2014", book: "MM" }, attributes: { senses: { ranges: { darkvision: 60 } } } } },
  ];
  const packUpdates = [];
  game.packs = [{ documentName: "Actor", collection: "world.ddb-monsters", locked: false, metadata: { label: "DDB Monsters" },
    getIndex: async () => index, updates: packUpdates }];
  VisionAudit._books = null;
  const wolf24 = mk("Wolf", {}, { sight: { enabled: true, range: 0, visionMode: "basic" } });
  wolf24.system.source = { rules: "2024" };
  const got = await VisionAudit.sensesFor(wolf24);
  check("a 2024 wolf with no senses takes the 2024 book's darkvision 60", got?.ranges?.darkvision, 60);
  check("and says where it came from", /2024 book's copy in DDB Monsters/.test(got?.from ?? ""), true);
  const wolf14 = mk("Wolf (Legacy)", {}, { sight: { enabled: true, range: 0, visionMode: "basic" } });
  check("a (Legacy) wolf reads the 2014 book, where a wolf has none", await VisionAudit.sensesFor(wolf14), null);
  const mephit = mk("Steam Mephit (Legacy)", {});
  check("a (Legacy) steam mephit takes the 2014 book's darkvision",
    (await VisionAudit.sensesFor(mephit))?.ranges?.darkvision, 60);
  const sheetWins = mk("Wolf", { darkvision: 30 });
  sheetWins.system.source = { rules: "2024" };
  check("a sheet with its own senses wins over the book", (await VisionAudit.sensesFor(sheetWins))?.ranges?.darkvision, 30);
}

console.log("\nONE PASS OVER HIS WORLD ACTORS, ONCE; THE LOCKED BOOKS ARE ONLY COUNTED");
{
  const a = mk("Erinyes", { truesight: 120 }, { sight: { enabled: true, range: 0, visionMode: "basic" },
    detectionModes: [{ id: "seeAll", range: 120, enabled: true }] });
  const b = mk("Guard", {}, { sight: { enabled: true, range: 0, visionMode: "basic" } });
  game.actors = [a, b];
  const locked = { documentName: "Actor", collection: "dnd-monster-manual.actors", locked: true,
    metadata: { label: "Monster Manual" }, indexCalls: 0,
    async getIndex() { this.indexCalls++; return [{ name: "Arcanaloth", system: { source: { rules: "2024" }, attributes: { senses: { ranges: { truesight: 120 } } } },
      prototypeToken: { sight: { enabled: false, range: 0, visionMode: "basic" }, detectionModes: [] } }]; } };
  game.packs = [locked];
  VisionAudit._books = null;
  settingsStore.set("visionPass", 0);
  const said = [];
  const keepLog = console.log;
  console.log = (...args) => said.push(args.join(" "));
  let first, second;
  try { first = await VisionAudit.pass(); second = await VisionAudit.pass(); }
  finally { console.log = keepLog; }
  check("the first pass stamps the creature short of its sheet, and nobody else", [first?.changed, a.updates.length, b.updates.length], [1, 1, 0]);
  check("it gave the Erinyes its 120 feet in the Truesight mode", [a.prototypeToken.sight.range, a.prototypeToken.sight.visionMode], [120, "truesight"]);
  check("the second load does not run it again", second, null);
  check("the locked Monster Manual is counted in the console, never written",
    said.some(l => /Monster Manual \(dnd-monster-manual\.actors\) is locked and is not rewritten: 1 of 1/.test(l)), true);
}

console.log("\nONE GM STAMPS A DROP");
{
  const arc = mmArcanaloth();
  arc.id = "arc2";
  game.actors = Object.assign([arc], { get: () => arc });
  settingsStore.set("visionPass", 1);
  VisionAudit.register();
  const onCreate = (hooks.createToken ?? []).at(-1);
  const other = { id: "gm2", isGM: true, name: "Second GM" };
  game.user = other;
  const t1 = tokenOf(arc, "t3");
  onCreate(t1);
  await new Promise(r => setTimeout(r, 10));
  game.user = GM;
  const t2 = tokenOf(arc, "t4");
  onCreate(t2);
  await new Promise(r => setTimeout(r, 10));
  check("a GM who is not the active one leaves it alone", t1.updates.length, 0);
  check("the active GM stamps it", t2.sight.visionMode, "truesight");
}

console.log("");
console.log(pass + " passed, " + fail + " failed");
if (fail) process.exitCode = 1;
