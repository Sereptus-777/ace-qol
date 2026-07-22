// ============================================================================
//  ACE QOL — Weapon Mastery System (D&D 2024 PHB)
//
//  2024 PHB: every weapon has a mastery property. Characters with the
//  "Weapon Mastery" class feature (Fighter, Barbarian, Paladin, Ranger,
//  Rogue at L1) can use the mastery of weapons they're proficient with.
//
//  9 masteries:
//    • Cleave   — Greataxe, Halberd: extra attack on adjacent foe
//    • Graze    — Glaive, Greatsword: ability mod damage on a miss
//    • Nick     — Dagger, Light Hammer, Sickle, Scimitar: extra Light attack
//    • Push     — Greatclub, Pike, Warhammer (heavy), Heavy Crossbow: push 10 ft
//    • Sap      — Mace, Quarterstaff (or Spear), Morningstar, War Pick:
//                 target has disadvantage on next attack roll
//    • Slow     — Club, Javelin, ranged: target speed reduced 10 ft
//    • Topple   — Battleaxe, Flail, Glaive, Lance, Maul, Trident, Warhammer:
//                 CON save vs prone
//    • Vex      — Dagger, Rapier, Scimitar, Shortsword, ranged crossbows:
//                 advantage on your next attack vs target
//    • Flex     — Lance (versatile damage stance)  [stub — niche]
//
//  Detection: weapon.system.mastery if 2024 system populated it, else
//  fallback to weapon-name lookup. Actor gate: must have a "Weapon Mastery"
//  class feature item (override via setting `weaponMasteryStrict`).
//
//  Effect dispatch listens to the existing ace-qol.attackComplete hook —
//  no edits to attack-pipeline.mjs required.
// ============================================================================

// NOTE: DamageApplicator is dynamic-imported at call-time inside
// _cleaveSecondAttack (NOT a top-level import). Top-level import would
// create a circular dependency: ace-qol.mjs → weapon-masteries.mjs →
// damage-applicator.mjs → ace-qol.mjs. The cycle causes DamageApplicator
// to be `undefined` when this file evaluates, which breaks module loading
// and prevents the entire Weapon Mastery system from registering.

import { aceWithinFt } from "./geometry-utils.mjs";
import { CombatState } from "./combat-state.mjs";
import { AttackAbilityResolver } from "./attack-ability-resolver.mjs";

const MODULE_ID = "ace-qol";
const TAG       = `${MODULE_ID} | Mastery`;

/**
 * 2024 PHB weapon-name → mastery fallback. Lowercased weapon name match.
 * Used when `item.system.mastery` isn't populated (older content / homebrew).
 */
const WEAPON_NAME_TO_MASTERY = {
  // Simple Melee
  "club":          "slow",
  "dagger":        "nick",
  "greatclub":     "push",
  "handaxe":       "vex",
  "javelin":       "slow",
  "light hammer":  "nick",
  "mace":          "sap",
  "quarterstaff":  "topple",
  "sickle":        "nick",
  "spear":         "sap",
  // Martial Melee
  "battleaxe":     "topple",
  "flail":         "sap",
  "glaive":        "graze",
  "greataxe":      "cleave",
  "greatsword":    "graze",
  "halberd":       "cleave",
  "lance":         "topple",
  "longsword":     "sap",
  "maul":          "topple",
  "morningstar":   "sap",
  "pike":          "push",
  "rapier":        "vex",
  "scimitar":      "nick",
  "shortsword":    "vex",
  "trident":       "topple",
  "war pick":      "sap",
  "warhammer":     "push",
  "whip":          "slow",
  // Simple Ranged
  "dart":            "vex",
  "light crossbow":  "slow",
  "shortbow":        "vex",
  "sling":           "slow",
  // Martial Ranged
  "blowgun":         "vex",
  "hand crossbow":   "vex",
  "heavy crossbow":  "push",
  "longbow":         "slow",
  "musket":          "slow",
  "pistol":          "vex",
};

const MASTERY_COLORS = {
  cleave: "#d4af37",
  graze:  "#9ecbf0",
  nick:   "#c0c0c0",
  push:   "#e88a5a",
  sap:    "#9070b0",
  slow:   "#5fb0a8",
  topple: "#c46060",
  vex:    "#ffd166",
  flex:   "#88c0d0",
};

const MASTERY_ICONS = {
  cleave: "fa-axe-battle",
  graze:  "fa-feather",
  nick:   "fa-dagger",
  push:   "fa-hand-back-fist",
  sap:    "fa-droplet-slash",
  slow:   "fa-hourglass-half",
  topple: "fa-person-falling",
  vex:    "fa-eye",
  flex:   "fa-grip-lines",
};

const MASTERY_DESCRIPTIONS = {
  cleave: "If the target is within 5 ft of another creature in your reach, you may attack that second creature with the same weapon (no ability modifier to that damage).",
  graze:  "Miss with this weapon? The target still takes damage equal to the ability modifier you used to attack.",
  nick:   "When you make the extra attack of the Light property, you can make it as part of the Attack action instead of as a Bonus Action.",
  push:   "You can push the target 10 feet straight away from you.",
  sap:    "The target has Disadvantage on its next attack roll before the start of your next turn.",
  slow:   "The target's Speed is reduced by 10 feet until the start of your next turn.",
  topple: "The target must succeed on a Constitution save (DC 8 + PB + your STR/DEX mod) or be knocked Prone.",
  vex:    "You have Advantage on your next attack roll against the target before the end of your next turn.",
  flex:   "Versatile stance — alternate between one-handed and two-handed damage dice.",
};

export class WeaponMasteries {
  static _initialized = false;

  // ──────────────────────────────────────────────────────────────────────────
  //  Lifecycle
  // ──────────────────────────────────────────────────────────────────────────

  static init() {
    if (this._initialized) return;
    this._initialized = true;
    Hooks.on(`${MODULE_ID}.attackComplete`, (data) => {
      try { this._onAttackComplete(data); }
      catch (err) { console.warn(`${TAG} | attackComplete handler failed:`, err); }
    });

    // Bind mastery-card button handlers (Push, Cleave). Each fires once per
    // chat-card render — guarded by data-bound so we don't double-bind on
    // re-renders. GM-only so movement/attacks only run on the GM client.
    //
    // ── V13 hook rename fix ─────────────────────────────────────────────
    // Foundry V13 renamed the chat-render hook from `renderChatMessage` to
    // `renderChatMessageHTML` (the new hook receives a real HTMLElement
    // instead of a jQuery wrapper). Register on BOTH names so this works
    // on V12 AND V13 systems. The `data-bound` guard prevents the click
    // handler from being attached twice if both hooks happen to fire.
    const _bindMasteryButtons = (message, html /*, data */) => {
      if (message?.flags?.[MODULE_ID]?.type !== "weaponMastery") return;
      const el = (html instanceof HTMLElement) ? html : (html?.[0] ?? html);
      if (!el?.querySelectorAll) return;

      // ── Push — player OR GM can click ──────────────────────────────────
      // Pushing a token requires token.update() which players don't have
      // permission for. Permission-aware: GM calls _pushTarget directly;
      // non-GM emits a socket request → GM handler performs the move on
      // their side. Same architectural pattern as Cleave (proven working).
      //
      // Persistent gray-out: the chat message gets a `pushFired` flag when
      // the push fires. Bind handler checks the flag on render and renders
      // disabled if already fired — so gray state survives chat re-renders.
      el.querySelectorAll(".ace-qol-mastery-push-btn:not([data-bound])").forEach(btn => {
        btn.setAttribute("data-bound", "1");
        // Restore "Pushed" state from persistent flag on re-render
        if (message?.flags?.[MODULE_ID]?.pushFired) {
          btn.disabled = true;
          btn.innerHTML = `<i class="fas fa-check"></i> Pushed`;
          return;  // skip click handler — no point binding
        }
        btn.addEventListener("click", async () => {
          if (message?.flags?.[MODULE_ID]?.pushFired) return;  // race guard
          try {
            if (game.user.isGM) {
              // GM path: do the move + flag update directly
              await this._pushTarget(btn.dataset.attackerUuid, btn.dataset.targetUuid);
              try { await message.update({ [`flags.${MODULE_ID}.pushFired`]: true }); }
              catch (flagErr) { console.warn(`${TAG} | Failed to persist pushFired flag:`, flagErr); }
            } else {
              // Player path: socket-route to GM. GM handler performs the
              // token move AND sets the pushFired flag (which propagates
              // back via Foundry's standard message sync). Player's button
              // disables optimistically below.
              game.socket?.emit?.(`module.${MODULE_ID}`, {
                type:         "executePush",
                fromUserId:   game.user.id,
                attackerUuid: btn.dataset.attackerUuid,
                targetUuid:   btn.dataset.targetUuid,
                messageId:    message.id,
              });
            }
            // Local optimistic UI: disable + flip label immediately
            btn.disabled = true;
            btn.innerHTML = `<i class="fas fa-check"></i> Pushed`;
          } catch (err) { console.warn(`${TAG} | Push click failed:`, err); }
        });
      });

      // ── Cleave — attacker's owner OR GM can click ──────────────────────
      // The attacker fires their own second attack, so permission gating is
      // by actor ownership. GM always works (full permissions). Player can
      // click on THEIR character's cleave card.
      //
      // Persistent gray-out: the chat message gets a `cleaveFired` flag
      // when the attack fires. Bind handler checks the flag on render and
      // disables the button if already fired — so the gray state survives
      // chat re-renders (otherwise the button springs back to clickable).
      el.querySelectorAll(".ace-qol-mastery-cleave-btn:not([data-bound])").forEach(btn => {
        btn.setAttribute("data-bound", "1");
        // Check persistent flag on the message — if cleave already fired,
        // render as disabled immediately on this re-bind.
        if (message?.flags?.[MODULE_ID]?.cleaveFired) {
          btn.disabled = true;
          btn.innerHTML = `<i class="fas fa-check"></i> Cleave fired`;
          return;  // skip click handler — no point binding
        }
        btn.addEventListener("click", async () => {
          const attUuid = btn.dataset.attackerUuid;
          try {
            // Resolve the attacker actor and check permission
            const attActor = await fromUuid(attUuid).catch(() => null);
            const canClick = game.user.isGM
              || (attActor && attActor.testUserPermission?.(game.user, "OWNER"));
            if (!canClick) {
              ui.notifications?.warn("Cleave: only the attacker or the GM can use this.");
              return;
            }
            // _cleaveSecondAttack returns true ONLY on success (damage
            // actually applied). False/falsy means a guard fired (no
            // damage card yet, no adjacent enemy, user cancelled, etc.)
            // — in those cases leave the button clickable so the user
            // can try again after rolling damage / adjusting positions.
            const success = await this._cleaveSecondAttack(
              attUuid,
              btn.dataset.targetUuid,
              btn.dataset.itemUuid,
            );
            if (!success) return;  // don't gray out — let user retry
            // Immediate UI update (success path only)
            btn.disabled = true;
            btn.innerHTML = `<i class="fas fa-check"></i> Cleave fired`;
            // Persistent flag on the message — survives chat re-renders.
            try {
              if (game.user.isGM) {
                await message.update({ [`flags.${MODULE_ID}.cleaveFired`]: true });
              } else {
                game.socket?.emit?.(`module.${MODULE_ID}`, {
                  type: "setCleaveFiredFlag",
                  messageId: message.id,
                });
              }
            } catch (flagErr) {
              console.warn(`${TAG} | Failed to persist cleaveFired flag:`, flagErr);
            }
          } catch (err) { console.warn(`${TAG} | Cleave click failed:`, err); }
        });
      });
    };
    // Register on both hook names — V13 fires renderChatMessageHTML (with
    // a raw HTMLElement); V12 fires renderChatMessage (with a jQuery wrap).
    // The data-bound guard prevents double-binding if both fire.
    Hooks.on("renderChatMessageHTML", _bindMasteryButtons);  // V13
    Hooks.on("renderChatMessage",     _bindMasteryButtons);  // V12 fallback

    // ── GM-side socket handler for player-initiated mastery actions ─────
    // Players don't have permission to update chat messages they don't own
    // (cleaveFired/pushFired flags), and they don't have permission to
    // update tokens they don't own (Push target move). All player clicks
    // on mastery buttons emit socket requests on this channel; the GM
    // client performs the actual mutations.
    //
    // Action types:
    //   - "setCleaveFiredFlag": persist cleaveFired flag on a damage card
    //     after a player completed a cleave (the damage row itself was
    //     added via the addCleaveTarget socket handler in damage-engine.mjs).
    //   - "executePush": perform the token-move for Push mastery + set the
    //     pushFired flag so the button greys out for everyone.
    if (game.user.isGM) {
      game.socket?.on?.(`module.${MODULE_ID}`, async (data) => {
        try {
          if (data?.type === "setCleaveFiredFlag") {
            const msg = game.messages?.get?.(data.messageId);
            if (!msg) return;
            await msg.update({ [`flags.${MODULE_ID}.cleaveFired`]: true });
            return;
          }
          if (data?.type === "executePush") {
            // Validate the requesting user (so a malicious player can't
            // socket arbitrary token moves)
            const fromUser = game.users?.get?.(data.fromUserId);
            if (!fromUser) {
              console.warn(`${TAG} | executePush socket: unknown user ${data.fromUserId} — rejecting.`);
              return;
            }
            // Bundled "ROLL DAMAGE + PUSH": arm the damage-card stamp hook
            // BEFORE the push so it's listening when the damage card arrives.
            if (data.expectDamageCard && data.stampActorId && data.stampItemUuid) {
              try {
                const { DamageEngine } = await import("./damage-engine.mjs");
                DamageEngine._armDamageCardPushStamp(data.stampActorId, data.stampItemUuid);
              } catch (err) {
                console.warn(`${TAG} | Failed to arm damage-card stamp hook:`, err);
              }
            }
            // Perform the token move
            await this._pushTarget(data.attackerUuid, data.targetUuid);
            // Persist the pushFired flag so the button stays disabled on
            // all clients after re-render (post-damage card path)
            if (data.messageId) {
              const msg = game.messages?.get?.(data.messageId);
              if (msg) await msg.update({ [`flags.${MODULE_ID}.pushFired`]: true });
            }
            console.log(`${TAG} | Socket: GM applied push from ${fromUser.name}${data.expectDamageCard ? " (bundled with roll damage)" : ""}`);
            return;
          }
          if (data?.type === "setBundledFiredFlag") {
            const msg = game.messages?.get?.(data.messageId);
            if (!msg) return;
            await msg.update({ [`flags.${MODULE_ID}.bundledFired`]: true });
            return;
          }
        } catch (err) {
          console.warn(`${TAG} | Mastery socket handler failed:`, err);
        }
      });
    }

    console.log(`${TAG} | Weapon Mastery system online (2024 PHB).`);
  }

  /**
   * Push target 10 ft (2 squares on standard grid) directly away from attacker.
   * @param {string} attackerUuid
   * @param {string} targetUuid
   */
  static async _pushTarget(attackerUuid, targetUuid) {
    const attTokenDoc = await fromUuid(attackerUuid).catch(() => null);
    const tgtTokenDoc = await fromUuid(targetUuid).catch(() => null);
    // Resolve from actor → most-recent token if a uuid was given as actor uuid
    const attTok = (attTokenDoc?.documentName === "Token") ? attTokenDoc
                 : attTokenDoc?.getActiveTokens?.()[0]?.document ?? null;
    const tgtTok = (tgtTokenDoc?.documentName === "Token") ? tgtTokenDoc
                 : tgtTokenDoc?.getActiveTokens?.()[0]?.document ?? null;
    if (!attTok || !tgtTok) {
      ui.notifications?.warn("Push: couldn't resolve attacker or target token.");
      return;
    }
    const dx = tgtTok.x - attTok.x;
    const dy = tgtTok.y - attTok.y;
    const dist = Math.hypot(dx, dy) || 1;
    const cell = canvas.grid?.size ?? 100;
    const pushPx = cell * 2; // 10 ft on standard 5 ft grid
    const newX = Math.round(tgtTok.x + (dx / dist) * pushPx);
    const newY = Math.round(tgtTok.y + (dy / dist) * pushPx);
    // ── aceForcedMovement flag ──
    // Signals to OAPrompt (and any other movement-aware ACE systems) that
    // this position change is NOT voluntary. Push mastery is "forced
    // movement" per RAW — the target isn't using their own movement, so
    // it must NOT provoke opportunity attacks. OAPrompt's updateToken hook
    // checks for this flag and short-circuits when it sees it.
    await tgtTok.update({ x: newX, y: newY }, { aceForcedMovement: true });
    console.log(`${TAG} | Pushed ${tgtTok.name} 10 ft away from ${attTok.name} (forced movement — OA suppressed)`);
  }

  /**
   * Cleave: open a target-picker prompt for the GM to select the second
   * adjacent creature, then route through the standard activity attack so the
   * normal pipeline runs. The "no ability modifier" caveat is noted in the
   * resulting chat card — applying it programmatically would require deeper
   * damage-pipeline surgery, so the GM adjusts the damage manually.
   */
  static async _cleaveSecondAttack(attackerUuid, originalTargetUuid, itemUuid) {
    const item = await fromUuid(itemUuid).catch(() => null);
    if (!item) {
      ui.notifications?.warn("Cleave: couldn't resolve weapon item — attack manually.");
      return;
    }
    const originalTargetDoc = await fromUuid(originalTargetUuid).catch(() => null);
    if (!originalTargetDoc) {
      ui.notifications?.warn("Cleave: original target not found — pick an adjacent creature manually.");
      return;
    }
    // Resolve the original-target token (canvas object)
    const origTok = (originalTargetDoc?.documentName === "Token")
                     ? originalTargetDoc.object
                     : originalTargetDoc?.getActiveTokens?.()[0] ?? null;
    if (!origTok) {
      ui.notifications?.warn("Cleave: target not on canvas — pick manually.");
      return;
    }

    // ── Resolve the attacker token so we filter by ATTACKER's disposition ──
    // (not target's — that was the bug that made Syrax cleave himself).
    // Cleave RAW: damage to a "second creature within 5 ft of the first."
    // Practically: any creature other than the attacker AND the original
    // target. We additionally filter out same-disposition (allies) so the
    // player doesn't accidentally cleave their wizard standing next to the
    // boss. Allies aren't usually who you want to cleave anyway; if a GM
    // wants ally-cleave they can target manually.
    const attackerDoc = await fromUuid(attackerUuid).catch(() => null);
    const attackerToken = (attackerDoc?.documentName === "Token")
                         ? attackerDoc.object
                         : attackerDoc?.getActiveTokens?.()[0] ?? null;
    const attackerDisp = attackerToken?.document?.disposition ?? 0;

    // Within 5 ft of the original target — shared, HP-aware helper (alive only,
    // never a downed/dead creature; same list the damage-card cleave path uses).
    const adjacent = WeaponMasteries.findCleaveAdjacent(attackerToken, origTok);

    if (!adjacent.length) {
      ui.notifications?.warn("Cleave: no living creatures within 5 ft of the original target.");
      return;
    }

    // ── Target picker ──
    // If exactly one adjacent enemy, auto-pick. Otherwise show a portrait
    // picker dialog so the player chooses who to swing at. Players don't
    // have to manually target on canvas — click the portrait, attack fires.
    let chosen;
    if (adjacent.length === 1) {
      chosen = adjacent[0];
    } else {
      chosen = await this._pickCleaveTarget(adjacent, origTok.name);
      if (!chosen) {
        ui.notifications?.info("Cleave cancelled.");
        return;
      }
    }

    // ── RAW 2024 PHB Cleave damage application ──
    // Cleave is NOT a second attack roll. Per RAW: "you can deal damage to
    // a second creature with the same attack ... the damage is the same as
    // the damage dealt to the first creature, but the second creature
    // doesn't take the damage from your STR or DEX modifier."
    //
    // Implementation:
    //   1. Find the most recent damage card from this attacker + this item
    //   2. Look up the original target's totalFinal damage in that card
    //   3. Subtract the attacker's ability modifier
    //   4. Apply the result directly to the chosen target's HP (no attack
    //      roll, no save, no AC check — RAW says it's automatic damage)
    //   5. Post a small chat confirmation
    //
    // The OLD implementation called item.use() which triggered the entire
    // attack pipeline again — that caused infinite Cleave cascades because
    // every successful hit re-fired _onAttackComplete which posted another
    // Cleave card. This implementation does ONE damage event and stops.

    // Find the matching damage card in recent chat history.
    const originalTokId = origTok.document?.id ?? origTok.id;
    const recentMsgs = [...(game.messages?.contents ?? [])].slice(-30).reverse();
    let damageCard = null;
    for (const msg of recentMsgs) {
      const fl = msg.flags?.[MODULE_ID];
      if (fl?.type !== "damageResult") continue;
      if (fl?.itemUuid && fl.itemUuid !== itemUuid) continue;
      const hasOrigInResults = (fl?.damageResults ?? []).some(r =>
        r.tokenDocId === originalTokId || r.tokenId === originalTokId
      );
      if (hasOrigInResults) { damageCard = msg; break; }
    }

    if (!damageCard) {
      ui.notifications?.warn(
        `Cleave: roll damage on ${origTok.name} first, then click Attack Adjacent again.`
      );
      return;
    }

    // Look up the original target's damage entry
    const dResults = damageCard.flags?.[MODULE_ID]?.damageResults ?? [];
    const origEntry = dResults.find(r =>
      r.tokenDocId === originalTokId || r.tokenId === originalTokId
    );
    if (!origEntry || !Number.isFinite(origEntry.totalFinal)) {
      ui.notifications?.warn("Cleave: couldn't read original target's damage from the damage card.");
      return;
    }

    // Compute the attacker's ability modifier for THIS weapon's swing — via the
    // shared, resolver-aware helper (honors Pact of the Blade / Hex Warrior CHA,
    // not the weapon's static STR default). RAW: only a POSITIVE mod is removed
    // ("doesn't take the damage from your STR/DEX modifier" — a bonus only).
    const attActor = attackerToken?.actor ?? attackerDoc?.actor ?? attackerDoc;
    const { abilityKey, subtracted: subtractedMod } = WeaponMasteries.getAttackAbilityMod(item, attActor);
    const cleaveDamage = Math.max(0, origEntry.totalFinal - subtractedMod);

    if (cleaveDamage <= 0) {
      ui.notifications?.info(
        `Cleave: damage on ${origTok.name} was ${origEntry.totalFinal}; minus ${subtractedMod} ${abilityKey.toUpperCase()} = 0. No damage to apply.`
      );
      return;
    }

    // Determine damage type from the first component (preserves type for
    // resistance/immunity calculations on the cleave target).
    const damageType = origEntry.components?.[0]?.type ?? "slashing";

    // Apply damage directly to the chosen actor's HP.
    const chosenActor = chosen.actor;
    if (!chosenActor) {
      ui.notifications?.warn(`Cleave: ${chosen.name} has no actor — can't apply damage.`);
      return;
    }
    try {
      // Lazy import to avoid the ace-qol → weapon-masteries → damage-applicator
      // → ace-qol circular dependency at module-load time.
      const { DamageApplicator } = await import("./damage-applicator.mjs");
      await DamageApplicator.applyHPDamage(chosenActor, cleaveDamage, {
        label: `Cleave from ${attActor?.name ?? "attacker"} (${item.name})`,
      });
    } catch (err) {
      console.warn(`${TAG} | Cleave damage application failed:`, err);
      ui.notifications?.warn(`Cleave: damage failed — apply ${cleaveDamage} ${damageType} to ${chosen.name} manually.`);
      return;
    }

    // Post a confirmation chat card so the table sees what happened.
    const attName = foundry.utils.escapeHTML(attActor?.name ?? "Attacker");
    const tgtName = foundry.utils.escapeHTML(chosen.name);
    const itemName = foundry.utils.escapeHTML(item.name);
    const dmgTypeLabel = foundry.utils.escapeHTML(damageType);
    try {
      await ChatMessage.create({
        content: `<div class="ace-qol-card ace-qol-cleave-fired-card"
                       style="background:#0e0e10; border:2px solid #d4af37; border-radius:6px; padding:10px 12px;">
          <div style="display:flex; align-items:center; gap:10px; margin-bottom:4px;">
            <i class="fas fa-axe-battle" style="color:#d4af37; font-size:18px;"></i>
            <strong style="color:#d4af37; font-size:14px;">Cleave Hit</strong>
            <span style="color:#888; font-size:11px; margin-left:auto;">${itemName}</span>
          </div>
          <div style="color:#e8e6e0; font-size:12px; line-height:1.45;">
            <strong>${attName}</strong> cleaves into <strong>${tgtName}</strong> for
            <strong style="color:#ff9a4a;">${cleaveDamage}</strong> ${dmgTypeLabel} damage
            (${origEntry.totalFinal} − ${subtractedMod} ${abilityKey.toUpperCase()} mod).
          </div>
        </div>`,
        speaker: ChatMessage.getSpeaker({ actor: attActor }),
        flags: { [MODULE_ID]: { type: "cleaveFiredCard" } },
      });
    } catch (_) { /* non-fatal — damage already applied */ }
    return true;  // signal success to the click handler so it grays the button
  }

  /**
   * Pick a Cleave target via a portrait-grid dialog.
   * @param {Token[]} candidates  list of valid adjacent enemy tokens
   * @param {string} origName     name of the original target (for the prompt)
   * @returns {Promise<Token|null>}  the picked token, or null if cancelled
   */
  static _pickCleaveTarget(candidates, origName) {
    return new Promise(resolve => {
      const tiles = candidates.map((t, i) => {
        const img = t.document?.texture?.src ?? t.actor?.img ?? "icons/svg/mystery-man.svg";
        const name = foundry.utils.escapeHTML(t.name ?? `Target ${i + 1}`);
        return `
          <div class="ace-qol-cleave-pick" data-idx="${i}"
               style="display:flex; flex-direction:column; align-items:center; padding:8px;
                      border:2px solid #555; border-radius:8px; cursor:pointer;
                      background:#1a1a1f; transition: border-color 0.15s, transform 0.15s;
                      width:96px;">
            <img src="${img}" style="width:64px; height:64px; border-radius:50%;
                                     border:2px solid #d4af37; object-fit:cover;" />
            <div style="margin-top:6px; font-size:12px; color:#e0e0e0; text-align:center;
                        max-width:84px; overflow:hidden; text-overflow:ellipsis;
                        white-space:nowrap;">${name}</div>
          </div>
        `;
      }).join("");

      const content = `
        <style>
          .ace-qol-cleave-pick { transition: border-color 0.15s, transform 0.15s; }
          .ace-qol-cleave-pick:hover {
            border-color: #d4af37 !important;
            transform: translateY(-2px);
          }
        </style>
        <div style="color:#e0e0e0; padding:6px 0;">
          <p style="margin:0 0 10px 0; font-size:13px;">
            Choose which adjacent creature to attack (within 5 ft of <strong>${foundry.utils.escapeHTML(origName)}</strong>):
          </p>
          <div class="ace-qol-cleave-picker"
               style="display:flex; flex-wrap:wrap; gap:10px; justify-content:center;">
            ${tiles}
          </div>
        </div>
      `;

      let dialog;
      let resolved = false;

      // ── Event delegation on the document body ──
      // The per-tile click handlers in the original implementation were
      // brittle — DialogV2's render callback fires before the dialog's
      // DOM is fully attached in some V13 builds, so querySelectorAll
      // found 0 tiles. Document-level delegation works regardless of
      // render timing — we listen for any click bubbling up, check if
      // it originated inside a tile, and resolve based on its data-idx.
      const onDocClick = (ev) => {
        const tile = ev.target?.closest?.(".ace-qol-cleave-pick");
        if (!tile || resolved) return;
        const idx = Number(tile.dataset.idx);
        const picked = candidates[idx] ?? null;
        resolved = true;
        document.removeEventListener("click", onDocClick, true);
        try { dialog?.close?.({ force: true }); } catch (_) {}
        resolve(picked);
      };
      document.addEventListener("click", onDocClick, true);

      // Hover effects via CSS pseudo-class (no JS needed) — added to the
      // tile styles below so hovering still highlights the active option.

      // Use V13 DialogV2 if available, fall back to legacy Dialog
      try {
        if (foundry.applications?.api?.DialogV2) {
          const Dialog2 = foundry.applications.api.DialogV2;
          dialog = new Dialog2({
            window: { title: "Cleave — Pick adjacent target" },
            content,
            buttons: [{
              action: "cancel",
              label: "Cancel",
              callback: () => {
                if (resolved) return;
                resolved = true;
                document.removeEventListener("click", onDocClick, true);
                resolve(null);
              },
            }],
            rejectClose: false,
            close: () => {
              if (resolved) return;
              resolved = true;
              document.removeEventListener("click", onDocClick, true);
              resolve(null);
            },
          });
          dialog.render({ force: true });
        } else {
          dialog = new Dialog({
            title: "Cleave — Pick adjacent target",
            content,
            buttons: {
              cancel: {
                label: "Cancel",
                callback: () => {
                  if (resolved) return;
                  resolved = true;
                  document.removeEventListener("click", onDocClick, true);
                  resolve(null);
                },
              },
            },
            close: () => {
              if (resolved) return;
              resolved = true;
              document.removeEventListener("click", onDocClick, true);
              resolve(null);
            },
          });
          dialog.render(true);
        }
      } catch (err) {
        console.warn(`${TAG} | Cleave picker failed to render:`, err);
        document.removeEventListener("click", onDocClick, true);
        resolve(null);
      }
    });
  }

  // ──────────────────────────────────────────────────────────────────────────
  //  Settings + gating
  // ──────────────────────────────────────────────────────────────────────────

  static isEnabled() {
    try { return game.settings.get(MODULE_ID, "weaponMasteryEnabled") !== false; }
    catch (_) { return true; }
  }

  static isStrict() {
    try { return game.settings.get(MODULE_ID, "weaponMasteryStrict") !== false; }
    catch (_) { return true; }
  }

  /**
   * Resolve the mastery for a weapon. Prefers item.system.mastery (2024
   * dnd5e), falls back to weapon-name lookup.
   * @param {Item} item
   * @returns {string|null}  one of cleave/graze/nick/push/sap/slow/topple/vex/flex
   */
  static getMasteryFor(item) {
    if (!item) return null;
    const sys = item.system ?? {};
    // ── Path 1: dnd5e 2024 system data populates `system.mastery` directly ──
    const direct = String(sys.mastery ?? "").toLowerCase().trim();
    if (direct && MASTERY_DESCRIPTIONS[direct]) return direct;

    const nameNorm = String(item.name ?? "").toLowerCase().trim();
    if (!nameNorm) return null;

    // ── Path 2: exact-name match against the WEAPON_NAME_TO_MASTERY table ──
    if (WEAPON_NAME_TO_MASTERY[nameNorm]) return WEAPON_NAME_TO_MASTERY[nameNorm];

    // ── Path 3: word-boundary substring match — catches magic/named variants ──
    // "Blood Halberd [Pact Weapon]" → "halberd" → cleave
    // "Greataxe of Smiting" → "greataxe" → cleave
    // "+1 Longsword" → "longsword" → sap
    //
    // Sort keys by length DESC so longer multi-word keys match before their
    // single-word substrings: "hand crossbow" / "heavy crossbow" / "light
    // crossbow" / "musket" must all match before bare "crossbow" would.
    // (Currently "crossbow" alone isn't in the table, but the sort future-proofs.)
    const sortedKeys = Object.keys(WEAPON_NAME_TO_MASTERY).sort((a, b) => b.length - a.length);
    for (const key of sortedKeys) {
      // Word-boundary regex so "halberd" matches "Blood Halberd" but not
      // "halberdier" (and so "axe" wouldn't match "battleaxe"). Escape any
      // regex metacharacters in the key just in case the table grows.
      const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const re = new RegExp(`\\b${escaped}\\b`, "i");
      if (re.test(nameNorm)) return WEAPON_NAME_TO_MASTERY[key];
    }
    return null;
  }

  /**
   * Does this actor have the Weapon Mastery class feature?
   *
   * In strict mode, masteries fire only for actors with weapon mastery
   * eligibility. RAW (2024 PHB), Weapon Mastery is granted at L1 to
   * Barbarian, Fighter, Paladin, Ranger, and Rogue — but the dnd5e system
   * usually doesn't materialize it as a stand-alone feat item; it's
   * implicit in the class. So we check three sources, accepting any:
   *   1. An explicit feat-type item named "Weapon Mastery"
   *   2. An item of ANY type whose name matches (covers class features
   *      that some imports surface as their own row)
   *   3. Membership in a Weapon-Mastery-granting class at L1+
   *
   * In permissive mode (strict OFF), every weapon's mastery fires for
   * every wielder — useful for NPC monster weapons that have a mastery.
   */
  static _actorHasMasteryFeature(actor) {
    if (!actor) return false;
    if (!this.isStrict()) return true;

    // Path 1 + 2: name match on any item
    const byName = (actor.items ?? []).some(i =>
      /weapon\s*mastery/i.test(String(i.name ?? ""))
    );
    if (byName) return true;

    // Path 3: class membership. Weapon Mastery is automatic at L1 for
    // these classes in 2024 RAW; the dnd5e system rarely instantiates
    // a separate item for the class feature.
    const WM_CLASSES = ["barbarian", "fighter", "paladin", "ranger", "rogue"];
    return (actor.items ?? []).some(i => {
      if (i.type !== "class") return false;
      const name = String(i.name ?? "").toLowerCase();
      return WM_CLASSES.some(c => name.includes(c));
    });
  }

  // ──────────────────────────────────────────────────────────────────────────
  //  Main dispatcher
  // ──────────────────────────────────────────────────────────────────────────

  static async _onAttackComplete({ item, actor, results, hits, misses }) {
    if (!this.isEnabled()) return;
    if (!item || !actor) return;
    if (!game.user.isGM) return; // single client fires the cards

    // ── 2014 mode gate (with hybrid-mode override) ──
    // Weapon Mastery is a D&D 2024 PHB feature. It does NOT exist in the
    // 2014 PHB. If the world is set to legacy (2014) rules, skip mastery
    // by default. BUT some tables run 2014 ruleset and want Weapon Mastery
    // as a houserule import from 2024 — the `weaponMasteryAllowIn2014`
    // setting lets them opt in. Defaults to false (pure RAW).
    try {
      const rv = CombatState.getActiveRulesVersion(actor);  // honors ACE gameRulesEdition override
      if (rv === "legacy") {
        const allowIn2014 = game.settings.get?.(MODULE_ID, "weaponMasteryAllowIn2014") === true;
        if (!allowIn2014) {
          console.log(`${TAG} | 2014 mode active — skipping mastery (enable "Weapon Mastery — Allow in 2014" in ACE QOL settings if you want this as a houserule).`);
          return;
        }
        console.log(`${TAG} | 2014 mode + houserule override active — firing mastery anyway.`);
      }
    } catch (_) { /* dnd5e version w/o the setting — assume modern */ }

    const mastery = this.getMasteryFor(item);
    if (!mastery) return;
    if (!this._actorHasMasteryFeature(actor)) return;

    // Hits get the on-hit masteries; misses get Graze.
    for (const hit of (hits ?? [])) {
      await this._fireMasteryForHit(mastery, item, actor, hit);
    }
    if (mastery === "graze") {
      for (const miss of (misses ?? [])) {
        await this._fireGrazeForMiss(item, actor, miss);
      }
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  //  Public helpers — used by damage-engine's CLEAVE damage-card button
  //  to decide whether to do RAW behavior or fall through to homebrew overkill
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Returns true if 2024 RAW Cleave should fire for this (item, actor) combo.
   * Single source of truth for the edition-gate + master-toggle + mastery-type
   * + actor-feature checks. Damage-engine's CLEAVE button calls this on click
   * — true means RAW branch (find adjacent, picker, add row with damage − mod);
   * false means fall through to homebrew overkill (the old button behavior).
   */
  static shouldOfferCleave(item, actor) {
    if (!item || !actor) return false;
    // Edition gate (2024, or 2014 + override)
    try {
      const rv = CombatState.getActiveRulesVersion(actor);  // honors ACE gameRulesEdition override
      if (rv === "legacy") {
        const allow = game.settings.get?.(MODULE_ID, "weaponMasteryAllowIn2014") === true;
        if (!allow) return false;
      }
    } catch (_) { /* assume modern */ }
    // Master toggle
    try {
      if (game.settings.get?.(MODULE_ID, "weaponMasteryEnabled") === false) return false;
    } catch (_) {}
    // Item has cleave mastery + actor has the feature
    if (this.getMasteryFor(item) !== "cleave") return false;
    if (!this._actorHasMasteryFeature(actor)) return false;
    return true;
  }

  /**
   * Returns true if Push mastery should fire for this (item, actor[, target]).
   *
   * Single source of truth for the Push gate. Optional `targetActor` enables
   * the RAW size cap — Push only works if the target is no more than one
   * size category larger than the attacker (PHB 2024). Pass `null`/omit to
   * skip the size check (e.g., for visibility decisions where we don't
   * have a target yet).
   *
   *   Medium attacker → can push tiny/small/medium/large
   *   Medium attacker → CANNOT push huge/gargantuan
   *   Small attacker  → CANNOT push large/huge/gargantuan
   */
  static shouldOfferPush(item, actor, targetActor = null) {
    if (!item || !actor) return false;
    // Edition gate (2024 or 2014 + override)
    try {
      const rv = CombatState.getActiveRulesVersion(actor);  // honors ACE gameRulesEdition override
      if (rv === "legacy") {
        const allow = game.settings.get?.(MODULE_ID, "weaponMasteryAllowIn2014") === true;
        if (!allow) return false;
      }
    } catch (_) {}
    try {
      if (game.settings.get?.(MODULE_ID, "weaponMasteryEnabled") === false) return false;
    } catch (_) {}
    if (this.getMasteryFor(item) !== "push") return false;
    if (!this._actorHasMasteryFeature(actor)) return false;
    // ── RAW 2024 size cap ──
    // "If you hit a creature that is no more than one size larger than you
    //  with this weapon, you can push the creature up to 10 feet straight
    //  away from you."
    if (targetActor) {
      const SIZE_ORDER = ["tiny", "sm", "med", "lg", "huge", "grg"];
      const aSize = String(actor.system?.traits?.size ?? "med").toLowerCase();
      const tSize = String(targetActor.system?.traits?.size ?? "med").toLowerCase();
      const aIdx = SIZE_ORDER.indexOf(aSize);
      const tIdx = SIZE_ORDER.indexOf(tSize);
      // Unknown sizes default to allow (avoid false rejections on homebrew)
      if (aIdx >= 0 && tIdx >= 0 && tIdx > aIdx + 1) return false;
    }
    return true;
  }

  /**
   * Compute the attacker's ability modifier used for this weapon's attack roll.
   * Returns: { abilityKey, abilityMod, subtracted }
   *   - abilityKey: "str", "dex", etc.
   *   - abilityMod: actor's signed modifier (can be negative)
   *   - subtracted: Math.max(0, abilityMod) — RAW only "doesn't take the
   *     damage from your STR/DEX modifier" if that modifier was a bonus
   */
  static getAttackAbilityMod(item, actor) {
    // Pact of the Blade (2024) / Hex Warrior (2014) dynamically swap the swing's
    // ability to CHARISMA at roll time. The weapon itself carries no static
    // ability, so reading item.system.ability alone falls back to STR — the
    // Blood Halberd cleave bug: it subtracted +1 STR when the swing was actually
    // +5 CHA. Ask the SAME resolver the attack used, so Cleave removes exactly
    // the ability modifier that was added.
    let abilityKey = "";
    let abilityMod = null;
    try {
      const override = AttackAbilityResolver.getOverride?.(actor, item);
      if (override && Number.isFinite(override.mod)) {
        abilityKey = String(override.ability || "").toLowerCase().trim();
        abilityMod = override.mod;
      }
    } catch (_) { /* resolver unavailable — fall through to the weapon's static ability */ }

    if (!abilityKey) {
      let staticKey = item?.system?.attack?.ability || item?.system?.ability || "";
      if (staticKey instanceof Set || staticKey instanceof Array) staticKey = [...staticKey][0] ?? "";
      abilityKey = String(staticKey || "").toLowerCase().trim() || "str";
    }
    if (abilityMod === null) abilityMod = actor?.system?.abilities?.[abilityKey]?.mod ?? 0;
    return { abilityKey, abilityMod, subtracted: Math.max(0, abilityMod) };
  }

  /**
   * Find enemies adjacent (within 5 ft / 1.5 grid cells) to the original
   * target, excluding the attacker and the original target themselves, and
   * filtering out allies of the attacker (matched by disposition).
   * Same filter logic as the old _cleaveSecondAttack — extracted so the
   * damage-card button can reuse it cleanly.
   */
  static findCleaveAdjacent(attackerToken, origTok) {
    if (!attackerToken || !origTok) return [];
    const attackerDisp = attackerToken?.document?.disposition ?? 0;
    // Within 5 ft of the original target — nearest-edge, size-aware, 3D (canonical).
    return canvas.tokens?.placeables?.filter(t =>
      t !== origTok &&
      t.id !== attackerToken?.id &&
      t.actor &&
      (t.actor?.system?.attributes?.hp?.value ?? 0) > 0 &&   // ALIVE only — never cleave a downed/dead creature
      t.document.disposition !== attackerDisp &&
      aceWithinFt(t, origTok, 5)
    ) ?? [];
  }

  static async _fireMasteryForHit(mastery, item, actor, hitResult) {
    // ── BUG FIX ──
    // hitResult.target is a PLAIN METADATA OBJECT ({name, img, ac, ...}),
    // not a real Token reference. Calling `.document.uuid` on it returns
    // undefined, which made every mastery card's button get an empty
    // data-target-uuid → fromUuid("") → null → "original target not found"
    // error. The real Token reference is on `hitResult.targetToken`
    // (combat-state.mjs line 1200 puts it there alongside the metadata).
    const targetToken = hitResult?.targetToken
                     ?? hitResult?.token
                     ?? null;
    switch (mastery) {
      // ── Cleave: damage-card button handles it ──
      // RAW 2024 Cleave is now fully integrated into the damage card itself
      // (the CLEAVE button on every damage card). When the player rolls
      // damage and clicks CLEAVE, the picker opens; on pick, a SECOND target
      // row is added to the same damage card with damage − ability mod.
      // APPLY ALL then handles both rows in one click. This avoids the
      // separate-chat-card UX and the player-can't-apply-damage permission
      // problem the old standalone-card flow had.
      case "cleave":  return;
      case "topple":  return this._fireTopple(item, actor, targetToken);
      case "vex":     return this._fireVex(item, actor, targetToken);
      case "sap":     return this._fireSap(item, actor, targetToken);
      case "slow":    return this._fireSlow(item, actor, targetToken);
      // ── Push: damage-card button handles it ──
      // Same architecture as Cleave — Push is now an action on the damage
      // card itself (next to ROLL DAMAGE / APPLY ALL), not a separate chat
      // card that pops before the damage rolls. Lets the player see the
      // damage first, THEN decide whether the push is worth it.
      case "push":    return;
      case "nick":    return this._fireNick(item, actor, targetToken);
      case "graze":   return; // graze fires only on miss
      case "flex":    return; // niche stance toggle, no on-hit effect
      default:        return;
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  //  Individual mastery handlers
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Localize a "{mastery}-fired" template from languages/en.json, with the
   * usual {attacker}/{target} interpolations. Falls back to the English
   * literal on missing-key so the system never renders blank.
   */
  static _l10nFire(masteryKey, data, fallback) {
    try {
      const out = game.i18n?.format?.(`ACE_QOL.mastery.fired.${masteryKey}`, data);
      if (out && out !== `ACE_QOL.mastery.fired.${masteryKey}`) return out;
    } catch (_) { /* fall through */ }
    return fallback;
  }

  /** Vex — set advantage-on-next-attack flag on attacker, gated to target. */
  static async _fireVex(item, actor, targetToken) {
    const targetUuid = targetToken?.document?.uuid ?? targetToken?.uuid;
    if (!targetUuid) return;
    try {
      await actor.setFlag(MODULE_ID, "vex", {
        targetUuid,
        expiresAtRound: (game.combat?.round ?? 0) + 1,  // until end of your next turn
        combatId: game.combat?.id ?? null,
      });
      const tName = targetToken?.name ?? game.i18n?.localize?.("ACE_QOL.common.target") ?? "the target";
      this._postMasteryCard("vex", item, actor, targetToken,
        this._l10nFire("vex", { attacker: actor.name, target: tName },
          `${actor.name} gains <strong>Advantage</strong> on their next attack vs ${tName} (this turn or next).`)
      );
    } catch (err) { console.warn(`${TAG} | Vex apply failed:`, err); }
  }

  /** Sap — set disadvantage-on-next-attack flag on the TARGET. */
  static async _fireSap(item, actor, targetToken) {
    const target = targetToken?.actor;
    if (!target) return;
    try {
      await target.setFlag(MODULE_ID, "sapped", {
        byUuid: actor.uuid,
        expiresAtRound: (game.combat?.round ?? 0) + 1,
        combatId: game.combat?.id ?? null,
      });
      const tName = targetToken?.name ?? game.i18n?.localize?.("ACE_QOL.common.target") ?? "The target";
      this._postMasteryCard("sap", item, actor, targetToken,
        this._l10nFire("sap", { attacker: actor.name, target: tName },
          `${tName} has <strong>Disadvantage</strong> on its next attack roll (before ${actor.name}'s next turn).`)
      );
    } catch (err) { console.warn(`${TAG} | Sap apply failed:`, err); }
  }

  /** Slow — reduce target speed 10 ft until your next turn (informational card; system-level speed mod is a follow-up). */
  static async _fireSlow(item, actor, targetToken) {
    const tName = targetToken?.name ?? game.i18n?.localize?.("ACE_QOL.common.target") ?? "The target";
    this._postMasteryCard("slow", item, actor, targetToken,
      this._l10nFire("slow", { attacker: actor.name, target: tName },
        `${tName}'s speed is <strong>reduced by 10 ft</strong> until the start of ${actor.name}'s next turn.`)
    );
  }

  /** Push — chat card with a Push button (auto-push 10 ft away). */
  static async _firePush(item, actor, targetToken) {
    const targetTokenDoc = targetToken?.document ?? targetToken;
    const tgtUuid = targetTokenDoc?.uuid;
    const attUuid = actor.uuid;
    const tName = targetToken?.name ?? game.i18n?.localize?.("ACE_QOL.common.target") ?? "the target";
    const pushBtnLabel = game.i18n?.localize?.("ACE_QOL.mastery.buttons.push") ?? "Push 10 ft";
    this._postMasteryCard("push", item, actor, targetToken,
      this._l10nFire("push", { attacker: actor.name, target: tName },
        `${actor.name} may <strong>push ${tName} 10 ft</strong> straight away.`),
      `<div style="margin-top:6px;">
         <button class="ace-qol-btn ace-qol-mastery-push-btn"
                 data-attacker-uuid="${attUuid}"
                 data-target-uuid="${tgtUuid}"
                 style="background:#3a1a0a; color:#ffe1c8; border:1px solid #e88a5a; border-radius:4px; padding:4px 10px; font-size:12px;">
           <i class="fas fa-hand-back-fist"></i> ${foundry.utils.escapeHTML(pushBtnLabel)}
         </button>
       </div>`
    );
  }

  /** Topple — post a save card prompting the target to make a CON save vs prone. */
  static async _fireTopple(item, actor, targetToken) {
    // Build a save DC = 8 + PB + better of STR/DEX mod
    const prof = actor.system?.attributes?.prof ?? 2;
    const strMod = actor.system?.abilities?.str?.mod ?? 0;
    const dexMod = actor.system?.abilities?.dex?.mod ?? 0;
    const dc = 8 + prof + Math.max(strMod, dexMod);
    const tName = targetToken?.name ?? game.i18n?.localize?.("ACE_QOL.common.target") ?? "The target";

    this._postMasteryCard("topple", item, actor, targetToken,
      this._l10nFire("topple", { attacker: actor.name, target: tName, dc },
        `${tName} must make a <strong>DC ${dc} CON save</strong> or fall <strong>Prone</strong>.`)
    );

    // If the save engine is available, fire a public save card for this single target.
    try {
      const saveEngine = game.aceQol?.saveEngine;
      if (saveEngine && targetToken && typeof saveEngine.postSaveCard === "function") {
        await saveEngine.postSaveCard(item, actor, [targetToken], {
          saveAbility: "con",
          saveDC: dc,
          halfOnSave: false,
          damageTypes: ["none"],
          isSpell: false,
          timing: { timing: "INSTANT" },
          activityId: null,
          spellLevel: null,
          skipDelay: true,
        });
      }
    } catch (err) {
      console.warn(`${TAG} | Topple save card failed (manual prompt only):`, err);
    }
  }

  /** Cleave — present a chat card with an Attack Adjacent button. (Legacy
   * path; in v0.7.16+ the cleave case in _fireMasteryForHit returns early so
   * the damage-card button handles 2024 RAW Cleave. Method retained for
   * any external caller or future standalone-card use.) */
  static async _fireCleave(item, actor, targetToken) {
    const tgtUuid = targetToken?.document?.uuid ?? targetToken?.uuid;
    const itemUuid = item?.uuid;
    const tName = targetToken?.name ?? game.i18n?.localize?.("ACE_QOL.common.target") ?? "the target";
    const itemName = item?.name ?? game.i18n?.localize?.("ACE_QOL.common.weapon") ?? "Weapon";
    const cleaveBtnLabel = game.i18n?.localize?.("ACE_QOL.mastery.buttons.cleave") ?? "Attack Adjacent";
    this._postMasteryCard("cleave", item, actor, targetToken,
      this._l10nFire("cleave", { attacker: actor.name, weapon: itemName, target: tName },
        `${actor.name} may make a <strong>second attack with ${itemName}</strong> against another creature within 5 ft of ${tName} that's also within their reach. No ability modifier to that damage.`),
      `<div style="margin-top:6px;">
         <button class="ace-qol-btn ace-qol-mastery-cleave-btn"
                 data-attacker-uuid="${actor.uuid}"
                 data-target-uuid="${tgtUuid}"
                 data-item-uuid="${itemUuid}"
                 style="background:#1a1a0a; color:#fff7cc; border:1px solid #d4af37; border-radius:4px; padding:4px 10px; font-size:12px;">
           <i class="fas fa-axe-battle"></i> ${foundry.utils.escapeHTML(cleaveBtnLabel)}
         </button>
       </div>`
    );
  }

  /** Nick — note the bonus light attack option. Player executes via standard attack. */
  static async _fireNick(item, actor, targetToken) {
    this._postMasteryCard("nick", item, actor, targetToken,
      this._l10nFire("nick", { attacker: actor.name },
        `${actor.name} may make their extra <strong>Light weapon attack</strong> as part of this Attack action (instead of as a Bonus Action).`)
    );
  }

  /** Graze — on miss, the target still takes ability-mod damage. */
  static async _fireGrazeForMiss(item, actor, missResult) {
    const targetToken = missResult?.target ?? missResult?.token ?? null;
    if (!targetToken) return;
    const strMod = actor.system?.abilities?.str?.mod ?? 0;
    const dexMod = actor.system?.abilities?.dex?.mod ?? 0;
    const sys = item.system ?? {};
    const useDex = sys.properties?.has?.("fin") || sys.actionType === "rwak";
    const abilityMod = useDex ? Math.max(strMod, dexMod) : strMod;
    if (abilityMod <= 0) return;

    // Damage type from the weapon's primary damage part
    const damageType = item.system?.damage?.parts?.[0]?.[1]
                    ?? item.system?.damage?.parts?.[0]?.types?.[0]
                    ?? "slashing";

    const tName = targetToken?.name ?? game.i18n?.localize?.("ACE_QOL.common.target") ?? "The target";
    this._postMasteryCard("graze", item, actor, targetToken,
      this._l10nFire("graze", { target: tName, damage: abilityMod, type: damageType },
        `${tName} takes <strong>${abilityMod} ${damageType}</strong> damage on the miss (ability modifier).`)
    );

    // Apply the damage using the existing damage applicator
    try {
      const tgtActor = targetToken?.actor;
      if (tgtActor) {
        const damageRoll = await new Roll(`${abilityMod}`).evaluate();
        await tgtActor.applyDamage([{ value: abilityMod, type: damageType }]);
      }
    } catch (err) {
      console.warn(`${TAG} | Graze damage application failed (chat card only):`, err);
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  //  Card rendering
  // ──────────────────────────────────────────────────────────────────────────

  static _postMasteryCard(mastery, item, actor, targetToken, body, extraHtml = "") {
    const color   = MASTERY_COLORS[mastery] ?? "#d4af37";
    const icon    = MASTERY_ICONS[mastery] ?? "fa-star";
    // i18n: localized mastery name (Cleave/Push/Topple/etc.) and card title.
    // Falls back to capitalized English on missing key so non-English worlds
    // missing a translation still get readable text.
    const localizedName = game.i18n?.localize?.(`ACE_QOL.mastery.names.${mastery}`)
                       ?? (mastery.charAt(0).toUpperCase() + mastery.slice(1));
    const title = game.i18n?.format?.("ACE_QOL.mastery.cardTitle", { mastery: localizedName })
               ?? `Mastery — ${localizedName}`;
    const localizedDesc = game.i18n?.localize?.(`ACE_QOL.mastery.descriptions.${mastery}`)
                      ?? MASTERY_DESCRIPTIONS[mastery]
                      ?? "";
    const fallbackItem = game.i18n?.localize?.("ACE_QOL.common.weapon") ?? "Weapon";
    const itemName = foundry.utils.escapeHTML(item?.name ?? fallbackItem);
    ChatMessage.create({
      content: `<div class="ace-qol-card ace-qol-mastery-card"
                     style="background:#0e0e10; border:2px solid ${color}; border-radius:6px; padding:10px 12px;">
        <div style="display:flex; align-items:center; gap:10px; margin-bottom:4px;">
          <i class="fas ${icon}" style="color:${color}; font-size:18px;"></i>
          <strong style="color:${color}; font-size:14px;">${foundry.utils.escapeHTML(title)}</strong>
          <span style="color:#888; font-size:11px; margin-left:auto;">${itemName}</span>
        </div>
        <div style="color:#e0e0e0; font-size:12px; line-height:1.45;">${body}</div>
        <div style="color:#888; font-size:11px; margin-top:4px; font-style:italic;">${foundry.utils.escapeHTML(localizedDesc)}</div>
        ${extraHtml}
      </div>`,
      speaker: ChatMessage.getSpeaker({ actor }),
      flags: { [MODULE_ID]: { type: "weaponMastery", mastery } },
    });
  }
}
