// ─── ACE: QOL — A creature's own words fire them: death bursts and burning bodies ─
//
// Johnny, 2026-09-19:
//
//   "DEATH BURST / DEATH THROES. When the creature hits 0 hit points, if its
//    words say it explodes / bursts / death throes: area, damage, save,
//    conditions — all from that item's words. No button. Detect by the words,
//    not a name list. Damage through the hit-point door. Card after Dice So
//    Nice. Dead tokens do not save."
//
//   "HEATED BODY / FIRE FORM / TOUCH AURAS. Salamander, Azer, Fire Elemental,
//    anything whose words say: you take fire when you touch it, hit it with
//    melee, or start your turn next to it. That trigger runs with no button.
//    His Fire Salamander did nothing. Fix that."
//
// Before this, ACE knew none of it: a Magmin dropped to 0 and nothing burst, and
// the 2024 salamander's Fire Aura ("at the end of each of the salamander's turns,
// each creature of the salamander's choice in a 5-foot Emanation ... takes 7
// (2d6) Fire damage") had no engine at all. The melee half of a heated body
// (hit it and burn) is retaliation-engine.mjs; the gaze is gaze-engine.mjs.
//
// WHO DECIDES WHAT:
//   • the words (rules/creature-words.mjs) say THAT it fires, WHEN, the area,
//     and whether the creature chooses who;
//   • the item's recipe says what a save decides and what lands;
//   • the save card (autoResolve) and the road's run() land it through the
//     doors: saves, damage through the hit-point door, conditions through the
//     condition door, the card after the dice. Nobody presses anything.
//
// ⚠️ THE DEAD ARE NOT CAUGHT (his rule): the picker rule's "harm" test, the
// same one every save card uses, so a corpse beside a burst gets no row.
// ──────────────────────────────────────────────────────────────────────────────

import { aceDistanceFt } from "./geometry-utils.mjs";
import { readDeathBurst, readTurnAura, wordsRecipe, itemWords, kindOf } from "./rules/creature-words.mjs";
import { lifeStateOf, pickable } from "./road/picker-rule.mjs";
// What a save's DC comes to, the way dnd5e works it out (one resolver).
import { saveDCOf } from "./rules/save-dc.mjs";

const MODULE_ID = "ace-qol";
const LOG = "ace-qol | creature";
const say = (msg) => console.log(`${LOG} | ${msg}`);
const short = (s, n = 110) => (String(s ?? "").length > n ? `${String(s).slice(0, n - 1)}…` : String(s ?? ""));

/** Statuses that stop a creature doing anything, for "unless it is incapacitated". */
const OUT_OF_ACTION = ["incapacitated", "paralyzed", "petrified", "stunned", "unconscious", "dead"];

export class CreatureTriggers {

  static init() {
    if (this._on) return;
    this._on = true;
    // Fired by the one NPC death hook (ace-qol.mjs), on the active GM, once per
    // death, after the corpse art: the token keeps its place and its items.
    Hooks.on(`${MODULE_ID}.npcDeath`, (data) => {
      CreatureTriggers.onDeath(data).catch(err =>
        console.error(`${LOG} | a death burst could not run:`, err));
    });
    // After the turn has moved: `prior` is the turn that just ended, `current`
    // the one beginning (combat-hooks lesson, 2026-08-07).
    Hooks.on("combatTurnChange", (combat, prior, current) => {
      CreatureTriggers.onTurnChange(combat, prior, current).catch(err =>
        console.error(`${LOG} | a burning body could not run on the turn change:`, err));
    });
    // A stench's made save buys an immunity (its words say whose and how long).
    // Every save, a player's included, reaches the active GM's screen as this
    // signal once its dice are in (save-engine.mjs re-sends a player's).
    Hooks.on(`${MODULE_ID}.saveComplete`, (payload) => {
      CreatureTriggers._afterStenchSave(payload).catch(err =>
        console.warn(`${LOG} | could not write a stench immunity after a made save:`, err));
    });
    console.debug(`${LOG} | online: death bursts, burning bodies and stenches fire from their own words.`);
  }

  /* ═══ 1. DEATH BURSTS ═══════════════════════════════════════════════════ */

  /**
   * Does ACE QOL run this item's death effect? ACE Engine's monster automation
   * asks before it fires its own, and stands down for exactly these (one burst,
   * never two, and never the stat block pasted into chat).
   */
  static claims(item) {
    try { return !!readDeathBurst(item); } catch (_) { return false; }
  }

  /** A creature died: every item whose words burst it goes off. */
  static async onDeath({ actor, tokenDoc } = {}) {
    if (!actor || game.users?.activeGM !== game.user) return;
    const doc = tokenDoc ?? actor.token ?? actor.getActiveTokens?.()[0]?.document ?? null;
    for (const item of actor.items ?? []) {
      const words = readDeathBurst(item);
      if (!words) {
        // ⚠️ SILENCE IS A BUG. The words decide, never the name; but an item
        // NAMED like a burst that the words did not fire is said out loud, so a
        // reader that misses one is seen the first time (the 2024 Magmin's
        // "when it dies" hid in a lookup, 2026-09-19).
        if (/\bdeath (?:burst|throes)\b/i.test(String(item?.name ?? ""))) {
          say(`${doc?.name ?? actor.name}'s ${item.name}: named like a death burst, and its words say nothing ACE `
            + `reads as bursting when it dies ("${short(itemWords(item))}"), so nothing was run.`);
        }
        continue;
      }
      await CreatureTriggers._burst(actor, doc, item, words);
    }
  }

  static async _burst(actor, doc, item, words) {
    const name = doc?.name ?? actor.name;
    const tag = `${name}'s ${item.name}`;
    if (words.nothingToRoll) {
      say(`${tag}: ${words.notABurst ? "its words at death are not an explosion" : "its words put nothing on anyone to roll"}`
        + ` ("${short(words.sentence)}"), so nothing was run.`);
      return;
    }
    if (words.gmOnly) {
      say(`${tag}: ${words.gmOnly}.`);
      await CreatureTriggers._gmNote(`${esc(name)} died. <b>${esc(item.name)}</b>: ${esc(words.gmOnly)}.`);
      return;
    }
    if (!doc) {
      say(`${tag}: it has no token on the map, so nobody can be measured from it.`);
      return;
    }
    const rec = await CreatureTriggers._recipeFor(item, actor, ["save", "automatic"]);
    if (!rec) {
      say(`${tag}: its words burst it, and its item gives no save or damage ACE can read, so nothing was run.`);
      await CreatureTriggers._gmNote(`${esc(name)} died. <b>${esc(item.name)}</b> bursts, and ACE could not read what it `
        + `does from the item. Run it by hand.`);
      return;
    }
    const radius = CreatureTriggers._radius(words.radiusFt, rec, item);
    if (!radius) {
      say(`${tag}: its words burst it but say no distance, and its item has no area, so nobody was measured.`);
      await CreatureTriggers._gmNote(`${esc(name)} died. <b>${esc(item.name)}</b> bursts, and neither its words nor its `
        + `item say how far. Run it by hand.`);
      return;
    }
    const caught = CreatureTriggers._around(doc, radius);
    if (!caught.length) {
      say(`${tag}: it died and burst, and nobody living is within ${radius} feet of it.`);
      return;
    }
    say(`${tag}: it died and bursts; ${caught.map(t => t.name).join(", ")} within ${radius} feet.`);
    await CreatureTriggers._land(rec, item, actor, caught, "dies", `was caught when ${name} died`);
  }

  /* ═══ 2. BURNING BODIES, ON A TURN ═════════════════════════════════════ */

  /**
   * The turn that ended fires its creature's "at the end of each of its turns"
   * auras; the turn beginning fires its creature's "at the start" auras, and
   * every "a creature that starts its turn within N feet of it" aura around it.
   */
  static async onTurnChange(combat, prior, current) {
    if (game.users?.activeGM !== game.user) return;
    if (!combat?.started) return;
    const scene = combat.scene ?? canvas?.scene ?? null;
    const tokenOf = (combatantId) => combat.combatants?.get?.(combatantId)?.token ?? null;
    const ended = prior?.combatantId ? tokenOf(prior.combatantId) : null;
    const began = current?.combatantId ? tokenOf(current.combatantId) : null;

    if (ended && ended.id !== began?.id) await CreatureTriggers._ownAuras(ended, "own-end");
    if (began) {
      await CreatureTriggers._ownAuras(began, "own-start");
      await CreatureTriggers._auraOnArrival(began, scene);
    }
  }

  /** A creature's own turn fires the auras its words tie to that moment. */
  static async _ownAuras(sourceDoc, when) {
    const actor = sourceDoc?.actor;
    if (!actor) return;
    for (const item of actor.items ?? []) {
      const aura = readTurnAura(item);
      if (!aura || aura.when !== when) continue;
      await CreatureTriggers._aura(sourceDoc, item, aura, null);
    }
  }

  /** "A creature that starts its turn within N feet of it": the one starting, around every such source. */
  static async _auraOnArrival(victimDoc, scene) {
    // ⚠️ ONE SAVE AGAINST A KIND (2024: "immune to the Stench of all ghasts").
    // Two ghasts beside a creature ask it once: a made save is immunity to both,
    // and a failed one is the same poison twice.
    const askedKinds = new Set();
    for (const src of scene?.tokens?.contents ?? []) {
      if (!src?.actor || src.id === victimDoc.id) continue;
      for (const item of src.actor.items ?? []) {
        const aura = readTurnAura(item);
        if (!aura || aura.when !== "their-start") continue;
        const kindKey = aura.immunity?.allOfKind ? `${kindOf(src)}|${String(item.name).toLowerCase()}` : null;
        if (kindKey && askedKinds.has(kindKey)) {
          say(`${src.name}'s ${item.name}: ${victimDoc.name} already answers to one ${kindOf(src)}'s `
            + `${item.name} this turn, and its words make that save count for all of them.`);
          continue;
        }
        const asked = await CreatureTriggers._aura(src, item, aura, victimDoc);
        if (kindKey && asked) askedKinds.add(kindKey);
      }
    }
  }

  /**
   * One aura going off. `only` limits it to the creature whose turn began
   * (a "their-start" aura); otherwise everyone its words reach.
   */
  static async _aura(sourceDoc, item, aura, only = null) {
    const actor = sourceDoc.actor;
    const name = sourceDoc.name ?? actor.name;
    const tag = `${name}'s ${item.name}`;
    // ⚠️ A CREATURE'S OWN TURN: EVERY GIVE-UP BELOW IS SAID (his table, 2026-10-14:
    // "the Ghast's stench is not working", and nothing here said why). An aura the
    // creature began its turn outside of is none of its business and is only a
    // debug line; one it began inside of names each step it stops at.
    if (only) {
      let ft = Infinity;
      try { ft = aceDistanceFt(sourceDoc, only); } catch (_) { ft = Infinity; }
      const reach = Number(aura.radiusFt) || null;
      if (reach && ft > reach + 0.1) {
        console.debug(`${LOG} | ${tag}: ${only.name} began its turn ${Math.round(ft)} feet away, outside its ${reach}.`);
        return;
      }
      say(`${tag}: ${only.name} began its turn ${Number.isFinite(ft) ? `${Math.round(ft)} feet` : "an unknown distance"} `
        + `from it (it reaches ${reach ?? "?"} feet).`);
    }
    if (!CreatureTriggers._living(sourceDoc)) {
      say(`${tag}: it is dead, so it ${only ? "catches" : "burns"} nobody.`);
      return;
    }
    if (aura.unlessIncapacitated && CreatureTriggers._outOfAction(actor)) {
      say(`${tag}: its words switch it off while it is incapacitated, and it is.`);
      return;
    }
    const rec = aura.save
      ? await CreatureTriggers._recipeFor(item, actor, ["save"])
      : CreatureTriggers._damageRecipe(item, aura, await CreatureTriggers._recipeFor(item, actor, ["automatic"]));
    if (!rec) {
      if (only) say(`${tag}: ${aura.save ? "its words ask for a save its item does not carry" : "no damage could be read from its words or its item"}, so ${only.name} was not asked.`);
      if (!only) {
        say(`${tag}: ${aura.save ? "its words ask for a save its item does not carry" : "no damage could be read from its words or its item"}, so nothing was run.`);
        // Once a fight for each creature: a note every round would bury the chat.
        const key = `${game.combat?.id ?? "none"}:${sourceDoc.id}:${item.id ?? item.name}`;
        CreatureTriggers._noted ??= new Set();
        if (!CreatureTriggers._noted.has(key)) {
          CreatureTriggers._noted.add(key);
          await CreatureTriggers._gmNote(`<b>${esc(tag)}</b> goes off on its turn, and ACE could not read `
            + `${aura.save ? "its save" : "its damage"}. Run it by hand (said once this fight).`);
        }
      }
      return;
    }
    const radius = CreatureTriggers._radius(aura.radiusFt, rec, item);
    if (!radius) {
      say(`${tag}: neither its words nor its item say how far it reaches, so nobody was measured.`);
      return;
    }
    let caught = CreatureTriggers._around(sourceDoc, radius);
    if (only) caught = caught.filter(t => t.id === only.id);

    // ⚠️ WHO ITS WORDS LEAVE OUT: "any creature (other than a ghast)".
    if (aura.excludes) {
      const leftOut = caught.filter(t => kindOf(t) === kindOf(aura.excludes));
      if (leftOut.length) {
        say(`${tag}: ${leftOut.map(t => t.name).join(", ")} ${leftOut.length === 1 ? "is a" : "are"} `
          + `${aura.excludes}, which its words leave out.`);
        caught = caught.filter(t => !leftOut.includes(t));
      }
    }
    // A stench: who already made the save, and who cannot have its condition.
    const stench = !!aura.condition && !(aura.dice ?? []).length;
    if (stench) caught = await CreatureTriggers._stenchSpares(sourceDoc, item, aura, caught, tag);
    const inRange = caught.map(t => t.name);

    /* ⚠️🔴 "OF ITS CHOICE" IS A CHOICE SOMEBODY MAKES (his rule, 2026-10-04).
       This answered it by disposition: anybody not on the opposite side was
       spared, silently, without anybody being asked. So a Salamander's Fire Aura
       left the Yuan-ti Anathema standing beside it untouched every round and the
       log said it was "on its side". Two creatures are not allies because a
       token's disposition number happens to match, a salamander will burn a
       yuan-ti as readily as anyone, and that choice is not ACE's to make.

       One creature in reach is burned. More than one opens the portrait picker
       this suite already uses for exactly this question, and only the ones he
       marks there are spared. */
    let spared = [];
    if (aura.choice && caught.length > 1) {
      const { SpellTargetPicker } = await import("./spell-target-picker.mjs");
      let safe = [];
      try {
        safe = await SpellTargetPicker.pick({
          spellItem: item, casterActor: actor, maxTargets: caught.length,
          rangeFt: Infinity, allowSelf: false, kind: "exclude", only: caught,
        }) ?? [];
      } catch (err) {
        console.warn(`${LOG} | ${tag}: the "who is safe" picker could not be opened, `
          + `so nobody is marked safe and everyone in reach burns:`, err);
      }
      const safeIds = new Set();
      for (const a of safe) {
        for (const t of caught) {
          if (t.actor === a || (a?.id && t.actor?.id === a.id)) safeIds.add(t.id);
        }
      }
      spared = caught.filter(t => safeIds.has(t.id));
      caught = caught.filter(t => !safeIds.has(t.id));
    }
    if (!caught.length) {
      /* ⚠️ MARKING EVERYBODY SAFE IS AN ANSWER, and it does not look like an
         empty room. */
      if (spared.length) {
        say(`${tag}: in range ${inRange.join(", ")}; every one of them marked safe, so nobody was burned.`);
      } else if (only) {
        say(`${tag}: ${only.name} was not asked: not within its ${radius} feet edge to edge, not among `
          + `the living, or left out by its words (said above when it was).`);
      } else {
        say(`${tag}: nobody living within ${radius} feet for it to burn.`);
      }
      return;
    }
    const when = aura.when === "own-end" ? "as its turn ended" : aura.when === "own-start" ? "as its turn began"
      : "as their turn began";
    // ⚠️ WHO WAS IN RANGE AND WHO WAS BURNED (his rule): a creature that was
    // standing there and did not burn has to be accounted for by name.
    say(`${tag}: within ${radius} feet ${when}: ${inRange.join(", ")}. `
      + `${stench ? "Asked to save" : "Burned"}: ${caught.map(t => t.name).join(", ")}.`
      + `${spared.length ? ` Marked safe: ${spared.map(t => t.name).join(", ")}.` : ""}`
      + `${aura.choice && inRange.length === 1 ? " One creature in reach, so nothing was asked." : ""}`);
    if (stench) {
      const landed = CreatureTriggers._stenchRecipe(rec, aura, tag);
      if (aura.immunity) CreatureTriggers._awaitStenchSaves(sourceDoc, item, aura, caught);
      await CreatureTriggers._land(landed, item, actor, caught, "aura", `was beside ${name} ${when}`);
      return true;
    }
    await CreatureTriggers._land(rec, item, actor, caught, "aura", `was beside ${name} ${when}`);
    return true;
  }

  /* ═══ 3. A STENCH ══════════════════════════════════════════════════════ */

  /**
   * Who a stench does not ask: a creature its made save already made immune
   * (presence-engine.mjs holds that immunity, the one ACE has), and a creature
   * that cannot have its condition at all (the target profile answers that, as
   * it does for every condition). Each one is said by name.
   */
  static async _stenchSpares(sourceDoc, item, aura, caught, tag) {
    let PresenceEngine = null, buildTargetProfile = null;
    try { ({ PresenceEngine } = await import("./presence-engine.mjs")); }
    catch (err) { console.warn(`${LOG} | ${tag}: the immunity reader did not load, so nobody is counted immune:`, err); }
    try { ({ buildTargetProfile } = await import("./profiles/target-profile.mjs")); }
    catch (err) { console.warn(`${LOG} | ${tag}: the target profile did not load, so nobody is counted immune to ${aura.condition}:`, err); }
    const out = [];
    for (const t of caught) {
      const imm = aura.immunity && PresenceEngine ? PresenceEngine.immunityOn(t.actor, sourceDoc, item) : null;
      if (imm) {
        say(`${tag}: ${t.name} made this save before and is immune to it still (${imm.name}).`);
        continue;
      }
      let cannot = false;
      try { cannot = !!buildTargetProfile?.(t.actor, { token: t.object ?? t })?.immuneToCondition?.(aura.condition); }
      catch (err) { console.warn(`${LOG} | ${tag}: could not ask whether ${t.name} can be ${aura.condition}; it is asked to save:`, err); }
      if (cannot) {
        say(`${tag}: ${t.name} cannot be ${aura.condition}, so it is not asked to save.`);
        continue;
      }
      out.push(t);
    }
    return out;
  }

  /**
   * The recipe a stench lands, with what its words say about the condition. A
   * 2024 stench carries its Poisoned as an effect that lasts one turn; a 2014
   * one has only the sentence, which no reader turned into a length, so the
   * poison went on for good. "Until the start of its next turn" is one round,
   * the same six seconds the 2024 effect is.
   */
  static _stenchRecipe(rec, aura, tag) {
    const recipe = rec?.recipe;
    if (!recipe) return rec;
    const lasts = Number(aura.lastsSeconds) > 0 ? Number(aura.lastsSeconds) : null;
    let named = false;
    const onFail = (Array.isArray(recipe.onFail) ? recipe.onFail : []).map(o => {
      if (o?.kind !== "condition") return o;
      if (String(o.condition?.key ?? "").toLowerCase() === aura.condition) named = true;
      if (!lasts || Number(o.condition?.duration) > 0) return o;
      return { ...o, condition: { ...o.condition, duration: lasts } };
    });
    if (!named) {
      onFail.push({ kind: "condition", condition: { key: aura.condition, duration: lasts, ends: null } });
      say(`${tag}: its recipe did not carry ${aura.condition}; its words do, so a failed save puts it on.`);
    }
    return { ...rec, recipe: { ...recipe, onFail } };
  }

  /**
   * Remember who was asked, so a made save can buy its immunity when its dice
   * are in. Kept for ten minutes of real time: a save still unanswered after
   * that is a card nobody is going to roll.
   */
  static _awaitStenchSaves(sourceDoc, item, aura, caught) {
    CreatureTriggers._stenchAsked ??= new Map();
    const now = Date.now();
    for (const [k, v] of CreatureTriggers._stenchAsked) if (now - v.at > 600000) CreatureTriggers._stenchAsked.delete(k);
    for (const t of caught) {
      CreatureTriggers._stenchAsked.set(`${t.id}|${item.uuid}`, {
        at: now,
        mark: {
          sourceActorId: sourceDoc.actor?.id ?? null,
          sourceTokenId: sourceDoc.id,
          sourceName: sourceDoc.name ?? sourceDoc.actor?.name ?? "it",
          itemName: item.name,
          itemUuid: item.uuid ?? null,
          immuneHours: aura.immunity.hours,
          sceneId: sourceDoc.parent?.id ?? null,
          verb: "affect",
          ...(aura.immunity.allOfKind ? { allOfKind: kindOf(sourceDoc) } : { perCreature: true }),
        },
      });
    }
  }

  /** A save against a stench came back: made, it buys the immunity its words name. */
  static async _afterStenchSave(payload) {
    if (game.users?.activeGM !== game.user) return;
    const asked = CreatureTriggers._stenchAsked;
    if (!asked?.size || !payload?.itemUuid || !payload?.tokenDocId) return;
    const key = `${payload.tokenDocId}|${payload.itemUuid}`;
    const entry = asked.get(key);
    if (!entry) return;
    asked.delete(key);
    if (payload.passed !== true) return;
    const { PresenceEngine } = await import("./presence-engine.mjs");
    await PresenceEngine._immunise(payload.actor, entry.mark, "it made the save");
  }

  /* ═══ Landing ══════════════════════════════════════════════════════════ */

  /**
   * Through the doors. A save goes on the one save card, marked to resolve
   * itself; damage nothing rolls against goes through the road, one creature at
   * a time, each with its card after the dice.
   */
  static async _land(rec, item, actor, caught, trigger, happened) {
    const recipe = rec.recipe;
    if (recipe.decidedBy?.kind === "save") {
      const eng = game.aceQol?.saveEngine;
      if (typeof eng?.postSaveCard !== "function") {
        console.warn(`${LOG} | ${item.name}: the save engine is not on the API, so no save was asked.`);
        return;
      }
      const dc = saveDCOf(recipe, item);
      if (!Number.isFinite(dc) || dc <= 0) {
        say(`${item.name}: its save has no DC ACE can read, so nothing was asked.`);
        await CreatureTriggers._gmNote(`<b>${esc(item.name)}</b> went off, and its save has no DC ACE can read. Run it by hand.`);
        return;
      }
      await eng.postSaveCard(item, actor, caught.map(t => t.object ?? t), {
        saveAbility: String(recipe.decidedBy.ability ?? "").toLowerCase(),
        saveDC: dc,
        isSpell: false,
        recipe,
        activityId: recipe.source?.activity ?? null,
        skipDelay: true,
        autoResolve: true,
        trigger,
      });
      return;
    }
    const { run } = await import("./road/run.mjs");
    for (const t of caught) {
      await run(recipe, trigger, { item, actor, token: t.object ?? t, happened });
    }
  }

  /* ═══ Reading the item ═════════════════════════════════════════════════ */

  /** The item's first recipe decided by one of these kinds, with its record. */
  static async _recipeFor(item, actor, kinds) {
    try {
      const { recipesFor } = await import("./inference/recipe.mjs");
      const recs = recipesFor(item, { actor }) ?? [];
      for (const k of kinds) {
        const hit = recs.find(r => r?.recipe?.decidedBy?.kind === k);
        if (hit) return hit;
      }
    } catch (err) {
      console.warn(`${LOG} | could not read ${item?.name}'s recipe:`, err);
    }
    return null;
  }

  /**
   * The damage a burning body deals, from its own sentence first: the dice the
   * sentence writes, else its place among the item's "(damage)" placeholders
   * (the 2014 balor's aura and touch share one activity's two parts), else the
   * item's damage recipe.
   */
  static _damageRecipe(item, aura, rec) {
    if (aura.dice?.length) return { recipe: wordsRecipe(item.name, aura.dice), fromWords: true };
    const parts = CreatureTriggers._activityDice(item);
    const placeholders = (itemWords(item).match(/\(damage\)/g) ?? []).length;
    if (aura.placeholder !== null && aura.placeholder !== undefined && placeholders > 1
        && parts.length === placeholders && parts[aura.placeholder]) {
      return { recipe: wordsRecipe(item.name, [parts[aura.placeholder]]), fromWords: true };
    }
    if (rec?.recipe) return rec;
    return parts.length ? { recipe: wordsRecipe(item.name, parts), fromWords: true } : null;
  }

  /** Every damage part on the item's first activity that has any, as dice. */
  static _activityDice(item) {
    for (const a of CreatureTriggers._activities(item)) {
      const parts = a?.damage?.parts ?? [];
      if (!parts.length) continue;
      return parts.map(p => {
        const custom = p?.custom?.enabled ? String(p.custom.formula ?? "").trim() : "";
        const formula = custom || (p?.number && p?.denomination
          ? `${p.number}d${p.denomination}${p.bonus ? ` + ${p.bonus}` : ""}` : "");
        const types = p?.types instanceof Set ? [...p.types] : [].concat(p?.types ?? []);
        return formula ? { formula, type: types[0] ?? null } : null;
      }).filter(Boolean);
    }
    return [];
  }

  static _activities(item) {
    const acts = item?.system?.activities;
    if (!acts) return [];
    return [...(acts.values?.() ?? Object.values(acts))];
  }

  /**
   * How far it reaches: its words first; then the recipe's area; then any
   * activity's own area. Null when nothing says.
   */
  static _radius(wordsFt, rec, item) {
    if (Number.isFinite(Number(wordsFt)) && Number(wordsFt) > 0) return Number(wordsFt);
    const w = rec?.recipe?.where;
    if (w && (w.kind === "emanation" || w.kind === "area") && Number(w.size) > 0) return Number(w.size);
    for (const a of CreatureTriggers._activities(item)) {
      const size = Number(a?.target?.template?.size);
      if (size > 0) return size;
    }
    return null;
  }


  /* ═══ Who is where ═════════════════════════════════════════════════════ */

  /** Every living creature within `radiusFt` of this one, edge to edge, itself left out. */
  static _around(sourceDoc, radiusFt) {
    const scene = sourceDoc?.parent ?? canvas?.scene ?? null;
    const out = [];
    for (const t of scene?.tokens?.contents ?? []) {
      if (!t?.actor || t.id === sourceDoc.id) continue;
      if (!CreatureTriggers._living(t)) continue;
      let ft = Infinity;
      try { ft = aceDistanceFt(sourceDoc, t); } catch (_) { ft = Infinity; }
      if (ft <= Number(radiusFt) + 0.1) out.push(t);
    }
    return out;
  }

  /** Alive, or dying at 0 hit points: the living a harm reaches (picker-rule.mjs). */
  static _living(tokenDoc) {
    return pickable("harm", lifeStateOf(tokenDoc?.actor, tokenDoc)).ok;
  }

  /* ⚠️ `_opposes` IS GONE (2026-10-04). It was only ever used to decide who an
     aura "of its choice" spared, and deciding that by disposition is the bug he
     reported: it spared the Yuan-ti Anathema from the salamander standing next
     to it. The question is asked now. The gaze engine keeps its own copy, where
     it answers a different question (whose gaze is the GM's to force). */

  static _outOfAction(actor) {
    const st = actor?.statuses;
    return OUT_OF_ACTION.some(s => st?.has?.(s));
  }

  /** A line for the GM alone, when something fired that ACE hands back. */
  static async _gmNote(html) {
    try {
      const { CardDoor } = await import("./road/doors.mjs");
      const gms = (game.users?.filter?.(u => u.isGM) ?? []).map(u => u.id);
      await CardDoor.post({
        content: `<div style="border-left:3px solid #d4af37;padding:6px 10px;font-size:16px;line-height:1.4;">${html}</div>`,
        speaker: { alias: "ACE" },
        whisper: gms,
        flags: { [MODULE_ID]: { type: "creatureTriggerNote" } },
      });
    } catch (err) {
      console.warn(`${LOG} | could not post the GM's note:`, err);
    }
  }
}

function esc(s) {
  return globalThis.foundry?.utils?.escapeHTML ? foundry.utils.escapeHTML(String(s ?? "")) : String(s ?? "");
}
