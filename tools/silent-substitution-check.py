# ─── Find failure branches that report SUCCESS ──────────────────────────────
#
# Why this exists. Every tool we own checks whether the code is WELL FORMED:
# node --check finds syntax, eslint finds undefined names, platform-contract
# finds renamed APIs, ready-hook-check finds handlers that never fire. All of
# them pass, happily, on code like this:
#
#     if (result.status !== "ok") {
#         console.warn(...);          // a console nobody has open
#         await this._speakBrowser(); // a DIFFERENT, worse implementation
#         return "ok";                // ← and it reports SUCCESS
#     }
#
# Syntactically perfect. Lints clean. Throws nothing. Returns something the
# caller believes. That is how NPC voices played Windows speech synthesis for
# weeks while the real cause never reached a human: the failure did not
# disappear, it got DRESSED UP AS A RESULT.
#
# ⚠️ A NOISY AUDIT IS A DEAD AUDIT. There are ~150 quiet catches in the suite
# that return a sensible default, and almost all of them are fine. Flagging them
# all is how an audit gets ignored. So this asks the narrow, nasty question
# only: does a branch that ran BECAUSE SOMETHING FAILED hand its caller a
# success value, without telling a human? Every layer above such a branch is
# being lied to, so no amount of correct error handling further up can save it.
import io, os, re

ROOT    = r"D:\FoundryVTT\Data\modules"
MODULES = ["ace-qol", "ace-engine", "ace-artificer", "ace-token-art"]

FAIL_BRANCH = re.compile(
    r"(\bcatch\s*\([^)]*\)\s*\{"
    r"|if\s*\(\s*!\s*\w+(\.\w+)*\s*\)\s*\{"
    r"|if\s*\([^)]*status\s*!==\s*[\"']ok[\"'][^)]*\)\s*\{"
    r"|if\s*\(\s*![\w.]*\.ok\s*\)\s*\{)")

TELLS_A_HUMAN  = re.compile(r"ui\.notifications|Dialog|ChatMessage\.create")
RERAISES       = re.compile(r"\bthrow\b")
DOES_SOMETHING = re.compile(r"\bawait\s+\w|\bthis\._\w+\(|\b\w+Engine\.\w+\(")
CLAIMS_SUCCESS = re.compile(
    r"return\s+[\"']ok[\"']"
    r"|return\s+true\b"
    r"|return\s*\{[^}]*(ok\s*:\s*true|status\s*:\s*[\"']ok[\"'])")

def body_of(src, i):
    depth, n = 0, len(src)
    while i < n:
        if src[i] == "{": depth += 1
        elif src[i] == "}":
            depth -= 1
            if depth == 0: return src[:i + 1]
        i += 1
    return ""

rows = []
for mod in MODULES:
    base = os.path.join(ROOT, mod)
    if not os.path.isdir(base): continue
    for dirpath, _d, files in os.walk(base):
        if "node_modules" in dirpath or ".git" in dirpath: continue
        for f in files:
            if not f.endswith((".mjs", ".js")): continue
            path = os.path.join(dirpath, f)
            src = io.open(path, encoding="utf-8", errors="ignore").read()
            for m in FAIL_BRANCH.finditer(src):
                brace = src.find("{", m.start())
                if brace < 0: continue
                body = body_of(src, brace)[brace:] if False else body_of(src, brace)
                body = body[brace:] if body.startswith(src[:1]) and False else body
                seg = body_of(src, brace)
                seg = seg[brace:] if len(seg) > brace else seg
                if not seg or len(seg) > 4000: continue
                if not DOES_SOMETHING.search(seg): continue
                if TELLS_A_HUMAN.search(seg):     continue
                if RERAISES.search(seg):          continue
                hit = CLAIMS_SUCCESS.search(seg)
                if not hit: continue
                rows.append((mod, os.path.relpath(path, base),
                             src[:m.start()].count("\n") + 1,
                             " ".join(hit.group(0).split())[:44]))

rows.sort()
print("FAILURE BRANCHES THAT REPORT SUCCESS")
print("=" * 70)
for mod in MODULES:
    hits = [r for r in rows if r[0] == mod]
    print(f"\n{mod}: {len(hits)}")
    for _m, rel, line, claim in hits:
        print(f"   {rel}:{line}   returns: {claim}")
print(f"\nTOTAL: {len(rows)}")
