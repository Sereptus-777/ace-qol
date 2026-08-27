// ─── ACE: QOL — Holy Symbol of Ravenkind ─────────────────────────────────────
// Self-contained handler for the Curse of Strahd artifact's three powers.
//
// The SAVE powers (Hold Vampires, Turn Undead) ride the normal save-engine for
// their card + rolls + condition + target-clear; this module only adds their
// 30-ft animation. The condition each one applies (paralyzed vs frightened) is
// driven per-power by the activity's chatFlavor via the save-engine's
// activity-aware condition parse — see _wireItem() below.
//
// SUNLIGHT is not a save: it is a 10-minute, 30-ft sunlight zone. This module
// owns it end-to-end — a styled ACE card, real token light (so it actually
// illuminates + reveals), a persistent sun glow, automatic expiry, an
// Extinguish button, and a per-turn radiant tick for vampires / sunlight-
// hypersensitive creatures standing in it.
//
// RAW (Curse of Strahd, Holy Symbol of Ravenkind):
//   • 10 charges, regains 1d6+4 at dawn.
//   • Hold Vampires (1 charge): each vampire/vampire spawn within 30 feet that
//     can see the symbol — DC 15 Wis save or paralyzed until the symbol drops.
//   • Turn Undead (3 charges): each undead within 30 feet — DC 15 Wis save or
//     turned (frightened) for 1 minute or until it takes damage.
//   • Sunlight (5 charges): 30-ft bright + 30-ft dim real sunlight for 10 min.
// ──────────────────────────────────────────────────────────────────────────────

import { MODULE_ID } from "./ace-qol.mjs";
import { registerChatCardHandler } from "./chat-render-utils.mjs";
import { aceDistanceFt } from "./geometry-utils.mjs";

const ITEM_RE  = /holy symbol of ravenkind/i;
const WIRE_VERSION = 4;                 // bump to re-run the one-time data wiring
const SUN_SECONDS = 600;                // 10 minutes of game-time
const SUN_ROUNDS  = 100;                // 10 minutes = 100 combat rounds (6s each)
const SUN_RADIUS  = 30;                 // feet (bright); dim extends to 60
const VAMPIRE_RADIANT = 20;             // RAW sunlight-hypersensitivity damage

// Per-power burst animation. Each candidate list is tried in order against the
// Sequencer/JB2A database; the first that EXISTS plays, tinted to the power's
// colour. If none exist (or Sequencer/JB2A absent) a PIXI ring pulse is drawn
// instead — so there is ALWAYS a 30-ft visual, regardless of the user's JB2A.
const POWER_FX = {
  hold: {
    color: "#ffe9a8",                   // warm gold — holy restraint
    candidates: [
      "jb2a.cure_wounds.400px.blue",
      "jb2a.healing_generic.400px.bluewhite",
      "jb2a.markers.light_play.complete.001.blue",
      "jb2a.healing_generic.burst.bluewhite",   // confirmed-present free asset
    ],
  },
  turn: {
    color: "#fff2c0",                   // bright radiant — turning undead
    candidates: [
      "jb2a.divine_smite.caster.reversed.bluewhite",
      "jb2a.cure_wounds.400px.yellow",
      "jb2a.healing_generic.400px.yellowwhite",
      "jb2a.healing_generic.burst.bluewhite",   // confirmed-present free asset
    ],
  },
  sun: {
    color: "#ffd34d",                   // sun gold — daylight burst
    candidates: [
      "jb2a.sunbeam.01.700px.yellow",
      "jb2a.cure_wounds.400px.yellow",
      "jb2a.healing_generic.400px.yellowwhite",
      "jb2a.healing_generic.burst.bluewhite",   // confirmed-present free asset
    ],
  },
  // Persistent glow that hangs on the bearer for Sunlight's duration.
  sunGlow: [
    "jb2a.markers.light_play.complete.001.yellow",
    "jb2a.template_circle.aura.01.loop.large.bluewhite",
    "jb2a.spirit_guardians.yellow.ring",
    "jb2a.spirit_guardians.blueyellow.ring",     // confirmed-present
  ],
};

const HOLD_FLAVOR =
  "Each vampire or vampire spawn within 30 feet that can see the holy symbol " +
  "must succeed on a DC 15 Wisdom saving throw or be paralyzed until the symbol is lowered.";
const TURN_FLAVOR =
  "Each undead within 30 feet that can see the holy symbol must succeed on a " +
  "DC 15 Wisdom saving throw or be frightened for 1 minute or until it takes damage.";
const SUN_FLAVOR =
  "The symbol blazes with sunlight in a 30-foot radius (and dim light 30 feet " +
  "beyond) for 10 minutes. This light is sunlight.";

export class HolySymbol {

  // Templates currently being torn down — guards the effect↔zone removal loop.
  static _endingZones = new Set();

  static init() {
    // Fire animations + Sunlight on use.
    Hooks.on("dnd5e.postCreateUsageMessage", (activity, message) => {
      try { HolySymbol._onUse(activity, message); }
      catch (err) { console.warn(`${MODULE_ID} | HolySymbol._onUse threw:`, err); }
    });

    // Pre-target the eligible creature type for the AREA save powers BEFORE the
    // save engine reads targets: Hold Vampires → vampires only, Turn Undead →
    // undead only ("each X within 30 feet"). Returning false cancels the use when
    // nothing eligible is in range, so a charge isn't wasted.
    Hooks.on("dnd5e.preUseActivity", (activity) => {
      try { return HolySymbol._onPreUse(activity); }
      catch (err) { console.warn(`${MODULE_ID} | HolySymbol._onPreUse threw:`, err); }
    });

    // One-time data wiring (Turn Undead → save, per-power chatFlavor, charges).
    // init() is invoked from ace-qol's own `ready` hook, so `ready` has already
    // fired — call directly rather than via Hooks.once("ready"), which would
    // never run at this point. (Guarded: re-run if somehow called pre-ready.)
    try {
      if (game?.actors?.size != null) HolySymbol._ensureWired();
      else Hooks.once("ready", () => HolySymbol._ensureWired());
    } catch (err) {
      console.warn(`${MODULE_ID} | HolySymbol._ensureWired threw:`, err);
    }

    // Sunlight lifecycle: expire by game-time, tick vampires on their turn,
    // and keep the Sunlight Sensitivity affliction in sync with who's standing
    // in the light (on movement, turn change, and time advance).
    Hooks.on("updateWorldTime", () => {
      try { HolySymbol._sweepSunlight(); HolySymbol._sweepSunlightAffliction(); } catch (_) {}
    });
    Hooks.on("updateCombat", (combat, changed) => {
      try {
        if ("turn" in changed || "round" in changed) {
          HolySymbol._sunlightTurnTick(combat);
          HolySymbol._sweepSunlightAffliction();
          // Calm the bright cast-time flare once the bearer's turn ends.
          HolySymbol._dimSunlightAfterCasterTurn(combat);
        }
      } catch (_) {}
    });
    // The light rides the bearer's token (follows natively). On any token move
    // just re-evaluate who's in range — so disadvantage drops when a creature
    // leaves the light and returns when it steps back in.
    Hooks.on("updateToken", (doc, changed) => {
      try { if ("x" in changed || "y" in changed) HolySymbol._sweepSunlightAffliction(); } catch (_) {}
    });
    Hooks.on("deleteToken", () => {
      try { HolySymbol._sweepSunlightAffliction(); } catch (_) {}
    });

    // Chat-card buttons (Extinguish / Apply radiant). _wireCardButtons normalizes
    // native-vs-jQuery, so register on BOTH V12 + V13 hooks (V13 was missing →
    // the Extinguish/Radiant buttons were inert on V13).
    const _wireHolyCard = (msg, html) => {
      try { HolySymbol._wireCardButtons(msg, html); } catch (_) {}
    };
    // Both render hooks + a sweep of cards that were drawn before this
    // registered. See chat-render-utils — the raw hooks leave those
    // undecorated forever, which is how GM-only content reached a player.
    registerChatCardHandler(_wireHolyCard, "holy-symbol cards");

    // Expose for the attack pipeline (sunlight-disadvantage check) + macros.
    game.aceQol = game.aceQol ?? {};
    game.aceQol.HolySymbol = HolySymbol;

    console.log(`${MODULE_ID} | HolySymbol initialised.`);
  }

  // ─── Detection ───────────────────────────────────────────────────────────
  static _isHolySymbol(item) {
    return !!item && (ITEM_RE.test(item.name ?? "") || item.getFlag?.(MODULE_ID, "holySymbol"));
  }

  /**
   * Does this ability create real sunlight?
   *
   * Name first, then the text, because the rulebook says it outright: Sunbeam
   * and Sunburst both state "this light is sunlight", and so does the Holy
   * Symbol. A GM can also mark anything with the `sunlightSource` flag.
   *
   * ⚠️ Never Daylight. It is the obvious near-miss and RAW it is not sunlight.
   */
  static _isSunlightSource(item, activity) {
    if (!item) return false;
    try { if (item.getFlag?.(MODULE_ID, "sunlightSource")) return true; } catch (_) {}

    const name = `${item.name ?? ""} ${activity?.name ?? ""}`.toLowerCase();
    if (/\bdaylight\b/.test(name) && !/\bsunlight\b/.test(name)) return false;
    if (/\bsun\s*(light|beam|burst)\b|\bsunlight\b/.test(name)) return true;

    // The text is allowed to say so on its own, which catches homebrew.
    const text = String(item.system?.description?.value ?? "")
      .replace(/<[^>]*>/g, " ").toLowerCase();
    return /this light is sunlight|counts? as sunlight|is considered sunlight/.test(text);
  }

  static _casterToken(item) {
    const actor = item?.actor;
    if (!actor) return null;
    return actor.getActiveTokens?.()?.[0]
      ?? canvas.tokens?.placeables.find(t => t.actor?.id === actor.id)
      ?? null;
  }

  // ─── Creature eligibility (Hold Vampires / Turn Undead) ───────────────────
  static _creatureType(actor) {
    const t = actor?.system?.details?.type;
    return String((typeof t === "string" ? t : t?.value) ?? "").toLowerCase();
  }

  static _isUndead(actor) {
    return HolySymbol._creatureType(actor) === "undead";
  }

  static _isVampire(actor) {
    if (!actor) return false;
    if (/vampire/i.test(actor.name ?? "")) return true;
    const t = actor.system?.details?.type;
    const sub = `${t?.subtype ?? ""} ${(typeof t === "string" ? t : t?.value) ?? ""}`;
    if (/vampire/i.test(sub)) return true;
    // A "Vampire Weaknesses" feature (or any vampire-named feature) is the
    // reliable tell for a statted vampire whose token isn't literally named one.
    for (const i of actor.items ?? []) if (/vampire/i.test(i.name ?? "")) return true;
    return false;
  }

  // Nearest-edge, size-aware, 3D distance in feet (canonical — geometry-utils).
  static _tokenDistFt(a, b) {
    return aceDistanceFt(a, b);
  }

  // Replace the user's targets with exactly the creatures the power can affect,
  // gathered from within range. RAW: these are area effects, not pick-a-target.
  static _onPreUse(activity) {
    const item = activity?.item;
    if (!HolySymbol._isHolySymbol(item)) return;
    const power = String(activity?.name ?? "");

    let pred = null, label = "";
    if (/hold\s*vampires/i.test(power)) { pred = HolySymbol._isVampire; label = "vampire"; }
    else if (/turn\s*undead/i.test(power)) { pred = HolySymbol._isUndead; label = "undead creature"; }
    else return;   // Sunlight + anything else: no auto-targeting

    const casterToken = HolySymbol._casterToken(item);
    if (!casterToken) return;
    const rangeFt = Number(activity?.range?.value) || SUN_RADIUS;

    const eligible = (canvas.tokens?.placeables ?? []).filter(t =>
      t !== casterToken && t.actor && pred(t.actor)
      && HolySymbol._tokenDistFt(casterToken, t) <= rangeFt + 0.1);

    if (!eligible.length) {
      ui.notifications?.warn(`No ${label} within ${rangeFt} feet — ${power} affects no one.`);
      return false;   // cancel: don't burn a charge on an empty area
    }

    // Swap the live targets for exactly the eligible creatures.
    for (const t of [...(game.user.targets ?? [])]) {
      t.setTarget?.(false, { user: game.user, releaseOthers: false, groupSelection: false });
    }
    for (const t of eligible) {
      t.setTarget?.(true, { user: game.user, releaseOthers: false, groupSelection: false });
    }
    console.log(`${MODULE_ID} | ${power}: auto-targeted ${eligible.length} ${label}(s) within ${rangeFt} feet.`);
  }

  // ─── Use dispatch ────────────────────────────────────────────────────────
  static _onUse(activity, message) {
    // Only the user who activated runs this (Sequencer broadcasts the visual).
    if (message?.author?.id && message.author.id !== game.user.id) return;
    const item = activity?.item;
    const power = String(activity?.name ?? "");

    // ⚠️🔴 SUNLIGHT IS A THING THAT EXISTS, NOT A CHARGE ON ONE ITEM (2026-08-22).
    //
    // Every line below used to sit behind `if (!_isHolySymbol(item)) return`,
    // so the ONLY sunlight ACE understood was a charge of the Holy Symbol of
    // Ravenkind. Johnny cast a SPELL called Sunlight, standing next to a
    // vampire, and nothing happened at all — the animation played because that
    // comes from elsewhere, and the module that knows what sunlight does to a
    // vampire never even looked.
    //
    // Sunbeam and Sunburst say "this light is sunlight" in as many words, and a
    // GM may have any number of homebrew sources. All of them should burn a
    // vampire. So the ZONE is now available to anything that makes sunlight,
    // and the Holy Symbol is simply one such thing.
    //
    // ⚠️ DAYLIGHT IS DELIBERATELY NOT ON THE LIST. RAW it does not create
    // sunlight, and a vampire standing in it takes nothing. Getting that wrong
    // in the generous direction would quietly rewrite the monster.
    if (!HolySymbol._isHolySymbol(item)) {
      if (HolySymbol._isSunlightSource(item, activity)) {
        const t = HolySymbol._casterToken(item);
        if (t) HolySymbol._activateSunlight(t, item);
      }
      return;
    }

    const token = HolySymbol._casterToken(item);
    if (!token) return;

    if (/hold\s*vampires/i.test(power)) {
      HolySymbol._fireBurst(token, POWER_FX.hold);
    } else if (/turn\s*undead/i.test(power)) {
      HolySymbol._fireBurst(token, POWER_FX.turn);
    } else if (/sunlight/i.test(power)) {
      HolySymbol._activateSunlight(token, item);
    }
  }

  // ─── Animations ──────────────────────────────────────────────────────────
  // Sequencer's `.size(n, {gridUnits:true})` measures n in GRID SQUARES, not
  // feet. Convert a real distance (e.g. a 60-ft diameter) into squares using
  // the scene's ft-per-square so a "30-ft" effect is actually 30 feet, not 300.
  static _gridUnits(distanceFt) {
    return distanceFt / (canvas.grid?.distance || 5);
  }

  static _firstExisting(candidates) {
    const db = window.Sequencer?.Database;
    if (!db?.entryExists) return null;
    for (const c of candidates) {
      try { if (db.entryExists(c)) return c; } catch (_) {}
    }
    return null;
  }

  static async _fireBurst(token, fx) {
    const file = HolySymbol._firstExisting(fx.candidates);
    if (file && window.Sequence) {
      try {
        await new window.Sequence()
          .effect()
            .file(file)
            .atLocation(token)
            .size(HolySymbol._gridUnits(SUN_RADIUS * 2), { gridUnits: true })   // 60 feet diameter = 30 feet radius
            .tint(fx.color)
            .opacity(0.9)
            .fadeIn(150)
            .fadeOut(500)
          .play();
        return;
      } catch (err) {
        console.debug(`${MODULE_ID} | HolySymbol burst Sequencer path failed, using PIXI:`, err?.message ?? err);
      }
    }
    HolySymbol._pixiPulse(token, SUN_RADIUS, fx.color);
  }

  // Always-available fallback: an expanding ring drawn on the canvas, sized to
  // the real 30-ft radius using the scene's grid scale.
  static _pixiPulse(token, radiusFt, color) {
    try {
      const grid = canvas.grid;
      const pxR = (radiusFt / (grid?.distance || 5)) * (grid?.size || 100);
      const center = token.center ?? { x: token.x ?? 0, y: token.y ?? 0 };
      const colorInt = parseInt(String(color).replace("#", ""), 16) || 0xffe9a8;
      const layer = canvas.primary ?? canvas.stage;
      const g = new PIXI.Graphics();
      g.position.set(center.x, center.y);
      layer.addChild(g);

      const start = performance.now();
      const dur = 850;
      const step = (now) => {
        const t = Math.min(1, (now - start) / dur);
        const eased = 1 - Math.pow(1 - t, 3);
        const a = 1 - eased;
        g.clear();
        g.lineStyle(6, colorInt, 0.9 * a);
        g.beginFill(colorInt, 0.18 * a);
        g.drawCircle(0, 0, pxR * eased);
        g.endFill();
        if (t < 1) requestAnimationFrame(step);
        else { try { layer.removeChild(g); g.destroy(); } catch (_) {} }
      };
      requestAnimationFrame(step);
    } catch (err) {
      console.debug(`${MODULE_ID} | HolySymbol PIXI pulse failed:`, err?.message ?? err);
    }
  }

  // ─── Sunlight: activate ──────────────────────────────────────────────────
  static async _activateSunlight(token, item) {
    HolySymbol._fireBurst(token, POWER_FX.sun);          // initial flare
    // If this bearer already has sunlight up, end it first so the new snapshot
    // captures their REAL prior token light (not a stacked sunlight).
    try {
      if (token.document?.getFlag?.(MODULE_ID, "holySymbolSunlight")) {
        await HolySymbol._removeSunlightZone(token.document);
      }
    } catch (_) {}
    let bearer = null;
    try { bearer = await HolySymbol._placeSunlightZone(token); }
    catch (err) { console.warn(`${MODULE_ID} | Sunlight placement failed (perms?):`, err); }
    try { await HolySymbol._postSunlightCard(item, token, bearer); }
    catch (err) { console.warn(`${MODULE_ID} | Sunlight card post failed:`, err); }
    // Afflict any sunlight-sensitive creatures already in range.
    try { await HolySymbol._sweepSunlightAffliction(); } catch (_) {}
  }

  // The sunlight lives entirely on the BEARER'S TOKEN — no template, no separate
  // light. The token's own light (sunburst animation) is the visual and follows
  // the bearer natively; a flag on the token holds the timer + the prior-light
  // snapshot. Everything (disadvantage area, panel timer, expiry, extinguish)
  // keys off this token, so it all travels with the bearer for free.
  static async _placeSunlightZone(token) {
    const tdoc = token.document;
    if (!tdoc) return null;
    const prevLight = tdoc.light?.toObject?.() ?? foundry.utils.deepClone(tdoc.light ?? {});
    const expires = (game.time?.worldTime ?? 0) + SUN_SECONDS;
    try {
      await tdoc.update({
        light: {
          bright: 30, dim: 60, color: "#ffdca8", alpha: 0.5,
          attenuation: 0.55, luminosity: 0.55,
          animation: { type: "sunburst", speed: 2, intensity: 4 },
        },
        [`flags.${MODULE_ID}.holySymbolSunlight`]: { expires, prevLight },
      });
    } catch (err) { console.warn(`${MODULE_ID} | Sunlight token-light apply failed:`, err); }
    return tdoc;
  }

  // Every token that is currently a sunlight BEARER (has the flag). The token's
  // own light is the zone; "in the light" = within SUN_RADIUS of a bearer.
  static _activeSunBearers() {
    return [...(canvas.scene?.tokens ?? [])].filter(td => td.getFlag?.(MODULE_ID, "holySymbolSunlight"));
  }

  // Is this token standing in any active sunlight (within range of a bearer,
  // excluding itself)? Real-time off live positions, so it follows the bearer.
  static _inAnySunlight(creatureToken, bearers) {
    const list = bearers ?? HolySymbol._activeSunBearers().map(td => td.object).filter(Boolean);
    return list.some(b => b && b !== creatureToken
      && HolySymbol._tokenDistFt(b, creatureToken) <= SUN_RADIUS + 0.1);
  }

  // PUBLIC: synthetic effects-panel entries for sunlight zones THIS actor cast,
  // with rounds remaining (from the zone's game-time expiry). Rendered by the
  // ACE effects panel like a Class Aura — panel-only, NO token status icon.
  static getCasterSunlightIndicators(actor) {
    const out = [];
    try {
      if (!actor) return out;
      const now = game.time?.worldTime ?? 0;
      for (const td of HolySymbol._activeSunBearers()) {
        if (td.actor?.id !== actor.id) continue;   // only the bearer's own panel
        const d = td.getFlag(MODULE_ID, "holySymbolSunlight");
        const rounds = Math.max(0, Math.ceil(Math.max(0, (d?.expires ?? now) - now) / 6));
        out.push({
          id: `hsor-sun-${td.id}`,
          name: "Sunlight — Holy Symbol",
          icon: "icons/magic/light/explosion-star-glow-yellow.webp",
          rounds,
          tokenId: td.id,
          sceneId: td.parent?.id ?? canvas.scene?.id,
        });
      }
    } catch (_) { /* non-fatal */ }
    return out;
  }

  // PUBLIC: extinguish the sunlight on a bearer token (effects-panel dismiss,
  // which stays put while chat scrolls away).
  static async extinguishSunlightZone(tokenId, sceneId) {
    const scene = game.scenes.get(sceneId) ?? canvas.scene;
    const td = scene?.tokens?.get?.(tokenId);
    if (td) await HolySymbol._removeSunlightZone(td);
  }

  // ─── Sunlight: remove / expire ───────────────────────────────────────────
  // Restore the bearer's prior token light, clear the flag, then re-sweep so
  // anyone who was in the light loses Sunlight Sensitivity.
  static async _removeSunlightZone(tdoc) {
    if (!tdoc) return;
    if (HolySymbol._endingZones.has(tdoc.id)) return;   // re-entry guard
    HolySymbol._endingZones.add(tdoc.id);
    try {
      const d = tdoc.getFlag?.(MODULE_ID, "holySymbolSunlight");
      await tdoc.update({
        light: d?.prevLight ?? { bright: 0, dim: 0, animation: { type: "none" } },
        [`flags.${MODULE_ID}.-=holySymbolSunlight`]: null,
      });
      try { await HolySymbol._sweepSunlightAffliction(); } catch (_) {}
    } catch (err) {
      console.warn(`${MODULE_ID} | Sunlight extinguish failed:`, err);
    } finally {
      HolySymbol._endingZones.delete(tdoc.id);
    }
  }

  static _sweepSunlight() {
    if (game.users?.activeGM !== game.user) return;   // one client handles expiry
    const now = game.time?.worldTime ?? 0;
    for (const td of HolySymbol._activeSunBearers()) {
      const d = td.getFlag(MODULE_ID, "holySymbolSunlight");
      if (d && now >= d.expires) HolySymbol._removeSunlightZone(td);
    }
  }

  // Once the bearer's turn ends, calm the token light from the bright cast-time
  // flare to a quiet shimmer (still clearly lit, no longer washing out the map).
  // The illumination radius is unchanged — only the warm tint + animation drop.
  static async _dimSunlightAfterCasterTurn(combat) {
    if (game.users?.activeGM !== game.user) return;
    const curUuid = combat?.combatant?.actor?.uuid ?? null;
    if (!curUuid) return;
    for (const td of HolySymbol._activeSunBearers()) {
      const d = td.getFlag(MODULE_ID, "holySymbolSunlight");
      if (!d || d.dimmed) continue;
      if (curUuid === td.actor?.uuid) continue;   // still the bearer's turn → stay bright
      try {
        await td.update({
          "light.alpha": 0.12,
          "light.animation.intensity": 1,
          [`flags.${MODULE_ID}.holySymbolSunlight.dimmed`]: true,
        });
      } catch (_) { /* non-fatal */ }
    }
  }

  // ─── Sunlight: per-turn vampire / hypersensitive tick ────────────────────
  static _sunlightTurnTick(combat) {
    if (game.users?.activeGM !== game.user) return;   // GM adjudicates
    const bearers = HolySymbol._activeSunBearers().map(td => td.object).filter(Boolean);
    if (!bearers.length) return;

    const tok = combat?.combatant?.token?.object
      ?? canvas.tokens?.get(combat?.combatant?.tokenId);
    if (!tok?.actor) return;
    if (!HolySymbol._inAnySunlight(tok, bearers)) return;

    const sens = HolySymbol._sunlightSensitivity(tok.actor);
    if (!sens.sensitive) return;
    HolySymbol._postSunlightTurnCard(tok, sens);
  }

  /**
   * PUBLIC: is this token currently standing in active sunlight, and is it
   * sunlight-sensitive? The attack pipeline uses this to impose disadvantage.
   * Distance-based off the bearer's live position, so it follows the bearer.
   * @returns {{inLight:boolean, sensitive:boolean, hyper:boolean}}
   */
  static sunlightStatus(token) {
    const out = { inLight: false, sensitive: false, hyper: false };
    try {
      if (!token) return out;
      out.inLight = HolySymbol._inAnySunlight(token);
      if (!out.inLight) return out;
      const s = HolySymbol._sunlightSensitivity(token.actor);
      out.sensitive = s.sensitive;
      out.hyper = s.hyper;
    } catch (_) { /* non-fatal */ }
    return out;
  }

  // ─── Sunlight Sensitivity affliction (full RAW disadvantage) ──────────────
  // A real, visible Active Effect carrying ACE's disadvantage flags, applied to
  // sunlight-sensitive creatures while they STAND in a sunlight zone and removed
  // when they leave / the light ends. ACE enforces these flags on every roll:
  //   • attacks  — combat-state (the attack prompt)
  //   • ability checks / skills — flags-engine (hooks dnd5e's roll events)
  // RAW split:
  //   • Sunlight Hypersensitivity (vampires) → disadvantage on attacks AND all
  //     ability checks.
  //   • Sunlight Sensitivity (drow, kobolds…) → disadvantage on attacks and
  //     sight-based Perception.
  static async _applySunlightAffliction(actor, hyper) {
    try {
      // OVERRIDE (not CUSTOM): ACE reads these via actor.getFlag, so the flag
      // must actually be WRITTEN. mode 0/CUSTOM is a no-op without a handler —
      // that was why the disadvantage never applied.
      const OV = CONST.ACTIVE_EFFECT_MODES.OVERRIDE;
      const changes = [{ key: "flags.ace-qol.disadvantage.attack.all", mode: OV, value: "1" }];
      if (hyper) changes.push({ key: "flags.ace-qol.disadvantage.ability.check.all", mode: OV, value: "1" });
      else       changes.push({ key: "flags.ace-qol.disadvantage.skill.prc",         mode: OV, value: "1" });
      await actor.createEmbeddedDocuments("ActiveEffect", [{
        name: "Sunlight Sensitivity",
        img: "icons/magic/light/explosion-star-glow-yellow.webp",
        description: hyper
          ? "<p>Standing in sunlight: <b>disadvantage on attack rolls and ability checks</b>.</p>"
          : "<p>Standing in sunlight: <b>disadvantage on attack rolls and sight-based Perception checks</b>.</p>",
        changes,
        flags: { [MODULE_ID]: { sunlightAffliction: true } },
      }]);
    } catch (err) {
      console.warn(`${MODULE_ID} | Sunlight affliction apply failed for ${actor?.name}:`, err);
    }
  }

  // Reconcile every token's Sunlight Sensitivity effect against the live zones:
  // apply to sensitive creatures standing in light, remove from those who left
  // (or when the light is gone). Driven by movement, turn change, and time.
  static async _sweepSunlightAffliction() {
    if (game.users?.activeGM !== game.user) return;
    const bearers = HolySymbol._activeSunBearers().map(td => td.object).filter(Boolean);
    for (const t of canvas.tokens?.placeables ?? []) {
      const actor = t.actor;
      if (!actor) continue;
      const existing = actor.effects.find(e => e.getFlag?.(MODULE_ID, "sunlightAffliction"));
      const sens = HolySymbol._sunlightSensitivity(actor);
      const inLight = sens.sensitive && bearers.length && HolySymbol._inAnySunlight(t, bearers);
      if (inLight && !existing) {
        await HolySymbol._applySunlightAffliction(actor, sens.hyper);
      } else if (!inLight && existing) {
        try { await existing.delete(); } catch (_) {}
      }
    }
  }

  // A creature is sunlight-sensitive if any of its features / effects MENTION
  // sunlight sensitivity — checked in NAME *and* description text, because the
  // monster-manual phrasing ("Sunlight Hypersensitivity") lives in the BODY of
  // a feature usually named "Vampire Weaknesses", not in the feature's name.
  // "Hyper" (or "radiant ... starts its turn in sunlight") → it takes the damage.
  static _sunlightSensitivity(actor) {
    const out = { sensitive: false, hyper: false };
    if (!actor) return out;

    // Sunlight (Hyper)Sensitivity is a NAMED trait — match the trait NAME and
    // never scan descriptions. Scanning prose false-positived on anything that
    // merely mentions sunlight mechanics (the Sunlight / Daylight spell, or an
    // innate-casting FEAT that lists Sunlight). That's how Varek Thalor, a CR 30
    // caster who knows Sunlight, kept getting flagged. A real sunlight-sensitive
    // creature (drow, kobold, vampire) carries a trait literally named
    // "Sunlight Sensitivity" / "Sunlight Hypersensitivity".
    const HYPER = /sunlight\s*hypersensitiv/i;
    const PLAIN = /sunlight\s*sensitiv/i;
    const consider = (name) => {
      const n = String(name ?? "").trim();
      if (!n) return;
      if (HYPER.test(n)) { out.sensitive = true; out.hyper = true; }
      else if (PLAIN.test(n)) { out.sensitive = true; }
    };

    // The genuine trait is a feat item named for it.
    for (const i of actor.items ?? []) {
      if (i.type === "feat") consider(i.name);
    }
    // Or a non-ACE ActiveEffect by that name. NEVER our own applied affliction
    // (it is named "Sunlight Sensitivity" and would re-match its own name).
    for (const e of actor.effects ?? []) {
      if (e.getFlag?.(MODULE_ID, "sunlightAffliction")) continue;
      consider(e.name ?? e.label);
    }
    // Safety net: anything literally named a vampire.
    if (/vampire/i.test(actor.name ?? "")) { out.sensitive = true; out.hyper = true; }
    return out;
  }

  // ─── Cards ───────────────────────────────────────────────────────────────
  static async _postSunlightCard(item, token, bearer) {
    const actor = item?.actor;
    const content = `
<div style="background:#15110a;border:1px solid #d4af37;border-radius:8px;padding:12px 14px;color:#f3ead2;font-size:15px;line-height:1.5;">
  <div style="display:flex;align-items:center;gap:10px;border-bottom:1px solid #6b5a2a;padding-bottom:8px;margin-bottom:8px;">
    <span style="font-size:24px;line-height:1;">☀️</span>
    <div>
      <div style="font-weight:700;color:#ffd86b;font-size:17px;">Sunlight</div>
      <div style="font-size:13px;color:#c9bd9a;">Holy Symbol of Ravenkind</div>
    </div>
  </div>
  <p style="margin:6px 0;">The symbol blazes with the light of the sun — <b>bright light in a 30-ft radius</b> and dim light 30 ft beyond, for <b>10 minutes</b>. This light <b>is sunlight</b>.</p>
  <ul style="margin:8px 0 8px 4px;padding-left:18px;">
    <li style="margin:3px 0;">Creatures with <b>Sunlight Sensitivity</b> have disadvantage on attack rolls and sight-based Perception while in the light.</li>
    <li style="margin:3px 0;">A <b>vampire</b> or other creature with <b>Sunlight Hypersensitivity</b> that starts its turn in the light takes <b>${VAMPIRE_RADIANT} radiant damage</b> and is impaired by the glare.</li>
  </ul>
  <div style="text-align:center;margin-top:10px;">
    <button type="button" data-action="ace-hsor-extinguish" data-token-id="${bearer?.id ?? token.document?.id ?? ""}" data-scene-id="${canvas.scene?.id ?? ""}"
      style="background:#2a1f0a;color:#ffd86b;border:1px solid #d4af37;border-radius:6px;padding:6px 14px;font-size:14px;font-weight:600;cursor:pointer;">
      🕯️ Extinguish
    </button>
  </div>
</div>`;
    await ChatMessage.create({
      speaker: ChatMessage.getSpeaker({ actor, token: token.document }),
      content,
      flags: { [MODULE_ID]: { type: "holySymbolSunlight", tokenId: bearer?.id ?? token.document?.id ?? null, sceneId: canvas.scene?.id } },
    });
  }

  static async _postSunlightTurnCard(tok, sens) {
    const curHP = tok.actor?.system?.attributes?.hp?.value ?? 0;
    const newHP = Math.max(0, curHP - VAMPIRE_RADIANT);
    const text = sens.hyper
      ? `☀️ <b>${tok.name}</b>: ${VAMPIRE_RADIANT} radiant → <b style="color:#ff9b9b;">${newHP} HP</b> · disadvantage`
      : `☀️ <b>${tok.name}</b>: disadvantage in sunlight`;
    const button = sens.hyper
      ? `<button type="button" data-action="ace-hsor-radiant" data-token-id="${tok.id}" data-scene-id="${canvas.scene?.id ?? ""}"
           style="flex:0 0 auto;background:#3a0f0f;color:#ffd0d0;border:1px solid #d46a6a;border-radius:6px;padding:4px 10px;font-size:14px;font-weight:700;cursor:pointer;white-space:nowrap;">Apply ${VAMPIRE_RADIANT}</button>` : "";
    const content = `
<div style="display:flex;align-items:center;gap:10px;background:#15110a;border:1px solid #d4af37;border-radius:8px;padding:8px 12px;color:#f3ead2;font-size:15px;line-height:1.3;">
  <span style="flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${text}</span>
  ${button}
</div>`;
    await ChatMessage.create({
      speaker: ChatMessage.getSpeaker({ token: tok.document, actor: tok.actor }),
      content,
      flags: { [MODULE_ID]: { type: "holySymbolSunTick", tokenId: tok.id, sceneId: canvas.scene?.id } },
    });
  }

  static _wireCardButtons(msg, html) {
    if (!msg.flags?.[MODULE_ID]) return;
    const el = html instanceof HTMLElement ? html : html?.[0] ?? html;
    if (!el?.querySelector) return;

    const ext = el.querySelector('[data-action="ace-hsor-extinguish"]');
    if (ext) ext.addEventListener("click", async (ev) => {
      ev.preventDefault();
      if (!game.user.isGM) return ui.notifications?.warn("Only the GM can extinguish the sunlight.");
      const scene = game.scenes.get(ext.dataset.sceneId) ?? canvas.scene;
      const td = scene?.tokens?.get(ext.dataset.tokenId);
      if (td) await HolySymbol._removeSunlightZone(td);
      else ui.notifications?.warn("Sunlight already gone.");
      ext.disabled = true;
      ext.style.opacity = "0.5";
      ext.textContent = "🕯️ Extinguished";
    });

    const rad = el.querySelector('[data-action="ace-hsor-radiant"]');
    if (rad) rad.addEventListener("click", async (ev) => {
      ev.preventDefault();
      if (!game.user.isGM) return ui.notifications?.warn("Only the GM can apply that.");
      const scene = game.scenes.get(rad.dataset.sceneId) ?? canvas.scene;
      const actor = scene?.tokens?.get(rad.dataset.tokenId)?.actor;
      if (!actor) return;
      try {
        if (typeof actor.applyDamage === "function") {
          await actor.applyDamage([{ value: VAMPIRE_RADIANT, type: "radiant" }]);
        }
        const left = actor.system?.attributes?.hp?.value ?? "?";
        rad.disabled = true;
        rad.style.opacity = "0.6";
        rad.textContent = `✓ ${left} HP left`;
      } catch (err) {
        console.warn(`${MODULE_ID} | Sunlight radiant apply failed:`, err);
      }
    });
  }

  // ─── One-time data wiring ────────────────────────────────────────────────
  // Makes the item canonical without the user running a console snippet:
  //   • Turn Undead becomes a SAVE activity (cloned from the working Hold
  //     Vampires save so the dnd5e schema is guaranteed correct).
  //   • Each save power gets a chatFlavor that names its own condition, which
  //     the save-engine's activity-aware parse turns into the right effect.
  //   • Charge costs (1 / 3 / 5) and the dawn-recovering 10-charge pool stay.
  // Version-gated + try/catch per item, and it preserves the custom artwork.
  static async _ensureWired() {
    if (!game.user.isGM) return;
    const targets = [];
    for (const a of game.actors ?? []) for (const it of a.items ?? []) {
      if (HolySymbol._isHolySymbol(it)) targets.push(it);
    }
    for (const it of game.items ?? []) if (HolySymbol._isHolySymbol(it)) targets.push(it);

    for (const item of targets) {
      try {
        if (item.getFlag(MODULE_ID, "wireVersion") === WIRE_VERSION) continue;
        await HolySymbol._wireItem(item);
        await item.setFlag(MODULE_ID, "wireVersion", WIRE_VERSION);
        console.log(`${MODULE_ID} | Holy Symbol wired: ${item.name} (${item.parent?.name ?? "world item"}).`);
      } catch (err) {
        console.warn(`${MODULE_ID} | Holy Symbol wiring failed for ${item.name}:`, err);
      }
    }
  }

  static async _wireItem(item) {
    const find = (re) => [...(item.system?.activities ?? [])].find(a => re.test(a.name ?? ""));

    // ── Step 1: Turn Undead must be a SAVE ────────────────────────────────
    // If it's still a utility, rebuild it by cloning Hold Vampires' proven
    // save structure under a FRESH id and deleting the old utility entry.
    // Clone-and-swap (rather than overwriting in place) avoids Foundry merging
    // save fields onto the old utility schema and leaving stale data behind.
    const hold = find(/hold\s*vampires/i);
    const turn = find(/turn\s*undead/i);
    if (turn && turn.type !== "save" && hold) {
      const clone = hold.toObject();
      clone._id  = foundry.utils.randomID();
      clone.type = "save";
      clone.name = "Turn Undead";
      clone.description = { ...(clone.description ?? {}), chatFlavor: TURN_FLAVOR };
      clone.consumption = foundry.utils.deepClone(hold.consumption ?? {});
      if (clone.consumption?.targets?.[0]) clone.consumption.targets[0].value = "3";
      // Frightened is driven by the chatFlavor parse, not a linked effect —
      // drop anything Hold Vampires carried so we don't paralyze undead.
      clone.effects = [];
      await item.update({
        [`system.activities.-=${turn.id}`]: null,
        [`system.activities.${clone._id}`]: clone,
      });
    }

    // ── Step 2: per-power chatFlavor + charge costs ───────────────────────
    // Re-read activities (Turn Undead's id may have changed in step 1).
    const hold2 = find(/hold\s*vampires/i);
    const turn2 = find(/turn\s*undead/i);
    const sun2  = find(/sunlight/i);

    // Each power draws from the item's shared 10-charge pool (item-uses) at the
    // RIGHT cost: Hold Vampires 1, Turn Undead 3, Sunlight 5. Build the targets
    // array FRESH — cloning Hold's toObject() handed back frozen nested objects
    // whose `value` silently wouldn't change, so all three came out at "1".
    const mkTargets = (val) => [
      { type: "itemUses", target: "", value: String(val), scaling: { mode: "", formula: "" } },
    ];

    const updates = {};
    if (hold2) {
      updates[`system.activities.${hold2.id}.description.chatFlavor`] = HOLD_FLAVOR;
      updates[`system.activities.${hold2.id}.consumption.targets`] = mkTargets(1);
    }
    if (turn2) {
      updates[`system.activities.${turn2.id}.description.chatFlavor`] = TURN_FLAVOR;
      updates[`system.activities.${turn2.id}.consumption.targets`] = mkTargets(3);
    }
    if (sun2) {
      updates[`system.activities.${sun2.id}.description.chatFlavor`] = SUN_FLAVOR;
      updates[`system.activities.${sun2.id}.consumption.targets`] = mkTargets(5);
    }
    if (Object.keys(updates).length) await item.update(updates);
  }
}
