// ─── ACE: QOL — Heal Pipeline ────────────────────────────────────────────────
// Custom heal flow that mirrors the attack pipeline. Detects HealActivity
// uses, classifies the heal's targeting profile, shows a target picker
// popup (range-aware, type-aware), rolls the heal through dnd5e's
// HealActivity.rollDamage(), then posts a custom chat card with
// per-target apply buttons.
//
// Coverage by RAW pattern:
//   ┌───────────────────────────┬───────────────────────────────────────────┐
//   │ Pattern                   │ Examples                                  │
//   ├───────────────────────────┼───────────────────────────────────────────┤
//   │ Self only                 │ Second Wind, Lay on Hands (self)          │
//   │ Touch (5ft + self)        │ Cure Wounds (2014), Lay on Hands          │
//   │ Single ranged             │ Healing Word (60ft)                       │
//   │ Multi single-target       │ Mass Healing Word (up to 6 in 60ft)       │
//   │ Multi-self counts         │ Aura of Vitality (one per round)          │
//   │ AoE template              │ Prayer of Healing (30ft sphere)           │
//   │ Temp HP                   │ Heroism, Inspiring Leader                 │
//   │ At 0 HP / Stable          │ Spare the Dying (separate flow, vanilla)  │
//   └───────────────────────────┴───────────────────────────────────────────┘
//
// Activity detection:
//   - Hooks `dnd5e.postCreateUsageMessage`. Only fires on activity.type === "heal".
//   - Suppresses the dnd5e default usage card (deletes it) and substitutes
//     our own card with target picker integration.
//   - Template-based heals defer to `dnd5e.createActivityTemplate` and pull
//     tokens inside the placed template.
//
// Targeting classification (`_classify`):
//   shape:    "self" | "single" | "multi" | "template"
//   count:    integer max targets (1, 6, etc.)
//   rangeFt:  numeric distance in feet (0=self, 5=touch, etc., Infinity=any)
//   isTempHP: true for temp-HP heals (applied to actor.system.attributes.hp.temp)
//
// Apply behavior:
//   One-click "Apply" button per target row. Updates HP (regular or temp),
//   caps at max, posts a follow-up chat note. No APPLY ALL / UNDO ALL —
//   keeps the UX clean.
// ──────────────────────────────────────────────────────────────────────────────

import { MODULE_ID } from "./ace-qol.mjs";
import { QolSettings } from "./settings.mjs";
import { HealTargetPicker } from "./heal-target-picker.mjs";
import { HealCardRenderer } from "./heal-card-renderer.mjs";

export class HealPipeline {

  constructor() {
    /** Pending heal awaiting template placement (template-shape activities) */
    this._pendingTemplateHeal = null;

    /** Debounce — protects against duplicate dnd5e hook fires for the same activity */
    this._lastHandledActivityId = null;
    this._lastHandledAt = 0;

    this._registerHooks();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Hook Registration
  // ═══════════════════════════════════════════════════════════════════════════

  _registerHooks() {
    // PRIMARY ENTRY: hook preUseActivity (fires BEFORE the usage message and
    // BEFORE any auto-roll dialogs). For heal activities we suppress dnd5e's
    // entire default flow — no usage chat, no auto-rolled damage dialog —
    // and run our own pipeline (picker → silent Roll → custom card).
    //
    // Why this matters: previously we hooked postCreateUsageMessage and
    // tried to delete the usage message after the fact. dnd5e was ALSO
    // auto-firing activity.rollDamage() right after creating the usage
    // message (showing a Roll Configuration dialog), AND we were calling
    // rollDamage() ourselves after the picker confirmed (showing a SECOND
    // dialog). Two dialogs, two rolls. Hooking preUseActivity stops the
    // vanilla flow at the source — no dialogs, no auto-roll, no double-fire.
    // Belt-and-suspenders chat-message suppression. Even when we return false
    // from preUseActivity (which cancels activity.use()), some dnd5e code paths
    // post a usage card directly from the spell description. We attack this
    // from two angles:
    //   1. preCreateChatMessage: cancel the create entirely (cleanest)
    //   2. postCreateUsageMessage: delete it after the fact (fallback)

    // Cancel any chat message that's a vanilla activity-usage card for a
    // heal activity we just intercepted (preferred — message never appears).
    // dnd5e tags usage cards with various flag shapes depending on minor
    // version + usage path. We check ALL the places the activity/item id
    // might live: flags.dnd5e.activity (string), flags.dnd5e.activity.id,
    // flags.dnd5e.use.activityId, flags.dnd5e.item.id/uuid, etc.
    Hooks.on("preCreateChatMessage", (message, data) => {
      if (!game.user.isGM) return;
      if (!QolSettings.get("enableHealPipeline")) return;

      const now = Date.now();
      if ((now - this._lastHandledAt) > 5000) return;

      const dnd = data?.flags?.dnd5e ?? message?.flags?.dnd5e ?? {};
      const myActId   = this._lastHandledActivityId;
      const myItemUuid = this._lastHandledItemUuid;

      // Collect every plausible "what is this card about" id from the flags
      const candidates = [
        typeof dnd.activity === "string" ? dnd.activity : null,
        dnd.activity?.id,
        dnd.activity?.activityId,
        dnd.use?.activityId,
        dnd.item?.activityId,
        dnd.item?.id,
        dnd.item?.uuid,
        dnd.use?.itemId,
        dnd.use?.itemUuid,
      ].filter(x => typeof x === "string" && x.length > 0);

      // Also detect by content/template — usage cards typically have a
      // dnd5e.use flag block, and we can match the parent item UUID inside
      const contentClasses = (data?.content ?? "").match(/data-(item|activity)-uuid="([^"]+)"/g) ?? [];
      for (const m of contentClasses) {
        const v = m.split('"')[1];
        if (v) candidates.push(v);
      }

      // Cancel if any candidate matches
      for (const c of candidates) {
        if (myActId && (c === myActId || c.endsWith(`.${myActId}`))) return false;
        if (myItemUuid && (c === myItemUuid || c.includes(myItemUuid.split(".").pop()))) return false;
      }
    });

    // Fallback: if a vanilla card slipped past preCreateChatMessage, delete it.
    Hooks.on("dnd5e.postCreateUsageMessage", (activity, message) => {
      if (!game.user.isGM) return;
      if (!activity || !HealPipeline._activityHeals(activity)) return;
      if (!QolSettings.get("enableHealPipeline")) return;
      const now = Date.now();
      if (this._lastHandledActivityId === activity.id && (now - this._lastHandledAt) < 5000) {
        try {
          message?.delete?.().catch(() => {});
        } catch (_) { /* non-blocking */ }
      }
    });

    Hooks.on("dnd5e.preUseActivity", (activity, usageConfig, dialogConfig, messageConfig) => {
      // Diagnostic — surface every fire so we can see what's actually happening
      console.log(`${MODULE_ID} | HealPipeline.preUseActivity fired:`, {
        activityName: activity?.name,
        activityType: activity?.type,
        item:         activity?.item?.name,
        actor:        activity?.actor?.name,
        isGM:         game.user.isGM,
        enabled:      QolSettings.get("enableHealPipeline"),
      });

      if (!game.user.isGM) return;
      if (!QolSettings.get("enableHealPipeline")) return;
      if (!activity) return;

      // Broadened detection: not all heal-bearing activities have type === "heal".
      // Some (like Prayer of Healing in certain dnd5e versions) are type "utility"
      // with a healing field, or "save" with healing on success. We accept ANY
      // activity whose toObject() has a healing block with a non-empty formula.
      const isHeal = HealPipeline._activityHeals(activity);
      if (!isHeal) {
        console.log(`${MODULE_ID} | HealPipeline: not a heal (type=${activity.type}) — pass through`);
        return;
      }
      console.log(`${MODULE_ID} | HealPipeline: INTERCEPTED ${activity.item?.name} → canceling vanilla flow, running pipeline`);

      // Run our pipeline asynchronously
      this._onHealActivityIntercept(activity, usageConfig)
        .catch(err => console.error(`${MODULE_ID} | HealPipeline intercept threw:`, err));

      // Cancel the vanilla flow entirely — no dialog, no auto-roll, no chat
      return false;
    });

    // Template-shape heals — wait for template placement, then collect tokens inside
    Hooks.on("dnd5e.createActivityTemplate", (activity, templates) => {
      if (!this._pendingTemplateHeal) return;
      if (this._pendingTemplateHeal.activity.id !== activity.id) return;
      this._onTemplatePlaced(templates).catch(err =>
        console.error(`${MODULE_ID} | HealPipeline._onTemplatePlaced threw:`, err));
    });

    // Render hook does TWO jobs every time a heal card is rendered:
    //   1. Sync DOM with flags.targets state — if any target has applied:true,
    //      replace its Apply button with the disabled "Applied" version. This
    //      runs on EVERY render, so message.update()-triggered re-renders
    //      can't revert the visual state to the original "Apply" HTML.
    //   2. Wire click handlers (deduped — V13 fires both renderChatMessage
    //      AND renderChatMessageHTML; without dedupe each button gets two
    //      listeners and one user click fires _onApplyClick twice).
    const wireRender = (message, html) => {
      const flags = message.flags?.[MODULE_ID];
      if (flags?.type !== "healCard") return;
      const el = html instanceof HTMLElement ? html : (html?.[0] ?? html);
      if (!el) return;

      // Job 1: sync visual state with flags.targets — runs every render
      HealCardRenderer.syncAppliedState(el, flags);

      // Job 2: wire buttons (only once per element)
      if (el.dataset && el.dataset.aceqolHealWired === "1") return;
      if (el.dataset) el.dataset.aceqolHealWired = "1";
      HealCardRenderer.wireButtons(el, message, flags);
    };
    Hooks.on("renderChatMessage",     wireRender);
    Hooks.on("renderChatMessageHTML", wireRender);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Activity Intercept — entry point
  // ═══════════════════════════════════════════════════════════════════════════

  async _onHealActivityIntercept(activity, usageConfig) {
    // Debounce — preUseActivity can fire twice on rapid double-click
    const now = Date.now();
    if (this._lastHandledActivityId === activity.id && (now - this._lastHandledAt) < 500) return;
    this._lastHandledActivityId = activity.id;
    this._lastHandledItemUuid   = activity.item?.uuid ?? null;
    this._lastHandledAt = now;

    const item  = activity.item;
    const actor = activity.actor;
    if (!item || !actor) return;

    const classification = this._classify(activity);
    console.log(`${MODULE_ID} | HealPipeline: ${item.name} → shape=${classification.shape} count=${classification.count} range=${classification.rangeFt}ft tempHP=${classification.isTempHP}`);

    // Pre-flight resource check — abort if no spell slots / charges remaining.
    // Without this guard, the user picks targets and rolls only to find out
    // the cast had no resources. (Note: GM can still bypass by toggling
    // "Consume resource" off in the picker, which we honor below.)
    if (!this._hasResources(activity)) {
      ui.notifications.warn(`${item.name}: no resources remaining to cast.`);
      return;
    }

    // Template heals: wait for template placement
    if (classification.shape === "template") {
      this._pendingTemplateHeal = { activity, classification, usageConfig };
      return;
    }

    // Pick targets — picker returns { tokens, consume } for non-self,
    // or just an array of tokens for self auto-target.
    let pickResult;
    try {
      pickResult = await this._resolveTargets(activity, classification);
    } catch (err) {
      console.error(`${MODULE_ID} | HealPipeline target resolution failed:`, err);
      return;
    }
    // Normalize to { tokens, consume } shape — self-target shortcut returns array
    let targets, consume;
    if (Array.isArray(pickResult)) { targets = pickResult; consume = true; }
    else { targets = pickResult?.tokens ?? []; consume = pickResult?.consume ?? true; }

    if (!targets.length) {
      ui.notifications.info(`${item.name}: heal canceled — no targets selected (no resources spent).`);
      return;
    }

    // Consume resources only if the user left the toggle ON in the picker.
    // Off = free cast (testing or houserule); spell slot / charges preserved.
    if (consume) {
      const ok = await this._consumeResources(activity, usageConfig);
      if (ok === false) {
        // Resource check failed mid-consume (raced with another cast or got
        // out-of-sync). Abort the heal — user already saw the warning toast.
        return;
      }
    } else {
      console.log(`${MODULE_ID} | HealPipeline: consume toggle off — skipping resource decrement`);
    }

    await this._rollAndPostCard(activity, actor, item, targets, classification, usageConfig);
  }

  /**
   * Consume the activity's resources (charges, spell slots, linked uses).
   *
   * Strategy: try dnd5e's `activity.consume()` first (handles charges, linked
   * items, etc.). For spells, snapshot the slot count before/after — if
   * nothing changed (because we cancelled the vanilla flow before dnd5e's
   * slot-selection dialog could populate `usageConfig.spell.slot`), manually
   * decrement the slot at the spell's base level.
   *
   * If we can't consume because the actor has no slots/charges left, return
   * false so the caller can abort the heal (no point firing if nothing to spend).
   */
  async _consumeResources(activity, usageConfig) {
    const item  = activity.item;
    const actor = activity.actor;
    if (!item || !actor) return true;

    // Snapshot pre-consume state for spells
    const isSpell = item.type === "spell";
    const baseLevel = parseInt(item.system?.level ?? 0);
    const slotKey  = usageConfig?.spell?.slot
                  ?? (Number.isFinite(baseLevel) && baseLevel > 0 ? `spell${baseLevel}` : null);
    const beforeSlots = (isSpell && slotKey)
      ? (actor.system?.spells?.[slotKey]?.value ?? 0)
      : null;

    // Snapshot pre-consume charges (uses.spent)
    const beforeUses = parseInt(item.system?.uses?.spent ?? activity.uses?.spent ?? 0) || 0;

    // Try the dnd5e API
    try {
      if (typeof activity.consume === "function") {
        await activity.consume(usageConfig ?? {}, { create: false });
      }
    } catch (err) {
      console.warn(`${MODULE_ID} | HealPipeline: activity.consume() threw:`, err);
    }

    // Re-read post-consume state
    const afterSlots = (isSpell && slotKey)
      ? (actor.system?.spells?.[slotKey]?.value ?? 0)
      : null;
    const afterUses = parseInt(item.system?.uses?.spent ?? activity.uses?.spent ?? 0) || 0;

    // ── Spell-slot fallback ──
    // If activity.consume() didn't decrement the slot (because usageConfig
    // didn't have slot info — common when we cancel the vanilla flow), do it
    // ourselves at the spell's base level.
    if (isSpell && slotKey && beforeSlots !== null && afterSlots === beforeSlots) {
      if (beforeSlots > 0) {
        await actor.update({ [`system.spells.${slotKey}.value`]: beforeSlots - 1 });
        console.log(`${MODULE_ID} | HealPipeline: manually decremented ${slotKey} (${beforeSlots} → ${beforeSlots - 1})`);
      } else {
        // No slots and consume didn't replenish — caller should abort
        ui.notifications.warn(`${item.name}: no ${slotKey.replace("spell", "level ")} slots remaining.`);
        return false;
      }
    }

    return true;
  }

  /**
   * Pre-flight check — does the actor actually have the resources to use
   * this activity? Returns true if they do (or if no consumption is required),
   * false if they're tapped out. Called BEFORE the picker so the user
   * doesn't waste time targeting and only THEN find out they're empty.
   */
  _hasResources(activity) {
    const item  = activity.item;
    const actor = activity.actor;
    if (!item || !actor) return true;

    // Spells: check spell slot at the base level (upcasting is via the
    // dnd5e level-select dialog which fires before our hook normally)
    if (item.type === "spell") {
      const baseLevel = parseInt(item.system?.level ?? 0);
      if (Number.isFinite(baseLevel) && baseLevel > 0) {
        // Check if ANY slot at >= baseLevel has uses
        for (let lvl = baseLevel; lvl <= 9; lvl++) {
          const slots = actor.system?.spells?.[`spell${lvl}`];
          if ((slots?.value ?? 0) > 0) return true;
        }
        // No slots at any usable level
        return false;
      }
    }

    // Items with limited uses
    const uses = item.system?.uses;
    if (uses && Number.isFinite(uses.max) && uses.max > 0) {
      const remaining = (uses.max - (uses.spent ?? 0));
      if (remaining <= 0) return false;
    }

    return true;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Classification — derive targeting profile from activity data
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Inspect the activity's target/range/healing fields and return a flat
   * description of how this heal should be targeted and applied.
   * Defensive against schema variations across dnd5e minor versions.
   */
  _classify(activity) {
    const item     = activity.item;
    const sys      = activity.toObject?.() ?? activity;
    const target   = sys.target  ?? activity.target  ?? {};
    const range    = sys.range   ?? activity.range   ?? {};
    const healing  = sys.healing ?? activity.healing ?? {};

    // Item-level fallbacks — many DDB-imported spells leave activity-level
    // target/range fields blank but populate the spell-item-level ones.
    // E.g. Prayer of Healing's activity has range.units="self" (wrong) but
    // the item has range.value=30, range.units="ft", target.value=6.
    const itemTarget = item?.system?.target ?? {};
    const itemRange  = item?.system?.range  ?? {};

    // ── Range (in feet) ─────────────────────────────────────────────────────
    // Try activity range first, fall back to item range if activity is blank.
    const useItemRange = !range.units || range.units === "self" && !range.value;
    const rSrc = useItemRange && (itemRange.units || itemRange.value) ? itemRange : range;
    const rUnits = (rSrc.units ?? "ft").toLowerCase();
    const rValue = parseInt(rSrc.value ?? rSrc.long ?? rSrc.short ?? 0);
    let rangeFt = 5;
    if (rUnits === "self")   rangeFt = 0;
    else if (rUnits === "touch")  rangeFt = 5;
    else if (rUnits === "any" || rUnits === "spec" || rUnits === "unlimited") rangeFt = Infinity;
    else if (rUnits === "ft" || rUnits === "feet") rangeFt = Number.isFinite(rValue) ? rValue : 5;
    else if (rUnits === "mi" || rUnits === "miles") rangeFt = (rValue || 1) * 5280;
    else rangeFt = Number.isFinite(rValue) ? rValue : 5;

    // ── Target count (try activity, fall back to item, then description) ──
    let count = parseInt(target.affects?.count);
    if (!Number.isFinite(count) || count <= 0) {
      // Fall back to item-level target value (DDB stores spell target count here)
      count = parseInt(itemTarget.value);
    }
    if (!Number.isFinite(count) || count <= 0) {
      // Last resort: parse the description for "up to N creatures" patterns.
      // Many DDB-imported heals leave structured data blank but the description
      // text is verbatim RAW. Catches "up to five", "up to 6 creatures", etc.
      count = HealPipeline._parseCountFromDescription(item?.system?.description?.value ?? "");
    }
    if (!Number.isFinite(count) || count <= 0) count = 1;

    // ── Target shape ─────────────────────────────────────────────────────────
    // Precedence:
    //   1. template defined → "template"
    //   2. affects.type EXPLICITLY === "self" → "self" (Second Wind, Lay on Hands)
    //   3. count > 1 → "multi"
    //   4. fallback → "single"
    //
    // Note: we DON'T force "self" just because rangeFt === 0. DDB-imported spells
    // often have range.units="self" by mistake (Prayer of Healing's activity is
    // a known case). Without an explicit affects.type === "self", the picker
    // should always run — let the GM decide.
    let shape = "single";
    const templateType = target.template?.type ?? itemTarget.template?.type ?? "";
    const affectsType  = (target.affects?.type ?? itemTarget.type ?? "creature").toLowerCase();
    if (templateType) shape = "template";
    else if (affectsType === "self") shape = "self";
    else if (count > 1) shape = "multi";
    else shape = "single";

    // ── Temp HP detection ────────────────────────────────────────────────────
    // Healing types may be a Set (V13 dnd5e schema) or array (V12). Normalize.
    let healingTypes = healing.types ?? [];
    if (healingTypes instanceof Set) healingTypes = [...healingTypes];
    if (!Array.isArray(healingTypes)) healingTypes = [];
    const isTempHP = healingTypes.includes("temphp");

    return {
      shape,                          // "self" | "single" | "multi" | "template"
      count,                          // integer max targets
      rangeFt,                        // distance (feet); Infinity for unlimited
      affectsType,                    // "self" | "creature" | "ally" | "enemy" | etc.
      isTempHP,                       // apply to .hp.temp instead of .hp.value
      template: target.template ?? null,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Target Resolution — picker dialog or auto-target
  // ═══════════════════════════════════════════════════════════════════════════

  async _resolveTargets(activity, classification) {
    const actor = activity.actor;

    // Self-only — no picker needed
    if (classification.shape === "self") {
      const tok = actor.getActiveTokens()?.[0]
               ?? canvas.tokens?.placeables.find(t => t.actor?.id === actor.id);
      return tok ? [tok] : [];
    }

    // Single or multi-target — show picker
    return await HealTargetPicker.pick(activity, classification);
  }

  async _onTemplatePlaced(templates) {
    if (!this._pendingTemplateHeal) return;
    const { activity, classification, usageConfig } = this._pendingTemplateHeal;
    this._pendingTemplateHeal = null;

    const tmpl = templates?.[0];
    if (!tmpl) return;

    // Collect tokens inside the template
    const doc = tmpl.document ?? tmpl;
    const inside = canvas.tokens?.placeables.filter(t =>
      this._isTokenInsideTemplate(t, doc)
    ) ?? [];

    // Filter to count limit (template heals usually heal everyone inside)
    const targets = inside.slice(0, classification.count || inside.length);
    if (!targets.length) {
      ui.notifications.info(`${activity.item.name}: no creatures in template area.`);
      return;
    }

    await this._rollAndPostCard(activity, activity.actor, activity.item, targets, classification, usageConfig);
  }

  /**
   * Hit-test a token against a measured template. Uses Foundry's built-in
   * containsPoint when available, falls back to grid math otherwise.
   */
  _isTokenInsideTemplate(token, templateDoc) {
    try {
      const tx = token.center?.x ?? token.x;
      const ty = token.center?.y ?? token.y;
      const tmplObj = templateDoc.object ?? templateDoc;
      if (typeof tmplObj.shape?.contains === "function") {
        return tmplObj.shape.contains(tx - templateDoc.x, ty - templateDoc.y);
      }
      // Fallback: bounding-circle distance check
      const dx = tx - templateDoc.x;
      const dy = ty - templateDoc.y;
      const dist = Math.hypot(dx, dy);
      const grid = canvas.grid?.size ?? 100;
      const distFt = (dist / grid) * (canvas.scene?.grid?.distance ?? 5);
      return distFt <= (templateDoc.distance ?? 0);
    } catch (_) {
      return false;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Description Parsing — extract count from spell text when data is empty
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Look for "up to N creatures" / "affects N creatures" / "each creature
   * within X feet" patterns in a spell's description and return the implied
   * target count. Catches Prayer of Healing ("Affects up to five creatures"),
   * Mass Healing Word ("up to six creatures"), Cure Wounds ("a creature"
   * → 1), etc. Returns 0 if nothing matches (caller falls back to 1).
   */
  static _parseCountFromDescription(html) {
    if (!html || typeof html !== "string") return 0;
    // Strip HTML tags for cleaner regex
    const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").toLowerCase();

    const WORDS = {
      one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
      seven: 7, eight: 8, nine: 9, ten: 10, twelve: 12,
    };

    // Pattern A: "up to N creatures" / "up to five creatures of your choice"
    let m = text.match(/up to (\d+|one|two|three|four|five|six|seven|eight|nine|ten|twelve)\s+(?:creatures?|allies|targets|willing)/);
    if (m) {
      const n = WORDS[m[1]] ?? parseInt(m[1]);
      if (Number.isFinite(n) && n > 0) return n;
    }

    // Pattern B: "affects up to N creatures"
    m = text.match(/affects\s+up to (\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+/);
    if (m) {
      const n = WORDS[m[1]] ?? parseInt(m[1]);
      if (Number.isFinite(n) && n > 0) return n;
    }

    // Pattern C: "N creatures of your choice"
    m = text.match(/(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+creatures?\s+of\s+your\s+choice/);
    if (m) {
      const n = WORDS[m[1]] ?? parseInt(m[1]);
      if (Number.isFinite(n) && n > 0) return n;
    }

    // Pattern D: "each creature within" → AoE-style; cap at 8 (reasonable
    // ceiling for an emanation/sphere) — caller can still pick fewer.
    if (/each\s+(?:friendly\s+|willing\s+)?creature/.test(text)) return 8;

    return 0;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Heal Detection — broader than just type === "heal"
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Decide if an activity outputs healing. Catches:
   *   - type === "heal" (direct heal activities like Cure Wounds, Repair)
   *   - activities with a healing.number > 0 (some "utility" or "save"
   *     activities that produce healing as their primary output)
   *   - activities whose item description contains [[/healing ...]] enrichers
   *     and whose system has healing fields (defensive)
   */
  static _activityHeals(activity) {
    if (!activity) return false;
    if (activity.type === "heal") return true;

    const obj = activity.toObject?.() ?? {};
    const h   = obj.healing ?? activity.healing ?? null;
    if (!h) return false;

    // Has explicit dice or custom formula?
    const num = parseInt(h.number) || 0;
    const den = parseInt(h.denomination) || 0;
    const customF = (h.custom?.formula ?? "").toString().trim();
    const bonus   = (h.bonus ?? "").toString().trim();
    if (num > 0 && den > 0) return true;
    if (customF) return true;
    if (bonus) return true;
    return false;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Formula Construction — turn activity.healing into a Roll formula string
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * dnd5e 5.x heal activity stores the healing as { number, denomination,
   * bonus, types, custom: { enabled, formula } }. This converts it into a
   * single Foundry-evaluable formula string.
   *
   * Custom formula override:    custom.enabled=true → use custom.formula verbatim
   * Standard:                    `{number}d{denomination}` + (bonus ? ` + ${bonus}` : "")
   */
  static _buildHealFormula(activity, usageConfig = null) {
    const obj = activity.toObject?.() ?? activity;
    const h   = obj.healing ?? activity.healing ?? {};

    // Custom formula override (use as-is, no scaling — assume the GM wrote it
    // exactly as they want)
    if (h.custom?.enabled && h.custom?.formula) {
      return h.custom.formula;
    }

    // Standard dice + bonus
    const num = parseInt(h.number) || 0;
    const den = parseInt(h.denomination) || 0;
    const bonus = (h.bonus ?? "").toString().trim();

    let formula = "";
    if (num > 0 && den > 0) formula = `${num}d${den}`;
    if (bonus) formula = formula ? `${formula} + ${bonus}` : bonus;

    // ── Upcast scaling ──
    // When a spell is cast at a higher level than its base (Healing Word at
    // L3 instead of L1), the heal scales. RAW Cure Wounds 2024: +2d8 per slot
    // above 1st. Healing Word: +2d4. Mass Healing Word: +1d4. Etc.
    //
    // dnd5e 5.x stores the scaling expression on the activity. Read it from
    // `activity.healing.scaling.formula` if present; otherwise fall back to
    // the heuristic "one extra base dice block per level above" (Cure Wounds
    // pattern — works for the vast majority of heal spells).
    try {
      const item = activity.item ?? activity.parent?.parent ?? null;
      const baseLevel = parseInt(item?.system?.level ?? 0);
      const slotKey = usageConfig?.spell?.slot ?? null;
      // slotKey forms: "spell1".."spell9", "pact"
      let slotLevel = baseLevel;
      if (typeof slotKey === "string") {
        const m = slotKey.match(/spell(\d+)/);
        if (m) slotLevel = parseInt(m[1]);
        else if (slotKey === "pact") slotLevel = parseInt(item?.actor?.system?.spells?.pact?.level ?? baseLevel);
      } else if (typeof usageConfig?.spell?.level === "number") {
        slotLevel = usageConfig.spell.level;
      }
      const levelsAbove = Math.max(0, slotLevel - baseLevel);

      if (levelsAbove > 0 && baseLevel > 0) {
        const scalingFormula = h.scaling?.formula?.trim?.();
        if (scalingFormula) {
          // Activity has explicit scaling expression — apply it `levelsAbove` times
          const upcastPart = levelsAbove === 1
            ? scalingFormula
            : `${levelsAbove} * (${scalingFormula})`;
          formula = formula ? `${formula} + ${upcastPart}` : upcastPart;
        } else if (num > 0 && den > 0) {
          // Heuristic fallback: add `levelsAbove` more copies of the base dice
          // (Cure Wounds 2024 = 2d8 base, +2d8 per slot above)
          formula = formula
            ? `${formula} + ${num * levelsAbove}d${den}`
            : `${num * levelsAbove}d${den}`;
        }
        console.log(`${MODULE_ID} | Heal upcast: ${item?.name} cast at ${slotLevel} (base ${baseLevel}) → formula "${formula}"`);
      }
    } catch (err) {
      console.warn(`${MODULE_ID} | Heal upcast scaling failed (non-fatal):`, err);
    }

    return formula || "0";
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Roll + Post Card
  // ═══════════════════════════════════════════════════════════════════════════

  async _rollAndPostCard(activity, actor, item, targets, classification, usageConfig = null) {
    // Build the heal Roll directly from the activity's healing data.
    //
    // We do NOT call activity.rollDamage() because:
    //   1. It opens a "Roll Configuration" dialog the user has to dismiss
    //   2. Its internal flow may auto-post a dnd5e damage chat message
    //      that duplicates our own card and surfaces the floating
    //      damage-applicator widget the user reported.
    // Direct construction gives us a clean Roll with full @ data resolution
    // (so @flags.dnd5e.summon.mod still works) and zero extra UI.
    //
    // Pass usageConfig so _buildHealFormula can detect upcasting and add
    // the per-level scaling dice (Cure Wounds 2024: +2d8 per slot above 1st).
    const formula = HealPipeline._buildHealFormula(activity, usageConfig);
    const rollData = activity.getRollData?.() ?? actor.getRollData();
    let roll;
    try {
      roll = new Roll(formula, rollData);
      await roll.evaluate();
    } catch (err) {
      console.error(`${MODULE_ID} | Heal roll failed (formula="${formula}"):`, err);
      ui.notifications.error(`${item.name}: heal roll failed — check formula in activity.`);
      return;
    }

    // DSN auto-fires when ChatMessage.create runs below (chat-message hook).
    // Don't trigger it manually — that would double-animate.

    // Build per-target HP-delta data
    const targetData = targets.map(token => {
      const tActor = token.actor;
      const hp = tActor?.system?.attributes?.hp ?? {};
      const cur = hp.value ?? 0;
      const max = hp.max ?? 0;
      const tmp = hp.temp ?? 0;
      const heal = roll.total ?? 0;
      let projected;
      if (classification.isTempHP) {
        // Temp HP: replaces if greater, otherwise no-op (RAW)
        projected = Math.max(tmp, heal);
      } else {
        projected = Math.min(max, cur + heal);
      }
      return {
        tokenId:       token.id,
        tokenDocId:    token.document?.id ?? token.id,
        sceneId:       token.scene?.id ?? canvas.scene?.id,
        actorId:       tActor?.id,
        actorUuid:     tActor?.uuid,
        name:          token.document?.name ?? tActor?.name ?? "?",
        img:           token.document?.texture?.src ?? tActor?.img,
        currentHp:     cur,
        maxHp:         max,
        currentTempHp: tmp,
        healAmount:    heal,
        projectedHp:   projected,
        isTempHP:      classification.isTempHP,
        applied:       false,
      };
    });

    // Build + post the card
    const html = HealCardRenderer.buildCard({
      item, actor, roll, targetData, classification,
    });

    await ChatMessage.create({
      user:      game.user.id,
      speaker:   ChatMessage.getSpeaker({ actor }),
      content:   html,
      rolls:     [roll],
      sound:     CONFIG.sounds?.dice,
      flags: {
        [MODULE_ID]: {
          type:           "healCard",
          itemUuid:       item.uuid,
          actorUuid:      actor.uuid,
          rollFormula:    roll.formula,
          rollTotal:      roll.total,
          isTempHP:       classification.isTempHP,
          targets:        targetData,
        },
      },
    });
  }
}
