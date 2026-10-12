// ─── The live test of 2026-10-12, pinned ────────────────────────────────────
//
// Five things he found at the table, Cure Wounds already done:
//
//   1. "Frostbite plays the silhouette you drew, on the target, inside its
//       square... It is never 30 feet. If that silhouette cannot be found, say
//       every path you looked in and stop."
//   2. "Charm Person plays the JB2A hearts. ACE does not draw its own... A card
//       never shows an image whose file is not there. The header uses Charm
//       Person's own icon."
//   3. "Lucky is one box, and only when the roll failed. A 20 that totals 31
//       against DC 13 is a success. Lucky does not open."
//   4. The damage card: square portraits, APPLY back after UNDO, a row that reads.
//   5. "A creature already in the fight does not join it again." And the three
//       Nothics two hundred feet away, behind walls, that joined.
//
// What was PROVEN from his own world (hijinx, AMBER TEMPLE: LOWER), read from a
// copy of its data:
//   - Frostbite's Automated Animations record is "impact frost", size 1, masked.
//     ACE ignored both, so it played at its own full size.
//   - The 08:00 card read "Firaxis Greenbeard 20 FAIL, Lucky: rolled 7, kept 20".
//   - Four Flameskulls, two Gorgons and three Specters are separate tokens; none
//     joined twice. None of the Nothics, Flameskulls or Gorgons that joined had a
//     clear line to anybody on his side; each could see only other monsters that
//     had already joined. The Nothics were 169 to 214 feet from the party, walled.
//   - The Frostbite on Vilnius damage rows drew a 24px circle.
//
//   node tools/live-test-1012-selftest.mjs

import { readFileSync } from "node:fs";

let pass = 0, fail = 0;
const check = (label, ok, note = "") => {
  if (ok) pass++; else fail++;
  console.log(`${ok ? "  ok  " : "  FAIL"} ${label}${note ? `  (${note})` : ""}`);
};
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const anim = read("scripts/animation/spell-animator.mjs");
const fx = read("scripts/ace-fx.mjs");
const rec = read("scripts/animation/autorec.mjs");
const vis = read("scripts/condition-visuals.mjs");
const main = read("scripts/ace-qol.mjs");
const save = read("scripts/save-engine.mjs");
const utils = read("scripts/chat-render-utils.mjs");
const luck = read("scripts/luck.mjs");
const reng = read("scripts/reaction-engine.mjs");
const verdict = read("scripts/road/verdict.mjs");
const watch = read("scripts/perception-watch.mjs");
const css = read("styles/ace-qol.css");

console.log("\n1. FROSTBITE: THE SILHOUETTE, ON THE TARGET, INSIDE ITS SQUARE");
{
  check("Frostbite has ACE's own look: the cold silhouette",
    /const ACE_LOOKS = Object\.freeze\(\{\s*\n\s*frostbite: \{ silhouette: "cold" \},/.test(anim));
  check("and it is found by the spell's name, its edition suffix taken off",
    /export function aceLookFor\(item\) \{\s*\n\s*try \{ return ACE_LOOKS\[spellKey\(item\?\.name\)\] \?\? null;/.test(anim));
  check("a spell with ACE's look is ACE's to animate, so Automated Animations is stopped for it",
    /if \(shape\) return \(animationFor\(item\) \|\| aceLookFor\(item\)\) \? "ace" : "automated-animations";/.test(anim));
  check("the silhouette plays on every target, after the record's clip",
    /for \(const t of aimed\) any = AceFX\.silhouetteBroadcast\(t, DAMAGE_THEME\[look\.silhouette\]\) \|\| any;/.test(anim)
      && /await seq\.play\(\);[\s\S]{0,260}playLook\(\);/.test(anim));
  check("and alone when there is no record at all",
    /if \(!anim && look\) \{[\s\S]{0,220}return playLook\(\);/.test(anim));
  check("the silhouette is the crust masked to the token's own picture, and it is back",
    /static encrust\(token, opts = \{\}\)/.test(fx) && /mask = new PIXI\.Sprite\(tex\);/.test(fx));
  check("it plays no sound of its own and reaches every screen",
    /static silhouetteBroadcast\(token, color = DAMAGE_THEME\.cold\)/.test(fx)
      && /action: "aceFx:silhouette"/.test(fx) && /payload\?\.action === "aceFx:silhouette"/.test(fx)
      && !/_playSound/.test(fx.slice(fx.indexOf("static silhouetteBroadcast"), fx.indexOf("// Play a one-shot sound LOCALLY"))));
  check("the record's own size and mask travel with it",
    /size:\s+Number\(opt\.size \?\? 1\) \|\| 1,/.test(rec) && /masked:\s+!!opt\.isMasked,/.test(rec));
  check("a clip that belongs on the creature is fitted to its square: a look, a masked record, a condition badge",
    /const fitted = onTarget && \(!!look \|\| !!o\.masked \|\| CONDITION_FAMILY\.test\(String\(anim\.path \?\? ""\)\)\);/.test(anim)
      && /if \(fitTo\) \{\s*\n\s*e\.scaleToObject\(o\.size \|\| 1\);\s*\n\s*if \(o\.masked\) e\.mask\(fitTo\);/.test(anim),
    "never 30 feet");
  check("Cure Wounds is untouched: an unmasked, non-condition record with no look still plays as it did",
    /\} else if \(o\.scale && o\.scale !== 1\) e\.scale\(o\.scale\);/.test(anim), "done, do not touch");
}

console.log("\n2. CHARM PERSON: THE JB2A HEARTS, AND NO BROKEN PICTURE");
{
  check("charmed is left to JB2A, and ACE draws nothing for it",
    /export const LEFT_TO_JB2A = new Set\(\["charmed"\]\);/.test(vis)
      && /export function aceDrawsOnBody\(status\) \{\s*\n\s*return BODY_VISUAL_STATUSES\.has\(status\) && !LEFT_TO_JB2A\.has\(status\);/.test(vis)
      && !/if \(has\("charmed"\)\) \{/.test(vis) && !/charmed:\s*\{ tint/.test(vis));
  check("Foundry's square stays off a charmed token",
    /"frightened", "blinded", "charmed", "unconscious"/.test(vis)
      && /for \(const s of \(st \?\? \[\]\)\) if \(BODY_VISUAL_STATUSES\.has\(s\)\) return true;/.test(main));
  check("Charm Person's JB2A clip is no longer refused at the cast, so no flourish stands in for it",
    /const drawn = conditionStatuses\(key\)\.filter\(s => aceDrawsOnBody\(s\)\);/.test(anim));
  check("Automated Animations' own Charmed hearts play on the first charm",
    /const drawn = statuses\.filter\(s => aceDrawsOnBody\(s\)\);/.test(main)
      && /if \(!already\) return;\s+\/\/ its first source: AA plays it/.test(main)
      && /const drawn = statuses\.filter\(s => aceDrawsOnBody\(s\)\);/.test(anim));
  check("and a second charm on the same creature starts no second clip (his rule, 2026-09-30)",
    /\.some\(e => !e\.disabled && jb2a\.some\(s => e\.statuses\?\.has\?\.\(s\)\)\)/.test(main)
      && /if \(!jb2a\.length \|\| !others\.some\(e => jb2a\.some\(s => e\.statuses\?\.has\?\.\(s\)\)\)\) return;/.test(anim));
  check("the header falls back to the spell's own icon when the caster's portrait is missing",
    /const img = face \|\| fallbackImg \|\| "";/.test(save)
      && /data-ace-fallback="\$\{esc\(fallbackImg\)\}"/.test(save)
      && /src="\$\{img\}"\$\{fallbackAttr\} alt=""/.test(save));
  check("every ACE card's pictures are guarded, in the one chrome pass",
    /skinSystemCard\(message, el\);[^\n]*\n\s*guardCardImages\(message, el\);/.test(utils));
}

/* The picture guard, run: a missing picture is swapped or taken off, and said. */
console.log("\n2b. THE PICTURE GUARD, RUN");
{
  globalThis.game = { user: { isGM: true }, release: { generation: 13 } };
  globalThis.foundry = { utils: { escapeHTML: (s) => String(s) } };
  globalThis.Hooks = { on() {}, once() {} };
  globalThis.ui = {};
  const U = await import("../scripts/chat-render-utils.mjs");
  const warned = [];
  const keepWarn = console.warn, keepLog = console.log;
  // Only the guard's own lines are caught; the checks below still print.
  const quiet = (fn) => { console.warn = (...a) => warned.push(a.join(" ")); console.log = () => {};
    try { return fn(); } finally { console.warn = keepWarn; console.log = keepLog; } };
  const img = (src, attrs = {}) => {
    const listeners = {};
    const el = {
      _attrs: { src, ...attrs }, dataset: {}, removed: false, complete: false, naturalWidth: 0, currentSrc: "",
      getAttribute(k) { return this._attrs[k] ?? null; },
      setAttribute(k, v) { this._attrs[k] = v; },
      removeAttribute(k) { delete this._attrs[k]; },
      hasAttribute(k) { return k in this._attrs; },
      addEventListener(t, fn) { listeners[t] = fn; },
      fail() { listeners.error?.(); },
      remove() { this.removed = true; },
    };
    return el;
  };
  const card = (imgs) => ({ querySelectorAll: () => imgs, getAttribute: () => null });
  const message = { id: "m1", flags: { "ace-qol": { type: "saveResults" } } };

  const lamia = img("worlds/hijinx/Lamia 03.png", { "data-ace-fallback": "icons/charm-person.webp" });
  const target = img("worlds/hijinx/Jeth.png");
  const die = img("modules/ace-qol/Assets/BD20-7.png", { onerror: "this.style.display='none'" });
  quiet(() => { U.guardCardImages(message, card([lamia, target, die])); lamia.fail(); });
  check("a missing caster portrait is swapped for the spell's own icon",
    lamia._attrs.src === "icons/charm-person.webp" && !lamia.removed && !("data-ace-fallback" in lamia._attrs));
  check("and the missing path is said once in the console",
    warned.filter(w => w.includes("Lamia 03.png")).length === 1, warned.join(" | "));
  const missing = img("worlds/hijinx/Ghost.png");
  quiet(() => { U.guardCardImages(message, card([missing])); missing.fail(); });
  check("a missing portrait with no fallback is left out", missing.removed === true);
  const again = img("worlds/hijinx/Lamia 03.png", { "data-ace-fallback": "icons/charm-person.webp" });
  quiet(() => U.guardCardImages({ id: "m2", flags: { "ace-qol": { type: "x" } } }, card([again])));
  check("a path already known to be missing is swapped before the browser asks for it again",
    again._attrs.src === "icons/charm-person.webp"
      && warned.filter(w => w.includes("Lamia 03.png")).length === 1);
  check("a picture that is there is left alone", target.removed === false && target._attrs.src === "worlds/hijinx/Jeth.png");
  check("the d20 face keeps its own onerror", die.dataset.aceImgGuard === undefined && die.removed === false);
}

console.log("\n3. LUCKY: ONE BOX, AND ONLY WHEN THE ROLL FAILED");
{
  const roll = save.slice(save.indexOf("async _rollPcSave(message"), save.indexOf("_onPcSaveResultPosted(resultFlags) {"));
  check("the player's save no longer judges itself against a DC it does not have",
    !/passed = saveTotal >= saveDC;/.test(roll)
      // (and since the offline Charm Person, it hands over the DC it does have)
      && /passed = \(await askVerdict\(\{ messageId: message\.id \?\? null, total: saveTotal,\s*\n\s*dc: _dcInHand \}\)\)\?\.passed \?\? null;/.test(roll));
  check("the screen that holds the DC answers; a player's asks the GM's, privately",
    /if \(here !== null\) return \{ passed: Number\(total\) >= here \};/.test(verdict)
      && /type: "aceVerdictAsk"[\s\S]{0,120}\{ recipients: \[gm\.id\] \}/.test(verdict)
      && /type: "aceVerdictAnswer", requestId: data\.requestId, passed \}, \{ recipients: \[senderId\] \}/.test(verdict));
  check("and only the roller's own question, a few times a prompt",
    /if \(!actor\.testUserPermission\?\.\(sender, "OWNER"\)\)/.test(verdict) && /const MAX_ASKS_PER_PROMPT = 4;/.test(verdict));
  check("the verdict door is registered at start-up, in its own try",
    /try \{ Verdict\.register\(\); \}/.test(main));
  check("Lucky asks only when the GM's verdict says it failed",
    /: \(passed === false && t <= rolledTotal\)\s*\n\s*\? \{ fails: true, words: "failed" \}/.test(roll)
      && /\{ fails: null, words: "" \}/.test(roll)
      && /if \(now\.fails == null\) \{ skip\(actor, `nobody could say whether the \$\{kind\} failed/.test(luck));
  check("a roll nobody judged shows the die and no word, and sends no signal",
    /const noWord = passed === null && !autoFailSave;/.test(roll) && /if \(targetActor && passed !== null\) \{/.test(roll));
  check("the one box spends, rolls the luck die and asks which die, itself",
    /static _luckRollInTheBox\(dlg, \{ luckRoll, luckItemUuid, settle, setOnClose \}\)/.test(reng)
      && /spent = luckItemUuid \? await spendLuckByUuid\(luckItemUuid\) : false;/.test(reng)
      && /fresh = await rollLuckDie\(actor, luckRoll\.label \?\? "Lucky"\);/.test(reng)
      && /const offer = luckChoices\(luckRoll, fresh\);/.test(reng));
  check("closing it after the point is spent keeps the roll, and is not a second offer",
    /setOnClose\(\(\) => settle\(true, \{ luckSpent: true, fresh, choice: null \}\)\);/.test(reng));
  check("the old \"which d20?\" dialog is not asked for any more",
    !/askChoice|type: "luckyChoice"/.test(luck));
  check("the player's screen does not spend a second point after the box spent one",
    /if \(result\?\.accepted && payload\.promptData\?\.luckItemUuid && !result\.choiceData\?\.luckSpent\) \{/.test(reng));
  check("the 7 still does not replace the 20: the kept die is whatever he picked",
    /\} else \{\s*\n\s*face = Number\(ask\.choice\);\s*\n\s*\}/.test(luck) && /else if \(ask\.choice == null\)/.test(luck));
}

console.log("\n4. THE DAMAGE CARD");
{
  const rowWho = /<div class="ace-qol-save-result-row ace-qol-save-row \$\{nameClass\}" data-token-doc-id="\$\{r\.tokenDocId\}">\s*\n[^\n]*\n\s*<img src="\$\{r\.img \|\| "icons\/svg\/mystery-man\.svg"\}" class="ace-qol-save-tgt-img ace-qol-save-portrait ace-face" \/>/g;
  const both = [...save.matchAll(/<div class="ace-qol-save-result-row ace-qol-save-row \$\{nameClass\}"/g)].length;
  check("both damage-row builders draw the save card's own row and square portrait",
    both === 2 && /<div class="ace-qol-save-row-who">\s*\n\s*<img src="\$\{r\.img \|\| "icons\/svg\/mystery-man\.svg"\}" class="ace-qol-save-tgt-img ace-qol-save-portrait ace-face" \/>/.test(save),
    `${both} builder(s)`);
  void rowWho;
  check("no portrait on the save card is a 24px circle any more",
    !/class="ace-qol-save-tgt-img ace-face"\s*\n\s*style="width:24px;height:24px;border-radius:50%/.test(save));
  check("the damage portrait's own class is square, so nothing round can win",
    /\.ace-qol-dmg-tgt-img \{\s*\n\s*width: 56px; height: 56px; border-radius: 8px;/.test(css)
      && /\.ace-qol-save-tgt-img \{\s*\n\s*grid-area: img;[^}]*border-radius: 4px;/.test(css));
  check("the whole name, wrapped, never \"Vilnius the Imp o…\"",
    /\.ace-qol-save-row \.ace-qol-save-tgt-name \{[^}]*white-space: normal;[^}]*text-overflow: clip;/.test(css));
  const wire = save.slice(save.indexOf("    // ── Apply All / Undo All ──"), save.indexOf("  //  Refresh Target List from Canvas Selection"));
  check("APPLY and UNDO are drawn from one state, applied or not, on every render",
    /const showState = \(applied\) => \{/.test(wire) && /showState\(!!flags\.applied\);/.test(wire));
  check("UNDO hands APPLY back, and APPLY applies again",
    /await this\._undoAllSaveDamage\(message\);\s*\n\s*await message\.setFlag\(MODULE_ID, "applied", false\);\s*\n\s*showState\(false\);/.test(wire)
      && /await this\._applyAllSaveDamage\(message\);\s*\n\s*await message\.setFlag\(MODULE_ID, "applied", true\);\s*\n\s*showState\(true\);/.test(wire)
      && !/undoBtn\.textContent = "UNDONE/.test(wire));
  check("a second APPLY lands the same choices the row still shows",
    /if \(cachedValue === "removed"\) continue;/.test(save) && !/\/\/ Clear cache entry after applying/.test(save));
}

console.log("\n5. ONE TOKEN, ONE JOIN, AND ONLY BY SEEING SOMEBODY ON HIS SIDE");
{
  check("the tokens a creature must see are the ones it would be fighting",
    /const seats = combat\.combatants\.map\(c => c\.token\)\.filter\(Boolean\)\s*\n\s*\.filter\(t => PerceptionWatch\._onTheOtherSide\(t\)\);/.test(watch),
    "no chain through fellow monsters");
  check("a player's token, or one that is not hostile",
    /if \(tokenDoc\.actor\.hasPlayerOwner\) return true;/.test(watch)
      && /return d === \(D\.FRIENDLY \?\? 1\) \|\| d === \(D\.NEUTRAL \?\? 0\);/.test(watch));
  check("the tracker is read as it is now, before each creature",
    /if \(combat\.combatants\.some\(c => c\.tokenId === foe\.id\)\) continue;/.test(watch));
  check("one join pass at a time; one that arrives mid-pass runs once, after",
    /if \(PerceptionWatch\._joining\) \{\s*\n\s*PerceptionWatch\._joinAgain = \{ scene, opts \};/.test(watch));
  check("and a creature being rolled for is never rolled for twice, by either path",
    /if \(PerceptionWatch\._rolling\.has\(tokenDoc\.id\)\) \{/.test(watch));
  check("the line tells twins apart and finds the one it means",
    /return `\$\{name\} \(\$\{twins\.findIndex\(t => t\.id === tokenDoc\.id\) \+ 1\} of \$\{twins\.length\}\)`;/.test(watch)
      && /class="ace-perceived-token" data-token-doc-id=/.test(watch)
      && /registerChatCardHandler\(\(message, html\) => PerceptionWatch\.wireJoinLines\(message, html\), "join lines"\);/.test(watch));

  // The twin count, run on his scene's four Flameskulls.
  const src = watch.slice(watch.indexOf("  static _nameOnScene(tokenDoc) {"));
  const body = src.slice(0, src.indexOf("\n  }\n") + 4).replace(/^\s*static /, "function ");
  globalThis.foundry = { utils: { escapeHTML: (s) => String(s) } };
  const nameOnScene = new Function(`return (${body});`)();
  const skulls = [
    { id: "1tGM", name: "Flameskull", x: 5300, y: 10600 }, { id: "2Up4", name: "Flameskull", x: 5300, y: 6450 },
    { id: "NNN4", name: "Flameskull", x: 4700, y: 6500 }, { id: "dmKQ", name: "Flameskull", x: 4650, y: 10600 },
    { id: "naga", name: "Guardian Naga", x: 9400, y: 8400 },
  ];
  const parent = { tokens: { contents: skulls } };
  for (const t of skulls) t.parent = parent;
  check("his four Flameskulls read 1 to 4, top of the map down",
    ["2Up4", "NNN4", "dmKQ", "1tGM"].map(id => nameOnScene(skulls.find(t => t.id === id))).join(" | ")
      === "Flameskull (1 of 4) | Flameskull (2 of 4) | Flameskull (3 of 4) | Flameskull (4 of 4)");
  check("a creature with no twin is just its name", nameOnScene(skulls[4]) === "Guardian Naga");
}

console.log("\n6. CHARM PERSON ON AN OFFLINE PLAYER: ONE RESULT, FROM THE HEADER'S DC");
// His table, 2026-10-12: "Lamia cast Charm Person at Virric... DC 13 Wisdom. He is
// a PC whose owner is offline, so the GM rolled the save before the card was
// built. The die was 9 and his Wisdom is +1. The card printed '9 + 1 =' and then
// nothing, and under it, in green, 'All targets resisted.' He was not charmed."
// Cause (PROVEN, his console): the GM rolls from a prompt built in memory, which
// carries the cast's DC and has no message id; askVerdict looked the DC up by id,
// found nothing, and the empty verdict was read downstream as "not failed".
{
  globalThis.game = { messages: { get: () => null }, users: { activeGM: { id: "gm" } }, user: { id: "gm", isGM: true } };
  const { askVerdict } = await import("../scripts/road/verdict.mjs");
  const keepWarn = console.warn; const warned = [];
  console.warn = (...a) => warned.push(a.join(" "));
  const ten = await askVerdict({ messageId: null, total: 10, dc: 13 });
  const seventeen = await askVerdict({ messageId: null, total: 17, dc: 13 });
  const nothing = await askVerdict({ messageId: null, total: 10, dc: null });
  console.warn = keepWarn;
  check("Virric's 9 + 1 = 10 against the header's DC 13, on the offline roll: a fail", ten?.passed === false, JSON.stringify(ten));
  check("16 + 1 = 17 against 13: resisted", seventeen?.passed === true, JSON.stringify(seventeen));
  check("with no DC anywhere it says so, and does not invent a verdict",
    nothing === null && warned.some(w => /carries a DC here, so pass or fail/.test(w)), warned.join(" | "));

  const roll = save.slice(save.indexOf("async _rollPcSave(message"), save.indexOf("_onPcSaveResultPosted(resultFlags) {"));
  check("the roll hands askVerdict the DC its own prompt carries, every time it asks",
    /const _dcInHand = \(saveDC === null \|\| saveDC === undefined \|\| saveDC === ""/.test(roll)
      && (roll.match(/askVerdict\(\{ messageId: message\.id \?\? null, total: saveTotal,\s*\n\s*dc: _dcInHand \}\)/g) ?? []).length === 2);
  check("and the offline roll's prompt carries the same DC the header prints",
    /const _promptOpts = \{ saveAbility, saveDC, halfOnSave/.test(save)
      && /const \{ saveAbility, saveDC, halfOnSave, damageTypes, isSpell, castId, recipe = null \} = opts;\s*\n\s*const fakeMsg = \{ flags: \{ \[MODULE_ID\]: \{[\s\S]{0,260}saveAbility, saveDC, halfOnSave/.test(save));

  // A missing verdict is not a resist, on the card and in the applier.
  const src = save.slice(save.indexOf("  static _unjudged(r) {"));
  const body = src.slice(0, src.indexOf("\n  }\n") + 4).replace(/^\s*static /, "function ");
  const unjudged = new Function("SaveEngine", `return (${body});`)({ _isImmuneRow: (r) => r?.immune === true });
  check("a rolled row with neither pass nor fail is unjudged; a fail, a pass, a waiting row and an immune row are not",
    unjudged({ saveTotal: 10, passed: null }) === true && unjudged({ passed: false }) === false
      && unjudged({ passed: true }) === false && unjudged({ pending: true }) === false
      && unjudged({ passed: null, immune: true }) === false && unjudged({ noRoll: true }) === false);
  check("the card never says \"All targets resisted\" over a row nobody judged",
    /\} else if \(unjudged\.length\) \{\s*\n\s*actionsHtml = SaveEngine\._gmReasonLine\(/.test(save)
      && save.indexOf("} else if (unjudged.length) {") < save.indexOf("<i class=\"fas fa-shield-halved\"></i> All targets resisted"));
  check("the applier says out loud which saves it could not judge",
    /const unjudgedRows = results\.filter\(r => SaveEngine\._unjudged\(r\)\);/.test(save)
      && /A missing verdict is not a resist\./.test(save));
  check("the GM's side calls a missing verdict a missing verdict, never \"failed\"",
    /passed === true \? "saved" : passed === false \? "failed"\s*\n\s*: "none, so this save stays unjudged/.test(save));
  check("the cast card's own row shows no word for an unjudged save, not FAIL",
    /const unjudged = pcResult\.passed == null && !pcResult\.autoFailSave;/.test(save)
      && /const verdictText = unjudged \? "" : pcResult\.resultLabel/.test(save));
  check("and a total with no verdict is still readable on the black card",
    /\.ace-qol-save-neutral \{ color: #e8e6e0; \}/.test(css));
  check("a fail is the row the applier reads: the one test for a failed save",
    /static _failedTheSave\(r\) \{\s*\n\s*return !!r && r\.pending !== true && !r\.noRoll && r\.passed === false;/.test(save));
}

console.log("\n7. EVERY BONUS NAMED, AND A PLAYER'S OWN SAVE ON HIS OWN CARD");
// His rule, 2026-10-12: "The GM card prints '6 + 1 = 7'. The +1 is not named...
// 6 + 1 WIS = 7... The player card prints the die, the word FAIL... No formula and
// no total. This is his own save... Print the same line on his card... Name every
// bonus that way, on both cards, in capitals... One bare +1 is not an answer...
// A creature's bonus stays off the player card."
{
  const src = save.slice(save.indexOf("export function namedSaveSum("));
  const body = src.slice(0, src.indexOf("\n}\n") + 2).replace(/^export /, "");
  const keepWarn = console.warn; const warned = [];
  console.warn = (...a) => warned.push(a.join(" "));
  const named = new Function("MODULE_ID", `return (${body});`)("ace-qol");
  check("Virric's +1 is named: 6 + 1 WIS = 7",
    `6${named([{ name: "Wis", value: 1 }], 1)} = 7` === "6 + 1 WIS = 7", `6${named([{ name: "Wis", value: 1 }], 1)} = 7`);
  check("+1 WIS and +2 PROF print both, then the total",
    `6${named([{ name: "Wis", value: 1 }, { name: "Prof", value: 2 }], 3)} = 9` === "6 + 1 WIS + 2 PROF = 9");
  check("every ability in capitals, and a minus says minus",
    named([{ name: "Str", value: 3 }, { name: "Dex", value: -1 }, { name: "Con", value: 2 },
      { name: "Int", value: 1 }, { name: "Cha", value: 4 }], 9) === " + 3 STR − 1 DEX + 2 CON + 1 INT + 4 CHA");
  check("a part worth nothing is not printed", named([{ name: "Wis", value: 0 }, { name: "Prof", value: 2 }], 2) === " + 2 PROF");
  check("a buff's own die is named by the buff (Bless)",
    named([{ name: "Wis", value: 1 }], 4, { saveBonuses: [{ label: "Bless", value: "1d4" }] }) === " + 1 WIS + 3 BLESS");
  check("cover and an item are named in capitals too",
    named([{ name: "Dex", value: 2 }, { name: "Cover", value: 2 }, { name: "Cloak", value: 1 }], 5) === " + 2 DEX + 2 COVER + 1 CLOAK");
  named([{ name: "Wis", value: 1 }], 3, { who: "Virric's" });
  console.warn = keepWarn;
  check("anything no part names is said in the console, not passed off as a part",
    warned.some(w => /Virric's save added \+2 that none of its recorded parts names/.test(w)), warned.join(" | "));

  check("the save card's row, both damage rows, the player's own card and the cast card's row all name it",
    /namedSaveSum\(_reading\.parts, modifier, \{ who: r\.name \?\? "", saveBonuses: r\.saveBonuses \}\);\s*\n\s*d20El = aceD20FaceImg\(d20Face, \{ size: 40 \}\);/.test(save)
      && (save.match(/const rollDisplay = SaveEngine\._damageRowRoll\(r, passClass, opts\);/g) ?? []).length === 2
      && /const _bdPart = \(_bdMod != null && _bdMod !== 0\)\s*\n\s*\? namedSaveSum\(_parts, _bdMod,/.test(save)
      && /const mp = namedSaveSum\(f\?\.saveParts, mod,/.test(save));
  check("and the sum is the roller's, not a d20's: wrapped as theirs on every card",
    (save.match(/saveBonusSpan\(/g) ?? []).length >= 4
      && !/bonusSpan\(`<span class="ace-qol-save-math-mod">/.test(save.replace(/saveBonusSpan\(/g, "SBS(")));

  // The one function, run: a party member's own sum stays on the table's copy,
  // a creature's goes to the GM.
  globalThis.foundry = { utils: { randomID: () => Math.random().toString(36).slice(2, 10),
    deepClone: (x) => JSON.parse(JSON.stringify(x)), escapeHTML: (s) => String(s) } };
  const { splitHtml } = await import("../scripts/road/table-view.mjs");
  const row = (who) => `<div class="ace-qol-save-row-result"><span class="ace-qol-save-math"><span class="ace-qol-save-math-die">6</span>`
    + `<span class="ace-qol-save-bonus" data-bonus-actor="${who}"><span class="ace-qol-save-math-mod"> + 1 WIS = </span>`
    + `<span class="ace-qol-save-fail ace-qol-save-math-total">7</span></span></span><span class="ace-qol-save-verdict ace-qol-save-fail">FAIL</span></div>`;
  const isTable = (id) => id === "virric";
  const party = splitHtml(row("virric"), { isTable });
  const creature = splitHtml(row("lamia"), { isTable });
  check("Virric's own 6 + 1 WIS = 7 stays on every copy of the card, FAIL after it",
    /\+ 1 WIS = <\/span><span[^>]*>7<\/span>/.test(party.html) && /FAIL/.test(party.html) && !(party.slots ?? []).length);
  check("a creature's sum is cut to the GM's screen; the table keeps the die and the word",
    !/WIS/.test(creature.html) && /FAIL/.test(creature.html) && /6<\/span>/.test(creature.html)
      && (creature.slots ?? []).some(sl => sl.aud === "gm" && /\+ 1 WIS = /.test(sl.html)));
  const qolTv = read("scripts/road/table-view.mjs");
  const forgeTv = readFileSync(new URL("../../ace-artificer/scripts/table-view.mjs", import.meta.url), "utf8");
  check("both copies of the one function treat it the same way",
    /"ace-qol-save-bonus",\s*\n\]\);/.test(qolTv) && /"ace-qol-save-bonus",\s*\n\]\);/.test(forgeTv));
  check("and each screen shows it on the same test: the GM, or a party member's own",
    /for \(const el of \(root\?\.querySelectorAll\?\.\("\.ace-qol-save-bonus"\) \?\? \[\]\)\) \{\s*\n\s*decide\(el, el\.dataset\?\.bonusActor \?\? ofCard\);/.test(utils)
      && /const mine = game\.user\?\.isGM \|\| isPartyActor\(id\);/.test(utils));
  check("no size changed: the new wrapper only shows and hides",
    /\.ace-qol-save-bonus \{ display: none !important; \}\s*\n\.ace-qol-save-bonus\[data-ace-bonus="show"\] \{ display: inline !important; \}/.test(css)
      && !/\.ace-qol-save-bonus(?![-\w])[^{]*\{[^}]*font-size/.test(css));
  check("no DC was added to the player's card", !/saveBonusSpan\([^)]*DC/.test(save));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
