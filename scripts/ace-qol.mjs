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
import { RiderEngine }          from "./rider-engine.mjs";
import { FlagsEngine }          from "./flags-engine.mjs";
import { ReactionEngine, injectReactionCSS } from "./reaction-engine.mjs";
import { HookAPI }              from "./hook-api.mjs";
import { OverTimeEngine }       from "./overtime-engine.mjs";
import { CoverEngine }          from "./cover-engine.mjs";
import { BloodiedEngine }       from "./bloodied-engine.mjs";
import { VisibilityEngine }     from "./visibility-engine.mjs";
import { ConditionLibrary }     from "./condition-library.mjs";
import { DurationTracker }      from "./duration-tracker.mjs";
import { SpeedRolls }           from "./speed-rolls.mjs";
import { MergeCard }            from "./merge-card.mjs";

// ─── Module state ────────────────────────────────────────────────────────────
let extendedEffects      = null;
let attackPipeline       = null;
let damageEngine         = null;
let saveEngine           = null;
let concentrationWidget  = null;
let durationTracker      = null;
let reactionEngine       = null;
let overTimeEngine       = null;
let bloodiedEngine       = null;
let speedRolls           = null;

const SOCKET_NAME = `module.${MODULE_ID}`;

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

  // Attack pipeline — ALL users
  // Pre-roll hook (advantage/disadvantage, range check) runs on the attacking client.
  // Post-roll processing (_onAttackRoll) has its own GM guard — only GM processes results.
  try {
    attackPipeline = new AttackPipeline();
    console.log(`${MODULE_ID} | Attack pipeline online`);
  } catch (err) {
    console.error(`${MODULE_ID} | Attack pipeline init failed:`, err);
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
    console.log(`${MODULE_ID} | Condition Library online`);
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

  // Speed Rolls — ALL users (intercepts character sheet clicks for fast-forward)
  try {
    speedRolls = new SpeedRolls();
    console.log(`${MODULE_ID} | Speed rolls online`);
  } catch (err) {
    console.error(`${MODULE_ID} | Speed rolls init failed:`, err);
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
          } catch { /* cover non-blocking */ }

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
          await attackPipeline._postAttackResults(item, actor, results, { isMelee, isSpell, roll: fakeRoll });

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
    DurationTracker,
    durationTracker,
    speedRolls,
    MergeCard,

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
  };

  // Register APIs that need game.aceQol to exist
  try { CoverEngine.registerAPI(); } catch { /* non-critical */ }
  try { if (bloodiedEngine) bloodiedEngine.registerAPI(); } catch { /* non-critical */ }
  try { VisibilityEngine.registerAPI(); } catch { /* non-critical */ }

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

    // Collapse the description/content section, keep header visible
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
    ItemClass.prototype.use = function(config = {}, ...args) {
      if (this.type === "weapon") {
        // Replace the event with a plain object — native MouseEvent.shiftKey is read-only,
        // so we can't set it on the original event (BG3 HUD passes real MouseEvents).
        // The system checks event?.shiftKey to skip ActivityChoiceDialog.
        config.event = { shiftKey: true };
      }
      return origUse.call(this, config, ...args);
    };
    console.log(`${MODULE_ID} | Patched Item.use() to skip ActivityChoiceDialog for weapons`);
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
