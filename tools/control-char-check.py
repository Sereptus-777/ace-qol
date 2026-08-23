# ─── Find control characters that ate an escape ──────────────────────────────
#
# ⚠️ WHY THIS EXISTS. On 2026-08-22 a single lost backslash turned `\b` into a
# literal BACKSPACE byte (0x08) inside a regex. The pattern then demanded a
# character no input will ever contain, so it matched nothing, silently, forever:
#
#     (HEROIC|VILLAINOUS|NEUTRAL)^H\s*
#     /^Hsun\s*(light|beam|burst)^H/
#
# NOTHING ELSE WE OWN CAN SEE THIS. `node --check` passes. eslint passes with
# zero errors. Nothing throws. The regex is simply always false, and every
# consequence downstream looks like a feature that "doesn't work" for reasons
# nobody can find.
#
# It happened five times in one night while writing files through a shell into
# python, where "\b" is a backspace escape. The same trap exists for \n \t \f
# \v \0 \a \r.
#
# ⚠️ AND IT FOUND ONE THAT PREDATED THAT NIGHT ENTIRELY: in
# ace-qol/scripts/flight-visuals.mjs the word boundaries around "fly", "flight"
# and "land" were all backspaces, so ACE's flight visuals had never once
# recognised the three most obvious ability names. "Levitate" and "Soar" worked.
# "Fly" never did. Nobody would ever have found that by reading the code.
#
# Run before every handover. The pass condition is ZERO.
import io, os, re, sys

ROOT = r"D:\FoundryVTT\Data\modules"
MODULES = ["ace-qol", "ace-engine", "ace-artificer", "ace-token-art"]

# Everything below space except tab (09), newline (0a) and carriage return (0d),
# which are legitimately present in source.
BAD = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f]")

NAMES = {0x00: r"\0", 0x07: r"\a", 0x08: r"\b (word boundary)", 0x0b: r"\v",
         0x0c: r"\f", 0x1b: "ESC"}

hits = []
for mod in MODULES:
    base = os.path.join(ROOT, mod)
    if not os.path.isdir(base):
        continue
    for dp, _dirs, files in os.walk(base):
        if "node_modules" in dp or ".git" in dp:
            continue
        for f in files:
            # ⚠️ .py WAS MISSING AND IT COST A REAL BUG (2026-08-22). This script
            # itself is Python, and so is every builder in modules/*/tools. Two
            # eaten escapes went into build-scene-docs.py the same afternoon:
            #   ^(Arrived in|Slew|Departed|Entered|Left)<BS>
            #   ^(the|a|an)<BS>
            # The first let 138 movement-log lines through into documents meant
            # for a narrated video; the second produced "took the The Abbot's
            # Divine Correspondence". A checker that only looks at the language
            # where the problem was FIRST found is a checker with a blind spot.
            if not f.endswith((".mjs", ".js", ".py")):
                continue
            path = os.path.join(dp, f)
            try:
                src = io.open(path, encoding="utf-8", errors="ignore").read()
            except OSError:
                continue
            for m in BAD.finditer(src):
                line = src[: m.start()].count("\n") + 1
                code = ord(m.group())
                snippet = src.split("\n")[line - 1].strip()[:88]
                hits.append((os.path.relpath(path, ROOT), line, code, snippet))

print("CONTROL CHARACTERS IN SHIPPED SOURCE")
print("=" * 74)
if not hits:
    print("\nnone. Every escape survived being written to disk.")
    sys.exit(0)

for path, line, code, snippet in hits:
    print(f"\n  {path}:{line}")
    print(f"      0x{code:02x}  probably meant to be {NAMES.get(code, 'an escape')}")
    print(f"      {snippet}")
print(f"\n{len(hits)} found. Each one is a regex or string that can never match "
      f"what it was written to match.")
sys.exit(1)
