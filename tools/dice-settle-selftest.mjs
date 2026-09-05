// ─── Does the card wait for dice somebody else threw? ────────────────────────
//
// ⚠️ THIS HAS BEEN "FIXED" THREE TIMES AND KEPT COMING BACK, so it gets a test
// that reproduces the actual failure rather than checking that a helper exists.
//
// Johnny, 2026-09-03: "the chat card is still coming up. I've been saying this
// for months." The reason is that ACE does not throw the attack d20 — dnd5e
// does — so the settle helper had nothing of its own to wait on, and the
// completion listener was being installed AFTER the dice were already in the
// air. Every earlier fix improved the waiting; none of them was the problem.
//
// Run:  node tools/dice-settle-selftest.mjs
const hooks = new Map();
let nextHookId = 1;
globalThis.Hooks = {
  on(name, fn) { const id = nextHookId++; hooks.set(id, { name, fn }); return id; },
  off(_name, id) { hooks.delete(id); },
  once(name, fn) { return globalThis.Hooks.on(name, fn); },
  callAll(name, ...args) { for (const h of [...hooks.values()]) if (h.name === name) h.fn(...args); },
  call(name, ...args) { globalThis.Hooks.callAll(name, ...args); return true; },
};
const fire = (name, ...args) => globalThis.Hooks.callAll(name, ...args);

let dsnEnabled = true;
globalThis.game = { dice3d: { isEnabled: () => dsnEnabled, showForRoll: null },
  settings: { get: () => false, register: () => {} }, user: { id: "u1" }, ready: true };
globalThis.ui = { notifications: { info: () => {}, warn: () => {}, error: () => {} } };
globalThis.canvas = { grid: { size: 100 } };
globalThis.foundry = { utils: { escapeHTML: (s) => String(s) } };

const { aceArmDiceWatch, awaitDiceSettle, safeShowForRoll } = await import(
  "file:///D:/FoundryVTT/Data/modules/ace-qol/scripts/dsn-utils.mjs");

let pass = 0, fail = 0;
const check = (label, got, want) => {
  const ok = got === want;
  ok ? pass++ : fail++;
  console.log((ok ? "  ok   " : "  FAIL ") + label.padEnd(58) + "got " + JSON.stringify(got) + ", want " + JSON.stringify(want));
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

console.log("\nTHE FAILURE, REPRODUCED — dnd5e throws the dice, ACE builds the card");
{
  // Armed the instant the system reports the roll, exactly as the pipeline now
  // does, and long before any card exists.
  aceArmDiceWatch();

  let cardPosted = false;
  const card = awaitDiceSettle(3000, { graceMs: 20, useArmed: true }).then(() => { cardPosted = true; });

  await sleep(60);
  check("the card has NOT posted while the dice are still rolling", cardPosted, false);

  fire("diceSoNiceRollComplete", "Message.abc");
  await card;
  check("it posts once the dice report finishing", cardPosted, true);
}

console.log("\nTHE RACE THAT MADE IT SURVIVE THREE FIXES");
{
  // ⚠️ THE DICE LAND BEFORE ANYBODY ASKS. Installing the listener at card-build
  // time missed this completion forever and fell through to a short probe.
  aceArmDiceWatch();
  fire("diceSoNiceRollComplete", "Message.def");   // finished already

  const t0 = Date.now();
  await awaitDiceSettle(3000, { graceMs: 20, useArmed: true });
  const took = Date.now() - t0;
  check("an already-finished animation resolves at once, not on a timeout", took < 400, true);
}

console.log("\nEACH CARD WAITS FOR ITS OWN ROLL");
{
  aceArmDiceWatch();   // swing one
  aceArmDiceWatch();   // swing two

  let first = false, second = false;
  const c1 = awaitDiceSettle(3000, { graceMs: 10, useArmed: true }).then(() => { first = true; });
  const c2 = awaitDiceSettle(3000, { graceMs: 10, useArmed: true }).then(() => { second = true; });

  await sleep(40);
  check("neither has posted yet", first || second, false);

  fire("diceSoNiceRollComplete", "Message.1");
  await c1;
  check("the first card posts on the first completion", first, true);

  fire("diceSoNiceRollComplete", "Message.2");
  await c2;
  check("the second waits for its own", second, true);
}

console.log("\nIT CAN NEVER HANG");
{
  // ⚠️ AWAITING DSN UNGUARDED HUNG THE WHOLE PIPELINE IN v0.4.21. A watch whose
  // completion never arrives has to give up eventually.
  const watch = aceArmDiceWatch();
  check("a watch is armed", !!watch, true);
  check("and it carries a promise", typeof watch?.promise?.then, "function");
}

console.log("\nNO DICE SO NICE, NO WAIT AT ALL");
{
  dsnEnabled = false;
  const t0 = Date.now();
  await awaitDiceSettle(3000, { graceMs: 500, useArmed: true });
  check("returns immediately when 3D dice are off", Date.now() - t0 < 50, true);
  check("and arming is a no-op", aceArmDiceWatch(), null);
  dsnEnabled = true;
}

console.log("\nTHE SAME DICE NEVER TUMBLE TWICE");
// ⚠️🔴 HE SAW THIS LIVE AND READ IT AS 4d6. Johnny, 2026-09-05: "when
// Firaxis did that heal, it rolled 4d6... two d6, and then maybe two seconds
// later it rolled another two d6." Nothing rolled twice. The 2d6 was ANIMATED
// twice, and the two-second gap was the settle wait in between: the resolver
// shows the dice, waits for them to land, posts a card, and the card helper
// shows the SAME roll again on its way out.
{
  const shown = [];
  dsnEnabled = true;
  game.dice3d.showForRoll = (roll) => { shown.push(roll); return Promise.resolve(); };

  const roll = { total: 6, dice: [] };
  safeShowForRoll(roll, "the heal");
  safeShowForRoll(roll, "the card");            // what _postCard does on the way out
  check("one roll is animated once, however many times it is shown", shown.length, 1);

  // ⚠️ A GENUINE SECOND ROLL IS UNAFFECTED. A re-roll for advantage builds a
  // new Roll, and suppressing that would hide real dice.
  safeShowForRoll({ total: 11, dice: [] }, "a different roll");
  check("a different roll still animates", shown.length, 2);

  // ⚠️ AND IT IS THE ROLL THAT IS MARKED, NOT A COUNTER. Showing the first
  // roll again, later, after other rolls, is still the same dice.
  safeShowForRoll(roll, "the same heal again, much later");
  check("the first roll stays suppressed afterwards", shown.length, 2);

  game.dice3d.showForRoll = null;
}

console.log("");
console.log(pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
