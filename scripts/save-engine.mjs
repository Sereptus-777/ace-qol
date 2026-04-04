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
import { DamageEngine } from "./damage-engine.mjs";
import { getSpellTiming, TIMING } from "./spell-timing.mjs";

export class SaveEngine {

  /** In-memory override cache — avoids re-render on every button click.
   *  Key: `${messageId}|${tokenDocId}` → multiplier (number)
   *  Flushed to flags only when APPLY ALL is clicked. */
  static overrideCache = new Map();

  constructor({ damageEngine } = {}) {
    this.damageEngine = damageEngine;

    /** @type {object|null} Pending save spell waiting for template placement */
    this._pendingSaveSpell = null;

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
      setTimeout(() => this._onTemplateCreated(templateDoc), 100);
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

    // Check if this activity has a save
    const save = activity.save;
    if (!save?.ability) return;

    const item = activity.item;
    const actor = activity.actor;
    if (!item || !actor) return;

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

    // ── Check if the spell places a measured template ──
    const templateType = item.system?.target?.template?.type
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
      };
      console.log(`${MODULE_ID} | Save spell "${item.name}" has template type "${templateType}" — waiting for template placement`);
      return;
    }

    // ── No template — use game.user.targets directly ──
    const targets = game.user.targets;
    if (!targets.size) return;

    const tokens = [...targets];
    await this._postLiveTargetCard(item, actor, tokens, {
      saveAbility, saveDC, halfOnSave, damageTypes, isSpell, timing,
      activityId: activity.id,
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Template Created — Resolve Pending Save Spell
  // ═══════════════════════════════════════════════════════════════════════════

  async _onTemplateCreated(templateDoc) {
    console.log(`${MODULE_ID} | _onTemplateCreated fired, pending:`, !!this._pendingSaveSpell);
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

    if (!tokens.length) {
      console.warn(`${MODULE_ID} | No targets and template found 0 tokens — skipping save card`);
      return;
    }

    // Store template reference
    pending.templateDoc = templateDoc;

    const { item, actor, saveAbility, saveDC, halfOnSave, damageTypes, isSpell, timing, activityId } = pending;

    if (timing.isInstant) {
      // ── Instant spell (Fireball, etc.) — post target card immediately ──
      await this._postLiveTargetCard(item, actor, tokens, {
        saveAbility, saveDC, halfOnSave, damageTypes, isSpell, timing, activityId,
      });

    } else {
      // ── Persistent spell (Moonbeam, Spirit Guardians, etc.) ──
      // Emit hook for concentration widget (Phase B)
      Hooks.callAll("ace-qol.persistentSpellCreated", {
        item, actor, templateDoc, timing, saveAbility, saveDC,
        halfOnSave, damageTypes, tokens,
      });

      console.log(`${MODULE_ID} | Persistent spell "${item.name}" — emitted ace-qol.persistentSpellCreated`);

      // If timing includes "enter" trigger, post initial save for tokens already in area
      const triggerOnEnter = timing.timing === TIMING.ENTER_START
                          || timing.timing === TIMING.ENTER_END;

      if (triggerOnEnter && tokens.length) {
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

  async _postLiveTargetCard(item, actor, tokens, opts) {
    const { saveAbility, saveDC, halfOnSave, damageTypes, isSpell, timing, activityId } = opts;
    const abilityLabel = CONFIG.DND5E?.abilities?.[saveAbility]?.label ?? saveAbility.toUpperCase();

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
      const modStr = saveMod >= 0 ? `+${saveMod}` : `${saveMod}`;

      targetData.push({
        tokenId: token.id,
        tokenDocId: token.document?.id ?? token.id,
        actorId: token.actor?.id,
        sceneId: canvas.scene?.id,
        name: state.target.name,
        img: state.target.img,
        isPC,
        saveMod: modStr,
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

    // ── Build NPC rows ──
    const npcRowsHtml = npcs.map(t => {
      const di = _getDmgIndicator(t);
      return `
      <div class="ace-qol-save-tgt-row ${di.cls}" data-token-id="${t.tokenId}">
        <img src="${t.img || "icons/svg/mystery-man.svg"}" class="ace-qol-save-tgt-img" />
        <span class="ace-qol-save-tgt-name">${t.name}</span>
        <span class="ace-qol-save-tgt-mod">${t.saveAbilityUpper} ${t.saveMod}</span>
        ${t.autoFailSave ? '<span class="ace-qol-tag ace-qol-tag-danger"><i class="fas fa-circle-xmark"></i> AUTO-FAIL</span>' : ""}
        ${t.superSaver ? '<span class="ace-qol-tag ace-qol-tag-buff"><i class="fas fa-person-running"></i> EVASION</span>' : ""}
        ${di.tag}
        <button class="ace-qol-save-tgt-remove" data-action="aceQolRemoveTarget" data-token-id="${t.tokenId}">
          <i class="fas fa-xmark"></i>
        </button>
      </div>
    `}).join("");

    // ── Build PC rows (with GM dice icon to roll on their behalf) ──
    const pcRowsHtml = pcs.map(t => {
      const di = _getDmgIndicator(t);
      return `
      <div class="ace-qol-save-tgt-row ace-qol-save-tgt-pc ${di.cls}" data-token-id="${t.tokenId}" data-token-doc-id="${t.tokenDocId}" data-actor-id="${t.actorId}">
        <img src="${t.img || "icons/svg/mystery-man.svg"}" class="ace-qol-save-tgt-img" />
        <span class="ace-qol-save-tgt-name">${t.name}</span>
        <span class="ace-qol-save-tgt-mod">${t.saveAbilityUpper} ${t.saveMod}</span>
        ${t.autoFailSave ? '<span class="ace-qol-tag ace-qol-tag-danger"><i class="fas fa-circle-xmark"></i> AUTO-FAIL</span>' : ""}
        ${t.superSaver ? '<span class="ace-qol-tag ace-qol-tag-buff"><i class="fas fa-person-running"></i> EVASION</span>' : ""}
        ${di.tag}
        <button class="ace-qol-save-pc-roll-btn" data-action="aceQolGmRollPcSave" data-token-doc-id="${t.tokenDocId}">
          <img src="modules/ace-qol/assets/20-20.png" class="ace-qol-save-pc-dice-img" />
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
            <i class="fas fa-dice-d20"></i> ROLL SAVES
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
          timingType: timing?.timing ?? TIMING.INSTANT,
          targets: targetData,
          persistentInitial: opts.persistentInitial ?? false,
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
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Legacy Save Prompt Card (kept for backward compat)
  // ═══════════════════════════════════════════════════════════════════════════

  async _postSaveCard(item, actor, targetStates, opts) {
    const { saveAbility, saveDC, halfOnSave, damageTypes, isSpell } = opts;
    const abilityLabel = CONFIG.DND5E?.abilities?.[saveAbility]?.label ?? saveAbility.toUpperCase();

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
      const modStr = saveMod >= 0 ? `+${saveMod}` : `${saveMod}`;

      newTargets.push({
        tokenId: token.id,
        tokenDocId: token.document?.id ?? token.id,
        actorId: token.actor?.id,
        sceneId: canvas.scene?.id,
        name: state.target.name,
        img: state.target.img,
        isPC,
        saveMod: modStr,
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

    const { saveAbility, saveDC, halfOnSave, targets, itemId, itemUuid, actorId, damageTypes, isSpell } = flags;

    const item = await fromUuid(itemUuid) ?? game.items.get(itemId);
    const casterActor = game.actors.get(actorId);

    // ── Separate NPC and PC targets ──
    const npcTargets = targets.filter(t => !t.isPC);
    const pcTargets = targets.filter(t => t.isPC);

    // ── Roll NPC saves ──
    const npcResults = [];
    for (const tgt of npcTargets) {
      const result = await this._rollSingleSave(tgt, saveAbility, saveDC, halfOnSave);
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

    // ── Post Phase 1 saves-only card (damage rolled separately) ──
    const allResults = [...npcResults, ...pcResults];
    await this._postSaveResultsPhase1(item, casterActor, allResults, {
      saveAbility, saveDC, halfOnSave, damageTypes, isSpell,
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Roll a Single NPC Save
  // ═══════════════════════════════════════════════════════════════════════════

  async _rollSingleSave(tgt, saveAbility, saveDC, halfOnSave) {
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
      const bonuses = (tgt.saveBonuses ?? []).map(b => b.value).join(" + ");
      const formula = rollMode === "advantage" ? `2d20kh + ${saveMod}${bonuses ? ` + ${bonuses}` : ""}`
                    : rollMode === "disadvantage" ? `2d20kl + ${saveMod}${bonuses ? ` + ${bonuses}` : ""}`
                    : `1d20 + ${saveMod}${bonuses ? ` + ${bonuses}` : ""}`;

      const roll = new Roll(formula);
      await roll.evaluate();
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

  async _rollSpellDamage(item, casterActor) {
    const rollData = casterActor?.getRollData?.() ?? {};
    const damageComponents = [];

    const sys = item?.system ?? {};
    const activities = sys.activities;
    if (activities) {
      const actList = (typeof activities.forEach === "function")
        ? [...(activities.values?.() ?? activities)]
        : (typeof activities === "object" ? Object.values(activities) : []);

      for (const activity of actList) {
        if (!activity?.damage?.parts?.length) continue;
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
        }
        break; // Only first activity with damage
      }
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
      const bonuses = (saveBonuses ?? []).map(b => b.value).join(" + ");
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

      console.log(`${MODULE_ID} | Updated target list PC row: ${verdictText} (${rollDisplay})`);
      return;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Update Main Save Results Card with PC Save Result
  // ═══════════════════════════════════════════════════════════════════════════

  async _updateMainCardPcResult(tokenDocId, pcResult) {
    // Find the most recent saveResults card that has this tokenDocId as pending
    const messages = game.messages.contents.slice(-20).reverse();
    for (const msg of messages) {
      const flags = msg.flags?.[MODULE_ID];
      if (flags?.type !== "saveResults") continue;
      const allResults = flags.allResults;
      if (!allResults) continue;

      const idx = allResults.findIndex(r => r.tokenDocId === tokenDocId && r.pending);
      if (idx < 0) continue;

      // Found the matching pending row — update it in the flag data
      allResults[idx].pending = false;
      allResults[idx].saveTotal = pcResult.saveTotal;
      allResults[idx].passed = pcResult.passed;
      allResults[idx].resultLabel = pcResult.resultLabel;
      allResults[idx].isAutoFail = pcResult.autoFailSave;
      allResults[idx].damageMultiplier = pcResult.damageMultiplier;

      // Persist flags WITHOUT re-render (render:false prevents DOM wipe)
      await msg.update({
        [`flags.${MODULE_ID}.allResults`]: allResults,
      }, { render: false });

      // Update DOM directly for the pending row
      const chatLog = document.querySelector("#chat-log, .chat-log");
      if (!chatLog) return;
      const msgEl = chatLog.querySelector(`.chat-message[data-message-id="${msg.id}"]`);
      if (!msgEl) return;
      const row = msgEl.querySelector(`.ace-qol-save-result-row[data-token-doc-id="${tokenDocId}"]`);
      if (!row) return;

      const passClass = pcResult.passed ? "ace-qol-save-pass" : "ace-qol-save-fail";
      const verdictText = pcResult.passed ? "PASS" : "FAIL";
      const rollDisplay = pcResult.autoFailSave ? "AUTO" : pcResult.saveTotal;

      row.classList.remove("ace-qol-save-result-pending");
      row.innerHTML = `
        <div class="ace-qol-save-result-line">
          <img src="${allResults[idx].img || "icons/svg/mystery-man.svg"}" class="ace-qol-save-tgt-img" />
          <span class="ace-qol-save-tgt-name">${allResults[idx].name}</span>
          <span class="ace-qol-save-roll ${passClass}">${rollDisplay}</span>
          <span class="ace-qol-save-verdict ${passClass}">${verdictText}</span>
        </div>
      `;

      console.log(`${MODULE_ID} | Updated main card pending row for ${allResults[idx].name}: ${verdictText} (${rollDisplay})`);
      return;
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

    for (const tgt of targets) {
      const result = await this._rollSingleSave(tgt, saveAbility, saveDC, halfOnSave);
      results.push(result);
    }

    // Roll damage once and apply per target with multipliers
    const damageComponents = await this._rollSpellDamage(item, casterActor);
    await this._postSaveResults(item, casterActor, results, {
      saveAbility, saveDC, halfOnSave, damageTypes, isSpell,
    }, damageComponents);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Phase 1 — Saves-Only Card (no damage yet, ROLL DAMAGE button)
  // ═══════════════════════════════════════════════════════════════════════════

  async _postSaveResultsPhase1(item, casterActor, results, opts) {
    const { saveAbility, saveDC, halfOnSave, damageTypes, isSpell } = opts;
    const abilityLabel = CONFIG.DND5E?.abilities?.[saveAbility]?.label ?? saveAbility.toUpperCase();

    // ── Build Phase 1 target rows (saves only — no damage, no HP, no overrides) ──
    const targetRows = results.map(r => {
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
      const rollDisplay = r.isAutoFail ? "AUTO" : r.saveTotal;
      const verdictText = r.passed ? "PASS" : "FAIL";

      return `
        <div class="ace-qol-save-result-row" data-token-doc-id="${r.tokenDocId}">
          <div class="ace-qol-save-result-line">
            <img src="${r.img || "icons/svg/mystery-man.svg"}" class="ace-qol-save-tgt-img" />
            <span class="ace-qol-save-tgt-name">${r.name}</span>
            <span class="ace-qol-save-roll ${passClass}">${rollDisplay}</span>
            <span class="ace-qol-save-verdict ${passClass}">${verdictText}</span>
          </div>
        </div>
      `;
    }).join("");

    const cardHtml = `
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
        <div class="ace-qol-dmg-actions">
          <button class="ace-qol-btn ace-qol-btn-roll-dmg" data-action="aceQolRollDamage">
            <i class="fas fa-dice-d20"></i> ROLL DAMAGE
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
          phase: 1,
          itemId: item.id,
          itemUuid: item.uuid,
          actorId: casterActor?.id,
          saveAbility,
          saveDC,
          halfOnSave,
          damageTypes,
          isSpell,
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

    const { itemUuid, itemId, actorId, saveAbility, saveDC, halfOnSave,
            damageTypes, isSpell, allResults } = flags;

    const item = await fromUuid(itemUuid) ?? game.items.get(itemId);
    const casterActor = game.actors.get(actorId);

    if (!item) {
      ui.notifications.error("ACE QOL | Could not find spell item for damage roll.");
      return;
    }

    // ── 1. Roll damage dice ──
    const damageComponents = await this._rollSpellDamage(item, casterActor);
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
      [`flags.${MODULE_ID}.damageComponentTotals`]: damageComponents.map(c => ({ total: c.total, type: c.type })),
      [`flags.${MODULE_ID}.damageResults`]: damageResults,
    });
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
      const rollDisplay = r.isAutoFail ? "AUTO" : r.saveTotal;
      const verdictText = r.passed ? "PASS" : "FAIL";

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

      return `
        <div class="ace-qol-save-result-row ${nameClass}" data-token-doc-id="${r.tokenDocId}">
          <div class="ace-qol-save-result-line">
            <img src="${r.img || "icons/svg/mystery-man.svg"}" class="ace-qol-save-tgt-img" />
            <span class="ace-qol-save-tgt-name">${r.name}</span>
            <span class="ace-qol-save-roll ${passClass}">${rollDisplay}</span>
            <span class="ace-qol-save-verdict ${passClass}">${verdictText}</span>
            ${inlineBadge}
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
      const color = DamageEngine.DAMAGE_COLORS[c.type] ?? "#ccc";
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
    const { saveAbility, saveDC, halfOnSave, damageTypes } = opts;
    const abilityLabel = CONFIG.DND5E?.abilities?.[saveAbility]?.label ?? saveAbility.toUpperCase();

    // If damageComponents not provided, roll them
    if (!damageComponents) {
      damageComponents = await this._rollSpellDamage(item, casterActor);
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
        const color = DamageEngine.DAMAGE_COLORS[c.type] ?? "#ccc";
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

      return `
        <div class="ace-qol-save-result-row ${nameClass}" data-token-doc-id="${r.tokenDocId}">
          <div class="ace-qol-save-result-line">
            <img src="${r.img || "icons/svg/mystery-man.svg"}" class="ace-qol-save-tgt-img" />
            <span class="ace-qol-save-tgt-name">${r.name}</span>
            <span class="ace-qol-save-roll ${passClass}">${rollDisplay}</span>
            <span class="ace-qol-save-verdict ${passClass}">${verdictText}</span>
            ${inlineBadge}
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
      const color = DamageEngine.DAMAGE_COLORS[c.type] ?? "#ccc";
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
          damageComponentTotals: damageComponents.map(c => ({ total: c.total, type: c.type })),
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

      const currentHP = actor.system?.attributes?.hp?.value ?? 0;
      const newHP = Math.max(0, currentHP - damageToApply);
      await actor.update({ "system.attributes.hp.value": newHP });

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
