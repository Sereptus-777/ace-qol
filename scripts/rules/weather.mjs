// ─── Weather, and what it actually does to a fight ──────────────────────────
//
// Johnny, 2026-08-28: "it's got to consider the environment too. Does it know
// what map it's on? Are they out on an icy cliff somewhere? Are they in the
// middle of a river in a boat or just swimming? Are they in the rain? Are they
// slipping around? Is it snowing?"
//
// ⚠️ IT READS THE FIELD HE ALREADY OWNS. Foundry's Scene configuration has a
// weather picker, and dnd5e and the DMG both have rules for what weather does.
// Building a second weather system beside the one in the software would be the
// Clock mistake again: a calendar was written before anyone checked that dnd5e
// already ships the Calendar of Harptos.
//
// ⚠️ AND IT IS HONEST THAT HIS SCENES ARE MOSTLY SILENT. Exactly one of the 420
// scenes in hijinx sets the weather field. So this reads three sources - the
// scene's weather, its regions, and its name - and reports "unknown" rather than
// "clear" when none of them say anything. Those are not the same answer, and
// treating silence as fair weather is how an icy cliff fights like a ballroom.
//
// RAW, from the DMG's wilderness and adventuring rules:
//   heavy precipitation  heavily obscured; disadvantage on Perception by sight
//                        AND hearing (the rain is loud)
//   strong wind          disadvantage on RANGED weapon attacks and on Perception
//                        by hearing; open flames go out; fog disperses
//   fog                  heavily obscured
//   extreme cold         DC 10 CON at the end of each hour or gain exhaustion
//   extreme heat         DC 5 CON, scaling with exertion
//   slippery ice         difficult terrain, and moving onto it for the first
//                        time on a turn calls for a DC 10 Dexterity (Acrobatics)
//                        check or you fall prone
//
// ⚠️ IMPORTS NOTHING. A leaf, so it can be read from the environment profile and
// from an offline harness both, and can never join an import cycle.

const _s = (v) => String(v ?? "").toLowerCase();

/**
 * Foundry's own weather effect ids, and what each one means in the rules.
 *
 * ⚠️ SEVERITY IS NOT IN FOUNDRY'S FIELD. Its picker offers "rain" and "rainStorm"
 * but nothing that says "this is heavy enough to obscure". The storm variants are
 * treated as heavy, plain rain as light, and light rain does NOT obscure or
 * impose disadvantage - inventing a penalty out of drizzle would quietly make
 * every outdoor fight harder than the rules say.
 */
const FOUNDRY_WEATHER = {
  rain:       { kind: "rain",  heavy: false },
  rainstorm:  { kind: "rain",  heavy: true, wind: true },
  rainsimple: { kind: "rain",  heavy: false },
  snow:       { kind: "snow",  heavy: false },
  snowstorm:  { kind: "snow",  heavy: true, wind: true },
  blizzard:   { kind: "snow",  heavy: true, wind: true, cold: true },
  fog:        { kind: "fog",   heavy: true },
  leaves:     { kind: "leaves", heavy: false },
  autumnleaves: { kind: "leaves", heavy: false },
  embers:     { kind: "embers", heavy: false },
  starfall:   { kind: "clear", heavy: false },
};

/** Words in a scene or region name that describe the weather over it. */
const WEATHER_WORDS = [
  [["blizzard", "whiteout"],                       { kind: "snow", heavy: true, wind: true, cold: true }],
  [["snowstorm"],                                  { kind: "snow", heavy: true, wind: true }],
  [["snow", "snowfall", "snowy"],                  { kind: "snow", heavy: false }],
  [["downpour", "rainstorm", "thunderstorm", "storm", "tempest", "monsoon"],
                                                   { kind: "rain", heavy: true, wind: true }],
  [["rain", "rainy", "drizzle"],                   { kind: "rain", heavy: false }],
  [["fog", "foggy", "mist", "misty", "haze"],      { kind: "fog", heavy: true }],
  [["gale", "windy", "howling wind", "high wind"], { kind: "wind", heavy: false, wind: true }],
  [["frozen", "frigid", "arctic", "freezing"],     { kind: "cold", heavy: false, cold: true }],
  [["scorching", "sweltering", "blistering heat"], { kind: "heat", heavy: false, heat: true }],
];

/**
 * Ground conditions that make a creature slip. Kept separate from weather on
 * purpose: ice underfoot is a property of the FLOOR, and it persists in a warm
 * cave with a frozen pool in it.
 */
const SLIPPERY_KINDS = new Set(["ice"]);

/**
 * What is the weather over this scene?
 *
 * @param {Scene}  scene
 * @param {string[]} [terrainKinds]  kinds already read from the regions under a
 *                                   token, so an icy region counts as slippery
 *                                   ground without re-reading the map.
 * @returns {object} kind, severity, the mechanics it imposes, and WHERE each
 *                   answer came from. `known:false` means nobody said.
 */
export function readWeather(scene, terrainKinds = []) {
  const sources = [];
  let w = null;

  try {
    // 1. Foundry's own field, the authority when it is set.
    const raw = _s(scene?.weather ?? scene?.environment?.weather);
    if (raw) {
      const hit = FOUNDRY_WEATHER[raw.replace(/[^a-z]/g, "")];
      if (hit) { w = { ...hit }; sources.push(`the scene's weather is set to "${raw}"`); }
    }

    // 2. The scene's name, which is how most GMs actually record it.
    if (!w) {
      const name = _s(scene?.name);
      for (const [words, spec] of WEATHER_WORDS) {
        const found = words.find(word => name.includes(word));
        if (found) { w = { ...spec }; sources.push(`the scene is called "${scene?.name}"`); break; }
      }
    }
  } catch (err) {
    console.warn("ace-qol | could not read the weather; treating it as unknown:", err);
  }

  // Slippery ground is independent of what is falling out of the sky.
  const slippery = (terrainKinds ?? []).some(k => SLIPPERY_KINDS.has(_s(k)));
  if (slippery) sources.push("the ground under it is icy");

  // ⚠️ UNKNOWN IS AN ANSWER, AND IT IS NOT "CLEAR". Only one of his 420 scenes
  // sets the field. Reporting fair weather for the other 419 would be inventing
  // a fact about his game.
  if (!w && !slippery) {
    return { known: false, kind: null, heavy: false, sources: [],
             effects: _noEffects(), summary: "nobody has said what the weather is" };
  }

  const kind = w?.kind ?? "clear";
  const heavy = !!w?.heavy;
  const wind = !!w?.wind;

  const effects = {
    // Heavy precipitation and fog are heavily obscured: effectively blinded
    // when trying to see through them.
    heavilyObscured: heavy && (kind === "rain" || kind === "snow" || kind === "fog"),
    // ⚠️ THE ONE THAT CHANGES EVERY ARCHER'S TURN. Strong wind gives
    // disadvantage on ranged WEAPON attacks. Not spell attacks, and not melee.
    rangedWeaponDisadvantage: wind,
    perceptionSightDisadvantage: heavy && kind !== "wind",
    // Heavy rain and strong wind are both loud.
    perceptionHearingDisadvantage: (heavy && kind === "rain") || wind,
    openFlamesExtinguished: wind,
    exhaustionSave: w?.cold ? { ability: "con", dc: 10, per: "hour", reason: "extreme cold" }
                  : w?.heat ? { ability: "con", dc: 5,  per: "hour", reason: "extreme heat" }
                  : null,
    // ⚠️ THE SLIP CHECK IS A CHECK, NOT A SAVE, AND IT IS ONCE PER TURN. DMG:
    // moving onto slippery ice for the first time on a turn calls for a DC 10
    // Dexterity (Acrobatics) check or you fall prone. Rolling it per square
    // would put a party on its back crossing one frozen pond.
    slipperyGround: slippery
      ? { check: "acr", ability: "dex", dc: 10, oncePerTurn: true,
          onFail: "prone", alsoDifficultTerrain: true }
      : null,
  };

  return {
    known: true, kind, heavy, wind,
    cold: !!w?.cold, heat: !!w?.heat, slippery,
    sources, effects,
    summary: _summarise(kind, heavy, wind, slippery),
  };
}

function _noEffects() {
  return { heavilyObscured: false, rangedWeaponDisadvantage: false,
           perceptionSightDisadvantage: false, perceptionHearingDisadvantage: false,
           openFlamesExtinguished: false, exhaustionSave: null, slipperyGround: null };
}

function _summarise(kind, heavy, wind, slippery) {
  const bits = [];
  if (kind && kind !== "clear") bits.push(heavy ? `heavy ${kind}` : kind);
  if (wind) bits.push("strong wind");
  if (slippery) bits.push("icy footing");
  return bits.length ? bits.join(", ") : "clear";
}

/** Plain sentences a GM can read on a card. */
export function describeWeather(w) {
  if (!w?.known) return "Nobody has said what the weather is here.";
  const out = [`It is ${w.summary}.`];
  const e = w.effects;
  if (e.heavilyObscured) out.push("The air is heavily obscured, so seeing through it counts as blinded.");
  if (e.rangedWeaponDisadvantage) out.push("Ranged weapon attacks have disadvantage in this wind.");
  if (e.perceptionSightDisadvantage || e.perceptionHearingDisadvantage) {
    out.push("Spotting anything is harder"
      + (e.perceptionHearingDisadvantage ? ", and it is too loud to hear well" : "") + ".");
  }
  if (e.openFlamesExtinguished) out.push("Open flames are blown out.");
  if (e.slipperyGround) out.push("The footing is icy: moving onto it the first time on a turn "
    + "calls for a DC 10 Dexterity (Acrobatics) check or you fall prone.");
  if (e.exhaustionSave) out.push(`The ${e.exhaustionSave.reason} calls for a DC ${e.exhaustionSave.dc} `
    + `Constitution save each hour or a level of exhaustion.`);
  return out.join(" ");
}
