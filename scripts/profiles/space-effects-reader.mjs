// ─── What does standing HERE do to you? ─────────────────────────────────────
//
// The third source in the effects design. An effect is always ON something or
// FROM somewhere, and these are the ones that belong to a PLACE rather than a
// creature: a region behaviour, an aura whose radius reaches this square, a
// template covering it.
//
// ⚠️🔴 THE DOUBLE-COUNT IS THE WHOLE DANGER HERE. ACE's aura engine writes REAL
// Active Effects onto tokens, so a paladin's Aura of Protection becomes an
// actual effect on the ally's sheet. If the target profile reports "+3 to saves
// from an effect" AND this reports "you are standing in an aura granting +3 to
// saves", the Gate adds six. Both sources are real, the number is plausible, and
// nobody catches it without doing the arithmetic by hand.
//
// So the rule is absolute: THIS REPORTS WHAT THE SPACE OFFERS, NEVER WHAT HAS
// ALREADY LANDED ON THE CREATURE. Anything already applied belongs to that
// creature's own profile and this stays silent about it.
//
// ⚠️ THEN WHY READ AURAS AT ALL? Because auras apply on MOVEMENT, and there is a
// window between a creature stepping into range and the effect being written.
// Read only the sheet during that window and the bonus does not exist yet; read
// the space and it does. The space is the authoritative answer for positional
// modifiers and the sheet is a cache that can lag. Reporting the gap is also how
// three separate aura bugs surfaced on 2026-08-28.
//
// ⚠️ AND A GAP IS REPORTED ONCE, NOT EVERY TURN. An aura that should be applying
// and is not is worth saying. Saying it on every single roll would train the GM
// to ignore it, which is how the boot report became furniture.
const MODULE_ID = "ace-qol";

/** Gaps already announced this session, so each is said once. */
const _toldAbout = new Set();

/**
 * Everything this square imposes or offers, and whether the creature standing
 * in it has already received each thing.
 *
 * @param {Token} token           the creature standing there
 * @param {object} [opts]
 * @param {boolean} [opts.announceGaps]  say once when an aura should be applying
 * @returns {{auras, regions, pending, readable, problems}}
 */
export function readSpaceEffects(token, { announceGaps = true } = {}) {
  const auras = [], regions = [], pending = [], problems = [];

  if (!token) {
    return { auras, regions, pending, readable: false,
             problems: ["no token was given, so nothing about the space could be read"] };
  }

  // ── Auras reaching this square ────────────────────────────────────────────
  try {
    const engine = globalThis.game?.aceQol?.AuraEngine;
    const sources = engine?.getActiveSources?.() ?? [];
    const own = token.actor?.effects ?? [];

    for (const src of sources) {
      if (!src?.token || src.token.id === token.id) continue;   // your own aura is yours

      let dist = null;
      try { dist = engine._tokenDistanceFt?.(src.token, token); }
      catch (err) { problems.push(`the distance to ${src.token.name} could not be measured`); }
      if (!Number.isFinite(dist)) continue;
      if (dist > Number(src.rangeFt ?? 0)) continue;            // out of reach

      // ⚠️ THE ANTI-DOUBLE-COUNT CHECK. If the aura's effect is already on this
      // creature, it belongs to the creature's own profile and this says nothing.
      const alreadyApplied = own.some(e =>
        e.flags?.[MODULE_ID]?.auraSourceTokenId === src.token.id);

      const row = {
        source: src.token.name,
        sourceTokenId: src.token.id,
        aura: src.aura?.sourceFeatureName ?? "an aura",
        rangeFt: Number(src.rangeFt ?? 0),
        distanceFt: dist,
        applied: alreadyApplied,
      };
      auras.push(row);

      if (!alreadyApplied) {
        pending.push(row);
        const key = `${token.id}:${src.token.id}:${row.aura}`;
        if (announceGaps && !_toldAbout.has(key)) {
          _toldAbout.add(key);
          // ⚠️ A gap is a real signal, not noise: it means the aura engine has
          // not caught up, or has stopped working for this pair.
          console.warn(`${MODULE_ID} | ${token.name} is ${Math.round(dist)} feet from `
            + `${src.token.name}, inside their ${row.aura} (${row.rangeFt} feet), but is not `
            + `carrying its effect. The space says it should apply and the sheet does not.`);
        }
      }
    }
  } catch (err) {
    problems.push(`auras could not be read: ${err?.message ?? err}`);
  }

  // ── Regions covering this square ──────────────────────────────────────────
  try {
    const all = globalThis.canvas?.scene?.regions ?? [];
    for (const region of all) {
      let inside = false;
      try {
        inside = region.object?.testPoint?.(token.center, token.document?.elevation ?? 0)
          ?? region.testPoint?.({ ...token.center, elevation: token.document?.elevation ?? 0 })
          ?? false;
      } catch (_) { continue; }
      if (!inside) continue;

      const behaviours = (region.behaviors ?? []).filter(b => !b.disabled);
      regions.push({
        name: region.name ?? "(unnamed region)",
        behaviours: behaviours.map(b => b.type),
        // A region that applies a status hands the creature a real effect, so
        // the same silence rule applies: it is named, never counted here.
        appliesStatus: behaviours.some(b => String(b.type).includes("statusEffect")),
      });
    }
  } catch (err) {
    problems.push(`regions could not be read: ${err?.message ?? err}`);
  }

  return { auras, regions, pending, readable: true, problems };
}

/** Plain sentences for a card or the console. */
export function describeSpaceEffects(space, who = "this creature") {
  if (!space?.readable) return `Nothing about the space around ${who} could be read.`;
  const bits = [];
  if (space.auras.length) {
    bits.push(`${who} is inside ${space.auras.length} aura(s): `
      + space.auras.map(a => `${a.aura} from ${a.source} (${Math.round(a.distanceFt)} of ${a.rangeFt} feet)`
        + (a.applied ? "" : " — NOT yet applied")).join(", ") + ".");
  }
  if (space.regions.length) {
    bits.push(`Standing in: ` + space.regions.map(r => r.name).join(", ") + ".");
  }
  if (!bits.length) bits.push(`Nothing about where ${who} is standing changes anything.`);
  if (space.problems.length) bits.push(`Could not read: ${space.problems.join("; ")}.`);
  return bits.join(" ");
}

/** Forget what has been announced, so a new session speaks up again. */
export function resetSpaceAnnouncements() { _toldAbout.clear(); }
