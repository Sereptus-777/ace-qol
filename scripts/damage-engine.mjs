// ─── ACE: QOL — Damage Engine (Orchestrator) ─────────────────────────────────
// Central coordinator for the damage pipeline. Registers hooks, routes events,
// and delegates to specialized modules:
//   - DamageCalculator  → pure math (roll components, crit rules, modifiers)
//   - DamageCardRenderer → HTML card generation (damage buttons, full cards)
//   - DamageApplicator  → HP mutation (apply, undo, overrides, per-type toggle)
//   - PostHitSaves      → save subsystem (check, card, roll, results)
//   - RiderEngine       → rider detection, popup, resource consume/refund
//
// This replaces Midi-QOL's damage handling entirely.
// ──────────────────────────────────────────────────────────────────────────────

import { MODULE_ID } from "./ace-qol.mjs";
import { QolSettings } from "./settings.mjs";
import { DescriptionParser } from "./description-parser.mjs";
import { RiderEngine } from "./rider-engine.mjs";
import { MergeCard } from "./merge-card.mjs";
import { DamageCalculator } from "./damage-calculator.mjs";
import { DamageCardRenderer } from "./damage-card-renderer.mjs";
import { DamageApplicator } from "./damage-applicator.mjs";
import { AttackPipeline } from "./attack-pipeline.mjs";  // v0.4.22: shared multi-target detection
import { PostHitSaves } from "./post-hit-saves.mjs";

// ═══════════════════════════════════════════════════════════════════════════
//  Shared Constants — exported for use by all damage sub-modules
// ═══════════════════════════════════════════════════════════════════════════

export class DamageConstants {
  static suppressDiceAnimation = false;

  static async showDiceAnimation(roll) {
    if (!roll || DamageConstants.suppressDiceAnimation) return;
    // ── DSN fire-and-forget (v0.4.21) ──
    // Never await DSN. If the renderer is broken, awaiting hangs forever.
    // Players still see broadcast dice on their working clients.
    try {
      game.dice3d?.showForRoll?.(roll, game.user, true)?.catch?.(err =>
        console.warn(`${MODULE_ID} | DSN dice animation rejected (non-fatal):`, err?.message ?? err)
      );
    } catch (err) {
      console.warn(`${MODULE_ID} | DSN dice animation threw:`, err?.message ?? err);
    }
  }

  /**
   * Serialize Roll terms for flag storage (Roll objects aren't serializable).
   */
  static serializeRollTerms(roll) {
    if (!roll?.terms) return [];
    return roll.terms.map(t => {
      if (t.faces) return { type: "die", faces: t.faces, results: (t.results ?? []).map(r => ({ result: r.result })) };
      if (t.number !== undefined && !t.faces) return { type: "num", number: t.number };
      if (t.operator) return { type: "op", operator: t.operator };
      return null;
    }).filter(Boolean);
  }

  /**
   * Check if an actor has a cleave-type ability.
   *
   * v0.4.22: delegates to AttackPipeline._actorHasMultiTargetMelee for
   * 4-layer detection (weapon mastery, identifier match, world allow-list,
   * legacy name-matching) instead of the previous pure-name-matching that
   * broke on translated worlds and homebrew weapons.
   *
   * @param {Actor} actor
   * @param {Item} [weapon] - Optional weapon being swung; enables Layer 1
   *                          weapon-mastery detection
   */
  static actorHasCleave(actor, weapon = null) {
    if (!actor?.items) return false;
    return AttackPipeline._actorHasMultiTargetMelee(actor, weapon);
  }

  // ── Dice image path builder ──
  static DICE_COLOR = "Red";

  static getDiceImagePath(faces, result) {
    const color = DamageConstants.DICE_COLOR;
    const dieFolder = `d${faces}`;
    return `modules/ace-qol/Assets/Dice%20Dice/Dice%20Images/${color}/${dieFolder}/${faces}-${result}_nobg.png`;
  }

  static getBD20ImagePath(result) {
    return `modules/ace-qol/Assets/Dice%20Dice/BD20/BD20-${result}_nobg.png`;
  }

  static DIE_ICONS = {
    4:  "fa-dice-d4",
    6:  "fa-dice-d6",
    8:  "fa-dice-d8",
    10: "fa-dice-d10",
    12: "fa-dice-d12",
    20: "fa-dice-d20",
  };

  static DAMAGE_COLORS = {
    slashing:     "#e0e0e0",
    piercing:     "#c0c0c0",
    bludgeoning:  "#a0a0c0",
    fire:         "#ff6d00",
    cold:         "#4fc3f7",
    lightning:    "#7c4dff",
    acid:         "#c6ff00",
    poison:       "#66bb6a",
    necrotic:     "#ce93d8",
    radiant:      "#ffd54f",
    force:        "#b388ff",
    psychic:      "#f48fb1",
    thunder:      "#80deea",
    healing:      "#00e676",
  };
}

// ═══════════════════════════════════════════════════════════════════════════
//  DamageEngine — The Orchestrator
// ═══════════════════════════════════════════════════════════════════════════

export class DamageEngine {

  constructor() {
    /** Pending rider popup requests sent to players, keyed by requestId. */
    this._pendingRiderRequests = {};
    this._registerHooks();
  }

  // Keep backward-compat static reference to override cache
  static get overrideCache() { return DamageApplicator.overrideCache; }

  _registerHooks() {
    // Listen for our own attack completion
    Hooks.on(`${MODULE_ID}.attackComplete`, (data) => this._onAttackComplete(data));

    // ── PERSISTENT BUTTONS: Re-wire Apply/Undo on ANY damage card render ──
    //
    // v0.4.22: tightened scope + defensive try/catch.
    //   Previous implementation extracted flags then type-checked. Now we
    //   short-circuit on flag presence FIRST (fastest possible exit on
    //   non-ace messages), and the entire body is wrapped in try/catch so
    //   a single malformed card can't crash the listener for subsequent
    //   messages.
    //   Also registers `renderChatMessageHTML` for Foundry V13 compat —
    //   previous implementation only listened to V12's `renderChatMessage`.
    const _cardRenderHandler = (message, html) => {
      try {
        // Fastest-possible early exit for non-ace messages
        if (!message?.flags?.[MODULE_ID]) return;
        const flags = message.flags[MODULE_ID];
        if (!flags?.type || !["damageResult", "damageButton", "postHitSave", "postHitSaveResult"].includes(flags.type)) return;

        const el = html?.[0] ?? html;
        if (!el) return;

      // ── Hide GM-only sections for non-GM users ──
      if (!game.user.isGM) {
        const targets = el.querySelector?.(".ace-qol-dmg-targets");
        if (targets) targets.style.display = "none";
        const gmControls = el.querySelectorAll?.(".ace-qol-dmg-gm-controls");
        for (const ctrl of (gmControls ?? [])) {
          ctrl.style.display = "none";
        }
      }

      // ── Player status summary ──
      DamageCardRenderer.injectPlayerStatus(el, flags);

      // ── Apply button ──
      const applyBtn = el.querySelector?.("[data-action='aceQolApplyDamage']");
      const undoBtn = el.querySelector?.("[data-action='aceQolUndoDamage']");

      const anyPerTypeApplied = Object.values(flags?.appliedComps ?? {}).some(arr => arr?.length > 0);

      if (applyBtn && !applyBtn.dataset.wired) {
        applyBtn.dataset.wired = "1";
        if (flags.applied) {
          applyBtn.disabled = true;
          applyBtn.textContent = "APPLIED ✓";
        } else {
          applyBtn.addEventListener("click", async () => {
            await DamageApplicator.applyDamage(message);
            applyBtn.disabled = true;
            applyBtn.textContent = "APPLIED ✓";
            await message.setFlag(MODULE_ID, "applied", true);
          });
        }
      }

      if (undoBtn && !undoBtn.dataset.wired) {
        undoBtn.dataset.wired = "1";
        if (!flags.applied && !anyPerTypeApplied) {
          undoBtn.disabled = true;
          undoBtn.style.opacity = "0.35";
          undoBtn.title = "Apply damage first";
        } else {
          undoBtn.disabled = false;
          undoBtn.style.opacity = "";
          undoBtn.title = "Undo all applied damage and reset card";

          const appliedCompsMap = flags?.appliedComps ?? {};
          const results = flags?.damageResults ?? [];
          const appliedTypeNames = new Set();
          for (const [tid, indices] of Object.entries(appliedCompsMap)) {
            const entry = results.find(r => r.tokenDocId === tid);
            if (!entry?.components) continue;
            for (const idx of (indices ?? [])) {
              const comp = entry.components[idx];
              if (comp?.type) appliedTypeNames.add(comp.type.toUpperCase());
            }
          }
          if (flags.applied) {
            undoBtn.innerHTML = '<i class="fas fa-undo"></i> UNDO ALL';
          } else if (appliedTypeNames.size === 1) {
            undoBtn.innerHTML = `<i class="fas fa-undo"></i> UNDO ${[...appliedTypeNames][0]}`;
          } else {
            undoBtn.innerHTML = '<i class="fas fa-undo"></i> UNDO ALL';
          }

          undoBtn.addEventListener("click", async () => {
            await DamageApplicator.undoDamage(message);
          });
        }
      }

      // ── Per-row override buttons ──
      DamageApplicator.wireOverrideButtons(el, message);

      // ── Rider Refund buttons — GM only ──
      if (game.user.isGM) {
        RiderEngine.wireRefundButtons(el, message);
      }

      // ── ADD TARGET button ──
      const addBtn = el.querySelector?.("[data-action='aceQolAddTarget']");
      if (addBtn && !addBtn.dataset.wired) {
        addBtn.dataset.wired = "1";
        addBtn.addEventListener("click", () => {
          if (message.flags?.[MODULE_ID]?.applied) return;
          addBtn.classList.add("ace-qol-btn-picking");
          addBtn.textContent = "⊕ CLICK TOKEN...";

          const pickHook = Hooks.on("controlToken", async (token, controlled) => {
            if (!controlled || !token) return;
            Hooks.off("controlToken", pickHook);
            addBtn.classList.remove("ace-qol-btn-picking");
            addBtn.innerHTML = '<i class="fas fa-plus"></i> ADD';
            await DamageApplicator.addTargetToCard(message, el, token, false);
            DamageApplicator.wireOverrideButtons(el, message);
          });
        });
      }

      // ── CLEAVE button ──
      const cleaveBtn = el.querySelector?.("[data-action='aceQolCleave']");
      if (cleaveBtn && !cleaveBtn.dataset.wired) {
        cleaveBtn.dataset.wired = "1";
        cleaveBtn.addEventListener("click", () => {
          if (message.flags?.[MODULE_ID]?.applied) return;

          const results = message.flags?.[MODULE_ID]?.damageResults ?? [];
          let overkill = 0;
          let overkillComponents = null;
          for (const r of results) {
            const excess = r.totalFinal - r.currentHP;
            if (excess > 0) {
              overkill = excess;
              overkillComponents = r.components;
              break;
            }
          }
          if (overkill <= 0) {
            ui.notifications.warn("ACE QOL: No excess damage — no target reduced to 0 HP.");
            return;
          }

          cleaveBtn.classList.add("ace-qol-btn-picking");
          cleaveBtn.textContent = `⚔ ${overkill} DMG — CLICK TOKEN...`;

          const pickHook = Hooks.on("controlToken", async (token, controlled) => {
            if (!controlled || !token) return;
            Hooks.off("controlToken", pickHook);
            cleaveBtn.classList.remove("ace-qol-btn-picking");
            cleaveBtn.innerHTML = '<i class="fas fa-khanda"></i> CLEAVE';
            await DamageApplicator.addTargetToCard(message, el, token, true, overkill, overkillComponents);
            DamageApplicator.wireOverrideButtons(el, message);
          });
        });
      }

      // ── Auto-apply damage to HP ──
      // If setting is ON, GM auto-applies damage as soon as the card renders
      if (game.user.isGM && flags.type === "damageResult" && !flags.applied && applyBtn) {
        try {
          const shouldAutoApply = QolSettings.get("autoApplyDamage");
          if (shouldAutoApply && !el.dataset.aceAutoApplied) {
            el.dataset.aceAutoApplied = "1";
            // Slight delay to let the card fully render first
            setTimeout(async () => {
              try {
                await DamageApplicator.applyDamage(message);
                const btn = el.querySelector?.("[data-action='aceQolApplyDamage']");
                if (btn) { btn.disabled = true; btn.textContent = "APPLIED ✓"; }
                await message.setFlag(MODULE_ID, "applied", true);
                console.log(`${MODULE_ID} | Auto-applied damage for message ${message.id}`);
              } catch (err) {
                console.error(`${MODULE_ID} | Auto-apply damage failed:`, err);
              }
            }, 100);
          }
        } catch (_) { /* setting not ready */ }
      }

      // ── PC "Roll Damage" button ──
      const rollDmgBtn = el.querySelector?.("[data-action='aceQolRollDamage']");
      if (rollDmgBtn && !rollDmgBtn.dataset.wired) {
        rollDmgBtn.dataset.wired = "1";
        if (flags.rolled) {
          rollDmgBtn.disabled = true;
          rollDmgBtn.innerHTML = '<i class="fas fa-check"></i> ROLLED ✓';
        }

        // ── Auto-roll damage when setting is ON ──
        if (game.user.isGM && !flags.rolled && !el.dataset.aceAutoRolled) {
          try {
            const shouldAutoRoll = QolSettings.get("autoRollDamage");
            if (shouldAutoRoll) {
              el.dataset.aceAutoRolled = "1";
              rollDmgBtn.disabled = true;
              rollDmgBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Rolling...';
              // Slight delay to let the card render fully before triggering
              setTimeout(async () => {
                try {
                  const success = await this._rollDamageFromButton(message);
                  if (success) {
                    rollDmgBtn.innerHTML = '<i class="fas fa-check"></i> Rolled ✓';
                    console.log(`${MODULE_ID} | Auto-rolled damage for message ${message.id}`);
                  } else {
                    rollDmgBtn.innerHTML = '<i class="fas fa-burst"></i> ROLL DAMAGE';
                    rollDmgBtn.disabled = false;
                  }
                } catch (err) {
                  console.error(`${MODULE_ID} | Auto-roll damage failed:`, err);
                  rollDmgBtn.innerHTML = '<i class="fas fa-burst"></i> ROLL DAMAGE';
                  rollDmgBtn.disabled = false;
                }
              }, 50);
            }
          } catch (_) { /* setting not ready */ }
        }

        rollDmgBtn.addEventListener("click", async () => {
          rollDmgBtn.disabled = true;
          rollDmgBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Rolling...';
          try {
            if (game.user.isGM) {
              const success = await this._rollDamageFromButton(message);
              if (success) {
                rollDmgBtn.innerHTML = '<i class="fas fa-check"></i> Rolled ✓';
              } else {
                rollDmgBtn.innerHTML = '<i class="fas fa-exclamation-triangle"></i> Failed — check console';
                rollDmgBtn.disabled = false;
                ui.notifications.error("ACE QOL: Damage roll returned early — check console (F12) for details.");
              }
            } else {
              console.log(`${MODULE_ID} | Player requesting GM to roll damage for message ${message.id}`);
              game.socket.emit(`module.${MODULE_ID}`, {
                action: "rollDamage",
                messageId: message.id,
                userId: game.user.id,
                userName: game.user.name,
              });
              rollDmgBtn.innerHTML = '<i class="fas fa-check"></i> Rolled ✓';
            }
          } catch (err) {
            console.error(`${MODULE_ID} | Roll damage failed:`, err);
            rollDmgBtn.innerHTML = '<i class="fas fa-exclamation-triangle"></i> Error — check console';
            rollDmgBtn.disabled = false;
            ui.notifications.error("ACE QOL: Damage roll failed — check console for details.");
          }
        });
      }

      // ── Post-hit "Roll Saves" button ──
      const rollSaveBtn = el.querySelector?.("[data-action='aceQolRollPostHitSaves']");
      if (rollSaveBtn && !rollSaveBtn.dataset.wired) {
        rollSaveBtn.dataset.wired = "1";
        if (flags.rolled) {
          rollSaveBtn.disabled = true;
          rollSaveBtn.innerHTML = '<i class="fas fa-check"></i> ROLLED ✓';
        } else {
          rollSaveBtn.addEventListener("click", async () => {
            rollSaveBtn.disabled = true;
            rollSaveBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Rolling...';
            try {
              await PostHitSaves.rollPostHitSaves(message);
              rollSaveBtn.innerHTML = '<i class="fas fa-check"></i> ROLLED ✓';
              await message.setFlag(MODULE_ID, "rolled", true);
            } catch (err) {
              console.error(`${MODULE_ID} | Post-hit save failed:`, err);
              rollSaveBtn.innerHTML = '<i class="fas fa-exclamation-triangle"></i> Error';
              rollSaveBtn.disabled = false;
            }
          });
        }
      }
      } catch (err) {
        console.warn(`${MODULE_ID} | renderChatMessage handler threw (non-fatal):`, err?.message ?? err);
      }
    };

    Hooks.on("renderChatMessage", _cardRenderHandler);
    Hooks.on("renderChatMessageHTML", _cardRenderHandler);  // V13 hook

    console.log(`${MODULE_ID} | Damage engine hooks registered`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Attack Complete → Route to Damage Card
  // ═══════════════════════════════════════════════════════════════════════════

  async _onAttackComplete(data) {
    const { item, actor, results, hits, actionType: hookActionType, subject } = data;
    if (!hits?.length) return;

    // ── Check for optional riders (Divine Smite, Eldritch Smite, maneuvers, etc.) ──
    try {
      const firstHit = hits[0];
      const targetActor = firstHit.targetActor ?? game.actors.get(firstHit.actorId);
      const resolvedActionType = hookActionType ?? subject?.actionType ?? item.system?.actionType ?? "mwak";
      const isMelee = ["mwak", "msak"].includes(resolvedActionType);
      const isRanged = ["rwak", "rsak"].includes(resolvedActionType);
      const isCrit = firstHit.hitResult === "critical";

      const availableRiders = RiderEngine.detectRiders(actor, {
        actor: targetActor,
        token: firstHit.targetToken,
        creatureType: targetActor?.system?.details?.type?.value ?? firstHit.target?.creatureType,
        creatureSubtype: targetActor?.system?.details?.type?.subtype,
        creatureSize: targetActor?.system?.traits?.size ?? firstHit.target?.creatureSize,
        currentHP: targetActor?.system?.attributes?.hp?.value ?? firstHit.target?.currentHP,
        maxHP: targetActor?.system?.attributes?.hp?.max ?? firstHit.target?.maxHP,
      }, { isMelee, isRanged, isCrit, item });

      console.log(`${MODULE_ID} | Rider scan: actor=${actor.name}, isMelee=${isMelee}, targetType=${targetActor?.system?.details?.type?.value ?? "unknown"}, riders found=${availableRiders.length}`, availableRiders.map(r => r.name));

      if (availableRiders.length > 0) {
        const targetName = firstHit.target?.name ?? firstHit.name ?? "target";
        const targetCreatureType = targetActor?.system?.details?.type?.value ?? "";

        const riderContext = {
          attackerName: actor.name,
          targetName,
          targetCreatureType,
          isCrit,
        };

        const selectedRiders = await this._requestRiderChoice(actor, availableRiders, riderContext);

        if (selectedRiders.length > 0) {
          await RiderEngine.consumeResources(actor, selectedRiders);

          // Once-per-turn riders — mark the actor flag after resources are
          // consumed so the rider-engine `detectRiders` step on the NEXT hit
          // this turn skips offering them. Cleared on combatTurnChange.
          for (const rider of selectedRiders) {
            if (rider.isOncePerTurn === "divineSmite") {
              await CombatState.markDivineSmiteUsed(actor);
            } else if (rider.isOncePerTurn === "eldritchSmite") {
              await CombatState.markEldritchSmiteUsed(actor);
            }
          }

          for (const hit of hits) {
            if (!hit.attacker) hit.attacker = { bonuses: [] };
            if (!hit.attacker.bonuses) hit.attacker.bonuses = [];
            for (const rider of selectedRiders) {
              if (rider.formula) {
                hit.attacker.bonuses.push({
                  name: rider.name,
                  formula: rider.formula,
                  type: rider.type ?? "radiant",
                  // ── Preserve metadata flags so downstream consumers
                  //    (Radiant Soul detector, future feature riders) can
                  //    still see them. Without this, isSpellDerived was
                  //    silently lost when riders were transferred to the
                  //    bonus list, and Radiant Soul could never fire on
                  //    Divine Smite / smite spell damage attached to a
                  //    weapon attack. v0.4.19 hotfix.
                  isSpellDerived: rider.isSpellDerived === true,
                  isDischarge: rider.isDischarge === true,
                  riderId: rider.id,
                });
              }
            }
          }

          this._pendingConsumedRiders = selectedRiders
            .filter(r => !r.isDischarge && !r.skipConsume && r.resource)
            .map(r => ({
              id: r.id,
              name: r.name,
              resourceType: r.resource.type,
              resourceLevel: r.resource.level ?? null,
              actorId: actor.id,
            }));

          console.log(`${MODULE_ID} | Riders applied: ${selectedRiders.map(r => `${r.name} (${r.formula})`).join(", ")}`);
        }
      }
    } catch (err) {
      console.error(`${MODULE_ID} | Rider detection/popup failed (non-blocking):`, err);
    }

    // Grab consumed riders from pending state
    const consumedRiders = this._pendingConsumedRiders ?? [];
    this._pendingConsumedRiders = null;

    if (MergeCard.isEnabled) {
      await DamageCardRenderer.postMergeDamageButton(item, actor, hits, consumedRiders);
    } else {
      await DamageCardRenderer.postDamageButton(item, actor, hits, consumedRiders);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Ownership-based Rider Routing
  // ═══════════════════════════════════════════════════════════════════════════

  async _requestRiderChoice(actor, riders, context) {
    const owningPlayer = game.users.find(u =>
      !u.isGM && u.active && actor.testUserPermission(u, "OWNER")
    );

    if (!owningPlayer) {
      console.log(`${MODULE_ID} | Rider popup: showing locally (GM-controlled actor)`);
      return RiderEngine.showRiderPopup(riders, context);
    }

    const requestId = foundry.utils.randomID();
    console.log(`${MODULE_ID} | Rider popup: routing to player ${owningPlayer.name} (requestId=${requestId})`);

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        delete this._pendingRiderRequests[requestId];
        console.warn(`${MODULE_ID} | Rider request ${requestId} timed out after 60s — skipping riders`);
        ui.notifications.warn(`ACE QOL: ${owningPlayer.name} didn't respond to rider popup — skipping.`);
        resolve([]);
      }, 60000);

      this._pendingRiderRequests[requestId] = { resolve, timeout };

      game.socket.emit(`module.${MODULE_ID}`, {
        action: "showRiderPopup",
        requestId,
        userId: owningPlayer.id,
        riders,
        context,
      });
    });
  }

  resolveRiderChoice(requestId, selectedRiders) {
    const pending = this._pendingRiderRequests[requestId];
    if (!pending) {
      console.warn(`${MODULE_ID} | No pending rider request for ${requestId}`);
      return;
    }
    clearTimeout(pending.timeout);
    delete this._pendingRiderRequests[requestId];
    pending.resolve(selectedRiders ?? []);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Roll Damage From Button Click
  // ═══════════════════════════════════════════════════════════════════════════

  async _rollDamageFromButton(message) {
    const flags = message.flags?.[MODULE_ID];
    console.log(`${MODULE_ID} | _rollDamageFromButton ENTERED. flags:`, flags);

    if (flags?.rolled) {
      console.log(`${MODULE_ID} | _rollDamageFromButton: already rolled, skipping`);
      return true;
    }

    // In-memory lock against double-click race. setFlag is async, so the
    // window between this function entering and line ~578 (setFlag commits
    // `rolled:true`) is non-trivial. A user double-clicking the ROLL
    // DAMAGE button — or a held mouse button firing two click events —
    // produces two concurrent calls; both see no `rolled` flag and both
    // post a damage card. The set-flag check above only catches
    // sequential clicks. This lock catches concurrent clicks too.
    if (!DamageEngine._rollLocks) DamageEngine._rollLocks = new Set();
    if (DamageEngine._rollLocks.has(message.id)) {
      console.log(`${MODULE_ID} | _rollDamageFromButton: roll already in progress for ${message.id}, skipping`);
      return false;
    }
    DamageEngine._rollLocks.add(message.id);

    try {

    // ── New path: pre-rolled results available (Beneos-safe) ──
    if (flags?.preRolled?.length) {
      const result = await DamageCardRenderer.postPreRolledDamageCard(message, flags);
      if (result?.success) {
        await message.setFlag(MODULE_ID, "rolled", true);
        // If the renderer returned an item for post-hit effects, run them
        if (result.item) {
          await PostHitSaves.checkPostHitEffects(result.item, game.actors.get(flags.actorId), flags.preRolled, result.damageResults);
        }
      }
      return !!result?.success;
    }

    // ── Legacy path: old messages without pre-rolled data ──
    if (!flags?.hits?.length) {
      console.error(`${MODULE_ID} | _rollDamageFromButton BAIL: no preRolled and no hits.`, flags);
      return false;
    }

    const actor = game.actors.get(flags.actorId);
    let item = await fromUuid(flags.itemUuid).catch(() => null);
    if (!item) item = actor?.items?.get(flags.itemId);
    if (!item && flags.itemName) item = actor?.items?.getName(flags.itemName);
    if (!item) item = game.items.get(flags.itemId);
    if (!item || !actor) {
      console.error(`${MODULE_ID} | _rollDamageFromButton BAIL (legacy): item=${!!item} actor=${!!actor}`);
      return false;
    }

    const critRule = QolSettings.get("critRule") ?? "maxPlusRoll";
    let rollData;
    try { rollData = item.getRollData?.() ?? actor.getRollData?.() ?? {}; }
    catch (e) { rollData = actor.getRollData?.() ?? {}; }

    const damageResults = [];
    for (const hit of flags.hits) {
      const isCrit = hit.hitResult === "critical";
      const components = await DamageCalculator.rollDamageComponents(item, actor, hit, isCrit, critRule);
      const applied = DamageCalculator.applyDamageModifiers(components, hit.damageModifiers ?? {});
      const totalRaw = applied.reduce((sum, c) => sum + c.raw, 0);
      const totalFinal = applied.reduce((sum, c) => sum + c.final, 0);
      const scene = game.scenes.get(hit.sceneId) ?? canvas.scene;
      const tokenDoc = scene?.tokens?.get(hit.tokenDocId);
      const targetActor = tokenDoc?.actor ?? game.actors.get(hit.actorId);
      damageResults.push({
        target: { name: hit.name, img: hit.img, currentHP: targetActor?.system?.attributes?.hp?.value ?? hit.currentHP, maxHP: hit.maxHP },
        targetToken: { id: hit.tokenId, document: { id: hit.tokenDocId } },
        targetActor: targetActor ?? { id: hit.actorId },
        isCrit, components: applied, totalRaw, totalFinal,
      });
    }

    try {
      await DamageCardRenderer.postDamageCard(item, actor, damageResults, critRule);
    } catch (err) {
      console.error(`${MODULE_ID} | postDamageCard (legacy) CRASHED:`, err);
      return false;
    }
    await PostHitSaves.checkPostHitEffects(item, actor, flags.hits, damageResults);
    return true;

    } finally {
      DamageEngine._rollLocks?.delete?.(message.id);
    }
  }
}
