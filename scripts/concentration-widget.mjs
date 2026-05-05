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
import { QolSettings } from "./settings.mjs";

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

    // v0.6.0 — Token movement triggers Phase 1 entry detection +
    // Phase 2 movement-distance damage for persistent templates.
    //
    // We use BOTH preUpdateToken (to capture old position) and
    // updateToken (to react after the move). The hook fires AFTER the
    // document has its new position applied, so we need to stash the
    // pre-move coords during preUpdateToken to compute the move vector.
    if (!this._preMovePositions) this._preMovePositions = new Map();

    Hooks.on("preUpdateToken", (tokenDoc, changes, opts, userId) => {
      if (!game.user.isGM) return;
      if (changes.x === undefined && changes.y === undefined) return;
      this._preMovePositions.set(tokenDoc.id, {
        x: tokenDoc.x,
        y: tokenDoc.y,
      });
    });

    Hooks.on("updateToken", (tokenDoc, changes, opts, userId) => {
      if (!game.user.isGM) return;
      if (changes.x === undefined && changes.y === undefined) return;
      const pre = this._preMovePositions.get(tokenDoc.id);
      this._preMovePositions.delete(tokenDoc.id);
      const oldX = pre?.x ?? tokenDoc.x;
      const oldY = pre?.y ?? tokenDoc.y;
      const newX = tokenDoc.x;
      const newY = tokenDoc.y;
      // Defer to next tick so the token document is fully updated
      setTimeout(() => {
        this._onTokenMoved(tokenDoc, { oldX, oldY, newX, newY });
      }, 0);
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
    // v0.4.22.10: GM-only gate. The body of this function calls
    // `_triggerSaveForToken` which posts save cards via the SaveEngine.
    // Without this guard, every player client would post their own save
    // card on every relevant turn change — N players in a session would
    // produce N duplicate save cards. The hook fires on every client
    // because Foundry's `updateCombat` hook is broadcast.
    if (!game.user.isGM) return;
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
    // v0.4.22.10: Defense-in-depth GM gate. `_onTurnChange` already gates,
    // but if any future caller invokes this directly we still want only
    // the GM client to post the save card.
    if (!game.user.isGM) return;

    // Resolve the actual token placeable
    const token = canvas.tokens.get(tokenDoc.id) ?? canvas.tokens.placeables.find(t => t.document.id === tokenDoc.id);
    if (!token) return;

    // v0.6.0: Use the SaveEngine's public `postSaveCard` API (was calling
    // a non-existent `_postSaveCardForTargets` method, so the INFLICT
    // DAMAGE button silently did nothing). Fallback to the underscore
    // method if running against an older save engine without the alias.
    const post = this._saveEngine?.postSaveCard?.bind(this._saveEngine)
              ?? this._saveEngine?._postLiveTargetCard?.bind(this._saveEngine);
    if (typeof post === "function") {
      await post(tracker.item, tracker.actor, [token], {
        saveAbility: tracker.saveAbility,
        saveDC: tracker.saveDC,
        halfOnSave: tracker.halfOnSave,
        damageTypes: tracker.damageTypes,
        isSpell: true,
        isPersistent: true,
        templateId: tracker.templateId,
      });
    } else {
      console.warn(`${TAG} | save engine has neither postSaveCard nor _postLiveTargetCard — INFLICT DAMAGE failed for ${tracker.item?.name}`);
    }
  }

  // ═══════════════════════════════════════════════════════════════
  //  Concentration Break — Cleanup
  // ═══════════════════════════════════════════════════════════════
  //  v0.6.0 — Phase 1 + 2 Token Movement Handlers
  // ═══════════════════════════════════════════════════════════════

  /**
   * Called after a token finishes moving. For each tracked persistent
   * template, decides whether to fire the entry trigger (Phase 1 — token
   * crossed into the area) or the movement-distance damage trigger
   * (Phase 2 — token moved within / through Spike Growth-style area).
   *
   * @param {TokenDocument} tokenDoc
   * @param {{oldX, oldY, newX, newY}} positions  Pre/post move coords.
   */
  async _onTokenMoved(tokenDoc, positions) {
    if (!this._activeSpells.size) return;

    const token = canvas.tokens.get(tokenDoc.id)
               ?? canvas.tokens.placeables.find(t => t.document.id === tokenDoc.id);
    if (!token) return;

    for (const [templateId, tracker] of this._activeSpells) {
      const template = canvas.scene.templates.get(templateId)?.object;
      if (!template) continue;

      const wasInside = !!tracker.tokensInside?.has?.(tokenDoc.id);
      const isInside  = this._tokenInsideTemplate(token, template, positions);
      if (!tracker.tokensInside) tracker.tokensInside = new Set();

      // ── Phase 2: Spike Growth-style movement damage ──
      // Spells with damage but NO save are continuous — apply per 5ft
      // of movement traversed inside the template area.
      const isMovementDamage = !tracker.saveAbility && !!tracker.damageTypes?.length;
      if (isMovementDamage) {
        const ft = this._distanceMovedInsideTemplate(template, positions);
        if (ft > 0) {
          await this._applyMovementDamage(tracker, token, ft);
        }
        // Movement-damage spells don't use the entry trigger flow
      }

      // ── Phase 1: Save on entry (Moonbeam, Wall of Fire, etc.) ──
      if (!isMovementDamage) {
        if (isInside && !wasInside) {
          tracker.tokensInside.add(tokenDoc.id);
          await this._onTokenEnteredTemplate(tracker, token);
        } else if (!isInside && wasInside) {
          tracker.tokensInside.delete(tokenDoc.id);
        } else if (isInside) {
          // Already inside, still inside — keep tracker fresh
          tracker.tokensInside.add(tokenDoc.id);
        }
      }
    }
  }

  /**
   * Whether a token's CENTER point is currently inside a measured-template
   * polygon. Uses the placeable's hit-test if available, falls back to a
   * shape-bounds + polygon intersection check.
   *
   * `positions` is the pre/post move coord pair — we use the post-move
   * (new) center for "currently inside" determination.
   */
  _tokenInsideTemplate(token, template, positions) {
    if (!token || !template) return false;
    const tokenDoc = token.document;
    const w = (Number(tokenDoc.width)  > 0) ? Number(tokenDoc.width)  : 1;
    const h = (Number(tokenDoc.height) > 0) ? Number(tokenDoc.height) : 1;
    const gridSize = canvas.grid?.size ?? 100;
    const cx = positions.newX + (w * gridSize) / 2;
    const cy = positions.newY + (h * gridSize) / 2;

    // Foundry V13 MeasuredTemplate has a `shape` property (a PIXI polygon)
    // and inherits PlaceableObject's `bounds` + custom hit testing.
    if (typeof template.shape?.contains === "function") {
      const localX = cx - template.x;
      const localY = cy - template.y;
      return template.shape.contains(localX, localY);
    }
    if (typeof template.containsPoint === "function") {
      return template.containsPoint({ x: cx, y: cy });
    }
    // Fallback — bounds-only check (works for circles approximately)
    const b = template.bounds;
    if (!b) return false;
    return cx >= b.x && cx <= b.x + b.width
        && cy >= b.y && cy <= b.y + b.height;
  }

  /**
   * For Phase 2 (Spike Growth, Wall of Thorns) — measure how many feet of
   * the token's move-vector lay INSIDE the template's polygon. Uses
   * Foundry's grid distance scale (typically 5 ft per cell). Returns 0 if
   * no portion of the movement passed through the template.
   */
  _distanceMovedInsideTemplate(template, positions) {
    if (!template || !positions) return 0;
    const tokenDoc = canvas.tokens.placeables.find(t => true)?.document; // unused
    // Use token-center start/end for the move ray
    // (caller-supplied positions are token-origin; we approximate with origin
    // since we don't know token size at this point in the helper. The result
    // is stable across the full token because we're measuring a line, not
    // a swept area.)
    const start = { x: positions.oldX, y: positions.oldY };
    const end   = { x: positions.newX, y: positions.newY };

    // Sample the segment at fine increments and count how many samples
    // landed inside the template. Convert sample count → distance.
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const segPx = Math.hypot(dx, dy);
    if (segPx < 1) return 0;
    const gridSize    = canvas.grid?.size ?? 100;
    const ftPerSquare = canvas.scene?.grid?.distance ?? 5;
    const samplesPerCell = 6;
    const sampleCount = Math.max(2, Math.ceil((segPx / gridSize) * samplesPerCell));
    let insideSamples = 0;
    for (let i = 0; i <= sampleCount; i++) {
      const t = i / sampleCount;
      const x = start.x + dx * t;
      const y = start.y + dy * t;
      let inside = false;
      if (typeof template.shape?.contains === "function") {
        inside = template.shape.contains(x - template.x, y - template.y);
      } else if (typeof template.containsPoint === "function") {
        inside = template.containsPoint({ x, y });
      }
      if (inside) insideSamples += 1;
    }
    if (insideSamples === 0) return 0;
    const fracInside = insideSamples / (sampleCount + 1);
    const totalFt = (segPx / gridSize) * ftPerSquare;
    return totalFt * fracInside;
  }

  /**
   * Phase 1 entry trigger. Routes to NPC auto-save flow vs PC save-prompt
   * flow based on token ownership.
   */
  async _onTokenEnteredTemplate(tracker, token) {
    const isPC = !!token.actor?.hasPlayerOwner;
    console.log(`${TAG} | ${token.name} entered ${tracker.item?.name} (${isPC ? "PC" : "NPC"})`);
    // Reuse the SaveEngine's postSaveCard flow for both NPCs and PCs —
    // it already handles the NPC-fast-path single-target auto-roll
    // pathway internally, and the PC-prompt whisper-+-collapse rendering.
    await this._triggerSaveForToken(tracker, token.document);
  }

  /**
   * Phase 2 movement damage (Spike Growth, Wall of Thorns). Roll the
   * spell's damage formula scaled by feet traversed (e.g. Spike Growth
   * is `2d4` per 5ft; ft / 5 = number of "tickets" of damage to roll).
   */
  async _applyMovementDamage(tracker, token, ftMoved) {
    const ftPerTick = canvas.scene?.grid?.distance ?? 5;
    const ticks = Math.floor(ftMoved / ftPerTick);
    if (ticks < 1) return;

    const formulaPerTick = tracker.item?.system?.damage?.parts?.[0]?.[0]
                        ?? tracker.damageFormula
                        ?? "2d4";
    const damageType     = tracker.damageTypes?.[0] ?? "piercing";

    // Build a multi-tick formula. e.g. ticks=4, formulaPerTick="2d4" → "4*(2d4)"
    const formula = `${ticks}*(${formulaPerTick})`;
    try {
      const roll = new Roll(formula, tracker.actor?.getRollData?.() ?? {});
      await roll.evaluate();
      // Fire-and-forget DSN broadcast (per v0.4.21 fix — never await)
      try { game.dice3d?.showForRoll?.(roll, game.user, true); } catch (_) {}

      const total = roll.total;
      const flavor = `<strong>${tracker.item?.name ?? "Persistent area"}</strong> — ${token.name} moved ${Math.round(ftMoved)}ft through area`
                   + `<br><em>${ticks} × ${formulaPerTick} ${damageType} = ${total}</em>`;
      // Whisper to GM only — they apply damage manually per user spec
      // (chat-card with INFLICT DAMAGE button is the right surface; for
      // now we post a simple result card and let the GM apply via the
      // existing damage application pipeline.)
      await ChatMessage.create({
        speaker: ChatMessage.getSpeaker({ actor: tracker.actor }),
        flavor,
        rolls: [roll],
        sound: CONFIG.sounds.dice,
        whisper: ChatMessage.getWhisperRecipients("GM"),
        type: CONST.CHAT_MESSAGE_STYLES?.OTHER ?? 0,
      });
      console.log(`${TAG} | Movement damage: ${token.name} took ${total} ${damageType} from ${tracker.item?.name} (${Math.round(ftMoved)}ft)`);
    } catch (err) {
      console.error(`${TAG} | _applyMovementDamage failed:`, err);
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

        // v0.4.22.10: Only the GM client may delete the canvas template.
        // Otherwise every player would race to delete the same document,
        // generating N permission errors and one successful delete.
        if (game.user.isGM) {
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
    // v0.6.0: Default position is top-center (was bottom-right which got
    // hidden behind the chat panel). User-draggable via the title bar
    // (`#ace-qol-conc-drag-handle`); after a drag, position is preserved
    // for the rest of the session via internal _userPos coordinates.
    const initialLeft = this._userPos?.left ?? "50%";
    const initialTop  = this._userPos?.top  ?? "12px";
    const transform   = (this._userPos) ? "none" : "translateX(-50%)";
    this._container.style.cssText = `
      position: fixed; top: ${initialTop}; left: ${initialLeft};
      transform: ${transform}; z-index: 100;
      display: flex; flex-direction: column; gap: 8px;
      pointer-events: auto; max-height: 60vh; overflow-y: auto;
    `;
    document.body.appendChild(this._container);
    this._attachDragHandlers();
  }

  /**
   * v0.6.0 — Drag handlers for the concentration widget.
   * The widget can be moved by clicking and dragging anywhere on the
   * container that isn't a button. We capture pointerdown on the
   * container, track movement via pointermove on document, and release
   * on pointerup. The user's chosen position survives until next reload.
   */
  _attachDragHandlers() {
    if (!this._container) return;
    let dragging = false;
    let startX = 0, startY = 0;
    let originLeft = 0, originTop = 0;

    const onPointerDown = (ev) => {
      // Don't start drag if the user clicked an interactive control
      if (ev.target.closest?.("button, a, input, select, textarea")) return;
      dragging = true;
      startX = ev.clientX;
      startY = ev.clientY;
      const rect = this._container.getBoundingClientRect();
      originLeft = rect.left;
      originTop  = rect.top;
      // Drop the centering transform on first drag so subsequent
      // positions are stored in raw pixel coordinates.
      this._container.style.transform = "none";
      this._container.style.left = `${originLeft}px`;
      this._container.style.top  = `${originTop}px`;
      document.addEventListener("pointermove", onPointerMove);
      document.addEventListener("pointerup",   onPointerUp, { once: true });
      ev.preventDefault();
    };
    const onPointerMove = (ev) => {
      if (!dragging) return;
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      // Clamp to viewport so the widget can't be dragged off-screen
      const maxLeft = window.innerWidth  - 80;
      const maxTop  = window.innerHeight - 80;
      const newLeft = Math.max(0, Math.min(maxLeft, originLeft + dx));
      const newTop  = Math.max(0, Math.min(maxTop,  originTop  + dy));
      this._container.style.left = `${newLeft}px`;
      this._container.style.top  = `${newTop}px`;
    };
    const onPointerUp = () => {
      if (!dragging) return;
      dragging = false;
      document.removeEventListener("pointermove", onPointerMove);
      // Persist for the rest of this session
      this._userPos = {
        left: this._container.style.left,
        top:  this._container.style.top,
      };
    };

    this._container.style.cursor = "move";
    this._container.addEventListener("pointerdown", onPointerDown);
  }

  _renderWidgets() {
    // v0.6.1: Gate UI rendering behind the existing `concentrationWidget`
    // setting (Saves tab → "Floating Concentration Widget"). v0.6.0
    // accidentally registered a duplicate `showConcentrationWidget` that
    // wasn't in any tab — removed in v0.6.1.
    //
    // The DATA tracking (this._activeSpells Map) and entry-detection logic
    // continue to run regardless — only the visible widget is suppressed
    // when the setting is off. That way auto save-card flow still works
    // even with the widget hidden.
    let widgetEnabled = true;
    try {
      widgetEnabled = QolSettings.get?.("concentrationWidget") !== false;
    } catch (_) { /* setting not registered yet during boot */ }

    if (!widgetEnabled || !this._activeSpells.size) {
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
