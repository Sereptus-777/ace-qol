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

        // ⚠️🔴 THE RULES ARE SCHEDULED BEFORE THE DRAWING, AND THE DRAWING
        // CANNOT STOP THEM. This is why Virric kept losing his aura.
        //
        // This block used to call `AuraVisualLayer.refresh()` FIRST, inside the
        // same try, and then schedule the recompute. When refresh threw - and
        // it can, it talks to Sequencer, the EffectManager and three settings -
        // the catch below swallowed it and `_scheduleRecompute` was never
        // reached. Silently. On some moves and not others, depending on what
        // Sequencer was doing at that instant.
        //
        // His log, 2026-09-02: he moved Virric to 10 feet at 07:28:34 and no
        // recompute ran for the next 4.6 seconds, while a forced one on the same
        // board went from 6 aura effects to 8. The engine was never wrong. It
        // was never asked.
        //
        // Same shape as the 2026-08-09 lesson one level down: a flat run of
        // statements in one try is a chain of fuses, and the first one that
        // blows takes everything after it.
        if (game.users?.activeGM === game.user) {
          try { AuraEngine._scheduleRecompute(); }
          catch (err) { console.warn(`${MODULE_ID} | could not schedule an aura recompute:`, err); }
        }

        // Now the drawing, in its own try, where a failure costs a frame and
        // nothing else. Every client redraws so everyone sees the rings.
        try { AuraVisualLayer.refresh(); }
        catch (err) { console.warn(`${MODULE_ID} | aura redraw failed (rules unaffected):`, err); }
        // (The 80ms debounce inside _scheduleRecompute still coalesces a fast
        // drag across many squares into one recompute — see that method.)
      } catch (err) {
        // ⚠️ NOT SILENT ANY MORE. This catch used to swallow whatever went wrong
        // and move on, which is exactly how a redraw failure turned into a lost
        // recompute nobody could see.
        console.warn(`${MODULE_ID} | the aura movement handler threw:`, err);
      }
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

        // ⚠️🔴 RECORD THE POSITION THIS DECISION WAS MADE FROM.
        // On 2026-09-02 the engine removed Virric's auras on the move that put
        // him at 10 feet - the correct answer for the 15 feet he had just left.
        // The trigger was fixed by then and fired on every move, so the only
        // remaining explanation is that the recompute measured a position the
        // token no longer occupied. Reading `document.x` was supposed to settle
        // that and did not.
        //
        // Guessing has cost days. This records the exact numbers the decision
        // used, so the next report is a fact instead of another theory. Kept on
        // the object, not logged, so it costs nothing until something changes.
        AuraEngine._lastRead ??= new Map();
        AuraEngine._lastRead.set(`${t.id}:${src.aura.id}`, {
          token: t.name,
          readX: t.document?.x, readY: t.document?.y,
          drawnX: t.x, drawnY: t.y,
          srcX: src.token.document?.x, srcY: src.token.document?.y,
          dist, range: src.rangeFt, verdict: dist <= src.rangeFt,
        });

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
      // ⚠️ WHEN THE ANSWER CHANGED, SAY WHAT IT WAS MEASURED FROM. A summary
      // that reports only the outcome cannot distinguish "decided correctly" from
      // "decided correctly about the wrong position", and that distinction has
      // been the whole difficulty here.
      try {
        for (const [, r] of (AuraEngine._lastRead ?? new Map())) {
          const stale = (r.readX !== r.drawnX) || (r.readY !== r.drawnY);
          console.log(`${MODULE_ID} |    ${r.token}: measured ${r.dist} ft against a `
            + `${r.range} ft aura -> ${r.verdict ? "inside" : "outside"}`
            + `  [read x=${r.readX} y=${r.readY}`
            + (stale ? `, but the SPRITE is at x=${r.drawnX} y=${r.drawnY}` : "")
            + `, source at x=${r.srcX} y=${r.srcY}]`);
        }
      } catch (_) { /* reporting must never break the recompute */ }
    }
    AuraEngine._lastRead = new Map();
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
//  AuraVisualLayer — JB2A aura animations, played through Sequencer
// ═══════════════════════════════════════════════════════════════════════════════
//
// A spinning JB2A token border on every creature actually carrying an aura
// effect, and a JB2A aura circle showing each source's reach.
//
// ⚠️🔴 THIS HEADER USED TO ARGUE FOR DRAWING THEM BY HAND, and the argument was
// wrong on the only points that mattered. It said PIXI was chosen because "AA's
// Sequencer-based aura visuals leave orphaned animations when active effects are
// deleted... and don't update reliably on token movement". The orphan problem is
// solved by naming every effect and ending it by name. The movement problem does
// not exist: `attachTo` makes Sequencer carry the effect with the token, which
// is most of what the hand-rolled container existed to do.
//
// What drawn circles cannot do is look like anything. Johnny, 2026-09-01:
// "That is just drawn circles. That is not the animation that I had before. If
// you're drawing them, quit fucking drawing them."
//
// ⚠️ THE ACTING GM PLACES THEM, EVERYONE SEES THEM. A persistent Sequencer
// effect is broadcast, so one created per client would put one copy on the board
// per connected user. That is the opposite of the old PIXI layer, where every
// client had to draw its own.
// ═══════════════════════════════════════════════════════════════════════════════

// ⚠️ JB2A SHIPS A FIXED PALETTE AND GOLD IS NOT IN IT. The token borders come
// in blue, green, orange and purple; the aura circles in bluepurple, green,
// orangepurple and yellow. Aura of Protection reads as gold in the rules and is
// mapped to the warmest thing that exists rather than silently failing to a
// colour nobody chose.
const AURA_BORDER_TINT = {
  "aura-of-protection":   "orange",
  "aura-of-warding":      "blue",
  "aura-of-courage":      "orange",
  "aura-of-hate":         "purple",
  "aura-of-the-guardian": "blue",
};

// Every effect this layer places is named with this prefix so it can find and
// end exactly its own, and never somebody else's.
const EFFECT_PREFIX = "ace-qol-aura:";


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
   * Bring the scene's aura animations up to date. Idempotent.
   *
   * ⚠️ THERE IS NO CANVAS CONTAINER ANY MORE. This used to build a PIXI
   * layer and draw circles into it. Sequencer owns the effects now, attaches
   * them to the tokens itself, and moves them when the tokens move - which is
   * most of what the old container existed to do by hand.
   */
  static attach() {
    if (!canvas?.tokens) return;
    if (!this._shouldRender()) { this.detach(); return; }
    this.refresh();
  }

  /**
   * Re-draw all aura rings from scratch. Cheap (Graphics is GPU-accelerated).
   * Auto-noops if rendering is disabled (e.g., AA is active and mode=auto).
   */
  /**
   * ⚠️🔴 DRAWN CIRCLES ARE NOT ANIMATIONS, AND HE HAS SAID SO TWICE.
   * Johnny, 2026-09-01, looking at a board full of flat PIXI discs:
   *
   *   "That is just drawn circles. That is not the animation that I had before.
   *    If you're drawing them, quit fucking drawing them. This is what we use
   *    Automated Animations for, or JB2A... I want the animation, the circle,
   *    slight, whatever."
   *
   * He is right, and the PIXI layer was never the answer — it was a stopgap I
   * shipped on 2026-08-27 when ACE and Automated Animations were each deferring
   * to the other and nothing appeared at all. A stopgap that stays becomes the
   * product.
   *
   * This now plays real JB2A assets through Sequencer:
   *   per creature  jb2a.token_border.circle.spinning.<colour>  — the little
   *                 turning ring around anyone actually carrying the effect
   *
   * The source gets the same ring as everybody else and nothing more — Aura of
   * Protection includes its own caster, so the paladin is simply one of the
   * covered. A separate range circle on top of that buried him in particles.
   *
   * ⚠️ DIFFED, NEVER REDRAWN. The old code cleared and rebuilt every graphic on
   * every token move. Doing that with animations would restart each one several
   * times a second and look like a strobe. Only what changed is touched.
   *
   * ⚠️ ONE CLIENT CREATES THEM. Sequencer broadcasts a persistent effect to
   * everybody, so if every client created its own the board would carry one copy
   * per connected user. The activeGM places them; everyone sees them.
   */
  static refresh() {
    if (!this._shouldRender()) { this.detach(); return; }
    if (typeof Sequence === "undefined" || !globalThis.Sequencer?.EffectManager) {
      // ⚠️ Say it rather than fall back to drawing. Silently reverting to PIXI
      // discs is how the stopgap became the product in the first place.
      console.warn(`${MODULE_ID} | Sequencer is not available, so aura animations `
        + `cannot play. No rings will be drawn.`);
      return;
    }
    // Only the acting GM writes effects; every client sees them.
    if (game.users?.activeGM !== game.user) return;
    if (!canvas?.scene) return;

    try {
      const wanted = new Map();   // effect name -> {token, path, scale, colour}

      // ── No reach circle ─────────────────────────────────────────
      //
      // ⚠️ THE SOURCE GETS THE SAME RING AS EVERYBODY ELSE, NOTHING MORE.
      // Johnny, 2026-09-01: "Why is Firaxis spewing out a bunch of, I don't know
      // what aura that is? I don't want that. I just want his order the same as
      // the other auras... the blue one with the floaty things around it. That's
      // a good aura. Leave that alone."
      //
      // The big `template_circle.aura` I put on each source was a range
      // indicator, and it buried the paladin under particles. The per-creature
      // ring already carries the information that matters - who is covered - and
      // Aura of Protection includes its own caster, so Firaxis gets a ring from
      // the loop below like everyone else.
      //
      // ⚠️ Range is still visible on demand: hovering the aura in the effects
      // panel shows the feet, and the engine measures it edge to edge regardless
      // of what is drawn.

      // ── The people actually carrying the effect ──────────────────────────
      //
      // ⚠️ DRIVEN BY THE APPLIED EFFECT, NOT BY DISTANCE. That is the whole
      // point of the per-creature ring: it is evidence the aura landed. Somebody
      // standing inside the reach with no ring means the engine has not caught
      // up, which is a bug worth seeing rather than papering over.
      for (const t of (canvas.tokens?.placeables ?? [])) {
        if (!t.actor) continue;
        for (const eff of (t.actor.effects ?? [])) {
          const f = eff.flags?.[FLAG_NS];
          if (!f?.[FLAG_AURA_APPLIED] || eff.disabled) continue;

          const tint = AURA_BORDER_TINT[f.auraId] ?? "blue";
          const path = AuraVisualLayer._resolve([
            `jb2a.token_border.circle.spinning.${tint}.001`,
            `jb2a.token_border.circle.spinning.blue.001`,
            `jb2a.token_border.circle.static.${tint}.001`,
          ]);
          if (!path) continue;

          // ⚠️ TWO AURAS ON ONE CREATURE MUST LOOK LIKE TWO. Firaxis carries
          // Protection AND Warding; both rings were scaled identically, so they
          // sat exactly on top of each other and read as one. Each additional
          // one steps outward a little.
          const nth = (wanted._perToken ??= new Map()).get(t.id) ?? 0;
          wanted._perToken.set(t.id, nth + 1);
          wanted.set(`${EFFECT_PREFIX}on:${t.id}:${f.auraId}`, {
            token: t, path, scale: 1.05 + (nth * 0.16), opacity: 0.9, fadeIn: 400,
          });
        }
      }

      // ── Diff against what is already playing ─────────────────────────────
      const live = new Set();
      try {
        for (const e of (Sequencer.EffectManager.getEffects({ name: `${EFFECT_PREFIX}*` }) ?? [])) {
          const n = e?.data?.name ?? e?.name;
          if (n) live.add(n);
        }
      } catch (err) {
        console.warn(`${MODULE_ID} | could not read the running aura effects:`, err);
      }

      for (const name of live) {
        if (wanted.has(name)) continue;
        try { Sequencer.EffectManager.endEffects({ name }); }
        catch (err) { console.warn(`${MODULE_ID} | could not end "${name}":`, err); }
      }

      for (const [name, spec] of wanted) {
        if (live.has(name)) continue;                   // already turning
        try {
          const seq = new Sequence();
          const e = seq.effect()
            .file(spec.path)
            .attachTo(spec.token, { bindAlpha: false })
            .persist()
            .name(name)
            .opacity(spec.opacity ?? 0.85)
            .fadeIn(spec.fadeIn ?? 300)
            .fadeOut(300)
            // ⚠️ UNDER THE ART, ALWAYS. Sequencer puts effects ABOVE tokens by
            // default, which drew the ring across the creature's face. Johnny:
            // "it's drawing it right over top of his token. I don't want that
            // shit." The old hand-drawn layer got this right by sitting at
            // index 0 with a negative zIndex; the Sequencer version has to ask
            // for the same thing explicitly.
            .belowTokens()
            .zIndex(0);
          // A reach ring is sized in pixels; a token ring scales to its wearer.
          if (spec.sizePx) e.size(spec.sizePx);
          else e.scaleToObject(spec.scale ?? 1.05);
          seq.play().catch(err =>
            console.warn(`${MODULE_ID} | aura animation "${name}" failed to play:`, err));
        } catch (err) {
          console.warn(`${MODULE_ID} | could not start the aura animation "${name}":`, err);
        }
      }
    } catch (err) {
      console.warn(`${MODULE_ID} | the aura visual refresh failed:`, err);
    }
  }

  /** First of these paths this JB2A install actually contains. */
  static _resolve(candidates) {
    for (const c of candidates) {
      try { if (Sequencer?.Database?.entryExists?.(c)) return c; } catch (_) { /* next */ }
    }
    // ⚠️ Named, not silent: a missing asset and a disabled engine must not look
    // the same in the console.
    console.warn(`${MODULE_ID} | none of these aura assets are in this JB2A `
      + `install, so nothing will show: ${candidates.join(", ")}`);
    return null;
  }

  /**
   * Detach + cleanup (called on canvas tear-down or module disable).
   */
  static detach() {
    // ⚠️ A PERSISTENT SEQUENCER EFFECT OUTLIVES A RELOAD. It is stored on the
    // scene, so an aura left running when the engine is switched off would still
    // be turning tomorrow with nothing left to remove it. Ending them by name
    // touches only the ones this layer placed.
    try {
      Sequencer?.EffectManager?.endEffects?.({ name: `${EFFECT_PREFIX}*` });
    } catch (err) {
      console.warn(`${MODULE_ID} | could not end the aura animations:`, err);
    }
    // Legacy: destroy the old drawn-circle container if a previous version left
    // one on the canvas. Harmless when there is none.
    if (this.container && !this.container.destroyed) {
      this.container.removeChildren().forEach(c => c.destroy?.());
      this.container.parent?.removeChild(this.container);
      this.container.destroy();
    }
    this.container = null;
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
