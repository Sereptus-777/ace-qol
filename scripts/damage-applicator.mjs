// ─── ACE: QOL — Damage Applicator ────────────────────────────────────────────
// HP mutation: apply damage, undo damage, per-type toggle, override multipliers,
// add target / cleave. Owns the override cache and actor resolution.
// ──────────────────────────────────────────────────────────────────────────────

import { MODULE_ID } from "./ace-qol.mjs";
import { DamageCalculator } from "./damage-calculator.mjs";
import { DamageCardRenderer } from "./damage-card-renderer.mjs";
import { DamageConstants } from "./damage-engine.mjs";

export class DamageApplicator {

  /** In-memory override cache for per-row damage multipliers.
   *  Key: `${messageId}|${tokenDocId}` → multiplier (number) or "removed" */
  static overrideCache = new Map();

  // ═══════════════════════════════════════════════════════════════════════════
  //  Actor Resolution
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Resolve the correct actor for a damage entry.
   * For unlinked tokens, we need the token's synthetic actor, not the base world actor.
   */
  static resolveTargetActor(entry) {
    const scene = game.scenes.get(entry.sceneId) ?? canvas.scene;
    if (scene) {
      const tokenDoc = scene.tokens?.get(entry.tokenDocId);
      if (tokenDoc?.actor) return tokenDoc.actor;
    }

    const canvasToken = canvas.tokens?.get(entry.tokenDocId);
    if (canvasToken?.actor) return canvasToken.actor;

    return game.actors.get(entry.targetId);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Apply Damage to All Targets
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Apply damage to all targets from a damage card.
   */
  static async applyDamage(message) {
    const flags = message.flags?.[MODULE_ID];
    const data = flags?.damageResults;
    if (!data?.length) return;

    let applied = 0;
    for (const entry of data) {
      const cacheKey = `${message.id}|${entry.tokenDocId}`;
      const cachedValue = DamageApplicator.overrideCache.get(cacheKey);

      // Skip removed targets
      if (cachedValue === "removed") {
        DamageApplicator.overrideCache.delete(cacheKey);
        continue;
      }

      const actor = DamageApplicator.resolveTargetActor(entry);
      if (!actor) {
        console.warn(`${MODULE_ID} | Could not find actor for token ${entry.tokenDocId}`);
        continue;
      }

      // ── Component-level APPLY ALL ──
      // Only sum components that haven't been individually applied (greyed out).
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
        DamageApplicator.overrideCache.delete(cacheKey);
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
        if (appliedComps.includes(i)) continue;
        const compDmg = Math.floor(components[i].final * override);
        perCompUpdate[`flags.${MODULE_ID}.perCompApplied.${entry.tokenDocId}.${i}`] = compDmg;
      }
      await message.update({
        [`flags.${MODULE_ID}.appliedComps.${entry.tokenDocId}`]: allIndices,
        [`flags.${MODULE_ID}.perTypeApplied.${entry.tokenDocId}`]: prevPerType + damageToApply,
        ...perCompUpdate,
      });

      DamageApplicator.overrideCache.delete(cacheKey);
      applied++;
    }

    ui.notifications.info(`ACE QOL: Damage applied to ${applied} target(s).`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Undo Damage
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Undo damage — restore HP to pre-damage values.
   */
  static async undoDamage(message) {
    const data = message.getFlag(MODULE_ID, "damageResults");
    if (!data?.length) return;

    let undoneCount = 0;
    for (const entry of data) {
      const actor = DamageApplicator.resolveTargetActor(entry);
      if (!actor) {
        console.warn(`${MODULE_ID} | Could not find actor for undo on token ${entry.tokenDocId}`);
        continue;
      }

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
  //  Add Target / Cleave
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Add a new target to an existing damage card (ADD TARGET or CLEAVE).
   * Reads raw components from flags, assesses new target's defenses,
   * calculates adjusted damage, appends row to DOM, updates message flags.
   */
  static async addTargetToCard(message, el, token, isCleave = false, overkillAmount = 0, overkillComponents = null) {
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

    // Retrieve the attacking item for bypass checks
    const attackItem = flags.itemUuid ? await fromUuid(flags.itemUuid) : null;

    // Assess new target's defenses
    const damageModifiers = DamageCalculator.getTargetDamageModifiers(actor, attackItem);

    let components;
    if (isCleave && overkillAmount > 0) {
      const srcComponents = overkillComponents ?? flags.rawComponents ?? [];
      const totalSrc = srcComponents.reduce((s, c) => s + (c.final ?? c.raw ?? 0), 0);
      components = srcComponents.map(c => {
        const srcVal = c.final ?? c.raw ?? 0;
        const proportion = totalSrc > 0 ? srcVal / totalSrc : 0;
        const cleaveRaw = Math.max(0, Math.round(overkillAmount * proportion));
        return { name: c.name, type: c.type, raw: cleaveRaw, total: cleaveRaw };
      });
      let sum = components.reduce((s, c) => s + c.raw, 0);
      if (sum !== overkillAmount && components.length) {
        components[0].raw += (overkillAmount - sum);
        components[0].total = components[0].raw;
      }
    } else {
      const rawComponents = flags.rawComponents ?? [];
      components = rawComponents.map(c => ({ name: c.name, type: c.type, raw: c.raw, total: c.raw }));
    }

    // Apply new target's defenses
    const applied = DamageCalculator.applyDamageModifiers(components, damageModifiers);
    const totalFinal = applied.reduce((s, c) => s + c.final, 0);

    const currentHP = actor.system?.attributes?.hp?.value ?? 0;
    const maxHP = actor.system?.attributes?.hp?.max ?? 0;
    const tokenDocId = token.document?.id ?? token.id;
    const img = token.document?.texture?.src || actor.img || "icons/svg/mystery-man.svg";

    // Build row HTML and insert into the targets container
    const rowHtml = DamageCardRenderer.buildTargetRowHtml({
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
      // Wire the new row's buttons — caller must pass the wireOverrideButtons function
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

  // ═══════════════════════════════════════════════════════════════════════════
  //  Override Buttons + Per-Type Toggle Wiring
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Wire per-row override and remove buttons on a damage card.
   * Safe to call multiple times — skips already-wired buttons.
   */
  static wireOverrideButtons(el, message) {
    // Override multiplier buttons (¼, ½, 1, 2×)
    const overrideBtns = el.querySelectorAll?.("[data-action='aceQolDmgOverride']");
    for (const btn of (overrideBtns ?? [])) {
      if (btn.dataset.wired) continue;
      btn.dataset.wired = "1";

      // ── Restore visual state from in-memory cache ──
      const tokenDocId = btn.dataset.tokenDocId;
      const multiplier = parseFloat(btn.dataset.multiplier);
      const cacheKey = `${message.id}|${tokenDocId}`;
      const cached = DamageApplicator.overrideCache.get(cacheKey);
      if (typeof cached === "number" && cached === multiplier) {
        const ovrLine = btn.closest(".ace-qol-dmg-ovr-line");
        if (ovrLine) {
          ovrLine.querySelectorAll(".ace-qol-dmg-ovr").forEach(b => b.classList.remove("ace-qol-dmg-ovr-active"));
          btn.classList.add("ace-qol-dmg-ovr-active");
        }
        const row = btn.closest(".ace-qol-dmg-target-row");
        if (row) DamageApplicator.updateDmgRowDisplay(row, tokenDocId, cached, message.flags?.[MODULE_ID]);
      }

      btn.addEventListener("click", () => {
        const tokenDocId = btn.dataset.tokenDocId;
        const multiplier = parseFloat(btn.dataset.multiplier);
        if (!tokenDocId || isNaN(multiplier)) return;

        const ovrLine = btn.closest(".ace-qol-dmg-ovr-line");
        if (ovrLine) {
          ovrLine.querySelectorAll(".ace-qol-dmg-ovr").forEach(b => b.classList.remove("ace-qol-dmg-ovr-active"));
          btn.classList.add("ace-qol-dmg-ovr-active");
        }

        const cacheKey = `${message.id}|${tokenDocId}`;
        DamageApplicator.overrideCache.set(cacheKey, multiplier);

        const row = btn.closest(".ace-qol-dmg-target-row");
        if (row) DamageApplicator.updateDmgRowDisplay(row, tokenDocId, multiplier, message.flags?.[MODULE_ID]);
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
        DamageApplicator.overrideCache.set(cacheKey, "removed");
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

      const origHP = entry.currentHP;
      const maxHP = entry.maxHP ?? origHP;
      const appliedIndices = appliedCompsMap[tokenDocId] ?? [];

      const remainingDamage = (entry.components ?? []).reduce((sum, c, i) => {
        if (appliedIndices.includes(i)) return sum;
        return sum + (c.final ?? 0);
      }, 0);

      const currentLiveHP = Math.max(0, origHP - appliedAmount);
      const projectedHP = Math.max(0, currentLiveHP - remainingDamage);
      const isDead = projectedHP <= 0;

      const dmgSpan = row.querySelector(".ace-qol-dmg-row-dmg");
      if (dmgSpan && appliedAmount > 0) {
        dmgSpan.textContent = remainingDamage;
      }

      const hpLine = row.querySelector(".ace-qol-dmg-row-hp");
      if (hpLine && appliedAmount > 0) {
        hpLine.innerHTML = `HP: <span class="ace-qol-hp-cur">${currentLiveHP}</span> → <span class="ace-qol-hp-new${isDead ? ' ace-qol-hp-dead' : ''}">${projectedHP}</span><span class="ace-qol-hp-max">/${maxHP}</span>`;
      }
    }

    // ── Per-type damage TOGGLE (click to apply, click again to undo) ──
    const typeLines = el.querySelectorAll?.("[data-action='aceQolApplyType']");
    for (const line of (typeLines ?? [])) {
      if (line.dataset.wired) continue;
      line.dataset.wired = "1";

      // Restore visual state from flags
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
        const actor = DamageApplicator.resolveTargetActor(entry);
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

          const currentHP = actor.system.attributes.hp.value;
          const restoredHP = Math.min(currentHP + appliedAmount, actor.system.attributes.hp.max);
          await actor.update({ "system.attributes.hp.value": restoredHP });

          const newApplied = currentApplied.filter(i => i !== idx);
          const prevTotal = message.flags?.[MODULE_ID]?.perTypeApplied?.[tokenDocId] ?? 0;
          const flagUpdate = {
            [`flags.${MODULE_ID}.appliedComps.${tokenDocId}`]: newApplied,
            [`flags.${MODULE_ID}.perTypeApplied.${tokenDocId}`]: Math.max(0, prevTotal - appliedAmount),
            [`flags.${MODULE_ID}.perCompApplied.${tokenDocId}.${idx}`]: null,
          };
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
        const override = DamageApplicator.overrideCache.get(cacheKey);
        const amount = (typeof override === "number")
          ? Math.floor(baseAmount * override)
          : baseAmount;

        const currentHP = actor.system.attributes.hp.value;
        const newHP = Math.max(0, currentHP - amount);
        await actor.update({ "system.attributes.hp.value": newHP });

        const prevApplied = message.flags?.[MODULE_ID]?.perTypeApplied?.[tokenDocId] ?? 0;
        const overrideLabel = (typeof override === "number" && override !== 1) ? ` (×${override})` : "";
        console.log(`${MODULE_ID} | Per-type apply: comp ${idx} (${amount} ${dmgType}${overrideLabel}) to ${entry.name}: HP ${currentHP} → ${newHP}`);

        const updatedComps = [...currentApplied, idx];
        await message.update({
          [`flags.${MODULE_ID}.perTypeApplied.${tokenDocId}`]: prevApplied + amount,
          [`flags.${MODULE_ID}.appliedComps.${tokenDocId}`]: updatedComps,
          [`flags.${MODULE_ID}.perCompApplied.${tokenDocId}.${idx}`]: amount,
        });

        DamageApplicator.overrideCache.delete(cacheKey);
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

  // ═══════════════════════════════════════════════════════════════════════════
  //  Override Display Update
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Update a target row's damage and HP display after an override click.
   */
  static updateDmgRowDisplay(row, tokenDocId, multiplier, flags) {
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
}
