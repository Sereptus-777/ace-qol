// ─── Spiritual Weapon self-test ───────────────────────────────────────────────
//
// His call, 2026-10-14: Spiritual Weapon is a token on the map that attacks as
// itself, with a picker for its look remembered per caster. This pins what can
// be proved without Foundry running:
//   • which items are the spell (both editions, however imported);
//   • the JB2A list read from Sequencer's database (nametags left out, forms and
//     colours named the way the picker shows them);
//   • the weapon is "not a creature" to the one picker rule every gatherer asks;
//   • its dice by edition (2014: 1d8 per two slot levels above 2nd; 2024: per
//     slot level above 2nd), on dnd5e's own summon flags.
//
// Run: node tools/spiritual-weapon-selftest.mjs
// ──────────────────────────────────────────────────────────────────────────────

import { isSpiritualWeapon } from "../scripts/rules/spell-name.mjs";
import { notACreature, lifeStateOf, pickable } from "../scripts/road/picker-rule.mjs";
import { artCatalog, DICE } from "../scripts/spiritual-weapon.mjs";

let passed = 0, failed = 0;
function check(label, ok, detail = "") {
  ok ? passed++ : failed++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${ok || !detail ? "" : `  (${detail})`}`);
}

console.log("Spiritual Weapon");

// ── Which items are the spell ──
check("\"Spiritual Weapon\" (a spell) is it", isSpiritualWeapon({ type: "spell", name: "Spiritual Weapon" }));
check("\"Spiritual Weapon (Legacy)\" is it", isSpiritualWeapon({ type: "spell", name: "Spiritual Weapon (Legacy)" }));
check("\"Spiritual Weapon (2/Day)\" is it", isSpiritualWeapon({ type: "spell", name: "Spiritual Weapon (2/Day)" }));
check("the weapon's own \"Move and Attack\" is not", !isSpiritualWeapon({ type: "feat", name: "Move and Attack" }));
check("a feat named Spiritual Weapon is not the spell", !isSpiritualWeapon({ type: "feat", name: "Spiritual Weapon" }));

// ── The look: JB2A through Sequencer's database ──
const P = "modules/jb2a_patreon/Library/2nd_Level/Spiritual_Weapon";
globalThis.Sequencer = { Database: {
  entryExists: (k) => k === "jb2a.spiritual_weapon",
  getAllFileEntries: () => [
    `${P}/SpiritualWeapon_Mace01_01_Spectral_Blue_400x400.webm`,
    `${P}/SpiritualWeapon_Mace01_01_Flaming_Yellow_400x400.webm`,
    `${P}/SpiritualWeapon_GreatAxe01_02_Spectral_Orange_400x400.webm`,
    `${P}/SpiritualWeapon_Lasersword1H01_01_Dark_Red_600x600.webm`,
    `${P}/Nametag/SpiritualWeapon_Mace01_01_Spectral_Blue_Nametag_200x200.webm`,
  ],
} };
const cat = artCatalog();
check("four looks, the nametag left out", cat.length === 4, JSON.stringify(cat.map(a => a.file.split("/").pop())));
const mace = cat.find(a => /Mace01_01_Spectral_Blue/.test(a.file));
check("the spectral blue mace reads as \"Mace\", \"Spectral Blue\"", mace?.form === "Mace" && mace?.style === "Spectral Blue", JSON.stringify(mace));
check("its thumbnail sits beside it", mace?.thumb === `${P}/SpiritualWeapon_Mace01_01_Spectral_Blue_Thumb.webp`, mace?.thumb);
check("\"GreatAxe\" reads as \"Great Axe\"", cat.some(a => a.form === "Great Axe"), JSON.stringify(cat.map(a => a.form)));
check("a 600x600 laser sword is read too", cat.some(a => a.form === "Lasersword 1H" && a.style === "Dark Red"), JSON.stringify(cat.map(a => `${a.form}|${a.style}`)));
globalThis.Sequencer = undefined;
check("no Sequencer: no looks, and no error", artCatalog().length === 0);

// ── Not a creature ──
const weaponToken = { flags: { "ace-qol": { notACreature: "Spiritual Weapon" } } };
const weaponActor = { system: { attributes: { hp: { value: 1 } } } };
check("the weapon's token says what it is", notACreature(weaponActor, weaponToken) === "Spiritual Weapon");
const life = lifeStateOf(weaponActor, weaponToken);
check("the picker rule reads it as a thing", life.state === "thing", JSON.stringify(life));
check("no harm, heal or revive picker may offer it",
  !pickable("harm", life).ok && !pickable("heal", life).ok && !pickable("revive", life).ok);
const ireena = lifeStateOf({ system: { attributes: { hp: { value: 9 } } } }, { flags: {} });
check("a creature is still a creature", ireena.state === "alive" && pickable("harm", ireena).ok);

// ── The dice, by edition, at each slot level ──
const dice = (formula, level) => {
  const f = formula.replace(/@flags\.dnd5e\.summon\.level/g, String(level)).replace(/@flags\.dnd5e\.summon\.mod/g, "0");
  return Function(`"use strict"; return ${f.replace(/\)d8.*/, ")").replace(/^\(/, "(").replace(/floor/g, "Math.floor")};`)();
};
check("2014 at level 2: 1d8", dice(DICE["2014"], 2) === 1);
check("2014 at level 3: still 1d8 (every TWO levels above 2nd)", dice(DICE["2014"], 3) === 1);
check("2014 at level 4: 2d8", dice(DICE["2014"], 4) === 2);
check("2014 at level 6: 3d8", dice(DICE["2014"], 6) === 3);
check("2024 at level 2: 1d8", dice(DICE["2024"], 2) === 1);
check("2024 at level 3: 2d8 (every level above 2nd)", dice(DICE["2024"], 3) === 2);
check("2024 at level 5: 4d8", dice(DICE["2024"], 5) === 4);
check("both add the caster's modifier", /\+ @flags\.dnd5e\.summon\.mod$/.test(DICE["2014"]) && /\+ @flags\.dnd5e\.summon\.mod$/.test(DICE["2024"]));

// ── Its attack card names the caster's spell attack (his table, 2026-10-14:
//    "-5 INT +6 PROF +5 SUMMON" on a roll whose only bonus was ACE Test Dummy's +6) ──
{
  const { readFileSync } = await import("fs");
  const { fileURLToPath } = await import("url");
  const atk = readFileSync(fileURLToPath(new URL("../scripts/attack-pipeline.mjs", import.meta.url)), "utf8");
  check("a flat attack's chips come from one helper",
    /static _flatAttackChips\(item, actor, activity, d20, rollTotal\)/.test(atk));
  check("it reads dnd5e's flat flag and the summon's caster",
    /act\?\.attack\?\.flat !== true/.test(atk) && /fromUuidSync\(origin\)\?\.actor/.test(atk));
  check("both card builders ask it",
    (atk.match(/AttackPipeline\._flatAttackChips\(item, actor, activity, d20,/g) ?? []).length === 2);
  check("and neither then adds the attacker's own ability, PROF or a leftover chip",
    (atk.match(/if \(!_flat\) (?:formulaParts|parts)\.push/g) ?? []).length === 2
    && (atk.match(/if \(!_flat && profBonus\)/g) ?? []).length === 2
    && (atk.match(/if \(!_flat && missingBonus !== 0/g) ?? []).length === 2);
}

// ── What you see is its space, and its caster's owners own it (his table,
//    2026-10-14: "out of reach, which I'm not", and "not an owner of Spiritual
//    Weapon... He is the owner") ──
{
  const { readFileSync } = await import("fs");
  const { fileURLToPath } = await import("url");
  const sw = readFileSync(fileURLToPath(new URL("../scripts/spiritual-weapon.mjs", import.meta.url)), "utf8");
  check("no art drawn bigger than the token", !/ART_SCALE/.test(sw) && /scaleX: 1, scaleY: 1/.test(sw));
  check("one full square, snapped, before either placement is measured",
    /tokenData\.width = 1;\s*tokenData\.height = 1;/.test(sw)
    && (sw.match(/squareUp\(tokenData\);\s*\n\s*(?:if \(casterDoc\) )?SpiritualWeapon\._holdRange/g) ?? []).length === 2);
  check("the caster's owners own this weapon, on its own token",
    /ownership: foundry\.utils\.deepClone\(caster\.ownership\)/.test(sw));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
