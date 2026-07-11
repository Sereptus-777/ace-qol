// ─── ACE: QOL — Rules Coverage Report (the honest map) ────────────────────────
//
// One window that answers "how much of MY world does the engine own?" —
// every spell and weapon carried by actors in this world, bucketed:
//
//   LIBRARY       — a curated rules entry ships with the module
//   SELF-LEARNED  — the engine drafted the rule from the item's own text
//   CUSTOM        — a hand-authored per-item override (GM or Forge)
//   NOT MODELED   — no entry; dnd5e default behavior stands (the parser
//                   still covers post-hit saves/venoms generically)
//
// Feats are listed only when the engine actually knows them (library /
// drafted / custom) — every class feature showing as a "gap" would be noise,
// since most feats have no rules-engine-relevant behavior at all.
//
// Open from the console:  game.aceQol.openRulesCoverage()
// ──────────────────────────────────────────────────────────────────────────────

import { MODULE_ID } from "../ace-qol.mjs";
import { RulesBrain } from "./rules-brain.mjs";
import { DescriptionParser } from "../description-parser.mjs";

/** Does the general description reader find automatable behavior on this item?
 *  (Post-hit saves, venom fail-damage, sever/on-kill/HP-threshold riders,
 *  effect tables, bonus damage — the wasp-Sting / Mace-of-Smiting class.) */
function _parserCovers(item) {
  try {
    const p = DescriptionParser.parse(item);
    return !!(p?.saves?.length || p?.severRider || p?.onKillRider
      || p?.hpThresholdRider || p?.effectTable || p?.bonusDamage?.length
      || p?.conditions?.length);
  } catch (_) { return false; }
}

export function collectRulesCoverage() {
  const seen = new Map();
  for (const actor of game.actors) {
    for (const it of actor.items) {
      if (!["spell", "weapon", "feat"].includes(it.type)) continue;
      const key = `${it.type}:${RulesBrain.normalizeName(it.name)}`;
      let row = seen.get(key);
      if (!row) {
        // Bucket resolution: per-item override first (drafted vs custom),
        // then the shipped library, then the general READER (parser
        // automation — "not modeled" used to hide this, which read as
        // "does nothing" for fully-automated items; Johnny 2026-07-10),
        // else gap.
        let covered = "gap";
        const flagEntry = it.flags?.[MODULE_ID]?.rulesEntry;
        if (flagEntry) covered = flagEntry.drafted ? "drafted" : "custom";
        else if (RulesBrain.lookup(it, { actor })) covered = "library";
        else if (_parserCovers(it)) covered = "parsed";
        row = { name: it.name, key, type: it.type, covered, actors: 0 };
        seen.set(key, row);
      }
      row.actors++;
    }
  }
  // Feats: engine-known or reader-known only (every class feature listed as
  // a gap would be noise — most feats have no combat automation to track).
  return [...seen.values()].filter(r => r.type !== "feat" || r.covered !== "gap");
}

export async function openRulesCoverage() {
  const rows = collectRulesCoverage();
  const buckets = {
    library: { label: "LIBRARY RULE", color: "#7ec97e", rows: [] },
    drafted: { label: "SELF-LEARNED", color: "#c9a76b", rows: [] },
    custom:  { label: "CUSTOM OVERRIDE", color: "#8fb8e8", rows: [] },
    parsed:  { label: "AUTOMATED BY THE READER (saves, venoms, riders parsed from its text)", color: "#6fb8a8", rows: [] },
    gap:     { label: "GENERIC HANDLING (attack/save/damage pipelines — nothing extra to know)", color: "#9c8f74", rows: [] },
  };
  for (const r of rows) buckets[r.covered]?.rows.push(r);
  for (const b of Object.values(buckets)) b.rows.sort((a, z) => a.name.localeCompare(z.name));

  const covered = rows.length - buckets.gap.rows.length;
  const typeIcon = { spell: "fa-wand-sparkles", weapon: "fa-hand-fist", feat: "fa-star" };

  const sections = Object.values(buckets).map(b => b.rows.length ? `
    <div style="margin-top:10px;">
      <div style="font-weight:700;color:${b.color};font-size:15px;border-bottom:1px solid ${b.color}44;padding-bottom:2px;">
        ${b.label} — ${b.rows.length}
      </div>
      <div style="columns:2;column-gap:18px;margin-top:4px;">
        ${b.rows.map(r => `
          <div style="break-inside:avoid;font-size:14px;padding:1px 0;">
            <i class="fas ${typeIcon[r.type] ?? "fa-circle"}" style="width:16px;color:${b.color};"></i>
            ${foundry.utils.escapeHTML(r.name)}
            <span style="color:#8a7f68;font-size:12px;">×${r.actors}</span>
          </div>`).join("")}
      </div>
    </div>` : "").join("");

  const content = `
    <div style="background:#141118;color:#e8dcc3;border:1px solid #c9a76b;border-radius:8px;padding:12px 14px;max-height:65vh;overflow-y:auto;font-size:16px;">
      <div style="display:flex;justify-content:space-between;align-items:baseline;">
        <span style="font-weight:700;color:#c9a76b;font-size:18px;"><i class="fas fa-brain"></i> Rules Engine Coverage</span>
        <span style="font-size:14px;">${covered}/${rows.length} modeled</span>
      </div>
      <div style="font-size:13px;color:#9c8f74;margin-top:2px;">
        Everything actors in this world carry. "Not modeled" still gets generic handling
        (attack pipeline, parsed venom saves) — these buckets track the rules engine specifically.
      </div>
      ${sections}
    </div>`;

  try {
    await foundry.applications.api.DialogV2.prompt({
      window: { title: "ACE — Rules Engine Coverage", icon: "fas fa-brain" },
      content,
      ok: { label: "Close" },
      position: { width: 720 },
    });
  } catch (_) {
    // DialogV2 unavailable → classic Dialog fallback (same content).
    new Dialog({ title: "ACE — Rules Engine Coverage", content, buttons: { ok: { label: "Close" } } }, { width: 720 }).render(true);
  }
  return rows;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Toolbar button — the brain, right under the ACE Engine grimoire
//  (Johnny 2026-07-10: "a button on the left toolbar so I can push it every
//  once in a while"). Same proven V13 DOM-injection pattern ace-engine uses.
// ─────────────────────────────────────────────────────────────────────────────

export function registerCoverageButton() {
  Hooks.on("renderSceneControls", () => {
    try {
      if (!game.user?.isGM) return;
      _injectCoverageControl();
    } catch (_) {}
  });
  // Controls may already be rendered by the time we register.
  try { if (game.user?.isGM) _injectCoverageControl(); } catch (_) {}
}

function _injectCoverageControl() {
  if (document.querySelector("[data-ace-coverage-control]")) return;

  const mainControls =
    document.querySelector("#scene-controls-layers")           ??  // v13 confirmed
    document.querySelector("#scene-controls menu:first-child") ??
    document.querySelector("#scene-controls ol")               ??
    document.querySelector("#controls .main-controls")         ??  // v12
    document.querySelector("#controls ol")                     ??
    document.querySelector(".main-controls")                   ??
    null;
  if (!mainControls) return;

  const li = document.createElement("li");
  li.setAttribute("data-ace-coverage-control", "1");

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "control ui-control";
  btn.setAttribute("data-tooltip", "ACE — Rules Engine Coverage");
  btn.setAttribute("aria-label", "ACE — Rules Engine Coverage");
  btn.title = "ACE — Rules Engine Coverage";
  btn.style.cssText = "display:flex;align-items:center;justify-content:center;cursor:pointer;padding:0;width:100%;height:100%;";

  const icon = document.createElement("i");
  icon.className = "fas fa-brain";
  icon.style.cssText = "font-size:26px;color:#c9a76b;pointer-events:none;display:block;";

  btn.appendChild(icon);
  li.appendChild(btn);
  btn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    openRulesCoverage();
  });

  mainControls.appendChild(li);
  console.debug("ace-qol | coverage toolbar button injected");
}
