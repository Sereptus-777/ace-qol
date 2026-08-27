// ─── ACE: QOL — Rules Engine Self-Test (the scorecard) ────────────────────────
//
// THE answer to "am I just endlessly testing?" (Johnny, 2026-07-10). The
// engine tests ITSELF: canned rules text, decision tables, and contract
// checks run through the real production code — parser, brain, drafter,
// sight logic, save math — and report a pass/fail scorecard. Every bug we've
// fixed live becomes a REGRESSION TEST here (the wasp's "taking", the fey's
// decorated names, the darkvision-vs-magical-darkness law), so a fixed bug
// can never silently return.
//
// Run from the console any time:   game.aceQol.selfTest()
// Output: console table + a GM-whispered scorecard card.
// Zero side effects: no documents created, no canvas touched, no dice shown.
// ──────────────────────────────────────────────────────────────────────────────

import { MODULE_ID } from "../ace-qol.mjs";
import { DescriptionParser } from "../description-parser.mjs";
import { Situation } from "../situation.mjs";
import { RulesBrain } from "./rules-brain.mjs";
import { SpaceDrafter } from "./space-drafter.mjs";
import { SPELL_RULES, validateAllSpellRules } from "./rules-data-spells.mjs";
import { WEAPON_RULES, validateAllWeaponRules } from "./rules-data-weapons.mjs";
import { PostHitSaves } from "../post-hit-saves.mjs";
import { ConditionVisuals } from "../condition-visuals.mjs";
import { ATTACK_MULTI_SPELLS, validateAllAttackMultiSpells } from "../spell-pipeline/registry/attack-multi-spells.mjs";
import { DamageResolver } from "../spell-pipeline/resolvers/damage.mjs";
import { HearingGate } from "./hearing-gate.mjs";
// THE GATE's pure verdict helpers (suite 9). save-engine.mjs imports nothing
// from rules/, so this direction adds no cycle.
import { SaveEngine } from "../save-engine.mjs";

/** Minimal fake item — enough for the parser, brain, and drafter. */
function fakeItem(name, descriptionHtml, { type = "feat", sourceRules = null, flags = {} } = {}) {
  return {
    name,
    type,
    uuid: `SelfTest.${name.replace(/\W+/g, "-")}`,
    flags,
    actor: null,
    system: {
      description: { value: descriptionHtml },
      source: sourceRules ? { rules: sourceRules } : {},
      properties: new Set(),
      duration: {},
    },
  };
}

export class SelfTest {

  /** Run every suite. Returns { passed, failed, results } and reports. */
  static async run({ quiet = false } = {}) {
    const results = [];
    const t = (suite, name, pass, detail = "") => results.push({ suite, name, pass: !!pass, detail: String(detail) });

    // ═════════════════════════════════════════════════════════════════════
    //  SUITE 1 — Description parser (regressions live here forever)
    // ═════════════════════════════════════════════════════════════════════
    try {
      // The Giant Wasp, verbatim statblock wording — the 2026-07-10 bug.
      const wasp = DescriptionParser.parse(fakeItem("Sting",
        "<p>The target must make a DC 11 Constitution saving throw, taking 10 (3d6) poison damage on a failed save, or half as much damage on a successful one.</p>"));
      const ws = wasp.saves?.[0];
      t("parser", "wasp save detected (DC 11 CON)", ws?.dc === 11 && ws?.ability === "con", JSON.stringify({ dc: ws?.dc, ability: ws?.ability }));
      const wd = (ws?.failEffect ?? []).find(f => f.type === "damage");
      t("parser", "wasp fail-damage extracted ('taking' wording)", wd?.formula === "3d6" && wd?.damageType === "poison", JSON.stringify(wd ?? null));
      t("parser", "wasp half-on-success detected", ws?.halfOnSuccess === true, `halfOnSuccess=${ws?.halfOnSuccess}`);

      // "takes" wording still parses (don't fix one tense and break the other)
      const snake = DescriptionParser.parse(fakeItem("Bite",
        "<p>The target must make a DC 12 Constitution saving throw. On a failed save the target takes 7 (2d6) poison damage.</p>"));
      const sd = (snake.saves?.[0]?.failEffect ?? []).find(f => f.type === "damage");
      t("parser", "'takes' wording still parses", sd?.formula === "2d6" && sd?.damageType === "poison", JSON.stringify(sd ?? null));

      // Condition-on-fail wording
      const ghoul = DescriptionParser.parse(fakeItem("Claws",
        "<p>The target must succeed on a DC 10 Constitution saving throw or be paralyzed for 1 minute.</p>"));
      const gc = (ghoul.saves?.[0]?.failEffect ?? []).find(f => f.type === "condition");
      t("parser", "condition-on-fail extracted (paralyzed)", gc?.condition === "paralyzed", JSON.stringify(gc ?? null));

      // No-save text stays quiet — no phantom saves
      const plain = DescriptionParser.parse(fakeItem("Club", "<p>A simple wooden club. Deals bludgeoning damage.</p>"));
      t("parser", "plain item produces no saves", (plain.saves ?? []).length === 0, `saves=${plain.saves?.length}`);
    } catch (err) { t("parser", "suite crashed", false, err?.message ?? String(err)); }

    // ═════════════════════════════════════════════════════════════════════
    //  SUITE 2 — Rules brain (lookup, normalization, edition, override)
    // ═════════════════════════════════════════════════════════════════════
    try {
      t("brain", "normalization strips decorations",
        RulesBrain.normalizeName("Darkness (1/Day)") === "darkness"
        && RulesBrain.normalizeName("Fog Cloud [Legacy]") === "fog cloud"
        && RulesBrain.normalizeName("  TRICKSY ") === "tricksy");

      const dark = RulesBrain.lookup(fakeItem("Darkness (1/Day)", "", { type: "spell" }));
      t("brain", "decorated Darkness resolves to the library entry", dark?.entry?.space?.kind === "magicalDarkness", `kind=${dark?.entry?.space?.kind}`);

      const trick = RulesBrain.lookup(fakeItem("Tricksy", "", { type: "feat" }));
      t("brain", "Tricksy (feat) resolves", trick?.entry?.space?.obscurement === "heavy", `obscurement=${trick?.entry?.space?.obscurement}`);

      const e2024 = RulesBrain.resolveEdition(fakeItem("X", "", { sourceRules: "2024" }));
      t("brain", "feature's own 2024 edition wins", e2024 === "2024", `edition=${e2024}`);

      const ovItem = fakeItem("Totally Custom Thing", "", { flags: { [MODULE_ID]: { rulesEntry: { space: { obscurement: "heavy", kind: "fog", pierceBy: ["blindsight"] } } } } });
      const ov = RulesBrain.lookup(ovItem);
      t("brain", "per-item override flag wins", ov?.entry?.space?.kind === "fog", `kind=${ov?.entry?.space?.kind}`);

      const net = RulesBrain.lookup(fakeItem("Net", "", { type: "weapon" }));
      t("brain", "weapon entries served (Net)", net?.entry?.onHit?.[0]?.condition === "restrained", JSON.stringify(net?.entry?.onHit?.[0] ?? null));

      const probs = [...validateAllSpellRules(), ...validateAllWeaponRules()];
      t("brain", "all rules entries validate", probs.length === 0, probs.join("; ") || "clean");
    } catch (err) { t("brain", "suite crashed", false, err?.message ?? String(err)); }

    // ═════════════════════════════════════════════════════════════════════
    //  SUITE 3 — Space drafter (the engine reading unknown content)
    // ═════════════════════════════════════════════════════════════════════
    try {
      // Tricksy's actual wording — must infer magical darkness
      const tr = SpaceDrafter.infer(fakeItem("Tricksy-Test",
        "<p>The fey can create a 5-foot cube of magical darkness on a point it can see within 5 feet of it, which lasts until the end of its next turn.</p>"));
      t("drafter", "magical darkness inferred (darkvision does NOT pierce)",
        tr?.entry?.space?.kind === "magicalDarkness" && !tr.entry.space.pierceBy.includes("darkvision"),
        JSON.stringify(tr?.entry?.space?.pierceBy ?? null));

      const plainDark = SpaceDrafter.infer(fakeItem("Shadow Pocket",
        "<p>This creates an area of darkness in a 10-foot radius.</p>"));
      t("drafter", "PLAIN darkness inferred (darkvision DOES pierce)",
        plainDark?.entry?.space?.pierceBy?.includes("darkvision") === true,
        JSON.stringify(plainDark?.entry?.space?.pierceBy ?? null));

      const fog = SpaceDrafter.infer(fakeItem("Smoke Bomb",
        "<p>Thick smoke fills the area, which becomes heavily obscured until the end of your next turn.</p>"));
      t("drafter", "heavy obscurement inferred (fog kind, blindsight only)",
        fog?.entry?.space?.kind === "fog" && String(fog?.entry?.space?.pierceBy) === "blindsight",
        JSON.stringify(fog?.entry?.space ?? null));

      const sil = SpaceDrafter.infer(fakeItem("Zone of Quiet",
        "<p>No sound can be created within or pass through the area.</p>"));
      t("drafter", "silence inferred + deafened stamp",
        sil?.entry?.space?.silence === true && sil?.entry?.space?.stampInside?.[0] === "deafened",
        JSON.stringify(sil?.entry?.space ?? null));

      const amb = SpaceDrafter.infer(fakeItem("Vague Blessing",
        "<p>Allies in the area feel emboldened and fight with renewed vigor.</p>"));
      t("drafter", "ambiguous text stays hands-off", amb === null, amb ? "DRAFTED (should not have)" : "null ✓");
    } catch (err) { t("drafter", "suite crashed", false, err?.message ?? String(err)); }

    // ═════════════════════════════════════════════════════════════════════
    //  SUITE 4 — Sight pierce decision table (the RAW sense laws)
    // ═════════════════════════════════════════════════════════════════════
    try {
      const MAGICAL = { pierceBy: ["devilsSight", "truesight", "blindsight"] };
      const PLAIN   = { pierceBy: ["darkvision", "devilsSight", "truesight", "blindsight"] };
      const FOG     = { pierceBy: ["blindsight"] };
      const P = (space, senses) => Situation.canPierce(space, senses).pierced;

      t("sight", "darkvision does NOT pierce magical darkness", P(MAGICAL, { darkvision: 60, dist: 20 }) === false);
      t("sight", "darkvision DOES pierce plain darkness", P(PLAIN, { darkvision: 60, dist: 20 }) === true);
      t("sight", "devil's sight pierces magical darkness (≤120 feet)", P(MAGICAL, { devilsSight: true, dist: 100 }) === true);
      t("sight", "devil's sight fails beyond 120 feet", P(MAGICAL, { devilsSight: true, dist: 150 }) === false);
      t("sight", "devil's sight does NOT pierce fog", P(FOG, { devilsSight: true, dist: 10 }) === false);
      t("sight", "truesight does NOT pierce fog (RAW)", P(FOG, { truesight: 120, dist: 10 }) === false);
      t("sight", "truesight pierces magical darkness", P(MAGICAL, { truesight: 120, dist: 10 }) === true);
      t("sight", "blindsight pierces everything in radius", P(FOG, { blindsight: 30, dist: 10 }) === true && P(MAGICAL, { blindsight: 30, dist: 10 }) === true);
      t("sight", "blindsight fails beyond its radius", P(FOG, { blindsight: 30, dist: 60 }) === false);
      t("sight", "no senses → blocked", P(MAGICAL, { dist: 10 }) === false);
    } catch (err) { t("sight", "suite crashed", false, err?.message ?? String(err)); }

    // ═════════════════════════════════════════════════════════════════════
    //  SUITE 5 — Save-consequence contract (the wasp's whole pipeline)
    // ═════════════════════════════════════════════════════════════════════
    try {
      // The flags mapping must carry the fail-effect (the dropped-bag bug).
      const parsed = DescriptionParser.parse(fakeItem("Contract Sting",
        "<p>DC 13 Constitution saving throw, taking 9 (2d8) poison damage on a failed save, or half as much damage on a successful one.</p>"));
      const spec = parsed.saves[0];
      const wireBag = JSON.parse(JSON.stringify({   // simulate the message flags round-trip
        dc: spec.dc, ability: spec.ability, failEffect: spec.failEffect ?? [], halfOnSuccess: !!spec.halfOnSuccess,
      }));
      t("save-contract", "fail-effect survives the message round-trip",
        wireBag.failEffect?.[0]?.formula === "2d8" && wireBag.halfOnSuccess === true, JSON.stringify(wireBag));

      // Half-on-success math: deterministic formula, stub target, real code path.
      const stubActor = { system: { traits: {} } };
      const stubItem = { system: { properties: new Set() } };
      const resFull = { effects: [] };
      await PostHitSaves._rollAndApplySaveDamage({ formula: "10", damageType: "poison" }, stubActor, stubItem, resFull);
      const resHalf = { effects: [] };
      await PostHitSaves._rollAndApplySaveDamage({ formula: "10", damageType: "poison" }, stubActor, stubItem, resHalf, { half: true });
      t("save-contract", "fail applies full damage", resFull.effects[0]?.total === 10, `total=${resFull.effects[0]?.total}`);
      t("save-contract", "pass applies HALF damage", resHalf.effects[0]?.total === 5, `total=${resHalf.effects[0]?.total}`);

      // Resistance halves after the save-half (RAW ordering): 10 → 5 → 2.
      const resistActor = { system: { traits: { dr: { value: ["poison"] } } } };
      const resBoth = { effects: [] };
      await PostHitSaves._rollAndApplySaveDamage({ formula: "10", damageType: "poison" }, resistActor, stubItem, resBoth, { half: true });
      t("save-contract", "half then resistance stacks (10→5→2)", resBoth.effects[0]?.total === 2, `total=${resBoth.effects[0]?.total}`);

      // Entry override: the brain's postHitSave beats the parser.
      const netEntry = RulesBrain.lookup(fakeItem("Net", "", { type: "weapon" }))?.entry;
      t("save-contract", "weapon onHit contract intact (Net → restrained)",
        netEntry?.onHit?.[0]?.type === "condition" && netEntry.onHit[0].condition === "restrained");
    } catch (err) { t("save-contract", "suite crashed", false, err?.message ?? String(err)); }

    // ═════════════════════════════════════════════════════════════════════
    //  SUITE 7 — Attack-multi volley (Eldritch Blast / Scorching Ray laws)
    // ═════════════════════════════════════════════════════════════════════
    try {
      const eb = ATTACK_MULTI_SPELLS["eldritch blast"];
      t("volley", "EB beam law: 1 / 2@5 / 3@11 / 4@17",
        eb?.countResolver(0, 1) === 1 && eb?.countResolver(0, 5) === 2
        && eb?.countResolver(0, 11) === 3 && eb?.countResolver(0, 17) === 4,
        `L1=${eb?.countResolver(0, 1)} L5=${eb?.countResolver(0, 5)} L11=${eb?.countResolver(0, 11)} L17=${eb?.countResolver(0, 17)}`);
      t("volley", "EB beams ignore slot level (cantrip)",
        eb?.countResolver(3, 5) === 2, `castL3@charL5=${eb?.countResolver(3, 5)}`);

      const sr = ATTACK_MULTI_SPELLS["scorching ray"];
      t("volley", "Scorching Ray: 3 rays @L2, +1 per slot above",
        sr?.countResolver(2) === 3 && sr?.countResolver(3) === 4 && sr?.countResolver(5) === 6,
        `L2=${sr?.countResolver(2)} L3=${sr?.countResolver(3)} L5=${sr?.countResolver(5)}`);

      const vErrs = validateAllAttackMultiSpells();
      t("volley", "attack-multi registry validates clean", vErrs.length === 0, vErrs.join("; "));

      t("volley", "crit bake: 1d10 × 3 units = 3d10",
        DamageResolver._scaleFormulaToUnits("1d10", 3) === "3d10",
        DamageResolver._scaleFormulaToUnits("1d10", 3));
      t("volley", "crit bake: 2d6 × 3 units = 6d6",
        DamageResolver._scaleFormulaToUnits("2d6", 3) === "6d6",
        DamageResolver._scaleFormulaToUnits("2d6", 3));
      t("volley", "resolver + volley card exist",
        typeof DamageResolver.runAttackMulti === "function"
        && typeof DamageResolver._postVolleyCard === "function"
        && typeof DamageResolver._rollUnitAttack === "function");

      // Purple-picker distribution laws (round-robin, pick order front-loaded)
      const A = { id: "A" }, B = { id: "B" }, C = { id: "C" };
      const d1 = DamageResolver._distributeUnits([A], 3);
      const d2 = DamageResolver._distributeUnits([A, B], 3);
      const d3 = DamageResolver._distributeUnits([A, B, C], 2);
      t("volley", "beam split: 1 target × 3 units = all 3 on it", d1.get(A) === 3 && d1.size === 1);
      t("volley", "beam split: 2 targets × 3 units = 2/1 front-loaded", d2.get(A) === 2 && d2.get(B) === 1);
      t("volley", "beam split: 3 targets × 2 units = first two picked", d3.get(A) === 1 && d3.get(B) === 1 && !d3.has(C));
      t("volley", "beam split: empty/zero → empty map",
        DamageResolver._distributeUnits([], 3).size === 0 && DamageResolver._distributeUnits([A], 0).size === 0);
    } catch (err) { t("volley", "suite crashed", false, err?.message ?? String(err)); }

    // ═════════════════════════════════════════════════════════════════════
    //  SUITE 8 — Hearing gate ("must hear you" spells vs the deafened)
    // ═════════════════════════════════════════════════════════════════════
    try {
      t("hearing", "Vicious Mockery requires hearing (decorated name too)",
        !!HearingGate.requiresTargetHearing({ name: "Vicious Mockery" })
        && !!HearingGate.requiresTargetHearing({ name: "Vicious Mockery (Recharge 5-6)" }));
      t("hearing", "Suggestion / Command / Dissonant Whispers gated",
        !!HearingGate.requiresTargetHearing({ name: "Suggestion" })
        && !!HearingGate.requiresTargetHearing({ name: "Command" })
        && !!HearingGate.requiresTargetHearing({ name: "Dissonant Whispers" }));
      t("hearing", "Fire Bolt / Power Word Kill NOT gated (no clause)",
        !HearingGate.requiresTargetHearing({ name: "Fire Bolt" })
        && !HearingGate.requiresTargetHearing({ name: "Power Word Kill" }));

      const deafActor = { statuses: new Set(["deafened"]) };
      const hearActor = { statuses: new Set(["prone"]) };
      t("hearing", "deafened detection (status set)",
        HearingGate.isDeafened({ actor: deafActor }) === true
        && HearingGate.isDeafened({ actor: hearActor }) === false);

      const split = HearingGate.filterDeafTargets(
        { name: "Vicious Mockery" },
        [{ name: "Deaf Goblin", actor: deafActor }, { name: "Hearing Goblin", actor: hearActor }]);
      t("hearing", "filter splits deaf from hearing targets",
        split.blocked.length === 1 && split.allowed.length === 1
        && split.blocked[0].name === "Deaf Goblin", JSON.stringify({ blocked: split.blocked.length, allowed: split.allowed.length }));

      const noGate = HearingGate.filterDeafTargets({ name: "Fire Bolt" }, [{ name: "Deaf Goblin", actor: deafActor }]);
      t("hearing", "ungated spell passes deaf targets through",
        noGate.entry === null && noGate.allowed.length === 1 && noGate.blocked.length === 0);
    } catch (err) { t("hearing", "suite crashed", false, err?.message ?? String(err)); }

    // ═════════════════════════════════════════════════════════════════════
    //  SUITE 9 — THE GATE (ONE_GATE phase 0, 2026-08-06)
    //  Born from a DEAD Specter rolling two saves against Petrifying Gaze and
    //  then being told it was immune to the result. Nothing here touches the
    //  world — these are pure verdicts against hand-built profiles.
    // ═════════════════════════════════════════════════════════════════════
    try {
      // Minimal stand-in for a target profile: only the fields the Gate reads.
      const prof = ({ hp = 10, pc = false, conds = [], immune = [] }) => ({
        isPC: pc,
        hp: { value: hp, max: 10, temp: 0 },
        hasCondition(id) { return conds.includes(String(id).toLowerCase()); },
        immuneToCondition(id) { return immune.includes(String(id).toLowerCase()); },
        get isDead() {
          if (this.hasCondition("dead")) return true;
          if (this.isPC) return false;
          return (Number(this.hp?.value ?? 0) || 0) <= 0;
        },
      });
      const V = (p, o) => SaveEngine._preRollVerdict(p, o);

      // THE SPECTER. 0 HP monster → no die, ever.
      t("gate", "dead NPC (0 HP) does not roll", V(prof({ hp: 0 }))?.reason === "dead");
      t("gate", "NPC marked dead does not roll", V(prof({ hp: 9, conds: ["dead"] }))?.reason === "dead");

      // ⚠️ THE OPPOSITE MISTAKE, guarded just as hard: a downed PC is NOT dead.
      // Gating players on HP would stop a dying party member being healed,
      // affected, or targeted at all — a worse bug than the one being fixed.
      t("gate", "downed PC (0 HP) STILL rolls — unconscious ≠ dead", V(prof({ hp: 0, pc: true })) === null);
      t("gate", "PC marked dead does not roll", V(prof({ hp: 0, pc: true, conds: ["dead"] }))?.reason === "dead");
      t("gate", "healthy creature rolls normally", V(prof({ hp: 10 })) === null);

      // Immunity, decided BEFORE the die rather than announced after it.
      t("gate", "immune to the only outcome → no save",
        V(prof({ immune: ["petrified"] }), { outcomeConditions: ["petrified"] })?.reason === "immune");
      t("gate", "immune to SOME outcomes → still rolls",
        V(prof({ immune: ["petrified"] }), { outcomeConditions: ["petrified", "restrained"] }) === null);
      // A damaging spell still needs the save — it is doing work for half damage.
      t("gate", "immune but the spell deals damage → still rolls",
        V(prof({ immune: ["petrified"] }), { outcomeConditions: ["petrified"], dealsDamage: true }) === null);
      // Never block on a fact we could not read.
      t("gate", "unknown outcomes → rolls (fails open)",
        V(prof({ immune: ["petrified"] }), { outcomeConditions: [] }) === null);
      t("gate", "no profile → rolls (fails open)", V(null) === null);

      // Dead beats immune: the first decisive answer wins, in order.
      t("gate", "dead is decided before immunity",
        V(prof({ hp: 0, immune: ["petrified"] }), { outcomeConditions: ["petrified"] })?.reason === "dead");

      // A gated row must never be mistaken for a failed save downstream —
      // that is how a corpse would collect conditions it never rolled for.
      t("gate", "no-roll row is NOT a failed save",
        SaveEngine._failedTheSave({ passed: false, noRoll: "dead" }) === false);
      t("gate", "pending PC is NOT a failed save",
        SaveEngine._failedTheSave({ passed: false, pending: true }) === false);
      t("gate", "a genuine fail still reads as a failure",
        SaveEngine._failedTheSave({ passed: false }) === true);
    } catch (err) { t("gate", "suite crashed", false, err?.message ?? String(err)); }

    // ═════════════════════════════════════════════════════════════════════
    //  SUITE 6 — Live state (what's actually loaded right now)
    // ═════════════════════════════════════════════════════════════════════
    try {
      t("live", "spell rules present", Object.keys(SPELL_RULES).length >= 17, `${Object.keys(SPELL_RULES).length} entries`);
      t("live", "weapon rules present", Object.keys(WEAPON_RULES).length >= 2, `${Object.keys(WEAPON_RULES).length} entries`);
      t("live", "condition visuals engine loaded", typeof ConditionVisuals?.sync === "function");
      const chain = ConditionVisuals?._chainTex;
      t("live", "chain strip texture state known", chain !== undefined, chain ? `loaded ${chain.width}×${chain.height}` : "absent (drawn-link fallback)");
      t("live", "silence entry stamps deafened", SPELL_RULES["silence"]?.space?.stampInside?.[0] === "deafened");
      t("live", "hunger of hadar stamps blinded", SPELL_RULES["hunger of hadar"]?.space?.stampInside?.[0] === "blinded");
      t("live", "tricksy entry present (the fey)", SPELL_RULES["tricksy"]?.space?.kind === "magicalDarkness");
    } catch (err) { t("live", "suite crashed", false, err?.message ?? String(err)); }

    // ═════════════════════════════════════════════════════════════════════
    //  SUITE 7 — Counterspell native-cleanup origin matcher (regression)
    //  Guards the summon/template kill-list logic so a countered Summon Fey
    //  can never silently start leaking its creature again. Side-effect-free:
    //  saves + restores the live kill-list.
    // ═════════════════════════════════════════════════════════════════════
    try {
      const { ReactionEngine } = await import("../reaction-engine.mjs");
      const saved = ReactionEngine._counterspelledCasts;
      ReactionEngine._counterspelledCasts = [];
      ReactionEngine._markCastCounterspelled({
        uuid: "Actor.aaa.Item.bbb.Activity.ccc",
        item: { uuid: "Actor.aaa.Item.bbb", actor: { name: "SelfTest" } },
      });
      t("counterspell", "matches summoned-token origin (item uuid)",
        ReactionEngine._isCounterspelledOrigin("Actor.aaa.Item.bbb") === true);
      t("counterspell", "matches template origin (activity uuid)",
        ReactionEngine._isCounterspelledOrigin("Actor.aaa.Item.bbb.Activity.ccc") === true);
      t("counterspell", "ignores an unrelated origin",
        ReactionEngine._isCounterspelledOrigin("Actor.zzz.Item.qqq") === false);
      ReactionEngine._counterspelledCasts = [{ itemUuid: "X", activityUuid: "Y", expiresAt: Date.now() - 1 }];
      t("counterspell", "prunes an expired counterspelled cast",
        ReactionEngine._isCounterspelledOrigin("X") === false);
      ReactionEngine._counterspelledCasts = Array.isArray(saved) ? saved : [];
    } catch (err) { t("counterspell", "suite crashed", false, err?.message ?? String(err)); }

    // ═════════════════════════════════════════════════════════════════════
    //  Scorecard
    // ═════════════════════════════════════════════════════════════════════
    const passed = results.filter(r => r.pass).length;
    const failed = results.length - passed;
    const bySuite = {};
    for (const r of results) {
      bySuite[r.suite] ??= { pass: 0, fail: 0 };
      bySuite[r.suite][r.pass ? "pass" : "fail"]++;
    }

    console.log(`${MODULE_ID} | ═══ RULES ENGINE SELF-TEST ═══ ${passed}/${results.length} passed${failed ? ` — ${failed} FAILING` : " — ALL CLEAR"}`);
    console.table(results.map(r => ({ Suite: r.suite, Test: r.name, Result: r.pass ? "PASS" : "✗ FAIL", Detail: r.detail.slice(0, 80) })));

    if (!quiet) {
      try {
        const suiteRows = Object.entries(bySuite).map(([s, c]) =>
          `<div style="display:flex;justify-content:space-between;"><span>${s}</span><span style="color:${c.fail ? "#e05c5c" : "#7ec97e"};font-weight:700;">${c.pass}/${c.pass + c.fail}</span></div>`).join("");
        const failRows = results.filter(r => !r.pass).map(r =>
          `<div style="color:#e05c5c;font-size:12px;">✗ [${r.suite}] ${foundry.utils.escapeHTML(r.name)}${r.detail ? ` — ${foundry.utils.escapeHTML(r.detail.slice(0, 90))}` : ""}</div>`).join("");
        await ChatMessage.create({
          whisper: ChatMessage.getWhisperRecipients?.("GM") ?? [],
          content: `
            <div style="border:1px solid #c9a76b;border-radius:6px;padding:8px 10px;background:#141118;color:#e8dcc3;font-size:14px;">
              <div style="font-weight:700;color:#c9a76b;"><i class="fas fa-clipboard-check"></i> Rules Engine Self-Test — ${passed}/${results.length} ${failed ? `<span style="color:#e05c5c;">(${failed} failing)</span>` : '<span style="color:#7ec97e;">ALL CLEAR</span>'}</div>
              <div style="margin:6px 0 2px;">${suiteRows}</div>
              ${failRows}
              <div style="font-size:11px;color:#9c8f74;margin-top:4px;">Every live-fire bug is a permanent regression test here. Full detail in the console table.</div>
            </div>`,
          flags: { [MODULE_ID]: { selfTestReport: true } },
        });
      } catch (_) { /* chat is best-effort; the console table always prints */ }
    }

    return { passed, failed, results };
  }
}
