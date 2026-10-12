// ─── ACE: QOL — Pipeline Resolver: Heal ───────────────────────────────────────
// Single-target heal (Cure Wounds touch, Healing Word ranged) and multi-target
// heal (Mass Cure Wounds, Mass Healing Word), and the revives, the stabilise and
// the restorations the registry shapes as touch heals.
//
// ⚠️🔴 NOTHING LANDS UNTIL THE GM PRESSES APPLY (his rule, 2026-10-11, the live
// test: "Cure Wounds is applying the healing by itself... Jeth was healed 12 with
// no card to press. Stop that. The number sits on the card until the GM presses
// Apply, the same way damage waits."). The dice are rolled and shown here; the
// card carries the number; the GM's Apply on a row takes it through the
// hit-point door, scaled by the row's X, ¼, ½, 1 or 2 the way a damage row is.
//
// THE ONE ROAD, PHASE 4 (2026-09-15): the healing is the used activity's own,
// rolled by dnd5e with the slot's scaling: the item's reading, and for a named
// official spell the same numbers as its book entry. It lands through the
// hit-point door, and the card through the card door. The registry's hand-written
// formula, entry.heal.formula(castLvl, spellMod), is used only when the activity
// rolls nothing of its own (Raise Dead's "Revive" carries no healing, Spare the
// Dying and the restorations none at all).
// ──────────────────────────────────────────────────────────────────────────────

import { MODULE_ID } from "../../ace-qol.mjs";
import { safeShowForRoll, awaitDiceSettle } from "../../dsn-utils.mjs";
import { HpDoor, ConditionDoor, CardDoor } from "../../road/doors.mjs";
import { registerChatCardHandler } from "../../chat-render-utils.mjs";
import { shareOf } from "../../road/what-lands.mjs";

export class HealResolver {

  static async runSingle(ctx, result) {
    const target = result?.target ?? result?.targets?.[0];
    if (!target) {
      console.warn(`${MODULE_ID} | HealResolver.runSingle: no target`);
      return;
    }
    return HealResolver._heal(ctx, [target], false);
  }

  static async runMulti(ctx, result) {
    const targets = result?.targets ?? [];
    if (!targets.length) {
      console.warn(`${MODULE_ID} | HealResolver.runMulti: no targets`);
      return;
    }
    return HealResolver._heal(ctx, targets, true);
  }

  // ─── Core ──────────────────────────────────────────────────────────────────

  /**
   * The healing the used activity rolls itself, through dnd5e, scaled by the
   * slot it was cast with. Null when it rolls nothing of its own.
   */
  static async _activityRoll(ctx) {
    const { activity, item, castLevel } = ctx;
    if (typeof activity?.rollDamage !== "function") return null;
    try {
      // The same roll config the save engine gives a spell's damage: the slot's
      // scaling, and the mark the pipeline's roll guard lets through.
      const { SaveEngine } = await import("../../save-engine.mjs");
      const rolls = await activity.rollDamage(SaveEngine._damageRollConfig(item, castLevel),
        { configure: false }, { create: false });
      return (Array.isArray(rolls) ? rolls : []).find(r => Number.isFinite(Number(r?.total))) ?? null;
    } catch (err) {
      console.warn(`${MODULE_ID} | ${item?.name}: dnd5e could not roll its own healing, so the registry's formula is used:`, err);
      return null;
    }
  }

  static async _heal(ctx, targets, isMulti) {
    const { entry, item, actor, castLevel, spellMod } = ctx;
    const formulaFn = entry.heal?.formula;
    const isRevive = entry.heal?.revivesDead === true;       // Revivify, Raise Dead
    const isStabilize = entry.heal?.stabilizes === true;     // Spare the Dying
    const clearStatuses = Array.isArray(entry.heal?.clearStatuses) ? entry.heal.clearStatuses : null;

    // One roll for one creature: the activity's own, else the registry's formula.
    let from = null;
    const rollOne = async () => {
      const own = await HealResolver._activityRoll(ctx);
      if (own) { from = "the spell"; return own; }
      if (typeof formulaFn !== "function") return null;
      from = "ACE's registry";
      return new Roll(formulaFn(castLevel, spellMod), actor.getRollData()).evaluate();
    };

    // ⚠️🔴 ONE ROLL OR ONE EACH, AND THE SPELL DECIDES. "Each target regains Hit
    // Points equal to 5d8 plus your spellcasting ability modifier" is one roll
    // shared by all of them, the same convention as area damage and what dnd5e's
    // own implementation does. A per-entry flag, so a spell that genuinely rolls
    // per creature keeps working by saying nothing.
    const rollOnce = entry.heal?.rollOnce === true;
    const sharedRoll = (rollOnce && targets.length > 1) ? await rollOne() : null;

    // ⚠️🔴 NOTHING LANDS BEFORE THE DICE (Johnny's rule). Every roll is made and
    // thrown first, the dice land, and only then does anything touch a creature.
    const rollFor = new Map();
    for (const c of targets) {
      if (!c.actor) continue;
      try {
        const roll = sharedRoll ?? await rollOne();
        if (roll) rollFor.set(c, roll);
      } catch (err) {
        console.error(`${MODULE_ID} | HealResolver: the roll failed for ${c.name}:`, err);
      }
    }
    if (!rollFor.size) {
      console.error(`${MODULE_ID} | HealResolver: "${item.name}" rolls no healing of its own and its registry entry has no formula; nothing was healed.`);
      ui.notifications?.error(`${item.name}: ACE found no healing to roll. Nothing was healed; see the console.`);
      return;
    }
    for (const thrown of new Set(rollFor.values())) {
      try { safeShowForRoll(thrown, "healing"); } catch (_) { /* non-fatal */ }
    }
    await awaitDiceSettle();
    console.log(`${MODULE_ID} | ${item.name}: healing from ${from}: `
      + [...new Set(rollFor.values())].map(r => `${r.formula} = ${r.total}`).join("; "));

    // ⚠️ THE NUMBER WAITS ON THE CARD (his rule, 2026-10-11). Each row carries
    // what was rolled for it and what the creature had then; the GM's Apply
    // lands it. Hit points ride under the names the one function knows
    // (road/table-view.mjs), so they are the GM's alone.
    const rows = [];
    for (const c of targets) {
      const targetActor = c.actor;
      const roll = rollFor.get(c);
      if (!targetActor || !roll) continue;               // its roll failed above, and said so
      const temp = String(roll.options?.type ?? "") === "temphp";
      const hp = targetActor.system?.attributes?.hp ?? {};
      rows.push({
        name: c.name,
        img: c.img,
        actorId: targetActor.id ?? null,
        actorUuid: targetActor.uuid ?? null,
        formula: roll.formula,
        rolled: Math.max(0, Number(roll.total) || 0),
        temp,
        hpBefore: Number(temp ? hp.temp : hp.value) || 0,
        maxHP: Number(hp.max) || 0,
        applied: false,
      });
    }
    if (!rows.length) return;

    await HealResolver._postChatCard(item, actor, rows, castLevel,
      { revive: isRevive, stabilize: isStabilize, clearStatuses });
  }

  static async _postChatCard(item, caster, rows, castLevel, spell) {
    if (!rows.length) return;
    const state = {
      type: "healResult",
      actorId: caster?.id ?? null,
      // Who cast it, for the header's line (his rule, 2026-10-11).
      casterName: caster?.token?.name ?? caster?.getActiveTokens?.()?.[0]?.name ?? caster?.name ?? "",
      itemName: item?.name ?? "",
      itemImg: item?.img ?? "",
      castLevel,
      itemLevel: item?.system?.level ?? 1,
      spell,
      rows,
    };
    // Through the card door. The healing dice were waited for before the card.
    try {
      await CardDoor.post({
        speaker: ChatMessage.getSpeaker({ actor: caster }),
        content: HealResolver._cardHtml(state),
        flavor: `${item.name}: healing for ${rows.length} target${rows.length === 1 ? "" : "s"}, waiting for the GM`,
        flags: { [MODULE_ID]: state },
      });
    } catch (err) {
      console.error(`${MODULE_ID} | HealResolver: the healing card could not be posted, so nothing can be applied `
        + `from it; nothing has landed:`, err);
      ui.notifications?.error(`${item.name}: the healing card could not be posted. Nothing was healed; see the console.`);
    }
  }

  /** "Jeth", "Jeth and Kirsten", "Jeth, Kirsten and Escher": the rows, escaped. */
  static _namesOf(rows) {
    const names = (rows ?? []).map(r => foundry.utils.escapeHTML(String(r?.name ?? ""))).filter(Boolean);
    return names.length <= 1 ? (names[0] ?? "")
      : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  }

  /** What a row will land, or did: the number on its card. */
  static _amountOf(row, mult = 1) {
    return row.applied ? (Number(row.landedAmount) || 0) : shareOf(row.rolled, mult);
  }

  /** The row's words: "+12 healing", the same for the GM and the table. */
  static _saidOf(row, spell, mult = 1) {
    const esc = (v) => foundry.utils.escapeHTML(String(v ?? ""));
    if (row.notApplied) return `<span style="color:#e8c46a;">Not applied: ${esc(row.notApplied)}.</span>`;
    if (spell?.stabilize) return row.applied ? "Stabilized, still unconscious" : "Stabilize";
    const n = HealResolver._amountOf(row, mult);
    return row.temp ? `+${n} temporary hit points` : `+${n} healing`;
  }

  /** The GM's line: the hit points it had, and what it has or will have. */
  static _hpOf(row, spell, mult = 1) {
    const max = Number(row.maxHP) || 0;
    const before = Number(row.hpBefore) || 0;
    if (spell?.stabilize) return `HP ${before}/${max}`;
    const after = row.applied ? (Number(row.hpAfter) || 0)
      : row.temp ? Math.max(before, HealResolver._amountOf(row, mult))
      : Math.min(max || Infinity, before + HealResolver._amountOf(row, mult));
    return row.temp
      ? `Temporary HP ${before} → <strong style="color:#7ec97e;">${after}</strong>`
      : `HP ${before} → <strong style="color:#7ec97e;">${after}</strong> / ${max}`;
  }

  static _cardHtml(state) {
    const accent = "#7ec97e";
    const esc = (s) => foundry.utils.escapeHTML(String(s ?? ""));
    const rows = state.rows ?? [];
    const total = rows.reduce((sum, r) => sum + HealResolver._amountOf(r), 0);
    /* ⚠️ ONE NUMBER PER ROW (his rule, 2026-10-11, the live test: "Both cards,
       mine and the player's, drop the big second +13."), and then the same
       afternoon: "The portrait, the name, and '+12 healing' are half again as
       big. A 10 becomes a 15. Green, same as now. The player stops there. The
       GM card has the same three, the hit points, and under them the controls.
       Apply, then X, ¼, ½, 1, 2... All of them green, on this card. Not the
       damage colors. The player does not get that row." So the portrait is 54
       (was 36), the name 21px (14) and the words 22.5px (15). The hit points and
       the controls are the GM's, cut from every player's copy before the card
       is sent (road/table-view.mjs). */
    const saidStyle = `font-size:22.5px;font-weight:700;color:${accent};line-height:1.2;`;
    /* ⚠️🔴 THE DAMAGE CARD'S OWN CONTROLS (his rule, 2026-10-11: "There is one
       way to build a thing. If a card, a row, or a control already exists, you
       use that one... The healing controls broke it. They are the damage
       controls. Copy that row."). Its classes and so its sizes: the × ¼ ½ 1 2
       row (.ace-qol-dmg-ovr-line), the hit points under it (.ace-qol-dmg-hp-line),
       and APPLY ALL / UNDO ALL (.ace-qol-dmg-actions), all inside the GM's half
       (.ace-qol-dmg-gm-controls, cut from every player's copy before the card is
       sent). Green on this card, and colour is the only thing the stylesheet
       changes (.ace-qol-heal-result). 1 is picked to start. */
    const targetRows = rows.map((r, i) => {
      const cleared = r.clearedStatuses?.length
        ? `<div style="font-size:14px;color:#9ec99e;font-style:italic;margin-top:2px;">Cleared: ${esc(r.clearedStatuses.join(", "))}</div>`
        : "";
      const hp = r.notApplied ? "" : HealResolver._hpOf(r, state.spell);
      const picked = r.applied ? Number(r.mult ?? 1) : 1;
      const scale = (k, label) => `<button type="button" class="${k === 0 ? "ace-qol-dmg-ovr-x" : "ace-qol-dmg-ovr"}`
        + `${HealResolver.SCALES[k] === picked ? " ace-qol-dmg-ovr-active" : ""}"`
        + ` data-action="aceQolHealScale" data-row="${i}" data-pick="${k}"${r.applied ? " disabled" : ""}>${label}</button>`;
      const controls = `<div class="ace-qol-dmg-gm-controls">`
        + `<div class="ace-qol-dmg-ovr-line">${scale(0, "×")}${scale(1, "¼")}${scale(2, "½")}${scale(3, "1")}${scale(4, "2")}</div>`
        + (hp ? `<div class="ace-qol-dmg-hp-line"><span class="ace-qol-dmg-row-hp ace-qol-heal-hp">${hp}</span></div>` : "")
        + `</div>`;
      return `
        <div class="ace-qol-heal-row" data-row="${i}" style="display:flex;align-items:center;gap:10px;padding:8px;background:rgba(126,201,126,0.10);border-radius:4px;margin-bottom:4px;min-width:0;flex-wrap:wrap;">
          <img class="ace-face" src="${r.img || "icons/svg/heal.svg"}" style="width:54px;height:54px;border-radius:4px;background:#0c140c;border:1px solid #5a8a5a;flex-shrink:0;" />
          <div style="flex:1 1 160px;min-width:0;color:#e8d49a;">
            <div style="font-weight:600;font-size:21px;line-height:1.2;overflow-wrap:anywhere;">${esc(r.name)}</div>
            <div class="ace-qol-heal-said" style="${saidStyle}">${HealResolver._saidOf(r, state.spell)}</div>
            ${cleared}
            ${controls}
          </div>
        </div>
      `;
    }).join("");
    const allApplied = rows.length > 0 && rows.every(r => r.applied);
    const actions = `<div class="ace-qol-dmg-gm-controls"><div class="ace-qol-dmg-actions">`
      + `<button class="ace-qol-btn ace-qol-btn-apply${allApplied ? " ace-qol-btn-applied" : ""}" data-action="aceQolHealApplyAll"${allApplied ? " disabled" : ""}>`
      + `<i class="fas fa-heart"></i> ${allApplied ? "APPLIED" : "APPLY ALL"}</button>`
      + `<button class="ace-qol-btn ace-qol-btn-undo" data-action="aceQolHealUndoAll"><i class="fas fa-undo"></i> UNDO ALL</button>`
      + `</div></div>`;

    return `
      <div class="ace-qol-heal-result" style="background:linear-gradient(180deg,#101a10 0%,#080f08 100%);
                  border:2px solid ${accent};
                  border-radius:6px;
                  padding:12px 14px;
                  color:#f0e4c0;
                  font-family:'Signika','Helvetica Neue',sans-serif;">
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;row-gap:4px;
                    font-size:15px;font-weight:700;color:${accent};
                    text-transform:uppercase;letter-spacing:0.6px;
                    border-bottom:1px solid #2a4a2a;
                    padding-bottom:6px;margin-bottom:8px;">
          <img src="${state.itemImg || "icons/svg/heal.svg"}" style="width:24px;height:24px;border-radius:3px;object-fit:cover;flex-shrink:0;" />
          <span style="flex:1 1 auto;min-width:0;overflow-wrap:anywhere;">${esc(String(state.itemName ?? "").toUpperCase())}${state.castLevel > (state.itemLevel ?? 1) ? ` (L${state.castLevel})` : ""}</span>
          <span style="font-size:14px;flex-shrink:0;">+${total} total</span>
          ${/* ⚠️ WHO CAST IT, AND WHO IT LANDED ON: one line in the header that is
               already there (his rule, 2026-10-11: "Do not rebuild the card. Add one
               line to the header that is already there... No second portrait."). */ ""}
          ${state.casterName ? `<div style="flex-basis:100%;font-size:14px;font-weight:600;color:#e8d49a;text-transform:none;letter-spacing:normal;overflow-wrap:anywhere;">${esc(state.casterName)} casts it on ${HealResolver._namesOf(rows)}.</div>` : ""}
        </div>
        ${targetRows}
        ${actions}
      </div>
    `;
  }

  // ─── The GM's controls ─────────────────────────────────────────────────────

  /** The GM's pick per row, on this screen, as the damage card keeps its own. */
  static _picked = new Map();
  /**
   * The five choices, by position: X, ¼, ½, 1, 2. ⚠️ A button names WHICH
   * choice, never an amount: what lands is read from the card's own record, not
   * from its markup (the one road, tools/one-road-check.py rule 3).
   */
  static SCALES = Object.freeze([0, 0.25, 0.5, 1, 2]);
  static _applying = new Set();

  /** Wire a heal card's × ¼ ½ 1 2, APPLY ALL and UNDO ALL. The GM's screen only. */
  static wireCard(message, html) {
    const flags = message?.flags?.[MODULE_ID];
    if (flags?.type !== "healResult" || !Array.isArray(flags.rows) || !game.user?.isGM) return;
    const el = html instanceof HTMLElement ? html : (html?.[0] ?? html);
    if (!el?.querySelectorAll) return;
    const show = (i) => {
      const row = flags.rows[i];
      const rowEl = el.querySelector(`.ace-qol-heal-row[data-row="${i}"]`);
      if (!row || !rowEl || row.applied) return;
      const mult = HealResolver._picked.get(`${message.id}|${i}`) ?? 1;
      const said = rowEl.querySelector(".ace-qol-heal-said");
      if (said) said.innerHTML = HealResolver._saidOf(row, flags.spell, mult);
      const hp = rowEl.querySelector(".ace-qol-heal-hp");
      if (hp && !row.notApplied) hp.innerHTML = HealResolver._hpOf(row, flags.spell, mult);
      for (const b of rowEl.querySelectorAll("[data-action='aceQolHealScale']")) {
        b.classList.toggle("ace-qol-dmg-ovr-active", HealResolver.SCALES[Number(b.dataset.pick)] === mult);
      }
    };
    flags.rows.forEach((_, i) => show(i));
    for (const btn of el.querySelectorAll("[data-action='aceQolHealScale']")) {
      if (btn.dataset.wired) continue;
      btn.dataset.wired = "1";
      btn.addEventListener("click", (ev) => {
        ev.preventDefault();
        const i = Number(btn.dataset.row);
        const mult = HealResolver.SCALES[Number(btn.dataset.pick)];
        if (mult === undefined || flags.rows[i]?.applied) return;
        HealResolver._picked.set(`${message.id}|${i}`, mult);
        show(i);
      });
    }
    const applyAll = el.querySelector("[data-action='aceQolHealApplyAll']");
    if (applyAll && !applyAll.dataset.wired) {
      applyAll.dataset.wired = "1";
      applyAll.addEventListener("click", async (ev) => {
        ev.preventDefault();
        if (applyAll.disabled) return;
        applyAll.disabled = true;
        await HealResolver._applyAll(message);
      });
    }
    const undoAll = el.querySelector("[data-action='aceQolHealUndoAll']");
    if (undoAll && !undoAll.dataset.wired) {
      undoAll.dataset.wired = "1";
      undoAll.addEventListener("click", async (ev) => {
        ev.preventDefault();
        await HealResolver._undoAll(message);
      });
    }
  }

  /**
   * APPLY ALL: every row not yet applied, its number scaled by its pick, through
   * the hit-point door. Once: a row already applied is left as it is.
   */
  static async _applyAll(message) {
    const flags = message.flags?.[MODULE_ID];
    if (!Array.isArray(flags?.rows)) return;
    if (HealResolver._applying.has(message.id) || flags.rows.every(r => r.applied)) {
      console.log(`${MODULE_ID} | this heal card is already applied; a second press does nothing.`);
      return;
    }
    HealResolver._applying.add(message.id);
    try {
      const spell = flags.spell ?? {};
      const rows = foundry.utils.deepClone(flags.rows);
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        if (row.applied) continue;
        const mult = HealResolver._picked.get(`${message.id}|${i}`) ?? 1;
        const amount = shareOf(row.rolled, mult);
        const actor = (row.actorUuid ? fromUuidSync(row.actorUuid) : null) ?? game.actors.get(row.actorId);
        if (!actor) {
          console.warn(`${MODULE_ID} | ${row.name} could not be found to heal; nothing was applied to it.`);
          ui.notifications?.warn(`ACE: ${row.name} could not be found, so nothing was applied to it.`);
          continue;
        }
        // × applies none. Anything else goes through the hit-point door, a 0 too:
        // a restoration heals nothing and the door is what lets it clear its
        // conditions (it counts a 0 as landed).
        // dice-ok: the GM's press on a card posted after its healing dice landed.
        const landed = (mult !== 0)
          ? await HpDoor.heal(actor, amount, { temp: row.temp, revive: !!spell.revive, stabilize: !!spell.stabilize })
          : { applied: false, healed: 0, before: row.hpBefore, after: row.hpBefore, why: null };
        const cleared = [];
        if (landed.applied && spell.clearStatuses?.length) {
          for (const status of spell.clearStatuses) {
            try { if (await ConditionDoor.remove(actor, status)) cleared.push(status); }
            catch (err) { console.warn(`${MODULE_ID} | could not take ${status} off ${row.name}:`, err); }
          }
        }
        rows[i] = {
          ...row,
          applied: true,
          mult,
          landedAmount: landed.applied ? (Number(landed.healed) || 0) : 0,
          hpBefore: Number(landed.before ?? row.hpBefore) || 0,
          hpAfter: Number(landed.after ?? row.hpBefore) || 0,
          clearedStatuses: cleared,
          notApplied: (amount > 0 && !landed.applied)
            ? (landed.why ?? (row.temp ? "it already had as many temporary hit points" : "nothing changed"))
            : null,
        };
        console.log(`${MODULE_ID} | ${row.name}: ${amount} of ${row.rolled} healing (×${mult}) applied by the GM; `
          + `${landed.applied ? `${landed.before} → ${landed.after}` : "nothing changed"}.`);
        HealResolver._picked.delete(`${message.id}|${i}`);
      }
      await message.update({
        content: HealResolver._cardHtml({ ...flags, rows }),
        [`flags.${MODULE_ID}.rows`]: rows,
      });
    } catch (err) {
      console.error(`${MODULE_ID} | APPLY ALL on a heal card failed:`, err);
      ui.notifications?.error("ACE: the healing could not be applied; see the console.");
    } finally {
      HealResolver._applying.delete(message.id);
    }
  }

  /**
   * UNDO ALL: every applied row's healing taken back, each once, and the card
   * ready again with 1 picked (the damage card's UNDO ALL, for healing). Nothing
   * applied means nothing to do, and it says so.
   */
  static async _undoAll(message) {
    const flags = message.flags?.[MODULE_ID];
    if (!Array.isArray(flags?.rows)) return;
    if (!flags.rows.some(r => r.applied)) {
      console.log(`${MODULE_ID} | UNDO ALL: nothing on this heal card is applied, so nothing is taken back.`);
      return;
    }
    if (HealResolver._applying.has(message.id)) return;
    HealResolver._applying.add(message.id);
    try {
      const rows = foundry.utils.deepClone(flags.rows);
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        if (!row.applied) continue;
        const actor = (row.actorUuid ? fromUuidSync(row.actorUuid) : null) ?? game.actors.get(row.actorId);
        let now = Number(row.hpBefore) || 0;
        if (!actor) {
          console.warn(`${MODULE_ID} | ${row.name} could not be found, so its healing was not taken back.`);
        } else if (Number(row.landedAmount) > 0) {
          const back = await HpDoor.takeBack(actor, row.landedAmount, { temp: row.temp, tempWas: row.temp ? row.hpBefore : null });
          now = back.after;
          console.log(`${MODULE_ID} | UNDO ALL on ${row.name}: ${row.landedAmount} healing taken back, `
            + `${back.before} → ${back.after}.${row.hpBefore <= 0 ? " It was brought up from 0; it is not put back to dying." : ""}`);
        } else {
          now = Number(actor.system?.attributes?.hp?.[row.temp ? "temp" : "value"] ?? now) || 0;
        }
        rows[i] = { ...row, applied: false, hpBefore: now, clearedStatuses: [], notApplied: null };
        delete rows[i].mult;
        delete rows[i].landedAmount;
        delete rows[i].hpAfter;
        HealResolver._picked.delete(`${message.id}|${i}`);
      }
      await message.update({
        content: HealResolver._cardHtml({ ...flags, rows }),
        [`flags.${MODULE_ID}.rows`]: rows,
      });
    } catch (err) {
      console.error(`${MODULE_ID} | UNDO ALL on a heal card failed:`, err);
      ui.notifications?.error("ACE: the healing could not be taken back; see the console.");
    } finally {
      HealResolver._applying.delete(message.id);
    }
  }
}

// The GM's × ¼ ½ 1 2, APPLY ALL and UNDO ALL on every heal card, drawn now or later.
registerChatCardHandler((message, html) => HealResolver.wireCard(message, html), "spell heal cards");
