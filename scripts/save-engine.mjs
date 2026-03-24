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

    // ── Template placement — auto-target tokens inside ──
    Hooks.on("createMeasuredTemplate", (templateDoc, context, userId) => {
      if (!game.user.isGM) return;
      // Small delay to let the PIXI shape render
      setTimeout(() => this._onTemplateCreated(templateDoc), 100);
    });

    // ── Persistent button wiring for ALL save card types ──
    Hooks.on("renderChatMessage", (message, html) => {
      const flags = message.flags?.[MODULE_ID];
      if (!flags?.type) return;

      const el = html[0] ?? html;

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
        this._wirePcSaveButton(el, message, flags);
      }

      // ── Save Results card — manual override + Apply/Undo ──
      if (flags.type === "saveResults") {
        this._wireSaveResultButtons(el, message, flags);
        // Auto-collapse the target list card above this one
        this._collapseTargetListCard(flags);
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

    // Find tokens inside the template
    let tokens = [];
    try {
      tokens = SaveEngine._getTokensInTemplate(templateDoc);
      console.log(`${MODULE_ID} | _getTokensInTemplate found ${tokens.length} tokens:`, tokens.map(t => t.name));
    } catch (err) {
      console.error(`${MODULE_ID} | _getTokensInTemplate FAILED:`, err);
    }

    if (!tokens.length) {
      // Fallback: use game.user.targets if template targeting found nothing
      console.warn(`${MODULE_ID} | Template found 0 tokens — falling back to game.user.targets`);
      tokens = [...game.user.targets];
      if (!tokens.length) {
        console.warn(`${MODULE_ID} | No targets either — skipping save card`);
        return;
      }
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
          .filter(([id, level]) => level >= 3 && id !== "default")
          .map(([id]) => id) : [],
      });
    }

    if (!targetData.length) return;

    // ── Split into NPCs and PCs ──
    const npcs = targetData.filter(t => !t.isPC);
    const pcs = targetData.filter(t => t.isPC);

    // ── Build NPC rows ──
    const npcRowsHtml = npcs.map(t => `
      <div class="ace-qol-save-tgt-row" data-token-id="${t.tokenId}">
        <img src="${t.img || "icons/svg/mystery-man.svg"}" class="ace-qol-save-tgt-img" />
        <span class="ace-qol-save-tgt-name">${t.name}</span>
        <span class="ace-qol-save-tgt-mod">${t.saveAbilityUpper} ${t.saveMod}</span>
        ${t.autoFailSave ? '<span class="ace-qol-tag ace-qol-tag-danger"><i class="fas fa-circle-xmark"></i> AUTO-FAIL</span>' : ""}
        ${t.superSaver ? '<span class="ace-qol-tag ace-qol-tag-buff"><i class="fas fa-person-running"></i> EVASION</span>' : ""}
        <button class="ace-qol-save-tgt-remove" data-action="aceQolRemoveTarget" data-token-id="${t.tokenId}">
          <i class="fas fa-xmark"></i>
        </button>
      </div>
    `).join("");

    // ── Build PC rows ──
    const pcRowsHtml = pcs.map(t => `
      <div class="ace-qol-save-tgt-row ace-qol-save-tgt-pc" data-token-id="${t.tokenId}">
        <img src="${t.img || "icons/svg/mystery-man.svg"}" class="ace-qol-save-tgt-img" />
        <span class="ace-qol-save-tgt-name">${t.name}</span>
        <span class="ace-qol-save-tgt-mod">${t.saveAbilityUpper} ${t.saveMod}</span>
        ${t.autoFailSave ? '<span class="ace-qol-tag ace-qol-tag-danger"><i class="fas fa-circle-xmark"></i> AUTO-FAIL</span>' : ""}
        ${t.superSaver ? '<span class="ace-qol-tag ace-qol-tag-buff"><i class="fas fa-person-running"></i> EVASION</span>' : ""}
        <span class="ace-qol-save-pc-note">rolls privately</span>
      </div>
    `).join("");

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
            <div class="ace-qol-save-tgt-section-label">NPCs (${npcs.length})</div>
            ${npcRowsHtml}
          </div>
        ` : ""}

        ${pcs.length ? `
          <div class="ace-qol-save-tgt-section ace-qol-save-tgt-section-pc">
            <div class="ace-qol-save-tgt-section-label">PCs (${pcs.length})</div>
            ${pcRowsHtml}
          </div>
        ` : ""}

        <div class="ace-qol-save-actions">
          <button class="ace-qol-btn ace-qol-btn-roll" data-action="aceQolRollNpcSaves">
            <i class="fas fa-dice-d20"></i> ROLL NPC SAVES
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
    const rollBtn = el.querySelector?.("[data-action='aceQolRollPcSave']");
    if (!rollBtn || rollBtn.dataset.wired) return;
    rollBtn.dataset.wired = "1";

    if (flags.rolled) {
      rollBtn.disabled = true;
      rollBtn.innerHTML = '<i class="fas fa-check"></i> ROLLED \u2713';
    } else {
      rollBtn.addEventListener("click", async () => {
        rollBtn.disabled = true;
        rollBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Rolling...';

        await this._rollPcSave(message);

        rollBtn.innerHTML = '<i class="fas fa-check"></i> ROLLED \u2713';
        await message.setFlag(MODULE_ID, "rolled", true);
      });
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Auto-Collapse Target List Card
  // ═══════════════════════════════════════════════════════════════════════════

  _collapseTargetListCard(resultsFlags) {
    // Find the target list card that spawned this results card and collapse it
    const chatLog = document.querySelector("#chat-log");
    if (!chatLog) return;
    const targetCards = chatLog.querySelectorAll(".ace-qol-save-card");
    for (const card of targetCards) {
      // Collapse the entire chat message containing this card
      const msg = card.closest(".chat-message");
      if (msg) msg.classList.add("ace-qol-save-collapsed");
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Button Wiring — Save Results Card (override + Apply/Undo)
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

    // ── Manual damage override buttons (x0, x1/2, x1, x2) ──
    const overrideBtns = el.querySelectorAll?.("[data-action='aceQolDmgOverride']");
    if (overrideBtns?.length) {
      for (const btn of overrideBtns) {
        if (btn.dataset.wired) continue;
        btn.dataset.wired = "1";
        btn.addEventListener("click", async () => {
          const tokenDocId = btn.dataset.tokenDocId;
          const multiplier = parseFloat(btn.dataset.multiplier);
          if (!tokenDocId || isNaN(multiplier)) return;

          await this._applyDamageOverride(message, tokenDocId, multiplier, el);
        });
      }
    }

    // ── Apply All / Undo All (reuse DamageEngine wiring pattern) ──
    const applyBtn = el.querySelector?.("[data-action='aceQolApplyDamage']");
    const undoBtn = el.querySelector?.("[data-action='aceQolUndoDamage']");

    if (applyBtn && !applyBtn.dataset.wired) {
      applyBtn.dataset.wired = "1";
      if (flags.applied) {
        applyBtn.disabled = true;
        applyBtn.textContent = "APPLIED \u2713";
      } else {
        applyBtn.addEventListener("click", async () => {
          await this._applyAllSaveDamage(message);
          applyBtn.disabled = true;
          applyBtn.textContent = "APPLIED \u2713";
          await message.setFlag(MODULE_ID, "applied", true);
        });
      }
    }

    if (undoBtn && !undoBtn.dataset.wired) {
      undoBtn.dataset.wired = "1";
      if (flags.undone) {
        undoBtn.disabled = true;
        undoBtn.textContent = "UNDONE \u2713";
      } else {
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
          .filter(([id, level]) => level >= 3 && id !== "default")
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

    // ── Build PC "waiting" placeholders ──
    const pcResults = pcTargets.map(tgt => ({
      name: tgt.name,
      img: tgt.img,
      tokenDocId: tgt.tokenDocId,
      actorId: tgt.actorId,
      sceneId: tgt.sceneId,
      saveTotal: null,
      passed: null,
      isAutoFail: tgt.autoFailSave,
      resultLabel: "\u23f3 Waiting for save...",
      damageMultiplier: null,
      roll: null,
      damageModifiers: tgt.damageModifiers,
      currentHP: tgt.currentHP,
      maxHP: tgt.maxHP,
      isPC: true,
      pending: true,
    }));

    // ── Roll damage once for the spell ──
    const damageComponents = await this._rollSpellDamage(item, casterActor);

    // ── Post results card (NPC results + PC placeholders) ──
    const allResults = [...npcResults, ...pcResults];
    await this._postSaveResults(item, casterActor, allResults, {
      saveAbility, saveDC, halfOnSave, damageTypes, isSpell,
    }, damageComponents);

    // ── Send PC whispered save prompts ──
    for (const tgt of pcTargets) {
      await this._sendPcSavePrompt(item, casterActor, tgt, {
        saveAbility, saveDC, halfOnSave, damageTypes, isSpell,
      });
    }
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
    const { saveAbility, saveDC, halfOnSave, damageTypes, isSpell } = opts;
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

    // Whisper to the player(s) who own this PC
    const whisperIds = tgt.ownerIds?.length ? tgt.ownerIds : [];

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
            saveBonuses, targetName, targetImg } = flags;

    const scene = game.scenes.get(sceneId) ?? canvas.scene;
    const tokenDoc = scene?.tokens?.get(tokenDocId);
    const targetActor = tokenDoc?.actor ?? game.actors.get(actorId);
    if (!targetActor) return;

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
    const abilityLabel = CONFIG.DND5E?.abilities?.[saveAbility]?.label ?? saveAbility.toUpperCase();
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
        }
      }
    });
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
  //  Save Results + Damage Card (Redesigned)
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

      return `
        <div class="ace-qol-save-result-row" data-token-doc-id="${r.tokenDocId}">
          <div class="ace-qol-save-result-line">
            <img src="${r.img || "icons/svg/mystery-man.svg"}" class="ace-qol-save-tgt-img" />
            <span class="ace-qol-save-tgt-name">${r.name}</span>
            <span class="ace-qol-save-roll ${passClass}">${rollDisplay}</span>
            <span class="ace-qol-save-result-dmg" style="color:${DamageEngine.DAMAGE_COLORS[damageComponents[0]?.type] ?? '#ff6644'}">${targetDamage}</span>${isDead ? '<span style="color:#fff; margin-left:2px;">\u2620</span>' : ""}
            ${inlineBadge}
            <span class="ace-qol-save-result-hp">HP: ${r.currentHP}\u2192${newHP}</span>
            <button class="ace-qol-save-ovr" data-action="aceQolDmgOverride" data-token-doc-id="${r.tokenDocId}" data-multiplier="0">\u00d70</button>
            <button class="ace-qol-save-ovr" data-action="aceQolDmgOverride" data-token-doc-id="${r.tokenDocId}" data-multiplier="0.5">\u00bd</button>
            <button class="ace-qol-save-ovr ace-qol-save-ovr-active" data-action="aceQolDmgOverride" data-token-doc-id="${r.tokenDocId}" data-multiplier="1">1</button>
            <button class="ace-qol-save-ovr" data-action="aceQolDmgOverride" data-token-doc-id="${r.tokenDocId}" data-multiplier="2">\u00d72</button>
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
          <button class="ace-qol-btn ace-qol-btn-undo" data-action="aceQolUndoDamage">
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

  async _applyDamageOverride(message, tokenDocId, multiplier, el) {
    const flags = message.flags?.[MODULE_ID];
    if (!flags) return;

    const results = flags.damageResults ?? [];
    const idx = results.findIndex(r => r.tokenDocId === tokenDocId);
    if (idx < 0) return;

    // Recalculate damage with the new multiplier from base
    const baseDmg = flags.baseDamageTotal ?? 0;
    const newDamage = Math.floor(baseDmg * multiplier);

    // Update the stored result
    results[idx].totalFinal = newDamage;
    await message.setFlag(MODULE_ID, "damageResults", results);

    // Update the damage display in the DOM
    const row = el.querySelector?.(`.ace-qol-save-result-row[data-token-doc-id="${tokenDocId}"]`);
    if (row) {
      const dmgSpan = row.querySelector(".ace-qol-save-result-dmg");
      if (dmgSpan) {
        const newHP = Math.max(0, results[idx].currentHP - newDamage);
        dmgSpan.textContent = `${newDamage} dmg${newHP <= 0 ? " \u2620" : ""}`;
      }
      const hpSpan = row.querySelector(".ace-qol-dmg-hp");
      if (hpSpan) {
        const newHP = Math.max(0, results[idx].currentHP - newDamage);
        hpSpan.textContent = `HP: ${results[idx].currentHP} \u2192 ${newHP}/${results[idx].maxHP ?? "?"}`;
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Apply All Save Damage
  // ═══════════════════════════════════════════════════════════════════════════

  async _applyAllSaveDamage(message) {
    const flags = message.flags?.[MODULE_ID];
    if (!flags?.damageResults?.length) return;

    for (const r of flags.damageResults) {
      const scene = game.scenes.get(r.sceneId) ?? canvas.scene;
      const tokenDoc = scene?.tokens?.get(r.tokenDocId);
      const actor = tokenDoc?.actor ?? game.actors.get(r.targetId);
      if (!actor) continue;

      const currentHP = actor.system?.attributes?.hp?.value ?? 0;
      const newHP = Math.max(0, currentHP - (r.totalFinal ?? 0));
      await actor.update({ "system.attributes.hp.value": newHP });
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
