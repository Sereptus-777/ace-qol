// ─── Which edition governs which rule ────────────────────────────────────────
//
// ⚠️ WHY THIS EXISTS. ACE had TWO independent "D&D 5e Rules Edition" settings,
// one in QOL and one in Engine, and the Engine one's own hint said "Mirror this
// with the same setting in ACE QOL for full consistency." The module was asking
// the GM to keep two settings in step by hand. Johnny, 2026-08-23: "The two have
// to sync together. Whatever I have in one has to happen in the other."
//
// ⚠️ AND "AUTO" IS GONE, BY INSTRUCTION. "I don't want fucking Auto Detect.
// That's just going to screw things up." He is right for a sold product: a
// per-actor sniff means two creatures in the same fight can be running different
// rules, and no support conversation can start from "it depends what ACE decided
// about that goblin". Anyone still holding "auto" is resolved ONCE to a concrete
// edition and written down, so nobody is left on a value that no longer exists.
//
// ⚠️ EVERY ROW HERE IS A REAL BRANCH IN THE CODE. Not one of these is a
// decorative switch. Grapple, shove, surprise and hiding also differ between the
// editions and are NOT listed, because ACE does not branch on them today — an
// option that changes nothing is worse than no option, because it makes a GM
// believe they have configured something.
// ⚠️ MODULE_ID is declared here rather than imported from ace-qol.mjs.
// settings.mjs imports this file statically and ace-qol.mjs imports settings,
// so reaching back for the constant would close an import cycle.
const MODULE_ID = "ace-qol";

const LOG = "ace-qol | RulesEdition";

/**
 * The rules ACE actually implements differently, and what differs.
 *
 * `key` is the setting suffix; the stored setting is `edition.<key>` and holds
 * "2014" or "2024".
 */
export const EDITION_RULES = [
  { key: "weaponMastery", label: "Weapon Mastery",
    d2014: "Does not exist",
    d2024: "Vex, Topple, Graze, Nick, Cleave, Push, Sap, Slow" },

  { key: "exhaustion", label: "Exhaustion",
    d2014: "Six levels; level 3 and up gives attack disadvantage",
    d2024: "Ten levels; a flat penalty per level, no separate disadvantage" },

  { key: "greatWeaponMaster", label: "Great Weapon Master",
    d2014: "The -5 / +10 gamble",
    d2024: "No gamble; a damage bonus on heavy weapons instead" },

  { key: "sharpshooter", label: "Sharpshooter",
    d2014: "The -5 / +10 gamble",
    d2024: "No gamble" },

  { key: "crusherSlasher", label: "Crusher and Slasher",
    d2014: "2014 wording",
    d2024: "2024 wording" },

  { key: "lifedrinker", label: "Lifedrinker",
    d2014: "2014 damage rule",
    d2024: "2024 damage rule" },

  { key: "stunningStrike", label: "Stunning Strike",
    d2014: "Lasts to the END of the monk's next turn",
    d2024: "Lasts to the START of the monk's next turn" },

  { key: "commandSpell", label: "Command",
    d2014: "2014 wording",
    d2024: "2024 wording" },
];

const RULE_KEYS = EDITION_RULES.map(r => r.key);

/** The world's edition choice: "2014", "2024" or "custom". */
export function editionMode() {
  try { return game.settings.get(MODULE_ID, "gameRulesEdition") ?? "2024"; }
  catch (_) { return "2024"; }
}

/**
 * Which edition governs ONE named rule.
 *
 * ⚠️ THIS IS THE ONLY QUESTION THE REST OF THE CODE SHOULD ASK. A call site
 * that reads the top-level setting directly cannot be overridden by the Custom
 * tab, so it would silently ignore the GM's choice for that one rule — the
 * failure being invisible is the whole problem with a half-wired setting.
 *
 * @param {string} rule one of EDITION_RULES[].key
 * @returns {"2014"|"2024"}
 */
export function editionFor(rule) {
  const mode = editionMode();
  if (mode === "2014" || mode === "2024") return mode;
  if (mode !== "custom") return "2024";
  try {
    const v = game.settings.get(MODULE_ID, `edition.${rule}`);
    return (v === "2014" || v === "2024") ? v : "2024";
  } catch (_) {
    return "2024";
  }
}

/** Convenience for the many call sites that just want a boolean. */
export function is2024(rule) { return editionFor(rule) === "2024"; }

/**
 * Register the per-rule settings. Hidden from the native settings list — they
 * are meaningless unless the mode is Custom, and eight rows of dead controls in
 * the main list is noise for the 95% of tables who pick an edition and move on.
 * They are surfaced together on ACE's own config panel.
 */
export function registerRuleSettings(register) {
  for (const rule of EDITION_RULES) {
    register(`edition.${rule.key}`, {
      name: `${rule.label} — which edition`,
      hint: `2014: ${rule.d2014}. 2024: ${rule.d2024}. Only used when Rules Edition is set to Custom.`,
      scope: "world",
      config: false,
      type: String,
      choices: { "2014": "2014 rules", "2024": "2024 rules" },
      default: "2024",
    });
  }
}

/**
 * Set every per-rule row to one edition. Used when the GM picks 2014 or 2024
 * outright, so switching to Custom afterwards starts from where they were
 * rather than from an unrelated default.
 */
export async function setAllRules(edition) {
  if (!game.user?.isGM) return;
  for (const key of RULE_KEYS) {
    try { await game.settings.set(MODULE_ID, `edition.${key}`, edition); }
    catch (err) { console.warn(`${LOG} | could not set edition.${key}:`, err); }
  }
}

// ─── Keeping the two modules in step ─────────────────────────────────────────

let _syncing = false;

/**
 * Push the edition to ACE Engine, and accept a push from it.
 *
 * ⚠️ THE GUARD IS NOT OPTIONAL. Each module's onChange writes the other's
 * setting, so without it the first change bounces between them until the stack
 * gives out. `_syncing` is set for the duration of the write, not cleared on a
 * timer, so it cannot be defeated by a slow round trip.
 */
export async function syncEditionTo(otherModuleId, value) {
  if (_syncing) return;
  if (!game.user?.isGM) return;              // only a GM may write world settings
  const mod = game.modules.get(otherModuleId);
  if (!mod?.active) return;                  // the sibling is not installed
  try {
    const current = game.settings.get(otherModuleId, "gameRulesEdition");
    if (current === value) return;
    _syncing = true;
    await game.settings.set(otherModuleId, "gameRulesEdition", value);
    console.log(`${LOG} | Rules edition set to "${value}" in ${otherModuleId} too — the two stay in step.`);
  } catch (err) {
    console.warn(`${LOG} | could not sync the rules edition to ${otherModuleId}:`, err);
  } finally {
    _syncing = false;
  }
}

/**
 * Retire "auto" once, writing a concrete edition in its place.
 *
 * ⚠️ IT RESOLVES THE SAME WAY AUTO USED TO, so a world that has been running on
 * Auto keeps behaving exactly as it did yesterday. Migrating everyone to a flat
 * default would silently change the rules of live campaigns, which is a far
 * worse outcome than the setting they lost.
 */
export async function migrateAutoAway() {
  if (!game.user?.isGM) return null;
  let current;
  try { current = game.settings.get(MODULE_ID, "gameRulesEdition"); }
  catch (_) { return null; }
  if (current !== "auto") return null;

  let resolved = "2024";
  try {
    const rv = game.settings.get("dnd5e", "rulesVersion");
    if (rv === "legacy") resolved = "2014";
    else if (rv === "modern") resolved = "2024";
  } catch (_) { /* very old dnd5e — keep the default */ }

  await game.settings.set(MODULE_ID, "gameRulesEdition", resolved);
  await setAllRules(resolved);
  console.log(`${LOG} | "Auto" has been retired. This world resolved to ${resolved} `
    + `(the same answer Auto was giving), and every rule now says so explicitly.`);
  ui.notifications?.info(`ACE: the "Auto" rules edition has been replaced by ${resolved}, `
    + `which is what Auto was already choosing here. Change it in ACE QOL settings if that is wrong.`);
  return resolved;
}

/**
 * Say what is configured, at load, when it is not a plain edition.
 *
 * ⚠️ A CUSTOM MIX MUST BE ANSWERABLE IN ONE GLANCE. Johnny's own concern: if
 * something behaves oddly later, the first question becomes "what is in your
 * Custom tab?" — and eight clicks to find out is eight clicks nobody takes.
 */
export function reportEdition() {
  const mode = editionMode();
  if (mode !== "custom") {
    console.log(`${LOG} | Rules edition: ${mode}.`);
    return;
  }
  console.log(`${LOG} | Rules edition: CUSTOM — a mix, listed in full:`);
  for (const rule of EDITION_RULES) {
    const ed = editionFor(rule.key);
    console.log(`     ${rule.label.padEnd(22)} ${ed}   ${ed === "2014" ? rule.d2014 : rule.d2024}`);
  }
}
