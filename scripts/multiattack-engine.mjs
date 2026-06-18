// ─── ACE: QOL — Multiattack / Extra-Attack Chain Engine ──────────────────────
// When a creature with "Multiattack" — or a PC with "Extra Attack" — makes its
// FIRST weapon attack of the turn, ACE pops a reactive dialog that drives the
// REST of the attack sequence as square pushbuttons: one per attack type, each
// badged with its remaining count. Clicking a button fires that weapon through
// the normal attack pipeline (hit / miss / damage / riders all flow) and ticks
// the count down. When the chain is spent the dialog closes itself.
//
// SAFETY PRINCIPLE — the engine NEVER auto-fires. Every swing is an explicit
// click. So even if a stat block's Multiattack text is mis-parsed, the worst
// case is badge counts that are slightly off — the GM/player simply clicks the
// attacks they actually want. A parse error can never force a wrong attack.
//
// Two modes:
//   • PARSED   — the Multiattack description names specific attacks ("two claws
//                and one bite") and those names match the actor's weapons →
//                one badged button per named attack.
//   • FALLBACK — the description is generic ("makes two attacks"), or it's a
//                PC's Extra Attack → "Attack X of N" with every available
//                weapon as a free pick each time.
//
// Works for NPCs (Multiattack feature) and PCs (Extra Attack). Dark/gold
// reactive-dialog styling to match the Counterspell / Legendary Resistance
// prompts. Setting: `multiattackChain` (default ON).
// ──────────────────────────────────────────────────────────────────────────────

import { MODULE_ID } from "./ace-qol.mjs";

const NUM_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8 };
const ACCENT = "#ffd54f";

export class MultiattackEngine {
  static _seenRolls = new WeakSet();   // dual-hook dedupe (rollAttackV2 + rollAttack share a Roll)
  static _inFlight  = new Set();       // actorIds whose chain is FIRING an attack — suppresses re-trigger
  static _chained   = new Set();       // actorIds who already opened a chain this turn

  static init() {
    try {
      game.settings.register(MODULE_ID, "multiattackChain", {
        name: "Multiattack / Extra-Attack Chain Pop-up",
        hint: "When a creature with Multiattack — or a PC with Extra Attack — makes its first attack of the turn, show a pop-up that drives the remaining attacks as one-click weapon buttons (badged with their counts). It NEVER auto-attacks — you click each swing. Default ON.",
        scope: "world", config: true, type: Boolean, default: true,
      });
    } catch (_) { /* already registered */ }

    const trigger = (rolls, data) => {
      try { MultiattackEngine._onAttack(rolls, data); }
      catch (e) { console.warn(`${MODULE_ID} | MultiattackEngine trigger failed:`, e); }
    };
    Hooks.on("dnd5e.rollAttackV2", trigger);
    Hooks.on("dnd5e.rollAttack",   trigger);

    // Per-turn gating reset
    Hooks.on("combatTurn",  () => MultiattackEngine._chained.clear());
    Hooks.on("combatRound", () => MultiattackEngine._chained.clear());
    Hooks.on("deleteCombat", () => { MultiattackEngine._chained.clear(); MultiattackEngine._inFlight.clear(); });

    console.debug(`${MODULE_ID} | MultiattackEngine online.`);
  }

  static _enabled() {
    try { return game.settings.get(MODULE_ID, "multiattackChain") !== false; } catch (_) { return true; }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Trigger
  // ═══════════════════════════════════════════════════════════════════════════

  static _onAttack(rolls, data) {
    if (!this._enabled()) return;

    // Dual-hook dedupe — rollAttackV2 + rollAttack fire with the same Roll.
    const rollRef = rolls?.[0];
    if (rollRef && typeof rollRef === "object") {
      if (this._seenRolls.has(rollRef)) return;
      this._seenRolls.add(rollRef);
    }

    const subject = data?.subject;
    const item  = subject?.item;
    const actor = subject?.actor;
    if (!actor || !item) return;

    // Chain-fired attacks must NOT re-trigger the prompt.
    if (this._inFlight.has(actor.id)) return;
    // Only a real weapon/attack swing counts.
    if (!this._isAttackItem(item)) return;
    // One chain offer per actor per turn.
    if (this._chained.has(actor.id)) return;

    // Show on exactly ONE client: the PC's owning player, else the active GM.
    const targetUserId = this._dialogUserId(actor);
    if (!targetUserId || game.user.id !== targetUserId) return;

    // Build the plan. Null → this actor has no Multiattack / Extra Attack, or the
    // multiattack was a single swing with nothing left to chain.
    const plan = this._buildPlan(actor, item);
    if (!plan) return;

    this._chained.add(actor.id);
    // Defer briefly so the triggering attack's own card posts first.
    setTimeout(() => {
      this._openChainDialog(actor, plan).catch(e => console.warn(`${MODULE_ID} | Multiattack dialog failed:`, e));
    }, 250);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Detection / plan building
  // ═══════════════════════════════════════════════════════════════════════════

  /** True if the item can make an attack (weapon type, or has an attack activity). */
  static _isAttackItem(item) {
    if (!item) return false;
    if (item.type === "weapon") return true;
    try {
      const acts = item.system?.activities;
      const list = acts ? (typeof acts.values === "function" ? [...acts.values()] : Object.values(acts)) : [];
      return list.some(a => a?.type === "attack");
    } catch (_) { return false; }
  }

  /** The actor's available attack options (buttons + parse targets). */
  static _getAttackItems(actor) {
    const out = [];
    for (const it of actor.items ?? []) {
      if (!this._isAttackItem(it)) continue;
      // For PCs, skip unequipped carried weapons (don't surface backpack daggers).
      if (it.type === "weapon" && actor.hasPlayerOwner && it.system?.equipped === false) continue;
      out.push(it);
    }
    return out;
  }

  /** Which single client shows the dialog: PC's owning player, else active GM. */
  static _dialogUserId(actor) {
    if (actor.hasPlayerOwner) {
      const owner = game.users?.find(u => u.active && !u.isGM && actor.testUserPermission(u, "OWNER"));
      if (owner) return owner.id;
    }
    return game.users?.activeGM?.id ?? null;
  }

  /**
   * @returns {null | {mode:"parsed", entries:[{item,count}], attackItems}
   *                 | {mode:"fallback", total:number, remaining:number, attackItems}}
   */
  static _buildPlan(actor, triggerItem) {
    const attackItems = this._getAttackItems(actor);
    if (!attackItems.length) return null;

    const isPC = actor.hasPlayerOwner;
    const maFeature   = actor.items?.find(i => /multiattack/i.test(i.name ?? ""));
    const extraAttack = isPC && actor.items?.find(i =>
      /extra attack/i.test(i.name ?? "")
      // Identifier survives renames/translation — SRD Extra Attack slugs to "extra-attack".
      || (i.identifier ?? i.system?.identifier ?? "") === "extra-attack");
    if (!maFeature && !extraAttack) return null;   // nothing to chain

    // ── PARSED mode (NPC Multiattack naming specific attacks) ──
    if (maFeature) {
      const text = this._plainText(maFeature.system?.description?.value ?? "");
      const parsed = this._parseMultiattack(text, attackItems);
      if (parsed && parsed.length) {
        this._decrementTrigger(parsed, triggerItem);   // the first swing already happened
        const total = parsed.reduce((s, e) => s + e.count, 0);
        if (total <= 0) return null;                    // single-swing multiattack, nothing left
        return { mode: "parsed", entries: parsed, attackItems };
      }
    }

    // ── FALLBACK mode (generic text or PC Extra Attack) ──
    let n = 2;   // covers most Extra Attack + generic "two attacks"
    if (maFeature) {
      const t = this._plainText(maFeature.system?.description?.value ?? "");
      const m = t.match(/\b(one|two|three|four|five|six|seven|eight|\d+)\b\s+(?:\w+\s+){0,2}attacks?\b/i);
      if (m) {
        const v = NUM_WORDS[m[1].toLowerCase()] ?? parseInt(m[1], 10);
        if (v >= 1 && v <= 10) n = v;
      }
    } else if (extraAttack) {
      // PC Extra Attack — base 2; only Fighter scales further (3 @ L11, 4 @ L20).
      const fl = actor.items?.find(i => i.type === "class" && /fighter/i.test(i.name ?? ""))?.system?.levels ?? 0;
      n = fl >= 20 ? 4 : fl >= 11 ? 3 : 2;
    }
    const remaining = Math.max(1, n - 1);   // the triggering attack was #1
    return { mode: "fallback", total: n, remaining, attackItems };
  }

  /** Parse "two claws and one bite" → [{item:Claw,count:2},{item:Bite,count:1}]. */
  static _parseMultiattack(text, attackItems) {
    if (!text) return null;
    const lower = text.toLowerCase();
    const entries = [];
    for (const item of attackItems) {
      // Strip parenthetical qualifiers so "Bite (Hybrid Form)" / "Claws (Bear
      // Form)" (lycanthropes, Wild Shape) still match "...two bites..." in the
      // Multiattack text. Common in Curse of Strahd stat blocks.
      const base = (item.name ?? "").toLowerCase().replace(/\(.*?\)/g, "").trim();
      if (!base) continue;
      const esc = base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      // <count> within ~3 words before the (optionally pluralized) weapon name.
      const re = new RegExp(`\\b(one|two|three|four|five|six|seven|eight|\\d+)\\b(?:\\s+\\w+){0,3}?\\s+${esc}s?\\b`, "i");
      const m = lower.match(re);
      if (m) {
        const cnt = NUM_WORDS[m[1].toLowerCase()] ?? parseInt(m[1], 10);
        if (cnt >= 1 && cnt <= 12) entries.push({ item, count: cnt });
      }
    }
    return entries.length ? entries : null;
  }

  static _decrementTrigger(entries, triggerItem) {
    const e = entries.find(en => en.item?.id === triggerItem?.id)
           ?? entries.find(en => this._nameMatch(en.item?.name, triggerItem?.name));
    if (e && e.count > 0) e.count -= 1;
  }

  static _plainText(html) {
    return String(html ?? "")
      .replace(/<[^>]+>/g, " ")
      .replace(/&[a-z]+;/gi, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  static _nameMatch(a, b) {
    const norm = s => String(s ?? "").toLowerCase().replace(/s\b/g, "").trim();
    return !!a && !!b && norm(a) === norm(b);
  }

  /** A light melee weapon — for off-hand two-weapon-fighting detection. */
  static _isLightMelee(item) {
    try {
      const p = item.system?.properties;
      const light = (p?.has?.("lgt")) || (Array.isArray(p) && p.includes("lgt"));
      const wtype = String(item.system?.type?.value ?? "");
      const melee = /M$/.test(wtype) || wtype === "natural" || wtype === "improv";
      return !!light && melee;
    } catch (_) { return false; }
  }

  /**
   * Bonus-action attacks to surface as a SEPARATE, clearly-labelled row:
   *   • kind "bonus"   — an attack activity whose activation type is "bonus"
   *                      (Polearm Master, Crossbow Expert, Flurry of Blows, …).
   *                      Data-driven: reads the activity's action cost, so no
   *                      name-matching and it catches well-built homebrew too.
   *   • kind "offhand" — a SECOND equipped light melee weapon (two-weapon
   *                      fighting). Heuristic, since TWF isn't a discrete activity.
   * @returns {Array<{id,name,img,activityId:string|null,kind:"bonus"|"offhand"}>}
   */
  static _getBonusAttacks(actor) {
    const out = [];
    const seen = new Set();

    // (a) attack activities flagged as bonus-action.
    for (const it of actor.items ?? []) {
      if (!this._isAttackItem(it)) continue;
      const acts = it.system?.activities;
      const list = acts ? (typeof acts.values === "function" ? [...acts.values()] : Object.values(acts)) : [];
      const bonusAct = list.find(a => a?.type === "attack" && a?.activation?.type === "bonus");
      if (bonusAct) {
        out.push({ id: it.id, name: it.name, img: it.img, activityId: bonusAct.id, kind: "bonus" });
        seen.add(it.id);
      }
    }

    // (b) off-hand TWF — the SECOND equipped light melee weapon.
    const lightMelee = (actor.items ?? []).filter(it =>
      it.type === "weapon" && it.system?.equipped && this._isAttackItem(it) && this._isLightMelee(it));
    if (lightMelee.length >= 2) {
      const offhand = lightMelee[1];
      if (offhand && !seen.has(offhand.id)) {
        out.push({ id: offhand.id, name: offhand.name, img: offhand.img, activityId: null, kind: "offhand" });
        seen.add(offhand.id);
      }
    }

    return out;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Dialog
  // ═══════════════════════════════════════════════════════════════════════════

  static async _openChainDialog(actor, plan) {
    const portrait = actor.img ?? actor.prototypeToken?.texture?.src ?? "icons/svg/mystery-man.svg";
    const itemById = (id) => actor.items?.get?.(id) ?? actor.items?.find?.(i => i.id === id);

    // Mutable in-memory state (we never re-read the stat block mid-chain).
    const state = plan.mode === "parsed"
      ? { mode: "parsed", entries: plan.entries.map(e => ({ id: e.item.id, name: e.item.name, img: e.item.img, count: e.count })) }
      : { mode: "fallback", total: plan.total, remaining: plan.remaining,
          weapons: plan.attackItems.map(it => ({ id: it.id, name: it.name, img: it.img })) };

    // Bonus-action options — a separate, clearly-labelled row. Soft guard only:
    // after one is used we grey the whole row (one bonus action per turn).
    const BONUS_ACCENT = "#6fa8dc";
    const bonusAttacks = MultiattackEngine._getBonusAttacks(actor);
    state.bonusUsed = false;

    const remainingCount = () => state.mode === "parsed"
      ? state.entries.reduce((s, e) => s + e.count, 0)
      : state.remaining;

    // Done only when no multiattack swings remain AND the bonus row is absent
    // or already spent — so a leftover bonus action keeps the pop-up open.
    const shouldClose = () => remainingCount() <= 0 && (!bonusAttacks.length || state.bonusUsed);

    const squareBtn = (id, name, img, badge) => `
      <button type="button" class="ace-ma-btn" data-item-id="${id}" title="${name}"
        style="position:relative;width:84px;height:84px;display:flex;flex-direction:column;align-items:center;justify-content:flex-start;gap:3px;padding:6px 4px;background:linear-gradient(180deg,#241a0c 0%,#140d05 100%);border:2px solid ${ACCENT}55;border-radius:8px;cursor:pointer;color:#f0e4c0;transition:border-color 0.15s,box-shadow 0.15s;">
        <img src="${img || "icons/svg/sword.svg"}" style="width:42px;height:42px;object-fit:contain;border-radius:4px;pointer-events:none;" />
        <span style="font-size:10px;line-height:1.1;text-align:center;max-width:78px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;pointer-events:none;">${name}</span>
        ${badge > 1 ? `<span style="position:absolute;top:-8px;right:-8px;min-width:22px;height:22px;padding:0 5px;display:flex;align-items:center;justify-content:center;background:${ACCENT};color:#1a1208;font-weight:800;font-size:13px;border-radius:11px;border:2px solid #140d05;pointer-events:none;">${badge}</span>` : ""}
      </button>`;

    // Bonus-action button — blue accent + a "BA" corner tag, greyed once spent.
    const bonusBtn = (b) => {
      const dim = state.bonusUsed ? "opacity:0.4;pointer-events:none;filter:grayscale(0.6);" : "";
      const label = b.kind === "offhand" ? `Off-hand: ${b.name}` : b.name;
      return `
        <button type="button" class="ace-ma-bonus-btn" data-item-id="${b.id}" data-activity-id="${b.activityId ?? ""}" title="${label} (Bonus Action)"
          style="position:relative;width:84px;height:84px;display:flex;flex-direction:column;align-items:center;justify-content:flex-start;gap:3px;padding:6px 4px;background:linear-gradient(180deg,#0c1822 0%,#060d14 100%);border:2px solid ${BONUS_ACCENT}66;border-radius:8px;cursor:pointer;color:#dfeaf5;transition:border-color 0.15s,box-shadow 0.15s;${dim}">
          <img src="${b.img || "icons/svg/sword.svg"}" style="width:42px;height:42px;object-fit:contain;border-radius:4px;pointer-events:none;" />
          <span style="font-size:10px;line-height:1.1;text-align:center;max-width:78px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;pointer-events:none;">${label}</span>
          <span style="position:absolute;top:-8px;left:-8px;padding:0 5px;height:18px;display:flex;align-items:center;justify-content:center;background:${BONUS_ACCENT};color:#06121c;font-weight:800;font-size:10px;border-radius:9px;border:2px solid #060d14;pointer-events:none;">BA</span>
        </button>`;
    };

    const buildHtml = () => {
      const buttons = state.mode === "parsed"
        ? state.entries.filter(e => e.count > 0).map(e => squareBtn(e.id, e.name, e.img, e.count)).join("")
        : state.weapons.map(w => squareBtn(w.id, w.name, w.img, 1)).join("");

      const subhead = state.mode === "parsed"
        ? `Remaining attacks — click each to swing at your current target.`
        : `Attack ${state.total - state.remaining + 1} of ${state.total} — pick a weapon (targets your current target).`;

      return `
        <div class="ace-ma-prompt" style="background:linear-gradient(180deg,#1a1410 0%,#0f0a08 100%);border:2px solid ${ACCENT};border-radius:6px;padding:12px 14px;color:#f0e4c0;font-family:'Signika','Helvetica Neue',sans-serif;">
          <div style="display:flex;align-items:center;gap:10px;border-bottom:1px solid #4a3a28;padding-bottom:6px;margin-bottom:10px;">
            <img src="${portrait}" style="width:40px;height:40px;border-radius:50%;object-fit:cover;border:2px solid ${ACCENT};flex-shrink:0;" />
            <div style="display:flex;flex-direction:column;min-width:0;">
              <span style="font-weight:700;font-size:15px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${actor.name}</span>
              <span style="font-size:13px;font-weight:700;color:${ACCENT};text-transform:uppercase;letter-spacing:0.5px;"><i class="fas fa-burst"></i> <i class="fas fa-hand-fist"></i> Multiattack</span>
            </div>
          </div>
          <div style="font-size:13px;color:#c0b288;margin-bottom:10px;">${subhead}</div>
          <div class="ace-ma-grid" style="display:flex;flex-wrap:wrap;gap:8px;justify-content:flex-start;">${buttons}</div>
          ${bonusAttacks.length ? `
          <div style="border-top:1px dashed #3a4a5a;margin-top:12px;padding-top:9px;">
            <div style="font-size:12px;font-weight:700;color:${BONUS_ACCENT};text-transform:uppercase;letter-spacing:0.5px;margin-bottom:7px;">
              <i class="fas fa-bolt"></i> Bonus Action${state.bonusUsed ? ` <span style="color:#a06a4f;font-weight:600;text-transform:none;letter-spacing:0;">— used this turn</span>` : ``}
            </div>
            <div class="ace-ma-bonus-grid" style="display:flex;flex-wrap:wrap;gap:8px;justify-content:flex-start;">${bonusAttacks.map(bonusBtn).join("")}</div>
          </div>` : ``}
        </div>`;
    };

    let dialog;
    let firing = false;

    const wireGrid = (promptNode) => {
      promptNode.querySelectorAll(".ace-ma-btn").forEach(b => {
        b.addEventListener("mouseenter", () => { b.style.borderColor = ACCENT; b.style.boxShadow = `0 0 8px ${ACCENT}88`; });
        b.addEventListener("mouseleave", () => { b.style.borderColor = `${ACCENT}55`; b.style.boxShadow = "none"; });
        b.addEventListener("click", async (ev) => {
          ev.preventDefault();
          if (firing) return;
          firing = true;
          const id = b.getAttribute("data-item-id");
          const item = itemById(id);
          // Lock the grid (main + bonus) while the swing resolves.
          promptNode.querySelectorAll(".ace-ma-btn, .ace-ma-bonus-btn").forEach(x => { x.disabled = true; x.style.opacity = "0.45"; x.style.cursor = "wait"; });
          try {
            if (item) await this._fireAttack(actor, item);
          } catch (e) {
            console.warn(`${MODULE_ID} | Multiattack fire failed:`, e);
          }
          // Decrement the plan.
          if (state.mode === "parsed") {
            const e = state.entries.find(en => en.id === id);
            if (e && e.count > 0) e.count -= 1;
          } else {
            state.remaining = Math.max(0, state.remaining - 1);
          }
          firing = false;
          if (shouldClose()) { dialog.close(); return; }
          // Re-render the prompt block in place + re-wire.
          const el = dialog.element?.[0] ?? dialog.element;
          const node = el?.querySelector?.(".ace-ma-prompt");
          if (node) {
            node.outerHTML = buildHtml();
            const fresh = el.querySelector(".ace-ma-prompt");
            if (fresh) wireGrid(fresh);
          }
        });
      });

      // ── Bonus-action buttons (separate row) — soft one-per-turn guard ──
      promptNode.querySelectorAll(".ace-ma-bonus-btn").forEach(b => {
        b.addEventListener("mouseenter", () => { if (!state.bonusUsed) { b.style.borderColor = BONUS_ACCENT; b.style.boxShadow = `0 0 8px ${BONUS_ACCENT}88`; } });
        b.addEventListener("mouseleave", () => { b.style.borderColor = `${BONUS_ACCENT}66`; b.style.boxShadow = "none"; });
        b.addEventListener("click", async (ev) => {
          ev.preventDefault();
          if (firing || state.bonusUsed) return;
          firing = true;
          const id = b.getAttribute("data-item-id");
          const actId = b.getAttribute("data-activity-id") || null;
          const item = itemById(id);
          const activity = (actId && item) ? (item.system?.activities?.get?.(actId) ?? null) : null;
          promptNode.querySelectorAll(".ace-ma-btn, .ace-ma-bonus-btn").forEach(x => { x.disabled = true; x.style.opacity = "0.45"; x.style.cursor = "wait"; });
          try {
            if (item) await this._fireAttack(actor, item, activity);
          } catch (e) {
            console.warn(`${MODULE_ID} | Multiattack bonus fire failed:`, e);
          }
          state.bonusUsed = true;     // soft guard — one bonus action per turn
          firing = false;
          if (shouldClose()) { dialog.close(); return; }
          const el = dialog.element?.[0] ?? dialog.element;
          const node = el?.querySelector?.(".ace-ma-prompt");
          if (node) {
            node.outerHTML = buildHtml();
            const fresh = el.querySelector(".ace-ma-prompt");
            if (fresh) wireGrid(fresh);
          }
        });
      });
    };

    dialog = new Dialog({
      title: `Multiattack — ${actor.name}`,
      content: buildHtml(),
      buttons: {
        done: { icon: '<i class="fas fa-flag-checkered"></i>', label: "Done", callback: () => {} },
      },
      default: "done",
      render: (jq) => {
        const root = jq?.[0] ?? jq;
        const node = root?.querySelector?.(".ace-ma-prompt") ?? root;
        if (node) wireGrid(node);
      },
      close: () => {
        // Out of combat there's no turn-change to reset the per-actor gate, so
        // clear it on close → a later separate attack can re-offer the chain.
        if (!game.combat?.started) MultiattackEngine._chained.delete(actor.id);
      },
    }, { width: 360 });
    dialog.render(true);
  }

  /**
   * Fire one real attack with the given weapon through the dnd5e use flow
   * (fast-forward, same pattern as the OA engine). The `_inFlight` guard keeps
   * the attack the chain fires from re-triggering this very prompt. The swing
   * targets whatever the user currently has targeted, and flows through the
   * normal AttackPipeline (hit/miss/damage/riders).
   */
  static async _fireAttack(actor, item, activity = null) {
    this._inFlight.add(actor.id);
    try {
      // Fire a SPECIFIC activity when given (bonus-action attacks may share a
      // weapon with its normal action attack) — else the item's default attack.
      if (activity && typeof activity.use === "function") {
        await activity.use({ event: { shiftKey: true, target: document.body } }, {}, {});
      } else {
        await item.use({ event: { shiftKey: true, target: document.body } }, {}, {});
      }
    } finally {
      // Hold the guard a beat past use() so BOTH dual hooks for this swing are
      // covered, then release.
      setTimeout(() => this._inFlight.delete(actor.id), 250);
    }
  }
}
