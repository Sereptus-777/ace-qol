// ─── ACE: QOL — The roll popout: the one who must roll gets a box ───────────
//
// Johnny, 2026-09-19: "SAVE CARD UX. RULE: Chat keeps the results. The player
// who must roll gets a popout. NPCs do not sit on a waiting list.
//   PLAYER: popout on that owner's client; sound on open; the roll button
//   blinks; that client focuses the popout; one click rolls; popout closes
//   after the roll; GM card may still say 'Waiting for player'.
//   CONCENTRATION: ... Same d20 widget as the save popout."
//
// One box for every roll ACE asks a person to make: a save on a save card
// (Fireball, a death burst, a gaze) and a concentration check. By his pop-up
// rule it is a moment, not a form: who is doing it, to whom, their two
// portraits, one line, and the roll. The numbers go on the chat card after
// (feedback: pop-ups are moments, not forms).
//
// The callers say what the roll IS (the save engine, the concentration
// prompt); this only shows it, rolls it once, and closes.
//
// ⚠️ IMPORTS ONLY LEAVES, so the save engine and the damage door can both ask.
// ──────────────────────────────────────────────────────────────────────────────

import { popupDing } from "./popup-ding.mjs";
import { aceD20FaceImg } from "./dice-face.mjs";

const MODULE_ID = "ace-qol";
const LOG = "ace-qol | roll popout";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c]));

const CSS = `
.ace-qol-roll-popout .window-header {
  background: linear-gradient(180deg, #1a1a20 0%, #111116 100%);
  border-bottom: 1px solid rgba(212,175,55,0.35);
  color: #f0e4c0;
}
.ace-qol-roll-popout .window-header .window-title { font-size: 18px; font-weight: 700; }
/* It is not dismissed by accident: it closes when the roll is made. */
.ace-qol-roll-popout .window-header [data-action="close"] { display: none; }
.ace-qol-roll-popout .window-content {
  background: linear-gradient(180deg, #141118 0%, #0c0c10 100%);
  color: #f0e4c0;
  padding: 0;
}
.ace-qol-roll-popout .acp-body {
  display: flex; flex-direction: column; gap: 12px;
  padding: 14px 16px 16px;
  font-family: 'Signika', 'Helvetica Neue', sans-serif;
}
.ace-qol-roll-popout .acp-scene {
  display: flex; align-items: center; justify-content: center; flex-wrap: wrap; gap: 14px;
}
.ace-qol-roll-popout .acp-side {
  display: flex; flex-direction: column; align-items: center; gap: 5px;
  max-width: 130px; text-align: center;
}
.ace-qol-roll-popout .acp-portrait {
  width: 66px; height: 66px; border-radius: 10px; object-fit: cover;
  border: 2px solid var(--acp-accent, #d4af37); background: #0c0c10;
}
.ace-qol-roll-popout .acp-name { font-size: 16px; font-weight: 700; line-height: 1.2; overflow-wrap: anywhere; }
.ace-qol-roll-popout .acp-you { font-size: 14px; color: #c0b288; font-weight: 400; }
.ace-qol-roll-popout .acp-arrow { color: #c0392b; font-size: 24px; }
.ace-qol-roll-popout .acp-line { font-size: 17px; line-height: 1.4; text-align: center; }
.ace-qol-roll-popout .acp-roll { display: flex; flex-direction: column; align-items: center; gap: 12px; }
.ace-qol-roll-popout .acp-die {
  background: none; border: none; padding: 0; cursor: pointer; border-radius: 50%;
  animation: acp-blink-die 1.1s ease-in-out infinite;
}
.ace-qol-roll-popout .acp-pill, .ace-qol-roll-popout .acp-lucky {
  width: 100%; display: flex; align-items: center; justify-content: center; gap: 10px;
  padding: 12px 18px; border-radius: 999px; cursor: pointer;
  font-family: 'Signika', sans-serif; font-size: 18px; font-weight: 700; line-height: 1.25;
  white-space: normal; overflow-wrap: break-word; text-align: center;
}
.ace-qol-roll-popout .acp-pill {
  background: var(--acp-accent, #d4af37); color: #1a1408; border: 1px solid #8a6d1c;
  animation: acp-blink 1.1s ease-in-out infinite;
}
.ace-qol-roll-popout .acp-pill:focus-visible { outline: 3px solid #ffffff; outline-offset: 2px; }
.ace-qol-roll-popout .acp-lucky { background: #3fa34d; color: #0b1a0e; border: 1px solid #2a6e33; font-size: 17px; }
.ace-qol-roll-popout .acp-pill:disabled, .ace-qol-roll-popout .acp-lucky:disabled,
.ace-qol-roll-popout .acp-die:disabled { animation: none; opacity: 0.7; cursor: default; }
@keyframes acp-blink {
  0%, 100% { box-shadow: 0 0 0 0 rgba(212,175,55,0); filter: brightness(1); }
  50%      { box-shadow: 0 0 16px 5px rgba(212,175,55,0.85); filter: brightness(1.25); }
}
@keyframes acp-blink-die {
  0%, 100% { filter: brightness(1); }
  50%      { filter: brightness(1.45) drop-shadow(0 0 8px rgba(212,175,55,0.9)); }
}
`;

function injectCss() {
  try {
    if (globalThis.document?.getElementById?.("ace-qol-roll-popout-css")) return;
    const style = document.createElement("style");
    style.id = "ace-qol-roll-popout-css";
    style.textContent = CSS;
    document.head?.appendChild?.(style);
  } catch (err) {
    console.warn(`${LOG} | could not add its look to the page:`, err);
  }
}

const AppV2 = globalThis.foundry?.applications?.api?.ApplicationV2 ?? class { constructor() {} };

class RollPopoutApp extends AppV2 {
  static DEFAULT_OPTIONS = {
    classes: ["ace-qol-roll-popout"],
    tag: "div",
    window: { title: "Roll", icon: "fa-solid fa-dice-d20", resizable: false, minimizable: false },
    position: { width: 380, height: "auto" },
  };

  constructor(spec) {
    super({ id: `ace-qol-roll-popout-${String(spec.key).replace(/[^\w-]/g, "_")}`,
      window: { title: spec.title ?? "Roll" } });
    this.spec = spec;
    this.rolled = false;
    this.rolling = false;
  }

  async _renderHTML() {
    const s = this.spec;
    const portrait = (img, name) => img
      ? `<img class="acp-portrait" src="${esc(img)}" alt="${esc(name)}" />`
      : `<span class="acp-portrait" style="display:inline-flex;align-items:center;justify-content:center;font-size:28px;font-weight:700;">${esc(String(name ?? "?").charAt(0))}</span>`;
    const scene = s.sourceName
      ? `<div class="acp-scene">
          <div class="acp-side">${portrait(s.sourceImg, s.sourceName)}<span class="acp-name">${esc(s.sourceName)}</span></div>
          <i class="fas fa-arrow-right acp-arrow"></i>
          <div class="acp-side">${portrait(s.rollerImg, s.rollerName)}<span class="acp-name">${esc(s.rollerName)} <span class="acp-you">(you)</span></span></div>
        </div>`
      : `<div class="acp-scene"><div class="acp-side">${portrait(s.rollerImg, s.rollerName)}<span class="acp-name">${esc(s.rollerName)}</span></div></div>`;
    // A point already spent on this roll (before a reload) shows as spent.
    const lucky = !s.lucky ? ""
      : s.lucky.spent
        ? `<button type="button" class="acp-lucky" data-acp="lucky" disabled><i class="fas fa-clover"></i><span>${esc(s.lucky.spentLabel ?? "Luck spent")}</span></button>`
        : `<button type="button" class="acp-lucky" data-acp="lucky"><i class="fas fa-clover"></i><span>${esc(s.lucky.label)}</span></button>`;
    return `<div class="acp-body" style="--acp-accent:${esc(s.accent ?? "#d4af37")}">
      ${scene}
      <div class="acp-line">${esc(s.line)}</div>
      <div class="acp-roll">
        ${lucky}
        <button type="button" class="acp-die" data-acp="roll" title="${esc(s.pillLabel)}">${aceD20FaceImg(20, { size: 72, glow: true })}</button>
        <button type="button" class="acp-pill" data-acp="roll"><i class="fas fa-dice-d20"></i><span>${esc(s.pillLabel)}</span></button>
      </div>
    </div>`;
  }

  _replaceHTML(result, content) {
    content.innerHTML = result;
    for (const b of content.querySelectorAll("[data-acp='roll']")) {
      b.addEventListener("click", (ev) => { ev.preventDefault(); this._roll(); });
    }
    const lucky = content.querySelector("[data-acp='lucky']");
    lucky?.addEventListener("click", (ev) => { ev.preventDefault(); this._lucky(lucky); });
  }

  _onRender(context, options) {
    super._onRender?.(context, options);
    // ⚠️ THIS CLIENT FOCUSES THE POPOUT (his rule): in front of every other
    // window, the roll button holding the keyboard so Enter or Space rolls.
    try { this.bringToFront?.(); } catch (_) { /* a window that cannot come forward is still open */ }
    try { this.element?.querySelector?.(".acp-pill")?.focus?.({ preventScroll: true }); } catch (_) { /* focus is a courtesy */ }
    try { globalThis.window?.focus?.(); } catch (_) { /* the browser may refuse; the ding still sounds */ }
    // Drawn: if the ding did not already sound when the box opened, it sounds now.
    this._ding();
  }

  /**
   * ⚠️ SOUND ON OPEN, ONCE (his rule, and his table on 2026-09-19: "No ding on
   * the Death Burst popout ... This box did not log a ding at all"). It is
   * asked for the moment the box opens AND again when Foundry says it is drawn,
   * with this guard making it one ding; a render that never reports back can no
   * longer leave the box silent. The same call the reaction boxes use.
   */
  _ding() {
    if (this._dinged) return false;
    this._dinged = true;
    return popupDing(`${this.spec.rollerName}'s ${this.spec.pillLabel}`);
  }

  async _lucky(btn) {
    if (!this.spec.lucky || this.rolling || this.rolled || btn.disabled) return;
    btn.disabled = true;
    try {
      const done = await this.spec.lucky.onPress();
      if (done) {
        btn.innerHTML = `<i class="fas fa-clover"></i><span>${esc(this.spec.lucky.spentLabel ?? "Luck spent: this roll has Advantage")}</span>`;
      } else {
        btn.disabled = false;
      }
    } catch (err) {
      console.warn(`${LOG} | the Lucky button failed:`, err);
      btn.disabled = false;
    }
  }

  /** One click rolls, once. */
  async _roll() {
    if (this.rolling || this.rolled) return;
    this.rolling = true;
    const buttons = [...(this.element?.querySelectorAll?.("button") ?? [])];
    for (const b of buttons) b.disabled = true;
    const pill = this.element?.querySelector?.(".acp-pill span");
    if (pill) pill.textContent = "Rolling…";
    try {
      await this.spec.onRoll();
      this.rolled = true;
    } catch (err) {
      console.error(`${LOG} | ${this.spec.rollerName}'s roll could not be made:`, err);
      globalThis.ui?.notifications?.error?.(`ACE: ${this.spec.rollerName}'s roll could not be made. The console has why.`);
      for (const b of buttons) b.disabled = false;
      if (pill) pill.textContent = this.spec.pillLabel;
    } finally {
      this.rolling = false;
    }
    if (this.rolled) await this.close({ acpRolled: true });
  }

  async close(options = {}) {
    // Closed once: the roll closing it and its result arriving can both ask.
    if (this._acpClosed) return this;
    this._acpClosed = true;
    RollPopout._open.delete(this.spec.key);
    const dismissed = !this.rolled && !options?.acpRolled && !options?.acpResolved;
    const out = await super.close?.(options);
    if (dismissed) {
      // Closed without a roll (Escape, or another way): the roll must not be lost.
      try { await this.spec.onDismiss?.(); }
      catch (err) { console.warn(`${LOG} | could not give ${this.spec.rollerName}'s roll back to the chat:`, err); }
    }
    return out;
  }
}

export class RollPopout {
  /** key → the open popout on this client. */
  static _open = new Map();

  /**
   * Open a roll popout on THIS client, once per key.
   *
   * @param {object} spec
   * @param {string} spec.key          one per prompt (its chat message's id)
   * @param {string} spec.title        the window title: the spell or feature
   * @param {string} spec.line         one plain line: what is happening
   * @param {string} [spec.sourceName] who or what it comes from
   * @param {string} [spec.sourceImg]
   * @param {string} spec.rollerName   the creature rolling
   * @param {string} [spec.rollerImg]
   * @param {string} spec.pillLabel    the action alone: "Roll Dexterity save"
   * @param {string} [spec.accent]
   * @param {object} [spec.match]      what a result for this roll looks like (for closing)
   * @param {{label: string, spent?: boolean, spentLabel?: string, onPress: () => Promise<boolean>}|null} [spec.lucky]
   * @param {() => Promise<void>} spec.onRoll
   * @param {() => Promise<void>} [spec.onDismiss]  closed without a roll
   * @returns {boolean} whether a popout is open for this key now
   */
  static open(spec) {
    try {
      if (!spec?.key || typeof spec.onRoll !== "function") return false;
      if (RollPopout._open.has(spec.key)) return true;
      injectCss();
      const app = new RollPopoutApp(spec);
      RollPopout._open.set(spec.key, app);
      const rendered = app.render?.({ force: true });
      if (rendered?.catch) rendered.catch(err => {
        console.warn(`${LOG} | ${spec.rollerName}'s roll box could not be drawn; the roll goes to the chat:`, err);
        RollPopout._open.delete(spec.key);
        // It still asks out loud: the card in the chat is what they answer now.
        popupDing(`${spec.rollerName}'s ${spec.pillLabel} (in the chat)`);
        spec.onDismiss?.();
      });
      // The same ding every ACE prompt uses, as the box opens.
      const dinged = app._ding();
      console.log(`${LOG} | ${spec.rollerName}: "${spec.pillLabel}" is waiting on this screen `
        + `(${spec.title}); ding ${dinged ? "asked for" : "not played, see the line above"}.`);
      return true;
    } catch (err) {
      console.warn(`${LOG} | could not open ${spec?.rollerName ?? "a"} roll box:`, err);
      RollPopout._open.delete(spec?.key);
      return false;
    }
  }

  static isOpen(key) { return RollPopout._open.has(key); }

  /** Close every popout whose `match` passes: its roll was made somewhere else (the GM rolled for them). */
  static closeWhere(test, why = "its roll was made elsewhere") {
    for (const [key, app] of [...RollPopout._open]) {
      let hit = false;
      try { hit = !!test(app.spec?.match ?? {}, key); } catch (_) { hit = false; }
      if (!hit) continue;
      console.log(`${LOG} | ${app.spec?.rollerName}'s box closes: ${why}.`);
      app.rolled = true;
      app.close({ acpResolved: true }).catch(err => console.warn(`${LOG} | could not close a roll box:`, err));
    }
  }
}

export const _test = { RollPopoutApp };
