// ============================================================
// ACE QOL — AutoAnimations Quick-Edit Dialog
//
// Right-click a spell → "Tweak Animation" → this dialog opens.
// One-screen edit of the spell's AA visual config:
//   - File path (Sequencer DB) + Browse to open Sequencer Viewer
//   - Scale slider, Opacity slider, Below-tokens toggle
//   - "Disable AA globally" toggle (deletes the autorec record)
//   - Preview button (plays once on selected token, no save)
//   - Save (writes to AA autorec — GLOBAL change)
//
// UI: ACE dark theme. Body text 14-16px, headings 18-20px. No
// light-on-light. Reachable from actor sheet spell list + chat
// card after cast (wired in aa-tools-init.mjs).
// ============================================================

import { AAStore } from "./aa-store.mjs";

const MODULE_ID = "ace-qol";
const TAG = `${MODULE_ID} | AAQuickEdit`;

export class AAQuickEdit {

  /**
   * Open the quick-edit dialog for a spell item.
   * @param {Item} item — the spell item from any actor
   * @param {Token|null} [previewToken] — token used by Preview button
   */
  static async open(item, previewToken = null) {
    if (!AAStore.isInstalled()) {
      ui.notifications.warn("AutoAnimations is not installed.");
      return;
    }
    if (!item || item.type !== "spell") {
      ui.notifications.warn("Not a spell item.");
      return;
    }
    const dialog = new AAQuickEdit(item, previewToken);
    // Async pre-load: if no autorec record exists, probe AA's compiled
    // defaults so the dialog opens with whatever AA WOULD play for this
    // spell. Falls back silently to empty fields if AA's API isn't
    // accessible the way we guess.
    await dialog._loadFields();
    dialog.render();
  }

  constructor(item, previewToken) {
    this.item         = item;
    this.spellName    = item.name;
    this.previewToken = previewToken;
    this.fields       = AAStore.getEditableFields(null); // defaults
    this.hasRecord    = false;
    this.dataSource   = "empty"; // "autorec" | "aa-default" | "empty"

    this._overlay = null;
    this._modal   = null;
  }

  async _loadFields() {
    // Step 1: look for an autorec record
    const entry = AAStore.findRecord(this.spellName);
    if (entry) {
      this.fields     = AAStore.getEditableFields(entry.record);
      this.hasRecord  = true;
      this.dataSource = "autorec";
      return;
    }
    // Step 2: no autorec — try AA's compiled defaults via its API
    const def = await AAStore.getCompiledDefault(this.item);
    if (def) {
      this.fields     = def;
      this.dataSource = "aa-default";
      return;
    }
    // Step 3: nothing found — start blank
    this.fields     = AAStore.getEditableFields(null);
    this.dataSource = "empty";
  }

  // ── DOM construction ────────────────────────────────────────

  render() {
    // Remove any leftover open dialog (one at a time)
    document.querySelectorAll(".ace-qol-aa-quick-edit-overlay").forEach(el => el.remove());

    const overlay = document.createElement("div");
    overlay.className = "ace-qol-aa-quick-edit-overlay";
    overlay.style.cssText = `
      position: fixed; inset: 0; background: rgba(0,0,0,0.78);
      z-index: 99999; display: flex; align-items: center; justify-content: center;
    `;

    const modal = document.createElement("div");
    modal.className = "ace-qol-aa-quick-edit-modal";
    modal.style.cssText = `
      position: relative;
      background: linear-gradient(180deg, #1f1f24 0%, #15151a 100%);
      color: #e8dfc8;
      border: 2px solid #d4af37; border-radius: 10px;
      padding: 28px 32px;
      min-width: 640px; max-width: 820px;
      font-family: 'Signika', sans-serif;
      box-shadow: 0 16px 60px rgba(0,0,0,0.85), inset 0 1px 0 rgba(212,175,55,0.15);
    `;
    modal.innerHTML = this._html();

    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    this._overlay = overlay;
    this._modal   = modal;
    this._wireEvents();
  }

  _html() {
    const f = this.fields;
    // The Sequencer Animation Path input ONLY ever shows a real Sequencer
    // path (customPath). If the record uses an AA preset name ("fireball")
    // instead of a custom Sequencer path, the input stays empty and the
    // preset name is shown in the heads-up banner as INFO. Typing into the
    // input + saving creates a customPath override.
    const escapedPath  = this._escape(f.customPath ?? "");
    const usingPreset  = !f.customPath && !!f.presetName;
    const status = (() => {
      if (this.dataSource === "autorec")
        return `<span style="color:#4ade80;">✓ Loaded from your AA autorec — editing existing record</span>`;
      if (this.dataSource === "aa-default")
        return `<span style="color:#60a5fa;">✓ Loaded from AA's compiled default — saving will create your first override</span>`;
      return `<span style="color:#facc15;">No data found — saving will create a new AA record</span>`;
    })();

    return `
      <button id="ace-aa-close-x"
        title="Close (Esc)"
        style="position:absolute;top:14px;right:18px;background:none;border:none;
               color:#c8b890;font-size:30px;line-height:1;cursor:pointer;padding:4px 10px;
               font-family:inherit;border-radius:4px;font-weight:300;">
        ×
      </button>
      <h2 style="color:#d4af37;font-size:26px;margin:0 0 8px;font-family:'Cinzel',serif;letter-spacing:1.5px;padding-right:50px;">
        AA Quick-Edit
      </h2>
      <div style="font-size:17px;color:#c8b890;margin-bottom:8px;">
        Spell: <strong style="color:#fff;font-size:18px;">${this._escape(this.spellName)}</strong>
      </div>
      <div style="font-size:14px;margin-bottom:18px;">${status}</div>

      <div style="font-size:14px;color:#fb923c;font-style:italic;
                  background:#2a1f0a;border-left:4px solid #fb923c;
                  padding:10px 14px;margin-bottom:20px;border-radius:0 5px 5px 0;line-height:1.5;">
        ⚠ Changes are GLOBAL — affect every actor's <strong>${this._escape(this.spellName)}</strong>.
        Use Themes (coming soon) to override on a specific actor.
      </div>

      <div style="display:flex;flex-direction:column;gap:20px;">

        <!-- ─── File path + Browse ─── -->
        <div>
          <label style="display:block;font-size:16px;color:#d4af37;margin-bottom:6px;font-weight:bold;letter-spacing:0.3px;">
            Sequencer Animation Path
          </label>
          <div style="display:flex;gap:8px;">
            <input type="text" id="ace-aa-path" value="${escapedPath}"
              placeholder="e.g. jb2a.fog_cloud.02.green02"
              style="flex:1;background:#2a2a30;color:#e8dfc8;border:1px solid #555;
                     padding:10px 12px;font-size:15px;font-family:'Signika',sans-serif;border-radius:4px;">
            <button id="ace-aa-browse"
              style="background:#3a2a10;color:#d4af37;border:1px solid #d4af37;
                     padding:8px 18px;font-size:15px;cursor:pointer;font-weight:bold;
                     border-radius:4px;font-family:inherit;letter-spacing:0.5px;">
              Browse
            </button>
          </div>
          ${usingPreset ? `
            <div style="font-size:14px;color:#facc15;margin-top:8px;background:#2a1f0a;padding:10px 14px;border-radius:4px;border-left:4px solid #facc15;line-height:1.55;">
              <strong>Heads up:</strong> AA is currently using its built-in preset named <strong style="color:#fff;">${this._escape(f.presetName)}</strong>${f.color ? ` (color: <strong style="color:#fff;">${this._escape(f.color)}</strong>)` : ""}${f.variant ? `, variant <strong style="color:#fff;">${this._escape(f.variant)}</strong>` : ""}. That's an internal AA reference, not a Sequencer path — typing a Sequencer path above and saving will override it with your custom asset.
            </div>
          ` : ""}
          <div style="font-size:13px;color:#a8a090;margin-top:6px;font-style:italic;">
            Click Browse to open Sequencer's Database Viewer.
          </div>
        </div>

        <!-- ─── Scale + Opacity sliders side-by-side ─── -->
        <div style="display:flex;gap:24px;">
          <div style="flex:1;">
            <label style="display:block;font-size:16px;color:#d4af37;margin-bottom:6px;font-weight:bold;">
              Scale: <span id="ace-aa-scale-display" style="color:#fff;">${Number(f.scale ?? 1).toFixed(2)}</span>x
            </label>
            <input type="range" id="ace-aa-scale" min="0.5" max="2.5" step="0.05"
              value="${Number(f.scale ?? 1)}" style="width:100%;cursor:pointer;height:6px;">
          </div>
          <div style="flex:1;">
            <label style="display:block;font-size:16px;color:#d4af37;margin-bottom:6px;font-weight:bold;">
              Opacity: <span id="ace-aa-opacity-display" style="color:#fff;">${Math.round((f.opacity ?? 1) * 100)}</span>%
            </label>
            <input type="range" id="ace-aa-opacity" min="0.1" max="1.0" step="0.05"
              value="${Number(f.opacity ?? 1)}" style="width:100%;cursor:pointer;height:6px;">
          </div>
        </div>

        <!-- ─── Below tokens checkbox ─── -->
        <div>
          <label style="font-size:16px;color:#e8dfc8;cursor:pointer;display:flex;align-items:center;gap:10px;">
            <input type="checkbox" id="ace-aa-below" ${f.belowTokens ? "checked" : ""}
              style="width:20px;height:20px;cursor:pointer;">
            Render below tokens (ground effects: Spike Growth, Grease, Web)
          </label>
        </div>

        <!-- ─── Kill animation toggle ─── -->
        <div style="padding:14px 16px;background:#2a1818;border-radius:5px;border:1px solid #5a3030;">
          <label style="font-size:16px;color:#ef4444;cursor:pointer;display:flex;align-items:center;gap:10px;font-weight:bold;">
            <input type="checkbox" id="ace-aa-kill"
              style="width:20px;height:20px;cursor:pointer;">
            Disable AA globally for this spell (deletes the record)
          </label>
          <p style="font-size:14px;color:#c8b890;margin:8px 0 0 30px;font-style:italic;line-height:1.45;">
            Use this if you're handling animations elsewhere. Reversible — re-save with this unchecked to recreate.
          </p>
        </div>

      </div>

      <!-- ─── Action buttons ─── -->
      <div style="margin-top:26px;padding-top:18px;border-top:1px solid rgba(212,175,55,0.2);display:flex;gap:12px;justify-content:flex-end;align-items:center;">
        <span id="ace-aa-msg" style="margin-right:auto;font-size:14px;color:#c8b890;"></span>
        <button id="ace-aa-preview"
          style="background:#1a1a1f;color:#4ade80;border:1px solid #4ade80;
                 padding:11px 22px;font-size:16px;cursor:pointer;border-radius:5px;
                 font-family:inherit;font-weight:bold;letter-spacing:0.5px;">
          Preview
        </button>
        <button id="ace-aa-save"
          style="background:linear-gradient(180deg,#5a4015,#3a2a10);color:#d4af37;border:1px solid #d4af37;
                 padding:12px 24px;font-size:17px;font-weight:bold;cursor:pointer;
                 border-radius:5px;font-family:inherit;letter-spacing:0.5px;">
          Save (Global)
        </button>
        <button id="ace-aa-cancel"
          style="background:#1a1a1f;color:#c8b890;border:1px solid #555;
                 padding:11px 22px;font-size:16px;cursor:pointer;border-radius:5px;
                 font-family:inherit;">
          Cancel
        </button>
      </div>
    `;
  }

  // ── Event wiring ────────────────────────────────────────────

  _wireEvents() {
    const m = this._modal;

    // Live slider readout
    m.querySelector("#ace-aa-scale").addEventListener("input", (e) => {
      m.querySelector("#ace-aa-scale-display").textContent = Number(e.target.value).toFixed(2);
    });
    m.querySelector("#ace-aa-opacity").addEventListener("input", (e) => {
      m.querySelector("#ace-aa-opacity-display").textContent = Math.round(e.target.value * 100);
    });

    // Disable rest of form when kill toggle is on
    const killCb = m.querySelector("#ace-aa-kill");
    const updateKillState = () => {
      const dim = killCb.checked;
      ["#ace-aa-path", "#ace-aa-browse", "#ace-aa-scale", "#ace-aa-opacity", "#ace-aa-below", "#ace-aa-preview"]
        .forEach(sel => {
          const el = m.querySelector(sel);
          if (el) el.disabled = dim;
          if (el) el.style.opacity = dim ? "0.4" : "1";
        });
    };
    killCb.addEventListener("change", updateKillState);

    // Buttons
    m.querySelector("#ace-aa-browse").addEventListener("click",   () => this._onBrowse());
    m.querySelector("#ace-aa-preview").addEventListener("click",  () => this._onPreview());
    m.querySelector("#ace-aa-save").addEventListener("click",     () => this._onSave());
    m.querySelector("#ace-aa-cancel").addEventListener("click",   () => this._close());
    m.querySelector("#ace-aa-close-x").addEventListener("click",  () => this._close());
    // Hover effect on the X button
    const xBtn = m.querySelector("#ace-aa-close-x");
    xBtn.addEventListener("mouseenter", () => { xBtn.style.color = "#ef4444"; xBtn.style.background = "rgba(239,68,68,0.1)"; });
    xBtn.addEventListener("mouseleave", () => { xBtn.style.color = "#c8b890"; xBtn.style.background = "none"; });

    // Click outside the modal to dismiss
    this._overlay.addEventListener("click", (e) => {
      if (e.target === this._overlay) this._close();
    });

    // Escape key to dismiss
    this._escHandler = (e) => { if (e.key === "Escape") this._close(); };
    document.addEventListener("keydown", this._escHandler);
  }

  // ── Actions ─────────────────────────────────────────────────

  _onBrowse() {
    try {
      if (typeof Sequencer === "undefined" || !Sequencer.DatabaseViewer) {
        ui.notifications.warn("Sequencer module not loaded — type the path manually.");
        return;
      }
      // Snapshot all existing app windows BEFORE calling show(). Anything
      // that's in the DOM after `show()` finishes that wasn't in this set
      // is the new viewer. Works regardless of Sequencer's specific CSS
      // class naming, which has shifted across versions.
      const APP_SEL = ".window-app, .application, [id^='sequencer-']";
      const beforeSnapshot = new Set(document.querySelectorAll(APP_SEL));

      Sequencer.DatabaseViewer.show();

      // Try multiple times in case the render is slow. Each retry bumps
      // any NEW app windows above our overlay (99999).
      const bumpNewApps = () => {
        const after = document.querySelectorAll(APP_SEL);
        let bumped = 0;
        for (const el of after) {
          if (beforeSnapshot.has(el)) continue;
          el.style.setProperty("z-index", "100001", "important");
          bumped++;
        }
        return bumped;
      };
      // Retry at 100ms, 300ms, 600ms — covers slow renders + animations
      let attempts = 0;
      const interval = setInterval(() => {
        attempts++;
        const n = bumpNewApps();
        if (n > 0 || attempts >= 6) {
          clearInterval(interval);
          if (n === 0) {
            console.warn(`${TAG} | Could not find new Sequencer DatabaseViewer window to bring to top after ${attempts} tries`);
          }
        }
      }, 100);

      this._setMsg("Database Viewer opened — copy a path, click back here to paste.");
    } catch (err) {
      console.warn(`${TAG} | Browse failed:`, err);
    }
  }

  _onPreview() {
    const SequenceCtor = (typeof Sequence !== "undefined") ? Sequence
                       : globalThis.Sequence ?? Sequencer?.Sequence ?? null;
    if (!SequenceCtor) {
      this._setMsg("Sequencer not available for preview.", "#ef4444");
      return;
    }

    const path = this._modal.querySelector("#ace-aa-path").value.trim();
    if (!path) { this._setMsg("Enter a file path first.", "#facc15"); return; }

    const target = this.previewToken
                ?? canvas.tokens.controlled[0]
                ?? canvas.tokens.placeables[0];
    if (!target) { this._setMsg("Place or select a token to preview on.", "#facc15"); return; }

    // Verify the path exists in the DB to avoid silent black-screen previews
    try {
      if (Sequencer.Database && !Sequencer.Database.entryExists(path)) {
        this._setMsg(`Path "${path}" not in your Sequencer DB — preview may not show.`, "#facc15");
      }
    } catch (_) { /* non-fatal */ }

    const scale   = Number(this._modal.querySelector("#ace-aa-scale").value);
    const opacity = Number(this._modal.querySelector("#ace-aa-opacity").value);
    const below   = this._modal.querySelector("#ace-aa-below").checked;

    try {
      let chain = new SequenceCtor().effect()
        .file(path)
        .atLocation(target)
        .scaleToObject(scale)
        .opacity(opacity);
      if (below) chain = chain.belowTokens();
      chain.play();
      this._setMsg("Preview playing — close + re-open Browse if needed.", "#4ade80");
    } catch (err) {
      this._setMsg(`Preview failed: ${err.message}`, "#ef4444");
      console.error(`${TAG} | Preview failed:`, err);
    }
  }

  async _onSave() {
    const kill = this._modal.querySelector("#ace-aa-kill").checked;

    if (kill) {
      const ok = await AAStore.deleteRecord(this.spellName);
      if (ok) {
        ui.notifications.info(`AA disabled globally for "${this.spellName}". Reload Foundry.`);
        this._close();
      } else {
        this._setMsg("Failed to delete AA record. Check console.", "#ef4444");
      }
      return;
    }

    const path    = this._modal.querySelector("#ace-aa-path").value.trim();
    const scale   = Number(this._modal.querySelector("#ace-aa-scale").value);
    const opacity = Number(this._modal.querySelector("#ace-aa-opacity").value);
    const below   = this._modal.querySelector("#ace-aa-below").checked;

    if (!path) {
      this._setMsg("Enter a file path or check 'Disable AA globally'.", "#facc15");
      return;
    }

    const ok = await AAStore.upsertFields(this.spellName, {
      customPath:  path,
      scale,
      opacity,
      belowTokens: below,
    });

    if (ok) {
      ui.notifications.info(`Saved AA config for "${this.spellName}". Reload Foundry for AA to pick up the new settings.`);
      this._close();
    } else {
      this._setMsg("Save failed — check console.", "#ef4444");
    }
  }

  // ── Helpers ─────────────────────────────────────────────────

  _close() {
    if (this._escHandler) {
      document.removeEventListener("keydown", this._escHandler);
      this._escHandler = null;
    }
    if (this._overlay) {
      this._overlay.remove();
      this._overlay = null;
      this._modal   = null;
    }
  }

  _setMsg(text, color = "#c8b890") {
    const el = this._modal?.querySelector("#ace-aa-msg");
    if (el) {
      el.textContent = text;
      el.style.color = color;
    }
  }

  _escape(str) {
    const div = document.createElement("div");
    div.textContent = String(str ?? "");
    return div.innerHTML;
  }
}
