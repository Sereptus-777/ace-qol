// ─── The roll box: the one who must roll gets a box, and it rolls once ──────
//
// Johnny, 2026-09-19: "PLAYER. When a player-owned creature must roll a save
// (Fireball, Death Burst, gaze, anything on this card): popout on that owner's
// client; sound on open (same family as the other ACE prompts; if the file is
// missing, say so); the roll button blinks; that client focuses the popout;
// one click rolls; popout closes after the roll."
//
// Foundry's window is stood in by a class that renders the way ApplicationV2
// does (its HTML, then its content, then _onRender), so the box's own code
// runs: what it draws, that it comes to the front with the roll button
// focused, that it dings, that two clicks are one roll, and what happens when
// it is closed without one. WHO gets the box, and the save and concentration
// prompts that open it, are pinned in the replay with his own creatures.
//
// Run:  node tools/roll-popout-selftest.mjs

let pass = 0, fail = 0;
const check = (label, ok, detail = "") => {
  ok ? pass++ : fail++;
  console.log((ok ? "  ok   " : "  FAIL ") + label + (detail ? `   (${detail})` : ""));
};
const tick = (ms = 0) => new Promise(r => setTimeout(r, ms));

// ── Foundry stand-ins ──
const styles = [], plays = [], notes = [], warns = [];
let headStatus = 200;
class FakeButton {
  constructor(tag) {
    this.tag = tag;
    this.acp = /data-acp="(\w+)"/.exec(tag)?.[1] ?? null;
    this.cls = /class="([^"]*)"/.exec(tag)?.[1] ?? "";
    this.disabled = /\sdisabled[\s>]/.test(tag);
    this.listeners = [];
    this.focused = false;
    this.innerHTML = "";
    this.span = { textContent: "" };
  }
  addEventListener(type, fn) { if (type === "click") this.listeners.push(fn); }
  click() { if (this.disabled) return; for (const f of this.listeners) f({ preventDefault() {} }); }
  focus() { this.focused = true; }
  get classList() { return { contains: (c) => this.cls.split(/\s+/).includes(c) }; }
}
class FakeContent {
  constructor() { this.html = ""; this.buttons = []; }
  set innerHTML(h) { this.html = h; this.buttons = [...h.matchAll(/<button\b[^>]*>/g)].map(m => new FakeButton(m[0])); }
  get innerHTML() { return this.html; }
  querySelectorAll(sel) {
    if (sel === "button") return this.buttons;
    const m = /\[data-acp='(\w+)'\]/.exec(sel);
    return m ? this.buttons.filter(b => b.acp === m[1]) : [];
  }
  querySelector(sel) {
    const pill = this.buttons.find(b => b.classList.contains("acp-pill")) ?? null;
    if (sel === ".acp-pill") return pill;
    if (sel === ".acp-pill span") return pill?.span ?? null;
    return this.querySelectorAll(sel)[0] ?? null;
  }
}
const apps = [];
class AppV2 {
  static DEFAULT_OPTIONS = {};
  constructor(options = {}) { this.options = options; this.element = null; this.front = false; this.closed = false; apps.push(this); }
  // The order ApplicationV2 renders in: the HTML, the content, then _onRender.
  async render() {
    const html = await this._renderHTML({}, {});
    const content = new FakeContent();
    this._replaceHTML(html, content, {});
    this.element = content;
    this._onRender?.({}, {});
    return this;
  }
  bringToFront() { this.front = true; }
  async close() { this.closed = true; return this; }
}
globalThis.foundry = {
  applications: { api: { ApplicationV2: AppV2 } },
  audio: { AudioHelper: { play: (o, push) => { plays.push({ ...o, push }); return Promise.resolve({ failed: false }); } } },
  utils: { getRoute: (p) => `/${p}` },
};
globalThis.CONFIG = { sounds: { notification: "sounds/notify.wav" } };
globalThis.game = { user: { id: "gm", name: "Johnny", isGM: true } };
globalThis.ui = { notifications: { info: (m) => notes.push(m), warn: (m) => notes.push(m), error: (m) => notes.push(m) } };
globalThis.document = {
  getElementById: (id) => styles.find(s => s.id === id) ?? null,
  createElement: () => ({}),
  head: { appendChild: (s) => styles.push(s) },
};
globalThis.window = { focused: false, focus() { this.focused = true; } };
globalThis.fetch = async () => ({ ok: headStatus < 400, status: headStatus });
const realWarn = console.warn, realLog = console.log;
console.warn = (...a) => warns.push(a.map(String).join(" "));

const { RollPopout } = await import("file:///D:/FoundryVTT/Data/modules/ace-qol/scripts/roll-popout.mjs");
const { popupDing } = await import("file:///D:/FoundryVTT/Data/modules/ace-qol/scripts/popup-ding.mjs");
const quietLog = (fn) => { console.log = () => {}; try { return fn(); } finally { console.log = realLog; } };

console.log("\nTHE SOUND: the prompt ding, and a missing file is said");
{
  CONFIG.sounds.notification = "sounds/gone.wav";
  headStatus = 404;
  const played = quietLog(() => popupDing("a test box"));
  await tick(20);
  check("a missing ding file is said: the console names the file, and the GM is told once",
    played && warns.some(w => /sounds\/gone\.wav" is missing \(404\)/.test(w))
      && notes.some(n => /sounds\/gone\.wav" is missing/.test(n)),
    `console: ${warns.filter(w => /gone/.test(w)).length}, GM notice: ${notes.filter(n => /gone/.test(n)).length}`);
  CONFIG.sounds.notification = "sounds/notify.wav";
  headStatus = 200;
  await tick(1600);   // past the one-ding-for-a-burst window
}

console.log("\nTHE BOX: a moment, a blinking roll, the front of the screen, a ding");
const rolled = [], dismissed = [];
let failNext = false;
const spec = (key, extra = {}) => ({
  key, kind: "save", title: "Death Burst",
  line: "Magmin dies, and its Death Burst catches you.",
  sourceName: "Magmin", sourceImg: "magmin.webp",
  rollerName: "Chudd", rollerImg: "chudd.webp",
  pillLabel: "Roll Dexterity save",
  match: { kind: "save", castId: "cast1", tokenDocId: extra.tokenDocId ?? "tok-chudd" },
  onRoll: async () => { rolled.push(key); await tick(30); if (failNext) { failNext = false; throw new Error("no dice"); } },
  onDismiss: async () => { dismissed.push(key); },
  ...extra,
});
{
  const before = plays.length;
  const opened = quietLog(() => RollPopout.open(spec("p1")));
  await tick(5);
  const app = apps.at(-1);
  const html = app?.element?.innerHTML ?? "";
  const css = styles.map(s => s.textContent ?? "").join("\n");
  check("it opens, with both portraits, one plain line, the die and a pill that names the roll",
    opened && RollPopout.isOpen("p1") && /magmin\.webp/.test(html) && /chudd\.webp/.test(html)
      && /Magmin dies, and its Death Burst catches you\./.test(html)
      && /BD20-20_nobg\.png/.test(html) && /class="acp-pill"[^>]*data-acp="roll"/.test(html) && />Roll Dexterity save</.test(html),
    `${html.length} characters drawn`);
  check("no DC, no modifier, no damage in the box: those go on the chat card after the dice (his pop-up rule)",
    !/\bDC\b/.test(html) && !/\d+d\d+/.test(html));
  check("the roll button blinks: the pill and the die both carry a blinking animation",
    /\.acp-pill \{[^}]*animation: acp-blink /.test(css) && /@keyframes acp-blink \{/.test(css)
      && /\.acp-die \{[^}]*animation: acp-blink-die /.test(css) && /@keyframes acp-blink-die \{/.test(css));
  check("it closes by being rolled: the window's own close control is not drawn",
    /\.window-header \[data-action="close"\] \{ display: none; \}/.test(css));
  check("that screen focuses it: brought to the front, the roll pill holding the keyboard, the window asked for focus",
    app?.front === true && app.element.querySelector(".acp-pill")?.focused === true && window.focused === true);
  check("it dings on open, on this screen only, on the interface channel, with the prompt ding",
    plays.length === before + 1 && plays.at(-1).src === "sounds/notify.wav" && plays.at(-1).push === false
      && plays.at(-1).channel === "interface");
  const again = quietLog(() => RollPopout.open(spec("p1")));
  await tick(5);
  check("the same prompt opened twice is one box and one ding (a re-render, a reload sweep)",
    again === true && apps.filter(a => a.spec?.key === "p1").length === 1 && plays.length === before + 1);

  const pill = app.element.querySelector(".acp-pill");
  const die = app.element.querySelectorAll("[data-acp='roll']").find(b => b !== pill);
  quietLog(() => { pill.click(); pill.click(); die.click(); });
  await tick(80);
  check("one click rolls, once: the pill pressed twice and the die once make one roll",
    rolled.filter(k => k === "p1").length === 1, `${rolled.filter(k => k === "p1").length} roll(s)`);
  check("and the box closes after the roll, without handing anything back to the chat",
    app.closed === true && !RollPopout.isOpen("p1") && !dismissed.includes("p1"));
}

console.log("\nA BOX CLOSED WITHOUT A ROLL, AND ONE CLOSED BY ANOTHER SCREEN'S ROLL");
{
  quietLog(() => RollPopout.open(spec("p2")));
  await tick(5);
  const app = apps.at(-1);
  await app.close();
  check("closed without a roll (Escape): the roll goes back to the chat, never lost",
    dismissed.includes("p2") && !RollPopout.isOpen("p2") && !rolled.includes("p2"));

  quietLog(() => { RollPopout.open(spec("p3", { tokenDocId: "tok-a" })); RollPopout.open(spec("p4", { tokenDocId: "tok-b" })); });
  await tick(5);
  quietLog(() => RollPopout.closeWhere(m => m.castId === "cast1" && m.tokenDocId === "tok-a", "the GM rolled it"));
  await tick(5);
  check("the GM rolling for them closes that one box and hands nothing back; the other creature's box stays",
    !RollPopout.isOpen("p3") && RollPopout.isOpen("p4") && !dismissed.includes("p3"));
}

console.log("\nA ROLL THAT DID NOT HAPPEN KEEPS THE BOX");
{
  const app = apps.find(a => a.spec?.key === "p4");
  failNext = true;
  const errorsBefore = notes.length;
  const realErr = console.error;
  console.error = () => {};
  try { app.element.querySelector(".acp-pill").click(); await tick(80); } finally { console.error = realErr; }
  check("a roll that throws says so and leaves the box open with its buttons live, so it can be pressed again",
    RollPopout.isOpen("p4") && notes.length === errorsBefore + 1 && /could not be made/.test(notes.at(-1))
      && app.element.querySelectorAll("button").every(b => b.disabled === false));
  app.element.querySelector(".acp-pill").click();
  await tick(80);
  check("pressed again, it rolls and closes", !RollPopout.isOpen("p4") && rolled.filter(k => k === "p4").length === 2);
}

console.log("\nTHE 2024 LUCKY BUTTON IN THE BOX");
{
  const pressed = [];
  quietLog(() => RollPopout.open(spec("p5", { lucky: { label: "Lucky: Advantage (2 left)",
    spentLabel: "Luck spent: this save rolls with Advantage", onPress: async () => { pressed.push(1); return true; } } })));
  await tick(5);
  const app = apps.at(-1);
  const lucky = app.element.querySelector("[data-acp='lucky']");
  lucky.click(); lucky.click();
  await tick(20);
  check("pressed before the roll: spent once, the button then says it is spent and cannot be pressed again",
    pressed.length === 1 && lucky.disabled === true && /Luck spent/.test(lucky.innerHTML));
  quietLog(() => RollPopout.open(spec("p6", { lucky: { label: "Lucky", spent: true, spentLabel: "Luck spent: this save rolls with Advantage", onPress: async () => true } })));
  await tick(5);
  const spentHtml = apps.at(-1).element.innerHTML;
  check("a point already spent on this roll (before a reload) shows as spent, not as a second offer",
    /data-acp="lucky" disabled/.test(spentHtml) && /Luck spent/.test(spentHtml));
  await app.close();
  await apps.at(-1).close();
}

console.warn = realWarn;
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
