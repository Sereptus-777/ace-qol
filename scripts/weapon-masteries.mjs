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
    Hooks.on("renderChatMessage", (message, html /*, data */) => {
      if (!game.user.isGM) return;
      if (message?.flags?.[MODULE_ID]?.type !== "weaponMastery") return;
      const el = (html instanceof HTMLElement) ? html : (html?.[0] ?? html);
      if (!el?.querySelectorAll) return;

      el.querySelectorAll(".ace-qol-mastery-push-btn:not([data-bound])").forEach(btn => {
        btn.setAttribute("data-bound", "1");
        btn.addEventListener("click", () => {
          try {
            this._pushTarget(
              btn.dataset.attackerUuid,
              btn.dataset.targetUuid,
            );
            btn.disabled = true;
            btn.innerHTML = `<i class="fas fa-check"></i> Pushed`;
          } catch (err) { console.warn(`${TAG} | Push click failed:`, err); }
        });
      });

      el.querySelectorAll(".ace-qol-mastery-cleave-btn:not([data-bound])").forEach(btn => {
        btn.setAttribute("data-bound", "1");
        btn.addEventListener("click", () => {
          try {
            this._cleaveSecondAttack(
              btn.dataset.attackerUuid,
              btn.dataset.targetUuid,
              btn.dataset.itemUuid,
            );
            btn.disabled = true;
            btn.innerHTML = `<i class="fas fa-check"></i> Cleave fired`;
          } catch (err) { console.warn(`${TAG} | Cleave click failed:`, err); }
        });
      });
    });

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
    await tgtTok.update({ x: newX, y: newY });
    console.log(`${TAG} | Pushed ${tgtTok.name} 10 ft away from ${attTok.name}`);
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
    // Find adjacent enemies on the scene within 5 ft of original target.
    const origTok = (originalTargetDoc?.documentName === "Token")
                     ? originalTargetDoc.object
                     : originalTargetDoc?.getActiveTokens?.()[0] ?? null;
    if (!origTok) {
      ui.notifications?.warn("Cleave: target not on canvas — pick manually.");
      return;
    }
    const cell = canvas.grid?.size ?? 100;
    const maxPx = cell * 1.5; // ~5 ft in grid distance (a touch over to catch diagonals)
    const adjacent = canvas.tokens?.placeables?.filter(t =>
      t !== origTok &&
      t.actor &&
      t.document.disposition !== origTok.document.disposition &&
      Math.hypot(t.x - origTok.x, t.y - origTok.y) <= maxPx
    ) ?? [];

    if (!adjacent.length) {
      ui.notifications?.warn("Cleave: no adjacent creatures within 5 ft of the original target.");
      return;
    }
    // Target the first one and let the GM target+roll manually with the weapon.
    // (Programmatic re-roll through the activity would need attack-pipeline
    // surgery; saving that for a follow-up.)
    adjacent[0].setTarget(true, { user: game.user, releaseOthers: true });
    ui.notifications?.info(
      `Cleave: targeting ${adjacent[0].name}. Re-attack with ${item.name} (no ability mod on damage).`
    );
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
    const direct = String(sys.mastery ?? "").toLowerCase().trim();
    if (direct && MASTERY_DESCRIPTIONS[direct]) return direct;
    const nameNorm = String(item.name ?? "").toLowerCase().trim();
    return WEAPON_NAME_TO_MASTERY[nameNorm] ?? null;
  }

  /**
   * Does this actor have the Weapon Mastery class feature? (Strict mode
   * required to fire masteries.) In strict mode, masteries only fire for
   * actors with the feature. In permissive mode, every weapon fires its
   * mastery for every wielder.
   */
  static _actorHasMasteryFeature(actor) {
    if (!actor) return false;
    if (!this.isStrict()) return true;
    return (actor.items ?? []).some(i =>
      i.type === "feat" && /weapon\s*mastery/i.test(String(i.name ?? ""))
    );
  }

  // ──────────────────────────────────────────────────────────────────────────
  //  Main dispatcher
  // ──────────────────────────────────────────────────────────────────────────

  static async _onAttackComplete({ item, actor, results, hits, misses }) {
    if (!this.isEnabled()) return;
    if (!item || !actor) return;
    if (!game.user.isGM) return; // single client fires the cards

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

  static async _fireMasteryForHit(mastery, item, actor, hitResult) {
    const targetToken = hitResult?.target ?? hitResult?.token ?? null;
    switch (mastery) {
      case "cleave":  return this._fireCleave(item, actor, targetToken);
      case "topple":  return this._fireTopple(item, actor, targetToken);
      case "vex":     return this._fireVex(item, actor, targetToken);
      case "sap":     return this._fireSap(item, actor, targetToken);
      case "slow":    return this._fireSlow(item, actor, targetToken);
      case "push":    return this._firePush(item, actor, targetToken);
      case "nick":    return this._fireNick(item, actor, targetToken);
      case "graze":   return; // graze fires only on miss
      case "flex":    return; // niche stance toggle, no on-hit effect
      default:        return;
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  //  Individual mastery handlers
  // ──────────────────────────────────────────────────────────────────────────

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
      this._postMasteryCard("vex", item, actor, targetToken,
        `${actor.name} gains <strong>Advantage</strong> on their next attack vs ${targetToken?.name ?? "the target"} (this turn or next).`
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
      this._postMasteryCard("sap", item, actor, targetToken,
        `${targetToken?.name ?? "The target"} has <strong>Disadvantage</strong> on its next attack roll (before ${actor.name}'s next turn).`
      );
    } catch (err) { console.warn(`${TAG} | Sap apply failed:`, err); }
  }

  /** Slow — reduce target speed 10 ft until your next turn (informational card; system-level speed mod is a follow-up). */
  static async _fireSlow(item, actor, targetToken) {
    this._postMasteryCard("slow", item, actor, targetToken,
      `${targetToken?.name ?? "The target"}'s speed is <strong>reduced by 10 ft</strong> until the start of ${actor.name}'s next turn.`
    );
  }

  /** Push — chat card with a Push button (auto-push 10 ft away). */
  static async _firePush(item, actor, targetToken) {
    const targetTokenDoc = targetToken?.document ?? targetToken;
    const tgtUuid = targetTokenDoc?.uuid;
    const attUuid = actor.uuid;
    this._postMasteryCard("push", item, actor, targetToken,
      `${actor.name} may <strong>push ${targetToken?.name ?? "the target"} 10 ft</strong> straight away.`,
      `<div style="margin-top:6px;">
         <button class="ace-qol-btn ace-qol-mastery-push-btn"
                 data-attacker-uuid="${attUuid}"
                 data-target-uuid="${tgtUuid}"
                 style="background:#3a1a0a; color:#ffe1c8; border:1px solid #e88a5a; border-radius:4px; padding:4px 10px; font-size:12px;">
           <i class="fas fa-hand-back-fist"></i> Push 10 ft
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

    this._postMasteryCard("topple", item, actor, targetToken,
      `${targetToken?.name ?? "The target"} must make a <strong>DC ${dc} CON save</strong> or fall <strong>Prone</strong>.`
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

  /** Cleave — present a chat card with an Attack Adjacent button. */
  static async _fireCleave(item, actor, targetToken) {
    const tgtUuid = targetToken?.document?.uuid ?? targetToken?.uuid;
    const itemUuid = item?.uuid;
    this._postMasteryCard("cleave", item, actor, targetToken,
      `${actor.name} may make a <strong>second attack with ${item.name}</strong> against another creature within 5 ft of ${targetToken?.name ?? "the target"} that's also within their reach. No ability modifier to that damage.`,
      `<div style="margin-top:6px;">
         <button class="ace-qol-btn ace-qol-mastery-cleave-btn"
                 data-attacker-uuid="${actor.uuid}"
                 data-target-uuid="${tgtUuid}"
                 data-item-uuid="${itemUuid}"
                 style="background:#1a1a0a; color:#fff7cc; border:1px solid #d4af37; border-radius:4px; padding:4px 10px; font-size:12px;">
           <i class="fas fa-axe-battle"></i> Attack Adjacent
         </button>
       </div>`
    );
  }

  /** Nick — note the bonus light attack option. Player executes via standard attack. */
  static async _fireNick(item, actor, targetToken) {
    this._postMasteryCard("nick", item, actor, targetToken,
      `${actor.name} may make their extra <strong>Light weapon attack</strong> as part of this Attack action (instead of as a Bonus Action).`
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

    this._postMasteryCard("graze", item, actor, targetToken,
      `${targetToken?.name ?? "The target"} takes <strong>${abilityMod} ${damageType}</strong> damage on the miss (ability modifier).`
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
    const label   = mastery.charAt(0).toUpperCase() + mastery.slice(1);
    const itemName = foundry.utils.escapeHTML(item?.name ?? "Weapon");
    ChatMessage.create({
      content: `<div class="ace-qol-card ace-qol-mastery-card"
                     style="background:#0e0e10; border:2px solid ${color}; border-radius:6px; padding:10px 12px;">
        <div style="display:flex; align-items:center; gap:10px; margin-bottom:4px;">
          <i class="fas ${icon}" style="color:${color}; font-size:18px;"></i>
          <strong style="color:${color}; font-size:14px;">Mastery — ${label}</strong>
          <span style="color:#888; font-size:11px; margin-left:auto;">${itemName}</span>
        </div>
        <div style="color:#e0e0e0; font-size:12px; line-height:1.45;">${body}</div>
        <div style="color:#888; font-size:11px; margin-top:4px; font-style:italic;">${MASTERY_DESCRIPTIONS[mastery]}</div>
        ${extraHtml}
      </div>`,
      speaker: ChatMessage.getSpeaker({ actor }),
      flags: { [MODULE_ID]: { type: "weaponMastery", mastery } },
    });
  }
}
