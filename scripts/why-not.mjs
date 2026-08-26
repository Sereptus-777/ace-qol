// ─── Why didn't that happen? ─────────────────────────────────────────────────
//
// ⚠️🔴 THE PIPELINES USED TO GIVE UP IN SILENCE, EIGHTY TIMES OVER.
//
// An audit on 2026-08-26 counted 80 early returns across the roll path that
// bailed without a word. Two of them had already cost real time that week:
//
//   · Switching "Enable Reactions" off made EVERY attack card in the game
//     vanish. Nothing anywhere mentioned the setting. It ended a live session
//     on 24 August and took a full night to find.
//   · Uncanny Dodge declined every hit for an hour because the object handed
//     to it carried no attack outcome. No prompt, no warning, nothing to tell
//     a broken feature from a feature correctly deciding not to fire.
//
// That second one is the whole argument for this file. From the outside,
// "this feature is switched off", "this feature is broken", and "this feature
// looked and decided no" produce exactly the same thing: nothing. The console
// has to separate them, or every quiet feature costs a debugging session.
//
// ═══ THE TWO SHAPES ══════════════════════════════════════════════════════════
//
//   gateOff(feature, settingKey)  a SETTING says no. Said ONCE per feature per
//                                 session, so a hook that fires on every spell
//                                 cast cannot flood the log. Names the setting
//                                 the way it reads on screen.
//
//   cannotDo(feature, what)       something needed is ABSENT. Said every time,
//                                 because it is a defect, not a preference.
//
// ⚠️ AND A THIRD SHAPE THAT LIVES IN THE SOURCE, NOT HERE. Roughly half the
// early returns in these files are "this event is not mine to handle" - wrong
// client, not the active GM, a socket message of another type, a hook that
// fires on deselect as well as select. Those run on every client for every
// event, and making them speak would bury every player's console. Noise gets
// logging switched off, and then nothing is reported at all. Those are marked
// in place with a `// SILENT-OK: <reason>` comment, which tools/silent-exit-
// audit.py counts and displays separately. The reason is required.
//
// ⚠️ THIS FILE IMPORTS NOTHING, ON PURPOSE. ace-qol.mjs is the hub of 130+
// static import cycles in this module, so pulling MODULE_ID from it would put
// a diagnostic helper inside the loop - and a broken diagnostic is worse than
// none, because its silence reads as a pass. The id is hardcoded here for the
// same reason reaction-engine.mjs hardcodes it.
const MODULE_ID = "ace-qol";

/** Feature+setting pairs already reported, so a hot hook says it once. */
const _reported = new Set();

/**
 * A feature will not run because a setting is off.
 *
 * Reported ONCE per feature per session. The alternative - reporting every
 * time - floods the console on hooks that fire on every cast, and a flooded
 * console is one nobody reads, which puts us back where we started.
 *
 * @param {string} feature     what the player would have seen, in plain words
 * @param {string} settingKey  the ACE setting key that is switched off
 * @returns {undefined}        so a void guard can `return gateOff(...)`
 */
export function gateOff(feature, settingKey) {
  try {
    const key = `${feature}|${settingKey}`;
    if (_reported.has(key)) return undefined;
    _reported.add(key);
    // Name the checkbox as it reads on screen, not the internal key - he has
    // to find it in the settings menu, and the key is not what is printed
    // there.
    let label = settingKey;
    try {
      label = game.settings?.settings?.get(`${MODULE_ID}.${settingKey}`)?.name ?? settingKey;
    } catch { /* settings not ready; the key still beats nothing */ }
    console.log(`${MODULE_ID} | ${feature} will not run this session: `
      + `the setting "${label}" is off. Reported once.`);
  } catch { /* a diagnostic must never break the thing it reports on */ }
  return undefined;
}

/**
 * A feature could not run because something it needs is absent.
 *
 * Always says so. This is the case that reads as "the feature is broken" from
 * the player's chair, and it is the one that has to name itself.
 *
 * @param {string} feature  what the player would have seen
 * @param {string} what     what was missing, in plain words
 * @returns {undefined}     so a void guard can `return cannotDo(...)`
 */
export function cannotDo(feature, what) {
  try {
    console.warn(`${MODULE_ID} | ${feature} could not run: ${what}.`);
  } catch { /* never break the caller */ }
  return undefined;
}

/**
 * A reply arrived from a user we did not ask.
 *
 * ⚠️ THIS ONE IS NEVER QUIET AND NEVER DEDUPLICATED. Foundry attaches no
 * trusted sender to a socket message, so "is this the user we ASKED" is the
 * only real check ACE has, and a rejected reply is either a bug in our own
 * routing or somebody reaching for a decision that is not theirs. Both are
 * worth a line every single time.
 *
 * @returns {undefined}
 */
export function rejectedReply(feature, expectedUserId, payload) {
  try {
    const from = payload?.senderUserId ?? payload?.userId ?? "unknown";
    const name = (() => {
      try { return game.users?.get?.(from)?.name ?? from; } catch { return from; }
    })();
    console.warn(`${MODULE_ID} | ${feature}: ignored a reply from ${name} - `
      + `the prompt was sent to user ${expectedUserId ?? "(nobody recorded)"}. `
      + `Only the user who was asked may answer.`);
  } catch { /* never break the caller */ }
  return undefined;
}
