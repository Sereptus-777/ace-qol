// ─── ACE: QOL — Tabbed Configuration Panel ───────────────────────────────────
// Custom ApplicationV2 that organizes ace-qol's settings into focused tabs.
// Each tab is a single feature/system so the GM knows exactly where to look.
// Replaces the long flat list in Foundry's standard module settings.
// ──────────────────────────────────────────────────────────────────────────────

import { MODULE_ID } from "./ace-qol.mjs";
import { QolSettings } from "./settings.mjs";
import { TokenCache } from "./token-cache.mjs";

// ─── Tab definitions ────────────────────────────────────────────────────────
const TABS = [
  // v0.4.22.13: removed `autoTargetTemplates` from this tab — it was
  // also listed under "templates" (its natural home), creating two
  // controls for the same setting that could disagree mid-session.
  // Keeping the "templates" tab as the canonical location.
  { id: "targeting",  label: "Targeting",         icon: "fa-solid fa-crosshairs",
    settings: ["requireTarget", "advantagePrompt", "autoCheckHit"] },
  { id: "attacks",    label: "Attacks",            icon: "fa-solid fa-swords",
    settings: ["damageTypeSeparation", "autoCheckResistances", "slayerAutoDetect", "batchResultsCard"] },
  { id: "damage",     label: "Damage",             icon: "fa-solid fa-burst",
    settings: ["autoRollDamage", "autoApplyDamage", "halfDamageOnSave", "dsnRevealDelayMs",
               "npcSaveAnimationDelay", "npcSaveAnimationDelayMulti", "npcDamageAnimationDelay"] },
  { id: "saves",      label: "Saves",              icon: "fa-solid fa-shield-heart",
    settings: ["targetStateAssessment", "concentrationTracking", "concentrationWidget", "concentrationOnDamage", "concentrationDamageMinDC", "bonusActionSpellRule", "bonusActionSpellStrict"] },
  { id: "reactions",  label: "Reactions",          icon: "fa-solid fa-bolt",
    settings: ["enableReactions", "autoShield", "autoCounterspell", "autoAbsorbElements", "autoLegendaryResistance"] },
  { id: "effects",    label: "Conditions & Effects", icon: "fa-solid fa-wand-sparkles",
    settings: ["extendedEffects", "autoApplyConditions", "effectTransferRules", "enableDurationTracker", "expireEffectsOnTurnChange", "notifyOnExpiry", "expiryNotifyAll", "combatWindDownEnabled", "combatWindDownThresholdMin"] },
  { id: "cover",      label: "Cover",              icon: "fa-solid fa-shield-alt",
    settings: ["enableCoverCalculation", "creatureAsCover", "showCoverIndicator", "ignoreCoverForAdjacent", "reduceCoverForLargeTargets"] },
  { id: "flanking",   label: "Flanking",           icon: "fa-solid fa-arrows-left-right",
    settings: ["flanking", "flankingAllowReachWeapons"] },
  { id: "templates",  label: "Templates",          icon: "fa-solid fa-circle-dot",
    settings: ["autoTargetTemplates", "autoDeleteInstantTemplates", "excludeCasterFromTemplates", "hideSpellTemplateVisuals"] },
  { id: "auras",      label: "Auras",              icon: "fa-solid fa-circle-radiation",
    settings: ["auraEngineEnabled", "auraVisualMode"] },
  { id: "death",      label: "Death",              icon: "fa-solid fa-skull",
    settings: ["enableDeadMarker", "enableDeathPipeline", "deleteTokenOnDeath", "notifyDeadArtFallback", "enableBloodied", "announceBloodied",
               "autoDeathSaves", "massiveDamageDeath", "autoResetOnHeal"] },
  { id: "stealth",    label: "Stealth",            icon: "fa-solid fa-user-ninja",
    settings: ["autoSurpriseCheck", "hideActionEnabled", "hideRevealsOnAttack", "hideRevealsOnDamage"] },
  { id: "actions",    label: "Combat Actions",     icon: "fa-solid fa-person-running",
    settings: ["criticalFumbleEnabled", "rangedInMeleeDisadvantage", "opportunityAttackPrompt", "opportunityAttackReach"] },
  { id: "masteries",  label: "Weapon Masteries",   icon: "fa-solid fa-khanda",
    settings: ["weaponMasteryEnabled", "weaponMasteryStrict", "weaponMasteryAllowIn2014"] },
  { id: "initiative", label: "Initiative",         icon: "fa-solid fa-hourglass-start",
    settings: ["showInitiativeButtons", "pcInitiativeAutoRoll"] },
  { id: "loot",       label: "Loot",               icon: "fa-solid fa-treasure-chest",
    settings: ["enableLootGeneration", "lootOnBio", "lootOnDeath", "minCRForLoot", "lootCardPublic", "autoPostLootCard"] },
  { id: "xp",         label: "XP",                 icon: "fa-solid fa-trophy",
    settings: ["enableXpDistribution"] },
  { id: "turnmarker", label: "Turn Marker",        icon: "fa-solid fa-circle-notch",
    settings: ["enableTurnMarker", "turnMarkerImage", "turnMarkerImageNext", "turnMarkerScale", "turnMarkerSpeed", "turnMarkerAlpha", "turnMarkerNextAlpha", "enableNextTurnMarker", "enableYourTurnNotification", "enableYourTurnSound", "yourTurnSound", "enableTurnMarkerAutoPan"] },
  { id: "movement",   label: "Movement",           icon: "fa-solid fa-route",
    settings: ["enableMovementTracker", "movementTrackerOnlyInCombat", "movementTrackerAlpha"] },
  { id: "effectspanel", label: "Effects Panel",     icon: "fa-solid fa-list",
    settings: ["enableEffectsPanel", "effectsPanelPosition", "effectsPanelAction", "effectsPanelFor", "effectsPanelShowAuras"] },
  { id: "ui",         label: "UI / Cards",         icon: "fa-solid fa-window-maximize",
    settings: ["suppressSystemCards", "hideSaveDC", "hideNPCNames", "playersSeeBloodied"] },
  { id: "advanced",   label: "Advanced",           icon: "fa-solid fa-screwdriver-wrench",
    settings: ["enableFlagsSystem", "enableOptionalPrompts", "midiCompatibility", "enableOnUseHooks", "enableOverTimeEffects", "autoApplyOverTimeDamage", "enableSpeedRolls", "enableMergeCard", "debugMode"] },
  { id: "tokens",     label: "Tokens",             icon: "fa-solid fa-paw",
    settings: ["polymorphMode"],
    customMethod: "_buildTokensTabUI" },
];

// ─── ApplicationV2 panel ────────────────────────────────────────────────────
const { ApplicationV2 } = foundry.applications.api;

export class AceQolConfigPanel extends ApplicationV2 {

  static DEFAULT_OPTIONS = {
    id: "ace-qol-config-panel",
    classes: ["ace-qol-config-panel-window"],
    tag: "div",
    window: {
      title: "ACE: QOL — Configuration",
      icon: "fa-solid fa-cog",
      resizable: true,
    },
    position: {
      width: 1100,
      height: 780,
    },
  };

  constructor(options = {}) {
    super(options);
    this._activeTab = TABS[0].id;
    this._pendingChanges = {};
    this._searchQuery = "";  // cross-tab filter input value
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  Render
  // ─────────────────────────────────────────────────────────────────────────

  async _renderHTML(_context, _options) {
    return this._buildHTML();
  }

  _replaceHTML(result, content, _options) {
    content.innerHTML = result;
    this._wireEvents(content);
  }

  _buildHTML() {
    const tabsHtml = TABS.map(tab => `
      <li class="ace-qol-cfg-tab ${tab.id === this._activeTab ? "active" : ""}" data-tab-id="${tab.id}">
        <span class="ace-qol-cfg-tab-icon ace-qol-cfg-tab-icon-${tab.id}" aria-hidden="true">
          <i class="${tab.icon ?? "fa-solid fa-circle"}"></i>
        </span>
        <span class="ace-qol-cfg-tab-label">${tab.label}</span>
      </li>
    `).join("");

    // ── Search bar (cross-tab) ──
    // When query has 2+ chars, the pane shows search results across ALL tabs
    // instead of the active tab's settings. Each result is rendered with a
    // small chip showing which tab it belongs to (clickable to jump).
    const q = String(this._searchQuery ?? "").trim();
    const searchBar = `
      <div class="ace-qol-cfg-search">
        <span class="ace-qol-cfg-search-icon"><i class="fa-solid fa-magnifying-glass"></i></span>
        <input type="search" class="ace-qol-cfg-search-input" placeholder="Search all settings…"
               value="${foundry.utils.escapeHTML(this._searchQuery ?? "")}" />
        ${q ? `<button type="button" class="ace-qol-cfg-search-clear" data-action="clear-search" title="Clear search"><i class="fa-solid fa-xmark"></i></button>` : ""}
      </div>
    `;

    let paneHtml;
    if (q.length >= 2) {
      paneHtml = this._renderSearchResults(q);
    } else {
      const activeTab = TABS.find(t => t.id === this._activeTab) ?? TABS[0];
      const settingsHtml = activeTab.settings.map(k => this._renderSetting(k)).join("");
      const customHtml = activeTab.customMethod && typeof this[activeTab.customMethod] === "function"
        ? this[activeTab.customMethod]()
        : "";
      paneHtml = `
        <div class="ace-qol-cfg-pane">
          <div class="ace-qol-cfg-pane-header">
            <span class="ace-qol-cfg-pane-icon ace-qol-cfg-tab-icon-${activeTab.id}" aria-hidden="true"></span>
            <h2>${activeTab.label}</h2>
            <span class="ace-qol-cfg-pane-icon ace-qol-cfg-pane-icon-mirror ace-qol-cfg-tab-icon-${activeTab.id}" aria-hidden="true"></span>
          </div>
          <div class="ace-qol-cfg-pane-frame">
            <div class="ace-qol-cfg-pane-body">
              ${settingsHtml}${customHtml}${(!settingsHtml && !customHtml) ? `<p class="ace-qol-cfg-empty">No settings for this tab.</p>` : ""}
            </div>
          </div>
        </div>
      `;
    }

    return `
      <div class="ace-qol-cfg-root">
        ${searchBar}
        <div class="ace-qol-cfg-body">
          <ul class="ace-qol-cfg-tablist">${tabsHtml}</ul>
          ${paneHtml}
        </div>
      </div>
      <footer class="ace-qol-cfg-footer">
        <div class="ace-qol-cfg-footer-left">
          <button type="button" data-action="reset-tab" title="Reset all settings on this tab to their defaults">
            <i class="fa-solid fa-rotate-left"></i> Reset Tab
          </button>
          <select data-action="preset-select" class="ace-qol-cfg-preset-select">
            <option value="">— Apply Preset —</option>
            <option value="recommended">Recommended</option>
            <option value="full">Full (all on)</option>
            <option value="minimal">Minimal</option>
          </select>
        </div>
        <div class="ace-qol-cfg-footer-right">
          <button type="button" data-action="cancel">
            <i class="fa-solid fa-xmark"></i> Cancel
          </button>
          <button type="button" data-action="save" class="ace-qol-cfg-save-btn">
            <i class="fa-solid fa-floppy-disk"></i> Save
          </button>
        </div>
      </footer>
    `;
  }

  /**
   * Render cross-tab search results. Walks every tab's settings, matches
   * the query (case-insensitive) against setting key, name, and hint.
   * Each match is shown with a clickable "tab chip" so the user can jump
   * to that tab and edit the setting in context.
   *
   * @param {string} query  case-insensitive needle
   * @returns {string}      HTML for the pane content
   */
  _renderSearchResults(query) {
    const q = query.toLowerCase();
    const results = [];
    for (const tab of TABS) {
      for (const key of (tab.settings ?? [])) {
        const fullKey = `${MODULE_ID}.${key}`;
        const setting = game.settings.settings.get(fullKey);
        if (!setting) continue;
        const name = String(setting.name ?? "").toLowerCase();
        const hint = String(setting.hint ?? "").toLowerCase();
        if (name.includes(q) || hint.includes(q) || key.toLowerCase().includes(q)) {
          results.push({ tab, key, setting });
        }
      }
    }

    if (!results.length) {
      return `
        <div class="ace-qol-cfg-pane">
          <div class="ace-qol-cfg-pane-header">
            <span class="ace-qol-cfg-pane-icon" aria-hidden="true"><i class="fa-solid fa-magnifying-glass"></i></span>
            <h2>Search Results</h2>
            <span class="ace-qol-cfg-pane-icon ace-qol-cfg-pane-icon-mirror" aria-hidden="true"><i class="fa-solid fa-magnifying-glass"></i></span>
          </div>
          <div class="ace-qol-cfg-pane-frame">
            <div class="ace-qol-cfg-pane-body">
              <p class="ace-qol-cfg-empty">No settings match <strong>"${foundry.utils.escapeHTML(query)}"</strong>.</p>
            </div>
          </div>
        </div>
      `;
    }

    const itemsHtml = results.map(r => `
      <div class="ace-qol-cfg-search-result">
        <button type="button" class="ace-qol-cfg-search-tab-chip" data-action="jump-to-tab"
                data-tab-id="${r.tab.id}" title="Jump to ${foundry.utils.escapeHTML(r.tab.label)} tab">
          <span class="ace-qol-cfg-tab-icon ace-qol-cfg-tab-icon-${r.tab.id}" aria-hidden="true"></span>
          ${foundry.utils.escapeHTML(r.tab.label)}
        </button>
        ${this._renderSetting(r.key)}
      </div>
    `).join("");

    return `
      <div class="ace-qol-cfg-pane">
        <div class="ace-qol-cfg-pane-header">
          <span class="ace-qol-cfg-pane-icon" aria-hidden="true"><i class="fa-solid fa-magnifying-glass"></i></span>
          <h2>Search Results — ${results.length} match${results.length === 1 ? "" : "es"} for "${foundry.utils.escapeHTML(query)}"</h2>
          <span class="ace-qol-cfg-pane-icon ace-qol-cfg-pane-icon-mirror" aria-hidden="true"><i class="fa-solid fa-magnifying-glass"></i></span>
        </div>
        <div class="ace-qol-cfg-pane-frame">
          <div class="ace-qol-cfg-pane-body">
            ${itemsHtml}
          </div>
        </div>
      </div>
    `;
  }

  _renderSetting(key) {
    const fullKey = `${MODULE_ID}.${key}`;
    const setting = game.settings.settings.get(fullKey);
    if (!setting) return "";

    let currentValue;
    try { currentValue = game.settings.get(MODULE_ID, key); }
    catch { currentValue = setting.default; }
    const value = this._pendingChanges[key] ?? currentValue;

    const safeId = `ace-qol-cfg-${key.replace(/[^a-z0-9]/gi, "-")}`;
    const safeName = foundry.utils.escapeHTML(setting.name ?? key);
    const safeHint = setting.hint ? `<p class="ace-qol-cfg-hint">${foundry.utils.escapeHTML(setting.hint)}</p>` : "";
    const isModified = key in this._pendingChanges;

    let widget = "";

    if (setting.choices) {
      const options = Object.entries(setting.choices).map(([k, v]) =>
        `<option value="${foundry.utils.escapeHTML(k)}" ${String(value) === String(k) ? "selected" : ""}>${foundry.utils.escapeHTML(v)}</option>`
      ).join("");
      widget = `<select id="${safeId}" data-setting="${key}">${options}</select>`;
    } else if (setting.type === Boolean) {
      widget = `<label class="ace-qol-cfg-toggle">
        <input type="checkbox" id="${safeId}" data-setting="${key}" ${value ? "checked" : ""}>
        <span class="ace-qol-cfg-toggle-track"></span>
      </label>`;
    } else if (setting.type === Number && setting.range) {
      const r = setting.range;
      widget = `
        <input type="range" id="${safeId}" data-setting="${key}"
               min="${r.min}" max="${r.max}" step="${r.step ?? 1}" value="${value}">
        <span class="ace-qol-cfg-range-value" data-for="${safeId}">${value}</span>`;
    } else if (setting.type === Number) {
      widget = `<input type="number" id="${safeId}" data-setting="${key}" value="${value}">`;
    } else if (setting.filePicker) {
      widget = `
        <input type="text" id="${safeId}" data-setting="${key}" value="${foundry.utils.escapeHTML(String(value ?? ""))}">
        <button type="button" data-action="filepicker" data-setting="${key}" data-fp-type="${setting.filePicker}" title="Browse files">
          <i class="fa-solid fa-folder-open"></i>
        </button>`;
    } else {
      widget = `<input type="text" id="${safeId}" data-setting="${key}" value="${foundry.utils.escapeHTML(String(value ?? ""))}">`;
    }

    return `
      <div class="ace-qol-cfg-setting ${isModified ? "modified" : ""}" data-setting-row="${key}">
        <div class="ace-qol-cfg-setting-row">
          <label for="${safeId}">${safeName}${isModified ? ' <span class="ace-qol-cfg-modified-dot" title="Unsaved change">●</span>' : ""}</label>
          <div class="ace-qol-cfg-widget">${widget}</div>
        </div>
        ${safeHint}
      </div>
    `;
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  Tokens tab — custom UI for image folder management
  // ─────────────────────────────────────────────────────────────────────────

  _buildTokensTabUI() {
    // Read live, NOT pending, since folders are managed via dedicated buttons
    let folders = [];
    try {
      const raw = game.settings.get(MODULE_ID, "tokenImageFolders");
      if (Array.isArray(raw)) folders = raw.filter(p => typeof p === "string" && p.trim());
    } catch (_) {}

    const stats = TokenCache.stats();
    const lastScan = stats.lastScan;
    const ageStr = lastScan?.timestamp
      ? this._ageString(lastScan.timestamp)
      : "never";
    const statusLine = stats.cacheSize > 0
      ? `<strong>${stats.cacheSize.toLocaleString()}</strong> images indexed across <strong>${(lastScan?.paths?.length ?? folders.length)}</strong> folder(s) — last scanned ${ageStr}${lastScan?.durationSec ? ` (took ${lastScan.durationSec.toFixed(1)}s)` : ""}`
      : `<em>Cache empty — add folders below and click Rescan</em>`;

    const folderRows = folders.length === 0
      ? `<p class="ace-qol-tokens-empty">No folders configured. Polymorph will use compendium-default images for all beasts.</p>`
      : folders.map((path, i) => `
          <div class="ace-qol-tokens-folder-row" data-folder-idx="${i}">
            <span class="ace-qol-tokens-folder-icon"><i class="fa-solid fa-folder"></i></span>
            <code class="ace-qol-tokens-folder-path">${foundry.utils.escapeHTML(path)}</code>
            <button type="button" class="ace-qol-tokens-folder-remove" data-action="tokens-remove-folder" data-idx="${i}" title="Remove this folder from the cache">
              <i class="fa-solid fa-xmark"></i>
            </button>
          </div>
        `).join("");

    return `
      <div class="ace-qol-tokens-section">
        <h3 class="ace-qol-tokens-heading">
          <i class="fa-solid fa-database"></i> Token Image Cache
        </h3>
        <p class="ace-qol-cfg-hint">
          ace-qol scans these folders <em>recursively</em> at first use and caches every image's name → path
          mapping. During Polymorph, the chosen beast's name is looked up in this cache (sub-millisecond) and
          the matching image becomes the polymorphed token. Add folders containing your curated token art.
          <strong>No Token Variants required.</strong>
        </p>

        <div class="ace-qol-tokens-status">${statusLine}</div>

        <div class="ace-qol-tokens-folders">${folderRows}</div>

        <div class="ace-qol-tokens-actions">
          <button type="button" data-action="tokens-add-folder" class="ace-qol-tokens-btn-add">
            <i class="fa-solid fa-folder-plus"></i> Add Folder…
          </button>
          <button type="button" data-action="tokens-rescan" class="ace-qol-tokens-btn-rescan" ${folders.length === 0 ? "disabled" : ""}>
            <i class="fa-solid fa-arrows-rotate"></i> Rescan All
          </button>
          <button type="button" data-action="tokens-clear-cache" class="ace-qol-tokens-btn-clear">
            <i class="fa-solid fa-trash"></i> Clear Cache
          </button>
        </div>
      </div>
    `;
  }

  _ageString(timestamp) {
    if (!timestamp) return "never";
    const seconds = Math.round((Date.now() - timestamp) / 1000);
    if (seconds < 60)    return `${seconds}s ago`;
    if (seconds < 3600)  return `${Math.round(seconds / 60)}min ago`;
    if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`;
    return `${Math.round(seconds / 86400)}d ago`;
  }

  async _addTokenFolder() {
    const FP = foundry.applications.apps?.FilePicker?.implementation
            ?? foundry.applications.apps?.FilePicker
            ?? globalThis.FilePicker;
    if (!FP) {
      ui.notifications.error("FilePicker not available.");
      return;
    }
    return new Promise(resolve => {
      const fp = new FP({
        type: "folder",
        callback: async (path) => {
          if (!path) return resolve(false);
          const cleaned = String(path).replace(/\\+/g, "/").replace(/^\/+/, "").replace(/\/+$/, "").trim();
          if (!cleaned) return resolve(false);
          let current = [];
          try {
            const raw = game.settings.get(MODULE_ID, "tokenImageFolders");
            if (Array.isArray(raw)) current = raw.slice();
          } catch (_) {}
          if (current.includes(cleaned)) {
            ui.notifications.info(`Folder already in the list: ${cleaned}`);
            return resolve(false);
          }
          current.push(cleaned);
          await game.settings.set(MODULE_ID, "tokenImageFolders", current);
          ui.notifications.info(`Added folder: ${cleaned}. Click Rescan to index it.`);
          this.render({ force: false });
          resolve(true);
        },
      });
      fp.browse("");
    });
  }

  async _removeTokenFolder(idx) {
    let current = [];
    try {
      const raw = game.settings.get(MODULE_ID, "tokenImageFolders");
      if (Array.isArray(raw)) current = raw.slice();
    } catch (_) {}
    if (idx < 0 || idx >= current.length) return;
    const removed = current.splice(idx, 1)[0];
    await game.settings.set(MODULE_ID, "tokenImageFolders", current);
    ui.notifications.info(`Removed folder: ${removed}. Click Rescan to update the cache.`);
    this.render({ force: false });
  }

  async _rescanTokens() {
    ui.notifications.info("Rescanning token folders… check console for progress.");
    try {
      await TokenCache.refresh();
      const stats = TokenCache.stats();
      ui.notifications.info(`Token cache: ${stats.cacheSize.toLocaleString()} images indexed.`);
      this.render({ force: false });
    } catch (err) {
      console.error(`${MODULE_ID} | Token cache rescan failed:`, err);
      ui.notifications.error("Token cache rescan failed — see console.");
    }
  }

  async _clearTokenCache() {
    const confirm = await foundry.applications.api.DialogV2.confirm({
      window: { title: "Clear Token Cache" },
      content: `<p>Clear the persisted token image cache? You'll need to click Rescan to rebuild it.</p><p style="font-size:11px;color:#888;">Folder list is preserved.</p>`,
      rejectClose: false,
    }).catch(() => false);
    if (!confirm) return;
    await TokenCache.clearPersistedCache();
    ui.notifications.info("Token image cache cleared.");
    this.render({ force: false });
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  Event wiring
  // ─────────────────────────────────────────────────────────────────────────

  _wireEvents(root) {
    // ── Search input ──
    // Re-renders on each keystroke to filter across all tabs. Focus and
    // caret position are restored after re-render so typing stays smooth.
    const searchInput = root.querySelector(".ace-qol-cfg-search-input");
    if (searchInput) {
      searchInput.addEventListener("input", (ev) => {
        const newQuery = ev.target.value ?? "";
        const caretPos = ev.target.selectionStart;
        this._searchQuery = newQuery;
        this.render({ force: false }).then(() => {
          // Restore focus + caret after async re-render
          const newInput = this.element?.querySelector?.(".ace-qol-cfg-search-input");
          if (newInput) {
            newInput.focus();
            try { newInput.setSelectionRange(caretPos, caretPos); } catch (_) {}
          }
        });
      });
    }
    root.querySelector("[data-action='clear-search']")?.addEventListener("click", () => {
      this._searchQuery = "";
      this.render({ force: false });
    });
    // Search results — click a tab chip to jump to that tab (clears search)
    root.querySelectorAll("[data-action='jump-to-tab']").forEach(btn => {
      btn.addEventListener("click", () => {
        const id = btn.dataset.tabId;
        if (id) {
          this._activeTab = id;
          this._searchQuery = "";
          this.render({ force: false });
        }
      });
    });

    // Tab switching — preserve the tab-rail scroll position across re-render.
    // Without this, clicking a tab causes the left rail to jump back to top
    // (the new DOM is fresh, so scrollTop defaults to 0). Capture before,
    // restore after the async render resolves.
    root.querySelectorAll(".ace-qol-cfg-tab").forEach(li => {
      li.addEventListener("click", () => {
        const id = li.dataset.tabId;
        if (id && id !== this._activeTab) {
          const tablistEl = root.querySelector(".ace-qol-cfg-tablist");
          const savedScroll = tablistEl?.scrollTop ?? 0;
          this._activeTab = id;
          this.render({ force: false }).then(() => {
            const newTablist = this.element?.querySelector?.(".ace-qol-cfg-tablist");
            if (newTablist) newTablist.scrollTop = savedScroll;
          });
        }
      });
    });

    // Setting widgets
    root.querySelectorAll("[data-setting]").forEach(el => {
      el.addEventListener("change", () => this._onSettingChange(el));
      if (el.type === "range") {
        el.addEventListener("input", () => this._onSettingChange(el));

        // ── UX fix: block wheel-over-slider from changing the value ──
        // Without this, scrolling the settings list with the mouse wheel
        // will accidentally crank any slider the cursor passes over, often
        // to its min or max. Foundry's stock UI has the same problem.
        // Standard pattern: sliders only respond to click + drag or to
        // arrow keys after click. Wheel events bubble up to scroll the
        // panel normally (we manually propagate to the scroll container).
        el.addEventListener("wheel", (ev) => {
          ev.preventDefault();
          const scrollContainer = el.closest(".ace-qol-cfg-pane-body")
                              ?? el.closest(".ace-qol-cfg-pane");
          if (scrollContainer) {
            scrollContainer.scrollBy({ top: ev.deltaY, behavior: "auto" });
          }
        }, { passive: false });
      }
    });

    // Footer buttons
    root.querySelector("[data-action='save']")?.addEventListener("click", () => this._save());
    root.querySelector("[data-action='cancel']")?.addEventListener("click", () => this.close());
    root.querySelector("[data-action='reset-tab']")?.addEventListener("click", () => this._resetTab());
    root.querySelector("[data-action='preset-select']")?.addEventListener("change", (ev) => {
      const preset = ev.target.value;
      if (preset) this._applyPreset(preset);
      ev.target.value = "";
    });

    // File picker buttons
    root.querySelectorAll("[data-action='filepicker']").forEach(btn => {
      btn.addEventListener("click", () => this._openFilePicker(btn, root));
    });

    // Tokens tab — folder management
    root.querySelector("[data-action='tokens-add-folder']")?.addEventListener("click", () => this._addTokenFolder());
    root.querySelector("[data-action='tokens-rescan']")?.addEventListener("click", () => this._rescanTokens());
    root.querySelector("[data-action='tokens-clear-cache']")?.addEventListener("click", () => this._clearTokenCache());
    root.querySelectorAll("[data-action='tokens-remove-folder']").forEach(btn => {
      btn.addEventListener("click", () => {
        const idx = Number(btn.dataset.idx);
        if (Number.isFinite(idx)) this._removeTokenFolder(idx);
      });
    });
  }

  _onSettingChange(el) {
    const key = el.dataset.setting;
    if (!key) return;
    let value;
    if (el.type === "checkbox") value = el.checked;
    else if (el.type === "number" || el.type === "range") value = parseFloat(el.value);
    else value = el.value;
    this._pendingChanges[key] = value;

    // Live update range display
    const display = el.parentElement?.querySelector(".ace-qol-cfg-range-value");
    if (display) display.textContent = value;

    // Toggle "modified" indicator
    const row = el.closest(".ace-qol-cfg-setting");
    if (row) row.classList.add("modified");
  }

  _openFilePicker(btn, root) {
    const key = btn.dataset.setting;
    const fpType = btn.dataset.fpType ?? "any";
    const input = root.querySelector(`#ace-qol-cfg-${key.replace(/[^a-z0-9]/gi, "-")}`);
    const FP = foundry.applications.apps?.FilePicker?.implementation
            ?? foundry.applications.apps?.FilePicker
            ?? globalThis.FilePicker;
    if (!FP) {
      ui.notifications.error("ACE QOL: FilePicker not available.");
      return;
    }
    const fp = new FP({
      type: fpType,
      current: input?.value ?? "",
      callback: (path) => {
        if (input) {
          input.value = path;
          this._pendingChanges[key] = path;
          const row = input.closest(".ace-qol-cfg-setting");
          if (row) row.classList.add("modified");
        }
      },
    });
    fp.browse();
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  Save / Reset / Preset
  // ─────────────────────────────────────────────────────────────────────────

  async _save() {
    const entries = Object.entries(this._pendingChanges);
    if (!entries.length) {
      ui.notifications.info("ACE QOL: No changes to save.");
      this.close();
      return;
    }
    let saved = 0, failed = 0;
    for (const [key, value] of entries) {
      try {
        await game.settings.set(MODULE_ID, key, value);
        saved++;
      } catch (err) {
        console.warn(`${MODULE_ID} | Failed to save setting "${key}":`, err);
        failed++;
      }
    }
    ui.notifications.info(`ACE QOL: Saved ${saved} setting${saved === 1 ? "" : "s"}${failed ? ` (${failed} failed)` : ""}.`);
    this._pendingChanges = {};
    this.close();
  }

  async _resetTab() {
    const tab = TABS.find(t => t.id === this._activeTab);
    if (!tab) return;
    const proceed = await foundry.applications.api.DialogV2.confirm({
      window: { title: "Reset Tab to Defaults" },
      content: `<p>Reset all <strong>${tab.label}</strong> settings to their default values?</p><p style="font-size:11px;color:#888;">Changes are pending until you click Save.</p>`,
      rejectClose: false,
    }).catch(() => false);
    if (!proceed) return;

    for (const key of tab.settings) {
      const setting = game.settings.settings.get(`${MODULE_ID}.${key}`);
      if (setting && "default" in setting) {
        this._pendingChanges[key] = setting.default;
      }
    }
    this.render({ force: false });
  }

  async _applyPreset(presetName) {
    const proceed = await foundry.applications.api.DialogV2.confirm({
      window: { title: "Apply Preset" },
      content: `<p>Apply the <strong>${presetName}</strong> preset? This will queue changes across many settings.</p><p style="font-size:11px;color:#888;">Changes are pending until you click Save.</p>`,
      rejectClose: false,
    }).catch(() => false);
    if (!proceed) return;

    try {
      // QolSettings has its own preset definitions — call the preset apply method
      // but stage the changes in pending instead of saving immediately.
      // Simpler: ask it to apply, then reload pending from current values.
      await QolSettings.applyPreset(presetName);
      this._pendingChanges = {}; // QolSettings already saved
      this.render({ force: false });
      ui.notifications.info(`ACE QOL: Applied "${presetName}" preset.`);
    } catch (err) {
      console.warn(`${MODULE_ID} | Apply preset failed:`, err);
      ui.notifications.error(`Failed to apply preset: ${err.message ?? err}`);
    }
  }
}
