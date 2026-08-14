// ─── ACE: QOL — Flight Visuals ────────────────────────────────────────────────
// Makes a flying creature LOOK airborne: an offset drop-shadow that pulls away
// from the feet, a slight lift and a slow bob, and the token's actual elevation
// set so rulers, vision and other modules agree.
//
// ⚠️ TWO THINGS THIS DELIBERATELY DOES NOT DO (both 2026-08-11):
//   • It does NOT treat elevation as flight. A guard on a balcony is 30 ft up
//     and standing on stone. Only the `flying` STATUS counts.
//   • It does NOT put a whirlwind under an ordinary flier. A person under a Fly
//     spell is not standing in a tornado. `_addWhirlwind` survives for things
//     that really are a vortex; nothing calls it for plain flight.
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
        // ⚠️ READ THE ITEM'S NAME, NOT JUST THE ACTIVITY'S.
        // A spell's activity is usually called "Cast" or "Utility" — casting
        // the actual FLY spell produced an activity named nothing like "fly",
        // so the match failed and the spell did nothing at all. The staff only
        // worked because its activity happens to be called "Aerial Ascension".
        // Johnny, 2026-08-11: "when you're using the spell, you can set the
        // elevation, and it looks like it's hovering… the same for levitation."
        const actName  = String(activity?.name ?? "").toLowerCase();
        const itemName = String(activity?.item?.name ?? "").toLowerCase();
        const name = `${actName} ${itemName}`.trim();
        const caster = activity?.actor ?? activity?.item?.actor;
        if (!caster || !name) return;

        // ⚠️ AN ATTACK IS NEVER A TAKEOFF. Without this, a flying snake's BITE
        // matched on the word "Flying" and asked the snake how high it wanted
        // to go. Creature names carry their movement mode; their attacks do not.
        if (activity?.type === "attack") return;

        const isAscend  = /ascen|take\s*flight|fly|flight|levitat|soar|hover/.test(name);
        const isDescend = /descen|land|touch\s*down|alight/.test(name);
        if (!isAscend && !isDescend) return;

        // ⚠️ THE SPELL LIFTS ITS TARGET, NOT ITS CASTER.
        // Fly: "You touch a willing creature." Levitate: "One creature or
        // object of your choice." A wizard casting Fly on the barbarian must
        // put the BARBARIAN in the air. Fall back to the caster for
        // self-targeted abilities like the staff's ascension.
        const targets = [...(game.user?.targets ?? [])].filter(t => t?.document);
        const subjects = targets.length
          ? targets
          : (caster.getActiveTokens?.(true) ?? []).slice(0, 1);
        if (!subjects.length) return;

        if (isDescend) {
          for (const t of subjects) await FlightVisuals.descend(t);
          return;
        }

        // How high this particular magic can lift you.
        // Levitate is explicitly 20 ft in RAW, so it is capped whatever the
        // item text says. Anything else takes a cap from its own description
        // ("maximum altitude ... 30ft") and is otherwise uncapped.
        let maxFt = /levitat/.test(name) ? 20 : null;
        try {
          const txt = String(activity.description?.chatFlavor ?? "")
                    + String(activity.item?.system?.description?.value ?? "");
          const m = txt.replace(/<[^>]*>/g, " ").match(/maximum altitude[^.]*?(\d+)\s*(?:ft|feet)/i);
          if (m) maxFt = Math.min(maxFt ?? Infinity, Number(m[1]));
        } catch (_) { /* no cap declared */ }

        // A storm item lifts you on a vortex; a spell just flies.
        const vortex = FlightVisuals.isVortexSource(activity?.item);

        for (const subject of subjects) {
          const ft = await FlightVisuals.promptAltitude(subject, {
            defaultFt: Math.min(15, maxFt ?? 15), maxFt,
          });
          if (!Number.isFinite(ft)) continue;   // cancelled for this one only
          await FlightVisuals.ascend(subject, ft, { vortex });
        }
      } catch (err) {
        console.warn(`${MODULE_ID} | flight activity wiring failed (non-fatal):`, err);
      }
    });

    console.debug(`${MODULE_ID} | Flight Visuals online`);
  }

  /** Tokens we're currently decorating (client-local). */
  static _live = new Set();

  /**
   * Tokens whose flight is a STORM, not just flight.
   *
   * ⚠️ OPT-IN AND REMEMBERED. Johnny asked for the tornado back for the Staff of
   * the Stormforger only — "I don't want it fucking around with the other code
   * for elevations." So nothing infers it: an item must declare itself. It is
   * held here rather than re-derived because `_applyVisuals` is called again on
   * every elevation change and token redraw, and it has no idea what lifted the
   * creature in the first place.
   */
  static _vortex = new Set();

  /**
   * Does this item lift its user on a storm?
   * A flag wins; otherwise the name is enough for the obvious cases, so a GM's
   * homebrew tempest staff works without any setup.
   */
  static isVortexSource(item) {
    try {
      const flag = item?.getFlag?.(MODULE_ID, "vortexFlight");
      if (flag !== undefined) return !!flag;
      return /stormforger|tempest|tornado|whirlwind|cyclone|storm/i.test(String(item?.name ?? ""));
    } catch (_) { return false; }
  }

  /**
   * Is this creature actually FLYING?
   *
   * ⚠️ ELEVATION IS NOT FLIGHT. This used to answer yes to anything above
   * elevation 0, which meant a guard on a balcony, a sniper on a rooftop, an
   * NPC at the top of a staircase or anyone on an upper floor was treated as
   * airborne and got a whirlwind spinning under their feet.
   *
   * Johnny, 2026-08-11: "one of my guys is standing on a balcony 30 ft up above
   * the party… that should only be for a spell, like flying."
   *
   * Height is a position in space. Flight is a STATE, and 5e already has a
   * status for it. Only the status counts — set by the Fly spell, Levitate, a
   * griffon's wings, or our own ascend(). Nothing infers it from geometry.
   */
  static isFlying(token) {
    try {
      return !!token?.actor?.statuses?.has?.("flying");
    } catch (_) { return false; }
  }

  /**
   * Where the creature is, regardless of how it got there. Kept separate so no
   * future caller is tempted to reach for isFlying() when it means "is up high".
   */
  static elevationFt(token) {
    return Number(token?.document?.elevation ?? 0) || 0;
  }

  /**
   * Take off. Sets the token's real elevation and turns the look on.
   * @param {Token}  token
   * @param {number} [feet] — omitted → ask (default 15)
   */
  static async ascend(token, feet = null, { vortex = false } = {}) {
    try {
      if (!token?.document) return;
      if (vortex) FlightVisuals._vortex.add(token.id);
      let ft = Number(feet);
      if (!Number.isFinite(ft)) ft = await FlightVisuals.promptAltitude(token);
      if (!Number.isFinite(ft)) return;               // cancelled
      await token.document.update({ elevation: ft });
      // ⚠️ FLYING IS A STATE, SO SET IT. `isFlying` now reads only the status
      // (elevation alone is a balcony, not flight), which means ascending
      // without stamping it would leave the creature looking airborne while
      // every rule that asks "is this thing flying?" said no — and the visuals
      // would drop off at the next elevation change.
      await FlightVisuals._setFlyingStatus(token, true);
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
      FlightVisuals._vortex.delete(token.id);
      await FlightVisuals._setFlyingStatus(token, false);
      FlightVisuals._removeVisuals(token);
      console.log(`${MODULE_ID} | ${token.name} descends safely to the ground`);
    } catch (err) {
      console.warn(`${MODULE_ID} | descend failed:`, err);
    }
  }

  /**
   * Turn the `flying` status on or off, quietly.
   * Best-effort: a creature that is already flying (a griffon, a Fly spell
   * already running) must not have its existing effect disturbed.
   */
  static async _setFlyingStatus(token, on) {
    try {
      const actor = token?.actor;
      if (!actor?.toggleStatusEffect) return;
      const has = !!actor.statuses?.has?.("flying");
      if (has === !!on) return;                 // already in the right state
      await actor.toggleStatusEffect("flying", { active: !!on });
    } catch (err) {
      console.warn(`${MODULE_ID} | could not ${on ? "set" : "clear"} the flying status (visuals still applied):`, err);
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
      FlightVisuals._addAltitudeScale(token);
      // Only for flight that IS a storm — see `_vortex`.
      if (FlightVisuals._vortex.has(token.id)) FlightVisuals._addWhirlwind(token);

      // ⚠️ NO WHIRLWIND BY DEFAULT. Johnny, 2026-08-11: "I think maybe that's a
      // little bit too much anyways, that whirlwind underneath, even if they're
      // flying." He is right — a person under a Fly spell is not standing in a
      // tornado. The read we want is the SHADOW pulling away from the feet and
      // a slight lift, which is how the eye judges height.
      // `_addWhirlwind` is kept and exposed for things that genuinely ARE a
      // vortex (a djinni, an actual Whirlwind), just not for ordinary flight.
    } catch (err) {
      console.warn(`${MODULE_ID} | flight visuals apply failed (non-fatal):`, err);
    }
  }

  static _removeVisuals(token) {
    FlightVisuals._live.delete(token.id);
    // TMFX filter
    try {
      if (globalThis.TokenMagic?.deleteFilters) {
        TokenMagic.deleteFilters(token, TMFX_ID);
        // ⚠️ The lift filter is a SECOND filter id. Deleting only the shadow
        // would leave a token permanently 12% oversized and gently bobbing
        // after it lands.
        TokenMagic.deleteFilters(token, `${TMFX_ID}-lift`);
      }
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

  /**
   * A touch bigger the higher you go — the oldest depth cue there is.
   * Deliberately small: 30 ft of altitude is about 6% larger, enough for the
   * eye to read "up there" without the token looking like a different creature.
   */
  static _addAltitudeScale(token) {
    try {
      if (!globalThis.TokenMagic?.addUpdateFilters) return;
      const elev = Math.max(0, Number(token.document?.elevation ?? 0));
      if (elev <= 0) return;
      const scale = 1 + Math.min(0.12, elev * 0.002);   // caps at +12%
      TokenMagic.addUpdateFilters(token, [{
        filterType: "transform",
        filterId:   `${TMFX_ID}-lift`,
        scaleX: scale, scaleY: scale,
        animated: {
          translationY: {
            active: true, loopDuration: 3200, animType: "sinOscillation",
            val1: -0.012, val2: 0.012,        // a slow, shallow bob
          },
        },
      }]);
    } catch (err) {
      console.warn(`${MODULE_ID} | altitude scale failed (non-fatal):`, err);
    }
  }

  /**
   * Swirling wind beneath the token, looping until they land.
   * ⚠️ NOT part of ordinary flight any more — see `_applyVisuals`. Call it
   * deliberately for creatures that really are a vortex.
   */
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
