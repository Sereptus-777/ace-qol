// ─── ACE: QOL — The d20 widget: one die face, everywhere a person rolls ──────
//
// Real black d20 die art (per-face). These are the dice the GM already sees;
// ACE uses them everywhere a save result or a prompt appears instead of the flat
// Font Awesome icon. The art is black and ACE's cards are dark, so each die gets
// a gold radial glow and a drop-shadow beneath it for contrast.
//
// ⚠️ ONE WIDGET (2026-09-19). His ask: "Same d20 widget as the save popout."
// This lived in the save engine with a second copy in the break-free engine;
// the roll popout, the save cards, break-free and concentration all draw this
// one now. A LEAF: imports nothing.
// ──────────────────────────────────────────────────────────────────────────────

const ACE_DICE_DIR = "modules/ace-qol/Assets/Dice%20Dice/BD20";

/**
 * @param {number} face         The raw d20 result (1–20). Out-of-range → generic 20 face.
 * @param {{size?:number, glow?:boolean}} opts  Pixel size of the die (default 30).
 * @returns {string}            HTML for a glowing black d20 showing that face.
 */
export function aceD20FaceImg(face, { size = 30, glow = true } = {}) {
  const n = Number(face);
  const valid = Number.isInteger(n) && n >= 1 && n <= 20;
  const src = `${ACE_DICE_DIR}/BD20-${valid ? n : 20}_nobg.png`;
  const icon = Math.round(size * 0.74);
  const glowSpan = glow
    ? `<span style="position:absolute;width:${size}px;height:${size}px;border-radius:50%;background:radial-gradient(circle,rgba(212,175,55,0.60) 0%,rgba(212,175,55,0.22) 48%,transparent 72%);"></span>`
    : "";
  const shadow = glow ? "filter:drop-shadow(0 0 3px rgba(212,175,55,0.75));" : "";
  return `<span class="ace-qol-d20" style="position:relative;display:inline-flex;align-items:center;justify-content:center;width:${size}px;height:${size}px;flex-shrink:0;vertical-align:middle;">`
    + glowSpan
    + `<img src="${src}" alt="d20${valid ? " " + n : ""}" style="position:relative;width:${size}px;height:${size}px;object-fit:contain;${shadow}" `
    + `onerror="this.style.display='none';this.nextElementSibling.style.display='inline-block';" />`
    + `<i class="fas fa-dice-d20" style="display:none;position:relative;color:#d4af37;font-size:${icon}px;"></i>`
    + `</span>`;
}
