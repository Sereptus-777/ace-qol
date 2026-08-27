// ─── ACE: QOL — Item / Spell / Feature Audit Engine (read-only) ───────────────
// Johnny's idea (2026-06-28): "why can't the engine just CHECK that everything is
// built right?" PHASE 1 — a READ-ONLY audit across the world AND compendiums that
// flags documents whose dnd5e 5.x activity data contradicts itself. It CHANGES
// NOTHING; it only reports. Two ways in:
//   • GM settings button — Quality of Life → "Audit Items, Spells & Features".
//   • Console —  game.aceQol.auditItems()   ("scene" | "selected" | "all")
//
// Catches the classes that bit us live:
//   • Produce Flame — typed melee-spell (msak) but a 30 feet range → should be ranged.
//   • The goat's Ram — an attack with NO melee/ranged type → reach gate can't classify.
// Size-aware: a Gargantuan dragon's 20 feet reach is correct and is NOT flagged.
//
// PHASE 2 (next): a curated RAW reference (2014 + 2024) so we validate against
// canonical book values, not just internal consistency — kills the special-reach
// false positives (Roper, Balor) and turns "verify" into "here's the fix".
// PHASE 3: a confirm-each fix-flow that snapshots each document before changing it.
// ──────────────────────────────────────────────────────────────────────────────

import { lookupRaw, compareToRaw, worldEdition, SIZE_REACH } from "./raw-reference.mjs";

const MODULE_ID = "ace-qol";

// SIZE_REACH (natural melee reach by creature size) is imported from raw-reference.mjs
// so the heuristic and the RAW compare share one source of truth.

// Item-type groups for the audit's "what to check" filter.
export const AUDIT_TYPE_GROUPS = {
  spell:   { label: "Spells",           types: ["spell"] },
  gear:    { label: "Weapons & Gear",   types: ["weapon", "equipment", "consumable", "tool", "loot", "container"] },
  feature: { label: "Features & Feats", types: ["feat"] },
};

/** Inspect one activity for internal contradictions. Returns {kind, issue} or null. */
function _checkActivity(item, activity, actor) {
  try {
    if (activity?.type !== "attack") return null;   // v1 focuses on attack activities

    const actionType = activity?.actionType ?? item.system?.actionType ?? "";
    const range = activity?.range ?? item.system?.range ?? {};
    const units = range?.units ?? "";
    const value = Number(range?.value) || 0;
    const props = item.system?.properties ? new Set(item.system.properties) : new Set();

    // 1. Melee SPELL attack with a >5 feet range → likely ranged (rsak), UNLESS it's a
    //    conjuration that PLACES a weapon (Spiritual Weapon, Bigby's Hand) where the
    //    range is the placement range and the attack really is melee.
    if (actionType === "msak" && units === "ft" && value > 5) {
      return { kind: "msak→rsak?", issue: `Melee spell attack (msak) but range is ${value} feet. If the caster attacks a creature at that range (Produce Flame) it should be RANGED (rsak) — else attack bonuses and the reach check misfire. NOTE: conjuration spells that PLACE a weapon (Spiritual Weapon, Bigby's Hand) are legitimately msak — verify before changing.` };
    }

    // 2. Attack with NO classification → ACE can't tell its reach or apply bonuses.
    if (!actionType) {
      return { kind: "no-type", issue: `Attack activity has no melee/ranged type set — ACE can't classify its reach or apply attack bonuses. Set it to mwak / rwak / msak / rsak.` };
    }

    // 3. Melee WEAPON attack beyond the creature's SIZE-appropriate reach. A
    //    Gargantuan dragon's 20 feet tail is correct; a 600 feet "melee" longbow is not.
    //    Thrown weapons (thr) are skipped — their range is the throw distance.
    if (actionType === "mwak" && units === "ft" && value > 0 && !props.has("thr")) {
      const size = actor?.system?.traits?.size ?? "med";
      const reach = (SIZE_REACH[size] ?? 5) + (props.has("rch") ? 5 : 0);
      if (value > reach) {
        const clearlyRanged = value > 30 || value >= reach * 3;
        return clearlyRanged
          ? { kind: "mwak→ranged?", issue: `Melee weapon attack (mwak) reaching ${value} feet — far past a ${size} creature's ~${reach} feet reach. Almost certainly a RANGED weapon/ability mislabeled as melee (or a thrown weapon missing the Thrown property).` }
          : { kind: "reach-check",  issue: `Melee weapon attack (mwak) reaches ${value} feet, past this ${size} creature's ~${reach} feet reach — verify the reach is intended, or add the Reach property.` };
      }
    }

    return null;
  } catch (_) {
    return null;   // never let one odd activity break the whole audit
  }
}

/**
 * Check one item. If we have a canonical RAW entry for it, that ruling is
 * AUTHORITATIVE (definitive ✓/✗); otherwise fall back to the internal-consistency
 * heuristic, clearly marked "no RAW entry". `actor` may be null for standalone items.
 */
function _checkItem(item, actor, edition = "2014") {
  const out = [];
  try {
    // MONSTER ATTACKS ARE BESPOKE — defined by the creature's stat block, not the
    // generic catalog. A Balor's "Whip" is its 30 feet Flame Whip, not a 10 feet martial
    // whip; a Bugbear's morningstar reaches 10 feet via Long-Limbed. Judging an NPC's
    // attacks by generic weapon/spell values false-flags every special monster, so
    // for NPCs we only flag the one thing wrong regardless of the creature — a
    // missing melee/ranged type. The correct per-creature ruling (vs the canonical
    // stat block) is the monster-reference pass.
    if (actor?.type === "npc") {
      for (const activity of item.system?.activities?.contents ?? []) {
        if (activity?.type !== "attack") continue;
        const at = activity.actionType ?? item.system?.actionType ?? "";
        if (!at) out.push({
          item: item.name, type: item.type, activity: activity.name || activity.type,
          kind: "no-type", source: "heuristic",
          itemVal: "no type set", rawVal: "(monster — vs its stat block)",
          issue: "Attack has no melee/ranged type set — needs mwak / rwak / msak / rsak.",
        });
      }
      return out;
    }

    const raw = lookupRaw(item.name, item.type);
    if (raw) {
      const v = compareToRaw(item, raw, edition, actor);
      if (v) out.push({
        item: item.name, type: item.type, activity: v.field,
        kind: "raw-wrong", source: "RAW",
        itemVal: v.itemVal, rawVal: v.rawVal, issue: v.issue,
      });
      return out;   // RAW is authoritative — a matching item produces NOTHING (clean)
    }
    // No RAW entry → internal-consistency heuristic per attack activity.
    const activities = item.system?.activities?.contents ?? [];
    for (const activity of activities) {
      const r = _checkActivity(item, activity, actor);
      if (r) out.push({
        item: item.name, type: item.type, activity: activity.name || activity.type,
        kind: r.kind, source: "heuristic",
        itemVal: "", rawVal: "(no RAW entry)", issue: r.issue,
      });
    }
  } catch (_) { /* skip a bad item */ }
  return out;
}

/** Audit one actor's embedded items. `where` labels the source location. */
function _auditActor(actor, where = "World", edition = "2014") {
  const out = [];
  if (!actor?.items) return out;
  for (const item of actor.items) {
    for (const f of _checkItem(item, actor, edition)) out.push({ where, owner: actor.name, ...f });
  }
  return out;
}

/** Audit one standalone item (world directory or compendium — no owning actor). */
function _auditItem(item, where = "World", edition = "2014") {
  const out = [];
  for (const f of _checkItem(item, null, edition)) out.push({ where, owner: "—", ...f });
  return out;
}

/** Is this item type included by the selected type-group keys? */
function _typeAllowed(type, groups) {
  if (!groups?.length) return true;
  for (const key of groups) if (AUDIT_TYPE_GROUPS[key]?.types.includes(type)) return true;
  return false;
}

/**
 * Full async audit across the world and/or compendiums. CHANGES NOTHING.
 * @param {object} opts
 * @param {"world"|"compendium"|"both"} [opts.scope]
 * @param {string[]} [opts.types]  group keys from AUDIT_TYPE_GROUPS (default all)
 * @param {(msg:string, pct:number)=>void} [opts.onProgress]
 * @returns {Promise<Array<{where,owner,item,type,activity,kind,issue}>>}
 */
export async function runAudit({ scope = "world", types = Object.keys(AUDIT_TYPE_GROUPS), onProgress } = {}) {
  const findings = [];
  const edition = worldEdition();
  const doWorld = scope === "world" || scope === "both";
  const doPacks = scope === "compendium" || scope === "both";

  if (doWorld) {
    onProgress?.("Scanning world actors…", 0);
    for (const actor of game.actors ?? []) findings.push(..._auditActor(actor, "World actors", edition));
    onProgress?.("Scanning world items…", 0);
    for (const item of game.items ?? []) findings.push(..._auditItem(item, "World items", edition));
  }

  if (doPacks) {
    const packs = (game.packs ?? []).filter(p => p.documentName === "Actor" || p.documentName === "Item");
    let i = 0;
    for (const pack of packs) {
      i++;
      const label = pack.metadata?.label ?? pack.collection ?? "compendium";
      onProgress?.(`Scanning compendium: ${label} (${i}/${packs.length})`, Math.round((i / Math.max(packs.length, 1)) * 100));
      try {
        const docs = await pack.getDocuments();
        if (pack.documentName === "Actor") for (const a of docs) findings.push(..._auditActor(a, label, edition));
        else                               for (const it of docs) findings.push(..._auditItem(it, label, edition));
      } catch (e) {
        console.warn(`${MODULE_ID} | Audit: couldn't read pack "${label}":`, e);
      }
    }
  }

  const filtered = findings.filter(f => _typeAllowed(f.type, types));
  onProgress?.(`Done — ${filtered.length} finding(s).`, 100);
  return filtered;
}

/**
 * Console shortcut. scope: "all" (default) | "scene" | "selected".
 * World/scene only (no compendiums); logs a table. CHANGES NOTHING.
 */
export function auditItems(scope = "all") {
  const actors = new Map();
  try {
    if (scope === "selected") for (const t of canvas.tokens?.controlled ?? []) if (t.actor) actors.set(t.actor.id, t.actor);
    else if (scope === "scene") for (const t of canvas.tokens?.placeables ?? []) if (t.actor) actors.set(t.actor.id, t.actor);
    else { for (const a of game.actors ?? []) actors.set(a.id, a); for (const t of canvas.tokens?.placeables ?? []) if (t.actor) actors.set(t.actor.id, t.actor); }
  } catch (e) {
    console.warn(`${MODULE_ID} | auditItems scope gather failed:`, e);
  }

  const edition = worldEdition();
  const all = [];
  for (const actor of actors.values()) all.push(..._auditActor(actor, "World", edition));

  if (!all.length) {
    console.log(`%c${MODULE_ID} | Item audit (${scope}): no inconsistencies across ${actors.size} actor(s). ✓`, "color:#50c878");
    ui.notifications?.info(`ACE audit: no item issues found (${actors.size} actors checked).`);
    return all;
  }

  console.log(`%c${MODULE_ID} | Item audit (${scope}) — ${all.length} issue(s) across ${actors.size} actor(s):`, "color:#e8a33d;font-weight:bold");
  try { console.table(all); }
  catch (_) { all.forEach(f => console.log(`  • ${f.owner} → ${f.item} (${f.activity}): ${f.issue}`)); }
  ui.notifications?.warn(`ACE audit: ${all.length} item issue(s) — see console (F12), or use the Audit button in Quality-of-Life settings.`);
  return all;
}

// Expose on the ACE QOL API once the game is ready. (We also add these to the API
// object in ace-qol.mjs so they survive the `game.aceQol = {…}` assignment.)
Hooks.once("ready", () => {
  try {
    game.aceQol = game.aceQol || {};
    game.aceQol.auditItems = auditItems;
    game.aceQol.runAudit = runAudit;
  } catch (e) {
    console.warn(`${MODULE_ID} | Audit engine registration failed (non-fatal):`, e);
  }
});
