// ─── ACE: QOL — THE reader for an item's description ─────────────────────────
//
// Johnny, 2026-09-03, looking at his action bar showing a beholder's lair
// action: "It says the lookup name part. I don't want to ever see that in any of
// our shit. It's supposed to be saying what the name is, not 'lookup at name'."
//
// ⚠️🔴 THE SUITE HAD THREE ANSWERS TO ONE QUESTION AND ONLY ONE WAS RIGHT.
//
//   usage-card / activity-use-prompt   enrich properly            correct
//   lootable-tile                      strip `[[...]]` entirely   safe, lossy
//   action-bar                         strip HTML tags only       THE BUG
//
// The action bar's own comment argued for stripping: "a half-rendered enricher
// reads as corruption." True, and it missed that an UNRENDERED one reads worse.
// Taking the tags out of `<p>[[lookup @name]] is a beholder</p>` leaves the
// square brackets sitting on screen in full.
//
// So there is one reader now, and it does the thing that is actually correct:
// ENRICH FIRST, then flatten if prose is what the caller wanted. `[[lookup
// @name]]` becomes the creature's name. `[[/damage 2d6]]` becomes a damage
// button, or the words "2d6" once flattened. Nothing bracketed reaches a screen.
//
// ⚠️ PARSERS MUST KEEP READING THE RAW TEXT AND THIS FILE IS NOT FOR THEM.
// Twenty-odd places in the suite regex the description for reach, damage types,
// attack counts and spell timing. Enriching first would wrap their haystack in
// anchors and spans and quietly break every one of them. Display enriches;
// parsing does not. If a caller is looking for a number, it is not a caller of
// this file.
//
// ⚠️ AND THE FALLBACK STRIPS THE SYNTAX TOO. When enrichment has not finished,
// or throws, the worst thing that can reach the screen is a sentence with the
// name missing — never the brackets. That is the whole point: there is no path
// through here, including the failure paths, that shows him `[[lookup @name]]`.
const MODULE_ID = "ace-qol";

/**
 * Enriched text, keyed by item uuid AND by the length of the raw source.
 *
 * ⚠️ THE LENGTH IS IN THE KEY BECAUSE HE EDITS DESCRIPTIONS IN FORGE. A cache
 * keyed on uuid alone would hand back last week's text for the rest of the
 * session, and a stale description is a lie that looks like a fact.
 */
const _cache = new Map();
const MAX_CACHE = 400;

const _key = (item, raw) => `${item?.uuid ?? item?.id ?? "?"}:${raw.length}`;

/** The raw description off the item, or the activity's chat flavour first. */
function _raw(item, { activity = null } = {}) {
  const flavour = activity?.description?.chatFlavor;
  return String(flavour || item?.system?.description?.value || "").trim();
}

/**
 * Everything a screen must never see, removed.
 *
 * ⚠️ THIS IS THE FLOOR, NOT THE FEATURE. It runs when enrichment could not, and
 * it is deliberately blunt: an enricher whose meaning we cannot resolve is
 * dropped rather than shown. A label inside `@UUID[...]{Sword of Wounding}` is
 * kept, because that label IS the readable answer.
 */
export function aceStripEnrichers(html) {
  let out = String(html ?? "");
  // `@UUID[...]{Label}` and friends keep their label.
  out = out.replace(/@[A-Za-z]+\[[^\]]*\]\{([^}]*)\}/g, "$1");
  // A referential enricher with no label has nothing readable left.
  out = out.replace(/@[A-Za-z]+\[[^\]]*\]/g, "");
  // `[[/damage 2d6]]`, `[[lookup @name]]`, `[[1d6+2]]` — anything bracketed.
  out = out.replace(/\[\[[^\]]*\]\]/g, "");
  // A bare `&Reference[...]` style enricher.
  out = out.replace(/&[A-Za-z]+\[[^\]]*\](\{[^}]*\})?/g, (_m, label) =>
    label ? label.slice(1, -1) : "");
  return out;
}

/** HTML to readable prose: tags out, entities decoded, whitespace collapsed. */
function _flatten(html, limit) {
  let text;
  try {
    const el = document.createElement("div");
    el.innerHTML = String(html ?? "");
    text = el.textContent ?? "";
  } catch (_) {
    // No DOM (a test harness, a headless call). Blunt but never wrong-looking.
    text = String(html ?? "").replace(/<[^>]+>/g, " ");
  }
  text = text.replace(/\s+/g, " ").trim();
  if (limit && text.length > limit) {
    const cut = text.slice(0, limit);
    const lastSpace = cut.lastIndexOf(" ");
    text = (lastSpace > limit * 0.6 ? cut.slice(0, lastSpace) : cut) + "…";
  }
  return text;
}

/**
 * The item's description as enriched HTML, ready to put on a screen.
 *
 * ⚠️ ROLL DATA FROM THE ACTIVITY, THEN THE ITEM, THEN THE ACTOR. `[[lookup
 * @name]]` resolves out of roll data, and the item's own roll data is what
 * carries the creature's name — asking the activity alone answers null for the
 * exact placeholder that started this.
 */
export async function aceDescriptionHtml(item, { activity = null, actor = null } = {}) {
  const raw = _raw(item, { activity });
  if (!raw) return "";
  const cacheKey = _key(item, raw);
  const hit = _cache.get(cacheKey);
  if (hit) return hit;

  try {
    const TE = foundry.applications?.ux?.TextEditor?.implementation ?? globalThis.TextEditor;
    if (!TE?.enrichHTML) {
      console.warn(`${MODULE_ID} | this Foundry has no text enricher, so descriptions `
        + `are shown with their enricher syntax removed rather than resolved.`);
      return aceStripEnrichers(raw);
    }
    const rollData = activity?.getRollData?.()
                  ?? item?.getRollData?.()
                  ?? (actor ?? item?.actor)?.getRollData?.()
                  ?? {};
    const enriched = await TE.enrichHTML(raw, {
      rollData, relativeTo: item, secrets: false,
    });
    if (_cache.size > MAX_CACHE) _cache.clear();
    _cache.set(cacheKey, enriched);
    return enriched;
  } catch (err) {
    // ⚠️ NAMED, AND STILL SAFE. A thrown enricher must not put brackets on his
    // screen, and it must not be silent about why the text looks thinner.
    console.warn(`${MODULE_ID} | could not enrich the description of `
      + `"${item?.name ?? "an item"}", so any enricher text in it has been removed `
      + `rather than resolved:`, err);
    return aceStripEnrichers(raw);
  }
}

/** The item's description as readable prose, enriched first. */
export async function aceDescriptionText(item, opts = {}) {
  const html = await aceDescriptionHtml(item, opts);
  return _flatten(html, opts.limit ?? 0);
}

/**
 * Prose right now, for a caller that cannot await.
 *
 * ⚠️ THE CACHE IS WHAT MAKES THIS HONEST, so warm it. The action bar primes
 * every item when it redraws for a creature, which is well before any hover.
 * On a miss this still never shows the syntax — it strips it — so the worst
 * case is one sentence missing a name, not brackets on the screen.
 */
export function aceDescriptionTextSync(item, { limit = 0, activity = null } = {}) {
  const raw = _raw(item, { activity });
  if (!raw) return "";
  const hit = _cache.get(_key(item, raw));
  if (hit) return _flatten(hit, limit);
  // Not warm yet: warm it for next time, and answer safely now.
  aceDescriptionHtml(item, { activity }).catch(() => {});
  return _flatten(aceStripEnrichers(raw), limit);
}

/** Enrich these items' descriptions in the background so the sync read is warm. */
export function acePrimeDescriptions(items) {
  try {
    for (const item of (items ?? [])) {
      if (!item?.system?.description?.value) continue;
      aceDescriptionHtml(item).catch(() => {});
    }
  } catch (err) {
    console.warn(`${MODULE_ID} | could not pre-read these descriptions, so the first `
      + `hover on each may show one without its enriched names:`, err);
  }
}
