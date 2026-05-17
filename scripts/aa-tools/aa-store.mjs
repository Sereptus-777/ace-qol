// ============================================================
// ACE QOL — AutoAnimations Autorec Helpers
//
// AA 6.x stores its records SPLIT across multiple settings, one per
// category (melee, range, ontoken, templatefx, aefx, aura, preset).
// The legacy single-setting `aaAutorec` is deprecated.
//
// This store reads/writes the per-category settings transparently.
// Calling code asks for a record by spell name; we search across all
// categories. Calling code saves fields; we write to the correct
// category (or create a new templatefx record if no existing one).
// ============================================================

const AA_MODULE = "autoanimations";

/** AA's data is split across these per-category world settings. */
const AA_CATEGORIES = ["aefx", "aura", "melee", "preset", "range", "ontoken", "templatefx"];

export class AAStore {

  /** Whether the AutoAnimations module is installed and active. */
  static isInstalled() {
    return !!game.modules.get(AA_MODULE)?.active;
  }

  /**
   * Read all records from all categories and merge into a single object
   * shaped like the legacy `aaAutorec` setting:
   *   { melee: {...}, range: {...}, templatefx: {...}, ... }
   * Most calling code expects this shape — keeping it for compatibility.
   */
  static getAll() {
    if (!AAStore.isInstalled()) return null;
    const out = {};
    for (const cat of AA_CATEGORIES) {
      try { out[cat] = game.settings.get(AA_MODULE, `aaAutorec-${cat}`) ?? {}; }
      catch (_) { out[cat] = {}; }
    }
    return out;
  }

  /** Get the records for ONE category. */
  static getCategory(category) {
    if (!AAStore.isInstalled()) return {};
    try { return game.settings.get(AA_MODULE, `aaAutorec-${category}`) ?? {}; }
    catch (_) { return {}; }
  }

  /** Save records for ONE category. */
  static async saveCategory(category, updated) {
    if (!AAStore.isInstalled()) return false;
    if (!AA_CATEGORIES.includes(category)) {
      console.warn(`[ace-qol/AAStore] unknown category: ${category}`);
      return false;
    }
    try {
      await game.settings.set(AA_MODULE, `aaAutorec-${category}`, updated);
      return true;
    } catch (err) {
      console.error(`[ace-qol/AAStore] saveCategory(${category}) failed:`, err);
      return false;
    }
  }

  /**
   * Find a record whose label matches the given spell name.
   * Case-insensitive. Strips bracket prefixes like "[ACE-OFF] ".
   * Searches every category since AA splits by category.
   *
   * @returns {{category:string, recId:string, record:object} | null}
   */
  static findRecord(spellName) {
    if (!AAStore.isInstalled()) return null;
    const target = String(spellName ?? "").toLowerCase().trim();
    if (!target) return null;
    for (const cat of AA_CATEGORIES) {
      const records = AAStore.getCategory(cat);
      for (const [recId, rec] of Object.entries(records)) {
        const label = String(rec?.label ?? "").toLowerCase().trim()
          .replace(/^\[[^\]]*\]\s*/, "");
        if (label === target) return { category: cat, recId, record: rec };
      }
    }
    return null;
  }

  /**
   * Extract editable fields from a record. Returns sensible defaults if
   * the record is null or missing keys. Handles BOTH structures:
   *
   * - Simple categories (melee/range/templatefx/aefx/aura/ontoken):
   *     record.animation.primary.video.* + record.animation.primary.options.*
   *
   * - Preset category (multi-phase like Fireball, Eldritch Blast):
   *     record.data.{projectile,explosion,beam,...}.{customPath,animation,color,variant,options}
   *   For these, we read from the "main visible effect" — usually `explosion`
   *   for proToTemp types, `projectile` for proTo* types, etc.
   */
  static getEditableFields(record) {
    if (!record) return AAStore._emptyFields();

    // Preset category — multi-phase animations
    if (record.menu === "preset" && record.data && typeof record.data === "object") {
      // Pick the "main" block — explosion (template impact) takes priority,
      // then projectile (the beam/missile), then any other block we recognize.
      const block = record.data.explosion
                 ?? record.data.projectile
                 ?? record.data.beam
                 ?? record.data.primary
                 ?? Object.values(record.data).find(b => b && typeof b === "object" && (b.animation || b.customPath));
      if (block) return AAStore._fieldsFromBlock(block);
    }

    // Simple categories — animation.primary.video shape
    const primary = record.animation?.primary;
    if (primary) return AAStore._fieldsFromBlock(primary.video, primary);

    return AAStore._emptyFields();
  }

  /** Empty field defaults — same shape as a populated record. */
  static _emptyFields() {
    return {
      customPath: "", presetName: "", menuType: "",
      currentRef: "", color: "", variant: "",
      scale: 1.0, opacity: 1.0, belowTokens: false,
    };
  }

  /**
   * Read fields out of one "animation block" — either a preset sub-block
   * (record.data.explosion / data.projectile) or a primary.video block.
   * `parent` is the parent object (primary) so we can fall back to its
   * options.* for scale/opacity if the block itself doesn't have them.
   */
  static _fieldsFromBlock(block, parent = null) {
    if (!block) return AAStore._emptyFields();
    const options = block.options ?? parent?.options ?? {};
    const customPath = block.customPath ?? "";
    const presetName = block.animation ?? "";
    return {
      customPath,
      presetName,
      menuType:    block.menuType ?? "",
      currentRef:  customPath || presetName || "",
      color:       block.color ?? "",
      variant:     block.variant ?? "",
      scale:       Number(options.scale ?? options.size ?? 1.0),
      opacity:     Number(options.opacity ?? 1.0),
      belowTokens: !!(options.below ?? false),
    };
  }

  /**
   * Upsert fields onto the spell's AA record. If an existing record is
   * found (in any category), modify it in place. If no record exists,
   * create a new templatefx record (covers spell-cast template effects,
   * the most common case for ace-qol use).
   *
   * @param {string} spellName
   * @param {{customPath?:string, color?:string, variant?:string,
   *          scale?:number, opacity?:number, belowTokens?:boolean}} fields
   */
  static async upsertFields(spellName, fields) {
    if (!AAStore.isInstalled()) {
      ui.notifications.error("AutoAnimations not installed.");
      return false;
    }

    const entry = AAStore.findRecord(spellName);
    let category, recId, record;

    if (entry) {
      category = entry.category;
      recId    = entry.recId;
      record   = foundry.utils.deepClone(entry.record);
    } else {
      // No record exists — create new in templatefx
      category = "templatefx";
      recId    = foundry.utils.randomID(16);
      record   = {
        label: spellName,
        menu:  category,
        animation: { primary: { video: {} } },
      };
    }

    record.animation ??= {};
    record.animation.primary ??= {};
    record.animation.primary.video   ??= {};
    record.animation.primary.options ??= {};

    const video   = record.animation.primary.video;
    const primary = record.animation.primary;

    if (fields.customPath !== undefined) {
      video.customPath = fields.customPath;
      if (fields.customPath) {
        video.dbSection ??= "static";
        video.menuType    = "static";
      }
    }
    if (fields.color       !== undefined) video.color   = fields.color;
    if (fields.variant     !== undefined) video.variant = fields.variant;
    if (fields.scale       !== undefined) primary.options.scale   = Number(fields.scale);
    if (fields.opacity     !== undefined) primary.options.opacity = Number(fields.opacity);
    if (fields.belowTokens !== undefined) primary.options.below   = !!fields.belowTokens;

    // Read current category data, set the record, write back
    const categoryData = foundry.utils.deepClone(AAStore.getCategory(category));
    categoryData[recId] = record;
    return await AAStore.saveCategory(category, categoryData);
  }

  /**
   * Delete the spell's AA record entirely. AA's compiled-in fallback may
   * still play for known spells, but the user's autorec entry is gone.
   */
  static async deleteRecord(spellName) {
    if (!AAStore.isInstalled()) return false;
    const entry = AAStore.findRecord(spellName);
    if (!entry) return true; // already absent
    const categoryData = foundry.utils.deepClone(AAStore.getCategory(entry.category));
    delete categoryData[entry.recId];
    return await AAStore.saveCategory(entry.category, categoryData);
  }

  /**
   * Probe AA's exposed `globalThis.AutomatedAnimations` API to see if it
   * provides a way to query compiled-in defaults for a spell that isn't
   * yet in autorec. Returns null if no API path works — caller falls back
   * to a blank dialog. NEVER throws.
   */
  static async getCompiledDefault(item) {
    if (!AAStore.isInstalled() || !item) return null;
    try {
      const candidates = [
        globalThis.AutomatedAnimations,
        game.modules.get(AA_MODULE)?.api,
        globalThis.aa,
      ].filter(Boolean);

      for (const api of candidates) {
        if (typeof api.findAnimation === "function") {
          try {
            const result = await api.findAnimation(item);
            if (result) return AAStore._extractFromAAResult(result);
          } catch (_) {}
        }
        if (typeof api.getPreset === "function") {
          try {
            const found = await api.getPreset(item.name);
            if (found) return AAStore.getEditableFields(found);
          } catch (_) {}
        }
      }
      return null;
    } catch (err) {
      console.warn("[ace-qol/AAStore] getCompiledDefault failed:", err);
      return null;
    }
  }

  static _extractFromAAResult(result) {
    if (!result) return null;
    const candidate = result.animation && result.animation.primary
      ? result
      : result.record ?? result.preset ?? result;
    return AAStore.getEditableFields(candidate);
  }
}
