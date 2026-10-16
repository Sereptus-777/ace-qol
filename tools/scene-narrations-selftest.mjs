// ─── Saved narrations on a scene, and the region that plays one ──────────────
//
// Johnny, 2026-10-15: "I don't have any narration files stored... I need
// something like that that says X5 entry." ACE Engine now keeps narrations on
// each scene (narration-library.mjs), lists them with Play in the Narration tab,
// and a region behaviour plays one when the party walks in (narrate-behavior.mjs).
//
// This pins:
//   • a title is found however it is typed; the same title replaces, never doubles;
//   • the region plays on the active GM only, for a player's token only, once,
//     then switches itself off, and a party arriving together hears it once;
//   • a narration plays before ACE's window has ever been opened;
//   • the region type is declared, registered and labelled;
//   • each narration's voice is made once and kept as a file, and made again
//     only when its words, voice or model change.
//
// Run: node tools/scene-narrations-selftest.mjs
// ──────────────────────────────────────────────────────────────────────────────

import { readFileSync } from "fs";
import { fileURLToPath } from "url";

let passed = 0, failed = 0;
function check(label, ok, detail = "") {
  ok ? passed++ : failed++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${ok || !detail ? "" : `  (${detail})`}`);
}
const src = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const ENGINE = "../../ace-engine/scripts/";

console.log("Saved narrations and the narrate region");

// ── The library ──
const { sameTitle, narrationsOf, findNarration } = await import(`${ENGINE}narration-library.mjs`);
const scene = { name: "AMBER TEMPLE: LOWER", flags: { "ace-engine": { narrations: [
  { id: "a1", title: "X5 approach", text: "Before you reach the temple, you hear it." },
  { id: "a2", title: "X5 entry", text: "The Temple of Lost Secrets is at war." },
  { id: "a3", title: "Empty one", text: "   " },
] } } };
check("\"x5  ENTRY \" finds \"X5 entry\"", findNarration(scene, "x5  ENTRY ")?.id === "a2");
check("an id finds it too", findNarration(scene, "a1")?.title === "X5 approach");
check("a title nobody saved finds nothing", findNarration(scene, "X5 exit") === null);
check("a narration with no words is not listed", narrationsOf(scene).length === 2);
check("a scene with nothing saved lists nothing, without an error", narrationsOf({ flags: {} }).length === 0 && narrationsOf(null).length === 0);
check("a blank title matches nothing", !sameTitle("", "") && !sameTitle("  ", "x"));

// ── The region, run against stand-ins for Foundry ──
const played = [];
let disabledWith = null;
let activeGM = "gm", me = "gm";
globalThis.CONST = { REGION_EVENTS: { TOKEN_ENTER: "tokenEnter" } };
globalThis.foundry = { data: { regionBehaviors: { RegionBehaviorType: class {} }, fields: {} } };
globalThis.ui = { notifications: { warn: (m) => played.push(`WARN ${m}`), error: (m) => played.push(`ERR ${m}`), info: () => {} } };
globalThis.game = {
  get user() { return { id: me }; },
  users: { get activeGM() { return { id: activeGM }; } },
  modules: { get: () => ({ api: { playNarration: async (t) => { played.push(t); return t !== "missing"; } } }) },
};
// The active-GM test compares objects, so give it the same object for the same id.
const users = {};
Object.defineProperty(globalThis.game, "user", { get: () => (users[me] ??= { id: me }) });
Object.defineProperty(globalThis.game.users, "activeGM", { get: () => (users[activeGM] ??= { id: activeGM }) });

const { NarrateBehaviorType } = await import(`${ENGINE}narrate-behavior.mjs`);
const onEnter = NarrateBehaviorType.events.tokenEnter;
let n = 0;
const behaviour = (narration, playersOnly = true) => ({
  narration, playersOnly, scene,
  parent: { uuid: `Scene.x.Region.r.RegionBehavior.b${++n}`, name: "Doors", update: async (d) => { disabledWith = d; } },
});
const pc = { name: "Firaxis Greenbeard", actor: { hasPlayerOwner: true } };
const monster = { name: "Ghast", actor: { hasPlayerOwner: false } };

let b = behaviour("X5 entry");
me = "player";
await onEnter.call(b, { data: { token: pc } });
check("a player's screen plays nothing (the GM's does)", played.length === 0, played.join(" | "));
me = "gm";
await onEnter.call(b, { data: { token: monster } });
check("a monster walking in plays nothing", played.length === 0, played.join(" | "));
await onEnter.call(b, { data: { token: pc } });
check("the first player token in plays it", played.join("|") === "X5 entry", played.join(" | "));
check("then the region switches itself off", disabledWith?.disabled === true);
check("switched on again, it plays again (nothing left over from the first time)",
  (await onEnter.call(b, { data: { token: pc } }), played.filter(p => p === "X5 entry").length === 2));

played.length = 0;
b = behaviour("X5 entry");
await Promise.all([onEnter.call(b, { data: { token: pc } }), onEnter.call(b, { data: { token: { ...pc, name: "Chudd Buckland" } } })]);
check("a party walking in together hears it once", played.filter(p => p === "X5 entry").length === 1, played.join(" | "));

played.length = 0; disabledWith = null;
b = behaviour("missing");
await onEnter.call(b, { data: { token: pc } });
check("a title that is not saved stays switched on (Engine says what is saved)", disabledWith === null && played[0] === "missing");

played.length = 0;
b = behaviour("   ");
await onEnter.call(b, { data: { token: pc } });
check("a region with no title says so", played.length === 1 && played[0].startsWith("WARN") && /no narration title/.test(played[0]), played.join(" | "));

played.length = 0;
b = behaviour("X5 entry", false);
await onEnter.call(b, { data: { token: monster } });
check("with Players only off, anything walking in plays it", played.join("|") === "X5 entry", played.join(" | "));

// ── The wiring ──
const engine = src(`${ENGINE}ace-engine.mjs`);
check("a narration plays before ACE's window was ever opened",
  /function _narrate\(text, opts = \{\}\) \{\s*const p = _narrationPanel\(\);/.test(engine)
  && /function _narrationPanel\(\) \{\s*if \(!panel\) \{[\s\S]{0,300}?panel = _newPanel\(\);/.test(engine)
  && /narrate:\s+\(text\) => _narrate\(text\)/.test(engine));
check("only the active GM plays a saved narration",
  /async function _playNarration\([\s\S]{0,300}?if \(game\.users\?\.activeGM !== game\.user\) return false;/.test(engine));
check("the region type is registered before ACE's enabled check",
  engine.indexOf("CONFIG.RegionBehavior.dataModels, { [`${MODULE_ID}.narrate`]") > 0
  && engine.indexOf("CONFIG.RegionBehavior.dataModels, { [`${MODULE_ID}.narrate`]") < engine.indexOf("if (!_aceEngineEnabled()) {"));
const manifest = JSON.parse(src("../../ace-engine/module.json"));
check("the manifest declares it", !!manifest.documentTypes?.RegionBehavior?.narrate);
const lang = JSON.parse(src("../../ace-engine/languages/en.json"));
check("it has a name in the region menu, and short field labels",
  !!lang.ACE?.REGIONBEHAVIORS?.NARRATE?.label
  && Object.values(lang.ACE.REGIONBEHAVIORS.NARRATE.FIELDS).every(f => f.label.length <= 18));
const panel = src(`${ENGINE}panel.mjs`);
check("the Narration tab lists this scene's narrations with Play",
  /id="ace-saved-narrations"/.test(panel) && /data-action="playSavedNarration"/.test(panel));
check("Play takes the one narration path", /api\.playNarration\(id, \{ scene: canvas\?\.scene \}\)/.test(panel));
check("the list follows the scene: on a scene change and when its narrations change",
  /panel\._refreshSavedNarrationsUI\(\);\s+\/\/ the Narration tab/.test(engine)
  && /hasProperty\(changes \?\? \{\}, `flags\.\$\{MODULE_ID\}\.narrations`\)/.test(engine));

// ── The players hear the narrator, not a robot (his table, 2026-10-16: "X5
//    approach" in the narrator voice on Firaxis's screen, "X5 entry" in the
//    robot, because the longer audio was over a 700 KB guess and the players were
//    sent the words instead) ──
const limits = src(`${ENGINE}text-limits.mjs`);
check("one limit on audio over the socket, the size the NPC voices always had",
  /export const AUDIO_SOCKET_MAX_B64 = 6_000_000;/.test(limits));
check("no 700 KB cap left anywhere in Engine", !/700_000/.test(panel) && !/700_000/.test(engine));
check("the narrator and NPC speech both send under that one limit",
  (panel.match(/base64\.length <= AUDIO_SOCKET_MAX_B64/g) ?? []).length === 2);
check("the receiver refuses by the same limit", /const AUDIO_MAX_BYTES\s*=\s*AUDIO_SOCKET_MAX_B64;/.test(engine));
check("too long for the voice sends words only when the GM chose the browser voice",
  /\} else if \(this\._browserVoiceChosen\(\)\) \{\s*\/\/[^\n]*\n\s*game\.socket\.emit\(`module\.\$\{MODULE_ID\}`, \{\s*type: "narration-tts"/.test(panel));

// ── Made once, ahead of time (his ask, 2026-10-16: "a huge delay in narration") ──
const bodyOf = (text, head) => {
  const start = text.indexOf(head);
  if (start < 0) return "";
  let i = text.indexOf("{", start + head.length - 1), depth = 0, j = i;
  for (; j < text.length; j++) { if (text[j] === "{") depth++; else if (text[j] === "}" && --depth === 0) break; }
  return text.slice(i + 1, j);
};
const keyOf = new Function("text", bodyOf(panel, "  narrationAudioKey(text) {"));
const voice = (model) => ({
  _narratorVoice: (g) => ({ voiceId: g === "female" ? "her" : "him", modelId: model }),
  _cleanForSpeech: (t) => t.trim(),
});
const turbo = voice("eleven_turbo_v2_5"), slow = voice("eleven_multilingual_v2");
const k1 = keyOf.call(turbo, "The Temple of Lost Secrets is at war.");
check("the same words in the same voice keep their recording", k1 === keyOf.call(turbo, "The Temple of Lost Secrets is at war.  "));
check("changed words are made again", k1 !== keyOf.call(turbo, "The Temple of Lost Secrets is at peace."));
check("a change of voice model is made again", k1 !== keyOf.call(slow, "The Temple of Lost Secrets is at war."));
check("the female narrator tag is made in her voice", k1 !== keyOf.call(turbo, "[voice:female] The Temple of Lost Secrets is at war."));

const { saveNarration, setNarrationAudio } = await import(`${ENGINE}narration-library.mjs`);
const kept = {
  name: "X5",
  flags: { "ace-engine": { narrations: [
    { id: "n1", title: "X5 entry", text: "Old words.", audio: "worlds/hijinx/ace-engine/narration-audio/s-n1-a.mp3", audioKey: "a" },
  ] } },
  async setFlag(_m, _k, list) { this.flags["ace-engine"].narrations = list; },
};
users.gm.isGM = true; me = "gm";
globalThis.foundry.utils = { randomID: () => "new" };
await saveNarration(kept, { title: "X5 entry", text: "Old words." });
check("saving the same words again keeps the recording", kept.flags["ace-engine"].narrations[0].audio?.endsWith("s-n1-a.mp3"));
await saveNarration(kept, { title: "x5 ENTRY", text: "New words." });
check("new words under the same title drop the old recording",
  kept.flags["ace-engine"].narrations[0].audio === null && kept.flags["ace-engine"].narrations[0].audioKey === null);
await setNarrationAudio(kept, "n1", { audio: "worlds/hijinx/ace-engine/narration-audio/s-n1-b.mp3", audioKey: "b" });
check("the made recording is kept on its narration", kept.flags["ace-engine"].narrations[0].audioKey === "b");

const play = bodyOf(engine, "async function _playNarration(which, { scene } = {}) {");
check("Play and the regions play the made recording, making it first if it is not",
  /const audioSrc = await _ensureNarrationAudio\(where, entry\);\s*await _narrate\(entry\.text, audioSrc \? \{ audioSrc \} : \{\}\);/.test(play));
const ensure = bodyOf(engine, "async function _ensureNarrationAudio(scene, entry) {");
check("a failed upload is a failure, never a path guessed at",
  /if \(!res\?\.path\) throw new Error/.test(ensure) && !/\$\{dir\}\/\$\{name\}/.test(ensure));
check("a recording whose file has gone is made again", /fetch\(entry\.audio, \{ method: "HEAD" \}\)/.test(ensure));
check("the same one asked for twice at once is one request", /_makingNarration\.has\(flight\)/.test(ensure));
check("when it cannot be made, it is spoken live, not dropped",
  /if \(audioSrc\) this\._playNarrationFile\(audioSrc\);\s*else this\._speakText\(text, voiceGender, \{ broadcast: true \}\);/.test(panel));
const at = engine.indexOf('if (data?.type === "narration-file"');
const recv = at < 0 ? "" : engine.slice(at, at + 900);
check("the players play it from the world folder, sent by a GM only",
  /if \(!sentByGM\(data\)\) return;/.test(recv)
  && /startsWith\(`worlds\/\$\{game\.world\.id\}\/ace-engine\/narration-audio\/`\)/.test(recv)
  && /_playNarrationFileHere\(data\.src, vol\);/.test(recv));
check("Stop stops it on the players' screens",
  /function _playNarrationFileHere\(src, volume = 0\.8\) \{[\s\S]{0,300}?_narrationAudio = audio;/.test(engine)
  && /function _stopAllAudio\(\) \{\s*\/\/[^\n]*\n\s*if \(_narrationAudio\)/.test(engine));
check("Save to Scene makes the one just saved, and Make Voices makes the rest",
  /api\?\.prepareNarrations\?\.\(scene, entry\.id\)/.test(panel) && /data-action="makeNarrationVoices"/.test(panel)
  && /makeNarrationVoices: AcePanel\._onMakeNarrationVoices,/.test(panel));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
