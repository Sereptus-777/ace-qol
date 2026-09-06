// ─── ACE QOL — Swapping weapons, by the book ─────────────────────────────────
//
// A player reaches for a weapon they are not holding. RAW that is not free, and
// what it costs depends on the edition and on what is already in their hands.
// This asks, in the words of the rules, and then does it.
//
// Johnny, 2026-08-24: "I want to go raw on the changing weapons stuff. I want to
// pop up saying Dawnbringer is equipped, drop it and draw this other sword or
// whatever, your bow, because that's what happens... Whatever his options are,
// we need to do it that way."
//
// ═══ THE RULES THIS IMPLEMENTS ═══════════════════════════════════════════════
//
// 2014 PHB, "Using Each Ability" / object interaction:
//   You get ONE free object interaction on your turn — draw OR sheathe. A second
//   one costs your action (Use an Object). DROPPING is free and costs nothing at
//   all, which is exactly why adventurers drop things mid-fight.
//     • Drop what you hold, draw the new one   -> free, attack normally
//     • Sheathe what you hold, draw the new one -> the draw costs your ACTION
//
// 2024 PHB, the Attack action:
//   "You can equip or unequip one weapon when you make an attack as part of this
//   action." That is IN ADDITION to the general free interaction, so a clean
//   swap fits in one turn without spending the action.
//     • Stow and draw, then attack -> free
//     • Drop and draw, then attack -> free, and faster if hands are full
//
// Both editions: a SHIELD takes an action to don or doff. It is never free.
//
// ⚠️ ONLY IN COMBAT. Johnny: "that better be only in combat, right, because they
// can do anything they want with swiping and swapping weapons outside of
// combat." Out of combat this never appears — it just equips and gets on with
// it, because nobody is counting actions while the party is walking.
//
// ⚠️ PLAYER CHARACTERS ONLY. A monster's stat block is its loadout; nobody makes
// a goblin sheathe a scimitar. Same rule as the action bar's equipped gate and
// the opportunity-attack reader.
// ──────────────────────────────────────────────────────────────────────────────

import { MODULE_ID } from "./ace-qol.mjs";
import { editionMode } from "./rules-edition.mjs";
import { LoadoutEngine } from "./loadout-engine.mjs";

const LOG = "ace-qol | WeaponSwap";

export class WeaponSwap {

  /** 2024 unless the table is explicitly on 2014. Custom tables get 2024. */
  static _is2024() {
    try { return editionMode() !== "2014"; }
    catch (_) { return true; }
  }

  /** Everything this character is currently holding that takes a hand. */
  static _inHand(actor, exceptId = null) {
    try {
      return (actor?.items ?? []).filter(i =>
        i.id !== exceptId
        && i.system?.equipped === true
        && !i.system?.container
        && WeaponSwap._occupiesAHand(i));
    } catch (_) { return []; }
  }

  /**
   * Is this thing actually IN A HAND?
   *
   * ⚠️🔴 A WHITELIST, BECAUSE THE BLACKLIST WAS WRONG THE FIRST TIME.
   * This began as "equipment, unless it is armour or clothing", which meant every
   * equipment type I had not thought of counted as being held. Johnny's paladin
   * was offered the choice to "drop Cloak of Many Fashions on the ground" to
   * free a hand for a flail, mid-session (2026-08-24). A cloak is worn. So are
   * rings, amulets, boots, bracers, and every wondrous item in the book.
   *
   * Naming what IS held is a short, closed list; naming what is NOT held is
   * open-ended and wrong the moment somebody adds an item type. Anything not on
   * this list is worn or carried, never in a hand.
   */
  static _occupiesAHand(item) {
    // ⚠️🔴 YOU CANNOT DROP YOUR FISTS. Every weapon-type item counted as
    // being in a hand, and in dnd5e an Unarmed Strike IS a weapon item and is
    // marked equipped — so Johnny's druid was offered "Drop Unarmed Strike and
    // Stormforger on the ground" (2026-09-06). Natural weapons are the same:
    // a bear cannot sheathe its claws.
    //
    // ⚠️ THE SAME TEST THE LOADOUT ENGINE ALREADY USES, not a third copy of
    // it. That one checks the identifier as well as the name, so it catches a
    // renamed unarmed strike that a name match alone would miss.
    if (LoadoutEngine._isNaturalOrUnarmed?.(item)) return false;
    if (item.type === "weapon") return true;
    // A shield is the one piece of equipment that genuinely fills a hand.
    return item.type === "equipment" && (item.system?.type?.value ?? "") === "shield";
  }

  static _isShield(item) {
    return (item.system?.type?.value ?? "") === "shield";
  }

  /**
   * Should this use be interrupted to ask about a swap?
   * Returns false for everything that is not a player character in a live fight
   * reaching for a weapon they are not holding.
   */
  static shouldPrompt(actor, item) {
    try {
      if (actor?.type !== "character") return false;       // stat blocks hold their kit
      if (item?.type !== "weapon") return false;
      if (item.system?.equipped === true) return false;    // already in hand
      if (item.system?.container) return false;            // packed away, not on your belt
      // ⚠️ Only a STARTED combat counts. An encounter sitting in the tracker
      // with no initiative rolled is not a fight, and the party should not be
      // asked to budget actions while nothing is happening.
      const fight = game.combat;
      if (!fight?.started) return false;
      return true;
    } catch (_) { return false; }
  }

  /**
   * Ask, then do it. Resolves true when the weapon ends up in hand and the
   * caller should go ahead and use it; false when the player backed out.
   */
  static async promptAndEquip(actor, item) {
    const held = WeaponSwap._inHand(actor, item.id);
    const shields = held.filter(WeaponSwap._isShield);
    const weapons = held.filter(i => !WeaponSwap._isShield(i));
    const is2024 = WeaponSwap._is2024();
    const esc = foundry.utils.escapeHTML;

    const options = [];

    if (!weapons.length) {
      // A free hand. One interaction, and that is the whole cost.
      options.push({
        id: "draw",
        label: `Draw ${item.name}`,
        cost: "Free object interaction",
        note: "Your hands are free, so this is the one free interaction you get on your turn.",
      });
    } else {
      const other = weapons.map(w => w.name).join(" and ");
      if (is2024) {
        options.push({
          id: "stow",
          label: `Stow ${other}, draw ${item.name}`,
          cost: "Free",
          note: "2024: you may equip or unequip one weapon as part of the Attack action, "
              + "and the stow uses your free object interaction. You still attack this turn.",
        });
        options.push({
          id: "drop",
          label: `Drop ${other} on the ground, draw ${item.name}`,
          cost: "Free",
          note: "Dropping costs nothing at all. Faster than stowing, but the weapon is on the "
              + "floor and picking it back up costs an interaction later.",
        });
      } else {
        options.push({
          id: "drop",
          label: `Drop ${other} on the ground, draw ${item.name}`,
          cost: "Free — you still attack",
          note: "2014: dropping is free and drawing is your one free interaction, so this is "
              + "the only way to swap and still attack in the same turn.",
        });
        options.push({
          id: "stow",
          label: `Sheathe ${other}, draw ${item.name}`,
          cost: "Costs your ACTION — no attack this turn",
          note: "2014: you only get one free interaction. Sheathing uses it, so drawing needs "
              + "the Use an Object action and your attack is gone.",
          spendsAction: true,
        });
      }
    }

    if (shields.length) {
      options.push({
        id: "doff",
        label: `Take off your ${shields[0].name} as well`,
        cost: "Costs your ACTION",
        note: "Donning or doffing a shield takes an action in both editions. Only needed if "
            + `${item.name} needs two hands.`,
        spendsAction: true,
      });
    }

    const rows = options.map((o, i) => `
      <label class="ace-qol-swap-row">
        <input type="radio" name="ace-swap" value="${i}"${i === 0 ? " checked" : ""}>
        <span class="ace-qol-swap-main">
          <span class="ace-qol-swap-label">${esc(o.label)}</span>
          <span class="ace-qol-swap-cost${o.spendsAction ? " ace-qol-swap-costly" : ""}">${esc(o.cost)}</span>
          <span class="ace-qol-swap-note">${esc(o.note)}</span>
        </span>
      </label>`).join("");

    const content = `
      <div class="ace-qol-swap">
        <div class="ace-qol-swap-head">
          ${weapons.length
            ? `You are holding <strong>${esc(weapons.map(w => w.name).join(" and "))}</strong>.`
            : `Your hands are free.`}
          How do you want to get <strong>${esc(item.name)}</strong> in hand?
        </div>
        ${rows}
      </div>`;

    let chosen = null;
    try {
      const DialogV2 = foundry.applications.api.DialogV2;
      chosen = await DialogV2.wait({
        window: { title: `Swap to ${item.name}` },
        content,
        buttons: [
          { action: "go", label: "Do it", default: true,
            callback: (_ev, btn) => btn.form?.elements?.["ace-swap"]?.value ?? "0" },
          { action: "cancel", label: "Never mind" },
        ],
        // ⚠️ Dismissal must settle, or the caller waits for ever. A directly
        // constructed DialogV2 ignores `close:` — `wait()` is the one that reads
        // it, which is why this uses wait() rather than a hand-rolled promise.
        rejectClose: false,
        close: () => null,
      });
    } catch (err) {
      console.error(`${LOG} | the swap prompt failed:`, err);
      return false;
    }
    if (chosen === null || chosen === undefined || chosen === "cancel") return false;

    const pick = options[Number(chosen)] ?? options[0];
    return WeaponSwap._apply(actor, item, pick, { weapons, shields });
  }

  /** Carry out the chosen option and say what happened, in the log and in chat. */
  static async _apply(actor, item, pick, { weapons, shields }) {
    const updates = [];
    const said = [];

    if (pick.id === "stow" || pick.id === "drop") {
      for (const w of weapons) updates.push({ _id: w.id, "system.equipped": false });
      said.push(pick.id === "drop"
        ? `drops ${weapons.map(w => w.name).join(" and ")}`
        : `stows ${weapons.map(w => w.name).join(" and ")}`);
    }
    if (pick.id === "doff") {
      for (const sh of shields) updates.push({ _id: sh.id, "system.equipped": false });
      said.push(`takes off the ${shields[0].name}`);
    }
    updates.push({ _id: item.id, "system.equipped": true });
    said.push(`draws ${item.name}`);

    try {
      await actor.updateEmbeddedDocuments("Item", updates);
    } catch (err) {
      console.error(`${LOG} | could not change ${actor.name}'s loadout:`, err);
      ui.notifications?.error("That weapon swap did not go through — see the console.");
      return false;
    }

    // ⚠️ THE TABLE HAS TO SEE THE COST. A swap that quietly spends somebody's
    // action is the kind of thing that gets argued about three turns later. Say
    // it out loud, once, where everyone can read it.
    const costly = pick.spendsAction === true;
    try {
      await ChatMessage.create({
        speaker: ChatMessage.getSpeaker({ actor }),
        content: `<div class="ace-qol-swap-card">
            <div class="ace-qol-swap-card-line">${foundry.utils.escapeHTML(actor.name)} ${foundry.utils.escapeHTML(said.join(", then "))}.</div>
            <div class="ace-qol-swap-card-cost${costly ? " ace-qol-swap-costly" : ""}">${foundry.utils.escapeHTML(pick.cost)}</div>
          </div>`,
      });
    } catch (_) { /* the loadout changed; a missing card must not undo it */ }

    if (costly) {
      ui.notifications?.warn(`${pick.cost} — ${actor.name} cannot attack this turn.`);
      return false;      // the action is spent; do not then fire the attack
    }
    return true;
  }
}
