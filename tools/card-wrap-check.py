#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
A CARD ROW THAT CANNOT WRAP DESTROYS SOMETHING TO FIT.

Johnny's rule, stated more than once and written into CLAUDE.md: chat cards
never squeeze a row, height is free. On 2026-09-05 the save card broke it in the
worst way - every target's HP box ran off the right edge and was CUT IN HALF
("HP: 32-", "HP: 201"). Not squeezed, clipped, so the number he needed was not on
screen at all.

The cause was one missing line. A flex row with no `flex-wrap` defaults to
nowrap, and that row carried five buttons, a damage number and an HP chip that is
deliberately unbreakable. Something had to give and it was the right-hand edge.

WHY THIS IS A TOOL AND NOT A SWEEP. Twenty-odd rules in the stylesheet were in
the same state. Fixing them by eye once fixes them once; the twenty-first gets
written next week and nobody notices until a screenshot arrives. This runs with
the other handover checks so a row that cannot wrap cannot ship.

A ROW THAT GENUINELY MUST NOT WRAP SAYS SO. Put `no-wrap-ok: <reason>` in a
comment on the line above the rule, or inside it. Same shape as the `SILENT-OK:`
marker the early-return audit uses: the exception becomes deliberate and
explained rather than absent and accidental.

Run:  python tools/card-wrap-check.py
"""

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CSS = ROOT / "styles" / "ace-qol.css"

# CHAT CARDS ONLY, and this narrowing is the whole point of the tool.
#
# A first pass matched anything row-shaped anywhere in the stylesheet and named
# 58 rules: config tabs, dialog footers, panel headers, the action bar. A check
# that names 58 things is a check nobody reads, which is exactly how the "areas
# that are never drawn" card ended up ignored. Over-reporting is not the safe
# direction to err in.
#
# What actually has this problem is a CHAT CARD. The chat panel is narrow and
# fixed, so a row that cannot wrap has nowhere to go and clips its own contents.
# Dialogs, the config window and the effects panel are resizable or sized to
# what is inside them.
CARD_FAMILIES = re.compile(
    r"\.ace-qol-(atk|dmg|save|merge|heal-card|loot|tile-loot|rider|tx|volley|crit|fall)-",
    re.I,
)
# Selectors whose rules lay out a ROW of card content.
ROWISH = re.compile(r"(row|line|header|footer|actions|targets?|entry|item)\b", re.I)
# A single control lays out its own insides. It is not a row of card content,
# and forcing it to wrap would break the thing it was glued together to prevent.
CONTROL = re.compile(r"-(btn|button|chip|toggle|icon|tab|pill|medallion|unit|badge)\b", re.I)
# Deliberately excluded: these lay out along a column, so wrapping means nothing.
COLUMNISH = re.compile(r"flex-direction:\s*column")

OPT_OUT = re.compile(r"no-wrap-ok\s*:", re.I)


def rules(text):
    """Yield (line_no, selector, body, preceding_comment) for every CSS rule."""
    for m in re.finditer(r"([^{}]+)\{([^{}]*)\}", text):
        sel = m.group(1).strip()
        body = m.group(2)
        line = text.count("\n", 0, m.start()) + 1
        # The comment block immediately above, if any, so `no-wrap-ok` can live there.
        head = text[max(0, m.start() - 600):m.start()]
        before = head[head.rfind("}") + 1:] if "}" in head else head
        yield line, sel, body, before


def main():
    if not CSS.exists():
        print(f"Stylesheet not found: {CSS}")
        return 1

    text = CSS.read_text(encoding="utf-8", errors="replace")
    offenders = []
    exempt = 0
    checked = 0

    for line, sel, body, before in rules(text):
        if "display:" not in body.replace(" ", "") and "display :" not in body:
            continue
        if not re.search(r"display:\s*(inline-)?flex", body):
            continue
        if COLUMNISH.search(body):
            continue
        if not CARD_FAMILIES.search(sel):
            continue
        if not ROWISH.search(sel):
            continue
        if CONTROL.search(sel):
            continue
        checked += 1
        if OPT_OUT.search(body) or OPT_OUT.search(before):
            exempt += 1
            continue
        if re.search(r"flex-wrap\s*:", body):
            continue
        offenders.append((line, sel.replace("\n", " ").strip()))

    print("=" * 74)
    print("CARD ROWS THAT CANNOT WRAP")
    print("=" * 74)
    print(f"Checked {checked} flex row rule(s) in {CSS.name}. "
          f"{exempt} say why they must not wrap.")
    print()

    if not offenders:
        print("Every card row can wrap. Height is free.")
        return 0

    for line, sel in offenders:
        print(f"  {CSS.name}:{line}  {sel}")
    print()
    print(f"{len(offenders)} row(s) will clip their contents instead of wrapping.")
    print("Add `flex-wrap: wrap;` with a row-gap, or say `no-wrap-ok: <reason>`")
    print("in the rule if it genuinely must stay on one line.")
    return 1


if __name__ == "__main__":
    sys.exit(main())
