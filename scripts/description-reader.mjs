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
// Imports nothing itself, so no import cycle can reach this file through it.
import { inlineRollsAsText } from "./inference/spell-text.mjs";

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

const ABILITY = { str: "Strength", dex: "Dexterity", con: "Constitution",
  int: "Intelligence", wis: "Wisdom", cha: "Charisma" };
const SKILL = { acr: "Acrobatics", ani: "Animal Handling", arc: "Arcana", ath: "Athletics",
  dec: "Deception", his: "History", ins: "Insight", itm: "Intimidation", inv: "Investigation",
  med: "Medicine", nat: "Nature", prc: "Perception", prf: "Performance", per: "Persuasion",
  rel: "Religion", slt: "Sleight of Hand", ste: "Stealth", sur: "Survival" };
// dnd5e's own reference kinds (CONFIG.DND5E.ruleTypes), lower-cased.
const RULE_KEYS = new Set(["rule", "ability", "areaofeffect", "condition", "creaturetype", "damage",
  "skill", "spellcomponent", "spellschool", "spelltag", "weaponmastery"]);

/** "BrightLight", "bright-light", "blinded" as "Bright Light", "Bright Light", "Blinded". */
const _words = (s) => String(s ?? "").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[-_]+/g, " ")
  .replace(/\s+/g, " ").trim().replace(/\b([a-z])/g, (c) => c.toUpperCase());

/** An enricher's inside, "ability=con dc=14 format=long" or "con 14", as parts. */
function _configOf(inside) {
  const keyed = {}, bare = [];
  for (const tok of String(inside ?? "").trim().split(/\s+/).filter(Boolean)) {
    const eq = tok.indexOf("=");
    if (eq > 0) keyed[tok.slice(0, eq).toLowerCase()] = tok.slice(eq + 1);
    else bare.push(tok);
  }
  return { keyed, bare };
}
const _ability = (t) => ABILITY[String(t ?? "").toLowerCase().slice(0, 3)] ?? null;

/** What `&Reference[...]` points at, as the name dnd5e prints for it. */
function _referenceWords(inside) {
  const { keyed, bare } = _configOf(inside);
  const named = Object.entries(keyed).find(([k]) => RULE_KEYS.has(k))?.[1];
  return _words(named ?? bare.join(" "));
}

/** `[[/save ability=con dc=14]]` as "DC 14 Constitution saving throw". */
function _saveWords(inside) {
  const { keyed, bare } = _configOf(inside);
  const abilities = String(keyed.ability ?? bare.find(t => _ability(t)) ?? "").split(/[,|/]/)
    .map(_ability).filter(Boolean);
  const dc = keyed.dc ?? bare.find(t => /^\d+$/.test(t));
  return [dc ? `DC ${dc}` : "", abilities.join(" or "), "saving throw"].filter(Boolean).join(" ");
}

/** `[[/damage 2d6 type=fire]]` as "2d6 fire". */
function _damageWords(inside) {
  const { keyed, bare } = _configOf(inside);
  const formula = keyed.formula ?? bare.filter(t => /\d/.test(t) || /^[+\-*/]$/.test(t)).join(" ");
  const types = String(keyed.type ?? keyed.types ?? bare.filter(t => /^[a-z]+$/i.test(t)).join(","))
    .split(/[,|/]/).map(t => t.trim().toLowerCase()).filter(Boolean).join(" or ");
  return [formula, types].filter(Boolean).join(" ");
}

/** `[[/skill skill=prc dc=13]]` as "DC 13 Perception check". */
function _checkWords(inside) {
  const { keyed, bare } = _configOf(inside);
  const key = String(keyed.skill ?? keyed.ability ?? keyed.tool ?? bare.find(t => !/^\d+$/.test(t)) ?? "")
    .toLowerCase().split(/[,|/]/)[0];
  const what = SKILL[key] ?? Object.values(SKILL).find(v => v.toLowerCase() === key) ?? _ability(key) ?? _words(key);
  const dc = keyed.dc ?? bare.find(t => /^\d+$/.test(t));
  return [dc ? `DC ${dc}` : "", what, "check"].filter(Boolean).join(" ");
}

/** Whose words these are, for `[[lookup @name]]`, `@item.name` and `@item.level`. */
const _context = (item) => ({ name: item?.actor?.name ?? null, itemName: item?.name ?? null,
  level: item?.system?.level ?? null });

/**
 * Every enricher spelled out as the words dnd5e would print, and nothing a
 * screen must never see.
 *
 * ⚠️ THIS IS THE FLOOR, NOT THE FEATURE. It runs when enrichment could not, so
 * it is the text a hover shows before the rendered version is ready.
 *
 * ⚠️🔴 IT USED TO DROP WHAT IT COULD NOT READ AND MISS WHAT IT DID NOT EXPECT.
 * Johnny, 2026-09-11, hovering Prismatic Wall: "The wall sheds
 * &Reference[BrightLight] within 100 feet". The book stores the ampersand
 * encoded, "&amp;Reference[...]", which the old pattern never matched, and it
 * surfaced once the text was decoded for the screen. On its first run the
 * replay counted 2,758 items in hijinx doing the same. And a save or a damage
 * roll was deleted outright, leaving "must succeed on a  or".
 *
 * A label inside `@UUID[...]{Sword of Wounding}` is kept, because that label
 * IS the readable answer.
 *
 * ⚠️ A LABEL CAN HOLD ANOTHER ENRICHER, so this runs until nothing changes.
 * Magic Missile's own text is `[[2 + @item.level]]{Level [[lookup @item.level]]
 * darts}`: a roll whose label is a lookup. One pass handed the label back with
 * the lookup still inside it, on fifteen copies of the spell in hijinx.
 *
 * ⚠️ AND WHAT IS LEFT OF A BROKEN ONE IS NEVER SHOWN. His world holds an
 * enricher missing a bracket ("[[Lookup @Name Lowercase]{monster}") and a
 * statblock with a stray "]]" in the middle of a sentence.
 *
 * @param {string} html
 * @param {{name?: string|null, itemName?: string|null, level?: number|null}} [who]  for the lookups
 */
export function aceStripEnrichers(html, { name = null, itemName = null, level = null } = {}) {
  const labelOr = (label, fallback) => String(label ?? "").trim() || fallback;
  let out = String(html ?? "");
  for (let round = 0; round < 3; round++) {
    const next = _spellOut(out, { name, itemName, level, labelOr });
    if (next === out) break;
    out = next;
  }
  // What is left of a broken enricher: a lone bracket, never shown.
  return out.replace(/\[\[[^[\]]*\](?:\{([^}]*)\})?/g, (_m, label) => labelOr(label, ""))
    .replace(/\[\[|\]\]/g, "");
}

/** One pass of aceStripEnrichers: every enricher it recognises, as words. */
function _spellOut(html, { name, itemName, level, labelOr }) {
  let out = inlineRollsAsText(html);
  // dnd5e's embedded attack and damage lines print nothing without the activity.
  out = out.replace(/\[\[\/(?:attack|damage)\s+extended\s*\]\]\.?/gi, "");
  out = out.replace(/(?:&amp;|&)Reference\[([^\]]*)\](?:\{([^}]*)\})?/gi,
    (_m, inside, label) => labelOr(label, _referenceWords(inside)));
  out = out.replace(/\[\[\/save\s+([^\]]*)\]\](?:\{([^}]*)\})?/gi,
    (_m, inside, label) => labelOr(label, _saveWords(inside)));
  out = out.replace(/\[\[\/(?:damage|dmg|heal|healing)\s+([^\]]*)\]\](?:\{([^}]*)\})?/gi,
    (_m, inside, label) => labelOr(label, _damageWords(inside)));
  out = out.replace(/\[\[\/(?:check|skill|tool)\s+([^\]]*)\]\](?:\{([^}]*)\})?/gi,
    (_m, inside, label) => labelOr(label, _checkWords(inside)));
  out = out.replace(/\[\[lookup\s+@name\s*\]\](?:\{([^}]*)\})?/gi, (_m, label) => labelOr(label, name || "it"));
  out = out.replace(/\[\[lookup\s+@item\.name\s*\]\](?:\{([^}]*)\})?/gi, (_m, label) => labelOr(label, itemName || "it"));
  out = out.replace(/\[\[lookup\s+@item\.level\s*\]\](?:\{([^}]*)\})?/gi,
    (_m, label) => labelOr(label, level !== null && level !== undefined ? String(level) : ""));
  out = out.replace(/\[\[lookup\s+@labels\.description\.affects[^\]]*\]\]/gi, "each creature");
  // `@UUID[...]{Label}` and friends keep their label.
  out = out.replace(/@[A-Za-z]+\[[^\]]*\]\{([^}]*)\}/g, "$1");
  // A referential enricher with no label has nothing readable left.
  out = out.replace(/@[A-Za-z]+\[[^\]]*\]/g, "");
  // Anything else bracketed: its label if it has one, otherwise nothing.
  out = out.replace(/\[\[[^\]]*\]\](?:\{([^}]*)\})?/g, (_m, label) => labelOr(label, ""));
  // A bare `&Something[...]` enricher of another kind, stored either way.
  out = out.replace(/(?:&amp;|&)[A-Za-z]+\[[^\]]*\](?:\{([^}]*)\})?/g, (_m, label) => labelOr(label, ""));
  return out;
}

/** HTML to readable prose: tags out, entities decoded, whitespace collapsed. */
function _flatten(html, limit) {
  // ⚠️ A BLOCK IS A GAP. Taking the text out of the markup ran paragraphs and
  // table cells straight together: "without effect.The wall" and "Prismatic
  // LayersOrderEffects1Red" on his hover of Prismatic Wall (2026-09-11).
  const spaced = String(html ?? "")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<\/(p|div|li|tr|td|th|h[1-6]|table|thead|tbody|ul|ol|blockquote|section|caption|dt|dd)>/gi, "</$1> ");
  let text;
  try {
    const el = document.createElement("div");
    el.innerHTML = spaced;
    text = el.textContent ?? "";
  } catch (_) {
    // No DOM (a test harness, a headless call). Blunt but never wrong-looking.
    text = spaced.replace(/<[^>]+>/g, " ");
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
      return aceStripEnrichers(raw, _context(item));
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
    return aceStripEnrichers(raw, _context(item));
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
  return _flatten(aceStripEnrichers(raw, _context(item)), limit);
}

/**
 * The description as markup with every enricher spelled out, right now.
 *
 * ⚠️ FOR A CARD THAT CANNOT WAIT. It keeps the paragraphs and the tables,
 * which flattening to prose destroys, and it never shows enricher syntax. It
 * warms the cache on the way past, so the next look is the rendered text.
 */
export function aceDescriptionFloorHtml(item, { activity = null } = {}) {
  const raw = _raw(item, { activity });
  if (!raw) return "";
  aceDescriptionHtml(item, { activity }).catch(() => {});
  return aceStripEnrichers(raw, _context(item));
}

/**
 * Enriched HTML right now, or empty when the cache is cold.
 *
 * ⚠️ EMPTY MEANS "NOT YET", NOT "NOTHING". The caller must have a fallback —
 * `aceDescriptionTextSync` is the one to use — because returning the raw source
 * here would put enricher syntax straight into a tooltip, which is the whole
 * thing this file exists to prevent. It warms the cache on the way past.
 */
export function aceDescriptionHtmlSync(item, { activity = null } = {}) {
  const raw = _raw(item, { activity });
  if (!raw) return "";
  const hit = _cache.get(_key(item, raw));
  if (hit) return hit;
  aceDescriptionHtml(item, { activity }).catch(() => {});
  return "";
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
