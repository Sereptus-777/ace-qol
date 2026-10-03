// ─── A REACTION BOX DOES NOT HAND THE PLAYER THE ANSWER ──────────────────────
//
// His table, 2026-10-03:
//
//   "The Shield prompt is telling the player the outcome. 'Shield would turn it
//    into a miss' comes off the player dialog. He knows he was hit, and that
//    Shield is +5 against that attack. He does not know the roll. The player
//    line is 'Lamia hits you with Claws.' Nothing about a miss or a hit after
//    the +5. The GM can still see the margin on his own screen."
//
// The box only opens when Shield changes the answer, so saying so out loud told
// the player the roll, the AC and the margin in one sentence, and made the
// decision for them. What they are owed is what their character knows: something
// hit them, and their spell is worth five AC.
//
// ⚠️ AND IT IS DECIDED WHERE THE BOX IS DRAWN, NOT WHERE IT IS WRITTEN. A
// reaction box is built on the GM's client and sent to whoever owns the
// creature, so a line meant for the GM can only be held back at render time, on
// the client it opens on.
//
// Run:  node tools/reaction-secrecy-selftest.mjs
import { readFileSync } from "node:fs";

const src = readFileSync("D:/FoundryVTT/Data/modules/ace-qol/scripts/reaction-engine.mjs", "utf8");

let pass = 0, fail = 0;
const check = (label, ok, detail = "") => {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${String(label).padEnd(64)} ${detail}`);
};

console.log("\nTHE PLAYER'S LINE IS THE MOMENT, NOT THE ANSWER");
{
  const at = src.indexOf('type: "shield"');
  const box = src.slice(at, src.indexOf("acceptLabel: \"Cast Shield\"", at));
  check("the Shield box is where this pin expects it", at > 0, 'type: "shield"');
  check("the player is told he was hit, and by what",
    /hits you with `\s*\+ `<span class="ace-qol-reaction-spell">\$\{attackName\}<\/span>\.`/.test(box),
    "Lamia hits you with Claws.");
  /* ⚠️🔴 THE SENTENCE THAT MADE THE CHOICE FOR HIM. Read from the value
     itself, not the block: the comment above it quotes his report, and a pin
     that greps the comments would pass or fail on the wrong words. */
  const line = box.slice(box.indexOf("description:"), box.indexOf("gmNote:"));
  check("nothing about a miss is on the player's line",
    !/miss/.test(line), "no outcome");
  check("and nothing about a hit after the +5 either",
    !/still hits/.test(box) && !/would be a hit/i.test(box));
}

console.log("\nTHE MARGIN IS THE GM'S, ON THE GM'S OWN SCREEN");
{
  const at = src.indexOf('type: "shield"');
  const box = src.slice(at, src.indexOf("acceptLabel: \"Cast Shield\"", at));
  check("the box carries a GM note with the numbers",
    /gmNote: /.test(box) && /against AC /.test(box) && /a miss by /.test(box));
  check("it names the roll, the AC and the AC with Shield",
    /result\.attackTotal/.test(box) && /acBefore/.test(box) && /acWith/.test(box));

  /* ⚠️ HELD BACK WHERE IT IS DRAWN. Everything written on the GM's client is
     the GM's; only the client the box OPENS on can say who is reading it. */
  check("it is drawn only when the screen it opens on belongs to a GM",
    (src.match(/gmNote && game\.user\?\.isGM/g) ?? []).length === 2,
    "both layouts of the box");
  check("the option is read out of the box's own data",
    /\n        gmNote,\n/.test(src), "destructured, so the socket's copy carries it");
  /* ⚠️ The socket spreads the whole options object, so a new string field
     travels on its own; this pin is what keeps that true. */
  check("and the remote copy is a spread, so it travels",
    /promptData: \{\n          \.\.\.opts,/.test(src), "no whitelist to fall off");
  check("it is quieter than the line above it, and marked as the GM's",
    /\.ace-qol-reaction-gm-note \{[^}]*font-style: italic;/s.test(src));
}

console.log("");
console.log(pass + " passed, " + fail + " failed");
if (fail) process.exitCode = 1;
