// ─── ACE: QOL — Activity Use Prompt ───────────────────────────────────────────
// ACE owns EVERY pause. dnd5e's "Consume Item Use?" usage dialog is the last
// piece of system chrome that still appeared on a player's screen; this
// replaces it with ACE's own prompt, using the same cancel-and-refire pattern
// the attack choke point and the engagement gate already use:
//
//   preUseActivity → cancel → ACE prompt → re-fire with { configure: false }
//
// The re-fire carries the user's choice (spend the charges or use them free)
// and is marked so it passes straight through instead of prompting again.
//
// Only fires when the activity ACTUALLY consumes something — a plain utility
// with no cost never gets an extra click. (Johnny 2026-07-27.)
// ──────────────────────────────────────────────────────────────────────────────

import { MODULE_ID } from "./ace-qol.mjs";

export class ActivityUsePrompt {

  /** Activity uuids currently being re-fired by us — pass straight through. */
  static _refiring = new Set();

  /** itemUuid → consume decision already made on ACE's activity picker.
   *  ONE dialog does the whole job (Johnny 2026-07-27: the consume toggle is a
   *  check mark on the ability list, not a second pop-up), so when the picker
   *  has already answered we suppress dnd5e's dialog and never ask again. */
  static _preset = new Map();

  static presetConsume(itemUuid, consume) {
    if (!itemUuid) return;
    ActivityUsePrompt._preset.set(itemUuid, !!consume);
    // Short-lived: it belongs to THIS click, not the next one.
    setTimeout(() => ActivityUsePrompt._preset.delete(itemUuid), 8000);
  }

  static init() {
    Hooks.on("dnd5e.preUseActivity", (activity, usageConfig, dialogConfig, messageConfig) => {
      try {
        const uuid = activity?.uuid;
        if (!uuid) return;

        // Our own re-fire — consume the marker and let it run.
        if (ActivityUsePrompt._refiring.has(uuid)) {
          ActivityUsePrompt._refiring.delete(uuid);
          return;
        }

        // Someone upstream already suppressed the dialog — respect that.
        if (dialogConfig?.configure === false) return;

        // ACE's activity picker already asked (its consume check mark) — honour
        // that answer, suppress dnd5e's dialog, and don't ask twice.
        const itemUuid = activity.item?.uuid;
        if (itemUuid && ActivityUsePrompt._preset.has(itemUuid)) {
          const consume = ActivityUsePrompt._preset.get(itemUuid);
          ActivityUsePrompt._preset.delete(itemUuid);
          if (dialogConfig) dialogConfig.configure = false;
          if (consume === false && usageConfig) usageConfig.consume = false;
          return;
        }

        const spend = ActivityUsePrompt._describeCost(activity);
        if (!spend) return;   // nothing consumed → no prompt, no interruption

        ActivityUsePrompt._promptThenRefire(activity, usageConfig, messageConfig, spend);
        return false;         // cancel this use; the re-fire carries the choice
      } catch (err) {
        console.warn(`${MODULE_ID} | activity use prompt failed — dnd5e's own dialog stands:`, err);
      }
    });

    console.debug(`${MODULE_ID} | Activity Use Prompt online — ACE owns the consumption dialog`);
  }

  /** What does this activity cost? null when it consumes nothing. */
  static _describeCost(activity) {
    try {
      const targets = activity?.consumption?.targets ?? [];
      if (!targets.length) return null;
      const t = targets[0];
      const cost = Number(t?.value ?? 0);
      if (!Number.isFinite(cost) || cost === 0) return null;

      const item = activity.item;
      let available = null;
      let max = null;
      let label = "uses";
      switch (t.type) {
        case "itemUses":
          available = Number(item?.system?.uses?.value ?? NaN);
          max       = Number(item?.system?.uses?.max ?? NaN);
          label = "charges";
          break;
        case "activityUses":
          available = Number(activity?.uses?.value ?? NaN);
          max       = Number(activity?.uses?.max ?? NaN);
          break;
        case "spellSlots":
          label = "spell slots";
          break;
        case "attribute":
          label = String(t.target ?? "uses");
          break;
        default:
          label = "uses";
      }
      return {
        cost,
        available: Number.isFinite(available) ? available : null,
        // The MAXIMUM, so the prompt can say "3 of 5 left". Without it the line
        // printed the available count twice and always read "5 of 5 left",
        // however many had been spent. (Johnny 2026-07-29.)
        max: Number.isFinite(max) && max > 0 ? max : null,
        label,
      };
    } catch (_) { return null; }
  }

  /**
   * A short, readable blurb for the prompt — the activity's own chat flavour if
   * it has one, otherwise the item's description. Trimmed to a couple of lines
   * so the dialog stays a decision, not a wall of rules text.
   */
  static async _summary(activity) {
    try {
      let raw = activity?.description?.chatFlavor
             || activity?.item?.system?.description?.value
             || "";
      raw = String(raw).trim();
      if (!raw) return "";
      const TE = foundry.applications?.ux?.TextEditor?.implementation ?? globalThis.TextEditor;
      if (TE?.enrichHTML) {
        raw = await TE.enrichHTML(raw, {
          rollData:   activity.getRollData?.() ?? {},
          relativeTo: activity.item,
          secrets:    false,
        });
      }
      // Strip to plain text and cap it — the full text lives on the item.
      const text = String(raw).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      return text.length > 240 ? text.slice(0, 237).trimEnd() + "…" : text;
    } catch (_) { return ""; }
  }

  static async _promptThenRefire(activity, usageConfig, messageConfig, spend) {
    try {
      const { showConsumePrompt } = await import("./attack-prompt.mjs");
      const choice = await showConsumePrompt({
        itemName:     activity.item?.name,
        itemImg:      activity.item?.img,
        activityName: activity.name || activity.type,
        cost:         spend.cost,
        available:    spend.available,
        max:          spend.max,
        label:        spend.label,
        summary:      await ActivityUsePrompt._summary(activity),
      });
      if (!choice) return;   // cancelled — the use stays cancelled

      const cfg = foundry.utils.deepClone(usageConfig ?? {});
      // "free" = run the ability without spending the resource.
      if (choice === "free") cfg.consume = false;

      ActivityUsePrompt._refiring.add(activity.uuid);
      await activity.use(cfg, { configure: false }, messageConfig ?? {});
    } catch (err) {
      ActivityUsePrompt._refiring.delete(activity?.uuid);
      console.warn(`${MODULE_ID} | consumption prompt/re-fire failed — use cancelled:`, err);
    }
  }
}
