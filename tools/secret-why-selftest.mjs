// ─── Why a hidden door was not found: told to the GM ─────────────────────────
//
// Johnny, 2026-10-15: Jeth stood beside the statue's secret door in X5 (DC 20)
// with passive 21 and noticed nothing; he searched, rolled 25, and was told
// "finds nothing", the same words as an empty room. His call: "tell the GM in a
// GM card, chat card only." And with his second GM login connected, every Forge
// request ran on BOTH GM screens: a player's search rolled and posted twice.
//
// This pins (ACE Forge, read as source):
//   • every way the passive check passes over a door in range names its reason;
//   • every way a search passes over a door or trap within 20 ft is a row;
//   • the card goes to GMs only, and says when the screen shows another scene;
//   • one GM screen handles a player's request and runs the passive check.
//
// Run: node tools/secret-why-selftest.mjs
// ──────────────────────────────────────────────────────────────────────────────

import { readFileSync } from "fs";
import { fileURLToPath } from "url";

let passed = 0, failed = 0;
function check(label, ok, detail = "") {
  ok ? passed++ : failed++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${ok || !detail ? "" : `  (${detail})`}`);
}
const src = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const FORGE = "../../ace-artificer/scripts/";

console.log("Why a hidden door was not found");

const sw = src(`${FORGE}secret-watcher.mjs`);
const passive = sw.slice(sw.indexOf("static async _onTokenMove("), sw.indexOf("static _whyMemo"));
check("passive: a wall in the way says so", /_canSee\(tokenCenter, mid, gridSize\)\) \{ miss\(/.test(passive));
check("passive: a fight says so, and that a Search still works", /_inCombat\(tokenDoc\)\) \{ miss\(`[^`]*a Search still works`\)/.test(passive));
check("passive: darkness without darkvision says so", /cond\.dc === null\) \{ miss\(`too dark/.test(passive));
check("passive: a DC above the passive gives both numbers and how the DC was made",
  /miss\(`passive \$\{passive\} against DC \$\{cond\.dc\} \(\$\{SecretWatcher\._dcWorking\(dc, cond\)\}\)`\)/.test(passive));
check("passive: the misses reach the GM's card", /if \(misses\.length\) SecretWatcher\._gmWhyPassive\(scene, tokenDoc, actor, misses\);/.test(passive));
check("passive: the same reason for the same door is said once, not every step",
  /_whyMemo\.get\(key\) === m\.why\) return false/.test(sw));
check("passive: one GM screen runs it", /static async _onTokenMove\(tokenDoc, changes\) \{[\s\S]{0,400}?if \(game\.users\?\.activeGM !== game\.user\) return;/.test(sw));

const sa = src(`${FORGE}search-action.mjs`);
const doors = sa.slice(sa.indexOf("// ── Secret doors ──"), sa.indexOf("// ── Armed traps ──"));
check("search: already found", /row\(`already found by \$\{whoFound\}/.test(doors));
check("search: out of reach", /row\(`out of reach: a search covers/.test(doors));
check("search: a wall in the way", /_canSee\(centre, near, gridSize\)\) \{ row\(`a wall stands between/.test(doors));
check("search: too dark", /cond\.dc === null\) \{ row\(`too dark/.test(doors));
check("search: the roll against the DC, and by how much it fell short", /short by \$\{cond\.dc - total\}/.test(doors));
check("search: found", /row\(`found: rolled \$\{total\} against DC/.test(doors));
const traps = sa.slice(sa.indexOf("// ── Armed traps ──"), sa.indexOf("// ── Remember this square"));
check("search: traps get the same rows", /trapRow\(`already found/.test(traps) && /trapRow\(`out of reach/.test(traps) && /short by \$\{dc - total\}/.test(traps) && /trapRow\(`found:/.test(traps));
check("search: the GM card follows the player's card",
  sa.indexOf("SearchAction._tell(userId, actor, line") < sa.indexOf("SecretWatcher.postGmWhy({") && /title: "Search"/.test(sa));

const card = sw.slice(sw.indexOf("static postGmWhy("), sw.indexOf("static _gmWhyPassive("));
check("the card goes to GMs only", /whisper: gmIds/.test(card) && /u\.isGM && u\.active/.test(card));
check("it says when the screen shows another scene", /_screenNote\(scene\)/.test(card) && /measured on the wrong map/.test(sw));
check("it is the search card's own look, not a new one", /border-left:4px solid #8c9aad;padding:12px 16px;background:#191b22;border-radius:5px;/.test(card));

const forge = src(`${FORGE}ace-artificer.mjs`);
check("one GM screen handles a player's request",
  /if \(game\.users\?\.activeGM !== game\.user\) return;\s*\/\/ A message the server stamped with nobody/.test(forge)
  && !/\n    if \(!game\.user\.isGM\) return;\n    \/\/ A message the server stamped with nobody/.test(forge));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
