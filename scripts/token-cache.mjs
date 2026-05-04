// ─── ACE: QOL — Token Image Cache ────────────────────────────────────────────
// Fast in-memory cache of token image filenames → full paths, scanned from
// user-configured folders. Replaces slow per-cast image searches for
// polymorph image resolution.
//
// Lifecycle:
//   1. At world ready, hydrate from persisted setting (instant if cache
//      exists from a prior scan).
//   2. If no persisted cache exists, run an initial scan.
//   3. After every successful scan, persist to setting.
//   4. User can trigger manual rescan via config panel or
//      `game.aceQol.tokenCache.refresh()`.
//
// Folder source (single source of truth):
//   game.settings("ace-qol", "tokenImageFolders") — array of path strings
//   relative to the Foundry user-data folder.
//
// No TVA dependency. Auto-import from TVA was removed because TVA users
// often have nested/duplicate paths that exploded scan time. Users
// configure folders explicitly via the ace-qol config panel.
//
// Polymorph lookup:
//   path = TokenCache.get(beastName)  // sub-ms
//   - hit  → use that path
//   - miss → use compendium default image (no further fallback)
// ──────────────────────────────────────────────────────────────────────────────

import { MODULE_ID } from "./ace-qol.mjs";
import { QolSettings } from "./settings.mjs";

const IMAGE_EXTS = [".webp", ".png", ".jpg", ".jpeg", ".gif", ".svg"];
const CACHE_SETTING_KEY = "tokenImageCacheData";
const FOLDERS_SETTING_KEY = "tokenImageFolders";

export class TokenCache {
  static _cache = new Map();    // lowercase basename → full path
  static _scanning = false;
  static _initialized = false;
  static _lastScanInfo = null;  // { paths, fileCount, uniqueCount, durationSec, timestamp }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Init / public API
  // ═══════════════════════════════════════════════════════════════════════════

  /** Hydrate the cache from persisted settings. If empty, optionally trigger
   *  an initial scan. Idempotent. */
  static init() {
    if (this._initialized) return;
    this._initialized = true;

    const ready = () => {
      try {
        const hydrated = this._hydrateFromSettings();
        if (hydrated) {
          console.log(`${MODULE_ID} | TokenCache hydrated from world settings: ${this._cache.size} unique names (last scanned ${this._formatAge(this._lastScanInfo?.timestamp)})`);
          return;
        }
        // No persisted cache — run an initial scan if folders are configured
        const paths = this.getConfiguredPaths();
        if (paths.length) {
          console.log(`${MODULE_ID} | TokenCache: no persisted cache, running first-time scan of ${paths.length} folder(s)…`);
          this.refresh().catch(err => {
            console.warn(`${MODULE_ID} | TokenCache: first-time scan failed:`, err);
          });
        } else {
          console.log(`${MODULE_ID} | TokenCache: no folders configured (set them in ace-qol config panel)`);
        }
      } catch (err) {
        console.warn(`${MODULE_ID} | TokenCache.init failed:`, err);
      }
    };

    if (game?.ready) ready();
    else Hooks.once("ready", ready);
    console.log(`${MODULE_ID} | TokenCache wired`);
  }

  /** Look up a token image by name. Returns the full path, or null if no
   *  match. Tries multiple normalized variations of the name. */
  static get(name) {
    if (!name) return null;
    if (!this._cache.size) return null;

    const tries = [
      this._normalize(name),
      this._normalize(name).replace(/[\s_-]+/g, ""),
      this._normalize(name).replace(/\s+/g, "-"),
      this._normalize(name).replace(/\s+/g, "_"),
      this._normalize(name).replace(/\s*\([^)]*\)\s*/g, "").trim(),
    ];
    for (const key of tries) {
      if (key && this._cache.has(key)) return this._cache.get(key);
    }
    return null;
  }

  /** Diagnostic info. */
  static stats() {
    return {
      cacheSize:       this._cache.size,
      configuredPaths: this.getConfiguredPaths(),
      lastScan:        this._lastScanInfo,
      sample:          [...this._cache.entries()].slice(0, 10),
    };
  }

  /** The folder paths that will be scanned (read directly from setting). */
  static getConfiguredPaths() {
    try {
      const raw = QolSettings.get(FOLDERS_SETTING_KEY);
      if (Array.isArray(raw)) return raw.filter(p => typeof p === "string" && p.trim());
    } catch (_) { /* setting not registered yet */ }
    return [];
  }

  /** Manually clear the scanning lock. Use only if a refresh got stuck. */
  static forceUnlock() {
    const wasLocked = this._scanning;
    this._scanning = false;
    console.log(`${MODULE_ID} | TokenCache: scan lock force-cleared (was ${wasLocked})`);
    return wasLocked;
  }

  /** Drop the persisted cache and the in-memory cache. Next refresh will
   *  do a full re-scan. */
  static async clearPersistedCache() {
    try {
      await QolSettings.set ? game.settings.set(MODULE_ID, CACHE_SETTING_KEY, {
        map: {}, paths: [], fileCount: 0, uniqueCount: 0, durationSec: 0, timestamp: 0,
      }) : null;
    } catch (_) {}
    this._cache.clear();
    this._lastScanInfo = null;
    console.log(`${MODULE_ID} | TokenCache: persisted cache cleared`);
  }

  /**
   * Re-scan all configured folders and rebuild the cache. Persists result.
   * Per-path progress logged so any slow path is visible.
   */
  static async refresh() {
    if (this._scanning) {
      console.log(`${MODULE_ID} | TokenCache.refresh: already scanning, skipping (use forceUnlock() if stuck)`);
      return;
    }
    this._scanning = true;

    try {
      const rawPaths = this.getConfiguredPaths();
      if (!rawPaths.length) {
        this._cache.clear();
        this._lastScanInfo = { paths: [], fileCount: 0, uniqueCount: 0, durationSec: 0, timestamp: Date.now() };
        await this._persist();
        console.log(`${MODULE_ID} | TokenCache: no folders configured — empty cache`);
        return;
      }

      // ── Dedup overlapping paths ──
      // If a path is contained inside another configured path, skip it. This
      // prevents the 5x-walk problem (e.g. "tokens/MM" + "tokens" + "tokens/MM/X").
      const cleanPaths = rawPaths
        .map(p => String(p).replace(/\\+/g, "/").replace(/^\/+/, "").replace(/\/+$/, "").trim())
        .filter(p => p.length > 0);
      const dedupPaths = this._dedupPaths(cleanPaths);
      if (dedupPaths.length < cleanPaths.length) {
        const skipped = cleanPaths.filter(p => !dedupPaths.includes(p));
        console.log(`${MODULE_ID} | TokenCache: skipped ${skipped.length} overlapping path(s) (already covered by a parent path): ${skipped.join(", ")}`);
      }

      const t0 = performance.now();
      const newCache = new Map();
      let totalFiles = 0;

      for (let i = 0; i < dedupPaths.length; i++) {
        const cleanPath = dedupPaths[i];
        const pathT0 = performance.now();
        let pathFileCount = 0;
        try {
          console.log(`${MODULE_ID} | TokenCache [${i + 1}/${dedupPaths.length}] scanning "${cleanPath}" (recursive)…`);
          const files = await this._walkRecursive(cleanPath);
          for (const file of files) {
            const name = this._basenameWithoutExt(file);
            const key = this._normalize(name);
            if (!newCache.has(key)) newCache.set(key, file);
            totalFiles++;
            pathFileCount++;
          }
          const pathSec = ((performance.now() - pathT0) / 1000).toFixed(2);
          console.log(`${MODULE_ID} | TokenCache [${i + 1}/${dedupPaths.length}] "${cleanPath}" → ${pathFileCount} files (${pathSec}s)`);
        } catch (err) {
          const pathSec = ((performance.now() - pathT0) / 1000).toFixed(2);
          console.warn(`${MODULE_ID} | TokenCache [${i + 1}/${dedupPaths.length}] "${cleanPath}" THREW after ${pathSec}s:`, err);
        }
      }

      this._cache = newCache;
      const durationSec = (performance.now() - t0) / 1000;
      this._lastScanInfo = {
        paths:       dedupPaths,
        fileCount:   totalFiles,
        uniqueCount: newCache.size,
        durationSec: Number(durationSec.toFixed(2)),
        timestamp:   Date.now(),
      };

      await this._persist();
      console.log(`${MODULE_ID} | TokenCache: scanned ${dedupPaths.length} root path(s), ${totalFiles} files total, ${newCache.size} unique names indexed in ${durationSec.toFixed(2)}s — persisted to world settings`);
    } finally {
      this._scanning = false;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Internal — persistence
  // ═══════════════════════════════════════════════════════════════════════════

  static _hydrateFromSettings() {
    try {
      const data = QolSettings.get(CACHE_SETTING_KEY);
      if (!data || !data.map) return false;
      const entries = Object.entries(data.map);
      if (!entries.length) return false;
      this._cache = new Map(entries);
      this._lastScanInfo = {
        paths:       Array.isArray(data.paths) ? data.paths : [],
        fileCount:   Number(data.fileCount) || 0,
        uniqueCount: Number(data.uniqueCount) || entries.length,
        durationSec: Number(data.durationSec) || 0,
        timestamp:   Number(data.timestamp) || 0,
      };
      return true;
    } catch (err) {
      console.warn(`${MODULE_ID} | TokenCache._hydrateFromSettings failed:`, err);
      return false;
    }
  }

  static async _persist() {
    try {
      const map = Object.fromEntries(this._cache.entries());
      const data = {
        map,
        paths:       this._lastScanInfo?.paths ?? [],
        fileCount:   this._lastScanInfo?.fileCount ?? 0,
        uniqueCount: this._lastScanInfo?.uniqueCount ?? this._cache.size,
        durationSec: this._lastScanInfo?.durationSec ?? 0,
        timestamp:   this._lastScanInfo?.timestamp ?? Date.now(),
      };
      await game.settings.set(MODULE_ID, CACHE_SETTING_KEY, data);
    } catch (err) {
      console.warn(`${MODULE_ID} | TokenCache._persist failed:`, err);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Internal — path dedup
  // ═══════════════════════════════════════════════════════════════════════════

  /** If path A is inside path B (or equal), drop A. Keeps shortest covering
   *  set so we walk each disk subtree exactly once. */
  static _dedupPaths(paths) {
    // Sort shortest first so children get dropped, parents kept
    const sorted = [...new Set(paths)].sort((a, b) => a.length - b.length);
    const kept = [];
    for (const p of sorted) {
      const isChild = kept.some(k => p === k || p.startsWith(k + "/"));
      if (!isChild) kept.push(p);
    }
    return kept;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Internal — recursive walk
  // ═══════════════════════════════════════════════════════════════════════════

  static async _walkRecursive(path, source = "data") {
    const files = [];
    let result;
    try {
      result = await FilePicker.browse(source, path);
    } catch (err) {
      return files;
    }

    for (const file of (result.files ?? [])) {
      const lower = String(file).toLowerCase();
      if (IMAGE_EXTS.some(ext => lower.endsWith(ext))) {
        files.push(file);
      }
    }
    for (const dir of (result.dirs ?? [])) {
      const subFiles = await this._walkRecursive(dir, source);
      files.push(...subFiles);
    }
    return files;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Internal — name normalization + helpers
  // ═══════════════════════════════════════════════════════════════════════════

  static _basenameWithoutExt(filepath) {
    const filename = String(filepath).split("/").pop();
    return filename.replace(/\.[^.]+$/, "");
  }

  static _normalize(name) {
    return String(name ?? "").toLowerCase().trim();
  }

  static _formatAge(timestamp) {
    if (!timestamp) return "never";
    const seconds = Math.round((Date.now() - timestamp) / 1000);
    if (seconds < 60)    return `${seconds}s ago`;
    if (seconds < 3600)  return `${Math.round(seconds / 60)}min ago`;
    if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`;
    return `${Math.round(seconds / 86400)}d ago`;
  }
}
