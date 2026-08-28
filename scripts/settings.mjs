// ─── ACE: QOL — Settings Registration ─────────────────────────────────────────
//
// ACE STARTS CONSERVATIVE. It works out hits, resistances, cover and saves,
// and the GM clicks to apply. Anything where ACE would ACT ON ITS OWN —
// applying damage, applying conditions, or answering a player's reaction for
// them — registers OFF and is opted into, never out of.
//
// ⚠️ THIS FILE USED TO SAY "Everything ON by default. Toggle OFF if you want."
// That was true of the registrations and false of the product: a first-run
// hook overlaid the Conservative preset on top. Two sources of truth, and the
// safe one only won when a ready hook completed. The defaults below now ARE
// Conservative, so a first run that never fires lands somewhere safe rather
// than somewhere loud. (2026-08-26, external audit.)
// ──────────────────────────────────────────────────────────────────────────────

import { MODULE_ID } from "./ace-qol.mjs";
import { normalizeFoundryPath, verifyFoundryPath } from "./path-utils.mjs";
import { registerRuleSettings } from "./rules-edition.mjs";

// ── Auto-clean a pasted file-path setting ───────────────────────────────────
// Users copy a path from Windows File Explorer (absolute, backslashes) and
// paste it in. This silently rewrites it to the Foundry-relative forward-slash
// form, then checks the file actually exists and confirms with a toast. Wired
// to file-path settings via their onChange. Re-saving the cleaned value re-fires
// onChange with the already-clean value, which short-circuits to the verify
// branch — so it runs the toast exactly once and never loops.
async function _cleanAndVerifyPathSetting(key, value, label = "path") {
  if (!value || typeof value !== "string") return;
  const cleaned = normalizeFoundryPath(value);
  if (cleaned !== value) {
    try { await game.settings.set(MODULE_ID, key, cleaned); } catch (_) { /* re-save failed */ }
    return; // the re-save's onChange handles the verify + toast
  }
  const ok = await verifyFoundryPath(cleaned);
  if (ok) {
    ui.notifications?.info(`ACE QOL: ${label} set ✓ — ${cleaned}`);
  } else {
    ui.notifications?.warn(`ACE QOL: ${label} cleaned to "${cleaned}", but no file was found there. Double-check it exists (and that the module/folder is installed).`);
  }
}

// ── Preset definitions: which settings each level sets ──────────────────────
const PRESETS = {
  // ⚠️ THE FIRST-RUN PROFILE. A new customer installing a combat automation
  // module for the first time should not have their table's rules quietly
  // decided for them mid-session. Conservative is the "show me, do not do it"
  // setting: ACE works out hits, resistances, cover, save halving and posts
  // the cards, and every APPLY is a click. Nothing fires a reaction, applies
  // damage, applies a condition or ends a turn without a human.
  //
  // This is not "minimal". Minimal turns features OFF. Conservative leaves
  // them on and takes ACE's hands off the wheel.
  conservative: {
    autoCheckHit: true, autoTargetTemplates: true, damageTypeSeparation: true,
    autoCheckResistances: true, halfDamageOnSave: true, concentrationTracking: true,
    batchResultsCard: true, targetStateAssessment: true,
    slayerAutoDetect: true, flanking: false, autoApplyConditions: false,
    autoRollDamage: false, autoApplyDamage: false,
    // Reactions still OFFER — the prompt appears, the player decides. What is
    // off is ACE answering the prompt for them.
    enableReactions: true, autoShield: false, autoCounterspell: false,
    autoAbsorbElements: false, autoLegendaryResistance: false,
    enableSpeedRolls: true, enableMergeCard: false, enableHealPipeline: true,
    extendedEffects: true, effectTransferRules: false,
    enableOnUseHooks: true, enableOverTimeEffects: true, autoApplyOverTimeDamage: false, autoApplyOverTimeHeal: false,
    enableFlagsSystem: true, enableOptionalPrompts: true, midiCompatibility: true,
    enableDurationTracker: true, expireEffectsOnTurnChange: false, notifyOnExpiry: true,
    expiryNotifyAll: false,
    enableCoverCalculation: true, creatureAsCover: false, showCoverIndicator: true,
    ignoreCoverForAdjacent: true,
    enableBloodied: true, announceBloodied: true, enableDeadMarker: true,
    hideSaveDC: false, hideNPCNames: false, playersSeeBloodied: true,
  },
  recommended: {
    autoCheckHit: true, autoTargetTemplates: true, damageTypeSeparation: true,
    autoCheckResistances: true, halfDamageOnSave: true, concentrationTracking: true,
    batchResultsCard: true, targetStateAssessment: true,
    slayerAutoDetect: true, flanking: false, autoApplyConditions: true,
    autoRollDamage: false, autoApplyDamage: false,
    enableReactions: true, autoShield: true, autoCounterspell: true,
    autoAbsorbElements: true, autoLegendaryResistance: true,
    enableSpeedRolls: true, enableMergeCard: false, enableHealPipeline: true,
    extendedEffects: true, effectTransferRules: true,
    enableOnUseHooks: true, enableOverTimeEffects: true, autoApplyOverTimeDamage: false, autoApplyOverTimeHeal: true,
    enableFlagsSystem: true, enableOptionalPrompts: true, midiCompatibility: true,
    enableDurationTracker: true, expireEffectsOnTurnChange: true, notifyOnExpiry: true,
    expiryNotifyAll: false,
    enableCoverCalculation: true, creatureAsCover: false, showCoverIndicator: true,
    ignoreCoverForAdjacent: true,
    enableBloodied: true, announceBloodied: true, enableDeadMarker: true,
    hideSaveDC: false, hideNPCNames: false, playersSeeBloodied: true,
  },
  minimal: {
    autoCheckHit: true, autoTargetTemplates: false, damageTypeSeparation: true,
    autoCheckResistances: true, halfDamageOnSave: true, concentrationTracking: false,
    batchResultsCard: true, targetStateAssessment: false,
    slayerAutoDetect: false, flanking: false, autoApplyConditions: false,
    autoRollDamage: false, autoApplyDamage: false,
    enableReactions: false, autoShield: false, autoCounterspell: false,
    autoAbsorbElements: false, autoLegendaryResistance: false,
    enableSpeedRolls: true, enableMergeCard: false, enableHealPipeline: true,
    extendedEffects: false, effectTransferRules: false,
    enableOnUseHooks: false, enableOverTimeEffects: false, autoApplyOverTimeDamage: false, autoApplyOverTimeHeal: false,
    enableFlagsSystem: false, enableOptionalPrompts: false, midiCompatibility: false,
    enableDurationTracker: false, expireEffectsOnTurnChange: false, notifyOnExpiry: false,
    expiryNotifyAll: false,
    enableCoverCalculation: false, creatureAsCover: false, showCoverIndicator: false,
    ignoreCoverForAdjacent: true,
    enableBloodied: true, announceBloodied: false, enableDeadMarker: true,
    hideSaveDC: false, hideNPCNames: false, playersSeeBloodied: true,
  },
  full: {
    autoCheckHit: true, autoTargetTemplates: true, damageTypeSeparation: true,
    autoCheckResistances: true, halfDamageOnSave: true, concentrationTracking: true,
    batchResultsCard: true, targetStateAssessment: true,
    slayerAutoDetect: true, flanking: true, autoApplyConditions: true,
    autoRollDamage: true, autoApplyDamage: true,
    enableReactions: true, autoShield: true, autoCounterspell: true,
    autoAbsorbElements: true, autoLegendaryResistance: true,
    enableSpeedRolls: true, enableMergeCard: true,
    extendedEffects: true, effectTransferRules: true,
    enableOnUseHooks: true, enableOverTimeEffects: true, autoApplyOverTimeDamage: true, autoApplyOverTimeHeal: true,
    enableFlagsSystem: true, enableOptionalPrompts: true, midiCompatibility: true,
    enableDurationTracker: true, expireEffectsOnTurnChange: true, notifyOnExpiry: true,
    expiryNotifyAll: true,
    enableCoverCalculation: true, creatureAsCover: true, showCoverIndicator: true,
    ignoreCoverForAdjacent: true,
    enableBloodied: true, announceBloodied: true, enableDeadMarker: true,
    hideSaveDC: false, hideNPCNames: false, playersSeeBloodied: true,
  },
};

// ── Settings that presets control (hidden when not "custom") ────────────────
// ⚠️ THE UNION, not one preset's keys. Deriving this from "recommended" alone
// meant a key that only another preset touched was never hidden and never
// managed — a silent gap that grows every time a preset gains an entry.
const PRESET_MANAGED_KEYS = new Set(Object.values(PRESETS).flatMap(p => Object.keys(p)));

export class QolSettings {

  /**
   * Apply a preset by batch-setting all managed toggles.
   */
  /**
   * FIRST RUN: make the dropdown tell the truth.
   *
   * ⚠️🔴 THE PRESET WAS A LABEL, NOT A BOOT PATH (Brock, 2026-08-19).
   * applyPreset only ever ran from the setting's onChange, so a brand-new
   * install never applied anything. The world came up on the per-key registered
   * defaults — which are almost all `true`, i.e. effectively Full Automation —
   * while the dropdown displayed "Recommended". The dropdown lied until
   * somebody happened to toggle it, and the manifest said "everything ON by
   * default", which was the only honest sentence in the set.
   *
   * ⚠️ AND IT MUST NOT TOUCH AN EXISTING WORLD. Applying a preset on upgrade
   * would silently overwrite settings a GM has spent months tuning. So this
   * needs an exact test for "brand new", not a heuristic.
   *
   * There is one: Foundry only stores a Setting document for a setting that has
   * actually been SET. A world that has never saved a single ace-qol setting has
   * never been configured. That is not a guess about intent, it is the absence
   * of the data itself.
   */
  static async applyPresetOnFirstRun() {
    if (!game.user?.isGM) return;
    try {
      if (game.settings.get(MODULE_ID, "presetInitialised")) return;

      const stored = game.settings.storage?.get?.("world") ?? [];
      const everSaved = [...stored].some(setting =>
        String(setting?.key ?? "").startsWith(`${MODULE_ID}.`));

      if (everSaved) {
        // An existing world. Whatever is on disk is the GM's, not ours to
        // rewrite. Record that we looked, change nothing, say nothing.
        await game.settings.set(MODULE_ID, "presetInitialised", true);
        console.log(`${MODULE_ID} | Existing world — settings left exactly as they are.`);
        return;
      }

      // Genuinely fresh. Start Conservative: a combat automation module should
      // not decide a stranger's table rules before they have seen it work once.
      await QolSettings.applyPreset("conservative", { quiet: true });
      await game.settings.set(MODULE_ID, "automationLevel", "conservative");
      await game.settings.set(MODULE_ID, "presetInitialised", true);
      console.log(`${MODULE_ID} | Fresh install — started on the Conservative preset.`);
      ui.notifications?.info(
        "ACE QOL is set to Conservative: it works out hits, resistances and cover, " +
        "and you click to apply. Change it any time in the module settings.",
        { permanent: true });
    } catch (err) {
      console.warn(`${MODULE_ID} | First-run preset check failed:`, err);
    }
  }

  static async applyPreset(presetName, { quiet = false } = {}) {
    const preset = PRESETS[presetName];
    if (!preset) return;
    for (const [key, value] of Object.entries(preset)) {
      try { await game.settings.set(MODULE_ID, key, value); }
      catch (_) { /* setting may not exist yet */ }
    }
    if (!quiet) ui.notifications?.info(`ACE QOL: Applied "${presetName}" automation preset.`);
  }

  static register() {
    const s = (key, opts) => game.settings.register(MODULE_ID, key, opts);

    // ── Tabbed configuration panel — single button in module settings ──
    try {
      // Lazy import so we don't pull in ApplicationV2 before Foundry is ready
      import("./config-panel.mjs").then(({ AceQolConfigPanel }) => {
        game.settings.registerMenu(MODULE_ID, "configurePanel", {
          name:     "ACE QOL — Configuration Panel",
          label:    "Open Configuration",
          hint:     "Open the tabbed configuration panel — every setting organized by feature.",
          icon:     "fa-solid fa-cog",
          type:     AceQolConfigPanel,
          restricted: true,
        });
      }).catch(err => console.warn(`${MODULE_ID} | Config panel registration deferred:`, err));
    } catch (err) {
      console.warn(`${MODULE_ID} | Config panel menu registration failed:`, err);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  GAME RULES EDITION — single source of truth for 2014 vs 2024 5e rules
    //
    //  Registered FIRST so new users see it immediately on Configure Settings.
    //  Many class features and magic items behave differently between 2014 and
    //  2024 editions (Lifedrinker, Hunter's Mark, True Strike, Counterspell,
    //  Surprise, Weapon Masteries, etc.). This single toggle drives every
    //  edition-aware feature implementation through the getActiveEdition
    //  helper in combat-state.mjs.
    //
    //  "Auto" is the default: at evaluation time, we inspect the relevant
    //  actor's class items and feats for 2024-only markers (weapon mastery
    //  property, Innate Sorcery feat, etc.). When in doubt, falls back to
    //  2014 — the larger of the two player bases per market surveys as of
    //  2026 (roughly 50% want 2014 vs 25% want 2024; remainder split).
    // ═══════════════════════════════════════════════════════════════════════════
    // ⚠️ AUTO IS GONE, BY INSTRUCTION (2026-08-23). Johnny: "I don't want
    // fucking Auto Detect. That's just going to screw things up." For a sold
    // product he is right — a per-actor sniff means two creatures in one fight
    // can run different rules, and no support conversation can begin with "it
    // depends what ACE decided about that goblin". Worlds still on Auto are
    // migrated once, to the answer Auto was already giving them, so nothing
    // changes underneath a live campaign. See rules-edition.mjs.
    //
    // ⚠️ AND IT SYNCS WITH ACE ENGINE. The old hint asked the GM to "mirror
    // this with the same setting in ACE QOL" — the module asking a human to keep
    // two settings in step by hand. Setting either one now sets both.
    s("gameRulesEdition", {
      name: "D&D 5e Rules Edition",
      hint: "Which ruleset ACE follows for the rules that actually differ — Weapon Mastery, Exhaustion, Great Weapon Master, Sharpshooter, Crusher/Slasher, Lifedrinker, Stunning Strike and Command. Custom lets you mix them one by one on the ACE QOL panel. This is shared with ACE Engine: change it here and it changes there.",
      scope: "world",
      config: true,
      type: String,
      choices: {
        "2014":  "2014 Rules (original 5e Player's Handbook)",
        "2024":  "2024 Rules (new Player's Handbook / One D&D)",
        custom:  "Custom — choose each rule yourself (Homebrew)",
      },
      default: "2024",
      onChange: (value) => {
        import("./rules-edition.mjs").then(async (m) => {
          // Picking a plain edition sets every individual rule to match, so a
          // later switch to Custom starts from where they actually were rather
          // than from an unrelated default.
          if (value === "2014" || value === "2024") await m.setAllRules(value);
          await m.syncEditionTo("ace-engine", value);
          m.reportEdition();
        }).catch(err => console.warn("ace-qol | rules-edition sync failed:", err));
      },
    });

    // The eight rules that genuinely differ. Hidden from the native list — they
    // mean nothing unless the mode is Custom, and eight dead rows is noise for
    // the tables who pick an edition and move on.
    try { registerRuleSettings(s); }
    catch (err) { console.warn("ace-qol | could not register the per-rule edition settings:", err); }

    // ⚠️🔴 A SETTING THAT OVERRIDES YOUR EDITION MUST LIVE BESIDE IT (2026-08-23).
    //
    // This was `config: false`, surfaced only on ACE's own Weapon Masteries tab.
    // So a switch that makes 2024 masteries fire inside a 2014 world was
    // INVISIBLE in the place a GM goes to look at settings.
    //
    // Johnny spent an evening on it: he set his world to 2014, kept seeing Vex
    // and Topple, and said "I don't see anywhere where it says houserule
    // override active." He was looking in Game Settings. It was not there.
    //
    // Registered immediately after the edition picker so it appears next to the
    // thing it overrides — Foundry lists settings in registration order, so
    // position here is the whole fix. It stays on the ACE panel too; a setting
    // can appear in both places, and the one place it must appear is the
    // obvious one.
    s("weaponMasteryAllowIn2014", {
      name:    "Weapon Mastery — use it in 2014 rules anyway (houserule)",
      hint:    "OVERRIDES the Rules Edition above for Weapon Mastery only. Weapon Mastery is a 2024 feature and does not exist in 2014, so it normally does nothing in a 2014 world. Turn this ON only if you deliberately want to import Vex, Topple, Graze and the rest into a 2014 game as a houserule. If you set the edition to 2014 and are still seeing masteries fire, this is why.",
      scope:   "world",
      config:  true,
      type:    Boolean,
      default: false,
    });

    // ═══════════════════════════════════════════════════════════════════════════
    //  3D DISTANCE — strict-RAW nearest-edge measurement counts elevation
    //
    //  All reach/range/spell/aura/radius checks in ACE measure from the nearest
    //  EDGE of each creature's space (size-aware), counting 5-ft grid steps the
    //  5e-default way (diagonal = straight). With this ON, vertical separation
    //  (flying, ledges) counts too, per strict RAW. At equal elevation it
    //  changes nothing — only flyers/height are affected. See geometry-utils.mjs.
    // ═══════════════════════════════════════════════════════════════════════════
    // ⚠️ JOHNNY'S STANDING RULE IS "ASK BEFORE ADDING A SETTING", AND THIS ONE
    // WAS ADDED WITHOUT ASKING because he was asleep and this is a kill switch
    // rather than a table preference. It needs to exist because the engine is a
    // genuine behaviour change: an item nobody curated used to fall through to
    // the generic save engine, and now the pipeline claims it. That is the point
    // of the engine, and it is also the thing most likely to need turning off at
    // a table mid-session. Rolling back a version is not something he should
    // have to do live. Say the word and it comes out.
    s("inferenceEngine", {
      name:    "Work Out Unregistered Spells and Features",
      hint:    "When ON (default), ACE reads any spell, feature or trait nobody has "
             + "written an entry for and works out how it resolves from its own data "
             + "and rules text, then remembers the answer. When OFF, only the "
             + "hand-written entries are used and everything else falls through to "
             + "the generic engine, exactly as it behaved before this existed. "
             + "Anything ACE gets wrong can be corrected once from the review list "
             + "and stays corrected.",
      scope:   "world",
      config:  true,
      type:    Boolean,
      default: true,
    });

    // ── The inference engine's memory ─────────────────────────────────
    // Not a preference and never shown as one: this is the store where ACE
    // writes down what it worked out about an item nobody registered, plus any
    // shape a GM has corrected by hand. World-scoped because every client must
    // resolve the same action the same way.
    s("learnedShapes", {
      name:    "What ACE has worked out",
      hint:    "Internal store. Managed from the ACE panel, not here.",
      scope:   "world",
      config:  false,
      type:    Object,
      default: {},
    });

    s("raw3dDistance", {
      name:    "3D Distance (count elevation)",
      hint:    "Measure reach, range, spells, and auras in 3D per strict 5e RAW — height from flying or elevation counts toward distance. When everyone is at the same elevation this changes nothing. Turn OFF for flat 2D. Default: ON.",
      scope:   "world",
      config:  false,   // lives in the ACE config panel (Combat Actions tab)
      type:    Boolean,
      default: true,
    });

    // ═══════════════════════════════════════════════════════════════════════════
    //  SQUARE CUBE TEMPLATES — keep 5e cube AoEs grid-aligned squares
    //
    //  D&D 5e cubes (Web, Thunderwave, Cloudkill area, Sleet Storm, etc.) should
    //  occupy a true N-ft square. dnd5e only does this when its own
    //  "gridAlignedSquareTemplates" world setting is ON (which IS its default).
    //  When that setting is OFF, dnd5e turns every cube into a draggable RAY —
    //  a rectangle whose length follows the mouse — so a "20-ft cube" can land
    //  as a 40-ft-long strip. That breaks BOTH the visual AND ACE's area
    //  detection (who's caught in the web), since detection reads the real
    //  drawn template shape. With this ON, ACE restores the correct square cube
    //  at load so area saves, auras, and persistent animations match the
    //  spell's true footprint. Turn OFF only if you deliberately want
    //  rotatable rectangular cubes. Default: ON.
    // ═══════════════════════════════════════════════════════════════════════════
    s("enforceSquareCubes", {
      name:    "Square Cube Templates",
      hint:    "Keep 5e cube spells (Web, Thunderwave, etc.) as true grid-aligned squares so area detection and animations match the real footprint. Restores the dnd5e default; turn OFF only if you want rotatable rectangular cubes. Default: ON.",
      scope:   "world",
      config:  false,   // lives in the ACE config panel (Templates tab)
      type:    Boolean,
      default: true,
    });

    // ═══════════════════════════════════════════════════════════════════════════
    //  SPELL DIFFICULT TERRAIN — auto movement-cost Region for area spells
    //
    //  Spells that fill their area with difficult terrain (Web, Spike Growth,
    //  etc.) drop a Foundry V13 movement-cost Region matching the template, so
    //  the token ruler charges double to move through. The Region is removed
    //  automatically when the spell's template is deleted (concentration end,
    //  duration end, or manual delete). Turn OFF if your table tracks difficult
    //  terrain by hand or uses another terrain module. Default: ON.
    // ═══════════════════════════════════════════════════════════════════════════
    s("spellDifficultTerrain", {
      name:    "Spell Difficult Terrain",
      hint:    "Area spells that create difficult terrain (Web, Spike Growth, …) drop a movement-cost Region so the token ruler charges 2x to move through — removed automatically when the spell ends. Turn OFF to track difficult terrain manually. Default: ON.",
      scope:   "world",
      config:  false,   // lives in the ACE config panel (Templates tab)
      type:    Boolean,
      default: true,
    });

    // ═══════════════════════════════════════════════════════════════════════════
    //  LOCK RESTRAINED MOVEMENT — players can't drag a held token (RAW speed 0)
    //
    //  Restrained and Grappled both set a creature's speed to 0 — it can't move
    //  on its own. With this ON, a PLAYER trying to drag their own Restrained /
    //  Grappled token is stopped (the token snaps back). The GM is never
    //  blocked, so forced movement, repositioning, and shoves all still work,
    //  and the creature can still break free and then move. Default: ON.
    // ═══════════════════════════════════════════════════════════════════════════
    s("lockRestrainedMovement", {
      name:    "Lock Restrained Movement",
      hint:    "Players can't drag a token that can't move under RAW — Restrained, Grappled, Paralyzed, Stunned, Unconscious, or Petrified. (Prone is excluded — it can still crawl.) The GM can always reposition it; the creature moves again once the condition clears. Default: ON.",
      scope:   "world",
      config:  false,   // lives in the ACE config panel (Combat Actions tab)
      type:    Boolean,
      default: true,
    });

    // ⚠️ "hideMovementTrail" WAS HERE AND IS GONE (2026-08-19). It patched four
    // of core's token-ruler style hooks to blank the history path that Foundry
    // draws when you hover a token. It was removed at Johnny's request, and the
    // reasoning is worth keeping: the trail is core behaviour, we never read it
    // for anything, and suppressing somebody else's rendering to hide a
    // cosmetic annoyance cost hours of misdiagnosis - every investigation into
    // "what is drawing this" had to see past our own filter first.
    //
    // If it comes up again: core's BaseTokenRuler#isVisible is
    //   token.hover || layer.highlightObjects || token.showRuler || token.isDragged
    // with no setting anywhere, and the history is stored on the token document
    // so it survives reloads. Core clears it when that token's TURN STARTS.
    // The honest fix is to advance the turn or call
    // game.aceQol.clearMovementHistory(), not to paint over the renderer.

    // ═══════════════════════════════════════════════════════════════════════════
    //  MODULE MASTER ENABLED — global kill-switch, sits at top of settings page
    // ═══════════════════════════════════════════════════════════════════════════

    s("moduleEnabled", {
      name:    "ACE QOL — Enabled",
      hint:    "Master on/off switch for the entire module. When OFF, all QOL automation and UI is skipped. Requires a world reload to take effect.",
      scope:   "world",
      config:  true,
      type:    Boolean,
      default: true,
    });

    // ═══════════════════════════════════════════════════════════════════════════
    //  TOOLTIP DELAY — slows down Foundry's hover tooltips
    // ═══════════════════════════════════════════════════════════════════════════
    //
    //  Foundry's default is 500ms which fires almost instantly when mousing
    //  past elements. A higher value gives you breathing room to scan a
    //  character sheet without tooltips popping over what you're trying to
    //  read. 1500ms is the sweet spot per user testing; 500ms is Foundry
    //  default for users who like the original behavior. Applies live —
    //  no reload needed when changed.
    s("tooltipDelay", {
      name:    "Tooltip Hover Delay (ms)",
      hint:    "How long you must hover before a tooltip appears (Foundry default is 500ms — too fast for some users). 1500ms = 1.5 seconds. Set to 500 to restore Foundry default. Applies live; no reload required.",
      scope:   "client",
      config:  false,   // surfaced via the ACE config panel (UI / Cards tab), not native settings
      type:    Number,
      range:   { min: 100, max: 5000, step: 100 },
      default: 1500,
      onChange: (value) => {
        try {
          const v = Number(value) || 500;
          if (foundry.helpers?.interaction?.TooltipManager) {
            foundry.helpers.interaction.TooltipManager.TOOLTIP_ACTIVATION_DELAY = v;
            console.log(`${MODULE_ID} | Tooltip delay set to ${v}ms (live update).`);
          }
        } catch (err) {
          console.warn(`${MODULE_ID} | Tooltip delay live-update failed:`, err);
        }
      },
    });

    // ── Player Can Start Combat ────────────────────────────────────────────
    //  RAW (5e): any combatant can initiate combat — the assassin striking
    //  from stealth, the wizard hurling a fireball at a guard, the rogue
    //  pulling a knife in a tavern brawl. Foundry's default requires the GM
    //  to manually create the encounter first, which is a flow-break:
    //  "wait, stop, let me make a combat tracker entry, NOW you can roll
    //  initiative" — completely backwards from how D&D actually plays.
    //
    //  When ON: players (and GMs) can roll initiative anytime. If no active
    //  combat exists in the current scene, ACE QOL auto-creates one and
    //  adds the rolling actor as a combatant. Players who lack permission
    //  to create Combat documents emit a socket request to the GM client,
    //  which handles the creation on their behalf and emits acknowledgment.
    //
    //  Defaults ON because this is RAW-correct behavior and what every
    //  commercial customer will expect.
    s("playerCanStartCombat", {
      name:    "Players Can Start Combat (RAW)",
      hint:    "When enabled, any player rolling initiative auto-creates a combat encounter if none exists. Restores standard D&D flow (any combatant can initiate). Default OFF so installing ACE QOL doesn't change Foundry's default GM-only combat-creation behavior without an explicit opt-in.",
      scope:   "world",
      config:  false,   // surfaced via the ACE config panel (Initiative tab), not native settings
      type:    Boolean,
      default: false,
    });

    // ── Hidden NPC Initiative ──────────────────────────────────────────────
    //  When ON: any time an NPC rolls initiative, the resulting chat message
    //  is whispered to GMs only — players never see "Hidden Bandit rolled 17
    //  for initiative" and therefore can't meta-game knowing an ambush is
    //  about to drop. Works regardless of how initiative is rolled (combat
    //  tracker, BG3 HUD, hotkey, manual). PC initiative rolls are still
    //  public — only NPCs are hidden. Defaults to ON because every GM wants
    //  this; the only reason to turn it off is if your table prefers
    //  fully-transparent combat for some reason.
    s("hideNpcInitiative", {
      name:    "Hide NPC Initiative Rolls from Players",
      hint:    "When enabled, NPC initiative rolls go to GM-only chat. Players never see the roll, preventing meta-gaming from ambushes and hidden combatants. PC initiative rolls remain public. Default OFF — opt-in so installing ACE QOL doesn't silently change Foundry's default visibility behavior for new GMs.",
      scope:   "world",
      config:  false,   // lives in the ACE config panel (Initiative tab)
      type:    Boolean,
      default: false,
    });

    s("weaponMasteryEnabled", {
      name:    "Weapon Mastery (2024 PHB) — Enabled",
      hint:    "Auto-fires mastery effects (Cleave, Graze, Vex, Sap, Topple, etc.) when a weapon is used. Each mastery posts a chat card and applies its effect where automatable.",
      scope:   "world",
      config:  false,
      type:    Boolean,
      default: true,
    });

    // ── Weapon Mastery 2014 Override ───────────────────────────────────────
    //  Weapon Mastery is a D&D 2024 PHB feature; by default ACE QOL skips
    //  it in 2014 (Legacy) mode because the feature doesn't exist there.
    //  BUT some tables run 2014 ruleset and want Weapon Mastery as a
    //  houserule import from 2024. Turning this ON forces the mastery
    //  system to fire even when dnd5e's rulesVersion is "legacy".
    //
    //  Default OFF (pure 2014 RAW). Flip ON for hybrid play.
    s("cleaveRawAttackRoll", {
      name:    "Cleave — Roll to Hit (RAW)",
      hint:    "ON (default, 2024 RAW): the Cleave weapon mastery (Greataxe/Halberd) makes a real attack roll against the second creature — it CAN miss. On a hit, the second creature takes the weapon's damage minus your ability modifier. OFF: the cleave auto-hits (faster; treats the second hit as automatic damage, the old behaviour). Only affects Cleave.",
      scope:   "world",
      config:  false,   // surfaced via the ACE config panel (Weapon Masteries tab), not native settings
      type:    Boolean,
      default: true,
    });

    s("weaponMasteryStrict", {
      name:    "Weapon Mastery — Strict (require feature)",
      hint:    "When ON, only actors with a 'Weapon Mastery' class feature can fire masteries (RAW 2024). When OFF, every weapon fires its mastery for every wielder (looser, useful for monster attacks).",
      scope:   "world",
      config:  false,
      type:    Boolean,
      default: true,
    });

    // ═══════════════════════════════════════════════════════════════════════════
    //  AUTOMATION LEVEL PRESET — controls 30+ toggles with one dropdown
    // ═══════════════════════════════════════════════════════════════════════════

    // Have we ever decided what this world starts on? See applyPresetOnFirstRun.
    s("presetInitialised", {
      scope:   "world",
      config:  false,
      type:    Boolean,
      default: false,
    });

    s("automationLevel", {
      name:    "Automation Level",
      hint:    "Quick preset for all combat automation. Use the 'Open Configuration' button above for full per-setting control via the tabbed panel.",
      scope:   "world",
      config:  true,
      type:    String,
      // ⚠️🔴 CONSERVATIVE IS THE DEFAULT, NOT AN OVERLAY ON TOP OF ONE.
      //
      // This read "recommended" while applyPresetOnFirstRun wrote
      // "conservative" over it at first boot. Two sources of truth, and the
      // safe one only won if a ready hook fired and completed. If that first
      // run threw - a settings read failing, a migration ahead of it dying -
      // the table silently came up on Recommended, with ACE answering Shield
      // and Counterspell for the players.
      //
      // A safe default must be the DEFAULT. External audit, 2026-08-26.
      default: "conservative",
      choices: {
        conservative: "Conservative — ACE works it out, you click to apply",
        recommended:  "Recommended — sensible defaults, most features ON",
        minimal:      "Minimal — basic hit checking and damage only",
        full:         "Full Automation — everything ON, maximum automation",
        custom:       "Custom — leave individual settings as-is (use the panel)",
      },
      onChange: (value) => {
        if (value !== "custom") QolSettings.applyPreset(value);
      },
    });

    // ═══════════════════════════════════════════════════════════════════════════
    //  COMBAT WORKFLOW — the read-only half is ON, the acting half is OFF.
    //  Working out a hit is safe; applying damage without being asked is not.
    // ═══════════════════════════════════════════════════════════════════════════

    s("autoCheckHit", {
      name:    "Auto-Check Hit vs AC",
      hint:    "Automatically compare attack rolls against target AC, factoring in cover, conditions, and buffs.",
      scope:   "world",
      config:  false,
      type:    Boolean,
      default: true,
    });

    s("autoTargetTemplates", {
      name:    "Auto-Target Tokens in Templates",
      hint:    "When a measured template is placed (Fireball, Moonbeam, etc.), automatically target all tokens inside it.",
      scope:   "world",
      config:  false,
      type:    Boolean,
      default: true,
    });

    s("hideSpellTemplateVisuals", {
      name:    "Hide Spell Template Visuals",
      hint:    "When a spell places a template, hide the visual (red zone, ruler, etc.) from GM and players. The spell still works normally — Spike Growth still damages on movement, auto-targeting still fires — only the visual is suppressed. End concentration to delete the template.",
      scope:   "world",
      config:  false,
      type:    Boolean,
      default: true,
    });

    s("suppressSelfSpellTemplates", {
      name:    "No Template for Self / Emanation Spells",
      hint:    "Self-centered spells (Detect Magic, Detect Evil & Good, and other spells ACE classifies as emanating from the caster) don't need a placed template — they radiate from you. When ON (default), ACE cancels the template-placement prompt for those spells so you never have to drop a circle for a spell that just emanates from yourself (a mis-built stat-block spell can otherwise prompt one). Auras that project a tracked zone (Spirit Guardians, etc.) are unaffected. Turn OFF to let every template through.",
      scope:   "world",
      config:  false,
      type:    Boolean,
      default: true,
    });

    s("damageTypeSeparation", {
      name:    "Separate Damage by Type",
      hint:    "Roll and display each damage type separately (slashing, cold, fire, etc.) so resistances apply per type.",
      scope:   "world",
      config:  false,
      type:    Boolean,
      default: true,
    });

    s("autoCheckResistances", {
      name:    "Check Resistances/Immunities",
      hint:    "Automatically check target resistances, immunities, and vulnerabilities for each damage type.",
      scope:   "world",
      config:  false,
      type:    Boolean,
      default: true,
    });

    s("halfDamageOnSave", {
      name:    "Half Damage on Save",
      hint:    "Automatically detect 'half damage on save' from spell descriptions and apply accordingly.",
      scope:   "world",
      config:  false,
      type:    Boolean,
      default: true,
    });

    s("concentrationTracking", {
      name:    "Concentration Tracking",
      hint:    "Track concentration spells, prompt saves on damage, remove effects when concentration breaks.",
      scope:   "world",
      config:  false,
      type:    Boolean,
      default: true,
    });

    // ⚠️ "concentrationWidget" WAS REGISTERED HERE AND IS DELIBERATELY GONE
    // (2026-08-27). It switched a floating card that has been removed: every
    // trigger the card offered already fires on its own, so its button only
    // ever re-rolled an area for no reason. A setting that controls nothing is
    // worse than no setting - it tells the GM a feature exists.
    //
    // The concentration TRACKING it was named after is untouched and is not
    // optional: it is what makes Moonbeam and Spirit Guardians damage anyone.

    // Whether ace-qol owns the persistent-spell animation layer (Sequencer
    // chain attached to the template). Default false — Automated Animations
    // is the mature, configurable visual layer that GMs already know; our
    // SPELL_ANIMATIONS table is opt-in for users who specifically want
    // ace-qol to render those 11 spells through its own pipeline.
    // Damage / saves / concentration / effects are ALWAYS owned by ace-qol
    // regardless of this setting — only the visual is gated.
    s("ownSpellAnimations", {
      name:    "ace-qol Owns Persistent-Spell Animations",
      hint:    "When ON, ace-qol's SPELL_ANIMATIONS table plays animations for known concentration AoE spells (Stinking Cloud, Cloudkill, Spike Growth, etc) via a Sequencer chain attached to the template. When OFF (default), Automated Animations handles all spell visuals — ace-qol still owns damage/saves/concentration. Turn ON only if you want ace-qol's animations instead of AA's.",
      scope:   "world",
      config:  false,
      type:    Boolean,
      default: false,
    });

    s("concentrationOnDamage", {
      name:    "Concentration Save on Damage (RAW)",
      hint:    "When a concentrating actor takes damage, automatically prompt a Constitution saving throw with DC = max(10, floor(damage / 2)). On fail, the concentration effect is removed and dependent spells end. PHB 203.",
      scope:   "world",
      config:  false,
      type:    Boolean,
      default: true,
    });

    s("concentrationDamageMinDC", {
      name:    "Concentration Save Minimum DC",
      hint:    "Floor for the auto-fired concentration save DC. RAW says 10 — leave this alone unless your table uses a houserule. Damage of 21+ generates DC 11+ via the half-damage formula regardless of this setting.",
      scope:   "world",
      config:  false,
      type:    Number,
      default: 10,
      range:   { min: 5, max: 25, step: 1 },
    });

    s("unifyConcentrationMarker", {
      name:    "Single Concentration Marker (ACE)",
      hint:    "When you cast a self-concentration spell (Detect Magic, Blur, Fly, …) dnd5e drops a 'Concentrating: X' effect AND ACE drops its own spell marker — two icons for one spell. When ON (default), ACE folds them into ONE: dnd5e's concentration effect is re-dressed with ACE's name, icon, and description (and ACE's flags, for duration/time-tracking) while keeping its concentration status underneath — so break-on-damage and auto-cleanup still work, and you only see one marker. Turn OFF to keep dnd5e's separate 'Concentrating:' effect visible alongside ACE's.",
      scope:   "world",
      config:  false,
      type:    Boolean,
      default: true,
    });

    s("bonusActionSpellRule", {
      name:    "Bonus Action Spell Rule (RAW)",
      hint:    "Enforce PHB 202: 'You can't cast another spell during the same turn, except for a cantrip with a casting time of 1 action.' Blocks leveled spells after a bonus-action leveled spell, and bonus-action leveled spells after any other spell on the same turn.",
      scope:   "world",
      config:  false,
      type:    Boolean,
      default: true,
    });

    s("bonusActionSpellStrict", {
      name:    "Bonus Action Spell Rule — Strict",
      hint:    "When ON, the rule stops the cast outright. When OFF it only warns you and lets it through, so you can rule on it yourself. Default ON.",
      scope:   "world",
      config:  false,
      type:    Boolean,
      default: true,
    });

    s("armorProfSpellBlock", {
      name:    "Block Spellcasting in Unproficient Armor (RAW)",
      hint:    "RAW (PHB p.144): a PC wearing armor they lack proficiency with cannot cast spells. When ON, attempts to cast are blocked with an error toast. When OFF, casts proceed normally. PC-only — does not affect NPC casters. Default ON.",
      scope:   "world",
      config:  false,
      type:    Boolean,
      default: true,
    });

    s("armorProfCheckSaveDisadvantage", {
      name:    "Disadvantage on STR/DEX Checks & Saves in Unproficient Armor (RAW)",
      hint:    "RAW (PHB p.144): the same unproficient-armor rule that imposes attack-roll disadvantage and blocks spellcasting ALSO imposes disadvantage on any STR or DEX ability check or saving throw. When ON, those rolls automatically take disadvantage if the PC is wearing armor they lack proficiency with. PC-only. Default ON.",
      scope:   "world",
      config:  false,
      type:    Boolean,
      default: true,
    });

    // ── Death Saves (PHB 197) ────────────────────────────────────────────
    s("autoDeathSaves", {
      name: "Auto-Roll Death Saves",
      hint: "When a PC at 0 HP starts their turn, automatically roll their death save.",
      scope: "world", config: false, type: Boolean, default: true,
    });
    s("massiveDamageDeath", {
      name: "Massive Damage Instant Death (PHB 197)",
      hint: "If damage exceeds the target's HP maximum on a hit that would drop them to 0, they die instantly.",
      scope: "world", config: false, type: Boolean, default: true,
    });
    s("autoResetOnHeal", {
      name: "Reset Death Save Tally on Heal",
      hint: "When a PC heals from 0 HP back to 1+ HP, clear their death save success/failure count.",
      scope: "world", config: false, type: Boolean, default: true,
    });

    // ── Stealth / Hide / Surprise (PHB 192-194) ─────────────────────────
    s("autoSurpriseCheck", {
      name: "Auto Surprise Check at Combat Start",
      hint: "Compare each combatant's passive Perception against opposing-side stealth at combat start. Surprised combatants skip turn 1. Default OFF — Surprise (PHB 192-194) is a RAW rule many tables don't enforce; opt-in so installing ACE QOL doesn't silently change how combat-start works for GMs unfamiliar with the rule.",
      scope: "world", config: false, type: Boolean, default: false,
    });
    s("hideActionEnabled", {
      name: "Hide Action Enabled",
      hint: "Adds a Hide button to the token toolbar.",
      scope: "world", config: false, type: Boolean, default: true,
    });
    s("hideRevealsOnAttack", {
      name: "Hide Reveals on Attack",
      hint: "When a hidden token makes an attack, automatically clear their hidden state (PHB 195).",
      scope: "world", config: false, type: Boolean, default: true,
    });
    s("hideRevealsOnDamage", {
      name: "Hide Reveals on Damage Taken",
      hint: "When a hidden token takes damage, automatically clear their hidden state.",
      scope: "world", config: false, type: Boolean, default: true,
    });

    // ── Ranged-in-melee disadvantage (PHB 195) ──────────────────────────
    s("rangedInMeleeDisadvantage", {
      name: "Ranged in Melee = Disadvantage (PHB 195)",
      hint: "Disadvantage on ranged attack rolls when a hostile creature within 5 feet can see the attacker (and isn't incapacitated/unconscious/etc).",
      scope: "world", config: false, type: Boolean, default: true,
    });

    // ── Critical Fumble (table rule, NOT RAW) ───────────────────────────
    s("criticalFumbleEnabled", {
      name: "Critical Fumble Table",
      hint: "OPTIONAL house rule. When an attack roll is a natural 1, post a fumble chat card with a rolled effect. Off by default — many tables don't use fumbles.",
      scope: "world", config: false, type: Boolean, default: false,
    });

    s("fumbleEndsTurn", {
      name: "Fumble Ends the Turn",
      hint: "OPTIONAL house rule. When a combatant rolls a natural 1 on an attack during their OWN turn, their turn ends IMMEDIATELY — the turn auto-advances, no further attacks, bonus actions, or the multiattack pop-up. Off by default. (Independent of the Critical Fumble Table above.)",
      scope: "world", config: false, type: Boolean, default: false,
    });

    s("ghostlyHowlSound", {
      name: "Ghostly Howl — Sound",
      hint: "Sound file that plays with the Ghostly Howl wave (a feature that emanates a 30-ft spectral wave). Paste a file path (e.g. modules/ace-qol/Assets/Sounds/ghostly-howl.ogg) or a Sequencer sound key. Leave blank for silent.",
      scope: "world", config: false, type: String, default: "",
      filePicker: "audio",
    });

    // ── Opportunity Attack Prompt (PHB 195) ─────────────────────────────
    s("opportunityAttackPrompt", {
      name: "Opportunity Attack Prompt",
      hint: "When a hostile creature moves out of an actor's reach, prompt the GM to take an OA on the actor's behalf.",
      scope: "world", config: false, type: Boolean, default: true,
    });
    s("opportunityAttackReach", {
      name: "Opportunity Attack — Default Reach (ft)",
      hint: "Default reach distance for OA detection. Most actors use 5 feet; reach weapons (10 feet) handled per-weapon as a future enhancement.",
      scope: "world", config: false, type: Number, default: 5,
      range: { min: 5, max: 30, step: 5 },
    });

    // ── Resource-prompt routing (Divine Smite, Bardic, Lucky, etc.) ─────
    s("riderPromptsFollowRoller", {
      name: "Resource Prompts Follow the Roller",
      hint: "When ON (default), follow-up resource prompts — Divine Smite, Eldritch Smite, Bardic Inspiration, Lucky, and similar — appear on the screen of whoever ROLLED the attack. So when the GM rolls on behalf of a player's character, the GM gets the smite prompt instead of it appearing unnoticed on the player's screen. When OFF, prompts always go to the character's owning player even when the GM rolled — for tables where the player should decide whether to spend their own resources.",
      scope: "world", config: false, type: Boolean, default: true,
    });

    // ── Loadout / hands enforcement ──────────────────────────────────────
    s("enforceLoadout", {
      name: "Enforce Weapon Loadout (Hands)",
      hint: "When ON (default), a player character can't equip more than their hands can hold — two one-handed weapons, OR one two-handed weapon, OR a one-handed weapon + shield. Two non-Light one-handed weapons require the Dual Wielder feat. Natural weapons and unarmed strikes use no hands. Set the flag a setting on the creature on a creature to raise its hand budget (a marilith has six arms). NPCs are not enforced — their stat blocks are GM-managed. When OFF, the dnd5e equip checkbox behaves normally (equip anything).",
      scope: "world", config: false, type: Boolean, default: true,
    });

    // ── Block un-equipped weapon swing ───────────────────────────────────
    s("blockUnequippedAttack", {
      name: "Block Un-Equipped Weapon Attacks",
      hint: "When ON (default), a player character can't attack with a weapon that isn't marked equipped IF they already have another weapon in hand (e.g. swinging a sheathed halberd while a greataxe is equipped) — the swing is cancelled before it rolls, with a note to equip it first. Fails open: if NOTHING is marked equipped we can't tell what's in hand, so the attack is allowed. Relies on the equipped checkbox being accurate — if a truly-wielded weapon reads 'not equipped' it'll be blocked, so keep your main weapon ticked, or turn this OFF. NPCs are never blocked (their stat blocks are GM-managed).",
      scope: "world", config: false, type: Boolean, default: true,
    });

    // ── Initiative Tools ────────────────────────────────────────────────
    s("showInitiativeButtons", {
      name: "Show Initiative Buttons in Combat Tracker",
      hint: "Render Roll-All-NPCs / Roll-All-PCs buttons at the top of the combat tracker.",
      scope: "world", config: false, type: Boolean, default: true,
    });
    s("pcInitiativeAutoRoll", {
      name: "Auto-Roll PC Initiative",
      hint: "When ON, the Roll-All-PCs button rolls server-side. When OFF (default), it whispers each player a roll prompt — most tables prefer players rolling themselves.",
      scope: "world", config: false, type: Boolean, default: false,
    });

    s("excludeCasterFromTemplates", {
      name: "Exclude Caster From Auto-Targeted AOE Saves",
      hint: "When the caster is standing inside their own AOE template (Lightning Bolt line origin, Fireball self-cast, etc.), Foundry/dnd5e auto-targets them. By default ace-qol filters the caster OUT of the save target list. Turn this OFF if you actually want the caster to roll their own save (Evasion + half damage builds, etc.).",
      scope: "world", config: false, type: Boolean, default: true,
    });

    s("auraEngineEnabled", {
      name: "Aura Engine — Auto-Apply / Auto-Remove",
      hint: "Self-maintaining replacement for the (broken in dnd5e 5.x) ActiveAuras module. Watches token movement and dynamically applies/removes paladin aura marker effects on tokens within range. Catalog includes Aura of Protection / Warding / Courage / Hate / The Guardian and is easy to extend.",
      scope: "world", config: false, type: Boolean, default: true,
    });

    s("auraVisualMode", {
      name: "Aura Visual Style",
      hint: "How to render aura range circles. RINGS = always show our reliable PIXI rings around source tokens. AUTO = defer to Automated Animations when it's active (less reliable — AA may only render on some tokens). OFF (default) = no ace-qol rings (rely on AA or nothing).",
      scope: "world", config: false, type: String, default: "off",
      choices: { off: "Off (default — no ace-qol rings)", rings: "PIXI rings (reliable)", auto: "Auto (defer to AA when active)" },
    });

    s("spellAutoDamageEnabled", {
      name: "Spell Auto-Damage Pipeline (Magic Missile, Fire Bolt, etc.)",
      hint: "When ON (default), ace-qol intercepts auto-hit damage spells (Magic Missile, Fire Bolt, etc.) and posts our unified ROLL DAMAGE card with per-target apply/undo + resistance/immunity gates. dnd5e's native damage popup is suppressed via prototype patch. Set to OFF for a clean fallback to vanilla dnd5e flow if our pipeline misbehaves.",
      scope: "world", config: false, type: Boolean, default: true,
    });

    s("magicMissilePerDartRoll", {
      name: "Magic Missile — Roll each dart separately",
      hint: "RAW: each missile rolls 1d4+1 independently — more variance, slightly more table time. When OFF (default), darts assigned to the same target combine into a single multi-die roll (Nd4+N) — mathematically equivalent expected value with less variance and faster play. Per-dart rolling is the strict RAW interpretation; combined rolling is the popular table shortcut. Either way, the picker UI for distributing darts works identically.",
      scope: "world", config: false, type: Boolean, default: false,
    });

    s("radiantSoulRiderEnabled", {
      name: "Radiant Soul Rider (Celestial Warlock 6+)",
      hint: "When ON (default), automatically adds CHA modifier to fire/radiant damage from spells and cantrips, once per turn. Triggers on Divine Smite (it's a spell in 2024 PHB), Sacred Flame, Spirit Shroud's radiant variant, Holy Weapon, Crusader's Mantle, etc. RAW: Celestial Warlock 6th-level feature. Set to OFF if your table runs the rider manually.",
      scope: "world", config: false, type: Boolean, default: true,
    });

    s("empoweredEvocationEnabled", {
      name: "Empowered Evocation Rider (Wizard Evocation School 10+)",
      hint: "When ON (default), automatically adds INT modifier to damage rolls of evocation-school wizard spells. RAW: 'you can add your Intelligence modifier to one damage roll of any wizard evocation spell you cast.' Detection: actor has the 'Empowered Evocation' feature AND the spell's school is 'evo'. Set to OFF if your table runs the rider manually.",
      scope: "world", config: false, type: Boolean, default: true,
    });

    s("agonizingBlastEnabled", {
      name: "Agonizing Blast Rider (Warlock invocation)",
      hint: "When ON (default), automatically adds CHA modifier to each beam of Eldritch Blast. RAW: 'When you cast eldritch blast, add your Charisma modifier to the damage it deals on a hit.' Detection: actor has the 'Agonizing Blast' invocation AND the spell name matches 'Eldritch Blast'. CHA mod added per damage component (per beam) so higher-level multi-beam casts scale correctly. Set to OFF if your table runs the rider manually.",
      scope: "world", config: false, type: Boolean, default: true,
    });

    s("potentSpellcastingEnabled", {
      name: "Potent Spellcasting Rider (Cleric / Druid 8+)",
      hint: "When ON (default), automatically adds WIS modifier to damage from cantrips. RAW: 'When you cast a cleric cantrip [or druid cantrip] that deals damage, you can add your Wisdom modifier to the damage.' Detection: actor has 'Potent Spellcasting' feature AND the spell is level 0 (cantrip). Applied once per cantrip cast. Set to OFF if your table runs the rider manually.",
      scope: "world", config: false, type: Boolean, default: true,
    });

    s("descriptionOnKillRiderEnabled", {
      name: "On-Kill Description Riders (temp HP / self-heal on kill)",
      hint: "When ON (default), parses item descriptions for on-kill rewards like 'Reducing a target to zero hitpoints grants 2d6 temporary hitpoints' (Blood Halberd) or 'When you reduce a creature to 0 HP you regain Xd6 hit points' (life-leech weapons). Auto-rolls and applies to the attacker after each kill. Temp HP uses Math.max per RAW (doesn't stack). Set to OFF to handle these manually.",
      scope: "world", config: false, type: Boolean, default: true,
    });

    s("multiTargetMeleeFeatureIds", {
      name: "Multi-Target Melee Feature Allow-List (advanced)",
      hint: "Array of feature identifiers, item names, or UUIDs that authorize an actor to make a single melee swing against multiple targets (Cleave, Whirlwind, Great Weapon Master, etc.). Default detection uses dnd5e weapon-mastery 'cleave' property + standard identifiers (great-weapon-master, cleaving-attack, whirlwind-attack, improved-whirlwind-attack). Add homebrew or translated content here. Setting is consumed by AttackPipeline._actorHasMultiTargetMelee.",
      scope: "world", config: false, type: Array, default: [],
    });

    // NOTE: dsnRevealDelayMs is registered ONCE, further below (default 3000,
    // with a 0–6000ms range slider). A duplicate registration that lived here
    // (default 1500) was removed 2026-06-17 — Foundry's last-registration-wins
    // meant the 1500 default was always silently overwritten by the later one,
    // so removing it changes nothing at runtime and kills the confusion.

    s("saveCardDelayAfterCastMs", {
      name: "Save Card Delay After Cast (ms)",
      hint: "Pause (in milliseconds) between the cast/template landing and the save card appearing in chat. Default 1500ms lets the spell animation play first so the save card doesn't pre-empt the dramatic beat. Set to 0 to post the save card immediately. Setting is consumed by SaveEngine._postLiveTargetCard and SaveEngine._fastResolveSingleNpcSave.",
      scope: "world", config: false, type: Number, default: 1500,
    });

    s("debugFlankLogging", {
      name: "Debug — Flanking Resolution Logs",
      hint: "Log detailed flanking-detection diagnostics to console (per-target, per-ally distance/disposition/reach checks). EXTREMELY verbose — typically 15-25 lines per attack roll. Off by default even when general Debug Mode is on. Turn on only when troubleshooting why a token does or doesn't get the flanking bonus.",
      scope: "client", config: false, type: Boolean, default: false,
    });

    // v0.6.1: removed `showConcentrationWidget` — duplicated the existing
    // `concentrationWidget` setting in the Saves tab. Widget code now reads
    // the existing setting directly.

    s("batchResultsCard", {
      name:    "Batch Combat Results Card",
      hint:    "Show all targets in one consolidated damage card instead of individual cards per target.",
      scope:   "world",
      config:  false,
      type:    Boolean,
      default: true,
    });

    s("targetStateAssessment", {
      name:    "Full Target State Assessment",
      hint:    "Assess every condition, buff, resistance, creature type, and modifier on every target before damage.",
      scope:   "world",
      config:  false,
      type:    Boolean,
      default: true,
    });

    s("autoRollNpcSaves", {
      name:    "Auto-Roll NPC Saves",
      hint:    "When a save card targets NPCs, roll their saves automatically — no GM button click. Player-character targets still get their own whispered prompt to roll. Default: ON.",
      scope:   "world",
      config:  false,
      type:    Boolean,
      default: true,
    });

    s("pactBladePromptPerAttack", {
      name:    "Pact of the Blade — Ask Damage Type Each Hit",
      hint:    "For a Pact of the Blade weapon, pop a quick chooser (Normal / Necrotic / Psychic / Radiant) each time it deals damage, so you can change the type per swing. OFF = use the sticky choice from the Warlock Damage Type chooser instead (no popup). Only ever appears for a pact-weapon wielder. Default: ON.",
      scope:   "world",
      config:  false,   // surfaced via the ACE config panel (Attacks tab), not native settings
      type:    Boolean,
      default: true,
    });

    s("dualWielderGrantsOffhandMod", {
      name:    "Dual Wielder Grants Off-Hand Damage Mod (House Rule)",
      hint:    "STRICT RAW when OFF (default): the Dual Wielder feat does NOT add your ability modifier to an off-hand attack's damage — in either 2014 or 2024. That bonus comes ONLY from the Two-Weapon Fighting fighting style. Turn this ON to house-rule it: any character with the Dual Wielder feat also adds their ability modifier to off-hand damage, as if they had the fighting style (a very common table variant). Characters who actually have the Two-Weapon Fighting style always get the mod regardless of this setting. Default: OFF (RAW).",
      scope:   "world",
      config:  false,   // surfaced via the ACE config panel (Attacks tab), not native settings
      type:    Boolean,
      default: false,
    });

    s("slayerAutoDetect", {
      name:    "Slayer Weapon Auto-Detect",
      hint:    "Automatically detect Slayer weapons (Giant Slayer, Dragon Slayer) and apply bonus damage vs matching creature types.",
      scope:   "world",
      config:  false,
      type:    Boolean,
      default: true,
    });

    s("flanking", {
      name:    "Flanking (Optional Rule)",
      hint:    "Melee attackers get advantage when an ally is on the opposite side of the target. Uses the line-through method — a line from attacker through target must reach an ally.",
      scope:   "world",
      config:  false,
      type:    Boolean,
      default: false,
    });

    s("autoApplyConditions", {
      name:    "Auto-Apply Conditions",
      hint:    "Automatically apply conditions (prone, grappled, restrained, etc.) to targets when they fail saves. When OFF, conditions show in the results card but must be applied manually.",
      scope:   "world",
      config:  false,
      type:    Boolean,
      default: false,
    });

    s("autoRollDamage", {
      name:    "Auto-Roll Damage on Hit",
      hint:    "Automatically roll damage when an attack hits, instead of showing a ROLL DAMAGE button. Fastest combat flow — one click and damage appears.",
      scope:   "world",
      config:  false,
      type:    Boolean,
      default: false,
    });

    s("autoApplyDamage", {
      name:    "Auto-Apply Damage to HP",
      hint:    "Automatically apply rolled damage to target HP without waiting for the GM to click APPLY. The UNDO button remains available on the card. ⚠️ Full automation — damage is applied instantly.",
      scope:   "world",
      config:  false,
      type:    Boolean,
      default: false,
    });

    // ═══════════════════════════════════════════════════════════════════════════
    //  REACTION AUTOMATION
    // ═══════════════════════════════════════════════════════════════════════════

    s("enableReactions", {
      name:    "Enable Reaction Automation",
      hint:    "Master toggle for all automated reaction prompts (Shield, Counterspell, Absorb Elements, Legendary Resistance, Silvery Barbs, Cutting Words).",
      scope:   "world",
      config:  false,
      type:    Boolean,
      default: true,
    });

    s("reactionTimeout", {
      name:    "Reaction Prompt Timeout (seconds)",
      hint:    "How long players have to respond to a reaction prompt before it auto-declines. Default: 10 seconds.",
      scope:   "world",
      config:  false,
      type:    Number,
      default: 10,
      range:   { min: 5, max: 30, step: 1 },
    });

    s("autoShield", {
      name:    "Auto-Prompt Shield Spell",
      hint:    "When an attack hits a target that has Shield prepared and a spell slot, prompt them to cast it.",
      scope:   "world",
      config:  false,
      type:    Boolean,
      default: false,
    });

    s("autoCounterspell", {
      name:    "Auto-Prompt Counterspell",
      hint:    "When a creature casts a spell, prompt eligible opponents within 60 feet to Counterspell.",
      scope:   "world",
      config:  false,
      type:    Boolean,
      default: false,
    });

    s("skipOfflineCounterspell", {
      name:    "Skip Counterspell for Offline Players",
      hint:    "When ON (default), the Counterspell pop-up is NOT raised for a character whose player owner isn't logged in — an offline player can't answer it anyway, so no dead prompt. NPC counterspellers (GM-owned) are always offered to the GM. Turn OFF to prompt every eligible reactor regardless of who's connected.",
      scope:   "world",
      config:  false,
      type:    Boolean,
      default: true,
    });

    s("counterspellAnyCaster", {
      name:    "Counterspell Any Caster (RAW)",
      hint:    "RAW, Counterspell interrupts ANY creature you can see casting within 60 feet — ally OR enemy. By DEFAULT (OFF) ACE only offers it against an ENEMY caster, so your counterspeller isn't pestered every time a teammate casts a spell. Turn ON for strict RAW: the pop-up also offers on same-side casts (e.g. countering a dominated ally).",
      scope:   "world",
      config:  false,
      type:    Boolean,
      default: false,
    });

    s("autoBreakInvisibility", {
      name:    "Auto-Break Invisibility on Attack / Spell-Cast (RAW)",
      hint:    "When a creature with the Invisibility spell active makes an attack or casts a spell, automatically end the spell and make them visible (RAW 2014 + 2024). Greater Invisibility persists (intentional — that's the point of the spell). Natural invisibility from monster traits (Will-o'-Wisp, Invisible Stalker) is not touched.",
      scope:   "world",
      config:  false,
      type:    Boolean,
      default: true,
    });

    s("autoAbsorbElements", {
      name:    "Auto-Prompt Absorb Elements",
      hint:    "When a creature takes elemental damage (acid/cold/fire/lightning/thunder), prompt for Absorb Elements.",
      scope:   "world",
      config:  false,
      type:    Boolean,
      default: false,
    });

    s("autoLegendaryResistance", {
      name:    "Auto-Prompt Legendary Resistance",
      hint:    "When an NPC fails a save and has Legendary Resistance uses, prompt the GM to use one.",
      scope:   "world",
      config:  false,
      type:    Boolean,
      default: false,
    });

    // ═══════════════════════════════════════════════════════════════════════════
    //  SPEED ROLLS — one-click attacks from character sheet
    // ═══════════════════════════════════════════════════════════════════════════

    s("enableSpeedRolls", {
      name:    "Speed Item Rolls",
      hint:    "Click a weapon/spell on the character sheet to immediately roll the attack with no dialog. Ctrl+click to show the normal dialog. Alt+click for advantage.",
      scope:   "world",
      config:  false,
      type:    Boolean,
      default: true,
    });

    s("speedRollBehavior", {
      name:    "Speed Roll Behavior",
      hint:    "What happens when you click an item on the character sheet. Fast Forward: rolls immediately, no dialog. Dialog: always shows the roll dialog. Disabled: normal Foundry behavior.",
      scope:   "world",
      config:  false,
      type:    String,
      default: "fastForward",
      choices: {
        fastForward: "Fast Forward — roll immediately, no dialog",
        dialog:      "Dialog — always show the roll configuration dialog",
        disabled:    "Disabled — use default Foundry behavior",
      },
    });

    s("speedRollAdvantageKey", {
      name:    "Speed Roll Advantage Key",
      hint:    "Which modifier key grants advantage on speed rolls. Alt: Alt+click = advantage, Ctrl+Alt = disadvantage. Shift: Shift+click = advantage, Ctrl+Shift = disadvantage.",
      scope:   "world",
      config:  false,
      type:    String,
      default: "alt",
      choices: {
        alt:   "Alt — Alt+click = advantage, Ctrl+Alt = disadvantage",
        shift: "Shift — Shift+click = advantage, Ctrl+Shift = disadvantage",
      },
    });

    // ═══════════════════════════════════════════════════════════════════════════
    //  MERGE CARD — combined attack + damage display
    // ═══════════════════════════════════════════════════════════════════════════

    s("enableMergeCard", {
      name:    "Merge Attack + Damage Cards",
      hint:    "Combine the attack and damage results into a single chat card instead of separate messages. Opt-in — disabled by default.",
      scope:   "world",
      config:  false,
      type:    Boolean,
      default: false,
    });

    // ═════════════════════════════════════════════════════════════════════
    //  HEAL PIPELINE — custom heal flow (HealActivity interception)
    // ═════════════════════════════════════════════════════════════════════
    s("enableHealPipeline", {
      name:    "Custom Heal Pipeline",
      hint:    "Replaces the vanilla dnd5e heal usage card with a custom card: target picker popup (range-aware), one-click apply per target, temp HP support. Disable to fall back to vanilla dnd5e heal flow.",
      scope:   "world",
      config:  false,
      type:    Boolean,
      default: true,
    });

    s("mergeCardStyle", {
      name:    "Merge Card Style",
      hint:    "Detailed: shows full dice formulas and type breakdowns. Compact: minimal display with just totals.",
      scope:   "world",
      config:  false,
      type:    String,
      default: "detailed",
      choices: {
        detailed: "Detailed — full dice formulas and type breakdowns",
        compact:  "Compact — minimal display with totals only",
      },
    });

    s("showAttackFormula", {
      name:    "Show Attack Roll Formula (Merge Card)",
      hint:    "Display the attack roll breakdown (d20 + ability + proficiency + magic) in merge cards.",
      scope:   "world",
      config:  false,
      type:    Boolean,
      default: true,
    });

    s("showDamageFormula", {
      name:    "Show Damage Roll Formula (Merge Card)",
      hint:    "Display the damage dice breakdown (individual die results + modifiers) in merge cards.",
      scope:   "world",
      config:  false,
      type:    Boolean,
      default: true,
    });

    // ═══════════════════════════════════════════════════════════════════════════
    //  CRITICAL HIT RULES
    // ═══════════════════════════════════════════════════════════════════════════

    s("critRule", {
      name:    "Critical Hit Damage Rule",
      hint:    "How critical hits calculate bonus damage. RAW Double Dice: roll all dice twice (2d8 becomes 4d8). Max + Roll: take max value of normal dice + roll crit dice (guarantees strong crits). Max All: max value of ALL dice (most generous, brutal crits).",
      scope:   "world",
      config:  false,
      type:    String,
      default: "maxPlusRoll",
      choices: {
        doubleDice:   "RAW Double Dice — roll twice as many dice (e.g., 2d8 → 4d8)",
        maxPlusRoll:  "Max + Roll — normal dice maxed + roll bonus crit dice (e.g., 8 + 1d8)",
        maxAll:       "Max All Dice — all dice maxed (most generous, e.g., 8 + 8 = 16)",
      },
    });

    // ═══════════════════════════════════════════════════════════════════════════
    //  EXTENDED ACTIVE EFFECTS (replaces DAE)
    // ═══════════════════════════════════════════════════════════════════════════

    s("extendedEffects", {
      name:    "Extended Active Effects",
      hint:    "Enable extended effect keys, formula evaluation, and macros on apply/remove (replaces DAE).",
      scope:   "world",
      config:  false,
      type:    Boolean,
      default: true,
    });

    s("effectTransferRules", {
      name:    "Effect Transfer Rules",
      hint:    "Control when item effects transfer to actors (equip, attune, always). Extends vanilla Foundry behavior.",
      scope:   "world",
      config:  false,
      type:    Boolean,
      default: false,
    });

    // ═══════════════════════════════════════════════════════════════════════════
    //  HOOK API & OVERTIME EFFECTS
    // ═══════════════════════════════════════════════════════════════════════════

    s("enableOnUseHooks", {
      name:    "Enable OnUse Hook API",
      hint:    "Fire ace-qol.* hooks at every phase of the combat workflow. Allows third-party modules and macros to extend behavior (damage bonuses, custom conditions, etc.).",
      scope:   "world",
      config:  false,
      type:    Boolean,
      default: true,
    });

    s("enableOverTimeEffects", {
      name:    "Enable OverTime Effects",
      hint:    "Process recurring Active Effects (damage, saves) at the start/end of a creature's combat turn. Reads flags.ace-qol.OverTime and flags.midi-qol.OverTime.",
      scope:   "world",
      config:  false,
      type:    Boolean,
      default: true,
    });

    s("autoApplyOverTimeDamage", {
      name:    "Auto-Apply OverTime Damage",
      hint:    "When ON, OverTime damage is applied to HP automatically. When OFF, the GM must click APPLY on the chat card.",
      scope:   "world",
      config:  false,
      type:    Boolean,
      default: false,
    });

    s("autoApplyOverTimeHeal", {
      name:    "Auto-Apply Regeneration / Healing",
      hint:    "When ON, recurring healing (Regeneration on trolls, vampires, etc.) is applied automatically at the start of the creature's turn — the GM never has to remember it. When OFF, a chat card with an APPLY button is posted instead.",
      scope:   "world",
      config:  false,
      type:    Boolean,
      default: false,
    });

    // ═══════════════════════════════════════════════════════════════════════════
    //  FLAGS ENGINE + OPTIONAL PROMPTS
    // ═══════════════════════════════════════════════════════════════════════════

    s("enableFlagsSystem", {
      name:    "Flags System",
      hint:    "Enable the general-purpose flags system. Active Effects can set flags under flags.ace-qol.* to control advantage, disadvantage, auto-crit, save modifiers, damage bonuses, and more.",
      scope:   "world",
      config:  false,
      type:    Boolean,
      default: true,
    });

    s("enableOptionalPrompts", {
      name:    "Optional Bonus Prompts",
      hint:    "When a roll happens and the actor has optional modifiers available (Bardic Inspiration, Lucky, Guided Strike, Precision Attack, etc.), show a prompt to the player.",
      scope:   "world",
      config:  false,
      type:    Boolean,
      default: true,
    });

    s("optionalPromptTimeout", {
      name:    "Optional Prompt Timeout (seconds)",
      hint:    "How many seconds the optional bonus prompt stays open before auto-declining. 0 = no timeout.",
      scope:   "world",
      config:  false,
      type:    Number,
      default: 8,
      range:   { min: 0, max: 30, step: 1 },
    });

    s("midiCompatibility", {
      name:    "Midi-QOL Flag Compatibility",
      hint:    "Also read flags.midi-qol.* on actors for backward compatibility with existing items that have Midi-QOL flags set. Disable if you have fully migrated to ace-qol flags.",
      scope:   "world",
      config:  false,
      type:    Boolean,
      default: true,
    });

    // ═══════════════════════════════════════════════════════════════════════════
    //  CONDITION LIBRARY & DURATION TRACKER
    // ═══════════════════════════════════════════════════════════════════════════

    s("enableDurationTracker", {
      name:    "Effect Duration Tracker",
      hint:    "Automatically track and expire Active Effects when their duration runs out (replaces Times Up module).",
      scope:   "world",
      config:  false,
      type:    Boolean,
      default: true,
    });

    s("expireEffectsOnTurnChange", {
      name:    "Expire Effects on Turn Change",
      hint:    "Automatically check for and remove expired effects when combat turns/rounds advance.",
      scope:   "world",
      config:  false,
      type:    Boolean,
      default: false,
    });

    s("notifyOnExpiry", {
      name:    "Notify on Effect Expiry",
      hint:    "Post a chat notification when an effect expires during combat.",
      scope:   "world",
      config:  false,
      type:    Boolean,
      default: true,
    });

    s("expiryNotifyAll", {
      name:    "Expiry Notifications Visible to All",
      hint:    "When ON, effect expiry notifications are visible to all players. When OFF, they are whispered to GM only.",
      scope:   "world",
      config:  false,
      type:    Boolean,
      default: false,
    });

    s("combatWindDownEnabled", {
      name:    "Combat Wind-Down — Expire Short Buffs After Combat",
      hint:    "When combat ends, automatically expire any effect with a short remaining duration (Bless, Bane, Haste, Faerie Fire, etc.). Long-duration effects (Mage Armor 8h, Stoneskin 1h) are NOT touched — they survive combat naturally. Threshold controls how short counts as 'short'.",
      scope:   "world",
      config:  false,
      type:    Boolean,
      default: true,
    });

    s("combatWindDownThresholdMin", {
      name:    "Combat Wind-Down Threshold (minutes)",
      hint:    "Any effect with this much remaining duration or less is auto-expired when combat ends. Default: 10 minutes — catches all 1-minute combat buffs and short concentration spells. Set higher to also drop 1-hour buffs (Stoneskin, Spirit Shroud) at combat's end.",
      scope:   "world",
      config:  false,
      type:    Number,
      default: 10,
      range:   { min: 1, max: 480, step: 1 },
    });

    // ═══════════════════════════════════════════════════════════════════════════
    //  COVER CALCULATION
    // ═══════════════════════════════════════════════════════════════════════════

    s("enableCoverCalculation", {
      name:    "Auto-Calculate Cover",
      hint:    "Automatically calculate cover between attacker and target using wall/obstacle ray casting. Adds AC bonus to target before hit determination.",
      scope:   "world",
      config:  false,
      type:    Boolean,
      default: true,
    });

    s("coverCalculationMethod", {
      name:    "Cover Calculation Method",
      hint:    "How cover is calculated. Corners: casts 16 rays from attacker corners to target corners (DMG variant, more accurate). Center: single ray from center to center (simpler, faster).",
      scope:   "world",
      config:  false,
      type:    String,
      default: "corners",
      choices: {
        corners: "Corner-to-Corner (16 rays, DMG variant)",
        center:  "Center-to-Center (1 ray, simplified)",
      },
    });

    s("creatureAsCover", {
      name:    "Creatures Provide Cover (Optional Rule)",
      hint:    "Other creatures in the line of attack provide half cover (+2 AC) to the target. PHB optional rule.",
      scope:   "world",
      config:  false,
      type:    Boolean,
      default: false,
    });

    s("showCoverIndicator", {
      name:    "Show Cover Indicator",
      hint:    "Display a scrolling text indicator on the target showing the cover level when an attack is made.",
      scope:   "world",
      config:  false,
      type:    Boolean,
      default: true,
    });

    s("ignoreCoverForAdjacent", {
      name:    "Ignore Cover for Adjacent Targets",
      hint:    "Targets within 5 feet of the attacker ignore cover (they are too close for obstacles to matter).",
      scope:   "world",
      config:  false,
      type:    Boolean,
      default: true,
    });

    // ═══════════════════════════════════════════════════════════════════════════
    //  BLOODIED & DEATH INDICATORS
    // ═══════════════════════════════════════════════════════════════════════════

    s("enableBloodied", {
      name:    "Bloodied Indicator",
      hint:    "Show a visual indicator when a token drops to half HP or below.",
      scope:   "world",
      config:  false,
      type:    Boolean,
      default: true,
    });

    s("bloodiedThreshold", {
      name:    "Bloodied Threshold",
      hint:    "Percentage of max HP at or below which a creature is considered bloodied. Default 0.5 = half HP.",
      scope:   "world",
      config:  false,
      type:    Number,
      default: 0.5,
      range:   { min: 0.1, max: 0.9, step: 0.05 },
    });

    s("bloodiedIndicatorStyle", {
      name:    "Bloodied Indicator Style",
      hint:    "Visual style for the bloodied indicator on tokens.",
      scope:   "world",
      config:  false,
      type:    String,
      default: "border",
      choices: {
        border:  "Red Border Ring (default, most visible)",
        overlay: "Blood Splatter Overlay Icon",
        tint:    "Red Tint on Token Image",
      },
    });

    s("announceBloodied", {
      name:    "Announce Bloodied in Chat",
      hint:    "Post a chat message when a creature becomes bloodied.",
      scope:   "world",
      config:  false,
      type:    Boolean,
      default: true,
    });

    s("bloodiedVisibleTo", {
      name:    "Bloodied Visible To",
      hint:    "Who can see the bloodied indicator on tokens and in chat.",
      scope:   "world",
      config:  false,
      type:    String,
      default: "gm",
      choices: {
        gm:  "GM Only",
        all: "All Players",
      },
    });

    s("enableDeadMarker", {
      name:    "Auto Dead Marker",
      hint:    "Automatically apply the dead status effect (skull overlay) when a creature drops to 0 HP.",
      scope:   "world",
      config:  false,
      type:    Boolean,
      default: true,
    });

    s("notifyDeadArtFallback", {
      name:    "Notify When Dead-Art Falls Back",
      hint:    "Whisper a chat notice to the GM when the death pipeline can't find a matching corpse image for a creature type and uses the token image (or skull icon) as a fallback. Off by default — the tile is still created normally; this notice exists only to help you discover which Assets/Dead/dead-<type>.png files are still missing.",
      scope:   "world",
      config:  false,
      type:    Boolean,
      default: false,
    });

    // ═══════════════════════════════════════════════════════════════════════════
    //  ROLL VISIBILITY CONTROLS
    // ═══════════════════════════════════════════════════════════════════════════

    s("npcAttackVisibility", {
      name:    "NPC Attack Roll Visibility",
      hint:    "What players see when NPCs make attack rolls. Public: full details. Result Only: Hit/Miss but not the number. GM Only: players see nothing.",
      scope:   "world",
      config:  false,
      type:    String,
      default: "public",
      choices: {
        public:     "Public — players see full roll details",
        resultOnly: "Result Only — players see Hit/Miss, not the roll",
        gmOnly:     "GM Only — hidden from players entirely",
      },
    });

    s("npcDamageVisibility", {
      name:    "NPC Damage Roll Visibility",
      hint:    "What players see when NPCs deal damage. Public: full details. Result Only: damage type but not the number. GM Only: hidden.",
      scope:   "world",
      config:  false,
      type:    String,
      default: "public",
      choices: {
        public:     "Public — players see full damage details",
        resultOnly: "Result Only — players see type labels, not totals",
        gmOnly:     "GM Only — hidden from players entirely",
      },
    });

    s("npcSaveVisibility", {
      name:    "NPC Save Roll Visibility",
      hint:    "What players see when NPCs make saving throws.",
      scope:   "world",
      config:  false,
      type:    String,
      default: "public",
      choices: {
        public:     "Public — players see full save details",
        resultOnly: "Result Only — players see Pass/Fail, not the roll",
        gmOnly:     "GM Only — hidden from players entirely",
      },
    });

    s("hideSaveDC", {
      name:    "Hide Save DC from Players",
      hint:    "Replace save DCs with 'DC ???' in chat messages visible to players. Prevents metagaming save difficulty.",
      scope:   "world",
      config:  false,
      type:    Boolean,
      default: false,
    });

    s("hideNPCNames", {
      name:    "Hide NPC Names in Rolls",
      hint:    "Replace NPC names with '???' in attack/damage/save cards. Prevents players from identifying unknown creatures.",
      scope:   "world",
      config:  false,
      type:    Boolean,
      default: false,
    });

    s("playersSeeBloodied", {
      name:    "Players See Bloodied Indicators",
      hint:    "Whether players can see bloodied visual indicators on NPC tokens. Independent of the Bloodied Visible To setting for chat announcements.",
      scope:   "world",
      config:  false,
      type:    Boolean,
      default: true,
    });

    s("npcSaveAnimationDelay", {
      name:    "NPC Save Dice Pacing — Single Target (ms)",
      hint:    "How long the engine waits while a SINGLE NPC's save d20 is animating before showing the result. Higher = more dramatic. Set to 0 to skip waiting entirely (result appears instantly while dice roll in background). Default: 1000ms.",
      scope:   "world",
      config:  false,
      type:    Number,
      default: 1000,
      range:   { min: 0, max: 5000, step: 100 },
    });

    s("npcSaveAnimationDelayMulti", {
      name:    "NPC Save Dice Pacing — Multi-Target (ms per save)",
      hint:    "When rolling saves for MULTIPLE NPCs at once (Fireball, Mass Suggestion, etc.), how long to pause per save. Lower = faster batch resolution. Default: 250ms per save (5 targets ≈ 1.25s total).",
      scope:   "world",
      config:  false,
      type:    Number,
      default: 250,
      range:   { min: 0, max: 2000, step: 50 },
    });

    s("npcDamageAnimationDelay", {
      name:    "Spell Damage Dice Pacing (ms)",
      hint:    "How long the engine waits while spell damage dice (Fireball 8d6, Sacred Flame 1d8, etc.) are animating across the table before the merge card displays. Applies to BOTH NPC and PC casts since damage is rolled engine-side either way. Set to 0 to skip waiting entirely. Default: 1500ms.",
      scope:   "world",
      config:  false,
      type:    Number,
      default: 1500,
      range:   { min: 0, max: 8000, step: 100 },
    });

    // ═══════════════════════════════════════════════════════════════════════════
    //  DEBUG
    // ═══════════════════════════════════════════════════════════════════════════

    s("debugMode", {
      name:    "Debug Mode",
      hint:    "Log detailed combat resolution info to console.",
      scope:   "client",
      config:  false,
      type:    Boolean,
      default: false,
    });

    // The situational engine's "show me a clue" switch — surfaces WHAT the engine
    // read and concluded so gaps announce themselves instead of failing silently.
    s("situationalNarration", {
      name:    "Situational Narration",
      hint:    "Show the combat engine's reasoning as it reads the scene (e.g. 'sees through invisibility via Truesight → no disadvantage'). OFF for normal play; CONSOLE logs to F12; GM WHISPER posts it quietly to the GM only.",
      scope:   "client",
      config:  false,   // surfaced via the ACE config panel (Advanced tab), not native settings
      type:    String,
      choices: {
        off:   "Off",
        debug: "Console (F12)",
        chat:  "GM whisper",
      },
      default: "off",
    });

    s("requireTarget", {
      name:    "Require Target for Weapon Attacks",
      hint:    "Block weapon attacks when no target is selected. Shows a centered 'Please select a target' notice.",
      scope:   "world",
      config:  false,
      type:    Boolean,
      default: true,
    });

    s("advantagePrompt", {
      name:    "Advantage Prompt Before Weapon Attacks",
      hint:    "Show a centered popup with three buttons (Advantage / Normal / Disadvantage) before each weapon attack. The button ace-qol auto-detects is pre-focused; press Enter to accept it.",
      scope:   "world",
      config:  false,
      type:    Boolean,
      default: true,
    });

    // Johnny 2026-07-27: "when I reload, the chat log comes up closed. I want
    // them open by default with a setting." Foundry has no core option for
    // this — it restores whatever tab/collapse state the client last had.
    s("chatOpenOnLoad", {
      name:    "Open the Chat Log on Load",
      hint:    "After every world load, switch the sidebar to Chat and expand it if it was collapsed. Client-scoped — each person chooses for themselves.",
      scope:   "client",
      config:  true,
      type:    Boolean,
      default: true,
    });

    s("suppressSystemCards", {
      name:    "Suppress D&D 5e System Chat Cards",
      hint:    "Hide the system's item-use and attack-roll chat cards entirely. Our ace-qol attack card embeds the item description (collapsed under a chevron) so nothing is lost. Disable to fall back to the legacy collapse behavior.",
      scope:   "world",
      config:  false,
      type:    Boolean,
      default: true,
    });

    s("enableEffectsPanel", {
      name:    "Enable Effects Panel",
      hint:    "Show a floating list of the currently selected token's active effects. Left-click an effect to read its description, right-click to disable/delete (with confirmation).",
      scope:   "client",
      config:  false,
      type:    Boolean,
      default: true,
    });

    s("effectsPanelPosition", {
      name:    "Effects Panel Position",
      hint:    "Where the effects panel anchors on screen.",
      scope:   "client",
      config:  false,
      type:    String,
      choices: { "top-right": "Top Right", "top-left": "Top Left", "bottom-right": "Bottom Right", "bottom-left": "Bottom Left" },
      default: "top-right",
    });

    s("effectsPanelAction", {
      name:    "Effects Panel Right-Click Action",
      hint:    "What right-click does after the confirmation prompt: Disable (effect stays on the actor but inactive — reversible) or Delete (effect removed entirely — permanent).",
      scope:   "world",
      config:  false,
      type:    String,
      choices: { "disable": "Disable (recommended)", "delete": "Delete" },
      default: "disable",
    });

    s("effectsPanelFor", {
      name:    "Effects Panel Visibility",
      hint:    "Who sees the panel for which tokens. 'Default': GM sees panel for any token, players see only their own. 'Owned only': both GM and players see only tokens they own.",
      scope:   "world",
      config:  false,
      type:    String,
      choices: { "default": "Default (GM all, players owned)", "owned": "Owned tokens only" },
      default: "default",
    });

    s("effectsPanelShowAuras", {
      name:    "Effects Panel — Show Class Auras",
      hint:    "Detect and display class auras (Paladin Aura of Protection, Aura of Courage, etc.) computed from class levels — these are class features, not Active Effects, so they don't appear elsewhere.",
      scope:   "client",
      config:  false,
      type:    Boolean,
      default: true,
    });

    // ── Turn Marker (replaces combatbooster) ────────────────────────────
    s("enableTurnMarker", {
      name:    "Enable Turn Marker",
      hint:    "Rotating marker placed under the active combatant's token during combat.",
      scope:   "world",
      config:  false,
      type:    Boolean,
      default: true,
    });

    s("turnMarkerImage", {
      name:    "Turn Marker Image (Current)",
      hint:    "Image/webm under the active combatant. Default: JB2A orange-yellow Buff ring (loops automatically). If JB2A isn't installed, falls back to a spinning Foundry-core icon so a marker always appears.",
      scope:   "world",
      config:  false,
      type:    String,
      default: "modules/JB2A_DnD5e/Library/Generic/On_Token/Buff/Ontoken_Buff001_001_OrangeYellow_400x400.webm",
      filePicker: "imagevideo",
      onChange: (v) => _cleanAndVerifyPathSetting("turnMarkerImage", v, "current turn-marker"),
    });

    s("turnMarkerImageNext", {
      name:    "Turn Marker Image (Next)",
      hint:    "Image/webm under the next combatant. Default: JB2A blue-purple Buff ring (loops automatically). If JB2A isn't installed, falls back to a spinning Foundry-core icon so a marker always appears.",
      scope:   "world",
      config:  false,
      type:    String,
      default: "modules/JB2A_DnD5e/Library/Generic/On_Token/Buff/Ontoken_Buff001_001_BluePurple_400x400.webm",
      filePicker: "imagevideo",
      onChange: (v) => _cleanAndVerifyPathSetting("turnMarkerImageNext", v, "next turn-marker"),
    });

    s("turnMarkerNextAlpha", {
      name:    "Next-Turn Marker Opacity",
      hint:    "Opacity of the next-combatant marker. Lower = more subtle.",
      scope:   "world",
      config:  false,
      type:    Number,
      default: 0.85,
      range:   { min: 0.1, max: 1, step: 0.05 },
    });

    s("turnMarkerScale", {
      name:    "Turn Marker Size",
      hint:    "Scale multiplier relative to the active token. 1.0 = same size, 1.5 = 50% larger. Larger rings out past the token art so it's easier to see.",
      scope:   "world",
      config:  false,
      type:    Number,
      default: 1.35,
      range:   { min: 0.5, max: 2.5, step: 0.05 },
    });

    s("turnMarkerSpeed", {
      name:    "Turn Marker Rotation Speed",
      hint:    "How fast the marker spins. 0 = no rotation, 1.0 = normal, 2.0 = fast.",
      scope:   "world",
      config:  false,
      type:    Number,
      default: 0.5,
      range:   { min: 0, max: 3, step: 0.1 },
    });

    s("turnMarkerAlpha", {
      name:    "Turn Marker Opacity",
      hint:    "Base opacity of the active-turn marker (it also pulses for visibility). 1.0 = fully opaque.",
      scope:   "world",
      config:  false,
      type:    Number,
      default: 1.0,
      range:   { min: 0.1, max: 1, step: 0.05 },
    });

    s("enableNextTurnMarker", {
      name:    "Enable Next-Turn Marker",
      hint:    "Greyscale version of the marker placed under the next combatant's token (helps players prepare).",
      scope:   "world",
      config:  false,
      type:    Boolean,
      default: true,
    });

    s("enableYourTurnNotification", {
      name:    "Show 'Your Turn' Notification",
      hint:    "Display a centered popup for connected players when their turn begins.",
      scope:   "world",
      config:  false,
      type:    Boolean,
      default: true,
    });

    s("enableYourTurnSound", {
      name:    "Play 'Your Turn' Sound",
      hint:    "Play an audible alert for connected players when their turn begins.",
      scope:   "world",
      config:  false,
      type:    Boolean,
      default: true,
    });

    s("yourTurnSound", {
      name:    "Your Turn Sound File",
      hint:    "Sound played when it's a player's turn.",
      scope:   "world",
      config:  false,
      type:    String,
      default: "sounds/notify.wav",
      filePicker: "audio",
    });

    s("enableTurnMarkerAutoPan", {
      name:    "Auto-Pan Camera to Active Combatant",
      hint:    "Smoothly pan the camera to the current combatant when their turn begins.",
      scope:   "world",
      config:  false,
      type:    Boolean,
      default: false,
    });

    // ── Movement Tracker (colored squares while dragging tokens) ────────
    // ⚠️ DEFAULT OFF, AND IT WAS NEVER REALLY "ON" BEFORE (2026-08-19).
    // This shipped defaulting to true, but the drag patch that draws it was
    // registered from a dead ready hook and had never once executed. So the
    // feature has never been seen by anybody, and "default on" was a decision
    // nobody made - it was just an untested value on code that never ran.
    // Repairing that hook in the same session would have switched an unknown
    // overlay on across every table without a word. Reviving dead code is a
    // behaviour change, and it gets the same scrutiny as a new feature.
    s("enableMovementTracker", {
      name:    "Enable Movement Tracker",
      hint:    "Show colored grid squares while dragging a token: green = within walk speed, yellow = within Dash (2x walk), red = beyond Dash. Off by default - turn it on if you want the overlay.",
      scope:   "world",
      config:  false,
      type:    Boolean,
      default: false,
    });

    s("movementTrackerOnlyInCombat", {
      name:    "Movement Tracker — Only in Combat",
      hint:    "When on, the colored squares only appear during combat. Off = always visible while dragging.",
      scope:   "world",
      config:  false,
      type:    Boolean,
      default: true,
    });

    s("movementTrackerAlpha", {
      name:    "Movement Tracker Opacity",
      hint:    "How visible the colored squares are. 1.0 = solid color, 0.2 = very subtle.",
      scope:   "world",
      config:  false,
      type:    Number,
      default: 0.35,
      range:   { min: 0.1, max: 0.8, step: 0.05 },
    });

    s("flankingAllowReachWeapons", {
      name:    "Flanking — Allow Reach Weapons (Houserule)",
      hint:    "When ON, an ally with an equipped reach weapon (Glaive, Halberd, Pike, Whip, Lance, etc.) can grant flanking from 10 feet. RAW only allows flanking at 5 feet (adjacent).",
      scope:   "world",
      config:  false,
      type:    Boolean,
      default: false,
    });

    s("autoPostLootCard", {
      name:    "Auto-Post Loot Card on Death",
      hint:    "When ON (default), a public chat card listing the dead NPC's loot is posted automatically — items are draggable to PC sheets. Disable to suppress the chat card and rely solely on the tile loot dialog (single-click the dead-art tile).",
      scope:   "world",
      config:  false,
      type:    Boolean,
      default: true,
    });

    s("lootHoverIconDelayMs", {
      name:    "Loot Hover-Icon Delay (ms)",
      hint:    "How long to hover over a corpse / container tile before the gold coin-sack icon fades in. Set to 0 to disable the hover icon entirely. Default: 200ms (0.2 seconds — snappy).",
      scope:   "client",
      config:  false,
      type:    Number,
      default: 200,
      range:   { min: 0, max: 5000, step: 50 },
    });

    s("lootMaxDistanceFt", {
      name:    "Max Loot Distance (ft)",
      hint:    "How close a player's character has to be to a corpse or container to open the loot dialog. Doesn't apply to the GM — GMs can loot from anywhere. Set to 0 to disable the distance gate entirely. Default: 10 feet (one move action's reach for an adjacent body / right next to a chest).",
      scope:   "world",
      config:  false,
      type:    Number,
      default: 10,
      range:   { min: 0, max: 200, step: 5 },
    });

    s("lootClickDebug", {
      name:    "Loot Click Debug Logging",
      hint:    "When ON, every left-click logs the lootable-tile detection result to console (world pos, layer, tile found?). Use this to diagnose click-doesn't-open-loot bugs. Default: OFF.",
      scope:   "client",
      config:  false,
      type:    Boolean,
      default: false,
    });

    s("enableXpDistribution", {
      name:    "Enable XP Distribution at Combat End",
      hint:    "When combat ends, prompt the GM to distribute XP from defeated NPCs. Only connected (active) PCs receive XP. Dead PCs are auto-skipped.",
      scope:   "world",
      config:  false,
      type:    Boolean,
      default: true,
    });

    s("reduceCoverForLargeTargets", {
      name:    "Reduce Cover for Large+ Targets (House Rule)",
      hint:    "Big creatures can't easily hide behind small obstacles. When ON: Large targets ignore Half cover and downgrade ¾ cover to Half. Huge targets ignore Half + ¾ cover entirely (only Full cover counts). Gargantuan: same as Huge. Disable to use strict 5e RAW.",
      scope:   "world",
      config:  false,
      type:    Boolean,
      default: true,
    });

    s("autoDeleteInstantTemplates", {
      name:    "Auto-Delete Instant Spell Templates",
      hint:    "After damage is rolled for an instantaneous spell (Fireball, Lightning Bolt, etc.), automatically delete the AOE template from the canvas. Templates for persistent spells (Fog Cloud, Spirit Guardians) are kept and remain draggable.",
      scope:   "world",
      config:  false,
      type:    Boolean,
      default: true,
    });

    s("dsnRevealDelayMs", {
      name:    "Result Card Reveal Cap (ms)",
      hint:    "Result cards now appear the moment Dice So Nice finishes animating (event-based). This value is only the MAXIMUM wait — if the 3D animation is skipped or disabled for a roll, the card reveals after this many milliseconds instead of hanging. Default 3000. Set to 0 to disable waiting entirely.",
      scope:   "world",
      config:  false,
      type:    Number,
      default: 3000,
      range:   { min: 0, max: 6000, step: 250 },
    });

    s("polymorphMode", {
      name:    "Polymorph Implementation",
      hint:    "Choose the engine that handles Polymorph spell + trap transformations. ACE handles it itself - quick, and works the same on a hosted server. DND5E NATIVE hands it to the game system instead - exactly by the book, but it can take a minute or two on a hosted server.",
      scope:   "world",
      config:  false,
      type:    String,
      default: "custom",
      choices: {
        custom: "Custom — fast (ace-qol implementation, ~3s)",
        dnd5e:  "Game system — by the book, but slower",
      },
    });

    s("tokenImageFolders", {
      name:    "Token Image Folders",
      hint:    "Folders ace-qol scans recursively to build the polymorph token-image cache. Each entry is a path relative to your Foundry user-data folder (e.g. 'NPCs' or 'assets/srd5e/img/bestiary/tokens/MM'). When empty, polymorph uses compendium-default images. Add/remove folders via the ace-qol config panel.",
      scope:   "world",
      config:  false,
      type:    Object,
      default: [],
    });

    s("tokenImageCacheData", {
      name:    "Token Image Cache Data (persisted)",
      hint:    "Internal — persisted snapshot of the scanned token-image map. Auto-managed by ace-qol; do not edit by hand. Cleared by 'Rescan' in the config panel.",
      scope:   "world",
      config:  false,
      type:    Object,
      default: { map: {}, paths: [], fileCount: 0, uniqueCount: 0, durationSec: 0, timestamp: 0 },
    });

    // ── THE CLOCK: time outside combat ─────────────────────────────────
    // Johnny asked for this directly (2026-08-11): "We do have a setting to
    // turn time off or something like that, right?" — we did not.
    // ⚠️ The master switch is honoured at the CHOKEPOINT (TheClock.spend), so
    // turning it off silences every consumer at once. A per-feature opt-out
    // would leave some path still writing world time.
    s("clockEnabled", {
      name:    "Track time outside combat",
      hint:    "Searching, resting, butchering and walking advance the world clock. Combat is never affected — Foundry already counts 6 seconds a round. Turn this off and ACE stops touching the clock entirely.",
      scope:   "world",
      config:  true,
      type:    Boolean,
      default: true,
    });

    s("clockMovementEnabled", {
      name:    "Walking costs time",
      hint:    "Moving player tokens advances the clock by distance and the scene's pace. Off means only deliberate actions — searches, rests, meals — cost time. Ignored entirely when 'Track time outside combat' is off.",
      scope:   "world",
      config:  true,
      type:    Boolean,
      default: true,
    });

    // ── THE CLOCK: food and water ──────────────────────────────────────
    // Johnny chose ON by default (2026-08-10): "We're building a feature that
    // we want on that nobody knows about… if they're surprised by it in the
    // middle of a dungeon, a DM can just slide some rations over to them."
    // The first meal posts a one-time explainer so it is discoverable rather
    // than silent.
    s("sustenanceEnabled", {
      name:    "Track food and water",
      hint:    "On a long rest the party eats from a shared pool of rations. Going without food past 3 + your Constitution modifier days brings exhaustion. Beasts you kill can be butchered for meat.",
      scope:   "world",
      config:  true,
      type:    Boolean,
      default: true,
    });

    // ⚠️ Water OFF by default and deliberately low-profile. RAW is a gallon per
    // person per day and a waterskin holds HALF a gallon, so a party of four
    // needs eight full skins a day — which nobody carries, because RAW assumes
    // you refill from streams and wells constantly. Checked every rest, it
    // would fire false exhaustion nightly and the whole feature would get
    // switched off. Turn it on for a desert crossing and leave it off otherwise.
    s("sustenanceTrackWater", {
      name:    "Also track water (arid regions)",
      hint:    "Leave this off unless the party is somewhere with no water. RAW needs a gallon per person per day, which assumes constant refilling — tracked everywhere it will report thirst every single night.",
      scope:   "world",
      config:  true,
      type:    Boolean,
      default: false,
    });

    s("sustenanceExplained", {
      name:    "Sustenance explainer shown (internal)",
      scope:   "world",
      config:  false,
      type:    Boolean,
      default: false,
    });

    console.debug(`${MODULE_ID} | Settings registered (all combat features ON by default)`);
  }

  /** Quick helper to read a setting */
  static get(key) {
    return game.settings.get(MODULE_ID, key);
  }

  /**
   * Hook into settings panel render to hide/show managed settings and add section headers.
   */
  static onRenderSettingsConfig(app, html) {
    const el = html[0] ?? html;
    const level = game.settings.get(MODULE_ID, "automationLevel");
    const isCustom = (level === "custom");

    // ── Hide/show managed settings based on preset ──
    for (const key of PRESET_MANAGED_KEYS) {
      const row = el.querySelector(`div.form-group:has([name="${MODULE_ID}.${key}"])`);
      if (!row) continue;
      row.style.display = isCustom ? "" : "none";
    }

    // ── Also hide non-boolean settings that are sub-options of hidden parents ──
    const subSettings = [
      "reactionTimeout", "speedRollBehavior", "speedRollAdvantageKey",
      "mergeCardStyle", "showAttackFormula", "showDamageFormula", "critRule",
      "optionalPromptTimeout", "coverCalculationMethod",
      "bloodiedThreshold", "bloodiedIndicatorStyle", "bloodiedVisibleTo",
      "npcAttackVisibility", "npcDamageVisibility", "npcSaveVisibility",
    ];
    for (const key of subSettings) {
      const row = el.querySelector(`div.form-group:has([name="${MODULE_ID}.${key}"])`);
      if (!row) continue;
      row.style.display = isCustom ? "" : "none";
    }

    // ── Add a summary note when not custom ──
    if (!isCustom) {
      const presetRow = el.querySelector(`div.form-group:has([name="${MODULE_ID}.automationLevel"])`);
      if (presetRow && !presetRow.querySelector(".ace-preset-note")) {
        const note = document.createElement("p");
        note.className = "ace-preset-note notes";
        note.style.cssText = "color:#999; font-style:italic; margin:4px 0 0 0; font-size:11px;";
        note.textContent = `Using "${level}" preset. Switch to "Custom" to see and edit all ${PRESET_MANAGED_KEYS.size}+ individual settings.`;
        presetRow.appendChild(note);
      }
    }

    // ── When in custom mode, add section headers ──
    if (isCustom) {
      const sections = {
        autoCheckHit:           "⚔️ Combat Workflow",
        enableReactions:        "🛡️ Reactions",
        enableSpeedRolls:       "⚡ Speed Rolls",
        enableMergeCard:        "📋 Merge Card",
        critRule:               "💥 Critical Hits",
        extendedEffects:        "✨ Active Effects",
        enableOnUseHooks:       "🔗 Hooks & OverTime",
        enableFlagsSystem:      "🚩 Flags & Optional Prompts",
        enableDurationTracker:  "⏱️ Duration Tracking",
        enableCoverCalculation: "🏰 Cover",
        enableBloodied:         "🩸 Bloodied & Death",
        npcAttackVisibility:    "👁️ Roll Visibility",
      };
      for (const [settingKey, label] of Object.entries(sections)) {
        const row = el.querySelector(`div.form-group:has([name="${MODULE_ID}.${settingKey}"])`);
        if (!row || row.previousElementSibling?.classList?.contains("ace-section-header")) continue;
        const header = document.createElement("h3");
        header.className = "ace-section-header";
        header.style.cssText = "border-bottom:1px solid #444; padding:8px 0 4px 0; margin:16px 0 6px 0; color:#d4af37; font-size:13px; font-weight:bold;";
        header.textContent = label;
        row.parentNode.insertBefore(header, row);
      }
    }
  }
}
