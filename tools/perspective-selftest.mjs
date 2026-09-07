// ─── The ground falls away when you climb ───────────────────────────────────
//
// Johnny, 2026-09-06: *"I imagine it should be pure perspective... I imagine it
// would be like 2.5% smaller at 10 ft. Let's start there."*
//
// ⚠️ THE VIEWER IS THE TOKEN THAT WENT UP. His own words gave the model away:
// he did not say the flier grows, he said everything else shrinks. So the
// camera rides the selected creature and only what is BELOW it recedes.
//
// ⚠️🔴 AND IT MUST STAY A PICTURE. The whole feature is one multiplication on a
// mesh. If it ever reached the document, every distance, reach, template and
// area in the suite would move with it, because all of them measure from the
// document. That is the assertion that matters most here.
//
// Run:  node tools/perspective-selftest.mjs
globalThis.Hooks = { on: () => {}, once: () => {}, off: () => {}, callAll: () => {} };
globalThis.document = { querySelectorAll: () => [], querySelector: () => null };
globalThis.CONFIG = { DND5E: {}, statusEffects: [], Canvas: { polygonBackends: {} } };
globalThis.ui = { notifications: { info: () => {}, warn: () => {}, error: () => {} } };
class _App { static DEFAULT_OPTIONS = {}; constructor() {} render() {} close() {} }
globalThis.foundry = {
  utils: { escapeHTML: (s) => String(s), deepClone: (o) => o, randomID: () => "id",
           mergeObject: (a, b) => ({ ...a, ...b }), getDocumentClass: () => null },
  applications: { api: { ApplicationV2: _App, DialogV2: { wait: async () => null },
                         HandlebarsApplicationMixin: (C) => C },
                  ux: {}, apps: {}, handlebars: {} },
};
globalThis.ChatMessage = { create: async () => {}, getSpeaker: () => ({}) };
globalThis.CONST = { ACTIVE_EFFECT_MODES: { ADD: 2 } };
globalThis.canvas = { ready: true, scene: { id: "s1" }, grid: { size: 100, distance: 5 },
  tokens: { placeables: [], controlled: [] } };

let SETTINGS = { perspectiveScaling: true, perspectivePercent: 2.5 };
globalThis.game = { ready: true, user: { isGM: true }, actors: [], scenes: [], users: [],
  settings: { get: (_m, k) => SETTINGS[k], register: () => {} },
  i18n: { localize: (k) => k } };

let pass = 0, fail = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log((ok ? "  ok   " : "  FAIL ") + String(label).padEnd(58)
    + "got " + JSON.stringify(got) + ", want " + JSON.stringify(want));
};
const near = (label, got, want, tol = 0.001) => {
  const ok = Math.abs(got - want) <= tol;
  ok ? pass++ : fail++;
  console.log((ok ? "  ok   " : "  FAIL ") + String(label).padEnd(58)
    + "got " + got.toFixed(4) + ", want ~" + want);
};

const { Perspective } = await import(
  "file:///D:/FoundryVTT/Data/modules/ace-qol/scripts/perspective.mjs");

const tok = (name, elevation, ownScale = 1) => {
  const t = {
    name,
    document: { id: `t-${name}`, elevation, width: 1, height: 1 },
    mesh: { scale: { x: ownScale, y: ownScale,
      set(x, y) { this.x = x; this.y = y ?? x; } } },
    renderFlags: { set: () => {} },
  };
  return t;
};

console.log("\nHIS NUMBER, EXACTLY");
{
  near("10 feet below is drawn at 97.5%", Perspective.scaleFor(10), 0.975);
  near("20 feet below compounds, not doubles", Perspective.scaleFor(20), 0.950625);
  near("100 feet below is about 78%", Perspective.scaleFor(100), 0.7763, 0.001);
}

console.log("\nIT NEVER REACHES ZERO, AND NEVER INVERTS");
{
  // ⚠️🔴 2.5% per 10ft taken as SUBTRACTION hits zero at 400 feet and goes
  // negative after that: a token turned inside out. Compounding cannot.
  check("400 feet below is still positive", Perspective.scaleFor(400) > 0, true);
  check("2000 feet below is still positive", Perspective.scaleFor(2000) > 0, true);
  // ⚠️ And there is a floor, so a distant creature stays findable and clickable.
  check("but never smaller than the floor", Perspective.scaleFor(100000) >= 0.35, true);
  check("shrinking is monotonic",
    Perspective.scaleFor(10) > Perspective.scaleFor(50)
      && Perspective.scaleFor(50) > Perspective.scaleFor(200), true);
}

console.log("\nNOTHING AT OR ABOVE YOU IS TOUCHED");
{
  check("level with you", Perspective.scaleFor(0), 1);
  // ⚠️ You do not look down on what is over your head.
  check("above you", Perspective.scaleFor(-40), 1);
}

console.log("\nTHE VIEWER IS THE HIGHEST THING SELECTED");
{
  // ⚠️🔴 THE HIGHEST, NOT THE FIRST. Taking the first of an unordered set flips
  // the whole view depending on click order — the same arbitrary-set-order bug
  // that cancelled an attack at arm's length earlier today.
  canvas.tokens.controlled = [tok("Ground", 0), tok("Firaxis", 60), tok("Mid", 20)];
  check("the flier is the camera", Perspective.viewerElevation(), 60);
  canvas.tokens.controlled = [tok("Mid", 20), tok("Firaxis", 60)];
  check("order does not change it", Perspective.viewerElevation(), 60);
  canvas.tokens.controlled = [];
  check("nothing selected means standing on the ground", Perspective.viewerElevation(), 0);
}

console.log("\nDRAWING IT");
{
  canvas.tokens.controlled = [tok("Firaxis", 40)];
  const ghoul = tok("Ghoul", 0);
  Perspective.apply(ghoul);
  near("a ghoul 40 feet below shrinks", ghoul.mesh.scale.x, Math.pow(0.975, 4));

  // ⚠️ MULTIPLIES THE TOKEN'S OWN SCALE. A big wolf set to 1.4 on its sheet
  // must stay big; assigning a flat number would silently erase that.
  const wolf = tok("Dire Wolf", 0, 1.4);
  Perspective.apply(wolf);
  near("a token's own scale is kept", wolf.mesh.scale.x, 1.4 * Math.pow(0.975, 4));

  const eagle = tok("Eagle", 40);
  Perspective.apply(eagle);
  check("something level with the viewer is untouched", eagle.mesh.scale.x, 1);
}

console.log("\nAND IT NEVER TOUCHES THE RULES");
{
  // ⚠️🔴 THE ONE THAT MUST NOT BREAK. Distance, reach, templates and areas all
  // measure from the document. If this ever wrote there, a creature that merely
  // LOOKS small would become harder to hit and fall out of a fireball.
  canvas.tokens.controlled = [tok("Firaxis", 100)];
  const ghoul = tok("Ghoul", 0);
  const before = JSON.stringify(ghoul.document);
  Perspective.apply(ghoul);
  check("the document is byte-for-byte unchanged", JSON.stringify(ghoul.document), before);
  check("its elevation is still zero", ghoul.document.elevation, 0);
  check("its width is still one square", ghoul.document.width, 1);
}

console.log("\nSWITCHED OFF, IT DOES NOTHING AT ALL");
{
  SETTINGS.perspectiveScaling = false;
  canvas.tokens.controlled = [tok("Firaxis", 100)];
  const ghoul = tok("Ghoul", 0);
  Perspective.apply(ghoul);
  check("no scaling applied", ghoul.mesh.scale.x, 1);
  SETTINGS.perspectiveScaling = true;
}

console.log("\nAND THE PERCENTAGE IS HIS TO TUNE");
{
  SETTINGS.perspectivePercent = 10;
  near("10% per 10 feet", Perspective.scaleFor(10), 0.9);
  SETTINGS.perspectivePercent = 0;          // nonsense
  near("a nonsense setting falls back to 2.5", Perspective.scaleFor(10), 0.975);
  SETTINGS.perspectivePercent = 2.5;
}

console.log("");
console.log(pass + " passed, " + fail + " failed");
if (fail) process.exitCode = 1;
