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
import { HookAPI }              from "./hook-api.mjs";
import { OverTimeEngine }       from "./overtime-engine.mjs";
import { CoverEngine }          from "./cover-engine.mjs";
import { BloodiedEngine }       from "./bloodied-engine.mjs";
import { VisibilityEngine }     from "./visibility-engine.mjs";
import { ConditionLibrary }     from "./condition-library.mjs";
import { DescriptionParser }    from "./description-parser.mjs";
import { RepeatingSaveEngine }  from "./repeating-save-engine.mjs";
import { TransformationEngine } from "./transformation-engine.mjs";
import { ConcentrationDamage }  from "./concentration-damage.mjs";
import { BonusSpellRule }       from "./bonus-spell-rule.mjs";
import { DeathSaves }           from "./death-saves.mjs";
import { StealthEngine }        from "./stealth-engine.mjs";
import { CombatActions }        from "./combat-actions.mjs";
import { FumbleEngine }         from "./fumble-engine.mjs";
import { OAPrompt }             from "./oa-prompt.mjs";
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

  console.log(`${MODULE_ID} | Initialized`);
});

// ─── Ready: start all subsystems (GM only for combat, all users for effects) ─
Hooks.once("ready", () => {
  if (!_aceQolEnabled()) {
    console.log(`${MODULE_ID} | Module disabled — skipping ready subsystems.`);
    return;
  }

  // Attack pipeline — ALL users
  // Pre-roll hook (advantage/disadvantage, range check) runs on the attacking client.
  // Post-roll processing (_onAttackRoll) has its own GM guard — only GM processes results.
  try {
    attackPipeline = new AttackPipeline();
    console.log(`${MODULE_ID} | Attack pipeline online`);
  } catch (err) {
    console.error(`${MODULE_ID} | Attack pipeline init failed:`, err);
  }

  // Heal pipeline — GM-only handler (registered for all clients but gated inside)
  // Detects HealActivity uses, shows target picker, builds a custom heal card
  // with per-target Apply buttons. Mirrors the attack pipeline architecture.
  try {
    healPipeline = new HealPipeline();
    console.log(`${MODULE_ID} | Heal pipeline online`);
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
    console.log(`${MODULE_ID} | Damage engine online`);
  } catch (err) {
    console.error(`${MODULE_ID} | Damage engine init failed:`, err);
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

  // Reaction engine — ALL users (players receive reaction prompts via socket)
  try {
    reactionEngine = new ReactionEngine();
    injectReactionCSS();
    console.log(`${MODULE_ID} | Reaction engine online`);
  } catch (err) {
    console.error(`${MODULE_ID} | Reaction engine init failed:`, err);
  }

  // Hook API — register public API on the module for third-party extensibility
  try {
    HookAPI.registerAPI();
    console.log(`${MODULE_ID} | Hook API online`);
  } catch (err) {
    console.error(`${MODULE_ID} | Hook API init failed:`, err);
  }

  // OverTime engine — GM only (processes recurring effects on combat turn changes)
  if (game.user.isGM) {
    try {
      overTimeEngine = new OverTimeEngine();
      console.log(`${MODULE_ID} | OverTime engine online`);
    } catch (err) {
      console.error(`${MODULE_ID} | OverTime engine init failed:`, err);
    }
  }

  // Bloodied engine — ALL users (visual overlays render on every client)
  try {
    bloodiedEngine = new BloodiedEngine();
    console.log(`${MODULE_ID} | Bloodied engine online`);
  } catch (err) {
    console.error(`${MODULE_ID} | Bloodied engine init failed:`, err);
  }

  // Visibility engine — ALL users (players need renderChatMessage filtering)
  try {
    VisibilityEngine.registerHooks();
    console.log(`${MODULE_ID} | Visibility engine online`);
  } catch (err) {
    console.error(`${MODULE_ID} | Visibility engine init failed:`, err);
  }

  // Cover engine — static, no constructor needed (API registered after game.aceQol is set)
  console.log(`${MODULE_ID} | Cover engine online`);

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
      return removed;
    };

    Hooks.on("deleteActiveEffect", async (effect, opts, userId) => {
      try {
        if (!game.user.isGM) return; // GM client owns the cleanup
        if (!effect) return;

        // ── Permissive detection ──
        const statuses = effect.statuses;
        const hasStatusSet = statuses?.has?.("concentrating") === true;
        const statusFirst  = statuses?.first?.() ?? null;
        const coreStatus   = effect.flags?.core?.statusId ?? null;
        const dndConcFlag  = effect.flags?.dnd5e?.concentration ?? null;
        const nameLc       = String(effect.name ?? "").toLowerCase();

        const isConcentratingFx =
             hasStatusSet
          || statusFirst === "concentrating"
          || coreStatus === "concentrating"
          || !!dndConcFlag
          || nameLc.startsWith("concentrating")
          || nameLc.includes("concentrating");

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
        if (!game.user.isGM) return;
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
        if (!game.user.isGM) return;
        if (!effect) return;

        // Only react to LINKED dependents — they have flags.dnd5e.dependentOn
        const depOnUuid = effect.flags?.dnd5e?.dependentOn;
        if (!depOnUuid) return;

        // Skip if the deleted effect is itself a Concentrating effect — the
        // other concentration layers handle that case (and we'd recurse).
        const isConcSelf = effect.statuses?.has?.("concentrating")
                       || !!effect.flags?.dnd5e?.concentration
                       || String(effect.name ?? "").toLowerCase().includes("concentrating");
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
        if (!game.user.isGM) return;
        if (!effect) return;

        // Only react to disabled flips on a concentrating effect
        const becameDisabled = changes?.disabled === true;
        if (!becameDisabled) return;

        const isConcentrating = effect.statuses?.has?.("concentrating")
          || !!effect.flags?.dnd5e?.concentration
          || String(effect.name ?? "").toLowerCase().includes("concentrating");
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

    console.log(`${MODULE_ID} | Condition Library online (concentration-link sweep registered)`);
  } catch (err) {
    console.error(`${MODULE_ID} | Condition Library init failed:`, err);
  }

  // Duration Tracker — ALL users init hooks, but only GM processes expirations
  try {
    durationTracker = new DurationTracker();
    durationTracker.init();
    DurationTracker.registerAPI(durationTracker);
    console.log(`${MODULE_ID} | Duration Tracker online`);
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

  // Class Feature Riders (turn-based reset) — clears the once-per-turn flag
  // for features like Radiant Soul (Celestial Warlock 6+) when this actor's
  // turn ends. Same pattern as BonusSpellRule's combatTurnChange handler:
  // we read the PRIOR combatant's actor (the one whose turn just ended) and
  // unset their feature-rider flags. Belt-and-suspenders cleanup also runs
  // on deleteCombat in case state survives a combat ending.
  try {
    Hooks.on("combatTurnChange", (combat /*, prior, current */) => {
      try {
        const priorActorId = combat?.previous?.combatantId
          ? combat?.combatants?.get?.(combat.previous.combatantId)?.actorId
          : null;
        if (priorActorId) {
          const priorActor = game.actors.get(priorActorId);
          if (priorActor) {
            CombatState.clearRadiantSoulFlag(priorActor).catch(() => {});
          }
        }
      } catch (_) { /* non-fatal */ }
    });
    Hooks.on("deleteCombat", (combat) => {
      try {
        for (const c of combat?.combatants?.contents ?? []) {
          if (c.actor) CombatState.clearRadiantSoulFlag(c.actor).catch(() => {});
        }
      } catch (_) { /* non-fatal */ }
    });
    console.log(`${MODULE_ID} | Class feature rider turn-reset hooks registered (Radiant Soul, etc.)`);
  } catch (err) {
    console.error(`${MODULE_ID} | Class feature rider hook setup failed:`, err);
  }

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
    console.log(`${MODULE_ID} | Flags roll hooks online`);
  } catch (err) {
    console.error(`${MODULE_ID} | Flags roll hooks init failed:`, err);
  }

  // Speed Rolls — ALL users (intercepts character sheet clicks for fast-forward)
  try {
    speedRolls = new SpeedRolls();
    console.log(`${MODULE_ID} | Speed rolls online`);
  } catch (err) {
    console.error(`${MODULE_ID} | Speed rolls init failed:`, err);
  }

  // Effects Panel — ALL users (floating list of selected token's active effects)
  try {
    effectsPanel = new EffectsPanel();
    console.log(`${MODULE_ID} | Effects panel online`);
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
    console.log(`${MODULE_ID} | Turn marker online`);
  } catch (err) {
    console.error(`${MODULE_ID} | Turn marker init failed:`, err);
  }

  // Movement Tracker — ALL users (colored squares while dragging tokens)
  try {
    movementTracker = new MovementTracker();
    console.log(`${MODULE_ID} | Movement tracker online`);
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

    console.log(`${MODULE_ID} | Loot engine online`);
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

      console.log(`${MODULE_ID} | Death pipeline online`);
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
      if (!game.user.isGM) return;

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
    });

    console.log(`${MODULE_ID} | Unified NPC death hook registered`);
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

    console.log(`${MODULE_ID} | Player-side attack bridge registered`);
  }

  if (game.user.isGM) {
    // ── GM SIDE: receive player requests via socket ──
    game.socket.on(SOCKET_NAME, async (payload) => {
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

          let hitResult;
          if (isFumbleRoll) hitResult = "fumble";
          else if (coverResult?.isFullCover) hitResult = "miss";
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

          // Emit attackComplete hook for the damage engine
          Hooks.callAll(`${MODULE_ID}.attackComplete`, { item, actor, results, hits, misses });

          // Tell the player to close any system ActivityChoiceDialogs (Divine Smite popup)
          game.socket.emit(SOCKET_NAME, { action: "closeSystemDialogs", userId: payload.userId });
        }
      } catch (err) {
        console.error(`${MODULE_ID} | GM socket handler crashed:`, err);
      }
    });

    console.log(`${MODULE_ID} | GM-side socket listener registered`);
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

        // ── Show the advantage prompt (if enabled) ───────────────────────────
        if (QolSettings.get("advantagePrompt") !== false) {
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
  function _handleActivityChoiceDialog(app, element) {
    const item = app.item;
    const el = element?.[0] ?? element ?? app.element;

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

    // No Attack button found — this is a post-hit rider dialog, close it.
    // Our rider engine handles all post-hit abilities (Divine Smite, etc.)
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

  console.log(`${MODULE_ID} | Ready — combat automation active (all features ON by default)`);
});
