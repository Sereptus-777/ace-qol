// ─── ACE: QOL — The Resolver ─────────────────────────────────────────────────
//
// THE PIECE THAT PUTS THE DEXTERITY BEHIND THE RAPIER.
//
// Four profiles report facts. None of them can resolve a swing on its own: the
// rapier knows it is finesse and does not know whose hand it is in; the fighter
// knows their Strength and Dexterity and does not know which one this weapon
// wants. The answer belongs to the PAIRING, and until now there was nowhere to
// put it — so every pipeline worked it out again, differently.
//
// Johnny, 2026-08-25:
//
//   "I guess the biggest thing that we're missing is the Resolver. That puts it
//    all together. That puts the dexterity behind the rapier attack. That puts
//    how much damage is gonna happen... Everything has to be read before any
//    dice hit the canvas."
//
// ═══ THE DIVISION OF LABOUR ══════════════════════════════════════════════════
//
//   PROFILES report.  They never decide.   `exhaustion: 3, edition: "2014"`
//   THE RESOLVER decides. It never rolls.  `disadvantage, because exhaustion 3`
//   THE PIPELINE rolls.  It never decides. It is handed a plan and executes it.
//
// ⚠️ ALL THREE JOBS USED TO BE SMEARED ACROSS THE PIPELINES, which is how a
// fact got read correctly and used by nobody: Aura of Warding written and read
// by nothing, Uncanny Dodge declared and never consulted, `canAct` computed
// since July while a dead Specter rolled twice.
//
// ⚠️ IT ROLLS NOTHING. Not one die. If a function here ever needs a random
// number, the design has gone wrong — the whole point is that the plan is
// settled and inspectable BEFORE anything is thrown.
//
// ⚠️ EVERY ANSWER CARRIES ITS REASON. Not `abilityMod: 4` but `ability: "dex",
// abilityMod: 4, because: "finesse — DEX +4 beats STR +2"`. A number without
// its reason cannot be argued with at a table, and a GM overruling ACE needs to
// know what ACE thought it was doing.
// ──────────────────────────────────────────────────────────────────────────────

/** Ability keys in the order a tie should break. */
const ABILITY_LABEL = { str: "STR", dex: "DEX", con: "CON", int: "INT", wis: "WIS", cha: "CHA" };

/**
 * Which ability does THIS attack use in THIS creature's hands?
 *
 * ⚠️🔴 THE QUESTION NEITHER PROFILE CAN ANSWER ALONE. The rapier reports
 * `finesse: true` and `abilityRequested: null`. The fighter reports STR +2 and
 * DEX +4. Only here do those become "+4, because finesse takes the better one".
 *
 * Order, and every rung says why:
 *   1. The activity names an ability outright — a Battle Smith's INT, a
 *      Hexblade's CHA. An explicit override beats every rule below.
 *   2. Finesse — the better of Strength and Dexterity. RAW in both editions.
 *   3. A spell attack — the caster's own spellcasting ability.
 *   4. Ranged weapon — Dexterity.
 *   5. Melee weapon — Strength.
 *   6. Nothing else fits — Strength, and it says the choice was a fallback.
 */
export function resolveAbility(attack, attacker) {
  const mod = (k) => Number(attacker?.abilityMod?.(k) ?? 0) || 0;
  const say = (key, because, extra = {}) => ({
    ability: key,
    abilityMod: mod(key),
    because,
    ...extra,
  });

  // ── ⚠️🔴 ASK THE SYSTEM FIRST. IT ALREADY DID THIS WORK. ────────────
  //
  // `activity.ability` is not a raw setting — it is dnd5e's COMPUTED answer.
  // Read its getter: an explicit override wins, "spellcasting" resolves to the
  // caster's ability, and otherwise it takes whichever of the AVAILABLE
  // abilities has the larger modifier. That last branch IS the finesse rule,
  // implemented by the system, tested by the system, and correct for Battle
  // Smiths, Hexblades, thrown weapons and everything else.
  //
  // ⚠️ RE-DERIVING IT HERE WOULD BE THE FIFTH REACH READER. This whole
  // night has been about deleting second implementations of things that already
  // existed. So the system's answer stands, and ACE's job is to EXPLAIN it —
  // and to notice when its own reasoning would have disagreed.
  const systemSaid = attack?.abilitySystemResolved ?? null;
  const available = attack?.abilitiesAvailable ?? [];

  // ACE's own reasoning, computed either way so the two can be compared.
  const aceSaid = _aceWouldChoose(attack, attacker, mod);

  // ── ⚠️🔴 dnd5e DOES NOT KNOW ABOUT PACT OF THE BLADE ────────────
  //
  // `availableAbilities` is built from the WEAPON — finesse exposes {str,dex},
  // a plain longsword exposes {str}. A warlock's Charisma is nowhere in it,
  // because Pact of the Blade and Hex Warrior are CHARACTER features that dnd5e
  // does not model. Deferring to the system alone would hand a CHA 20 warlock
  // their Strength modifier and call it resolved.
  //
  // ACE already owns that rule — `AttackAbilityResolver`, written 2026-07-09
  // after exactly this bug: a warlock/paladin swinging the Blood Halberd at
  // +1 STR with CHA 20 on the sheet. It is a CHARACTER-level rule, not an item
  // stamp, so it survives picking up a new weapon.
  //
  // ⚠️ IT ONLY WINS WHEN IT IS BETTER. RAW says the warlock "can use"
  // Charisma, not "must", and nobody chooses the worse modifier. Below the
  // threshold the system's answer stands.
  //
  // ⚠️ AND IT IS ASKED HERE, NOT AFTER. The pipeline used to apply this
  // override AFTER deriving the ability, which meant the resolver's stated
  // reason said "a melee weapon attack, STR" while the roll actually used CHA.
  // The number was right and the explanation was a lie.
  const override = _pactOverride(attack, attacker);
  if (override && override.mod > mod(systemSaid ?? aceSaid.ability)) {
    const beat = systemSaid ?? aceSaid.ability;
    return say(override.ability,
      `${override.why} — ${ABILITY_LABEL[override.ability]} `
      + `${override.mod >= 0 ? "+" : ""}${override.mod} beats `
      + `${ABILITY_LABEL[beat]} ${mod(beat) >= 0 ? "+" : ""}${mod(beat)}`,
      { overrodeSystem: true });
  }

  if (systemSaid && ABILITY_LABEL[systemSaid]) {
    let because;
    if (attack?.abilityOverride) {
      because = `the item overrides to ${ABILITY_LABEL[systemSaid]}`;
    } else if (attack?.finesse && available.length > 1) {
      const other = available.find(a => a !== systemSaid);
      because = `finesse — ${ABILITY_LABEL[systemSaid]} ${mod(systemSaid) >= 0 ? "+" : ""}${mod(systemSaid)}`
        + (other ? ` beats ${ABILITY_LABEL[other]} ${mod(other) >= 0 ? "+" : ""}${mod(other)}` : "");
    } else if (attack?.isSpell || attack?.attackKind === "msak" || attack?.attackKind === "rsak") {
      because = `a spell attack, cast with ${ABILITY_LABEL[systemSaid]}`;
    } else {
      because = `dnd5e resolved this attack to ${ABILITY_LABEL[systemSaid]}`;
    }

    // ⚠️ A DISAGREEMENT IS REPORTED, NEVER SILENTLY RESOLVED. If ACE's own
    // ladder would have picked something else, that is worth knowing — either
    // the item is odd or one of the two is wrong, and both are worth a look.
    const extra = (aceSaid.ability !== systemSaid)
      ? { disagreement: `ACE would have chosen ${ABILITY_LABEL[aceSaid.ability]} (${aceSaid.because})` }
      : {};
    return say(systemSaid, because, extra);
  }

  // The system had nothing to say — an old activity shape, or a bare item.
  // ACE's ladder answers, and says that it had to.
  return say(aceSaid.ability, `${aceSaid.because} (dnd5e resolved no ability for this attack)`);
}

/**
 * The character-level ability rule ACE already owns — Pact of the Blade and
 * Hex Warrior.
 *
 * ⚠️ RESOLVED LAZILY AND DEFENSIVELY. The resolver is a leaf that a bench
 * runs outside Foundry; a hard import of a module that reaches into game
 * settings would make it untestable. An injected override (used by the bench)
 * wins, then the real resolver, then nothing.
 */
function _pactOverride(attack, attacker) {
  try {
    // A bench, or a caller that already looked it up, can hand it straight in.
    if (attack?.abilityOverrideRule) return attack.abilityOverrideRule;
    const R = globalThis.game?.aceQol?.attackAbilityResolver
      ?? globalThis.AttackAbilityResolver;
    if (!R?.getOverride) return null;
    return R.getOverride(attacker?.ref, attack?.item) ?? null;
  } catch (_) { return null; }
}

/**
 * ACE's own reasoning about which ability an attack should use.
 *
 * ⚠️ THIS IS THE FALLBACK AND THE CROSS-CHECK, NOT THE PRIMARY. It runs on
 * every attack so the two answers can be compared, but the system's answer is
 * what gets used whenever the system has one.
 */
function _aceWouldChoose(attack, attacker, mod) {
  const asked = attack?.abilityOverride;
  if (asked && ABILITY_LABEL[asked]) {
    return { ability: asked, because: `the item asks for ${ABILITY_LABEL[asked]} outright` };
  }
  if (attack?.finesse) {
    const str = mod("str");
    const dex = mod("dex");
    const key = dex >= str ? "dex" : "str";
    const other = key === "dex" ? "str" : "dex";
    return { ability: key,
      because: `finesse — ${ABILITY_LABEL[key]} ${mod(key) >= 0 ? "+" : ""}${mod(key)} `
        + `beats ${ABILITY_LABEL[other]} ${mod(other) >= 0 ? "+" : ""}${mod(other)}` };
  }
  if (attack?.isSpell || attack?.attackKind === "msak" || attack?.attackKind === "rsak") {
    const sc = attacker?.creature?.spellcasting;
    if (sc && ABILITY_LABEL[sc]) return { ability: sc, because: `a spell attack, cast with ${ABILITY_LABEL[sc]}` };
    return { ability: "cha", because: "a spell attack with no declared spellcasting ability — assuming CHA" };
  }
  if (attack?.attackKind === "rwak") return { ability: "dex", because: "a ranged weapon attack" };
  if (attack?.attackKind === "mwak") return { ability: "str", because: "a melee weapon attack" };
  return { ability: "str", because: "nothing on the attack said which ability to use — defaulted to STR" };
}

/**
 * Does the wielder get their proficiency bonus with this thing?
 *
 * ⚠️ THE ITEM'S OWN BLOCK OUTRANKS THE CATEGORY. Johnny swung a NON-proficient
 * magic battleaxe on 2026-08-13 and the card added his proficiency anyway. If
 * the item says the wielder is not proficient, that is the answer regardless of
 * whether they know martial weapons in general.
 */
export function resolveProficiency(attack, attacker) {
  const prof = Number(attacker?.prof ?? 0) || 0;

  const own = attack?.itemProficiency;
  if (own && own.hasProficiency === false) {
    return { applies: false, bonus: 0, because: "the item itself says this wielder is not proficient" };
  }
  if (own && Number.isFinite(own.flat)) {
    return { applies: own.flat > 0, bonus: own.flat,
      because: `the item declares a flat proficiency of ${own.flat}` };
  }

  const need = attack?.proficiencyRequired;
  if (!need || need === "none") {
    return { applies: true, bonus: prof, because: "no proficiency is required" };
  }
  if (attack?.isSpell) {
    return { applies: true, bonus: prof, because: "a caster is always proficient with their own spells" };
  }

  // Trained with this specific weapon, or with its whole category.
  //
  // ⚠️🔴 dnd5e STORES THE CATEGORIES AS "sim" AND "mar", NOT "simple" AND
  // "martial". `DND5E.weaponProficiencies = { sim, mar }`. Checking for the long
  // words would have matched NOTHING, and every character whose sheet lists only
  // categories — Ireena, Firaxis, Syrax, Ismark — would have silently lost
  // their proficiency bonus on every swing. Caught on 2026-08-26 by reading his
  // actual character data before shipping the change, not after.
  //
  // ⚠️ READ HIS DATA, NOT THE WORD YOU EXPECTED. Jeth's sheet reads
  // [sim, rapier, scimitar, shortsword, whip, handcrossbow, dagger, longbow] —
  // a category AND specific weapons, mixed. Both forms have to match.
  const CATEGORY_KEYS = {
    simple:  ["sim", "simple"],
    martial: ["mar", "martial"],
    natural: ["nat", "natural"],
  };
  const have = attacker?.weaponProficiencies ?? new Set();
  const base = attack?.baseItem;
  if (base && have.has?.(base)) {
    return { applies: true, bonus: prof, because: `trained with ${base} specifically` };
  }
  const keys = CATEGORY_KEYS[need] ?? [need];
  const matched = keys.find(k => have.has?.(k));
  if (matched) {
    return { applies: true, bonus: prof, because: `trained with ${need} weapons ("${matched}")` };
  }
  if (!have.size) {
    // ⚠️ AN EMPTY TRAIT LIST IS NOT A STATEMENT THAT THEY KNOW NOTHING. Most
    // monsters carry no proficiency traits at all and are obviously proficient
    // with their own claws. Refusing the bonus here would nerf every NPC in the
    // game. Fail toward the creature and say which way we fell.
    return { applies: true, bonus: prof,
      because: "this creature lists no weapon proficiencies at all — assumed proficient with its own gear" };
  }
  return { applies: false, bonus: 0, because: `not trained with ${base ?? need}` };
}

/**
 * Does this weapon's mastery actually apply?
 *
 * ⚠️ TWO FACTS FROM TWO PROFILES, AND ONE OF THEM WAS NEVER READ. The weapon
 * declares what it offers; the creature carries the set of weapons it has
 * trained mastery with. dnd5e keys that on the BASE ITEM ("rapier"), not on the
 * mastery name, because RAW you learn mastery WITH A WEAPON.
 *
 * ⚠️ AND IT IS A 2024 RULE. On a 2014 table it does not exist, no matter what
 * the item carries — imported items routinely have mastery fields the table
 * never agreed to.
 */
export function resolveMastery(attack, attacker) {
  const offered = attack?.masteryDeclared ?? null;
  if (!offered) return { applies: false, mastery: null, because: "this weapon offers no mastery" };

  if (attacker?.edition !== "2024") {
    return { applies: false, mastery: offered,
      because: `weapon mastery is a 2024 rule and this table is on ${attacker?.edition ?? "2014"}` };
  }

  const trained = attacker?.masteryWeapons ?? new Set();
  const base = attack?.baseItem;
  if (!base) {
    return { applies: false, mastery: offered,
      because: "the weapon has no base type, so mastery training cannot be matched" };
  }
  if (trained.has?.(base)) {
    return { applies: true, mastery: offered, because: `trained in mastery with ${base}` };
  }
  return { applies: false, mastery: offered,
    because: `offers ${offered}, but this creature has not trained mastery with ${base}` };
}

/**
 * Can this go ahead at all?
 *
 * ⚠️ EVERY REASON IS A SENTENCE A GM CAN READ ALOUD. "blocked: true" tells
 * nobody anything; "Jeth cannot act: unconscious" ends the argument.
 */
export function resolveGate(attack, attacker, environment, target) {
  const refuse = (because) => ({ ok: false, because });

  if (!attacker) return refuse("there is no attacker to act");
  if (!attacker.canAct) return refuse(`${attacker.name} cannot act: ${attacker.cannotActBecause}`);
  if (attacker.gate?.ok === false) return refuse(attacker.gate.reason ?? "this action is not available");

  // ⚠️ SILENCE IS A FACT ABOUT THE SPACE, not about the caster, which is why it
  // is asked of the environment and not of the creature.
  if (attack?.isSpell && environment?.attackerSilenced && attack?.components?.v) {
    return refuse(`${attacker.name} is in a silenced space and this spell needs a verbal component`);
  }

  if (target && target.isDead) {
    return refuse(`${target.name ?? "the target"} is already dead`);
  }

  return { ok: true, because: "nothing stands in the way" };
}

/**
 * Build the whole plan. Reads four profiles, rolls nothing.
 *
 * @param {object} p
 * @param {object} p.attacker      from buildAttackerProfile
 * @param {object} p.attack        from buildAttackProfile
 * @param {object} [p.environment] from buildEnvironmentProfile
 * @param {object} [p.target]      from buildTargetProfile
 * @returns {object} the resolved plan
 */
export function resolveAttack({ attacker, attack, environment = null, target = null } = {}) {
  const notes = [];

  const gate = resolveGate(attack, attacker, environment, target);
  const ability = resolveAbility(attack, attacker);
  const proficiency = resolveProficiency(attack, attacker);
  const mastery = resolveMastery(attack, attacker);

  // ── The attack bonus, itemised ──
  // ⚠️ ITEMISED, NOT TOTALLED. A card that says "+9" starts an argument; a card
  // that says "+4 DEX, +3 proficiency, +2 magic" ends it.
  const parts = [];
  if (attack?.rollsToHit) {
    parts.push({ label: ABILITY_LABEL[ability.ability] ?? ability.ability.toUpperCase(),
                 value: ability.abilityMod, because: ability.because });
    if (proficiency.applies && proficiency.bonus) {
      parts.push({ label: "PROF", value: proficiency.bonus, because: proficiency.because });
    }
    if (attack.magicBonus) {
      parts.push({ label: "MAGIC", value: attack.magicBonus, because: "a magic bonus on the item" });
    }
  }
  const attackBonus = parts.reduce((sum, p) => sum + (Number(p.value) || 0), 0);

  // ── Effective AC ──
  let effectiveAC = null;
  const acParts = [];
  if (target?.ac !== undefined && target?.ac !== null) {
    acParts.push({ label: "AC", value: Number(target.ac) || 0, because: "the target's armour class" });
    if (environment?.coverAcBonus) {
      acParts.push({ label: "COVER", value: environment.coverAcBonus,
                     because: `${environment.coverLevel} between them` });
    }
    effectiveAC = acParts.reduce((s, p) => s + p.value, 0);
  }

  // ── Reach or range, and whether the target is inside it ──
  let inRange = null;
  let rangeBecause = "no target, so nothing was measured";
  if (environment?.distanceFt !== null && environment?.distanceFt !== undefined && attack) {
    const d = environment.distanceFt;
    const isRanged = attack.attackKind === "rwak" || attack.attackKind === "rsak"
      || (attack.rangeLong > 0);
    const limit = isRanged ? (attack.rangeLong || attack.rangeNormal) : attack.reachFt;
    if (limit > 0) {
      inRange = d <= limit;
      rangeBecause = inRange
        ? `${d} ${environment.gridUnits} away, within ${limit}`
        : `${d} ${environment.gridUnits} away, beyond ${limit}`;
      // ⚠️ ELEVATION IS PART OF THE DISTANCE, not a footnote. It is named
      // separately because a GM staring at a flat map cannot see it otherwise.
      if (environment.elevationDeltaFt) {
        rangeBecause += ` (including ${Math.abs(environment.elevationDeltaFt)} `
          + `${environment.gridUnits} of elevation)`;
      }
    } else {
      rangeBecause = "this attack declares no reach or range to measure against";
    }
  }

  // ── How many units, and what governs it ──
  // ⚠️ THE NUMBER THAT COST A CR 21 LICH THREE BEAMS. The count belongs to the
  // attack; the level it depends on belongs to the attacker. Neither alone.
  let units = { count: 1, because: "one attack" };
  if (attack?.unitCountResolver) {
    try {
      const n = Number(attack.unitCountResolver(attacker)) || 1;
      units = { count: n, because: `${n} from the attack's own count rule at caster level `
        + `${attacker?.casterLevel ?? "?"} (${attacker?.casterLevelSource ?? "unknown source"})` };
    } catch (err) { notes.push(`could not work out the unit count: ${err?.message ?? err}`); }
  }

  // ── What the target will do to the damage ──
  const damageAgainstTarget = [];
  if (target && attack?.damageParts?.length) {
    for (const part of attack.damageParts) {
      const type = part.types?.[0] ?? "";
      let treatment = "full";
      let because = `${target.name ?? "the target"} has no special defence against ${type || "this"}`;
      try {
        if (type && target.creature?.di?.has?.(type)) { treatment = "immune"; because = `immune to ${type}`; }
        else if (type && target.creature?.dv?.has?.(type)) { treatment = "vulnerable"; because = `vulnerable to ${type}`; }
        else if (type && target.creature?.dr?.has?.(type)) {
          treatment = "resistant";
          because = `resistant to ${type}`;
          // ⚠️ RESISTANCE CAN BE BYPASSED, and the weapon is what bypasses it.
          if (attack.magical) because += ", but this attack is magical — check whether that bypasses it";
        }
      } catch (err) { notes.push(`could not read the target's defences: ${err?.message ?? err}`); }
      damageAgainstTarget.push({ type, treatment, because });
    }
  }

  // ── Upcast options, bounded by what this caster can actually afford ──
  // ⚠️ THE ATTACK KNOWS WHAT UPCASTING CHANGES; THE ATTACKER KNOWS WHAT THEY
  // CAN PAY FOR. Offering a 5th-level slot to somebody who has none is the same
  // class of nonsense as asking which piston to fire.
  const upcast = [];
  if (attack?.isSpell && !attack.isCantrip && attack.consumesSpellSlot) {
    try {
      const base = attack.spellLevel ?? 1;
      for (const [key, slot] of Object.entries(attacker?.resources?.spellSlots ?? {})) {
        const lvl = Number(slot?.level ?? (/^spell(\d)$/.exec(key)?.[1])) || 0;
        if (lvl >= base && Number(slot?.value ?? 0) > 0) {
          upcast.push({ level: lvl, slotsLeft: Number(slot.value) || 0 });
        }
      }
      upcast.sort((a, b) => a.level - b.level);
    } catch (err) { notes.push(`could not read spell slots: ${err?.message ?? err}`); }
  }

  return {
    kind: "resolved-attack",
    schema: 1,

    ok: gate.ok,
    because: gate.because,

    ability: ability.ability,
    abilityMod: ability.abilityMod,
    abilityBecause: ability.because,
    // ⚠️ SURFACED ON THE PLAN, not buried inside the ability object, because a
    // caller that has to go digging for a warning will not print it.
    abilityDisagreement: ability.disagreement ?? null,
    abilityOverrodeSystem: !!ability.overrodeSystem,

    proficiencyApplies: proficiency.applies,
    proficiencyBonus: proficiency.bonus,
    proficiencyBecause: proficiency.because,

    masteryApplies: mastery.applies,
    mastery: mastery.mastery,
    masteryBecause: mastery.because,

    attackBonus,
    attackBonusParts: parts,

    effectiveAC,
    acParts,

    inRange,
    rangeBecause,

    units,
    damageParts: attack?.damageParts ?? [],
    damageSource: attack?.damageSource ?? null,
    damageAgainstTarget,

    saveAbility: attack?.saveAbility ?? null,
    saveDC: attack?.saveDCFlat || null,

    consumesSpellSlot: !!attack?.consumesSpellSlot,
    consumption: attack?.consumptionTargets ?? [],
    upcastOptions: upcast,

    // Anything the resolver could not work out. Never silently empty.
    notes,

    // The four it read, for anything downstream that wants to look further.
    profiles: { attacker, attack, environment, target },
  };
}

/**
 * One line a human can read — the whole plan, before any dice.
 */
export function describeResolution(r) {
  if (!r) return "(nothing resolved)";
  if (!r.ok) return `REFUSED: ${r.because}`;

  const bits = [];
  if (r.attackBonusParts.length) {
    bits.push("+" + r.attackBonus + " to hit ("
      + r.attackBonusParts.map(p => `${p.value >= 0 ? "+" : ""}${p.value} ${p.label}`).join(", ") + ")");
  }
  bits.push(`${r.ability.toUpperCase()} because ${r.abilityBecause}`);
  if (r.effectiveAC !== null) bits.push(`vs AC ${r.effectiveAC}`);
  if (r.inRange === false) bits.push(`OUT OF RANGE — ${r.rangeBecause}`);
  else if (r.inRange === true) bits.push(r.rangeBecause);
  if (r.units.count > 1) bits.push(`${r.units.count} units — ${r.units.because}`);
  if (r.masteryApplies) bits.push(`mastery ${r.mastery} applies`);
  else if (r.mastery) bits.push(`${r.mastery} does not apply: ${r.masteryBecause}`);
  for (const d of r.damageAgainstTarget) {
    if (d.treatment !== "full") bits.push(`${d.type}: ${d.treatment} — ${d.because}`);
  }
  if (r.upcastOptions.length > 1) {
    bits.push(`can upcast to level ${r.upcastOptions.map(u => u.level).join("/")}`);
  }
  if (r.notes.length) bits.push(`NOTES: ${r.notes.join("; ")}`);
  return bits.join(" · ");
}
