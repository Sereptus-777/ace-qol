// ─── ACE: QOL — A formula's value, the way dnd5e works it out at load ──────
//
// dnd5e writes some sizes and counts as formulas. In hijinx, Fog Cloud's sphere
// is "20 * @item.level", Hold Person's targets "@item.level - 1", Krusk's aura
// "@scale.paladin.aura". At load dnd5e 5.3.3 replaces each @reference from the
// roll data, a missing one becoming 0 (replaceFormulaData), and works the
// arithmetic out (prepareFormulaValue). This does the same with no Foundry and
// no dice, so the recipe reader and the replay work a formula out one way.
//
// ⚠️ IMPORTS NOTHING, so anything can use it without an import cycle.
// ──────────────────────────────────────────────────────────────────────────────

const REF = /@([a-z.0-9_-]+)/gi;
const get = (obj, path) => String(path).split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);
const FUNCS = { max: Math.max, min: Math.min, floor: Math.floor, ceil: Math.ceil,
                round: Math.round, abs: Math.abs };

/** The formula with each @reference filled from `data`; a missing one becomes "0", as dnd5e does. */
export function fillFormula(formula, data = {}) {
  const missing = [];
  const text = String(formula ?? "").replace(REF, (match, term) => {
    const v = get(data, term);
    if (v === null || v === undefined) { missing.push(match); return "0"; }
    return String(v).trim();
  });
  return { text, missing };
}

/**
 * Plain arithmetic: numbers, + - * / %, brackets, and max, min, floor, ceil,
 * round and abs.
 *
 * @returns {number|null} null when the text is not plain arithmetic (dice,
 *   words), which the caller reports; it is never a guessed number.
 */
export function arithmetic(text) {
  const src = String(text ?? "");
  let i = 0;
  const ws = () => { while (i < src.length && /\s/.test(src[i])) i++; };
  const fail = () => { throw new Error("not plain arithmetic"); };
  // Declared first: a bracket or a function's arguments are a whole expression.
  let expr = null;
  const primary = () => {
    ws();
    const c = src[i];
    if (c === "(") {
      i++;
      const v = expr();
      ws();
      if (src[i] !== ")") fail();
      i++;
      return v;
    }
    if (c === "-") { i++; return -primary(); }
    if (c === "+") { i++; return primary(); }
    const num = /^\d+(?:\.\d+)?/.exec(src.slice(i));
    if (num) { i += num[0].length; return Number(num[0]); }
    const name = /^[a-z]+/i.exec(src.slice(i));
    const fn = name ? FUNCS[name[0].toLowerCase()] : null;
    if (!fn) return fail();
    i += name[0].length;
    ws();
    if (src[i] !== "(") fail();
    i++;
    const args = [];
    ws();
    if (src[i] !== ")") {
      for (;;) {
        args.push(expr());
        ws();
        if (src[i] !== ",") break;
        i++;
      }
    }
    if (src[i] !== ")") fail();
    i++;
    return fn(...args);
  };
  const term = () => {
    let v = primary();
    for (;;) {
      ws();
      const c = src[i];
      if (c === "*") { i++; v *= primary(); }
      else if (c === "/") { i++; v /= primary(); }
      else if (c === "%") { i++; v %= primary(); }
      else return v;
    }
  };
  expr = () => {
    let v = term();
    for (;;) {
      ws();
      const c = src[i];
      if (c === "+") { i++; v += term(); }
      else if (c === "-") { i++; v -= term(); }
      else return v;
    }
  };
  try {
    const v = expr();
    ws();
    return (i === src.length && Number.isFinite(v)) ? v : null;
  } catch (_) {
    return null;   // not plain arithmetic: the null is the answer, and callers name it
  }
}

/**
 * A formula worked out as dnd5e does at load.
 *
 * @returns {{value: number|null, missing: string[]}} `missing` lists the
 *   references that were not in the data and so counted as 0.
 */
export function formulaValue(formula, data = {}) {
  if (typeof formula === "number") return { value: formula, missing: [] };
  if (formula === null || formula === undefined || String(formula).trim() === "") {
    return { value: null, missing: [] };
  }
  const { text, missing } = fillFormula(formula, data);
  return { value: arithmetic(text), missing };
}

/**
 * How much a stored formula grows for each spell level above the one it is
 * written for: Hold Person's "@item.level - 1" gains 1 target, Fog Cloud's
 * "20 * @item.level" gains 20 feet.
 *
 * @returns {number|null} null when it does not depend on the level alone.
 */
export function growthPerLevel(formula, level) {
  const f = String(formula ?? "");
  if (!/@(?:item\.level|scaling)\b/i.test(f)) return null;
  // An ability or a class scale is about the caster, not the slot.
  if (/@(?!item\.level\b|scaling\b)[a-z]/i.test(f)) return null;
  const at = (step) => formulaValue(f.replace(/@scaling(?:\.increase)?\b/gi, String(step)),
    { item: { level: (Number(level) || 0) + step } }).value;
  const a = at(0), b = at(1);
  return (a === null || b === null) ? null : b - a;
}
