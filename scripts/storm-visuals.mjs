// ─── ACE: QOL — Storm Visuals ─────────────────────────────────────────────────
// A short, good-looking flourish when a storm-kind space is created — grey
// driving storm across the whole radius, purple lightning cracking down inside
// it, and a howling Halloween wind. About three seconds, then gone: the storm
// LASTS a minute as a Region, but the cinematic is a punctuation mark, not a
// screensaver. (Johnny 2026-07-27.)
//
// RULES-DRIVEN, not item-specific. It fires off the rules brain: any entry whose
// space kind is "storm" gets this, sized to that entry's own radius. Thunderstorm
// of Misery is simply the first one — a future storm item inherits the visual
// with no code change here.
//
// GRACEFUL: Sequencer and JB2A are OPTIONAL. Missing either just means no
// animation; the storm's mechanics are unaffected. Missing the sound module
// means the visual plays silent.
// ──────────────────────────────────────────────────────────────────────────────

import { MODULE_ID } from "./ace-qol.mjs";
import { RulesBrain } from "./rules/rules-brain.mjs";
import { SPELL_RULES } from "./rules/rules-data-spells.mjs";

/**
 * Total run time of the flourish. 3s was too quick to read, 5s still wasn't
 * enough — the beat Johnny wants is: the whole area goes black, the table says
 * "wait, I can't even SEE them", then bolts and thunder tear through it and it
 * clears. That needs room to breathe.
 */
const STORM_MS = 7500;

/**
 * When the darkness starts tearing open and the first bolt lands. Everything
 * before this is pure "you can't see them"; everything after is the clear.
 */
const CLEAR_AT = 4200;

/** How many bolts fall during the flourish. */
const STRIKE_COUNT = 6;

/**
 * The dark mass that swallows the whole radius.
 *
 * The grey sleet-storm sheet was tried first and dropped: it read as weather
 * wallpaper, not menace. This is the black darkness sphere, drawn OVER the
 * tokens so the table genuinely can't see who's in there until it clears —
 * which is the whole point of the beat. Square asset, built as a sphere, so it
 * scales to a 100-ft circle without smearing the way the tall smoke plumes do.
 *
 * VISUAL ONLY. The storm's actual rules — light obscurement, difficult terrain,
 * deafened inside — live on the Region the rules brain creates. Nothing here
 * changes what a creature can mechanically see.
 */
const STORM_BED = [
  "modules/jb2a_patreon/Library/2nd_Level/Darkness/Darkness_01_Black_600x600.webm",
  "modules/JB2A_DnD5e/Library/2nd_Level/Darkness/Darkness_01_Black_600x600.webm",
  "modules/jb2a_patreon/Library/3rd_Level/Sleet_Storm/SleetStorm_01_Grey_800x800.webm",
];

/** Thunder, rotated so six bolts don't fire the same clap six times. */
const THUNDER = [
  "modules/ace-qol/Assets/Sounds/thunder-crack.mp3",
  "modules/ace-engine/sounds/creatures/elemental/thunder-crack.mp3",
  "modules/ace-engine/sounds/creatures/elemental/thunder-close.mp3",
  "modules/ace-engine/sounds/creatures/elemental/thunder-deep.mp3",
];

/**
 * Lightning strikes.
 *
 * Purple was tried first (misery = gothic purple) and it FAILED on screen:
 * against the grey storm bed on a pale snow map it read as "dark splotches",
 * not lightning. Bright blue is the readable choice — a bolt has to look like
 * a bolt at a glance or the flourish is just noise. (Johnny, live test.)
 */
const STRIKE = [
  "modules/jb2a_patreon/Library/3rd_Level/Call_Lightning/CallLightning_01_Blue_1000x1000.webm",
  "modules/jb2a_patreon/Library/3rd_Level/Call_Lightning/CallLightning_01_BlueOrange_1000x1000.webm",
  "modules/jb2a_patreon/Library/3rd_Level/Call_Lightning/CallLightning_01_Purple_1000x1000.webm",
];

/**
 * Whirlwind — deliberately the SAME asset the flight ascension uses, so every
 * ability on the staff reads as one item rather than a grab bag of effects.
 */
const WHIRLWIND = [
  "modules/jb2a_patreon/Library/7th_Level/Whirlwind/Whirlwind_01_BlueWhite_400x400.webm",
  "modules/jb2a_patreon/Library/7th_Level/Whirlwind/Whirlwind_01_BlueGrey_01_400x400.webm",
  "modules/JB2A_DnD5e/Library/7th_Level/Whirlwind/Whirlwind_01_BlueWhite_400x400.webm",
];

/**
 * Single-target abilities that conjure a whirlwind ON THE TARGET rather than a
 * space around the caster. Tornado Takedown places no template, so the rules
 * brain has nothing to match — this is matched by name instead.
 */
const TORNADO_RE = /tornado/i;

/** Whirlwind run time — long enough to read as a tornado grabbing them. */
const TORNADO_MS = 4000;

/**
 * Halloween wind. ace-qol is the FREE module, so its own copy is preferred and
 * ace-engine's library is the fallback — whichever is present wins, and if
 * neither is the flourish simply plays silent.
 */
const WIND = [
  "modules/ace-qol/Assets/Sounds/halloween-wind.mp3",
  "modules/ace-engine/sounds/creatures/elemental/scary-graveyard-wind.mp3",
  "modules/ace-engine/sounds/creatures/elemental/dark-storm-wind.mp3",
];

/**
 * Resolve the first candidate that ACTUALLY EXISTS on this install, cached.
 *
 * Checking "is the owning module active" is not enough: ace-qol is always
 * active, so an ace-qol candidate would always win even when its file hasn't
 * been added yet, and the effect would silently reference a 404. Probing the
 * real file means a candidate list can safely hold paths that only some users
 * have — each person gets the best asset they own, and anyone who owns none
 * simply gets no visual instead of a broken one.
 */
const _picked = new Map();

/** Every candidate that exists here, in order. */
async function pickAllExisting(key, paths) {
  if (_picked.has(key)) return _picked.get(key);
  const found = [];
  for (const p of paths) {
    try {
      if (!game.modules.get(p.split("/")[1])?.active) continue;   // cheap reject first
      const url = foundry.utils.getRoute?.(p) ?? p;
      const res = await fetch(url, { method: "HEAD" });
      if (res.ok) found.push(p);
    } catch (_) { /* try the next candidate */ }
  }
  _picked.set(key, found);
  return found;
}

/** The single best candidate that exists here, or null. */
async function pickExisting(key, paths) {
  return (await pickAllExisting(key, paths))[0] ?? null;
}

export class StormVisuals {

  static init() {
    Hooks.on("dnd5e.postUseActivity", (activity, _usageConfig, results) => {
      StormVisuals._maybePlay(activity, results).catch(err =>
        console.warn(`${MODULE_ID} | storm visual failed (non-fatal):`, err));
      StormVisuals._maybeTornado(activity).catch(err =>
        console.warn(`${MODULE_ID} | tornado visual failed (non-fatal):`, err));
    });
    // Warm the asset probes so the first cast doesn't pay for them.
    Hooks.once("ready", () => {
      pickExisting("bed", STORM_BED);
      pickExisting("strike", STRIKE);
      pickExisting("wind", WIND);
      pickExisting("whirl", WHIRLWIND);
    });
    console.debug(`${MODULE_ID} | Storm Visuals online — any storm-kind space gets the flourish`);
  }

  /**
   * Ask the brain whether this action makes a storm. The ACTIVITY name is tried
   * first because a magic item's storm is one activity among several — the
   * Stormforger's storm is "Thunderstorm of Misery" while the item is "Staff of
   * the Stormforger", so an item-name-only lookup would miss it.
   */
  static _resolveStorm(activity) {
    const tryKey = (name) => {
      if (!name) return null;
      const key = RulesBrain.normalizeName(String(name));
      const entry = SPELL_RULES[key];
      return entry?.space?.kind === "storm" ? entry : null;
    };

    // The activity's own name is the only authority worth trusting first.
    const byActivity = tryKey(activity?.name);
    if (byActivity) return byActivity;

    // ⚠️ ON A MULTI-ACTIVITY ITEM, STOP HERE (2026-07-29).
    // Falling back to the ITEM asks "does this staff make a storm?" — and the
    // Staff of the Stormforger does, via a DIFFERENT activity. So pressing
    // Tornado Takedown resolved to Thunderstorm of Misery and played the storm
    // over the whirlwind. Johnny, live: "it gave me the graphics for
    // Thunderstorm of Misery instead of the Whirlwind."
    //
    // Same failure as the damage bug that rolled the storm's 8d6 for the
    // tornado — an item-level answer standing in for one of its abilities.
    // The item fallback exists for the single-activity case (a spell, a scroll,
    // a wand named for the one thing it does); there it's correct and needed,
    // because the storm's name lives on the ITEM, not the activity.
    let activityCount = 0;
    try {
      const acts = activity?.item?.system?.activities;
      activityCount = acts?.size ?? acts?.contents?.length ?? Object.keys(acts ?? {}).length;
    } catch (_) { activityCount = 0; }
    if (activityCount > 1) return null;

    return tryKey(activity?.item?.name)
        ?? (() => {
             // Last resort: the brain's own item resolution (handles aliases).
             try {
               const hit = RulesBrain.spaceEntry(activity.item, { actor: activity.item?.actor });
               return hit?.entry?.space?.kind === "storm" ? hit.entry : null;
             } catch (_) { return null; }
           })();
  }

  /**
   * Tornado Takedown — a whirlwind wrapping the TARGET, plus howling wind.
   *
   * Targets come from the user's live target set: this hook runs on the client
   * that used the staff, and a single-creature action keeps its target under
   * ACE's release policy, so the target is still held when we get here. The
   * activity's own target descriptors are the fallback for anything that has
   * already released.
   */
  static async _maybeTornado(activity) {
    const name = String(activity?.name ?? "");
    if (!TORNADO_RE.test(name)) return;

    const Seq = globalThis.Sequence;
    if (!Seq || !globalThis.Sequencer) return;

    const [whirl, wind] = await Promise.all([
      pickExisting("whirl", WHIRLWIND),
      pickExisting("wind", WIND),
    ]);
    if (!whirl) return;

    const targets = StormVisuals._targetTokens(activity);
    if (!targets.length) return;

    const seq = new Seq();
    for (const t of targets) {
      seq.effect()
        .file(whirl)
        .attachTo(t, { bindAlpha: false })
        .scaleToObject(1.8)
        .opacity(0.9)
        .duration(TORNADO_MS)
        .fadeIn(300)
        .fadeOut(800);
    }
    if (wind) {
      seq.sound()
        .file(wind)
        .volume(0.55)
        .duration(TORNADO_MS)
        .fadeInAudio(200)
        .fadeOutAudio(800);
    }
    seq.play();
  }

  /** Tokens this activity is aimed at — live targets first, descriptors after. */
  static _targetTokens(activity) {
    const out = new Set();
    try {
      for (const t of (game.user?.targets ?? [])) if (t) out.add(t);
    } catch (_) { /* fall through */ }
    if (out.size) return [...out];
    try {
      for (const d of (activity?.messageFlags?.targets ?? [])) {
        const doc = fromUuidSync?.(d?.uuid);
        const tok = doc?.object ?? doc?.parent?.object ?? null;
        if (tok) out.add(tok);
      }
    } catch (_) { /* fall through */ }
    return [...out];
  }

  static async _maybePlay(activity, results = null) {
    // An activity the tornado handler owns is never also a storm. Both run off
    // the same hook, so without this the two visuals stack and the big dark
    // storm simply buries the whirlwind.
    if (TORNADO_RE.test(String(activity?.name ?? ""))) return;

    const entry = StormVisuals._resolveStorm(activity);
    if (!entry) return;

    // ── WHERE the storm actually is ──
    // Anchor to the TEMPLATE, not the caster. The template is what the rules
    // brain builds the region from, so if the visual sits on the caster while
    // the template was dropped elsewhere, the picture lies about where the
    // difficult terrain and obscurement really are. Caster is the fallback for
    // a genuinely self-centred cast that placed no template.
    // NEVER trust the shape of what dnd5e hands back. `results.templates` comes
    // from drawPreview(), which resolves with whatever createEmbeddedDocuments
    // returned — an ARRAY of documents — so templates[0] can itself be an array
    // rather than a document. Reading .x off that gives undefined, Sequencer
    // gets a location of {x: undefined, y: undefined}, and every effect silently
    // draws nothing while the sound (which needs no location) plays happily.
    // That's a miserable failure mode: it looks like the animation was deleted.
    // So dig out a real document, demand finite coordinates, and fall back to
    // the caster the moment anything is off.
    const token = activity.item?.actor?.getActiveTokens?.()[0];
    const dig = (v, depth = 0) => (Array.isArray(v) && depth < 4) ? dig(v[0], depth + 1) : v;
    const tpl = dig(results?.templates?.[0]) ?? null;
    const tx = Number(tpl?.x);
    const ty = Number(tpl?.y);
    const useTemplate = Number.isFinite(tx) && Number.isFinite(ty);
    const anchor = useTemplate ? { x: tx, y: ty } : (token ?? null);
    if (!anchor) return;
    console.debug(`${MODULE_ID} | storm anchored to ${useTemplate ? `template (${tx}, ${ty})` : `caster ${token?.name ?? "?"}`}`);

    const Seq = globalThis.Sequence;
    if (!Seq || !globalThis.Sequencer) return;        // Sequencer optional

    const [bed, strike, wind, thunder] = await Promise.all([
      pickExisting("bed", STORM_BED),
      pickExisting("strike", STRIKE),
      pickExisting("wind", WIND),
      pickAllExisting("thunder", THUNDER),
    ]);
    if (!bed && !strike) return;                      // no storm assets — nothing to draw

    // Size the bed to the entry's OWN radius, so a future 20-ft storm is drawn
    // at 20 ft without touching this file.
    const radiusFt = Number(entry.expectedArea?.size) || 20;
    const gridDist = Number(canvas?.grid?.distance) || 5;
    const gridSize = Number(canvas?.grid?.size) || 100;
    const radiusPx = (radiusFt / gridDist) * gridSize;
    const squares  = (radiusFt * 2) / gridDist;       // diameter, in grid squares

    const seq = new Seq();

    // ── The storm itself: fills the radius, sits under the tokens ──
    if (bed) {
      // ABOVE the tokens on purpose — the beat only lands if the darkness
      // actually hides who's standing in it. Held just shy of opaque so shapes
      // are hinted at rather than erased, and the bolts still punch through.
      seq.effect()
        .file(bed)
        .atLocation(anchor)
        .size(squares, { gridUnits: true })
        .opacity(0.82)
        .duration(STORM_MS)
        .fadeIn(600)
        .fadeOut(STORM_MS - CLEAR_AT)     // starts clearing exactly when the bolts start
        .zIndex(0);
    }

    // ── Howling wind, faded so it punctuates instead of stomping the table ──
    if (wind) {
      seq.sound()
        .file(wind)
        .volume(0.55)
        .duration(STORM_MS)
        .fadeInAudio(200)
        .fadeOutAudio(900);
    }

    // ── Strikes, staggered across the run, landing inside the radius ──
    // Spread evenly so the last bolt lands before the storm fades rather than
    // all six stacking up front. Bigger than the first pass (3.5 squares, not
    // 2.5) so a bolt is unmistakably a bolt.
    if (strike) {
      // The beat Johnny asked for, in order: the mass rolls in and SITS there
      // ("they can't even see you"), and only then does it tear open — every
      // bolt lands during the clear, not buried under an opaque black sheet.
      // That's also why the bolts read as dark smudges before: they were firing
      // underneath the darkness while it was at full strength.
      const first = CLEAR_AT;
      const last  = STORM_MS - 400;
      const gap   = (last - first) / Math.max(1, STRIKE_COUNT - 1);
      for (let i = 0; i < STRIKE_COUNT; i++) {
        // Even-area distribution: sqrt keeps strikes from clustering at centre.
        const angle = Math.random() * Math.PI * 2;
        const dist  = Math.sqrt(Math.random()) * radiusPx * 0.85;
        const at    = Math.round(first + i * gap);
        seq.effect()
          .file(strike)
          .atLocation(anchor, { offset: { x: Math.cos(angle) * dist, y: Math.sin(angle) * dist } })
          .size(3.5, { gridUnits: true })
          .delay(at)
          .opacity(1)
          .zIndex(2);

        // Thunder on every other bolt — six claps in seven seconds is a mess,
        // three is a storm. Rotated through the available files so it doesn't
        // sound like the same sample on a loop, and lagged a beat behind the
        // flash the way real thunder trails lightning.
        if (thunder.length && i % 2 === 0) {
          seq.sound()
            .file(thunder[(i / 2) % thunder.length])
            .delay(at + 120)
            .volume(0.7);
        }
      }
    }

    seq.play();
  }
}
