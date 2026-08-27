// ─── A feature that promises a number and delivers nothing ───────────────────
//
// ⚠️🔴 WHAT THIS FOUND THE DAY IT WAS WRITTEN (2026-08-26). A sweep of Johnny's
// live world turned up TEN fighting-style and damage features on player
// characters, and every one of them applied nothing at all:
//
//     Ireena Kolyana        Archery                +2 to ranged attack rolls
//     Ismark Kolyanovich    Archery, Dueling       +2 attack, +2 damage
//     Izek Strazni          Great Weapon Fighting  reroll 1s and 2s
//     Virric Vaesoldandros  Savage Attacker        reroll damage, take better
//
// No Active Effect, no flag, no bonus anywhere. Ireena had been shooting at two
// lower than she should for as long as that sheet has existed, in a campaign
// that has been running for months.
//
// ⚠️ NOTHING IN ACE WAS WRONG, AND THAT IS PRECISELY THE PROBLEM. The item DATA
// is hollow, almost always because an importer carried the rules text across
// and not the mechanics. No module can notice, because a feature with no effect
// is indistinguishable from a feature that is pure flavour. Several of these
// items even say "This feature includes an Active Effect" in their own
// description while shipping none.
//
// A GM has no way to discover this. The player just rolls badly, forever.
//
// ⚠️ IT TELLS, IT NEVER FIXES. Writing the missing effect would double up with
// any other module that handles the feature, and would silently rewrite
// somebody's characters on load. Both are worse than a quiet sheet. The GM is
// told once, with the character's name and what the feature is supposed to do,
// and decides.
//
// ⚠️ AND IT ONLY SPEAKS ABOUT PLAYER CHARACTERS. A hollow trait on one of the
// four hundred monsters in a bestiary is noise; a hollow Fighting Style on the
// ranger who shoots every round is a wrong number every combat.
import { MODULE_ID } from "./ace-qol.mjs";

/**
 * Features whose whole purpose is a number, keyed by their normalised name.
 *
 * ⚠️ DELIBERATELY A SHORT, CERTAIN LIST. Guessing from description text finds
 * far more and is wrong far more often: the offline version of this check
 * flagged worn armour for "missing" an AC bonus that dnd5e computes natively
 * from the item, and buried the genuinely dead Archery under three of them.
 * Everything here does nothing whatsoever without an effect behind it.
 */
const NUMERIC_FEATURES = {
  "archery":                 "+2 to ranged weapon attack rolls",
  "fighting style archery":  "+2 to ranged weapon attack rolls",
  "dueling":                 "+2 damage with a one-handed melee weapon",
  "fighting style dueling":  "+2 damage with a one-handed melee weapon",
  "great weapon fighting":   "reroll 1s and 2s on two-handed weapon damage",
  "fighting style great weapon fighting": "reroll 1s and 2s on two-handed weapon damage",
  "savage attacker":         "reroll weapon damage once per turn and take the better roll",
  "two weapon fighting":     "add your ability modifier to off-hand damage",
  "fighting style two weapon fighting": "add your ability modifier to off-hand damage",
  "close quarters shooter":  "+1 to ranged attack rolls and ignores half cover",
  "thrown weapon fighting":  "+2 damage with a thrown weapon",
  "blessed warrior":         "two cleric cantrips",
  "superior technique":      "one manoeuvre and a superiority die",
};

/**
 * Flags dnd5e writes for its own bookkeeping. Their presence proves nothing.
 *
 * ⚠️ THE OFFLINE VERSION TREATED ANY FLAG AS MACHINERY and therefore skipped
 * Archery, the clearest case in the world: its flags are `sourceId` and
 * `advancementOrigin`, written by the importer, carrying no behaviour at all.
 */
const BOOKKEEPING = new Set(["sourceId", "advancementOrigin", "advancementRoot",
  "persistSourceMigration", "migratedUses", "last", "dependents"]);

const _norm = (n) => String(n ?? "")
  .toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();

/** Does this item carry anything at all that could change a roll? */
function _hasMachinery(item) {
  try {
    if ((item.effects?.size ?? item.effects?.length ?? 0) > 0) {
      for (const e of item.effects) if ((e?.changes?.length ?? 0) > 0) return true;
    }
    const flags = Object.keys(item.flags?.dnd5e ?? {});
    if (flags.some(f => !BOOKKEEPING.has(f))) return true;
    const acts = item.system?.activities;
    const count = acts?.size ?? (acts ? Object.keys(acts).length : 0);
    if (count > 0) return true;
  } catch (_) { /* an unreadable item is not evidence of anything */ }
  return false;
}

/** Every hollow numeric feature on a player character. */
export function findHollowFeatures() {
  const out = [];
  try {
    for (const actor of (game.actors ?? [])) {
      if (actor?.type !== "character") continue;
      if (!actor.hasPlayerOwner) continue;   // a GM's test dummy is not a table problem
      for (const item of (actor.items ?? [])) {
        if (item?.type !== "feat") continue;
        const promise = NUMERIC_FEATURES[_norm(item.name)];
        if (!promise) continue;
        if (_hasMachinery(item)) continue;
        out.push({ actor: actor.name, feature: item.name, promise });
      }
    }
  } catch (err) {
    console.warn(`${MODULE_ID} | could not scan for hollow features:`, err);
  }
  return out;
}

/**
 * Say it once, to the GM, at boot.
 *
 * ⚠️ ONCE PER SESSION AND GM ONLY. A player cannot fix an item they do not own
 * and cannot edit, so telling them only makes the table feel broken.
 */
export function warnAboutHollowFeatures() {
  if (!game.user?.isGM) return [];
  const hollow = findHollowFeatures();
  if (!hollow.length) return [];

  console.warn(`${MODULE_ID} | ${hollow.length} feature(s) on player characters `
    + `promise a number and carry nothing to produce it:`);
  for (const h of hollow) {
    console.warn(`${MODULE_ID} |   ${h.actor} — "${h.feature}" should give ${h.promise}, `
      + `and applies nothing. The item has no Active Effect behind it.`);
  }

  const lines = hollow
    .map(h => `<li><strong>${h.actor}</strong> — ${h.feature}: <em>${h.promise}</em></li>`)
    .join("");
  ChatMessage.create({
    whisper: game.users.filter(u => u.isGM).map(u => u.id),
    flags: { [MODULE_ID]: { type: "hollowFeatures" } },
    content: `
      <div style="background:#1a0e0e;border:2px solid #c74420;border-radius:6px;padding:10px 14px;color:#f0e4c0;">
        <div style="font-family:'Cinzel Decorative','Cinzel',serif;color:#ff6b3d;font-size:15px;font-weight:700;letter-spacing:1px;margin-bottom:6px;">
          <i class="fas fa-triangle-exclamation"></i> ACE — features that do nothing
        </div>
        <p style="margin:4px 0 8px 0;font-size:14px;line-height:1.5;">
          These features are on player sheets and carry no Active Effect, so they change
          no roll. The rules text came across from the importer; the mechanics did not.
          ACE has not altered anything.
        </p>
        <ul style="margin:4px 0 8px 18px;font-size:14px;line-height:1.6;">${lines}</ul>
        <p style="margin:8px 0 0 0;font-size:13px;color:#c0b288;font-style:italic;">
          Fix them on the sheet, or re-import the feature from a compendium that includes
          its effect. Shown once per load, to GMs only.
        </p>
      </div>`,
  }).catch(err => console.warn(`${MODULE_ID} | hollow-feature notice failed to post:`, err));

  return hollow;
}

/**
 * ⚠️ `Hooks.once("ready")` FROM INSIDE `ready` NEVER FIRES. Every ACE subsystem
 * starts from the entry file's own ready handler, so waiting on `ready` here
 * would wait on an event already in progress: nothing throws, nothing logs, and
 * the check silently never runs. That cost thirteen surviving condition ghosts
 * and a boot API check that only ever ran when typed by hand (2026-08-12).
 */
export function registerHollowFeatureWarning() {
  const run = () => { try { warnAboutHollowFeatures(); } catch (err) {
    console.error(`${MODULE_ID} | hollow-feature warning failed:`, err);
  } };
  if (game.ready) run();
  else Hooks.once("ready", run);
}
