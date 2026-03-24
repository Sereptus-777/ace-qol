// ============================================================
// ACE QOL — Concentration Widget
// Floating persistent card for concentration AoE spells
// (Moonbeam, Spirit Guardians, Cloudkill, etc.)
//
// Listens for persistent spell creation, then:
//   - Renders a floating card with spell info + current targets
//   - Tracks template movement and re-targets
//   - Detects turn changes for start/end-of-turn triggers
//   - Auto-dismisses when concentration breaks
// ============================================================

// NOTE: MODULE_ID hardcoded to avoid circular import (ace-qol.mjs imports us)
const MODULE_ID = "ace-qol";
import { TIMING } from "./spell-timing.mjs";

const TAG = `${MODULE_ID} | ConcWidget`;

export class ConcentrationWidget {

  constructor(saveEngine) {
    this._saveEngine = saveEngine;
    /** @type {Map<string, SpellTracker>} templateId → spell tracking data */
    this._activeSpells = new Map();
    this._container = null;
    this._registerHooks();
  }

  // ═══════════════════════════════════════════════════════════════
  //  Hook Registration
  // ═══════════════════════════════════════════════════════════════

  _registerHooks() {
    // Listen for persistent spells created by SaveEngine
    Hooks.on("ace-qol.persistentSpellCreated", (data) => {
      this._onPersistentSpellCreated(data);
    });

    // Template moved — re-target
    Hooks.on("updateMeasuredTemplate", (templateDoc, changes, opts, userId) => {
      if (changes.x !== undefined || changes.y !== undefined ||
          changes.direction !== undefined || changes.distance !== undefined) {
        this._onTemplateMove(templateDoc);
      }
    });

    // Template deleted — remove widget
    Hooks.on("deleteMeasuredTemplate", (templateDoc, opts, userId) => {
      this._onTemplateDeleted(templateDoc.id);
    });

    // Turn change in combat — check for start/end-of-turn triggers
    Hooks.on("updateCombat", (combat, changes, opts, userId) => {
      if (changes.turn !== undefined || changes.round !== undefined) {
        this._onTurnChange(combat, changes);
      }
    });

    // Concentration broken — active effect removed
    Hooks.on("deleteActiveEffect", (effect, opts, userId) => {
      this._onEffectRemoved(effect);
    });

    // Also check for the "concentrating" status being removed
    Hooks.on("updateActiveEffect", (effect, changes, opts, userId) => {
      if (changes.disabled === true) {
        this._onEffectRemoved(effect);
      }
    });

    console.log(`${TAG} | Hooks registered`);
  }

  // ═══════════════════════════════════════════════════════════════
  //  Persistent Spell Registration
  // ═══════════════════════════════════════════════════════════════

  _onPersistentSpellCreated(data) {
    const { item, actor, templateDoc, timing, saveAbility, saveDC,
            halfOnSave, damageTypes, tokens } = data;

    if (!templateDoc?.id) {
      console.warn(`${TAG} | No template for persistent spell "${item?.name}"`);
      return;
    }

    const tracker = {
      templateId: templateDoc.id,
      templateDoc,
      item,
      actor,
      timing,
      saveAbility,
      saveDC,
      halfOnSave,
      damageTypes,
      tokens: tokens ?? [],
      createdAt: Date.now(),
    };

    this._activeSpells.set(templateDoc.id, tracker);
    console.log(`${TAG} | Registered persistent spell: ${item.name} (${timing.timing}) with ${tracker.tokens.length} initial targets`);

    this._renderWidgets();

    // If timing includes "enter", tokens already in the area might need to save
    // (Depends on interpretation — some GMs say "enter" means voluntarily move in)
    // We'll let the GM trigger this manually via INFLICT DAMAGE
  }

  // ═══════════════════════════════════════════════════════════════
  //  Template Movement — Re-target
  // ═══════════════════════════════════════════════════════════════

  _onTemplateMove(templateDoc) {
    const tracker = this._activeSpells.get(templateDoc.id);
    if (!tracker) return;

    // Update the template reference
    tracker.templateDoc = templateDoc;

    // Re-calculate tokens inside the template
    const newTokens = this._saveEngine.constructor._getTokensInTemplate?.(templateDoc) ?? [];
    const oldIds = new Set(tracker.tokens.map(t => t.id));
    const newIds = new Set(newTokens.map(t => t.id));

    // Find newly entered tokens
    const entered = newTokens.filter(t => !oldIds.has(t.id));
    const exited = tracker.tokens.filter(t => !newIds.has(t.id));

    tracker.tokens = newTokens;

    if (entered.length > 0) {
      console.log(`${TAG} | ${entered.length} token(s) entered ${tracker.item.name} template`);
      // If timing includes "enter", these tokens should save
      if (tracker.timing.timing.includes("enter")) {
        ui.notifications.info(`${MODULE_ID} | ${entered.map(t => t.name).join(", ")} entered ${tracker.item.name} — save required!`);
      }
    }
    if (exited.length > 0) {
      console.log(`${TAG} | ${exited.length} token(s) exited ${tracker.item.name} template`);
    }

    this._renderWidgets();
  }

  // ═══════════════════════════════════════════════════════════════
  //  Template Deleted — Remove Widget
  // ═══════════════════════════════════════════════════════════════

  _onTemplateDeleted(templateId) {
    if (!this._activeSpells.has(templateId)) return;
    const tracker = this._activeSpells.get(templateId);
    console.log(`${TAG} | Template deleted for ${tracker.item?.name} — removing widget`);
    this._activeSpells.delete(templateId);
    this._renderWidgets();
  }

  // ═══════════════════════════════════════════════════════════════
  //  Turn Change — Check Triggers
  // ═══════════════════════════════════════════════════════════════

  _onTurnChange(combat, changes) {
    if (!this._activeSpells.size) return;

    // Who just started their turn?
    const currentCombatant = combat.combatant;
    const currentToken = currentCombatant?.token;

    // Who just ended their turn? (previous combatant)
    const turns = combat.turns ?? [];
    const currentIdx = combat.turn ?? 0;
    const prevIdx = currentIdx - 1;
    const prevCombatant = prevIdx >= 0
      ? turns[prevIdx]
      : turns[turns.length - 1]; // wrapped from previous round
    const prevToken = prevCombatant?.token;

    for (const [templateId, tracker] of this._activeSpells) {
      const timing = tracker.timing.timing;
      const tokenIds = new Set(tracker.tokens.map(t => t.id));

      // Start-of-turn check
      if (timing.includes("startOfTurn") || timing.includes("enter+startOfTurn")) {
        if (currentToken && tokenIds.has(currentToken.id)) {
          console.log(`${TAG} | ${currentToken.name} starts turn in ${tracker.item.name}`);
          ui.notifications.info(`${tracker.item.name}: ${currentToken.name} starts turn in area — save required!`);
          // Post a single-target save prompt
          this._triggerSaveForToken(tracker, currentToken);
        }
      }

      // End-of-turn check
      if (timing.includes("endOfTurn") || timing.includes("enter+endOfTurn")) {
        if (prevToken && tokenIds.has(prevToken.id)) {
          console.log(`${TAG} | ${prevToken.name} ends turn in ${tracker.item.name}`);
          ui.notifications.info(`${tracker.item.name}: ${prevToken.name} ends turn in area — save required!`);
          this._triggerSaveForToken(tracker, prevToken);
        }
      }
    }
  }

  /**
   * Trigger a save prompt for a single token inside a persistent spell.
   * Posts a save card to the GM chat for that one creature.
   */
  async _triggerSaveForToken(tracker, tokenDoc) {
    // Resolve the actual token placeable
    const token = canvas.tokens.get(tokenDoc.id) ?? canvas.tokens.placeables.find(t => t.document.id === tokenDoc.id);
    if (!token) return;

    // Use the SaveEngine to post a save prompt for this single target
    // We simulate the same flow as the batch save but with one target
    if (this._saveEngine?._postSaveCardForTargets) {
      await this._saveEngine._postSaveCardForTargets(tracker.item, tracker.actor, [token], {
        saveAbility: tracker.saveAbility,
        saveDC: tracker.saveDC,
        halfOnSave: tracker.halfOnSave,
        damageTypes: tracker.damageTypes,
        isSpell: true,
        isPersistent: true,
        templateId: tracker.templateId,
      });
    }
  }

  // ═══════════════════════════════════════════════════════════════
  //  Concentration Break — Cleanup
  // ═══════════════════════════════════════════════════════════════

  _onEffectRemoved(effect) {
    // Check if this is a concentration effect
    const statusId = effect.statuses?.first?.() ?? effect.flags?.core?.statusId ?? "";
    const isConcentrating = statusId === "concentrating"
                         || (effect.name ?? "").toLowerCase().includes("concentrating");

    if (!isConcentrating) return;

    const actor = effect.parent;
    if (!actor) return;

    // Find any active spells cast by this actor
    for (const [templateId, tracker] of this._activeSpells) {
      if (tracker.actor?.id === actor.id) {
        console.log(`${TAG} | ${actor.name} lost concentration on ${tracker.item?.name} — removing widget`);
        ui.notifications.info(`${tracker.item?.name}: Concentration broken by ${actor.name}`);
        this._activeSpells.delete(templateId);

        // Optionally remove the template from canvas
        try {
          const template = canvas.scene.templates.get(templateId);
          if (template) {
            template.delete();
          }
        } catch (err) {
          console.warn(`${TAG} | Failed to delete template:`, err);
        }
      }
    }

    this._renderWidgets();
  }

  // ═══════════════════════════════════════════════════════════════
  //  Widget Rendering
  // ═══════════════════════════════════════════════════════════════

  _ensureContainer() {
    if (this._container && document.body.contains(this._container)) return;
    this._container = document.createElement("div");
    this._container.id = "ace-qol-concentration-widgets";
    this._container.style.cssText = `
      position: fixed; bottom: 80px; right: 16px; z-index: 100;
      display: flex; flex-direction: column; gap: 8px;
      pointer-events: auto; max-height: 60vh; overflow-y: auto;
    `;
    document.body.appendChild(this._container);
  }

  _renderWidgets() {
    if (!this._activeSpells.size) {
      if (this._container) {
        this._container.remove();
        this._container = null;
      }
      return;
    }

    this._ensureContainer();
    this._container.innerHTML = "";

    for (const [templateId, tracker] of this._activeSpells) {
      const card = this._buildWidgetCard(tracker);
      this._container.appendChild(card);
    }
  }

  _buildWidgetCard(tracker) {
    const div = document.createElement("div");
    div.className = "ace-qol-conc-widget";
    div.dataset.templateId = tracker.templateId;

    const timingLabel = tracker.timing.timing.replace(/\+/g, " + ").replace(/([A-Z])/g, " $1").trim();

    // Target list
    const targetRows = tracker.tokens.map(t => {
      const actor = t.actor;
      const saveMod = actor?.system?.abilities?.[tracker.saveAbility]?.save ?? 0;
      const modSign = saveMod >= 0 ? "+" : "";
      return `
        <div class="ace-qol-conc-tgt-row">
          <img src="${actor?.img || t.document?.texture?.src || 'icons/svg/mystery-man.svg'}" class="ace-qol-save-tgt-img" />
          <span class="ace-qol-save-tgt-name">${t.name || actor?.name || "Unknown"}</span>
          <span class="ace-qol-save-tgt-mod">${tracker.saveAbility.toUpperCase()} ${modSign}${saveMod}</span>
        </div>
      `;
    }).join("") || '<div class="ace-qol-conc-empty">No targets in area</div>';

    div.innerHTML = `
      <div class="ace-qol-conc-header">
        <img src="${tracker.item?.img || 'icons/svg/spell.svg'}" class="ace-qol-conc-spell-img" />
        <div class="ace-qol-conc-info">
          <strong>${tracker.item?.name || "Unknown Spell"}</strong>
          <span class="ace-qol-conc-dc">DC ${tracker.saveDC} ${(tracker.saveAbility || "").toUpperCase()}</span>
        </div>
        <button class="ace-qol-conc-dismiss" title="Dismiss widget">
          <i class="fas fa-xmark"></i>
        </button>
      </div>
      <div class="ace-qol-conc-timing">
        <i class="fas fa-clock"></i> ${timingLabel}
        ${tracker.halfOnSave ? ' <span class="ace-qol-save-half-badge">HALF ON SAVE</span>' : ''}
      </div>
      <div class="ace-qol-conc-targets">
        ${targetRows}
      </div>
      <div class="ace-qol-conc-actions">
        <button class="ace-qol-btn ace-qol-btn-inflict" data-template-id="${tracker.templateId}">
          <i class="fas fa-bolt"></i> INFLICT DAMAGE
        </button>
      </div>
    `;

    // Wire dismiss button
    div.querySelector(".ace-qol-conc-dismiss")?.addEventListener("click", () => {
      this._activeSpells.delete(tracker.templateId);
      this._renderWidgets();
    });

    // Wire inflict damage button
    div.querySelector(".ace-qol-btn-inflict")?.addEventListener("click", async () => {
      if (!tracker.tokens.length) {
        ui.notifications.warn("No targets in the template area.");
        return;
      }
      await this._triggerBatchSave(tracker);
    });

    return div;
  }

  /**
   * Trigger a batch save for all tokens currently in the persistent spell's template.
   */
  async _triggerBatchSave(tracker) {
    if (this._saveEngine?._postSaveCardForTargets) {
      await this._saveEngine._postSaveCardForTargets(tracker.item, tracker.actor, tracker.tokens, {
        saveAbility: tracker.saveAbility,
        saveDC: tracker.saveDC,
        halfOnSave: tracker.halfOnSave,
        damageTypes: tracker.damageTypes,
        isSpell: true,
        isPersistent: true,
        templateId: tracker.templateId,
      });
    }
  }

  // ═══════════════════════════════════════════════════════════════
  //  Public API
  // ═══════════════════════════════════════════════════════════════

  /** Get all active persistent spells. */
  getActiveSpells() {
    return [...this._activeSpells.values()];
  }

  /** Check if a template has an active spell. */
  hasActiveSpell(templateId) {
    return this._activeSpells.has(templateId);
  }

  /** Manually dismiss all widgets. */
  dismissAll() {
    this._activeSpells.clear();
    this._renderWidgets();
  }
}
