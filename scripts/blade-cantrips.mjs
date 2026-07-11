// ============================================================================
//  ACE QOL — Blade Cantrips (Booming Blade, Green-Flame Blade, True Strike)
//
//  2024 PHB cantrips that fire a weapon attack and add a bonus / rider:
//
//   • Booming Blade   — weapon hit + 1d8 thunder; +(1+L5/L11/L17)d8 if target
//                       moves voluntarily before start of caster's next turn.
//                       The base 1d8 thunder is handled by the cantrip's own
//                       activity. We add the movement-trigger reminder card.
//   • Green-Flame Blade — weapon hit + 1d8 fire (scaling at L5/11/17); a
//                         second creature within 5 ft of the target takes
//                         ability-mod fire damage. The base 1d8 is handled
//                         by the cantrip; we surface the secondary-target
//                         damage as a one-click chat button.
//   • True Strike     — weapon attack + 1d6 radiant (scaling); the caster
//                       may REPLACE the weapon's normal damage type with
//                       radiant on this attack. We pop a yes/no dialog at
//                       cast time and stash a one-shot flag the damage
//                       pipeline reads to do the swap.
//
//  Detection: `dnd5e.postCreateUsageMessage` hook, gated to spells whose
//  name matches one of the three.
// ============================================================================

import { aceWithinFt } from "./geometry-utils.mjs";

const MODULE_ID = "ace-qol";
const TAG       = `${MODULE_ID} | BladeCantrips`;

export class BladeCantrips {
  static _initialized = false;

  static init() {
    if (this._initialized) return;
    this._initialized = true;
    Hooks.on("dnd5e.postCreateUsageMessage", (activity, message) => {
      try { this._onCantripCast(activity, message); }
      catch (err) { console.warn(`${TAG} | activation hook failed:`, err); }
    });
    // V13-SAFE: handler reads a native element OR jQuery. Registered on BOTH the
    // V12 (`renderChatMessage`) and V13 (`renderChatMessageHTML`) hooks — the V13
    // one was missing, so on V13 the Green-Flame-Blade secondary button was inert.
    const _wireBladeCard = (message, html) => {
      if (!game.user.isGM) return;
      if (message?.flags?.[MODULE_ID]?.type !== "bladeCantrip") return;
      const el = (html instanceof HTMLElement) ? html : (html?.[0] ?? html);
      if (!el?.querySelectorAll) return;
      el.querySelectorAll(".ace-qol-gfb-secondary-btn:not([data-bound])").forEach(btn => {
        btn.setAttribute("data-bound", "1");
        btn.addEventListener("click", () => {
          try {
            this._applyGreenFlameSecondary(
              btn.dataset.casterUuid,
              btn.dataset.primaryUuid,
              Number(btn.dataset.diceCount ?? "0"),
            );
            btn.disabled = true;
            btn.innerHTML = `<i class="fas fa-check"></i> Applied`;
          } catch (err) { console.warn(`${TAG} | GFB secondary click failed:`, err); }
        });
      });
    };
    Hooks.on("renderChatMessage", _wireBladeCard);       // V12
    Hooks.on("renderChatMessageHTML", _wireBladeCard);   // V13

    // Booming Blade — auto-fire bonus thunder damage if the marked target
    // moves on its turn. updateToken fires on EVERY position change (drag,
    // ruler-move, AI move), so we GATE on "is it the marked actor's turn?"
    // to approximate "voluntary movement." Out-of-turn forced movement
    // (Thunderwave, Eldritch Blast Repelling, etc.) doesn't trigger.
    Hooks.on("updateToken", async (tokenDoc, changes /*, opts, userId */) => {
      if (game.users?.activeGM !== game.user) return;  // activeGM: Booming Blade bonus damage must only fire once
      try {
        if (!("x" in changes || "y" in changes)) return;
        const actor = tokenDoc?.actor;
        if (!actor) return;
        const bb = actor.getFlag?.(MODULE_ID, "boomingBlade");
        if (!bb || typeof bb !== "object") return;

        // Voluntary-movement gate: only fires when it's the marked actor's
        // own turn. Forced movement on another turn won't trigger.
        const currentActorId = game.combat?.combatant?.actorId ?? null;
        if (currentActorId !== actor.id) return;

        const dice = Number(bb.moveDice) || 2;
        const roll = await new Roll(`${dice}d8`).evaluate();
        const total = roll.total;

        // Apply damage, then clear the flag — Booming Blade only triggers
        // once per cast.
        try { await actor.applyDamage([{ value: total, type: "thunder" }]); }
        catch (err) { console.warn(`${TAG} | Booming Blade damage apply failed:`, err); }
        await actor.unsetFlag(MODULE_ID, "boomingBlade").catch(() => {});

        ChatMessage.create({
          content: `<div class="ace-qol-card" style="background:#10101a; border:2px solid #a39bcf; border-radius:6px; padding:10px 12px;">
            <div style="display:flex; align-items:center; gap:10px; margin-bottom:4px;">
              <i class="fas fa-bolt" style="color:#a39bcf; font-size:18px;"></i>
              <strong style="color:#c8c0e8;">Booming Blade — Movement Trigger</strong>
            </div>
            <div style="color:#dcd0e8; font-size:12px; line-height:1.45;">
              <strong>${foundry.utils.escapeHTML(actor.name)}</strong> takes <strong>${total} thunder</strong> (${dice}d8) for moving while echoing with ${foundry.utils.escapeHTML(bb.casterName ?? "the caster")}'s Booming Blade.
            </div>
          </div>`,
          speaker: ChatMessage.getSpeaker({ actor }),
          flags: { [MODULE_ID]: { type: "bladeCantrip", cantrip: "booming-blade-trigger" } },
        });
      } catch (err) {
        console.warn(`${TAG} | Booming Blade updateToken handler failed:`, err);
      }
    });

    // Booming Blade cleanup — clear the marker when its 1-round window
    // (caster's next turn) closes, even if the target never moved.
    Hooks.on("combatTurnChange", () => {
      if (game.users?.activeGM !== game.user) return;  // activeGM: marker expiry write must only fire once
      try { this._expireBoomingBladeIfDue(); }
      catch (err) { console.warn(`${TAG} | Booming Blade expiry sweep failed:`, err); }
    });

    console.log(`${TAG} | Blade cantrip handlers online (Booming Blade, Green-Flame Blade, True Strike).`);
  }

  /** Clear stale boomingBlade markers — applied previous round, never moved. */
  static async _expireBoomingBladeIfDue() {
    const currentRound = game.combat?.round ?? null;
    if (currentRound === null) return;
    for (const a of game.actors?.contents ?? []) {
      const bb = a?.getFlag?.(MODULE_ID, "boomingBlade");
      if (!bb || typeof bb !== "object") continue;
      // Booming Blade lasts until the start of the caster's next turn —
      // round+1 from when applied.
      if ((bb.appliedRound ?? 0) < currentRound) {
        try { await a.unsetFlag(MODULE_ID, "boomingBlade"); } catch (_) { /* non-fatal */ }
      }
    }
  }

  static async _onCantripCast(activity, message) {
    // Only the user who cast runs this.
    if (message?.author?.id && message.author.id !== game.user.id) return;

    const item = activity?.item;
    if (!item || item.type !== "spell") return;
    const nameLower = String(item.name ?? "").toLowerCase().trim();
    const actor = item.actor;
    if (!actor) return;

    // Caster level for scaling: character level for PCs, the cantrip-scale
    // logic stays the same across the three.
    const charLevel = actor.system?.details?.level ?? 1;
    const cantripDice = charLevel >= 17 ? 4 : charLevel >= 11 ? 3 : charLevel >= 5 ? 2 : 1;
    // Movement-trigger dice for Booming Blade is +(cantripDice) more on move.

    if (nameLower === "booming blade") {
      const target = game.user.targets?.first?.();
      const targetName = target?.name ?? "the target";
      const moveDice = cantripDice; // RAW (2014 + 2024): movement damage is 1d8 / 2d8 / 3d8 / 4d8 at L1-4 / 5-10 / 11-16 / 17+ — exactly the cantrip tier (was cantripDice+1 → over-rolled one die at every tier).

      // Mark the target's actor with the movement-trigger payload. The
      // updateToken listener in init() reads this on position change and
      // fires bonus damage. Auto-clears at start of caster's next turn via
      // the combatTurnChange handler (we store the round here for the
      // cleanup gate).
      try {
        if (target?.actor) {
          await target.actor.setFlag(MODULE_ID, "boomingBlade", {
            moveDice,
            casterUuid:     actor.uuid,
            casterName:     actor.name,
            appliedRound:   game.combat?.round ?? 0,
            combatId:       game.combat?.id ?? null,
          });
        }
      } catch (_) { /* non-fatal */ }

      this._postCantripCard("booming-blade", item, actor, target,
        `<strong>${targetName}</strong> takes <strong>${moveDice}d8 thunder</strong> if they move voluntarily before the start of ${actor.name}'s next turn.`,
        "#a39bcf", "fa-bolt"
      );
      return;
    }

    if (nameLower === "green-flame blade" || nameLower === "green flame blade") {
      const target = game.user.targets?.first?.();
      const tgtUuid = target?.document?.uuid ?? target?.uuid;
      const casterUuid = actor.uuid;
      const targetName = target?.name ?? "the primary target";
      const abilKey = actor.system?.attributes?.spellcasting ?? "cha";
      const abilMod = actor.system?.abilities?.[abilKey]?.mod ?? 0;
      const secondaryDice = cantripDice - 1; // 2024: ability mod at L1, +Xd8 at L5+
      const damageDescPart = secondaryDice > 0 ? `${secondaryDice}d8 + ` : "";
      this._postCantripCard("green-flame-blade", item, actor, target,
        `A second creature within 5 ft of <strong>${targetName}</strong> takes <strong>${damageDescPart}${abilMod} fire</strong> damage.`,
        "#7ed957", "fa-fire",
        `<div style="margin-top:6px;">
          <button class="ace-qol-btn ace-qol-gfb-secondary-btn"
                  data-caster-uuid="${casterUuid}"
                  data-primary-uuid="${tgtUuid}"
                  data-dice-count="${secondaryDice}"
                  style="background:#0a1a08; color:#dfffdf; border:1px solid #7ed957; border-radius:4px; padding:4px 10px; font-size:12px;">
            <i class="fas fa-fire"></i> Apply to Adjacent Enemy
          </button>
        </div>`
      );
      return;
    }

    if (nameLower === "true strike") {
      // Pop a dialog asking whether to swap weapon damage type → radiant.
      const swap = await this._askTrueStrikeSwap(actor, item);
      if (swap) {
        // One-shot flag; damage-calculator reads it and clears.
        await actor.setFlag(MODULE_ID, "trueStrike.swapDamage", true);
        ChatMessage.create({
          content: `<div class="ace-qol-card" style="background:#1a1a08; border:2px solid #ffd54f; border-radius:6px; padding:8px 10px;">
            <strong style="color:#ffd54f;"><i class="fas fa-sun"></i> True Strike — Radiant Swap</strong>
            <div style="color:#fff7d0; font-size:12px; margin-top:3px;">
              ${foundry.utils.escapeHTML(actor.name)}'s weapon damage on this attack will be <strong>Radiant</strong> instead of its normal type.
            </div>
          </div>`,
          speaker: ChatMessage.getSpeaker({ actor }),
          flags: { [MODULE_ID]: { type: "bladeCantrip", cantrip: "true-strike" } },
        });
      }
      return;
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  //  True Strike — radiant-swap prompt
  // ──────────────────────────────────────────────────────────────────────────

  static async _askTrueStrikeSwap(actor, item) {
    return new Promise((resolve) => {
      const dialog = new Dialog({
        title: "True Strike — Damage Type",
        content: `<div style="padding:8px; font-size:14px; line-height:1.5;">
          Replace this attack's weapon damage type with <strong>Radiant</strong>?
          <br><em style="color:#888; font-size:12px;">RAW (2024): "You can replace the weapon's damage type with Radiant damage."</em>
        </div>`,
        buttons: {
          yes:  { icon: '<i class="fas fa-sun"></i>',    label: "Yes, swap to Radiant", callback: () => resolve(true) },
          no:   { icon: '<i class="fas fa-sword"></i>',  label: "No, keep weapon type",  callback: () => resolve(false) },
        },
        default: "yes",
        close: () => resolve(false),
      });
      dialog.render(true);
    });
  }

  // ──────────────────────────────────────────────────────────────────────────
  //  Green-Flame Blade — secondary target damage
  // ──────────────────────────────────────────────────────────────────────────

  static async _applyGreenFlameSecondary(casterUuid, primaryUuid, secondaryDice) {
    const casterDoc = await fromUuid(casterUuid).catch(() => null);
    const caster = casterDoc?.documentName === "Actor" ? casterDoc : casterDoc?.actor ?? null;
    if (!caster) {
      ui.notifications?.warn("Green-Flame Blade: caster not resolved.");
      return;
    }
    const primaryTokenDoc = await fromUuid(primaryUuid).catch(() => null);
    const primaryTok = (primaryTokenDoc?.documentName === "Token")
                       ? primaryTokenDoc.object
                       : primaryTokenDoc?.getActiveTokens?.()[0] ?? null;
    if (!primaryTok) {
      ui.notifications?.warn("Green-Flame Blade: primary target not on canvas — pick adjacent manually.");
      return;
    }
    // RAW GFB: a different creature within 5 ft of the primary target.
    // Nearest-edge, size-aware, 3D (canonical — geometry-utils).
    const candidates = canvas.tokens?.placeables?.filter(t =>
      t !== primaryTok &&
      t.actor &&
      aceWithinFt(t, primaryTok, 5)
    ) ?? [];
    if (!candidates.length) {
      ui.notifications?.warn("Green-Flame Blade: no creatures within 5 ft of the primary target.");
      return;
    }
    // For simplicity, hit the FIRST adjacent. GM can repick by targeting first.
    const secondary = game.user.targets?.first?.() ?? candidates[0];
    const abilKey = caster.system?.attributes?.spellcasting ?? "cha";
    const abilMod = caster.system?.abilities?.[abilKey]?.mod ?? 0;
    let total = abilMod;
    if (secondaryDice > 0) {
      const roll = await new Roll(`${secondaryDice}d8`).evaluate();
      total += roll.total;
    }
    try {
      await secondary.actor?.applyDamage([{ value: total, type: "fire" }]);
      console.log(`${TAG} | GFB secondary damage: ${secondary.name} takes ${total} fire`);
      ChatMessage.create({
        content: `<div class="ace-qol-card" style="background:#0a1a08; border:2px solid #7ed957; border-radius:6px; padding:8px 10px;">
          <strong style="color:#7ed957;"><i class="fas fa-fire"></i> Green-Flame Blade — Secondary</strong>
          <div style="color:#dfffdf; font-size:12px; margin-top:3px;">
            ${foundry.utils.escapeHTML(secondary.name)} takes <strong>${total} fire</strong> damage.
          </div>
        </div>`,
        speaker: ChatMessage.getSpeaker({ actor: caster }),
      });
    } catch (err) {
      console.warn(`${TAG} | GFB damage apply failed:`, err);
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  //  Card rendering helper
  // ──────────────────────────────────────────────────────────────────────────

  static _postCantripCard(cantripId, item, actor, target, body, color, icon, extraHtml = "") {
    const itemName = foundry.utils.escapeHTML(item?.name ?? "Cantrip");
    ChatMessage.create({
      content: `<div class="ace-qol-card ace-qol-cantrip-card"
                     style="background:#0e0e10; border:2px solid ${color}; border-radius:6px; padding:10px 12px;">
        <div style="display:flex; align-items:center; gap:10px; margin-bottom:4px;">
          <i class="fas ${icon}" style="color:${color}; font-size:18px;"></i>
          <strong style="color:${color}; font-size:14px;">${itemName}</strong>
        </div>
        <div style="color:#e0e0e0; font-size:12px; line-height:1.45;">${body}</div>
        ${extraHtml}
      </div>`,
      speaker: ChatMessage.getSpeaker({ actor }),
      flags: { [MODULE_ID]: { type: "bladeCantrip", cantrip: cantripId } },
    });
  }
}
