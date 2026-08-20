// ─── ACE QOL — hooking the world into THE CLOCK ───────────────────────────────
//
// The plumbing that makes the clock move by PLAYING: where the party is (scene
// kind + pace), resting, and butchering a kill.
//
// Everything here goes through `TheClock.spend`. Nothing calls
// `game.time.advance` directly, so the two rules stay enforceable.
// ──────────────────────────────────────────────────────────────────────────────

import { MODULE_ID } from "./ace-qol.mjs";
import { TheClock } from "./the-clock.mjs";
import { MovementClock } from "./movement-clock.mjs";
import { SCENE_KINDS, paceSetFor } from "./travel-pace.mjs";
import { canHarvest, harvestHaul, partyPool, feedParty, sustenanceOf } from "./sustenance.mjs";

const LOG = "ace-qol | ClockWiring";

export class ClockWiring {

  /** Guards against the rest hook firing once per resting character. */
  static _lastMeal = 0;

  /* ═══ Where the party is ══════════════════════════════════════════════ */

  /**
   * Two dropdowns on the Scene Config sheet. This is the correct home for it:
   * a scene IS a dungeon or a road or a town, permanently, and the GM sets it
   * once when they build the map rather than being asked during play.
   */
  static registerSceneConfig() {
    Hooks.on("renderSceneConfig", (app, element) => {
      try {
        const root = element instanceof HTMLElement ? element : element?.[0];
        if (!root || root.querySelector(".ace-clock-scene")) return;

        const scene = app.document;
        const kind  = scene.getFlag(MODULE_ID, "sceneKind") ?? "dungeon";
        const pace  = scene.getFlag(MODULE_ID, "pace") ?? SCENE_KINDS[kind]?.pace ?? "cautious";
        const set   = paceSetFor(kind);

        const kindOpts = Object.entries(SCENE_KINDS)
          .map(([k, v]) => `<option value="${k}" ${k === kind ? "selected" : ""}>${v.label}</option>`).join("");
        const paceOpts = Object.entries(set)
          .map(([k, v]) => `<option value="${k}" ${k === pace ? "selected" : ""}>${v.label} — ${v.feetPerMinute} ft/min</option>`).join("");

        const block = document.createElement("div");
        block.className = "ace-clock-scene";
        block.innerHTML = `
          <fieldset style="margin-top:8px;">
            <legend>ACE — The Clock</legend>
            <div class="form-group">
              <label>Scene type</label>
              <select name="flags.${MODULE_ID}.sceneKind">${kindOpts}</select>
              <p class="hint">Towns do not charge time for walking about.</p>
            </div>
            <div class="form-group">
              <label>Travel pace</label>
              <select name="flags.${MODULE_ID}.pace">${paceOpts}</select>
              <p class="hint">Hurrying costs 5 passive Perception — you walk past things.</p>
            </div>
          </fieldset>`;

        // Drop it at the end of the Ambience/Basics tab, or failing that the form.
        const home = root.querySelector('.tab[data-tab="basics"]')
                  ?? root.querySelector('.tab[data-tab="ambience"]')
                  ?? root.querySelector("form");
        home?.appendChild(block);
        app.setPosition?.({ height: "auto" });
      } catch (err) {
        console.warn(`${LOG} | could not add scene controls — the scene still works, it just uses defaults.`, err);
      }
    });
  }

  /* ═══ Resting ═════════════════════════════════════════════════════════ */

  /**
   * A short rest is an hour and a long rest is eight. RAW, and the two biggest
   * time events in the game.
   *
   * ⚠️ dnd5e CAN ADVANCE TIME ITSELF. Both rest types carry an `advanceTime`
   * flag (shipped `false`, but a GM or another module may turn it on). If it is
   * on, the system has already moved the clock and charging again would bill the
   * rest twice — the exact rule this whole subsystem exists to keep. Read the
   * config we are handed; never assume.
   */
  static registerRests() {
    Hooks.on("dnd5e.restCompleted", async (actor, result, config) => {
      try {
        if (!game.user.isGM) return;

        // ⚠️🔴 SKIPPING THE CHARGE MUST NOT SKIP THE MEAL (2026-08-19).
        // This used to `return` here when dnd5e had advanced the clock itself,
        // which correctly avoided double-counting the time AND silently threw
        // away everything below: the movement settle, and the party eating. So
        // with "Advance Time" ticked in the rest dialog, nobody ever ate, hunger
        // never accumulated, and the whole sustenance system did nothing — with
        // one reassuring log line saying the clock was fine.
        //
        // Exactly the shape of the fall-damage bug on 08-14: a guard that skips
        // a WRITE also skipped the DECISION after it. The guard now covers only
        // the thing it is about.
        const dnd5eAlreadyAdvanced = !!(config?.advanceTime || result?.advanceTime);

        // Walking done before bedding down belongs to the day just finished.
        await MovementClock.settle("the party stopped to rest");

        const long = (config?.type ?? result?.type) === "long"
                  || result?.longRest === true;

        if (dnd5eAlreadyAdvanced) {
          console.log(`${LOG} | rest not charged — dnd5e advanced the clock itself (advanceTime is on). Everything else still runs.`);
        } else {
          const key = long ? "rest.long" : "rest.short";
          // Shared: the whole party resting together is ONE rest, so the second
          // character through this hook rides the first one's window.
          await TheClock.spend(key, { detail: actor?.name });
        }

        // A long rest is when people eat. A short one is not a meal.
        // ⚠️ OUTSIDE the clock branch, deliberately — see above.
        if (long) await this.feedTheParty();
      } catch (err) {
        console.error(`${LOG} | rest hook failed — the rest itself was unaffected.`, err);
      }
    });
  }

  /* ═══ Eating ══════════════════════════════════════════════════════════ */

  /**
   * The party eats, out of ONE shared pool. Runs once per long rest, not once
   * per character — resting is a party act and this hook fires per actor.
   */
  static async feedTheParty() {
    if (!game.settings.get(MODULE_ID, "sustenanceEnabled")) return;

    // ⚠️ ONE MEAL PER REST. `dnd5e.restCompleted` fires for EVERY resting
    // character, so without this the party would eat four dinners and burn
    // four days of rations in a single night.
    const now = Date.now();
    if (now - (this._lastMeal ?? 0) < 20_000) return;
    this._lastMeal = now;

    const party = (game.actors ?? []).filter(a => a.type === "character" && a.hasPlayerOwner);
    if (!party.length) return;

    const trackWater = game.settings.get(MODULE_ID, "sustenanceTrackWater");
    const pool = partyPool(party, MODULE_ID);

    // Water assumed available unless the GM says the region is dry. See the
    // setting's own hint for why tracking it everywhere is unusable.
    if (!trackWater) pool.water = Number.MAX_SAFE_INTEGER;

    const eaters = party.map(a => ({
      name: a.name,
      conMod: Number(a.system?.abilities?.con?.mod) || 0,
      daysHungry:  Number(a.getFlag(MODULE_ID, "daysHungry"))  || 0,
      daysThirsty: Number(a.getFlag(MODULE_ID, "daysThirsty")) || 0,
    }));

    const meal = feedParty(pool, eaters);

    // Spend the food actually eaten, cheapest sources first.
    await this._consume(party, "food", meal.foodEaten);
    if (trackWater) await this._consume(party, "water", meal.waterDrunk);

    // Carry hunger forward and apply exhaustion where it is owed.
    const suffered = [];
    for (const r of meal.results) {
      const actor = party.find(a => a.name === r.name);
      if (!actor) continue;
      await actor.setFlag(MODULE_ID, "daysHungry", r.daysHungry);
      await actor.setFlag(MODULE_ID, "daysThirsty", r.daysThirsty);
      if (r.exhaustion > 0) {
        suffered.push(`<strong>${r.name}</strong> — ${r.reasons.join("; ")}`);
        try {
          const cur = Number(actor.system?.attributes?.exhaustion) || 0;
          await actor.update({ "system.attributes.exhaustion": Math.min(6, cur + r.exhaustion) });
        } catch (err) {
          console.error(`${LOG} | could not apply exhaustion to ${r.name}.`, err);
        }
      }
    }

    await this._mealCard(meal, suffered, trackWater);
  }

  /** Remove what was eaten from the party's packs. */
  static async _consume(party, kind, amount) {
    let left = Number(amount) || 0;
    if (left <= 0) return;
    for (const actor of party) {
      for (const item of actor.items ?? []) {
        if (left <= 0) return;
        const s = sustenanceOf(item, MODULE_ID);
        if (!s || (s.kind !== kind && s.kind !== "both")) continue;
        const qty = Number(item.system?.quantity ?? 1) || 0;
        if (qty <= 0) continue;

        const need = Math.ceil(left / s.servings);
        const take = Math.min(qty, need);
        left -= take * s.servings;
        try {
          if (take >= qty) await item.delete();
          else await item.update({ "system.quantity": qty - take });
        } catch (err) {
          console.error(`${LOG} | could not consume ${item.name} from ${actor.name}.`, err);
        }
      }
    }
  }

  static async _mealCard(meal, suffered, trackWater) {
    const first = !game.settings.get(MODULE_ID, "sustenanceExplained");
    if (first) await game.settings.set(MODULE_ID, "sustenanceExplained", true);

    const rows = [
      `<div><strong>${meal.fed}</strong> of ${meal.need} ate tonight.` +
      (trackWater ? ` <strong>${meal.watered}</strong> drank.` : "") + `</div>`,
      `<div style="opacity:.85">${meal.remaining.food} day${meal.remaining.food === 1 ? "" : "s"} of rations left` +
      (trackWater ? `, ${meal.remaining.water} of water` : "") + `.</div>`,
    ];
    if (meal.shortFood > 0) {
      rows.push(`<div style="color:#c9a227;margin-top:4px">${meal.shortFood} went hungry — there was not enough food.</div>`);
    }
    if (suffered.length) {
      rows.push(`<div style="color:#d67a7f;margin-top:4px">${suffered.join("<br>")}</div>`);
    }
    if (first) {
      rows.push(`<div style="margin-top:8px;padding-top:6px;border-top:1px solid #3a3a2e;font-size:13px;opacity:.85">
        ACE is now tracking the party's food. Everyone eats from a shared pool on
        a long rest — it does not matter who carries it. You can switch this off
        in the ACE QOL settings.</div>`);
    }

    await ChatMessage.create({
      content: `<div style="padding:6px 2px;font-size:14px;line-height:1.55">${rows.join("")}</div>`,
      speaker: { alias: "Rations" },
      whisper: ChatMessage.getWhisperRecipients("GM").map(u => u.id),
    });
  }

  /* ═══ Butchering ══════════════════════════════════════════════════════ */

  /**
   * Butcher a carcass: costs time by size, yields meat capped by what the party
   * can carry.
   *
   * ⚠️ `canHarvest` is the ONLY gate. It answers beasts-only and it is not
   * overridable. Do not add a second opinion here.
   */
  static async harvest(tokenDoc) {
    const actor = tokenDoc?.actor;
    const verdict = canHarvest(actor);
    if (!verdict.ok) {
      // Silent by design for anything that is not meat — no prompt should ever
      // have offered this in the first place.
      if (!verdict.silent && verdict.reason) ui.notifications?.info(verdict.reason);
      return null;
    }

    const carry = this._sparePartyCapacity();
    const haul  = harvestHaul(actor, carry);
    if (haul.servings <= 0) {
      ui.notifications?.info(`There is nothing worth taking off ${tokenDoc.name}.`);
      return null;
    }

    const spent = await TheClock.spend("harvest", {
      minutes: haul.minutes,
      detail: tokenDoc.name,
    });

    // ⚠️ Report what HAPPENED. If the clock refused (mid-combat), say so rather
    // than pretending the party spent half an hour butchering during a fight.
    if (spent?.refused) {
      ui.notifications?.warn(`Not now — ${spent.reason}.`);
      return null;
    }

    const lines = [
      `<strong>${haul.servings}</strong> day${haul.servings === 1 ? "" : "s"} of meat taken from ${tokenDoc.name}.`,
      `<span style="opacity:.8">${haul.minutes} minutes' work.</span>`,
    ];
    if (haul.capped) {
      lines.push(`<span style="color:#c9a227">${haul.left} more left behind — nobody could carry it.</span>`);
    }

    await ChatMessage.create({
      content: `<div class="ace-qol-harvest" style="padding:6px 2px;font-size:14px;line-height:1.5">${lines.join("<br>")}</div>`,
      speaker: { alias: "Butchering" },
    });

    return haul;
  }

  /**
   * Rough spare carrying capacity across the party, in pounds.
   * Deliberately generous and cheap — this exists so a mammoth cannot end food
   * scarcity for the campaign, not to run an encumbrance simulation.
   */
  static _sparePartyCapacity() {
    try {
      let spare = 0;
      for (const actor of game.actors ?? []) {
        if (actor.type !== "character") continue;
        if (!actor.hasPlayerOwner) continue;
        const max = Number(actor.system?.attributes?.encumbrance?.max);
        const val = Number(actor.system?.attributes?.encumbrance?.value);
        if (Number.isFinite(max) && Number.isFinite(val)) spare += Math.max(0, max - val);
        else spare += 60;                       // no encumbrance data — assume a pack
      }
      return spare > 0 ? spare : 60;
    } catch (_) {
      return 60;
    }
  }

  static register() {
    const wired = [];
    const step = (label, fn) => {
      try { fn(); wired.push(label); }
      catch (err) { console.error(`${LOG} | "${label}" failed to register — that part is OFF, the rest still work.`, err); }
    };
    step("scene type + pace", () => this.registerSceneConfig());
    step("rests", () => this.registerRests());
    console.log(`${LOG} | wired: ${wired.join(", ") || "nothing"}`);
  }
}
