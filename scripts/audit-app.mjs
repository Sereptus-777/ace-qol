// ─── ACE: QOL — Audit Tool window + GM settings button (read-only) ────────────
// PHASE 1 of Johnny's "check that everything is built right" system. Opens from
// Quality-of-Life settings → "Audit Items, Spells & Features". Scans the world
// and/or compendiums and lists every document whose data is internally
// inconsistent. It CHANGES NOTHING — fixing arrives in a later phase.
// ──────────────────────────────────────────────────────────────────────────────

import { runAudit, AUDIT_TYPE_GROUPS } from "./item-validator.mjs";
import { rawEntryCount, RAW_ATTRIBUTION } from "./raw-reference.mjs";

const MODULE_ID = "ace-qol";

// Friendly label + colour per finding kind, worst first.
const KIND_INFO = {
  "raw-wrong":    { label: "Wrong vs RAW",               color: "#e0584f", order: 0 },
  "mwak→ranged?": { label: "Ranged typed as melee",      color: "#e0584f", order: 1 },
  "no-type":      { label: "No attack type",             color: "#e0584f", order: 2 },
  "msak→rsak?":   { label: "Melee-spell, ranged range",  color: "#e8a33d", order: 3 },
  "reach-check":  { label: "Reach past size",            color: "#c9b458", order: 4 },
};

function _esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

export class AuditApp extends foundry.applications.api.ApplicationV2 {
  static DEFAULT_OPTIONS = {
    id: "ace-qol-audit",
    classes: ["ace-qol-audit"],
    tag: "div",
    window: { title: "ACE — Audit Items, Spells & Features", icon: "fa-solid fa-clipboard-check", resizable: true },
    position: { width: 960, height: 740 },
    actions: {
      run:  AuditApp.#onRun,
      copy: AuditApp.#onCopy,
    },
  };

  #findings = null;     // null = not run yet
  #running  = false;
  #progress = "";
  #scope    = "world";                          // remembered across re-renders
  #types    = Object.keys(AUDIT_TYPE_GROUPS);   // remembered across re-renders

  async _renderHTML() { return this.#buildHTML(); }
  _replaceHTML(result, content) { content.innerHTML = result; }

  #buildHTML() {
    const dis = this.#running ? "disabled" : "";
    const typeChks = Object.entries(AUDIT_TYPE_GROUPS)
      .map(([k, g]) => `<label class="aqa-chk"><input type="checkbox" name="type" value="${k}" ${this.#types.includes(k) ? "checked" : ""} ${dis}> ${_esc(g.label)}</label>`)
      .join("");

    let results;
    if (this.#running) {
      results = `<div class="aqa-status"><i class="fa-solid fa-spinner fa-spin"></i> ${_esc(this.#progress || "Running…")}</div>`;
    } else if (this.#findings == null) {
      results = `<div class="aqa-status aqa-muted">Choose a scope and what to check, then press <b>Run audit</b>. Items are checked against ACE's canonical RAW table; anything without an entry falls back to a labelled heuristic. Read-only — it changes nothing. Scanning all compendiums can take a little while.</div>`;
    } else if (!this.#findings.length) {
      results = `<div class="aqa-status aqa-ok"><i class="fa-solid fa-circle-check"></i> No inconsistencies found. ✓</div>`;
    } else {
      const counts = {};
      for (const f of this.#findings) counts[f.kind] = (counts[f.kind] ?? 0) + 1;
      const pills = Object.entries(counts)
        .sort((a, b) => (KIND_INFO[a[0]]?.order ?? 9) - (KIND_INFO[b[0]]?.order ?? 9))
        .map(([k, n]) => {
          const info = KIND_INFO[k] ?? { label: k, color: "#aaa" };
          return `<span class="aqa-pill" style="border-color:${info.color};color:${info.color}">${_esc(info.label)}: ${n}</span>`;
        }).join("");

      const rows = this.#findings.map(f => {
        const info = KIND_INFO[f.kind] ?? { label: f.kind, color: "#aaa" };
        return `<tr>
            <td>${_esc(f.where)}</td>
            <td>${_esc(f.owner)}</td>
            <td class="aqa-item">${_esc(f.item)}${f.count > 1 ? ` <span class="aqa-count" title="${f.count} identical instances in this location">×${f.count}</span>` : ""}</td>
            <td>${_esc(f.type)}</td>
            <td><span class="aqa-tag" style="color:${info.color};border-color:${info.color}" title="${_esc(info.label)}">${_esc(f.kind)}</span></td>
            <td class="aqa-has">${_esc(f.itemVal || "")}</td>
            <td class="aqa-raw">${_esc(f.rawVal || "")}</td>
            <td class="aqa-issue">${_esc(f.issue)}</td>
          </tr>`;
      }).join("");

      results = `
        <div class="aqa-summary">
          ${pills}
          <button type="button" class="aqa-copy" data-action="copy"><i class="fa-solid fa-copy"></i> Copy list</button>
        </div>
        <div class="aqa-tablewrap">
          <table class="aqa-table">
            <thead><tr><th>Where</th><th>Owner</th><th>Item</th><th>Type</th><th>Verdict</th><th>Item has</th><th>RAW says</th><th>Detail</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>`;
    }

    return `
      <div class="aqa-controls">
        <div class="aqa-row">
          <span class="aqa-lbl">Scope</span>
          <label class="aqa-chk"><input type="radio" name="scope" value="world" ${this.#scope === "world" ? "checked" : ""} ${dis}> This world</label>
          <label class="aqa-chk"><input type="radio" name="scope" value="compendium" ${this.#scope === "compendium" ? "checked" : ""} ${dis}> Compendiums</label>
          <label class="aqa-chk"><input type="radio" name="scope" value="both" ${this.#scope === "both" ? "checked" : ""} ${dis}> Both</label>
        </div>
        <div class="aqa-row">
          <span class="aqa-lbl">Check</span>
          ${typeChks}
        </div>
        <div class="aqa-row aqa-runrow">
          <button type="button" class="aqa-run" data-action="run" ${this.#running ? "disabled" : ""}>
            <i class="fa-solid fa-magnifying-glass"></i> Run audit
          </button>
          <span class="aqa-note">Read-only — nothing is changed. Fixing comes in a later phase.</span>
        </div>
      </div>
      ${results}
      <div class="aqa-footer" title="${_esc(RAW_ATTRIBUTION)}"><i class="fa-solid fa-scale-balanced"></i> Checking against ${rawEntryCount()} canonical RAW entries · SRD content under CC-BY-4.0</div>`;
  }

  static async #onRun() {
    if (this.#running) return;
    const root = this.element;
    const scope = root.querySelector('input[name="scope"]:checked')?.value ?? "world";
    const types = [...root.querySelectorAll('input[name="type"]:checked')].map(e => e.value);
    this.#scope = scope;   // remember the selection so the re-renders below preserve it
    this.#types = types;

    this.#running = true;
    this.#progress = "Starting…";
    this.#findings = null;
    await this.render();

    try {
      const findings = await runAudit({
        scope, types,
        // Update only the status line during the scan — avoids re-render races.
        onProgress: (msg) => {
          this.#progress = msg;
          const el = this.element?.querySelector(".aqa-status");
          if (el) el.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> ${_esc(msg)}`;
        },
      });
      // Collapse identical findings (same where/owner/item/activity/kind) into one
      // row with a count. A junk compendium full of duplicate actors (e.g. a botched
      // import) otherwise floods the list with the same line hundreds of times.
      const map = new Map();
      for (const f of findings) {
        const key = `${f.where}|${f.owner}|${f.item}|${f.type}|${f.activity}|${f.kind}`;
        const ex = map.get(key);
        if (ex) ex.count++;
        else map.set(key, { ...f, count: 1 });
      }
      const deduped = [...map.values()];
      deduped.sort((a, b) =>
        (KIND_INFO[a.kind]?.order ?? 9) - (KIND_INFO[b.kind]?.order ?? 9) ||
        (b.count - a.count) ||
        String(a.where).localeCompare(String(b.where)) ||
        String(a.owner).localeCompare(String(b.owner)) ||
        String(a.item).localeCompare(String(b.item)));
      this.#findings = deduped;
    } catch (e) {
      console.error(`${MODULE_ID} | Audit run failed:`, e);
      ui.notifications?.error("ACE audit failed — see console (F12).");
      this.#findings = [];
    } finally {
      this.#running = false;
      await this.render();
    }
  }

  static async #onCopy() {
    if (!this.#findings?.length) return;
    const text = this.#findings
      .map(f => {
        const id = `${f.where} · ${f.owner} · ${f.item}${f.count > 1 ? ` ×${f.count}` : ""}`;
        const cmp = f.itemVal ? ` — item: ${f.itemVal} / RAW: ${f.rawVal}` : "";
        return `[${f.kind}] ${id}${cmp}: ${f.issue}`;
      })
      .join("\n");
    try {
      await game.clipboard.copyPlainText(text);
      ui.notifications?.info(`Copied ${this.#findings.length} findings to the clipboard.`);
    } catch (_) {
      console.log(text);
      ui.notifications?.info("Findings logged to console (clipboard unavailable).");
    }
  }
}

// ── Dark, readable styling (CLAUDE.md UI rules: never light-on-light) ──────────
const AUDIT_CSS = `
.ace-qol-audit .window-content { background:#17171a; color:#e8e3d3; padding:0; display:flex; flex-direction:column; flex:1 1 auto; min-height:0; overflow:hidden; }
.ace-qol-audit .aqa-controls { padding:12px 14px; border-bottom:1px solid #3a3a40; background:#1f1f24; flex:0 0 auto; }
.ace-qol-audit .aqa-row { display:flex; align-items:center; flex-wrap:wrap; gap:14px; margin:6px 0; }
.ace-qol-audit .aqa-lbl { font-weight:700; color:#d4af37; min-width:54px; font-size:14px; letter-spacing:.04em; text-transform:uppercase; }
.ace-qol-audit .aqa-chk { display:inline-flex; align-items:center; gap:5px; font-size:14px; cursor:pointer; }
.ace-qol-audit .aqa-chk input { cursor:pointer; }
.ace-qol-audit .aqa-runrow { margin-top:10px; }
.ace-qol-audit .aqa-run { background:linear-gradient(#3a3320,#2a2410); color:#f0e4c0; border:1px solid #d4af37; border-radius:4px; padding:7px 16px; font-size:15px; font-weight:700; cursor:pointer; }
.ace-qol-audit .aqa-run:hover { box-shadow:0 0 10px rgba(212,175,55,.5); }
.ace-qol-audit .aqa-run:disabled { opacity:.5; cursor:default; box-shadow:none; }
.ace-qol-audit .aqa-note { font-size:13px; color:#9a948a; }
.ace-qol-audit .aqa-status { padding:22px 16px; font-size:16px; }
.ace-qol-audit .aqa-status.aqa-muted { color:#b8b2a6; }
.ace-qol-audit .aqa-status.aqa-ok { color:#5fcf7f; }
.ace-qol-audit .aqa-summary { display:flex; align-items:center; flex-wrap:wrap; gap:8px; padding:10px 14px; background:#1f1f24; border-bottom:1px solid #3a3a40; flex:0 0 auto; }
.ace-qol-audit .aqa-pill { border:1px solid; border-radius:12px; padding:2px 10px; font-size:13px; font-weight:700; }
.ace-qol-audit .aqa-copy { margin-left:auto; background:#2a2a30; color:#e8e3d3; border:1px solid #555; border-radius:4px; padding:4px 10px; font-size:13px; cursor:pointer; }
.ace-qol-audit .aqa-copy:hover { border-color:#d4af37; color:#f0e4c0; }
.ace-qol-audit .aqa-tablewrap { overflow:auto; flex:1 1 auto; min-height:0; }
.ace-qol-audit .aqa-table { width:100%; border-collapse:collapse; font-size:13px; }
.ace-qol-audit .aqa-table thead th { position:sticky; top:0; background:#26262c; color:#d4af37; text-align:left; padding:7px 9px; border-bottom:2px solid #3a3a40; font-size:13px; white-space:nowrap; z-index:1; }
.ace-qol-audit .aqa-table td { padding:6px 9px; border-bottom:1px solid #2c2c32; vertical-align:top; }
.ace-qol-audit .aqa-table tbody tr:hover { background:#22222a; }
.ace-qol-audit .aqa-item { font-weight:700; color:#f0e4c0; }
.ace-qol-audit .aqa-count { display:inline-block; margin-left:6px; background:#3a2a2a; color:#f0a0a0; border:1px solid #7a4a4a; border-radius:8px; padding:0 7px; font-size:11px; font-weight:700; }
.ace-qol-audit .aqa-tag { border:1px solid; border-radius:4px; padding:1px 6px; font-size:12px; white-space:nowrap; }
.ace-qol-audit .aqa-issue { color:#cfc9bd; min-width:240px; }
.ace-qol-audit .aqa-has { color:#e89a90; white-space:nowrap; font-weight:600; }
.ace-qol-audit .aqa-raw { color:#8fcf9f; white-space:nowrap; font-weight:600; }
.ace-qol-audit .aqa-footer { flex:0 0 auto; padding:6px 14px; font-size:12px; color:#8a857b; border-top:1px solid #3a3a40; background:#1f1f24; }
`;

// Register the GM settings button at init; inject CSS + expose opener at ready.
Hooks.once("init", () => {
  try {
    game.settings.registerMenu(MODULE_ID, "auditTool", {
      name: "Audit Items, Spells & Features",
      label: "Open Audit Tool",
      hint: "Read-only scan of your world and compendiums for items, spells, and features whose data is built inconsistently (e.g. a melee-typed spell with a ranged range, or an attack with no melee/ranged type). Changes nothing.",
      icon: "fa-solid fa-clipboard-check",
      type: AuditApp,
      restricted: true,
    });
  } catch (e) {
    console.warn(`${MODULE_ID} | Audit menu registration failed:`, e);
  }
});

Hooks.once("ready", () => {
  try {
    if (!document.getElementById("ace-qol-audit-css")) {
      const style = document.createElement("style");
      style.id = "ace-qol-audit-css";
      style.textContent = AUDIT_CSS;
      document.head.appendChild(style);
    }
    game.aceQol = game.aceQol || {};
    game.aceQol.openAudit = () => new AuditApp().render(true);
  } catch (e) {
    console.warn(`${MODULE_ID} | Audit CSS/API init failed:`, e);
  }
});
