// ═══════════════════════════════════════════════════════════════════════════
//  TRAP CONSEQUENCE SELF-TEST — what a failed save leaves, and what a player
//  is never shown
// ───────────────────────────────────────────────────────────────────────────
//  2026-09-25. Four things his table proved broken in one sitting:
//
//   1. A pit trap's prone never landed. The ONLY place effectOnFail was ever
//      applied was inside applyAll, so the condition waited on the GM's damage
//      button, and the call was wrapped in an empty catch, so when it did run
//      and fail it failed in silence.
//   2. He fell into the pit and the pit VANISHED. The one-shot spend deleted
//      every tile carrying the trap's id, which is where his own PNG lives.
//      "I want that PNG to still be there."
//   3. The disarm card still printed "Disarm DC 15" and the save row still
//      printed "vs DC 15" on a player's screen. His rule: "Everywhere it says
//      the fucking DCs, I do not want that on the client side."
//   4. Nobody fell in at all: a failed save is supposed to put the victim in
//      the middle of the trap and a successful one is supposed to leave him on
//      the rim.
//
//  Each one is a rule that has to keep holding, so each one is pinned here
//  against the real source.
// ═══════════════════════════════════════════════════════════════════════════

import { readFileSync } from "node:fs";

const FORGE = "D:/FoundryVTT/Data/modules/ace-artificer/scripts/";
const read = (f) => readFileSync(FORGE + f, "utf8");

let passed = 0, failed = 0;
const check = (what, ok, detail = "") => {
    if (ok) { passed++; console.log(`  ok   ${what}`); }
    else { failed++; console.log(`  FAIL ${what}${detail ? `  ${detail}` : ""}`); }
};

console.log("\nTRAP CONSEQUENCES: WHAT LANDS, AND WHAT HE IS NEVER SHOWN");

/* ─── 1. The one reader for "is there a hole to fall into" ──────────────── */
{
    const lib = read("trap-library.mjs").replace(/^export /gm, "");
    const { trapVictimFallsIn } =
        new Function(lib.replace(/^import[^\n]*\n/gm, "") + "\nreturn { trapVictimFallsIn };")();

    check("a pit trap is a hole",           trapVictimFallsIn({ name: "Pit Trap", description: "A concealed shaft." }));
    check("so is a spike pit",              trapVictimFallsIn({ name: "Spike Pit" }));
    check("a rolling boulder is not",      !trapVictimFallsIn({ name: "Rolling Boulder", description: "heavy bludgeoning damage and knocked prone" }));
    check("nor is a slamming door",        !trapVictimFallsIn({ name: "Slamming Door", description: "bludgeoning + prone" }));
    check("the tick beats the words, ON",   trapVictimFallsIn({ name: "Dart Trap", victimFallsIn: true }));
    check("and the tick beats them OFF",   !trapVictimFallsIn({ name: "Pit Trap", victimFallsIn: false }),
        "an explicit answer is never overruled by a name");

    // The three holes in the library say so outright, so a COPY of one that he
    // edits carries the answer with it.
    for (const id of ["pit-trap", "spike-pit", "tripwire-pit"]) {
        const at = lib.indexOf(`id:           "${id}"`);
        const block = lib.slice(at, at + 1200);
        check(`the library's ${id} answers the question itself`,
            at > 0 && /victimFallsIn:\s*true/.test(block));
    }
}

/* ─── 2. The condition lands when the SAVE is decided ───────────────────── */
{
    const pipe = read("trap-pipeline.mjs");

    check("the save path settles what the save left",
        /_advanceStateIfAllRolled[\s\S]{0,400}_landSaveConsequences/.test(pipe),
        "the condition must not wait on the damage button");

    check("and only the GM lands it",
        /_landSaveConsequences\s*\(state\)\s*\{\s*(\/\/[^\n]*\n\s*)*if\s*\(!game\.user\.isGM\)\s*return;/.test(pipe),
        "a player's own client applying its own condition is the 2026-09-21 bug");

    check("a failed save moves the victim into the trap",
        /_dropIntoTrap/.test(pipe) && /if\s*\(fallsIn\)/.test(pipe));

    check("a successful save moves nobody",
        /if\s*\(target\.saveRoll\.success\)\s*\{\s*target\.consequences\s*=\s*"saved";\s*continue;/.test(pipe),
        "a pass has to leave the loop before the condition and the fall");

    check("the centre is remembered at fire time",
        /trapCenter:/.test(pipe),
        "a one-shot trap deletes its template long before anyone rolls");

    // Silence is a bug: every refusal to apply a status says so on screen.
    const setStatus = pipe.slice(pipe.indexOf("static async _setStatus"),
                                 pipe.indexOf("static async _landSaveConsequences"));
    check("a condition that cannot be applied says so on screen",
        (setStatus.match(/ui\.notifications\?\.error/g) ?? []).length >= 3
        && !/catch\s*\(_\)\s*\{\s*\/\*[^*]*\*\/\s*\}/.test(setStatus),
        "he does not play with the console open");

    check("undo lifts what actually landed, not what the trap says",
        /if\s*\(target\.effectLanded\)/.test(pipe) && /if\s*\(target\.fellIn\)/.test(pipe));
}

/* ─── 3. The spent one-shot leaves its picture ──────────────────────────── */
{
    const eng = read("trap-engine.mjs");
    const spent = eng.slice(eng.indexOf("async applyOneShotSpent"),
                            eng.indexOf("async applyReusableFired"));

    check("the spend no longer deletes the trap's tiles",
        !/deleteEmbeddedDocuments\("Tile"/.test(spent),
        "this is what made his pit trap disappear");

    check("it reveals the picture instead",
        /hidden:\s*false/.test(spent) && /updateEmbeddedDocuments\("Tile"/.test(spent));

    check("and strips the flags that would draw chrome on it",
        ["isTrap", "trapId", "linkedTemplateId", "armed", "spottedBy"]
            .every(f => spent.includes(`-=${f}`)),
        "a leftover trapId would let the delete cascade take it later");

    check("the template itself still goes",
        /template\.delete\(\)/.test(spent));
}

/* ─── 4. No DC ever reaches a player ───────────────────────────────────── */
{
    // Every line that prints a DC has to carry the GM-only mark on the same
    // element. These are the exact three sites his table found.
    const CARD_FILES = ["trap-behavior.mjs", "disarm-pipeline.mjs", "perception-watcher.mjs"];
    const DC_PRINTS = /(Disarm DC|vs DC|vs \$\{trap\.saveDC\}|DC \$\{)/;

    for (const f of CARD_FILES) {
        const src = read(f);
        const leaks = src.split("\n")
            .map((line, i) => ({ line, n: i + 1 }))
            .filter(({ line }) => DC_PRINTS.test(line))
            .filter(({ line }) => /[<>]/.test(line))              // markup, not a log line
            .filter(({ line }) => !line.includes("forge-gm-only"))
            .filter(({ line }) => !/^\s*(\/\/|\*|<!--)/.test(line));
        check(`${f} prints no DC a player can read`,
            leaks.length === 0,
            leaks.map(l => `line ${l.n}: ${l.line.trim().slice(0, 70)}`).join(" | "));

        // And the mark has to actually be taken out on his client.
        if (src.includes("forge-gm-only")) {
            check(`${f} strips the GM-only marks for a player`,
                /!game\.user\.isGM[\s\S]{0,200}querySelectorAll\("\.forge-gm-only"\)/.test(src)
                || /querySelectorAll\("\.forge-gm-only"\)/.test(src) && /!game\.user\.isGM/.test(src),
                "a chat message is one document rendered on every screen");
        }
    }

    // The NPC block, which prints "7 vs 15", is GM-only as a whole.
    const beh = read("trap-behavior.mjs");
    check("the NPC save block is GM-only as a whole",
        /forge-npc-block forge-gm-only/.test(beh));
}

/* ─── 5. What landed is on the card ────────────────────────────────────── */
{
    const beh = read("trap-behavior.mjs");
    check("the card shows the condition and the fall",
        /_renderConsequences/.test(beh)
        && /forge-consequence-condition/.test(beh)
        && /forge-consequence-fell/.test(beh),
        "a condition that lands and says nothing is the same bug wearing a hat");

    const css = readFileSync("D:/FoundryVTT/Data/modules/ace-artificer/styles/ace-artificer.css", "utf8");
    for (const cls of ["forge-target-consequences", "forge-consequence-condition",
                       "forge-consequence-fell", "forge-die-result", "forge-dmg-type-num"]) {
        check(`.${cls} is styled`, css.includes(`.${cls}`));
    }

    // The damage dice are red, the way ace-qol's are.
    check("trap damage dice are red, not the damage type's folder",
        /DAMAGE_DIE_COLOR_FOLDER\s*=\s*"Red"/.test(beh)
        && /Dice%20Images\/\$\{DAMAGE_DIE_COLOR_FOLDER\}/.test(beh));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
