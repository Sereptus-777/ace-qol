// ============================================================================
//  ACE QOL — Sound Engine
//
//  Optional sound layer powered by BLFX (Boss Loot FX) via Sequencer.
//  Self-discovers every `blfx.sound.*` path at startup, caches by category,
//  and auto-plays sounds when ace-qol fires its key events:
//
//    • Spell cast        → on dnd5e.postCreateUsageMessage  (item.type === "spell")
//    • Damage impact     → on createChatMessage             (flags.ace-qol.type === "damageResult")
//
//  Both BLFX and Sequencer are OPTIONAL — if either is missing or no
//  `blfx.sound.*` entries are registered, every call no-ops silently. No
//  warnings, no errors, no console spam. The rest of ace-qol is unaffected.
//
//  Two settings control this layer:
//    • soundEffectsEnabled (world, default true)  — master on/off
//    • soundEffectsVolume  (client, default 60)   — per-user 0–100 slider
// ============================================================================

const MODULE_ID = "ace-qol";
const TAG       = `${MODULE_ID} | Sound`;

const BLFX_SOUND_PREFIX = "blfx.sound.";

export class SoundEngine {
  /** @type {Map<string, string[]>|null}  category → list of full paths */
  static _cache = null;
  static _initialized = false;
  static _hooksRegistered = false;

  // ──────────────────────────────────────────────────────────────────────────
  //  Lifecycle
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Initialize the sound engine. Safe to call at Foundry `ready`; no-ops if
   * Sequencer is missing or no BLFX sound entries are registered. Idempotent.
   */
  static init() {
    if (this._initialized) return;
    this._initialized = true;

    if (!this._sequencerAvailable()) {
      console.log(`${TAG} | Sequencer not installed — sound layer dormant.`);
      return;
    }

    this._buildCache();

    const total = this._cacheTotal();
    if (total === 0) {
      console.log(`${TAG} | No BLFX sound entries found in Sequencer DB — sound layer dormant.`);
      return;
    }

    this._registerHooks();
    console.log(`${TAG} | Online — ${total} sounds cached across ${this._cache.size} categories (${[...this._cache.keys()].join(", ")}).`);
  }

  // ──────────────────────────────────────────────────────────────────────────
  //  Cache (self-discover BLFX sound paths)
  // ──────────────────────────────────────────────────────────────────────────

  static _sequencerAvailable() {
    return typeof Sequencer === "object" && Sequencer !== null && !!Sequencer.Database;
  }

  static _buildCache() {
    this._cache = new Map();
    if (!this._sequencerAvailable()) return;

    const flat = Sequencer.Database.publicFlattenedEntries;
    let entries = [];
    if (flat instanceof Set)                            entries = [...flat];
    else if (flat instanceof Map)                       entries = [...flat.keys()];
    else if (Array.isArray(flat))                       entries = flat.slice();
    else if (flat && typeof flat === "object")          entries = Object.keys(flat);

    for (const path of entries) {
      if (typeof path !== "string") continue;
      if (!path.startsWith(BLFX_SOUND_PREFIX)) continue;
      const remainder = path.slice(BLFX_SOUND_PREFIX.length);
      const category  = remainder.split(".")[0];
      if (!category) continue;
      let list = this._cache.get(category);
      if (!list) { list = []; this._cache.set(category, list); }
      list.push(path);
    }
  }

  static _cacheTotal() {
    if (!this._cache) return 0;
    let n = 0;
    for (const list of this._cache.values()) n += list.length;
    return n;
  }

  // ──────────────────────────────────────────────────────────────────────────
  //  Settings access
  // ──────────────────────────────────────────────────────────────────────────

  static isEnabled() {
    try { return game.settings.get(MODULE_ID, "soundEffectsEnabled") !== false; }
    catch (_) { return true; }
  }

  /** Returns 0..1 multiplier from the 0..100 user setting. */
  static getVolume() {
    try {
      const raw = Number(game.settings.get(MODULE_ID, "soundEffectsVolume"));
      const v = Number.isFinite(raw) ? raw : 60;
      return Math.max(0, Math.min(100, v)) / 100;
    } catch (_) { return 0.6; }
  }

  // ──────────────────────────────────────────────────────────────────────────
  //  Lookup + play primitives
  // ──────────────────────────────────────────────────────────────────────────

  /** Escape a string for use inside a regex. */
  static _escapeRe(str) {
    return String(str ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  /**
   * Find the best-match sound path inside a BLFX sound category.
   * Keywords are tried in order; first match wins. Falls back to a random
   * path within the category if none match (so we always play *something*
   * relevant rather than nothing).
   */
  static _findSound(category, keywords = []) {
    if (!this._cache) return null;
    const pool = this._cache.get(category);
    if (!pool || !pool.length) return null;

    for (const kw of keywords) {
      if (!kw) continue;
      const re = new RegExp(this._escapeRe(kw), "i");
      const match = pool.find(p => re.test(p));
      if (match) return match;
    }
    return pool[Math.floor(Math.random() * pool.length)];
  }

  /** Internal play helper — no-ops silently on any error or missing dep. */
  static _play(path, volumeScale = 1) {
    if (!path) return;
    if (!this.isEnabled()) return;
    if (!this._sequencerAvailable()) return;
    try {
      if (!Sequencer.Database.entryExists(path)) return;
    } catch (_) { return; }

    try {
      new Sequence()
        .sound()
          .file(path)
          .volume(this.getVolume() * volumeScale)
        .play();
    } catch (err) {
      // Last-resort warn: something is broken about Sequencer, not about our
      // call. We swallow but log so a determined GM can diagnose.
      console.warn(`${TAG} | playback failed for ${path}:`, err);
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  //  Public API
  // ──────────────────────────────────────────────────────────────────────────

  /** Weapon impact sound matched to the damage type (slashing, fire, etc.). */
  static playWeaponHit(damageType) {
    const path = this._findSound("weapon", [damageType]);
    this._play(path, 0.95);
  }

  /** Spell-cast WHOOSH — fires when a spell's description card hits chat. */
  static playSpellCast(spellName) {
    const path = this._findSound("spell", ["cast", spellName]);
    this._play(path, 0.85);
  }

  /** Spell-impact BOOM — fires when a spell's damage card hits chat. */
  static playSpellImpact(damageType, spellName) {
    const path = this._findSound("spell", ["impact", damageType, spellName]);
    this._play(path, 0.95);
  }

  /** Condition-applied chime — fires when an ace-qol condition lands. */
  static playConditionApplied(condition) {
    // BLFX's condition visuals live in `condition.*`, but audio sits in
    // `sound.misc` (the BLFX folks bucket effect SFX under misc). Try both.
    const path = this._findSound("misc", [condition, "effect"])
              ?? this._findSound("condition", [condition]);
    this._play(path, 0.6);
  }

  // ──────────────────────────────────────────────────────────────────────────
  //  Hook bindings (auto-trigger sounds on ace-qol pipeline events)
  // ──────────────────────────────────────────────────────────────────────────

  static _registerHooks() {
    if (this._hooksRegistered) return;
    this._hooksRegistered = true;

    // Spell cast — fires once per cast, on every client. Each client plays
    // locally. Gated to spells (weapons get the impact sound via the damage
    // card hook below — no double-trigger).
    Hooks.on("dnd5e.postCreateUsageMessage", (activity, _message) => {
      try {
        if (!this.isEnabled()) return;
        const item = activity?.item;
        if (!item || item.type !== "spell") return;
        this.playSpellCast(item.name);
      } catch (err) {
        console.warn(`${TAG} | spell-cast hook failed:`, err);
      }
    });

    // Damage impact — `createChatMessage` (not `renderChatMessage`) so this
    // fires exactly once per damage card per client, regardless of re-renders
    // when the message gets updated (rider refunds, etc.).
    Hooks.on("createChatMessage", (message) => {
      try {
        if (!this.isEnabled()) return;
        const flags = message?.flags?.[MODULE_ID];
        if (flags?.type !== "damageResult") return;

        // Pull dominant damage type from the first result's first component.
        const firstResult     = Array.isArray(flags.damageResults) ? flags.damageResults[0] : null;
        const firstComponent  = firstResult?.components?.[0];
        const dominantType    = firstComponent?.type ?? "bludgeoning";

        // Decide spell vs weapon via item type lookup (sync — already cached).
        let isSpell = false;
        let spellName = null;
        try {
          if (flags.itemUuid) {
            const item = fromUuidSync(flags.itemUuid);
            if (item) {
              isSpell   = item.type === "spell";
              spellName = item.name;
            }
          }
        } catch (_) { /* deleted item — fall through to weapon sound */ }

        if (isSpell) this.playSpellImpact(dominantType, spellName);
        else         this.playWeaponHit(dominantType);
      } catch (err) {
        console.warn(`${TAG} | damage-card hook failed:`, err);
      }
    });
  }
}
