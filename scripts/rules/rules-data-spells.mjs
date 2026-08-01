// ─── ACE: QOL — Rules Data: Spells (Phase 1 of the rules engine) ──────────────
//
// THE structured rules model. Each entry states what a spell ACTUALLY DOES per
// the printed rules — mechanics as data, not code. The rules brain looks
// entries up deterministically (normalized name + edition); the executors
// (space-effects today, more later) turn them into live mechanics. Adding a
// spell to the engine = adding a DATA entry here, never bespoke code.
//
// ── LEGAL ──
// Entries model SRD 5.1 (CC-BY-4.0) and SRD 5.2 (CC-BY-4.0) content —
// game mechanics in our own structure, shippable in a commercial module with
// attribution. Non-SRD content is NOT authored here; it gets drafted at the
// table from the GM's own licensed books (Phase 4) and stored as world data.
//
// ── SCHEMA v1 (space-focused; grows by phase) ──
// {
//   srd: true,                    // provenance
//   level: 2, school: "evo",
//   concentration: true,
//   expectedArea: { type, size }, // what the RULES say the template should be.
//                                 // The executor traces the ACTUAL template; a
//                                 // material mismatch logs a discrepancy — the
//                                 // "Foundry item disagrees with the book" signal.
//   space: {                      // properties of the SPACE the spell creates.
//     obscurement: "heavy"|"light"|null,   // sight-line blocking (Phase 2 consumes)
//     kind: "magicalDarkness"|"fog"|"web"|null,  // WHAT the obscurement is —
//                                 // determines which senses pierce it
//     pierceBy: [ ... ],          // senses/features that see through it:
//                                 //   "devilsSight" | "truesight" | "blindsight"
//                                 // (darkvision NEVER pierces magical darkness or
//                                 //  fog — that absence is load-bearing RAW)
//     silence: false,             // no sound within or passing through
//     difficultTerrain: null|2,   // movement-cost multiplier (2 = standard)
//     light: { mode: "override", level: 1 } | null,
//                                 // darkness level inside the area (1 = pitch
//                                 // black) — drives a native region behavior
//     stampInside: ["deafened"],  // conditions STAMPED on tokens while inside
//                                 // (applied on entry, removed on exit/region
//                                 // delete; v1 center-based containment)
//   },
//   byEdition: { "2014": {...}, "2024": {...} },  // shallow overrides when the
//                                 // editions genuinely differ (top level = shared)
//   notes: "...",
// }
//
// KEYS are normalized: lowercase, trimmed. The brain normalizes before lookup.
// ──────────────────────────────────────────────────────────────────────────────

export const RULES_SCHEMA_VERSION = 1;

export const SPELL_RULES = {

  // ── Darkness — SRD 5.1 p.230 / SRD 5.2 ─────────────────────────────────────
  // "Magical darkness spreads from a point you choose within range to fill a
  //  15-foot-radius sphere... A creature with darkvision can't see through
  //  this darkness, and nonmagical light can't illuminate it."
  // Identical mechanics in 2024 wording. NOT a condition on creatures — a
  // property of SPACE: a creature is effectively blinded only when trying to
  // see something IN the area (per-sight-line, evaluated at action time —
  // Phase 2). Devil's Sight ("you can see normally in darkness, both magical
  // and nonmagical") and truesight pierce it; blindsight doesn't use sight;
  // darkvision explicitly does NOT.
  "darkness": {
    srd: true,
    level: 2, school: "evo",
    concentration: true,
    expectedArea: { type: "sphere", size: 15 },
    space: {
      obscurement: "heavy",
      kind: "magicalDarkness",
      pierceBy: ["devilsSight", "truesight", "blindsight"],
      silence: false,
      difficultTerrain: null,
      light: { mode: "override", level: 1 },
    },
    notes: "If cast on an object, the darkness moves with it (mobile carrier not modeled in Phase 1 — template is static). Nonmagical light can't illuminate the area; a 2nd-level-or-lower light spell in the area is dispelled/suppressed (light-vs-darkness interaction is a later phase).",
  },

  // ── Tricksy — Fey Spirit trait (Summon Fey; mechanics-only, not SRD) ────────
  // The summoned fey's OWN darkness: "can create a 5-foot cube of magical
  // darkness on a point it can see within 5 feet of it, which lasts until the
  // end of its next turn." NOT the Darkness spell — a distinct rule keyed by
  // the feat's name. Proven live 2026-07-09 21:29: the interceptor + space
  // diagnostic caught the fey casting item "Tricksy" with no entry — the
  // engine's coverage-gap design working as intended. Same magical-darkness
  // space properties as the spell; no concentration (short duration — the
  // region dies with the template on any end path).
  "tricksy": {
    srd: false,
    level: 0, school: null,
    concentration: false,
    expectedArea: { type: "cube", size: 5 },
    space: {
      obscurement: "heavy",
      kind: "magicalDarkness",
      pierceBy: ["devilsSight", "truesight", "blindsight"],
      silence: false,
      difficultTerrain: null,
      light: { mode: "override", level: 1 },
    },
    notes: "Fey Spirit (Summon Fey) trait. Lasts until the end of the fey's next turn — dnd5e/GM removes the template; the region cascades.",
  },

  // ── Fog Cloud — SRD 5.1 p.243 / SRD 5.2 ────────────────────────────────────
  // "You create a 20-foot-radius sphere of fog... The sphere spreads around
  //  corners, and its area is heavily obscured."
  // Fog is NOT darkness: darkvision doesn't help, Devil's Sight doesn't help,
  // and RAW truesight doesn't either (it pierces darkness, invisibility, and
  // illusions — fog is none of those). Only blindsight perceives through it.
  // No light change — a brightly lit fog bank is still opaque.
  "fog cloud": {
    srd: true,
    level: 1, school: "con",
    concentration: true,
    expectedArea: { type: "sphere", size: 20 },
    space: {
      obscurement: "heavy",
      kind: "fog",
      pierceBy: ["blindsight"],
      silence: false,
      difficultTerrain: null,
      light: null,
    },
    notes: "Wind (moderate+) disperses it early — GM call, not modeled. Radius grows +20 ft per slot level above 1st (region traces the actual template, so upcasting is covered by construction).",
  },

  // ── Silence — SRD 5.1 p.275 / SRD 5.2 ──────────────────────────────────────
  // "For the duration, no sound can be created within or pass through a
  //  20-foot-radius sphere... A creature... is deafened while entirely inside
  //  it. Casting a spell that includes a verbal component is impossible there."
  // Phase 1 live enforcement: verbal casting is blocked from inside the sphere
  // (CombatContext's casting gate reads the space). Deafened-while-inside and
  // thunder-damage immunity inside are Phase 2 (per-token stamping on entry/exit).
  "silence": {
    srd: true,
    level: 2, school: "ill",
    concentration: true,
    expectedArea: { type: "sphere", size: 20 },
    space: {
      obscurement: null,
      kind: null,
      pierceBy: [],
      silence: true,
      difficultTerrain: null,
      light: null,
      stampInside: ["deafened"],
    },
    notes: "Ritual. Deafened stamped while inside (v1 center-based; RAW says entirely within). Thunder immunity inside is a later phase. Verbal-component casting impossible inside — LIVE.",
  },

  // ── Cloudkill — SRD ─────────────────────────────────────────────────────────
  // 20-ft-radius sphere of poisonous fog; area heavily obscured. The cloud
  // moving 10 ft away each round is not modeled (template is static — GM drags).
  "cloudkill": {
    srd: true,
    level: 5, school: "con",
    concentration: true,
    expectedArea: { type: "sphere", size: 20 },
    space: { obscurement: "heavy", kind: "fog", pierceBy: ["blindsight"], silence: false, difficultTerrain: null, light: null },
    notes: "Save/damage machinery stays with the areaDenial path (spell-timing). Moves 10 ft/round away from caster — GM drags the template; the region follows on recreation.",
  },

  // ── Stinking Cloud — SRD ────────────────────────────────────────────────────
  "stinking cloud": {
    srd: true,
    level: 3, school: "con",
    concentration: true,
    expectedArea: { type: "sphere", size: 20 },
    space: { obscurement: "heavy", kind: "fog", pierceBy: ["blindsight"], silence: false, difficultTerrain: null, light: null },
    notes: "Nausea save machinery stays with the areaDenial path (spell-timing).",
  },

  // ── Incendiary Cloud — SRD ──────────────────────────────────────────────────
  "incendiary cloud": {
    srd: true,
    level: 8, school: "con",
    concentration: true,
    expectedArea: { type: "sphere", size: 20 },
    space: { obscurement: "heavy", kind: "fog", pierceBy: ["blindsight"], silence: false, difficultTerrain: null, light: null },
    notes: "Damage machinery stays with the areaDenial path. Moves 10 ft/round — GM drags.",
  },

  // ── Sleet Storm — SRD ───────────────────────────────────────────────────────
  // 40-ft-radius, 20-ft-tall cylinder: heavily obscured AND slick-ice
  // difficult terrain.
  "sleet storm": {
    srd: true,
    level: 3, school: "con",
    concentration: true,
    expectedArea: { type: "cylinder", size: 40 },
    space: { obscurement: "heavy", kind: "fog", pierceBy: ["blindsight"], silence: false, difficultTerrain: 2, light: null },
    notes: "Prone save on entering/starting turn stays with spell-timing. Extinguishes open flames.",
  },

  // ── Hunger of Hadar — mechanics-only entry (not SRD) ────────────────────────
  // Lightless void: no light illuminates it, creatures fully inside are
  // blinded. Devil's Sight does NOT pierce it (the void blinds — it is not
  // mere darkness); nothing on the pierce list. Difficult terrain inside.
  "hunger of hadar": {
    srd: false,
    level: 3, school: "con",
    concentration: true,
    expectedArea: { type: "sphere", size: 20 },
    space: { obscurement: "heavy", kind: "magicalDarkness", pierceBy: ["truesight", "blindsight"], silence: false, difficultTerrain: 2, terrainModes: ["walk", "fly"], light: { mode: "override", level: 1 }, stampInside: ["blinded"] },
    notes: "Blinded stamped while inside the void (v1 center-based; RAW says fully within). Cold/acid damage phases stay with spell-timing. Devil's Sight deliberately NOT on the pierce list.",
  },

  // ── Insect Plague — SRD ─────────────────────────────────────────────────────
  "insect plague": {
    srd: true,
    level: 5, school: "con",
    concentration: true,
    expectedArea: { type: "sphere", size: 20 },
    space: { obscurement: "light", kind: null, pierceBy: [], silence: false, difficultTerrain: 2, terrainModes: ["walk", "fly"], light: null },
    notes: "Lightly obscured + difficult terrain. Damage machinery stays with spell-timing.",
  },

  // ── Grease — SRD ────────────────────────────────────────────────────────────
  // CONVERGENCE: terrain moves here from the legacy path (the guard defers).
  "grease": {
    srd: true,
    level: 1, school: "con",
    concentration: false,
    expectedArea: { type: "cube", size: 10 },
    space: { obscurement: null, kind: null, pierceBy: [], silence: false, difficultTerrain: 2, light: null },
    durationSeconds: 60,   // 1 minute, no concentration — expires on its own
    notes: "Prone save on entry/turn stays with spell-timing. 1-minute duration, no concentration. Before 2026-07-28 nothing ever removed the template, so the region lived forever and stacked with every re-cast.",
  },

  // ── Spike Growth — SRD ──────────────────────────────────────────────────────
  // CONVERGENCE: terrain moves here from the legacy path. The ground is
  // camouflaged (Perception to notice) — no obscurement.
  "spike growth": {
    srd: true,
    level: 2, school: "trs",
    concentration: true,
    expectedArea: { type: "sphere", size: 20 },
    space: { obscurement: null, kind: null, pierceBy: [], silence: false, difficultTerrain: 2, light: null },
    notes: "2d4-per-5-ft movement damage stays with spell-timing's movement-damage path.",
  },

  // ── Entangle — SRD ──────────────────────────────────────────────────────────
  // "Grasping weeds and vines sprout... turning the ground in the area into
  //  difficult terrain." The STR save / restrained machinery stays with the
  //  parser + save-engine; the SPACE (terrain) lives here.
  "entangle": {
    srd: true,
    level: 1, school: "con",
    concentration: true,
    expectedArea: { type: "square", size: 20 },
    space: { obscurement: null, kind: null, pierceBy: [], silence: false, difficultTerrain: 2, light: null },
    notes: "STR save vs restrained on cast (and to break free) stays with the save flow. Area is lightly obscured per some readings — RAW says only difficult terrain; kept terrain-only.",
  },

  // ── Black Tentacles — SRD (Evard's) ─────────────────────────────────────────
  "black tentacles": {
    srd: true,
    level: 4, school: "con",
    concentration: true,
    expectedArea: { type: "square", size: 20 },
    space: { obscurement: null, kind: null, pierceBy: [], silence: false, difficultTerrain: 2, light: null },
    notes: "DEX save vs restrained + 3d6 on entry/turn stays with the save flow. Difficult terrain is the space's own property.",
  },

  // ── Plant Growth — SRD ──────────────────────────────────────────────────────
  // Overgrowth option: "a creature moving through the area must spend 4 feet
  // of movement for every 1 foot it moves" — a ×4 multiplier, the only one
  // in the SRD. The 8-hour enrichment option has no combat footprint.
  "plant growth": {
    srd: true,
    level: 3, school: "trs",
    concentration: false,
    expectedArea: { type: "sphere", size: 100 },
    space: { obscurement: null, kind: null, pierceBy: [], silence: false, difficultTerrain: 4, light: null },
    notes: "Overgrowth cast (action): ×4 movement cost. GM can exclude clear paths RAW — the region traces the placed template.",
  },

  // ── Wall of Thorns — SRD ────────────────────────────────────────────────────
  // Moving through the wall is slowed (4 ft per 1 ft) and deals damage —
  // the damage stays with the movement-damage path; the ×4 cost lives here.
  "wall of thorns": {
    srd: true,
    level: 6, school: "con",
    concentration: true,
    expectedArea: { type: "wall", size: 60 },
    space: { obscurement: null, kind: null, pierceBy: [], silence: false, difficultTerrain: 4, terrainModes: ["walk", "fly"], light: null },
    notes: "Blocks line of sight RAW ('blocks line of sight') — sight-blocker walls are a later phase; terrain + the movement-damage path cover the mechanics now.",
  },

  // ── Web — SRD 5.1 p.287 / SRD 5.2 ──────────────────────────────────────────
  // "...webs fill a 20-foot cube... The webs are difficult terrain and lightly
  //  obscure their area."
  // CONVERGENCE ENTRY: the save machinery (Dex save on entry/turn, Restrained,
  // STR break-free) stays with the proven save-engine + concentration-widget
  // path (driven by spell-timing's "web" entry). What moves HERE is the SPACE:
  // difficult terrain (region movement cost) + light obscurement. The legacy
  // difficult-terrain creator defers to this entry when it exists — one region,
  // one owner.
  "web": {
    srd: true,
    level: 2, school: "con",
    concentration: true,
    expectedArea: { type: "cube", size: 20 },
    space: {
      obscurement: "light",
      kind: "web",
      pierceBy: [],           // lightly obscured = disadvantage on Perception
                              // (sight), not blocked — Phase 2 nuance
      silence: false,
      difficultTerrain: 2,
      terrainModes: ["walk", "fly"],   // webs FILL the cube — flying through is just as slow
      light: null,
    },
    notes: "Flammable: fire burns 5-ft cubes away (2d4 fire, later phase). Needs anchoring surfaces or the web collapses (GM call). Save/restrain machinery remains with save-engine + concentration-widget.",
  },

  // ── Thunderstorm of Misery — Stormforger staff (magic item) ───────────────
  // "Summon a powerful storm around you in a 50ft radius for 1 minute. The storm
  //  creates dangerous terrain, making the ground slippery and filled with
  //  debris, making it difficult for creatures within the area of effect to move
  //  around. The winds, lightning strikes and heavy rain make it hard for
  //  creatures to see or hear, imposing disadvantage on any perception checks
  //  made while within the storm."
  //
  // The 8d6 lightning DEX save is the item's own save ACTIVITY and stays there —
  // this entry owns THE SPACE, exactly like Web: difficult terrain + the
  // see/hear penalty. Light obscurement is the RAW-equivalent encoding of
  // "hard to see" (disadvantage on sight Perception, not blocked); `deafened`
  // is stamped for "hard to hear", which the hearing gate already consumes for
  // components and audible triggers. (Built 2026-07-27.)
  "thunderstorm of misery": {
    srd: false,
    level: 0, school: "evo",
    concentration: false,
    expectedArea: { type: "radius", size: 50 },
    space: {
      obscurement: "light",
      kind: "storm",
      pierceBy: [],            // driving rain + debris blinds everyone equally
      silence: false,          // NOT silence — sound exists, it's just drowned out
      difficultTerrain: 2,     // slippery ground + debris
      light: null,
      stampInside: ["deafened"],
    },
    durationSeconds: 60,   // 1 minute, no concentration — expires on its own
    notes: "Stormforger staff, 9 charges, 1 minute, 50-ft radius centred on the wielder. The 8d6 lightning DEX save is the item's save activity. Space owns: difficult terrain + light obscurement (disadvantage on sight Perception) + deafened while inside (howling wind/rain).",
  },
};

// ── Item-name aliases ───────────────────────────────────────────────────────
// The brain looks a space up by the ITEM's name, but a magic item's area
// ability is an ACTIVITY inside it — the Stormforger staff's storm is one of
// four activities, so a lookup on "Stormforger" would miss the entry keyed to
// the ability. Aliasing the item name to the same entry closes that gap, and it
// is SAFE because a space is only ever built when a TEMPLATE is placed
// (SpaceEffects hooks createMeasuredTemplate): of this staff's four activities
// only Thunderstorm of Misery places one — Tornado Takedown targets a single
// creature and the two flight abilities are self-only. (2026-07-27.)
SPELL_RULES["stormforger"] = SPELL_RULES["thunderstorm of misery"];

/**
 * Validate one entry against schema v1. Returns an array of problem strings —
 * empty when clean. Run on load so a malformed entry announces itself at boot
 * instead of silently misbehaving at the table.
 */
export function validateSpellRuleEntry(name, entry) {
  const problems = [];
  if (!entry || typeof entry !== "object") return [`${name}: entry is not an object`];
  if (entry.space) {
    const s = entry.space;
    if (s.obscurement != null && !["heavy", "light"].includes(s.obscurement))
      problems.push(`${name}: space.obscurement "${s.obscurement}" invalid`);
    if (!Array.isArray(s.pierceBy))
      problems.push(`${name}: space.pierceBy must be an array`);
    else for (const p of s.pierceBy) {
      if (!["devilsSight", "truesight", "blindsight"].includes(p))
        problems.push(`${name}: space.pierceBy contains unknown sense "${p}"`);
    }
    if (s.difficultTerrain != null && !(Number(s.difficultTerrain) > 1))
      problems.push(`${name}: space.difficultTerrain must be a multiplier > 1 or null`);
    // Which movement types the terrain actually impedes. Omitted = ground only
    // (walk), which is RAW for nearly all difficult terrain — a flier above
    // grease or slippery ground is unaffected. Volume-filling effects opt in
    // to "fly". Only non-derived actions are meaningful here; crawl/climb/jump
    // resolve themselves from walk and fly.
    if (s.terrainModes != null) {
      if (!Array.isArray(s.terrainModes) || !s.terrainModes.length)
        problems.push(`${name}: space.terrainModes must be a non-empty array or omitted`);
      else for (const m of s.terrainModes) {
        if (!["walk", "fly", "swim", "burrow"].includes(m))
          problems.push(`${name}: space.terrainModes contains unknown movement "${m}"`);
      }
    }
    if (s.light != null && (s.light.mode !== "override" || !(s.light.level >= 0 && s.light.level <= 1)))
      problems.push(`${name}: space.light must be { mode: "override", level: 0..1 } or null`);
  }
  if (entry.expectedArea && (!entry.expectedArea.type || !(Number(entry.expectedArea.size) > 0)))
    problems.push(`${name}: expectedArea needs { type, size>0 }`);
  return problems;
}

/** Self-check every entry once at load — a malformed entry warns at boot. */
export function validateAllSpellRules() {
  const all = [];
  for (const [name, entry] of Object.entries(SPELL_RULES)) {
    all.push(...validateSpellRuleEntry(name, entry));
  }
  return all;
}
