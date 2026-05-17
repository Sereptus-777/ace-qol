// ============================================================
// ACE QOL — AA Tools Initialization
//
// Wires the Quick-Edit dialog into:
//   (a) Right-click on a spell row in the actor sheet's spell list
//   (b) A "Tweak" button on the chat card after the spell is cast
//
// Both paths just call AAQuickEdit.open(item, previewToken).
// ============================================================

import { AAStore }     from "./aa-store.mjs";
import { AAQuickEdit } from "./aa-quick-edit.mjs";

const MODULE_ID = "ace-qol";
const TAG       = `${MODULE_ID} | AA Tools`;
const ROW_WIRED = "aceAaWired";          // data-* attr to dedupe
const CARD_WIRED = "aceAaCardWired";

export function initAATools() {
  if (!AAStore.isInstalled()) {
    console.log(`${TAG} | AutoAnimations not installed — AA tools skipped.`);
    return;
  }
  console.log(`${TAG} | initializing — registering actor-sheet + chat-card hooks.`);

  // ── (a) Add "Tweak Animation" entry to dnd5e's context menu ──
  // Right-click "Tweak Animation" opens AA's native AutoRec menu
  // (registered as a Foundry settings menu under
  // `autoanimations.custom-autorec`). No data-structure mirroring on
  // our side, no custom dialog to maintain — user gets AA's full
  // editor and everything inside it works as AA's developers intended.
  Hooks.on("dnd5e.getItemContextOptions", (item, options) => {
    if (!item || !Array.isArray(options)) return;
    if (item.type !== "spell") return;
    if (options.some(o => o?.name === "Tweak Animation")) return;

    options.push({
      name:  "Tweak Animation",
      icon:  '<i class="fas fa-wand-sparkles" style="color:#d4af37;"></i>',
      callback: () => {
        try {
          const menuConfig = game.settings.menus.get("autoanimations.custom-autorec");
          if (!menuConfig?.type) {
            ui.notifications.error("AutoAnimations AutoRec menu not registered");
            return;
          }
          new menuConfig.type().render(true);
          // After AA's AutorecMenuApp renders, jump to the spell's category
          // tab AND try to scroll/highlight the matching record.
          setTimeout(() => _navigateAATo(item), 400);
        } catch (err) {
          console.error(`${TAG} | failed to open AA AutoRec menu:`, err);
          ui.notifications.error("Could not open AutoAnimations AutoRec menu");
        }
      },
    });
  });

  // Render hook is kept for compatibility/future use even though the
  // contextmenu DOM listener was removed.
  const ACTOR_HOOKS = [
    "renderActorSheet",
    "renderActorSheet5e",
    "renderActorSheet5eCharacter",
    "renderActorSheet5eCharacter2",
    "renderActorSheet5eNPC",
    "renderActorSheet5eNPC2",
    "renderActorSheetV2",
  ];
  for (const h of ACTOR_HOOKS) Hooks.on(h, _onRenderActorSheet);

  // ── (b) Chat card "Tweak" button after spell cast ──
  Hooks.on("renderChatMessage",     _onRenderChatMessage);
  Hooks.on("renderChatMessageHTML", _onRenderChatMessage); // V13 alt name
}

// ──────────────────────────────────────────────────────────────
//  (a) Add "Tweak Animation" entry into dnd5e's stock context menu
// ──────────────────────────────────────────────────────────────

/**
 * Pushed into the entries array Foundry/dnd5e builds for the ContextMenu
 * on item rows. We only show the option for spells. The hook signature
 * varies slightly across sheet versions, so we handle both
 *   (sheet, entries)  — most dnd5e hooks
 *   (entries)         — some generic V2 hooks
 */
function _addContextMenuEntry(...args) {
  // Resolve sheet + entries regardless of hook signature
  let sheet = null, entries = null;
  if (args.length >= 2 && Array.isArray(args[1])) {
    [sheet, entries] = args;
  } else if (args.length >= 1 && Array.isArray(args[0])) {
    entries = args[0];
  } else {
    return;
  }
  if (!Array.isArray(entries)) return;
  // Some hooks fire twice in a single render — dedupe by name
  if (entries.some(e => e?.name === "Tweak Animation")) return;

  const getItemId = (el) => {
    const target = (el instanceof HTMLElement) ? el : el?.[0];
    if (!target) return null;
    return target.dataset?.itemId
      ?? target.closest?.("[data-item-id]")?.dataset?.itemId
      ?? null;
  };
  const resolveItem = (el) => {
    const itemId = getItemId(el);
    if (!itemId) return null;
    const actor = sheet?.actor ?? sheet?.object ?? sheet?.document;
    return actor?.items?.get?.(itemId) ?? null;
  };

  entries.push({
    name:  "Tweak Animation",
    icon:  '<i class="fas fa-wand-sparkles" style="color:#d4af37;"></i>',
    condition: (el) => {
      const item = resolveItem(el);
      return item?.type === "spell";
    },
    callback: (el) => {
      const item = resolveItem(el);
      if (!item) return;
      const actor = item.actor;
      const previewToken = actor?.getActiveTokens?.()?.[0] ?? null;
      AAQuickEdit.open(item, previewToken);
    },
  });
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
    const entry = AAStore.findRecord(item.name);
    if (!entry) {
      ui.notifications.info(`No AA record for "${item.name}" yet — pick a category to create one.`);
      return;
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
    //    filters down to just this spell. Auto-expanding the row would be
    //    ideal but TyphonJS Svelte owns that state and rejects any
    //    outside toggle — user clicks the chevron themselves (one click).
    setTimeout(() => {
      _setAASearch(root, item.name);
      setTimeout(() => _highlightRecordByLabel(root, item.name), 250);
    }, 250);
    ui.notifications.info(`AutoRec: filtered to "${item.name}" — click the chevron to edit.`);
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
 * After filter narrows AA's list to one row, click the <summary> on its
 * <details> wrapper so the row expands and shows the edit/preview form.
 *
 * AA uses TyphonJS Svelte + native HTML <details> for collapse/expand.
 * Each record's LABEL lives in an <input value="…"> field (Svelte
 * binding), NOT a text node — that's why we match on input values, then
 * walk up to the enclosing <details>.
 */
function _expandRecordByLabel(root, label) {
  const target = String(label ?? "").toLowerCase().trim();
  if (!target) return;

  // Find label inputs whose value matches the spell name (skip the search bar)
  const search = root.querySelector('input[type="search"], input[placeholder*="search" i]');
  const inputs = [...root.querySelectorAll('input')].filter(i =>
    i !== search && String(i.value ?? "").toLowerCase().trim() === target
  );

  for (const input of inputs) {
    // Walk up to the enclosing <details>
    let el = input.parentElement;
    while (el && el.tagName !== "DETAILS") el = el.parentElement;
    if (!el) continue;

    if (el.open) {
      console.log(`${TAG} | "${label}" already expanded`);
      return;
    }
    const summary = el.querySelector(':scope > summary');
    if (summary) {
      summary.click();
      console.log(`${TAG} | expanded "${label}" via <summary>`);
      return;
    }
    // Fallback — set the open attribute directly
    el.open = true;
    console.log(`${TAG} | expanded "${label}" via .open=true fallback`);
    return;
  }
  console.log(`${TAG} | no <details> wrapper found for "${label}"`);
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

// ──────────────────────────────────────────────────────────────
//  (a-legacy) Actor sheet render hook — currently no-op, kept for future
// ──────────────────────────────────────────────────────────────

function _onRenderActorSheet(app, html, data) {
  if (!app?.actor) return;

  // html might be a jQuery wrap (v1 sheets) or HTMLElement (V2)
  const root = (html instanceof HTMLElement) ? html
             : (html?.[0]   instanceof HTMLElement) ? html[0]
             : (html?.element instanceof HTMLElement) ? html.element
             : null;
  if (!root) return;

  // Right-click row override REMOVED — it was hijacking dnd5e's stock
  // context menu (Edit / View / Delete) by calling preventDefault, which
  // broke the user's normal workflow.
  //
  // Proper integration via dnd5e's context-menu hook system is the next
  // step (after Monday). For now, Quick-Edit is reached via the console
  // helper snippet OR the chat-card "Tweak" button after a spell cast.
  void app; void root;
}

/**
 * Show a small floating context menu at the cursor with a "Tweak Animation"
 * entry. We use capture-phase to fire before dnd5e's own context menu,
 * but we DON'T preventDefault — that way the user can dismiss us by
 * clicking elsewhere and dnd5e's menu still works on subsequent clicks.
 */
function _showQuickEditMenu(event, item, sheetApp) {
  // If shift-held, fall through to default behavior (lets advanced users
  // skip our menu and access dnd5e's stock context menu).
  if (event.shiftKey) return;

  // Position
  const x = event.clientX;
  const y = event.clientY;

  // Remove any existing instance
  document.querySelectorAll(".ace-aa-context-menu").forEach(el => el.remove());

  const menu = document.createElement("div");
  menu.className = "ace-aa-context-menu";
  menu.style.cssText = `
    position: fixed; left: ${x}px; top: ${y}px;
    background: #1a1a1f; color: #e8dfc8;
    border: 1px solid #d4af37; border-radius: 4px;
    padding: 4px 0; min-width: 200px;
    z-index: 999999; font-family: 'Signika', sans-serif;
    box-shadow: 0 4px 12px rgba(0,0,0,0.7);
  `;
  menu.innerHTML = `
    <button class="ace-aa-menu-tweak"
      style="background:none;border:none;color:#e8dfc8;padding:10px 14px;
             width:100%;text-align:left;cursor:pointer;font-size:14px;
             font-family:inherit;display:flex;align-items:center;gap:8px;">
      <i class="fas fa-wand-sparkles" style="color:#d4af37;width:16px;"></i>
      <span>Tweak Animation</span>
    </button>
    <div style="font-size:11px;color:#888;padding:0 14px 6px;font-style:italic;">
      ace-qol AA Quick-Edit
    </div>
  `;
  document.body.appendChild(menu);

  // Hover highlight
  const btn = menu.querySelector(".ace-aa-menu-tweak");
  btn.addEventListener("mouseenter", () => btn.style.background = "#3a2a10");
  btn.addEventListener("mouseleave", () => btn.style.background = "none");

  // Click to open dialog
  btn.addEventListener("click", () => {
    menu.remove();
    const previewToken = sheetApp.actor?.getActiveTokens?.()?.[0] ?? null;
    AAQuickEdit.open(item, previewToken);
  });

  // Prevent the default browser menu from showing on top of ours
  event.preventDefault();
  event.stopPropagation();

  // Click anywhere outside to close
  setTimeout(() => {
    const close = (e) => {
      if (!menu.contains(e.target)) {
        menu.remove();
        document.removeEventListener("click",       close);
        document.removeEventListener("contextmenu", close);
      }
    };
    document.addEventListener("click",       close);
    document.addEventListener("contextmenu", close);
  }, 0);
}

// ──────────────────────────────────────────────────────────────
//  (b) Chat card: append a "Tweak" button after a spell cast
// ──────────────────────────────────────────────────────────────

function _onRenderChatMessage(msg, html, data) {
  const flags = msg?.flags?.dnd5e;
  if (!flags) return;

  // dnd5e spell-cast cards carry the activity/item UUID in flags
  const itemUuid = flags.activity?.uuid ?? flags.item?.uuid ?? null;
  if (!itemUuid) return;

  let item = null;
  try { item = fromUuidSync(itemUuid); } catch (_) {}
  // Sometimes the UUID points to the Activity, not the Item — walk up.
  if (item && item.documentName === "Activity") item = item.item ?? item.parent ?? null;
  if (!item || item.type !== "spell") return;

  const root = (html instanceof HTMLElement) ? html
             : (html?.[0]   instanceof HTMLElement) ? html[0]
             : (html?.element instanceof HTMLElement) ? html.element
             : null;
  if (!root) return;

  if (root.dataset[CARD_WIRED] === "1") return;
  root.dataset[CARD_WIRED] = "1";

  // Find the chat card content; fall back to root if no .chat-card wrapper
  const cardBody = root.querySelector(".chat-card")
                ?? root.querySelector(".message-content")
                ?? root;

  const btn = document.createElement("button");
  btn.className = "ace-qol-aa-tweak-btn";
  btn.style.cssText = `
    background: #1a1a1f; color: #d4af37;
    border: 1px solid #d4af37; border-radius: 3px;
    padding: 5px 10px; margin: 6px 2px 0;
    font-size: 12px; cursor: pointer;
    font-family: 'Signika', sans-serif;
    display: inline-flex; align-items: center; gap: 4px;
  `;
  btn.innerHTML = `<i class="fas fa-wand-sparkles"></i> Tweak Animation`;
  btn.title = "Open AA Quick-Edit for this spell (global change)";
  btn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    const previewToken = canvas.tokens.placeables.find(t => t.actor?.id === item.actor?.id)
                      ?? canvas.tokens.controlled[0]
                      ?? null;
    AAQuickEdit.open(item, previewToken);
  });
  cardBody.appendChild(btn);
}
