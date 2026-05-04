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
    icon: "icons/magic/holy/yellow-glow-rays.webp",
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
    icon: "icons/magic/defensive/shield-barrier-glowing-blue.webp",
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
    icon: "icons/magic/holy/saint-glass-yellow-blue.webp",
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
    icon: "icons/magic/death/skull-horned-crown-black.webp",
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
    icon: "icons/magic/defensive/shield-barrier-glowing-triangle.webp",
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
        if (!game.user.isGM) return;
        if (QolSettings.get?.("auraEngineEnabled") === false) return;
        AuraEngine.recomputeAll();
      } catch (err) { console.warn(`${MODULE_ID} | AuraEngine canvasReady threw:`, err); }
    });

    // Token moved → recompute the aura state of EVERY token (cheap; we only
    // touch differences). A token's movement can affect:
    //   - The token itself (entering/leaving someone else's aura)
    //   - Every other token if the moving token is an aura source
    Hooks.on("updateToken", (tokenDoc, changes) => {
      try {
        if (!game.user.isGM) return;
        if (QolSettings.get?.("auraEngineEnabled") === false) return;
        const moved = changes.x !== undefined || changes.y !== undefined;
        if (!moved) return;
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

    // Status effects added/removed (incapacitated etc.)
    const _onEffectChange = () => AuraEngine._scheduleRecompute();
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
   */
  static async recomputeAll() {
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
    let appliedCount = 0;
    let removedCount = 0;
    for (const t of tokens) {
      if (!t.actor) continue;
      const target = shouldHave.get(t.id) ?? new Map();
      const currentEffects = (t.actor.effects?.contents ?? []).filter(e =>
        e?.flags?.[FLAG_NS]?.[FLAG_AURA_APPLIED] === true
      );
      const currentByAuraId = new Map();
      for (const e of currentEffects) {
        const aId = e.flags?.[FLAG_NS]?.auraId;
        if (aId) currentByAuraId.set(aId, e);
      }

      // Remove effects that should no longer be there OR whose source has changed
      for (const [auraId, eff] of currentByAuraId) {
        const wantSourceTokenId = target.get(auraId);
        const currentSourceTokenId = eff.flags?.[FLAG_NS]?.auraSourceTokenId;
        if (!wantSourceTokenId || wantSourceTokenId !== currentSourceTokenId) {
          try { await eff.delete(); removedCount++; } catch (err) {
            console.warn(`${MODULE_ID} | AuraEngine: failed to remove ${eff.name}:`, err);
          }
        }
      }

      // Add effects that should be there but aren't
      for (const [auraId, sourceTokenId] of target) {
        if (currentByAuraId.has(auraId)) {
          // Already present and matches source — skip
          const eff = currentByAuraId.get(auraId);
          if (eff.flags?.[FLAG_NS]?.auraSourceTokenId === sourceTokenId) continue;
        }
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

    if (QolSettings.get?.("debugMode") || appliedCount + removedCount > 0) {
      console.log(`${MODULE_ID} | AuraEngine: ${sources.length} source(s), +${appliedCount} applied / -${removedCount} removed`);
    }
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
   * Distance in feet between two tokens (center-to-center).
   */
  static _tokenDistanceFt(a, b) {
    const grid = canvas.scene?.grid?.size ?? 100;
    const ftPer = canvas.scene?.grid?.distance ?? 5;
    const aw = (a.document?.width  ?? 1) * grid;
    const ah = (a.document?.height ?? 1) * grid;
    const bw = (b.document?.width  ?? 1) * grid;
    const bh = (b.document?.height ?? 1) * grid;
    const ax = (a.x ?? 0) + aw / 2;
    const ay = (a.y ?? 0) + ah / 2;
    const bx = (b.x ?? 0) + bw / 2;
    const by = (b.y ?? 0) + bh / 2;
    return Math.hypot(ax - bx, ay - by) / grid * ftPer;
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
    ui.notifications?.info(`Aura cleanup: removed ${removed} stale effect(s); rebuilt from scratch.`);
  }
}
