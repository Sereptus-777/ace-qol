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
// Where a pop-up opens, so three boxes never land on the same spot.
import { stepAside } from "./popup-place.mjs";

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
    Hooks.on("deleteActiveEffect", (effect, options = {}) => {
      if (game.users?.activeGM !== game.user) return;
      const mark = effect?.flags?.[MODULE_ID]?.presence;
      if (!mark?.sourceTokenId) return;
      // ⚠️ A CONDITION BEING REPLACED HAS NOT ENDED (his table, 2026-09-20).
      // The condition door deletes the old Frightened before placing a fresh
      // one, and this watch was reading every one of those as "the fear ended"
      // and writing the 24-hour immunity on a creature that is still afraid.
      if (options?.aceReplacing) {
        console.debug(`${LOG} | ${effect.parent?.name}'s fear was replaced, not ended — no immunity written.`);
        return;
      }
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

      // ⚠️🔴 THE CLAIM IS TAKEN BEFORE ANYTHING IS AWAITED (his table,
      // 2026-09-20: one Nothic frightened three times, a Specter four).
      // `combatStart` and `combatTurnChange` both fire when a fight begins, and
      // `createToken` can land in the same tick. Each one read the combat's
      // flag, found nothing, and went off to await writing it — so two or three
      // presences ran, each posting its own card and each frightening the room
      // again. A flag written after an await cannot stop the caller that is
      // already past the read. The same lesson as the save engine's dedupe.
      // ⚠️🔴 ONCE PER FIGHT FOR THAT DRAGON — THE KEY IS THE CREATURE, NOT ITS
      // TOKEN (his table, 2026-09-20: "He advanced the turn. Presence opened
      // again and the log printed 'its first turn began, so it happens once,
      // now'. The once-per-fight flag is a lie."). He had two bodies of the
      // dragon on the map, each its own combatant; keyed by token, the second
      // one's turn was a fresh claim and it asked the room all over again.
      // Its ACTOR is the dragon, however many tokens of it are standing there.
      const who = tokenDoc.actor?.id ?? tokenDoc.actorId ?? tokenDoc.id;
      const key = `${who}:${item.id}`;
      if (!PresenceEngine._claimedIn(combat, key)) continue;

      say(`${tokenDoc.name}'s ${item.name}: ${why}, so it happens once, now.`);
      await PresenceEngine.run(tokenDoc, item, presence, { why, claim: { combat, key } });
    }
  }

  /**
   * Claim this creature's presence for this fight, in THIS tick.
   *
   * ⚠️ MEMORY FIRST, THE DOCUMENT AFTER. `combatStart`, `combatTurnChange` and
   * `createToken` can all fire before any of them has finished writing a flag,
   * so a claim that only lived on the combat let two or three presences run —
   * each posting its own card, each frightening the room, and each sending its
   * own box to the same player (whose answer then belonged to a card nobody was
   * looking at). The Set answers in the same tick; the flag survives a reload.
   *
   * @returns {boolean} true if this caller owns the run
   */
  static _claimedIn(combat, key) {
    PresenceEngine._claimed ??= new Set();
    const full = `${combat?.id ?? "no-combat"}:${key}`;
    if (PresenceEngine._claimed.has(full)) return false;
    const fired = combat?.getFlag?.(MODULE_ID, "presenceFired") ?? {};
    if (fired[key]) return false;
    PresenceEngine._claimed.add(full);
    combat?.setFlag?.(MODULE_ID, "presenceFired", { ...fired, [key]: true })
      ?.catch?.(err => console.warn(`${LOG} | the fight could not remember that ${key} has happened:`, err));
    return true;
  }

  /** Has this creature's presence already happened in this fight? */
  static _alreadyHappened(combat, key) {
    const full = `${combat?.id ?? "no-combat"}:${key}`;
    return (PresenceEngine._claimed?.has(full) ?? false)
      || !!(combat?.getFlag?.(MODULE_ID, "presenceFired") ?? {})[key];
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
    // ⚠️ A CREATURE DOES NOT FRIGHTEN ITSELF, AND ONE TOKEN ID IS NOT ENOUGH
    // (his table, 2026-09-20). A press measures from whichever body ACE found
    // for the caster, and an unlinked token, a second copy on the map or a
    // token replaced mid-fight all give that a different id from the row being
    // judged. Its actor answers where its token id cannot.
    if (targetDoc.id === sourceDoc.id
        || (target.id && sourceDoc.actor?.id && target.id === sourceDoc.actor.id)
        || (targetDoc.actorId && sourceDoc.actorId && targetDoc.actorId === sourceDoc.actorId)) {
      return { reason: "itself", label: "ITSELF", tone: "immune", hide: true };
    }
    // ⚠️ A TOKEN NOBODY CAN SEE IS NOT IN THE ROOM. A prepared dungeon map
    // carries dozens of hidden creatures waiting for later scenes, and every
    // one of them was being asked to save against a dragon it has not met.
    if (targetDoc.hidden === true) {
      return { reason: "not on the map yet (hidden)", hide: true, tone: "blocked",
        label: "HIDDEN — not in play" };
    }
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

  /**
   * Is this creature on the source's own side?
   *
   * ⚠️ ITS WORDS SAY WHOSE CHOICE IT IS. "Each creature of the dragon's choice
   * that is within 120 feet" — a dragon does not frighten its own cultists, and
   * on a dungeon level his 120 feet reached 27 creatures, most of them the
   * dragon's own (his table, 2026-09-20: "First firing asked far more than the
   * five other combatants"). They stay ON the list, with their reason, and he
   * ticks any he wants; they are simply not ticked for him.
   */
  static _sameSide(targetDoc, sourceDoc) {
    const side = (d) => {
      const n = Number(d?.disposition ?? 0);
      return n < 0 ? -1 : n > 0 ? 1 : 0;
    };
    return side(targetDoc) === side(sourceDoc);
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
      // Its own side is asked only if he ticks them, and only where the words
      // make it the creature's choice who is caught.
      const ally = !skip && presence.choice && PresenceEngine._sameSide(t, sourceDoc);
      rows.push({ doc: t, name: t.name, img: t.texture?.src ?? t.actor?.img ?? null, ft, skip, ally });
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
  static async run(sourceDoc, item, presence, { why = "", pressed = false, claim = null } = {}) {
    const source = sourceDoc?.actor;
    if (!source) return;
    if (SOURCE_OUT.some(s => source.statuses?.has?.(s))) {
      say(`${sourceDoc.name}'s ${item.name}: nothing. It is in no state to frighten anyone.`);
      ui.notifications?.info(`${sourceDoc.name} is in no state to frighten anyone.`);
      return;
    }

    // ⚠️ ONE RUN, ONE NAME (his rule, 2026-09-20: "Same cast id on the picker
    // and the card"). Everything this run posts carries it, so a result that
    // arrives early can be matched to the row it belongs to, and the console
    // reads as one story instead of several that look alike.
    const runId = `fp-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e4)}`;
    const rows = PresenceEngine._read(sourceDoc, item, presence);
    const asked = rows.filter(r => !r.skip);
    const ticked = asked.filter(r => !r.ally);
    // On the card but not rolling: the two his rule names, so he can see them.
    const spared = rows.filter(r => r.skip && !r.skip.hide);
    const offList = rows.filter(r => r.skip?.hide && r.skip.reason !== "itself" && r.skip.reason !== "no creature");

    say(`[${runId}] ${sourceDoc.name}'s ${item.name}${why ? ` (${why})` : ""}: ${ticked.length} ticked of `
      + `${asked.length} on the list (${asked.length - ticked.length} on its own side), `
      + `${spared.length} already done with it, ${offList.length} off the list `
      + `(${[...new Set(offList.map(r => r.skip.reason))].join("; ") || "none"}).`);

    if (!asked.length && !spared.length) {
      ui.notifications?.info(`${sourceDoc.name}'s ${item.name}: nobody in ${presence.radiusFt} feet `
        + `${presence.needsSight ? "can see it" : "is near it"}, so nobody rolls.`);
      return;
    }

    // ── The picker, first, every time ──
    const picked = await PresenceEngine._pick(sourceDoc, item, presence, asked, spared);
    // ⚠️ AND THE CLAIM IS ASKED AGAIN ON THE WAY OUT. The picker is a human
    // holding the door open; anything that fires while it is open must not slip
    // a second card past it.
    if (claim && !PresenceEngine._alreadyHappened(claim.combat, claim.key)) {
      say(`${sourceDoc.name}'s ${item.name}: the fight no longer says this has happened, so it stands down.`);
      return;
    }
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

    say(`[${runId}] ${picked.length} creature(s) were ticked, so ${picked.length === 1 ? "it rolls" : "they roll"}: `
      + `${picked.map(r => r.name).join(", ") || "nobody"}.`);
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
        runId,
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
  static async _pick(sourceDoc, item, presence, rows, spared) {
    const DialogV2 = globalThis.foundry?.applications?.api?.DialogV2;
    if (!DialogV2) {
      console.warn(`${LOG} | no dialog on this client, so everyone the door allows is asked.`);
      return rows.filter(r => !r.ally);
    }

    // ⚠️🔴 EVERY SIZE IS WRITTEN ON THE ELEMENT (his table, 2026-09-20:
    // "Picker portraits are full token art, screen-tall, not 80 pixels.
    // Nameless checkboxes. Names run into the distance number.").
    //
    // The first version put its rules in a <style> block inside the dialog's
    // content, and not one of them reached the rows: the portraits came out at
    // the natural size of his token art, the layout was gone with them, and a
    // list he cannot read is a list he cannot use. A style block that may or
    // may not survive its host is not a size. These are inline, so the row is
    // 80 pixels whatever the dialog does to it.
    const ROW = "display:flex;align-items:center;gap:12px;padding:5px 8px;border-radius:4px;"
      + "font-size:17px;color:#f0e4c0;cursor:pointer;";
    const IMG = "width:80px;height:80px;min-width:80px;max-width:80px;border-radius:6px;"
      + "object-fit:cover;border:1px solid #555;background:#0c0c10;display:block;flex:0 0 80px;";
    const BOX = "width:20px;height:20px;min-width:20px;flex:0 0 20px;margin:0;";
    const NAME = "flex:1 1 auto;font-weight:600;overflow-wrap:anywhere;min-width:0;";
    const FT = "flex:0 0 auto;color:#c9a76b;font-size:15px;white-space:nowrap;padding-left:10px;";
    // ⚠️ AND THE LIST SCROLLS INSIDE THE DIALOG, so 30 creatures cannot make
    // the window taller than his screen.
    const LIST = "display:flex;flex-direction:column;gap:3px;max-height:420px;overflow-y:auto;"
      + "border:1px solid rgba(212,175,55,0.25);border-radius:4px;padding:5px;background:#121016;";

    const line = (r) => `
      <label style="${ROW}">
        <input type="checkbox" name="who" value="${esc(r.doc.id)}" style="${BOX}" ${r.ally ? "" : "checked"} />
        <img src="${esc(r.img ?? "icons/svg/mystery-man.svg")}" alt="" style="${IMG}" />
        <span style="${NAME}">${esc(r.name)}${r.ally
          ? ` <span style="color:#8a8a92;font-weight:400;font-size:14px;">(its own side)</span>` : ""}</span>
        <span style="${FT}">${r.ft == null ? "" : `${r.ft} ft`}</span>
      </label>`;

    // ⚠️ ONE NAME, ONE REASON (his rule). The same creature can be reached by
    // two rows when two of its bodies are on the map; the line under the list
    // names each creature once.
    const seen = new Set();
    const sparedOnce = [];
    for (const r of spared) {
      const k = `${r.name}|${r.skip.reason}`;
      if (seen.has(k)) continue;
      seen.add(k);
      sparedOnce.push(r);
    }
    const sparedLine = sparedOnce.length
      ? `<div style="margin-top:8px;font-size:15px;color:#ffaa44;line-height:1.4;">`
        + `<i class="fas fa-shield-halved"></i> Already done with it, not asked: `
        + sparedOnce.map(r => `<b>${esc(r.name)}</b> (${esc(r.skip.reason)})`).join(", ") + `</div>`
      : "";

    const ticked = rows.filter(r => !r.ally).length;
    const content = `
      <div class="ace-fp" style="color:#f0e4c0;font-family:'Signika',sans-serif;">
        <div style="font-size:16px;line-height:1.4;margin-bottom:8px;">
          <b>${esc(sourceDoc.name)}</b>'s <b>${esc(item.name)}</b>:
          <b class="ace-fp-count">${ticked}</b> of ${rows.length} ticked, within ${presence.radiusFt} feet${
            presence.needsSight ? " and able to see it" : ""}. Tick and untick as you like.</div>
        <div style="margin:6px 0 4px;font-size:15px;color:#c9a76b;">
          <a data-ace-fp="all" style="cursor:pointer;">Tick all</a> &middot;
          <a data-ace-fp="none" style="cursor:pointer;">Untick all</a></div>
        <div style="${LIST}">${rows.map(line).join("")}</div>
        ${sparedLine}
      </div>`;

    try {
      const chosen = await DialogV2.wait({
        window: { title: `${sourceDoc.name}: ${item.name}`, icon: "fa-solid fa-face-scream" },
        classes: ["ace-qol-dark-dialog"],
        position: { width: 480, ...stepAside() },
        content,
        buttons: [
          { action: "go", label: "Frighten them", icon: "fa-solid fa-face-scream", default: true,
            callback: (ev, btn) => [...btn.form.elements.who ?? []].filter(c => c.checked).map(c => c.value) },
          { action: "no", label: "Nobody", icon: "fa-solid fa-xmark", callback: () => [] },
        ],
        render: (ev, html) => {
          const root = html?.element ?? html;
          const count = root?.querySelector?.(".ace-fp-count");
          const boxes = [...(root?.querySelectorAll?.("input[name='who']") ?? [])];
          const retell = () => { if (count) count.textContent = String(boxes.filter(b => b.checked).length); };
          for (const b of boxes) b.addEventListener("change", retell);
          root?.querySelector?.("[data-ace-fp='all']")?.addEventListener("click", () => {
            for (const c of boxes) c.checked = true; retell();
          });
          root?.querySelector?.("[data-ace-fp='none']")?.addEventListener("click", () => {
            for (const c of boxes) c.checked = false; retell();
          });
        },
        rejectClose: false,
      });
      if (chosen == null) return null;
      const ids = new Set(Array.isArray(chosen) ? chosen : []);
      return rows.filter(r => ids.has(r.doc.id));
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
