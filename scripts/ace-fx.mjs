// ═══════════════════════════════════════════════════════════════════════════
//  ACE: QOL — Auto-Animation  (Foundry-native FX)
// ───────────────────────────────────────────────────────────────────────────
//  Two automatic, asset-free effects that fire on EVERY spell, themed by the
//  spell's damage type — no per-item setup:
//
//    1. CAST FLOURISH  — a quick themed bloom + expanding ring on the caster
//                        the instant Cast fires.
//    2. SILHOUETTE ENCRUST — on a FAILED save, frost/ice that forms over the
//                        TARGET's own silhouette (masked to the token's alpha,
//                        NOT an outline glow), then fades. One-shot, no loop.
//
//  Pure PIXI on canvas.primary. NO Token Magic FX (Johnny runs with it off),
//  NO Sequencer-asset dependency. Broadcast over the module socket so every
//  connected client sees the same effect — the trigger hooks only fire on one
//  client each (cast → caster's client, save → the GM), so we relay to the rest.
//
//  Per-item Forge FX (flags["ace-artificer"].fx) remains the explicit OVERRIDE
//  layer; this is the automatic DEFAULT beneath it.
// ═══════════════════════════════════════════════════════════════════════════

import { MODULE_ID } from "./ace-qol.mjs";

// Socket channel computed LAZILY at call time. MODULE_ID is a circular import
// (ace-qol.mjs imports this module), so reading it at the top level lands in the
// temporal dead zone and crashes the entire ace-qol load. Every caller of this
// runs at runtime (ready hook / cast), by which point MODULE_ID is defined.
function _socket() { return `module.${MODULE_ID}`; }

// Damage-type → theme colour (drives both the cast bloom and the impact tint).
const DAMAGE_THEME = {
  cold:      0x9fd8ff, fire:    0xff7a3c, lightning: 0x9fd0ff, thunder: 0xc9b6ff,
  acid:      0x9be04a, poison:  0x86d36b, necrotic:  0x8a63b8, radiant: 0xffe9a3,
  psychic:   0xff8fd6, force:   0xc6a9ff,
  bludgeoning: 0xd6d6d6, piercing: 0xd6d6d6, slashing: 0xd6d6d6,
};
const DEFAULT_COLOR = 0xbfe2ff;   // soft arcane blue

// Damage types that look right as a body-encrusting impact (frost, char, etc.).
// Pure physical (bludgeoning/piercing/slashing) is excluded — a sword hit
// shouldn't coat a creature in frost. Those can get a lighter impact later.
const ENCRUST_TYPES = new Set([
  "cold", "fire", "acid", "lightning", "thunder", "poison",
  "necrotic", "radiant", "psychic", "force",
]);

// Per-token throttle so a re-emitted saveComplete can't stack two encrusts + sounds.
const _recentEncrust = new Map();

/** First recognised damage type on the item (activity-first, then legacy). */
function _itemDamageType(item) {
  try {
    const acts = item?.system?.activities;
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
    const legacy = item?.system?.damage?.parts ?? [];
    for (const p of legacy) {
      const t = Array.isArray(p) ? p[1] : (p?.types && [...p.types][0]);
      if (t && DAMAGE_THEME[t]) return t;
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

// Per-damage-type fallback sound from the psfx spell-sound library, IF the user runs
// it. Used only when the user hasn't set their own `aceFxSounds[type]`, so the encrust
// has good audio out of the box for psfx owners. Gated on psfx being active → a no-op
// for everyone else (they get the silent encrust until they pick a sound). Uses the
// default `modules/psfx/...` path; if the user relocated psfx the file just won't load.
function _psfxFallbackSound(dt) {
  try {
    if (!game.modules?.get?.("psfx")?.active) return null;
    const P = "modules/psfx/library/cantrips";
    const MAP = {
      cold:      `${P}/ray-of-frost/v1/ray-of-frost-003.ogg`,
      fire:      `${P}/fire-bolt/v1/fire-bolt-001-30ft.ogg`,
      lightning: `${P}/shocking-grasp/v1/shocking-grasp-001.ogg`,
      acid:      `${P}/acid-splash/v1/acid-splash-003-30ft.ogg`,
      poison:    `${P}/poison-spray/v1/poison-spray-001.ogg`,
      thunder:   `${P}/thunderclap/v1/thunderclap-001.ogg`,
      necrotic:  `${P}/toll-the-dead/v1/toll-the-dead-001.ogg`,
      radiant:   `${P}/sacred-flame/v1/sacred-flame-target-01.ogg`,
      force:     `${P}/eldritch-blast/v1/eldritch-blast-001.ogg`,
      psychic:   `${P}/mind-sliver/v1/mind-sliver-001.ogg`,
    };
    return MAP[dt] ?? null;
  } catch (_) { return null; }
}

export class AceFX {

  static register() {
    // World map of damage-type → impact sound path, populated by the one-time
    // migration that retires per-item Forge FX into this auto-animation layer.
    // Hidden setting (no config UI) — edited via the migration console snippet.
    try {
      game.settings.register(MODULE_ID, "aceFxSounds", {
        scope: "world", config: false, type: Object, default: {},
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
          } else if (payload?.action === "aceFx:encrust") {
            const tk = _resolveToken(payload.sceneId, payload.tokenId);
            if (tk) AceFX.encrust(tk, { color: payload.color });
            AceFX._playSound(payload.soundSrc);
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

    // ── CAST → flourish on the caster. postCreateUsageMessage fires on the
    //    caster's own client; we play it locally and relay to everyone else. ──
    Hooks.on("dnd5e.postCreateUsageMessage", (activity) => {
      try {
        if (!AceFX._enabled()) return;
        const item = activity?.item;
        if (item?.type !== "spell") return;
        // Save spells with no template go through OUR target picker — their flourish
        // must fire AFTER the pick (via ace-qol.spellCommitted), not here at the
        // cast-click instant (which is before the picker even opens). Skip them here.
        const _sa = activity?.save?.ability;
        const _hasSave = _sa instanceof Set ? _sa.size > 0 : !!_sa;
        const _tpl = activity?.target?.template?.type ?? activity?.target?.type
                  ?? item.system?.target?.template?.type ?? "";
        if (_hasSave && !_tpl) return;
        const tk = activity?.actor?.getActiveTokens?.()?.[0];
        console.log(`${MODULE_ID} | [ace-fx] CAST hook (immediate): "${item?.name}" caster-token=${tk?.name ?? "none"}`);
        if (!tk) return;
        AceFX.flourishBroadcast(tk, _themeColor(item));
      } catch (err) { console.warn(`${MODULE_ID} | AceFX cast-flourish threw:`, err); }
    });

    // ── CAST COMMITTED (after the target picker resolves) → flourish on the
    //    caster. The save-engine emits this once a target is locked in, so the
    //    flourish lands when the spell actually goes off, not at the cast-click. ──
    Hooks.on("ace-qol.spellCommitted", (data) => {
      try {
        if (!AceFX._enabled()) return;
        const tk = data?.casterActor?.getActiveTokens?.()?.[0];
        console.log(`${MODULE_ID} | [ace-fx] COMMIT hook (post-pick): "${data?.item?.name}" caster-token=${tk?.name ?? "none"}`);
        if (!tk) return;
        AceFX.flourishBroadcast(tk, _themeColor(data?.item));
      } catch (err) { console.warn(`${MODULE_ID} | AceFX commit-flourish threw:`, err); }
    });

    // ── DAMAGE LANDS on a target → encrust it, themed by the damage type. This
    //    is the dramatic beat ("oh yeah, I hit"), synced with the impact. Fires on
    //    the GM (damage applicator is GM-gated); we relay. Elemental damage only —
    //    a plain weapon hit shouldn't coat a creature in frost. ──
    // Encrust on the FAILED SAVE — the proven-firing beat (it drew here at 0.7.142).
    // The damage-apply hooks (damageApplied / hpApplied) never fired in the single-NPC
    // save flow, so we anchor on saveComplete, which the save-engine reliably emits.
    // Only for elemental-DAMAGE spells (an ice crust on Hold Person would be wrong).
    // The impact sound rides with it here, so visual + sound stay synced.
    Hooks.on("ace-qol.saveComplete", async (data) => {
      try {
        if (!AceFX._enabled()) return;
        if (data?.passed === true) return;             // only on a FAILED save
        const tk = data?.actor?.getActiveTokens?.()?.[0];
        if (!tk) return;
        let item = null;
        if (data?.itemUuid) item = await fromUuid(data.itemUuid).catch(() => null);
        const dt = _itemDamageType(item);              // first recognised damage type, or null
        console.log(`${MODULE_ID} | [ace-fx] SAVE-FAIL encrust: item="${item?.name ?? "?"}" dmgType=${dt ?? "none"} target=${tk?.name}`);
        if (!dt || !ENCRUST_TYPES.has(dt)) return;     // ice/encrust only for elemental-damage spells
        // Resolve the impact sound. Honor a configured `aceFxSounds[type]` ONLY when it's
        // a real file path — a bare Sequencer DB key (e.g. "psfx.magic-signs.rune…") that
        // older builds wrote in here 404s through AudioHelper, so we skip it and fall
        // through to the psfx file fallback (a known-good per-type sound file).
        let soundSrc = null;
        try {
          const userSnd = String((game.settings.get(MODULE_ID, "aceFxSounds") ?? {})[dt] || "").trim();
          if (userSnd && (/[\/\\]/.test(userSnd) || /\.(ogg|wav|mp3|webm|m4a|flac)$/i.test(userSnd))) {
            soundSrc = userSnd;
          }
        } catch (_) {}
        if (!soundSrc) soundSrc = _psfxFallbackSound(dt);
        console.log(`${MODULE_ID} | [ace-fx] save-fail: "${item?.name}" (${dt}) — firing ENCRUST + SOUND together NOW (src=${soundSrc ?? "none"})`);
        AceFX.encrustBroadcast(tk, DAMAGE_THEME[dt] ?? DEFAULT_COLOR, soundSrc);
      } catch (err) { console.warn(`${MODULE_ID} | AceFX save-fail encrust threw:`, err); }
    });

    console.log(`${MODULE_ID} | [ace-fx] AceFX auto-animation ONLINE (cast flourish + silhouette encrust)`);
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

  static encrustBroadcast(token, color, soundSrc = null) {
    // Throttle rapid double-fires (re-emitted saveComplete) — one hit, one crust.
    try {
      const now = Date.now();
      if (now - (_recentEncrust.get(token.id) ?? 0) < 4000) return;
      _recentEncrust.set(token.id, now);
    } catch (_) {}
    AceFX.encrust(token, { color });
    AceFX._playSound(soundSrc);                       // local on this client
    try {
      game.socket.emit(_socket(), {
        action: "aceFx:encrust",
        sceneId: token.scene?.id ?? canvas.scene?.id, tokenId: token.id, color, soundSrc,
      });
    } catch (_) { /* solo / no socket — local play already happened */ }
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
      AH?.play({ src: file, volume: 0.8, autoplay: true, loop: false });
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

      const start = performance.now();
      const durMs = 1150;
      const WAVES = 3;              // staggered ripples
      const stagger = 0.18;        // fraction of the cycle between waves
      const lineW = Math.max(3, R * 0.02);

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
          const r = R * ease;
          const a = (1 - wt) * 0.9;                // fade as it travels
          // Faint filled wash inside the leading edge, brighter ring on the edge.
          g.beginFill(color, 0.06 * a); g.drawCircle(0, 0, r); g.endFill();
          g.lineStyle(lineW * (1 - wt * 0.5), color, a);
          g.drawCircle(0, 0, r);
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
