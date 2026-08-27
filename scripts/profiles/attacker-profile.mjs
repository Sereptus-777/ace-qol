// ─── ACE: QOL — Attacker Profile (the attacker third of THE ONE GATE) ─────────
//
// THE formalized "who is acting, with what" snapshot. This is the stable,
// documented vocabulary every rules-engine layer speaks — the rules brain,
// the sight evaluator, the interceptor audit, and the executors all read THIS
// shape instead of poking at raw actor/item internals.
//
// ⚠️🔴 2026-08-25 — WHY THIS FILE GREW INSTEAD OF A NEW ONE APPEARING BESIDE IT.
// I started writing a second attacker profile under `scripts/gate/` without
// looking here first. This file has existed since 2026-07-28. That is exactly
// the mistake Johnny caught on 08-11: "we have a damage pipeline, why did you
// have to build a whole new chat card?" Two profiles means two answers to
// "is he prone", and the day they disagree is a bug nobody can find. The new
// readers were folded IN; the second file was deleted.
//
// ⚠️🔴 AND WHY IT NEEDED TO GROW. Until today this profile carried a `gate`
// (from `CombatContext.canAct`), a full creature snapshot with every condition,
// the edition, and the action's components — and the attack pipeline asked it
// for exactly THREE things: proficiency and two ability modifiers. Everything
// else was assembled on every single attack and thrown away. `canAct` in
// particular has been computed since July and consulted by nothing, which is
// how a DEAD SPECTER rolled two saving throws on 2026-08-06.
//
// Johnny, 2026-08-25: "When I push a button, a whole block of code should read
// the attacker's profile, everything about them, and all the conditions...
// before anything happens."
//
// DESIGN CONTRACT:
//   • PURE + READ-ONLY. Building a profile never mutates anything, never
//     rolls anything, never writes a flag. It only LOOKS.
//   • IT REPORTS, IT DOES NOT DECIDE. `exhaustion: 3` and `edition: "2014"`,
//     never `disadvantage: true` — baking one edition's answer in here is how
//     a 2024 rule leaks into a 2014 table.
//   • NO NEW RULES LOGIC. Every field is assembled from the proven readers —
//     Situation.readCreature (creature snapshot), CombatContext (gates,
//     components), CombatState (edition). This file formalizes their OUTPUT.
//   • NO SECOND COPY. Anything the creature snapshot already knows is exposed
//     as an accessor over it, never duplicated as plain data. One source means
//     the attacker and target profiles can never drift apart on the same fact.
//   • NULL-SAFE. A missing actor/item yields a minimal-but-valid profile.
//   • IT SAYS WHAT IT COULD NOT READ. `problems[]` is never silently empty —
//     a reader that fails records why, so "it checked" and "it tried to check"
//     can never look the same in the log.
//
// Fields: identity → edition → creature → action → gates → economy →
//         resources → projected auras → position.
// ──────────────────────────────────────────────────────────────────────────────

import { CombatState } from "../combat-state.mjs";
import { CombatContext } from "../combat-context.mjs";
import { Situation } from "../situation.mjs";
import { hasTurns } from "../action-economy.mjs";
import { resolveReach } from "../reach-reader.mjs";

/**
 * Auras a creature projects onto OTHER creatures around it.
 *
 * ⚠️🔴 THE LEVEL GATE IS THE WHOLE POINT. Feraxis Greenbeard is a 9th-level
 * paladin and his Aura of Warding had never once halved spell damage for
 * anyone standing beside him — one write, zero readers. And Cyrix, a 2nd-level
 * paladin with seven Warlock levels, was handed a full Aura of Protection on
 * every save, because the code read CHARACTER level instead of PALADIN level.
 * Both bugs live here now, gated, in one table.
 *
 * ⚠️ RADIUS IS A FUNCTION OF LEVEL, not a constant — both paladin auras go
 * from 10 feet to 30 feet at 18th level, in both editions.
 */
const PROJECTED_AURAS = [
  {
    key: "auraOfProtection",
    feature: "Aura of Protection",
    className: "paladin",
    minLevel: 6,
    radius: (lvl) => (lvl >= 18 ? 30 : 10),
    ability: "cha",
    grants: "a bonus to saving throws equal to the paladin's Charisma modifier",
  },
  {
    key: "auraOfWarding",
    feature: "Aura of Warding",
    className: "paladin",
    minLevel: 7,
    radius: (lvl) => (lvl >= 18 ? 30 : 10),
    ability: null,
    grants: "resistance to damage from spells",
  },
  {
    key: "auraOfCourage",
    feature: "Aura of Courage",
    className: "paladin",
    minLevel: 10,
    radius: (lvl) => (lvl >= 18 ? 30 : 10),
    ability: null,
    grants: "immunity to the frightened condition",
  },
  {
    key: "auraOfHate",
    feature: "Aura of Hate",
    className: null,             // a monster feature — no class gate
    minLevel: 0,
    radius: () => 10,
    ability: "cha",
    grants: "a bonus to melee damage equal to the source's Charisma modifier",
  },
];

/** Does this creature own a feature by name? */
function _hasFeature(actor, name) {
  try {
    const want = String(name).toLowerCase();
    return (actor.items ?? []).some(i =>
      i.type === "feat" && String(i.name ?? "").toLowerCase().includes(want));
  } catch (_) { return false; }
}

/** One of ACE's own per-turn flags, read without throwing. */
function _flag(actor, key) {
  try { return actor.getFlag?.("ace-qol", key); } catch (_) { return undefined; }
}

/**
 * What level of spellcaster is this creature?
 *
 * ⚠️🔴 A CR 21 LICH FIRED ONE BEAM OF ELDRITCH BLAST BECAUSE OF THIS.
 * Every field ACE looked at came back empty on Johnny's Lich:
 *
 *     details.level        undefined
 *     details.spellLevel   undefined
 *     attributes.spell     { level: 0 }
 *     cr                   21
 *
 * It read 0, the caller defaulted it to 1, and the beam table returned one
 * beam. A 21-CR spellcaster threw a single dart at a Flameskull, silently.
 *
 * ⚠️ AN EMPTY FIELD IS A QUESTION, NOT AN ANSWER. Johnny, 2026-08-25, on
 * the reach reader: "we were making some real progress with reading the
 * description, getting the values from the right places, having fallbacks...
 * That was really giving me hope." Same ladder here. Each rung says which one
 * answered, so a GM can see WHY a monster is casting at the level it is.
 *
 * The ladder, in order of how much it actually knows:
 *   1. A PC's own class levels    — exact
 *   2. The NPC's declared caster level fields — exact when the import set them
 *   3. The HIGHEST SPELL SLOT the creature owns — a 9th-level slot means an
 *      17th+ level caster; this is RAW's own table read backwards
 *   4. Challenge rating — a rough but honest floor for a monster
 *
 * ⚠️ RUNG 3 BEFORE RUNG 4, DELIBERATELY. Slots are what the statblock
 * actually grants; CR is a difficulty rating that happens to correlate.
 *
 * @returns {{level:number, source:string}}
 */
function _casterLevel(actor, classLevels, characterLevel) {
  const sys = actor?.system ?? {};

  // 1. A PC casts at their character level.
  if (actor?.type === "character" && characterLevel > 0) {
    return { level: characterLevel, source: "the character's own levels" };
  }

  // 2. Whatever the statblock or the importer declared.
  const declared = Number(
    sys.details?.spellLevel
    ?? sys.attributes?.spell?.level
    ?? sys.details?.level
    ?? 0
  ) || 0;
  if (declared > 0) return { level: declared, source: "the creature's declared caster level" };

  // 3. Read the slots backwards. Slot level N first appears at caster level:
  //    1st@1  2nd@3  3rd@5  4th@7  5th@9  6th@11  7th@13  8th@15  9th@17
  try {
    const MIN_LEVEL_FOR_SLOT = { 1: 1, 2: 3, 3: 5, 4: 7, 5: 9, 6: 11, 7: 13, 8: 15, 9: 17 };
    let best = 0;
    for (const [key, slot] of Object.entries(sys.spells ?? {})) {
      if (!(Number(slot?.max ?? 0) > 0)) continue;
      const m = /^spell(\d)$/.exec(key);
      const lvl = m ? Number(m[1]) : Number(slot?.level ?? 0) || 0;
      if (MIN_LEVEL_FOR_SLOT[lvl] > best) best = MIN_LEVEL_FOR_SLOT[lvl];
    }
    if (best > 0) {
      return { level: best, source: `the highest spell slot it owns (level ${
        Object.entries(MIN_LEVEL_FOR_SLOT).find(([, v]) => v === best)?.[0]})` };
    }
  } catch (_) { /* no slots is normal for a warrior */ }

  // 4. Challenge rating, as a floor. Rough, and it says so.
  // ⚠️ ONLY WHEN IT ROUNDS TO A REAL LEVEL. A CR 1/4 goblin rounds to zero,
  // and crediting "challenge rating" for an answer of 0 is the same small lie
  // as reporting a range as a reach: the number is right, the explanation
  // sends the reader somewhere that did not decide anything.
  const cr = Number(sys.details?.cr ?? 0) || 0;
  const fromCr = Math.round(cr);
  if (fromCr >= 1) return { level: fromCr, source: `its challenge rating (${cr}), as a rough floor` };

  return { level: 0, source: "nothing on this creature says what level it casts at" };
}

/** Levels PER CLASS, lowercased — `{ paladin: 2, warlock: 7 }`. */
function _classLevels(actor) {
  const out = {};
  try {
    for (const it of actor.items ?? []) {
      if (it.type !== "class") continue;
      const key = String(it.name ?? "").toLowerCase().trim();
      if (key) out[key] = Number(it.system?.levels ?? 0) || 0;
    }
  } catch (_) { /* a monster with no class items is normal */ }
  return out;
}

/**
 * Build the attacker-side profile for one action.
 *
 * @param {Actor5e} actor              the acting creature
 * @param {object}  opts
 * @param {Token|TokenDocument} [opts.token]     acting token (resolved if omitted)
 * @param {Item5e}  [opts.item]                  the weapon / spell / feature being used
 * @param {Activity} [opts.activity]             the dnd5e activity (when available)
 * @returns {object|null} the AttackerProfile, or null when there is no actor
 */
export function buildAttackerProfile(actor, { token = null, item = null, activity = null } = {}) {
  if (!actor) return null;

  const problems = [];

  // ── creature snapshot — the proven reader owns this ──
  // ⚠️ DO NOT REIMPLEMENT THIS. `Situation.readCreature` already exposes ~32
  // fields and is the reader the target side uses too.
  let creature = {};
  try {
    creature = Situation.readCreature(actor, token) ?? {};
  } catch (err) {
    problems.push(`could not read the creature: ${err?.message ?? err}`);
  }
  const resolvedToken = creature.token ?? token ?? null;
  const tokenDoc = resolvedToken?.document ?? resolvedToken ?? null;

  // ── edition — actor-aware (ACE override → dnd5e setting → marker sniff) ──
  let edition = "2014";
  try { edition = CombatState.getActiveEdition(actor) ?? "2014"; } catch (err) {
    problems.push(`could not resolve the edition: ${err?.message ?? err}`);
  }

  // ── ⚠️🔴 THE ATTACK USED TO LIVE HERE, AND IT DOES NOT ANY MORE ──
  //
  // Thirty-two fields describing the BUTTON sat inside this profile under
  // `action` — reach, finesse, mastery, which ability it wants. Those are
  // facts about a rapier, and they were being reported as facts about the
  // creature holding it. The console line read
  //
  //     Lich (Legacy): conditions: concentrating · reach 120 feet · in combat
  //
  // which is two subjects in one sentence, and a 120-foot cantrip does not
  // have "reach" at all.
  //
  // Johnny, 2026-08-25: "There are two separate things here: the attack and
  // the attacker. The attacker profile should be separate from the attack
  // profile." They are `profiles/attack-profile.mjs` and this file now.
  //
  // ⚠️ THIS PROFILE STILL TAKES `item` AND `activity`, and deliberately so.
  // Two answers here genuinely depend on what is being used — whether the
  // creature may take THIS action at all (a silenced caster, no free hand),
  // and whether the item is equipped. Everything else about the button now
  // belongs to the attack profile.

  // ── hard gates — CAN this creature act at all? (shared brain) ──
  let gate = { ok: true };
  try {
    gate = CombatContext.canAct(actor, {
      isSpell: item?.type === "spell",
      item,
      activationType: activity?.activation?.type ?? item?.system?.activation?.type ?? "action",
    }) ?? { ok: true };
  } catch (err) {
    problems.push(`could not run the action gate: ${err?.message ?? err}`);
  }

  // ── liveness — the question nothing was asking ──
  // ⚠️ TWO SEPARATE GATES, AND BOTH MATTER. The creature snapshot answers
  // "is this thing alive and conscious"; the shared brain answers "may it take
  // THIS action right now" (silenced caster, no free hand, incapacitated).
  // A dead Specter passes neither, and passed both unasked for months.
  const aliveAndAware = creature.canAct !== false;
  const canAct = aliveAndAware && gate.ok !== false;
  let cannotActBecause = "";
  if (!aliveAndAware) cannotActBecause = creature.cantActBecause || "unable to act";
  else if (gate.ok === false) cannotActBecause = gate.reason || gate.why || "cannot take this action";

  // ── action economy ──
  // ⚠️ NO TURNS, NO ACTION ECONOMY. Outside combat there are no turns, so none
  // of this applies — the rule that had a caster locked out of Sacred Flame
  // because a per-turn flag was never cleared (2026-08-24).
  let isTheirTurn = false;
  try {
    const combat = game.combat;
    isTheirTurn = !!combat?.started && combat.combatant?.actor?.id === actor.id;
  } catch (_) { /* no combat is a normal state, not a failure */ }

  const economy = {
    hasTurns: (() => { try { return hasTurns(actor); } catch (_) { return false; } })(),
    isTheirTurn,
    reactionUsed: !!_flag(actor, "reactionUsed"),
    bonusActionUsed: !!_flag(actor, "bonusActionUsed"),
    freeInteractionUsed: !!_flag(actor, "freeInteractionUsed"),
  };

  // ── resources this action might spend ──
  const resources = { spellSlots: {}, itemUses: null, concentratingOn: null };
  try {
    for (const [key, slot] of Object.entries(actor.system?.spells ?? {})) {
      const max = Number(slot?.max ?? 0) || 0;
      if (!max) continue;
      resources.spellSlots[key] = {
        value: Number(slot?.value ?? 0) || 0,
        max,
        level: Number(slot?.level ?? 0) || 0,
      };
    }
  } catch (err) { problems.push(`could not read spell slots: ${err?.message ?? err}`); }

  try {
    const uses = item?.system?.uses;
    if (uses && Number(uses.max) > 0) {
      resources.itemUses = {
        value: Number(uses.value ?? 0) || 0,
        max: Number(uses.max) || 0,
        spent: Number(uses.spent ?? 0) || 0,
      };
    }
  } catch (err) { problems.push(`could not read item uses: ${err?.message ?? err}`); }

  // What a new concentration spell would break.
  //
  // ⚠️🔴 `concentration.items` IS A SET, NOT A COLLECTION. It has no
  // `.contents`, so reading that gave undefined, the `?? []` turned it into an
  // empty list, and this field was ALWAYS null. The profile happily reported
  // "concentrating" from the condition while being unable to say on what —
  // Johnny's Lich was holding Storm Sphere on screen and the Gate line named
  // nothing. Exactly the Set-versus-Array trap that hid damage immunities.
  //
  // ⚠️ AND THE EFFECT IS THE FALLBACK. dnd5e can only name the ITEM when the
  // concentration effect carries its flag; on an imported NPC it often does
  // not. The effect's own name is still the truth on screen, so it is better
  // than reporting nothing.
  try {
    const conc = actor.concentration ?? null;
    const items = conc?.items ? [...conc.items] : [];
    if (items.length) {
      resources.concentratingOn = items[0]?.name ?? "something";
    } else {
      const effs = conc?.effects ? [...conc.effects] : [];
      resources.concentratingOn = effs.length ? (effs[0]?.name ?? "something") : null;
    }
  } catch (err) {
    problems.push(`could not read concentration: ${err?.message ?? err}`);
  }

  // ── auras this creature projects onto everyone else ──
  const classLevels = _classLevels(actor);
  const _charLevel = Object.values(classLevels).reduce((a, b) => a + b, 0)
    || Number(actor.system?.details?.level ?? 0) || 0;
  const _caster = _casterLevel(actor, classLevels, _charLevel);
  const projectedAuras = [];
  try {
    // An unconscious or incapacitated paladin projects nothing.
    const suppressed = !canAct
      || (creature.conditions?.has?.("unconscious") ?? false)
      || (creature.conditions?.has?.("incapacitated") ?? false);

    for (const spec of PROJECTED_AURAS) {
      if (!_hasFeature(actor, spec.feature)) continue;
      const lvl = spec.className ? (classLevels[spec.className] ?? 0) : 0;
      if (spec.className && lvl < spec.minLevel) continue;

      projectedAuras.push({
        key: spec.key,
        feature: spec.feature,
        radiusFt: spec.radius(lvl),
        grants: spec.grants,
        amount: spec.ability
          ? (Number(actor.system?.abilities?.[spec.ability]?.mod ?? 0) || 0)
          : 0,
        suppressed,
        suppressedBecause: suppressed ? (cannotActBecause || "unconscious or incapacitated") : "",
        sourceActorId: actor.id ?? null,
        sourceTokenId: tokenDoc?.id ?? null,
      });
    }
  } catch (err) {
    problems.push(`could not read projected auras: ${err?.message ?? err}`);
  }

  return {
    kind: "attacker-profile",
    schema: 2,

    // identity
    actorId: actor.id ?? null,
    actorUuid: actor.uuid ?? null,
    tokenId: tokenDoc?.id ?? null,
    name: creature.name ?? actor.name ?? "Creature",
    isPC: actor.type === "character",
    hasPlayerOwner: !!actor.hasPlayerOwner,
    disposition: tokenDoc?.disposition ?? null,

    // ⚠️ PER CLASS, NOT CHARACTER LEVEL. See PROJECTED_AURAS above for what
    // reading this wrong cost at Johnny's table.
    classLevels,
    characterLevel: Object.values(classLevels).reduce((a, b) => a + b, 0)
      || Number(actor.system?.details?.level ?? 0) || 0,

    // ⚠️🔴 THE NUMBER THAT COST THREE BEAMS. See _casterLevel above.
    casterLevel: _caster.level,
    casterLevelSource: _caster.source,
    cr: Number(actor.system?.details?.cr ?? 0) || 0,

    // ⚠️ WHICH WEAPONS THIS CREATURE HAS MASTERY WITH — a Set of BASE ITEM
    // keys ("rapier", "longsword"), not mastery names. That is how dnd5e stores
    // it and how RAW works: you learn mastery WITH A WEAPON. The attack profile
    // reports what the weapon OFFERS; only together do they mean anything.
    masteryWeapons: (() => {
      try {
        const v = actor.system?.traits?.weaponProf?.mastery?.value;
        return v instanceof Set ? new Set(v) : new Set(v ?? []);
      } catch (_) { return new Set(); }
    })(),
    weaponProficiencies: (() => {
      try {
        const v = actor.system?.traits?.weaponProf?.value;
        return v instanceof Set ? new Set(v) : new Set(v ?? []);
      } catch (_) { return new Set(); }
    })(),
    armorProficiencies: (() => {
      try {
        const v = actor.system?.traits?.armorProf?.value;
        return v instanceof Set ? new Set(v) : new Set(v ?? []);
      } catch (_) { return new Set(); }
    })(),

    // The players who should be prompted about this creature's choices.
    ownerUserIds: (() => {
      try {
        return (game.users?.contents ?? [])
          .filter(u => !u.isGM && actor.testUserPermission?.(u, "OWNER"))
          .map(u => u.id);
      } catch (_) { return []; }
    })(),

    // rules context
    edition,                                          // "2014" | "2024"

    // live references (same-client consumers only — NOT serializable)
    ref: actor,
    token: resolvedToken,

    // the full creature snapshot (conditions, senses incl. devilsSight,
    // speeds, defenses, concentration) — Situation.readCreature's shape
    creature,

    // can they even do it
    gate,
    canAct,
    cannotActBecause,

    // what the turn allows
    economy,

    // what this action would spend
    resources,

    // what this creature does for everyone near it
    projectedAuras,

    // where they are
    position: {
      elevationFt: Number(tokenDoc?.elevation ?? 0) || 0,
      gridWidth: Number(tokenDoc?.width ?? 1) || 1,
      gridHeight: Number(tokenDoc?.height ?? 1) || 1,
      hidden: !!tokenDoc?.hidden,
    },

    // ⚠️ NEVER SILENTLY EMPTY. Anything a reader could not answer is named
    // here, so a pipeline running blind says so instead of looking healthy.
    problems,

    // ── THE NUMBERS PIPELINES ACTUALLY ASK FOR (2026-07-28) ──
    // Ability modifiers, proficiency, HP, size, type and exhaustion all come
    // from the creature snapshot — ONE source, so attacker and target profiles
    // can never drift apart on the same fact. Everything below is an accessor
    // over `creature`; there is deliberately no second copy of the data here.

    /** Ability modifier. */
    abilityMod(key) { return Number(creature.abilities?.[String(key ?? "").toLowerCase()]?.mod ?? 0) || 0; },
    /** Raw ability score (for DCs computed off the score, not the mod). */
    abilityScore(key) { return Number(creature.abilities?.[String(key ?? "").toLowerCase()]?.score ?? 10) || 10; },
    /** Proficiency bonus. */
    get prof() { return Number(creature.prof ?? 0) || 0; },
    /**
     * Exhaustion LEVEL — never an answer about advantage.
     * ⚠️ TWO DIFFERENT RULES. 2014: six levels, disadvantage on attacks from
     * level 3. 2024: ten levels, a flat penalty on every d20. Read this
     * alongside `edition` and apply the right one at the point of use.
     */
    get exhaustion() { return Number(creature.exhaustion ?? 0) || 0; },
    /** Size key ("tiny"|"sm"|"med"|"lg"|"huge"|"grg"). */
    get size() { return String(creature.size ?? "med"); },
    /** Creature type ("undead", "construct", …). */
    get creatureType() { return String(creature.type ?? ""); },
    /** Armour proficiencies, as a Set. */
    get armorProf() { return creature.armorProf ?? new Set(); },
    /** Current / max / temp hit points. */
    get hitPoints() { return creature.hp ?? { value: 0, max: 0, temp: 0 }; },
    /** Every condition on this creature right now, as a Set. */
    get conditions() { return creature.conditions ?? new Set(); },
    /** Does this creature have a condition right now? */
    hasCondition(id) {
      const s = String(id ?? "").toLowerCase();
      const c = creature.conditions ?? [];
      return (c.includes?.(s) ?? false) || (c.has?.(s) ?? false);
    },
    // ⚠️🔴 selfAttackDisadvantage WAS HERE AND IS DELIBERATELY GONE.
    //
    // It returned a bare boolean for "does this creature's own state impose
    // disadvantage on its attacks". CombatState already answers that question
    // properly: blinded, poisoned, frightened, restrained, prone, the 2014
    // exhaustion cascade and Sunlight Sensitivity, each with the REASON
    // attached so the card can say why.
    //
    // Two answers to one question is worse than one answer. A boolean sitting
    // beside a fully reasoned implementation invites the next person to read
    // the boolean, and they lose every reason in the process - and if the two
    // ever disagree, nothing says which is right. CombatState.assess owns
    // advantage and disadvantage. Ask it.
  };
}

/**
 * One line a human can read, for the console.
 *
 * ⚠️ THIS IS HOW "DID IT CHECK THE AURA?" GETS ANSWERED IN ONE LINE instead of
 * by me reading code and guessing, which is what the whole of 24 August was.
 * Johnny's definition of done: you name a thing on the sheet, and I show you
 * the line where the pipeline read it.
 *
 * @param {object} p a profile from buildAttackerProfile
 * @returns {string}
 */
export function describeAttacker(p) {
  if (!p) return "(no attacker profile)";
  const bits = [];
  if (!p.canAct) bits.push(`CANNOT ACT (${p.cannotActBecause})`);
  const conds = [...(p.conditions ?? [])].filter(Boolean);
  if (conds.length) bits.push(`conditions: ${conds.join(", ")}`);
  if (p.exhaustion) bits.push(`exhaustion ${p.exhaustion} (${p.edition} rules)`);

  // ⚠️🔴 THE ATTACKER DOES NOT SPEAK FOR THE WEAPON. Reach, mastery and
  // "not equipped" were printed here, which is how a Lich ended up claiming a
  // cantrip's 120-foot range as its own reach. Those live on the attack
  // profile and print on its own line now. What follows is the creature.
  if (p.casterLevel) bits.push(`caster level ${p.casterLevel}`);
  if (p.masteryWeapons?.size) bits.push(`mastery trained: ${[...p.masteryWeapons].join(", ")}`);
  if (p.resources?.concentratingOn) bits.push(`concentrating on ${p.resources.concentratingOn}`);
  bits.push(p.economy?.hasTurns ? (p.economy.isTheirTurn ? "their turn" : "in combat") : "no turns");
  if (p.economy?.reactionUsed) bits.push("reaction spent");
  if (p.projectedAuras?.length) {
    bits.push("projects " + p.projectedAuras
      .map(a => `${a.feature} ${a.radiusFt} feet${a.suppressed ? " (SUPPRESSED)" : ""}`)
      .join(" + "));
  }
  if (p.problems?.length) bits.push(`PROBLEMS: ${p.problems.join("; ")}`);
  return `${p.name}: ${bits.join(" · ")}`;
}
