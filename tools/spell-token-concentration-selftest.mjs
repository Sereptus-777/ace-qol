// ─── Deleting a spell's token ends its concentration ─────────────────────────
//
// His rule, 2026-10-14: "When it's deleted off the scene, the concentration
// should come off the caster." Spike Growth's AREA already did it; a spell's
// TOKEN did nothing, so deleting ACE Test Dummy's Spiritual Weapon left him
// concentrating on a spell with nothing on the map. This pins:
//   • which token a spell put there (dnd5e's summon stamp, or ACE's weapon stamp);
//   • a spell with several (Conjure Animals' wolves) ends with the LAST one, on
//     any scene;
//   • a delete ACE makes as a consequence says why, and never ends a
//     concentration: the sweep after concentration ended, a recast (dnd5e begins
//     the new concentration BEFORE it ends the old one), and party transfer;
//   • the token door sits beside the area door and uses the same matcher.
//
// Run: node tools/spell-token-concentration-selftest.mjs
// ──────────────────────────────────────────────────────────────────────────────

import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { spellOriginOf, othersFromTheSameSpell, removedBecause, whyRemoved } from "../scripts/rules/spell-tokens.mjs";

let passed = 0, failed = 0;
function check(label, ok, detail = "") {
  ok ? passed++ : failed++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${ok || !detail ? "" : `  (${detail})`}`);
}
const src = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

console.log("A spell's token and its caster's concentration");

// ── Which token a spell put there ──
const FEY = "Actor.dummy.Item.summonFey";
const WOLVES = "Actor.druid.Item.conjureAnimals";
const fey = { id: "f1", name: "Fey Spirit", actor: { flags: { dnd5e: { summon: { origin: FEY } } } } };
check("dnd5e's summon stamp names the spell", spellOriginOf(fey) === FEY);
check("a stamp only on the token's own changes is read too",
  spellOriginOf({ id: "d", actor: null, delta: { flags: { dnd5e: { summon: { origin: FEY } } } } }) === FEY);
check("ACE's Spiritual Weapon stamp names the spell",
  spellOriginOf({ id: "w", actor: { flags: {} }, flags: { "ace-qol": { spiritualWeapon: { itemUuid: "Actor.dummy.Item.sw" } } } }) === "Actor.dummy.Item.sw");
check("Ireena is nobody's spell", spellOriginOf({ id: "i", actor: { flags: { dnd5e: {} } }, flags: {} }) === null);
check("no token, no answer, no error", spellOriginOf(null) === null);

// ── The last one ──
const wolf = (id) => ({ id, name: `Wolf ${id}`, actor: { flags: { dnd5e: { summon: { origin: WOLVES } } } } });
const here = { tokens: [wolf("w1"), wolf("w2"), fey, { id: "i", name: "Ireena", actor: { flags: {} } }] };
const there = { tokens: [wolf("w3")] };
const left = othersFromTheSameSpell(WOLVES, "w1", [here, there]);
check("deleting one wolf leaves the other two, on either scene",
  left.map(t => t.id).join(",") === "w2,w3", left.map(t => t.id).join(","));
check("the fey spirit was the only one of its spell", othersFromTheSameSpell(FEY, "f1", [here, there]).length === 0);
check("no spell, nothing counted", othersFromTheSameSpell(null, "x", [here]).length === 0);

// ── A consequence says why ──
const opts = removedBecause("it was cast again");
check("a consequence delete says why", whyRemoved(opts) === "it was cast again");
check("other delete options are kept", whyRemoved(removedBecause("x", { render: false })) === "x"
  && removedBecause("x", { render: false }).render === false);
check("the GM pressing delete says nothing", whyRemoved({}) === null && whyRemoved(undefined) === null);
check("a teleport to another scene is a move: Foundry names the copy that replaced it",
  whyRemoved({ replacements: { f1: "Scene.k1.Token.f1" } }) === "it was moved to another scene");
check("an empty replacement list is not a move", whyRemoved({ replacements: {} }) === null);

// ── The doors ──
const cw = src("../scripts/concentration-widget.mjs");
check("deleting a token asks the token door",
  /Hooks\.on\("deleteToken", \(tokenDoc, opts\) => \{\s*this\._onSpellTokenDeleted\(tokenDoc, opts\)/.test(cw));
check("deleting an area hands its options to the area door",
  /this\._onTemplateDeleted\(templateDoc\.id, opts\)/.test(cw));
const door = cw.slice(cw.indexOf("async _onSpellTokenDeleted("), cw.indexOf("async _onSpellTokenDeleted(") + 3200);
check("only the active GM ends it", /game\.users\?\.activeGM !== game\.user/.test(door));
check("a consequence is left alone before anything else is read",
  door.indexOf("whyRemoved(opts)") > 0 && door.indexOf("whyRemoved(opts)") < door.indexOf("fromUuidSync"));
check("it ends with the last one, on every scene",
  /othersFromTheSameSpell\(origin, tokenDoc\?\.id, game\.scenes\)/.test(door));
check("the GM is told when it ends, and when it could not",
  /ui\.notifications\?\.info\(/.test(door) && /ui\.notifications\?\.warn\(/.test(door));
const area = cw.slice(cw.indexOf("async _onTemplateDeleted("), cw.indexOf("async _onSpellTokenDeleted("));
check("the area door leaves a consequence alone too",
  /const why = whyRemoved\(opts\);[\s\S]*else if \(game\.users\?\.activeGM === game\.user && tracker\.actor && tracker\.item\)/.test(area));
check("both doors find the concentration with one matcher",
  /_concentrationEffectsFor\(actor, item\)/.test(cw) && /this\._concentrationEffectsFor\(caster, item\)/.test(door)
  && /for \(const effect of this\._concentrationEffectsFor\(actor, item\)\)/.test(cw));

// ── Every delete ACE makes as a consequence says so ──
const qol = src("../scripts/ace-qol.mjs");
check("the sweep after concentration ended: its areas",
  /deleteEmbeddedDocuments\("MeasuredTemplate", toDelete,\s*removedBecause\(/.test(qol));
check("the sweep after concentration ended: its summons",
  /deleteEmbeddedDocuments\("Token", summonIds,\s*removedBecause\(/.test(qol));
const sw = src("../scripts/spiritual-weapon.mjs");
check("Spiritual Weapon cast again: the old weapon after a summon",
  /await old\.delete\(removedBecause\("it was cast again"\)\)/.test(sw));
check("Spiritual Weapon cast again: the old weapon before a placement",
  /await old\.delete\(removedBecause\(why\)\)/.test(sw));
check("its minute running out is NOT a consequence: that ends the spell",
  /try \{ await t\.delete\(\); say\(`\$\{t\.name\} is gone: its minute is up\.`\)/.test(sw));
const pt = src("../scripts/party-transfer.mjs");
check("party transfer: a summon carried to another scene",
  /deleteEmbeddedDocuments\("Token", entries\.map\(e => e\.id\),\s*removedBecause\(/.test(pt));
check("party transfer: the old copy the carried one replaces",
  /deleteEmbeddedDocuments\("Token", doomed,\s*removedBecause\(/.test(pt));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
