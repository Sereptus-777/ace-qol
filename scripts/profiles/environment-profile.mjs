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

  return bits.length ? bits.join(" · ") : "nothing between them";
}
