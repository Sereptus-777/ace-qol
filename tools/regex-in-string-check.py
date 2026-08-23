# ─── A regex escape inside a STRING is not a regex escape ────────────────────
#
# ⚠️ WHY THIS EXISTS. This defect has now shipped three separate times in one
# day, in three different files, and nothing the suite owns could see any of it:
#
#   faction-registry.mjs   ["\bgnolls?\b", "gnoll"]  -> new RegExp(pat, "i")
#       All 17 creature hints, dead since written. 448 of 461 factions were
#       therefore recorded as made of HUMANS, including ones named "Gnolls" and
#       "Kobolds", which is why the matcher could not place a single monster and
#       why ACE was made to INVENT tribes it never needed.
#
#   faction-roster.mjs     new RegExp("(^|\b)(none|unknown|...)", "i")
#       Written ONE HOUR after the above was found and documented. Of ~55
#       factions whose leader is a description, 3 were caught. "Various Thayan
#       Zulkirs" and "Unknown cult leader" were seated as people.
#
#   api-surface-check.py   r"|\bapi\s*=\s*\{"  (a different eaten-escape route)
#
# ⚠️ IN A JAVASCRIPT STRING, \b IS A BACKSPACE. So is nothing else useful:
#       "\b" -> chr(8)      "\d" -> "d"      "\w" -> "w"      "\s" -> "s"
# The regex that comes out is silently wrong and can never match. It needs
# "\\b", or better, a REGEX LITERAL /\b/ which has no escaping layer at all.
#
# ⚠️ AND control-char-check.py CANNOT FIND THIS. The bytes on disk are a clean
# backslash followed by a letter; the corruption only exists at runtime, after
# the JS parser has read the string. Different bug, different check.
#
# Run before every handover. The pass condition is ZERO.
import io
import os
import re
import sys

ROOT = r"D:\FoundryVTT\Data\modules"
MODULES = ["ace-qol", "ace-engine", "ace-artificer", "ace-token-art", "ace-envoy"]

# A string literal, single or double quoted, non-greedy, allowing escaped quotes.
STRING = re.compile(r'"((?:[^"\\\n]|\\.)*)"' r"|'((?:[^'\\\n]|\\.)*)'")

# Regex escapes that a JS string literal will silently ruin.
RUINED = "bdwsBDWSpP"

# Lines that build a pattern rather than merely holding text.
BUILDS_A_REGEX = re.compile(r"new\s+RegExp\s*\(|RegExp\s*\(")


def suspect_escapes(literal):
    """Regex escapes in this string body that JS will eat.

    ⚠️ COUNT THE BACKSLASHES, DO NOT TRY TO PARSE THEM. The rule is simply:
    an ODD number of backslashes immediately before a regex letter means the
    last one binds to the letter, and JS eats it.

        \\b   1 backslash,  odd  -> becomes a BACKSPACE. Broken.
        \\\\b  2 backslashes, even -> an escaped backslash, then b. Correct.

    An earlier version walked matches of a backslash-plus-any pattern and got
    the offsets wrong, so it flagged correct code. A false finding makes an
    audit worse than useless, and this one exists precisely because three real
    defects went unseen.
    """
    found = []
    for i, ch in enumerate(literal):
        if ch not in RUINED:
            continue
        n = 0
        j = i - 1
        while j >= 0 and literal[j] == "\\":
            n += 1
            j -= 1
        if n % 2 == 1:
            found.append("\\" + ch)
    return found


def source_files(module):
    base = os.path.join(ROOT, module)
    for dirpath, _dirs, files in os.walk(base):
        if "node_modules" in dirpath or ".git" in dirpath:
            continue
        for f in files:
            if f.endswith((".mjs", ".js")):
                yield os.path.join(dirpath, f)


def main():
    print("REGEX ESCAPES INSIDE STRING LITERALS")
    print("=" * 76)
    total = 0

    for module in MODULES:
        if not os.path.isdir(os.path.join(ROOT, module)):
            continue
        hits = []
        for path in source_files(module):
            try:
                src = io.open(path, encoding="utf-8", errors="ignore").read()
            except OSError:
                continue
            lines = src.split("\n")
            # A RegExp built from strings can span several lines of
            # concatenation, so once one opens, keep looking for a few lines.
            armed = 0
            for n, line in enumerate(lines, 1):
                stripped = line.strip()
                if stripped.startswith(("//", "*", "/*", "#")):
                    continue
                if BUILDS_A_REGEX.search(line):
                    armed = 6            # this line and the next few
                if armed <= 0:
                    continue
                armed -= 1
                for m in STRING.finditer(line):
                    body = m.group(1) if m.group(1) is not None else m.group(2)
                    if not body:
                        continue
                    bad = suspect_escapes(body)
                    if bad:
                        hits.append((os.path.relpath(path, ROOT), n,
                                     ", ".join(sorted(set(bad))), stripped[:92]))
        if not hits:
            print(f"\n  {module}: clean")
            continue
        print(f"\n  {module}: {len(hits)} string(s) fed to RegExp with an eaten escape")
        for path, n, bad, snippet in hits:
            print(f"\n     {path}:{n}   {bad}")
            print(f"        {snippet}")
        total += len(hits)

    print("\n" + "=" * 76)
    if total:
        print(f"{total} pattern(s) that can never match what they were written to match.")
        print("In a JS string, \\b is a backspace and \\d \\w \\s are just letters.")
        print("Use a REGEX LITERAL — /\\b/ — or double every backslash.")
        sys.exit(1)
    print("No regex escape is trapped inside a string literal.")
    sys.exit(0)


if __name__ == "__main__":
    main()
