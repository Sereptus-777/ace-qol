#!/usr/bin/env node
/**
 * NOTHING LANDS BEFORE THE DICE.
 *
 * Johnny's rule, months old: nothing touches a creature (a condition on or off,
 * hit points, temp HP), fires a signal other features act on, or shows an
 * answer (a card, or a card redrawn) until the dice that decided it have
 * visibly landed. His words, 2026-09-13: "That was already supposed to be
 * fucking in there. Am I not making myself clear?"
 *
 * WHY THIS EXISTS. The rule lived as a separate wait inside each piece of code.
 * The save engine got its guard on 2026-07-28, the repeating-save engine waits
 * before it removes or escalates, and every engine written after that had to
 * remember it on its own. The Prismatic Wall (0.34.7) put indigo's Restrained
 * and violet's Blinded on Neferon ten seconds before its dice stopped, and a
 * sweep then found about a dozen more places doing the same. Nothing checked.
 *
 * WHAT IT DOES. Reads every script with a real JavaScript parser (espree, the
 * one eslint uses) and follows each function in order:
 *   THROW  dice go into the air: safeShowForRoll, a raw showForRoll, a roll
 *          sent to chat (toMessage, or a card carrying `rolls`, which Dice So
 *          Nice animates), or a dnd5e roll that creates its own message.
 *   WAIT   `await awaitDiceSettle(...)` or `await awaitDsnRoll(...)`, which wait
 *          on the promises Dice So Nice resolves when the dice stop.
 *   LAND   a condition or effect on or off, damage or an HP write, any document
 *          update or delete, a chat card, or `Hooks.callAll` (a signal).
 * A LAND while dice may still be rolling is reported. So is a roll animated by
 * ACE and then handed to chat as well (the same dice tumbling twice).
 *
 * Calls into other functions are followed, but only to the function the call
 * really reaches: one in the same file, an import, a method of a named class,
 * `this` inside a class, or a name that exists exactly once. A helper that
 * throws dice and returns without waiting leaves its caller with dice in the
 * air; a helper that lands before waiting is a landing at every call site.
 *
 * ⚠️ PROVE THE CHECKER FIRST (lesson, 2026-08-26). Its first run matched
 * helpers by name alone: an unrelated `register()` in one file picked up dice
 * thrown in another and every settings call in ace-qol.mjs was "landing before
 * the dice". tools/dice-check-selftest.mjs pins what it must and must not find.
 *
 * A place that is right to land while dice roll says so on its line, or the
 * line above:   // dice-ok: <reason>
 *
 * Usage (from the ace-qol folder):
 *   node tools/dice-check.mjs              ace-qol, plus Forge and Engine beside it
 *   node tools/dice-check.mjs --root DIR   just DIR (repeatable)
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative, dirname, basename, resolve, posix } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { homedir } from "node:os";

const HERE = dirname(dirname(fileURLToPath(import.meta.url)));   // the ace-qol folder

// ─── The parser ──────────────────────────────────────────────────────────────
// ⚠️ NEVER A SILENT SKIP. If the parser cannot be found the check FAILS and says
// how to get it; a check that quietly passes because it could not run is worse
// than no check.
export function loadEspree() {
  const bases = [
    join(HERE, "node_modules"),
    join(process.env.LOCALAPPDATA ?? "", "npm-cache", "_npx"),
    join(homedir(), ".npm", "_npx"),
  ];
  const found = [];
  const consider = (dir) => {
    const pkg = join(dir, "espree", "package.json");
    if (!existsSync(pkg)) return;
    try { found.push({ dir: dirname(pkg), v: JSON.parse(readFileSync(pkg, "utf8")).version }); } catch { /* unreadable */ }
  };
  for (const base of bases) {
    if (!existsSync(base)) continue;
    consider(base);
    for (const d of readdirSync(base)) consider(join(base, d, "node_modules"));
  }
  const num = (v) => String(v).split(".").map(n => parseInt(n, 10) || 0);
  found.sort((a, b) => { const x = num(a.v), y = num(b.v); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return y[i] - x[i]; return 0; });
  if (!found.length) return null;
  return createRequire(join(found[0].dir, "package.json"))(found[0].dir);
}

// ─── What each call does ─────────────────────────────────────────────────────
// ⚠️ NOT setFlag / unsetFlag. A flag is bookkeeping nobody at the table sees
// (a Sneak Attack "used" mark, a replaced-not-ended note); counting them put
// dozens of harmless writes on the list. A card redrawn from a flag is the one
// case this misses, and it is named here so nobody assumes it is covered.
const LAND_NAMES = new Set([
  "applyEffect", "applyByName", "removeEffect", "applyDamage",
  "createEmbeddedDocuments", "deleteEmbeddedDocuments", "updateEmbeddedDocuments",
  "toggleStatusEffect",
]);
// dnd5e rolls that create their own chat message unless told `create: false`.
const ROLL_METHODS = new Set([
  "rollSavingThrow", "rollAbilityCheck", "rollAbilityTest", "rollAbilitySave", "rollSkill",
  "rollToolCheck", "rollDeathSave", "rollHitDie", "rollConcentration", "rollInitiative",
  "rollAttack", "rollDamage", "rollFormula", "rollRecharge",
]);
// ACE QOL's two waits, and Forge's own (Forge runs without ACE QOL, so it
// carries its copy in scripts/dice-wait.mjs).
const WAIT_NAMES = new Set(["awaitDiceSettle", "awaitDsnRoll", "forgeAwaitDice", "untilDiceLand"]);
const SHOW_NAMES = new Set(["safeShowForRoll", "showForRoll"]);

const unchain = (n) => (n && n.type === "ChainExpression") ? n.expression : n;

function calleeParts(call, src) {
  const c = unchain(call.callee);
  if (c.type === "Identifier") return { name: c.name, obj: null, objText: "" };
  if (c.type === "MemberExpression" && !c.computed && c.property.type === "Identifier") {
    const o = unchain(c.object);
    return { name: c.property.name, obj: o, objText: o.type === "ThisExpression" ? "this" : src.slice(o.range[0], o.range[1]) };
  }
  return { name: null, obj: null, objText: "" };
}

function objectHasKey(node, key, value) {
  if (!node || node.type !== "ObjectExpression") return false;
  return node.properties.some(p => p.type === "Property" && !p.computed
    && ((p.key.type === "Identifier" && p.key.name === key) || (p.key.type === "Literal" && p.key.value === key))
    && (value === undefined || (p.value.type === "Literal" && p.value.value === value)));
}

/** throw | wait | land | user | null, plus a few words for the report. */
export function classify(call, src) {
  const { name, obj, objText } = calleeParts(call, src);
  if (!name) return { kind: null };
  if (SHOW_NAMES.has(name)) return { kind: "throw", what: name === "showForRoll" ? "a raw showForRoll" : "safeShowForRoll", show: true };
  if (name === "toMessage") return { kind: "throw", what: "a roll sent to chat" };
  if (name === "create" && /(^|\.)ChatMessage(\.implementation)?$/.test(objText)) {
    return objectHasKey(call.arguments[0], "rolls")
      ? { kind: "throw", what: "a card carrying its rolls" }
      : { kind: "land", what: "a chat card" };
  }
  if (ROLL_METHODS.has(name) && obj) {
    return objectHasKey(call.arguments[2], "create", false) ? { kind: null } : { kind: "throw", what: `${name} with a chat message` };
  }
  if (WAIT_NAMES.has(name)) return { kind: "wait" };
  if (LAND_NAMES.has(name) && obj) return { kind: "land", what: name };
  if ((name === "callAll" || name === "call") && objText === "Hooks") {
    const a = call.arguments[0];
    const sig = a?.type === "Literal" ? a.value : (a?.type === "TemplateLiteral" ? src.slice(a.range[0], a.range[1]) : "a hook");
    return { kind: "land", what: `the signal ${sig}` };
  }
  if (name === "update" && obj && call.arguments.length >= 1
      && ["ObjectExpression", "Identifier", "MemberExpression", "CallExpression", "ArrayExpression"].includes(call.arguments[0].type)) {
    return { kind: "land", what: `${objText}.update` };
  }
  if (name === "delete" && obj && (call.arguments.length === 0 || call.arguments[0].type === "ObjectExpression")) {
    return { kind: "land", what: `${objText}.delete` };
  }
  return { kind: "user", name, objText, member: !!obj };
}

// ─── Collecting functions ────────────────────────────────────────────────────
const FN_TYPES = new Set(["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"]);

function childrenOf(node) {
  const out = [];
  for (const k of Object.keys(node)) {
    if (k === "parent" || k === "loc" || k === "range" || k === "start" || k === "end") continue;
    const v = node[k];
    if (Array.isArray(v)) { for (const x of v) if (x && typeof x.type === "string") out.push(x); }
    else if (v && typeof v.type === "string") out.push(v);
  }
  return out;
}

function nameOf(fn, parent) {
  if (fn.type === "FunctionDeclaration" && fn.id) return fn.id.name;
  if (!parent) return null;
  if (parent.type === "VariableDeclarator" && parent.id.type === "Identifier") return parent.id.name;
  if ((parent.type === "MethodDefinition" || parent.type === "Property" || parent.type === "PropertyDefinition") && !parent.computed) {
    return parent.key.type === "Identifier" ? parent.key.name : (parent.key.type === "Literal" ? String(parent.key.value) : null);
  }
  if (parent.type === "AssignmentExpression" && parent.left.type === "MemberExpression" && !parent.left.computed) return parent.left.property.name;
  return null;
}

function collect(ast, file) {
  const fns = [];
  const walk = (node, parent, cls) => {
    if (FN_TYPES.has(node.type)) fns.push({ node, file, name: nameOf(node, parent), cls });
    const nextCls = (node.type === "ClassDeclaration" || node.type === "ClassExpression") ? (node.id?.name ?? cls) : cls;
    for (const c of childrenOf(node)) walk(c, node, nextCls);
  };
  walk(ast, null, null);
  const imports = new Map();
  for (const node of ast.body) {
    if (node.type !== "ImportDeclaration" || typeof node.source.value !== "string" || !node.source.value.startsWith(".")) continue;
    const from = posix.normalize(posix.join(posix.dirname(file), node.source.value));
    for (const s of node.specifiers) if (s.type === "ImportSpecifier") imports.set(s.local.name, { from, name: s.imported.name });
  }
  return { fns, imports };
}

// ─── Following one function ──────────────────────────────────────────────────
// State is null (nothing of ours in the air) or a note of the dice that are.
const ENTRY = { entry: true, what: "the caller's dice" };
const merge = (a, b) => a ?? b ?? null;
/** New dice beat "whatever the caller had", which beats nothing. */
const exitOf = (states) => states.find(s => s && s !== ENTRY) ?? (states.includes(ENTRY) ? ENTRY : null);

function analyse(fnRec, entry, ctx) {
  const { src, file } = fnRec;
  const exits = [];
  let landsOnEntry = null;
  const shown = new Set();
  const carried = [];

  const lineOf = (n) => n.loc.start.line;
  const report = (node, st, display, inner) => {
    if (st === ENTRY) { landsOnEntry ??= inner; return; }
    if (entry !== null) return;                     // summaries never report
    ctx.report({ file, line: lineOf(node), what: display, from: st });
  };

  // ⚠️ THE ANSWER CAN LAND BEFORE ITS DICE ARE EVEN THROWN. The heal resolver
  // rolled, wrote the new HP, and only then showed the dice. Nothing is "in the
  // air" at the write, so the state above cannot see it. So: a roll that is
  // evaluated and later shown remembers every landing in between.
  const evaluated = new Map();      // roll name -> [{ node, what }] landed since it was rolled
  const noteLanding = (node, what) => { for (const list of evaluated.values()) list.push({ node, what }); };
  const rolledInto = (name, init) => {
    let hit = false;
    const scan = (n) => {
      if (!n || hit || typeof n.type !== "string" || FN_TYPES.has(n.type)) return;
      if (n.type === "CallExpression") {
        const { name: nm, obj } = calleeParts(n, src);
        if (nm === "evaluate" || nm === "evaluateSync" || (ROLL_METHODS.has(nm) && obj && objectHasKey(n.arguments[2], "create", false))) { hit = true; return; }
      }
      for (const c of childrenOf(n)) scan(c);
    };
    scan(init);
    if (hit) evaluated.set(name, []);
  };

  const applyCall = (call, st, awaited) => {
    const k = classify(call, src);
    if (k.kind === "land" || (k.kind === "user" && ctx.summaryFor(k, fnRec)?.lands)) noteLanding(call, k.what ?? `${k.name}()`);
    if (k.kind === "throw") {
      if (k.show && call.arguments[0]?.type === "Identifier") {
        const name = call.arguments[0].name;
        shown.add(name);
        if (entry === null) for (const l of evaluated.get(name) ?? []) {
          ctx.report({ file, line: lineOf(l.node), what: `${l.what}, before the dice for ${name} are even thrown (line ${lineOf(call)})`, before: true });
        }
        evaluated.delete(name);
      }
      if (k.what === "a card carrying its rolls") {
        const rolls = call.arguments[0].properties.find(p => p.type === "Property" && ((p.key.name ?? p.key.value) === "rolls"));
        if (rolls?.value?.type === "ArrayExpression") for (const el of rolls.value.elements) if (el?.type === "Identifier") carried.push({ name: el.name, node: call });
      }
      if (k.what === "a roll sent to chat") {
        const o = calleeParts(call, src).obj;
        if (o?.type === "Identifier") carried.push({ name: o.name, node: call });
      }
      // An awaited raw showForRoll resolves when its dice land.
      if (awaited && k.what === "a raw showForRoll") return null;
      return { file, line: lineOf(call), what: k.what };
    }
    if (k.kind === "wait") return awaited ? null : st;
    if (k.kind === "land") { if (st) report(call, st, k.what, k.what); return st; }
    if (k.kind === "user") {
      const sum = ctx.summaryFor(k, fnRec);
      if (!sum) return st;
      if (st && sum.lands) report(call, st, `${k.name}() (${sum.lands})`, sum.lands);
      if (awaited) {
        const out = st ? sum.outTrue : sum.outFalse;
        return out === ENTRY ? st : (out ?? null);
      }
      return merge(st, sum.outFalse);
    }
    return st;
  };

  const E = (node, st, awaited = false) => {
    if (!node) return st;
    switch (node.type) {
      case "AwaitExpression": return E(node.argument, st, true);
      case "ChainExpression": return E(node.expression, st, awaited);
      case "CallExpression": case "NewExpression": {
        let s = st;
        const callee = unchain(node.callee);
        if (callee.type === "MemberExpression") { s = E(callee.object, s); if (callee.computed) s = E(callee.property, s); }
        else if (callee.type !== "Identifier") s = E(callee, s);
        for (const a of node.arguments) s = E(a, s);
        return node.type === "NewExpression" ? s : applyCall(node, s, awaited);
      }
      case "FunctionExpression": case "ArrowFunctionExpression": case "ClassExpression": return st;
      case "ConditionalExpression": { const s = E(node.test, st); return merge(E(node.consequent, s), E(node.alternate, s)); }
      case "LogicalExpression": { const s = E(node.left, st); return merge(s, E(node.right, s)); }
      case "SequenceExpression": return node.expressions.reduce((s, x) => E(x, s), st);
      case "AssignmentExpression": {
        const out = E(node.right, E(node.left, st));
        if (node.left.type === "Identifier") rolledInto(node.left.name, node.right);
        return out;
      }
      case "MemberExpression": { const s = E(node.object, st); return node.computed ? E(node.property, s) : s; }
      case "ArrayExpression": return node.elements.reduce((s, x) => E(x, s), st);
      case "ObjectExpression": return node.properties.reduce((s, p) => p.type === "SpreadElement" ? E(p.argument, s) : E(p.value, p.computed ? E(p.key, s) : s), st);
      case "TemplateLiteral": return node.expressions.reduce((s, x) => E(x, s), st);
      case "TaggedTemplateExpression": return E(node.quasi, E(node.tag, st));
      case "BinaryExpression": return E(node.right, E(node.left, st));
      case "UnaryExpression": case "UpdateExpression": case "SpreadElement": case "YieldExpression": return E(node.argument, st);
      default: return st;
    }
  };

  // Statements return { st, term } where term means this path left the function.
  const S = (node, st) => {
    if (!node) return { st, term: false };
    switch (node.type) {
      case "BlockStatement": case "StaticBlock": return seq(node.body, st);
      case "ExpressionStatement": return { st: E(node.expression, st), term: false };
      case "VariableDeclaration": return { st: node.declarations.reduce((s, d) => {
        const out = E(d.init, s);
        if (d.id.type === "Identifier" && d.init) rolledInto(d.id.name, d.init);
        return out;
      }, st), term: false };
      case "ReturnStatement": case "ThrowStatement": { const s = E(node.argument, st); exits.push(s); return { st: s, term: true }; }
      case "IfStatement": { const s = E(node.test, st); return join2(S(node.consequent, s), node.alternate ? S(node.alternate, s) : { st: s, term: false }); }
      case "ForStatement": {
        const s = node.init ? (node.init.type === "VariableDeclaration" ? S(node.init, st).st : E(node.init, st)) : st;
        return loop((x) => { const r = S(node.body, E(node.test, x)); return { st: E(node.update, r.st), term: r.term }; }, s);
      }
      case "ForOfStatement": case "ForInStatement": return loop((x) => S(node.body, x), E(node.right, st));
      case "WhileStatement": return loop((x) => S(node.body, E(node.test, x)), st);
      case "DoWhileStatement": return loop((x) => { const r = S(node.body, x); return { st: E(node.test, r.st), term: r.term }; }, st);
      case "TryStatement": {
        // ⚠️ A CATCH IS THE ROLL FAILING, NOT THE ROLL LANDING. It starts from
        // what was in the air when the try began (so a catch that lands while
        // earlier dice roll is still reported), and it carries dice forward only
        // if it threw some itself: `try { await awaitDsnRoll(); } catch (_) {}`
        // must not read as "the wait may not have happened".
        const t = S(node.block, st);
        let res = t;
        if (node.handler) {
          const h = S(node.handler.body, st);
          if (t.term && h.term) res = { st: merge(t.st, h.st), term: true };
          else if (t.term) res = h;
          else if (h.term) res = t;
          else res = { st: (h.st && h.st !== st) ? merge(t.st, h.st) : t.st, term: false };
        }
        if (node.finalizer) { const f = S(node.finalizer, res.st); res = { st: f.st, term: res.term || f.term }; }
        return res;
      }
      case "SwitchStatement": {
        const s0 = E(node.discriminant, st);
        let out = null, carry = null;
        const endsWithBreak = (list) => {
          const last = list[list.length - 1];
          return !!last && (last.type === "BreakStatement" || (last.type === "BlockStatement" && endsWithBreak(last.body)));
        };
        for (const c of node.cases) {
          const r = seq(c.consequent, merge(s0, carry));
          // `break` ends the case: nothing falls into the next one.
          carry = (r.term || endsWithBreak(c.consequent)) ? null : r.st;
          if (!r.term) out = merge(out, r.st);
        }
        if (!node.cases.some(c => !c.test)) out = merge(out, s0);
        return { st: merge(out, carry), term: false };
      }
      case "LabeledStatement": return S(node.body, st);
      default: return { st, term: false };
    }
  };
  const seq = (list, st) => {
    let s = st;
    for (const x of list) { const r = S(x, s); if (r.term) return { st: r.st, term: true }; s = r.st; }
    return { st: s, term: false };
  };
  const join2 = (a, b) => (a.term && b.term) ? { st: merge(a.st, b.st), term: true }
    : a.term ? b : b.term ? a : { st: merge(a.st, b.st), term: false };
  const loop = (body, st) => {
    const r1 = body(st);
    const again = merge(st, r1.term ? null : r1.st);
    const r2 = body(again);
    return { st: merge(st, merge(r1.term ? null : r1.st, r2.term ? null : r2.st)), term: false };
  };

  const fn = fnRec.node;
  if (fn.body.type === "BlockStatement") { const r = seq(fn.body.body, entry); if (!r.term) exits.push(r.st); }
  else exits.push(E(fn.body, entry));

  // The same dice animated by ACE and then handed to chat, which animates them again.
  if (entry === null) for (const c of carried) if (shown.has(c.name)) {
    ctx.report({ file, line: c.node.loc.start.line, what: `${c.name}, already animated, is sent to chat as well`, twice: true });
  }
  return { exit: exitOf(exits), landsOnEntry };
}

// ─── One root: every function, followed until the helpers settle ─────────────
export function checkSources(sources /* [{file, src}] */, espree) {
  const recs = [];
  const files = new Map();       // file -> { imports, okLines }
  const parseErrors = [];
  for (const { file, src } of sources) {
    let ast;
    try { ast = espree.parse(src, { ecmaVersion: "latest", sourceType: "module", range: true, loc: true, comment: true }); }
    catch (err) { parseErrors.push({ file, why: err.message }); continue; }
    const okLines = new Set();
    for (const c of ast.comments ?? []) if (/dice-ok:\s*\S/.test(c.value)) for (let l = c.loc.start.line; l <= c.loc.end.line + 1; l++) okLines.add(l);
    const { fns, imports } = collect(ast, file);
    files.set(file, { imports, okLines });
    for (const f of fns) recs.push({ ...f, src });
  }
  const byName = new Map();
  for (const r of recs) if (r.name) { if (!byName.has(r.name)) byName.set(r.name, []); byName.get(r.name).push(r); }

  /** The functions a call really reaches, or none when that cannot be told. */
  const reach = (k, from) => {
    const all = byName.get(k.name) ?? [];
    if (!all.length) return [];
    if (!k.member) {
      const here = all.filter(d => d.file === from.file);
      if (here.length) return here;
      const imp = files.get(from.file)?.imports.get(k.name);
      return imp ? (byName.get(imp.name) ?? []).filter(d => d.file === imp.from || d.file === imp.from.replace(/\.m?js$/, "") ) : [];
    }
    if (k.objText === "this") {
      const sameClass = all.filter(d => d.file === from.file && d.cls && d.cls === from.cls);
      return sameClass.length ? sameClass : all.filter(d => d.file === from.file && d.cls);
    }
    if (/^[A-Z][\w$]*$/.test(k.objText)) return all.filter(d => d.cls === k.objText);
    // ⚠️ AN OBJECT THE CHECK CANNOT NAME. `engine._rollSingleSave()` is ACE's
    // one `_rollSingleSave`; `seq.play()` is Sequencer's, not ACE's one `play`.
    // Only a name that exists once AND reads as ACE's own (a leading underscore,
    // or a long camelCase name) is followed; short common verbs never are.
    const distinctive = k.name.startsWith("_") || (k.name.length >= 10 && /[a-z][A-Z]/.test(k.name));
    return (all.length === 1 && distinctive) ? all : [];
  };

  let summaries = new Map();   // rec -> { outFalse, outTrue, lands }
  const summaryFor = (k, from) => {
    const defs = reach(k, from);
    if (!defs.length) return null;
    const sums = defs.map(d => summaries.get(d)).filter(Boolean);
    if (!sums.length) return null;
    return {
      outFalse: sums.map(s => s.outFalse).find(Boolean) ?? null,
      outTrue: exitOf(sums.map(s => s.outTrue)),
      lands: sums.map(s => s.lands).find(Boolean) ?? null,
    };
  };
  const silent = { report: () => {}, summaryFor };
  const sig = (s) => `${!!s.outFalse}|${s.outTrue === ENTRY ? "E" : !!s.outTrue}|${!!s.lands}`;
  for (let pass = 0; pass < 20; pass++) {
    const next = new Map();
    let changed = false;
    for (const r of recs) {
      const a = analyse(r, null, silent);
      const b = analyse(r, ENTRY, silent);
      const s = { outFalse: a.exit === ENTRY ? null : a.exit, outTrue: b.exit, lands: b.landsOnEntry };
      const old = summaries.get(r);
      if (!old || sig(old) !== sig(s)) changed = true;
      next.set(r, s);
    }
    summaries = next;
    if (!changed) break;
  }

  const findings = [];
  const seen = new Set();
  const ctx = {
    summaryFor,
    report: (f) => {
      if (files.get(f.file)?.okLines.has(f.line)) return;
      const key = `${f.file}:${f.line}:${f.what}`;
      if (seen.has(key)) return;
      seen.add(key);
      findings.push(f);
    },
  };
  for (const r of recs) analyse(r, null, ctx);
  findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  return { findings, parseErrors };
}

// ─── Command line ────────────────────────────────────────────────────────────
function scriptsUnder(root) {
  const out = [];
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      if (["node_modules", "lib", "libs", "vendor", "dist", "packs"].includes(name)) continue;
      const p = join(d, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else if (/\.(mjs|js)$/.test(name)) out.push(p);
    }
  };
  walk(root);
  return out;
}

async function main() {
  const args = process.argv.slice(2);
  let roots = [];
  for (let i = 0; i < args.length; i++) if (args[i] === "--root") roots.push(resolve(args[++i]));
  if (!roots.length) {
    roots = [join(HERE, "scripts")];
    for (const sib of ["ace-artificer/scripts", "ace-engine/scripts"]) {
      const p = resolve(HERE, "..", sib);
      if (existsSync(p)) roots.push(p);
      else console.log(`(not checked: ${sib} is not beside ace-qol)`);
    }
  }
  const espree = loadEspree();
  if (!espree) {
    console.log("The dice check could not find its parser (espree). The lint check installs it:");
    console.log("  npx --yes eslint@9 --version");
    console.log("0 passed, 1 failed");
    process.exit(1);
  }
  let total = 0, twice = 0, broken = 0;
  console.log("DICE CHECK: nothing lands before the dice that decided it\n");
  for (const root of roots) {
    const files = scriptsUnder(root);
    const sources = files.map(f => ({ file: relative(resolve(HERE, ".."), f).replace(/\\/g, "/"), src: readFileSync(f, "utf8") }));
    const { findings, parseErrors } = checkSources(sources, espree);
    for (const e of parseErrors) { console.log(`  COULD NOT READ ${e.file}: ${e.why}`); broken++; }
    for (const f of findings) {
      if (f.twice) { twice++; console.log(`  ${f.file}:${f.line}  the same dice twice: ${f.what}`); continue; }
      total++;
      const from = f.from?.line ? `${f.from.what} (${f.from.file === f.file ? "line " : f.from.file.replace(/^.*\//, "") + ":"}${f.from.line})` : "dice";
      console.log(`  ${f.file}:${f.line}  ${f.what}, while ${from} may still be rolling`);
    }
    console.log(`  (${basename(dirname(root))}: ${files.length} files)`);
  }
  console.log(`\n${total} places land before their dice, ${twice} rolls shown twice, ${broken} files unreadable.`);
  process.exit(total + twice + broken ? 1 : 0);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
