// ─── Getting off the ground ─────────────────────────────────────────────────
//
// ⚠️ WHY THIS EXISTS. Johnny, 2026-09-06, after Tarakamedes' dark gift gave a
// character a flying speed: *"When he pushes that fucking dark gift feature or
// icon, or whatever feature, then he's got to be asked for elevation."* A flying
// speed is not being in the air. Foundry stores the number and never asks the
// question that matters at the table.
//
// ⚠️ THE MARKER IS A SHADOW, NOT AN ANIMATION. *"We can't use that same
// animation there with the whirlwind. We've got to come up with something
// else."* So: a soft ellipse behind the token that falls further and fades as
// the creature climbs. One sprite, no swirl, nothing that reads as a spell.
//
// Run:  node tools/flight-selftest.mjs
globalThis.Hooks = { on: () => {}, once: () => {}, off: () => {}, callAll: () => {} };
globalThis.document = { querySelectorAll: () => [], querySelector: () => null,
  createElement: () => ({ style: {}, dataset: {}, addEventListener: () => {},
                          appendChild: () => {}, querySelector: () => null }) };
globalThis.CONFIG = { DND5E: {}, statusEffects: [], Canvas: { polygonBackends: {} } };
globalThis.ui = { notifications: { info: () => {}, warn: () => {}, error: () => {} } };
class _App { static DEFAULT_OPTIONS = {}; constructor() {} render() {} close() {} }
globalThis.foundry = {
  utils: { escapeHTML: (s) => String(s), deepClone: (o) => o, randomID: () => "id",
           mergeObject: (a, b) => ({ ...a, ...b }), getDocumentClass: () => null },
  applications: { api: { ApplicationV2: _App, DialogV2: { wait: async () => null },
                         HandlebarsApplicationMixin: (C) => C },
                  ux: { TextEditor: { implementation: { enrichHTML: async (h) => h } } },
                  apps: {}, handlebars: {} },
};
globalThis.ChatMessage = { create: async () => {}, getSpeaker: () => ({}) };
globalThis.CONST = { ACTIVE_EFFECT_MODES: { ADD: 2, OVERRIDE: 5 } };

// The smallest PIXI that lets the drawing code run and be measured.
const drawn = [];
globalThis.PIXI = {
  Graphics: class {
    constructor() { this.children = []; this.calls = []; }
    beginFill(c, a) { this.calls.push({ fill: c, alpha: a }); return this; }
    drawEllipse(x, y, rx, ry) { this.calls.push({ ellipse: { x, y, rx, ry } }); drawn.push({ x, y, rx, ry }); return this; }
    endFill() { return this; }
    destroy() { this.destroyed = true; }
  },
  TextStyle: class { constructor(o) { Object.assign(this, o); } },
  Text: class {
    constructor(t, s) { this.text = t; this.style = s; this.anchor = { set: () => {} };
      this.position = { set: (x, y) => { this.x = x; this.y = y; } }; }
    destroy() { this.destroyed = true; }
  },
};
globalThis.canvas = { ready: true, scene: { id: "s1" }, grid: { size: 100, distance: 5 },
  tokens: { placeables: [], controlled: [] } };
globalThis.game = { combat: null, ready: true, settings: { get: () => true, register: () => {} },
  user: { isGM: true }, users: [], actors: [], scenes: [], i18n: { localize: (k) => k } };

let pass = 0, fail = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log((ok ? "  ok   " : "  FAIL ") + String(label).padEnd(58)
    + "got " + JSON.stringify(got) + ", want " + JSON.stringify(want));
};

const { FlightControl } = await import(
  "file:///D:/FoundryVTT/Data/modules/ace-qol/scripts/flight.mjs");

const tok = (name, { fly = 0, elevation = 0, size = 1 } = {}) => {
  const t = {
    name, w: size * 100, h: size * 100, children: [], destroyed: false,
    mesh: { width: size * 100, height: size * 100 },
    actor: { name, system: { attributes: { movement: { fly } } } },
    document: { name, elevation, object: null },
    addChildAt(c, i) { this.children.splice(i, 0, c); },
    addChild(c) { this.children.push(c); },
    // ⚠️ A REAL CONTAINER DETACHES. The first version of this stub had no
    // removeChild, so the cleanup looked broken when it was the stub that was
    // incomplete. A harness that cannot do what the platform does invents bugs.
    removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); },
  };
  t.document.object = t;
  return t;
};

console.log("\nWHO GETS THE CONTROL AT ALL");
{
  check("a creature with a flying speed can fly",
    FlightControl.canFly(tok("Firaxis", { fly: 50 }).actor), true);
  check("one without does not", FlightControl.canFly(tok("Ismark").actor), false);
  // ⚠️ A zero or a blank is not a flying speed, and NaN must never read as one.
  const odd = tok("Odd"); odd.actor.system.attributes.movement.fly = "";
  check("an empty speed is not a flying speed", FlightControl.canFly(odd.actor), false);
  const bad = tok("Bad"); bad.actor.system.attributes.movement.fly = "yes";
  check("a nonsense speed is not a flying speed", FlightControl.canFly(bad.actor), false);
  check("the speed reads back as a number",
    FlightControl.flySpeed(tok("Wyrm", { fly: 80 }).actor), 80);
}

console.log("\nON THE GROUND THERE IS NOTHING TO SEE");
{
  drawn.length = 0;
  const t = tok("Firaxis", { fly: 50, elevation: 0 });
  FlightControl.draw(t);
  check("nothing is drawn at zero feet", t.children.length, 0);
  // ⚠️🔴 AND A NEGATIVE ELEVATION IS NOT FLYING EITHER. A creature in a pit
  // must not sprout a shadow above its head.
  const pit = tok("Digger", { fly: 50, elevation: -10 });
  FlightControl.draw(pit);
  check("nor below ground level", pit.children.length, 0);
}

console.log("\nIN THE AIR: A SHADOW BEHIND, A HEIGHT ABOVE");
{
  const t = tok("Firaxis", { fly: 50, elevation: 20 });
  FlightControl.draw(t);
  check("two things are drawn", t.children.length, 2);
  // ⚠️ INDEX 0 IS THE POINT. Behind the creature's art, never over it.
  check("the shadow is behind the art", t.children[0] instanceof PIXI.Graphics, true);
  check("and the height is written above", t.children[1].text, "▲ 20 ft");
  check("the label sits over the token's head", t.children[1].y < 0, true);
}

console.log("\nTHE HIGHER IT GOES, THE FURTHER THE SHADOW FALLS");
{
  const at = (ft) => { drawn.length = 0; FlightControl.draw(tok("F", { fly: 50, elevation: ft })); return drawn[0]; };
  const low = at(10), mid = at(40), high = at(200);
  check("the shadow drops as it climbs", low.y < mid.y && mid.y < high.y, true);
  check("and it shrinks", high.rx < low.rx, true);
  // ⚠️🔴 CAPPED ON PURPOSE. A creature at 500 feet must not throw its shadow
  // across the whole map.
  const t = tok("F", { fly: 50, elevation: 500 });
  drawn.length = 0; FlightControl.draw(t);
  check("the drop is capped near the token's own height", drawn[0].y <= t.h * 1.4, true);
}

console.log("\nA HUGE CREATURE GETS A HUGE SHADOW");
{
  // ⚠️ SIZE FROM THE MESH, not from the grid. Reading the grid gives a dragon
  // a rat's shadow.
  drawn.length = 0; FlightControl.draw(tok("Rat", { fly: 30, elevation: 20 }));
  const small = drawn[0].rx;
  drawn.length = 0; FlightControl.draw(tok("Wyrm", { fly: 80, elevation: 20, size: 4 }));
  check("the dragon's shadow is wider", drawn[0].rx > small * 3, true);
}

console.log("\nCOMING DOWN CLEANS UP AFTER ITSELF");
{
  const t = tok("Firaxis", { fly: 50, elevation: 30 });
  FlightControl.draw(t);
  const [shadow, label] = t.children;
  t.document.elevation = 0;
  FlightControl.draw(t);
  check("nothing is left on the token", t.children.length, 0);
  // ⚠️ DESTROYED, NOT ORPHANED. A sprite merely detached keeps its texture and
  // leaks for the life of the session.
  check("and both sprites were destroyed", [shadow.destroyed, label.destroyed], [true, true]);
}

console.log("\nDRAWING TWICE DOES NOT STACK");
{
  // ⚠️🔴 THE ONE THAT ALWAYS HAPPENS. Seventeen copies of one aura ring on one
  // token, 2026-09-02. Every draw clears first.
  const t = tok("Firaxis", { fly: 50, elevation: 20 });
  FlightControl.draw(t);
  FlightControl.draw(t);
  FlightControl.draw(t);
  check("still exactly two children", t.children.length, 2);
}

console.log("\nA DROP FROM 30 TO 0 TAKES THE TRIANGLE WITH IT (his table, 2026-09-18)");
{
  // "Token elevation is 0 after the fall. Right-click confirms 0. The badge
  // still says 30 ft." An elevation change is a movement in V13, and in his
  // world the document has been seen holding the old value after the update
  // announced the new one. The marker redrew from the document in that window.
  //
  // The hooks as Foundry would call them: every updateToken listener in the
  // order it registered (the marker's, then the suite's position note), and
  // refreshToken when Foundry redraws the height.
  const hooks = {};
  const keepOn = Hooks.on;
  Hooks.on = (name, fn) => { (hooks[name] ??= []).push(fn); return (hooks[name].length); };
  const { aceRegisterPositionTracking } = await import(
    "file:///D:/FoundryVTT/Data/modules/ace-qol/scripts/geometry-utils.mjs");
  FlightControl.register();
  aceRegisterPositionTracking();
  Hooks.on = keepOn;
  const fire = (name, ...args) => { for (const fn of hooks[name] ?? []) fn(...args); };
  const label = (t) => t.children.find(c => c instanceof PIXI.Text)?.text ?? "none";

  const t = tok("Varek", { elevation: 30 });
  Object.assign(t.document, { id: "tok-varek", x: 1000, y: 1000 });
  canvas.tokens.placeables.push(t);
  FlightControl.draw(t);
  check("on the balcony region the triangle says 30", label(t), "▲ 30 ft");

  // The fall: the update says 0, the document has not caught up yet.
  fire("updateToken", t.document, { elevation: 0 }, {}, "gm");
  check("the update says 0, the document still says 30: the triangle goes", [label(t), t.children.length], ["none", 0]);

  // Foundry redraws the height while the document still lags: it must not come back.
  fire("refreshToken", t, { refreshElevation: true });
  check("Foundry's own height refresh does not bring the 30 back", label(t), "none");

  // The document catches up; the refresh still agrees.
  t.document.elevation = 0;
  fire("refreshToken", t, { refreshElevation: true });
  check("and once the document agrees, still nothing", label(t), "none");

  // Back up on to a 30-foot region.
  fire("updateToken", t.document, { elevation: 30 }, {}, "gm");
  check("stepping back up on to the region shows 30 at once", label(t), "▲ 30 ft");

  // Foundry redraws the whole token while the document still lags a new drop.
  fire("updateToken", t.document, { elevation: 0 }, {}, "gm");
  fire("drawToken", t);
  check("a full redraw of the token in that window also shows the drop, not the old 30", label(t), "none");
  t.document.elevation = 0;

  // Other refreshes (a move across the floor, a new picture) leave it alone.
  const before = t.children[1];
  fire("refreshToken", t, { refreshPosition: true });
  check("a refresh that is not about height does not redraw the marker", t.children[1] === before, true);
  canvas.tokens.placeables.length = 0;
}

console.log("");
console.log(pass + " passed, " + fail + " failed");
if (fail) process.exitCode = 1;
