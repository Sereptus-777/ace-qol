// ─── ACE: QOL — Roll Visibility Controls ──────────────────────────────────────
// Controls what players can see about NPC rolls. Filters chat message content
// based on visibility settings — hiding roll totals, formulas, DCs, and
// optionally NPC names from player view.
//
// Visibility modes per roll type:
//   "public"     — Everyone sees full roll details
//   "resultOnly" — Players see Hit/Miss or Pass/Fail, but not the number
//   "gmOnly"     — Only GM sees the roll; players see nothing
//
// All filtering happens at render time — the full data is always stored in
// the message flags for the GM. Players just can't see it.
// ──────────────────────────────────────────────────────────────────────────────

import { MODULE_ID } from "./ace-qol.mjs";
import { QolSettings } from "./settings.mjs";

export class VisibilityEngine {

  // ═══════════════════════════════════════════════════════════════════════════
  //  Hook Registration
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Register the renderChatMessage hook that filters message content
   * based on visibility settings. Should be called once during module ready.
   */
  static registerHooks() {
    Hooks.on("renderChatMessage", (message, html) => {
      VisibilityEngine.filterMessageContent(message, html);
    });

    console.debug(`${MODULE_ID} | Visibility engine hooks registered`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Message Visibility Determination
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Determine the whisper targets and blind flag for a chat message
   * based on the roll type and the actor's NPC status.
   *
   * Call this BEFORE creating a ChatMessage to set its visibility.
   *
   * @param {"attack"|"damage"|"save"|"check"} rollType
   * @param {Actor|null} actor - The actor making the roll
   * @returns {{ whisper: string[], blind: boolean }|{}} Empty object for public rolls
   */
  static getMessageVisibility(rollType, actor) {
    const isNPC = actor?.type === "npc";
    if (!isNPC) return {}; // Player rolls are always fully visible

    let setting = "public";
    try {
      const settingKey = `npc${rollType.charAt(0).toUpperCase() + rollType.slice(1)}Visibility`;
      setting = QolSettings.get(settingKey);
    } catch {
      return {}; // Setting not registered yet — default to public
    }

    switch (setting) {
      case "gmOnly":
        // Only GM sees the entire message
        return {
          whisper: game.users.filter(u => u.isGM).map(u => u.id),
          blind: false,
        };

      case "resultOnly":
        // Message is public but content will be filtered at render time
        // (filterMessageContent handles the masking)
        return {};

      default: // "public"
        return {};
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Content Filtering — renderChatMessage Hook
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Filter a chat message's visible content based on the viewer's role
   * and the visibility settings. Called during the renderChatMessage hook.
   *
   * GM always sees everything. Players see filtered content based on settings.
   *
   * @param {ChatMessage} message
   * @param {HTMLElement|jQuery} html
   */
  static filterMessageContent(message, html) {
    // Only filter our own messages (ones with ace-qol flags)
    const flags = message.flags?.[MODULE_ID];
    if (!flags?.type) return;

    const el = html instanceof HTMLElement ? html : html?.[0] ?? html;
    if (!el?.querySelector) return;

    // GM branch: hide PLAYER-ONLY flavor elements (the GM doesn't need a
    // discovery hint — they already see the IMMUNE / RESIST / VULN truth
    // badges and know the target's defensive profile). Keep everything else.
    if (game.user.isGM) {
      try {
        for (const node of el.querySelectorAll(".ace-qol-dmg-flavor-hint")) {
          node.style.display = "none";
        }
        for (const node of el.querySelectorAll(".ace-qol-dmg-player-only")) {
          node.style.display = "none";
        }
      } catch (err) {
        console.warn(`${MODULE_ID} | GM-only player-element hide failed:`, err);
      }
      return;
    }

    // ── Determine if the source actor is an NPC ──
    const actorId = flags.actorId;
    let isNPC = false;
    if (actorId) {
      const actor = game.actors?.get(actorId);
      isNPC = actor?.type === "npc";
    }
    // If no actor ID or can't resolve, check message speaker
    if (!actorId) {
      const speakerActor = game.actors?.get(message.speaker?.actor);
      isNPC = speakerActor?.type === "npc";
    }

    // ── Truth-only stripping ALWAYS runs (regardless of NPC status) ──
    // A player attacking an NPC produces a damage card whose source actor is
    // the PLAYER. We still need to hide the IMMUNE/RESIST/VULN badges from
    // OTHER players so they can't see the target's resistance profile.
    // This needs to happen before the NPC-only short-circuit below.
    try {
      VisibilityEngine._hideTruthOnly(el);
    } catch (err) {
      console.warn(`${MODULE_ID} | Truth-only filter failed:`, err);
    }

    // Only the broader NPC-roll filtering (hide totals, mask DCs, etc.)
    // requires the source to be an NPC. Skip the rest for player rolls.
    if (!isNPC) return;

    // ── Apply filters based on message type and settings ──
    try {
      switch (flags.type) {
        case "attackResult":
          VisibilityEngine._filterAttackCard(el);
          break;
        case "damageResult":
        case "damageButton":
          VisibilityEngine._filterDamageCard(el);
          break;
        case "postHitSave":
        case "postHitSaveResult":
          VisibilityEngine._filterSaveCard(el);
          break;
      }

      // ── Hide NPC names if configured ──
      VisibilityEngine._filterNPCNames(el, flags);

      // (Truth-only stripping was already applied at the top of this method
      // — see the comment above the early NPC-return.)

    } catch (err) {
      console.warn(`${MODULE_ID} | Visibility filter failed:`, err);
    }
  }

  /**
   * Strip GM-truth elements from a player's view. Two passes:
   *   1. `.ace-qol-dmg-truth-only` → display:none on individual badges/spans
   *   2. `.ace-qol-dmg-truth-row` → display:none on entire damage rows
   *      (used for IMMUNE rows so players don't see "0 cold" lines that
   *      would confirm the resistance profile)
   *
   * The flavor hint added to per-target rows (`.ace-qol-dmg-flavor-hint`)
   * is intentionally NOT hidden — it's the in-fiction substitute for the
   * truth badges and gives players a discovery prompt.
   */
  static _hideTruthOnly(el) {
    if (!el?.querySelectorAll) return;
    for (const node of el.querySelectorAll(".ace-qol-dmg-truth-only")) {
      node.style.display = "none";
    }
    for (const row of el.querySelectorAll(".ace-qol-dmg-truth-row")) {
      row.style.display = "none";
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Attack Card Filtering
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Filter attack result cards for non-GM players.
   * In "resultOnly" mode: hide roll total and formula, keep Hit/Miss labels.
   * In "gmOnly" mode: the message is already whispered (won't reach here).
   */
  static _filterAttackCard(el) {
    let visibility = "public";
    try { visibility = QolSettings.get("npcAttackVisibility"); } catch (err) { console.debug("ace-qol | VisibilityEngine._filterAttackCard setting read:", err); return; }

    if (visibility === "public") return;

    if (visibility === "resultOnly") {
      // Replace the roll total with "???"
      const totals = el.querySelectorAll(".ace-qol-atk-total");
      for (const total of totals) {
        total.textContent = "???";
        total.classList.remove("ace-qol-result-hit", "ace-qol-result-crit", "ace-qol-result-miss");
        total.style.color = "#888";
      }

      // Hide the formula breakdown (d20 result, modifiers)
      const formulas = el.querySelectorAll(".ace-qol-atk-formula");
      for (const formula of formulas) {
        formula.style.display = "none";
      }

      // Hide AC values — players shouldn't see NPC AC in this mode
      const acLabels = el.querySelectorAll(".ace-qol-atk-ac");
      for (const ac of acLabels) {
        ac.textContent = "AC ???";
      }

      // Keep the Hit/Miss/Crit/Fumble labels visible
      // (these are the .ace-qol-atk-result elements — leave them alone)

      // Hide combat state tags (advantage sources, conditions, etc.)
      const tags = el.querySelectorAll(".ace-qol-atk-tags");
      for (const tagGroup of tags) {
        tagGroup.style.display = "none";
      }

      // Hide roll mode indicator (ADV/DISADV)
      const rollModes = el.querySelectorAll(".ace-qol-roll-mode");
      for (const rm of rollModes) {
        rm.style.display = "none";
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Damage Card Filtering
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Filter damage result cards for non-GM players.
   * In "resultOnly" mode: hide specific damage numbers, show type labels only.
   */
  static _filterDamageCard(el) {
    let visibility = "public";
    try { visibility = QolSettings.get("npcDamageVisibility"); } catch (err) { console.debug("ace-qol | VisibilityEngine._filterDamageCard setting read:", err); return; }

    if (visibility === "public") return;

    if (visibility === "resultOnly") {
      // Hide all damage totals
      const dmgTotals = el.querySelectorAll(
        ".ace-qol-dmg-total, .ace-qol-dmg-type-total, .ace-qol-dmg-grand-total"
      );
      for (const total of dmgTotals) {
        total.textContent = "???";
        total.style.color = "#888";
      }

      // Hide dice formulas
      const formulas = el.querySelectorAll(".ace-qol-dmg-formula, .ace-qol-dmg-dice");
      for (const formula of formulas) {
        formula.style.display = "none";
      }

      // Hide per-target HP changes
      const hpElements = el.querySelectorAll(
        ".ace-qol-dmg-hp, .ace-qol-dmg-applied, .ace-qol-dmg-hp-change"
      );
      for (const hp of hpElements) {
        hp.style.display = "none";
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Save Card Filtering
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Filter saving throw cards for non-GM players.
   * Optionally hides the save DC.
   */
  static _filterSaveCard(el) {
    let saveVisibility = "public";
    try { saveVisibility = QolSettings.get("npcSaveVisibility"); } catch { /* default */ }

    // ── Hide save DC if configured ──
    let hideDC = false;
    try { hideDC = QolSettings.get("hideSaveDC"); } catch { /* default false */ }

    if (hideDC) {
      const dcElements = el.querySelectorAll(
        ".ace-qol-save-dc, [data-save-dc]"
      );
      for (const dc of dcElements) {
        // Replace "DC 15" with "DC ???"
        dc.textContent = dc.textContent.replace(/DC\s*\d+/gi, "DC ???");
      }
    }

    if (saveVisibility === "resultOnly") {
      // Hide roll totals on save cards
      const saveTotals = el.querySelectorAll(".ace-qol-save-total, .ace-qol-save-roll");
      for (const total of saveTotals) {
        total.textContent = "???";
        total.style.color = "#888";
      }

      // Hide modifiers/formula
      const formulas = el.querySelectorAll(".ace-qol-save-formula, .ace-qol-save-mods");
      for (const formula of formulas) {
        formula.style.display = "none";
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  NPC Name Hiding
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Replace NPC names with "???" in chat cards if hideNPCNames is enabled.
   * This prevents metagaming by hiding creature identity.
   */
  static _filterNPCNames(el, flags) {
    let hideNames = false;
    try { hideNames = QolSettings.get("hideNPCNames"); } catch (err) { console.debug("ace-qol | VisibilityEngine._filterNPCNames setting read:", err); return; }

    if (!hideNames) return;

    // ── Replace NPC names in target rows ──
    const nameElements = el.querySelectorAll(".ace-qol-atk-name, .ace-qol-dmg-name, .ace-qol-save-name");
    for (const nameEl of nameElements) {
      nameEl.textContent = "???";
    }

    // ── Replace NPC images with mystery man ──
    const imgElements = el.querySelectorAll(
      ".ace-qol-atk-img, .ace-qol-dmg-img, .ace-qol-save-img"
    );
    for (const img of imgElements) {
      img.src = "icons/svg/mystery-man.svg";
    }

    // ── Replace the item header name if it reveals the NPC ──
    // (e.g., "Goblin's Scimitar" → leave as-is since it's the weapon name)
    // We only hide actor names, not item names
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Utility — Pre-create Message Modifier
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Apply visibility settings to a message data object before creation.
   * Call this in the attack/damage/save engines before ChatMessage.create().
   *
   * @param {object} messageData - The data object for ChatMessage.create()
   * @param {"attack"|"damage"|"save"|"check"} rollType
   * @param {Actor|null} actor
   * @returns {object} Modified messageData with whisper/blind set
   */
  static applyVisibility(messageData, rollType, actor) {
    const vis = VisibilityEngine.getMessageVisibility(rollType, actor);
    if (vis.whisper) messageData.whisper = vis.whisper;
    if (vis.blind !== undefined) messageData.blind = vis.blind;
    return messageData;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  API Registration
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Register public API methods on game.aceQol.
   */
  static registerAPI() {
    if (!game.aceQol) return;

    game.aceQol.VisibilityEngine = VisibilityEngine;
    game.aceQol.getMessageVisibility = VisibilityEngine.getMessageVisibility;

    console.debug(`${MODULE_ID} | Visibility engine API registered (game.aceQol.VisibilityEngine)`);
  }
}
