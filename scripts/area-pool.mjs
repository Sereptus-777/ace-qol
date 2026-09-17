// ─── A spell that has an area should DRAW its area ──────────────────────────
//
// ⚠️🔴 THIS IS ACE'S FAULT, AND JOHNNY SAID SO IN ONE LINE. 2026-08-28:
// "It pops a target picker instead. The animation was set to play when the cone
// appears. Well, that's your fucking fault."
//
// He is right. Colour Spray IS a 15 foot cone. Its sheet says so, every other
// module draws it, and ACE decided to show a target picker instead. Everything
// downstream then had nothing real to work from:
//
//   * the curated animation was waiting for a cone that never appeared
//   * elevation, cover and terrain had no area to test anybody against
//   * the GM had to judge who was "in" a cone that was never on the map
//
// And I made it worse first. Told that Colour Spray did not animate, I built a
// second animation system to play the effect for picker-shaped spells - working
// around ACE's own mistake instead of fixing it. The animation work is not
// wasted (Bless and its kind genuinely have no area), but it was the wrong first
// move and this is the right one.
//
// ⚠️ THE REASON THE PICKER EXISTED IS REAL, THOUGH, AND MUST NOT BE LOST.
// Colour Spray has NO saving throw in either edition. It is a 6d10 hit-point
// pool: the lowest-current-hit-point creatures in the area are blinded until the
// pool runs out. His own sheet carries a phantom Constitution save at DC 22 that
// somebody's importer invented, and routing the spell through the normal
// template-save path would roll that phantom save at every creature in the cone.
//
// So: the template is placed like any other area spell, ACE reads who is inside
// it with the SAME geometry every other area uses, and the pool decides. No
// picker, no invented save, and the cone is on the map where it belongs.
const MODULE_ID = "ace-qol";

import { isTokenInTemplate } from "./template-geometry.mjs";

/** Templates already handled, so a re-render never applies a pool twice. */
const _done = new Set();

/**
 * Is this template from a spell whose area is resolved by a hit-point pool?
 * @returns {{item, actor, entry}|null}
 */
function _poolSpellFor(templateDoc) {
  try {
    const origin = templateDoc?.flags?.dnd5e?.origin;
    if (!origin) return null;
    const doc = fromUuidSync?.(origin);
    const item = doc?.item ?? doc;
    if (!item) return null;

    const entry = game.aceQol?.SpellPipeline?._getEntry?.(item);
    if (entry?.shape !== "template-pool" || !entry?.hpPool) return null;

    return { item, actor: item.actor ?? doc?.actor ?? null, entry };
  } catch (err) {
    // ⚠️ "COULD NOT READ THE ORIGIN" IS NOT "NOT A POOL SPELL". Said out loud,
    // because the silent version leaves a cone on the map that blinds nobody.
    console.warn(`${MODULE_ID} | could not tell what placed template `
      + `${templateDoc?.id}, so no area pool was applied:`, err);
    return null;
  }
}

/** Everyone standing in the area, by the one geometry the whole suite uses. */
function _tokensInside(templateDoc) {
  try {
    const obj = templateDoc?.object;
    if (!obj?.shape) {
      // ⚠️ NO SHAPE YET IS NOT AN EMPTY CONE. Saying "nobody was caught" here
      // would be a believable lie about his board.
      console.warn(`${MODULE_ID} | template ${templateDoc?.id} has no shape yet, `
        + `so who is inside it cannot be read. No pool applied.`);
      return null;
    }

    return (canvas?.tokens?.placeables ?? [])
      .filter(t => t.actor && isTokenInTemplate(t, obj));
  } catch (err) {
    console.warn(`${MODULE_ID} | could not read who is inside template `
      + `${templateDoc?.id}:`, err);
    return null;
  }
}

async function _onTemplateCreated(templateDoc) {
  try {
    if (game.users?.activeGM !== game.user) return;   // one client resolves
    if (_done.has(templateDoc.id)) return;

    const hit = _poolSpellFor(templateDoc);
    if (!hit) return;
    _done.add(templateDoc.id);

    const inside = _tokensInside(templateDoc);
    if (inside === null) return;                       // already explained itself
    if (!inside.length) {
      console.log(`${MODULE_ID} | ${hit.item.name}: the area caught nobody.`);
      return;
    }

    const { BuffResolver } = await import("./spell-pipeline/resolvers/buff.mjs");
    const castLevel = Number(templateDoc.flags?.dnd5e?.spellLevel)
      || Number(hit.item.system?.level) || 1;

    const ctx = { entry: hit.entry, item: hit.item, actor: hit.actor, castLevel };
    // `_applyHpPool` reads `result.targets`, so the area's occupants go in
    // exactly where the picker's chosen creatures used to.
    const pooled = await BuffResolver._applyHpPool(ctx, { targets: inside });

    console.log(`${MODULE_ID} | ${hit.item.name}: the area caught `
      + `${inside.map(t => t.name).join(", ")}; the pool covered `
      + (pooled?.length ? pooled.map(t => t.name ?? t.actor?.name).join(", ") : "nobody"));
  } catch (err) {
    console.error(`${MODULE_ID} | the area pool failed for template `
      + `${templateDoc?.id}:`, err);
  }
}

/**
 * ⚠️ `Hooks.once("ready")` FROM INSIDE `ready` NEVER FIRES. Every ACE subsystem
 * starts from the entry file's own ready handler, so waiting on `ready` here
 * would wait on an event already in progress and this would silently never
 * register.
 */
/**
 * Nothing is spent until the cast is known to have happened.
 *
 * ⚠️ SAME DOOR, SAME QUESTION (2026-09-17). A counterspell is answered on
 * somebody's screen seconds after the area lands, so a door that reads the
 * template and acts immediately acts on a spell that never happened. The save
 * engine had exactly this bug with Fireball; this is the same door on a
 * different engine.
 */
async function _afterTheVerdict(doc) {
  try {
    const origin = doc?.flags?.dnd5e?.origin ?? null;
    if (origin) {
      const { ReactionEngine } = await import("./reaction-engine.mjs");
      const decision = await ReactionEngine.awaitCastDecision(origin);
      if (decision?.abort) {
        console.log(`${MODULE_ID} | that area was ${decision.reason}, so its pool is not spent.`);
        return;
      }
    }
  } catch (err) {
    console.warn(`${MODULE_ID} | could not ask whether that area's cast was counterspelled, `
      + `so it is treated as going ahead:`, err);
  }
  return _onTemplateCreated(doc);
}

export function registerAreaPool() {
  const run = () => {
    Hooks.on("createMeasuredTemplate", (doc) => {
      // A tick of delay so the placeable exists and carries its shape; the
      // geometry read above refuses to guess without one.
      setTimeout(() => _afterTheVerdict(doc).catch(err =>
        console.error(`${MODULE_ID} | area pool threw:`, err)), 50);
    });
    Hooks.on("deleteMeasuredTemplate", (doc) => _done.delete(doc.id));
    console.log(`${MODULE_ID} | area pools registered (spells whose area is `
      + `resolved by a hit-point pool rather than a save)`);
  };
  if (game.ready) run();
  else Hooks.once("ready", run);
}
