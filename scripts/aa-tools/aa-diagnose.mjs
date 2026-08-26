// ─── ACE: QOL — Why did this thing not animate? ──────────────────────────────
//
// ⚠️🔴 WHY THIS EXISTS. Automated Animations reports every failure with one
// sentence: "No Item or Source Token". That sentence is wrong in the way that
// costs the most time — it names the token and the item, which are almost never
// the problem. The trailing value it prints is the whole handler, and when the
// handler is `false` AA never looked at a token at all.
//
// Johnny, 2026-08-25, on a Rapier +3 that would not animate. I read AA's source
// and his world database and produced a confident answer that his very next
// question destroyed: his Fireball animates and it has no AA record at all,
// while his Magic Missile has a full custom record and does not. That is the
// exact opposite of what the setting I blamed would produce.
//
// So this reads the LIVE GAME instead of me reconstructing it. Every gate AA
// applies, in AA's own order, reported per item, naming the one that stopped it.
//
// ⚠️ IT MIRRORS AA'S MATCHING, IT DOES NOT INVENT ITS OWN. The name rinse
// (spaces stripped, lowercased), the exact-label pass, the longest-label-first
// substring pass and the excluded-terms rule are all lifted from AA's
// `AAAutorecFunctions`. A diagnostic that matches differently than the thing it
// diagnoses is worse than none, because it sends you somewhere else.
//
// Usage in Foundry's console:
//     game.aceQol.whyNoAnimation()             — everything the selected token owns
//     game.aceQol.whyNoAnimation("Fireball")   — one item by name
// ──────────────────────────────────────────────────────────────────────────────

const AA = "autoanimations";
const CATEGORIES = ["melee", "range", "ontoken", "templatefx", "aura", "preset", "aefx"];

/** AA's own name normalisation. Spaces gone, lowercased. */
function rinse(name) {
  return String(name ?? "").replace(/\s+/g, "").toLowerCase();
}

function setting(key, fallback = undefined) {
  try { return game.settings.get(AA, key); } catch (_) { return fallback; }
}

/** Every autorec entry AA would consider, in AA's own priority order. */
function allEntries() {
  const out = [];
  for (const cat of CATEGORIES) {
    const v = setting(`aaAutorec-${cat}`, []);
    if (Array.isArray(v)) for (const e of v) out.push({ ...e, _category: cat });
  }
  // ⚠️ LONGEST LABEL FIRST, exactly as AA sorts. "Fire Bolt" must be tried
  // before "Fire", or every fire spell in the game gets Fire Bolt's animation.
  return out.sort((a, b) => rinse(b.label).length - rinse(a.label).length);
}

/** AA's match: exact label first, then longest-label substring, minus excludes. */
function matchEntry(entries, itemName) {
  const rinsed = rinse(itemName);
  const exact = entries.find(x => x.label && x.label === itemName);
  if (exact) return { entry: exact, how: "an exact label match" };

  const loose = entries.find(x => {
    if (!x.label) return false;
    if (!rinsed.includes(rinse(x.label))) return false;
    const excl = x.advanced?.excludedTerms ?? [];
    if (excl.length && excl.some(t => rinsed.includes(rinse(t)))) return false;
    return true;
  });
  return loose ? { entry: loose, how: `the label "${loose.label}" appearing in the name` } : null;
}

/**
 * Work out, gate by gate, what AA would do with one item.
 * @returns {{name:string, verdict:string, detail:string}}
 */
export function diagnoseItem(item) {
  const name = item?.name ?? "(unnamed)";
  const flags = item?.flags?.[AA] ?? null;

  // Gate 1 — animations switched off wholesale.
  if (setting("killAllAnim") === "off") {
    return { name, verdict: "BLOCKED", detail: "all animations are switched off in AA's settings (Kill All Animations)." };
  }

  // Gate 2 — this item is switched off, or has an explicit kill flag.
  if (flags?.killAnim) {
    return { name, verdict: "BLOCKED", detail: "this item carries AA's 'kill animation' flag." };
  }
  if (flags && flags.isEnabled === false) {
    return { name, verdict: "BLOCKED", detail: "this item's own AA record is disabled." };
  }

  // Gate 3 — a custom record wins outright and ignores recognition entirely.
  if (flags?.isCustomized) {
    const menu = flags.menu ?? "(no menu set)";
    const file = flags.primary?.video?.animation
      ?? flags.primary?.video?.customPath
      ?? "(nothing set)";
    const empty = !flags.primary?.video?.animation && !flags.primary?.video?.customPath;
    return {
      name,
      verdict: empty ? "SUSPECT" : "SHOULD ANIMATE",
      detail: empty
        ? `it has its own AA record (menu "${menu}") but no animation file is set in it, so there is nothing to play.`
        : `it has its own AA record (menu "${menu}", animation "${file}"), which ignores the recognition setting entirely.`,
    };
  }

  // Gate 4 — recognition, and whether the library would match.
  const disabled = !!setting("disableAutoRec");
  const entries = allEntries();
  const hit = matchEntry(entries, name);

  if (disabled) {
    return {
      name,
      verdict: "BLOCKED",
      detail: hit
        ? `automatic recognition is OFF. It would otherwise have matched "${hit.entry.label}" `
          + `(${hit.entry._category}) by ${hit.how}.`
        : `automatic recognition is OFF, and nothing in the library matches this name anyway.`,
    };
  }

  if (!hit) {
    return {
      name,
      verdict: "NO MATCH",
      detail: `nothing in the ${entries.length} installed entries matches "${name}". `
        + `AA matches on the label appearing inside the item name, so an entry called `
        + `"${name.split(/\s+/)[0]}" would catch it.`,
    };
  }

  return {
    name,
    verdict: "SHOULD ANIMATE",
    detail: `matches "${hit.entry.label}" (${hit.entry._category}) by ${hit.how}.`,
  };
}

/**
 * Report on one named item, or on everything the selected token owns.
 * Prints a table and returns the rows.
 */
export function whyNoAnimation(itemName = null) {
  // ⚠️ AA'S ABSENCE IS AN ANSWER, NOT A REASON TO SAY NOTHING. This runs
  // even when AA is missing or disabled, because "the module is not running" is
  // exactly the finding a GM chasing a silent weapon needs.
  const mod = game.modules.get(AA);
  if (!mod) {
    console.warn("ACE: QOL | Automated Animations is not installed. Nothing will animate through it.");
    return [];
  }
  if (!mod.active) {
    console.warn("ACE: QOL | Automated Animations is installed but DISABLED in Manage Modules. "
      + "That alone stops every animation.");
    return [];
  }

  const rows = [];
  const header = [];

  // ⚠️ THE GLOBAL STATE FIRST. Two of the four gates are world-wide, and a GM
  // hunting one stubborn weapon should not have to find that out per item.
  header.push(`Automated Animations global state:`);
  header.push(`   all animations: ${setting("killAllAnim") === "off" ? "OFF" : "on"}`);
  header.push(`   automatic recognition: ${setting("disableAutoRec") ? "OFF" : "on"}`);
  header.push(`   installed entries: ${allEntries().length}`);
  header.push(`   play on miss: ${setting("playonmiss") ? "yes" : "no"}`);
  console.log("ACE: QOL | " + header.join("\n           "));

  const token = canvas?.tokens?.controlled?.[0];
  let items = [];
  if (itemName) {
    const wanted = String(itemName).toLowerCase();
    const pool = token?.actor?.items ?? game.actors?.contents?.flatMap(a => a.items.contents) ?? [];
    items = pool.filter(i => String(i.name ?? "").toLowerCase().includes(wanted));
    if (!items.length) {
      console.warn(`ACE: QOL | No item matching "${itemName}" was found`
        + (token ? ` on ${token.name}` : " on any actor") + ".");
      return [];
    }
  } else {
    if (!token) {
      console.warn("ACE: QOL | Select a token first, or pass an item name.");
      return [];
    }
    items = token.actor?.items?.contents ?? [];
    // Only things that actually get used — a diagnostic listing 200 pieces of
    // inventory is a wall of text, not an answer.
    items = items.filter(i => ["weapon", "spell", "feat", "consumable"].includes(i.type));
  }

  for (const it of items) {
    const r = diagnoseItem(it);
    rows.push(r);
    const mark = r.verdict === "SHOULD ANIMATE" ? "ok  " : r.verdict === "NO MATCH" ? "none" : "STOP";
    console.log(`ACE: QOL | ${mark}  ${r.name.padEnd(28)} ${r.detail}`);
  }
  return rows;
}
