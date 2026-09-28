// ─── DOES THIS EFFECT LAND ON THIS CREATURE? ─────────────────────────────────
//
// The One Road's target-profile question, asked before APPLY.
//
// ⚠️ WHY. Jeth wears a Cloak of Arachnida, attuned, and its words say "You can't
// be caught in webs of any sort." The item carries NO active effect at all, so
// nothing in Foundry, dnd5e or ACE had ever stopped a web restraining him. That
// is the hollow shape: it reads as working and does nothing.
//
// ⚠️ AND A SECOND THING WAS WRONG ON THE SAME WALK-IN. Kasimir's Web stores a
// 2d4 fire damage part on its Dexterity save activity. Web deals no damage for
// failing that save; the 2d4 belongs to its burning-webs clause, which needs the
// webs set alight and a creature starting its turn in the flames. So the recipe
// read "on fail 2d4 fire, restrained", the save card grew a ROLL DAMAGE button,
// and failing to dodge a web set a man on fire.
//
// ⚠️ NOTHING HERE NAMES A SPELL OR AN ITEM IN THE CODE IT TESTS. The ward is read
// from the TARGET's words, the material from the SOURCE's words, and the save's
// damage from the sentence that owns it. These pins use his real text because
// that is what has to work, not because the code knows those names.
//
// ⚠️ THE RULE THAT MUST NOT MOVE: Fireball. "A target takes 8d6 fire damage on a
// failed save, or half as much on a successful one" is a conditional sentence
// too, so a plain "is this gated" test would strip the most-cast spell in the
// game. A sentence that ties the damage to the save always keeps it.
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
  console.log(`  ${ok ? "ok  " : "FAIL"} ${String(label).padEnd(60)} ${detail}`);
};

/* ══ the least Foundry these readers need ═════════════════════════════════ */
globalThis.Hooks = { on: () => {}, once: () => {}, callAll: () => {}, call: () => true };
globalThis.CONFIG = { DND5E: { abilities: {}, conditionTypes: {}, statusEffects: [], damageTypes: {} }, Dice: {} };
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
  settings: { get: () => undefined, set: async () => {}, register: () => {} },
  modules: new Map(), system: { id: "dnd5e", version: "5.x" }, actors: new Map(), items: new Map(),
  i18n: { localize: (k) => k, format: (k) => k, getListFormatter: () => ({ format: (a) => a.join(", ") }) },
  combat: null, combats: [], time: { worldTime: 0 } };
globalThis.canvas = { ready: false, tokens: { placeables: [] }, scene: null, grid: {}, dimensions: {} };
globalThis.ChatMessage = { create: async (d) => d, getSpeaker: () => ({}) };
globalThis.Roll = class { constructor(f) { this.formula = String(f ?? "0"); this.terms = []; }
  get isDeterministic() { return !/\d*d\d+/i.test(this.formula); }
  async evaluate() { this.total = 0; return this; } };
globalThis.fromUuid = async () => null;
globalThis.fromUuidSync = () => null;

/* ══ his real words ═══════════════════════════════════════════════════════ */
let CLOAK = null, WEB = null, fromWorld = false;
if (existsSync(join(WORLD, "actors", "CURRENT")) && existsSync(LEVELDB)) {
  const { ClassicLevel } = await import(pathToFileURL(LEVELDB).href);
  const dst = join(mkdtempSync(join(tmpdir(), "ace-tw-")), "actors");
  cpSync(join(WORLD, "actors"), dst, { recursive: true, filter: (s) => basename(s) !== "LOCK" });
  const db = new ClassicLevel(dst, { valueEncoding: "json" });
  await db.open();
  for await (const [k, v] of db.iterator()) {
    if (!k.startsWith("!actors.items!")) continue;
    if (!CLOAK && v?.name === "Cloak of Arachnida") CLOAK = v;
    if (!WEB && v?.name === "Web" && v?.type === "spell") WEB = v;
  }
  await db.close();
  fromWorld = !!(CLOAK && WEB);
}
// The same words, for a machine without his world. Both editions say it the same way.
const CLOAK_WORDS = CLOAK?.system?.description?.value
  ?? "<p>While wearing it, you gain the following benefits. <b>Poison Resistance.</b> You have "
   + "Resistance to Poison damage. <b>Spider Climb.</b> You have a Climb Speed equal to your Speed. "
   + "<b>Spider Walk.</b> You can't be caught in webs of any sort and can move through webs as if "
   + "they were Difficult Terrain.</p>";
const WEB_WORDS = WEB?.system?.description?.value
  ?? "<p>You conjure a mass of sticky webbing. The webs are difficult terrain. The first time a "
   + "creature enters the webs on a turn or starts its turn there, it must succeed on a Dexterity "
   + "saving throw or have the Restrained condition while in the webs. Any 5-foot Cube of webs "
   + "exposed to fire burns away in 1 round, dealing [[/damage 2d4 type=fire]] damage to any "
   + "creature that starts its turn in the fire.</p>";
const FIREBALL_WORDS = "<p>Each creature in a 20-foot-radius Sphere centered on that point must make a "
  + "Dexterity saving throw. On a failed save, the creature takes [[/damage 8d6 type=fire]] damage, "
  + "or half as much damage on a successful save.</p>";

console.log(`\nDOES THIS EFFECT LAND ON THIS CREATURE?`);
console.log(`  ${fromWorld ? "the cloak's and Web's own words, read from hijinx"
  : "his world is not on this machine; the same words stood in"}\n`);

const { readWards, wardAgainst, wardIsLive, sourceIsMadeOf } =
  await import(`${MODULE}/scripts/profiles/target-wards.mjs`);
const { damageTheSaveDeals, damageWordsOf } = await import(`${MODULE}/scripts/inference/recipe.mjs`);

const gear = (name, words, { equipped = true, attuned = true, attunement = "required", type = "equipment" } = {}) => ({
  id: `it-${name}`, name, type, uuid: `Item.${name}`,
  system: { equipped, attuned, attunement, description: { value: words } },
});
const jeth = (items) => ({ id: "jeth", name: "Jeth", type: "character", items });
const web = { id: "web", name: "Web", type: "spell", uuid: "Item.web",
  system: { description: { value: WEB_WORDS } } };

/* ══ 1. THE READER ════════════════════════════════════════════════════════ */
console.log("THE READER FINDS THE WARD IN THE CLOAK'S OWN WORDS");
{
  const cloak = gear("Cloak of Arachnida", CLOAK_WORDS);
  const wards = readWards(jeth([cloak]));
  const w = wards.find(x => x.material === "web");
  check("it reads a ward against being caught in webs", !!w,
    w ? `${w.source}: ${w.conditions.join("+")} against ${w.material}s` : `found ${wards.length} ward(s)`);
  check("and it names the two conditions that mean held fast",
    !!w && w.conditions.includes("restrained") && w.conditions.includes("grappled"),
    w ? w.conditions.join(", ") : "");
  // ⚠️ THE CLOAK IS NOT EMPTY, IT IS HALF DONE. Its one active effect grants poison
  // resistance and a climb speed. Nothing on it mentions webs or restrained, so the
  // Spider Walk clause has never been implemented anywhere: the words are all there is.
  // ⚠️ V13 keeps an item's effects in their OWN database rows, so the item row here
  // carries none inline. Read from the world separately they are two changes, poison
  // resistance and a climb speed, and that is the whole of what the cloak does.
  check("nothing on the cloak mentions webs or being restrained",
    !/web|restrain/i.test(JSON.stringify(CLOAK?.effects ?? [])),
    "its effect grants poison resistance and a climb speed, and stops there");

  // ⚠️ GEAR HAS TO BE EARNED, the same rule dnd5e uses for a weapon's +1.
  check("a cloak in the pack wards nothing",
    wardIsLive(gear("Cloak of Arachnida", CLOAK_WORDS, { equipped: false })).live === false, "not worn");
  check("an unattuned cloak that requires attunement wards nothing",
    wardIsLive(gear("Cloak of Arachnida", CLOAK_WORDS, { attuned: false })).live === false, "not attuned");
}

/* ══ 2. THE JOIN: the ward covers webbing, and only webbing ═══════════════ */
console.log("\nTHE WARD COVERS WHAT ITS OWN WORDS COVER, AND NOTHING ELSE");
{
  const worn = jeth([gear("Cloak of Arachnida", CLOAK_WORDS)]);
  const packed = jeth([gear("Cloak of Arachnida", CLOAK_WORDS, { equipped: false })]);

  const v = wardAgainst(worn, "restrained", { item: web });
  check("webbing cannot restrain him", v.warded === true, v.why ?? "not warded");
  check("and the reason names the cloak", /cloak of arachnida/i.test(v.why ?? ""), v.why ?? "");

  // Not webbing: a vine, a net, a giant's hand. The ward says webs, so it stays out of it.
  const vine = { id: "v", name: "Grasping Vine", type: "spell",
    system: { description: { value: "<p>The vine lashes out and the target is Restrained.</p>" } } };
  const notWeb = wardAgainst(worn, "restrained", { item: vine });
  check("a vine still restrains him: the cloak wards webs", notWeb.warded === false,
    notWeb.held?.[0]?.heldBecause ?? "");

  // A condition the ward never mentions.
  check("the cloak does not make him immune to being frightened",
    wardAgainst(worn, "frightened", { item: web }).warded === false);

  // In the pack it refuses nothing, and says why rather than going quiet.
  const off = wardAgainst(packed, "restrained", { item: web });
  check("in the pack it refuses nothing, and says why", off.warded === false
    && /not being worn/.test(off.held?.[0]?.heldBecause ?? ""), off.held?.[0]?.heldBecause ?? "");

  check("the source side is read from the source's own words",
    sourceIsMadeOf(web, "web") === true && sourceIsMadeOf(vine, "web") === false);
}

/* ══ 3. BEFORE APPLY: the door refuses it ═════════════════════════════════ */
console.log("\nTHE CONDITION DOOR ASKS BEFORE IT WRITES");
{
  const { ConditionDoor } = await import(`${MODULE}/scripts/road/doors.mjs`);
  const { ConditionLibrary } = await import(`${MODULE}/scripts/condition-library.mjs`);
  const worn = jeth([gear("Cloak of Arachnida", CLOAK_WORDS)]);

  // Nothing is allowed to reach the library when a ward refuses it.
  const keep = ConditionLibrary.applyByName;
  let reached = 0;
  ConditionLibrary.applyByName = async () => { reached++; return { ok: true }; };
  try {
    const out = await ConditionDoor.apply(worn, "restrained", {}, { item: web });
    check("the door refuses it and hands back the reason",
      out?.warded === true && /cloak of arachnida/i.test(out?.why ?? ""), out?.why ?? JSON.stringify(out));
    check("and the condition library is never reached", reached === 0, `${reached} call(s)`);

    reached = 0;
    const vine = { id: "v", name: "Grasping Vine", type: "spell",
      system: { description: { value: "<p>The target is Restrained.</p>" } } };
    const out2 = await ConditionDoor.apply(worn, "restrained", {}, { item: vine });
    check("something that is not webbing goes through as it always did",
      out2?.ok === true && reached === 1, `${reached} call(s)`);
  } finally { ConditionLibrary.applyByName = keep; }
}

/* ══ 4. WEB'S FAILED SAVE IS NOT FIRE ════════════════════════════════════ */
console.log("\nA SAVE DEALS THE DAMAGE ITS OWN SENTENCE GIVES IT");
{
  const plain = (h) => String(damageWordsOf(h)).replace(/<[^>]+>/g, " ")
    .replace(/&[a-z]+;/gi, " ").replace(/&?Reference\[(\w+)[^\]]*\](\{[^}]*\})?/gi, "$1")
    .replace(/\s+/g, " ").trim();

  const fire = [{ formula: "2d4", types: ["fire"] }];
  const webOut = damageTheSaveDeals(fire, plain(WEB_WORDS));
  check("Web's failed save deals no damage", webOut.kept.length === 0,
    webOut.dropped[0]?.why ?? "kept it");
  check("and the reason is the sentence that owns the fire",
    /burns away|starts its turn/i.test(webOut.dropped[0]?.why ?? ""), webOut.dropped[0]?.why ?? "");

  // ⚠️ THE ONE THAT MUST NOT MOVE.
  const ball = damageTheSaveDeals([{ formula: "8d6", types: ["fire"] }], plain(FIREBALL_WORDS));
  check("Fireball still deals its 8d6 fire on a failed save", ball.kept.length === 1,
    ball.dropped[0]?.why ?? "kept");

  // A damage the words never mention is kept: the data is all there is.
  const quiet = damageTheSaveDeals([{ formula: "1d8", types: ["acid"] }],
    "A creature must make a Constitution saving throw.");
  check("a damage the words never mention is kept", quiet.kept.length === 1);

  // And the enricher keeps its dice, which is what made the rule able to see it.
  check("a damage enricher is written out with its dice and its type",
    /2d4 fire damage/i.test(plain(WEB_WORDS)), plain(WEB_WORDS).match(/[^.]*2d4[^.]*/)?.[0]?.trim().slice(0, 70) ?? "");
}

/* ══ 5. HIS WALK-IN, END TO END ══════════════════════════════════════════ */
console.log("\nKASIMIR'S WEB, JETH WALKING IN");
{
  const { whatLands } = await import(`${MODULE}/scripts/road/what-lands.mjs`);
  // The recipe as the reader now builds it for a web: restrained on a failure,
  // and no damage of any kind.
  const recipe = { decidedBy: { kind: "save", ability: "dex" },
    onFail: [{ kind: "condition", condition: { key: "restrained" } }], onSuccess: [] };
  const v = whatLands(recipe, { passed: false });
  check("1. nothing stops him entering: the trigger runs and asks for a save",
    v.share === 1 && v.why.length > 0, v.why);
  check("2. the failure puts restrained on the list, and no damage with it",
    v.conditions.some(c => c.key === "restrained") && v.damage.length === 0,
    `${v.conditions.length} condition(s), ${v.damage.length} damage`);
  check("4. no damage means no ROLL DAMAGE button: the card has nothing to roll",
    v.damage.length === 0 && (recipe.onFail ?? []).every(o => o.kind !== "damage"));

  // And then the cloak takes the restrained off the list, with a reason for the card.
  const worn = jeth([gear("Cloak of Arachnida", CLOAK_WORDS)]);
  const ward = wardAgainst(worn, "restrained", { item: web });
  check("3. the card names the cloak instead of skipping in silence",
    ward.warded === true && /cloak of arachnida/i.test(ward.why) && ward.sentence.length > 0,
    ward.why);
  check("   and what is left on him is nothing at all",
    v.conditions.filter(c => !ward.warded || c.key !== "restrained").length === 0
    && v.damage.length === 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.stdout.write("", () => process.exit(fail ? 1 : 0));
