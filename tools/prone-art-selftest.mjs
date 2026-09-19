// ─── Finding the right picture of a creature lying down ─────────────────────
//
// ⚠️🔴 THE BUG THIS EXISTS FOR. Johnny, 2026-09-18: Neferon fell thirty feet
// with no Feather Fall. The fall put Prone on him and the card said "Lands
// prone.", but the token showed nothing. His prone folders are Assets/Prone AND
// Assets/Dead, and the matcher stripped only a `prone-` prefix, so
// `dead-fiend.png` was filed as "dead-fiend" and no creature ever asked for
// that. The prone icon is hidden for everybody by his 2026-09-02 rule, so no
// picture meant no sign at all.
//
// His rules for it:
//   1. Every image in the prone folders counts, `dead-` or no prefix at all.
//   2. The order: the creature's name, then its type (fiend), then its race or
//      subtype (yugoloth).
//   3. Neferon is a fiend: `dead-fiend` or `dead-arcanaloth-fiend` must be his.
//   4. A fall that lands puts Prone on him unless Feather Fall caught him.
//
// The folder below is read from disk, so this runs on the files he has.
//
// Run:  node tools/prone-art-selftest.mjs
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

globalThis.Hooks = { on: () => {}, once: () => {}, off: () => {}, callAll: () => {} };
globalThis.document = { querySelectorAll: () => [], querySelector: () => null };
globalThis.CONFIG = { DND5E: {}, statusEffects: [], Canvas: { polygonBackends: {} } };
globalThis.ui = { notifications: { info: () => {}, warn: () => {}, error: () => {} } };
class _App { static DEFAULT_OPTIONS = {}; constructor() {} render() {} close() {} }
globalThis.foundry = {
  utils: { escapeHTML: (s) => String(s), deepClone: (o) => o, randomID: () => "id",
           mergeObject: (a, b) => ({ ...a, ...b }), getDocumentClass: () => null },
  applications: { api: { ApplicationV2: _App, DialogV2: { wait: async () => null },
                         HandlebarsApplicationMixin: (C) => C },
                  ux: { TextEditor: { implementation: { enrichHTML: async (h) => h } } },
                  apps: { FilePicker: { implementation: { browse: async () => ({ files: [], dirs: [] }) } } },
                  handlebars: {} },
};
globalThis.ChatMessage = { create: async () => {}, getSpeaker: () => ({}) };
globalThis.CONST = { ACTIVE_EFFECT_MODES: { ADD: 2 } };
globalThis.canvas = { ready: true, scene: { id: "s1" }, grid: { size: 100, distance: 5 },
  tokens: { placeables: [], controlled: [] } };
const GM = { id: "gm", isGM: true };
globalThis.game = { combat: null, ready: true, actors: [], scenes: [],
  settings: { get: () => false, register: () => {} }, user: GM,
  users: Object.assign([GM], { activeGM: GM }), i18n: { localize: (k) => k } };

let pass = 0, fail = 0;
const check = (label, ok, detail = "") => {
  ok ? pass++ : fail++;
  console.log((ok ? "  ok   " : "  FAIL ") + label + (detail ? `   (${detail})` : ""));
};
const file = (p) => decodeURIComponent(String(p ?? "").split("/").pop());

const MODULE = "D:/FoundryVTT/Data/modules/ace-qol";
const { ProneArt } = await import(`file:///${MODULE}/scripts/prone-art.mjs`);
const { resolveFall } = await import(`file:///${MODULE}/scripts/falling.mjs`);

// ── His folders, walked the way ACE Token Art walks them (every subfolder) ──
const walk = (disk, url) => {
  const out = [];
  for (const name of readdirSync(disk)) {
    const d = join(disk, name);
    if (statSync(d).isDirectory()) out.push(...walk(d, `${url}/${name}`));
    else out.push(`${url}/${encodeURIComponent(name)}`);
  }
  return out;
};
const FOLDERS = ["Prone", "Dead"];
const paths = FOLDERS.flatMap(f => walk(`${MODULE}/Assets/${f}`, `modules/ace-qol/Assets/${f}`));
const index = ProneArt.indexFiles(paths);

const npc = (name, value, subtype = "", extra = {}) => ({
  name, prototypeToken: { name }, getFlag: () => undefined,
  system: { details: { type: { value, subtype }, race: null, ...extra } },
});
const pick = (actor, rand = () => 0) => ProneArt.pickFrom(index, ProneArt.triesFor(actor), rand);

console.log(`\nHis prone folders: ${index.files} images (${index.byKind.prone} prone-, ${index.byKind.dead} dead-, ${index.byKind.plain} no prefix)`);

// ── 1. Every image counts ──
check("the dead- pictures in his Dead folder are in the prone index, not only the prone- ones",
  index.byKind.dead > 50 && index.byKind.prone === 7, `${index.byKind.dead} dead-, ${index.byKind.prone} prone-`);
check("a video and a Photoshop file are not pictures (dead-Celestial.webm, the _PSD Sources)",
  !paths.filter(p => /\.(webm|psd)$/i.test(p)).some(p => [...index.exact.values()].flat().some(e => e.path === p)));
check("an image with no prefix counts too (Drowned-Dead-Corpse.png)",
  index.byKind.plain >= 1 && !!index.exact.get("drowned-dead-corpse"));

// ── 2 and 3. Neferon ──
const neferon = npc("Neferon", "fiend", "yugoloth");
{
  const a = pick(neferon, () => 0), b = pick(neferon, () => 0.99);
  const fiends = ["dead-fiend.png", "dead-fiend-11.png"];
  check("Neferon (a fiend, yugoloth, no picture of his own) gets dead-fiend by his type",
    fiends.includes(file(a?.path)) && a?.key === "fiend", `${file(a?.path)} via "${a?.key}"`);
  check("both dead-fiend pictures are his, picked at random so two fiends are not identical",
    new Set([file(a?.path), file(b?.path)]).size === 2 && fiends.includes(file(b?.path)),
    `${file(a?.path)} and ${file(b?.path)}`);
}
check("an Arcanaloth gets its own picture, dead-arcanaloth-fiend, by name",
  file(pick(npc("Arcanaloth", "fiend", "Yugoloth"))?.path) === "dead-arcanaloth-fiend.png");
check("so does an Arcanaloth (Legacy)",
  file(pick(npc("Arcanaloth (Legacy)", "fiend", "Yugoloth"))?.path) === "dead-arcanaloth-fiend.png");

// ── 2. The order: name, then type, then race or subtype ──
{
  const only = (...names) => ProneArt.indexFiles(names.map(n => `modules/ace-qol/Assets/Dead/${n}`));
  const both = ProneArt.pickFrom(only("dead-fiend.png", "dead-yugoloth.png"), ProneArt.triesFor(neferon));
  check("his order: the type (fiend) is asked before the subtype (yugoloth)",
    file(both?.path) === "dead-fiend.png", file(both?.path));
  const sub = ProneArt.pickFrom(only("dead-yugoloth.png", "dead-beast.png"), ProneArt.triesFor(neferon));
  check("and the subtype still answers when the type has no picture",
    file(sub?.path) === "dead-yugoloth.png", file(sub?.path));
  const named = ProneArt.pickFrom(only("dead-fiend.png", "dead-neferon.png"), ProneArt.triesFor(neferon));
  check("and a picture with his own name beats his type",
    file(named?.path) === "dead-neferon.png", file(named?.path));
  const pc = { name: "Varek", prototypeToken: { name: "Varek" }, getFlag: () => undefined,
    system: { details: { type: { value: "humanoid", subtype: "" }, race: { name: "Tiefling" } } } };
  const race = ProneArt.pickFrom(only("dead-tiefling.png"), ProneArt.triesFor(pc));
  check("the race is read from the species ITEM dnd5e prepares (not \"object-object\")",
    file(race?.path) === "dead-tiefling.png" && !ProneArt.triesFor(pc).some(t => /object/.test(t.key)),
    file(race?.path));
  const idRace = { ...pc, system: { details: { type: { value: "humanoid" }, race: "aB3dE5fG7hJ9kL1m" } } };
  check("a race that is only a missing item's id is not asked for",
    !ProneArt.triesFor(idRace).some(t => t.key === "ab3de5fg7hj9kl1m"));
  const mixed = ProneArt.pickFrom(only("dead-goblin.png", "prone-goblin.png"), ProneArt.triesFor(npc("Goblin", "humanoid", "goblinoid")));
  check("a picture made for lying down beats a corpse picture of the same name",
    file(mixed?.path) === "prone-goblin.png", file(mixed?.path));
}

// ── The first-name rule still works, and never reaches a corpse ──
check("Firaxis Greenbeard still gets prone-firaxis by first name",
  file(pick({ ...npc("Firaxis Greenbeard", "humanoid"), prototypeToken: { name: "Firaxis Greenbeard" } })?.path) === "prone-firaxis.webp");
check("Izek Strazni still gets prone-Izek",
  file(pick(npc("Izek Strazni", "humanoid", "human"))?.path) === "prone-Izek.png");
check("a Giant Frog is not a dead giant: the first-name walk never reaches a corpse, so it gets dead-beast",
  file(pick(npc("Giant Frog", "beast"))?.path) === "dead-beast.png", file(pick(npc("Giant Frog", "beast"))?.path));
check("a Giant Spider gets its own picture (dead-giant spider-11)",
  file(pick(npc("Giant Spider", "beast"))?.path) === "dead-giant spider-11.png");
check("a Wolf gets dead-wolf-grey, not the Animal Lord (Wolf): the file most about the word wins",
  file(pick(npc("Wolf", "beast"))?.path) === "dead-wolf-grey.png", file(pick(npc("Wolf", "beast"))?.path));

// ── The swap itself, through goProne, with his folder as ACE Token Art's index ──
{
  game.modules = { get: (id) => (id === "ace-token-art"
    ? { active: true, api: { getProneIndex: () => ({ ready: true, all: paths.map(path => ({ path })) }) } } : null) };
  ProneArt._cache = null;
  const wrote = [];
  const doc = { name: "Neferon", texture: { src: "NPCs/FIENDS/Arcanaloth%20033.png" }, flags: {},
    actor: { ...neferon, statuses: new Set(["prone"]) },
    getFlag: () => undefined, update: async (u) => { wrote.push(u); } };
  const log = console.log; const lines = [];
  console.log = (...a) => lines.push(a.join(" "));
  try { await ProneArt.goProne(doc); } finally { console.log = log; }
  const u = wrote[0] ?? {};
  check("goProne puts a dead-fiend picture on Neferon's token and remembers what he was wearing",
    /dead-fiend(-11)?\.png$/.test(u["texture.src"] ?? "")
      && u["flags.ace-qol.proneArtPrevious"] === "NPCs/FIENDS/Arcanaloth%20033.png",
    `${file(u["texture.src"])}, remembers ${u["flags.ace-qol.proneArtPrevious"]}`);

  const lost = { ...doc, name: "Nobody", actor: { ...npc("Nobody", "celestial", "angel"), statuses: new Set(["prone"]) } };
  wrote.length = 0; lines.length = 0;
  console.log = (...a) => lines.push(a.join(" "));
  try { await ProneArt.goProne(lost); } finally { console.log = log; }
  check("a creature with no picture says so in the console, with what was asked for, instead of nothing",
    !wrote.length && lines.some(l => /Nobody is prone, but no prone art matched \(asked for: nobody, celestial, angel\)/.test(l)),
    lines.find(l => /Nobody/.test(l)) ?? "no line");
}

// ── 4. The fall ──
{
  const f = resolveFall({ from: 30, to: 0 });
  check("a 30 ft fall with no Feather Fall lands prone (3d6), 2014 and 2024 alike",
    f.prone === true && f.dice === 3 && f.formula === "3d6", JSON.stringify({ prone: f.prone, dice: f.dice }));
  const c = resolveFall({ from: 30, to: 0, caught: true });
  check("caught by Feather Fall: no damage and on his feet", c.prone === false && c.dice === 0);
  const s = resolveFall({ from: 5, to: 0 });
  check("a 5 ft drop is not a fall that hurts, so no prone", s.prone === false && s.dice === 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
