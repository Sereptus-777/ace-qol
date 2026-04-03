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

      // Optional riders (player chooses)
      for (const r of optionalRiders) {
        // Group maneuvers together
        const slotPicker = r.scalable ? RiderEngine._buildSlotPicker(r.resource.available) : "";
        const highlightBadge = r.highlight
          ? `<span class="ace-qol-rider-badge ace-qol-rider-highlight" style="color:${creatureTypeColor}">${r.highlight}</span>`
          : "";

        html += `<div class="ace-qol-rider-row" data-rider-id="${r.id}">
          <i class="fas ${r.icon}"></i>
          <span class="ace-qol-rider-name">${r.name}</span>
          <span class="ace-qol-rider-formula">${r.description}</span>
          ${highlightBadge}
          ${slotPicker}
          <button class="ace-qol-rider-select" data-rider-id="${r.id}">
            <i class="fas fa-check"></i> USE
          </button>
        </div>`;
      }

      // Dismiss button
      html += `<div class="ace-qol-rider-actions">
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

          // Wire USE buttons
          el.querySelectorAll(".ace-qol-rider-select").forEach(btn => {
            btn.addEventListener("click", () => {
              const riderId = btn.dataset.riderId;
              const rider = riders.find(r => r.id === riderId);
              if (!rider) return;

              // Check for slot picker override
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

              // Resolve with selected rider + any discharge riders
              // MUST set flag BEFORE dialog.close() — Foundry calls the close callback
              // synchronously inside close(), which would steal the resolve otherwise.
              resolved = true;
              resolve([...dischargeRiders, rider]);
              dialog.close();
            });
          });

          // Wire dismiss
          el.querySelector(".ace-qol-rider-dismiss")?.addEventListener("click", () => {
            resolved = true;
            resolve(dischargeRiders); // Still include discharge riders
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
