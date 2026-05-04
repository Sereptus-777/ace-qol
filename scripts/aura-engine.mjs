// ─── ACE: QOL — Aura Engine ──────────────────────────────────────────────────
// Self-maintaining D&D 5e aura emission system. Replaces the third-party
// ActiveAuras module which is broken in dnd5e 5.x (throws on update cycle).
//
// What it does:
//   - At ready-time + on every token movement, recomputes who's inside every
//     aura source's emission radius
//   - Applies a tagged Active Effect to tokens entering range
//   - Removes the tagged Active Effect from tokens leaving range
//   - Source-actor's own aura applies to themselves (RAW)
//   - Suppresses when the source is incapacitated/unconscious
//
// Aura catalog includes paladin's class auras (Protection, Warding, Courage,
// Devotion, Crown, Hate, Vengeance, Conquest, Redemption, Sentinel) and
// generic feature-name detection via the SOURCE_FEATURE_NAME match. Easy to
// extend — add an entry to AURAS at the top.
//
// Range:
//   - Paladin Aura of Protection: 10ft → 30ft at L18
//   - Most other paladin auras same range pattern
//   - Override per-aura via `range(level)` function
//
// ARCHITECTURE
//   Each aura definition:
//     {
//       id, sourceFeatureName, sourceClass, minLevel, range(level),
//       appliesTo: "allies" | "enemies" | "all" | "self",
//       suppressedBy: ["incapacitated", "unconscious", ...],
//       icon, effectChanges: (sourceActor) => Array<change>,
//       includesSource: bool — does the source itself benefit?
//     }
//
// PERFORMANCE
//   Token movement triggers a localized recompute (just affected tokens, not
//   the whole scene). Full scene rescan only happens on canvasReady or
//   manual refresh.
//
// API
//   game.aceQol.AuraEngine                — class
//   game.aceQol.AuraEngine.recomputeAll() — force full rescan
//   game.aceQol.recomputeAuras()          — shortcut
// ──────────────────────────────────────────────────────────────────────────────

import { MODULE_ID } from "./ace-qol.mjs";
import { QolSettings } from "./settings.mjs";

// Hardcoded literal — TDZ-safe (see stealth-engine.mjs comment)
const FLAG_NS = "ace-qol";
const FLAG_AURA_APPLIED = "auraApplied"; // set on the Active Effect we add

// Marker prefix for our managed effect names, so we can identify+remove them
// without cleaning up unrelated effects with similar names.
const EFFECT_NAME_PREFIX = "";  // we keep the natural name; flag distinguishes

// ── Aura Catalog ────────────────────────────────────────────────────────────
// Keys are RAW aura class features. Add entries to extend.
const AURAS = [
  {
    id: "aura-of-protection",
    sourceFeatureName: "Aura of Protection",
    sourceClass: "paladin",
    minLevel: 6,
    range: (lvl) => lvl >= 18 ? 30 : 10,
    appliesTo: "allies",
    suppressedBy: ["incapacitated", "unconscious"],
    includesSource: true,
    icon: "icons/svg/aura.svg", // verified-exists on hosted Foundry; yellow-glow-rays 404s
    description: "Bonus to saving throws equal to source's CHA mod (PHB)",
    effectChanges: (sourceActor) => {
      // The save bonus is calculated dynamically at save-roll time by
      // combat-state._getAuraOfProtectionBonus. We don't need to put a
      // numeric change here — the marker effect is enough so the panel
      // shows it and so other systems can detect "is in aura range".
      return [];
    },
    markerFlags: { isAuraOfProtection: true },
  },
  {
    id: "aura-of-warding",
    sourceFeatureName: "Aura of Warding",
    sourceClass: "paladin",
    minLevel: 7,
    range: (lvl) => lvl >= 18 ? 30 : 10,
    appliesTo: "allies",
    suppressedBy: ["incapacitated", "unconscious"],
    includesSource: true,
    icon: "icons/svg/shield.svg",
    description: "Resistance to spell damage (Oath of Devotion / Ancients PHB)",
    effectChanges: () => [],
    markerFlags: { isAuraOfWarding: true },
  },
  {
    id: "aura-of-courage",
    sourceFeatureName: "Aura of Courage",
    sourceClass: "paladin",
    minLevel: 10,
    range: (lvl) => lvl >= 18 ? 30 : 10,
    appliesTo: "allies",
    suppressedBy: ["incapacitated", "unconscious"],
    includesSource: true,
    icon: "icons/svg/regen.svg",
    description: "Immune to the frightened condition (PHB)",
    effectChanges: () => [
      // Add condition immunity (frightened)
      // dnd5e 5.x: system.traits.ci is a Set; we add via mode 2 (ADD)
      { key: "system.traits.ci.value", mode: 2, value: "frightened", priority: 100 },
    ],
    markerFlags: { isAuraOfCourage: true },
  },
  {
    id: "aura-of-hate",
    sourceFeatureName: "Aura of Hate",
    sourceClass: "paladin",
    minLevel: 7,
    range: (lvl) => lvl >= 18 ? 30 : 10,
    appliesTo: "allies", // RAW: paladin + fiends/undead within 10ft, but for our table we apply to allies
    suppressedBy: ["incapacitated", "unconscious"],
    includesSource: true,
    icon: "icons/svg/skull.svg",
    description: "Bonus to melee weapon damage equal to source's CHA mod (Oathbreaker DMG)",
    effectChanges: () => [],
    markerFlags: { isAuraOfHate: true },
  },
  {
    id: "aura-of-the-guardian",
    sourceFeatureName: "Aura of the Guardian",
    sourceClass: "paladin",
    minLevel: 7,
    range: (lvl) => lvl >= 18 ? 30 : 10,
    appliesTo: "allies",
    suppressedBy: ["incapacitated", "unconscious"],
    includesSource: false, // self can't transfer damage to self
    icon: "icons/svg/shield.svg",
    description: "Use reaction to take damage in place of nearby ally (Oath of Redemption Xanathar's)",
    effectChanges: () => [],
    markerFlags: { isAuraOfTheGuardian: true },
  },
];

const TURN_OFF_STATUS_KEYS = new Set(["incapacitated", "unconscious", "stunned", "paralyzed", "petrified"]);

export class AuraEngine {

  static init() {
    // Full recompute when canvas is ready (handles initial load + scene change)
    Hooks.on("canvasReady", () => {
      try {
        if (QolSettings.get?.("auraEngineEnabled") === false) return;
        AuraVisualLayer.attach(); // visual ring renderer (all clients)
        if (!game.user.isGM) return;
        AuraEngine.recomputeAll();
      } catch (err) { console.warn(`${MODULE_ID} | AuraEngine canvasReady threw:`, err); }
    });

    // Token moved → recompute the aura state of EVERY token (cheap; we only
    // touch differences). A token's movement can affect:
    //   - The token itself (entering/leaving someone else's aura)
    //   - Every other token if the moving token is an aura source
    Hooks.on("updateToken", (tokenDoc, changes) => {
      try {
        if (QolSettings.get?.("auraEngineEnabled") === false) return;
        const moved = changes.x !== undefined || changes.y !== undefined;
        if (!moved) return;
        // Visual layer refreshes on every client (so everyone sees the rings)
        AuraVisualLayer.refresh();
        // Effect-application is GM-only
        if (!game.user.isGM) return;
        // Defer slightly to let the actual position update commit
        setTimeout(() => AuraEngine.recomputeAll().catch(err =>
          console.warn(`${MODULE_ID} | AuraEngine recompute after move threw:`, err)
        ), 50);
      } catch (err) { /* non-fatal */ }
    });

    // Token created or deleted → recompute
    Hooks.on("createToken", () => AuraEngine._scheduleRecompute());
    Hooks.on("deleteToken", () => AuraEngine._scheduleRecompute());

    // Actor stats / conditions changed (e.g., paladin became unconscious)
    Hooks.on("updateActor", (actor, changes) => {
      try {
        if (!game.user.isGM) return;
        if (QolSettings.get?.("auraEngineEnabled") === false) return;
        // Watch for HP changes that might trigger unconscious/dead
        const hpChanged = foundry.utils.getProperty(changes, "system.attributes.hp.value") !== undefined;
        if (hpChanged) AuraEngine._scheduleRecompute();
      } catch (_) { /* non-fatal */ }
    });

    // Status effects added/removed (incapacitated etc.) — but ONLY for non-aura
    // effects. Our own aura creates/deletes would recursively trigger recompute
    // (infinite loop, duplicate effect explosion).
    const _onEffectChange = (effect) => {
      try {
        // Skip if it's one of OUR aura marker effects — we created it, we
        // don't need to recompute because of it
        if (effect?.flags?.[FLAG_NS]?.[FLAG_AURA_APPLIED] === true) return;
        AuraEngine._scheduleRecompute();
      } catch (_) { /* non-fatal */ }
    };
    Hooks.on("createActiveEffect", _onEffectChange);
    Hooks.on("deleteActiveEffect", _onEffectChange);
    Hooks.on("updateActiveEffect", _onEffectChange);

    console.log(`${MODULE_ID} | AuraEngine online — managing ${AURAS.length} aura types`);
  }

  /** Debounced trigger to avoid recomputing 10x in one tick */
  static _scheduleRecompute() {
    if (!game.user.isGM) return;
    if (QolSettings.get?.("auraEngineEnabled") === false) return;
    if (this._pendingRecompute) return;
    this._pendingRecompute = true;
    setTimeout(() => {
      this._pendingRecompute = false;
      AuraEngine.recomputeAll().catch(err =>
        console.warn(`${MODULE_ID} | AuraEngine recompute (scheduled) threw:`, err)
      );
    }, 80);
  }

  /**
   * Full scene rescan: for every aura source, find all tokens in range and
   * apply the marker effect. For every existing marker effect, if the
   * source is no longer in range OR no longer eligible, remove it.
   *
   * Re-entry guard prevents concurrent runs from racing each other and
   * creating duplicate effects.
   */
  static async recomputeAll() {
    if (this._running) {
      // Another recompute is already in flight — schedule a follow-up so we
      // catch the latest state but don't run concurrently.
      this._scheduleRecompute();
      return;
    }
    this._running = true;
    try {
      await AuraEngine._recomputeAllInner();
    } finally {
      this._running = false;
    }
  }

  static async _recomputeAllInner() {
    if (!canvas?.scene) return;
    const tokens = canvas.tokens?.placeables ?? [];
    if (!tokens.length) return;

    // 1. Identify all aura sources (one per (token, aura) pair)
    /** @type {Array<{token, aura, level, rangeFt, suppressed}>} */
    const sources = [];
    for (const t of tokens) {
      if (!t.actor) continue;
      for (const aura of AURAS) {
        // Class + level check
        const classItem = t.actor.items?.find(i => i.type === "class"
          && i.name?.toLowerCase().includes(aura.sourceClass.toLowerCase()));
        const level = Number(classItem?.system?.levels ?? 0);
        if (level < aura.minLevel) continue;
        // Feature presence check
        const hasFeat = t.actor.items?.some(i => i.type === "feat"
          && i.name?.toLowerCase().includes(aura.sourceFeatureName.toLowerCase()));
        if (!hasFeat) continue;
        // Suppressed?
        const statuses = t.actor.statuses ?? new Set();
        const suppressed = (aura.suppressedBy ?? []).some(s => statuses.has(s));
        sources.push({
          token: t,
          aura,
          level,
          rangeFt: aura.range(level),
          suppressed,
        });
      }
    }

    if (!sources.length) {
      // No aura sources on canvas — clean up any orphaned aura effects
      await AuraEngine._cleanupOrphanedAuras(tokens, []);
      return;
    }

    // 2. For each token, determine which auras SHOULD be on it
    /** @type {Map<tokenId, Map<auraId, sourceTokenId>>} */
    const shouldHave = new Map();
    for (const t of tokens) {
      if (!t.actor) continue;
      const myMap = new Map();
      for (const src of sources) {
        if (src.suppressed) continue; // source is incapacitated etc.
        // Self?
        if (t.id === src.token.id) {
          if (src.aura.includesSource) myMap.set(src.aura.id, src.token.id);
          continue;
        }
        // Disposition check
        if (src.aura.appliesTo === "allies"
            && t.document.disposition !== src.token.document.disposition) continue;
        if (src.aura.appliesTo === "enemies"
            && t.document.disposition === src.token.document.disposition) continue;
        // Distance check
        const dist = AuraEngine._tokenDistanceFt(t, src.token);
        if (dist > src.rangeFt) continue;
        myMap.set(src.aura.id, src.token.id);
      }
      shouldHave.set(t.id, myMap);
    }

    // 3. Apply diffs: for each token, compute add/remove
    //
    // DEDUP FIX: previous version used Map<auraId, effect> which collapsed
    // duplicates to a single entry — so if the actor already had 3 Aura of
    // Protection effects, the remove loop only saw 1 of them and the other
    // 2 stayed forever. Plus our own create/delete events recursively
    // triggered recomputes, exploding duplicates each pass.
    //
    // This version: iterate ALL marker effects per actor, dedupe by
    // (auraId, sourceTokenId) tuple. Keep ONE matching effect per target;
    // delete every duplicate AND every effect that doesn't match target.
    let appliedCount = 0;
    let removedCount = 0;
    for (const t of tokens) {
      if (!t.actor) continue;
      const target = shouldHave.get(t.id) ?? new Map();
      const currentEffects = (t.actor.effects?.contents ?? []).filter(e =>
        e?.flags?.[FLAG_NS]?.[FLAG_AURA_APPLIED] === true
      );

      // Bucket existing effects by (auraId, sourceTokenId) tuple
      /** @type {Map<string, Array<ActiveEffect>>} */
      const buckets = new Map();
      for (const eff of currentEffects) {
        const aId = eff.flags?.[FLAG_NS]?.auraId;
        const sId = eff.flags?.[FLAG_NS]?.auraSourceTokenId;
        if (!aId) continue;
        const key = `${aId}::${sId ?? "none"}`;
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key).push(eff);
      }

      // Determine what each bucket SHOULD do
      // For each target (auraId, sourceTokenId), keep ONE effect; delete extras
      const toDelete = [];
      const targetKeys = new Set();
      for (const [auraId, sourceTokenId] of target) {
        const key = `${auraId}::${sourceTokenId}`;
        targetKeys.add(key);
        const bucket = buckets.get(key) ?? [];
        if (bucket.length > 1) {
          // Keep first, delete rest
          for (let i = 1; i < bucket.length; i++) toDelete.push(bucket[i].id);
        }
      }

      // Any bucket NOT in targetKeys → delete entirely
      for (const [key, bucket] of buckets) {
        if (targetKeys.has(key)) continue;
        for (const eff of bucket) toDelete.push(eff.id);
      }

      // Execute deletes (single batch per actor)
      if (toDelete.length) {
        try {
          await t.actor.deleteEmbeddedDocuments("ActiveEffect", toDelete);
          removedCount += toDelete.length;
        } catch (err) {
          // "Does not exist" is benign — Foundry may have already cleaned via
          // cascade. Suppress that, log other errors.
          if (!/does not exist/i.test(String(err?.message ?? err))) {
            console.warn(`${MODULE_ID} | AuraEngine: bulk delete failed for ${t.actor.name}:`, err);
          }
        }
      }

      // Add effects for targets that have NO existing effect (bucket was empty)
      for (const [auraId, sourceTokenId] of target) {
        const key = `${auraId}::${sourceTokenId}`;
        const bucket = buckets.get(key);
        if (bucket && bucket.length > 0) continue; // already had at least one (we kept first, deleted rest)
        const aura = AURAS.find(a => a.id === auraId);
        if (!aura) continue;
        const sourceToken = tokens.find(tt => tt.id === sourceTokenId);
        if (!sourceToken) continue;
        const sourceLevel = Number(sourceToken.actor.items?.find(i =>
          i.type === "class" && i.name?.toLowerCase().includes(aura.sourceClass.toLowerCase())
        )?.system?.levels ?? 0);
        try {
          await AuraEngine._applyAura(t.actor, aura, sourceToken.actor, sourceTokenId, sourceLevel);
          appliedCount++;
        } catch (err) {
          console.warn(`${MODULE_ID} | AuraEngine: failed to apply ${aura.id} to ${t.actor.name}:`, err);
        }
      }
    }

    // 4. Final cleanup pass: any aura effects whose source token no longer exists
    await AuraEngine._cleanupOrphanedAuras(tokens, sources);

    // 5. Refresh the visual layer (rings around source tokens)
    try { AuraVisualLayer.refresh(); } catch (_) { /* non-fatal */ }

    if (QolSettings.get?.("debugMode") || appliedCount + removedCount > 0) {
      console.log(`${MODULE_ID} | AuraEngine: ${sources.length} source(s), +${appliedCount} applied / -${removedCount} removed`);
    }
  }

  /**
   * Returns the active aura sources (for the visual layer).
   * Used by AuraVisualLayer to draw the rings.
   */
  static getActiveSources() {
    if (!canvas?.scene) return [];
    const tokens = canvas.tokens?.placeables ?? [];
    const sources = [];
    for (const t of tokens) {
      if (!t.actor) continue;
      for (const aura of AURAS) {
        const classItem = t.actor.items?.find(i => i.type === "class"
          && i.name?.toLowerCase().includes(aura.sourceClass.toLowerCase()));
        const level = Number(classItem?.system?.levels ?? 0);
        if (level < aura.minLevel) continue;
        const hasFeat = t.actor.items?.some(i => i.type === "feat"
          && i.name?.toLowerCase().includes(aura.sourceFeatureName.toLowerCase()));
        if (!hasFeat) continue;
        const statuses = t.actor.statuses ?? new Set();
        const suppressed = (aura.suppressedBy ?? []).some(s => statuses.has(s));
        if (suppressed) continue;
        sources.push({
          token: t,
          aura,
          level,
          rangeFt: aura.range(level),
        });
      }
    }
    return sources;
  }

  /**
   * Apply an aura's marker effect to a target actor.
   */
  static async _applyAura(targetActor, aura, sourceActor, sourceTokenId, sourceLevel) {
    const effData = {
      name: aura.sourceFeatureName,
      icon: aura.icon,
      img:  aura.icon,
      origin: sourceActor.uuid,
      changes: aura.effectChanges?.(sourceActor) ?? [],
      transfer: false,
      flags: {
        [FLAG_NS]: {
          [FLAG_AURA_APPLIED]: true,
          auraId: aura.id,
          auraSourceActorId: sourceActor.id,
          auraSourceTokenId: sourceTokenId,
          auraSourceLevel:   sourceLevel,
          stamp: Date.now(),
          ...(aura.markerFlags ?? {}),
        },
      },
    };
    await targetActor.createEmbeddedDocuments("ActiveEffect", [effData]);
  }

  /**
   * Remove any "auraApplied" effects whose source token no longer exists OR
   * whose source actor doesn't have the feature anymore.
   */
  static async _cleanupOrphanedAuras(tokens, sources) {
    const validSourceTokenIds = new Set(sources.map(s => s.token.id));
    for (const t of tokens) {
      if (!t.actor) continue;
      const orphans = (t.actor.effects?.contents ?? []).filter(e => {
        if (e?.flags?.[FLAG_NS]?.[FLAG_AURA_APPLIED] !== true) return false;
        const srcId = e.flags?.[FLAG_NS]?.auraSourceTokenId;
        return !srcId || !validSourceTokenIds.has(srcId);
      });
      if (orphans.length) {
        try {
          await t.actor.deleteEmbeddedDocuments("ActiveEffect", orphans.map(o => o.id));
        } catch (err) {
          console.warn(`${MODULE_ID} | AuraEngine: orphan cleanup failed for ${t.actor.name}:`, err);
        }
      }
    }
  }

  /**
   * Distance in feet between two tokens — EDGE-TO-EDGE.
   *
   * D&D 5e RAW PHB 192: "When determining whether you are within range
   * of a target, measure to the nearest part of its space."
   *
   * For aura "within 10 feet of you" checks, this means the minimum
   * distance from any part of the source's space to any part of the
   * target's space. Two adjacent tokens have edge distance 0; two tokens
   * separated by one empty grid cell have edge distance 5ft; etc.
   *
   * Implemented as rectangle-to-rectangle distance:
   *   - If the rectangles overlap or touch: 0
   *   - Otherwise: sqrt(dx^2 + dy^2) where dx/dy are the gap distances
   *
   * Replaces the previous center-to-center calc which was too strict —
   * a target whose body visually overlapped the aura ring could still
   * test as "out of range" because their center was past the ring edge.
   */
  static _tokenDistanceFt(a, b) {
    const grid = canvas.scene?.grid?.size ?? 100;
    const ftPer = canvas.scene?.grid?.distance ?? 5;
    const aw = (a.document?.width  ?? 1) * grid;
    const ah = (a.document?.height ?? 1) * grid;
    const bw = (b.document?.width  ?? 1) * grid;
    const bh = (b.document?.height ?? 1) * grid;
    const ax1 = a.x ?? 0, ay1 = a.y ?? 0;
    const ax2 = ax1 + aw, ay2 = ay1 + ah;
    const bx1 = b.x ?? 0, by1 = b.y ?? 0;
    const bx2 = bx1 + bw, by2 = by1 + bh;
    // Gap between rectangles in each axis (0 if overlapping/touching)
    const dx = Math.max(0, Math.max(bx1 - ax2, ax1 - bx2));
    const dy = Math.max(0, Math.max(by1 - ay2, ay1 - by2));
    return Math.hypot(dx, dy) / grid * ftPer;
  }

  /**
   * One-shot manual cleanup: remove ALL effects flagged with our auraApplied
   * marker AND any "Aura of *" effects that came from ActiveAuras (different
   * flag pattern). Useful when transitioning from ActiveAuras to our engine
   * to clear stale entries.
   */
  static async cleanAllAndRebuild() {
    if (!game.user.isGM) return;
    const tokens = canvas.tokens?.placeables ?? [];
    let removed = 0;
    for (const t of tokens) {
      if (!t.actor) continue;
      // Remove our own
      const ours = (t.actor.effects?.contents ?? []).filter(e =>
        e?.flags?.[FLAG_NS]?.[FLAG_AURA_APPLIED] === true
      );
      // Remove ActiveAuras' (their flag namespace is ActiveAuras / dae auraeffects)
      const aaEffects = (t.actor.effects?.contents ?? []).filter(e => {
        const f = e?.flags ?? {};
        return f.ActiveAuras || f.auraeffects
            || (f.dae?.transfer === false && /aura of /i.test(e.name ?? ""));
      });
      const all = [...new Set([...ours.map(e => e.id), ...aaEffects.map(e => e.id)])];
      if (all.length) {
        try {
          await t.actor.deleteEmbeddedDocuments("ActiveEffect", all);
          removed += all.length;
        } catch (err) {
          console.warn(`${MODULE_ID} | AuraEngine: cleanAllAndRebuild failed for ${t.actor.name}:`, err);
        }
      }
    }
    console.log(`${MODULE_ID} | AuraEngine: removed ${removed} stale aura effect(s); rebuilding...`);
    await AuraEngine.recomputeAll();
    AuraVisualLayer.refresh();
    ui.notifications?.info(`Aura cleanup: removed ${removed} stale effect(s); rebuilt from scratch.`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  AuraVisualLayer — PIXI ring renderer for source tokens
// ═══════════════════════════════════════════════════════════════════════════════
//
// Independent of Automated Animations / Sequencer. Draws a translucent
// circle at each aura source's position with the configured range. Color-
// coded per aura type. Updates on token movement, creation, deletion, and
// engine recomputes.
//
// Why custom: AA's Sequencer-based aura visuals leave orphaned animations
// when active effects are deleted, spam the console with "use Sequencer
// Effect Manager" warnings, and don't update reliably on token movement.
// PIXI Graphics is direct, fast, and we control the lifecycle.
//
// All clients render the same rings (the data is just the active aura
// sources on canvas). No socket needed.
// ═══════════════════════════════════════════════════════════════════════════════

const AURA_RING_COLORS = {
  "aura-of-protection":    0xffd700,  // gold
  "aura-of-warding":       0x4488ff,  // blue
  "aura-of-courage":       0xffaa00,  // amber
  "aura-of-hate":          0xaa00aa,  // purple
  "aura-of-the-guardian":  0x00aaff,  // cyan
};

export class AuraVisualLayer {
  /** PIXI.Container holding all aura ring graphics */
  static container = null;

  /**
   * Returns true if our PIXI ring renderer should be active.
   * Auto-disables when Automated Animations is active (it draws its own
   * particle swirls for aura effects). User can override via setting.
   */
  static _shouldRender() {
    const mode = QolSettings.get?.("auraVisualMode") ?? "auto";
    if (mode === "off")   return false;
    if (mode === "rings") return true;
    // "auto": render rings only if AA is NOT active
    return !game.modules?.get?.("autoanimations")?.active;
  }

  /**
   * Attach the aura ring container to the canvas. Idempotent.
   */
  static attach() {
    if (!canvas?.tokens) return;
    if (!this._shouldRender()) {
      this.detach();
      return;
    }
    if (this.container && !this.container.destroyed) {
      this.refresh();
      return;
    }
    try {
      this.container = new PIXI.Container();
      this.container.name = "ace-qol-aura-rings";
      this.container.eventMode = "none"; // pass clicks through
      this.container.zIndex = -1; // below tokens
      // Insert at index 0 so it's BELOW token sprites (under their feet)
      canvas.tokens.addChildAt(this.container, 0);
      this.refresh();
      console.log(`${MODULE_ID} | AuraVisualLayer attached to canvas.tokens`);
    } catch (err) {
      console.warn(`${MODULE_ID} | AuraVisualLayer attach failed:`, err);
    }
  }

  /**
   * Re-draw all aura rings from scratch. Cheap (Graphics is GPU-accelerated).
   * Auto-noops if rendering is disabled (e.g., AA is active and mode=auto).
   */
  static refresh() {
    if (!this._shouldRender()) {
      this.detach();
      return;
    }
    if (!this.container || this.container.destroyed) {
      this.attach();
      return;
    }
    // Clear existing graphics
    this.container.removeChildren().forEach(c => c.destroy?.());

    if (!canvas.scene) return;

    const sources = AuraEngine.getActiveSources();
    const grid = canvas.scene.grid?.size ?? 100;
    const ftPer = canvas.scene.grid?.distance ?? 5;

    for (const src of sources) {
      const t = src.token;
      const tw = (t.document?.width  ?? 1) * grid;
      const th = (t.document?.height ?? 1) * grid;
      const cx = (t.x ?? 0) + tw / 2;
      const cy = (t.y ?? 0) + th / 2;

      // Ring radius extends from the source's EDGE, matching RAW edge-to-edge
      // measurement. So a Medium source (5ft) with 10ft aura draws at:
      //   ringRadiusPx = (10ft + 2.5ft halfSourceSize) px-converted
      // = 12.5ft from center = 250px on a 100px/5ft grid.
      // Result: any target whose body overlaps the ring is in range, matching
      // the visual to the engine's edge-to-edge distance check exactly.
      const sourceHalfFt = (Math.max(tw, th) / grid * ftPer) / 2;
      const visualRadiusFt = src.rangeFt + sourceHalfFt;
      const radiusPx = (visualRadiusFt / ftPer) * grid;
      const color = AURA_RING_COLORS[src.aura.id] ?? 0xffffff;

      const g = new PIXI.Graphics();
      // Outer ring (thicker, opaque)
      g.lineStyle({ width: 3, color, alpha: 0.7, alignment: 0 });
      g.drawCircle(cx, cy, radiusPx);
      // Inner glow (filled, very translucent)
      g.beginFill(color, 0.08);
      g.drawCircle(cx, cy, radiusPx);
      g.endFill();
      // Inner ring (subtle, slightly inside)
      g.lineStyle({ width: 1.5, color, alpha: 0.4, alignment: 0 });
      g.drawCircle(cx, cy, radiusPx - 4);

      this.container.addChild(g);
    }
  }

  /**
   * Detach + cleanup (called on canvas tear-down or module disable).
   */
  static detach() {
    if (this.container && !this.container.destroyed) {
      this.container.removeChildren().forEach(c => c.destroy?.());
      this.container.parent?.removeChild(this.container);
      this.container.destroy();
      this.container = null;
    }
  }
}

// ── Hook the visual layer into Foundry's render lifecycle ───────────────────
// canvasReady is the primary attach point (handled in AuraEngine.init).
// We also refresh on token sheet updates that might change aura status.
Hooks.on("createToken", () => AuraVisualLayer.refresh());
Hooks.on("deleteToken", () => AuraVisualLayer.refresh());
Hooks.on("updateActor", () => AuraVisualLayer.refresh());
Hooks.on("createActiveEffect", (effect) => {
  // Status effect added (e.g., paladin became unconscious) — re-evaluate
  if (!effect?.flags?.["ace-qol"]?.auraApplied) AuraVisualLayer.refresh();
});
Hooks.on("deleteActiveEffect", (effect) => {
  if (!effect?.flags?.["ace-qol"]?.auraApplied) AuraVisualLayer.refresh();
});
