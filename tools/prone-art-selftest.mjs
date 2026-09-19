// ─── Finding the right picture of a creature, lying down or dead ────────────
//
// ⚠️🔴 THE BUGS THIS EXISTS FOR.
//
// Johnny, 2026-09-18 (0.34.67): Neferon fell thirty feet with no Feather Fall.
// The fall put Prone on him and the card said "Lands prone.", but the token
// showed nothing. His prone folders are Assets/Prone AND Assets/Dead, and the
// matcher stripped only a `prone-` prefix, so `dead-fiend.png` was filed as
// "dead-fiend" and no creature ever asked for that.
//
// Johnny, 2026-09-18 (0.34.68): "Specific art loses to a generic type file.
// Neferon: dead-arcanaloth-fiend exists. It used dead-fiend. Draft Horse:
// dead-horse exists. It used a generic beast." Both matchers stopped at the
// first rung that answered. His rules:
//   • More specific filename wins. Always.
//   • Count every word: name, then type, then subtype.
//   • Do not stop at the first type hit.
// One rule now picks for both (scripts/art-match.mjs). This file pins it on
// his real folders; tools/dead-art-selftest.mjs pins the corpse side.
//
// Run:  node tools/prone-art-selftest.mjs
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

globalThis.Hooks = { on: () => {}, once: () => {}, off: () => {}, callAll: () => {} };
globalThis.document = { querySelectorAll: () => [], querySelector: () => null };
globalThis.CONFIG = { DND5E: {}, statusEffects: [], Canvas: { polygonBackends: {} } };
globalThis.ui = { notifications: { info: () => {}, warn: () => {}, error: () => {} } };
class _App { static DEFAULT_OPTIONS = {}; constructor() {} render() {} close() {} }
// Foundry's compendium lookup, standing in for the index it loads at startup.
const COMPENDIUM = { "Compendium.dnd5e.actors24.Actor.mmGoblinWarrior0": { name: "Goblin Warrior" } };
globalThis.foundry = {
  utils: { escapeHTML: (s) => String(s), deepClone: (o) => o, randomID: () => "id",
           mergeObject: (a, b) => ({ ...a, ...b }), getDocumentClass: () => null,
           fromUuidSync: (uuid) => COMPENDIUM[uuid] ?? null },
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
const { creatureWords, bestArt, rankArt, indexArt } = await import(`file:///${MODULE}/scripts/art-match.mjs`);
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
const paths = ["Prone", "Dead"].flatMap(f => walk(`${MODULE}/Assets/${f}`, `modules/ace-qol/Assets/${f}`));
const index = ProneArt.indexFiles(paths);

// Shapes as dnd5e 5.x hands them over; the flags are the ones his actors carry.
const npc = (name, value, subtype = "", { flags = {}, stats = {}, race = null } = {}) => ({
  name, prototypeToken: { name }, flags, _stats: stats,
  getFlag: (scope, key) => flags?.[scope]?.[key],
  system: { details: { type: { value, subtype }, race } },
});
const pick = (actor, rand = () => 0) => bestArt(index, creatureWords(actor), { rand });
const got = (actor, rand) => file(pick(actor, rand)?.path);

console.log(`\nHis prone folders: ${index.files} images (${index.byKind.prone} prone-, ${index.byKind.dead} dead-, ${index.byKind.plain} no prefix)`);

// ── Every image counts (0.34.67) ──
check("the dead- pictures in his Dead folder are in the prone index, not only the prone- ones",
  index.byKind.dead > 50 && index.byKind.prone === 7, `${index.byKind.dead} dead-, ${index.byKind.prone} prone-`);
check("a video and a Photoshop file are not pictures (dead-Celestial.webm, the _PSD Sources)",
  !paths.filter(p => /\.(webm|psd)$/i.test(p)).some(p => index.paths.has(p)));
check("an image with no prefix counts too (Drowned-Dead-Corpse.png)",
  index.byKind.plain >= 1 && (index.byWord.get("drowned") ?? []).some(e => e.kind === "plain"));

// ── HIS TWO (0.34.68) ──
// His Neferon: named Neferon, fiend (yugoloth), imported by Plutonium as "arcanaloth_mm".
const neferon = npc("Neferon", "fiend", "yugoloth",
  { flags: { plutonium: { page: "bestiary.html", source: "", hash: "arcanaloth_mm" } } });
check("Neferon gets dead-arcanaloth-fiend, not dead-fiend: it has two of his words (arcanaloth, fiend)",
  got(neferon) === "dead-arcanaloth-fiend.png" && got(neferon, () => 0.99) === "dead-arcanaloth-fiend.png",
  `${got(neferon)} by his ${pick(neferon)?.level}`);
const horse = npc("Draft Horse", "beast");
{
  const a = got(horse, () => 0), b = got(horse, () => 0.99);
  check("the Draft Horse gets dead-horse, not dead-beast: \"horse\" is a word of its name",
    ["dead-horse.png", "dead-horse-2.png"].includes(a) && ["dead-horse.png", "dead-horse-2.png"].includes(b) && a !== b,
    `${a} or ${b}`);
}
check("so does a Draft Horse (Legacy) from the D&D Beyond importer",
  got(npc("Draft Horse (Legacy)", "beast", "",
    { flags: { monsterMunch: { url: "https://www.dndbeyond.com/monsters/16844-draft-horse" } } })).startsWith("dead-horse"));

// ── More specific is measured against the creature ──
check("an Imp still gets dead-fiend: dead-arcanaloth-fiend has its one word plus some other fiend's",
  /^dead-fiend(-11)?\.png$/.test(got(npc("Imp", "fiend", "devil"))), got(npc("Imp", "fiend", "devil")));
check("a Bat gets dead-beast, not the displacer beast",
  got(npc("Bat", "beast")) === "dead-beast.png", got(npc("Bat", "beast")));
check("a Wolf gets dead-wolf-grey, not the Animal Lord (Wolf)",
  got(npc("Wolf", "beast")) === "dead-wolf-grey.png", got(npc("Wolf", "beast")));
check("a Dire Wolf too", got(npc("Dire Wolf", "beast")) === "dead-wolf-grey.png", got(npc("Dire Wolf", "beast")));
check("a Giant Frog is not a dead giant or a giant spider: \"giant\" names another type, so it gets dead-beast",
  got(npc("Giant Frog", "beast")) === "dead-beast.png", got(npc("Giant Frog", "beast")));
check("a Giant Spider gets its own picture (dead-giant spider-11)",
  got(npc("Giant Spider", "beast")) === "dead-giant spider-11.png", got(npc("Giant Spider", "beast")));
check("a Frost Giant gets a plain dead giant, not the Hill Giant or the spider",
  /^dead-giant(-11)?\.(png|webp)$/.test(got(npc("Frost Giant", "giant"))), got(npc("Frost Giant", "giant")));
check("a Hill Giant gets Dead-Hill-Giant", got(npc("Hill Giant", "giant")) === "Dead-Hill-Giant.png");
check("a Goblin Boss gets dead-goblin (a name word), not Dead-Goblinoid (the subtype) or dead-fey (the type)",
  got(npc("Goblin Boss", "fey", "goblinoid")) === "dead-goblin.png", got(npc("Goblin Boss", "fey", "goblinoid")));
check("a Cultist gets dead-cultist-11 over the Aberrant Cultist (fewest words it does not have)",
  got(npc("Cultist", "humanoid")) === "dead-cultist-11.png", got(npc("Cultist", "humanoid")));
check("Kasimir Velikov, an elf by subtype, gets dead-elf, not the generic Dead-Humanoid",
  got(npc("Kasimir Velikov", "humanoid", "elf")) === "dead-elf.png", got(npc("Kasimir Velikov", "humanoid", "elf")));
check("Ezmerelda, a human by subtype, gets Dead-Humanoid, not the human hag or the bandit",
  got(npc("Ezmerelda d'Avenir", "humanoid", "human")) === "Dead-Humanoid.png", got(npc("Ezmerelda d'Avenir", "humanoid", "human")));
check("an Erinyes (a devil by subtype) gets dead-fiend, not the Barbed Devil's picture",
  /^dead-fiend(-11)?\.png$/.test(got(npc("Erinyes", "fiend", "devil"))), got(npc("Erinyes", "fiend", "devil")));
check("a Gazer (a beholder by subtype) gets dead-beholder, not the generic aberration",
  got(npc("Gazer", "aberration", "beholder")) === "dead-beholder.png", got(npc("Gazer", "aberration", "beholder")));
// A job word only matches a picture filed under the creature's own type.
check("Lord Soth (undead) is not given the Animal Lord (Wolf)",
  got(npc("Lord Soth", "undead")) === "dead-undead.png", got(npc("Lord Soth", "undead")));
check("a Guard Drake (dragon) is not given the human guard",
  /^dead-dragon/.test(got(npc("Guard Drake", "dragon"))), got(npc("Guard Drake", "dragon")));
check("a Town Guard (humanoid) still is", got(npc("Town Guard", "humanoid")) === "dead-guard.png", got(npc("Town Guard", "humanoid")));
check("a Star Spawn Grue (aberration) is not given the vampire spawn",
  got(npc("Star Spawn Grue", "aberration")) === "dead-aberration.png", got(npc("Star Spawn Grue", "aberration")));
check("a Vampire Spawn still is", got(npc("Vampire Spawn", "undead")) === "dead-vampire-spawn-22.png", got(npc("Vampire Spawn", "undead")));
check("a Phantom Warrior (undead) is not given a drow warrior",
  got(npc("Phantom Warrior", "undead")) === "dead-undead.png", got(npc("Phantom Warrior", "undead")));
check("a Drow Elite Warrior gets the drow warrior (two of its words)",
  got(npc("Drow Elite Warrior", "humanoid", "elf")) === "dead-drow-warrior-11.png", got(npc("Drow Elite Warrior", "humanoid", "elf")));
check("a 2014 Goblin Boss (humanoid) still gets dead-goblin, filed under Fey by the 2024 type",
  got(npc("Goblin Boss (Legacy)", "humanoid", "goblinoid")) === "dead-goblin.png", got(npc("Goblin Boss (Legacy)", "humanoid", "goblinoid")));
{
  const only = (...names) => indexArt(names.map(n => `modules/ace-qol/Assets/Dead/${n}`));
  const own = bestArt(only("dead-arcanaloth-fiend.png", "dead-neferon.png"), creatureWords(neferon));
  check("a picture with his own name beats what he was made from",
    file(own?.path) === "dead-neferon.png", file(own?.path));
  const exact = bestArt(only("dead-frog.png", "dead-giant frog.png"), creatureWords(npc("Giant Frog", "beast")));
  check("and a file for the whole \"Giant Frog\" beats a plain frog",
    file(exact?.path) === "dead-giant frog.png", file(exact?.path));
  const order = bestArt(only("dead-fiend.png", "dead-yugoloth.png"), creatureWords(npc("Mezzoloth", "fiend", "yugoloth")));
  check("a picture that is exactly its subtype (dead-yugoloth) beats the generic type file (dead-fiend)",
    file(order?.path) === "dead-yugoloth.png", file(order?.path));
  const sub = bestArt(only("dead-yugoloth.png", "dead-beast.png"), creatureWords(npc("Mezzoloth", "fiend", "yugoloth")));
  check("and the subtype answers when the type has no picture", file(sub?.path) === "dead-yugoloth.png", file(sub?.path));
  const made = bestArt(only("dead-goblin warrior.png", "dead-fey.png"),
    creatureWords(npc("Grish", "fey", "goblinoid", { stats: { compendiumSource: "Compendium.dnd5e.actors24.Actor.mmGoblinWarrior0" } })));
  check("a renamed creature is found by the compendium entry it was dropped from (Grish, a Goblin Warrior)",
    file(made?.path) === "dead-goblin warrior.png", file(made?.path));
  const mixed = bestArt(only("dead-goblin.png", "prone-goblin.png"), creatureWords(npc("Goblin", "fey", "goblinoid")));
  check("a picture made for lying down beats a corpse that fits the creature as well",
    file(mixed?.path) === "prone-goblin.png", file(mixed?.path));
  const pc = npc("Varek", "humanoid", "", { race: { name: "Tiefling" } });
  check("the race is read from the species ITEM dnd5e prepares",
    file(bestArt(only("dead-tiefling.png"), creatureWords(pc))?.path) === "dead-tiefling.png");
  check("a race that is only a missing item's id is not a word",
    !creatureWords(npc("Varek", "humanoid", "", { race: "aB3dE5fG7hJ9kL1m" })).levels[3].words.size);
  check("ranked, not first-found: every candidate for Neferon is listed, the arcanaloth first",
    rankArt(index, creatureWords(neferon)).map(r => file(r.entry.path)).slice(0, 3).join(", ")
      === "dead-arcanaloth-fiend.png, dead-fiend-11.png, dead-fiend.png"
    || rankArt(index, creatureWords(neferon)).map(r => file(r.entry.path)).slice(0, 3).join(", ")
      === "dead-arcanaloth-fiend.png, dead-fiend.png, dead-fiend-11.png");
}

// ── The first-name rule still works ──
check("Firaxis Greenbeard still gets prone-firaxis", got(npc("Firaxis Greenbeard", "humanoid")) === "prone-firaxis.webp");
check("Izek Strazni still gets prone-Izek", got(npc("Izek Strazni", "humanoid", "human")) === "prone-Izek.png");

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
  check("goProne puts dead-arcanaloth-fiend on Neferon's token and remembers what he was wearing",
    file(u["texture.src"]) === "dead-arcanaloth-fiend.png"
      && u["flags.ace-qol.proneArtPrevious"] === "NPCs/FIENDS/Arcanaloth%20033.png",
    `${file(u["texture.src"])}, remembers ${u["flags.ace-qol.proneArtPrevious"]}`);

  const lost = { ...doc, name: "Nobody", actor: { ...npc("Nobody", "celestial", "angel"), statuses: new Set(["prone"]) } };
  wrote.length = 0; lines.length = 0;
  console.log = (...a) => lines.push(a.join(" "));
  try { await ProneArt.goProne(lost); } finally { console.log = log; }
  check("a creature with no picture says so in the console, with the words it was asked by, instead of nothing",
    !wrote.length && lines.some(l => /Nobody is prone, but no prone art matched \(asked for: name: nobody; type: celestial; subtype: angel\)/.test(l)),
    lines.find(l => /Nobody/.test(l)) ?? "no line");
}

// ── The fall ──
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
