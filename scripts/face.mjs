// ─── THE FACE ON AN ACE CARD ─────────────────────────────────────────────────
//
// His rule, 2026-10-05:
//
//   "The face on this popup is the actor portrait, actor.img, not the token
//    texture. The same rule on every ACE card and popup that shows a face:
//    saves, damage, attacks, Lucky. Animated top-down tokens paint blank in
//    those squares. If the actor has no portrait, leave the square empty. Do
//    not fall back to the token."
//
// ⚠️🔴 THE SQUARES WERE FED BY TWENTY-ODD DIFFERENT EXPRESSIONS, and they did
// not agree: the attack and damage cards read the token texture first, the save
// rows read the token texture first, the heal and missile pickers read the token
// texture first, and a handful read the portrait first. So the same creature
// showed its face on one card and a blank square on the next, depending on which
// builder drew it. A webm token has no still frame to paint into an <img>, which
// is why his animated creatures came out empty.
//
// ⚠️ AND THE FALLBACK WAS THE BUG, NOT THE SAFETY NET. Every one of those
// expressions ended in a token texture or a mystery-man icon, so a creature with
// no portrait got a picture of something else. An empty square is the truth.
//
// ⚠️ THIS IS NOT ABOUT THE BOARD. A corpse picture, a prone swap, the token art
// picker, the condition overlays and a polymorph's snapshot are all about the
// TOKEN's own image, which is a different question with a different answer, and
// none of them go through here.
//
// A LEAF: imports nothing, like dice-face.mjs, so any card can read it without
// risking an import cycle.
// ──────────────────────────────────────────────────────────────────────────────

/**
 * The portrait to draw for a creature, or "" when it has none.
 *
 * @param {Actor|Token|TokenDocument|{actor?:any,img?:string}|null} thing
 *        a creature, or anything that carries one
 * @returns {string} `actor.img`, or "" — never a token texture, never a
 *          stand-in icon
 */
export function faceOf(thing) {
  try {
    // An Actor answers for itself; a token (placeable or document) hands over
    // the creature standing on it.
    const actor = thing?.actor ?? thing?.document?.actor ?? thing ?? null;
    const img = String(actor?.img ?? "").trim();
    return img;
  } catch (_) {
    return "";
  }
}

/**
 * The square itself, drawn only when there is a face to put in it.
 *
 * @param {Actor|Token|TokenDocument|string|null} thing  a creature, or a path
 * @param {string} cls   the classes the card gives its portrait
 * @param {object} [o]
 * @param {string} [o.alt]
 * @returns {string} an `<img>`, or "" so the square is simply not there
 */
export function faceImg(thing, cls, { alt = "" } = {}) {
  const src = typeof thing === "string" ? thing.trim() : faceOf(thing);
  if (!src) return "";
  const esc = (s) => String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  return `<img src="${esc(src)}" class="${esc(cls)}" alt="${esc(alt)}" />`;
}
