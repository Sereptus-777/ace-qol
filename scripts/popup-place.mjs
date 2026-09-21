// ─── ACE: QOL — Where a pop-up opens, so none of them hide each other ───────
//
// Johnny, 2026-09-20: "Gaze 'Avert your eyes' and the Presence picker stacked
// on the same spot. Aryel also got a repeat-fear box on her own turn with no
// new Presence. Those are three different boxes... They must not sit on top of
// each other."
//
// Every ACE pop-up wants the middle of the screen, because every one of them is
// the thing to answer right now. When two arrive together the second lands
// exactly on the first: one gets answered, the other is never seen, and it
// reads as a box that ate the other's roll.
//
// ⚠️ ONE COUNTER, NOT THREE. The roll box, the reaction box and a picker are
// built by three different files; if each counted only its own kind they would
// still land on each other. This counts every ACE pop-up that is open.
// ──────────────────────────────────────────────────────────────────────────────

/** The classes ACE puts on its own windows. */
const ACE_POPUPS = ["ace-qol-roll-popout", "ace-qol-reaction-dialog", "ace-qol-dark-dialog", "ace-qol-picker"];

/** How many ACE pop-ups are on screen right now. */
export function openPopupCount() {
  try {
    let n = 0;
    const apps = globalThis.foundry?.applications?.instances;
    if (apps?.values) {
      for (const app of apps.values()) {
        const cls = app?.options?.classes ?? [];
        if (app?.rendered && ACE_POPUPS.some(c => cls.includes(c))) n++;
      }
    }
    // Foundry V1 Application windows (the reaction box is one) live elsewhere.
    for (const app of Object.values(globalThis.ui?.windows ?? {})) {
      const cls = app?.options?.classes ?? [];
      if (ACE_POPUPS.some(c => cls.includes(c))) n++;
    }
    return n;
  } catch (_) { return 0; }
}

/**
 * A position for the next pop-up: the given place when nothing else is open,
 * and a step down and across for each one that is.
 *
 * @param {{left?: number, top?: number}} [base]
 * @returns {{left: number, top: number}}
 */
export function stepAside(base = {}) {
  const n = openPopupCount();
  const left = Number.isFinite(base.left) ? base.left : Math.max(20, Math.floor((globalThis.innerWidth ?? 1200) / 2 - 240));
  const top = Number.isFinite(base.top) ? base.top : Math.max(40, Math.floor((globalThis.innerHeight ?? 900) / 2 - 260));
  if (!n) return { left, top };
  // Down and across, and never off the bottom of a small screen.
  const step = Math.min(n, 6);
  return { left: left + step * 44, top: Math.min(top + step * 40, Math.max(40, (globalThis.innerHeight ?? 900) - 260)) };
}
