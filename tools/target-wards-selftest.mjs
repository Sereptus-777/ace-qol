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
/** dnd5e keeps a live save ability as a Set and a live damage type as a Set. */
const liveActivities = (stored) => {
  const out = new Map();
  for (const [id, a] of Object.entries(stored ?? {})) {
    const copy = structuredClone(a);
    copy.id = copy._id ?? id;
    if (copy.save?.ability) copy.save.ability = new Set([].concat(copy.save.ability));
    for (const p of (copy.damage?.parts ?? [])) p.types = new Set([].concat(p.types ?? []));
    out.set(copy.id, copy);
  }
  return out;
};
const web = WEB
  ? { id: WEB._id ?? "web", name: "Web", type: "spell", uuid: "Item.web",
      system: { ...WEB.system, description: { value: WEB_WORDS },
        activities: liveActivities(WEB.system?.activities),
        properties: new Set(WEB.system?.properties ?? []) },
      getFlag: () => undefined, effects: [] }
  : { id: "web", name: "Web", type: "spell", uuid: "Item.web",
      system: { description: { value: WEB_WORDS }, activities: new Map(),
        properties: new Set() }, getFlag: () => undefined, effects: [] };

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

/* == 6. THE FAIL PATH ITSELF: the widget that applies it ================= */
// His live fail came through here, not through the save engine: the log said
// "concentration-widget.mjs:1947 applied Restrained to Jeth from Web" and
// "save-engine skipped because Web is area-denial / widget-owned". This file
// wrote the effect with createEmbeddedDocuments, so the ward never ran.
console.log("\nTHE WIDGET'S OWN FAIL PATH ASKS THE WARD FIRST");
{
  const { ConcentrationWidget } = await import(`${MODULE}/scripts/concentration-widget.mjs`);
  const { CardDoor } = await import(`${MODULE}/scripts/road/doors.mjs`);

  const posted = [];
  const keepPost = CardDoor.post;
  CardDoor.post = async (data) => { posted.push(data); return data; };

  const madeEffects = [];
  const actorWith = (items) => {
    const a = {
      id: "jeth", name: "Jeth", type: "character", items,
      effects: { contents: [] },
      statuses: new Set(),
      system: { attributes: { hp: { value: 50, max: 50 } } },
      getFlag: () => undefined, setFlag: async () => {}, unsetFlag: async () => {},
      createEmbeddedDocuments: async (type, data) => { madeEffects.push(...data); return data; },
      deleteEmbeddedDocuments: async () => [],
      getActiveTokens: () => [],
    };
    return a;
  };
  const tracker = { item: web, actor: { id: "kas", name: "Kasimir Velikov" },
    timing: {}, saveDC: 13, templateId: "t1" };

  try {
    // Jeth, wearing the cloak: the webs get nothing.
    const jethWorn = actorWith([gear("Cloak of Arachnida", CLOAK_WORDS)]);
    const widget = new ConcentrationWidget(null);
    const out = await widget._applyAreaDenialEffect(jethWorn, tracker, "restrained", "entry");
    check("the widget refuses it, and says the cloak did it", out?.warded === true
      && /cloak of arachnida/i.test(out?.why ?? ""), out?.why ?? JSON.stringify(out));
    check("no effect is written to him at all", madeEffects.length === 0,
      `${madeEffects.length} effect(s) created`);
    check("and a card goes out naming the cloak, not a silent skip",
      posted.length === 1 && /Cloak of Arachnida/.test(posted[0]?.content ?? ""),
      posted.length ? "card posted" : "nothing posted");
    check("the card says which condition he escaped",
      /not restrained/i.test(posted[0]?.content ?? ""), "");

    // Somebody with no cloak: it lands, ONCE, through the condition door.
    const { ConditionLibrary } = await import(`${MODULE}/scripts/condition-library.mjs`);
    const keepApply = ConditionLibrary.applyByName;
    let applies = 0;
    ConditionLibrary.applyByName = async (actor, key) => {
      applies++;
      actor.effects.contents.push({ id: "e1", name: "Restrained", disabled: false,
        statuses: new Set([key]), flags: {}, update: async () => {} });
      return { ok: true, applied: key };
    };
    try {
      madeEffects.length = 0;
      const plain = actorWith([]);
      await widget._applyAreaDenialEffect(plain, tracker, "restrained", "entry");
      check("without a ward it still lands, through the condition door",
        applies === 1, `${applies} call(s) to the library`);
      check("ONE restrained, not a second effect beside the condition",
        madeEffects.length === 0 && plain.effects.contents.length === 1,
        `${madeEffects.length} raw effect(s), ${plain.effects.contents.length} condition(s)`);
      check("and it is the condition's own name, so the token wears the overlay",
        plain.effects.contents[0]?.name === "Restrained", plain.effects.contents[0]?.name ?? "?");
    } finally { ConditionLibrary.applyByName = keepApply; }
  } finally { CardDoor.post = keepPost; }
}

/* == 7. THE OPPORTUNITY-ATTACK LOG ====================================== */
// His log: oa-prompt spam for Ghast, Shield Guardian, Specter, Flameskull and
// Poltergeist, all corpses or hundreds of feet away behind walls, because every
// refusal was reached BEFORE the distance was measured.
console.log("\nTHE OPPORTUNITY-ATTACK SCAN ONLY TALKS ABOUT CREATURES IT REACHED");
{
  const { OAPrompt } = await import(`${MODULE}/scripts/oa-prompt.mjs`);
  const { QolSettings } = await import(`${MODULE}/scripts/settings.mjs`);
  const keepGet = QolSettings.get;
  QolSettings.get = (k) => (k === "opportunityAttackReach" ? 5 : true);

  const GRID = 100;   // 100 px to 5 feet
  globalThis.canvas = { ...globalThis.canvas, ready: true,
    grid: { size: GRID, distance: 5, type: 1 },
    dimensions: { size: GRID, distance: 5 },
    scene: { grid: { size: GRID, distance: 5, type: 1 } },
    tokens: { placeables: [] } };

  const tok = (name, gx, gy, { down = false, disposition = -1, weapons = true } = {}) => {
    const actor = { id: `a-${name}`, name, type: "npc",
      statuses: new Set(down ? ["dead"] : []),
      system: { attributes: { hp: { value: down ? 0 : 20, max: 20 } } },
      items: weapons ? [{ id: "w", name: "Claw", type: "weapon", img: "",
        system: { equipped: true, properties: new Set(),
          activities: { a1: { _id: "a1", id: "a1", type: "attack",
            damage: { includeBase: true, parts: [] } } } } }] : [],
      effects: { contents: [] }, getFlag: () => undefined,
      getActiveTokens: () => [] };
    const document = { id: `t-${name}`, name, x: gx * GRID, y: gy * GRID, elevation: 0,
      width: 1, height: 1, disposition, actor, object: null };
    const t = { id: document.id, actor, document, x: document.x, y: document.y, w: GRID, h: GRID };
    document.object = t;
    actor.getActiveTokens = () => [t];
    return t;
  };

  const mover = tok("Jeth", 10, 10, { disposition: 1 });
  // Beside him, and he walks four squares away, so their reach really is left.
  const adjacentDown = tok("Specter", 11, 10, { down: true });
  const farCorpse = tok("Flameskull", 70, 70, { down: true });
  const farAlive = tok("Shield Guardian", 68, 70);
  const adjacentLive = tok("Ghast", 10, 11);
  canvas.tokens.placeables = [mover, adjacentDown, farCorpse, farAlive, adjacentLive];

  const lines = [];
  const keepLog = console.log;
  console.log = (...a) => { const t = a.join(" "); if (/opportunity attack/.test(t)) lines.push(t); };
  let cards = 0;
  const keepCard = OAPrompt._postPromptCard;
  OAPrompt._postPromptCard = async () => { cards++; };
  try {
    // Jeth steps two squares away: out of everybody's reach.
    await OAPrompt._checkProvocations(mover.document, { x: 14 * GRID, y: 10 * GRID });
  } finally {
    console.log = keepLog;
    OAPrompt._postPromptCard = keepCard;
    QolSettings.get = keepGet;
  }

  const named = (n) => lines.filter(l => l.includes(n));
  check("nothing is said about a corpse across the map", named("Flameskull").length === 0,
    named("Flameskull")[0] ?? "silent");
  check("nothing is said about a live creature across the map", named("Shield Guardian").length === 0,
    named("Shield Guardian")[0] ?? "silent");
  check("the dead thing he walked away from gets ONE line, with the distances",
    named("Specter").length === 1 && /ft before/.test(named("Specter")[0] ?? ""),
    named("Specter")[0]?.replace(/^.*opportunity attack: /, "") ?? "nothing");
  check("the one that could swing was offered it", cards === 1, `${cards} card(s)`);
  check("and one closing line names who was offered the swing",
    lines.some(l => /was offered the swing/.test(l) && l.includes("Ghast")),
    lines.find(l => /offered the swing/.test(l))?.replace(/^.*opportunity attack: /, "") ?? "none");
  check("the whole move is three lines or fewer, not one per token on the map",
    lines.length <= 3, `${lines.length} line(s) for five tokens`);
}

/* == 8. NO WASTED SAVE ================================================== */
// ⚠️ HIS RULE (2026-09-27): "If the target profile already refuses the only
// on-fail effect, do not roll. One card: he is not restrained, name the cloak.
// No second FAIL card." He was rolling a Dexterity save whose only outcome the
// cloak had already refused, then getting a FAIL card AND a ward card for it.
console.log("\nA SAVE THAT COULD DECIDE NOTHING IS NOT ROLLED");
{
  const { ConcentrationWidget } = await import(`${MODULE}/scripts/concentration-widget.mjs`);
  const widget = new ConcentrationWidget(null);
  const cloaked = { id: "jeth", name: "Jeth", type: "character",
    items: [gear("Cloak of Arachnida", CLOAK_WORDS)], effects: { contents: [] },
    statuses: new Set(), getFlag: () => undefined };
  const bare = { id: "kro", name: "Krusk", type: "character", items: [],
    effects: { contents: [] }, statuses: new Set(), getFlag: () => undefined };

  // Web as it now reads: a failure restrains, and nothing else.
  const webTracker = { item: web, timing: { family: "areaDenial", failEffect: "restrained" },
    recipe: { decidedBy: { kind: "save" },
      onFail: [{ kind: "condition", condition: { key: "restrained" } }], onSuccess: [] } };

  const skipped = widget._saveWouldDecideNothing(cloaked, webTracker);
  check("his save is skipped, because its only outcome is already refused",
    skipped.skip === true && skipped.key === "restrained", skipped.why);
  check("and the reason names the cloak, for the one card that goes out",
    /cloak of arachnida/i.test(skipped.ward?.why ?? ""), skipped.ward?.why ?? "");

  const rolls = widget._saveWouldDecideNothing(bare, webTracker);
  check("somebody with no cloak still rolls it", rolls.skip === false, rolls.why);

  // ⚠️ NARROW ON PURPOSE. Damage on the failure, and the save decides how much.
  const withDamage = { ...webTracker, recipe: { decidedBy: { kind: "save" },
    onFail: [{ kind: "damage", formula: "2d4", types: ["fire"] },
             { kind: "condition", condition: { key: "restrained" } }], onSuccess: [] } };
  const stillRolls = widget._saveWouldDecideNothing(cloaked, withDamage);
  check("an area whose failure also deals damage is still rolled",
    stillRolls.skip === false, stillRolls.why);

  // Two conditions on the failure: the save still decides the one he is open to.
  const twoThings = { ...webTracker, recipe: { decidedBy: { kind: "save" },
    onFail: [{ kind: "condition", condition: { key: "restrained" } },
             { kind: "condition", condition: { key: "blinded" } }], onSuccess: [] } };
  check("an area that puts on more than one thing is still rolled",
    widget._saveWouldDecideNothing(cloaked, twoThings).skip === false,
    widget._saveWouldDecideNothing(cloaked, twoThings).why);

  // And an area whose failure is not a single condition at all.
  check("an area with no single-condition failure is still rolled",
    widget._saveWouldDecideNothing(cloaked, { item: web, timing: { family: "areaDenial" },
      recipe: webTracker.recipe }).skip === false, "no failEffect on its timing");
}

/* == 9. THE GATE, WHERE THE SAVE ENGINE ASKS ============================= */
// ⚠️ THE PATH HIS TABLE ACTUALLY TOOK. _getTokensInTemplate found him, and then
// save-engine.mjs:3867 GM-rolled the PC save before the card was even built: a
// FAIL (9) row and a second cloak card for the same entry. The widget gate added
// in 0.41.0 is on a different road. The one gate is where every pipeline reads
// its verdict, so the ward belongs there, beside the immunity rule it matches.
console.log("\nTHE ONE GATE REFUSES THE DIE, NOT JUST THE EFFECT");
{
  const { ActionGate } = await import(`${MODULE}/scripts/gate/action-gate.mjs`);
  const { buildTargetProfile } = await import(`${MODULE}/scripts/profiles/target-profile.mjs`);

  const actorLike = (items) => ({
    id: "jeth", name: "Jeth", type: "character", items,
    effects: { contents: [] }, statuses: new Set(),
    system: { attributes: { hp: { value: 50, max: 50 }, ac: { value: 17 } }, abilities: {},
      traits: { ci: { value: new Set() }, di: { value: new Set() } } },
    getFlag: () => undefined, getActiveTokens: () => [],
  });
  const cloaked = actorLike([gear("Cloak of Arachnida", CLOAK_WORDS)]);
  const bare = actorLike([]);

  const verdict = (actor, { outcomes, dealsDamage = false, item = web }) =>
    ActionGate.verdictFor({ targetProfile: buildTargetProfile(actor), targetActor: actor,
      outcomes, dealsDamage, item });

  // Web as it now reads: restrained on a failure, no damage.
  const v = verdict(cloaked, { outcomes: ["restrained"] });
  check("the gate refuses the die outright", v?.reason === "warded", v?.reason ?? "rolled");
  check("and its label names the cloak, for the one card",
    /cloak of arachnida/i.test(v?.label ?? "") || /cloak of arachnida/i.test(v?.why ?? ""),
    v?.label ?? "");
  check("it reads as a no-roll, the same shape immunity has",
    v?.tone === "immune", v?.tone ?? "?");

  // Somebody with no cloak still rolls.
  check("a creature with no ward still rolls it",
    verdict(bare, { outcomes: ["restrained"] }) === null
    || verdict(bare, { outcomes: ["restrained"] })?.reason !== "warded",
    JSON.stringify(verdict(bare, { outcomes: ["restrained"] })?.reason ?? null));

  // ⚠️ THE SAME LIMIT THE IMMUNITY RULE HAS. Damage on the failure and the save
  // still earns half on a success, so the die is still thrown.
  check("an area that also deals damage is still rolled",
    verdict(cloaked, { outcomes: ["restrained"], dealsDamage: true })?.reason !== "warded",
    "damage still has to be decided");

  // A second condition the ward does not cover: still rolled.
  check("an area putting on something the ward does not cover is still rolled",
    verdict(cloaked, { outcomes: ["restrained", "blinded"] })?.reason !== "warded");

  // ⚠️ AND WITHOUT THE ITEM THE RULE IS INERT, NOT WRONG. A material ward has
  // nothing to answer, so it does not fire, and the gate says so in the log.
  check("handed no item, a material ward does not fire",
    verdict(cloaked, { outcomes: ["restrained"], item: null })?.reason !== "warded",
    "nothing to compare the webs against");
}

/* == 10. AND THE SAVE ENGINE HANDS THE GATE WHAT IT NEEDS =============== */
console.log("\nTHE SAVE ENGINE'S OWN CONTEXT CARRIES THE SOURCE");
{
  const { SaveEngine } = await import(`${MODULE}/scripts/save-engine.mjs`);
  const ctx = SaveEngine._gateContextFor(web, [], null);
  check("the gate context carries the item, or a material ward is deaf",
    ctx?.item === web, ctx?.item ? "the item is there" : "MISSING");
  check("and it says the save deals no damage when it deals none",
    ctx?.dealsDamage === false, `dealsDamage=${ctx?.dealsDamage}`);
  // ⚠️ WHAT THE GATE WILL BE TOLD THIS SAVE CAN DO. It reads the recipe through
  // whatLands, the same answer the applier gives, so "restrained" here is the
  // real list and not a guess.
  // ⚠️🔴 AN EMPTY OUTCOME LIST MAKES THE WHOLE GATE INERT, for the ward exactly as
  // for the immunity rule beside it: `if (!dealsDamage && outcomes.length)`. So
  // what fills that list is pinned here, because if it ever comes back empty the
  // die is thrown again and the cloak is decoration.
  //
  // Web is in the spell registry but its entry carries no effect key, so the
  // registry branch answers null and the RECIPE decides. This harness has no book
  // index, so the recipe is handed over directly and what is pinned is the wiring.
  const keepRecipe = SaveEngine.saveRecipe;
  const asked = [];
  SaveEngine.saveRecipe = (item, activity) => {
    asked.push(activity?.id ?? activity?._id ?? "(nothing)");
    return { recipe: { decidedBy: { kind: "save", ability: "dex" },
      onFail: [{ kind: "condition", condition: { key: "restrained" } }], onSuccess: [] } };
  };
  let outcomes, noneNamed;
  try {
    outcomes = SaveEngine._outcomeConditionsFor(web, null);
    noneNamed = [...asked];
    asked.length = 0;
  } finally { SaveEngine.saveRecipe = keepRecipe; }
  check("a recipe that restrains gives the gate the restrain to act on",
    Array.isArray(outcomes) && outcomes.includes("restrained"), JSON.stringify(outcomes));

  // ⚠️🔴 THE PIN THAT WOULD HAVE CAUGHT THREE NIGHTS OF THIS. With no activity id,
  // _activityOf answers null, saveRecipe says "no activity was named", whatLands
  // gets nothing and the list came back EMPTY — which makes the gate inert for the
  // ward AND for plain condition immunity. Every save activity is asked now.
  check("with no activity named, every save activity is still asked",
    noneNamed.length >= 1 && !noneNamed.includes("(nothing)"),
    `asked: ${noneNamed.join(", ") || "none at all"}`);
  check("and Web has more than one save activity, so one of them is not enough",
    SaveEngine._saveActivitiesOf(web).length >= (fromWorld ? 2 : 0),
    `${SaveEngine._saveActivitiesOf(web).length} save activit(ies) on it`);

  // ⚠️ AND AN EMPTY LIST IS NEVER SILENT AGAIN (his words: "If outcomes is empty,
  // log that and stop guessing").
  {
    const keep2 = SaveEngine.saveRecipe;
    SaveEngine.saveRecipe = () => ({ recipe: null, why: "nothing to read" });
    const said = [];
    const keepLog = console.log;
    console.log = (...a) => { said.push(a.join(" ")); };
    let empty;
    try { empty = SaveEngine._outcomeConditionsFor(web, null); }
    finally { console.log = keepLog; SaveEngine.saveRecipe = keep2; }
    check("an empty outcome list says so, instead of standing down in silence",
      empty.length === 0 && said.some(l => /the gate cannot spare anybody the die/i.test(l)),
      said.find(l => /GATE/.test(l))?.slice(0, 96) ?? "nothing was said");
  }

  // And the whole chain, from that list to the die: the gate refuses it.
  const { ActionGate: Gate2 } = await import(`${MODULE}/scripts/gate/action-gate.mjs`);
  const { buildTargetProfile: prof2 } = await import(`${MODULE}/scripts/profiles/target-profile.mjs`);
  const jeth2 = { id: "jeth", name: "Jeth", type: "character",
    items: [gear("Cloak of Arachnida", CLOAK_WORDS)], effects: { contents: [] },
    statuses: new Set(), getFlag: () => undefined, getActiveTokens: () => [],
    system: { attributes: { hp: { value: 50, max: 50 } }, abilities: {},
      traits: { ci: { value: new Set() }, di: { value: new Set() } } } };
  const endToEnd = Gate2.verdictFor({ targetProfile: prof2(jeth2), targetActor: jeth2,
    outcomes, dealsDamage: ctx.dealsDamage, item: ctx.item });
  check("so the engine's own context, start to finish, throws no die",
    endToEnd?.reason === "warded", endToEnd?.label ?? "it would have rolled");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.stdout.write("", () => process.exit(fail ? 1 : 0));
