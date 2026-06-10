// ─── ACE: QOL — File-path helpers (shared) ──────────────────────────────────
// Foundry serves files as WEB paths: forward slashes, relative to its Data
// root (e.g. "modules/jb2a/x.webm"). But users copy paths from Windows File
// Explorer, which hands back an absolute drive path with BACKSLASHES, e.g.
//
//   Y:\Mirror\FoundryVTT\Data\modules\jb2a_patreon\Library\...\Marker.webm
//
// normalizeFoundryPath() turns that into the form Foundry actually wants
//
//   modules/jb2a_patreon/Library/.../Marker.webm
//
// and verifyFoundryPath() confirms the file really exists there. Both are
// generic — wire them into any file-path setting in the suite.
// ──────────────────────────────────────────────────────────────────────────────

// Top-level folders served under Foundry's Data root. Used as fallback anchors
// when a pasted path has no "/Data/" marker (custom data paths, already-relative
// paths, etc.).
const FOUNDRY_TOP_FOLDERS = ["modules", "worlds", "systems", "assets"];

/**
 * Convert a pasted file path into a Foundry-relative, forward-slash path.
 *   "Y:\…\Data\modules\jb2a\x.webm"  →  "modules/jb2a/x.webm"
 *   "modules/jb2a/x.webm"            →  unchanged (already clean)
 *   "https://host/x.webm"            →  unchanged (real URL)
 * Always returns a string; returns the input untouched if it isn't a string.
 * @param {string} raw
 * @returns {string}
 */
export function normalizeFoundryPath(raw) {
  if (!raw || typeof raw !== "string") return raw;
  let p = raw.trim().replace(/^["']+|["']+$/g, "");   // strip wrapping quotes
  if (!p) return p;
  if (/^https?:\/\//i.test(p)) return p;              // leave real URLs alone
  p = p.replace(/\\/g, "/").replace(/\/{2,}/g, "/");  // backslashes → fwd, collapse doubles

  // Primary anchor: everything after the LAST "/Data/" (Foundry's user-data
  // root). Handles the standard Windows paste cleanly, and any folder under
  // Data — not just modules.
  const dataIdx = p.toLowerCase().lastIndexOf("/data/");
  if (dataIdx >= 0) {
    p = p.slice(dataIdx + 6); // 6 = "/data/".length
  } else {
    // Fallback: no Data marker (custom data path, or already partly-relative) —
    // start at the first known top-level Foundry folder.
    const re = new RegExp(`(?:^|/)((?:${FOUNDRY_TOP_FOLDERS.join("|")})/.*)$`, "i");
    const m = p.match(re);
    if (m) p = m[1];
  }
  return p.replace(/^\/+/, ""); // no leading slash
}

/**
 * Does this path resolve to a real file the server can serve? Uses an HTTP HEAD
 * so it works for both Foundry-relative paths and absolute URLs.
 * @param {string} path
 * @returns {Promise<boolean>}
 */
export async function verifyFoundryPath(path) {
  if (!path || typeof path !== "string") return false;
  try {
    const url = /^https?:\/\//i.test(path)
      ? path
      : foundry.utils.getRoute(path.split("/").map(s => encodeURIComponent(s)).join("/"));
    const r = await fetch(url, { method: "HEAD" });
    return r.ok;
  } catch (_) {
    return false;
  }
}
