// ─── ACE: QOL — Flight Visuals ────────────────────────────────────────────────
// Makes a flying creature LOOK airborne: an offset drop-shadow that pulls away
// from the feet, a slight lift and a slow bob, and the token's actual elevation
// set so rulers, vision and other modules agree.
//
// ⚠️ TWO THINGS THIS DELIBERATELY DOES NOT DO (both 2026-08-11):
//   • It does NOT treat elevation as flight. A guard on a balcony is 30 feet up
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
//   ascend(token, climbFt) — rise climbFt ABOVE where it already is (prompts if omitted)
//   descend(token)         — land on the ground beneath it, visuals off
//   isFlying(token)
// ──────────────────────────────────────────────────────────────────────────────

import { MODULE_ID } from "./ace-qol.mjs";

/** Swirling wind under the token — JB2A, whichever collection is installed. */
const WHIRLWIND_CANDIDATES = [
  "modules/jb2a_patreon/Library/7th_Level/Whirlwind/Whirlwind_01_BlueWhite_400x400.webm",
  "modules/jb2a_patreon/Library/7th_Level/Whirlwind/Whirlwind_01_BlueGrey_01_400x400.webm",
  "modules/JB2A_DnD5e/Library/7th_Level/Whirlwind/Whirlwind_01_BlueWhite_400x400.webm",
];

/**
 * A number, where "nothing" stays nothing.
 *
 * ⚠️🔴 `Number(null)` IS 0, AND 0 IS FINITE. That one line meant an UNCAPPED
 * climb was capped at zero: `climbTo(-30, 30)` returned -30 and the creature
 * never left the floor. Caught by the self-test on the same day the relative
 * climb was written (2026-09-03), which is the only reason it is not live.
 *
 * The same trap sat under the landing: a token with no remembered takeoff
 * reported that it had taken off from zero, with a message saying so.
 */
const aceNum = (v) => (v === null || v === undefined || v === "" ? NaN : Number(v));

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
        // ⚠️🔴 "ON THE GROUND" IS NOT "AT OR BELOW ZERO". This read the sign
        // of the elevation, which was survivable only while every creature took
        // off from zero. The moment a climb became relative (2026-09-03), a
        // wielder rising from -30 to 0 was declared landed and stripped of the
        // whirlwind at the top of his ascent, and one rising from -60 to -30
        // never got it at all. This very file already says elevation is a
        // position and flight is a state; the check now agrees with it.
        if (FlightVisuals.isFlying(token)) FlightVisuals._applyVisuals(token);
        else FlightVisuals._removeVisuals(token);
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

        // ⚠️ THE TORNADO IS NOT DRAWN HERE, AND MUST NOT BE. `storm-visuals.mjs`
        // has owned the takedown whirlwind since 2026-07-29 (`_maybeTornado`),
        // off the same hook. I added a second one here on 2026-09-03 without
        // grepping for it first, which is the exact thing that keeps going
        // wrong: build BESIDE an engine and you get two owners of one picture,
        // and the next bug lives in whichever one you are not reading.

        // ⚠️ AN ATTACK IS NEVER A TAKEOFF. Without this, a flying snake's BITE
        // matched on the word "Flying" and asked the snake how high it wanted
        // to go. Creature names carry their movement mode; their attacks do not.
        if (activity?.type === "attack") return;

        const isAscend  = /ascen|take\s*flight|\bfly\b|\bflight\b|levitat|soar|hover/.test(name);
        const isDescend = /descen|\bland\b|touch\s*down|alight/.test(name);
        if (!isAscend && !isDescend) return;

        // ⚠️ THE SPELL LIFTS ITS TARGET, NOT ITS CASTER.
        // Fly: "You touch a willing creature." Levitate: "One creature or
        // object of your choice." A wizard casting Fly on the barbarian must
        // put the BARBARIAN in the air.
        //
        // ⚠️🔴 BUT A SELF ABILITY LIFTS ITS USER, AND THIS NEVER CHECKED.
        // It preferred any target the user happened to have, and only fell back
        // to the caster when there were none. The old comment even said "fall
        // back to the caster for self-targeted abilities like the staff's
        // ascension" — which is not a check, it is a hope that nothing else is
        // targeted.
        //
        // Johnny, 2026-09-03: he was testing Tornado Takedown, still had that
        // creature targeted, then used Aerial Ascension and the STAFF LIFTED THE
        // ENEMY. "I was under the impression Aerial Ascension is only for the
        // person who is holding the staff." It is.
        //
        // ⚠️ READ THE ACTIVITY, NOT THE NAME. The ability declares its own
        // reach: range units "self", or a target that affects "self". Guessing
        // from the name would break the moment somebody writes a homebrew one.
        const selfOnly = (() => {
          try {
            if (String(activity?.range?.units ?? "") === "self") return true;
            const aff = activity?.target?.affects?.type;
            if (String(aff ?? "") === "self") return true;
          } catch (_) { /* unreadable → treat as not self, the old behaviour */ }
          return false;
        })();

        const targets = selfOnly ? [] : [...(game.user?.targets ?? [])].filter(t => t?.document);
        const subjects = targets.length
          ? targets
          : (caster.getActiveTokens?.(true) ?? []).slice(0, 1);
        if (!subjects.length) return;
        if (selfOnly) {
          console.log(`${MODULE_ID} | ${activity?.item?.name ?? "this ability"} is self-targeted, `
            + `so it lifts its user and not whoever happens to be targeted.`);
        }

        if (isDescend) {
          for (const t of subjects) await FlightVisuals.descend(t);
          return;
        }

        // How high this particular magic can lift you.
        // Levitate is explicitly 20 feet in RAW, so it is capped whatever the
        // item text says. Anything else takes a cap from its own description
        // ("maximum altitude ... 30 feet") and is otherwise uncapped.
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
      return /stormforger|tempest|tornado|whirlwind|cyclone|storm\b/i.test(String(item?.name ?? ""));
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
   * Johnny, 2026-08-11: "one of my guys is standing on a balcony 30 feet up above
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
   * Where a climb of `climbFt` from `fromFt` puts you.
   *
   * ⚠️ PURE ON PURPOSE. This is the sum that was wrong (a token at -30 told to
   * climb 30 was written to 30), and a sum that lives inside a document write
   * cannot be proven without a canvas. It is here, alone, so the self-test can
   * hold it to account.
   *
   * @param {number} fromFt  where the creature already is, negative included
   * @param {number} climbFt how far up, never down
   * @param {number|null} maxFt cap on the CLIMB, not on the resulting altitude
   */
  static climbTo(fromFt, climbFt, maxFt = null) {
    const from = aceNum(fromFt) || 0;
    let climb = aceNum(climbFt);
    if (!Number.isFinite(climb)) return NaN;
    climb = Math.max(0, climb);
    const cap = aceNum(maxFt);
    if (Number.isFinite(cap)) climb = Math.min(climb, cap);
    return from + climb;
  }

  /**
   * Where "the ground" is for a creature coming down.
   *
   * @param {Array<{elevation:number}>} grounds ACE ground-level regions below
   * @param {number|null} tookOffFrom where the ascent started, if remembered
   * @returns {{ft:number, how:string}}
   */
  static landingElevation(grounds, tookOffFrom = null) {
    const floors = (Array.isArray(grounds) ? grounds : [])
      .map(g => Number(g?.elevation))
      .filter(Number.isFinite);
    // The HIGHEST floor below, not the lowest: standing on the third storey of a
    // tower means landing on the third storey, not in the cellar.
    if (floors.length) return { ft: Math.max(...floors), how: "the floor beneath them" };
    const took = aceNum(tookOffFrom);
    if (Number.isFinite(took)) return { ft: took, how: "where they took off from" };
    return { ft: 0, how: "the scene floor, having nothing better to go on" };
  }

  /**
   * Take off.
   *
   * ⚠️🔴 THE NUMBER IS A CLIMB, NOT AN ALTITUDE, AND THIS USED TO WRITE IT RAW.
   * Johnny, 2026-09-03: his wielder was standing at elevation -30, the staff
   * caps the climb at 30 feet, and the token was put at 30 — thirty feet above
   * the map's zero rather than thirty feet above HIM. "He was at -30, so if I
   * fly up 30 ft ... he should have been at 0 ft ... the math has to go into the
   * token itself: what elevation it's at."
   *
   * A creature that takes off from a balcony, an upper floor, a ship's deck or
   * the bottom of a pit rises from THERE. Nothing in 5e measures flight from the
   * scene's zero, and the only reason this ever looked right is that most
   * creatures happen to be standing at zero when they cast.
   *
   * ⚠️ AND WHERE HE LEFT FROM IS REMEMBERED, on the token, so a descent has
   * somewhere to go back to. A flag rather than a Map: it survives a reload and
   * every client can read it, and the landing may well be handled by a
   * different client than the takeoff.
   *
   * @param {Token}  token
   * @param {number} [climbFt] — how far UP. Omitted → ask (default 15).
   */
  static async ascend(token, climbFt = null, { vortex = false } = {}) {
    try {
      if (!token?.document) return;
      if (vortex) FlightVisuals._vortex.add(token.id);
      const from = FlightVisuals.elevationFt(token);
      let climb = Number(climbFt);
      if (!Number.isFinite(climb)) climb = await FlightVisuals.promptAltitude(token);
      if (!Number.isFinite(climb)) return;               // cancelled
      const ft = FlightVisuals.climbTo(from, climb);     // the prompt already capped it
      await token.document.setFlag(MODULE_ID, "tookOffFrom", from);
      await token.document.update({ elevation: ft });
      // ⚠️ FLYING IS A STATE, SO SET IT. `isFlying` now reads only the status
      // (elevation alone is a balcony, not flight), which means ascending
      // without stamping it would leave the creature looking airborne while
      // every rule that asks "is this thing flying?" said no — and the visuals
      // would drop off at the next elevation change.
      await FlightVisuals._setFlyingStatus(token, true);
      FlightVisuals._applyVisuals(token);
      console.log(`${MODULE_ID} | ${token.name} climbs ${climb} feet from ${from} `
        + `and is now at ${ft} feet.`);
    } catch (err) {
      console.warn(`${MODULE_ID} | ascend failed:`, err);
    }
  }

  /**
   * Land.
   *
   * ⚠️🔴 "THE GROUND" IS NOT ZERO. This wrote elevation 0, so a creature who
   * took off from a pit at -30 landed thirty feet above the floor he had been
   * standing on, in mid-air. The staff's own text says "you can use your action
   * to safely descend to the ground" — the ground, meaning the one underneath
   * him, not the scene's origin.
   *
   * Three answers, in order of how much they actually know:
   *   1. The highest ACE ground-level region below him. This is the real floor
   *      and it is already modelled — `fall-pipeline.mjs` reads exactly this to
   *      decide how far a falling creature drops, and it would be absurd for
   *      landing and falling to disagree about where the ground is.
   *   2. Where he took off from, remembered by `ascend`.
   *   3. Zero, and only then.
   *
   * ⚠️ IMPORTED LATE ON PURPOSE. `fall-pipeline.mjs` pulls in the damage engine,
   * the profiles and the combat context; a top-level import here would drag all
   * of that into the load order for a file that only needs one number.
   */
  static async descend(token) {
    try {
      if (!token?.document) return;
      const from = FlightVisuals.elevationFt(token);
      let below = [];
      try {
        const { FallPipeline } = await import("./fall-pipeline.mjs");
        below = FallPipeline._groundsBelow?.(token.document, from) ?? [];
      } catch (err) {
        console.warn(`${MODULE_ID} | could not read the ground below ${token.name}:`, err);
      }
      const tookOff = token.document.getFlag?.(MODULE_ID, "tookOffFrom");
      const { ft: ground, how } = FlightVisuals.landingElevation(below, tookOff);

      await token.document.update({ elevation: ground });
      try { await token.document.unsetFlag(MODULE_ID, "tookOffFrom"); } catch (_) { /* nothing stored */ }
      FlightVisuals._vortex.delete(token.id);
      await FlightVisuals._setFlyingStatus(token, false);
      FlightVisuals._removeVisuals(token);
      console.log(`${MODULE_ID} | ${token.name} descends from ${from} to ${ground} feet (${how}).`);
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

  /** "How high?" — defaults to 15 feet, the staff's comfortable hover. */
  static async promptAltitude(token, { defaultFt = 15, maxFt = null } = {}) {
    // ⚠️ TELL HIM WHERE HE IS AND WHERE HE WILL END UP. The old box said
    // "Altitude" and took the number literally, which is how a creature at -30
    // asking to climb ended up below where he thought he was going. A number
    // that means "up from here" has to be labelled as one, and the answer has
    // to be on screen before he presses the button.
    const from = FlightVisuals.elevationFt(token);
    const start = Math.min(defaultFt, maxFt ?? defaultFt);
    const capNote = maxFt ? ` (up to ${maxFt} feet)` : "";
    const standing = from === 0
      ? "on the ground"
      : `at ${from} feet`;
    const content = `
      <div class="ace-qol-adv-prompt">
        <div class="ace-qol-adv-targets">
          <span class="ace-qol-adv-attacker ace-qol-adv-pc">${foundry.utils.escapeHTML(token.name ?? "Creature")}</span>
          <i class="fas fa-wind"></i>
          <span class="ace-qol-adv-target">takes flight${capNote}</span>
        </div>
        <div class="ace-qol-adv-reason" style="font-size:15px;">
          <label style="display:flex;align-items:center;gap:10px;justify-content:center;font-size:1.05em;">
            Climb
            <input type="number" name="ft" value="${start}" min="0" ${maxFt ? `max="${maxFt}"` : ""} step="5"
                   style="width:90px;text-align:center;font-size:1.15em;font-weight:700;">
            ft
          </label>
          <div style="text-align:center;margin-top:8px;opacity:0.9;">
            Standing ${standing} &rarr; <b class="ace-flight-dest">${from + start}</b> ft
          </div>
        </div>
      </div>`;
    try {
      const result = await foundry.applications.api.DialogV2.wait({
        window: { title: "Take Flight" },
        classes: ["ace-qol-adv-dialog"],
        content,
        render: (_ev, dialog) => {
          try {
            const root = dialog?.element ?? dialog;
            const input = root?.querySelector?.("input[name=ft]");
            const dest  = root?.querySelector?.(".ace-flight-dest");
            if (!input || !dest) return;
            input.addEventListener("input", () => {
              let v = Number(input.value);
              if (!Number.isFinite(v)) v = 0;
              if (maxFt) v = Math.min(v, maxFt);
              dest.textContent = String(from + Math.max(0, v));
            });
          } catch (_) { /* the readout is a courtesy; the number still works */ }
        },
        buttons: [
          { action: "fly", label: "Fly", icon: "fa-solid fa-feather", default: true,
            callback: (ev, btn) => Number(btn.form?.elements?.ft?.value ?? start) },
          { action: "cancel", label: "Cancel", icon: "fa-solid fa-xmark", callback: () => null },
        ],
        rejectClose: false,
      });
      if (result == null) return NaN;
      const ft = Number(result);
      if (!Number.isFinite(ft)) return NaN;
      // ⚠️ A CLIMB, SO NEVER NEGATIVE — typing -50 into a takeoff box must not
      // bury the creature. The cap is on how far up, which is how Johnny reads
      // the staff's "maximum altitude ... is 30ft": thirty feet of climb.
      return Math.max(0, maxFt ? Math.min(ft, maxFt) : ft);
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
  /**
   * How far above its own ground this token is.
   *
   * ⚠️ NOT ITS ELEVATION. A creature hovering ten feet above the floor of a pit
   * sits at -20, and reading that as its height gave it no shadow and no lift
   * at all — it looked exactly like a creature standing still. Height is
   * measured from where it took off; absolute elevation is a map coordinate.
   */
  static _heightAboveGround(token) {
    const now = Number(token?.document?.elevation ?? 0) || 0;
    const from = aceNum(token?.document?.getFlag?.(MODULE_ID, "tookOffFrom"));
    return Math.max(0, now - (Number.isFinite(from) ? from : 0));
  }

  static _addHoverShadow(token) {
    try {
      if (!globalThis.TokenMagic?.addUpdateFilters) return;   // TMFX optional
      const elev = FlightVisuals._heightAboveGround(token);
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
   * Deliberately small: 30 feet of altitude is about 6% larger, enough for the
   * eye to read "up there" without the token looking like a different creature.
   */
  static _addAltitudeScale(token) {
    try {
      if (!globalThis.TokenMagic?.addUpdateFilters) return;
      const elev = FlightVisuals._heightAboveGround(token);
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
  /** The first whirlwind file this JB2A install actually has. */
  static _whirlwindFile() {
    return WHIRLWIND_CANDIDATES.find(p => {
      try { return !!game.modules.get(p.split("/")[1])?.active; } catch (_) { return false; }
    }) ?? null;
  }

  static _addWhirlwind(token) {
    try {
      const Seq = globalThis.Sequence;
      if (!Seq || !globalThis.Sequencer) return;              // Sequencer optional
      // Already running for this token? Don't stack.
      const existing = Sequencer.EffectManager.getEffects?.({ name: fxName(token) }) ?? [];
      if (existing.length) return;

      const file = FlightVisuals._whirlwindFile();
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
