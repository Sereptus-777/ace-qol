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
//   - Paladin Aura of Protection: 10 feet → 30 feet at L18
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
import { aceDistanceFt } from "./geometry-utils.mjs";

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
    appliesTo: "allies", // RAW: paladin + fiends/undead within 10 feet, but for our table we apply to allies
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

  /**
   * Does this engine actually drive the named item?
   *
   * ⚠️ EXISTS SO A NO-OP CANNOT LIE. TemplateResolver.runAura did nothing
   * and said "handled by aura-engine". For Spirit Guardians that was false:
   * this engine knows five PALADIN CLASS FEATURES and no spells at all, so the
   * cast fell through three layers and resolved nowhere.
   *
   * A hand-off has to be answerable by the receiver, or it is just a hope
   * written in a comment.
   */
  static knowsAura(item) {
    try {
      const name = String(item?.name ?? "").toLowerCase().trim();
      if (!name) return false;
      return AURAS.some(a => name.includes(String(a.sourceFeatureName ?? "").toLowerCase()));
    } catch (_) { return false; }
  }

  static init() {
    // ⚠️🔴 canvasReady HAS ALREADY FIRED BY THE TIME THIS RUNS.
    //
    // AuraEngine.init() is called from ace-qol.mjs's own `ready` handler, and
    // Foundry fires `canvasReady` during startup - before we get here. So this
    // listener was waiting for an event already in the past: the ring layer
    // never attached, `recomputeAll` never ran, and nothing threw or logged.
    // The rings only appeared if the GM happened to change scene.
    //
    // Johnny, 2026-08-27: "I'm still not getting the animation that I liked."
    // His diagnostic said it plainly - paladin 9, feature present, engine
    // enabled, mode "rings", and "ring container: NOT ON CANVAS".
    //
    // ⚠️ THIS IS THE 2026-08-12 BUG WITH A DIFFERENT EVENT NAME. That one
    // was `Hooks.once("ready")` registered from inside `ready` and it cost
    // thirteen surviving condition ghosts. The rule is not about `ready`; it
    // is about ANY lifecycle event that may already have happened: run it now
    // if the world is already in that state, and subscribe for next time.
    const start = () => {
      try {
        if (QolSettings.get?.("auraEngineEnabled") === false) return;
        AuraVisualLayer.attach(); // visual ring renderer (all clients)
        if (game.users?.activeGM !== game.user) return;  // activeGM: recomputeAll applies effects — must only fire once
        AuraEngine.recomputeAll();
      } catch (err) { console.warn(`${MODULE_ID} | AuraEngine canvasReady threw:`, err); }
    };

    // Every future scene change...
    Hooks.on("canvasReady", start);
    // ⚠️🔴 THE CATCH-UP DRAWS ONLY. IT MUST NOT RECOMPUTE.
    //
    // The first version of this called the whole `start()` immediately and
    // BROKE HIS GAME. recomputeAll treats "I found no aura sources" as
    // "delete every aura effect on the board", and at this point in boot a
    // token's `.actor` may not be hydrated yet: no actors read, no sources
    // found, every aura marker stripped off every creature. Johnny, minutes
    // after that shipped: "none of my tokens are concentrating or have the
    // aura... that list is gone."
    //
    // Attaching the ring layer is pure drawing and cannot damage data, so
    // the catch-up does that and only that. The effect recompute stays on
    // the real canvasReady, where the world is genuinely loaded.
    //
    // ⚠️ A FIX FOR A SILENT-NO-OP MUST NOT BECOME A SILENT DELETE. The
    // original bug was a listener registered too late; the cure was running
    // the same work too EARLY, which was worse - it destroyed data instead
    // of failing to draw.
    if (canvas?.ready) {
      try {
        if (QolSettings.get?.("auraEngineEnabled") !== false) AuraVisualLayer.attach();
      } catch (err) { console.warn(`${MODULE_ID} | aura ring catch-up failed:`, err); }
    }

    // ── The halo has to appear the moment the effect lands ───────────────
    //
    // ⚠️ MOVEMENT WAS THE ONLY TRIGGER, AND IT IS THE WRONG ONE FOR THIS. The
    // rings redraw when a token moves, which was enough when the only thing
    // drawn was a circle round a stationary paladin. The per-creature halo is
    // drawn from the APPLIED EFFECT, so the event that changes it is the effect
    // being created or deleted - and that happens on the GM's client while
    // everyone else's screen still shows the old picture.
    //
    // ⚠️ These fire on EVERY client, which is the point. The effect write is
    // still activeGM-only; only the drawing is universal.
    for (const hook of ["createActiveEffect", "deleteActiveEffect"]) {
      Hooks.on(hook, (effect) => {
        try {
          if (QolSettings.get?.("auraEngineEnabled") === false) return;
          if (!effect?.flags?.[FLAG_NS]?.[FLAG_AURA_APPLIED]) return;
          AuraVisualLayer.refresh();
        } catch (err) {
          console.warn(`${MODULE_ID} | aura halo refresh failed on ${hook}:`, err);
        }
      });
    }

    // An aura effect being switched off is a creature no longer protected.
    Hooks.on("updateActiveEffect", (effect, changes) => {
      try {
        if (changes?.disabled === undefined) return;
        if (!effect?.flags?.[FLAG_NS]?.[FLAG_AURA_APPLIED]) return;
        AuraVisualLayer.refresh();
      } catch (err) {
        console.warn(`${MODULE_ID} | aura halo refresh failed on updateActiveEffect:`, err);
      }
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
        // Effect-application is activeGM-only (prevent duplicate effect writes with 2 GMs)
        if (game.users?.activeGM !== game.user) return;
        // Coalesce rapid drag-moves through the shared 80ms debounce instead of
        // queuing a full recompute per move-commit (a fast drag across many squares
        // fired one recompute each). The debounce also covers the commit defer. (perf 2026-06-25)
        AuraEngine._scheduleRecompute();
      } catch (err) { /* non-fatal */ }
    });

    // Token created or deleted → recompute
    Hooks.on("createToken", () => AuraEngine._scheduleRecompute());
    Hooks.on("deleteToken", () => AuraEngine._scheduleRecompute());

    // Actor stats / conditions changed (e.g., paladin became unconscious)
    Hooks.on("updateActor", (actor, changes) => {
      try {
        if (game.users?.activeGM !== game.user) return;  // activeGM: scheduleRecompute must only run once
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

    console.debug(`${MODULE_ID} | AuraEngine online — managing ${AURAS.length} aura types`);
  }

  /** Debounced trigger to avoid recomputing 10x in one tick */
  static _scheduleRecompute() {
    if (game.users?.activeGM !== game.user) return;  // activeGM: covers createToken/deleteToken + effect hooks
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
      // ⚠️🔴 "I FOUND NO SOURCES" IS NOT "THERE ARE NO SOURCES".
      //
      // The line below deletes every aura effect on the board, so it must
      // only run when we were genuinely able to LOOK. During boot, or mid
      // scene-swap, a placeable can exist with `.actor` still null - and
      // reading zero actors then produces zero sources, which strips the
      // auras off an entire party. Same shape as a wall test answering "no
      // wall" because it threw.
      const readable = tokens.filter(t => t.actor).length;
      if (!readable) {
        console.warn(`${MODULE_ID} | AuraEngine: ${tokens.length} token(s) on this scene `
          + `and NONE has a readable actor yet, so whether anyone projects an aura cannot `
          + `be determined. Leaving every existing aura effect alone rather than deleting.`);
        return;
      }
      // Genuinely nobody projects an aura - clean up the leftovers.
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
   * Distance in feet between two tokens — nearest-edge, size-aware, 3D, via the
   * suite's canonical helper (geometry-utils). Grid-counted the 5e-default way:
   * two ADJACENT creatures are 5 feet apart, one empty cell between = 10 feet, etc.
   * So "within 10 feet" correctly includes adjacent + one-cell-away, per RAW.
   *
   * (Previously a raw edge-GAP — adjacent counted as 0 — which made every aura
   * reach one ring too far. Now identical to the ruler and to attack/reach math.)
   */
  static _tokenDistanceFt(a, b) {
    return aceDistanceFt(a, b);
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

    // ⚠️🔴 "AUTO" USED TO MEAN "AA IS INSTALLED, SO IT IS AA'S JOB".
    // That is a hand-off, and a hand-off must check that somebody caught it.
    //
    // Johnny, 2026-08-27: "figure out why I don't see an animation for Aura of
    // Protection... I used to see those animations." His world had
    // auraVisualMode "auto" and Automated Animations active - so ACE stood
    // down - while AA's own `aaAutorec-aura` list was EMPTY. Two systems, each
    // correctly assuming the other had it, and no ring on the board.
    //
    // Nothing was broken in either module. The aura entries had been lost from
    // AA's config at some point, and ACE had no way to notice it was deferring
    // to nobody.
    //
    // ⚠️ SO ASK WHETHER AA ACTUALLY HAS AURA AUTOMATIONS, not merely
    // whether AA exists. If its aura list is empty, drawing our own rings is
    // strictly better than drawing nothing, and it says so once.
    const aa = game.modules?.get?.("autoanimations");
    if (!aa?.active) return true;               // AA absent -> we draw

    let aaHasAuras = null;                      // null = could not tell
    try {
      const raw = game.settings.get("autoanimations", "aaAutorec-aura");
      const list = typeof raw === "string" ? JSON.parse(raw) : raw;
      aaHasAuras = Array.isArray(list) ? list.length > 0 : null;
    } catch (_) {
      // ⚠️ "COULD NOT READ IT" IS NOT "IT IS EMPTY". A future AA that
      // renames or removes this setting must not make ACE start drawing rings
      // over AA's own, so an unknown answer defers exactly as before.
      aaHasAuras = null;
    }

    if (aaHasAuras === false) {
      if (!AuraEngine._warnedAaEmpty) {
        AuraEngine._warnedAaEmpty = true;
        console.warn(`${MODULE_ID} | Automated Animations is active but its aura list `
          + `is empty, so nothing was drawing aura rings at all. ACE is drawing its own. `
          + `Set "Aura Visual Style" to Off if you would rather have none.`);
      }
      return true;
    }

    return false;   // AA is active and has auras configured - its job
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

    // ⚠️ TWO AURAS AT THE SAME RADIUS DRAW ON TOP OF EACH OTHER. Firaxis is
    // an Oath of the Ancients paladin 9, so Protection (gold) and Warding (blue)
    // are BOTH 10 feet - identical circles, and whichever draws second wins.
    // Johnny saw "that plain blue circle" and reasonably concluded Protection
    // was not working. It was; it was underneath.
    const ringsPerToken = new Map();

    for (const src of sources) {
      const t = src.token;
      const tw = (t.document?.width  ?? 1) * grid;
      const th = (t.document?.height ?? 1) * grid;
      const cx = (t.x ?? 0) + tw / 2;
      const cy = (t.y ?? 0) + th / 2;

      // Ring radius extends from the source's EDGE, matching RAW edge-to-edge
      // measurement. So a Medium source (5 feet) with 10 feet aura draws at:
      //   ringRadiusPx = (10ft + 2.5ft halfSourceSize) px-converted
      // = 12.5ft from center = 250px on a 100px/5ft grid.
      // Result: any target whose body overlaps the ring is in range, matching
      // the visual to the engine's edge-to-edge distance check exactly.
      const sourceHalfFt = (Math.max(tw, th) / grid * ftPer) / 2;
      const visualRadiusFt = src.rangeFt + sourceHalfFt;
      // Each additional aura on the same creature steps inward a little so every
      // one of them is visible. The engine still measures the true radius; only
      // the drawing is nudged.
      const nth = ringsPerToken.get(t.id) ?? 0;
      ringsPerToken.set(t.id, nth + 1);
      const radiusPx = ((visualRadiusFt / ftPer) * grid) - (nth * Math.max(6, grid * 0.06));
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

    // ── The people it is actually protecting ────────────────────────────────
    //
    // ⚠️🔴 A RING ROUND THE PALADIN SHOWS RANGE. IT DOES NOT SHOW THAT ANYONE IS
    // PROTECTED. Johnny, 2026-09-01:
    //
    //   "each person that came within 10 feet of the paladin suddenly got a
    //    little glowing aura around them, the same as the one the paladin had...
    //    I'm not sure that aura works. It probably does, but I liked the little
    //    bit of an animation when they step near the paladin, so that they knew
    //    the aura of protection was protecting them."
    //
    // That was Automated Animations' own aura visual, and his AA aura list is
    // EMPTY — the entries were lost from his config. On 2026-08-27 I made ACE
    // draw a source ring when AA has nothing, which put something on the board
    // and answered the wrong question.
    //
    // ⚠️ THIS IS DRAWN FROM THE APPLIED EFFECT, NOT FROM THE DISTANCE. That is
    // the whole point: it is evidence the effect actually landed. A creature
    // standing well inside the ring with no glow means the aura engine has not
    // caught up, and that is exactly the bug worth seeing rather than assuming
    // away. Three aura bugs this fortnight were invisible for want of this.
    try {
      const sourceIds = new Set(sources.map(s => s.token?.id).filter(Boolean));
      for (const t of (canvas.tokens?.placeables ?? [])) {
        if (!t.actor || sourceIds.has(t.id)) continue;   // the source has its ring

        // ⚠️ ONE HALO PER AURA, NOT PER CREATURE. This used to `break` after
        // the first one, so somebody standing in both Protection and Warding got
        // a single halo in whichever colour happened to come first - arbitrary,
        // and it hid the fact that two different things were protecting them.
        let nth = 0;
        for (const eff of (t.actor.effects ?? [])) {
          const f = eff.flags?.[FLAG_NS];
          if (!f?.[FLAG_AURA_APPLIED]) continue;
          if (eff.disabled) continue;                    // switched off is not protected

          const colour = AURA_RING_COLORS[f.auraId] ?? 0xffffff;
          const tw = (t.document?.width  ?? 1) * grid;
          const th = (t.document?.height ?? 1) * grid;
          const cx = (t.x ?? 0) + tw / 2;
          const cy = (t.y ?? 0) + th / 2;
          // ⚠️🔴 THIS LAYER SITS *UNDER* THE TOKEN SPRITES, ON PURPOSE. The
          // container is added at index 0 with zIndex -1 so the big source ring
          // reads as light on the floor rather than a hoop over the art.
          //
          // The first version of this halo used `half the token + 4px`, which is
          // the token's own footprint — so it drew flawlessly and was covered
          // completely by the creature standing on it. Johnny reloaded and saw
          // "that plain blue circle and that's it."
          //
          // It has to extend past the sprite to exist at all. A quarter of a
          // grid cell of glow shows on the floor around their feet at any token
          // size and on any grid scale, which is what he described seeing before.
          const r = (Math.max(tw, th) / 2) + (grid * 0.28) + (nth * Math.max(4, grid * 0.05));
          nth++;

          const halo = new PIXI.Graphics();
          // Soft pool of light, brightest at the rim where it clears the sprite.
          halo.beginFill(colour, 0.16);
          halo.drawCircle(cx, cy, r);
          halo.endFill();
          halo.lineStyle({ width: 3, color: colour, alpha: 0.85, alignment: 0 });
          halo.drawCircle(cx, cy, r);
          halo.lineStyle({ width: 1.5, color: colour, alpha: 0.4, alignment: 0 });
          halo.drawCircle(cx, cy, r + Math.max(3, grid * 0.05));
          this.container.addChild(halo);
        }
      }
    } catch (err) {
      // ⚠️ Never let the halo take the source rings down with it.
      console.warn(`${MODULE_ID} | could not draw the protected-creature halos:`, err);
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
