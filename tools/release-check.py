#!/usr/bin/env python3
"""
Everything that must be green before ace-qol ships, in one command.

Johnny, 2026-09-11: "When we do a sweep or something like that, all the rest of
it gets fucking lost, and we have to redo simple spells like magic missile,
fireball." This runs every house check and every self-test in tools/, the
replay over his own world last, and names every one that is not green.

WHY ONE COMMAND. Each self-test was written for the bug it pins and then only
run while that bug was fresh. A test nobody runs is the same as no test, and a
list of eleven commands in a file is a list I skip one of when I am sure.

Every *-selftest.mjs in tools/ is picked up automatically, so a new test is in
the release check from the moment it is written.

Run from the ace-qol folder:   python tools/release-check.py
Exit code 0 only when everything is green.
"""
import glob
import os
import re
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WINDOWS = os.name == "nt"

CHECKS = [
    ("every file parses", "python tools/parse-check.py"),
    ("no escape eaten by a write", "python tools/control-char-check.py"),
    ("every card row can wrap", "python tools/card-wrap-check.py"),
    ("every hook ACE listens for is fired", "python tools/hook-check.py"),
    ("no import read before it exists", "python tools/cycle-check.py"),
    ("lint (undefined names, broken code)", 'npx --yes eslint@9 "scripts/**/*.mjs"'),
]


def run(cmd, timeout):
    started = time.time()
    try:
        p = subprocess.run(cmd, cwd=HERE, shell=True, capture_output=True, text=True,
                           encoding="utf-8", errors="replace", timeout=timeout)
        out = (p.stdout or "") + (p.stderr or "")
        code = p.returncode
    except subprocess.TimeoutExpired as e:
        out = ((e.stdout or b"").decode("utf-8", "replace") if isinstance(e.stdout, bytes) else (e.stdout or ""))
        out += f"\n(stopped after {timeout} seconds)"
        code = -1
    return code, out, time.time() - started


def summary_of(out):
    m = re.findall(r"(\d+) passed, (\d+) failed(?:, (\d+) skipped)?", out)
    if m:
        passed, failed, skipped = m[-1]
        return f"{passed} passed, {failed} failed" + (f", {skipped} skipped" if skipped else "")
    lint = re.findall(r"(\d+) problems? \((\d+) errors?, (\d+) warnings?\)", out)
    if lint:
        return f"{lint[-1][1]} errors, {lint[-1][2]} warnings"
    lines = [l for l in out.strip().splitlines() if l.strip()]
    return lines[-1][:90] if lines else ""


def main():
    tests = sorted(glob.glob(os.path.join(HERE, "tools", "*-selftest.mjs")))
    # The replay reads his whole world; it goes last so everything cheaper speaks first.
    tests.sort(key=lambda t: os.path.basename(t) == "replay-selftest.mjs")
    jobs = [(name, cmd, 600) for name, cmd in CHECKS]
    jobs += [(os.path.basename(t)[:-len("-selftest.mjs")] + " self-test",
              f'node "tools/{os.path.basename(t)}"', 900) for t in tests]

    print(f"RELEASE CHECK: {len(CHECKS)} checks and {len(tests)} self-tests\n")
    failed = []
    for name, cmd, timeout in jobs:
        code, out, secs = run(cmd, timeout)
        ok = code == 0
        print(f"  {'ok  ' if ok else 'FAIL'}  {name:<44} {secs:6.1f}s  {summary_of(out)}")
        sys.stdout.flush()
        if not ok:
            failed.append((name, out))

    if failed:
        print(f"\n{len(failed)} NOT GREEN. The end of each one's output:\n")
        for name, out in failed:
            print(f"--- {name}")
            tail = [l for l in out.rstrip().splitlines() if l.strip()][-25:]
            print("\n".join("    " + l for l in tail))
            print()
        print("Nothing ships until every line above says ok.")
        return 1
    print("\nAll green.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
