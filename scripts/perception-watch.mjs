// ─── WHEN A CREATURE NOTICES SOMEBODY ────────────────────────────────────────
//
// His spec, 2026-10-05: "When a hostile creature perceives a player character,
// the GM gets a popup. The popup never rolls initiative by itself. The only roll
// is the button the GM presses, and that roll is for that one creature. No PCs.
// No other creatures on the scene."
//
// THREE CASES, AND THEY ARE NOT THE SAME EVENT:
//
//   1. They can see each other. The game pauses and player tokens are LOCKED
//      until the GM answers, because a pause does not cancel a drag that has
//      already started. The pause is the announcement; the hook is the lock.
//   2. The creature sees him and he cannot see it (darkvision, invisibility, a
//      hidden creature, blindsight, tremorsense). NO pause: a pause banner
//      tells the whole table they have been spotted, which is the one thing
//      that must not happen here.
//   3. Neither can see the other, but sound carries and they are within thirty
//      feet. The creature hears something. No pause, no roll.
//
// And the fourth case is deliberately silent: if HE can see the creature and it
// cannot see him, nothing happens at all. He can back off.
//
// ⚠️🔴 NOTHING HERE ROLLS BY ITSELF, EVER. One button, one creature, and only
// because a person pressed it. It never touches `rollAllNpcs`, `rollAllPcs` or
// `_populate`, and it never starts turns for the table.
//
// ⚠️ SIGHT COMES FROM THE ONE READER. `Situation.canSee` knows walls, closed
// doors, blindness, invisibility, darkness, blindsight, tremorsense and averted
// eyes, and it hands back WHY, which is logged. The narrator's own sight test in
// ace-engine fails open and ignores those senses, and aura range ignores walls
// on purpose. Neither is asked here.
//
// ⚠️ HIDDEN COMES FROM THE STEALTH ENGINE, not a second copy of the comparison.
// `StealthEngine.attackerHiddenFromTarget` is the suite's one answer to "is this
// token hidden from that one", and it is RAW: the Stealth total has to BEAT the
// passive Perception, so a tie goes to the creature doing the perceiving.
// ──────────────────────────────────────────────────────────────────────────────

const MODULE_ID = "ace-qol";
const LOG = `${MODULE_ID} | perceived`;

import { Situation } from "./situation.mjs";
import { StealthEngine } from "./stealth-engine.mjs";
import { aceTokenSpace, aceSpaceDistanceFt } from "./geometry-utils.mjs";
import { InitiativeTools } from "./initiative-tools.mjs";
import { popupDing } from "./popup-ding.mjs";
import { awaitDiceSettle } from "./dsn-utils.mjs";
import { aceToolOrder } from "./token-tools-order.mjs";

/** Footsteps carry this far, edge to edge: the same measure the auras use. */
const HEARING_FT = 30;

/* ⚠️ REGISTERED AT IMPORT, NOT FROM `init()`. `getSceneControlButtons` fires
   ONCE during Foundry's init, and ACE calls its engines' `init()` from the ready
   handler, which is long after: a toolbar hook added in there listens for an
   event that has already happened and the button never exists. The outline
   toggle learned this on 2026-08-24 and says so in its own file.

   WHERE it sits is token-tools-order.mjs's business, not this file's. The only
   thing said here is the number, and it is its own: `ace-select-all` and
   `ace-disposition-outline` both carry 99006 already, which is how two buttons
   end up fighting over one slot. */
Hooks.on("getSceneControlButtons", (controls) => {
  try {
    if (!game.user?.isGM) return;
    let group = null;
    if (Array.isArray(controls)) group = controls.find(c => c.name === "token" || c.name === "tokens");
    else if (controls && typeof controls === "object") group = controls.tokens ?? controls.token;
    if (!group) return;

    const tool = {
      name: "ace-perception-reset",
      title: "Reset perception memory",
      icon: "fa-solid fa-right-left",
      button: true,
      visible: true,
      // Off the one list, which is also what decides it is last.
      order: aceToolOrder("ace-perception-reset"),
      // ⚠️ ONE HANDLER. V13 fires BOTH `onClick` and `onChange` for a button
      // tool, so a tool wired to both does everything twice.
      onChange: () => PerceptionWatch.resetMemory(),
    };

    if (Array.isArray(group.tools)) {
      group.tools = group.tools.filter(t => t?.name !== tool.name);
      group.tools.push(tool);
    } else if (group.tools && typeof group.tools === "object") {
      delete group.tools[tool.name];
      group.tools[tool.name] = tool;
    }
  } catch (err) {
    console.error(`${MODULE_ID} | the perception reset button could not be built:`, err);
  }
});

export class PerceptionWatch {

  /* ⚠️🔴 THE MEMORY IS THE PAIR, AND IT IS ON THE SCENE (his rule,
     2026-10-05): "Once a popup has been shown for that pair, do not show it
     again on a later move, a door change, or the same creature hearing him
     after already seeing him... 'Popup still open' is not the memory. The pair
     is."

     So it is written the moment the popup is SHOWN, not when it is answered,
     and it is a scene flag rather than a variable in this file: a variable dies
     on a reload, is not shared with a second GM client, and cleared itself every
     time he unpaused, which is three ways to ask the same question twice.

     The key is the creature's token id and the player's token id. A different
     creature is a different key and gets one notice of its own. */
  static NOTICED_FLAG = "perceptionNoticed";

  /* The only thing `_asking` is for: two moves inside the same tick, before the
     flag written below has landed. It is a race guard, not the memory. */
  static _asking = new Set();

  /** Which scene this client last had drawn, so a reload is not a scene change. */
  static _lastSceneId = null;
  /* ⚠️🔴 THE LOCK LIVES ON THE SCENE, NOT IN THIS FILE. `preUpdateToken` fires
     only on the client that STARTS the update, so a player finishing a drag is
     refused on the PLAYER's client, where a variable set on the GM's client is
     still false. A scene flag is synced to everybody, which is the same reason
     restrained-movement.mjs reads the hold off the actor instead of a local. */
  static LOCK_FLAG = "perceptionLock";

  static init() {
    /* ⚠️ THE DESTINATION, NOT THE SQUARE HE LEFT (his rule). The secret-door
       watcher read `document.x` and tested the square he had already walked out
       of. `changes.x` is where he is going. */
    Hooks.on("updateToken", (tokenDoc, changes) => {
      if (changes?.x === undefined && changes?.y === undefined) return;
      const at = { x: changes.x ?? tokenDoc.x, y: changes.y ?? tokenDoc.y };
      PerceptionWatch._afterMove(tokenDoc, at).catch(err =>
        console.warn(`${LOG} | could not test what ${tokenDoc?.name} walked into:`, err));
    });

    /* ⚠️ A DOOR OPENING MOVES NOBODY, AND IT IS THE CASE THAT MATTERS: the
       paladin is already standing at the door when it swings. */
    Hooks.on("updateWall", (wallDoc, changes) => {
      if (changes?.ds === undefined) return;
      PerceptionWatch._afterDoor(wallDoc).catch(err =>
        console.warn(`${LOG} | could not test the door that just opened:`, err));
    });

    /* ⚠️ THE HARD LOCK. A pause does not cancel a drag already in flight, so
       the move itself is refused while a mutual-sight popup is open. */
    Hooks.on("preUpdateToken", (tokenDoc, changes) => {
      if (changes?.x === undefined && changes?.y === undefined) return;
      if (!tokenDoc?.parent?.getFlag?.(MODULE_ID, PerceptionWatch.LOCK_FLAG)) return;
      if (!tokenDoc?.actor?.hasPlayerOwner) return;
      console.log(`${LOG} | ${tokenDoc.name} is held still: a creature is looking straight `
        + `at somebody and the popup has not been answered yet.`);
      try {
        ui.notifications?.warn(`${tokenDoc.name} stops: something has seen you.`);
      } catch (_) { /* the console has it either way */ }
      return false;   // cancel the move
    });

    /* The lock lives as long as the pause it came with: when he unpauses, the
       table is his again. "Ready" and "Roll" both leave the pause on, by his
       rule, so this is where those two let go. */
    Hooks.on("pauseGame", (paused) => {
      if (paused || game.users?.activeGM !== game.user) return;
      // ⚠️ UNPAUSING LETS THEM MOVE. IT DOES NOT FORGET ANYBODY. It used to
      // clear the memory here, which is why one creature could ask twice.
      PerceptionWatch._unlock(canvas?.scene).catch(err =>
        console.warn(`${LOG} | could not take the movement lock off:`, err));
    });

    /* ⚠️ COMBAT ENDING IS THE RESET. Everyone on that scene has been noticed by
       now; the next time something spots somebody it is a new moment. */
    Hooks.on("deleteCombat", (combat) => {
      if (game.users?.activeGM !== game.user) return;
      const scene = combat?.scene ?? canvas?.scene;
      PerceptionWatch._forget(scene, "the encounter ended").catch(() => {});
    });

    /* ⚠️ A SCENE CHANGE IS ALSO A RESET, AND A RELOAD IS NOT A SCENE CHANGE.
       The first draw after a refresh is the same scene he was already on, so it
       must not wipe what that scene remembers. */
    Hooks.on("canvasReady", (canvasReadyFor) => {
      const id = canvasReadyFor?.scene?.id ?? canvas?.scene?.id ?? null;
      const was = PerceptionWatch._lastSceneId;
      PerceptionWatch._lastSceneId = id;
      if (!was || was === id) return;                    // a reload, or the same scene
      if (game.users?.activeGM !== game.user) return;
      PerceptionWatch._forget(canvasReadyFor?.scene ?? canvas?.scene, "the scene changed")
        .catch(() => {});
    });

    /* ⚠️ A LOCK LEFT OVER FROM A RELOAD WOULD FREEZE HIS TABLE WITH NOTHING TO
       CLICK. No popup can be open at startup, so any lock on a scene now is
       stale by definition. */
    if (game.user.isGM) {
      for (const scene of (game.scenes ?? [])) {
        if (!scene.getFlag?.(MODULE_ID, PerceptionWatch.LOCK_FLAG)) continue;
        console.warn(`${LOG} | "${scene.name}" was still locked from a previous session, `
          + `which cannot be right, so the lock is off.`);
        PerceptionWatch._unlock(scene).catch(() => {});
      }
    }

    console.log(`${LOG} | watching for the moment something notices somebody.`);
  }

  /**
   * What this scene remembers: `{ seen: [creature token id], heard: [pair key] }`.
   *
   * ⚠️🔴 HEARD IS NOT SEEN (his correction, 2026-10-05): "A hearing notice
   * writes 'heard' for that creature only. It must not consume a later sighting."
   * One flat list of pairs did exactly that: a creature that heard footsteps
   * through a door was marked answered, so when the door opened and they were
   * staring at each other, nothing paused and nothing was said.
   *
   * THREE THINGS, AND ONLY ONE OF THEM IS TOTAL:
   *
   *   seen     the mutual-sight popup happened, and so did the pause. Keyed by
   *            the CREATURE, because a sighting is a group and every creature in
   *            it is marked, so a second player walking into that same group
   *            later raises nothing. Nothing comes from a seen creature again.
   *   watched  a one-way sighting was shown for that pair: it can see him, he
   *            cannot see it. Keyed by the PAIR, and it stops only another
   *            one-way popup for that same pair.
   *   heard    a hearing notice was shown for that pair. Keyed by the pair, and
   *            it stops only another hearing for that same pair.
   *
   * ⚠️🔴 A ONE-WAY SIGHTING DOES NOT WRITE SEEN (his correction, 2026-10-05):
   * "seen means the pause already happened." It was writing seen, so the moment
   * that same creature and that same player could finally see each other, the
   * moment the whole pause exists for, went by in silence.
   */
  static _memory(scene) {
    try {
      const raw = scene?.getFlag?.(MODULE_ID, PerceptionWatch.NOTICED_FLAG);
      // A scene written by the first version of this file holds a flat array of
      // pair keys. It is read as "seen" and said out loud, not silently dropped.
      if (Array.isArray(raw)) {
        console.log(`${LOG} | "${scene?.name}" remembers ${raw.length} pair(s) in the old flat `
          + `shape; they count as seen until the encounter ends or the scene changes.`);
        return { seen: new Set(raw.map(k => String(k).split(">")[0])),
                 watched: new Set(raw), heard: new Set(raw) };
      }
      return { seen: new Set(raw?.seen ?? []), watched: new Set(raw?.watched ?? []),
               heard: new Set(raw?.heard ?? []) };
    } catch (_) { return { seen: new Set(), watched: new Set(), heard: new Set() }; }
  }

  /**
   * The button: forget every sighting, watch and hearing on THIS scene, and take
   * the movement lock off.
   *
   * ⚠️ IT DOES NOT UNPAUSE, END THE COMBAT OR TOUCH THE TRACKER (his rule,
   * 2026-10-05). It clears what this watcher remembers and the lock this watcher
   * set, and nothing that belongs to anybody else.
   */
  static async resetMemory() {
    if (!game.user.isGM) {
      ui.notifications?.warn("ACE: only the GM can clear the perception memory.");
      return;
    }
    const scene = canvas?.scene;
    if (!scene) {
      ui.notifications?.warn("ACE: no scene is being viewed, so there is nothing to clear.");
      return;
    }
    // Any popup open right now is about to be answered against a cleared memory;
    // the race guard goes with it so the next move can ask again.
    PerceptionWatch._asking.clear();
    await PerceptionWatch._forget(scene, "the reset button was pressed");
    await PerceptionWatch._unlock(scene);
    console.log(`${LOG} | reset: "${scene.name}" remembers nothing and no token is held. `
      + `The pause, the encounter and the tracker are untouched.`);
    ui.notifications?.info("Perception memory cleared.");
  }

  /** Has this creature's sighting already been shown? Then it never asks again. */
  static _isSeen(scene, foeId) { return PerceptionWatch._memory(scene).seen.has(foeId); }

  /** Has this pair already had its one-way popup? A mutual one still comes. */
  static _isWatched(scene, key) { return PerceptionWatch._memory(scene).watched.has(key); }

  /** Has this creature already been reported hearing this player? */
  static _isHeard(scene, key) { return PerceptionWatch._memory(scene).heard.has(key); }

  /** Write it down. Said out loud if it cannot be written. */
  static async _write(scene, { seen = [], watched = [], heard = [] }, line) {
    if (!scene) return;
    try {
      const now = PerceptionWatch._memory(scene);
      for (const id of seen) now.seen.add(id);
      for (const k of watched) now.watched.add(k);
      for (const k of heard) now.heard.add(k);
      await scene.setFlag(MODULE_ID, PerceptionWatch.NOTICED_FLAG,
        { seen: [...now.seen], watched: [...now.watched], heard: [...now.heard] });
    } catch (err) {
      /* ⚠️ A MEMORY THAT DID NOT WRITE WILL ASK AGAIN ON THE NEXT STEP, and he
         would have no idea why. */
      console.error(`${LOG} | could not write down that "${line}" has been shown, so this `
        + `may be asked again on the next move:`, err);
    }
  }

  /** Forget every pair on a scene. */
  static async _forget(scene, why) {
    if (!scene || !game.user.isGM) return;
    try {
      const now = PerceptionWatch._memory(scene);
      if (!now.seen.size && !now.watched.size && !now.heard.size) return;
      await scene.unsetFlag(MODULE_ID, PerceptionWatch.NOTICED_FLAG);
      console.log(`${LOG} | ${why}: "${scene.name}" forgets ${now.seen.size} sighting(s), `
        + `${now.watched.size} one-way watch(es) and ${now.heard.size} hearing(s), so the next `
        + `time something notices somebody it says so again.`);
    } catch (err) {
      console.warn(`${LOG} | could not clear what "${scene?.name}" remembers:`, err);
    }
  }

  /** Hold every player token still, on every client. GM only. */
  static async _lockDown(scene) {
    if (!scene || !game.user.isGM) return;
    try { await scene.setFlag(MODULE_ID, PerceptionWatch.LOCK_FLAG, true); }
    catch (err) { console.error(`${LOG} | the movement lock could not be set, so a drag `
      + `already in flight will land:`, err); }
  }

  /** Let them move again. */
  static async _unlock(scene) {
    if (!scene || !game.user.isGM) return;
    if (!scene.getFlag?.(MODULE_ID, PerceptionWatch.LOCK_FLAG)) return;
    await scene.unsetFlag(MODULE_ID, PerceptionWatch.LOCK_FLAG);
    console.log(`${LOG} | the movement lock is off: player tokens move freely again.`);
  }

  /* ═══ When to look ════════════════════════════════════════════════════════ */

  /** Is this client the one that looks? Only one does, or it happens twice. */
  static _onDuty() {
    return game.users?.activeGM === game.user;
  }

  /** Every player-owned token on the scene, and every hostile creature. */
  static _sides(scene) {
    const tokens = (scene?.tokens?.contents ?? []).filter(t => t.actor);
    const pcs = tokens.filter(t => t.actor.hasPlayerOwner);
    const foes = tokens.filter(t => !t.actor.hasPlayerOwner
      && Number(t.disposition) === (CONST.TOKEN_DISPOSITIONS?.HOSTILE ?? -1)
      && PerceptionWatch._awake(t));
    return { pcs, foes };
  }

  /** A creature that is down, dead or asleep notices nothing. */
  static _awake(tokenDoc) {
    const st = tokenDoc?.actor?.statuses;
    if (!(st instanceof Set)) return true;
    for (const out of ["dead", "unconscious", "paralyzed", "petrified", "stunned", "incapacitated"]) {
      if (st.has(out)) return false;
    }
    return Number(tokenDoc?.actor?.system?.attributes?.hp?.value ?? 1) > 0;
  }

  /** A token moved: test it against the other side, whichever side it is on. */
  static async _afterMove(tokenDoc, at) {
    if (!PerceptionWatch._onDuty()) return;
    const scene = tokenDoc?.parent ?? canvas?.scene;
    if (!scene || !tokenDoc?.actor) return;

    /* ⚠️ ONCE THE FIGHT IS ON, NOBODY IS ASKED (his rule, 2026-10-05). A
       creature that can see somebody already fighting is simply added and rolled,
       with one line in the GM's chat. No popup, no pause, no hop. */
    if (game.combat?.started) return PerceptionWatch._joinFight(scene, { at, moved: tokenDoc });

    const { pcs, foes } = PerceptionWatch._sides(scene);

    if (tokenDoc.actor.hasPlayerOwner) {
      for (const foe of foes) await PerceptionWatch._pair(foe, tokenDoc, { pcAt: at });
      return;
    }
    if (foes.some(f => f.id === tokenDoc.id)) {
      for (const pc of pcs) await PerceptionWatch._pair(tokenDoc, pc, { foeAt: at });
    }
  }

  /** A door changed state: test every pair on the scene, nobody having moved. */
  static async _afterDoor(wallDoc) {
    if (!PerceptionWatch._onDuty()) return;
    const scene = wallDoc?.parent ?? canvas?.scene;
    if (game.combat?.started) return PerceptionWatch._joinFight(scene, {});
    const { pcs, foes } = PerceptionWatch._sides(scene);
    if (!pcs.length || !foes.length) return;
    console.log(`${LOG} | a door changed state, so ${foes.length} creature(s) and `
      + `${pcs.length} player token(s) are measured again.`);
    for (const foe of foes) for (const pc of pcs) await PerceptionWatch._pair(foe, pc);
  }

  /* ═══ The three cases ═════════════════════════════════════════════════════ */

  /**
   * One creature, one player character. Decides which of the three moments this
   * is, if any, and asks.
   */
  static async _pair(foeDoc, pcDoc, { pcAt = null, foeAt = null } = {}) {
    const key = `${foeDoc.id}>${pcDoc.id}`;
    const scene = pcDoc.parent ?? canvas?.scene;
    if (PerceptionWatch._asking.has(key)) return;      // a second move in the same tick
    /* ⚠️ ALREADY SEEN MEANS NOTHING AGAIN: not another step, not a door, not
       hearing. Keyed on the creature, so every creature in a group it was part of
       is quiet too. A pair that was only WATCHED, or only HEARD, is not done: the
       mutual sighting is still ahead of it, and that is the one that pauses. */
    if (PerceptionWatch._isSeen(scene, foeDoc.id)) return;
    if (!PerceptionWatch._awake(pcDoc)) return;

    const foe = foeDoc.actor;
    const pc = pcDoc.actor;
    if (!foe || !pc) return;

    /* ⚠️ MEASURE FROM WHERE HE IS GOING. The caller hands over the destination
       off the update; `aceDistanceFt` reads the document, which may not have
       caught up yet (2026-09-02: the document lagged its own update and the
       aura measured the square he had LEFT). */
    const ft = PerceptionWatch._feet(foeDoc, pcDoc, { pcAt, foeAt });

    const foeSees = PerceptionWatch._sees(foeDoc, pcDoc, ft);
    const pcSees = PerceptionWatch._sees(pcDoc, foeDoc, ft);

    // The fourth case: he sees it, it does not see him. Nothing at all.
    if (!foeSees.yes && pcSees.yes) {
      console.log(`${LOG} | ${pcDoc.name} can see ${foeDoc.name} and is not seen back `
        + `(${foeSees.why}), so nothing is asked. He can back off.`);
      return;
    }

    if (foeSees.yes && pcSees.yes) {
      /* ⚠️ ONE HOP, AND ONE WINDOW FOR THE WHOLE GROUP (his rule): the creature
         that saw him plus every hostile that can see THAT creature, and the
         player who was seen plus every player who can see HIM. Not one window
         per creature, and not one per player. */
      const group = PerceptionWatch._group(foeDoc, pcDoc, scene);
      return PerceptionWatch._ask({
        kind: "mutual", foeDoc, pcDoc, ft, group,
        line: `${foeDoc.name} and ${pcDoc.name} can see each other.`,
        why: `${foeDoc.name}: ${foeSees.why}. ${pcDoc.name}: ${pcSees.why}.`,
      });
    }

    if (foeSees.yes && !pcSees.yes) {
      // Shown once per pair, and it does not consume the mutual sighting to come.
      if (PerceptionWatch._isWatched(scene, key)) return;
      return PerceptionWatch._ask({
        kind: "oneWay", foeDoc, pcDoc, ft,
        line: `${foeDoc.name} can see ${pcDoc.name}. ${pcDoc.name} cannot see it.`,
        why: `${foeDoc.name}: ${foeSees.why}. ${pcDoc.name}: ${pcSees.why}.`,
      });
    }

    // Neither sees the other. Does it HEAR him?
    // ⚠️ AND A HEARING IS ASKED ONCE PER PAIR, not once per creature: this one
    // does not consume the sighting that may come when the door opens.
    if (PerceptionWatch._isHeard(scene, key)) return;
    const heard = PerceptionWatch._hears(foeDoc, pcDoc, ft, { pcAt, foeAt });
    if (!heard.yes) return;
    return PerceptionWatch._ask({
      kind: "heard", foeDoc, pcDoc, ft,
      // ⚠️ THE NAME IS ON THE GM'S POPUP ONLY. The creature heard a sound; it
      // does not know whose.
      line: `${foeDoc.name} hears something outside.`,
      why: `neither can see the other (${foeSees.why}); ${heard.why}, ${Math.round(ft)} ft away`,
    });
  }

  /**
   * The group a sighting belongs to, one hop each way.
   *
   * ⚠️ ONE HOP, NOT A CHAIN. A hostile that can see the creature that spotted
   * him is in; a hostile that can only see THAT one is not. Same on the player
   * side. A chain would swallow a whole dungeon off one glance.
   */
  static _group(foeDoc, pcDoc, scene) {
    const { pcs, foes } = PerceptionWatch._sides(scene);
    const creatures = [foeDoc];
    for (const f of foes) {
      if (f.id === foeDoc.id) continue;
      if (PerceptionWatch._sees(f, foeDoc, PerceptionWatch._feet(f, foeDoc, {})).yes) creatures.push(f);
    }
    const players = [pcDoc];
    for (const p of pcs) {
      if (p.id === pcDoc.id) continue;
      if (!PerceptionWatch._awake(p)) continue;
      if (PerceptionWatch._sees(p, pcDoc, PerceptionWatch._feet(p, pcDoc, {})).yes) players.push(p);
    }
    return { creatures, players };
  }

  /**
   * Feet between them, edge to edge, measured from the destination when there is
   * one.
   *
   * ⚠️ `aceTokenSpace` TAKES THE HYPOTHETICAL POSITION ITSELF, which is the
   * same door the opportunity-attack path uses to measure a square a token has
   * not reached yet. Handing a made-up object to `aceDistanceFt` instead would
   * have gone through `aceMeasuredPosition`, which reads the real document and
   * would have quietly measured the square he LEFT: the exact bug its own
   * comment is about.
   */
  static _feet(foeDoc, pcDoc, { pcAt, foeAt }) {
    try {
      return aceSpaceDistanceFt(aceTokenSpace(foeDoc, foeAt ?? null),
                                aceTokenSpace(pcDoc, pcAt ?? null));
    } catch (err) {
      console.warn(`${LOG} | could not measure ${foeDoc?.name} to ${pcDoc?.name}:`, err);
      return NaN;
    }
  }

  /**
   * Can the viewer see the subject? The one reader, plus the hidden rule.
   * @returns {{yes: boolean, why: string}}
   */
  static _sees(viewerDoc, subjectDoc, ft) {
    let out = { canSee: true, why: "not tested" };
    try {
      out = Situation.canSee(viewerDoc.actor, subjectDoc.actor, {
        viewerToken: viewerDoc.object ?? viewerDoc,
        subjectToken: subjectDoc.object ?? subjectDoc,
        distanceFt: Number.isFinite(ft) ? ft : undefined,
      }) ?? out;
    } catch (err) {
      console.warn(`${LOG} | the sight reader threw on ${viewerDoc?.name} → ${subjectDoc?.name}, `
        + `so it counts as seen and nothing is hidden from view by accident:`, err);
    }
    if (!out.canSee) return { yes: false, why: out.why };

    /* ⚠️ HIDING BEATS A CLEAR LINE OF SIGHT. The stealth engine owns the
       comparison; a second copy of it here is how two answers to one question
       drift apart. */
    try {
      if (StealthEngine.attackerHiddenFromTarget(subjectDoc.object ?? subjectDoc,
                                                 viewerDoc.object ?? viewerDoc)) {
        return { yes: false, why: `${subjectDoc.name} is hidden and beat its passive Perception` };
      }
    } catch (err) {
      console.warn(`${LOG} | could not ask whether ${subjectDoc?.name} is hidden:`, err);
    }
    return { yes: true, why: out.why };
  }

  /**
   * Sound only: the sight line is blocked but a sound line is not, and they are
   * close enough for footsteps to matter.
   */
  static _hears(foeDoc, pcDoc, ft, { pcAt, foeAt } = {}) {
    if (!Number.isFinite(ft)) return { yes: false, why: "the distance could not be measured" };
    // ⚠️ THE SAME MEASURE AS THE AURAS AND THE SECRET DOOR, with the epsilon
    // that lets an exact thirty feet count as thirty feet.
    if (ft > HEARING_FT + 0.1) return { yes: false, why: `further than ${HEARING_FT} feet` };

    const backend = CONFIG.Canvas?.polygonBackends?.sound;
    if (!backend?.testCollision) {
      // ⚠️ A TEST THAT CANNOT RUN SAYS SO. It must not answer "heard" on its own.
      console.warn(`${LOG} | Foundry has no sound backend on this client, so nothing can be `
        + `said about what ${foeDoc.name} heard.`);
      return { yes: false, why: "there is no sound backend to ask" };
    }
    const from = PerceptionWatch._centre(foeDoc, foeAt);
    const to = PerceptionWatch._centre(pcDoc, pcAt);
    try {
      const blocked = backend.testCollision(from, to, { type: "sound", mode: "any" });
      return blocked
        ? { yes: false, why: "the sound is blocked too" }
        : { yes: true, why: "the sound path is clear" };
    } catch (err) {
      console.warn(`${LOG} | the sound test threw, so nothing is claimed about hearing:`, err);
      return { yes: false, why: "the sound test could not run" };
    }
  }

  /** The middle of a token, at its destination when one was given. */
  static _centre(tokenDoc, at = null) {
    const grid = canvas?.grid?.size ?? canvas?.scene?.grid?.size ?? 100;
    const x = (at?.x ?? tokenDoc.x) + (Number(tokenDoc.width) || 1) * grid / 2;
    const y = (at?.y ?? tokenDoc.y) + (Number(tokenDoc.height) || 1) * grid / 2;
    return { x, y };
  }

  /* ═══ The popup ═══════════════════════════════════════════════════════════ */

  /**
   * One popup, three buttons, and nothing happens that he did not press.
   *
   * ⚠️ THE PAUSE IS FOR MUTUAL SIGHT ONLY. On a one-way sighting or a sound, a
   * pause banner would tell the whole table they have been spotted.
   */
  static async _ask({ kind, foeDoc, pcDoc, ft, line, why, group = null }) {
    const key = `${foeDoc.id}>${pcDoc.id}`;
    const scene = pcDoc.parent ?? canvas?.scene;
    const creatures = group?.creatures ?? [foeDoc];
    PerceptionWatch._asking.add(key);
    console.log(`${LOG} | ${line} (${Math.round(ft)} ft) — ${why}`);
    if (group && (group.creatures.length > 1 || group.players.length > 1)) {
      // Name them. A bare count is no use to him.
      console.log(`${LOG} |   the group: ${group.creatures.map(c => c.name).join(", ")} `
        + `against ${group.players.map(p => p.name).join(", ")}.`);
    }

    /* ⚠️ WRITTEN NOW, NOT WHEN HE ANSWERS. The popup being on screen is not
       what stops the second one: having been shown is.
         a mutual sighting  -> seen, for every creature in the group
         a one-way sighting -> watched, for that pair alone
         a hearing          -> heard, for that pair alone
       Only the first of those is the pause, and only the first is total. */
    await PerceptionWatch._write(scene,
      kind === "mutual" ? { seen: creatures.map(c => c.id) }
      : kind === "oneWay" ? { watched: [key] }
      : { heard: [key] }, line);

    if (kind === "mutual") {
      await PerceptionWatch._lockDown(pcDoc.parent ?? canvas?.scene);
      try { if (!game.paused) game.togglePause(true); }
      catch (err) { console.warn(`${LOG} | could not pause the game:`, err); }
    }

    const esc = (s) => foundry.utils.escapeHTML(String(s ?? ""));
    const others = group
      ? [group.creatures.filter(c => c.id !== foeDoc.id).map(c => c.name),
         group.players.filter(p => p.id !== pcDoc.id).map(p => p.name)]
      : [[], []];
    const alsoHtml = (others[0].length || others[1].length)
      ? `<p class="ace-perceived-also">With ${foundry.utils.escapeHTML(foeDoc.name)}: `
        + `${others[0].length ? foundry.utils.escapeHTML(others[0].join(", ")) : "nobody"}. `
        + `Watching ${foundry.utils.escapeHTML(pcDoc.name)}: `
        + `${others[1].length ? foundry.utils.escapeHTML(others[1].join(", ")) : "nobody"}.</p>`
      : "";
    const subtitle = kind === "mutual" ? "The game is paused and nobody is moving."
      : kind === "oneWay" ? "The table has not been told."
      : `Sight is blocked, the sound is not. ${esc(pcDoc.name)} is ${Math.round(ft)} feet away.`;

    const content = `
      <div class="ace-perceived">
        <div class="ace-perceived-who">
          ${foeDoc.actor?.img ? `<img class="ace-perceived-face" src="${esc(foeDoc.actor.img)}" alt="" />` : ""}
          <div>
            <div class="ace-perceived-line">${esc(line)}</div>
            <div class="ace-perceived-sub">${subtitle}</div>
          </div>
          ${pcDoc.actor?.img ? `<img class="ace-perceived-face" src="${esc(pcDoc.actor.img)}" alt="" />` : ""}
        </div>
        ${alsoHtml}
        <p class="ace-perceived-why">${esc(why)}</p>
      </div>`;

    let answered = false;
    const settle = async (choice) => {
      if (answered) return;
      answered = true;
      PerceptionWatch._asking.delete(key);
      /* ⚠️ THE CLOSE HANDLER IS NOT AWAITED BY FOUNDRY, so a throw in here
         would be an unhandled rejection and the table could be left locked
         with nothing on screen. It says what happened and lets go. */
      try {
        await PerceptionWatch._answer(choice, { kind, foeDoc, pcDoc, creatures });
      } catch (err) {
        console.error(`${LOG} | "${choice}" failed on ${foeDoc?.name} / ${pcDoc?.name}, `
          + `so the table is released:`, err);
        try { await PerceptionWatch._unlock(pcDoc.parent ?? canvas?.scene); } catch (_) {}
      }
    };

    try {
      const dlg = new foundry.applications.api.DialogV2({
        window: { title: `${foeDoc.name} — noticed` },
        classes: ["ace-perceived-dialog"],
        content,
        position: { width: 540 },
        rejectClose: false,
        buttons: [
          { action: "wait", label: "Wait", callback: () => settle("wait") },
          { action: "ready", label: "Ready", callback: () => settle("ready") },
          { action: "roll", label: "Roll initiative", default: true, callback: () => settle("roll") },
        ],
        /* ⚠️ A WINDOW CLOSED WITH ESCAPE IS "WAIT". Leaving the lock on with no
           popup on screen would freeze his table with nothing to click. */
        close: () => { settle("wait"); },
      });
      await dlg.render({ force: true });
      try { popupDing(`${foeDoc.name} noticed somebody`); } catch (_) { /* a silent ding is not a bug */ }
    } catch (err) {
      console.error(`${LOG} | the popup could not open, so the table is released and nothing `
        + `was rolled:`, err);
      PerceptionWatch._asking.delete(key);
      await PerceptionWatch._unlock(pcDoc.parent ?? canvas?.scene);
      try { if (game.paused) game.togglePause(false); } catch (_) {}
    }
  }

  /** What each button does, and nothing more than that. */
  static async _answer(choice, { kind, foeDoc, pcDoc, creatures = null }) {
    const who = `${foeDoc.name} / ${pcDoc.name}`;

    if (choice === "wait") {
      // Unpause, let go, no combatant. Only a mutual sighting ever paused.
      if (kind === "mutual") {
        await PerceptionWatch._unlock(pcDoc.parent ?? canvas?.scene);
        try { if (game.paused) game.togglePause(false); }
        catch (err) { console.warn(`${LOG} | could not unpause:`, err); }
      }
      console.log(`${LOG} | ${who}: WAIT. ${kind === "mutual"
        ? "Unpaused, the lock is off, and nobody was added to a tracker."
        : "Nothing was done to the table."}`);
      return;
    }

    if (choice === "ready") {
      /* The creature is ready, and that is all. The pause and the lock stay
         exactly as they are: his rule. They lift when he unpauses. */
      try {
        await foeDoc.setFlag(MODULE_ID, "perceptionReady", {
          of: pcDoc.id, at: game.time?.worldTime ?? 0, stamp: Date.now(),
        });
      } catch (err) {
        console.warn(`${LOG} | could not write that ${foeDoc.name} is ready:`, err);
      }
      console.log(`${LOG} | ${who}: READY. ${foeDoc.name} is waiting, nothing was rolled`
        + `${kind === "mutual" ? ", and the pause and the lock stay on until you unpause" : ""}.`);
      return;
    }

    if (choice !== "roll") return;

    /* ⚠️🔴 THOSE CREATURES, AND NOBODY ELSE. The group he was shown, one
       `rollInitiative()` each: no PC, no bystander, no `rollAllNpcs`, no
       `_populate`, and no turn started for the table. */
    let combat = null;
    try { combat = await InitiativeTools.ensureCombat(); }
    catch (err) { console.error(`${LOG} | could not open an encounter:`, err); }
    if (!combat) {
      console.warn(`${LOG} | ${who}: ROLL pressed and there is no encounter to add to, so `
        + `nothing was rolled.`);
      return;
    }

    const rolled = [];
    for (const doc of (creatures ?? [foeDoc])) {
      const one = await PerceptionWatch._addAndRoll(combat, doc);
      if (one) rolled.push(one);
    }
    if (!rolled.length) return;

    console.log(`${LOG} | ${who}: ROLL. ${rolled.join(", ")}. No PC was rolled, nobody else was `
      + `added, and no turn was started.`
      + `${kind === "mutual" ? " The pause and the lock stay on until you unpause." : ""}`);
    try {
      ui.notifications?.info(`Initiative: ${rolled.join(", ")}. No players were added.`);
    } catch (_) { /* the console has it */ }
  }

  /**
   * One creature into the tracker, and one roll for it.
   * @returns {Promise<string|null>} "Name on 14", or null when nothing happened
   */
  static async _addAndRoll(combat, tokenDoc) {
    if (!combat || !tokenDoc) return null;
    let combatant = combat.combatants.find(c => c.tokenId === tokenDoc.id);
    if (!combatant) {
      try {
        // dice-ok: a combatant has to exist before it can roll. Nothing is
        // decided yet at this line; the roll is below and its number is read
        // only after the dice have landed.
        const [made] = await combat.createEmbeddedDocuments("Combatant", [{
          tokenId: tokenDoc.id,
          sceneId: tokenDoc.parent?.id ?? canvas.scene?.id,
          actorId: tokenDoc.actor?.id,
          // A hidden creature stays hidden in the tracker: an ambush that
          // announces itself is not an ambush.
          hidden: !!tokenDoc.hidden,
        }]);
        combatant = made;
      } catch (err) {
        console.error(`${LOG} | could not add ${tokenDoc.name} to the encounter:`, err);
        return null;
      }
    }
    if (!combatant) return null;
    if (combatant.initiative !== null && combatant.initiative !== undefined) {
      return `${tokenDoc.name} was already on ${combatant.initiative}`;
    }
    try {
      // The same call the single-creature buttons use, so Alert and the rest of
      // the feats are respected. One combatant at a time, nobody else.
      await combatant.rollInitiative();
      /* ⚠️🔴 NOTHING SHOWS THE NUMBER BEFORE ITS DICE LAND (his rule, caught by
         dice-check 2026-10-05). `rollInitiative` posts a card and resolves while
         the dice are still in the air, so the line below, the GM chat line and
         the toast all read an initiative the table had not seen rolled yet. */
      await awaitDiceSettle(15000);
    } catch (err) {
      console.error(`${LOG} | ${tokenDoc.name}'s initiative roll failed:`, err);
      return null;
    }
    return `${tokenDoc.name} on ${combatant.initiative ?? "?"}`;
  }

  /* ═══ Once the fight is on ══════════════════════════════════════════ */

  /**
   * A hostile that can see somebody already fighting joins the fight.
   *
   * His rule, 2026-10-05: "Once combat is started, do not popup. A hostile that
   * is not yet in the combat, and can itself see a token already in the combat,
   * is added and rollInitiative() is called on that one combatant. No hop. No
   * player chat. One GM chat line naming the creature."
   *
   * ⚠️ HEARING ROLLS NOTHING. The sound test is not asked on this path at all:
   * a creature that hears the fight through a wall is not in it.
   */
  static async _joinFight(scene, { at = null, moved = null } = {}) {
    const combat = game.combat;
    if (!scene || !combat?.started) return;

    const inFight = new Set(combat.combatants.map(c => c.tokenId).filter(Boolean));
    const seats = combat.combatants.map(c => c.token).filter(Boolean);
    if (!seats.length) return;

    const { foes } = PerceptionWatch._sides(scene);
    for (const foe of foes) {
      if (inFight.has(foe.id)) continue;
      /* ⚠️ SKIP THE DOWN AND THE HIDDEN (his rule). `_sides` already drops the
         dead, the unconscious and the incapacitated; a token the players cannot
         see is the GM's ambush and is not dragged into the tracker by a walk. */
      if (foe.hidden) {
        console.log(`${LOG} | ${foe.name} can see the fight and is hidden from the players, `
          + `so it was left out of the tracker.`);
        continue;
      }
      let sawWho = null;
      for (const seat of seats) {
        if (seat.id === foe.id) continue;
        const where = (moved && seat.id === moved.id) ? at : null;
        const ft = PerceptionWatch._feet(foe, seat, { pcAt: where });
        if (PerceptionWatch._sees(foe, seat, ft).yes) { sawWho = seat; break; }
      }
      if (!sawWho) continue;

      const said = await PerceptionWatch._addAndRoll(combat, foe);
      if (!said) continue;
      console.log(`${LOG} | the fight is on: ${said}, because it can see ${sawWho.name}.`);
      await PerceptionWatch._gmLine(`<strong>${foundry.utils.escapeHTML(foe.name)}</strong> `
        + `joins the fight: it can see ${foundry.utils.escapeHTML(sawWho.name)}. ${said}.`);
    }
  }

  /** One line, GM only. Never a plain card, and never to a player. */
  static async _gmLine(html) {
    try {
      const { CardDoor } = await import("./road/doors.mjs");
      await CardDoor.post({
        // ⚠️ THE BLACK ACE CARD (his rule, 2026-10-06: "Every card you post uses
        // that black ACE card. A pale line on the default chat background is not
        // a card."). This line had colour and no card behind it, so on a whisper
        // it was pale text on Foundry's parchment. It stays GM-only - what a
        // creature noticed is not the table's to read - but it is a card now.
        content: `<div class="ace-qol-card ace-perceived-note">${html}</div>`,
        whisper: (game.users ?? []).filter(u => u.isGM).map(u => u.id),
        flags: { [MODULE_ID]: { type: "perceptionJoined" } },
      }, { dice: false });
    } catch (err) {
      console.warn(`${LOG} | could not post the GM line (the console has it):`, err);
    }
  }
}
