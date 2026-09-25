#!/usr/bin/env node
/**
 * A NAME THE OTHER FILE DOES NOT EXPORT.
 *
 * WHY THIS EXISTS (2026-09-25). Forge's polymorph trap and summon trap both did
 * this, for five months:
 *
 *     const { playTrapAnimation } = await import("./trap-behavior.mjs");
 *     animationPromise = playTrapAnimation(trapDef, { template });
 *
 * trap-behavior.mjs does not export playTrapAnimation; trap-engine.mjs does.
 * So the name is undefined, the call throws, and the catch beside it says
 * "trap animation unavailable (trap still fires)" into a console nobody reads.
 * Neither of those two traps had EVER played its animation at his table.
 *
 * Nothing catches this shape. The module being imported is real, so the load
 * succeeds. eslint's no-undef sees a declared binding. dead-import-check.py
 * asks the opposite question (a name imported and never read). A destructured
 * name that does not exist is simply undefined, and undefined is only ever
 * found by calling it.
 *
 * WHAT IT READS. Every ACE script, with a real parser (espree, the one eslint
 * uses), in every form this codebase actually uses:
 *   import { a, b as c } from "./x.mjs"        static, by name
 *   import d from "./x.mjs"                    static, the default
 *   export { a } from "./x.mjs"                a re-export
 *   const { a } = await import("./x.mjs")      awaited, destructured
 *   (await import("./x.mjs")).a                awaited, read straight off
 *   import("./x.mjs").then(({ a }) => ...)     the promise form, destructured
 *   import("./x.mjs").then(m => m.a)           the promise form, off the module
 *   const m = await import("./x.mjs"); m.a     awaited into a binding
 *   import * as NS from "./x.mjs"; NS.a        a namespace, read by name
 * and a relative path that resolves to no file at all.
 *
 * `export * from "./y.mjs"` is followed, so a name re-exported through a chain
 * of files counts as exported.
 *
 * NEVER A SILENT SKIP (lesson, 2026-08-26). A module this cannot read (a parse
 * error, or an `export *` from a package whose names are unknowable) is OPAQUE:
 * its consumers are not judged, and every opaque module is named in the report.
 * A computed path (`await import(someVariable)`) is counted out loud. A module
 * that is not installed beside ace-qol is said out loud, not skipped.
 *
 * PROVE THE CHECKER FIRST (lesson, 2026-08-26). Four of my own tools have handed
 * back confident wrong numbers. A regex version of this check missed both Forge
 * bugs: the pattern for a destructure matched from the `try {` above the line,
 * because a character class that excludes a closing brace still allows an
 * opening one. tools/missing-export-selftest.mjs pins what this must and must
 * not find.
 *
 * A place that is right to read a name that is not there says so on its line,
 * or the line above:   // export-ok: <reason>
 *
 * Usage (from the ace-qol folder):
 *   node tools/missing-export-check.mjs           every ACE module beside it
 *   node tools/missing-export-check.mjs --root D  just D (repeatable)
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname, resolve, relative, basename } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadEspree } from "./dice-check.mjs";

const HERE = dirname(dirname(fileURLToPath(import.meta.url)));    // the ace-qol folder
const MODULES = dirname(HERE);                                     // Data/modules
const PARSE = { ecmaVersion: "latest", sourceType: "module", range: true, loc: true, comment: true };

/* The five modules, and where each one keeps its code.
   ENVOY LIVES IN src/, NOT scripts/. Every "all four modules" sweep before
   2026-08-16 silently audited three. Both folders are listed, and a module that
   is not installed here is said out loud rather than passed over. */
const SUITE = [
  ["ACE QOL",       "ace-qol",       ["scripts"]],
  ["ACE Forge",     "ace-artificer", ["scripts"]],
  ["ACE Engine",    "ace-engine",    ["scripts"]],
  ["ACE Envoy",     "ace-envoy",     ["src", "scripts"]],
  ["ACE Token Art", "ace-token-art", ["scripts"]],
];

const unchain = (n) => (n && n.type === "ChainExpression") ? n.expression : n;
const isImportCall = (n) => !!n && (n.type === "ImportExpression" || (n.type === "CallExpression" && n.callee?.type === "Import"));
const importSource = (n) => (n.type === "ImportExpression" ? n.source : n.arguments?.[0]);
const awaitedImport = (n) => (n?.type === "AwaitExpression" && isImportCall(unchain(n.argument))) ? unchain(n.argument) : null;

function childrenOf(node) {
  const out = [];
  for (const k of Object.keys(node)) {
    if (k === "loc" || k === "range" || k === "start" || k === "end" || k === "parent") continue;
    const v = node[k];
    if (Array.isArray(v)) { for (const x of v) if (x && typeof x.type === "string") out.push(x); }
    else if (v && typeof v.type === "string") out.push(v);
  }
  return out;
}

const walk = (node, fn) => { fn(node); for (const c of childrenOf(node)) walk(c, fn); };

/** Every name an object pattern pulls out, spelled as the other module spells it. */
function patternNames(pat) {
  const out = [];
  if (!pat || pat.type !== "ObjectPattern") return out;
  for (const p of pat.properties) {
    if (p.type === "RestElement") continue;            // a rest takes whatever is there
    if (p.computed) continue;                          // a computed key cannot be read here
    if (p.key.type === "Identifier") out.push({ name: p.key.name, node: p.key });
    else if (p.key.type === "Literal" && typeof p.key.value === "string") out.push({ name: p.key.value, node: p.key });
  }
  return out;
}

/** Non-computed reads of one binding's properties, anywhere inside a scope. */
function memberReads(scope, bindingName) {
  const out = [];
  walk(scope, (n) => {
    if (n.type !== "MemberExpression" || n.computed) return;
    const o = unchain(n.object);
    if (o?.type === "Identifier" && o.name === bindingName && n.property.type === "Identifier") {
      out.push({ name: n.property.name, node: n.property });
    }
  });
  return out;
}

/* ==========================================================================
   What one module exports
   ========================================================================== */

/**
 * @param {(path:string)=>string|null} load                 a file's source, or null
 * @param {(from:string,spec:string)=>object} resolveSpec   {path} | {bare:true} | {missing}
 */
export function makeReader(load, resolveSpec, espree) {
  const asts = new Map();        // path -> { ast, src } | { why }
  const exportsOf = new Map();   // path -> { names:Set, opaque:string|null }

  const astFor = (path) => {
    if (asts.has(path)) return asts.get(path);
    const src = load(path);
    let rec;
    if (src === null) rec = { why: "the file could not be read" };
    else {
      try { rec = { ast: espree.parse(src, PARSE), src }; }
      catch (err) { rec = { why: `it does not parse: ${err.message}` }; }
    }
    asts.set(path, rec);
    return rec;
  };

  /** The names a module exports, and why it is opaque when it is. */
  const namesFor = (path, chain = new Set()) => {
    if (exportsOf.has(path)) return exportsOf.get(path);
    if (chain.has(path)) return { names: new Set(), opaque: null };   // a cycle adds nothing
    chain.add(path);
    const rec = astFor(path);
    if (rec.why) {
      const out = { names: new Set(), opaque: rec.why };
      exportsOf.set(path, out);
      return out;
    }
    const names = new Set();
    let opaque = null;
    for (const node of rec.ast.body) {
      if (node.type === "ExportDefaultDeclaration") { names.add("default"); continue; }
      if (node.type === "ExportAllDeclaration") {
        if (node.exported) { names.add(node.exported.name ?? node.exported.value); continue; }   // export * as NS from
        const r = resolveSpec(path, node.source.value);
        if (r.bare) { opaque ??= `it re-exports everything from "${node.source.value}", whose names are not ours to know`; continue; }
        if (r.missing) { opaque ??= `it re-exports everything from "${node.source.value}", which resolves to no file`; continue; }
        const inner = namesFor(r.path, chain);
        for (const n of inner.names) names.add(n);
        if (inner.opaque) opaque ??= `through ${r.path}: ${inner.opaque}`;
        continue;
      }
      if (node.type !== "ExportNamedDeclaration") continue;
      for (const s of node.specifiers ?? []) names.add(s.exported.name ?? s.exported.value);
      const d = node.declaration;
      if (!d) continue;
      if (d.type === "FunctionDeclaration" || d.type === "ClassDeclaration") { if (d.id) names.add(d.id.name); continue; }
      if (d.type === "VariableDeclaration") {
        for (const dec of d.declarations) {
          if (dec.id.type === "Identifier") { names.add(dec.id.name); continue; }
          walk(dec.id, (n) => {                       // export const { a, b } = ... and [a, b] = ...
            if (n.type === "Property" && !n.computed && n.value?.type === "Identifier") names.add(n.value.name);
            else if (n.type === "ArrayPattern") for (const el of n.elements) if (el?.type === "Identifier") names.add(el.name);
            else if (n.type === "RestElement" && n.argument?.type === "Identifier") names.add(n.argument.name);
          });
        }
      }
    }
    const out = { names, opaque };
    exportsOf.set(path, out);
    return out;
  };

  return { astFor, namesFor };
}

/* ==========================================================================
   Every name one file asks another for
   ========================================================================== */

/** { asks: [{ spec, name, node, how }], computed: [node] } */
function asksOf(ast) {
  const asks = [];
  const computed = [];
  const add = (spec, name, node, how) => asks.push({ spec, name, node, how });

  // A binding that holds a whole module: `import * as NS from "./x"`, or
  // `const m = await import("./x")`. A name shadowed elsewhere in the file is
  // left alone, because which module `m.foo` reads could not then be told.
  const namespaces = [];
  const seenOnce = new Set();
  const shadowed = new Set();
  const note = (name) => { if (seenOnce.has(name)) shadowed.add(name); seenOnce.add(name); };
  walk(ast, (n) => {
    if (n.type === "VariableDeclarator" && n.id.type === "Identifier") note(n.id.name);
    else if (n.type === "ImportNamespaceSpecifier") note(n.local.name);
    else if ((n.type === "FunctionDeclaration" || n.type === "ClassDeclaration") && n.id) note(n.id.name);
  });

  walk(ast, (node) => {
    // static
    if (node.type === "ImportDeclaration") {
      const spec = node.source.value;
      for (const s of node.specifiers) {
        if (s.type === "ImportSpecifier") add(spec, s.imported.name ?? s.imported.value, s.imported, "imported");
        else if (s.type === "ImportDefaultSpecifier") add(spec, "default", s.local, "imported as the default");
        else if (s.type === "ImportNamespaceSpecifier" && !shadowed.has(s.local.name)) namespaces.push({ spec, binding: s.local.name });
      }
      return;
    }
    if (node.type === "ExportNamedDeclaration" && node.source) {
      for (const s of node.specifiers) add(node.source.value, s.local.name ?? s.local.value, s.local, "re-exported");
      return;
    }

    // a path computed at run time cannot be followed; it is counted out loud
    if (isImportCall(node)) {
      const src = importSource(node);
      if (!src || src.type !== "Literal" || typeof src.value !== "string") computed.push(node);
      return;
    }

    // awaited: destructured, or into a binding
    if (node.type === "VariableDeclarator") {
      const imp = awaitedImport(node.init);
      const src = imp && importSource(imp);
      if (imp && src?.type === "Literal") {
        if (node.id.type === "ObjectPattern") for (const k of patternNames(node.id)) add(src.value, k.name, k.node, "destructured from an awaited import");
        else if (node.id.type === "Identifier" && !shadowed.has(node.id.name)) namespaces.push({ spec: src.value, binding: node.id.name });
      }
      return;
    }
    if (node.type === "AssignmentExpression" && node.left.type === "ObjectPattern") {
      const imp = awaitedImport(node.right);
      const src = imp && importSource(imp);
      if (imp && src?.type === "Literal") for (const k of patternNames(node.left)) add(src.value, k.name, k.node, "destructured from an awaited import");
      return;
    }
    // read straight off an awaited import
    if (node.type === "MemberExpression" && !node.computed) {
      const imp = awaitedImport(unchain(node.object));
      const src = imp && importSource(imp);
      if (imp && src?.type === "Literal" && node.property.type === "Identifier") {
        add(src.value, node.property.name, node.property, "read off an awaited import");
      }
      return;
    }

    // the promise form: import("./x").then(...)
    if (node.type === "CallExpression") {
      const c = unchain(node.callee);
      if (c?.type !== "MemberExpression" || c.computed || c.property.name !== "then") return;
      const imp = unchain(c.object);
      if (!isImportCall(imp)) return;
      const src = importSource(imp);
      if (src?.type !== "Literal") return;
      const fn = node.arguments[0];
      if (!fn || !["ArrowFunctionExpression", "FunctionExpression"].includes(fn.type)) return;
      const p = fn.params[0];
      if (!p) return;
      if (p.type === "ObjectPattern") for (const k of patternNames(p)) add(src.value, k.name, k.node, "destructured from an imported module");
      else if (p.type === "Identifier") for (const r of memberReads(fn.body, p.name)) add(src.value, r.name, r.node, "read off an imported module");
    }
  });

  for (const ns of namespaces) for (const r of memberReads(ast, ns.binding)) {
    add(ns.spec, r.name, r.node, "read off an imported module");
  }
  return { asks, computed };
}

/* ==========================================================================
   The check
   ========================================================================== */

/**
 * @param {string[]} files   the files to judge
 * @param {object}   io      { load, resolveSpec }
 */
export function checkFiles(files, { load, resolveSpec }, espree) {
  const reader = makeReader(load, resolveSpec, espree);
  const findings = [], unresolved = [], unreadable = [], opaque = new Map();
  let computed = 0, asked = 0;

  for (const file of files) {
    const rec = reader.astFor(file);
    if (rec.why) { unreadable.push({ file, why: rec.why }); continue; }
    const okLines = new Set();
    for (const c of rec.ast.comments ?? []) {
      if (/export-ok:\s*\S/.test(c.value)) for (let l = c.loc.start.line; l <= c.loc.end.line + 1; l++) okLines.add(l);
    }
    const { asks, computed: comp } = asksOf(rec.ast);
    computed += comp.length;
    const resolved = new Map();
    const seen = new Set();
    for (const a of asks) {
      asked++;
      const line = a.node.loc.start.line;
      if (okLines.has(line)) continue;
      if (!resolved.has(a.spec)) resolved.set(a.spec, resolveSpec(file, a.spec));
      const r = resolved.get(a.spec);
      if (r.bare) continue;                               // a package from outside the suite
      const key = `${a.spec}|${a.name}|${line}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (r.missing) { unresolved.push({ file, line, spec: a.spec, name: a.name, how: a.how, tried: r.missing }); continue; }
      const { names, opaque: why } = reader.namesFor(r.path);
      if (why) { if (!opaque.has(r.path)) opaque.set(r.path, why); continue; }
      if (!names.has(a.name)) findings.push({ file, line, name: a.name, how: a.how, spec: a.spec, target: r.path });
    }
  }
  const order = (a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.name.localeCompare(b.name);
  findings.sort(order);
  unresolved.sort(order);
  return { findings, unresolved, opaque, computed, unreadable, asked };
}

/* ==========================================================================
   Command line
   ========================================================================== */

const SKIP_DIRS = ["node_modules", "lib", "libs", "vendor", "dist", "packs", "tools", ".git"];

function scriptsUnder(root) {
  const out = [];
  const go = (d) => {
    for (const name of readdirSync(d)) {
      if (SKIP_DIRS.includes(name)) continue;
      const p = join(d, name);
      let st; try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) go(p);
      else if (/\.(mjs|js)$/.test(name)) out.push(p.replace(/\\/g, "/"));
    }
  };
  go(root);
  return out;
}

function diskIo() {
  const cache = new Map();
  const load = (p) => {
    if (cache.has(p)) return cache.get(p);
    let src = null;
    try { if (statSync(p).isFile()) src = readFileSync(p, "utf8"); } catch { /* not a file */ }
    cache.set(p, src);
    return src;
  };
  const resolveSpec = (from, spec) => {
    // Foundry serves modules out of the Data folder, so "/modules/x/y.mjs" is a
    // real path inside this suite and not a package.
    let base;
    if (spec.startsWith("/modules/")) base = join(dirname(MODULES), spec).replace(/\\/g, "/");
    else if (spec.startsWith(".")) base = join(dirname(from), spec).replace(/\\/g, "/");
    else return { bare: true };
    for (const c of [base, base + ".mjs", base + ".js", base + "/index.mjs", base + "/index.js"]) {
      if (load(c) !== null) return { path: c };
    }
    return { missing: base };
  };
  return { load, resolveSpec };
}

function main() {
  const args = process.argv.slice(2);
  const given = [];
  for (let i = 0; i < args.length; i++) if (args[i] === "--root") given.push(resolve(args[++i]).replace(/\\/g, "/"));

  console.log("MISSING EXPORT CHECK: every name read out of another file is one that file exports\n");
  const roots = [];
  if (given.length) for (const r of given) roots.push({ label: basename(r), root: r });
  else {
    for (const [label, folder, subs] of SUITE) {
      const home = join(MODULES, folder);
      if (!existsSync(home)) { console.log(`  not installed here: ${label} (${folder}) — nothing of it was read`); continue; }
      const found = subs.filter(s => existsSync(join(home, s)));
      if (!found.length) { console.log(`  ${label}: none of ${subs.join(", ")} exist under ${folder} — nothing of it was read`); continue; }
      for (const s of found) roots.push({ label, root: join(home, s).replace(/\\/g, "/") });
    }
  }
  if (!roots.length) { console.log("No ACE code found to read.\n0 passed, 1 failed"); process.exit(1); }

  const espree = loadEspree();
  if (!espree) {
    console.log("This check could not find its parser (espree). The lint step installs it:");
    console.log("  npx --yes eslint@9 --version");
    console.log("0 passed, 1 failed");
    process.exit(1);
  }

  const io = diskIo();
  const files = [];
  for (const { label, root } of roots) {
    const got = scriptsUnder(root);
    files.push(...got);
    console.log(`  read ${String(got.length).padStart(4)} files  ${label}  (${relative(MODULES, root).replace(/\\/g, "/")})`);
  }
  console.log("");

  const { findings, unresolved, opaque, computed, unreadable, asked } = checkFiles(files, io, espree);
  const show = (p) => relative(MODULES, p).replace(/\\/g, "/");

  for (const u of unreadable) console.log(`  COULD NOT READ ${show(u.file)}: ${u.why}`);
  for (const f of findings) {
    console.log(`  ${show(f.file)}:${f.line}  ${f.name} is ${f.how} from "${f.spec}", which does not export it`);
    console.log(`        ${show(f.target)} has no ${f.name}`);
  }
  for (const u of unresolved) {
    console.log(`  ${show(u.file)}:${u.line}  ${u.name} is ${u.how} from "${u.spec}", and that path is no file`);
    console.log(`        tried ${show(u.tried)} (.mjs, .js, /index.mjs, /index.js)`);
  }
  if (opaque.size) {
    console.log("");
    console.log("  Not judged, because their own names cannot be known:");
    for (const [p, why] of opaque) console.log(`    ${show(p)} — ${why}`);
  }
  if (computed) console.log(`\n  ${computed} import path(s) are built at run time, so no name of them was checked.`);

  console.log("");
  console.log(`${asked} names read across files. ${findings.length} the other file does not export, ` +
              `${unresolved.length} path(s) that are no file, ${unreadable.length} file(s) unreadable.`);
  const bad = findings.length + unresolved.length + unreadable.length;
  console.log(bad ? "\nEvery one of those is undefined at run time: a call that throws, or a value silently missing."
                  : "Every name is there.");
  process.exit(bad ? 1 : 0);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
