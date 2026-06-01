// ============================================================
// ACE QOL — AA Tools Initialization
//
// Adds a "Tweak Animation" entry to dnd5e's right-click context menu on
// spells. Clicking it opens AutoAnimations' native AutoRec menu, jumps to
// the spell's category tab, and fills the search bar to filter the list
// down to the matching record. Then the GM clicks the chevron to expand
// and edit — using AA's own editor, which handles every shape of AA
// record cleanly.
//
// This file used to host a custom Quick-Edit dialog (aa-quick-edit.mjs)
// and various chat-card / actor-sheet integrations that drove it. All of
// that was removed once we settled on opening AA's native page directly
// — fewer surfaces to maintain, no data-shape mirroring on our side, no
// custom dialog to keep in sync with AA updates.
// ============================================================

import { AAStore } from "./aa-store.mjs";

const MODULE_ID = "ace-qol";
const TAG       = `${MODULE_ID} | AA Tools`;

export function initAATools() {
  if (!AAStore.isInstalled()) {
    console.log(`${TAG} | AutoAnimations not installed — AA tools skipped.`);
    return;
  }
  console.log(`${TAG} | initializing — registering "Tweak Animation" context-menu entry.`);

  // Add "Tweak Animation" to dnd5e's item context menu (right-click on
  // any spell in the inventory).
  //
  // Hook naming changed between dnd5e/Foundry versions:
  //   - V12 / dnd5e 3.x       → "dnd5e.getItemContextOptions"
  //   - V13 / dnd5e 5.x       → "getItemContextOptions" (system-agnostic)
  //   - Some V13 builds also fire a 5e-specific variant.
  // Register all three defensively; the dedupe guard inside the callback
  // (`options.some(o => o?.name === "Tweak Animation")`) ensures we don't
  // double-add when more than one hook fires for the same menu.
  // Item types that get the "Tweak Animation" right-click option. AA's
  // autorec covers all of these — spells obviously, plus features (class
  // features, racial traits, monster abilities), weapons (attack swings),
  // equipment (magic items with on-hit effects), and consumables (potions,
  // scrolls). Everything else (class, subclass, background, loot, container,
  // race) doesn't have an AA animation hook so the option is skipped.
  const _AA_TWEAK_TYPES = new Set(["spell", "feat", "weapon", "equipment", "consumable"]);

  const _addTweakOption = (item, options) => {
    if (!item || !Array.isArray(options)) return;
    if (!_AA_TWEAK_TYPES.has(item.type)) return;
    if (options.some(o => o?.name === "Tweak Animation")) return;

    options.push({
      name:  "Tweak Animation",
      icon:  '<i class="fas fa-wand-sparkles" style="color:#d4af37;"></i>',
      callback: async () => {
        try {
          // ── Close any existing AutorecMenuApp first ──
          // AA's menu is a singleton — calling render(true) on a "new"
          // instance just refocuses the existing one with its old filter
          // state. Without an explicit close, right-clicking a second item
          // shows the menu still filtered to the FIRST item we navigated
          // to. Closing first guarantees a fresh open with empty filter
          // state that we then set to the current item.
          const apps = [
            ...(foundry.applications.instances?.values?.() ?? []),
            ...Object.values(ui.windows ?? {}),
          ];
          const existing = apps.find(a => a?.constructor?.name === "AutorecMenuApp");
          if (existing) {
            try { await existing.close?.({ force: true }); } catch (_) { /* non-fatal */ }
            // Give Foundry one tick to fully tear the DOM down before we
            // request the new render — otherwise AA may reuse the dying
            // instance and we're back to the stale-filter problem.
            await new Promise(r => setTimeout(r, 50));
          }

          const menuConfig = game.settings.menus.get("autoanimations.custom-autorec");
          if (!menuConfig?.type) {
            ui.notifications.error("AutoAnimations AutoRec menu not registered");
            return;
          }
          new menuConfig.type().render(true);
          // After AA's AutorecMenuApp renders, jump to the item's category
          // tab AND try to scroll/highlight the matching record.
          setTimeout(() => _navigateAATo(item), 400);
        } catch (err) {
          console.error(`${TAG} | failed to open AA AutoRec menu:`, err);
          ui.notifications.error("Could not open AutoAnimations AutoRec menu");
        }
      },
    });
  };

  Hooks.on("dnd5e.getItemContextOptions", _addTweakOption);   // V12 / dnd5e 3.x
  Hooks.on("getItemContextOptions",        _addTweakOption);   // V13 generic
  Hooks.on("getItem5eContextOptions",      _addTweakOption);   // V13 dnd5e-specific (some builds)
}

// AA's internal category → AutorecMenuApp visible tab label
const _AA_TAB_LABELS = {
  "melee":      "Melee",
  "range":      "Range",
  "ontoken":    "On Token",
  "templatefx": "Templates",
  "aura":       "Aura",
  "preset":     "Preset",
  "aefx":       "Active Effects",
};

/**
 * After AA's AutorecMenuApp opens, click the tab matching the spell's
 * category and try to scroll/highlight the row whose label matches the
 * spell name. AA's app is Svelte-rendered with auto-generated class
 * names — we use the stable visible text labels for matching.
 */
async function _navigateAATo(item) {
  try {
    // Pass the full item so findRecord can fall back to baseItem when the
    // exact name doesn't match. Catches magical weapons ("Longsword of
    // Sharpness", "Dawnbringer") whose proper names aren't in AA's autorec
    // but whose base type ("longsword") IS.
    const entry = AAStore.findRecord(item);
    if (!entry) {
      ui.notifications.info(`No AA record for "${item.name}" yet — pick a category to create one.`);
      return;
    }
    if (entry.matchedBy && entry.matchedBy !== "name") {
      console.log(`${TAG} | "${item.name}" matched AA record via ${entry.matchedBy}: "${entry.record?.label}"`);
    }
    const tabLabel = _AA_TAB_LABELS[entry.category];
    if (!tabLabel) {
      console.warn(`${TAG} | unknown AA category "${entry.category}" — no tab label mapping`);
      return;
    }
    const apps = [
      ...(foundry.applications.instances?.values?.() ?? []),
      ...Object.values(ui.windows ?? {}),
    ];
    const aaApp = apps.find(a => a.constructor.name === "AutorecMenuApp");
    if (!aaApp) {
      console.warn(`${TAG} | AutorecMenuApp not found after open — Svelte may still be mounting`);
      return;
    }
    const root = aaApp.element instanceof HTMLElement ? aaApp.element : aaApp.element?.[0];
    if (!root) return;

    // 1. Click the matching tab
    const lis = root.querySelectorAll('li[role="presentation"]');
    let clicked = false;
    for (const li of lis) {
      if (li.textContent.trim() === tabLabel) {
        li.click();
        clicked = true;
        console.log(`${TAG} | navigated to AA "${tabLabel}" tab for ${item.name}`);
        break;
      }
    }
    if (!clicked) {
      console.warn(`${TAG} | tab "${tabLabel}" not found in AA menu`);
      return;
    }

    // 2. After tab content swaps in, fill the AA search bar so the list
    //    filters down to the matched record. Auto-expanding the row would
    //    be ideal but TyphonJS Svelte owns that state and rejects any
    //    outside toggle — user clicks the chevron themselves (one click).
    //
    //    When the match was via baseItem (e.g. "Longsword of Sharpness"
    //    matched AA's "Longsword" entry), filter by the matched record's
    //    label, NOT the original item name — the original name isn't in
    //    AA's list and filtering by it would hide every row.
    const filterLabel = (entry.matchedBy && entry.matchedBy !== "name")
      ? (entry.record?.label ?? item.name)
      : item.name;
    setTimeout(() => {
      _setAASearch(root, filterLabel);
      setTimeout(() => _highlightRecordByLabel(root, filterLabel), 250);
    }, 250);
    const matchNote = (entry.matchedBy && entry.matchedBy !== "name")
      ? ` (matched via ${entry.matchedBy}: "${entry.record?.label}")`
      : "";
    ui.notifications.info(`AutoRec: filtered to "${filterLabel}"${matchNote} — click the chevron to edit.`);
  } catch (err) {
    console.error(`${TAG} | _navigateAATo failed:`, err);
  }
}

/**
 * Fill AA's search/filter input with the spell name. Uses the native
 * HTMLInputElement value setter so Svelte's reactive `bind:value` picks
 * up the change — assigning to `input.value` directly does NOT trigger
 * Svelte's reactivity.
 */
function _setAASearch(root, query) {
  const selectors = [
    'input[type="search"]',
    'input[placeholder*="search" i]',
    'input[placeholder*="filter" i]',
    'input[placeholder*="name" i]',
    '.search-bar input',
    '.search input',
    'input.search',
  ];
  let input = null;
  for (const sel of selectors) {
    input = root.querySelector(sel);
    if (input) break;
  }
  if (!input) {
    console.warn(`${TAG} | search input not found in AA menu — list won't be filtered`);
    return;
  }
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
  setter.call(input, query);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  console.log(`${TAG} | filtered AA list to "${query}"`);
}

/**
 * Walk every text-bearing element in the category's panel, find one whose
 * trimmed text matches the spell name (case-insensitive), scroll it into
 * view, and outline it briefly. AA uses Svelte inputs for labels so we
 * check input[value] too.
 */
function _highlightRecordByLabel(root, label) {
  const target = String(label ?? "").toLowerCase().trim();
  if (!target) return;
  const candidates = root.querySelectorAll('input[type="text"], h2, h3, h4, .entry-label, [data-label], .name');
  for (const c of candidates) {
    const txt = String(c.value ?? c.textContent ?? "").toLowerCase().trim();
    if (txt === target) {
      const container = c.closest("li, .entry, .ar-row, fieldset, details, .menu-row") ?? c;
      container.scrollIntoView({ behavior: "smooth", block: "center" });
      const prevOutline   = container.style.outline;
      const prevBoxShadow = container.style.boxShadow;
      container.style.outline   = "3px solid #d4af37";
      container.style.boxShadow = "0 0 18px rgba(212,175,55,0.7)";
      setTimeout(() => {
        container.style.outline   = prevOutline;
        container.style.boxShadow = prevBoxShadow;
      }, 2500);
      return;
    }
  }
  console.log(`${TAG} | no row matched "${label}" — user can scroll manually`);
}
