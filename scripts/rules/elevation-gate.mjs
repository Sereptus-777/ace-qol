// ─── Who was out of reach, and why ───────────────────────────────────────────
//
// ⚠️🔴 A CREATURE SILENTLY DROPPED FROM A FIREBALL LOOKS EXACTLY LIKE A BUG.
// Elevation was taught to the area hit-test on 2026-08-28, and a gate that can
// only ever REMOVE creatures has to say so out loud. From the GM's chair, a
// flyer that gets no save card is indistinguishable from ACE forgetting it, and
// that is the report that comes back three sessions later as "it missed people".
//
// Johnny asked the question this file answers: "what if a character who's flying
// at 30 ft. and casts Fireball at a bunch of other flying creatures that are at
// different elevations?" The engine tests each creature on its own, so some are
// in and some are not. This is the part that TELLS HIM which, with the two
// numbers that decided it, so he never has to work anything out himself.
//
// ⚠️ CAST TIME ONLY. The same exclusion happens on every walk-in and every
// start of turn, and a card for each of those would bury the chat log. The one
// moment that needs explaining is the moment he expected a save card and did
// not get one.
import { isTokenInTemplate, verticalBand, anyOverlapCounts } from "../template-geometry.mjs";

export class ElevationGate {
  /**
   * Which creatures the area covers on the floor but cannot reach in the air.
   *
   * @param {object} templateDoc  the placed template document
   * @param {Array}  kept         the tokens that survived the real hit-test
   * @param {Function} getEdition CombatState.getActiveEdition, passed in
   * @param {object} caster       the casting actor, never reported
   * @returns {Array<{token:object, feet:number, band:object}>}
   */
  static findOutOfReach(templateDoc, kept, getEdition, caster = null) {
    try {
      const obj = templateDoc?.object;
      if (!obj?.shape) return [];
      const band = verticalBand(obj);
      if (!band) return [];                 // height unknown, nobody was excluded

      const overlap = anyOverlapCounts(getEdition);
      const keptIds = new Set((kept ?? []).map(t => t?.id));
      const out = [];
      for (const token of (canvas?.tokens?.placeables ?? [])) {
        if (keptIds.has(token.id)) continue;
        if (caster && token.actor?.id === caster.id) continue;   // its own exclusion explains itself
        // Would it have been caught if height did not exist?
        const flat = isTokenInTemplate(token, obj, null,
          { anyOverlapCounts: overlap, ignoreElevation: true });
        if (!flat) continue;               // it was simply not in the area at all
        out.push({ token, feet: Number(token.document?.elevation ?? 0) || 0, band });
      }
      return out;
    } catch (err) {
      console.warn("ace-qol | could not work out who was out of reach:", err);
      return [];
    }
  }

  /** Say it on screen, with the numbers that decided it. */
  static async postOutOfReachCard(item, caster, blocked) {
    if (!blocked?.length) return;
    const blue = "#7fb3d5";
    const esc = (t) => foundry.utils.escapeHTML(String(t ?? ""));
    const band = blocked[0].band;
    const reach = `${Math.round(band.bottom)} to ${Math.round(band.top)} feet`;

    const rows = blocked.map(b => {
      const above = b.feet >= band.top;
      return `
      <div style="display:flex;align-items:center;gap:10px;padding:6px 8px;background:rgba(127,179,213,0.08);border-radius:4px;margin-bottom:4px;">
        <i class="fas fa-arrow-${above ? "up" : "down"}" style="color:${blue};font-size:14px;"></i>
        <div style="flex:1;">
          <strong style="color:#e8d49a;">${esc(b.token.name)}</strong>
          <span style="color:#c0b288;font-size:13px;"> is at ${Math.round(b.feet)} feet, ${above ? "above" : "below"} it</span>
        </div>
      </div>`;
    }).join("");

    const html = `
      <div style="background:linear-gradient(180deg,#101822 0%,#080c11 100%);
                  border:2px solid ${blue};border-radius:6px;padding:12px 14px;
                  color:#f0e4c0;font-family:'Signika','Helvetica Neue',sans-serif;
                  box-shadow:0 0 10px ${blue}33;">
        <div style="display:flex;align-items:center;gap:10px;font-size:15px;font-weight:700;
                    color:${blue};text-transform:uppercase;letter-spacing:0.6px;
                    border-bottom:1px solid #2a3a4a;padding-bottom:6px;margin-bottom:8px;">
          <i class="fas fa-up-down" style="font-size:16px;"></i>
          <span>${esc(item?.name)} &mdash; out of reach</span>
        </div>
        <div style="font-size:13px;color:#c0b288;margin-bottom:8px;font-style:italic;">
          The area reaches from ${reach}. These were over the spot on the floor and
          outside it in the air, so they take nothing.
        </div>
        ${rows}
      </div>`;

    try {
      await ChatMessage.create({
        speaker: ChatMessage.getSpeaker({ actor: caster }),
        content: html,
        whisper: game.users.filter(u => u.isGM).map(u => u.id),
        flags: { "ace-qol": { type: "elevationOutOfReach" } },
      });
    } catch (err) {
      console.warn("ace-qol | out-of-reach card failed to post:", err);
    }
  }
}
