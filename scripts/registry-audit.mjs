// ─── ACE: QOL — does the registry agree with the items on his sheets? ────────
//
// ⚠️🔴 WRITTEN BECAUSE THE SAME BUG ARRIVED THREE TIMES IN ONE DAY, and each
// time it was found by tripping over it rather than by looking (2026-09-04):
//
//   • Thunderstorm of Misery stamped `deafened` while the staff's own text says
//     disadvantage on Perception checks.
//   • Holy Weapon's entry promised +2d10 on hit and 4d10 on the burst; RAW is
//     2d8 and 4d8.
//   • Mass Healing Word's entry carried 1d4, the 2014 number, while his copy is
//     the 2024 one at 2d4. Every 2024 caster had been healing half the spell, on
//     every cast, and nothing anywhere would ever have said so.
//
// A curated entry that disagrees with the item is the worst kind of wrong: the
// spell still resolves, still posts a card, still looks right, and quietly uses
// somebody else's numbers. Nothing throws and nothing warns.
//
// ⚠️ SO IT COMPARES WHAT CAN ACTUALLY DISAGREE, AND NOTHING ELSE. Damage dice
// are not in the registry at all — the save engine reads those off the item, so
// they cannot drift. What CAN drift is the handful of things an entry restates:
// the save ability, the range, whether it needs concentration, the healing dice
// and the area it expects. Those five, and a report a human reads.
//
// ⚠️ IT REPORTS, IT NEVER FIXES. Some disagreements are deliberate: a homebrew
// item, a variant, a GM's own edit. Naming them and letting a human judge is the
// same stance the geometry check and the hollow-feature warning take.
//
// ⚠️ AND IT PROVES WHAT IT LOOKED AT. A silent audit that finds nothing is
// indistinguishable from one that never ran, and four of my own tools have given
// confident wrong numbers before now. This prints how many items it read, how
// many carried an ACE entry, and how many of those it could actually compare.
//
// Run:  game.aceQol.auditSpellRules()
// ──────────────────────────────────────────────────────────────────────────────

const MODULE_ID = "ace-qol";
const LOG = "ace-qol | RegistryAudit";

/**
 * Every spell and feat in the world, once per distinct name.
 *
 * ⚠️🔴 AND IT REMEMBERS WHOSE COPY IT READ. His library holds many copies of
 * one spell across many sheets, and they do not all agree. Reporting "Sleep says
 * 90 feet" while his own Sleep card plainly reads 60 sent him looking at the
 * wrong item; the offender was some other actor's copy, stamped 2024 but
 * carrying the 2014 range. A finding he cannot go and look at is not a finding.
 */
function _allItems() {
  const byName = new Map();
  const add = (item, owner) => {
    if (!item) return;
    if (item.type !== "spell" && item.type !== "feat") return;
    const key = String(item.name ?? "").trim().toLowerCase();
    if (!key) return;
    const seen = byName.get(key);
    if (seen) { seen.copies++; return; }
    byName.set(key, { item, owner, copies: 1 });
  };
  try { for (const i of (game.items ?? [])) add(i, "the world items list"); } catch (_) { /* keep going */ }
  try {
    for (const a of (game.actors ?? [])) {
      for (const i of (a.items ?? [])) add(i, a.name);
    }
  } catch (_) { /* keep going */ }
  return [...byName.values()];
}

/** Which edition THIS item is written for. The item wins over the world setting. */
function _editionOf(item) {
  try {
    const r = String(item?.system?.source?.rules ?? "").trim();
    if (r === "2014" || r === "2024") return r;
  } catch (_) { /* fall through */ }
  try {
    const { CombatState } = globalThis.aceQolCombatState ?? {};
    if (CombatState?.getActiveEdition) return CombatState.getActiveEdition;
  } catch (_) { /* fall through */ }
  return null;
}

/** The dice in a formula, ignoring modifiers: "5d8 + 3" -> "5d8". */
function _diceOf(text) {
  const out = [];
  for (const m of String(text ?? "").matchAll(/(\d+)\s*d\s*(\d+)/gi)) {
    out.push(`${Number(m[1])}d${Number(m[2])}`);
  }
  return out.join(" + ");
}

/** What the ITEM says it heals, read off its activities. */
function _itemHealing(item) {
  try {
    const acts = item.system?.activities;
    const list = typeof acts?.values === "function" ? [...acts.values()] : Object.values(acts ?? {});
    for (const a of list) {
      const h = a?.healing ?? a?.toObject?.()?.healing ?? null;
      if (h && Number(h.number) > 0 && Number(h.denomination) > 0) {
        return `${Number(h.number)}d${Number(h.denomination)}`;
      }
      // Some heal activities carry it as an ordinary damage part typed "healing".
      for (const p of (a?.damage?.parts ?? [])) {
        const types = [...(p?.types ?? [])].map(t => String(t).toLowerCase());
        if (!types.includes("healing") && !types.includes("temphp")) continue;
        if (Number(p.number) > 0 && Number(p.denomination) > 0) {
          return `${Number(p.number)}d${Number(p.denomination)}`;
        }
      }
    }
  } catch (_) { /* unreadable */ }
  return null;
}

/** What the ITEM says its save is. */
function _itemSave(item) {
  try {
    const acts = item.system?.activities;
    const list = typeof acts?.values === "function" ? [...acts.values()] : Object.values(acts ?? {});
    for (const a of list) {
      // ⚠️ A SET IN dnd5e 5.x, NOT A STRING. Reading it as a string here gives
      // "undefined" and reports every save spell as a disagreement.
      const ab = a?.save?.ability;
      if (!ab) continue;
      const first = (ab instanceof Set) ? [...ab][0] : (Array.isArray(ab) ? ab[0] : ab);
      if (first) return String(first).toLowerCase();
    }
  } catch (_) { /* unreadable */ }
  return null;
}

/** What the ITEM says its range is, in feet. */
function _itemRangeFt(item) {
  try {
    const r = item.system?.range ?? {};
    const units = String(r.units ?? "").toLowerCase();
    if (units === "self" || units === "touch") return units;
    const v = Number(r.value);
    return Number.isFinite(v) && v > 0 ? v : null;
  } catch (_) { return null; }
}

/** What the ITEM says its area is. */
function _itemArea(item) {
  try {
    const t = item.system?.target?.template ?? {};
    const type = String(t.type ?? "").toLowerCase();
    if (!type) return null;
    const size = Number(t.size);
    return { type, size: Number.isFinite(size) ? size : null };
  } catch (_) { return null; }
}

export class RegistryAudit {

  static async run({ quiet = false } = {}) {
    const lines = [];
    const say = (s) => { lines.push(s); if (!quiet) console.log(s); };

    const pipeline = game.aceQol?.SpellPipeline;
    if (!pipeline?._getEntry) {
      console.error(`${LOG} | the spell pipeline is not on the API, so there is nothing to `
        + `compare against. This is not "no disagreements".`);
      return { checked: 0, compared: 0, rows: [] };
    }

    let SPELL_RULES = {}, normalize = (s) => String(s ?? "").toLowerCase().trim();
    try {
      const rules = await import("./rules/rules-data-spells.mjs");
      SPELL_RULES = rules.SPELL_RULES ?? {};
      const brain = await import("./rules/rules-brain.mjs");
      if (brain.RulesBrain?.normalizeName) normalize = (s) => brain.RulesBrain.normalizeName(s);
    } catch (err) {
      console.warn(`${LOG} | could not read the rules data, so area and duration are not `
        + `being checked:`, err);
    }

    const items = _allItems();
    const rows = [];
    let withEntry = 0, compared = 0;

    for (const { item, owner, copies } of items) {
      let entry = null;
      try { entry = pipeline._getEntry(item); } catch (_) { entry = null; }
      const spaceEntry = SPELL_RULES[normalize(item.name)] ?? null;
      if (!entry && !spaceEntry) continue;
      withEntry++;

      const edition = _editionOf(item);
      const issues = [];

      // ── 1. The save ability ──
      if (entry?.save?.ability) {
        const mine = String(entry.save.ability).toLowerCase();
        const theirs = _itemSave(item);
        if (theirs && theirs !== mine) {
          issues.push(`save: ACE says ${mine.toUpperCase()}, the item says ${theirs.toUpperCase()}`);
        }
      }

      // ── 2. The range ──
      //
      // ⚠️🔴 A CANTRIP'S RANGE CAN DEPEND ON THE CASTER'S LEVEL, and then no
      // single number in a table is right. 2024 Spare the Dying doubles at 5th,
      // 11th and 17th: 15, 30, 60, 120. This audit reported a Cleric 17's
      // correct 120 as a disagreement, I believed it, and I told him to change
      // an item that was already right. An audit that is confidently wrong
      // about his data is worse than no audit — it does not merely fail to
      // help, it causes damage.
      //
      // ⚠️ SO A CANTRIP'S RANGE IS NEVER COMPARED. The entry for a scaling
      // cantrip should carry no range at all and read the item's, which this
      // now assumes rather than second-guesses.
      const isCantrip = Number(item.system?.level) === 0;
      if (!isCantrip && Number.isFinite(Number(entry?.range)) && Number(entry.range) > 0) {
        const theirs = _itemRangeFt(item);
        if (typeof theirs === "number" && theirs !== Number(entry.range)) {
          issues.push(`range: ACE says ${entry.range} ft, the item says ${theirs} ft`);
        }
      }

      // ── 3. Concentration ──
      if (typeof entry?.concentration === "boolean") {
        const theirs = item.system?.duration?.concentration === true
          || item.system?.properties?.has?.("concentration") === true;
        if (theirs !== entry.concentration) {
          issues.push(`concentration: ACE says ${entry.concentration}, the item says ${theirs}`);
        }
      }

      // ── 4. The healing dice ──
      if (typeof entry?.heal?.formula === "function") {
        try {
          const lvl = Number(item.system?.level) || 1;
          const mine = _diceOf(entry.heal.formula(lvl, 0));
          const theirs = _itemHealing(item);
          if (mine && theirs && mine !== theirs) {
            issues.push(`healing: ACE rolls ${mine}, the item says ${theirs}`);
          }
        } catch (err) {
          issues.push(`healing: ACE's formula threw (${err?.message ?? err})`);
        }
      }

      // ── 5. The area ──
      const wantArea = entry?.expectedArea ?? spaceEntry?.expectedArea ?? null;
      if (wantArea?.type) {
        const theirs = _itemArea(item);
        const same = { sphere: "sphere", radius: "radius", cylinder: "cylinder",
                       cube: "cube", square: "square", cone: "cone", line: "line", wall: "wall" };
        if (theirs?.type) {
          const a = same[String(wantArea.type).toLowerCase()] ?? String(wantArea.type).toLowerCase();
          const b = theirs.type;
          // radius and sphere are the same shape under two names in dnd5e.
          const round = new Set(["sphere", "radius", "cylinder"]);
          const typeOff = !(a === b || (round.has(a) && round.has(b)));
          const sizeOff = Number(wantArea.size) > 0 && Number(theirs.size) > 0
            && Math.abs(Number(theirs.size) - Number(wantArea.size)) > 0.5;
          if (typeOff || sizeOff) {
            issues.push(`area: ACE expects ${wantArea.type} ${wantArea.size ?? "?"} ft, `
              + `the item declares ${theirs.type} ${theirs.size ?? "?"} ft`);
          }
        }
      }

      compared++;
      if (issues.length) {
        rows.push({ name: item.name, edition: edition ?? "unstated", owner, copies, issues });
      }
    }

    // ── The report ──
    say("");
    say("ACE — REGISTRY VERSUS THE ITEMS ON THESE SHEETS");
    say("-".repeat(72));
    say(`Read ${items.length} distinct spells and feats. ${withEntry} carry an ACE entry. `
      + `${compared} of those could be compared.`);
    say("");
    if (!rows.length) {
      say("Nothing disagrees. Every entry matches the item it describes on the five");
      say("things an entry restates: save ability, range, concentration, healing dice");
      say("and expected area. Damage dice are read off the item and cannot drift.");
    } else {
      say(`${rows.length} disagreement(s). Some may be deliberate — a homebrew, a variant,`);
      say("an edit of yours. This names them and changes nothing.");
      say("");
      for (const r of rows) {
        say(`  ${r.name}  [${r.edition}]  — read from ${r.owner}`
          + (r.copies > 1 ? `, ${r.copies} copies of this name exist and they may differ` : ""));
        for (const i of r.issues) say(`      ${i}`);
      }
    }
    say("-".repeat(72));
    return { checked: items.length, withEntry, compared, rows, text: lines.join("\n") };
  }

  static register() {
    game.aceQol = game.aceQol ?? {};
    Object.assign(game.aceQol, {
      auditSpellRules: (opts) => RegistryAudit.run(opts),
    });
    console.debug(`${LOG} | online — game.aceQol.auditSpellRules()`);
  }
}
