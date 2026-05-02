// ─── ACE: QOL — Optional Rider Detection Engine ─────────────────────────────
// Detects post-hit abilities that require player choice + resource expenditure.
// Shows a floating popup after a successful attack hit for the player to decide.
// ──────────────────────────────────────────────────────────────────────────────

import { MODULE_ID } from "./ace-qol.mjs";

export class RiderEngine {

  // ═══════════════════════════════════════════════════════════════════════════
  //  Detection — Scan actor for available optional riders
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Scan an actor for available optional riders after a successful hit.
   * @param {Actor} actor - The attacking actor
   * @param {object} target - Target info { actor, token, creatureType, creatureSubtype, currentHP, maxHP }
   * @param {object} opts - { isMelee, isRanged, isCrit, item }
   * @returns {object[]} Array of available riders with { id, name, formula, type, resource, description, icon, highlight }
   */
  static detectRiders(actor, target, opts = {}) {
    const riders = [];
    const { isMelee, isRanged, isCrit, item } = opts;

    // ── DIVINE SMITE (2014 class feature) ──
    // Paladin class feature, melee only, costs spell slot
    // +2d8 radiant, +1d8 per slot above 1st, +1d8 vs undead/fiend
    if (isMelee && RiderEngine._hasPaladinSmite(actor)) {
      const slots = RiderEngine._getAvailableSpellSlots(actor);
      if (slots.length > 0) {
        const targetType = target.creatureType?.toLowerCase() ?? "";
        const isUndeadOrFiend = targetType === "undead" || targetType === "fiend";
        const bestSlot = slots[0]; // lowest available
        const numDice = 1 + bestSlot.level + (isUndeadOrFiend ? 1 : 0);
        riders.push({
          id: "divine-smite",
          name: "Divine Smite",
          formula: `${numDice}d8`,
          type: "radiant",
          resource: { type: "spell-slot", level: bestSlot.level, available: slots },
          description: isUndeadOrFiend
            ? `${numDice}d8 radiant (includes +1d8 vs ${targetType})`
            : `${numDice}d8 radiant`,
          icon: "fa-sun",
          highlight: isUndeadOrFiend ? targetType.toUpperCase() : null,
          isMeleeOnly: true,
          scalable: true, // can pick higher slot for more dice
        });
      }
    }

    // ── ELDRITCH SMITE (Warlock invocation) ──
    // Pact of the Blade, costs warlock slot, 1d8 + 1d8/level above 1st, knocks prone if Huge or smaller
    if (RiderEngine._hasFeature(actor, "Eldritch Smite")) {
      const pactSlots = RiderEngine._getPactSlots(actor);
      if (pactSlots.available > 0) {
        const numDice = 1 + pactSlots.level;
        const targetSize = target.creatureSize ?? "medium";
        const canKnockProne = ["tiny","small","medium","large","huge"].includes(targetSize.toLowerCase());
        riders.push({
          id: "eldritch-smite",
          name: "Eldritch Smite",
          formula: `${numDice}d8`,
          type: "force",
          resource: { type: "pact-slot", level: pactSlots.level, available: pactSlots.available },
          description: `${numDice}d8 force${canKnockProne ? " + prone" : ""}`,
          icon: "fa-bolt",
          highlight: canKnockProne ? "KNOCKS PRONE" : null,
          proneOnHit: canKnockProne,
        });
      }
    }

    // ── STUNNING STRIKE (Monk 5+) ──
    // No damage, costs ki/focus point, CON save or stunned
    if (isMelee && RiderEngine._hasFeature(actor, "Stunning Strike")) {
      const ki = RiderEngine._getKiPoints(actor);
      if (ki.current > 0) {
        riders.push({
          id: "stunning-strike",
          name: "Stunning Strike",
          formula: null, // no damage
          type: null,
          resource: { type: "ki", current: ki.current, max: ki.max },
          description: `Target must CON save or be STUNNED`,
          icon: "fa-hand-fist",
          highlight: "STUN",
          isMeleeOnly: true,
          saveRequired: { ability: "con", dc: RiderEngine._getKiSaveDC(actor) },
        });
      }
    }

    // ── BATTLE MASTER MANEUVERS ──
    // Check for superiority dice
    if (RiderEngine._hasFeature(actor, "Combat Superiority") || RiderEngine._hasFeature(actor, "Superiority Dice")) {
      const supDice = RiderEngine._getSuperiorityDice(actor);
      if (supDice.current > 0) {
        // Detect which maneuvers the actor knows
        const maneuvers = RiderEngine._detectManeuvers(actor);
        for (const m of maneuvers) {
          riders.push({
            id: `maneuver-${m.id}`,
            name: m.name,
            formula: supDice.die, // e.g., "1d8", "1d10", "1d12"
            type: item?.system?.damage?.parts?.[0]?.[1] ?? "untyped",
            resource: { type: "superiority-die", current: supDice.current, max: supDice.max },
            description: m.description,
            icon: "fa-chess-knight",
            highlight: m.effect,
            saveRequired: m.save ?? null,
            category: "maneuver",
          });
        }
      }
    }

    // ── HAND OF HARM (Mercy Monk) ──
    if (isMelee && RiderEngine._hasFeature(actor, "Hand of Harm")) {
      const ki = RiderEngine._getKiPoints(actor);
      if (ki.current > 0) {
        const monkLevel = RiderEngine._getClassLevel(actor, "monk");
        const martialDie = monkLevel >= 17 ? "1d12" : monkLevel >= 11 ? "1d10" : monkLevel >= 5 ? "1d8" : "1d6";
        const wisMod = actor.system?.abilities?.wis?.mod ?? 0;
        riders.push({
          id: "hand-of-harm",
          name: "Hand of Harm",
          formula: `${martialDie} + ${wisMod}`,
          type: "necrotic",
          resource: { type: "ki", current: ki.current, max: ki.max },
          description: `${martialDie}+${wisMod} necrotic`,
          icon: "fa-skull",
          isMeleeOnly: true,
        });
      }
    }

    // ── SMITE SPELLS (pre-cast, discharge on hit) ──
    // These are active concentration effects that discharge on the next weapon hit
    const smiteSpells = [
      { effect: "Searing Smite",    formula: "1d6",  type: "fire",    icon: "fa-fire" },
      { effect: "Thunderous Smite", formula: "2d6",  type: "thunder", icon: "fa-cloud-bolt" },
      { effect: "Wrathful Smite",   formula: "2d6",  type: "psychic", icon: "fa-brain" },
      { effect: "Blinding Smite",   formula: "3d8",  type: "radiant", icon: "fa-eye-slash" },
      { effect: "Staggering Smite", formula: "4d6",  type: "psychic", icon: "fa-dizzy" },
      { effect: "Banishing Smite",  formula: "5d10", type: "force",   icon: "fa-portal-exit" },
      { effect: "Shining Smite",    formula: "2d6",  type: "radiant", icon: "fa-sparkles" },
    ];
    for (const ss of smiteSpells) {
      if (RiderEngine._hasEffect(actor, ss.effect)) {
        riders.push({
          id: `smite-spell-${ss.effect.toLowerCase().replace(/\s+/g, "-")}`,
          name: ss.effect,
          formula: ss.formula,
          type: ss.type,
          resource: { type: "discharge", note: "Active — will discharge on hit" },
          description: `${ss.formula} ${ss.type} (ACTIVE — discharges on hit)`,
          icon: ss.icon,
          highlight: "ACTIVE",
          isDischarge: true, // Auto-included, just confirming
        });
      }
    }

    return riders;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Rider Popup UI
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Show the rider selection popup after a successful hit.
   * Returns a promise that resolves with selected riders or empty array if dismissed.
   * @param {object[]} riders - Available riders from detectRiders()
   * @param {object} context - { attackerName, targetName, targetCreatureType, isCrit }
   * @returns {Promise<object[]>} Selected riders with final formulas
   */
  static showRiderPopup(riders, context) {
    return new Promise((resolve) => {
      if (!riders.length) { resolve([]); return; }

      const { targetName, targetCreatureType, isCrit } = context;

      // Separate discharge riders (auto-confirmed) from optional riders
      const dischargeRiders = riders.filter(r => r.isDischarge);
      const optionalRiders = riders.filter(r => !r.isDischarge);

      // If only discharge riders (no choices to make), auto-resolve
      if (!optionalRiders.length) {
        resolve(dischargeRiders);
        return;
      }

      // Guard flag: Foundry's Dialog.close() calls the `close` callback synchronously,
      // which races with resolve() in USE/dismiss handlers. Without this flag, dialog.close()
      // inside the USE handler triggers the `close` callback's resolve(dischargeRiders) BEFORE
      // the USE handler's resolve([...dischargeRiders, rider]) can run — the Promise resolves
      // with an empty array and the selected rider is silently lost.
      let resolved = false;

      // Build popup HTML
      const creatureTypeColor = RiderEngine.CREATURE_TYPE_COLORS[targetCreatureType?.toLowerCase()] ?? "#ccc";
      const creatureTypeDisplay = targetCreatureType ? targetCreatureType.toUpperCase() : "";

      let html = `<div class="ace-qol-rider-popup">`;

      // Target info header
      if (creatureTypeDisplay) {
        html += `<div class="ace-qol-rider-target-type" style="color:${creatureTypeColor}; border-color:${creatureTypeColor}">
          <i class="fas fa-crosshairs"></i> TARGET IS <strong>${creatureTypeDisplay}</strong>
        </div>`;
      }

      // Discharge riders (auto-included, just informational)
      for (const dr of dischargeRiders) {
        html += `<div class="ace-qol-rider-row ace-qol-rider-discharge">
          <i class="fas ${dr.icon}"></i>
          <span class="ace-qol-rider-name">${dr.name}</span>
          <span class="ace-qol-rider-formula">${dr.formula} ${dr.type}</span>
          <span class="ace-qol-rider-badge ace-qol-rider-active">AUTO</span>
        </div>`;
      }

      // Optional riders (player chooses one OR MORE — multi-select per RAW)
      // Per RAW (Crawford): multiple smites/riders can stack on a single hit
      // as long as each trigger condition is met and each consumes its own
      // resource. Two-row layout per rider to give the description full
      // breathing room instead of squishing it between the name and badges.
      const isGM = game.user.isGM;
      for (const r of optionalRiders) {
        const slotPicker = r.scalable ? RiderEngine._buildSlotPicker(r.resource.available) : "";
        const highlightBadge = r.highlight
          ? `<span class="ace-qol-rider-badge ace-qol-rider-highlight" style="color:${creatureTypeColor}">${r.highlight}</span>`
          : "";

        const consumeToggle = isGM
          ? `<label class="ace-qol-rider-consume" title="Uncheck to use without spending the resource">
               <input type="checkbox" data-rider-id="${r.id}" class="ace-qol-rider-consume-cb" checked />
               <span>Consume</span>
             </label>`
          : "";

        // Two-row layout:
        //   Top:    [icon] Name              [highlight] [slot] [consume]
        //   Bottom: full-width description                          [USE toggle]
        html += `<div class="ace-qol-rider-row" data-rider-id="${r.id}">
          <div class="ace-qol-rider-row-top">
            <i class="fas ${r.icon} ace-qol-rider-icon"></i>
            <span class="ace-qol-rider-name">${r.name}</span>
            <div class="ace-qol-rider-row-meta">
              ${highlightBadge}
              ${slotPicker}
              ${consumeToggle}
            </div>
          </div>
          <div class="ace-qol-rider-row-bottom">
            <span class="ace-qol-rider-formula">${r.description}</span>
            <button class="ace-qol-rider-select" data-rider-id="${r.id}" aria-pressed="false">
              <i class="fas fa-check"></i> <span class="ace-qol-rider-select-label">USE</span>
            </button>
          </div>
        </div>`;
      }

      // Action row — Apply Selected (fires all checked riders) + dismiss
      html += `<div class="ace-qol-rider-actions">
        <button class="ace-qol-rider-apply" disabled>
          <i class="fas fa-check-double"></i> Apply Selected (<span class="ace-qol-rider-count">0</span>)
        </button>
        <button class="ace-qol-rider-dismiss">
          <i class="fas fa-xmark"></i> Not This Time
        </button>
      </div>`;
      html += `</div>`;

      // Create as a floating dialog near the chat
      const dialog = new Dialog({
        title: `Post-Hit Options — ${targetName}`,
        content: html,
        buttons: {},
        render: (jq) => {
          const el = jq[0] ?? jq;

          // ── USE buttons toggle selection state (don't close the dialog) ──
          // Per-rider USE click flips the row's selected state. Multiple
          // riders can be selected simultaneously (RAW: stackable smites).
          // The bottom Apply Selected button is the actual commit action.
          const updateApplyButton = () => {
            const selectedCount = el.querySelectorAll(".ace-qol-rider-select.selected").length;
            const applyBtn = el.querySelector(".ace-qol-rider-apply");
            const countSpan = el.querySelector(".ace-qol-rider-count");
            if (countSpan) countSpan.textContent = String(selectedCount);
            if (applyBtn) applyBtn.disabled = selectedCount === 0;
          };

          el.querySelectorAll(".ace-qol-rider-select").forEach(btn => {
            btn.addEventListener("click", (ev) => {
              ev.preventDefault();
              ev.stopPropagation();
              const isSelected = btn.classList.toggle("selected");
              btn.setAttribute("aria-pressed", isSelected ? "true" : "false");
              const labelEl = btn.querySelector(".ace-qol-rider-select-label");
              if (labelEl) labelEl.textContent = isSelected ? "SELECTED" : "USE";
              const row = btn.closest(".ace-qol-rider-row");
              if (row) row.classList.toggle("selected", isSelected);
              updateApplyButton();
            });
          });

          // ── Apply Selected — gather all checked riders and resolve ──
          el.querySelector(".ace-qol-rider-apply")?.addEventListener("click", () => {
            const selectedBtns = [...el.querySelectorAll(".ace-qol-rider-select.selected")];
            if (!selectedBtns.length) return; // disabled state guard
            const chosen = [];
            for (const btn of selectedBtns) {
              const riderId = btn.dataset.riderId;
              const rider = riders.find(r => r.id === riderId);
              if (!rider) continue;

              // Slot picker override (Divine Smite scalable)
              if (rider.scalable) {
                const select = el.querySelector(`select[data-rider-id="${riderId}"]`);
                if (select) {
                  const slotLevel = parseInt(select.value);
                  const targetType = targetCreatureType?.toLowerCase() ?? "";
                  const isUndeadOrFiend = targetType === "undead" || targetType === "fiend";
                  const numDice = 1 + slotLevel + (isUndeadOrFiend ? 1 : 0);
                  rider.formula = `${numDice}d8`;
                  rider.resource.level = slotLevel;
                  rider.description = `${numDice}d8 radiant (${slotLevel === 1 ? "1st" : slotLevel === 2 ? "2nd" : slotLevel === 3 ? "3rd" : slotLevel + "th"} level slot)`;
                }
              }

              // GM consume toggle
              const consumeCb = el.querySelector(`.ace-qol-rider-consume-cb[data-rider-id="${riderId}"]`);
              if (consumeCb && !consumeCb.checked) {
                rider.skipConsume = true;
              }

              chosen.push(rider);
            }

            resolved = true;
            resolve([...dischargeRiders, ...chosen]);
            dialog.close();
          });

          // ── Dismiss — fire only discharge riders (already-active spells) ──
          el.querySelector(".ace-qol-rider-dismiss")?.addEventListener("click", () => {
            resolved = true;
            resolve(dischargeRiders);
            dialog.close();
          });
        },
        close: () => {
          // Fallback: only resolve if USE/dismiss didn't already handle it
          // (e.g., user clicked X button or pressed Escape to close the dialog)
          if (!resolved) {
            resolved = true;
            resolve(dischargeRiders);
          }
        },
      }, {
        classes: ["ace-qol-rider-dialog"],
        width: 460,
        height: "auto",
      });

      dialog.render(true);
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Resource Consumption
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Consume resources for selected riders (spell slots, ki points, superiority dice, etc.)
   * @param {Actor} actor - The attacking actor
   * @param {object[]} selectedRiders - Riders chosen by the player
   */
  static async consumeResources(actor, selectedRiders) {
    for (const rider of selectedRiders) {
      if (rider.isDischarge) {
        // Remove the concentration effect
        const effect = actor.effects.find(e => e.name?.toLowerCase().includes(rider.name.toLowerCase()));
        if (effect) {
          await effect.delete();
          console.log(`${MODULE_ID} | Discharged ${rider.name} effect from ${actor.name}`);
        }
        continue;
      }

      // GM toggled "Consume" off — fire damage without spending the resource
      if (rider.skipConsume) {
        console.log(`${MODULE_ID} | Skipping resource consumption for ${rider.name} (GM override)`);
        continue;
      }

      const res = rider.resource;
      if (!res) continue;

      switch (res.type) {
        case "spell-slot": {
          const slotKey = `spell${res.level}`;
          const current = actor.system?.spells?.[slotKey]?.value ?? 0;
          if (current > 0) {
            await actor.update({ [`system.spells.${slotKey}.value`]: current - 1 });
            console.log(`${MODULE_ID} | Consumed level ${res.level} spell slot for ${rider.name}. ${current - 1} remaining.`);
          }
          break;
        }
        case "pact-slot": {
          const pact = actor.system?.spells?.pact;
          if (pact?.value > 0) {
            await actor.update({ "system.spells.pact.value": pact.value - 1 });
            console.log(`${MODULE_ID} | Consumed pact slot for ${rider.name}. ${pact.value - 1} remaining.`);
          }
          break;
        }
        case "ki": {
          // Ki/Focus points are stored differently depending on system version
          const ki = RiderEngine._getKiPoints(actor);
          if (ki.current > 0) {
            // Try common storage locations
            const kiItem = actor.items.find(i =>
              i.name?.toLowerCase().includes("ki point") ||
              i.name?.toLowerCase().includes("focus point") ||
              i.name?.toLowerCase().includes("ki")
            );
            if (kiItem?.system?.uses) {
              await kiItem.update({ "system.uses.value": Math.max(0, (kiItem.system.uses.value ?? 0) - 1) });
            }
            console.log(`${MODULE_ID} | Consumed ki/focus point for ${rider.name}.`);
          }
          break;
        }
        case "superiority-die": {
          const supItem = actor.items.find(i =>
            i.name?.toLowerCase().includes("superiority") ||
            i.name?.toLowerCase().includes("combat superiority")
          );
          if (supItem?.system?.uses) {
            await supItem.update({ "system.uses.value": Math.max(0, (supItem.system.uses.value ?? 0) - 1) });
          }
          console.log(`${MODULE_ID} | Consumed superiority die for ${rider.name}.`);
          break;
        }
        case "discharge":
          // Already handled above
          break;
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Helper Methods — Actor Inspection
  // ═══════════════════════════════════════════════════════════════════════════

  static _hasFeature(actor, name) {
    if (!actor?.items) return false;
    const lcName = name.toLowerCase();
    for (const item of actor.items) {
      if ((item.type === "feat" || item.type === "class" || item.type === "subclass")
          && item.name?.toLowerCase().includes(lcName)) return true;
    }
    return false;
  }

  static _hasEffect(actor, name) {
    if (!actor?.effects) return false;
    const lcName = name.toLowerCase();
    for (const effect of actor.effects) {
      if (!effect.disabled && effect.name?.toLowerCase().includes(lcName)) return true;
    }
    return false;
  }

  static _getClassLevel(actor, className) {
    for (const item of actor.items ?? []) {
      if (item.type === "class" && item.name?.toLowerCase().includes(className.toLowerCase())) {
        return item.system?.levels ?? 0;
      }
    }
    return 0;
  }

  static _hasPaladinSmite(actor) {
    // Check for 2014 Divine Smite class feature, 2024 Divine Smite spell, OR paladin levels >= 2
    if (RiderEngine._hasFeature(actor, "Divine Smite")) return true;
    if (RiderEngine._hasSpell(actor, "Divine Smite")) return true;
    if (RiderEngine._getClassLevel(actor, "paladin") >= 2) return true;
    return false;
  }

  static _hasSpell(actor, name) {
    if (!actor?.items) return false;
    const lcName = name.toLowerCase();
    for (const item of actor.items) {
      if (item.type === "spell" && item.name?.toLowerCase().includes(lcName)) return true;
    }
    return false;
  }

  static _getAvailableSpellSlots(actor) {
    const slots = [];
    const spells = actor.system?.spells ?? {};
    for (let level = 1; level <= 9; level++) {
      const slot = spells[`spell${level}`];
      if (slot && slot.value > 0 && slot.max > 0) {
        slots.push({ level, current: slot.value, max: slot.max });
      }
    }
    // Also check pact slots
    if (spells.pact?.value > 0 && spells.pact?.max > 0) {
      slots.push({ level: spells.pact.level ?? 1, current: spells.pact.value, max: spells.pact.max, isPact: true });
    }
    return slots;
  }

  static _getPactSlots(actor) {
    const pact = actor.system?.spells?.pact ?? {};
    return {
      level: pact.level ?? 1,
      available: pact.value ?? 0,
      max: pact.max ?? 0,
    };
  }

  static _getKiPoints(actor) {
    // Ki/Focus points can be stored in various ways
    for (const item of actor.items ?? []) {
      const name = item.name?.toLowerCase() ?? "";
      if ((name.includes("ki point") || name.includes("focus point") || name === "ki") && item.system?.uses) {
        return { current: item.system.uses.value ?? 0, max: item.system.uses.max ?? 0 };
      }
    }
    // Fallback: check class resources
    const monk = actor.items.find(i => i.type === "class" && i.name?.toLowerCase().includes("monk"));
    if (monk) {
      // In some setups, ki is stored as a class resource
      const monkLevel = monk.system?.levels ?? 0;
      return { current: monkLevel, max: monkLevel }; // approximate
    }
    return { current: 0, max: 0 };
  }

  static _getKiSaveDC(actor) {
    // 8 + proficiency + WIS mod
    const prof = actor.system?.attributes?.prof ?? 2;
    const wis = actor.system?.abilities?.wis?.mod ?? 0;
    return 8 + prof + wis;
  }

  static _getSuperiorityDice(actor) {
    for (const item of actor.items ?? []) {
      const name = item.name?.toLowerCase() ?? "";
      if ((name.includes("superiority") || name.includes("combat superiority")) && item.system?.uses) {
        const fighterLevel = RiderEngine._getClassLevel(actor, "fighter");
        const die = fighterLevel >= 18 ? "1d12" : fighterLevel >= 10 ? "1d10" : "1d8";
        return { current: item.system.uses.value ?? 0, max: item.system.uses.max ?? 0, die };
      }
    }
    return { current: 0, max: 0, die: "1d8" };
  }

  static _detectManeuvers(actor) {
    // Scan actor items for known maneuvers
    const known = [];
    const maneuverDefs = [
      { id: "trip",        name: "Trip Attack",        effect: "STR save or PRONE",        save: { ability: "str" } },
      { id: "menacing",    name: "Menacing Attack",    effect: "WIS save or FRIGHTENED",   save: { ability: "wis" } },
      { id: "pushing",     name: "Pushing Attack",     effect: "STR save or PUSHED 15ft",  save: { ability: "str" } },
      { id: "distracting", name: "Distracting Strike", effect: "Next attack has ADV",       save: null },
      { id: "goading",     name: "Goading Attack",     effect: "WIS save or DISADV vs others", save: { ability: "wis" } },
      { id: "maneuvering", name: "Maneuvering Attack",  effect: "Ally can reposition",      save: null },
      { id: "sweeping",    name: "Sweeping Attack",    effect: "Hit adjacent creature",     save: null },
      { id: "riposte",     name: "Riposte",            effect: "Reaction counterattack",    save: null },
      { id: "feinting",    name: "Feinting Attack",    effect: "Advantage + bonus dmg",     save: null },
      { id: "quick-toss",  name: "Quick Toss",         effect: "Bonus action thrown attack", save: null },
      { id: "brace",       name: "Brace",              effect: "Reaction on approach",       save: null },
    ];

    for (const def of maneuverDefs) {
      if (RiderEngine._hasFeature(actor, def.name)) {
        const dc = 8 + (actor.system?.attributes?.prof ?? 2) + Math.max(
          actor.system?.abilities?.str?.mod ?? 0,
          actor.system?.abilities?.dex?.mod ?? 0
        );
        known.push({
          ...def,
          description: `${def.effect} (DC ${dc})`,
          save: def.save ? { ...def.save, dc } : null,
        });
      }
    }
    return known;
  }

  static _buildSlotPicker(availableSlots) {
    if (!availableSlots?.length) return "";
    const options = availableSlots.map(s => {
      const label = s.level === 1 ? "1st" : s.level === 2 ? "2nd" : s.level === 3 ? "3rd" : `${s.level}th`;
      return `<option value="${s.level}">${label} (${s.current}/${s.max})</option>`;
    }).join("");
    return `<select class="ace-qol-rider-slot-picker" data-rider-id="divine-smite">${options}</select>`;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Creature Type Colors (for popup display)
  // ═══════════════════════════════════════════════════════════════════════════

  // ═══════════════════════════════════════════════════════════════════════════
  //  Rider Refund — GM-only: give back a consumed resource post-facto
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Render and wire refund buttons for consumed riders on a damage card.
   * Only called for GM users.
   */
  static wireRefundButtons(el, message) {
    const mFlags = message.flags?.[MODULE_ID];
    const consumedRiders = mFlags?.consumedRiders;
    if (!consumedRiders?.length) return;

    // ── Cross-card refund sync ──
    // Pre-roll button card and damage card both display refund buttons for
    // the same consumedRiders list. They get linked via `refundSourceMsgId`
    // (damage card → button card). Read the union of refunded IDs from BOTH
    // messages so a refund on either side is reflected on the other when it
    // re-renders. Without this, the GM could double-refund the same slot.
    const sourceMsgId = mFlags?.refundSourceMsgId;
    const sourceMsg = sourceMsgId ? game.messages?.get(sourceMsgId) : null;
    const sourceRefunded = sourceMsg?.flags?.[MODULE_ID]?.refundedRiders ?? [];
    const selfRefunded = mFlags?.refundedRiders ?? [];
    const refundedSet = new Set([...sourceRefunded, ...selfRefunded]);

    const alreadyRendered = !!el.querySelector?.(".ace-qol-refund-row");

    if (!alreadyRendered) {
      let refundHtml = '<div class="ace-qol-refund-section">';
      for (const cr of consumedRiders) {
        const refunded = refundedSet.has(cr.id);
        const label = RiderEngine.refundLabel(cr);
        if (refunded) {
          refundHtml += `<div class="ace-qol-refund-row ace-qol-refund-done" data-rider-id="${cr.id}">
            <i class="fas fa-check"></i> ${cr.name} — REFUNDED
          </div>`;
        } else {
          refundHtml += `<div class="ace-qol-refund-row" data-rider-id="${cr.id}">
            <button class="ace-qol-btn ace-qol-btn-refund" data-rider-id="${cr.id}" data-actor-id="${cr.actorId}"
                    data-resource-type="${cr.resourceType}" data-resource-level="${cr.resourceLevel ?? ""}">
              <i class="fas fa-rotate-left"></i> REFUND ${label}
            </button>
          </div>`;
        }
      }
      refundHtml += '</div>';

      const gmControls = el.querySelector?.(".ace-qol-dmg-gm-controls");
      const dmgCard = el.querySelector?.(".ace-qol-damage-card") ?? el.querySelector?.(".ace-qol-dmg-btn-card");
      if (gmControls) {
        gmControls.insertAdjacentHTML("afterend", refundHtml);
      } else if (dmgCard) {
        dmgCard.insertAdjacentHTML("beforeend", refundHtml);
      } else {
        return;
      }
    } else {
      // Already rendered — sync any rider that was refunded by the linked
      // sibling card after this card was first rendered.
      for (const cr of consumedRiders) {
        if (!refundedSet.has(cr.id)) continue;
        const row = el.querySelector?.(`.ace-qol-refund-row[data-rider-id="${cr.id}"]`);
        if (!row || row.classList.contains("ace-qol-refund-done")) continue;
        row.classList.add("ace-qol-refund-done");
        row.innerHTML = `<i class="fas fa-check"></i> ${cr.name} — REFUNDED`;
      }
    }

    el.querySelectorAll?.(".ace-qol-btn-refund")?.forEach(btn => {
      // Dedupe wiring across V13's renderChatMessage + renderChatMessageHTML
      if (btn.dataset.aceqolRefundWired === "1") return;
      btn.dataset.aceqolRefundWired = "1";

      btn.addEventListener("click", async () => {
        if (btn.disabled) return;
        btn.disabled = true; // optimistic lock against double-click

        const riderId = btn.dataset.riderId;
        const actorId = btn.dataset.actorId;
        const resType = btn.dataset.resourceType;
        const resLevel = btn.dataset.resourceLevel ? parseInt(btn.dataset.resourceLevel) : null;

        // Re-read flags fresh in case the linked sibling card refunded
        // this same rider between render and click.
        const freshSourceMsgId = message.flags?.[MODULE_ID]?.refundSourceMsgId;
        const freshSource = freshSourceMsgId ? game.messages?.get(freshSourceMsgId) : null;
        const freshSelfRefunded = message.flags?.[MODULE_ID]?.refundedRiders ?? [];
        const freshSourceRefunded = freshSource?.flags?.[MODULE_ID]?.refundedRiders ?? [];
        const alreadyDone = freshSelfRefunded.includes(riderId) || freshSourceRefunded.includes(riderId);

        if (alreadyDone) {
          ui.notifications?.info(`ACE QOL: Resource already refunded.`);
          const row = btn.closest(".ace-qol-refund-row");
          if (row) {
            row.classList.add("ace-qol-refund-done");
            row.innerHTML = `<i class="fas fa-check"></i> REFUNDED`;
          }
          return;
        }

        await RiderEngine.refundRiderResource(actorId, resType, resLevel, riderId);

        // Mark refund on THIS message
        const selfExisting = message.flags?.[MODULE_ID]?.refundedRiders ?? [];
        if (!selfExisting.includes(riderId)) {
          await message.setFlag(MODULE_ID, "refundedRiders", [...selfExisting, riderId]);
        }

        // Mark refund on the linked source message (button card)
        if (freshSource) {
          const srcExisting = freshSource.flags?.[MODULE_ID]?.refundedRiders ?? [];
          if (!srcExisting.includes(riderId)) {
            await freshSource.setFlag(MODULE_ID, "refundedRiders", [...srcExisting, riderId]);
          }
        }

        // Also propagate to any child messages that link back to this one
        // (case: GM clicks refund on button card → damage card already exists)
        try {
          const children = game.messages?.contents?.filter(
            m => m.flags?.[MODULE_ID]?.refundSourceMsgId === message.id
          ) ?? [];
          for (const child of children) {
            const childExisting = child.flags?.[MODULE_ID]?.refundedRiders ?? [];
            if (!childExisting.includes(riderId)) {
              await child.setFlag(MODULE_ID, "refundedRiders", [...childExisting, riderId]);
            }
          }
        } catch (err) {
          console.warn(`${MODULE_ID} | Refund child-sync failed:`, err);
        }

        btn.closest(".ace-qol-refund-row")?.classList.add("ace-qol-refund-done");
        btn.innerHTML = `<i class="fas fa-check"></i> REFUNDED`;
      });
    });
  }

  /**
   * Build a short human-readable label for the refund button.
   */
  static refundLabel(cr) {
    switch (cr.resourceType) {
      case "spell-slot": {
        const lvl = cr.resourceLevel ?? 1;
        const suffix = lvl === 1 ? "ST" : lvl === 2 ? "ND" : lvl === 3 ? "RD" : "TH";
        return `${lvl}${suffix} SLOT`;
      }
      case "pact-slot":      return "PACT SLOT";
      case "ki":              return "KI POINT";
      case "superiority-die": return "SUPERIORITY DIE";
      default:                return cr.name?.toUpperCase() ?? "RESOURCE";
    }
  }

  /**
   * Refund a consumed rider resource back to the actor.
   */
  static async refundRiderResource(actorId, resourceType, resourceLevel, riderId) {
    const actor = game.actors.get(actorId);
    if (!actor) {
      ui.notifications.warn("ACE QOL: Cannot refund — actor not found.");
      return;
    }

    switch (resourceType) {
      case "spell-slot": {
        const slotKey = `spell${resourceLevel}`;
        const current = actor.system?.spells?.[slotKey]?.value ?? 0;
        const max = actor.system?.spells?.[slotKey]?.max ?? 0;
        if (current < max) {
          await actor.update({ [`system.spells.${slotKey}.value`]: current + 1 });
          ui.notifications.info(`ACE QOL: Refunded level ${resourceLevel} spell slot to ${actor.name}.`);
        } else {
          ui.notifications.warn(`ACE QOL: ${actor.name} already has max level ${resourceLevel} slots.`);
        }
        break;
      }
      case "pact-slot": {
        const pact = actor.system?.spells?.pact;
        if (pact && pact.value < pact.max) {
          await actor.update({ "system.spells.pact.value": pact.value + 1 });
          ui.notifications.info(`ACE QOL: Refunded pact slot to ${actor.name}.`);
        } else {
          ui.notifications.warn(`ACE QOL: ${actor.name} already has max pact slots.`);
        }
        break;
      }
      case "ki": {
        const kiItem = actor.items.find(i => {
          const n = i.name?.toLowerCase() ?? "";
          return (n.includes("ki point") || n.includes("focus point") || n === "ki") && i.system?.uses;
        });
        if (kiItem) {
          const current = kiItem.system.uses.value ?? 0;
          const max = kiItem.system.uses.max ?? 0;
          if (current < max) {
            await kiItem.update({ "system.uses.value": current + 1 });
            ui.notifications.info(`ACE QOL: Refunded ki/focus point to ${actor.name}.`);
          } else {
            ui.notifications.warn(`ACE QOL: ${actor.name} already has max ki points.`);
          }
        }
        break;
      }
      case "superiority-die": {
        const supItem = actor.items.find(i => {
          const n = i.name?.toLowerCase() ?? "";
          return (n.includes("superiority") || n.includes("combat superiority")) && i.system?.uses;
        });
        if (supItem) {
          const current = supItem.system.uses.value ?? 0;
          const max = supItem.system.uses.max ?? 0;
          if (current < max) {
            await supItem.update({ "system.uses.value": current + 1 });
            ui.notifications.info(`ACE QOL: Refunded superiority die to ${actor.name}.`);
          } else {
            ui.notifications.warn(`ACE QOL: ${actor.name} already has max superiority dice.`);
          }
        }
        break;
      }
      default:
        ui.notifications.warn(`ACE QOL: Unknown resource type "${resourceType}" — cannot refund.`);
    }

    console.log(`${MODULE_ID} | Refunded ${resourceType}${resourceLevel ? ` (level ${resourceLevel})` : ""} to ${actor.name}`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Creature Type Colors (for popup display)
  // ═══════════════════════════════════════════════════════════════════════════

  static CREATURE_TYPE_COLORS = {
    undead:      "#ce93d8",  // purple
    fiend:       "#ff6d00",  // orange
    celestial:   "#ffd54f",  // gold
    aberration:  "#7c4dff",  // deep purple
    beast:       "#8d6e63",  // brown
    construct:   "#78909c",  // blue-grey
    dragon:      "#f44336",  // red
    elemental:   "#4fc3f7",  // light blue
    fey:         "#66bb6a",  // green
    giant:       "#a1887f",  // tan
    humanoid:    "#e0e0e0",  // white/grey
    monstrosity: "#ff8a65",  // deep orange
    ooze:        "#c6ff00",  // lime
    plant:       "#81c784",  // light green
  };
}
