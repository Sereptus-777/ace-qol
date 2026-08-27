// ─── ACE: QOL — Engagement Gate ───────────────────────────────────────────────
// THE pre-flight validator. Runs at the start of every weapon swing, spell cast,
// trap fire, or any source-vs-target moment. Catches RAW rule violations BEFORE
// any slot/charge is consumed and BEFORE any chat card is posted.
//
// This is the "parent" pipeline — every downstream pipeline (attack, save, heal,
// auto-damage) eventually calls EngagementGate.validate() first. If the gate
// returns blocked: true, the cast is cancelled with a clear toast and no
// resources are consumed. If it returns warnings, the cast proceeds.
//
// Design philosophy:
//   • BLOCK only on RAW rule violations the engine should enforce.
//     Player tactical mistakes (Fire Bolt on a fire elemental) are NOT blocked
//     — let the table groan, let players learn. Player agency wins.
//   • CONFIRM (dialog) for irreversible side-effects the player might miss
//     (breaking concentration on a different spell). Allows override.
//   • NEVER warn for damage-type/condition immunity. The damage card already
//     gives subtle in-fiction feedback (the flavor-hint system).
//
// Phase 1 scope (this commit):
//   • Creature-type restriction (Hold Person → Humanoid only)
//   • Concentration confirm dialog (cast Haste while concentrating on Bless)
//
// Phase 2-5 will add: range, full-cover, size restrictions, slot/charge checks,
// incapacitation centralization, multi-target rules, and refactor the existing
// pipelines to consume the validator's output.
// ──────────────────────────────────────────────────────────────────────────────

import { MODULE_ID, SPELL_AUTO_APPLY } from "./ace-qol.mjs";
import { DescriptionParser } from "./description-parser.mjs";
import { showCenterToast } from "./attack-prompt.mjs";
import { SpellAutoDamage } from "./spell-auto-damage.mjs";

export class EngagementGate {

  /**
   * v0.4.22.5: UUIDs of activities the user has already confirmed via the
   * concentration-break dialog. Replaces the old approach of mutating
   * `activity._aceQolConfirmed = true`, which silently failed because dnd5e
   * 5.x activity objects are non-extensible — the marker was lost on every
   * re-fire and the dialog re-prompted in a loop.
   *
   * The async confirm handler adds the UUID before re-firing `activity.use()`.
   * The synchronous preUseActivity hook checks the Set, consumes (deletes)
   * the entry on hit, and bypasses the gate. Single-use marker — a future
   * independent cast of the same activity still triggers the prompt.
   */
  static _confirmedActivityUuids = new Set();

  /**
   * The single entry point. Every pipeline calls this first.
   *
   * @param {object} ctx
   * @param {Actor}    ctx.source    — caster / attacker
   * @param {Item}     ctx.item      — weapon / spell / consumable
   * @param {object}   [ctx.activity]— dnd5e Activity (when available)
   * @param {Token[]|Set<Token>} [ctx.targets] — targeted tokens
   * @param {string}   [ctx.mode]    — "spell" | "weapon" | "auto" (defaults inferred)
   *
   * @returns {Promise<{
   *   valid: boolean,
   *   blocked: boolean,
   *   blockReason: string|null,
   *   blockTargets: Token[],
   *   warnings: string[],
   *   sourceState: object|null,
   *   targetStates: object[],
   * }>}
   */
  static async validate(ctx) {
    const { source, item, activity, targets } = ctx ?? {};
    const targetArr = Array.isArray(targets) ? targets : [...(targets ?? [])];

    const result = {
      valid: true,
      blocked: false,
      blockReason: null,
      blockTargets: [],
      warnings: [],
      sourceState: null,
      targetStates: [],
    };

    if (!source || !item) {
      // Fail-open — gate can't validate without source+item, let downstream
      // handle. This keeps the gate from breaking edge-case usages.
      return result;
    }

    try {
      // ── Phase 1 check 0: target requirement ──
      // Block spells that require a target but have NONE selected. RAW:
      // casting Hold Person on nothing is just wasting a slot. The cast
      // shouldn't happen — the player should be told to pick a target first.
      // Also blocks single-target spells with multiple selected, and
      // self-only spells with non-self targets.
      const targetReqBlock = EngagementGate._checkTargetRequirement(item, activity, targetArr, source);
      if (targetReqBlock?.blocked) {
        result.blocked = true;
        result.valid = false;
        result.blockReason = targetReqBlock.reason;
        return result;
      }

      // ── Phase 1 check 1: target creature-type restriction ──
      const typeBlock = EngagementGate._checkCreatureTypeRestriction(item, targetArr);
      if (typeBlock?.blocked) {
        result.blocked = true;
        result.valid = false;
        result.blockReason = typeBlock.reason;
        result.blockTargets = typeBlock.invalidTokens;
        return result;
      }

      // ── Phase 1 check 2: concentration confirm dialog ──
      // Only matters for spells that REQUIRE concentration. If the source is
      // already concentrating on a DIFFERENT spell, prompt before breaking.
      const concBlock = await EngagementGate._checkConcentrationConfirm(source, item, activity);
      if (concBlock?.blocked) {
        result.blocked = true;
        result.valid = false;
        result.blockReason = concBlock.reason;
        return result;
      }
    } catch (err) {
      // Defensive: never let a gate bug block a legit cast. Log + fail-open.
      console.error(`${MODULE_ID} | EngagementGate.validate threw — fail-open:`, err);
    }

    return result;
  }

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
    const name = String(item.name ?? "").toLowerCase().trim();
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

  /**
   * If the new spell requires concentration AND source is already concentrating
   * on a different spell, prompt the player. Yes → break old, cast new.
   * No → cancel cast, slot preserved, old concentration intact.
   *
   * Casting the SAME concentration spell (e.g., Hunter's Mark on a new target)
   * is treated as a refresh — no prompt, just proceed. Casting a non-
   * concentration spell while concentrating on something doesn't prompt
   * (no concentration is broken).
   */
  static async _checkConcentrationConfirm(source, item, activity) {
    // Detect: does the new spell require concentration?
    const needsConcentration = EngagementGate._spellRequiresConcentration(item, activity);
    if (!needsConcentration) return null;

    // What is the source currently concentrating on?
    const current = EngagementGate._currentConcentrationSpellName(source);
    if (!current) return null; // not concentrating — no prompt

    // Same spell? Treat as a refresh — no prompt
    if (current === item.name) return null;

    const ok = await EngagementGate._confirmBreakConcentrationDialog(item.name, current);
    if (ok) return null; // user confirmed; let cast proceed

    return {
      blocked: true,
      reason: `Cancelled — concentration on ${current} preserved`,
    };
  }

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

  // ═══════════════════════════════════════════════════════════════════════════
  //  Hook Registration
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Register the gate's pre-cast hook. For Phase 1, only attaches to the
   * spell-use path (preUseActivity). Weapon attacks already have their own
   * pre-roll hook in attack-pipeline; Phase 5 will route them through the
   * gate too. For now, the gate runs as an additive layer.
   */
  static registerHooks() {
    // CRITICAL: this hook MUST be synchronous and return false synchronously
    // to actually cancel the activity. Foundry checks the immediate return
    // value of each listener; an async function returns a Promise which is
    // always truthy, so async hooks CANNOT cancel the event even if they
    // resolve to false. The previous version of this gate was async and
    // silently failed to block — the toast appeared but the spell still cast.
    Hooks.on("dnd5e.preUseActivity", (activity, usageConfig, dialogConfig, messageConfig) => {
      try {
        const item = activity?.item;
        if (!item) return; // not enough context to validate
        if (item.type !== "spell") return; // weapons handled in attack-pipeline

        const source = item.actor;
        if (!source) return;

        // v0.4.22.5: bypass gate if this is the post-confirm re-fire from the
        // concentration dialog. Consume the entry so a future independent cast
        // of the same activity still gets gated.
        if (activity?.uuid && EngagementGate._confirmedActivityUuids.has(activity.uuid)) {
          EngagementGate._confirmedActivityUuids.delete(activity.uuid);
          return; // proceed without gating
        }

        const targets = [...(game.user.targets ?? [])];

        // ── SYNCHRONOUS check 0: target requirement (zero targets, wrong count) ──
        const targetReqBlock = EngagementGate._checkTargetRequirement(item, activity, targets, source);
        if (targetReqBlock?.blocked) {
          // ATTACK-roll spell with NO target → open the target picker instead of
          // a dead-end toast. Save spells and Magic Missile always had a picker;
          // attack cantrips (Fire Bolt) fell through the crack and just blocked
          // (Johnny 2026-07-26). Same cancel-now → async dialog → re-fire pattern
          // as the concentration confirm below; picking a target re-fires the
          // cast, cancelling the picker leaves the cast cancelled.
          if (activity?.type === "attack" && !targets.length) {
            console.log(`${MODULE_ID} | EngagementGate: ${item.name} has no target — opening the target picker`);
            EngagementGate._handleAttackTargetPickAsync(activity, source, item);
            return false; // cancel the original cast (synchronous)
          }
          showCenterToast(targetReqBlock.reason, 3500);
          console.log(`${MODULE_ID} | EngagementGate BLOCKED: ${targetReqBlock.reason}`);
          return false;
        }

        // ── SYNCHRONOUS check 1: creature-type restriction (Hold Person → humanoid) ──
        const typeBlock = EngagementGate._checkCreatureTypeRestriction(item, targets);
        if (typeBlock?.blocked) {
          showCenterToast(typeBlock.reason, 3500);
          console.log(`${MODULE_ID} | EngagementGate BLOCKED: ${typeBlock.reason}`);
          return false; // synchronous return — cancels the activity
        }

        // ── Concentration confirm ──
        // The dialog is async, so we can't await it inside this synchronous
        // hook. Instead we use a re-fire pattern:
        //   1. Detect that confirm is needed
        //   2. Cancel the activity NOW (return false synchronously)
        //   3. Show the dialog asynchronously
        //   4. If the user confirms, programmatically re-invoke activity.use()
        //      with a marker flag so the gate skips the confirm on re-entry
        if (EngagementGate._spellRequiresConcentration(item, activity)) {
          const current = EngagementGate._currentConcentrationSpellName(source);
          if (current && current !== item.name) {
            // Defer the dialog + re-fire to async land. The early-bypass
            // check at the top of this hook handles the post-confirm
            // re-entry via `_confirmedActivityUuids`.
            EngagementGate._handleConcentrationConfirmAsync(activity, source, item, current);
            return false; // cancel the original cast (synchronous)
          }
        }

        // No blocks fired — let the cast proceed
      } catch (err) {
        // Fail-open on any unexpected error — never block a real cast
        // because of a gate bug.
        console.error(`${MODULE_ID} | EngagementGate hook threw — fail-open:`, err);
      }
    });

    console.debug(`${MODULE_ID} | EngagementGate hooks registered (Phase 1: creature-type + concentration)`);
  }

  /**
   * Async dialog + re-fire for concentration confirm. Called from the
   * synchronous hook AFTER it has already returned false to cancel the
   * original cast.
   */
  /**
   * Attack-roll spell cast with no target: open the SpellTargetPicker on THIS
   * client (whoever is casting — GM or player), set the pick as the user's
   * target, then re-fire the cast through the confirmed-uuid bypass. Cancelling
   * the picker leaves the cast cancelled. (Fire Bolt parity — 2026-07-26.)
   */
  static async _handleAttackTargetPickAsync(activity, source, item) {
    try {
      const { SpellTargetPicker } = await import("./spell-target-picker.mjs");
      const rangeFt = Number(activity?.range?.value ?? item.system?.range?.value ?? 0) || null;
      const maxTargets = Number(activity?.target?.affects?.count) || 1;
      const picked = await SpellTargetPicker.pick({ spellItem: item, casterActor: source, maxTargets, rangeFt, allowSelf: false });
      if (!picked?.length) return;   // GM/player cancelled — cast stays cancelled
      // V13: no bulk target ops — set each picked token individually.
      let first = true;
      for (const a of picked) {
        const tok = a?.getActiveTokens?.()?.[0]
          ?? canvas.tokens?.placeables.find(t => t.actor?.id === a?.id)
          ?? null;
        if (!tok) continue;
        tok.setTarget(true, { user: game.user, releaseOthers: first });
        first = false;
      }
      if (first) return;             // nothing resolvable to a token — stay cancelled
      if (activity?.uuid) EngagementGate._confirmedActivityUuids.add(activity.uuid);
      await activity.use();
    } catch (err) {
      console.warn(`${MODULE_ID} | attack-spell target pick failed (cast stays cancelled):`, err);
    }
  }

  static async _handleConcentrationConfirmAsync(activity, source, item, oldSpellName) {
    let ok = false;
    try {
      ok = await EngagementGate._confirmBreakConcentrationDialog(item.name, oldSpellName);
    } catch (err) {
      console.warn(`${MODULE_ID} | concentration confirm dialog failed — fail-open:`, err);
      ok = true; // fail-open
    }
    if (!ok) {
      console.log(`${MODULE_ID} | EngagementGate: ${item.name} cast cancelled — concentration on ${oldSpellName} preserved`);
      showCenterToast(`Cancelled — concentration on ${oldSpellName} preserved`, 3000);
      return;
    }
    // User confirmed — register the activity UUID so the sync hook bypasses
    // the gate on re-entry, then re-fire `activity.use()`.
    //
    // v0.4.22.5: Use a static Set keyed on activity.uuid instead of mutating
    // `activity._aceQolConfirmed`. The mutation approach silently failed
    // because dnd5e 5.x activities are non-extensible — every click of "Break"
    // re-fired the dialog in a loop because the marker never stuck.
    if (!activity?.uuid) {
      console.warn(`${MODULE_ID} | concentration confirm: activity has no uuid, can't safely re-fire`);
      ui.notifications?.error(`Re-cast of ${item.name} failed — please cast from the sheet.`);
      return;
    }
    try {
      EngagementGate._confirmedActivityUuids.add(activity.uuid);
      await activity.use();
    } catch (err) {
      console.error(`${MODULE_ID} | EngagementGate re-fire of ${item.name} failed:`, err);
      ui.notifications?.error(`Re-cast of ${item.name} failed — try again from the sheet.`);
      // Clean up if re-fire blew up before the sync hook could consume the entry
      EngagementGate._confirmedActivityUuids.delete(activity.uuid);
    }
  }
}
