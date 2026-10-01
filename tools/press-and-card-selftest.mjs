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
    /if \(remember\) rememberAim\(why, key\);/.test(pipe)
    && /static _clearUserTargets\(\{ remember = true, why = "the cast", key = "" \} = \{\}\)/.test(pipe),
    "road/aim.mjs");
  check("the same helper in the damage path remembers too",
    /if \(remember\) rememberAim\(why, key\);/.test(auto)
    && /static _clearUserTargets\(\{ remember = true, why = "the cast", key = "" \} = \{\}\)/.test(auto),
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
    /_atPress = \{ ids, why: String\(why\), key: k \};/.test(aim),
    "nothing can be inherited from an older press");
  check("and the first read consumes it",
    /_atPress = null;/.test(aim) && /return held;/.test(aim),
    "read once, then gone");

  // ⚠️🔴 AND THE SECOND CLEAR OF ONE PRESS MUST NOT ERASE IT. 0.66.0 shipped the
  // memory and the picker STILL opened on Escher: dnd5e's activity chooser and
  // ACE's consume prompt both re-enter the use, so preUseActivity — where the
  // clear lives — fires twice for one press, and the second pass remembered the
  // empty set the first pass had just left.
  check("the memory is keyed to what is being cast",
    /export function rememberAim\(why = "a press", key = ""\)/.test(aim)
    && /export function aimedAtPress\(key = ""\)/.test(aim),
    "an item uuid");
  check("the same press never replaces a real answer with nothing",
    /if \(!ids\.length && same && _atPress\.ids\.length\) \{/.test(aim),
    "the chooser and the consume prompt both re-enter the use");
  check("a different press does replace it, so nothing bleeds across",
    /if \(held\.key && k && held\.key !== k\) \{/.test(aim), "keyed both ways");
  check("both clears pass the key",
    /rememberAim\(why, key\);/.test(pipe) && /rememberAim\(why, key\);/.test(auto)
    && /key: activity\?\.item\?\.uuid \?\? "",/.test(pipe),
    "one press, one memory");
  check("and the picker asks for its own",
    /aimedAtPress\(spellItem\?\.uuid \?\? ""\)/.test(pick), "not somebody else's press");
  check("when it opens anyway it says why",
    /the picker is opening\. Targeted now:/.test(pick),
    "this decision has been wrong twice with nothing in the console");

  check("the picker asks the live reticle first",
    /let chosen = \[\.\.\.\(game\.user\.targets \?\? \[\]\)\]\.map\(t => legal\(t\.id\)\)\.filter\(Boolean\);/.test(pick),
    "whatever is targeted now");
  check("then what the press was pointing at",
    /const press = aimedAtPress\(spellItem\?\.uuid \?\? ""\);/.test(pick)
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
    /if \(inTheLog\(\)\) \{ followTheLog\(/.test(chat)
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
  // ⚠️🔴 AND IT IS THE BOTTOM OF THE LOG, NOTHING CLEVERER (his rule,
  // 2026-09-30: "Do not scroll-to-card. Do not wait on images. Do not add
  // padding. Bottom of the log."). Waiting on images waits for every picture in
  // the WHOLE log, which arrives late enough to read as not scrolling at all.
  check("it does not wait on images",
    !/log\.scrollBottom\(\{[^}]*waitImages/.test(chat),
    "waiting on images waits for every picture in the whole log");
  check("it does not scroll to the card",
    !/scrollIntoView/.test(chat), "the bottom of the log");
  // ⚠️ ASKING WAS NOT ENOUGH, AND NEITHER WAS THE FIRST BOX THAT SCROLLS. The
  // whole rule is pinned in section 9; it lives in one place now because three
  // copies of it across three sections drifted apart twice in one evening.
  check("the scrollbar is driven to the bottom by hand — section 9 has the rule",
    /box\.scrollTop = box\.scrollHeight - box\.clientHeight;/.test(chat), "his words");
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
  // ⚠️🔴 AND "MINE" IS PROVED, NOT ASSUMED FROM THE ABSENCE OF A DISAGREEMENT.
  // 0.73.0 read "only two KNOWN casters that differ make it somebody else's", so
  // a copy naming NO caster was treated as the new caster's own and had its clock
  // rewritten. One missing stamp on either side and Kasimir rewrote Lamia's hour.
  check("a copy is only his when it says so",
    /if \(caster \? \(theirs === caster\) : !theirs\) mine\.push\(e\);/.test(lib),
    "an unattributed copy belongs to nobody and is left alone");
  check("and a condition with no caster at all still does not stack",
    /the old no-stack behaviour is untouched/.test(lib), "prone from a fall, a GM's toggle");
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

  // ⚠️🔴 THREE ROADS, NOT ONE. This file decided who owns a cast and never told
  // AA, which has its own trigger on the item's use.
  check("Automated Animations is stood down, not just out-voted",
    /export function registerAaStandDown\(\)/.test(anim)
    && /Hooks\.on\("AutomatedAnimations-WorkflowStart", \(data\) => \{/.test(anim)
    && /data\.stopWorkflow = true;/.test(anim),
    "AAHandler.make fires that hook and honours stopWorkflow");
  check("and it is registered",
    /registerAaStandDown\(\)/.test(main), "at ready, on every client");

  // ⚠️🔴 THE ROAD 0.67.0 MISSED. AA's createActiveEffects calls
  // AAHandler.make({ item: effect, activeEffect: true }), so on that hook
  // `data.item` is an ActiveEffect. The old code asked the spell registry for an
  // entry, got null, and returned — so AA played its badge on the token.
  check("an EFFECT that puts on a condition ACE draws gets no AA picture",
    /if \(data\?\.activeEffect === true \|\| subject\?\.documentName === "ActiveEffect"\) \{/.test(anim)
    && /const drawn = statuses\.filter\(s => BODY_VISUAL_STATUSES\.has\(s\)\);/.test(anim),
    "not on the effect");
  check("whoever created it and whatever record AA chose",
    /it puts on \$\{drawn\.join\(", "\)\}, which ACE draws on/.test(anim),
    "no autorec path is consulted for this one");
  check("the item's use is refused too, for a condition badge",
    /const drawn = aceAlreadyDrawsThis\(entry, anim\?\.path\);/.test(anim),
    "not on the item use");
  check("and Bless and Bane are left alone",
    /if \(!drawn\.length\) return;/.test(anim),
    "they carry no body-visual status, so nothing is stood down for them");
}

/* ══ 7. THE ORDER: DICE, CONDITION, CARD, THEN THE PICTURE ════════════════ */
console.log("\n7. DIE, THEN CARD, THEN HEARTS");
{
  const lib = read("scripts/condition-library.mjs");
  const vis = read("scripts/condition-visuals.mjs");
  const doors = read("scripts/road/doors.mjs");
  const gate = read("scripts/road/dice-gate.mjs");

  // ⚠️🔴 THE DICE. The condition door defaulted to `dice = false`, which the gate
  // honours as a caller's declaration, and the save resolver does not reach the
  // door at all. So the condition landed while the d20 was still tumbling and
  // ACE's drawing of it went up with it.
  check("the gate lives in a leaf both the doors and the library can read",
    /import \{ awaitDiceSettle, diceInFlight \} from "\.\.\/dsn-utils\.mjs";/.test(gate)
    && /export \{ untilDiceLand \} from "\.\/dice-gate\.mjs";/.test(doors),
    "doors.mjs imports the library, so the gate could not live there");
  check("the condition door no longer says 'no dice' on the caller's behalf",
    /static async apply\(actor, key, options = \{\}, \{ dice, item = null \} = \{\}\) \{/.test(doors),
    "silence asks the screen");
  check("and the library waits too, for the paths that never reach a door",
    /static async _beforeItLands\(actor, key, options = \{\}\) \{/.test(lib)
    && /await untilDiceLand\(options\?\.dice\);/.test(lib),
    "the save resolver calls applyEffect straight");
  check("both apply paths go through it",
    (lib.match(/await ConditionLibrary\._beforeItLands\(actor, key, options\);/g) ?? []).length >= 2,
    "applyEffect and applyByName");
  check("and it costs nothing when the screen is still",
    /if \(!dice && !diceInFlight\(\)\) return;/.test(gate), "same tick, no timer");

  // ⚠️ THE PICTURE. Drawn the instant the effect exists, which is before the card.
  check("a condition's drawing is held until its card",
    /export function holdConditionArt\(actorId, why = "a condition landing"\)/.test(vis)
    && /if \(fromSomething\) holdConditionArt\(actor\?\.id, /.test(lib),
    "raised where the condition lands");
  check("and only when a card is actually coming",
    /const fromSomething = !!\(options\?\.source \|\| options\?\.sourceActorId/.test(lib),
    "a GM's own toggle is not announced by one");
  check("the card lowers it",
    /export function releaseConditionArt\(why = "the card is on screen"\)/.test(vis)
    && /if \(isAceCard\(message, el\)\) releaseConditionArt\("the card is on screen"\);/.test(vis),
    "through the handler every ACE card already runs");
  check("only a drawing that would ADD something is held",
    /if \(held && active\.length > \(existing\?\.key \? existing\.key\.split\("\|"\)\.length : 0\)\)/.test(vis),
    "taking one off, and every unrelated redraw, goes now");
  check("per creature, so the rest of the board is not held up",
    /_artHeld\.get\(token\.actor\.id\)/.test(vis), "one actor at a time");
  check("and a hold nobody lowers lowers itself, out loud",
    /if \(\+\+frames > ART_HOLD_FRAMES\)/.test(vis)
    && /no card came for \$\{why\}/.test(vis),
    "a late drawing beats an invisible condition");
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

/* ══ 8. THE NAME, THE SCROLLBAR AND THE DAMAGE ROW ════════════════════════ */
console.log("\n8. NAMED FOR ITS CASTER, THE BOTTOM OF THE LOG, THE PORTRAIT ROW");
{
  const lib = read("scripts/condition-library.mjs");
  const dmg = read("scripts/damage-card-renderer.mjs");
  const app = read("scripts/damage-applicator.mjs");
  const css = read("styles/ace-qol.css");

  // 1. "Charmed by Lamia", never "Charmed by Caster". Two sources live side by
  //    side on one creature now, so the name is the only thing on the effects
  //    panel that can say whose hour is whose.
  check("an effect is named for who put it there",
    /static _nameFor\(def, options = \{\}\) \{/.test(lib)
    && /return base\.replace\(\/\\bby Caster\\b\/i, `by \$\{who\}`\);/.test(lib),
    "Charmed by Lamia");
  check("and the effect data uses it",
    /name: options\.nameOverride \?\? ConditionLibrary\._nameFor\(def, options\),/.test(lib),
    "one place");
  check("the caster is asked of the item first",
    /const fromItem = options\?\.spellItem\?\.actor\?\.name/.test(lib),
    "a synthetic token actor is not in game.actors");
  check("then the id, then the board",
    /const world = game\.actors\?\.get\(id\)\?\.name;/.test(lib)
    && /if \(tok\?\.actor\?\.id === id\) return String\(tok\.name \?\? tok\.actor\.name\);/.test(lib),
    "an unlinked token still gets a name");
  check("and nothing is invented when nobody can be named",
    /if \(!who\) return base;/.test(lib), "the definition's own name stands");
  check("a same-caster refresh keeps the name, and fixes an old one",
    /if \(_want && _want !== _twin\.name/.test(lib), "still named for them");

  // 2. The scrollbar: the wait on the card being in the log. Everything else
  //    about it is section 9's.
  check("it waits for the card to be in the log, not merely attached",
    /const inTheLog = \(\) => !!el\?\.closest\?\.\("#chat-log, \.chat-log"\);/.test(chat),
    "that is the element whose scrollbar moves");
  check("and once more on the next animation frame",
    /requestAnimationFrame\(\(\) => pin\("next frame", \{ quiet: true \}\)\);/.test(chat),
    "the card settles into its height without waiting on a picture");
  check("no padding, no scroll-to-card",
    !/scrollIntoView/.test(chat), "two of his three don'ts; images are section 9's");

  // 3. The damage row.
  const header = dmg.slice(dmg.indexOf('class="ace-qol-dmg-row-header"'));
  check("what landed sits on the creature's own row",
    header.indexOf("ace-qol-dmg-type-breakdown") > 0
    && header.indexOf("ace-qol-dmg-type-breakdown") < header.indexOf("${flavorHintHtml}"),
    "inside the header, not a block above the buttons");
  check("and the name is under the portrait, in a column of its own",
    /\.ace-qol-dmg-row-who \{/.test(css)
    && /display: flex; flex-direction: column; align-items: center; gap: 3px;/.test(css),
    "so it never has to be cut short to leave room for what landed");
  check("the breakdown loses its indent inside the header",
    /\.ace-qol-dmg-row-header \.ace-qol-dmg-type-breakdown \{/.test(css),
    "no 36px clearance needed there");
  // ⚠️ SUPERSEDED BY HIS NEXT RULE, AND KEPT AS THE RECORD OF IT. 0.71.0 made
  // the chip half size on a row of its own under the pill; 0.73.0 took the badge
  // off this card altogether and put the word on the HP line. Pinned in
  // section 9; what is pinned here is that the old chip is gone from this card.
  check("no outcome chip on this card any more",
    !/ace-qol-dmg-mod-row/.test(dmg), "it is a word on the HP line now");
  check("the chosen multiplier is the card's gold, not blue",
    /background: linear-gradient\(180deg, #e2c45a 0%, #d4af37 100%\) !important;/.test(css)
    && !/#1e70c9/.test(css), "dark text on gold clears the contrast floor");
  check("the red DMG line is gone",
    !/<span class="ace-qol-dmg-row-dmg">\$\{totalFinal\}/.test(dmg),
    "the pill already said 5 piercing");
  check("HP and the buttons stay",
    /HP: <span class="ace-qol-hp-cur">/.test(dmg) && /ace-qol-dmg-ovr-line/.test(dmg),
    "keep HP 10 to 5/82 and APPLY ALL / UNDO ALL");
  check("the skull moved to the line about hit points",
    /class="ace-qol-dmg-hp-line">[\s\S]{0,400}ace-qol-dmg-skull/.test(dmg), "not a damage number");
  check("and a multiplier press keeps the maximum on the HP line",
    /const _max = result\.maxHP \?\? currentHP;/.test(app), "it used to drop the /82");
}

/* ══ 9. THE BAR, THE ROW, AND THE LIE ON THE SECOND CARD ══════════════════ */
console.log("\n9. THE BAR, THE DAMAGE ROW, AND THE SECOND CARD'S FALSE ERROR");
{
  const lib = read("scripts/condition-library.mjs");
  const dmg = read("scripts/damage-card-renderer.mjs");
  const css = read("styles/ace-qol.css");

  /* 1. THE BAR, AND IT IS THE ONE HE DRAGS.
   *
   * ⚠️🔴 HIS LOG, 2026-09-30: "scrollHeight 1207, clientHeight 1117. That element
   * only has 90 pixels of travel. The chat bar the GM is looking at travels much
   * further. You scrolled the wrong box."
   *
   * A card sits inside several boxes that each scroll a little, and walking up
   * and taking the FIRST one finds one of those wrappers. The pane whose thumb he
   * grabs is the one with the most TRAVEL — travel IS the thumb — so every
   * scrolling ancestor is measured and the deepest-travelling one wins. */
  /* ⚠️🔴 AND THE MOMENT WAS THE REST OF IT. His console, 2026-10-01:
   * "div.chat-scroll scrollTop=3687 ... travel=3687. That element was at its max.
   * The GM's bar was not at the bottom, because the Charm card, the apply, and
   * the condition art all logged AFTER the 100ms scroll."
   *
   * So the element was right and every pin fired before the log had finished
   * growing. A card cannot know when it is the last thing in the log, so the bar
   * is FOLLOWED instead: watched to the bottom until the log goes still. */
  check("the bar follows the log until it stops growing",
    /export function followTheLog\(why, cardEl = null\) \{/.test(chat)
    && /const FOLLOW_QUIET_MS = 400;/.test(chat), "not a fixed set of moments");
  check("anything added to the log is a pin",
    /new MutationObserver\(\(\) => pin\("a message was added to the log"/.test(chat),
    "the apply and what landed arrive after the card");
  check("a card that grows after it was drawn is a pin",
    /new ResizeObserver\(\(\) => pin\("a card changed height"/.test(chat),
    "every ACE card fills itself in");
  check("and the end of an apply is a pin",
    /Hooks\.on\(`\$\{MODULE_ID\}\.\$\{name\}`, fn\);/.test(chat)
    && /ACE finished \$\{name\}/.test(chat), "every signal The One Road names");
  check("each of those keeps the window open",
    /state\.until = Math\.max\(state\.until, performance\.now\(\) \+ FOLLOW_QUIET_MS\);/.test(chat),
    "so the bar is pinned after the LAST write, not before it");
  check("and it lets go, so it can never hold his scrollbar hostage",
    /const FOLLOW_MAX_MS = 4000;/.test(chat)
    && /for \(const o of observers\) \{ try \{ o\.disconnect\(\); \} catch \(_\) \{\} \}/.test(chat),
    "holding it longer is worse than letting go");

  check("both panes are pinned, and both are named",
    /for \(const box of document\.querySelectorAll\("\.chat-scroll"\)\) add\(box, "chat-scroll"\);/.test(chat)
    && /add\(best, "most travel above the card"\);/.test(chat),
    "div.chat-scroll and the bar he drags, when they differ");
  check("set to the max, which is what the bottom is",
    /box\.scrollTop = box\.scrollHeight - box\.clientHeight;/.test(chat),
    "scrollHeight on its own is past the end");
  check("it logs the class, scrollTop, scrollHeight, clientHeight and the travel",
    /scrollTop=\$\{top\} scrollHeight=\$\{h\} `/.test(chat)
    && /clientHeight=\$\{vis\} travel=\$\{travel\}/.test(chat), "his words");
  check("the verdict is read after the log goes quiet, not before",
    /the log has been still for \$\{FOLLOW_QUIET_MS\}ms/.test(chat),
    "his rule: log after the card is on screen");
  check("and it never claims it scrolled when it did not",
    /px SHORT of the bottom/.test(chat)
    && /Do not take the lines above as a success/.test(chat), "his rule");
  check("nothing has a scrollbar and it says so",
    /nothing in the chat has a scrollbar/.test(chat), "silence is a bug");
  check("the quiet pins stay quiet unless a bar is short",
    /if \(quiet && down\) continue;/.test(chat), "one verdict, not forty lines");
  // ⚠️ THE ONLY IMAGE WAIT IS FOUNDRY'S OWN, AND IT GATES ONLY THE LAST PIN.
  // "After Foundry's own scroll runs" can only be known by awaiting the same
  // call, and that call is the one that waits for pictures. The first three pins
  // have already happened by then, so nothing he asked for waits on an image.
  check("ACE's own three pins wait on nothing",
    chat.indexOf('pin("100ms later")') < chat.indexOf("after Foundry's own scroll"),
    "the image wait belongs to Foundry's call, which is the last word only");

  // 2. The damage row.
  // ⚠️ THE GRAY BOX IS GONE, AND THE TYPE-COLOUR PILL IS NOT THAT BOX. The click
  // rule used to zero padding, border and radius to kill the gray box, which
  // would have flattened the pill — same element, later in the file, equal
  // specificity: exactly the cascade collision the house rule warns about.
  check("the click rule no longer zeroes the pill's own shape",
    /\.ace-qol-dmg-type-clickable \{\s*\n\s*cursor: pointer; border: 0;/.test(css),
    "it carries only the click");
  check("and the pill is declared last, so nothing flattens it",
    css.lastIndexOf(".ace-qol-dmg-type-line {") > css.lastIndexOf(".ace-qol-dmg-type-clickable {"),
    "one shape says the number, the reduction and the type");
  check("the pill is filled with the damage type's own colour, in black",
    /style="\$\{strikeStyle\}background:\$\{color\};"/.test(dmg)
    && /\.ace-qol-dmg-type-line \.ace-qol-dmg-arrow \{ color: #12120f; \}/.test(css),
    "DAMAGE_COLORS, the table the whole suite paints with");
  check("struck total, arrow, then what was taken",
    /ace-qol-dmg-arrow">→<\/span>/.test(dmg) && /\.ace-qol-dmg-arrow \{/.test(css),
    "16 → 8 piercing reads as one reduced number");
  check("the outcome is a word on the HP line, before HP",
    /\$\{modPlain\}\s*\n\s*<span class="ace-qol-dmg-row-hp">HP:/.test(dmg), "his rule");
  check("a pill again, at the HP text's own size",
    /\.ace-qol-dmg-mod-plain \{/.test(css)
    && /font-size: 0\.95rem; font-weight: 800; letter-spacing: 0\.3px;/.test(css)
    && /padding: 1px 8px; border-radius: 999px;/.test(css)
    && /min-height: 1\.1rem;/.test(css),
    "same size as the HP text, and it fits its own label");
  check("still the GM's alone",
    /ace-qol-dmg-mod-plain \$\{modWord\.cls\} ace-qol-dmg-truth-only/.test(dmg),
    "a player sees the halved number and is told nothing about why");
  check("and no badge is built any more",
    !/modBadge/.test(dmg), "nothing left that nothing renders");
  check("the merge card's chip goes back to the size he knows",
    /font-size: 1\.05rem; font-weight: 800; padding: 2px 9px;/.test(css),
    "0.71.0 shrank it there for a card that no longer uses it");

  // 3 and 4. The false error, and the line both cards owe him.
  check("a status already on the creature is not toggled again",
    /const _alreadyOn = _wants\.length > 0 && _wants\.every\(st => _held\.has\(st\)\);/.test(lib)
    && /if \(!_alreadyOn && typeof actor\.toggleStatusEffect === "function"\)/.test(lib),
    "dnd5echarmed0000 is a fixed id and a second one throws");
  check("nor rebuilt from the status definition, which collides the same way",
    /if \(!_matches\(\)\.length && !_alreadyOn\) \{/.test(lib), "fromStatusEffect keeps the id too");
  check("the verify asks whether THIS caster's copy is on the actor",
    /const _matches = \(\) => ConditionLibrary\._copiesBySource\(actor, key, options\)\.mine;/.test(lib),
    "if Charmed by this caster is there, the apply succeeded");
  check("and it no longer asks for a status nothing carries",
    !/e\.statuses\?\.has\?\.\(_statusId\) \|\| e\.statuses\?\.has\?\.\(key\)/.test(lib),
    "charm_person puts on charmed, not charm_person");
  check("the net finds an effect by the flag ACE stamps itself",
    /if \(effect\.flags\?\.\[MODULE_ID\]\?\.conditionKey === key\) take\(effect\);/.test(lib),
    "a name renamed for its caster cannot break it");
}

/* ══ 10. NO RED TOAST, AND A PICKER HE CAN READ ═══════════════════════════ */
console.log("\n10. NO RED TOAST, AND THE PICKER AT TWICE THE SIZE");
{
  const css = read("styles/ace-qol.css");
  const pick2 = read("scripts/spell-target-picker.mjs");

  // ⚠️ ACE no longer asks for a status a creature already has, but dnd5e's rider
  // spawn, a macro or the effects panel still can, and a creature carrying two
  // Charms is now ordinary. A red banner about a collision that broke nothing is
  // not the table's business.
  check("a duplicate-id toast never reaches the screen",
    /if \(\/_id\\s\*\\\[\[\^\\\]\]\+\\\]\\s\*already exists\/i\.test\(text\)\) \{/.test(main),
    "the id in the message is what makes it safe to catch");
  check("and it is still said, in the console",
    /held back a toast about a duplicate document id/.test(main), "never a silent swallow");
  check("every other notification is untouched",
    /return _origNotify\(message, type, options\);/.test(main), "one message, by its text");
  check("patched once, and never able to break a notification",
    /if \(notes\?\.notify && !notes\._aceDupeIdQuiet\)/.test(main)
    && /catch \(_\) \{ \/\* never let the guard break a notification \*\//.test(main),
    "notify is what error, warn and info all go through");

  // The picker: text only, twice the size.
  check("the spell name in the header is twice the size",
    /font-size: 30px; color: #d4af37;/.test(css), "15px → 30px");
  check("the window title is centred and twice the size",
    /\.ace-qol-pickr-dialog \.window-header \.window-title \{/.test(css)
    && /font-size: 30px; line-height: 1\.2; flex: 1 1 auto; text-align: center;/.test(css)
    && /classes: \["ace-qol-pickr-dialog"\],/.test(pick2),
    "Foundry's chrome needs its own rule and a class to reach it");
  check("the instructions are twice the size",
    /font-size: 22px; color: #c9c9cc;/.test(css), "11px → 22px");
  check("each name is twice the size, and wraps instead of being cut",
    /font-weight: 600; font-size: 22px; color: #e8e8ea; text-align: center;/.test(css)
    && /overflow-wrap: break-word;/.test(css), "11px → 22px");
  check("FRIENDLY / HOSTILE is twice the size",
    /font-size: 16px; font-weight: 700; letter-spacing: 1px;/.test(css), "8px → 16px");
  check("the distance is twice the size",
    /font-size: 18px; font-weight: 700; letter-spacing: 1px;/.test(css), "9px → 18px");
  check("\"0 / 1 selected\" is twice the size",
    /font-size: 24px; color: #cfcfd2; gap: 12px;/.test(css), "12px → 24px");
  check("the range tag too",
    /font-size: 18px; font-weight: 700; letter-spacing: 1\.2px;/.test(css), "9px → 18px");
  check("and the tile grew with the text, so nothing is clipped",
    /repeat\(auto-fill, minmax\(180px, 1fr\)\)/.test(css),
    "doubling every label inside a 120px tile would cut the names");
  check("who may be picked and the range are untouched",
    /const resolvedRange = \(Number\.isFinite\(rangeFt\) \|\| rangeFt === Infinity\)/.test(pick2)
    && /candidates = candidates\.filter\(c => c\.lifeOk\);/.test(pick2), "text only");
}

/* ══ 11. ONE ROW FOR THE CHIP, AND A TIMER NOBODY ELSE RESETS ═════════════ */
console.log("\n11. THE CHIP ON THE HP ROW, AND TWO TIMERS THAT DO NOT TOUCH");
{
  const css = read("styles/ace-qol.css");
  const dmg = read("scripts/damage-card-renderer.mjs");
  const lib = read("scripts/condition-library.mjs");
  const tracker = read("scripts/duration-tracker.mjs");

  // ⚠️ IT WAS ALREADY ON THAT LINE IN THE MARKUP. A 36px left indent, left from
  // when a 26px portrait sat beside this text, ate enough width that the chip
  // and the sentence could not share the row, so it wrapped above.
  check("the chip and HP share one row",
    /\$\{modPlain\}/.test(dmg) && /padding: 3px 10px 2px 0; font-size: 0\.85rem;/.test(css),
    "the indent is gone; the portrait is a column of its own now");
  check("and the chip keeps its width, so the sentence is what wraps",
    /\.ace-qol-dmg-hp-line \.ace-qol-dmg-mod-plain \{ flex: 0 0 auto; \}/.test(css),
    "never the chip away from the line it belongs to");
  check("at the HP text's own size",
    /font-size: 0\.95rem; font-weight: 800; letter-spacing: 0\.3px;/.test(css), "his rule");

  /* ⚠️🔴 A NEW SOURCE DOES NOT REWRITE ANOTHER SOURCE'S DURATION (his table,
     2026-09-30: "Lamia charmed Escher. Time passed. 40 minutes left. Kasimir
     charmed him... Lamia's copy stays at 40 minutes.").

     applyEffect set `seconds` and never `startTime`, so an ACE condition arrived
     with no wall-clock anchor. duration-tracker's `_anchorEffect` then stamps the
     missing anchor with the CURRENT world time whenever it next sweeps — and a
     second caster's charm is exactly what triggers that sweep. Lamia's forty
     minutes were re-anchored to now and became a fresh hour, by a write meant
     only to rescue an orphaned third-party effect. */
  check("a condition is anchored the moment it lands",
    /duration\.startTime = Number\.isFinite\(Number\(options\.startTime\)\)/.test(lib),
    "so nothing downstream has to guess when it started");
  check("and only when it has a finite duration to count",
    /if \(_secs > 0\) \{/.test(lib), "a permanent effect has nothing to anchor");
  check("the tracker's rescue stamp says what it is doing",
    /had no start time, so it `/.test(tracker) && /is anchored to now/.test(tracker),
    "stamping now onto a twenty-minute-old effect hands it a fresh duration");
  check("a refresh needs the effect to SAY it is his",
    /if \(_caster \? \(theirs !== _caster\) : !!theirs\) return false;/.test(lib),
    "the only ACE write that touches an existing clock");
  check("and another source's copy is not deleted either",
    /if \(caster \? \(theirs === caster\) : !theirs\) mine\.push\(e\);/.test(lib),
    "both stay, each with its own hour");
  check("the clocks are read before and after every apply",
    /static _clocks\(actor, key\)/.test(lib)
    && /clocks BEFORE this apply/.test(lib) && /clocks AFTER this apply/.test(lib),
    "his rule: the live bar is the test");
  check("and a clock this apply did not own moving is shouted about",
    /A SECOND SOURCE MOVED ANOTHER SOURCE'S CLOCK/.test(lib), "never silent");
  check("the bar's own number is what is reported",
    /remaining: d\.remaining \?\? null,/.test(lib),
    "Foundry's computed remaining, which is what the effects panel shows");
}

/* ══ 12. THE CAST DIALOG ══════════════════════════════════════════════════ */
console.log("\n12. THE CAST DIALOG");
{
  const css = read("styles/ace-qol.css");
  const prompt = read("scripts/attack-prompt.mjs");
  const use = read("scripts/activity-use-prompt.mjs");

  check("the title beside the icon is twice the size",
    /font-size: 2\.3em; font-weight: 700; color: #f5df8f;/.test(css), "1.15em → twice");
  check("and it wraps, so a long spell name is not cut",
    /\.ace-qol-act-head > span \{ overflow-wrap: break-word; min-width: 0; \}/.test(css),
    "at that size it would run off the end");
  check("\"Cast Charm Person\" stays",
    /<span class="ace-qol-use-primary-name">\$\{esc\(activityName \?\? "Use"\)\}<\/span>/.test(prompt),
    "the ability is the button");
  check("\"Consume item use\" stays",
    /<span>Consume item use<\/span>/.test(prompt), "his rule");
  check("the description under the consume box is gone",
    !/ace-qol-consume-blurb/.test(prompt), "he knows what he is casting");
  check("and so is the work behind it, and the helper that did it",
    !/summary/.test(prompt.slice(prompt.indexOf("export async function showConsumePrompt")))
    && !/_summary/.test(use.replace(/\/\/[^\n]*/g, "")),
    "a dead argument is a trap for the next reader");
  check("the not-enough warning stays, because that one is about this press",
    /ace-qol-consume-warn/.test(prompt), "using it anyway won't spend any");
  check("Cancel stays where it is, a bit bigger and a bit brighter",
    /color: #ff8d86; font-family: "Rajdhani", "Signika", sans-serif;/.test(css)
    && /font-size: 15px; font-weight: 700; letter-spacing: 0\.5px;/.test(css),
    "13px → 15px, #e8756f → #ff8d86");
  check("and the text stays inside the button",
    /width: 100%; margin: 0; padding: 9px 12px;/.test(css),
    "the padding came up with the type");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
