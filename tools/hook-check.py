#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
A LISTENER ON A HOOK NOBODY FIRES WAITS FOREVER, IN SILENCE.

2026-09-05. Johnny got "a little plop within 5 ft" from a spell animation twice
in a row. The cause was not the animation. The code that drew it was registered
on `dnd5e.useActivity`, which dnd5e 5.3.3 does not emit - it fires
`preUseActivity` and `postUseActivity` and nothing between them. Registering a
listener on a name nothing fires is completely legal: nothing throws, nothing
warns, `no-undef` sees a string, and the feature is simply absent.

FIVE OTHER ACE FEATURES WERE ON THE SAME DEAD NAME, some of them for months.

This is the same family as the renamed-method audit of 2026-08-12, where
`rollAbilitySave` became `rollSavingThrow` and every OverTime save silently
scored zero. That one produced `platform-contract.mjs`, which checks METHODS at
boot. A hook cannot be probed at runtime the way a method can - there is no way
to ask Foundry "will anybody ever fire this?" - so it has to be checked against
the system's source, here, before it ships.

WHAT IT DOES. Collects every `Hooks.on/once("dnd5e.*")` across the suite and
confirms the system actually emits that name. dnd5e builds several hook names
dynamically, so an exact string match is not enough and the known families are
resolved before anything is reported.

Core Foundry hooks are listed but NOT judged: Foundry generates `render<Class>`,
`create<Document>` and friends from class names at runtime, so a source scan
would report dozens of false positives, and a check nobody trusts is a check
nobody reads.

Run:  python tools/hook-check.py
"""

import re
import sys
from pathlib import Path

MODULES = Path(__file__).resolve().parent.parent.parent      # .../Data/modules
SYSTEM = MODULES.parent / "systems" / "dnd5e" / "dnd5e.mjs"
ACE = ["ace-qol", "ace-artificer", "ace-engine", "ace-token-art"]

LISTEN = re.compile(r'Hooks\.(?:on|once)\(\s*[\'"`]([^\'"`]+)[\'"`]')
# dnd5e emits some names by assembling them. These are the shapes it uses.
DYNAMIC = [
    # `dnd5e.preRoll${name.capitalize()}` and its V2 twin
    (re.compile(r'^dnd5e\.preRoll(.+?)(V2)?$'), "hookNames"),
    # `dnd5e.post${name.capitalize()}RollConfiguration`
    (re.compile(r'^dnd5e\.post(.+?)RollConfiguration$'), "hookNames"),
    # `dnd5e.roll${name}` / `dnd5e.roll${name}V2`
    (re.compile(r'^dnd5e\.roll(.+?)(V2)?$'), "hookNames"),
    # `dnd5e.postBuild${name.capitalize()}RollConfig` - assembled in buildConfigure.
    # ⚠️ THIS PATTERN WAS MISSING AND THE TOOL REPORTED TWO LIVE LISTENERS AS
    # DEAD ON ITS FIRST RUN. A wrong audit is worse than none: it argues for
    # deleting working code. Verified against the system source before trusting.
    (re.compile(r'^dnd5e\.postBuild(.+?)RollConfig$'), "hookNames"),
    # `dnd5e.${type}Rest`, `dnd5e.${heal|damage}Actor`
    (re.compile(r'^dnd5e\.(short|long)Rest$'), "Rest"),
    (re.compile(r'^dnd5e\.(heal|damage)Actor$'), "Actor"),
]


MARK = re.compile(r"dead-hook-ok:\s*(.+?)\s*$")


def system_source():
    if not SYSTEM.exists():
        print(f"dnd5e source not found at {SYSTEM} - cannot check anything.")
        sys.exit(2)
    return SYSTEM.read_text(encoding="utf-8", errors="replace")


def emitted(name, src):
    """Does dnd5e actually fire this hook name?"""
    # 1. The plain case: the literal name is in a Hooks.call.
    if re.search(r'Hooks\.(?:call|callAll)\(\s*[\'"`]' + re.escape(name), src):
        return True
    # 2. Documented on the emitting function (`@function dnd5e.preRollSkill`).
    if f"@function {name}" in src:
        return True
    # 3. Assembled at runtime. Resolve the stem and look for it where the
    #    system lists the parts it assembles from.
    for pattern, marker in DYNAMIC:
        m = pattern.match(name)
        if not m:
            continue
        stem = m.group(1)
        lower = stem[0].lower() + stem[1:]
        if re.search(r'[\'"]' + re.escape(lower) + r'[\'"]', src):
            return True
        if re.search(r'[\'"]' + re.escape(stem) + r'[\'"]', src):
            return True
    return False


def _excuse(path, line_no):
    """The stated reason a dead listener is deliberate, or None."""
    try:
        lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    except Exception:
        return None
    for idx in (line_no - 1, line_no - 2):     # same line, or the one above
        if 0 <= idx < len(lines):
            m = MARK.search(lines[idx])
            if m and m.group(1).strip():
                return m.group(1).strip()
    return None


def main():
    src = system_source()
    found = {}          # name -> [(file, line)]
    for mod in ACE:
        root = MODULES / mod
        if not root.exists():
            continue
        for path in root.rglob("*.mjs"):
            if "node_modules" in str(path):
                continue
            try:
                text = path.read_text(encoding="utf-8", errors="replace")
            except Exception:
                continue
            for m in LISTEN.finditer(text):
                name = m.group(1)
                line = text.count("\n", 0, m.start()) + 1
                found.setdefault(name, []).append(
                    (str(path.relative_to(MODULES)), line))

    dnd = {n: v for n, v in found.items() if n.startswith("dnd5e.")}
    other = {n: v for n, v in found.items() if not n.startswith("dnd5e.")}

    dead = {n: v for n, v in dnd.items() if not emitted(n, src)}

    # -- Deliberately dead listeners -------------------------------------
    #
    # A gate that is permanently red is a gate nobody reads, and this one has
    # been red for a day over four listeners that are dead ON PURPOSE: legacy
    # fallbacks, and paths that would double-prompt if they ever woke up.
    # With no way to say so, the next genuinely dead hook would arrive into a
    # report that already says "1 hook name nothing fires" and be invisible.
    #
    # So a listener can declare itself, exactly like card-wrap-check's
    # `no-wrap-ok`, by carrying a reason on the same line or the line above:
    #
    #     Hooks.on("dnd5e.useActivity", fn);   // dead-hook-ok: legacy fallback
    #
    # The reason is required. "dead-hook-ok" with nothing after it does not
    # count, because a bare marker is how a real one gets waved through.
    live_dead = {}
    excused = []
    for name, sites in dead.items():
        kept = []
        for f, ln in sites:
            reason = _excuse(MODULES / f, ln)
            if reason:
                excused.append((name, f, ln, reason))
            else:
                kept.append((f, ln))
        if kept:
            live_dead[name] = kept
    dead = live_dead

    print("=" * 74)
    print("HOOKS ACE LISTENS FOR THAT dnd5e NEVER FIRES")
    print("=" * 74)
    print(f"Checked {len(dnd)} dnd5e hook name(s) across {len(ACE)} modules.")
    print(f"{len(other)} core/Foundry hook name(s) listed but not judged - Foundry")
    print("builds those from class names at runtime.")
    print()

    if excused:
        print(f"{len(excused)} listener(s) are dead ON PURPOSE and say why:")
        for name, f, ln, reason in sorted(excused):
            print(f"  {name}  {f}:{ln}")
            print(f"      {reason}")
        print()

    if not dead:
        print("Every dnd5e hook ACE listens for is one dnd5e actually emits,")
        print("or is declared dead on purpose with a reason.")
        return 0

    for name in sorted(dead):
        print(f"  {name}")
        for f, ln in dead[name]:
            print(f"      {f}:{ln}")
    print()
    print(f"{len(dead)} hook name(s) nothing fires. Every listener above is dead:")
    print("it registered without complaint and will never run.")
    return 1


if __name__ == "__main__":
    sys.exit(main())
