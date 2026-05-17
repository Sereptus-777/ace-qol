// ─── ACE: QOL — Save Automation Engine ────────────────────────────────────────
// Handles saving throw spells (Moonbeam, Fireball, Hold Person, etc.)
//
// Phase A: Instant AoE — template auto-targeting, live target card, split
//          NPC rolls / PC whispered prompts, redesigned results card.
// Phase B (hooks only): Persistent AoE — stores template + timing data,
//          emits ace-qol.persistentSpellCreated for concentration widget.
//
// Flow:
//   1. Detect save-based spell usage (dnd5e.useActivity)
//   2. If spell places a template → stash pending data, wait for createMeasuredTemplate
//      If no template → use game.user.targets, post live target card immediately
//   3. Live target card: NPC rows + PC rows, TARGETED/SELECTED toggle, remove buttons
//   4. GM clicks ROLL NPC SAVES → NPC saves rolled, PC whispered prompts sent
//   5. PCs click their own ROLL button → result posted publicly, GM card updated
//   6. Results card: slim rows, color-coded reasons, manual override, Apply/Undo
//
// GM ALWAYS clicks the button. No auto-rolling.
// ──────────────────────────────────────────────────────────────────────────────

import { MODULE_ID } from "./ace-qol.mjs";
import { QolSettings } from "./settings.mjs";
import { CombatState } from "./combat-state.mjs";
import { DamageConstants } from "./damage-engine.mjs";
import { DamageApplicator } from "./damage-applicator.mjs";
import { getSpellTiming, TIMING } from "./spell-timing.mjs";
import { CoverEngine } from "./cover-engine.mjs";
import { DescriptionParser } from "./description-parser.mjs";
import { ConditionLibrary } from "./condition-library.mjs";
import { PolymorphSpellPipeline } from "./polymorph-spell-pipeline.mjs";
import { DamageCalculator } from "./damage-calculator.mjs";

export class SaveEngine {

  /** In-memory override cache — avoids re-render on every button click.
   *  Key: `${messageId}|${tokenDocId}` → multiplier (number)
   *  Flushed to flags only when APPLY ALL is clicked. */
  static overrideCache = new Map();

  constructor({ damageEngine } = {}) {
    this.damageEngine = damageEngine;

    /** @type {object|null} Pending save spell waiting for template placement */
    this._pendingSaveSpell = null;

    /** @type {Map<string, number>} activityId → timestamp; tracks activities
     *  we've already posted save cards for, so the createChatMessage fallback
     *  hook (v0.4.22) doesn't double-fire when the standard
     *  postCreateUsageMessage hook also processes the same cast. Entries
     *  auto-prune after 5 seconds. */
    this._processedActivityIds = new Map();

    this._registerHooks();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Hook Registration
  // ═══════════════════════════════════════════════════════════════════════════

  _registerHooks() {
    // ── Detect save-based spells/abilities ──
    // dnd5e 5.2.5 uses postCreateUsageMessage, NOT useActivity
    Hooks.on("dnd5e.postCreateUsageMessage", (activity, message) => {
      console.log(`${MODULE_ID} | postCreateUsageMessage fired:`, activity?.item?.name, "save:", activity?.save?.ability);
      this._onUseActivity(activity);
    });
    // Fallback for older dnd5e versions that might use useActivity
    Hooks.on("dnd5e.useActivity", (activity, usageConfig, dialogConfig, messageConfig) => {
      console.log(`${MODULE_ID} | useActivity fired (legacy):`, activity?.item?.name);
      this._onUseActivity(activity);
    });

    // ── v0.4.22 FALLBACK: createChatMessage detection for non-standard cast paths ──
    //
    // Some cast paths skip the `dnd5e.postCreateUsageMessage` hook entirely
    // (right-click → "Display Card", certain macros, drag-and-drop). These
    // post the description card without firing our standard processing.
    //
    // Live impact: Hellfire Orb (Death Knight feat-type) and Hold Person (Chudd)
    // both hit this path during a session — description card appeared but no
    // save card. Workaround was a manual `_postLiveTargetCard` call from JS.
    //
    // This fallback hook listens to ALL chat-message creation. When a message
    // has `flags.dnd5e.activity.type === "save"` AND we haven't already
    // processed that activity ID via the standard hook (within the 5s TTL),
    // we resolve the activity from the actor+item+activityId path and run it
    // through `_onUseActivity` as if the standard hook had fired.
    //
    // Dedupe via `_processedActivityIds` Map prevents double-firing.
    Hooks.on("createChatMessage", async (message) => {
      try {
        if (!game.user.isGM) return;
        const dnd5eFlag = message.flags?.dnd5e;
        const activityFlag = dnd5eFlag?.activity;
        if (activityFlag?.type !== "save") return;

        // ── v0.4.22.1 hotfix ──
        // Previous version read `activityFlag.actor` and `activityFlag.item`
        // as separate fields and bailed when they were undefined. dnd5e 5.x
        // actually stores the activity reference as a single
        // `activityFlag.uuid` of the form `Actor.X.Item.Y.Activity.Z`.
        // Use that UUID to resolve the activity directly via fromUuid().
        //
        // Also: the dedup key was `activityFlag.id` (e.g. "dnd5eactivity000")
        // which is dnd5e's default activity ID — SHARED across all items
        // that have only a single primary activity. A Hellfire Orb cast
        // would be wrongly deduped against an earlier Hold Person cast
        // because both have id "dnd5eactivity000". Now uses the FULL UUID
        // as the dedup key.

        const activityUuid = activityFlag?.uuid;
        const activityId   = activityFlag?.id;
        const dedupKey = activityUuid || activityId;
        if (!dedupKey) return;

        // Fast-bail: if this activity was processed within the 5s TTL
        // (same cast repeated, prior cast still in dedup window), skip
        // without yielding.
        if (this._processedActivityIds.has(dedupKey)) return;

        // ── v0.4.22.2 race fix ──
        // The standard `dnd5e.postCreateUsageMessage` hook fires ~2ms after
        // `createChatMessage` for activities that go through the normal
        // path. Without yielding here, the fallback hook would race the
        // standard hook: both would call `_onUseActivity` for the same
        // cast (standard directly, fallback via setTimeout 50ms later).
        // The two calls fight over shared state (`overrideCache`, the
        // 200ms PC-save merge timeout, target sets), and the visible
        // symptom is first-cast-after-reload producing no save card.
        //
        // We wait 200ms. If `dnd5e.postCreateUsageMessage` fires in that
        // window, the standard handler's `_onUseActivity` will have set
        // the dedup synchronously at the top of the function — we re-check
        // and bail. The fallback only engages when the standard path
        // genuinely did not run (the case it was built for).
        await new Promise(r => setTimeout(r, 200));

        // Re-check dedup after the yield. If the standard hook fired
        // during the wait, it owns the activity — bail.
        if (this._processedActivityIds.has(dedupKey)) return;

        // Resolve the live activity. UUID path is the primary route in
        // modern dnd5e; the actor/item-id fallback handles older flag
        // shapes if they ever appear.
        let activity = null;
        if (activityUuid) {
          try { activity = await fromUuid(activityUuid); }
          catch (err) { console.warn(`${MODULE_ID} | createChatMessage fallback fromUuid failed for ${activityUuid}:`, err?.message ?? err); }
        }
        if (!activity) {
          // Legacy fallback: separate actor/item fields
          const actorId = activityFlag?.actor;
          const itemId  = activityFlag?.item;
          const actor = actorId ? game.actors.get(actorId) : null;
          const item  = (actor && itemId) ? actor.items.get(itemId) : null;
          if (actor && item && activityId) {
            const activities = item.system?.activities;
            if (activities) {
              try {
                if (typeof activities.get === "function") {
                  activity = activities.get(activityId);
                } else {
                  for (const a of activities) {
                    if (a?.id === activityId) { activity = a; break; }
                  }
                }
              } catch (_) { /* iteration shape varies */ }
            }
          }
        }

        if (!activity) {
          console.warn(`${MODULE_ID} | createChatMessage fallback: could not resolve activity for ${dedupKey}`);
          return;
        }

        const itemName = activity?.item?.name ?? "(unknown)";
        console.log(`${MODULE_ID} | createChatMessage fallback firing for ${itemName} (uuid ${activityUuid ?? "no-uuid"} skipped postCreateUsageMessage)`);

        // Mark BEFORE calling _onUseActivity so the call itself doesn't
        // re-trigger via the standard hook (race-safe)
        this._processedActivityIds.set(dedupKey, Date.now());

        // Defer one tick so the chat message finishes posting first
        setTimeout(() => {
          try {
            this._onUseActivity(activity);
          } catch (err) {
            console.warn(`${MODULE_ID} | createChatMessage fallback _onUseActivity threw:`, err);
          }
        }, 50);
      } catch (err) {
        console.warn(`${MODULE_ID} | createChatMessage fallback hook failed:`, err);
      }
    });

    // ── Snap template origin to caster token ──
    Hooks.on("dnd5e.createActivityTemplate", (activity, templates) => {
      if (!game.user.isGM) return;
      const casterActor = activity?.actor ?? this._pendingSaveSpell?.actor;
      if (!casterActor) return;
      const casterToken = canvas.tokens.placeables.find(t => t.actor?.id === casterActor.id);
      if (!casterToken) return;
      for (const tmpl of (templates ?? [])) {
        const doc = tmpl.document ?? tmpl;
        doc.updateSource({
          x: casterToken.center.x,
          y: casterToken.center.y,
        });
        // Also update the PIXI object position if it exists
        if (tmpl.x !== undefined) {
          tmpl.x = casterToken.center.x;
          tmpl.y = casterToken.center.y;
        }
        console.log(`${MODULE_ID} | Snapped template origin to ${casterToken.name}`);
      }
    });

    // ── Template placement — auto-target tokens inside ──
    Hooks.on("createMeasuredTemplate", (templateDoc, context, userId) => {
      if (!game.user.isGM) return;
      // Small delay to let the PIXI shape render
      setTimeout(async () => {
        try {
          await this._onTemplateCreated(templateDoc);
        } catch (err) {
          console.error(`${MODULE_ID} | _onTemplateCreated CRASHED:`, err);
        }
      }, 100);
    });

    // ── Persistent button wiring for ALL save card types ──
    // V13 uses renderChatMessageHTML (HTMLElement), V12 uses renderChatMessage (jQuery)
    const _onRenderChatMessage = (message, html) => {
      const flags = message.flags?.[MODULE_ID];
      if (!flags?.type) return;

      const el = html instanceof HTMLElement ? html : (html[0] ?? html);


      // ── Save Prompt card (legacy — still supported) ──
      if (flags.type === "savePrompt") {
        this._wireSavePromptButtons(el, message, flags);
      }

      // ── Live Target List card ──
      if (flags.type === "saveTargetList") {
        this._wireTargetListButtons(el, message, flags);
      }

      // ── PC Save Prompt card (whispered to player) ──
      if (flags.type === "pcSavePrompt") {
        if (game.user.isGM) {
          // GM sees all whispers — hide prompt cards on GM side (GM uses dice icon instead)
          const chatMsg = el.closest?.(".chat-message") ?? el;
          chatMsg.classList.add("ace-qol-save-collapsed");
          return;
        }
        this._wirePcSaveButton(el, message, flags);
      }

      // ── PC Save Result — collapse on GM side (result shown inline in target list) ──
      if (flags.type === "pcSaveResult" && game.user.isGM) {
        const chatMsg = el.closest?.(".chat-message") ?? el;
        chatMsg.classList.add("ace-qol-save-collapsed");
      }

      // ── Save Results card — phase-aware wiring ──
      if (flags.type === "saveResults") {
        if (flags.phase === 1) {
          // Phase 1: saves only — wire ROLL DAMAGE button + portrait click-to-pan
          this._wireRollDamageButton(el, message, flags);
        } else {
          // Phase 2 (or legacy cards without phase flag): wire overrides + Apply/Undo
          this._wireSaveResultButtons(el, message, flags);
        }
        // Auto-collapse the target list card above this one
        this._collapseTargetListCard(flags);
      }
    };
    Hooks.on("renderChatMessage", _onRenderChatMessage);
    Hooks.on("renderChatMessageHTML", _onRenderChatMessage);

    // ── createChatMessage — reliable hook for PC save results (fires on ALL clients) ──
    Hooks.on("createChatMessage", (message) => {
      if (!game.user.isGM) return;
      const flags = message.flags?.[MODULE_ID];
      if (flags?.type === "pcSaveResult" && flags.castId) {
        console.log(`${MODULE_ID} | createChatMessage caught pcSaveResult for`, flags.tokenDocId, "castId:", flags.castId);
        // Small delay to let the DOM render first
        setTimeout(() => this._onPcSaveResultPosted(flags), 200);
      }
    });

    console.log(`${MODULE_ID} | Save engine hooks registered`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Template Auto-Targeting
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Find all tokens whose occupied grid squares overlap a measured template shape.
   * Checks every grid square the token occupies (for Large+ creatures) against the
   * template's PIXI shape in local coordinates.
   *
   * @param {MeasuredTemplateDocument} templateDoc
   * @returns {Token[]} array of Token placeables inside the template
   */
  static _getTokensInTemplate(templateDoc) {
    const templateObject = templateDoc.object;
    if (!templateObject?.shape) return [];

    const shape = templateObject.shape;
    const templateX = templateDoc.x;
    const templateY = templateDoc.y;
    const gridSize = canvas.grid.size;

    const tokensInside = [];

    for (const token of canvas.tokens.placeables) {
      const tokenDoc = token.document;
      const tokenGridW = tokenDoc.width ?? 1;   // width in grid squares
      const tokenGridH = tokenDoc.height ?? 1;  // height in grid squares
      const tokenX = tokenDoc.x;
      const tokenY = tokenDoc.y;

      let isInside = false;

      // Check every grid square the token occupies
      for (let gx = 0; gx < tokenGridW && !isInside; gx++) {
        for (let gy = 0; gy < tokenGridH && !isInside; gy++) {
          // Center of this grid square in world coordinates
          const centerX = tokenX + (gx + 0.5) * gridSize;
          const centerY = tokenY + (gy + 0.5) * gridSize;

          // Convert to template-local coordinates
          const localX = centerX - templateX;
          const localY = centerY - templateY;

          if (shape.contains(localX, localY)) {
            isInside = true;
          }
        }
      }

      if (isInside) {
        tokensInside.push(token);
      }
    }

    return tokensInside;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Detect Save-Based Spells/Abilities
  // ═══════════════════════════════════════════════════════════════════════════

  async _onUseActivity(activity, usageConfig, dialogConfig, messageConfig) {
    if (!game.user.isGM) return;

    const item = activity.item;
    const actor = activity.actor;
    if (!item || !actor) return;

    // v0.6.5: Detect movement-damage concentration spells (Spike Growth,
    // Wall of Thorns, etc.) that have a template + damage but NO save.
    // These don't fit the save-engine's save-on-entry model, but they
    // ARE persistent template spells that need movement-distance damage
    // tracking by the concentration widget. Stash a pending entry so
    // `_onTemplateCreated` can fire `ace-qol.persistentSpellCreated`
    // for them with no-save metadata.
    const save = activity.save;
    if (!save?.ability) {
      try {
        const templateType = activity?.target?.template?.type
                          ?? activity?.target?.type
                          ?? item.system?.target?.template?.type
                          ?? item.system?.target?.type
                          ?? "";
        const props = item.system?.properties ?? new Set();
        const hasConcentration = props.has?.("concentration") === true
                              || (Array.isArray(props) && props.includes("concentration"))
                              || activity?.duration?.concentration === true;

        // v0.6.5: Spike Growth-class spells have NO save and NO
        // `activity.damage.parts` — dnd5e stores them as `utility`
        // activities with damage described in the spell text only.
        // Parse the description for the standard "takes XdY <type> damage
        // for every 5 feet" pattern.
        let formula = null;
        let damageType = null;

        // Activity-level damage parts. Two known shapes:
        //   • dnd5e 5.x:   { number, denomination, bonus, types: [...] }
        //   • Legacy:      ["2d4", "piercing"]
        // (v0.6.5 originally only handled the legacy shape, so Chudd's
        // 2024 Spike Growth — which uses the new object shape — fell
        // through to the description regex, which then also failed.)
        const damageParts = activity?.damage?.parts ?? [];
        if (Array.isArray(damageParts) && damageParts.length > 0) {
          const p = damageParts[0];
          if (Array.isArray(p)) {
            formula    = p[0] ?? null;
            damageType = p[1] ?? null;
          } else if (p && typeof p === "object") {
            if (p.number != null && p.denomination != null) {
              formula = `${p.number}d${p.denomination}` + (p.bonus ? `+${p.bonus}` : "");
            }
            damageType = p.types?.[0] ?? null;
          }
        }

        // Description regex fallback — covers spells where damage isn't
        // on the activity (e.g. Spike Growth before re-import). Two
        // patterns since dnd5e descriptions can use plain text OR
        // dnd5e enrichers:
        //   • Plain:    "takes 2d4 piercing damage for every 5 feet"
        //   • Enricher: "takes [[/damage 2d4 type=piercing]] damage for every 5 feet"
        if (!formula) {
          const descRaw = item.system?.description?.value ?? "";
          const desc = String(descRaw).replace(/<[^>]+>/g, " ").replace(/&\w+;/g, " ");
          // Plain-text pattern first
          let m = desc.match(/takes?\s+(\d+d\d+)\s+([a-zA-Z]+)\s+damage\s+(?:for\s+every|per)\s+5\s+(?:feet|ft)/i);
          // Enricher pattern: [[/damage 2d4 type=piercing]] ... 5 feet
          if (!m) {
            m = desc.match(/\[\[\s*\/damage\s+(\d+d\d+)[^\]]*?type\s*=\s*([a-zA-Z]+)[^\]]*?\]\]\s*damage\s+(?:for\s+every|per)\s+5\s+(?:feet|ft)/i);
          }
          if (m) {
            formula    = m[1];
            damageType = m[2].toLowerCase();
          }
        }

        if (templateType && hasConcentration && formula) {
          this._pendingMovementDamageSpell = {
            activity,
            item,
            actor,
            damageTypes: damageType ? [damageType] : CombatState._getItemDamageTypes(item),
            damageFormula: formula,
            timing: getSpellTiming(item),
            activityId: activity.id,
          };
          console.log(`${MODULE_ID} | Movement-damage spell "${item.name}" detected (formula: ${formula} ${damageType ?? "?"}) — waiting for placement`);
        }
      } catch (err) {
        console.warn(`${MODULE_ID} | Movement-damage detection threw:`, err);
      }
      return; // No save flow needed for these
    }

    // ── v0.4.22 — Mark this activity as processed ──
    // The createChatMessage fallback hook (registered below) reads this Map
    // to skip activities already handled by the standard postCreateUsageMessage
    // path. Without this dedupe, both hooks would fire and post duplicate
    // save cards.
    //
    // v0.4.22.1: Mark BOTH the activity.uuid AND activity.id, because the
    // fallback hook keys on uuid (different items can share the default id
    // "dnd5eactivity000"). Marking only the id would leave the fallback
    // hook to fire spuriously for any subsequent cast that happens to share
    // the same default id.
    if (activity?.uuid) {
      this._processedActivityIds.set(activity.uuid, Date.now());
    }
    if (activity?.id) {
      this._processedActivityIds.set(activity.id, Date.now());
    }
    // Auto-prune entries older than 5 seconds
    const cutoff = Date.now() - 5000;
    for (const [k, ts] of this._processedActivityIds) {
      if (ts < cutoff) this._processedActivityIds.delete(k);
    }

    // ── Capture spell upcast level (RAW upcast scaling) ──
    // dnd5e 5.x stamps the chat message with `flags.dnd5e.use.spellLevel`
    // (the slot level the spell was actually cast at — can be > base level).
    // We thread this through to _rollSpellDamage so dnd5e's rollDamage
    // applies the proper "+ X dice per slot above base" scaling.
    //
    // Falls back to base spell level when no upcast info is available.
    // For cantrips (level 0), this stays 0 and character-level cantrip
    // scaling kicks in instead.
    let spellLevel = null;
    try {
      const useFlag = messageConfig?.data?.flags?.dnd5e?.use
                   ?? messageConfig?.flags?.dnd5e?.use
                   ?? usageConfig?.spell;
      if (useFlag) {
        spellLevel = Number(useFlag.spellLevel ?? useFlag.level ?? null);
      }
      // Fallback: use base item level
      if (!Number.isFinite(spellLevel) && item.system?.level !== undefined) {
        spellLevel = Number(item.system.level);
      }
    } catch (_) { /* non-fatal */ }

    // dnd5e 5.2.5: save.ability is a Set, not a string
    const saveAbility = (save.ability instanceof Set || save.ability instanceof Array)
      ? [...save.ability][0]
      : (typeof save.ability === "string" ? save.ability : String(save.ability));
    if (!saveAbility) return;
    const saveDC = save.dc?.value ?? save.dc ?? 10;
    const isSpell = item.type === "spell";

    // Get damage info
    const damageTypes = CombatState._getItemDamageTypes(item);
    const halfOnSave = this._detectHalfDamage(item, activity);

    // Get spell timing classification
    const timing = getSpellTiming(item);

    // ── Check if the spell/feat places a measured template ──
    // v0.4.22.3: dnd5e 5.x stores template config on the ACTIVITY for
    // feats (and modern-shape spells), and on the ITEM for legacy-shape
    // spells. Reading only `item.system.target.template.type` missed
    // every feat-with-template (Hellfire Orb, dragon breath weapons,
    // aura-of-dread style abilities), causing the handler to fall
    // through to the `game.user.targets` branch — which is empty
    // BEFORE the template lands and auto-targets tokens. Result:
    // first-cast-after-reload produced no save card. Check activity
    // first, item second.
    const templateType = activity?.target?.template?.type
                      ?? activity?.target?.type
                      ?? item.system?.target?.template?.type
                      ?? item.system?.target?.type
                      ?? "";

    if (templateType) {
      // Spell has a template — stash data, wait for createMeasuredTemplate hook
      this._pendingSaveSpell = {
        activity,
        item,
        actor,
        saveAbility,
        saveDC,
        halfOnSave,
        damageTypes,
        isSpell,
        timing,
        activityId: activity.id,
        spellLevel,
      };
      console.log(`${MODULE_ID} | Save spell "${item.name}" has template type "${templateType}" — waiting for template placement`);
      return;
    }

    // ── No template — use game.user.targets directly ──
    const targets = game.user.targets;
    if (!targets.size) return;

    let tokens = [...targets];

    // Exclude caster — same logic as the template path. See _onTemplateCreated
    // for full justification. GM can re-add via "+ TARGET SELECTED" button.
    if (QolSettings.get?.("excludeCasterFromTemplates") !== false) {
      tokens = tokens.filter(t => t.actor?.id !== actor?.id);
      if (!tokens.length) {
        console.log(`${MODULE_ID} | All targets were the caster — skipping save card`);
        return;
      }
    }

    // ── Fast-path for NPC-only single-target saves ──
    // If the GM is rolling on a single NPC with no PCs in the mix, the
    // live-target-card confirmation step is unnecessary friction — the GM
    // is just going to click ROLL SAVES anyway. Skip straight to rolling
    // and posting the result card. The GM can always pre-target multiple
    // creatures or include a PC if they want the confirmation step.
    const isNpcOnlySingleTarget = tokens.length === 1
      && !tokens[0].actor?.hasPlayerOwner;
    if (isNpcOnlySingleTarget) {
      console.log(`${MODULE_ID} | Single NPC target detected — skipping live-target-card, rolling immediately`);
      await this._fastResolveSingleNpcSave(item, actor, tokens[0], {
        saveAbility, saveDC, halfOnSave, damageTypes, isSpell, timing,
        activity,
      });
      return;
    }

    await this._postLiveTargetCard(item, actor, tokens, {
      saveAbility, saveDC, halfOnSave, damageTypes, isSpell, timing,
      activityId: activity.id,
      spellLevel,
    });
  }

  /**
   * Fast-path for single NPC target: roll the save immediately and post the
   * Phase 1 result card. Skips the live-target-card confirmation step.
   *
   * Mirrors the relevant subset of _rollNpcSavesFromTargetList — same
   * roll, same condition application, same wasted-concentration drop, same
   * Phase 1 card. Does NOT support template AOEs, multi-target, or PC
   * saves — those go through the normal flow.
   */
  async _fastResolveSingleNpcSave(item, casterActor, token, opts) {
    // v0.4.22.4: Match the pacing of `_postLiveTargetCard`. Without this
    // the fast-path NPC save card lands instantly, ahead of the spell
    // animation. Configurable via `saveCardDelayAfterCastMs`.
    //
    // v0.6.2: `opts.skipDelay === true` bypasses the pacing for
    // entry-trigger NPC saves (Moonbeam token-walked-in path).
    if (!opts?.skipDelay) {
      try {
        const delay = Number(QolSettings.get?.("saveCardDelayAfterCastMs") ?? 1500);
        if (Number.isFinite(delay) && delay > 0) {
          await new Promise(r => setTimeout(r, delay));
        }
      } catch (_) { /* setting unavailable — proceed without delay */ }
    }

    const { saveAbility, saveDC, halfOnSave, damageTypes, isSpell, timing, activity } = opts;
    const activityId = activity?.id ?? null;

    // Build the target context the way _postLiveTargetCard does so
    // _rollSingleSave gets a normalized input.
    const tActor = token.actor;
    const rawMod = tActor?.system?.abilities?.[saveAbility]?.save;
    const saveMod = typeof rawMod === "number" ? rawMod : (rawMod?.value ?? rawMod?.mod ?? 0);
    const tgt = {
      tokenId:    token.id,
      tokenDocId: token.document?.id ?? token.id,
      sceneId:    canvas.scene?.id,
      actorId:    tActor?.id,
      name:       token.name ?? tActor?.name,
      img:        tActor?.img ?? token.document?.texture?.src,
      saveAbility,
      saveAbilityUpper: saveAbility.toUpperCase(),
      saveMod,
      saveBonus: saveMod,
      autoFailSave: false,
      superSaver: false,
      damageModifiers: tActor ? DamageCalculator.getTargetDamageModifiers(tActor, item) : {},
      currentHP: tActor?.system?.attributes?.hp?.value ?? 0,
      maxHP:     tActor?.system?.attributes?.hp?.max ?? 0,
    };

    // Roll the save
    const result = await this._rollSingleSave(tgt, saveAbility, saveDC, halfOnSave, casterActor?.id);

    // Emit saveComplete hook
    try {
      Hooks.callAll(`${MODULE_ID}.saveComplete`, {
        actor: tActor, tokenDocId: result.tokenDocId, saveAbility, passed: result.passed,
      });
    } catch (_) { /* non-fatal */ }

    // Compute hasDamage same way the regular path does
    const hasDamage = Array.isArray(damageTypes) && damageTypes.length > 0
                   && damageTypes.some(t => t && t !== "none");

    // Apply condition if appropriate
    let appliedConditions = [];
    if (!hasDamage) {
      try {
        appliedConditions = await this._applyFailedSaveConditions(item, [result], { saveAbility, saveDC, activityId, casterActor }) ?? [];
      } catch (err) {
        console.error(`${MODULE_ID} | Fast-path condition application failed:`, err);
      }
    }

    // Drop wasted concentration if nothing landed
    if (!hasDamage && appliedConditions.length === 0) {
      try {
        await this._dropCasterConcentrationIfNoEffect(item, casterActor);
      } catch (err) {
        console.warn(`${MODULE_ID} | Fast-path wasted-concentration drop failed:`, err);
      }
    }

    // Post the result card (Phase 1 — same builder as the normal flow)
    await this._postSaveResultsPhase1(item, casterActor, [result], {
      saveAbility, saveDC, halfOnSave, damageTypes, isSpell,
      timingType: timing?.type ?? null,
      templateDocId: null,
      templateSceneId: null,
      hasDamage,
      appliedConditions,
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Template Created — Resolve Pending Save Spell
  // ═══════════════════════════════════════════════════════════════════════════

  async _onTemplateCreated(templateDoc) {
    console.log(`${MODULE_ID} | _onTemplateCreated fired, pending save:`, !!this._pendingSaveSpell, "pending movement-damage:", !!this._pendingMovementDamageSpell);

    // v0.6.5: Movement-damage spell waiting for template (Spike Growth,
    // Wall of Thorns, etc.). Fire the persistent hook with no-save
    // metadata so concentration-widget tracks it for the Phase 2
    // movement-distance damage flow.
    if (this._pendingMovementDamageSpell && !this._pendingSaveSpell) {
      const pending = this._pendingMovementDamageSpell;
      this._pendingMovementDamageSpell = null;
      Hooks.callAll("ace-qol.persistentSpellCreated", {
        item: pending.item,
        actor: pending.actor,
        templateDoc,
        timing: pending.timing,
        saveAbility: null,        // no save = movement-damage variant
        saveDC: null,
        halfOnSave: false,
        damageTypes: pending.damageTypes,
        damageFormula: pending.damageFormula,
        tokens: [],
      });
      console.log(`${MODULE_ID} | Movement-damage "${pending.item.name}" — emitted ace-qol.persistentSpellCreated (no-save variant, formula: ${pending.damageFormula})`);
      return;
    }

    if (!this._pendingSaveSpell) return;

    const pending = this._pendingSaveSpell;
    this._pendingSaveSpell = null; // consume it

    // ── Primary: use game.user.targets (GM already targeted who they want) ──
    let tokens = [...game.user.targets];
    console.log(`${MODULE_ID} | game.user.targets: ${tokens.length} tokens:`, tokens.map(t => t.name));

    // ── Fallback: template geometry if GM had nothing targeted ──
    if (!tokens.length) {
      try {
        tokens = SaveEngine._getTokensInTemplate(templateDoc);
        console.log(`${MODULE_ID} | _getTokensInTemplate found ${tokens.length} tokens:`, tokens.map(t => t.name));
      } catch (err) {
        console.error(`${MODULE_ID} | _getTokensInTemplate FAILED:`, err);
      }
    }

    // Store template reference
    pending.templateDoc = templateDoc;

    const { item, actor, saveAbility, saveDC, halfOnSave, damageTypes, isSpell, timing, activityId } = pending;

    // ── Exclude the caster from the auto-targeted list ──
    // Foundry / dnd5e auto-targets every token an AOE template touches when
    // it lands. If the caster is standing inside their own AOE (Lightning
    // Bolt line origin, Fireball self-cast, etc.) they show up in the save
    // list. RAW the caster CAN target themselves with most damage AOEs, but
    // 99% of the time the GM doesn't want it. Filter them out by default;
    // the GM can re-add via "+ TARGET SELECTED" button if intentional.
    if (QolSettings.get?.("excludeCasterFromTemplates") !== false) {
      const before = tokens.length;
      tokens = tokens.filter(t => t.actor?.id !== actor?.id);
      const after = tokens.length;
      if (before !== after) {
        console.log(`${MODULE_ID} | Excluded caster ${actor?.name} from save targets (${before} → ${after})`);
      }
    }

    console.log(`${MODULE_ID} | Template resolved: spell="${item.name}", timing=`, timing, `isInstant=${timing?.isInstant}, tokens=${tokens.length}`);

    if (timing?.isInstant) {
      // ── Instant spell (Fireball, etc.) — post target card immediately ──
      // v0.6.1: empty-targets bail moved INSIDE this branch. For instant
      // spells, no targets = no card. For PERSISTENT spells (Moonbeam,
      // Spike Growth, etc.), an empty area at cast time is the NORMAL
      // case — they're cast on the ground waiting for tokens to enter.
      // The previous bail above this `if` was preventing
      // `persistentSpellCreated` from firing, so the concentration
      // widget never tracked persistent spells with empty initial areas.
      if (!tokens.length) {
        console.warn(`${MODULE_ID} | Instant ${item.name}: 0 tokens in area — skipping save card`);
        return;
      }
      console.log(`${MODULE_ID} | Posting instant save card for ${item.name} → ${tokens.length} targets`);
      await this._postLiveTargetCard(item, actor, tokens, {
        saveAbility, saveDC, halfOnSave, damageTypes, isSpell, timing, activityId, templateDoc,
      });
      console.log(`${MODULE_ID} | Instant save card posted successfully`);

    } else {
      // ── Persistent spell (Moonbeam, Spirit Guardians, etc.) ──
      // Emit hook for concentration widget — fires REGARDLESS of whether
      // any tokens are currently in the area. The widget needs to track
      // the spell so it can fire the entry-trigger save card later when
      // a token walks in.
      Hooks.callAll("ace-qol.persistentSpellCreated", {
        item, actor, templateDoc, timing, saveAbility, saveDC,
        halfOnSave, damageTypes, tokens,
      });

      console.log(`${MODULE_ID} | Persistent spell "${item.name}" — emitted ace-qol.persistentSpellCreated (${tokens.length} tokens initially in area)`);

      // If timing includes "enter" trigger, post initial save for tokens already in area.
      //
      // EXCEPTION: area-denial family (Stinking Cloud, Cloudkill, etc.) — these
      // are handled by the concentration widget, which auto-rolls entry saves
      // for initial-in-area tokens via _onPersistentSpellCreated. Posting the
      // manual TARGETED/SELECTED card here would be duplicate noise.
      const triggerOnEnter = timing.timing === TIMING.ENTER_START
                          || timing.timing === TIMING.ENTER_END;
      const isAreaDenial = timing?.family === "areaDenial";

      if (triggerOnEnter && tokens.length && !isAreaDenial) {
        await this._postLiveTargetCard(item, actor, tokens, {
          saveAbility, saveDC, halfOnSave, damageTypes, isSpell, timing, activityId,
          persistentInitial: true,
        });
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Detect "Half Damage on Save"
  // ═══════════════════════════════════════════════════════════════════════════

  _detectHalfDamage(item, activity) {
    // Check activity data first
    if (activity.damage?.onSave === "half") return true;

    // Check item description for common phrases
    const desc = (item.system?.description?.value ?? "").toLowerCase();
    if (desc.includes("half as much damage") || desc.includes("half damage")
     || desc.includes("takes half") || desc.includes("save for half")) {
      return true;
    }

    return false;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Live Target Card — NPC/PC split, remove buttons, roll trigger
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * v0.6.0 — Public-facing alias for `_postLiveTargetCard`. The leading
   * underscore on the original signals "internal use only," but the
   * persistent-template tracker (and any future external module) needs a
   * stable, non-underscore entry point. Both names resolve to the same
   * implementation; this alias is the recommended API for cross-module
   * callers.
   *
   * Same args/return as `_postLiveTargetCard`.
   */
  async postSaveCard(item, actor, tokens, opts) {
    return this._postLiveTargetCard(item, actor, tokens, opts);
  }

  async _postLiveTargetCard(item, actor, tokens, opts) {
    // v0.4.22.4: Pace the save card behind the spell/feat animation.
    // Without this delay the save card can land 1-2 seconds before the
    // visual effect, eating the dramatic beat. Configurable via
    // `saveCardDelayAfterCastMs` (default 1500ms; set 0 to disable).
    //
    // v0.6.2: `opts.skipDelay === true` bypasses the pacing entirely.
    // Used by entry-trigger saves (Moonbeam token-walked-in) where the
    // animation has already played; an additional 1.5s wait would feel
    // like the system stalled.
    if (!opts?.skipDelay) {
      try {
        const delay = Number(QolSettings.get?.("saveCardDelayAfterCastMs") ?? 1500);
        if (Number.isFinite(delay) && delay > 0) {
          await new Promise(r => setTimeout(r, delay));
        }
      } catch (_) { /* setting unavailable — proceed without delay */ }
    }

    const { saveAbility, saveDC, halfOnSave: rawHalfOnSave, damageTypes, isSpell, timing, activityId, spellLevel } = opts;
    const abilityLabel = CONFIG.DND5E?.abilities?.[saveAbility]?.label ?? saveAbility.toUpperCase();

    // ── Gate the HALF ON SAVE badge on actual damage presence ──
    // Some 2024 spell activities default `damage.onSave: "half"` even when
    // there are no damage parts (Hold Person, Charm Person, etc. were
    // showing a bogus "HALF ON SAVE" badge). The badge should only appear
    // when the spell ACTUALLY deals damage that gets halved.
    const hasDamage = Array.isArray(damageTypes) && damageTypes.length > 0
                   && damageTypes.some(t => t && t !== "none");
    const halfOnSave = rawHalfOnSave && hasDamage;

    // Assess all targets
    const targetData = [];
    for (const token of tokens) {
      const state = CombatState.assess(actor, token, item, {
        saveAbility, isSpell, damageTypes,
      });
      if (!state) continue;

      const isPC = token.actor?.hasPlayerOwner ?? false;
      const rawMod = token.actor?.system?.abilities?.[saveAbility]?.save;
      const saveMod = typeof rawMod === "number" ? rawMod
                    : typeof rawMod === "object" ? (rawMod?.value ?? rawMod?.total ?? 0)
                    : Number(rawMod) || 0;

      // Sum numeric save bonuses (Aura of Protection, ability-specific bonus,
      // cover) into the displayed mod. Non-numeric bonuses (Bless's "+1d4")
      // stay in saveBonuses for the roll formula but don't fold into the
      // shown number — they get rendered as separate badges if the card
      // chooses to display them.
      const numericBonusTotal = (state.saveBonuses ?? []).reduce((sum, b) => {
        const raw = String(b?.value ?? "").replace(/^\+/, "").trim();
        const n = Number(raw);
        return Number.isFinite(n) ? sum + n : sum;
      }, 0);
      const effectiveMod = saveMod + numericBonusTotal;
      const modStr = effectiveMod >= 0 ? `+${effectiveMod}` : `${effectiveMod}`;

      targetData.push({
        tokenId: token.id,
        tokenDocId: token.document?.id ?? token.id,
        actorId: token.actor?.id,
        sceneId: canvas.scene?.id,
        name: state.target.name,
        img: state.target.img,
        isPC,
        saveMod: modStr,
        saveModBase: saveMod,
        saveModBonus: numericBonusTotal,
        saveAbilityUpper: saveAbility.toUpperCase(),
        autoFailSave: state.autoFailSave,
        saveAdvantage: state.saveAdvantage,
        saveDisadvantage: state.saveDisadvantage,
        superSaver: state.superSaver,
        semiSuperSaver: state.semiSuperSaver,
        saveBonuses: state.saveBonuses,
        damageModifiers: state.damageModifiers,
        currentHP: state.target.currentHP,
        maxHP: state.target.maxHP,
        // For owners — which players own this PC
        ownerIds: isPC ? Object.entries(token.actor?.ownership ?? {})
          .filter(([id, level]) => level >= 3 && id !== "default" && !game.users.get(id)?.isGM)
          .map(([id]) => id) : [],
      });
    }

    if (!targetData.length) return;

    // ── Split into NPCs and PCs ──
    const npcs = targetData.filter(t => !t.isPC);
    const pcs = targetData.filter(t => t.isPC);

    // ── Helper: determine worst damage modifier for color-coding ──
    const _getDmgIndicator = (t) => {
      if (!t.damageModifiers || !damageTypes?.length) return { cls: "", tag: "" };
      // Check each spell damage type against this target's modifiers
      let hasImmune = false, hasResist = false, hasVuln = false;
      for (const dtype of damageTypes) {
        const mod = t.damageModifiers[dtype];
        if (mod?.modifier === "immune") hasImmune = true;
        else if (mod?.modifier === "resistant") hasResist = true;
        else if (mod?.modifier === "vulnerable") hasVuln = true;
      }
      // Immune takes priority, then resist, then vuln
      if (hasImmune) return { cls: "ace-qol-tgt-immune", tag: '<span class="ace-qol-tag ace-qol-tag-immune"><i class="fas fa-shield-halved"></i> IMMUNE</span>' };
      if (hasResist) return { cls: "ace-qol-tgt-resist", tag: '<span class="ace-qol-tag ace-qol-tag-resist"><i class="fas fa-shield-halved"></i> RESIST</span>' };
      if (hasVuln) return { cls: "ace-qol-tgt-vuln", tag: '<span class="ace-qol-tag ace-qol-tag-vuln"><i class="fas fa-burst"></i> VULN</span>' };
      return { cls: "", tag: "" };
    };

    // ── Helper: render save mod breakdown ──
    // Returns HTML showing base mod + each bonus as a chip with attribution.
    // Example: "DEX +0  [+3 Aura]  [+1d8 BI]"
    // Players see exactly which buffs are contributing — no hidden math.
    // Skips 0-value / empty / non-meaningful bonus entries so we don't show
    // useless chips like "0 DEX bonus".
    const _renderModBreakdown = (t) => {
      const baseStr = t.saveModBase >= 0 ? `+${t.saveModBase}` : `${t.saveModBase}`;
      const bonusChips = (t.saveBonuses ?? [])
        .filter(b => {
          const raw = String(b?.value ?? "").trim();
          if (!raw) return false;
          // Reject literal "+0" / "-0" / "0" — those add nothing
          const stripped = raw.replace(/^\+/, "").replace(/^0+(?=\d|$)/, "0");
          if (stripped === "0" || stripped === "-0" || stripped === "") return false;
          // Numeric? Skip if zero. Non-numeric (like "+1d4") always rendered.
          const n = Number(stripped);
          if (Number.isFinite(n) && n === 0) return false;
          return true;
        })
        .map(b => {
          const v = String(b?.value ?? "").trim();
          const vDisplay = v.startsWith("+") || v.startsWith("-") ? v : `+${v}`;
          const label = String(b?.label ?? "Bonus").trim();
          const shortLabel = label
            .replace(/^Aura of Protection$/i, "Aura")
            .replace(/^Aura of Warding$/i, "Warding")
            .replace(/^Bardic Inspiration$/i, "BI")
            .replace(/^Resistance$/i, "Resist")
            .replace(/^Heroes' Feast$/i, "Feast");
          return `<span class="ace-qol-save-bonus-chip" title="${label}">${vDisplay} ${shortLabel}</span>`;
        }).join("");
      return `<span class="ace-qol-save-tgt-mod">${t.saveAbilityUpper} ${baseStr}</span>${bonusChips}`;
    };

    // ── Build NPC rows ──
    const npcRowsHtml = npcs.map(t => {
      const di = _getDmgIndicator(t);
      return `
      <div class="ace-qol-save-tgt-row ${di.cls}" data-token-id="${t.tokenId}">
        <img src="${t.img || "icons/svg/mystery-man.svg"}" class="ace-qol-save-tgt-img" />
        <span class="ace-qol-save-tgt-name">${t.name}</span>
        ${_renderModBreakdown(t)}
        ${t.autoFailSave ? '<span class="ace-qol-tag ace-qol-tag-danger"><i class="fas fa-circle-xmark"></i> AUTO-FAIL</span>' : ""}
        ${t.superSaver ? '<span class="ace-qol-tag ace-qol-tag-buff"><i class="fas fa-person-running"></i> EVASION</span>' : ""}
        ${di.tag}
        <button class="ace-qol-save-tgt-remove" data-action="aceQolRemoveTarget" data-token-id="${t.tokenId}">
          <i class="fas fa-xmark"></i>
        </button>
      </div>
    `}).join("");

    // ── Build PC rows (with GM dice icon to roll on their behalf + X to remove) ──
    const pcRowsHtml = pcs.map(t => {
      const di = _getDmgIndicator(t);
      return `
      <div class="ace-qol-save-tgt-row ace-qol-save-tgt-pc ${di.cls}" data-token-id="${t.tokenId}" data-token-doc-id="${t.tokenDocId}" data-actor-id="${t.actorId}">
        <img src="${t.img || "icons/svg/mystery-man.svg"}" class="ace-qol-save-tgt-img" />
        <span class="ace-qol-save-tgt-name">${t.name}</span>
        ${_renderModBreakdown(t)}
        ${t.autoFailSave ? '<span class="ace-qol-tag ace-qol-tag-danger"><i class="fas fa-circle-xmark"></i> AUTO-FAIL</span>' : ""}
        ${t.superSaver ? '<span class="ace-qol-tag ace-qol-tag-buff"><i class="fas fa-person-running"></i> EVASION</span>' : ""}
        ${di.tag}
        <button class="ace-qol-save-pc-roll-btn" data-action="aceQolGmRollPcSave" data-token-doc-id="${t.tokenDocId}" title="Roll save on this PC's behalf (GM)">
          <img src="modules/ace-qol/Assets/Dice%20Dice/BD20/BD20-20_nobg.png" class="ace-qol-save-pc-dice-img" alt="d20" onerror="this.style.display='none';this.nextElementSibling.style.display='inline'" />
          <i class="fas fa-dice-d20" style="display:none"></i>
        </button>
        <button class="ace-qol-save-tgt-remove" data-action="aceQolRemoveTarget" data-token-id="${t.tokenId}" title="Remove this PC from the save list">
          <i class="fas fa-xmark"></i>
        </button>
      </div>
    `}).join("");

    // ── Assemble card ──
    const cardHtml = `
      <div class="ace-qol-save-card">
        <div class="ace-qol-save-header">
          <img src="${item.img || "icons/svg/spell.svg"}" class="ace-qol-save-item-img" />
          <div>
            <strong class="ace-qol-save-item-name">${item.name}</strong>
            <span class="ace-qol-save-dc">DC ${saveDC} ${abilityLabel} Save</span>
          </div>
          ${halfOnSave ? '<span class="ace-qol-save-half-badge">HALF ON SAVE</span>' : ""}
        </div>

        <div class="ace-qol-save-mode-toggle">
          <button class="ace-qol-save-mode-btn active" data-mode="targeted">TARGETED</button>
          <button class="ace-qol-save-mode-btn" data-mode="selected">SELECTED</button>
        </div>
        <div class="ace-qol-save-target-selected-row">
          <button class="ace-qol-save-target-selected-btn" data-action="aceQolTargetSelected" title="Add currently selected tokens to the target list (additive)">
            <i class="fas fa-crosshairs"></i> + TARGET SELECTED
          </button>
        </div>

        ${npcs.length ? `
          <div class="ace-qol-save-tgt-section">
            ${npcRowsHtml}
          </div>
        ` : ""}

        ${pcs.length ? `
          <div class="ace-qol-save-tgt-section ace-qol-save-tgt-section-pc">
            ${pcRowsHtml}
          </div>
        ` : ""}

        <div class="ace-qol-save-actions">
          <button class="ace-qol-btn ace-qol-btn-roll" data-action="aceQolRollNpcSaves">
            <i class="fas fa-dice-d20"></i> ${
              npcs.length > 0 && pcs.length > 0 ? "ROLL NPC SAVES + PROMPT PCs" :
              npcs.length > 0                    ? "ROLL NPC SAVES" :
                                                   "PROMPT PCs TO ROLL"
            }
          </button>
        </div>
      </div>
    `;

    const targetListMsg = await ChatMessage.create({
      content: cardHtml,
      speaker: ChatMessage.getSpeaker({ actor }),
      whisper: [game.user.id],
      flags: {
        [MODULE_ID]: {
          type: "saveTargetList",
          itemId: item.id,
          itemUuid: item.uuid,
          actorId: actor.id,
          saveAbility,
          saveDC,
          halfOnSave,
          damageTypes,
          isSpell,
          activityId,
          spellLevel: Number.isFinite(spellLevel) ? spellLevel : null,
          timingType: timing?.timing ?? TIMING.INSTANT,
          targets: targetData,
          persistentInitial: opts.persistentInitial ?? false,
          templateDocId:   opts.templateDoc?.id ?? null,
          templateSceneId: opts.templateDoc?.parent?.id ?? null,
        }
      }
    });

    // Use target list message ID as unique cast identifier
    const castId = targetListMsg.id;

    // ── Send PC save prompts immediately (same time as target list card) ──
    for (const tgt of pcs) {
      await this._sendPcSavePrompt(item, actor, tgt, {
        saveAbility, saveDC, halfOnSave, damageTypes, isSpell, castId,
      });
    }

    // ── Auto-delete the AOE template ──
    // Originally fired only on ROLL SAVES click — but if the GM let PCs
    // roll via individual dice icons OR the cast just sat there, the
    // template lingered indefinitely. Now fires after a 1.5s delay (gives
    // Sequencer/AA spell animations time to play through) right after
    // the target list lands. Persistent spells (Moonbeam, Spirit Guardians,
    // etc.) bail inside _deleteInstantTemplate via the timingType check.
    if (timing?.isInstant && opts.templateDoc) {
      const flagsForDelete = {
        timingType: TIMING.INSTANT,
        templateDocId: opts.templateDoc.id,
        templateSceneId: opts.templateDoc.parent?.id,
      };
      setTimeout(() => {
        this._deleteInstantTemplate(flagsForDelete).catch(err =>
          console.warn(`${MODULE_ID} | post-target-list template delete threw:`, err)
        );
      }, 1500);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Legacy Save Prompt Card (kept for backward compat)
  // ═══════════════════════════════════════════════════════════════════════════

  async _postSaveCard(item, actor, targetStates, opts) {
    const { saveAbility, saveDC, halfOnSave: rawHalfOnSave, damageTypes, isSpell } = opts;
    const abilityLabel = CONFIG.DND5E?.abilities?.[saveAbility]?.label ?? saveAbility.toUpperCase();
    // Same hasDamage gate as _postLiveTargetCard — suppresses bogus
    // "HALF ON SAVE" badge on save-only-condition spells (Hold Person etc.)
    const hasDamage = Array.isArray(damageTypes) && damageTypes.length > 0
                   && damageTypes.some(t => t && t !== "none");
    const halfOnSave = rawHalfOnSave && hasDamage;

    const targetRows = targetStates.map(ts => {
      const tags = [];

      // Auto-fail
      if (ts.autoFailSave) {
        tags.push({ label: "AUTO-FAIL", type: "danger", icon: "fa-circle-xmark" });
      }

      // Save advantage/disadvantage
      for (const reason of (ts.saveAdvReasons ?? [])) {
        tags.push({ label: reason, type: "buff", icon: "fa-arrow-up" });
      }
      for (const reason of (ts.saveDisadvReasons ?? [])) {
        tags.push({ label: reason, type: "debuff", icon: "fa-arrow-down" });
      }

      // Evasion
      if (ts.superSaver) {
        tags.push({ label: "EVASION \u2192 pass = 0 dmg", type: "buff", icon: "fa-person-running" });
      }

      // Legendary resistance
      if (ts.target.legendaryResistance > 0) {
        tags.push({ label: `LEG RESIST: ${ts.target.legendaryResistance}/${ts.target.legendaryResistanceMax}`, type: "legendary", icon: "fa-crown" });
      }

      // Save bonuses
      for (const bonus of (ts.saveBonuses ?? [])) {
        tags.push({ label: `+${bonus.value} (${bonus.label})`, type: "buff", icon: "fa-plus" });
      }

      // Damage modifiers
      for (const [type, mod] of Object.entries(ts.damageModifiers ?? {})) {
        if (mod.modifier === "immune") tags.push({ label: `IMMUNE: ${type}`, type: "immune", icon: "fa-shield" });
        if (mod.modifier === "resistant") tags.push({ label: `RESIST: ${type}`, type: "resistant", icon: "fa-shield-halved" });
        if (mod.modifier === "vulnerable") tags.push({ label: `VULN: ${type}`, type: "vulnerable", icon: "fa-heart-crack" });
      }

      const tagHtml = tags.map(t =>
        `<span class="ace-qol-tag ace-qol-tag-${t.type}"><i class="fas ${t.icon}"></i> ${t.label}</span>`
      ).join("");

      return `
        <div class="ace-qol-save-target">
          <div class="ace-qol-save-target-header">
            <img src="${ts.target.img || "icons/svg/mystery-man.svg"}" class="ace-qol-save-target-img" />
            <span class="ace-qol-save-target-name">${ts.target.name}</span>
            <span class="ace-qol-save-target-mod">
              ${saveAbility.toUpperCase()} save: +${(() => { const r = ts.targetActor.system?.abilities?.[saveAbility]?.save; return typeof r === "number" ? r : r?.value ?? r?.total ?? 0; })()}
            </span>
          </div>
          ${tagHtml ? `<div class="ace-qol-atk-tags">${tagHtml}</div>` : ""}
        </div>
      `;
    }).join("");

    const cardHtml = `
      <div class="ace-qol-save-card">
        <div class="ace-qol-save-header">
          <img src="${item.img || "icons/svg/spell.svg"}" class="ace-qol-save-item-img" />
          <div>
            <strong class="ace-qol-save-item-name">${item.name}</strong>
            <span class="ace-qol-save-dc">DC ${saveDC} ${abilityLabel} Save</span>
          </div>
          ${halfOnSave ? '<span class="ace-qol-save-half-badge">HALF ON SAVE</span>' : ""}
        </div>
        <div class="ace-qol-save-targets">
          ${targetRows}
        </div>
        <div class="ace-qol-save-actions">
          <button class="ace-qol-btn ace-qol-btn-roll" data-action="aceQolRollSaves">
            <i class="fas fa-dice-d20"></i> ROLL ALL SAVES
          </button>
        </div>
      </div>
    `;

    await ChatMessage.create({
      content: cardHtml,
      speaker: ChatMessage.getSpeaker({ actor }),
      whisper: [game.user.id],
      flags: {
        [MODULE_ID]: {
          type: "savePrompt",
          itemId: item.id,
          itemUuid: item.uuid,
          actorId: actor.id,
          saveAbility,
          saveDC,
          halfOnSave,
          damageTypes,
          isSpell,
          activityId: opts.activityId,
          targets: targetStates.map(ts => ({
            tokenId: ts.targetToken.id,
            tokenDocId: ts.targetToken.document?.id ?? ts.targetToken.id,
            actorId: ts.targetActor.id,
            sceneId: canvas.scene?.id,
            name: ts.target.name,
            img: ts.target.img,
            autoFailSave: ts.autoFailSave,
            saveAdvantage: ts.saveAdvantage,
            saveDisadvantage: ts.saveDisadvantage,
            superSaver: ts.superSaver,
            semiSuperSaver: ts.semiSuperSaver,
            saveBonuses: ts.saveBonuses,
            damageModifiers: ts.damageModifiers,
            currentHP: ts.target.currentHP,
            maxHP: ts.target.maxHP,
          })),
        }
      }
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Button Wiring — Save Prompt (legacy)
  // ═══════════════════════════════════════════════════════════════════════════

  _wireSavePromptButtons(el, message, flags) {
    const rollBtn = el.querySelector?.("[data-action='aceQolRollSaves']");

    if (rollBtn && !rollBtn.dataset.wired) {
      rollBtn.dataset.wired = "1";
      if (flags.rolled) {
        rollBtn.disabled = true;
        rollBtn.innerHTML = '<i class="fas fa-check"></i> ROLLED \u2713';
      } else {
        rollBtn.addEventListener("click", async () => {
          rollBtn.disabled = true;
          rollBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Rolling...';
          await this._rollAllSaves(message);
          rollBtn.innerHTML = '<i class="fas fa-check"></i> ROLLED \u2713';
          await message.setFlag(MODULE_ID, "rolled", true);
        });
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Button Wiring — Live Target List Card
  // ═══════════════════════════════════════════════════════════════════════════

  _wireTargetListButtons(el, message, flags) {
    // ── TARGETED / SELECTED toggle ──
    const modeBtns = el.querySelectorAll?.(".ace-qol-save-mode-btn");
    if (modeBtns?.length) {
      for (const btn of modeBtns) {
        if (btn.dataset.wired) continue;
        btn.dataset.wired = "1";
        btn.addEventListener("click", () => {
          for (const b of modeBtns) b.classList.remove("active");
          btn.classList.add("active");
          // Toggle between targeted tokens and selected tokens
          const mode = btn.dataset.mode;
          if (mode === "selected") {
            // Re-populate from canvas.tokens.controlled
            this._refreshTargetListFromSelection(message, el);
          }
          // "targeted" mode keeps the original list
        });
      }
    }

    // ── Click portrait/name on target list → select + pan ──
    const tgtImgs = el.querySelectorAll?.(".ace-qol-save-tgt-row .ace-qol-save-tgt-img, .ace-qol-save-tgt-row .ace-qol-save-tgt-name");
    if (tgtImgs?.length) {
      for (const elem of tgtImgs) {
        const row = elem.closest(".ace-qol-save-tgt-row");
        const tokenId = row?.dataset?.tokenId;
        if (!tokenId) continue;
        elem.style.cursor = "pointer";
        elem.addEventListener("click", () => {
          const scene = canvas.scene;
          if (!scene) return;
          const tokenDoc = scene.tokens.get(tokenId);
          const token = tokenDoc?.object;
          if (!token) return;
          token.control({ releaseOthers: true });
          canvas.animatePan({ x: token.center.x, y: token.center.y, duration: 250 });
        });
      }
    }

    // ── Remove (x) buttons ──
    const removeBtns = el.querySelectorAll?.("[data-action='aceQolRemoveTarget']");
    if (removeBtns?.length) {
      for (const btn of removeBtns) {
        if (btn.dataset.wired) continue;
        btn.dataset.wired = "1";
        btn.addEventListener("click", async () => {
          const tokenId = btn.dataset.tokenId;
          if (!tokenId) return;

          // Remove the row visually
          const row = el.querySelector?.(`.ace-qol-save-tgt-row[data-token-id="${tokenId}"]`);
          if (row) row.remove();

          // Update the message flags
          const currentTargets = message.flags?.[MODULE_ID]?.targets ?? [];
          const updated = currentTargets.filter(t => t.tokenId !== tokenId);
          await message.setFlag(MODULE_ID, "targets", updated);

          // Update section counts
          this._updateSectionCounts(el, updated);
        });
      }
    }

    // ── PC dice buttons (GM rolls for PC on main card) ──
    const pcRollBtns = el.querySelectorAll?.("[data-action='aceQolGmRollPcSave']");
    if (pcRollBtns?.length) {
      // Check for existing PC results to gray out already-rolled PCs (same cast only)
      const thisCastId = message.id;
      const recentMsgs = game.messages.contents.slice(-30);
      const rolledPcs = new Set();
      for (const m of recentMsgs) {
        const f = m.flags?.[MODULE_ID];
        if (f?.type === "pcSaveResult" && f.tokenDocId && f.castId === thisCastId) rolledPcs.add(f.tokenDocId);
      }

      for (const btn of pcRollBtns) {
        if (btn.dataset.wired) continue;
        btn.dataset.wired = "1";

        // If this PC already rolled, show result and disable
        const tokenDocId = btn.dataset.tokenDocId;
        if (rolledPcs.has(tokenDocId)) {
          const existingResult = recentMsgs.find(m => m.flags?.[MODULE_ID]?.type === "pcSaveResult" && m.flags[MODULE_ID].tokenDocId === tokenDocId && m.flags[MODULE_ID].castId === thisCastId);
          if (existingResult) {
            const f = existingResult.flags[MODULE_ID];
            const passClass = f.passed ? "ace-qol-save-pass" : "ace-qol-save-fail";
            const verdictText = f.passed ? "PASS" : "FAIL";
            btn.disabled = true;
            btn.innerHTML = `<span class="ace-qol-save-verdict ${passClass}" style="font-size:0.65rem">${verdictText}</span>`;
            btn.style.background = "none"; btn.style.border = "none"; btn.style.padding = "0 4px";
            // Also update the mod display
            const row = btn.closest(".ace-qol-save-tgt-row");
            const modSpan = row?.querySelector(".ace-qol-save-tgt-mod");
            if (modSpan) modSpan.innerHTML = `<span class="${passClass}" style="font-weight:700">${f.autoFailSave ? "AUTO" : f.saveTotal}</span>`;
            continue;
          }
        }

        btn.addEventListener("click", async () => {
          const tokenDocId = btn.dataset.tokenDocId;
          if (!tokenDocId) return;

          // Check if this PC already rolled (race condition guard)
          const alreadyRolled = game.messages.contents.slice(-30).some(m => {
            const f = m.flags?.[MODULE_ID];
            return f?.type === "pcSaveResult" && f.tokenDocId === tokenDocId && f.castId === message.id;
          });
          if (alreadyRolled) {
            ui.notifications.warn("This PC has already rolled their save.");
            btn.disabled = true;
            return;
          }

          // Find the PC target data from flags
          const targets = message.flags?.[MODULE_ID]?.targets ?? [];
          const tgt = targets.find(t => t.tokenDocId === tokenDocId);
          if (!tgt) return;

          btn.disabled = true;
          btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';

          // Build a fake pcSavePrompt message and roll it
          const flags = message.flags?.[MODULE_ID];
          const fakeMsg = { flags: { [MODULE_ID]: {
            type: "pcSavePrompt",
            saveAbility: flags.saveAbility,
            saveDC: flags.saveDC,
            halfOnSave: flags.halfOnSave,
            damageTypes: flags.damageTypes,
            isSpell: flags.isSpell,
            tokenDocId: tgt.tokenDocId,
            actorId: tgt.actorId,
            sceneId: tgt.sceneId,
            targetName: tgt.name,
            targetImg: tgt.img,
            autoFailSave: tgt.autoFailSave,
            saveAdvantage: tgt.saveAdvantage,
            saveDisadvantage: tgt.saveDisadvantage,
            superSaver: tgt.superSaver,
            semiSuperSaver: tgt.semiSuperSaver,
            saveBonuses: tgt.saveBonuses,
            damageModifiers: tgt.damageModifiers,
            currentHP: tgt.currentHP,
            maxHP: tgt.maxHP,
            castId: message.id,
          }}};

          await this._rollPcSave(fakeMsg);
          btn.innerHTML = '<i class="fas fa-check"></i>';
        });
      }
    }

    // ── + TARGET SELECTED button (additive: adds canvas-selected tokens) ──
    const targetSelBtn = el.querySelector?.("[data-action='aceQolTargetSelected']");
    if (targetSelBtn && !targetSelBtn.dataset.wired) {
      targetSelBtn.dataset.wired = "1";
      targetSelBtn.addEventListener("click", async () => {
        const selected = canvas.tokens?.controlled ?? [];
        if (!selected.length) {
          ui.notifications.warn("ACE QOL: No tokens selected on the canvas.");
          return;
        }
        const existingIds = new Set((flags.targets ?? []).map(t => t.tokenDocId));
        const newTokens = selected.filter(t => !existingIds.has(t.document?.id ?? t.id));
        if (!newTokens.length) {
          ui.notifications.info("ACE QOL: All selected tokens are already in the target list.");
          return;
        }
        // Additive: target each new token, keep existing user targets
        for (const tok of newTokens) {
          tok.setTarget(true, { user: game.user, releaseOthers: false });
        }
        await this._addTargetsToCard(message, newTokens);
      });
    }

    // ── ROLL NPC SAVES button ──
    const rollNpcBtn = el.querySelector?.("[data-action='aceQolRollNpcSaves']");
    if (rollNpcBtn && !rollNpcBtn.dataset.wired) {
      rollNpcBtn.dataset.wired = "1";
      if (flags.rolled) {
        rollNpcBtn.disabled = true;
        rollNpcBtn.innerHTML = '<i class="fas fa-check"></i> ROLLED \u2713';
      } else {
        rollNpcBtn.addEventListener("click", async () => {
          rollNpcBtn.disabled = true;
          rollNpcBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Rolling NPC saves...';

          await this._rollNpcSavesFromTargetList(message);

          rollNpcBtn.innerHTML = '<i class="fas fa-check"></i> ROLLED \u2713';
          await message.setFlag(MODULE_ID, "rolled", true);
        });
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Button Wiring — PC Save Prompt (whispered to player)
  // ═══════════════════════════════════════════════════════════════════════════

  _wirePcSaveButton(el, message, flags) {
    // If already rolled, collapse the entire prompt card
    if (flags.rolled) {
      const chatMsg = el.closest?.(".chat-message") ?? el;
      chatMsg.classList.add("ace-qol-save-collapsed");
      return; // No need to wire anything
    }

    const rollBtn = el.querySelector?.("[data-action='aceQolRollPcSave']");
    if (!rollBtn || rollBtn.dataset.wired) return;
    rollBtn.dataset.wired = "1";

    rollBtn.addEventListener("click", async () => {
      rollBtn.disabled = true;
      rollBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Rolling...';

      await this._rollPcSave(message);

      // Collapse on this client immediately (DOM only — no flag write needed)
      rollBtn.innerHTML = '<i class="fas fa-check"></i> ROLLED \u2713';
      const chatMsg = el.closest?.(".chat-message") ?? el;
      chatMsg.classList.add("ace-qol-save-collapsed");
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Auto-Collapse Target List Card
  // ═══════════════════════════════════════════════════════════════════════════

  _collapseTargetListCard(resultsFlags) {
    // Find the target list card that spawned this results card and collapse it
    const chatLog = document.querySelector("#chat-log, .chat-log");
    if (!chatLog) return;
    const targetCards = chatLog.querySelectorAll(".ace-qol-save-card");
    for (const card of targetCards) {
      // Collapse the entire chat message containing this card
      const msg = card.closest(".chat-message");
      if (msg) msg.classList.add("ace-qol-save-collapsed");
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Button Wiring — Phase 1 (ROLL DAMAGE + portrait click-to-pan)
  // ═══════════════════════════════════════════════════════════════════════════

  _wireRollDamageButton(el, message, flags) {
    // ── Click portrait/name → select + pan to token ──
    const rows = el.querySelectorAll?.(".ace-qol-save-result-row");
    if (rows?.length) {
      for (const row of rows) {
        const img = row.querySelector(".ace-qol-save-tgt-img");
        const name = row.querySelector(".ace-qol-save-tgt-name");
        const tokenDocId = row.dataset.tokenDocId;
        const clickHandler = () => {
          if (!tokenDocId) return;
          const scene = canvas.scene;
          if (!scene) return;
          const tokenDoc = scene.tokens.get(tokenDocId);
          const token = tokenDoc?.object;
          if (!token) return;
          token.control({ releaseOthers: true });
          canvas.animatePan({ x: token.center.x, y: token.center.y, duration: 250 });
        };
        if (img) { img.style.cursor = "pointer"; img.addEventListener("click", clickHandler); }
        if (name) { name.style.cursor = "pointer"; name.addEventListener("click", clickHandler); }
      }
    }

    // ── × Remove buttons (Phase 1 — strip target from allResults before damage) ──
    const phase1RemoveBtns = el.querySelectorAll?.("[data-action='aceQolRemovePhase1']");
    if (phase1RemoveBtns?.length) {
      for (const btn of phase1RemoveBtns) {
        if (btn.dataset.wired) continue;
        btn.dataset.wired = "1";
        btn.addEventListener("click", async (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          const tokenDocId = btn.dataset.tokenDocId;
          if (!tokenDocId) return;
          const allResults = (message.flags?.[MODULE_ID]?.allResults ?? []).filter(r => r.tokenDocId !== tokenDocId);
          await message.update({
            [`flags.${MODULE_ID}.allResults`]: allResults,
          }, { render: false });
          // Remove the row from DOM and rebuild the card content for persistence
          const row = btn.closest(".ace-qol-save-result-row");
          if (row) row.remove();
          // Rebuild content so subsequent renders/updates stay correct
          try {
            const item = await fromUuid(message.flags?.[MODULE_ID]?.itemUuid)
                      ?? game.items.get(message.flags?.[MODULE_ID]?.itemId);
            if (item) {
              const cardHtml = this._buildPhase1CardHtml(item, allResults, {
                saveAbility: message.flags?.[MODULE_ID]?.saveAbility,
                saveDC:      message.flags?.[MODULE_ID]?.saveDC,
              });
              await message.update({ content: cardHtml }, { render: false });
            }
          } catch (err) {
            console.warn(`${MODULE_ID} | Phase 1 X-remove rebuild failed:`, err);
          }
        });
      }
    }

    // ── ROLL DAMAGE button ──
    const rollDmgBtn = el.querySelector?.("[data-action='aceQolRollDamage']");
    if (rollDmgBtn && !rollDmgBtn.dataset.wired) {
      rollDmgBtn.dataset.wired = "1";
      rollDmgBtn.addEventListener("click", async () => {
        rollDmgBtn.disabled = true;
        rollDmgBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Rolling damage...';
        await this._completeSaveResultsPhase2(message);
      });
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Button Wiring — Phase 2 / Legacy (override + Apply/Undo)
  // ═══════════════════════════════════════════════════════════════════════════

  _wireSaveResultButtons(el, message, flags) {
    // ── Click portrait/name → select + pan to token ──
    const rows = el.querySelectorAll?.(".ace-qol-save-result-row");
    if (rows?.length) {
      for (const row of rows) {
        const img = row.querySelector(".ace-qol-save-tgt-img");
        const name = row.querySelector(".ace-qol-save-tgt-name");
        const tokenDocId = row.dataset.tokenDocId;
        const clickHandler = () => {
          if (!tokenDocId) return;
          const scene = canvas.scene;
          if (!scene) return;
          const tokenDoc = scene.tokens.get(tokenDocId);
          const token = tokenDoc?.object;
          if (!token) return;
          // Select the token
          token.control({ releaseOthers: true });
          // Pan camera to it
          canvas.animatePan({ x: token.center.x, y: token.center.y, duration: 250 });
        };
        if (img) { img.style.cursor = "pointer"; img.addEventListener("click", clickHandler); }
        if (name) { name.style.cursor = "pointer"; name.addEventListener("click", clickHandler); }
      }
    }

    // ── Manual damage override buttons (0, ¼, ½, 1, 2) ──
    const overrideBtns = el.querySelectorAll?.("[data-action='aceQolDmgOverride']");
    if (overrideBtns?.length) {
      for (const btn of overrideBtns) {
        if (btn.dataset.wired) continue;
        btn.dataset.wired = "1";
        btn.addEventListener("click", () => {
          const tokenDocId = btn.dataset.tokenDocId;
          const multiplier = parseFloat(btn.dataset.multiplier);
          if (!tokenDocId || isNaN(multiplier)) return;

          // Toggle active class — scoped to this row only
          const ovrLine = btn.closest(".ace-qol-save-ovr-line");
          if (ovrLine) {
            ovrLine.querySelectorAll(".ace-qol-save-ovr").forEach(b => b.classList.remove("ace-qol-save-ovr-active"));
            btn.classList.add("ace-qol-save-ovr-active");
          }

          // Store in memory cache (NO flag persist, NO re-render)
          const cacheKey = `${message.id}|${tokenDocId}`;
          SaveEngine.overrideCache.set(cacheKey, multiplier);

          // Update DOM instantly — scoped to this button's row
          const row = btn.closest(".ace-qol-save-result-row");
          if (row) this._updateRowDamageDisplay(row, tokenDocId, multiplier, flags);
        });
      }
    }

    // ── × Remove buttons — hide row and exclude from APPLY ──
    const removeBtns = el.querySelectorAll?.("[data-action='aceQolRemoveResult']");
    if (removeBtns?.length) {
      for (const btn of removeBtns) {
        if (btn.dataset.wired) continue;
        btn.dataset.wired = "1";
        btn.addEventListener("click", () => {
          const tokenDocId = btn.dataset.tokenDocId;
          const row = btn.closest(".ace-qol-save-result-row");
          if (row) {
            row.style.display = "none";
            row.dataset.removed = "1";
          }
          // Mark as removed in cache so APPLY ALL skips it
          const cacheKey = `${message.id}|${tokenDocId}`;
          SaveEngine.overrideCache.set(cacheKey, "removed");
        });
      }
    }

    // ── Apply All / Undo All ──
    const applyBtn = el.querySelector?.("[data-action='aceQolApplyDamage']");
    const undoBtn = el.querySelector?.("[data-action='aceQolUndoDamage']");

    if (applyBtn && !applyBtn.dataset.wired) {
      applyBtn.dataset.wired = "1";
      if (flags.applied) {
        applyBtn.disabled = true;
        applyBtn.textContent = "APPLIED \u2713";
        // Enable undo since damage was already applied
        if (undoBtn && !flags.undone) undoBtn.disabled = false;
      } else {
        applyBtn.addEventListener("click", async () => {
          await this._applyAllSaveDamage(message);
          applyBtn.disabled = true;
          applyBtn.textContent = "APPLIED \u2713";
          await message.setFlag(MODULE_ID, "applied", true);
          // Enable UNDO now that damage has been applied
          if (undoBtn) { undoBtn.disabled = false; }
        });
      }
    }

    if (undoBtn && !undoBtn.dataset.wired) {
      undoBtn.dataset.wired = "1";
      if (flags.undone) {
        undoBtn.disabled = true;
        undoBtn.textContent = "UNDONE \u2713";
      } else if (!flags.applied) {
        // Not applied yet — keep disabled (set in HTML)
      } else {
        // Was applied but not yet undone — enable it
        undoBtn.disabled = false;
        undoBtn.addEventListener("click", async () => {
          await this._undoAllSaveDamage(message);
          undoBtn.disabled = true;
          undoBtn.textContent = "UNDONE \u2713";
          await message.setFlag(MODULE_ID, "undone", true);
        });
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Refresh Target List from Canvas Selection
  // ═══════════════════════════════════════════════════════════════════════════

  async _refreshTargetListFromSelection(message, el) {
    const flags = message.flags?.[MODULE_ID];
    if (!flags) return;

    const controlled = canvas.tokens.controlled;
    if (!controlled.length) {
      ui.notifications.warn("No tokens selected on the canvas.");
      return;
    }

    // Re-assess the selected tokens
    const item = await fromUuid(flags.itemUuid) ?? game.items.get(flags.itemId);
    const casterActor = game.actors.get(flags.actorId);
    if (!item || !casterActor) return;

    const newTargets = [];
    for (const token of controlled) {
      const state = CombatState.assess(casterActor, token, item, {
        saveAbility: flags.saveAbility,
        isSpell: flags.isSpell,
        damageTypes: flags.damageTypes,
      });
      if (!state) continue;

      const isPC = token.actor?.hasPlayerOwner ?? false;
      const rawSM = token.actor?.system?.abilities?.[flags.saveAbility]?.save;
      const saveMod = typeof rawSM === "number" ? rawSM : (rawSM?.value ?? rawSM?.total ?? (Number(rawSM) || 0));
      const numericBonusTotal2 = (state.saveBonuses ?? []).reduce((sum, b) => {
        const raw = String(b?.value ?? "").replace(/^\+/, "").trim();
        const n = Number(raw);
        return Number.isFinite(n) ? sum + n : sum;
      }, 0);
      const effectiveMod2 = saveMod + numericBonusTotal2;
      const modStr = effectiveMod2 >= 0 ? `+${effectiveMod2}` : `${effectiveMod2}`;

      newTargets.push({
        tokenId: token.id,
        tokenDocId: token.document?.id ?? token.id,
        actorId: token.actor?.id,
        sceneId: canvas.scene?.id,
        name: state.target.name,
        img: state.target.img,
        isPC,
        saveMod: modStr,
        saveModBase: saveMod,
        saveModBonus: numericBonusTotal2,
        saveAbilityUpper: flags.saveAbility.toUpperCase(),
        autoFailSave: state.autoFailSave,
        saveAdvantage: state.saveAdvantage,
        saveDisadvantage: state.saveDisadvantage,
        superSaver: state.superSaver,
        semiSuperSaver: state.semiSuperSaver,
        saveBonuses: state.saveBonuses,
        damageModifiers: state.damageModifiers,
        currentHP: state.target.currentHP,
        maxHP: state.target.maxHP,
        ownerIds: isPC ? Object.entries(token.actor?.ownership ?? {})
          .filter(([id, level]) => level >= 3 && id !== "default" && !game.users.get(id)?.isGM)
          .map(([id]) => id) : [],
      });
    }

    // Update flags
    await message.setFlag(MODULE_ID, "targets", newTargets);

    // Re-render the message to reflect new targets
    ui.chat.updateMessage(message);
  }

  /**
   * Update the NPC/PC section header counts after removing a target.
   */
  _updateSectionCounts(el, targets) {
    const npcs = targets.filter(t => !t.isPC);
    const pcs = targets.filter(t => t.isPC);

    const labels = el.querySelectorAll?.(".ace-qol-save-tgt-section-label");
    if (labels?.[0] && npcs.length >= 0) labels[0].textContent = `NPCs (${npcs.length})`;
    if (labels?.[1] && pcs.length >= 0) labels[1].textContent = `PCs (${pcs.length})`;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Roll NPC Saves from Target List Card
  // ═══════════════════════════════════════════════════════════════════════════

  async _rollNpcSavesFromTargetList(message) {
    const flags = message.flags?.[MODULE_ID];
    if (!flags) return;

    const { saveAbility, saveDC, halfOnSave, targets, itemId, itemUuid, actorId, damageTypes, isSpell,
            timingType, templateDocId, templateSceneId } = flags;

    const item = await fromUuid(itemUuid) ?? game.items.get(itemId);
    const casterActor = game.actors.get(actorId);

    // ── Separate NPC and PC targets ──
    const npcTargets = targets.filter(t => !t.isPC);
    const pcTargets = targets.filter(t => t.isPC);

    // ── Roll NPC saves ──
    // isMulti tells _rollSingleSave to use the multi-target dice pacing
    // (default 250ms per save) instead of the single-target pacing
    // (default 1000ms). Without this, a 5-target Fireball would wait
    // 5 full seconds with the per-die delay summed.
    const isMulti = npcTargets.length > 1;
    const npcResults = [];
    for (const tgt of npcTargets) {
      const result = await this._rollSingleSave(tgt, saveAbility, saveDC, halfOnSave, actorId, { isMultiTarget: isMulti });
      npcResults.push(result);
    }

    // ── POST-SAVE REACTIONS (Legendary Resistance) ──
    // Check if any NPC that failed can use Legendary Resistance.
    const reactionEng = game.aceQol?.reactionEngine;
    if (reactionEng) {
      try {
        // Enrich results with actor references for the reaction engine
        const enriched = npcResults.map(r => ({
          ...r,
          actor: game.actors.get(r.actorId),
          ability: saveAbility,
          dc: saveDC,
          total: r.saveTotal,
          saved: r.passed,
        }));
        const modified = await reactionEng.checkPostSaveReactions(enriched);
        // Apply any changes (Legendary Resistance flips saved to true)
        for (let i = 0; i < modified.length; i++) {
          if (modified[i].legendaryResistance && modified[i].saved) {
            npcResults[i].passed = true;
            npcResults[i].legendaryResistance = true;
            npcResults[i].resultLabel = "LEGENDARY RESISTANCE";
            // Recalculate damage multiplier
            if (halfOnSave) npcResults[i].damageMultiplier = 0.5;
            else npcResults[i].damageMultiplier = 0;
          }
        }
      } catch (err) {
        console.error(`${MODULE_ID} | Post-save reaction check failed:`, err);
      }
    }

    // ── SILVERY BARBS — force reroll on successful NPC saves ──
    if (reactionEng) {
      try {
        for (let i = 0; i < npcResults.length; i++) {
          const r = npcResults[i];
          if (!r.passed) continue; // Only targets successful saves
          const targetActor = game.actors.get(r.actorId);
          const scene = game.scenes.get(r.sceneId) ?? canvas.scene;
          const targetTokenDoc = scene?.tokens?.get(r.tokenDocId);
          const targetToken = targetTokenDoc?.object;
          if (!targetActor || !targetToken) continue;

          const sbResult = await reactionEng.checkSilveryBarbs({
            actor: targetActor,
            token: targetToken,
            rollType: "save",
            total: r.saveTotal,
            dc: saveDC,
            description: `${targetActor.name}'s ${saveAbility.toUpperCase()} save`,
          });
          if (sbResult.rerolled && sbResult.newTotal !== undefined) {
            const newPassed = sbResult.newTotal >= saveDC;
            if (!newPassed) {
              npcResults[i].passed = false;
              npcResults[i].saveTotal = sbResult.newTotal;
              npcResults[i].silveryBarbsRerolled = true;
              npcResults[i].resultLabel = "SILVERY BARBS → FAILED";
              npcResults[i].damageMultiplier = 1;
            }
          }
        }
      } catch (err) {
        console.warn(`${MODULE_ID} | Silvery Barbs save check failed (non-blocking):`, err);
      }
    }

    // ── Emit saveComplete hooks for NPC saves (for duration tracker isSave expiry) ──
    for (const r of npcResults) {
      try {
        const scene = game.scenes.get(r.sceneId) ?? canvas.scene;
        const tokenDoc = scene?.tokens?.get(r.tokenDocId);
        const actor = tokenDoc?.actor ?? game.actors.get(r.actorId);
        if (actor) {
          Hooks.callAll(`${MODULE_ID}.saveComplete`, { actor, tokenDocId: r.tokenDocId, saveAbility, passed: r.passed });
        }
      } catch (_) { /* non-fatal */ }
    }

    // ── Build PC results — check if they already rolled (same cast only) ──
    const thisCastId = message.id; // target list message ID = cast ID
    const recentMsgs = game.messages.contents.slice(-30);
    const existingPcResults = new Map();
    for (const m of recentMsgs) {
      const f = m.flags?.[MODULE_ID];
      if (f?.type === "pcSaveResult" && f.tokenDocId && f.castId === thisCastId) {
        existingPcResults.set(f.tokenDocId, f);
      }
    }

    const pcResults = pcTargets.map(tgt => {
      const existing = existingPcResults.get(tgt.tokenDocId);
      if (existing) {
        // PC already rolled — build resolved result
        const passed = existing.passed;
        const superSaver = existing.superSaver;
        let damageMultiplier;
        if (passed) {
          if (superSaver) damageMultiplier = 0;
          else if (halfOnSave) damageMultiplier = 0.5;
          else damageMultiplier = 0;
        } else {
          if (superSaver) damageMultiplier = 0.5;
          else damageMultiplier = 1;
        }
        return {
          name: tgt.name, img: tgt.img,
          tokenDocId: tgt.tokenDocId, actorId: tgt.actorId, sceneId: tgt.sceneId,
          saveTotal: existing.saveTotal, passed,
          isAutoFail: existing.autoFailSave,
          resultLabel: existing.resultLabel,
          damageMultiplier,
          roll: null, damageModifiers: tgt.damageModifiers,
          currentHP: tgt.currentHP, maxHP: tgt.maxHP,
          isPC: true, pending: false,
        };
      }
      // PC hasn't rolled yet — pending placeholder
      return {
        name: tgt.name, img: tgt.img,
        tokenDocId: tgt.tokenDocId, actorId: tgt.actorId, sceneId: tgt.sceneId,
        saveTotal: null, passed: null,
        isAutoFail: tgt.autoFailSave,
        resultLabel: "\u23f3 Waiting for save...",
        damageMultiplier: null,
        roll: null, damageModifiers: tgt.damageModifiers,
        currentHP: tgt.currentHP, maxHP: tgt.maxHP,
        isPC: true, pending: true,
      };
    });

    // ── PC prompts already sent when target list card was posted ──

    // ── Detect whether this spell deals damage at all ──
    // Save-or-condition spells (Hold Person, Charm Person, Sleep, Bane,
    // Hypnotic Pattern, Tasha's, Suggestion, Slow, Dominate Person, etc.)
    // have NO damage parts. For those, skip the ROLL DAMAGE button + Phase 2
    // damage card entirely and apply conditions on the spot.
    const hasDamage = Array.isArray(damageTypes) && damageTypes.length > 0
                   && damageTypes.some(t => t && t !== "none");

    // ── Apply on-fail conditions immediately for save-only-condition spells ──
    // (Damage spells defer condition application until after the damage card
    // posts in _completeSaveResultsPhase2 → _runConditionApplicationFromPhase2,
    // so the GM can review damage before conditions apply. Pure-condition
    // spells skip that gate — there's nothing to review.)
    let appliedConditions = [];
    if (!hasDamage) {
      try {
        appliedConditions = await this._applyFailedSaveConditions(item, [...npcResults, ...pcResults], { saveAbility, saveDC, activityId, casterActor }) ?? [];
      } catch (err) {
        console.error(`${MODULE_ID} | Phase-1 condition application failed:`, err);
      }
    }

    // ── Drop wasted concentration ──
    // RAW: if no target ended up affected (everyone saved, all immune, etc.),
    // there's nothing to concentrate ON. The caster shouldn't be locked into
    // concentration on a no-effect Hold Person. Only drops when:
    //   - The spell required concentration
    //   - No condition was applied to anyone
    //   - All saves are resolved (no pending PCs)
    // If PCs are pending, we defer until their saves resolve (handled in
    // _handlePCSaveResult).
    const anyPending = [...npcResults, ...pcResults].some(r => r?.pending);
    if (!hasDamage && !anyPending && appliedConditions.length === 0) {
      try {
        await this._dropCasterConcentrationIfNoEffect(item, casterActor);
      } catch (err) {
        console.warn(`${MODULE_ID} | Wasted-concentration drop failed:`, err);
      }
    }

    // ── Post Phase 1 saves-only card (damage rolled separately) ──
    const allResults = [...npcResults, ...pcResults];
    await this._postSaveResultsPhase1(item, casterActor, allResults, {
      saveAbility, saveDC, halfOnSave, damageTypes, isSpell,
      timingType, templateDocId, templateSceneId,
      hasDamage,
      appliedConditions,
    });

    // ── Auto-delete the AOE template now that saves have rolled ──
    // Animation has had time to play (caster → travel → explosion).
    await this._deleteInstantTemplate({ timingType, templateDocId, templateSceneId });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Roll a Single NPC Save
  // ═══════════════════════════════════════════════════════════════════════════

  async _rollSingleSave(tgt, saveAbility, saveDC, halfOnSave, casterActorId = null, options = {}) {
    const scene = game.scenes.get(tgt.sceneId) ?? canvas.scene;
    const tokenDoc = scene?.tokens?.get(tgt.tokenDocId);
    const targetActor = tokenDoc?.actor ?? game.actors.get(tgt.actorId);

    let saveTotal = 0;
    let passed = false;
    let rollResult = null;
    let isAutoFail = tgt.autoFailSave;

    if (isAutoFail) {
      saveTotal = 0;
      passed = false;
    } else {
      // Determine advantage/disadvantage
      let rollMode = "normal";
      if (tgt.saveAdvantage && tgt.saveDisadvantage) rollMode = "normal";
      else if (tgt.saveAdvantage) rollMode = "advantage";
      else if (tgt.saveDisadvantage) rollMode = "disadvantage";

      // Build the roll formula
      // dnd5e 5.2.5: abilities.dex.save may be a number OR an object with .value
      const rawSaveMod = targetActor?.system?.abilities?.[saveAbility]?.save;
      const saveMod = typeof rawSaveMod === "number" ? rawSaveMod
                    : typeof rawSaveMod === "object" ? (rawSaveMod?.value ?? rawSaveMod?.total ?? 0)
                    : Number(rawSaveMod) || 0;
      const allBonusParts = (tgt.saveBonuses ?? []).map(b => b.value);

      // ── Cover DEX save bonus (half cover +2, three-quarters +5) ──
      if (saveAbility === "dex" && tokenDoc && casterActorId) {
        try {
          if (QolSettings.get("enableCoverCalculation")) {
            const casterTokenDoc = scene?.tokens?.find(t => t.actorId === casterActorId);
            if (casterTokenDoc) {
              const coverResult = CoverEngine.calculateCover(casterTokenDoc, tokenDoc);
              if (coverResult?.dexSaveBonus > 0) {
                allBonusParts.push(coverResult.dexSaveBonus);
              }
            }
          }
        } catch (_) { /* cover check non-fatal */ }
      }

      const bonuses = allBonusParts.join(" + ");
      const formula = rollMode === "advantage" ? `2d20kh + ${saveMod}${bonuses ? ` + ${bonuses}` : ""}`
                    : rollMode === "disadvantage" ? `2d20kl + ${saveMod}${bonuses ? ` + ${bonuses}` : ""}`
                    : `1d20 + ${saveMod}${bonuses ? ` + ${bonuses}` : ""}`;

      const roll = new Roll(formula);
      await roll.evaluate();

      // ── Visible Dice So Nice animation ──
      // Players want to SEE NPC saves roll across the screen, not just have
      // a number appear. DSN auto-fires for player-rolled saves via the
      // chat-message hook, but engine-rolled NPC saves bypass that. Fire
      // the animation here, then wait for the configurable pacing delay
      // before resolving the result.
      //
      // Pacing reads from QOL settings (Damage tab):
      //   • npcSaveAnimationDelay      — single-target  (default 1000ms)
      //   • npcSaveAnimationDelayMulti — per-save in batch (default 250ms)
      // The caller passes options.isMultiTarget=true when rolling a batch
      // (Mass Suggestion, Fireball, etc.) so multi-target casts don't
      // burn the full single-target delay per die.
      try {
        if (game.dice3d) {
          // Fire-and-forget: animation runs in background, we control wait
          // time via the setting (decoupled from DSN's own throw speed).
          game.dice3d.showForRoll(roll, game.user, true).catch(err =>
            console.warn(`${MODULE_ID} | DSN showForRoll rejected (non-fatal):`, err)
          );
        }
        const isMulti = !!options.isMultiTarget;
        let delay = isMulti
          ? (QolSettings.get("npcSaveAnimationDelayMulti") ?? 250)
          : (QolSettings.get("npcSaveAnimationDelay") ?? 1000);
        delay = Math.max(0, Math.min(5000, Number(delay) || 0));
        if (delay > 0) {
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      } catch (err) {
        console.warn(`${MODULE_ID} | DSN/pacing failed for save roll (non-fatal):`, err);
      }

      saveTotal = roll.total;
      passed = saveTotal >= saveDC;
      rollResult = roll;
    }

    // Determine damage multiplier
    let damageMultiplier = 1;
    let resultLabel = "FAIL";
    if (passed) {
      resultLabel = "PASS";
      if (tgt.superSaver) {
        damageMultiplier = 0; // Evasion: pass = 0 damage
        resultLabel = "PASS (EVASION)";
      } else if (halfOnSave) {
        damageMultiplier = 0.5;
        resultLabel = "PASS (HALF)";
      } else {
        damageMultiplier = 0;
        resultLabel = "PASS (NO DMG)";
      }
    } else {
      if (tgt.superSaver) {
        damageMultiplier = 0.5; // Evasion: fail = half damage
        resultLabel = "FAIL (EVASION: HALF)";
      } else {
        damageMultiplier = 1;
        resultLabel = isAutoFail ? "AUTO-FAIL" : "FAIL";
      }
    }

    return {
      name: tgt.name,
      img: tgt.img,
      tokenDocId: tgt.tokenDocId,
      actorId: tgt.actorId,
      sceneId: tgt.sceneId,
      saveTotal,
      passed,
      isAutoFail,
      resultLabel,
      damageMultiplier,
      roll: rollResult,
      damageModifiers: tgt.damageModifiers,
      currentHP: tgt.currentHP,
      maxHP: tgt.maxHP,
      isPC: false,
      pending: false,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Roll Spell Damage (once, shared across all targets)
  // ═══════════════════════════════════════════════════════════════════════════

  async _rollSpellDamage(item, casterActor, opts = {}) {
    const rollData = casterActor?.getRollData?.() ?? {};
    const damageComponents = [];
    const rollsToShow = []; // DSN animations to fire in parallel

    const sys = item?.system ?? {};
    const activities = sys.activities;
    if (activities) {
      const actList = (typeof activities.forEach === "function")
        ? [...(activities.values?.() ?? activities)]
        : (typeof activities === "object" ? Object.values(activities) : []);

      for (const activity of actList) {
        if (!activity?.damage?.parts?.length) continue;

        // ── PRIMARY PATH: dnd5e's native rollDamage ──
        // Handles cantrip scaling at L5/11/17 (character-level based) AND
        // spell upcast scaling (slot-level based) when caller passes
        // opts.spellLevel. Returns Array<DamageRoll> with proper @scale
        // resolution, magic damage tagging, versatile/two-handed handling.
        let nativeRolledOk = false;
        try {
          if (typeof activity.rollDamage === "function") {
            const rollConfig = {};
            // Thread spell upcast level if caller supplied it (Burning Hands
            // at L3 = 5d6 instead of 3d6, etc.). Falls through to base level
            // when undefined — cantrip scaling still works regardless.
            if (Number.isFinite(opts.spellLevel)) {
              rollConfig.spell = { level: Number(opts.spellLevel) };
            }
            const damageRolls = await activity.rollDamage(
              rollConfig,
              { configure: false },          // skip the modify-roll dialog
              { create: false, rollMode: CONST.DICE_ROLL_MODES?.PUBLIC ?? "publicroll" }
            );
            if (Array.isArray(damageRolls) && damageRolls.length > 0) {
              for (const roll of damageRolls) {
                const optTypes = roll.options?.types;
                const optType  = roll.options?.type;
                const type = optType
                          ?? (Array.isArray(optTypes) && optTypes.length > 0 ? optTypes[0] : "untyped");
                damageComponents.push({
                  name:    item.name,
                  formula: roll.formula,
                  total:   roll.total,
                  type,
                  roll,
                });
                rollsToShow.push(roll);
              }
              nativeRolledOk = true;
            }
          }
        } catch (err) {
          console.warn(`${MODULE_ID} | activity.rollDamage failed, falling back to manual roll:`, err);
        }

        // ── FALLBACK: manual formula construction ──
        // Used when activity.rollDamage isn't available (older dnd5e,
        // non-spell items, malformed activity). No cantrip/upcast scaling
        // here — purely the literal formula in part.number/denomination.
        if (!nativeRolledOk) {
          for (const part of activity.damage.parts) {
            const formula = part.custom?.enabled
              ? part.custom.formula
              : `${part.number ?? 1}d${part.denomination ?? 6}${part.bonus ? `+${part.bonus}` : ""}`;
            const types = part.types ? [...part.types] : ["untyped"];
            const type = types[0] ?? "untyped";

            let resolved = formula.replace(/@([a-zA-Z0-9_.]+)/g, (match, path) => {
              const val = path.split(".").reduce((o, k) => o?.[k], rollData);
              return val !== undefined ? String(val) : "0";
            });

            const roll = new Roll(resolved);
            await roll.evaluate();
            damageComponents.push({ name: item.name, formula: resolved, total: roll.total, type, roll });
            rollsToShow.push(roll);
          }
        }

        break; // Only first activity with damage
      }
    }

    // ── Radiant Soul (Celestial Warlock 6+) — direct spell damage path ──
    // RAW: "Once per turn when you deal fire or radiant damage with a spell or
    // cantrip, you can add your Charisma modifier to that damage."
    // Find the first fire/radiant component and add CHA mod. Once-per-turn
    // enforced via actor flag. The spell-source check is implicit here
    // because _rollSpellDamage is ONLY called for spell items — every path
    // through this method qualifies as "damage with a spell or cantrip".
    try {
      const radiantSoulIdx = damageComponents.findIndex(c => {
        const t = String(c.type ?? "").toLowerCase();
        return t === "radiant" || t === "fire";
      });
      if (radiantSoulIdx !== -1) {
        const targetType = damageComponents[radiantSoulIdx].type;
        const chaBonus = CombatState.getRadiantSoulBonus(casterActor, targetType);
        if (chaBonus > 0) {
          // Mutate the component's total + display formula so the bonus shows
          // inline with the spell's damage rather than as a separate line.
          // Direct spell damage is a single roll per type — adding a sibling
          // component would split the visual into two pieces of the same
          // type, which reads worse on the merge card.
          const original = damageComponents[radiantSoulIdx];
          original.total = (original.total ?? 0) + chaBonus;
          original.formula = `${original.formula} + ${chaBonus}`;
          original.radiantSoulBonus = chaBonus;
          original.featureRiders = [...(original.featureRiders ?? []), { name: "Radiant Soul", bonus: chaBonus }];
          await CombatState.markRadiantSoulUsed(casterActor);
          console.log(`${MODULE_ID} | Radiant Soul: +${chaBonus} ${targetType} added to ${casterActor.name}'s ${item.name} (direct spell path)`);
        }
      }
    } catch (err) {
      console.warn(`${MODULE_ID} | Radiant Soul direct-spell rider check failed (non-fatal):`, err);
    }

    // ── Visible Dice So Nice animation for spell damage ──
    // Save rolls already animate via the save-engine path. Damage rolls were
    // silently evaluated, so the merge card displayed totals without any dice
    // crossing the table. Now we fire DSN for every damage component (one
    // per damage type) in parallel, then wait a configurable pacing delay
    // before the merge card draws — same pattern as save rolls. Animation
    // is broadcast (3rd arg true) so PCs see NPC damage dice and vice versa.
    try {
      if (game.dice3d && rollsToShow.length > 0) {
        for (const r of rollsToShow) {
          game.dice3d.showForRoll(r, game.user, true).catch(err =>
            console.warn(`${MODULE_ID} | DSN showForRoll (damage) rejected (non-fatal):`, err)
          );
        }
        let delay = QolSettings.get("npcDamageAnimationDelay") ?? 1500;
        delay = Math.max(0, Math.min(8000, Number(delay) || 0));
        if (delay > 0) {
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    } catch (err) {
      console.warn(`${MODULE_ID} | DSN/pacing failed for damage roll (non-fatal):`, err);
    }

    return damageComponents;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  PC Whispered Save Prompt
  // ═══════════════════════════════════════════════════════════════════════════

  async _sendPcSavePrompt(item, casterActor, tgt, opts) {
    const { saveAbility, saveDC, halfOnSave, damageTypes, isSpell, castId } = opts;
    const abilityLabel = CONFIG.DND5E?.abilities?.[saveAbility]?.label ?? saveAbility.toUpperCase();

    const cardHtml = `
      <div class="ace-qol-pc-save-card">
        <div class="ace-qol-save-header">
          <img src="${item.img || "icons/svg/spell.svg"}" class="ace-qol-save-item-img" />
          <div>
            <strong>${item.name}</strong>
            <span class="ace-qol-save-dc">DC ${saveDC} ${abilityLabel} Save</span>
          </div>
        </div>
        <button class="ace-qol-btn ace-qol-btn-roll" data-action="aceQolRollPcSave">
          <i class="fas fa-dice-d20"></i> ROLL ${abilityLabel.toUpperCase()} SAVE
        </button>
      </div>
    `;

    // Whisper to the player(s) who own this PC only (GM has dice icon on target list)
    // Filter out GM users — they have ownership on all actors but don't need prompt cards
    const whisperIds = (tgt.ownerIds ?? []).filter(id => !game.users.get(id)?.isGM);

    await ChatMessage.create({
      content: cardHtml,
      speaker: ChatMessage.getSpeaker({ alias: tgt.name }),
      whisper: whisperIds,
      flags: {
        [MODULE_ID]: {
          type: "pcSavePrompt",
          itemId: item.id,
          itemUuid: item.uuid,
          actorId: tgt.actorId,
          tokenDocId: tgt.tokenDocId,
          sceneId: tgt.sceneId,
          saveAbility,
          saveDC,
          halfOnSave,
          damageTypes,
          isSpell,
          targetName: tgt.name,
          targetImg: tgt.img,
          autoFailSave: tgt.autoFailSave,
          saveAdvantage: tgt.saveAdvantage,
          saveDisadvantage: tgt.saveDisadvantage,
          superSaver: tgt.superSaver,
          semiSuperSaver: tgt.semiSuperSaver,
          saveBonuses: tgt.saveBonuses,
          damageModifiers: tgt.damageModifiers,
          currentHP: tgt.currentHP,
          maxHP: tgt.maxHP,
          castId,
        }
      }
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  PC Rolls Their Own Save
  // ═══════════════════════════════════════════════════════════════════════════

  async _rollPcSave(message) {
    const flags = message.flags?.[MODULE_ID];
    if (!flags) return;

    const { saveAbility, saveDC, halfOnSave, tokenDocId, sceneId, actorId,
            autoFailSave, saveAdvantage, saveDisadvantage, superSaver,
            saveBonuses, targetName, targetImg, castId } = flags;

    const scene = game.scenes.get(sceneId) ?? canvas.scene;
    const tokenDoc = scene?.tokens?.get(tokenDocId);
    const targetActor = tokenDoc?.actor
      ?? game.actors.get(actorId)
      ?? game.user.character;  // Fallback: player's assigned character
    if (!targetActor) {
      console.error(`${MODULE_ID} | _rollPcSave: Could not find actor for ${targetName} (actorId: ${actorId})`);
      ui.notifications.error("Could not find your character to roll the save.");
      return;
    }

    const abilityLabel = CONFIG.DND5E?.abilities?.[saveAbility]?.label ?? saveAbility.toUpperCase();
    let saveTotal = 0;
    let passed = false;
    let rollResult = null;

    if (autoFailSave) {
      saveTotal = 0;
      passed = false;
    } else {
      let rollMode = "normal";
      if (saveAdvantage && saveDisadvantage) rollMode = "normal";
      else if (saveAdvantage) rollMode = "advantage";
      else if (saveDisadvantage) rollMode = "disadvantage";

      const rawPcMod = targetActor.system?.abilities?.[saveAbility]?.save;
      const saveMod = typeof rawPcMod === "number" ? rawPcMod : (rawPcMod?.value ?? rawPcMod?.total ?? (Number(rawPcMod) || 0));
      const allBonusParts = (saveBonuses ?? []).map(b => b.value);

      // ── Cover DEX save bonus (half cover +2, three-quarters +5) ──
      if (saveAbility === "dex" && tokenDoc) {
        try {
          if (QolSettings.get("enableCoverCalculation")) {
            // Find caster token from the flags
            const casterActorId = flags.casterActorId ?? flags.actorId;
            const casterTokenDoc = scene?.tokens?.find(t => t.actorId === casterActorId);
            if (casterTokenDoc) {
              const coverResult = CoverEngine.calculateCover(casterTokenDoc, tokenDoc);
              if (coverResult?.dexSaveBonus > 0) {
                allBonusParts.push(coverResult.dexSaveBonus);
              }
            }
          }
        } catch (_) { /* cover check non-fatal */ }
      }

      const bonuses = allBonusParts.join(" + ");
      const formula = rollMode === "advantage" ? `2d20kh + ${saveMod}${bonuses ? ` + ${bonuses}` : ""}`
                    : rollMode === "disadvantage" ? `2d20kl + ${saveMod}${bonuses ? ` + ${bonuses}` : ""}`
                    : `1d20 + ${saveMod}${bonuses ? ` + ${bonuses}` : ""}`;

      const roll = new Roll(formula);
      await roll.evaluate();
      saveTotal = roll.total;
      passed = saveTotal >= saveDC;
      rollResult = roll;

      // Trigger Dice So Nice 3D animation — public so all players see it
      if (game.dice3d) {
        game.dice3d.showForRoll(roll, game.user, true).catch(() => {});
      }
    }

    // Determine result label
    let resultLabel;
    if (passed) {
      if (superSaver) resultLabel = "PASS (EVASION)";
      else if (halfOnSave) resultLabel = "PASS (HALF)";
      else resultLabel = "PASS (NO DMG)";
    } else {
      if (superSaver) resultLabel = "FAIL (EVASION: HALF)";
      else if (autoFailSave) resultLabel = "AUTO-FAIL";
      else resultLabel = "FAIL";
    }

    const passClass = passed ? "ace-qol-save-pass" : "ace-qol-save-fail";
    const rollDisplay = autoFailSave ? "AUTO" : saveTotal;
    const reasonText = autoFailSave
      ? `AUTO-FAIL (condition)`
      : passed
        ? `Rolled ${saveTotal} \u2014 SAVED (DC ${saveDC})`
        : `Rolled ${saveTotal} \u2014 FAILED (DC ${saveDC})`;

    // Post public result — clean, matches D&D 5e card style
    const passColor = passed ? "#00e676" : "#ff1744";
    const resultHtml = `
      <div class="ace-qol-save-pc-result-card">
        <div class="ace-qol-save-pc-result-line">
          <img src="${targetImg || "icons/svg/mystery-man.svg"}" class="ace-qol-save-tgt-img" />
          <span class="ace-qol-save-tgt-name">${targetName}</span>
          <span class="ace-qol-save-roll" style="color:${passColor}">${rollDisplay}</span>
          <span class="ace-qol-save-verdict" style="background:${passed ? 'rgba(0,230,118,0.15)' : 'rgba(255,23,68,0.15)'};color:${passColor}">${resultLabel}</span>
        </div>
      </div>
    `;

    await ChatMessage.create({
      content: resultHtml,
      speaker: ChatMessage.getSpeaker({ alias: targetName }),
      flags: {
        [MODULE_ID]: {
          type: "pcSaveResult",
          tokenDocId,
          actorId,
          sceneId,
          saveTotal,
          passed,
          resultLabel,
          autoFailSave,
          superSaver,
          castId,
        }
      }
    });

    // ── Emit saveComplete hook for PC save (duration tracker isSave expiry) ──
    try {
      if (targetActor) {
        Hooks.callAll(`${MODULE_ID}.saveComplete`, { actor: targetActor, tokenDocId, saveAbility, passed });
      }
    } catch (_) { /* non-fatal */ }

    // ── Update the main save results card's pending row for this PC ──
    // Determine damage multiplier same as NPC saves
    let damageMultiplier;
    if (passed) {
      if (superSaver) damageMultiplier = 0;        // Evasion pass = 0 damage
      else if (halfOnSave) damageMultiplier = 0.5;  // Half on save
      else damageMultiplier = 0;                     // No damage on save
    } else {
      if (superSaver) damageMultiplier = 0.5;        // Evasion fail = half
      else damageMultiplier = 1;                     // Full damage
    }

    // Main card update happens via renderChatMessage hook on GM client
    // (players don't have permission to edit GM-whispered messages)

    // Collapse any PC save prompt cards for this token
    const chatLog = document.querySelector("#chat-log, .chat-log");
    if (chatLog) {
      const promptCards = chatLog.querySelectorAll(".chat-message");
      for (const card of promptCards) {
        const cardMsg = game.messages.get(card.dataset.messageId);
        const cardFlags = cardMsg?.flags?.[MODULE_ID];
        if (cardFlags?.type === "pcSavePrompt" && cardFlags.tokenDocId === tokenDocId) {
          card.classList.add("ace-qol-save-collapsed");
        }
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  GM: Handle PC Save Result Posted (from renderChatMessage hook)
  // ═══════════════════════════════════════════════════════════════════════════

  _onPcSaveResultPosted(resultFlags) {
    console.log(`${MODULE_ID} | _onPcSaveResultPosted fired for tokenDocId:`, resultFlags.tokenDocId, "passed:", resultFlags.passed);
    const { tokenDocId, saveTotal, passed, resultLabel, autoFailSave, superSaver } = resultFlags;

    // Determine damage multiplier
    let damageMultiplier;
    if (passed) {
      if (superSaver) damageMultiplier = 0;
      else damageMultiplier = 0.5; // half on save (most common for AoE)
    } else {
      if (superSaver) damageMultiplier = 0.5;
      else damageMultiplier = 1;
    }

    const pcResult = { saveTotal, passed, resultLabel, autoFailSave, damageMultiplier };

    // Update Phase 1 save results card if it exists
    this._updateMainCardPcResult(tokenDocId, pcResult);

    // Update the target list card's PC row live
    this._updateTargetListPcRow(tokenDocId, pcResult);

    // Collapse the PC prompt card on GM side
    const chatLog = document.querySelector("#chat-log, .chat-log");
    if (chatLog) {
      for (const card of chatLog.querySelectorAll(".chat-message")) {
        const cardMsg = game.messages.get(card.dataset.messageId);
        const f = cardMsg?.flags?.[MODULE_ID];
        if (f?.type === "pcSavePrompt" && f.tokenDocId === tokenDocId) {
          card.classList.add("ace-qol-save-collapsed");
        }
      }
    }
  }

  /**
   * Update a PC row on the target list card with their save result (live update).
   */
  _updateTargetListPcRow(tokenDocId, pcResult) {
    console.log(`${MODULE_ID} | _updateTargetListPcRow looking for tokenDocId:`, tokenDocId);

    // Search the entire document — V13 chat containers vary
    const row = document.querySelector(`.ace-qol-save-tgt-row[data-token-doc-id="${tokenDocId}"]`);
    if (!row) { console.log(`${MODULE_ID} | Row not found in DOM`); return; }
    {

      const passClass = pcResult.passed ? "ace-qol-save-pass" : "ace-qol-save-fail";
      const verdictText = pcResult.passed ? "PASS" : "FAIL";
      const rollDisplay = pcResult.autoFailSave ? "AUTO" : pcResult.saveTotal;

      // Replace the dice button + mod with the result
      const modSpan = row.querySelector(".ace-qol-save-tgt-mod");
      if (modSpan) modSpan.innerHTML = `<span class="${passClass}" style="font-weight:700">${rollDisplay}</span>`;

      const rollBtn = row.querySelector(".ace-qol-save-pc-roll-btn");
      if (rollBtn) {
        rollBtn.disabled = true;
        rollBtn.innerHTML = `<span class="ace-qol-save-verdict ${passClass}" style="font-size:0.65rem">${verdictText}</span>`;
        rollBtn.style.background = "none";
        rollBtn.style.border = "none";
        rollBtn.style.padding = "0 4px";
      }

      // ── Bottom action button reconciliation + template auto-delete ──
      // After this PC rolled, check if any PC roll buttons are still pending.
      // If no PCs left to roll AND no NPCs left to roll:
      //   1. Change bottom button to "ALL ROLLED" terminal state
      //   2. Auto-delete the AOE template (so the spell visual goes away —
      //      the existing _deleteInstantTemplate path only fires on full save
      //      completion / Phase 2, not on the "PCs roll individually" path)
      try {
        const chatEl = row.closest(".chat-message");
        const card = row.closest(".ace-qol-save-target-card") ?? chatEl;
        const pendingPcRolls = card?.querySelectorAll?.(".ace-qol-save-pc-roll-btn:not([disabled])") ?? [];
        const pendingNpcRolls = card?.querySelectorAll?.(".ace-qol-save-tgt-row[data-pc='false']:not([data-rolled])") ?? [];
        const bottomBtn = card?.querySelector?.("[data-action='aceQolRollNpcSaves']");
        if (bottomBtn && pendingPcRolls.length === 0 && pendingNpcRolls.length === 0) {
          bottomBtn.disabled = true;
          bottomBtn.innerHTML = `<i class="fas fa-check"></i> ALL ROLLED`;
          bottomBtn.classList?.add?.("ace-qol-btn-done");

          // Trigger template auto-delete (was only firing on full result-card
          // completion paths). Look up the message from the chat element's
          // data-message-id, fetch flags, hand to _deleteInstantTemplate.
          try {
            const msgId = chatEl?.dataset?.messageId;
            const msg = msgId ? game.messages.get(msgId) : null;
            const flags = msg?.flags?.[MODULE_ID];
            if (flags) this._deleteInstantTemplate(flags);
          } catch (err) {
            console.warn(`${MODULE_ID} | Template auto-delete on PC-only completion threw:`, err);
          }
        }
      } catch (err) {
        console.warn(`${MODULE_ID} | Bottom-button reconciliation threw:`, err);
      }

      console.log(`${MODULE_ID} | Updated target list PC row: ${verdictText} (${rollDisplay})`);
      return;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Update Main Save Results Card with PC Save Result
  // ═══════════════════════════════════════════════════════════════════════════

  async _updateMainCardPcResult(tokenDocId, pcResult) {
    // Find the most recent saveResults card and update/insert this PC's row.
    // Three cases for that card:
    //   (a) PC entry exists as pending → update in place
    //   (b) PC entry exists already resolved → REPLACE (re-roll after X+re-add)
    //   (c) PC not in allResults at all → append as new resolved entry (late-add)
    const messages = game.messages.contents.slice(-20).reverse();

    let msg = null;
    for (const m of messages) {
      const f = m.flags?.[MODULE_ID];
      if (f?.type === "saveResults" && Array.isArray(f.allResults)) { msg = m; break; }
    }
    if (!msg) return;

    const flags = msg.flags?.[MODULE_ID];
    const allResults = [...(flags.allResults ?? [])];
    let idx = allResults.findIndex(r => r.tokenDocId === tokenDocId);

    if (idx < 0) {
      // Case (c): late-add — build a fresh resolved entry
      const scene = game.scenes.get(canvas.scene?.id) ?? canvas.scene;
      const tokenDoc = scene?.tokens?.get(tokenDocId);
      const actor = tokenDoc?.actor;
      allResults.push({
        name:       tokenDoc?.name ?? actor?.name ?? "Unknown",
        img:        tokenDoc?.texture?.src ?? actor?.img ?? "icons/svg/mystery-man.svg",
        tokenDocId,
        actorId:    actor?.id,
        sceneId:    scene?.id,
        saveTotal:  pcResult.saveTotal,
        passed:     pcResult.passed,
        isAutoFail: pcResult.autoFailSave,
        resultLabel: pcResult.resultLabel,
        damageMultiplier: pcResult.damageMultiplier,
        damageModifiers: {},
        currentHP:  actor?.system?.attributes?.hp?.value ?? 0,
        maxHP:      actor?.system?.attributes?.hp?.max ?? 0,
        isPC:       true,
        pending:    false,
      });
      idx = allResults.length - 1;
    }

    // Apply pcResult to the entry at idx (covers a, b, and c cases)
    const r = allResults[idx];
    r.pending = false;
    r.saveTotal = pcResult.saveTotal;
    r.passed = pcResult.passed;
    r.resultLabel = pcResult.resultLabel;
    r.isAutoFail = pcResult.autoFailSave;
    r.damageMultiplier = pcResult.damageMultiplier;

    // Refresh live HP from the actor (PC may have taken damage since card was built)
    try {
      const scene = game.scenes.get(r.sceneId) ?? canvas.scene;
      const tokenDoc = scene?.tokens?.get(r.tokenDocId);
      const actor = tokenDoc?.actor ?? game.actors.get(r.actorId);
      if (actor) r.currentHP = actor.system?.attributes?.hp?.value ?? r.currentHP;
    } catch (_) { /* keep cached HP if refresh fails */ }

    // ── Rebuild the card (Phase 2 if damage rolled, otherwise Phase 1) ──
    try {
      const item = await fromUuid(flags.itemUuid) ?? game.items.get(flags.itemId);
      if (!item) {
        await msg.update({ [`flags.${MODULE_ID}.allResults`]: allResults }, { render: false });
        return;
      }

      const isPhase2 = flags.phase === 2 || Array.isArray(flags.damageComponentTotals);
      let cardHtml;
      if (isPhase2 && Array.isArray(flags.damageComponentTotals)) {
        const casterActor = game.actors.get(flags.actorId);
        const damageComponents = flags.damageComponentTotals.map(c => ({
          total: c.total, type: c.type, formula: c.formula ?? String(c.total),
        }));
        cardHtml = this._buildPhase2CardHtml(item, casterActor, allResults, damageComponents, {
          saveAbility: flags.saveAbility, saveDC: flags.saveDC,
          halfOnSave: flags.halfOnSave, damageTypes: flags.damageTypes,
        });
      } else {
        cardHtml = this._buildPhase1CardHtml(item, allResults, {
          saveAbility: flags.saveAbility, saveDC: flags.saveDC,
          hasDamage: flags.hasDamage !== false,
        });
      }

      await msg.update({
        content: cardHtml,
        [`flags.${MODULE_ID}.allResults`]: allResults,
      });
      console.log(`${MODULE_ID} | Card updated for ${r.name}: ${r.passed ? "PASS" : "FAIL"} (${r.saveTotal})`);
    } catch (err) {
      console.error(`${MODULE_ID} | Card update failed:`, err);
      // Last-ditch: at least persist the flag
      await msg.update({ [`flags.${MODULE_ID}.allResults`]: allResults }, { render: false });
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Roll All Saves — Legacy (GM Clicks the Button on old-style card)
  // ═══════════════════════════════════════════════════════════════════════════

  async _rollAllSaves(message) {
    const flags = message.flags?.[MODULE_ID];
    if (!flags) return;

    const { saveAbility, saveDC, halfOnSave, targets, itemId, itemUuid, actorId, damageTypes, isSpell } = flags;

    const item = await fromUuid(itemUuid) ?? game.items.get(itemId);
    const casterActor = game.actors.get(actorId);

    const results = [];
    // Multi-target pacing for the legacy ROLL ALL SAVES button — same logic
    // as the modern path so a Fireball through this code path doesn't burn
    // the full single-target delay per die.
    const isMultiLegacy = (targets?.length ?? 0) > 1;

    for (const tgt of targets) {
      const result = await this._rollSingleSave(tgt, saveAbility, saveDC, halfOnSave, actorId, { isMultiTarget: isMultiLegacy });
      results.push(result);

      // Emit saveComplete hook for duration tracker (isSave expiry)
      try {
        const scene = game.scenes.get(result.sceneId) ?? canvas.scene;
        const tokenDoc = scene?.tokens?.get(result.tokenDocId);
        const actor = tokenDoc?.actor ?? game.actors.get(result.actorId);
        if (actor) {
          Hooks.callAll(`${MODULE_ID}.saveComplete`, { actor, tokenDocId: result.tokenDocId, saveAbility, passed: result.passed });
        }
      } catch (_) { /* non-fatal */ }
    }

    // ── Save-or-condition spell handling ──
    // For spells like Hold Person, Sleep, Hypnotic Pattern, Charm Person,
    // Bane, Tasha's Hideous Laughter — failed saves apply CONDITIONS
    // (paralyzed, frightened, charmed, etc.) with no damage. Until this
    // shipped, save-engine was hard-wired to damage flow only and these
    // spells silently did nothing when the save failed. Mirrors the
    // post-hit-saves.mjs pattern that handles weapon-rider conditions.
    await this._applyFailedSaveConditions(item, results, { saveAbility, saveDC, activityId: flags.activityId ?? null, casterActor });

    // Roll damage once and apply per target with multipliers
    const damageComponents = await this._rollSpellDamage(item, casterActor, {
      spellLevel: flags.spellLevel ?? null,
    });
    await this._postSaveResults(item, casterActor, results, {
      saveAbility, saveDC, halfOnSave, damageTypes, isSpell,
    }, damageComponents);
  }

  /**
   * Apply on-fail conditions to every target that failed the save.
   *
   * Reads conditions from the item description via DescriptionParser. Honors
   * `cond.requiresSave === true` so we don't apply on-hit conditions through
   * this path (those are handled elsewhere). Respects per-target condition
   * immunity — frightened-immune fey hit by Cause Fear silently skip.
   * Routes through ConditionLibrary.applyByName so exhaustion correctly
   * INCREMENTS the level counter rather than toggling.
   *
   * @param {Item} item    — the spell item (must have description)
   * @param {Array} results — per-target save results (fields: passed, tokenDocId, sceneId, actorId, name)
   * @returns {Promise<void>}
   */
  /**
   * Drop the caster's concentration on this specific spell.
   *
   * Called when a concentration spell resolved with no actual effect on any
   * target — the caster shouldn't be stuck "concentrating on nothing." RAW:
   * concentration only matters while there's an effect to maintain; if every
   * target saved or was immune, the spell ends and so does the concentration.
   *
   * Matches the concentrating Active Effect by:
   *   1. flags.dnd5e.concentration.origin includes the spell item's UUID, OR
   *   2. The effect name contains the spell name (fallback)
   * Only deletes if the spell is actually a concentration spell.
   *
   * @param {Item} item — the spell that just resolved
   * @param {Actor} caster — the caster
   * @returns {Promise<boolean>} — true if concentration was dropped
   */
  async _dropCasterConcentrationIfNoEffect(item, caster) {
    if (!item || !caster) return false;

    // Confirm the spell required concentration in the first place
    const props = item.system?.properties;
    const isConcentration = props?.has?.("concentration")
      || (Array.isArray(props) && props.includes("concentration"));
    if (!isConcentration) return false;

    // ── Persistent-AOE exception ──
    // Spells like Stinking Cloud, Cloudkill, Moonbeam etc. create a persistent
    // template that AFFECTS creatures over time — even if every creature in
    // the area at cast time saves successfully, the cloud is still there for
    // 1 minute and other creatures may enter / start their turn inside.
    // Dropping concentration here would defeat the spell.
    //
    // Heuristic: any spell whose timing is NOT instant (i.e. has a persistent
    // template / ongoing area) is exempt from "wasted concentration" drop.
    // This covers all area-denial family spells, all ENTER_START spells, and
    // all NO_SAVE_AUTO movement-damage spells in one rule.
    try {
      const timing = getSpellTiming(item);
      const isPersistent = timing?.isPersistent === true
        || (timing?.timing && timing.timing !== TIMING.INSTANT);
      if (isPersistent) {
        console.log(`${MODULE_ID} | _dropCasterConcentrationIfNoEffect: skipping for "${item.name}" — persistent template spell, concentration is NOT wasted by passed initial saves`);
        return false;
      }
    } catch (err) {
      console.warn(`${MODULE_ID} | wasted-concentration spell-timing check failed (non-fatal — vanilla drop logic continues):`, err);
    }

    // Find the matching concentrating effect on the caster
    const effects = caster.effects?.contents ?? [];
    const concEffect = effects.find(e => {
      if (e.disabled) return false;
      const isConcentratingFx = e.statuses?.has?.("concentrating")
        || e.flags?.dnd5e?.concentration;
      if (!isConcentratingFx) return false;
      // Match by spell origin
      const concOrigin = e.flags?.dnd5e?.concentration?.origin ?? "";
      if (concOrigin && item.uuid && concOrigin.includes(item.uuid)) return true;
      // Fallback: effect name contains spell name
      if (e.name && item.name && e.name.includes(item.name)) return true;
      return false;
    });

    if (!concEffect) {
      console.log(`${MODULE_ID} | _dropCasterConcentrationIfNoEffect: no matching concentration effect on ${caster.name} for ${item.name}`);
      return false;
    }

    try {
      await concEffect.delete();
      ui.notifications?.info(`${item.name}: no targets affected — concentration ended.`);
      console.log(`${MODULE_ID} | Dropped wasted concentration on ${item.name} for ${caster.name}`);
      return true;
    } catch (err) {
      console.warn(`${MODULE_ID} | Failed to drop concentration effect on ${caster.name}:`, err);
      return false;
    }
  }

  async _applyFailedSaveConditions(item, results, saveCtx = null) {
    // Returns an array of { targetName, conditions: [...] } per target where
    // at least one condition was successfully applied. Used by Phase 1 card
    // builder to render specific "Goblin: Paralyzed" footers instead of a
    // generic message.
    //
    // saveCtx (optional): { saveAbility, saveDC }
    //   When provided, repeating-save metadata gets stamped on the placed
    //   effect so RepeatingSaveEngine can fire end-of-turn re-saves
    //   (Hold Person, Banishment, etc.). If omitted, we try to recover the
    //   ability/DC from the item's first save activity as a fallback.
    const applied = [];

    if (!item || !results?.length) {
      console.log(`${MODULE_ID} | _applyFailedSaveConditions: no item or no results`);
      return applied;
    }

    let parsed;
    try {
      parsed = DescriptionParser.parse(item);
    } catch (err) {
      console.warn(`${MODULE_ID} | _applyFailedSaveConditions: parse failed for ${item.name}:`, err);
      return applied;
    }

    // ── Resolve save ability + DC for repeating-save metadata ──
    let resolvedSaveAbility = saveCtx?.saveAbility ?? null;
    let resolvedSaveDC      = Number(saveCtx?.saveDC) || null;
    if ((!resolvedSaveAbility || !resolvedSaveDC) && item?.system?.activities) {
      try {
        const acts = [...(item.system.activities?.values?.() ?? [])];
        const saveAct = acts.find(a => a?.save?.ability);
        if (saveAct) {
          if (!resolvedSaveAbility) {
            const ab = saveAct.save.ability;
            resolvedSaveAbility = (ab instanceof Set || Array.isArray(ab)) ? [...ab][0] : String(ab);
          }
          if (!resolvedSaveDC) {
            resolvedSaveDC = Number(saveAct.save.dc?.value ?? saveAct.save.dc) || null;
          }
        }
      } catch (_) { /* best-effort fallback */ }
    }
    // Compute spell duration in seconds (for math-correct OOC cap)
    let durationSeconds = null;
    try {
      const dur = item?.system?.duration;
      if (dur) {
        const value = Number(dur.value) || 0;
        const units = String(dur.units ?? "").toLowerCase();
        switch (units) {
          case "round":   durationSeconds = value * 6; break;
          case "turn":    durationSeconds = value * 6; break;
          case "minute":  durationSeconds = value * 60; break;
          case "hour":    durationSeconds = value * 3600; break;
          case "day":     durationSeconds = value * 86400; break;
          case "instant": durationSeconds = 0; break;
          // "permanent", "special", "until dispelled" → null (no cap)
        }
      }
    } catch (_) { /* fallthrough */ }

    const repeatingSaveMeta = (parsed?.repeatingSave?.trigger && resolvedSaveAbility && resolvedSaveDC)
      ? {
          ability:         resolvedSaveAbility,
          dc:              resolvedSaveDC,
          trigger:         parsed.repeatingSave.trigger,
          castWorldTime:   game.time?.worldTime ?? 0,
          durationSeconds: durationSeconds, // null = no duration cap
        }
      : null;

    // Diagnostic dump — surfaces why conditions might not be applying
    const allConds = parsed?.conditions ?? [];
    const failConditions = allConds.filter(c => c?.requiresSave);
    console.log(`${MODULE_ID} | _applyFailedSaveConditions: ${item.name} — parsed ${allConds.length} condition(s), ${failConditions.length} marked requiresSave:`,
      allConds.map(c => `${c.condition}${c.requiresSave ? "(save)" : "(no-save)"}`));

    // ── Polymorph spell branch — MUST run BEFORE the no-conditions early return ──
    // Polymorph-class spells don't apply a tagged condition like "paralyzed" —
    // they transform the target. So `failConditions.length === 0` is EXPECTED
    // for Polymorph and the normal "NO conditions marked requiresSave" return
    // would skip our transformation routing. Branch here first.
    const isPolymorph = PolymorphSpellPipeline.isPolymorphSpell(item);
    if (isPolymorph) {
      console.log(`${MODULE_ID} | _applyFailedSaveConditions: ${item.name} — routing to Polymorph pipeline (skipping normal condition path)`);
      const activityId = saveCtx?.activityId ?? null;
      const casterActor = saveCtx?.casterActor ?? null;
      const failed = results.filter(r => r && !r.passed);
      if (!failed.length) {
        console.log(`${MODULE_ID} | ${item.name}: no failed saves — no transformation`);
        return applied;
      }
      for (const r of failed) {
        const scene = game.scenes.get(r.sceneId) ?? canvas.scene;
        const tokenDoc = scene?.tokens?.get(r.tokenDocId);
        const actor = tokenDoc?.actor ?? game.actors.get(r.actorId);
        if (!actor) continue;

        const transformed = await PolymorphSpellPipeline.tryConsumeAndTransform(activityId, actor, casterActor, tokenDoc);
        if (transformed) {
          applied.push({
            targetName: r.name ?? actor.name,
            tokenDocId: r.tokenDocId,
            conditions: ["transformed"],
          });
        } else {
          console.warn(`${MODULE_ID} | ${item.name}: Polymorph cast but no pending pick for activity ${activityId} — target ${actor.name} unaffected`);
        }
      }
      // Polymorph handled (success or no-pick) — skip the normal condition
      // application loop entirely. Polymorph doesn't apply paralyzed etc.
      return applied;
    }

    if (!failConditions.length) {
      console.warn(`${MODULE_ID} | _applyFailedSaveConditions: ${item.name} — NO conditions marked requiresSave. Description parse may have missed the save trigger. Description excerpt:`,
        String(item.system?.description?.value ?? "").replace(/<[^>]+>/g, " ").slice(0, 300));
      return applied;
    }

    const autoApply = QolSettings.get("autoApplyConditions") ?? true;
    if (!autoApply) {
      console.log(`${MODULE_ID} | autoApplyConditions OFF — skipping condition application for ${item.name}`);
      return applied;
    }

    const failed = results.filter(r => r && !r.passed);
    if (!failed.length) {
      console.log(`${MODULE_ID} | ${item.name}: no failed saves — no conditions to apply`);
      return applied;
    }

    for (const r of failed) {
      const scene = game.scenes.get(r.sceneId) ?? canvas.scene;
      const tokenDoc = scene?.tokens?.get(r.tokenDocId);
      const actor = tokenDoc?.actor ?? game.actors.get(r.actorId);
      if (!actor) {
        console.warn(`${MODULE_ID} | _applyFailedSaveConditions: ${item.name} — could not resolve actor for failed target ${r.name} (sceneId=${r.sceneId} tokenDocId=${r.tokenDocId} actorId=${r.actorId})`);
        continue;
      }

      const condImmunities = new Set(
        (actor.system?.traits?.ci?.value ?? []).map(s => String(s).toLowerCase())
      );

      const appliedForThisTarget = [];

      for (const cond of failConditions) {
        const condKey = String(cond.condition ?? "").toLowerCase().trim();
        if (!condKey) continue;
        if (condImmunities.has(condKey)) {
          console.log(`${MODULE_ID} | ${actor.name} IMMUNE to ${condKey} — ${item.name} condition skipped`);
          continue;
        }
        try {
          // ── Concentration linkage ──
          // For concentration spells (Hold Person, Hypnotic Pattern, etc.),
          // tag the applied condition with the caster + spell name so we
          // can sweep + remove it automatically when the caster's
          // concentration ends or moves to a new cast.
          let concentrationOrigin = null;
          const isConcentration = item?.system?.properties?.has?.("concentration")
            || (Array.isArray(item?.system?.properties) && item.system.properties.includes("concentration"));
          if (isConcentration) {
            concentrationOrigin = {
              casterId:    item.actor?.id ?? null,
              spellName:   item.name,
              spellItemId: item.id,
            };
          }

          // Build options bundle for applyByName — concentration linkage AND
          // repeating-save metadata (when applicable).
          const applyOpts = {};
          if (concentrationOrigin) applyOpts.concentrationOrigin = concentrationOrigin;
          if (repeatingSaveMeta)   applyOpts.repeatingSave       = repeatingSaveMeta;

          // Area-denial family (Stinking Cloud, etc.): description-parsed
          // conditions like Poisoned need to auto-expire at end of the
          // victim's turn, otherwise they linger forever even after the
          // Retching effect clears. Stinking Cloud 2024 RAW: Poisoned
          // until start of next turn — turnEnd is one tick earlier but
          // functionally equivalent for "loses Action this turn."
          try {
            const tm = item?.flags?.["ace-qol"]?.spellTiming;
            let familyTag = tm?.family ?? null;
            if (!familyTag) {
              // Look up via the spell-timing table
              const { getSpellTiming } = await import("./spell-timing.mjs");
              const timing = getSpellTiming(item);
              familyTag = timing?.family ?? null;
            }
            if (familyTag === "areaDenial") {
              applyOpts.specialDuration = "turnEnd";
            }
          } catch (_) { /* best-effort; missing family flag = old behavior */ }

          const out = await ConditionLibrary.applyByName(actor, cond.condition,
            Object.keys(applyOpts).length ? applyOpts : undefined);
          if (out?.ok) {
            const detail = out.level !== undefined ? ` (level ${out.level})` : "";
            const tagBits = [];
            if (concentrationOrigin) tagBits.push("concentration-linked");
            if (repeatingSaveMeta)   tagBits.push(`repeating-save:${repeatingSaveMeta.trigger}`);
            const tagStr = tagBits.length ? ` [${tagBits.join(", ")}]` : "";
            console.log(`${MODULE_ID} | ${item.name}: applied "${cond.condition}"${detail} to ${actor.name} (failed save)${tagStr}`);
            appliedForThisTarget.push(cond.condition);
          } else {
            console.warn(`${MODULE_ID} | ${item.name}: applyByName returned not-ok for "${cond.condition}" on ${actor.name}:`, out);
          }
        } catch (err) {
          console.warn(`${MODULE_ID} | applyByName(${cond.condition}) failed for ${actor.name}:`, err);
        }
      }

      if (appliedForThisTarget.length) {
        applied.push({
          targetName: r.name ?? actor.name,
          tokenDocId: r.tokenDocId,
          conditions: appliedForThisTarget,
        });
      }
    }

    return applied;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Phase 1 — Saves-Only Card (no damage yet, ROLL DAMAGE button)
  // ═══════════════════════════════════════════════════════════════════════════

  // ─────────────────────────────────────────────────────────────────────────
  //  Build Phase 1 card HTML — extracted so late PC updates can rebuild
  // ─────────────────────────────────────────────────────────────────────────
  _buildPhase1CardHtml(item, results, opts) {
    const { saveAbility, saveDC, hasDamage = true, appliedConditions = [] } = opts;
    const abilityLabel = CONFIG.DND5E?.abilities?.[saveAbility]?.label ?? saveAbility.toUpperCase();

    const targetRows = results.map(r => {
      const removeBtn = `<button class="ace-qol-save-phase1-remove" data-action="aceQolRemovePhase1" data-token-doc-id="${r.tokenDocId}" title="Remove this target before damage rolls"><i class="fas fa-xmark"></i></button>`;
      if (r.pending) {
        return `
          <div class="ace-qol-save-result-row ace-qol-save-result-pending" data-token-doc-id="${r.tokenDocId}">
            <div class="ace-qol-save-result-target">
              <img src="${r.img || "icons/svg/mystery-man.svg"}" class="ace-qol-save-tgt-img" />
              <span class="ace-qol-save-tgt-name">${r.name}</span>
              <span class="ace-qol-save-result-label ace-qol-save-pending">\u23f3 Waiting for save...</span>
              ${removeBtn}
            </div>
          </div>
        `;
      }
      const passClass = r.passed ? "ace-qol-save-pass" : "ace-qol-save-fail";
      const verdictText = r.passed ? "PASS" : "FAIL";

      // Build the dice breakdown: show the d20 (with adv/disadv indicator)
      // plus modifier so the GM can immediately see what was rolled and
      // calc the actor's static bonus. Falls back to just the total when
      // roll info isn't available (auto-fail, edge cases).
      let rollDisplay;
      if (r.isAutoFail) {
        rollDisplay = `<span class="ace-qol-save-roll ${passClass}">AUTO</span>`;
      } else if (r.roll) {
        const d20Term = r.roll.dice?.[0] ?? r.roll.terms?.[0];
        const d20Result = d20Term?.total ?? null;
        const modifier = (typeof r.saveTotal === "number" && d20Result != null)
          ? r.saveTotal - d20Result : null;
        if (d20Result != null && modifier != null) {
          const modSign = modifier >= 0 ? "+" : "";
          const modPart = modifier === 0 ? "" : ` ${modSign}${modifier}`;
          rollDisplay = `
            <span class="ace-qol-save-roll-breakdown" style="display:inline-flex;align-items:center;gap:5px;font-family:'Signika',sans-serif;">
              <i class="fas fa-dice-d20" style="color:#d4af37;font-size:13px;"></i>
              <span style="color:#c8b890;font-size:12px;letter-spacing:0.3px;">${d20Result}${modPart} =</span>
              <span class="${passClass}" style="font-weight:700;font-size:14px;">${r.saveTotal}</span>
            </span>`;
        } else {
          rollDisplay = `<span class="ace-qol-save-roll ${passClass}">${r.saveTotal}</span>`;
        }
      } else {
        rollDisplay = `<span class="ace-qol-save-roll ${passClass}">${r.saveTotal}</span>`;
      }

      // Two-line layout: target name across the top, dice/verdict on the
      // second line. Avoids the "Dea/th/Kni/ght" squish that happens when
      // a long name fights for horizontal space with the roll formula.
      return `
        <div class="ace-qol-save-result-row" data-token-doc-id="${r.tokenDocId}"
             style="padding:8px 10px;border-bottom:1px solid rgba(212,175,55,0.15);">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;">
            <img src="${r.img || "icons/svg/mystery-man.svg"}" class="ace-qol-save-tgt-img"
                 style="width:24px;height:24px;border-radius:50%;flex-shrink:0;border:1px solid #444;" />
            <span class="ace-qol-save-tgt-name"
                  style="flex:1;font-weight:bold;color:#fff;font-size:14px;line-height:1.2;">${r.name}</span>
            ${removeBtn}
          </div>
          <div style="display:flex;justify-content:space-between;align-items:center;padding-left:32px;gap:8px;">
            <span style="flex:1;">${rollDisplay}</span>
            <span class="ace-qol-save-verdict ${passClass}"
                  style="font-weight:bold;font-size:14px;letter-spacing:0.5px;">${verdictText}</span>
          </div>
        </div>
      `;
    }).join("");

    // ROLL DAMAGE button only appears if the spell actually deals damage.
    // Save-or-condition spells (Hold Person, Charm Person, Sleep, etc.) get
    // a per-target condition footer instead. Each line shows exactly which
    // condition was applied to which target (red, e.g., "Goblin: Paralyzed")
    // so the GM/player can see at a glance what changed.
    let actionsHtml;
    if (hasDamage) {
      actionsHtml = `<div class="ace-qol-dmg-actions">
          <button class="ace-qol-btn ace-qol-btn-roll-dmg" data-action="aceQolRollDamage">
            <i class="fas fa-dice-d20"></i> ROLL DAMAGE
          </button>
        </div>`;
    } else if (appliedConditions?.length) {
      const lines = appliedConditions.map(a => {
        const condList = a.conditions.map(c =>
          c.charAt(0).toUpperCase() + c.slice(1).toLowerCase()
        ).join(", ");
        return `<div style="display:flex;align-items:center;gap:6px;padding:2px 0;">
          <i class="fas fa-skull-crossbones" style="color:#ff5555;font-size:11px;"></i>
          <span style="color:#ffffff;font-weight:700;">${foundry.utils.escapeHTML(a.targetName)}</span>
          <span style="color:#888;">\u2192</span>
          <span style="color:#ff5555;font-weight:700;letter-spacing:0.5px;">${foundry.utils.escapeHTML(condList)}</span>
        </div>`;
      }).join("");
      actionsHtml = `<div class="ace-qol-save-conditions-applied" style="padding:8px 12px;background:linear-gradient(180deg,rgba(255,85,85,0.08),rgba(255,85,85,0.03));border-top:1px solid rgba(255,85,85,0.25);font-size:12px;">
          ${lines}
        </div>`;
    } else {
      // No conditions applied. Distinguish between:
      //   (a) Everyone passed their save \u2192 green "resisted" message
      //   (b) Someone failed but no conditions to apply \u2192 silent (leave blank)
      // Otherwise we'd show a misleading "all resisted" message when in fact
      // a target failed but the parser couldn't extract the condition (e.g.,
      // homebrew description format we don't recognize yet).
      const anyoneFailed = (results ?? []).some(r => r && !r.passed && !r.pending);
      if (anyoneFailed) {
        actionsHtml = `<div class="ace-qol-save-no-effect" style="padding:6px 12px;text-align:center;color:#aaa;font-size:11px;font-style:italic;">
          <i class="fas fa-info-circle"></i> Save resolved \u2014 apply spell effect manually if needed
        </div>`;
      } else {
        actionsHtml = `<div class="ace-qol-save-no-effect" style="padding:6px 12px;text-align:center;color:#88c878;font-size:11px;font-style:italic;">
          <i class="fas fa-shield-halved"></i> All targets resisted
        </div>`;
      }
    }

    return `
      <div class="ace-qol-save-results-card" data-phase="1">
        <div class="ace-qol-save-header">
          <img src="${item.img || "icons/svg/spell.svg"}" class="ace-qol-save-item-img" />
          <div>
            <strong class="ace-qol-save-item-name">${item.name} \u2014 Saves</strong>
            <span class="ace-qol-save-dc">DC ${saveDC} ${abilityLabel}</span>
          </div>
        </div>
        <div class="ace-qol-save-results">
          ${targetRows}
        </div>
        ${actionsHtml}
      </div>
    `;
  }

  async _postSaveResultsPhase1(item, casterActor, results, opts) {
    const { saveAbility, saveDC, halfOnSave, damageTypes, isSpell,
            timingType, templateDocId, templateSceneId, hasDamage = true,
            appliedConditions = [] } = opts;

    const cardHtml = this._buildPhase1CardHtml(item, results, opts);

    await ChatMessage.create({
      content: cardHtml,
      speaker: ChatMessage.getSpeaker({ actor: casterActor }),
      whisper: [game.user.id],
      flags: {
        [MODULE_ID]: {
          type: "saveResults",
          phase: 1,
          itemId: item.id,
          itemUuid: item.uuid,
          actorId: casterActor?.id,
          saveAbility,
          saveDC,
          halfOnSave,
          damageTypes,
          isSpell,
          hasDamage, // false for save-only-condition spells; suppresses Phase 2
          appliedConditions, // [{ targetName, conditions:[...] }] for footer rendering
          allResults: results.map(r => ({
            name: r.name,
            img: r.img,
            tokenDocId: r.tokenDocId,
            actorId: r.actorId,
            sceneId: r.sceneId,
            saveTotal: r.saveTotal,
            passed: r.passed,
            isAutoFail: r.isAutoFail,
            resultLabel: r.resultLabel,
            damageMultiplier: r.damageMultiplier,
            damageModifiers: r.damageModifiers,
            currentHP: r.currentHP,
            maxHP: r.maxHP,
            isPC: r.isPC,
            pending: r.pending,
          })),
          timingType:      timingType ?? null,
          templateDocId:   templateDocId ?? null,
          templateSceneId: templateSceneId ?? null,
        }
      }
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Phase 2 — Complete Save Results (roll damage, update card in-place)
  // ═══════════════════════════════════════════════════════════════════════════

  async _completeSaveResultsPhase2(message) {
    const flags = message.flags?.[MODULE_ID];
    if (!flags || flags.phase !== 1) return;

    // Save-only-condition spells (no damage parts) never produce a Phase 2.
    // Defensive — the button shouldn't render, but if a stale card from
    // before this fix or a custom hook somehow fires here, refuse to post
    // a damage card with zero damage.
    if (flags.hasDamage === false) {
      console.log(`${MODULE_ID} | Phase 2 skipped — ${flags.itemId ?? "spell"} has no damage parts`);
      return;
    }

    const { itemUuid, itemId, actorId, saveAbility, saveDC, halfOnSave,
            damageTypes, isSpell, allResults, spellLevel } = flags;

    const item = await fromUuid(itemUuid) ?? game.items.get(itemId);
    const casterActor = game.actors.get(actorId);

    if (!item) {
      ui.notifications.error("ACE QOL | Could not find spell item for damage roll.");
      return;
    }

    // ── 1. Roll damage dice (with cantrip + upcast scaling) ──
    const damageComponents = await this._rollSpellDamage(item, casterActor, {
      spellLevel: Number.isFinite(spellLevel) ? spellLevel : null,
    });
    const baseDamageTotal = damageComponents.reduce((sum, c) => sum + c.total, 0);

    // Damage info is shown in the results card header — no separate roll message needed

    // ── 3. Build Phase 2 card HTML with full damage data ──
    const cardHtml = this._buildPhase2CardHtml(item, casterActor, allResults, damageComponents, {
      saveAbility, saveDC, halfOnSave, damageTypes,
    });

    // ── 4. Compute damageResults for flag storage ──
    const damageResults = [];
    for (const r of allResults) {
      if (r.pending) continue;
      let targetDamage = 0;
      for (const c of damageComponents) {
        let dmg = Math.floor(c.total * r.damageMultiplier);
        const mod = r.damageModifiers?.[c.type];
        if (mod?.modifier === "immune") dmg = 0;
        else if (mod?.modifier === "resistant") dmg = Math.floor(dmg / 2);
        else if (mod?.modifier === "vulnerable") dmg = dmg * 2;
        targetDamage += dmg;
      }
      damageResults.push({
        targetId: r.actorId,
        tokenDocId: r.tokenDocId,
        sceneId: r.sceneId,
        totalFinal: targetDamage,
        currentHP: r.currentHP,
      });
    }

    // ── 5. Update existing message in one call ──
    await message.update({
      content: cardHtml,
      [`flags.${MODULE_ID}.phase`]: 2,
      [`flags.${MODULE_ID}.baseDamageTotal`]: baseDamageTotal,
      [`flags.${MODULE_ID}.damageComponentTotals`]: damageComponents.map(c => ({ total: c.total, type: c.type, formula: c.formula })),
      [`flags.${MODULE_ID}.damageResults`]: damageResults,
    });

    // ── 6. Auto-delete the AOE template if the spell is instantaneous ──
    await this._deleteInstantTemplate(message.flags?.[MODULE_ID]);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  + TARGET SELECTED — append canvas-selected tokens to an existing save card
  // ═══════════════════════════════════════════════════════════════════════════

  async _addTargetsToCard(message, newTokens) {
    const flags = message.flags?.[MODULE_ID];
    if (!flags) return;
    const item  = await fromUuid(flags.itemUuid) ?? game.items.get(flags.itemId);
    const actor = game.actors.get(flags.actorId);
    if (!item) return;

    // ── Build target data for the new tokens (mirrors _postLiveTargetCard) ──
    const newTargetData = [];
    for (const token of newTokens) {
      const state = CombatState.assess(actor, token, item, {
        saveAbility: flags.saveAbility, isSpell: flags.isSpell, damageTypes: flags.damageTypes,
      });
      if (!state) continue;
      const isPC = token.actor?.hasPlayerOwner ?? false;
      const rawMod = token.actor?.system?.abilities?.[flags.saveAbility]?.save;
      const saveMod = typeof rawMod === "number" ? rawMod
                    : typeof rawMod === "object" ? (rawMod?.value ?? rawMod?.total ?? 0)
                    : Number(rawMod) || 0;
      newTargetData.push({
        tokenId:        token.id,
        tokenDocId:     token.document?.id ?? token.id,
        actorId:        token.actor?.id,
        sceneId:        canvas.scene?.id,
        name:           state.target.name,
        img:            state.target.img,
        isPC,
        saveMod:        saveMod >= 0 ? `+${saveMod}` : `${saveMod}`,
        saveAbilityUpper: flags.saveAbility.toUpperCase(),
        autoFailSave:   state.autoFailSave,
        superSaver:     state.superSaver,
        damageModifiers: state.damageModifiers,
        ownerIds:       isPC ? Object.entries(token.actor?.ownership ?? {})
          .filter(([uid, lvl]) => uid !== "default" && lvl >= 3).map(([uid]) => uid) : null,
      });
    }
    if (!newTargetData.length) return;

    // ── Build damage indicator for color coding ──
    const dmgInd = (t) => {
      const dt = flags.damageTypes;
      if (!t.damageModifiers || !dt?.length) return { cls: "", tag: "" };
      let im=false, re=false, vu=false;
      for (const d of dt) {
        const m = t.damageModifiers[d];
        if (m?.modifier === "immune")     im = true;
        else if (m?.modifier === "resistant")  re = true;
        else if (m?.modifier === "vulnerable") vu = true;
      }
      if (im) return { cls: "ace-qol-tgt-immune", tag: '<span class="ace-qol-tag ace-qol-tag-immune"><i class="fas fa-shield-halved"></i> IMMUNE</span>' };
      if (re) return { cls: "ace-qol-tgt-resist", tag: '<span class="ace-qol-tag ace-qol-tag-resist"><i class="fas fa-shield-halved"></i> RESIST</span>' };
      if (vu) return { cls: "ace-qol-tgt-vuln",   tag: '<span class="ace-qol-tag ace-qol-tag-vuln"><i class="fas fa-burst"></i> VULN</span>' };
      return { cls: "", tag: "" };
    };

    const buildNpcRow = (t) => {
      const di = dmgInd(t);
      return `<div class="ace-qol-save-tgt-row ${di.cls}" data-token-id="${t.tokenId}">
        <img src="${t.img || "icons/svg/mystery-man.svg"}" class="ace-qol-save-tgt-img" />
        <span class="ace-qol-save-tgt-name">${t.name}</span>
        <span class="ace-qol-save-tgt-mod">${t.saveAbilityUpper} ${t.saveMod}</span>
        ${t.autoFailSave ? '<span class="ace-qol-tag ace-qol-tag-danger"><i class="fas fa-circle-xmark"></i> AUTO-FAIL</span>' : ""}
        ${t.superSaver ? '<span class="ace-qol-tag ace-qol-tag-buff"><i class="fas fa-person-running"></i> EVASION</span>' : ""}
        ${di.tag}
        <button class="ace-qol-save-tgt-remove" data-action="aceQolRemoveTarget" data-token-id="${t.tokenId}"><i class="fas fa-xmark"></i></button>
      </div>`;
    };
    const buildPcRow = (t) => {
      const di = dmgInd(t);
      return `<div class="ace-qol-save-tgt-row ace-qol-save-tgt-pc ${di.cls}" data-token-id="${t.tokenId}" data-token-doc-id="${t.tokenDocId}" data-actor-id="${t.actorId}">
        <img src="${t.img || "icons/svg/mystery-man.svg"}" class="ace-qol-save-tgt-img" />
        <span class="ace-qol-save-tgt-name">${t.name}</span>
        <span class="ace-qol-save-tgt-mod">${t.saveAbilityUpper} ${t.saveMod}</span>
        ${t.autoFailSave ? '<span class="ace-qol-tag ace-qol-tag-danger"><i class="fas fa-circle-xmark"></i> AUTO-FAIL</span>' : ""}
        ${t.superSaver ? '<span class="ace-qol-tag ace-qol-tag-buff"><i class="fas fa-person-running"></i> EVASION</span>' : ""}
        ${di.tag}
        <button class="ace-qol-save-pc-roll-btn" data-action="aceQolGmRollPcSave" data-token-doc-id="${t.tokenDocId}" title="Roll save on this PC's behalf (GM)">
          <img src="modules/ace-qol/Assets/Dice%20Dice/BD20/BD20-20_nobg.png" class="ace-qol-save-pc-dice-img" alt="d20" onerror="this.style.display='none';this.nextElementSibling.style.display='inline'" />
          <i class="fas fa-dice-d20" style="display:none"></i>
        </button>
        <button class="ace-qol-save-tgt-remove" data-action="aceQolRemoveTarget" data-token-id="${t.tokenId}" title="Remove this PC from the save list">
          <i class="fas fa-xmark"></i>
        </button>
      </div>`;
    };

    // ── Build the COMPLETE updated targets list (existing minus duplicates + new) ──
    // flags.targets is the authoritative source — reflects any X-removals already done.
    // Rebuilding sections from scratch avoids stale-content bugs where removed targets
    // would resurface because message.content wasn't updated alongside flag changes.
    const existingIds  = new Set((flags.targets ?? []).map(t => t.tokenDocId));
    const dedupedNew   = newTargetData.filter(t => !existingIds.has(t.tokenDocId));
    if (!dedupedNew.length) {
      ui.notifications.info("ACE QOL: All selected tokens are already in the target list.");
      return;
    }
    const updatedTargets = [...(flags.targets ?? []), ...dedupedNew];
    const allNpcs = updatedTargets.filter(t => !t.isPC);
    const allPcs  = updatedTargets.filter(t =>  t.isPC);
    const allNpcRowsHtml = allNpcs.map(buildNpcRow).join("");
    const allPcRowsHtml  = allPcs.map(buildPcRow).join("");

    // ── Replace the section contents in the parsed DOM (don't append to stale HTML) ──
    const parser = new DOMParser();
    const doc = parser.parseFromString(message.content, "text/html");
    const card = doc.querySelector(".ace-qol-save-card");
    if (!card) {
      console.warn(`${MODULE_ID} | Could not find save card to update targets`);
      return;
    }

    const ensureSection = (selector, classes) => {
      let s = card.querySelector(selector);
      if (!s) {
        s = doc.createElement("div");
        s.className = classes;
        const actions = card.querySelector(".ace-qol-save-actions");
        if (actions) actions.before(s); else card.appendChild(s);
      }
      return s;
    };
    // Remove any existing sections so we can rebuild cleanly
    card.querySelectorAll(".ace-qol-save-tgt-section").forEach(s => s.remove());
    if (allNpcRowsHtml) {
      const sec = ensureSection("__missing__", "ace-qol-save-tgt-section");
      sec.innerHTML = allNpcRowsHtml;
    }
    if (allPcRowsHtml) {
      const sec = ensureSection("__missing__", "ace-qol-save-tgt-section ace-qol-save-tgt-section-pc");
      sec.innerHTML = allPcRowsHtml;
    }

    // Update local var for the prompt loop and the success notification
    const newPcs = dedupedNew.filter(t => t.isPC);
    const newNpcs = dedupedNew.filter(t => !t.isPC);

    // ── Persist ──
    await message.update({
      content: card.outerHTML,
      [`flags.${MODULE_ID}.targets`]: updatedTargets,
    });

    // ── Clear any stale pcSaveResults for re-added PCs (so they get a fresh roll) ──
    // Use case: PC was on the list, rolled, X-removed (e.g., user wants to apply a buff),
    // then re-added via TARGET SELECTED — they should be allowed to re-roll.
    for (const tgt of newPcs) {
      try {
        const stale = game.messages.contents.filter(m => {
          const f = m.flags?.[MODULE_ID];
          return f?.type === "pcSaveResult"
              && f.tokenDocId === tgt.tokenDocId
              && f.castId === message.id;
        });
        for (const m of stale) await m.delete();
      } catch (err) {
        console.warn(`${MODULE_ID} | Failed to clear stale pcSaveResult for ${tgt.name}:`, err);
      }
    }

    // ── Send prompts to any new PCs ──
    for (const tgt of newPcs) {
      try {
        await this._sendPcSavePrompt(item, actor, tgt, {
          saveAbility:  flags.saveAbility,
          saveDC:       flags.saveDC,
          halfOnSave:   flags.halfOnSave,
          damageTypes:  flags.damageTypes,
          isSpell:      flags.isSpell,
          castId:       message.id,
        });
      } catch (err) {
        console.warn(`${MODULE_ID} | Failed to send prompt to new PC ${tgt.name}:`, err);
      }
    }

    const npcMsg = newNpcs.length ? ` (${newNpcs.length} NPC${newNpcs.length > 1 ? "s" : ""})` : "";
    const pcMsg  = newPcs.length  ? ` (${newPcs.length} PC${newPcs.length > 1 ? "s" : ""} prompted)` : "";
    ui.notifications.info(`ACE QOL: Added ${newTargetData.length} target${newTargetData.length > 1 ? "s" : ""}${npcMsg}${pcMsg}.`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Auto-delete instant spell templates (Fireball, Lightning Bolt, etc.)
  //  Persistent spells (Fog Cloud, Spirit Guardians) keep their template.
  // ═══════════════════════════════════════════════════════════════════════════

  async _deleteInstantTemplate(flags) {
    try {
      if (!flags) return;
      if (game.settings.get(MODULE_ID, "autoDeleteInstantTemplates") === false) return;
      if (flags.timingType !== TIMING.INSTANT) return;
      const sceneId = flags.templateSceneId;
      const tmplId  = flags.templateDocId;
      if (!sceneId || !tmplId) return;
      const scene = game.scenes.get(sceneId);
      const tmpl  = scene?.templates?.get(tmplId);
      if (!tmpl) return;
      await tmpl.delete();
      console.log(`${MODULE_ID} | Auto-deleted instant template ${tmplId}`);
    } catch (err) {
      console.warn(`${MODULE_ID} | Failed to auto-delete instant template:`, err);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Build Phase 2 Card HTML (extracted from _postSaveResults)
  // ═══════════════════════════════════════════════════════════════════════════

  _buildPhase2CardHtml(item, casterActor, results, damageComponents, opts) {
    const { saveAbility, saveDC, halfOnSave, damageTypes } = opts;
    const abilityLabel = CONFIG.DND5E?.abilities?.[saveAbility]?.label ?? saveAbility.toUpperCase();
    const baseDamageTotal = damageComponents.reduce((sum, c) => sum + c.total, 0);

    // ── Sort: highest save roll first, pending PCs at bottom ──
    const sorted = [...results].sort((a, b) => {
      if (a.pending && !b.pending) return 1;
      if (!a.pending && b.pending) return -1;
      return (b.saveTotal ?? -999) - (a.saveTotal ?? -999);
    });

    // ── Build result rows ──
    const targetRows = sorted.map(r => {
      // PC still pending
      if (r.pending) {
        return `
          <div class="ace-qol-save-result-row ace-qol-save-result-pending" data-token-doc-id="${r.tokenDocId}">
            <div class="ace-qol-save-result-target">
              <img src="${r.img || "icons/svg/mystery-man.svg"}" class="ace-qol-save-tgt-img" />
              <span class="ace-qol-save-tgt-name">${r.name}</span>
              <span class="ace-qol-save-result-label ace-qol-save-pending">\u23f3 Waiting for save...</span>
            </div>
          </div>
        `;
      }

      const passClass = r.passed ? "ace-qol-save-pass" : "ace-qol-save-fail";
      const verdictText = r.passed ? "PASS" : "FAIL";

      // Dice breakdown — same shape as Phase 1 card so GMs can read the
      // d20 result + modifier at a glance.
      let rollDisplay;
      if (r.isAutoFail) {
        rollDisplay = `<span class="ace-qol-save-roll ${passClass}">AUTO</span>`;
      } else if (r.roll) {
        const d20Term = r.roll.dice?.[0] ?? r.roll.terms?.[0];
        const d20Result = d20Term?.total ?? null;
        const modifier = (typeof r.saveTotal === "number" && d20Result != null)
          ? r.saveTotal - d20Result : null;
        if (d20Result != null && modifier != null) {
          const modSign = modifier >= 0 ? "+" : "";
          const modPart = modifier === 0 ? "" : ` ${modSign}${modifier}`;
          rollDisplay = `
            <span class="ace-qol-save-roll-breakdown" style="display:inline-flex;align-items:center;gap:5px;font-family:'Signika',sans-serif;">
              <i class="fas fa-dice-d20" style="color:#d4af37;font-size:13px;"></i>
              <span style="color:#c8b890;font-size:12px;letter-spacing:0.3px;">${d20Result}${modPart} =</span>
              <span class="${passClass}" style="font-weight:700;font-size:14px;">${r.saveTotal}</span>
            </span>`;
        } else {
          rollDisplay = `<span class="ace-qol-save-roll ${passClass}">${r.saveTotal}</span>`;
        }
      } else {
        rollDisplay = `<span class="ace-qol-save-roll ${passClass}">${r.saveTotal}</span>`;
      }

      // ── Calculate per-target damage ──
      let targetDamage = 0;
      const dmgReasons = [];
      const dmgParts = damageComponents.map(c => {
        let dmg = Math.floor(c.total * r.damageMultiplier);
        const mod = r.damageModifiers?.[c.type];
        if (mod?.modifier === "immune") {
          dmg = 0;
          dmgReasons.push(`IMMUNE to ${c.type}`);
        } else if (mod?.modifier === "resistant") {
          dmg = Math.floor(dmg / 2);
          dmgReasons.push(`RESIST ${c.type}`);
        } else if (mod?.modifier === "vulnerable") {
          dmg = dmg * 2;
          dmgReasons.push(`VULN ${c.type}`);
        }
        targetDamage += dmg;
        return dmg;
      });

      const newHP = Math.max(0, r.currentHP - targetDamage);
      const isDead = newHP <= 0;

      // Inline badge for immune/resist/vuln
      const inlineBadge = dmgReasons.length
        ? dmgReasons.map(dr => {
            if (dr.includes("IMMUNE")) return '<span class="ace-qol-save-inline-badge immune">IMMUNE</span>';
            if (dr.includes("RESIST")) return '<span class="ace-qol-save-inline-badge resist">\u00bd</span>';
            if (dr.includes("VULN")) return '<span class="ace-qol-save-inline-badge vuln">\u00d72</span>';
            return "";
          }).join("")
        : "";

      // Determine EFFECTIVE multiplier (save × resist/vuln) for button highlighting
      let effectiveMult = r.damageMultiplier;
      const mods = r.damageModifiers ?? {};
      for (const dtype of Object.keys(mods)) {
        if (mods[dtype]?.modifier === "immune") { effectiveMult = 0; break; }
        if (mods[dtype]?.modifier === "resistant") effectiveMult *= 0.5;
        if (mods[dtype]?.modifier === "vulnerable") effectiveMult *= 2;
      }
      // Snap to nearest button value: 0, 0.25, 0.5, 1, 2
      const snapValues = [0, 0.25, 0.5, 1, 2];
      const dm = snapValues.reduce((prev, curr) => Math.abs(curr - effectiveMult) < Math.abs(prev - effectiveMult) ? curr : prev);
      const _a = (val) => dm === val ? " ace-qol-save-ovr-active" : "";
      const dmgDisplay = targetDamage === 0 ? "0" : targetDamage.toString();

      // Color-code name to match target list (immune=red, resist=yellow, vuln=purple)
      let nameClass = "";
      if (dmgReasons.some(d => d.includes("IMMUNE"))) nameClass = "ace-qol-tgt-immune";
      else if (dmgReasons.some(d => d.includes("VULN"))) nameClass = "ace-qol-tgt-vuln";
      else if (dmgReasons.some(d => d.includes("RESIST"))) nameClass = "ace-qol-tgt-resist";

      // Two-line layout (name on top, formula/verdict below) so long names
      // don't get squished into a vertical "Dea/th/Kni/ght" stack next to
      // the dice readout.
      return `
        <div class="ace-qol-save-result-row ${nameClass}" data-token-doc-id="${r.tokenDocId}"
             style="padding:8px 10px;border-bottom:1px solid rgba(212,175,55,0.15);">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;">
            <img src="${r.img || "icons/svg/mystery-man.svg"}" class="ace-qol-save-tgt-img"
                 style="width:24px;height:24px;border-radius:50%;flex-shrink:0;border:1px solid #444;" />
            <span class="ace-qol-save-tgt-name"
                  style="flex:1;font-weight:bold;color:#fff;font-size:14px;line-height:1.2;">${r.name}</span>
            ${inlineBadge}
          </div>
          <div style="display:flex;justify-content:space-between;align-items:center;padding-left:32px;gap:8px;">
            <span style="flex:1;">${rollDisplay}</span>
            <span class="ace-qol-save-verdict ${passClass}"
                  style="font-weight:bold;font-size:14px;letter-spacing:0.5px;">${verdictText}</span>
          </div>
          <div class="ace-qol-save-ovr-line">
            <button class="ace-qol-save-ovr-x" data-action="aceQolRemoveResult" data-token-doc-id="${r.tokenDocId}">\u00d7</button>
            <button class="ace-qol-save-ovr${_a(0.25)}" data-action="aceQolDmgOverride" data-token-doc-id="${r.tokenDocId}" data-multiplier="0.25">\u00bc</button>
            <button class="ace-qol-save-ovr${_a(0.5)}" data-action="aceQolDmgOverride" data-token-doc-id="${r.tokenDocId}" data-multiplier="0.5">\u00bd</button>
            <button class="ace-qol-save-ovr${_a(1)}" data-action="aceQolDmgOverride" data-token-doc-id="${r.tokenDocId}" data-multiplier="1">1</button>
            <button class="ace-qol-save-ovr${_a(2)}" data-action="aceQolDmgOverride" data-token-doc-id="${r.tokenDocId}" data-multiplier="2">2</button>
            <span class="ace-qol-save-ovr-spacer"></span>
            <span class="ace-qol-save-result-dmg">${dmgDisplay}</span>${isDead ? '<span class="ace-qol-save-skull">\u2620</span>' : '<span class="ace-qol-save-skull" style="display:none">\u2620</span>'}
            <span class="ace-qol-save-result-hp">HP: <span class="ace-qol-hp-cur">${r.currentHP}</span>\u2192<span class="ace-qol-hp-new${isDead ? ' ace-qol-hp-dead' : ''}">${newHP}</span></span>
          </div>
        </div>
      `;
    }).join("");

    // ── Damage summary ──
    const dmgSummary = damageComponents.map(c => {
      const color = DamageConstants.DAMAGE_COLORS[c.type] ?? "#ccc";
      return `<span style="color:${color}">${c.formula} = ${c.total} ${c.type}</span>`;
    }).join(", ");

    return `
      <div class="ace-qol-save-results-card" data-phase="2">
        <div class="ace-qol-save-header">
          <img src="${item.img || "icons/svg/spell.svg"}" class="ace-qol-save-item-img" />
          <div>
            <strong class="ace-qol-save-item-name">${item.name} \u2014 Save Results</strong>
            <span class="ace-qol-save-dc">DC ${saveDC} ${abilityLabel}</span>
          </div>
        </div>
        <div class="ace-qol-save-dmg-summary">Damage: ${dmgSummary}</div>
        <div class="ace-qol-save-results">
          ${targetRows}
        </div>
        <div class="ace-qol-dmg-actions">
          <button class="ace-qol-btn ace-qol-btn-apply" data-action="aceQolApplyDamage">
            <i class="fas fa-heart-crack"></i> APPLY ALL
          </button>
          <button class="ace-qol-btn ace-qol-btn-undo" data-action="aceQolUndoDamage" disabled
            <i class="fas fa-undo"></i> UNDO ALL
          </button>
        </div>
      </div>
    `;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Save Results + Damage Card (Legacy / Direct Post)
  // ═══════════════════════════════════════════════════════════════════════════

  async _postSaveResults(item, casterActor, results, opts, damageComponents) {
    const { saveAbility, saveDC, halfOnSave, damageTypes, spellLevel } = opts;
    const abilityLabel = CONFIG.DND5E?.abilities?.[saveAbility]?.label ?? saveAbility.toUpperCase();

    // If damageComponents not provided, roll them (with cantrip + upcast scaling)
    if (!damageComponents) {
      damageComponents = await this._rollSpellDamage(item, casterActor, {
        spellLevel: Number.isFinite(spellLevel) ? spellLevel : null,
      });
    }

    const baseDamageTotal = damageComponents.reduce((sum, c) => sum + c.total, 0);

    // ── Build result rows ──
    const targetRows = results.map(r => {
      // ── PC still pending ──
      if (r.pending) {
        return `
          <div class="ace-qol-save-result-row ace-qol-save-result-pending" data-token-doc-id="${r.tokenDocId}">
            <div class="ace-qol-save-result-target">
              <img src="${r.img || "icons/svg/mystery-man.svg"}" class="ace-qol-save-tgt-img" />
              <span class="ace-qol-save-tgt-name">${r.name}</span>
              <span class="ace-qol-save-result-label ace-qol-save-pending">\u23f3 Waiting for save...</span>
            </div>
          </div>
        `;
      }

      const passClass = r.passed ? "ace-qol-save-pass" : "ace-qol-save-fail";
      const rollDisplay = r.isAutoFail ? "AUTO" : r.saveTotal;

      // ── Calculate per-target damage with multiplier and resistance checks ──
      let targetDamage = 0;
      const dmgReasons = [];
      const dmgParts = damageComponents.map(c => {
        let dmg = Math.floor(c.total * r.damageMultiplier);
        const mod = r.damageModifiers?.[c.type];
        let modBadge = "";

        if (mod?.modifier === "immune") {
          dmg = 0;
          modBadge = '<span class="ace-qol-dmg-mod ace-qol-dmg-immune">IMMUNE</span>';
          dmgReasons.push(`\ud83d\udee1\ufe0f IMMUNE to ${c.type} \u2014 0 damage`);
        } else if (mod?.modifier === "resistant") {
          dmg = Math.floor(dmg / 2);
          modBadge = '<span class="ace-qol-dmg-mod ace-qol-dmg-resist">\u00bd</span>';
          dmgReasons.push(`\ud83d\udee1\ufe0f RESIST ${c.type} \u2014 halved`);
        } else if (mod?.modifier === "vulnerable") {
          dmg = dmg * 2;
          modBadge = '<span class="ace-qol-dmg-mod ace-qol-dmg-vuln">\u00d72</span>';
          dmgReasons.push(`\u2620\ufe0f VULN ${c.type} \u2014 doubled`);
        }

        targetDamage += dmg;
        const color = DamageConstants.DAMAGE_COLORS[c.type] ?? "#ccc";
        return `<span style="color:${color}">${dmg} ${c.type}</span>${modBadge}`;
      }).join(" ");

      const newHP = Math.max(0, r.currentHP - targetDamage);
      const isDead = newHP <= 0;

      // Store for apply
      r.totalDamage = targetDamage;
      r.newHP = newHP;

      // ── Build reason line ──
      let reasonText;
      if (r.isAutoFail) {
        reasonText = `<span class="ace-qol-save-fail">AUTO-FAIL (condition)</span>`;
      } else if (r.passed && r.resultLabel.includes("EVASION")) {
        reasonText = `<span class="ace-qol-save-pass">EVASION \u2014 SAVED \u2014 0 damage</span>`;
      } else if (r.passed) {
        reasonText = `<span class="ace-qol-save-pass">Rolled ${r.saveTotal} \u2014 SAVED (DC ${saveDC})</span>`;
      } else if (r.resultLabel.includes("EVASION")) {
        reasonText = `<span class="ace-qol-save-fail">Rolled ${r.saveTotal} \u2014 FAILED (DC ${saveDC}) \u2014 EVASION: half</span>`;
      } else {
        reasonText = `<span class="ace-qol-save-fail">Rolled ${r.saveTotal} \u2014 FAILED (DC ${saveDC})</span>`;
      }

      // Add resistance/immunity/vulnerability reasons
      const modReasonHtml = dmgReasons.length
        ? dmgReasons.map(dr => `<div class="ace-qol-save-mod-reason">${dr}</div>`).join("")
        : "";

      // Inline badge for immune/resist/vuln
      const inlineBadge = dmgReasons.length
        ? dmgReasons.map(dr => {
            if (dr.includes("IMMUNE")) return '<span class="ace-qol-save-inline-badge immune">IMMUNE</span>';
            if (dr.includes("RESIST")) return '<span class="ace-qol-save-inline-badge resist">½</span>';
            if (dr.includes("VULN")) return '<span class="ace-qol-save-inline-badge vuln">×2</span>';
            return "";
          }).join("")
        : "";

      const verdictText = r.passed ? "PASS" : "FAIL";

      // Determine EFFECTIVE multiplier (save × resist/vuln) for button highlighting
      let effectiveMult = r.damageMultiplier;
      const mods = r.damageModifiers ?? {};
      for (const dtype of Object.keys(mods)) {
        if (mods[dtype]?.modifier === "immune") { effectiveMult = 0; break; }
        if (mods[dtype]?.modifier === "resistant") effectiveMult *= 0.5;
        if (mods[dtype]?.modifier === "vulnerable") effectiveMult *= 2;
      }
      // Snap to nearest button value: 0, 0.25, 0.5, 1, 2
      const snapValues = [0, 0.25, 0.5, 1, 2];
      const dm = snapValues.reduce((prev, curr) => Math.abs(curr - effectiveMult) < Math.abs(prev - effectiveMult) ? curr : prev);
      const _a = (val) => dm === val ? " ace-qol-save-ovr-active" : "";
      const dmgDisplay = targetDamage === 0 ? "0" : targetDamage.toString();

      // Color-code name to match target list (immune=red, resist=yellow, vuln=purple)
      let nameClass = "";
      if (dmgReasons.some(d => d.includes("IMMUNE"))) nameClass = "ace-qol-tgt-immune";
      else if (dmgReasons.some(d => d.includes("VULN"))) nameClass = "ace-qol-tgt-vuln";
      else if (dmgReasons.some(d => d.includes("RESIST"))) nameClass = "ace-qol-tgt-resist";

      // Two-line layout (name on top, formula/verdict below) so long names
      // don't get squished into a vertical "Dea/th/Kni/ght" stack next to
      // the dice readout.
      return `
        <div class="ace-qol-save-result-row ${nameClass}" data-token-doc-id="${r.tokenDocId}"
             style="padding:8px 10px;border-bottom:1px solid rgba(212,175,55,0.15);">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;">
            <img src="${r.img || "icons/svg/mystery-man.svg"}" class="ace-qol-save-tgt-img"
                 style="width:24px;height:24px;border-radius:50%;flex-shrink:0;border:1px solid #444;" />
            <span class="ace-qol-save-tgt-name"
                  style="flex:1;font-weight:bold;color:#fff;font-size:14px;line-height:1.2;">${r.name}</span>
            ${inlineBadge}
          </div>
          <div style="display:flex;justify-content:space-between;align-items:center;padding-left:32px;gap:8px;">
            <span style="flex:1;">${rollDisplay}</span>
            <span class="ace-qol-save-verdict ${passClass}"
                  style="font-weight:bold;font-size:14px;letter-spacing:0.5px;">${verdictText}</span>
          </div>
          <div class="ace-qol-save-ovr-line">
            <button class="ace-qol-save-ovr-x" data-action="aceQolRemoveResult" data-token-doc-id="${r.tokenDocId}">\u00d7</button>
            <button class="ace-qol-save-ovr${_a(0.25)}" data-action="aceQolDmgOverride" data-token-doc-id="${r.tokenDocId}" data-multiplier="0.25">\u00bc</button>
            <button class="ace-qol-save-ovr${_a(0.5)}" data-action="aceQolDmgOverride" data-token-doc-id="${r.tokenDocId}" data-multiplier="0.5">\u00bd</button>
            <button class="ace-qol-save-ovr${_a(1)}" data-action="aceQolDmgOverride" data-token-doc-id="${r.tokenDocId}" data-multiplier="1">1</button>
            <button class="ace-qol-save-ovr${_a(2)}" data-action="aceQolDmgOverride" data-token-doc-id="${r.tokenDocId}" data-multiplier="2">2</button>
            <span class="ace-qol-save-ovr-spacer"></span>
            <span class="ace-qol-save-result-dmg">${dmgDisplay}</span>${isDead ? '<span class="ace-qol-save-skull">\u2620</span>' : '<span class="ace-qol-save-skull" style="display:none">\u2620</span>'}
            <span class="ace-qol-save-result-hp">HP: <span class="ace-qol-hp-cur">${r.currentHP}</span>\u2192<span class="ace-qol-hp-new${isDead ? ' ace-qol-hp-dead' : ''}">${newHP}</span></span>
          </div>
        </div>
      `;
    }).join("");

    // ── Damage rolled summary ──
    const dmgSummary = damageComponents.map(c => {
      const color = DamageConstants.DAMAGE_COLORS[c.type] ?? "#ccc";
      return `<span style="color:${color}">${c.formula} = ${c.total} ${c.type}</span>`;
    }).join(", ");

    const cardHtml = `
      <div class="ace-qol-save-results-card">
        <div class="ace-qol-save-header">
          <img src="${item.img || "icons/svg/spell.svg"}" class="ace-qol-save-item-img" />
          <div>
            <strong class="ace-qol-save-item-name">${item.name} \u2014 Save Results</strong>
            <span class="ace-qol-save-dc">DC ${saveDC} ${abilityLabel}</span>
          </div>
        </div>
        <div class="ace-qol-save-dmg-summary">Damage: ${dmgSummary}</div>
        <div class="ace-qol-save-results">
          ${targetRows}
        </div>
        <div class="ace-qol-dmg-actions">
          <button class="ace-qol-btn ace-qol-btn-apply" data-action="aceQolApplyDamage">
            <i class="fas fa-heart-crack"></i> APPLY ALL
          </button>
          <button class="ace-qol-btn ace-qol-btn-undo" data-action="aceQolUndoDamage" disabled
            <i class="fas fa-undo"></i> UNDO ALL
          </button>
        </div>
      </div>
    `;

    await ChatMessage.create({
      content: cardHtml,
      speaker: ChatMessage.getSpeaker({ actor: casterActor }),
      whisper: [game.user.id],
      flags: {
        [MODULE_ID]: {
          type: "saveResults",
          phase: 2,
          itemId: item.id,
          itemUuid: item.uuid,
          actorId: casterActor?.id,
          saveAbility,
          saveDC,
          halfOnSave,
          damageResults: results.filter(r => !r.pending).map(r => ({
            targetId: r.actorId,
            tokenDocId: r.tokenDocId,
            sceneId: r.sceneId,
            totalFinal: r.totalDamage,
            currentHP: r.currentHP,
          })),
          // Store base damage for override recalculation
          baseDamageTotal,
          damageComponentTotals: damageComponents.map(c => ({ total: c.total, type: c.type, formula: c.formula })),
        }
      }
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Manual Damage Override (x0, x1/2, x1, x2 per row)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Update a single row's damage + HP display in the DOM. No flag writes.
   * @param {HTMLElement} rowElement  The .ace-qol-save-result-row element
   * @param {string} tokenDocId
   * @param {number} multiplier
   * @param {object} flags  The message's MODULE_ID flags (read-only)
   */
  _updateRowDamageDisplay(rowElement, tokenDocId, multiplier, flags) {
    const results = flags.damageResults ?? [];
    const result = results.find(r => r.tokenDocId === tokenDocId);
    if (!result) return;

    const baseDmg = flags.baseDamageTotal ?? 0;
    const newDamage = Math.floor(baseDmg * multiplier);
    const currentHP = result.currentHP ?? 0;

    const dmgSpan = rowElement.querySelector(".ace-qol-save-result-dmg");
    if (dmgSpan) {
      dmgSpan.textContent = newDamage.toString();
      const skullSpan = rowElement.querySelector(".ace-qol-save-skull");
      if (skullSpan) skullSpan.style.display = (Math.max(0, currentHP - newDamage) <= 0) ? "" : "none";
    }

    const hpSpan = rowElement.querySelector(".ace-qol-save-result-hp");
    if (hpSpan) {
      const newHP = Math.max(0, currentHP - newDamage);
      const deadClass = newHP <= 0 ? " ace-qol-hp-dead" : "";
      hpSpan.innerHTML = `HP: ${currentHP}\u2192<span class="ace-qol-hp-new${deadClass}">${newHP}</span>`;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Apply All Save Damage
  // ═══════════════════════════════════════════════════════════════════════════

  async _applyAllSaveDamage(message) {
    const flags = message.flags?.[MODULE_ID];
    if (!flags?.damageResults?.length) return;

    const baseDmg = flags.baseDamageTotal ?? 0;

    for (const r of flags.damageResults) {
      const scene = game.scenes.get(r.sceneId) ?? canvas.scene;
      const tokenDoc = scene?.tokens?.get(r.tokenDocId);
      const actor = tokenDoc?.actor ?? game.actors.get(r.targetId);
      if (!actor) continue;

      // Check override cache for this target
      const cacheKey = `${message.id}|${r.tokenDocId}`;
      const cachedValue = SaveEngine.overrideCache.get(cacheKey);

      // Skip removed targets
      if (cachedValue === "removed") {
        SaveEngine.overrideCache.delete(cacheKey);
        continue;
      }

      const damageToApply = (typeof cachedValue === "number")
        ? Math.floor(baseDmg * cachedValue)
        : (r.totalFinal ?? 0);

      // Single source of truth — handles polymorph excess capture + clamp
      await DamageApplicator.applyHPDamage(actor, damageToApply, { label: "save-apply-all" });

      // Clear cache entry after applying
      SaveEngine.overrideCache.delete(cacheKey);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Undo All Save Damage
  // ═══════════════════════════════════════════════════════════════════════════

  async _undoAllSaveDamage(message) {
    const flags = message.flags?.[MODULE_ID];
    if (!flags?.damageResults?.length) return;

    for (const r of flags.damageResults) {
      const scene = game.scenes.get(r.sceneId) ?? canvas.scene;
      const tokenDoc = scene?.tokens?.get(r.tokenDocId);
      const actor = tokenDoc?.actor ?? game.actors.get(r.targetId);
      if (!actor) continue;

      // Restore to HP they had before damage was applied
      const restoredHP = r.currentHP ?? actor.system?.attributes?.hp?.value ?? 0;
      await actor.update({ "system.attributes.hp.value": restoredHP });
    }
  }
}
