# ─── A setting read but never registered is a switch that does not exist ─────
#
# ⚠️ WHY THIS EXISTS. On 2026-08-23 an audit found `autoAnimations` in ace-qol:
# read once, registered nowhere. `game.settings.get` THROWS on a key that was
# never registered, the read sat inside a try/catch that returned true, and the
# comment beside it admitted the situation — "setting not registered yet".
#
# Net effect: the spell flourish and impact silhouette were permanently ON with
# no switch anywhere. A GM who found them distracting had nothing to click and
# nothing to find. A feature with a toggle that does not exist is the same shape
# as a button wired to nothing, and it is invisible to every other check we run:
# the syntax is valid, no identifier is undefined, and it never surfaces an
# error because the catch eats it.
#
# ⚠️ IT REPORTS TWO TIERS, AND THAT MATTERS. Some settings are registered by a
# local helper (`reg("monsterAutomation", …)`) rather than by a direct call, and
# a scanner that cannot see those would cry wolf. Anything that looks
# helper-registered is listed SEPARATELY as "verify by hand" rather than being
# called a defect. A wrong finding costs hours to disprove and teaches everyone
# to ignore the tool.
#
# The pass condition is zero in the first list.
import io
import os
import re
import sys

ROOT = r"D:\FoundryVTT\Data\modules"
MODULES = ["ace-qol", "ace-engine", "ace-artificer", "ace-token-art"]

# Keys built at runtime from a table; not literals, so never "missing".
DYNAMIC_PREFIXES = ("edition.",)


def scan(module):
    base = os.path.join(ROOT, module)
    registered = set()
    helper_literals = set()
    read = {}

    for dirpath, dirs, files in os.walk(base):
        if "node_modules" in dirpath or ".git" in dirpath:
            continue
        for f in files:
            if not f.endswith(".mjs"):
                continue
            path = os.path.join(dirpath, f)
            try:
                src = io.open(path, encoding="utf-8", errors="ignore").read()
            except OSError:
                continue
            rel = os.path.relpath(path, ROOT)

            # Direct registrations.
            for m in re.finditer(
                    r"settings\.register(?:Menu)?\(\s*[^,]+,\s*[\"']([\w.]+)[\"']", src):
                registered.add(m.group(1))

            # ⚠️ FIND THE HELPER, DO NOT GUESS AT IT. Most of the suite
            # registers through a tiny wrapper defined at the top of the file:
            #     const s = (key, data) => game.settings.register(ID, key, {...})
            # A scanner blind to those reports nearly every setting as missing.
            #
            # The first version of this check matched ANY call whose first
            # argument was a string, which produced 180 rows of "verify by hand"
            # — a tool nobody would run twice. So: identify the wrapper BY NAME
            # from its definition, then count calls to that name, and nothing
            # else.
            helpers = set()
            arrow = re.compile(
                r"(?:const|let|var)\s+(\w+)\s*=\s*\([^)]*\)\s*=>[\s\S]{0,220}?settings\.register")
            for hm in arrow.finditer(src):
                helpers.add(hm.group(1))
            fn = re.compile(r"function\s+(\w+)\s*\([^)]*\)\s*\{[\s\S]{0,320}?settings\.register")
            for hm in fn.finditer(src):
                helpers.add(hm.group(1))
            for h in helpers:
                for m in re.finditer(r"\b" + re.escape(h) + r"\(\s*[\"\']([\w.]+)[\"\']", src):
                    registered.add(m.group(1))

            # Reads and writes against this module's own id.
            pat = (r"settings\.(?:get|set)\(\s*(?:MODULE_ID|[\"']"
                   + re.escape(module) + r"[\"'])\s*,\s*[\"']([\w.]+)[\"']")
            for m in re.finditer(pat, src):
                read.setdefault(m.group(1), set()).add(rel)

    return registered, helper_literals, read


def main():
    print("SETTINGS READ BUT NEVER REGISTERED")
    print("=" * 78)
    definite = 0
    for module in MODULES:
        if not os.path.isdir(os.path.join(ROOT, module)):
            continue
        registered, helper_literals, read = scan(module)

        missing, probable = [], []
        for key, where in read.items():
            if key in registered:
                continue
            if key.startswith(DYNAMIC_PREFIXES):
                continue
            (probable if key in helper_literals else missing).append((key, where))

        print(f"\n  {module}: {len(registered)} registered, {len(read)} keys read")
        for key, where in sorted(missing):
            definite += 1
            print(f"     MISSING  \"{key}\"")
            for w in sorted(where):
                print(f"                read in {w}")
        for key, _w in sorted(probable):
            print(f"     probably registered by a local helper: \"{key}\" — verify by hand")
        if not missing and not probable:
            print("     every setting read is registered")

    print("\n" + "=" * 78)
    if definite:
        print(f"{definite} setting(s) read but never registered.")
        print("game.settings.get THROWS on an unregistered key. If the read sits in a")
        print("try/catch, the feature silently takes its fallback forever and the")
        print("switch the code implies simply does not exist.")
        sys.exit(1)
    print("Every setting read by name is registered.")
    sys.exit(0)


if __name__ == "__main__":
    main()
