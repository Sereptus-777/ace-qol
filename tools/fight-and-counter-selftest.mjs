// ─── The morning of 2026-10-16: Counterspell, hidden NPCs, a fight found ────
//
// His table that morning:
//   • Firaxis's Cure Wounds posted +17 on Jeth BEFORE Vilnius's Counterspell was
//     decided. A player's cast had no Counterspell hold on the player's screen,
//     and heals, spell attacks and Spiritual Weapon's placement never asked.
//   • Logan could see Vilnius and his initiative. ACE's own add-to-combat code
//     wrote "hidden: no" for every visible token, and the hide rule honoured it.
//     His rule: "The PCs should never, ever see the NPCs in the combat tracker."
//   • Firaxis walked into a room of ten monsters while the temple fight ran, and
//     nothing happened. His design: the PLAYER who comes upon a fight is asked
//     Wait, Ready, Join, and Talk while the fight is NPCs only.
//
// Run: node tools/fight-and-counter-selftest.mjs
// ──────────────────────────────────────────────────────────────────────────────

import { readFileSync } from "fs";
import { fileURLToPath } from "url";

let passed = 0, failed = 0;
function check(label, ok, detail = "") {
  ok ? passed++ : failed++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${ok || !detail ? "" : `  (${detail})`}`);
}
const src = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const QOL = "../scripts/";

console.log("Counterspell, hidden NPCs, and a fight found");

// ── Counterspell: one wait, on the caster's own screen too ──
const re = src(`${QOL}reaction-engine.mjs`);
const preUse = re.slice(re.indexOf('Hooks.on("dnd5e.preUseActivity", (activity, usageConfig) => {'));
check("the caster's own screen raises the Counterspell hold, a player's included",
  !/^Hooks\.on\("dnd5e\.preUseActivity", \(activity, usageConfig\) => \{\s*\/\/[^\n]*\n\s*if \(!game\.user\.isGM\) return;/.test(preUse)
  && /ReactionEngine\._createCastBarrier\(activity\);/.test(preUse.slice(0, 900)));
const qol = src(`${QOL}ace-qol.mjs`);
check("the GM's verdict lets the player's hold go",
  /if \(act && !game\.user\.isGM\) ReactionEngine\._resolveCastBarrier\(act, payload\.result \?\? \{ abort: false \}\);/.test(qol));
check("one question for every spell path: levelled spells only, waiting for the verdict",
  /static async spellWasCountered\(activityOrUuid, \{ item = null, actor = null \} = \{\}\) \{[\s\S]{0,300}?Number\(it\.system\?\.level\) > 0[\s\S]{0,200}?awaitCastDecision\(/.test(re));
const heal = src(`${QOL}heal-pipeline.mjs`);
const healDoor = heal.slice(heal.indexOf("async _rollAndPostCard("), heal.indexOf("async _rollAndPostCard(") + 1600);
check("every heal card asks before a die is thrown, and a countered heal posts nothing",
  /if \(await ReactionEngine\.spellWasCountered\(activity, \{ item, actor \}\)\) \{[\s\S]{0,300}?return;/.test(healDoor)
  && healDoor.indexOf("spellWasCountered") < healDoor.indexOf("Build the heal Roll"));
// The audit of 2026-10-16: every path that acts on a spell and had never asked.
const asks = {
  "a spell attack": [`${QOL}attack-pipeline.mjs`, /spellWasCountered\(subject, \{ item, actor \}\)/],
  "Spiritual Weapon's placement": [`${QOL}spiritual-weapon.mjs`, /spellWasCountered\(activity, \{ item, actor: caster \}\)/],
  "Fly and Levitate lifting anyone": [`${QOL}flight-visuals.mjs`, /if \(await ReactionEngine\.spellWasCountered\(activity\)\) \{/],
  "a flight-control item lifting anyone": [`${QOL}flight.mjs`, /if \(await ReactionEngine\.spellWasCountered\(activity\)\) \{/],
  "the storm and whirlwind visuals": [`${QOL}storm-visuals.mjs`, /if \(await ReactionEngine\.spellWasCountered\(activity\)\) \{/],
  "Prismatic Wall asking who passes": [`${QOL}prismatic-wall-engine.mjs`, /ReactionEngine\.spellWasCountered\(String\(doc\?\.flags\?\.dnd5e\?\.origin/],
};
for (const [what, [file, rx]] of Object.entries(asks)) check(`${what} asks whether the spell was countered`, rx.test(src(file)));

// ── NPCs never shown to the players ──
const hook = qol.slice(qol.indexOf('Hooks.on("preCreateCombatant", (combatant, data) => {'), qol.indexOf("async function _hideNpcCombatantsAlreadyInFights"));
check("an NPC is hidden whoever adds it; no 'shown on purpose' exception", !/data\?\.hidden === false/.test(hook) && /data\.hidden = true;/.test(hook));
check("what a player owns stays visible, read off the token first",
  /if \(actor\.hasPlayerOwner\) return;/.test(hook) && /tokenDoc\?\.actor \?\? game\.actors\.get/.test(hook));
check("NPCs already in a running fight are hidden at start-up",
  /_hideNpcCombatantsAlreadyInFights\(\)\.catch\(/.test(qol) && /hidden: true \}\)\)/.test(qol));

// ── A fight found ──
const pw = src(`${QOL}perception-watch.mjs`);
const pwCode = pw.split("\n").filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
check("no check reads the fight off the GM's screen any more", !/game\.combat\b/.test(pwCode));
check("moving and opening a door both ask whether a player has come upon the fight",
  (pw.match(/return PerceptionWatch\._comesUpon\(scene, fight, /g) ?? []).length === 2);
check("the question goes to the character's connected player, else the GM",
  /const answerer = whoAnswers\(pc\.actor\);/.test(pw) && /answerer\.user\.query\(PerceptionWatch\.QUERY/.test(pw));
check("every screen can answer it", /CONFIG\.queries\["ace-qol\.comesUponFight"\] = \(data\) => PerceptionWatch\._comesUponQuery\(data\);/.test(pw)
  && /static QUERY = "ace-qol\.comesUponFight";/.test(pw));
check("Talk is offered only while the fight is NPCs only", /const talkTo = npcOnly \? \[\.\.\.seen, \.\.\.heard\] : \[\];/.test(pw));
check("Join rolls HIS initiative on his own screen, and answers after the dice land",
  /await pc\.actor\?\.rollInitiative\?\.\(\{ createCombatants: true \}\);\s*\/\/[^\n]*\n\s*\/\/[^\n]*\n\s*await awaitDiceSettle\(6000\);/.test(pw));
check("a player is asked once per fight", /fight\.setFlag\(MODULE_ID, "comesUponAsked"/.test(pw));
check("the GM is told what was chosen on the black ACE card", /await PerceptionWatch\._gmLine\(foundry\.utils\.escapeHTML\(said\)\);/.test(pw));

// ── Every popup holds the players until it is answered (his rule, 2026-10-16) ──
const lockHook = pw.slice(pw.indexOf('Hooks.on("preUpdateToken", (tokenDoc, changes) => {'), pw.indexOf('Hooks.on("pauseGame"'));
check("the GM's moves and ACE's automatic ones are never held", /if \(game\.user\.isGM\) return;/.test(lockHook));
check("in a running fight, the creatures in it are never held",
  /if \(fight && PerceptionWatch\._inFight\(fight, tokenDoc\)\) return;/.test(lockHook));
check("a quiet hold says nothing that gives the moment away", /"Hold on: the GM needs a moment\."/.test(lockHook));
check("a quiet GM popup holds, and lets go when answered",
  /\} else \{\s*\/\/[^\n]*\n\s*await PerceptionWatch\._hold\(scene, key\);/.test(pw)
  && /if \(kind !== "mutual"\) await PerceptionWatch\._release\(scene, key\);/.test(pw));
check("the player's fight popup holds everybody else until he answers, and always lets go",
  /await PerceptionWatch\._hold\(scene, holdKey\);/.test(pw) && /\} finally \{\s*await PerceptionWatch\._release\(scene, holdKey\);/.test(pw));
check("unpausing ends the sighting's hold only; an open question holds on",
  /PerceptionWatch\._releaseSeen\(canvas\?\.scene\)/.test(pw) && /if \(!now\.open\.length && !now\.seen && !now\.freeze\) await PerceptionWatch\._unlock\(scene\);/.test(pw));
check("the GM's lock stops every token on the scene, an NPC's too, before anyone is let through",
  lockHook.indexOf("lock?.freeze === true") > 0 && lockHook.indexOf("lock?.freeze === true") < lockHook.indexOf("if (game.user.isGM) return;"));
check("no question answered lets go of the GM's lock; only he does",
  /\{ seen: true, open: now\.open, freeze: now\.freeze \}/.test(pw) && /if \(!now\.open\.length && !now\.freeze\) return PerceptionWatch\._unlock\(scene\);/.test(pw));
check("the macro's switch: anything holding the scene is let go, otherwise it is locked",
  /static async toggleSceneLock\(scene = canvas\?\.scene\) \{[\s\S]{0,400}?if \(scene\.getFlag\?\.\(MODULE_ID, PerceptionWatch\.LOCK_FLAG\)\) \{\s*await PerceptionWatch\._unlock\(scene\);/.test(pw)
  && /sceneLock: \{ toggle: \(scene\) => PerceptionWatch\.toggleSceneLock\(scene\) \}/.test(qol));
check("a second GM screen loading cannot let go of a live hold",
  /if \(game\.users\?\.activeGM === game\.user\) \{\s*for \(const scene of \(game\.scenes \?\? \[\]\)\) \{\s*if \(!scene\.getFlag\?\.\(MODULE_ID, PerceptionWatch\.LOCK_FLAG\)\) continue;/.test(pw));

// The fight check itself, run on example fights.
const body = (() => {
  const start = pw.indexOf("static _fightOn(scene) {");
  let i = pw.indexOf("{", start), depth = 0, j = i;
  for (; j < pw.length; j++) { if (pw[j] === "{") depth++; else if (pw[j] === "}" && --depth === 0) break; }
  return pw.slice(i + 1, j);
})();
const fightOn = new Function("scene", "game", body);
const temple = { id: "temple" }, bridge = { id: "bridge" };
const fight = (id, sceneDoc, round, active, modified) => ({ id, scene: sceneDoc, round, started: round > 0, active, _stats: { modifiedTime: modified } });
let games = { combats: { contents: [fight("old", temple, 3, false, 100), fight("bridgeFight", bridge, 3, true, 200)] } };
check("his temple fight counts though Foundry has not marked it active", fightOn(temple, games)?.id === "old");
check("another scene's active fight is not this scene's", fightOn(bridge, games)?.id === "bridgeFight");
games = { combats: { contents: [fight("a", temple, 2, false, 300), fight("b", temple, 1, true, 100)] } };
check("the active fight comes first", fightOn(temple, games)?.id === "b");
games = { combats: { contents: [fight("prep", temple, 0, true, 300)] } };
check("a fight not yet started is no fight", fightOn(temple, games) === null);

// ── Engine: Talk opens the chat the one way it is opened ──
const eng = src("../../ace-engine/scripts/ace-engine.mjs");
const hooks = src("../../ace-engine/scripts/npc/ui-hooks.mjs");
check("Talk asks the chat button's own rules first", /const why = whyCannotTalk\(npcTokenDoc\?\.actor\);/.test(eng));
check("the chat button and Talk open the chat through one opener",
  /openNpcConversation\(tokenDoc, capturedPlayerToken\);/.test(hooks)
  && (hooks.match(/new ConversationApp\(/g) ?? []).length === 1);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
