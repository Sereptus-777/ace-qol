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
    const entrySrc = read("ace-artificer.mjs");

    check("the save path settles what the save left",
        /_advanceStateIfAllRolled[\s\S]{0,400}_landSaveConsequences/.test(pipe),
        "the condition must not wait on the damage button");

    check("and only the GM lands it",
        /_landSaveConsequences\s*\(state\)\s*\{\s*(\/\/[^\n]*\n\s*)*if\s*\(!game\.user\.isGM\)\s*return;/.test(pipe),
        "a player's own client applying its own condition is the 2026-09-21 bug");

    check("a failed save moves the victim into the trap",
        /_dropIntoTrap/.test(pipe) && /if\s*\(fallsIn\)/.test(pipe));

    // ⚠️ Re-pinned 2026-09-25: "he should be popped back out from whatever
    // direction he was coming from and be just outside the pit area."
    check("a pass takes neither the condition nor the fall",
        /if \(target\.saveRoll\.success\) \{[\s\S]{0,300}?target\.consequences = "saved";\s*continue;/.test(pipe),
        "a pass has to leave the loop before both of them");

    check("and is stepped back clear of a hole it did not fall into",
        /_stepBackOut\(state, target\)/.test(pipe)
          && /static async _stepBackOut/.test(pipe)
          && /target\.cameFrom/.test(pipe),
        "he is standing on the rim, not in the open pit");

    check("the square he came from is remembered before the move is lost",
        /_lastTokenPos/.test(entrySrc) && /cameFrom: pending\.cameFrom/.test(entrySrc),
        "the trap hook fires after the move, so the old position is already gone");

    check("the hole's own rectangle is remembered at fire time",
        /const trapArea = TrapPipeline\._trapArea\(template\);/.test(pipe)
          && /static _trapArea\(template\)/.test(pipe),
        "a one-shot trap deletes its template long before anyone rolls");

    // ⚠️ 2026-09-25: Patrina was at the bottom of the pit when Virric stepped
    // on it, and the trap asked her to save against a hole she was already in.
    check("a trap does not catch a creature that is already in it",
        /PitFall\._rectsOverlap\(inPit\.rect, trapArea\)/.test(pipe)
          && /alreadyIn\.push\(tokenDoc\.name\)/.test(pipe),
        "the Monk's Active Tiles model, narrowed to the case his table proved");

    check("and the card says who it could not catch again",
        /state\.alreadyIn/.test(read("trap-behavior.mjs")),
        "a creature quietly missing from the list looks like a bug");

    check("and the PICTURE is the hole, not the trigger area",
        /if \(tile\) return \{ x: tile\.x, y: tile\.y, w: tile\.width, h: tile\.height \};/.test(pipe),
        "he resizes the tile and the template follows it");

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
    const pipe = read("trap-pipeline.mjs");
    const watchSrc = read("perception-watcher.mjs");
    const spent = eng.slice(eng.indexOf("async applyOneShotSpent"),
                            eng.indexOf("async applyReusableFired"));

    // ⚠️ Re-pinned 2026-09-25. A hole stays a hole; a ward burns out and leaves
    // nothing, and its icon lying on the map afterwards is litter.
    check("a trap that leaves its mark keeps its picture, and one that does not takes it with it",
        /if \(trapLeavesItsMark\(flags\.trapData \?\? \{\}\)\) \{/.test(spent)
          && /deleteEmbeddedDocuments\("Tile", tiles\)/.test(spent)
          && /export function trapLeavesItsMark/.test(read("trap-library.mjs")),
        "the pit disappearing and the ward's icon staying were the same missing question");

    // ⚠️ Re-pinned 2026-09-25. The reveal is one function now, because firing
    // has to reveal the art too: a trap that fired and stayed showed its
    // picture to nobody at all.
    check("it reveals the picture through the one reveal function",
        /await this\.revealTrapArt\(trapId, \{\s*strip: true/.test(spent)
          && /async revealTrapArt\(trapId/.test(eng)
          && /hidden: false/.test(eng));

    check("and strips the flags that would draw chrome on it",
        ["isTrap", "trapId", "linkedTemplateId", "armed", "spottedBy"]
            .every(f => eng.includes(`-=${f}`)),
        "a leftover trapId would let the delete cascade take it later");

    check("firing marks the trap sprung and puts its picture up",
        /async markSprung\(template\)/.test(eng)
          && /setFlag\(MODULE_ID, "sprung", true\)/.test(eng)
          && /engine\?\.markSprung\?\.\(template\)/.test(pipe),
        "his words: if the fucking trap went off, the trap went off");

    check("and a sprung trap gets no lock and no glow, ever again",
        (watchSrc.match(/sprung/g) ?? []).length >= 3,
        "the spotting scan, the doors and the templates all have to know");

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

    // ⚠️ Re-pinned 2026-09-25. Enemies used to live in one block marked
    // GM-only. The card was rebuilt in ace-qol's shape, one list for everyone,
    // so the mark moved onto the enemy's own row. Who may see what did not
    // change, and this is the line that proves it did not.
    const beh = read("trap-behavior.mjs");
    // ⚠️ Re-pinned 2026-09-25. "Is there a non-GM owner" was the wrong
    // question and hid his own people's rows from them. The question is whether
    // the person looking owns this creature.
    check("a row is drawn for whoever owns that creature",
        /data-owners="\$\{\(target\.ownerUserIds \?\? \[\]\)\.join\(" "\)\}"/.test(beh)
          && /owners\.includes\(game\.user\.id\)/.test(beh)
          && /_ownerUserIds\(actor\)/.test(read("trap-pipeline.mjs")));

    check("and the dice everyone should see are not GM-only",
        /<div class="forge-dmg-block">\s*\n\s*<div class="forge-dmg-roll-section">/.test(beh),
        "there were no dice at all on a player's screen");

    check("and no row prints a DC any more: the header is the only place it exists",
        !/vs DC/.test(beh),
        "one place cannot disagree with itself");
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

/* ─── 6. Down the shaft ─────────────────────────────────────────────────── */
// 2026-09-25: "If it's in the centre of a 10 or 20 foot hole, I want it to
// ignore grid snapping and be right in the centre... You could put it as tiny
// because I want it to look like it's down at the bottom of the shaft."
{
    const pit   = read("pit-fall.mjs");
    const pipe  = read("trap-pipeline.mjs");
    const entry = read("ace-artificer.mjs");
    const entrySrc = entry;
    const panel = read("panel.mjs");

    check("the fall ignores grid snapping and lands near the middle",
        /static _landingSpot\(tokenDoc, rect, grid\)/.test(pit)
          && /rect\.x \+ rect\.w \/ 2/.test(pit)
          && /const wander = \(rect\.w > grid \* 1\.5/.test(pit),
        "near the centre, not on it, and never snapped to a square");

    check("it shrinks by a share of its OWN size, not to a fixed one",
        /scaleX \* IN_PIT_SCALE/.test(pit) && /scaleY \* IN_PIT_SCALE/.test(pit),
        "a token already at 1.2 must come back to 1.2");

    // ⚠️ 2026-09-25: a real negative elevation removed the token from his map
    // under Levels. The depth is drawn, not written.
    check("the depth is a badge, not a real elevation",
        !/elevation: elev - Math\.abs\(depthFt\)/.test(pit)
          && /_refreshBadge/.test(pit)
          && /Hooks\.on\("refreshToken"/.test(pit)
          && /\(-\$\{Math\.abs\(pit\.depthFt \?\? 10\)\} ft\)/.test(pit),
        "writing it took the token off the map");

    check("a one-off burst is never looped as a standing area",
        /impact\|explosion\|ground_crack\|cast_generic/.test(read("trap-engine.mjs")),
        "an impact looped over his pit through two reloads");

    check("and leftovers are swept at load, out loud",
        /export async function sweepStalePersistentVisuals/.test(read("trap-engine.mjs"))
          && /sweepStalePersistentVisuals\?\.\(\)/.test(read("ace-artificer.mjs")));

    check("it remembers the depth the climb needs",
        /depthFt = 10/.test(pit)
          && /depthFt:  state\.trap\?\.pitDepthFt \?\? 10/.test(pipe)
          && /pitDepthFt/.test(panel));

    check("what it was is written on the token before any of that",
        /inPit`\]: \{ rect, scaleX, scaleY, elevation: elev, from, trapName, depthFt \}/.test(pit),
        "the way back has to survive a refresh, a reload and a different GM");

    // ⚠️ Re-pinned 2026-09-25: "I want them locked inside of there so they
    // can't get out." Walking out is refused on the mover's own client, which
    // is the only place a move can be stopped.
    check("walking out of a hole is refused, not watched",
        /Hooks\.on\("preUpdateToken"/.test(pit)
          && /PitFall\.promptClimb\(tokenDoc, pit\)/.test(pit)
          && /return false;\s*\/\/ the walls are in the way/.test(pit));

    // ⚠️ 2026-09-25, his table: he deleted a pit with three people in it and
    // all three kept the 55% scale and the negative elevation forever, because
    // the only ways back were leaving the hole, climbing out or an undo.
    check("deleting a trap brings everyone in it back up",
        /Hooks\.on\("deleteMeasuredTemplate", \(tplDoc\)/.test(pit)
          && /Hooks\.on\("deleteTile", \(tileDoc\)/.test(pit)
          && /static async liftEveryoneIn/.test(pit));

    check("and a token in a hole that no longer exists is repaired at load, out loud",
        /static async repairOrphans/.test(pit)
          && /Hooks\.once\("ready", \(\) => PitFall\.repairOrphans\(\)\)/.test(pit)
          && /ui\.notifications\?\.info/.test(pit),
        "a silent repair is indistinguishable from a broken one");

    check("the Forge API cannot wipe what registered before it",
        /game\.aceForge = Object\.assign\(game\.aceForge \?\? \{\}, \{/.test(entrySrc)
          && /liftEveryoneOut/.test(entrySrc),
        "the 2026-08 API-wipe lesson, caught again in the other module");

    check("and the GM can still lift anyone out by hand",
        /if \(game\.user\.isGM\) return true;/.test(pit)
          && /PitFall\.lift\(tokenDoc, "it was taken out"\)/.test(pit));

    check("the way out is the book's way out: a climb speed, gear, or magic",
        /movement\?\.climb/.test(pit)
          && /spider\\s\*climb/i.test(pit)
          && /rope\|chain/.test(pit),
        "DMG, Spiked Pit: a Climb Speed, climbing gear, or magic such as Spider Climb");

    check("a friend at the top with a rope counts",
        /other\.getFlag\?\.\(MODULE_ID, "inPit"\)/.test(pit)
          && /_distanceToRect\(ox, oy, pit\.rect\)/.test(pit));

    check("bare hands are an Athletics check, and failing it is another fall",
        /CLIMB_DC = 15/.test(pit)
          && /checks\.run\(actor, "skill", "ath"/.test(pit)
          && /Math\.max\(1, Math\.floor\(depth \/ 10\)\)/.test(pit),
        "1d6 per 10 feet, and prone again");

    // 2026-09-25, his table: he pressed "try the walls" on the client and the
    // roll box opened on the GM's screen, because CheckGate opens its box on
    // the client that calls it and the whole climb was being run GM-side.
    check("the climber rolls his own check, on his own screen",
        /static async rollTheWalls\(actor\)/.test(pit)
          && /total = await PitFall\.rollTheWalls\(actor\)/.test(pit)
          && /total,                    \/\/ already rolled, on the climber's own screen/.test(pit),
        "a roll belongs to whoever owns the creature");

    check("and the GM is sent only what it left",
        /static async resolveClimb/.test(pit)
          && /if \(!game\.user\.isGM\) return;/.test(pit)
          && /case "pitClimb"/.test(entrySrc)
          && /testUserPermission\(requestor, "OWNER"\)/.test(entrySrc));

    check("the watcher does not fire on the fall's own move",
        /options\?\.\[MODULE_ID\]\?\.pitMove/.test(pit)
          && /\[MODULE_ID\]: \{ pitMove: true \}/.test(pit));

    check("only the GM moves anyone",
        /if \(!game\.user\.isGM\) return;\s*\/\/ one writer/.test(pit));

    check("undo takes him out of the hole and back to his square",
        /PitFall\.lift\(tokenDoc, "the trap was undone", true\)/.test(pipe));

    check("and the whole thing is actually wired to the module",
        /import \{ PitFall \} from "\.\/pit-fall\.mjs";/.test(entry)
          && /PitFall\.register\(\);/.test(entry),
        "a layer nothing calls is the same bug wearing a hat");

    check("the depth box only appears for a trap that is a hole",
        /builder-pit-depth/.test(panel)
          && /fallsInBox\?\.addEventListener\("change"/.test(panel),
        "a control written in code fires nothing");
}

/* ─── 7. The card is ace-qol's card ─────────────────────────────────────── */
{
    const beh = read("trap-behavior.mjs");
    const css = readFileSync("D:/FoundryVTT/Data/modules/ace-artificer/styles/ace-artificer.css", "utf8");

    check("one list, not a player list and an enemy block",
        /const targetRows = targets/.test(beh) && !/_renderNpcBlock/.test(beh),
        "his words: this isn't even close to what my quality of life save card looks like");

    // ⚠️ Re-pinned 2026-09-25 to the order he asked for: the picture with the
    // name beside it, then the die with the arithmetic beside IT.
    check("the picture has the name beside it, and the die sits with the numbers",
        /_d20FaceHtml/.test(beh)
          && /<div class="forge-target-head">/.test(beh)
          && /<span class="forge-target-name">/.test(beh)
          && /<div class="forge-save-line">[\s\S]{0,40}?\$\{dieColumn\}/.test(beh)
          && /\.forge-d20-img \{[\s\S]{0,120}?width: 54px;/.test(css));

    check("what a failure left is a note, not a row of buttons",
        /\.forge-consequence \{[\s\S]{0,240}?border: none;/.test(css)
          && /\.forge-target-consequences \{[\s\S]{0,240}?font-size: 15px;/.test(css),
        "he read the old chips as controls and asked what they were for");

    check("the party's own rows are public, whoever owns the sheet",
        /data-party="\$\{target\.isCharacter \? "1" : "0"\}"/.test(beh)
          && /if \(row\.dataset\.party === "1"\) continue;/.test(beh)
          && /isCharacter:\s*tokenDoc\.actor\?\.type === "character"/.test(read("trap-pipeline.mjs")),
        "he owns the whole party, so ownership hid his own people from themselves");

    check("a hole lands prone even when the trap was saved with restrained",
        /if \(fallsIn && wanted === "restrained"\)/.test(read("trap-pipeline.mjs")),
        "every copy of the old Spike Pit still carries restrained");

    check("the arithmetic is spelled out, not a 'X vs Y' pill",
        /forge-save-roll/.test(beh) && /forge-save-total/.test(beh)
          && !/forge-npc-save-pill/.test(beh));

    check("the trap's description is not on the card",
        !/forge-trap-desc/.test(beh),
        "he wrote the trap; the card is for what just happened");

    check("APPLY ALL fits on one line",
        beh.includes("APPLY ALL — <strong>${totalPending}</strong>")
          && !/i>\s*APPLY DAMAGE TO ALL/.test(beh),
        "the old wording could not fit and wrapped into a mess");

    // "All that writing should be bigger, twice the size." These are the five
    // sizes that were 11 to 14px on the card he photographed.
    for (const [cls, min] of [["forge-target-name", 20], ["forge-save-roll", 25],
                              ["forge-save-verdict", 19], ["forge-target-dmg-num", 28],
                              ["forge-hp-text", 18]]) {
        // The start of a RULE, not the same class inside a longer selector.
        const at = css.indexOf(`
.${cls} {`);
        const m = at < 0 ? null : /font-size: (\d+)px/.exec(css.slice(at, at + 400));
        check(`.${cls} is at least ${min}px`, !!m && Number(m[1]) >= min,
            m ? `got ${m[1]}px` : "no font-size found");
    }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
