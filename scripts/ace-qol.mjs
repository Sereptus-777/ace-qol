// ─── ACE: Quality of Life — Entry Point ───────────────────────────────────────
// Comprehensive D&D 5e combat automation engine.
// Replaces Midi-QOL + DAE in one clean module. Everything ON by default.
// ──────────────────────────────────────────────────────────────────────────────

export const MODULE_ID = "ace-qol";

import { QolSettings }       from "./settings.mjs";
import { ExtendedEffects }   from "./extended-effects.mjs";
import { AttackPipeline }    from "./attack-pipeline.mjs";
import { TargetState }       from "./target-state.mjs";
import { CombatState }       from "./combat-state.mjs";
import { DamageEngine }      from "./damage-engine.mjs";
import { SaveEngine }           from "./save-engine.mjs";
import { ConcentrationWidget }  from "./concentration-widget.mjs";

// ─── Module state ────────────────────────────────────────────────────────────
let extendedEffects      = null;
let attackPipeline       = null;
let damageEngine         = null;
let saveEngine           = null;
let concentrationWidget  = null;

// ─── Init: register settings ─────────────────────────────────────────────────
Hooks.once("init", () => {
  try {
    QolSettings.register();
  } catch (err) {
    console.error(`${MODULE_ID} | Settings registration failed:`, err);
  }

  // Initialize Extended Active Effects engine (must be early — before effects process)
  try {
    extendedEffects = new ExtendedEffects();
    extendedEffects.init();
  } catch (err) {
    console.error(`${MODULE_ID} | Extended Effects init failed:`, err);
  }

  console.log(`${MODULE_ID} | Initialized`);
});

// ─── Ready: start all subsystems (GM only for combat, all users for effects) ─
Hooks.once("ready", () => {

  // Attack pipeline + Damage engine — GM only
  if (game.user.isGM) {
    try {
      attackPipeline = new AttackPipeline();
      console.log(`${MODULE_ID} | Attack pipeline online`);
    } catch (err) {
      console.error(`${MODULE_ID} | Attack pipeline init failed:`, err);
    }

    try {
      damageEngine = new DamageEngine();
      console.log(`${MODULE_ID} | Damage engine online`);
    } catch (err) {
      console.error(`${MODULE_ID} | Damage engine init failed:`, err);
    }
  }

  // Save engine — ALL users (players need renderChatMessage hook for PC save cards)
  try {
    saveEngine = new SaveEngine({ damageEngine });
    console.log(`${MODULE_ID} | Save engine online`);
  } catch (err) {
    console.error(`${MODULE_ID} | Save engine init failed:`, err);
  }

  // Concentration widget — GM only
  if (game.user.isGM) {
    try {
      concentrationWidget = new ConcentrationWidget(saveEngine);
      console.log(`${MODULE_ID} | Concentration widget online`);
    } catch (err) {
      console.error(`${MODULE_ID} | Concentration widget init failed:`, err);
    }
  }

  // Expose module API
  game.aceQol = {
    MODULE_ID,
    extendedEffects,
    attackPipeline,
    damageEngine,
    saveEngine,
    concentrationWidget,
    TargetState,
    CombatState,
    DamageEngine,

    /** Check if a setting is enabled */
    isEnabled: (key) => QolSettings.get(key),

    /** Manually assess combat state (for console testing) */
    assessCombat: (attackerActor, targetToken, item) => CombatState.assess(attackerActor, targetToken, item),
    assessTarget: (token, item) => TargetState.assess(token, null, item),
  };

  console.log(`${MODULE_ID} | Ready — combat automation active (all features ON by default)`);
});
