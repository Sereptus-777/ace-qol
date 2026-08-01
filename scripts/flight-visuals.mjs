// ─── ACE: QOL — Flight Visuals ────────────────────────────────────────────────
// Makes a flying creature LOOK airborne: a swirling whirlwind under the token,
// an offset drop-shadow that hovers (the "float" read), and the token's actual
// elevation set so rulers, vision and other modules agree.
//
// WHY OURS (Johnny 2026-07-27): he had this via the free "Flying Tokens"
// module, which uninstalled itself along with Sequencer and JB2A. Rebuilding it
// inside ACE means it can't vanish again, it matches our look, and it ships
// with the product instead of being a dependency users must discover.
//
// SCOPE — deliberately NOT Stormforger-specific (Rule #1: sweep the class).
// ANY creature that gains the `flying` status gets the treatment: the Fly
// spell, a griffon's wings, Aerial Ascension, a homebrew broom.
//
// GRACEFUL: Token Magic and Sequencer are both OPTIONAL. Missing either just
// costs that layer — elevation still changes, and nothing throws.
//
// Public API (game.aceQol.flight):
//   ascend(token, feet)  — set elevation + visuals (prompts if feet omitted)
//   descend(token)       — land: elevation 0, visuals off
//   isFlying(token)
// ──────────────────────────────────────────────────────────────────────────────

import { MODULE_ID } from "./ace-qol.mjs";

/** Swirling wind under the token — JB2A, whichever collection is installed. */
const WHIRLWIND_CANDIDATES = [
  "modules/jb2a_patreon/Library/7th_Level/Whirlwind/Whirlwind_01_BlueWhite_400x400.webm",
  "modules/jb2a_patreon/Library/7th_Level/Whirlwind/Whirlwind_01_BlueGrey_01_400x400.webm",
  "modules/JB2A_DnD5e/Library/7th_Level/Whirlwind/Whirlwind_01_BlueWhite_400x400.webm",
];

/** Sequencer effect name — one per token, so ending it is unambiguous. */
const fxName = (token) => `ace-flight-${token.id ?? token.document?.id}`;
/** Our TMFX filter id — namespaced so we never clobber another module's. */
const TMFX_ID = "ace-flight-hover";

export class FlightVisuals {

  static init() {
    // Any creature that GAINS or LOSES the flying status gets/loses the look.
    // activeGM-gated for the document write (elevation); the visuals themselves
    // are client-local and run everywhere so all players see them.
    const onEffect = (effect, kind) => {
      try {
        const actor = effect?.parent instanceof Actor ? effect.parent
          : (effect?.parent?.parent instanceof Actor ? effect.parent.parent : null);
        if (!actor) return;
        if (!effect?.statuses?.has?.("flying")) return;
        for (const token of actor.getActiveTokens?.(true) ?? []) {
          if (kind === "add") FlightVisuals._applyVisuals(token);
          else                FlightVisuals._removeVisuals(token);
        }
      } catch (err) {
        console.warn(`${MODULE_ID} | flight visuals hook failed (non-fatal):`, err);
      }
    };
    Hooks.on("createActiveEffect", (e) => onEffect(e, "add"));
    Hooks.on("deleteActiveEffect", (e) => onEffect(e, "remove"));

    // Landing by any route (elevation dragged to 0, another module, the HUD)
    // takes the visuals with it — the look must never outlive the flight.
    Hooks.on("updateToken", (tokenDoc, changes) => {
      try {
        if (!("elevation" in (changes ?? {}))) return;
        const token = tokenDoc.object;
        if (!token) return;
        if (Number(changes.elevation) <= 0) FlightVisuals._removeVisuals(token);
        else if (FlightVisuals.isFlying(token)) FlightVisuals._applyVisuals(token);
      } catch (_) { /* non-fatal */ }
    });

    // Re-assert after a token redraw (Foundry rebuilds the mesh and drops
    // filters — the same lesson as the petrified stone weld).
    Hooks.on("refreshToken", (token) => {
      try {
        if (!FlightVisuals._live.has(token.id)) return;
        if (!FlightVisuals._hasTmfx(token)) FlightVisuals._addHoverShadow(token);
      } catch (_) { /* non-fatal */ }
    });

    // ── Flight ABILITIES actually do something (Johnny 2026-07-27) ─────────
    // A dnd5e "utility" activity fires its usage card and stops — it has no way
    // to say "put this creature 15 feet in the air". Aerial Ascension therefore
    // consumed 5 charges and produced nothing. ACE closes that gap: any activity
    // that reads as taking off asks for an altitude, sets it, and turns on the
    // look; any that reads as landing puts them down. Name-matched so it works
    // for the Stormforger staff AND any homebrew "Fly"/"Land" ability.
    Hooks.on("dnd5e.postUseActivity", async (activity, _usageConfig, _results) => {
      try {
        // NO activeGM gate. `postUseActivity` fires ONLY on the client that used
        // the item — for a player-owned character that is the PLAYER, so gating
        // to the GM meant nothing ran at all when Alex used the staff (live,
        // 2026-07-27). The using client is already the right single client, and
        // a player owns their own token so the elevation write is permitted.
        const name = String(activity?.name ?? "").toLowerCase();
        const actor = activity?.actor ?? activity?.item?.actor;
        if (!actor || !name) return;
        const token = actor.getActiveTokens?.(true)?.[0];
        if (!token) return;

        const isAscend  = /ascen|take\s*flight|\bfly\b|levitat|soar/.test(name);
        const isDescend = /descen|land\b|touch\s*down|alight/.test(name);
        if (!isAscend && !isDescend) return;

        if (isDescend) { await FlightVisuals.descend(token); return; }

        // Altitude cap from the ability's own text when it states one
        // ("maximum altitude ... 30ft"), else uncapped.
        let maxFt = null;
        try {
          const txt = String(activity.description?.chatFlavor ?? "")
                    + String(activity.item?.system?.description?.value ?? "");
          const m = txt.replace(/<[^>]*>/g, " ").match(/maximum altitude[^.]*?(\d+)\s*(?:ft|feet)/i);
          if (m) maxFt = Number(m[1]);
        } catch (_) { /* no cap declared */ }

        const ft = await FlightVisuals.promptAltitude(token, { defaultFt: Math.min(15, maxFt ?? 15), maxFt });
        if (!Number.isFinite(ft)) return;   // cancelled — they keep the charges spent, GM can refund
        await FlightVisuals.ascend(token, ft);
      } catch (err) {
        console.warn(`${MODULE_ID} | flight activity wiring failed (non-fatal):`, err);
      }
    });

    console.debug(`${MODULE_ID} | Flight Visuals online`);
  }

  /** Tokens we're currently decorating (client-local). */
  static _live = new Set();

  static isFlying(token) {
    try {
      return !!(token?.actor?.statuses?.has?.("flying")
        || Number(token?.document?.elevation ?? 0) > 0);
    } catch (_) { return false; }
  }

  /**
   * Take off. Sets the token's real elevation and turns the look on.
   * @param {Token}  token
   * @param {number} [feet] — omitted → ask (default 15)
   */
  static async ascend(token, feet = null) {
    try {
      if (!token?.document) return;
      let ft = Number(feet);
      if (!Number.isFinite(ft)) ft = await FlightVisuals.promptAltitude(token);
      if (!Number.isFinite(ft)) return;               // cancelled
      await token.document.update({ elevation: ft });
      FlightVisuals._applyVisuals(token);
      console.log(`${MODULE_ID} | ${token.name} ascends to ${ft} ft`);
    } catch (err) {
      console.warn(`${MODULE_ID} | ascend failed:`, err);
    }
  }

  /** Land. Elevation to 0 and the look off. */
  static async descend(token) {
    try {
      if (!token?.document) return;
      await token.document.update({ elevation: 0 });
      FlightVisuals._removeVisuals(token);
      console.log(`${MODULE_ID} | ${token.name} descends safely to the ground`);
    } catch (err) {
      console.warn(`${MODULE_ID} | descend failed:`, err);
    }
  }

  /** "How high?" — defaults to 15 ft, the staff's comfortable hover. */
  static async promptAltitude(token, { defaultFt = 15, maxFt = null } = {}) {
    const capNote = maxFt ? ` (max ${maxFt} ft)` : "";
    const content = `
      <div class="ace-qol-adv-prompt">
        <div class="ace-qol-adv-targets">
          <span class="ace-qol-adv-attacker ace-qol-adv-pc">${foundry.utils.escapeHTML(token.name ?? "Creature")}</span>
          <i class="fas fa-wind"></i>
          <span class="ace-qol-adv-target">takes flight${capNote}</span>
        </div>
        <div class="ace-qol-adv-reason">
          <label style="display:flex;align-items:center;gap:10px;justify-content:center;font-size:1.05em;">
            Altitude
            <input type="number" name="ft" value="${defaultFt}" min="0" ${maxFt ? `max="${maxFt}"` : ""} step="5"
                   style="width:90px;text-align:center;font-size:1.15em;font-weight:700;">
            ft
          </label>
        </div>
      </div>`;
    try {
      const result = await foundry.applications.api.DialogV2.wait({
        window: { title: "Take Flight" },
        classes: ["ace-qol-adv-dialog"],
        content,
        buttons: [
          { action: "fly", label: "Fly", icon: "fa-solid fa-feather", default: true,
            callback: (ev, btn) => Number(btn.form?.elements?.ft?.value ?? defaultFt) },
          { action: "cancel", label: "Cancel", icon: "fa-solid fa-xmark", callback: () => null },
        ],
        rejectClose: false,
      });
      if (result == null) return NaN;
      const ft = Number(result);
      if (!Number.isFinite(ft)) return NaN;
      return maxFt ? Math.min(ft, maxFt) : ft;
    } catch (_) { return NaN; }
  }

  // ── visuals ───────────────────────────────────────────────────────────────

  static _applyVisuals(token) {
    try {
      FlightVisuals._live.add(token.id);
      FlightVisuals._addHoverShadow(token);
      FlightVisuals._addWhirlwind(token);
    } catch (err) {
      console.warn(`${MODULE_ID} | flight visuals apply failed (non-fatal):`, err);
    }
  }

  static _removeVisuals(token) {
    FlightVisuals._live.delete(token.id);
    // TMFX filter
    try {
      if (globalThis.TokenMagic?.deleteFilters) TokenMagic.deleteFilters(token, TMFX_ID);
    } catch (_) { /* TMFX absent or already clean */ }
    // Sequencer whirlwind
    try {
      globalThis.Sequencer?.EffectManager?.endEffects({ name: fxName(token) });
    } catch (_) { /* Sequencer absent */ }
  }

  static _hasTmfx(token) {
    try { return !!globalThis.TokenMagic?.hasFilterId?.(token, TMFX_ID); }
    catch (_) { return false; }
  }

  /**
   * The airborne read: an offset drop shadow whose distance breathes, so the
   * token appears to hover rather than sit flat on the ground. Params match the
   * installed Token Magic's own `shadow` filter shape; the oscillation uses
   * TMFX's documented syncCosOscillation animator.
   */
  static _addHoverShadow(token) {
    try {
      if (!globalThis.TokenMagic?.addUpdateFilters) return;   // TMFX optional
      const elev = Math.max(0, Number(token.document?.elevation ?? 0));
      // Higher up = shadow further away = reads as more altitude.
      const base = Math.min(60, 12 + elev * 0.8);
      TokenMagic.addUpdateFilters(token, [{
        filterType: "shadow",
        filterId:   TMFX_ID,
        rotation:   35,
        blur:       3,
        quality:    5,
        distance:   base,
        alpha:      0.55,
        padding:    12,
        shadowOnly: false,
        color:      0x000000,
        animated: {
          distance: {
            active: true, loopDuration: 2400, animType: "syncCosOscillation",
            val1: base * 0.82, val2: base * 1.18,
          },
        },
      }]);
    } catch (err) {
      console.warn(`${MODULE_ID} | hover shadow failed (non-fatal):`, err);
    }
  }

  /** Swirling wind beneath the token, looping until they land. */
  static _addWhirlwind(token) {
    try {
      const Seq = globalThis.Sequence;
      if (!Seq || !globalThis.Sequencer) return;              // Sequencer optional
      // Already running for this token? Don't stack.
      const existing = Sequencer.EffectManager.getEffects?.({ name: fxName(token) }) ?? [];
      if (existing.length) return;

      const file = WHIRLWIND_CANDIDATES.find(p => {
        try { return !!game.modules.get(p.split("/")[1])?.active; } catch (_) { return false; }
      });
      if (!file) return;                                      // no JB2A installed

      new Seq()
        .effect()
          .file(file)
          .attachTo(token, { bindAlpha: false })
          .belowTokens()
          .scaleToObject(1.5)
          .opacity(0.85)
          .fadeIn(400)
          .fadeOut(600)
          .persist()
          .name(fxName(token))
        .play();
    } catch (err) {
      console.warn(`${MODULE_ID} | whirlwind effect failed (non-fatal):`, err);
    }
  }
}
