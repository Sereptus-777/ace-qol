// ─── ACE: QOL — Environment Profile (the THIRD third of THE ONE GATE) ────────
//
// WHAT IS BETWEEN THEM. The space the attack has to cross, and the ground both
// creatures are standing on.
//
// ⚠️🔴 WHY THIS FILE EXISTS. It did not, until 2026-08-26. Elevation, cover,
// light, terrain and walls were each read by whichever pipeline happened to
// care, in its own way, or not at all. Johnny cast Frostbite at a creature
// sixty feet away and thirty feet DOWN and nothing objected, because a save
// spell goes through the save engine and the save engine measures nothing.
//
// Johnny, 2026-08-25: "The environment should know the environment exactly:
// what elevation this thing is at, whether it is standing on ice, all the
// fucking things."
//
// DESIGN CONTRACT — the same three rules the rest of the Gate runs on:
//   • IT REPORTS, IT DOES NOT DECIDE. `coverLevel: "half"` and `acBonus: 2`,
//     never `advantage: false`. Whether cover beats a Sharpshooter is the
//     resolver's call.
//   • IT SAYS WHAT IT COULD NOT SEE. A wall test that throws records why,
//     because "no wall between them" and "could not check for walls" are
//     opposite facts that used to print the same.
//   • IT NEVER INVENTS. Where a reader is missing, the field is null with a
//     note — not a cheerful default that reads like a measurement.
//
// ⚠️ FAIL OPEN, AND SAY SO. A geometry check that throws must never block a
// legitimate attack. Every one of them defaults to "unobstructed" AND pushes a
// line into `problems`, so a table where cover silently stopped working can be
// diagnosed from one console line instead of a week of confusion.
//
// ⚠️ THE ONLY WALL TEST THAT WORKS on Foundry 13 is
// `CONFIG.Canvas.polygonBackends.<type>.testCollision`. `canvas.walls.
// checkCollision` DOES NOT EXIST and `Ray` is not a global; both were tried,
// both threw into a catch that answered "no wall", and wall checking was
// silently dead twice over (2026-08-06). Verify against the live API before
// changing this. Do not "fix" it from documentation.
// ──────────────────────────────────────────────────────────────────────────────

import { aceDistanceFt } from "../geometry-utils.mjs";
import { CoverEngine } from "../cover-engine.mjs";
import { SpaceEffects } from "../rules/space-effects.mjs";
// ⚠️ Weather is part of WHERE THEY ARE, so it belongs on this profile and
// not in a corner of the attack pipeline. Johnny asked for it by name: "are they
// in the rain, are they slipping around, is it snowing".
import { readWeather } from "../rules/weather.mjs";
// ⚠️ The third effects source: what a PLACE imposes, as opposed to what is
// riding on either creature. It stays silent about anything already applied,
// because ACE's aura engine writes real effects and counting both would double.
import { readSpaceEffects } from "./space-effects-reader.mjs";

/** A point the polygon backends will accept, from a token or token document. */
function _centerOf(tok) {
  const o = tok?.object ?? tok;
  if (o?.center) return { x: o.center.x, y: o.center.y };
  const d = tok?.document ?? tok;
  const gs = canvas?.grid?.size ?? 100;
  const w = Number(d?.width ?? 1) || 1;
  const h = Number(d?.height ?? 1) || 1;
  return { x: (Number(d?.x) || 0) + (w * gs) / 2, y: (Number(d?.y) || 0) + (h * gs) / 2 };
}

/**
 * Is something in the way, for one kind of blocking?
 *
 * @param {"move"|"sight"|"sound"|"light"} type
 * @returns {boolean|null} true blocked, false clear, null could not be tested
 */
function _blocked(type, from, to, problems) {
  try {
    const backend = CONFIG?.Canvas?.polygonBackends?.[type];
    if (!backend?.testCollision) {
      problems.push(`no ${type} polygon backend on this Foundry build — ${type} blocking was not tested`);
      return null;
    }
    return !!backend.testCollision(from, to, { type, mode: "any" });
  } catch (err) {
    // ⚠️ "COULD NOT CHECK" IS NOT "NOTHING THERE". Answering false here is what
    // disabled wall checking twice without anybody noticing.
    problems.push(`the ${type} wall test threw (${err?.message ?? err}) — treated as clear`);
    return null;
  }
}

/** Foundry's darkness level for the scene, 0 (bright) → 1 (pitch dark). */
function _sceneDarkness() {
  try {
    return Number(canvas?.scene?.environment?.darknessLevel
      ?? canvas?.scene?.darkness ?? 0) || 0;
  } catch (_) { return 0; }
}

/**
 * How lit is this point?
 *
 * ⚠️ FOUNDRY DOES NOT HAND OUT A LIGHT LEVEL, so this is derived from the
 * scene's darkness and the light sources that actually reach the point. It is
 * reported as a best reading with its basis attached, never as gospel — a
 * number a GM can argue with beats a number that pretends to be certain.
 */
function _lightAt(point, problems) {
  const dark = _sceneDarkness();
  try {
    const sources = canvas?.effects?.lightSources ?? canvas?.effects?.lightSources?.values?.() ?? [];
    let best = "dark";
    for (const src of sources) {
      if (!src?.active || src.disabled) continue;
      const d = src.data ?? src;
      const dx = point.x - (d.x ?? 0);
      const dy = point.y - (d.y ?? 0);
      const px = Math.hypot(dx, dy);
      const gs = canvas?.grid?.size ?? 100;
      const gd = canvas?.grid?.distance ?? 5;
      const ft = (px / gs) * gd;
      if (ft <= (Number(d.bright) || 0)) return { level: "bright", basis: "inside a light source's bright radius" };
      if (ft <= (Number(d.dim) || 0)) best = "dim";
    }
    if (best === "dim") return { level: "dim", basis: "inside a light source's dim radius" };
    if (dark <= 0.25) return { level: "bright", basis: "the scene itself is lit" };
    if (dark <= 0.75) return { level: "dim", basis: `scene darkness ${dark.toFixed(2)}` };
    return { level: "dark", basis: `scene darkness ${dark.toFixed(2)}, no source reaches here` };
  } catch (err) {
    problems.push(`could not read the light at a point: ${err?.message ?? err}`);
    return { level: null, basis: "could not be read" };
  }
}

/** Terrain-ish regions standing at a point, by name. */
// ═══ WHAT ARE THEY STANDING IN? ══════════════════════════════════
//
// ⚠️🔴 THIS PROFILE HAD 26 FIELDS AND NOT ONE OF THEM WAS TERRAIN. It knew
// how far apart two creatures were, what cover stood between them and how
// bright it was, and had no idea whether they were on an icy ledge, waist deep
// in a river, or standing in a boat.
//
// Johnny, 2026-08-27: "it's got to consider the environment too. Does it know
// what map it's on? Dude doesn't know where they are. Are they out on an icy
// cliff somewhere? Are they in the middle of a river in a boat or just
// swimming?"
//
// ⚠️ TWO SIGNALS, AND THEY ARE NOT EQUALLY GOOD. Say which one answered.
//
//   modifyMovementCost   a CORE Foundry region behaviour. If a region carries
//                        it, difficult terrain is a FACT, not a reading.
//   the region's NAME    everything else. Foundry has no native concept of
//                        water, ice or lava, so "Frozen Lake" is the only
//                        clue there is - and it is a GUESS. A GM who names a
//                        region "The Icehouse" gets ice they did not mean.
//
// So both are reported, tagged with where they came from, and a consumer that
// wants to refuse an action can decide how much it trusts each. Nothing here
// decides anything: the profile reports, the resolver judges.

/** Region-name words that suggest a terrain kind. Best effort, never a fact. */
const TERRAIN_WORDS = {
  water:  ["water", "river", "lake", "sea", "ocean", "pond", "flood", "shallows", "surf", "canal", "moat"],
  deep:   ["deep water", "underwater", "submerged", "depths", "drowning"],
  ice:    ["ice", "icy", "frozen", "glacier", "frost", "sleet"],
  snow:   ["snow", "drift", "blizzard"],
  lava:   ["lava", "magma", "molten"],
  swamp:  ["swamp", "bog", "marsh", "mire", "quagmire", "mud"],
  rubble: ["rubble", "debris", "scree", "gravel", "wreck"],
  brush:  ["brush", "undergrowth", "briar", "thicket", "bramble"],
  sand:   ["sand", "dune", "desert"],
  boat:   ["boat", "ship", "raft", "deck", "vessel", "barge"],
};

/**
 * Everything readable about the ground under one token.
 *
 * @returns {object} kinds, difficulty, and WHERE each answer came from
 */
function _terrainAt(tok, problems) {
  const out = {
    regions: [],
    kinds: [],
    difficult: null,          // null = could not tell, not "no"
    movementCostMultiplier: null,
    difficultSource: "nothing declares it",
    kindSource: "nothing declares it",
  };
  try {
    const doc = tok?.document ?? tok;
    if (!doc) return out;

    const named = [];
    for (const region of canvas?.scene?.regions ?? []) {
      try {
        if (!region.tokens?.has?.(doc)) continue;
        const name = region.name ?? "(unnamed region)";
        out.regions.push(name);
        named.push(String(name).toLowerCase());

        for (const b of region.behaviors ?? []) {
          if (b?.disabled) continue;
          if (b?.type !== "modifyMovementCost") continue;
          // ⚠️ THE FACT PATH. A movement cost above 1 IS difficult terrain
          // by definition - no name-guessing involved.
          const terrain = b.system?.terrain ?? {};
          const worst = Math.max(...Object.values(terrain)
            .map(v => Number(v)).filter(Number.isFinite), 1);
          if (worst > 1) {
            out.difficult = true;
            out.movementCostMultiplier = worst;
            out.difficultSource = `the region "${name}" costs ${worst}x movement`;
          }
        }
      } catch (_) { /* a region that cannot answer is not one we count */ }
    }

    // ⚠️ NAME MATCHING IS A GUESS AND IS LABELLED AS ONE.
    const hay = named.join(" | ");
    if (hay) {
      for (const [kind, words] of Object.entries(TERRAIN_WORDS)) {
        if (words.some(w => hay.includes(w))) out.kinds.push(kind);
      }
      if (out.kinds.length) {
        out.kindSource = `guessed from the region name(s): ${out.regions.join(", ")}`;
      }
    }

    // Being in ANY region but reading no movement behaviour is a real answer:
    // it is not difficult terrain as far as Foundry is concerned.
    if (out.difficult === null && out.regions.length) {
      out.difficult = false;
      out.difficultSource = "no region here modifies movement cost";
    }
  } catch (err) {
    problems.push(`could not read the terrain: ${err?.message ?? err}`);
  }
  return out;
}

function _regionsAt(tok, problems) {
  const out = [];
  try {
    const doc = tok?.document ?? tok;
    for (const region of canvas?.scene?.regions ?? []) {
      try {
        if (region.tokens?.has?.(doc)) out.push(region.name ?? "(unnamed region)");
      } catch (_) { /* a region that cannot answer is not a region we count */ }
    }
  } catch (err) {
    problems.push(`could not read scene regions: ${err?.message ?? err}`);
  }
  return out;
}

/**
 * Build the environment profile between an attacker and a target.
 *
 * ⚠️ THE TARGET IS OPTIONAL. Half of this is true with nobody targeted — the
 * ground under the attacker, the light on them, the regions they stand in — and
 * a spell picking its target later still wants that half.
 *
 * @param {Token|TokenDocument} attackerToken
 * @param {Token|TokenDocument} [targetToken]
 * @returns {object} the EnvironmentProfile — never null, so no caller guards it
 */
export function buildEnvironmentProfile(attackerToken, targetToken = null) {
  const problems = [];
  const aDoc = attackerToken?.document ?? attackerToken ?? null;
  const tDoc = targetToken?.document ?? targetToken ?? null;

  if (!aDoc) problems.push("no attacker token — nothing about the space could be measured");

  const aCentre = aDoc ? _centerOf(attackerToken) : null;
  const tCentre = tDoc ? _centerOf(targetToken) : null;

  const aElev = Number(aDoc?.elevation ?? 0) || 0;
  const tElev = Number(tDoc?.elevation ?? 0) || 0;

  // ── Distance ────────────────────────────────────────────────────────────
  // ⚠️ NEAREST EDGE AND ELEVATION-AWARE. A flying attacker is not in melee
  // reach of the ground just because the squares line up from above.
  let distanceFt = null;
  if (aDoc && tDoc) {
    try {
      const d = aceDistanceFt(attackerToken, targetToken);
      distanceFt = Number.isFinite(d) ? Math.round(d) : null;
      if (distanceFt === null) problems.push("the distance could not be measured");
    } catch (err) {
      problems.push(`could not measure the distance: ${err?.message ?? err}`);
    }
  }

  // ── What is in the way ──────────────────────────────────────────────────
  const both = aCentre && tCentre;
  const movementBlocked = both ? _blocked("move", aCentre, tCentre, problems) : null;
  const sightBlocked = both ? _blocked("sight", aCentre, tCentre, problems) : null;
  const soundBlocked = both ? _blocked("sound", aCentre, tCentre, problems) : null;
  // ⚠️ LINE OF EFFECT IS NOT LINE OF SIGHT. A window blocks a fireball and not
  // a glance; a curtain does the reverse. Foundry models them as separate wall
  // restrictions, so they are reported separately rather than conflated.
  const effectBlocked = movementBlocked;

  // ── Cover, from the engine that already owns it ─────────────────────────
  let cover = { level: "No Cover", acBonus: 0, dexBonus: 0, blockedPct: 0, isFull: false };
  if (aDoc && tDoc) {
    try {
      const c = CoverEngine.calculateCover(attackerToken?.object ?? attackerToken,
                                           targetToken?.object ?? targetToken);
      if (c) {
        // ⚠️ THESE ARE THE ENGINE'S REAL FIELD NAMES, read out of
        // `CoverEngine._noCover()` rather than assumed. The first draft of this
        // file read `c.dexBonus` and `c.source`; neither exists, so the DEX save
        // bonus would have silently been the AC bonus and the reason would
        // always have been null. Guessing a shape is how a profile reports a
        // confident wrong number.
        cover = {
          level: c.label ?? "No Cover",
          acBonus: Number(c.acBonus ?? 0) || 0,
          dexBonus: Number(c.dexSaveBonus ?? 0) || 0,
          blockedPct: Number(c.blockedPct ?? 0) || 0,
          isFull: !!c.isFullCover,
        };
      }
    } catch (err) {
      problems.push(`the cover engine threw (${err?.message ?? err}) — treated as no cover`);
    }
  }

  // ── Light ───────────────────────────────────────────────────────────────
  const lightAtAttacker = aCentre ? _lightAt(aCentre, problems) : { level: null, basis: "no attacker token" };
  const lightAtTarget = tCentre ? _lightAt(tCentre, problems) : { level: null, basis: "no target" };

  // ── Spell spaces standing over either end ───────────────────────────────
  let spacesAtAttacker = [];
  let spacesAtTarget = [];
  let attackerSilenced = false;
  let targetSilenced = false;
  try {
    if (attackerToken) spacesAtAttacker = SpaceEffects.spacesAtToken(attackerToken) ?? [];
    if (targetToken) spacesAtTarget = SpaceEffects.spacesAtToken(targetToken) ?? [];
    // ⚠️ SILENCE STOPS A VERBAL COMPONENT DEAD, and that is a fact about the
    // SPACE, not about the caster.
    if (attackerToken) attackerSilenced = !!SpaceEffects.tokenInSilence(attackerToken);
    if (targetToken) targetSilenced = !!SpaceEffects.tokenInSilence(targetToken);
  } catch (err) {
    problems.push(`could not read spell spaces: ${err?.message ?? err}`);
  }

  // ── Who else is standing near either end ────────────────────────────────
  // ⚠️ TWO DIFFERENT RULES LIVE HERE. Enemies beside the ATTACKER give a ranged
  // attack disadvantage; allies beside the TARGET are what a rogue's Sneak
  // Attack needs. Same measurement, opposite ends, opposite meanings.
  const near = { enemiesNearAttacker: [], alliesNearTarget: [], auraSources: [] };
  try {
    const gd = canvas?.grid?.distance ?? 5;
    for (const t of canvas?.tokens?.placeables ?? []) {
      if (!t?.actor) continue;
      const isSame = (x) => (x?.document?.id ?? x?.id) === (t.document?.id ?? t.id);
      if (aDoc && !isSame(attackerToken)) {
        const d = aceDistanceFt(attackerToken, t);
        if (Number.isFinite(d) && d <= gd
            && t.document?.disposition !== aDoc.disposition) {
          near.enemiesNearAttacker.push(t.name ?? "a creature");
        }
      }
      if (tDoc && !isSame(targetToken)) {
        const d = aceDistanceFt(targetToken, t);
        if (Number.isFinite(d) && d <= gd
            && t.document?.disposition !== tDoc.disposition) {
          // An enemy OF THE TARGET is an ally of the attacker.
          near.alliesNearTarget.push(t.name ?? "a creature");
        }
      }
    }
  } catch (err) {
    problems.push(`could not read who is standing nearby: ${err?.message ?? err}`);
  }

  return {
    kind: "environment-profile",
    schema: 1,

    // ── Geometry ──
    distanceFt,
    attackerElevationFt: aElev,
    targetElevationFt: tElev,
    elevationDeltaFt: tDoc ? (tElev - aElev) : null,
    targetIsAbove: tDoc ? tElev > aElev : null,
    gridDistance: Number(canvas?.grid?.distance ?? 5) || 5,
    gridUnits: String(canvas?.scene?.grid?.units ?? "ft"),
    targetOnCanvas: !!tDoc,

    // ── What blocks ──
    // null means "could not be tested", which is NOT the same as false.
    movementBlocked,
    sightBlocked,
    soundBlocked,
    effectBlocked,
    coverLevel: cover.level,
    coverAcBonus: cover.acBonus,
    coverDexBonus: cover.dexBonus,
    coverBlockedPct: cover.blockedPct,
    coverIsTotal: cover.isFull,

    // ── Light and sight ──
    sceneDarkness: _sceneDarkness(),
    lightAtAttacker: lightAtAttacker.level,
    lightAtAttackerBasis: lightAtAttacker.basis,
    lightAtTarget: lightAtTarget.level,
    lightAtTargetBasis: lightAtTarget.basis,
    // ⚠️ RAW: heavy obscurement blinds you; light obscurement gives
    // disadvantage on Perception. Reported as the CONDITION of the space, and
    // whether that blinds THIS creature depends on its senses — the resolver's
    // question, not ours.
    heavilyObscuredAtTarget: lightAtTarget.level === "dark",
    lightlyObscuredAtTarget: lightAtTarget.level === "dim",

    // ── Ground ──
    regionsAtAttacker: aDoc ? _regionsAt(attackerToken, problems) : [],
    regionsAtTarget: tDoc ? _regionsAt(targetToken, problems) : [],

    // ── WHERE THEY ARE STANDING ─────────────────────────────────
    //
    // ⚠️ EVERY ANSWER CARRIES ITS SOURCE. `difficult` from a region's
    // movement-cost behaviour is a FACT; `kinds` guessed from a region's NAME
    // is a guess, and a consumer is entitled to treat them differently. null
    // means "could not tell", never "no".
    terrainAtAttacker: aDoc ? _terrainAt(attackerToken, problems) : null,
    terrainAtTarget: tDoc ? _terrainAt(targetToken, problems) : null,

    // ⚠️ AND WHICH MAP THIS IS. Johnny: "Does it know what map it's on?
    // Dude doesn't know where they are." It did not - the profile could
    // measure the gap between two creatures without knowing the room existed.
    // ── Weather and footing ───────────────────────────────────────
    // Read for the ATTACKER's footing, because that is whose ranged attack the
    // wind spoils and whose feet go out from under them on the ice.
    weather: (() => {
      try {
        const kinds = aDoc ? (_terrainAt(attackerToken, problems)?.kinds ?? []) : [];
        return readWeather(canvas?.scene, kinds);
      } catch (err) {
        problems.push(`the weather could not be read: ${err?.message ?? err}`);
        return null;
      }
    })(),

    // ── What the SPACE itself offers ───────────────────────────────
    // Auras reaching the target's square and regions covering it. Anything
    // already on the creature's sheet is deliberately NOT repeated here.
    spaceAtTarget: (() => {
      try { return tDoc ? readSpaceEffects(targetToken) : null; }
      catch (err) {
        problems.push(`the space around the target could not be read: ${err?.message ?? err}`);
        return null;
      }
    })(),

    sceneName: canvas?.scene?.name ?? null,
    sceneId: canvas?.scene?.id ?? null,
    spacesAtAttacker,
    spacesAtTarget,
    attackerSilenced,
    targetSilenced,

    // ── Who else is here ──
    enemiesNearAttacker: near.enemiesNearAttacker,
    alliesNearTarget: near.alliesNearTarget,

    // ── When ──
    inCombat: !!game?.combat?.started,
    round: Number(game?.combat?.round ?? 0) || 0,
    worldTime: Number(game?.time?.worldTime ?? 0) || 0,

    // live references (same-client only)
    attackerToken,
    targetToken,

    // ⚠️ NEVER SILENTLY EMPTY.
    problems,
  };
}

/**
 * One line a human can read.
 *
 * ⚠️ IT SAYS "COULD NOT CHECK" OUT LOUD. A quiet environment line and a broken
 * one must never look the same — that is how wall checking stayed dead for two
 * weeks in June.
 */
/**
 * Underwater combat, RAW (PHB "Underwater Combat").
 *
 * ⚠️ NOTHING IN ACE IMPLEMENTED THIS. A party fighting in a flooded room
 * rolled exactly as if they were on dry land: no disadvantage on a longsword,
 * a longbow working perfectly at full range.
 *
 * The printed rules:
 *   • A MELEE weapon attack has disadvantage unless the weapon is a dagger,
 *     javelin, shortsword, spear or trident. A creature with a SWIMMING SPEED
 *     is exempt entirely.
 *   • A RANGED weapon attack automatically MISSES beyond its normal range,
 *     and has disadvantage within it - unless the weapon is a crossbow, a net,
 *     or a thrown javelin, spear, trident or dart.
 *
 * ⚠️ IT ANSWERS, IT DOES NOT APPLY. Whether "underwater" is even true here
 * is a guess off a region name, so this returns a verdict WITH its reasoning
 * and the caller decides whether to act on it. Applying disadvantage because a
 * GM called a region "Waterfall Overlook" would be worse than doing nothing.
 *
 * @param {object} env      an environment profile
 * @param {object} attack   an attack profile (for baseItem / kind)
 * @param {object} attacker an attacker profile (for a swim speed)
 * @returns {{applies:boolean, disadvantage:boolean, autoMiss:boolean, why:string}}
 */
export function underwaterRules(env, attack, attacker) {
  const no = { applies: false, disadvantage: false, autoMiss: false,
               why: "not underwater as far as anything on this scene says" };
  try {
    const t = env?.terrainAtAttacker;
    const wet = !!t && (t.kinds?.includes("deep") || t.kinds?.includes("water"));
    if (!wet) return no;

    const MELEE_OK  = ["dagger", "javelin", "shortsword", "spear", "trident"];
    const RANGED_OK = ["crossbow", "handcrossbow", "lightcrossbow", "heavycrossbow",
                       "net", "javelin", "spear", "trident", "dart"];
    const base = String(attack?.baseItem ?? "").toLowerCase();
    const isRanged = attack?.attackKind === "rwak" || attack?.attackKind === "rsak";

    if (!isRanged) {
      // A swimming speed removes the melee penalty outright.
      const swims = Number(attacker?.creature?.speeds?.swim ?? attacker?.speeds?.swim ?? 0) > 0;
      if (swims) {
        return { applies: true, disadvantage: false, autoMiss: false,
                 why: `${t.kindSource} - underwater, but this creature has a swimming speed` };
      }
      const fine = MELEE_OK.some(w => base.includes(w));
      return { applies: true, disadvantage: !fine, autoMiss: false,
               why: fine
                 ? `underwater, but a ${base} is one of the weapons that works there`
                 : `underwater and a ${base || "this weapon"} is not one of the five that works there (${t.kindSource})` };
    }

    const fine = RANGED_OK.some(w => base.includes(w));
    const beyondNormal = Number.isFinite(env?.distanceFt) && attack?.rangeNormal > 0
      && env.distanceFt > attack.rangeNormal;
    return {
      applies: true,
      disadvantage: !fine,
      autoMiss: !fine && beyondNormal,
      why: fine
        ? `underwater, but a ${base} is one of the ranged weapons that works there`
        : beyondNormal
          ? `underwater and ${env.distanceFt} feet away, past this weapon's normal range - RAW that is an automatic miss (${t.kindSource})`
          : `underwater with a ${base || "ranged weapon"} that is not exempt (${t.kindSource})`,
    };
  } catch (_) {
    return no;
  }
}

export function describeEnvironment(p) {
  if (!p) return "(no environment profile)";
  const bits = [];

  if (p.distanceFt !== null) bits.push(`${p.distanceFt} ${p.gridUnits} apart`);
  if (p.elevationDeltaFt) {
    bits.push(`${Math.abs(p.elevationDeltaFt)} ${p.gridUnits} ${p.targetIsAbove ? "above" : "below"}`);
  }
  if (p.coverLevel && p.coverLevel !== "No Cover") {
    bits.push(`${p.coverLevel} (+${p.coverAcBonus} AC, +${p.coverDexBonus} DEX saves`
      + `${p.coverBlockedPct ? `, ${p.coverBlockedPct}% blocked` : ""})`);
  }
  if (p.sightBlocked === true) bits.push("SIGHT BLOCKED");
  else if (p.sightBlocked === null && p.targetOnCanvas) bits.push("sight could not be tested");
  if (p.effectBlocked === true) bits.push("a wall is in the way");
  if (p.lightAtTarget && p.lightAtTarget !== "bright") bits.push(`target in ${p.lightAtTarget} light`);
  if (p.attackerSilenced) bits.push("ATTACKER IS IN SILENCE");
  if (p.spacesAtTarget?.length) bits.push(`target standing in ${p.spacesAtTarget.length} spell space(s)`);
  if (p.enemiesNearAttacker?.length) {
    bits.push(`${p.enemiesNearAttacker.length} enemy within reach of the attacker`);
  }
  if (p.alliesNearTarget?.length) {
    bits.push(`${p.alliesNearTarget.length} ally beside the target`);
  }
  if (p.problems?.length) bits.push(`PROBLEMS: ${p.problems.join("; ")}`);

  
  // ⚠️ THE GROUND GOES IN THE LINE. A Gate line that says how far apart
  // two creatures are and not that one of them is waist deep in a river is
  // describing half a situation.
  const _ground = [];
  const _t = p?.terrainAtAttacker;
  if (_t?.difficult === true) _ground.push(`difficult terrain (${_t.difficultSource})`);
  if (_t?.kinds?.length)      _ground.push(_t.kinds.join(" + "));
  const _where = p?.sceneName ? ` on "${p.sceneName}"` : "";
  const _groundTxt = _ground.length ? ` · ground: ${_ground.join(", ")}` : "";

  const _core = bits.length ? bits.join(" · ") : "nothing between them";
  return _core + _where + _groundTxt;
}
