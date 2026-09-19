// ─── Lucky (2014 and 2024) and the halfling's Lucky ─────────────────────────
//
// Johnny, 2026-09-18: "Stop when a Halfling 1 rerolls with no box, a 2014
// Lucky holder is asked only on a fail or an incoming hit, and a 2024 holder
// has a button on their own roll card."
//
// The items are shaped as they sit in his world (read 2026-09-18):
//   Firaxis  "Lucky" feat, feat/general, 2014, uses 3 (1 spent)
//   Chudd    "Lucky" feat, feat/origin, 2024, uses @prof  AND  "Lucky", race, 2014 (the halfling trait)
//   Perrin   "Luck", race, 2024, with the effect that sets dnd5e's halfling flag
//
// The reaction door is a stand-in that records every box and answers from a
// script, so this proves who is asked, when, and what each answer does.
//
// Run:  node tools/luck-selftest.mjs

let pass = 0, fail = 0;
const check = (label, ok, detail = "") => {
  ok ? pass++ : fail++;
  console.log((ok ? "  ok   " : "  FAIL ") + label + (detail ? `   (${detail})` : ""));
};

// ── Foundry stand-ins ──
const hooks = [];
globalThis.Hooks = { on: (name, fn) => { hooks.push([name, fn]); return hooks.length; }, once: () => {}, off: () => {},
  callAll: () => {}, call: () => true };
globalThis.CONFIG = { DND5E: {} };
globalThis.foundry = { utils: { escapeHTML: (s) => String(s) } };
globalThis.ui = { notifications: { info: () => {}, warn: () => {}, error: () => {} } };
const rollQueue = [];
let rollsMade = 0;
globalThis.Roll = class {
  constructor(formula) { this.formula = String(formula); }
  async evaluate() {
    rollsMade++;
    const face = rollQueue.shift() ?? 10;
    this.total = face;
    this.dice = [{ faces: 20, total: face, results: [{ result: face, active: true }] }];
    return this;
  }
};
const GM = { id: "gm", name: "Johnny", isGM: true, active: true };
const TOMMY = { id: "tommy", name: "Tommy", isGM: false, active: true };
const JEX = { id: "jex", name: "Jexxi", isGM: false, active: false };
const users = Object.assign([GM, TOMMY, JEX], { activeGM: GM });
users.get = (id) => users.find(u => u.id === id);
globalThis.game = {
  user: GM,
  users,
  settings: { get: () => "modern" },
  aceQol: {},
};
globalThis.fromUuid = async (uuid) => allItems.find(i => i.uuid === uuid) ?? null;

// The door: records each box and answers from `answers` (default: yes / first choice).
const boxes = [];
let answers = [];
game.aceQol.reactionEngine = {
  async _promptReaction(opts) {
    boxes.push(opts);
    const a = answers.shift();
    if (opts.choices?.length) {
      const pick = a ?? opts.choices[0].id;
      return pick === null ? { accepted: false, choiceData: {} } : { accepted: true, choiceData: { choice: pick } };
    }
    return { accepted: a ?? true, choiceData: {} };
  },
};

// ── his items ──
const allItems = [];
const feat = (name, value, subtype, rules, uses, extra = {}) => {
  const it = {
    type: "feat", name, uuid: `Item.${name}.${allItems.length}`,
    system: { type: { value, subtype }, source: { rules }, uses: uses ? { ...uses } : { max: null, spent: 0 } },
    flags: {},
    async update(data) {
      if ("system.uses.spent" in data) {
        this.system.uses.spent = data["system.uses.spent"];
        this.system.uses.value = Math.max(0, this.system.uses.max - this.system.uses.spent);
      }
      return this;
    },
    getFlag(s, k) { return this.flags?.[s]?.[k]; },
    async setFlag(s, k, v) { (this.flags[s] ??= {})[k] = v; },
    async unsetFlag(s, k) { delete this.flags?.[s]?.[k]; },
    ...extra,
  };
  if (it.system.uses.max) it.system.uses.value = it.system.uses.max - (it.system.uses.spent ?? 0);
  allItems.push(it);
  return it;
};
const actor = (name, items, { owner = null, halflingFlag = false } = {}) => {
  const a = { name, id: name.toLowerCase(), uuid: `Actor.${name}`, img: `${name}.png`, items,
    ownership: owner ? { [owner]: 3 } : {},
    flags: halflingFlag ? { dnd5e: { halflingLucky: true } } : {},
    getFlag(s, k) { return this.flags?.[s]?.[k]; },
    getActiveTokens: () => [] };
  for (const i of items) i.actor = a;
  return a;
};
const firaxis = actor("Firaxis", [feat("Lucky", "feat", "general", "2014", { max: 3, spent: 1 })], { owner: "tommy" });
const chudd = actor("Chudd", [feat("Lucky", "feat", "origin", "2024", { max: 3, spent: 0 }),
                              feat("Lucky", "race", "", "2014", null)], { owner: "tommy" });
const perrin = actor("Perrin", [feat("Luck", "race", "", "2024", null)], { owner: "jex", halflingFlag: true });
const goblin = actor("Goblin", []);
const pretender = actor("Pretender", [feat("Lucky Footwork", "feat", "general", "2014", { max: 3, spent: 0 }),
                                      feat("Halfling Lucky", "feat", "general", "2014", { max: 3, spent: 0 })]);
const legacy = actor("Oldtimer", [feat("Lucky (Legacy)", "feat", "general", "2014", { max: 3, spent: 0 })]);

const L = await import("file:///D:/FoundryVTT/Data/modules/ace-qol/scripts/luck.mjs");
const logs = [];
const origLog = console.log;
const quietly = async (fn) => { logs.length = 0; console.log = (...a) => logs.push(a.join(" ")); try { return await fn(); } finally { console.log = origLog; } };

console.log("\nWHO HAS IT: the suite feat key, and a feat, never a species trait");
{
  const f = L.luckyFeat(firaxis);
  check("Firaxis's 2014 Lucky feat: 2 of 3 points left", f?.edition === "2014" && f.left === 2 && f.max === 3, JSON.stringify({ e: f?.edition, l: f?.left }));
  const c = L.luckyFeat(chudd);
  check("Chudd's Lucky is the 2024 FEAT, not his 2014 halfling trait of the same name",
    c?.edition === "2024" && c.item.system.type.value === "feat");
  check("and his halfling trait is found as the trait", L.halflingTraitItem(chudd)?.system.type.value === "race");
  check("Perrin's 2024 \"Luck\" is not the feat", L.luckyFeat(perrin) === null);
  check("\"Lucky Footwork\" and \"Halfling Lucky\" are not the feat (a name that contains lucky)", L.luckyFeat(pretender) === null);
  check("\"Lucky (Legacy)\" is the feat (the key drops the importer's suffix)", L.luckyFeat(legacy)?.edition === "2014");
}

console.log("\nHALFLING LUCKY: a 1 rerolls, no box, no point");
{
  check("Chudd (the 2014 trait, no flag on the sheet) rerolls a 1", L.hasHalflingLuck(chudd));
  check("Perrin (the flag his 2024 trait sets) rerolls a 1", L.hasHalflingLuck(perrin));
  check("Firaxis (the feat, no trait) does not", !L.hasHalflingLuck(firaxis));
  check("ACE's own d20: 1d20 + 5 becomes 1d20r1=1 + 5", L.withHalflingLuck("1d20 + 5", chudd) === "1d20r1=1 + 5");
  check("advantage: 2d20kh + 3 becomes 2d20r1=1kh + 3, as dnd5e builds it", L.withHalflingLuck("2d20kh + 3", chudd) === "2d20r1=1kh + 3");
  check("anybody else's d20 is left alone", L.withHalflingLuck("1d20 + 5", firaxis) === "1d20 + 5");
  // dnd5e's own rolls, through the hooks luck.mjs registers.
  await quietly(() => L.registerLuck());
  const onD20 = hooks.find(([n]) => n === "dnd5e.preRollD20TestV2")?.[1];
  const onInit = hooks.find(([n]) => n === "dnd5e.preConfigureInitiative")?.[1];
  const cfg = { subject: chudd };
  await quietly(() => onD20?.(cfg));
  check("dnd5e's own attack, check or save for Chudd is told to reroll a 1", cfg.halflingLucky === true);
  const cfgAtk = { subject: { actor: chudd } };
  await quietly(() => onD20?.(cfgAtk));
  check("including an attack, whose subject is the activity", cfgAtk.halflingLucky === true);
  const cfgF = { subject: firaxis };
  await quietly(() => onD20?.(cfgF));
  check("and nobody without the trait", !cfgF.halflingLucky);
  // A death save is a saving throw underneath: dnd5e fires d20Test for it too.
  const death = { subject: chudd, hookNames: ["deathSave", "SavingThrow", "d20Test", ""] };
  await quietly(() => onD20?.(death));
  check("Chudd's death save rerolls a 1 too, and the console names it a death save",
    death.halflingLucky === true && logs.some(l => /Chudd's death save rerolls a 1/.test(l)), logs.join(" | "));
  const perrinSave = { subject: perrin, halflingLucky: true, hookNames: ["SavingThrow", "d20Test", ""] };
  await quietly(() => onD20?.(perrinSave));
  check("Perrin's flag is dnd5e's own business: left alone, nothing logged", perrinSave.halflingLucky === true && logs.length === 0);
  const init = { options: {} };
  await quietly(() => onInit?.(chudd, init));
  check("and initiative", init.options.halflingLucky === true);
  check("no box was opened for any of it", boxes.length === 0);
}

const judgeDC = (dc) => (t) => ({ fails: t < dc, words: `${t} against DC ${dc}` });

console.log("\n2014 LUCKY ON THEIR OWN ROLL: only when it is about to fail");
{
  boxes.length = 0; rollsMade = 0;
  rollQueue.push(15); answers = [true, "15"];
  const r = await quietly(() => L.ownRoll({ actor: firaxis, kind: "save", what: "Dexterity save (DC 15)",
    d20s: [7], kept: 7, total: 12, judge: judgeDC(15) }));
  check("a failing save (12 against DC 15): asked, spent, rolled, chose, 20 now",
    boxes.length === 2 && r.spent && r.total === 20 && r.d20 === 15, JSON.stringify({ boxes: boxes.length, total: r.total }));
  check("the box went to Firaxis (the door routes it to his owner) and carries the item, so the screen that says yes spends it",
    boxes[0].reactorActor === firaxis && boxes[0].luckItemUuid === firaxis.items[0].uuid);
  check("the second box asks which d20, with each face and what it makes",
    boxes[1].choices?.map(c => c.label).join(" / ") === "Keep 7 / Keep 15", boxes[1].choices?.map(c => c.label).join(" / "));
  check("one luck die rolled, one point spent (1 of 3 left)", rollsMade === 1 && L.luckyFeat(firaxis).left === 1);

  boxes.length = 0;
  await quietly(() => L.ownRoll({ actor: firaxis, kind: "save", what: "Dexterity save (DC 15)",
    d20s: [18], kept: 18, total: 23, judge: judgeDC(15) }));
  check("a save already passed: no box, and the console says why",
    boxes.length === 0 && logs.some(l => /already a success/.test(l)), logs.find(l => /Firaxis/.test(l)));

  boxes.length = 0; answers = [false];
  const kept = await quietly(() => L.ownRoll({ actor: firaxis, kind: "check", what: "Athletics (DC 15)",
    d20s: [3], kept: 3, total: 8, judge: judgeDC(15) }));
  check("a no keeps the roll and spends nothing", boxes.length === 1 && !kept.spent && L.luckyFeat(firaxis).left === 1);

  const spentOut = actor("Spent", [feat("Lucky", "feat", "general", "2014", { max: 3, spent: 3 })]);
  boxes.length = 0;
  await quietly(() => L.ownRoll({ actor: spentOut, kind: "save", what: "a save", d20s: [2], kept: 2, total: 5, judge: judgeDC(15) }));
  check("no points left: no box, and it says so", boxes.length === 0 && logs.some(l => /no luck points left/.test(l)));

  boxes.length = 0;
  await quietly(() => L.ownRoll({ actor: chudd, kind: "save", what: "a save", d20s: [2], kept: 2, total: 5, judge: judgeDC(15) }));
  check("a 2024 holder gets no box after the roll (the button is before it)",
    boxes.length === 0 && logs.some(l => /2024 Lucky is the button/.test(l)));

  boxes.length = 0;
  await quietly(() => L.ownRoll({ actor: perrin, kind: "save", what: "a save", d20s: [2], kept: 2, total: 5, judge: judgeDC(15) }));
  check("the halfling trait is not the feat: no box, and it says so",
    boxes.length === 0 && logs.some(l => /halfling trait, not the Lucky feat/.test(l)));

  const noUses = actor("Unset", [feat("Lucky", "feat", "general", "2014", null)]);
  boxes.length = 0;
  await quietly(() => L.ownRoll({ actor: noUses, kind: "save", what: "a save", d20s: [2], kept: 2, total: 5, judge: judgeDC(15) }));
  check("a feat with no uses on the item: no box, and it says what to set",
    boxes.length === 0 && logs.some(l => /no uses set on the item/.test(l)));
}

// An attack result as the pipeline builds it.
const attackResult = (target, d20, total, ac) => ({ name: target.name, targetActor: target, targetToken: null,
  d20Result: d20, attackTotal: total, effectiveAC: ac, ac, coverResult: null, mirrorImageRedirect: null, autoCrit: false,
  hitResult: d20 === 1 ? "fumble" : d20 === 20 ? "critical" : total >= ac ? "hit" : "miss" });
const item = { name: "Rapier" };

console.log("\n2014 LUCKY ON ATTACKS: the attacker on a miss, the target on a hit");
{
  const fresh = () => actor("Firaxis", [feat("Lucky", "feat", "general", "2014", { max: 3, spent: 0 })], { owner: "tommy" });
  let atk = fresh();
  boxes.length = 0; rollQueue.push(18); answers = [true, "18"];
  let res = [attackResult(goblin, 5, 10, 15)];
  await quietly(() => L.afterAttackRoll({ actor: atk, item, results: res }));
  check("Firaxis misses (10 against AC 15): asked, keeps his 18, now 23 and a hit",
    res[0].hitResult === "hit" && res[0].attackTotal === 23 && /kept 18/.test(res[0].luck ?? ""), `${res[0].hitResult} ${res[0].attackTotal}`);

  atk = fresh(); boxes.length = 0;
  res = [attackResult(goblin, 14, 19, 15)];
  await quietly(() => L.afterAttackRoll({ actor: atk, item, results: res }));
  check("a hit he already made: no box", boxes.length === 0 && res[0].hitResult === "hit");

  // An NPC attacks Firaxis.
  const firax = fresh(); boxes.length = 0; rollQueue.push(3); answers = [true, "mine"];
  res = [attackResult(firax, 16, 21, 15)];
  await quietly(() => L.afterAttackRoll({ actor: goblin, item, results: res }));
  check("a goblin's attack about to hit Firaxis: he is asked, rolls a 3, makes it use his die: a miss",
    boxes[0]?.reactorActor === firax && boxes[1]?.choices?.length === 2 && res[0].hitResult === "miss" && res[0].attackTotal === 8,
    `${res[0].hitResult} ${res[0].attackTotal}`);
  check("that box shows the attacker on the other side", boxes[0]?.attackerName === "Goblin");

  const firax2 = fresh(); boxes.length = 0;
  res = [attackResult(firax2, 4, 9, 15)];
  await quietly(() => L.afterAttackRoll({ actor: goblin, item, results: res }));
  check("an attack that already misses him: no box", boxes.length === 0);

  // Both have 2014 Lucky: the two points cancel, no extra dice.
  const a = fresh(); const t = actor("Rival", [feat("Lucky", "feat", "general", "2014", { max: 3, spent: 0 })]);
  boxes.length = 0; rollsMade = 0; rollQueue.push(19); answers = [true, "19", true];
  res = [attackResult(t, 6, 11, 15)];
  await quietly(() => L.afterAttackRoll({ actor: a, item, results: res }));
  check("attacker spends (a miss becomes a hit), the target spends too: they cancel, the roll stands as first rolled (a miss)",
    res[0].hitResult === "miss" && res[0].attackTotal === 11 && /cancel/.test(res[0].luck ?? ""), `${res[0].hitResult} ${res[0].attackTotal}`);
  check("and no extra die for the second spend: one luck die in all, both points spent",
    rollsMade === 1 && L.luckyFeat(a).left === 2 && L.luckyFeat(t).left === 2, `${rollsMade} dice`);
}

console.log("\n2024 LUCKY: the button on their own roll, one box before an attack on them");
{
  // A goblin attacks Chudd: one box, before the roll.
  boxes.length = 0; answers = [true];
  const c = actor("Chudd", [feat("Lucky", "feat", "origin", "2024", { max: 3, spent: 0 })], { owner: "tommy" });
  check("a goblin's swing at Chudd needs the question before the roll", L.needsBeforeRoll(goblin, [{ actor: c }]));
  await quietly(() => L.beforeAttackRoll({ attacker: goblin, item, targets: [{ actor: c }] }));
  const took = L.takeBeforeRoll(goblin);
  check("one box, \"give that attack Disadvantage?\"; yes spends a point and the roll takes it",
    boxes.length === 1 && /Disadvantage/.test(boxes[0].acceptLabel) && took?.by?.join() === "Chudd" && L.luckyFeat(c).left === 2);
  check("the answer is taken once", L.takeBeforeRoll(goblin) === null);
  check("Advantage and Lucky's Disadvantage cancel", L.withLuckDisadvantage("advantage", true) === "normal");
  check("a straight roll becomes Disadvantage", L.withLuckDisadvantage("normal", false) === "disadvantage");
  check("a 2014 holder is never asked before the roll", !L.needsBeforeRoll(goblin, [{ actor: firaxis }]));

  const broke = actor("Broke", [feat("Lucky", "feat", "origin", "2024", { max: 3, spent: 3 })]);
  check("no points left: nothing to ask", !L.needsBeforeRoll(goblin, [{ actor: broke }]));

  // The button on his own roll.
  game.user = TOMMY;
  const btn = await quietly(() => L.buttonFor(c));
  check("Chudd's own screen (Tommy owns him and is connected) gets the Lucky button", btn?.left === 2);
  game.user = GM;
  const gmBtn = await quietly(() => L.buttonFor(c));
  check("the GM's screen does not, while Tommy is connected, and the console says whose it is",
    gmBtn === null && logs.some(l => /belongs on Tommy's screen/.test(l)));
  game.user = TOMMY;
  const mode = await quietly(() => L.pressButton(c));
  check("pressing it spends a point and gives Advantage", mode === "advantage" && L.luckyFeat(c).left === 1);
  const mode2 = await quietly(() => L.pressButton(c, { hasDisadvantage: true }));
  check("with Disadvantage on the roll, it cancels to a straight roll (RAW)", mode2 === "normal" && L.luckyFeat(c).left === 0);
  check("a 2014 holder gets no button", (await quietly(() => L.buttonFor(firaxis))) === null);
  game.user = GM;

  // The save card's press is kept on the feat, per cast and token.
  await L.markCardAdvantage(chudd, "cast1:tok1");
  check("the save card's press is remembered for that cast and token", L.cardHasAdvantage(chudd, "cast1:tok1") && !L.cardHasAdvantage(chudd, "cast2:tok1"));
  check("and taken once, when the roll happens", (await L.takeCardAdvantage(chudd, "cast1:tok1")) && !L.cardHasAdvantage(chudd, "cast1:tok1"));
}

console.log("\n2014 LUCKY ON A DEATH SAVE: dnd5e's write waits for the box");
{
  Math.clamp ??= (n, lo, hi) => Math.min(hi, Math.max(lo, n));
  const posted = [];
  globalThis.ChatMessage = { getSpeaker: () => ({}), applyRollMode: () => {}, create: async (d) => { posted.push(d); return d; } };
  game.i18n = { format: (k) => k };
  const onDeathRoll = hooks.find(([n]) => n === "dnd5e.rollDeathSaveV2")?.[1];
  const dying = (name, success, failure, featItem) => {
    const a = actor(name, [featItem], { owner: "tommy" });
    a.system = { attributes: { death: { success, failure }, hp: { value: 0 } } };
    a.updates = [];
    a.update = async (u) => { a.updates.push(u); return a; };
    return a;
  };
  const deathRoll = (face) => ({ total: face, options: { target: 10, criticalSuccess: 20, criticalFailure: 1 },
    dice: [{ faces: 20, total: face, results: [{ result: face, active: true }] }] });

  // Firaxis rolls a 6 on a death save; his luck die shows 20 and he keeps it.
  let a = dying("Firaxis", 1, 1, feat("Lucky", "feat", "general", "2014", { max: 3, spent: 0 }));
  let r = deathRoll(6);
  boxes.length = 0; posted.length = 0; rollQueue.push(20); answers = [true, "20"];
  const stopped = await quietly(() => onDeathRoll?.([r], { subject: a }));
  await quietly(() => r._aceOutcome);
  check("a failing death save: dnd5e's write is stopped while the box is open", stopped === false);
  check("he keeps the luck die's 20: back up with 1 hit point, the tally cleared, dnd5e's own line",
    JSON.stringify(a.updates[0]) === JSON.stringify({ "system.attributes.death.success": 0, "system.attributes.death.failure": 0, "system.attributes.hp.value": 1 })
    && posted[0]?.content === "DND5E.DeathSaveCriticalSuccess", JSON.stringify(a.updates[0]));
  check("and the card is told what the luck left", r._aceLuck?.total === 20 && r._aceLuck?.d20 === 20);

  // A natural 1 he keeps: two failures on top of one, and he dies.
  a = dying("Firaxis", 0, 1, feat("Lucky", "feat", "general", "2014", { max: 3, spent: 0 }));
  r = deathRoll(1);
  boxes.length = 0; posted.length = 0; answers = [false];
  await quietly(() => onDeathRoll?.([r], { subject: a }));
  await quietly(() => r._aceOutcome);
  check("a natural 1 he keeps counts two failures, as dnd5e counts it, and posts dnd5e's line",
    a.updates[0]?.["system.attributes.death.failure"] === 3 && posted[0]?.content === "DND5E.DeathSaveFailure", JSON.stringify(a.updates[0]));

  // A 12 already succeeds: dnd5e writes it, nobody is asked.
  a = dying("Firaxis", 0, 0, feat("Lucky", "feat", "general", "2014", { max: 3, spent: 0 }));
  r = deathRoll(12);
  boxes.length = 0;
  const left = await quietly(() => onDeathRoll?.([r], { subject: a }));
  check("a death save that already succeeds is dnd5e's to write, no box", left === undefined && boxes.length === 0 && !r._aceOutcome);

  // A 2024 holder: the button was before the roll, so dnd5e writes it.
  a = dying("Chudd", 0, 0, feat("Lucky", "feat", "origin", "2024", { max: 3, spent: 0 }));
  r = deathRoll(4);
  boxes.length = 0;
  const left24 = await quietly(() => onDeathRoll?.([r], { subject: a }));
  check("a 2024 holder's failing death save is dnd5e's to write, no box", left24 === undefined && boxes.length === 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
