# -*- coding: utf-8 -*-
# --- Package the ACE suite source for an outside audit ----------------------
#
# WHY THIS IS A TOOL AND NOT A COMMAND I TYPE EACH TIME.
#
# 1. THE ZIP I HANDED OUT ON 2026-08-18 CONTAINED A LIVE API KEY. It was not
#    in a file with a suspicious extension; it was sitting in ordinary source.
#    Filtering by file type would not have caught it and did not. So this
#    reads the CONTENT of every file that goes in, and refuses to write the
#    archive at all if anything looks like a credential.
#
# 2. THE MODULE LIST IS EXPLICIT, AND ZERO FILES IS AN ERROR. A walk that
#    finds nothing where it expected a module reports success just as
#    cheerfully as one that finds everything, so this refuses to build.
#
#    Related, and worth writing down because I had it wrong: ace-envoy is NOT
#    a fourth module any more. Its own manifest calls it a compatibility shim
#    and says the code MERGED into ACE: Engine at v2.5.0. Nine files is the
#    whole of it. Earlier sweeps that covered qol, engine, artificer and
#    token-art were therefore complete, not short by one.
#
# Run:  python tools/make-audit-zip.py
import io
import os
import re
import sys
import zipfile
from datetime import date

MODULES_ROOT = r"D:\FoundryVTT\Data\modules"
OUT_DIR = r"C:\Users\johnp\OneDrive\Desktop\ACE Project\Grok Audit"

# ⚠️ EXPLICIT. Not a glob of whatever happens to be in the modules folder -
# that would sweep in every third-party module Johnny has installed.
#
# ⚠️🔴 ace-envoy IS NOT WHERE THE OTHERS ARE. On 2026-08-26 it was
# found parked at modules/AAA-BAKUPS/ace-envoy - a NESTED folder, which
# Foundry does not load, so envoy 2.5.6 is not running in his world at all.
# That is worth knowing on its own, and it also explains why three "all four
# modules" sweeps in a row silently audited three: the walk looked for it
# beside the others and found nothing, and nothing is not an error.
MODULE_PATHS = {
    "ace-qol":       [r"ace-qol"],
    "ace-engine":    [r"ace-engine"],
    "ace-artificer": [r"ace-artificer"],
    # Forward slash deliberately. A backslash before "ace" is the escape
    # backslash-a, which becomes a literal BEL byte when anything writes this
    # string through a shell: it lints clean, prints as nothing, and never
    # matches. That is exactly how it broke on the first run of this line.
    "ace-envoy":     ["ace-envoy", "AAA-BAKUPS/ace-envoy"],
    "ace-token-art": [r"ace-token-art"],
}
MODULES = list(MODULE_PATHS.keys())

KEEP_EXT = {".mjs", ".js", ".json", ".css", ".html", ".hbs", ".md", ".py"}
SKIP_DIRS = {"node_modules", ".git", ".github", "packs", "assets", "sounds",
             "icons", "images", "img", "fonts", "media", "dist", "build",
             "coverage", ".vscode", ".idea", "lang"}
MAX_FILE = 2 * 1024 * 1024  # a source file bigger than this is data, not code

# --- Credential patterns ----------------------------------------------------
#
# Written as (label, regex). Keep them broad: a false positive costs one look,
# a false negative costs a leaked key. Every one of these has a real provider
# behind it, and the ElevenLabs shape is the one that actually got out.
SECRET_PATTERNS = [
    ("Anthropic key",      r"sk-ant-[A-Za-z0-9_\-]{20,}"),
    ("OpenAI key",         r"\bsk-(?!ant-)[A-Za-z0-9]{32,}"),
    ("ElevenLabs key",     r"\bsk_[A-Za-z0-9]{32,}"),
    ("Google API key",     r"\bAIza[0-9A-Za-z_\-]{35}"),
    ("GitHub token",       r"\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}"),
    ("GitHub PAT",         r"\bgithub_pat_[A-Za-z0-9_]{50,}"),
    ("Slack token",        r"\bxox[baprs]-[A-Za-z0-9\-]{10,}"),
    ("AWS access key",     r"\bAKIA[0-9A-Z]{16}\b"),
    ("Bearer token",       r"[Bb]earer\s+[A-Za-z0-9_\-\.=]{30,}"),
    ("private key block",  r"-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----"),
    ("assigned secret",    r"(?i)\b(?:api[_-]?key|apikey|secret|password|passwd|"
                           r"access[_-]?token|auth[_-]?token|client[_-]?secret)"
                           r"\s*[:=]\s*[\"'][^\"'\s]{24,}[\"']"),
]
COMPILED = [(label, re.compile(rx)) for label, rx in SECRET_PATTERNS]

# Text that LOOKS like the above but is a placeholder, not a credential. A
# scanner that cries wolf gets switched off, and then it protects nothing.
PLACEHOLDER = re.compile(
    r"(?i)(your[_-]?key|example|placeholder|xxxx|<[^>]{1,40}>|\.\.\.|"
    r"changeme|dummy|sk-ant-api03-\.\.\.|redacted|inserted[_-]?here)")


def scan(text, rel):
    """Every credential-shaped run of characters in one file."""
    hits = []
    for label, rx in COMPILED:
        for m in rx.finditer(text):
            frag = m.group(0)
            if PLACEHOLDER.search(frag):
                continue
            line = text.count(chr(10), 0, m.start()) + 1
            # Show enough to recognise it, never enough to use it.
            shown = frag[:12] + "..." + ("[%d chars]" % len(frag))
            hits.append((rel, line, label, shown))
    return hits


collected, findings, per_module, where = [], [], {}, {}

for mod in MODULES:
    base = None
    for candidate in MODULE_PATHS[mod]:
        trial = os.path.join(MODULES_ROOT, candidate)
        if os.path.isdir(trial):
            base = trial
            break
    if base is None:
        print("MISSING MODULE: %s is at none of %s"
              % (mod, ", ".join(MODULE_PATHS[mod])))
        sys.exit(1)
    where[mod] = os.path.relpath(base, MODULES_ROOT).replace("\\", "/")
    count = 0
    for dp, dn, fns in os.walk(base):
        dn[:] = [d for d in dn if d not in SKIP_DIRS]
        for fn in fns:
            if os.path.splitext(fn)[1].lower() not in KEEP_EXT:
                continue
            full = os.path.join(dp, fn)
            try:
                if os.path.getsize(full) > MAX_FILE:
                    continue
                text = io.open(full, encoding="utf-8", errors="ignore").read()
            except OSError:
                continue
            rel = mod + "/" + os.path.relpath(full, base).replace("\\", "/")
            findings.extend(scan(text, rel))
            collected.append((full, rel))
            count += 1
    per_module[mod] = count

print("")
print("ACE AUDIT PACKAGE")
print("=" * 78)
for mod in MODULES:
    print("  %-16s %4d files   %s" % (mod, per_module[mod], where[mod]))
    if per_module[mod] == 0:
        # envoy hid under src/ and three sweeps in a row reported success.
        print("     ^ ZERO FILES. This module contributes nothing to the audit.")
        print("       Check its layout before shipping - a module whose code is")
        print("       somewhere this walk does not look reads as 'covered'.")
        sys.exit(1)
print("  %-16s %4d files" % ("TOTAL", len(collected)))

print("")
print("CREDENTIAL SCAN (contents, not extensions)")
print("-" * 78)
if findings:
    for rel, line, label, shown in findings:
        print("  %s:%d  %s  %s" % (rel, line, label, shown))
    print("")
    print("REFUSING TO WRITE THE ARCHIVE.")
    print("A live key went out in the 2026-08-18 zip exactly this way. Remove or")
    print("redact the values above, then run this again.")
    sys.exit(1)
print("  clean - nothing credential-shaped in %d files" % len(collected))

stamp = date.today().isoformat()
os.makedirs(OUT_DIR, exist_ok=True)

# ⚠️ NEVER CLOBBER A ZIP SOMEBODY IS ALREADY READING. Two builds on one day
# is the normal case, not the exception - an audit comes back, the findings get
# fixed, and the tree is repackaged the same night. Overwriting means the
# reviewer's copy silently becomes a different pile of code than the one their
# notes refer to, and nobody can tell which zip a finding came from.
#
# Same day, second build -> -b, then -c. The earlier zips stay exactly as they
# were.
out = os.path.join(OUT_DIR, "ACE-SUITE-SOURCE-%s.zip" % stamp)
if os.path.exists(out):
    suffix = ord("b")
    while os.path.exists(os.path.join(OUT_DIR, "ACE-SUITE-SOURCE-%s%s.zip" % (stamp, chr(suffix)))):
        suffix += 1
        if suffix > ord("z"):
            print("More than 25 builds today. Something is wrong; refusing.")
            sys.exit(1)
    out = os.path.join(OUT_DIR, "ACE-SUITE-SOURCE-%s%s.zip" % (stamp, chr(suffix)))
    print("")
    print("  An archive for today already exists and is left untouched.")
    print("  Writing a new revision instead: %s" % os.path.basename(out))

with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
    for full, rel in collected:
        z.write(full, rel)

print("")
print("WROTE  %s" % out)
print("       %d files, %.1f MB" % (len(collected), os.path.getsize(out) / 1048576.0))
