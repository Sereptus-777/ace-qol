// ─── ACE: QOL — who draws this? ───────────────────────────────────────────────
//
// One question, asked by anything that is about to invent an animation:
// "does ACE already have a picture for this action?"
//
// ⚠️🔴 WHY THIS EXISTS. Johnny cast Thunderstorm of Misery and FOUR separate
// systems drew something on the same press (2026-09-03):
//
//   1. Forge FX derived a blue explosion, because the item has no FX configured
//      and Forge's job is to invent one from the damage type and the shape.
//   2. Storm Visuals played its cinematic: darkness, six bolts, wind.
//   3. Space Effects drew the persistent whirlwind under the tokens.
//   4. ace-fx encrusted every creature that failed its save.
//
// His words: "there's a lot of things going on with the animation there, so I'm
// not surprised it'd be hard to figure out ... I don't want what Forge FX does."
//
// ⚠️ THE FIX IS NOT TO GUT THE GUESSER. Forge deriving an animation from an
// item's own data is the whole point of that feature: a spell out of a book he
// has not bought, or homebrew a player wrote last night, animates on first use
// with no curation at all. It is right almost everywhere. It is wrong HERE,
// because something better already owns this picture.
//
// So the rule is a standing-down rule, not a switch: a GUESS defers to an OWNER.
// Anything Johnny configured himself in Forge still plays — that is authored
// work, not a guess, and it outranks everything here.
//
// ⚠️ AND EACH OWNER ANSWERS FOR ITSELF. The alternative was a list of names in
// this file, which is a second copy of three sets of rules that would drift the
// first time one of them changed. Every owner exports its own predicate and
// this file only asks them in turn.
// ──────────────────────────────────────────────────────────────────────────────

// ⚠️ HARDCODED, NOT IMPORTED. `MODULE_ID` comes from the entry file, and an
// imported const at the top level of a module in an import cycle throws at load
// and kills the whole module (2026-08-28). Five files already do this.
const MODULE_ID = "ace-qol";

import { StormVisuals } from "./storm-visuals.mjs";
import { FlightVisuals } from "./flight-visuals.mjs";
import { RulesBrain } from "./rules/rules-brain.mjs";
import { SPELL_RULES } from "./rules/rules-data-spells.mjs";

export class VisualOwnership {

  /**
   * Does ACE already draw this action?
   *
   * @param {Item5e}     item      the item being used
   * @param {Activity}   [activity] the activity, when the caller has it
   * @returns {{owned: boolean, by: string|null}}
   */
  static owns(item, activity = null) {
    const answer = (by) => ({ owned: true, by });

    // ── A space on the map ────────────────────────────────────────────────
    // Thunderstorm of Misery, Fog Cloud, Darkness, Web. Space Effects builds a
    // region and draws a persistent effect sized to it, which is a far better
    // picture than a one-shot explosion at the centre.
    try {
      const kind = VisualOwnership._spaceKind(item, activity);
      if (kind) return answer(`the ${kind} space ACE draws on the map`);
    } catch (_) { /* fall through to the next owner */ }

    // ── A whirlwind on the target ─────────────────────────────────────────
    try {
      if (StormVisuals.ownsTornado?.(activity)) return answer("ACE's tornado whirlwind");
    } catch (_) { /* fall through */ }

    // ── Taking off or landing ─────────────────────────────────────────────
    try {
      if (FlightVisuals.ownsFlight?.(activity)) return answer("ACE's flight visuals");
    } catch (_) { /* fall through */ }

    return { owned: false, by: null };
  }

  /**
   * The space kind this action creates, or null.
   *
   * ⚠️ THE ACTIVITY'S NAME FIRST. On a multi-activity magic item the storm is
   * ONE ability among four: the Stormforger's storm is "Thunderstorm of
   * Misery" while the item is "Stormforger". Asking the item alone would say
   * yes for all four of its abilities, and Aerial Ascension would lose an
   * animation it is entitled to. Storm Visuals learned this the hard way on
   * 2026-07-29 and the same order applies here.
   */
  static _spaceKind(item, activity) {
    const tryName = (name) => {
      if (!name) return null;
      const entry = SPELL_RULES[RulesBrain.normalizeName(String(name))];
      return entry?.space?.kind ?? null;
    };

    const byActivity = tryName(activity?.name);
    if (byActivity) return byActivity;

    // Only fall back to the item when it has ONE ability, where the item's name
    // IS the ability's name (a spell, a scroll, a wand named for its one trick).
    let count = 0;
    try {
      const acts = item?.system?.activities;
      count = acts?.size ?? acts?.contents?.length ?? Object.keys(acts ?? {}).length;
    } catch (_) { count = 0; }
    if (count > 1) return null;

    return tryName(item?.name);
  }

  /** Registered on the API so Forge (a separate module) can ask. */
  static register() {
    game.aceQol = game.aceQol ?? {};
    Object.assign(game.aceQol, {
      // ⚠️ Object.assign, NEVER `game.aceQol = {…}` — a literal assignment here
      // erased a dozen registrations once already.
      ownsVisual: (item, activity) => VisualOwnership.owns(item, activity),
    });
    console.debug(`${MODULE_ID} | Visual ownership online — a guessed animation now defers to an owner`);
  }
}
