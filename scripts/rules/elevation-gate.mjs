// ─── Who was left out of an area, and why ────────────────────────────────────
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
// ⚠️🔴 AND IT USED TO BLAME HEIGHT FOR THINGS HEIGHT NEVER DID. Johnny,
// 2026-09-10: *"What the hell is this saying? The first time I cast it, the
// specter was clearly inside the box."* Hypnotic Pattern posted "out of reach"
// with the Specter at 0 feet inside a band of 0 to 42 feet, and labelled him
// "below it". The report asked only one question, "would the floor alone have
// caught him?", and treated every yes as a height problem. It never checked that
// height excluded him at all, and anything not above the band was called below.
//
// But the list it compares against is not always the area. When the GM has
// creatures targeted, the save engine uses THOSE instead of the area, and
// targets stick from one action to the next. So a leftover target from an
// earlier action stood in for the whole cube, and the report, knowing nothing
// about that, invented a cause. A catch must never invent a cause.
//
// Now every creature it names carries the reason that is actually true:
//   above / below   height really did exclude it, with the numbers
//   not-targeted    the list came from targets, and it was not one of them
//   missed          it was on the floor AND at the height, and still left out,
//                   which is a disagreement inside ACE and is said to be one
//
// ⚠️ CAST TIME ONLY. The same exclusion happens on every walk-in and every
// start of turn, and a card for each of those would bury the chat log. The one
// moment that needs explaining is the moment he expected a save card and did
// not get one.
import { isTokenInTemplate, verticalBand, anyOverlapCounts, tokenBand } from "../template-geometry.mjs";

export class ElevationGate {
  /**
   * Which creatures the area covers on the floor but did not catch, and why.
   *
   * @param {object} templateDoc  the placed template document
   * @param {Array}  kept         the tokens the save engine is actually using
   * @param {Function} getEdition CombatState.getActiveEdition, passed in
   * @param {object} caster       the casting actor, never reported
   * @param {object} [opts]
   * @param {"area"|"targets"} [opts.source]  where `kept` came from
   * @returns {Array<{token:object, feet:number, band:object|null,
   *                  why:"above"|"below"|"not-targeted"|"missed"}>}
   */
  static findOutOfReach(templateDoc, kept, getEdition, caster = null, { source = "area" } = {}) {
    try {
      const obj = templateDoc?.object;
      if (!obj?.shape) return [];
      // May be null: height unknown for this shape, so height excludes nobody.
      const band = verticalBand(obj);

      const overlap = anyOverlapCounts(getEdition);
      const keptIds = new Set((kept ?? []).map(t => t?.id));
      const out = [];
      for (const token of (canvas?.tokens?.placeables ?? [])) {
        if (keptIds.has(token.id)) continue;
        if (caster && token.actor?.id === caster.id) continue;   // its own exclusion explains itself
        // Would the floor alone have caught it?
        const flat = isTokenInTemplate(token, obj, null,
          { anyOverlapCounts: overlap, ignoreElevation: true });
        if (!flat) continue;               // it was simply not in the area at all

        const feet = Number(token.document?.elevation ?? 0) || 0;

        // ⚠️🔴 HEIGHT HAS TO BE THE REASON BEFORE HEIGHT GETS THE BLAME. The
        // same test the hit-test uses, from the same reader, so this cannot
        // disagree with it: outside means its whole body is past a face.
        let why = null;
        if (band) {
          const t = tokenBand(token.document);
          if (t.bottom >= band.top) why = "above";
          else if (t.top <= band.bottom) why = "below";
        }
        if (!why) why = source === "targets" ? "not-targeted" : "missed";

        if (why === "missed") {
          // ⚠️ SAID AS WHAT IT IS. Both checks read the same area and the same
          // creature; if they disagree, something between them changed, and
          // that is ACE's fault, not a ruling.
          console.error(`ace-qol | ${token.name} is inside this area on the floor AND at `
            + `its height, and the save list still left them out. That is a disagreement `
            + `inside ACE, not a rules outcome.`,
            { feet, band, keptNames: (kept ?? []).map(t => t?.name) });
        }
        out.push({ token, feet, band, why });
      }
      return out;
    } catch (err) {
      console.warn("ace-qol | could not work out who was left out of the area:", err);
      return [];
    }
  }

  /** Say it on screen, with the reason that is actually true for each one. */
  static async postOutOfReachCard(item, caster, blocked) {
    if (!blocked?.length) return;
    const blue = "#7fb3d5";
    const esc = (t) => foundry.utils.escapeHTML(String(t ?? ""));

    const height  = blocked.filter(b => b.why === "above" || b.why === "below");
    const targets = blocked.filter(b => b.why === "not-targeted");
    const missed  = blocked.filter(b => b.why === "missed");

    const row = (b, icon, tail) => `
      <div style="display:flex;flex-wrap:wrap;align-items:center;gap:6px 10px;padding:6px 8px;
                  background:rgba(127,179,213,0.08);border-radius:4px;margin-bottom:4px;">
        <i class="fas ${icon}" style="color:${blue};font-size:14px;"></i>
        <div style="flex:1;min-width:0;">
          <strong style="color:#e8d49a;">${esc(b.token.name)}</strong>
          <span style="color:#c0b288;font-size:13px;"> ${tail}</span>
        </div>
      </div>`;

    const note = (text) => `
      <div style="font-size:13px;color:#c0b288;margin:6px 0;font-style:italic;">${text}</div>`;

    let body = "";
    if (height.length) {
      const band = height[0].band;
      body += note(`The area reaches from ${Math.round(band.bottom)} to ${Math.round(band.top)} `
        + `feet. These were over it on the floor and outside it in the air, so they take nothing.`);
      body += height.map(b => row(b, b.why === "above" ? "fa-arrow-up" : "fa-arrow-down",
        `is at ${Math.round(b.feet)} feet, ${b.why} it`)).join("");
    }
    if (targets.length) {
      body += note("These were standing in the area, but you had creatures targeted, so ACE "
        + "used your targets instead of the area. Clear your targets before an area spell "
        + "and it catches everyone in it.");
      body += targets.map(b => row(b, "fa-crosshairs", "was in the area but not targeted")).join("");
    }
    if (missed.length) {
      body += note("These were in the area and at its height, and ACE still left them out. "
        + "That is a bug in ACE, not a rule. The console has the numbers.");
      body += missed.map(b => row(b, "fa-triangle-exclamation",
        `at ${Math.round(b.feet)} feet, inside the area, left out`)).join("");
    }

    const title = height.length === blocked.length ? "out of reach" : "not included";
    const html = `
      <div style="background:linear-gradient(180deg,#101822 0%,#080c11 100%);
                  border:2px solid ${blue};border-radius:6px;padding:12px 14px;
                  color:#f0e4c0;font-family:'Signika','Helvetica Neue',sans-serif;
                  box-shadow:0 0 10px ${blue}33;">
        <div style="display:flex;flex-wrap:wrap;align-items:center;gap:6px 10px;font-size:15px;font-weight:700;
                    color:${blue};text-transform:uppercase;letter-spacing:0.6px;
                    border-bottom:1px solid #2a3a4a;padding-bottom:6px;margin-bottom:8px;">
          <i class="fas fa-up-down" style="font-size:16px;"></i>
          <span>${esc(item?.name)} &mdash; ${title}</span>
        </div>
        ${body}
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
