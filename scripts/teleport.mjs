// ─── ACE: QOL — Teleport: the monster's hop, and the 7th-level spell ─────────
//
// 2026-09-18, Johnny: "TWO different Teleports. Read the item on the token."
// rules/teleport-words.mjs decides which one an item is, from the item alone;
// this file carries them out.
//
// A) THE HOP. "Picker: empty squares in that range it can see. Click → it
//    appears there. Gear comes along. No party picker. No d100. No mishap.
//    Counterspell does not apply (not a spell)." Every square the creature
//    could land on lights up; a click on one moves it there as a teleport, so
//    nothing that watches movement (an opportunity attack, a fall, a trap
//    region's walk-through) mistakes it for a walk.
//
// B) THE SPELL. "Picker: who comes (caster + willing creatures it can see
//    within 10 ft, max 8 extras); destination type; where on the map or named
//    place. Then d100 on the book's table for that edition. On target: they
//    appear there. Mishap: 3d10 force each, roll again. Off-target / similar
//    area: GM places them, or a note on the card if ACE cannot pick a scene.
//    Successful Counterspell: no move." The Counterspell part is the spell
//    pipeline's: it waits on the cast's hold before it ever calls this.
//
// The two tables below are the books' own, read from his copies of the spell
// (2014: "Associated object", "Viewed once" and "Description" as three rows;
// 2024: "Linked object" and "Viewed once or described" as one). Off Target is
// where they part: 2014 is 1d10 x 1d10 percent of the distance, a d8 compass
// point starting at north; 2024 is 2d12 miles, a d8 starting at east.
// ──────────────────────────────────────────────────────────────────────────────

import { readTeleport } from "./rules/teleport-words.mjs";
import { PartyTransfer } from "./party-transfer.mjs";
import { CardDoor } from "./road/doors.mjs";
import { safeShowForRoll, awaitDiceSettle } from "./dsn-utils.mjs";
import { RulesBrain } from "./rules/rules-brain.mjs";
import { aceDistanceFt } from "./geometry-utils.mjs";
import { isDead } from "./is-down.mjs";
import { DamageCardRenderer } from "./damage-card-renderer.mjs";
import { DamageCalculator } from "./damage-calculator.mjs";
import { teleportLookFor } from "./animation/autorec.mjs";
import { replyOwnerIsAuthorised } from "./socket-authority.mjs";
// What pressing it spent, given back when nothing happens: the one helper every
// abandoned cast uses, the spell pipeline's included.
import { giveBack } from "./road/give-back.mjs";

// ⚠️ HARDCODED. Reached through the spell pipeline from the entry file.
const MODULE_ID = "ace-qol";
const LOG = `${MODULE_ID} | Teleport`;

/**
 * The books' Teleportation Outcome tables: for each familiarity, the highest
 * d100 that is a Mishap, a Similar Area and Off Target. Anything above the last
 * is On Target. A dash in the book is the previous number carried along.
 */
export const TELEPORT_TABLES = Object.freeze({
  "2014": [
    { key: "circle",      label: "Permanent circle",          mishap: 0,  similar: 0,   off: 0 },
    { key: "object",      label: "Associated object",         mishap: 0,  similar: 0,   off: 0 },
    { key: "very",        label: "Very familiar",             mishap: 5,  similar: 13,  off: 24 },
    { key: "casual",      label: "Seen casually",             mishap: 33, similar: 43,  off: 53 },
    { key: "once",        label: "Viewed once",               mishap: 43, similar: 53,  off: 73 },
    { key: "description", label: "Description",               mishap: 43, similar: 53,  off: 73 },
    { key: "false",       label: "False destination",         mishap: 50, similar: 100, off: 100 },
  ],
  "2024": [
    { key: "circle",      label: "Permanent circle",          mishap: 0,  similar: 0,   off: 0 },
    { key: "object",      label: "Linked object",             mishap: 0,  similar: 0,   off: 0 },
    { key: "very",        label: "Very familiar",             mishap: 5,  similar: 13,  off: 24 },
    { key: "casual",      label: "Seen casually",             mishap: 33, similar: 43,  off: 53 },
    { key: "once",        label: "Viewed once or described",  mishap: 43, similar: 53,  off: 73 },
    { key: "false",       label: "False destination",         mishap: 50, similar: 100, off: 100 },
  ],
});

/** The compass, as each edition numbers it. */
const COMPASS = Object.freeze({
  "2014": ["north", "northeast", "east", "southeast", "south", "southwest", "west", "northwest"],
  "2024": ["east", "southeast", "south", "southwest", "west", "northwest", "north", "northeast"],
});

const esc = (x) => foundry.utils.escapeHTML(String(x ?? ""));

export class Teleport {

  /* ── Reading the table ─────────────────────────────────────────────────── */

  /**
   * What a d100 means for this familiarity, by this edition's table.
   * @returns {"mishap"|"similar"|"off"|"on"}
   */
  static outcome(edition, familiarity, d100) {
    const rows = TELEPORT_TABLES[edition === "2024" ? "2024" : "2014"];
    const row = rows.find(r => r.key === familiarity) ?? rows.find(r => r.key === "very");
    const n = Number(d100);
    if (n <= row.mishap) return "mishap";
    if (n <= row.similar) return "similar";
    if (n <= row.off) return "off";
    return "on";
  }

  /* ── The map ───────────────────────────────────────────────────────────── */

  static _g() { return Number(canvas.grid?.size) || 100; }
  static _ft() { return Number(canvas.scene?.grid?.distance ?? canvas.grid?.distance) || 5; }

  static _size(doc) {
    return { w: Math.max(1, Number(doc?.width) || 1), h: Math.max(1, Number(doc?.height) || 1) };
  }

  static _centre(x, y, doc) {
    const g = Teleport._g(), { w, h } = Teleport._size(doc);
    return { x: x + (w * g) / 2, y: y + (h * g) / 2 };
  }

  /** How far a creature moves, in feet, going from one top-left to another. */
  static _moveFeet(doc, from, to) {
    const a = Teleport._centre(from.x, from.y, doc), b = Teleport._centre(to.x, to.y, doc);
    try {
      const d = canvas.grid?.measurePath?.([a, b])?.distance;
      if (Number.isFinite(d)) return d;
    } catch (_) { /* fall back to a straight line */ }
    return (Math.hypot(b.x - a.x, b.y - a.y) / Teleport._g()) * Teleport._ft();
  }

  /** Can a creature at `from` see `to`? Walls only; no wall API means yes, said once. */
  static _canSee(from, to) {
    const backend = CONFIG?.Canvas?.polygonBackends?.sight;
    if (typeof backend?.testCollision !== "function") {
      if (!Teleport._warnedSight) {
        Teleport._warnedSight = true;
        console.warn(`${LOG} | cannot test sight on this canvas, so every square in range counts as seen.`);
      }
      return true;
    }
    try { return !backend.testCollision(from, to, { type: "sight", mode: "any" }); }
    catch (err) { console.warn(`${LOG} | a sight test failed, so that square counts as seen:`, err); return true; }
  }
  static _warnedSight = false;

  /** Is this footprint inside the scene's own rectangle? */
  static _inScene(x, y, doc) {
    const r = canvas.dimensions?.sceneRect;
    if (!r) return true;
    const g = Teleport._g(), { w, h } = Teleport._size(doc);
    return x >= r.x && y >= r.y && x + w * g <= r.x + r.width && y + h * g <= r.y + r.height;
  }

  /** Every square taken on this scene, but not by the ones who are moving. */
  static _taken(scene, movingIds = []) {
    const skip = new Set(movingIds);
    const taken = new Set();
    for (const t of (scene?.tokens ?? [])) {
      if (skip.has(t.id)) continue;
      const s = PartyTransfer._snap(Number(t.x) || 0, Number(t.y) || 0);
      PartyTransfer._markFootprint(taken, s.x, s.y, t.width, t.height);
    }
    return taken;
  }

  /**
   * Every square this token could teleport to: unoccupied, on the scene, within
   * `feet` of where it stands, and in its sight.
   */
  static squaresFor(token, feet) {
    const doc = token.document ?? token;
    const g = Teleport._g();
    const here = PartyTransfer._snap(Number(doc.x) || 0, Number(doc.y) || 0);
    const eye = Teleport._centre(here.x, here.y, doc);
    const taken = Teleport._taken(doc.parent ?? canvas.scene, [doc.id]);
    const { w, h } = Teleport._size(doc);
    const reach = Math.ceil(feet / Teleport._ft()) + 1;
    const out = [];
    for (let dx = -reach; dx <= reach; dx++) {
      for (let dy = -reach; dy <= reach; dy++) {
        if (!dx && !dy) continue;
        const to = { x: here.x + dx * g, y: here.y + dy * g };
        if (!Teleport._inScene(to.x, to.y, doc)) continue;
        if (!PartyTransfer._footprintFree(taken, to.x, to.y, w, h)) continue;
        if (Teleport._moveFeet(doc, here, to) > feet + 0.01) continue;
        if (!Teleport._canSee(eye, Teleport._centre(to.x, to.y, doc))) continue;
        out.push(to);
      }
    }
    return out;
  }

  /* ── The pickers ───────────────────────────────────────────────────────── */

  static _layer() {
    const host = canvas.controls ?? canvas.stage;
    const layer = new PIXI.Container();
    layer.eventMode = "none";
    layer.interactiveChildren = false;
    layer.zIndex = 10000;
    host.addChild(layer);
    return layer;
  }

  /**
   * A click on the map, with a live drawing under the cursor. Resolves to what
   * `choose(point)` returns for the clicked point (null ignores the click), or
   * null when right-click or Escape cancels.
   *
   * ⚠️ ONE AIMING AT A TIME, AND NOTHING OF IT OUTLIVES THE CLICK (his table,
   * 2026-09-18: "After he lands, destroy the aiming session. No ghost, no line,
   * no click listener. One move per press."). The click that picks a square
   * ends the session before anything moves: its three listeners come off, its
   * squares, ghost and line are taken off the canvas, and a second aiming
   * started while one is open cancels the first, so one click can never pick
   * twice. A scene change cancels it too.
   */
  static _aim({ draw, choose, hint }) {
    Teleport._session?.cancel("a new aiming began");
    return new Promise((resolve) => {
      const layer = Teleport._layer();
      const onBoard = (ev) => {
        const board = document.getElementById("board");
        return !!board && (ev.target === board || board.contains(ev.target));
      };
      let done = false;
      let tearDown = null;
      const finish = (value, why) => {
        if (done) return;
        done = true;
        document.removeEventListener("pointermove", onMove, true);
        document.removeEventListener("pointerdown", onDown, true);
        document.removeEventListener("keydown", onKey, true);
        if (tearDown != null) Hooks.off("canvasTearDown", tearDown);
        try {
          layer.parent?.removeChild(layer);
          layer.destroy({ children: true });
        } catch (err) {
          console.warn(`${LOG} | the aiming drawing could not be taken off the canvas; `
            + `a reload of the scene clears it:`, err);
        }
        if (Teleport._session === session) Teleport._session = null;
        console.log(`${LOG} | aiming over (${why}): its squares, line and click are gone.`);
        resolve(value);
      };
      const session = { cancel: (why) => finish(null, why) };
      const onMove = (ev) => {
        if (!onBoard(ev)) return;
        try { draw(layer, PartyTransfer._clientToCanvas(ev.clientX, ev.clientY)); }
        catch (err) { console.warn(`${LOG} | could not draw under the cursor:`, err); }
      };
      const onDown = (ev) => {
        if (!onBoard(ev)) return;
        if (ev.button === 2) {
          ev.preventDefault(); ev.stopPropagation(); ev.stopImmediatePropagation();
          finish(null, "cancelled");
          return;
        }
        if (ev.button !== 0) return;
        // This click is the aiming's: nothing else on the page acts on it.
        ev.preventDefault();
        ev.stopPropagation();
        ev.stopImmediatePropagation();
        const picked = choose(PartyTransfer._clientToCanvas(ev.clientX, ev.clientY));
        if (picked) finish(picked, "picked");
      };
      const onKey = (ev) => {
        if (ev.key !== "Escape") return;
        ev.preventDefault();
        ev.stopPropagation();
        finish(null, "cancelled");
      };
      Teleport._session = session;
      document.addEventListener("pointermove", onMove, true);
      document.addEventListener("pointerdown", onDown, true);
      document.addEventListener("keydown", onKey, true);
      tearDown = Hooks.once("canvasTearDown", () => finish(null, "the scene changed"));
      try { draw(layer, null); } catch (err) { console.warn(`${LOG} | could not draw the squares:`, err); }
      ui.notifications?.info(hint);
    });
  }

  /** The aiming open right now, if any: `{cancel(why)}`. */
  static _session = null;

  /** The hop's picker: the lit squares, and the one under the cursor. */
  static pickSquare(token, feet) {
    const doc = token.document ?? token;
    const squares = Teleport.squaresFor(token, feet);
    if (!squares.length) {
      ui.notifications?.warn(`${doc.name} has no unoccupied space within ${feet} feet that it can see.`);
      console.log(`${LOG} | ${doc.name}: no unoccupied space within ${feet} feet in its sight, so nothing to pick.`);
      return Promise.resolve(null);
    }
    const g = Teleport._g(), { w, h } = Teleport._size(doc);
    const byKey = new Map(squares.map(s => [`${s.x},${s.y}`, s]));
    const under = (p) => {
      if (!p) return null;
      const s = PartyTransfer._snap(p.x - ((w - 1) * g) / 2, p.y - ((h - 1) * g) / 2);
      return byKey.get(`${s.x},${s.y}`) ?? null;
    };
    const eye = Teleport._centre(Number(doc.x) || 0, Number(doc.y) || 0, doc);
    return Teleport._aim({
      hint: `${doc.name} teleports: click a lit square, up to ${feet} feet. Right-click or Escape cancels.`,
      draw: (layer, p) => {
        layer.removeChildren().forEach(c => c.destroy());
        const gfx = new PIXI.Graphics();
        gfx.lineStyle(1, 0xb48cff, 0.6);
        gfx.beginFill(0x8a5cf6, 0.18);
        for (const s of squares) gfx.drawRect(s.x + 2, s.y + 2, g - 4, g - 4);
        gfx.endFill();
        const hover = under(p);
        if (hover) {
          const c = Teleport._centre(hover.x, hover.y, doc);
          gfx.lineStyle(2, 0xe8dcff, 0.9);
          gfx.moveTo(eye.x, eye.y).lineTo(c.x, c.y);
          gfx.lineStyle(3, 0xe8dcff, 1);
          gfx.beginFill(0xb48cff, 0.35);
          gfx.drawRoundedRect(hover.x + 2, hover.y + 2, w * g - 4, h * g - 4, 8);
          gfx.endFill();
        }
        layer.addChild(gfx);
      },
      choose: (p) => under(p),
    });
  }

  /** Where each traveller lands, the caster at the point and the rest around. */
  static _landing(docs, point, casterId) {
    const entries = docs.map(d => ({ id: d.id, tokenData: { width: d.width, height: d.height },
      originX: Number(d.x) || 0, originY: Number(d.y) || 0 }));
    const taken = Teleport._taken(docs[0]?.parent ?? canvas.scene, docs.map(d => d.id));
    const pts = PartyTransfer._landingPoints(entries, point, taken, casterId);
    return docs.map((d, i) => ({ doc: d, to: pts[i] }));
  }

  /** The spell's picker: anywhere on this map, the group drawn where it lands. */
  static pickPoint(docs, caster) {
    const g = Teleport._g();
    return Teleport._aim({
      hint: `Teleport: click where ${caster.name} arrives on this map. Right-click or Escape cancels.`,
      draw: (layer, p) => {
        layer.removeChildren().forEach(c => c.destroy());
        if (!p) return;
        const gfx = new PIXI.Graphics();
        for (const { doc, to } of Teleport._landing(docs, p, caster.id)) {
          if (!to) continue;
          const { w, h } = Teleport._size(doc);
          const lead = doc.id === caster.id;
          gfx.lineStyle(lead ? 3 : 2, lead ? 0xe8dcff : 0xb48cff, 0.95);
          gfx.beginFill(0x8a5cf6, lead ? 0.35 : 0.2);
          gfx.drawRoundedRect(to.x + 2, to.y + 2, w * g - 4, h * g - 4, 8);
          gfx.endFill();
        }
        layer.addChild(gfx);
      },
      choose: (p) => (p ? { x: p.x, y: p.y } : null),
    });
  }

  /* ── Moving ────────────────────────────────────────────────────────────── */

  /**
   * Teleport a token to a top-left point: V13's "displace" movement, which is
   * how Foundry itself records a teleport (no path, no walls, no animation),
   * and what the opportunity attack and the fall both already read as one.
   */
  static async displace(doc, to) {
    try {
      const moved = await doc.move({ x: to.x, y: to.y, action: "displace" },
        { method: "api", autoRotate: false, showRuler: false });
      if (!moved) console.warn(`${LOG} | Foundry did not move ${doc.name}; nothing changed.`);
      return !!moved;
    } catch (err) {
      console.warn(`${LOG} | could not move ${doc?.name ?? "that token"}:`, err);
      return false;
    }
  }

  /** The token a creature is acting from, on the scene being looked at. */
  static tokenOf(actor) {
    return canvas.tokens?.controlled?.find(t => t.actor === actor)
      ?? actor?.getActiveTokens?.()?.find(t => t.scene?.id === canvas.scene?.id || t.document?.parent?.id === canvas.scene?.id)
      ?? actor?.getActiveTokens?.()?.[0]
      ?? null;
  }

  /* ── Automated Animations stands down ──────────────────────────────────── */

  /**
   * ⚠️🔴 AUTOMATED ANIMATIONS' TELEPORT MOVES THE TOKEN TOO (his table,
   * 2026-09-18: the first click landed Neferon, and "a later click on the map
   * plays a leave-poof from the old square and moves him toward the cursor").
   * AA's "Teleport" preset is a teleportation preset: pressing the item rings
   * the creature and arms a click listener on the canvas, and that click walks
   * it there through Sequencer (the deprecated teleport flag in his console was
   * Sequencer's animation.js making that move). ACE's own picker swallowed the
   * first click, so AA's listener waited, armed, for the next one.
   *
   * AA offers a way out for exactly this: every one of its runs calls
   * "AutomatedAnimations-WorkflowStart" first and gives up when a listener sets
   * `stopWorkflow`. For a press ACE teleports itself, the hop and the spell, it
   * is set: no ring, no click, no second move. ACE plays the same look itself
   * when they arrive (`_arrive`).
   */
  static register() {
    Hooks.on("AutomatedAnimations-WorkflowStart", Teleport._standDownAA);
    console.debug(`${LOG} | online: Automated Animations stands down for the teleports ACE moves itself`);
  }

  static _standDownAA(data) {
    try {
      const item = data?.item ?? null;
      if (!readTeleport(item)) return;
      data.stopWorkflow = true;
      console.log(`${LOG} | Automated Animations stands down for ${item.actor?.name ?? "that creature"}'s `
        + `${item.name}: ACE moves the token and plays the look itself, so AA arms no click and moves nobody.`);
    } catch (err) {
      console.warn(`${LOG} | could not stand Automated Animations down for a teleport, so it may `
        + `move the token a second time:`, err);
    }
  }

  /* ── The look, at the moment of arrival ────────────────────────────────── */

  /** The teleport's look from his Automated Animations presets, saying why when there is none. */
  static _look(item) {
    const look = teleportLookFor(item);
    if (!look) {
      console.log(`${LOG} | no teleport look for "${item?.name}": Automated Animations has no `
        + `teleportation preset for it and none called Teleport, or its clips are not in this JB2A `
        + `install, so it moves without one.`);
      return null;
    }
    if (typeof Sequence !== "function") {
      console.log(`${LOG} | Sequencer is not running, so "${item?.name}" moves without its look.`);
      return null;
    }
    return look;
  }

  /** One clip of the look on one point, sized and layered the way AA plays it. */
  static _poof(effect, clip, point, doc, delay) {
    const o = clip.options ?? {};
    const { w, h } = Teleport._size(doc);
    effect.file(clip.path).atLocation(point)
      .size(Math.max(w, h) * 1.5 * (Number(o.size) || 1), { gridUnits: true });
    if (delay > 0) effect.delay(delay);
    if (Number(o.fadeIn) > 0) effect.fadeIn(Number(o.fadeIn));
    if (Number(o.fadeOut) > 0) effect.fadeOut(Number(o.fadeOut));
    const opacity = Number(o.opacity ?? 1);
    if (Number.isFinite(opacity) && opacity > 0 && opacity !== 1) effect.opacity(opacity);
    const rate = Number(o.playbackRate ?? 1);
    if (Number.isFinite(rate) && rate > 0 && rate !== 1) effect.playbackRate(rate);
    const elevation = Number(o.elevation ?? 0) || 0;
    // AA's own rule: an elevation that is not absolute sits one below the number.
    effect.elevation(o.isAbsolute ? elevation : elevation - 1, { absolute: !!o.isAbsolute });
    return effect;
  }

  /**
   * Move each traveller, with the look: the leaving clip where each one stands
   * and the sound, then, at the preset's own arrival beat, the arriving clip
   * where each one lands AND the move itself, together. Johnny: "ACE plays the
   * hop animation at the moment he arrives. Keep the look he already likes."
   *
   * @param {{doc: TokenDocument, to: {x: number, y: number}}[]} moves
   * @param {Item} item   whose look it is
   * @param {{look?: boolean}} [opts]  false moves them without it
   * @returns {Promise<boolean>} whether every one of them moved
   */
  static async _arrive(moves, item, { look: withLook = true } = {}) {
    const look = withLook ? Teleport._look(item) : null;
    const plan = moves.map(({ doc, to }) => ({ doc, to,
      from: Teleport._centre(Number(doc.x) || 0, Number(doc.y) || 0, doc),
      at: Teleport._centre(to.x, to.y, doc) }));
    const play = (seq, what) => Promise.resolve(seq.play())
      .catch(err => console.warn(`${LOG} | the ${what} clip of the teleport look failed; the move is unaffected:`, err));

    let beat = 0;
    if (look) {
      try {
        const out = new Sequence();
        if (look.sound) out.sound().file(look.sound.file).volume(look.sound.volume).delay(look.sound.delay);
        if (look.start) {
          for (const p of plan) Teleport._poof(out.effect(), look.start, p.from, p.doc, Number(look.start.options?.delay) || 0);
        }
        play(out, "leaving");
        beat = look.end ? Math.max(0, Number(look.end.options?.delay) || 0) : 0;
      } catch (err) {
        console.warn(`${LOG} | the leaving clip of the teleport look could not be built; they still go:`, err);
      }
    }
    if (beat > 0) await new Promise(resolve => setTimeout(resolve, beat));
    if (look?.end) {
      try {
        const arrive = new Sequence();
        for (const p of plan) Teleport._poof(arrive.effect(), look.end, p.at, p.doc, 0);
        play(arrive, "arriving");
      } catch (err) {
        console.warn(`${LOG} | the arriving clip of the teleport look could not be built; they still arrive:`, err);
      }
    }
    const moved = await Promise.all(plan.map(p => Teleport.displace(p.doc, p.to)));
    return moved.every(Boolean);
  }

  /* ── A) The hop ────────────────────────────────────────────────────────── */

  static async runHop(ctx) {
    const tp = ctx.entry?.teleport ?? readTeleport(ctx.item, ctx.activity);
    const token = Teleport.tokenOf(ctx.actor);
    if (!token) {
      ui.notifications?.warn(`${ctx.actor?.name ?? "That creature"} has no token on this scene to teleport.`);
      await giveBack(ctx, "it has no token on this scene, so nothing moves");
      return false;
    }
    const doc = token.document;
    const to = await Teleport.pickSquare(token, tp.feet);
    if (!to) {
      await giveBack(ctx, `${doc.name} stays where it is (no square was picked)`);
      return false;
    }
    // The aiming is over before anything moves: one click, one move, one look.
    const feet = Math.round(Teleport._moveFeet(doc, { x: doc.x, y: doc.y }, to));
    const moved = await Teleport._arrive([{ doc, to }], ctx.item);
    if (moved) console.log(`${LOG} | ${doc.name} teleports ${feet} feet (${ctx.item?.name}, up to ${tp.feet}).`);
    return moved;
  }

  /* ── B) The spell ──────────────────────────────────────────────────────── */

  /** Creatures within 10 feet of the caster that it can see: who may come along. */
  static companions(casterToken) {
    const eye = casterToken.center ?? Teleport._centre(casterToken.document.x, casterToken.document.y, casterToken.document);
    return (canvas.tokens?.placeables ?? []).filter(t => {
      if (!t?.actor || t.id === casterToken.id) return false;
      if (t.document?.hidden && !game.user?.isGM) return false;
      if (isDead(t)) return false;
      if (aceDistanceFt(casterToken, t) > 10) return false;
      return Teleport._canSee(eye, t.center ?? eye);
    });
  }

  /**
   * Who comes, how well the caster knows the place, and where it is.
   * @returns {Promise<null|{who: Token[], familiarity: string, where: "map"|"elsewhere", place: string}>}
   */
  static async askPlan({ caster, nearby, edition }) {
    const DialogV2 = foundry.applications?.api?.DialogV2;
    if (!DialogV2) {
      console.warn(`${LOG} | no dialog to ask where to go; the spell does nothing.`);
      return null;
    }
    const rows = TELEPORT_TABLES[edition];
    const who = nearby.length
      ? nearby.map(t => `
          <label style="display:flex;align-items:center;gap:10px;padding:5px 2px;cursor:pointer;">
            <input type="checkbox" name="who" value="${esc(t.id)}" />
            <img src="${esc(t.document?.texture?.src ?? t.actor?.img ?? "icons/svg/mystery-man.svg")}" style="width:36px;height:36px;border-radius:50%;border:1px solid #6a5a9a;object-fit:cover;" />
            <span>${esc(t.name)}</span>
          </label>`).join("")
      : `<div style="color:#b9b0cf;font-size:14px;">Nobody within 10 feet that ${esc(caster.name)} can see.</div>`;
    const familiarity = rows.map((r, i) => `
        <label style="display:block;padding:3px 2px;cursor:pointer;">
          <input type="radio" name="familiarity" value="${r.key}" ${i === 2 ? "checked" : ""} /> ${esc(r.label)}
        </label>`).join("");
    const content = `
      <div style="background:#15121c;border:1px solid #5b4a8a;border-radius:8px;padding:14px 16px;color:#ece6ff;font-size:16px;line-height:1.45;">
        <div style="font-size:18px;font-weight:700;color:#cbb6ff;margin-bottom:8px;">Who comes with ${esc(caster.name)}?</div>
        <div style="color:#b9b0cf;font-size:14px;margin-bottom:4px;">Willing creatures within 10 feet, up to eight.</div>
        <div class="ace-tp-who">${who}</div>
        <div class="ace-tp-too-many" style="display:none;color:#ff8a80;font-size:14px;">Up to eight may come.</div>
        <div style="font-size:18px;font-weight:700;color:#cbb6ff;margin:14px 0 6px;">How well is the place known?</div>
        ${familiarity}
        <div style="font-size:18px;font-weight:700;color:#cbb6ff;margin:14px 0 6px;">Where?</div>
        <label style="display:block;padding:3px 2px;cursor:pointer;">
          <input type="radio" name="where" value="map" checked /> A spot on this map
        </label>
        <label style="display:block;padding:3px 2px;cursor:pointer;">
          <input type="radio" name="where" value="elsewhere" /> Somewhere else:
        </label>
        <input type="text" name="place" placeholder="Vallaki, the Amber Temple gate" style="width:100%;margin-top:4px;background:#0f0d14;color:#ece6ff;border:1px solid #5b4a8a;border-radius:5px;padding:6px 8px;font-size:16px;" />
      </div>`;
    const result = await DialogV2.wait({
      window: { title: "Teleport" },
      position: { width: 460 },
      content,
      render: (_event, dialog) => {
        // At most eight: the ninth box cannot be ticked, and says why.
        const root = dialog?.element;
        const boxes = [...(root?.querySelectorAll?.("input[name=who]") ?? [])];
        const warn = root?.querySelector?.(".ace-tp-too-many");
        const cap = () => {
          const n = boxes.filter(b => b.checked).length;
          for (const b of boxes) b.disabled = !b.checked && n >= 8;
          if (warn) warn.style.display = n >= 8 && boxes.length > 8 ? "block" : "none";
        };
        for (const b of boxes) b.addEventListener("change", cap);
        root?.querySelector?.("input[name=place]")?.addEventListener("focus", () => {
          const r = root.querySelector("input[name=where][value=elsewhere]");
          if (r) r.checked = true;
        });
      },
      buttons: [
        { action: "go", label: "Teleport", icon: "fa-solid fa-person-rays", default: true,
          callback: (_e, button) => {
            const f = button.form;
            const ids = [...f.querySelectorAll("input[name=who]:checked")].map(b => b.value).slice(0, 8);
            return {
              who: ids.map(id => nearby.find(t => t.id === id)).filter(Boolean),
              familiarity: f.elements.familiarity?.value ?? "very",
              where: f.elements.where?.value === "elsewhere" ? "elsewhere" : "map",
              place: String(f.elements.place?.value ?? "").trim(),
            };
          } },
        { action: "cancel", label: "Cancel", icon: "fa-solid fa-xmark" },
      ],
    });
    return result && typeof result === "object" ? result : null;
  }

  /**
   * Throw one roll and wait for its dice to land.
   *
   * ⚠️ THE DESTINATION DICE ARE THE GM'S (his table, 2026-09-18: "Those
   * destination dice are GM-only."). The d100 and the dice that say where an
   * off-target group ends up tumble on the GMs' screens only. A mishap's 3d10
   * is damage, and rolls where everybody sees damage roll.
   */
  static async _roll(formula, label, { gmOnly = false } = {}) {
    const roll = await new Roll(formula).evaluate();
    const users = gmOnly ? (game.users?.filter?.(u => u.isGM)?.map(u => u.id) ?? []) : null;
    safeShowForRoll(roll, label, { users: users?.length ? users : null });
    await awaitDiceSettle();
    return roll;
  }

  /** A mishap's force damage, on the suite's own damage card, once its dice have landed. */
  static async _mishapCard(docs, roll, casterActor) {
    const components = [];
    const rows = [];
    const results = [];
    for (const doc of docs) {
      const actor = doc.actor;
      let modifier = "normal", final = roll.total;
      try {
        const m = DamageCalculator.getTargetDamageModifiers(actor)?.force?.modifier;
        if (m === "immune") { modifier = "immune"; final = 0; }
        else if (m === "resistant") { modifier = "resistant"; final = Math.floor(roll.total / 2); }
        else if (m === "vulnerable") { modifier = "vulnerable"; final = roll.total * 2; }
      } catch (err) {
        console.warn(`${LOG} | could not read ${doc.name}'s force resistance; it takes the full amount:`, err);
      }
      const comp = [{ name: "Teleport mishap", type: "force", raw: roll.total, final, modifier, formula: roll.formula }];
      if (!components.length) components.push(...comp);
      const hp = { value: Number(actor?.system?.attributes?.hp?.value) || 0, max: Number(actor?.system?.attributes?.hp?.max) || 0 };
      const img = actor?.img || doc.texture?.src || "icons/svg/mystery-man.svg";
      rows.push(DamageCardRenderer.buildTargetRowHtml({ tokenDocId: doc.id, actorId: actor?.id, sceneId: doc.parent?.id,
        name: doc.name, img, currentHP: hp.value, maxHP: hp.max, totalFinal: final, isCrit: false, components: comp }));
      results.push({ targetId: actor?.id, tokenId: doc.id, tokenDocId: doc.id, sceneId: doc.parent?.id,
        isLinked: doc.actorLink ?? false, totalFinal: final, currentHP: hp.value, maxHP: hp.max,
        name: doc.name, img, components: comp });
    }
    const diceRows = DamageCardRenderer.buildComponentRowsHtml(components, { baseName: "Teleport mishap" });
    await CardDoor.post({
      speaker: ChatMessage.getSpeaker({ actor: casterActor }),
      content: `<div class="ace-qol-damage-card">
          <div class="ace-qol-dmg-header">
            <strong class="ace-qol-dmg-item-name">Teleport: a mishap tears at them</strong>
          </div>
          <div class="ace-qol-dmg-roll-section"><div class="ace-qol-dmg-components">${diceRows}</div></div>
          <div class="ace-qol-dmg-targets">${rows.join("")}</div>
          <div class="ace-qol-dmg-gm-controls">
            <div class="ace-qol-dmg-actions">
              <button class="ace-qol-btn ace-qol-btn-apply" data-action="aceQolApplyDamage"><i class="fas fa-heart-crack"></i> APPLY ALL</button>
              <button class="ace-qol-btn ace-qol-btn-undo" data-action="aceQolUndoDamage" disabled><i class="fas fa-undo"></i> UNDO ALL</button>
            </div>
          </div>
        </div>`,
      flags: { [MODULE_ID]: { type: "damageResult", damageResults: results, totalRaw: roll.total } },
    }, { dice: true });
  }

  /**
   * The 7th-level spell: the caster's choices on the caster's screen, then the
   * table on the GM's. Returns false when nobody went (cancelled), so the
   * pipeline can give the slot back.
   */
  static async runSpell(ctx) {
    const edition = RulesBrain.resolveEdition(ctx.item, ctx.actor) === "2024" ? "2024" : "2014";
    const casterToken = Teleport.tokenOf(ctx.actor);
    if (!casterToken) {
      ui.notifications?.warn(`${ctx.actor?.name ?? "The caster"} has no token on this scene to teleport from.`);
      await giveBack(ctx, "no token on this scene, so the spell does nothing and its slot is kept");
      return false;
    }
    const caster = casterToken.document;
    const plan = await Teleport.askPlan({ caster, nearby: Teleport.companions(casterToken), edition });
    if (!plan) {
      await giveBack(ctx, `${caster.name} does not cast it (the plan was cancelled), and the slot is kept`);
      return false;
    }
    const docs = [caster, ...plan.who.map(t => t.document)];
    let point = null;
    if (plan.where === "map") {
      point = await Teleport.pickPoint(docs, caster);
      if (!point) {
        await giveBack(ctx, `${caster.name} does not cast it (no spot was picked), and the slot is kept`);
        return false;
      }
    }
    // From here the spell is cast: the slot is spent (by the caller) and the
    // table decides.
    if (typeof ctx.onCommit === "function") await ctx.onCommit();

    const table = { edition, familiarity: plan.familiarity, where: plan.where, place: plan.place, point,
      sceneId: caster.parent?.id ?? null, casterId: caster.id, travellers: docs.map(d => d.id),
      actorUuid: ctx.actor?.uuid ?? null, itemUuid: ctx.item?.uuid ?? null };

    // ⚠️ THE TABLE IS ROLLED ON A GM'S SCREEN. The destination dice are the
    // GM's, and so is the card that says what they meant. A player who casts it
    // chose who and where on their own screen; the dice go to the GM.
    if (game.user?.isGM) {
      await Teleport.runTable({ ...table, docs, actor: ctx.actor, item: ctx.item });
      return true;
    }
    const gm = game.users?.activeGM ?? null;
    if (!gm) {
      console.warn(`${LOG} | no GM is connected to roll the Teleport table, so it is rolled here, `
        + `where ${game.user?.name ?? "this player"} can see it.`);
      await Teleport.runTable({ ...table, docs, actor: ctx.actor, item: ctx.item, gmOnly: false });
      return true;
    }
    game.socket.emit(`module.${MODULE_ID}`, { action: "teleportTable", table, userId: game.user.id });
    console.log(`${LOG} | ${caster.name}'s Teleport goes to ${gm.name} to roll: the destination dice are the GM's.`);
    return true;
  }

  /**
   * A player's Teleport, arriving at the GM: checked, then rolled here.
   *
   * ⚠️ A SOCKET CARRIES NO TRUSTED SENDER. The player must own the caster, the
   * item must be that creature's 7th-level Teleport, the travellers must stand
   * on the caster's scene, and when the GM is looking at that scene, within 10
   * feet of the caster where it can see them, eight at most.
   */
  static async fromSocket(payload) {
    const t = payload?.table ?? {};
    const refuse = (why) => console.warn(`${LOG} | a Teleport table from a player was REFUSED: ${why}.`);
    try {
      const actor = t.actorUuid ? await fromUuid(t.actorUuid) : null;
      if (!replyOwnerIsAuthorised(payload, actor, "Teleport table")) return;
      const item = t.itemUuid ? await fromUuid(t.itemUuid) : null;
      if (!item || item.actor !== actor) return refuse(`the item is not ${actor?.name ?? "that creature"}'s`);
      if (readTeleport(item)?.kind !== "spell") return refuse(`"${item.name}" is not the 7th-level Teleport`);
      const scene = game.scenes?.get?.(t.sceneId) ?? null;
      const casterDoc = scene?.tokens?.get?.(t.casterId) ?? null;
      if (!casterDoc || casterDoc.actor !== actor) return refuse(`${actor.name} has no token there`);
      const onScreen = canvas.scene?.id === scene.id && !!casterDoc.object;
      const near = onScreen ? new Set(Teleport.companions(casterDoc.object).map(k => k.id)) : null;
      const extras = (t.travellers ?? []).filter(id => id !== casterDoc.id);
      const kept = extras.filter(id => scene.tokens.get(id) && (!near || near.has(id))).slice(0, 8);
      if (kept.length !== extras.length) {
        console.warn(`${LOG} | ${extras.length - kept.length} of the creatures ${actor.name} named cannot come `
          + `(not within 10 feet where ${actor.name} can see them, or more than eight).`);
      }
      if (!onScreen) {
        console.warn(`${LOG} | ${actor.name}'s scene is not on this GM's screen, so who came along could not be `
          + `checked for distance and sight, and the look will not play.`);
      }
      const docs = [casterDoc, ...kept.map(id => scene.tokens.get(id))];
      const edition = RulesBrain.resolveEdition(item, actor) === "2024" ? "2024" : "2014";
      const point = t.where === "map" && Number.isFinite(t.point?.x) && Number.isFinite(t.point?.y)
        ? { x: t.point.x, y: t.point.y } : null;
      await Teleport.runTable({ edition, familiarity: t.familiarity, where: point ? "map" : "elsewhere",
        place: String(t.place ?? "").slice(0, 200), point, docs, actor, item, look: onScreen });
    } catch (err) {
      console.warn(`${LOG} | a Teleport table from a player could not be rolled:`, err);
    }
  }

  /**
   * The book's table, rolled: d100 until it is not a mishap (each mishap 3d10
   * force to each, on the damage card, after its dice), then where they end up,
   * then the card. Nothing lands before the dice that decided it.
   */
  static async runTable({ edition, familiarity, where: whereKind, place, point, docs, actor, item,
    gmOnly = true, look = true }) {
    const rows = TELEPORT_TABLES[edition === "2024" ? "2024" : "2014"];
    const row = rows.find(r => r.key === familiarity) ?? rows[2];
    const caster = docs[0];
    const rolls = [];
    let result = "mishap";
    for (let tries = 0; result === "mishap" && tries < 20; tries++) {
      const d100 = await Teleport._roll("1d100", "Teleport", { gmOnly });
      result = Teleport.outcome(edition, row.key, d100.total);
      const entry = { total: d100.total, result };
      rolls.push(entry);
      if (result === "mishap") {
        const force = await Teleport._roll("3d10", "Teleport mishap");
        entry.force = force.total;
        await Teleport._mishapCard(docs, force, actor);
      }
    }

    const names = docs.map(d => d.name);
    const where = whereKind === "map" ? "the spot picked on this map" : (place || "the place named");
    const notes = [];
    let arrival = "";
    let landed = false;
    if (result === "mishap") {
      arrival = "Twenty mishaps in a row: the magic never settles. The GM decides where they end up.";
    } else if (result === "on" && point) {
      landed = await Teleport._land(docs, point, caster.id, item, { look });
      arrival = landed ? "They appear exactly where they meant to." : "They arrive on target, but not every token could be moved; see the console.";
    } else if (result === "on") {
      arrival = `They appear at ${esc(where)}. ACE cannot pick that scene: the GM moves them there.`;
    } else if (result === "similar") {
      arrival = "They appear somewhere that looks like where they meant to go, but is not. The GM places them.";
    } else if (result === "off") {
      const dir = (await Teleport._roll("1d8", "Teleport direction", { gmOnly })).total;
      const heading = COMPASS[edition === "2024" ? "2024" : "2014"][dir - 1];
      if (edition === "2024") {
        const miles = (await Teleport._roll("2d12", "Teleport distance", { gmOnly })).total;
        arrival = `They appear ${miles} miles ${heading} of ${esc(where)}. The GM places them.`;
        notes.push(`2d12 = ${miles} miles; d8 = ${dir}, ${heading}.`);
      } else {
        const a = (await Teleport._roll("1d10", "Teleport distance", { gmOnly })).total;
        const b = (await Teleport._roll("1d10", "Teleport distance", { gmOnly })).total;
        const pct = a * b;
        notes.push(`${a} x ${b} = ${pct}% of the distance; d8 = ${dir}, ${heading}.`);
        // Johnny: "Off-target / similar area: GM places them." ACE works out
        // how far off, in feet, and leaves the placing to the GM.
        if (point) {
          const from = Teleport._centre(Number(caster.x) || 0, Number(caster.y) || 0, caster);
          const feet = (Math.hypot(point.x - from.x, point.y - from.y) / Teleport._g()) * Teleport._ft();
          const off = Math.round((feet * pct) / 100);
          arrival = `They appear off target, about ${off} feet ${heading} of the spot picked `
            + `(${pct}% of the ${Math.round(feet)} feet they meant to go). The GM places them.`;
        } else {
          arrival = `They appear off target, ${pct}% of the distance away to the ${heading} of ${esc(where)}. The GM places them.`;
        }
      }
    }

    await Teleport._resultCard({ edition, row, where, names, rolls, arrival, notes, result, landed, actor, gmOnly });
    console.log(`${LOG} | ${caster.name} casts Teleport (${edition}, ${row.label}): `
      + `${rolls.map(r => `d100 ${r.total} ${r.result}`).join(", ")}${landed ? ", moved on the map" : ""}.`);
    return { result, landed };
  }

  /**
   * The card: each d100, big, with what it meant, then where they end up.
   * For the GMs only when the dice were, and posted only once every die that
   * decided it has landed.
   */
  static async _resultCard({ edition, row, where, names, rolls, arrival, notes, result, landed, actor, gmOnly }) {
    const MEANT = { mishap: "Mishap", similar: "Similar Area", off: "Off Target", on: "On Target" };
    const INK = { mishap: "#ff8a80", similar: "#ffd54f", off: "#ffb74d", on: "#9be29b" };
    const rollRows = rolls.map(r => `
          <div style="display:flex;flex-wrap:wrap;align-items:center;gap:4px 10px;margin-top:8px;">
            <span style="display:inline-flex;align-items:baseline;gap:6px;padding:2px 12px;border-radius:999px;background:#2a2140;border:1px solid #8a5cf6;">
              <span style="font-size:14px;color:#b9b0cf;">d100</span>
              <span style="font-size:20px;font-weight:700;color:#ffffff;">${r.total}</span>
            </span>
            <span style="flex:1 1 160px;font-size:16px;font-weight:700;color:${INK[r.result]};">${MEANT[r.result]}</span>
            ${r.result === "mishap" ? `<span style="flex:1 1 100%;font-size:14px;color:#d8cfee;">3d10 force to each of them: ${r.force}. The table is rolled again.</span>` : ""}
          </div>`).join("");
    const gms = game.users?.filter?.(u => u.isGM)?.map(u => u.id) ?? [];
    await CardDoor.post({
      speaker: ChatMessage.getSpeaker({ actor }),
      whisper: gmOnly ? gms : [],
      content: `
        <div class="ace-qol-teleport-card" style="background:#15121c;border:1px solid #5b4a8a;border-left:4px solid #8a5cf6;border-radius:6px;padding:10px 14px;color:#ece6ff;line-height:1.45;">
          <div style="font-size:18px;font-weight:700;color:#cbb6ff;">Teleport</div>
          <div style="font-size:16px;margin-top:4px;">${names.map(esc).join(", ")} vanish${names.length === 1 ? "es" : ""}.</div>
          ${rollRows}
          <div style="font-size:16px;margin-top:10px;">${arrival}</div>
          ${notes.map(n => `<div style="font-size:14px;color:#d8cfee;margin-top:2px;">${esc(n)}</div>`).join("")}
          <div style="font-size:14px;color:#b9b0cf;margin-top:8px;">${esc(row.label)} on the ${edition} table, bound for ${esc(where)}.</div>
        </div>`,
      flags: { [MODULE_ID]: { type: "teleportResult", edition, familiarity: row.key, result, landed,
        rolls: rolls.map(r => ({ d100: r.total, meant: r.result, force: r.force ?? null })) } },
    }, { dice: true });
  }

  /** Move everyone who went to where they land around `point`, with the look. */
  static async _land(docs, point, casterId, item = null, { look = true } = {}) {
    const moves = [];
    let all = true;
    for (const { doc, to } of Teleport._landing(docs, point, casterId)) {
      if (!to) { all = false; console.warn(`${LOG} | no free square near the arrival point for ${doc.name}.`); continue; }
      moves.push({ doc, to });
    }
    if (moves.length && !(await Teleport._arrive(moves, item, { look }))) all = false;
    return all;
  }
}
