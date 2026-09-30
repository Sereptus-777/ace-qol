// ─── A DC BELONGS TO WHOEVER SET IT ─────────────────────────────────────────
//
// HIS RULE, 2026-09-29:
//
//   "The player knows its own DCs. It has no idea about any other DC. The
//    dungeon master knows all DCs. That's all there is to it."
//
// WHY THIS EXISTS. It was already the rule, written down as "players never see
// any DC", and on the evening of 29 September every save card in the suite was
// still printing "DC 13 Wisdom" in its header to the whole table, and the save
// prompt WHISPERED TO THE PLAYER printed the number they were rolling against in
// gold under the spell's name. I fixed the two I was looking at, twice, and each
// time a third was still leaking, because a rule that has to be remembered at
// every new card is a rule that gets remembered at most of them.
//
// So the rule is enforced instead of remembered. A DC that reaches a screen goes
// through the one wrapper:
//
//     <span class="ace-qol-dc" data-dc-actor="${whoSetIt}">DC 13 Wisdom</span>
//
// which `revealOwnDCs` (chat-render-utils.mjs) shows to the GM always and to a
// player only for a creature they own.
//
// WHAT THIS CHECK READS. Every script in ace-qol, Forge, Engine and Envoy, with
// a real parser (espree), and for every string or template literal that states a
// DC it asks where that text goes.
//
// ⚠️ TWO LISTS, BECAUSE "STATES A DC" IS NOT "SHOWS A DC".
//
// Its first run reported 133 lines and most were reference prose: a spell
// registry's description of Frightful Presence, a setting's hint, a trap library
// entry, a weapon's escape text. Those are DATA the engine reads, and failing a
// release on them is how a checker turns into noise that gets ignored, which is
// exactly what cycle-check's first version did with ten false positives.
//
// So a DC that reaches MARKUP or a NOTIFICATION fails this check; a DC stated
// anywhere else is listed and does not. Nothing is hidden either way: a leak
// cannot be invisible, and prose cannot cry wolf.
//
// A line that genuinely belongs unwrapped says why, on it or just above it:
//
//     dc-ok: the GM's own reason line, already inside .ace-qol-gm-only
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEspree } from "./dice-check.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const QOL = dirname(HERE);
const MODULES = dirname(QOL);

const ROOTS = [
  join(QOL, "scripts"),
  join(MODULES, "ace-artificer", "scripts"),
  join(MODULES, "ace-engine", "scripts"),
  join(MODULES, "ace-envoy", "src"),
];

/** A literal that states a DC and a number, e.g. "DC 13", "DC ${dc}", "(DC 15)". */
const STATES_A_DC = /\bDC\b\s*(?:\$\{|\d)/;
// ⚠️ THREE WRAPPERS COUNT, AND THEY ARE NOT THE SAME THING.
//
//   .ace-qol-dc      hidden by default, revealed to the GM and to the OWNER of
//                    the creature that set it. The one to reach for.
//   .ace-qol-save-dc hidden by default, revealed to the GM only. Correct for a
//                    monster's save DC, which no player owns.
//   .forge-gm-only   Forge's own, same shape, in Forge's stylesheet.
//
// All three are hidden by CSS and revealed at render, which is the safe
// direction: a card the render pass never reaches stays hidden rather than
// leaking. A class that is VISIBLE until a handler hides it is the 2026-08-07
// bug that chat-render-utils exists to prevent, and it does not count here.
const WRAPPED = /ace-qol-dc\b|ace-qol-save-dc\b|forge-gm-only\b|dcSpan\s*\(/;
/** A justification on the line or just above it. */
const OK_MARK = /dc-ok:\s*\S/;
/** Markup: this text is part of something drawn on a screen. */
const IS_MARKUP = /<[a-zA-Z/]/;
/** A call that hands text to a screen rather than into a data structure. */
const SCREEN_CALL = /notifications|notify|Html$|tooltip|flavor|whisper/i;

function walkFiles(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, name.name);
    if (name.isDirectory()) walkFiles(p, out);
    else if (/\.mjs$/.test(name.name)) out.push(p);
  }
  return out;
}

function eachNode(node, fn) {
  if (!node || typeof node.type !== "string") return;
  fn(node);
  for (const key of Object.keys(node)) {
    if (key === "parent" || key === "range" || key === "loc") continue;
    const v = node[key];
    if (Array.isArray(v)) for (const n of v) eachNode(n, fn);
    else if (v && typeof v === "object" && typeof v.type === "string") eachNode(v, fn);
  }
}

/** Arguments to a console call, thrown errors, and comments: never a screen. */
function quietRanges(ast) {
  const ranges = [];
  eachNode(ast, (node) => {
    if (node.type === "CallExpression") {
      const c = node.callee;
      const isConsole = (c?.type === "MemberExpression"
          && (c.object?.name === "console" || /_debug$/.test(c.property?.name ?? "")))
        || /^(_debug|debug)$/.test(c?.name ?? "");
      if (isConsole) ranges.push([node.range[0], node.range[1]]);
    }
    if (node.type === "ThrowStatement" || node.type === "NewExpression") {
      ranges.push([node.range[0], node.range[1]]);
    }
  });
  for (const c of (ast.comments ?? [])) ranges.push([c.range[0], c.range[1]]);
  return ranges;
}

/** Calls that hand their text to a screen: a notification, a tooltip, a whisper. */
function screenRanges(ast) {
  const ranges = [];
  eachNode(ast, (node) => {
    if (node.type !== "CallExpression") return;
    const c = node.callee;
    const name = c?.type === "MemberExpression"
      ? `${c.object?.name ?? c.object?.property?.name ?? ""}.${c.property?.name ?? ""}`
      : (c?.name ?? "");
    if (SCREEN_CALL.test(name)) ranges.push([node.range[0], node.range[1]]);
  });
  return ranges;
}

const inAny = (ranges, start) => ranges.some(([a, b]) => start >= a && start < b);

function dedupe(list) {
  const seen = new Set();
  return list.filter((h) => {
    const k = `${h.file}:${h.line}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export function run() {
  const espree = loadEspree();
  if (!espree) return { checked: 0, hits: [], notes: [], noParser: true };

  const hits = [];
  const notes = [];
  let checked = 0;

  for (const root of ROOTS) {
    for (const file of walkFiles(root)) {
      const src = readFileSync(file, "utf8");
      if (!STATES_A_DC.test(src)) continue;
      checked++;
      let ast;
      try {
        ast = espree.parse(src, {
          ecmaVersion: 2023, sourceType: "module", range: true, loc: true, comment: true,
        });
      } catch (err) {
        hits.push({ file, line: 0, text: `could not be parsed: ${err?.message ?? err}` });
        continue;
      }
      const quiet = quietRanges(ast);
      const screens = screenRanges(ast);
      const lines = src.split("\n");

      eachNode(ast, (node) => {
        if (node.type !== "TemplateLiteral" && node.type !== "Literal") return;
        const text = src.slice(node.range[0], node.range[1]);
        if (!STATES_A_DC.test(text)) return;
        if (inAny(quiet, node.range[0])) return;        // the console is the GM's
        if (WRAPPED.test(text)) return;                 // already in the wrapper

        // ⚠️ REPORT THE LINE THE DC IS ON, not the line the template opens on. A
        // card is one literal forty lines long, so "pc-save-nudge.mjs:170" sent me
        // to a backtick and a justification written beside the DC itself was three
        // lines too far away to count. The offset inside the literal gives the real
        // line, and a reason anywhere from three lines above the literal down to
        // the DC's own line is a reason.
        const at = text.search(STATES_A_DC);
        const startLine = node.loc.start.line;
        const dcLine = startLine + (at > 0 ? (text.slice(0, at).match(/\n/g)?.length ?? 0) : 0);
        for (let l = Math.max(1, startLine - 3); l <= dcLine; l++) {
          if (OK_MARK.test(lines[l - 1] ?? "")) return;
        }
        const ln = dcLine;
        const flat = text.replace(/\s+/g, " ");
        const m = /.{0,40}\bDC\b\s*(?:\$\{[^}]*\}|\d+).{0,30}/.exec(flat);
        const row = { file, line: ln, text: (m?.[0] ?? flat.slice(0, 70)).trim() };
        const onAScreen = IS_MARKUP.test(text) || inAny(screens, node.range[0]);
        (onAScreen ? hits : notes).push(row);
      });
    }
  }

  return { checked, hits: dedupe(hits), notes: dedupe(notes) };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const { checked, hits, notes, noParser } = run();
  if (noParser) {
    console.log("The DC check could not find its parser (espree). The lint check installs it:");
    console.log("  npx --yes eslint@9 --version");
    console.log("0 passed, 1 failed");
    process.exit(1);
  }
  const short = (f) => relative(MODULES, f).replace(/\\/g, "/");
  const sayNotes = () => {
    if (!notes.length) return;
    console.log(`\n${notes.length} more state a DC away from any screen: reference prose, a`);
    console.log("setting's hint, a rules entry. Listed so none is invisible; they do not fail");
    console.log("the check. Run with --all to read them.");
    if (process.argv.includes("--all")) {
      for (const n of notes) console.log(`  ${short(n.file)}:${n.line}  ${n.text}`);
    }
  };

  console.log("=".repeat(74));
  console.log("A DC BELONGS TO WHOEVER SET IT");
  console.log("=".repeat(74));
  if (!hits.length) {
    console.log(`Read ${checked} file(s) that state a DC. Every one that reaches a screen is`);
    console.log("inside the wrapper, so the GM sees them all and a player sees only their own.");
    sayNotes();
    process.exit(0);
  }
  const byFile = new Map();
  for (const h of hits) {
    const k = short(h.file);
    if (!byFile.has(k)) byFile.set(k, []);
    byFile.get(k).push(h);
  }
  for (const [f, list] of [...byFile].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`\n${f}  (${list.length})`);
    for (const h of list) console.log(`  ${String(h.line).padStart(5)}  ${h.text}`);
  }
  console.log(`\n${hits.length} DC(s) reach a screen outside the wrapper, in ${byFile.size} file(s).`);
  console.log("Wrap it:   dcSpan(`DC ${dc} ${label}`, whoSetItActorId)");
  console.log("or say why it belongs as it is:   dc-ok: <reason>");
  sayNotes();
  process.exit(1);
}
