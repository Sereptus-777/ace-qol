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

const mk = (name, senses = {}, proto = {}) => {
  const actor = {
    name, type: "npc",
    system: { attributes: { senses } },
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

console.log("");
console.log(pass + " passed, " + fail + " failed");
if (fail) process.exitCode = 1;
