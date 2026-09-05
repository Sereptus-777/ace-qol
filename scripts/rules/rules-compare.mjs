// ─── ACE: QOL — Does his item agree with the book? ───────────────────────────
//
// Johnny, 2026-09-05: "I want it to fucking check immediately. And let me know
// if there's some sort of problem or disagreement between the button that was
// pushed and the rules as written."
//
// ⚠️🔴 THE ITEM ALWAYS WINS. This file REPORTS, it never overrides, and that is
// not caution, it is a scar. On 2026-09-05 I told him "120 feet is not a number
// Spare the Dying has ever had", believed my own audit over his sheet, and
// handed him a snippet that changed items which were already right. It is a
// 2024 cantrip whose range doubles at 5th, 11th and 17th. His data wins until
// the ITEM proves otherwise, every time. A disagreement is a sentence on his
// screen, never an edit and never a different roll.
//
// ⚠️ ONE READER, TWO USES. `readMechanics` is run over HIS item and over the
// book's entry with the same code. Two readers of one shape drift apart exactly
// the way ACE's cast-time and entry-time template geometry did, and that bug
// let a creature half inside Moonbeam be hit on the cast and take nothing
// walking back in.
//
// ⚠️ A MISSING FIELD IS NOT A DISAGREEMENT. Half the SRD entries leave a field
// blank that his DDB import fills in, and reporting every one of those would
// produce a wall he stops reading — which is how the "areas that are never
// drawn" card ended up ignored. Nothing is reported unless BOTH sides state a
// value and the two values genuinely differ.
// ──────────────────────────────────────────────────────────────────────────────

const MODULE_ID = "ace-qol";

/* ── Reading ──────────────────────────────────────────────────────────────── */

/** dnd5e stores several of these as a Set. Normalise to a sorted array. */
function _list(v) {
  if (!v) return [];
  if (v instanceof Set) return [...v].map(String).sort();
  if (Array.isArray(v)) return v.map(String).sort();
  return [String(v)];
}

function _num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** The activities on an item, whatever shape this dnd5e build stores them in. */
function _activities(item) {
  const a = item?.system?.activities;
  if (!a) return [];
  if (typeof a.contents !== "undefined") return [...a.contents];
  if (Array.isArray(a)) return a;
  if (typeof a === "object") return Object.values(a);
  return [];
}

/** Range in feet, or a word ("self", "touch", "any") when it is not a distance. */
function _rangeOf(src) {
  const r = src?.range ?? {};
  const units = String(r.units ?? "").toLowerCase();
  if (!units && !r.value) return null;
  if (units === "self") return "self";
  if (units === "touch") return "touch";
  if (units === "any" || units === "unlimited" || units === "spec") return "any";
  const v = _num(r.value);
  if (v === null) return null;
  if (units === "mi" || units === "miles") return v * 5280;
  return v;                                   // feet
}

/**
 * Everything worth comparing, pulled off any item the same way.
 *
 * ⚠️ ACTIVITY FIRST, THEN THE ITEM. dnd5e 5.x keeps the real numbers on the
 * ACTIVITY and leaves a derived copy at item level; reading the item first gets
 * the stale one. The activity-not-item rule, learned the hard way on titles.
 */
export function readMechanics(item) {
  const sys = item?.system ?? {};
  const acts = _activities(item);
  const props = _list(sys.properties);
  // A spell with an empty properties list has told us it concentrates on nothing.
  // A spell with no properties field at all has told us nothing.
  const hasProps = sys.properties !== undefined && sys.properties !== null;

  // The activity that carries the mechanics: prefer one that actually resolves
  // something over a bare utility entry.
  const RANKED = ["attack", "save", "damage", "heal", "check", "utility"];
  const main = acts.slice().sort(
    (a, b) => RANKED.indexOf(a?.type ?? "") - RANKED.indexOf(b?.type ?? "")
  ).find(a => RANKED.includes(a?.type ?? "")) ?? acts[0] ?? null;

  const out = {
    readable: !!item,
    name: item?.name ?? null,
    itemType: item?.type ?? null,
    level: _num(sys.level),
    school: sys.school ? String(sys.school) : null,
    // ⚠️🔴 "NO" IS AN ANSWER; ONLY AN ABSENT FIELD IS SILENCE. Written as
    // `props.includes(...) || null` this turned every non-concentration spell
    // into "says nothing", and the comparison below skips anything that says
    // nothing — so a spell that had LOST its concentration could never be
    // reported. Caught by the self-test before it shipped. Same family as the
    // blank ElevenLabs key: an empty value is not the same as no value.
    concentration: hasProps ? props.includes("concentration") : null,
    ritual: hasProps ? props.includes("ritual") : null,
    range: _rangeOf(main) ?? _rangeOf(sys),
    activityType: main?.type ?? null,
    attackType: null,
    save: [],
    damage: [],
    healing: null,
    template: null,
    targetCount: null,
  };

  if (main?.type === "attack") {
    const cls = main.attack?.type?.classification ?? null;   // "weapon" | "spell"
    const val = main.attack?.type?.value ?? null;            // "melee" | "ranged"
    out.attackType = (cls && val) ? `${val} ${cls}` : null;
  }

  if (main?.save?.ability) out.save = _list(main.save.ability);

  const dparts = main?.damage?.parts ?? [];
  for (const p of dparts) {
    const f = p?.formula ?? (p?.custom?.enabled ? p.custom.formula : null)
           ?? (p?.number && p?.denomination ? `${p.number}d${p.denomination}` : null);
    if (!f) continue;
    out.damage.push({ formula: String(f).trim(), types: _list(p?.types ?? p?.type) });
  }

  const h = main?.healing;
  if (h) {
    const f = h.formula ?? (h.custom?.enabled ? h.custom.formula : null)
           ?? (h.number && h.denomination ? `${h.number}d${h.denomination}` : null);
    if (f) out.healing = { formula: String(f).trim(), types: _list(h.types ?? h.type) };
  }

  const tgt = main?.target ?? sys.target ?? {};
  const tpl = tgt?.template ?? {};
  if (tpl?.type) {
    out.template = {
      type: String(tpl.type),
      size: _num(tpl.size),
      width: _num(tpl.width),
      height: _num(tpl.height),
    };
  }
  const count = _num(tgt?.affects?.count) ?? _num(sys.target?.value);
  if (count !== null && count > 0) out.targetCount = count;

  return out;
}

/* ── Comparing ────────────────────────────────────────────────────────────── */

/** Both sides must actually state something before a difference means anything. */
function _both(a, b) {
  return a !== null && a !== undefined && a !== "" && b !== null && b !== undefined && b !== "";
}

/** A dice formula, with the noise taken out so "2d8+3" and "2d8 + 3" agree. */
function _fnorm(f) {
  return String(f ?? "").toLowerCase().replace(/\s+/g, "").replace(/\+\+/g, "+");
}

/** Feet, or a word. Prints the way he would say it. */
function _rangeWord(r) {
  if (r === "self") return "self";
  if (r === "touch") return "touch";
  if (r === "any") return "any distance";
  return `${r} feet`;
}

/**
 * Compare his item against the book entry.
 *
 * @returns {{count:number, lines:string[], fields:object[]}}
 *   `lines` are plain English, ready to show him. `fields` is the same thing
 *   structured, for anything that wants to act on it later.
 */
export function compareToBook(mine, book, { edition = "2014" } = {}) {
  const lines = [];
  const fields = [];
  const say = (field, msg, yours, theirs) => {
    lines.push(msg);
    fields.push({ field, yours, theirs });
  };

  if (!mine?.readable || !book?.readable) {
    return { count: 0, lines: [], fields: [], note: "nothing to compare" };
  }

  const ed = edition === "2024" ? "2024" : "2014";
  const bookSays = `the ${ed} book says`;

  // ── Spell level ──
  if (_both(mine.level, book.level) && mine.level !== book.level) {
    say("level", `Your copy is level ${mine.level}; ${bookSays} level ${book.level}.`,
      mine.level, book.level);
  }

  // ── Concentration. The one that quietly changes how a whole fight goes. ──
  if (mine.concentration !== null && book.concentration !== null
      && !!mine.concentration !== !!book.concentration) {
    say("concentration",
      mine.concentration
        ? `Your copy needs concentration; ${bookSays} it does not.`
        : `Your copy does not need concentration; ${bookSays} it does.`,
      !!mine.concentration, !!book.concentration);
  }

  // ── Range ──
  if (_both(mine.range, book.range) && String(mine.range) !== String(book.range)) {
    say("range", `Your copy has a range of ${_rangeWord(mine.range)}; `
      + `${bookSays} ${_rangeWord(book.range)}.`, mine.range, book.range);
  }

  // ── The area. This is the one that was 40 feet on his Death Knight's Web. ──
  if (mine.template && book.template) {
    if (mine.template.type !== book.template.type) {
      say("template.type", `Your copy makes a ${mine.template.type}; `
        + `${bookSays} a ${book.template.type}.`, mine.template.type, book.template.type);
    } else if (_both(mine.template.size, book.template.size)
               && mine.template.size !== book.template.size) {
      say("template.size", `Your copy's ${mine.template.type} is ${mine.template.size} feet; `
        + `${bookSays} ${book.template.size} feet.`, mine.template.size, book.template.size);
    }
  }

  // ── Which save, if any. A wrong ability here fails the wrong creatures. ──
  if (mine.save.length && book.save.length
      && mine.save.join(",") !== book.save.join(",")) {
    say("save", `Your copy calls for a ${mine.save.join(" or ").toUpperCase()} save; `
      + `${bookSays} ${book.save.join(" or ").toUpperCase()}.`, mine.save, book.save);
  }

  // ── Melee or ranged, weapon or spell ──
  if (_both(mine.attackType, book.attackType) && mine.attackType !== book.attackType) {
    say("attackType", `Your copy is a ${mine.attackType} attack; `
      + `${bookSays} a ${book.attackType} attack.`, mine.attackType, book.attackType);
  }

  // ── Damage. Compared per slot, because a spell can have several parts. ──
  const n = Math.min(mine.damage.length, book.damage.length);
  for (let i = 0; i < n; i++) {
    const a = mine.damage[i], b = book.damage[i];
    if (_fnorm(a.formula) !== _fnorm(b.formula)) {
      say("damage.formula", `Your copy deals ${a.formula}; ${bookSays} ${b.formula}.`,
        a.formula, b.formula);
    }
    if (a.types.length && b.types.length && a.types.join(",") !== b.types.join(",")) {
      say("damage.type", `Your copy deals ${a.types.join(" and ")} damage; `
        + `${bookSays} ${b.types.join(" and ")}.`, a.types, b.types);
    }
  }

  // ── Healing. This is where Cure Wounds was healing half. ──
  if (mine.healing && book.healing
      && _fnorm(mine.healing.formula) !== _fnorm(book.healing.formula)) {
    say("healing.formula", `Your copy heals ${mine.healing.formula}; `
      + `${bookSays} ${book.healing.formula}.`, mine.healing.formula, book.healing.formula);
  }

  // ── How many creatures ──
  if (_both(mine.targetCount, book.targetCount) && mine.targetCount !== book.targetCount) {
    say("targetCount", `Your copy affects ${mine.targetCount} creature(s); `
      + `${bookSays} ${book.targetCount}.`, mine.targetCount, book.targetCount);
  }

  return { count: lines.length, lines, fields, note: null };
}

/**
 * ⚠️ A CANTRIP'S RANGE AND DICE ARE SUPPOSED TO CHANGE, so comparing them to
 * the book's level-1 numbers manufactures a disagreement on a correct item.
 *
 * This cost a whole exchange on 2026-09-05: I reported his Cleric 17's Spare
 * the Dying at 120 feet as an importer's default and had him "fix" items that
 * were right. It doubles at 5th, 11th and 17th. Cantrips are checked for the
 * things that do NOT scale, and nothing else.
 */
export const SCALES_WITH_LEVEL = new Set([
  "range", "damage.formula", "healing.formula", "targetCount",
]);

export function isCantrip(item) {
  return item?.type === "spell" && Number(item?.system?.level) === 0;
}

/** Drop the findings that a cantrip is SUPPOSED to have. */
export function filterForCantrip(result) {
  const keep = result.fields.filter(f => !SCALES_WITH_LEVEL.has(f.field));
  const dropped = result.fields.length - keep.length;
  const lines = result.lines.filter((_, i) => !SCALES_WITH_LEVEL.has(result.fields[i].field));
  return { count: keep.length, lines, fields: keep, droppedForScaling: dropped, note: result.note };
}
