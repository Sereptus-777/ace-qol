// ─── Every portrait is framed from the top ──────────────────────────────────
//
// His rule, 2026-10-11: "Every portrait on every card is framed from the top of
// the picture down. The head stays in the frame. The box fills with whatever fits
// under that. Never centered on the middle. Firaxis's portrait on the Lucky card
// is showing his chest. Fix that one, and make this the way every card portrait
// is drawn from here on."
//
// One class does it, `ace-face` (img.ace-face in each module's stylesheet:
// cover, anchored at the top). This reads every <img> the three modules build
// and fails on a creature's picture that does not carry it, so the next card
// cannot be drawn the old way without this saying so.
//
// A picture that is not a creature's face (a die, an item's icon, a trap's tile)
// is told apart by its class, and a line that is right to differ says
// `face-ok: <reason>` on it or on one of the two lines above. Panels and the
// action bar are windows, not cards, and are not read.
//
//   node tools/portrait-framing-selftest.mjs

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const MODULES = fileURLToPath(new URL("../../", import.meta.url));
const ROOTS = ["ace-qol/scripts", "ace-artificer/scripts", "ace-engine/scripts"];
// Windows, not cards: the action bar, the party hand-off, the Forge and Engine
// panels, the creature scaler, the NPC journal and chat windows. And the helper
// that adds the class itself.
const NOT_CARDS = [
  /ace-qol\/scripts\/action-bar\.mjs$/, /ace-qol\/scripts\/party-transfer\.mjs$/,
  /ace-qol\/scripts\/face\.mjs$/,
  /ace-artificer\/scripts\/panel\.mjs$/, /ace-artificer\/scripts\/creature-scaler\//,
  /ace-engine\/scripts\/panel\.mjs$/, /ace-engine\/scripts\/npc\//,
];
// A creature's picture, by what the card draws it from.
// (Case-blind: an attacker's face is `_attackerFace`.)
const CREATURE_SRC = /faceOf|portrait|face\b|actorImg|actor\??\.img|texture\??\.src|tokenImg|targetImg|pcImg|reactorActorImg|sourceImg|\b(?:r|t|c|e|ts\.target|atkResult)\??\.img\b|\$\{\s*(?:esc\(|escapeHtml\()?img\)?\s*\}/i;
// Not a face: dice, an item's icon, a trap's tile.
const NOT_A_FACE = /die-img|use-icon|trap-header-icon/;

let pass = 0, fail = 0;
const check = (label, ok, note = "") => {
  if (ok) pass++; else fail++;
  console.log(`${ok ? "  ok  " : "  FAIL"} ${label}${note ? `\n        ${note}` : ""}`);
};

function* files(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* files(p);
    else if (/\.(mjs|js)$/.test(name)) yield p;
  }
}

console.log("\nEVERY CARD'S PORTRAIT CARRIES THE ONE CLASS");
const missing = [];
let faces = 0;
for (const root of ROOTS) {
  for (const path of files(join(MODULES, root))) {
    const rel = relative(MODULES, path).replace(/\\/g, "/");
    if (NOT_CARDS.some(re => re.test(rel))) continue;
    const src = readFileSync(path, "utf8");
    const lines = src.split("\n");
    for (const m of src.matchAll(/<img\b[^>]*>/g)) {
      const tag = m[0];
      const srcAttr = /src="([^"]*)"/.exec(tag)?.[1] ?? "";
      if (!CREATURE_SRC.test(srcAttr)) continue;
      const cls = /class="([^"]*)"/.exec(tag)?.[1] ?? "";
      if (NOT_A_FACE.test(cls)) continue;
      const line = src.slice(0, m.index).split("\n").length;
      const near = lines.slice(Math.max(0, line - 3), line).join("\n");
      if (/face-ok:/.test(near)) continue;
      faces++;
      if (!/\bace-face\b/.test(cls)) missing.push(`${rel}:${line}  ${tag.slice(0, 110)}`);
    }
  }
}
check(`every creature picture on a card or popup is framed from the top (${faces} found)`,
  missing.length === 0, missing.join("\n        "));
check("and there are many of them: the reader is reading", faces > 40, `${faces}`);

console.log("\nTHE RULE IS IN EVERY MODULE'S STYLESHEET");
for (const css of ["ace-qol/styles/ace-qol.css", "ace-artificer/styles/ace-artificer.css", "ace-engine/styles/ace-engine.css"]) {
  const text = readFileSync(join(MODULES, css), "utf8");
  check(`${css}: cover, anchored at the top`,
    /img\.ace-face \{ object-fit: cover !important; object-position: 50% 0 !important; \}/.test(text));
}

console.log("\nTHE ONE HE SAW");
{
  const reaction = readFileSync(join(MODULES, "ace-qol/scripts/reaction-engine.mjs"), "utf8");
  check("Firaxis's Lucky card draws its face with the class", /class="ace-lucky-face ace-face"/.test(reaction));
  const face = readFileSync(join(MODULES, "ace-qol/scripts/face.mjs"), "utf8");
  check("and the face helper draws every square it makes with it", /class="\$\{esc\(cls\)\} ace-face"/.test(face));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
