// ─── ACE: QOL — Multi-Type Damage Chooser ────────────────────────────────────
// Weapons (and some items) whose description says "X or Y damage, your choice"
// — Blood Halberd ("fire or cold"), Holy Avenger (radiant or...), Dragon's
// Wrath weapons, etc. The dnd5e system has no built-in chooser for this; left
// alone it would roll ALL listed damage types every hit, which is wrong.
//
// Design (mirrors the Warlock chooser pattern):
//
//   - STICKY per-item preference. The player sets their preferred damage
//     type once and every subsequent attack with that weapon uses it.
//     They can change it between encounters via the chooser dialog. Per-
//     attack popups would be annoying.
//
//   - Storage: item-level flag `flags.ace-qol.chosenDamageType` =
//       "fire" | "cold" | "necrotic" | <etc>  — one of the options the
//       item's description offers, or "default" for the weapon's natural
//       (first-listed) type.
//
//   - Detection: regex scan of the item description for patterns like
//     "<type> or <type>" / "<type>, <type>, or <type>" / "<type> or its
//     normal damage type" etc.
//
//   - Application: damage-calculator.mjs reads the flag before rolling
//     and filters the damage parts to match the chosen type.
//
//   - API: game.aceQol.openMultiTypeChooser(actor) — opens the dialog
//     listing every multi-type item the actor carries with current
//     preference shown.
//
// Why not auto-detect from the system's damage parts directly? Because
// dnd5e treats "fire or cold" as two separate damage parts (BOTH rolled,
// summed). We need the description to know it's an OR, not an AND.
// ──────────────────────────────────────────────────────────────────────────────

import { MODULE_ID } from "./ace-qol.mjs";

const FLAG_KEY = "chosenDamageType";

// Lowercase damage type vocabulary used to detect "X or Y" patterns.
const DAMAGE_TYPES = [
  "acid", "bludgeoning", "cold", "fire", "force", "lightning", "necrotic",
  "piercing", "poison", "psychic", "radiant", "slashing", "thunder",
];

const TYPES_REGEX_ALT = DAMAGE_TYPES.join("|");

// ═══════════════════════════════════════════════════════════════════════════
//  Detection
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Scan an item's description for "X or Y damage" patterns.
 * Returns an array of damage types the player can choose between, or null
 * if no choice is offered. Always includes "default" as the first option —
 * letting the player revert to the weapon's natural type.
 *
 * @param {Item} item
 * @returns {string[] | null}  e.g., ["default", "fire", "cold"]
 */
export function detectMultiTypeOptions(item) {
  const desc = item?.system?.description?.value ?? "";
  if (!desc) return null;
  const text = String(desc).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").toLowerCase();

  // Pattern A: "X or Y damage" / "X, Y, or Z damage" — list of types
  // separated by commas/or, followed by the word "damage".
  // Example: "fire or cold damage", "necrotic, psychic, or radiant damage"
  const listRx = new RegExp(
    `\\b(${TYPES_REGEX_ALT})(?:\\s*,\\s*(${TYPES_REGEX_ALT}))?(?:\\s*,?\\s+or\\s+(${TYPES_REGEX_ALT}))\\s+damage\\b`,
    "gi"
  );

  // Pattern B: "X damage instead of Y" / "Y damage rather than X" —
  // alternative phrasing where the choice swaps one type for another.
  const swapRx = new RegExp(
    `\\b(${TYPES_REGEX_ALT})\\s+damage\\s+(?:instead\\s+of|rather\\s+than)\\s+(?:its\\s+normal\\s+damage(?:\\s+type)?|(${TYPES_REGEX_ALT})\\s+damage)`,
    "gi"
  );

  const found = new Set();

  let m;
  while ((m = listRx.exec(text)) !== null) {
    for (let i = 1; i < m.length; i++) {
      if (m[i]) found.add(m[i].toLowerCase());
    }
  }
  while ((m = swapRx.exec(text)) !== null) {
    for (let i = 1; i < m.length; i++) {
      if (m[i] && DAMAGE_TYPES.includes(m[i].toLowerCase())) {
        found.add(m[i].toLowerCase());
      }
    }
  }

  if (found.size < 2) return null;
  return ["default", ...found];
}

// ═══════════════════════════════════════════════════════════════════════════
//  Flag read / write
// ═══════════════════════════════════════════════════════════════════════════

/** Read the chosen damage type for an item. Returns null if not set. */
export function getChosenDamageType(item) {
  try {
    const v = item?.getFlag?.(MODULE_ID, FLAG_KEY);
    return (typeof v === "string" && v.length) ? v : null;
  } catch (_) { return null; }
}

/** Set the chosen damage type for an item. Pass null/"default" to clear. */
export async function setChosenDamageType(item, type) {
  if (!item) return false;
  try {
    if (!type || type === "default") {
      await item.unsetFlag(MODULE_ID, FLAG_KEY);
    } else {
      await item.setFlag(MODULE_ID, FLAG_KEY, type);
    }
    return true;
  } catch (err) {
    console.warn(`${MODULE_ID} | setChosenDamageType failed:`, err);
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  Chooser Dialog
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Find every multi-type item on the actor and return a structured list
 * for the chooser dialog. Each entry: { item, options, current }.
 */
function _scanActorForMultiTypeItems(actor) {
  if (!actor?.items) return [];
  const results = [];
  for (const item of actor.items) {
    // Only weapons and equipment make sense here. Skip spells, feats,
    // consumables — those have their own damage-type semantics.
    if (item.type !== "weapon" && item.type !== "equipment") continue;
    const options = detectMultiTypeOptions(item);
    if (!options) continue;
    results.push({
      item,
      options,
      current: getChosenDamageType(item) ?? "default",
    });
  }
  return results;
}

/**
 * Open the multi-type damage chooser dialog for the given actor.
 * Lists every weapon/item that offers a damage-type choice and lets the
 * player pick their preferred type per item.
 */
export async function openMultiTypeChooser(actor) {
  if (!actor) {
    ui.notifications?.warn("ACE QOL: No actor — assign a PC or pass an actor explicitly.");
    return;
  }
  const entries = _scanActorForMultiTypeItems(actor);
  if (!entries.length) {
    ui.notifications?.info(`ACE QOL: ${actor.name} has no items with multi-type damage choices.`);
    return;
  }

  // Build the dialog HTML — one row per item, each with a select dropdown.
  const rows = entries.map(({ item, options, current }) => {
    const opts = options.map(o => {
      const label = o === "default" ? "Default (weapon's normal type)"
                                    : (o.charAt(0).toUpperCase() + o.slice(1));
      const sel = o === current ? "selected" : "";
      return `<option value="${o}" ${sel}>${label}</option>`;
    }).join("");
    return `
      <div class="ace-qol-multi-row" style="display:flex; align-items:center; gap:10px; padding:8px 0; border-bottom:1px solid #333;">
        <img src="${item.img}" alt="" style="width:32px; height:32px; border-radius:3px; flex-shrink:0;">
        <div style="flex:1;">
          <div style="color:#ffe9a0; font-weight:700; font-size:13px;">${foundry.utils.escapeHTML(item.name)}</div>
          <div style="color:#aaa; font-size:11px;">Damage type choice</div>
        </div>
        <select data-item-id="${item.id}" style="background:#1a1a1a; color:#fff; border:1px solid #555; padding:4px 6px; border-radius:3px; min-width:180px;">
          ${opts}
        </select>
      </div>
    `;
  }).join("");

  const content = `
    <div class="ace-qol-multi-chooser" style="font-family:'Signika',sans-serif; color:#e8d8a8;">
      <p style="color:#ccc; font-size:12px; margin-bottom:10px;">
        Set the damage type each weapon should deal on hit. Choice is sticky —
        every attack with the weapon uses the chosen type until you change it
        here.
      </p>
      ${rows}
    </div>
  `;

  const Dialog = foundry.applications?.api?.DialogV2 ?? globalThis.Dialog;
  const useV2  = !!foundry.applications?.api?.DialogV2;

  if (useV2) {
    await foundry.applications.api.DialogV2.wait({
      window: { title: `${actor.name} — Damage Type Choices` },
      content,
      buttons: [
        {
          action: "save",
          label: "Save Changes",
          icon: "fa-solid fa-floppy-disk",
          default: true,
          callback: async (event, button, dialog) => {
            const root = dialog.element;
            const selects = root.querySelectorAll("select[data-item-id]");
            for (const sel of selects) {
              const itemId = sel.dataset.itemId;
              const value  = sel.value;
              const item = actor.items.get(itemId);
              if (!item) continue;
              await setChosenDamageType(item, value);
            }
            ui.notifications?.info(`ACE QOL: Damage type preferences saved for ${actor.name}.`);
            return "save";
          },
        },
        { action: "cancel", label: "Cancel", icon: "fa-solid fa-xmark", callback: () => "cancel" },
      ],
    });
  } else {
    // Legacy Dialog fallback
    new Dialog({
      title: `${actor.name} — Damage Type Choices`,
      content,
      buttons: {
        save: {
          icon: '<i class="fa-solid fa-floppy-disk"></i>',
          label: "Save Changes",
          callback: async (html) => {
            const root = html[0] ?? html;
            const selects = root.querySelectorAll("select[data-item-id]");
            for (const sel of selects) {
              const itemId = sel.dataset.itemId;
              const value  = sel.value;
              const item = actor.items.get(itemId);
              if (!item) continue;
              await setChosenDamageType(item, value);
            }
            ui.notifications?.info(`ACE QOL: Damage type preferences saved for ${actor.name}.`);
          },
        },
        cancel: { icon: '<i class="fa-solid fa-xmark"></i>', label: "Cancel" },
      },
      default: "save",
    }).render(true);
  }
}
