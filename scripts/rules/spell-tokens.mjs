// ─── The tokens a spell puts on the map ──────────────────────────────────────
//
// His rule, 2026-10-14: "When it's deleted off the scene, the concentration
// should come off the caster." Spike Growth has done that for its AREA since
// 0.6.3. A spell's TOKENS (Spiritual Weapon, Summon Fey, Conjure Animals) had
// nothing: deleting ACE Test Dummy's Spiritual Weapon left him concentrating on a
// spell with nothing on the map, and ACE only took the token out of the tracker.
//
// One rule, two doors. Both live in the concentration widget; this file is what
// the token door reads. A pure leaf with no imports, so anything may use it.
//
// ⚠️🔴 NOT EVERY DELETE IS A DISMISSAL. ACE itself takes a spell's tokens off the
// map when its concentration has already ended, when the spell is cast again,
// and when the party is carried to another scene. None of those may end a
// concentration. dnd5e begins the NEW concentration before it ends the old one
// (activity use, 5.3.3), so on a recast the old token goes while the caster is
// already concentrating on the new cast, and a carried summon is still on its
// way. Each of those deletes says why, and the door leaves them alone.
// ──────────────────────────────────────────────────────────────────────────────

const KEY = "ace-qol";

/**
 * Options for a delete that is not the spell being dismissed.
 * @param {string} why     plain words: "its caster's concentration ended"
 * @param {object} [extra] other delete options to keep
 */
export function removedBecause(why, extra = {}) {
  return { ...extra, [KEY]: { ...(extra?.[KEY] ?? {}), removedBecause: String(why) } };
}

/**
 * Why it was removed, or null when somebody simply deleted it. ACE's own
 * reason first; then Foundry's: a teleport to another scene creates the token
 * there FIRST and deletes this one with `replacements` naming the new copy
 * (RegionDocument#teleportToken, V13), so it is moving, not dismissed.
 */
export function whyRemoved(options) {
  const why = options?.[KEY]?.removedBecause;
  if (typeof why === "string" && why) return why;
  const moved = options?.replacements;
  if (moved && typeof moved === "object" && Object.keys(moved).length) return "it was moved to another scene";
  return null;
}

/**
 * The spell that put this token on the map (its item's uuid), or null.
 * dnd5e stamps every summoned creature with it; ACE's own Spiritual Weapon
 * carries it in its stamp as well.
 */
export function spellOriginOf(tokenDoc) {
  const origin = tokenDoc?.actor?.flags?.dnd5e?.summon?.origin
              ?? tokenDoc?.delta?.flags?.dnd5e?.summon?.origin
              ?? tokenDoc?.flags?.[KEY]?.spiritualWeapon?.itemUuid
              ?? null;
  return typeof origin === "string" && origin ? origin : null;
}

/** Every other token, on any scene, that the same spell put there. */
export function othersFromTheSameSpell(origin, exceptId, scenes) {
  const out = [];
  if (!origin) return out;
  for (const scene of scenes ?? []) {
    for (const t of scene?.tokens ?? []) {
      if (t?.id === exceptId) continue;
      if (spellOriginOf(t) === origin) out.push(t);
    }
  }
  return out;
}
