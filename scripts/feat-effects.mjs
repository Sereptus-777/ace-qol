// ============================================================================
//  ACE QOL — Feat-Effect Riders (Polearm Master, Crusher, Slasher, Piercer)
//
//  Feat-driven post-hit effects that pair with the existing damage pipeline.
//  Each listens to `ace-qol.attackComplete` and fires per hit/miss + per crit:
//
//   • Polearm Master  — if actor wields qualifying polearm (Glaive, Halberd,
//                       Pike, Quarterstaff, Spear), post a "bonus-action
//                       butt attack" reminder. Damage = 1d4 + ability mod
//                       (same mod as primary), type bludgeoning.
//   • Crusher         — bludgeoning hit: card with "Push 5 feet" button +
//                       crit bonus: card noting "advantage on next attack
//                       vs this target until start of your next turn".
//                       Once per turn.
//   • Slasher         — slashing hit: card with "Speed -10 feet until start
//                       of your next turn" reminder + crit bonus: target
//                       has Disadvantage on attack rolls vs anyone except
//                       you. Once per turn.
//   • Piercer         — piercing hit: card noting "you may reroll one of
//                       this attack's damage dice (must use new roll)" +
//                       crit bonus: roll one additional damage die. Once
//                       per turn. Full dice-mutation automation is in a
//                       follow-up; we surface the rule via card.
//
//  Once-per-turn flags follow the existing pattern (clear on combatTurnChange
//  via ace-qol.mjs).
// ============================================================================

import { CombatState } from "./combat-state.mjs";
import { registerChatCardHandler } from "./chat-render-utils.mjs";

const MODULE_ID = "ace-qol";
const TAG       = `${MODULE_ID} | FeatEffects`;

const POLEARM_NAMES = new Set(["glaive", "halberd", "pike", "quarterstaff", "spear"]);

export class FeatEffects {
  static _initialized = false;

  static init() {
    if (this._initialized) return;
    this._initialized = true;
    Hooks.on(`${MODULE_ID}.attackComplete`, (data) => {
      try { this._onAttackComplete(data); }
      catch (err) { console.warn(`${TAG} | attackComplete handler failed:`, err); }
    });
    // V13-SAFE: handler reads native element OR jQuery. Registered on BOTH hooks —
    // the V13 `renderChatMessageHTML` was missing, so the Crusher push button was
    // inert on V13.
    const _wireFeatCard = (message, html) => {
      if (!game.user.isGM) return;
      if (message?.flags?.[MODULE_ID]?.type !== "featEffect") return;
      const el = (html instanceof HTMLElement) ? html : (html?.[0] ?? html);
      if (!el?.querySelectorAll) return;
      el.querySelectorAll(".ace-qol-crusher-push-btn:not([data-bound])").forEach(btn => {
        btn.setAttribute("data-bound", "1");
        btn.addEventListener("click", () => {
          try {
            this._pushTarget5ft(btn.dataset.attackerUuid, btn.dataset.targetUuid);
            btn.disabled = true;
            btn.innerHTML = `<i class="fas fa-check"></i> Pushed`;
          } catch (err) { console.warn(`${TAG} | Crusher push click failed:`, err); }
        });
      });
    };
    // Both render hooks + a sweep of cards that were drawn before this
    // registered. See chat-render-utils — the raw hooks leave those
    // undecorated forever, which is how GM-only content reached a player.
    registerChatCardHandler(_wireFeatCard, "feat cards");
    console.log(`${TAG} | Feat-effect handlers online (Polearm Master, Crusher, Slasher, Piercer).`);
  }

  static async _onAttackComplete({ item, actor, hits, misses }) {
    if (!game.user.isGM) return;
    if (!item || !actor || !hits?.length) return;

    const nameNorm = String(item.name ?? "").toLowerCase().trim();
    const damageType = item.system?.damage?.parts?.[0]?.[1]
                    ?? item.system?.damage?.parts?.[0]?.types?.[0]
                    ?? "";

    // ── Polearm Master ──
    if (this._hasFeat(actor, "Polearm Master") && POLEARM_NAMES.has(nameNorm)) {
      // Use the primary attack's ability modifier (item ability or STR fallback)
      const abilKey = item.system?.ability || "str";
      const abilMod = actor.system?.abilities?.[abilKey]?.mod ?? 0;
      this._postFeatCard("polearm-master", item, actor, hits[0]?.target,
        `${actor.name} may make a <strong>Bonus Action butt attack</strong> with the ${item.name}: 1d4 + ${abilMod} bludgeoning.`,
        "#b08850", "fa-cane"
      );
    }

    // ── Dual Wielder (Enhanced Dual Wielding, 2024 XPHB) ──
    // RAW: "When you take the Attack action on your turn and attack with a
    // weapon that has the Light property, you can make one extra attack as
    // a Bonus Action later on the same turn with a different weapon, which
    // must be a Melee weapon that lacks the Two-Handed property. You don't
    // add your ability modifier to the extra attack's damage."
    // We fire on attacks made with a Light weapon by an actor with the feat.
    // Posted at most once per turn so multi-attack volleys don't spam.
    //
    // Detection paths:
    //   1. dnd5e 5.x stores the "Edit Sheet" checkbox at
    //      flags.dnd5e.enhancedDualWielding (boolean — not an item).
    //   2. DDB imports as an actual feat item named "Enhanced Dual
    //      Wielding" or "Dual Wielder".
    // We accept either source.
    const hasDualWielderFlag = actor?.getFlag?.("dnd5e", "enhancedDualWielding") === true
                            || actor?.getFlag?.("dnd5e", "dualWielder") === true;
    const hasDualWielderItem = (actor?.items ?? []).some(i =>
      /dual.?wield/i.test(String(i.name ?? ""))
    );
    const hasDualWielder = hasDualWielderFlag || hasDualWielderItem;
    if (hasDualWielder) {
      const props = item?.system?.properties ?? new Set();
      const isLight = props.has?.("lgt");
      const alreadyShown = !!actor.getFlag?.(MODULE_ID, "dualWielderReminder.shownThisTurn");
      if (isLight && !alreadyShown) {
        try { await actor.setFlag(MODULE_ID, "dualWielderReminder.shownThisTurn", true); }
        catch (_) { /* non-fatal */ }
        this._postFeatCard("dual-wielder", item, actor, hits[0]?.target,
          `${actor.name} may make a <strong>Bonus Action attack</strong> with any equipped melee weapon that isn't two-handed — <em>Light property not required</em>. (Ability modifier is NOT added to that attack's damage.)`,
          "#c08866", "fa-khanda"
        );
      }
    }

    // ── Crusher / Slasher / Piercer — once-per-turn riders by damage type ──
    for (const hit of hits) {
      const isCrit = hit?.hitResult === "critical";
      if (damageType === "bludgeoning" && this._hasFeat(actor, "Crusher")) {
        await this._fireCrusher(item, actor, hit?.target, isCrit);
      }
      if (damageType === "slashing" && this._hasFeat(actor, "Slasher")) {
        await this._fireSlasher(item, actor, hit?.target, isCrit);
      }
      if (damageType === "piercing" && this._hasFeat(actor, "Piercer")) {
        await this._firePiercer(item, actor, hit?.target, isCrit);
      }
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  //  Crusher
  // ──────────────────────────────────────────────────────────────────────────

  static async _fireCrusher(item, actor, target, isCrit) {
    const alreadyUsed = !!actor.getFlag?.(MODULE_ID, "crusher.usedThisTurn");
    const targetName = target?.name ?? "the target";

    if (!alreadyUsed) {
      await actor.setFlag(MODULE_ID, "crusher.usedThisTurn", true);
      const attUuid = actor.uuid;
      const tgtUuid = target?.document?.uuid ?? target?.uuid;
      this._postFeatCard("crusher", item, actor, target,
        `${actor.name} may push <strong>${targetName} 5 feet</strong> to an unoccupied space.`,
        "#b07050", "fa-hammer",
        `<div style="margin-top:6px;">
          <button class="ace-qol-btn ace-qol-crusher-push-btn"
                  data-attacker-uuid="${attUuid}"
                  data-target-uuid="${tgtUuid}"
                  style="background:#3a1a0a; color:#ffe1c8; border:1px solid #b07050; border-radius:4px; padding:4px 10px; font-size:12px;">
            <i class="fas fa-hand-back-fist"></i> Push 5 feet
          </button>
        </div>`
      );
    }

    if (isCrit) {
      // Auto-set the crit advantage flag on the TARGET. Combat-state reads
      // this when ANY attacker rolls vs this target → advantage. Cleared
      // at start of actor's (the Crusher's) next turn via combatTurnChange.
      try {
        if (target?.actor) {
          await target.actor.setFlag(MODULE_ID, "crusherCritDebuff", {
            byUuid: actor.uuid,
            expiresAtRound: (game.combat?.round ?? 0) + 1,
            combatId: game.combat?.id ?? null,
          });
        }
      } catch (_) { /* non-fatal */ }
      const crusherEdition = CombatState.getActiveEdition(actor);
      const crusherCritText = crusherEdition === "2014"
        ? `Attack rolls against ${targetName} <em>by creatures other than ${actor.name}</em> have <strong>Advantage</strong> until the start of ${actor.name}'s next turn. <small style="opacity:0.7;">(2014 Tasha's RAW)</small>`
        : `Attack rolls against ${targetName} have <strong>Advantage</strong> until the start of ${actor.name}'s next turn. <small style="opacity:0.7;">(2024 RAW)</small>`;
      this._postFeatCard("crusher-crit", item, actor, target,
        crusherCritText,
        "#d4af37", "fa-star"
      );
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  //  Slasher
  // ──────────────────────────────────────────────────────────────────────────

  static async _fireSlasher(item, actor, target, isCrit) {
    const alreadyUsed = !!actor.getFlag?.(MODULE_ID, "slasher.usedThisTurn");
    const targetName = target?.name ?? "the target";

    if (!alreadyUsed) {
      await actor.setFlag(MODULE_ID, "slasher.usedThisTurn", true);
      this._postFeatCard("slasher", item, actor, target,
        `${targetName}'s speed is reduced by <strong>10 feet</strong> until the start of ${actor.name}'s next turn.`,
        "#a02828", "fa-sword"
      );
    }

    if (isCrit) {
      // Auto-set the slasher crit flag on the TARGET. Combat-state reads
      // this when the target attacks anyone else → disadvantage. The
      // exceptUuid is the slasher's actor uuid, so attacks vs the slasher
      // themselves don't suffer disadvantage. Cleared at start of slasher's
      // next turn via combatTurnChange.
      try {
        if (target?.actor) {
          await target.actor.setFlag(MODULE_ID, "slasherCritDebuff", {
            exceptUuid: actor.uuid,
            expiresAtRound: (game.combat?.round ?? 0) + 1,
            combatId: game.combat?.id ?? null,
          });
        }
      } catch (_) { /* non-fatal */ }
      const slasherEdition = CombatState.getActiveEdition(actor);
      const slasherCritText = slasherEdition === "2014"
        ? `${targetName} has <strong>Disadvantage</strong> on attack rolls until the start of ${actor.name}'s next turn. <small style="opacity:0.7;">(2014 Tasha's RAW — blanket disadvantage, including vs ${actor.name})</small>`
        : `${targetName} has <strong>Disadvantage</strong> on attack rolls against anyone except ${actor.name} until the start of ${actor.name}'s next turn. <small style="opacity:0.7;">(2024 RAW)</small>`;
      this._postFeatCard("slasher-crit", item, actor, target,
        slasherCritText,
        "#d04040", "fa-star"
      );
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  //  Piercer
  // ──────────────────────────────────────────────────────────────────────────

  static async _firePiercer(item, actor, target, isCrit) {
    const alreadyUsed = !!actor.getFlag?.(MODULE_ID, "piercer.usedThisTurn");
    const targetName = target?.name ?? "the target";

    if (!alreadyUsed) {
      await actor.setFlag(MODULE_ID, "piercer.usedThisTurn", true);
      this._postFeatCard("piercer", item, actor, target,
        `${actor.name} may <strong>reroll one of this attack's damage dice</strong> (must use the new roll).`,
        "#7090b0", "fa-bolt"
      );
    }

    if (isCrit) {
      // Set a one-shot marker the damage-calculator reads on the NEXT
      // damage roll. (For Piercer the extra die fires WITH this same crit's
      // damage roll, but our attackComplete fires AFTER the attack roll
      // resolves but BEFORE damage rolls — by setting the flag now, the
      // upcoming damage-roll picks it up.) The flag is consumed by
      // damage-calculator after one use.
      try {
        await actor.setFlag(MODULE_ID, "piercerCrit.pendingExtraDie", true);
      } catch (_) { /* non-fatal */ }
      this._postFeatCard("piercer-crit", item, actor, target,
        `On this critical hit with piercing damage, you roll <strong>one additional damage die</strong>.`,
        "#d4af37", "fa-star"
      );
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  //  Buttons
  // ──────────────────────────────────────────────────────────────────────────

  static async _pushTarget5ft(attackerUuid, targetUuid) {
    const attTokenDoc = await fromUuid(attackerUuid).catch(() => null);
    const tgtTokenDoc = await fromUuid(targetUuid).catch(() => null);
    const attTok = attTokenDoc?.documentName === "Token" ? attTokenDoc
                 : attTokenDoc?.getActiveTokens?.()[0]?.document ?? null;
    const tgtTok = tgtTokenDoc?.documentName === "Token" ? tgtTokenDoc
                 : tgtTokenDoc?.getActiveTokens?.()[0]?.document ?? null;
    if (!attTok || !tgtTok) return;
    const dx = tgtTok.x - attTok.x;
    const dy = tgtTok.y - attTok.y;
    const dist = Math.hypot(dx, dy) || 1;
    const cell = canvas.grid?.size ?? 100;
    const pushPx = cell * 1; // 5 feet
    await tgtTok.update({
      x: Math.round(tgtTok.x + (dx / dist) * pushPx),
      y: Math.round(tgtTok.y + (dy / dist) * pushPx),
    });
  }

  // ──────────────────────────────────────────────────────────────────────────
  //  Helpers
  // ──────────────────────────────────────────────────────────────────────────

  static _hasFeat(actor, featName) {
    const re = new RegExp(featName.replace(/[^a-z0-9]/gi, ".?"), "i");
    return (actor?.items ?? []).some(i =>
      i.type === "feat" && re.test(String(i.name ?? ""))
    );
  }

  static _postFeatCard(featId, item, actor, target, body, color, icon, extraHtml = "") {
    const itemName = foundry.utils.escapeHTML(item?.name ?? "");
    const label    = featId.charAt(0).toUpperCase() + featId.slice(1).replace(/-/g, " ");
    ChatMessage.create({
      content: `<div class="ace-qol-card ace-qol-feat-card"
                     style="background:#0e0e10; border:2px solid ${color}; border-radius:6px; padding:10px 12px;">
        <div style="display:flex; align-items:center; gap:10px; margin-bottom:4px;">
          <i class="fas ${icon}" style="color:${color}; font-size:18px;"></i>
          <strong style="color:${color}; font-size:14px;">${label}</strong>
          <span style="color:#888; font-size:11px; margin-left:auto;">${itemName}</span>
        </div>
        <div style="color:#e0e0e0; font-size:12px; line-height:1.45;">${body}</div>
        ${extraHtml}
      </div>`,
      speaker: ChatMessage.getSpeaker({ actor }),
      flags: { [MODULE_ID]: { type: "featEffect", feat: featId } },
    });
  }

  // ──────────────────────────────────────────────────────────────────────────
  //  Flag cleanup (called from ace-qol.mjs combatTurnChange + deleteCombat)
  // ──────────────────────────────────────────────────────────────────────────

  static async clearOncePerTurnFlags(actor) {
    if (!actor) return;
    for (const k of [
      "crusher.usedThisTurn",
      "slasher.usedThisTurn",
      "piercer.usedThisTurn",
      "dualWielderReminder.shownThisTurn",
    ]) {
      try {
        if (actor.getFlag?.(MODULE_ID, k)) await actor.unsetFlag(MODULE_ID, k);
      } catch (_) { /* non-fatal */ }
    }
  }

  /**
   * Expire Crusher/Slasher crit debuffs whose round window has passed.
   * Scans every actor for the flag and clears it when its expiresAtRound
   * is in the past or its combat no longer matches the current one.
   * Called from combatTurnChange in ace-qol.mjs.
   */
  static async expireCritDebuffsIfDue() {
    const round = game.combat?.round ?? null;
    const combatId = game.combat?.id ?? null;
    if (round === null) return;
    for (const a of game.actors?.contents ?? []) {
      for (const flagKey of ["crusherCritDebuff", "slasherCritDebuff"]) {
        const debuff = a?.getFlag?.(MODULE_ID, flagKey);
        if (!debuff || typeof debuff !== "object") continue;
        const expired =
          (debuff.combatId && debuff.combatId !== combatId) ||
          (typeof debuff.expiresAtRound === "number" && round >= debuff.expiresAtRound);
        if (expired) {
          try { await a.unsetFlag(MODULE_ID, flagKey); }
          catch (_) { /* non-fatal */ }
        }
      }
    }
  }
}
