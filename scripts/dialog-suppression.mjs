// ─── ACE QOL — one place that decides whether dnd5e opens a dialog ───────────
//
// Johnny, 2026-08-25: "can we not just suppress categorically across all of our
// systems the D&D 5e pop-ups... For attacks and spells and features and blah
// blah blah, whatever we're controlling."
//
// Yes. dnd5e 5.x runs EVERY roll it makes through one function, and that
// function fires one hook we can answer:
//
//     config.hookNames = [...(config.hookNames ?? []), ""];
//     for ( const hookName of config.hookNames ) {
//       Hooks.call(`dnd5e.preRoll${hookName.capitalize()}`, config, dialog, message);
//       Hooks.call(`dnd5e.preRoll${hookName.capitalize()}V2`, config, dialog, message);
//     }
//
// Because `""` is always appended, `dnd5e.preRoll` fires for attack, damage,
// save, check, skill, initiative, death save, hit die — everything. And a few
// lines later:
//
//     if ( dialog.configure === false ) { ...build the rolls directly... }
//     else { ...open the configuration dialog... }
//
// So `dialog.configure = false` is the system's OWN supported path, not a hack.
// One listener, every dialog, one rule.
//
// ═══ ⚠️🔴 WHAT THIS REPLACES, AND WHY IT HAD TO ═════════════════════════════
//
// Suppression used to happen in three unrelated ways:
//
//   1. Attacks — `dialog.configure = false` set inside the attack pipeline,
//      below several early returns that used to leak it. Fixed once by hoisting
//      it to the top, which is a fix that has to be remembered every time
//      somebody adds a return above it.
//   2. Auto-hit spell damage — a MONKEY-PATCH on dnd5e's `rollDamage`
//      prototype, switched on by a marker, and the marker was cleared BY A
//      FIVE-SECOND TIMER.
//   3. Usage cards — a separate hook returning `create: false`.
//
// Number 2 is why Magic Missile stopped working. The marker said "ACE is
// handling this cast"; five seconds later it was wiped, whether or not the cast
// had finished. Leave the spell-slot dialog open while somebody asks a question
// and the spell forgot it was ever cast. That timer was never a design
// decision - the original comment says its real job was tidying up after a
// CANCELLED cast, because nobody looked for the event that says so.
//
// This file does not patch a prototype, does not set a marker, and does not
// start a clock. It answers a question dnd5e asks it, every time, synchronously.
//
// ═══ ⚠️ THE GATE IS "IS ACE DRIVING THIS ONE", NOT "IS ACE INSTALLED" ═══════
//
// The dangerous failure is the reverse of the one being fixed: suppress a
// dialog for a roll ACE does NOT post a card for, and the player loses their
// situational-bonus box AND gets no card - a silent loss with nothing on screen.
// So every rule below is tied to the setting that turns the matching ACE
// feature on. Switch our attack pipeline off and dnd5e's dialog comes back,
// which is what "off" has to mean.
// ──────────────────────────────────────────────────────────────────────────────

import { MODULE_ID } from "./ace-qol.mjs";
import { QolSettings } from "./settings.mjs";

const LOG = "ace-qol | DialogSuppression";

/**
 * Which roll types ACE posts its own card for, and the setting that governs
 * each. A type absent from here is one we do not drive, and dnd5e keeps its
 * dialog — checks, skills, initiative, hit dice, death saves.
 *
 * ⚠️ ADD A ROW WHEN ACE STARTS DRIVING A NEW ROLL TYPE. A card without a row
 * shows two dialogs; a row without a card shows none. Both are visible at the
 * table, which is the only reason this table is short enough to keep honest.
 */
const DRIVEN = {
  attack: {
    setting: "autoCheckHit",
    why: "the attack pipeline posts its own hit/miss card",
  },
  damage: {
    setting: null,          // see _damageIsDriven — it depends on the source
    why: "ACE posts the damage card with per-target apply and resistance",
  },
};

export class DialogSuppression {

  /** Read a setting without letting an unregistered key throw the roll away. */
  static _on(key) {
    if (!key) return true;
    try { return QolSettings.get?.(key) !== false; }
    catch (_) { return false; }   // cannot tell -> do not suppress
  }

  /**
   * Damage is the awkward one: ACE drives damage for its own attack pipeline
   * and for auto-hit spells, but NOT when the pipeline is switched off, and not
   * for a roll somebody triggers straight off a sheet with our features
   * disabled.
   *
   * ⚠️ TWO SETTINGS, TWO SOURCES. `spellAutoDamageEnabled` governs Magic
   * Missile and friends; `autoCheckHit` governs weapon damage that follows one
   * of our attack cards. Either being off must hand that dialog back.
   */
  static _damageIsDriven(config) {
    const isSpell = config?.subject?.item?.type === "spell";
    if (isSpell) return DialogSuppression._on("spellAutoDamageEnabled");
    return DialogSuppression._on("autoCheckHit");
  }

  /**
   * Should dnd5e skip its dialog for this roll?
   * Returns the reason when yes, null when no — so the decision can be logged
   * rather than guessed at later.
   */
  static _reasonToSuppress(config) {
    const names = Array.isArray(config?.hookNames) ? config.hookNames : [];

    for (const [type, rule] of Object.entries(DRIVEN)) {
      if (!names.includes(type)) continue;
      if (type === "damage") {
        return DialogSuppression._damageIsDriven(config) ? rule.why : null;
      }
      return DialogSuppression._on(rule.setting) ? rule.why : null;
    }
    return null;
  }

  static register() {
    // ⚠️ `dnd5e.preRoll` — the empty-suffix hook, which fires for EVERY roll.
    // Not `preRollAttackV2` and `preRollDamageV2` separately: that is how the
    // old code ended up with three suppression sites and a hole between them.
    Hooks.on("dnd5e.preRoll", (config, dialog /*, message */) => {
      try {
        if (!dialog) return;
        const why = DialogSuppression._reasonToSuppress(config);
        if (!why) return;

        // ⚠️ ONLY EVER SUPPRESS. Never set `configure = true` — another module
        // may have suppressed this same dialog for its own reasons, and
        // overruling it would resurrect a window somebody deliberately closed.
        if (dialog.configure === false) return;
        dialog.configure = false;

        if (QolSettings.get?.("debugMode")) {
          console.log(`${LOG} | suppressed dnd5e's dialog for `
            + `[${(config.hookNames ?? []).filter(Boolean).join(", ")}] — ${why}.`);
        }
      } catch (err) {
        // ⚠️ FAIL OPEN, LOUDLY. If this throws, the player gets dnd5e's dialog:
        // an extra window is an annoyance, a missing one plus a missing card is
        // a lost turn. Never let a suppression bug eat somebody's roll.
        console.warn(`${LOG} | could not decide about this dialog — leaving it to dnd5e:`, err);
      }
    });

    console.log(`${LOG} | online — one rule for every dnd5e roll dialog `
      + `(${Object.keys(DRIVEN).join(", ")})`);
  }
}
