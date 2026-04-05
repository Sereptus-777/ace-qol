// ─── ACE: QOL — Damage Calculation Engine ────────────────────────────────────
// Phase 4: Takes attack results from the combat state and calculates damage
// with full type separation, crit rules, slayer bonuses, and per-target
// resistance/immunity/vulnerability application.
//
// This replaces Midi-QOL's damage handling entirely.
// ──────────────────────────────────────────────────────────────────────────────

import { MODULE_ID } from "./ace-qol.mjs";
import { QolSettings } from "./settings.mjs";
import { DescriptionParser } from "./description-parser.mjs";
import { RiderEngine } from "./rider-engine.mjs";
import { MergeCard } from "./merge-card.mjs";

const PHYSICAL_TYPES = new Set(["bludgeoning", "piercing", "slashing"]);

export class DamageEngine {

  constructor() {
    /** Pending rider popup requests sent to players, keyed by requestId.
     *  Each entry: { resolve: Function, timeout: number } */
    this._pendingRiderRequests = {};
    this._registerHooks();
  }

  /** In-memory override cache for per-row damage multipliers.
   *  Key: `${messageId}|${tokenDocId}` → multiplier (number) or "removed" */
  static overrideCache = new Map();

  _registerHooks() {
    // Listen for our own attack completion
    Hooks.on(`${MODULE_ID}.attackComplete`, (data) => this._onAttackComplete(data));

    // ── PERSISTENT BUTTONS: Re-wire Apply/Undo on ANY damage card render ──
    // This catches both new cards AND old cards after page refresh
    Hooks.on("renderChatMessage", (message, html) => {
      const flags = message.flags?.[MODULE_ID];
      if (!flags?.type || !["damageResult", "damageButton", "postHitSave", "postHitSaveResult"].includes(flags.type)) return;

      const el = html[0] ?? html;

      // ── Hide GM-only sections for non-GM users ──
      // Players see: header, dice formulas, type totals, applied status summary
      // GM sees all of that PLUS: target rows, overrides, HP, CLEAVE, APPLY ALL, UNDO ALL
      if (!game.user.isGM) {
        // Hide all target rows (name, per-type breakdown, overrides, HP)
        const targets = el.querySelector?.(".ace-qol-dmg-targets");
        if (targets) targets.style.display = "none";
        // Hide action buttons (CLEAVE, APPLY ALL, UNDO ALL)
        const gmControls = el.querySelectorAll?.(".ace-qol-dmg-gm-controls");
        for (const ctrl of (gmControls ?? [])) {
          ctrl.style.display = "none";
        }
      }

      // ── Damage status summary — shown for ALL users after GM applies ──
      // Shows "12 slashing ✓ applied", "2 cold ✓ applied", "IMMUNE fire", etc.
      if (flags.applied && flags.damageResults?.length) {
        const existing = el.querySelector(".ace-qol-player-status");
        if (!existing) {
          const MODIFIER_LABELS = {
            immune: { text: "IMMUNE", color: "#ef5350", icon: "fa-shield" },
            resistant: { text: "RESIST", color: "#ffa726", icon: "fa-shield-halved" },
            vulnerable: { text: "VULN ×2", color: "#ab47bc", icon: "fa-burst" },
          };
          let statusHtml = '<div class="ace-qol-player-status">';
          for (const dr of flags.damageResults) {
            statusHtml += `<div class="ace-qol-player-status-target">
              <span class="ace-qol-player-status-name">${dr.name}</span>`;
            for (const c of (dr.components ?? [])) {
              const mod = MODIFIER_LABELS[c.modifier];
              if (c.modifier === "immune") {
                statusHtml += `<span class="ace-qol-player-status-line ace-qol-player-status-immune">
                  <i class="fas ${mod.icon}"></i> ${c.type} <strong>${mod.text}</strong>
                </span>`;
              } else if (mod) {
                statusHtml += `<span class="ace-qol-player-status-line" style="color:${mod.color}">
                  <i class="fas ${mod.icon}"></i> ${c.final} ${c.type} <strong>${mod.text}</strong>
                </span>`;
              } else if (c.final > 0) {
                statusHtml += `<span class="ace-qol-player-status-line ace-qol-player-status-applied">
                  <i class="fas fa-check"></i> ${c.final} ${c.type}
                </span>`;
              }
            }
            statusHtml += `</div>`;
          }
          statusHtml += '</div>';
          // Insert after the roll section (dice + type totals)
          const rollSection = el.querySelector(".ace-qol-dmg-roll-section");
          if (rollSection) {
            rollSection.insertAdjacentHTML("afterend", statusHtml);
          } else {
            const card = el.querySelector(".ace-qol-damage-card");
            if (card) card.insertAdjacentHTML("beforeend", statusHtml);
          }
        }
      }

      const applyBtn = el.querySelector?.("[data-action='aceQolApplyDamage']");
      const undoBtn = el.querySelector?.("[data-action='aceQolUndoDamage']");

      // ── Check if any per-type damage has been applied (for UNDO button state) ──
      const anyPerTypeApplied = Object.values(flags?.appliedComps ?? {}).some(arr => arr?.length > 0);

      if (applyBtn && !applyBtn.dataset.wired) {
        applyBtn.dataset.wired = "1";
        if (flags.applied) {
          applyBtn.disabled = true;
          applyBtn.textContent = "APPLIED ✓";
        } else {
          applyBtn.addEventListener("click", async () => {
            await this._applyDamage(message);
            applyBtn.disabled = true;
            applyBtn.textContent = "APPLIED ✓";
            await message.setFlag(MODULE_ID, "applied", true);
          });
        }
      }

      if (undoBtn && !undoBtn.dataset.wired) {
        undoBtn.dataset.wired = "1";
        if (!flags.applied && !anyPerTypeApplied) {
          // No damage applied yet — disabled
          undoBtn.disabled = true;
          undoBtn.style.opacity = "0.35";
          undoBtn.title = "Apply damage first";
        } else {
          // Active — damage has been applied. Build contextual label.
          undoBtn.disabled = false;
          undoBtn.style.opacity = "";
          undoBtn.title = "Undo all applied damage and reset card";

          // Dynamic label: "↩ UNDO SLASHING" for one type, "↩ UNDO ALL" for multiple
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
            await this._undoDamage(message);
            // _undoDamage resets all flags and triggers re-render — button re-wires fresh
          });
        }
      }

      // ── Per-row override buttons (×, ¼, ½, 1, 2×) ──
      this._wireOverrideButtons(el, message);

      // ── ADD TARGET button — pick a token from canvas ──
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
            await this._addTargetToCard(message, el, token, false);
          });
        });
      }

      // ── CLEAVE button — add target with overkill damage ──
      const cleaveBtn = el.querySelector?.("[data-action='aceQolCleave']");
      if (cleaveBtn && !cleaveBtn.dataset.wired) {
        cleaveBtn.dataset.wired = "1";
        cleaveBtn.addEventListener("click", () => {
          if (message.flags?.[MODULE_ID]?.applied) return;

          // Calculate overkill from first dying target
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
            await this._addTargetToCard(message, el, token, true, overkill, overkillComponents);
          });
        });
      }

      // ── PC "Roll Damage" button ──
      const rollDmgBtn = el.querySelector?.("[data-action='aceQolRollDamage']");
      if (rollDmgBtn && !rollDmgBtn.dataset.wired) {
        rollDmgBtn.dataset.wired = "1";
        // If already rolled (flag set by GM after processing), show completed state
        if (flags.rolled) {
          rollDmgBtn.disabled = true;
          rollDmgBtn.innerHTML = '<i class="fas fa-check"></i> ROLLED ✓';
        }
        rollDmgBtn.addEventListener("click", async () => {
          rollDmgBtn.disabled = true;
          rollDmgBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Rolling...';
          try {
            if (game.user.isGM) {
              // GM can roll directly
              const success = await this._rollDamageFromButton(message);
              if (success) {
                rollDmgBtn.innerHTML = '<i class="fas fa-check"></i> Rolled ✓';
              } else {
                rollDmgBtn.innerHTML = '<i class="fas fa-exclamation-triangle"></i> Failed — check console';
                rollDmgBtn.disabled = false;
                ui.notifications.error("ACE QOL: Damage roll returned early — check console (F12) for details.");
              }
            } else {
              // Player → ask GM to roll via socket
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

      // ── Post-hit "Roll Saves" button (from description parser) ──
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
              await this._rollPostHitSaves(message);
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
    });

    console.log(`${MODULE_ID} | Damage engine hooks registered`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Attack Complete → Calculate + Show Damage Card
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Called when the attack pipeline finishes resolving hits/misses.
   * For each hit target, calculates damage with type separation and crit rules.
   */
  async _onAttackComplete(data) {
    const { item, actor, results, hits, actionType: hookActionType, subject } = data;
    if (!hits?.length) return; // No hits, no damage

    // ALL attacks get a ROLL DAMAGE button — GM controls when damage applies.
    // Works for PCs, friendly NPCs, hostile NPCs — any actor the GM rolls for.
    if (true) {
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

          // Route rider popup to the owning client (player or GM)
          const selectedRiders = await this._requestRiderChoice(actor, availableRiders, riderContext);

          if (selectedRiders.length > 0) {
            // Consume resources (spell slots, ki, etc.)
            await RiderEngine.consumeResources(actor, selectedRiders);

            // Inject selected riders as bonus damage into each hit
            for (const hit of hits) {
              if (!hit.attacker) hit.attacker = { bonuses: [] };
              if (!hit.attacker.bonuses) hit.attacker.bonuses = [];
              for (const rider of selectedRiders) {
                if (rider.formula) {
                  hit.attacker.bonuses.push({
                    name: rider.name,
                    formula: rider.formula,
                    type: rider.type ?? "radiant",
                  });
                }
              }
            }

            console.log(`${MODULE_ID} | Riders applied: ${selectedRiders.map(r => `${r.name} (${r.formula})`).join(", ")}`);
          }
        }
      } catch (err) {
        console.error(`${MODULE_ID} | Rider detection/popup failed (non-blocking):`, err);
        // Non-blocking: if rider detection fails, still post the damage button
      }

      if (MergeCard.isEnabled) {
        // Merge mode: use merge card layout for the PC damage button
        await this._postMergeDamageButton(item, actor, hits);
      } else {
        await this._postDamageButton(item, actor, hits);
      }
      return;
    }

    const critRule = QolSettings.get("critRule") ?? "maxPlusRoll";

    // ── Calculate damage for each hit target ──
    const damageResults = [];
    for (const hit of hits) {
      const isCrit = hit.hitResult === "critical";
      const targetState = hit; // hit already contains full combat state

      // Roll all damage components separately by type
      let components = await this._rollDamageComponents(item, actor, targetState, isCrit, critRule);

      // ── ABSORB ELEMENTS — target reaction to halve elemental damage ──
      try {
        const reactionEng = game.aceQol?.reactionEngine;
        if (reactionEng && hit.targetActor && hit.targetToken) {
          const absorbResult = await reactionEng.checkPreDamageReactions(
            components, hit.targetActor, hit.targetToken, actor, item
          );
          if (absorbResult.absorbed) {
            components = absorbResult.modifiedComponents;
          }
        }
      } catch (err) {
        console.warn(`ace-qol | Absorb Elements check failed (non-blocking):`, err);
      }

      // Apply resistance/immunity/vulnerability to each component
      const applied = this._applyDamageModifiers(components, targetState.damageModifiers);

      // Calculate totals
      const totalRaw = applied.reduce((sum, c) => sum + c.raw, 0);
      const totalFinal = applied.reduce((sum, c) => sum + c.final, 0);

      damageResults.push({
        target: targetState.target,
        targetToken: targetState.targetToken,
        targetActor: targetState.targetActor,
        isCrit,
        components: applied,
        totalRaw,
        totalFinal,
      });
    }

    // ── Post the batch damage card (or merge card) ──
    try {
      if (MergeCard.isEnabled) {
        // Merge mode: combine attack + damage into one card
        const attackData = MergeCard.consumeAttackResult();
        await MergeCard.postMergedDamageCard(attackData, item, actor, damageResults, critRule);
      } else {
        await this._postDamageCard(item, actor, damageResults, critRule);
      }
    } catch (err) {
      console.error(`${MODULE_ID} | _postDamageCard CRASHED:`, err);
      console.error(`${MODULE_ID} | damageResults:`, JSON.stringify(damageResults, (k, v) => {
        if (v?.constructor?.name === "Token5e" || v?.constructor?.name === "Actor5e") return `[${v.constructor.name}: ${v.name}]`;
        if (v instanceof Roll) return `[Roll: ${v.formula}]`;
        return v;
      }, 2));
    }

    // ── Store for Apply button ──
    this._lastDamageResults = damageResults;
    this._lastDamageItem = item;

    // Emit hook for other modules
    Hooks.callAll(`${MODULE_ID}.damageCalculated`, { item, actor, damageResults });

    // ── Check for post-hit saves from description (Spiked Chain, Giant Slayer, etc.) ──
    await this._checkPostHitEffects(item, actor, hits, damageResults);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Ownership-based Rider Routing
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Route the rider popup to the correct client based on actor ownership.
   * - If GM owns the attacker (or no active player owner) → show popup locally on GM screen
   * - If a player owns the attacker → send rider data via socket → player sees popup → choice comes back
   * @param {Actor} actor - The attacking actor
   * @param {object[]} riders - Available riders from detectRiders()
   * @param {object} context - { attackerName, targetName, targetCreatureType, isCrit }
   * @returns {Promise<object[]>} Selected riders
   */
  async _requestRiderChoice(actor, riders, context) {
    // Find the active player who owns this actor (not GM)
    const owningPlayer = game.users.find(u =>
      !u.isGM && u.active && actor.testUserPermission(u, "OWNER")
    );

    if (!owningPlayer) {
      // GM-controlled actor (NPC, or no active player) → show popup locally
      console.log(`${MODULE_ID} | Rider popup: showing locally (GM-controlled actor)`);
      return RiderEngine.showRiderPopup(riders, context);
    }

    // Player-owned actor → route via socket
    const requestId = foundry.utils.randomID();
    console.log(`${MODULE_ID} | Rider popup: routing to player ${owningPlayer.name} (requestId=${requestId})`);

    return new Promise((resolve) => {
      // 60-second timeout — if player doesn't respond, skip riders
      const timeout = setTimeout(() => {
        delete this._pendingRiderRequests[requestId];
        console.warn(`${MODULE_ID} | Rider request ${requestId} timed out after 60s — skipping riders`);
        ui.notifications.warn(`ACE QOL: ${owningPlayer.name} didn't respond to rider popup — skipping.`);
        resolve([]);
      }, 60000);

      // Store pending request
      this._pendingRiderRequests[requestId] = { resolve, timeout };

      // Send to the owning player
      game.socket.emit(`module.${MODULE_ID}`, {
        action: "showRiderPopup",
        requestId,
        userId: owningPlayer.id,
        riders,
        context,
      });
    });
  }

  /**
   * Resolve a pending rider choice from a player's socket response.
   * Called by the socket handler in ace-qol.mjs when a riderChoice message arrives.
   * @param {string} requestId - The request ID to resolve
   * @param {object[]} selectedRiders - The riders the player chose
   */
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
  //  Roll Damage Components — Each Type Separate
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Roll each damage source separately by type.
   * Returns array of { name, formula, roll, total, type, isCritBonus }
   */
  async _rollDamageComponents(item, actor, targetState, isCrit, critRule) {
    const components = [];
    const sys = item.system ?? {};

    // Get roll data — prefer item (includes @mod) with actor fallback
    let rollData;
    try {
      rollData = item.getRollData?.() ?? actor.getRollData?.() ?? {};
    } catch (e) {
      console.warn(`${MODULE_ID} | item.getRollData() failed, falling back to actor:`, e.message);
      rollData = actor.getRollData?.() ?? {};
    }

    // ── Parse item description for conditional damage (save-gated) ──
    const parsed = DescriptionParser.parse(item);
    const conditionalDamageTypes = new Set();
    if (parsed.saves.length > 0) {
      for (const bd of parsed.bonusDamage) {
        if (bd.damageType) conditionalDamageTypes.add(bd.damageType);
      }
    }

    // ── Use the D&D 5e system's own damage formula builder ──────────
    // The system knows EVERYTHING: ability mod, magic bonus, ammo bonus,
    // scaling, proficiency — all of it. We call getDamageConfig() to get
    // the complete formula, then roll it ourselves with our crit rules.
    let usedNativeConfig = false;
    const activities = sys.activities;
    if (activities) {
      const actList = (typeof activities.forEach === "function")
        ? [...(activities.values?.() ?? activities)]
        : (typeof activities === "object" ? Object.values(activities) : []);

      for (const activity of actList) {
        if (!activity?.damage?.parts?.length) continue;
        if (typeof activity.getDamageConfig !== "function") continue;

        try {
          const dmgConfig = activity.getDamageConfig({}, { rollData });
          const rolls = dmgConfig?.rolls ?? [];

          for (let i = 0; i < rolls.length; i++) {
            const rollCfg = rolls[i];
            const parts = rollCfg.parts ?? [];
            if (!parts.length) continue;

            // Join the system's formula parts (it already includes @mod, @magicalBonus, etc.)
            const formula = parts.join(" + ");
            const type = rollCfg.options?.type ?? rollCfg.options?.types?.[0] ?? "untyped";

            // Skip conditional damage parts (gated behind a save from description)
            if (conditionalDamageTypes.has(type) && i > 0) continue;

            // Resolve @references and roll with our crit rules
            const data = rollCfg.data ?? rollData;
            const result = await this._rollWithCrit(formula, data, isCrit, critRule, `Base ${type}`);
            components.push({ name: item.name, ...result, type });
          }

          // Tag first component with modifier metadata for card labels
          if (components.length > 0 && !components[0]._modMeta) {
            const magicBonus = sys.magicalBonus ?? 0;
            // Detect ability name + mod — use the activity's resolved ability getter
            // (handles Battle Smith INT, finesse, spell CHA/INT/WIS, ranged DEX, etc.)
            let abilName = "MOD";
            let abilMod = 0;
            try {
              const str = rollData.abilities?.str?.mod ?? 0;
              const dex = rollData.abilities?.dex?.mod ?? 0;
              // activity.ability is the system's resolved getter — picks the correct
              // ability accounting for class features, finesse, spellcasting, etc.
              const resolvedAbility = activity?.ability;
              if (resolvedAbility) {
                abilName = resolvedAbility.toUpperCase();
                abilMod = rollData.abilities?.[resolvedAbility]?.mod ?? rollData.mod ?? 0;
              } else {
                // Fallback for activities without an ability getter
                const atkAbility = activity?.attack?.ability;
                if (atkAbility && atkAbility !== "none") {
                  abilName = atkAbility.toUpperCase();
                  abilMod = rollData.abilities?.[atkAbility]?.mod ?? rollData.mod ?? 0;
                } else {
                  const actionType = activity?.actionType ?? sys.actionType ?? "mwak";
                  const isFinesse = sys.properties?.has?.("fin") || sys.properties?.fin;
                  const isThrown = sys.properties?.has?.("thr") || sys.properties?.thr;
                  if (isFinesse) {
                    abilName = (dex >= str) ? "DEX" : "STR";
                    abilMod = Math.max(str, dex);
                  } else if (isThrown && actionType === "rwak") {
                    abilName = "STR"; abilMod = str;
                  } else if (["rwak", "rsak"].includes(actionType)) {
                    abilName = "DEX"; abilMod = dex;
                  } else {
                    abilName = "STR"; abilMod = str;
                  }
                }
              }
              // Final fallback: if rollData.mod is set and we got 0, use it
              if (abilMod === 0 && rollData.mod) abilMod = rollData.mod;
            } catch (_) { /* keep default */ }

            components[0]._modMeta = {
              abilityMod: abilMod,
              abilityName: abilName,
              magicBonus: magicBonus,
            };
            console.log(`${MODULE_ID} | Modifier metadata: ${abilName}=${abilMod}, MAGIC=${magicBonus}`);
          }

          usedNativeConfig = true;
        } catch (e) {
          console.warn(`${MODULE_ID} | getDamageConfig() failed for ${item.name}, falling back to manual:`, e.message);
        }

        break; // Only use first attack activity
      }
    }

    // ── Fallback: manual formula construction (legacy or getDamageConfig unavailable) ──
    if (!usedNativeConfig) {
      if (activities) {
        const actList = (typeof activities.forEach === "function")
          ? [...(activities.values?.() ?? activities)]
          : (typeof activities === "object" ? Object.values(activities) : []);

        for (const activity of actList) {
          if (!activity?.damage?.parts?.length) continue;

          for (let i = 0; i < activity.damage.parts.length; i++) {
            const part = activity.damage.parts[i];
            const partTypes = part.types ? [...part.types] : [];
            if (partTypes.some(t => conditionalDamageTypes.has(t)) && i > 0) continue;

            let formula = part.custom?.enabled
              ? part.custom.formula
              : `${part.number ?? 1}d${part.denomination ?? 8}`;

            if (part.bonus && String(part.bonus) !== "0") {
              const bonusStr = String(part.bonus);
              formula += (bonusStr.startsWith("+") || bonusStr.startsWith("-")) ? bonusStr : `+${bonusStr}`;
            }

            // First part gets ability mod + magic bonus
            if (i === 0) {
              const resolvedAbil = activity?.ability;
              const str = rollData.abilities?.str?.mod ?? 0;
              const dex = rollData.abilities?.dex?.mod ?? 0;
              const abilityMod = resolvedAbil
                ? (rollData.abilities?.[resolvedAbil]?.mod ?? rollData.mod ?? 0)
                : (rollData.mod ?? str);
              if (abilityMod !== 0) formula += abilityMod >= 0 ? `+${abilityMod}` : `${abilityMod}`;

              const magicBonus = sys.magicalBonus ?? 0;
              const partBonusNum = parseInt(part.bonus) || 0;
              if (magicBonus > 0 && partBonusNum !== magicBonus) formula += `+${magicBonus}`;
            }

            const types = part.types ? [...part.types] : ["untyped"];
            const type = types[0] ?? "untyped";
            const result = await this._rollWithCrit(formula, rollData, isCrit, critRule, `Base ${type}`);
            const comp = { name: item.name, ...result, type };

            // Tag first component with modifier metadata
            if (i === 0) {
              const resolvedAbil = activity?.ability;
              const str = rollData.abilities?.str?.mod ?? 0;
              const dex = rollData.abilities?.dex?.mod ?? 0;
              let abilMod, abilName;
              if (resolvedAbil) {
                abilName = resolvedAbil.toUpperCase();
                abilMod = rollData.abilities?.[resolvedAbil]?.mod ?? rollData.mod ?? 0;
              } else {
                const actionType = activity?.actionType ?? sys.actionType ?? "mwak";
                const isFinesse = sys.properties?.has?.("fin") || sys.properties?.fin;
                const isThrown = sys.properties?.has?.("thr") || sys.properties?.thr;
                abilMod = rollData.mod ?? (isFinesse ? Math.max(str, dex) : ["rwak","rsak"].includes(actionType) ? dex : str);
                abilName = isFinesse ? (dex >= str ? "DEX" : "STR")
                         : (isThrown && actionType === "rwak") ? "STR"
                         : ["rwak","rsak"].includes(actionType) ? "DEX" : "STR";
              }
              comp._modMeta = {
                abilityMod: abilMod,
                abilityName: abilName,
                magicBonus: sys.magicalBonus ?? 0,
              };
            }

            components.push(comp);
          }
          break;
        }
      }

      // Legacy damage.parts array (pre-activities dnd5e)
      if (!components.length && sys.damage?.parts?.length) {
        for (const [formula, type] of sys.damage.parts) {
          const result = await this._rollWithCrit(formula, rollData, isCrit, critRule, `Base ${type}`);
          components.push({ name: item.name, ...result, type: type || "untyped" });
        }
      }
    }

    // ── Ability modifier (if not already in formula) ──
    // Most dnd5e formulas already include @mod, so this is handled by rollData

    // ── Attacker bonus damage (Hex, Hunter's Mark, Rage, Sneak Attack) ──
    const bonuses = targetState.attacker?.bonuses ?? targetState.attackerBonuses ?? [];
    for (const bonus of bonuses) {
      if (!bonus.formula) continue; // Skip entries without a formula
      const result = await this._rollWithCrit(bonus.formula, rollData, isCrit, critRule, bonus.name);
      components.push({ name: bonus.name ?? "Bonus", ...result, type: bonus.type ?? components[0]?.type ?? "untyped" });
    }

    // ── Slayer bonus ──
    if (targetState.slayerMatch && targetState.slayerDamage) {
      const result = await this._rollWithCrit(targetState.slayerDamage, rollData, isCrit, critRule, "Slayer");
      components.push({
        name: `Slayer (${targetState.slayerType})`,
        ...result,
        type: components[0]?.type ?? "untyped",
      });
    }

    // ── Creature-type conditional bonus damage ──
    // Parsed from item description: "extra 1d8 radiant damage to undead", etc.
    // If the description mentions a creature type trigger and the target matches,
    // auto-roll the bonus damage. Sources (in priority order):
    //   1. bonusDamage array (separate [[/damage]] tags in description)
    //   2. Creature trigger's embedded formula (parsed from the trigger sentence itself)
    if (parsed.creatureTrigger) {
      const triggerType = parsed.creatureTrigger.creatureType?.toLowerCase();
      const targetType = targetState.creatureType?.toLowerCase() ?? "";
      const targetSubtype = targetState.creatureSubtype?.toLowerCase() ?? "";

      if (triggerType && (targetType === triggerType
          || targetType.includes(triggerType)
          || targetSubtype.includes(triggerType))) {

        let rolled = false;

        // Source 1: bonusDamage array from separate damage tags
        if (parsed.bonusDamage.length > 0) {
          for (const bd of parsed.bonusDamage) {
            if (!bd.formula) continue;
            const dmgType = bd.damageType ?? components[0]?.type ?? "untyped";
            const result = await this._rollWithCrit(bd.formula, rollData, isCrit, critRule, `vs ${triggerType}`);
            components.push({
              name: `${item.name} (vs ${triggerType})`,
              ...result,
              type: dmgType,
            });
            rolled = true;
          }
        }

        // Source 2: formula embedded in the creature trigger sentence itself
        if (!rolled && parsed.creatureTrigger.bonusFormula) {
          const dmgType = parsed.creatureTrigger.bonusType ?? components[0]?.type ?? "untyped";
          const result = await this._rollWithCrit(parsed.creatureTrigger.bonusFormula, rollData, isCrit, critRule, `vs ${triggerType}`);
          components.push({
            name: `${item.name} (vs ${triggerType})`,
            ...result,
            type: dmgType,
          });
          rolled = true;
        }

        if (rolled) {
          console.log(`${MODULE_ID} | Creature bonus: ${item.name} deals extra damage to ${triggerType} (target: ${targetType})`);
        }
      }
    }

    return components;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Roll With Crit Rules
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Roll a damage formula, applying critical hit rules if applicable.
   *
   * @param {string} formula    — base damage formula (e.g., "2d6+3")
   * @param {object} rollData   — actor roll data for @references
   * @param {boolean} isCrit    — is this a critical hit?
   * @param {string} critRule   — "doubleDice" | "maxPlusRoll" | "maxAll"
   * @param {string} label      — display label
   * @returns {{ formula, normalTotal, critTotal, total, isCrit, breakdown }}
   */
  async _rollWithCrit(formula, rollData, isCrit, critRule, label = "") {
    // Resolve @references in formula
    let resolved = formula;
    if (typeof formula === "string") {
      resolved = formula.replace(/@([a-zA-Z0-9_.]+)/g, (match, path) => {
        const val = path.split(".").reduce((o, k) => o?.[k], rollData);
        return val !== undefined ? String(val) : "0";
      });
    }

    // Roll the base damage
    const baseRoll = new Roll(resolved);
    await baseRoll.evaluate();
    await DamageEngine._showDiceAnimation(baseRoll);
    const normalTotal = baseRoll.total;

    if (!isCrit) {
      return {
        formula: resolved,
        normalTotal,
        critTotal: 0,
        total: normalTotal,
        isCrit: false,
        breakdown: `${resolved} = ${normalTotal}`,
        roll: baseRoll,
      };
    }

    // ── CRITICAL HIT DAMAGE ──
    let critTotal = 0;
    let breakdown = "";

    // Extract dice terms from the formula for crit calculations
    const diceTerms = baseRoll.terms.filter(t => t.faces); // DiceTerm instances
    const flatTerms = baseRoll.terms.filter(t => t.number !== undefined && !t.faces); // NumericTerm

    switch (critRule) {
      case "doubleDice": {
        // RAW: Roll all dice twice. Flat modifiers added once.
        // 2d6+3 → 4d6+3
        const critRoll = new Roll(resolved);
        await critRoll.evaluate();
        await DamageEngine._showDiceAnimation(critRoll);
        critTotal = critRoll.total;
        // Total = base dice + crit dice + modifiers (once)
        const diceTotal = diceTerms.reduce((sum, t) => sum + t.total, 0);
        const critDiceTotal = critRoll.terms.filter(t => t.faces).reduce((sum, t) => sum + t.total, 0);
        const flatTotal = flatTerms.reduce((sum, t) => sum + (t.number ?? 0), 0);
        const finalTotal = diceTotal + critDiceTotal + flatTotal;
        breakdown = `${resolved} (${normalTotal}) + crit dice (${critDiceTotal}) = ${finalTotal}`;
        return {
          formula: resolved, normalTotal, critTotal: critDiceTotal,
          total: finalTotal, isCrit: true, breakdown, roll: baseRoll,
        };
      }

      case "maxPlusRoll": {
        // Max normal dice + roll crit dice. Flat modifiers once.
        // 2d6+3 → max(2d6)=12 + roll(2d6) + 3
        const maxDice = diceTerms.reduce((sum, t) => sum + (t.faces * (t.number ?? 1)), 0);
        const critRoll = new Roll(resolved);
        await critRoll.evaluate();
        await DamageEngine._showDiceAnimation(critRoll);
        const critDiceOnly = critRoll.terms.filter(t => t.faces).reduce((sum, t) => sum + t.total, 0);
        const flatTotal = flatTerms.reduce((sum, t) => sum + (t.number ?? 0), 0);
        const finalTotal = maxDice + critDiceOnly + flatTotal;
        breakdown = `max dice (${maxDice}) + crit roll (${critDiceOnly}) + mods (${flatTotal}) = ${finalTotal}`;
        return {
          formula: resolved, normalTotal: maxDice, critTotal: critDiceOnly,
          total: finalTotal, isCrit: true, breakdown, roll: baseRoll,
        };
      }

      case "maxAll": {
        // Max ALL dice (normal + crit). Flat modifiers once.
        // 2d6+3 → max(2d6)=12 + max(2d6)=12 + 3 = 27
        const maxDice = diceTerms.reduce((sum, t) => sum + (t.faces * (t.number ?? 1)), 0);
        const flatTotal = flatTerms.reduce((sum, t) => sum + (t.number ?? 0), 0);
        const finalTotal = maxDice + maxDice + flatTotal;
        breakdown = `max dice (${maxDice}) + max crit (${maxDice}) + mods (${flatTotal}) = ${finalTotal}`;
        return {
          formula: resolved, normalTotal: maxDice, critTotal: maxDice,
          total: finalTotal, isCrit: true, breakdown, roll: baseRoll,
        };
      }

      default:
        return {
          formula: resolved, normalTotal, critTotal: 0,
          total: normalTotal, isCrit: false, breakdown: `${resolved} = ${normalTotal}`,
          roll: baseRoll,
        };
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Apply Resistance/Immunity/Vulnerability Per Type
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Take raw damage components and apply per-type modifiers.
   * Returns array with { name, type, raw, final, modifier, reason }
   */
  // ═══════════════════════════════════════════════════════════════════════════
  //  PC Damage Button — slim card with "ROLL DAMAGE" button
  // ═══════════════════════════════════════════════════════════════════════════

  async _postDamageButton(item, actor, hits) {
    const critRule = QolSettings.get("critRule") ?? "maxPlusRoll";
    const anyCrit = hits.some(h => h.hitResult === "critical");
    const targetNames = hits.map(h => h.name ?? h.target?.name ?? "target").join(", ");

    // ── Pre-roll damage while item still exists (Beneos/BG3 HUD deletes items after attack) ──
    DamageEngine._suppressDiceAnimation = true;
    const preRolled = [];
    try {
      for (const hit of hits) {
        const isCrit = hit.hitResult === "critical";
        let components = await this._rollDamageComponents(item, actor, hit, isCrit, critRule);

        // ── ABSORB ELEMENTS — target reaction to halve elemental damage ──
        try {
          const reactionEng = game.aceQol?.reactionEngine;
          if (reactionEng && hit.targetActor && hit.targetToken) {
            const absorbResult = await reactionEng.checkPreDamageReactions(
              components, hit.targetActor, hit.targetToken, actor, item
            );
            if (absorbResult.absorbed) {
              components = absorbResult.modifiedComponents;
            }
          }
        } catch (err) {
          console.warn(`ace-qol | Absorb Elements check failed (non-blocking):`, err);
        }

        const applied = this._applyDamageModifiers(components, hit.damageModifiers ?? {});
        const totalRaw = applied.reduce((sum, c) => sum + c.raw, 0);
        const totalFinal = applied.reduce((sum, c) => sum + c.final, 0);

        // Serialize components (Roll objects aren't JSON-serializable)
        const serializedComponents = applied.map(c => ({
          name: c.name,
          formula: c.formula,
          total: c.total ?? c.raw,
          raw: c.raw,
          final: c.final,
          modifier: c.modifier,
          reason: c.reason,
          type: c.type,
          isCrit: c.isCrit ?? false,
          normalTotal: c.normalTotal,
          _modMeta: c._modMeta ?? null,
          terms: DamageEngine._serializeRollTerms(c.roll),
        }));

        preRolled.push({
          tokenId: hit.targetToken?.id,
          tokenDocId: hit.targetToken?.document?.id ?? hit.targetToken?.id,
          actorId: hit.targetActor?.id,
          sceneId: canvas.scene?.id,
          hitResult: hit.hitResult,
          isCrit,
          name: hit.target?.name ?? hit.name,
          img: hit.target?.img ?? hit.img,
          currentHP: hit.target?.currentHP,
          maxHP: hit.target?.maxHP,
          totalRaw,
          totalFinal,
          components: serializedComponents,
          // Keep for post-hit effects
          damageModifiers: hit.damageModifiers,
        });
      }
    } finally {
      DamageEngine._suppressDiceAnimation = false;
    }

    // ── Also pre-parse item description for post-hit effects ──
    let parsedDescription = null;
    try {
      const parsed = DescriptionParser.parse(item);
      if (parsed.saves.length || parsed.effectTable || parsed.bonusDamage.length || parsed.conditions.length) {
        parsedDescription = {
          saves: parsed.saves,
          effectTable: parsed.effectTable,
          bonusDamage: parsed.bonusDamage,
          conditions: parsed.conditions,
        };
      }
    } catch (e) {
      console.warn(`${MODULE_ID} | DescriptionParser.parse failed in _postDamageButton:`, e.message);
    }

    console.log(`${MODULE_ID} | _postDamageButton: pre-rolled ${preRolled.length} targets, critRule=${critRule}`);

    const cardHtml = `
      <div class="ace-qol-dmg-btn-card">
        <button class="ace-qol-btn ace-qol-btn-roll-dmg" data-action="aceQolRollDamage">
          <i class="fas fa-burst"></i>
          ROLL DAMAGE${anyCrit ? ' <span class="ace-qol-dmg-btn-crit">CRIT!</span>' : ""}
        </button>
        <span class="ace-qol-dmg-btn-targets">→ ${targetNames}</span>
      </div>
    `;

    await ChatMessage.create({
      content: cardHtml,
      speaker: ChatMessage.getSpeaker({ actor }),
      flags: {
        [MODULE_ID]: {
          type: "damageButton",
          itemId: item.id,
          itemUuid: item.uuid,
          itemName: item.name,
          itemImg: item.img || "icons/svg/sword.svg",
          actorId: actor.id,
          critRule,
          preRolled,
          parsedDescription,
        }
      }
    });
  }

  /**
   * Post a merged attack + ROLL DAMAGE button card for PC attacks.
   * Does the same pre-rolling as _postDamageButton, but wraps the output
   * in MergeCard's combined layout that includes attack results above.
   */
  async _postMergeDamageButton(item, actor, hits) {
    const critRule = QolSettings.get("critRule") ?? "maxPlusRoll";
    const anyCrit = hits.some(h => h.hitResult === "critical");

    // ── Pre-roll damage (same as _postDamageButton) ──
    DamageEngine._suppressDiceAnimation = true;
    const preRolled = [];
    try {
      for (const hit of hits) {
        const isCrit = hit.hitResult === "critical";
        const components = await this._rollDamageComponents(item, actor, hit, isCrit, critRule);
        const applied = this._applyDamageModifiers(components, hit.damageModifiers ?? {});
        const totalRaw = applied.reduce((sum, c) => sum + c.raw, 0);
        const totalFinal = applied.reduce((sum, c) => sum + c.final, 0);

        const serializedComponents = applied.map(c => ({
          name: c.name, formula: c.formula, total: c.total ?? c.raw,
          raw: c.raw, final: c.final, modifier: c.modifier, reason: c.reason,
          type: c.type, isCrit: c.isCrit ?? false, normalTotal: c.normalTotal,
          _modMeta: c._modMeta ?? null,
          terms: DamageEngine._serializeRollTerms(c.roll),
        }));

        preRolled.push({
          tokenId: hit.targetToken?.id,
          tokenDocId: hit.targetToken?.document?.id ?? hit.targetToken?.id,
          actorId: hit.targetActor?.id,
          sceneId: canvas.scene?.id,
          hitResult: hit.hitResult, isCrit,
          name: hit.target?.name ?? hit.name,
          img: hit.target?.img ?? hit.img,
          currentHP: hit.target?.currentHP, maxHP: hit.target?.maxHP,
          totalRaw, totalFinal,
          components: serializedComponents,
          damageModifiers: hit.damageModifiers,
        });
      }
    } finally {
      DamageEngine._suppressDiceAnimation = false;
    }

    // ── Pre-parse description for post-hit effects ──
    let parsedDescription = null;
    try {
      const parsed = DescriptionParser.parse(item);
      if (parsed.saves.length || parsed.effectTable || parsed.bonusDamage.length || parsed.conditions.length) {
        parsedDescription = {
          saves: parsed.saves, effectTable: parsed.effectTable,
          bonusDamage: parsed.bonusDamage, conditions: parsed.conditions,
        };
      }
    } catch (e) {
      console.warn(`${MODULE_ID} | DescriptionParser.parse failed in _postMergeDamageButton:`, e.message);
    }

    // ── Post the merged card ──
    const attackData = MergeCard.consumeAttackResult();
    await MergeCard.postMergedDamageButton(attackData, item, actor, hits, preRolled, critRule, parsedDescription);
  }

  async _rollDamageFromButton(message) {
    const flags = message.flags?.[MODULE_ID];
    console.log(`${MODULE_ID} | _rollDamageFromButton ENTERED. flags:`, flags);

    // Don't re-roll if already rolled
    if (flags?.rolled) {
      console.log(`${MODULE_ID} | _rollDamageFromButton: already rolled, skipping`);
      return true;
    }

    // ── New path: pre-rolled results available (Beneos-safe) ──
    if (flags?.preRolled?.length) {
      const result = await this._postPreRolledDamageCard(message, flags);
      if (result) await message.setFlag(MODULE_ID, "rolled", true);
      return result;
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
      const components = await this._rollDamageComponents(item, actor, hit, isCrit, critRule);
      const applied = this._applyDamageModifiers(components, hit.damageModifiers ?? {});
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
      await this._postDamageCard(item, actor, damageResults, critRule);
    } catch (err) {
      console.error(`${MODULE_ID} | _postDamageCard (legacy) CRASHED:`, err);
      return false;
    }
    await this._checkPostHitEffects(item, actor, flags.hits, damageResults);
    return true;
  }

  /**
   * Post damage card from pre-rolled results stored in message flags.
   * This path doesn't need the original item — all data was serialized at button creation.
   */
  async _postPreRolledDamageCard(message, flags) {
    const { preRolled, critRule, itemName, itemImg, actorId, parsedDescription } = flags;
    const actor = game.actors.get(actorId);

    console.log(`${MODULE_ID} | _postPreRolledDamageCard: ${preRolled.length} pre-rolled targets`);

    // Reconstruct damageResults from serialized data
    const damageResults = preRolled.map(pr => {
      const scene = game.scenes.get(pr.sceneId) ?? canvas.scene;
      const tokenDoc = scene?.tokens?.get(pr.tokenDocId);
      const targetActor = tokenDoc?.actor ?? game.actors.get(pr.actorId);

      // Reconstruct components with fake roll.terms for dice display
      const components = pr.components.map(c => ({
        ...c,
        roll: { terms: (c.terms ?? []).map(t => {
          if (t.type === "die") return { faces: t.faces, results: t.results };
          if (t.type === "num") return { number: t.number };
          return t;
        }) },
      }));

      return {
        target: {
          name: pr.name,
          img: pr.img,
          currentHP: targetActor?.system?.attributes?.hp?.value ?? pr.currentHP,
          maxHP: pr.maxHP,
        },
        targetToken: { id: pr.tokenId, document: { id: pr.tokenDocId } },
        targetActor: targetActor ?? { id: pr.actorId },
        isCrit: pr.isCrit,
        components,
        totalRaw: pr.totalRaw,
        totalFinal: pr.totalFinal,
      };
    });

    // Build a minimal item stand-in for the card header
    const fakeItem = { name: itemName, img: itemImg, uuid: flags.itemUuid };

    // ── Fire Dice So Nice animations FIRST, then post the card ──
    // Dice roll across screen → THEN the damage results card appears
    if (game.dice3d) {
      try {
        for (const pr of preRolled) {
          for (const c of (pr.components ?? [])) {
            if (!c.terms?.length) continue;
            // Build a formula string from serialized terms
            const formulaParts = [];
            for (const t of c.terms) {
              if (t.type === "die") formulaParts.push(`${t.results.length}d${t.faces}`);
              else if (t.type === "num" && t.number > 0) formulaParts.push(`+ ${t.number}`);
              else if (t.type === "num" && t.number < 0) formulaParts.push(`- ${Math.abs(t.number)}`);
              else if (t.type === "op") formulaParts.push(t.operator);
            }
            const formula = formulaParts.join(" ") || c.formula;
            if (!formula) continue;

            const roll = new Roll(formula);
            roll._evaluated = true;
            // Inject the actual results into the roll's terms
            let termIdx = 0;
            for (const term of roll.terms) {
              if (term.faces) {
                // Find matching serialized die term
                const sTerm = c.terms.find((t, i) => t.type === "die" && i >= termIdx);
                if (sTerm) {
                  term._evaluated = true;
                  term.results = sTerm.results.map(r => ({ result: r.result, active: true }));
                  termIdx = c.terms.indexOf(sTerm) + 1;
                }
              }
            }
            roll._total = c.total ?? c.raw;

            await game.dice3d.showForRoll(roll, game.user, true);
          }
        }
      } catch (err) {
        console.warn(`${MODULE_ID} | Pre-rolled dice animation failed (non-blocking):`, err);
      }
    }

    // ── Post the damage card AFTER dice finish rolling ──
    try {
      await this._postDamageCard(fakeItem, actor, damageResults, critRule);
    } catch (err) {
      console.error(`${MODULE_ID} | _postPreRolledDamageCard CRASHED:`, err);
      return false;
    }

    // ── Post-hit effects — use pre-parsed description data if item is gone ──
    if (parsedDescription?.saves?.length) {
      // Try to find the real item for full post-hit processing
      let item = await fromUuid(flags.itemUuid).catch(() => null);
      if (!item) item = actor?.items?.get(flags.itemId);
      if (!item && itemName) item = actor?.items?.getName(itemName);

      if (item) {
        await this._checkPostHitEffects(item, actor, preRolled, damageResults);
      } else {
        console.warn(`${MODULE_ID} | Item gone, but post-hit saves detected. Save card skipped (item description unavailable).`);
      }
    }

    return true;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Post-Hit Effects — Description Parser Integration
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * After damage is dealt, check the item description for additional effects:
   *   - Saving throws (DC 14 DEX save or be grappled)
   *   - Effect tables (roll d6: 1-2 Decay, 3-4 Grapple, 5-6 Topple)
   *   - Conditions to apply
   *   - Creature-type-gated bonus damage (Giant Slayer)
   */
  async _checkPostHitEffects(item, actor, hits, damageResults) {
    if (!item) return;

    const parsed = DescriptionParser.parse(item);
    if (!parsed.saves.length && !parsed.effectTable) return;

    // Only process targets that were actually HIT
    const hitTargets = hits.filter(h => h.hitResult === "hit" || h.hitResult === "critical");
    if (!hitTargets.length) return;

    // ── Post-hit save required ──
    if (parsed.saves.length) {
      const save = parsed.saves[0]; // Primary save
      const hasTable = !!parsed.effectTable;

      // Build target info for the save card
      const targetData = hitTargets.map(h => {
        const scene = game.scenes.get(h.sceneId) ?? canvas.scene;
        const tokenDoc = scene?.tokens?.get(h.targetToken?.document?.id ?? h.tokenDocId);
        const targetActor = tokenDoc?.actor ?? game.actors.get(h.targetActor?.id ?? h.actorId);
        const token = tokenDoc?.object;

        return {
          tokenDocId: tokenDoc?.id ?? h.tokenDocId ?? h.targetToken?.document?.id,
          actorId: targetActor?.id ?? h.actorId,
          sceneId: scene?.id,
          name: h.target?.name ?? h.name,
          img: h.target?.img ?? h.img,
          targetActor,
          token,
        };
      }).filter(t => t.targetActor);

      if (!targetData.length) return;

      // Post the save prompt card
      await this._postPostHitSaveCard(item, actor, targetData, {
        save,
        effectTable: parsed.effectTable,
        bonusDamage: parsed.bonusDamage,
        conditions: parsed.conditions,
      });
    }
  }

  /**
   * Post a save card that appears AFTER the damage card for post-hit saves.
   * Shows the save requirement, the effect table if any, and a ROLL SAVE button.
   */
  async _postPostHitSaveCard(item, actor, targetData, opts) {
    const { save, effectTable, bonusDamage, conditions } = opts;
    const abilityLabel = CONFIG.DND5E?.abilities?.[save.ability]?.label ?? save.ability.toUpperCase();

    // Target rows
    const targetRows = targetData.map(t => {
      const saveData = t.targetActor?.system?.abilities?.[save.ability]?.save;
      const saveMod = typeof saveData === "number" ? saveData : (saveData?.value ?? saveData?.mod ?? 0);
      return `
        <div class="ace-qol-save-target">
          <div class="ace-qol-save-target-header">
            <img src="${t.img || "icons/svg/mystery-man.svg"}" class="ace-qol-save-target-img" />
            <span class="ace-qol-save-target-name">${t.name}</span>
            <span class="ace-qol-save-target-mod">${save.ability.toUpperCase()} +${saveMod}</span>
          </div>
        </div>
      `;
    }).join("");

    // Keep the save card CLEAN — just show DC, ability, and targets.
    // Effects/table results only appear AFTER the save is rolled.
    // No pre-showing grappled, prone, or damage before the save happens.

    const cardHtml = `
      <div class="ace-qol-save-card ace-qol-posthit-save">
        <div class="ace-qol-save-header">
          <img src="${item.img || "icons/svg/spell.svg"}" class="ace-qol-save-item-img" />
          <div>
            <strong class="ace-qol-save-item-name">${item.name} — Save Required</strong>
            <span class="ace-qol-save-dc">DC ${save.dc} ${abilityLabel} Save</span>
          </div>
        </div>
        <div class="ace-qol-save-targets">
          ${targetRows}
        </div>
        <div class="ace-qol-save-actions">
          <button class="ace-qol-btn ace-qol-btn-roll" data-action="aceQolRollPostHitSaves">
            <i class="fas fa-dice-d20"></i> ROLL SAVES
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
          type: "postHitSave",
          itemId: item.id,
          itemUuid: item.uuid,
          actorId: actor.id,
          save: { dc: save.dc, ability: save.ability },
          effectTable: effectTable,
          bonusDamage: bonusDamage,
          conditions: conditions.filter(c => c.requiresSave),
          targets: targetData.map(t => ({
            tokenDocId: t.tokenDocId,
            actorId: t.actorId,
            sceneId: t.sceneId,
            name: t.name,
            img: t.img,
          })),
        }
      }
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Apply Resistance/Immunity/Vulnerability Per Type
  // ═══════════════════════════════════════════════════════════════════════════

  _applyDamageModifiers(components, damageModifiers) {
    return components.map(c => {
      const mod = damageModifiers[c.type];
      let finalDmg = c.total;
      let modifier = "normal";
      let reason = null;

      if (mod) {
        modifier = mod.modifier;
        reason = mod.reason;

        switch (mod.modifier) {
          case "immune":
            finalDmg = 0;
            break;
          case "resistant":
            finalDmg = Math.floor(c.total / 2);
            break;
          case "vulnerable":
            finalDmg = c.total * 2;
            break;
          default:
            finalDmg = c.total;
        }
      }

      return {
        ...c,
        raw: c.total,
        final: finalDmg,
        modifier,
        reason,
      };
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Damage Card — Batch Results with Apply/Undo
  // ═══════════════════════════════════════════════════════════════════════════

  async _postDamageCard(item, actor, damageResults, critRule) {
    if (!damageResults.length) return;

    // ── Shared formula display (from first target's raw roll — same roll for all) ──
    const firstResult = damageResults[0];
    // ── Build unified component rows: dice + mods on left, type total on right ──
    // Each damage type gets its own row (e.g., "🎲7 🎲9 +5 STR  →  12 slashing")
    // IMPORTANT: Use c.final (post-resistance) for the type total — must match totalFinal.
    const formulaRows = firstResult.components.map(c => {
      const dieResults = [];
      const flatMods = [];
      const meta = c._modMeta;
      const usedLabels = new Set();

      if (c.roll?.terms) {
        for (const term of c.roll.terms) {
          if (term.faces) {
            for (const r of (term.results ?? [])) {
              const imgPath = DamageEngine.getDiceImagePath(term.faces, r.result);
              const fallbackIcon = DamageEngine.DIE_ICONS[term.faces] ?? "fa-dice";
              dieResults.push(
                `<span class="ace-qol-die">`
                + `<img class="ace-qol-die-img" src="${imgPath}" alt="d${term.faces}" onerror="this.style.display='none';this.nextElementSibling.style.display='inline'">`
                + `<i class="fas ${fallbackIcon} ace-qol-die-fallback" style="display:none"></i>`
                + `<span class="ace-qol-die-result">${r.result}</span>`
                + `</span>`
              );
            }
          } else if (term.number !== undefined && term.number !== 0) {
            const num = term.number;
            let label = "";
            if (meta) {
              if (!usedLabels.has("ability") && meta.abilityMod !== 0 && num === meta.abilityMod) {
                label = meta.abilityName;
                usedLabels.add("ability");
              } else if (!usedLabels.has("magic") && meta.magicBonus > 0 && num === meta.magicBonus) {
                label = "MAGIC";
                usedLabels.add("magic");
              }
            }
            const sign = num > 0 ? "+" : "";
            const labelClass = label === "MAGIC" ? "ace-qol-mod-label ace-qol-mod-magic" : "ace-qol-mod-label";
            const labelHtml = label
              ? `<span class="ace-qol-mod-labeled">${sign}${num} <span class="${labelClass}">${label}</span></span>`
              : `<span class="ace-qol-mod-plain">${sign}${num}</span>`;
            flatMods.push(labelHtml);
          }
        }
      }

      const dieDisplay = dieResults.join(' <span class="ace-qol-dmg-plus">+</span> ') || c.formula;
      const modDisplay = flatMods.length ? ` ${flatMods.join(" ")}` : "";
      const critDisplay = c.isCrit ? `<span class="ace-qol-dmg-crit-label">${c.normalTotal !== undefined ? `MAX ${c.normalTotal}` : "CRIT"}</span> + ` : "";

      // Right side: big bold type total (colored per damage type)
      const color = DamageEngine.DAMAGE_COLORS[c.type] ?? "#ccc";
      const typeTotal = `<span class="ace-qol-dmg-type-total" style="color:${color}"><span class="ace-qol-dmg-type-num">${c.final}</span> ${c.type}</span>`;

      return `<div class="ace-qol-dmg-component">`
        + `<div class="ace-qol-dmg-comp-left">${critDisplay}${dieDisplay}${modDisplay}</div>`
        + typeTotal
        + `</div>`;
    }).join("");

    const totalRaw = firstResult.totalRaw;

    // ── Build per-target rows ──
    const targetRows = damageResults.map(dr => this._buildTargetRowHtml({
      tokenDocId: dr.targetToken?.document?.id ?? dr.targetToken?.id,
      actorId: dr.targetActor?.id,
      sceneId: canvas.scene?.id,
      name: dr.target.name,
      img: dr.target.img,
      currentHP: dr.target.currentHP,
      maxHP: dr.target.maxHP,
      totalFinal: dr.totalFinal,
      isCrit: dr.isCrit,
      components: dr.components,
    })).join("");

    const critRuleLabel = { doubleDice: "Double Dice", maxPlusRoll: "Max + Roll", maxAll: "Max All" }[critRule] ?? critRule;
    const anyCrit = damageResults.some(dr => dr.isCrit);

    // ── Conditional button checks ──
    const hasCleave = actor ? DamageEngine._actorHasCleave(actor) : false;

    const cardHtml = `
      <div class="ace-qol-damage-card">
        <div class="ace-qol-dmg-header">
          <img src="${item.img || "icons/svg/sword.svg"}" class="ace-qol-dmg-item-img" />
          <strong class="ace-qol-dmg-item-name">${item.name} — Damage</strong>
          ${anyCrit ? `<span class="ace-qol-dmg-crit-rule">${critRuleLabel}</span>` : ""}
        </div>
        <div class="ace-qol-dmg-roll-section">
          <div class="ace-qol-dmg-components">${formulaRows}</div>
        </div>
        <div class="ace-qol-dmg-targets">
          ${targetRows}
        </div>
        <div class="ace-qol-dmg-gm-controls">
          <div class="ace-qol-dmg-actions">
            ${hasCleave ? `<button class="ace-qol-btn ace-qol-btn-cleave" data-action="aceQolCleave">
              <i class="fas fa-khanda"></i> CLEAVE
            </button>` : ""}
            <button class="ace-qol-btn ace-qol-btn-apply" data-action="aceQolApplyDamage">
              <i class="fas fa-heart-crack"></i> APPLY ALL
            </button>
            <button class="ace-qol-btn ace-qol-btn-undo" data-action="aceQolUndoDamage" disabled>
              <i class="fas fa-undo"></i> UNDO ALL
            </button>
          </div>
        </div>
      </div>
    `;

    // Store raw components for ADD TARGET re-calculation
    const rawComponents = firstResult.components.map(c => ({
      name: c.name, type: c.type, raw: c.raw, formula: c.formula,
    }));

    await ChatMessage.create({
      content: cardHtml,
      speaker: ChatMessage.getSpeaker({ actor }),
      flags: {
        [MODULE_ID]: {
          type: "damageResult",
          itemUuid: item.uuid,
          actorId: actor.id,
          rawComponents,
          totalRaw,
          damageResults: damageResults.map(dr => ({
            targetId: dr.targetActor.id,
            tokenId: dr.targetToken.id,
            tokenDocId: dr.targetToken.document?.id ?? dr.targetToken.id,
            sceneId: canvas.scene?.id,
            isLinked: dr.targetActor.prototypeToken?.actorLink ?? dr.targetToken.document?.actorLink ?? false,
            totalFinal: dr.totalFinal,
            currentHP: dr.target.currentHP,
            maxHP: dr.target.maxHP,
            name: dr.target.name,
            img: dr.target.img,
            components: dr.components.map(c => ({ name: c.name, type: c.type, raw: c.raw, final: c.final, modifier: c.modifier })),
          })),
        }
      }
    });

    // Buttons are wired by the persistent renderChatMessage hook in _registerHooks
  }

  /**
   * Resolve the correct actor for a damage entry.
   * For unlinked tokens, we need the token's synthetic actor, not the base world actor.
   */
  _resolveTargetActor(entry) {
    // Try to find the token on the current scene
    const scene = game.scenes.get(entry.sceneId) ?? canvas.scene;
    if (scene) {
      const tokenDoc = scene.tokens?.get(entry.tokenDocId);
      if (tokenDoc?.actor) return tokenDoc.actor;
    }

    // Try canvas token
    const canvasToken = canvas.tokens?.get(entry.tokenDocId);
    if (canvasToken?.actor) return canvasToken.actor;

    // Fallback to world actor (works for linked tokens)
    return game.actors.get(entry.targetId);
  }

  /**
   * Apply damage to all targets from a damage card.
   */
  async _applyDamage(message) {
    const flags = message.flags?.[MODULE_ID];
    const data = flags?.damageResults;
    if (!data?.length) return;

    let applied = 0;
    for (const entry of data) {
      const cacheKey = `${message.id}|${entry.tokenDocId}`;
      const cachedValue = DamageEngine.overrideCache.get(cacheKey);

      // Skip removed targets
      if (cachedValue === "removed") {
        DamageEngine.overrideCache.delete(cacheKey);
        continue;
      }

      const actor = this._resolveTargetActor(entry);
      if (!actor) {
        console.warn(`${MODULE_ID} | Could not find actor for token ${entry.tokenDocId}`);
        continue;
      }

      // ── Component-level APPLY ALL ──
      // Only sum components that haven't been individually applied (greyed out).
      // This correctly handles the case where a per-type click used a different
      // override multiplier (e.g., ½ slashing applied, then APPLY ALL for remaining cold).
      const appliedComps = flags?.appliedComps?.[entry.tokenDocId] ?? [];
      const override = (typeof cachedValue === "number") ? cachedValue : 1;
      let damageToApply = 0;
      const components = entry.components ?? [];

      for (let i = 0; i < components.length; i++) {
        if (appliedComps.includes(i)) {
          console.log(`${MODULE_ID} | APPLY ALL: skipping comp ${i} (${components[i].type}) — already applied individually`);
          continue;
        }
        const compDmg = Math.floor(components[i].final * override);
        damageToApply += compDmg;
        console.log(`${MODULE_ID} | APPLY ALL: comp ${i} (${components[i].final} ${components[i].type} × ${override}) = ${compDmg}`);
      }

      console.log(`${MODULE_ID} | APPLY ALL total for ${entry.name}: ${damageToApply} (override=${override}, ${appliedComps.length} comps already applied)`);

      if (damageToApply <= 0) {
        console.log(`${MODULE_ID} | Skipping ${entry.name} — all components already applied`);
        DamageEngine.overrideCache.delete(cacheKey);
        applied++;
        continue;
      }

      const currentHP = actor.system.attributes.hp.value;
      const newHP = Math.max(0, currentHP - damageToApply);

      await actor.update({ "system.attributes.hp.value": newHP });
      console.log(`${MODULE_ID} | Applied ${damageToApply} damage to ${entry.name}: ${currentHP} → ${newHP}`);

      // Track what APPLY ALL applied: mark all remaining comps as applied in flags
      const allIndices = components.map((_, i) => i);
      const prevPerType = flags?.perTypeApplied?.[entry.tokenDocId] ?? 0;
      const perCompUpdate = {};
      for (let i = 0; i < components.length; i++) {
        if (appliedComps.includes(i)) continue; // already tracked from per-type click
        const compDmg = Math.floor(components[i].final * override);
        perCompUpdate[`flags.${MODULE_ID}.perCompApplied.${entry.tokenDocId}.${i}`] = compDmg;
      }
      await message.update({
        [`flags.${MODULE_ID}.appliedComps.${entry.tokenDocId}`]: allIndices,
        [`flags.${MODULE_ID}.perTypeApplied.${entry.tokenDocId}`]: prevPerType + damageToApply,
        ...perCompUpdate,
      });

      DamageEngine.overrideCache.delete(cacheKey);
      applied++;
    }

    ui.notifications.info(`ACE QOL: Damage applied to ${applied} target(s).`);
  }

  /**
   * Undo damage — restore HP to pre-damage values.
   */
  async _undoDamage(message) {
    const data = message.getFlag(MODULE_ID, "damageResults");
    if (!data?.length) return;

    let undoneCount = 0;
    for (const entry of data) {
      const actor = this._resolveTargetActor(entry);
      if (!actor) {
        console.warn(`${MODULE_ID} | Could not find actor for undo on token ${entry.tokenDocId}`);
        continue;
      }

      // Restore HP to what it was before this damage card's damage was applied
      const restoredHP = Math.min(entry.currentHP, actor.system.attributes.hp.max);
      await actor.update({ "system.attributes.hp.value": restoredHP });
      console.log(`${MODULE_ID} | Undid damage on ${actor.name}: ${actor.system.attributes.hp.value} → restored to ${restoredHP}`);
      undoneCount++;
    }

    // Clear ALL tracking flags so the card returns to completely fresh state
    await message.update({
      [`flags.${MODULE_ID}.perTypeApplied`]: {},
      [`flags.${MODULE_ID}.appliedComps`]: {},
      [`flags.${MODULE_ID}.perCompApplied`]: {},
      [`flags.${MODULE_ID}.applied`]: false,
    });

    if (undoneCount) ui.notifications.info(`ACE QOL: Damage undone for ${undoneCount} target(s). Card reset — you can re-apply.`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Damage Type Colors
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Show dice rolling animation on screen.
   * Uses Dice So Nice (game.dice3d) if available, otherwise no-op.
   */
  /**
   * Check if an actor has a cleave-type ability (Great Weapon Master, Cleaving Attack, etc.)
   */
  static _actorHasCleave(actor) {
    if (!actor?.items) return false;
    for (const item of actor.items) {
      const name = item.name?.toLowerCase() ?? "";
      if (name.includes("great weapon master") || name.includes("cleave") || name.includes("cleaving")) return true;
    }
    return false;
  }

  static _suppressDiceAnimation = false;

  static async _showDiceAnimation(roll) {
    if (!roll || DamageEngine._suppressDiceAnimation) return;
    try {
      if (game.dice3d) {
        await game.dice3d.showForRoll(roll, game.user, true);
      }
    } catch (err) {
      console.warn(`${MODULE_ID} | Dice animation failed:`, err.message);
    }
  }

  /**
   * Serialize Roll terms for flag storage (Roll objects aren't serializable).
   * Preserves dice faces+results and flat numbers for card display reconstruction.
   */
  static _serializeRollTerms(roll) {
    if (!roll?.terms) return [];
    return roll.terms.map(t => {
      if (t.faces) return { type: "die", faces: t.faces, results: (t.results ?? []).map(r => ({ result: r.result })) };
      if (t.number !== undefined && !t.faces) return { type: "num", number: t.number };
      if (t.operator) return { type: "op", operator: t.operator };
      return null;
    }).filter(Boolean);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Post-Hit Save Rolling (from Description Parser)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * When GM clicks ROLL SAVES on a post-hit save card:
   * 1. Roll the save for each target
   * 2. If failed and there's an effect table, roll the table
   * 3. Apply conditions and/or bonus damage from the result
   * 4. Post results card
   */
  async _rollPostHitSaves(message) {
    const flags = message.flags?.[MODULE_ID];
    if (!flags) return;

    const { save, effectTable, bonusDamage, conditions, targets, itemId, itemUuid, actorId } = flags;
    const item = await fromUuid(itemUuid) ?? game.items.get(itemId);
    const casterActor = game.actors.get(actorId);

    const results = [];

    for (const tgt of targets) {
      const scene = game.scenes.get(tgt.sceneId) ?? canvas.scene;
      const tokenDoc = scene?.tokens?.get(tgt.tokenDocId);
      const targetActor = tokenDoc?.actor ?? game.actors.get(tgt.actorId);
      if (!targetActor) continue;

      // Check for auto-fail conditions
      const statuses = targetActor.statuses ?? new Set();
      const isAutoFail = (save.ability === "str" || save.ability === "dex")
        && (statuses.has("paralyzed") || statuses.has("stunned") || statuses.has("unconscious"));

      let saveTotal = 0;
      let passed = false;
      let saveRoll = null;

      if (isAutoFail) {
        saveTotal = 0;
        passed = false;
      } else {
        // Check advantage/disadvantage on save
        const hasAdvantage = targetActor.flags?.["midi-qol"]?.advantage?.save?.[save.ability]
          || (statuses.has("magic-resistance") && item?.type === "spell");
        const hasDisadvantage = (save.ability === "dex" && statuses.has("restrained"));

        let rollMode = "normal";
        if (hasAdvantage && !hasDisadvantage) rollMode = "advantage";
        else if (hasDisadvantage && !hasAdvantage) rollMode = "disadvantage";

        const saveRaw = targetActor.system?.abilities?.[save.ability]?.save;
        const saveMod = typeof saveRaw === "number" ? saveRaw : (saveRaw?.value ?? saveRaw?.mod ?? 0);
        const formula = rollMode === "advantage" ? `2d20kh + ${saveMod}`
                      : rollMode === "disadvantage" ? `2d20kl + ${saveMod}`
                      : `1d20 + ${saveMod}`;

        saveRoll = new Roll(formula);
        await saveRoll.evaluate();

        // Show dice animation
        try { if (game.dice3d) await game.dice3d.showForRoll(saveRoll, game.user, true); } catch {}

        saveTotal = saveRoll.total;
        passed = saveTotal >= save.dc;
      }

      // ── Determine outcome ──
      const result = {
        name: tgt.name,
        img: tgt.img,
        tokenDocId: tgt.tokenDocId,
        actorId: tgt.actorId,
        sceneId: tgt.sceneId,
        saveTotal,
        passed,
        isAutoFail,
        saveRoll,
        effects: [], // What happens to this target
      };

      if (!passed) {
        // ── Failed save — check for effect table ──
        if (effectTable) {
          const tableRoll = new Roll(effectTable.die === "d6" ? "1d6" : `1${effectTable.die}`);
          await tableRoll.evaluate();
          try { if (game.dice3d) await game.dice3d.showForRoll(tableRoll, game.user, true); } catch {}

          const tableResult = tableRoll.total;
          result.tableRoll = tableResult;
          result.tableDie = effectTable.die;

          console.log(`${MODULE_ID} | POST-HIT TABLE: ${tgt.name} failed save → rolled ${effectTable.die} = ${tableResult}`);
          console.log(`${MODULE_ID} | POST-HIT TABLE: entries:`, effectTable.entries.map(e => `[${e.range[0]}-${e.range[1]}] ${e.name}`).join(", "));

          // Find matching entry
          const matchedEntry = effectTable.entries.find(e =>
            tableResult >= e.range[0] && tableResult <= e.range[1]
          );

          console.log(`${MODULE_ID} | POST-HIT TABLE: matched entry:`, matchedEntry ? `"${matchedEntry.name}" with ${matchedEntry.effects?.length ?? 0} effects` : "NO MATCH");

          if (matchedEntry) {
            result.tableEntry = matchedEntry.name;
            result.tableDesc = matchedEntry.description;

            // Apply effects from this entry ONLY
            const autoApply = QolSettings.get("autoApplyConditions") ?? true;
            console.log(`${MODULE_ID} | POST-HIT TABLE: applying ${matchedEntry.effects?.length ?? 0} effects from "${matchedEntry.name}" (autoApply=${autoApply})`);
            const condImmunities = new Set((targetActor.system?.traits?.ci?.value ?? []).map(s => s.toLowerCase()));
            for (const fx of matchedEntry.effects) {
              console.log(`${MODULE_ID} | POST-HIT TABLE: effect:`, fx);
              if (fx.type === "condition") {
                const condKey = (fx.condition ?? "").toLowerCase();
                if (condImmunities.has(condKey)) {
                  result.effects.push({ type: "condition", condition: fx.condition, blocked: true, reason: `Immune to ${fx.condition}` });
                  console.log(`${MODULE_ID} | POST-HIT TABLE: ${tgt.name} IMMUNE to "${fx.condition}" — skipped`);
                } else {
                  result.effects.push({ type: "condition", condition: fx.condition });
                  if (autoApply) {
                    try {
                      await tokenDoc?.actor?.toggleStatusEffect?.(fx.condition, { active: true });
                      console.log(`${MODULE_ID} | POST-HIT TABLE: applied condition "${fx.condition}" to ${tgt.name}`);
                    } catch (err) {
                      console.warn(`${MODULE_ID} | Could not apply ${fx.condition}:`, err);
                    }
                  }
                }
              } else if (fx.type === "damage") {
                const dmgRoll = new Roll(fx.formula);
                await dmgRoll.evaluate();
                try { if (game.dice3d) await game.dice3d.showForRoll(dmgRoll, game.user, true); } catch {}

                // ── Check target resistance/immunity/vulnerability for this damage type ──
                const rawTotal = dmgRoll.total;
                let finalTotal = rawTotal;
                let dmgModifier = "normal";
                let dmgModReason = null;
                const tgtTraits = targetActor.system?.traits ?? {};
                const resistSet = new Set((tgtTraits.dr?.value ?? []).map(s => s.toLowerCase()));
                const immuneSet = new Set((tgtTraits.di?.value ?? []).map(s => s.toLowerCase()));
                const vulnSet = new Set((tgtTraits.dv?.value ?? []).map(s => s.toLowerCase()));
                const drBypasses = new Set(tgtTraits.dr?.bypasses ?? []);
                const diBypasses = new Set(tgtTraits.di?.bypasses ?? []);
                const dmgType = (fx.damageType ?? "").toLowerCase();

                // Determine weapon properties for bypass checks
                const riderItemProps = new Set(item?.system?.properties ?? []);
                const riderIsMagical = riderItemProps.has("mgc") || !!item?.system?.magicAvailable;
                const riderIsSilvered = riderItemProps.has("sil");
                const riderIsAdamantine = riderItemProps.has("ada");

                if (immuneSet.has(dmgType)) {
                  // Check if physical damage immunity is bypassed
                  if (PHYSICAL_TYPES.has(dmgType) && diBypasses.size > 0) {
                    const bypassed = (diBypasses.has("mgc") && riderIsMagical)
                                  || (diBypasses.has("sil") && riderIsSilvered)
                                  || (diBypasses.has("ada") && riderIsAdamantine);
                    if (!bypassed) {
                      finalTotal = 0;
                      dmgModifier = "immune";
                      dmgModReason = `Immune to ${dmgType}`;
                    }
                    // else: bypassed — stays normal
                  } else {
                    finalTotal = 0;
                    dmgModifier = "immune";
                    dmgModReason = `Immune to ${dmgType}`;
                  }
                } else if (resistSet.has(dmgType)) {
                  // Check if physical damage resistance is bypassed
                  if (PHYSICAL_TYPES.has(dmgType) && drBypasses.size > 0) {
                    const bypassed = (drBypasses.has("mgc") && riderIsMagical)
                                  || (drBypasses.has("sil") && riderIsSilvered)
                                  || (drBypasses.has("ada") && riderIsAdamantine);
                    if (!bypassed) {
                      finalTotal = Math.floor(rawTotal / 2);
                      dmgModifier = "resistant";
                      dmgModReason = `Resists ${dmgType} (half damage)`;
                    }
                    // else: bypassed — stays normal
                  } else {
                    finalTotal = Math.floor(rawTotal / 2);
                    dmgModifier = "resistant";
                    dmgModReason = `Resists ${dmgType} (half damage)`;
                  }
                } else if (vulnSet.has(dmgType)) {
                  finalTotal = rawTotal * 2;
                  dmgModifier = "vulnerable";
                  dmgModReason = `VULNERABLE to ${dmgType} (double damage)`;
                }

                result.effects.push({
                  type: "damage",
                  formula: fx.formula,
                  damageType: fx.damageType,
                  raw: rawTotal,
                  total: finalTotal,
                  roll: dmgRoll,
                  modifier: dmgModifier,
                  reason: dmgModReason,
                });
                console.log(`${MODULE_ID} | POST-HIT TABLE: rolled ${fx.formula} ${fx.damageType} = ${rawTotal}${dmgModifier !== "normal" ? ` → ${finalTotal} (${dmgModifier})` : ""} on ${tgt.name}`);
              }
            }
          }
        } else if (!effectTable) {
          // No table AND no table at all — apply fail conditions directly
          // (Only for simple save-or-condition items like Giant Slayer)
          const autoApply = QolSettings.get("autoApplyConditions") ?? true;
          const condImmunities = new Set((targetActor.system?.traits?.ci?.value ?? []).map(s => s.toLowerCase()));
          for (const cond of (conditions ?? [])) {
            const condKey = (cond.condition ?? "").toLowerCase();
            if (condImmunities.has(condKey)) {
              result.effects.push({ type: "condition", condition: cond.condition, blocked: true, reason: `Immune to ${cond.condition}` });
              console.log(`${MODULE_ID} | ${tgt.name} is IMMUNE to ${cond.condition} — skipped`);
            } else {
              result.effects.push({ type: "condition", condition: cond.condition });
              if (autoApply) {
                try {
                  await tokenDoc?.actor?.toggleStatusEffect?.(cond.condition, { active: true });
                } catch (err) {
                  console.warn(`${MODULE_ID} | Could not apply ${cond.condition}:`, err);
                }
              }
            }
          }
        }
      }

      results.push(result);
    }

    // Post results card
    await this._postPostHitSaveResults(item, casterActor, results, save);
  }

  /**
   * Post the results card showing save outcomes, table rolls, and applied effects.
   */
  async _postPostHitSaveResults(item, actor, results, save) {
    const abilityLabel = CONFIG.DND5E?.abilities?.[save.ability]?.label ?? save.ability.toUpperCase();

    // Check if any result has damage to apply
    const hasDamage = results.some(r => r.effects.some(fx => fx.type === "damage"));

    const rows = results.map(r => {
      const passClass = r.passed ? "ace-qol-save-pass" : "ace-qol-save-fail";
      const resultLabel = r.isAutoFail ? "AUTO-FAIL" : r.passed ? "PASS" : "FAIL";
      const rollDisplay = r.isAutoFail ? "—" : r.saveTotal;

      // Effects summary
      let effectsHtml = "";
      if (r.tableEntry) {
        effectsHtml += `<div class="ace-qol-table-result">
          <i class="fas fa-dice-d6"></i> Rolled <strong>${r.tableRoll}</strong>: <strong>${r.tableEntry}</strong>
        </div>`;
      }

      for (const fx of r.effects) {
        if (fx.type === "condition") {
          effectsHtml += `<span class="ace-qol-tag ace-qol-tag-debuff"><i class="fas fa-circle-xmark"></i> ${fx.condition.toUpperCase()} applied</span> `;
        } else if (fx.type === "damage") {
          const color = DamageEngine.DAMAGE_COLORS[fx.damageType] ?? "#ccc";
          const modBadge = fx.modifier === "immune" ? '<span class="ace-qol-dmg-mod ace-qol-dmg-immune">IMMUNE</span>'
                         : fx.modifier === "resistant" ? '<span class="ace-qol-dmg-mod ace-qol-dmg-resist">½ RESIST</span>'
                         : fx.modifier === "vulnerable" ? '<span class="ace-qol-dmg-mod ace-qol-dmg-vuln">×2 VULN</span>'
                         : "";
          let displayTotal;
          if (fx.modifier === "immune") {
            displayTotal = `<span style="text-decoration: line-through; text-decoration-color: #ff1744; color: #ccc;">${fx.raw}</span> <strong style="color: #ff1744;">0</strong>`;
          } else if (fx.modifier !== "normal") {
            displayTotal = `<span style="text-decoration: line-through; text-decoration-color: #ff9100; color: #ccc;">${fx.raw}</span> <strong>${fx.total}</strong>`;
          } else {
            displayTotal = `${fx.total}`;
          }
          // Build dice display for post-hit save damage
          let fxDieDisplay = fx.formula;
          if (fx.roll?.terms) {
            const fxDice = [];
            for (const fxTerm of fx.roll.terms) {
              if (fxTerm.faces) {
                for (const fxR of (fxTerm.results ?? [])) {
                  const fxImgPath = DamageEngine.getDiceImagePath(fxTerm.faces, fxR.result);
                  const fxFallback = DamageEngine.DIE_ICONS[fxTerm.faces] ?? "fa-dice";
                  fxDice.push(
                    `<span class="ace-qol-die">`
                    + `<img class="ace-qol-die-img" src="${fxImgPath}" alt="d${fxTerm.faces}" onerror="this.style.display='none';this.nextElementSibling.style.display='inline'">`
                    + `<i class="fas ${fxFallback} ace-qol-die-fallback" style="display:none"></i>`
                    + `<span class="ace-qol-die-result">${fxR.result}</span>`
                    + `</span>`
                  );
                }
              }
            }
            if (fxDice.length) fxDieDisplay = fxDice.join(' <span class="ace-qol-dmg-plus">+</span> ');
          }
          effectsHtml += `<div class="ace-qol-dmg-component" style="padding-left: 0;">
            ${fxDieDisplay}
            <span class="ace-qol-dmg-equals">=</span>
            <span class="ace-qol-dmg-value" style="color:${color}">${displayTotal} ${fx.damageType}</span>
            ${modBadge}
          </div>`;
        }
      }

      // HP line for targets that took damage
      const dmgEffects = r.effects.filter(fx => fx.type === "damage");
      const totalDamage = dmgEffects.reduce((sum, fx) => sum + fx.total, 0);
      let hpHtml = "";
      if (totalDamage > 0) {
        // Resolve current HP
        const scene = game.scenes.get(r.sceneId) ?? canvas.scene;
        const tokenDoc = scene?.tokens?.get(r.tokenDocId);
        const targetActor = tokenDoc?.actor ?? game.actors.get(r.actorId);
        const currentHP = targetActor?.system?.attributes?.hp?.value ?? 0;
        const maxHP = targetActor?.system?.attributes?.hp?.max ?? 0;
        const newHP = Math.max(0, currentHP - totalDamage);
        const isDead = newHP <= 0;
        r._currentHP = currentHP;
        r._maxHP = maxHP;
        r._totalDamage = totalDamage;
        hpHtml = `<div class="ace-qol-dmg-hp">HP: ${currentHP} → ${newHP}/${maxHP}${isDead ? " ☠" : ""}</div>`;
      }

      return `
        <div class="ace-qol-save-result-row">
          <div class="ace-qol-save-result-target">
            <img src="${r.img || "icons/svg/mystery-man.svg"}" class="ace-qol-save-target-img" />
            <span class="ace-qol-save-target-name">${r.name}</span>
            <span class="ace-qol-save-roll ${passClass}">${rollDisplay}</span>
            <span class="ace-qol-save-result-label ${passClass}">${resultLabel}</span>
          </div>
          ${effectsHtml ? `<div class="ace-qol-posthit-effects">${effectsHtml}</div>` : ""}
          ${hpHtml}
        </div>
      `;
    }).join("");

    // Build Apply/Undo buttons only if there's damage to apply
    const actionsHtml = hasDamage ? `
      <div class="ace-qol-dmg-actions">
        <button class="ace-qol-btn ace-qol-btn-apply" data-action="aceQolApplyDamage">
          <i class="fas fa-heart-crack"></i> Apply Damage
        </button>
        <button class="ace-qol-btn ace-qol-btn-undo" data-action="aceQolUndoDamage">
          <i class="fas fa-undo"></i> Undo
        </button>
      </div>` : "";

    const cardHtml = `
      <div class="ace-qol-save-results-card ace-qol-posthit-results">
        <div class="ace-qol-save-header">
          <img src="${item?.img || "icons/svg/spell.svg"}" class="ace-qol-save-item-img" />
          <div>
            <strong class="ace-qol-save-item-name">${item?.name ?? "Unknown"} — Save Results</strong>
            <span class="ace-qol-save-dc">DC ${save.dc} ${abilityLabel}</span>
          </div>
        </div>
        <div class="ace-qol-save-results">
          ${rows}
        </div>
        ${actionsHtml}
      </div>
    `;

    // Build damage results for Apply/Undo flags (only targets with damage)
    const damageResults = results
      .filter(r => r._totalDamage > 0)
      .map(r => ({
        targetId: r.actorId,
        tokenDocId: r.tokenDocId,
        sceneId: r.sceneId,
        totalFinal: r._totalDamage,
        currentHP: r._currentHP,
      }));

    await ChatMessage.create({
      content: cardHtml,
      speaker: ChatMessage.getSpeaker({ actor }),
      flags: {
        [MODULE_ID]: {
          type: "postHitSaveResult",
          ...(damageResults.length ? { damageResults } : {}),
        }
      },
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Row-Based Multi-Target Helpers
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Build HTML for a single target row in the damage card.
   * Normalized input — works for both initial render and dynamic ADD/CLEAVE.
   */
  _buildTargetRowHtml({ tokenDocId, actorId, sceneId, name, img, currentHP, maxHP, totalFinal, isCrit, components }) {
    const tDocId = tokenDocId ?? "unknown";
    const portrait = img || "icons/svg/mystery-man.svg";
    const newHP = Math.max(0, currentHP - totalFinal);
    const isDead = newHP <= 0;

    // Per-component type breakdown lines (each damage type gets its own line)
    const compLines = (components ?? []).map((c, idx) => {
      const color = DamageEngine.DAMAGE_COLORS[c.type] ?? "#ccc";
      let modBadge = "";
      let strikeStyle = "";
      if (c.modifier === "immune") {
        modBadge = `<span class="ace-qol-dmg-mod ace-qol-dmg-immune" style="background:${color}; color:#000">IMMUNE</span>`;
        strikeStyle = `text-decoration: line-through; text-decoration-color: ${color}; opacity: 0.6;`;
      } else if (c.modifier === "resistant") {
        modBadge = `<span class="ace-qol-dmg-mod ace-qol-dmg-resist" style="border-color:${color}; color:${color}">½ RESIST</span>`;
      } else if (c.modifier === "vulnerable") {
        modBadge = `<span class="ace-qol-dmg-mod ace-qol-dmg-vuln">×2 VULN</span>`;
      }
      // Show raw→final if modified, otherwise just final
      const dmgDisplay = (c.raw !== c.final && c.modifier !== "normal")
        ? `<span style="color:#666; text-decoration:line-through; font-size:0.75rem">${c.raw}</span> <strong style="color:${color}">${c.final}</strong>`
        : `<strong style="color:${color}">${c.final}</strong>`;
      const clickable = c.final > 0 ? `data-action="aceQolApplyType" data-damage-type="${c.type}" data-damage-amount="${c.final}" data-comp-index="${idx}" title="Click to apply ${c.final} ${c.type} damage"` : "";
      const clickClass = c.final > 0 ? " ace-qol-dmg-type-clickable" : "";
      return `
        <div class="ace-qol-dmg-type-line${clickClass}" ${clickable} style="${strikeStyle}">
          ${dmgDisplay} <span style="color:${color}; font-weight:600">${c.type}</span> ${modBadge}
        </div>
      `;
    }).join("");

    const _a = (mult) => (mult === 1) ? " ace-qol-dmg-ovr-active" : "";

    return `
      <div class="ace-qol-dmg-target-row" data-token-doc-id="${tDocId}" data-actor-id="${actorId ?? ""}" data-scene-id="${sceneId ?? ""}">
        <div class="ace-qol-dmg-row-header">
          <img src="${portrait}" class="ace-qol-dmg-tgt-img" />
          <span class="ace-qol-dmg-tgt-name">${name ?? "Unknown"}</span>
          ${isCrit ? '<span class="ace-qol-dmg-crit-badge">CRIT</span>' : ""}
        </div>
        ${compLines ? `<div class="ace-qol-dmg-type-breakdown">${compLines}</div>` : ""}
        <div class="ace-qol-dmg-gm-controls">
          <div class="ace-qol-dmg-hp-line">
            <span class="ace-qol-dmg-row-dmg">${totalFinal}</span>
            ${isDead ? '<span class="ace-qol-dmg-skull">☠</span>' : ''}
            <span class="ace-qol-dmg-row-hp">HP: <span class="ace-qol-hp-cur">${currentHP}</span> → <span class="ace-qol-hp-new${isDead ? ' ace-qol-hp-dead' : ''}">${newHP}</span><span class="ace-qol-hp-max">/${maxHP}</span></span>
          </div>
          <div class="ace-qol-dmg-ovr-line">
            <button class="ace-qol-dmg-ovr-x" data-action="aceQolDmgRemove" data-token-doc-id="${tDocId}">×</button>
            <button class="ace-qol-dmg-ovr${_a(0.25)}" data-action="aceQolDmgOverride" data-token-doc-id="${tDocId}" data-multiplier="0.25">¼</button>
            <button class="ace-qol-dmg-ovr${_a(0.5)}" data-action="aceQolDmgOverride" data-token-doc-id="${tDocId}" data-multiplier="0.5">½</button>
            <button class="ace-qol-dmg-ovr${_a(1)}" data-action="aceQolDmgOverride" data-token-doc-id="${tDocId}" data-multiplier="1">1</button>
            <button class="ace-qol-dmg-ovr${_a(2)}" data-action="aceQolDmgOverride" data-token-doc-id="${tDocId}" data-multiplier="2">2</button>
          </div>
        </div>
      </div>
    `;
  }

  /**
   * Wire per-row override and remove buttons on a damage card.
   * Safe to call multiple times — skips already-wired buttons.
   */
  _wireOverrideButtons(el, message) {
    // Override multiplier buttons (¼, ½, 1, 2×)
    const overrideBtns = el.querySelectorAll?.("[data-action='aceQolDmgOverride']");
    for (const btn of (overrideBtns ?? [])) {
      if (btn.dataset.wired) continue;
      btn.dataset.wired = "1";

      // ── Restore visual state from in-memory cache (survives re-render) ──
      const tokenDocId = btn.dataset.tokenDocId;
      const multiplier = parseFloat(btn.dataset.multiplier);
      const cacheKey = `${message.id}|${tokenDocId}`;
      const cached = DamageEngine.overrideCache.get(cacheKey);
      if (typeof cached === "number" && cached === multiplier) {
        const ovrLine = btn.closest(".ace-qol-dmg-ovr-line");
        if (ovrLine) {
          ovrLine.querySelectorAll(".ace-qol-dmg-ovr").forEach(b => b.classList.remove("ace-qol-dmg-ovr-active"));
          btn.classList.add("ace-qol-dmg-ovr-active");
        }
        // Also update the damage/HP display to match the cached override
        const row = btn.closest(".ace-qol-dmg-target-row");
        if (row) this._updateDmgRowDisplay(row, tokenDocId, cached, message.flags?.[MODULE_ID]);
      }

      btn.addEventListener("click", () => {
        const tokenDocId = btn.dataset.tokenDocId;
        const multiplier = parseFloat(btn.dataset.multiplier);
        if (!tokenDocId || isNaN(multiplier)) return;

        // Toggle active class — scoped to this row only
        const ovrLine = btn.closest(".ace-qol-dmg-ovr-line");
        if (ovrLine) {
          ovrLine.querySelectorAll(".ace-qol-dmg-ovr").forEach(b => b.classList.remove("ace-qol-dmg-ovr-active"));
          btn.classList.add("ace-qol-dmg-ovr-active");
        }

        // Store in override cache (no flag persist, no re-render)
        const cacheKey = `${message.id}|${tokenDocId}`;
        DamageEngine.overrideCache.set(cacheKey, multiplier);

        // Update DOM instantly
        const row = btn.closest(".ace-qol-dmg-target-row");
        if (row) this._updateDmgRowDisplay(row, tokenDocId, multiplier, message.flags?.[MODULE_ID]);
      });
    }

    // Remove buttons (×)
    const removeBtns = el.querySelectorAll?.("[data-action='aceQolDmgRemove']");
    for (const btn of (removeBtns ?? [])) {
      if (btn.dataset.wired) continue;
      btn.dataset.wired = "1";
      btn.addEventListener("click", () => {
        const tokenDocId = btn.dataset.tokenDocId;
        const row = btn.closest(".ace-qol-dmg-target-row");
        if (row) {
          row.style.display = "none";
          row.dataset.removed = "1";
        }
        const cacheKey = `${message.id}|${tokenDocId}`;
        DamageEngine.overrideCache.set(cacheKey, "removed");
      });
    }

    // Portrait/name click → select + pan to token
    const rows = el.querySelectorAll?.(".ace-qol-dmg-target-row");
    for (const row of (rows ?? [])) {
      const img = row.querySelector(".ace-qol-dmg-tgt-img");
      const nameEl = row.querySelector(".ace-qol-dmg-tgt-name");
      const tokenDocId = row.dataset.tokenDocId;
      if (!tokenDocId || row.dataset.clickWired) continue;
      row.dataset.clickWired = "1";
      const clickHandler = () => {
        const scene = canvas.scene;
        if (!scene) return;
        const tokenDoc = scene.tokens.get(tokenDocId);
        const token = tokenDoc?.object;
        if (!token) return;
        token.control({ releaseOthers: true });
        canvas.animatePan({ x: token.center.x, y: token.center.y, duration: 250 });
      };
      if (img) img.addEventListener("click", clickHandler);
      if (nameEl) nameEl.addEventListener("click", clickHandler);
    }

    // ── Update HP + damage display from flags on every re-render ──
    // Shows live state: current HP (after applied damage), remaining damage, projected HP.
    const mFlags = message.flags?.[MODULE_ID] ?? {};
    const perTypeApplied = mFlags.perTypeApplied ?? {};
    const appliedCompsMap = mFlags.appliedComps ?? {};
    const damageResults = mFlags.damageResults ?? [];
    for (const row of (el.querySelectorAll?.(".ace-qol-dmg-target-row") ?? [])) {
      const tokenDocId = row.dataset?.tokenDocId;
      if (!tokenDocId) continue;
      const appliedAmount = perTypeApplied[tokenDocId] ?? 0;
      const entry = damageResults.find(r => r.tokenDocId === tokenDocId);
      if (!entry) continue;

      const origHP = entry.currentHP;             // HP when card was created
      const maxHP = entry.maxHP ?? origHP;
      const totalDamage = entry.totalFinal ?? 0;   // Total damage (all types)
      const appliedIndices = appliedCompsMap[tokenDocId] ?? [];

      // Calculate remaining damage (sum of unapplied components)
      const remainingDamage = (entry.components ?? []).reduce((sum, c, i) => {
        if (appliedIndices.includes(i)) return sum;
        return sum + (c.final ?? 0);
      }, 0);

      const currentLiveHP = Math.max(0, origHP - appliedAmount);   // HP right now
      const projectedHP = Math.max(0, currentLiveHP - remainingDamage);  // HP after remaining damage
      const isDead = projectedHP <= 0;

      // Update the red damage total → remaining damage to apply
      const dmgSpan = row.querySelector(".ace-qol-dmg-row-dmg");
      if (dmgSpan && appliedAmount > 0) {
        dmgSpan.textContent = remainingDamage;
      }

      // Update HP line: "HP: {currentLive} → {projected}/{max}"
      const hpLine = row.querySelector(".ace-qol-dmg-row-hp");
      if (hpLine && appliedAmount > 0) {
        hpLine.innerHTML = `HP: <span class="ace-qol-hp-cur">${currentLiveHP}</span> → <span class="ace-qol-hp-new${isDead ? ' ace-qol-hp-dead' : ''}">${projectedHP}</span><span class="ace-qol-hp-max">/${maxHP}</span>`;
      }
    }

    // ── Per-type damage TOGGLE (click to apply, click again to undo) ──
    // State is persisted in flags so it survives re-renders (setFlag triggers re-render).
    // Flags: appliedComps.{tokenDocId} = [indices], perCompApplied.{tokenDocId}.{idx} = amount
    const typeLines = el.querySelectorAll?.("[data-action='aceQolApplyType']");
    for (const line of (typeLines ?? [])) {
      if (line.dataset.wired) continue;
      line.dataset.wired = "1";

      // ── Restore visual state from flags (survives re-render) ──
      const row = line.closest(".ace-qol-dmg-target-row");
      const tokenDocId = row?.dataset?.tokenDocId;
      const compIndex = parseInt(line.dataset.compIndex);
      const appliedComps = message.flags?.[MODULE_ID]?.appliedComps?.[tokenDocId] ?? [];
      if (appliedComps.includes(compIndex)) {
        line.classList.add("ace-qol-dmg-type-applied");
      }

      line.addEventListener("click", async () => {
        const baseAmount = parseInt(line.dataset.damageAmount);
        const dmgType = line.dataset.damageType;
        const idx = parseInt(line.dataset.compIndex);
        if (isNaN(baseAmount) || baseAmount <= 0) return;

        const row = line.closest(".ace-qol-dmg-target-row");
        const tokenDocId = row?.dataset?.tokenDocId;
        if (!tokenDocId) return;

        const currentApplied = message.flags?.[MODULE_ID]?.appliedComps?.[tokenDocId] ?? [];
        const entry = message.flags?.[MODULE_ID]?.damageResults?.find(r => r.tokenDocId === tokenDocId);
        if (!entry) return;
        const actor = this._resolveTargetActor(entry);
        if (!actor) {
          ui.notifications.warn(`ACE QOL: Could not find actor for token.`);
          return;
        }

        // ════════════════════════════════════════════════════════════════
        //  TOGGLE OFF — undo this type's damage
        // ════════════════════════════════════════════════════════════════
        if (currentApplied.includes(idx)) {
          const appliedAmount = message.flags?.[MODULE_ID]?.perCompApplied?.[tokenDocId]?.[idx] ?? 0;
          if (appliedAmount <= 0) {
            console.warn(`${MODULE_ID} | Toggle-off: no recorded amount for comp ${idx} (${dmgType})`);
            return;
          }

          // Restore HP
          const currentHP = actor.system.attributes.hp.value;
          const restoredHP = Math.min(currentHP + appliedAmount, actor.system.attributes.hp.max);
          await actor.update({ "system.attributes.hp.value": restoredHP });

          // Update flags: remove from appliedComps, subtract from perTypeApplied, delete from perCompApplied
          const newApplied = currentApplied.filter(i => i !== idx);
          const prevTotal = message.flags?.[MODULE_ID]?.perTypeApplied?.[tokenDocId] ?? 0;
          const flagUpdate = {
            [`flags.${MODULE_ID}.appliedComps.${tokenDocId}`]: newApplied,
            [`flags.${MODULE_ID}.perTypeApplied.${tokenDocId}`]: Math.max(0, prevTotal - appliedAmount),
            [`flags.${MODULE_ID}.perCompApplied.${tokenDocId}.${idx}`]: null,
          };
          // If was fully applied, re-enable APPLY ALL
          if (message.flags?.[MODULE_ID]?.applied) {
            flagUpdate[`flags.${MODULE_ID}.applied`] = false;
          }
          await message.update(flagUpdate);

          console.log(`${MODULE_ID} | Per-type UNDO: comp ${idx} (${appliedAmount} ${dmgType}) from ${entry.name}: HP ${currentHP} → ${restoredHP}`);
          line.classList.remove("ace-qol-dmg-type-applied");
          ui.notifications.info(`ACE QOL: Undid ${appliedAmount} ${dmgType} damage from ${entry.name} (${currentHP} → ${restoredHP})`);
          return;
        }

        // ════════════════════════════════════════════════════════════════
        //  TOGGLE ON — apply this type's damage
        // ════════════════════════════════════════════════════════════════
        const cacheKey = `${message.id}|${tokenDocId}`;
        const override = DamageEngine.overrideCache.get(cacheKey);
        const amount = (typeof override === "number")
          ? Math.floor(baseAmount * override)
          : baseAmount;

        const currentHP = actor.system.attributes.hp.value;
        const newHP = Math.max(0, currentHP - amount);
        await actor.update({ "system.attributes.hp.value": newHP });

        // Track in flags: appliedComps, perTypeApplied, AND perCompApplied (exact amount for undo)
        const prevApplied = message.flags?.[MODULE_ID]?.perTypeApplied?.[tokenDocId] ?? 0;
        const overrideLabel = (typeof override === "number" && override !== 1) ? ` (×${override})` : "";
        console.log(`${MODULE_ID} | Per-type apply: comp ${idx} (${amount} ${dmgType}${overrideLabel}) to ${entry.name}: HP ${currentHP} → ${newHP}`);

        const updatedComps = [...currentApplied, idx];
        await message.update({
          [`flags.${MODULE_ID}.perTypeApplied.${tokenDocId}`]: prevApplied + amount,
          [`flags.${MODULE_ID}.appliedComps.${tokenDocId}`]: updatedComps,
          [`flags.${MODULE_ID}.perCompApplied.${tokenDocId}.${idx}`]: amount,
        });

        DamageEngine.overrideCache.delete(cacheKey);
        line.classList.add("ace-qol-dmg-type-applied");
        ui.notifications.info(`ACE QOL: Applied ${amount} ${dmgType} damage to ${entry.name} (${currentHP} → ${newHP})`);

        // If ALL types now applied, mark fully applied
        const totalComps = el.querySelectorAll("[data-action='aceQolApplyType']");
        const allDone = [...totalComps].every(l => {
          const ci = parseInt(l.dataset.compIndex);
          const tid = l.closest(".ace-qol-dmg-target-row")?.dataset?.tokenDocId;
          const ac = message.flags?.[MODULE_ID]?.appliedComps?.[tid] ?? updatedComps;
          return ac.includes(ci);
        });
        if (allDone) {
          await message.setFlag(MODULE_ID, "applied", true);
        }
      });
    }
  }

  /**
   * Update a target row's damage and HP display after an override click.
   */
  _updateDmgRowDisplay(row, tokenDocId, multiplier, flags) {
    const result = flags?.damageResults?.find(r => r.tokenDocId === tokenDocId);
    if (!result) return;

    const baseDmg = result.totalFinal;
    const newDamage = Math.floor(baseDmg * multiplier);
    const currentHP = result.currentHP;
    const newHP = Math.max(0, currentHP - newDamage);
    const isDead = newHP <= 0;

    const dmgSpan = row.querySelector(".ace-qol-dmg-row-dmg");
    if (dmgSpan) dmgSpan.textContent = newDamage;

    const hpSpan = row.querySelector(".ace-qol-dmg-row-hp");
    if (hpSpan) {
      hpSpan.innerHTML = `HP: <span class="ace-qol-hp-cur">${currentHP}</span>→<span class="ace-qol-hp-new${isDead ? ' ace-qol-hp-dead' : ''}">${newHP}</span>`;
    }

    const skull = row.querySelector(".ace-qol-dmg-skull");
    if (skull) skull.style.display = isDead ? "" : "none";
  }

  /**
   * Add a new target to an existing damage card (ADD TARGET or CLEAVE).
   * Reads raw components from flags, assesses new target's defenses,
   * calculates adjusted damage, appends row to DOM, updates message flags.
   */
  async _addTargetToCard(message, el, token, isCleave = false, overkillAmount = 0, overkillComponents = null) {
    const flags = message.flags?.[MODULE_ID];
    if (!flags) return;

    const actor = token.actor;
    if (!actor) {
      ui.notifications.warn("ACE QOL: Selected token has no actor.");
      return;
    }

    // Check if this token is already in the card
    const existing = flags.damageResults?.find(r => r.tokenDocId === (token.document?.id ?? token.id));
    if (existing) {
      ui.notifications.warn(`ACE QOL: ${token.name} is already in this damage card.`);
      return;
    }

    // Retrieve the attacking item for bypass checks (magical/silvered/adamantine)
    const attackItem = flags.itemUuid ? await fromUuid(flags.itemUuid) : null;

    // Assess new target's defenses
    const damageModifiers = this._getTargetDamageModifiers(actor, attackItem);

    let components;
    if (isCleave && overkillAmount > 0) {
      // Distribute overkill proportionally across damage types (based on final amounts)
      const srcComponents = overkillComponents ?? flags.rawComponents ?? [];
      const totalSrc = srcComponents.reduce((s, c) => s + (c.final ?? c.raw ?? 0), 0);
      components = srcComponents.map(c => {
        const srcVal = c.final ?? c.raw ?? 0;
        const proportion = totalSrc > 0 ? srcVal / totalSrc : 0;
        const cleaveRaw = Math.max(0, Math.round(overkillAmount * proportion));
        return { name: c.name, type: c.type, raw: cleaveRaw, total: cleaveRaw };
      });
      // Fix rounding to match exact overkill
      let sum = components.reduce((s, c) => s + c.raw, 0);
      if (sum !== overkillAmount && components.length) {
        components[0].raw += (overkillAmount - sum);
        components[0].total = components[0].raw;
      }
    } else {
      // ADD TARGET: use full raw damage from original roll
      const rawComponents = flags.rawComponents ?? [];
      components = rawComponents.map(c => ({ name: c.name, type: c.type, raw: c.raw, total: c.raw }));
    }

    // Apply new target's defenses
    const applied = this._applyDamageModifiers(components, damageModifiers);
    const totalFinal = applied.reduce((s, c) => s + c.final, 0);

    const currentHP = actor.system?.attributes?.hp?.value ?? 0;
    const maxHP = actor.system?.attributes?.hp?.max ?? 0;
    const tokenDocId = token.document?.id ?? token.id;
    const img = token.document?.texture?.src || actor.img || "icons/svg/mystery-man.svg";

    // Build row HTML and insert into the targets container
    const rowHtml = this._buildTargetRowHtml({
      tokenDocId,
      actorId: actor.id,
      sceneId: canvas.scene?.id,
      name: token.name,
      img,
      currentHP,
      maxHP,
      totalFinal,
      isCrit: false,
      components: applied,
    });

    const targetsDiv = el.querySelector(".ace-qol-dmg-targets");
    if (targetsDiv) {
      targetsDiv.insertAdjacentHTML("beforeend", rowHtml);
      // Wire the new row's buttons
      this._wireOverrideButtons(el, message);
    }

    // Update message flags with the new target
    const existingResults = [...(flags.damageResults ?? [])];
    existingResults.push({
      targetId: actor.id,
      tokenId: token.id,
      tokenDocId,
      sceneId: canvas.scene?.id,
      isLinked: token.document?.actorLink ?? false,
      totalFinal,
      currentHP,
      maxHP,
      name: token.name,
      img,
      components: applied.map(c => ({ name: c.name, type: c.type, raw: c.raw, final: c.final, modifier: c.modifier })),
      isCleave: isCleave,
    });

    await message.update({ [`flags.${MODULE_ID}.damageResults`]: existingResults });
    console.log(`${MODULE_ID} | ${isCleave ? "CLEAVE" : "ADD"}: ${token.name} added to damage card (${totalFinal} damage)`);
  }

  /**
   * Build damage modifiers map from an actor's traits (resistances/immunities/vulnerabilities).
   * @param {Actor} actor - The target actor
   * @param {Item|null} item - The attacking item (for bypass property checks)
   */
  _getTargetDamageModifiers(actor, item = null) {
    const traits = actor?.system?.traits ?? {};
    const resistSet = new Set((traits.dr?.value ?? []).map(s => s.toLowerCase()));
    const immuneSet = new Set((traits.di?.value ?? []).map(s => s.toLowerCase()));
    const vulnSet = new Set((traits.dv?.value ?? []).map(s => s.toLowerCase()));
    const drBypasses = new Set(traits.dr?.bypasses ?? []);
    const diBypasses = new Set(traits.di?.bypasses ?? []);

    // Determine weapon properties for bypass checks
    const itemProps = new Set(item?.system?.properties ?? []);
    const isMagical = itemProps.has("mgc") || !!item?.system?.magicAvailable;
    const isSilvered = itemProps.has("sil");
    const isAdamantine = itemProps.has("ada");

    const modifiers = {};

    for (const type of immuneSet) {
      // Physical damage types may be bypassed by magical/silvered/adamantine weapons
      if (PHYSICAL_TYPES.has(type) && diBypasses.size > 0) {
        const bypassed = (diBypasses.has("mgc") && isMagical)
                      || (diBypasses.has("sil") && isSilvered)
                      || (diBypasses.has("ada") && isAdamantine);
        if (bypassed) {
          // Don't add immunity — weapon bypasses it
          continue;
        }
      }
      modifiers[type] = { modifier: "immune", reason: `Immune to ${type}` };
    }

    for (const type of resistSet) {
      if (modifiers[type]) continue; // Already immune (takes priority)
      if (PHYSICAL_TYPES.has(type) && drBypasses.size > 0) {
        const bypassed = (drBypasses.has("mgc") && isMagical)
                      || (drBypasses.has("sil") && isSilvered)
                      || (drBypasses.has("ada") && isAdamantine);
        if (bypassed) {
          // Don't add resistance — weapon bypasses it
          continue;
        }
      }
      modifiers[type] = { modifier: "resistant", reason: `Resists ${type}` };
    }

    for (const type of vulnSet) {
      if (modifiers[type]) continue; // Immunity/resistance takes priority
      modifiers[type] = { modifier: "vulnerable", reason: `Vulnerable to ${type}` };
    }

    return modifiers;
  }

  // ── Dice image path builder (uses _nobg.png assets only) ──
  static DICE_COLOR = "Red";  // Default dice color set

  static getDiceImagePath(faces, result) {
    const color = DamageEngine.DICE_COLOR;
    // Map faces → folder name
    const dieFolder = `d${faces}`;
    // File pattern: {faces}-{result}_nobg.png — encode spaces for Foundry asset serving
    return `modules/ace-qol/Assets/Dice%20Dice/Dice%20Images/${color}/${dieFolder}/${faces}-${result}_nobg.png`;
  }

  // BD20 attack d20 — separate set in Assets/Dice Dice/BD20/
  static getBD20ImagePath(result) {
    return `modules/ace-qol/Assets/Dice%20Dice/BD20/BD20-${result}_nobg.png`;
  }

  // Legacy icon map (fallback if images fail to load)
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
