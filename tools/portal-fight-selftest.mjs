// ─── His portal fight arms itself on load ────────────────────────────────────
//
// 2026-10-15: the Amber Temple portal fight (tools/world/ace-portals-engine.js)
// armed only when a macro was pressed, so every reload left the vortexes dead
// until somebody remembered. ACE QOL now loads the engine at start-up on a GM's
// screen in any world with a portal actor (scripts/world-portals.mjs).
//
// This pins:
//   • only red, yellow and blue portal actors count; nothing else arms it;
//   • a GM's screen arms it, a player's does not, a world without portals does not;
//   • the real engine file arms its three hooks exactly once;
//   • its crack is his pick (the mountainous big crack, 2026-10-14) and the file is on disk.
//
// Run: node tools/portal-fight-selftest.mjs
// ──────────────────────────────────────────────────────────────────────────────

import { readFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";

let passed = 0, failed = 0;
function check(label, ok, detail = "") {
  ok ? passed++ : failed++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${ok || !detail ? "" : `  (${detail})`}`);
}
const here = (rel) => fileURLToPath(new URL(rel, import.meta.url));

console.log("The portal fight arms itself");

// ── Foundry stand-ins: a GM, the three vortexes, and a hook register ──
const hooks = [];
const red = { name: "Red Vortex", flags: { world: { portal: "red" } } };
const yellow = { name: "Yellow Vortex", flags: { world: { portal: "yellow" } } };
const blue = { name: "Blue Vortex", flags: { world: { portal: "blue" } } };
const device = { name: "Arcane Vortex Device", flags: { dnd5e: {} } };
globalThis.Hooks = { on: (name) => hooks.push(name) };
globalThis.game = { user: { isGM: false, id: "player" }, actors: [red, yellow, blue, device], users: {} };
globalThis.ui = { notifications: { error: (m) => console.log(`    ui error: ${m}`) } };
const quiet = console.log;

const { portalActorsIn, armWorldPortals } = await import("../scripts/world-portals.mjs");

check("the three vortexes are portal actors, the Arcane Vortex Device is not",
  portalActorsIn(game.actors).map(a => a.name).join(",") === "Red Vortex,Yellow Vortex,Blue Vortex");
check("an actor tagged with some other colour is not",
  portalActorsIn([{ flags: { world: { portal: "green" } } }]).length === 0);

await armWorldPortals();
check("a player's screen does not arm it", hooks.length === 0 && !globalThis.AcePortals);

game.user.isGM = true;
game.actors = [device];
await armWorldPortals();
check("a world with no portal actors does not arm it", hooks.length === 0 && !globalThis.AcePortals);

game.actors = [red, yellow, blue, device];
console.log = () => {};
await armWorldPortals();
console.log = quiet;
check("a GM's screen in his world arms the real engine", globalThis.AcePortals?._armed === true);
check("with its three hooks: the round, no healing, and the hit card",
  hooks.join(",") === "combatRound,preUpdateActor,updateActor", hooks.join(","));
await armWorldPortals();
check("arming again adds no second set of hooks", hooks.length === 3, hooks.join(","));

// ── The crack ──
const engine = readFileSync(here("./world/ace-portals-engine.js"), "utf8");
const cracks = [...engine.matchAll(/^\s*"(modules\/[^"]+\.(?:ogg|mp3|wav))",?$/gm)].map(m => m[1]);
check("the crack is his pick and only his pick",
  cracks.length === 1 && cracks[0] === "modules/ace-qol/Assets/Sounds/thunder-mountainous-big-crack-02.ogg", cracks.join(", "));
check("and that file is on disk", existsSync(here("../Assets/Sounds/thunder-mountainous-big-crack-02.ogg")));
check("it plays for the whole table", /helper\.play\(\{ src, volume, autoplay: true, loop: false \}, true\)/.test(engine));

// ── The wiring ──
const qol = readFileSync(here("../scripts/ace-qol.mjs"), "utf8");
check("ACE QOL arms it at start-up", /armWorldPortals\(\)\.catch\(/.test(qol) && /from "\.\/world-portals\.mjs"/.test(qol));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
