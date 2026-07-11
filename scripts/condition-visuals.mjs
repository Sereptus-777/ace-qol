// ─── ACE: QOL — Condition Visuals (conditions you can SEE) ────────────────────
//
// The little square status icons are dead. Conditions render ON THE BODY:
//
//   ORBIT FAMILY (glyphs circling above the head — one visual language):
//     stunned        → gold stars, fast orbit
//     incapacitated  → gold stars, slow orbit
//     unconscious    → orange Z's
//     prone          → red down-arrows
//   COATS (tint washes masked to the creature's own silhouette):
//     poisoned   → sickly green wash
//     paralyzed  → pale ice-blue + periodic electric flicker
//     frightened → violet cast + continuous tremble
//     charmed    → soft pink + drifting hearts
//     blinded    → darkened + smoky veil across the eyes
//     petrified  → full stone (suppresses all other coats — stone is stone)
//   CHAINS (rope meshes along paths, Johnny's strip PNG as the texture):
//     restrained → the X: one chain corner to corner, one across the
//                  opposite corners (layout call 2026-07-09 20:38 — reads
//                  "in chains, can't move" on any creature; equal diagonals
//                  render identically). Drawn iron links only as a loud
//                  emergency fallback.
//     grappled   → single amber grip band across the middle (body-extent
//                  aware via the silhouette scan)
//
// Foundations (all proven in this codebase):
//   • Silhouette mask = sprite of the token's own texture (ace-fx encrust).
//   • Containers live on canvas.stage, glued to token.center per frame.
//   • Ellipse fallback when a texture isn't readable — never a hard square.
//   • ONE shared animation frame loop, self-stopping when nothing animates.
//   • Pure visuals: no document writes, no sockets — every client renders
//     from the actor's replicated statuses. Nothing can strand a token.
//
// The clean-tokens patch in ace-qol.mjs imports BODY_VISUAL_STATUSES so the
// square icons for these conditions stop drawing — the body IS the icon.
// ──────────────────────────────────────────────────────────────────────────────

import { MODULE_ID } from "./ace-qol.mjs";

const CHAIN_TEXTURE_PATH = "modules/ace-qol/Assets/Conditions/restrained-chain.png";
// Build stamp — printed at startup so "did the new file load" is answerable
// in one console glance (the token-art picker header lesson).
const CV_BUILD = "0.7.202";

/** Conditions this engine renders on the body — their token squares are suppressed. */
export const BODY_VISUAL_STATUSES = new Set([
  "prone", "restrained", "poisoned", "paralyzed", "stunned", "incapacitated",
  "frightened", "blinded", "charmed", "unconscious", "petrified", "grappled",
  "deafened",
]);

// Coat colors / alphas — tuned for readability over varied art without
// drowning it. Petrified is deliberately heavy: stone should look like stone.
const COATS = {
  poisoned:   { tint: 0x3fae5a, alpha: 0.34 },
  paralyzed:  { tint: 0xbfe8ff, alpha: 0.30 },
  frightened: { tint: 0x9a6bd0, alpha: 0.20 },
  charmed:    { tint: 0xff8fc0, alpha: 0.22 },
  blinded:    { tint: 0x111111, alpha: 0.20 },
  petrified:  { tint: 0x848484, alpha: 0.90 },
};

export class ConditionVisuals {

  /** tokenDocId → { token, cont, key, anims:[], gfx:{} } */
  static _live = new Map();
  /** texture src → body extents rows (64 entries of [minFrac,maxFrac]|null) or null */
  static _extents = new Map();
  /** The loaded chain strip texture (null until loaded / if missing). */
  static _chainTex = null;
  static _rafHandle = null;

  // ═══════════════════════════════════════════════════════════════════════════
  //  Registration
  // ═══════════════════════════════════════════════════════════════════════════

  static register() {
    // Chain strip — load once. _chainReady is AWAITED by every wrap build:
    // the strip is 2+ MB, and building chains before it finished loading was
    // why the drawn-ring fallback kept appearing instead of the real PNG
    // (the ring-vs-strip mystery, 2026-07-09 evening — a load race, nothing
    // else). After the await, the texture is definitively loaded or absent.
    ConditionVisuals._chainReady = (async () => {
      try {
        const loader = globalThis.loadTexture ?? (p => PIXI.Assets.load(p));
        ConditionVisuals._chainTex = await loader(CHAIN_TEXTURE_PATH).catch?.(() => null) ?? null;
        if (ConditionVisuals._chainTex?.valid !== false && ConditionVisuals._chainTex) {
          console.log(`${MODULE_ID} | [conditions] chain strip loaded (${ConditionVisuals._chainTex.width}×${ConditionVisuals._chainTex.height})`);
        } else {
          console.log(`${MODULE_ID} | [conditions] no chain strip — drawn links active`);
        }
      } catch (_) {
        console.log(`${MODULE_ID} | [conditions] chain strip unavailable — drawn links active`);
      }
    })();

    // Status changes arrive as ActiveEffect create/update/delete on the actor.
    const effectActor = (effect) => {
      const p = effect?.parent;
      if (p?.documentName === "Actor") return p;
      if (p?.parent?.documentName === "Actor") return p.parent; // item-embedded effect
      return null;
    };
    const syncActor = (effect) => {
      try {
        const actor = effectActor(effect);
        if (!actor) return;
        for (const tok of actor.getActiveTokens?.(true) ?? []) ConditionVisuals.sync(tok);
      } catch (_) {}
    };
    Hooks.on("createActiveEffect", syncActor);
    Hooks.on("deleteActiveEffect", syncActor);
    Hooks.on("updateActiveEffect", syncActor);

    // Token lifecycle.
    Hooks.on("canvasReady", () => ConditionVisuals.syncAll());
    Hooks.on("drawToken", (token) => ConditionVisuals.sync(token));
    Hooks.on("deleteToken", (tokenDoc) => ConditionVisuals._teardown(tokenDoc.id));
    Hooks.on("updateToken", (tokenDoc, changes) => {
      try {
        if (foundry.utils.getProperty(changes ?? {}, "texture.src") !== undefined) {
          ConditionVisuals._extents.delete(tokenDoc.texture?.src);
          const tok = tokenDoc.object;
          if (tok) { ConditionVisuals._teardown(tokenDoc.id); ConditionVisuals.sync(tok); }
        }
      } catch (_) {}
    });
    Hooks.on("canvasTearDown", () => {
      for (const id of [...ConditionVisuals._live.keys()]) ConditionVisuals._teardown(id);
    });

    // First sweep for the scene we loaded into.
    if (canvas?.ready) ConditionVisuals.syncAll();

    console.log(`${MODULE_ID} | ConditionVisuals v${CV_BUILD} online — conditions render on the body (squares retired)`);
  }

  static syncAll() {
    try { for (const tok of canvas?.tokens?.placeables ?? []) ConditionVisuals.sync(tok); } catch (_) {}
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Sync — make one token's visuals match its statuses (idempotent)
  // ═══════════════════════════════════════════════════════════════════════════

  static sync(token) {
    try {
      if (!token?.document || token.destroyed) return;
      const id = token.document.id;
      const statuses = token.actor?.statuses instanceof Set ? token.actor.statuses : new Set();

      // Death pipeline owns dead tokens — we render nothing on them.
      const active = statuses.has("dead") ? []
        : [...statuses].filter(s => BODY_VISUAL_STATUSES.has(s)).sort();
      const key = active.join("|");

      const existing = ConditionVisuals._live.get(id);
      if (existing?.key === key && existing.token === token && !existing.cont?.destroyed) return;
      ConditionVisuals._teardown(id);
      if (!active.length) return;

      ConditionVisuals._build(token, active, key);
    } catch (err) {
      console.warn(`${MODULE_ID} | [conditions] sync failed (non-fatal):`, err);
    }
  }

  static _teardown(id) {
    const e = ConditionVisuals._live.get(id);
    if (e) {
      try { e.cont?.destroy({ children: true }); } catch (_) {}
      ConditionVisuals._live.delete(id);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Build — assemble the visual stack for one token
  // ═══════════════════════════════════════════════════════════════════════════

  static async _build(token, active, key) {
    const layer = canvas?.stage;
    if (!layer || !token?.center) return;
    const w = token.w ?? 100, h = token.h ?? 100;
    const has = (s) => active.includes(s);

    const cont = new PIXI.Container();
    cont.position.set(token.center.x, token.center.y);
    // NEVER intercept the mouse — the overlay must be a ghost. Without this,
    // the container sat over the token eating clicks: unselectable tokens,
    // unreachable sheets (live-fire 2026-07-09).
    cont.eventMode = "none";
    cont.interactiveChildren = false;
    layer.addChild(cont);

    // ── Silhouette mask — created LAZILY, only when something consumes it.
    // A mask sprite added but never bound to anything renders as a plain
    // sprite: a full DUPLICATE of the token's art floating over the real one
    // (the "second Syrax" bug, 2026-07-09). ensureMask() creates it on first
    // use; a token with only wraps/orbits never builds one at all.
    // BODY group — everything anchored to the creature's ART (mask, coats,
    // veins, veil, bolt, chains) lives here and ROTATES with the token's
    // facing each frame (Johnny 2026-07-10: tokens turn; the silhouette work
    // was stuck pointing north). Orbit glyphs + floaters stay outside, upright.
    const body = new PIXI.Container();
    cont.addChild(body);

    const tex = token.mesh?.texture ?? null;
    let mask = null;
    const ensureMask = () => {
      if (mask) return mask;
      if (tex?.valid) {
        mask = new PIXI.Sprite(tex);
        mask.anchor.set(0.5);
        mask.width = w; mask.height = h;
      } else {
        mask = new PIXI.Graphics();
        mask.beginFill(0xffffff, 1).drawEllipse(0, 0, w * 0.48, h * 0.48).endFill();
      }
      body.addChild(mask);
      return mask;
    };

    const anims = [];
    const entry = { token, cont, body, key, anims };
    ConditionVisuals._live.set(token.document.id, entry);

    // ── COATS (petrified suppresses the others — stone is stone) ──
    const coatOrder = has("petrified") ? ["petrified"]
      : ["poisoned", "paralyzed", "frightened", "charmed", "blinded"].filter(has);
    for (const c of coatOrder) {
      const spec = COATS[c];
      const coat = new PIXI.Sprite(PIXI.Texture.WHITE);
      coat.anchor.set(0.5);
      coat.width = w; coat.height = h;
      coat.tint = spec.tint; coat.alpha = spec.alpha;
      coat.mask = ensureMask();
      body.addChild(coat);

      if (c === "petrified") {
        // Fine stone craquelure (Johnny 2026-07-10 v2: the big fissures were
        // "way too big" — small, tiny, detailed cracks). Many short hairline
        // polylines scattered across the silhouette, most solo, some meeting
        // in tiny Y-forks; a 1px light offset gives them a chiseled edge
        // without reading as marker pen. Same silhouette mask as the veins.
        const polys = [];
        const unit = Math.min(w, h);
        const N = 26;                                     // dense = detailed
        for (let i = 0; i < N; i++) {
          // Scatter inside the body ellipse so the mask doesn't eat most.
          const sa = Math.random() * Math.PI * 2;
          const sr = Math.sqrt(Math.random());
          let x = Math.cos(sa) * sr * w * 0.36;
          let y = Math.sin(sa) * sr * h * 0.42;
          let ang = Math.random() * Math.PI * 2;
          const pts = [[x, y]];
          const segs = 2 + Math.floor(Math.random() * 2); // short: 2-3 kinks
          for (let s = 0; s < segs; s++) {
            ang += (Math.random() - 0.5) * 1.1;
            const len = unit * (0.030 + Math.random() * 0.035);
            x += Math.cos(ang) * len; y += Math.sin(ang) * len;
            pts.push([x, y]);
          }
          polys.push({ pts, w0: unit * 0.008 });
          // 1-in-3 gets a tiny fork off its midpoint
          if (Math.random() < 0.33) {
            const [mx, my] = pts[1];
            const bAng = ang + (Math.random() < 0.5 ? 1 : -1) * (0.9 + Math.random() * 0.6);
            const bLen = unit * 0.028;
            polys.push({ pts: [[mx, my], [mx + Math.cos(bAng) * bLen, my + Math.sin(bAng) * bLen]], w0: unit * 0.006 });
          }
        }
        const cracks = new PIXI.Graphics();
        const stroke = (color, alpha, mul, dx, dy) => {
          for (const pl of polys) {
            cracks.lineStyle(Math.max(0.7, pl.w0 * mul), color, alpha);
            cracks.moveTo(pl.pts[0][0] + dx, pl.pts[0][1] + dy);
            for (let i = 1; i < pl.pts.length; i++) cracks.lineTo(pl.pts[i][0] + dx, pl.pts[i][1] + dy);
          }
        };
        const lift = Math.max(0.7, unit * 0.006);
        stroke(0xc9c9c9, 0.30, 1.3, lift, lift);   // faint chiseled highlight
        stroke(0x474747, 0.85, 1.0, 0, 0);         // hairline fissures
        cracks.mask = ensureMask();
        body.addChild(cracks);
      }
    }

    // ── Blinded — smoky veil across the eyes-line of the silhouette ──
    if (has("blinded")) {
      const veil = new PIXI.Graphics();
      veil.beginFill(0x0a0a0a, 0.6)
        .drawRoundedRect(-w * 0.5, -h * 0.34, w, h * 0.2, h * 0.08)
        .endFill();
      veil.mask = ensureMask();
      body.addChild(veil);
    }

    // ── Deafened — broken sound-waves dying at the ears ──
    // (Johnny 2026-07-10: no crossed-out-ear cliche. Ripples march toward
    // the head and visibly fragment/fade before they arrive: sound isn't
    // getting in.) Anchored to the body so the ears stay flanked when the
    // token turns.
    if (has("deafened")) {
      for (const side of [-1, 1]) {
        const waves = new PIXI.Graphics();
        waves.position.set(side * w * 0.30, -h * 0.20);
        body.addChild(waves);
        const phase = side < 0 ? 0 : 700, period = 2600;
        const facing = side < 0 ? Math.PI : 0;   // arcs bulge away from the head
        anims.push((now) => {
          const t = ((now + phase) % period) / period;
          waves.clear();
          for (let k = 0; k < 3; k++) {
            const tt = (t + k / 3) % 1;                        // each ripple's own cycle
            const r = w * (0.24 - tt * 0.16);                  // marching inward
            const die = tt < 0.5 ? 1 : 1 - (tt - 0.5) / 0.5;   // shatter as it closes
            if (die <= 0.04) continue;
            waves.lineStyle(Math.max(1.5, w * 0.02), 0xa8a8a8, 0.75 * die);
            const span = 0.95, gap = 0.10;                     // three dashes per arc
            for (let d = 0; d < 3; d++) {
              const a0 = facing - span / 2 + (d / 3) * span + gap / 2;
              const a1 = facing - span / 2 + ((d + 1) / 3) * span - gap / 2;
              // moveTo the dash start — PIXI otherwise draws a connector line
              // from the previous point into the arc.
              waves.moveTo(Math.cos(a0) * r, Math.sin(a0) * r);
              waves.arc(0, 0, r, a0, a1);
            }
          }
        });
      }
    }

    // ── Paralyzed — periodic electric flicker across the body ──
    if (has("paralyzed")) {
      const bolt = new PIXI.Graphics();
      bolt.lineStyle(Math.max(2, w * 0.03), 0xdff4ff, 0.95);
      let x = -w * 0.28, y = -h * 0.3;
      bolt.moveTo(x, y);
      for (let i = 0; i < 5; i++) {
        x += w * 0.12; y += h * 0.13 * (i % 2 ? -0.6 : 1);
        bolt.lineTo(x, y);
      }
      bolt.alpha = 0; bolt.mask = ensureMask();
      body.addChild(bolt);
      const phase = Math.random() * 2600;
      anims.push((now) => {
        const t = (now + phase) % 2600;
        bolt.alpha = t < 200 ? (1 - t / 200) : 0;
      });
    }

    // ── Charmed — drifting hearts ──
    if (has("charmed")) {
      for (let i = 0; i < 3; i++) {
        const heart = ConditionVisuals._heart(Math.max(5, w * 0.07), 0xff7fb2);
        cont.addChild(heart);
        const phase = i * 1400, period = 4200, drift = (i - 1) * w * 0.16;
        anims.push((now) => {
          const t = ((now + phase) % period) / period;
          heart.position.set(drift + Math.sin(t * Math.PI * 4) * w * 0.05, -h * (0.18 + t * 0.55));
          heart.alpha = t < 0.15 ? t / 0.15 : t > 0.75 ? (1 - t) / 0.25 : 1;
        });
      }
    }

    // ── ORBIT FAMILY — glyphs circling above the head ──
    // One shared look: stunned/incap = gold stars, unconscious = orange Z's,
    // prone = red down-arrows. Count/speed express severity.
    const orbits = [];
    if (has("stunned"))            orbits.push({ n: 3, period: 1500, mk: () => ConditionVisuals._star(Math.max(5, w * 0.075), 0xf2c14e) });
    else if (has("incapacitated")) orbits.push({ n: 2, period: 2600, mk: () => ConditionVisuals._star(Math.max(5, w * 0.075), 0xf2c14e) });
    if (has("unconscious"))        orbits.push({ n: 3, period: 3000, mk: () => ConditionVisuals._zGlyph(h) });
    if (has("prone"))              orbits.push({ n: 3, period: 2200, mk: () => ConditionVisuals._downArrow(Math.max(6, w * 0.085)) });

    let ring = 0;
    for (const o of orbits) {
      // Ring centered ON the token (Johnny 2026-07-10: glyphs were spinning
      // north of the token, not over it). Slight lift + wide ellipse reads as
      // a halo circling the creature; extra rings stack upward.
      const ry = -h * (0.06 + ring * 0.15);
      ring++;
      for (let i = 0; i < o.n; i++) {
        const g = o.mk();
        cont.addChild(g);
        const off = (i / o.n) * o.period;
        anims.push((now) => {
          const t = ((now + off) % o.period) / o.period;
          const a = t * Math.PI * 2;
          g.position.set(Math.cos(a) * w * 0.40, ry + Math.sin(a) * h * 0.16);
          // Depth cue: shrink + dim on the "far side" of the orbit.
          const depth = (Math.sin(a) + 1) / 2;
          g.scale.set(0.8 + depth * 0.3);
          g.alpha = 0.75 + depth * 0.25;
        });
      }
    }

    // ── WRAPS — restrained X-cross + grappled grip band ──
    if (has("restrained") || has("grappled")) {
      // Wait for the chain strip — building before it loads is what produced
      // drawn rings instead of the real PNG (the load race, 2026-07-09).
      try { await ConditionVisuals._chainReady; } catch (_) {}
      if (cont.destroyed) return;           // condition ended while we waited
      if (has("restrained")) {
        // Johnny's call (2026-07-09 20:38): forget body-following wraps —
        // ONE chain corner to corner, ONE across the opposite corners. The X
        // reads "in chains, can't move" on any creature. Equal-length
        // diagonals also render identically by construction (the mixed
        // squished/clean look came from unequal rope lengths).
        ConditionVisuals._chainX(body, w, h);
      }
      if (has("grappled") && !has("restrained")) {
        const rows = await ConditionVisuals._bodyExtents(token);
        if (cont.destroyed) return;
        ConditionVisuals._wrap(body, rows, w, h, 0.5, {
          sag: h * 0.03,
          thickness: Math.max(6, h * 0.08),
          tint: 0xd99a2b,                    // amber grip
        });
      }
    }

    // Start the shared animation/glue loop.
    ConditionVisuals._startLoop();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Body extents — scan the token's own alpha so wraps follow THIS creature
  // ═══════════════════════════════════════════════════════════════════════════

  /** 64 rows of [minXfrac, maxXfrac] (texture space) or null per row; null result = no data. */
  static async _bodyExtents(token) {
    const src = token.document?.texture?.src ?? "?";
    if (ConditionVisuals._extents.has(src)) return ConditionVisuals._extents.get(src);
    let rows = null;
    try {
      const tex = token.mesh?.texture;
      if (tex?.valid) {
        const SZ = 64;
        const spr = new PIXI.Sprite(tex);
        spr.width = SZ; spr.height = SZ;
        const rt = PIXI.RenderTexture.create({ width: SZ, height: SZ });
        canvas.app.renderer.render(spr, { renderTexture: rt });
        const px = await canvas.app.renderer.extract.pixels(rt);
        try { rt.destroy(true); spr.destroy(); } catch (_) {}
        rows = [];
        for (let y = 0; y < SZ; y++) {
          let min = -1, max = -1;
          for (let x = 0; x < SZ; x++) {
            if (px[(y * SZ + x) * 4 + 3] > 60) { if (min < 0) min = x; max = x; }
          }
          rows.push(min < 0 ? null : [min / SZ, max / SZ]);
        }
        // Degenerate scan (full-bleed art, no alpha) → treat as no data.
        const usable = rows.filter(r => r && (r[1] - r[0]) < 0.98);
        if (usable.length < 8) rows = null;
      }
    } catch (_) { rows = null; }
    ConditionVisuals._extents.set(src, rows);
    return rows;
  }

  /**
   * One wrap: a rope bent between the body's real left/right edges at height
   * fraction fy, with dark stubs peeking past the edges (the behind-the-body
   * pass). Uses the chain strip texture when loaded; procedural links if not.
   */
  static _wrap(cont, rows, w, h, fy, { sag, thickness, tint }) {
    // Edge extents at this height — from the silhouette scan when the token
    // has one. Full-art tokens (no cutout) get UNIFORM near-full-width bands:
    // a body-taper with no visible body just reads as a misplaced short chain
    // (the "why is the third chain there" question, 2026-07-09 20:18).
    let minF = 0.09 + Math.random() * 0.02;
    let maxF = 0.91 - Math.random() * 0.02;
    if (rows) {
      const idx = Math.min(63, Math.max(0, Math.round(fy * 63)));
      // Average a 5-row band so one stray pixel row doesn't skew the wrap.
      const band = [];
      for (let d = -2; d <= 2; d++) {
        const r = rows[Math.min(63, Math.max(0, idx + d))];
        if (r) band.push(r);
      }
      if (band.length) {
        minF = band.reduce((s, r) => s + r[0], 0) / band.length;
        maxF = band.reduce((s, r) => s + r[1], 0) / band.length;
      }
    }
    const y0 = (fy - 0.5) * h;
    const x0 = (minF - 0.5) * w - w * 0.03;   // slight overshoot past the edge
    const x1 = (maxF - 0.5) * w + w * 0.03;
    if (!(x1 > x0)) return;

    const path = (t) => ({ x: x0 + (x1 - x0) * t, y: y0 + Math.sin(Math.PI * t) * sag });
    const ropeLen = Math.abs(x1 - x0) + Math.abs(sag) * 0.6;
    ConditionVisuals._chainRope(cont, path, ropeLen, thickness, tint);
  }

  /**
   * Restrained: the X — one chain corner to corner, one across the opposite
   * corners (Johnny's layout call, 2026-07-09 20:38). Reads "in chains,
   * can't move" on ANY creature, and the two diagonals are equal length so
   * they always render identically — the mixed squished/clean look of the
   * horizontal wraps came from unequal rope lengths.
   */
  static _chainX(cont, w, h) {
    const c = 0.52;                                  // slight corner overshoot
    const thickness = Math.max(7, h * 0.085);
    const bump = h * 0.03;                           // gentle perpendicular sag
    const len = Math.hypot(w * c * 2, h * c * 2);
    for (const dir of [1, -1]) {
      const ax = -w * c * dir, ay = -h * c;          // top-left / top-right
      const bx = w * c * dir,  by = h * c;           // bottom-right / bottom-left
      // Perpendicular unit for the sag bulge.
      const px = -(by - ay) / len, py = (bx - ax) / len;
      const path = (t) => ({
        x: ax + (bx - ax) * t + px * Math.sin(Math.PI * t) * bump * dir,
        y: ay + (by - ay) * t + py * Math.sin(Math.PI * t) * bump * dir,
      });
      ConditionVisuals._chainRope(cont, path, len, thickness, 0xffffff);
    }
  }

  /**
   * ONE chain along an arbitrary path. Johnny's strip PNG is the look
   * (drawn iron only as emergency fallback, warned loudly — never silent).
   * The slice is cut to the rope's length so nothing tiles (tiling a
   * non-power-of-two strip smears its edge column into hairline stripes).
   */
  static _chainRope(cont, path, ropeLen, thickness, tint) {
    const chainTex = ConditionVisuals._chainTex;
    if (chainTex?.valid) {
      // Point density scales with length — a fixed count stretched long
      // ropes differently than short ones (the squish inconsistency).
      const nPts = Math.min(40, Math.max(12, Math.round(ropeLen / 22)));
      const points = [];
      for (let i = 0; i <= nPts; i++) {
        const p = path(i / nPts);
        points.push(new PIXI.Point(p.x, p.y));
      }
      const texH = chainTex.height, texW = chainTex.width;
      try {
        // LINK_STRETCH — the taste dial. "wider" → raise, "tighter" → lower.
        const LINK_STRETCH = 18.0;  // 6 → 18: diagonals are ~3× longer than the chunky chain Johnny liked — stretch scales with length (2026-07-09 20:47)
        const sliceW = Math.min(texW, Math.max(32, Math.round(texH * ropeLen / (thickness * LINK_STRETCH))));
        const offX = Math.floor(Math.random() * Math.max(1, texW - sliceW));
        const frame = new PIXI.Texture(chainTex.baseTexture, new PIXI.Rectangle(offX, 0, sliceW, texH));
        const rope = new PIXI.SimpleRope(frame, points, thickness / texH);
        rope.tint = tint;
        cont.addChild(rope);
        return;
      } catch (err) {
        console.warn(`${MODULE_ID} | [conditions] chain slice failed (${err?.message ?? err}) — trying whole-strip rope`);
      }
      try {
        const rope = new PIXI.SimpleRope(chainTex, points, ropeLen / texW);
        rope.tint = tint;
        cont.addChild(rope);
        return;
      } catch (err) {
        console.warn(`${MODULE_ID} | [conditions] whole-strip rope ALSO failed (${err?.message ?? err}) — drawn links fallback`);
      }
    }

    // ── Drawn iron chain (emergency fallback only) ──
    const isGrip = tint !== 0xffffff;
    const BODY = isGrip ? 0x7a5210 : 0x23262b;       // dark iron / dark amber
    const EDGE = isGrip ? 0x8a6220 : 0x2e3238;
    const HILT = isGrip ? 0xe8b45a : 0xaab3bf;       // highlight steel / brass
    const linkL = Math.max(9, thickness * 1.05);
    const segs = Math.max(3, Math.round(ropeLen / (linkL * 0.92)));

    const shadow = new PIXI.Graphics();
    shadow.lineStyle(thickness * 0.85, 0x000000, 0.28);
    const s0 = path(0);
    shadow.moveTo(s0.x, s0.y + 2.5);
    for (let i = 1; i <= 16; i++) {
      const p = path(i / 16);
      shadow.lineTo(p.x, p.y + 2.5);
    }
    cont.addChild(shadow);

    for (let i = 0; i <= segs * 2; i++) {
      const t = i / (segs * 2);
      const p = path(t);
      const pn = path(Math.min(1, t + 0.01));
      const link = new PIXI.Graphics();
      if (i % 2 === 0) {
        link.lineStyle(Math.max(2.5, thickness * 0.30), BODY, 1);
        link.drawEllipse(0, 0, linkL * 0.52, linkL * 0.30);
        link.lineStyle(Math.max(1.2, thickness * 0.11), HILT, 0.9);
        link.drawEllipse(-linkL * 0.03, -linkL * 0.045, linkL * 0.46, linkL * 0.24);
      } else {
        link.lineStyle(Math.max(3, thickness * 0.30), EDGE, 1);
        link.moveTo(-linkL * 0.17, 0); link.lineTo(linkL * 0.17, 0);
        link.lineStyle(Math.max(1.2, thickness * 0.10), HILT, 0.85);
        link.moveTo(-linkL * 0.14, -thickness * 0.06); link.lineTo(linkL * 0.14, -thickness * 0.06);
      }
      link.position.set(p.x, p.y);
      link.rotation = Math.atan2(pn.y - p.y, pn.x - p.x);
      cont.addChild(link);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Glyph builders (procedural — no assets)
  // ═══════════════════════════════════════════════════════════════════════════

  static _star(r, color) {
    const g = new PIXI.Graphics();
    g.beginFill(color, 0.95).lineStyle(1.5, 0x6b5210, 0.9);
    const pts = [];
    for (let i = 0; i < 10; i++) {
      const rad = i % 2 === 0 ? r : r * 0.45;
      const a = (i / 10) * Math.PI * 2 - Math.PI / 2;
      pts.push(Math.cos(a) * rad, Math.sin(a) * rad);
    }
    g.drawPolygon(pts).endFill();
    return g;
  }

  static _downArrow(s) {
    const g = new PIXI.Graphics();
    g.beginFill(0xd83a3a, 0.95).lineStyle(1.5, 0xffffff, 0.85);
    // Chunky ▼ with a short tail — unmistakable at token scale.
    g.drawPolygon([-s * 0.42, -s * 0.9, s * 0.42, -s * 0.9, s * 0.42, -s * 0.25,
                   s * 0.8, -s * 0.25, 0, s * 0.75, -s * 0.8, -s * 0.25, -s * 0.42, -s * 0.25]);
    g.endFill();
    return g;
  }

  static _zGlyph(h) {
    const t = new PIXI.Text("Z", {
      fontFamily: "Signika, Arial, sans-serif",
      fontSize: Math.max(14, h * 0.22),
      fontWeight: "900",
      fill: "#ff9b2d",
      stroke: "#1a0e00",
      strokeThickness: 3,
    });
    t.anchor.set(0.5);
    return t;
  }

  static _heart(s, color) {
    const g = new PIXI.Graphics();
    g.beginFill(color, 0.95);
    g.moveTo(0, s * 0.35);
    g.bezierCurveTo(-s * 1.1, -s * 0.45, -s * 0.45, -s * 1.05, 0, -s * 0.35);
    g.bezierCurveTo(s * 0.45, -s * 1.05, s * 1.1, -s * 0.45, 0, s * 0.35);
    g.endFill();
    return g;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  The shared loop — glue to tokens, mirror visibility, drive animations
  // ═══════════════════════════════════════════════════════════════════════════

  static _startLoop() {
    if (ConditionVisuals._rafHandle != null) return;
    const step = () => {
      ConditionVisuals._rafHandle = null;
      const live = ConditionVisuals._live;
      if (!live.size) return;                          // self-stop when idle
      const now = performance.now();
      for (const [id, e] of live) {
        const tok = e.token;
        if (!tok || tok.destroyed || e.cont?.destroyed) { ConditionVisuals._teardown(id); continue; }
        try {
          // Glue to the token (frightened adds a tremble on top).
          let x = tok.center.x, y = tok.center.y;
          if (e.key.includes("frightened")) {
            x += (Math.random() - 0.5) * 2.6;
            y += (Math.random() - 0.5) * 2.6;
          }
          e.cont.position.set(x, y);
          e.cont.visible = !!tok.visible;
          if (e.body) e.body.rotation = ((tok.document?.rotation ?? 0) * Math.PI) / 180;
          for (const fn of e.anims) fn(now);
        } catch (_) { /* per-token guard — one bad token never stops the loop */ }
      }
      ConditionVisuals._rafHandle = requestAnimationFrame(step);
    };
    ConditionVisuals._rafHandle = requestAnimationFrame(step);
  }
}
