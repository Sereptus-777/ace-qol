// ─── ACE: QOL — Gaze Engine: a gaze at the start of a creature's turn ─────────
//
// Johnny, 2026-09-19: "PETRIFYING GAZE. This used to work. It does not now.
// Restore it. Start of a creature's turn, in range, can see the gazer: CON save.
// Fail: Restrained (or what that copy's words say). Second fail while still
// restrained: Petrified. Avert eyes if the words give that choice — box to the
// target's owner. Blinded / dead / cannot see: no save. Same recipe + condition
// door as everything else."
//
// ⚠️🔴 WHY IT STOPPED. This engine was switched off on 2026-07-24 because it
// gazed every creature near the basilisk, an untargeted second Ogre included,
// and collided with the pressed gaze item. It stayed off, so a 2014 basilisk or
// medusa did nothing at the start of anyone's turn. It is back, rebuilt:
//
//   • WHICH ITEMS: the ones whose WORDS say "starts its turn within 30 feet of
//     the basilisk ... can force it to make a saving throw" (rules/creature-
//     words.mjs), never a name list. A 2024 copy is a pressed cone and never
//     fires here.
//   • WHO: the gazer "can force" the save, so it is the gazer's choice, and it
//     never turns its own side to stone (the Ogre). Hostile to it, in range,
//     alive, and, where the words ask, the two of them able to see each other.
//   • THE SAVE: the same save card every press posts, with the gaze item's own
//     recipe, marked to resolve itself. A player rolls their own save on their
//     own card; an NPC rolls at once. The save engine's staging does the rest:
//     Restrained now, the repeat save at the end of its next turn, Petrified on
//     a second failure (and "fails by 5 or more" straight to stone, where the
//     words say it), all through the condition door.
//   • AVERTING: where the words give the choice and the creature is not
//     surprised, its owner is asked first, through the one reaction door. A
//     creature that looks away does not save and cannot see the gazer until the
//     start of its next turn (Situation.canSee reads the mark).
//
// ⚠️ THE OLD CHECK OF SIGHT NEVER READ BLINDNESS. It handed Situation.canSee two
// TOKENS where it takes two creatures, so a blinded victim still "saw" the
// basilisk. The creatures go in now, with their tokens beside them.
// ──────────────────────────────────────────────────────────────────────────────

import { aceDistanceFt } from "./geometry-utils.mjs";
import { Situation } from "./situation.mjs";
import { readTurnGaze } from "./rules/creature-words.mjs";
import { lifeStateOf, pickable } from "./road/picker-rule.mjs";

const MODULE_ID = "ace-qol";
const LOG = "ace-qol | gaze";
const say = (msg) => console.log(`${LOG} | ${msg}`);

/** A gazer in any of these cannot force anything ("if the basilisk isn't incapacitated"). */
const GAZER_OUT = ["incapacitated", "paralyzed", "petrified", "stunned", "unconscious", "dead"];

/** The flag a creature that looked away carries: the gazers' token ids. */
export const AVERT_FLAG = "avertEyesFrom";

export class GazeEngine {

  static init() {
    if (this._initialized) return;
    this._initialized = true;
    // ⚠️ NOT `combatTurn`. It fires before the update, while the creature whose
    // turn is ENDING is still the combatant (audit F-022, 2026-08-07).
    // `combatTurnChange` hands over the turn that is beginning.
    Hooks.on("combatTurnChange", (combat, prior, current) => {
      GazeEngine._onTurnStart(combat, current).catch(err =>
        console.warn(`${LOG} | the start-of-turn gaze failed; nothing was put on anyone:`, err));
    });
    // A creature that looked away stops looking away when the fight ends.
    Hooks.on("deleteCombat", (combat) => {
      if (game.users?.activeGM !== game.user) return;
      for (const c of combat?.combatants ?? []) {
        GazeEngine._clearAverted(c.actor).catch(() => {});
      }
    });
    console.debug(`${LOG} | online: start-of-turn gazes fire from their own words.`);
  }

  /** The creature whose turn is beginning meets every gaze its words reach it with. */
  static async _onTurnStart(combat, current = null) {
    if (game.users?.activeGM !== game.user) return;
    if (!combat?.started) return;
    const combatant = current?.combatantId ? combat.combatants?.get(current.combatantId) : combat.combatant;
    const victimDoc = combatant?.token ?? null;
    const victim = victimDoc?.actor ?? null;
    if (!victimDoc || !victim) return;

    // "It can't see the basilisk until the start of its next turn, when it can
    // avert its eyes again": whatever it looked away from, it is looking again.
    await GazeEngine._clearAverted(victim);

    const scene = victimDoc.parent ?? canvas?.scene ?? null;
    const gazes = [];
    for (const g of scene?.tokens?.contents ?? []) {
      if (!g?.actor || g.id === victimDoc.id) continue;
      for (const item of g.actor.items ?? []) {
        const gaze = readTurnGaze(item);
        if (gaze) gazes.push({ gazerDoc: g, item, gaze });
      }
    }
    if (!gazes.length) return;

    if (!pickable("harm", lifeStateOf(victim, victimDoc)).ok) {
      say(`${victimDoc.name} is dead, so no gaze reaches it.`);
      return;
    }
    if (victim.statuses?.has?.("petrified")) {
      say(`${victimDoc.name} is already stone.`);
      return;
    }
    for (const { gazerDoc, item, gaze } of gazes) {
      await GazeEngine._attempt(victimDoc, gazerDoc, item, gaze);
    }
  }

  /** One gazer's gaze at one creature starting its turn. Says why whenever it does nothing. */
  static async _attempt(victimDoc, gazerDoc, item, gaze) {
    const victim = victimDoc.actor;
    const gazer = gazerDoc.actor;
    const tag = `${gazerDoc.name}'s ${item.name} on ${victimDoc.name}`;

    let ft = Infinity;
    try { ft = aceDistanceFt(gazerDoc, victimDoc); } catch (_) { ft = Infinity; }
    if (!(ft <= gaze.rangeFt + 0.1)) return;   // out of reach: not worth a line per creature per turn

    if (!pickable("harm", lifeStateOf(gazer, gazerDoc)).ok || GAZER_OUT.some(s => gazer.statuses?.has?.(s))) {
      say(`${tag}: nothing. ${gazerDoc.name} is dead or incapacitated, and its words need it able to act.`);
      return;
    }
    if (!GazeEngine._opposes(gazerDoc, victimDoc)) {
      say(`${tag}: nothing. ${victimDoc.name} is on its side, and the gaze is its to force or not.`);
      return;
    }
    if (GazeEngine._turningToStone(victim, item)) {
      say(`${tag}: ${victimDoc.name} is already turning to stone from it; the repeat save at the end of its turn decides.`);
      return;
    }
    if (gaze.needsSight) {
      const sees = Situation.canSee(victim, gazer, { viewerToken: victimDoc.object ?? victimDoc, subjectToken: gazerDoc.object ?? gazerDoc, distanceFt: ft });
      if (!sees?.canSee) {
        say(`${tag}: no save. ${victimDoc.name} cannot see ${gazerDoc.name} (${sees?.why ?? "unseen"}).`);
        return;
      }
      const seen = Situation.canSee(gazer, victim, { viewerToken: gazerDoc.object ?? gazerDoc, subjectToken: victimDoc.object ?? victimDoc, distanceFt: ft });
      if (!seen?.canSee) {
        say(`${tag}: no save. ${gazerDoc.name} cannot see ${victimDoc.name} (${seen?.why ?? "unseen"}).`);
        return;
      }
    }

    // ── Averting its eyes: the owner's choice, where the words give it ──
    if (gaze.avert) {
      if (GazeEngine._surprised(victimDoc)) {
        say(`${tag}: ${victimDoc.name} is surprised, so it cannot avert its eyes.`);
      } else if (await GazeEngine._asksToAvert(victimDoc, gazerDoc, item)) {
        await GazeEngine._avert(victimDoc, gazerDoc, item);
        return;
      }
    }

    // ── The save, on the one save card, resolving itself ──
    const eng = game.aceQol?.saveEngine;
    if (typeof eng?.postSaveCard !== "function") {
      console.warn(`${LOG} | ${tag}: the save engine is not on the API, so no save was asked.`);
      return;
    }
    let rec = null;
    try {
      const { recipesFor } = await import("./inference/recipe.mjs");
      rec = (recipesFor(item, { actor: gazer }) ?? []).find(r => r?.recipe?.decidedBy?.kind === "save") ?? null;
    } catch (err) {
      console.warn(`${LOG} | could not read ${item.name}'s recipe:`, err);
    }
    if (!rec) {
      say(`${tag}: its words force a save, and its item carries no save ACE can read, so none was asked.`);
      return;
    }
    const dc = GazeEngine._saveDC(rec.recipe, item);
    const ability = String(rec.recipe.decidedBy?.ability ?? "").toLowerCase();
    if (!ability || !Number.isFinite(dc)) {
      say(`${tag}: its save has ${ability ? "no DC" : "no ability"} ACE can read, so none was asked.`);
      return;
    }
    say(`${tag}: ${victimDoc.name} starts its turn ${Math.round(ft)} feet away, and the two can see each other: `
      + `${ability.toUpperCase()} DC ${dc} save.`);
    await eng.postSaveCard(item, gazer, [victimDoc.object ?? victimDoc], {
      saveAbility: ability,
      saveDC: dc,
      isSpell: false,
      recipe: rec.recipe,
      activityId: rec.recipe.source?.activity ?? null,
      skipDelay: true,
      autoResolve: true,
      trigger: "start-of-turn",
    });
  }

  /* ═══ Averting ═════════════════════════════════════════════════════════ */

  /** Ask whoever decides for the creature, through the one reaction door. */
  static async _asksToAvert(victimDoc, gazerDoc, item) {
    const door = game.aceQol?.reactionEngine;
    if (typeof door?._promptReaction !== "function") {
      console.warn(`${LOG} | the reaction engine is not on the API, so ${victimDoc.name} could not be asked to avert its eyes; it meets the gaze.`);
      return false;
    }
    try {
      const res = await door._promptReaction({
        type: "avertEyes",
        title: "Avert your eyes",
        heading: item.name,
        icon: "fa-eye-slash",
        accentColor: "#8a7a4f",
        reactorActor: victimDoc.actor,
        reactorToken: victimDoc.object ?? null,
        attackerName: gazerDoc.name,
        attackerImg: gazerDoc.texture?.src ?? gazerDoc.actor?.img ?? null,
        description: `${gazerDoc.name}'s eyes are on you. Look away and you do not have to save, `
          + `but you cannot see ${gazerDoc.name} until the start of your next turn.`,
        acceptLabel: "Avert my eyes",
        declineLabel: "Meet its gaze",
      });
      return !!res?.accepted;
    } catch (err) {
      console.warn(`${LOG} | the avert box for ${victimDoc.name} failed, so it meets the gaze:`, err);
      return false;
    }
  }

  /** It looked away: no save, and it cannot see the gazer until its next turn starts. */
  static async _avert(victimDoc, gazerDoc, item) {
    const victim = victimDoc.actor;
    try {
      const mine = (victim.effects?.contents ?? []).find(e => Array.isArray(e.flags?.[MODULE_ID]?.[AVERT_FLAG]));
      if (mine) {
        const ids = [...new Set([...mine.flags[MODULE_ID][AVERT_FLAG], gazerDoc.id])];
        await mine.update({ [`flags.${MODULE_ID}.${AVERT_FLAG}`]: ids });
      } else {
        await victim.createEmbeddedDocuments("ActiveEffect", [{
          name: "Averting its eyes",
          img: "icons/svg/blind.svg",
          origin: item.uuid ?? null,
          disabled: false,
          transfer: false,
          duration: { rounds: 1 },
          description: `Looking away from ${gazerDoc.name}: no save against its ${item.name}, and it cannot be `
            + `seen until the start of this creature's next turn.`,
          flags: { [MODULE_ID]: { [AVERT_FLAG]: [gazerDoc.id] } },
        }]);
      }
      say(`${victimDoc.name} averts its eyes from ${gazerDoc.name}: no save, and it cannot see ${gazerDoc.name} until the start of its next turn.`);
      const { CardDoor } = await import("./road/doors.mjs");
      await CardDoor.post({
        speaker: ChatMessage.getSpeaker({ alias: victimDoc.name }),
        content: `<div style="border-left:3px solid #8a7a4f;padding:6px 10px;font-size:16px;line-height:1.4;">`
          + `<b>${esc(victimDoc.name)}</b> averts their eyes from <b>${esc(gazerDoc.name)}</b>: no save against `
          + `${esc(item.name)}, and they cannot see ${esc(gazerDoc.name)} until the start of their next turn.</div>`,
        flags: { [MODULE_ID]: { type: "avertEyes" } },
      });
    } catch (err) {
      console.warn(`${LOG} | ${victimDoc.name} averted its eyes, and the mark could not be put on it:`, err);
    }
  }

  /** Take the look-away mark off: its next turn has begun, or the fight is over. */
  static async _clearAverted(actor) {
    if (!actor) return;
    const marks = (actor.effects?.contents ?? []).filter(e => Array.isArray(e.flags?.[MODULE_ID]?.[AVERT_FLAG]));
    for (const e of marks) {
      try { await e.delete(); }
      catch (err) { if (!/does not exist/i.test(String(err?.message ?? err))) console.warn(`${LOG} | could not take the look-away mark off ${actor.name}:`, err); }
    }
  }

  /* ═══ Helpers ══════════════════════════════════════════════════════════ */

  /** Already turning to stone from this gaze: the save engine's staged restraint, by the gaze's name. */
  static _turningToStone(actor, item) {
    const name = String(item?.name ?? "").toLowerCase();
    return (actor?.effects?.contents ?? []).some(e => {
      if (e.disabled) return false;
      const rs = e.flags?.[MODULE_ID]?.repeatingSave;
      return rs?.onFailureApply === "petrified" && String(rs?.spellName ?? "").toLowerCase() === name;
    });
  }

  /** On different sides: dispositions differ (secret counts as hostile). */
  static _opposes(a, b) {
    const side = (d) => {
      const n = Number(d?.disposition ?? 0);
      return n < 0 ? -1 : n > 0 ? 1 : 0;
    };
    return side(a) !== side(b);
  }

  /** "A creature that isn't surprised can avert its eyes": the same surprise read combat-state uses. */
  static _surprised(tokenDoc) {
    const a = tokenDoc?.actor;
    const c = game.combat?.combatants?.find?.(x => x.tokenId === tokenDoc?.id) ?? null;
    return a?.statuses?.has?.("surprised") === true || a?.statuses?.has?.("surprise") === true
      || c?.flags?.dnd5e?.surprised === true || c?.flags?.core?.surprised === true
      || tokenDoc?.getFlag?.(MODULE_ID, "surprised") === true;
  }

  /** The save's DC as a number: the recipe's, else the live activity's worked-out one. */
  static _saveDC(recipe, item) {
    const n = Number(recipe?.decidedBy?.dc);
    if (Number.isFinite(n) && n > 0) return n;
    const acts = item?.system?.activities;
    const list = acts ? [...(acts.values?.() ?? Object.values(acts))] : [];
    const id = recipe?.source?.activity ?? null;
    const act = (id ? list.find(a => (a?.id ?? a?._id) === id) : null) ?? list.find(a => a?.save);
    const v = Number(act?.save?.dc?.value ?? act?.save?.dc?.formula);
    return Number.isFinite(v) && v > 0 ? v : NaN;
  }
}

function esc(s) {
  return globalThis.foundry?.utils?.escapeHTML ? foundry.utils.escapeHTML(String(s ?? "")) : String(s ?? "");
}
