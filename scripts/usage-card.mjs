// ─── ACE: QOL — Activity Usage Card ───────────────────────────────────────────
// TWO jobs, one module (Johnny 2026-07-27):
//
//   1. dnd5e's item-usage card NEVER EXISTS. Not "hidden" — never created.
//      The old approach hid it at render time with display:none, which left a
//      ghost <li> in the log and, worse, lived ~3900 lines deep inside the one
//      giant Hooks.once("ready") callback in ace-qol.mjs — anything throwing
//      earlier in that block silently took the suppression down with it. This
//      module registers at INIT, in its own file, insulated from all of that.
//
//      dnd5e gives us a supported opt-out: `dnd5e.preCreateUsageMessage` fires
//      with the message config, and Activity#_createUsageMessage then does
//          messageConfig.create === false ? messageConfig.data : ChatMessage.create(...)
//      so flipping `create` to false means the document is never written. No
//      document, no render, no hook-ordering race, no leftover row.
//
//   2. ACE posts its OWN usage card for every activity ACE doesn't already
//      card. Attack / damage / save / heal already have purpose-built ACE
//      cards; utility, cast, summon, enchant, check and transform had NOTHING,
//      so suppressing dnd5e left those actions completely silent in chat
//      (Aerial Ascension being the case that surfaced it). Now they get a real
//      ACE card: item art, activity name, what it spent, what's left, and the
//      description under a chevron.
//
//   ACE's card carries dnd5e's own `messageFlags` (activity / item / targets)
//   so third-party consumers that anchor off the usage message — Automated
//   Animations especially — still find everything they look for.
// ──────────────────────────────────────────────────────────────────────────────

import { MODULE_ID }   from "./ace-qol.mjs";
import { QolSettings } from "./settings.mjs";

export class UsageCard {

  /** Activity types that ALREADY have a purpose-built ACE card. */
  static CARDED_ELSEWHERE = new Set(["attack", "damage", "save", "heal"]);

  /**
   * Activity types whose dnd5e usage card MUST survive — it isn't chrome, it's
   * the mechanism. `enchant` is the only one in dnd5e 5.x: EnchantActivity is
   * the sole class that overrides `onRenderChatCard`, injecting the drop-target
   * UI you drag an item onto to apply the enchantment, and it anchors the
   * enchantment's origin to that message (`chatMessage: results.message`, and
   * `delete({ chatMessageOrigin: results.message?.id })` to remove it). Suppress
   * that card and enchantments simply stop working. Verified against the
   * installed dnd5e 5.x source, not assumed. (2026-07-27)
   */
  static KEEP_SYSTEM_CARD = new Set(["enchant"]);

  /** activity uuid → timestamp, so a re-fire can't post the card twice. */
  static _recent = new Map();

  // ═══════════════════════════════════════════════════════════════════════════
  //  Wiring
  // ═══════════════════════════════════════════════════════════════════════════

  static init() {
    // ── (1) dnd5e's usage card is never created ──
    Hooks.on("dnd5e.preCreateUsageMessage", (activity, messageConfig) => {
      try {
        if (QolSettings.get("suppressSystemCards") === false) return;
        if (UsageCard.KEEP_SYSTEM_CARD.has(activity?.type)) return;  // the card IS the feature
        messageConfig.create = false;
      } catch (_) { /* never block the use over this */ }
    });

    // ── (2) ACE's own usage card ──
    Hooks.on("dnd5e.postUseActivity", (activity) => {
      try { UsageCard._maybePost(activity); } catch (err) {
        console.warn(`${MODULE_ID} | usage card failed (the action itself still ran):`, err);
      }
    });

    // ── (3) Belt to the braces: hide any OTHER dnd5e system card that still
    //        renders (roll cards, anything a third party posts with dnd5e
    //        flags). Relocated here from ~line 4960 of ace-qol.mjs, where it
    //        was buried inside the giant ready callback — see the note there. ──
    const hideSystemCard = (message, html) => {
      try {
        if (!message?.flags?.dnd5e) return;             // only dnd5e system cards
        if (message.flags?.[MODULE_ID]?.type) return;   // ACE's own cards always show — they carry a .type; dnd5e's never do
        if (QolSettings.get("suppressSystemCards") === false) return;
        // Enchant cards are the enchantment UI itself — never hide them, or the
        // player has nothing to drop the item onto. (See KEEP_SYSTEM_CARD.)
        if (UsageCard.KEEP_SYSTEM_CARD.has(message.flags.dnd5e?.activity?.type)) return;
        const el = html instanceof HTMLElement ? html : html?.[0] ?? html;
        if (!el || el.dataset?.aceHidden) return;
        el.style.display = "none";
        el.dataset.aceHidden = "1";
      } catch (_) { /* non-fatal */ }
    };
    Hooks.on("renderChatMessageHTML", hideSystemCard);
    Hooks.on("renderChatMessage", hideSystemCard);

    // ── (4) Description chevron ──
    const wire = (message, html) => {
      if (message?.flags?.[MODULE_ID]?.type !== "activityUse") return;
      const el = html instanceof HTMLElement ? html : html?.[0] ?? html;
      const toggle = el?.querySelector?.(".ace-qol-use-desc-toggle");
      if (!toggle || toggle.dataset.aceWired) return;
      toggle.dataset.aceWired = "1";
      toggle.addEventListener("click", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        const body = el.querySelector(".ace-qol-use-desc-body");
        if (!body) return;
        const open = body.classList.toggle("ace-qol-use-open");
        toggle.setAttribute("aria-expanded", String(open));
        const icon = toggle.querySelector("i");
        if (icon) {
          icon.classList.toggle("fa-chevron-right", !open);
          icon.classList.toggle("fa-chevron-down", open);
        }
      });
    };
    Hooks.on("renderChatMessageHTML", wire);
    Hooks.on("renderChatMessage", wire);

    console.debug(`${MODULE_ID} | Usage Card online — dnd5e usage cards are never created; ACE cards every uncarded activity`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Decide + post
  // ═══════════════════════════════════════════════════════════════════════════

  static async _maybePost(activity) {
    if (QolSettings.get("suppressSystemCards") === false) return;  // dnd5e's own card is showing — don't double up
    if (!activity?.item) return;
    if (UsageCard.CARDED_ELSEWHERE.has(activity.type)) return;     // attack/save/heal/damage card is coming
    if (UsageCard.KEEP_SYSTEM_CARD.has(activity.type)) return;     // dnd5e's card survived — don't double up

    // Cancel-and-refire (attack choke point, consumption prompt) can run the
    // same activity twice in quick succession — only card it once.
    const now  = Date.now();
    const last = UsageCard._recent.get(activity.uuid) ?? 0;
    if (now - last < 1500) return;
    UsageCard._recent.set(activity.uuid, now);
    if (UsageCard._recent.size > 40) {
      for (const [k, t] of UsageCard._recent) if (now - t > 10000) UsageCard._recent.delete(k);
    }

    const item  = activity.item;
    const actor = item.actor;
    const content = await UsageCard._build(activity, item, actor);

    await ChatMessage.create({
      user:    game.user.id,
      speaker: ChatMessage.getSpeaker({ actor, token: actor?.token }),
      content,
      flags: {
        // dnd5e's own usage flags, so Automated Animations and friends still
        // find the item/activity/targets they anchor off.
        dnd5e: activity.messageFlags ?? {},
        [MODULE_ID]: {
          type:         "activityUse",
          activityUuid: activity.uuid,
          itemUuid:     item.uuid,
          actorUuid:    actor?.uuid,
        },
      },
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Card HTML
  // ═══════════════════════════════════════════════════════════════════════════

  static async _build(activity, item, actor) {
    const esc = foundry.utils.escapeHTML;

    const itemName = esc(item.name ?? "Item");
    const actName  = esc(activity.name || UsageCard._typeLabel(activity.type));
    const img      = item.img || "icons/svg/item-bag.svg";

    const chips = UsageCard._chips(activity, item);
    const chipsHtml = chips.length
      ? `<div class="ace-qol-use-chips">${chips.map(c =>
          `<span class="ace-qol-use-chip ${c.cls}"><i class="fas ${c.icon}"></i>${esc(c.text)}</span>`
        ).join("")}</div>`
      : "";

    const descHtml = await UsageCard._description(activity, item, actor);

    return `
      <div class="ace-qol-use-card" data-item-uuid="${item.uuid}">
        <div class="ace-qol-use-header">
          <img class="ace-qol-use-icon" src="${img}" alt="" onerror="this.style.display='none'">
          <div class="ace-qol-use-titles">
            <span class="ace-qol-use-item">${itemName}</span>
            <span class="ace-qol-use-activity">${actName}</span>
          </div>
        </div>
        ${chipsHtml}
        ${descHtml}
      </div>
    `;
  }

  /** Plain-English label when an activity has no name of its own. */
  static _typeLabel(type) {
    switch (type) {
      case "utility":   return "Used";
      case "cast":      return "Cast";
      case "summon":    return "Summon";
      case "enchant":   return "Enchant";
      case "check":     return "Ability Check";
      case "transform": return "Transform";
      case "order":     return "Order";
      case "forward":   return "Activated";
      default:          return "Activated";
    }
  }

  /**
   * The status line: what it spent, what's left, spell level, range.
   * Runs AFTER consumption (postUseActivity), so item uses already reflect
   * the spend — that's exactly the number the player wants to see.
   */
  static _chips(activity, item) {
    const chips = [];

    // ── What it cost, and what's left ──
    for (const t of (activity.consumption?.targets ?? [])) {
      const cost = Number(t?.value ?? 0);
      if (!Number.isFinite(cost) || cost === 0) continue;

      if (t.type === "itemUses") {
        const uses = item.system?.uses ?? {};
        const left = Number(uses.value ?? NaN);
        const max  = Number(uses.max ?? NaN);
        let text = `${cost} charge${cost === 1 ? "" : "s"} spent`;
        if (Number.isFinite(left)) {
          text += Number.isFinite(max) ? ` · ${left} of ${max} left` : ` · ${left} left`;
        }
        chips.push({ icon: "fa-bolt", cls: "ace-qol-use-chip-cost", text });
      } else if (t.type === "activityUses") {
        const uses = activity.uses ?? {};
        const left = Number(uses.value ?? NaN);
        let text = `${cost} use${cost === 1 ? "" : "s"} spent`;
        if (Number.isFinite(left)) text += ` · ${left} left`;
        chips.push({ icon: "fa-bolt", cls: "ace-qol-use-chip-cost", text });
      } else if (t.type === "spellSlots") {
        chips.push({ icon: "fa-star", cls: "ace-qol-use-chip-cost", text: `${cost} spell slot${cost === 1 ? "" : "s"}` });
      } else if (t.type === "attribute") {
        chips.push({ icon: "fa-droplet", cls: "ace-qol-use-chip-cost", text: `${cost} ${String(t.target ?? "resource")}` });
      }
    }

    // ── Spell level ──
    const lvl = Number(item.system?.level ?? NaN);
    if (item.type === "spell" && Number.isFinite(lvl)) {
      chips.push({
        icon: "fa-hat-wizard",
        cls:  "ace-qol-use-chip-info",
        text: lvl === 0 ? "Cantrip" : `Level ${lvl}`,
      });
    }

    // ── Range ──
    const range = activity.range ?? {};
    if (range.units === "touch")     chips.push({ icon: "fa-hand", cls: "ace-qol-use-chip-info", text: "Touch" });
    else if (range.units === "self") chips.push({ icon: "fa-user", cls: "ace-qol-use-chip-info", text: "Self" });
    else if (Number(range.value) > 0) {
      chips.push({ icon: "fa-ruler", cls: "ace-qol-use-chip-info", text: `${range.value} ${range.units || "ft"}` });
    }

    return chips;
  }

  /** Description under a chevron — collapsed by default so the card stays small. */
  static async _description(activity, item, actor) {
    let raw = activity.description?.chatFlavor || item.system?.description?.value || "";
    raw = String(raw).trim();
    if (!raw) return "";

    let enriched = raw;
    try {
      const TE = foundry.applications?.ux?.TextEditor?.implementation ?? globalThis.TextEditor;
      if (TE?.enrichHTML) {
        enriched = await TE.enrichHTML(raw, {
          rollData:   activity.getRollData?.() ?? actor?.getRollData?.() ?? {},
          relativeTo: item,
          secrets:    false,
        });
      }
    } catch (_) { /* fall back to the raw text */ }

    return `
      <div class="ace-qol-use-desc">
        <button type="button" class="ace-qol-use-desc-toggle" aria-expanded="false">
          <i class="fas fa-chevron-right"></i><span>Description</span>
        </button>
        <div class="ace-qol-use-desc-body">${enriched}</div>
      </div>
    `;
  }
}
