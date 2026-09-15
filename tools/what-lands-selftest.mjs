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
check("a recipe decided by nothing lands nothing",
  whatLands({ decidedBy: { kind: "automatic" } }, { passed: false }).why === "it is not decided by a save");
check("an attack asked without its result lands nothing, and says what it needs",
  (() => { const v = whatLands({ decidedBy: { kind: "attack" }, onHit: [dmg("1d8", "slashing")] }, { passed: false });
    return !v.damage.length && !v.conditions.length && /hit, a critical hit or a miss/.test(v.why); })());

// ── An attack's result (The One Road, Phase 3, 2026-09-14) ──
const atk = (onHit, onCrit = [], onMiss = [], then = []) =>
  ({ decidedBy: { kind: "attack", melee: true, attacks: 1 }, onHit, onCrit, onMiss, then, onFail: [], onSuccess: [] });
const dmgOn = (formula, type) => ({ kind: "damage", formula, types: [type] });
const frostBrand = atk([dmgOn("1d8", "slashing"), dmgOn("1d6", "cold")]);
o = whatLands(frostBrand, { result: "hit", rolled: [{ total: 5, type: "slashing" }, { total: 3, type: "cold" }] });
check("a hit lands the attack's own dice, its extra dice with them: 5 slashing, 3 cold",
  o.damage.map(d => `${d.amount} ${d.type}`).join(", ") === "5 slashing, 3 cold" && o.label === "HIT", show(o));
o = whatLands(frostBrand, { result: "miss", rolled: [{ total: 5, type: "slashing" }] });
check("a miss lands nothing", o.damage.every(d => d.amount === 0) && o.label === "MISS" && !o.then.length, show(o));
const vicious = atk([dmgOn("2d6", "slashing")], [dmgOn("2d6", "slashing")]);
check("a plain hit adds no crit dice", !whatLands(vicious, { result: "hit" }).extras.length);
o = whatLands(vicious, { result: "critical" });
check("a critical hit adds the item's crit dice, once: 2d6 slashing",
  o.extras.length === 1 && o.extras[0].formula === "2d6" && o.extras[0].types[0] === "slashing" && o.label === "CRITICAL",
  JSON.stringify(o.extras));
const wolf = atk([dmgOn("1d6", "piercing"), { kind: "condition", condition: { key: "prone", duration: 60, ends: null } }]);
check("a hit's own condition is part of what lands on a hit, and not on a miss",
  whatLands(wolf, { result: "hit" }).conditions[0]?.key === "prone" && !whatLands(wolf, { result: "miss" }).conditions.length);
const clawSave = { key: "2014 · claws · d281bf8c · then 1", decidedBy: save("con"), onSuccess: [],
  onFail: [dmg("3d6", "poison", "half")] };
const claw = atk([dmgOn("2d4", "slashing")], [], [], [clawSave]);
check("a hit hands on the save after it, and a miss does not",
  whatLands(claw, { result: "hit" }).then[0] === clawSave && whatLands(claw, { result: "critical" }).then.length === 1
    && !whatLands(claw, { result: "miss" }).then.length);
check("that save is decided as a save: failed, all 3 poison; made, half of 3 is 1",
  whatLands(clawSave, { passed: false, rolled: [{ total: 3, type: "poison" }] }).damage[0]?.amount === 3
    && whatLands(clawSave, { passed: true, rolled: [{ total: 3, type: "poison" }] }).damage[0]?.amount === 1);
const graze = atk([dmgOn("1d12", "slashing")], [], [dmgOn("@mod", "slashing")]);
o = whatLands(graze, { result: "miss", rolled: [{ total: 3, type: "slashing" }] });
check("a miss that still deals damage (Graze) lands it", o.damage[0]?.amount === 3 && o.dealsDamage, show(o));

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

// ── A save card row asks whatLands and nothing else ──
const rowOf = (r, o) => { const v = whatLands(r, o); return `${v.share} ${v.label}`; };
check("whatLands gives a made Fireball's row: half, PASS (HALF)",
  rowOf(fireball, { passed: true }) === "0.5 PASS (HALF)", rowOf(fireball, { passed: true }));
check("whatLands gives a failed Disintegrate's row with Evasion: all of it, FAIL",
  rowOf(disintegrate, { passed: false, evasion: true }) === "1 FAIL", rowOf(disintegrate, { passed: false, evasion: true }));
check("whatLands gives a made Hold Person's row: none, PASS (NO DMG)",
  rowOf(holdPerson, { passed: true }) === "0 PASS (NO DMG)", rowOf(holdPerson, { passed: true }));
check("whatLands names an automatic failure",
  rowOf(holdPerson, { passed: false, autoFail: true }) === "1 AUTO-FAIL", rowOf(holdPerson, { passed: false, autoFail: true }));
check("a save with no recipe still gets a plain row and lands nothing",
  rowOf(null, { passed: true }) === "0 PASS (NO DMG)" && whatLands(null, { passed: false }).conditions.length === 0,
  rowOf(null, { passed: true }));
check("the GM's quarter and double from the card: 7 is 1 and 14", shareOf(7, 0.25) === 1 && shareOf(7, 2) === 14,
  `${shareOf(7, 0.25)} and ${shareOf(7, 2)}`);

// ── A contest lands the way a save does (Phase 4, 2026-09-15) ──
// A 2014 grapple: the grappler's Athletics against the target's Athletics or
// Acrobatics. The target losing takes onFail; holding (or a tie) takes onSuccess.
const grapple2014 = { decidedBy: { kind: "contest", check: "ath vs ath/acr", dc: null }, onSuccess: [],
  onFail: [{ kind: "condition", condition: { key: "grappled", duration: null, ends: null } }] };
o = whatLands(grapple2014, { passed: false });
check("a 2014 grapple, lost: Grappled, and no damage", o.conditions.map(c => c.key).join() === "grappled" && o.damage.length === 0, show(o));
o = whatLands(grapple2014, { passed: true });
check("a 2014 grapple, held or tied: nothing", o.conditions.length === 0 && o.damage.length === 0, show(o));

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
