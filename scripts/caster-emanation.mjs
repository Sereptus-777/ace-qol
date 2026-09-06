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

import { AceFX, DAMAGE_THEME, DEFAULT_COLOR, HEAL_COLOR } from "./ace-fx.mjs";

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

/**
 * Shapes whose circle must actually EXIST on the board, not just be drawn once.
 *
 * ⚠️🔴 SPIRIT GUARDIANS NEEDS ITS TEMPLATE AND AURA OF VITALITY DOES NOT.
 * The concentration tracker MOVES a template with its caster and hit-tests
 * creatures against it every turn — that circle is the spell. Take it away and
 * the spirits stop catching anybody (2026-08-27).
 *
 * An emanation heal measures its own distance from the caster and never reads a
 * template, so creating one just puts a circle on the map that something else
 * then tidies away. Johnny, 2026-09-05: "It draws a template 30 ft and then
 * disappears right away... can't we get rid of the template?" For those, the
 * wave IS the feedback.
 */
const NEEDS_A_REAL_TEMPLATE = new Set([
  "template-trigger",   // Spirit Guardians, Moonbeam-style areas that keep catching
  "template-save",
  "template-pool",
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
 * Should dnd5e's template placement be suppressed for this?
 *
 * ⚠️🔴 SUPPRESSING AND DRAWING ARE TWO DIFFERENT QUESTIONS AND I MERGED
 * THEM. Before 0.16.0 the rule was simply "a self-shaped spell with a template
 * does not prompt". I narrowed that to circles only, to protect Burning Hands'
 * cone — and in doing so stopped suppressing Misty Step's, so a teleport left a
 * circle sitting on the map that nothing ever cleans up. Johnny, mid-session:
 * "Misty stepped worked, but the template did not go away. First time I've ever
 * seen that."
 *
 * ⚠️ THE GEOMETRY GUARD BELONGS TO DRAWING, NOT TO SUPPRESSING. A cone
 * needs aiming, so ACE must not place it — but a cone never belongs to a
 * caster-centred SHAPE in the first place: Burning Hands is a template spell,
 * not a "self" one. So suppression can safely key on the shape, which is what
 * it did for months, and only the drawing needs to care which way the thing
 * points.
 */
export function suppressesTemplate(entry, activity) {
  const tpl = activity?.target?.template ?? activity?.item?.system?.target?.template ?? {};
  if (!String(tpl?.type ?? "")) return false;          // nothing to suppress
  if (entry?.fx) return false;                          // it draws its own — leave it whole
  return CASTER_CENTRED_SHAPES.has(entry?.shape);
}

/**
 * Does this action radiate from the caster, with no aiming to do?
 *
 * @param {object} entry     the pipeline's entry for the item, if any
 * @param {object} activity  the activity being used
 * @returns {{yes:boolean, radiusFt:number|null, why:string}}
 */
export function emanatesFromCaster(entry, activity) {
  // ⚠️🔴 A SPELL WITH ITS OWN VISUALS IS NOT MINE TO DRAW. Ghostly Howl
  // is a registry spell: shape "save-area", carrying its own expanding wave AND
  // the sound Johnny configured for it. Its own resolver draws that correctly
  // and has for months.
  //
  // This feature then looked at the same item, saw "range self with a radius",
  // suppressed its template and drew a SECOND wave — neutral blue, silent —
  // over the top. Johnny, the next morning: "my ghostly howl on King was
  // working fucking yesterday. I didn't tell you to touch it... it's got a
  // completely different growl."
  //
  // ⚠️ ONE OWNER PER CAST. This exists for emanations nothing else handles.
  // If the pipeline has an entry with its own effects, it owns the picture, the
  // sound and the template, and this stands entirely aside.
  if (entry?.fx) {
    return { yes: false, radiusFt: null,
             why: `the spell pipeline draws this one itself (${entry.fx.kind ?? "its own effect"})` };
  }

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


/** Every damage type this action states, however dnd5e stores them. */
function _damageTypesOf(activity) {
  const out = [];
  try {
    for (const part of (activity?.damage?.parts ?? [])) {
      const t = part?.types;
      if (t instanceof Set) out.push(...t);
      else if (Array.isArray(t)) out.push(...t);
      else if (t) out.push(t);
    }
  } catch (_) { /* no damage stated is a normal answer */ }
  return [...new Set(out.map(String))];
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

  // ⚠️ ONLY WHEN SOMETHING WILL READ IT. See NEEDS_A_REAL_TEMPLATE.
  const wantsTemplate = NEEDS_A_REAL_TEMPLATE.has(entry?.shape);
  if (!wantsTemplate) {
    const radiusOnly = Number(entry?.emanation?.radiusFt
      ?? activity?.target?.template?.size
      ?? item?.system?.target?.template?.size) || 0;
    playEmanationBurst({
      token, radiusFt: radiusOnly, item,
      heals: !!(entry?.heal || activity?.healing || String(activity?.type) === "heal"),
      damageTypes: _damageTypesOf(activity),
    }).catch(err => console.warn(`${LOG} | wave failed for ${item.name}:`, err));
    console.log(`${LOG} | ${item.name}: no template drawn — nothing reads one for a `
      + `"${entry?.shape ?? "shapeless"}" spell, so the wave is the whole picture.`);
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

  // ⚠️ AND SHOW HIM IT HAPPENED. Read straight off the activity rather than
  // from a profile, so this works for an NPC's ability and for homebrew the
  // registry has never heard of — which is the whole point of the burst.
  const radiusFt = Number(entry?.emanation?.radiusFt ?? data[0]?.distance) || 0;
  playEmanationBurst({
    token, radiusFt, item,
    heals: !!(entry?.heal || activity?.healing || String(activity?.type) === "heal"),
    damageTypes: _damageTypesOf(activity),
  }).catch(err => console.warn(`${LOG} | burst failed for ${item.name}:`, err));

  return created;
}

/* ── The burst ─────────────────────────────────────────────────────────────
 *
 * Johnny, 2026-09-05: "It got a little poof. That was it. It didn't even
 * emanate out... It didn't even reach 30 feet. I said I wanted some sort of
 * visual, not just a little plop. Go look at what ghostly howl does for an
 * animation. I want something like that."
 *
 * ⚠️🔴 AND ACE ALREADY HAD IT. `AceFX.ghostlyWave` was written for exactly
 * this in July, for his Spectral Wolf King, and he tuned it twice — 2026-07-10
 * "push it, visual waves go out 30 feet", and 2026-07-29 "I wish it was more
 * like a waveform, a purple waveform emanating out from him, it could last for
 * one second longer". It takes a radius in FEET, converts it against the
 * scene's own grid, undulates so it reads as a wavefront rather than a pond
 * ripple, and broadcasts to every client.
 *
 * I did not grep for it and drew a 400-pixel JB2A explosion instead. That is
 * the "grep for the CAPABILITY, not the feature name" rule, broken again, and
 * this comment is here because the code did not say it the first time.
 *
 * The damage-type colour table was sitting in the same file.
 */

/**
 * What colour is this action's wave, and why.
 *
 * ⚠️ HEALING FIRST AND IT BEATS EVERYTHING. A spell that restores hit points
 * is green whatever else it carries, and Aura of Vitality is why this exists.
 */
export function burstFor({ heals = false, damageTypes = [] } = {}) {
  if (heals) return { color: HEAL_COLOR, why: "it heals" };
  for (const t of damageTypes) {
    const key = String(t).toLowerCase();
    if (DAMAGE_THEME[key] !== undefined) {
      return { color: DAMAGE_THEME[key], why: `it deals ${key} damage` };
    }
  }
  if (damageTypes.length) {
    return { color: DEFAULT_COLOR, why: `it deals ${damageTypes[0]} damage, which has no colour of its own` };
  }
  // ⚠️ A BUFF IS NOT AN EXPLOSION. Detect Magic washing out blood-red would
  // tell the table something violent had happened.
  return { color: DEFAULT_COLOR, why: "it neither heals nor damages, so it gets the neutral arcane wave" };
}

/** Casts already drawn, so one press cannot stack waves. */
const _burstsInFlight = new Set();

/**
 * Send the wave out to the full radius.
 *
 * ⚠️🔴 COALESCED, BECAUSE THE PLAYER RETURNS BEFORE THE EFFECT REGISTERS.
 * That is the 2026-09-02 lesson that put seventeen copies of one aura ring on
 * one token: presence-testing what is on screen does not work, because nothing
 * is on screen yet. In-flight work is tracked here, by cast.
 */
export async function playEmanationBurst({ token, radiusFt, item, heals, damageTypes }) {
  if (!token) return;

  const key = `${token.id}|${item?.id ?? item?.name ?? "?"}`;
  if (_burstsInFlight.has(key)) {
    console.debug(`${LOG} | a wave for ${item?.name} on ${token.name} is already playing.`);
    return;
  }
  _burstsInFlight.add(key);
  setTimeout(() => _burstsInFlight.delete(key), 1000);

  // ⚠️ NEVER SHRINK TO A DEFAULT. The first version floored this at 5 feet,
  // so a radius that failed to read produced a one-square poof that looked
  // exactly like a working animation doing nothing. An unknown radius draws
  // NOTHING and says so.
  const ft = Number(radiusFt);
  if (!Number.isFinite(ft) || ft <= 0) {
    console.warn(`${LOG} | ${item?.name} has no readable radius (${radiusFt}), so no wave was `
      + `drawn. The spell is unaffected.`);
    return;
  }

  const pick = burstFor({ heals, damageTypes });
  try {
    AceFX.ghostlyWaveBroadcast(token, ft, pick.color);
    console.log(`${LOG} | ${item?.name}: a ${ft} foot wave off ${token.name} `
      + `(${pick.why}).`);
  } catch (err) {
    console.warn(`${LOG} | could not draw the wave for ${item?.name}:`, err);
  }
}
