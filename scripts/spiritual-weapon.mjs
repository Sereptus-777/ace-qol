// ─── ACE QOL — Spiritual Weapon: a weapon on the map that attacks as itself ──
//
// His call, 2026-10-14: "I just want to completely take care of Spiritual
// Weapon ourselves", with a picker for its look that remembers each caster.
//
// THE BOOKS (dnd5e 5.3.3's own packs, read 2026-10-14):
//   2014: "You create a floating, spectral weapon within range [60 ft] that
//         lasts for the duration [1 minute] or until you cast this spell again.
//         When you cast the spell, you can make a melee spell attack against a
//         creature within 5 feet of the weapon ... 1d8 + your spellcasting
//         ability modifier. As a bonus action on your turn, you can move the
//         weapon up to 20 feet and repeat the attack." +1d8 per two slot levels
//         above 2nd. Not concentration.
//   2024: the same, concentration, +1d8 per slot level above 2nd, and dnd5e
//         builds it as a SUMMON: a "Spiritual Weapon" creature whose "Move and
//         Attack" matches the caster's spell attack.
//
// ONE WEAPON, WHICHEVER COPY IS CAST. His world holds both shapes (a 2014 copy is
// only an attack; a 2024 copy summons), and the table sees one thing: a token
// that attacks as ITSELF. Then everything the attack road already does (5 feet of
// reach, cover, advantage, the card) is measured from the weapon's square, which
// is where the book says the attack comes from. The 2024 copy is dnd5e's own
// summon; the 2014 copy places the same creature, with the same matched attack
// and its own edition's dice.
//
// ⚠️ NOT A CREATURE: the token carries flags.ace-qol.notACreature, which the
// picker rule, targeting, areas, auras, the cold hour and initiative all read
// (road/picker-rule.mjs, notACreature).
// ⚠️ HOW IT ENDS, BY EDITION: 1 minute, or a recast; a concentration copy also
// when concentration ends (ACE's concentration sweep removes summons), and the
// GM deleting it ends that concentration (his rule, 2026-10-14; the token door
// in concentration-widget.mjs). A 2014 weapon does NOT end when its caster
// drops: it is not concentration.
// ⚠️ GM PATH FIRST: placing a token and fetching the weapon creature need a GM.
// A player's caster is part 2 (ownership of the weapon), said out loud below.
// ──────────────────────────────────────────────────────────────────────────────

import { isSpiritualWeapon } from "./rules/spell-name.mjs";
import { aimAt } from "./road/aim.mjs";
// A weapon replaced by a recast is not a dismissed one (rules/spell-tokens.mjs).
import { removedBecause } from "./rules/spell-tokens.mjs";

const MODULE_ID = "ace-qol";
const LOG = "ace-qol | Spiritual Weapon";
const say = (m) => console.log(`${LOG} | ${m}`);
const _esc = (s) => foundry.utils.escapeHTML(String(s ?? ""));

/** What the token is, for every reader of road/picker-rule.mjs's notACreature. */
const THING = "Spiritual Weapon";
/** dnd5e's own weapon creature, the one its 2024 summon places. */
const WEAPON_ACTOR = "Compendium.dnd5e.actors24.Actor.phbsplSpiritualW";
/** JB2A's weapons in Sequencer's database. */
const ART_ROOT = "jb2a.spiritual_weapon";
const DEFAULT_ART = /Mace01_01_Spectral_Blue_/i;
const CAST_FT = 60;
const MOVE_FT = 20;
const REACH_FT = 5;
const LASTS_SECONDS = 60;

/* ═══ Reading the spell ══════════════════════════════════════════════════ */

function _activities(item) {
  const acts = item?.system?.activities;
  return acts ? [...(acts.values?.() ?? Object.values(acts))] : [];
}

/** Which book this copy is, from the item itself (his rule: the item is what is cast). */
function editionOf(item) {
  const r = String(item?.system?.source?.rules ?? "");
  if (r === "2014" || r === "2024") return r;
  if (_activities(item).some(a => a?.type === "summon")) return "2024";
  try { return game.settings.get("dnd5e", "rulesVersion") === "legacy" ? "2014" : "2024"; }
  catch (_) { return "2014"; }
}

function concentrationOf(item) {
  const p = item?.system?.properties;
  return typeof p?.has === "function" ? p.has("concentration") : (Array.isArray(p) && p.includes("concentration"));
}

/** A press that casts it (spends a slot), rather than a step once it is up. */
const casts = (activity) => activity?.consumption?.spellSlot !== false;

/** The damage dice, by edition, on the weapon's own roll data (dnd5e's summon flags). */
export const DICE = {
  "2014": "(floor(@flags.dnd5e.summon.level / 2))d8 + @flags.dnd5e.summon.mod",
  "2024": "(@flags.dnd5e.summon.level - 1)d8 + @flags.dnd5e.summon.mod",
};

/* ═══ Where things are ═══════════════════════════════════════════════════ */

function _centre(doc, at = null) {
  const g = canvas.grid?.size ?? 100;
  const x = Number(at?.x ?? doc.x) + (Number(doc.width) || 1) * g / 2;
  const y = Number(at?.y ?? doc.y) + (Number(doc.height) || 1) * g / 2;
  return { x, y };
}

function _feet(a, b) {
  try { return canvas.grid.measurePath([a, b]).distance; }
  catch (_) {
    const d = canvas.dimensions;
    return Math.hypot(b.x - a.x, b.y - a.y) * (d?.distance ?? 5) / (d?.size ?? 100);
  }
}

/** The nearest point of a token's own square(s) to a point: range is measured from its edge. */
function _nearestOf(doc, p) {
  const g = canvas.grid?.size ?? 100;
  const x0 = Number(doc.x), y0 = Number(doc.y);
  const x1 = x0 + (Number(doc.width) || 1) * g, y1 = y0 + (Number(doc.height) || 1) * g;
  return { x: Math.min(Math.max(p.x, x0), x1), y: Math.min(Math.max(p.y, y0), y1) };
}

/**
 * The furthest point toward `to` that is no more than `maxFt` from `from`,
 * snapped to a grid centre when that stays inside the limit. "The drag stops
 * at 20 feet": the line you dragged, cut where the feet run out.
 */
function _cutAt(from, to, maxFt) {
  if (_feet(from, to) <= maxFt + 0.01) return { point: to, cut: false };
  const lerp = (t) => ({ x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t });
  let lo = 0, hi = 1;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    if (_feet(from, lerp(mid)) <= maxFt) lo = mid; else hi = mid;
  }
  let point = lerp(lo);
  try {
    const snapped = canvas.grid.getSnappedPoint(point, { mode: CONST.GRID_SNAPPING_MODES.CENTER });
    if (_feet(from, snapped) <= maxFt + 0.01) point = snapped;
  } catch (_) { /* the unsnapped point is inside the limit */ }
  return { point, cut: true };
}

/** A token's top-left for a given centre. */
function _cornerFor(tokenData, centre) {
  const g = canvas.grid?.size ?? 100;
  return { x: centre.x - (Number(tokenData.width) || 1) * g / 2, y: centre.y - (Number(tokenData.height) || 1) * g / 2 };
}

/* ═══ The look ═══════════════════════════════════════════════════════════ */

/**
 * Every Spiritual Weapon JB2A has, from Sequencer's database (the fire engine
 * reads JB2A the same way), so a player's screen needs no file browsing.
 * @returns {Array<{file, thumb, form, style}>}
 */
export function artCatalog() {
  const db = globalThis.Sequencer?.Database;
  let files = [];
  try {
    if (!db?.entryExists?.(ART_ROOT)) return [];
    files = db.getAllFileEntries(ART_ROOT) ?? [];
  } catch (err) {
    console.warn(`${LOG} | could not read JB2A's Spiritual Weapon list from Sequencer:`, err);
    return [];
  }
  const out = [];
  for (const f of files) {
    if (typeof f !== "string" || /nametag/i.test(f)) continue;
    const base = decodeURIComponent(f.split("/").pop() ?? "");
    const m = base.match(/^SpiritualWeapon_([A-Za-z]+[0-9A-Za-z]*?)(\d{2})_(\d{2})_(.+)_(\d+x\d+)\.webm$/i);
    if (!m) continue;
    const form = m[1].replace(/([a-z])([A-Z0-9])/g, "$1 $2");
    const style = m[4].replace(/_/g, " ").replace(/(\D)(\d+)$/, "$1 $2");
    out.push({ file: f, thumb: f.replace(/_\d+x\d+\.webm$/i, "_Thumb.webp"), form, style });
  }
  return out;
}

/** The look this caster chose before, kept on the caster's own actor (every Priest swings the same). */
function rememberedArt(caster) {
  const base = game.actors?.get?.(caster?.id) ?? caster;
  return base?.getFlag?.(MODULE_ID, "spiritualWeaponArt") ?? null;
}

async function rememberArt(caster, file) {
  const base = game.actors?.get?.(caster?.id) ?? caster;
  try { await base?.setFlag?.(MODULE_ID, "spiritualWeaponArt", file); }
  catch (err) { console.warn(`${LOG} | could not remember ${caster?.name}'s weapon; it will ask again:`, err); }
}

/**
 * The picker: the form, then its colour. The polymorph form picker's cards and
 * classes (one way to build a thing). Resolves the chosen file, or null.
 */
async function pickArt(casterName, catalog) {
  if (!catalog.length) return null;
  const forms = [...new Map(catalog.map(a => [a.form, a])).values()].map(first => {
    const all = catalog.filter(a => a.form === first.form);
    const shown = all.find(a => DEFAULT_ART.test(a.file)) ?? all.find(a => /spectral/i.test(a.style)) ?? all[0];
    return { name: first.form, img: shown.thumb, sub: `${all.length} look${all.length === 1 ? "" : "s"}`, all };
  });
  const form = await _cards(`${casterName}'s Spiritual Weapon`, "What does it look like? ACE remembers it.", forms);
  if (!form) return null;
  if (form.all.length === 1) return form.all[0].file;
  const style = await _cards(`${casterName}'s ${form.name}`, "Which one?",
    form.all.map(a => ({ name: a.style, img: a.thumb, sub: "", art: a })));
  return style?.art?.file ?? null;
}

function _cards(title, sub, entries) {
  return new Promise(async (resolve) => {
    let picked = null, done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const cards = entries.map((e, i) => `
      <div class="ace-qol-poly-card" data-entry-idx="${i}">
        <img class="ace-face" src="${_esc(e.img)}" alt="${_esc(e.name)}" onerror="this.src='icons/svg/sword.svg'" />
        <div class="ace-qol-poly-name">${_esc(e.name)}</div>
        ${e.sub ? `<div class="ace-qol-poly-cr">${_esc(e.sub)}</div>` : ""}
      </div>`).join("");
    const html = `<div class="ace-qol-poly-picker">
        <div class="ace-qol-poly-header"><strong>${_esc(title)}</strong>
          <div class="ace-qol-poly-sub">${_esc(sub)}</div></div>
        <div class="ace-qol-poly-grid">${cards}</div></div>`;
    let dlg;
    try {
      dlg = new foundry.applications.api.DialogV2({
        window: { title: "ACE — Spiritual Weapon", icon: "fas fa-hammer" },
        content: html,
        buttons: [{ action: "cancel", label: "Cancel", default: false, callback: () => null }],
        rejectClose: false, modal: true, position: { width: 720 },
      });
      const origOnClose = dlg._onClose?.bind(dlg);
      dlg._onClose = function (options) { try { origOnClose?.(options); } catch (_) {} finish(picked); };
      await dlg.render({ force: true });
    } catch (err) {
      console.warn(`${LOG} | the weapon picker could not open; the default look is used:`, err);
      return finish(null);
    }
    for (const card of dlg.element?.querySelectorAll?.(".ace-qol-poly-card") ?? []) {
      card.addEventListener("click", () => {
        picked = entries[Number(card.dataset.entryIdx)] ?? null;
        dlg.close().catch(() => finish(picked));
      });
    }
  });
}

/* ═══ The weapon on the map ══════════════════════════════════════════════ */

/** Every Spiritual Weapon this cast of this item left on the scene. */
function weaponsOf(item, scene = canvas?.scene) {
  const uuid = item?.uuid;
  if (!uuid) return [];
  return [...(scene?.tokens ?? [])].filter(t => {
    const sw = t.flags?.[MODULE_ID]?.spiritualWeapon;
    if (sw?.itemUuid === uuid) return true;
    // dnd5e's own summon, before (or without) ACE's stamp.
    return t.actor?.getFlag?.("dnd5e", "summon.origin") === uuid && !!t.flags?.[MODULE_ID]?.notACreature;
  });
}

/**
 * ⚠️🔴 WHAT YOU SEE IS ITS SPACE (his table, 2026-10-14: "it says I'm out of
 * reach, which I'm not. I'm right beside it"). dnd5e's weapon creature is a
 * half-square token, and ACE drew its art at twice that so it could be seen: the
 * picture filled a square while its real half-square sat a step away, and every
 * reach was measured from the half-square. It is one full square now, drawn at
 * its own size and snapped to the square it was placed in.
 */
function squareUp(tokenData) {
  const g = canvas.grid?.size ?? 100;
  const c = _centre(tokenData);
  tokenData.width = 1;
  tokenData.height = 1;
  let corner = { x: Math.floor(c.x / g) * g, y: Math.floor(c.y / g) * g };
  try { corner = canvas.grid.getTopLeftPoint(c) ?? corner; } catch (_) { /* the square arithmetic above */ }
  tokenData.x = corner.x;
  tokenData.y = corner.y;
}

/**
 * What a weapon token carries: its name, its look, its side, its owners, no
 * sight, and the marks that make it "not a creature" and say whose it is and
 * when it ends.
 */
function dress(tokenData, ctx) {
  const { caster, casterDoc, item, edition, art } = ctx;
  tokenData.name = `${casterDoc?.name ?? caster?.name ?? "Its caster"}'s Spiritual Weapon`;
  if (casterDoc && Number.isFinite(Number(casterDoc.disposition))) tokenData.disposition = casterDoc.disposition;
  tokenData.sight = { ...(tokenData.sight ?? {}), enabled: false };
  tokenData.displayBars = CONST.TOKEN_DISPLAY_MODES.NONE;
  tokenData.texture = { ...(tokenData.texture ?? {}), ...(art ? { src: art } : {}), scaleX: 1, scaleY: 1 };
  // ⚠️🔴 WHOEVER OWNS THE CASTER OWNS ITS WEAPON (his table, 2026-10-14: "Why
  // does it say ACE Tester Player is not an owner of Spiritual Weapon? He is the
  // owner."). He owns ACE Test Dummy; the weapon is a creature of its own, and
  // nobody had been given it, so the GM's screen refused every swing the player
  // made. The ownership rides on THIS token's creature only (its actor delta),
  // so a player owns his own weapon and nobody else's.
  if (caster?.ownership) {
    tokenData.delta = foundry.utils.mergeObject(tokenData.delta ?? {}, {
      ownership: foundry.utils.deepClone(caster.ownership),
    });
  }
  const now = Number(game.time?.worldTime ?? 0);
  tokenData.flags = foundry.utils.mergeObject(tokenData.flags ?? {}, {
    [MODULE_ID]: {
      notACreature: THING,
      spiritualWeapon: {
        casterActorId: caster?.id ?? null,
        casterUuid: caster?.uuid ?? null,
        casterTokenId: casterDoc?.id ?? null,
        itemUuid: item?.uuid ?? null,
        itemName: item?.name ?? "Spiritual Weapon",
        edition,
        concentration: concentrationOf(item),
        endsAt: now + LASTS_SECONDS,
      },
    },
  });
  return tokenData;
}

/** The caster's token on this scene. */
function casterDocOf(actor) {
  return actor?.token ?? actor?.getActiveTokens?.()?.[0]?.document ?? null;
}

/* ═══ The engine ═════════════════════════════════════════════════════════ */

export const SpiritualWeapon = {
  /** tokenId -> { left: feet, by: userId } on THIS screen, armed by "Move, then strike". */
  _armed: new Map(),
  /** tokenIds whose next move is ACE's own (a drag cut at 20 feet). */
  _ownMove: new Set(),
  /** item uuids allowed to cast again once, past the "it is up" question. */
  _recast: new Set(),

  register() {
    // ── A press while the weapon is up: move and strike, or cast again ──
    Hooks.on("dnd5e.preUseActivity", (activity) => {
      try { return SpiritualWeapon._onPress(activity); }
      catch (err) { console.warn(`${LOG} | the press could not be read; it goes ahead as pressed:`, err); }
      return undefined;
    });
    // ── A 2014 copy (or any copy that is only an attack): the slot is spent and
    //    the card is posted; the CASTER's attack roll is stopped, and the weapon
    //    is placed and strikes instead.
    Hooks.on("dnd5e.postUseActivity", (activity, usageConfig, results) => {
      try { return SpiritualWeapon._onCast(activity, usageConfig, results); }
      catch (err) { console.error(`${LOG} | the cast could not become a weapon; it rolls as dnd5e would:`, err); }
      return undefined;
    });
    // ── A 2024 copy: dnd5e's own summon places it; ACE dresses it and holds 60 feet.
    Hooks.on("dnd5e.summonToken", (activity, profile, tokenData) => {
      try { SpiritualWeapon._onSummonToken(activity, tokenData); }
      catch (err) { console.warn(`${LOG} | could not dress the summoned weapon:`, err); }
    });
    Hooks.on("dnd5e.postSummon", (activity, profile, tokens) => {
      if (!isSpiritualWeapon(activity?.item)) return;
      SpiritualWeapon._afterSummon(activity, tokens ?? []).catch(err =>
        console.error(`${LOG} | the summoned weapon could not strike:`, err));
    });
    // ── The drag stops at 20 feet ──
    Hooks.on("preMoveToken", (doc, movement, operation) => SpiritualWeapon._onPreMove(doc, movement, operation));
    Hooks.on("moveToken", (doc, movement) => {
      SpiritualWeapon._onMoved(doc, movement).catch(err =>
        console.error(`${LOG} | the weapon moved but could not strike:`, err));
    });
    // ── A minute passes ──
    Hooks.on("updateWorldTime", () => {
      if (game.users?.activeGM !== game.user) return;
      SpiritualWeapon._expire().catch(err => console.warn(`${LOG} | could not end an expired weapon:`, err));
    });
    Hooks.on("deleteToken", (doc) => { SpiritualWeapon._armed.delete(doc.id); SpiritualWeapon._ownMove.delete(doc.id); });
    console.debug(`${LOG} | online: the weapon is a token, and it attacks as itself.`);
  },

  /* ── Pressing it ─────────────────────────────────────────────────────── */

  _onPress(activity) {
    const item = activity?.item;
    if (!isSpiritualWeapon(item)) return undefined;
    if (SpiritualWeapon._recast.delete(item.uuid)) return undefined;      // "Cast it again"
    const up = weaponsOf(item);
    if (!up.length) {
      if (!casts(activity)) {
        ui.notifications?.warn(`${item.name}: no Spiritual Weapon of ${item.actor?.name ?? "this caster"}'s is on the map. Cast it first.`);
        say(`${item.actor?.name}'s ${item.name}: a later step was pressed with no weapon on the map; refused.`);
        return false;
      }
      return undefined;
    }
    SpiritualWeapon._ask(activity, up[0]).catch(err =>
      console.error(`${LOG} | could not ask what the weapon does:`, err));
    return false;
  },

  /** The weapon is up: move and strike, strike from here, cast again, or change its look. */
  async _ask(activity, weaponDoc) {
    const item = activity.item;
    const caster = item.actor;
    const content = `
      <div style="background:linear-gradient(180deg,#15110d 0%,#0c0a08 100%);
                  border:2px solid #d4af37;border-radius:8px;padding:16px 18px;
                  color:#f0e4c0;font-family:'Signika','Helvetica Neue',sans-serif;">
        <div style="font-size:18px;font-weight:700;color:#f5d060;margin-bottom:6px;">
          <i class="fas fa-hammer" style="margin-right:8px;"></i>${_esc(weaponDoc.name)}
        </div>
        <div style="font-size:16px;line-height:1.5;">Your bonus action: move it up to ${MOVE_FT} feet, then strike
          a creature within ${REACH_FT} feet of it.</div>
      </div>`;
    let answer = null;
    try {
      answer = await foundry.applications.api.DialogV2.wait({
        window: { title: "ACE — Spiritual Weapon" },
        position: { width: 480 },
        content,
        modal: true,
        buttons: [
          { action: "move", label: "Move, then strike", icon: "fa-solid fa-arrows-up-down-left-right", default: true },
          { action: "strike", label: "Strike from here", icon: "fa-solid fa-hammer" },
          { action: "look", label: "Change its look", icon: "fa-solid fa-palette" },
          { action: "recast", label: "Cast it again" },
        ],
        rejectClose: false,
      });
    } catch (err) {
      console.warn(`${LOG} | the question could not open; nothing happened:`, err);
      return;
    }
    if (answer === "move") return SpiritualWeapon._arm(weaponDoc);
    if (answer === "strike") return SpiritualWeapon.strike(weaponDoc);
    if (answer === "look") {
      const file = await pickArt(caster?.name ?? "its caster", artCatalog());
      if (!file) return;
      await rememberArt(caster, file);
      await weaponDoc.update({ "texture.src": file });
      say(`${weaponDoc.name} looks different now, and ${caster?.name} keeps that look.`);
      return;
    }
    if (answer === "recast") {
      SpiritualWeapon._recast.add(item.uuid);
      return activity.use();
    }
    say(`${weaponDoc.name}: closed without a choice; nothing happened.`);
  },

  /* ── Casting it ──────────────────────────────────────────────────────── */

  _onCast(activity, usageConfig) {
    const item = activity?.item;
    if (!isSpiritualWeapon(item) || !casts(activity)) return undefined;
    if (activity.type === "summon") return undefined;          // dnd5e places it; see _afterSummon
    if (activity.type !== "attack" && activity.type !== "utility") return undefined;
    SpiritualWeapon._place(activity).catch(err => {
      console.error(`${LOG} | ${item.actor?.name}'s ${item.name}: the weapon could not be placed:`, err);
      ui.notifications?.error(`${item.name}: the weapon could not be placed. See the console.`);
    });
    // The slot is spent and the card is posted; the CASTER does not roll.
    return false;
  },

  /** A copy that is only an attack: place dnd5e's weapon creature, the way its summon would. */
  async _place(activity) {
    const item = activity.item;
    const caster = item.actor;
    const casterDoc = casterDocOf(caster);
    const edition = editionOf(item);
    if (!game.user.isGM) {
      // ⚠️ PART 2, NOT SILENCE: a player cannot place the weapon creature yet.
      ui.notifications?.warn(`${item.name}: ACE places the weapon from the GM's screen for now. Ask the GM to place it.`);
      say(`${caster?.name}'s ${item.name} was cast by a player; placing the weapon from a player's screen is not built yet.`);
      return;
    }
    if (!casterDoc) {
      ui.notifications?.warn(`${item.name}: ${caster?.name ?? "the caster"} has no token on this scene, so there is nowhere to measure 60 feet from.`);
      return;
    }
    await SpiritualWeapon._endOld(item, "it was cast again");

    const rd = activity.getRollData?.() ?? {};
    const level = Number(rd.item?.level ?? item.system?.level ?? 2) || 2;
    const mod = Number(rd.mod) || 0;
    const prof = Number(rd.attributes?.prof) || 0;
    // The caster's spell attack, the way dnd5e's summon matches it.
    let extra = "";
    try { extra = CONFIG.Dice.BasicRoll.replaceFormulaData(rd.bonuses?.msak?.attack ?? "", rd); } catch (_) { /* none */ }
    const attack = [mod, prof, extra].filter(p => p && p !== "0").join(" + ") || "0";

    const weaponActor = await globalThis.dnd5e.documents.Actor5e.fetchExisting(WEAPON_ACTOR);
    let art = rememberedArt(caster);
    const placed = await globalThis.dnd5e.canvas.TokenPlacement.place({ origin: casterDoc, tokens: [weaponActor.prototypeToken] });
    const spot = placed?.[0];
    if (!spot) {
      say(`${caster?.name}'s ${item.name}: no spot was chosen, so no weapon was placed (the slot is spent).`);
      return;
    }
    const tokenData = (await weaponActor.getTokenDocument({ x: spot.x, y: spot.y, elevation: spot.elevation ?? casterDoc.elevation ?? 0 })).toObject();
    squareUp(tokenData);
    SpiritualWeapon._holdRange(tokenData, casterDoc, item);
    dress(tokenData, { caster, casterDoc, item, edition, art });
    tokenData.delta = foundry.utils.mergeObject(tokenData.delta ?? {}, {
      flags: { dnd5e: { summon: { level, mod, origin: item.uuid } } },
    });
    const [weaponDoc] = await canvas.scene.createEmbeddedDocuments("Token", [tokenData]);
    if (!weaponDoc) throw new Error("the weapon token was not created");

    // Its attack is the caster's spell attack, and its dice are this edition's.
    const strikeItem = weaponDoc.actor?.items?.find(i => _activities(i).some(a => a?.type === "attack"));
    const strike = strikeItem ? _activities(strikeItem).find(a => a?.type === "attack") : null;
    if (strike) {
      const parts = foundry.utils.deepClone(strike.damage?.parts?.map?.(p => p.toObject?.() ?? p) ?? []);
      const part = parts[0] ?? { types: ["force"], denomination: 8 };
      part.custom = { enabled: true, formula: DICE[edition] };
      part.types = part.types?.length ? part.types : ["force"];
      await strikeItem.update({
        [`system.activities.${strike.id}.attack.bonus`]: attack,
        [`system.activities.${strike.id}.attack.flat`]: true,
        [`system.activities.${strike.id}.damage.parts`]: [part],
      });
    } else {
      console.warn(`${LOG} | ${weaponDoc.name} has no attack of its own, so it cannot strike.`);
    }
    say(`${caster?.name} cast ${item.name} (${edition}, level ${level}): the weapon is at `
      + `${Math.round(_feet(_nearestOf(casterDoc, _centre(weaponDoc)), _centre(weaponDoc)))} feet; `
      + `its attack is +${attack}, its damage ${DICE[edition]}.`);

    if (!art) art = await SpiritualWeapon._chooseLook(caster, weaponDoc);
    await SpiritualWeapon.strike(weaponDoc);
  },

  /** No look remembered yet: ask once, keep it, and dress the weapon in it. */
  async _chooseLook(caster, weaponDoc) {
    const catalog = artCatalog();
    if (!catalog.length) {
      say(`no JB2A Spiritual Weapon art is in Sequencer's database, so ${weaponDoc.name} keeps the creature's own picture.`);
      return null;
    }
    const file = await pickArt(caster?.name ?? "its caster", catalog)
      ?? catalog.find(a => DEFAULT_ART.test(a.file))?.file ?? catalog[0].file;
    await rememberArt(caster, file);
    try { await weaponDoc.update({ "texture.src": file }); }
    catch (err) { console.warn(`${LOG} | could not dress ${weaponDoc.name} in its look:`, err); }
    return file;
  },

  /** "Within range": the spot it lands on is held to 60 feet from the caster's edge. */
  _holdRange(tokenData, casterDoc, item) {
    const want = _centre(tokenData);
    const from = _nearestOf(casterDoc, want);
    const { point, cut } = _cutAt(from, want, CAST_FT);
    if (!cut) return;
    const corner = _cornerFor(tokenData, point);
    tokenData.x = corner.x;
    tokenData.y = corner.y;
    say(`${item?.name}: the spot chosen was beyond ${CAST_FT} feet, so the weapon stops at ${CAST_FT}.`);
    ui.notifications?.info(`${item?.name}: placed at its ${CAST_FT}-foot range.`);
  },

  /** A 2024 copy: dress dnd5e's own summoned weapon as it is created. */
  _onSummonToken(activity, tokenData) {
    const item = activity?.item;
    if (!isSpiritualWeapon(item)) return;
    const caster = item.actor;
    const casterDoc = casterDocOf(caster);
    squareUp(tokenData);
    if (casterDoc) SpiritualWeapon._holdRange(tokenData, casterDoc, item);
    dress(tokenData, { caster, casterDoc, item, edition: editionOf(item), art: rememberedArt(caster) });
  },

  async _afterSummon(activity, tokens) {
    const item = activity.item;
    const caster = item.actor;
    const weaponDoc = tokens.map(t => t?.document ?? t).find(Boolean);
    if (!weaponDoc) return;
    // Its older weapons go (2014: "until you cast this spell again").
    for (const old of weaponsOf(item)) {
      if (old.id !== weaponDoc.id && game.user.isGM) await old.delete(removedBecause("it was cast again"));
    }
    if (!rememberedArt(caster)) await SpiritualWeapon._chooseLook(caster, weaponDoc);
    await SpiritualWeapon.strike(weaponDoc);
  },

  /** Every older weapon of this item comes off the map. */
  async _endOld(item, why) {
    for (const old of weaponsOf(item)) {
      try { await old.delete(removedBecause(why)); say(`${old.name} is gone: ${why}.`); }
      catch (err) { console.warn(`${LOG} | could not take ${old.name} off the map:`, err); }
    }
  },

  /* ── Striking ────────────────────────────────────────────────────────── */

  /**
   * The weapon attacks as itself: a creature within 5 feet of IT (the attack
   * picker, which takes the only one without asking), aimed, and the weapon's
   * own attack pressed, so the attack road measures everything from its square.
   */
  async strike(weaponDoc) {
    const actor = weaponDoc?.actor;
    const strikeItem = actor?.items?.find(i => _activities(i).some(a => a?.type === "attack"));
    const strike = strikeItem ? _activities(strikeItem).find(a => a?.type === "attack") : null;
    if (!strike) {
      ui.notifications?.warn(`${weaponDoc?.name ?? "The weapon"} has no attack of its own to make.`);
      return;
    }
    const { SpellTargetPicker } = await import("./spell-target-picker.mjs");
    const target = await SpellTargetPicker.pickAttackTarget({ weaponItem: strikeItem, attackerActor: actor, reachFt: REACH_FT });
    if (!target) {
      say(`${weaponDoc.name}: nobody within ${REACH_FT} feet was struck (none there, or none chosen).`);
      return;
    }
    for (const t of [...(game.user.targets ?? [])]) t.setTarget(false, { releaseOthers: false });
    if (!aimAt(target, { releaseOthers: true })) return;
    say(`${weaponDoc.name} strikes at ${target.name}.`);
    await strike.use({}, { configure: false });
  },

  /* ── Moving ──────────────────────────────────────────────────────────── */

  _arm(weaponDoc) {
    SpiritualWeapon._armed.set(weaponDoc.id, { left: MOVE_FT, by: game.user.id });
    weaponDoc.object?.control?.({ releaseOthers: true });
    ui.notifications?.info(`Drag ${weaponDoc.name}: it moves up to ${MOVE_FT} feet, then strikes.`);
    say(`${weaponDoc.name}: armed to move ${MOVE_FT} feet, then strike.`);
  },

  /**
   * Foundry 13 lets a drag be refused, not shortened, so a drag past what is
   * left is refused and the weapon is then moved to the point on the same line
   * where the feet run out.
   */
  _onPreMove(doc, movement, operation) {
    if (!doc?.flags?.[MODULE_ID]?.spiritualWeapon) return undefined;
    if (SpiritualWeapon._ownMove.delete(doc.id) || operation?.aceSpiritualWeapon) return undefined;
    const armed = SpiritualWeapon._armed.get(doc.id);
    if (!armed) {
      ui.notifications?.warn(`${doc.name} moves only on its bonus action: press Spiritual Weapon on its caster and choose Move.`);
      return false;
    }
    const dest = movement?.destination;
    if (!dest) return undefined;
    const from = _centre(doc);
    const to = _centre(doc, dest);
    const feet = _feet(from, to);
    if (feet <= armed.left + 0.01) {
      armed.left = Math.max(0, armed.left - feet);
      return undefined;
    }
    const { point } = _cutAt(from, to, armed.left);
    const corner = _cornerFor(doc, point);
    armed.left = 0;
    SpiritualWeapon._ownMove.add(doc.id);
    setTimeout(() => {
      doc.move({ x: corner.x, y: corner.y, elevation: dest.elevation ?? doc.elevation }, { aceSpiritualWeapon: true })
        .catch?.(err => console.warn(`${LOG} | could not move ${doc.name} to its ${MOVE_FT}-foot mark:`, err));
    }, 0);
    ui.notifications?.info(`${doc.name} stops at ${MOVE_FT} feet.`);
    say(`${doc.name}: dragged ${Math.round(feet)} feet; it stops at ${MOVE_FT}.`);
    return false;
  },

  async _onMoved(doc, movement) {
    const armed = SpiritualWeapon._armed.get(doc?.id);
    if (!armed || armed.by !== game.user.id) return;
    if (movement?.pending?.waypoints?.length) return;          // still moving
    SpiritualWeapon._armed.delete(doc.id);
    await SpiritualWeapon.strike(doc);
  },

  /* ── Ending ──────────────────────────────────────────────────────────── */

  async _expire() {
    const now = Number(game.time?.worldTime ?? 0);
    for (const t of [...(canvas?.scene?.tokens ?? [])]) {
      const sw = t.flags?.[MODULE_ID]?.spiritualWeapon;
      if (!sw || !Number.isFinite(Number(sw.endsAt)) || now < Number(sw.endsAt)) continue;
      try { await t.delete(); say(`${t.name} is gone: its minute is up.`); }
      catch (err) { console.warn(`${LOG} | could not take ${t.name} off the map when its minute ran out:`, err); }
    }
  },
};
