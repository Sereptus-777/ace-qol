// ─── ACE: QOL — A spell that radiates from you is not placed by you ─────────
//
// Johnny, 2026-09-05: "The template is a bit of a problem. It still makes me
// place it. It shouldn't do that. It should just show the template emanating
// out from me. And any self-emanating thing should do the same thing."
//
// ⚠️🔴 AND THE PROMPT CAME BACK BECAUSE OF A FIX I MADE THE SAME NIGHT. The old
// suppressor read `entry.shape !== "self"` and bailed. Aura of Vitality used to
// classify as "self", so it was suppressed. Once the registry started matching
// his "(Legacy)" names again its shape became "emanation-heal" — correct, and
// far more useful — and this suppressor, which knew exactly one word, stopped
// recognising it. A two-way branch broke on the third kind, again.
//
// So the test is a TABLE and a derivation, never a word:
//   • the entry states an emanation, or
//   • its shape is one of the caster-centred ones, or
//   • the item itself says range self AND carries a template.
//
// ⚠️🔴 BUT "RANGE SELF WITH A TEMPLATE" IS NOT ENOUGH ON ITS OWN. Burning Hands
// is range self with a 15 foot CONE, and a cone has to be aimed. Taking that
// prompt away would fire every cone in the game straight down the x-axis and
// look like the spell had chosen its own targets.
//
// The dividing line is whether the shape has a direction. A circle centred on
// you is the same circle whichever way you face; a cone, a line and a ray are
// not. So only shapes dnd5e resolves to a CIRCLE are placed automatically, and
// everything else keeps its prompt.
// ──────────────────────────────────────────────────────────────────────────────

const MODULE_ID = "ace-qol";
const LOG = `${MODULE_ID} | emanation`;

/**
 * Shapes that are, by definition, centred on the caster.
 *
 * ⚠️ A TABLE, NOT A TERNARY. This list is the thing that broke: it used to be
 * the single string "self". When a new caster-centred shape is added to the
 * pipeline, it goes here, and the failure mode of forgetting is a template
 * prompt rather than a silently wrong spell.
 */
export const CASTER_CENTRED_SHAPES = new Set([
  "self",
  "emanation-heal",
  "aura",
]);

/** Does this template shape have a direction that has to be chosen? */
function _isOmnidirectional(templateType) {
  try {
    const shape = CONFIG?.DND5E?.areaTargetTypes?.[templateType]?.template
      ?? globalThis.dnd5e?.config?.areaTargetTypes?.[templateType]?.template;
    // ⚠️ UNKNOWN MEANS "ASK HIM". A shape dnd5e does not recognise is exactly
    // the King's Ghostly Howl case from 2026-07-28, and guessing that it is a
    // circle would drop an un-aimable area on the caster's head.
    return shape === "circle";
  } catch (_) { return false; }
}

/**
 * Does this action radiate from the caster, with no aiming to do?
 *
 * @param {object} entry     the pipeline's entry for the item, if any
 * @param {object} activity  the activity being used
 * @returns {{yes:boolean, radiusFt:number|null, why:string}}
 */
export function emanatesFromCaster(entry, activity) {
  const tpl = activity?.target?.template ?? activity?.item?.system?.target?.template ?? {};
  const type = String(tpl?.type ?? "");
  if (!type) return { yes: false, radiusFt: null, why: "it places no template at all" };

  if (!_isOmnidirectional(type)) {
    return { yes: false, radiusFt: null,
             why: `its ${type} has to be aimed, so it keeps its placement prompt` };
  }

  const size = Number(tpl?.size);
  const radiusFt = Number(entry?.emanation?.radiusFt ?? (Number.isFinite(size) ? size : null));

  if (entry?.emanation) {
    return { yes: true, radiusFt, why: "its entry says it emanates from the caster" };
  }
  if (CASTER_CENTRED_SHAPES.has(entry?.shape)) {
    return { yes: true, radiusFt, why: `it is a "${entry.shape}" spell, which is centred on the caster` };
  }

  // No entry, or an entry that says nothing about this. Read the item.
  const units = String(activity?.range?.units
    ?? activity?.item?.system?.range?.units ?? "").toLowerCase();
  if (units === "self") {
    return { yes: true, radiusFt, why: "the item says its range is self and it carries a radius" };
  }
  return { yes: false, radiusFt: null, why: "it is aimed somewhere other than the caster" };
}

/**
 * The caster's own token on this scene, or null with a reason.
 *
 * ⚠️ SEVERAL COPIES MEANS DRAW NONE. Picking the wrong one drops the aura on a
 * duplicate across the map, and a spell centred on the wrong creature is worse
 * than a spell he has to place by hand. Same rule the concentration tracker
 * already uses when deciding which token an emanation follows.
 */
function _casterToken(actor) {
  const own = (canvas?.tokens?.placeables ?? []).filter(t => t.actor && actor && t.actor.id === actor.id);
  if (own.length === 1) return { token: own[0], problem: null };
  if (own.length > 1) {
    return { token: null, problem: `${own.length} tokens on this scene share "${actor?.name}", `
      + `so ACE cannot tell which one is casting` };
  }
  return { token: null, problem: `no token for "${actor?.name}" is on this scene` };
}

/**
 * Draw the emanation centred on the caster. Returns the created documents.
 *
 * ⚠️ BUILT BY dnd5e, NOT BY US. `AbilityTemplate.fromActivity` is what the
 * system uses for its own placement, so the document comes out with the flags
 * everything downstream reads — the origin activity, the item, the dimensions,
 * the cast level. Hand-rolling the data would produce a circle that looks right
 * and that the concentration tracker, the geometry reader and the save engine
 * would all fail to recognise.
 */
export async function drawCasterEmanation(activity, entry) {
  const actor = activity?.actor;
  const item = activity?.item;
  if (!actor || !item) return null;

  const { token, problem } = _casterToken(actor);
  if (!token) {
    // ⚠️ SAY IT. A missing aura with no message is the exact failure this whole
    // night was spent on: he presses the button and something quietly does not
    // appear.
    console.warn(`${LOG} | ${item.name} radiates from the caster, but ${problem}. `
      + `No area was drawn.`);
    ui.notifications?.warn(`${item.name}: ACE could not draw its area because ${problem}.`);
    return null;
  }

  const Cls = globalThis.dnd5e?.canvas?.AbilityTemplate;
  if (typeof Cls?.fromActivity !== "function") {
    console.error(`${LOG} | dnd5e.canvas.AbilityTemplate.fromActivity is missing on this build — `
      + `${item.name} keeps dnd5e's placement prompt.`);
    return null;
  }

  const objects = Cls.fromActivity(activity, { x: token.center.x, y: token.center.y });
  if (!objects?.length) {
    console.warn(`${LOG} | dnd5e produced no template for ${item.name}; its prompt stands.`);
    return null;
  }

  const data = objects.map(o => o.document.toObject());
  const created = await canvas.scene.createEmbeddedDocuments("MeasuredTemplate", data);
  console.log(`${LOG} | ${item.name}: drew a ${data[0]?.distance ?? "?"} foot area centred on `
    + `${token.name ?? actor.name} — nothing to place.`);
  return created;
}
