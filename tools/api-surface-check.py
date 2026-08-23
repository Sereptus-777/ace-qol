# ─── Does this API member actually exist? ────────────────────────────────────
#
# ⚠️ WHY THIS EXISTS. On 2026-08-22 the same defect shipped twice in one
# afternoon, and nothing the suite owns could see either one:
#
#   api.getFactionScoreLabel(id)   -- never existed; the API has getFactionScore,
#                                     which returns a NUMBER. Caught by hand.
#   api.memory                     -- never existed; the getter is memoryManager.
#                                     NOT caught by hand. It shipped.
#
# The second one rebuilt all 347 NPC journals from a null store, so every
# "Between Us" page came out empty, and it reported success. It also made the
# deed replay announce "no deeds found" as though the world had no history.
#
# ⚠️ OPTIONAL CHAINING IS WHAT MAKES THIS INVISIBLE. `api?.memory?.npcs` on a
# missing property yields undefined instead of throwing. No error, no warning,
# no stack trace. `node --check` sees valid syntax. ESLint's no-undef sees a
# property access and is satisfied. The only symptom is a feature that quietly
# does nothing, which is indistinguishable from a world that has no data.
#
# So: gather what the API actually defines, gather every place it is read, and
# print the difference. The pass condition is ZERO.
import io
import os
import re
import sys

ROOT = r"D:\FoundryVTT\Data\modules"
# ⚠️ ace-envoy IS PART OF THE SUITE and its code lives under src/, which is
# why three earlier "all four modules" sweeps only ever audited three.
MODULES = ["ace-qol", "ace-engine", "ace-artificer", "ace-token-art", "ace-envoy"]

# Where an API object is built. Both shapes appear in this codebase, and
# Object.assign matters because assigning a fresh object literal over
# `game.aceQol` once erased a dozen live registrations.
# ⚠️ THE REAL ONE IS `game.aceQol = Object.assign(game.aceQol ?? {}, {`.
# A pattern that demanded `= {` or `Object.assign(handle, {` missed it over the
# `?? {}` in the middle, so all ~40 members ace-qol exports there were reported
# as undefined. Match the assign broadly and let the member scanner sort it out.
API_BLOCK = re.compile(
    r"(?:mod\.api|module\.api|\w+\.api)\s*=\s*\{"
    r"|Object\.assign\("
    # ⚠️ AND `const api = { … }`, a plain local later attached to mod.api.
    # ace-engine builds its whole surface that way, so missing this shape
    # reported getPanel and getMemoryManager as undefined when both are
    # defined thirty lines apart in the same object.
    r"|(?<![.\w])api\s*=\s*\{")

# A member on that object. FOUR shapes, and missing any one of them turns this
# tool into a liar:
#   name: value        the obvious one
#   async name(  /  get name()
#   name,              ES6 shorthand - ace-qol exports ~40 members this way and
#                      the first version of this tool reported every one of them
#                      as undefined
MEMBER = re.compile(
    r"^\s*(?:async\s+|get\s+|set\s+)?"
    r"(?:\"([A-Za-z_$][\w$]*)\"|'([A-Za-z_$][\w$]*)'|([A-Za-z_$][\w$]*))"
    r"\s*(?::|\(|,\s*(?://.*)?$|\s*(?://.*)?$)")

# Members attached one at a time rather than in a literal:
#   game.aceQol.speciesOf = ...      mod.api.foo = ...
DIRECT_ATTACH = re.compile(
    r"(?:game\.\w+|mod\.api|module\.api)\.([A-Za-z_$][\w$]*)\s*=(?!=)")

# Reading something off an api handle.
ACCESS = re.compile(
    r"\bapi\s*\??\.\s*([A-Za-z_$][\w$]*)"
    r"|\.api\s*\??\.\s*([A-Za-z_$][\w$]*)")

# ⚠️ FOUNDRY HAS AN `api` NAMESPACE OF ITS OWN and it is not ours.
# `foundry.applications.api.DialogV2` matched the pattern above 37 times on the
# first run and every one was reported as a missing member of our API. An audit
# that cries wolf gets ignored, which is worse than not having it.
FOUNDRY_NS = re.compile(r"foundry\s*\.\s*\w+\s*\.\s*api\s*\.")

# Things that are not API members even though they read like one.
IGNORE = {"then", "catch", "finally", "constructor", "prototype", "call", "apply",
          "bind", "toString", "valueOf", "hasOwnProperty",
          # `mod.api` reads the api OFF a module handle; "api" is not a member of itself.
          "api",
          # ⚠️ FOUNDRY'S OWN MODULE PROPERTIES. `envoy?.active`, `forge?.active`
          # and `mod.version` read the MODULE object, not our API, and reporting
          # them as missing members is noise that buries the real findings.
          "active", "id", "version", "title", "esmodules", "styles", "flags",
          "data", "compatibility", "socket", "download", "manifest"}

# ⚠️ A URL IS NOT AN API READ. `https://api.elevenlabs.io` satisfies a word boundary because
# the character before "api" is a slash, so a naive word-boundary reported
# every TTS endpoint in the file as a missing member.
NOT_A_HANDLE_BEFORE = r"(?<![/.\w$])"


def source_files(module):
    base = os.path.join(ROOT, module)
    for dirpath, _dirs, files in os.walk(base):
        if "node_modules" in dirpath or ".git" in dirpath:
            continue
        for f in files:
            if f.endswith((".mjs", ".js")):
                yield os.path.join(dirpath, f)


def brace_scan(lines, start):
    """Yield the lines of the object literal that opens on `start`."""
    depth = 0
    started = False
    for i in range(start, len(lines)):
        line = lines[i]
        if not started:
            if "{" in line:
                started = True
            else:
                continue
        depth += line.count("{") - line.count("}")
        yield line
        if started and depth <= 0:
            return


def defined_members(module):
    """Every member name any API object in this module defines."""
    names = set()
    for path in source_files(module):
        try:
            src = io.open(path, encoding="utf-8", errors="ignore").read()
        except OSError:
            continue
        lines = src.split("\n")
        for i, line in enumerate(lines):
            if not API_BLOCK.search(line):
                continue
            for body in brace_scan(lines, i):
                m = MEMBER.match(body)
                if m:
                    names.add(m.group(1) or m.group(2) or m.group(3))
        for m in DIRECT_ATTACH.finditer(src):
            names.add(m.group(1))
    return names - IGNORE


# ⚠️ ONLY OUR API COUNTS, and getting this wrong is what made the first two runs
# useless. `SimpleCalendar.api.setDate`, `game.modules.get("sequencer")?.api?.Sequence`
# and the string "https://api.openai.com" all match a naive pattern, and none of
# them are ours to define. 116 findings, every one a lie.
OUR_HANDLE = re.compile(
    r"""(?:game\.modules(?:\?)?\.get\(\s*(?:MODULE_ID|["']ace-[\w-]+["'])\s*\)|"""
    r"""game\.(?:aceQol|aceEngine|aceForge|aceArtificer|aceEnvoy|aceTokenArt))""")

# Inline, with no local: `game.modules.get(MODULE_ID)?.api?.replayDeeds`
OUR_INLINE = re.compile(
    OUR_HANDLE.pattern + r"\s*\??\.\s*api\s*\??\.\s*([A-Za-z_$][\w$]*)", re.X)

# A local assigned from our API, decided on ONE LINE and nothing cleverer:
#     const api = game.aceQol;
#     const api = game.modules.get(MODULE_ID)?.api;
#
# ⚠️ AN EARLIER VERSION MATCHED ACROSS A WHOLE FILE and swept in `result`,
# `intent`, `engine` and `panel`, then dutifully reported `result.fileCount` as
# a missing API member. 187 findings, all false. A verbose-mode regex built by
# splicing another pattern's source was the cause; both are gone.
ASSIGN = re.compile(r"^\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(.+)$")


def accesses(module):
    """Every (file, line, member) read off OUR api, and nobody else's."""
    out = []
    for path in source_files(module):
        try:
            src = io.open(path, encoding="utf-8", errors="ignore").read()
        except OSError:
            continue
        rel = os.path.relpath(path, ROOT)
        lines = src.split("\n")

        # Which local names in this file hold our API? One line, one decision.
        #
        # ⚠️ AND A NAME THAT MEANS TWO THINGS MEANS NEITHER. ace-engine.mjs uses
        # `const mod = game.modules.get(MODULE_ID)` in one place and
        # `const mod = await import("./npc/auto-pipeline.mjs")` in another. This
        # tracker is file-wide and cannot see block scope, so it happily reported
        # `mod.activateAutoPipeline()` — a perfectly good call on an ES module
        # namespace — as a missing API member. Any name that is ever assigned
        # from something that is NOT our API is dropped, because a false finding
        # costs more trust than a missed one is worth.
        ours, ambiguous = set(), set()
        for line in lines:
            m = ASSIGN.match(line)
            if not m:
                continue
            name, rhs = m.group(1), m.group(2)
            if not OUR_HANDLE.search(rhs):
                ambiguous.add(name)
                continue
            # The right-hand side must END at the api, not merely mention it:
            # `const api = game.aceEngine` or `... .get(MODULE_ID)?.api`.
            if re.search(r"\.api\s*\??\s*[;)]?\s*$", rhs) or re.search(
                    OUR_HANDLE.pattern + r"\s*\??\s*[;)]?\s*$", rhs, re.X):
                ours.add(name)
            else:
                ambiguous.add(name)
        ours -= ambiguous

        for n, line in enumerate(lines, 1):
            stripped = line.strip()
            if stripped.startswith(("//", "*", "/*")):
                continue
            if FOUNDRY_NS.search(line):
                continue
            for m in OUR_INLINE.finditer(line):
                name = m.group(1)
                if name and name not in IGNORE:
                    out.append((rel, n, name, stripped[:96]))
            for handle in ours:
                for m in re.finditer(
                        NOT_A_HANDLE_BEFORE + re.escape(handle)
                        + r"\s*\??\.\s*([A-Za-z_$][\w$]*)", line):
                    name = m.group(1)
                    if name and name not in IGNORE:
                        out.append((rel, n, name, stripped[:96]))
    # One report per (file, line, name).
    return sorted(set(out))


def main():
    print("API MEMBERS READ THAT ARE NEVER DEFINED")
    print("=" * 76)
    total = 0

    # ⚠️ Cross-module: ace-engine reads game.aceQol and vice versa, so a member
    # defined in a sibling is not missing. Gather every module's surface first.
    everywhere = set()
    per_module = {}
    for module in MODULES:
        if not os.path.isdir(os.path.join(ROOT, module)):
            continue
        per_module[module] = defined_members(module)
        everywhere |= per_module[module]

    for module in per_module:
        missing = {}
        for path, line, name, snippet in accesses(module):
            if name in everywhere:
                continue
            missing.setdefault(name, []).append((path, line, snippet))
        if not missing:
            print(f"\n  {module}: clean ({len(per_module[module])} members defined)")
            continue
        print(f"\n  {module}: {len(missing)} name(s) read but never defined")
        for name, sites in sorted(missing.items()):
            print(f"\n     api.{name}   read in {len(sites)} place(s)")
            for path, line, snippet in sites[:4]:
                print(f"        {path}:{line}")
                print(f"           {snippet}")
            total += len(sites)

    print("\n" + "=" * 76)
    if total:
        print(f"{total} access(es) to something that does not exist.")
        print("Each one returns undefined instead of throwing, so the feature")
        print("silently does nothing and reports success.")
        sys.exit(1)
    print("Every API member that is read is defined somewhere in the suite.")
    sys.exit(0)


if __name__ == "__main__":
    main()
