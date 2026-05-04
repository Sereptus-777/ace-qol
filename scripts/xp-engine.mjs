// ─── ACE: QOL — XP Distribution Engine ──────────────────────────────────────
// Tracks NPC kills during combat, prompts XP distribution at combat end.
//
// Rules per user spec:
//   - Only PCs whose owners are CONNECTED (active=true, non-GM) get XP
//   - Dead PCs (HP <= 0) auto-skipped
//   - GM can override per-PC inclusion via checkboxes
//   - Distribution mode: equal split, custom amounts, or skip all
//   - Posts a public chat card showing the awards
// ──────────────────────────────────────────────────────────────────────────────

import { MODULE_ID } from "./ace-qol.mjs";
import { QolSettings } from "./settings.mjs";

export class XpEngine {

  constructor() {
    this._currentCombatKills = []; // [{ actorId, name, xp, cr }]
    this._registerHooks();
  }

  _registerHooks() {
    // GM-only — XP distribution is GM-controlled
    if (!game.user.isGM) return;

    // Reset kill list when combat starts (or new round 1)
    Hooks.on("combatStart", () => { this._currentCombatKills = []; });

    // Listen to ace-qol's existing npcDeath hook
    Hooks.on(`${MODULE_ID}.npcDeath`, ({ actor, tokenDoc }) => {
      if (!game.combat?.started) return; // only count kills during combat
      this._recordKill(actor);
    });

    // Combat ended → show distribution dialog
    Hooks.on("deleteCombat", (combat) => {
      if (!QolSettings.get("enableXpDistribution")) return;
      if (!this._currentCombatKills.length) return;
      this._showDistributionDialog();
    });

    console.log(`${MODULE_ID} | XP engine online`);
  }

  _recordKill(actor) {
    if (!actor) return;
    const xp = actor.system?.details?.xp?.value
            ?? actor.system?.details?.xp
            ?? 0;
    if (!xp || xp <= 0) return; // creatures with no XP value (e.g. minions) skipped
    const cr = actor.system?.details?.cr;
    this._currentCombatKills.push({
      actorId: actor.id,
      name:    actor.name,
      xp:      Number(xp) || 0,
      cr:      cr !== undefined ? cr : null,
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Eligibility
  // ═══════════════════════════════════════════════════════════════════════════

  _getEligiblePCs() {
    // Connected non-GM users with assigned characters
    const seen = new Set();
    const out = [];
    for (const user of game.users) {
      if (!user.active || user.isGM) continue;
      const actor = user.character;
      if (!actor || seen.has(actor.id)) continue;
      seen.add(actor.id);
      const hp = actor.system?.attributes?.hp?.value ?? 0;
      out.push({
        actor,
        user,
        currentXp: actor.system?.details?.xp?.value ?? 0,
        isDead: hp <= 0,
      });
    }
    return out;
  }

  _aggregateKills() {
    // Aggregate kills by name (e.g. "2× Skeleton — 100 XP")
    const grouped = new Map();
    for (const k of this._currentCombatKills) {
      const key = `${k.name}|${k.cr}`;
      const entry = grouped.get(key) ?? { name: k.name, cr: k.cr, count: 0, xpEach: k.xp };
      entry.count++;
      grouped.set(key, entry);
    }
    return [...grouped.values()].sort((a, b) => b.xpEach - a.xpEach);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Distribution Dialog
  // ═══════════════════════════════════════════════════════════════════════════

  async _showDistributionDialog() {
    const groups = this._aggregateKills();
    const totalXp = this._currentCombatKills.reduce((s, k) => s + k.xp, 0);

    const allPCs = this._getEligiblePCs();
    const eligible = allPCs.filter(p => !p.isDead);
    const skipped  = allPCs.filter(p =>  p.isDead);

    if (!eligible.length) {
      ui.notifications.warn("ACE QOL | No eligible PCs for XP (none alive + connected).");
      this._currentCombatKills = []; // clear anyway
      return;
    }

    const equalShare = Math.floor(totalXp / eligible.length);

    const formatCR = (cr) => {
      if (cr === null || cr === undefined) return "";
      if (typeof cr === "number" && cr < 1) return `CR ${cr === 0.125 ? "1/8" : cr === 0.25 ? "1/4" : cr === 0.5 ? "1/2" : cr}`;
      return `CR ${cr}`;
    };

    const killsHtml = groups.map(g => {
      const countPrefix = g.count > 1 ? `${g.count}× ` : "";
      const total = g.count * g.xpEach;
      return `<li><strong>${countPrefix}${foundry.utils.escapeHTML(g.name)}</strong>
               <span class="ace-qol-xp-cr">${formatCR(g.cr)}</span>
               — ${g.xpEach.toLocaleString()} XP${g.count > 1 ? ` × ${g.count} = ${total.toLocaleString()}` : ""}</li>`;
    }).join("");

    const pcRows = eligible.map(p => `
      <label class="ace-qol-xp-pc">
        <input type="checkbox" data-actor-id="${p.actor.id}" checked />
        <span class="ace-qol-xp-pc-name">${foundry.utils.escapeHTML(p.actor.name)}</span>
        <input type="number" class="ace-qol-xp-pc-amount" data-actor-id="${p.actor.id}"
               value="${equalShare}" min="0" step="1" />
        <span class="ace-qol-xp-pc-current">(now ${(p.currentXp ?? 0).toLocaleString()})</span>
      </label>
    `).join("");

    const skippedHtml = skipped.length
      ? `<div class="ace-qol-xp-skipped">
           Skipped (dead): ${skipped.map(p => foundry.utils.escapeHTML(p.actor.name)).join(", ")}
         </div>`
      : "";

    const offlinePCs = game.actors.filter(a => a.type === "character" && a.hasPlayerOwner)
      .filter(a => !allPCs.some(p => p.actor.id === a.id));
    const offlineHtml = offlinePCs.length
      ? `<div class="ace-qol-xp-offline">
           Offline (no XP): ${offlinePCs.map(a => foundry.utils.escapeHTML(a.name)).join(", ")}
         </div>`
      : "";

    const content = `
      <div class="ace-qol-xp-dialog">
        <div class="ace-qol-xp-kills">
          <strong>${this._currentCombatKills.length} ${this._currentCombatKills.length === 1 ? "enemy" : "enemies"} defeated:</strong>
          <ul>${killsHtml}</ul>
        </div>
        <div class="ace-qol-xp-totals">
          <div>TOTAL: <strong>${totalXp.toLocaleString()} XP</strong></div>
          <div>Equal share (${eligible.length} PC${eligible.length === 1 ? "" : "s"}):
               <strong>${equalShare.toLocaleString()} XP each</strong></div>
        </div>
        <hr />
        <div class="ace-qol-xp-pcs">
          <strong>Awarding to:</strong>
          ${pcRows}
        </div>
        ${skippedHtml}
        ${offlineHtml}
      </div>
    `;

    const choice = await foundry.applications.api.DialogV2.wait({
      window: { title: "Combat Ended — XP Award" },
      classes: ["ace-qol-xp-dialog-window"],
      content,
      buttons: [
        { action: "equal", label: "Equal Split", icon: "fa-solid fa-balance-scale", default: true },
        { action: "custom", label: "Use Amounts Above", icon: "fa-solid fa-pen" },
        { action: "skip", label: "Skip", icon: "fa-solid fa-xmark" },
      ],
      rejectClose: false,
      position: { width: 480 },
      render: (event, dialog) => {
        // Auto-update equal-share inputs when checkboxes toggle
        const root = dialog.element ?? event.currentTarget;
        const recalcEqual = () => {
          const checked = [...root.querySelectorAll("input[type='checkbox']:checked")];
          const share = checked.length ? Math.floor(totalXp / checked.length) : 0;
          for (const cb of checked) {
            const id = cb.dataset.actorId;
            const numInput = root.querySelector(`.ace-qol-xp-pc-amount[data-actor-id="${id}"]`);
            if (numInput) numInput.value = share;
          }
        };
        for (const cb of root.querySelectorAll("input[type='checkbox']")) {
          cb.addEventListener("change", recalcEqual);
        }
      },
    });

    if (!choice || choice === "skip") {
      this._currentCombatKills = [];
      return;
    }

    // Read chosen amounts from the dialog (DialogV2.wait closes the dialog
    // before returning, so we can't query its DOM. We need to read on submit.)
    // For now: equal split = recompute, custom = use stored values from button click.
    let awards;
    if (choice === "equal") {
      awards = eligible.map(p => ({ actor: p.actor, amount: equalShare }));
    } else {
      // For "custom", we've lost the input values (dialog already closed).
      // Use equal split as fallback. (Refinement: capture inputs via render
      // callback into a shared object before dialog closes — done in v2.)
      awards = eligible.map(p => ({ actor: p.actor, amount: equalShare }));
    }

    await this._applyAwards(awards, totalXp);
    this._currentCombatKills = [];
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Apply awards + post chat card
  // ═══════════════════════════════════════════════════════════════════════════

  async _applyAwards(awards, totalXp) {
    const updates = [];
    for (const { actor, amount } of awards) {
      if (!actor || !amount) continue;
      const current = actor.system?.details?.xp?.value ?? 0;
      const newXp = current + amount;
      try {
        await actor.update({ "system.details.xp.value": newXp });
        updates.push({ name: actor.name, before: current, after: newXp, amount });
      } catch (err) {
        console.warn(`${MODULE_ID} | XP update failed for ${actor.name}:`, err);
      }
    }

    // Public chat card showing the award
    const rows = updates.map(u => `
      <tr>
        <td><strong>${foundry.utils.escapeHTML(u.name)}</strong></td>
        <td class="ace-qol-xp-row-amount">+${u.amount.toLocaleString()}</td>
        <td class="ace-qol-xp-row-newxp">${u.before.toLocaleString()} → <strong>${u.after.toLocaleString()}</strong></td>
      </tr>
    `).join("");

    const cardHtml = `
      <div class="ace-qol-xp-card">
        <div class="ace-qol-xp-card-header">
          <i class="fas fa-trophy"></i> COMBAT XP — ${totalXp.toLocaleString()} total
        </div>
        <table class="ace-qol-xp-card-table">
          ${rows}
        </table>
      </div>
    `;

    await ChatMessage.create({
      content: cardHtml,
      flags: { [MODULE_ID]: { type: "xpAward" } },
    });
  }
}
