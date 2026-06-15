// ─── ACE: Quality of Life — Entry Point ───────────────────────────────────────
// Comprehensive D&D 5e combat automation engine.
// Replaces Midi-QOL + DAE in one clean module. Everything ON by default.
// ──────────────────────────────────────────────────────────────────────────────

export const MODULE_ID = "ace-qol";

import { QolSettings }       from "./settings.mjs";
import { ExtendedEffects }   from "./extended-effects.mjs";
import { AttackPipeline }    from "./attack-pipeline.mjs";
import { HealPipeline }      from "./heal-pipeline.mjs";
import { SpellAutoDamage }   from "./spell-auto-damage.mjs";
import { EngagementGate }    from "./engagement-gate.mjs";
import { TargetState }       from "./target-state.mjs";
import { CombatState }       from "./combat-state.mjs";
import { DamageEngine }      from "./damage-engine.mjs";
import { SaveEngine }           from "./save-engine.mjs";
import { ConcentrationWidget }  from "./concentration-widget.mjs";
import { RiderEngine }          from "./rider-engine.mjs";
import { FlagsEngine }          from "./flags-engine.mjs";
import { ReactionEngine, injectReactionCSS } from "./reaction-engine.mjs";
import { InvisibilityBreaker } from "./invisibility-breaker.mjs";
import { SpellPipeline } from "./spell-pipeline/pipeline.mjs";
import { HookAPI }              from "./hook-api.mjs";
import { OverTimeEngine }       from "./overtime-engine.mjs";
import { CoverEngine }          from "./cover-engine.mjs";
import { BloodiedEngine }       from "./bloodied-engine.mjs";
import { VisibilityEngine }     from "./visibility-engine.mjs";
import { ConditionLibrary }     from "./condition-library.mjs";
import { SpellTargetPicker }    from "./spell-target-picker.mjs";
import { DescriptionParser }    from "./description-parser.mjs";
import { RepeatingSaveEngine }  from "./repeating-save-engine.mjs";
import { BreakFreeEngine }      from "./break-free-engine.mjs";
import { TransformationEngine } from "./transformation-engine.mjs";
import { ConcentrationDamage }  from "./concentration-damage.mjs";
import { BonusSpellRule }       from "./bonus-spell-rule.mjs";
import { ArmorProfSpellBlock }  from "./armor-prof-spell-block.mjs";
import { DeathSaves }           from "./death-saves.mjs";
import { StealthEngine }        from "./stealth-engine.mjs";
import { CombatActions }        from "./combat-actions.mjs";
import { FumbleEngine }         from "./fumble-engine.mjs";
import { OAPrompt }             from "./oa-prompt.mjs";
import { LoadoutEngine }        from "./loadout-engine.mjs";
import { OA_IN_FLIGHT }         from "./oa-transient.mjs";
import { InitiativeTools }      from "./initiative-tools.mjs";
import { AuraEngine }           from "./aura-engine.mjs";
import { PolymorphSpellPipeline } from "./polymorph-spell-pipeline.mjs";
import { TokenCache }            from "./token-cache.mjs";
import { DurationTracker }      from "./duration-tracker.mjs";
import { SpeedRolls }           from "./speed-rolls.mjs";
import { MergeCard }            from "./merge-card.mjs";
import { LootEngine }           from "./loot-engine.mjs";
import { DeathPipeline }        from "./death-pipeline.mjs";
import * as Diagnostics         from "./diagnostics.mjs";
import { showCenterToast, showAdvantagePrompt, pendingAttackChoices }
  from "./attack-prompt.mjs";
import { EffectsPanel } from "./effects-panel.mjs";
import { XpEngine } from "./xp-engine.mjs";
import { QuickSelectTools } from "./quick-select-tools.mjs";
import { TurnMarker } from "./turn-marker.mjs";
import { MovementTracker } from "./movement-tracker.mjs";
import { LootableTile } from "./lootable-tile.mjs";
import { initAATools }       from "./aa-tools/aa-tools-init.mjs";
import { WeaponMasteries }   from "./weapon-masteries.mjs";
import { BladeCantrips }     from "./blade-cantrips.mjs";
import { HolySymbol }        from "./holy-symbol.mjs";
import { MovementTrail }     from "./movement-trail.mjs";
import { Banishment }        from "./banishment.mjs";
import { FeatEffects }       from "./feat-effects.mjs";
import { SwordOfWounding }   from "./sword-of-wounding.mjs";

// ─── Module state ────────────────────────────────────────────────────────────
let extendedEffects      = null;
let attackPipeline       = null;
let healPipeline         = null;
let damageEngine         = null;
let saveEngine           = null;
let concentrationWidget  = null;
let durationTracker      = null;
let reactionEngine       = null;
let overTimeEngine       = null;
let bloodiedEngine       = null;
let speedRolls           = null;
let lootEngine           = null;
let deathPipeline        = null;
let effectsPanel         = null;
let xpEngine             = null;
let quickSelectTools     = null;
let turnMarker           = null;
let movementTracker      = null;
let lootableTile         = null;

const SOCKET_NAME = `module.${MODULE_ID}`;

// Read the master on/off switch — safe to call after settings are registered.
function _aceQolEnabled() {
  try { return game.settings.get(MODULE_ID, "moduleEnabled") !== false; }
  catch (_) { return true; }
}

// ─── Spell-cast auto-apply dispatch table (v0.7.15) ──────────────────────────
// When a spell is cast that has a matching effect template in condition-library,
// auto-apply the effect to the right target(s) and link to the caster's
// concentration so the effect cleans up when concentration ends.
//
// Match key: spell.name.toLowerCase() with apostrophes stripped.
// Target modes:
//   "self"    → apply to the caster
//   "targets" → apply to the user's currently-targeted token(s)
//                 maxTargets caps the spread (Bless 3, Slow 6, etc.).
//                 If no targets and target mode is "targets", warn and bail.
//
// Hex / Hexblade's Curse / Hunter's Mark / Hold Person / Hold Monster are
// excluded here — Hex/Hexblade have bespoke handlers above with extra flag
// tracking, and Hold Person/Monster are wired through the save engine's
// failed-save-condition path.
//
// Exported so the EngagementGate can recognize spells that handle their own
// target selection via the SpellTargetPicker (skip the "no target" block).
export const SPELL_AUTO_APPLY = {
  // ── 1st level ─────────────────────────────────────────────────────────────
  "bless":                          { key: "bless",                 target: "targets", maxTargets: 3 },
  "bane":                           { key: "bane",                  target: "targets", maxTargets: 3 },
  "shield of faith":                { key: "shield_of_faith",       target: "targets", maxTargets: 1 },
  "heroism":                        { key: "heroism",               target: "targets", maxTargets: 1 },
  "faerie fire":                    { key: "faerie_fire",           target: "targets" },
  "mage armor":                     { key: "mage_armor",            target: "targets", maxTargets: 1 },
  "protection from evil and good":  { key: "protection_from_evil",  target: "targets", maxTargets: 1 },
  "protection from evil":           { key: "protection_from_evil",  target: "targets", maxTargets: 1 },
  "longstrider":                    { key: "longstrider",           target: "targets" },
  "sanctuary":                      { key: "sanctuary",             target: "targets", maxTargets: 1 },
  "divine favor":                   { key: "divine_favor",          target: "self" },
  // ── 2nd level ─────────────────────────────────────────────────────────────
  "barkskin":                       { key: "barkskin",              target: "targets", maxTargets: 1 },
  "blur":                           { key: "blur",                  target: "self" },
  "darkness":                       { key: "darkness",              target: "self" },
  "mirror image":                   { key: "mirror_image",          target: "self" },
  "enlarge/reduce":                 { key: "enlarge",               target: "targets", maxTargets: 1 },
  "enlarge":                        { key: "enlarge",               target: "targets", maxTargets: 1 },
  "reduce":                         { key: "reduce",                target: "targets", maxTargets: 1 },
  // ── 3rd level ─────────────────────────────────────────────────────────────
  "haste":                          { key: "haste",                 target: "targets", maxTargets: 1 },
  "slow":                           { key: "slow",                  target: "targets", maxTargets: 6 },
  "fly":                            { key: "fly",                   target: "targets", maxTargets: 3 },
  "elemental weapon":               { key: "elemental_weapon",      target: "self" },
  "crusader's mantle":              { key: "crusaders_mantle",      target: "self" },
  "crusaders mantle":               { key: "crusaders_mantle",      target: "self" },
  "beacon of hope":                 { key: "beacon_of_hope",        target: "targets" },
  // ── 4th level ─────────────────────────────────────────────────────────────
  "stoneskin":                      { key: "stoneskin",             target: "targets", maxTargets: 1 },
  "freedom of movement":            { key: "freedom_of_movement",   target: "targets", maxTargets: 1 },
  "aura of vitality":               { key: "aura_of_vitality",      target: "self" },
  "fire shield":                    { key: "fire_shield",           target: "self" },
  "death ward":                     { key: "death_ward",            target: "targets", maxTargets: 1 },
  // ── Misc ──────────────────────────────────────────────────────────────────
  "invisibility":                   { key: "invisibility",          target: "targets", maxTargets: 1 },
  "greater invisibility":           { key: "greater_invisibility",  target: "targets", maxTargets: 1 },
  "warding bond":                   { key: "warding_bond",          target: "targets", maxTargets: 1 },
  // ── Smite spells (self-buffs that discharge on next melee weapon hit) ────
  // Cast applies the named concentration effect to the caster. The
  // rider-engine's _hasConcentrationEffect detects it and offers the
  // discharge rider on the next melee swing.
  "searing smite":                  { key: "searing_smite",         target: "self" },
  "wrathful smite":                 { key: "wrathful_smite",        target: "self" },
  "thunderous smite":               { key: "thunderous_smite",      target: "self" },
  "blinding smite":                 { key: "blinding_smite",        target: "self" },
  "staggering smite":               { key: "staggering_smite",      target: "self" },
  "banishing smite":                { key: "banishing_smite",       target: "self" },
};

/**
 * Find the caster's existing Concentrating effect for a given spell, or null.
 * Match by status + name pattern + dnd5e flag origin/item.
 */
function _findConcentratingEffectFor(caster, spellItem) {
  const spellNameLc = String(spellItem?.name ?? "").toLowerCase();
  return (caster?.effects?.contents ?? []).find(e => {
    if (!e.statuses?.has?.("concentration") && !e.statuses?.has?.("concentrating")) return false;
    const eNameLc = String(e.name ?? "").toLowerCase();
    if (eNameLc.includes(spellNameLc)) return true;
    const cf = e.flags?.dnd5e?.concentration;
    if (cf?.item && spellItem?.id && cf.item === spellItem.id) return true;
    if (cf?.origin && spellItem?.id && String(cf.origin).includes(spellItem.id)) return true;
    return false;
  }) ?? null;
}

/**
 * Manually create a Concentrating effect on the caster for the given spell.
 * Used when dnd5e's own activity-use pipeline fails to start concentration
 * (custom/broken spell items, compendium items missing concentration on
 * activity, etc.). Mirrors dnd5e.createConcentrationEffectData's shape so
 * the dnd5e system treats it identically — same status id, same flags.
 *
 * Returns the created concentrating effect, or null on failure.
 */
async function _createConcentratingEffectManually(caster, spellItem, durationRounds = 10) {
  try {
    const statusEffectDef = (CONFIG.statusEffects ?? []).find(e =>
      e.id === (CONFIG.specialStatusEffects?.CONCENTRATING ?? "concentrating")
    ) ?? { id: "concentrating", icon: "icons/svg/aura.svg", statuses: ["concentrating"] };

    const effectData = {
      name: `Concentrating: ${spellItem.name}`,
      icon: statusEffectDef.icon ?? statusEffectDef.img ?? "icons/svg/aura.svg",
      origin: spellItem.uuid,
      statuses: ["concentration", "concentrating", ...(statusEffectDef.statuses ?? [])].filter((v, i, a) => a.indexOf(v) === i),
      duration: { rounds: durationRounds },
      flags: {
        dnd5e: {
          activity: { type: "utility", id: spellItem.id, uuid: spellItem.uuid },
          item:     { type: spellItem.type, id: spellItem.id, uuid: spellItem.uuid },
        },
        [MODULE_ID]: {
          aceQolCreated:  true,
          spellName:      spellItem.name,
          createdAt:      Date.now?.() ?? 0,
          reason:         "dnd5e-item-missing-concentration",
        },
      },
    };
    const created = await caster.createEmbeddedDocuments("ActiveEffect", [effectData]);
    const placed = created?.[0] ?? null;
    if (placed) {
      console.log(`${MODULE_ID} | Concentrating effect manually created for ${spellItem.name} on ${caster.name} (dnd5e item config was missing concentration).`);
    }
    return placed;
  } catch (err) {
    console.warn(`${MODULE_ID} | Manual Concentrating effect creation failed for ${spellItem.name} on ${caster.name}:`, err);
    return null;
  }
}

/**
 * Apply a spell effect from the condition library to a target actor and link
 * it to the caster's Concentrating effect for proper auto-cleanup when
 * concentration ends. Used by the spell-cast auto-apply dispatch.
 *
 * If the spell is a concentration spell AND the dnd5e system failed to apply
 * the Concentrating status (because the item is misconfigured, custom, or
 * missing the concentration property on its activity), this helper creates
 * the Concentrating effect manually to ensure concentration is tracked and
 * the rider-engine can detect smite-spell discharges, etc.
 *
 * @param {Actor} targetActor — actor receiving the effect
 * @param {string} libraryKey — ConditionLibrary effect key (e.g. "bless")
 * @param {Actor} caster      — actor who cast the spell
 * @param {Item}  spellItem   — the spell item that was cast
 * @returns {Promise<ActiveEffect|null>}
 */
async function _applySpellEffectWithConcentration(targetActor, libraryKey, caster, spellItem) {
  try {
    // Look up the library definition to know if this is a concentration spell.
    // (ConditionLibrary.get(key) returns the definition; getEffect is a
    // different method that returns a placed ActiveEffect — don't use that here.)
    const libDef = ConditionLibrary.get?.(libraryKey) ?? null;
    const isConcentration = libDef?.concentration === true;

    // Step 1: Apply the named effect (Bless, Searing Smite, etc.) to the target.
    const effect = await ConditionLibrary.applyEffect(targetActor, libraryKey, {
      origin: spellItem.uuid,
    });
    if (!effect) return null;

    // Step 1b: Initialize per-spell state flags on the target where needed.
    // Mirror Image starts with 3 duplicates; the count is read + decremented
    // by the attack-pipeline's redirect check. The AE change writes mode 0
    // (CUSTOM) which doesn't auto-apply to flags, so we set it explicitly.
    if (libraryKey === "mirror_image") {
      try { await targetActor.setFlag(MODULE_ID, "mirrorImage", 3); }
      catch (_) { /* non-fatal */ }
    }

    // Step 2: For concentration spells, ensure the caster has a Concentrating
    // effect. If dnd5e set one up via its own activity pipeline, use it. If
    // not (broken/custom spell item — common cause of "casting did nothing"),
    // create one manually so concentration is properly tracked.
    let concEffect = null;
    if (isConcentration) {
      concEffect = _findConcentratingEffectFor(caster, spellItem);
      if (!concEffect) {
        // Derive a sensible duration from the library entry (defaults to 10 rounds = 1 minute).
        const durationRounds = libDef?.duration?.rounds
          ?? (libDef?.duration?.minutes ? libDef.duration.minutes * 10 : 10);
        concEffect = await _createConcentratingEffectManually(caster, spellItem, durationRounds);
      }
    }

    // Step 3: Link the placed effect to the Concentrating effect so dnd5e's
    // dependent-cleanup auto-deletes it when concentration ends.
    if (concEffect?.uuid) {
      await effect.update({
        "flags.dnd5e.dependentOn": concEffect.uuid,
        [`flags.${MODULE_ID}.concentrationOrigin`]: {
          casterId:       caster.id,
          spellName:      spellItem.name,
          spellItemId:    spellItem.id,
          concEffectUuid: concEffect.uuid,
          stampedAt:      Date.now?.() ?? 0,
        },
      });
      console.log(`${MODULE_ID} | Spell auto-apply: ${spellItem.name} → ${targetActor.name} (linked to Concentrating effect)`);
    } else if (isConcentration) {
      console.log(`${MODULE_ID} | Spell auto-apply: ${spellItem.name} → ${targetActor.name} (concentration linkage failed; effect placed without auto-cleanup)`);
    } else {
      console.log(`${MODULE_ID} | Spell auto-apply: ${spellItem.name} → ${targetActor.name} (non-concentration, no linkage needed)`);
    }

    return effect;
  } catch (err) {
    console.warn(`${MODULE_ID} | Spell auto-apply failed for ${spellItem.name} on ${targetActor.name}:`, err);
    return null;
  }
}

// ─── Init: register settings ─────────────────────────────────────────────────
Hooks.once("init", () => {
  try {
    QolSettings.register();
    LootEngine.registerSettings();
    DeathPipeline.registerSettings();
    Hooks.on("renderSettingsConfig", (app, html) => QolSettings.onRenderSettingsConfig(app, html));
  } catch (err) {
    console.error(`${MODULE_ID} | Settings registration failed:`, err);
  }

  // Gate the rest of init behind the master enabled switch — settings MUST
  // stay registered (so the user can re-enable) but no runtime systems load.
  if (!_aceQolEnabled()) {
    console.log(`${MODULE_ID} | Module disabled — skipping init subsystems.`);
    return;
  }

  // Initialize Extended Active Effects engine (must be early — before effects process)
  try {
    extendedEffects = new ExtendedEffects();
    extendedEffects.init();
  } catch (err) {
    console.error(`${MODULE_ID} | Extended Effects init failed:`, err);
  }

  // Apply user-configured tooltip activation delay (Foundry default is 500ms;
  // we let the user slow it down for sheet-browsing comfort). The setting's
  // onChange handler covers live updates; this applies the saved value on
  // every world load so it survives reloads.
  try {
    const delay = Number(game.settings.get(MODULE_ID, "tooltipDelay")) || 500;
    if (foundry.helpers?.interaction?.TooltipManager) {
      foundry.helpers.interaction.TooltipManager.TOOLTIP_ACTIVATION_DELAY = delay;
      console.log(`${MODULE_ID} | Tooltip delay restored to ${delay}ms on world load.`);
    }
  } catch (err) {
    console.warn(`${MODULE_ID} | Tooltip delay init failed (non-fatal):`, err);
  }

  // ── 2024 Exhaustion sheet-pip cap bump ──
  // dnd5e 5.x ships CONFIG.DND5E.conditionTypes.exhaustion.levels = 6 even when
  // the system is in modern (2024) mode. 2024 RAW has 10 exhaustion levels.
  // Without bumping this, the actor sheet exhaustion track clamps at 6 pips
  // and the actor cannot reach the level-10 death threshold visually. Bump it
  // here when the system itself is on "modern" rules so the UI matches RAW.
  try {
    const rv = game.settings.get?.("dnd5e", "rulesVersion");
    if (rv === "modern" && CONFIG?.DND5E?.conditionTypes?.exhaustion) {
      const currentLevels = CONFIG.DND5E.conditionTypes.exhaustion.levels;
      if (currentLevels !== 10) {
        CONFIG.DND5E.conditionTypes.exhaustion.levels = 10;
        console.log(`${MODULE_ID} | Exhaustion levels bumped 6 → 10 for 2024 RAW (was ${currentLevels}).`);
      }
    }
  } catch (err) {
    console.warn(`${MODULE_ID} | Exhaustion config bump failed (non-fatal):`, err);
  }

  console.log(`${MODULE_ID} | Initialized`);
});

// ─── BG3 HUD nudge (auto deselect + reselect on world load) ─────────────
// BG3 HUD's portrait + action-hotbar components don't always fully render
// + bind their click handlers on the very first load. Symptoms include:
//   - Info-button (dice icon) missing on portrait
//   - Weapon attack buttons (Halberd / Dawnbringer in hotbar) not firing
//     when clicked
//   - Both clear up immediately when the player clicks off their token
//     onto empty canvas and back on (deselect+reselect cycle)
//
// Fix: on world ready, do the deselect+reselect for the player automatically
// so they don't have to remember the workaround. Runs for GM AND players
// (Johnny reported the bug hits GM side too when re-selecting between
// tokens). The release+control sequence triggers BG3 HUD's controlToken
// hook which fully re-initializes BOTH the portrait and the action hotbar.
//
// Timing: 1500ms after ready. Earlier values (600ms) sometimes fired
// BEFORE BG3 HUD had finished its initial render, leaving the action
// buttons still unbound. 1500ms is conservative but still imperceptible
// for the player.
Hooks.once("ready", () => {
  setTimeout(() => {
    try {
      const controlled = canvas?.tokens?.controlled ?? [];
      if (controlled.length === 0) return;  // nothing to nudge
      // If multiple selected (GM with a group), only nudge the first to
      // avoid changing the GM's selection state too aggressively.
      const token = controlled[0];
      const tokenName = token.name;
      // Deselect all
      canvas.tokens?.releaseAll?.();
      // One tick later, re-select the same token. BG3 HUD's controlToken
      // hook fires on both events, fully re-initializing the portrait
      // AND the action hotbar (binding the click handlers properly).
      setTimeout(() => {
        try {
          token.control?.({ releaseOthers: true });
          console.log(`${MODULE_ID} | BG3 HUD nudged (deselect+reselect) for ${tokenName}`);
        } catch (_) { /* non-fatal — token may have moved off-canvas */ }
      }, 100);
    } catch (err) {
      console.warn(`${MODULE_ID} | BG3 HUD nudge failed (non-fatal):`, err);
    }
  }, 1500);
});

// ─── Module-conflict detection on world ready (audit P2-4) ───────────────────
// ACE QOL is a comprehensive replacement for Midi-QOL + DAE + Times-Up +
// Convenient Effects + Cover modules. Users migrating from those modules
// may leave them active during the transition — which causes double-firing
// on damage application, double active-effect handling, conflicting reaction
// prompts, etc. Detect on world load, warn ONCE with a dismissible message.
//
// GM-only because GMs install/disable modules; players see no actionable UI.
// Warning is suppressible via a settings-stored flag so users only see it
// once per world (or until they re-enable a conflicting module).
const REPLACED_MODULES = [
  { id: "midi-qol",                  label: "Midi-QOL" },
  { id: "dae",                       label: "Dynamic Active Effects (DAE)" },
  { id: "times-up",                  label: "Times Up" },
  { id: "dfreds-convenient-effects", label: "DFreds Convenient Effects" },
  { id: "tokenmagic",                label: "Token Magic FX (cover features)" },
];
Hooks.once("ready", () => {
  if (!game.user.isGM) return;
  if (!_aceQolEnabled()) return;
  try {
    const active = REPLACED_MODULES.filter(m => game.modules?.get?.(m.id)?.active);
    if (!active.length) return;
    const labelList = active.map(m => `<li><strong>${m.label}</strong> <code>(${m.id})</code></li>`).join("");
    // Post a chat notice once per world session — easy to dismiss + reference.
    const html = `
      <div style="background:#1a0e0e;border:2px solid #c74420;border-radius:6px;padding:10px 14px;color:#f0e4c0;">
        <div style="font-family:'Cinzel Decorative','Cinzel',serif;color:#ff6b3d;font-size:14px;font-weight:700;letter-spacing:1px;margin-bottom:6px;">
          <i class="fas fa-triangle-exclamation"></i> ACE QOL — Module Conflict Warning
        </div>
        <p style="margin:4px 0 6px 0;font-size:12px;">
          ACE QOL replaces these modules — running them simultaneously will cause double-firing damage,
          conflicting effect application, and inconsistent behavior. Consider disabling them for a clean experience.
        </p>
        <ul style="margin:4px 0 0 18px;font-size:12px;line-height:1.5;">${labelList}</ul>
        <p style="margin:8px 0 0 0;font-size:11px;color:#c0b288;font-style:italic;">
          This message is whispered to GMs only and shown once per world load.
        </p>
      </div>
    `;
    ChatMessage.create({
      content: html,
      whisper: game.users.filter(u => u.isGM).map(u => u.id),
      flags: { [MODULE_ID]: { type: "conflictWarning" } },
    });
    console.warn(`${MODULE_ID} | Detected ${active.length} potentially-conflicting module(s): ${active.map(m => m.id).join(", ")}`);
  } catch (err) {
    console.warn(`${MODULE_ID} | Module-conflict detection threw (non-fatal):`, err);
  }
});

// ─── BG3 HUD bleed-through auto-heal (REACTIVE — fires only when bug occurs) ─
// BragginRites/bg3-inspired-hotbar's DnD5eAdapter.decorateCellElement throws
// "Actor is not a valid embedded Document within the Token Document" on
// some token swaps. When it throws, the affected grid cells (4-7) are left
// in their previous state — visually this looks like the PRIOR token's
// portrait + icons "bleed through" into the next selection's HUD slot.
//
// Previous implementation hooked controlToken and fired a heal on EVERY
// token swap — that caused visible HUD flicker and intermittent disappear
// because release+control cycles were doing extra work every selection
// even when BG3 HUD's render succeeded.
//
// Current implementation is REACTIVE: wraps console.error to detect the
// specific BG3 HUD failure message, and triggers a SINGLE debounced heal
// only when that error actually fires. Token swaps that work correctly
// pass through with zero overhead — no flicker, no disappear.
//
// GM-only because the bug surfaces on the GM client (full action grid).
Hooks.once("ready", () => {
  if (!game.user.isGM) return;
  let _bg3HealActive = false;
  let _bg3HealActiveSince = 0;  // timestamp when flag was set — staleness check
  let _bg3HealQueued = null;
  const origErr = console.error.bind(console);

  // Helper: clear the active flag if it's been held longer than the max
  // expected heal duration (3s). Defends against the edge case where the
  // setTimeout in `finally` never fires (page unload, JS event-loop hang,
  // exception in an async path the finally can't reach). Audit P2-3.
  const _isBg3HealStale = () => {
    if (!_bg3HealActive) return false;
    if (Date.now() - _bg3HealActiveSince > 3000) {
      console.warn(`${MODULE_ID} | BG3 HUD heal flag was stale (>3s) — force-clearing.`);
      _bg3HealActive = false;
      return true;
    }
    return false;
  };

  console.error = function(...args) {
    try {
      // Only inspect string + Error args; ignore complex objects to keep this cheap.
      const msg = args.map(a => {
        if (typeof a === "string") return a;
        if (a instanceof Error)    return String(a.message ?? "") + " " + String(a.stack ?? "");
        return "";
      }).join(" ");
      const isBg3Bug = msg.includes("Cell decoration failed")
                    && msg.includes("Actor is not a valid embedded Document");
      // Staleness check: force-clear the flag if it's been held too long
      // (recovery from edge cases where the `finally` setTimeout never fires).
      _isBg3HealStale();
      if (isBg3Bug && !_bg3HealActive && !_bg3HealQueued) {
        // Coalesce: a single token swap can trigger this error on cells 4,
        // 5, 6, 7 simultaneously (Promise.all from GridContainer.render).
        // Debounce so we only heal once per token-swap regardless of how
        // many cells failed.
        _bg3HealQueued = setTimeout(async () => {
          _bg3HealQueued = null;
          try {
            _bg3HealActive = true;
            _bg3HealActiveSince = Date.now();  // staleness tracking — see _isBg3HealStale
            // Prefer BG3 HUD's official refresh API — no visible blink.
            const api = globalThis.bg3Hotbar
                     ?? game.modules?.get?.("bg3-inspired-hotbar")?.api
                     ?? globalThis.BG3Hotbar;
            if (api?.refresh) {
              await api.refresh();
            } else {
              // Fallback only if no API: release + reselect cycle.
              const tokens = canvas.tokens?.controlled?.slice() ?? [];
              if (tokens.length) {
                for (const t of tokens) t.release?.();
                await new Promise(r => setTimeout(r, 80));
                for (const t of tokens) t.control?.({ releaseOthers: false });
              }
            }
          } catch (err) {
            // Use origErr to avoid recursing through our own wrapper.
            origErr(`${MODULE_ID} | BG3 HUD bleed-through heal failed:`, err);
          } finally {
            // Clear the re-entrancy guard a beat after the heal — any
            // errors the heal itself triggers in BG3 HUD won't re-fire us.
            setTimeout(() => { _bg3HealActive = false; }, 500);
          }
        }, 100);
      }
    } catch (_) { /* never let our wrapper itself throw — fall through */ }
    return origErr.apply(this, args);
  };
  console.log(`${MODULE_ID} | BG3 HUD bleed-through auto-heal: REACTIVE mode armed (fires only on the actual error pattern).`);
});

// ─── Player Can Start Combat (RAW behavior) ─────────────────────────────
// Foundry/dnd5e default: only the GM can create a Combat document. Players
// rolling initiative when no combat exists hit a TypeError from dnd5e's
// rollInitiative trying to call methods on null. This is wrong for D&D —
// RAW any combatant can initiate combat (assassin from stealth, surprise
// attack, etc.). We patch the system so any roll-initiative call auto-
// creates a combat if one doesn't exist.
//
// Two paths:
//   - GM side: patch Actor.rollInitiative to create the combat directly.
//   - Player side: same patch, but if Combat.create fails (permission
//     denied), emit a socket to the GM client which creates on their
//     behalf and adds the player's actor as a combatant.
//
// Both paths fall back to calling the original rollInitiative once the
// combat exists. No-op when the `playerCanStartCombat` setting is off.
const ACE_SOCKET_NAME = `module.${MODULE_ID}`;

Hooks.once("ready", () => {
  if (!_aceQolEnabled()) return;
  if (!game.settings.get(MODULE_ID, "playerCanStartCombat")) {
    console.log(`${MODULE_ID} | Player-can-start-combat patch skipped (setting off).`);
    return;
  }

  // ── 1. Prototype patch on Actor.rollInitiative ─────────────────────────
  try {
    const ActorClass = CONFIG.Actor?.documentClass;
    if (!ActorClass) {
      console.warn(`${MODULE_ID} | CONFIG.Actor.documentClass missing — initiative patch skipped.`);
    } else if (typeof ActorClass.prototype.rollInitiative === "function"
               && !ActorClass.prototype.rollInitiative.__aceQolStartCombatPatched) {
      const _origRollInitiative = ActorClass.prototype.rollInitiative;
      ActorClass.prototype.rollInitiative = async function (...args) {
        try {
          // Combat already active in the viewed scene? Nothing to do here.
          if (game.combat) return _origRollInitiative.apply(this, args);

          // No combat — figure out which scene and try to create one.
          const sceneId = canvas.scene?.id ?? game.scenes?.viewed?.id;
          if (!sceneId) {
            ui.notifications?.error("ACE: Can't start combat — no active scene.");
            return _origRollInitiative.apply(this, args);
          }
          const actor = this;
          const token = actor.getActiveTokens?.()?.[0]?.document
                     ?? actor.getActiveTokens?.()?.[0];

          // Direct create path (works for GM; throws for player without
          // permission — that's the trigger to fall through to socket).
          try {
            const combat = await Combat.create({ scene: sceneId, active: true });
            if (combat && token) {
              try {
                await combat.createEmbeddedDocuments("Combatant", [{
                  tokenId: token.id,
                  sceneId,
                  actorId: actor.id,
                  hidden:  false,
                }]);
              } catch (addErr) {
                console.warn(`${MODULE_ID} | Failed to add actor to auto-created combat:`, addErr);
              }
            }
            console.log(`${MODULE_ID} | Auto-created combat for ${actor.name} (direct path)`);
          } catch (createErr) {
            // Permission denied (player) — ask the GM client to do it.
            if (!game.user.isGM) {
              console.log(`${MODULE_ID} | Direct create failed (likely permission), routing via GM socket.`);
              ui.notifications?.info("ACE: Asking GM to start combat...");
              game.socket?.emit?.(ACE_SOCKET_NAME, {
                type:    "requestCreateCombat",
                sceneId,
                actorId: actor.id,
                tokenId: token?.id,
                fromUserId: game.user.id,
              });
              // Poll for combat to appear (GM client creates it via socket).
              // 100ms intervals up to 5s total — round-trip socket + create
              // typically takes <500ms on a healthy connection, but slow GM
              // machines / busy worlds can stretch this. Extended from 3s
              // to 5s after audit feedback (silent roll-drop risk at 3s).
              const deadline = Date.now() + 5000;
              while (!game.combat && Date.now() < deadline) {
                await new Promise(r => setTimeout(r, 100));
              }
              // ── HIGH-priority audit fix (Grok #3) ──
              // Previously this had `return;` here which silently dropped
              // the user's initiative roll if combat hadn't appeared by
              // deadline. Now we do one final synchronous check AND fall
              // through to _origRollInitiative regardless of result. If
              // game.combat exists (race recovery), original works; if
              // not, dnd5e's standard "no encounter" warning fires —
              // which is no worse than the pre-patch behavior, and the
              // user can retry. We still post a friendly heads-up so
              // they know what happened.
              if (!game.combat) {
                ui.notifications?.warn("ACE: GM didn't respond yet — combat may not be started. Attempting roll anyway; retry if it fails.");
                // No `return;` — fall through below.
              }
            } else {
              // We ARE the GM and create still failed — re-throw so the
              // error surfaces instead of silently swallowing.
              throw createErr;
            }
          }
          return _origRollInitiative.apply(this, args);
        } catch (err) {
          console.error(`${MODULE_ID} | rollInitiative patch threw:`, err);
          return _origRollInitiative.apply(this, args);
        }
      };
      ActorClass.prototype.rollInitiative.__aceQolStartCombatPatched = true;
      console.log(`${MODULE_ID} | Actor.rollInitiative patched — players can now start combat.`);
    }
  } catch (patchErr) {
    console.warn(`${MODULE_ID} | rollInitiative prototype patch failed:`, patchErr);
  }

  // ── 2. GM-side socket handler for player-initiated combat creation ────
  // Only the GM client should respond. Multiple GMs: first to respond
  // wins — the in-memory lock below prevents duplicate Combat creation
  // even under concurrent player requests.
  //
  // ── In-memory mutex per scene (audit fix — Grok #2) ──
  // Without this, two players rolling initiative simultaneously could
  // BOTH pass the "no combat" check, BOTH call Combat.create, and end
  // up with two combats for the same scene. The lock serializes per-
  // scene handler execution. Locks auto-expire after 5s as a safety
  // net (handler should never take that long).
  if (game.user.isGM) {
    const _pendingScenes = new Map();  // sceneId → expiryTimestamp

    game.socket?.on?.(ACE_SOCKET_NAME, async (data) => {
      try {
        if (data?.type !== "requestCreateCombat") return;
        const sceneId = data.sceneId ?? canvas.scene?.id;
        if (!sceneId) return;

        // ── CRITICAL audit fix (Grok #1) — Permission validation ──
        // Without this, ANY connected client could craft a socket payload
        // claiming any actorId/tokenId, and the GM handler would dutifully
        // create a combat and add that combatant. Malicious player could
        // force-add hidden ambush NPCs, other players' characters, etc.
        // Verify the requesting user actually has permission on the actor
        // they claim to be acting for.
        const requestingUser = game.users?.get?.(data.fromUserId);
        if (!requestingUser) {
          console.warn(`${MODULE_ID} | Socket request from unknown user id "${data.fromUserId}" — rejecting.`);
          return;
        }
        const requestedActor = game.actors?.get?.(data.actorId);
        if (!requestedActor) {
          console.warn(`${MODULE_ID} | Socket request for unknown actor id "${data.actorId}" — rejecting.`);
          return;
        }
        // Must have at least OBSERVER (level 2) on the actor to start
        // combat for them. PCs typically have OWNER (3) on their own
        // characters; this gates against players hijacking unowned NPCs.
        const userPerm = requestedActor.getUserLevel?.(requestingUser)
                      ?? requestedActor.ownership?.[requestingUser.id]
                      ?? requestedActor.ownership?.default
                      ?? 0;
        if (userPerm < 2) {
          console.warn(`${MODULE_ID} | User "${requestingUser.name}" lacks permission on actor "${requestedActor.name}" (level=${userPerm}) — rejecting socket request.`);
          ui.notifications?.warn(`ACE: Player "${requestingUser.name}" tried to start combat for "${requestedActor.name}" but lacks ownership. Request denied.`);
          return;
        }

        // ── Acquire per-scene lock (Grok #2 race fix) ──
        const now = Date.now();
        const existingLock = _pendingScenes.get(sceneId);
        if (existingLock && existingLock > now) {
          // Another handler is mid-flight for this scene — wait for it
          // to finish, then re-check (the other handler likely created
          // the combat we need).
          const waitDeadline = existingLock + 500;
          while (_pendingScenes.has(sceneId) && Date.now() < waitDeadline) {
            await new Promise(r => setTimeout(r, 50));
          }
        }
        _pendingScenes.set(sceneId, Date.now() + 5000);  // 5s expiry

        try {
          let combat = game.combats?.find?.(c => (c.scene?.id ?? c.sceneId) === sceneId);
          if (!combat) {
            try {
              combat = await Combat.create({ scene: sceneId, active: true });
              console.log(`${MODULE_ID} | GM auto-created combat on player request (user=${requestingUser.name}, actor=${requestedActor.name})`);
            } catch (createErr) {
              // Could be a constraint violation from another concurrent
              // handler beating us — re-query and try to use existing.
              combat = game.combats?.find?.(c => (c.scene?.id ?? c.sceneId) === sceneId);
              if (!combat) throw createErr;  // Genuine error, not a race
              console.log(`${MODULE_ID} | Combat.create race detected — using existing combat created by concurrent handler.`);
            }
          }
          // Add the requesting player's token as a combatant if not already.
          if (data.tokenId && combat) {
            const alreadyIn = combat.combatants?.some?.(c =>
              c.tokenId === data.tokenId || c.actorId === data.actorId
            );
            if (!alreadyIn) {
              await combat.createEmbeddedDocuments("Combatant", [{
                tokenId: data.tokenId,
                sceneId,
                actorId: data.actorId,
                hidden:  false,  // PC — always visible
              }]);
              console.log(`${MODULE_ID} | Added ${requestedActor.name} to combat (requested by ${requestingUser.name})`);
            }
          }
          ui.notifications?.info(`ACE: Combat started for ${requestingUser.name}'s request.`);
        } finally {
          // ALWAYS release the lock, success or failure
          _pendingScenes.delete(sceneId);
        }
      } catch (err) {
        console.warn(`${MODULE_ID} | Socket combat creation failed:`, err);
      }
    });
    console.log(`${MODULE_ID} | GM socket handler online for player-initiated combat starts.`);
  }
});

// ─── Hidden NPC Initiative ───────────────────────────────────────────────
// When the GM rolls initiative for an NPC (via the combat tracker, BG3 HUD,
// hotkey, or any other path), the resulting chat message is whispered to GMs
// only — players never see "Hidden Bandit rolled 17 for initiative" and so
// can't meta-game from knowing an ambush is incoming. PCs are still public.
//
// We hook on preCreateChatMessage (runs on every client before the message
// is persisted) and rewrite the whisper field for any message whose speaker
// is an NPC actor AND whose flavor identifies it as an initiative roll. The
// dnd5e system marks initiative rolls by setting `flags.core.initiativeRoll`
// or by including localized "Initiative" in flavor text; we check both to
// be robust across system versions.
// Companion hook: when an NPC is added to combat, mark them as hidden so
// they don't appear in the native combat tracker, BG3 HUD carousel, or any
// other UI surface that respects Foundry's standard Combatant.hidden flag.
// Players will see a "???" placeholder for hidden entries — same convention
// Foundry GMs already use for surprise-round ambushes.
//
// GM can manually un-hide any combatant from the tracker right-click menu
// when the NPC is revealed in-fiction (typically after the surprise round).
Hooks.on("preCreateCombatant", (combatant, data) => {
  try {
    if (!game.settings.get(MODULE_ID, "hideNpcInitiative")) return;
    // Resolve actor — combatant.actor getter relies on actorId, which is
    // not yet linked during preCreate. Read straight from the data payload.
    const actorId = data?.actorId ?? combatant?.actorId;
    if (!actorId) return;
    const actor = game.actors.get(actorId);
    if (!actor || actor.type !== "npc") return;
    // Honor an explicit GM choice to show this NPC (e.g., they manually set
    // hidden=false before creation). Otherwise hide by default.
    if (data?.hidden === false) return;
    data.hidden = true;
  } catch (err) {
    console.warn(`${MODULE_ID} | Hidden NPC combatant hook failed (non-fatal):`, err);
  }
});

Hooks.on("preCreateChatMessage", (message, data) => {
  try {
    if (!game.settings.get(MODULE_ID, "hideNpcInitiative")) return;

    // Initiative detection — try multiple signals so we work across versions
    const isInitiative =
         !!data?.flags?.core?.initiativeRoll
      || !!message?.flags?.core?.initiativeRoll
      || /initiative/i.test(String(data?.flavor ?? message?.flavor ?? ""))
      || /initiative/i.test(String(data?.system?.activity?.type ?? ""));
    if (!isInitiative) return;

    // Resolve the actor from the speaker
    const speaker = data?.speaker ?? message?.speaker;
    const actor   = ChatMessage.getSpeakerActor?.(speaker);
    if (!actor) return;

    // PC initiative stays public; only hide NPC rolls
    if (actor.type !== "npc") return;

    // Already whispered (e.g. GM chose Private Roll manually)? Don't override
    if (Array.isArray(data?.whisper) && data.whisper.length > 0) return;

    // Whisper to all GM users — preserves dice animations for them, hides
    // entirely from players
    const gmIds = game.users?.filter?.(u => u.isGM)?.map?.(u => u.id) ?? [];
    if (gmIds.length === 0) return;

    // ── CRITICAL: mutate `data` directly, NOT `message.updateSource()` ──
    // In preCreateChatMessage, the ChatMessage document is constructed FROM
    // the `data` object. updateSource() on the temp document doesn't reliably
    // propagate to the finalized message's whisper field. Mutating data
    // before the document finishes constructing is the canonical Foundry V13
    // pattern. We do BOTH (belt and suspenders) so it sticks regardless of
    // which path Foundry actually reads from for the final whisper resolve.
    data.whisper = gmIds;
    if (typeof message?.updateSource === "function") {
      try { message.updateSource({ whisper: gmIds }); } catch (_) { /* non-fatal */ }
    }

    // Optional: also flip the rollMode hint to "gmroll" so any downstream
    // module that inspects rollMode (instead of whisper) renders correctly.
    if (!data.rollMode) data.rollMode = "gmroll";
  } catch (err) {
    // Non-fatal — if anything throws, fall back to the default public roll
    console.warn(`${MODULE_ID} | Hidden NPC initiative hook failed:`, err);
  }
});

// ─── Ready: start all subsystems (GM only for combat, all users for effects) ─
Hooks.once("ready", () => {
  if (!_aceQolEnabled()) {
    console.log(`${MODULE_ID} | Module disabled — skipping ready subsystems.`);
    return;
  }

  // ── hideSpellTemplateVisuals — prototype patch on MeasuredTemplate._refreshState ──
  // The refreshMeasuredTemplate hook alone isn't reliable: in Foundry V13,
  // _refreshState fires on hover changes, layer activation, selection
  // changes, etc., and each call resets the template.template.alpha and
  // highlightLayer.alpha back to the "hidden + GM = 0.5" default before
  // the hook can rerun. Diagnostic confirmed: placeable.alpha=1 (our value)
  // but template.alpha=0.5 (Foundry's reset after some downstream refresh).
  //
  // Patching _refreshState on the prototype guarantees our zeroing runs
  // AFTER every single call to it, with no race-window. Cheap — one extra
  // prototype-property check per refresh, no measurable cost.
  try {
    const MTClass = CONFIG?.MeasuredTemplate?.objectClass;
    if (MTClass && !MTClass.prototype.__aceQolHideVisualsPatched) {
      const _origRefreshState = MTClass.prototype._refreshState;
      MTClass.prototype._refreshState = function() {
        _origRefreshState.call(this);
        try {
          if (this?.document?.getFlag?.(MODULE_ID, "visualHidden")) {
            if (this.template) this.template.alpha = 0;
            if (this.ruler)    this.ruler.alpha    = 0;
            const hl = canvas?.interface?.grid?.getHighlightLayer?.(this.highlightId);
            if (hl) hl.alpha = 0;
          }
        } catch (_) {}
      };
      MTClass.prototype.__aceQolHideVisualsPatched = true;
      console.log(`${MODULE_ID} | hideSpellTemplateVisuals: prototype patch applied to MeasuredTemplate._refreshState`);
    }
  } catch (err) {
    console.warn(`${MODULE_ID} | hideSpellTemplateVisuals: prototype patch failed`, err);
  }

  // On reload, the prototype patch installs HERE in the ready hook, but
  // templates already rendered during canvasReady (which fires BEFORE
  // ready). So existing templates were drawn with alpha=1 — the patch
  // exists now but hasn't been applied to them yet. Force a state refresh
  // on every flagged template so our patched _refreshState fires and
  // they go invisible.
  //
  // We do this BOTH immediately (handles boot — canvasReady has already
  // fired by the time `ready` fires) AND on future canvasReady events
  // (handles scene switches). Same logic, both timings.
  const _reapplyVisualHiddenToTemplates = () => {
    try {
      const templates = canvas?.scene?.templates?.contents ?? [];
      let refreshed = 0;
      for (const tdoc of templates) {
        if (!tdoc.getFlag?.(MODULE_ID, "visualHidden")) continue;
        const placeable = tdoc.object;
        if (!placeable?.renderFlags?.set) continue;
        try {
          placeable.renderFlags.set({ refreshState: true });
          refreshed++;
        } catch (_) {}
      }
      if (refreshed > 0) {
        console.log(`${MODULE_ID} | hideSpellTemplateVisuals: re-applied to ${refreshed} existing template(s)`);
      }
    } catch (err) {
      console.warn(`${MODULE_ID} | hideSpellTemplateVisuals re-apply failed:`, err);
    }
  };
  _reapplyVisualHiddenToTemplates();              // handles initial boot
  Hooks.on("canvasReady", _reapplyVisualHiddenToTemplates); // handles scene switches

  // Attack pipeline — ALL users
  // Pre-roll hook (advantage/disadvantage, range check) runs on the attacking client.
  // Post-roll processing (_onAttackRoll) has its own GM guard — only GM processes results.
  try {
    attackPipeline = new AttackPipeline();
    console.debug(`${MODULE_ID} | Attack pipeline online`);
  } catch (err) {
    console.error(`${MODULE_ID} | Attack pipeline init failed:`, err);
  }

  // AA Tools — right-click "Tweak Animation" on actor-sheet spell rows,
  // plus a "Tweak" button on chat cards after a spell is cast. No-op if
  // AutoAnimations isn't installed.
  try {
    initAATools();
  } catch (err) {
    console.error(`${MODULE_ID} | AA Tools init failed:`, err);
  }

  // Weapon Mastery system (2024 PHB) — listens to ace-qol.attackComplete,
  // fires mastery chat cards + effects per weapon. Self-contained.
  try {
    WeaponMasteries.init();
  } catch (err) {
    console.error(`${MODULE_ID} | Weapon Mastery init failed:`, err);
  }

  // Blade cantrips (Booming Blade / Green-Flame Blade / True Strike).
  // Self-contained — listens to dnd5e.postCreateUsageMessage + renderChatMessage.
  try {
    BladeCantrips.init();
  } catch (err) {
    console.error(`${MODULE_ID} | Blade Cantrip init failed:`, err);
  }

  // Holy Symbol of Ravenkind — 3 powers, 30-ft animations, Sunlight zone.
  // Self-contained — listens to dnd5e.postCreateUsageMessage + combat/time hooks.
  try {
    HolySymbol.init();
  } catch (err) {
    console.error(`${MODULE_ID} | Holy Symbol init failed:`, err);
  }

  // Hide-V13-movement-trail toggle — patches the core token ruler so the
  // "Hide token movement trail" setting can suppress the history path.
  try {
    MovementTrail.init();
  } catch (err) {
    console.error(`${MODULE_ID} | Movement Trail init failed:`, err);
  }

  // Banishment RAW visuals — on the Banished effect's lifecycle: hide the token
  // from players (GM still sees it), GM card, un-hide in place on spell end
  // (or leave it gone permanently if the full minute elapsed).
  try {
    Banishment.init();
  } catch (err) {
    console.error(`${MODULE_ID} | Banishment init failed:`, err);
  }

  // Feat effects (Polearm Master, Crusher, Slasher, Piercer).
  // Self-contained — listens to ace-qol.attackComplete.
  try {
    FeatEffects.init();
  } catch (err) {
    console.error(`${MODULE_ID} | Feat Effects init failed:`, err);
  }

  // Sword of Wounding DoT — listens to attackComplete + combatTurnChange.
  try {
    SwordOfWounding.init();
  } catch (err) {
    console.error(`${MODULE_ID} | Sword of Wounding init failed:`, err);
  }

  // Heavy Armor Master (2014 PHB / 2024 PHB variant)
  // RAW (2014): "While you are wearing heavy armor, bludgeoning, piercing,
  // and slashing damage that you take from nonmagical weapons is reduced
  // by 3."
  // Hook: dnd5e.preApplyDamage — fires before HP reduction. We mutate the
  // damage descriptors in place when the actor has the HAM feat AND is
  // wearing heavy armor AND the damage type is B/P/S. Magical-bypass: we
  // check the damage descriptor's `properties` set for "mgc" if dnd5e
  // surfaces it; otherwise we apply the reduction (acceptable approximation
  // — magical attacks against PCs are rare enough that the over-reduction
  // is small in practice).
  try {
    Hooks.on("dnd5e.preApplyDamage", (actor, amount, updates, opts) => {
      try {
        if (!actor) return;
        const hasFeat = (actor.items ?? []).some(i =>
          i.type === "feat" && /heavy\s*armor\s*master/i.test(String(i.name ?? ""))
        );
        if (!hasFeat) return;
        // Detect heavy armor equipped
        const wearingHeavy = (actor.items ?? []).some(i =>
          i.type === "equipment"
          && i.system?.equipped
          && (i.system?.type?.value === "heavy" || /heavy/i.test(String(i.system?.armor?.type ?? "")))
        );
        if (!wearingHeavy) return;

        // dnd5e calls preApplyDamage with descriptors in opts.damages (array
        // of { value, type, properties }). Reduce qualifying entries by 3.
        const damages = Array.isArray(opts?.damages) ? opts.damages : null;
        if (!damages?.length) return;
        let reduced = 0;
        const BPS = new Set(["bludgeoning", "piercing", "slashing"]);
        for (const d of damages) {
          if (!BPS.has(String(d?.type ?? "").toLowerCase())) continue;
          // Skip if magical-property surfaced
          const props = d?.properties;
          const isMagical = props instanceof Set ? props.has("mgc") : Array.isArray(props) ? props.includes("mgc") : false;
          if (isMagical) continue;
          const cut = Math.min(3, d.value ?? 0);
          d.value = (d.value ?? 0) - cut;
          reduced += cut;
        }
        if (reduced > 0) {
          console.log(`${MODULE_ID} | Heavy Armor Master: ${actor.name} reduced ${reduced} non-magical B/P/S damage.`);
        }
      } catch (err) {
        console.warn(`${MODULE_ID} | Heavy Armor Master hook failed (non-fatal):`, err);
      }
    });
    console.debug(`${MODULE_ID} | Heavy Armor Master damage-reduction hook registered.`);
  } catch (err) {
    console.error(`${MODULE_ID} | HAM hook setup failed:`, err);
  }

  // Heal pipeline — GM-only handler (registered for all clients but gated inside)
  // Detects HealActivity uses, shows target picker, builds a custom heal card
  // with per-target Apply buttons. Mirrors the attack pipeline architecture.
  try {
    healPipeline = new HealPipeline();
    console.debug(`${MODULE_ID} | Heal pipeline online`);
  } catch (err) {
    console.error(`${MODULE_ID} | Heal pipeline init failed:`, err);
  }

  // Spell auto-damage pipeline — ALL users
  // Routes damage-type spell activities (Magic Missile, Witch Bolt initial,
  // any custom auto-hit damage spell) through our resistance/immunity-aware
  // damage card flow. Without this, vanilla dnd5e bypasses our gates and a
  // force-immune target would still take full damage from Magic Missile.
  try {
    new SpellAutoDamage();
  } catch (err) {
    console.error(`${MODULE_ID} | Spell auto-damage pipeline init failed:`, err);
  }

  // Engagement Gate — ALL users, ALWAYS first
  // The pre-flight validator for every spell cast. Phase 1 covers:
  //   • Creature-type restrictions (Hold Person on a Wolf → BLOCKED)
  //   • Concentration confirm (Haste while concentrating on Bless → DIALOG)
  // Returns false from preUseActivity to cancel invalid casts BEFORE any
  // slot is consumed. Subsequent phases will add range, cover, size, and
  // route weapon attacks through the same gate.
  try {
    EngagementGate.registerHooks();
  } catch (err) {
    console.error(`${MODULE_ID} | Engagement gate init failed:`, err);
  }

  // Damage engine — ALL users
  // Players need the renderChatMessage hooks for: hiding GM controls, wiring
  // the ROLL DAMAGE button (routes to GM via socket), and per-type click feedback.
  // Attack processing methods only run when called by GM socket handlers.
  try {
    damageEngine = new DamageEngine();
    console.debug(`${MODULE_ID} | Damage engine online`);
  } catch (err) {
    console.error(`${MODULE_ID} | Damage engine init failed:`, err);
  }

  // Save engine — ALL users (players need renderChatMessage hook for PC save cards)
  try {
    saveEngine = new SaveEngine({ damageEngine });
    console.debug(`${MODULE_ID} | Save engine online`);
  } catch (err) {
    console.error(`${MODULE_ID} | Save engine init failed:`, err);
  }

  // Concentration widget — GM only (Map + per-spell tracking is GM-owned)
  if (game.user.isGM) {
    try {
      concentrationWidget = new ConcentrationWidget(saveEngine);
      console.debug(`${MODULE_ID} | Concentration widget online`);
    } catch (err) {
      console.error(`${MODULE_ID} | Concentration widget init failed:`, err);
    }
  }

  // Movement-damage UNDO button wiring — ALL clients. Non-GM clients need
  // this hook too so the button on the chat card gets hidden for them
  // (clicking it would do nothing — they have no permission to update HP).
  // Without this, non-GMs see a dead UNDO button on every movement-damage
  // card. The handler itself is a no-op on non-GM aside from hiding the
  // button.
  const wireMovementUndo = (message, html) => {
    try {
      const flags = message.flags?.[MODULE_ID];
      if (flags?.type !== "movementDamage") return;
      const el = (html instanceof HTMLElement) ? html : (html?.[0] ?? html);
      const btn = el?.querySelector?.(".ace-qol-mvmt-undo");
      if (!btn) return;
      if (!game.user.isGM) {
        btn.style.display = "none";
        return;
      }
      // GM client — delegate to the widget instance for the actual wiring.
      concentrationWidget?._wireMovementDamageUndo?.(message, html);
    } catch (_) { /* non-fatal */ }
  };
  Hooks.on("renderChatMessage", wireMovementUndo);
  Hooks.on("renderChatMessageHTML", wireMovementUndo);

  // Reaction engine — ALL users (players receive reaction prompts via socket)
  try {
    reactionEngine = new ReactionEngine();
    injectReactionCSS();
    console.debug(`${MODULE_ID} | Reaction engine online`);
  } catch (err) {
    console.error(`${MODULE_ID} | Reaction engine init failed:`, err);
  }

  // Invisibility breaker — RAW: attack/cast ends Invisibility spell (not Greater).
  // Runs on the casting/attacking actor's owner client (PC owner OR GM for NPCs).
  try {
    InvisibilityBreaker.register();
  } catch (err) {
    console.error(`${MODULE_ID} | Invisibility breaker init failed:`, err);
  }

  // Unified Spell Pipeline — registry-driven dispatch for spells whose
  // shape is mapped in SPELL_REGISTRY. Phase 1 ships with Magic Missile
  // as proof-of-concept; other spells fall through to dnd5e default flow.
  // Exposed on game.aceQol.SpellPipeline so spell-auto-damage can check
  // pipeline ownership before its own handlers fire (avoids double-dispatch).
  try {
    SpellPipeline.initialize();
    game.aceQol = game.aceQol ?? {};
    game.aceQol.SpellPipeline = SpellPipeline;
    console.debug(`${MODULE_ID} | Spell pipeline online + exposed on game.aceQol.SpellPipeline`);
  } catch (err) {
    console.error(`${MODULE_ID} | Spell pipeline init failed:`, err);
  }

  // Hook API — register public API on the module for third-party extensibility
  try {
    HookAPI.registerAPI();
    console.debug(`${MODULE_ID} | Hook API online`);
  } catch (err) {
    console.error(`${MODULE_ID} | Hook API init failed:`, err);
  }

  // OverTime engine — GM only (processes recurring effects on combat turn changes)
  if (game.user.isGM) {
    try {
      overTimeEngine = new OverTimeEngine();
      console.debug(`${MODULE_ID} | OverTime engine online`);
    } catch (err) {
      console.error(`${MODULE_ID} | OverTime engine init failed:`, err);
    }
  }

  // Bloodied engine — ALL users (visual overlays render on every client)
  try {
    bloodiedEngine = new BloodiedEngine();
    console.debug(`${MODULE_ID} | Bloodied engine online`);
  } catch (err) {
    console.error(`${MODULE_ID} | Bloodied engine init failed:`, err);
  }

  // Visibility engine — ALL users (players need renderChatMessage filtering)
  try {
    VisibilityEngine.registerHooks();
    console.debug(`${MODULE_ID} | Visibility engine online`);
  } catch (err) {
    console.error(`${MODULE_ID} | Visibility engine init failed:`, err);
  }

  // Cover engine — static, no constructor needed (API registered after game.aceQol is set)
  console.debug(`${MODULE_ID} | Cover engine online`);

  // Condition Library — ALL users (effect definitions + apply/remove API)
  try {
    ConditionLibrary.registerAPI();

    // ── Concentration link cleanup ──
    // When the caster's "concentrating" Active Effect is deleted (concentration
    // ends, OR a new concentration spell breaks the previous one, OR the GM
    // manually drops it from the effects panel/sheet), sweep all actors and
    // remove conditions that were tagged as linked to that caster + spell.
    // RAW: dropping concentration ends the spell's effects.
    //
    // Without this hook, casting Hold Person on Goblin B leaves Goblin A
    // paralyzed forever even though concentration moved to B.
    //
    // Detection is intentionally PERMISSIVE — dnd5e 5.x exposes the
    // concentration effect through several signals depending on path:
    //   - effect.statuses (Set) contains "concentrating"
    //   - effect.flags.dnd5e.concentration exists (raw flag presence is enough)
    //   - effect.flags.core.statusId === "concentrating"
    //   - effect.name starts with "Concentrating" (legacy + manual edits)
    // We accept ANY of these as "this is the concentration tracker effect".
    //
    // Both this hook AND `dnd5e.endConcentration` (registered below) can fire
    // for the same end-event. We share a dedup cache between the two so the
    // sweep only runs once per (caster, spell) within a 2-second window.
    // Dedup window: the two hooks fire within milliseconds of each other for
    // the same concentration-end event. 500ms is plenty to dedupe but won't
    // block a legitimate back-to-back end (e.g. rapid testing).
    const SWEEP_DEDUP_MS = 500;
    const _recentSweeps = new Map();
    const _markSweep = (key) => _recentSweeps.set(key, Date.now());

    // v0.6.5 — Template-creation timestamp tracker.
    // Foundry's MeasuredTemplate docs don't populate `_stats.createdTime`
    // in this version, so we maintain our own map of templateId → ms-since-
    // epoch. Used by the concentration-end sweep below for the grace-period
    // skip, so freshly-created templates aren't deleted by hair-trigger
    // concentration-end events (e.g. dnd5e auto-ending when a damage
    // activity has zero targets).
    const _templateCreatedAt = new Map();
    Hooks.on("createMeasuredTemplate", (tdoc) => {
      try { _templateCreatedAt.set(tdoc.id, Date.now()); } catch (_) {}

      // Hide spell template visuals — GM-owned write. The template doc still
      // exists (Spike Growth / Moonbeam / Wall of Fire entry-trigger detection
      // keeps working) but the placeable alpha is dropped to 0 in the refresh
      // hook below. setTimeout(100) lets dnd5e finish populating flags.dnd5e.*
      // — at synchronous create-hook time those may not be set yet on V13.
      //
      // IMPORTANT: We do NOT set `document.hidden = true` here. The MeasuredTemplate
      // _refreshState patch in the ready hook handles invisibility via PIXI alpha,
      // which works for all clients. Setting `hidden: true` triggers Auto-Animations
      // and similar Sequencer-based modules to PAUSE their animations on the
      // template — which is exactly the "static-sprite instead of looping video"
      // muting symptom the user reported. The flag-only marker is enough.
      setTimeout(async () => {
        try {
          if (game.users?.activeGM !== game.user) return;  // activeGM: flag write must only run once
          if (!game.settings.get(MODULE_ID, "hideSpellTemplateVisuals")) return;
          const fresh = canvas?.scene?.templates?.get?.(tdoc.id);
          if (!fresh) return;
          const dnd5eFlags = fresh.flags?.dnd5e;
          if (!dnd5eFlags?.origin) return;
          if (fresh.getFlag?.(MODULE_ID, "visualHidden")) return;
          await fresh.update({
            [`flags.${MODULE_ID}.visualHidden`]: true,
          });
          // CRITICAL: trigger a state refresh on the placeable manually.
          // Foundry V13 MeasuredTemplate._onUpdate only sets renderFlags
          // for `sort`, `hidden`, or `author` changes — a pure-flag update
          // (like ours) doesn't request `refreshState`, so our prototype-
          // patched _refreshState never runs and the alphas stay at 1.
          // Now that we no longer set `hidden:true` (because it caused
          // Auto-Animations to pause the attached Sequencer effect),
          // there's nothing else triggering the refresh — we have to do
          // it ourselves.
          const placeable = fresh.object;
          if (placeable?.renderFlags?.set) {
            placeable.renderFlags.set({ refreshState: true });
          }
          console.log(`${MODULE_ID} | hideSpellTemplateVisuals: flagged template ${tdoc.id} (origin=${dnd5eFlags.origin})`);
        } catch (err) {
          console.warn(`${MODULE_ID} | hideSpellTemplateVisuals: flag write failed`, err);
        }
      }, 100);
    });
    Hooks.on("deleteMeasuredTemplate", (tdoc) => {
      try { _templateCreatedAt.delete(tdoc.id); } catch (_) {}

      // Clean up orphaned Sequencer/Auto-Animations effects that were
      // attached to this template. AA's auto-cleanup on attached-entity
      // deletion is unreliable in dnd5e 5.x + Foundry V13 — the user's
      // diagnostic showed Sequencer's EffectManager retaining persistent
      // effects whose source token/template had been deleted. Over
      // multiple casts those orphans pile up at 50% opacity and composite
      // into the "muted animation" symptom (each new cast layers on top
      // of N invisible-but-rendering ghosts from prior casts).
      //
      // This explicit cleanup catches what AA misses for the
      // template-attached case. GM-only because endEffects writes through
      // the socket. Wrapped in try/catch because Sequencer isn't a hard
      // dependency.
      try {
        if (game.users?.activeGM !== game.user) return;  // activeGM: endEffects socket must only fire once
        if (!game.modules?.get?.("sequencer")?.active) return;
        const uuid = tdoc?.uuid;
        if (!uuid) return;
        // Sequencer accepts `source` as a UUID string or a Document; UUID
        // works after the doc is gone from the canvas. Fire-and-forget
        // (don't await — keeps the delete-hook handler non-blocking).
        Sequencer?.EffectManager?.endEffects?.({ source: uuid })
          ?.then?.(() => console.log(`${MODULE_ID} | Sequencer effects ended for deleted template ${tdoc.id}`))
          ?.catch?.(err => console.warn(`${MODULE_ID} | Sequencer endEffects (template) failed:`, err));
      } catch (err) {
        console.warn(`${MODULE_ID} | Sequencer cleanup on template delete threw:`, err);
      }
    });

    // Render-side hide for spell templates flagged `visualHidden`. There are
    // THREE separate render surfaces to zero out — Foundry V13 doesn't put
    // them all under the placeable:
    //
    //   1. Placeable children (this.template = Graphics with shape+texture,
    //      this.ruler = PreciseText). Bulldozed via child.alpha = 0.
    //   2. The control icon — left visible so the GM can still hover-and-grab
    //      the template on the templates layer (controlIcon's own visibility
    //      gate already restricts it to layer.active && document.isOwner).
    //   3. The grid HIGHLIGHT LAYER at canvas.interface.grid, keyed by
    //      template.highlightId. This is the colored AOE-fill overlay (the
    //      red squares). It lives OUTSIDE the placeable, so the children
    //      loop never reaches it. Foundry's _refreshState sets its alpha to
    //      0.5 for GM on hidden templates — we have to zero that out again
    //      here, after _refreshState runs (the refreshMeasuredTemplate hook
    //      fires after _applyRenderFlags). Without this, the GM still sees
    //      the red AOE squares even after the shape/texture are invisible.
    //
    // Cleanup workflow stays the same: end concentration on the caster's
    // effect → the v0.6.5 sweep deletes the template automatically.
    Hooks.on("refreshMeasuredTemplate", (template) => {
      try {
        if (!template?.document?.getFlag?.(MODULE_ID, "visualHidden")) return;
        template.alpha = 1;
        for (const child of (template.children ?? [])) {
          if (child === template.controlIcon) continue;
          try { child.alpha = 0; } catch (_) {}
        }
        try {
          const hl = canvas?.interface?.grid?.getHighlightLayer?.(template.highlightId);
          if (hl) hl.alpha = 0;
        } catch (_) {}
      } catch (_) { /* PIXI children may not exist mid-init */ }
    });
    const _wasRecentlySwept = (key) => {
      const t = _recentSweeps.get(key);
      if (!t) return false;
      if (Date.now() - t > SWEEP_DEDUP_MS) { _recentSweeps.delete(key); return false; }
      return true;
    };

    const _runSweep = async (casterId, spellName, source, casterName) => {
      const key = `${casterId}::${spellName ?? "*"}`;
      if (_wasRecentlySwept(key)) {
        console.log(`${MODULE_ID} | [concentration-end:${source}] skipped — already swept ${key} <${SWEEP_DEDUP_MS}ms ago`);
        return 0;
      }
      _markSweep(key);
      console.log(`${MODULE_ID} | [concentration-end:${source}] sweeping ${spellName ? `"${spellName}"` : "(any spell)"} from caster ${casterName ?? casterId}`);
      const removed = await ConditionLibrary.dropConcentrationLinkedEffects({
        casterId, spellName,
      });
      if (removed > 0) {
        console.log(`${MODULE_ID} | [concentration-end:${source}] removed ${removed} linked condition(s) from caster ${casterName ?? casterId}`);
      } else {
        console.log(`${MODULE_ID} | [concentration-end:${source}] sweep found nothing to remove (caster ${casterId}${spellName ? `, spell "${spellName}"` : ""})`);
      }

      // v0.6.5: Also delete any persistent measured templates owned by this
      // caster for this spell. Without this, ending concentration on a
      // template spell (Moonbeam, Spike Growth, etc.) leaves the template
      // floating on canvas indefinitely. We match templates by
      // `flags.dnd5e.origin` (item UUID) or `flags.dnd5e.actor.id` —
      // both are populated by the dnd5e create-template flow.
      //
      // GRACE PERIOD: Skip templates that were created less than
      // TEMPLATE_GRACE_MS ago. Some workflows (e.g. dnd5e auto-ending
      // concentration when a damage activity has zero targets) fire the
      // concentration-end hook within ~200ms of the template being
      // placed. Without this guard, the user sees the template flash on
      // for one frame and disappear before they can interact with it.
      // The grace period gives time for legitimate fast-cast flows to
      // complete; manual concentration-end actions taken later still
      // sweep the template.
      const TEMPLATE_GRACE_MS = 2500;
      try {
        const scene = canvas?.scene;
        if (scene) {
          const now = Date.now();
          const toDelete = [];
          const gracedSkipped = [];
          for (const tmplDoc of scene.templates.contents) {
            const flags = tmplDoc.flags?.dnd5e ?? {};
            const tmplActorId = flags?.actor?.id ?? null;
            const tmplOrigin  = flags?.origin ?? "";
            const tmplItemName = (flags?.item?.name ?? "").toLowerCase();

            // Caster ownership: actor.id flag or origin path includes caster id
            const ownedByCaster = (tmplActorId === casterId)
                               || (typeof tmplOrigin === "string" && tmplOrigin.includes(casterId));
            if (!ownedByCaster) continue;

            // Spell match: by name when we have one, otherwise sweep all
            // templates owned by this caster (last-resort cleanup)
            if (spellName) {
              const wantName = String(spellName).toLowerCase();
              if (tmplItemName && tmplItemName !== wantName) continue;
            }

            // Grace period — Foundry doesn't populate `_stats.createdTime`
            // for MeasuredTemplate documents, so we use our own
            // `_templateCreatedAt` Map (populated by the
            // createMeasuredTemplate hook above). If we have no record
            // (e.g. template was placed before the world reload), no
            // grace skip applies.
            const createdAt = _templateCreatedAt.get(tmplDoc.id);
            if (createdAt != null && (now - createdAt) < TEMPLATE_GRACE_MS) {
              gracedSkipped.push({ id: tmplDoc.id, ageMs: now - createdAt });
              continue;
            }

            toDelete.push(tmplDoc.id);
          }
          if (gracedSkipped.length > 0) {
            console.log(`${MODULE_ID} | [concentration-end:${source}] grace-period skip on ${gracedSkipped.length} freshly-created template(s):`, gracedSkipped);
          }
          if (toDelete.length > 0) {
            await scene.deleteEmbeddedDocuments("MeasuredTemplate", toDelete);
            console.log(`${MODULE_ID} | [concentration-end:${source}] removed ${toDelete.length} template(s) for ${spellName ?? "(any spell)"} on caster ${casterName ?? casterId}`);
          }
        }
      } catch (err) {
        console.warn(`${MODULE_ID} | [concentration-end:${source}] template cleanup threw:`, err);
      }

      return removed;
    };

    Hooks.on("deleteActiveEffect", async (effect, opts, userId) => {
      try {
        if (!game.user.isGM) return; // GM client owns the cleanup
        if (!effect) return;

        // ── Permissive detection ──
        const statuses = effect.statuses;
        const hasStatusSet = statuses?.has?.("concentration") === true   // dnd5e 5.x
                          || statuses?.has?.("concentrating") === true;  // dnd5e 4.x
        const statusFirst  = statuses?.first?.() ?? null;
        const coreStatus   = effect.flags?.core?.statusId ?? null;
        const dndConcFlag  = effect.flags?.dnd5e?.concentration ?? null;
        const nameLc       = String(effect.name ?? "").toLowerCase();

        const isConcentratingFx =
             hasStatusSet
          || statusFirst === "concentration"   // dnd5e 5.x
          || statusFirst === "concentrating"   // dnd5e 4.x
          || coreStatus === "concentration"    // dnd5e 5.x
          || coreStatus === "concentrating"    // dnd5e 4.x
          || !!dndConcFlag
          || nameLc.startsWith("concentrat")
          || nameLc.includes("concentrat");

        if (!isConcentratingFx) return;

        console.log(`${MODULE_ID} | [concentration-end] hook fired:`, {
          name:        effect.name,
          parent:      effect.parent?.name ?? "(no parent)",
          parentId:    effect.parent?.id ?? null,
          hasStatusSet,
          statusFirst,
          coreStatus,
          dndConcFlag: dndConcFlag ? Object.keys(dndConcFlag) : null,
          dndOrigin:   dndConcFlag?.origin ?? null,
          dndItem:     dndConcFlag?.item ?? null,
        });

        const casterId = effect.parent?.id ?? null;
        if (!casterId) {
          console.warn(`${MODULE_ID} | [concentration-end] no caster id resolvable — skipping sweep`);
          return;
        }

        // ── Resolve spell name from every available signal ──
        let spellName = null;
        let spellResolveSource = null;

        // Path A: dnd5e flag with origin UUID
        if (!spellName && dndConcFlag?.origin) {
          try {
            const src = await fromUuid(dndConcFlag.origin);
            if (src?.name) {
              spellName = src.name;
              spellResolveSource = "flags.dnd5e.concentration.origin";
            }
          } catch (_) { /* fallthrough */ }
        }

        // Path B: dnd5e flag with item id (resolve on parent actor)
        if (!spellName && dndConcFlag?.item && effect.parent) {
          const it = effect.parent.items?.get?.(dndConcFlag.item)
                  ?? effect.parent.items?.find?.(i => i.id === dndConcFlag.item);
          if (it?.name) {
            spellName = it.name;
            spellResolveSource = "flags.dnd5e.concentration.item";
          }
        }

        // Path C: name pattern "Concentrating: Hold Person"
        if (!spellName) {
          const m = String(effect.name ?? "").match(/Concentrating(?:\s*[:—–-])?\s*(.+)/i);
          if (m?.[1]) {
            spellName = m[1].trim();
            spellResolveSource = "name pattern";
          }
        }

        // ── Sweep ──
        // If we have a spell name, filter the sweep to that spell only.
        // If we don't, fall back to a name-less sweep (any concentration-
        // tagged effect from this caster) — safer than orphaning conditions
        // forever, since the caster's only concentration just ended anyway.
        if (spellName) {
          console.log(`${MODULE_ID} | [concentration-end] spellName="${spellName}" resolved via ${spellResolveSource}`);
        } else {
          console.warn(`${MODULE_ID} | [concentration-end] could not resolve spell name — falling back to caster-only sweep`);
        }

        await _runSweep(casterId, spellName, "deleteActiveEffect", effect.parent?.name);
      } catch (err) {
        console.warn(`${MODULE_ID} | Concentration-link sweep on deleteActiveEffect failed:`, err);
      }
    });

    // ── Safety-net hook: dnd5e native concentration-end signal ──
    // Some dnd5e flows (e.g. "End Concentration" UI buttons that route through
    // ConcentrationManager) may emit this hook AS WELL AS deleteActiveEffect,
    // or in rare cases instead of it. Wiring both gives us belt-and-braces;
    // the shared dedup cache prevents double-sweeps.
    Hooks.on("dnd5e.endConcentration", async (...args) => {
      try {
        if (game.users?.activeGM !== game.user) return;  // activeGM: concentration sweep must only run once
        // Try to find an actor and an effect/item in the args
        const actor  = args.find(a => a?.documentName === "Actor") ?? null;
        const effect = args.find(a => a?.documentName === "ActiveEffect") ?? null;
        const item   = args.find(a => a?.documentName === "Item") ?? null;
        if (!actor) return;

        let spellName = null;
        if (item?.name) spellName = item.name;
        else if (effect?.flags?.dnd5e?.concentration?.origin) {
          try {
            const src = await fromUuid(effect.flags.dnd5e.concentration.origin);
            if (src?.name) spellName = src.name;
          } catch (_) {}
        }
        if (!spellName && effect?.name) {
          const m = String(effect.name).match(/Concentrating(?:\s*[:—–-])?\s*(.+)/i);
          if (m?.[1]) spellName = m[1].trim();
        }

        console.log(`${MODULE_ID} | [concentration-end:dnd5e] hook fired — caster=${actor.name} spell=${spellName ?? "(unknown)"}`);
        await _runSweep(actor.id, spellName, "dnd5e", actor.name);
      } catch (err) {
        console.warn(`${MODULE_ID} | dnd5e.endConcentration handler failed:`, err);
      }
    });

    // ── Fifth path: orphaned-parent drop ──
    // When a concentration-LINKED dependent (paralyzed, charmed, etc.) is
    // deleted by any means OTHER than the parent concentration ending — e.g.
    // a successful repeating save, Lesser Restoration cure, GM manual removal,
    // duration expiry — check whether the caster has ANY other linked targets
    // remaining. If none, drop the caster's concentration too. Without this,
    // a single goblin passing its end-of-turn save against Hold Person would
    // leave the caster locked into an effectless concentration forever.
    //
    // Skips when: (a) the deleted thing IS the Concentrating effect itself
    // (handled by other layers), (b) parent is already gone/disabled, or
    // (c) any other dependent is still alive on the parent.
    Hooks.on("deleteActiveEffect", async (effect /*, opts, userId */) => {
      try {
        if (game.users?.activeGM !== game.user) return;  // activeGM: concentration orphan sweep must only run once
        if (!effect) return;

        // Only react to LINKED dependents — they have flags.dnd5e.dependentOn
        const depOnUuid = effect.flags?.dnd5e?.dependentOn;
        if (!depOnUuid) return;

        // Skip if the deleted effect is itself a Concentrating effect — the
        // other concentration layers handle that case (and we'd recurse).
        const isConcSelf = effect.statuses?.has?.("concentration")   // dnd5e 5.x
                       || effect.statuses?.has?.("concentrating")   // dnd5e 4.x
                       || !!effect.flags?.dnd5e?.concentration
                       || String(effect.name ?? "").toLowerCase().includes("concentrat");
        if (isConcSelf) return;

        // Resolve the parent Concentrating effect
        let parent;
        try { parent = fromUuidSync(depOnUuid); } catch (_) { return; }
        if (!parent) return;        // Parent already gone — nothing to do
        if (parent.disabled) return; // Parent already disabled — already handled

        // Count remaining alive dependents on the parent. The just-deleted
        // effect may or may not still be in the registry depending on hook
        // ordering (super._onDelete fires this hook BEFORE dnd5e's mixin
        // untracks). Filter by id to guarantee we exclude it.
        let remaining = [];
        try {
          remaining = (parent.getDependents?.() ?? [])
            .filter(d => d && d.id !== effect.id && !d.disabled);
        } catch (_) { /* fall through */ }

        if (remaining.length > 0) return; // Other targets still hooked

        // Last linked target gone — drop the caster's concentration
        console.log(`${MODULE_ID} | [orphan-parent] last linked dependent of "${parent.name}" removed — dropping caster's concentration`);
        try {
          await parent.delete();
          ui.notifications?.info(`${parent.name} ended — no targets remain affected.`);
        } catch (err) {
          const msg = String(err?.message ?? err ?? "");
          if (!/does not exist/i.test(msg)) {
            console.warn(`${MODULE_ID} | Failed to drop orphan parent concentration:`, err);
          }
        }
      } catch (err) {
        console.warn(`${MODULE_ID} | orphan-parent handler failed:`, err);
      }
    });

    // ── Third safety net: watch for concentration being DISABLED (not deleted) ──
    // Some UIs (effect badge toggles, certain modules) may set `disabled: true`
    // on the Concentrating effect rather than deleting it. RAW: a disabled
    // concentration effect means the spell is no longer being concentrated on,
    // so we treat that the same as deletion.
    //
    // After we sweep linked conditions, we ALSO delete the now-dead
    // Concentrating effect itself. Otherwise it sits on the actor as clutter
    // forever, and if the player re-casts the same concentration spell, the
    // system stacks a NEW Concentrating effect on top — so disabled-cast,
    // disabled-cast, disabled-cast accumulates indefinitely.
    Hooks.on("updateActiveEffect", async (effect, changes /*, opts, userId */) => {
      try {
        if (game.users?.activeGM !== game.user) return;  // activeGM: concentration-disable sweep + delete must only run once
        if (!effect) return;

        // Only react to disabled flips on a concentrating effect
        const becameDisabled = changes?.disabled === true;
        if (!becameDisabled) return;

        const isConcentrating = effect.statuses?.has?.("concentration")   // dnd5e 5.x
          || effect.statuses?.has?.("concentrating")                      // dnd5e 4.x
          || !!effect.flags?.dnd5e?.concentration
          || String(effect.name ?? "").toLowerCase().includes("concentrat");
        if (!isConcentrating) return;

        const casterId = effect.parent?.id ?? null;
        if (!casterId) return;

        let spellName = null;
        const dndConcFlag = effect.flags?.dnd5e?.concentration;
        if (dndConcFlag?.origin) {
          try {
            const src = await fromUuid(dndConcFlag.origin);
            if (src?.name) spellName = src.name;
          } catch (_) {}
        }
        if (!spellName) {
          const m = String(effect.name ?? "").match(/Concentrating(?:\s*[:—–-])?\s*(.+)/i);
          if (m?.[1]) spellName = m[1].trim();
        }

        console.log(`${MODULE_ID} | [concentration-end:disable] Concentrating effect disabled on ${effect.parent?.name} — sweeping`);
        await _runSweep(casterId, spellName, "disable", effect.parent?.name);

        // ── Clean up the now-dead Concentrating effect ──
        // Re-fetch right before delete in case something else already removed
        // it (race with dnd5e's own cleanup on some flows).
        try {
          const stillThere = effect.parent?.effects?.get?.(effect.id);
          if (stillThere) {
            await stillThere.delete();
            console.log(`${MODULE_ID} | [concentration-end:disable] cleaned up disabled Concentrating effect on ${effect.parent?.name}`);
          } else {
            console.log(`${MODULE_ID} | [concentration-end:disable] disabled Concentrating effect already gone — no cleanup needed`);
          }
        } catch (err) {
          // "does not exist" = something else won the race — benign
          const msg = String(err?.message ?? err ?? "");
          if (!/does not exist/i.test(msg)) {
            console.warn(`${MODULE_ID} | Failed to delete disabled Concentrating effect on ${effect.parent?.name}:`, err);
          }
        }
      } catch (err) {
        console.warn(`${MODULE_ID} | updateActiveEffect concentration-disable handler failed:`, err);
      }
    });

    console.debug(`${MODULE_ID} | Condition Library online (concentration-link sweep registered)`);
  } catch (err) {
    console.error(`${MODULE_ID} | Condition Library init failed:`, err);
  }

  // ─── v0.7.21: Haste lethargy auto-apply on Haste effect deletion ─────────
  // PHB Haste: "When the spell ends, the target can't move or take actions
  // until after its next turn, as a wave of lethargy sweeps over it."
  // Listen for any Haste effect being deleted and apply the lethargy debuff
  // to the actor it was on. GM-only because only GM can write to NPC actors.
  try {
    Hooks.on("deleteActiveEffect", async (effect, _opts, userId) => {
      try {
        if (!game.user.isGM) return;
        if (userId !== game.user.id) return;  // only the deleting client handles
        if (!effect) return;
        const effName = String(effect.name ?? "").toLowerCase().trim();
        if (effName !== "haste") return;
        const actor = effect.parent;
        if (!actor || actor.documentName !== "Actor") return;

        // ── v0.7.21 — Replacement detection ──
        // BuffResolver flags the prior Haste with `_replacedNotEnded` when
        // re-casting Haste on the same target. RAW: the spell didn't END, it
        // was refreshed — no lethargy in that case.
        if (effect.flags?.[MODULE_ID]?._replacedNotEnded) {
          console.log(`${MODULE_ID} | Haste on ${actor.name} was REPLACED (re-cast), not ended — skipping lethargy`);
          return;
        }

        // Don't double-apply if lethargy is already there (e.g., spell ended twice)
        const existing = actor.effects?.find(e => String(e.name ?? "").toLowerCase().trim() === "haste lethargy");
        if (existing) return;

        // Apply via ConditionLibrary
        const { ConditionLibrary } = await import("./condition-library.mjs");
        await ConditionLibrary.applyEffect(actor, "haste_lethargy", {});
        console.log(`${MODULE_ID} | Haste lethargy auto-applied to ${actor.name} — Haste ended`);
      } catch (err) {
        console.warn(`${MODULE_ID} | Haste lethargy hook threw (non-fatal):`, err);
      }
    });
    console.debug(`${MODULE_ID} | Haste lethargy auto-apply hook registered`);
  } catch (err) {
    console.error(`${MODULE_ID} | Haste lethargy hook init failed:`, err);
  }

  // ─── v0.7.21: ACE-owned concentration check — PC roll button + vanilla suppress ─
  // Wires the "Roll Concentration Save" button on PC concentration cards
  // (posted by DamageApplicator._triggerAceConcentrationCheck) and suppresses
  // dnd5e's vanilla concentration prompt so the player only sees ours.
  try {
    // 1. Click handler — fires when the user (or GM) clicks the roll button
    const _wireConcButton = (message, html) => {
      const el = html instanceof HTMLElement ? html : (html?.[0] ?? html);
      if (!el) return;
      const btn = el.querySelector?.("[data-action='aceQolRollConcSave']");
      if (!btn || btn.dataset.aceWired === "1") return;
      btn.dataset.aceWired = "1";
      btn.addEventListener("click", async (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        try {
          const actorUuid = btn.dataset.actorUuid;
          const effectId = btn.dataset.effectId;
          const dc = Number(btn.dataset.dc);
          const formula = btn.dataset.formula;
          const actor = await fromUuid(actorUuid);
          if (!actor) {
            ui.notifications?.warn("Concentration save: actor not found.");
            return;
          }
          // Permission check — owner or GM only
          if (!actor.testUserPermission?.(game.user, "OWNER") && !game.user.isGM) {
            ui.notifications?.warn("You don't own this actor.");
            return;
          }
          const effect = actor.effects?.get?.(effectId);
          if (!effect) {
            ui.notifications?.info("Concentration already ended.");
            btn.disabled = true;
            btn.textContent = "ALREADY ENDED";
            return;
          }
          btn.disabled = true;
          btn.textContent = "ROLLING...";
          const roll = await new Roll(formula).evaluate();
          const total = roll.total;
          const passed = total >= dc;
          await roll.toMessage({
            speaker: ChatMessage.getSpeaker({ actor }),
            flavor: `${actor.name} Concentration save — ${passed ? "MAINTAINED" : "BROKEN"} (${total} vs DC ${dc})`,
          });
          if (!passed) {
            try { await effect.delete(); } catch (_) { /* non-fatal */ }
            btn.textContent = `BROKEN — ${total} vs DC ${dc}`;
            btn.style.background = "#e57373";
          } else {
            btn.textContent = `MAINTAINED — ${total} vs DC ${dc}`;
            btn.style.background = "#7ec97e";
          }
        } catch (err) {
          console.error(`${MODULE_ID} | concentration roll button failed:`, err);
        }
      });
    };
    Hooks.on("renderChatMessage", _wireConcButton);
    Hooks.on("renderChatMessageHTML", _wireConcButton);

    // 2. Suppress vanilla dnd5e concentration challenge card — we own this now.
    //    dnd5e doesn't fire a hook before posting the card; the actual escape
    //    hatch is `options.dnd5e.concentrationCheck === false` in the HP-update
    //    options (dnd5e.mjs line 26287 checks this before challengeConcentration).
    //    We patch ALL Actor#update calls that touch HP to inject this option so
    //    EVERY damage path (ACE, vanilla attack, manual GM edit, traps, DoT)
    //    routes through our concentration check, not dnd5e's.
    try {
      const ActorCls = CONFIG.Actor?.documentClass ?? globalThis.Actor;
      if (ActorCls?.prototype?.update) {
        const _origUpdate = ActorCls.prototype.update;
        // Re-entrancy guard — per-actor WeakSet. If the patch body triggers
        // another Actor.update on the same actor (e.g. effect creation/deletion
        // → updateActor hook → other module fires actor.update), we bypass the
        // patch to avoid stacked concentration cards / infinite recursion.
        // (Audit-mandated: Grok 2026-06-08.)
        const _patchActive = new WeakSet();
        ActorCls.prototype.update = async function(data, options = {}) {
          // ── Re-entrancy bypass ──
          if (_patchActive.has(this)) {
            return _origUpdate.call(this, data, options);
          }
          _patchActive.add(this);
          try {
            let damageDealt = 0;
            let wasConcentrating = false;
            try {
              // Did this update touch HP downward? Only inject when HP is changing.
              const newHP = foundry.utils.getProperty(data ?? {}, "system.attributes.hp.value");
              if (Number.isFinite(newHP)) {
                const curHP = this.system?.attributes?.hp?.value ?? 0;
                if (newHP < curHP) {
                  damageDealt = curHP - newHP;
                  wasConcentrating = this.effects?.some?.(e =>
                    e.statuses?.has?.("concentration") || e.statuses?.has?.("concentrating"));
                  // Suppress vanilla dnd5e concentration challenge — we own this.
                  options = foundry.utils.mergeObject(options, { dnd5e: { concentrationCheck: false } });
                }
              }
            } catch (_) { /* non-fatal — fall through to original update */ }
            const result = await _origUpdate.call(this, data, options);
            // ── Post-update: fire ACE concentration check if HP dropped on a
            // concentrating actor. Fires AFTER the WeakSet clear (in finally)
            // so the inner check doesn't recurse against this same guard. ──
            if (damageDealt > 0 && wasConcentrating) {
              const actor = this;
              setTimeout(() => {
                (async () => {
                  try {
                    const { DamageApplicator } = await import("./damage-applicator.mjs");
                    if (DamageApplicator?._triggerAceConcentrationCheck) {
                      await DamageApplicator._triggerAceConcentrationCheck(actor, damageDealt);
                    }
                  } catch (err) {
                    console.warn(`${MODULE_ID} | global concentration check threw (non-fatal):`, err);
                  }
                })();
              }, 0);
            }
            return result;
          } finally {
            _patchActive.delete(this);
          }
        };
        console.debug(`${MODULE_ID} | Actor.update patched (re-entrancy-guarded) — vanilla dnd5e concentration suppressed + ACE concentration check fires globally on HP drops`);
      }
    } catch (err) {
      console.warn(`${MODULE_ID} | Actor.update patch failed (non-fatal):`, err);
    }
  } catch (err) {
    console.error(`${MODULE_ID} | concentration-check wiring init failed:`, err);
  }

  // ─── v0.7.21: One-time cleanup of malformed dependentOn data ─────────────
  // Earlier BuffResolver writes used an array-of-objects format for
  // flags.dnd5e.dependentOn that dnd5e 5.x's DependentsRegistry can't parse —
  // produces "Failed data preparation ... Cannot read properties of null
  // (reading 'effects')" errors every prepareData cycle. Sweep once on ready,
  // unset anything that isn't a valid UUID string. Idempotent.
  Hooks.once("ready", async () => {
    if (!game.user.isGM) return;
    try {
      let fixedCount = 0;
      for (const actor of game.actors?.contents ?? []) {
        for (const eff of actor.effects ?? []) {
          const dep = eff.flags?.dnd5e?.dependentOn;
          // Valid: string starting with a document class name. Invalid: array, object, undefined garbage.
          if (dep !== undefined && dep !== null && (typeof dep !== "string" || dep.length < 16)) {
            try {
              await eff.update({ "flags.dnd5e.-=dependentOn": null });
              fixedCount++;
            } catch (_) { /* non-fatal */ }
          }
        }
      }
      // Same sweep across scene tokens (unlinked actors live there)
      for (const scene of game.scenes?.contents ?? []) {
        for (const token of scene.tokens ?? []) {
          if (token.actorLink) continue;  // linked → handled above
          const actor = token.actor;
          if (!actor) continue;
          for (const eff of actor.effects ?? []) {
            const dep = eff.flags?.dnd5e?.dependentOn;
            if (dep !== undefined && dep !== null && (typeof dep !== "string" || dep.length < 16)) {
              try {
                await eff.update({ "flags.dnd5e.-=dependentOn": null });
                fixedCount++;
              } catch (_) { /* non-fatal */ }
            }
          }
        }
      }
      if (fixedCount > 0) {
        console.log(`${MODULE_ID} | dependentOn cleanup: unset ${fixedCount} malformed flag(s) — dnd5e dependent registry errors should clear`);
      }
    } catch (err) {
      console.warn(`${MODULE_ID} | dependentOn cleanup threw (non-fatal):`, err);
    }
  });

  // ─── v0.7.21: Clear stale targets on turn change ─────────────────────────
  // Fireball-style template-save spells leave game.user.targets populated
  // for every token inside the template. If the GM doesn't click APPLY ALL
  // (the damage-applicator's clear path), or just casts another spell
  // mid-resolution, the targets persist across the whole encounter. Turn
  // change is the natural reset point — by then either the spell resolved
  // or the user moved on. GM-side only (player targets are their own
  // tactical planning, don't stomp on them).
  try {
    Hooks.on("combatTurnChange", () => {
      try {
        if (!game.user.isGM) return;
        const targets = [...(game.user?.targets ?? [])];
        if (!targets.length) return;
        for (const t of targets) {
          t.setTarget?.(false, { user: game.user, releaseOthers: false, groupSelection: false });
        }
        game.user?.targets?.clear?.();
        console.debug(`${MODULE_ID} | turn-change: cleared ${targets.length} stale target(s)`);
      } catch (err) {
        console.warn(`${MODULE_ID} | turn-change target clear failed (non-fatal):`, err);
      }
    });
    console.debug(`${MODULE_ID} | turn-change target-clear hook registered`);
  } catch (err) {
    console.error(`${MODULE_ID} | turn-change target-clear init failed:`, err);
  }

  // ─── v0.7.21: Auto-select current combatant's token on turn change ────────
  // Foundry's core "Control current combatant" setting can be disabled silently
  // by other modules or per-user toggles, leaving the GM clicking around to
  // find whose turn it is. We own the behavior here so it always works.
  // GM-only; for players, only fires if they own the combatant. Skips if
  // user is currently holding shift (so dragging selections doesn't break).
  try {
    Hooks.on("combatTurnChange", (combat /*, prior, current */) => {
      try {
        // Bail if no live combat or no current combatant
        if (!combat?.started) return;
        const combatant = combat.combatant;
        const tokenId = combatant?.tokenId;
        if (!tokenId) return;

        // Permission gate — GM always; players only if they own the actor
        const actor = combatant.actor;
        const isOwner = actor?.testUserPermission?.(game.user, "OWNER");
        if (!game.user.isGM && !isOwner) return;

        // Get the canvas token (the document → token mapping)
        const token = canvas?.tokens?.get?.(tokenId);
        if (!token) return;

        // Skip if user has shift held (preserving manual multi-select)
        if (game.keyboard?.isModifierActive?.("Shift")) return;

        // Already controlled? skip the no-op
        if (token.controlled && canvas.tokens.controlled.length === 1) return;

        token.control({ releaseOthers: true });
        // Also pan camera if the token is off-screen and ace-qol pan-on-turn
        // is enabled (default ON). Uses Foundry's canvas.animatePan.
        try {
          const center = token.center;
          const screen = canvas.screenDimensions;
          const view = canvas.stage.toLocal({ x: screen[0] / 2, y: screen[1] / 2 });
          // crude off-screen check — pan if more than 60% of half-screen away
          const dx = Math.abs(center.x - view.x);
          const dy = Math.abs(center.y - view.y);
          if (dx > screen[0] * 0.4 || dy > screen[1] * 0.4) {
            canvas.animatePan({ x: center.x, y: center.y, duration: 300 });
          }
        } catch (_) { /* non-fatal — pan is convenience, not core */ }

        console.debug(`${MODULE_ID} | turn-change: auto-selected ${token.name}`);
      } catch (err) {
        console.warn(`${MODULE_ID} | turn-change auto-select failed (non-fatal):`, err);
      }
    });
    console.debug(`${MODULE_ID} | turn-change auto-select hook registered`);
  } catch (err) {
    console.error(`${MODULE_ID} | turn-change auto-select init failed:`, err);
  }

  // Duration Tracker — ALL users init hooks, but only GM processes expirations
  try {
    durationTracker = new DurationTracker();
    durationTracker.init();
    DurationTracker.registerAPI(durationTracker);
    console.debug(`${MODULE_ID} | Duration Tracker online`);
  } catch (err) {
    console.error(`${MODULE_ID} | Duration Tracker init failed:`, err);
  }

  // Repeating Save Engine — GM-only (it gates internally). Handles RAW
  // end-of-turn re-saves for Hold Person, Banishment, Tasha's, etc.
  try {
    RepeatingSaveEngine.init();
  } catch (err) {
    console.error(`${MODULE_ID} | Repeating Save Engine init failed:`, err);
  }

  // Break-Free Engine — action-to-escape for restrain-type effects (Entangling
  // Rope, Net, Entangle). Prompts the trapped creature at the start of its turn.
  try {
    BreakFreeEngine.init();
  } catch (err) {
    console.error(`${MODULE_ID} | Break-Free Engine init failed:`, err);
  }

  // Transformation Engine — GM-only. Wraps dnd5e transformInto/revertOriginalForm
  // and handles Polymorph spell + trap, True Polymorph, Wild Shape, lycanthropy,
  // innate shapechangers, and item-driven transformations through one pipeline.
  try {
    TransformationEngine.init();
  } catch (err) {
    console.error(`${MODULE_ID} | Transformation Engine init failed:`, err);
  }

  // Concentration on Damage — GM-only. Hooks dnd5e.preApplyDamage; if the
  // damaged actor is concentrating, fires actor.challengeConcentration with
  // DC = max(10, floor(damage / 2)). RAW PHB 203.
  try {
    ConcentrationDamage.init();
  } catch (err) {
    console.error(`${MODULE_ID} | Concentration Damage init failed:`, err);
  }

  // Bonus Action Spell Rule — RAW PHB 202: a bonus-action leveled spell
  // limits the rest of the turn to a single 1-action cantrip. Pre-flight
  // check via dnd5e.preUseActivity; tracks per-actor cast state per turn.
  try {
    BonusSpellRule.init();
  } catch (err) {
    console.error(`${MODULE_ID} | Bonus Spell Rule init failed:`, err);
  }

  // Non-Proficient Armor Spell Block — RAW PHB p.144: a PC wearing armor
  // they lack proficiency with cannot cast spells. Pre-flight check via
  // dnd5e.preUseActivity that cancels the activity before dialog or
  // usage message fires. Pairs with the attack-roll disadvantage check
  // in combat-state.assess (v0.7.6).
  try {
    ArmorProfSpellBlock.init();
  } catch (err) {
    console.error(`${MODULE_ID} | Armor-Prof Spell Block init failed:`, err);
  }

  // Class Feature Riders (turn-based reset) — clears the once-per-turn flag
  // for features like Radiant Soul (Celestial Warlock 6+) when this actor's
  // turn ends. Same pattern as BonusSpellRule's combatTurnChange handler:
  // we read the PRIOR combatant's actor (the one whose turn just ended) and
  // unset their feature-rider flags. Belt-and-suspenders cleanup also runs
  // on deleteCombat in case state survives a combat ending.
  try {
    Hooks.on("combatTurnChange", (combat, prior /*, current */) => {
      if (game.users?.activeGM !== game.user) return;  // activeGM: flag clears + Hexblade/CritDebuff expiry must only run once
      try {
        // Resolve the prior combatant (the one whose turn just ended).
        // Prefer combat.previous.combatantId (the canonical position
        // marker dnd5e maintains), fall back to the hook's `prior` arg
        // (passed by Foundry core) if `previous` is null — happens during
        // mid-round GM interventions, held actions reasserting, certain
        // initiative-edit operations, and other combat state transitions
        // where the previous-position marker isn't populated. Grok audit
        // catch (v0.7.8).
        const priorCombatantId = combat?.previous?.combatantId
                              ?? prior?.combatantId
                              ?? null;
        const priorActorId = priorCombatantId
          ? combat?.combatants?.get?.(priorCombatantId)?.actorId
          : null;
        if (priorActorId) {
          const priorActor = game.actors.get(priorActorId);
          if (priorActor) {
            CombatState.clearRadiantSoulFlag(priorActor).catch(() => {});
            CombatState.clearDivineStrikeFlag(priorActor).catch(() => {});
            CombatState.clearDivineSmiteFlag(priorActor).catch(() => {});
            CombatState.clearEldritchSmiteFlag(priorActor).catch(() => {});
            CombatState.clearSneakAttackFlag(priorActor).catch(() => {});
            FeatEffects.clearOncePerTurnFlags(priorActor).catch(() => {});
          }
        }
        // Hexblade's Curse — RAW 1-minute (10-round) duration.
        CombatState.expireHexbladeCursesIfDue().catch(() => {});
        FeatEffects.expireCritDebuffsIfDue().catch(() => {});
      } catch (_) { /* non-fatal */ }
    });
    // Also clear all once-per-turn flags on combat START — protects against
    // flags getting stuck from out-of-combat testing or a session-crash mid-turn.
    // Without this, an actor who fired Sneak Attack out of combat could enter
    // their next combat with the flag pre-set and have round 1 Sneak Attack
    // silently blocked.
    Hooks.on("combatStart", (combat) => {
      if (game.users?.activeGM !== game.user) return;  // activeGM: flag clears on start must only run once
      try {
        for (const c of combat?.combatants?.contents ?? []) {
          if (c.actor) {
            CombatState.clearRadiantSoulFlag(c.actor).catch(() => {});
            CombatState.clearDivineStrikeFlag(c.actor).catch(() => {});
            CombatState.clearDivineSmiteFlag(c.actor).catch(() => {});
            CombatState.clearEldritchSmiteFlag(c.actor).catch(() => {});
            CombatState.clearSneakAttackFlag(c.actor).catch(() => {});
            FeatEffects.clearOncePerTurnFlags(c.actor).catch(() => {});
          }
        }
      } catch (_) { /* non-fatal */ }
    });
    Hooks.on("deleteCombat", (combat) => {
      if (game.users?.activeGM !== game.user) return;  // activeGM: flag clears + Hexblade expiry on end must only run once
      try {
        for (const c of combat?.combatants?.contents ?? []) {
          if (c.actor) {
            CombatState.clearRadiantSoulFlag(c.actor).catch(() => {});
            CombatState.clearDivineStrikeFlag(c.actor).catch(() => {});
            CombatState.clearDivineSmiteFlag(c.actor).catch(() => {});
            CombatState.clearEldritchSmiteFlag(c.actor).catch(() => {});
            CombatState.clearSneakAttackFlag(c.actor).catch(() => {});
            FeatEffects.clearOncePerTurnFlags(c.actor).catch(() => {});
          }
        }
        CombatState.expireHexbladeCursesIfDue().catch(() => {});
      } catch (_) { /* non-fatal */ }
    });
    console.debug(`${MODULE_ID} | Class feature rider turn-reset hooks registered (Radiant Soul, Divine Strike, Divine Smite, Eldritch Smite, Sneak Attack).`);
  } catch (err) {
    console.error(`${MODULE_ID} | Class feature rider hook setup failed:`, err);
  }

  // Hexblade's Curse — auto-clear on cursed target death + heal-on-kill.
  // Listens to the existing ace-qol.npcDeath hook (fired by the death pipeline
  // when any NPC's HP reaches 0). Scans all actors for a matching curse flag;
  // calls CombatState.removeHexbladeCurse with cursedTargetDied=true so the
  // Hexblade warlock regains HP = warlock level + CHA mod (RAW heal-on-kill).
  try {
    Hooks.on(`${MODULE_ID}.npcDeath`, ({ actor, tokenDoc }) => {
      if (!game.user.isGM) return;
      try {
        const deadUuid = tokenDoc?.uuid;
        if (!deadUuid) return;
        for (const a of game.actors?.contents ?? []) {
          const curse = a?.getFlag?.(MODULE_ID, "hexbladeCurse");
          if (!curse || typeof curse !== "object") continue;
          if (curse.targetUuid !== deadUuid) continue;
          CombatState.removeHexbladeCurse(a, { cursedTargetDied: true }).catch(err => {
            console.warn(`${MODULE_ID} | Hexblade curse heal-on-kill failed for ${a.name}:`, err);
          });
        }
      } catch (err) {
        console.warn(`${MODULE_ID} | Hexblade death-hook failed:`, err);
      }
    });
    console.debug(`${MODULE_ID} | Hexblade's Curse heal-on-kill hook registered.`);
  } catch (err) {
    console.error(`${MODULE_ID} | Hexblade hook setup failed:`, err);
  }

  // Hexblade's Curse — auto-clear when the attacker becomes incapacitated.
  // RAW: "The curse ends early if [...] you die or are incapacitated."
  // Two trigger paths:
  //   (a) Attacker's HP hits 0     → updateActor hook below
  //   (b) Incapacitating status    → createActiveEffect hook below
  //                                   (stunned, paralyzed, petrified, etc.)
  // GM-only so the cleanup is idempotent (one client running the heal/clear).
  try {
    Hooks.on("updateActor", (actor, changes /*, opts, userId */) => {
      if (game.users?.activeGM !== game.user) return;  // activeGM: Hexblade curse clear must only run once
      try {
        const hpUpdate = foundry.utils.getProperty(changes, "system.attributes.hp.value");
        if (hpUpdate === undefined || hpUpdate > 0) return;
        if (!actor?.getFlag?.(MODULE_ID, "hexbladeCurse")) return;
        CombatState.clearHexbladeCurseIfIncapacitated(actor).catch(() => {});
      } catch (err) {
        console.warn(`${MODULE_ID} | Hexblade incapacitation HP-hook failed:`, err);
      }
    });

    Hooks.on("createActiveEffect", (effect /*, opts, userId */) => {
      if (game.users?.activeGM !== game.user) return;  // activeGM: Hexblade incapacitation check must only run once
      try {
        const actor = effect?.parent;
        if (!actor?.getFlag?.(MODULE_ID, "hexbladeCurse")) return;
        // Active-effect statuses are stored as a Set on the effect; the actor
        // composite `actor.statuses` updates async after this hook. Read off
        // the freshly-created effect directly.
        const statuses = effect?.statuses ?? new Set();
        const INCAP = ["incapacitated", "stunned", "paralyzed", "petrified", "unconscious", "dead"];
        const incap = INCAP.some(s => statuses.has?.(s));
        if (!incap) return;
        CombatState.clearHexbladeCurseIfIncapacitated(actor).catch(() => {});
      } catch (err) {
        console.warn(`${MODULE_ID} | Hexblade incapacitation status-hook failed:`, err);
      }
    });
    console.debug(`${MODULE_ID} | Hexblade's Curse incapacitation hooks registered (HP=0, stunned/paralyzed/etc).`);
  } catch (err) {
    console.error(`${MODULE_ID} | Hexblade incapacitation hook setup failed:`, err);
  }

  // Hexblade's Curse — auto-apply when the player activates the feature.
  // Detection: any dnd5e activity whose item name contains both "hexblade"
  // and "curse". The activator's currently-targeted token becomes the curse
  // target (RAW: "choose one creature you can see within 30 feet"). Runs only
  // on the activator's client — they have ownership of their own actor, so
  // setFlag succeeds locally and replicates to everyone.
  //
  // If no target is selected, we don't fail silently — a chat-card hint tells
  // the player to target first and reactivate.
  try {
    Hooks.on("dnd5e.postCreateUsageMessage", async (activity, message) => {
      try {
        // Only the user who activated runs this; otherwise the curse would be
        // re-applied N times (once per connected client).
        if (message?.author?.id && message.author.id !== game.user.id) return;

        const item = activity?.item;
        if (!item) return;
        const nameNorm = String(item.name ?? "").toLowerCase();
        const actor = item.actor;
        if (!actor) return;

        // Hexblade's Curse — auto-apply
        if (nameNorm.includes("hexblade") && nameNorm.includes("curse")) {
          const targetToken = game.user.targets?.first?.();
          if (!targetToken) {
            ui.notifications?.warn(
              `Hexblade's Curse: target a creature first (mouse-over + T), then re-activate the feature.`
            );
            return;
          }
          await CombatState.applyHexbladeCurse(actor, targetToken);
          return;
        }

        // Hex spell — auto-apply on cast. Detection: spell named "Hex"
        // (exact match — avoid catching "Hexblade's Curse" which is handled
        // above and has its own apply).
        if (item.type === "spell" && nameNorm === "hex") {
          const targetToken = game.user.targets?.first?.();
          if (!targetToken) {
            ui.notifications?.warn(
              `Hex: target a creature first (mouse-over + T), then re-cast the spell.`
            );
            return;
          }
          await CombatState.applyHex(actor, targetToken);
          return;
        }

        // ── Generic spell-cast auto-apply (v0.7.15) ──
        // Look up the spell name in SPELL_AUTO_APPLY. If a match exists, the
        // condition-library has a ready-to-go effect template for this spell
        // (Bless, Bane, Haste, Faerie Fire, Mage Armor, Stoneskin, Mirror
        // Image, etc.). Apply to caster (self) or picked target(s) and link
        // to the caster's Concentrating effect via dnd5e.dependentOn.
        //
        // For multi-target spells (Bless up to 3, Slow up to 6, etc.) the
        // SpellTargetPicker opens a portrait grid so the caster can pick
        // exactly which creatures to affect. Single-target spells use the
        // currently-targeted token if present, otherwise the picker too.
        if (item.type === "spell") {
          // ── v0.7.21: SpellPipeline ownership guard ──
          // If the new unified spell pipeline owns this spell (registry
          // entry exists), let IT handle the cast end-to-end. Without
          // this guard, Haste / Bless / Mage Armor / etc. get processed
          // by BOTH systems → double picker, double effect application.
          // The pipeline's resolver runs in postCreateUsageMessage, which
          // also fires this code path — hence the explicit ownership check.
          const pipeline = globalThis.game?.aceQol?.SpellPipeline;
          if (pipeline?.ownsSpell?.(item)) {
            console.log(`${MODULE_ID} | ${item.name}: skipping legacy auto-apply (SpellPipeline owns this spell)`);
            return;
          }

          // ── v0.7.21: Counterspell barrier for legacy auto-apply ──
          // The pipeline path checks the reaction barrier and tears down
          // concentration on abort. The LEGACY path didn't — meaning if a
          // spell only in SPELL_AUTO_APPLY (not yet in pipeline registry)
          // got counterspelled, the buff still applied. Same guard here.
          try {
            const { ReactionEngine } = await import("./reaction-engine.mjs");
            const result = await ReactionEngine.awaitCastBarrier(activity);
            if (result?.abort) {
              console.log(`${MODULE_ID} | ${item.name}: legacy auto-apply aborted — ${result.reason}`);
              try {
                if (pipeline?._endConcentrationForCancelledSpell) {
                  await pipeline._endConcentrationForCancelledSpell(actor, item);
                }
              } catch (_) { /* non-fatal */ }
              return;
            }
          } catch (_) { /* non-fatal — proceed with cast */ }

          const lookupKey = nameNorm.replace(/['']/g, "").trim();
          const dispatch = SPELL_AUTO_APPLY[lookupKey];
          if (dispatch) {
            let targets = [];

            if (dispatch.target === "self") {
              // Self-target spells (Searing Smite, Mirror Image, Blur, etc.)
              targets = [actor];

            } else {
              // "targets" mode — pick via the SpellTargetPicker UI
              const maxTargets = dispatch.maxTargets ?? 6;
              targets = await SpellTargetPicker.pick({
                spellItem: item,
                casterActor: actor,
                maxTargets,
                allowSelf: true,
              });
              if (!targets || targets.length === 0) {
                console.log(`${MODULE_ID} | ${item.name}: target selection cancelled — no auto-apply.`);
                return;
              }
            }

            if (!targets.length) {
              console.warn(`${MODULE_ID} | ${item.name}: no valid target actors resolved for auto-apply.`);
              return;
            }

            // Apply the library effect to each target with concentration link.
            for (const targetActor of targets) {
              await _applySpellEffectWithConcentration(targetActor, dispatch.key, actor, item);
            }
            return;
          }
        }
      } catch (err) {
        console.warn(`${MODULE_ID} | spell-activation auto-apply hook failed:`, err);
      }
    });
    console.debug(`${MODULE_ID} | Spell auto-apply hook registered: Hexblade's Curse + Hex + ${Object.keys(SPELL_AUTO_APPLY).length} dispatched library spells.`);

    // Hex — auto-clear when concentration ends (the "Hex" Active Effect on the
    // caster is deleted, either by the concentration widget, by casting a new
    // concentration spell, or by manual removal).
    Hooks.on("deleteActiveEffect", (effect /*, opts, userId */) => {
      if (game.users?.activeGM !== game.user) return;  // activeGM: Hex cleanup must only run once
      try {
        const name = String(effect?.name ?? "").toLowerCase();
        if (name !== "hex") return;
        const actor = effect?.parent;
        if (!actor?.getFlag?.(MODULE_ID, "hex")) return;
        CombatState.removeHex(actor, { reason: "concentration ended" }).catch(() => {});
      } catch (err) {
        console.warn(`${MODULE_ID} | Hex effect-delete hook failed:`, err);
      }
    });
  } catch (err) {
    console.error(`${MODULE_ID} | Spell auto-apply hook setup failed:`, err);
  }

  // ── Spell feature riders for ATTACK-based spells + Pact-of-the-Blade type ──
  // Combined prototype patch on the attack-activity rollDamage method:
  //
  //   1. Empowered Evocation / Agonizing Blast / Potent Spellcasting:
  //      add stat-mod bonuses to spell damage (Eldritch Blast, Fire Bolt, etc.).
  //
  //   2. Pact of the Blade (2024 PHB): "You can cause the weapon to deal
  //      Necrotic, Psychic, or Radiant damage or its normal damage type."
  //      Player's preference is stored as actor flag and applied to every
  //      damage roll of the actor's pact weapon (any weapon item).
  //
  // Both layers run in the same patch since they target the same prototype.
  // Idempotent via flag. Mirrors SpellAutoDamage's rollDamage patch pattern.
  // Defer the prototype patch until the warlock-damage-chooser module has
  // loaded. We need its hasPactOfTheBlade + getPactBladeType helpers inside
  // the patched function. Using import().then() instead of await because the
  // surrounding `ready` hook callback is not declared async.
  import("./warlock-damage-chooser.mjs").then(({ hasPactOfTheBlade, getPactBladeType }) => {
  try {
    const attackActivityClass = CONFIG.DND5E?.activityTypes?.attack?.documentClass;
    if (attackActivityClass?.prototype && !attackActivityClass.prototype._aceQolSpellRiderPatched) {
      const original = attackActivityClass.prototype.rollDamage;
      attackActivityClass.prototype.rollDamage = async function (...args) {
        const rolls = await original.apply(this, args);
        try {
          const item = this?.item;
          const actor = item?.actor ?? this?.actor;
          if (!actor || !Array.isArray(rolls) || rolls.length === 0) return rolls;

          // ── Layer 1: spell feature riders (only for spell items) ──
          if (item?.type === "spell") {
            const empoweredBonus = CombatState.getEmpoweredEvocationBonus(actor, item);
            const potentBonus    = CombatState.getPotentSpellcastingBonus(actor, item);
            const agonizingBonus = CombatState.getAgonizingBlastBonus(actor, item);
            for (let i = 0; i < rolls.length; i++) {
              const roll = rolls[i];
              if (!roll) continue;
              let bonus = 0;
              if (i === 0) bonus += empoweredBonus + potentBonus;
              bonus += agonizingBonus;
              if (bonus <= 0) continue;
              roll._total = Number(roll._total ?? roll.total ?? 0) + bonus;
              roll.options = roll.options ?? {};
              roll.options.aceQolFeatureRiders = roll.options.aceQolFeatureRiders ?? [];
              if (i === 0 && empoweredBonus > 0) roll.options.aceQolFeatureRiders.push({ name: "Empowered Evocation", bonus: empoweredBonus });
              if (i === 0 && potentBonus > 0)    roll.options.aceQolFeatureRiders.push({ name: "Potent Spellcasting", bonus: potentBonus });
              if (agonizingBonus > 0)            roll.options.aceQolFeatureRiders.push({ name: "Agonizing Blast", bonus: agonizingBonus });
              console.log(`${MODULE_ID} | Spell rider (attack path): +${bonus} added to ${item.name} damage roll ${i}`);
            }
          }

          // ── Layer 2: Pact of the Blade damage type override ──
          // Applies to any WEAPON attack from a Warlock with Pact of the Blade
          // whose stored preference != "weapon" (default). When set to
          // necrotic/psychic/radiant, overwrite the rolls' damage type so the
          // resistance/immunity pipeline applies the right reductions later.
          if (item?.type === "weapon" && hasPactOfTheBlade(actor)) {
            const preferredType = getPactBladeType(actor);
            if (preferredType && preferredType !== "weapon") {
              for (const roll of rolls) {
                if (!roll) continue;
                roll.options = roll.options ?? {};
                // dnd5e 5.x stores damage type on roll.options.type (singular)
                // OR roll.options.types (array). Update both for robustness.
                const originalType = roll.options.type ?? roll.options.types?.[0];
                roll.options.type = preferredType;
                if (Array.isArray(roll.options.types)) {
                  roll.options.types = [preferredType];
                }
                roll.options.aceQolPactBladeOverride = { from: originalType, to: preferredType };
              }
              console.log(`${MODULE_ID} | Pact of the Blade: ${actor.name}'s ${item.name} damage type ${preferredType} (player preference)`);
            }
          }
        } catch (err) {
          console.warn(`${MODULE_ID} | Spell-rider attack-path patch failed (non-fatal):`, err);
        }
        return rolls;
      };
      attackActivityClass.prototype._aceQolSpellRiderPatched = true;
      console.log(`${MODULE_ID} | Spell rider + Pact-of-Blade attack-path patch applied`);
    }
  } catch (err) {
    console.warn(`${MODULE_ID} | Spell rider attack-path patch setup failed:`, err);
  }
  }).catch(err => console.warn(`${MODULE_ID} | Warlock chooser module import failed:`, err));

  // ── Public API: Warlock damage type chooser dialog ──
  // Players invoke via game.aceQol.openWarlockChooser(actor) — opens a dialog
  // letting them set Pact of the Blade + Lifedrinker damage type preferences.
  import("./warlock-damage-chooser.mjs").then(({ openWarlockDamageDialog }) => {
    globalThis.game = globalThis.game ?? {};
    game.aceQol = game.aceQol ?? {};
    game.aceQol.openWarlockChooser = (actor) => {
      const target = actor ?? game.user?.character ?? canvas.tokens?.controlled?.[0]?.actor;
      return openWarlockDamageDialog(target);
    };
    console.debug(`${MODULE_ID} | Warlock damage chooser API exposed at game.aceQol.openWarlockChooser`);
  }).catch(err => console.warn(`${MODULE_ID} | Warlock chooser API exposure failed:`, err));

  // ── Public API: Multi-type damage chooser dialog ──
  // Players invoke via game.aceQol.openMultiTypeChooser(actor) — opens a
  // dialog listing every weapon/item they own that offers a damage-type
  // choice (Blood Halberd, Holy Avenger, Dragon's Wrath, etc.) with a
  // dropdown per item to set the preferred type. Sticky — once set, all
  // future attacks with that weapon use the chosen type until changed.
  import("./multi-type-damage-chooser.mjs").then(({ openMultiTypeChooser }) => {
    globalThis.game = globalThis.game ?? {};
    game.aceQol = game.aceQol ?? {};
    game.aceQol.openMultiTypeChooser = (actor) => {
      const target = actor ?? game.user?.character ?? canvas.tokens?.controlled?.[0]?.actor;
      return openMultiTypeChooser(target);
    };
    console.debug(`${MODULE_ID} | Multi-type damage chooser API exposed at game.aceQol.openMultiTypeChooser`);
  }).catch(err => console.warn(`${MODULE_ID} | Multi-type chooser API exposure failed:`, err));

  // ── Actor sheet button — adds "Warlock Damage Types" to the dnd5e item
  // context menu so players can find the chooser without a console command.
  Hooks.on("dnd5e.getItemContextOptions", (item, options) => {
    try {
      if (!item?.actor) return;
      // Only show on items that belong to a Warlock (pact items typically)
      const itemName = String(item.name ?? "").toLowerCase();
      if (!itemName.includes("pact of the blade") && !itemName.includes("lifedrinker")) return;
      options.push({
        name: "ACE: Warlock damage types…",
        icon: '<i class="fa-solid fa-flask-vial"></i>',
        condition: () => true,
        callback: async () => {
          const { openWarlockDamageDialog } = await import("./warlock-damage-chooser.mjs");
          openWarlockDamageDialog(item.actor);
        },
      });
    } catch (err) {
      console.warn(`${MODULE_ID} | Warlock chooser context menu hook failed:`, err);
    }
  });

  // Death Saves — RAW PHB 197. Auto-roll death save at PC turn start;
  // massive-damage instant-death check; reset tally on heal.
  try {
    DeathSaves.init();
  } catch (err) {
    console.error(`${MODULE_ID} | Death Saves init failed:`, err);
  }

  // Stealth Engine — surprise at combat start, Hide action, attack-from-hidden
  // advantage, hide reveals on attack/damage. RAW PHB 192-194 + 175.
  try {
    StealthEngine.init();
  } catch (err) {
    console.error(`${MODULE_ID} | Stealth Engine init failed:`, err);
  }

  // Combat Actions — Disengage / Dodge / Help / Ready API + auto-cleanup at
  // start of next turn. RAW PHB 192-193.
  try {
    CombatActions.init();
  } catch (err) {
    console.error(`${MODULE_ID} | Combat Actions init failed:`, err);
  }

  // Fumble Engine — optional natural-1 fumble table (NOT RAW, off by default).
  try {
    FumbleEngine.init();
  } catch (err) {
    console.error(`${MODULE_ID} | Fumble Engine init failed:`, err);
  }

  // Opportunity Attack Prompt — detects provoking movement, prompts GM to
  // take an OA on behalf of the reacting creature. PHB 195.
  try {
    OAPrompt.init();
  } catch (err) {
    console.error(`${MODULE_ID} | OA Prompt init failed:`, err);
  }

  // Loadout / Hands enforcement — stops a character equipping more weapons
  // than their hands can hold (makes "equipped" trustworthy for the OA picker
  // and everything else). PC-only; setting `enforceLoadout` (default ON).
  try {
    LoadoutEngine.init();
  } catch (err) {
    console.error(`${MODULE_ID} | Loadout Engine init failed:`, err);
  }

  // Initiative Tools — Roll-All-NPCs / Roll-All-PCs buttons in the combat
  // tracker header.
  try {
    InitiativeTools.init();
  } catch (err) {
    console.error(`${MODULE_ID} | Initiative Tools init failed:`, err);
  }

  // Aura Engine — replaces broken ActiveAuras module (dnd5e 5.x incompat).
  // Self-maintaining: applies/removes aura marker effects on token movement.
  // Catalog: Paladin Auras of Protection / Warding / Courage / Hate /
  // The Guardian, plus generic feature-name detection.
  try {
    AuraEngine.init();
  } catch (err) {
    console.error(`${MODULE_ID} | Aura Engine init failed:`, err);
  }

  // Polymorph Spell Pipeline — GM-only. Detects Polymorph / True Polymorph /
  // Mass Polymorph spell casts, shows form picker, stashes the pick, and
  // routes failed-save outcomes to TransformationEngine via save-engine.
  try {
    PolymorphSpellPipeline.init();
  } catch (err) {
    console.error(`${MODULE_ID} | Polymorph spell pipeline init failed:`, err);
  }

  // Token Image Cache — fast in-memory lookup of beast-name → image-path.
  // Refreshes once at world ready by walking configured folders recursively.
  // Used by transformation-engine to skip TVA's slow doImageSearch on hosted
  // servers. Falls back to TVA if cache miss.
  try {
    TokenCache.init();
  } catch (err) {
    console.error(`${MODULE_ID} | TokenCache init failed:`, err);
  }

  // Flags Engine roll hooks — ALL users (injects adv/dis from flags into ability/skill/tool checks)
  try {
    FlagsEngine.registerRollHooks();
    console.debug(`${MODULE_ID} | Flags roll hooks online`);
  } catch (err) {
    console.error(`${MODULE_ID} | Flags roll hooks init failed:`, err);
  }

  // Speed Rolls — ALL users (intercepts character sheet clicks for fast-forward)
  try {
    speedRolls = new SpeedRolls();
    console.debug(`${MODULE_ID} | Speed rolls online`);
  } catch (err) {
    console.error(`${MODULE_ID} | Speed rolls init failed:`, err);
  }

  // Effects Panel — ALL users (floating list of selected token's active effects)
  try {
    effectsPanel = new EffectsPanel();
    console.debug(`${MODULE_ID} | Effects panel online`);
  } catch (err) {
    console.error(`${MODULE_ID} | Effects panel init failed:`, err);
  }

  // XP Engine — GM only (tracks combat kills, prompts XP distribution at end)
  try {
    xpEngine = new XpEngine();
  } catch (err) {
    console.error(`${MODULE_ID} | XP engine init failed:`, err);
  }

  // Quick Select Tools — GM only (toolbar buttons to select PCs/NPCs/disposition)
  try {
    quickSelectTools = new QuickSelectTools();
  } catch (err) {
    console.error(`${MODULE_ID} | Quick select tools init failed:`, err);
  }

  // Turn Marker — ALL users (rotating marker on canvas + your-turn notif/sound)
  try {
    turnMarker = new TurnMarker();
    console.debug(`${MODULE_ID} | Turn marker online`);
  } catch (err) {
    console.error(`${MODULE_ID} | Turn marker init failed:`, err);
  }

  // Movement Tracker — ALL users (colored squares while dragging tokens)
  try {
    movementTracker = new MovementTracker();
    console.debug(`${MODULE_ID} | Movement tracker online`);
  } catch (err) {
    console.error(`${MODULE_ID} | Movement tracker init failed:`, err);
  }

  // Lootable Tile — ALL users (clickable dead-art tiles → loot dialog)
  try {
    lootableTile = new LootableTile();
  } catch (err) {
    console.error(`${MODULE_ID} | Lootable tile init failed:`, err);
  }

  // Loot Engine — ALL users (players need renderChatMessage hook for public loot cards)
  try {
    lootEngine = new LootEngine();
    LootEngine.registerAPI(lootEngine);

    // Hook: wire loot card interactivity on render (all users)
    Hooks.on("renderChatMessage", (message, html) => {
      try {
        const flags = message.flags?.[MODULE_ID];
        if (flags?.type !== "lootCard") return;
        const el = html instanceof HTMLElement ? html : html?.[0] ?? html;
        if (!el) return;
        lootEngine._wirePublicLootCard(el, message, flags);
      } catch (err) {
        console.error(`${MODULE_ID} | Loot card render hook failed:`, err);
      }
    });

    // Hook: detect items dragged to PC sheets (all users — tracks looting)
    Hooks.on("preCreateItem", async (item, data, context) => {
      try {
        if (!lootEngine) return;
        await lootEngine.handleItemLooted(item, data, context);
      } catch (err) {
        console.error(`${MODULE_ID} | Loot item tracking failed:`, err);
      }
    });

    console.debug(`${MODULE_ID} | Loot engine online`);
  } catch (err) {
    console.error(`${MODULE_ID} | Loot engine init failed:`, err);
  }

  if (game.user.isGM) {
    // Death Pipeline — GM only (converts dead NPC tokens to tiles with dead art)
    try {
      deathPipeline = new DeathPipeline();
      deathPipeline.buildArtCache();
      DeathPipeline.registerAPI(deathPipeline);

      // Rebuild art cache on scene change
      Hooks.on("canvasReady", () => {
        if (deathPipeline) deathPipeline.buildArtCache();
      });

      console.debug(`${MODULE_ID} | Death pipeline online`);
    } catch (err) {
      console.error(`${MODULE_ID} | Death pipeline init failed:`, err);
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  UNIFIED NPC DEATH HOOK — Single updateActor listener for all death logic
    //  Replaces 2 separate hooks (loot + death pipeline). Fires ace-qol.npcDeath
    //  so other modules (Envoy) can listen without their own updateActor hooks.
    // ══════════════════════════════════════════════════════════════════════════

    const _deathProcessed = new Set();  // Guard against double-fire within same update

    Hooks.on("updateActor", async (actor, changes, options, userId) => {
      if (game.users?.activeGM !== game.user) return;  // activeGM: npcDeath hook + death pipeline must only fire once

      // ── Only fire for NPC HP reaching 0 ──
      const hpUpdate = foundry.utils.getProperty(changes, "system.attributes.hp.value");
      if (hpUpdate === undefined || hpUpdate > 0) return;
      if (actor.hasPlayerOwner || actor.type !== "npc") return;

      // ── Guard: skip if max HP is 0 (invalid actor) ──
      const maxHP = actor.system?.attributes?.hp?.max ?? 0;
      if (maxHP <= 0) return;

      // ── Find the token on the current scene ──
      // For synthetic actors (unlinked tokens, most NPCs), `actor.token` points
      // DIRECTLY at the parent TokenDocument. Using find() against the scene is
      // ambiguous when the same prototype has multiple tokens — find() returns
      // the FIRST match, and a sibling clone may resolve to the wrong token.
      // Prefer the direct lookup; fall back to scan only for fully linked actors.
      let tokenDoc = actor?.token ?? null;
      if (!tokenDoc) {
        tokenDoc = canvas.scene?.tokens?.find(t =>
          t.actor?.id === actor.id || t.actorId === actor.id
        );
      }

      // ── Polymorph defer (RAW: polymorphed creature reverts at 0 HP) ──
      // If the dying actor is currently polymorphed, DO NOT fire NPC death
      // logic. The polymorph engine handles this 0-HP event (revert +
      // carryover). If the carryover damage drops the ORIGINAL form to 0
      // too, a new updateActor will fire → re-enters this hook with the
      // polymorph state/effect cleared, and the death pipeline runs cleanly.
      //
      // Multi-signal check (defensive — getFlag has shown intermittent races
      // in V13 for synthetic actors during simultaneous DB writes):
      //   1. flag check: transformState.revertOnZeroHP === true
      //   2. effect check: any active effect flagged polymorphEffect === true
      //   3. raw flags check: actor.flags["ace-qol"].transformState present
      // If ANY signal says "polymorphed", defer. False positives are safer
      // than false negatives here — the worst case of a false defer is the
      // death pipeline never running, which is recoverable. The worst case
      // of a false negative is the cleanup race we're trying to prevent.
      try {
        const flagState = actor?.getFlag?.(MODULE_ID, "transformState");
        const rawFlag   = actor?.flags?.[MODULE_ID]?.transformState;
        const polyEff   = actor.effects?.contents?.some?.(e =>
                            e?.flags?.[MODULE_ID]?.polymorphEffect === true && !e.disabled);
        const isPolymorphed = (flagState && flagState.revertOnZeroHP !== false)
                           || (rawFlag   && rawFlag.revertOnZeroHP   !== false)
                           || polyEff;
        if (isPolymorphed) {
          console.log(`${MODULE_ID} | NPC death deferred — ${actor.name} is polymorphed (flag=${!!flagState}, raw=${!!rawFlag}, eff=${polyEff}); revert pipeline owns this 0-HP event`);
          return;
        }
      } catch (err) {
        console.warn(`${MODULE_ID} | polymorph-defer guard threw — falling through:`, err);
      }

      // ── Guard: deduplicate within the same Foundry update cycle ──
      // Dedupe by the resolved token's UUID (unique per scene token) instead
      // of actor.id. For unlinked tokens, `actor.id` collides with the base
      // actor's id — meaning a linked clone dying first would lock out an
      // unlinked clone of the same prototype that dies right after. Using
      // tokenDoc.uuid keeps each individual token's death event distinct.
      // Fall back to actor.uuid if the token couldn't be resolved.
      const dedupeKey = tokenDoc?.uuid ?? actor?.uuid ?? actor.id;
      if (_deathProcessed.has(dedupeKey)) return;
      _deathProcessed.add(dedupeKey);
      setTimeout(() => _deathProcessed.delete(dedupeKey), 2000);

      // ── Determine killer from recent chat messages ──
      let killerName = "";
      try {
        const recentMsgs = game.messages?.contents?.slice(-5) ?? [];
        for (const msg of recentMsgs.reverse()) {
          if (msg.rolls?.length && msg.speaker?.alias) {
            const speakerActor = game.actors?.get(msg.speaker?.actor);
            if (speakerActor?.hasPlayerOwner) {
              killerName = msg.speaker.alias;
              break;
            }
          }
        }
      } catch (err) { console.debug("ace-qol | NPC death killer-search best-effort:", err); }

      console.log(`${MODULE_ID} | NPC death detected: ${actor.name}${killerName ? ` (killed by ${killerName})` : ""}`);

      // ── Step 1: Loot generation (before token might be removed) ──
      try {
        if (lootEngine
            && game.settings.get(MODULE_ID, "enableLootGeneration")
            && game.settings.get(MODULE_ID, "lootOnDeath")) {
          const cr = actor.system.details?.cr ?? 0;
          const minCR = game.settings.get(MODULE_ID, "minCRForLoot") ?? 0.25;
          if (cr >= minCR) {
            await lootEngine.checkAndGenerateOnDeath(actor);
          }
        }
      } catch (err) {
        console.error(`${MODULE_ID} | Loot on death failed:`, err);
      }

      // ── Step 2: Death pipeline (dead art tile conversion) ──
      if (tokenDoc && deathPipeline) {
        try {
          await deathPipeline.processNPCDeath(actor, tokenDoc);
        } catch (err) {
          console.error(`${MODULE_ID} | Death pipeline failed:`, err);
        }
      }

      // ── Step 3: Fire custom hook for other modules (Envoy, Engine, etc.) ──
      // This fires AFTER QOL's own processing so the token still existed
      // during loot/dead-art steps. Listeners get full context.
      Hooks.callAll("ace-qol.npcDeath", {
        actor,
        tokenDoc:   tokenDoc ?? null,
        changes,
        killerName,
        maxHP,
        options,
        userId,
      });

      // ── Cross-module contract: killLogged ──
      // Provides richer kill context for ace-engine (faction standing), ace-envoy
      // (witness reactions), and macros. attacker is resolved from killerName if
      // possible — null when the kill source can't be determined from chat history.
      Hooks.callAll(`${MODULE_ID}.killLogged`, {
        victim:     actor,
        attacker:   killerName ? (game.actors?.getName(killerName) ?? null) : null,
        killerName,
        attackItem: null,
        xp:         Number(actor.system?.details?.xp?.value ?? actor.system?.details?.xp ?? 0),
        isMassive:  false,
      });
    });

    console.debug(`${MODULE_ID} | Unified NPC death hook registered`);

    // ══════════════════════════════════════════════════════════════════════════
    //  REVIVE HOOK — HP restored above 0 → reverse the death pipeline
    //  Listens for any actor's HP going from 0 back to positive, reads the
    //  preDeath snapshot stored on the token by processNPCDeath, and restores:
    //    - The token's original texture (image)
    //    - The token's original dimensions and tint
    //    - The actor's original ownership levels (player access)
    //    - Clears all death-related flags so the token is "alive" again
    //  Vorpal / permanent-death victims have `permanentlyDead: true` on their
    //  flags — those bypass the revive entirely so the visual stays dead even
    //  if a GM accidentally bumps HP. Only manual GM override (button on the
    //  SEVERED card, actor sheet, or right-click menu) or strict-RAW
    //  resurrection magic clears the permanent flag.
    // ══════════════════════════════════════════════════════════════════════════
    Hooks.on("updateActor", async (actor, changes, options, userId) => {
      if (game.users?.activeGM !== game.user) return;  // activeGM: revive pipeline must only run once
      try {
        const hpUpdate = foundry.utils.getProperty(changes, "system.attributes.hp.value");
        if (hpUpdate === undefined || Number(hpUpdate) <= 0) return;

        // Find the token. Same logic as the death hook above.
        let tokenDoc = actor?.token ?? null;
        if (!tokenDoc) {
          tokenDoc = canvas.scene?.tokens?.find(t =>
            t.actor?.id === actor.id || t.actorId === actor.id
          );
        }
        if (!tokenDoc) return;

        // Only act on tokens we previously marked dead.
        const flags = tokenDoc.flags?.[MODULE_ID];
        if (!flags?.isDead) return;

        // Permanent death (Vorpal etc.) — refuse to revive.
        // The visual stays dead, the flag stays set, the GM must clear it
        // manually or have an auto-clearing resurrection spell fire.
        if (flags.permanentlyDead) {
          console.log(`${MODULE_ID} | Revive denied — ${actor.name} is permanently dead (${flags.deathReason ?? "unknown"}). Use the override card or actor sheet to allow revive.`);
          // Post a one-time notification so the GM sees what happened.
          try {
            await ChatMessage.create({
              content: `<div style="background:#1a0a0a;border:2px solid #c44;border-radius:6px;padding:8px 12px;">
                <strong style="color:#ffaaaa;"><i class="fas fa-skull-crossbones"></i> Revive Blocked — Permanent Death</strong>
                <div style="color:#e8c8c8;font-size:12px;margin-top:4px;">
                  <strong>${foundry.utils.escapeHTML(actor.name)}</strong> was permanently killed
                  (${foundry.utils.escapeHTML(flags.deathReason ?? "permanent effect")}).
                  HP was restored but the visual stays dead by RAW. Use the override button on
                  the SEVERED chat card or on the actor sheet header to allow revive.
                </div>
              </div>`,
              whisper: [game.user.id],
              flags: { [MODULE_ID]: { type: "reviveDenied", actorId: actor.id } },
            });
          } catch (_) {}
          return;
        }

        // Read snapshot and restore everything.
        const snap = flags.preDeathSnapshot;
        if (!snap) {
          console.warn(`${MODULE_ID} | Revive skipped — no preDeathSnapshot on token for ${actor.name}`);
          return;
        }

        // Token visual restoration — clear EVERY death-related flag, including
        // the compatibility-mirror flags added so the existing tile-based
        // loot dialog code reads dead tokens correctly. Forgetting any one
        // of these leaves the token half-revived: hit points back, texture
        // restored, but the loot click handler / hover icon / chat-overlay
        // gate still see the leftover flag and treat the token as dead.
        const tokenUpdate = {
          [`flags.${MODULE_ID}.-=isDead`]:             null,
          [`flags.${MODULE_ID}.-=isDeadLootable`]:     null,
          [`flags.${MODULE_ID}.-=preDeathSnapshot`]:   null,
          [`flags.${MODULE_ID}.-=preDeathOwnership`]:  null,
          [`flags.${MODULE_ID}.-=lootSnapshot`]:       null,
          [`flags.${MODULE_ID}.-=deathArtPath`]:       null,
          [`flags.${MODULE_ID}.-=deathReason`]:        null,
          [`flags.${MODULE_ID}.-=diedAt`]:             null,
          // Compatibility flags added so the existing tile-pipeline loot
          // dialog reads tokens unmodified. ALL of these must be cleared
          // on revive or the dead-state checks downstream still trigger.
          [`flags.${MODULE_ID}.-=isDeadToken`]:        null,
          [`flags.${MODULE_ID}.-=originalActorId`]:    null,
          [`flags.${MODULE_ID}.-=originalName`]:       null,
          [`flags.${MODULE_ID}.-=combatLocked`]:       null,
          // Permanent-death lock — defensive clear. If we got here, the
          // permanent gate already passed (we're in the success branch),
          // so any lingering flag is stale and should go.
          [`flags.${MODULE_ID}.-=permanentlyDead`]:    null,
        };
        if (snap.textureSrc) tokenUpdate["texture.src"] = snap.textureSrc;
        if (snap.textureTint !== null && snap.textureTint !== undefined) {
          tokenUpdate["texture.tint"] = snap.textureTint;
        }
        if (snap.textureScaleX !== null) tokenUpdate["texture.scaleX"] = snap.textureScaleX;
        if (snap.textureScaleY !== null) tokenUpdate["texture.scaleY"] = snap.textureScaleY;
        if (snap.width)  tokenUpdate.width  = snap.width;
        if (snap.height) tokenUpdate.height = snap.height;

        try {
          await tokenDoc.update(tokenUpdate);
          console.log(`${MODULE_ID} | Revive — token texture restored for ${actor.name}`);
        } catch (texErr) {
          console.warn(`${MODULE_ID} | Revive texture restore failed:`, texErr);
        }

        // Actor ownership restoration
        const preDeathOwn = flags.preDeathOwnership;
        if (preDeathOwn) {
          try {
            await actor.update({ ownership: preDeathOwn });
            console.log(`${MODULE_ID} | Revive — ownership restored for ${actor.name}`);
          } catch (ownErr) {
            console.warn(`${MODULE_ID} | Revive ownership restore failed:`, ownErr);
          }
        }

        // ── Clear combatant.defeated flag in any active combat ──
        // When a token dies, the death pipeline sets `combatant.defeated = true`
        // so the combat tracker shows the ✗ defeated mark. On revive, that
        // flag was being LEFT in place — meaning the tracker still showed the
        // revived character as defeated, GM couldn't roll initiative for them
        // without manually un-defeating, and the carousel hid them from the
        // active-turn rotation. Clear the flag on every combat the actor is
        // part of (rare but possible to be in multiple).
        // Per-combat + per-update guards — audit P1-2.
        // Each combat is checked for staleness (deleted/null) before iter,
        // and each combatant.update is wrapped in its own try/catch so a
        // single failed update doesn't abort the loop and leave other
        // combats with stale defeated flags. Multi-combat iteration is
        // intentional — an actor can legitimately be in multiple combats
        // across paused scenes; reviving must clear them all.
        for (const combat of game.combats ?? []) {
          if (!combat || combat.deleted) continue;
          try {
            const combatant = combat.combatants?.find(c =>
              c.actorId === actor.id && (!c.tokenId || c.tokenId === tokenDoc.id)
            );
            if (combatant?.defeated) {
              await combatant.update({ defeated: false });
              console.log(`${MODULE_ID} | Revive — cleared combatant.defeated for ${actor.name} in combat "${combat.id}"`);
            }
          } catch (combErr) {
            console.warn(`${MODULE_ID} | Revive defeated-clear failed for combat "${combat.id}" (non-fatal, continuing):`, combErr);
          }
        }

        // Post a brief chat note so the table sees the revive.
        try {
          await ChatMessage.create({
            content: `<div style="background:#0a1a0a;border:2px solid #4c4;border-radius:6px;padding:8px 12px;">
              <strong style="color:#aaffaa;"><i class="fas fa-heart-pulse"></i> Revived</strong>
              <div style="color:#c8e8c8;font-size:12px;margin-top:4px;">
                <strong>${foundry.utils.escapeHTML(actor.name)}</strong> is back among the living.
                Token image, dimensions, and player access restored.
              </div>
            </div>`,
            speaker: { alias: "ACE QOL", actor: actor.id },
          });
        } catch (_) {}
      } catch (err) {
        console.error(`${MODULE_ID} | Revive hook threw:`, err);
      }
    });
    console.debug(`${MODULE_ID} | Revive hook registered`);

    // ══════════════════════════════════════════════════════════════════════════
    //  STALE-FLAG AUTO-CLEANUP — Self-heal tokens stuck in half-dead state
    //  On world ready, walk every scene's tokens. Any token whose actor has
    //  positive HP BUT still has lingering death-pipeline flags is by
    //  definition stale (the actor is alive, the flags shouldn't be there).
    //  Clear them defensively so the loot icon, ace-engine chat suppression,
    //  click handlers, etc. all return to live-token behavior immediately.
    //
    //  Catches:
    //    - Tokens revived BEFORE the revive hook's compatibility-flag clear
    //      was wired (pre-2026-05-29 evening builds)
    //    - Tokens stuck because a revive promise rejected mid-update
    //    - Tokens whose flags were set by an old version of the death
    //      pipeline that's since been changed
    //    - Any user upgrading from an older ace-qol version mid-campaign
    //
    //  Idempotent — runs once per world load. If a token is genuinely dead
    //  (HP 0 + flags set), this leaves it alone. Only positive-HP + flags
    //  combinations get cleaned.
    // ══════════════════════════════════════════════════════════════════════════
    Hooks.once("ready", async () => {
      if (!game.user.isGM) return;
      try {
        let cleaned = 0;
        for (const scene of game.scenes ?? []) {
          for (const tokenDoc of scene.tokens ?? []) {
            try {
              const f = tokenDoc.flags?.[MODULE_ID];
              if (!f) continue;
              // Any of these set means "this token went through the death
              // pipeline at some point." If it's also currently alive, the
              // flags are stale and need to go.
              const hasStaleFlags = f.isDead || f.isDeadToken || f.isDeadLootable
                                 || f.preDeathSnapshot || f.lootSnapshot
                                 || f.originalActorId || f.combatLocked;
              if (!hasStaleFlags) continue;
              const hp = Number(tokenDoc.actor?.system?.attributes?.hp?.value ?? 0);
              if (hp <= 0) continue;  // genuinely dead — leave alone
              await tokenDoc.update({
                [`flags.${MODULE_ID}.-=isDead`]:             null,
                [`flags.${MODULE_ID}.-=isDeadLootable`]:     null,
                [`flags.${MODULE_ID}.-=isDeadToken`]:        null,
                [`flags.${MODULE_ID}.-=originalActorId`]:    null,
                [`flags.${MODULE_ID}.-=originalName`]:       null,
                [`flags.${MODULE_ID}.-=combatLocked`]:       null,
                [`flags.${MODULE_ID}.-=lootSnapshot`]:       null,
                [`flags.${MODULE_ID}.-=preDeathSnapshot`]:   null,
                [`flags.${MODULE_ID}.-=preDeathOwnership`]:  null,
                [`flags.${MODULE_ID}.-=deathArtPath`]:       null,
                [`flags.${MODULE_ID}.-=deathReason`]:        null,
                [`flags.${MODULE_ID}.-=diedAt`]:             null,
                [`flags.${MODULE_ID}.-=permanentlyDead`]:    null,
              });
              cleaned++;
              console.log(`${MODULE_ID} | Stale-flag cleanup: ${tokenDoc.name ?? tokenDoc.id} (scene ${scene.name}) — alive at ${hp} HP with stale death flags, cleared.`);
            } catch (perTokenErr) {
              console.warn(`${MODULE_ID} | Stale-flag cleanup skipped one token (non-fatal):`, perTokenErr);
            }
          }
        }
        if (cleaned > 0) {
          console.log(`${MODULE_ID} | Stale-flag cleanup complete — ${cleaned} half-revived token(s) self-healed on this world load.`);
        }
      } catch (err) {
        console.error(`${MODULE_ID} | Stale-flag cleanup hook failed:`, err);
      }
    });
    console.debug(`${MODULE_ID} | Stale-flag auto-cleanup hook registered`);

    // ══════════════════════════════════════════════════════════════════════════
    //  PERMANENT-DEATH OVERRIDE — Vorpal revoke button (chat card + actor sheet
    //  + token right-click menu)
    //  All three locations call the same handler: clear the permanentlyDead
    //  flag on the actor's token, then either auto-revive (if HP already
    //  positive) or prompt the GM to bump HP. The handler is idempotent.
    // ══════════════════════════════════════════════════════════════════════════

    /**
     * Clear the permanent-death flag on the actor's token. If HP is already
     * positive, fire the revive flow immediately. Otherwise notify the GM
     * that the lock is cleared and they can heal normally.
     * @param {string} actorId
     * @param {string} [tokenId]  — optional, helps locate the right token
     * @param {string} [sceneId]  — optional, helps locate the right token
     */
    async function _revokeVorpalLock(actorId, tokenId, sceneId) {
      if (!game.user.isGM) {
        ui.notifications.warn("Only the GM can revoke a Vorpal lock.");
        return;
      }
      const actor = game.actors.get(actorId);
      if (!actor) {
        ui.notifications.error(`Actor ${actorId} not found.`);
        return;
      }
      // Find the token — same resolution as the revive hook
      let tokenDoc = null;
      if (sceneId && tokenId) {
        const scene = game.scenes.get(sceneId);
        tokenDoc = scene?.tokens?.get(tokenId);
      }
      if (!tokenDoc) tokenDoc = actor.token ?? null;
      if (!tokenDoc) {
        for (const scene of game.scenes) {
          const found = scene.tokens?.find(t => t.actor?.id === actor.id || t.actorId === actor.id);
          if (found) { tokenDoc = found; break; }
        }
      }
      if (!tokenDoc) {
        ui.notifications.error(`No token found for ${actor.name}.`);
        return;
      }
      const flags = tokenDoc.flags?.[MODULE_ID];
      if (!flags?.permanentlyDead) {
        ui.notifications.info(`${actor.name} is not under a permanent-death lock.`);
        return;
      }
      try {
        await tokenDoc.update({
          [`flags.${MODULE_ID}.permanentlyDead`]: false,
        });
        ui.notifications.info(`Vorpal lock revoked for ${actor.name}. Healing will now revive normally.`);
        // If the actor is somehow already at positive HP (rare but possible
        // if GM bumped HP first then revoked the lock), nudge the revive
        // hook with a no-op update so the visual reverts.
        const curHp = actor.system?.attributes?.hp?.value ?? 0;
        if (curHp > 0) {
          await actor.update({ "system.attributes.hp.value": curHp });
        }
      } catch (err) {
        console.error(`${MODULE_ID} | Revoke Vorpal lock failed:`, err);
        ui.notifications.error("Failed to revoke Vorpal lock — see console.");
      }
    }

    // Wire chat-card button + hide for non-GM
    Hooks.on("renderChatMessageHTML", (msg, html /*, data*/) => {
      try {
        const root = html instanceof HTMLElement ? html : html?.[0];
        if (!root) return;
        const button = root.querySelector(".ace-qol-btn-vorpal-override");
        if (!button) return;
        if (!game.user.isGM) {
          // Hide the override wrapper for players
          const wrap = button.closest(".ace-qol-vorpal-override");
          if (wrap) wrap.style.display = "none";
          return;
        }
        if (button.dataset.aceQolWired === "true") return;
        button.dataset.aceQolWired = "true";
        button.addEventListener("click", async (ev) => {
          ev.preventDefault();
          await _revokeVorpalLock(
            button.dataset.actorId,
            button.dataset.tokenId,
            button.dataset.sceneId,
          );
        });
      } catch (err) {
        console.warn(`${MODULE_ID} | Vorpal override button wire failed:`, err);
      }
    });

    // Expose API for the actor sheet button + console
    game.aceQol = game.aceQol ?? {};
    game.aceQol.revokeVorpalLock = _revokeVorpalLock;

    // ── Actor sheet header button (location #2) ──
    // Adds a "Revoke Vorpal Lock" header button to any actor sheet whose
    // token has the permanentlyDead flag. GM-only — hidden for players.
    Hooks.on("getActorSheetHeaderButtons", (sheet, buttons) => {
      try {
        if (!game.user.isGM) return;
        const actor = sheet?.actor;
        if (!actor) return;
        // Find the token to check the flag
        let tokenDoc = actor.token ?? null;
        if (!tokenDoc) {
          for (const scene of game.scenes) {
            const t = scene.tokens?.find(x => x.actor?.id === actor.id || x.actorId === actor.id);
            if (t) { tokenDoc = t; break; }
          }
        }
        if (!tokenDoc?.flags?.[MODULE_ID]?.permanentlyDead) return;
        buttons.unshift({
          label: "Revoke Vorpal Lock",
          class: "ace-qol-revoke-vorpal",
          icon:  "fas fa-unlock-keyhole",
          onclick: () => _revokeVorpalLock(actor.id, tokenDoc.id, tokenDoc.parent?.id),
        });
      } catch (err) {
        console.warn(`${MODULE_ID} | Actor sheet button add failed:`, err);
      }
    });

    // ── Token right-click context menu (location #3) ──
    // Adds a "Revoke Vorpal Lock" entry to the token HUD / right-click
    // context menu for permanently-dead tokens. GM-only.
    Hooks.on("getTokenHUDButtons", (hud, buttons) => {
      try {
        if (!game.user.isGM) return;
        const tokenDoc = hud?.object?.document ?? hud?.token;
        if (!tokenDoc?.flags?.[MODULE_ID]?.permanentlyDead) return;
        buttons.unshift?.({
          label: "Revoke Vorpal Lock",
          icon:  "fas fa-unlock-keyhole",
          onclick: () => _revokeVorpalLock(tokenDoc.actor?.id, tokenDoc.id, tokenDoc.parent?.id),
        });
      } catch (err) {
        console.warn(`${MODULE_ID} | Token HUD button add failed:`, err);
      }
    });

    console.debug(`${MODULE_ID} | Vorpal override hooks registered (chat card + actor sheet + token HUD)`);

    // ══════════════════════════════════════════════════════════════════════════
    //  STRICT-RAW RESURRECTION DETECTION
    //  Vorpal RAW says a beheaded creature dies AND can't be revived by
    //  ordinary means — only True Resurrection or Wish actually restore a
    //  body that's lost a head. We detect spell casts of revival magic and:
    //    - True Resurrection or Wish → auto-clear permanentlyDead, allowing
    //      the next HP-restored update to revive normally
    //    - Revivify / Raise Dead / Resurrection / Reincarnate → post a chat
    //      card explaining "this spell can't normally restore a body missing
    //      a head; GM, click to override if you want to allow it"
    //  Detection is by spell NAME (case-insensitive substring), which is the
    //  most robust approach across the SRD, homebrew variants, and dnd5e 5.x
    //  activity restructuring.
    // ══════════════════════════════════════════════════════════════════════════
    const STRICT_RAW_REVIVES = [/true\s*resurrection/i, /\bwish\b/i];
    const WEAKER_REVIVES = [
      /revivify/i,
      /raise\s*dead/i,
      /^resurrection\b/i,         // "Resurrection" but not "True Resurrection"
      /reincarnate/i,
    ];

    Hooks.on("dnd5e.preUseActivity", (activity /*, usageConfig, dialogConfig, messageConfig*/) => {
      try {
        if (!game.user.isGM) return;
        const spellName = String(activity?.item?.name ?? "");
        if (!spellName) return;
        const isStrict  = STRICT_RAW_REVIVES.some(rx => rx.test(spellName));
        const isWeaker  = !isStrict && WEAKER_REVIVES.some(rx => rx.test(spellName));
        if (!isStrict && !isWeaker) return;

        // Get the targets the caster has selected on canvas. For PC casters
        // that's the player's targets; for GM-cast spells it's the GM's.
        const targets = [...(game.user.targets ?? [])];
        if (!targets.length) return;

        // For each targeted token, check if it has the permanent-death flag
        for (const tgt of targets) {
          const tokenDoc = tgt.document;
          if (!tokenDoc?.flags?.[MODULE_ID]?.permanentlyDead) continue;

          if (isStrict) {
            // True Resurrection or Wish — auto-clear the flag silently
            tokenDoc.update({
              [`flags.${MODULE_ID}.permanentlyDead`]: false,
            }).then(() => {
              ChatMessage.create({
                content: `<div style="background:#0a1a0a;border:2px solid #4c4;border-radius:6px;padding:8px 12px;">
                  <strong style="color:#aaffaa;"><i class="fas fa-staff-aesculapius"></i> Permanent-Death Lock Cleared</strong>
                  <div style="color:#c8e8c8;font-size:12px;margin-top:4px;">
                    <strong>${foundry.utils.escapeHTML(spellName)}</strong> bypasses the Vorpal lock per RAW.
                    <strong>${foundry.utils.escapeHTML(tokenDoc.actor?.name ?? tokenDoc.name)}</strong> can be revived
                    by healing now.
                  </div>
                </div>`,
                whisper: [game.user.id],
                flags: { [MODULE_ID]: { type: "permanentDeathStrictClear" } },
              });
            }).catch(err => console.warn(`${MODULE_ID} | Strict-RAW clear failed:`, err));
          } else {
            // Weaker revival spell — post override card asking GM to decide
            ChatMessage.create({
              content: `<div style="background:#2a0a0a;border:2px solid #c44;border-radius:6px;padding:8px 12px;">
                <strong style="color:#ffaaaa;"><i class="fas fa-skull-crossbones"></i> Revive Spell Insufficient (per RAW)</strong>
                <div style="color:#e8c8c8;font-size:12px;margin-top:4px;line-height:1.45;">
                  <strong>${foundry.utils.escapeHTML(spellName)}</strong> normally restores a corpse to life, but
                  <strong>${foundry.utils.escapeHTML(tokenDoc.actor?.name ?? tokenDoc.name)}</strong> is missing
                  body parts (Vorpal RAW). True Resurrection or Wish are required to restore them. The spell still
                  fires — but to RESTORE this victim, click the button below.
                </div>
                <div style="margin-top:8px;">
                  <button type="button" class="ace-qol-btn-vorpal-override" data-action="aceQolRevokeVorpal"
                          data-actor-id="${foundry.utils.escapeHTML(tokenDoc.actor?.id ?? "")}"
                          data-token-id="${foundry.utils.escapeHTML(tokenDoc.id ?? "")}"
                          data-scene-id="${foundry.utils.escapeHTML(tokenDoc.parent?.id ?? "")}"
                          style="background:linear-gradient(180deg,#2a1a0a,#1a0a05);border:1px solid #d4af37;border-radius:4px;color:#ffd87a;padding:6px 12px;font-size:12px;font-weight:700;cursor:pointer;width:100%;">
                    <i class="fas fa-unlock-keyhole"></i> GM Override: Allow ${foundry.utils.escapeHTML(spellName)} to revive
                  </button>
                </div>
              </div>`,
              whisper: [game.user.id],
              flags: { [MODULE_ID]: { type: "permanentDeathSpellWarning" } },
            }).catch(err => console.warn(`${MODULE_ID} | Permanent-death spell-warning post failed:`, err));
          }
        }
      } catch (err) {
        console.warn(`${MODULE_ID} | Strict-RAW resurrection detection threw:`, err);
      }
    });
    console.debug(`${MODULE_ID} | Strict-RAW resurrection detection registered`);
  }

  // ── Socket bridge: player attacks → GM processing ──
  // When a player rolls an attack on their client, the dnd5e.rollAttackV2 hook only
  // fires there. We capture the data and send it to the GM via socket.
  // The GM receives it and feeds it into the existing AttackPipeline.

  if (!game.user.isGM) {
    // ── PLAYER SIDE: capture attack rolls and forward to GM ──
    Hooks.on("dnd5e.rollAttackV2", (rolls, data) => {
      try {
        const subject = data?.subject;
        if (!subject) return;
        const item = subject.item;
        const actor = subject.actor;
        if (!item || !actor) return;

        // Capture the player's targeted tokens (client-local data the GM can't see)
        const targetData = [];
        for (const token of game.user.targets) {
          targetData.push({
            tokenId: token.id,
            tokenDocId: token.document?.id ?? token.id,
            sceneId: token.scene?.id ?? canvas.scene?.id,
            actorId: token.actor?.id,
            name: token.name ?? token.document?.name,
          });
        }

        // Serialize roll data (Roll objects aren't directly serializable)
        const rollData = rolls.map(r => ({
          total: r.total,
          formula: r.formula,
          d20Result: r.dice?.[0]?.total ?? r.terms?.[0]?.total,
          results: r.dice?.[0]?.results?.map(d => d.result),
        }));

        // Resolve which ability the attack uses (INT for Artificer, CHA for Warlock, etc.)
        const atkActivity = item.system?.activities ? [...item.system.activities].find(a => a.type === "attack") : null;
        const attackAbility = atkActivity?.ability || item.system?.attack?.ability || "";

        // Send to GM via socket
        const payload = {
          action: "attackRoll",
          rollData,
          itemUuid: item.uuid,
          itemId: item.id,
          itemName: item.name,
          itemImg: item.img,
          itemActionType: item.system?.actionType ?? "mwak",
          itemType: item.type,
          attackAbility,
          actorId: actor.id,
          actorUuid: actor.uuid,
          targets: targetData,
          userId: game.user.id,
          userName: game.user.name,
        };

        console.log(`${MODULE_ID} | Player sending attack data to GM:`, item.name, `(${targetData.length} targets)`);
        game.socket.emit(SOCKET_NAME, payload);
      } catch (err) {
        console.error(`${MODULE_ID} | Player-side attack bridge failed:`, err);
      }
    });

    // ── PLAYER SIDE: listen for GM commands via socket ──
    game.socket.on(SOCKET_NAME, async (payload) => {
      // FlagsEngine optional prompts — routed to specific player
      if (payload?.action === "showOptionalPrompt" || payload?.action === "optionalPromptResult") {
        FlagsEngine.handleSocketMessage(payload);
        return;
      }

      // ReactionEngine prompts — routed to specific player
      if (payload?.action === "showReactionPrompt" || payload?.action === "reactionResponse") {
        if (await reactionEngine?.handleSocketMessage(payload)) return;
      }

      if (!payload?.action || payload?.userId !== game.user.id) return;

      // ── Close system ActivityChoiceDialogs (Divine Smite "Use/Damage/Undead" popup) ──
      if (payload.action === "closeSystemDialogs") {
        console.log(`${MODULE_ID} | Player received closeSystemDialogs command from GM`);
        for (const app of Object.values(ui.windows ?? {})) {
          if (app?.options?.classes?.includes("activity-choice")) {
            console.log(`${MODULE_ID} | Closing system ActivityChoiceDialog on player screen`);
            app.close();
          }
        }
        if (foundry.applications?.instances) {
          for (const app of foundry.applications.instances.values()) {
            if (app?.options?.classes?.includes("activity-choice")) {
              console.log(`${MODULE_ID} | Closing system ActivityChoiceDialog (V2) on player screen`);
              app.close();
            }
          }
        }
        return;
      }

      // ── Rider popup — GM is asking this player to choose riders (Divine Smite, etc.) ──
      if (payload.action === "showRiderPopup") {
        const { requestId, riders, context } = payload;
        console.log(`${MODULE_ID} | Player received rider popup request (${requestId}): ${riders.length} riders available`);
        try {
          const selectedRiders = await RiderEngine.showRiderPopup(riders, context);
          console.log(`${MODULE_ID} | Player chose ${selectedRiders.length} riders — sending back to GM`);
          game.socket.emit(SOCKET_NAME, {
            action: "riderChoice",
            requestId,
            selectedRiders,
          });
        } catch (err) {
          console.error(`${MODULE_ID} | Player rider popup failed:`, err);
          game.socket.emit(SOCKET_NAME, {
            action: "riderChoice",
            requestId,
            selectedRiders: [],
          });
        }
        return;
      }
    });

    console.debug(`${MODULE_ID} | Player-side attack bridge registered`);
  }

  if (game.user.isGM) {
    // ── GM SIDE: receive player requests via socket ──
    // activeGM guard: socket messages broadcast to ALL connected GMs; only one should process.
    game.socket.on(SOCKET_NAME, async (payload) => {
      if (game.users?.activeGM !== game.user) return;
      if (!payload?.action) return;

      // FlagsEngine optional prompt responses from players
      if (payload.action === "optionalPromptResult") {
        FlagsEngine.handleSocketMessage(payload);
        return;
      }

      // ReactionEngine responses from players
      if (payload.action === "reactionResponse") {
        if (await reactionEngine?.handleSocketMessage(payload)) return;
      }

      // ── Player responds to rider popup (Divine Smite, Eldritch Smite, etc.) ──
      if (payload.action === "riderChoice") {
        console.log(`${MODULE_ID} | GM received riderChoice from player (requestId=${payload.requestId}, riders=${payload.selectedRiders?.length ?? 0})`);
        damageEngine.resolveRiderChoice(payload.requestId, payload.selectedRiders);
        return;
      }

      // ── Player resolved their OWN opportunity attack — GM flips the card
      //    and marks the reaction used (message + flag writes are GM-side).
      //    The player already fired the actual attack on their own client.
      if (payload.action === "oaResolve") {
        try {
          const { OAPrompt } = await import("/modules/ace-qol/scripts/oa-prompt.mjs");
          await OAPrompt.resolveOAPrompt(payload.messageId, payload.status);
        } catch (err) {
          console.error(`${MODULE_ID} | oaResolve socket handler failed:`, err);
        }
        return;
      }

      // ── Player requests GM to roll damage from a ROLL DAMAGE button ──
      if (payload.action === "rollDamage") {
        console.log(`${MODULE_ID} | GM received rollDamage request from ${payload.userName} for message ${payload.messageId}`);
        try {
          const message = game.messages.get(payload.messageId);
          if (!message) { console.warn(`${MODULE_ID} | rollDamage: message not found ${payload.messageId}`); return; }
          const success = await damageEngine._rollDamageFromButton(message);
          if (success) {
            console.log(`${MODULE_ID} | rollDamage: success for message ${payload.messageId}`);
          } else {
            console.error(`${MODULE_ID} | rollDamage: _rollDamageFromButton returned false`);
          }
        } catch (err) {
          console.error(`${MODULE_ID} | rollDamage socket handler crashed:`, err);
        }
        return;
      }

      if (payload.action !== "attackRoll") return;

      console.log(`${MODULE_ID} | GM received attack from player ${payload.userName}: ${payload.itemName} → ${payload.targets.length} targets`);

      try {
        // Resolve the actor and item on the GM side (GM has full data access)
        const actor = game.actors.get(payload.actorId);
        if (!actor) { console.warn(`${MODULE_ID} | Socket: actor not found ${payload.actorId}`); return; }

        // Try to find the item — first by UUID, then by ID on the actor, then by name
        let item = null;
        try { item = await fromUuid(payload.itemUuid); } catch (e) { /* ignore */ }
        if (!item) item = actor.items.get(payload.itemId);
        if (!item) item = actor.items.getName(payload.itemName);
        if (!item) { console.warn(`${MODULE_ID} | Socket: item not found ${payload.itemName}`); return; }

        const roll = payload.rollData?.[0];
        if (!roll) return;

        const attackTotal = roll.total;
        const d20Result = roll.d20Result;
        const isCritRoll = d20Result === 20;
        const isFumbleRoll = d20Result === 1;
        const actionType = payload.itemActionType ?? "mwak";
        const isMelee = ["mwak", "msak"].includes(actionType);
        const isSpell = payload.itemType === "spell" || ["msak", "rsak"].includes(actionType);

        // Resolve target tokens on the GM side (GM has full NPC data)
        const scene = game.scenes.get(payload.targets[0]?.sceneId) ?? canvas.scene;
        const targetTokens = [];
        for (const td of payload.targets) {
          const tokenDoc = scene?.tokens?.get(td.tokenDocId);
          if (tokenDoc?.object) targetTokens.push(tokenDoc.object);
        }

        if (!targetTokens.length) {
          console.warn(`${MODULE_ID} | Socket: no target tokens could be resolved`);
          return;
        }

        // Assess combat state for each target (GM has full access to NPC stats)
        const combatStates = targetTokens.map(token =>
          CombatState.assess(actor, token, item)
        );

        // Build results (same logic as _onAttackRoll, with cover calculation)
        const atkToken = CoverEngine.getAttackerToken(actor);
        const results = [];
        for (const cs of combatStates) {
          // ── Cover calculation ──
          let coverResult = null;
          let effectiveAC = cs.target.ac;
          try {
            if (QolSettings.get("enableCoverCalculation") && atkToken && cs.targetToken) {
              coverResult = CoverEngine.calculateCover(atkToken, cs.targetToken);
              if (!coverResult.isFullCover && coverResult.acBonus > 0) {
                effectiveAC += coverResult.acBonus;
              }
              CoverEngine.showCoverIndicator(cs.targetToken, coverResult);
            }
          } catch (err) { console.debug("ace-qol | CoverEngine calculation non-blocking:", err); }

          // ── Mirror Image redirect (socket attack path — v0.7.15) ──
          // Same logic as the local attack-pipeline path. RAW: target with
          // Mirror Image rolls d20 (threshold 6/8/11 for 3/2/1 dupes).
          // Success → attack vs duplicate AC (10+DEX); hit destroys duplicate.
          let mirrorImageRedirect = null;
          try {
            const targetActor = cs.targetActor ?? cs.target?.actor;
            const dupes = Number(targetActor?.getFlag?.(MODULE_ID, "mirrorImage") ?? 0);
            if (dupes > 0 && !isFumbleRoll && !coverResult?.isFullCover) {
              const threshold = dupes >= 3 ? 6 : dupes === 2 ? 8 : 11;
              const redirectRoll = await new Roll("1d20").evaluate();
              const redirectVal = redirectRoll.total;
              if (redirectVal >= threshold) {
                const dexMod = targetActor.system?.abilities?.dex?.mod ?? 0;
                const duplicateAC = 10 + dexMod;
                const hitDuplicate = attackTotal >= duplicateAC;
                let newCount = dupes;
                if (hitDuplicate) {
                  newCount = dupes - 1;
                  try { await targetActor.setFlag(MODULE_ID, "mirrorImage", newCount); } catch (_) {}
                  if (newCount === 0) {
                    try {
                      const eff = targetActor.effects?.find(e => String(e.name ?? "").toLowerCase() === "mirror image");
                      if (eff) await eff.delete();
                      await targetActor.unsetFlag(MODULE_ID, "mirrorImage");
                    } catch (_) {}
                  }
                }
                mirrorImageRedirect = { rollResult: redirectVal, threshold, duplicatesBefore: dupes, duplicatesAfter: newCount, duplicateAC, hitDuplicate };
                try {
                  const remainingTxt = newCount === 0 ? "all duplicates destroyed — spell ends" : `${newCount} duplicate${newCount === 1 ? "" : "s"} remaining`;
                  const outcomeTxt = hitDuplicate
                    ? `<strong style="color:#d4af37;">duplicate destroyed</strong> — ${remainingTxt}`
                    : `<strong style="color:#8eebff;">attack misses</strong> — duplicate not struck, ${dupes} duplicate${dupes === 1 ? "" : "s"} remaining`;
                  ChatMessage.create({
                    content: `<div style="background:linear-gradient(180deg,#1a1416 0%,#241a30 100%);border:2px solid #8eebff;border-radius:6px;padding:8px 10px;color:#cfcfd0;font-size:12px;">
                      <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;">
                        <i class="fas fa-clone" style="color:#8eebff;font-size:16px;"></i>
                        <strong style="color:#8eebff;text-transform:uppercase;letter-spacing:0.5px;">Mirror Image</strong>
                      </div>
                      Attack on <strong>${targetActor.name}</strong> redirected (roll <strong>${redirectVal}</strong> vs threshold ${threshold}+).
                      Duplicate AC <strong>${duplicateAC}</strong> vs attack <strong>${attackTotal}</strong> → ${outcomeTxt}.
                    </div>`,
                    speaker: ChatMessage.getSpeaker({ actor: targetActor }),
                  }).catch(() => {});
                } catch (_) { /* non-fatal */ }
              }
            }
          } catch (err) {
            console.warn(`${MODULE_ID} | Mirror Image socket-path redirect failed (non-blocking):`, err);
          }

          let hitResult;
          if (isFumbleRoll) hitResult = "fumble";
          else if (coverResult?.isFullCover) hitResult = "miss";
          else if (mirrorImageRedirect) hitResult = "miss"; // Mirror Image absorbed
          else if (isCritRoll || cs.autoCrit) hitResult = "critical";
          else if (attackTotal >= effectiveAC) hitResult = "hit";
          else hitResult = "miss";

          results.push({
            ...cs,
            name: cs.target.name,
            img: cs.target.img,
            ac: cs.target.ac,
            effectiveAC,
            coverResult,
            hitResult,
            attackTotal,
            d20Result,
            isCritRoll,
            isFumbleRoll,
            mirrorImageRedirect,
          });
        }

        // ── POST-HIT REACTIONS (Shield, etc.) — socket attack path ──
        if (reactionEngine) {
          try {
            const modifiedResults = await reactionEngine.checkPostHitReactions(results, item, actor);
            if (modifiedResults) {
              results.length = 0;
              results.push(...modifiedResults);
            }
          } catch (err) {
            console.error(`${MODULE_ID} | Socket: post-hit reaction check failed:`, err);
          }
        }

        const hits = results.filter(r => r.hitResult === "hit" || r.hitResult === "critical");
        const misses = results.filter(r => r.hitResult === "miss" || r.hitResult === "fumble");

        console.log(`${MODULE_ID} | Socket: ${item.name} (${attackTotal}) → ${hits.length} hits, ${misses.length} misses`);

        // Build a fake roll object for the attack card display
        const fakeRoll = {
          total: attackTotal,
          formula: roll.formula,
          terms: [],
          dice: [{ total: d20Result, results: (roll.results ?? []).map(r => ({ result: r })) }],
        };

        // Post the attack card and trigger the damage pipeline — use the AttackPipeline instance
        if (attackPipeline) {
          // Build a fake subject with the resolved ability so the card shows the right label
          const fakeSubject = { ability: payload.attackAbility || "", actionType: actionType };
          await attackPipeline._postAttackResults(item, actor, results, { isMelee, isSpell, roll: fakeRoll, subject: fakeSubject });

          // Store for damage phase
          attackPipeline._lastAttackResults = results;
          attackPipeline._lastAttackItem = item;
          attackPipeline._lastAttackActor = actor;

          // Emit attackComplete hook for the damage engine.
          // initiatorUserId = the player who rolled the attack on their
          // client (forwarded in the bridge payload). The damage engine
          // routes rider popups (Divine Smite etc.) to this user. v0.7.22.
          Hooks.callAll(`${MODULE_ID}.attackComplete`, { item, actor, results, hits, misses, initiatorUserId: payload.userId });

          // Tell the player to close any system ActivityChoiceDialogs (Divine Smite popup)
          game.socket.emit(SOCKET_NAME, { action: "closeSystemDialogs", userId: payload.userId });
        }
      } catch (err) {
        console.error(`${MODULE_ID} | GM socket handler crashed:`, err);
      }
    });

    console.debug(`${MODULE_ID} | GM-side socket listener registered`);
  }

  // Expose module API
  game.aceQol = {
    VERSION: 1,
    MODULE_ID,
    extendedEffects,
    attackPipeline,
    damageEngine,
    saveEngine,
    concentrationWidget,
    TargetState,
    CombatState,
    DamageEngine,
    FlagsEngine,
    HookAPI,
    overTimeEngine,
    reactionEngine,
    ReactionEngine,
    SpellPipeline,            // v0.7.18 — registry-driven spell dispatcher
    bloodiedEngine,
    CoverEngine,
    VisibilityEngine,
    ConditionLibrary,
    DescriptionParser,
    TransformationEngine,
    TokenCache,
    /** Quick-call shortcuts for transformation testing.
     *  game.aceQol.transform(token.actor, beastActor, opts)
     *  game.aceQol.revert(token.actor, "voluntary")
     *  game.aceQol.isTransformed(actor)
     *  game.aceQol.tokenCache.get("Almiraj") → path or null
     *  game.aceQol.tokenCache.refresh()      → re-scan folders
     *  game.aceQol.tokenCache.stats()        → diagnostics
     */
    transform: (target, source, opts) => TransformationEngine.transform(target, source, opts),
    revert:    (actor, reason)        => TransformationEngine.revert(actor, reason),
    isTransformed: (actor)             => TransformationEngine.isTransformed(actor),
    getTransformState: (actor)         => TransformationEngine.getState(actor),
    tokenCache: TokenCache,
    // ── v0.4.0 sprint additions (Phases 2-8) ──
    DeathSaves,
    StealthEngine,
    /** Quick-call shortcuts for stealth testing.
     *  game.aceQol.hide(token)                      → roll Stealth + hide
     *  game.aceQol.reveal(token)                    → clear hidden state
     *  game.aceQol.attackerHidden(attacker, target) → check advantage
     */
    hide:           (tokenOrDoc) => StealthEngine.hide(tokenOrDoc),
    reveal:         (tokenOrDoc) => StealthEngine.reveal(tokenOrDoc),
    attackerHidden: (att, tgt)   => StealthEngine.attackerHiddenFromTarget(att, tgt),
    CombatActions,
    /** Quick-call shortcuts for combat actions.
     *  game.aceQol.disengage(token)
     *  game.aceQol.dodge(token)
     *  game.aceQol.help(helper, ally, foe)
     *  game.aceQol.ready(token, trigger, description)
     */
    disengage: (t)              => CombatActions.disengage(t),
    dodge:     (t)              => CombatActions.dodge(t),
    help:      (h, a, f)        => CombatActions.help(h, a, f),
    ready:     (t, trig, desc)  => CombatActions.ready(t, trig, desc),
    FumbleEngine,
    OAPrompt,
    InitiativeTools,
    rollAllNpcs: () => InitiativeTools.rollAllNpcs(),
    rollAllPcs:  () => InitiativeTools.rollAllPcs(),
    AuraEngine,
    /** Quick-call shortcuts.
     *  game.aceQol.recomputeAuras()   → full rescan + apply/remove
     *  game.aceQol.cleanAllAuras()    → wipe ALL aura effects (ours + stale
     *                                    ActiveAuras leftovers) then rebuild
     */
    recomputeAuras: () => AuraEngine.recomputeAll(),
    cleanAllAuras:  () => AuraEngine.cleanAllAndRebuild(),
    DurationTracker,
    durationTracker,
    speedRolls,
    MergeCard,
    LootEngine,
    lootEngine,
    DeathPipeline,
    deathPipeline,
    effectsPanel,
    xpEngine,
    quickSelectTools,
    turnMarker,
    movementTracker,
    lootableTile,

    /** Check if a setting is enabled */
    isEnabled: (key) => QolSettings.get(key),

    /** Manually assess combat state (for console testing) */
    assessCombat: (attackerActor, targetToken, item) => CombatState.assess(attackerActor, targetToken, item),
    assessTarget: (token, item) => TargetState.assess(token, null, item),

    /** Check flags on an actor (for console testing) */
    checkFlags: (actor, actionType) => ({
      attackAdvantage: FlagsEngine.hasAttackAdvantage(actor, actionType ?? "mwak"),
      attackDisadvantage: FlagsEngine.hasAttackDisadvantage(actor, actionType ?? "mwak"),
      autoCrit: FlagsEngine.hasAutoCrit(actor, actionType ?? "mwak"),
      magicResistance: FlagsEngine.hasMagicResistance(actor),
      evasion: FlagsEngine.hasEvasion(actor),
      sculptSpell: FlagsEngine.hasSculptSpell(actor),
      optionals: FlagsEngine.getAvailableOptionals(actor, "attack", actionType ?? "mwak"),
    }),

    /** Diagnostics — run from console: game.aceQol.diagnostics.runAll() */
    diagnostics: Diagnostics,
  };

  // Register APIs that need game.aceQol to exist
  try { CoverEngine.registerAPI(); } catch (err) { console.debug("ace-qol | CoverEngine.registerAPI non-critical:", err); }
  try { if (bloodiedEngine) bloodiedEngine.registerAPI(); } catch (err) { console.debug("ace-qol | BloodiedEngine.registerAPI non-critical:", err); }
  try { VisibilityEngine.registerAPI(); } catch (err) { console.debug("ace-qol | VisibilityEngine.registerAPI non-critical:", err); }

  // ── Suppress "Bloodied" and other status effect chat cards ──
  // These come from modules like BLFS/DFreds and show "Bloodied - Applied to X" /
  // "Bloodied - Removed from X" messages. We hide them entirely — GM and players.
  Hooks.on("renderChatMessage", (message, html) => {
    // Never touch our own messages
    if (message.flags?.[MODULE_ID]) return;

    const el = html instanceof HTMLElement ? html : html?.[0] ?? html;
    if (!el) return;

    // Detect status effect messages by content pattern or module flags
    // Check for common status effect modules: blfs, dfreds-convenient-effects, combat-utility-belt
    const isStatusEffect =
      message.flags?.blfs ||
      message.flags?.["dfreds-convenient-effects"] ||
      message.flags?.["combat-utility-belt"];

    // Also detect by text content — "Applied to" / "Removed from" with effect names
    const textContent = el.textContent ?? "";
    const isStatusText = /\b(Applied to|Removed from)\b/i.test(textContent) &&
      /\b(Bloodied|Concentrating|Frightened|Poisoned|Stunned|Blinded|Charmed|Deafened|Exhaustion|Grappled|Incapacitated|Invisible|Paralyzed|Petrified|Prone|Restrained|Unconscious)\b/i.test(textContent);

    if (isStatusEffect || isStatusText) {
      el.style.display = "none";
      el.dataset.aceHidden = "1";
      return;
    }
  });

  // ── Collapse D&D 5e system chat cards ──
  // Only collapse messages that have dnd5e flags (system-generated cards).
  // Our ace-qol messages have MODULE_ID flags — they are NEVER touched.
  // This is flag-based detection only — no DOM selectors that could match our cards.
  Hooks.on("renderChatMessage", (message, html) => {
    // ONLY suppress messages with D&D 5e system flags — nothing else
    if (!message.flags?.dnd5e) return;
    // Double-check: never touch our own messages
    if (message.flags?.[MODULE_ID]) return;

    const el = html instanceof HTMLElement ? html : html?.[0] ?? html;
    if (!el?.querySelector) return;
    if (el.dataset.aceHidden) return;
    el.dataset.aceHidden = "1";

    // ── Full suppression mode: hide the system card entirely ──
    // The item description is embedded in our own attack-result card
    // (collapsible via chevron). This eliminates the redundant system cards.
    if (QolSettings.get("suppressSystemCards") !== false) {
      el.style.display = "none";
      return;
    }

    // ── Legacy mode: collapse the description, keep header visible ──
    const content = el.querySelector(".card-content, .details, .collapsible-content, .dice-tooltip");
    if (content) content.style.display = "none";
    const footer = el.querySelector(".card-footer");
    if (footer) footer.style.display = "none";

    el.style.opacity = "0.6";
    el.style.cursor = "pointer";

    // ── Chevron / header click to expand/collapse ──
    // The D&D 5e system uses its own collapsible handler on .collapsible headers
    // which may call stopPropagation. We add a direct handler on the header/summary
    // element and also on the whole card as a fallback.
    const header = el.querySelector(".summary, .card-header > header, .message-header");
    if (header) {
      header.style.cursor = "pointer";
      header.addEventListener("click", (e) => {
        e.stopPropagation(); // prevent system handler from interfering
        const isHidden = content?.style.display === "none";
        if (content) content.style.display = isHidden ? "" : "none";
        if (footer) footer.style.display = isHidden ? "" : "none";
        el.style.opacity = isHidden ? "1" : "0.6";
      });
    }

    // Also remove the inert attribute from the chevron so it's visually clickable
    const chevron = el.querySelector("i.fa-chevron-down[inert], i.fa-chevron-up[inert]");
    if (chevron) chevron.removeAttribute("inert");

    // Fallback: click anywhere on the card body to toggle
    el.addEventListener("click", (e) => {
      if (e.target.closest("button, a, [data-action], .summary, header")) return;
      const isHidden = content?.style.display === "none";
      if (content) content.style.display = isHidden ? "" : "none";
      if (footer) footer.style.display = isHidden ? "" : "none";
      el.style.opacity = isHidden ? "1" : "0.6";
    });
  });

  // ── Wire chevron toggle on our attack-result cards ──
  // Click the chevron in the card header to expand/collapse the embedded
  // item description + property tags.
  Hooks.on("renderChatMessage", (message, html) => {
    if (message.flags?.[MODULE_ID]?.type !== "attackResult") return;
    const el = html instanceof HTMLElement ? html : html?.[0] ?? html;
    if (!el) return;
    const toggle = el.querySelector(".ace-qol-atk-info-toggle");
    if (!toggle) return;

    toggle.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const card = toggle.closest(".ace-qol-attack-card");
      const details = card?.querySelector(".ace-qol-atk-item-details");
      if (!details) return;
      const willShow = details.classList.contains("ace-qol-collapsed");
      details.classList.toggle("ace-qol-collapsed", !willShow);
      toggle.setAttribute("aria-expanded", String(willShow));
      const icon = toggle.querySelector("i");
      if (icon) {
        icon.classList.toggle("fa-chevron-down", !willShow);
        icon.classList.toggle("fa-chevron-up", willShow);
      }
    });
  });

  // ── Suppress system's ActivityChoiceDialog for ALL weapon uses ──
  // The D&D 5e system shows an "activity-choice" dialog when:
  //   (activities.length > 1 || chooseActivity) && !event?.shiftKey
  // The BG3 HUD can pass chooseActivity:true even for single-activity weapons,
  // and class features (Divine Smite) add rider activities dynamically.
  // Since our rider engine handles all post-hit abilities, we ALWAYS inject
  // shiftKey=true for weapons. The system then auto-selects activities[0]
  // (the Attack activity) and proceeds — our hooks catch the roll.
  // Any POST-HIT ActivityChoiceDialogs (system's "use Divine Smite?" prompt)
  // are caught and closed by the render hooks below.
  // This runs on ALL clients (GM + players) since it patches the prototype.
  const ItemClass = CONFIG.Item?.documentClass;
  if (ItemClass?.prototype?.use) {
    const origUse = ItemClass.prototype.use;
    ItemClass.prototype.use = async function(config = {}, ...args) {
      if (this.type === "weapon" && this.actor) {
        // Opportunity attacks fast-forward: skip the pre-prompt range check
        // (the OA was already validated as in-reach when it triggered) AND the
        // advantage prompt (it's a one-click auto-swing; advantage is still
        // auto-applied from combat state). v0.7.24.
        const isOA = OA_IN_FLIGHT.has(this.actor?.id);

        // ── Block attacks from incapacitated attackers (BEFORE the prompt) ───
        const atkStatuses = this.actor.statuses ?? new Set();
        const blockingConditions = ["paralyzed", "stunned", "unconscious", "incapacitated", "petrified"];
        const blocker = blockingConditions.find(c => atkStatuses.has(c));
        if (blocker) {
          const name = this.actor.token?.name ?? this.actor.name;
          showCenterToast(`${name} is ${blocker.toUpperCase()} — cannot attack`, 2500);
          return null;
        }

        // ── Require a target ─────────────────────────────────────────────────
        if (QolSettings.get("requireTarget") !== false) {
          if (!game.user.targets.size) {
            showCenterToast("Please select a target", 2500);
            return null;
          }
        }

        // ── Range check (FIRST — before the advantage prompt) ────────────────
        // Bug reported 2026-05-31: range check used to run only in the
        // `dnd5e.preRollAttackV2` downstream hook, AFTER the player had
        // already clicked through the Advantage/Normal/Disadvantage prompt.
        // That wasted clicks on attacks that couldn't physically land.
        // Now we range-check before the prompt so out-of-range attacks
        // get a clean "Out of range" toast and abort cleanly without the
        // player ever seeing the advantage dialog.
        if (!isOA) {
          try {
            const target = game.user.targets.first();
            const ap = game.aceQol?.attackPipeline;
            if (target && ap?._checkRange) {
              const rangeCheck = ap._checkRange(this.actor, target, this);
              if (rangeCheck?.blocked) {
                const msg = `Out of range — ${rangeCheck.distanceFt}ft away (${rangeCheck.rangeDesc})`;
                showCenterToast(msg, 2500);
                ui.notifications?.warn(`ACE QOL: ${msg}`);
                return null;  // cancel the attack
              }
            }
          } catch (err) {
            console.warn(`${MODULE_ID} | Pre-prompt range check failed (non-fatal):`, err);
          }
        }

        // ── Show the advantage prompt (if enabled) ───────────────────────────
        if (!isOA && QolSettings.get("advantagePrompt") !== false) {
          const target = game.user.targets.first();
          let suggested = "normal";
          let reasons   = [];
          try {
            const cs = CombatState.assess(this.actor, target, this);
            suggested = cs?.finalRollMode || "normal";
            reasons   = suggested === "advantage"    ? (cs?.advantageSources    ?? [])
                      : suggested === "disadvantage" ? (cs?.disadvantageSources ?? [])
                                                     : [];
          } catch (err) {
            console.warn(`${MODULE_ID} | CombatState.assess failed in prompt:`, err);
          }

          const choice = await showAdvantagePrompt({
            attacker:     this.actor.token?.name ?? this.actor.name ?? "Attacker",
            target:       target.actor?.name ?? target.name ?? "Target",
            suggested,
            reasons,
            attackerIsPC: !!this.actor?.hasPlayerOwner,
            targetIsPC:   !!target.actor?.hasPlayerOwner,
          });

          if (!choice) return null; // Esc cancels the attack
          pendingAttackChoices.set(this.actor.id, choice);
        }

        // Replace the event so dnd5e fast-forwards (skips ActivityChoiceDialog).
        // Native MouseEvent.shiftKey is read-only, so we wrap. Preserve target
        // so dnd5e's buildPost can call .closest() safely.
        config.event = { shiftKey: true, target: config.event?.target ?? document.body };
      }
      return origUse.call(this, config, ...args);
    };
    console.log(`${MODULE_ID} | Patched Item.use(): target gating + advantage prompt for weapons`);
  }

  // ── Persistent suppression of ALL system ActivityChoiceDialogs ──
  // The Item.use() shiftKey patch doesn't always fire — BG3 HUD caches a reference
  // to the original Item.use() before our module patches it, bypassing our wrapper.
  // So we ALSO intercept at render time as a reliable fallback.
  //
  // Strategy: if the dialog has an Attack activity button, click it — this tells the
  // system "I choose Attack" and proceeds normally (no timeout error, no flash).
  // If there's NO Attack button (post-hit rider dialog like "use Divine Smite?"),
  // close the dialog — our rider engine handles all post-hit abilities.
  //
  // Using both V1 and V2 hooks to cover all Foundry versions.
  // Dedup: dnd5e re-renders the dialog multiple times during its lifecycle
  // (and we hook both renderApplication + renderActivityChoiceDialog).
  // Use a string-key set on (item-uuid + app-id) so we catch app re-creates.
  // Cleared after a short timeout so subsequent casts of the same spell work.
  const _handledActivityDialogs = new Set();
  function _handleActivityChoiceDialog(app, element) {
    const item = app.item;
    const dedupKey = `${item?.uuid ?? "?"}|${app.id ?? app.appId ?? Math.random()}`;
    if (_handledActivityDialogs.has(dedupKey)) return;
    _handledActivityDialogs.add(dedupKey);
    // Clear after 3s so re-casts of the same spell aren't blocked
    setTimeout(() => _handledActivityDialogs.delete(dedupKey), 3000);
    const el = element?.[0] ?? element ?? app.element;

    // Our CSS hides ALL .activity-choice dialogs by default (to kill the
    // one-frame flash before we auto-close weapon rider dialogs). Any dialog
    // we intentionally LEAVE OPEN must be explicitly revealed, or the user
    // sees nothing — the menu renders into the DOM but stays display:none.
    // This was the Holy Symbol of Ravenkind "invisible power menu" bug.
    const _revealChoice = () => {
      (el?.closest?.(".activity-choice") ?? el)?.classList?.add?.("ace-choice-show");
    };

    // Try to find the Attack activity on this item
    if (item && el?.querySelector) {
      const activities = item.system?.activities;
      if (activities) {
        for (const a of activities) {
          if (a.type === "attack") {
            const btn = el.querySelector(`button[data-activity-id="${a.id}"]`);
            if (btn) {
              console.log(`${MODULE_ID} | Auto-selecting Attack in ActivityChoiceDialog: ${app.title}`);
              setTimeout(() => btn.click(), 0);
              return;
            }
          }
        }
      }
    }

    // ── ACE: Forge-templated items exception (v0.7.10) ─────────────────
    // Items wired by ACE: Forge's Item Template Library (Holy Symbol of
    // Ravenkind etc.) have LEGITIMATE multi-activity setups where the
    // user needs to pick which power to fire (Hold Vampires vs Sunlight
    // vs Turn Undead Enhanced). The original "no attack → close" logic
    // was correctly catching Divine Smite rider popups but ALSO catching
    // these legitimate user-choice dialogs. Leave Forge-templated dialogs
    // open so the user can actually pick.
    if (item?.flags?.["ace-artificer"]?.appliedTemplate) {
      console.log(`${MODULE_ID} | ActivityChoiceDialog for Forge-templated item — leaving open for user choice: ${app.title}`);
      _revealChoice();
      return;
    }

    // ── Spell items handling (v0.7.21+) ────────────────────────────────
    // The "no attack → close" assumption only holds for WEAPON post-hit
    // rider dialogs (Divine Smite, Searing Smite, etc., which our rider
    // engine handles independently). For SPELL items, we want the cast
    // to proceed without an extra click.
    //
    // Strategy: auto-click the FIRST activity button. Most multi-activity
    // spells have the primary "Cast" as activity #0 and secondary options
    // are upcast variants or rarely-used "Dismiss"/"End" actions. For
    // edge cases where a user genuinely wants the second activity, they
    // can use the character sheet directly (which calls the activity by
    // ID without going through the dialog).
    if (item?.type === "spell") {
      if (el?.querySelector) {
        const firstBtn = el.querySelector("button[data-activity-id]");
        if (firstBtn) {
          const activityId = firstBtn.dataset.activityId;
          console.log(`${MODULE_ID} | Spell — auto-clicking first activity (${activityId}): ${app.title}`);
          setTimeout(() => firstBtn.click(), 0);
          return;
        }
      }
      console.log(`${MODULE_ID} | Spell ActivityChoiceDialog with no buttons — leaving open: ${app.title}`);
      _revealChoice();
      return;
    }

    // No Attack button found. The auto-close rationale — post-hit rider dialogs
    // (Divine Smite etc.) handled by our rider engine — applies ONLY to WEAPONS.
    // Any non-weapon multi-activity item (equipment like the Holy Symbol of
    // Ravenkind: Hold Vampires / Turn Undead / Sunlight; consumables; tools;
    // feats) has a LEGITIMATE power-choice the user must make. Leave it open.
    if (item?.type !== "weapon") {
      console.log(`${MODULE_ID} | Multi-activity ${item?.type ?? "item"} — leaving choice open for the user: ${app.title}`);
      _revealChoice();
      return;
    }
    console.log(`${MODULE_ID} | Auto-closing post-hit ActivityChoiceDialog: ${app.title}`);
    setTimeout(() => app.close(), 0);
  }
  Hooks.on("renderApplication", (app, html) => {
    if (app?.options?.classes?.includes("activity-choice")) {
      _handleActivityChoiceDialog(app, html);
    }
  });
  Hooks.on("renderActivityChoiceDialog", (app, element) => {
    _handleActivityChoiceDialog(app, element);
  });

  // ─── Auto-remove combatants when their token is deleted ────────────────────
  // Foundry SHOULD cascade-delete a Combatant when its underlying token goes
  // away, but module interference + unlinked-actor edge cases sometimes leave
  // ghost combatants in the tracker (stale entries pointing at a tokenId that
  // no longer exists). These ghost entries break:
  //   - Auto-pass/fail logic (CombatState.assess reads them)
  //   - "Next turn" / "Previous turn" jumps to an invisible combatant
  //   - Save/concentration prompts fire against non-existent tokens
  //
  // Fix: on every token delete, walk every combat in the world and remove
  // combatants pointing at the deleted token. Idempotent. GM-only because
  // only the GM can edit Combat documents.
  Hooks.on("deleteToken", async (tokenDoc, options, userId) => {
    try {
      if (game.users?.activeGM !== game.user) return;  // activeGM: combatant removal must only run once
      const tokenId = tokenDoc?.id;
      if (!tokenId) return;

      let totalRemoved = 0;
      // Per-iteration guards — audit-mandated 2026-06-08. A single broken or
      // concurrently-deleting combat must NOT abort the whole sweep.
      for (const combat of game.combats ?? []) {
        try {
          // Existence + readiness check — combat may be mid-delete or stale
          if (!combat || combat.deleted) continue;
          if (!combat.combatants) continue;

          // Match by tokenId — covers both linked and synthetic-actor combatants.
          // Also defensively match by uuid since some combatants store token.uuid.
          const targets = combat.combatants.filter(c =>
               c.tokenId === tokenId
            || c.token?.id === tokenId
            || (c.token?.uuid && c.token.uuid.endsWith(`.${tokenId}`))
          );
          if (targets.length === 0) continue;

          const ids = targets.map(c => c.id).filter(Boolean);
          if (!ids.length) continue;

          try {
            await combat.deleteEmbeddedDocuments("Combatant", ids);
            totalRemoved += ids.length;
          } catch (err) {
            console.warn(`${MODULE_ID} | Could not auto-remove combatant(s) ${ids.join(",")} from combat ${combat.id}:`, err);
          }
        } catch (combatErr) {
          // Match / filter / property access on a malformed combat — log and skip.
          console.warn(`${MODULE_ID} | Combatant cleanup loop skipped combat "${combat?.id ?? "?"}" due to error:`, combatErr);
        }
      }
      if (totalRemoved > 0) {
        console.log(`${MODULE_ID} | Auto-removed ${totalRemoved} stale combatant(s) on token delete: "${tokenDoc?.name ?? tokenId}"`);
      }
    } catch (err) {
      console.warn(`${MODULE_ID} | deleteToken combatant-cleanup handler failed:`, err);
    }
  });

  console.log(`${MODULE_ID} | Ready — combat automation active (all features ON by default)`);
});
