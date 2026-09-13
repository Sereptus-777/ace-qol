// ─── ACE: QOL — Prismatic Wall, run by itself ────────────────────────────────
//
// Johnny, 2026-09-13, once the wall's list offered its two saves by hand: ACE
// should roll them itself. Two triggers, straight from the spell:
//
//   THE LIGHT   "If another creature that can see the wall moves within 20 feet
//               of it or starts its turn there, the creature must succeed on a
//               Constitution saving throw or have the Blinded condition for 1
//               minute."
//   THE LAYERS  "When a creature reaches into or passes through the wall, it
//               does so one layer at a time through all the layers. Each layer
//               forces the creature to make a Dexterity saving throw."
//
// And the exception that makes it a wall and not a trap for your own side: "You
// and creatures you designate when you cast the spell can pass through and be
// near the wall without harm." So the caster's own screen asks, the moment the
// wall is placed, who those creatures are, and the answer is kept on the wall.
//
// WHO DOES WHAT
//   the caster's client   asks who passes unharmed and writes it on the template
//   the active GM         watches movement and turns, rolls, posts the cards
//   the creature's owner  rolls its own saves; the GM rolls NPCs and anyone whose
//                         player is not here, as every ACE save does
//
// ⚠️ NOT THE CONCENTRATION TRACKER'S JOB. That tracker asks "is the creature
// inside the area?", and a wall one inch thick has no inside: the question is
// whether a path crossed a line and how near a creature came to it. The tracker
// is told to leave Prismatic Wall alone, so a reload cannot hand it to both.
//
// ⚠️ WHAT IT DOES NOT DO. Reaching into the wall (an arm, a sword) and the
// layers being destroyed one at a time leave nothing on the map to see, so they
// stay with the GM.
// ──────────────────────────────────────────────────────────────────────────────

import { isPrismaticWall, readPrismaticWall } from "./rules/prismatic-wall.mjs";
import { wallShapeOf, distanceToWallFt, wallCrossings, entersBand, wallPointsWithin } from "./rules/wall-geometry.mjs";
import { safeShowForRoll, awaitDiceSettle } from "./dsn-utils.mjs";
import { aceDiagonalRule } from "./geometry-utils.mjs";

// ⚠️ A LITERAL, NOT THE ENTRY FILE'S EXPORT. The entry file imports this one,
// and a binding read from it here would be the import cycle that took the whole
// module down on 2026-08-28.
const MOD = "ace-qol";
const TAG = "ace-qol | Prismatic Wall";

const LAYER_COLOURS = {
  red: "#e5484d", orange: "#f76b15", yellow: "#f5c400", green: "#3f9e5a",
  blue: "#3e63dd", indigo: "#5b4bc4", violet: "#a34bc0",
};

const esc = (s) => {
  try { return foundry.utils.escapeHTML(String(s ?? "")); }
  catch (_) { return String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]); }
};
const minutesWords = (seconds) => {
  const m = Math.round((Number(seconds) || 0) / 60);
  return m === 1 ? "1 minute" : `${m} minutes`;
};

export class PrismaticWallEngine {
  static _initialized = false;
  static _queue = Promise.resolve();
  static _seenMoves = new Map();
  static _told = new Set();

  static init() {
    if (this._initialized) return;
    this._initialized = true;

    // The caster's own screen: who passes unharmed.
    Hooks.on("createMeasuredTemplate", (doc, _options, userId) => {
      this._onTemplateCreated(doc, userId).catch(err =>
        console.warn(`${TAG}: could not ask who passes the wall unharmed:`, err));
    });

    // ⚠️ moveToken, NOT updateToken. Foundry 13 hands this hook the path the
    // token actually took, waypoint by waypoint (token.mjs, the moveToken call).
    // A straight line from where it started to where it stopped would have a
    // creature that walked around the end of the wall walk through it.
    Hooks.on("moveToken", (doc, movement, operation) => {
      if (!this._isActiveGM()) return;
      this._enqueue(`${doc?.name ?? "a token"} moving`, () => this._onMove(doc, movement, operation));
    });

    // combatTurnChange, because it hands over whose turn it now is, explicitly.
    Hooks.on("combatTurnChange", (combat, _prior, current) => {
      if (!this._isActiveGM()) return;
      this._enqueue("a turn starting", () => this._onTurnStart(combat, current));
    });

    Hooks.on("updateWorldTime", () => {
      if (!this._isActiveGM()) return;
      this._enqueue("the clock moving", () => this._expireWalls());
    });

    console.debug(`${TAG}: online. The caster names who passes unharmed; the GM's screen rolls for anyone who comes near or goes through.`);
  }

  static _isActiveGM() {
    try { return !!game.user?.isGM && (game.users?.activeGM ?? game.user) === game.user; }
    catch (_) { return false; }
  }

  /** One at a time: two creatures moving together must not interleave their dice and cards. */
  static _enqueue(what, fn) {
    this._queue = this._queue.then(fn).catch(err =>
      console.error(`${TAG}: something went wrong with ${what}, and nothing more was rolled for it:`, err));
    return this._queue;
  }

  /** A console line once per cause, so a problem is said without being said forty times. */
  static _tellOnce(key, message) {
    if (this._told.has(key)) return;
    this._told.add(key);
    console.warn(`${TAG}: ${message}`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Reading what stands on a scene
  // ═══════════════════════════════════════════════════════════════════════════

  static _gridOf(scene) {
    const g = scene?.grid ?? {};
    return { gridPx: Number(g.size) || Number(canvas?.grid?.size) || 100,
             ftPerCell: Number(g.distance) || 5, rule: aceDiagonalRule() };
  }

  /** The spell a template was placed by: dnd5e stamps the item, and the activity as its origin. */
  static _itemOf(templateDoc) {
    const f = templateDoc?.flags?.dnd5e ?? {};
    const get = (u) => { try { return u ? fromUuidSync(u) : null; } catch (_) { return null; } };
    let doc = get(f.item);
    if (!doc && f.origin) { const o = get(f.origin); doc = o?.item ?? o; }
    return (doc && (doc.documentName === "Item" || doc.system?.activities)) ? doc : null;
  }

  /** Every Prismatic Wall standing on a scene, with what ACE needs to run it. */
  static _wallsOn(scene) {
    const out = [];
    const grid = this._gridOf(scene);
    for (const doc of scene?.templates ?? []) {
      const item = this._itemOf(doc);
      if (!item || !isPrismaticWall(item)) continue;
      const shape = wallShapeOf(doc, grid);
      if (!shape) {
        this._tellOnce(`shape:${doc.id}`, `${item.name} (${doc.id}) is drawn as a "${doc.t}", which ACE cannot `
          + `read as a wall or a globe; nothing is rolled for it.`);
        continue;
      }
      const facts = readPrismaticWall(item);
      for (const p of facts.problems) this._tellOnce(`problem:${item.uuid}:${p}`, `${item.name} on ${item.actor?.name ?? "?"}: ${p}.`);
      out.push({ doc, item, facts, shape, grid, pw: doc.flags?.[MOD]?.prismaticWall ?? null });
    }
    return out;
  }

  /**
   * Is the wall ready to act? It waits for the caster to say who passes unharmed.
   *
   * ⚠️ WAITING IS SAID, AND IT DOES NOT WAIT FOREVER. A wall placed before this
   * existed, or by a caster whose screen closed, would otherwise never work.
   */
  static _armed(wall) {
    if (wall.pw?.designated) return true;
    const born = Number(wall.doc?._stats?.createdTime) || 0;
    if (born && Date.now() - born < 120000) {
      this._tellOnce(`wait:${wall.doc.id}`, `${wall.item.name}: waiting for ${wall.item.actor?.name ?? "the caster"} `
        + `to say who passes unharmed. Nothing is rolled until then.`);
      return false;
    }
    this._tellOnce(`nodesig:${wall.doc.id}`, `${wall.item.name} (${wall.doc.id}) has no record of who passes `
      + `unharmed, so only ${wall.item.actor?.name ?? "its caster"} does. To ask again: `
      + `game.aceQol.prismaticWall.designate("${wall.doc.id}")`);
    return true;
  }

  /** The caster, and everyone the caster named. */
  static _isSpared(wall, tokenDoc) {
    const pw = wall.pw ?? {};
    const caster = wall.item?.actor ?? null;
    if (pw.casterTokenId && tokenDoc.id === pw.casterTokenId) return true;
    // The same document: a linked caster, or an unlinked caster's own token.
    if (caster && tokenDoc.actor && tokenDoc.actor === caster) return true;
    if (!pw.casterTokenId && caster && tokenDoc.actorLink && tokenDoc.actorId === caster.id) return true;
    if ((pw.exemptTokenIds ?? []).includes(tokenDoc.id)) return true;
    if (tokenDoc.actorLink && (pw.exemptActorIds ?? []).includes(tokenDoc.actorId)) return true;
    return false;
  }

  /**
   * A creature's space, in the shape the geometry reads. A Tiny creature fills
   * its whole square, the same snap geometry-utils makes for every distance.
   */
  static _rectOf(tokenDoc, grid, at = null) {
    const gs = grid.gridPx;
    const wU = Number(at?.width ?? tokenDoc.width) || 1;
    const hU = Number(at?.height ?? tokenDoc.height) || 1;
    let x = Number(at?.x ?? tokenDoc.x) || 0, y = Number(at?.y ?? tokenDoc.y) || 0;
    let w = wU * gs, h = hU * gs;
    if (w < gs) { x = Math.floor((x + w / 2) / gs) * gs; w = gs; }
    if (h < gs) { y = Math.floor((y + h / 2) / gs) * gs; h = gs; }
    const bottom = Number(at?.elevation ?? tokenDoc.elevation) || 0;
    return { x, y, w, h, bottom, top: bottom + Math.max(wU, hU, 1) * grid.ftPerCell };
  }

  /** The path Foundry says the token took: where it started, then every waypoint it passed. */
  static _pathOf(movement, tokenDoc, grid) {
    const actions = CONFIG?.Token?.movement?.actions ?? {};
    const point = (p, teleport) => {
      const wU = Number(p?.width ?? tokenDoc.width) || 1;
      const hU = Number(p?.height ?? tokenDoc.height) || 1;
      const bottom = Number(p?.elevation ?? tokenDoc.elevation) || 0;
      return { x: (Number(p?.x) || 0) + (wU * grid.gridPx) / 2, y: (Number(p?.y) || 0) + (hU * grid.gridPx) / 2,
               bottom, top: bottom + Math.max(wU, hU, 1) * grid.ftPerCell, teleport };
    };
    const pts = [];
    if (movement?.origin) pts.push(point(movement.origin, false));
    for (const w of movement?.passed?.waypoints ?? []) pts.push(point(w, actions?.[w?.action]?.teleport === true));
    return pts;
  }

  /**
   * Can it see the wall? Not if it is blind, asleep or stone, and not if walls
   * hide every part of the wall that is near it. The wall sheds its own bright
   * light, so darkness does not hide it.
   */
  static _canSeeWall(tokenDoc, wall) {
    const actor = tokenDoc.actor;
    const statuses = new Set([...(actor?.statuses ?? [])]);
    for (const e of actor?.effects ?? []) {
      if (e?.disabled) continue;
      for (const s of e?.statuses ?? []) statuses.add(s);
    }
    for (const s of ["blinded", "unconscious", "petrified", "dead"]) {
      if (statuses.has(s)) return { sees: false, why: `it is ${s}` };
    }
    const rect = this._rectOf(tokenDoc, wall.grid);
    const pts = wallPointsWithin(wall.shape, rect, wall.facts.bandFt, wall.grid, 5);
    if (!pts.length) return { sees: false, why: "no part of the wall is that near" };
    const backend = CONFIG?.Canvas?.polygonBackends?.sight;
    if (typeof backend?.testCollision !== "function") {
      this._tellOnce("nosight", "this Foundry build offers no sight test, so every creature near the wall is "
        + "treated as able to see it.");
      return { sees: true, why: "sight could not be tested" };
    }
    const from = { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 };
    const every = Math.max(1, Math.ceil(pts.length / 12));
    for (let i = 0; i < pts.length; i += every) {
      try {
        if (!backend.testCollision(from, pts[i], { type: "sight", mode: "any" })) return { sees: true, why: "in plain sight" };
      } catch (err) {
        this._tellOnce("sighterr", `the sight test threw (${err?.message ?? err}); creatures near the wall are `
          + `treated as able to see it.`);
        return { sees: true, why: "the sight test failed" };
      }
    }
    return { sees: false, why: "walls block every line to it" };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Triggers
  // ═══════════════════════════════════════════════════════════════════════════

  static async _onTemplateCreated(doc, userId) {
    // SILENT-OK: only the screen of whoever placed it asks, and only for this spell.
    if (userId !== game.user?.id) return;
    const item = this._itemOf(doc);
    if (!item || !isPrismaticWall(item)) return;   // SILENT-OK: not this spell
    await this.designate(doc);
  }

  static async _onMove(tokenDoc, movement, operation) {
    if (!tokenDoc?.parent || !movement) return;           // SILENT-OK: nothing moved on a scene
    // SILENT-OK: undoing a move is not moving. The saves it caused stand.
    if (operation?.isUndo || movement.method === "undo") return;
    const walls = this._wallsOn(tokenDoc.parent);
    if (!walls.length) return;                            // SILENT-OK: no wall on this scene

    // ⚠️ ONE MOVE, ONE ANSWER. A movement can arrive in pieces when Foundry
    // pauses it, each with its own start, so the key is the piece, not the move.
    const wp = movement.passed?.waypoints ?? [];
    const last = wp[wp.length - 1] ?? {};
    const key = `${movement.id ?? ""}:${movement.origin?.x},${movement.origin?.y}>${last.x},${last.y}`;
    if (this._seenMoves.has(key)) return;                 // SILENT-OK: the same piece, heard twice
    this._seenMoves.set(key, Date.now());
    if (this._seenMoves.size > 200) {
      for (const [k, t] of this._seenMoves) if (Date.now() - t > 60000) this._seenMoves.delete(k);
    }

    const actor = tokenDoc.actor;
    if (!actor) return;                                   // SILENT-OK: a token with no creature
    const hp = Number(actor.system?.attributes?.hp?.value);
    if (Number.isFinite(hp) && hp <= 0) return;           // SILENT-OK: a body being dragged walks into nothing

    for (const wall of walls) {
      if (this._isSpared(wall, tokenDoc) || !this._armed(wall)) continue;
      const path = this._pathOf(movement, tokenDoc, wall.grid);
      if (path.length < 2) continue;
      const size = { w: (Number(tokenDoc.width) || 1) * wall.grid.gridPx, h: (Number(tokenDoc.height) || 1) * wall.grid.gridPx };
      const arrived = entersBand(wall.shape, path, wall.facts.bandFt, wall.grid, size);
      const passes = wallCrossings(wall.shape, path, wall.grid);
      if (!arrived && !passes) continue;
      console.log(`${TAG}: ${tokenDoc.name}`
        + `${arrived ? ` came within ${wall.facts.bandFt} feet of` : ""}${arrived && passes ? " and" : ""}`
        + `${passes ? ` went through${passes > 1 ? ` (${passes} times)` : ""}` : ""} ${wall.item.name}.`);
      if (arrived) {
        const sight = this._canSeeWall(tokenDoc, wall);
        if (sight.sees) await this.resolveLight(wall, tokenDoc, "moves");
        else console.log(`${TAG}: ${tokenDoc.name} cannot see ${wall.item.name} (${sight.why}), so its light has no save to ask.`);
      }
      for (let i = 0; i < passes; i++) await this.resolveLayers(wall, tokenDoc);
    }
  }

  static async _onTurnStart(combat, current) {
    await this._expireWalls();
    const combatant = (current?.combatantId ? combat?.combatants?.get?.(current.combatantId) : null)
      ?? combat?.combatant ?? null;
    const tokenDoc = combatant?.token ?? null;
    if (!tokenDoc?.parent || !tokenDoc.actor) return;     // SILENT-OK: no token on a scene, nowhere to stand
    const hp = Number(tokenDoc.actor.system?.attributes?.hp?.value);
    if (Number.isFinite(hp) && hp <= 0) return;           // SILENT-OK: the dead do not start turns
    for (const wall of this._wallsOn(tokenDoc.parent)) {
      if (this._isSpared(wall, tokenDoc) || !this._armed(wall)) continue;
      const feet = distanceToWallFt(wall.shape, this._rectOf(tokenDoc, wall.grid), wall.grid);
      if (feet > wall.facts.bandFt) continue;
      const sight = this._canSeeWall(tokenDoc, wall);
      if (!sight.sees) {
        console.log(`${TAG}: ${tokenDoc.name} starts its turn ${feet} feet from ${wall.item.name} and cannot see it (${sight.why}); no save.`);
        continue;
      }
      await this.resolveLight(wall, tokenDoc, "starts");
    }
  }

  /** Ten minutes, then it is gone. dnd5e leaves the template on the map forever. */
  static async _expireWalls() {
    const now = Number(game.time?.worldTime) || 0;
    for (const scene of game.scenes ?? []) {
      for (const doc of [...(scene.templates ?? [])]) {
        const pw = doc.flags?.[MOD]?.prismaticWall;
        if (!pw?.expiresAt || now < pw.expiresAt) continue;
        const item = this._itemOf(doc);
        try { await doc.delete(); }
        catch (err) {
          console.warn(`${TAG}: ${item?.name ?? "a Prismatic Wall"} has run its course and could not be taken off the map:`, err);
          continue;
        }
        const lasted = pw.castAt != null ? minutesWords(pw.expiresAt - pw.castAt) : "time";
        await this._say(item, `<b>${esc(item?.actor?.name ?? "The caster")}</b>'s ${esc(item?.name ?? "Prismatic Wall")} `
          + `fades: its ${esc(lasted)} are up.`);
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Who passes unharmed
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Ask who passes the wall unharmed, and write it on the wall.
   * Runs on the caster's screen when the wall is placed; the GM or whoever
   * placed it can ask again from the console with the template's id.
   */
  static async designate(docOrId) {
    const doc = typeof docOrId === "string"
      ? ([...(game.scenes ?? [])].map(s => s.templates?.get?.(docOrId)).find(Boolean) ?? null)
      : docOrId;
    if (!doc) { ui.notifications?.warn(`ACE: no wall with the id ${docOrId} on any scene.`); return null; }
    const item = this._itemOf(doc);
    if (!item || !isPrismaticWall(item)) { ui.notifications?.warn("ACE: that template is not a Prismatic Wall."); return null; }
    if (!(game.user?.isGM || doc.author?.id === game.user?.id)) {
      ui.notifications?.warn("ACE: only the GM, or whoever placed the wall, can say who passes it unharmed.");
      return null;
    }
    const caster = item.actor ?? null;
    const scene = doc.parent;
    let casterToken = null;
    if (caster?.isToken && caster.token) casterToken = caster.token;
    else {
      const own = [...(scene?.tokens ?? [])].filter(t => t.actorLink && t.actorId === caster?.id);
      if (own.length === 1) casterToken = own[0];
    }

    let chosen = [];
    try {
      const { SpellTargetPicker } = await import("./spell-target-picker.mjs");
      chosen = await SpellTargetPicker.pick({ spellItem: item, casterActor: caster, maxTargets: 99,
        allowSelf: false, verb: "Spare from", icon: "fa-solid fa-shield-halved" }) ?? [];
    } catch (err) {
      console.warn(`${TAG}: the list of who passes unharmed could not be shown; only the caster is spared:`, err);
    }

    const exemptTokenIds = new Set(), exemptActorIds = new Set(), names = [];
    for (const a of chosen) {
      if (!a) continue;
      names.push(a.token?.name ?? a.name);
      if (a.isToken && a.token?.id) { exemptTokenIds.add(a.token.id); continue; }
      if (a.id) {
        exemptActorIds.add(a.id);
        for (const t of scene?.tokens ?? []) if (t.actorLink && t.actorId === a.id) exemptTokenIds.add(t.id);
      }
    }

    const facts = readPrismaticWall(item);
    const now = Number(game.time?.worldTime) || 0;
    const before = doc.flags?.[MOD]?.prismaticWall ?? {};
    const record = {
      itemUuid: item.uuid ?? null,
      casterActorId: caster?.id ?? null,
      casterTokenId: casterToken?.id ?? null,
      exemptTokenIds: [...exemptTokenIds],
      exemptActorIds: [...exemptActorIds],
      designated: true,
      castAt: before.castAt ?? now,
      expiresAt: before.expiresAt ?? (facts.durationSeconds ? now + facts.durationSeconds : null),
    };
    try {
      await doc.update({ [`flags.${MOD}.prismaticWall`]: record });
    } catch (err) {
      console.warn(`${TAG}: who passes unharmed could not be written on the wall:`, err);
      ui.notifications?.error("ACE could not record who passes the wall unharmed. The console has the details.");
      return null;
    }
    const spared = [caster?.name ?? "the caster", ...names];
    await this._say(item, `<b>${esc(caster?.name ?? "The caster")}</b> raises ${esc(item.name)}. Passing through `
      + `it and standing near it unharmed: ${spared.map(esc).join(", ")}.`, { gmOnly: true, alsoMe: true });
    return record;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Rolling
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * One saving throw, rolled the way every ACE save is.
   *
   * ⚠️ THE OWNER ROLLS THEIR OWN DICE. A player's creature is asked on the
   * player's screen; the GM rolls NPCs, and a creature whose player is not here.
   * ⚠️ AND THE GM'S ROLL GOES THROUGH THE SAVE ENGINE'S OWN ROLLER, so Magic
   * Resistance, a Restrained creature's Dexterity disadvantage, an automatic
   * failure and a Bless die all count here exactly as they do on a Fireball.
   */
  static async _rollSave(wall, tokenDoc, ability, dc, label, opts = {}) {
    const { item } = wall;
    const actor = tokenDoc.actor;
    const caster = item.actor ?? null;
    const token = tokenDoc.object ?? canvas?.tokens?.get?.(tokenDoc.id) ?? null;
    let state = null;
    try {
      const { CombatState } = await import("./combat-state.mjs");
      if (token && caster) state = CombatState.assess(caster, token, item,
        { saveAbility: ability, isSpell: true, damageTypes: opts.damageTypes ?? [] });
    } catch (err) {
      console.warn(`${TAG}: could not read ${tokenDoc.name}'s situation for its save; it is rolled plain:`, err);
    }
    const base = { advReasons: state?.saveAdvReasons ?? [], disReasons: state?.saveDisadvReasons ?? [],
                   superSaver: !!state?.superSaver };
    if (state?.autoFailSave) return { ...base, total: null, natural: null, passed: false, autoFail: true };

    const { RepeatingSaveEngine } = await import("./repeating-save-engine.mjs");
    const owner = RepeatingSaveEngine._ownerUser(actor);
    if (owner) {
      const info = await RepeatingSaveEngine._obtainReSaveRoll(actor, ability, dc, label);
      if (info && Number.isFinite(info.total)) {
        if (info.roll) safeShowForRoll(info.roll, "Prismatic Wall save");
        return { ...base, total: info.total, natural: Number.isFinite(info.natural) ? info.natural : null,
                 passed: info.total >= dc, by: owner.name };
      }
      console.warn(`${TAG}: ${tokenDoc.name}'s save for ${label} came back empty; the GM rolls it instead.`);
    }

    const engine = game.aceQol?.saveEngine;
    if (!state || typeof engine?._rollSingleSave !== "function") {
      const info = await RepeatingSaveEngine._gmRollSave(actor, ability, dc);
      // ⚠️ A ROLL THAT NEVER HAPPENED IS NOT A FAILED SAVE. Nothing lands on it.
      if (!info) return { ...base, total: null, natural: null, passed: false, noRoll: true, why: "its roll could not be made" };
      if (info.roll) safeShowForRoll(info.roll, "Prismatic Wall save");
      return { ...base, total: info.total, natural: info.natural, passed: info.total >= dc };
    }
    const { SaveEngine } = await import("./save-engine.mjs");
    const tgt = {
      tokenId: tokenDoc.id, tokenDocId: tokenDoc.id, sceneId: tokenDoc.parent?.id ?? null, actorId: actor?.id,
      name: tokenDoc.name, img: actor?.img ?? tokenDoc.texture?.src,
      autoFailSave: !!state.autoFailSave, saveAdvantage: !!state.saveAdvantage, saveDisadvantage: !!state.saveDisadvantage,
      saveAdvReasons: state.saveAdvReasons ?? [], saveDisadvReasons: state.saveDisadvReasons ?? [],
      superSaver: !!state.superSaver, saveBonuses: state.saveBonuses ?? [], damageModifiers: state.damageModifiers ?? {},
      currentHP: state.target?.currentHP, maxHP: state.target?.maxHP,
    };
    const r = await engine._rollSingleSave(tgt, ability, dc, false, null, {
      ...SaveEngine._gateContextFor(item, opts.damageTypes ?? [], opts.activityId ?? null),
      isMultiTarget: !!opts.multi,
    });
    if (r?.noRoll) return { ...base, total: null, natural: null, passed: !!r.passed, noRoll: true, why: r.reason ?? "" };
    return { ...base, total: r?.saveTotal ?? null, natural: r?.dieResult ?? null, passed: !!r?.passed, autoFail: !!r?.isAutoFail };
  }

  /** Put a condition on for one layer, unless it cannot land or this layer already holds it. */
  static async _putOn(actor, wall, layer, key, extraFlags) {
    const { ConditionLibrary } = await import("./condition-library.mjs");
    if (ConditionLibrary.immuneTo(actor, key)) return { immune: true };
    // ⚠️ THE SAME LAYER TWICE IS ONE CONDITION. Going back through the wall
    // while still held by its indigo layer would otherwise start a second score.
    const held = [...(actor.effects ?? [])].find(e =>
      e?.flags?.[MOD]?.prismaticWall?.templateId === wall.doc.id && e?.flags?.[MOD]?.prismaticWall?.layer === layer.key);
    if (held) return { already: true, effect: held };
    // ⚠️ allowStack: its own effect, never a replacement. Somebody already
    // Restrained by a Web keeps that Web; this layer's restraint ends on its own terms.
    const eff = await ConditionLibrary.applyEffect(actor, key, {
      nameOverride: `${key === "restrained" ? "Restrained" : "Blinded"} (${wall.item.name}, ${layer.key})`,
      origin: wall.item.uuid ?? null,
      allowStack: true,
      extraFlags: { ...extraFlags, prismaticWall: { templateId: wall.doc.id, layer: layer.key } },
    });
    return eff ? { effect: eff } : { failed: true };
  }

  /** The light: a Constitution save or a minute of blindness. */
  static async resolveLight(wall, tokenDoc, how) {
    const { item, facts } = wall;
    const actor = tokenDoc.actor;
    const what = how === "starts"
      ? `starts its turn within ${facts.bandFt} feet of the wall`
      : `comes within ${facts.bandFt} feet of the wall`;
    if (!facts.dc) {
      await this._say(item, `<b>${esc(tokenDoc.name)}</b> ${what}, and ACE cannot tell the save's DC, so nothing was rolled.`, { gmOnly: true });
      return null;
    }
    const { ConditionLibrary } = await import("./condition-library.mjs");
    if (ConditionLibrary.immuneTo(actor, "blinded")) {
      await this._say(item, `<b>${esc(tokenDoc.name)}</b> ${what} and cannot be Blinded, so no save is needed.`, { gmOnly: true });
      return { immune: true };
    }
    const save = await this._rollSave(wall, tokenDoc, "con", facts.dc, `${item.name}: its blinding light`,
      { activityId: facts.blindingActivityId });
    let landed = null;
    if (!save.passed && !save.noRoll) {
      const eff = await ConditionLibrary.applyEffect(actor, "blinded", {
        nameOverride: `Blinded (${item.name})`, origin: item.uuid ?? null,
        duration: { seconds: facts.blindSeconds }, allowStack: true,
        extraFlags: { prismaticWall: { templateId: wall.doc.id, layer: "light" } },
      });
      landed = eff ? { effect: eff } : { failed: true };
    }
    try { await awaitDiceSettle(); } catch (_) { /* the card still posts */ }
    await this._postLightCard(wall, tokenDoc, save, landed, what);
    return { save, landed };
  }

  /** The layers: seven Dexterity saves, in order, and what each failure costs. */
  static async resolveLayers(wall, tokenDoc) {
    const { item, facts } = wall;
    const actor = tokenDoc.actor;
    if (!facts.dc) {
      await this._say(item, `<b>${esc(tokenDoc.name)}</b> goes through the wall, and ACE cannot tell the save's DC, so nothing was rolled.`, { gmOnly: true });
      return null;
    }
    const { DamageCalculator } = await import("./damage-calculator.mjs");
    const damageTypes = facts.layers.filter(l => l.kind === "damage").map(l => l.type);
    const mods = DamageCalculator.getTargetDamageModifiers(actor, item) ?? {};
    const now = Number(game.time?.worldTime) || 0;
    const rows = [];
    for (const layer of facts.layers) {
      const label = `${item.name}: the ${layer.key} layer (${layer.n} of ${facts.layers.length})`;
      const save = await this._rollSave(wall, tokenDoc, "dex", facts.dc, label,
        { damageTypes, multi: true, activityId: facts.traversalActivityId });
      const row = { layer, save };
      if (layer.kind === "damage") {
        let roll = null;
        try { roll = layer.formula ? await new Roll(layer.formula).evaluate() : null; }
        catch (err) { console.warn(`${TAG}: the ${layer.key} layer's ${layer.formula} could not be rolled:`, err); }
        if (roll) {
          safeShowForRoll(roll, `Prismatic Wall ${layer.key} layer`);
          // Half on a save; Evasion makes that none, and a failure half. A save
          // the save engine's gate never let roll lands nothing at all.
          const mult = save.noRoll ? 0 : (save.passed ? (save.superSaver ? 0 : 0.5) : (save.superSaver ? 0.5 : 1));
          const raw = Math.floor((Number(roll.total) || 0) * mult);
          const [applied] = DamageCalculator.applyDamageModifiers(
            [{ name: `${layer.label} layer`, type: layer.type, total: raw }], mods);
          row.damage = { rolled: Number(roll.total) || 0, formula: layer.formula, mult, raw,
                         final: applied?.final ?? raw, modifier: applied?.modifier ?? "normal", type: layer.type };
        } else {
          row.damage = { failedToRoll: true, type: layer.type, formula: layer.formula };
        }
      } else if (save.noRoll) {
        // ⚠️ NOT ROLLED IS NOT FAILED: nothing lands (see the save engine's _isRealFailure).
      } else if (!save.passed && layer.kind === "restrained") {
        row.landed = await this._putOn(actor, wall, layer, "restrained", { repeatingSave: {
          ability: layer.saveAbility ?? "con", dc: facts.dc, trigger: "endOfTurn",
          spellName: `${item.name} (indigo layer)`,
          tally: { need: layer.need ?? 3, successes: 0, failures: 0 },
          onFailureApply: layer.escalatesTo ?? "petrified",
          castWorldTime: now, stampedAt: Date.now() } });
      } else if (!save.passed && layer.kind === "blinded") {
        row.landed = await this._putOn(actor, wall, layer, "blinded", { repeatingSave: {
          ability: layer.saveAbility ?? "wis", dc: facts.dc, trigger: "startOfCasterTurn",
          casterActorId: item.actor?.id ?? null, casterTokenId: wall.pw?.casterTokenId ?? null,
          casterName: item.actor?.name ?? null, once: true,
          spellName: `${item.name} (violet layer)`,
          onFailureNote: "it is sent to another plane of existence of the GM's choosing. ACE has not moved the token.",
          castWorldTime: now, stampedAt: Date.now() } });
      }
      rows.push(row);
    }
    try { await awaitDiceSettle(); } catch (_) { /* the card still posts */ }
    await this._postLayersCard(wall, tokenDoc, rows);
    return rows;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Cards
  // ═══════════════════════════════════════════════════════════════════════════

  static _mathHtml(save) {
    if (save.autoFail) return `<span class="ace-qol-prism-math ace-qol-save-roll ace-qol-rsv2-red">automatic failure</span>`;
    if (!Number.isFinite(save.total)) {
      return `<span class="ace-qol-prism-math ace-qol-save-roll">${save.noRoll ? "no roll" : "not rolled"}</span>`;
    }
    const cls = save.passed ? "ace-qol-rsv2-green" : "ace-qol-rsv2-red";
    if (!Number.isFinite(save.natural)) return `<span class="ace-qol-prism-math ace-qol-save-roll ${cls}">${save.total}</span>`;
    const mod = save.total - save.natural;
    return `<span class="ace-qol-prism-math ace-qol-save-roll">${save.natural} `
      + `<span class="ace-qol-prism-dim">${mod < 0 ? "-" : "+"} ${Math.abs(mod)}</span> = `
      + `<span class="${cls}">${save.total}</span></span>`;
  }

  static _reasonsHtml(save) {
    const tags = [
      ...(save.advReasons ?? []).map(r => `<span class="ace-qol-tag ace-qol-tag-buff"><i class="fas fa-arrow-up"></i> ${esc(r)}</span>`),
      ...(save.disReasons ?? []).map(r => `<span class="ace-qol-tag ace-qol-tag-debuff"><i class="fas fa-arrow-down"></i> ${esc(r)}</span>`),
    ];
    return tags.length ? `<span class="ace-qol-prism-tags">${tags.join(" ")}</span>` : "";
  }

  static async _postLightCard(wall, tokenDoc, save, landed, what) {
    const { item, facts } = wall;
    const { aceD20FaceImg } = await import("./save-engine.mjs");
    const name = esc(tokenDoc.name);
    const foot = save.noRoll
      ? `No save was rolled for <b>${name}</b>${save.why ? ` (${esc(save.why)})` : ""}, so nothing happens.`
      : save.passed
        ? `<b>${name}</b> shields its eyes. No effect.`
        : (landed?.effect
            ? `<i class="fas fa-eye-slash"></i> <b>${name}</b> is <b>Blinded</b> for ${minutesWords(facts.blindSeconds)}.`
            : `<b>${name}</b> failed, and ACE could not put Blinded on it. The console has the details.`);
    const html = `
      <div class="ace-qol-rsv2 ace-qol-prism-card">
        <div class="ace-qol-rsv2-head"><i class="fas fa-rainbow"></i>&nbsp;<b>${esc(item.name)}</b>:&nbsp;${name} ${esc(what)}
          <span class="ace-qol-rsv2-src">Constitution save, <span class="ace-qol-save-dc">DC ${facts.dc}</span></span></div>
        <div class="ace-qol-prism-row">
          ${aceD20FaceImg(Number.isFinite(save.natural) ? save.natural : 20, { size: 40 })}
          <span class="ace-qol-rsv2-name">${name}</span>
          ${this._mathHtml(save)}
          <span class="ace-qol-rsv2-badge ${save.noRoll ? "" : (save.passed ? "ace-qol-rsv2-pass" : "ace-qol-rsv2-fail")}">${save.noRoll ? "NO ROLL" : (save.passed ? "PASS" : "FAIL")}</span>
          ${this._reasonsHtml(save)}
        </div>
        <div class="ace-qol-rsv2-foot ${save.passed ? "ace-qol-rsv2-foot-pass" : "ace-qol-rsv2-foot-fail"}">${foot}</div>
      </div>`;
    try {
      await ChatMessage.create({
        content: html,
        speaker: ChatMessage.getSpeaker({ actor: item.actor ?? null }),
        flags: { [MOD]: { type: "prismaticLight", itemUuid: item.uuid ?? null, templateId: wall.doc.id,
                          tokenDocId: tokenDoc.id, passed: !!save.passed } },
      });
    } catch (err) {
      console.error(`${TAG}: the card for ${tokenDoc.name}'s save against the light could not be posted:`, err);
    }
  }

  static async _postLayersCard(wall, tokenDoc, rows) {
    const { item, facts } = wall;
    const actor = tokenDoc.actor;
    const { aceD20FaceImg } = await import("./save-engine.mjs");
    const name = esc(tokenDoc.name);
    const casterName = esc(item.actor?.name ?? "the caster");
    const MODS = { immune: "IMMUNE", resistant: "RESIST", vulnerable: "VULN x2" };

    const outcomeOf = (row) => {
      const { layer, save } = row;
      if (layer.kind === "damage") {
        const d = row.damage ?? {};
        if (d.failedToRoll) return `<span class="ace-qol-prism-out">its ${esc(d.formula ?? "dice")} could not be rolled</span>`;
        const how = save.noRoll ? " (no save rolled)"
          : (d.mult === 0 ? " (none: Evasion)" : (d.mult === 0.5 ? " (half)" : ""));
        const mod = MODS[d.modifier] ? ` <span class="ace-qol-dmg-truth-only ace-qol-prism-mod">${MODS[d.modifier]}</span>` : "";
        return `<span class="ace-qol-prism-out"><span class="ace-qol-prism-dim">${esc(d.formula)} ${d.rolled}</span> `
          + `<span class="ace-qol-dmg-type-total">${d.final}</span> ${esc(d.type)}${how}${mod}</span>`;
      }
      if (save.noRoll) return `<span class="ace-qol-prism-out">no save rolled${save.why ? `: ${esc(save.why)}` : ""}</span>`;
      if (save.passed) return `<span class="ace-qol-prism-out">no effect</span>`;
      const cond = layer.kind === "restrained" ? "Restrained" : "Blinded";
      const l = row.landed ?? {};
      if (l.immune) return `<span class="ace-qol-prism-out">cannot be ${cond}</span>`;
      if (l.already) return `<span class="ace-qol-prism-out">already held by this layer</span>`;
      if (l.failed || !l.effect) return `<span class="ace-qol-prism-out">${cond} could not be put on; see the console</span>`;
      return `<span class="ace-qol-prism-out"><b>${cond}</b></span>`;
    };

    const rowHtml = rows.map(row => `
        <div class="ace-qol-prism-row">
          <span class="ace-qol-prism-swatch" style="background:${LAYER_COLOURS[row.layer.key] ?? "#888"}"></span>
          <span class="ace-qol-prism-layer">${esc(row.layer.label)}</span>
          ${aceD20FaceImg(Number.isFinite(row.save.natural) ? row.save.natural : 20, { size: 30 })}
          ${this._mathHtml(row.save)}
          <span class="ace-qol-rsv2-badge ${row.save.noRoll ? "" : (row.save.passed ? "ace-qol-rsv2-pass" : "ace-qol-rsv2-fail")}">${row.save.noRoll ? "NO ROLL" : (row.save.passed ? "PASS" : "FAIL")}</span>
          ${outcomeOf(row)}
          ${this._reasonsHtml(row.save)}
        </div>`).join("");

    const dmgRows = rows.filter(r => r.layer.kind === "damage" && r.damage && !r.damage.failedToRoll);
    const components = dmgRows.map(r => ({ name: `${r.layer.label} layer`, type: r.damage.type,
      raw: r.damage.raw, final: r.damage.final, modifier: r.damage.modifier }));
    const total = components.reduce((s, c) => s + (Number(c.final) || 0), 0);
    const hpNow = Number(actor?.system?.attributes?.hp?.value) || 0;
    const hpMax = Number(actor?.system?.attributes?.hp?.max) || 0;
    const hpAfter = Math.max(0, hpNow - total);

    const notes = [];
    const indigo = rows.find(r => r.layer.kind === "restrained" && r.landed?.effect && !r.landed.already);
    const violet = rows.find(r => r.layer.kind === "blinded" && r.landed?.effect && !r.landed.already);
    if (indigo) notes.push(`<b>${name}</b> is <b>Restrained</b>: a Constitution save at the end of each of its turns. `
      + `Three successes free it; three failures turn it to stone.`);
    if (violet) notes.push(`<b>${name}</b> is <b>Blinded</b>: a Wisdom save at the start of ${casterName}'s next turn. `
      + `A success ends it; a failure sends it to another plane.`);

    const html = `
      <div class="ace-qol-rsv2 ace-qol-prism-card">
        <div class="ace-qol-rsv2-head"><i class="fas fa-rainbow"></i>&nbsp;<b>${esc(item.name)}</b>:&nbsp;${name} goes through the wall
          <span class="ace-qol-rsv2-src">${rows.length} Dexterity saves, <span class="ace-qol-save-dc">DC ${facts.dc}</span></span></div>
        <div class="ace-qol-prism-rows">${rowHtml}</div>
        ${total > 0 || dmgRows.length ? `<div class="ace-qol-prism-total">Damage: <span class="ace-qol-dmg-grand-total">${total}</span>
          <span class="ace-qol-prism-dim">(${components.filter(c => c.final > 0).map(c => `${c.final} ${esc(c.type)}`).join(", ") || "none got through"})</span></div>` : ""}
        ${total > 0 ? `<div class="ace-qol-dmg-gm-controls ace-qol-prism-gm">
          <div class="ace-qol-dmg-hp">HP ${hpNow} → ${hpAfter}/${hpMax}${hpAfter <= 0 ? " ☠" : ""}</div>
          <div class="ace-qol-dmg-actions">
            <button class="ace-qol-btn ace-qol-btn-apply" data-action="aceQolApplyDamage"><i class="fas fa-heart-crack"></i> Apply Damage</button>
            <button class="ace-qol-btn ace-qol-btn-undo" data-action="aceQolUndoDamage"><i class="fas fa-undo"></i> Undo</button>
          </div>
        </div>` : ""}
        ${notes.length ? `<div class="ace-qol-rsv2-foot ace-qol-rsv2-foot-fail">${notes.join("<br>")}</div>` : ""}
      </div>`;

    try {
      await ChatMessage.create({
        content: html,
        speaker: ChatMessage.getSpeaker({ actor: item.actor ?? null }),
        flags: { [MOD]: {
          type: "prismaticTraversal", itemUuid: item.uuid ?? null, actorId: item.actor?.id ?? null, templateId: wall.doc.id,
          // ⚠️ THE PARTS, NOT JUST THE SUM. APPLY adds up each part's final
          // number; a card carrying only its total applies nothing and says
          // "APPLIED" (the post-hit card did exactly that until 2026-09-13).
          ...(total > 0 ? { damageResults: [{
            targetId: actor?.id ?? null, tokenId: tokenDoc.id, tokenDocId: tokenDoc.id,
            sceneId: tokenDoc.parent?.id ?? null, isLinked: !!tokenDoc.actorLink,
            name: tokenDoc.name, img: actor?.img ?? tokenDoc.texture?.src ?? "",
            totalFinal: total, currentHP: hpNow, maxHP: hpMax, components,
          }] } : {}),
        } },
      });
    } catch (err) {
      console.error(`${TAG}: the card for ${tokenDoc.name} going through the wall could not be posted:`, err);
    }
  }

  /** A plain line in chat. */
  static async _say(item, html, { gmOnly = false, alsoMe = false } = {}) {
    try {
      const gm = gmOnly ? (ChatMessage.getWhisperRecipients?.("GM") ?? []).map(u => u.id) : null;
      await ChatMessage.create({
        content: `<div class="ace-qol-rsv2 ace-qol-prism-card"><div class="ace-qol-prism-note">${html}</div></div>`,
        speaker: ChatMessage.getSpeaker({ actor: item?.actor ?? null }),
        ...(gm ? { whisper: [...new Set([...gm, ...(alsoMe && game.user?.id ? [game.user.id] : [])])] } : {}),
        flags: { [MOD]: { type: "prismaticNote" } },
      });
    } catch (err) {
      console.warn(`${TAG}: a note could not be posted (${String(html).replace(/<[^>]+>/g, "")}):`, err);
    }
  }
}
