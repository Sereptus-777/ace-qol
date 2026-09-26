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

# ⚠️🔴 EVERY MODULE THAT POSTS A CHAT CARD (2026-09-25). This read ace-qol.css
# and nothing else, so the rule it exists to enforce was never checked in ACE
# Forge — the module where it kept breaking. His words that day, on a trap card
# whose "18 +6 = 24" came out as 1 over 8 and 2 over 4: "I can't believe how
# many times I've had to tell you to change that exact same thing in the last
# year of working on this shit."
#
# He is right, and a check that only looks at one of the three stylesheets is
# how the same bug came back. Fixing the instance was never going to hold.
STYLESHEETS = [
    ROOT / "styles" / "ace-qol.css",
    ROOT.parent / "ace-artificer" / "styles" / "ace-artificer.css",
    ROOT.parent / "ace-engine"    / "styles" / "ace-engine.css",
]

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
    r"\.ace-qol-(atk|dmg|save|merge|heal-card|loot|tile-loot|rider|tx|volley|crit|fall|prism)-"
    # Forge's chat cards: the trap card, the disarm card, the spot card, the
    # party warning, the pit, and the save and damage rows inside them.
    r"|\.forge-(trap|target|save|dmg|disarm|spot|warn|npc|apply|hp|pit|consequence)-"
    # The narrator's own cards.
    r"|\.ace-engine-(card|line|row|result)",
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


def scan(css_path):
    """Returns (checked, exempt, offenders) for one stylesheet."""
    text = css_path.read_text(encoding="utf-8", errors="replace")
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

    return checked, exempt, offenders


# ⚠️🔴 HIS RULE, 2026-09-25: "All text has to fit inside the fucking pill
# button, okay? Forever, for every fucking pill button." A button with a fixed
# height, or one that hides what overflows, cannot keep that promise: the label
# is simply cut off, which is what happened to "DISARM ALL (2)".
BUTTONISH = re.compile(r"(btn|button|pill)", re.I)
FIXED_HEIGHT = re.compile(r"(?<!min-)(?<!max-)(?<!line-)\bheight\s*:\s*(?!auto)(?!100%)(?!inherit)[^;]+;", re.I)
CLIPS = re.compile(
    r"overflow\s*:\s*hidden|text-overflow\s*:\s*ellipsis|white-space\s*:\s*nowrap",
    re.I,
)


def scan_pills(css_path):
    """Button rules that cannot grow around their own label."""
    text = css_path.read_text(encoding="utf-8", errors="replace")
    out = []
    for line, sel, body, before in rules(text):
        if not BUTTONISH.search(sel):
            continue
        if OPT_OUT.search(body) or OPT_OUT.search(before):
            continue
        # ⚠️ NARROW ON PURPOSE. A fixed height on an icon-only button is
        # correct, and flagging every one of them names two dozen rules nobody
        # will read — the same mistake cycle-check made on its first run. What
        # actually CUTS a label is a fixed height TOGETHER WITH something that
        # stops the text wrapping or hides the overflow.
        # A rule that hides its target is not a pill with a label in it.
        if re.search(r"display\s*:\s*none", body, re.I):
            continue
        if not (FIXED_HEIGHT.search(body) and CLIPS.search(body)):
            continue
        out.append((line, sel.replace("\n", " ").strip(),
                    "a fixed height and it hides what will not fit"))
    return out


def main():
    print("=" * 74)
    print("CARD ROWS THAT CANNOT WRAP")
    print("=" * 74)

    all_offenders = []
    for css in STYLESHEETS:
        if not css.exists():
            print(f"  (not installed, skipped: {css.name})")
            continue
        checked, exempt, offenders = scan(css)
        print(f"Checked {checked} flex row rule(s) in {css.name}. "
              f"{exempt} say why they must not wrap.")
        all_offenders += [(css.name, line, sel) for line, sel in offenders]
    print()

    pills = []
    for css in STYLESHEETS:
        if css.exists():
            pills += [(css.name, *p) for p in scan_pills(css)]

    if pills:
        print("PILLS THAT CANNOT FIT THEIR OWN LABEL")
        for name, line, sel, why in pills:
            print(f"  {name}:{line}  {sel}  ({why})")
        print()
        print("Every pill grows around its text. Drop the fixed height, or say")
        print("`no-wrap-ok: <reason>` in the rule.")
        print()

    if not all_offenders and not pills:
        print("Every card row can wrap, and every pill fits its own label. Height is free.")
        return 0

    if not all_offenders:
        return 1

    for name, line, sel in all_offenders:
        print(f"  {name}:{line}  {sel}")
    print()
    offenders = all_offenders
    print(f"{len(offenders)} row(s) will clip their contents instead of wrapping.")
    print("Add `flex-wrap: wrap;` with a row-gap, or say `no-wrap-ok: <reason>`")
    print("in the rule if it genuinely must stay on one line.")
    return 1


if __name__ == "__main__":
    sys.exit(main())
