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
const CV_BUILD = "0.7.215";

/** Conditions this engine renders on the body — their token squares are suppressed. */
export const BODY_VISUAL_STATUSES = new Set([
  "prone", "restrained", "poisoned", "paralyzed", "stunned", "incapacitated",
  "frightened", "blinded", "charmed", "unconscious", "petrified", "grappled",
  "deafened",
]);

// Coat colors / alphas — tuned for readability over varied art without
// drowning it. Petrified is deliberately heavy: stone should look like stone.
const COATS = {
  // Greener + stronger on Johnny's call (2026-07-28) — "just crank up the
  // green, I'll tell you when to stop". Was 0x3fae5a @ 0.34.
  poisoned:   { tint: 0x2fe04a, alpha: 0.42 },
  paralyzed:  { tint: 0xbfe8ff, alpha: 0.30 },
  frightened: { tint: 0x9a6bd0, alpha: 0.20 },
  charmed:    { tint: 0xff8fc0, alpha: 0.22 },
  blinded:    { tint: 0x111111, alpha: 0.20 },
  petrified:  { tint: 0x848484, alpha: 0.90 },   // legacy flat wash (fallback only now)
};

// ── Petrified "stone" look knobs (all in one place — tune live) ─────────────
// A petrified creature is drawn as: its OWN art DESATURATED to grey form, then a
// real GRANITE texture laid over the silhouette for the stone material.
const STONE_TINT   = 0xc0c8d2;   // tint on the desaturated FORM (cool granite)
const STONE_BRIGHT = 1.05;       // brightness lift on the form (higher = paler, less detail)
const STONE_BASE_TINT = 0xc4ccd6; // SOLID backing under the silhouette so the stone
                                  // reads as one solid statue with no PC-glow behind
                                  // it (players) — kills the see-through ghost look.
// Granite material overlay:
const GRANITE_TEXTURE_PATH = "modules/ace-qol/Assets/UI/Textures/granite-petrified.png";
const GRANITE_ALPHA = 0.85;      // overlay transparency — THE main knob (0 = none, 1 = full stone)
const GRANITE_BLEND = "NORMAL";  // "NORMAL" | "MULTIPLY" | "OVERLAY"
const GRANITE_SCALE = 1.2;       // >1 pushes the texture's feathered edge outside the silhouette

// ── Restrained "cinch" knobs (Johnny 2026-07-28) ────────────────────────────
// The chains bind, and the body gives where they bite. Deliberately SUBTLE:
// it should read as bound, not as broken art. Turn AMOUNT up if you want it
// to bite harder.
const RESTRAIN_PINCH_Y      = 0.52;  // where the squeeze is tightest (0 = top of the art, 1 = bottom)
const RESTRAIN_PINCH_BAND   = 0.22;  // how far it feathers above/below — bigger = softer, wider cinch
const RESTRAIN_PINCH_AMOUNT = 0.12;  // 0.12 ≈ 12% narrower at the tightest point
const RESTRAIN_PULSE_DEPTH  = 0.25;  // breathing: ±25% of AMOUNT, so it strains rather than sits still
const RESTRAIN_PULSE_MS     = 2600;  // one full squeeze-and-ease cycle

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

    // Petrified granite material — load once, same pattern as the chain strip.
    // Absent file → the desaturated stone form still renders (granite is additive).
    ConditionVisuals._graniteReady = (async () => {
      try {
        const loader = globalThis.loadTexture ?? (p => PIXI.Assets.load(p));
        ConditionVisuals._graniteTex = await loader(GRANITE_TEXTURE_PATH).catch?.(() => null) ?? null;
        if (ConditionVisuals._graniteTex?.valid !== false && ConditionVisuals._graniteTex) {
          console.log(`${MODULE_ID} | [conditions] granite texture loaded (${ConditionVisuals._graniteTex.width}×${ConditionVisuals._graniteTex.height})`);
        } else {
          console.log(`${MODULE_ID} | [conditions] no granite texture yet — desaturated stone only`);
        }
      } catch (_) {
        ConditionVisuals._graniteTex = null;
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
    // Foundry rebuilds token.mesh on redraws (elevation, art swaps, some refreshes),
    // wiping our welded stone filter. Cheaply re-weld it if it went missing on a
    // petrified token we're already managing. Guard makes the common frame a no-op.
    Hooks.on("refreshToken", (token) => {
      try {
        if (!ConditionVisuals._live.has(token?.document?.id)) return;

        // The restrained cinch is welded to the mesh too, so a rebuild drops it
        // the same way. Re-weld it here; the common frame is a no-op.
        const st = token?.actor?.statuses;
        if (st?.has?.("restrained") && !st?.has?.("petrified")) {
          const pf = token._aceRestrainPinch;
          if (!pf || !token.mesh?.filters?.includes(pf)) ConditionVisuals._applyRestrainPinch(token);
        } else if (token._aceRestrainPinch) {
          ConditionVisuals._removeRestrainPinch(token);   // no longer bound → let it go
        }

        if (!st?.has?.("petrified")) return;
        const cm = token._aceStoneFilter;
        if (!cm || !token.mesh?.filters?.includes(cm)) ConditionVisuals._applyStoneMesh(token);      // mesh rebuilt → re-weld
        const disc = token._aceStoneBackdisc;
        if (!disc || !token.children?.includes(disc)) ConditionVisuals._applyStoneBackdisc(token);   // redraw dropped it → re-add
        const gr = token._aceStoneGranite;
        if (!gr || !token.children?.includes(gr)) ConditionVisuals._applyStoneGranite(token);        // redraw dropped it → re-add

        // ⚠️ AND SYNC THE TRANSFORM — EVERY refresh, not just on rebuild.
        // This was the second half of the ghost (2026-08-06). The three lines
        // above only act when a layer went MISSING, so on an ordinary refresh —
        // a move, a rotation — nothing here ran. _syncStoneTransforms was called
        // exactly once, at build, and never again. The real art turned with the
        // token; the granite did not. Johnny: "it doesn't follow the token if I
        // spin the token around."
        ConditionVisuals._syncStoneTransforms(token);
      } catch (_) { /* non-fatal */ }
    });
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
      // Un-weld the petrified stone filter + remove the temporary white backing.
      try { if (e.token) ConditionVisuals._removeStoneMesh(e.token); } catch (_) {}
      try { if (e.token) ConditionVisuals._removeStoneBackdisc(e.token); } catch (_) {}
      try { if (e.token) ConditionVisuals._removeStoneGranite(e.token); } catch (_) {}
      // Un-squeeze — a cinch left welded on would outlive the chains.
      try { if (e.token) ConditionVisuals._removeRestrainPinch(e.token); } catch (_) {}
      ConditionVisuals._live.delete(id);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Restrained — the CINCH (a real squeeze of the creature's own art)
  // ═══════════════════════════════════════════════════════════════════════════
  //
  // Johnny 2026-07-28: "Do you have the ability to squish the token image… the
  // mid-section?" Yes — and it belongs on restrained, where the chain X already
  // crosses the body. The chains bind; the body gives where they bite.
  //
  // WHY A FILTER ON THE REAL MESH, and not a warped copy of the art:
  // a squeezed copy no longer covers the original underneath, so the unpinched
  // art shows past its edges — the exact doubling we just spent the evening
  // killing. To use a copy we'd have to hide Foundry's mesh and take over
  // drawing the token (vision, occlusion, elevation, refreshes). Deforming the
  // real mesh in place can't misalign with itself, and costs one shader.
  //
  // Foundry drops mesh filters on refresh, which is why the refreshToken hook
  // re-welds this the same way it re-welds the petrify greyscale.

  /** Lazily built so PIXI is certainly loaded. Horizontal squeeze, strongest at
   *  uCenterY, falling off smoothly — a cinch, never a hard step. */
  static _pinchFilterClass() {
    if (ConditionVisuals.__pinchCls !== undefined) return ConditionVisuals.__pinchCls;
    try {
      const FRAG = `
        precision mediump float;
        varying vec2 vTextureCoord;
        uniform sampler2D uSampler;
        uniform vec4 inputClamp;
        uniform float uCenterY;
        uniform float uBand;
        uniform float uAmount;

        void main(void) {
          vec2 uv = vTextureCoord;

          // Work relative to the sprite's own box inside the filter frame —
          // padding means the frame is not the sprite.
          float x0 = inputClamp.x, x1 = inputClamp.z;
          float y0 = inputClamp.y, y1 = inputClamp.w;
          float yc = mix(y0, y1, uCenterY);
          float band = max((y1 - y0) * uBand, 0.0001);

          float d = (uv.y - yc) / band;
          float f = exp(-d * d);              // gaussian — no visible seam
          float k = 1.0 + uAmount * f;        // sample WIDER => art reads NARROWER

          float cx = (x0 + x1) * 0.5;
          uv.x = cx + (uv.x - cx) * k;

          // Past the sprite's own edge there is nothing to squeeze in from.
          if (uv.x < x0 || uv.x > x1) { gl_FragColor = vec4(0.0); return; }
          gl_FragColor = texture2D(uSampler, uv);
        }
      `;
      class AcePinchFilter extends PIXI.Filter {
        constructor() {
          super(undefined, FRAG, {
            uCenterY: RESTRAIN_PINCH_Y,
            uBand:    RESTRAIN_PINCH_BAND,
            uAmount:  RESTRAIN_PINCH_AMOUNT,
          });
          this.padding = 0;   // we only ever sample inward
        }
      }
      ConditionVisuals.__pinchCls = AcePinchFilter;
    } catch (err) {
      console.warn(`${MODULE_ID} | [conditions] pinch filter unavailable (non-fatal):`, err);
      ConditionVisuals.__pinchCls = null;   // remembered, so we don't retry every frame
    }
    return ConditionVisuals.__pinchCls;
  }

  /** Weld the cinch onto the token's own mesh. */
  static _applyRestrainPinch(token) {
    try {
      ConditionVisuals._removeRestrainPinch(token);        // never stack
      // Stone does not breathe, and it certainly does not get squeezed.
      if (token?.actor?.statuses?.has?.("petrified")) return;
      const Cls = ConditionVisuals._pinchFilterClass();
      const mesh = token?.mesh;
      if (!Cls || !mesh) return;
      const f = new Cls();
      mesh.filters = [...(mesh.filters ?? []), f];
      token._aceRestrainPinch = f;
    } catch (err) {
      console.warn(`${MODULE_ID} | [conditions] restrain cinch failed (non-fatal):`, err);
    }
  }

  /** Un-weld the cinch, restoring the creature's normal shape. */
  static _removeRestrainPinch(token) {
    try {
      const f = token?._aceRestrainPinch;
      if (!f) return;
      const mesh = token?.mesh;
      if (mesh?.filters?.length) {
        const rest = mesh.filters.filter(x => x !== f);
        mesh.filters = rest.length ? rest : null;
      }
      delete token._aceRestrainPinch;
    } catch (_) { /* mesh already gone */ }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Petrified stone — WELDED to the token's own mesh (like PC-Glow)
  // ═══════════════════════════════════════════════════════════════════════════

  /** Turn the token's OWN art to stone by desaturating its mesh in place —
   *  the same technique PC-Glow uses to weld its filter onto token.mesh. Locked
   *  to the token, identical for GM + players, no floating copy. Idempotent. */
  static _applyStoneMesh(token) {
    try {
      const mesh = token?.mesh;
      if (!mesh) return;
      const CMF = PIXI.filters?.ColorMatrixFilter ?? PIXI.ColorMatrixFilter ?? null;
      if (!CMF) return;
      ConditionVisuals._removeStoneMesh(token);            // never stack
      const cm = new CMF();
      cm.desaturate();                                     // strip colour → stone grey
      cm.brightness(STONE_BRIGHT, true);                   // keep the darks reading
      mesh.filters = [...(mesh.filters ?? []), cm];        // append (coexists w/ glow outline)
      token._aceStoneFilter = cm;
    } catch (err) {
      console.warn(`${MODULE_ID} | [conditions] stone-mesh weld failed (non-fatal):`, err);
    }
  }

  /** Remove the welded stone filter, restoring the token's normal art. */
  static _removeStoneMesh(token) {
    try {
      const cm = token?._aceStoneFilter;
      if (!cm) return;
      const mesh = token?.mesh;
      if (mesh?.filters) {
        const cleaned = mesh.filters.filter(f => f !== cm);
        mesh.filters = cleaned.length ? cleaned : null;
      }
      delete token._aceStoneFilter;
    } catch (_) { /* non-fatal */ }
  }

  /** Temporary WHITE backing behind a petrified token — the PC-Glow technique (a
   *  child added at index 0, behind the art), but CLIPPED TO THE SILHOUETTE: a
   *  white fill masked by a copy of the token's own texture, so the backing is
   *  exactly the creature's shape (no circle/halo) — solid white behind his
   *  outline. Only while petrified. (Johnny 2026-07-26.) */
  static _applyStoneBackdisc(token) {
    try {
      ConditionVisuals._removeStoneBackdisc(token);        // never stack
      const w = token.w ?? 100, h = token.h ?? 100;
      const cx = w / 2, cy = h / 2;
      const tex = token.mesh?.texture;

      const backing = new PIXI.Container();
      backing.eventMode = "none";                          // pure decoration, never hit-tests
      backing.interactiveChildren = false;

      // ── ROTATE WITH THE ART (2026-07-28) ──
      // Children sat at (cx, cy) with no rotation, so when the token turned the
      // art swung round and this silhouette stayed pointing north — the mismatch
      // Johnny kept seeing. Put the children at the ORIGIN and move the pivot to
      // the token centre instead, so setting `backing.rotation` spins the whole
      // thing about the creature's middle. The per-frame loop drives it from
      // token.mesh.rotation (what's actually drawn), never document.rotation.
      backing.position.set(cx, cy);

      if (tex?.valid) {
        // Same geometry the art actually uses — a square-sized backing behind
        // overflowing art shows as a hard edge inside the creature's outline.
        const g = ConditionVisuals._meshGeometry(token);
        const fill = new PIXI.Sprite(PIXI.Texture.WHITE);
        fill.anchor.set(g.ax, g.ay); fill.width = g.w; fill.height = g.h;
        fill.position.set(g.ox, g.oy);
        fill.tint = 0xffffff; fill.alpha = 0.9;
        backing._aceFill = fill;                           // handles for the self-heal pass
        const silhouette = new PIXI.Sprite(tex);           // same art → same shape/size
        silhouette.anchor.set(g.ax, g.ay); silhouette.width = g.w; silhouette.height = g.h;
        silhouette.position.set(g.ox, g.oy);
        // A MASK MUST NOT ALSO DRAW. It has to be in the tree so its transform
        // updates, but being in the tree means it renders too — a full second
        // copy of the token's art. Sprite masks are sampled by the filter, not
        // by the normal draw, so this costs the mask nothing.
        silhouette.renderable = false;
        backing._aceSilhouette = silhouette;
        backing.addChild(silhouette);                      // mask must live in the tree
        fill.mask = silhouette;
        backing.addChild(fill);
      } else {
        // No readable texture → fall back to the plain disc (PC-Glow geometry).
        const disc = new PIXI.Graphics();
        disc.beginFill(0xffffff, 0.9).drawCircle(0, 0, Math.max(w, h) * 0.55).endFill();
        backing.addChild(disc);
      }

      try { token.addChildAt(backing, 0); } catch (_) { token.addChild(backing); }
      token._aceStoneBackdisc = backing;
      ConditionVisuals._syncStoneTransforms(token);   // correct on the very first frame
    } catch (err) {
      console.warn(`${MODULE_ID} | [conditions] stone backing failed (non-fatal):`, err);
    }
  }

  /**
   * The token art's ACTUAL on-screen geometry.
   *
   * Every stone layer used to be drawn at the token's GRID SQUARE size, on the
   * assumption that a token's art fills its square. Plenty don't: Izek's
   * portrait spills well outside his, so the copy landed smaller and off-centre
   * and you saw his axe twice — the real art plus a shrunken duplicate ghosting
   * over it. (Johnny 2026-07-28: "you can see the double axed double axis".)
   *
   * The mesh knows its own size, anchor and mirroring, so ask it rather than
   * assume. Falls back to the square only when there's no mesh to read.
   */
  static _meshGeometry(token) {
    const baseW = token?.w ?? 100, baseH = token?.h ?? 100;
    const out = { w: baseW, h: baseH, ox: 0, oy: 0, ax: 0.5, ay: 0.5 };
    try {
      // ⚠️ NEVER read mesh.width/height here (regression, 2026-07-28).
      // Foundry sizes the token mesh by handing document.getSize() to
      // mesh.resize(), which derives a SCALE FACTOR from the raw texture
      // dimensions. So mesh.width only reports canvas pixels once that resize
      // has happened — read it a moment early and you get the TEXTURE size,
      // 1024 or 2048px instead of ~100. Every stone layer then drew at ten to
      // twenty times scale: screen-filling grey ghosts that slid around as
      // their tokens moved. Johnny caught it on both screens.
      //
      // ⚠️ AND grid-size × texture-scale IS NOT THE DRAWN SIZE EITHER
      // (2026-07-28, Izek). Foundry hands the size box to mesh.resize() along
      // with the texture's FIT mode. Under "contain" — the default — the art is
      // scaled to fit INSIDE that box preserving its aspect ratio, so a wide or
      // tall image is drawn SMALLER than the box in one axis. Multiplying the
      // box by the scale ignores that entirely, so our stone copy came out with
      // the wrong aspect and a little too big, sitting over the real art as a
      // squashed second image. Square-ish art matched by coincidence, which is
      // why exactly one token showed it.
      //
      // The mesh already holds the answer Foundry computed. Read it, and only
      // fall back to arithmetic if what it reports is implausible — which is
      // the timing case above, where resize hasn't run and width still reports
      // raw texture pixels. Believe the mesh, but verify it.
      const m = token?.mesh;
      const mw = Number(m?.width), mh = Number(m?.height);

      // ⚠️ "IS IT SANE?" WAS THE WRONG QUESTION (2026-08-06).
      // The old guard accepted any value up to base × 6 — and that ceiling
      // SCALES WITH THE TOKEN, so the bigger the creature the more raw-texture
      // sizes it waved through. A Large ogre has a 240px token, giving a 1440px
      // ceiling; the ogre art is 1068 × 1090. Comfortably "plausible", and drawn
      // at 4.4× actual size. A Medium creature with the same art has a 720px
      // ceiling, so it failed the check and looked fine — which is exactly why
      // this presented as "only some creatures, only sometimes".
      //
      // The right question is not "is this number sane" but "has Foundry
      // actually resized the mesh yet?" — and there is a definitive answer:
      // before resize, mesh.width IS the raw texture width. Compare them.
      const src = m?.texture?.orig ?? m?.texture ?? null;
      const rawW = Number(src?.width), rawH = Number(src?.height);
      const unresized = Number.isFinite(rawW) && rawW > 0
        && Math.abs(mw - rawW) < 1 && Math.abs(mh - rawH) < 1;

      const plausible = (v, base) => Number.isFinite(v) && v > 0 && v <= base * 6;

      if (!unresized && plausible(mw, baseW) && plausible(mh, baseH)) {
        out.w = mw;
        out.h = mh;
        if (Number.isFinite(m?.anchor?.x)) out.ax = m.anchor.x;
        if (Number.isFinite(m?.anchor?.y)) out.ay = m.anchor.y;
      } else {
        // Mesh not sized yet (or reporting texture pixels) — do Foundry's own
        // fit maths ourselves so the aspect ratio is still respected.
        const size = token?.document?.getSize?.();
        const tex  = token?.document?.texture ?? {};
        const sx = Math.abs(Number(tex.scaleX ?? 1)) || 1;
        const sy = Math.abs(Number(tex.scaleY ?? 1)) || 1;
        const boxW = Number.isFinite(size?.width)  && size.width  > 0 ? size.width  : baseW;
        const boxH = Number.isFinite(size?.height) && size.height > 0 ? size.height : baseH;

        const src = m?.texture?.orig ?? m?.texture ?? null;
        const tw = Number(src?.width), th = Number(src?.height);
        let dw = boxW * sx, dh = boxH * sy;                 // "fill" behaviour

        if (Number.isFinite(tw) && tw > 0 && Number.isFinite(th) && th > 0) {
          const fit = String(tex.fit ?? "contain");
          const rx = boxW / tw, ry = boxH / th;
          let k;
          switch (fit) {
            case "fill":   k = null;                break;  // stretch — keep dw/dh
            case "cover":  k = Math.max(rx, ry);    break;
            case "width":  k = rx;                  break;
            case "height": k = ry;                  break;
            default:       k = Math.min(rx, ry);    break;  // "contain"
          }
          if (k != null) { dw = tw * k * sx; dh = th * k * sy; }
        }
        out.w = dw; out.h = dh;
        if (Number.isFinite(tex.anchorX)) out.ax = tex.anchorX;
        if (Number.isFinite(tex.anchorY)) out.ay = tex.anchorY;
      }
    } catch (_) { /* fall back to the square */ }

    // ── HARD SANITY CLAMP ──
    // Whatever the maths says, a stone layer is never more than a few times the
    // token's own square. This class of bug painted the whole canvas once; it
    // does not get a second chance, however the numbers arrive.
    const MAX = 6;
    if (!(out.w > 0) || out.w > baseW * MAX) out.w = baseW;
    if (!(out.h > 0) || out.h > baseH * MAX) out.h = baseH;
    return out;
  }

  /**
   * GRANITE ON THE FRONT — real stone grain over the creature's silhouette.
   *
   * The texture has been loaded at boot since 0.7.2xx and then quietly thrown
   * away: nothing ever consumed `_graniteTex`, which is why the stone always
   * read as a flat grey wash rather than rock. It now goes ON TOP of the art,
   * clipped to the creature's own outline, so the grain sits in the shape of
   * the body instead of a square patch over it. (Johnny 2026-07-28.)
   *
   * Two sprites of the SAME texture: one is the mask (the token's art), one is
   * the granite. A PIXI mask must live in the display tree, so both are added.
   */
  static _applyStoneGranite(token) {
    try {
      ConditionVisuals._removeStoneGranite(token);         // never stack
      const gran = ConditionVisuals._graniteTex;
      const tex  = token.mesh?.texture;
      if (!gran || !tex?.valid) return;                    // no texture → grey wash stands

      const w = token.w ?? 100, h = token.h ?? 100;
      const cx = w / 2, cy = h / 2;

      const cont = new PIXI.Container();
      cont.eventMode = "none";
      cont.interactiveChildren = false;
      cont.position.set(cx, cy);                           // pivot at the creature's middle

      // ── STONE FORM — our own greyed copy of the creature (2026-07-28) ──
      // The greyscale used to live as a filter welded onto token.mesh, but that
      // mesh belongs to Foundry's primary canvas group and Foundry rewrites its
      // filters on refresh, so the weld kept getting dropped. Johnny proved it
      // without knowing: "it looks great on Casimir, but his skin is really
      // white" — if the desaturation were actually working, the subject's skin
      // tone could not possibly matter. Grey is grey. It only looked right on
      // already-pale art because the greyscale wasn't happening at all.
      //
      // So we draw the grey ourselves, on a sprite WE own and Foundry never
      // touches. No mask is needed or wanted here: the token's texture already
      // carries the creature's silhouette in its own alpha channel — and a
      // sprite given BOTH a ColorMatrixFilter and a mask silently drops the
      // filter (the lesson that cost us the first petrify attempt).
      // Match the ART's real geometry, not the grid square — art that overflows
      // its square (Izek) rendered as a visible second, smaller copy otherwise.
      const g = ConditionVisuals._meshGeometry(token);

      // ⚠️ THE CREATURE IS DRAWN ONCE. NEVER TWICE. (2026-08-06)
      //
      // There used to be a `form` sprite here: a second full copy of the token
      // art, greyed and tinted, laid over the real one. But _applyStoneMesh
      // ALREADY welds a desaturate+brightness filter onto the real mesh — the
      // actual art is already stone. So the creature was being rendered twice:
      // once by Foundry (always perfectly sized, positioned and rotated) and
      // once by us (geometry guessed).
      //
      // Two copies means every disagreement between them is a visible ghost,
      // and they disagreed on BOTH axes:
      //   • size — the plausibility clamp below let a 1068px raw texture pass
      //     as "sane" on a 240px Large token, drawing a 4.4× monster;
      //   • rotation — the transform was synced once at build and never again,
      //     so the real art turned and the copy did not.
      // Johnny saw both: a screen-filling grey ogre, then a doubled ogre inside
      // its own square after he moved and turned it.
      //
      // Aligning a duplicate more carefully is not a fix — it is a bug waiting
      // for the next timing change. Deleting it is the fix. What remains below
      // is granite GRAIN clipped to the creature's outline: a texture pass, not
      // a second creature. If the grain is ever a few pixels off, it reads as
      // stone; a misplaced copy of the creature reads as a ghost.
      //
      // The cool granite cast that `form.tint` used to provide now comes from
      // the grain layer's own tint + blend below, which is where a surface
      // treatment belongs anyway.

      // Granite fills the token square; the silhouette clips it to the body.
      // GRANITE_SCALE >1 pushes the texture's own feathered edge outside the
      // mask, so the clip comes from the CREATURE's outline, not the texture's.
      const stone = new PIXI.Sprite(gran);
      stone.anchor.set(0.5);
      stone.width = g.w * GRANITE_SCALE; stone.height = g.h * GRANITE_SCALE;
      stone.position.set(g.ox, g.oy);
      stone.alpha = GRANITE_ALPHA;
      stone.tint = STONE_TINT;    // the cool cast the deleted `form` copy used to carry
      // Blend is a live knob at the top of this file. MULTIPLY keeps the form's
      // light and shade readable; NORMAL lays flatter, heavier stone.
      stone.blendMode = PIXI.BLEND_MODES[GRANITE_BLEND] ?? PIXI.BLEND_MODES.NORMAL;

      const silhouette = new PIXI.Sprite(tex);
      silhouette.anchor.set(g.ax, g.ay);
      silhouette.width = g.w; silhouette.height = g.h;
      silhouette.position.set(g.ox, g.oy);
      silhouette.renderable = false;                       // mask only — must never draw

      cont.addChild(silhouette);                           // mask must be in the tree
      stone.mask = silhouette;
      cont.addChild(stone);

      token.addChild(cont);                                // ON TOP of the art
      token._aceStoneGranite = cont;
      // Keep handles on the two sprites so _syncStoneTransforms can CORRECT
      // their geometry later, not just their rotation. Without this, an overlay
      // built during a bad frame stayed wrong for the life of the token.
      cont._aceStone = stone;
      cont._aceSilhouette = silhouette;
      ConditionVisuals._syncStoneTransforms(token);
    } catch (err) {
      console.warn(`${MODULE_ID} | [conditions] granite overlay failed (non-fatal):`, err);
    }
  }

  /** Remove the granite grain overlay. */
  static _removeStoneGranite(token) {
    try {
      const g = token?._aceStoneGranite;
      if (!g) return;
      try { g.parent?.removeChild(g); } catch (_) {}
      try { g.destroy({ children: true }); } catch (_) {}
      delete token._aceStoneGranite;
    } catch (_) { /* non-fatal */ }
  }

  /**
   * Point the stone layers the same way the ART is pointing.
   *
   * ⚠️ Read token.mesh.rotation, NOT token.document.rotation. The document
   * holds the requested angle; the mesh holds what is actually on screen. They
   * differ whenever the token has `lockRotation` set (art stays put, document
   * doesn't) and all the way through a rotation animation (document snaps to
   * the final angle instantly, the mesh eases into it). Driving off the
   * document is why the stone kept sliding out of register with the body.
   */
  static _syncStoneTransforms(token) {
    try {
      const rot = Number.isFinite(token?.mesh?.rotation)
        ? token.mesh.rotation
        : ((token?.document?.rotation ?? 0) * Math.PI) / 180;
      if (token._aceStoneBackdisc) token._aceStoneBackdisc.rotation = rot;
      if (token._aceStoneGranite)  token._aceStoneGranite.rotation  = rot;

      // ── SELF-HEAL THE GEOMETRY (2026-08-06) ────────────────────────────
      // Rotation alone was not enough. If an overlay was ever built during a
      // frame where the mesh had not been sized, it stayed wrong forever —
      // nothing recomputed it. Now every refresh re-measures and corrects, so
      // a bad first frame fixes itself on the very next one instead of
      // persisting as a giant grey ghost for the rest of the session.
      const cont = token?._aceStoneGranite;
      const back = token?._aceStoneBackdisc;
      if (!cont && !back) return;
      const g = ConditionVisuals._meshGeometry(token);
      const changed = (a, b) => !Number.isFinite(a) || Math.abs(a - b) > 0.5;

      // The white backing is masked, so bad geometry shows as a pale blob
      // rather than a duplicate creature — but it is the same failure and gets
      // the same correction.
      for (const spr of [back?._aceFill, back?._aceSilhouette]) {
        if (!spr) continue;
        if (changed(spr.width, g.w) || changed(spr.height, g.h)) {
          spr.anchor.set(g.ax, g.ay);
          spr.width = g.w; spr.height = g.h;
          spr.position.set(g.ox, g.oy);
        }
      }
      if (!cont) return;

      const sil = cont._aceSilhouette;
      if (sil && (changed(sil.width, g.w) || changed(sil.height, g.h))) {
        sil.anchor.set(g.ax, g.ay);
        sil.width = g.w; sil.height = g.h;
        sil.position.set(g.ox, g.oy);
      }
      const st = cont._aceStone;
      const wantW = g.w * GRANITE_SCALE, wantH = g.h * GRANITE_SCALE;
      if (st && (changed(st.width, wantW) || changed(st.height, wantH))) {
        st.width = wantW; st.height = wantH;
        st.position.set(g.ox, g.oy);
      }
    } catch (_) { /* non-fatal */ }
  }

  /** Remove the temporary white silhouette backing. */
  static _removeStoneBackdisc(token) {
    try {
      const disc = token?._aceStoneBackdisc;
      if (!disc) return;
      try { disc.parent?.removeChild(disc); } catch (_) {}
      try { disc.destroy({ children: true }); } catch (_) {}
      delete token._aceStoneBackdisc;
    } catch (_) { /* non-fatal */ }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Build — assemble the visual stack for one token
  // ═══════════════════════════════════════════════════════════════════════════

  static async _build(token, active, key) {
    const layer = canvas?.stage;
    if (!layer || !token?.center) return;
    const w = token.w ?? 100, h = token.h ?? 100;

    // ── THE ART'S REAL BOX vs THE GRID SQUARE (2026-07-28) ──
    // Two different measurements, and using the wrong one is what made the
    // petrify layers draw a squashed second Izek. Foundry FITS art inside the
    // token square preserving aspect ratio, so for anything that isn't square
    // the drawn art is smaller in one axis than w×h.
    //
    //   bw/bh — where the CREATURE actually is. Everything in the BODY group
    //           (silhouette mask, coats, veil, bolt, ear waves, hearts) must
    //           use this or it clips and sits against the wrong outline.
    //   w/h   — the token's SPACE. Orbiting glyphs circle the square by design
    //           (they're deliberately outside the body and stay upright), so
    //           those keep using it.
    //
    // For square art the two are identical, which is why this changes nothing
    // on almost every token and everything on the odd-shaped ones.
    const _art = ConditionVisuals._meshGeometry(token);
    const bw = _art.w, bh = _art.h;

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
        mask.anchor.set(_art.ax, _art.ay);
        mask.width = bw; mask.height = bh;         // the ART's box, not the square
        mask.renderable = false;                   // mask only — a drawn mask is a duplicate
      } else {
        mask = new PIXI.Graphics();
        // Graphics masks go through the stencil system, which needs the render
        // call — do NOT set renderable = false on this one.
        mask.beginFill(0xffffff, 1).drawEllipse(0, 0, bw * 0.48, bh * 0.48).endFill();
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
      // ── Petrified → TRUE STONE, WELDED TO THE TOKEN (Johnny 2026-07-26) ──
      // The old path floated a desaturated COPY of him on the global stage layer;
      // it drifted behind him and went ghostly for players, because it was never
      // actually attached to him. Instead desaturate the token's OWN mesh in
      // place — exactly how PC-Glow welds its filter onto token.mesh. The real
      // art turns to stone, locked to him, IDENTICAL for GM and players: no copy,
      // no z-order, no ghost, no dependency on a glow behind him. (Granite grain
      // re-layers on top next, once this weld is confirmed solid.)
      if (c === "petrified") {
        ConditionVisuals._applyStoneMesh(token);
        ConditionVisuals._applyStoneBackdisc(token);   // temporary white backing (Johnny 2026-07-26)
        ConditionVisuals._applyStoneGranite(token);    // real granite grain ON TOP (Johnny 2026-07-28)
        continue;
      }

      // ── Other conditions → a translucent tint sheet ──
      const spec = COATS[c];
      const coat = new PIXI.Sprite(PIXI.Texture.WHITE);
      coat.anchor.set(_art.ax, _art.ay);
      coat.width = bw; coat.height = bh;           // cover the ART, not the square
      coat.tint = spec.tint; coat.alpha = spec.alpha;
      coat.mask = ensureMask();
      body.addChild(coat);
    }

    // ── Blinded — smoky veil across the eyes-line of the silhouette ──
    if (has("blinded")) {
      const veil = new PIXI.Graphics();
      veil.beginFill(0x0a0a0a, 0.6)
        .drawRoundedRect(-bw * 0.5, -bh * 0.34, bw, bh * 0.2, bh * 0.08)
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
        waves.position.set(side * bw * 0.30, -bh * 0.20);
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
            waves.lineStyle(Math.max(1.5, bw * 0.02), 0xa8a8a8, 0.75 * die);
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
      bolt.lineStyle(Math.max(2, bw * 0.03), 0xdff4ff, 0.95);
      let x = -bw * 0.28, y = -bh * 0.3;
      bolt.moveTo(x, y);
      for (let i = 0; i < 5; i++) {
        x += bw * 0.12; y += bh * 0.13 * (i % 2 ? -0.6 : 1);
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
        const heart = ConditionVisuals._heart(Math.max(5, bw * 0.07), 0xff7fb2);
        cont.addChild(heart);
        const phase = i * 1400, period = 4200, drift = (i - 1) * bw * 0.16;
        anims.push((now) => {
          const t = ((now + phase) % period) / period;
          heart.position.set(drift + Math.sin(t * Math.PI * 4) * bw * 0.05, -bh * (0.18 + t * 0.55));
          heart.alpha = t < 0.15 ? t / 0.15 : t > 0.75 ? (1 - t) / 0.25 : 1;
        });
      }
    }

    // ── ORBIT FAMILY — glyphs circling above the head ──
    // One shared look: stunned/incap = gold stars, unconscious = orange Z's,
    // prone = red down-arrows. Count/speed express severity.
    //
    // PETRIFIED SUPPRESSES ORBITS TOO (Johnny 2026-07-24): the coats already
    // collapse to bare stone above, but the orbit glyphs did not — and petrified
    // carries the `incapacitated` rider, so a statue got gold stars circling its
    // head. A statue is inert; nothing orbits it. Stone is stone, everywhere.
    const orbits = [];
    if (has("petrified")) {
      // no orbits — the stone stands alone
    } else {
      if (has("stunned"))            orbits.push({ n: 3, period: 1500, mk: () => ConditionVisuals._star(Math.max(5, w * 0.075), 0xf2c14e) });
      else if (has("incapacitated")) orbits.push({ n: 2, period: 2600, mk: () => ConditionVisuals._star(Math.max(5, w * 0.075), 0xf2c14e) });
      if (has("unconscious"))        orbits.push({ n: 3, period: 3000, mk: () => ConditionVisuals._zGlyph(h) });
      if (has("prone"))              orbits.push({ n: 3, period: 2200, mk: () => ConditionVisuals._downArrow(Math.max(6, w * 0.085)) });
    }

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

        // ── THE CINCH — the body gives where the chains bite ──
        // Welded to the token's own mesh, so it can never drift out of
        // register with the art. Suppressed under petrified (stone doesn't
        // squeeze) by the apply itself.
        ConditionVisuals._applyRestrainPinch(token);
        if (token._aceRestrainPinch) {
          const base  = RESTRAIN_PINCH_AMOUNT;
          const phase = Math.random() * RESTRAIN_PULSE_MS;   // tokens don't breathe in lockstep
          anims.push((now) => {
            // Look the filter up EVERY frame, never capture it: refreshToken
            // re-welds a NEW instance when Foundry rebuilds the mesh, and a
            // captured reference would keep animating the discarded one while
            // the live cinch sat frozen.
            const pf = token._aceRestrainPinch;
            if (!pf) return;
            const t = ((now + phase) % RESTRAIN_PULSE_MS) / RESTRAIN_PULSE_MS;
            // Smooth in and out — a strain, not a throb.
            const s = 0.5 - 0.5 * Math.cos(t * Math.PI * 2);
            try { pf.uniforms.uAmount = base * (1 + RESTRAIN_PULSE_DEPTH * (s - 0.5) * 2); } catch (_) {}
          });
        }
      }
      if (has("grappled") && !has("restrained")) {
        const rows = await ConditionVisuals._bodyExtents(token);
        if (cont.destroyed) return;
        // The extent rows are fractions of the TEXTURE, so they scale by the
        // art's drawn box — scaling them by the grid square puts the grip band
        // off the body on any art that doesn't fill its square.
        ConditionVisuals._wrap(body, rows, bw, bh, 0.5, {
          sag: bh * 0.03,
          thickness: Math.max(6, bh * 0.08),
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
          // Follow the ART, not the requested angle — see _syncStoneTransforms.
          const _rot = Number.isFinite(tok.mesh?.rotation)
            ? tok.mesh.rotation
            : ((tok.document?.rotation ?? 0) * Math.PI) / 180;
          if (e.body) e.body.rotation = _rot;
          if (tok._aceStoneBackdisc) tok._aceStoneBackdisc.rotation = _rot;
          if (tok._aceStoneGranite)  tok._aceStoneGranite.rotation  = _rot;
          for (const fn of e.anims) fn(now);
        } catch (_) { /* per-token guard — one bad token never stops the loop */ }
      }
      ConditionVisuals._rafHandle = requestAnimationFrame(step);
    };
    ConditionVisuals._rafHandle = requestAnimationFrame(step);
  }
}
