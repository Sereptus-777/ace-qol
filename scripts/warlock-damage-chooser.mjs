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
    }, { width: 520, height: "auto" }).render(true);
  });
}
