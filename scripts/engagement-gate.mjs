// ─── ACE: QOL — Engagement checks ─────────────────────────────────────────────
// The source-versus-target checks a spell press is judged by. The one gate's
// rules read them (gate/press-rules.mjs, The One Road Phase 2, 2026-09-14):
//
//   • Targets: a spell that needs a target has one, and not too many
//     (_checkTargetRequirement, with the RAW multi-target catalog)
//   • Creature type: Hold Person → Humanoid only (_checkCreatureTypeRestriction)
//   • Concentration: a new concentration spell asks before ending the old one
//     (_spellRequiresConcentration, _currentConcentrationSpellName,
//     _confirmBreakConcentrationDialog)
//
// ⚠️ THIS FILE REGISTERS NOTHING. Its own preUseActivity hook, its validate()
// that nothing called, and its re-fire bookkeeping are deleted. The gate
// refuses, asks and presses again for it, and the GM can overrule a refusal.
//
// Design philosophy:
//   • BLOCK only on RAW rule violations the engine should enforce.
//     Player tactical mistakes (Fire Bolt on a fire elemental) are NOT blocked
//     — let the table groan, let players learn. Player agency wins.
//   • CONFIRM (dialog) for irreversible side-effects the player might miss
//     (breaking concentration on a different spell). Allows override.
//   • NEVER warn for damage-type/condition immunity. The damage card already
//     gives subtle in-fiction feedback (the flavor-hint system).
// ──────────────────────────────────────────────────────────────────────────────

import { MODULE_ID, SPELL_AUTO_APPLY } from "./ace-qol.mjs";
import { spellKey } from "./rules/spell-name.mjs";
import { DescriptionParser } from "./description-parser.mjs";
import { SpellAutoDamage } from "./spell-auto-damage.mjs";
import { HealPipeline } from "./heal-pipeline.mjs";

export class EngagementGate {

  // Every check below is read by the one gate's rules (gate/press-rules.mjs);
  // nothing in this file cancels a press.

  // ═══════════════════════════════════════════════════════════════════════════
  //  Check 0: Target Requirement (count + type-of-affects)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Block casts where the spell needs a target but none is selected, OR has
   * the wrong number of targets selected. This is the most basic sanity check
   * — without it, a player can cast Hold Person on nothing, burn the slot,
   * gain meaningless concentration, and the table groans for the wrong reason.
   *
   * Detects target requirement from dnd5e activity data + falls back to
   * description text scan for older items.
   *
   * Skips:
   *   - Self-targeted spells (Mage Armor, Shield, Bless on self) when source
   *     is correctly the only "target"
   *   - Templated AOE spells where the user places the template instead of
   *     pre-targeting (Fireball, Cone of Cold) — they don't use game.user.targets
   *   - Spells with no target system at all
   */
  static _checkTargetRequirement(item, activity, targets, source) {
    if (item?.type !== "spell") return null;

    // ── Bypass: spells handled by SPELL_AUTO_APPLY (v0.7.15) ──
    // For spells in our spell-cast auto-apply dispatch, the SpellTargetPicker
    // handles target selection AFTER the cast fires. The gate's "select a
    // target first" block would block the cast before our picker ever runs,
    // so skip it for these spells. (Bless, Bane, Haste, Slow, Faerie Fire,
    // Mirror Image, Mage Armor, etc., plus the smite spells.)
    try {
      const nameLc = String(item.name ?? "").toLowerCase().replace(/['']/g, "").trim();
      if (SPELL_AUTO_APPLY?.[nameLc]) {
        return null;
      }
    } catch (_) { /* non-fatal — fall through to normal gate */ }

    // ── Bypass: spells the unified pipeline owns ──
    // The pipeline opens its OWN picker AFTER the cast fires, so the "select a
    // target first" block would wrongly stop a no-target Banishment / Hold
    // Person / Dominate before that picker ever runs.
    try {
      if (game.aceQol?.SpellPipeline?.ownsSpell?.(item)) return null;
    } catch (_) { /* non-fatal — fall through to normal gate */ }

    // ── Bypass: heals, which pick their own targets (2026-09-14) ──
    // With the heal pipeline on, a heal is taken over after the press and its
    // own picker asks who (dnd5e places a template heal; the spell pipeline runs
    // one it owns). Before the one gate, the heal pipeline took a heal over
    // before this check ever ran, so a heal pressed with nobody targeted always
    // reached that picker. The gate's first cut refused it here instead. With
    // the heal pipeline off, dnd5e's own heal flow runs and this check stands.
    try {
      if (game.settings.get(MODULE_ID, "enableHealPipeline") !== false
          && HealPipeline._activityHeals(activity)) return null;
    } catch (err) {
      console.warn(`${MODULE_ID} | could not tell whether ${item.name} heals; judging its targets as usual:`, err);
    }

    // ── Bypass: damage spells with their own picker (v0.7.17) ──
    // Magic Missile and other auto-hit damage spells that own targeting via
    // a dedicated picker (MagicMissilePicker). The gate's pre-target block
    // would fire BEFORE the picker opens, so bypass it for these too. See
    // ACE_SPELL_TARGETING_FLOW_SPEC.md for the full post-camp unification.
    try {
      if (SpellAutoDamage?._isMagicMissile?.(activity)) {
        return null;
      }
    } catch (_) { /* non-fatal — fall through to normal gate */ }

    // ── Bypass: save-based spells (Frostbite, Hold Person, Ray of Sickness…) ──
    // A save spell cast with no pre-selected target is NOT a mistake to block.
    // The SaveEngine pops its OWN target picker — now routed to the caster's
    // client over the socket — and then resolves the save. Blocking here cancels
    // the cast before that picker can ever open, which IS the "no picker comes up
    // on the client" bug: the cast dies in preUseActivity and the SaveEngine
    // never runs. Let save activities through; the SaveEngine owns their
    // targeting. (Detect by activity.type "save" OR a non-empty save ability —
    // dnd5e 5.x stores the latter as a Set, older shapes as a string/array.)
    const _saveAbil = activity?.save?.ability;
    const _isSaveActivity = activity?.type === "save"
      || (_saveAbil instanceof Set   ? _saveAbil.size   > 0
        : Array.isArray(_saveAbil)   ? _saveAbil.length > 0
        : !!_saveAbil);
    if (_isSaveActivity) return null;

    // ── Bypass: summon / conjure activities (Summon Fey/Beast/Undead/Fiend/
    //    Aberration/Celestial/Construct…, Find Familiar, Conjure Animals). A
    //    summon CREATES a creature in an unoccupied space near the caster — it
    //    never needs a pre-selected canvas target. dnd5e types these as
    //    "summon", and the activity carries the summoned stat block whose
    //    "target one creature" wording would otherwise trip the description
    //    scan below and wrongly demand a target. Let the cast through; dnd5e's
    //    own summon dialog handles placement. (Reported 2026-07-14: Summon Fey
    //    — the "Tricksy" mood darkness — was blocked on "select a target".)
    if (activity?.type === "summon") return null;

    // Defensive reads — dnd5e activity schema varies between 2014/2024 and
    // some fields are objects (target.template = {type, size, ...}) not
    // strings. The previous version did `?? ""` then `.toLowerCase()` which
    // crashed when the value was an object, fail-opened the gate, and let
    // a no-target Hold Person cast through. Always coerce to string first.
    const targetData = activity?.target ?? item.system?.target ?? {};
    const affectsTypeRaw = targetData?.affects?.type ?? targetData?.type ?? "";
    const affectsType = (typeof affectsTypeRaw === "string" ? affectsTypeRaw : "").toLowerCase();
    const templateTypeRaw = targetData?.template?.type ?? "";
    const templateType = (typeof templateTypeRaw === "string" ? templateTypeRaw : "").toLowerCase();

    // Self-only — caster is the implicit target, no canvas selection needed
    if (affectsType === "self") return null;

    // Templated AOE spells use a template-placement workflow (no game.user.targets)
    if (templateType) return null;

    // Affects type is a known "needs target" type
    const needsCanvasTarget = ["any", "ally", "enemy", "creature", "object"].includes(affectsType);
    // Some 2014 items have no `affects` block — fall back to a description scan
    // for "Choose a [creature/humanoid/etc.]" or "target" wording
    let inferredNeedsTarget = false;
    if (!needsCanvasTarget && !affectsType) {
      const desc = String(item.system?.description?.value ?? "").replace(/<[^>]+>/g, " ").toLowerCase();
      inferredNeedsTarget = /\b(?:choose|target)\s+(?:a|an|one|up\s+to|any\s+number)\s+(?:creature|humanoid|beast|fey|fiend|undead|construct)/i.test(desc);
    }

    if (!needsCanvasTarget && !inferredNeedsTarget) return null;

    // ── BLOCK: Zero targets selected ──
    if (!targets?.length) {
      return {
        blocked: true,
        reason: `${item.name}: select a target first — no creatures targeted`,
      };
    }

    // ── BLOCK: Self-only being cast on someone else ──
    if (affectsType === "self") {
      const sourceTokenId = source?.token?.id ?? source?.getActiveTokens?.()?.[0]?.id;
      const onlySelf = targets.length === 1 && (targets[0].id === sourceTokenId || targets[0].actor?.id === source?.id);
      if (!onlySelf) {
        return {
          blocked: true,
          reason: `${item.name} only targets yourself — deselect other targets`,
        };
      }
    }

    // ── BLOCK: Too many targets selected ──
    // First check our RAW multi-target catalog (overrides bad sheet data).
    // Many DDB-imported spells have target.affects.count = 1 even when the
    // RAW spell allows multiple (Magic Missile darts, Scorching Ray rays,
    // Eldritch Blast beams, etc.). We compute the correct max from PHB
    // text and the cast slot level.
    const cataloged = EngagementGate._catalogedMaxTargets(item, activity);
    if (cataloged !== null) {
      if (targets.length > cataloged) {
        return {
          blocked: true,
          reason: `${item.name} targets up to ${cataloged} creature${cataloged === 1 ? "" : "s"} at this cast level — you have ${targets.length} selected`,
        };
      }
      // Catalog says it's allowed → skip the data-sheet check (which would
      // incorrectly block due to bad importer data).
      return null;
    }

    // Fallback: respect the activity/item data when there's no catalog entry.
    const rawCount = targetData?.affects?.count ?? targetData?.value ?? null;
    const numCount = parseInt(rawCount);
    if (Number.isFinite(numCount) && numCount > 0 && targets.length > numCount) {
      return {
        blocked: true,
        reason: `${item.name} targets only ${numCount} creature${numCount === 1 ? "" : "s"} — you have ${targets.length} selected`,
      };
    }

    return null;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  RAW Multi-Target Spell Catalog
  // ═══════════════════════════════════════════════════════════════════════════
  //
  // Many DDB-imported spells have target.affects.count = 1 in their data
  // even when RAW PHB allows multiple targets. This catalog overrides the
  // sheet data with the correct RAW max-target count, computed from the
  // cast slot level + character level (for cantrips).
  //
  // Returns null if the spell isn't in the catalog (caller falls back to
  // sheet data). Returns an integer otherwise.
  //
  // PHB references included for verification.
  // ═══════════════════════════════════════════════════════════════════════════
  static _catalogedMaxTargets(item, activity) {
    if (item?.type !== "spell") return null;
    // ⚠️🔴 SIXTEEN SPELLS BELOW WERE MATCHED BY RAW NAME AND EVERY ONE OF
    // THEM MISSED HIS "(Legacy)" COPIES — Magic Missile, Hold Person, Bless,
    // Mass Cure Wounds and the rest. So the target counts they exist to supply
    // silently never applied to the versions he actually casts.
    const name = spellKey(item.name);
    const baseLevel = Number(item.system?.level ?? 0);

    // Resolve cast slot level. Try activity-level usage data first (dnd5e
    // 5.x stamps usageConfig.spell.level for upcasts), fall back to base.
    const castLevel = Number(
      activity?.usage?.spellLevel
      ?? activity?.consumes?.spellSlots?.[0]?.level
      ?? activity?.consumption?.spellSlots
      ?? baseLevel
    );

    // Character level (for cantrip scaling at L5/11/17)
    const casterLevel = Number(item.parent?.system?.details?.level ?? 0);

    // ── Attack-roll multi-target spells ──
    if (name === "magic missile") {
      // PHB: "You create three glowing darts of magical force" + "When you
      // cast this spell using a spell slot of 2nd level or higher, the spell
      // creates one more dart for each slot level above 1st."
      // 3 darts at L1, 4 at L2, 5 at L3, 6 at L4, ...
      return 3 + Math.max(0, castLevel - 1);
    }
    if (name === "scorching ray") {
      // PHB: "You create three rays of fire" + "+1 ray per slot above 2nd"
      return 3 + Math.max(0, castLevel - 2);
    }
    if (name === "eldritch blast") {
      // PHB: "you can create one beam" → 1/2/3/4 beams at level 1/5/11/17
      if (casterLevel >= 17) return 4;
      if (casterLevel >= 11) return 3;
      if (casterLevel >= 5)  return 2;
      return 1;
    }

    // ── Save spells with "+1 target per slot above" pattern ──
    if (name === "hold person") {
      // PHB: "Choose a Humanoid you can see" + "+1 humanoid per slot above 2"
      return 1 + Math.max(0, castLevel - 2);
    }
    if (name === "hold monster") {
      // 1 + 1/slot above 5
      return 1 + Math.max(0, castLevel - 5);
    }
    if (name === "charm person") {
      // 1 + 1/slot above 1 (must be within 30 feet of each other)
      return 1 + Math.max(0, castLevel - 1);
    }
    if (name === "banishment") {
      // 1 + 1/slot above 4
      return 1 + Math.max(0, castLevel - 4);
    }
    if (name === "fear" || name === "compulsion") {
      // AOE — let template gate handle, not multi-target
      return null;
    }
    if (name === "haste" || name === "slow") {
      // Haste: 1 willing creature. Slow: up to 6.
      if (name === "slow") return 6;
      return 1;
    }
    if (name === "bless" || name === "bane") {
      // 3 + 1/slot above 1
      return 3 + Math.max(0, castLevel - 1);
    }

    // ── Healing multi-target spells ──
    if (name === "mass cure wounds")  return 6;
    if (name === "mass healing word") return 6;
    if (name === "healing spirit") {
      // 1 creature per turn — but the spell card itself targets 1
      return 1;
    }

    // No catalog match — return null so caller uses sheet data
    return null;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Check 1: Creature-Type Restriction
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Hold Person → "Choose a Humanoid". Wolf is a beast → block.
   * Charm Monster → "Humanoid, Beast, Fey, Giant, or Plant". Wider list.
   *
   * Skips the check entirely for non-spell items (weapons don't have type
   * restrictions in this sense) and for spells whose description doesn't
   * specify a creature-type filter.
   */
  static _checkCreatureTypeRestriction(item, targets) {
    if (item?.type !== "spell") return null;
    if (!targets?.length) return null;

    const desc = item.system?.description?.value;
    const restriction = DescriptionParser._parseTargetTypeRestriction(desc);
    if (!restriction?.allowed?.length) return null;

    const allowed = new Set(restriction.allowed.map(t => t.toLowerCase()));
    const invalid = [];
    for (const token of targets) {
      const tType = String(token?.actor?.system?.details?.type?.value ?? "").toLowerCase();
      const tSubtype = String(token?.actor?.system?.details?.type?.subtype ?? "").toLowerCase();
      // Match exact type OR subtype contains an allowed type (covers
      // "humanoid (orc)" and similar variants)
      const ok = allowed.has(tType)
              || [...allowed].some(a => tType.includes(a))
              || [...allowed].some(a => tSubtype.includes(a));
      if (!ok) invalid.push({ token, type: tType });
    }

    if (!invalid.length) return null;

    const allowedList = [...allowed].join(" / ");
    const invalidNames = invalid.map(i => i.token?.name ?? "target").join(", ");
    const reason = `${item.name} requires a ${allowedList} target — ${invalidNames} is invalid`;

    return {
      blocked: true,
      reason,
      invalidTokens: invalid.map(i => i.token),
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Check 2: Concentration Confirm Dialog
  // ═══════════════════════════════════════════════════════════════════════════

  // The gate's concentration rule asks this when a new concentration spell
  // would end a different one; declining keeps the old spell and the slot.

  static _spellRequiresConcentration(item, activity) {
    if (item?.type !== "spell") return false;
    // dnd5e 5.x: properties is a Set in some versions, Array in others
    const props = item.system?.properties;
    if (props?.has?.("concentration")) return true;
    if (Array.isArray(props) && props.includes("concentration")) return true;
    // Activity-level override
    if (activity?.duration?.concentration) return true;
    return false;
  }

  static _currentConcentrationSpellName(actor) {
    if (!actor?.effects?.contents) return null;
    for (const efx of actor.effects.contents) {
      if (efx.disabled) continue;
      const statuses = efx.statuses ?? new Set();
      const isConcentration = (statuses.has?.("concentration") || statuses.has?.("concentrating")
                               || efx.flags?.dnd5e?.concentration);
      if (isConcentration) {
        return efx.name?.replace(/^Concentrating:\s*/i, "") ?? efx.name ?? null;
      }
      // Our own flag (set when condition-library applies a concentration effect)
      if (efx.flags?.[MODULE_ID]?.concentration === true) {
        return efx.name ?? null;
      }
    }
    return null;
  }

  static async _confirmBreakConcentrationDialog(newSpell, oldSpell) {
    try {
      const DV2 = foundry.applications?.api?.DialogV2;
      if (DV2) {
        return await DV2.confirm({
          window: { title: "Break Concentration?" },
          content: `<div style="padding:8px 4px;">
            <p style="margin:0 0 8px 0;">You are concentrating on <strong>${foundry.utils.escapeHTML(oldSpell)}</strong>.</p>
            <p style="margin:0 0 8px 0;">Casting <strong>${foundry.utils.escapeHTML(newSpell)}</strong> will end that concentration.</p>
            <p style="margin:0;color:#888;font-size:12px;"><em>Cancel to keep ${foundry.utils.escapeHTML(oldSpell)} active.</em></p>
          </div>`,
          yes: { label: `Break ${oldSpell}`, default: false },
          no:  { label: "Cancel cast",       default: true  },
          rejectClose: false,
        });
      }
    } catch (err) {
      console.warn(`${MODULE_ID} | concentration confirm dialog failed:`, err);
    }
    // Fail-open: if dialog can't render, allow the cast (don't block on
    // infrastructure failure)
    return true;
  }
}
