// ─── ACE: QOL — OnUse Hook API ────────────────────────────────────────────────
// Extensibility API that fires Foundry hooks at every phase of the combat
// workflow, allowing third-party modules and user macros to extend behavior.
//
// Hook Points (in execution order):
//   ace-qol.preItemRoll          → Before anything happens. Return false to abort.
//   ace-qol.preAttackRoll        → Before attack roll. Can modify options.
//   ace-qol.postAttackRoll       → After attack roll resolved.
//   ace-qol.preCheckHits         → Before hit/miss evaluation.
//   ace-qol.postCheckHits        → After hit determination.
//   ace-qol.preDamageRoll        → Before damage roll.
//   ace-qol.damageBonus          → Inject additional damage components.
//   ace-qol.postDamageRoll       → After damage rolled.
//   ace-qol.preSave              → Before saves are prompted.
//   ace-qol.postSave             → After all saves resolved.
//   ace-qol.preDamageApplication → Last chance to modify damage before HP changes.
//   ace-qol.postDamageApplication→ After HP has been modified.
//   ace-qol.preActiveEffects     → Before Active Effects are applied.
//   ace-qol.postActiveEffects    → After effects applied.
//
// Also supports `flags.ace-qol.onUseMacro` on items (and midi-qol compat).
// ──────────────────────────────────────────────────────────────────────────────

import { MODULE_ID } from "./ace-qol.mjs";
import { QolSettings } from "./settings.mjs";

// ─── Complete list of all hook names (used for documentation + validation) ────
const HOOK_NAMES = [
  // ── Combat pipeline phases ──
  "preItemRoll",
  "preAttackRoll",
  "postAttackRoll",
  "preCheckHits",
  "postCheckHits",
  "preDamageRoll",
  "damageBonus",
  "postDamageRoll",
  "preSave",
  "postSave",
  "preDamageApplication",
  "postDamageApplication",
  "preActiveEffects",
  "postActiveEffects",
  // ── Cross-module event contracts ─────────────────────────────────────────
  // These are emitted at well-defined lifecycle points so other modules
  // (ace-engine, ace-artificer, user macros) can subscribe without coupling
  // to raw Foundry hooks whose timing may drift across dnd5e versions.
  //
  // ace-qol.damageApplied    ({ actor, total, components, sourceItem, sourceActor })
  //   Fired after HP is actually changed. Used by regen/aura engines and
  //   ace-engine deed logging. Defined here for documentation; the hook is
  //   emitted from damage-applicator.mjs.
  //
  // ace-qol.saveComplete     ({ actor, tokenDocId, saveAbility, passed })
  //   Fired once per actor after a save resolves (pass or fail, before LR).
  //   actor = Actor5e; tokenDocId = token document id; saveAbility = "wis" etc;
  //   passed = boolean. ace-engine uses this; banishment.mjs gates short-banish on it.
  //
  // ace-qol.killLogged       ({ victim, attacker, attackItem, xp, isMassive })
  //   Fired when a creature is killed and logged by the death pipeline.
  //   ace-engine consumes this to feed the World Event Ledger.
  //
  // ace-qol.reactionUsed     ({ actor, reactionType, targetActor })
  //   Fired when any reaction (Shield, Counterspell, Absorb Elements, etc.)
  //   is accepted and consumed. Lets ace-engine narrate dramatic reactions.
  //
  // ace-qol.concentrationBroken ({ actor, spell, reason })
  //   Fired when concentration is lost (damage threshold, effect removal,
  //   or explicit GM action). ace-engine can narrate "concentration broken."
  "damageApplied",
  "saveComplete",
  "killLogged",
  "reactionUsed",
  "concentrationBroken",
];

// ─── Midi-QOL hook name → ACE-QOL hook name mapping ─────────────────────────
// Allows items with midi-qol onUseMacro flags to work seamlessly.
const MIDI_HOOK_MAP = {
  "preItemRoll":          "preItemRoll",
  "preAttackRoll":        "preAttackRoll",
  "postAttackRoll":       "postAttackRoll",
  "preCheckHits":         "preCheckHits",
  "postCheckHits":        "postCheckHits",
  "preDamageRoll":        "preDamageRoll",
  "postDamageRoll":       "postDamageRoll",
  "preSave":              "preSave",
  "postSave":             "postSave",
  "preDamageApplication": "preDamageApplication",
  "postDamageApplication":"postDamageApplication",
  "preActiveEffects":     "preActiveEffects",
  "postActiveEffects":    "postActiveEffects",
  // Midi-specific names that map to our equivalents
  "preTargeting":         "preItemRoll",
  "preambleComplete":     "preAttackRoll",
  "postAttackRollComplete":"postAttackRoll",
  "preDamageRollComplete":"preDamageRoll",
  "damageRollComplete":   "postDamageRoll",
  "preSaveComplete":      "preSave",
  "savesComplete":        "postSave",
  // ⚠️ "preDamageApplication" was listed HERE as well as in the block above.
  // Same value both times so nothing broke, but a map that defines a key twice
  // is one edit away from the Haste bug: JS keeps the LAST, silently.
  "DamageDealt":          "postDamageApplication",
};

// ─── Per-item damage bonus registry ──────────────────────────────────────────
// Convenience API: addDamageBonus(itemUuid, formula, type, label) registers a
// persistent bonus that fires on every attack with that item.
// Stored in memory only — does not persist across reloads.
const _damageBonusRegistry = new Map();

export class HookAPI {

  // ═══════════════════════════════════════════════════════════════════════════
  //  Core Hook Firing
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Fire a synchronous hook. Returns false if any listener aborted.
   * Uses Hooks.call() — first listener to return false stops propagation.
   *
   * @param {string} hookName  - Hook name WITHOUT the "ace-qol." prefix
   * @param {...any}  args     - Arguments passed to listeners
   * @returns {boolean} true if all listeners allowed, false if aborted
   */
  static fireHook(hookName, ...args) {
    if (!QolSettings.get("enableOnUseHooks")) return true;

    const fullName = `${MODULE_ID}.${hookName}`;

    try {
      // Hooks.call returns false if ANY listener returned false (abort signal)
      const result = Hooks.call(fullName, ...args);
      if (result === false) {
        console.log(`${MODULE_ID} | Hook ABORTED: ${fullName}`);
      }
      return result;
    } catch (err) {
      console.error(`${MODULE_ID} | Hook error in ${fullName}:`, err);
      return true; // Don't abort the workflow on hook errors
    }
  }

  /**
   * Fire a hook and also execute any onUseMacro flags on the item.
   * This is the primary method used by the pipeline — it handles both
   * Foundry hooks AND per-item macro execution.
   *
   * @param {string} hookName  - Hook name WITHOUT the "ace-qol." prefix
   * @param {Item}   item      - The D&D 5e item being used (for macro lookup)
   * @param {...any} args      - Arguments passed to listeners AND macros
   * @returns {boolean} true if allowed to continue, false if aborted
   */
  static async fireItemHook(hookName, item, ...args) {
    if (!QolSettings.get("enableOnUseHooks")) return true;

    // 1. Fire the Foundry hook (synchronous abort check)
    const hookResult = this.fireHook(hookName, item, ...args);
    if (hookResult === false) return false;

    // 2. Execute onUseMacro from item flags (ace-qol format)
    const macroResult = await this._executeOnUseMacro(hookName, item, args);
    if (macroResult === false) return false;

    // 4. Execute onUseMacro from item flags (midi-qol compat format)
    const midiResult = await this._executeMidiOnUseMacro(hookName, item, args);
    if (midiResult === false) return false;

    return true;
  }

  /**
   * Fire an async hook — awaits all registered callbacks sequentially.
   * Used for hooks where listeners may need to do async work (API calls,
   * database reads, etc.) before the pipeline continues.
   *
   * @param {string} hookName  - Hook name WITHOUT the "ace-qol." prefix
   * @param {...any} args      - Arguments passed to listeners
   * @returns {boolean} true if all listeners allowed, false if aborted
   */
  static async fireAsyncHook(hookName, ...args) {
    if (!QolSettings.get("enableOnUseHooks")) return true;

    const fullName = `${MODULE_ID}.${hookName}`;

    // Foundry's Hooks don't natively support async — we use a custom pattern.
    // Register async handlers on a separate namespace and call them here.
    const asyncHandlers = this._asyncHandlers.get(hookName) ?? [];

    for (const handler of asyncHandlers) {
      try {
        const result = await handler(...args);
        if (result === false) {
          console.log(`${MODULE_ID} | Async hook ABORTED: ${fullName}`);
          return false;
        }
      } catch (err) {
        console.error(`${MODULE_ID} | Async hook error in ${fullName}:`, err);
        // Don't abort on errors — defensive
      }
    }

    // Also fire the synchronous hook for backward compat
    return this.fireHook(hookName, ...args);
  }

  /** @type {Map<string, Function[]>} Async handler registry */
  static _asyncHandlers = new Map();

  /**
   * Register an async hook handler.
   * @param {string}   hookName - Hook name WITHOUT prefix
   * @param {Function} fn       - Async function to call
   */
  static onAsync(hookName, fn) {
    if (!this._asyncHandlers.has(hookName)) {
      this._asyncHandlers.set(hookName, []);
    }
    this._asyncHandlers.get(hookName).push(fn);
  }

  /**
   * Unregister an async hook handler.
   * @param {string}   hookName - Hook name WITHOUT prefix
   * @param {Function} fn       - The exact function reference to remove
   */
  static offAsync(hookName, fn) {
    const handlers = this._asyncHandlers.get(hookName);
    if (!handlers) return;
    const idx = handlers.indexOf(fn);
    if (idx >= 0) handlers.splice(idx, 1);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Damage Bonus Hook (Special)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Fire the damageBonus hook and collect additional damage components.
   * Unlike other hooks, this one COLLECTS return values from listeners.
   *
   * Listeners should return an array of:
   *   { formula: "2d6", type: "fire", label: "Sneak Attack" }
   *
   * @param {Item}     item             - The item being used
   * @param {Actor}    actor            - The actor using the item
   * @param {object[]} hits             - Array of hit targets
   * @param {object[]} damageComponents - Current damage components (can modify)
   * @returns {object[]} Array of bonus damage components to add
   */
  static async collectDamageBonuses(item, actor, hits, damageComponents) {
    if (!QolSettings.get("enableOnUseHooks")) return [];

    const bonuses = [];

    // 1. Collect from Hooks listeners
    // We use a temporary collector — listeners push into a shared array
    const collector = { bonuses };
    Hooks.callAll(`${MODULE_ID}.damageBonus`, item, actor, hits, damageComponents, collector);

    // 2. Collect from the convenience registry (addDamageBonus API)
    const itemUuid = item.uuid;
    const registered = _damageBonusRegistry.get(itemUuid);
    if (registered?.length) {
      for (const entry of registered) {
        bonuses.push({
          formula: entry.formula,
          type: entry.type,
          label: entry.label ?? "Bonus",
        });
      }
    }

    // 3. Execute onUseMacro for "damageBonus" phase
    //    Macros can push into the collector.bonuses array
    await this._executeOnUseMacro("damageBonus", item, [actor, hits, damageComponents, collector]);
    await this._executeMidiOnUseMacro("damageBonus", item, [actor, hits, damageComponents, collector]);

    return bonuses;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  OnUseMacro Execution — ACE-QOL format
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Check an item for `flags.ace-qol.onUseMacro.<hookName>` and execute it.
   *
   * Flag format:
   *   flags.ace-qol.onUseMacro.preAttackRoll = "My Macro Name"
   *   flags.ace-qol.onUseMacro.postDamageRoll = "Macro.xxxxx" (UUID)
   *
   * The macro receives: { item, actor, hookName, args }
   *
   * @param {string}  hookName - Hook name (e.g., "preAttackRoll")
   * @param {Item}    item     - The D&D 5e item
   * @param {any[]}   args     - Arguments to pass to the macro
   * @returns {boolean|undefined} false if macro returned false (abort)
   * @private
   */
  static async _executeOnUseMacro(hookName, item, args) {
    if (!item) return;

    const macroRef = item.getFlag?.(MODULE_ID, `onUseMacro.${hookName}`);
    if (!macroRef) return;

    try {
      const macro = await this._resolveMacro(macroRef);
      if (!macro) {
        console.warn(`${MODULE_ID} | onUseMacro: Could not find macro "${macroRef}" for ${hookName} on ${item.name}`);
        return;
      }

      console.log(`${MODULE_ID} | Executing onUseMacro (${hookName}): ${macro.name} for ${item.name}`);

      // Build the context object the macro receives
      const context = {
        item,
        actor: item.actor ?? item.parent,
        hookName,
        args,
        MODULE_ID,
      };

      // Execute the macro — pass context as both scope and first argument
      const result = await macro.execute(context);

      if (result === false) {
        console.log(`${MODULE_ID} | onUseMacro (${hookName}) returned false — aborting`);
        return false;
      }
    } catch (err) {
      console.error(`${MODULE_ID} | onUseMacro execution failed (${hookName}, ${macroRef}):`, err);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  OnUseMacro Execution — Midi-QOL compatibility
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Check an item for `flags.midi-qol.onUseMacroParts` or
   * `flags.midi-qol.onUseMacro` and execute matching macros.
   *
   * Midi-QOL stores macros in two formats:
   *   1. `flags.midi-qol.onUseMacroParts` — Array of { macroName, option }
   *      where option is the midi hook name (e.g., "postAttackRoll")
   *   2. `flags.midi-qol.onUseMacro` — Comma-separated string
   *      "[phase]macroName,[phase]macroName2"
   *
   * @param {string}  hookName - Our hook name (e.g., "preAttackRoll")
   * @param {Item}    item     - The D&D 5e item
   * @param {any[]}   args     - Arguments to pass to the macro
   * @returns {boolean|undefined} false if macro returned false (abort)
   * @private
   */
  static async _executeMidiOnUseMacro(hookName, item, args) {
    if (!item) return;

    // ── Format 1: onUseMacroParts (structured array) ──
    const parts = item.getFlag?.("midi-qol", "onUseMacroParts");
    if (Array.isArray(parts)) {
      for (const part of parts) {
        const midiPhase = part.option ?? part.phase;
        const translatedPhase = MIDI_HOOK_MAP[midiPhase];
        if (translatedPhase !== hookName) continue;

        const macroRef = part.macroName ?? part.macro;
        if (!macroRef) continue;

        try {
          const macro = await this._resolveMacro(macroRef);
          if (!macro) {
            console.warn(`${MODULE_ID} | midi-compat onUseMacro: Could not find macro "${macroRef}"`);
            continue;
          }

          console.log(`${MODULE_ID} | Executing midi-compat onUseMacro (${hookName}): ${macro.name}`);

          // Midi-QOL passes a workflow object — we approximate it
          const workflow = this._buildMidiWorkflowCompat(item, args);
          const result = await macro.execute({ actor: item.actor, item, workflow, args });

          if (result === false) return false;
        } catch (err) {
          console.error(`${MODULE_ID} | midi-compat onUseMacro failed (${macroRef}):`, err);
        }
      }
    }

    // ── Format 2: onUseMacro (comma-separated string) ──
    const macroString = item.getFlag?.("midi-qol", "onUseMacro");
    if (typeof macroString === "string" && macroString.trim()) {
      const entries = macroString.split(",").map(s => s.trim()).filter(Boolean);
      for (const entry of entries) {
        // Format: "[phase]macroName" — e.g., "[postAttackRoll]Fire Bolt Extra"
        const match = entry.match(/^\[([^\]]+)\](.+)$/);
        if (!match) continue;

        const midiPhase = match[1];
        const macroRef = match[2].trim();
        const translatedPhase = MIDI_HOOK_MAP[midiPhase];
        if (translatedPhase !== hookName) continue;

        try {
          const macro = await this._resolveMacro(macroRef);
          if (!macro) {
            console.warn(`${MODULE_ID} | midi-compat onUseMacro: Could not find macro "${macroRef}"`);
            continue;
          }

          console.log(`${MODULE_ID} | Executing midi-compat string macro (${hookName}): ${macro.name}`);

          const workflow = this._buildMidiWorkflowCompat(item, args);
          const result = await macro.execute({ actor: item.actor, item, workflow, args });

          if (result === false) return false;
        } catch (err) {
          console.error(`${MODULE_ID} | midi-compat string macro failed (${macroRef}):`, err);
        }
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Macro Resolution
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Resolve a macro reference to a Macro document.
   * Supports: Macro name (string), Macro UUID, Macro ID.
   *
   * @param {string} ref - Macro name, UUID, or ID
   * @returns {Macro|null}
   * @private
   */
  static async _resolveMacro(ref) {
    if (!ref) return null;

    // Try UUID first (e.g., "Macro.abc123" or full compendium UUID)
    if (ref.includes(".")) {
      try {
        const doc = await fromUuid(ref);
        if (doc instanceof Macro) return doc;
        // Some UUIDs resolve to non-Macro documents
        if (doc) return null;
      } catch { /* not a valid UUID, fall through */ }
    }

    // Try by name (case-insensitive)
    const byName = game.macros?.getName(ref);
    if (byName) return byName;

    // Try by ID
    const byId = game.macros?.get(ref);
    if (byId) return byId;

    return null;
  }

  /**
   * Build a minimal midi-qol workflow-compatible object for macro compat.
   * Midi-QOL macros expect `workflow.targets`, `workflow.hitTargets`, etc.
   * We approximate these from our pipeline data.
   *
   * @param {Item}  item - The item being used
   * @param {any[]} args - Hook arguments
   * @returns {object} Workflow-like object
   * @private
   */
  static _buildMidiWorkflowCompat(item, args) {
    return {
      item,
      actor: item.actor ?? item.parent,
      // These get populated by the pipeline where available
      targets: new Set(),
      hitTargets: new Set(),
      failedSaves: new Set(),
      saves: new Set(),
      damageRoll: null,
      damageTotal: 0,
      isCritical: false,
      isFumble: false,
      // Expose our args for advanced macros that know about ACE-QOL
      _aceQolArgs: args,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Public API Registration
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Register the public API on game.modules.get("ace-qol").api
   * Called once during module ready.
   */
  static registerAPI() {
    const mod = game.modules.get(MODULE_ID);
    if (!mod) return;

    mod.api = {
      ...(mod.api ?? {}),

      // ── Hook documentation ──
      hooks: {
        /** All available hook names (without the "ace-qol." prefix) */
        available: [...HOOK_NAMES],

        /** Mapping of midi-qol hook names to ace-qol equivalents */
        midiCompatMap: { ...MIDI_HOOK_MAP },
      },

      // ── Convenience methods for damage bonuses ──

      /**
       * Register a persistent damage bonus for a specific item.
       * Fires on every attack with that item at the damageBonus phase.
       *
       * @param {string} itemUuid - The item's UUID
       * @param {string} formula  - Dice formula (e.g., "2d6")
       * @param {string} type     - Damage type (e.g., "fire")
       * @param {string} [label]  - Display label (e.g., "Sneak Attack")
       */
      addDamageBonus(itemUuid, formula, type, label = "Bonus") {
        if (!_damageBonusRegistry.has(itemUuid)) {
          _damageBonusRegistry.set(itemUuid, []);
        }
        _damageBonusRegistry.get(itemUuid).push({ formula, type, label });
        console.log(`${MODULE_ID} | API: Registered damage bonus on ${itemUuid}: ${formula} ${type} (${label})`);
      },

      /**
       * Remove all registered damage bonuses for an item.
       * @param {string} itemUuid - The item's UUID
       */
      removeDamageBonus(itemUuid) {
        const had = _damageBonusRegistry.delete(itemUuid);
        if (had) console.log(`${MODULE_ID} | API: Removed damage bonuses from ${itemUuid}`);
      },

      /**
       * List all registered damage bonuses.
       * @returns {Map<string, object[]>}
       */
      listDamageBonuses() {
        return new Map(_damageBonusRegistry);
      },

      /**
       * Register an async hook handler.
       * @param {string}   hookName - Hook name WITHOUT "ace-qol." prefix
       * @param {Function} fn       - Async callback
       */
      onAsync(hookName, fn) {
        HookAPI.onAsync(hookName, fn);
      },

      /**
       * Unregister an async hook handler.
       * @param {string}   hookName - Hook name WITHOUT "ace-qol." prefix
       * @param {Function} fn       - The exact function reference
       */
      offAsync(hookName, fn) {
        HookAPI.offAsync(hookName, fn);
      },

      /**
       * Manually fire a hook (for testing / macro use).
       * @param {string}  hookName - Hook name WITHOUT prefix
       * @param {...any}  args     - Arguments
       * @returns {boolean}
       */
      fireHook(hookName, ...args) {
        return HookAPI.fireHook(hookName, ...args);
      },
    };

    console.debug(`${MODULE_ID} | Hook API registered — ${HOOK_NAMES.length} hook points available`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Debug
  // ═══════════════════════════════════════════════════════════════════════════

  static _debug(msg) {
    try {
      if (game.settings.get(MODULE_ID, "debugMode")) {
        console.log(`${MODULE_ID} | HOOK | ${msg}`);
      }
    } catch { /* settings not ready */ }
  }
}
