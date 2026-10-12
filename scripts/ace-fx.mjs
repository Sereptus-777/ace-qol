// ═══════════════════════════════════════════════════════════════════════════
//  ACE: QOL — Foundry-native FX
// ───────────────────────────────────────────────────────────────────────────
//  Asset-free effects other parts of ACE ask for by name: the cast flourish on
//  a spell whose only clip is a condition ACE draws itself, the frost
//  silhouette that is Frostbite's own clip (animation/spell-animator.mjs), the
//  ghostly wave a
//  caster-centred emanation sends out (Ghostly Howl, caster-emanation.mjs and
//  the save resolver), their sounds, and the damage-type colours they share.
//
//  ⚠️🔴 ONE PICTURE AT THE CAST, AND ONLY WHERE THE SPELL HAS NO OTHER (his
//  rules, 2026-10-11). This file used to fire on its own: a coloured flourish on
//  the caster at EVERY cast, and a frost or fire crust with an impact sound on
//  every FAILED SAVE. The flourish was a second picture beside a spell's own
//  clip (Frostbite's wrong first frame); the crust's sound fired on a save roll
//  and again when a player's result was sent on after Lucky was let go. His
//  rule: "A spell's sound and its animation fire once, at the cast." So
//  nothing here listens for a cast or a save any more, and the crust is gone.
//
//  The flourish stays for ONE kind of spell, by his word the same evening:
//  "Charm Person, and any spell whose only clip is a condition badge, still
//  gets a flourish at the cast. The September 30 rule stands: ACE draws the
//  condition, and the JB2A badge does not play. The flourish is not that badge.
//  Do not put the ring back on a spell that already has its own clip." The
//  animator (animation/spell-animator.mjs) asks for it in exactly that case,
//  at the cast, after the Counterspell answer: castFlourish below.
//
//  Pure PIXI on canvas.stage. NO Token Magic FX (Johnny runs with it off), NO
//  Sequencer-asset dependency. Broadcast over the module socket so every
//  connected client sees the same effect.
// ═══════════════════════════════════════════════════════════════════════════

import { MODULE_ID } from "./ace-qol.mjs";
import { weaponDamageTypes } from "./read-activities.mjs";

// Socket channel computed LAZILY at call time. MODULE_ID is a circular import
// (ace-qol.mjs imports this module), so reading it at the top level lands in the
// temporal dead zone and crashes the entire ace-qol load. Every caller of this
// runs at runtime (ready hook / cast), by which point MODULE_ID is defined.
function _socket() { return `module.${MODULE_ID}`; }

// Damage-type → theme colour (the flourish and an emanation's wave take their spell's colour).
export const DAMAGE_THEME = {
  cold:      0x9fd8ff, fire:    0xff7a3c, lightning: 0x9fd0ff, thunder: 0xc9b6ff,
  acid:      0x9be04a, poison:  0x86d36b, necrotic:  0x8a63b8, radiant: 0xffe9a3,
  psychic:   0xff8fd6, force:   0xc6a9ff,
  bludgeoning: 0xd6d6d6, piercing: 0xd6d6d6, slashing: 0xd6d6d6,
};
export const DEFAULT_COLOR = 0xbfe2ff;   // soft arcane blue
// ⚠️ HEALING IS NOT A DAMAGE TYPE, so it is not in the table above — but a
// wave of healing must not come out arcane blue. Same green ACE's heal cards
// already use, so the colour means the same thing wherever he sees it.
export const HEAL_COLOR = 0x7ee081;

// Ghostly wave (Ghostly Howl and anything else emanating a sound wave).
// Was 1150ms — too fast to read as anything, and you couldn't judge the reach.
// Johnny 2026-07-29: "it could last for one second longer."
const GHOSTLY_WAVE_MS = 2300;

/**
 * The damage type that should colour the flourish.
 *
 * ⚠️🔴 ASK THE ACTIVITY THAT WAS USED. Without an activity this walks every
 * ability on the item and takes the first damage type it recognises, which on
 * a multi-activity magic item is very often the wrong one: the Stormforger's
 * first activity is Tornado Takedown, whose first damage part is bludgeoning,
 * so every creature caught in an 8d6 LIGHTNING storm was encrusted as though
 * it had been clubbed (Johnny's log, 2026-09-03).
 *
 * ⚠️ AND THE ITEM'S OWN BASE DAMAGE IS NOT THE ANSWER EITHER. Stormforger is
 * a quarterstaff: `system.damage.base` is 1d6 bludgeoning and has nothing to do
 * with any of its four abilities. That fallback stays for genuinely legacy
 * items with no activities at all, and is now reached only when nothing else
 * answered.
 */
function _itemDamageType(item, activityId = null) {
  try {
    const acts = item?.system?.activities;

    // The one that was actually used wins, outright.
    if (activityId && acts) {
      const used = acts.get?.(activityId)
        ?? (typeof acts.values === "function"
              ? [...acts.values()].find(a => a?.id === activityId)
              : (acts ?? {})[activityId]);
      for (const p of (used?.damage?.parts ?? [])) {
        const t = (p?.types && [...p.types][0]) ?? (Array.isArray(p) ? p[1] : null);
        if (t && DAMAGE_THEME[t]) return t;
      }
      // A used activity that deals no themed damage is an ANSWER: Aerial
      // Ascension has no damage at all and must not borrow the tornado's.
      if (used) return null;
    }

    if (acts) {
      const list = typeof acts.values === "function" ? [...acts.values()] : Object.values(acts ?? {});
      for (const a of list) {
        const parts = a?.damage?.parts ?? [];
        for (const p of parts) {
          const t = (p?.types && [...p.types][0]) ?? (Array.isArray(p) ? p[1] : null);
          if (t && DAMAGE_THEME[t]) return t;
        }
      }
    }
    // ⚠️ AND THE ITEM'S OWN FIELD IS `damage.base`, NOT `damage.parts`. This
    // last resort read a field no dnd5e 5.x item has, so the encrust on a
    // weapon with no themed activity was never coloured by its own damage.
    for (const t of weaponDamageTypes(item)) {
      if (DAMAGE_THEME[t]) return t;
    }
  } catch (_) { /* non-fatal */ }
  return null;
}

function _themeColor(item) {
  const dt = _itemDamageType(item);
  return (dt && DAMAGE_THEME[dt]) ? DAMAGE_THEME[dt] : DEFAULT_COLOR;
}

/** Resolve a token on THIS client's active scene (skip if viewing elsewhere). */
function _resolveToken(sceneId, tokenId) {
  try {
    if (sceneId && canvas?.scene?.id && canvas.scene.id !== sceneId) return null;
    return canvas?.tokens?.get(tokenId) ?? null;
  } catch (_) { return null; }
}

export class AceFX {

  static register() {
    // World map of sound paths, populated by the one-time migration that
    // retired per-item Forge FX into this layer. Hidden setting (no config UI),
    // edited via the migration console snippet. ⚠️ Since 2026-10-11 only its
    // "cast" key is read, for the flourish; the per-damage-type keys belonged to
    // the impact crust, which is gone.
    try {
      game.settings.register(MODULE_ID, "aceFxSounds", {
        scope: "world", config: false, type: Object, default: {},
      });
    } catch (_) { /* already registered */ }

    // ⚠️🔴 THIS SETTING WAS READ AND NEVER REGISTERED (found 2026-08-23), and
    // a feature with no switch is the same shape as a button wired to nothing.
    // ⚠️ 2026-10-11: it switches the one flourish left, so it says only that.
    // The impact crust it used to name is gone.
    try {
      game.settings.register(MODULE_ID, "autoAnimations", {
        name: "Spell Flourish",
        hint: "A coloured flourish on the caster when a spell is cast whose only clip is a condition ACE draws on the creature itself, such as Charm Person. A spell with its own clip never gets it. Purely cosmetic, turning it off changes no rules. Default: ON.",
        scope: "world", config: true, type: Boolean, default: true,
      });
    } catch (_) { /* already registered */ }

    // ── FX socket — runs on EVERY client (ungated). Only acts on aceFx:* actions,
    //    so it lives happily beside the existing module-socket dispatch. ──
    try {
      game.socket.on(_socket(), (payload) => {
        try {
          if (payload?.action === "aceFx:flourish") {
            const tk = _resolveToken(payload.sceneId, payload.tokenId);
            if (tk) AceFX.flourish(tk, payload.color);
            AceFX._playSound(payload.soundSrc);
          } else if (payload?.action === "aceFx:silhouette") {
            const tk = _resolveToken(payload.sceneId, payload.tokenId);
            if (tk) AceFX.encrust(tk, { color: payload.color });
          } else if (payload?.action === "aceFx:ghostlyWave") {
            const tk = _resolveToken(payload.sceneId, payload.tokenId);
            if (tk) {
              // Recompute px on THIS client (its canvas/grid may differ).
              const gridDist = canvas?.scene?.grid?.distance || 5;
              const gridSize = canvas?.grid?.size || 100;
              AceFX.ghostlyWave(tk, (Number(payload.radiusFt ?? 30) / gridDist) * gridSize, payload.color);
            }
            AceFX._playSound(payload.soundSrc);
          }
        } catch (err) { console.warn(`${MODULE_ID} | AceFX socket handler threw:`, err); }
      });
    } catch (err) { console.warn(`${MODULE_ID} | AceFX socket registration failed:`, err); }

    console.log(`${MODULE_ID} | [ace-fx] AceFX online: the flourish and the ghostly wave, on request. Nothing `
      + `fires on its own at a cast or a save; a cast's one clip is its owner's (animation/spell-animator.mjs).`);
  }

  /**
   * The cast flourish, for a spell whose only clip is a condition ACE draws
   * itself (his rule, 2026-10-11; see the top of this file). The animator calls
   * it at the cast, after the Counterspell answer, and nowhere else.
   * @returns {boolean} whether it played
   */
  static castFlourish(token, item) {
    try {
      if (!token) return false;
      if (!AceFX._enabled()) {
        console.log(`${MODULE_ID} | [ace-fx] no flourish for "${item?.name ?? "that spell"}": the Spell `
          + `Flourish setting is off.`);
        return false;
      }
      AceFX.flourishBroadcast(token, _themeColor(item));
      return true;
    } catch (err) {
      console.warn(`${MODULE_ID} | [ace-fx] the cast flourish for "${item?.name ?? "that spell"}" could not play:`, err);
      return false;
    }
  }

  static _enabled() {
    try { return game.settings.get(MODULE_ID, "autoAnimations") !== false; }
    catch (_) { return true; }   // setting not registered yet → on by default
  }

  // ── Broadcast helpers: play locally + relay to every other client ──────────
  static flourishBroadcast(token, color) {
    AceFX.flourish(token, color);
    let castSrc = null;   // optional cast sound — set game setting aceFxSounds.cast
    try { castSrc = (game.settings.get(MODULE_ID, "aceFxSounds") ?? {}).cast ?? null; } catch (_) {}
    AceFX._playSound(castSrc);
    try {
      game.socket.emit(_socket(), {
        action: "aceFx:flourish",
        sceneId: token.scene?.id ?? canvas.scene?.id, tokenId: token.id, color, soundSrc: castSrc,
      });
    } catch (_) { /* solo / no socket — local play already happened */ }
  }

  /**
   * The frost silhouette on one creature, here and on every other screen.
   *
   * ⚠️🔴 FROSTBITE'S OWN CLIP (his rule, 2026-10-12: "Frostbite plays the
   * silhouette you drew, on the target, inside its square... The clip that plays
   * is the Frostbite silhouette made for this spell, the one that is yours."). It
   * is the crust below, masked to the token's own picture, so it cannot leave
   * that creature's square. It has no sound of its own: the cast's one sound is
   * its record's. The animator asks for it at the cast, after the Counterspell
   * answer, and nowhere else; nothing here fires on a save any more.
   */
  static silhouetteBroadcast(token, color = DAMAGE_THEME.cold) {
    try {
      if (!token) return false;
      AceFX.encrust(token, { color });
      try {
        game.socket.emit(_socket(), {
          action: "aceFx:silhouette",
          sceneId: token.scene?.id ?? canvas.scene?.id, tokenId: token.id, color,
        });
      } catch (_) { /* solo / no socket: it already played here */ }
      return true;
    } catch (err) {
      console.warn(`${MODULE_ID} | [ace-fx] the frost silhouette on ${token?.name ?? "a creature"} could not play:`, err);
      return false;
    }
  }

  // Play a one-shot sound LOCALLY on this client. Each client calls this when it
  // draws the effect (trigger client + every socket recipient), so the sound is
  // heard once per client, synced with the visual. AudioHelper's broadcast flag
  // proved unreliable in V13, so we relay the src ourselves and play locally.
  static _playSound(src) {
    if (!src) return;
    try {
      let file = src;
      // A bare Sequencer DB key ("psfx.foo.bar" — no slash, no audio extension) is NOT a
      // URL; handing it to AudioHelper makes it a relative path and 404s. Resolve it to a
      // real file through the Sequencer database first. File paths pass straight through.
      if (!/[\/\\]/.test(src) && !/\.(ogg|wav|mp3|webm|m4a|flac)$/i.test(src) && src.includes(".")) {
        const Seq = globalThis.Sequencer ?? window.Sequencer;
        let r = Seq?.Database?.getEntry?.(src, { softFail: true }) ?? null;
        if (Array.isArray(r)) r = r[0];
        if (r && typeof r === "object") r = (typeof r.getFile === "function" ? r.getFile() : (r.file ?? r._file ?? null));
        if (typeof r === "string" && r) file = r;
        else { console.warn(`${MODULE_ID} | AceFX: unresolved Sequencer sound key "${src}" — skipping.`); return; }
      }
      const AH = foundry.audio?.AudioHelper ?? globalThis.AudioHelper;

      // ── Probe before playing (2026-07-28) ──
      // A configured sound that isn't on disk used to reach AudioHelper and
      // throw a red "Failed to load audio element …" banner across the GM's
      // screen mid-combat. That happens for ordinary reasons — the path points
      // at a world file the GM hasn't added yet, or at a sample-library module
      // that's installed but empty. A missing OPTIONAL sound is a silent
      // no-sound, never an error the table has to look at.
      const url = foundry.utils.getRoute?.(file) ?? file;
      fetch(url, { method: "HEAD" })
        .then(res => {
          if (res.ok) return AH?.play({ src: file, volume: 0.8, autoplay: true, loop: false });
          console.warn(`${MODULE_ID} | AceFX: sound "${file}" not found — playing silently.`);
        })
        .catch(() => {
          // Probe itself failed (odd host, CORS) — don't let the check block a
          // sound that might be perfectly fine. Try it.
          try { AH?.play({ src: file, volume: 0.8, autoplay: true, loop: false }); } catch (_) {}
        });
    } catch (err) { console.warn(`${MODULE_ID} | AceFX sound play failed:`, err); }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  CAST FLOURISH — themed bloom + expanding ring on the caster (~0.6s).
  // ═══════════════════════════════════════════════════════════════════════════
  static flourish(token, color = DEFAULT_COLOR) {
    try {
      const layer = canvas?.stage;
      if (!layer || !token?.center) return;
      console.log(`${MODULE_ID} | [ace-fx] FLOURISH play on ${token?.name ?? "?"} @ ${Math.round(token.center.x)},${Math.round(token.center.y)} (layer=${!!layer})`);
      const size = Math.max(token.w ?? 100, token.h ?? 100);
      const r0 = size * 0.34, r1 = size * 0.78;

      const g = new PIXI.Graphics();
      g.position.set(token.center.x, token.center.y);
      layer.addChild(g);

      const start = performance.now();
      const durMs = 600;
      const tick = () => {
        if (g.destroyed) return;
        const t = Math.min(1, (performance.now() - start) / durMs);
        const ease = 1 - Math.pow(1 - t, 2);            // ease-out
        const r = r0 + (r1 - r0) * ease;
        const a = 1 - t;
        g.clear();
        g.beginFill(color, 0.22 * a); g.drawCircle(0, 0, r * 0.9); g.endFill();
        g.lineStyle(Math.max(2, size * 0.04), color, 0.9 * a);
        g.drawCircle(0, 0, r);
        if (t >= 1) { try { g.destroy(); } catch (_) {} return; }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    } catch (err) { console.warn(`${MODULE_ID} | AceFX.flourish threw:`, err); }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  GHOSTLY WAVE — concentric spectral rings racing OUTWARD to a radius, so a
  //  30-ft "howl" visibly washes over everyone it reaches (Johnny 2026-07-10:
  //  "push it, visual waves go out 30 feet"). Three staggered rings, pale and
  //  translucent, expanding + fading. Pure PIXI on canvas.stage. One-shot.
  // ═══════════════════════════════════════════════════════════════════════════
  static ghostlyWave(token, radiusPx, color = 0xbfeaff) {
    try {
      const layer = canvas?.stage;
      if (!layer || !token?.center) return;
      const R = Math.max(60, Number(radiusPx) || 300);
      console.log(`${MODULE_ID} | [ace-fx] GHOSTLY WAVE on ${token?.name ?? "?"} → ${Math.round(R)}px`);

      const g = new PIXI.Graphics();
      g.position.set(token.center.x, token.center.y);
      g.blendMode = PIXI.BLEND_MODES.ADD;   // spectral glow reads over dark maps
      layer.addChild(g);

      // ── A WAVEFORM, NOT A RIPPLE (Johnny 2026-07-29) ──
      // "I wish it was more like a waveform… a purple waveform emanating out
      //  from him… it could last for one second longer."
      // Perfect circles read as a pond ripple. A howl is SOUND, so each ring
      // now undulates — its radius is modulated around the circle — and the
      // undulation rolls as the ring travels, which is what sells it as a
      // wavefront rather than a spreading disc.
      const start   = performance.now();
      const durMs   = GHOSTLY_WAVE_MS;
      const WAVES   = 4;            // staggered wavefronts
      const stagger = 0.14;         // fraction of the cycle between them
      const lineW   = Math.max(3, R * 0.022);
      const LOBES   = 7;            // undulations around the ring — odd = less "flowery"
      const AMP     = 0.045;        // ±4.5% of the radius; more than this reads as a blob
      const SEGS    = 72;           // points per ring — smooth at any size

      const tick = () => {
        if (g.destroyed) return;
        const now = performance.now();
        const t = (now - start) / durMs;
        if (t >= 1) { try { g.destroy(); } catch (_) {} return; }
        g.clear();
        for (let i = 0; i < WAVES; i++) {
          const wt = t - i * stagger;              // this wave's own progress
          if (wt <= 0 || wt >= 1) continue;
          const ease = 1 - Math.pow(1 - wt, 2);    // ease-out expansion
          const r    = R * ease;
          const a    = (1 - wt) * 0.9;             // fade as it travels
          // Each front rolls at its own rate and starts turned, so they never
          // line up into one thick wobbling band.
          const roll = wt * Math.PI * 1.6 + i * 0.9;
          // Undulation eases in — a wavefront leaves the throat clean and
          // develops its shape as it travels.
          const amp  = AMP * Math.min(1, wt * 3);

          const pts = [];
          for (let s = 0; s <= SEGS; s++) {
            const th = (s / SEGS) * Math.PI * 2;
            const rr = r * (1 + amp * Math.sin(LOBES * th + roll));
            pts.push(Math.cos(th) * rr, Math.sin(th) * rr);
          }

          // Faint wash inside the leading edge, brighter crest on the edge.
          g.beginFill(color, 0.05 * a); g.drawPolygon(pts); g.endFill();
          g.lineStyle(lineW * (1 - wt * 0.5), color, a);
          g.drawPolygon(pts);
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    } catch (err) { console.warn(`${MODULE_ID} | AceFX.ghostlyWave threw:`, err); }
  }

  /** Convert a foot radius to canvas pixels, play the wave + its sound locally,
   *  and relay both to all clients (each plays the sound once, synced). */
  static ghostlyWaveBroadcast(token, radiusFt = 30, color = 0xbfeaff, soundSrc = null) {
    try {
      const gridDist = canvas?.scene?.grid?.distance || 5;   // ft per square
      const gridSize = canvas?.grid?.size || canvas?.scene?.grid?.size || 100;
      const radiusPx = (Number(radiusFt) / gridDist) * gridSize;
      AceFX.ghostlyWave(token, radiusPx, color);
      if (soundSrc) AceFX._playSound(soundSrc);
      const sceneId = token?.scene?.id ?? canvas?.scene?.id;
      const tokenId = token?.id ?? token?.document?.id;
      if (sceneId && tokenId) {
        game.socket.emit(_socket(), { action: "aceFx:ghostlyWave", sceneId, tokenId, radiusFt, color, soundSrc });
      }
    } catch (err) { console.warn(`${MODULE_ID} | AceFX.ghostlyWaveBroadcast threw:`, err); }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  SILHOUETTE ENCRUST — frost masked to the token's OWN shape; forms, holds,
  //  fades. One-shot. Foundry-native (token alpha as the PIXI mask).
  // ═══════════════════════════════════════════════════════════════════════════
  static encrust(token, opts = {}) {
    try {
      const layer = canvas?.stage;
      if (!layer || !token?.center) return;
      console.log(`${MODULE_ID} | [ace-fx] ENCRUST play on ${token?.name ?? "?"} (layer=${!!layer}, texValid=${!!(token?.mesh?.texture?.valid)})`);
      const color    = opts.color     ?? DEFAULT_COLOR;
      const fadeInMs  = opts.fadeInMs  ?? 200;   // snappy — pops with the sound, not a slow build
      const holdMs    = opts.holdMs    ?? 4600;  // ice lingers on the target (~5.6s total with fades)
      const fadeOutMs = opts.fadeOutMs ?? 800;
      const peak      = opts.peakAlpha ?? 1.0;
      const w = token.w ?? 100, h = token.h ?? 100;

      const cont = new PIXI.Container();
      cont.position.set(token.center.x, token.center.y);
      layer.addChild(cont);

      // Mask = the token's own silhouette (texture alpha). Fall back to an
      // ellipse if the texture isn't readable, so we never paint a hard square.
      const tex = token.mesh?.texture ?? null;
      let mask;
      if (tex?.valid) {
        mask = new PIXI.Sprite(tex);
        mask.anchor.set(0.5);
        mask.width = w; mask.height = h;
      } else {
        mask = new PIXI.Graphics();
        mask.beginFill(0xffffff, 1).drawEllipse(0, 0, w * 0.48, h * 0.48).endFill();
      }
      cont.addChild(mask);

      // Frost body — icy tint that builds over the silhouette.
      const frost = new PIXI.Sprite(PIXI.Texture.WHITE);
      frost.anchor.set(0.5);
      frost.width = w; frost.height = h;
      frost.tint = color;
      frost.alpha = 0.9;            // solid NORMAL-blend coat — reliably visible on any map
      cont.addChild(frost);

      // A few angular cracks within the shape (brighter white).
      const cracks = new PIXI.Graphics();
      cracks.lineStyle(Math.max(2, w * 0.028), 0xffffff, 0.95);
      for (const a0 of [-0.5, 0.4, 1.5, 2.5, -1.6]) {
        const seg = Math.min(w, h) * 0.17;
        let x = 0, y = 0, ang = a0;
        cracks.moveTo(0, 0);
        for (let i = 0; i < 3; i++) {
          ang += (i % 2 ? 0.55 : -0.55);
          x += Math.cos(ang) * seg; y += Math.sin(ang) * seg;
          cracks.lineTo(x, y);
        }
      }
      cont.addChild(cracks);

      frost.mask = mask;
      cracks.mask = mask;

      const start = performance.now();
      const total = fadeInMs + holdMs + fadeOutMs;
      const tick = () => {
        if (cont.destroyed) return;
        const el = performance.now() - start;
        let a;
        if (el < fadeInMs)              a = peak * (el / fadeInMs);          // forming
        else if (el < fadeInMs + holdMs) a = peak;                          // holding
        else                            a = peak * (1 - (el - fadeInMs - holdMs) / fadeOutMs); // fading
        cont.alpha = Math.max(0, a);
        if (token.center) cont.position.set(token.center.x, token.center.y); // glue to token
        if (el >= total) { try { cont.destroy({ children: true }); } catch (_) {} return; }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    } catch (err) { console.warn(`${MODULE_ID} | AceFX.encrust threw:`, err); }
  }
}
