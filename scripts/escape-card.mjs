// ─── THE ESCAPE CARD — ONE BUILDER, FOUR ROWS ────────────────────────────────
//
// His card, 2026-10-04:
//
//   "Rebuild the escape card in four rows, in this order, pass or fail.
//    Row 1: the creature's name, then Athletics check. Nothing else on this row.
//    Row 2: the d20 image on the left, and on the same line the formula, large:
//           die result + bonus = total. Nothing else on this line.
//    Row 3: vs DC and the number, on its own row, under the formula.
//    Row 4: the result on its own row. A pass is green and says Broke free of
//           Constrict. A fail is the same orange as now and says The hold stays.
//    Remove the Strength score line, the Escape pill, the second formula, and
//    Snake Form Only. Keep the current colors."
//
// ⚠️🔴 TWO FILES DREW THIS CARD AND EACH DREW IT DIFFERENTLY. The held-turn box
// posted one (grapple-turn.mjs) and Web, the net and the Entangling Rope posted
// another (break-free-engine.mjs): one showed the bonus, the other printed
// "18 = 25" with the bonus nowhere, and only one of them carried the pill he is
// asking me to take off. Rebuilding the one he was looking at would have left
// the other wrong until his next net. There is one builder now and neither file
// decides anything about how it looks, the colours included.
//
// ⚠️ THE PILL IS GONE ON PURPOSE. It named the score (Strength), it named every
// effect behind the bonus (his "Snake Form Only"), and it repeated the sum that
// row 2 already shows. The bonus is one number on row 2 and that is the whole of
// it.
import { aceD20FaceImg } from "./dice-face.mjs";

/**
 * The only two colours this card has: pass green, fail red.
 * ⚠️ THE FAIL IS THE SUITE'S RED (his correction, 2026-10-04), the same
 * `#ff1744` a failed save wears, not the orange this card opened with.
 */
export const ESCAPE_PASS = "#9bcc4a";
export const ESCAPE_FAIL = "#ff1744";

/**
 * `+ STR 4`, `- STR 2`, `+ STR 0`: the bonus keeps the shape of the line
 * whatever it is, and it says which score it came off.
 *
 * ⚠️ THE SCORE IS DRAWN AT THE SAME SIZE AS THE NUMBERS (his rule): it sits in
 * the same span and takes no size of its own, so "2 + STR 4 = 6" reads as one
 * line of numbers and not as a number with a caption.
 */
function _bonusText(bonus, ability) {
  const n = Number(bonus) || 0;
  const abil = ability
    ? `${String(CONFIG.DND5E?.abilities?.[ability]?.abbreviation ?? ability).toUpperCase()} `
    : "";
  return `${n < 0 ? "-" : "+"} ${abil}${Math.abs(n)}`;
}

/**
 * The card, in his four rows.
 *
 * @param {object}  o
 * @param {string}  o.name        the creature's name
 * @param {string}  [o.actorId]   for the DC reader (§ 13: a DC shows on the roll that needs it)
 * @param {string}  o.checkLabel  "Athletics check", "Acrobatics check", "Strength check"
 * @param {string}  [o.ability]   the score the bonus came off ("str"), for "+ STR 4"
 * @param {number|null} o.die     the d20 face, or null when it could not be read
 * @param {number}  o.total       what the roll came to
 * @param {number}  o.dc          what it was against
 * @param {boolean} o.passed
 * @param {string}  o.label       the hold's own name, for the pass line
 * @returns {string} the card's HTML
 */
export function escapeCardHtml({ name, actorId = "", checkLabel, ability = "",
                                 die, total, dc, passed, label }) {
  const esc = (s) => foundry.utils.escapeHTML(String(s ?? ""));
  const colour = passed ? ESCAPE_PASS : ESCAPE_FAIL;
  const sum = Number(total);

  /* ⚠️ A DIE NOBODY COULD READ IS NOT A ZERO. Without the face there is no bonus
     to work out either, so the line shows the one number it actually knows
     instead of inventing the other two. */
  const formula = (die == null)
    ? `<b class="ace-qol-escape-total" style="color:${colour};">${sum}</b>`
    : `<b class="ace-qol-escape-die">${Number(die)}</b>`
      + `<span class="ace-qol-escape-bonus">${_bonusText(sum - Number(die), ability)} =</span>`
      + `<b class="ace-qol-escape-total" style="color:${colour};">${sum}</b>`;

  return `
    <div class="ace-qol-escape-card" style="border-color:${colour}55;">
      <div class="ace-qol-escape-who"><b>${esc(name)}</b> &mdash; ${esc(checkLabel)}</div>
      <div class="ace-qol-escape-roll">
        ${aceD20FaceImg(die, { size: 34, glow: true })}
        <span class="ace-qol-escape-sum">${formula}</span>
      </div>
      <div class="ace-qol-escape-dc ace-qol-dc" data-dc-roller="${esc(actorId)}">vs DC ${Number(dc)}</div>
      <div class="ace-qol-escape-verdict" style="color:${colour};">${passed
        ? `Broke free of ${esc(label)}`
        : "The hold stays."}</div>
    </div>`;
}
