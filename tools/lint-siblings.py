#!/usr/bin/env python
"""Lint the OTHER ACE modules, not just this one.

⚠️ WHY THIS EXISTS (2026-09-23). The release check's lint step reads
`scripts/**/*.mjs` from the ace-qol folder it runs in, so it has only ever
linted ace-qol. hook-check and cycle-check walk all four modules; the lint
walked one. A whole night's work in the Engine went through a green release
check having never been linted at all, and an undefined name there is a module
that dies on load.

Every sibling with its own eslint config is linted with it. A module without
one is reported as skipped, out loud, rather than passing quietly.
"""
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))     # ace-qol
MODULES_DIR = os.path.dirname(HERE)

SIBLINGS = [
    ("ACE Engine", "ace-engine", ["scripts"]),
    ("ACE Forge", "ace-artificer", ["scripts"]),
    ("ACE Token Art", "ace-token-art", ["scripts"]),
    ("ACE Envoy", "ace-envoy", ["src", "scripts"]),
]

def main():
    failed = 0
    checked = 0
    for label, folder, roots in SIBLINGS:
        path = os.path.join(MODULES_DIR, folder)
        if not os.path.isdir(path):
            print(f"  skip  {label}: not installed at {path}")
            continue
        if not os.path.isfile(os.path.join(path, "eslint.config.mjs")):
            print(f"  skip  {label}: no eslint.config.mjs, so it cannot be linted here")
            continue
        globs = [f'"{r}/**/*.mjs"' for r in roots if os.path.isdir(os.path.join(path, r))]
        if not globs:
            print(f"  skip  {label}: none of {roots} exist")
            continue

        cmd = "npx --yes eslint@9 " + " ".join(globs)
        p = subprocess.run(cmd, cwd=path, shell=True, capture_output=True,
                           text=True, encoding="utf-8", errors="replace")
        out = ((p.stdout or "") + (p.stderr or "")).strip()
        checked += 1
        if p.returncode == 0:
            note = ""
            for line in out.splitlines():
                if "problem" in line:
                    note = " (" + line.strip().lstrip("✖ ").strip() + ")"
            print(f"  ok    {label}{note}")
        else:
            failed += 1
            print(f"  FAIL  {label}")
            print(out)

    print()
    print(f"{checked - failed} passed, {failed} failed"
          + ("" if failed else "  — every module ACE ships was linted, not just ace-qol."))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
