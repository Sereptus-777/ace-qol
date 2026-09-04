// ─── ACE QOL — The Action Bar ─────────────────────────────────────────────────
//
// Two rows of ten slots that fill themselves from whoever you have selected,
// sitting directly above Foundry's own macro bar.
//
// ⚠️ IT IS CALLED "THE ACTION BAR". Not a HUD, not a hotbar. Foundry's own row
// underneath is "the hotbar", and the two names must never collide when a user
// files a bug — Johnny named this one on 2026-08-23.
//
// ═══ WHY THIS EXISTS, AND WHY IT IS NOT A BG3 HUD CLONE ══════════════════════
//
// Johnny ran BG3 Inspired Hotbar for months and dropped it on 2026-08-14 — his
// players had already abandoned it ("it doesn't show up half the time, it's very
// finicky") and were working from character sheets instead. ACE was carrying two
// separate workarounds for its bugs by then. But three of its ideas were good
// and are rebuilt here:
//
//   • A PORTRAIT, so you can tell at a glance who is selected.
//   • The selected creature's ACTIONS, without opening a sheet.
//   • An END TURN button that appears only when it is that creature's turn.
//
// ⚠️ WE DO NOT TOUCH FOUNDRY'S HOTBAR. It keeps its macros, its pages, its lock
// and its trash, and every slot in it stays exactly where Johnny put it. This
// bar renders ABOVE it.
//
// ═══ ARRANGING IT BY HAND — THE PART THAT USED TO BE MISSING ═════════════════
//
// The original split was justified like this: "an auto-filling bar and a
// hand-arranged bar cannot be the same bar, or selecting a goblin wipes the row
// you spent an evening building." That is true of a SHARED row. It is not true
// of a row remembered PER CREATURE, which is what this now is.
//
// Drop an item on a slot and it takes that slot; everything from there rightward
// shifts along one, wrapping from the top row into the bottom. Anything pushed
// past slot 20 is not drawn — it is still on the sheet, and it comes back if you
// make room. Slot 1 is top-left, slot 20 is bottom-right, and the automatic fill
// runs in that same reading order so the top row always fills first.
//
// ⚠️ THE ARRANGEMENT IS STORED ON THE CREATURE, WHICH FOR AN UNLINKED TOKEN
// MEANS THAT TOKEN. Arrange one goblin and the goblin beside it is untouched,
// because each unlinked token carries its own copy of the creature. That is the
// whole reason this can coexist with an auto-filled row at all.
//
// ⚠️ ONCE YOU TOUCH IT, IT STAYS TOUCHED. The first drop freezes the current
// order into the creature's own record. Anything the creature gains later is
// appended on the end rather than shuffling what you arranged. "Reset to
// automatic" on the right-click menu puts it back.
//
// ⚠️ EQUIPPED ONLY GATES PLAYER CHARACTERS. ═══════════════════════════════════
//
// Johnny, 2026-08-14: "when they swap weapons, I want them to equip and unequip
// right on their sheet." That is a rule about PLAYERS managing a loadout, and it
// was wrongly applied to every creature, which quietly deleted monster attacks.
//
// PROVEN 2026-08-23 from his own world file. The goblin on his screen, actor
// 7wmug8HMCatJzXwS, nameplate "Grizzle Snaptooth":
//
//     Scimitar        equipped: false   2 attack activities
//     Shortbow        equipped: false   2 attack activities
//     Nimble Escape   no equipped field at all
//
// Nimble Escape was the ONLY thing in his bar, and it is the only one of the
// three with no equipped box. 26 creatures in that world were affected, 75
// items, including a CR 30, an Aboleth and an Empyrean. The Monster Manual
// module's own copy of the Goblin Warrior has both weapons ticked, so this is
// not something ACE did — but it is something ACE has to survive.
//
// ⚠️ AND ACE ALREADY KNEW. `oa-prompt.mjs` says it in a comment: "Monster stat
// blocks don't reliably set the equipped flag and don't stow gear in bags, so
// their listed weapons ARE their available attacks." `multiattack-engine.mjs`
// applies the same rule. This file simply never got it. Fixing the one that
// surfaced and leaving its twins is the habit that keeps costing days.
//
// ⚠️ PASSIVES ARE NOT ACTIONS. Only items with at least one activity appear.
// Darkvision, Brave, Pack Tactics and the rest are facts about a creature, not
// buttons — they belong in the effects panel, and putting them here would push
// the actual attacks off the end of the row.
//
// ⚠️ MULTIATTACK IS A LABEL, NOT A SLOT. It is not something you activate; it
// tells you how to read everything to its right. It shows as a badge on the
// portrait, per Johnny's explicit instruction — "I would like it noted, but not
// in that macro".
// ──────────────────────────────────────────────────────────────────────────────

import { MODULE_ID } from "./ace-qol.mjs";
import { WeaponSwap } from "./weapon-swap.mjs";
import { resolveReach } from "./reach-reader.mjs";
import { MultiattackEngine } from "./multiattack-engine.mjs";
import { aceDescriptionTextSync, aceDescriptionHtmlSync, acePrimeDescriptions }
  from "./description-reader.mjs";

const LOG = "ace-qol | ActionBar";

/** Ten across, two rows. Slot 1 is top-left, slot 20 is bottom-right. */
const COLUMNS = 10;
const ROWS = 2;
const SLOT_COUNT = COLUMNS * ROWS;

/**
 * Four across, two rows. At or below this the slots go wide and the whole name
 * fits; above it they collapse back to the squares.
 *
 * ⚠️ EIGHT IS NOT ARBITRARY. It is what four wide slots across two rows holds,
 * and it is also roughly the fattest spell level a real 20th-level caster has
 * (a wizard's first and second levels run about eight). So the common case is
 * readable and the outlier still fits.
 */
const WIDE_MAX = 8;

/** Item types that are equipment rather than abilities. */
const GEAR_TYPES = ["consumable", "tool", "equipment", "loot", "container", "backpack"];

/**
 * Multiattack in either edition, with or without a parenthetical rider.
 * Built from character codes on purpose: a word-boundary escape written by
 * hand has been eaten into a literal backspace nine times across this suite
 * (2026-08-22), and a regex that silently never matches is exactly the bug
 * this pattern was added to fix.
 */
const MULTIATTACK_NAME = new RegExp("^multi[\\s-]?attack" + "\\b", "i");

/** Where a creature's hand-arranged order lives: `{ order: [id], hidden: [id] }`. */
const LAYOUT_FLAG = "actionBar";

export class ActionBar {

  static _el = null;
  static _actorUuid = null;
  static _renderTimer = null;

  /* ── Reading the creature ─────────────────────────────────────────────── */

  /**
   * Everything this creature can actually DO, in the order Johnny asked for:
   * attacks first on the far left, then actionable features, then spells.
   *
   * ⚠️ ASK THE ACTIVITY, NOT THE ITEM. An item is a container; what it can do
   * lives in its activities. A "weapon" with no attack activity is a club
   * sitting in a backpack, and a feat with a save activity is very much an
   * action. This is the same activity-not-item rule the attack pipeline learned
   * the hard way — reading `item.type` alone gets Breath Weapon wrong.
   */
  /**
   * Why this item does NOT belong on the bar, in plain English, or null if it
   * does. One item, one answer.
   *
   * ⚠️ THE RULE LIVES HERE AND ONLY HERE. `_actionsFor` asks this, and so does
   * the drop handler, so a refused drop can never disagree with what the bar
   * chose to draw. The first cut had the drop handler test membership of the
   * finished list instead, which quietly broke a case Johnny had explicitly
   * asked for: the list is deduplicated by name, so dragging a SECOND Spiked
   * Chain on by hand was refused as ineligible. Deduplication belongs to the
   * automatic fill, not to the rule about what may sit on a bar.
   */
  static _ineligible(actor, item) {
    // ⚠️🔴 MULTIATTACK IS A SLOT NOW, AND IT USED TO BE A BADGE ON THE PORTRAIT.
    // That was Johnny's call in August and he reversed it on 2026-09-03: "I
    // don't need it on the portrait... I want it on the hot bar, just like
    // Morningstar and Rock are on there. It's called an action, actually."
    // He is right: it has an activation cost and it drives the attack chain, so
    // it is a button. Its slot opens that chain rather than doing nothing.
    if (ActionBar._isMultiattack(item)) return null;

    // ⚠️ A PASSIVE IS A BADGE, NOT AN ACTION, AND IT STILL BELONGS HERE.
    // Johnny, 2026-09-03: "Keen Smell's got to be there, sort of... You can't
    // ever do anything with these things. It just lets me know it's a badge
    // that says, hey, this thing has keen smell, and when I hover over it, it
    // better say exactly what this creature has about keen smell."
    //
    // So they are admitted, and `_actionsFor` puts them last where they cannot
    // displace anything that can actually be pressed. The old rule — "passives
    // belong in the effects panel" — was right about what they ARE and wrong
    // about where a GM looks for them mid-turn.
    if (ActionBar._isPassiveBadge(actor, item)) return null;

    const list = ActionBar._activityList(item.system?.activities);
    if (!list.length) {
      return `${item.name} has nothing to activate, so it cannot sit on a bar. `
           + `Passive traits belong in the effects panel.`;
    }

    // ⚠️ A DAMAGE ACTIVITY IS NOT AN ACTION. Assassinate, Sneak Attack and
    // Cunning Strike all carry one so the player can apply the rider by hand,
    // and all three were sitting on Jeth's bar. dnd5e marks them itself: their
    // activation type is "special", and the system flags special / turnStart /
    // turnEnd / encounter / shortRest / longRest with `passive: true`. READ THE
    // SYSTEM'S FLAG, never a list we invent - a hand-written list is wrong the
    // day the system adds a type.
    if (!list.some(a => ActionBar._isTakeable(a))) {
      return `${item.name} applies on its own. It is not an action you take, so it has no button.`;
    }

    if (actor?.type === "character") {
      // Packed in a bag is not on your person. That gate stays.
      if (item.system?.container) {
        return `${item.name} is packed inside a container. Take it out on the sheet first.`;
      }
      // ⚠️ A WEAPON ON YOUR BELT BELONGS ON THE BAR EVEN WHEN IT IS NOT IN
      // YOUR HAND. The equipped gate used to hide it, so Jexxi's second sword
      // simply was not there and there was no way to reach for it. Johnny,
      // 2026-08-24: "we got to kind of have the main weapons on the macro action
      // hotbar there. If the character grabs it, it should pop up for them."
      //
      // And NOT greyed out - he was explicit: "I don't want things grayed out
      // because it looks like oh, I don't have this." It looks like any other
      // slot; clicking it opens the RAW swap prompt (see weapon-swap.mjs) and
      // then attacks. Everything else a player is not holding - armour, gear,
      // a stowed wand - still obeys the equipped rule.
      if (item.system?.equipped === false && item.type !== "weapon") {
        return `${item.name} is not equipped. Equip it on the sheet and it appears here on its own.`;
      }
    }

    // ⚠️ MULTIATTACK IS A BADGE, NEVER A SLOT. Johnny said so on 2026-08-14 -
    // "I would like it noted, but not in that macro" - and it was noted and then
    // put in the macro anyway: his Vampire had it sitting in slot three on
    // 2026-08-23. It is not something you activate; it tells you how to read
    // everything to its right.
    if (ActionBar._isMultiattack(item)) {
      return `Multiattack is shown as a badge on the portrait, not as a button. `
           + `It tells you how to read the attacks beside it.`;
    }

    // Prepared-spell respect: an unprepared spell is not castable at will.
    //
    // ⚠️ `system.preparation` IS DEPRECATED - dnd5e 5.1 split it into
    // `system.method` and `system.prepared`, and it disappears in 6.0. Reading
    // the old shape did not just risk a future break: every access logged a
    // compatibility warning, and this runs for EVERY spell on EVERY re-render.
    // On a caster carrying a full spell list that is hundreds of stack-trace
    // writes per redraw, which is exactly the "super glitchy, everything's all
    // fucked up when I move the map" Johnny reported (2026-08-14). A
    // deprecation notice is cheap once and ruinous in a render loop.
    if (item.type === "spell") {
      const sys = item.system ?? {};
      const method = sys.method ?? sys.preparation?.mode;         // 5.1+ first
      const prepared = sys.prepared ?? sys.preparation?.prepared;
      const alwaysReady = ["always", "atwill", "innate", "pact", "ritual"].includes(method);
      if (!alwaysReady && prepared === false) {
        return `${item.name} is not prepared. Prepare it on the sheet and it appears here on its own.`;
      }
      return null;
    }

    // ⚠️ GEAR IS NOT AN ACTION JUST BECAUSE LIGHTING IT TAKES ONE. Jeth's bar
    // was carrying a Candle, a Waterskin, Perfume and a Hooded Lantern, every
    // one of them a legitimate "action" as far as the data is concerned. Kept
    // only when the gear actually does something in a fight: a healing potion,
    // Ball Bearings, a flask of Oil. Johnny, 2026-08-23: "actions that actually
    // can be done."
    if (GEAR_TYPES.includes(item.type)
        && !list.some(a => ["attack", "damage", "save", "heal"].includes(a?.type))) {
      return `${item.name} is gear rather than an action. The bar keeps what fights: `
           + `weapons, potions, oil, caltrops.`;
    }

    return null;
  }

  /**
   * Everything this creature can actually DO, in the order Johnny asked for.
   *
   * Johnny, 2026-08-23: "Start with weapons, attacks, and actions that actually
   * can be done... The only caveat with spells is healing spells. I definitely
   * want them in there alongside attack spells. Attack spells are always more
   * important."
   *
   * ⚠️ ASK THE ACTIVITY, NOT THE ITEM. An item is a container; what it can do
   * lives in its activities. A "weapon" with no attack activity is a club
   * sitting in a backpack, and a feat with a save activity is very much an
   * action. This is the same activity-not-item rule the attack pipeline learned
   * the hard way - reading `item.type` alone gets Breath Weapon wrong.
   */
  static _actionsFor(actor) {
    const multi = [], weaponAttacks = [], otherAttacks = [], feats = [];
    const attackSpells = [], healing = [], otherSpells = [], gear = [], passives = [];

    // ⚠️ ONE SLOT PER NAME. Jeth genuinely carries Spiked Chain THREE times as
    // three separate items, all with attack activities, and the bar drew all
    // three. Deduped by name, first one wins. This is a property of the
    // AUTOMATIC fill only - `_ineligible` knows nothing about it, so dropping a
    // second copy on by hand is still honoured and keeps its slot.
    const seenNames = new Set();

    for (const item of (actor?.items ?? [])) {
      try {
        if (ActionBar._ineligible(actor, item)) continue;

        const name = String(item.name ?? "").trim().toLowerCase();
        if (name && seenNames.has(name)) continue;
        if (name) seenNames.add(name);

        // ⚠️ MULTIATTACK LEADS, because it tells you how to read everything to
        // its right, and a GM reads the bar left to right.
        if (ActionBar._isMultiattack(item)) { multi.push(item); continue; }
        if (ActionBar._isPassiveBadge(actor, item)) { passives.push(item); continue; }

        const list = ActionBar._activityList(item.system?.activities);
        const has = (t) => ActionBar._hasType(list, t);

        if (item.type === "spell") {
          if (has("attack")) attackSpells.push(item);
          else if (has("heal")) healing.push(item);
          else otherSpells.push(item);
        } else if (has("attack")) {
          (item.type === "weapon" ? weaponAttacks : otherAttacks).push(item);
        } else if (has("heal")) {
          healing.push(item);
        } else if (GEAR_TYPES.includes(item.type)) {
          gear.push(item);
        } else {
          feats.push(item);
        }
      } catch (err) {
        console.warn(`${LOG} | could not classify "${item?.name}":`, err);
      }
    }
    // ⚠️ PASSIVES FILL FROM THE BACK AND NEVER PUSH AN ACTION OUT. On a Cloud
    // Giant that is five things and a comfortable row; on a wizard with fifty
    // spells the badges simply do not fit, which is correct — nobody needs
    // Darkvision taking a slot from a spell list.
    return [...multi, ...weaponAttacks, ...otherAttacks, ...feats,
            ...attackSpells, ...healing, ...otherSpells, ...gear, ...passives];
  }

  /**
   * A fact about the creature rather than something it does.
   *
   * ⚠️ NO ACTIVITY, OR NOTHING TAKEABLE. Keen Smell and Darkvision have no
   * activity at all; Innate Spellcasting usually has one whose activation the
   * system flags passive. Both are badges: you read them, you never press them.
   *
   * ⚠️ FEATURES ONLY. A backpack has no activity either and is not a trait, and
   * admitting gear here would refill the bar with rope and rations.
   */
  /**
   * A slot you read rather than press.
   *
   * ⚠️🔴 I BUILT MULTIATTACK A BUTTON AND HE DID NOT ASK FOR ONE. Johnny,
   * 2026-09-03: "I just want to hover so I know how many attacks to do. I don't
   * want a button to push, for fuck's sake."
   *
   * He had said "it's called an action, actually" and I read that as "make it
   * pressable" when it meant "put it in the bar with the actions instead of on
   * the portrait". Position and pressability are two different questions and I
   * answered the wrong one.
   *
   * ⚠️ THE STYLING IS THE HONEST PART. These get no hover lift and no pointer
   * cursor, so nothing invites a press in the first place — which is better
   * than a click that fires a notification saying it did nothing.
   */
  static _isReadOnlySlot(actor, item) {
    return ActionBar._isMultiattack(item) || ActionBar._isPassiveBadge(actor, item);
  }

  static _isPassiveBadge(actor, item) {
    try {
      if (item?.type !== "feat") return false;
      if (ActionBar._isMultiattack(item)) return false;
      const list = ActionBar._activityList(item.system?.activities);
      if (!list.length) return true;
      return !list.some(a => ActionBar._isTakeable(a));
    } catch (_) { return false; }
  }


  /* ── Tabs ─────────────────────────────────────────────────────────────── */

  /**
   * The tab strip, and what is in each tab.
   *
   * ⚠️🔴 TABS, NOT PAGES, AND SPELLS GROUP BY LEVEL. Johnny, 2026-09-03: "the
   * only time that the bar will be completely full is with something like a
   * spellcaster, in which he has maybe 50 spells, so it's not all gonna fit...
   * I don't even know what spells they have because it runs out as soon as it's
   * got all the first-level spells on there."
   *
   * Pages fail here for the exact reason he gave: the problem is not knowing
   * what is there, and "page 2 of 5" is not a map. Levels are. A wizard's fifty
   * spells become nine short rows he can navigate the way he reads a sheet.
   *
   * ⚠️ "ALL" IS FIRST AND IT IS THE OLD BAR, HAND ARRANGEMENT INCLUDED. The
   * per-creature arrangement is a flat twenty-slot order, and partitioning it
   * into tabs would quietly throw away an evening's work. So the tabs are
   * ADDITIVE: All behaves exactly as the bar did, and the rest are filters over
   * it.
   *
   * ⚠️ A TAB WITH NOTHING IN IT IS NOT DRAWN, and when only All has anything
   * the strip does not draw at all. Most monsters never see a tab.
   */
  static _tabsFor(actor, ordered) {
    const tabs = [{ id: "all", label: "All", items: ordered }];
    try {
      const attacks = [], actions = [], spells = [], features = [], inventory = [];
      for (const item of ordered) {
        if (ActionBar._isPassiveBadge(actor, item)) { features.push(item); continue; }
        if (item.type === "spell") { spells.push(item); continue; }
        // ⚠️ GEAR BEFORE THE ATTACK TEST, or a thrown dagger and a wand end up
        // under Attacks and the Inventory tab is empty of the things he reaches
        // for. Johnny, 2026-09-03: "we need an inventory button in the tab up
        // top... A guy could drink a potion real quick, like an action."
        if (GEAR_TYPES.includes(item.type)) { inventory.push(item); continue; }
        const list = ActionBar._activityList(item.system?.activities);
        if (ActionBar._hasType(list, "attack")) { attacks.push(item); continue; }
        if (ActionBar._isMultiattack(item)) { attacks.push(item); continue; }
        if (item.type === "feat") { features.push(item); continue; }
        actions.push(item);
      }
      if (attacks.length)  tabs.push({ id: "attacks",  label: "Attacks",  items: attacks });
      if (actions.length)  tabs.push({ id: "actions",  label: "Actions",  items: actions });
      if (spells.length)   tabs.push({ id: "spells",   label: "Spells",   items: spells, levels: true });
      // ⚠️ USABLE GEAR, NOT A FULL PACK LIST. Rope and rations carry no
      // activity, so they never reach the bar at all — this is the potion you
      // drink and the wand you point, which is what he asked the tab for.
      if (inventory.length) tabs.push({ id: "inventory", label: "Inventory", items: inventory });
      if (features.length) tabs.push({ id: "features", label: "Features", items: features });
    } catch (err) {
      console.warn(`${LOG} | could not group this creature's actions into tabs:`, err);
    }
    // Only All has anything worth a tab -> no strip.
    return tabs.length > 1 ? tabs : [];
  }

  /**
   * Spell levels present on this creature, in order, cantrips first.
   *
   * ⚠️ ONLY THE LEVELS THEY ACTUALLY HAVE. Drawing 0 through 9 for a creature
   * with two cantrips and a first-level spell is nine buttons, seven of which
   * are lies about what is in there.
   */
  static _spellLevels(items) {
    const seen = new Map();
    for (const item of items) {
      const lvl = Number(item.system?.level ?? 0);
      if (!seen.has(lvl)) seen.set(lvl, []);
      seen.get(lvl).push(item);
    }
    return [...seen.entries()].sort((a, b) => a[0] - b[0])
      .map(([level, list]) => ({ level, items: list,
        label: level === 0 ? "Cantrips" : ActionBar._ordinal(level) }));
  }

  /** Which tab this creature is on. Remembered so a redraw does not reset it. */
  static _tabState = new Map();

  static _currentTab(actorId, tabs) {
    const held = ActionBar._tabState.get(actorId);
    if (held && tabs.some(t => t.id === held.tab)) return held;
    return { tab: tabs[0]?.id ?? "all", level: null };
  }

  /* ── What a slot actually IS, on hover ──────────────────────────── */

  /**
   * A rich hover card for one slot: what it is, what it costs, what it does.
   *
   * ⚠️ A NAME IS NOT A DESCRIPTION. The bar used to hover "Multiattack" and
   * stop there, which tells a GM nothing they did not already know. Johnny,
   * 2026-08-24: "it might say multi attack, but that doesn't tell me which
   * attacks are multi... I need it to tell me when I hover over." Monster stat
   * blocks are the whole reason: the GM is running twelve creatures they have
   * never read, and the sheet is two clicks away in the middle of a turn.
   *
   * ⚠️ `data-tooltip-html`, NOT `data-tooltip`. V13 renders the plain
   * attribute as TEXT and only `data-tooltip-html` as markup, through its own
   * `cleanHTML` sanitiser. Putting markup in the plain one shows the user
   * angle brackets.
   */
  /**
   * Everything a GM needs to decide whether to press this, and nothing less.
   *
   * ⚠️🔴 THE HOVER IS THE PRODUCT. Johnny, 2026-09-03: "The description is the
   * most important part when you're dealing with a hot bar, right? The hover
   * over, what the fuck this does, is important, not just some whatever." And
   * on spells: "I have to have the full description pop up: what it does, who
   * it affects, all that, because I don't know every freaking spell."
   *
   * So the description is NOT truncated any more. It was capped at 260
   * characters, which is roughly one sentence of a spell, and cutting a spell
   * off at "each creature in a 20-foot-radius sphere must make a..." is worse
   * than showing nothing, because it reads as the whole rule.
   *
   * ⚠️ AND IT GOES IN AS MARKUP, NOT ESCAPED TEXT. The old version ran the body
   * through `escapeHTML`, so a description that arrived as markup left as
   * visible angle brackets. Only the fields ACE composes itself are escaped,
   * because those are the ones that can carry a creature's name.
   */
  static _tooltipFor(item) {
    const esc = foundry.utils.escapeHTML;
    try {
      const rows = [];
      const list = ActionBar._activityList(item.system?.activities);
      const first = list[0] ?? null;
      const sys = item.system ?? {};

      // ── What KIND of thing this is ────────────────────────────────────
      // A spell's level and school is the first thing a caster reads, and it
      // was not in here at all.
      const kind = [];
      if (item.type === "spell") {
        const lvl = Number(sys.level ?? 0);
        const schoolKey = CONFIG.DND5E?.spellSchools?.[sys.school]?.label;
        const school = schoolKey ? game.i18n.localize(schoolKey) : "";
        kind.push(lvl === 0
          ? (school ? school + " cantrip" : "Cantrip")
          : ActionBar._ordinal(lvl) + "-level " + (school || "spell"));
        if (ActionBar._hasProperty(sys, "ritual")) kind.push("Ritual");
        if (ActionBar._hasProperty(sys, "concentration")) kind.push("Concentration");
      }

      // Cost: Action / Bonus Action / Reaction / Legendary, in the system's words.
      const actType = first?.activation?.type;
      const actCfg = CONFIG.DND5E?.activityActivationTypes?.[actType];
      const cost = actCfg?.label ? game.i18n.localize(actCfg.label) : null;
      if (cost) kind.push(cost);

      // ⚠️ WHICH BOOK THIS CAME OUT OF. Johnny, 2026-09-03: "our engine has to
      // detect whether it's a 2014 legacy monster or a 2024 monster because I
      // don't know which one I'm using." He spent an hour tonight comparing his
      // Cloud Giant's Multiattack against the 2024 text and concluding ACE was
      // broken; it was reading the 2014 stat block correctly and neither of us
      // could see which one was on the sheet.
      //
      // ⚠️ THE FIELD, NOT THE NAME. dnd5e stamps the ruleset on the item itself.
      // "(Legacy)" in a name is a convention some importers follow and others do
      // not, and a creature can carry 2014 items under a 2024 name.
      const rules = String(sys.source?.rules ?? "").trim();
      if (rules) kind.push(rules === "2014" ? "2014 rules" : `${rules} rules`);
      if (kind.length) rows.push('<div class="ace-qol-ab-tip-cost">' + esc(kind.join("  \u00b7  ")) + '</div>');

      const bits = [];
      // Reach or range, from THE resolver, the same one the attack gate uses.
      // ⚠️ THE TOOLTIP IS A PROMISE. A tooltip reading "Reach 5 feet" over a
      // weapon the pipeline will happily swing at 10 feet is a lie told in his
      // own UI. `repair: false` because rendering a tooltip is not a swing.
      const r = first?.range ?? {};
      if (r.units === "self") bits.push("Self");
      else if (r.value && r.long) bits.push("Range " + r.value + "/" + r.long + " " + (r.units ?? "ft"));
      else if (r.value) bits.push("Range " + r.value + " " + (r.units ?? "ft"));
      else {
        const reach = resolveReach(item, first, { repair: false });
        if (reach.reachFt > 0) bits.push("Reach " + reach.reachFt + " " + (reach.units ?? "ft"));
      }

      // ⚠️ WHO IT AFFECTS, IN HIS WORDS: "what it does, who it affects, all
      // that." A shape and a count are different answers and a spell can carry
      // either, a 20 ft sphere or three creatures.
      const tpl = first?.target?.template;
      if (tpl?.type && tpl?.size) bits.push(tpl.size + " " + (tpl.units ?? "ft") + " " + tpl.type);
      const aff = first?.target?.affects;
      if (aff?.type) {
        const key = CONFIG.DND5E?.individualTargetTypes?.[aff.type]?.label ?? aff.type;
        const label = game.i18n.localize(key);
        const count = Number(aff.count) || 0;
        bits.push(count > 1 ? count + " " + label + "s" : label);
      }

      // Attack or save, whichever this is.
      const save = first?.save;
      const saveAbil = save?.ability instanceof Set ? [...save.ability][0] : save?.ability;
      if (saveAbil) {
        const key = CONFIG.DND5E?.abilities?.[saveAbil]?.label;
        const label = key ? game.i18n.localize(key) : String(saveAbil).toUpperCase();
        const dc = save?.dc?.value ?? save?.dc?.formula ?? null;
        bits.push((dc ? "DC " + dc + " " : "") + label + " save");
      }

      // How long it lasts. Choosing between two spells needs this.
      const dur = first?.duration ?? sys.duration ?? {};
      if (dur.units && dur.units !== "inst") {
        bits.push(dur.value ? dur.value + " " + dur.units : String(dur.units));
      }

      const uses = sys.uses ?? {};
      if (Number.isFinite(uses.max) && uses.max > 0) {
        bits.push((uses.value ?? 0) + "/" + uses.max + " uses");
      }
      if (bits.length) rows.push('<div class="ace-qol-ab-tip-meta">' + esc(bits.join("  \u00b7  ")) + '</div>');

      // ── The rules text, whole, and as markup ──────────────────────────
      const body = ActionBar._describeForTooltip(item);
      if (body) {
        rows.push('<div class="ace-qol-ab-tip-desc">' + body + '</div>');
        // ⚠️ SAY THE LOCK EXISTS. A scrollable panel nobody knows they can pin
        // is the same as no panel: the hover vanishes the moment he reaches for
        // the wheel. dnd5e's own tooltips carry this line for the same reason.
        rows.push('<div class="ace-qol-ab-tip-more">Middle-click to keep this open</div>');
      }

      return '<div class="ace-qol-ab-tip"><div class="ace-qol-ab-tip-name">'
        + esc(item.name) + '</div>' + rows.join("") + '</div>';
    } catch (err) {
      console.debug(LOG + " | could not build a tooltip for \"" + item?.name + "\":", err);
      return '<div class="ace-qol-ab-tip"><div class="ace-qol-ab-tip-name">'
        + esc(item?.name ?? "") + '</div></div>';
    }
  }

  /** dnd5e 5.x keeps item properties in a Set; older data used an Array. */
  static _hasProperty(sys, key) {
    const props = sys?.properties;
    if (!props) return false;
    if (typeof props.has === "function") return props.has(key);
    if (Array.isArray(props)) return props.includes(key);
    return false;
  }

  static _ordinal(n) {
    const suffix = ["th", "st", "nd", "rd"];
    const v = n % 100;
    return n + (suffix[(v - 20) % 10] ?? suffix[v] ?? suffix[0]);
  }

  /**
   * The rules text for the hover: enriched markup, whole, never cut.
   *
   * ⚠️ MULTIATTACK'S OWN DESCRIPTION IS ALMOST NEVER ITS DESCRIPTION. The
   * importer writes "The Cloud Giant (Legacy) uses Multiattack" and leaves the
   * real line in the creature's stat block text. The engine already finds that
   * passage; reading the item's field here would show the useless sentence on
   * the one action that most needs its rules read out.
   */
  static _describeForTooltip(item) {
    const esc = foundry.utils.escapeHTML;
    try {
      if (ActionBar._isMultiattack(item)) {
        const summary = MultiattackEngine.summaryFor?.(item?.actor);
        const head = summary?.label
          ? '<div style="font-weight:700;margin-bottom:4px;">' + esc(summary.label) + '</div>'
          : "";
        if (summary?.text) return head + "<div>" + esc(summary.text) + "</div>";
        if (head) return head;
      }
      // ⚠️ HTML WHEN THE CACHE IS WARM, SAFE PROSE WHEN IT IS NOT. Enrichment
      // is async and a tooltip is built synchronously, so this reads the cache
      // the bar primes on every redraw. Neither path can show enricher syntax.
      const cached = aceDescriptionHtmlSync(item);
      if (cached) return cached;
      const plain = aceDescriptionTextSync(item);
      return plain ? esc(plain) : "";
    } catch (_) { return ""; }
  }

  /** Activities as a plain array, whatever shape the system hands them over in. */
  static _activityList(activities) {
    if (!activities) return [];
    if (typeof activities.values === "function") return [...activities.values()];
    if (Array.isArray(activities)) return activities;
    return Object.values(activities);
  }

  static _hasType(list, type) {
    return list.some(a => a?.type === type);
  }

  /**
   * Is this activity something a creature DOES on its turn?
   *
   * ⚠️ THE SYSTEM OWNS THIS ANSWER. `CONFIG.DND5E.activityActivationTypes`
   * carries a `passive: true` flag on exactly the types that are not actions:
   * special, turnStart, turnEnd, encounter, shortRest, longRest. An empty
   * activation is the same thing - that is what an enchantment has, which is
   * why "Sir Godfrey's Silver Shortsword" was on Jeth's bar as an attack.
   */
  static _isTakeable(activity) {
    // ⚠️ AN ATTACK ACTIVITY IS AN ACTION BY DEFINITION, whatever its
    // activation says. Johnny's world holds a "Vampire Spawn (Legacy)" whose
    // Bite carries an attack activity marked "special", and without this
    // exemption the new rule hid a real attack and left the creature with
    // nothing but Claws. Passive RIDERS are damage activities (Sneak Attack,
    // Assassinate) and are still excluded, because they are not attacks.
    if (activity?.type === "attack") return true;
    const type = activity?.activation?.type;
    if (!type) return false;
    return !CONFIG.DND5E?.activityActivationTypes?.[type]?.passive;
  }

  /**
   * Multiattack, however the stat block spells it.
   *
   * ⚠️ MATCHED ON THE LEADING WORD, NOT THE WHOLE NAME. The old test wanted the
   * name to be exactly "Multiattack", so the Vampire's "Multiattack (Vampire
   * Form Only)" matched nothing: no badge on the portrait AND a slot on the
   * bar, which is the exact opposite of what it should have done.
   * Name-matched deliberately - it carries no machine-readable marker.
   */
  static _isMultiattack(item) {
    return MULTIATTACK_NAME.test(String(item?.name ?? "").trim());
  }

  /** Does this creature have Multiattack? Returned as a label, never a slot. */
  static _multiattack(actor) {
    try {
      return (actor?.items ?? []).find(i => ActionBar._isMultiattack(i)) ?? null;
    } catch (_) { return null; }
  }

  /** Conditions and auras currently on the creature, for the strip along the top. */
  static _badgesFor(actor) {
    const out = [];
    try {
      for (const e of (actor?.effects ?? [])) {
        if (e.disabled) continue;
        out.push({ name: e.name, img: e.img ?? e.icon, id: e.id });
      }
    } catch (err) {
      console.warn(`${LOG} | could not read effects for the strip:`, err);
    }
    return out;
  }

  /* ── The hand-arranged order ──────────────────────────────────────────── */

  /** This creature's stored arrangement, always as a usable shape. */
  static _readLayout(actor) {
    let raw = null;
    try { raw = actor?.getFlag?.(MODULE_ID, LAYOUT_FLAG) ?? null; }
    catch (err) { console.warn(`${LOG} | could not read the stored layout:`, err); }
    return {
      order:  Array.isArray(raw?.order)  ? raw.order.filter(x => typeof x === "string")  : [],
      hidden: Array.isArray(raw?.hidden) ? raw.hidden.filter(x => typeof x === "string") : []
    };
  }

  /**
   * The full ordered list for this creature: hand-arranged first, in the order
   * they were arranged, then anything new in the automatic order.
   *
   * ⚠️ GAPLESS BY DESIGN. Johnny asked for the top row to fill before the bottom
   * one, so this is a LIST, not a grid of assignable boxes. Dropping something
   * in shifts everything after it along by one; it never leaves a hole.
   */
  static _orderedFor(actor) {
    const { order, hidden } = ActionBar._readLayout(actor);
    const hide = new Set(hidden);
    const eligible = ActionBar._actionsFor(actor);
    const remaining = new Map(eligible.map(i => [i.id, i]));
    const list = [];

    // Whatever was arranged by hand, in the arranged order, skipping anything
    // that has since left the creature.
    for (const id of order) {
      if (hide.has(id)) { remaining.delete(id); continue; }
      const item = remaining.get(id);
      if (!item) continue;
      list.push(item);
      remaining.delete(id);
    }
    // Then everything the creature has picked up since, automatically sorted.
    for (const item of remaining.values()) {
      if (hide.has(item.id)) continue;
      list.push(item);
    }
    return list;
  }

  /** Write an arrangement back to the creature. Returns true if anything changed. */
  static async _saveLayout(actor, order, hidden) {
    if (!actor) return false;
    // ⚠️ A PLAYER CANNOT WRITE TO A CREATURE THEY DO NOT OWN. Say so out loud
    // rather than letting the update fail into a console nobody is reading.
    if (!actor.isOwner) {
      ui.notifications?.warn(`You do not have permission to rearrange ${actor.name}'s action bar.`);
      return false;
    }
    const before = ActionBar._readLayout(actor);
    const same = before.order.join("|") === order.join("|")
              && before.hidden.join("|") === hidden.join("|");
    if (same) return false;
    try {
      await actor.setFlag(MODULE_ID, LAYOUT_FLAG, { order, hidden });
      return true;
    } catch (err) {
      console.error(`${LOG} | could not save the layout for ${actor.name}:`, err);
      ui.notifications?.error(`Could not save that arrangement — see the console.`);
      return false;
    }
  }

  /**
   * Drop `item` into slot `index`, pushing everything from there rightward.
   *
   * ⚠️ THE DROPPED ITEM TAKES THE SLOT YOU DROPPED IT ON. It never bounces
   * somewhere else. The one thing that moves is everything after it.
   */
  static async _placeAt(actor, item, index) {
    const ids = ActionBar._orderedFor(actor).map(i => i.id);
    const from = ids.indexOf(item.id);

    let to = Math.max(0, Math.min(index, ids.length));
    // ⚠️ NO "INSERT BEFORE THE TARGET" ADJUSTMENT HERE, DELIBERATELY.
    // The textbook list-reorder decrements the destination when the item came
    // from the left, because the removal shifted everything down by one. That
    // is right for "insert before that item" and WRONG for Johnny's rule, which
    // is "the item you drop takes the exact slot you dropped it on". With the
    // decrement, dragging slot 2 onto slot 5 landed it in slot 4. Caught by the
    // bench test in tools/action-bar-order-check.mjs, not by reading the code.
    if (from !== -1) ids.splice(from, 1);
    to = Math.max(0, Math.min(to, ids.length));
    ids.splice(to, 0, item.id);

    const { hidden } = ActionBar._readLayout(actor);
    const changed = await ActionBar._saveLayout(actor, ids, hidden.filter(h => h !== item.id));
    if (changed) ActionBar.render();
  }

  /** Take an item off the bar. It stays on the sheet; it just stops being drawn. */
  static async _removeFromBar(actor, item) {
    const ids = ActionBar._orderedFor(actor).map(i => i.id).filter(id => id !== item.id);
    const { hidden } = ActionBar._readLayout(actor);
    // ⚠️ IT HAS TO BE REMEMBERED AS OFF. Without the hidden list the automatic
    // fill would put it straight back in the next gap and the removal would look
    // like it did nothing at all.
    const next = hidden.includes(item.id) ? hidden : [...hidden, item.id];
    const changed = await ActionBar._saveLayout(actor, ids, next);
    if (!changed) return;
    // ⚠️ NEVER TAKE A SLOT AWAY IN SILENCE. A box that empties itself with
    // no explanation reads as a bug, and the way back is not guessable.
    ui.notifications?.info(`${item.name} is off ${actor.name}'s action bar. `
      + `Drag it back from the sheet, or right-click any slot to reset the bar.`);
    ActionBar.render();
  }

  /** Throw away every hand arrangement and go back to the automatic order. */
  static async _resetLayout(actor) {
    if (!actor?.isOwner) {
      ui.notifications?.warn(`You do not have permission to change ${actor?.name}'s action bar.`);
      return;
    }
    try {
      await actor.unsetFlag(MODULE_ID, LAYOUT_FLAG);
      ui.notifications?.info(`${actor.name}'s action bar is back to automatic.`);
      ActionBar.render();
    } catch (err) {
      console.error(`${LOG} | could not reset the layout for ${actor.name}:`, err);
      ui.notifications?.error("Could not reset that bar — see the console.");
    }
  }

  /* ── The creature on show ─────────────────────────────────────────────── */

  /**
   * Whose bar is this? The selected token, and nothing else.
   *
   * ⚠️ DELIBERATELY NOT "the current combatant". Foundry already selects a
   * player's token when their turn begins, so selection covers that case on its
   * own — while a GM who clicks a different creature mid-turn to check something
   * expects to see THAT creature, not whoever the tracker says is up.
   */
  /* ── Where he put it ──────────────────────────────────────────────────── */

  /**
   * The bar's offset from where it normally sits, remembered per user.
   *
   * ⚠️🔴 AN OFFSET, NOT A POSITION, AND THE FIRST VERSION GOT THIS WRONG.
   * Johnny, 2026-09-03: "as soon as I went to move it, it jumped over to the
   * right." It did. Switching the bar to `position: fixed` took it out of the
   * flow, so it lost the parent width it was centring itself inside and
   * snapped to its own content width before the drag had moved a pixel.
   *
   * A transform moves it without changing its layout at all. Nothing reflows,
   * nothing recentres, and the bar starts the drag exactly where it was sitting.
   *
   * ⚠️ PER USER, NOT PER SCENE. Per scene means moving it once on every map and
   * a bar that lives somewhere different on each board.
   */
  static _readPos() {
    try {
      const raw = JSON.parse(localStorage.getItem("ace-qol-action-bar-pos") ?? "null");
      if (!raw || !Number.isFinite(raw.dx) || !Number.isFinite(raw.dy)) return null;
      // ⚠️ CLAMPED ON READ, NOT ONLY ON WRITE. An offset saved on the desktop's
      // screen can put the bar off the edge of the camp laptop, and a bar he
      // cannot see is one he cannot drag back.
      const dx = Math.max(-window.innerWidth + 120, Math.min(raw.dx, window.innerWidth - 120));
      const dy = Math.max(-window.innerHeight + 80, Math.min(raw.dy, window.innerHeight - 80));
      return { dx, dy };
    } catch (_) { return null; }
  }

  static _writePos(pos) {
    try {
      if (pos) localStorage.setItem("ace-qol-action-bar-pos", JSON.stringify(pos));
      else localStorage.removeItem("ace-qol-action-bar-pos");
    } catch (err) {
      console.warn(`${LOG} | could not remember where the bar was moved to:`, err);
    }
  }

  /** Put it back where it started. */
  static recentre() {
    ActionBar._writePos(null);
    if (ActionBar._el) ActionBar._el.style.transform = "";
    ui.notifications?.info("Action bar back in its usual place.");
  }

  static _applyPos(el) {
    const pos = ActionBar._readPos();
    el.style.transform = pos ? `translate(${pos.dx}px, ${pos.dy}px)` : "";
  }

  /**
   * Drag it by the portrait.
   *
   * ⚠️ THE PORTRAIT, NOT THE WHOLE BAR. Every slot is a button and a drop
   * target; a draggable bar would mean a slightly-moved click on a weapon drags
   * the bar instead of swinging it.
   *
   * ⚠️ AND THE CURSOR IS LEFT ALONE. The first version set it to grab and
   * grabbing. Johnny: "I don't like the little hand because we already have a
   * little hand when we're hovering over the portrait." Two hands fighting over
   * one element is worse than none.
   */
  static _wireDrag(el) {
    const handle = el.querySelector(".ace-qol-ab-portrait");
    if (!handle || handle.dataset.aceDrag) return;
    handle.dataset.aceDrag = "1";

    let start = null;
    handle.addEventListener("mousedown", (ev) => {
      if (ev.button !== 0) return;
      const held = ActionBar._readPos() ?? { dx: 0, dy: 0 };
      start = { x: ev.clientX, y: ev.clientY, dx: held.dx, dy: held.dy, moved: false };
    });

    const onMove = (ev) => {
      if (!start) return;
      const mx = ev.clientX - start.x;
      const my = ev.clientY - start.y;
      // ⚠️ A DRAG IS NOT A CLICK. The portrait opens things, so this only takes
      // over once the mouse has actually travelled.
      if (!start.moved && Math.hypot(mx, my) < 5) return;
      start.moved = true;
      el.style.transform = `translate(${start.dx + mx}px, ${start.dy + my}px)`;
    };

    const onUp = (ev) => {
      if (!start) return;
      if (start.moved) {
        ActionBar._writePos({ dx: Math.round(start.dx + (ev.clientX - start.x)),
                              dy: Math.round(start.dy + (ev.clientY - start.y)) });
      }
      start = null;
    };

    // ⚠️ ON THE DOCUMENT, or letting go outside the bar leaves it stuck to the
    // mouse and every later move drags it again.
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }

  static _currentToken() {
    const controlled = canvas?.tokens?.controlled ?? [];
    return controlled.length === 1 ? controlled[0] : null;
  }

  /* ── Rendering ────────────────────────────────────────────────────────── */

  static _ensureElement() {
    if (ActionBar._el?.isConnected) return ActionBar._el;
    const hotbar = document.getElementById("hotbar");
    if (!hotbar?.parentElement) return null;

    const el = document.createElement("div");
    el.id = "ace-qol-action-bar";
    el.classList.add("ace-qol-ab");
    // Above Foundry's bar, never inside it — see the header.
    hotbar.parentElement.insertBefore(el, hotbar);
    ActionBar._el = el;
    return el;
  }

  static _renderDebounced() {
    if (ActionBar._renderTimer) clearTimeout(ActionBar._renderTimer);
    ActionBar._renderTimer = setTimeout(() => {
      ActionBar._renderTimer = null;
      ActionBar.render();
    }, 60);
  }

  static render() {
    try {
      const el = ActionBar._ensureElement();
      if (!el) return;

      const token = ActionBar._currentToken();
      const actor = token?.actor;
      if (!actor) {
        el.classList.remove("ace-qol-ab-visible");
        el.replaceChildren();
        ActionBar._actorUuid = null;
        return;
      }
      ActionBar._actorUuid = actor.uuid;
      el.classList.add("ace-qol-ab-visible");

      const esc = foundry.utils.escapeHTML;
      const ordered = ActionBar._orderedFor(actor);

      // ⚠️ THE TAB DECIDES WHAT IS DRAWN, and All is the bar exactly as it was.
      const tabs = ActionBar._tabsFor(actor, ordered);
      const state = ActionBar._currentTab(actor.id, tabs);
      const active = tabs.find(t => t.id === state.tab) ?? null;

      let pool = active?.items ?? ordered;
      let levels = [];
      if (active?.levels) {
        levels = ActionBar._spellLevels(active.items);
        // Default to the lowest level present rather than showing every spell
        // at once, which is the pile he cannot read.
        const pick = levels.find(l => l.level === state.level) ?? levels[0] ?? null;
        state.level = pick?.level ?? null;
        pool = pick?.items ?? [];
      } else {
        state.level = null;
      }
      ActionBar._tabState.set(actor.id, { tab: state.tab, level: state.level });

      const shown   = pool.slice(0, SLOT_COUNT);
      const overflow = Math.max(0, pool.length - SLOT_COUNT);
      // ⚠️ WARM THE DESCRIPTIONS BEFORE HE CAN HOVER ONE. The sync reader is
      // honest on a cold cache — it strips the enricher syntax rather than
      // showing it — but stripping loses the creature's name, and the name is
      // the whole thing he asked for. Priming here means the first hover after
      // a redraw already has the enriched text.
      try { acePrimeDescriptions(actor?.items ?? []); }
      catch (err) { console.warn(`${LOG} | could not pre-read the descriptions:`, err); }

      const badges  = ActionBar._badgesFor(actor);
      const hp      = actor.system?.attributes?.hp ?? {};
      const ac      = actor.system?.attributes?.ac?.value ?? "—";

      const combatant = game.combat?.combatants?.find(c => c.tokenId === token.id) ?? null;
      const isMyTurn  = !!combatant && game.combat?.combatant?.id === combatant.id;
      const needsInit = !!combatant && combatant.initiative === null;

      // ⚠️🔴 SHRINK TO WHAT IS THERE, AND KEEP SLOT 1 WHERE IT WAS. Johnny,
      // 2026-09-03: "if we're not using the room, then why not shrink it? In
      // fact, I don't know why we don't do that with all of them."
      //
      // A Cloud Giant has five things and was getting twenty boxes, fifteen of
      // them dashed and empty, which reads as a bar that failed to load.
      //
      // ⚠️ THE COUNT IS ROUNDED UP TO A WHOLE ROW, AND ONE SPARE SLOT IS KEPT.
      // Two reasons, both learned rather than guessed. A ragged right edge on a
      // ten-wide grid looks broken rather than tidy. And the empty slots are the
      // drop targets — shrinking to exactly the used count would leave nowhere
      // to drag a new action onto, which is how a feature disappears without
      // anybody removing it.
      //
      // ⚠️ AND THE BAR IS LEFT-ALIGNED SO SLOT 1 NEVER MOVES. A bar that
      // re-centres itself on every selection puts a different button under the
      // same pixel each time, which is worse than the wasted space it saves.
      // ⚠️🔴 BOTH ROWS ALWAYS. I shrank this to one row for a creature with five
      // actions and took his top row away with it. Johnny, 2026-09-03: "I've
      // lost the top row bars. I want them up there... I want the two rows still
      // there."
      //
      // The empty slots are not waste, they are the drop targets and the shape
      // he has learned. Shrinking a bar he arranges by hand moves every slot he
      // put somewhere on purpose.
      // ⚠️🔴 THE SLOT GROWS SIDEWAYS WHEN THERE IS ROOM, AND THE NAME IS WHY.
      //
      // Johnny, 2026-09-03: "You can only read so much in those little things...
      // I know it says Power Word something, but is it Kill?" A 50px square
      // gives about nine characters and cuts the rest, which is useless on
      // exactly the spells whose names differ at the end.
      //
      // ⚠️ WIDER, NOT TALLER. A bigger square would push the bar up over the
      // canvas and still leave a cramped strip of text under the picture. The
      // icon keeps its 48px, the name takes the rest of the width, and the bar's
      // height never changes.
      //
      // ⚠️ AND IT COLLAPSES BACK. Eight or fewer in the tab you are looking at
      // gets the wide rows; more returns to the squares with the hover carrying
      // the full name. Twelve ninth-level spells are squares, a Cloud Giant's
      // five are wide. Same bar, sized to what is in front of you.
      //
      // ⚠️ BOTH ROWS EITHER WAY. Shrinking to one row took his top row away on
      // 2026-09-03, and the empty slots are the drop targets.
      const wide = shown.length > 0 && shown.length <= WIDE_MAX;
      const slotCount = wide ? WIDE_MAX : SLOT_COUNT;

      const slotHtml = Array.from({ length: slotCount }, (_, i) => {
        const item = shown[i];
        if (!item) {
          // ⚠️ EMPTY SLOTS ARE STILL DROP TARGETS, so the index has to be here.
          return `<div class="ace-qol-ab-slot ace-qol-ab-empty" data-index="${i}"></div>`;
        }
        const uses = item.system?.uses ?? {};
        const showUses = Number.isFinite(uses.max) && uses.max > 0;
        const spent = showUses ? `<span class="ace-qol-ab-uses">${uses.value ?? 0}/${uses.max}</span>` : "";
        const lvl = item.type === "spell" && item.system?.level > 0
          ? `<span class="ace-qol-ab-lvl">${item.system.level}</span>` : "";
        const readOnly = ActionBar._isReadOnlySlot(actor, item) ? " ace-qol-ab-read" : "";
        return `<div class="ace-qol-ab-slot${readOnly}" draggable="true"
                     data-item-id="${item.id}" data-index="${i}" data-type="${esc(item.type)}"
                     data-tooltip-html="${esc(ActionBar._tooltipFor(item))}">
                  <img src="${esc(item.img)}" alt="" draggable="false">
                  <span class="ace-qol-ab-name">${esc(item.name)}</span>${spent}${lvl}
                </div>`;
      }).join("");

      // ⚠️🔴 THE FLOATING ×2 IS GONE. Johnny, 2026-09-03: "that times two down
      // there does not do me anything at all. I don't even know if that's for
      // Mount Multi-Attack." Fair — dnd5e already prints ×2 beside Multiattack
      // on the sheet, so a second identical badge floating over the bar with no
      // label attached to it was a number with no question. The count still
      // reads where it means something: on the Multiattack entry itself and in
      // its tooltip, both of which say what they are counting.
      const badgeHtml = badges.map(b =>
        `<div class="ace-qol-ab-badge" data-tooltip="${esc(b.name)}"><img src="${esc(b.img ?? "")}" alt=""></div>`
      ).join("");

      // ⚠️ NEVER SILENTLY HIDE THE REST. The bar used to stop at ten and say
      // nothing; 258 creatures in Johnny's world have more than ten things they
      // can do, and Strahd has 39. A count is not a pager — he explicitly does
      // not want sixty macros down there — but silence was the actual bug.
      const moreHtml = overflow
        ? `<div class="ace-qol-ab-more" data-tooltip="${overflow} more action${overflow === 1 ? "" : "s"} on the sheet. Drag one in to put it on the bar.">+${overflow}</div>`
        : "";

      // ⚠️ ABOVE THE SLOTS, per his answer on 2026-09-03: "yes, I want the tabs
      // above." Easier to hit than a left rail, at the cost of a little height.
      const tabHtml = tabs.length
        ? `<div class="ace-qol-ab-tabs">${tabs.map(t =>
            `<button type="button" class="ace-qol-ab-tab${t.id === state.tab ? " ace-qol-ab-tab-on" : ""}"
                     data-tab="${esc(t.id)}">${esc(t.label)}<span>${t.items.length}</span></button>`
          ).join("")}</div>`
        : "";

      const levelHtml = levels.length > 1
        ? `<div class="ace-qol-ab-levels">${levels.map(l =>
            `<button type="button" class="ace-qol-ab-level${l.level === state.level ? " ace-qol-ab-level-on" : ""}"
                     data-level="${l.level}">${esc(l.label)}<span>${l.items.length}</span></button>`
          ).join("")}</div>`
        : "";

      // ⚠️ OUTSIDE THE BAR, NOT IN IT. Johnny, 2026-09-03: "I don't like that
      // little settings bar being inside the bar itself... I'd rather have that
      // on the outside when you hover over the bar." It sits off the right edge
      // and only appears on hover, so it costs no width and no attention.
      el.innerHTML = `
        <button type="button" class="ace-qol-ab-gear"
                data-tooltip="Drag the portrait to move this bar. Click to put it back.">
          <i class="fas fa-gear"></i>
        </button>
        <div class="ace-qol-ab-strip">${badgeHtml}</div>
        ${tabHtml}${levelHtml}
        <div class="ace-qol-ab-main">
          <div class="ace-qol-ab-portrait" data-tooltip="${esc(actor.name)}">
            <img src="${esc(actor.img)}" alt="">
            <div class="ace-qol-ab-vitals">
              <span class="ace-qol-ab-hp">${hp.value ?? "—"}<span>/${hp.max ?? "—"}</span></span>
              <span class="ace-qol-ab-ac">${ac}</span>
            </div>
            <!-- The MULTI badge was here. It is a slot on the bar now, per
                 Johnny 2026-09-03: "I do not need it on the portrait." -->
            ${combatant && !needsInit
              ? `<div class="ace-qol-ab-init" data-tooltip="Initiative ${combatant.initiative}">${combatant.initiative}</div>`
              : ""}
            <div class="ace-qol-ab-dice" data-tooltip="Left-click: roll initiative &nbsp;·&nbsp; Right-click: ability &amp; skill checks">
              <i class="fas fa-dice-d20"></i>
            </div>
          </div>
          <div class="ace-qol-ab-slots${wide ? " ace-qol-ab-slots-wide" : ""}">${slotHtml}</div>
          ${moreHtml}
          <div class="ace-qol-ab-turn">
            ${isMyTurn ? `<button type="button" class="ace-qol-ab-endturn" data-tooltip="End this creature's turn">
                            <i class="fas fa-hourglass-end"></i><span>NEXT TURN</span></button>` : ""}
          </div>
        </div>`;

      ActionBar._wire(el, actor, combatant);
      ActionBar._wireDragAndDrop(el, actor);
      // ⚠️ RE-APPLIED ON EVERY RENDER. `innerHTML` is rewritten each time the
      // selection changes, so the drag handle and the gear are new elements and
      // the inline position on the container has to be put back with them.
      ActionBar._applyPos(el);
      ActionBar._wireDrag(el);
      el.querySelector(".ace-qol-ab-gear")?.addEventListener("click", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        ActionBar.recentre();
      });
    } catch (err) {
      console.error(`${LOG} | render failed:`, err);
    }
  }

  static _wire(el, actor, combatant) {
    // ── Tabs and spell levels ───────────────────────────────────────────
    // ⚠️ REDRAW, DO NOT HIDE. Showing every tab's slots and toggling display
    // would keep 50 spells in the DOM with 50 tooltips attached to them for a
    // creature the GM is only glancing at.
    for (const btn of el.querySelectorAll(".ace-qol-ab-tab")) {
      btn.addEventListener("click", (ev) => {
        ev.preventDefault();
        ActionBar._tabState.set(actor.id, { tab: btn.dataset.tab, level: null });
        ActionBar.render();
      });
    }
    for (const btn of el.querySelectorAll(".ace-qol-ab-level")) {
      btn.addEventListener("click", (ev) => {
        ev.preventDefault();
        const held = ActionBar._tabState.get(actor.id) ?? { tab: "spells" };
        ActionBar._tabState.set(actor.id, { tab: held.tab, level: Number(btn.dataset.level) });
        ActionBar.render();
      });
    }

    // ── Use an action ───────────────────────────────────────────────────
    for (const slot of el.querySelectorAll(".ace-qol-ab-slot[data-item-id]")) {
      slot.addEventListener("click", async (ev) => {
        ev.preventDefault();
        const item = actor.items.get(slot.dataset.itemId);
        if (!item) return ui.notifications?.warn("That item is no longer on this creature.");

        // ⚠️ READ, NEVER PRESSED — AND IT LOOKS THAT WAY, WHICH IS THE POINT.
        // Multiattack and the passives carry no click behaviour at all. The
        // first cut fired a notification saying nothing had happened, which is
        // a worse answer than a slot that never looked pressable: it makes him
        // click it to find out, once per creature, forever.
        if (ActionBar._isReadOnlySlot(actor, item)) return;


        try {
          // ⚠️ ASK BEFORE SWINGING SOMETHING THEY ARE NOT HOLDING, but only
          // in a live fight. Out of combat this never fires and the weapon is
          // simply equipped on the way past - nobody counts object interactions
          // while the party is walking down a corridor.
          if (WeaponSwap.shouldPrompt(actor, item)) {
            const ready = await WeaponSwap.promptAndEquip(actor, item);
            if (!ready) return;         // backed out, or the swap ate their action
          } else if (actor.type === "character" && item.type === "weapon"
                     && item.system?.equipped === false && !item.system?.container) {
            await item.update({ "system.equipped": true });
          }
        } catch (err) {
          console.error(`${LOG} | could not ready "${item.name}":`, err);
          ui.notifications?.error(`${item.name} could not be readied — see the console.`);
          return;
        }
        try { await item.use(); }
        catch (err) {
          console.error(`${LOG} | using "${item.name}" failed:`, err);
          ui.notifications?.error(`${item.name} could not be used — see the console.`);
        }
      });
      // ── Middle-click pins the hover so it can be read and scrolled ──────
      //
      // ⚠️ A HOVER CANNOT BE SCROLLED, BECAUSE REACHING FOR THE WHEEL MOVES THE
      // MOUSE OFF THE SLOT AND THE TOOLTIP GOES. Prismatic Spray is nine
      // paragraphs. Foundry's own locked tooltips take pointer events and stay
      // until dismissed, which is the mechanism dnd5e uses for exactly this.
      slot.addEventListener("auxclick", (ev) => {
        if (ev.button !== 1) return;          // middle only
        ev.preventDefault();
        ev.stopPropagation();
        try {
          const item = actor.items.get(slot.dataset.itemId);
          if (!item) return;
          const box = slot.getBoundingClientRect();
          game.tooltip?.createLockedTooltip?.(
            { top: `${Math.round(box.top)}px`, left: `${Math.round(box.right + 8)}px` },
            ActionBar._tooltipFor(item),
            { cssClass: "ace-qol-ab-tip-locked" }
          );
        } catch (err) {
          // ⚠️ NAMED. "The pin does nothing" and "this Foundry has no locked
          // tooltips" must not look the same.
          console.warn(`${LOG} | could not pin that tooltip:`, err);
          ui.notifications?.warn("This Foundry version cannot pin a tooltip open.");
        }
      });
      // Middle-click on a link-ish element scrolls or opens a tab by default.
      slot.addEventListener("mousedown", (ev) => { if (ev.button === 1) ev.preventDefault(); });

      // ⚠️ RIGHT-CLICK IS THE SHEET'S OWN MENU, NOT A SHORTCUT TO THE SHEET.
      // Johnny, 2026-08-23: "it should have a pop-up... where I can edit it,
      // just like anything, or tweak it, just like I would be able to from the
      // sheet, whatever that sheet has for a dropdown."
      slot.addEventListener("contextmenu", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        const item = actor.items.get(slot.dataset.itemId);
        if (item) ActionBar._openItemMenu(el, actor, item, slot);
      });
    }

    // ── The dice on the portrait ────────────────────────────────────────
    // ⚠️ ALWAYS PRESENT, ALWAYS LIVE. The first cut only drew this when the
    // creature had no initiative yet, so the moment one was rolled the control
    // vanished — and Johnny's first report was "it doesn't show me initiative or
    // anything like that" (2026-08-14). A control that disappears after one use
    // is indistinguishable from a broken one. Rerolling is explicitly allowed,
    // which is what BG3 did and why its version kept working.
    const dice = el.querySelector(".ace-qol-ab-dice");
    if (dice) {
      dice.addEventListener("click", async (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        try {
          if (!game.combat) {
            ui.notifications?.warn("There is no combat running — start one first.");
            return;
          }
          // ⚠️ NAMED, NOT OPTIONAL-CHAINED. `?.()` on a method that no longer
          // exists returns undefined instead of throwing — that is exactly how
          // six dnd5e API renames hid for months (2026-08-12). If the system
          // drops this, we want a real error, not a dead button.
          if (typeof actor.rollInitiativeDialog === "function") {
            await actor.rollInitiativeDialog({ rerollInitiative: true });
          } else if (combatant && typeof combatant.rollInitiative === "function") {
            await combatant.rollInitiative();
          } else {
            throw new Error("no initiative method on this actor or combatant");
          }
        } catch (err) {
          console.error(`${LOG} | initiative roll failed for ${actor.name}:`, err);
          ui.notifications?.error(`Could not roll initiative for ${actor.name} — see the console.`);
        }
      });

      dice.addEventListener("contextmenu", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        ActionBar._openCheckMenu(el, actor);
      });
    }

    // ── End turn ────────────────────────────────────────────────────────
    el.querySelector(".ace-qol-ab-endturn")?.addEventListener("click", async (ev) => {
      ev.preventDefault();
      try { await game.combat?.nextTurn(); }
      catch (err) {
        console.error(`${LOG} | advancing the turn failed:`, err);
        ui.notifications?.error("Could not advance the turn — see the console.");
      }
    });
  }

  /* ── Dragging things in, out and around ───────────────────────────────── */

  /**
   * Foundry hands drag payloads over as JSON on the plain-text channel. Read it
   * directly rather than through the TextEditor helper, whose namespace moved in
   * V13 — a helper that quietly returns undefined is worse than no helper.
   */
  static _dragPayload(ev) {
    try {
      const raw = ev.dataTransfer?.getData("text/plain");
      if (raw) return JSON.parse(raw);
    } catch (_) { /* not ours, or not JSON */ }
    return null;
  }

  /**
   * Resolve a dropped payload to an item that is ACTUALLY ON THIS CREATURE.
   *
   * ⚠️ MATCH BY ID ON THE LOCAL ACTOR, NOT BY UUID. An unlinked token's copy of
   * a creature keeps the same item ids as the base actor, so a GM dragging from
   * the base sheet onto a token's bar still lands on the right item. Anything
   * that does not resolve locally is somebody else's item and is refused.
   */
  static _resolveDropped(actor, payload) {
    if (!payload || payload.type !== "Item") return null;
    // ⚠️ NEVER CALL A FOUNDRY GLOBAL BARE. V13 keeps this on the utils
    // namespace; the bare global is the deprecated alias and is what breaks
    // first. Named, with a fallback, so a rename is a real error and not a
    // silent "no item here".
    const resolve = foundry?.utils?.fromUuidSync
      ?? (typeof fromUuidSync === "function" ? fromUuidSync : null);
    let dropped = null;
    try { dropped = (resolve && payload.uuid) ? resolve(payload.uuid) : null; }
    catch (_) { dropped = null; }
    const id = dropped?.id ?? payload.id ?? null;
    if (!id) return null;
    return actor.items.get(id) ?? null;
  }

  static _wireDragAndDrop(el, actor) {
    const slots = el.querySelectorAll(".ace-qol-ab-slot");

    for (const slot of slots) {
      // ── Picking a slot up ─────────────────────────────────────────────
      slot.addEventListener("dragstart", (ev) => {
        const item = actor.items.get(slot.dataset.itemId);
        if (!item) return;
        // Announced as a plain Item so dropping it on Foundry's own hotbar still
        // makes a macro, exactly as dragging from the sheet does.
        ev.dataTransfer?.setData("text/plain", JSON.stringify({
          type: "Item", uuid: item.uuid, aceActionBar: true
        }));
        ev.dataTransfer.effectAllowed = "all";
        slot.classList.add("ace-qol-ab-dragging");
      });

      slot.addEventListener("dragend", async (ev) => {
        slot.classList.remove("ace-qol-ab-dragging");
        for (const s of slots) s.classList.remove("ace-qol-ab-over");
        // ── Dragged clean off the bar → take it off ─────────────────────
        //
        // ⚠️ DECIDED FROM THE POINTER, NOT FROM `dropEffect`. Browsers disagree
        // about what dropEffect says when a drag ends on nothing, and a wrong
        // reading here would delete slots the user meant to keep. The pointer
        // position against the bar's own box is unambiguous.
        try {
          // ⚠️ ONLY THE MAP COUNTS AS "OFF THE BAR". Ending a drag anywhere
          // else must leave the slot alone: pressing Escape mid-drag still fires
          // dragend at the last cursor position, so a looser test would empty a
          // slot every time somebody changed their mind. Dropping onto Foundry's
          // macro bar means "make me a macro", which is its business, not ours.
          const board = document.getElementById("board");
          const bb = board?.getBoundingClientRect();
          if (!bb) return;
          const onMap = ev.clientX >= bb.left && ev.clientX <= bb.right
                     && ev.clientY >= bb.top  && ev.clientY <= bb.bottom;
          if (!onMap) return;
          const box = el.getBoundingClientRect();
          if (ev.clientX >= box.left && ev.clientX <= box.right
           && ev.clientY >= box.top  && ev.clientY <= box.bottom) return;
          const hotbar = document.getElementById("hotbar")?.getBoundingClientRect();
          if (hotbar && ev.clientX >= hotbar.left && ev.clientX <= hotbar.right
                     && ev.clientY >= hotbar.top  && ev.clientY <= hotbar.bottom) return;
          const item = actor.items.get(slot.dataset.itemId);
          if (item) await ActionBar._removeFromBar(actor, item);
        } catch (err) {
          console.warn(`${LOG} | could not finish that drag:`, err);
        }
      });

      // ── Something hovering over a slot ────────────────────────────────
      slot.addEventListener("dragover", (ev) => {
        ev.preventDefault();
        ev.dataTransfer.dropEffect = "move";
        slot.classList.add("ace-qol-ab-over");
      });
      slot.addEventListener("dragleave", () => slot.classList.remove("ace-qol-ab-over"));

      // ── The drop ──────────────────────────────────────────────────────
      slot.addEventListener("drop", async (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        slot.classList.remove("ace-qol-ab-over");
        try {
          const payload = ActionBar._dragPayload(ev);
          const item = ActionBar._resolveDropped(actor, payload);
          if (!item) {
            if (payload?.type === "Item") {
              ui.notifications?.warn(`The action bar only holds ${actor.name}'s own items.`);
            }
            return;
          }
          // Refuse out loud rather than accepting a drop that renders nothing.
          // Asks the RULE, not the finished list, so a hand-placed duplicate is
          // allowed even though the automatic fill would have deduplicated it.
          const why = ActionBar._ineligible(actor, item);
          if (why) { ui.notifications?.warn(why); return; }
          const index = Number(slot.dataset.index);
          await ActionBar._placeAt(actor, item, Number.isFinite(index) ? index : SLOT_COUNT);
        } catch (err) {
          console.error(`${LOG} | drop failed:`, err);
          ui.notifications?.error("That could not be placed on the bar — see the console.");
        }
      });
    }

    // The gaps between slots must not silently swallow a drop.
    const grid = el.querySelector(".ace-qol-ab-slots");
    grid?.addEventListener("dragover", (ev) => ev.preventDefault());
  }

  /* ── The right-click menu on a slot ───────────────────────────────────── */

  /**
   * The same actions the sheet offers on an item, on the bar.
   *
   * ⚠️ BUILT WITH dnd5e's OWN LABELS AND OWN PUBLIC METHODS, and it fires
   * dnd5e's own `getItemContextOptions` hook, so anything another module adds to
   * the sheet's menu turns up here too. The system's `_getContextOptions` itself
   * is bound to a rendered sheet — it needs `this.app`, `this.actor` and a live
   * row element — so it cannot be borrowed directly. Reusing the vocabulary is
   * the next best thing: the wording always matches what he sees on the sheet,
   * in whatever language he is running.
   */
  static _itemMenuEntries(actor, item) {
    const t = (k) => game.i18n.localize(k);
    const owner = () => item.isOwner;

    const entries = [{
      name: "DND5E.ContextMenuActionEdit",
      icon: '<i class="fa-solid fa-edit fa-fw"></i>',
      condition: owner,
      callback: () => item.sheet?.render(true)
    }, {
      name: "DND5E.DisplayCard",
      icon: '<i class="fa-solid fa-message fa-fw"></i>',
      condition: () => typeof item.displayCard === "function",
      callback: () => item.displayCard()
    }, {
      name: `DND5E.ContextMenuAction${item.system?.equipped ? "Unequip" : "Equip"}`,
      icon: '<i class="fa-solid fa-shield-alt fa-fw"></i>',
      condition: () => ("equipped" in (item.system ?? {})) && item.isOwner,
      callback: () => item.update({ "system.equipped": !item.system.equipped }),
      group: "state"
    }, {
      name: `DND5E.ContextMenuAction${item.system?.attuned ? "Unattune" : "Attune"}`,
      icon: '<i class="fa-solid fa-sun fa-fw"></i>',
      condition: () => !!item.system?.attunement && item.isOwner,
      callback: () => item.update({ "system.attuned": !item.system.attuned }),
      group: "state"
    }, {
      name: `DND5E.ContextMenuAction${item.system?.prepared ? "Unprepare" : "Prepare"}`,
      icon: '<i class="fa-solid fa-book fa-fw"></i>',
      condition: () => {
        if (item.type !== "spell" || !item.isOwner) return false;
        const prepares = CONFIG.DND5E?.spellcasting?.[item.system?.method]?.prepares;
        const always = CONFIG.DND5E?.spellPreparationStates?.always?.value;
        return !!prepares && item.system?.prepared !== always && !item.hasRecharge;
      },
      callback: () => {
        const on  = CONFIG.DND5E?.spellPreparationStates?.prepared?.value ?? true;
        const off = CONFIG.DND5E?.spellPreparationStates?.unprepared?.value ?? false;
        return item.update({ "system.prepared": item.system?.prepared === on ? off : on });
      },
      group: "state"
    }, {
      name: `DND5E.ContextMenuAction${item.isOnCooldown ? "Charge" : "ExpendCharge"}`,
      icon: '<i class="fa-solid fa-bolt fa-fw"></i>',
      condition: () => !!item.hasRecharge && item.isOwner,
      callback: () => item.update({ "system.uses.spent": 1 - (item.system?.uses?.spent ?? 0) }),
      group: "state"
    }, {
      name: "DND5E.Identify",
      icon: '<i class="fa-solid fa-magnifying-glass fa-fw"></i>',
      condition: () => ("identified" in (item.system ?? {})) && !item.system.identified && item.isOwner,
      callback: () => item.update({ "system.identified": true }),
      group: "state"
    }, {
      name: "DND5E.ContextMenuActionDuplicate",
      icon: '<i class="fa-solid fa-copy fa-fw"></i>',
      condition: () => (item.canDuplicate !== false) && item.isOwner,
      callback: () => item.clone({ name: game.i18n.format("DOCUMENT.CopyOf", { name: item.name }) }, { save: true }),
      group: "action"
    }];

    // ⚠️ LET OTHER MODULES IN. This is the hook dnd5e itself fires for the
    // sheet's menu, so anything Johnny installs that extends an item's options
    // extends them here as well, for free.
    try { Hooks.callAll("dnd5e.getItemContextOptions", item, entries); }
    catch (err) { console.warn(`${LOG} | a module threw while adding menu options:`, err); }

    // ⚠️🔴 A BAR IS NOT A SHEET, AND "DELETE" MUST MEAN THE BAR.
    //
    // The first cut carried dnd5e's own Delete straight through, which destroys
    // the ITEM. Johnny went to take a spare Spiked Chain off Jeth's bar, hit
    // Delete, and got "this is permanent" — one more click and a real weapon
    // would have been gone off a character sheet mid-prep (2026-08-24). He is
    // right that this should never have been a question:
    //
    //   "If I push delete on the hot bar, it should just delete it. Don't scare
    //    people like that. BG3 HUD just deleted it because it knows it's still
    //    on the character if we want to pull it back."
    //
    // So: OURS COMES FIRST, it says "Delete from the bar", and it does it
    // instantly with no confirmation, because it destroys nothing — the item is
    // still on the sheet and can be dragged straight back. The destructive one
    // sits at the very bottom, in its own group, saying "the character sheet"
    // out loud, and it keeps its confirmation because that one really is
    // permanent. Two words apart, two groups apart, one of them harmless.
    entries.unshift({
      name: "__ace_remove",
      label: "Delete",
      icon: '<i class="fa-solid fa-xmark fa-fw"></i>',
      condition: () => actor.isOwner,
      callback: () => ActionBar._removeFromBar(actor, item),
      group: "bar"
    }, {
      name: "__ace_reset",
      label: "Reset this bar to automatic",
      icon: '<i class="fa-solid fa-rotate-left fa-fw"></i>',
      condition: () => actor.isOwner,
      callback: () => ActionBar._resetLayout(actor),
      group: "bar"
    });

    // ⚠️🔴 NOTHING ON THIS MENU DESTROYS AN ITEM. Johnny, 2026-08-24:
    // "We never want to delete something from the character sheet from the
    // action bar." dnd5e's own Delete was carried through here at first and he
    // came within one click of losing a real weapon off Jeth. A hotbar is a
    // place you rearrange things quickly and without thinking; the sheet is
    // where things are destroyed, deliberately. Do not add it back.


    return entries.filter(e => {
      try { return e.condition === undefined || e.condition(); }
      catch (_) { return false; }
    }).map(e => ({
      label: e.label ?? t(e.name),
      icon: e.icon ?? "",
      group: e.group ?? "",
      callback: e.callback
    }));
  }

  static _openItemMenu(el, actor, item, slot) {
    ActionBar._closeMenus(el);

    const entries = ActionBar._itemMenuEntries(actor, item);
    if (!entries.length) return;

    const esc = foundry.utils.escapeHTML;
    const menu = document.createElement("div");
    menu.className = "ace-qol-ab-menu";

    let lastGroup = entries[0]?.group ?? "";
    menu.innerHTML = `<div class="ace-qol-ab-menu-head">${esc(item.name)}</div>`
      + entries.map((e, i) => {
        const rule = (i > 0 && e.group !== lastGroup) ? ' ace-qol-ab-menu-rule' : "";
        const danger = e.group === "destructive" ? ' ace-qol-ab-menu-danger' : "";
        lastGroup = e.group;
        return `<div class="ace-qol-ab-menu-row${rule}${danger}" data-i="${i}">${e.icon}<span>${esc(e.label)}</span></div>`;
      }).join("");

    el.appendChild(menu);

    // Anchored over the slot it came from, clamped inside the bar so a slot on
    // the far right never opens a menu off the edge of the screen.
    try {
      const barBox = el.getBoundingClientRect();
      const slotBox = slot.getBoundingClientRect();
      const left = Math.max(0, Math.min(slotBox.left - barBox.left, barBox.width - menu.offsetWidth));
      menu.style.left = `${left}px`;
      menu.style.bottom = `${barBox.bottom - slotBox.top + 4}px`;
    } catch (_) { /* default corner placement is still usable */ }

    for (const row of menu.querySelectorAll(".ace-qol-ab-menu-row")) {
      row.addEventListener("click", async (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        const entry = entries[Number(row.dataset.i)];
        menu.remove();
        try { await entry?.callback?.(slot); }
        catch (err) {
          console.error(`${LOG} | "${entry?.label}" failed on ${item.name}:`, err);
          ui.notifications?.error(`That action failed — see the console.`);
        }
      });
    }

    ActionBar._dismissOnOutsideClick(menu);
  }

  /* ── The compact ability / skill list (right-click the d20) ───────────── */

  /**
   * ⚠️ METHOD NAMES ARE THE 5.x ONES, DELIBERATELY SPELLED OUT. dnd5e renamed
   * `rollAbilityTest` to `rollAbilityCheck` and `rollAbilitySave` to
   * `rollSavingThrow`; calling the old names through `?.()` returns undefined
   * instead of throwing, which is how every OverTime save silently scored zero
   * for months (2026-08-12). Missing methods raise here, loudly.
   */
  static _openCheckMenu(el, actor) {
    ActionBar._closeMenus(el);

    const esc = foundry.utils.escapeHTML;
    const abilities = Object.entries(CONFIG.DND5E?.abilities ?? {});
    const skills    = Object.entries(CONFIG.DND5E?.skills ?? {});
    const arranged  = ActionBar._readLayout(actor);
    const isArranged = arranged.order.length > 0 || arranged.hidden.length > 0;

    const menu = document.createElement("div");
    menu.className = "ace-qol-ab-checks";
    menu.innerHTML = `
      <div class="ace-qol-ab-checks-col">
        <div class="ace-qol-ab-checks-head">Abilities</div>
        ${abilities.map(([k, a]) =>
          `<div class="ace-qol-ab-check" data-kind="ability" data-key="${esc(k)}">${esc(a.label ?? k)}</div>`).join("")}
      </div>
      <div class="ace-qol-ab-checks-col ace-qol-ab-checks-skills">
        <div class="ace-qol-ab-checks-head">Skills</div>
        ${skills.map(([k, s]) =>
          `<div class="ace-qol-ab-check" data-kind="skill" data-key="${esc(k)}">${esc(s.label ?? k)}</div>`).join("")}
      </div>
      ${isArranged ? `<div class="ace-qol-ab-checks-foot" data-kind="reset">
          <i class="fa-solid fa-rotate-left fa-fw"></i> Reset this bar to automatic
        </div>` : ""}`;
    el.appendChild(menu);

    const close = () => menu.remove();

    menu.querySelector('[data-kind="reset"]')?.addEventListener("click", async (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      close();
      await ActionBar._resetLayout(actor);
    });

    for (const row of menu.querySelectorAll(".ace-qol-ab-check")) {
      row.addEventListener("click", async (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        const { kind, key } = row.dataset;
        close();
        try {
          await ActionBar._rollCheck(actor, kind, key);
        } catch (err) {
          console.error(`${LOG} | ${kind} check "${key}" failed for ${actor.name}:`, err);
          ui.notifications?.error(`That check could not be rolled — see the console.`);
        }
      });
    }

    ActionBar._dismissOnOutsideClick(menu);
  }

  /* ── Shared menu plumbing ─────────────────────────────────────────────── */

  static _closeMenus(el) {
    el.querySelector(".ace-qol-ab-checks")?.remove();
    el.querySelector(".ace-qol-ab-menu")?.remove();
  }

  /**
   * A check from the bar goes through the SAME door as one from the sheet.
   *
   * ⚠️🔴 THIS FILE USED TO OWN THE WHOLE THING — the mode read, the prompt,
   * the dice and the card — and that was the bug. Clicking Perception on the
   * character sheet is a different caller and got none of it. Johnny: "now do
   * the same for all things rolled right?" There is no doing it again for each
   * caller; the implementation moved to `check-gate.mjs`, which hooks the ROLL
   * rather than any one button.
   *
   * ⚠️ IT CALLS THE GATE DIRECTLY rather than letting the hook catch it. The
   * gate's own re-roll is made with no dialog and no card, which is precisely
   * how it recognises an engine and stands aside — so going through
   * `actor.rollSkill` from here would be caught, cancelled and re-fired for no
   * reason. One call, one roll.
   */
  static async _rollCheck(actor, kind, key) {
    const { CheckGate } = await import("./check-gate.mjs");
    return CheckGate.run(actor, kind, key);
  }

  /** Dismiss on the next click anywhere else, and on Escape. */
  static _dismissOnOutsideClick(menu) {
    setTimeout(() => {
      const away = (ev) => {
        if (menu.contains(ev.target)) return;
        menu.remove();
        document.removeEventListener("mousedown", away);
      };
      document.addEventListener("mousedown", away);
      document.addEventListener("keydown", function onEsc(ev) {
        if (ev.key !== "Escape") return;
        menu.remove();
        document.removeEventListener("keydown", onEsc);
      });
    }, 0);
  }

  /* ── Wiring ───────────────────────────────────────────────────────────── */

  static register() {
    const redraw = () => ActionBar._renderDebounced();
    // ⚠️ MATCHED BY UUID, NOT ID. Two unlinked goblins from the same stat block
    // share an actor id, so an id comparison redraws the bar for the wrong one
    // and would show one goblin's arrangement on another.
    const mine = (doc) => doc?.uuid === ActionBar._actorUuid
                       || doc?.parent?.uuid === ActionBar._actorUuid;

    Hooks.on("controlToken", redraw);
    Hooks.on("updateActor", (actor) => { if (mine(actor)) redraw(); });
    Hooks.on("updateItem",  (item)  => { if (mine(item)) redraw(); });
    Hooks.on("createItem",  (item)  => { if (mine(item)) redraw(); });
    Hooks.on("deleteItem",  (item)  => { if (mine(item)) redraw(); });
    for (const h of ["createActiveEffect", "updateActiveEffect", "deleteActiveEffect"]) {
      Hooks.on(h, (effect) => { if (mine(effect)) redraw(); });
    }
    // An unlinked token keeps its creature in a delta on the token document, so
    // arranging that goblin's bar surfaces as a token update, not an actor one.
    Hooks.on("updateToken", (doc) => { if (doc?.actor?.uuid === ActionBar._actorUuid) redraw(); });
    Hooks.on("updateActorDelta", (delta) => {
      if (delta?.parent?.actor?.uuid === ActionBar._actorUuid) redraw();
    });
    // The end-turn button and the initiative pip both depend on combat state.
    Hooks.on("updateCombat", redraw);
    Hooks.on("deleteCombat", redraw);
    Hooks.on("canvasReady", redraw);

    // ⚠️ `Hooks.once("ready")` FROM INSIDE ready NEVER FIRES. Every ACE subsystem
    // starts from the entry file's own ready handler, so waiting on `ready` here
    // waits on an event already in progress — proven live 2026-08-12, when it
    // silently killed four features at once.
    if (game.ready) ActionBar.render();
    else Hooks.once("ready", () => ActionBar.render());

    console.log(`${LOG} | online — ${ROWS} rows of ${COLUMNS}, arranged per creature`);
  }
}
