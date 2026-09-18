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
   */
  static _aim({ draw, choose, hint }) {
    return new Promise((resolve) => {
      const layer = Teleport._layer();
      const onBoard = (ev) => {
        const board = document.getElementById("board");
        return !!board && (ev.target === board || board.contains(ev.target));
      };
      let done = false;
      const finish = (value) => {
        if (done) return;
        done = true;
        document.removeEventListener("pointermove", onMove, true);
        document.removeEventListener("pointerdown", onDown, true);
        document.removeEventListener("keydown", onKey, true);
        try { layer.destroy({ children: true }); } catch (_) { /* already gone */ }
        resolve(value);
      };
      const onMove = (ev) => {
        if (!onBoard(ev)) return;
        try { draw(layer, PartyTransfer._clientToCanvas(ev.clientX, ev.clientY)); }
        catch (err) { console.warn(`${LOG} | could not draw under the cursor:`, err); }
      };
      const onDown = (ev) => {
        if (!onBoard(ev)) return;
        if (ev.button === 2) { ev.preventDefault(); ev.stopPropagation(); finish(null); return; }
        if (ev.button !== 0) return;
        ev.preventDefault();
        ev.stopPropagation();
        const picked = choose(PartyTransfer._clientToCanvas(ev.clientX, ev.clientY));
        if (picked) finish(picked);
      };
      const onKey = (ev) => {
        if (ev.key !== "Escape") return;
        ev.preventDefault();
        ev.stopPropagation();
        finish(null);
      };
      document.addEventListener("pointermove", onMove, true);
      document.addEventListener("pointerdown", onDown, true);
      document.addEventListener("keydown", onKey, true);
      try { draw(layer, null); } catch (err) { console.warn(`${LOG} | could not draw the squares:`, err); }
      ui.notifications?.info(hint);
    });
  }

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

  /**
   * Nothing happened, so give back what pressing it spent: a daily use, a
   * recharge, a legendary action, an innate casting. dnd5e wrote down exactly
   * what it took on the usage message, and its own refund puts that back, the
   * same as the Refund on its card. A slot the spell pipeline held back was
   * never taken, so it is not in there to give back twice.
   */
  static async _giveBack(ctx, why) {
    const who = ctx.actor?.name ?? "That creature";
    const what = ctx.item?.name ?? "it";
    const deltas = ctx.message?.system?.deltas;
    const spent = (deltas?.actor?.length ?? 0)
      + Object.values(deltas?.item ?? {}).reduce((n, c) => n + (c?.length ?? 0), 0)
      + (deltas?.created?.length ?? 0) + (deltas?.deleted?.length ?? 0);
    if (!spent) {
      console.log(`${LOG} | ${who}: ${why}; pressing ${what} spent nothing that needs giving back.`);
      return;
    }
    if (typeof ctx.activity?.refund !== "function") {
      console.warn(`${LOG} | ${who}: ${why}, but what ${what} spent cannot be given back from here; `
        + `use Refund on its card.`);
      return;
    }
    try {
      await ctx.activity.refund(deltas);
      // As dnd5e's own Refund does, so the card cannot give it back a second time.
      if (typeof ctx.message?.update === "function") await ctx.message.update({ "system.deltas": null });
      console.log(`${LOG} | ${who}: ${why}, so what pressing ${what} spent is given back.`);
    } catch (err) {
      console.warn(`${LOG} | ${who}: ${why}, and giving back what ${what} spent failed; use Refund on its card:`, err);
    }
  }

  /** The token a creature is acting from, on the scene being looked at. */
  static tokenOf(actor) {
    return canvas.tokens?.controlled?.find(t => t.actor === actor)
      ?? actor?.getActiveTokens?.()?.find(t => t.scene?.id === canvas.scene?.id || t.document?.parent?.id === canvas.scene?.id)
      ?? actor?.getActiveTokens?.()?.[0]
      ?? null;
  }

  /* ── A) The hop ────────────────────────────────────────────────────────── */

  static async runHop(ctx) {
    const tp = ctx.entry?.teleport ?? readTeleport(ctx.item, ctx.activity);
    const token = Teleport.tokenOf(ctx.actor);
    if (!token) {
      ui.notifications?.warn(`${ctx.actor?.name ?? "That creature"} has no token on this scene to teleport.`);
      await Teleport._giveBack(ctx, "it has no token on this scene, so nothing moves");
      return false;
    }
    const doc = token.document;
    const to = await Teleport.pickSquare(token, tp.feet);
    if (!to) {
      await Teleport._giveBack(ctx, `${doc.name} stays where it is (no square was picked)`);
      return false;
    }
    const feet = Math.round(Teleport._moveFeet(doc, { x: doc.x, y: doc.y }, to));
    const moved = await Teleport.displace(doc, to);
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

  /** Throw one roll and wait for its dice to land. */
  static async _roll(formula, label) {
    const roll = await new Roll(formula).evaluate();
    safeShowForRoll(roll, label);
    await awaitDiceSettle();
    return roll;
  }

  /** A mishap's force damage, on the suite's own damage card. */
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
    });
  }

  /**
   * The 7th-level spell, start to finish. Returns false when nobody went
   * (cancelled), so the pipeline can give the slot back.
   */
  static async runSpell(ctx) {
    const edition = RulesBrain.resolveEdition(ctx.item, ctx.actor) === "2024" ? "2024" : "2014";
    const casterToken = Teleport.tokenOf(ctx.actor);
    if (!casterToken) {
      ui.notifications?.warn(`${ctx.actor?.name ?? "The caster"} has no token on this scene to teleport from.`);
      await Teleport._giveBack(ctx, "no token on this scene, so the spell does nothing and its slot is kept");
      return false;
    }
    const caster = casterToken.document;
    const plan = await Teleport.askPlan({ caster, nearby: Teleport.companions(casterToken), edition });
    if (!plan) {
      await Teleport._giveBack(ctx, `${caster.name} does not cast it (the plan was cancelled), and the slot is kept`);
      return false;
    }
    const docs = [caster, ...plan.who.map(t => t.document)];
    let point = null;
    if (plan.where === "map") {
      point = await Teleport.pickPoint(docs, caster);
      if (!point) {
        await Teleport._giveBack(ctx, `${caster.name} does not cast it (no spot was picked), and the slot is kept`);
        return false;
      }
    }
    // From here the spell is cast: the slot is spent (by the caller) and the
    // table decides.
    if (typeof ctx.onCommit === "function") await ctx.onCommit();

    const row = TELEPORT_TABLES[edition].find(r => r.key === plan.familiarity) ?? TELEPORT_TABLES[edition][2];
    const lines = [];
    let result = "mishap";
    for (let tries = 0; result === "mishap" && tries < 20; tries++) {
      const d100 = await Teleport._roll("1d100", "Teleport");
      result = Teleport.outcome(edition, row.key, d100.total);
      lines.push(`d100 ${d100.total}: ${{ mishap: "Mishap", similar: "Similar Area", off: "Off Target", on: "On Target" }[result]}`);
      if (result === "mishap") {
        const force = await Teleport._roll("3d10", "Teleport mishap");
        lines.push(`3d10 force to each: ${force.total}, and the table is rolled again`);
        await Teleport._mishapCard(docs, force, ctx.actor);
      }
    }
    if (result === "mishap") lines.push("Twenty mishaps in a row; the GM decides where they end up.");

    const names = docs.map(d => d.name);
    const where = plan.where === "map" ? "the spot picked on this map" : (plan.place || "the place named");
    let arrival = "";
    let landed = false;
    if (result === "mishap") {
      arrival = "The magic never settles. The GM decides where they end up.";
    } else if (result === "on" && point) {
      landed = await Teleport._land(docs, point, caster.id);
      arrival = landed ? "They appear exactly where they meant to." : "They arrive on target, but not every token could be moved; see the console.";
    } else if (result === "on") {
      arrival = `They appear at ${esc(where)}. ACE cannot pick that scene: the GM moves them there.`;
    } else if (result === "similar") {
      arrival = "They appear somewhere that looks like where they meant to go, but is not. The GM places them.";
    } else if (result === "off") {
      const dir = (await Teleport._roll("1d8", "Teleport direction")).total;
      const heading = COMPASS[edition][dir - 1];
      if (edition === "2024") {
        const miles = (await Teleport._roll("2d12", "Teleport distance")).total;
        arrival = `They appear ${miles} miles ${heading} of ${esc(where)}. The GM places them.`;
        lines.push(`Off Target: 2d12 = ${miles} miles, d8 = ${dir} (${heading})`);
      } else {
        const a = (await Teleport._roll("1d10", "Teleport distance")).total;
        const b = (await Teleport._roll("1d10", "Teleport distance")).total;
        const pct = a * b;
        lines.push(`Off Target: ${a} x ${b} = ${pct}% of the distance, d8 = ${dir} (${heading})`);
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

    await CardDoor.post({
      speaker: ChatMessage.getSpeaker({ actor: ctx.actor }),
      content: `
        <div class="ace-qol-teleport-card" style="background:#15121c;border:1px solid #5b4a8a;border-left:4px solid #8a5cf6;border-radius:6px;padding:10px 14px;color:#ece6ff;line-height:1.45;">
          <div style="font-size:18px;font-weight:700;color:#cbb6ff;">Teleport</div>
          <div style="font-size:16px;margin-top:4px;">${names.map(esc).join(", ")} vanish${names.length === 1 ? "es" : ""}.</div>
          <div style="font-size:16px;margin-top:6px;">${arrival}</div>
          <div style="font-size:14px;color:#b9b0cf;margin-top:8px;">${esc(row.label)} (${edition} table), bound for ${esc(where)}.</div>
          ${lines.map(l => `<div style="font-size:14px;color:#b9b0cf;">${esc(l)}</div>`).join("")}
        </div>`,
      flags: { [MODULE_ID]: { type: "teleportResult", edition, familiarity: row.key, result, landed } },
    });
    console.log(`${LOG} | ${caster.name} casts Teleport (${edition}, ${row.label}): ${result}${landed ? ", moved on the map" : ""}.`);
    return true;
  }

  /** Move everyone who went to where they land around `point`. */
  static async _land(docs, point, casterId) {
    let all = true;
    for (const { doc, to } of Teleport._landing(docs, point, casterId)) {
      if (!to) { all = false; console.warn(`${LOG} | no free square near the arrival point for ${doc.name}.`); continue; }
      if (!(await Teleport.displace(doc, to))) all = false;
    }
    return all;
  }
}
