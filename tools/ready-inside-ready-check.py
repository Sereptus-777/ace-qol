"""
READY INSIDE READY — a hook registered too late never fires.

⚠️ WHY THIS EXISTS. Foundry fires `ready` once. Anything that calls
Hooks.once("ready", ...) while the ready handlers are ALREADY RUNNING registers
a listener for an event that has been and gone. Nothing throws. Nothing warns.
The callback simply never runs, forever.

It has now cost four live bugs:

  2026-08-12 — proven live, and written down as a lesson.
  2026-08-16 — a third instance found in the full audit: a cleanup whose own
               comment claimed it ran on ready, and never had.
  2026-09-26 — pit-fall.mjs. PitFall.register() is called from inside the
               module's ready handler, and inside it I wrote
               Hooks.once("ready", () => PitFall.repairOrphans()). The repair
               that lifts a forgotten token out of a pit had never run once:
               his character stayed shrunk with a depth badge over her head
               through restart after restart.
  2026-09-26 — trap-behavior.mjs, found by this check on its first run. The
               sweep that decorates trap cards already sitting in the chat log
               had never run either.

A lesson that has to be remembered is a lesson that comes back. This reads the
code instead.

WHAT IT CHECKS, and deliberately nothing more:

  1. Collect every function called from inside a `ready` handler, across the ACE
     modules, by its QUALIFIED name where there is one — `PitFall.register`, not
     every `register` in the suite. Matching on the bare name alone named 27
     rules, nearly all of them innocent, which is a check nobody reads.
  2. Flag those functions when their own body registers a `ready` hook WITHOUT
     the guard this codebase already uses:

         if (game?.ready) run(); else Hooks.once("ready", run);

     That idiom is correct from anywhere, so it is not the bug.

Comments are stripped first: three of the first five hits were files describing
this very mistake in prose.

A registration that is genuinely correct some other way says `ready-ok: <reason>`.
"""

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent      # …/Data/modules
MODULES = ["ace-qol", "ace-artificer", "ace-engine", "ace-token-art", "ace-envoy"]

READY_HOOK = re.compile(r"""Hooks\.(?:once|on)\(\s*["']ready["']""")
QUALIFIED  = re.compile(r"\b([A-Za-z_$][\w$]*)\s*\.\s*([A-Za-z_$][\w$]*)\s*\(")
BARE_CALL  = re.compile(r"(?<![.\w$])([A-Za-z_$][\w$]*)\s*\(")
CLASS_DEF  = re.compile(r"\bclass\s+([A-Za-z_$][\w$]*)")
OPT_OUT    = re.compile(r"ready-ok\s*:", re.I)
# The guard that makes a ready registration safe from anywhere. ⚠️ ONLY the
# readiness test. An earlier version accepted `game.user` and `game.actors` too,
# which appear in almost every function in the suite — so it exempted the real
# bug in trap-behavior.mjs and reported a clean sweep. Over-reporting wastes an
# afternoon; under-reporting hides the thing the check exists for.
GUARDED    = re.compile(r"game\s*\??\.\s*ready\b")

KEYWORDS = {"if", "for", "while", "switch", "catch", "return", "function",
            "typeof", "await", "new", "super", "constructor"}


def strip_comments(text):
    """Line and block comments out, everything else the same length."""
    out = []
    i, n = 0, len(text)
    while i < n:
        two = text[i:i + 2]
        if two == "//":
            j = text.find("\n", i)
            j = n if j < 0 else j
            out.append(" " * (j - i))
            i = j
        elif two == "/*":
            j = text.find("*/", i + 2)
            j = n if j < 0 else j + 2
            out.append("".join(c if c == "\n" else " " for c in text[i:j]))
            i = j
        else:
            out.append(text[i])
            i += 1
    return "".join(out)


def files():
    for mod in MODULES:
        d = ROOT / mod / "scripts"
        if not d.is_dir():
            print(f"  not installed here: {mod} — nothing of it was read.")
            continue
        yield from sorted(d.rglob("*.mjs"))


def block_after(text, start):
    """The braced block that follows `start`, by brace counting."""
    i = text.find("{", start)
    if i < 0:
        return ""
    depth, j = 0, i
    while j < len(text):
        if text[j] == "{":
            depth += 1
        elif text[j] == "}":
            depth -= 1
            if depth == 0:
                return text[i:j + 1]
        j += 1
    return text[i:]


def enclosing_class(text, pos):
    """The nearest `class Name` opened before pos and not yet closed."""
    best = None
    for m in CLASS_DEF.finditer(text, 0, pos):
        body_start = text.find("{", m.end())
        if body_start < 0:
            continue
        depth, j = 0, body_start
        while j < len(text):
            if text[j] == "{":
                depth += 1
            elif text[j] == "}":
                depth -= 1
                if depth == 0:
                    break
            j += 1
        if body_start < pos < j:
            best = m.group(1)
    return best


def main():
    sources = {f: strip_comments(f.read_text(encoding="utf-8", errors="replace"))
               for f in files()}

    # ── 1. What is called from inside a ready handler? ────────────────────
    called_in_ready = set()
    for text in sources.values():
        for m in READY_HOOK.finditer(text):
            body = block_after(text, m.end())
            for c in QUALIFIED.finditer(body):
                called_in_ready.add(f"{c.group(1)}.{c.group(2)}")
            for c in BARE_CALL.finditer(body):
                if c.group(1) not in KEYWORDS:
                    called_in_ready.add(c.group(1))

    # ── 2. Do any of them register a ready hook, unguarded? ───────────────
    DEF = re.compile(
        r"^\s*(?:static\s+|export\s+)*(?:async\s+)?(?:function\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{",
        re.M,
    )
    offenders = []
    for f, text in sources.items():
        raw = f.read_text(encoding="utf-8", errors="replace")
        for d in DEF.finditer(text):
            name = d.group(1)
            if name in KEYWORDS:
                continue
            cls = enclosing_class(text, d.start())
            keys = {name} | ({f"{cls}.{name}"} if cls else set())
            if not (keys & called_in_ready):
                continue
            body = block_after(text, d.end() - 1)
            if not READY_HOOK.search(body):
                continue
            if GUARDED.search(body):
                continue
            line = text[:d.start()].count("\n") + 1
            # The reason may be written in the prose this file stripped out.
            near = raw.split("\n")[max(0, line - 12):line + 40]
            if OPT_OUT.search("\n".join(near)):
                continue
            offenders.append((f, line, f"{cls}.{name}" if cls else name))

    print("=" * 74)
    print("A READY HOOK REGISTERED FROM INSIDE READY")
    print("=" * 74)
    print(f"Read {len(sources)} file(s). {len(called_in_ready)} name(s) are "
          f"called from a ready handler.")
    print()

    if not offenders:
        print("None. Every ready hook is registered before ready has run,")
        print("or guards itself so it runs either way.")
        return 0

    for f, line, name in offenders:
        print(f"  {f.relative_to(ROOT)}:{line}  {name}() registers a ready hook, and is called from one.")
    print()
    print("Foundry fires `ready` once. A listener added while ready is already")
    print("running never fires, and nothing warns. Guard it:")
    print("    if (game?.ready) run(); else Hooks.once(\"ready\", run);")
    print("or use `canvasReady`, or call the work directly.")
    return 1


if __name__ == "__main__":
    sys.exit(main())
