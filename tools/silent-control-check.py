# ─── A control written in code fires no event, so nothing records it ─────────
#
# ⚠️ WHY THIS EXISTS. On 2026-08-23 Johnny reported that the PC glow size would
# not stick: drag it from 1.5 to 0.7, the panel says "saved 1 setting", come
# back and it is 1.5 again. It had never worked.
#
# ACE Engine's config panel records edits by listening for `input` and `change`
# on every `[data-setting-key]` control, and Save writes ONLY what was recorded
# — a deliberate design, because a Save that writes the whole screen once
# committed a bad render over his API key.
#
# But assigning to `.value` or `.checked` in JavaScript DISPATCHES NOTHING. So
# every place the panel filled a field for the user changed what was on screen
# and recorded nothing:
#
#   slider  -> number box    every range setting was unsaveable by its slider
#   provider swap -> apiUrl  pick Ollama, see localhost:11434, save, lose it
#   provider swap -> model   same
#   deprecation banner       printed "Click Save Changes to persist" for a
#                            value Save could not see
#
# ⚠️ AND NOTHING WE OWNED COULD SEE IT. The syntax is valid, no identifier is
# undefined, nothing throws, and the panel reports success. It is the same
# family as a renamed method called with `?.` — a silent no-op wearing the
# clothes of a working feature.
#
# ⚠️ NOT EVERY ASSIGNMENT IS A BUG. The same panels legitimately RESTORE a
# field to its stored value when repopulating a list. Those must stay silent,
# or Save starts writing fields nobody touched. So this check does not demand a
# dispatch on every assignment; it demands that a file which records edits from
# events has a single helper that assigns AND dispatches, and that raw
# assignments to setting-bound fields go through it.
#
# The pass condition is ZERO.
import io
import os
import re
import sys

ROOT = r"D:\FoundryVTT\Data\modules"
MODULES = ["ace-qol", "ace-engine", "ace-artificer", "ace-token-art", "ace-envoy"]

# A file that records edits by listening for input/change on setting controls.
RECORDS_FROM_EVENTS = re.compile(
    r"addEventListener\(\s*[\"'](?:input|change)[\"']", re.I)
SETTING_SELECTOR = re.compile(r"data-setting(?:-key)?", re.I)

# `something.value = ...` / `something.checked = ...` where something is a
# variable holding an element. Excludes `opt.value =` on a freshly created
# <option>, which is building a list, not writing a field.
ASSIGN = re.compile(
    r"(?P<var>[A-Za-z_$][\w$]*)\s*\.\s*(?P<prop>value|checked)\s*=\s*(?!=)")

# Names that are option elements being built, not fields being written.
OPTION_LIKE = re.compile(r"^(opt|option|o|el|node)$", re.I)

# An inline HTML handler doing the same thing.
INLINE = re.compile(
    r"on(?:input|change)\s*=\s*[\"'][^\"']*\.value\s*=\s*[^\"']*[\"']", re.I)


def recorded_near(lines, index, window=7):
    """Is this assignment accounted for?

    Three ways an assignment is legitimate, and all three must be recognised or
    the audit reports noise. A WRONG audit is worse than none: an earlier
    settings audit claimed 62 dead toggles because it missed one accessor shape,
    and a tool nobody trusts is a tool nobody runs.

      1. it dispatches the event itself, or goes through a helper that does
      2. it writes the pending-changes map directly on an adjacent line, which
         reaches the same place by a shorter road (ace-qol's file picker)
      3. it is deliberately silent and says so, with an ALLOW-SILENT comment
         naming the reason (repopulating a list, resetting a placeholder)
    """
    lo = max(0, index - window)
    hi = min(len(lines), index + window + 1)
    chunk = "\n".join(lines[lo:hi])
    if "dispatchEvent" in chunk or "_setFieldValue" in chunk:
        return True
    if "_pendingChanges" in chunk or "_onSettingChange" in chunk:
        return True
    if "ALLOW-SILENT" in chunk:
        return True
    return False


def source_files(module):
    base = os.path.join(ROOT, module)
    for dirpath, _dirs, files in os.walk(base):
        if "node_modules" in dirpath or ".git" in dirpath:
            continue
        for f in files:
            if f.endswith((".mjs", ".js", ".html")):
                yield os.path.join(dirpath, f)


def main():
    print("CONTROLS WRITTEN IN CODE THAT RECORD NOTHING")
    print("=" * 78)
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

            rel = os.path.relpath(path, ROOT)
            lines = src.split("\n")

            # Inline HTML handlers are always suspect: there is no helper to
            # route through and no recorder can see the assignment.
            for n, line in enumerate(lines, 1):
                if INLINE.search(line) and "dispatchEvent" not in line:
                    hits.append((rel, n, "inline handler assigns .value and dispatches nothing",
                                 line.strip()[:88]))

            if path.endswith(".html"):
                continue

            # Only .mjs/.js files that actually record edits from events can
            # suffer this defect; a file that saves by reading the DOM at save
            # time is immune and must not be flagged.
            if not (RECORDS_FROM_EVENTS.search(src) and SETTING_SELECTOR.search(src)):
                continue

            for i, line in enumerate(lines):
                stripped = line.strip()
                if stripped.startswith(("//", "*", "/*")):
                    continue
                m = ASSIGN.search(line)
                if not m:
                    continue
                if OPTION_LIKE.match(m.group("var")):
                    continue
                # The helper itself is allowed to assign; that is its job.
                if "_setFieldValue" in line:
                    continue
                if recorded_near(lines, i):
                    continue
                hits.append((rel, i + 1,
                             f"{m.group('var')}.{m.group('prop')} assigned with no event",
                             stripped[:88]))

        if not hits:
            print(f"\n  {module}: clean")
            continue
        print(f"\n  {module}: {len(hits)} control write(s) that record nothing")
        for rel, n, why, snippet in hits:
            print(f"\n     {rel}:{n}")
            print(f"        {why}")
            print(f"        {snippet}")
        total += len(hits)

    print("\n" + "=" * 78)
    if total:
        print(f"{total} place(s) where a control is filled in code and no recorder can see it.")
        print("Assigning .value or .checked fires NO event. If the panel saves a diff of")
        print("recorded edits, route the write through a helper that dispatches 'input'.")
        sys.exit(1)
    print("Every control written in code either dispatches, or its panel reads the DOM at save.")
    sys.exit(0)


if __name__ == "__main__":
    main()
