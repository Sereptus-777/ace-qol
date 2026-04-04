// ─── ACE: QOL — Speed Item Rolls ──────────────────────────────────────────────
// One-click attack rolling from the character sheet. Click a weapon/spell icon
// and it immediately fires the attack with no dialog. Modifier keys override:
//   Normal click  → fast-forward roll (no dialog, straight d20)
//   Ctrl+click    → show normal roll config dialog
//   Alt+click     → roll with advantage
//   Ctrl+Alt      → roll with disadvantage
//
// Hooks into:
//   - renderActorSheet5e (D&D 5e character sheets)
//   - renderTokenActionHud (BG3 HUD / Token Action HUD, if present)
// ──────────────────────────────────────────────────────────────────────────────

import { MODULE_ID } from "./ace-qol.mjs";
import { QolSettings } from "./settings.mjs";

export class SpeedRolls {

  constructor() {
    this._registerHooks();
    console.log(`${MODULE_ID} | Speed rolls initialized`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Hook Registration
  // ═══════════════════════════════════════════════════════════════════════════

  _registerHooks() {
    // ── Character sheet: intercept item clicks ──
    Hooks.on("renderActorSheet5e", (sheet, html, data) => {
      this._onRenderSheet(sheet, html, data);
    });

    // ── Token Action HUD (BG3-style HUD) ──
    Hooks.on("renderTokenActionHud", (app, html, data) => {
      this._onRenderHud(app, html, data);
    });

    console.log(`${MODULE_ID} | Speed roll hooks registered (sheet + HUD)`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Character Sheet Handler
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * When a D&D 5e character sheet renders, attach speed-roll click handlers
   * to all item images and item use buttons. These intercept the default
   * behavior and fast-forward the attack with no dialog.
   *
   * @param {ActorSheet} sheet - The rendered actor sheet
   * @param {jQuery|HTMLElement} html - The sheet's HTML element
   * @param {object} data - Sheet render data
   */
  _onRenderSheet(sheet, html, data) {
    if (!QolSettings.get("enableSpeedRolls")) return;

    const behavior = QolSettings.get("speedRollBehavior");
    if (behavior === "disabled") return;

    // Normalize to raw element (jQuery or HTMLElement)
    const el = html instanceof HTMLElement ? html : html?.[0] ?? html;
    if (!el?.querySelectorAll) return;

    // ── Find clickable item elements ──
    // D&D 5e v4 sheets use various selectors:
    //   .item .item-image     (item portrait in inventory)
    //   .item .item-name      (item name text)
    //   .item-use-button      (the "use" icon button)
    //   [data-action="use"]   (v4+ action buttons)
    const selectors = [
      ".item .item-image",
      ".item .item-name",
      ".item [data-action='use']",
      ".item [data-action='roll']",
      ".item .rollable",
    ];

    for (const selector of selectors) {
      const elements = el.querySelectorAll(selector);
      for (const element of elements) {
        // Skip if already wired
        if (element.dataset.aceSpeedWired) continue;
        element.dataset.aceSpeedWired = "1";

        element.addEventListener("click", (event) => {
          this._handleItemClick(event, sheet, behavior);
        }, { capture: true });
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Token Action HUD Handler (BG3 HUD)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * When the Token Action HUD renders, attach speed-roll handlers to
   * action buttons. This works with both Token Action HUD and BG3-style HUDs.
   *
   * @param {Application} app - The HUD application
   * @param {jQuery|HTMLElement} html - The HUD's HTML
   * @param {object} data - Render data
   */
  _onRenderHud(app, html, data) {
    if (!QolSettings.get("enableSpeedRolls")) return;

    const behavior = QolSettings.get("speedRollBehavior");
    if (behavior === "disabled") return;

    const el = html instanceof HTMLElement ? html : html?.[0] ?? html;
    if (!el?.querySelectorAll) return;

    // Token Action HUD uses [data-action-id] and [data-item-id] attributes
    const actionBtns = el.querySelectorAll("[data-action-id], [data-item-id]");
    for (const btn of actionBtns) {
      if (btn.dataset.aceSpeedWired) continue;
      btn.dataset.aceSpeedWired = "1";

      btn.addEventListener("click", (event) => {
        // HUD buttons store the item ID differently
        const itemId = btn.dataset.actionId ?? btn.dataset.itemId;
        if (!itemId) return;

        // Get the controlled token's actor
        const token = canvas.tokens.controlled[0];
        const actor = token?.actor;
        if (!actor) return;

        const item = actor.items.get(itemId);
        if (!item || !this._isRollableItem(item)) return;

        // Only intercept on fast-forward (no modifier keys that mean "show dialog")
        if (event.ctrlKey && !event.altKey) return; // Ctrl = show dialog

        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();

        this._speedRoll(item, actor, event);
      }, { capture: true });
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Click Handler — Decides Fast-Forward vs Pass-Through
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Core click handler for character sheet items.
   * Determines whether to fast-forward or let the default handler process.
   *
   * @param {MouseEvent} event - The click event
   * @param {ActorSheet} sheet - The actor sheet
   * @param {string} behavior - "fastForward" or "dialog"
   */
  _handleItemClick(event, sheet, behavior) {
    // ── Ctrl+click (without Alt): always show the normal dialog ──
    if (event.ctrlKey && !event.altKey) return;

    // ── Resolve the item from the clicked element ──
    const itemEl = event.currentTarget.closest(".item");
    if (!itemEl) return;

    const itemId = itemEl.dataset?.itemId;
    if (!itemId) return;

    const actor = sheet.actor;
    if (!actor) return;

    const item = actor.items.get(itemId);
    if (!item) return;

    // ── Only speed-roll for items with attack activities ──
    if (!this._isRollableItem(item)) return;

    // ── If behavior is "dialog", let the default handler process ──
    if (behavior === "dialog") return;

    // ── Fast-forward: intercept the event ──
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();

    this._speedRoll(item, actor, event);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Item Eligibility Check
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Determine if an item is eligible for speed-rolling.
   * Only items with attack rolls should be fast-forwarded.
   * Consumables, tools, and non-attack spells use normal dialogs.
   *
   * @param {Item5e} item - The D&D 5e item
   * @returns {boolean} True if the item has an attack activity
   */
  _isRollableItem(item) {
    const type = item.type;

    // Weapons are always rollable
    if (type === "weapon") return true;

    // Spells: only if they have an attack activity
    if (type === "spell") {
      return this._hasAttackActivity(item);
    }

    // Features/feats: only if they have an attack activity
    if (type === "feat") {
      return this._hasAttackActivity(item);
    }

    return false;
  }

  /**
   * Check if an item has an attack-type activity.
   * D&D 5e v4+ uses the activities system for all item actions.
   *
   * @param {Item5e} item
   * @returns {boolean}
   */
  _hasAttackActivity(item) {
    const activities = item.system?.activities;
    if (!activities) return false;

    // Handle both Map-like and plain object activity containers
    const iter = (typeof activities.values === "function")
      ? activities.values()
      : Object.values(activities);

    for (const activity of iter) {
      if (activity?.type === "attack") return true;
    }
    return false;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Speed Roll Execution
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Execute a fast-forward attack roll for the given item.
   * This calls item.use() with configuration that skips all dialogs
   * and feeds into our existing AttackPipeline hooks.
   *
   * @param {Item5e} item - The weapon/spell/feat to roll
   * @param {Actor5e} actor - The owning actor
   * @param {MouseEvent} event - The original click event (for modifier keys)
   */
  async _speedRoll(item, actor, event) {
    // ── Determine advantage/disadvantage from modifier keys ──
    const advKey = QolSettings.get("speedRollAdvantageKey");
    let advantage = false;
    let disadvantage = false;

    if (advKey === "alt") {
      // Alt = advantage, Ctrl+Alt = disadvantage
      advantage = event.altKey && !event.ctrlKey;
      disadvantage = event.altKey && event.ctrlKey;
    } else {
      // Shift = advantage, Ctrl+Shift = disadvantage
      advantage = event.shiftKey && !event.ctrlKey;
      disadvantage = event.shiftKey && event.ctrlKey;
    }

    // ── Validate targets ──
    const targets = game.user.targets;
    if (targets.size === 0) {
      // Don't block — the attack pipeline shows a funny no-target warning
      // Let it through so the user still sees the quip
    }

    this._debug(`Speed roll: ${item.name} (adv=${advantage}, disadv=${disadvantage}, targets=${targets.size})`);

    // ── Fire the item use with fast-forward config ──
    // event.shiftKey = true skips the ActivityChoiceDialog (our pipeline handles it)
    // The dnd5e.preRollAttackV2 / dnd5e.rollAttackV2 hooks will fire as normal,
    // feeding into our AttackPipeline for hit/miss resolution and damage.
    try {
      const useConfig = {
        event: { shiftKey: true },  // Skip ActivityChoiceDialog
      };

      // Build roll config options for advantage/disadvantage
      // The system checks these in the roll configuration
      const dialogConfig = {};
      const messageConfig = {};

      if (advantage || disadvantage) {
        // Set the advantage mode on the roll configuration
        // The preRollAttackV2 hook will see this and apply it
        useConfig.advantage = advantage;
        useConfig.disadvantage = disadvantage;

        // Also set on the dialog so if it somehow shows, it's pre-selected
        dialogConfig.defaultButton = advantage ? "advantage" : "disadvantage";
      }

      await item.use(useConfig, dialogConfig, messageConfig);
    } catch (err) {
      console.error(`${MODULE_ID} | Speed roll failed for ${item.name}:`, err);
      ui.notifications.error(`ACE QOL: Speed roll failed for ${item.name} — check console.`);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Debug
  // ═══════════════════════════════════════════════════════════════════════════

  _debug(msg) {
    try {
      if (game.settings.get(MODULE_ID, "debugMode")) {
        console.log(`${MODULE_ID} | SPEED | ${msg}`);
      }
    } catch { /* settings not ready */ }
  }
}
