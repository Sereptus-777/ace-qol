// ─── THE SYSTEM'S OWN CARDS WEAR ACE'S CHROME ────────────────────────────────
//
// His ask, 2026-10-01: "for short rest, long rest, initiative, and any of the
// dice that I roll off of (the dice that are underneath the chat card), I want
// them to look like ours. With our black background, only 1px wide."
//
// ⚠️ THESE CALL THE FUNCTION. The six pins on the token art picker's green
// Current mark read the SOURCE for the shape of the test, and they were green
// the whole time it was looking in the wrong place (2026-10-01). A pin that
// reads the code beside the behaviour tests the comment, not the card.
//
// Run:  node tools/card-skin-selftest.mjs
import { readFileSync } from "node:fs";

globalThis.game = {
  settings: { get: () => false, register: () => {} },
  user: { isGM: true, id: "u1" },
  i18n: { localize: (s) => s },
  modules: { get: () => null },
};
globalThis.Hooks = { on: () => {}, once: () => {}, callAll: () => {} };
globalThis.ui = { chat: {} };
globalThis.CONFIG = {};

const { skinSystemCard } = await import(
  "file:///D:/FoundryVTT/Data/modules/ace-qol/scripts/chat-render-utils.mjs");
const css = readFileSync("D:/FoundryVTT/Data/modules/ace-qol/styles/ace-qol.css", "utf8");

let pass = 0, fail = 0;
const check = (label, ok, detail = "") => {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${String(label).padEnd(66)} ${detail}`);
};

/** A chat message element, as far as the chrome pass can tell. */
const el = (inside = "", attrs = {}, classes = []) => {
  const set = new Set(classes);
  return {
    _attrs: { ...attrs }, _inside: inside,
    classList: {
      add: (...c) => c.forEach((x) => set.add(x)),
      remove: (...c) => c.forEach((x) => set.delete(x)),
      has: (c) => set.has(c),
      all: () => [...set],
    },
    setAttribute(k, v) { this._attrs[k] = v; },
    getAttribute(k) { return this._attrs[k] ?? null; },
    querySelector(sel) { return this._inside.includes(sel.replace(".", "")) ? {} : null; },
  };
};
const skinned = (e) => e.getAttribute("data-ace-skin") === "1";

console.log("\nTHE FOUR HE NAMED");
{
  const rest = el("rest-card", {}, ["chat-message", "dnd5e2"]);
  check("a long rest card is dressed", skinSystemCard({ type: "dnd5e.rest" }, rest) && skinned(rest));

  const shortRest = el("rest-card");
  check("and so is a short rest, by the class the template draws",
    skinSystemCard({ type: "" }, shortRest) && skinned(shortRest));

  const init = el("dice-roll");
  check("an initiative roll is dressed",
    skinSystemCard({ flags: { core: { initiativeRoll: true } } }, init) && skinned(init));

  const initFlag = el("");
  check("even when the flag is only reachable through getFlag",
    skinSystemCard({ getFlag: (s, k) => s === "core" && k === "initiativeRoll" }, initFlag)
    && skinned(initFlag));

  const dice = el("dice-roll");
  check("any card with dice under it is dressed",
    skinSystemCard({}, dice) && skinned(dice));
}

console.log("\nAND NOTHING ELSE IS TOUCHED");
{
  const talk = el("");
  check("a plain message keeps Foundry's parchment",
    skinSystemCard({}, talk) === false && !skinned(talk));

  /* ⚠️ AN ACE CARD IS NEVER SKINNED. `data-ace-card` hides the whole speaker
     strip; this one keeps it, and two dressings on one card is a card that
     cannot decide. */
  const ours = el("dice-roll", { "data-ace-card": "1" });
  check("an ACE card is left alone, dice and all",
    skinSystemCard({ type: "dnd5e.rest" }, ours) === false && !skinned(ours));
}

console.log("\nTHE DARK SWITCH IS THE SYSTEM'S OWN");
{
  const light = el("dice-roll", {}, ["chat-message", "dnd5e2", "themed", "theme-light"]);
  skinSystemCard({}, light);
  check("the message moves to the dark theme", light.classList.has("theme-dark"));
  /* ⚠️ BOTH THEMES ON ONE ELEMENT IS A COIN TOSS: whichever block is defined
     later wins, and that is not a decision anybody made. */
  check("and the light one comes off", !light.classList.has("theme-light"),
    light.classList.all().join(" "));
  check("it is marked as themed, or neither set applies", light.classList.has("themed"));
}

console.log("\nTHE DRESSING ITSELF");
{
  check("the background is ACE's black, through Foundry's own variable",
    /\[data-ace-skin="1"\][^}]*--chat-message-background: #0e0e10;/s.test(css));
  check("the frame is 1px, his words",
    /\[data-ace-skin="1"\][^}]*border-width: 1px;/s.test(css));
  /* ⚠️ `.chat-message` hardcodes `color: var(--color-dark-1)`, which no theme
     switch can reach, so it is named or the header stays near-black on black. */
  check("the text colour is named, because the theme cannot reach it",
    /\[data-ace-skin="1"\][^}]*color: var\(--color-text-primary/s.test(css));
  /* ⚠️ THE DICE BOX IS THE SAME ON BOTH KINDS OF CARD. */
  const diceRule = css.slice(css.indexOf('.chat-message[data-ace-skin="1"] .dice-roll .dice-formula'));
  check("the dice box is dressed on ACE's cards too, in the same rule",
    /data-ace-card="1"\] \.dice-roll \.dice-total/.test(diceRule.slice(0, 700))
    && /box-shadow: none;/.test(diceRule.slice(0, 900)),
    "one rule, both selectors");
  check("a success stays green and a failure stays red",
    /\.dice-total\.success[^}]*#6ee787/s.test(css) && /\.dice-total\.failure[^}]*#ff7b72/s.test(css));
}

console.log("");
console.log(pass + " passed, " + fail + " failed");
if (fail) process.exitCode = 1;
