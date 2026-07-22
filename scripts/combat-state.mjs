// ─── ACE: QOL — Combat State Assessment Engine (COMPREHENSIVE) ──────────────
// Reads BOTH the attacker AND the target COMPLETELY, cross-references both
// sides, and determines ALL combat modifiers for this specific attack.
//
// This is the intelligence layer — EVERY D&D 5e rule that affects advantage,
// disadvantage, AC, saves, auto-crit, damage, and conditions is checked here.
// ──────────────────────────────────────────────────────────────────────────────

import { MODULE_ID } from "./ace-qol.mjs";
import { ExtendedEffects } from "./extended-effects.mjs";
import { QolSettings } from "./settings.mjs";
import { FlagsEngine } from "./flags-engine.mjs";
import { Situation } from "./situation.mjs";
// Weapon rules entries (Lance etc.) — function-time reads only; cycle inert.
import { RulesBrain } from "./rules/rules-brain.mjs";
import { aceDistanceFt } from "./geometry-utils.mjs";

// ─── Physical damage types (bypass checks) ──────────────────────────────────
const PHYSICAL_TYPES = new Set(["bludgeoning", "piercing", "slashing"]);

export class CombatState {

  // ── Off-hand swing signal (two-weapon fighting) ──
  // The multiattack engine stamps an off-hand swing here right before it fires,
  // so the damage calculator knows to STRIP the base ability mod (RAW: an
  // off-hand attack's damage gets NO ability mod) and the TWF block below knows
  // to RESTORE it only for the Two-Weapon Fighting fighting style (both editions),
  // or the Dual Wielder house-rule toggle.
  // Keyed by item uuid with a short TTL so it can't bleed into a later main-hand
  // swing of the same weapon.
  static _offhandSwings = new Map();
  static markOffhandSwing(uuid) {
    if (uuid) CombatState._offhandSwings.set(uuid, Date.now() + 8000);
  }
  static clearOffhandSwing(uuid) {
    if (uuid) CombatState._offhandSwings.delete(uuid);
  }
  static isOffhandSwing(uuid) {
    if (!uuid) return false;
    const exp = CombatState._offhandSwings.get(uuid);
    if (!exp) return false;
    if (Date.now() > exp) { CombatState._offhandSwings.delete(uuid); return false; }
    return true;
  }

  // Multiattack fumble mark (Johnny's table rule, 2026-07-13): when "Fumble Ends
  // the Turn" fires, the fumble-engine (which sees the d20) marks the fumbler here
  // SYNCHRONOUSLY — the turn-advance runs on a 750ms beat, so this mark is what
  // stops the roller-local multiattack chain from popping the next swing during
  // that beat. Keyed by actor id with a short TTL so a stale mark can't bleed into
  // a later turn. One-shot — consume deletes it.
  static _multiattackFumbles = new Map();
  static markMultiattackFumble(actorId) {
    if (actorId) CombatState._multiattackFumbles.set(actorId, Date.now() + 10000);
  }
  static consumeMultiattackFumble(actorId) {
    if (!actorId) return false;
    const exp = CombatState._multiattackFumbles.get(actorId);
    if (!exp) return false;
    CombatState._multiattackFumbles.delete(actorId);   // one-shot
    return Date.now() <= exp;                            // stale mark → treated as no fumble
  }

  /**
   * Full combat assessment — EVERY rule checked.
   */
  static assess(attackerActor, targetToken, item, opts = {}) {
    const targetActor = targetToken?.actor;
    if (!attackerActor || !targetActor) return null;

    const isSpell = opts.isSpell ?? (item?.type === "spell");
    const actionType = item?.system?.actionType ?? "mwak";
    const itemProps = item?.system?.properties ?? new Set();

    // ── Smart melee/ranged detection ────────────────────────────────────
    // Don't just trust actionType — cross-check weapon type, properties, and range.
    // Catches misconfigured items (e.g., longbow with actionType "mwak").
    //
    // v0.4.22.7: For thrown weapons (spear, javelin, etc.), the call needs
    // attacker-to-target distance to distinguish a melee swing from a throw.
    // We resolve the attacker's token from canvas and pass distance into
    // `_isActuallyRanged`. If no token can be found (off-canvas actor, etc.)
    // the function falls back to its old behavior (treats thrown as melee).
    const attackerToken = opts.attackerToken
                       ?? canvas.tokens?.placeables?.find(t => t.actor?.id === attackerActor.id)
                       ?? null;
    const distanceToTarget = (attackerToken && targetToken)
      ? CombatState._getDistance(attackerToken, targetToken)
      : null;
    const actuallyRanged = CombatState._isActuallyRanged(item, actionType, distanceToTarget);
    const isMelee = opts.isMelee ?? !actuallyRanged;
    const isRanged = !isMelee;

    const damageTypes = opts.damageTypes ?? CombatState._getItemDamageTypes(item);
    const saveAbility = opts.saveAbility ?? null;

    // Collect all advantage/disadvantage sources with reasons
    const advantageSources = [];
    const disadvantageSources = [];
    // Informational notes: rules that ALMOST applied but were cancelled, with
    // the reason. These don't change the adv/dis math — they exist so a "NORMAL"
    // outcome can still explain itself on the card (e.g. the target sees through
    // magical darkness via truesight, so the attacker's darkness gives no edge).
    const situationalNotes = [];

    // ═════════════════════════════════════════════════════════════════════════
    //  ATTACKER STATE
    // ═════════════════════════════════════════════════════════════════════════
    const atkStatuses = CombatState._getStatuses(attackerActor);
    const atkConditions = new Set();

    // ── Attacker Conditions ──────────────────────────────────────────────
    if (atkStatuses.has("blinded") || atkStatuses.has("blind")) {
      atkConditions.add("blinded");
      disadvantageSources.push({ source: "attacker", reason: "Attacker is BLINDED → attack disadvantage" });
    }
    if (atkStatuses.has("poisoned")) {
      atkConditions.add("poisoned");
      disadvantageSources.push({ source: "attacker", reason: "Attacker is POISONED → attack disadvantage" });
    }
    if (atkStatuses.has("frightened")) {
      atkConditions.add("frightened");
      // Only applies if source of fear is visible — we assume it is for now
      disadvantageSources.push({ source: "attacker", reason: "Attacker is FRIGHTENED → attack disadvantage" });
    }
    if (atkStatuses.has("restrained")) {
      atkConditions.add("restrained");
      disadvantageSources.push({ source: "attacker", reason: "Attacker is RESTRAINED → attack disadvantage" });
    }
    if (atkStatuses.has("prone")) {
      atkConditions.add("prone");
      disadvantageSources.push({ source: "attacker", reason: "Attacker is PRONE → attack disadvantage" });
    }
    if (atkStatuses.has("invisible")) {
      atkConditions.add("invisible");
      // RAW: an unseen attacker has advantage — UNLESS the defender can still SEE it
      // (Truesight / See Invisibility / Blindsight / Tremorsense). The senses engine
      // decides; without this, a creature with Truesight wrongly suffered the penalty.
      const defenderSees = Situation.canSee(targetActor, attackerActor, {
        viewerToken: targetToken, subjectToken: attackerToken, distanceFt: distanceToTarget,
      });
      if (!defenderSees.canSee) {
        advantageSources.push({ source: "attacker", reason: "Attacker is INVISIBLE (unseen) → attack advantage" });
      } else {
        Situation.narrate([`${targetActor?.name} sees the invisible ${attackerActor?.name} (${defenderSees.why}) → no advantage`], { context: "attack" });
      }
    }

    // NOTE: Sunlight Sensitivity disadvantage (attacks + ability checks while in
    // a sunlight zone) is imposed by a real "Sunlight Sensitivity" Active Effect
    // applied by HolySymbol while a sensitive creature stands in the light. That
    // effect sets flags.ace-qol.disadvantage.attack.all, which the Effect/Flags
    // check below already detects — so no special-case is needed here.

    // ── Exhaustion (edition-aware) ───────────────────────────────────────
    // 2014 RAW: 6-level cascading model — at L3+ attacker has disadvantage
    //           on attack rolls. ACE QOL applies that directly here.
    // 2024 RAW: 10-level flat -N penalty model — the dnd5e system applies
    //           its own per-level d20 penalty via addRollExhaustion. ACE QOL
    //           must NOT stack 2014-style disadvantage on top in 2024 worlds.
    const exhaustion = attackerActor.system?.attributes?.exhaustion ?? 0;
    if (exhaustion >= 3 && CombatState.getActiveEdition(attackerActor) === "2014") {
      disadvantageSources.push({ source: "attacker", reason: `Attacker EXHAUSTION ${exhaustion} (2014 L3+) → attack disadvantage` });
    }

    // ── Reckless Attack (Barbarian) ─────────────────────────────────────
    const reckless = attackerActor.getFlag(MODULE_ID, "recklessAttack")
                  || atkStatuses.has("reckless");
    if (reckless && isMelee) {
      advantageSources.push({ source: "attacker", reason: "RECKLESS ATTACK → melee advantage (enemies get advantage back)" });
    }

    // ── Pack Tactics ────────────────────────────────────────────────────
    if (CombatState._hasFeature(attackerActor, "Pack Tactics")) {
      if (CombatState._isAllyNearTarget(attackerActor, targetToken, 5)) {
        advantageSources.push({ source: "attacker", reason: "PACK TACTICS → ally within 5ft of target" });
      }
    }

    // ── Flanking (optional rule, line-through method) ────────────────────
    try {
      if (isMelee && QolSettings.get("flanking")) {
        const flankAlly = CombatState._isFlanking(attackerActor, targetToken);
        if (flankAlly) {
          advantageSources.push({
            source: "attacker",
            reason: `FLANKING → ${flankAlly} on opposite side of target`,
          });
        }
      }
    } catch { /* setting not registered yet */ }

    // ── Ranged attack within 5ft of a hostile → disadvantage (PHB 195) ───
    // RAW: "You have disadvantage on a ranged attack roll if you are within
    // 5 feet of a hostile creature who can see you and who isn't
    // incapacitated."
    try {
      if (isRanged && QolSettings.get?.("rangedInMeleeDisadvantage")) {
        if (CombatState._hasHostileWithinReach(attackerActor, 5)) {
          disadvantageSources.push({
            source: "attacker",
            reason: "RANGED IN MELEE → hostile within 5ft (PHB 195)",
          });
        }
      }
    } catch { /* setting not registered yet */ }

    // ── Hidden attacker → advantage (PHB 195, ace-qol StealthEngine) ─────
    // If the attacker is hidden from this target, gain advantage.
    try {
      const StealthEngine = game.aceQol?.StealthEngine;
      const attackerToken = attackerActor.getActiveTokens?.()?.[0];
      if (StealthEngine?.attackerHiddenFromTarget?.(attackerToken, targetToken)) {
        advantageSources.push({
          source: "attacker",
          reason: "HIDDEN → unseen attacker (PHB 195)",
        });
      }
    } catch { /* StealthEngine not loaded yet */ }

    // ── Advantage/Disadvantage from Active Effects + Flags ───────────────
    const atkType = actionType;
    if (FlagsEngine.hasAttackAdvantage(attackerActor, atkType)
     || ExtendedEffects.hasAdvantage(attackerActor, "attack", atkType)
     || ExtendedEffects.hasAdvantage(attackerActor, "attack", "all")) {
      advantageSources.push({ source: "attacker", reason: "Effect/feature grants attack advantage" });
    }
    if (FlagsEngine.hasAttackDisadvantage(attackerActor, atkType)
     || ExtendedEffects.hasDisadvantage(attackerActor, "attack", atkType)
     || ExtendedEffects.hasDisadvantage(attackerActor, "attack", "all")) {
      disadvantageSources.push({ source: "attacker", reason: "Effect/feature grants attack disadvantage" });
    }

    // ── Grants from target flags (target grants advantage/disadvantage) ──
    if (FlagsEngine.grantsAttackAdvantage(targetActor, atkType)) {
      advantageSources.push({ source: "target", reason: "Target grants attack advantage (flag)" });
    }
    if (FlagsEngine.grantsAttackDisadvantage(targetActor, atkType)) {
      disadvantageSources.push({ source: "target", reason: "Target grants attack disadvantage (flag)" });
    }

    // ── Vex mastery — attacker has Advantage on next attack vs the same target ──
    try {
      const vex = attackerActor.getFlag?.(MODULE_ID, "vex");
      if (vex && typeof vex === "object" && vex.targetUuid) {
        const tgtUuid = targetToken?.document?.uuid ?? targetToken?.uuid;
        if (tgtUuid && tgtUuid === vex.targetUuid) {
          advantageSources.push({ source: "attacker", reason: "VEX (weapon mastery) → advantage on next attack vs this target" });
          // Consume — Vex is "next attack only"
          attackerActor.unsetFlag(MODULE_ID, "vex").catch(() => {});
        }
      }
    } catch (_) { /* non-fatal */ }

    // ── Crusher crit — Advantage on attacks vs the cursed target (edition-aware) ──
    // Flag lives on the TARGET. byUuid is the Crusher's actor uuid.
    // 2014 Tasha's: advantage applies to attacks by OTHER creatures — the
    //   Crusher's own follow-up swings do NOT get advantage on the cursed target.
    // 2024 PHB: advantage applies to ALL attackers including the Crusher.
    try {
      const crusherDebuff = targetActor?.getFlag?.(MODULE_ID, "crusherCritDebuff");
      if (crusherDebuff && typeof crusherDebuff === "object") {
        const crusherEdition = CombatState.getActiveEdition(attackerActor);
        const attackerIsCrusher = attackerActor?.uuid && crusherDebuff.byUuid && attackerActor.uuid === crusherDebuff.byUuid;
        // 2014 carve-out: skip advantage for the Crusher's own attacks.
        const skipAdv = crusherEdition === "2014" && attackerIsCrusher;
        if (!skipAdv) {
          advantageSources.push({ source: "target", reason: `CRUSHER CRIT (${crusherEdition}) → attack advantage vs this target` });
        }
      }
    } catch (_) { /* non-fatal */ }

    // ── Slasher crit — Disadvantage on attacks (edition-aware carve-out) ──
    // Flag lives on the ATTACKER (the original target of the slasher's crit).
    // exceptUuid is the slasher's actor uuid.
    // 2014 Tasha's: BLANKET disadvantage on attack rolls — no carve-out;
    //   the target is at disadvantage attacking the slasher as well.
    // 2024 PHB: carve-out applies — disadvantage on attacks vs anyone EXCEPT
    //   the slasher.
    try {
      const slasherDebuff = attackerActor?.getFlag?.(MODULE_ID, "slasherCritDebuff");
      if (slasherDebuff && typeof slasherDebuff === "object") {
        const slasherEdition = CombatState.getActiveEdition(attackerActor);
        const exceptUuid = slasherDebuff.exceptUuid;
        const isTargetingSlasher = exceptUuid && targetActor?.uuid && exceptUuid === targetActor.uuid;
        // 2014 = always push disadvantage. 2024 = skip when targeting the slasher.
        if (slasherEdition === "2014" || !isTargetingSlasher) {
          const carveOutText = slasherEdition === "2014" ? "" : " (vs anyone except the slasher)";
          disadvantageSources.push({ source: "attacker", reason: `SLASHER CRIT (${slasherEdition}) → disadvantage on attack rolls${carveOutText}` });
        }
      }
    } catch (_) { /* non-fatal */ }

    // ── Sap mastery — target Sapped → its attack has disadvantage ──
    try {
      const sapped = attackerActor.getFlag?.(MODULE_ID, "sapped");
      if (sapped && typeof sapped === "object") {
        disadvantageSources.push({ source: "attacker", reason: "SAPPED (weapon mastery) → disadvantage on this attack roll" });
        // Consume — Sap is "next attack only"
        attackerActor.unsetFlag(MODULE_ID, "sapped").catch(() => {});
      }
    } catch (_) { /* non-fatal */ }

    // ── Heavy Weapon + Small Creature ───────────────────────────────────
    const atkSize = attackerActor.system?.traits?.size ?? attackerActor.system?.details?.size ?? "medium";
    if (["tiny", "sm"].includes(atkSize) && itemProps.has("hvy")) {
      disadvantageSources.push({ source: "attacker", reason: "SMALL CREATURE + HEAVY WEAPON → attack disadvantage" });
    }

    // ── Non-proficient Armor (v0.7.5) ───────────────────────────────────
    // RAW (PHB p.144 / 2024 PHB equivalent): "If you wear armor that you
    // lack proficiency with, you have disadvantage on any ability check,
    // saving throw, or attack roll that involves Strength or Dexterity,
    // and you can't cast spells." We apply the attack-roll piece here.
    // STR/DEX save + ability-check disadvantage and spell-cast blocking
    // would live in their own pipelines (save-engine + spell flow) and
    // are not yet implemented — flagged in roadmap.
    //
    // Gated to PCs (actor.type === "character"). NPCs almost never have
    // populated `armorProf` arrays — applying the "lacks proficiency"
    // gate to monsters would give every armored bear/goblin/giant
    // disadvantage on every attack, which is plainly wrong.
    if (attackerActor.type === "character") {
      // dnd5e 5.x stores armor item type as a long-form string and
      // armorProf entries as short-form keys. Map between them.
      const ARMOR_TYPE_TO_PROF = { light: "lgt", medium: "med", heavy: "hvy" };
      // Find equipped body armor (shields excluded — separate ruleset).
      let equippedArmor = null;
      try {
        equippedArmor = attackerActor.items?.find?.(it =>
          it.type === "equipment"
          && it.system?.equipped === true
          && ARMOR_TYPE_TO_PROF[it.system?.armor?.type]
        ) ?? null;
      } catch (_) { /* defensive — never break combat-state on a malformed item */ }
      if (equippedArmor) {
        const profKey = ARMOR_TYPE_TO_PROF[equippedArmor.system.armor.type];
        const profs = attackerActor.system?.traits?.armorProf?.value;
        const hasProf = (profs?.has?.(profKey) === true)
                     || (Array.isArray(profs) && profs.includes(profKey));
        if (!hasProf) {
          disadvantageSources.push({
            source: "attacker",
            reason: `UNPROFICIENT ARMOR (${equippedArmor.name}) → STR/DEX attacks have disadvantage (RAW PHB p.144)`,
          });
        }
      }
    }


    // ═════════════════════════════════════════════════════════════════════════
    //  TARGET STATE
    // ═════════════════════════════════════════════════════════════════════════
    const tgtStatuses = CombatState._getStatuses(targetActor, targetToken);
    const tgtSys = targetActor.system ?? {};
    const tgtTraits = tgtSys.traits ?? {};
    const tgtAttrs = tgtSys.attributes ?? {};
    const tgtDetails = tgtSys.details ?? {};
    const tgtConditions = new Set();

    // ── Target Conditions → Attack Modifiers ─────────────────────────────

    // PRONE
    if (tgtStatuses.has("prone")) {
      tgtConditions.add("prone");
      if (isMelee) {
        advantageSources.push({ source: "target", reason: "Target is PRONE → melee attack advantage" });
      } else {
        disadvantageSources.push({ source: "target", reason: "Target is PRONE → ranged attack disadvantage" });
      }
    }

    // RESTRAINED
    if (tgtStatuses.has("restrained")) {
      tgtConditions.add("restrained");
      advantageSources.push({ source: "target", reason: "Target is RESTRAINED → attack advantage" });
    }

    // PARALYZED
    if (tgtStatuses.has("paralyzed")) {
      tgtConditions.add("paralyzed");
      advantageSources.push({ source: "target", reason: "Target is PARALYZED → attack advantage" });
    }

    // STUNNED
    if (tgtStatuses.has("stunned")) {
      tgtConditions.add("stunned");
      advantageSources.push({ source: "target", reason: "Target is STUNNED → attack advantage" });
    }

    // UNCONSCIOUS
    if (tgtStatuses.has("unconscious")) {
      tgtConditions.add("unconscious");
      advantageSources.push({ source: "target", reason: "Target is UNCONSCIOUS → attack advantage" });
    }

    // BLINDED
    if (tgtStatuses.has("blinded") || tgtStatuses.has("blind")) {
      tgtConditions.add("blinded");
      advantageSources.push({ source: "target", reason: "Target is BLINDED → attack advantage" });
    }

    // INVISIBLE — disadvantage to attack a creature you can't see, UNLESS this
    // attacker CAN see it (Truesight / See Invisibility / Blindsight / Tremorsense).
    // The senses engine decides; this is the See-Invisibility gap Johnny hit.
    if (tgtStatuses.has("invisible")) {
      tgtConditions.add("invisible");
      const attackerSees = Situation.canSee(attackerActor, targetActor, {
        viewerToken: attackerToken, subjectToken: targetToken, distanceFt: distanceToTarget,
      });
      if (!attackerSees.canSee) {
        disadvantageSources.push({ source: "target", reason: "Target is INVISIBLE (unseen) → attack disadvantage" });
      } else {
        Situation.narrate([`${attackerActor?.name} sees ${targetActor?.name} through invisibility (${attackerSees.why}) → no disadvantage`], { context: "attack" });
      }
    }

    // PETRIFIED
    if (tgtStatuses.has("petrified")) {
      tgtConditions.add("petrified");
      advantageSources.push({ source: "target", reason: "Target is PETRIFIED → attack advantage" });
    }

    // DODGING
    if (tgtStatuses.has("dodging") || tgtStatuses.has("dodge")) {
      tgtConditions.add("dodging");
      disadvantageSources.push({ source: "target", reason: "Target is DODGING → attack disadvantage" });
    }

    // POISONED, FRIGHTENED, CHARMED, GRAPPLED, INCAPACITATED, DEAFENED
    if (tgtStatuses.has("poisoned")) tgtConditions.add("poisoned");
    if (tgtStatuses.has("frightened")) tgtConditions.add("frightened");
    if (tgtStatuses.has("charmed")) tgtConditions.add("charmed");
    if (tgtStatuses.has("grappled")) tgtConditions.add("grappled");
    if (tgtStatuses.has("incapacitated")) tgtConditions.add("incapacitated");
    if (tgtStatuses.has("deafened") || tgtStatuses.has("deaf")) tgtConditions.add("deafened");

    // ── Ranged Attack Within 5ft of Hostile ─────────────────────────────
    if (isRanged) {
      const hostileNear = CombatState._isHostileNearAttacker(attackerActor, targetToken, 5);
      if (hostileNear) {
        disadvantageSources.push({ source: "situation", reason: "RANGED ATTACK within 5ft of hostile creature → disadvantage" });
      }
    }

    // ── Ranged Attack at Long Range ─────────────────────────────────────
    if (isRanged && targetToken && attackerActor.getActiveTokens?.()?.[0]) {
      const atkToken = attackerActor.getActiveTokens()[0];
      const distance = CombatState._getDistance(atkToken, targetToken);
      const normalRange = item?.system?.range?.value ?? 0;
      const longRange = item?.system?.range?.long ?? 0;
      if (normalRange && distance > normalRange && longRange && distance <= longRange) {
        disadvantageSources.push({ source: "situation", reason: `RANGED at LONG RANGE (${Math.round(distance)}ft > ${normalRange}ft normal) → disadvantage` });
      }
    }

    // ── Faerie Fire on Target ───────────────────────────────────────────
    if (CombatState._hasEffect(targetActor, "Faerie Fire")) {
      advantageSources.push({ source: "target", reason: "Target affected by FAERIE FIRE → attack advantage" });
    }

    // ── Guiding Bolt on Target (next attack advantage) ──────────────────
    if (CombatState._hasEffect(targetActor, "Guiding Bolt")) {
      advantageSources.push({ source: "target", reason: "Target marked by GUIDING BOLT → attack advantage" });
    }

    // ── Protection from Evil/Good on Target ─────────────────────────────
    if (CombatState._hasEffect(targetActor, "Protection from Evil and Good")) {
      const atkType = attackerActor.system?.details?.type?.value ?? "";
      if (["aberration", "celestial", "elemental", "fey", "fiend", "undead"].includes(atkType)) {
        disadvantageSources.push({ source: "target", reason: `Target has PROTECTION FROM EVIL/GOOD → disadvantage (attacker is ${atkType})` });
      }
    }

    // ── Blur on Target ──────────────────────────────────────────────────
    if (CombatState._hasEffect(targetActor, "Blur")) {
      disadvantageSources.push({ source: "target", reason: "Target has BLUR → attack disadvantage" });
    }

    // ── Foresight on Target ─────────────────────────────────────────────
    if (CombatState._hasEffect(targetActor, "Foresight")) {
      disadvantageSources.push({ source: "target", reason: "Target has FORESIGHT → attacks against have disadvantage" });
    }

    // ── Holy Aura on Target ─────────────────────────────────────────────
    if (CombatState._hasEffect(targetActor, "Holy Aura")) {
      disadvantageSources.push({ source: "target", reason: "Target has HOLY AURA → attacks against have disadvantage" });
    }

    // ── Foresight on Attacker ───────────────────────────────────────────
    if (CombatState._hasEffect(attackerActor, "Foresight")) {
      advantageSources.push({ source: "attacker", reason: "Attacker has FORESIGHT → attack advantage" });
    }

    // ── Otto's Irresistible Dance on Target ─────────────────────────────
    if (CombatState._hasEffect(targetActor, "Irresistible Dance") || CombatState._hasEffect(targetActor, "Otto")) {
      advantageSources.push({ source: "target", reason: "Target affected by IRRESISTIBLE DANCE → attack advantage" });
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  AUTO-CRIT CONDITIONS
    // ═════════════════════════════════════════════════════════════════════════
    let autoCrit = false;
    const autoCritReasons = [];

    if (isMelee && (tgtConditions.has("paralyzed") || tgtConditions.has("unconscious"))) {
      autoCrit = true;
      autoCritReasons.push(`Melee vs ${tgtConditions.has("paralyzed") ? "PARALYZED" : "UNCONSCIOUS"} = AUTO-CRIT`);
    }

    // Auto-crit from flags (attacker-side)
    if (FlagsEngine.hasAutoCrit(attackerActor, actionType)) {
      autoCrit = true;
      autoCritReasons.push("Flag grants AUTO-CRIT");
    }

    // Auto-crit from target grants flags
    if (FlagsEngine.grantsAutoCrit(targetActor, actionType)) {
      autoCrit = true;
      autoCritReasons.push("Target grants AUTO-CRIT (flag)");
    }

    // Prevent critical from target flags (Adamantine Armor)
    if (FlagsEngine.preventsCritical(targetActor, actionType)) {
      autoCrit = false;
      autoCritReasons.length = 0;
      autoCritReasons.push("CRITS PREVENTED (Adamantine Armor or similar)");
    }

    // Assassinate — attacker is Assassin rogue, target hasn't acted in combat
    //
    // RAW (PHB 2024 Soulknife/Assassin): "You have advantage on attack rolls
    // against any creature that hasn't taken a turn in the combat yet. Any
    // hit you score against a creature that is surprised is a critical hit."
    //
    // V0.4.22 FIX (replaces v0.4.21 runtime patch):
    //   The previous implementation read `targetCombatant.hasActed`. That
    //   getter does NOT exist on Foundry V13's `Combatant5e` class — it
    //   returned undefined, so `!undefined === true`, so Assassinate fired
    //   against EVERY target in combat regardless of turn state.
    //
    //   Two-layer detection:
    //   1) Read the actual flag Foundry stores: `flags.core.hasActed === true`
    //   2) Fallback: initiative-order comparison — if the target's initiative
    //      is higher than the current combatant's initiative AND we're in
    //      the same round, the target's turn already passed.
    //
    //   Both checks are required because (a) the flag isn't always set by
    //   default Foundry workflows and (b) initiative comparison breaks on
    //   the very first turn of round 1 when no one has acted yet.
    if (CombatState._hasFeature(attackerActor, "Assassinate")) {
      const combat = game.combat;
      if (combat?.started) {
        const targetCombatant = combat.combatants?.find(c => c.actorId === targetActor.id);
        if (targetCombatant) {
          const flagSet = targetCombatant.flags?.core?.hasActed === true
                       || targetCombatant.flags?.dnd5e?.hasActed === true;

          // v0.4.22.7 FIX: Assassinate is PER-COMBAT, not per-round. The
          // previous logic only checked init order within the current round,
          // so in Round 3 with Jeth (12.18) attacking Lord Soth (10.11),
          // initOrderSaysActed = (10.11 > 12.18) = false, falsely saying
          // Lord Soth hadn't acted — even though Soth had already taken
          // turns in Rounds 1 and 2.
          //
          // Correct logic:
          //   • Round 1: only init-order tells us whether the target's turn
          //     has come up yet. Target with HIGHER init has acted; target
          //     with LOWER init hasn't yet.
          //   • Round 2+: every combatant in initiative has had at least one
          //     full round to take their turn. Assume they've acted unless
          //     the flag explicitly says otherwise.
          const currentCombatant = combat.combatant;
          const targetInit = Number(targetCombatant.initiative ?? -Infinity);
          const currentInit = Number(currentCombatant?.initiative ?? -Infinity);

          let targetHasActed;
          if (flagSet) {
            // Foundry/dnd5e flag explicitly set — trust it
            targetHasActed = true;
          } else if (combat.round > 1) {
            // Round 2+: target has had at least one full round to act
            targetHasActed = true;
          } else {
            // Round 1: target acted if their init was higher (turn already
            // passed before current attacker's turn)
            targetHasActed = Number.isFinite(targetInit)
                          && Number.isFinite(currentInit)
                          && targetInit > currentInit;
          }

          if (!targetHasActed) {
            // ── Advantage portion (RAW: target hasn't taken a turn yet) ──
            // This applies whether or not the target is surprised.
            advantageSources.push({ source: "attacker", reason: "ASSASSINATE → advantage vs creature that hasn't acted" });

            // ── Auto-crit portion (RAW: target must be SURPRISED) ──
            // v0.4.22.6: Previously auto-crit fired on any not-yet-acted
            // creature, which is broader than RAW. Per PHB Assassin
            // Assassinate, the auto-crit ONLY applies to creatures with
            // the "surprised" condition. Surprise is a specific status
            // applied at combat start when the target didn't notice the
            // attacker before initiative. Without this gate, every round-1
            // attack from above-initiative was an auto-crit, dramatically
            // overpowering the feature.
            //
            // Detection: standard `surprised` status effect on the actor,
            // with fallback to dnd5e flag and combatant flag for cross-
            // workflow safety.
            const isSurprised = targetActor.statuses?.has?.("surprised") === true
                             || targetActor.statuses?.has?.("surprise") === true
                             || targetCombatant.flags?.dnd5e?.surprised === true
                             || targetCombatant.flags?.core?.surprised === true
                             // v0.7.14 G-A fix: also read the ACE QOL surprise flag on the
                             // target's TokenDocument. StealthEngine stamps this on detection
                             // and ALSO applies the standard status, but belt-and-braces
                             // covers any path where the standard status was cleared but our
                             // flag persists (or vice versa).
                             || targetCombatant.token?.getFlag?.(MODULE_ID, "surprised") === true;

            if (isSurprised) {
              autoCrit = true;
              autoCritReasons.push("ASSASSINATE → target is surprised = AUTO-CRIT");
            }
          }
        }
      }
    }

    // Expanded crit range — Hexblade's Curse (19-20 vs cursed target only),
    // Champion Improved Critical (19-20 vs any), Superior Critical (18-20).
    // RAW: Hexblade's Curse 19-20 crit range applies ONLY to the cursed
    // target, not to all attacks while the curse is active.
    let critRange = 20;
    if (CombatState._isHexbladeCursedTarget(attackerActor, targetToken)) {
      critRange = 19;
    }
    if (CombatState._hasFeature(attackerActor, "Improved Critical")) {
      critRange = 19;
    }
    if (CombatState._hasFeature(attackerActor, "Superior Critical")) {
      critRange = 18;
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  DAMAGE MODIFIERS PER TYPE
    // ═════════════════════════════════════════════════════════════════════════
    const resistances = new Set(tgtTraits.dr?.value ?? []);
    const immunities = new Set(tgtTraits.di?.value ?? []);
    const vulnerabilities = new Set(tgtTraits.dv?.value ?? []);
    const isMagical = itemProps.has("mgc") || !!item?.system?.magicAvailable;
    const isSilvered = itemProps.has("sil");
    const isAdamantine = itemProps.has("ada");

    // Build bypass sets from the creature's actual trait data
    const drBypasses = new Set(tgtTraits.dr?.bypasses ?? []);
    const diBypasses = new Set(tgtTraits.di?.bypasses ?? []);

    const damageModifiers = {};
    for (const type of damageTypes) {
      let modifier = "normal";
      let reason = null;

      if (immunities.has(type)) {
        // Physical damage types may be bypassed by magical/silvered/adamantine weapons
        if (PHYSICAL_TYPES.has(type) && diBypasses.size > 0) {
          const bypassed = (diBypasses.has("mgc") && isMagical)
                        || (diBypasses.has("sil") && isSilvered)
                        || (diBypasses.has("ada") && isAdamantine);
          if (bypassed) {
            modifier = "normal";
            reason = `${type} immunity BYPASSED (${isMagical ? "magical" : isSilvered ? "silvered" : "adamantine"} weapon)`;
          } else {
            modifier = "immune";
            reason = `Immune to ${type}`;
          }
        } else {
          modifier = "immune";
          reason = `Immune to ${type}`;
        }
      } else if (resistances.has(type)) {
        if (PHYSICAL_TYPES.has(type) && drBypasses.size > 0) {
          const bypassed = (drBypasses.has("mgc") && isMagical)
                        || (drBypasses.has("sil") && isSilvered)
                        || (drBypasses.has("ada") && isAdamantine);
          if (bypassed) {
            modifier = "normal";
            reason = `${type} resistance BYPASSED (${isMagical ? "magical" : isSilvered ? "silvered" : "adamantine"} weapon)`;
          } else {
            modifier = "resistant";
            reason = `Resists ${type} (half damage)`;
          }
        } else if (PHYSICAL_TYPES.has(type) && drBypasses.size === 0) {
          modifier = "resistant";
          reason = `Resists ${type} (half damage)`;
        } else {
          modifier = "resistant";
          reason = `Resists ${type} (half damage)`;
        }
      } else if (vulnerabilities.has(type)) {
        modifier = "vulnerable";
        reason = `VULNERABLE to ${type} (double damage)`;
      }

      // Petrified = resist all
      if (tgtConditions.has("petrified") && modifier === "normal") {
        modifier = "resistant";
        reason = "PETRIFIED → resists all damage";
      }

      damageModifiers[type] = { modifier, reason };
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  SAVING THROW MODIFIERS ON TARGET
    // ═════════════════════════════════════════════════════════════════════════
    let saveAdvantage = false;
    let saveDisadvantage = false;
    let autoFailSave = false;
    const saveBonuses = [];
    const saveAdvReasons = [];
    const saveDisadvReasons = [];

    if (saveAbility) {
      // Auto-fail STR/DEX saves
      if (["str", "dex"].includes(saveAbility)) {
        if (tgtConditions.has("paralyzed") || tgtConditions.has("stunned")
         || tgtConditions.has("unconscious") || tgtConditions.has("petrified")) {
          autoFailSave = true;
        }
      }

      // Restrained → disadvantage on DEX saves
      if (tgtConditions.has("restrained") && saveAbility === "dex") {
        saveDisadvantage = true;
        saveDisadvReasons.push("RESTRAINED → DEX save disadvantage");
      }

      // Exhaustion 3+ → disadvantage on ALL saves (2014 only)
      // 2024 RAW collapses exhaustion to a flat -N penalty per level handled
      // natively by the dnd5e system; ACE QOL must not double-stack.
      const tgtExhaustion = tgtSys.attributes?.exhaustion ?? 0;
      if (tgtExhaustion >= 3 && CombatState.getActiveEdition(targetActor) === "2014") {
        saveDisadvantage = true;
        saveDisadvReasons.push(`EXHAUSTION ${tgtExhaustion} (2014 L3+) → save disadvantage`);
      }

      // Dodge → advantage on DEX saves
      if (saveAbility === "dex" && tgtConditions.has("dodging")) {
        saveAdvantage = true;
        saveAdvReasons.push("DODGING → DEX save advantage");
      }

      // Magic Resistance → advantage on saves vs spells
      const magicRes = FlagsEngine.hasMagicResistance(targetActor)
                    || ExtendedEffects.hasMagicResistance(targetActor)
                    || CombatState._hasFeature(targetActor, "Magic Resistance");
      if (magicRes && isSpell) {
        saveAdvantage = true;
        saveAdvReasons.push("MAGIC RESISTANCE → advantage on saves vs spells");
      }

      // Gnome Cunning → advantage on INT/WIS/CHA saves vs magic
      if (["int", "wis", "cha"].includes(saveAbility) && isSpell) {
        if (CombatState._hasFeature(targetActor, "Gnome Cunning")) {
          saveAdvantage = true;
          saveAdvReasons.push("GNOME CUNNING → advantage on INT/WIS/CHA saves vs magic");
        }
      }

      // Danger Sense (Barbarian) → advantage on DEX saves you can see
      if (saveAbility === "dex" && CombatState._hasFeature(targetActor, "Danger Sense")) {
        if (!tgtConditions.has("blinded") && !tgtConditions.has("deafened") && !tgtConditions.has("incapacitated")) {
          saveAdvantage = true;
          saveAdvReasons.push("DANGER SENSE → DEX save advantage");
        }
      }

      // Haste → advantage on DEX saves
      if (saveAbility === "dex" && CombatState._hasEffect(targetActor, "Haste")) {
        saveAdvantage = true;
        saveAdvReasons.push("HASTE → DEX save advantage");
      }

      // Foresight → advantage on ALL saves
      if (CombatState._hasEffect(targetActor, "Foresight")) {
        saveAdvantage = true;
        saveAdvReasons.push("FORESIGHT → advantage on all saves");
      }

      // Holy Aura → advantage on ALL saves
      if (CombatState._hasEffect(targetActor, "Holy Aura")) {
        saveAdvantage = true;
        saveAdvReasons.push("HOLY AURA → advantage on all saves");
      }

      // Beacon of Hope → advantage on WIS saves
      if (saveAbility === "wis" && CombatState._hasEffect(targetActor, "Beacon of Hope")) {
        saveAdvantage = true;
        saveAdvReasons.push("BEACON OF HOPE → WIS save advantage");
      }

      // ACE QOL flags (FlagsEngine checks ace-qol + midi-qol automatically)
      if (FlagsEngine.hasSaveAdvantage(targetActor, saveAbility)
       || ExtendedEffects.hasAdvantage(targetActor, "save", saveAbility)
       || ExtendedEffects.hasAdvantage(targetActor, "save", "all")) {
        saveAdvantage = true;
        saveAdvReasons.push("Effect grants save advantage");
      }
      if (FlagsEngine.hasSaveDisadvantage(targetActor, saveAbility)
       || ExtendedEffects.hasDisadvantage(targetActor, "save", saveAbility)
       || ExtendedEffects.hasDisadvantage(targetActor, "save", "all")) {
        saveDisadvantage = true;
        saveDisadvReasons.push("Effect grants save disadvantage");
      }

      // Auto-fail saves from flags
      if (FlagsEngine.autoFailsSave(targetActor, saveAbility)) {
        autoFailSave = true;
      }

      // ── Save bonuses from active effects (Bless, Bardic Inspiration,
      //    Heroes' Feast, Resistance cantrip, custom buffs) ──
      // Scan the actor's active effects for any change modifying:
      //   • system.bonuses.abilities.save        (all-save bonus, like Bless)
      //   • system.abilities.<ability>.bonuses.save  (per-ability bonus)
      // Use the effect's NAME as the label so players see exactly which buff
      // is contributing. This replaces the old hardcoded "Bless" label which
      // mis-attributed Bardic Inspiration / Heroism / etc.
      const collectedFromEffects = new Set(); // dedup by (key,value)
      for (const eff of (targetActor.effects?.contents ?? [])) {
        if (eff.disabled) continue;
        const effName = eff.name || "Active Effect";
        for (const ch of (eff.changes ?? [])) {
          if (!ch.value) continue;
          const k = String(ch.key ?? "");
          const isAllSave = k === "system.bonuses.abilities.save";
          const isThisSave = k === `system.abilities.${saveAbility}.bonuses.save`;
          if (!isAllSave && !isThisSave) continue;
          const dedupeKey = `${k}::${ch.value}::${effName}`;
          if (collectedFromEffects.has(dedupeKey)) continue;
          collectedFromEffects.add(dedupeKey);
          saveBonuses.push({
            value: String(ch.value).startsWith("+") || String(ch.value).startsWith("-")
              ? ch.value : `+${ch.value}`,
            label: effName,
          });
        }
      }

      // Fallback: bonuses applied directly to the actor's system data (some
      // legacy modules/sheets stash bonuses there without a discoverable
      // active effect). Only surface if not already captured above.
      const blessBonus = tgtSys.bonuses?.abilities?.save;
      if (blessBonus && ![...collectedFromEffects].some(k => k.endsWith(`::${blessBonus}::Bless`))) {
        // Try to identify the source — if there's an effect literally named
        // "Bless" we already grabbed it. Otherwise label it as "Save bonus".
        const blessEff = (targetActor.effects?.contents ?? []).find(e =>
          /^bless$/i.test(e.name ?? "") && !e.disabled);
        if (!blessEff) {
          saveBonuses.push({ value: blessBonus, label: "Save bonus" });
        }
      }
      const abilitySaveBonus = tgtSys.abilities?.[saveAbility]?.bonuses?.save;
      if (abilitySaveBonus && !collectedFromEffects.size) {
        saveBonuses.push({ value: abilitySaveBonus, label: `${saveAbility.toUpperCase()} bonus` });
      }

      // Aura of Protection (Paladin) — CHA mod to saves for nearby allies
      // (or self per RAW). Check all friendly tokens for a paladin source.
      const auraBonus = CombatState._getAuraOfProtectionBonus(targetToken);
      if (auraBonus > 0) saveBonuses.push({ value: `+${auraBonus}`, label: "Aura of Protection" });
    }

    // ── Evasion / Shield Master ─────────────────────────────────────────
    const superSaver = FlagsEngine.hasEvasion(targetActor)
                    || ExtendedEffects.hasSuperSaver(targetActor, saveAbility)
                    || (saveAbility === "dex" && CombatState._hasFeature(targetActor, "Evasion"));
    const semiSuperSaver = FlagsEngine._checkFlag(targetActor, `semiSuperSaver.${saveAbility}`)
                        || ExtendedEffects.hasSemiSuperSaver(targetActor, saveAbility)
                        || (saveAbility === "dex" && CombatState._hasFeature(targetActor, "Shield Master"));

    // ═════════════════════════════════════════════════════════════════════════
    //  CREATURE TYPE + SLAYER
    // ═════════════════════════════════════════════════════════════════════════
    const creatureType = tgtDetails.type?.value ?? "";
    const creatureSubtype = tgtDetails.type?.subtype ?? "";
    const creatureSize = tgtDetails.size ?? "medium";

    const slayerType = item?.getFlag?.("ace-artificer", "slayerType")
                    || item?.getFlag?.("ace-qol", "slayerType") || null;
    const slayerDamage = item?.getFlag?.("ace-artificer", "slayerDamage")
                      || item?.getFlag?.("ace-qol", "slayerDamage") || null;
    let slayerMatch = false;
    if (slayerType && creatureType) {
      slayerMatch = creatureType === slayerType
                 || creatureSubtype?.toLowerCase().includes(slayerType)
                 || creatureType?.toLowerCase().includes(slayerType);
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  ATTACKER BONUS DAMAGE FEATURES
    // ═════════════════════════════════════════════════════════════════════════
    const attackerBonuses = [];

    // Sneak Attack — once per turn (RAW, both 2014 and 2024).
    // Detection covers finesse/ranged weapon + (advantage OR ally within 5 ft).
    // Once-per-turn enforcement gates re-fire on subsequent hits this turn
    // (Two-Weapon Fighting, Action Surge, Bonus-Action Attack, etc.).
    // Flag `sneakAttack.usedThisTurn` is cleared on this actor's turn-end.
    const sneakAttack = CombatState._checkSneakAttack(attackerActor, targetToken, item, isMelee, advantageSources.length > 0, disadvantageSources.length > 0);
    if (sneakAttack.eligible) {
      const alreadyUsed = !!attackerActor.getFlag?.(MODULE_ID, "sneakAttack.usedThisTurn");
      if (!alreadyUsed) {
        sneakAttack.isOncePerTurn = "sneakAttack"; // marker consumed downstream to set flag
        attackerBonuses.push(sneakAttack);
      } else {
        console.log(`${MODULE_ID} | Sneak Attack skipped — already used this turn (RAW: once per turn)`);
      }
    }

    // Hex
    if (CombatState._hasEffect(attackerActor, "Hex")) {
      attackerBonuses.push({ name: "Hex", formula: "1d6", type: "necrotic", reason: "Hex → +1d6 necrotic per hit" });
    }

    // Hunter's Mark
    if (CombatState._hasEffect(attackerActor, "Hunter's Mark") || CombatState._hasEffect(attackerActor, "Hunter")) {
      attackerBonuses.push({ name: "Hunter's Mark", formula: "1d6", type: damageTypes[0] ?? "force", reason: "Hunter's Mark → +1d6 per hit" });
    }

    // ── Dueling fighting style — +2 damage with one-handed melee, no other weapon ──
    // RAW: "When you are wielding a melee weapon in one hand and no other
    // weapons, you gain a +2 bonus to damage rolls with that weapon."
    if (isMelee && CombatState._hasFeature(attackerActor, "Dueling")) {
      const itemSysX = item?.system ?? {};
      const propsX = itemSysX.properties ?? new Set();
      const isOneHanded = !propsX.has?.("two") && !propsX.has?.("ver"); // exclude 2H and versatile (versatile counts only if held 2H, hard to detect — exclude conservatively)
      // "No other weapons" — heuristic: no other equipped weapon items.
      const otherWeapons = (attackerActor.items ?? []).filter(i =>
        i !== item && i.type === "weapon" && i.system?.equipped
      );
      if (isOneHanded && otherWeapons.length === 0) {
        attackerBonuses.push({
          name: "Dueling",
          formula: "2",
          type: damageTypes[0] ?? "untyped",
          reason: "Dueling fighting style → +2 damage (one-handed melee, no other weapon)",
        });
      }
    }

    // ── Polearm Master (2024) — bonus-action butt attack ──
    // RAW: "When you take the Attack action and attack with only a Glaive,
    // Halberd, Pike, Quarterstaff, or Spear, you can make one melee attack
    // with the opposite end of the weapon as a Bonus Action that turn. The
    // weapon's damage die for this attack is a d4, and it deals bludgeoning
    // damage."
    // We surface a reminder card via the attackComplete hook (no damage
    // bonus added here — the player makes the actual bonus-action attack).
    // (Reminder posting handled in weapon-masteries.mjs's framework — added
    // there as a sibling card.)

    // ── Crusher (2024) — bludgeoning damage feat ──
    // RAW: Once per turn when you hit a creature with an attack that deals
    // bludgeoning damage, you can move it 5 feet to an unoccupied space.
    // On crit with bludgeoning, attack rolls vs target have advantage until
    // start of your next turn.
    // We post a reminder card on hit and let the GM apply the movement.
    // (Push/advantage effects via cards in weapon-masteries.mjs sibling layer.)

    // ── Great Weapon Master — edition-aware ──
    // 2014 RAW: Player-choice -5 to-hit / +10 damage toggle on Heavy melee
    //           weapons you are proficient with, PLUS a bonus-action melee
    //           attack on crit or kill. No passive damage bonus. The -5/+10
    //           toggle is surfaced via the optional-bonus prompt system.
    // 2024 RAW: "When you make a melee attack with a Heavy weapon you have
    //           proficiency with, you can add your Proficiency Bonus to the
    //           damage." Passive +PB damage on every heavy melee hit.
    //
    // Resolution: CombatState.getActiveEdition(attackerActor). 2014 = no
    // passive damage here. 2024 = +PB damage rider.
    if (isMelee && CombatState._hasFeature(attackerActor, "Great Weapon Master")) {
      const gwmEdition = CombatState.getActiveEdition(attackerActor);
      if (gwmEdition === "2024") {
        const propsX = item?.system?.properties ?? new Set();
        if (propsX.has?.("hvy")) {
          const prof = attackerActor.system?.attributes?.prof ?? 2;
          attackerBonuses.push({
            name: "Great Weapon Master",
            formula: `${prof}`,
            type: damageTypes[0] ?? "slashing",
            reason: `Great Weapon Master (2024) → +${prof} damage on Heavy melee weapon`,
          });
        }
      }
    }

    // ── Sharpshooter — edition-aware ──
    // 2014 RAW: Player-choice -5 to-hit / +10 damage toggle on ranged weapons
    //           you are proficient with, PLUS ignores long-range disadvantage
    //           and Half / Three-Quarters Cover. No passive damage bonus.
    //           Toggle surfaced via the optional-bonus prompt system.
    // 2024 RAW: "When you make an attack with a Ranged Weapon you have
    //           proficiency with, you can add your Proficiency Bonus to the
    //           damage of the attack." Passive +PB damage on every ranged hit.
    //           (Cover-ignore handled by CoverEngine in both editions.)
    if (isRanged && CombatState._hasFeature(attackerActor, "Sharpshooter")) {
      const shsEdition = CombatState.getActiveEdition(attackerActor);
      if (shsEdition === "2024") {
        const prof = attackerActor.system?.attributes?.prof ?? 2;
        attackerBonuses.push({
          name: "Sharpshooter",
          formula: `${prof}`,
          type: damageTypes[0] ?? "piercing",
          reason: `Sharpshooter (2024) → +${prof} damage on Ranged weapon`,
        });
      }
    }

    // ── Two-Weapon Fighting — off-hand ability mod (edition-independent RAW) ──
    // RAW, BOTH 2014 and 2024: an off-hand attack's damage does NOT get your
    // ability modifier. The ONLY thing that grants it is the Two-Weapon Fighting
    // fighting style. The Dual Wielder feat does NOT grant it in either edition
    // (2024 Enhanced Dual Wielding, verbatim: "you don't add your ability
    // modifier to the extra attack's damage unless that modifier is negative").
    // The 2024 rules did NOT move the mod onto the Light property — that was a
    // myth this code used to encode (it auto-granted for any 2024 Light swing).
    // Corrected + proven 2026-07-12 (aidedd.org 2024 feat text; D&D Beyond forums).
    //
    // dnd5e strips the off-hand mod on its damage path AND our damage calculator
    // strips it on the ACE path, so this block is the SOLE authority that
    // restores it — only when it qualifies. Main-hand swings aren't marked as
    // off-hand, so they skip this entirely and keep their base mod.
    //
    // HOUSE RULE: `dualWielderGrantsOffhandMod` (default OFF) lets a table grant
    // the mod to anyone with the Dual Wielder feat, as if they had the fighting
    // style — a very common table variant, but NOT RAW. OFF = strict RAW.
    if (isMelee && CombatState.isOffhandSwing(item?.uuid)) {
      const itemSysX = item?.system ?? {};
      const propsX   = itemSysX.properties ?? new Set();
      const hasDualWielder = CombatState._hasFeature(attackerActor, "Dual Wielder");

      // Valid two-weapon-fighting configuration:
      //  • Base rules — the off-hand weapon is Light AND a second Light weapon is
      //    equipped.
      //  • Dual Wielder feat — the pair may be non-Light one-handed melee weapons
      //    (the feat drops the Light requirement; still no Two-Handed weapon).
      const offhandIsLight     = !!propsX.has?.("lgt");
      const offhandIsTwoHanded = !!propsX.has?.("two");
      const otherEquipped = (attackerActor.items ?? []).filter(i =>
        i !== item && i.type === "weapon" && i.system?.equipped && !(i.system?.properties?.has?.("two"))
      );
      const otherLight = otherEquipped.filter(i => i.system?.properties?.has?.("lgt"));

      const baseConfigOk        = offhandIsLight && otherLight.length > 0;
      const dualWielderConfigOk = hasDualWielder && !offhandIsTwoHanded && otherEquipped.length > 0;

      if (baseConfigOk || dualWielderConfigOk) {
        const hasTWFStyle = CombatState._hasFeature(attackerActor, "Two-Weapon Fighting");
        const dwHouseRule = !!QolSettings.get?.("dualWielderGrantsOffhandMod") && hasDualWielder;
        // Fighting style = RAW; Dual Wielder grant = explicit house rule only.
        if (hasTWFStyle || dwHouseRule) {
          const abilKey = itemSysX.ability || (propsX.has?.("fin") ? "dex" : "str");
          const abilMod = attackerActor.system?.abilities?.[abilKey]?.mod ?? 0;
          if (abilMod > 0) {
            const reasonSource = hasTWFStyle
              ? "Two-Weapon Fighting style"
              : "Dual Wielder feat (house rule)";
            attackerBonuses.push({
              name: hasTWFStyle ? "Two-Weapon Fighting" : "Dual Wielder (House Rule)",
              formula: `${abilMod}`,
              type: damageTypes[0] ?? "untyped",
              reason: `Off-hand ability mod → +${abilMod} (${reasonSource})`,
            });
          }
        }
      }
    }

    // Hex — +1d6 necrotic against the hexed target only (RAW).
    // Target tracked via `flags.ace-qol.hex = { targetUuid, ... }`. Set on
    // spell cast, cleared on concentration end (deleteActiveEffect for "Hex").
    if (CombatState._isHexTarget(attackerActor, targetToken)) {
      attackerBonuses.push({ name: "Hex", formula: "1d6", type: "necrotic", reason: "Hex → +1d6 necrotic vs hexed target" });
    }

    // Hexblade's Curse — +PB to damage rolls, but ONLY vs cursed target (RAW).
    // Curse is stored as `flags.ace-qol.hexbladeCurse = { targetUuid, appliedAt }`
    // — set via `CombatState.applyHexbladeCurse(attacker, targetToken)`.
    if (CombatState._isHexbladeCursedTarget(attackerActor, targetToken)) {
      const prof = attackerActor.system?.attributes?.prof ?? 2;
      attackerBonuses.push({ name: "Hexblade's Curse", formula: `${prof}`, type: damageTypes[0] ?? "force", reason: `Hexblade's Curse → +${prof} damage vs cursed target` });
    }

    // Rage damage (Barbarian)
    if (CombatState._hasEffect(attackerActor, "Rage") && isMelee) {
      const rageBonus = CombatState._getRageDamageBonus(attackerActor);
      if (rageBonus > 0) {
        attackerBonuses.push({ name: "Rage", formula: `${rageBonus}`, type: damageTypes[0] ?? "bludgeoning", reason: `Rage → +${rageBonus} melee damage` });
      }
    }

    // Improved Divine Smite / Radiant Strikes (Paladin 11+)
    if (isMelee && (CombatState._hasFeature(attackerActor, "Improved Divine Smite") || CombatState._hasFeature(attackerActor, "Radiant Strikes") || CombatState._getClassLevel(attackerActor, "paladin") >= 11)) {
      attackerBonuses.push({ name: "Improved Divine Smite", formula: "1d8", type: "radiant", reason: "Improved Divine Smite → +1d8 radiant on melee hits" });
    }

    // Divine Strike / Blessed Strikes (Cleric 8+) — ONCE PER TURN (RAW)
    // RAW: "Once on each of your turns when you hit a creature with a weapon
    // attack, you can cause the attack to deal an extra 1d8 [type] damage."
    //
    // Tracked via actor flag `divineStrike.usedThisTurn`. Cleared on this
    // actor's turn-end via the combatTurnChange handler in ace-qol.mjs.
    // Pattern mirrors Radiant Soul (Celestial Warlock 6+).
    if (CombatState._hasFeature(attackerActor, "Divine Strike") || CombatState._hasFeature(attackerActor, "Blessed Strikes")) {
      const alreadyUsed = !!attackerActor.getFlag?.(MODULE_ID, "divineStrike.usedThisTurn");
      if (!alreadyUsed) {
        const blessedStrikes = CombatState._hasFeature(attackerActor, "Blessed Strikes");
        attackerBonuses.push({
          name: blessedStrikes ? "Blessed Strikes" : "Divine Strike",
          formula: "1d8",
          type: "radiant",
          reason: `${blessedStrikes ? "Blessed Strikes" : "Divine Strike"} → +1d8 radiant (once per turn)`,
          isOncePerTurn: "divineStrike",  // marker for damage-calculator to call markDivineStrikeUsed
        });
      }
    }

    // Colossus Slayer (Hunter Ranger)
    if (CombatState._hasFeature(attackerActor, "Colossus Slayer")) {
      const tgtCurrentHP = tgtSys.attributes?.hp?.value ?? 0;
      const tgtMaxHP = tgtSys.attributes?.hp?.max ?? 0;
      if (tgtCurrentHP < tgtMaxHP) {
        attackerBonuses.push({ name: "Colossus Slayer", formula: "1d8", type: damageTypes[0] ?? "untyped", reason: "Colossus Slayer → +1d8 (target below max HP)" });
      }
    }

    // Dread Ambusher (Gloom Stalker)
    if (CombatState._hasFeature(attackerActor, "Dread Ambusher") && game.combat?.round === 1) {
      const rangerLevel = CombatState._getClassLevel(attackerActor, "ranger");
      const hasStalkerFlurry = CombatState._hasFeature(attackerActor, "Stalker's Flurry") || rangerLevel >= 11;
      const dreadFormula = hasStalkerFlurry ? "2d8" : "1d8";
      attackerBonuses.push({ name: "Dread Ambusher", formula: dreadFormula, type: damageTypes[0] ?? "untyped", reason: `Dread Ambusher → +${dreadFormula} damage (first round of combat)` });
    }

    // Divine Fury (Zealot Barbarian)
    if (CombatState._hasFeature(attackerActor, "Divine Fury") && CombatState._hasEffect(attackerActor, "Rage")) {
      const barbarianLevel = CombatState._getClassLevel(attackerActor, "barbarian");
      const furyBonus = Math.floor(barbarianLevel / 2);
      attackerBonuses.push({ name: "Divine Fury", formula: `1d6 + ${furyBonus}`, type: "radiant", reason: `Divine Fury → +1d6+${furyBonus} radiant (first hit while raging)` });
    }

    // Lifedrinker (Warlock invocation, requires Pact of the Blade)
    //
    // Edition-aware via getActiveEdition(actor). Mechanics differ:
    //   2014: bonus damage equal to the Warlock's CHA modifier (minimum 1),
    //         always necrotic, no player choice.
    //   2024: extra 1d6 of necrotic / psychic / radiant — player's choice
    //         (read from a sticky flag set via the chooser dialog).
    //
    // The edition setting at the top of the module config decides which
    // branch fires. Default is Auto, which sniffs the actor's items for
    // 2024 markers (weapon-mastery field, Innate Sorcery feat) and falls
    // back to 2014 when no markers are found.
    if (CombatState._hasFeature(attackerActor, "Lifedrinker")) {
      const edition = CombatState.getActiveEdition(attackerActor);
      if (edition === "2024") {
        let lifedrinkerType = "necrotic";
        try {
          const v = attackerActor.getFlag?.(MODULE_ID, "warlock.lifedrinkerType");
          if (v === "necrotic" || v === "psychic" || v === "radiant") {
            lifedrinkerType = v;
          }
        } catch (_) { /* default necrotic */ }
        attackerBonuses.push({
          name: "Lifedrinker",
          formula: "1d6",
          type: lifedrinkerType,
          reason: `Lifedrinker → +1d6 ${lifedrinkerType} per hit (2024 PHB, type per actor preference)`,
        });
      } else {
        // 2014 RAW: CHA modifier (minimum 1), necrotic, no choice.
        const chaMod = attackerActor.system?.abilities?.cha?.mod ?? 0;
        const damage = Math.max(1, chaMod);
        attackerBonuses.push({
          name: "Lifedrinker",
          formula: String(damage),
          type: "necrotic",
          reason: `Lifedrinker → +${damage} necrotic per hit (2014 PHB, CHA mod ${chaMod} → min 1)`,
        });
      }
    }

    // Spirit Shroud (active spell)
    //
    // v0.4.22.15: Range gate added (was TODO since launch). RAW: "the
    // first time on each of your turns that you hit a creature with a
    // weapon and deal damage to it, including when you make this melee
    // attack, the target takes an extra 1d8 radiant, necrotic, or cold
    // damage. THE TARGET MUST BE WITHIN 10 FEET OF YOU." Without the
    // distance check, the bonus fired at any range — wrong for archers
    // or thrown weapon attacks.
    //
    // We resolve the attacker's token from canvas (same approach as the
    // thrown-weapon fix in v0.4.22.7) and check distance.
    if (CombatState._hasEffect(attackerActor, "Spirit Shroud")) {
      const atkToken = opts.attackerToken
                    ?? canvas.tokens?.placeables?.find(t => t.actor?.id === attackerActor.id)
                    ?? null;
      const dist = (atkToken && targetToken)
        ? CombatState._getDistance(atkToken, targetToken)
        : null;
      // If we can't measure (off-canvas), default to allowing the
      // bonus — better to grant than wrongly deny when we lack data.
      if (dist === null || dist <= 10) {
        attackerBonuses.push({
          name: "Spirit Shroud",
          formula: "1d8",
          type: "radiant",
          reason: dist !== null
            ? `Spirit Shroud → +1d8 radiant (target ${Math.round(dist)}ft, within 10ft range)`
            : "Spirit Shroud → +1d8 radiant per hit (within 10ft)",
          isSpellDerived: true,
        });
      }
    }

    // Holy Weapon (active spell)
    if (CombatState._hasEffect(attackerActor, "Holy Weapon")) {
      attackerBonuses.push({ name: "Holy Weapon", formula: "2d8", type: "radiant", reason: "Holy Weapon → +2d8 radiant per hit", isSpellDerived: true });
    }

    // Elemental Weapon (active spell)
    if (CombatState._hasEffect(attackerActor, "Elemental Weapon")) {
      attackerBonuses.push({ name: "Elemental Weapon", formula: "1d4", type: "fire", reason: "Elemental Weapon → +1d4 elemental damage per hit", isSpellDerived: true });
    }

    // Crusader's Mantle (active spell aura)
    if (CombatState._hasEffect(attackerActor, "Crusader's Mantle") || CombatState._hasEffect(attackerActor, "Crusader")) {
      attackerBonuses.push({ name: "Crusader's Mantle", formula: "1d4", type: "radiant", reason: "Crusader's Mantle → +1d4 radiant per hit", isSpellDerived: true });
    }

    // Absorb Elements (active spell buff, melee only)
    if (CombatState._hasEffect(attackerActor, "Absorb Elements") && isMelee) {
      attackerBonuses.push({ name: "Absorb Elements", formula: "1d6", type: "fire", reason: "Absorb Elements → +1d6 elemental damage (next melee hit)", isSpellDerived: true });
    }

    // (Great Weapon Master +PB removed — was a duplicate of the earlier
    // edition-gated block above. Single edition-aware path lives at the
    // primary GWM block; double-stacking bug fixed.)

    // ═════════════════════════════════════════════════════════════════════════
    //  CONCENTRATION STATE
    // ═════════════════════════════════════════════════════════════════════════
    const isConcentrating = tgtStatuses.has("concentration") || tgtStatuses.has("concentrating");
    let concentrationSpell = null;
    if (isConcentrating) {
      for (const effect of targetActor.effects ?? []) {
        if (effect.statuses?.has("concentration") || effect.statuses?.has("concentrating")) {
          concentrationSpell = effect.name || "Unknown spell";
          break;
        }
      }
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  LEGENDARY RESISTANCE
    // ═════════════════════════════════════════════════════════════════════════
    const legendaryResistance = tgtSys.resources?.legres?.value ?? 0;
    const legendaryResistanceMax = tgtSys.resources?.legres?.max ?? 0;

    // ═════════════════════════════════════════════════════════════════════════
    //  WEAPON RULES ENTRIES — attack-roll quirks from the brain (2026-07-10)
    // ═════════════════════════════════════════════════════════════════════════
    // The Lance pattern: quirks dnd5e doesn't model, served as data. The brain
    // import is function-time only (cycle inert — same pattern as everywhere).
    try {
      if (item?.type === "weapon") {
        const wEntry = RulesBrain.lookup(item, { actor: attackerActor })?.entry;
        const withinFt = Number(wEntry?.attack?.disadvantageWithinFt);
        if (withinFt > 0 && distanceToTarget != null && distanceToTarget <= withinFt) {
          disadvantageSources.push({ source: "weapon", reason: `${item.name} used within ${withinFt} ft → attack disadvantage (weapon rule)` });
        }
      }
      // ── Heavy property (RAW, edition-split — 2026-07-10) ──
      // 2014: "Small creatures have disadvantage on attack rolls with heavy
      //        weapons." (Tiny included a fortiori.)
      // 2024: "You have Disadvantage on attack rolls with a Heavy weapon if
      //        your Strength isn't 13+ (melee) or Dexterity isn't 13+ (ranged)."
      if (item?.type === "weapon") {
        const props = item.system?.properties;
        const isHeavy = props?.has?.("hvy") || (Array.isArray(props) && props.includes("hvy"));
        if (isHeavy) {
          const edition = CombatState.getActiveEdition(attackerActor);
          if (edition === "2024") {
            const isRanged = String(item.system?.actionType ?? "").startsWith("r")
              || item.system?.type?.value === "martialR" || item.system?.type?.value === "simpleR";
            const abil = isRanged ? "dex" : "str";
            const score = Number(attackerActor.system?.abilities?.[abil]?.value ?? 10);
            if (score < 13) {
              disadvantageSources.push({ source: "weapon", reason: `Heavy weapon with ${abil.toUpperCase()} ${score} (< 13) → attack disadvantage (2024 Heavy property)` });
            }
          } else {
            const size = String(attackerActor.system?.traits?.size ?? "med");
            if (size === "sm" || size === "tiny") {
              disadvantageSources.push({ source: "weapon", reason: "Small creature wielding a Heavy weapon → attack disadvantage (2014 Heavy property)" });
            }
          }
        }
      }
    } catch (err) {
      console.debug(`${MODULE_ID} | weapon-rules attack check failed (non-fatal):`, err);
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  SIGHT THROUGH SPACES — darkness / fog / heavy obscurement (Phase 2, 2026-07-09)
    // ═════════════════════════════════════════════════════════════════════════
    // Evaluated at ATTACK TIME, per sight-line, both directions — never a
    // stamped condition. RAW (both editions): you can't see your target →
    // DISADVANTAGE on the attack; the target can't see YOU → unseen attacker →
    // ADVANTAGE. Devil's Sight / truesight pierce magical darkness; blindsight
    // pierces everything in radius; darkvision pierces neither. Mutual
    // blindness nets to a straight roll through the standard netting below.
    // The invisibility blocks above already ran their own sight checks — this
    // block only ADDS obscurement-caused sources when the cause is the SPACE
    // (guarded so invisible creatures don't double-report).
    try {
      const scene = attackerToken?.document?.parent ?? targetToken?.document?.parent ?? canvas?.scene;
      const anyObscuring = !!scene?.regions?.some?.(r => r.getFlag?.(MODULE_ID, "space")?.obscurement === "heavy");
      if (anyObscuring && attackerToken && targetToken) {
        // Attacker → target: can the attacker see who they're swinging at?
        if (!atkStatuses.has("blinded")) {           // blinded already penalized above
          const atkSees = Situation.canSee(attackerActor, targetActor, {
            viewerToken: attackerToken, subjectToken: targetToken, distanceFt: distanceToTarget,
          });
          if (!atkSees.canSee && /darkness|fog|obscure/i.test(atkSees.why)) {
            disadvantageSources.push({ source: "environment", reason: `Attacker can't see target — ${atkSees.why} → attack disadvantage` });
          } else if (atkSees.pierced) {
            // The obscurement WOULD have blinded the attacker, but one of the
            // attacker's senses cut through it → no disadvantage. This is about
            // the ATTACKER's OWN senses — safe for a player to see (gmOnly:false).
            situationalNotes.push({ gmOnly: false, text: `You see the target through the ${atkSees.pierced.kindLabel}${atkSees.pierced.spell ? ` (${atkSees.pierced.spell})` : ""} via ${atkSees.pierced.how} — no disadvantage from the darkness` });
          }
        }
        // Target → attacker: unseen attacker gets advantage. The why-filter
        // keeps this to OBSCUREMENT causes only — invisibility-caused blindness
        // reports "subject is invisible" and was already handled above.
        const tgtSees = Situation.canSee(targetActor, attackerActor, {
          viewerToken: targetToken, subjectToken: attackerToken, distanceFt: distanceToTarget,
        });
        if (!tgtSees.canSee && /darkness|fog|obscure/i.test(tgtSees.why)) {
          advantageSources.push({ source: "environment", reason: `Target can't see the attacker — ${tgtSees.why} → attack advantage` });
        } else if (tgtSees.pierced) {
          // The attacker is standing in obscurement that WOULD hide them, but
          // the target sees through it (truesight / devil's sight / blindsight)
          // → no unseen-attacker advantage. This is the "why is there no
          // advantage on Demogorgon?" case: state it instead of going silent.
          const tName = targetToken.document?.name ?? targetToken.name ?? targetActor.name ?? "The target";
          // Reveals the TARGET's hidden senses (a monster's truesight/devil's
          // sight) → GM-only by default so players can't metagame it.
          situationalNotes.push({ gmOnly: true, text: `${tName} sees you through the ${tgtSees.pierced.kindLabel}${tgtSees.pierced.spell ? ` (${tgtSees.pierced.spell})` : ""} via ${tgtSees.pierced.how} — you're not hidden, so no advantage` });
        }
      }
    } catch (err) {
      console.debug(`${MODULE_ID} | obscurement sight check failed (non-fatal):`, err);
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  FINAL ROLL MODE DETERMINATION
    // ═════════════════════════════════════════════════════════════════════════
    const hasAdvantage = advantageSources.length > 0;
    const hasDisadvantage = disadvantageSources.length > 0;

    // D&D 5e rule: any amount of advantage + any amount of disadvantage = normal
    let finalRollMode = "normal";
    if (hasAdvantage && hasDisadvantage) {
      finalRollMode = "normal"; // they cancel
    } else if (hasAdvantage) {
      finalRollMode = "advantage";
    } else if (hasDisadvantage) {
      finalRollMode = "disadvantage";
    }

    // ── Situational narration: surface the FULL read (the "show me a clue" switch) ──
    // Light dedup so the dual rollAttack/rollAttackV2 hooks don't double-print.
    try {
      const key = `${attackerActor?.id}|${targetActor?.id}|${finalRollMode}|${advantageSources.length}|${disadvantageSources.length}|${situationalNotes.length}`;
      if (CombatState._lastNarrationKey !== key) {
        CombatState._lastNarrationKey = key;
        const lines = [
          ...advantageSources.map(s => `+ ${s.reason}`),
          ...disadvantageSources.map(s => `− ${s.reason}`),
          ...situationalNotes.map(n => `· ${n.text}${n.gmOnly ? " (GM-only)" : ""}`),
        ];
        lines.push((advantageSources.length || disadvantageSources.length) ? `NET → ${finalRollMode.toUpperCase()}` : "no modifiers → straight roll");
        Situation.narrate(lines, { context: `${attackerActor?.name} → ${targetActor?.name}` });
      }
    } catch (_) { /* non-fatal */ }

    // ═════════════════════════════════════════════════════════════════════════
    //  BUILD RESULT
    // ═════════════════════════════════════════════════════════════════════════
    return {
      attackerActor, targetToken, targetActor, item,
      isMelee, isRanged, isSpell, actionType,

      attacker: {
        name: attackerActor.token?.name ?? attackerActor.getActiveTokens?.()?.[0]?.name ?? attackerActor.name,
        conditions: atkConditions,
        exhaustion,
        reckless: !!reckless,
        bonuses: attackerBonuses,
      },

      target: {
        name: targetToken.document?.name ?? targetToken.name ?? targetActor.name,
        img: targetToken.document?.texture?.src ?? targetActor.img,
        ac: tgtAttrs.ac?.value ?? 10,
        conditions: tgtConditions,
        conditionImmunities: new Set(tgtTraits.ci?.value ?? []),
        currentHP: tgtSys.attributes?.hp?.value ?? 0,
        maxHP: tgtSys.attributes?.hp?.max ?? 0,
        tempHP: tgtSys.attributes?.hp?.temp ?? 0,
        creatureType, creatureSubtype, creatureSize,
        isConcentrating, concentrationSpell,
        legendaryResistance, legendaryResistanceMax,
      },

      damageModifiers,
      magicalBypass: isMagical, silveredBypass: isSilvered, adamantineBypass: isAdamantine,
      damageTypes,

      finalRollMode,
      advantageSources,
      disadvantageSources,
      situationalNotes,
      autoCrit,
      autoCritReasons,
      critRange,

      saveAbility, saveAdvantage, saveDisadvantage, autoFailSave,
      saveBonuses, saveAdvReasons, saveDisadvReasons,
      superSaver, semiSuperSaver,
      magicResistance: (FlagsEngine.hasMagicResistance(targetActor) || ExtendedEffects.hasMagicResistance(targetActor) || CombatState._hasFeature(targetActor, "Magic Resistance")) && isSpell,

      slayerMatch, slayerDamage, slayerType,
    };
  }

  /**
   * Assess all currently targeted tokens.
   */
  static assessAll(attackerActor, item, opts = {}) {
    const results = [];
    for (const token of game.user.targets) {
      const state = CombatState.assess(attackerActor, token, item, opts);
      if (state) results.push(state);
    }
    return results;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Summary Tags for Chat Card
  // ═══════════════════════════════════════════════════════════════════════════

  static getSummaryTags(state) {
    const tags = [];

    // Roll mode
    if (state.finalRollMode === "advantage") {
      tags.push({ label: "ROLL: ADVANTAGE", type: "bonus", icon: "fa-angles-up" });
    } else if (state.finalRollMode === "disadvantage") {
      tags.push({ label: "ROLL: DISADVANTAGE", type: "debuff", icon: "fa-angles-down" });
    } else if (state.advantageSources.length > 0 && state.disadvantageSources.length > 0) {
      tags.push({ label: "ADV + DISADV = NORMAL (cancelled)", type: "info", icon: "fa-equals" });
    }

    // Why advantage
    for (const src of state.advantageSources) {
      tags.push({ label: src.reason, type: "bonus", icon: "fa-arrow-up" });
    }

    // Why disadvantage
    for (const src of state.disadvantageSources) {
      tags.push({ label: src.reason, type: "debuff", icon: "fa-arrow-down" });
    }

    // Auto-crit
    for (const reason of (state.autoCritReasons ?? [])) {
      tags.push({ label: reason, type: "danger", icon: "fa-skull-crossbones" });
    }

    // Expanded crit range
    if (state.critRange < 20) {
      tags.push({ label: `CRIT RANGE: ${state.critRange}-20`, type: "danger", icon: "fa-crosshairs" });
    }

    // Damage modifiers
    for (const [type, mod] of Object.entries(state.damageModifiers)) {
      if (mod.modifier === "immune") tags.push({ label: `IMMUNE: ${type}`, type: "immune", icon: "fa-shield" });
      if (mod.modifier === "resistant" && mod.reason) tags.push({ label: mod.reason, type: mod.reason.includes("BYPASS") ? "info" : "resistant", icon: "fa-shield-halved" });
      if (mod.modifier === "vulnerable") tags.push({ label: mod.reason || `VULNERABLE: ${type}`, type: "vulnerable", icon: "fa-heart-crack" });
    }

    // Attacker bonuses
    for (const bonus of state.attacker.bonuses) {
      tags.push({ label: `${bonus.name}: +${bonus.formula} ${bonus.type}`, type: "bonus", icon: "fa-plus" });
    }

    // Slayer
    if (state.slayerMatch) {
      tags.push({ label: `SLAYER → +${state.slayerDamage} vs ${state.slayerType}`, type: "bonus", icon: "fa-crosshairs" });
    }

    // Target special
    if (state.target.isConcentrating) {
      tags.push({ label: `CONCENTRATING: ${state.target.concentrationSpell}`, type: "info", icon: "fa-brain" });
    }
    // LEG RESIST tag removed from attack-roll summary tags (Johnny audit
    // 2026-05-31). Was firing on every attack against a creature with
    // Legendary Resistance — but RAW: attack rolls don't trigger LR
    // (only failed saves do). Showing the badge here was misleading
    // visual noise that suggested LR could affect the attack itself.
    // Save cards still render their own LR-aware UI via save-engine.mjs.

    // Save modifiers
    if (state.autoFailSave) tags.push({ label: "TARGET AUTO-FAILS STR/DEX SAVE", type: "danger", icon: "fa-circle-xmark" });
    for (const reason of (state.saveAdvReasons ?? [])) {
      tags.push({ label: reason, type: "buff", icon: "fa-arrow-up" });
    }
    for (const reason of (state.saveDisadvReasons ?? [])) {
      tags.push({ label: reason, type: "debuff", icon: "fa-arrow-down" });
    }
    if (state.superSaver) tags.push({ label: "EVASION → SAVE PASS = 0 DMG", type: "buff", icon: "fa-person-running" });
    if (state.semiSuperSaver) tags.push({ label: "SHIELD MASTER → SAVE PASS = 0 DMG (reaction)", type: "buff", icon: "fa-shield" });
    if (state.magicResistance) tags.push({ label: "MAGIC RESISTANCE → SAVE ADVANTAGE vs SPELLS", type: "buff", icon: "fa-hat-wizard" });

    for (const bonus of (state.saveBonuses ?? [])) {
      tags.push({ label: `SAVE BONUS: ${bonus.value} (${bonus.label})`, type: "buff", icon: "fa-plus" });
    }

    return tags;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  HELPERS
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Smart detection: is this ACTUALLY a ranged weapon/attack?
   * Cross-checks weapon type, properties, and range against actionType.
   * Catches misconfigured items like a longbow set to "mwak".
   */
  static _isActuallyRanged(item, actionType, distanceToTarget = null) {
    if (!item) return false;
    const sys = item.system ?? {};
    const props = sys.properties ?? new Set();

    // If actionType already says ranged, trust it
    if (["rwak", "rsak"].includes(actionType)) return true;

    // Check weapon type classification
    const weaponType = sys.type?.value ?? "";
    if (["simpleR", "martialR"].includes(weaponType)) return true;

    // Check for ammunition property (bows, crossbows)
    if (props.has("amm")) return true;

    // ── Thrown weapons (spear, javelin, handaxe, dagger) ──
    //
    // v0.4.22.7 FIX: Previously this returned `false` (= melee) on any thrown
    // weapon, on the assumption that dnd5e would set actionType to "rwak" when
    // actually throwing. But dnd5e 5.x doesn't always do that — actionType can
    // stay "mwak" even when the player is throwing the weapon at long range.
    // Result: a player throwing a spear from 30ft was getting flanking
    // advantage as if it were a melee attack, because flanking only gates on
    // `isMelee` (which was true).
    //
    // Correct test: distance to target. Thrown weapons used within melee reach
    // (5ft) are melee swings; anything further is a thrown attack and counts
    // as ranged for flanking, ranged-disadvantage-from-adjacent-hostile, etc.
    if (props.has("thr")) {
      if (Number.isFinite(distanceToTarget) && distanceToTarget > 5) {
        return true; // throwing — distance > melee reach
      }
      return false; // melee swing or no distance available
    }

    // Check range — if normal range is significantly more than melee range, it's ranged
    const normalRange = sys.range?.value ?? 0;
    const longRange = sys.range?.long ?? 0;
    if (normalRange > 10 && longRange > 0) return true;
    // Even without long range, if normal range > 30ft it's clearly ranged
    if (normalRange > 30) return true;

    // If it's a spell with range > 10ft and actionType is msak, could be ranged
    // But msak is explicitly melee spell attack, so leave it
    if (item.type === "spell" && ["rsak"].includes(actionType)) return true;

    return false;
  }

  /** Get all statuses from an actor — checks actor.statuses + effects + token */
  static _getStatuses(actor, token = null) {
    const statuses = new Set(actor.statuses ?? []);
    // Also check effects directly
    for (const effect of actor.effects ?? []) {
      if (effect.disabled) continue;
      for (const s of (effect.statuses ?? [])) statuses.add(s);
    }
    // Check token document
    if (token?.document?.hasStatusEffect) {
      // Can't iterate all, but at least we have the Set from above
    }
    return statuses;
  }

  /**
   * Flanking check — line-through method.
   * Draw a line from attacker through target center. If an ally is within
   * 5ft of the target on the opposite side of that line, flanking applies.
   */
  /**
   * @returns {string|null} Name of the flanking ally if found, else null.
   */
  static _isFlanking(attackerActor, targetToken) {
    if (!canvas.tokens?.placeables) return null;

    const atkToken = attackerActor.getActiveTokens?.()?.[0];
    if (!atkToken) return null;

    const atkCenter = atkToken.center;
    const tgtCenter = targetToken.center;
    const atkDisposition = atkToken.document?.disposition ?? 1;

    // Normalized vector from target to attacker
    const atkDx = atkCenter.x - tgtCenter.x;
    const atkDy = atkCenter.y - tgtCenter.y;
    const atkLen = Math.hypot(atkDx, atkDy);
    if (atkLen < 1) return null;
    const atkNx = atkDx / atkLen;
    const atkNy = atkDy / atkLen;

    // Angle threshold scales with target size — small creatures are strict
    // (perfect geometry from adjacent squares), large ones get more leeway
    // because tokens can't always land exactly opposite across a 3x3 / 4x4 body.
    //   Medium (1x1): ±32° (-0.85)  — RAW-tight
    //   Large  (2x2): ±40° (-0.77)
    //   Huge   (3x3): ±50° (-0.64)
    //   Garg   (4x4+): ±60° (-0.5)
    const targetSize = Math.max(
      targetToken.document?.width  ?? 1,
      targetToken.document?.height ?? 1,
    );
    const FLANK_DOT_THRESHOLD =
        targetSize <= 1 ? -0.85
      : targetSize <= 2 ? -0.77
      : targetSize <= 3 ? -0.64
      :                   -0.5;

    // Per RAW (DMG p251): both attackers must be ADJACENT to the target (5ft).
    // _getDistance() measures edge-to-edge, so this works for ALL target sizes:
    //   - Medium target: ally must be in one of the 8 adjacent squares (5ft)
    //   - Gargantuan target: ally must be touching one of its edges (0–5ft)
    // Reach weapons explicitly do NOT grant flanking per RAW.
    const FLANK_MAX_DISTANCE = 5;

    // v0.4.22.4: Flank logging gated behind its own setting (debugFlankLogging)
    // because flank resolution is EXTREMELY verbose (15-25 lines per target check).
    // Users who want general debug output via debugMode should not be flooded
    // with flank spam every attack roll.
    let dbg = false;
    try {
      dbg = game.settings.get(MODULE_ID, "debugFlankLogging");
    } catch (_) { /* setting not registered yet during boot */ }
    const log = (...args) => { if (dbg) console.log("ace-qol | FLANK |", ...args); };
    log(`Checking flanking for ${attackerActor.name} → ${targetToken.name}`);
    log(`  Attacker vector: (${atkNx.toFixed(2)}, ${atkNy.toFixed(2)})`);

    for (const token of canvas.tokens.placeables) {
      if (!token.actor || token.actor.id === attackerActor.id) continue;
      if (token.id === targetToken.id) continue;

      const tokName = token.document?.name ?? token.name ?? token.actor?.name ?? "ally";

      // Must be same disposition (ally)
      if (token.document?.disposition !== atkDisposition) {
        log(`  ✗ ${tokName}: different disposition (${token.document?.disposition} vs ${atkDisposition})`);
        continue;
      }

      // ── Must be a CONSCIOUS, COMBAT-CAPABLE ally ──
      const ally = token.actor;
      const blockingStatuses = ["incapacitated", "unconscious", "dead", "paralyzed", "petrified", "stunned"];
      const blocker = blockingStatuses.find(s => ally.statuses?.has(s));
      if (blocker) { log(`  ✗ ${tokName}: status "${blocker}"`); continue; }

      const allyHp = ally.system?.attributes?.hp?.value;
      if (allyHp !== undefined && allyHp !== null && allyHp <= 0) {
        log(`  ✗ ${tokName}: HP ${allyHp}`); continue;
      }

      const combatant = game.combat?.combatants?.find(c => c.token?.id === token.document?.id);
      if (combatant?.defeated) { log(`  ✗ ${tokName}: marked defeated`); continue; }

      // Must be within melee reach of the target.
      // RAW (DMG p251): adjacent = 5ft. Houserule: if ally has a reach weapon
      // equipped (Glaive, Halberd, Pike, Whip, Lance, etc.), they can flank
      // from 10ft when the `flankingAllowReachWeapons` setting is on.
      const distToTarget = CombatState._getDistance(token, targetToken);
      let maxDist = FLANK_MAX_DISTANCE;
      let usedReach = false;
      try {
        if (game.settings.get(MODULE_ID, "flankingAllowReachWeapons")) {
          const hasEquippedReach = (ally.items?.contents ?? []).some(it => {
            if (it.type !== "weapon") return false;
            if (!it.system?.equipped) return false;
            const props = it.system?.properties;
            if (props?.has?.("rch"))     return true;  // Set
            if (Array.isArray(props) && props.includes("rch")) return true;
            if (props && typeof props === "object" && props.rch) return true;
            return false;
          });
          if (hasEquippedReach) { maxDist = 10; usedReach = true; }
        }
      } catch (_) { /* setting not registered yet */ }

      if (distToTarget > maxDist) {
        log(`  ✗ ${tokName}: distance ${distToTarget}ft > ${maxDist}ft (not in melee reach of target)`);
        continue;
      }

      // Angle check
      const allyCenter = token.center;
      const allyDx = allyCenter.x - tgtCenter.x;
      const allyDy = allyCenter.y - tgtCenter.y;
      const allyLen = Math.hypot(allyDx, allyDy);
      if (allyLen < 1) { log(`  ✗ ${tokName}: same position as target?`); continue; }
      const allyNx = allyDx / allyLen;
      const allyNy = allyDy / allyLen;
      const dot = (atkNx * allyNx) + (atkNy * allyNy);
      const angleDeg = (Math.acos(Math.max(-1, Math.min(1, dot))) * 180 / Math.PI).toFixed(0);

      if (dot <= FLANK_DOT_THRESHOLD) {
        log(`  ✓ ${tokName}: distance=${distToTarget}ft, ally-vector (${allyNx.toFixed(2)}, ${allyNy.toFixed(2)}), dot=${dot.toFixed(2)}, angle=${angleDeg}° → FLANKING`);
        return tokName;
      } else {
        log(`  ✗ ${tokName}: ally-vector (${allyNx.toFixed(2)}, ${allyNy.toFixed(2)}), dot=${dot.toFixed(2)}, angle=${angleDeg}° (need ≤ ${FLANK_DOT_THRESHOLD}, i.e. ≥ ~148°)`);
      }
    }

    log(`  → No flanking ally found.`);
    return null;
  }

  /** Check if actor has a named feature/feat */
  /**
   * Determine which 5e ruleset (2014 vs 2024) is active for a given actor.
   * Single source of truth for every edition-aware feature implementation.
   *
   * Resolution order:
   *   1. ACE QOL world setting `gameRulesEdition` = "2014" or "2024"
   *      → hard override; return that regardless of system state.
   *   2. Setting = "auto" → read the dnd5e system's own setting
   *      `dnd5e.rulesVersion`:
   *        - "legacy" → "2014"
   *        - "modern" → "2024"
   *      This is the most reliable signal: compendium items are loaded
   *      and stamped with mechanics for whichever edition the system is
   *      set to, so the system setting is the actual source of truth.
   *   3. If the system setting cannot be read (very old dnd5e versions),
   *      fall back to sniffing the actor's items for 2024-only markers
   *      (weapon mastery field, Innate Sorcery feat, Weapon Mastery feat).
   *   4. Final fallback "2014" — market data as of 2026 shows ~50% of
   *      players want 2014 vs ~25% who want 2024. Defaulting to the
   *      larger base is the safer wrong answer when truly uncertain.
   *
   * @param {Actor} actor — Actor to sniff for tertiary auto-detection
   * @returns {"2014" | "2024"}
   */
  static getActiveEdition(actor) {
    // 1. Hard override from ACE QOL setting
    let setting = "auto";
    try { setting = game.settings.get(MODULE_ID, "gameRulesEdition"); }
    catch (_) { /* setting unregistered → fall through */ }
    if (setting === "2014" || setting === "2024") return setting;

    // 2. Primary auto signal: read dnd5e system's own rulesVersion setting
    try {
      const rv = game.settings.get("dnd5e", "rulesVersion");
      if (rv === "legacy") return "2014";
      if (rv === "modern") return "2024";
    } catch (_) { /* setting unavailable on this dnd5e version → fall through */ }

    // 3. Tertiary fallback: sniff the actor's items for 2024-specific markers
    if (actor?.items) {
      for (const it of actor.items) {
        // 2024 weapons carry a `mastery` field on system that 2014 weapons
        // never had. Any populated mastery = 2024 schema in use.
        if (it.type === "weapon" && it.system?.mastery) return "2024";
        // 2024-exclusive feats / features
        const nameLower = String(it.name ?? "").toLowerCase();
        if (nameLower === "innate sorcery") return "2024";
        if (nameLower === "weapon mastery") return "2024";
      }
    }

    // 4. Final fallback — no markers, no system setting → assume 2014
    return "2014";
  }

  /**
   * Same resolution as getActiveEdition() but returns the dnd5e system's own
   * vocabulary ("legacy"/"modern"). Use this ANYWHERE that previously read
   * `game.settings.get("dnd5e","rulesVersion")` directly, so the ACE QOL
   * `gameRulesEdition` master override is honored everywhere — not just half
   * the system. ("2024" → "modern", "2014" → "legacy".)
   * @param {Actor} [actor]
   * @returns {"legacy" | "modern"}
   */
  static getActiveRulesVersion(actor) {
    return CombatState.getActiveEdition(actor) === "2024" ? "modern" : "legacy";
  }

  static _hasFeature(actor, name) {
    const lower = name.toLowerCase();
    return actor.items?.some(i =>
      (i.type === "feat" || i.type === "class") && i.name?.toLowerCase().includes(lower)
    ) ?? false;
  }

  /** Check if actor has a named active effect */
  static _hasEffect(actor, name) {
    const lower = name.toLowerCase();
    return actor.effects?.some(e =>
      !e.disabled && e.name?.toLowerCase().includes(lower)
    ) ?? false;
  }

  /** Check if a hostile creature is within range of the attacker */
  static _isHostileNearAttacker(attackerActor, targetToken, rangeFt = 5) {
    if (!canvas.tokens?.placeables) return false;
    const atkToken = attackerActor.getActiveTokens?.()?.[0];
    if (!atkToken) return false;

    const atkDisposition = atkToken.document?.disposition ?? 1;

    for (const token of canvas.tokens.placeables) {
      if (!token.actor || token.actor.id === attackerActor.id) continue;
      if (token.id === targetToken?.id) continue; // Target itself doesn't count for this rule

      const disp = token.document?.disposition ?? 0;
      // Hostile = opposite disposition
      if (disp === atkDisposition) continue; // Same team
      if (token.actor.statuses?.has("incapacitated") || token.actor.statuses?.has("unconscious")) continue;

      const dist = CombatState._getDistance(atkToken, token);
      if (dist <= rangeFt) return true;
    }
    return false;
  }

  /** Check if an ally is near a target */
  static _isAllyNearTarget(attacker, targetToken, rangeFt = 5) {
    if (!canvas.tokens?.placeables) return false;
    const atkDisposition = attacker.prototypeToken?.disposition ?? attacker.token?.disposition ?? 1;

    // v0.4.22.8: Match the blocking-status set already used by `_isFlanking`.
    // The previous check only excluded `incapacitated` and `unconscious`,
    // which let DEAD allies (token still on canvas with status="dead") count
    // as "near target." Symptom: Jeth was getting Sneak Attack on every
    // attack near Lord Soth because Dorian Blackthorne's corpse was
    // adjacent. Pack Tactics had the same blind spot since it uses this
    // function too. RAW: only conscious, combat-capable allies provide the
    // distraction needed for these features.
    const blockingStatuses = ["incapacitated", "unconscious", "dead", "paralyzed", "petrified", "stunned"];

    for (const token of canvas.tokens.placeables) {
      if (!token.actor || token.actor.id === attacker.id) continue;
      if (token.id === targetToken.id) continue;
      if (token.document?.disposition !== atkDisposition) continue;

      // Status block — dead/incapacitated/etc. allies don't count
      if (blockingStatuses.some(s => token.actor.statuses?.has(s))) continue;

      // HP block — token at 0 HP doesn't count even if no status set
      const allyHp = token.actor.system?.attributes?.hp?.value;
      if (allyHp !== undefined && allyHp !== null && allyHp <= 0) continue;

      // Defeated-combatant block — combat tracker explicitly defeated
      const combatant = game.combat?.combatants?.find(c => c.token?.id === token.document?.id);
      if (combatant?.defeated) continue;

      const dist = CombatState._getDistance(token, targetToken);
      if (dist <= rangeFt) return true;
    }
    return false;
  }

  /**
   * Check if any HOSTILE creature is within `rangeFt` of the attacker.
   * Used for ranged-attack-in-melee disadvantage (PHB 195): a hostile
   * within 5ft who can see you AND isn't incapacitated triggers it.
   */
  static _hasHostileWithinReach(attacker, rangeFt = 5) {
    if (!canvas.tokens?.placeables) return false;
    const atkDisposition = attacker.prototypeToken?.disposition ?? attacker.token?.disposition ?? 1;
    // Find the attacker's token on canvas
    const atkToken = attacker.getActiveTokens?.()?.[0]
                  ?? canvas.tokens.placeables.find(t => t.actor?.id === attacker.id);
    if (!atkToken) return false;

    for (const token of canvas.tokens.placeables) {
      if (!token.actor || token.actor.id === attacker.id) continue;
      // Hostile = opposite disposition
      if (token.document?.disposition === atkDisposition) continue;
      if (token.document?.disposition === 0) continue; // neutral doesn't trigger
      // RAW: hostile must be able to see + not incapacitated
      if (token.actor.statuses?.has("incapacitated") || token.actor.statuses?.has("unconscious")
       || token.actor.statuses?.has("paralyzed") || token.actor.statuses?.has("petrified")
       || token.actor.statuses?.has("stunned") || token.actor.statuses?.has("blinded")) continue;

      const dist = CombatState._getDistance(atkToken, token);
      if (dist <= rangeFt) return true;
    }
    return false;
  }

  /**
   * Get distance between two tokens using EDGE-TO-EDGE measurement.
   * D&D 5e rule: distance is from the nearest edge of one creature's
   * space to the nearest edge of the other's. This handles Large (2×2),
   * Huge (3×3), and Gargantuan (4×4) tokens correctly — adjacent tokens
   * are always 5ft apart regardless of size.
   */
  // Nearest-edge, size-aware, 3D-aware distance in feet. Canonical math lives in
  // geometry-utils.mjs (aceDistanceFt) so every reach/range check in the suite
  // agrees with the in-game ruler. This wrapper is kept for existing callers.
  static _getDistance(token1, token2) {
    return aceDistanceFt(token1, token2);
  }

  /** Get Aura of Protection bonus from a nearby paladin (or the target's
   *  OWN aura, since RAW PHB: "you OR a friendly creature within 10 feet"
   *  — the paladin's own aura applies to their own saves). */
  static _getAuraOfProtectionBonus(targetToken) {
    if (!canvas.tokens?.placeables) return 0;
    let bestBonus = 0;

    for (const token of canvas.tokens.placeables) {
      if (!token.actor) continue;
      // NOTE: do NOT skip the target itself. RAW the paladin's aura applies
      // to themselves too. "you or a friendly creature within 10 feet" (PHB).
      // Self-distance is 0, naturally within range.

      // Same team — but for self this is always true so it auto-passes
      if (token.document?.disposition !== targetToken.document?.disposition) continue;
      // Has Aura of Protection
      if (!CombatState._hasFeature(token.actor, "Aura of Protection")) continue;
      // Not incapacitated (per RAW the aura suppresses if paladin is unconscious)
      if (token.actor.statuses?.has("incapacitated")) continue;
      if (token.actor.statuses?.has("unconscious"))   continue;

      const dist = CombatState._getDistance(token, targetToken);
      // 10ft base, 30ft at 18th level
      const paladinLevel = token.actor.items?.find(i => i.type === "class" && i.name?.toLowerCase().includes("paladin"))?.system?.levels ?? 0;
      const auraRange = paladinLevel >= 18 ? 30 : 10;

      if (dist <= auraRange) {
        const chaMod = token.actor.system?.abilities?.cha?.mod ?? 0;
        if (chaMod > bestBonus) bestBonus = chaMod;
      }
    }
    return bestBonus;
  }

  /** Check Sneak Attack eligibility */
  static _checkSneakAttack(attacker, targetToken, item, isMelee, hasAdvantage, hasDisadvantage = false) {
    const sneakFeature = attacker.items?.find(i =>
      i.type === "feat" && i.name?.toLowerCase().includes("sneak attack")
    );
    if (!sneakFeature) return { eligible: false };

    // RAW disadvantage block (PHB p.196 / 2024 PHB equivalent):
    //   "You don't need advantage on the attack roll if another enemy of
    //   the target is within 5 feet of it, that enemy isn't Incapacitated,
    //   AND YOU DON'T HAVE DISADVANTAGE ON THE ATTACK ROLL."
    // Even with advantage, RAW also bars Sneak Attack if disadvantage is
    // present — but at our call site advantage+disadvantage already cancel
    // to NORMAL, so hasAdvantage would be false then. The case this guard
    // catches is "ally adjacent, but I have disadvantage" — fully RAW.
    if (hasDisadvantage) {
      return { eligible: false, reason: "Disadvantage blocks Sneak Attack (RAW)" };
    }

    // Eligibility: Finesse OR Ranged weapon (RAW).
    // dnd5e 5.x moved actionType onto Activity objects, so `item.system.actionType`
    // is often undefined for native imports. We detect "ranged" through several
    // robust paths instead of trusting a single field:
    //   1. item.system.actionType === "rwak"             (legacy item-level)
    //   2. item.system.type.value matches simpleR/martialR (2024 weapon-type schema)
    //   3. ANY activity on the item is actionType "rwak"  (5.x activity model)
    //   4. weapon has ammunition property "amm"          (bow/crossbow proxy)
    const props = item?.system?.properties ?? new Set();
    const isFinesse = props.has?.("fin");

    const typeVal = String(item?.system?.type?.value ?? "");
    const acts = item?.system?.activities;
    const actsList = acts instanceof Map ? [...acts.values()]
                   : acts && typeof acts === "object" ? Object.values(acts) : [];
    const anyRangedActivity = actsList.some(act =>
      act?.actionType === "rwak" || act?.type === "rwak"
    );

    const isRanged = item?.system?.actionType === "rwak"
                  || /^(simpleR|martialR|R)$/i.test(typeVal)
                  || anyRangedActivity
                  || props.has?.("amm");

    if (!isFinesse && !isRanged) {
      return { eligible: false, reason: "Weapon not finesse or ranged" };
    }

    const allyNearby = CombatState._isAllyNearTarget(attacker, targetToken, 5);
    if (hasAdvantage || allyNearby) {
      const rogueClass = attacker.items?.find(i => i.type === "class" && i.name?.toLowerCase() === "rogue");
      const dice = Math.ceil((rogueClass?.system?.levels ?? 1) / 2);
      return {
        eligible: true, name: "Sneak Attack", formula: `${dice}d6`,
        type: item?.system?.damage?.parts?.[0]?.[1] ?? "piercing",
        reason: hasAdvantage ? "Sneak Attack (have advantage)" : "Sneak Attack (ally within 5ft)",
      };
    }
    return { eligible: false, reason: "No advantage and no ally near target" };
  }

  /** Get class level by name (e.g., "paladin", "barbarian") */
  static _getClassLevel(actor, className) {
    for (const item of actor.items ?? []) {
      if (item.type === "class" && item.name?.toLowerCase().includes(className.toLowerCase())) {
        return item.system?.levels ?? 0;
      }
    }
    return 0;
  }

  /** Get Rage damage bonus by barbarian level */
  static _getRageDamageBonus(actor) {
    const barbClass = actor.items?.find(i => i.type === "class" && i.name?.toLowerCase().includes("barbarian"));
    const level = barbClass?.system?.levels ?? 0;
    if (level >= 16) return 4;
    if (level >= 9) return 3;
    if (level >= 1) return 2;
    return 0;
  }

  /** Get all damage types from an item */
  static _getItemDamageTypes(item) {
    const types = new Set();
    const sys = item?.system ?? {};
    if (sys.activities) {
      const actList = (typeof sys.activities.forEach === "function")
        ? [...(sys.activities.values?.() ?? sys.activities)]
        : (typeof sys.activities === "object" ? Object.values(sys.activities) : []);
      for (const activity of actList) {
        if (!activity?.damage?.parts) continue;
        for (const part of activity.damage.parts) {
          if (part.types) for (const t of part.types) types.add(t);
        }
      }
    }
    if (sys.damage?.parts) {
      for (const part of sys.damage.parts) { if (part[1]) types.add(part[1]); }
    }
    return [...types];
  }

  /** Debug logging */
  static _debugLog(state) {
    try { if (!game.settings.get(MODULE_ID, "debugMode")) return; } catch { return; }
    const advSrc = state.advantageSources.map(s => s.reason).join("; ") || "none";
    const disSrc = state.disadvantageSources.map(s => s.reason).join("; ") || "none";
    console.log(`${MODULE_ID} | COMBAT STATE: ${state.attacker.name} → ${state.target.name}`);
    console.log(`  Roll: ${state.finalRollMode} | Adv: [${advSrc}] | Disadv: [${disSrc}]`);
    console.log(`  AutoCrit: ${state.autoCrit} | CritRange: ${state.critRange}-20 | Slayer: ${state.slayerMatch ? state.slayerType : "no"}`);
    console.log(`  Target AC: ${state.target.ac} | HP: ${state.target.currentHP}/${state.target.maxHP}`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Radiant Soul (Celestial Warlock 6+)
  //
  //  RAW: "Once per turn when you deal fire or radiant damage with a spell or
  //  cantrip, you can add your Charisma modifier to that damage."
  //
  //  Triggers in two places in our pipeline:
  //    1. Direct spell damage in save-engine._rollSpellDamage
  //    2. Spell-derived weapon riders (Divine Smite, smite spells) when they
  //       roll fire/radiant damage attached to a weapon attack
  //
  //  Once-per-turn enforced via actor flag, cleared on combatTurnChange.
  //  Out-of-combat usage clears the flag immediately after firing (no
  //  multi-trigger spam from a flurry of spells, but no permanent block
  //  if the actor isn't in combat).
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Returns the Radiant Soul bonus value (CHA mod) if it applies, else 0.
   * Does NOT mark the flag — caller must call markRadiantSoulUsed() after
   * actually applying the bonus to a damage component.
   *
   * @param {Actor} actor - The attacking/casting actor
   * @param {string} damageType - The damage type being dealt (case-insensitive)
   * @returns {number} CHA modifier or 0 if not applicable
   */
  static getRadiantSoulBonus(actor, damageType) {
    if (!actor || !damageType) return 0;

    // Setting kill switch
    try {
      if (game.settings.get(MODULE_ID, "radiantSoulRiderEnabled") === false) return 0;
    } catch (_) { /* setting not registered yet — proceed */ }

    // Type gate — RAW: fire OR radiant only
    const t = String(damageType).toLowerCase();
    if (t !== "radiant" && t !== "fire") return 0;

    // Feature presence — match by name (handles Celestial Warlock 6+ feature
    // entry from D&D Beyond importer + native dnd5e content)
    if (!CombatState._hasFeature(actor, "Radiant Soul")) return 0;

    // Once-per-turn check
    try {
      if (actor.getFlag?.(MODULE_ID, "radiantSoul.usedThisTurn")) return 0;
    } catch (_) { /* flag access failed — treat as unused */ }

    const chaMod = Number(actor.system?.abilities?.cha?.mod ?? 0);
    if (chaMod <= 0) return 0;

    return chaMod;
  }

  /**
   * Mark Radiant Soul as used for the current turn. Call this AFTER applying
   * the bonus to a damage component so subsequent damage in the same turn
   * skips it.
   * @param {Actor} actor
   */
  static async markRadiantSoulUsed(actor) {
    if (!actor) return;
    try {
      await actor.setFlag(MODULE_ID, "radiantSoul.usedThisTurn", true);
    } catch (err) {
      console.warn(`${MODULE_ID} | Failed to mark Radiant Soul used:`, err);
    }
  }

  /**
   * Clear the Radiant Soul once-per-turn flag. Called from the
   * combatTurnChange hook when this actor's turn ends, and from combatEnd
   * for cleanup.
   * @param {Actor} actor
   */
  static async clearRadiantSoulFlag(actor) {
    if (!actor) return;
    try {
      if (actor.getFlag?.(MODULE_ID, "radiantSoul.usedThisTurn")) {
        await actor.unsetFlag(MODULE_ID, "radiantSoul.usedThisTurn");
      }
    } catch (_) { /* non-fatal */ }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Empowered Evocation (Wizard, Evocation School, 10th+) — v0.7.12
  //
  //  RAW: "you can add your Intelligence modifier to one damage roll of any
  //  wizard evocation spell you cast." No per-turn limit (the limit is "one
  //  damage roll per spell cast"). Auto-applied to evocation-school spells.
  // ═══════════════════════════════════════════════════════════════════════════

  /** Returns INT mod if actor has Empowered Evocation, else 0. */
  static getEmpoweredEvocationBonus(actor) {
    if (!actor) return 0;
    try {
      if (game.settings.get(MODULE_ID, "empoweredEvocationEnabled") === false) return 0;
    } catch (_) { /* setting not registered yet — proceed */ }
    if (!CombatState._hasFeature(actor, "Empowered Evocation")) return 0;
    const intMod = Number(actor.system?.abilities?.int?.mod ?? 0);
    return intMod > 0 ? intMod : 0;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Agonizing Blast (Warlock invocation) — v0.7.12
  //
  //  RAW: "When you cast eldritch blast, add your Charisma modifier to the
  //  damage it deals on a hit." Adds CHA mod to EACH BEAM. Eldritch Blast
  //  rolls more beams as the caster levels up (1 at 1st, 2 at 5th, 3 at 11th,
  //  4 at 17th). Each beam gets the CHA mod independently.
  // ═══════════════════════════════════════════════════════════════════════════

  /** Returns CHA mod if actor has Agonizing Blast invocation, else 0. */
  static getAgonizingBlastBonus(actor) {
    if (!actor) return 0;
    try {
      if (game.settings.get(MODULE_ID, "agonizingBlastEnabled") === false) return 0;
    } catch (_) { /* setting not registered yet — proceed */ }
    if (!CombatState._hasFeature(actor, "Agonizing Blast")) return 0;
    const chaMod = Number(actor.system?.abilities?.cha?.mod ?? 0);
    return chaMod > 0 ? chaMod : 0;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Potent Spellcasting (Cleric 8+, Druid 8+) — v0.7.12
  //
  //  RAW (Cleric): "When you cast a cleric cantrip that deals damage, you can
  //  add your Wisdom modifier to the damage." Same for Druid (with druid
  //  cantrips). Adds WIS mod to cantrip damage. Once per cantrip cast.
  //
  //  We don't gate on "is this a cleric/druid cantrip specifically" because
  //  dnd5e doesn't reliably tag spell list ownership. The feature presence
  //  check (actor has "Potent Spellcasting") + cantrip-level check (spell
  //  level === 0) is sufficient — a Wizard with multi-class Cleric who has
  //  Potent Spellcasting will also benefit from their Wizard cantrips per
  //  some RAI readings, and the GM can disable per-instance if strict.
  // ═══════════════════════════════════════════════════════════════════════════

  /** Returns WIS mod if actor has Potent Spellcasting, else 0. */
  static getPotentSpellcastingBonus(actor) {
    if (!actor) return 0;
    try {
      if (game.settings.get(MODULE_ID, "potentSpellcastingEnabled") === false) return 0;
    } catch (_) { /* setting not registered yet — proceed */ }
    if (!CombatState._hasFeature(actor, "Potent Spellcasting")) return 0;
    const wisMod = Number(actor.system?.abilities?.wis?.mod ?? 0);
    return wisMod > 0 ? wisMod : 0;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Divine Strike / Blessed Strikes (Cleric 8+) — Once-per-turn enforcement
  //
  //  RAW (PHB Cleric): "Once on each of your turns when you hit a creature
  //  with a weapon attack, you can cause the attack to deal an extra 1d8
  //  [type] damage."
  //
  //  Mirrors the Radiant Soul pattern: combat-state push-side checks the
  //  flag; damage-calculator consume-side calls markDivineStrikeUsed after
  //  applying the bonus; combatTurnChange handler calls clearDivineStrikeFlag
  //  when the actor's turn ends.
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Mark Divine Strike / Blessed Strikes as used for the current turn.
   * Call this AFTER applying the bonus to a damage component so subsequent
   * weapon attacks in the same turn skip it.
   * @param {Actor} actor
   */
  static async markDivineStrikeUsed(actor) {
    if (!actor) return;
    try {
      await actor.setFlag(MODULE_ID, "divineStrike.usedThisTurn", true);
    } catch (err) {
      console.warn(`${MODULE_ID} | Failed to mark Divine Strike used:`, err);
    }
  }

  /**
   * Clear the Divine Strike once-per-turn flag. Called from the
   * combatTurnChange hook when this actor's turn ends.
   * @param {Actor} actor
   */
  static async clearDivineStrikeFlag(actor) {
    if (!actor) return;
    try {
      if (actor.getFlag?.(MODULE_ID, "divineStrike.usedThisTurn")) {
        await actor.unsetFlag(MODULE_ID, "divineStrike.usedThisTurn");
      }
    } catch (_) { /* non-fatal */ }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Empowered Evocation (Wizard Evoker 10+)
  //
  //  RAW (PHB Wizard / Evocation subclass at 10th level): "You can add your
  //  INT modifier to one damage roll of any wizard evocation spell you cast."
  //
  //  Per cast (not per turn). Applies to the FIRST damage roll only. No flag
  //  tracking needed — we mutate one damage component per cast.
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Returns the Empowered Evocation bonus (INT mod) if it applies, else 0.
   * @param {Actor} actor — the casting actor
   * @param {Item}  spellItem — the spell being cast (must be a spell item)
   * @returns {number}
   */
  static getEmpoweredEvocationBonus(actor, spellItem) {
    if (!actor || !spellItem) return 0;
    if (spellItem.type !== "spell") return 0;

    // Feature presence check
    if (!CombatState._hasFeature(actor, "Empowered Evocation")) return 0;

    // Spell must be an evocation. dnd5e uses short codes ("evo", "abj", etc.)
    const school = String(spellItem.system?.school ?? "").toLowerCase();
    if (school !== "evo" && school !== "evocation") return 0;

    const intMod = Number(actor.system?.abilities?.int?.mod ?? 0);
    return intMod > 0 ? intMod : 0;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Agonizing Blast (Warlock invocation, requires Eldritch Blast)
  //
  //  RAW (PHB Warlock invocations): "When you cast eldritch blast, add your
  //  Charisma modifier to the damage it deals on a hit."
  //
  //  Applies to EVERY beam of Eldritch Blast (not once per cast — once per
  //  damage roll). No flag tracking.
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Returns the Agonizing Blast bonus (CHA mod) if it applies, else 0.
   * @param {Actor} actor — the casting actor
   * @param {Item}  spellItem — must be the Eldritch Blast cantrip
   * @returns {number}
   */
  static getAgonizingBlastBonus(actor, spellItem) {
    if (!actor || !spellItem) return 0;
    if (spellItem.type !== "spell") return 0;

    // Spell must be Eldritch Blast specifically. Match by name (case-insensitive)
    // — dnd5e doesn't have a stable "isEldritchBlast" flag, and the spell can
    // exist under several compendium variants.
    const name = String(spellItem.name ?? "").toLowerCase();
    if (name !== "eldritch blast") return 0;

    // Feature presence — Agonizing Blast is typically a feat / invocation item.
    if (!CombatState._hasFeature(actor, "Agonizing Blast")) return 0;

    const chaMod = Number(actor.system?.abilities?.cha?.mod ?? 0);
    return chaMod > 0 ? chaMod : 0;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Potent Spellcasting (Cleric Light Domain 8+, Druid Circle of the Land 14+)
  //
  //  RAW (PHB Cleric Light Domain / Druid Land subclass): "You add your WIS
  //  modifier to the damage you deal with any cleric [or druid] cantrip."
  //
  //  Applies to every cantrip damage roll. No once-per-turn.
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Returns the Potent Spellcasting bonus (WIS mod) if it applies, else 0.
   * @param {Actor} actor — the casting actor
   * @param {Item}  spellItem — must be a cantrip (level 0)
   * @returns {number}
   */
  static getPotentSpellcastingBonus(actor, spellItem) {
    if (!actor || !spellItem) return 0;
    if (spellItem.type !== "spell") return 0;

    // Cantrip-only (level 0)
    const level = Number(spellItem.system?.level ?? -1);
    if (level !== 0) return 0;

    // Feature presence — Light Domain Cleric or Land Druid both have a
    // feature named "Potent Spellcasting" in the SRD content.
    if (!CombatState._hasFeature(actor, "Potent Spellcasting")) return 0;

    const wisMod = Number(actor.system?.abilities?.wis?.mod ?? 0);
    return wisMod > 0 ? wisMod : 0;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Divine Smite (Paladin) — 2024 PHB once-per-turn enforcement
  //
  //  2014 PHB allowed Divine Smite on EVERY hit (costs a slot each time).
  //  2024 PHB restricts to once-per-turn AND requires a bonus action.
  //
  //  rider-engine.mjs guards the popup-offer side; this module provides the
  //  mark/clear helpers used by damage-engine post-consume and combatTurnChange.
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Mark Divine Smite as used for the current turn. Called by damage-engine
   * after RiderEngine.consumeResources successfully consumes the spell slot
   * for a Divine Smite rider.
   * @param {Actor} actor
   */
  static async markDivineSmiteUsed(actor) {
    if (!actor) return;
    try {
      await actor.setFlag(MODULE_ID, "divineSmite.usedThisTurn", true);
    } catch (err) {
      console.warn(`${MODULE_ID} | Failed to mark Divine Smite used:`, err);
    }
  }

  /**
   * Clear the Divine Smite once-per-turn flag. Called from combatTurnChange
   * when this actor's turn ends.
   * @param {Actor} actor
   */
  static async clearDivineSmiteFlag(actor) {
    if (!actor) return;
    try {
      if (actor.getFlag?.(MODULE_ID, "divineSmite.usedThisTurn")) {
        await actor.unsetFlag(MODULE_ID, "divineSmite.usedThisTurn");
      }
    } catch (_) { /* non-fatal */ }
  }

  /**
   * Mark Eldritch Smite as used this turn. Set after `consumeResources` runs
   * for an Eldritch Smite rider. RAW (both 2014 and 2024): "Once per turn when
   * you hit a creature with your pact weapon..."
   * @param {Actor} actor
   */
  static async markEldritchSmiteUsed(actor) {
    if (!actor) return;
    try {
      await actor.setFlag(MODULE_ID, "eldritchSmite.usedThisTurn", true);
    } catch (err) {
      console.warn(`${MODULE_ID} | Failed to mark Eldritch Smite used:`, err);
    }
  }

  /**
   * Clear the Eldritch Smite once-per-turn flag. Called from combatTurnChange
   * when this actor's turn ends.
   * @param {Actor} actor
   */
  static async clearEldritchSmiteFlag(actor) {
    if (!actor) return;
    try {
      if (actor.getFlag?.(MODULE_ID, "eldritchSmite.usedThisTurn")) {
        await actor.unsetFlag(MODULE_ID, "eldritchSmite.usedThisTurn");
      }
    } catch (_) { /* non-fatal */ }
  }

  /**
   * Mark Sneak Attack as used this turn. Set when an attacker-bonus carrying
   * `isOncePerTurn === "sneakAttack"` is applied downstream. RAW (2014/2024):
   * "Once per turn, you can deal an extra ... damage when you hit ..."
   * @param {Actor} actor
   */
  static async markSneakAttackUsed(actor) {
    if (!actor) return;
    try {
      await actor.setFlag(MODULE_ID, "sneakAttack.usedThisTurn", true);
    } catch (err) {
      console.warn(`${MODULE_ID} | Failed to mark Sneak Attack used:`, err);
    }
  }

  /**
   * Clear the Sneak Attack once-per-turn flag. Called from combatTurnChange
   * when this actor's turn ends.
   * @param {Actor} actor
   */
  static async clearSneakAttackFlag(actor) {
    if (!actor) return;
    try {
      if (actor.getFlag?.(MODULE_ID, "sneakAttack.usedThisTurn")) {
        await actor.unsetFlag(MODULE_ID, "sneakAttack.usedThisTurn");
      }
    } catch (_) { /* non-fatal */ }
  }

  /** Mark the Cleave weapon mastery used this turn — RAW 2024: once per turn. */
  static async markCleaveUsed(actor) {
    if (!actor) return;
    try {
      await actor.setFlag(MODULE_ID, "cleave.usedThisTurn", true);
    } catch (err) {
      console.warn(`${MODULE_ID} | Failed to mark Cleave used:`, err);
    }
  }

  /** Clear the once-per-turn Cleave flag (turn-end / combat start / combat end). */
  static async clearCleaveFlag(actor) {
    if (!actor) return;
    try {
      if (actor.getFlag?.(MODULE_ID, "cleave.usedThisTurn")) {
        await actor.unsetFlag(MODULE_ID, "cleave.usedThisTurn");
      }
    } catch (_) { /* non-fatal */ }
  }

  // ════════════════════════════════════════════════════════════════════════
  //  HEXBLADE'S CURSE (Warlock — Hexblade Patron, 2014 PHB / Tasha's)
  // ════════════════════════════════════════════════════════════════════════
  //
  //  RAW: As a bonus action, choose one creature within 30 ft. The target is
  //  cursed for 1 minute. While cursed:
  //   • +Proficiency Bonus to damage rolls against the cursed target
  //   • Attack rolls vs cursed target crit on 19-20
  //   • If cursed target dies, you regain HP = warlock level + CHA mod
  //  Curse ends if target dies, you die, or you are incapacitated.
  //
  //  Storage: `flags.ace-qol.hexbladeCurse = { targetUuid, appliedAt }`
  //  Application: `CombatState.applyHexbladeCurse(attacker, targetToken)`
  //  Manual clear: `CombatState.removeHexbladeCurse(attacker)`
  //  Auto-clear:  when cursed target's HP hits 0 (handled in death-pipeline
  //               via the `getCursedTargetUuid` helper) — also fires the
  //               heal-on-kill rebate.

  /**
   * Return the UUID of the token currently cursed by this attacker, or null.
   * @param {Actor} attackerActor
   * @returns {string|null}
   */
  static getCursedTargetUuid(attackerActor) {
    const curse = attackerActor?.getFlag?.(MODULE_ID, "hexbladeCurse");
    if (!curse || typeof curse !== "object") return null;
    return curse.targetUuid ?? null;
  }

  /**
   * Check whether `targetToken` is the current Hexblade-cursed target of
   * `attackerActor`. The damage/crit bonuses RAW only apply to the cursed
   * target — this is the gate used by both check sites in `assess()`.
   * @param {Actor} attackerActor
   * @param {Token|TokenDocument} targetToken
   * @returns {boolean}
   */
  static _isHexbladeCursedTarget(attackerActor, targetToken) {
    const cursedUuid = CombatState.getCursedTargetUuid(attackerActor);
    if (!cursedUuid) return false;
    const tgtUuid = targetToken?.document?.uuid ?? targetToken?.uuid;
    return !!tgtUuid && tgtUuid === cursedUuid;
  }

  /**
   * Apply Hexblade's Curse from `attacker` onto `targetToken`. Stores the
   * target's UUID + a timestamp on the attacker as `flags.ace-qol.hexbladeCurse`.
   * Replaces any existing curse on this attacker (RAW: only one target at a
   * time). Posts a chat card if `opts.silent` is not set.
   *
   * @param {Actor} attackerActor   - The Hexblade warlock applying the curse
   * @param {Token|TokenDocument} targetToken - The token to curse
   * @param {object} [opts]
   * @param {boolean} [opts.silent=false] - Suppress chat card if true
   * @returns {Promise<boolean>} true on success
   */
  static async applyHexbladeCurse(attackerActor, targetToken, opts = {}) {
    if (!attackerActor || !targetToken) {
      console.warn(`${MODULE_ID} | applyHexbladeCurse: attacker or target missing`);
      return false;
    }
    const targetUuid = targetToken?.document?.uuid ?? targetToken?.uuid;
    if (!targetUuid) {
      console.warn(`${MODULE_ID} | applyHexbladeCurse: target has no UUID`);
      return false;
    }
    try {
      await attackerActor.setFlag(MODULE_ID, "hexbladeCurse", {
        targetUuid,
        appliedAt:     Date.now(),
        appliedRound:  game.combat?.round ?? 0,    // for 1-minute (10-round) expiration check
        combatId:      game.combat?.id ?? null,    // distinguishes "applied in this combat" from a stale flag
      });
      console.log(`${MODULE_ID} | Hexblade's Curse applied: ${attackerActor.name} → ${targetToken.name ?? targetUuid}`);
      if (!opts.silent) {
        const tgtName = foundry.utils.escapeHTML(targetToken.name ?? "the target");
        const attName = foundry.utils.escapeHTML(attackerActor.name);
        ChatMessage.create({
          content: `<div class="ace-qol-card" style="background:#1a0a1a; border:2px solid #6c3aaf; border-radius:6px; padding:10px 12px;">
            <div style="display:flex; align-items:center; gap:10px; margin-bottom:4px;">
              <i class="fas fa-skull" style="color:#b388ff; font-size:18px;"></i>
              <strong style="color:#dcc8ff;">Hexblade's Curse</strong>
            </div>
            <div style="color:#dcd0e8; font-size:12px;">
              <strong>${attName}</strong> curses <strong>${tgtName}</strong>.<br>
              <em style="color:#aaa;">+PB damage and 19–20 crit range against the cursed target until it dies or the curse is ended.</em>
            </div>
          </div>`,
          speaker: ChatMessage.getSpeaker({ actor: attackerActor }),
        });
      }
      return true;
    } catch (err) {
      console.error(`${MODULE_ID} | applyHexbladeCurse failed:`, err);
      return false;
    }
  }

  /**
   * Remove Hexblade's Curse from `attackerActor`. Optionally awards the
   * heal-on-kill rebate (warlock level + CHA mod) if `opts.cursedTargetDied`
   * is true. `opts.reason` controls the chat-card flavour (default,
   * "expired", "incapacitated").
   * @param {Actor} attackerActor
   * @param {object} [opts]
   * @param {boolean} [opts.cursedTargetDied=false] - Trigger heal-on-kill
   * @param {string}  [opts.reason]                  - "expired" | "incapacitated" | undefined
   * @param {boolean} [opts.silent=false]            - Suppress chat card
   * @returns {Promise<boolean>}
   */
  static async removeHexbladeCurse(attackerActor, opts = {}) {
    if (!attackerActor) return false;
    const curse = attackerActor.getFlag?.(MODULE_ID, "hexbladeCurse");
    if (!curse) return false;
    try {
      await attackerActor.unsetFlag(MODULE_ID, "hexbladeCurse");
      console.log(`${MODULE_ID} | Hexblade's Curse removed from ${attackerActor.name}${opts.reason ? ` (${opts.reason})` : ""}`);

      // Reason-specific expiry card (skip when heal-on-kill is firing — that
      // card supersedes this one).
      if (!opts.cursedTargetDied && !opts.silent && opts.reason) {
        const attName = foundry.utils.escapeHTML(attackerActor.name);
        const blurb = opts.reason === "expired"
          ? `<strong>${attName}</strong>'s Hexblade's Curse fades — its 1-minute duration expired.`
          : opts.reason === "incapacitated"
            ? `<strong>${attName}</strong> is incapacitated — Hexblade's Curse ends.`
            : `<strong>${attName}</strong>'s Hexblade's Curse ends.`;
        ChatMessage.create({
          content: `<div class="ace-qol-card" style="background:#1a1018; border:2px solid #5a4070; border-radius:6px; padding:10px 12px;">
            <div style="display:flex; align-items:center; gap:10px; margin-bottom:4px;">
              <i class="fas fa-hourglass-end" style="color:#9b88c0; font-size:18px;"></i>
              <strong style="color:#cdc0e0;">Hexblade's Curse — ${opts.reason.toUpperCase()}</strong>
            </div>
            <div style="color:#d8cee8; font-size:12px;">${blurb}</div>
          </div>`,
          speaker: ChatMessage.getSpeaker({ actor: attackerActor }),
        });
      }

      // Heal-on-kill rebate: warlock level + CHA mod (min 1)
      if (opts.cursedTargetDied) {
        const warlockClass = attackerActor.items?.find(i => i.type === "class" && i.name?.toLowerCase().includes("warlock"));
        const warlockLevel = warlockClass?.system?.levels ?? 0;
        const chaMod       = attackerActor.system?.abilities?.cha?.mod ?? 0;
        const heal         = Math.max(1, warlockLevel + chaMod);
        if (heal > 0 && warlockLevel > 0) {
          const currentHP = attackerActor.system?.attributes?.hp?.value ?? 0;
          const maxHP     = attackerActor.system?.attributes?.hp?.max ?? 0;
          const newHP     = Math.min(maxHP, currentHP + heal);
          await attackerActor.update({ "system.attributes.hp.value": newHP });
          if (!opts.silent) {
            const attName = foundry.utils.escapeHTML(attackerActor.name);
            ChatMessage.create({
              content: `<div class="ace-qol-card" style="background:#0a1a0a; border:2px solid #4caf50; border-radius:6px; padding:10px 12px;">
                <div style="display:flex; align-items:center; gap:10px; margin-bottom:4px;">
                  <i class="fas fa-heart" style="color:#a3e8a3; font-size:18px;"></i>
                  <strong style="color:#cfeacf;">Hexblade's Curse — Vengeance</strong>
                </div>
                <div style="color:#d8e8d8; font-size:12px;">
                  <strong>${attName}</strong> regains <strong>${heal} HP</strong> (warlock level ${warlockLevel} + CHA mod ${chaMod >= 0 ? "+" : ""}${chaMod}).
                </div>
              </div>`,
              speaker: ChatMessage.getSpeaker({ actor: attackerActor }),
            });
          }
          console.log(`${MODULE_ID} | Hexblade's Curse heal-on-kill: ${attackerActor.name} +${heal} HP`);
        }
      }
      return true;
    } catch (err) {
      console.error(`${MODULE_ID} | removeHexbladeCurse failed:`, err);
      return false;
    }
  }

  // ════════════════════════════════════════════════════════════════════════
  //  HEX (Warlock 1st-level spell — 2014 PHB / 2024 PHB)
  // ════════════════════════════════════════════════════════════════════════
  //
  //  RAW (2024): "Curse a creature you can see within range. Until the spell
  //  ends, you deal an extra 1d6 necrotic damage to the target whenever you
  //  hit it with an attack. Also, choose one ability when you cast the
  //  spell; the target has disadvantage on ability checks made with the
  //  chosen ability."
  //
  //  Storage: `flags.ace-qol.hex = { targetUuid, appliedAt, combatId }`
  //  Application: auto-applied by the dnd5e.postCreateUsageMessage hook in
  //               ace-qol.mjs when the player casts "Hex". Target is the
  //               activator's currently-targeted token.
  //  Auto-clear:  deleteActiveEffect hook fires when concentration ends.

  static getHexedTargetUuid(attackerActor) {
    const hex = attackerActor?.getFlag?.(MODULE_ID, "hex");
    if (!hex || typeof hex !== "object") return null;
    return hex.targetUuid ?? null;
  }

  static _isHexTarget(attackerActor, targetToken) {
    const hexedUuid = CombatState.getHexedTargetUuid(attackerActor);
    if (!hexedUuid) return false;
    const tgtUuid = targetToken?.document?.uuid ?? targetToken?.uuid;
    return !!tgtUuid && tgtUuid === hexedUuid;
  }

  /**
   * Apply Hex from `attacker` onto `targetToken`. Stores the target's UUID
   * on the attacker. Replaces any existing hex (re-cast moves the curse).
   * @param {Actor} attackerActor
   * @param {Token|TokenDocument} targetToken
   * @param {object} [opts]
   * @param {boolean} [opts.silent=false]
   * @returns {Promise<boolean>}
   */
  static async applyHex(attackerActor, targetToken, opts = {}) {
    if (!attackerActor || !targetToken) return false;
    const targetUuid = targetToken?.document?.uuid ?? targetToken?.uuid;
    if (!targetUuid) return false;
    try {
      await attackerActor.setFlag(MODULE_ID, "hex", {
        targetUuid,
        appliedAt: Date.now(),
        combatId:  game.combat?.id ?? null,
      });
      console.log(`${MODULE_ID} | Hex applied: ${attackerActor.name} → ${targetToken.name ?? targetUuid}`);
      if (!opts.silent) {
        const tgtName = foundry.utils.escapeHTML(targetToken.name ?? "the target");
        const attName = foundry.utils.escapeHTML(attackerActor.name);
        ChatMessage.create({
          content: `<div class="ace-qol-card" style="background:#0a141a; border:2px solid #4a6c7a; border-radius:6px; padding:10px 12px;">
            <div style="display:flex; align-items:center; gap:10px; margin-bottom:4px;">
              <i class="fas fa-spider" style="color:#88c0d0; font-size:18px;"></i>
              <strong style="color:#d0e0ea;">Hex</strong>
            </div>
            <div style="color:#d0d8e0; font-size:12px;">
              <strong>${attName}</strong> hexes <strong>${tgtName}</strong>.<br>
              <em style="color:#aaa;">+1d6 necrotic on every hit against the hexed target while concentration holds.</em>
            </div>
          </div>`,
          speaker: ChatMessage.getSpeaker({ actor: attackerActor }),
        });
      }
      return true;
    } catch (err) {
      console.error(`${MODULE_ID} | applyHex failed:`, err);
      return false;
    }
  }

  /**
   * Remove Hex from `attackerActor`. Called when concentration on Hex ends
   * (the "Hex" active effect is deleted) or manually.
   */
  static async removeHex(attackerActor, opts = {}) {
    if (!attackerActor) return false;
    const hex = attackerActor.getFlag?.(MODULE_ID, "hex");
    if (!hex) return false;
    try {
      await attackerActor.unsetFlag(MODULE_ID, "hex");
      console.log(`${MODULE_ID} | Hex removed from ${attackerActor.name}${opts.reason ? ` (${opts.reason})` : ""}`);
      return true;
    } catch (err) {
      console.error(`${MODULE_ID} | removeHex failed:`, err);
      return false;
    }
  }

  /**
   * Scan every actor for an active Hexblade's Curse and expire any whose
   * 10-round (1-minute, RAW) duration has elapsed. Also clears curses tied
   * to a combat that's no longer the current one (combat ended without the
   * curse expiring naturally — RAW would also have it expire by then).
   *
   * No heal-on-kill — the target survived; curse just ran out.
   * @returns {Promise<number>} number of curses expired
   */
  static async expireHexbladeCursesIfDue() {
    let expired = 0;
    const currentRound   = game.combat?.round   ?? null;
    const currentCombatId = game.combat?.id     ?? null;
    for (const a of game.actors?.contents ?? []) {
      const curse = a?.getFlag?.(MODULE_ID, "hexbladeCurse");
      if (!curse || typeof curse !== "object") continue;

      let shouldExpire = false;
      // Case 1: combat the curse was applied in is over — RAW 1 minute would
      // have passed (combat rounds are 6s, but out-of-combat we don't track
      // a wall-clock for short-duration buffs; conservative cleanup).
      if (curse.combatId && curse.combatId !== currentCombatId) {
        shouldExpire = true;
      }
      // Case 2: still in the original combat but ≥ 10 rounds elapsed.
      else if (
        currentRound !== null &&
        typeof curse.appliedRound === "number" &&
        (currentRound - curse.appliedRound) >= 10
      ) {
        shouldExpire = true;
      }

      if (shouldExpire) {
        await CombatState.removeHexbladeCurse(a, { reason: "expired" });
        expired++;
      }
    }
    if (expired > 0) console.log(`${MODULE_ID} | Expired ${expired} Hexblade curse(s) (1-minute duration elapsed).`);
    return expired;
  }

  /**
   * If `attackerActor` has an active Hexblade's Curse AND is now incapacitated
   * (HP at 0, or carrying any of the incapacitating statuses below), clear the
   * curse. RAW: "The curse ends early if [...] you die or are incapacitated."
   * @param {Actor} attackerActor
   * @returns {Promise<boolean>} true if curse was cleared by this call
   */
  static async clearHexbladeCurseIfIncapacitated(attackerActor) {
    if (!attackerActor) return false;
    const curse = attackerActor.getFlag?.(MODULE_ID, "hexbladeCurse");
    if (!curse) return false;

    const hp = attackerActor.system?.attributes?.hp?.value ?? null;
    const statuses = attackerActor.statuses ?? new Set();
    const INCAP_STATUSES = ["incapacitated", "stunned", "paralyzed", "petrified", "unconscious", "dead"];
    const isIncap = (hp !== null && hp <= 0) || INCAP_STATUSES.some(s => statuses.has?.(s));
    if (!isIncap) return false;

    await CombatState.removeHexbladeCurse(attackerActor, { reason: "incapacitated" });
    return true;
  }
}
