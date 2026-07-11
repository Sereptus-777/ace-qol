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
  static _activeChains = new Set();    // actorIds with a chain loop RUNNING right now (stale-gate healing)
  static _openPrompts  = new Map();    // actorId → the OPEN chain Dialog (front it instead of silent-suppressing)

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
    Hooks.on("combatTurn",  () => {
      MultiattackEngine._chained.clear();
      // Close any open chain pop-up for an actor who is no longer the active
      // combatant — covers fumble-ends-turn + GM manual skip (2026-07-10).
      try {
        const curId = game.combat?.combatant?.actor?.id;
        for (const [aid, dlg] of MultiattackEngine._openPrompts) {
          if (aid !== curId) { try { dlg?.close?.(); } catch (_) {} }
        }
      } catch (_) { /* non-fatal */ }
    });
    Hooks.on("combatRound", () => MultiattackEngine._chained.clear());
    Hooks.on("deleteCombat", () => { MultiattackEngine._chained.clear(); MultiattackEngine._inFlight.clear(); MultiattackEngine._activeChains.clear(); });

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
    // Suppress a new offer ONLY while a chain for this actor is genuinely
    // pending or running. A COMPLETED chain resets immediately — in combat
    // or out (Johnny 2026-07-10 17:34: "the second swing was a second
    // swing — that's it, reset"). The engine never auto-fires, so re-offering
    // is a convenience, not an action-economy violation — enforcing turn
    // economy is the GM's call, and the turn/round hooks still clear
    // leftovers each turn as a belt.
    if (this._chained.has(actor.id)) {
      if (this._activeChains.has(actor.id)) {
        // A chain for this actor is genuinely open — NEVER silently swallow
        // the swing (indistinguishable from a bug; 2026-07-10 17:36). Front
        // the open pop-up if there is one and say so out loud.
        const open = this._openPrompts.get(actor.id);
        try { open?.bringToTop?.(); } catch (_) { /* window gone — toast still fires */ }
        ui.notifications?.info(`${actor.name}: a multiattack pop-up is already open — pick the next swing there, or hit End Attacks to reset.`);
        console.log(`${MODULE_ID} | [chain] swing while chain open for ${actor.name} — fronted the existing pop-up`);
        return;
      }
      console.log(`${MODULE_ID} | [chain] stale gate for ${actor.name} (no chain running) — cleared, offering fresh chain`);
      this._chained.delete(actor.id);
    }

    // Show on the client that ROLLED the swing — this hook only fires there,
    // so hook locality IS the routing. The old owner-preference logic sent a
    // GM-rolled swing's pop-up to the owning player's client, which never saw
    // the roll hook at all → pop-up NOWHERE the moment a player window was
    // connected (live-fire 2026-07-10 17:04, Syrax/Phyraxis). A player rolling
    // their own attack still gets their own pop-up — their client is the one
    // firing this hook.

    // Build the plan. Null → this actor has no Multiattack / Extra Attack, or the
    // multiattack was a single swing with nothing left to chain.
    const plan = this._buildPlan(actor, item);
    if (!plan) return;

    this._chained.add(actor.id);
    this._activeChains.add(actor.id);   // pending from THIS moment (trigger → pop-up gap included)
    // Snapshot swing 1's target(s) NOW — while the roll still has them locked.
    // ACE flows auto-release targets after damage resolves, and the pipeline
    // reads game.user.targets at roll time: firing a chain swing with an
    // empty set makes it skip resolution silently — the "nothing happens"
    // bug (live-fire 2026-07-10 11:15; same lesson as the OA v0.7.24 fix).
    const initialTargetIds = [...(game.user.targets ?? [])].map(t => t.id);
    // Enter the chain only AFTER swing 1 fully resolves (Johnny 2026-07-10,
    // the exact spec): a MISS resolves the instant the verdict lands; a HIT
    // resolves when the damage card is created (= Roll Damage was pushed).
    // HOOK-DRIVEN — timers never open a prompt (v0.7.189 rebuild; the old 8s
    // safety net WAS the flow on paths that missed a signal — the "it's on a
    // timer" bug).
    this._awaitSwingResolved(actor).then(() => {
      this._runChain(actor, plan, initialTargetIds).catch(e => console.warn(`${MODULE_ID} | Multiattack chain failed:`, e));
    });
  }

  /**
   * Resolve when THIS actor's current swing has fully resolved (the Johnny
   * 2026-07-10 spec, exactly):
   *   • MISS → resolve IMMEDIATELY. Two signals cover it: the attackComplete
   *     verdict with zero hits (local) and the attackResolved signal (socket-
   *     relayed to every client, so the player-side prompt gets it too).
   *   • HIT  → resolve when the damage-RESULT card is created — i.e. the
   *     moment Roll Damage was pushed and finished. Chat messages replicate
   *     to all clients, so this works wherever the prompt lives.
   * The timeout is NOT a flow driver — it is a defect alarm. If it ever
   * fires, a resolution path failed to signal; we WARN loudly and continue
   * rather than hang the chain forever.
   * @param {Actor}  actor
   * @param {number} [timeoutMs=60000]
   * @returns {Promise<string>} why: "miss" | "damage" | "resolved" | "timeout"
   */
  static _awaitSwingResolved(actor, timeoutMs = 15000) {
    const t0 = performance.now?.() ?? 0;
    return new Promise((resolve) => {
      let done = false;
      let net = null;
      const finish = (why) => {
        if (done) return;
        done = true;
        try {
          const secs = ((performance.now?.() ?? 0) - t0) / 1000;
          console.log(`${MODULE_ID} | [chain] swing resolved via "${why}" after ${secs.toFixed(1)}s for ${actor.name}`);
        } catch (_) { /* logging only */ }
        try { Hooks.off("createChatMessage", cardHook); } catch (_) { /* non-fatal */ }
        try { Hooks.off(`${MODULE_ID}.attackResolved`, sigHook); } catch (_) { /* non-fatal */ }
        try { Hooks.off(`${MODULE_ID}.attackComplete`, verdictHook); } catch (_) { /* non-fatal */ }
        if (net) clearTimeout(net);
        resolve(why);
      };
      // Verdict, local path: a whole-swing MISS never rolls damage — resolve now.
      // (Hits keep waiting for the damage card below.)
      const verdictHook = Hooks.on(`${MODULE_ID}.attackComplete`, (p) => {
        try {
          const aid = p?.actor?.id ?? p?.actorId ?? p?.actor;
          if (aid !== actor.id) return;
          if ((p?.hits?.length ?? 0) === 0) setTimeout(() => finish("miss"), 100);
        } catch (_) { /* non-fatal */ }
      });
      // HIT path ground truth: the damage-RESULT card landed (Roll Damage done).
      const cardHook = Hooks.on("createChatMessage", (msg) => {
        try {
          const f = msg?.flags?.[MODULE_ID];
          if (f?.type === "damageResult" && f.actorId === actor.id) setTimeout(() => finish("damage"), 100);
        } catch (_) { /* non-fatal */ }
      });
      // Clean-miss signal — socket-relayed everywhere (player-side prompts).
      const sigHook = Hooks.on(`${MODULE_ID}.attackResolved`, (p) => {
        if (p?.actorId === actor.id) setTimeout(() => finish("resolved"), 100);
      });
      // DEFECT ALARM, not flow: if this fires, a path failed to signal.
      net = setTimeout(() => {
        console.warn(`${MODULE_ID} | Multiattack: no swing-resolution signal for ${actor.name} within ${timeoutMs / 1000}s — a roll path missed its signal (report this). Continuing the chain.`);
        finish("timeout");
      }, timeoutMs);
    });
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
      // RAW: Extra Attack / Multiattack swings are WEAPON (or unarmed/natural)
      // attacks — casting a cantrip is the Cast a Spell action, a different
      // action entirely. Fire Bolt does not belong on the swing list.
      // (Live-fire 2026-07-10 16:45 — Virick's pop-up offered Fire Bolt.)
      if (it.type === "spell") continue;
      // For PCs, skip unequipped carried weapons (don't surface backpack daggers).
      if (it.type === "weapon" && actor.hasPlayerOwner && it.system?.equipped === false) continue;
      out.push(it);
    }
    return out;
  }

  // (retired 2026-07-10: the pop-up is roller-local now — dnd5e roll hooks
  // fire only on the rolling client, so ownership routing sent pop-ups to
  // clients that never saw the trigger. See _onAttack.)

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
      || (i.identifier ?? i.system?.identifier ?? "") === "extra-attack"
      // 2024 blade-lock: Thirsting Blade invocation = "attack twice with your
      // pact weapon" — Extra Attack in all but name (Syrax, warlock 6).
      || /thirsting blade/i.test(i.name ?? ""));
    if (!maFeature && !extraAttack) {
      // No Extra Attack / Multiattack — but a bonus-action attack (off-hand
      // pair, Pole Strike) still deserves the pop-up after swing 1 (Jex:
      // Dual Wielder rogue, 2026-07-10 18:11). Zero main swings remain;
      // the pop-up offers ONLY the blue bonus row.
      if (this._getBonusAttacks(actor).length) {
        return { mode: "fallback", total: 1, remaining: 0, attackItems, bonusOnly: true };
      }
      return null;   // truly nothing to chain
    }

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

  /** A one-handed melee weapon (no Two-Handed property) — Dual Wielder pairs. */
  static _isMeleeOneHanded(item) {
    try {
      const p = item.system?.properties;
      const two = (p?.has?.("two")) || (Array.isArray(p) && p.includes("two"));
      const wtype = String(item.system?.type?.value ?? "");
      const melee = /M$/.test(wtype) || wtype === "natural" || wtype === "improv";
      return melee && !two;
    } catch (_) { return false; }
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

    // (b) off-hand two-weapon fighting — RAW: a second equipped LIGHT melee
    //     weapon. The DUAL WIELDER feat drops the Light requirement (any
    //     pair of one-handed melee weapons — rapier + scimitar, Jex
    //     2026-07-10). Off-hand damage takes NO ability mod RAW unless the
    //     Two-Weapon Fighting style applies — mod handling is the pipeline's
    //     follow-up (punch list); the OFFER is what lives here.
    const hasDualWielder = (actor.items ?? []).some(i =>
      i.type === "feat" && /dual\s*wielder/i.test(i.name ?? ""));
    const pairable = (actor.items ?? []).filter(it =>
      it.type === "weapon" && it.system?.equipped && this._isAttackItem(it)
      && (hasDualWielder ? this._isMeleeOneHanded(it) : this._isLightMelee(it)));
    if (pairable.length >= 2) {
      // Off-hand = the Light one when exactly one of the pair is Light
      // (main the rapier, off-hand the scimitar); otherwise the second listed.
      const lights = pairable.filter(w => this._isLightMelee(w));
      const offhand = (lights.length === 1 && pairable.length === 2) ? lights[0] : pairable[1];
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

  /**
   * THE CHAIN (Johnny 2026-07-10 spec, verbatim):
   *   1. Swing 1 happens normally and RESOLVES (miss → verdict; hit → after
   *      Roll Damage). Only then does the first pop-up appear.
   *   2. The pop-up offers the remaining attacks. Clicking a weapon CLOSES
   *      the pop-up instantly — no Done-button ceremony — and fires the swing.
   *   3. That swing resolves the same way (miss → next pop-up immediately;
   *      hit → next pop-up right after Roll Damage), and the next one-shot
   *      pop-up appears. Repeat until the attacks are spent.
   *   "End Attacks" (or closing the window) bails out of the chain early.
   */
  static async _runChain(actor, plan, initialTargetIds = []) {
    // Mutable in-memory state (we never re-read the stat block mid-chain).
    const state = plan.mode === "parsed"
      ? { mode: "parsed", entries: plan.entries.map(e => ({ id: e.item.id, name: e.item.name, img: e.item.img, count: e.count })) }
      : { mode: "fallback", total: plan.total, remaining: plan.remaining,
          weapons: plan.attackItems.map(it => ({ id: it.id, name: it.name, img: it.img })) };
    state.bonusUsed = false;
    const bonusAttacks = MultiattackEngine._getBonusAttacks(actor);

    const remainingCount = () => state.mode === "parsed"
      ? state.entries.reduce((s, e) => s + e.count, 0)
      : state.remaining;

    const itemById = (id) => actor.items?.get?.(id) ?? actor.items?.find?.(i => i.id === id);

    // The last known living target(s) — refreshed from live targets each
    // swing so re-targeting mid-chain (splitting attacks) is honored.
    let lastTargetIds = [...initialTargetIds];

    try {
    while (remainingCount() > 0 || (bonusAttacks.length && !state.bonusUsed)) {
      // Turn ended out from under us (fumble-ends-turn, GM skip)? Stop offering —
      // no more swings once it isn't this actor's turn (2026-07-10).
      if (game.combat?.started && game.combat.combatant?.actor?.id !== actor.id) {
        console.log(`${MODULE_ID} | [chain] ${actor.name} is no longer the active combatant — ending chain`);
        break;
      }
      const choice = await this._promptOne(actor, state, bonusAttacks);
      if (!choice) break;   // End Attacks / window closed → chain over

      // A chain swing must never fire target-less — the pipeline would skip
      // resolution silently. Live targets win; an empty set re-asserts the
      // last known living target; nothing left → re-open the pop-up.
      if (!this._ensureTargets(lastTargetIds)) {
        ui.notifications?.warn(`${actor.name}: no living target — click a target on the canvas, then pick the attack again.`);
        continue;   // nothing consumed, nothing fired; the pop-up returns
      }
      lastTargetIds = [...(game.user.targets ?? [])].map(t => t.id);

      const item = itemById(choice.itemId);
      const activity = (choice.activityId && item)
        ? (item.system?.activities?.get?.(choice.activityId) ?? null)
        : null;
      console.log(`${MODULE_ID} | [chain] resolved choice: item=${item?.name ?? "MISSING (" + choice.itemId + ")"} targets=${game.user.targets?.size ?? 0}`);

      if (!item) {
        // A dead swing must be VISIBLE, never silent (live-fire 2026-07-10 16:34).
        ui.notifications?.error(`ACE Multiattack: couldn't find that weapon on ${actor.name} — see console (F12).`);
        continue;
      }

      try {
        await this._fireAttack(actor, item, activity);
      } catch (e) {
        console.error(`${MODULE_ID} | [chain] Multiattack fire FAILED:`, e);
        ui.notifications?.error(`ACE Multiattack: the swing failed to fire — see console (F12).`);
        continue;   // don't burn the attack count on a failed fire
      }

      // Log the swing against the plan FIRST — this is what makes it "the
      // second attack" instead of a mystery roll (Johnny 2026-07-10 17:26).
      if (choice.bonus) {
        state.bonusUsed = true;            // soft guard — one bonus action per turn
      } else if (state.mode === "parsed") {
        const e = state.entries.find(en => en.id === choice.itemId);
        if (e && e.count > 0) e.count -= 1;
      } else {
        state.remaining = Math.max(0, state.remaining - 1);
      }

      // THE RESET: when nothing more will be offered (mains spent AND the
      // bonus row used or absent), the chain is OVER the instant this swing
      // fires — never await the final swing (the zombie-chain lesson,
      // live-fire 17:26/17:28).
      const moreToOffer = remainingCount() > 0 || (bonusAttacks.length && !state.bonusUsed);
      if (!moreToOffer) break;

      // More to offer → wait for THIS swing to resolve first.
      // Miss → resolves the moment the verdict lands (next pop-up right away).
      // Hit  → resolves when the damage card is created (right after Roll
      // Damage) — the next pop-up comes up while the GM applies the damage.
      await this._awaitSwingResolved(actor);
    }

    } finally {
      // GUARANTEED full reset — even if a swing throws. The chain ending IS
      // the reset, in combat or out: the very next attack with this actor
      // is a fresh "first swing" and re-offers a fresh chain.
      MultiattackEngine._activeChains.delete(actor.id);
      MultiattackEngine._chained.delete(actor.id);
    }
  }

  /**
   * Make sure the chain swing has a target. Live targets are honored as-is
   * (the user may have re-targeted between pop-ups); an EMPTY set re-asserts
   * the last known target(s), skipping dead/removed tokens (V13-correct
   * per-token setTarget). Returns false when nothing living can be targeted.
   */
  static _ensureTargets(lastTargetIds) {
    if ((game.user.targets?.size ?? 0) > 0) return true;
    let asserted = false;
    for (const tid of (lastTargetIds ?? [])) {
      const tok = canvas.tokens?.get?.(tid);
      const hp = Number(tok?.actor?.system?.attributes?.hp?.value ?? 0);
      if (tok && !tok.destroyed && hp > 0) {
        try {
          tok.setTarget(true, { user: game.user, releaseOthers: false, groupSelection: false });
          asserted = true;
        } catch (_) { /* token gone mid-chain — try the next */ }
      }
    }
    if (asserted) console.log(`${MODULE_ID} | Multiattack: re-asserted the previous target for the next swing (auto-release had cleared it)`);
    return asserted;
  }

  /**
   * ONE one-shot prompt: the square-button grid (badged counts / weapon picks
   * + the blue bonus-action row). Clicking ANY attack button resolves the
   * choice and closes the dialog INSTANTLY. Resolves null on End Attacks / X.
   * @returns {Promise<null | { itemId, activityId: string|null, bonus: boolean }>}
   */
  static _promptOne(actor, state, bonusAttacks) {
    const portrait = actor.img ?? actor.prototypeToken?.texture?.src ?? "icons/svg/mystery-man.svg";
    const BONUS_ACCENT = "#6fa8dc";

    const remainingCount = () => state.mode === "parsed"
      ? state.entries.reduce((s, e) => s + e.count, 0)
      : state.remaining;

    const squareBtn = (id, name, img, badge) => `
      <button type="button" class="ace-ma-btn" data-item-id="${id}" title="${name}"
        style="position:relative;width:84px;height:84px;display:flex;flex-direction:column;align-items:center;justify-content:flex-start;gap:3px;padding:6px 4px;background:linear-gradient(180deg,#241a0c 0%,#140d05 100%);border:2px solid ${ACCENT}55;border-radius:8px;cursor:pointer;color:#f0e4c0;transition:border-color 0.15s,box-shadow 0.15s;">
        <img src="${img || "icons/svg/sword.svg"}" style="width:42px;height:42px;object-fit:contain;border-radius:4px;pointer-events:none;" />
        <span style="font-size:10px;line-height:1.1;text-align:center;max-width:78px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;pointer-events:none;">${name}</span>
        ${badge > 1 ? `<span style="position:absolute;top:-8px;right:-8px;min-width:22px;height:22px;padding:0 5px;display:flex;align-items:center;justify-content:center;background:${ACCENT};color:#1a1208;font-weight:800;font-size:13px;border-radius:11px;border:2px solid #140d05;pointer-events:none;">${badge}</span>` : ""}
      </button>`;

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

    const buttons = state.mode === "parsed"
      ? state.entries.filter(e => e.count > 0).map(e => squareBtn(e.id, e.name, e.img, e.count)).join("")
      : (state.remaining > 0 ? state.weapons.map(w => squareBtn(w.id, w.name, w.img, 1)).join("") : "");

    const mainsSpent = state.mode === "parsed"
      ? state.entries.every(e => e.count <= 0)
      : state.remaining <= 0;
    const subhead = mainsSpent
      ? `Bonus action available — the blue attack below. The pop-up closes on click.`
      : state.mode === "parsed"
        ? `Remaining attacks — click one to swing at your current target. The pop-up closes on click.`
        : `Attack ${state.total - state.remaining + 1} of ${state.total} — pick a weapon. The pop-up closes on click.`;

    const content = `
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

    return new Promise((resolve) => {
      let settled = false;
      const settle = (v) => {
        if (settled) return;
        settled = true;
        MultiattackEngine._openPrompts.delete(actor.id);
        resolve(v);
      };

      const dialog = new Dialog({
        title: `Multiattack — ${actor.name}`,
        content,
        buttons: {
          done: {
            icon: '<i class="fas fa-flag-checkered"></i>',
            label: "End Attacks",
            callback: () => settle(null),
          },
        },
        default: "done",
        render: (jq) => {
          const root = jq?.[0] ?? jq;
          const node = root?.querySelector?.(".ace-ma-prompt") ?? root;
          if (!node) return;
          node.querySelectorAll(".ace-ma-btn").forEach(b => {
            b.addEventListener("mouseenter", () => { b.style.borderColor = ACCENT; b.style.boxShadow = `0 0 8px ${ACCENT}88`; });
            b.addEventListener("mouseleave", () => { b.style.borderColor = `${ACCENT}55`; b.style.boxShadow = "none"; });
            b.addEventListener("click", (ev) => {
              ev.preventDefault();
              console.log(`${MODULE_ID} | [chain] weapon button clicked: ${b.title} (${b.getAttribute("data-item-id")})`);
              // The whole point: choice made → pop-up GONE, instantly.
              settle({ itemId: b.getAttribute("data-item-id"), activityId: null, bonus: false });
              dialog.close();
            });
          });
          node.querySelectorAll(".ace-ma-bonus-btn").forEach(b => {
            b.addEventListener("mouseenter", () => { if (!state.bonusUsed) { b.style.borderColor = BONUS_ACCENT; b.style.boxShadow = `0 0 8px ${BONUS_ACCENT}88`; } });
            b.addEventListener("mouseleave", () => { b.style.borderColor = `${BONUS_ACCENT}66`; b.style.boxShadow = "none"; });
            b.addEventListener("click", (ev) => {
              ev.preventDefault();
              if (state.bonusUsed) return;
              settle({ itemId: b.getAttribute("data-item-id"), activityId: b.getAttribute("data-activity-id") || null, bonus: true });
              dialog.close();
            });
          });
        },
        // X / Escape / programmatic close — if no choice was made, end chain.
        close: () => settle(null),
      }, { width: 360 });
      dialog.render(true);
      MultiattackEngine._openPrompts.set(actor.id, dialog);
    });
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
    // A fake event dnd5e can safely poke at — if the system calls
    // preventDefault/stopPropagation on a bare POJO it throws INSIDE use()
    // and the whole swing dies silently. These no-ops make that impossible.
    const fakeEvent = {
      shiftKey: true, altKey: false, ctrlKey: false, metaKey: false,
      target: document.body, currentTarget: document.body, type: "click",
      preventDefault: () => {}, stopPropagation: () => {}, stopImmediatePropagation: () => {},
    };
    try {
      // ── PROVEN against his dnd5e 5.3.1 bundle (2026-07-10 17:18) ──
      // The use() auto-roll path dies inside D20Roll.buildPost:
      //   config.event?.target.closest("[data-message-id]")
      // — any synthetic event that isn't DOM-perfect crashes the roll, and
      // the crash is an unhandled promise (silent to the user). The fix is
      // structural: roll the attack DIRECTLY with NO event and an explicit
      // dialog skip (applyKeybindings uses ??=, so explicit false wins).
      // Every piece of ACE machinery (ability resolver, advantage prompt,
      // merge card, damage flow) rides the roll hooks and still runs.
      // Trade-off: usage card + consumption are skipped — right for weapon
      // swings (the table suppresses vanilla cards); ammo tracking on chain
      // crossbow shots is the one known soft spot.
      let fireVia = null;
      const acts = item.system?.activities;
      const list = acts ? (typeof acts.values === "function" ? [...acts.values()] : Object.values(acts)) : [];
      const atk = activity ?? list.find(a => a?.type === "attack");
      if (atk && typeof atk.rollAttack === "function") {
        fireVia = ["rollAttack direct (no event, dialog skipped)", () => atk.rollAttack({}, { configure: false }, {})];
      } else if (activity && typeof activity.use === "function") {
        fireVia = ["explicit activity use", () => activity.use({ event: fakeEvent }, {}, {})];
      } else if (typeof item.use === "function") {
        fireVia = ["item.use (legacy)", () => item.use({ event: fakeEvent }, {}, {})];
      }
      if (!fireVia) {
        throw new Error(`"${item.name}" has no usable attack activity and no use() — item data problem`);
      }
      console.log(`${MODULE_ID} | [chain] firing ${item.name} via ${fireVia[0]}`);
      const result = await fireVia[1]();
      console.log(`${MODULE_ID} | [chain] ${item.name} use() returned ${result ? "OK" : String(result) + " (dnd5e declined the use — a gate/dialog cancelled it?)"}`);
    } finally {
      // Hold the guard a beat past use() so BOTH dual hooks for this swing are
      // covered, then release.
      setTimeout(() => this._inFlight.delete(actor.id), 250);
    }
  }
}
