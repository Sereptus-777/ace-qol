// ─── ACE: QOL — A versatile weapon defaults to the two-handed die ───────────
//
// Johnny, 2026-09-06, after swinging a quarterstaff and getting a d6:
// *"It just, by default, rolled a d6, like I'm swinging it with one hand, which
// I exactly asked you not to do... Versatile damage should be the default
// damage, not one-handed damage."*
//
// He is right, and dnd5e is not wrong either — it is just listing the modes in
// schema order. `WeaponData.attackModes` pushes `oneHanded` before `twoHanded`
// for a versatile weapon, so the first option wins and a staff comes out at
// 1d6. dnd5e's own damage code does the right thing the moment the mode says
// two-handed: `_processDamagePart` swaps the base die for the versatile one.
// Nothing needs re-implementing. It only needs asking for.
//
// ⚠️ THE HAND HAS TO BE FREE, AND THAT IS THE WHOLE RULE. A fighter with a
// longsword and a shield is holding it in one hand and rolls a d8, exactly as
// RAW says. The same fighter who drops the shield rolls a d10. So this counts
// what else is actually in his hands rather than assuming.
//
// ⚠️ IT SETS THE DEFAULT, IT DOES NOT REMOVE THE CHOICE. The mode is set before
// the roll dialog builds, so the dialog opens with Two-Handed already selected
// and he can still pick One-Handed for the one turn he is holding a torch. A
// default he cannot override is a rule, and this is a preference.
//
// ⚠️ AND IT USES THE LOADOUT ENGINE'S HAND COUNTING, not a third copy. That one
// already knows a shield costs a hand, a two-handed weapon costs two, and that
// claws and unarmed strikes cost none — the last of which is why Johnny was
// offered "drop Unarmed Strike on the ground" the same morning.
// ──────────────────────────────────────────────────────────────────────────────

import { LoadoutEngine } from "./loadout-engine.mjs";

const MODULE_ID = "ace-qol";
const LOG = `${MODULE_ID} | versatile`;

export class VersatileDefault {

  /**
   * Should this weapon be swung in both hands?
   *
   * @returns {{yes:boolean, why:string}}
   */
  static twoHandedFor(actor, item) {
    try {
      if (!actor || item?.type !== "weapon") return { yes: false, why: "not a weapon" };
      if (!item.system?.isVersatile) return { yes: false, why: "it is not versatile" };

      const budget = LoadoutEngine._handBudget(actor);
      let used = 0;
      const holding = [];
      for (const other of LoadoutEngine._equippedHandItems(actor)) {
        if (other.id === item.id) continue;
        const cost = LoadoutEngine._gripCost(other);
        if (cost > 0) { used += cost; holding.push(`${other.name} (${cost})`); }
      }

      const free = budget - used;
      if (free >= 2) {
        return { yes: true, why: holding.length
          ? `${free} of ${budget} hands free with ${holding.join(", ")} held`
          : `both hands free` };
      }
      return { yes: false, why: `only ${Math.max(0, free)} hand free — holding ${
        holding.join(", ") || "nothing ACE can see"}` };
    } catch (err) {
      // ⚠️ A FAULT HERE MUST NOT CHANGE ANYBODY'S DAMAGE. Falling back to
      // dnd5e's own default is the safe direction, and it says so.
      console.warn(`${LOG} | could not work out the grip for "${item?.name}":`, err);
      return { yes: false, why: "the grip could not be read" };
    }
  }

  /**
   * Set the mode on a roll config, once, before dnd5e reads it.
   *
   * ⚠️ ONLY WHEN NOTHING HAS ALREADY CHOSEN. If a macro, a module or an earlier
   * dialog has set the mode deliberately, that is a decision and this is a
   * default. Overriding a stated choice is the thing that makes automation feel
   * like it is fighting you.
   */
  static _apply(config, where) {
    try {
      const activity = config?.subject;
      const item = activity?.item;
      const actor = activity?.actor ?? item?.actor;
      if (!item || !actor) return;

      const chosen = config.attackMode;
      if (chosen && chosen !== "oneHanded") return;   // somebody meant something else

      const verdict = VersatileDefault.twoHandedFor(actor, item);
      if (!verdict.yes) return;

      config.attackMode = "twoHanded";
      // ⚠️ SAID ONCE PER ITEM, NOT PER SWING. Eight attacks in a round is eight
      // identical lines nobody reads.
      const key = `${actor.id}:${item.id}`;
      if (!VersatileDefault._told.has(key)) {
        VersatileDefault._told.add(key);
        console.log(`${LOG} | ${item.name} swings two-handed by default for `
          + `${actor.name} — ${verdict.why}. Pick One-Handed in the dialog to override.`);
      }
    } catch (err) {
      console.warn(`${LOG} | could not set the grip on this ${where}:`, err);
    }
  }

  static _told = new Set();

  static register() {
    // ⚠️ BOTH ROLLS. The attack roll carries the mode into the damage roll for
    // a normal swing, but a damage roll thrown on its own — the button on a
    // chat card, a re-roll, a macro — arrives with nothing set, and that is the
    // one that was quietly producing a d6.
    Hooks.on("dnd5e.preRollAttackV2", (config) => VersatileDefault._apply(config, "attack"));
    Hooks.on("dnd5e.preRollDamageV2", (config) => VersatileDefault._apply(config, "damage"));
    console.log(`${LOG} | online — a versatile weapon defaults to its two-handed die `
      + `whenever both hands are free`);
  }
}
