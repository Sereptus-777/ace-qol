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
import { aceDescriptionText } from "./description-reader.mjs";

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

        // ⚠️🔴 THE GM IS ASKED; A PLAYER IS NOT (his rule, 2026-09-21: "GM
        // presses anything that spends a slot, a limited use, a recharge, or
        // legendary actions: ask first. Yes spends it and the action runs. No
        // cancels. Nothing is spent. A player press never sees that box.").
        //
        // ⚠️ AND I TOOK THIS BOX AWAY WITHOUT BEING ASKED (0.34.81). His words:
        // "He never asked to kill it. Put it back." What he wanted gone was
        // dnd5e's own "Consume Item Use?" window, not the one ACE owns. The
        // test is WHO IS PRESSING, not who owns the creature.
        //
        // A player's press: no ACE box, and dnd5e's is switched off on the way
        // past, so their slot or use is spent and nothing interrupts them.
        if (!game.user.isGM) {
          if (dialogConfig) dialogConfig.configure = false;
          return;
        }

        const spend = ActivityUsePrompt._describeCost(activity);
        // Nothing is spent (a Claw, a Bite, a cantrip): no box, no interruption.
        if (!spend) return;

        ActivityUsePrompt._promptThenRefire(activity, usageConfig, messageConfig, spend);
        return false;         // cancel this use; the re-fire carries the choice
      } catch (err) {
        console.warn(`${MODULE_ID} | activity use prompt failed — dnd5e's own dialog stands:`, err);
      }
    });

    console.debug(`${MODULE_ID} | Activity Use Prompt online — ACE owns the consumption dialog`);
  }

  /**
   * A creature's own action, as opposed to a player character's item.
   *
   * His rule, 2026-09-20: a monster's Wing, Tail or Breath is never asked
   * about. The GM pressed it; what it costs, it costs.
   */
  static isCreaturesOwnAction(activity) {
    const owner = activity?.actor ?? activity?.item?.actor ?? null;
    return !!owner && owner.type !== "character";
  }

  /**
   * What does this activity cost? null when it consumes nothing.
   *
   * ⚠️ A LEGENDARY ACTION IS A COST, AND IT IS NOT IN `consumption.targets`
   * (his table, 2026-09-21: the Wing Attack spent two of Volcathar's three
   * with no box at all). dnd5e takes it from the ACTIVATION, so a feature that
   * consumes nothing else looked free and was never asked about.
   */
  static _describeCost(activity) {
    try {
      const targets = activity?.consumption?.targets ?? [];
      if (!targets.length) return ActivityUsePrompt._legendaryCost(activity);
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
        case "attribute": {
          // ⚠️ A FIELD PATH IS NOT A WORD HE CAN READ. Volcathar's Wing Attack
          // consumes `resources.legact.value`, and the box offered to spend
          // "2 resources.legact.value" (his table, 2026-09-21). dnd5e's own
          // label for the resource is what belongs there.
          const path = String(t.target ?? "");
          const read = (o, p) => p.split(".").reduce((x, k) => (x == null ? x : x[k]), o);
          const actor = activity?.actor ?? item?.actor ?? null;
          if (/^resources\.legact\./.test(path)) {
            label = cost === 1 ? "legendary action" : "legendary actions";
            const res = actor?.system?.resources?.legact ?? {};
            max = Number(res.max);
            available = Number.isFinite(max) ? Math.max(0, max - (Number(res.spent ?? 0) || 0)) : NaN;
          } else if (/^resources\.legres\./.test(path)) {
            label = cost === 1 ? "legendary resistance" : "legendary resistances";
            const res = actor?.system?.resources?.legres ?? {};
            max = Number(res.max);
            available = Number.isFinite(max) ? Math.max(0, max - (Number(res.spent ?? 0) || 0)) : NaN;
          } else {
            const val = Number(read(actor?.system ?? {}, path));
            label = path.split(".").slice(-2, -1)[0] || "uses";
            if (Number.isFinite(val)) available = val;
          }
          break;
        }
        default:
          label = "uses";
      }
      // ⚠️ AND SAY WHAT BRINGS IT BACK. "1 of 1 charges" and "its one use,
      // back on a 5 or 6" are different decisions.
      try {
        const rec = (item?.system?.uses?.recovery ?? []).find(r => String(r?.period) === "recharge");
        if (rec && (t.type === "itemUses" || t.type === "activityUses")) {
          const needs = Number(rec.formula) || null;
          label = needs ? `use, back on a ${needs} or better` : "use, back on its recharge";
        }
      } catch (_) { /* the plain label stands */ }

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

  /** A legendary action's cost, read off the activation the way dnd5e spends it. */
  static _legendaryCost(activity) {
    try {
      if (String(activity?.activation?.type ?? "") !== "legendary") return null;
      const cost = Number(activity.activation.value ?? 1) || 1;
      const res = activity?.actor?.system?.resources?.legact ?? null;
      const max = Number(res?.max);
      const spent = Number(res?.spent ?? 0) || 0;
      return {
        cost,
        available: Number.isFinite(max) ? Math.max(0, max - spent) : null,
        max: Number.isFinite(max) && max > 0 ? max : null,
        label: cost === 1 ? "legendary action" : "legendary actions",
      };
    } catch (_) { return null; }
  }

  /**
   * A short, readable blurb for the prompt — the activity's own chat flavour if
   * it has one, otherwise the item's description. Trimmed to a couple of lines
   * so the dialog stays a decision, not a wall of rules text.
   */
  static async _summary(activity) {
    // ⚠️ THROUGH THE SHARED READER, which enriches and then flattens. Its roll
    // data falls back from the activity to the ITEM, and the item's is what
    // carries the creature's name — `[[lookup @name]]` asked of an activity
    // alone resolves to nothing, which is the exact placeholder that started
    // this on 2026-09-03.
    try { return await aceDescriptionText(activity?.item, { activity, limit: 240 }); }
    catch (_) { return ""; }
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
