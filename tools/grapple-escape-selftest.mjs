// ─── A GRAPPLE IS NOT OVER WHEN IT LANDS ─────────────────────────────────────
//
// The One Road stamp, 2026-09-29. When an attack's recipe puts Grappled on a
// creature, the START-OF-TURN break-free check is armed on THAT creature — the
// same door Web already uses. The victim is asked on their own turn. The one
// swinging is never asked.
//
// ⚠️ NO NEW ENGINE. BreakFreeEngine has prompted at the start of a trapped
// creature's turn since the Entangling Rope, reading `flags.ace-qol.breakFree`
// off the effect. All that was missing was somebody writing that flag when a
// weapon grapples, and the DC to write in it.
//
// ⚠️ THE DC COMES FROM THE ITEM'S OWN WORDS. 550 items in hijinx mention a
// grapple and 234 carry it in one shape: "(escape DC 14)". Nothing read it, so
// the number sat in the prose and the escape was the GM's to remember.
//
// ⚠️ AND THE READER REFUSES TO GUESS. Some of his items write the DC as an
// enricher or as a formula ("equals 8 plus your proficiency"). Those have no
// plain number, so it answers null and says so. A wrong DC is worse than none.
import { existsSync, mkdtempSync, cpSync } from "node:fs";
import { join, basename } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

const MODULE = "file:///D:/FoundryVTT/Data/modules/ace-qol";
const WORLD = "D:/FoundryVTT/Data/worlds/hijinx/data";
const LEVELDB = "D:/FoundryVTT/Foundry Virtual Tabletop/resources/app/node_modules/classic-level/index.js";

let pass = 0, fail = 0;
const check = (label, ok, detail = "") => {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${String(label).padEnd(62)} ${detail}`);
};

/* ══ the least Foundry these readers need ═════════════════════════════════ */
globalThis.Hooks = { on: () => {}, once: () => {}, callAll: () => {}, call: () => true };
globalThis.CONFIG = { DND5E: { abilities: { str: { label: "Strength" }, dex: { label: "Dexterity" } },
  // dnd5e's own skill labels, which is what the result card prints.
  skills: { ath: { label: "Athletics", ability: "str" }, acr: { label: "Acrobatics", ability: "dex" } },
  conditionTypes: {}, statusEffects: [], damageTypes: {} }, Dice: {} };
globalThis.ui = { notifications: { warn: () => {}, error: () => {}, info: () => {} } };
const el = () => ({ classList: { add() {}, remove() {}, contains: () => false }, dataset: {}, style: {},
  children: [], appendChild() {}, remove() {}, setAttribute() {}, getAttribute: () => null,
  addEventListener() {}, querySelector: () => null, querySelectorAll: () => [], closest: () => null,
  insertAdjacentHTML() {}, textContent: "", innerHTML: "" });
globalThis.document = { querySelector: () => null, querySelectorAll: () => [], createElement: el,
  body: el(), head: el(), addEventListener() {} };
globalThis.window = globalThis;
class AppStub { static DEFAULT_OPTIONS = {}; static PARTS = {}; render() {} close() {} }
globalThis.foundry = {
  applications: { api: { ApplicationV2: AppStub, HandlebarsApplicationMixin: (b) => b, DialogV2: AppStub },
    ux: { TextEditor: { implementation: { enrichHTML: async (s) => s } } }, sheets: {},
    handlebars: { renderTemplate: async () => "" } },
  appv1: { api: { Application: AppStub, Dialog: AppStub, FormApplication: AppStub } },
  abstract: { DataModel: AppStub, TypeDataModel: AppStub }, data: { fields: {} },
  documents: { collections: {} }, canvas: { placeables: {} },
  utils: { getProperty: (o, p) => p.split(".").reduce((x, k) => x?.[k], o),
    setProperty: (o, p, v) => { const ks = p.split("."); let x = o;
      for (const k of ks.slice(0, -1)) x = (x[k] ??= {}); x[ks.at(-1)] = v; return true; },
    deepClone: (o) => (o && typeof o === "object" ? structuredClone(o) : o),
    mergeObject: (a, b) => ({ ...a, ...b }), randomID: () => "x",
    escapeHTML: (v) => String(v ?? "").replace(/[&<>"']/g, c =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])) },
};
globalThis.game = { ready: true, user: { isGM: true, id: "gm" }, users: [],
  settings: { get: () => true, set: async () => {}, register: () => {} },
  modules: new Map(), system: { id: "dnd5e", version: "5.x" }, actors: new Map(), items: new Map(),
  i18n: { localize: (k) => k, format: (k) => k }, combat: { round: 3, turn: 1 }, combats: [],
  time: { worldTime: 0 } };
globalThis.canvas = { ready: false, tokens: { placeables: [] }, scene: null, grid: {}, dimensions: {} };
globalThis.ChatMessage = { create: async (d) => d, getSpeaker: () => ({}) };
globalThis.Roll = class { constructor(f) { this.formula = String(f ?? "0"); this.terms = []; }
  get isDeterministic() { return false; } async evaluate() { this.total = 0; return this; } };
globalThis.fromUuid = async () => null;
globalThis.fromUuidSync = () => null;

/* ══ his real Spiked Chain ════════════════════════════════════════════════ */
let CHAIN = null;
if (existsSync(join(WORLD, "actors", "CURRENT")) && existsSync(LEVELDB)) {
  const { ClassicLevel } = await import(pathToFileURL(LEVELDB).href);
  const dst = join(mkdtempSync(join(tmpdir(), "ace-ge-")), "actors");
  cpSync(join(WORLD, "actors"), dst, { recursive: true, filter: (s) => basename(s) !== "LOCK" });
  const db = new ClassicLevel(dst, { valueEncoding: "json" });
  await db.open();
  for await (const [k, v] of db.iterator()) {
    if (k.startsWith("!actors.items!") && /^Spiked Chain/i.test(v?.name ?? "")) { CHAIN = v; break; }
  }
  await db.close();
}
const CHAIN_WORDS = CHAIN?.system?.description?.value
  ?? '<p>Reach 10 ft. <em>Hit:</em> 2d6 piercing. The target must succeed on a DC 14 save '
   + 'or suffer one of the following.</p><p><strong>3\u20134: Grapple.</strong> The target is '
   + 'grappled (escape DC 14) if it is a Medium or smaller creature.</p>';

console.log(`\nA GRAPPLE IS NOT OVER WHEN IT LANDS`);
console.log(`  ${CHAIN ? "his own Spiked Chain, read from hijinx" : "the same words, stood in"}\n`);

const { DescriptionParser } = await import(`${MODULE}/scripts/description-parser.mjs`);
const { PostHitSaves } = await import(`${MODULE}/scripts/post-hit-saves.mjs`);

const chain = { id: "chain", name: "Spiked Chain", type: "feat", uuid: "Item.chain",
  system: { description: { value: CHAIN_WORDS } } };

/* ══ 1. THE READER ═══════════════════════════════════════════════════════ */
console.log("THE ESCAPE IS READ FROM THE ITEM'S OWN WORDS");
{
  const e = DescriptionParser.escapeFromGrapple(chain);
  check("it finds the escape DC his Spiked Chain states", e?.dc === 14, `DC ${e?.dc ?? "none"}`);
  check("and offers Athletics or Acrobatics, which is what the rules give",
    e?.abilities?.join(",") === "str,dex", (e?.abilities ?? []).join(" or "));
  check("it quotes the sentence it took the number from",
    /escape DC 14/i.test(e?.sentence ?? ""), `"${(e?.sentence ?? "").slice(0, 58)}..."`);

  // ⚠️ IT REFUSES TO GUESS.
  const vague = { name: "Vague Grabber", system: { description: { value:
    "<p>The target is grappled (escape DC [[/check dex]]).</p>" } } };
  check("an escape DC written as an enricher arms nothing",
    DescriptionParser.escapeFromGrapple(vague) === null, "no number, no prompt");

  const formula = { name: "Proficiency Grabber", system: { description: { value:
    "<p>The target is grappled. The DC for any escape attempts equals 8 plus your "
    + "proficiency bonus.</p>" } } };
  check("an escape DC written as a formula arms nothing either",
    DescriptionParser.escapeFromGrapple(formula) === null, "a wrong DC is worse than none");

  const nothing = { name: "Longsword", system: { description: { value: "<p>A sword.</p>" } } };
  check("an item that does not grapple is not read at all",
    DescriptionParser.escapeFromGrapple(nothing) === null);
}

/* ══ 2. THE STAMP, ON THE CREATURE THAT WAS GRABBED ══════════════════════ */
console.log("\nTHE STAMP GOES ON THE VICTIM, THROUGH THE DOOR WEB USES");
{
  const effectOn = (statuses) => {
    const e = { id: "e1", name: "Grappled", disabled: false, statuses: new Set(statuses),
      flags: {}, update: async (u) => {
        for (const [k, v] of Object.entries(u)) foundry.utils.setProperty(e, k, v);
        return e;
      } };
    return e;
  };
  const victim = (effects) => ({ id: "v", name: "Krusk", effects: { contents: effects } });

  const eff = effectOn(["grappled"]);
  const krusk = victim([eff]);
  await PostHitSaves._armEscape(krusk, chain, "Krusk");
  const meta = eff.flags?.["ace-qol"]?.breakFree;
  check("the grappled effect carries the break-free flag the engine reads",
    !!meta && meta.dc === 14, meta ? `DC ${meta.dc}` : "nothing stamped");
  check("it names the item, so the prompt says what has hold of him",
    meta?.label === "Spiked Chain", meta?.label ?? "");
  check("and it carries both abilities for the victim to choose from",
    meta?.abilities?.join(",") === "str,dex", (meta?.abilities ?? []).join(" or "));
  check("with the round and turn it was applied, so the first prompt is the NEXT turn",
    meta?.appliedRound === 3 && meta?.appliedTurn === 1,
    `round ${meta?.appliedRound}, turn ${meta?.appliedTurn}`);

  // Twice on the same grapple must not re-stamp and reset the turn guard.
  const before = meta.stampedAt;
  await PostHitSaves._armEscape(krusk, chain, "Krusk");
  check("arming it twice leaves the first stamp alone",
    eff.flags["ace-qol"].breakFree.stampedAt === before, "no double-arm");

  // ⚠️ AND NOTHING IS STAMPED WHERE THERE IS NO GRAPPLE.
  const other = effectOn(["prone"]);
  await PostHitSaves._armEscape(victim([other]), chain, "Krusk");
  check("a creature knocked prone by the same item gets no escape prompt",
    !other.flags?.["ace-qol"]?.breakFree, "prone is not a grapple");
}

/* ══ 3. NOBODY IS ASKED ═════════════════════════════════════════════════ */
// ⚠️ HIS RULE, 2026-09-29: "do not ask Strength or Dexterity. Roll the higher of
// the victim's Strength (Athletics) and Dexterity (Acrobatics) against the stamped
// DC. One whisper to the victim's owners. No Dialog. No two buttons."
console.log("\nTHE GRAPPLE ESCAPE ROLLS ITSELF");
{
  const { BreakFreeEngine } = await import(`${MODULE}/scripts/break-free-engine.mjs`);

  const eff = { id: "e1", name: "Grappled", disabled: false, statuses: new Set(["grappled"]),
    flags: { "ace-qol": { breakFree: { auto: true, ability: "str", abilities: ["str", "dex"],
      dc: 14, label: "Spiked Chain", itemUuid: "Item.chain" } } },
    update: async (u) => { for (const [k, v] of Object.entries(u)) foundry.utils.setProperty(eff, k, v); },
    delete: async () => { eff.deleted = true; } };

  const victim = (ath, acr) => ({
    id: "v", name: "Krusk", uuid: "Actor.v", img: "",
    system: { attributes: { hp: { value: 30, max: 30 } },
      skills: { ath: { total: ath }, acr: { total: acr } },
      abilities: { str: { mod: 3 }, dex: { mod: 1 } } },
    statuses: new Set(["grappled"]), effects: { contents: [eff], get: () => eff },
    getFlag: () => undefined, getRollData: () => ({ abilities: { str: { mod: 3 }, dex: { mod: 1 } } }),
    testUserPermission: () => true, getActiveTokens: () => [],
    rollSkill: async ({ skill }) => { rolled.push(skill); return { total: nextTotal, dice: [{ total: 11 }] }; },
  });

  let rolled = [], nextTotal = 0, posted = [];
  globalThis.ChatMessage = { create: async (d) => { posted.push(d); return d; },
    getSpeaker: () => ({}) };
  globalThis.fromUuid = async () => victimActor;

  // ── Athletics is better: that is what gets rolled, and it passes. ──
  let victimActor = victim(7, 2);
  rolled = []; posted = []; nextTotal = 18; eff.deleted = false;
  await BreakFreeEngine._autoAttempt(victimActor, null, eff, eff.flags["ace-qol"].breakFree, 4, 0);
  check("it rolls the better skill without asking", rolled.join(",") === "ath",
    `rolled ${rolled.join(",") || "nothing"}`);
  check("no dialog and no buttons were built", posted.every(p => !/breakfree-go/.test(p.content ?? "")),
    `${posted.length} message(s), none with a button`);
  check("a pass takes the Grappled off", eff.deleted === true, "the effect was deleted");
  check("and one whisper goes to the victim's owners, not the table",
    posted.length === 1 && Array.isArray(posted[0].whisper) && posted[0].whisper.length > 0,
    `${posted.length} card, whispered`);
  check("the whisper says the score, the roll and the verdict",
    /Athletics/.test(posted[0].content) && /18/.test(posted[0].content)
    && /vs DC 14/.test(posted[0].content) && /Broke free/.test(posted[0].content),
    "what was rolled, which score, pass or fail");

  // ── Acrobatics is better: the rogue uses it. ──
  victimActor = victim(1, 9);
  rolled = []; posted = []; nextTotal = 19; eff.deleted = false;
  delete eff.flags["ace-qol"].breakFree.promptedRound;
  await BreakFreeEngine._autoAttempt(victimActor, null, eff, eff.flags["ace-qol"].breakFree, 5, 0);
  check("a creature better at Acrobatics rolls that instead", rolled.join(",") === "acr",
    `rolled ${rolled.join(",")}`);

  // ── A failure leaves the hold on. ──
  victimActor = victim(7, 2);
  rolled = []; posted = []; nextTotal = 9; eff.deleted = false;
  await BreakFreeEngine._autoAttempt(victimActor, null, eff, eff.flags["ace-qol"].breakFree, 6, 0);
  check("a fail leaves the Grappled on", eff.deleted === false, "still held");
  check("and the whisper says so", /holds/.test(posted[0]?.content ?? ""),
    "the grapple holds");
}

/* ══ 4. WEB AND THE ROPE KEEP THEIR BUTTON ══════════════════════════════ */
console.log("\nA STAMP THAT DOES NOT SAY auto STILL ASKS");
{
  const src = await import("node:fs").then(fs =>
    fs.readFileSync("D:/FoundryVTT/Data/modules/ace-qol/scripts/break-free-engine.mjs", "utf8"));
  check("only an auto stamp rolls itself; everything else posts the prompt",
    /if \(meta\.auto\) this\._autoAttempt/.test(src) && /else this\._postPrompt/.test(src),
    "Web, the net and the Entangling Rope are untouched");
  check("and the prompt is ONE button again, not two",
    !/abilities\.map\(a =>/.test(src) && /data-ability="\$\{meta\.ability\}"/.test(src),
    "no picker anywhere");
  check("the turn scan sees a grapple as well as a restraint",
    /statuses\?\.has\?\.\("grappled"\)/.test(src),
    "a grapple is held too");
  check("the prompt still goes to the trapped creature's own owners",
    /whisper/i.test(src), "whispered, not posted to the table");
}

/* ══ 5. THE REGENERATION CARD ═══════════════════════════════════════════ */
// ⚠️ HIS RULE: "Portrait about one-third the current height. APPLIED button:
// green, full width of the card, ~10px taller." It had NO css at all, so the
// portrait rendered at the token image's own size and filled the card.
console.log("\nTHE REGENERATION CARD, START OF TURN");
{
  const css = await import("node:fs").then(fs =>
    fs.readFileSync("D:/FoundryVTT/Data/modules/ace-qol/styles/ace-qol.css", "utf8"));
  const block = css.slice(css.indexOf(".ace-qol-regen-card .ace-qol-ot-header"));
  check("the portrait has a size at last", /\.ace-qol-regen-card \.ace-qol-ot-token-img/.test(css)
    && /width: 84px; height: 84px/.test(block), "84px, about a third of a full-width portrait");
  check("the APPLY button is green", /background: #9bcc4a/.test(block), "#9bcc4a");
  check("and the full width of the card", /width: 100%/.test(block), "width: 100%");
  check("and taller, with min-height so a long label still wraps",
    /min-height: 44px/.test(block) && /white-space: normal/.test(block),
    "every pill fits its own text");
  // ⚠️ REGENERATION ONLY. The over-time damage card and the aura card share the
  // same ot- classes and must not move.
  check("every rule is scoped to the regeneration card alone",
    block.split("}").filter(r => r.includes("{")).every(r => /\.ace-qol-regen-card/.test(r)),
    "the damage and aura cards are untouched");
  const engine = await import("node:fs").then(fs =>
    fs.readFileSync("D:/FoundryVTT/Data/modules/ace-qol/scripts/overtime-engine.mjs", "utf8"));
  check("and nothing changed about when regen fires or how much it heals",
    /Should regain <strong>\$\{amount\}<\/strong> HP/.test(engine)
    && /APPLY \$\{amount\} HP/.test(engine), "the card's own words are as they were");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.stdout.write("", () => process.exit(fail ? 1 : 0));
