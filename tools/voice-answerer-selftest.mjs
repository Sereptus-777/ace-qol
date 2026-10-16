// ─── One GM screen makes a player's NPC voice ────────────────────────────────
//
// Johnny, 2026-10-15: a second GM login on another screen had no ElevenLabs key
// (keys live in each browser, his rule 10-13). Every GM screen answered a
// player's voice request and the player took the first answer, so the keyless
// screen's instant "no key" beat the main screen's real voice. Two GMs with a
// key would each pay for the line and the table would hear it twice.
//
// This pins (ACE Engine, npc/voice-answerer.mjs, and its wiring):
//   • exactly one GM answers, and it is one that can make the voice;
//   • a screen without the key never answers while one with it is connected;
//   • when nobody can, one GM gives the honest error at once;
//   • a GM screen that has not said yet is never answered for with an error;
//   • the answer is decided before the spending limit, and is yes or no only.
//
// Run: node tools/voice-answerer-selftest.mjs
// ──────────────────────────────────────────────────────────────────────────────

import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { chooseVoiceAnswerer } from "../../ace-engine/scripts/npc/voice-answerer.mjs";

let passed = 0, failed = 0;
function check(label, ok, detail = "") {
  ok ? passed++ : failed++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${ok || !detail ? "" : `  (${detail})`}`);
}
const src = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const show = (p) => JSON.stringify(p);

console.log("Which GM screen makes a player's NPC voice");

// MAIN = his main screen (has the key); SECOND = the second GM login (no key).
const MAIN = "mainGM00000000a", SECOND = "secondGM000000b";

let p = chooseVoiceAnswerer([{ id: MAIN, can: true }, { id: SECOND, can: false }], MAIN);
check("main screen has the key and is the active GM: main answers", p.id === MAIN && p.answer === "voice", show(p));

p = chooseVoiceAnswerer([{ id: MAIN, can: true }, { id: SECOND, can: false }], SECOND);
check("the keyless second screen is the active GM: main STILL answers", p.id === MAIN && p.answer === "voice", show(p));

p = chooseVoiceAnswerer([{ id: MAIN, can: true }, { id: SECOND, can: true }], SECOND);
check("both have a key: only one answers, the active GM", p.id === SECOND && p.answer === "voice", show(p));

p = chooseVoiceAnswerer([{ id: SECOND, can: true }, { id: MAIN, can: true }], "someoneElse");
check("both have a key, active GM unknown: the lowest id, the same on every screen", p.id === MAIN, show(p));

p = chooseVoiceAnswerer([{ id: MAIN, can: false }, { id: SECOND, can: false }], SECOND);
check("nobody can: the active GM gives the error at once", p.id === SECOND && p.answer === "error", show(p));

p = chooseVoiceAnswerer([{ id: SECOND, can: false }, { id: MAIN, can: undefined }], SECOND);
check("the main screen has not said yet: the keyless screen sends no error in its place",
  p.id === null && p.answer === "wait", show(p));

p = chooseVoiceAnswerer([{ id: SECOND, can: false }, { id: MAIN, can: undefined }, { id: "third00000000c", can: true }], SECOND);
check("one that can is enough, whatever the others have said", p.id === "third00000000c" && p.answer === "voice", show(p));

p = chooseVoiceAnswerer([{ id: MAIN, can: true }], MAIN);
check("one GM with the key: it answers, as before", p.id === MAIN && p.answer === "voice", show(p));

p = chooseVoiceAnswerer([], null);
check("no GM connected: nobody, and no error", p.id === null && p.answer === "wait", show(p));

// ── The wiring ──
const engine = src("../../ace-engine/scripts/ace-engine.mjs");
const relay = engine.slice(engine.indexOf(`data?.action === "ttsRequest"`), engine.indexOf(`data?.action === "ttsRequest"`) + 5000);
check("the voice relay asks who answers",
  /const _pick = voiceAnswerer\(\{ selfCan: await canVoiceHere\(\) \}\);/.test(relay));
check("a screen that is not the answerer stays quiet",
  /if \(_pick\.id !== game\.user\.id\) \{[\s\S]{0,400}?return;\s*\}/.test(relay));
check("it is decided before the spending limit, so a quiet screen never holds a player's slot",
  relay.indexOf("voiceAnswerer(") > 0 && relay.indexOf("voiceAnswerer(") < relay.indexOf("maySpendOnAI("));
check("only a GM's word about a screen is kept",
  /data\?\.action === "voiceStatus"\) \{\s*if \(sentByGM\(data\)\) noteVoiceStatus\(data\.senderId/.test(engine));
check("a GM screen says so at start-up and asks the others",
  /if \(game\.user\?\.isGM\) \{\s*sayVoiceStatus\(\)[\s\S]{0,200}?askVoiceStatus\(\);/.test(engine));
const settings = src("../../ace-engine/scripts/settings.mjs");
check("it says so again when its key, provider or speech server changes",
  (settings.match(/sayVoiceStatus\(\)/g) ?? []).length === 3);
const va = src("../../ace-engine/scripts/npc/voice-answerer.mjs");
check("what it says is yes or no, never the key",
  /emit\(`module\.\$\{MODULE_ID\}`, \{ action: "voiceStatus", can \}\)/.test(va) && !/emit\([^)]*(key|apiKey)/i.test(va));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
