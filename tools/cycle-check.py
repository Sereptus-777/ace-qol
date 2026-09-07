#!/usr/bin/env python3
"""An imported constant used at the top level of a module in an import cycle.

WHY THIS EXISTS
    2026-09-06. I wrote a new module that began:

        import { MODULE_ID } from "./ace-qol.mjs";
        const LOG = `${MODULE_ID} | flight`;

    `ace-qol.mjs` imports that module, so the two form a cycle. In a cycle the
    importer's bindings are still in their temporal dead zone when the imported
    module's top level runs, and reading one throws:

        ReferenceError: Cannot access 'MODULE_ID' before initialization

    That does not break the one file. It kills the WHOLE module: the entry file
    dies on the way in and nothing registered after it exists. In his world it
    would have looked like ACE simply vanished.

    It is written down as a lesson from 2026-08-28 and I did it again eight days
    later. Nothing we owned could see it: it parses, it lints, and the class of
    bug only appears at load. Every other leaf in the suite declares its own
    `const MODULE_ID = "ace-qol"` for exactly this reason.

WHAT IT REPORTS
    A module that (a) sits in an import cycle with another ACE module and
    (b) evaluates an imported binding at its top level. Inside a function is
    fine, because by then everything has initialised.

Run:  python tools/cycle-check.py
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
MODULES = HERE.parent.parent
ACE = ["ace-qol", "ace-engine", "ace-artificer", "ace-token-art"]

IMPORT = re.compile(r'^\s*import\s+(?:([\w*\s{},]+?)\s+from\s+)?["\']([^"\']+)["\']',
                    re.MULTILINE)
NAMED = re.compile(r"\{([^}]*)\}")


def resolve(src: Path, spec: str) -> Path | None:
    if not spec.startswith("."):
        return None
    target = (src.parent / spec).resolve()
    if target.suffix:
        return target if target.exists() else None
    for ext in (".mjs", ".js"):
        cand = target.with_suffix(ext)
        if cand.exists():
            return cand
    return None


def parse(path: Path):
    """(imports: {resolved path: [bound names]}, top-level body lines)."""
    text = path.read_text(encoding="utf-8", errors="replace")
    imports: dict[Path, list[str]] = {}
    for m in IMPORT.finditer(text):
        clause, spec = m.group(1) or "", m.group(2)
        target = resolve(path, spec)
        if not target:
            continue
        names = []
        nm = NAMED.search(clause)
        if nm:
            for part in nm.group(1).split(","):
                part = part.strip()
                if not part:
                    continue
                names.append(part.split(" as ")[-1].strip())
        else:
            bare = clause.replace("* as", "").strip()
            if bare:
                names.append(bare)
        imports.setdefault(target, []).extend(names)

    # -- WHAT COUNTS AS "EVALUATED AT LOAD" ------------------------------
    #
    # The first version of this called any line at column zero top-level and
    # tracked brace depth to be sure. It reported ten sites and every one was
    # inside a function body: brace counting cannot tell a brace in a string
    # from a brace in code, and a one-line `function f() { ... }` at column zero
    # looks exactly like a top-level statement.
    #
    # A checker that cries wolf is worse than no checker, and this suite has the
    # scars: four of my own tools gave confident wrong numbers in one night
    # (2026-08-26). So this is deliberately NARROW. It reports exactly one
    # shape, the one that actually killed a module:
    #
    #     const LOG = `${MODULE_ID} | flight`;     <- at column zero
    #
    # A declaration at column zero whose initialiser reads a cyclic import.
    # That initialiser runs the instant the module is evaluated, which in a
    # cycle is before the binding exists.
    #
    # NOT REPORTED, on purpose: reads inside function or class bodies (they run
    # later, when everything is initialised) and arguments to top-level calls
    # (real, but indistinguishable from a callback body without a parser). If
    # one of those ever bites, this grows a parser rather than a guess.
    DECL = re.compile(r"^(?:export\s+)?(?:const|let|var)\s")
    # A trailing comment is not code. Two of the first three findings were the
    # imported name appearing only in a `// SubtleRollManager - ...` note beside
    # a `let x = null`.
    COMMENT = re.compile(r"//.*$")
    # An initialiser that IS a function does not run now, it runs when called.
    # The third finding was `const f = (key) => isSecretKey(key)`, which is
    # perfectly safe and would have sent me editing working code.
    # ⚠️ RAW STRING, AND IT MATTERS. Written without the r prefix, Python turns
    # the \b into a literal backspace at compile time and the `function` branch
    # can then never match anything. That is precisely the bug
    # control-char-check.py exists to find, and it found it here, in the tool I
    # had just written to find a different class of bug.
    DEFERRED = re.compile(
        r"=\s*(?:async\s+)?(?:function\b|\(|[A-Za-z_$][\w$]*\s*=>)")
    top: list[tuple[int, str]] = []
    for i, line in enumerate(text.splitlines(), start=1):
        if line[:1] in (" ", "	"):
            continue                          # indented: inside something
        if not DECL.match(line):
            continue
        code = COMMENT.sub("", line)
        if DEFERRED.search(code):
            continue
        top.append((i, code))
    return imports, top


def main() -> int:
    graph: dict[Path, dict[Path, list[str]]] = {}
    tops: dict[Path, list[tuple[int, str]]] = {}
    for mod in ACE:
        root = MODULES / mod / "scripts"
        if not root.exists():
            continue
        for path in root.rglob("*.mjs"):
            if "node_modules" in str(path):
                continue
            try:
                imports, top = parse(path)
            except Exception:
                continue
            graph[path] = imports
            tops[path] = top

    findings = []
    for path, imports in graph.items():
        for target, names in imports.items():
            back = graph.get(target, {})
            if path not in back:
                continue                    # not a cycle
            for line_no, line in tops.get(path, []):
                for name in names:
                    if not name:
                        continue
                    if re.search(rf"\b{re.escape(name)}\b", line):
                        findings.append((path, line_no, name, target, line.strip()))
                        break

    print("=" * 74)
    print("IMPORTED CONSTANTS EVALUATED AT TOP LEVEL, INSIDE AN IMPORT CYCLE")
    print("=" * 74)
    print(f"Walked {len(graph)} file(s) across {len(ACE)} modules.")
    print()

    if not findings:
        print("None. No module reads a cyclic import before it is initialised.")
        return 0

    for path, line_no, name, target, line in sorted(findings, key=lambda f: str(f[0])):
        rel = path.relative_to(MODULES)
        print(f"  {rel}:{line_no}")
        print(f"      reads `{name}` from {target.name}, which imports it back")
        print(f"      {line[:100]}")
        print()
    print(f"{len(findings)} site(s). Each one throws at load and takes the whole")
    print("module with it. Declare the constant locally instead.")
    return 1


if __name__ == "__main__":
    sys.exit(main())
