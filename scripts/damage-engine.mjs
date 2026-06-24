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
import { CombatState } from "./combat-state.mjs";
import { ConditionLibrary } from "./condition-library.mjs";

// ═══════════════════════════════════════════════════════════════════════════
//  Shared Constants — exported for use by all damage sub-modules
// ═══════════════════════════════════════════════════════════════════════════

// safeShowForRoll lives in dsn-utils.mjs (a dependency-free leaf module)
// so concentration-widget.mjs can import it without creating a circular
// dependency through ace-qol.mjs. We re-export it here so existing
// imports of `safeShowForRoll` from damage-engine.mjs keep working.
import { safeShowForRoll } from "./dsn-utils.mjs";
export { safeShowForRoll };

export class DamageConstants {
  static suppressDiceAnimation = false;

  /**
   * Legacy entry point — kept for backwards compatibility with any external
   * callers (other ACE modules, world macros). Routes through safeShowForRoll.
   * No longer async; the `async` keyword caused subtle confusion where
   * callers thought awaiting it would gate on DSN completion (it never did).
   */
  static showDiceAnimation(roll) {
    if (!roll || DamageConstants.suppressDiceAnimation) return;
    safeShowForRoll(roll, "damage dice animation");
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
    this._registerCleaveSocket();
  }

  /**
   * GM-side socket listener for player-initiated cleave targets.
   *
   * When a player clicks CLEAVE on a damage card that the GM authored (the
   * normal flow for forwarded-attack damage cards), the player can't call
   * message.update() — Foundry blocks it on permission. The player emits a
   * socket request with the chosen target; this handler picks it up on the
   * GM client and performs the addTargetToCard call locally (GM has
   * permission). The resulting flag update propagates back to every client
   * via Foundry's normal sync, and every chat card re-renders with the new
   * target row visible + the CLEAVE button greyed out.
   */
  _registerCleaveSocket() {
    // NOTE: this method is called from the DamageEngine constructor, which is
    // itself invoked inside ace-qol.mjs's `Hooks.once("ready", ...)` callback.
    // That means we're ALREADY past init + setup, and `game.socket` / `game.user`
    // are guaranteed available. An earlier version wrapped this registration in
    // another `Hooks.once("ready", ...)` — that was a bug: by the time we got
    // here, the ready hook had already fired, and the nested registration
    // never landed. Result: the GM socket listener was never attached, so
    // player CLEAVE clicks emitted into the void. Register directly instead.
    if (!game.user?.isGM) return;
    game.socket?.on?.(`module.${MODULE_ID}`, async (data) => {
      try {
        if (data?.type !== "addCleaveTarget") return;

        // Validate the requesting user actually exists, owns the ATTACKER
        // actor on the damage card, and isn't bypassing rate limits.
        // (Audit-mandated 2026-06-08 — Grok pre-launch audit, Significant #9.)
        const fromUser = game.users?.get?.(data.fromUserId);
        if (!fromUser) {
          console.warn(`${MODULE_ID} | addCleaveTarget socket: unknown user ${data.fromUserId} — rejecting.`);
          return;
        }
        const message = game.messages?.get?.(data.messageId);
        if (!message) {
          console.warn(`${MODULE_ID} | addCleaveTarget socket: message ${data.messageId} not found.`);
          return;
        }

        // ── Ownership check on the damage card's actor ──
        // Only the player who OWNS the attacker should be able to add
        // cleave targets to their attack's damage card. A malicious player
        // could otherwise watch chat for a known messageId and redirect
        // cleave damage onto party characters.
        const attackerActorId = message.flags?.[MODULE_ID]?.actorId
                             ?? message.flags?.[MODULE_ID]?.attackerId
                             ?? message.speaker?.actor;
        if (attackerActorId) {
          const attackerActor = game.actors?.get?.(attackerActorId);
          const ownsAttacker = !!attackerActor?.testUserPermission?.(fromUser, "OWNER");
          if (!fromUser.isGM && !ownsAttacker) {
            console.warn(`${MODULE_ID} | addCleaveTarget socket: ${fromUser.name} doesn't own attacker actor ${attackerActorId} — rejecting.`);
            ui.notifications?.warn(`ACE: Cleave target add rejected — "${fromUser.name}" doesn't own the attacking actor.`);
            return;
          }
        } else {
          console.warn(`${MODULE_ID} | addCleaveTarget socket: damage card has no attacker actorId — cannot validate ownership.`);
        }

        // ── Lightweight rate-limit per user (≤2 cleave requests / 1.5s) ──
        // Prevents socket flood / accidental double-fire from runaway macros.
        const rlMap = DamageEngine._cleaveRateLimit ??= new Map();
        const now = Date.now();
        const userBucket = rlMap.get(fromUser.id) ?? [];
        const fresh = userBucket.filter(t => now - t < 1500);
        if (fresh.length >= 2) {
          console.warn(`${MODULE_ID} | addCleaveTarget socket: rate limit hit for ${fromUser.name} — rejecting.`);
          return;
        }
        fresh.push(now);
        rlMap.set(fromUser.id, fresh);

        const scene = data.sceneId ? game.scenes?.get?.(data.sceneId) : canvas.scene;
        const tokenDoc = scene?.tokens?.get?.(data.tokenDocId);
        const tokenObj = tokenDoc?.object ?? null;
        if (!tokenObj) {
          console.warn(`${MODULE_ID} | addCleaveTarget socket: token ${data.tokenDocId} not on scene.`);
          return;
        }

        // Find the rendered damage card element on the GM's screen so the
        // local DOM insert in addTargetToCard targets the right card.
        const messageEl = document.querySelector(`[data-message-id="${data.messageId}"]`);
        const cardEl = messageEl?.querySelector?.(".ace-qol-damage-card") ?? messageEl ?? null;

        await DamageApplicator.addTargetToCard(
          message, cardEl, tokenObj, data.isCleave, data.overkillAmount, data.overkillComponents
        );
        console.log(`${MODULE_ID} | Socket: GM applied cleave target ${tokenObj.name} on behalf of ${fromUser.name}`);
      } catch (err) {
        console.warn(`${MODULE_ID} | addCleaveTarget socket handler failed:`, err);
      }
    });
    console.log(`${MODULE_ID} | GM cleave-socket listener online.`);
  }

  /**
   * Arm a one-shot hook on the GM client that stamps `pushFired: true` on
   * the NEXT damageResult chat message matching the given actor + item.
   * Used by the bundled "ROLL DAMAGE + PUSH" flow to ensure that when the
   * damage card lands shortly after the push fires, its PUSH button
   * renders as already-greyed "PUSHED ✓" instead of active. Auto-cleanup
   * after 8 seconds so we don't leak hooks on aborted rolls.
   *
   * GM-only — only the GM has permission to update the damage card's flags.
   */
  static _armDamageCardPushStamp(actorId, itemUuid) {
    if (!game.user?.isGM) return;
    if (!actorId || !itemUuid) return;
    let resolved = false;
    const hookId = Hooks.on("createChatMessage", async (msg) => {
      try {
        const f = msg.flags?.[MODULE_ID];
        if (!f) return;
        if (f.type !== "damageResult") return;
        if (f.actorId !== actorId) return;
        if (f.itemUuid !== itemUuid) return;
        if (resolved) return;
        resolved = true;
        Hooks.off("createChatMessage", hookId);
        await msg.update({ [`flags.${MODULE_ID}.pushFired`]: true });
        console.log(`${MODULE_ID} | Bundled-push: stamped pushFired on damage card ${msg.id}`);
      } catch (err) {
        console.warn(`${MODULE_ID} | _armDamageCardPushStamp hook failed:`, err);
      }
    });
    // Auto-cleanup after 8s if no matching damage card arrives
    setTimeout(() => {
      if (!resolved) {
        Hooks.off("createChatMessage", hookId);
        console.log(`${MODULE_ID} | _armDamageCardPushStamp timed out for actor=${actorId}, item=${itemUuid}`);
      }
    }, 8000);
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
      // Note: the CLEAVE button row (`.ace-qol-dmg-cleave-row`) sits OUTSIDE
      // these hidden sections so players can see + click it.
      if (!game.user.isGM) {
        const targets = el.querySelector?.(".ace-qol-dmg-targets");
        if (targets) targets.style.display = "none";
        const gmControls = el.querySelectorAll?.(".ace-qol-dmg-gm-controls");
        for (const ctrl of (gmControls ?? [])) {
          ctrl.style.display = "none";
        }
      }

      // ── Rebuild target rows from flags if stored HTML is stale ──
      // When a player clicks CLEAVE and addTargetToCard updates message
      // flags, Foundry propagates the flag change to all clients. Each
      // client re-renders the message using the stored `content` HTML
      // (which was captured at create time and DOES NOT include the new
      // target row). Without this rebuild, the GM would re-render with
      // ONLY the original target visible until APPLY ALL — defeating the
      // point of cleave-on-damage-card UX. This regenerates the target
      // rows section every render so it always matches the flags state.
      if (game.user.isGM && flags?.type === "damageResult" && Array.isArray(flags?.damageResults)) {
        const targetsDiv = el.querySelector?.(".ace-qol-dmg-targets");
        const currentRows = targetsDiv?.querySelectorAll?.(".ace-qol-dmg-target-row")?.length ?? 0;
        if (targetsDiv && flags.damageResults.length > currentRows) {
          const rebuiltRows = flags.damageResults.map(r => DamageCardRenderer.buildTargetRowHtml({
            tokenDocId: r.tokenDocId,
            actorId:    r.targetId,
            sceneId:    r.sceneId,
            name:       r.name,
            img:        r.img,
            currentHP:  r.currentHP,
            maxHP:      r.maxHP,
            totalFinal: r.totalFinal,
            isCrit:     r.isCrit ?? false,
            components: r.components,
          })).join("");
          targetsDiv.innerHTML = rebuiltRows;
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
            if (applyBtn.disabled) return;
            applyBtn.disabled = true;
            applyBtn.textContent = "APPLYING...";
            await DamageApplicator.applyDamage(message);
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

      // ── PUSH button (2024 RAW Push mastery on the damage card) ──
      // Push moves the first damage target 10 ft directly away from the
      // attacker. Lives on the damage card so the player sees damage FIRST,
      // then decides whether the push is worth doing (e.g., skip if the
      // target already died). Permission-aware: GM does the token-move
      // directly, players socket-route through GM. Persistent `pushFired`
      // flag greys the button across all clients on re-render.
      const pushBtn = el.querySelector?.("[data-action='aceQolPush']");
      if (pushBtn && !pushBtn.dataset.wired) {
        pushBtn.dataset.wired = "1";
        if (message.flags?.[MODULE_ID]?.pushFired) {
          pushBtn.disabled = true;
          pushBtn.innerHTML = '<i class="fas fa-check"></i> PUSHED ✓';
        } else {
          pushBtn.addEventListener("click", async () => {
            if (message.flags?.[MODULE_ID]?.pushFired) return;
            const flags = message.flags?.[MODULE_ID] ?? {};
            try {
              // Resolve attacker actor + active token
              const attActor = flags.actorId ? game.actors?.get?.(flags.actorId) : null;
              const attTok   = attActor?.getActiveTokens?.()[0] ?? null;
              if (!attTok) {
                ui.notifications.warn("ACE QOL: Push — attacker token not on the current scene.");
                return;
              }
              // First target from damage results = the creature being pushed
              const firstResult = (flags.damageResults ?? [])[0];
              if (!firstResult) {
                ui.notifications.warn("ACE QOL: Push needs a target — roll damage first.");
                return;
              }
              const scene     = firstResult.sceneId ? game.scenes?.get?.(firstResult.sceneId) : canvas.scene;
              const tgtTokDoc = scene?.tokens?.get?.(firstResult.tokenDocId);
              if (!tgtTokDoc) {
                ui.notifications.warn("ACE QOL: Push — target token not on the current scene.");
                return;
              }
              // Permission-route: GM does the move directly; player sockets
              const { WeaponMasteries } = await import("./weapon-masteries.mjs");
              if (game.user.isGM) {
                await WeaponMasteries._pushTarget(attTok.document.uuid, tgtTokDoc.uuid);
                try { await message.update({ [`flags.${MODULE_ID}.pushFired`]: true }); }
                catch (e) { console.warn(`${MODULE_ID} | Failed to persist pushFired flag:`, e); }
              } else {
                game.socket?.emit?.(`module.${MODULE_ID}`, {
                  type:         "executePush",
                  fromUserId:   game.user.id,
                  attackerUuid: attTok.document.uuid,
                  targetUuid:   tgtTokDoc.uuid,
                  messageId:    message.id,
                });
              }
              // Optimistic UI — disable + flip label immediately
              pushBtn.disabled = true;
              pushBtn.innerHTML = '<i class="fas fa-check"></i> PUSHED ✓';
            } catch (err) {
              console.warn(`${MODULE_ID} | Push click failed:`, err);
            }
          });
        }
      }

      // ── CLEAVE button ──
      // Two behaviors share one button:
      //   1. RAW 2024 Weapon Mastery Cleave — if the attacker has cleave
      //      mastery + the edition allows it, picks any adjacent enemy and
      //      adds them as a SECOND ROW on this damage card with damage =
      //      first-target-damage − ability mod. APPLY ALL then handles
      //      both targets in one GM-side click (no permission issue).
      //   2. Homebrew Overkill Carryover — legacy fallback. If a target was
      //      reduced to 0 HP, the excess damage can be redirected to an
      //      adjacent enemy. Same proportional-component scaling. Used when
      //      no cleave mastery applies (e.g., non-mastery weapons, 2014
      //      mode without the override).
      const cleaveBtn = el.querySelector?.("[data-action='aceQolCleave']");
      if (cleaveBtn && !cleaveBtn.dataset.wired) {
        cleaveBtn.dataset.wired = "1";

        // ── Restore "CLEAVED ✓" state from persistent flag ──
        // Once a cleave has fired on this damage card (whether by player or
        // GM), the `cleaveFired` flag is set on the message. Every subsequent
        // render shows the button as disabled with a "CLEAVED ✓" label so
        // it's visually clear the action happened, and you can't double-fire.
        if (message.flags?.[MODULE_ID]?.cleaveFired) {
          cleaveBtn.disabled = true;
          cleaveBtn.innerHTML = '<i class="fas fa-check"></i> CLEAVED ✓';
          return;  // skip click handler — no point binding
        }

        // ── Suppress the button when there's nothing to cleave ──
        // Cleave (mastery OR overkill carryover) both need a hostile creature
        // within 5 ft of the one you hit. If there's none, don't show a dead
        // button — on the GM's screen OR the player's. (The render handler is
        // sync; run the canvas check in a microtask. The import resolves from
        // cache, so the button hides effectively instantly.) 2026-06-24.
        (async () => {
          try {
            const cf       = message.flags?.[MODULE_ID] ?? {};
            const first    = (cf.damageResults ?? [])[0];
            const attActor = cf.actorId ? game.actors?.get?.(cf.actorId) : null;
            const attTok   = attActor?.getActiveTokens?.()[0] ?? null;
            const origTok  = first?.tokenDocId ? canvas.tokens?.get?.(first.tokenDocId) : null;
            if (!attTok || !origTok) return;   // can't evaluate — leave the button
            const { WeaponMasteries } = await import("./weapon-masteries.mjs");
            if (WeaponMasteries.findCleaveAdjacent(attTok, origTok).length === 0) {
              cleaveBtn.style.display = "none";
            }
          } catch (_) { /* on any error, leave the button as-is */ }
        })();

        cleaveBtn.addEventListener("click", async () => {
          if (message.flags?.[MODULE_ID]?.applied) return;
          if (message.flags?.[MODULE_ID]?.cleaveFired) return;  // race guard
          const flags = message.flags?.[MODULE_ID] ?? {};

          // ── Branch 1: 2024 RAW Cleave (weapon mastery) ──
          try {
            const { WeaponMasteries } = await import("./weapon-masteries.mjs");
            const item = flags.itemUuid ? await fromUuid(flags.itemUuid).catch(() => null) : null;
            const attActor = flags.actorId ? game.actors?.get?.(flags.actorId) : null;
            if (item && attActor && WeaponMasteries.shouldOfferCleave(item, attActor)) {
              await DamageEngine._handleMasteryCleave({
                message, el, cleaveBtn, item, attActor, flags, WeaponMasteries,
              });
              return;
            }
          } catch (err) {
            console.warn(`${MODULE_ID} | Mastery cleave branch failed — falling through to overkill:`, err);
          }

          // ── Branch 2: Homebrew Overkill Carryover (fallback) ──
          const results = flags.damageResults ?? [];
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

      // ── Cleave caption (clarity for both GM and player) ──
      // When a mastery cleave fires, stamp a one-line caption right below
      // the CLEAVE button row showing WHICH target got cleaved. Two variants:
      //   - Auto-picked (only one valid candidate):
      //       "⚔ Auto-cleaved to <name> (only valid target)"
      //   - Picker resolved (multi-target):
      //       "⚔ Cleaved to <name>"
      // Independent of the cleave button wiring above — must re-check on
      // every render because flag-driven updates trigger fresh renders.
      // Idempotent: checks for the caption's class on the next sibling
      // before inserting, so re-renders don't stack duplicates.
      if (flags?.cleaveFired && flags?.cleaveTargetName) {
        const cleaveRow = el.querySelector?.(".ace-qol-dmg-cleave-row");
        const alreadyInserted = cleaveRow?.nextElementSibling?.classList?.contains?.("ace-qol-cleave-caption");
        if (cleaveRow && !alreadyInserted) {
          const key = flags.cleaveAutoPicked
            ? "ACE_QOL.mastery.cleaveCaption.auto"
            : "ACE_QOL.mastery.cleaveCaption.picker";
          const text = game.i18n?.format?.(key, { target: flags.cleaveTargetName })
                    ?? `⚔ Cleaved to ${flags.cleaveTargetName}`;
          const captionDiv = document.createElement("div");
          captionDiv.className = "ace-qol-cleave-caption";
          captionDiv.textContent = text;
          captionDiv.style.cssText = "text-align:center;font-style:italic;color:#c9a868;font-size:0.85rem;padding:6px 8px;opacity:0.95;letter-spacing:0.3px;";
          cleaveRow.insertAdjacentElement("afterend", captionDiv);
        }
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

      // ── PC "ROLL DAMAGE + PUSH 10 FT?" bundled button (push mastery only) ──
      // Lives on the pre-damage button card right under the regular ROLL DAMAGE.
      // Orange + blinking to grab attention. ONE click commits both actions:
      // (1) push target 10 ft directly away, with forced-movement flag so no
      //     OA prompt fires; (2) trigger the regular ROLL DAMAGE flow. Damage
      // result card that follows will be stamped with pushFired:true so its
      // own PUSH 10 FT button renders as already-greyed "PUSHED ✓" for the
      // visual confirmation.
      const rollDmgPushBtn = el.querySelector?.("[data-action='aceQolRollDamagePush']");
      if (rollDmgPushBtn && !rollDmgPushBtn.dataset.wired) {
        rollDmgPushBtn.dataset.wired = "1";
        if (flags.bundledFired || flags.rolled) {
          rollDmgPushBtn.disabled = true;
          rollDmgPushBtn.classList.remove("ace-qol-blink-push");
          rollDmgPushBtn.innerHTML = '<i class="fas fa-check"></i> ROLLED + PUSHED ✓';
        } else {
          rollDmgPushBtn.addEventListener("click", async () => {
            if (message.flags?.[MODULE_ID]?.bundledFired) return;
            if (message.flags?.[MODULE_ID]?.rolled) return;
            try {
              const attUuid = rollDmgPushBtn.dataset.attackerUuid;
              const tgtUuid = rollDmgPushBtn.dataset.targetUuid;
              const actorIdForStamp = message.flags?.[MODULE_ID]?.actorId;
              const itemUuidForStamp = message.flags?.[MODULE_ID]?.itemUuid;

              // ── (1) Trigger push first (immediate token movement) ──
              const { WeaponMasteries } = await import("./weapon-masteries.mjs");
              if (game.user.isGM) {
                // GM: push directly AND set up the one-shot hook to stamp
                // the upcoming damage card with pushFired:true.
                DamageEngine._armDamageCardPushStamp(actorIdForStamp, itemUuidForStamp);
                await WeaponMasteries._pushTarget(attUuid, tgtUuid);
                try { await message.update({ [`flags.${MODULE_ID}.bundledFired`]: true }); }
                catch (e) { console.warn(`${MODULE_ID} | bundledFired update failed:`, e); }
              } else {
                // Player: emit socket with expectDamageCard:true so GM also
                // arms the stamp hook on its side before the damage card lands.
                game.socket?.emit?.(`module.${MODULE_ID}`, {
                  type:            "executePush",
                  fromUserId:      game.user.id,
                  attackerUuid:    attUuid,
                  targetUuid:      tgtUuid,
                  expectDamageCard: true,
                  stampActorId:    actorIdForStamp,
                  stampItemUuid:   itemUuidForStamp,
                });
                game.socket?.emit?.(`module.${MODULE_ID}`, {
                  type:      "setBundledFiredFlag",
                  messageId: message.id,
                });
              }

              // ── (2) Optimistic UI: grey both buttons, kill the blink ──
              rollDmgPushBtn.disabled = true;
              rollDmgPushBtn.classList.remove("ace-qol-blink-push");
              rollDmgPushBtn.innerHTML = '<i class="fas fa-check"></i> ROLLED + PUSHED ✓';
              const rollDmgBtnLocal = el.querySelector?.("[data-action='aceQolRollDamage']");
              if (rollDmgBtnLocal && !rollDmgBtnLocal.disabled) {
                // (3) Programmatically trigger the regular ROLL DAMAGE flow
                // BEFORE we disable it, so its handler fires normally.
                rollDmgBtnLocal.click();
              }
            } catch (err) {
              console.warn(`${MODULE_ID} | Bundled roll+push click failed:`, err);
            }
          });
        }
      }

      // ── PC "Roll Damage" button ──
      const rollDmgBtn = el.querySelector?.("[data-action='aceQolRollDamage']");
      if (rollDmgBtn && !rollDmgBtn.dataset.wired) {
        rollDmgBtn.dataset.wired = "1";
        if (flags.rolled || flags.bundledFired) {
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

    console.debug(`${MODULE_ID} | Damage engine hooks registered`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Attack Complete → Route to Damage Card
  // ═══════════════════════════════════════════════════════════════════════════

  async _onAttackComplete(data) {
    const { item, actor, results, hits, actionType: hookActionType, subject, initiatorUserId } = data;
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

        const selectedRiders = await this._requestRiderChoice(actor, availableRiders, riderContext, initiatorUserId);

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

          // ── Save-required riders (Stunning Strike, etc.) ──
          // Riders carrying a `saveRequired` payload have no damage formula
          // but require a follow-up save card on the target. Stunning Strike
          // (Monk) is the canonical case: CON save vs the monk's ki save DC,
          // on failure the target is stunned with edition-aware duration.
          // (v0.7.14 G-D fix — previously the rider dead-ended after burning
          //  the ki point with no save and no condition applied.)
          for (const rider of selectedRiders) {
            if (!rider.saveRequired) continue;
            if (rider.id === "stunning-strike") {
              for (const hit of hits) {
                const targetActor = hit.targetActor ?? game.actors.get(hit.actorId);
                if (!targetActor) continue;
                try {
                  await ConditionLibrary.postStunningStrikeSaveCard(actor, targetActor, rider.saveRequired);
                } catch (err) {
                  console.warn(`${MODULE_ID} | Stunning Strike save card post failed:`, err);
                }
              }
            }
            // Future: other save-required riders dispatch here by rider.id.
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

  async _requestRiderChoice(actor, riders, context, initiatorUserId = null) {
    // ── Resolve WHO sees the rider popup (Divine Smite, Eldritch Smite, etc.) ──
    // v0.7.22 UX rule: the popup goes to whoever ROLLED the attack — GM or
    // player — because that's the person paying attention and expecting a
    // follow-up. The OLD behavior always routed to the actor's owning player
    // regardless of who rolled, so a GM rolling for a connected player's
    // paladin saw nothing while the popup sat unnoticed on the player's
    // screen until a 60-second timeout SILENTLY skipped the smite. That 60s
    // skip is gone (matches the suite-wide timer purge).
    //
    // The "riderPromptsFollowRoller" setting (default ON) controls this.
    // OFF restores the legacy "always ask the owning player" routing for
    // tables where the GM rolls but wants the player to spend their own slots.
    let followRoller = true;
    try { followRoller = QolSettings.get("riderPromptsFollowRoller") !== false; }
    catch (_) { followRoller = true; }

    let targetUser = null;
    if (followRoller && initiatorUserId) {
      targetUser = game.users.get(initiatorUserId) ?? null;
    }
    if (!targetUser) {
      // Fallback / legacy path: first active non-GM owner of the actor.
      targetUser = game.users.find(u =>
        !u.isGM && u.active && actor.testUserPermission(u, "OWNER")
      ) ?? null;
    }

    // Show on THIS machine when the resolved user is us (GM rolled, or we ARE
    // the rolling player) or when there's no distinct player to ask.
    if (!targetUser || targetUser.id === game.user.id) {
      console.log(`${MODULE_ID} | Rider popup: showing locally (roller=${targetUser?.name ?? "GM/local"})`);
      return RiderEngine.showRiderPopup(riders, context);
    }

    const requestId = foundry.utils.randomID();
    console.log(`${MODULE_ID} | Rider popup: routing to ${targetUser.name} (roller, requestId=${requestId})`);

    return new Promise((resolve) => {
      // NO decision timer. The popup waits for the roller to choose. The only
      // safety net is a long disconnect guard so a fully-dropped client can't
      // hang the GM's damage pipeline forever — 10 minutes, matching the
      // optional-prompt system. This is a disconnect net, NOT a "skip the
      // smite after N seconds" countdown.
      const NETWORK_SAFETY_MS = 10 * 60 * 1000;
      const timeout = setTimeout(() => {
        delete this._pendingRiderRequests[requestId];
        console.warn(`${MODULE_ID} | Rider request ${requestId} disconnect-safety expired (10 min) — ${targetUser.name} likely disconnected`);
        resolve([]);
      }, NETWORK_SAFETY_MS);

      this._pendingRiderRequests[requestId] = { resolve, timeout };

      game.socket.emit(`module.${MODULE_ID}`, {
        action: "showRiderPopup",
        requestId,
        userId: targetUser.id,
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
        // If the renderer returned an item for post-hit effects, run them.
        // Prefer the item's parent actor (which the renderer resolved from
        // the TOKEN, so items dragged onto NPC tokens mid-battle work) over
        // the base actor lookup. Falls back to base if the item somehow
        // has no parent (orphaned item — shouldn't happen in practice).
        if (result.item) {
          const attackerActor = result.item.actor ?? game.actors.get(flags.actorId);
          await PostHitSaves.checkPostHitEffects(result.item, attackerActor, flags.preRolled, result.damageResults);
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

  // ──────────────────────────────────────────────────────────────────────────
  //  2024 RAW Weapon Mastery — Cleave (damage-card flow)
  //
  //  Called from the damage-card CLEAVE button click handler when:
  //   - the attacker has the Weapon Mastery class feature
  //   - the weapon has cleave mastery
  //   - the edition allows it (2024 mode, or 2014 + override setting)
  //
  //  Flow: find adjacent enemy → portrait picker (if multiple) → compute
  //  cleave damage = (first target's total damage) − ability mod → add the
  //  chosen target as a second row to the SAME damage card. APPLY ALL then
  //  applies to both rows GM-side (no permission problem).
  //
  //  Per 2024 PHB Cleave entry: "if you hit a creature with a melee attack
  //  using this weapon, you can deal damage to a second creature with the
  //  same attack. The second creature must be within 5 feet of the first
  //  and within your reach. The damage is the same as the damage you dealt
  //  the first creature, except the second creature doesn't take any
  //  damage from your Strength (or Dexterity) modifier."
  // ──────────────────────────────────────────────────────────────────────────
  static async _handleMasteryCleave({ message, el, cleaveBtn, item, attActor, flags, WeaponMasteries }) {
    // 1. Need the first damage row to copy damage from
    const results = flags.damageResults ?? [];
    const origEntry = results[0];
    if (!origEntry || !Number.isFinite(origEntry.totalFinal)) {
      ui.notifications.warn("ACE QOL: Cleave needs damage to be rolled first.");
      return;
    }

    // 2. Resolve the original target token on canvas (need its position to
    //    find adjacent enemies). Try the recorded sceneId first; fall back
    //    to current canvas.
    const origScene = origEntry.sceneId ? game.scenes?.get?.(origEntry.sceneId) : null;
    const origTokDoc = (origScene?.tokens?.get?.(origEntry.tokenDocId))
                    ?? canvas.scene?.tokens?.get?.(origEntry.tokenDocId);
    const origTok = origTokDoc?.object;
    if (!origTok) {
      ui.notifications.warn("ACE QOL: Cleave — original target isn't on the current scene.");
      return;
    }

    // 3. Resolve the attacker token (need their disposition to filter allies
    //    out of cleave candidates, and their identity to exclude self).
    //    Prefer an active token on the current canvas.
    const attTok = attActor?.getActiveTokens?.()[0] ?? null;
    if (!attTok) {
      ui.notifications.warn("ACE QOL: Cleave — attacker token not on the current scene.");
      return;
    }

    // 4. Find adjacent enemies (within 5 ft of original target, hostile)
    const adjacent = WeaponMasteries.findCleaveAdjacent(attTok, origTok);
    if (!adjacent.length) {
      ui.notifications.warn(`Cleave: no adjacent creatures within 5 ft of ${origTok.name}.`);
      return;
    }

    // 5. Auto-pick if exactly one; otherwise portrait picker
    let chosen;
    let wasAutoPicked;
    if (adjacent.length === 1) {
      chosen = adjacent[0];
      wasAutoPicked = true;
    } else {
      chosen = await WeaponMasteries._pickCleaveTarget(adjacent, origTok.name);
      if (!chosen) {
        ui.notifications.info("Cleave cancelled.");
        return;
      }
      wasAutoPicked = false;
    }

    // 6. Already in card?  Tell the user, don't double-add.
    const tokenDocId = chosen.document?.id ?? chosen.id;
    if (results.some(r => r.tokenDocId === tokenDocId)) {
      ui.notifications.warn(`ACE QOL: ${chosen.name} is already a target on this damage card.`);
      return;
    }

    // 7. Compute cleave damage. Use the FIRST target's totalFinal (the damage
    //    they actually took) — this is what RAW means by "same damage as the
    //    first creature." Subtract the attacker's ability mod (positive only).
    const { abilityKey, subtracted } = WeaponMasteries.getAttackAbilityMod(item, attActor);
    const cleaveDmg = Math.max(0, origEntry.totalFinal - subtracted);
    if (cleaveDmg <= 0) {
      ui.notifications.info(
        `Cleave: ${origTok.name}'s damage was ${origEntry.totalFinal} − ${subtracted} ${abilityKey.toUpperCase()} = 0. Nothing to cleave.`
      );
      return;
    }

    // 8. Hand off to addTargetToCard. We pass the ORIGINAL target's components
    //    as `overkillComponents` so addTargetToCard's isCleave branch scales
    //    them proportionally to `cleaveDmg`, then applies the cleave TARGET'S
    //    own defenses (resistance/immunity/vulnerability) on top. That gives
    //    the new target its full set of damage modifiers while preserving
    //    the proportional damage-type breakdown of the original hit.
    cleaveBtn.disabled = true;
    cleaveBtn.innerHTML = '<i class="fas fa-check"></i> CLEAVED ✓';
    await DamageApplicator.addTargetToCard(
      message, el, chosen, /* isCleave */ true, cleaveDmg, origEntry.components ?? flags.rawComponents ?? [],
      // cleaveMeta — render handler reads these flags to show the
      // "Cleaved to <target>" caption on both GM and player damage cards.
      { autoPicked: wasAutoPicked, targetName: chosen.name }
    );
    DamageApplicator.wireOverrideButtons(el, message);

    ui.notifications.info(
      `Cleave → ${chosen.name}: ${cleaveDmg} damage (${origEntry.totalFinal} − ${subtracted} ${abilityKey.toUpperCase()})`
    );
  }
}
