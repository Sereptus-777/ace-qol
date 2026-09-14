// ─── What a save puts on a creature, decided from its recipe (2026-09-14) ───
//
// The One Road, Phase 1. The recipes here are the shapes the recipe reader
// prints for the spells Phase 1 is judged on (Disintegrate, Fireball, Hold
// Person, Blade Barrier's cast save), so a change to the decision fails here
// before it reaches a creature. The replay pins the same four from his own items.
//
// Run:  node tools/what-lands-selftest.mjs
// ──────────────────────────────────────────────────────────────────────────────

const { whatLands, damageShare, shareOf } = await import("file:///D:/FoundryVTT/Data/modules/ace-qol/scripts/road/what-lands.mjs");

let pass = 0, fail = 0;
const check = (label, ok, detail) => {
  if (ok) pass++; else fail++;
  console.log(`${ok ? "  ok  " : "  FAIL"} ${label}${detail ? `: ${detail}` : ""}`);
};
const save = (ability) => ({ kind: "save", ability, dc: "spellcasting" });
const dmg = (formula, type, onSuccess) => ({ kind: "damage", formula, types: [type], onSuccess });
const show = (o) => JSON.stringify({ damage: o.damage.map(d => `${d.amount} ${d.type}`), conditions: o.conditions.map(c => c.key) });

const disintegrate = { decidedBy: save("dex"), onFail: [dmg("10d6 + 40", "force", "none")], onSuccess: [] };
const fireball = { decidedBy: save("dex"), onFail: [dmg("8d6", "fire", "half")], onSuccess: [] };
const holdPerson = { decidedBy: save("wis"), onSuccess: [],
  onFail: [{ kind: "condition", condition: { key: "paralyzed", duration: 60, ends: "a save at the end of each of its turns" } }] };
const bladeBarrier = { decidedBy: save("dex"), onFail: [dmg("6d10", "force", "half")], onSuccess: [] };

let o = whatLands(disintegrate, { passed: false, rolled: [{ total: 75, type: "force" }] });
check("Disintegrate, failed: all 75 force", o.damage.length === 1 && o.damage[0].amount === 75 && o.damage[0].type === "force", show(o));
o = whatLands(disintegrate, { passed: true, rolled: [{ total: 75, type: "force" }] });
check("Disintegrate, made: nothing", o.damage.every(d => d.amount === 0), show(o));
o = whatLands(disintegrate, { passed: false, rolled: [{ total: 75, type: "force" }], evasion: true });
check("Disintegrate, failed with Evasion: still all 75 (it is not a half-damage effect)", o.damage[0].amount === 75, show(o));

o = whatLands(fireball, { passed: false, rolled: [{ total: 29, type: "fire" }] });
check("Fireball, failed: all 29 fire", o.damage[0].amount === 29, show(o));
o = whatLands(fireball, { passed: true, rolled: [{ total: 29, type: "fire" }] });
check("Fireball, made: half, rounded down (14)", o.damage[0].amount === 14, show(o));
o = whatLands(fireball, { passed: true, rolled: [{ total: 29, type: "fire" }], evasion: true });
check("Fireball, made with Evasion: none", o.damage[0].amount === 0, show(o));
o = whatLands(fireball, { passed: false, rolled: [{ total: 29, type: "fire" }], evasion: true });
check("Fireball, failed with Evasion: half (14)", o.damage[0].amount === 14, show(o));

o = whatLands(holdPerson, { passed: false });
check("Hold Person, failed: Paralyzed, ending on its end-of-turn save",
  o.conditions.length === 1 && o.conditions[0].key === "paralyzed" && /end of each of its turns/.test(o.conditions[0].ends), show(o));
o = whatLands(holdPerson, { passed: true });
check("Hold Person, made: nothing", !o.conditions.length && !o.damage.length, show(o));

o = whatLands(bladeBarrier, { passed: false, rolled: [{ total: 33, type: "force" }] });
check("Blade Barrier's cast save, failed: all 33 force", o.damage[0].amount === 33, show(o));
o = whatLands(bladeBarrier, { passed: true, rolled: [{ total: 33, type: "force" }] });
check("Blade Barrier's cast save, made: half (16)", o.damage[0].amount === 16, show(o));

const menu = { decidedBy: save("con"), onSuccess: [],
  onFail: [{ kind: "condition", condition: { key: "poisoned" } }, { kind: "note", condition: { key: "one of: Blinded, Deafened" } }] };
o = whatLands(menu, { passed: false });
check("a menu: what every choice shares lands, and the choice is a note",
  o.conditions[0]?.key === "poisoned" && o.notes[0] === "one of: Blinded, Deafened", JSON.stringify(o));
const both = { decidedBy: save("con"), onFail: [{ kind: "effect", condition: { key: "Unable to Move" } }],
  onSuccess: [{ kind: "effect", condition: { key: "Unable to Move" } }] };
check("an effect the item puts on either result lands on a made save too",
  whatLands(both, { passed: true }).effects[0]?.key === "Unable to Move");
check("a recipe not decided by a save lands nothing",
  whatLands({ decidedBy: { kind: "attack" } }, { passed: false }).why === "it is not decided by a save");

// ── The one rule every save path uses for a card row (2026-09-14) ──
const row = (o) => { const s = damageShare(o); return `${s.share} ${s.label}`; };
check("a made save against a half-damage effect takes half", row({ half: true, passed: true }) === "0.5 PASS (HALF)", row({ half: true, passed: true }));
check("a made save against an effect with no half clause takes none", row({ half: false, passed: true }) === "0 PASS (NO DMG)", row({ half: false, passed: true }));
check("a failed save takes all of it", row({ half: true, passed: false }) === "1 FAIL", row({ half: true, passed: false }));
check("an automatic failure says so", row({ half: false, passed: false, autoFail: true }) === "1 AUTO-FAIL", row({ half: false, passed: false, autoFail: true }));
check("Evasion, made, against a half-damage effect: none", row({ half: true, passed: true, evasion: true }) === "0 PASS (EVASION)", row({ half: true, passed: true, evasion: true }));
check("Evasion, failed, against a half-damage effect: half", row({ half: true, passed: false, evasion: true }) === "0.5 FAIL (EVASION: HALF)", row({ half: true, passed: false, evasion: true }));
check("Evasion, failed, against an effect with no half clause: all of it (RAW; the eight old copies gave half)",
  row({ half: false, passed: false, evasion: true }) === "1 FAIL", row({ half: false, passed: false, evasion: true }));
check("Evasion, made, against an effect with no half clause: none, and not called Evasion",
  row({ half: false, passed: true, evasion: true }) === "0 PASS (NO DMG)", row({ half: false, passed: true, evasion: true }));
check("a share rounds down: half of 29 is 14", shareOf(29, 0.5) === 14, String(shareOf(29, 0.5)));
check("the GM's quarter and double from the card: 7 is 1 and 14", shareOf(7, 0.25) === 1 && shareOf(7, 2) === 14,
  `${shareOf(7, 0.25)} and ${shareOf(7, 2)}`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
