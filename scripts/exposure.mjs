// ─── ACE QOL — An hour in extreme cold or extreme heat ────────────────────────
//
// His rule, 2026-10-13: "The hourly exhaustion check stays. The cold switch does
// not. Temperature lives on the scene, and an empty scene never rolls."
//
//   • ONE NUMBER ON THE SCENE: Temperature (°C) on the scene configuration.
//     Blank means no hazard, and no scene is ever given a number by default.
//     −20 or colder is extreme cold; 40 or hotter is extreme heat; everything in
//     between, 20 included, does nothing.
//   • THE HOUR LOOKS AT THE SCENE THE TOKENS STAND ON WHEN THE CLOCK CROSSES IT.
//     Each change of the clock counts the hour marks it crossed, on the
//     calendar's own hour, against the active scene at that moment (his rule,
//     2026-10-13: "A jump of the world clock no longer runs one check per hour it
//     crosses."):
//       one mark forward   the check, once.
//       two or more        nothing rolls; ONE question on the GM's screen,
//                          Resolve or Leave it (closing it is Leave it). Resolve
//                          runs the same check once for the whole jump.
//       backward           nothing rolls and no level comes off; one line on
//                          the GM's screen.
//     A scene with no hazard never asks and never prints the line. Leaving the
//     hazard takes no level away; a long rest still removes one, as dnd5e does.
//   • THE SAVE: Constitution, DC 10. Any failed save gains exactly 1 level,
//     capped at the last; a natural 1 is not special (his correction, 14:21: "A
//     natural 1 is one level. Not two."). A natural 20 removes 1, and does
//     nothing at 0. A pass changes nothing.
//   • THREE NOISES, NEVER MIXED. Player characters: the dice on the screen and
//     their own save card. Friendly NPCs and every other creature: in silence,
//     their level applied here. ONE GM card for the hour, only when a level
//     changed.
//
// ⚠️🔴 ON THE ROAD (his rule, the same afternoon: "The hour check left the road.
// It rolls a plain dnd5e save, and it decides cold resistance and fire
// resistance by itself. Take both of those out."):
//   • ONE READER. Who is skipped is asked of the target profile: dead, immune to
//     the exhaustion condition, already at the last level, immune or resistant to
//     the hazard's damage type. Nothing here reads a trait, an item or a word of
//     prose. An attuned Ring of Warmth is cold resistance on the sheet, so the
//     profile's resistance answers it; "adapted to a climate" is prose, and the
//     profile does not interpret prose (his rule, 14:21).
//   • ONE SAVE. Player, friendly NPC and creature all roll on the save engine's
//     own road (its gate, its bonuses, its advantage, its Lucky) with the
//     creature's own save situation (CombatState.saveSituation, the same
//     question assess asks). Silence is a flag on that road: no dice on screen,
//     no pop-up, no card per creature. Legendary Resistance still runs on a failed
//     save, through the reaction engine, which asks only the creatures that have
//     it.
//
// ⚠️ ONE WRITER. The active GM rolls and writes, as the day rollover does.
// ⚠️ The profile and the save engine are loaded when they are used, never at
// load: situation.mjs imports the entry file back (the 2026-08-19 cycle).
// ──────────────────────────────────────────────────────────────────────────────

import { writeExhaustion, exhaustionMax } from "./exhaustion.mjs";
import { faceOf } from "./face.mjs";
import { notACreature } from "./road/picker-rule.mjs";

const MODULE_ID = "ace-qol";
const LOG = "ace-qol | Exposure";
const DC = 10;

/**
 * Seconds in an hour on this world's calendar. The clock's :00 is a whole number
 * of these from world time 0 (Foundry's CalendarData counts whole days from 0),
 * whether world time is positive or, as in hijinx, far below zero.
 */
function _hourSeconds() {
  const d = game.time?.calendar?.days ?? {};
  const n = (Number(d.secondsPerMinute) || 60) * (Number(d.minutesPerHour) || 60);
  return n > 0 ? n : 3600;
}

/**
 * Seconds until the clock next reaches :00, read off the calendar's own minute
 * and second: at :13 it is 47 minutes, never more than an hour, and a full hour
 * on the hour itself (his correction, 14:21: "save in 73 minutes" came from a
 * remainder taken of a world time below zero).
 */
function _secondsToTheHour() {
  const hour = _hourSeconds();
  try {
    const c = game.time?.components;
    const perMin = Number(game.time?.calendar?.days?.secondsPerMinute) || 60;
    if (c && Number.isFinite(Number(c.minute)) && Number.isFinite(Number(c.second))) {
      return hour - (Number(c.minute) * perMin + Number(c.second));
    }
  } catch (_) { /* the arithmetic below says the same */ }
  const t = Number(game.time?.worldTime) || 0;
  return hour - (((t % hour) + hour) % hour);
}

/**
 * The hour marks one change of the clock crossed, on the calendar's own hour:
 * positive forward, zero inside one hour, negative back. Floor, not a cast, so
 * a world time below zero (hijinx) counts the same marks the clock face shows.
 */
function _marksCrossed(from, to) {
  const hour = _hourSeconds();
  return Math.floor(to / hour) - Math.floor(from / hour);
}

const COLD_AT = -20;
const HEAT_AT = 40;

const _esc = (s) => foundry.utils.escapeHTML(String(s ?? ""));

export const HAZARDS = {
  cold: { key: "cold", name: "Extreme cold", damage: "cold", glyph: "fa-snowflake",
          icon: "icons/magic/water/snowflake-ice-blue-white.webp", colour: "#8fc3e8" },
  heat: { key: "heat", name: "Extreme heat", damage: "fire", glyph: "fa-temperature-high",
          icon: "icons/magic/light/beam-rays-orange.webp", colour: "#ff9100" },
};

/**
 * The scene's Temperature (°C): null when the field is blank, NaN when it holds
 * something that is not a number. The two are never the same answer: "nothing
 * set" and "could not read what is set" print different lines.
 */
export function sceneTemperature(scene) {
  const raw = scene?.getFlag?.(MODULE_ID, "temperature");
  if (raw === null || raw === undefined || String(raw).trim() === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : NaN;
}

/** The hazard this scene's temperature makes, or null for none. */
export function hazardOf(scene) {
  const temp = sceneTemperature(scene);
  if (temp === null || Number.isNaN(temp)) return null;
  if (temp <= COLD_AT) return { ...HAZARDS.cold, temp };
  if (temp >= HEAT_AT) return { ...HAZARDS.heat, temp };
  return null;
}

/** "−30°C", "50°C". */
export function temperatureWords(temp) {
  return `${temp < 0 ? "−" : ""}${Math.abs(temp)}°C`;
}

/** The target profile builder, loaded once when the hour first needs it. */
let _profiles = null;
async function _loadProfiles() {
  if (!_profiles) _profiles = await import("./profiles/target-profile.mjs");
  return _profiles;
}

/**
 * Why this creature does not roll this hour, asked of its profile, or null
 * when it rolls. `out` is a creature the hour passes over (dead, immune to
 * exhaustion, at the last level); `protected` is one the hazard cannot touch,
 * which a player character's card names.
 */
export function whyNoSave(profile, hazard, max = exhaustionMax()) {
  if (!profile) return { kind: "out", why: "it has no profile" };
  if (profile.isDead) return { kind: "out", why: "dead" };
  if (profile.immuneToCondition("exhaustion")) return { kind: "out", why: "immune to exhaustion" };
  if (profile.exhaustion >= max) return { kind: "out", why: "at the last level of exhaustion" };
  if (profile.immuneToDamage(hazard.damage)) return { kind: "protected", why: `immune to ${hazard.damage}` };
  if (profile.resistantToDamage(hazard.damage)) return { kind: "protected", why: `resistant to ${hazard.damage}` };
  return null;
}

/** The scene the party is on: the one the players were pulled to. */
function _partyScene() {
  return game.scenes?.active ?? canvas?.scene ?? null;
}

function _isPC(actor) {
  if (actor?.hasPlayerOwner) return true;
  return (game.users ?? []).some(u => !u.isGM && u.character?.id === actor?.id);
}

/**
 * Every creature on the scene, once each, and which noise it makes: a player
 * character ("pc"), a friendly NPC ("friend"), or anyone else ("other"). A
 * linked creature is one creature however many tokens it has; an unlinked token
 * is its own creature. A vehicle is not a creature.
 */
function _creaturesOn(scene) {
  const seen = new Map();
  for (const doc of scene?.tokens ?? []) {
    const actor = doc.actor;
    if (!actor || (actor.type !== "character" && actor.type !== "npc")) continue;
    if (notACreature(actor, doc)) continue;   // a Spiritual Weapon feels no cold
    const id = doc.actorLink ? `a:${doc.actorId}` : `t:${doc.id}`;
    if (seen.has(id)) continue;
    const group = _isPC(actor) ? "pc"
      : doc.disposition === CONST.TOKEN_DISPOSITIONS.FRIENDLY ? "friend" : "other";
    seen.set(id, { actor, doc, group, name: doc.name || actor.name });
  }
  return [...seen.values()];
}

/**
 * What the save does to the level: a natural 20 removes 1, any failure adds
 * exactly 1, a pass changes nothing. There is no path that adds 2. A save
 * Legendary Resistance turned into a success is a success.
 */
function _change(row) {
  if (row?.legendaryResistance) return 0;
  if (Number(row?.dieResult) === 20) return -1;
  return row?.passed ? 0 : 1;
}

export const Exposure = {
  _busy: false,
  /** Clock changes waiting their turn, each with the scene and hazard it crossed. */
  _queue: [],

  register() {
    // Foundry hands every change its own size, so one change is one answer:
    // two advances of an hour are two checks, never one jump of two.
    Hooks.on("updateWorldTime", (worldTime, dt) => {
      if (game.users?.activeGM !== game.user) return;
      Exposure.clockMoved(Number(worldTime), Number(dt));
    });
    // The effects panel asks synchronously, so the profile is ready by then.
    _loadProfiles().catch(err => console.warn(`${LOG} | the target profile did not load:`, err));
    if (game.users?.activeGM === game.user) {
      Exposure._clearTheOldSwitches().catch(err => console.warn(`${LOG} | could not clear the old cold switches:`, err));
    }
    console.debug(`${LOG} | the hour checks each scene's Temperature (°C)`);
  },

  /**
   * One change of the clock, on the active GM's client. The scene and hazard
   * are the ones it crossed, read now; the check itself waits its turn.
   */
  clockMoved(worldTime, dt) {
    if (!Number.isFinite(worldTime) || !Number.isFinite(dt) || dt === 0) return;
    const scene = _partyScene();
    const hazard = hazardOf(scene);
    const marks = _marksCrossed(worldTime - dt, worldTime);
    if (!hazard) {
      if (marks !== 0) {
        const t = sceneTemperature(scene);
        const where = `the clock crossed ${marks} hour mark(s) on "${scene?.name ?? "no scene"}"`;
        if (Number.isNaN(t)) {
          console.warn(`${LOG} | ${where}, but its Temperature field holds `
            + `"${scene.getFlag(MODULE_ID, "temperature")}", which is not a number, so nobody was checked.`);
        } else {
          console.debug(`${LOG} | ${where}: `
            + `${t === null ? "no temperature set" : `${temperatureWords(t)}, no hazard`}.`);
        }
      }
      return;
    }
    // Backward crosses nothing: no question, no roll, no level taken off.
    if (dt < 0) {
      const words = `The clock went back, and the ${hazard.key} was left alone.`;
      console.log(`${LOG} | ${words} (${hazard.name}, ${temperatureWords(hazard.temp)}, "${scene.name}")`);
      ui.notifications?.info(words);
      return;
    }
    if (marks < 1) return;
    Exposure._queue.push({ scene, hazard, marks });
    Exposure._drain();
  },

  /** One change at a time, in the order the clock moved. */
  async _drain() {
    if (Exposure._busy) return;
    Exposure._busy = true;
    try {
      while (Exposure._queue.length) {
        const job = Exposure._queue.shift();
        try {
          await Exposure._crossed(job);
        } catch (err) {
          console.error(`${LOG} | the check for ${job.marks} hour mark(s) of ${job.hazard.name.toLowerCase()} `
            + `failed; nobody was rolled for it:`, err);
        }
      }
    } finally {
      Exposure._busy = false;
    }
  },

  /** One mark is the check; two or more is the GM's question first. */
  async _crossed({ scene, hazard, marks }) {
    if (!game.scenes?.get(scene.id)) {
      console.log(`${LOG} | "${scene.name}" is gone, so the ${marks} hour mark(s) it crossed roll nothing.`);
      return;
    }
    if (marks === 1) return Exposure._oneHour(scene, hazard);
    if ((await Exposure._askJump(hazard, marks)) !== "resolve") {
      console.log(`${LOG} | the clock jumped ${marks} hours in ${hazard.name.toLowerCase()} on "${scene.name}", `
        + `and the GM left the ${hazard.key} alone. Nothing rolled.`);
      return;
    }
    await Exposure._oneHour(scene, hazard, marks);
  },

  /**
   * One check on one scene. `jump` is the hours a resolved jump covered; it is
   * still one save each, and one failure is one level.
   */
  async _oneHour(scene, hazard, jump = 1) {
    const engine = game.aceQol?.saveEngine;
    if (typeof engine?._rollSingleSave !== "function") {
      console.warn(`${LOG} | ${hazard.name} on "${scene.name}": the save engine is not here, so nobody rolled this hour.`);
      return;
    }
    const { buildTargetProfile } = await _loadProfiles();
    const { CombatState } = await import("./combat-state.mjs");
    const max = exhaustionMax();

    const rollers = [];
    const shelteredPCs = [];
    for (const c of _creaturesOn(scene)) {
      const profile = buildTargetProfile(c.actor, { token: c.doc.object ?? c.doc });
      const no = whyNoSave(profile, hazard, max);
      if (no) { if (no.kind === "protected" && c.group === "pc") shelteredPCs.push({ ...c, why: no.why }); continue; }
      rollers.push(c);
    }
    console.log(`${LOG} | ${hazard.name}, ${temperatureWords(hazard.temp)}, on "${scene.name}"`
      + `${jump > 1 ? `, once for a jump of ${jump} hours` : ""}: ${rollers.length} creature(s) roll.`);

    // Every creature's save on the save engine's own road. Player characters
    // show their dice; everyone else is silent.
    const roll = async (c) => {
      const sit = CombatState.saveSituation(c.actor, c.doc.object ?? null, { saveAbility: "con", isSpell: false });
      const hp = c.actor.system?.attributes?.hp ?? {};
      const tgt = {
        tokenId: c.doc.id, tokenDocId: c.doc.id, sceneId: c.doc.parent?.id ?? scene.id, actorId: c.doc.actorId,
        name: c.name, img: faceOf(c.actor),
        autoFailSave: !!sit.autoFailSave, saveAdvantage: !!sit.saveAdvantage, saveDisadvantage: !!sit.saveDisadvantage,
        saveAdvReasons: sit.saveAdvReasons ?? [], saveDisadvReasons: sit.saveDisadvReasons ?? [],
        superSaver: !!sit.superSaver, saveBonuses: sit.saveBonuses ?? [], damageModifiers: {},
        currentHP: hp.value ?? null, maxHP: hp.max ?? null,
      };
      try {
        const row = await engine._rollSingleSave(tgt, "con", DC, null, null, {
          silent: c.group !== "pc", isMultiTarget: true,
          outcomeConditions: ["exhaustion"], dealsDamage: false, damageTypes: [], magical: false,
        });
        if (!row || row.noRoll) {
          if (row?.noRoll) console.log(`${LOG} | ${c.name} was not rolled: ${row.noRollLabel ?? row.reason ?? "the gate refused"}.`);
          return null;
        }
        return { c, row };
      } catch (err) {
        console.warn(`${LOG} | ${c.name}'s save could not be rolled; it is skipped this hour:`, err);
        return null;
      }
    };

    // 1. Player characters: their dice on screen, then their save card.
    const pcs = [];
    for (const c of rollers.filter(x => x.group === "pc")) { const r = await roll(c); if (r) pcs.push(r); }
    if (pcs.length) await Exposure._pcCard(hazard, pcs, shelteredPCs);

    // 2 and 3. Everyone else, in silence.
    const npcs = [];
    for (const c of rollers.filter(x => x.group !== "pc")) { const r = await roll(c); if (r) npcs.push(r); }
    await Exposure._legendaryResistance(npcs, hazard);

    const named = [];
    let gained = 0, lost = 0;
    for (const { c, row } of npcs) {
      const cur = Number(c.actor.system?.attributes?.exhaustion) || 0;
      const next = Math.max(0, Math.min(max, cur + _change(row)));
      if (next === cur) continue;
      // Only a level that was written is reported; a failed write has already
      // named the creature in the console and on the GM's screen.
      const why = `${hazard.name}, ${temperatureWords(hazard.temp)}, d20 ${row.dieResult}`;
      // Every save in this loop was rolled silent, so no die was thrown for it;
      // the players' dice were waited for in _pcCard before these began.
      // dice-ok: silent saves, and the players' dice have already landed
      const wrote = await writeExhaustion(c.actor, next, why, { cause: hazard.name });
      if (!wrote) continue;
      if (c.group === "friend") named.push({ name: c.name, by: next - cur, level: next });
      else if (next > cur) gained++;
      else lost++;
    }
    if (named.length || gained || lost) await Exposure._hourCard(hazard, named, gained, lost);
  },

  /**
   * Legendary Resistance on a failed save, the way the save card offers it: the
   * reaction engine, which asks only the creatures that have it.
   */
  async _legendaryResistance(npcs, hazard) {
    const reactions = game.aceQol?.reactionEngine;
    if (!npcs.length || typeof reactions?.checkPostSaveReactions !== "function") return;
    try {
      const enriched = npcs.map(({ c, row }, idx) => ({
        ...row, _idx: idx, actor: c.actor, ability: "con", dc: DC,
        total: row.saveTotal, saved: row.passed, sourceName: hazard.name,
      }));
      const modified = await reactions.checkPostSaveReactions(enriched);
      for (const m of (modified ?? [])) {
        const i = m?._idx;
        if (!Number.isInteger(i) || !npcs[i]) continue;
        if (m.legendaryResistance && m.saved) {
          npcs[i].row.passed = true;
          npcs[i].row.legendaryResistance = true;
        }
      }
    } catch (err) {
      console.error(`${LOG} | the reactions to a failed save could not be asked; the saves stand as rolled:`, err);
    }
  },

  /** The player characters' levels, after their dice, then their save card. */
  async _pcCard(hazard, pcs, sheltered) {
    const { CheckGate } = await import("./check-gate.mjs");
    const { SaveEngine } = await import("./save-engine.mjs");
    const { untilDiceLand } = await import("./road/dice-gate.mjs");
    const max = exhaustionMax();
    // ⚠️ NOTHING LANDS BEFORE THE DICE: the levels and the card wait for them,
    // through the same dice gate every door uses (its only backstop is the one
    // for a renderer that breaks mid-throw and would otherwise hang the hour).
    try {
      await untilDiceLand(true);
    } catch (err) {
      console.warn(`${LOG} | the wait for the players' dice failed; the levels and the card follow anyway:`, err);
    }
    // ⚠️ APPLY, THEN CARD (The One Road: "Never card-first. The card is a
    // report."). Each level is written first, and the card says what the sheet
    // now holds; a write that failed says so on the card instead of a level.
    const rows = [];
    for (const { c, row } of pcs) {
      const cur = Number(c.actor.system?.attributes?.exhaustion) || 0;
      const next = Math.max(0, Math.min(max, cur + _change(row)));
      let line = "";
      if (next !== cur) {
        const wrote = await writeExhaustion(c.actor, next,
          `${hazard.name}, ${temperatureWords(hazard.temp)}, d20 ${row.dieResult}`, { cause: hazard.name });
        line = wrote
          ? `<div class="ace-qol-save-landed">${next > cur ? "A level of exhaustion" : "A level of exhaustion comes off"}`
            + `: ${cur} → ${next}${next >= max ? ", the last level" : ""}.</div>`
          : `<div class="ace-qol-save-landed">Exhaustion could not be set to ${next}. See the console.</div>`;
      }
      rows.push({ ...row, name: _esc(c.name), extraHtml: `${row.extraHtml ?? ""}${line}` });
    }
    const actors = pcs.map(p => p.c.actor);
    const line = SaveEngine.castLineHtml({ name: hazard.name, img: hazard.icon }, "Constitution save", "",
      { isSpell: false, verb: "calls for a", dcText: `DC ${DC}`,
        rollers: actors.map(a => a.id), dcWhose: null });
    const extra = sheltered.length
      ? `<div class="ace-qol-save-landed" style="margin-top:6px;">No save: `
        + sheltered.map(s => `${_esc(s.name)} (${_esc(s.why)})`).join(", ") + `.</div>`
      : "";
    await CheckGate._postCheckCard({ actor: actors[0], roll: null, label: "Constitution saving throw",
      rows, dcText: `DC ${DC}`, line, extra, speaker: { alias: hazard.name },
      flags: { checkCard: true, exposure: hazard.key } });
  },

  /**
   * The GM's card for the hour: the cause and the number, a line per friendly
   * NPC whose level changed, a count for everyone else. No score, DC or formula.
   */
  async _hourCard(hazard, named, gained, lost) {
    const plural = (n, one, many) => (n === 1 ? one : many);
    const rows = named.map(n => `<div>${_esc(n.name)} ${n.by > 0 ? "gained" : "lost"} ${Math.abs(n.by)}. `
      + `Exhaustion ${n.level}. ${_esc(hazard.name)}.</div>`);
    if (gained) rows.push(`<div>${gained} ${plural(gained, "creature", "creatures")} gained a level.</div>`);
    if (lost) rows.push(`<div>${lost} ${plural(lost, "creature", "creatures")} lost a level.</div>`);
    try {
      // Through the card door (The One Road: no ChatMessage.create outside it).
      // The hour's saves were silent, so no dice are on screen to wait for.
      const { CardDoor } = await import("./road/doors.mjs");
      await CardDoor.post({
        content: `<div style="background:#0f1014;border:1px solid #d4af37;
                    border-radius:4px;padding:12px 14px;color:#c9bd94;font-size:16px;line-height:1.55;">
          <div class="ace-qol-card-head" style="font-size:18px;font-weight:700;color:${hazard.colour};margin:-12px -14px 6px;padding:8px 14px;border-radius:4px 4px 0 0;">${_esc(hazard.name)}, ${temperatureWords(hazard.temp)}.</div>
          ${rows.join("")}
        </div>`,
        speaker: { alias: hazard.name },
        whisper: ChatMessage.getWhisperRecipients("GM").map(u => u.id),
        flags: { [MODULE_ID]: { type: "exposureHour", exposure: hazard.key } },
      }, { dice: false });
    } catch (err) {
      console.warn(`${LOG} | the levels changed but the GM's card for the hour could not be posted:`, err);
    }
  },

  /**
   * The one question for a jump of two or more hours, on the active GM's screen
   * only. The markup is the fire engine's clock-jump question ("Still burning"),
   * in the hazard's colour. "resolve", or null for Leave it and for a closed
   * window.
   */
  async _askJump(hazard, hours) {
    const content = `
      <div style="background:linear-gradient(180deg,#15110d 0%,#0c0a08 100%);
                  border:2px solid #d4af37;border-radius:8px;padding:16px 18px;
                  color:#f0e4c0;font-family:'Signika','Helvetica Neue',sans-serif;">
        <div style="font-size:18px;font-weight:700;color:${hazard.colour};margin-bottom:6px;">
          <i class="fas ${hazard.glyph}" style="margin-right:8px;"></i>${_esc(hazard.name)}, ${temperatureWords(hazard.temp)}
        </div>
        <div style="font-size:16px;line-height:1.5;margin-bottom:8px;">
          The clock jumped ${hours} hours in ${hazard.name.toLowerCase()}, and the ${hazard.key} was left alone.
        </div>
        <div style="font-size:14px;color:#c0b288;font-style:italic;line-height:1.45;">
          Resolve rolls the check once, for the whole jump.
        </div>
      </div>`;
    try {
      const answer = await foundry.applications.api.DialogV2.wait({
        window: { title: `ACE — ${hazard.name}` },
        position: { width: 480 },
        content,
        modal: true,
        buttons: [
          { action: "resolve", label: "Resolve", icon: `fa-solid ${hazard.glyph}`, default: true },
          { action: "leave", label: "Leave it" },
        ],
        rejectClose: false,
      });
      return answer === "resolve" ? "resolve" : null;
    } catch (err) {
      console.warn(`${LOG} | the GM could not be asked about a jump of ${hours} hours; the ${hazard.key} was left alone:`, err);
      return null;
    }
  },

  /**
   * The old switches go (his rule, 2026-10-13: "do not keep honoring the old
   * world or party cold switch"): each creature's own cold clock, and the "With
   * the party" mark. Both were ACE's own records; each actor cleared is named.
   */
  async _clearTheOldSwitches() {
    const actors = [...(game.actors ?? [])];
    for (const doc of game.scenes?.active?.tokens ?? []) if (!doc.actorLink && doc.actor) actors.push(doc.actor);
    const cleared = [];
    for (const actor of actors) {
      try {
        const marks = (actor.effects ?? []).filter(e => e.statuses?.has?.("aceWithParty")).map(e => e.id);
        const clock = actor.flags?.[MODULE_ID]?.exposure !== undefined;
        if (!marks.length && !clock) continue;
        if (marks.length) await actor.deleteEmbeddedDocuments("ActiveEffect", marks);
        if (clock) await actor.update({ [`flags.${MODULE_ID}.-=exposure`]: null });
        cleared.push(actor.name);
      } catch (err) {
        console.warn(`${LOG} | could not clear the old cold switch from ${actor?.name}:`, err);
      }
    }
    if (cleared.length) console.log(`${LOG} | the old cold clock and "With the party" mark came off: ${cleared.join(", ")}.`);
  },

  /**
   * What the effects panel shows for this creature on the hazard scene: the
   * next hour's check, or what protects it. Asked of the same profile; writes
   * nothing.
   */
  statusFor(actor) {
    const out = [];
    try {
      const scene = _partyScene();
      const hazard = hazardOf(scene);
      if (!hazard || !actor || !_profiles) return out;
      const mine = _creaturesOn(scene).find(c => c.actor === actor || (c.doc.actorLink && c.doc.actorId === actor.id));
      if (!mine) return out;
      const no = whyNoSave(_profiles.buildTargetProfile(mine.actor, { token: mine.doc.object ?? mine.doc }), hazard);
      if (no?.kind === "out" && no.why === "dead") return out;
      const perMin = Number(game.time?.calendar?.days?.secondsPerMinute) || 60;
      const mins = Math.max(1, Math.ceil(_secondsToTheHour() / perMin));
      out.push({
        key: hazard.key,
        name: `${hazard.name}, ${temperatureWords(hazard.temp)}`,
        icon: hazard.icon,
        pill: no ? (no.kind === "protected" ? "protected" : "no save") : `save in ${mins} minute${mins === 1 ? "" : "s"}`,
        tip: no ? `No save: ${no.why}.`
          : `${hazard.name} on this scene. Every hour: a Constitution save, or a level of exhaustion.`,
      });
    } catch (err) {
      console.warn(`${LOG} | could not say whether ${actor?.name} is in a hazard:`, err);
    }
    return out;
  },
};
