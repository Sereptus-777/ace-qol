// ─── ACE: QOL — Warlock Damage Type Chooser ──────────────────────────────────
// 2024 PHB Warlock features that allow per-attack damage type choice:
//
//   • Pact of the Blade (3rd-level Pact Boon): "You can cause the weapon to
//     deal Necrotic, Psychic, or Radiant damage or its normal damage type."
//   • Lifedrinker (9th-level invocation, requires Pact of the Blade):
//     "extra 1d6 Necrotic, Psychic, or Radiant damage (your choice)"
//
// These need a UI so the player can choose. A per-attack popup would be
// annoying (every swing = a click), so we use a STICKY flag — the player sets
// their preferred type once and all future Pact-weapon attacks use it. They
// can change it any time via the dialog (e.g. switching from Necrotic to
// Radiant when fighting undead).
//
// Storage: `flags.ace-qol.warlock.pactBladeType` and `flags.ace-qol.warlock.lifedrinkerType`.
// Values: "weapon" (Pact only — keeps the weapon's natural type) | "necrotic" | "psychic" | "radiant"
// ──────────────────────────────────────────────────────────────────────────────

import { MODULE_ID } from "./ace-qol.mjs";

const FLAG_NS         = MODULE_ID;
const PACT_BLADE_KEY  = "warlock.pactBladeType";
const LIFEDRINKER_KEY = "warlock.lifedrinkerType";

const ALLOWED_TYPES = ["weapon", "necrotic", "psychic", "radiant"];

/**
 * Get the player's preferred Pact of the Blade damage type.
 * Returns "weapon" (use the weapon's natural type) by default.
 */
export function getPactBladeType(actor) {
  try {
    const v = actor?.getFlag?.(FLAG_NS, PACT_BLADE_KEY);
    return ALLOWED_TYPES.includes(v) ? v : "weapon";
  } catch (_) { return "weapon"; }
}

/**
 * Get the player's preferred Lifedrinker damage type.
 * Returns "necrotic" by default (RAW default per 2014 wording).
 */
export function getLifedrinkerType(actor) {
  try {
    const v = actor?.getFlag?.(FLAG_NS, LIFEDRINKER_KEY);
    if (v === "weapon") return "necrotic";  // Lifedrinker doesn't allow "weapon" type
    return ALLOWED_TYPES.includes(v) ? v : "necrotic";
  } catch (_) { return "necrotic"; }
}

/** Set a Warlock damage-type preference on an actor (programmatic API). */
export async function setWarlockDamageType(actor, kind, value) {
  if (!actor) return false;
  if (!ALLOWED_TYPES.includes(value)) return false;
  const key = kind === "pactBlade" ? PACT_BLADE_KEY
            : kind === "lifedrinker" ? LIFEDRINKER_KEY
            : null;
  if (!key) return false;
  await actor.setFlag(FLAG_NS, key, value);
  return true;
}

/**
 * Per-attack Pact of the Blade damage-type prompt (opt-in via the
 * `pactBladePromptPerAttack` setting). Opens a quick chooser and stores the pick
 * as the sticky preference, so the damage calculator's existing type-swap picks
 * it up. AWAITED inside the damage build, so the damage can't roll before the
 * choice is made — no timing race (this is the "risky live wire" done safe).
 * Fires only on the roller's own client (owner/GM); a one-at-a-time guard stops
 * overlapping dialogs across a multiattack chain.
 */
const _pactPromptOpen = new Set();
export async function promptPactTypePerAttack(actor, item) {
  try {
    if (!actor?.id) return;
    // Only the ACTUAL roller chooses. When an active player owns this actor, the
    // GM must NOT pop the chooser — the owning player picks on THEIR client
    // before the damage socket, and the pick is applied GM-side from that
    // payload. The GM only chooses for actors it runs itself (monsters / GM-cast:
    // no active player owner). Stops the chooser landing on the GM (2026-07-12).
    const _hasActivePlayerOwner = game.users?.some(u =>
      !u.isGM && u.active && actor.testUserPermission?.(u, "OWNER"));
    if (game.user?.isGM && _hasActivePlayerOwner) return;
    if (!(actor.isOwner || game.user?.isGM)) return;   // only the roller chooses
    if (_pactPromptOpen.has(actor.id)) return;          // one dialog at a time
    _pactPromptOpen.add(actor.id);

    const current = getPactBladeType(actor);
    const natural = item?.system?.damage?.base?.types?.[0]
      ?? [...(item?.system?.activities ?? [])]?.[0]?.damage?.parts?.[0]?.types?.[0]
      ?? "normal";
    const opts = [
      { val: "weapon",   label: `Normal (${natural})` },
      { val: "necrotic", label: "Necrotic" },
      { val: "psychic",  label: "Psychic" },
      { val: "radiant",  label: "Radiant" },
    ];
    const chosen = await new Promise((resolve) => {
      let settled = false;
      const done = (v) => { if (!settled) { settled = true; resolve(v); } };
      const tiles = opts.map(o => {
        const sel = o.val === current;
        return `<button type="button" class="ace-pact-btn" data-val="${o.val}" `
          + `style="background:${sel ? "linear-gradient(180deg,#3a1420,#2a0e18)" : "linear-gradient(180deg,#1a1420,#120c18)"};`
          + `border:1px solid ${sel ? "#e05a7a" : "#7a4a5a"};color:#f5dfe8;font-size:16px;font-weight:700;`
          + `padding:9px 13px;border-radius:8px;cursor:pointer;min-width:100px;">${o.label}</button>`;
      }).join("");
      const content = `<div style="background:#14121a;padding:13px 15px;border-radius:8px;">`
        + `<div style="color:#f0dfe8;font-size:15px;margin-bottom:10px;">`
        + `${item?.name ?? "Pact weapon"} — deal which damage type this hit?</div>`
        + `<div style="display:flex;gap:8px;flex-wrap:wrap;">${tiles}</div></div>`;
      const dlg = new foundry.applications.api.DialogV2({
        window: { title: "Pact of the Blade — Damage Type" },
        content,
        buttons: [{ action: "keep", label: "Keep current", callback: () => done(current) }],
        rejectClose: false,
        submit: () => done(current),
      });
      dlg.render({ force: true }).then(() => {
        const root = dlg.element ?? document;
        root.querySelectorAll?.(".ace-pact-btn")?.forEach(b =>
          b.addEventListener("click", () => { done(b.dataset.val); try { dlg.close(); } catch (_) {} }));
      }).catch(() => done(current));
    });
    if (chosen && ALLOWED_TYPES.includes(chosen) && chosen !== current) {
      await setWarlockDamageType(actor, "pactBlade", chosen);
    }
  } catch (err) {
    console.warn(`${MODULE_ID} | promptPactTypePerAttack threw (non-fatal):`, err);
  } finally {
    _pactPromptOpen.delete(actor?.id);
  }
}

/**
 * Detect whether an actor has Pact of the Blade (the pact boon).
 * Used to gate when to offer / apply the type choice.
 */
export function hasPactOfTheBlade(actor) {
  if (!actor?.items) return false;
  for (const item of actor.items) {
    const name = String(item.name ?? "").toLowerCase();
    if (name === "pact of the blade" || name.includes("pact of the blade")) return true;
  }
  return false;
}

/** Detect Lifedrinker invocation. */
export function hasLifedrinker(actor) {
  if (!actor?.items) return false;
  for (const item of actor.items) {
    const name = String(item.name ?? "").toLowerCase();
    if (name === "lifedrinker") return true;
  }
  return false;
}

/**
 * Open the Warlock damage-type chooser dialog for the given actor.
 * Shows current values and lets the player change them. Saves to actor flags.
 *
 * @param {Actor} actor - The Warlock PC (typically game.user.character)
 */
export async function openWarlockDamageDialog(actor) {
  if (!actor) {
    ui.notifications?.warn("ACE QOL: No actor — assign a PC or pass an actor explicitly.");
    return;
  }
  const hasBlade  = hasPactOfTheBlade(actor);
  const hasLife   = hasLifedrinker(actor);
  if (!hasBlade && !hasLife) {
    ui.notifications?.info(`ACE QOL: ${actor.name} has neither Pact of the Blade nor Lifedrinker — no choices to make.`);
    return;
  }

  const currentBlade = getPactBladeType(actor);
  const currentLife  = getLifedrinkerType(actor);

  // Build dropdown options. Pact of the Blade allows "weapon" (default = use
  // the weapon's normal type). Lifedrinker doesn't have a "weapon" option.
  const bladeOpts = [
    { val: "weapon",   label: "Normal (weapon's natural type)" },
    { val: "necrotic", label: "Necrotic" },
    { val: "psychic",  label: "Psychic" },
    { val: "radiant",  label: "Radiant" },
  ];
  const lifeOpts = [
    { val: "necrotic", label: "Necrotic" },
    { val: "psychic",  label: "Psychic" },
    { val: "radiant",  label: "Radiant" },
  ];

  const renderSelect = (name, current, opts) => `
    <select name="${name}"
            style="width:100%;padding:8px 10px;background:#1a1a1f;border:2px solid #6a5328;
                   border-radius:5px;color:#f0e4c0;font-size:16px;font-weight:600;
                   font-family:'Rajdhani',sans-serif;cursor:pointer;">
      ${opts.map(o => `<option value="${o.val}" ${o.val === current ? "selected" : ""}>${o.label}</option>`).join("")}
    </select>`;

  const bladeRow = hasBlade ? `
    <label style="display:flex;flex-direction:column;gap:6px;">
      <span style="color:#d4af37;font-weight:700;font-size:15px;letter-spacing:0.5px;">
        PACT OF THE BLADE — damage type
      </span>
      <span style="color:#a89060;font-size:13px;">
        Your pact weapon deals this damage type instead of its normal type.
        "Normal" = use whatever the weapon's natural damage type is (slashing/piercing/etc.).
      </span>
      ${renderSelect("pactBladeType", currentBlade, bladeOpts)}
    </label>` : "";

  const lifeRow = hasLife ? `
    <label style="display:flex;flex-direction:column;gap:6px;margin-top:14px;">
      <span style="color:#d4af37;font-weight:700;font-size:15px;letter-spacing:0.5px;">
        LIFEDRINKER — damage type
      </span>
      <span style="color:#a89060;font-size:13px;">
        Extra +1d6 damage of this type on hits with your pact weapon.
      </span>
      ${renderSelect("lifedrinkerType", currentLife, lifeOpts)}
    </label>` : "";

  const content = `
    <style>
      .ace-warlock-dialog select option {
        background: #1a1a1f !important;
        color: #f0e4c0 !important;
        padding: 8px !important;
        font-size: 15px !important;
      }
    </style>
    <div class="ace-warlock-dialog"
         style="background:linear-gradient(135deg,#1a1a1f 0%,#2a2118 100%);color:#f0e4c0;
                padding:20px;border-radius:8px;font-family:'Rajdhani',sans-serif;
                display:flex;flex-direction:column;gap:16px;min-width:480px;font-size:15px;">
      <header style="border-bottom:2px solid #d4af37;padding-bottom:12px;">
        <div style="font-family:'Cinzel Decorative',serif;font-size:22px;color:#d4af37;">
          ${actor.name} — Warlock Damage Types
        </div>
        <div style="color:#a89060;font-size:13px;margin-top:4px;">
          Set once; persists across all attacks until changed.
        </div>
      </header>
      ${bladeRow}
      ${lifeRow}
    </div>
  `;

  return new Promise(resolve => {
    new Dialog({
      title: `Warlock Damage Type — ${actor.name}`,
      content,
      buttons: {
        save: {
          icon: '<i class="fas fa-check"></i>',
          label: "Save",
          callback: async (html) => {
            const root = html[0]?.querySelector(".ace-warlock-dialog") ?? html.find(".ace-warlock-dialog")[0];
            const newBlade = root?.querySelector('select[name="pactBladeType"]')?.value;
            const newLife  = root?.querySelector('select[name="lifedrinkerType"]')?.value;
            const updates = [];
            if (hasBlade && newBlade && newBlade !== currentBlade) {
              await setWarlockDamageType(actor, "pactBlade", newBlade);
              updates.push(`Pact of the Blade → ${newBlade}`);
            }
            if (hasLife && newLife && newLife !== currentLife) {
              await setWarlockDamageType(actor, "lifedrinker", newLife);
              updates.push(`Lifedrinker → ${newLife}`);
            }
            if (updates.length > 0) {
              ui.notifications?.info(`ACE QOL — ${actor.name}: ${updates.join(", ")}`);
            }
            resolve({ ok: true, changes: updates });
          },
        },
        cancel: { icon: '<i class="fas fa-times"></i>', label: "Cancel", callback: () => resolve(null) },
      },
      default: "save",
      // Foundry V13's core form CSS overpowers inline select styling (its
      // fixed input height + light color-scheme squeezed the closed select
      // into an unreadable white bar — live-fire 2026-07-10 07:00). Re-assert
      // with priority at render, same proven pattern as the token-art picker.
      render: (html) => {
        try {
          const root = html[0] ?? html;
          for (const sel of root.querySelectorAll(".ace-warlock-dialog select")) {
            const imp = (prop, val) => sel.style.setProperty(prop, val, "important");
            imp("height", "44px");
            imp("min-height", "44px");
            imp("line-height", "26px");
            imp("padding", "8px 10px");
            imp("font-size", "16px");
            imp("font-weight", "600");
            imp("background-color", "#1a1a1f");
            imp("color", "#f0e4c0");
            imp("border", "2px solid #6a5328");
            imp("border-radius", "5px");
            imp("color-scheme", "dark");   // dropdown chrome matches the theme
          }
        } catch (_) { /* cosmetic only — never block the dialog */ }
      },
    }, { width: 520, height: "auto" }).render(true);
  });
}
