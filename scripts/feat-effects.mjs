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
//   • Crusher         — bludgeoning hit: card with "Push 5 ft" button +
//                       crit bonus: card noting "advantage on next attack
//                       vs this target until start of your next turn".
//                       Once per turn.
//   • Slasher         — slashing hit: card with "Speed -10 ft until start
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
    Hooks.on("renderChatMessage", (message, html /*, data */) => {
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
    });
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
        `${actor.name} may push <strong>${targetName} 5 ft</strong> to an unoccupied space.`,
        "#b07050", "fa-hammer",
        `<div style="margin-top:6px;">
          <button class="ace-qol-btn ace-qol-crusher-push-btn"
                  data-attacker-uuid="${attUuid}"
                  data-target-uuid="${tgtUuid}"
                  style="background:#3a1a0a; color:#ffe1c8; border:1px solid #b07050; border-radius:4px; padding:4px 10px; font-size:12px;">
            <i class="fas fa-hand-back-fist"></i> Push 5 ft
          </button>
        </div>`
      );
    }

    if (isCrit) {
      this._postFeatCard("crusher-crit", item, actor, target,
        `Attack rolls against ${targetName} have <strong>Advantage</strong> until the start of ${actor.name}'s next turn.`,
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
        `${targetName}'s speed is reduced by <strong>10 ft</strong> until the start of ${actor.name}'s next turn.`,
        "#a02828", "fa-sword"
      );
    }

    if (isCrit) {
      this._postFeatCard("slasher-crit", item, actor, target,
        `${targetName} has <strong>Disadvantage</strong> on attack rolls against anyone except ${actor.name} until the start of ${actor.name}'s next turn.`,
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
      this._postFeatCard("piercer-crit", item, actor, target,
        `On this critical hit with piercing damage, you may roll <strong>one additional damage die</strong>.`,
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
    const pushPx = cell * 1; // 5 ft
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
    for (const k of ["crusher.usedThisTurn", "slasher.usedThisTurn", "piercer.usedThisTurn"]) {
      try {
        if (actor.getFlag?.(MODULE_ID, k)) await actor.unsetFlag(MODULE_ID, k);
      } catch (_) { /* non-fatal */ }
    }
  }
}
