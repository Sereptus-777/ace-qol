// ─── ACE: QOL — A frightening presence: one save, one creature, once ─────────
//
// Johnny, 2026-09-20:
//   "1. FRIGHTFUL PRESENCE IS ONE SAVE. Against that dragon a creature rolls
//    once. Already frightened by it: no roll. Already immune to it: no roll.
//    Outside 120 feet: no roll. No line of sight (wall, closed door): no roll.
//    A second press does not roll the room again.
//    2. WHEN IT FIRES. First time that dragon is on the map in this combat, or
//    its first turn, run it once. Picker first: default is living creatures in
//    120 feet with line of sight. He can tick and untick. Dead off the list.
//    The button still exists for a later reveal. Same rules.
//    3. WHAT LANDS. Fail = Frightened only. Not Compelled. Not Command."
//
// ⚠️ NOTHING NEW DECIDES ANYTHING. The save is the save engine's, the card is
// the card door's, the condition is the condition door's, and the repeat save
// at the end of a turn is the repeating-save engine's. This file answers three
// questions those engines cannot: who is even asked, when it happens without a
// press, and who is already done with it.
//
// ⚠️ THE FOUR "NO ROLL" ANSWERS ARE NOT SILENCE. Each one prints why, and the
// ones that matter (already frightened, already immune) go on the card as a
// line, because a GM who cannot see why four creatures were skipped will
// assume the feature is broken.
// ──────────────────────────────────────────────────────────────────────────────

import { aceDistanceFt } from "./geometry-utils.mjs";
import { Situation } from "./situation.mjs";
import { readFrightfulPresence } from "./rules/creature-words.mjs";
import { lifeStateOf, pickable } from "./road/picker-rule.mjs";
import { saveDCOf } from "./rules/save-dc.mjs";

const MODULE_ID = "ace-qol";
const LOG = "ace-qol | presence";
const say = (msg) => console.log(`${LOG} | ${msg}`);

/** A creature in any of these frightens nobody. */
const SOURCE_OUT = ["incapacitated", "paralyzed", "petrified", "stunned", "unconscious", "dead"];

const esc = (s) => globalThis.foundry?.utils?.escapeHTML
  ? foundry.utils.escapeHTML(String(s ?? ""))
  : String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c]));

export class PresenceEngine {

  /* ═══ Wiring ═══════════════════════════════════════════════════════════ */

  static init() {
    if (this._initialized) return;
    this._initialized = true;

    // It shows up: the fight starts with it on the map, or it walks on later.
    Hooks.on("combatStart", (combat) => {
      PresenceEngine._sweep(combat, "the fight started").catch(err =>
        console.warn(`${LOG} | the start-of-combat sweep failed; nobody was asked:`, err));
    });
    Hooks.on("createToken", (tokenDoc) => {
      if (!game.combat?.started) return;
      PresenceEngine._fireFor(tokenDoc, "it appeared on the map").catch(err =>
        console.warn(`${LOG} | a creature arriving mid-fight failed to bring its presence:`, err));
    });
    // Or its first turn comes round and it never got the chance above.
    Hooks.on("combatTurnChange", (combat, prior, current) => {
      const c = current?.combatantId ? combat?.combatants?.get(current.combatantId) : combat?.combatant;
      if (!c?.token) return;
      PresenceEngine._fireFor(c.token, "its first turn began").catch(err =>
        console.warn(`${LOG} | the turn-start presence failed; nobody was asked:`, err));
    });

    // A creature stops being frightened: RAW, that is when it becomes immune.
    Hooks.on("deleteActiveEffect", (effect) => {
      if (game.users?.activeGM !== game.user) return;
      const mark = effect?.flags?.[MODULE_ID]?.presence;
      if (!mark?.sourceTokenId) return;
      PresenceEngine._immunise(effect.parent, mark, "the fear ended").catch(err =>
        console.warn(`${LOG} | could not write the 24-hour immunity as the fear ended:`, err));
    });

    console.debug(`${LOG} | online: a frightening presence fires from its own words, once per creature.`);
  }

  /* ═══ When it fires ════════════════════════════════════════════════════ */

  static async _sweep(combat, why) {
    for (const c of combat?.combatants ?? []) {
      if (c?.token) await PresenceEngine._fireFor(c.token, why);
    }
  }

  /**
   * Everything this creature is frightening BY, fired once per fight.
   *
   * ⚠️ ONCE, AND THE MARK LIVES ON THE COMBAT. Keeping it in memory would
   * fire it again after a reload, which is a second room-wide save nobody
   * asked for. The combat carries it, and the mark dies with the fight.
   */
  static async _fireFor(tokenDoc, why) {
    if (game.users?.activeGM !== game.user) return;
    const combat = game.combat;
    if (!combat?.started || !tokenDoc?.actor) return;

    for (const item of tokenDoc.actor.items ?? []) {
      let presence = null;
      try { presence = readFrightfulPresence(item); }
      catch (err) { console.warn(`${LOG} | could not read "${item?.name}":`, err); continue; }
      if (!presence?.byPresence) continue;

      const key = `${tokenDoc.id}:${item.id}`;
      const fired = combat.getFlag(MODULE_ID, "presenceFired") ?? {};
      if (fired[key]) continue;
      try { await combat.setFlag(MODULE_ID, "presenceFired", { ...fired, [key]: true }); }
      catch (err) { console.warn(`${LOG} | could not mark ${item.name} as fired; it may ask twice:`, err); }

      say(`${tokenDoc.name}'s ${item.name}: ${why}, so it happens once, now.`);
      await PresenceEngine.run(tokenDoc, item, presence, { why });
    }
  }

  /* ═══ Who is asked ═════════════════════════════════════════════════════ */

  /**
   * One creature's answer: null when it rolls, otherwise why it does not.
   * The four his rule names, in his order.
   */
  static _skip(targetDoc, sourceDoc, item, presence) {
    const target = targetDoc?.actor;
    const source = sourceDoc?.actor;
    if (!target) return { reason: "no creature", label: "NO CREATURE", tone: "immune", hide: true };
    if (targetDoc.id === sourceDoc.id) return { reason: "itself", label: "ITSELF", tone: "immune", hide: true };
    if (!pickable("harm", lifeStateOf(target, targetDoc)).ok) {
      return { reason: "dead", label: "DEAD", tone: "dead", hide: true };   // never on the card at all
    }
    if (presence.excludes && String(target.system?.details?.type?.value ?? "").toLowerCase() === presence.excludes) {
      return { reason: `it is ${presence.excludes}`, hide: true, tone: "immune",
        label: `${presence.excludes.toUpperCase()} — its words leave them out` };
    }
    if (PresenceEngine.isFrightenedByIt(target, sourceDoc, item)) {
      return { reason: "already frightened by it", tone: "immune",
        label: `ALREADY FRIGHTENED by ${sourceDoc.name} — no save` };
    }
    const imm = PresenceEngine.immunityOn(target, sourceDoc, item);
    if (imm) {
      return { reason: "immune to it already", tone: "immune",
        label: `IMMUNE to ${sourceDoc.name}'s ${item.name} — no save` };
    }
    let ft = Infinity;
    try { ft = aceDistanceFt(sourceDoc, targetDoc); } catch (_) { ft = Infinity; }
    if (!(ft <= presence.radiusFt + 0.1)) {
      return { reason: "out of range", hide: true, tone: "range",
        label: `OUT OF RANGE (${Math.round(ft)} of ${presence.radiusFt} feet)` };
    }
    if (presence.needsSight) {
      const sees = Situation.canSee(target, source, {
        viewerToken: targetDoc.object ?? targetDoc, subjectToken: sourceDoc.object ?? sourceDoc, distanceFt: ft });
      if (!sees?.canSee) {
        return { reason: `cannot see it (${sees?.why ?? "unseen"})`, hide: true, tone: "blocked",
          label: `CANNOT SEE ${sourceDoc.name.toUpperCase()} — no save` };
      }
    }
    return null;
  }

  /** Everyone on the scene, with the reason each one is or is not asked. */
  static _read(sourceDoc, item, presence) {
    const scene = sourceDoc.parent ?? canvas?.scene ?? null;
    const rows = [];
    for (const t of scene?.tokens?.contents ?? []) {
      if (!t?.actor) continue;
      const skip = PresenceEngine._skip(t, sourceDoc, item, presence);
      let ft = null;
      try { ft = Math.round(aceDistanceFt(sourceDoc, t)); } catch (_) { ft = null; }
      rows.push({ doc: t, name: t.name, img: t.texture?.src ?? t.actor?.img ?? null, ft, skip });
    }
    return rows;
  }

  /* ═══ The run ══════════════════════════════════════════════════════════ */

  /**
   * @param {TokenDocument} sourceDoc  the creature everybody is afraid of
   * @param {Item} item
   * @param {object} presence  what its words say (rules/creature-words.mjs)
   * @param {object} [o]  `{ why, pressed }`
   */
  static async run(sourceDoc, item, presence, { why = "", pressed = false } = {}) {
    const source = sourceDoc?.actor;
    if (!source) return;
    if (SOURCE_OUT.some(s => source.statuses?.has?.(s))) {
      say(`${sourceDoc.name}'s ${item.name}: nothing. It is in no state to frighten anyone.`);
      ui.notifications?.info(`${sourceDoc.name} is in no state to frighten anyone.`);
      return;
    }

    const rows = PresenceEngine._read(sourceDoc, item, presence);
    const asked = rows.filter(r => !r.skip);
    // On the card but not rolling: the two his rule names, so he can see them.
    const spared = rows.filter(r => r.skip && !r.skip.hide);
    const offList = rows.filter(r => r.skip?.hide && r.skip.reason !== "itself" && r.skip.reason !== "no creature");

    say(`${sourceDoc.name}'s ${item.name}${why ? ` (${why})` : ""}: ${asked.length} to ask, `
      + `${spared.length} already done with it, ${offList.length} off the list `
      + `(${[...new Set(offList.map(r => r.skip.reason))].join("; ") || "none"}).`);

    if (!asked.length && !spared.length) {
      ui.notifications?.info(`${sourceDoc.name}'s ${item.name}: nobody in ${presence.radiusFt} feet `
        + `${presence.needsSight ? "can see it" : "is near it"}, so nobody rolls.`);
      return;
    }

    // ── The picker, first, every time ──
    const picked = await PresenceEngine._pick(sourceDoc, item, presence, asked, spared);
    if (picked === null) {
      say(`${sourceDoc.name}'s ${item.name}: the picker was closed, so nothing was asked.`);
      return;
    }
    if (!picked.length && !spared.length) {
      say(`${sourceDoc.name}'s ${item.name}: nobody was ticked, so nothing was asked.`);
      return;
    }

    // ── The save, on the one card ──
    const eng = game.aceQol?.saveEngine;
    if (typeof eng?.postSaveCard !== "function") {
      console.warn(`${LOG} | the save engine is not on the API, so ${item.name} asked nobody.`);
      ui.notifications?.error(`ACE: ${item.name} could not ask for its saves — see the console.`);
      return;
    }

    const read = await PresenceEngine._recipeFor(item, source, presence);
    if (!read) {
      ui.notifications?.warn(`ACE: "${item.name}" has no save ACE can read, so nothing was asked.`);
      return;
    }

    await eng.postSaveCard(item, source, picked.map(r => r.doc.object ?? r.doc), {
      saveAbility: read.ability,
      saveDC: read.dc,
      isSpell: false,
      recipe: read.recipe,
      activityId: read.activityId,
      skipDelay: true,
      autoResolve: true,
      trigger: pressed ? "press" : "presence",
      // Everything this file knows that the card cannot work out for itself.
      presence: {
        sourceTokenId: sourceDoc.id,
        sourceActorId: source.id,
        sourceName: sourceDoc.name,
        itemName: item.name,
        itemUuid: item.uuid ?? null,
        immuneHours: presence.immuneHours ?? null,
        // His rule: NPCs take it when the save is in, players wait for APPLY.
        holdPCs: true,
        spared: spared.map(r => ({ tokenDocId: r.doc.id, actorId: r.doc.actor?.id ?? null,
          name: r.name, img: r.img, label: r.skip.label, reason: r.skip.reason })),
      },
    });
  }

  /**
   * Its save, its DC, and a recipe whose failure is FRIGHTENED and nothing else.
   *
   * ⚠️ FRIGHTENED ONLY (his rule). A 2024 copy carries an effect of its own
   * called "Status: Frightened" beside the word in its text, and two of his
   * items carry a Compelled or a Command effect from the importer. Applying
   * what the item happens to hold put three things on one failed save; the
   * words say one.
   */
  static async _recipeFor(item, source, presence) {
    let rec = null;
    try {
      const { recipesFor } = await import("./inference/recipe.mjs");
      rec = (recipesFor(item, { actor: source }) ?? []).find(r => r?.recipe?.decidedBy?.kind === "save") ?? null;
    } catch (err) {
      console.warn(`${LOG} | could not read ${item.name}'s recipe:`, err);
    }
    if (!rec) return null;
    const ability = String(rec.recipe.decidedBy?.ability ?? "").toLowerCase();
    const dc = saveDCOf(rec.recipe, item);
    if (!ability || !Number.isFinite(dc) || dc <= 0) {
      console.warn(`${LOG} | ${item.name}: its save has ${ability ? "no DC" : "no ability"} ACE can read.`);
      return null;
    }
    const recipe = {
      ...rec.recipe,
      onFail: [{
        kind: "condition",
        condition: {
          key: "frightened",
          duration: presence.durationSeconds ?? null,
          ends: presence.repeats ? "a save at the end of each of its turns" : null,
        },
      }],
      onSuccess: [],
    };
    return { ability, dc, recipe, activityId: rec.recipe.source?.activity ?? null };
  }

  /* ═══ The picker ═══════════════════════════════════════════════════════ */

  /**
   * His rule: "Picker first: default is living creatures in 120 feet with line
   * of sight. He can tick and untick. Dead off the list."
   *
   * @returns {Promise<Array|null>} the ticked rows, or null if it was closed.
   */
  static async _pick(sourceDoc, item, presence, asked, spared) {
    const DialogV2 = globalThis.foundry?.applications?.api?.DialogV2;
    if (!DialogV2) {
      console.warn(`${LOG} | no dialog on this client, so everyone in range is asked.`);
      return asked;
    }
    const line = (r) => `
      <label class="ace-fp-row">
        <input type="checkbox" name="who" value="${esc(r.doc.id)}" checked />
        <img src="${esc(r.img ?? "icons/svg/mystery-man.svg")}" alt="" />
        <span class="ace-fp-name">${esc(r.name)}</span>
        <span class="ace-fp-ft">${r.ft == null ? "" : `${r.ft} ft`}</span>
      </label>`;
    const sparedLine = spared.length
      ? `<div class="ace-fp-spared"><i class="fas fa-shield-halved"></i> No save: `
        + spared.map(r => `<b>${esc(r.name)}</b> (${esc(r.skip.reason)})`).join(", ") + `</div>`
      : "";

    const content = `
      <style>
        .ace-fp { color: #f0e4c0; font-family: 'Signika', sans-serif; }
        .ace-fp .ace-fp-head { font-size: 16px; line-height: 1.4; margin-bottom: 8px; }
        .ace-fp .ace-fp-list { display: flex; flex-direction: column; gap: 2px; max-height: 320px; overflow-y: auto;
          border: 1px solid rgba(212,175,55,0.25); border-radius: 4px; padding: 4px; background: #121016; }
        .ace-fp .ace-fp-row { display: flex; align-items: center; gap: 8px; padding: 4px 6px; border-radius: 3px; font-size: 16px; }
        .ace-fp .ace-fp-row:hover { background: rgba(212,175,55,0.10); }
        .ace-fp .ace-fp-row img { width: 34px; height: 34px; border-radius: 5px; object-fit: cover; border: 1px solid #555; }
        .ace-fp .ace-fp-name { flex: 1; font-weight: 600; overflow-wrap: anywhere; }
        .ace-fp .ace-fp-ft { color: #c9a76b; font-size: 14px; white-space: nowrap; }
        .ace-fp .ace-fp-spared { margin-top: 8px; font-size: 14px; color: #ffaa44; line-height: 1.4; }
        .ace-fp .ace-fp-all { margin: 6px 0 2px; font-size: 14px; color: #c9a76b; cursor: pointer; }
      </style>
      <div class="ace-fp">
        <div class="ace-fp-head"><b>${esc(sourceDoc.name)}</b>'s <b>${esc(item.name)}</b>:
          everyone within ${presence.radiusFt} feet${presence.needsSight ? " who can see it" : ""}.
          Untick anyone it spares.</div>
        <div class="ace-fp-all"><a data-ace-fp="all">Tick all</a> · <a data-ace-fp="none">Untick all</a></div>
        <div class="ace-fp-list">${asked.map(line).join("")}</div>
        ${sparedLine}
      </div>`;

    try {
      const chosen = await DialogV2.wait({
        window: { title: `${item.name}`, icon: "fa-solid fa-face-scream" },
        classes: ["ace-qol-dark-dialog"],
        position: { width: 420 },
        content,
        buttons: [
          { action: "go", label: "Frighten them", icon: "fa-solid fa-face-scream", default: true,
            callback: (ev, btn) => [...btn.form.elements.who ?? []].filter(c => c.checked).map(c => c.value) },
          { action: "no", label: "Nobody", icon: "fa-solid fa-xmark", callback: () => [] },
        ],
        render: (ev, html) => {
          const root = html?.element ?? html;
          root?.querySelector?.("[data-ace-fp='all']")?.addEventListener("click", () => {
            for (const c of root.querySelectorAll("input[name='who']")) c.checked = true;
          });
          root?.querySelector?.("[data-ace-fp='none']")?.addEventListener("click", () => {
            for (const c of root.querySelectorAll("input[name='who']")) c.checked = false;
          });
        },
        rejectClose: false,
      });
      if (chosen == null) return null;
      const ids = new Set(Array.isArray(chosen) ? chosen : []);
      return asked.filter(r => ids.has(r.doc.id));
    } catch (err) {
      console.warn(`${LOG} | the picker failed, so nobody was asked:`, err);
      return null;
    }
  }

  /* ═══ Being done with it ═══════════════════════════════════════════════ */

  /** Is this creature already frightened by THIS creature's presence? */
  static isFrightenedByIt(target, sourceDoc, item) {
    const name = String(item?.name ?? "").toLowerCase();
    return (target?.effects?.contents ?? []).some(e => {
      if (e.disabled) return false;
      const p = e.flags?.[MODULE_ID]?.presence;
      return !!p && p.sourceTokenId === sourceDoc.id && String(p.itemName ?? "").toLowerCase() === name;
    });
  }

  /** The 24-hour immunity, if it is on this creature and still standing. */
  static immunityOn(target, sourceDoc, item) {
    const name = String(item?.name ?? "").toLowerCase();
    const now = Number(game.time?.worldTime ?? 0);
    for (const e of target?.effects?.contents ?? []) {
      const im = e.flags?.[MODULE_ID]?.presenceImmunity;
      if (!im) continue;
      if (im.sourceActorId !== (sourceDoc.actor?.id ?? null)) continue;
      if (String(im.itemName ?? "").toLowerCase() !== name) continue;
      // ⚠️ AN EXPIRED MARK IS NOT AN ANSWER. Foundry expires an effect's
      // duration on its own clock; this one is measured in a day of world time,
      // which a long rest jumps straight past.
      if (Number.isFinite(im.until) && now >= im.until) {
        e.delete().catch(() => { /* gone already */ });
        continue;
      }
      return e;
    }
    return null;
  }

  /**
   * "If a creature's saving throw is successful, or the effect ends for it, the
   * creature is immune to this creature's presence for the next 24 hours."
   */
  static async _immunise(target, mark, why) {
    try {
      if (!target || !mark?.immuneHours) return null;
      const scene = game.scenes?.get(mark.sceneId) ?? canvas?.scene ?? null;
      const sourceDoc = scene?.tokens?.get(mark.sourceTokenId) ?? null;
      if (sourceDoc && PresenceEngine.immunityOn(target, sourceDoc, { name: mark.itemName })) return null;
      const seconds = Number(mark.immuneHours) * 3600;
      const now = Number(game.time?.worldTime ?? 0);
      const [made] = await target.createEmbeddedDocuments("ActiveEffect", [{
        name: `Immune: ${mark.sourceName}'s ${mark.itemName}`,
        img: "icons/svg/shield.svg",
        origin: mark.itemUuid ?? null,
        disabled: false,
        transfer: false,
        duration: { seconds, startTime: now },
        description: `${mark.sourceName}'s ${mark.itemName} cannot frighten this creature again `
          + `for ${mark.immuneHours} hours (${why}).`,
        flags: { [MODULE_ID]: { presenceImmunity: {
          sourceActorId: mark.sourceActorId ?? null,
          sourceTokenId: mark.sourceTokenId ?? null,
          itemName: mark.itemName,
          until: now + seconds,
          why,
        } } },
      }]);
      say(`${target.name} is immune to ${mark.sourceName}'s ${mark.itemName} for `
        + `${mark.immuneHours} hours (${why}).`);
      return made ?? null;
    } catch (err) {
      console.warn(`${LOG} | could not make ${target?.name} immune:`, err);
      return null;
    }
  }

  /** The save engine hands every resolved row back here, once the dice are in. */
  static async afterSaves(presenceFlag, results) {
    if (game.users?.activeGM !== game.user) return;
    if (!presenceFlag?.immuneHours) return;
    const scene = canvas?.scene ?? null;
    for (const r of results ?? []) {
      if (r?.pending || r?.noRoll || r?.passed !== true) continue;
      const target = scene?.tokens?.get(r.tokenDocId)?.actor ?? game.actors?.get(r.actorId) ?? null;
      if (!target) continue;
      await PresenceEngine._immunise(target, { ...presenceFlag, sceneId: scene?.id ?? null }, "it made the save");
    }
  }
}
