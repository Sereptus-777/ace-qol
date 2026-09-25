#!/usr/bin/env node
/**
 * PROVE THE CHECKER FIRST.
 *
 * missing-export-check.mjs exists because Forge's polymorph and summon traps
 * destructured `playTrapAnimation` out of a file that does not export it, so
 * neither trap had ever played an animation. A checker for that is only worth
 * running if it finds that shape and stays quiet about every real export beside
 * it: four of my own tools have handed back confident wrong numbers, and a
 * regex first draft of this one missed both Forge bugs outright.
 *
 * Every case below is a small module written here, judged through the same
 * checkFiles() the command line uses, with the files in memory instead of on
 * disk. MUST FIND cases are the bug. MUST NOT FIND cases are real code that has
 * to stay silent.
 *
 * Run:  node tools/missing-export-selftest.mjs
 */
import { checkFiles } from "./missing-export-check.mjs";
import { loadEspree } from "./dice-check.mjs";

const espree = loadEspree();
if (!espree) {
  console.log("The self-test could not find its parser (espree). The lint step installs it:");
  console.log("  npx --yes eslint@9 --version");
  console.log("0 passed, 1 failed");
  process.exit(1);
}

/* A module tree in memory. Keys are posix paths under /w. */
function ioFor(files) {
  const load = (p) => (Object.prototype.hasOwnProperty.call(files, p) ? files[p] : null);
  const resolveSpec = (from, spec) => {
    if (!spec.startsWith(".") && !spec.startsWith("/")) return { bare: true };
    const dir = from.slice(0, from.lastIndexOf("/"));
    const parts = (spec.startsWith("/") ? spec : dir + "/" + spec).split("/");
    const out = [];
    for (const part of parts) {
      if (part === "." || part === "") continue;
      if (part === "..") out.pop();
      else out.push(part);
    }
    const base = "/" + out.join("/");
    for (const c of [base, base + ".mjs", base + ".js", base + "/index.mjs", base + "/index.js"]) {
      if (load(c) !== null) return { path: c };
    }
    return { missing: base };
  };
  return { load, resolveSpec };
}

let passed = 0, failed = 0;

/**
 * @param {string} title
 * @param {object} files      path -> source; the first key is the file judged
 * @param {string[]} expect   names that must be reported, in any order
 */
function T(title, files, expect) {
  const io = ioFor(files);
  const judged = [Object.keys(files)[0]];
  let got;
  try { got = checkFiles(judged, io, espree); }
  catch (err) { failed++; console.log(`  FAIL  ${title}\n          it threw: ${err.message}`); return; }

  const named = [...got.findings.map(f => f.name), ...got.unresolved.map(u => u.name)].sort();
  const want = [...expect].sort();
  const same = named.length === want.length && named.every((n, i) => n === want[i]);
  if (same && !got.unreadable.length) { passed++; console.log(`  ok    ${title}`); return; }
  failed++;
  console.log(`  FAIL  ${title}`);
  console.log(`          expected: ${want.length ? want.join(", ") : "(nothing)"}`);
  console.log(`          got:      ${named.length ? named.join(", ") : "(nothing)"}`);
  for (const u of got.unreadable) console.log(`          unreadable: ${u.file} — ${u.why}`);
}

const EXPORTER = `
export function plainFn() {}
export async function asyncFn() {}
export function* genFn() {}
export class Klass {}
export const konst = 1;
export let lett = 2;
export var varr = 3;
const local = 4, other = 5;
export { local, other as renamed };
export const { destructured } = {};
export const [ fromArray ] = [];
export default class Def {}
`;

console.log("MISSING EXPORT SELF-TEST: it must find the bug and stay quiet about real exports\n");
console.log("  MUST FIND");

T("the Forge bug: a name destructured from an awaited import",
  { "/w/a.mjs": `async function go() { const { playTrapAnimation } = await import("./b.mjs"); playTrapAnimation(); }`,
    "/w/b.mjs": `export function fireTrapAgainstTokens() {}` },
  ["playTrapAnimation"]);

T("the same bug inside a try, where a regex matched the brace above it",
  { "/w/a.mjs": `async function go() {\n  try {\n    const { playTrapAnimation } = await import("./b.mjs");\n    playTrapAnimation();\n  } catch (e) {}\n}`,
    "/w/b.mjs": `export function renderTrapCard() {}` },
  ["playTrapAnimation"]);

T("a static import of a name that is not exported",
  { "/w/a.mjs": `import { nope, konst } from "./e.mjs";\nnope(konst);`, "/w/e.mjs": EXPORTER },
  ["nope"]);

T("a re-export of a name that is not there",
  { "/w/a.mjs": `export { nope } from "./e.mjs";`, "/w/e.mjs": EXPORTER },
  ["nope"]);

T("a default import where there is no default",
  { "/w/a.mjs": `import thing from "./b.mjs";\nthing();`, "/w/b.mjs": `export const named = 1;` },
  ["default"]);

T("the promise form, destructured",
  { "/w/a.mjs": `import("./b.mjs").then(({ Missing }) => Missing.init());`, "/w/b.mjs": `export class Present {}` },
  ["Missing"]);

T("the promise form, read off the module",
  { "/w/a.mjs": `import("./b.mjs").then(m => m.missingFn(1));`, "/w/b.mjs": `export function presentFn() {}` },
  ["missingFn"]);

T("read straight off an awaited import",
  { "/w/a.mjs": `async function go() { return (await import("./b.mjs")).Missing.go(); }`, "/w/b.mjs": `export class Present {}` },
  ["Missing"]);

T("awaited into a binding, then read by name",
  { "/w/a.mjs": `async function go() { const mod = await import("./b.mjs"); mod.missingFn(); }`, "/w/b.mjs": `export function presentFn() {}` },
  ["missingFn"]);

T("a namespace import, read by name",
  { "/w/a.mjs": `import * as NS from "./b.mjs";\nNS.missingFn();`, "/w/b.mjs": `export function presentFn() {}` },
  ["missingFn"]);

T("a renamed destructure checks the name the OTHER file would need",
  { "/w/a.mjs": `async function go() { const { missingFn: local } = await import("./b.mjs"); local(); }`,
    "/w/b.mjs": `export function presentFn() {}` },
  ["missingFn"]);

T("a relative path that is no file at all",
  { "/w/a.mjs": `import { anything } from "./gone.mjs";\nanything();` },
  ["anything"]);

T("a folder deep in the tree, reached by ../",
  { "/w/x/a.mjs": `import { nope } from "../e.mjs";\nnope();`, "/w/e.mjs": EXPORTER },
  ["nope"]);

T("two bad names on one line are both named",
  { "/w/a.mjs": `import { nopeOne, nopeTwo } from "./e.mjs";\nnopeOne(nopeTwo);`, "/w/e.mjs": EXPORTER },
  ["nopeOne", "nopeTwo"]);

console.log("\n  MUST NOT FIND");

T("every shape of a real export",
  { "/w/a.mjs": `import { plainFn, asyncFn, genFn, Klass, konst, lett, varr, local, renamed, destructured, fromArray } from "./e.mjs";\n`
      + `plainFn(asyncFn, genFn, Klass, konst, lett, varr, local, renamed, destructured, fromArray);`,
    "/w/e.mjs": EXPORTER },
  []);

T("a default import where there IS a default",
  { "/w/a.mjs": `import Def from "./e.mjs";\nnew Def();`, "/w/e.mjs": EXPORTER },
  []);

T("a name imported under another name",
  { "/w/a.mjs": `import { plainFn as renamedHere } from "./e.mjs";\nrenamedHere();`, "/w/e.mjs": EXPORTER },
  []);

T("a name reached through a chain of export *",
  { "/w/a.mjs": `import { deep } from "./b.mjs";\ndeep();`,
    "/w/b.mjs": `export * from "./c.mjs";`,
    "/w/c.mjs": `export * from "./d.mjs";`,
    "/w/d.mjs": `export function deep() {}` },
  []);

T("export * from a package, so the target's names are unknowable",
  { "/w/a.mjs": `import { whoKnows } from "./b.mjs";\nwhoKnows();`,
    "/w/b.mjs": `export * from "some-package";` },
  []);

T("export * as a namespace, which is one name",
  { "/w/a.mjs": `import { Bundle } from "./b.mjs";\nBundle.thing();`,
    "/w/b.mjs": `export * as Bundle from "./c.mjs";`,
    "/w/c.mjs": `export const thing = 1;` },
  []);

T("a cycle between two files that both export what the other needs",
  { "/w/a.mjs": `import { fromB } from "./b.mjs";\nexport const fromA = 1;\nfromB();`,
    "/w/b.mjs": `import { fromA } from "./a.mjs";\nexport function fromB() { return fromA; }` },
  []);

T("a package, not one of ours",
  { "/w/a.mjs": `import { readFileSync } from "node:fs";\nimport Sequencer from "sequencer";\nreadFileSync(Sequencer);` },
  []);

T("a path built at run time",
  { "/w/a.mjs": `async function go(which) { const m = await import(which); return m.anything; }` },
  []);

T("a rest element takes whatever is there",
  { "/w/a.mjs": `async function go() { const { plainFn, ...rest } = await import("./e.mjs"); return [plainFn, rest]; }`,
    "/w/e.mjs": EXPORTER },
  []);

T("a namespace binding whose name is used for something else too",
  { "/w/a.mjs": `import * as NS from "./b.mjs";\nfunction f() { const NS = { whatever: 1 }; return NS.whatever; }\nNS.presentFn();`,
    "/w/b.mjs": `export function presentFn() {}` },
  []);

T("a computed key cannot be judged",
  { "/w/a.mjs": `const k = "x";\nasync function go() { const { [k]: v } = await import("./b.mjs"); return v; }`,
    "/w/b.mjs": `export const x = 1;` },
  []);

T("a plain object destructure that has nothing to do with an import",
  { "/w/a.mjs": `const { anything, missing } = someObject;\nfunction f({ alsoMissing }) { return [anything, missing, alsoMissing]; }` },
  []);

T("an export-ok line is left alone",
  { "/w/a.mjs": `async function go() {\n  // export-ok: this build ships without it on purpose\n  const { maybe } = await import("./b.mjs");\n  return maybe;\n}`,
    "/w/b.mjs": `export const present = 1;` },
  []);

T("an index file resolved from a folder name",
  { "/w/a.mjs": `import { inIndex } from "./sub";\ninIndex();`, "/w/sub/index.mjs": `export function inIndex() {}` },
  []);

T("a file that imports nothing",
  { "/w/a.mjs": `export function alone() { return 1; }` },
  []);

console.log("");
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
