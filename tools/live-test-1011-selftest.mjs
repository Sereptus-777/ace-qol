// ─── The live test of 2026-10-11, pinned ────────────────────────────────────
//
// Four things he found on a player's screen the afternoon the one function
// (scripts/road/table-view.mjs) went in. The rule did not change; these are the
// places that broke it or read wrong.
//
//   1. "A party member's save row is the die and PASS or FAIL. Jeth and the
//       Steel Defender are showing Dex, proficiency, cover, and 9 + 11 = 20 on
//       the player's screen. That is not the spell. Chudd's DC 17 stays."
//   2. "Roll Damage dies after the first roll, whoever pressed it... One result.
//       A second press does nothing."
//   3. "Fist shows a die reading 18 and HIT, so the table reads it as a total...
//       the words are 'Rolled an 18 and hit.' ... My card stays the math."
//   4. "Cure Wounds is saying the name on one row and +13 again under it. Both
//       cards... drop the big second +13. The bottom line reads '+13 healing' in
//       the same size and color as the line around it. My card still shows the
//       hit points. The player's does not."
//
// And the second pass the same afternoon: the table's attack card top to bottom
// (the attacker's square portrait and "Attacks Jeth.", the die and "Rolled a 13
// and hit." with the yellow 13 in the sentence, the target's square portrait,
// name and word); the table's damage card without its dice row, titled
// "Shield Guardian's fist damage"; an applied pill in blood red; "+10 healing"
// green at the header's size; every portrait square.
//
// And the third: Cure Wounds lands nothing until the GM presses Apply, with X,
// ¼, ½, 1 and 2 in green on the GM's card alone; the portrait, the name and
// "+12 healing" half again as big; the attacker's portrait bigger, "Attacks
// Jeth" a little bigger, the sentence one character off the die; and the GM's
// attack card wears the same header as the table's, with the math under it.
//
// And his standing rule, the same evening: "There is one way to build a thing...
// The healing controls broke it. They are the damage controls. Copy that row."
// So the heal card's GM half IS the damage card's: × ¼ ½ 1 2, the hit points,
// APPLY ALL and UNDO ALL, by the damage card's own classes, green only.
//
//   node tools/live-test-1011-selftest.mjs

import { readFileSync } from "node:fs";
import { attackSentenceHtml } from "../scripts/chat-render-utils.mjs";

let pass = 0, fail = 0;
const words = (html) => String(html ?? "").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
const check = (label, ok, note = "") => {
  if (ok) pass++; else fail++;
  console.log(`${ok ? "  ok  " : "  FAIL"} ${label}${note ? `  (${note})` : ""}`);
};
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const save = read("scripts/save-engine.mjs");
const view = read("scripts/road/table-view.mjs");
const utils = read("scripts/chat-render-utils.mjs");

console.log("\n1. A PARTY MEMBER'S SAVE ROW IS THE DIE AND THE WORD");
{
  check("a d20's wrapper is the GM's, whoever it names",
    /if \(D20_CLASSES\.some\(c => cls\.has\(c\)\)\) return "gm";/.test(view), "the pill and the bonus");
  check("a d20's numbers in the flags are the GM's too",
    /ROLL_FLAG_KEYS\.has\(key\)\) return "gm";/.test(view), "saveTotal, saveParts, attackTotal");
  check("a party caster's DC still goes by its caster", /if \(DC_FLAG_KEYS\.has\(key\)\) return caster;/.test(view),
    "Chudd's DC 17 stays");
  check("the GM's screen alone shows a bonus wrapper",
    /if \(game\.user\?\.isGM\) el\.dataset\.aceBonus = "show";/.test(utils));
  // ⚠️ 2026-10-12, his rule: a party member's own save shows its named sum to the
  // whole table ("Do not hide Virric's Wisdom from Virric"); a creature's stays
  // the die alone on a player's screen.
  check("a player's redraw of a creature's save row draws the die and nothing else",
    /if \(!game\.user\?\.isGM && !isPartyActor\(f\?\.actorId \?\? null\)\) \{\s*return face == null \? ""/.test(save));
  check("a player's save still counts Bless: read from the sheet when the card no longer carries it",
    /CombatState\.assess\(_caster, _tok, _item, \{ saveAbility: ability/.test(save)
      && /const allBonusParts = _bonuses\.map\(b => b\.value\);/.test(save));
  check("the GM reads a player's result after its numbers are back",
    /game\.messages\?\.get\(message\.id\)\?\.flags\?\.\[MODULE_ID\] \?\? flags\), 200\)/.test(save));
}

console.log("\n2. ROLL DAMAGE: ONE RESULT, WHOEVER PRESSED IT");
{
  const phase2 = save.slice(save.indexOf("  async _completeSaveResultsPhase2(message) {"),
    save.indexOf("  async _rollPhase2Damage(message, flags) {"));
  check("a card already rolling refuses before any die", /if \(flags\.damageRolling\) \{/.test(phase2));
  check("the card says it is rolling before the dice are thrown",
    phase2.indexOf("damageRolling`]: true") > -1
      && phase2.indexOf("damageRolling`]: true") < phase2.indexOf("await this._rollPhase2Damage"));
  check("every copy of the button is dead once the card says so",
    /if \(rollDmgBtn && flags\.damageRolling\) \{\s*rollDmgBtn\.disabled = true;/.test(save));
  check("a press on a card that already has its result does nothing",
    /if \(_now\.damageRolling \|\| _now\.phase !== 1 \|\| rollDmgBtn\.disabled\) \{/.test(save));
  check("a roll that ends without a result says so and gives the button back",
    /ended without a result/.test(phase2) && /-=damageRolling`\]: null/.test(phase2));
}

console.log("\n3. THE TABLE'S ATTACK LINE IS A SENTENCE ABOUT THE DIE");
{
  check("a hit", words(attackSentenceHtml(13, [{ hitResult: "hit" }])) === "Rolled a 13 and hit.");
  check("a miss", words(attackSentenceHtml(4, [{ hitResult: "miss" }])) === "Rolled a 4 and missed.");
  check("a crit", words(attackSentenceHtml(20, [{ hitResult: "critical" }])) === "Rolled a 20 and crit.");
  check("an 8, an 11 and an 18 take 'an'", words(attackSentenceHtml(8, [{ hitResult: "miss" }])).includes("an 8")
    && words(attackSentenceHtml(11, [{ hitResult: "hit" }])).includes("an 11")
    && words(attackSentenceHtml(18, [{ hitResult: "hit" }])).includes("an 18"));
  check("targets that came out differently: the die alone, each row says its own word",
    words(attackSentenceHtml(11, [{ hitResult: "hit" }, { hitResult: "miss" }])) === "Rolled an 11.");
  check("never a total in it", !/=|\+/.test(words(attackSentenceHtml(18, [{ hitResult: "hit" }]))));
  check("the yellow number is in the sentence, in the die number's own class",
    /Rolled a <span class="ace-qol-atk-d20-result">13<\/span> and hit\./.test(attackSentenceHtml(13, [{ hitResult: "hit" }])));
  check("it is the table's, and steps aside on the GM's screen",
    /ace-qol-table-only/.test(attackSentenceHtml(18, [{ hitResult: "hit" }]))
      && /querySelectorAll\?\.\("\.ace-qol-table-only"\)/.test(utils)
      && /\.ace-qol-table-only\[data-ace-gm="true"\] \{ display: none !important; \}/.test(read("styles/ace-qol.css")));
  const atk = read("scripts/attack-pipeline.mjs");
  const tableCard = atk.slice(atk.indexOf("const tableCard = `"), atk.indexOf("const cardHtml = `"));
  check("the table's card is its own block, and the GM's card is the GM half",
    /<div class="ace-qol-atk-table ace-qol-table-only">/.test(tableCard)
      && /\$\{tableCard\}\s*<div class="ace-qol-gm-only ace-qol-block">/.test(atk));
  check("its header is the attacker's portrait and 'Attacks <the target>.', nothing else",
    /const _attackerFace = faceOf\(actor\);/.test(atk) && /\$\{_attackerPortrait\}\s*\$\{_attacksLine\}/.test(tableCard)
      && /Attacks \$\{_whom\}\./.test(atk)
      && !/item\.name|atk-info-toggle|rollModeLabel/.test(tableCard));
  check("under it the die, with no number beside it, then the sentence; no portrait on that row",
    /<i class="fas fa-dice-d20 ace-qol-atk-d20-fallback" style="display:none"><\/i>\s*<\/span>\s*\$\{attackSentenceHtml\(d20, results\)\}/.test(tableCard));
  check("the target's row: square portrait, name, the word on the right, no AC",
    /const table = `[\s\S]*?ace-qol-atk-portrait[\s\S]*?ace-qol-atk-table-name[\s\S]*?ace-qol-atk-result \$\{hitClass\}/.test(atk)
      && !/const table = `[^`]*acDisplay/.test(atk));
  check("the GM's card wears the same header: the attacker, not the weapon's picture or name",
    /<div class="ace-qol-gm-only ace-qol-block">\s*<div class="ace-qol-atk-header">\s*\$\{_attackerPortrait\}\s*\$\{_attacksLine\}/.test(atk)
      && !/class="ace-qol-atk-item-img"/.test(atk));
  check("the GM's card keeps the math, with no sentence in it",
    /const formulaStr = _die \+ \(_maths \? ` \$\{bonusSpan\(_maths, _atkWhose\)\}` : ""\);/.test(atk));
  check("the merged card says it the same way", /\$\{d20Html\}\$\{attackSentenceHtml\(d20, attackData\.results\)\}/.test(read("scripts/merge-card.mjs"))
    && /ace-qol-atk-d20-result ace-qol-gm-only/.test(read("scripts/merge-card.mjs")));
  check("in the left three quarters", /\.ace-qol-atk-table-line \{[^}]*max-width: 75%;/.test(read("styles/ace-qol.css")));
}

console.log("\n4. CURE WOUNDS: ONE +10, GREEN, THE HEADER'S SIZE");
{
  const heal = read("scripts/spell-pipeline/resolvers/heal.mjs");
  check("the big second number is gone", !/numberCol/.test(heal) && !/font-size:18px;font-weight:700;color:\$\{accent\};">\+/.test(heal));
  check("the line reads '+12 healing'", /: `\+\$\{n\} healing`;/.test(heal));
  check("green, half again as big: the words 22.5px, the name 21px, the portrait 54",
    /const saidStyle = `font-size:22\.5px;font-weight:700;color:\$\{accent\};/.test(heal)
      && /font-weight:600;font-size:21px;/.test(heal) && /width:54px;height:54px;border-radius:4px;/.test(heal));
  check("the hit points are the GM's, under the row, in the damage card's hit-point line",
    /<div class="ace-qol-dmg-hp-line"><span class="ace-qol-dmg-row-hp ace-qol-heal-hp">\$\{hp\}<\/span><\/div>/.test(heal));
  check("the portrait is square", !/border-radius:50%/.test(heal));
  const healStep = heal.slice(heal.indexOf("static async _heal("), heal.indexOf("static async _postChatCard("));
  check("nothing lands when it is cast: the hit-point door is not in the cast",
    !/HpDoor\.heal|ConditionDoor\.remove/.test(healStep));
  check("it lands on the GM's APPLY ALL, once, through the hit-point door",
    /static async _applyAll\(message\)/.test(heal) && /await HpDoor\.heal\(actor, amount,/.test(heal)
      && /if \(HealResolver\._applying\.has\(message\.id\) \|\| flags\.rows\.every\(r => r\.applied\)\)/.test(heal));
  check("the damage card's row: ×, ¼, ½, 1, 2 in its own classes, 1 picked, × applies none",
    /<div class="ace-qol-dmg-ovr-line">\$\{scale\(0, "×"\)\}\$\{scale\(1, "¼"\)\}\$\{scale\(2, "½"\)\}\$\{scale\(3, "1"\)\}\$\{scale\(4, "2"\)\}<\/div>/.test(heal)
      && /k === 0 \? "ace-qol-dmg-ovr-x" : "ace-qol-dmg-ovr"/.test(heal)
      && /const picked = r\.applied \? Number\(r\.mult \?\? 1\) : 1;/.test(heal)
      && /const landed = \(mult !== 0\)/.test(heal));
  check("then APPLY ALL and UNDO ALL, in the damage card's own row and buttons",
    /<div class="ace-qol-dmg-actions">/.test(heal) && /class="ace-qol-btn ace-qol-btn-apply/.test(heal)
      && /class="ace-qol-btn ace-qol-btn-undo" data-action="aceQolHealUndoAll"/.test(heal));
  check("UNDO ALL takes each applied row's healing back once, through the hit-point door",
    /static async _undoAll\(message\)/.test(heal) && /await HpDoor\.takeBack\(actor, row\.landedAmount/.test(heal)
      && /static async takeBack\(actor, amount/.test(read("scripts/road/doors.mjs")));
  check("and no second, invented row is left anywhere",
    !/ace-qol-heal-ctl/.test(heal) && !/ace-qol-heal-ctl/.test(read("styles/ace-qol.css")));
  check("scaled the way damage is", /const amount = shareOf\(row\.rolled, mult\);/.test(heal));
  check("the controls are the GM's half: the player does not get that row",
    /const controls = `<div class="ace-qol-dmg-gm-controls">`/.test(heal)
      && /const actions = `<div class="ace-qol-dmg-gm-controls"><div class="ace-qol-dmg-actions">`/.test(heal)
      && /!game\.user\?\.isGM\) return;/.test(heal));
  check("green, not the damage colours: colour is all the heal card changes",
    /\.ace-qol-heal-result \.ace-qol-dmg-ovr,\s*\.ace-qol-heal-result \.ace-qol-dmg-ovr-x \{[^}]*color: #7ec97e;/.test(read("styles/ace-qol.css"))
      && /\.ace-qol-heal-result \.ace-qol-btn-apply \{[^}]*color: #7ec97e;/.test(read("styles/ace-qol.css")));
}

console.log("\n5. THE DAMAGE CARD AND THE PORTRAITS");
{
  const dmg = read("scripts/damage-card-renderer.mjs");
  const css = read("styles/ace-qol.css");
  check("the dice row is the GM's card", /<div class="ace-qol-dmg-roll-section ace-qol-gm-only ace-qol-block">/.test(dmg));
  check("so is the dice note on the title row", /ace-qol-dmg-dice-note ace-qol-gm-only/.test(dmg));
  check("the title is whose and what with, on both cards",
    /DamageCardRenderer\.damageTitle\(item, actor\)/.test(dmg) && /return who \? `\$\{who\}'s \$\{what\} damage`/.test(dmg));
  check("a natural weapon reads in lower case: 'fist'", /const common = type\.value === "natural"/.test(dmg));
  check("an applied pill is blood red, letters light, line through",
    /\.ace-qol-dmg-type-applied \{[^}]*background: #8b0a0a !important;/.test(css)
      && /color: #f3ead7 !important;\s*text-decoration: line-through;/.test(css));
  check("the attacker's portrait is bigger, 'Attacks Jeth' a little bigger, the sentence off the die",
    /\.ace-qol-atk-portrait\.ace-qol-atk-attacker \{ width: 52px; height: 52px;/.test(css)
      && /\.ace-qol-atk-item-name\.ace-qol-atk-attacks \{ font-size: 1\.1rem;/.test(css)
      && /\.ace-qol-atk-table \.ace-qol-atk-table-line \{ margin-left: 1ch; \}/.test(css));
  check("no portrait on an attack card is round",
    !/\.ace-qol-atk-img \{[^}]*border-radius: 50%/.test(css) && /\.ace-qol-atk-portrait \{[^}]*border-radius: 4px;/.test(css));
}

console.log("\n6. THE PICKERS ALWAYS ASK, AND A SAVE THAT TOOK NOTHING HAS NO X");
{
  const pick = read("scripts/spell-target-picker.mjs");
  check("SpellTargetPicker: no skip, no memory, nothing selected, nobody out of range",
    !/aimedAtPress|game\.user\.targets|return \[chosen\[0\]\.actor\]|preSelected\.add\(/.test(pick)
      && /candidates = candidates\.filter\(c => c\.isSelf \|\| c\.inRange\);/.test(pick));
  const heal = read("scripts/heal-target-picker.mjs");
  check("HealTargetPicker: nothing lit, nobody out of range",
    !/preSelected\.add\(/.test(heal) && /distFt > classification\.rangeFt \+ 0\.01\) continue;/.test(heal));
  check("the X: open, a fail and a half keep it; a resolved row that takes nothing loses it",
    /if \(!r \|\| r\.pending\) return true;/.test(save) && /return SaveEngine\._rowWillTakeDamage\(r, halfOnSave\);/.test(save));
  check("the result row, the target list and the add-target rebuild all ask it",
    /canRemove: SaveEngine\._offersX\(r,/.test(save)
      && /const _castRemoveBtn = \(t, title\) => SaveEngine\._offersX\(/.test(save)
      && /const xFor = \(t, title = ""\) => SaveEngine\._offersX\(/.test(save)
      && !/<button class="ace-qol-save-tgt-remove"[^`]*>\s*<i class="fas fa-xmark"><\/i>\s*<\/button>\s*\$\{buildActionsRow/.test(save));
  check("and the card's own 'anyone takes damage' asks the same test",
    /const anyWillTakeDamage = hasDamage && results\.some\(r => SaveEngine\._rowWillTakeDamage\(r, halfOnSave\)\);/.test(save));
}

console.log("\n7. ONE CLIP AND ONE SOUND, ONCE, AT THE CAST");
// His rule: "A spell's sound and its animation fire once, at the cast. They do
// not fire when somebody rolls a save, and they do not fire when Lucky is
// dismissed... One owner per cast, decided before either plays, and the other
// one is actually stopped. A template spell stays Automated Animations'. A
// countered spell still plays nothing."
{
  const anim = read("scripts/animation/spell-animator.mjs");
  const helper = read("scripts/spell-pipeline/animation.mjs");
  const pipe = read("scripts/spell-pipeline/pipeline.mjs");
  const fx = read("scripts/ace-fx.mjs");

  check("the owner: a template spell is Automated Animations'",
    /if \(TEMPLATE_SHAPES\.has\(shape\)\) return "automated-animations";/.test(anim));
  // 2026-10-12: or ACE's own look for it (Frostbite's frost silhouette).
  check("ACE owns a cast only when it has that spell's clip to play",
    /if \(shape\) return \(animationFor\(item\) \|\| aceLookFor\(item\)\) \? "ace" : "automated-animations";/.test(anim),
    "stopping AA with nothing to play would leave the table with nothing");
  check("and Automated Animations is actually stopped for a cast ACE owns",
    /if \(whoOwnsThisCast\(subject, entry\) === "ace"\) \{\s*\n\s*data\.stopWorkflow = true;/.test(anim),
    "Cure Wounds' heal roll no longer plays AA's clip beside ACE's");
  check("an on-token clip lands on the target, not the caster",
    /const onTarget = anim\.category === "ontoken" && aim\.length;/.test(anim)
      && /if \(onTarget\) \{\s*\n\s*for \(const t of aim\) \{\s*\n\s*const e = seq\.effect\(\)\.file\(anim\.path\)\.atLocation\(t\);/.test(anim),
    "the second Cure Wounds clip landed off the target");
  check("ACE never calls Automated Animations itself",
    !/aa\.playAnimation|AutomatedAnimations\.playAnimation/.test(helper), "AA plays its own, once");
  check("the clip waits for the counter's answer, and a countered cast plays nothing",
    /await ReactionEngine\.awaitCastDecision\(/.test(helper) && /if \(decision\?\.abort \|\| ReactionEngine\.castIsDead\(/.test(helper));
  const at = pipe.indexOf("AnimationHelper.play(ctx, result)\n      .catch(");
  check("it starts at the cast, before the spell resolves and its saves are rolled",
    at > 0 && at < pipe.indexOf("await route.run(ctx, result);")
      && !/await AnimationHelper\.play\(ctx, result\);/.test(pipe), "not after the card");
  check("nothing in ace-fx listens for a cast or a save any more",
    !/Hooks\.(on|once)\(/.test(fx), "the flourish plays only when the animator asks for it");
  // 2026-10-12: the crust is back as Frostbite's own clip, at the cast, silent;
  // nothing fires it on a save and it plays no sound of its own.
  check("the crust on a failed save is gone, and its sound with it",
    !/encrustBroadcast|aceFx:encrust|ENCRUST_TYPES|_psfxFallbackSound|_recentEncrust/.test(fx)
      && !/Hooks\.(on|once)\(/.test(fx)
      && !/silhouetteBroadcast[\s\S]{0,900}?_playSound/.test(fx.slice(fx.indexOf("static silhouetteBroadcast"), fx.indexOf("static _playSound"))),
    "the Fireball sound on Firaxis's save");

  // And the same evening: "Charm Person, and any spell whose only clip is a
  // condition badge, still gets a flourish at the cast... Do not put the ring
  // back on a spell that already has its own clip."
  check("a spell whose only clip is a condition ACE draws gets the flourish in its place",
    /if \(drawn\) \{[\s\S]{0,500}?return AceFX\.castFlourish\(casterToken, item\);\s*\n\s*\}/.test(anim),
    "Charm Person: the hearts are ACE's, the badge does not play, the flourish does");
  {
    const { readdirSync } = await import("node:fs");
    const files = readdirSync(new URL("../scripts/", import.meta.url), { recursive: true })
      .filter(f => String(f).endsWith(".mjs")).map(f => `scripts/${String(f).split(String.fromCharCode(92)).join("/")}`);
    const callers = files.filter(f => /\bcastFlourish\(|\bflourishBroadcast\(/.test(read(f).replace(/static (castFlourish|flourishBroadcast)\(/g, "")))
      .filter(f => f !== "scripts/ace-fx.mjs");
    const animCalls = (anim.match(/AceFX\.castFlourish\(/g) ?? []).length;
    check("and nowhere else: a spell with its own clip never gets the ring",
      callers.length === 1 && callers[0] === "scripts/animation/spell-animator.mjs" && animCalls === 1,
      `asked for in: ${callers.join(", ") || "nothing"} (${animCalls} call)`);
  }
  check("it still answers to its switch, which names only what it switches",
    /if \(!AceFX\._enabled\(\)\) \{/.test(fx) && /name: "Spell Flourish",/.test(fx)
      && /whose only clip is a condition ACE draws/.test(fx) && !/Impact Effects/.test(fx));
}

console.log("\n8. THE LONG REST AND THE RATIONS CARD ON THE BLACK CARD");
{
  const css = read("styles/ace-qol.css");
  const clock = read("scripts/clock-wiring.mjs");
  check("a rest card is dressed by dnd5e's own type, \"rest\"",
    /const restType = type === "rest" \|\| type === "dnd5e\.rest";/.test(utils));
  check("and by the rest-card class on the card element itself",
    /el\?\.classList\?\.contains\?\.\("rest-card"\) \|\| el\?\.matches\?\.\("\.rest-card"\)/.test(utils));
  check("the background itself is painted black, not only the variable",
    /\.chat-message\[data-ace-skin="1"\] \{[^}]*background: #0e0e10 !important;/s.test(css),
    "a parchment image ignores the variable");
  check("and dnd5e's own card inside shows the black",
    /\[data-ace-skin="1"\] \.chat-card,\s*\.chat-message\[data-ace-skin="1"\] \.rest-card \{\s*background: none !important;/s.test(css));
  check("the rations whisper is the 'A new day' card: the same black box",
    /_mealCard[\s\S]*?background:#0f1014;border:1px solid #3a3122;border-left:4px solid #d4af37;/.test(clock));
  check("and it is marked as ACE's, the way 'A new day' is, so the whisper paper is gone",
    /flags: \{ \[MODULE_ID\]: \{ type: "rationsCard" \} \}/.test(clock));
}

console.log("\n9. THE HEAL CARD NAMES WHO DID IT");
{
  const heal = read("scripts/spell-pipeline/resolvers/heal.mjs");
  check("one line in the header that is already there: who cast it, on whom",
    /\$\{esc\(state\.casterName\)\} casts it on \$\{HealResolver\._namesOf\(rows\)\}\./.test(heal));
  check("the caster's name is the token's, as the table sees it",
    /casterName: caster\?\.token\?\.name \?\? caster\?\.getActiveTokens\?\.\(\)\?\.\[0\]\?\.name \?\? caster\?\.name \?\? ""/.test(heal));
  const headerLine = heal.split(/\r?\n/).find(l => l.includes("casts it on")) ?? "";
  check("no second portrait came with it",
    !/<img/.test(headerLine) && (heal.match(/<img /g) ?? []).length === 2
      && /<img src="\$\{state\.itemImg \|\| "icons\/svg\/heal\.svg"\}" style="width:24px;height:24px;/.test(heal),
    "the target's row and the spell's own icon, same place, same size");
  {
    // The names read as a sentence: "A", "A and B", "A, B and C".
    const src = heal.slice(heal.indexOf("static _namesOf(rows)"));
    const body = src.slice(0, src.indexOf("\n  }\n") + 4);
    const escapeHTML = (x) => String(x ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
    const fn = new Function("foundry", `return (${body.replace(/^static /, "function ")});`)({ utils: { escapeHTML } });
    const names = (...n) => fn(n.map(name => ({ name })));
    check("one target, two, three", names("Jeth") === "Jeth" && names("Jeth", "Chudd") === "Jeth and Chudd"
      && names("Jeth", "Chudd", "Firaxis") === "Jeth, Chudd and Firaxis",
      `${names("Jeth")} | ${names("Jeth", "Chudd")} | ${names("Jeth", "Chudd", "Firaxis")}`);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
