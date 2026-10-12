// ─── What the table sees: the one function, pinned ─────────────────────────
//
// His rule, 2026-10-11: "A hidden div is not hidden. A render hook is not
// hidden. If the number is in the flags, it is on the table." And the same
// morning: "A player character's formula and DC are not a secret. The whole
// table sees them. A creature's bonus, DC, AC, and hit points stay on my screen
// only." And after that: "A player character's AC and hit points stay on my
// screen, same as a creature's. The whole table sees a party member's formula
// and DC, the die, the word, and the damage that landed. Nothing else." And from
// the live test: "A party member's save row is the die and PASS or FAIL... That
// is not the spell. Chudd's DC 17 stays." A party member's formula is the
// spell's: its DC and its damage dice; any d20's arithmetic is the GM's. These
// pin the split that runs before a card leaves the client that posts it
// (scripts/road/table-view.mjs): what stays, what is cut, that only the GM gets
// it back, and that putting it back gives exactly what was cut.
//
//   node tools/table-view-selftest.mjs

import {
  splitHtml, fillHtml, splitFlags, mergeOverlay, diceOnlyRoll, forTable, shareFor,
  applyOverlayChange, audienceOf, hasEmptySlots, tableOrGM,
} from "../scripts/road/table-view.mjs";

let pass = 0, fail = 0;
// Order-blind: a restored object is the same object whatever order its keys came back in.
const canon = (v) => Array.isArray(v) ? v.map(canon)
  : (v && typeof v === "object") ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canon(v[k])])) : v;
const check = (label, got, want) => {
  const ok = JSON.stringify(canon(got)) === JSON.stringify(canon(want));
  if (ok) pass++; else fail++;
  console.log(`${ok ? "  ok  " : "  FAIL"} ${label}${ok ? "" : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`);
};
let n = 0;
const ids = () => `s${++n}`;
// The party: Kirsten, Jeth and the pc are player characters. Everyone else is a creature.
const PARTY = new Set(["kirsten", "jeth", "pc"]);
const isTable = (id) => PARTY.has(id);

console.log("\nTHE HTML: A CREATURE'S NUMBER IS NOT SENT");
{
  n = 0;
  const html = `<div class="row"><img src="d20.webp"> 14 <span class="ace-qol-bonus" data-bonus-actor="ogre">+4 STR = 18</span> HIT</div>`;
  const r = splitHtml(html, { makeId: ids, isTable });
  check("the ogre's bonus is gone from what is sent", r.html.includes("+4 STR") || r.html.includes("18"), false);
  check("the die and the word stay", r.html.includes("14") && r.html.includes("HIT"), true);
  check("one slot, and it is the GM's", r.slots.map(s => [s.id, s.aud]), [["s1", "gm"]]);
  check("putting it back gives exactly what was cut", fillHtml(r.html, r.slots), html);
  check("an unfilled card says so", hasEmptySlots(r.html), true);
  check("a filled one does not", hasEmptySlots(fillHtml(r.html, r.slots)), false);
}
{
  n = 0;
  const html = `<p>Saved</p><div class="ace-qol-gm-only">HP 40 → 32 <span class="ace-qol-bonus" data-bonus-actor="pc">+5</span></div><b>after</b>`;
  const r = splitHtml(html, { makeId: ids, isTable });
  check("a GM half is one slot with everything inside it, a player character's number too", r.slots.map(s => s.aud), ["gm"]);
  check("and nothing of it is sent", /HP|40|\+5/.test(r.html), false);
  check("text after it survives", r.html.endsWith("<b>after</b>"), true);
  check("round trip", fillHtml(r.html, r.slots), html);
}
{
  n = 0;
  const html = `<span class="ace-qol-dc" data-dc-roller="pc" data-dc-owner="lamia">DC 13</span>`
    + `<span class="ace-qol-dc" data-dc-owner="firaxis">DC 15</span>`
    + `<span class="ace-qol-dc" data-dc-roller="pc">DC 12</span>`
    + `<span class="ace-qol-save-dc">DC 9</span>`
    + `<span class="ace-qol-ac" data-ac-actor="tarrasque">AC 25</span>`;
  const r = splitHtml(html, { makeId: ids, isTable });
  check("a creature's DC and AC, and a DC that names nobody, are all the GM's",
    r.slots.map(s => s.aud), ["gm", "gm", "gm", "gm", "gm"]);
  check("no number is sent", /\d/.test(r.html.replace(/data-ace-slot="s\d+"/g, "")), false);
  check("whose each one is, before the rule: a DC its caster's, an AC always the GM's", [
    audienceOf({ class: "ace-qol-dc", "data-dc-owner": "lamia" }),
    audienceOf({ class: "ace-qol-ac", "data-ac-actor": "jeth" }),
    audienceOf({ class: "ace-qol-dc", "data-dc-roller": "pc" }),
  ], ["lamia", "gm", "gm"]);
}

console.log("\nA PARTY MEMBER'S SPELL IS THE TABLE'S; ANYBODY'S D20 MATH IS THE GM'S");
{
  n = 0;
  // Kirsten casts: her DC stays on the card; her save pill is a d20's, the GM's.
  const html = `<span class="ace-qol-dc" data-dc-owner="kirsten">DC 15</span>`
    + `<span class="ace-qol-formula-pill" data-bonus-actor="kirsten">Dex +5 | Prof +3 = 8</span>`
    + `<span class="ace-qol-bonus" data-bonus-actor="ogre">+2 = 9</span>`
    + `<span class="ace-qol-ac" data-ac-actor="jeth">AC 17</span>`;
  const r = splitHtml(html, { makeId: ids, isTable });
  check("her DC stays on the card", r.html.includes("DC 15"), true);
  check("her save bonus does not: a d20's arithmetic is the GM's, hers included",
    r.html.includes("Dex +5 | Prof +3 = 8"), false);
  check("Jeth's AC does not: a party member's AC is the GM's like anybody's", r.html.includes("AC 17"), false);
  check("her pill, the ogre's bonus and Jeth's AC are what is cut", r.slots.map(s => s.html),
    [`<span class="ace-qol-formula-pill" data-bonus-actor="kirsten">Dex +5 | Prof +3 = 8</span>`,
      `<span class="ace-qol-bonus" data-bonus-actor="ogre">+2 = 9</span>`,
      `<span class="ace-qol-ac" data-ac-actor="jeth">AC 17</span>`]);
  check("Jeth's 9 + 11 = 20 on his own save row is the GM's",
    splitHtml(`<span class="ace-qol-bonus" data-bonus-actor="jeth"> + 11 = 20</span>`, { makeId: ids, isTable }).slots.length, 1);
  check("so is a Forge row's bonus marked as a party member's",
    splitHtml(`<span data-ace-secret-owner="kirsten">+5 = 19</span>`, { makeId: ids, isTable }).slots.length, 1);
  check("the rule, in one line",
    [tableOrGM("kirsten", isTable), tableOrGM("ogre", isTable), tableOrGM("gm", isTable), tableOrGM(null, isTable)],
    [null, "gm", "gm", null]);
}
{
  n = 0;
  const html = `<span class="ace-qol-mod-labeled">+4 STR</span><span class="ace-qol-mod-plain">+2</span>`
    + `<span class="ace-qol-formula-pill" data-bonus-actor="pc">Dex +5 | Prof +3 = 8</span>`;
  const r = splitHtml(html, { cardActor: "ogre", makeId: ids, isTable });
  check("a damage chip that names nobody is the card's creature's: the ogre's are cut, and any save pill",
    r.slots.map(s => s.html), [`<span class="ace-qol-mod-labeled">+4 STR</span>`, `<span class="ace-qol-mod-plain">+2</span>`,
      `<span class="ace-qol-formula-pill" data-bonus-actor="pc">Dex +5 | Prof +3 = 8</span>`]);
  const hers = splitHtml(`<span class="ace-qol-mod-labeled">+4 STR</span>`, { cardActor: "kirsten", makeId: ids, isTable });
  check("on Kirsten's own damage card her +4 STR stays: it is her damage formula", hers.slots.length, 0);
}
{
  n = 0;
  const html = `<img class="ace-qol-gm-only" src="x.png"><div class="ace-qol-dmg-gm-controls"><button>APPLY</button>`;
  const r = splitHtml(html, { makeId: ids, isTable });
  check("a void element is cut as itself", r.slots[0].html, `<img class="ace-qol-gm-only" src="x.png">`);
  check("a secret that never closes takes the rest with it", r.slots[1].html.includes("APPLY"), true);
  check("so nothing of it is sent", r.html.includes("APPLY"), false);
}
{
  n = 0;
  const once = splitHtml(`<span class="ace-qol-gm-only">7</span>`, { makeId: ids });
  const twice = splitHtml(once.html, { makeId: ids });
  check("an empty slot is the table's, so a second pass leaves it", twice.slots.length, 0);
  check("audience of an ordinary element", audienceOf({ class: "ace-qol-card" }), null);
  check("a card can mark anything the GM's", audienceOf({ "data-ace-secret": "gm" }), "gm");
  check("with no way to tell, nobody is a player character", splitHtml(
    `<span class="ace-qol-bonus" data-bonus-actor="kirsten">+5</span>`, { makeId: ids }).slots.length, 1);
}

console.log("\nA PARTY MEMBER'S AC AND HIT POINTS ARE THE GM'S, IN THE FLAGS TOO");
{
  const flags = { actorId: "ogre", targetId: "jeth", ac: 17, attackTotal: 19,
    damageResults: [{ targetId: "jeth", currentHP: 34, maxHP: 40, modifier: "resistant", totalFinal: 7,
      damageModifiers: { resist: ["fire"] } }] };
  const { pub } = splitFlags(flags, "ogre", { isTable });
  check("Jeth's AC, hit points and resistance are cut; the damage that landed stays", pub,
    { actorId: "ogre", targetId: "jeth", damageResults: [{ targetId: "jeth", totalFinal: 7 }] });
  const hers = splitFlags({ type: "repeatingSave", actorId: "jeth", casterActorId: "kirsten", dc: 15, modifier: 4, total: 16 },
    "jeth", { isTable });
  check("a party caster's DC stays; a party member's save bonus and total do not", hers.pub,
    { type: "repeatingSave", actorId: "jeth", casterActorId: "kirsten", dc: 15 });
}

console.log("\nTHE FLAGS: A NUMBER IN THE FLAGS IS ON THE TABLE");
{
  const flags = {
    type: "saveResults", castId: "c1", saveDC: 15,
    allResults: [
      { actorId: "ogre", passed: false, dieResult: 7, saveTotal: 9, saveParts: [{ label: "Dex", value: 2 }], currentHP: 40, maxHP: 59 },
      { actorId: "pc", passed: true, dieResult: 16, saveTotal: 21 },
    ],
    damageResults: [{ totalFinal: 12, components: [{ type: "fire", final: 12, raw: 24, formula: "8d6" }] }],
  };
  const { pub, sec } = splitFlags(flags, "gm", { isTable });
  check("what is sent keeps the die, the word and the damage that landed, for a party member too", pub, {
    type: "saveResults", castId: "c1",
    allResults: [{ actorId: "ogre", passed: false, dieResult: 7 }, { actorId: "pc", passed: true, dieResult: 16 }],
    damageResults: [{ totalFinal: 12, components: [{ type: "fire", final: 12 }] }],
  });
  check("laying the overlay back gives every number again", mergeOverlay(pub, sec), flags);
}
{
  const flags = { type: "fireCheck", aceFire: { dc: 10 }, "-=hpDelta": null };
  const { pub } = splitFlags(flags);
  check("a deletion still reaches the server", pub, { type: "fireCheck", aceFire: {}, "-=hpDelta": null });
  // "rolled" is a yes/no on the damage button card, not a number (audit, 2026-10-11).
  check("a yes/no that happens to be called rolled stays", splitFlags({ rolled: true }).pub, { rolled: true });
}

console.log("\nA NUMBER IS WHOSE IT MEASURES, NOT WHOSE CARD IT IS ON");
{
  // Kirsten (a player) hits the ogre: her raw damage is hers, the ogre's hit points are not.
  const flags = { type: "damageResult", actorId: "kirsten", totalRaw: 14,
    damageResults: [{ targetId: "ogre", totalFinal: 14, currentHP: 59, maxHP: 59 }] };
  const { pub, sec } = splitFlags(flags, "kirsten", { isTable });
  check("her raw damage stays on the card", pub.totalRaw, 14);
  check("the ogre's hit points do not", JSON.stringify(pub).includes("59"), false);
  check("the GM gets them back", mergeOverlay(pub, sec), flags);
}
{
  // Her attack card names the ogre at the top: the AC there is the ogre's, not hers.
  const flags = { actorId: "kirsten", targetId: "ogre", attackTotal: 19, ac: 15, currentHP: 59 };
  const { pub } = splitFlags(flags, "kirsten", { isTable });
  check("on her attack card the ogre's AC and hit points are cut, and her own total",
    pub, { actorId: "kirsten", targetId: "ogre" });
  const lone = splitFlags({ actorId: "kirsten", ac: 15 }, "kirsten", { isTable });
  check("an AC at the top of her card that names no target is the GM's, never hers", lone.pub, { actorId: "kirsten" });
}
{
  // Lamia (a creature) casts at Jeth: his total is his, the DC on his row is Lamia's.
  const flags = { actorId: "lamia", saveDC: 13, allResults: [{ actorId: "jeth", saveTotal: 12, saveDC: 13 }] };
  const { pub } = splitFlags(flags, "lamia", { isTable });
  check("Lamia's DC is cut wherever it sits, and Jeth's total",
    pub, { actorId: "lamia", allResults: [{ actorId: "jeth" }] });
}
{
  // Kirsten casts at the ogre: her DC is the table's, the ogre's save total is the GM's.
  const flags = { actorId: "kirsten", saveDC: 15, allResults: [{ actorId: "ogre", saveTotal: 9, saveDC: 15 }] };
  const { pub } = splitFlags(flags, "kirsten", { isTable });
  check("her DC stays on every row, the ogre's total is cut",
    pub, { actorId: "kirsten", saveDC: 15, allResults: [{ actorId: "ogre", saveDC: 15 }] });
}
{
  // A trap's DC and a Forge DC are never a player character's, whoever stepped on it.
  const forge = splitFlags({ actorId: "kirsten", dc: 14, disarmDC: 15, trap: { dc: 14 } }, "kirsten", { isTable, ns: "ace-artificer" });
  check("Forge's DCs and its trap are the GM's", forge.pub, { actorId: "kirsten" });
  const spot = splitFlags({ actorId: "kirsten", perceptionDC: 16, threshold: 10 }, "kirsten", { isTable });
  check("a hidden thing's DC and a threshold are the GM's on any card", spot.pub, { actorId: "kirsten" });
}

console.log("\nA CARD NAMED FOR WHOEVER SAVES STILL CARRIES THE CASTER'S NUMBERS");
{
  // The prompt Jeth's screen rolls from (save-engine pcSavePrompt): named for
  // Jeth, carrying Lamia's DC and Lamia's damage. Audit, 2026-10-11.
  const flags = { type: "pcSavePrompt", actorId: "jeth", casterActorId: "lamia", saveDC: 13,
    saveBonuses: ["1d4"], recipe: { decidedBy: { dc: 13 }, onFail: [{ formula: "8d6" }] } };
  const { pub } = splitFlags(flags, "jeth", { isTable });
  // Jeth's Bless goes too: his own screen reads it back from his sheet when he
  // rolls (save-engine _rollPcSave), as it already re-measures cover.
  check("Lamia's DC, her damage formula and Jeth's save bonuses are cut",
    pub, { type: "pcSavePrompt", actorId: "jeth", casterActorId: "lamia",
      recipe: { decidedBy: {}, onFail: [{}] } });
  const hers = splitFlags({ ...flags, casterActorId: "kirsten" }, "jeth", { isTable });
  check("when Kirsten cast it, her DC stays for the table", hers.pub.saveDC, 13);
}
{
  // A repeat save (repeating-save-engine): Jeth's card, the caster's DC. A card that
  // names its caster's field and leaves it empty has a caster nobody recorded.
  const flags = { type: "repeatingSave", actorId: "jeth", casterActorId: null, dc: 14, total: 11, modifier: 3 };
  const { pub } = splitFlags(flags, "jeth", { isTable });
  check("the DC is cut, and Jeth's own bonus and total", pub,
    { type: "repeatingSave", actorId: "jeth", casterActorId: null });
  // A grapple card says nothing about the grappler: the speaker is not the DC's owner.
  check("a DC on a card with no creature of its own is the GM's",
    splitFlags({ type: "breakFree", passed: false, dc: 13 }, "jeth", { isTable }).pub, { type: "breakFree", passed: false });
}
{
  // A damage row is named for its target and carries the attacker's dice.
  const flags = { actorId: "ogre", totalRaw: 11, preRolled: [{ actorId: "jeth", totalRaw: 11,
    components: [{ type: "bludgeoning", formula: "2d8 + 4", total: 11, raw: 11, final: 11 }] }] };
  const { pub } = splitFlags(flags, "ogre", { isTable });
  check("the ogre's 2d8 + 4 is cut from Jeth's row; what landed stays", pub,
    { actorId: "ogre", preRolled: [{ actorId: "jeth", components: [{ type: "bludgeoning", final: 11 }] }] });
  const hers = splitFlags({ actorId: "kirsten", damageResults: [{ targetId: "ogre",
    components: [{ type: "fire", formula: "8d6", total: 28, raw: 28, final: 14 }], currentHP: 40 }] }, "kirsten", { isTable });
  check("Kirsten's own 8d6 stays on the ogre's row; the ogre's hit points do not", hers.pub,
    { actorId: "kirsten", damageResults: [{ targetId: "ogre",
      components: [{ type: "fire", formula: "8d6", total: 28, raw: 28, final: 14 }] }] });
  check("a contest's totals are the GM's, both sides: the table sees who won",
    splitFlags({ actorId: "kirsten", sides: [{ actorId: "kirsten", total: 17 }, { actorId: "ogre", total: 12 }] },
      "kirsten", { isTable }).pub.sides, [{ actorId: "kirsten" }, { actorId: "ogre" }]);
}

console.log("\nTHE DICE: THE FACES ARE THE TABLE'S, THE SUM IS NOT");
{
  const roll = {
    class: "D20Roll", formula: "1d20 + 5", total: 19, evaluated: true, options: {}, dice: [],
    terms: [
      { class: "D20Die", number: 1, faces: 20, modifiers: [], results: [{ result: 14, active: true }], evaluated: true },
      { class: "OperatorTerm", operator: "+", evaluated: true, options: {} },
      { class: "NumericTerm", number: 5, evaluated: true, options: {} },
    ],
  };
  const d = diceOnlyRoll(JSON.stringify(roll));
  check("formula is the dice", d.formula, "1d20");
  check("total is the face", d.total, 14);
  check("no number term survives", d.terms.some(t => t.class === "NumericTerm"), false);
  check("a roll with no dice sends nothing", diceOnlyRoll({ terms: [{ class: "NumericTerm", number: 3 }] }), null);
}

console.log("\nA WHISPER TO THE GM IS STILL SENT TO EVERY PLAYER");
{
  n = 0;
  // A refused press is posted BY the player and whispered to the GM; the player's
  // own screen still reads its routing (press-gate's "Do it anyway").
  const r = forTable({ content: `<p>Kirsten's initiative is 17</p>`,
    flags: { "ace-qol": { type: "note", gate: { status: "refused", userId: "u1" }, saveDC: 17 } } },
    { gmOnly: true, makeId: ids, isTable });
  check("all of its words are the GM's", r.pub.content, `<div data-ace-slot="s1"></div>`);
  check("its routing stays for the player who posted it", r.pub.flags,
    { "ace-qol": { type: "note", gate: { status: "refused", userId: "u1" } } });
  check("and its numbers are the GM's", r.secret.flags, { "ace-qol": { saveDC: { __aud: "gm", v: 17 } } });
  const hers = forTable({ content: `<span class="ace-qol-bonus" data-bonus-actor="kirsten">+5</span>`,
    flags: { "ace-qol": { actorId: "kirsten", saveDC: 15 } } }, { gmOnly: true, makeId: ids, isTable });
  check("a whisper to the GM keeps even a player character's numbers off the table",
    [hers.pub.content.includes("+5"), "saveDC" in hers.pub.flags["ace-qol"]], [false, false]);
}

console.log("\nWHO GETS WHAT BACK: THE GM, AND NOBODY ELSE");
{
  n = 0;
  const { secret } = forTable({
    content: `<span class="ace-qol-bonus" data-bonus-actor="ogre">+5</span><span class="ace-qol-gm-only">AC 18</span>`,
    flags: { "ace-qol": { saveDC: 14 } },
  }, { makeId: ids, isTable });
  check("the GM gets everything", shareFor({ isGM: true }, secret)?.slots.length, 2);
  // "A creature's bonus, DC, AC, and hit points stay on my screen only." Not the
  // screen of a player who happens to own that creature.
  check("a player gets nothing back, whatever they own", shareFor({ isGM: false }, secret), null);
  check("a card with nothing cut sends nothing", shareFor({ isGM: true }, forTable({ content: "<p>hi</p>" }).secret), null);
}

console.log("\nA CHANGE LANDS EXACTLY WHERE IT WROTE");
{
  const L = (v) => ({ __aud: "gm", v });
  const leafy = { trap: L({ dc: 15, armed: true, formula: "2d10" }) };
  check("a write into a secret object keeps the rest of it",
    applyOverlayChange(leafy, { trap: { armed: false } }, { trap: L({ armed: false }) }),
    { trap: L({ dc: 15, armed: false, formula: "2d10" }) });
}
{
  const had = { aceFire: { check: 8, dc: 10 }, allResults: { __arr: { 0: { saveTotal: 9 } } }, saveDC: 15 };
  // "flags.ace-qol.aceFire.check": 12  — the DC beside it must survive
  check("a nested write keeps its sibling", applyOverlayChange(had, { aceFire: { check: 12 } }, { aceFire: { check: 12 } }),
    { aceFire: { check: 12, dc: 10 }, allResults: { __arr: { 0: { saveTotal: 9 } } }, saveDC: 15 });
  // a new array with no secrets in it: the old secrets must not be laid on it
  check("a replaced array takes its old numbers with it", applyOverlayChange(had, { allResults: [{ passed: true }] }, undefined),
    { aceFire: { check: 8, dc: 10 }, saveDC: 15 });
  check("a deletion takes its numbers with it", applyOverlayChange(had, { "-=aceFire": null }, undefined),
    { allResults: { __arr: { 0: { saveTotal: 9 } } }, saveDC: 15 });
}

console.log("\nTHE GM'S NUMBERS SURVIVE A RELOAD OF THE GM'S BROWSER");
{
  // His rule, 2026-10-11: "The numbers on my cards have to survive a reload of
  // this browser." Read from the file: the GM's screen writes every share to the
  // browser's own store, reads it back before anything else on load, and never
  // asks the chat log to redraw a card it has not drawn (ui.chat.updateMessage
  // posts a card it cannot find, at the bottom of the log).
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../scripts/road/table-view.mjs", import.meta.url), "utf8");
  check("every share the GM holds is written to the browser's store", /this\._write\(store => store\.put\(next, key\)\)/.test(src), true);
  check("a write waits for the store to open instead of being dropped", /else this\.open\(\)\.then\(go\)/.test(src), true);
  check("on load the store is read before any card is put back", /async function onReady\(\) \{\s*await TableStore\.open\(\);/.test(src), true);
  check("a card is redrawn only when the log has drawn it", /if \(!message\?\.logged \|\| !message\.visible\) return;/.test(src), true);
  check("the old redraw that posts an undrawn card is gone", /if \(redraw\) ui\.chat\?\.updateMessage/.test(src), false);
  check("the GM asks each player for the cards they posted while it was away", /type: "aceTableAsk", ids: ids\.slice\(-500\)/.test(src), true);
  check("and the browser is asked to keep its store", /navigator\?\.storage\?\.persist/.test(src), true);
}

console.log("\nFORGE CARRIES THE SAME FUNCTION, NOT A SECOND ONE");
{
  // Forge sold alone registers its own copy (his rule: "A function that assumes
  // another module is installed" is a defect). One function, so the copy is byte
  // for byte the same file; a fix made in one and not the other fails here.
  const { readFileSync, existsSync } = await import("node:fs");
  const here = new URL("../scripts/road/table-view.mjs", import.meta.url);
  const forge = new URL("../../ace-artificer/scripts/table-view.mjs", import.meta.url);
  if (!existsSync(forge)) {
    console.log("  skip  ACE Forge is not installed beside ACE QOL here");
  } else {
    check("Forge's copy is identical to QOL's", readFileSync(forge, "utf8") === readFileSync(here, "utf8"), true);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
