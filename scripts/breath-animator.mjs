// ─── ACE: QOL — A breath weapon shows the breath ─────────────────────────────
//
// Johnny, 2026-09-20: "FIRE BREATH ANIMATION. Template, saves, and card are
// fine. No fire clip. Play the Automated Animations fire-breath clip for a fire
// breath. If that pack has none, use the JB2A / Chris fire cone already in the
// suite. Forge stays off spells. This is a monster weapon, not a spell."
//
// ⚠️ WHY ACE PLAYS IT AND AUTOMATED ANIMATIONS DOES NOT. A creature's area
// action was left to "whoever places the area", which is AA — and his dragon's
// cone landed in silence. His AA database DOES carry the clip (a `templatefx`
// record labelled "Fire Breath", a breathweapon cone in fire01/orange, with its
// own sound), so the picture was there the whole time and nothing played it.
// Rather than guess at which link in AA's chain is not firing on his machine,
// ACE plays HIS OWN curated record itself and stands AA down for that item, so
// the picture is the one he chose and there is exactly one of it.
//
// ⚠️ NEVER TWO. AA gives every run a "stand down" door (the same one the
// teleports use). It is shut for the item ACE is about to play and for nothing
// else, so everything AA already animates keeps animating.
//
// ⚠️ AND THE AREA OUTLIVES ITS CLIP. ACE deletes an instant template ~1.5s
// after the card lands and ends every Sequencer effect attached to it first, so
// a three-second breath was being cut off at the knees (and its sound, which
// that record delays by three seconds, never played at all). The delete now
// waits for whatever this file started.
// ──────────────────────────────────────────────────────────────────────────────

import { animationFor, whyNoAnimation } from "./animation/autorec.mjs";

const MODULE_ID = "ace-qol";
const LOG = "ace-qol | breath";

/** templateId → a promise that resolves when its clip has finished. */
const PLAYING = new Map();

/** Item uuids ACE is animating itself; AA stands down for these. */
const OURS = new Set();

/**
 * A creature's area action, with its shape: the thing this file animates.
 *
 * ⚠️ NOT BY NAME, AND NOT ONLY A DRAGON. "Fire Breath", "Cold Breath", a
 * beholder's cone, a chimera's, a wyvern's: what they share is a creature (not
 * a spell) placing a cone or a line. That is the test.
 */
export function isCreatureArea(item, activity = null) {
  try {
    if (!item || item.type === "spell") return null;
    const owner = item.actor ?? null;
    if (owner && owner.type === "character") return null;   // a player's own feature is theirs
    const acts = activity ? [activity] : [...(item.system?.activities ?? [])];
    for (const a of acts) {
      const shape = String(a?.target?.template?.type ?? item.system?.target?.template?.type ?? "");
      if (shape === "cone" || shape === "line" || shape === "ray") return { shape };
    }
    return null;
  } catch (_) { return null; }
}

/** The JB2A cones already in the suite, by what the action deals. */
const FALLBACK = {
  fire:      ["jb2a.breath_weapons.fire.cone.orange", "jb2a.breath_weapons02.cone.fire.orange01", "jb2a.burning_hands.01.orange"],
  cold:      ["jb2a.breath_weapons.cold.cone.blue", "jb2a.breath_weapons02.cone.ice.blue01", "jb2a.cone_of_cold.blue"],
  lightning: ["jb2a.breath_weapons.lightning.line.blue", "jb2a.chain_lightning.primary.blue"],
  acid:      ["jb2a.breath_weapons.acid.line.green", "jb2a.breath_weapons02.line.acid.green01"],
  poison:    ["jb2a.breath_weapons.poison.cone.green", "jb2a.breath_weapons02.cone.poison.green01"],
  necrotic:  ["jb2a.breath_weapons.poison.cone.purple"],
  radiant:   ["jb2a.breath_weapons.fire.cone.yellow"],
  thunder:   ["jb2a.breath_weapons.lightning.cone.blue"],
};

/** The first of those his install actually has, or null with a word about it. */
function fallbackFor(types) {
  const db = globalThis.Sequencer?.Database;
  if (!db?.entryExists) return null;
  for (const t of types ?? []) {
    for (const path of FALLBACK[String(t).toLowerCase()] ?? []) {
      try { if (db.entryExists(path)) return { path, why: `the JB2A ${t} cone already in the suite` }; }
      catch (_) { /* keep looking */ }
    }
  }
  return null;
}

export class BreathAnimator {

  static register() {
    Hooks.on("AutomatedAnimations-WorkflowStart", BreathAnimator._standDownAA);
    console.debug(`${LOG} | online: a creature's cone or line plays its own curated clip, once.`);
  }

  static _standDownAA(data) {
    try {
      const uuid = data?.item?.uuid ?? null;
      if (!uuid || !OURS.has(uuid)) return;
      data.stopWorkflow = true;
      console.log(`${LOG} | Automated Animations stands down for "${data.item.name}": ACE is playing `
        + `that same record itself, so there is one clip and one sound, not two.`);
    } catch (err) {
      console.warn(`${LOG} | could not stand Automated Animations down:`, err);
    }
  }

  /** How long, if anything, is still playing over this template. */
  static waitFor(templateId) {
    return PLAYING.get(templateId) ?? null;
  }

  /**
   * Play the look for a creature's cone or line, stretched down the template.
   *
   * @returns {Promise<boolean>} whether anything played
   */
  static async play(templateDoc, item, actor, { damageTypes = [] } = {}) {
    try {
      if (!templateDoc || !item) return false;
      if (!isCreatureArea(item)) return false;
      if (typeof Sequence === "undefined") {
        console.log(`${LOG} | Sequencer is not here, so "${item.name}" plays nothing.`);
        return false;
      }

      // His own curated record first: the picture he picked for this creature.
      let anim = null;
      try { anim = animationFor(item); } catch (_) { anim = null; }
      let path = anim?.path ?? null;
      let why = "his Automated Animations record for it";
      if (!path) {
        const back = fallbackFor(damageTypes);
        path = back?.path ?? null;
        why = back?.why ?? "";
      }
      if (!path) {
        // ⚠️ SAY WHICH OF THE TWO IT IS (the autorec rule): nobody curated it,
        // or the record points at an asset this install does not carry.
        console.log(`${LOG} | "${item.name}" plays nothing: `
          + `${whyNoAnimation?.(item) ?? "no curated record"}, and no JB2A cone matches `
          + `${damageTypes.join("/") || "its damage"}.`);
        return false;
      }

      // Down the template: from its origin, out to the far end of its own
      // direction and distance, so a 60-foot cone is 60 feet of fire pointing
      // where he aimed it.
      const scene = templateDoc.parent ?? canvas?.scene ?? null;
      const perFt = Number(scene?.grid?.size ?? canvas?.grid?.size ?? 100)
        / Number(scene?.grid?.distance ?? canvas?.grid?.distance ?? 5);
      const rad = (Number(templateDoc.direction ?? 0) * Math.PI) / 180;
      const reach = Number(templateDoc.distance ?? 0) * perFt;
      const from = { x: Number(templateDoc.x ?? 0), y: Number(templateDoc.y ?? 0) };
      const to = { x: from.x + Math.cos(rad) * reach, y: from.y + Math.sin(rad) * reach };

      if (item.uuid) OURS.add(item.uuid);
      const seq = new Sequence();
      if (anim?.sound?.file) {
        seq.sound().file(anim.sound.file)
          .volume(Number(anim.sound.volume ?? 0.75))
          .delay(Number(anim.sound.delay ?? 0));
      }
      const fx = seq.effect().file(path).atLocation(from).stretchTo(to);
      try { if (anim?.options?.opacity != null) fx.opacity(Number(anim.options.opacity)); } catch (_) { /* optional */ }

      console.log(`${LOG} | ${actor?.name ?? "a creature"}'s "${item.name}": playing ${path} `
        + `(${why}), ${Math.round(Number(templateDoc.distance ?? 0))} feet at ${Math.round(Number(templateDoc.direction ?? 0))}°.`);

      const done = seq.play()
        .catch(err => console.warn(`${LOG} | "${item.name}" could not be played:`, err))
        .finally(() => {
          PLAYING.delete(templateDoc.id);
          if (item.uuid) setTimeout(() => OURS.delete(item.uuid), 2000);
        });
      PLAYING.set(templateDoc.id, done);
      return true;
    } catch (err) {
      console.warn(`${LOG} | the breath's look failed, and nothing else was affected:`, err);
      return false;
    }
  }
}
