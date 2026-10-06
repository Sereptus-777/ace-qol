// ─── ACE: QOL — THE TURN OF A CREATURE THAT IS HELD ──────────────────────────
//
// His order, 2026-10-04:
//
//   "On the turn of a creature that is Grappled or Restrained, run this in
//    order. The turn starts with the squeeze, if the hold still carries one.
//    Roll the bludgeoning and the acid through the dice hook. Post that card
//    only after the dice land.
//
//    Then one popup on that creature: Attack, or Escape check. Attack swings at
//    disadvantage while it is Restrained, and that spends the action. Escape
//    rolls Athletics against the hold's DC through the same dice hook, the card
//    waits for the dice, and that spends the action. A success ends the hold. A
//    failure leaves it on.
//
//    A move by the GM or the player opens the same popup and does not move the
//    token. Print the choice it was given and which one it took."
//
// ⚠️🔴 THIS REVERSES THE 2026-09-29 RULE, DELIBERATELY. That day a grapple
// escape "asked nobody": the engine rolled the better of Athletics and
// Acrobatics at the start of the turn and whispered the answer, and the stamp
// still carries `auto: true` from it. It asks now, because the creature has a
// real choice to make with the same action — swing at it or get out — and
// rolling the escape for them took that choice away. Anything else holding a
// creature (Web, a net, the Entangling Rope) keeps its own prompt.
//
// ⚠️ THE SQUEEZE IS NOT THE OverTime ENGINE'S. A hold can carry two kinds at
// once (the bludgeoning and the acid), and that engine's flag holds one roll. So
// the dice this module throws are the hold's own list, thrown together, shown
// together, and posted as one card after they land.
// ──────────────────────────────────────────────────────────────────────────────

/* ⚠️🔴 ITS OWN CONSTANT, NOT ace-qol.mjs's. The entry file imports this one,
   so importing MODULE_ID back from it closes a cycle, and a top-level const read
   from a cyclic import is still in its temporal dead zone when this file loads:
   it throws on the way in and takes the WHOLE module with it. Written down on
   2026-08-28, done again on 09-06, and `cycle-check.py` caught this one before
   it ever ran. `restrained-movement.mjs` declares it the same way. */
const MODULE_ID = "ace-qol";
import { CardDoor } from "./road/doors.mjs";
import { awaitDiceSettle, safeShowForRoll } from "./dsn-utils.mjs";
import { explainCheck } from "./roll-formula.mjs";
import { escapeCardHtml } from "./escape-card.mjs";
import { isOutOfTheFight } from "./is-down.mjs";

const LOG = `${MODULE_ID} | held`;

/** The two things a held creature may do with its action, in his words. */
const CHOICES = [
  { id: "attack", label: "Attack", sub: "at disadvantage while Restrained", tone: "worse" },
  { id: "escape", label: "Escape check", sub: "Athletics against the hold", tone: "better" },
];

export class GrappleTurn {

  /* ── What is holding this creature ──────────────────────────────────────── */

  /**
   * Every hold on a creature: an effect ACE stamped with an escape.
   * @returns {ActiveEffect[]}
   */
  static holdsOn(actor) {
    return (actor?.effects?.contents ?? []).filter(e =>
      !e.disabled && Number(e.flags?.[MODULE_ID]?.breakFree?.dc) > 0);
  }

  /** Is this creature held at all, by its statuses? */
  static isHeld(actor) {
    const st = actor?.statuses;
    return !!(st?.has?.("grappled") || st?.has?.("restrained"));
  }

  /* ── 1. THE SQUEEZE ─────────────────────────────────────────────────────── */

  /**
   * The dice a hold deals at the start of the turn it still holds somebody.
   *
   * ⚠️ THROUGH THE DICE HOOK, AND THE CARD WAITS (his rule, and the suite's).
   * Every formula is thrown, all of them are shown, and the card is posted
   * through the door that will not let it land before they have.
   */
  static async squeeze(actor, hold) {
    const list = hold?.flags?.[MODULE_ID]?.squeeze;
    if (!Array.isArray(list) || !list.length) return null;
    const label = hold.flags[MODULE_ID].breakFree?.label ?? hold.name ?? "the hold";

    const rolled = [];
    for (const part of list) {
      const formula = String(part?.formula ?? "").trim();
      if (!formula) continue;
      try {
        const roll = await new Roll(formula).evaluate();
        safeShowForRoll(roll, `${label} — the squeeze`);
        rolled.push({ roll, total: roll.total, type: String(part.type ?? "bludgeoning") });
      } catch (err) {
        console.warn(`${LOG} | "${label}" could not roll ${formula} on ${actor?.name}:`, err);
      }
    }
    if (!rolled.length) return null;

    // ⚠️ NOTHING LANDS BEFORE THE DICE. Both of them, together, then the card.
    await awaitDiceSettle(15000);

    const rows = rolled.map(r =>
      `<div style="display:flex;align-items:baseline;gap:8px;">
         <b style="font-size:20px;color:#ff8a65;">${r.total}</b>
         <span style="font-size:15px;color:#e8e6d8;">${foundry.utils.escapeHTML(r.type)}</span>
         <span style="font-size:13px;color:#9a9080;">${foundry.utils.escapeHTML(r.roll.formula)}</span>
       </div>`).join("");
    await CardDoor.post({
      speaker: ChatMessage.getSpeaker({ actor }),
      content: `
        <div class="ace-qol-squeeze-card" style="border:1px solid #8d5524;border-radius:8px;padding:11px 13px;background:linear-gradient(180deg,#17110c,#0d0a08);font-family:'Signika',sans-serif;">
          <div style="color:#d9a066;font-weight:700;font-size:16px;margin-bottom:6px;">
            ${foundry.utils.escapeHTML(actor?.name ?? "It")} is crushed by ${foundry.utils.escapeHTML(label)}
          </div>
          ${rows}
        </div>`,
      flags: { [MODULE_ID]: { type: "squeeze", holdId: hold.id } },
    }, { dice: true });

    console.log(`${LOG} | the squeeze from "${label}" on ${actor?.name}: `
      + `${rolled.map(r => `${r.total} ${r.type}`).join(" and ")}, after its dice landed.`);
    return rolled;
  }

  /* ── 2. THE POPUP ───────────────────────────────────────────────────────── */

  /**
   * One popup: Attack, or Escape check. Returns the id taken, or null.
   *
   * ⚠️ PRINT THE CHOICE IT WAS GIVEN AND WHICH ONE IT TOOK (his rule). A box
   * that opens and closes with nothing in the log is the same as one that never
   * opened, which is the whole reason this file exists.
   */
  static async ask(actor, token, hold, { because = "its turn" } = {}) {
    const meta = hold?.flags?.[MODULE_ID]?.breakFree ?? {};
    const restrained = !!actor?.statuses?.has?.("restrained");
    const label = meta.label ?? hold?.name ?? "the hold";
    const choices = CHOICES.map(c => ({ ...c,
      sub: c.id === "attack"
        ? (restrained ? "at disadvantage while Restrained" : "it costs your action")
        : `Athletics against DC ${meta.dc}` }));

    console.log(`${LOG} | ${actor?.name} is held by "${label}" (${because}); offered: `
      + `${choices.map(c => c.label).join(" or ")}.`);

    let picked = null;
    try {
      /* ⚠️ THE ONE ON THE API, which is the live engine the rest of the suite
         talks to. Building a second here would open a box nothing else knows
         about, and the silence watch would call it a dead press. */
      const eng = game.aceQol?.reactionEngine ?? null;
      if (!eng) {
        console.warn(`${LOG} | the reaction engine is not on the API yet, so ${actor?.name} `
          + `was asked nothing. The hold stays and the action is not spent.`);
        return null;
      }
      const res = await eng._promptReaction({
        type: "heldTurn",
        title: "Held",
        heading: `${actor?.name ?? "You"} — held by ${label}`,
        icon: "fa-hand-fist",
        accentColor: "#9bcc4a",
        reactorActor: actor,
        reactorToken: token ?? null,
        attackerName: label,
        attackerImg: null,
        description: restrained
          ? "You are held fast. Swing at it, or spend your action trying to get out."
          : "You are held. Swing at it, or spend your action trying to get out.",
        gmNote: `Escape is DC ${meta.dc}. ${restrained ? "Attacks from it are at disadvantage." : ""}`,
        choices,
      });
      picked = res?.accepted ? (res.choiceData?.choice ?? null) : null;
    } catch (err) {
      console.warn(`${LOG} | the box for ${actor?.name} could not open, so nothing was asked:`, err);
      return null;
    }

    if (!picked) {
      console.log(`${LOG} | ${actor?.name} closed the box without choosing, so the hold stays `
        + `and the action is not spent.`);
      return null;
    }
    console.log(`${LOG} | ${actor?.name} chose ${picked === "escape" ? "the escape check" : "to attack"}.`);
    if (picked === "escape") await GrappleTurn.escape(actor, hold);
    else await GrappleTurn._spendAction(actor, "an attack while held");
    return picked;
  }

  /* ── 3. THE ESCAPE ──────────────────────────────────────────────────────── */

  /**
   * Athletics against the hold's DC, through the dice hook. A success ends the
   * hold: every condition that grab put on, by id, so nothing else is touched.
   */
  static async escape(actor, hold) {
    const meta = hold?.flags?.[MODULE_ID]?.breakFree ?? {};
    const dc = Number(meta.dc) || 10;
    const label = meta.label ?? hold?.name ?? "the hold";
    const skill = "ath";

    let roll = null;
    try {
      const r = await actor.rollSkill?.({ skill }, { configure: false }, { create: false });
      roll = Array.isArray(r) ? r[0] : r;
    } catch (_) { roll = null; }
    if (!roll) {
      const { parts, total } = explainCheck(actor, { skill });
      void parts;
      try { roll = await new Roll(`1d20 + ${total}`).evaluate(); }
      catch (err) {
        console.warn(`${LOG} | ${actor?.name}'s escape could not be rolled, so the hold stays:`, err);
        return false;
      }
    }
    safeShowForRoll(roll, "escape check");
    await awaitDiceSettle(15000);

    const die = roll.dice?.[0]?.total ?? null;
    const total = Number(roll.total);
    const passed = total >= dc;

    /* ⚠️ ONE BUILDER DRAWS THIS CARD (his four rows, 2026-10-04), and the
       net's escape in break-free-engine.mjs draws it with the same one. Nothing
       about how it looks is decided here, the colours included. */
    await CardDoor.post({
      speaker: ChatMessage.getSpeaker({ actor }),
      content: escapeCardHtml({
        name: actor?.name ?? "It", actorId: actor?.id ?? "",
        checkLabel: `${CONFIG.DND5E?.skills?.[skill]?.label ?? "Athletics"} check`,
        // The score behind the bonus, for his "2 + STR 4 = 6". Read off the
        // skill, because a table can move Athletics onto another one.
        ability: CONFIG.DND5E?.skills?.[skill]?.ability ?? "str",
        die, total, dc, passed, label,
      }),
      flags: { [MODULE_ID]: { type: "escapeResult", passed, dc } },
    }, { dice: true });

    await GrappleTurn._spendAction(actor, "an escape check");

    if (!passed) {
      console.log(`${LOG} | ${actor?.name} rolled ${total} against DC ${dc}: "${label}" holds.`);
      return false;
    }

    /* ⚠️ EVERY CONDITION THAT GRAB PUT ON, BY ID. A pass takes all of them off
       and nothing else: a Restrained that Web is holding is not this grapple's
       to remove. */
    const ids = (meta.holds ?? []).map(h => h.id).filter(Boolean);
    const gone = [];
    for (const id of (ids.length ? ids : [hold.id])) {
      const eff = actor.effects?.get?.(id);
      if (!eff) continue;
      try { await eff.delete(); gone.push(eff.name ?? id); }
      catch (err) { console.warn(`${LOG} | could not take "${eff.name}" off ${actor?.name}:`, err); }
    }
    console.log(`${LOG} | ${actor?.name} rolled ${total} against DC ${dc} and is free of "${label}": `
      + `${gone.join(", ") || "nothing was left to remove"}.`);
    return true;
  }

  /** Record that this turn's action is spent, so the box is not offered twice. */
  static async _spendAction(actor, on) {
    const c = game.combat;
    try {
      await actor.setFlag(MODULE_ID, "turnAction",
        { round: c?.round ?? null, turn: c?.turn ?? null, on, at: Date.now() });
      console.log(`${LOG} | ${actor?.name}'s action this turn went on ${on}.`);
    } catch (err) {
      console.warn(`${LOG} | could not record ${actor?.name}'s spent action:`, err);
    }
  }

  /** Has this creature already spent its action this turn? */
  static _actionSpent(actor) {
    const f = actor?.getFlag?.(MODULE_ID, "turnAction");
    const c = game.combat;
    return !!f && f.round === (c?.round ?? null) && f.turn === (c?.turn ?? null);
  }

  /* ── The turn itself, in his order ──────────────────────────────────────── */

  static async onTurn(actor, token) {
    if (!actor || isOutOfTheFight(token ?? actor)) return;
    const holds = GrappleTurn.holdsOn(actor);
    if (!holds.length) return;
    if (!GrappleTurn.isHeld(actor)) {
      console.log(`${LOG} | ${actor.name} carries an escape stamp but neither Grappled nor `
        + `Restrained, so nothing is asked.`);
      return;
    }
    for (const hold of holds) await GrappleTurn.squeeze(actor, hold);
    if (GrappleTurn._actionSpent(actor)) {
      console.log(`${LOG} | ${actor.name}'s action this turn is already spent, so the box is not offered.`);
      return;
    }
    await GrappleTurn.ask(actor, token, holds[0], { because: "its turn" });
  }

  /* ── A move is not a move while something is holding you ────────────────── */

  static init() {
    /* ⚠️ THE MOVE IS REFUSED WHERE MOVES ARE ALREADY REFUSED. `restrained-
       movement.mjs` has owned `preUpdateToken` for a held creature since
       2026-08; a second hook here would be a second door onto one question, and
       the two would disagree the first time one of them changed. It calls
       `GrappleTurn.ask` when it turns a move down. */
    Hooks.on("combatTurnChange", (combat, prior, current) => {
      try {
        const c = combat?.combatants?.get?.(current?.combatantId);
        if (c?.actor) GrappleTurn.onTurn(c.actor, c.token?.object ?? null);
      } catch (err) { console.warn(`${LOG} | the turn hook failed:`, err); }
    });
    console.log(`${LOG} | a held creature's turn: the squeeze, then one box — attack or escape. `
      + `A move opens the same box and the token stays where it is.`);
  }
}
