// ─── ACE: QOL — Attack Profile (the SECOND third of THE ONE GATE) ────────────
//
// THE BUTTON THAT WAS PUSHED. Everything this action is, on its own terms,
// true whether or not anybody is holding it.
//
// ⚠️🔴 WHY THIS FILE EXISTS. Until 2026-08-26 there was one profile and the
// attack lived INSIDE it, under `action` — 32 fields describing a rapier
// reported as facts about the creature holding it. The console line read
//
//     Lich (Legacy): conditions: concentrating · reach 120 feet · in combat
//
// which is two subjects spliced into one sentence. Johnny, 2026-08-25:
//
//   "There are two separate things here: the attack and the attacker. The
//    attacker profile should be full of information about the attacker. On the
//    other hand, the button that was pushed should have its own profile so we
//    know the range and all the stuff about the attack. The attack itself has
//    to know what the attacker profile is, so they can therefore use that
//    information for the attack itself."
//
// DESIGN CONTRACT — the same three rules the whole Gate runs on:
//   • IT REPORTS, IT DOES NOT DECIDE. `finesse: true` and `abilityRequested:
//     null`, never `ability: "dex"`. Which ability actually gets used is a
//     question about the CREATURE, and only the resolver may answer it.
//   • IT ASKS, IT DOES NOT ASSUME. `masteryDeclared` is what the weapon
//     OFFERS. Whether the wielder has trained with it is the attacker's fact.
//   • IT SAYS WHERE EVERY NUMBER CAME FROM. `reachSource` exists because
//     "5 feet because the item says so" and "5 feet because nothing said anything"
//     are different facts, and printing them alike hid a bug for months.
//
// ⚠️ ASK THE ACTIVITY, NEVER JUST THE ITEM. An item is a container; what it
// does lives in its activities. Reading `item.type` alone gets a dragon's
// Breath Weapon wrong, and in dnd5e 5.x the action type, the range and the
// damage all moved onto the activity.
//
// ⚠️ FALLBACK CHAINS ARE THE POINT, NOT A WORKAROUND. Johnny, 2026-08-25:
// "we were making some real progress with reading the description, getting the
// values from the right places, having fallbacks... That was really giving me
// hope." Reach already falls back to the statblock text. Damage does too now.
// Every fallback records which rung of the ladder answered.
// ──────────────────────────────────────────────────────────────────────────────

import { resolveReach } from "../reach-reader.mjs";
import { CombatContext } from "../combat-context.mjs";
import { WeaponMasteries } from "../weapon-masteries.mjs";

/** Activation types dnd5e itself marks as "not an action a person takes". */
function _isMachinery(type) {
  try { return !!CONFIG.DND5E?.activityActivationTypes?.[type]?.passive; }
  catch (_) { return false; }
}

/**
 * Damage parts, normalised, from the activity first and the item second.
 *
 * ⚠️ THE SHAPE CHANGED AND BOTH ARE STILL IN THE WILD. dnd5e 5.x stores a part
 * as `{number, denomination, bonus, types:Set}`; older data stores a `[formula,
 * type]` pair. An imported item can carry either. Reading only one silently
 * reports zero damage for the other, which looks exactly like a weapon that
 * does no damage.
 */
function _readDamageParts(activity, sys, problems) {
  const out = [];
  const push = (p) => { if (p) out.push(p); };

  try {
    const parts = activity?.damage?.parts ?? sys?.damage?.parts ?? [];
    for (const p of parts) {
      // Modern shape.
      if (p && typeof p === "object" && !Array.isArray(p)) {
        const types = p.types ? [...p.types] : (p.type ? [p.type] : []);
        push({
          number: Number(p.number ?? 0) || 0,
          denomination: Number(p.denomination ?? 0) || 0,
          bonus: String(p.bonus ?? "") || "",
          custom: p.custom?.enabled ? String(p.custom.formula ?? "") : "",
          types,
          scaling: p.scaling ? { mode: p.scaling.mode ?? null, number: Number(p.scaling.number ?? 0) || 0 } : null,
          source: "the activity's damage parts",
        });
        continue;
      }
      // Legacy [formula, type] pair.
      if (Array.isArray(p)) {
        push({
          number: 0, denomination: 0, bonus: "",
          custom: String(p[0] ?? ""),
          types: p[1] ? [String(p[1])] : [],
          scaling: null,
          source: "a legacy damage pair on the item",
        });
      }
    }
  } catch (err) {
    problems.push(`could not read damage parts: ${err?.message ?? err}`);
  }
  return out;
}

/**
 * Pull damage out of an item's own description text, as a last resort.
 *
 * ⚠️ SAME NARROW EXCEPTION THE REACH READER GETS, AND FOR THE SAME REASON.
 * Every dnd5e statblock renders damage as a fixed phrase — "7 (1d8 + 3)
 * piercing damage" — so this reads a NUMBER and a TYPE that sit in a known
 * shape. It is not inferring anything from prose. Reading a description to
 * decide what a creature IS remains a mistake and always will be.
 *
 * ⚠️ IT ONLY RUNS WHEN THE DAMAGE FIELDS ARE EMPTY, and it says so out loud so
 * a GM can fix the item once rather than wonder forever.
 *
 * @returns {Array} parts in the same shape as the real ones, or []
 */
export function damageFromDescription(sys) {
  try {
    const raw = String(sys?.description?.value ?? "");
    if (!raw) return [];
    const text = raw.replace(/<[^>]+>/g, " ").replace(/&nbsp;/gi, " ").replace(/\s+/g, " ");

    // "(1d8 + 3) piercing damage" / "2d6 fire damage" / "(1d10) necrotic"
    const re = /\(?\s*(\d+)d(\d+)\s*(?:([+-])\s*(\d+))?\s*\)?\s*([a-z]+)\s+damage/gi;
    const out = [];
    let m;
    while ((m = re.exec(text)) !== null) {
      const sign = m[3] === "-" ? "-" : "+";
      out.push({
        number: Number(m[1]) || 0,
        denomination: Number(m[2]) || 0,
        bonus: m[4] ? `${sign}${m[4]}` : "",
        custom: "",
        types: [String(m[5]).toLowerCase()],
        scaling: null,
        source: "the item's description",
      });
      if (out.length >= 4) break;   // a statblock line, not an essay
    }
    return out;
  } catch (_) {
    return [];
  }
}

/**
 * Build the attack-side profile for one button push.
 *
 * @param {Item5e}   item                 the weapon / spell / feature
 * @param {Activity} [activity]           the dnd5e activity, when there is one
 * @param {object}   [opts]
 * @param {boolean}  [opts.repairReach]   let the reach reader write back a
 *                                        missing field (the pipeline may; a
 *                                        profile built for inspection may not)
 * @returns {object|null} the AttackProfile, or null when there is no item
 */
export function buildAttackProfile(item, activity = null, { repairReach = false } = {}) {
  if (!item) return null;

  const problems = [];
  const sys = item.system ?? {};

  // ⚠️ RESOLVE THE ACTIVITY ONCE. The item-use path hands us none, and in
  // dnd5e 5.x that means every answer below would come from the wrong place.
  const act = activity ?? sys.activities?.contents?.[0] ?? null;
  if (!activity && act) {
    problems.push("no activity was given; fell back to the item's first activity");
  }

  const props = sys.properties ? new Set(sys.properties) : new Set();
  const rangeSrc = act?.range ?? sys.range ?? {};

  // ── Reach and range, from THE one resolver ──
  let reach = { reachFt: 0, source: "could not be read", units: "ft" };
  try {
    reach = resolveReach(item, act, { repair: repairReach });
  } catch (err) {
    problems.push(`could not resolve reach: ${err?.message ?? err}`);
  }

  // ── Damage, with the description as the last rung ──
  let damageParts = _readDamageParts(act, sys, problems);
  let damageSource = damageParts.length ? damageParts[0].source : "";
  if (!damageParts.length) {
    const described = damageFromDescription(sys);
    if (described.length) {
      damageParts = described;
      damageSource = "the item's description";
      console.log(`ace-qol | "${item.name}" declares no damage, but its description says `
        + described.map(d => `${d.number}d${d.denomination}${d.bonus} ${d.types[0] ?? ""}`).join(" + ")
        + `. Using that.`);
    } else {
      damageSource = "nothing declared any damage";
    }
  }

  // ── Mastery: what the WEAPON offers. Training is the attacker's business. ──
  let masteryDeclared = null;
  try { masteryDeclared = WeaponMasteries.getMasteryFor(item) ?? null; }
  catch (err) { problems.push(`could not read mastery: ${err?.message ?? err}`); }

  const itemType = item.type ?? "";
  const isSpell = itemType === "spell";
  const activationType = act?.activation?.type ?? sys.activation?.type ?? null;

  return {
    kind: "attack-profile",
    schema: 1,

    // ── 1. What it is ────────────────────────────────────────────────────
    item,
    activity: act,
    itemUuid: item.uuid ?? null,
    activityId: act?.id ?? null,
    name: item.name ?? "",
    normalizedName: String(item.name ?? "").toLowerCase().trim(),
    itemType,                                    // weapon | spell | feat | consumable
    baseItem: String(sys.type?.baseItem ?? "") || null,   // "rapier" — masteries key off this
    weaponType: String(sys.type?.value ?? "") || null,    // simpleM | martialR | natural
    isSpell,
    isWeapon: itemType === "weapon",
    activityType: act?.type ?? null,             // attack | save | damage | heal | utility
    activationType,
    activationCost: Number(act?.activation?.value ?? sys.activation?.value ?? 0) || 0,
    // ⚠️ MACHINERY IS NOT A CHOICE. dnd5e marks the sub-activities a spell
    // fires at itself; offering them to a caster is asking which piston to fire.
    isMachinery: _isMachinery(activationType),
    // The item's OWN edition outranks the world's — mixed tables are real.
    sourceRules: String(sys.source?.rules ?? "") || null,

    // ── 2. How it hits ───────────────────────────────────────────────────
    rollsToHit: act?.type === "attack" || !!act?.attack || !!sys.attack?.type,
    attackKind: String(act?.actionType ?? sys.actionType ?? "") || null,   // mwak|rwak|msak|rsak
    // ⚠️ REQUESTED, NOT DECIDED. An explicit override, or null meaning "work it
    // out from the creature" — which is the resolver's job, not ours.
    // ⚠️🔴 TWO DIFFERENT FACTS, AND CONFLATING THEM MAKES A SECOND
    // IMPLEMENTATION OF dnd5e. `attack.ability` is the OVERRIDE a person typed
    // on the item ("none", "spellcasting", or an ability key). `activity.ability`
    // is dnd5e's COMPUTED answer, and it already does the finesse comparison
    // itself: a finesse weapon exposes {str, dex} as available and the system
    // picks whichever modifier is larger.
    //
    // ⚠️ SO ACE MUST NOT RE-DERIVE IT. Working out finesse a second time is
    // exactly the drift this whole night has been about — four reach readers,
    // two attacker profiles. The resolver ASKS the system and supplies the
    // REASON, and only falls back to its own ladder when the system says
    // nothing. When the two disagree, that disagreement gets reported rather
    // than silently picked.
    abilityOverride: (() => {
      let a = act?.attack?.ability ?? sys.attack?.ability ?? sys.ability ?? "";
      if (a instanceof Set || Array.isArray(a)) a = [...a][0] ?? "";
      a = String(a || "");
      return (a && a !== "none") ? a : null;
    })(),
    abilitySystemResolved: (() => {
      try {
        let a = act?.ability ?? "";
        if (a instanceof Set || Array.isArray(a)) a = [...a][0] ?? "";
        return String(a || "") || null;
      } catch (_) { return null; }
    })(),
    // The abilities the system says are even available — {str,dex} on a
    // finesse weapon. Useful for explaining WHY the system chose what it chose.
    abilitiesAvailable: (() => {
      try {
        const av = act?.availableAbilities;
        return av ? [...av] : [];
      } catch (_) { return []; }
    })(),
    magicBonus: Number(sys.magicalBonus ?? 0) || 0,
    proficiencyRequired: (() => {
      const t = String(sys.type?.value ?? "");
      if (itemType === "spell") return "none";
      if (t.startsWith("martial")) return "martial";
      if (t.startsWith("simple")) return "simple";
      if (t === "natural") return "natural";
      return t ? t : "none";
    })(),
    // The item's own proficiency block — a non-proficient magic axe is real.
    itemProficiency: sys.prof && typeof sys.prof === "object"
      ? { hasProficiency: !!sys.prof.hasProficiency, flat: Number(sys.prof.flat) }
      : (sys.proficient === 0 ? { hasProficiency: false, flat: 0 } : null),
    critThreshold: Number(act?.attack?.critical?.threshold ?? sys.critical?.threshold ?? 0) || null,

    // ── 3. How far ───────────────────────────────────────────────────────
    reachFt: reach.reachFt,
    reachSource: reach.source,
    rangeUnits: rangeSrc.units ?? "ft",
    rangeNormal: Number(rangeSrc.value ?? 0) || 0,
    rangeLong: Number(rangeSrc.long ?? 0) || 0,
    isSelfRanged: (rangeSrc.units ?? "") === "self",
    isTouch: (rangeSrc.units ?? "") === "touch",

    // ── 4. Properties ────────────────────────────────────────────────────
    properties: props,
    twoHanded: props.has("two"),
    versatile: props.has("ver"),
    versatileFormula: String(sys.damage?.versatile ?? "") || null,
    finesse: props.has("fin"),
    light: props.has("lgt"),
    heavy: props.has("hvy"),
    thrown: props.has("thr"),
    ammunition: props.has("amm"),
    loading: props.has("lod"),
    reload: Number(sys.type?.reload ?? 0) || 0,
    magical: props.has("mgc"),
    silvered: props.has("sil"),
    adamantine: props.has("ada"),
    hasReachProperty: props.has("rch"),
    masteryDeclared,

    // ── 5. What it does ──────────────────────────────────────────────────
    damageParts,
    damageSource,
    onSave: String(act?.damage?.onSave ?? "") || null,   // half | none | full

    // ── 6. Spell specifics ───────────────────────────────────────────────
    spellLevel: isSpell ? (Number(sys.level ?? 0) || 0) : null,
    isCantrip: isSpell && (Number(sys.level ?? 0) || 0) === 0,
    school: sys.school ?? null,
    components: (() => {
      try { return CombatContext._components(item); }
      catch (err) { problems.push(`could not read components: ${err?.message ?? err}`); return null; }
    })(),
    materialCost: Number(sys.materials?.value ?? 0) || 0,
    materialConsumed: !!sys.materials?.consumed,
    concentration: !!(sys.properties?.has?.("concentration") || sys.duration?.concentration),
    ritual: !!sys.properties?.has?.("ritual"),
    duration: sys.duration ? { value: sys.duration.value ?? null, units: sys.duration.units ?? null } : null,
    saveAbility: (() => {
      let a = act?.save?.ability;
      if (a instanceof Set || Array.isArray(a)) a = [...a][0] ?? "";
      return String(a || "") || null;
    })(),
    saveDCSource: act?.save?.dc?.calculation ?? null,
    saveDCFlat: Number(act?.save?.dc?.value ?? 0) || 0,
    // ⚠️ WHAT UPCASTING CHANGES, not whether it may be upcast. What this caster
    // can actually afford is a question about their slots, and the resolver
    // answers it by asking the attacker.
    scaling: act?.consumption?.scaling
      ? { allowed: !!act.consumption.scaling.allowed, max: String(act.consumption.scaling.max ?? "") || null }
      : null,

    // ── 7. Who and what it can hit ───────────────────────────────────────
    targetKind: act?.target?.affects?.type ?? sys.target?.affects?.type ?? null,
    targetCount: Number(act?.target?.affects?.count ?? sys.target?.affects?.count ?? 0) || 0,
    targetChoice: !!(act?.target?.affects?.choice ?? sys.target?.affects?.choice),
    targetSpecial: String(act?.target?.affects?.special ?? "") || null,
    template: (() => {
      const t = act?.target?.template ?? sys.target?.template ?? null;
      if (!t?.type) return null;
      return {
        type: t.type,                                    // sphere|cone|cube|line|cylinder
        size: Number(t.size ?? 0) || 0,
        width: Number(t.width ?? 0) || 0,
        height: Number(t.height ?? 0) || 0,
        units: t.units ?? "ft",
      };
    })(),
    canTargetSelf: !(act?.target?.affects?.type === "creature"
      && String(act?.target?.affects?.special ?? "").toLowerCase().includes("other")),

    // ── 8. What it costs ─────────────────────────────────────────────────
    consumesSpellSlot: !!act?.consumption?.spellSlot,
    consumptionTargets: (() => {
      try {
        return (act?.consumption?.targets ?? []).map(t => ({
          type: t.type ?? null,                          // itemUses|attribute|material|hitDice
          target: t.target ?? null,
          value: Number(t.value ?? 0) || 0,
        }));
      } catch (_) { return []; }
    })(),

    // ⚠️ NEVER SILENTLY EMPTY. A reader that could not answer says why, so a
    // pipeline running blind announces itself instead of looking healthy.
    problems,
  };
}

/**
 * One line a human can read.
 *
 * ⚠️ THE ATTACK SPEAKS FOR ITSELF AND ONLY ITSELF. It does not mention the
 * creature; that is the attacker's line. Splicing the two is what produced
 * "Lich (Legacy): ... reach 120 feet" and made a 120-foot spell sound like a
 * melee weapon.
 */
export function describeAttack(p) {
  if (!p) return "(no attack profile)";
  const bits = [];

  if (p.activityType) bits.push(p.activityType);
  if (p.attackKind) bits.push(p.attackKind);

  // ⚠️ REACH IS A MELEE WORD. When the number was promoted out of a declared
  // range it is a range, and saying otherwise is how a cantrip got "reach 120".
  const fromRange = /declared range/.test(p.reachSource ?? "");
  if (p.reachFt && !fromRange) bits.push(`reach ${p.reachFt} ${p.rangeUnits}`);
  else if (p.rangeNormal) bits.push(`range ${p.rangeNormal}${p.rangeLong ? `/${p.rangeLong}` : ""} ${p.rangeUnits}`);
  else if (p.isTouch) bits.push("touch");
  else if (p.isSelfRanged) bits.push("self");

  if (p.damageParts.length) {
    bits.push(p.damageParts
      .map(d => `${d.number}d${d.denomination}${d.bonus} ${d.types[0] ?? ""}`.trim())
      .join(" + "));
  }
  if (p.isSpell) bits.push(p.isCantrip ? "cantrip" : `level ${p.spellLevel}`);
  if (p.abilityOverride) bits.push(`overrides to ${p.abilityOverride.toUpperCase()}`);
  else if (p.abilitySystemResolved) bits.push(`uses ${p.abilitySystemResolved.toUpperCase()}`);
  else if (p.finesse) bits.push("finesse (best of STR/DEX)");
  if (p.masteryDeclared) bits.push(`offers ${p.masteryDeclared}`);
  if (p.saveAbility) bits.push(`${p.saveAbility.toUpperCase()} save`);
  if (p.problems.length) bits.push(`PROBLEMS: ${p.problems.join("; ")}`);

  return `${p.name}: ${bits.join(" · ")}`;
}
