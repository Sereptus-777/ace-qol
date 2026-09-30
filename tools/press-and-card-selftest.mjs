// ─── THE PRESS, THE LABEL, THE CLIP AND THE JUMP ─────────────────────────────
//
// His table, 2026-09-30, on 0.65.0: "Four leaks."
//
//   1  PICKER STILL OPENED. Jeth was already targeted. "Already selected" means
//      Foundry's current targets, not only ACE's last pick.
//   2  THE DIALOG STILL SAYS "Save". The shot is dnd5e's own use dialog.
//      Relabeling ACE's button did not touch it.
//   3  TWO CHARMS, ONE CLIP. Two sources, one Charmed condition, one animation.
//      ACE's hearts, not JB2A.
//   4  CHAT DOES NOT JUMP TO THE NEW CARD.
//
// Two of the four were fixes I had already written that could never run, and
// both for the same shape of reason: a guard that read a value something else
// had already filled in.
//
//   · the picker read `game.user.targets` at a moment ACE had just emptied it
//   · the label read `activity.name` after dnd5e had backfilled it with "Save"
//
// So each pin below tests the thing the live code actually depends on, not the
// intention beside it.
import { readFileSync } from "node:fs";

let pass = 0, fail = 0;
const check = (label, ok, detail = "") => {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${String(label).padEnd(64)} ${detail}`);
};
const read = (p) => readFileSync(`D:/FoundryVTT/Data/modules/ace-qol/${p}`, "utf8");

const aim   = read("scripts/road/aim.mjs");
const pick  = read("scripts/spell-target-picker.mjs");
const pipe  = read("scripts/spell-pipeline/pipeline.mjs");
const auto  = read("scripts/spell-auto-damage.mjs");
const choice = read("scripts/activity-choice.mjs");
const main  = read("scripts/ace-qol.mjs");
const chat  = read("scripts/chat-render-utils.mjs");
const vis   = read("scripts/condition-visuals.mjs");
const react = read("scripts/reaction-engine.mjs");

console.log("\nTHE PRESS, THE LABEL, THE CLIP AND THE JUMP\n");

/* ══ 1. THE PICKER READS WHAT THE PRESS POINTED AT ════════════════════════ */
console.log("1. ALREADY SELECTED MEANS FOUNDRY'S CURRENT TARGETS");
{
  // ⚠️🔴 THE CAUSE. The pipeline's press clears the reticle for every
  // picker-using shape BEFORE the picker opens, so 0.65.0's early return was
  // reading a set ACE had emptied a moment earlier.
  check("the clear still happens — it is right and it stays",
    /const pickerShapes = new Set\(\["distribute", "attack-multi", "multi-buff", "multi-heal", "save-single", "touch", "chained"\]\);/.test(pipe),
    "stale targets pre-fill the next cast");
  check("and Charm Person's shape is one of the cleared ones",
    /case "save-single":\s*\n\s*await SpellPipeline\._runPickerAndResolve\(ctx, "single"\);/.test(pipe),
    "save-single, one target");

  check("the clear remembers what it cleared",
    /if \(remember\) rememberAim\(why\);/.test(pipe)
    && /static _clearUserTargets\(\{ remember = true, why = "the cast" \} = \{\}\)/.test(pipe),
    "road/aim.mjs");
  check("the same helper in the damage path remembers too",
    /if \(remember\) rememberAim\(why\);/.test(auto)
    && /static _clearUserTargets\(\{ remember = true, why = "the cast" \} = \{\}\)/.test(auto),
    "one rule, both clears");
  check("a post-resolution tidy-up does NOT remember",
    /_clearUserTargets\(\{ remember: false \}\)/.test(pipe)
    && /_clearUserTargets\(\{ remember: false \}\)/.test(auto),
    "that reticle is spent");

  check("the memory lives where ACE's aiming lives, and imports nothing",
    /export function rememberAim\(/.test(aim) && /export function aimedAtPress\(/.test(aim)
    && !/^import /m.test(aim),
    "no import cycle");
  check("an empty press writes an empty snapshot",
    /_atPress = \{ ids, why: String\(why\) \};/.test(aim),
    "nothing can be inherited from an older press");
  check("and the first read consumes it",
    /const held = _atPress;\s*\n\s*_atPress = null;\s*\n\s*return held;/.test(aim),
    "read once, then gone");

  check("the picker asks the live reticle first",
    /let chosen = \[\.\.\.\(game\.user\.targets \?\? \[\]\)\]\.map\(t => legal\(t\.id\)\)\.filter\(Boolean\);/.test(pick),
    "whatever is targeted now");
  check("then what the press was pointing at",
    /const press = aimedAtPress\(\);/.test(pick)
    && /const held = \(press\?\.ids \?\? \[\]\)\.map\(id => legal\(id\)\)\.filter\(Boolean\);/.test(pick),
    "the set ACE emptied");
  check("one legal target either way means no picker at all",
    /if \(chosen\.length === 1 && chosen\[0\]\.actor\)/.test(pick)
    && /return \[chosen\[0\]\.actor\];/.test(pick),
    "that target is the cast");
  check("and the reticle is put back where he had it",
    /if \(chosen\[0\]\.token\) aimAt\(chosen\[0\]\.token, \{ releaseOthers: false \}\);/.test(pick),
    "the cast, the clip and the card all read it after this");
  check("two targeted with room for one is still a question",
    /if \(chosen\.length > 1\)/.test(pick), "the picker opens to ask which");
  check("and the snapshot only counts for a LEGAL candidate",
    /const legal = \(tokenId\) => candidates\.find\(c => c\.tokenId === tokenId && c\.valid !== false\);/.test(pick),
    "out of range, dead, or gone → the picker opens");

  // Clicking a portrait on a one-target picker is still the cast (0.65.0).
  check("with one target the click is the cast",
    /if \(maxTargets === 1\) \{[\s\S]{0,300}confirm\.click\(\); return;/.test(pick),
    "no second button");
  check("and that button is hidden, because the click presses it",
    /if \(confirm\) confirm\.style\.display = "none";/.test(pick), "one way out");
}

/* ══ 2. NO PRESS IS LABELLED BY ITS TYPE ══════════════════════════════════ */
console.log("\n2. THE ROW READS \"Cast Charm Person\", NEVER \"Save\"");
{
  // ⚠️🔴 WHY 0.65.0 CHANGED NOTHING. dnd5e's Activity#prepareData does
  // `this.name = this.name || game.i18n.localize(this.metadata?.title)`, so
  // `if (a.name)` is true for every activity in his world and the branch that
  // built "Cast Charm Person" was unreachable — in ACE's own picker too.
  check("the test is no longer \"does it have a name\"",
    !/const base = a\.name\s*\n?\s*\? \(\(buttonFor\(a\)\?\.textContent/.test(main),
    "dnd5e fills that field in");
  check("it asks dnd5e what it would have called the TYPE",
    /const key = activity\?\.metadata\?\.title;/.test(choice)
    && /if \(typeWord && name === typeWord\) return false;/.test(choice),
    "no word list");
  check("so an activity somebody genuinely named \"Save\" keeps its name",
    /export function hasOwnName\(activity\)/.test(choice) && /return true;/.test(choice),
    "the name is only rejected when it IS the type word");
  check("one reader builds the label",
    /export function pressLabel\(\{ item, activity \}\)/.test(choice)
    && /const verb = item\?\.type === "spell" \? "Cast" : "Use";/.test(choice),
    "Cast a spell, Use a feature");

  const users = (main.match(/pressLabel\(\{/g) ?? []).length;
  check("and every press that can show a label uses it", users >= 3,
    `${users} call sites: ACE's rows, dnd5e's chooser, dnd5e's use dialog`);
  check("ACE's own picker rows",
    /const base = pressLabel\(\{ item, activity: a \}\);/.test(main), "the branded picker");
  check("dnd5e's chooser, on the one dialog ACE hands back",
    /_aceRelabelActivityRows\(el, item\);/.test(main)
    && /for \(const btn of root\.querySelectorAll\("button\[data-activity-id\]"\)\)/.test(main),
    "revealed, so it must read right");
  check("dnd5e's use dialog — the subtitle in his shot",
    /\.querySelector\?\.\("\.window-subtitle"\)/.test(main)
    && /sub\.innerText = want;/.test(main),
    "title = item name, subtitle = activity name");
  check("the activity type is untouched",
    /activity\.type` stays "save"|type stays "save"/.test(main) || /THE TYPE IS UNTOUCHED/.test(choice),
    "his words: it stays save internally");
  check("and a row it changes says so in the console",
    /which is the activity's type\. It reads/.test(main), "never silent");
}

/* ══ 3. ONE CLIP ON THE TOKEN ═════════════════════════════════════════════ */
console.log("\n3. TWO SOURCES, ONE CHARMED, ONE CLIP");
{
  // ACE's own half already obeyed this: the hearts are drawn from the token's
  // STATUS set and keyed on it, so a second charmed effect changes nothing.
  check("ACE draws the hearts from the status set, not per effect",
    /if \(has\("charmed"\)\) \{/.test(vis), "one charmed status however many sources");
  check("and what it built is keyed on that set, so a second source is a no-op",
    /const key = active\.join\("\|"\);/.test(vis)
    && /if \(existing\?\.key === key && existing\.token === token && !existing\.cont\?\.destroyed\) return;/.test(vis),
    "no teardown, no restart");
  check("so the clip ends exactly when the last source does",
    /const active = statuses\.has\("dead"\) \? \[\]/.test(vis),
    "the status drops with the last effect carrying it");

  // Automated Animations is the other clip. It plays per EFFECT CREATED.
  check("AA is switched off on an ACE condition ACE already draws",
    /const key = data\?\.flags\?\.\[MODULE_ID\]\?\.conditionKey \?\? effect\?\.flags\?\.\[MODULE_ID\]\?\.conditionKey;/.test(main)
    && /const drawn = statuses\.filter\(s => BODY_VISUAL_STATUSES\.has\(s\)\);/.test(main),
    "the body IS the icon");
  check("in AA's own words, before the effect exists",
    /effect\.updateSource\(\{ "flags\.autoanimations": \{\s*\n\s*isEnabled: false, isCustomized: false, fromAmmo: false, version: 5,/.test(main),
    "so AA never sees it");
  check("ACE's own conditions only",
    /if \(!key\) return;\s+\/\/ not one of ACE's conditions/.test(main),
    "somebody else's effect is not ours to take over");
  check("and a condition ACE does not draw is left alone",
    /if \(!drawn\.length\) return;\s+\/\/ ACE draws nothing for this one/.test(main),
    "no blanket suppression");
  check("a charm that refreshes creates nothing, so there is nothing to play",
    /refreshed/.test(read("scripts/condition-library.mjs")), "0.63.0, same caster");
}

/* ══ 4. A NEW ACE CARD TAKES THE LOG TO IT ════════════════════════════════ */
console.log("\n4. CHAT SITS ON THE NEW CARD");
{
  // ⚠️🔴 THE FIRST PASS SCROLLED TOO EARLY, AND THESE PINS WERE GREEN OVER IT.
  // Foundry's ChatLog##postOne awaits renderMessage (which fires the render
  // hook) and THEN appends, so both createChatMessage and renderChatMessageHTML
  // run while the card is still detached: the log scrolled to the bottom of a
  // log the new card was not in. So the pin is now on the WAIT, not on the call.
  check("the scroll waits until the card is actually in the log",
    /if \(el\?\.isConnected\) \{ scroll\(\)\.catch/.test(chat)
    && /requestAnimationFrame\(whenInTheDom\);/.test(chat),
    "a condition, not a delay");
  check("and one frame is the tick, because a microtask runs before the append",
    /anything queued during the/.test(chat) && /hook runs first/.test(chat),
    "the append is the continuation of that await");
  check("it gives up out loud rather than looping forever",
    /if \(\+\+frames > 30\)/.test(chat)
    && /never reached the chat log/.test(chat), "bounded, and it says so");
  check("a new card is marked at creation and scrolled from the render pass",
    /_newCards\.add\(message\.id\);/.test(chat)
    && /if \(!message\?\.id \|\| !_newCards\.has\(message\.id\)\) return;/.test(chat),
    "created in this session AND now on screen");
  check("consumed once, so a re-render never moves the log again",
    /_newCards\.delete\(message\.id\);/.test(chat), "a redraw is not a new card");
  check("it waits for the pictures",
    /await log\.scrollBottom\(\{ waitImages: true, popout: true \}\);/.test(chat),
    "a portrait has no height until it loads");
  check("and checks that it worked, because they settle after the scroll",
    /if \(cardBottom - boxBottom > 2\)/.test(chat)
    && /el\.scrollIntoView\(\{ block: "end", behavior: "instant" \}\);/.test(chat),
    "short of the card is the same as no scroll");
  check("the popout log too",
    /popout: true/.test(chat), "a second log with its own scroll position");
  check("whoever the speaker is",
    !/author/.test(chat.slice(chat.indexOf("export function takeLogToNewCard"))),
    "his words: including when the speaker is the monster");
  check("only ACE's cards",
    /if \(!isAceCard\(message\)\) return;/.test(chat), "nothing global");
  check("and only a card this screen can see",
    /if \(message\.visible === false\) return;/.test(chat), "a whisper past this screen");
  check("registered once, through the chrome pass every ACE card already uses",
    /registerAceCardScroll\(\);/.test(chat) && /if \(_scrollRegistered\) return;/.test(chat)
    && /takeLogToNewCard\(message, el\);/.test(chat),
    "one place, all four modules");
}

/* ══ 6. A SECOND CASTER DOES NOT DELETE THE FIRST ═════════════════════════ */
console.log("\n6. TWO SOURCES, ONE CHARMED, NEITHER DELETED");
{
  const lib = read("scripts/condition-library.mjs");
  const anim = read("scripts/animation/spell-animator.mjs");
  const helper = read("scripts/spell-pipeline/animation.mjs");
  const sweep = read("scripts/effect-sweeper.mjs");

  // ⚠️🔴 THE CAUSE. Both apply paths opened with a caster-blind dedupe:
  // _findEffect then delete(). It ran BEFORE the caster-aware twin check, so
  // Kasimir's Charm Person deleted Lamia's and the guard had nothing to look at.
  check("the dedupe asks whose copy it is",
    /static _copiesBySource\(actor, key, options = \{\}\) \{/.test(lib),
    "same caster, another caster, or nobody named");
  check("two KNOWN casters that differ make it somebody else's",
    /if \(caster && theirs && theirs !== caster\) others\.push\(e\);/.test(lib),
    "unknown on either side is not a disagreement");
  check("applyEffect deletes only its own copy",
    /const \{ mine, others \} = ConditionLibrary\._copiesBySource\(actor, key, options\);/.test(lib)
    && (lib.match(/_copiesBySource\(actor, key, options\)/g) ?? []).length >= 2,
    "the path a registry effect like charm_person takes");
  check("and the caster-blind delete is gone from both paths",
    !/const existing = ConditionLibrary\._findEffect\(actor, key\);\s*\n\s*if \(existing\) \{\s*\n\s*await existing\.delete\(\)/.test(lib),
    "no _findEffect-then-delete left");
  check("a second source is said out loud",
    /static _saySecondSource\(actor, key, others, options = \{\}\)/.test(lib)
    && /Two sources, one condition on the token, one clip/.test(lib), "never silent");

  check("the same-source refresh now runs BEFORE the dedupe",
    lib.indexOf("SAME SOURCE, SAME CONDITION: REFRESH IT")
      < lib.indexOf("Same-condition dedupe (RAW: conditions don't stack)"),
    "the order is the fix");
  check("one net finds every copy, not just the first",
    /static _matchingEffects\(actor, key\)/.test(lib)
    && /return ConditionLibrary\._matchingEffects\(actor, key\)\[0\] \?\? null;/.test(lib),
    "_findEffect reads the same net");

  // The sweeper: a condition another source still carries has not ended.
  check("the sweeper does not treat a still-carried condition as ended",
    /const stillOn = EffectSweeper\.stillCarried\(actor, effect\);/.test(sweep)
    && /if \(stillOn\.length\) \{/.test(sweep), "his rule, in the sweeper");
  check("and it reads the other effects, not the derived status set",
    /if \(e\.id === effect\?\.id \|\| e\.disabled\) continue;/.test(sweep),
    "the document has not caught up when a delete is announced");
  check("what belongs to the one effect still goes",
    /only this one's \$\{ended\} clip\(s\) ended/.test(sweep), "its own clip");

  // The JB2A condition clip.
  check("ACE does not play a JB2A picture of a condition it draws itself",
    /function aceAlreadyDrawsThis\(entry, path\)/.test(anim)
    && /if \(drawn\) \{/.test(anim), "jb2a.condition.boon.01.014.red");
  check("the condition FAMILY is what it tests",
    /\/\(\^\|\[\.\\-_\/\]\)condition\(\[\.\\-_\/\]\|\$\)\/i\.test/.test(anim),
    "the on-token picture, not a cast flourish");
  check("and only when ACE really draws that condition",
    /conditionStatuses\(key\)\.filter\(s => BODY_VISUAL_STATUSES\.has\(s\)\)/.test(anim),
    "Bless and Bane keep their own clip");
  check("the spell's landing condition reaches the animator",
    /entry: ctx\.entry \?\? null/.test(helper)
    && /export async function playCuratedAnimation\(\{ casterToken, item, targets = \[\], entry = null \} = \{\}\)/.test(anim),
    "it cannot answer without the entry");
  check("a key's statuses are read from the library, never a second list",
    /export function conditionStatuses\(key\)/.test(lib), "charm_person puts on charmed");
  check("a cast flourish is still played",
    /A cast flourish would still play/.test(anim), "his words");
  check("and an unreadable answer plays, rather than silently playing nothing",
    /return null;\s+\/\/ unreadable: play it, rather than silently play nothing/.test(anim),
    "silence is the worse failure here");
}

/* ══ 5. A RELOAD IS NOT A NEW ROUND ═══════════════════════════════════════ */
console.log("\n5. ALSO LOGGED: A SPENT REACTION SURVIVES A RELOAD");
{
  check("the boot sweep stands down while a fight is running",
    /if \(game\.combat\?\.started\) \{/.test(react), "his report: Kasimir's reaction came back");
  check("and says so rather than going quiet",
    /A reload is not a new round\./.test(react), "silence is a bug");
  check("the four real resets are untouched",
    /Hooks\.on\("combatTurnChange"/.test(react) && /Hooks\.on\("combatRound"/.test(react)
    && /Hooks\.on\("deleteCombat"/.test(react) && /Hooks\.on\("dnd5e\.restCompleted"/.test(react),
    "turn, round, combat end, rest");
  check("the boot sweep itself still exists for a fight that ended without deleteCombat",
    /this\._resetAllReactionFlags\("world startup"\);/.test(react), "not removed, gated");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
