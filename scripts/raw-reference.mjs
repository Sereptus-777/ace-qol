// ─── ACE: QOL — RAW Reference Table (canonical values, pure-code checker) ──────
// Phase 2 of the audit. A shipped DATA FILE of canonical D&D 5e mechanical values
// that the audit checks every item against — deterministically, in plain code,
// with NO AI and NO network at runtime. AI (the dev) only authors/updates this
// file; players never trigger a model call. Updates ride with module versions.
//
// LICENSING: this holds mechanical values only (attack type, range, reach, damage,
// save) keyed by generic names — game-mechanic facts, which are not copyrightable,
// and SRD content, which is CC-BY-4.0. No flavor text, art, lore, or product-
// identity names. See RAW_ATTRIBUTION below (shipped in the module credits).
//
// COVERAGE (growing): all standard weapons + the common attack/save cantrips +
// the conjuration spells the audit kept mis-flagging. Anything not in here gets
// the heuristic check and is clearly labelled "no RAW entry".
//
// Entry fields:
//   kind     "weapon" | "spell"
//   attack   "mwak" | "rwak" | "msak" | "rsak" | "save" | "util"
//   reach    melee reach in ft (default 5)        — for melee attacks
//   range    [normal, long] in ft                 — for ranged attacks
//   thrown   [normal, long] in ft                 — thrown weapons
//   save     ability ("dex"/"con"/…)              — for save spells
//   damage   base dice ("1d8")    dtype  damage type   (informational for now)
//   props    dnd5e property keys (informational for now)
//   noReachCheck true  → skip the reach check (conjuration/placement-range spells)
//   e2024    { …overrides } applied when the world runs 2024 rules
// ──────────────────────────────────────────────────────────────────────────────

export const RAW_ATTRIBUTION =
  "ACE rules data includes mechanical values from the System Reference Document 5.1 and 5.2, © Wizards of the Coast LLC, available under the Creative Commons Attribution 4.0 International License. ACE is unofficial Fan Content and is not affiliated with, endorsed, or sponsored by Wizards of the Coast.";

const RAW = {
  // ── Simple Melee weapons (mwak) ─────────────────────────────────────────────
  "club":         { kind:"weapon", attack:"mwak", reach:5, damage:"1d4",  dtype:"bludgeoning", props:["lgt"] },
  "dagger":       { kind:"weapon", attack:"mwak", reach:5, thrown:[20,60], damage:"1d4", dtype:"piercing", props:["fin","lgt","thr"] },
  "greatclub":    { kind:"weapon", attack:"mwak", reach:5, damage:"1d8",  dtype:"bludgeoning", props:["two"] },
  "handaxe":      { kind:"weapon", attack:"mwak", reach:5, thrown:[20,60], damage:"1d6", dtype:"slashing", props:["lgt","thr"] },
  "javelin":      { kind:"weapon", attack:"mwak", reach:5, thrown:[30,120], damage:"1d6", dtype:"piercing", props:["thr"] },
  "light hammer": { kind:"weapon", attack:"mwak", reach:5, thrown:[20,60], damage:"1d4", dtype:"bludgeoning", props:["lgt","thr"] },
  "mace":         { kind:"weapon", attack:"mwak", reach:5, damage:"1d6",  dtype:"bludgeoning" },
  "quarterstaff": { kind:"weapon", attack:"mwak", reach:5, damage:"1d6",  dtype:"bludgeoning", props:["ver"] },
  "sickle":       { kind:"weapon", attack:"mwak", reach:5, damage:"1d4",  dtype:"slashing", props:["lgt"] },
  "spear":        { kind:"weapon", attack:"mwak", reach:5, thrown:[20,60], damage:"1d6", dtype:"piercing", props:["thr","ver"] },

  // ── Simple Ranged weapons (rwak) ────────────────────────────────────────────
  "light crossbow": { kind:"weapon", attack:"rwak", range:[80,320],  damage:"1d8", dtype:"piercing", props:["amm","lod","two"] },
  "dart":           { kind:"weapon", attack:"rwak", range:[20,60],   damage:"1d4", dtype:"piercing", props:["fin","thr"] },
  "shortbow":       { kind:"weapon", attack:"rwak", range:[80,320],  damage:"1d6", dtype:"piercing", props:["amm","two"] },
  "sling":          { kind:"weapon", attack:"rwak", range:[30,120],  damage:"1d4", dtype:"bludgeoning", props:["amm"] },

  // ── Martial Melee weapons (mwak) ────────────────────────────────────────────
  "battleaxe":   { kind:"weapon", attack:"mwak", reach:5,  damage:"1d8",  dtype:"slashing", props:["ver"] },
  "flail":       { kind:"weapon", attack:"mwak", reach:5,  damage:"1d8",  dtype:"bludgeoning" },
  "glaive":      { kind:"weapon", attack:"mwak", reach:10, damage:"1d10", dtype:"slashing", props:["hvy","rch","two"] },
  "greataxe":    { kind:"weapon", attack:"mwak", reach:5,  damage:"1d12", dtype:"slashing", props:["hvy","two"] },
  "greatsword":  { kind:"weapon", attack:"mwak", reach:5,  damage:"2d6",  dtype:"slashing", props:["hvy","two"] },
  "halberd":     { kind:"weapon", attack:"mwak", reach:10, damage:"1d10", dtype:"slashing", props:["hvy","rch","two"] },
  "lance":       { kind:"weapon", attack:"mwak", reach:10, damage:"1d12", dtype:"piercing", props:["rch","spc"] },
  "longsword":   { kind:"weapon", attack:"mwak", reach:5,  damage:"1d8",  dtype:"slashing", props:["ver"] },
  "maul":        { kind:"weapon", attack:"mwak", reach:5,  damage:"2d6",  dtype:"bludgeoning", props:["hvy","two"] },
  "morningstar": { kind:"weapon", attack:"mwak", reach:5,  damage:"1d8",  dtype:"piercing" },
  "pike":        { kind:"weapon", attack:"mwak", reach:10, damage:"1d10", dtype:"piercing", props:["hvy","rch","two"] },
  "rapier":      { kind:"weapon", attack:"mwak", reach:5,  damage:"1d8",  dtype:"piercing", props:["fin"] },
  "scimitar":    { kind:"weapon", attack:"mwak", reach:5,  damage:"1d6",  dtype:"slashing", props:["fin","lgt"] },
  "shortsword":  { kind:"weapon", attack:"mwak", reach:5,  damage:"1d6",  dtype:"piercing", props:["fin","lgt"] },
  "trident":     { kind:"weapon", attack:"mwak", reach:5,  thrown:[20,60], damage:"1d6", dtype:"piercing", props:["thr","ver"] },
  "war pick":    { kind:"weapon", attack:"mwak", reach:5,  damage:"1d8",  dtype:"piercing" },
  "warhammer":   { kind:"weapon", attack:"mwak", reach:5,  damage:"1d8",  dtype:"bludgeoning", props:["ver"] },
  "whip":        { kind:"weapon", attack:"mwak", reach:10, damage:"1d4",  dtype:"slashing", props:["fin","rch"] },

  // ── Martial Ranged weapons (rwak) ───────────────────────────────────────────
  "blowgun":        { kind:"weapon", attack:"rwak", range:[25,100],  damage:"1",   dtype:"piercing", props:["amm","lod"] },
  "hand crossbow":  { kind:"weapon", attack:"rwak", range:[30,120],  damage:"1d6", dtype:"piercing", props:["amm","lgt","lod"] },
  "heavy crossbow": { kind:"weapon", attack:"rwak", range:[100,400], damage:"1d10",dtype:"piercing", props:["amm","hvy","lod","two"] },
  "longbow":        { kind:"weapon", attack:"rwak", range:[150,600], damage:"1d8", dtype:"piercing", props:["amm","hvy","two"] },
  // "net" intentionally omitted — its attack-vs-save treatment varies by edition/module; too ambiguous to rule on.

  // ── Cantrips — ranged spell attacks (rsak) ──────────────────────────────────
  "fire bolt":      { kind:"spell", attack:"rsak", range:[120,120], damage:"1d10", dtype:"fire" },
  "produce flame":  { kind:"spell", attack:"rsak", range:[30,30],   damage:"1d8",  dtype:"fire" },
  "ray of frost":   { kind:"spell", attack:"rsak", range:[60,60],   damage:"1d8",  dtype:"cold" },
  "chill touch":    { kind:"spell", attack:"rsak", range:[120,120], damage:"1d8",  dtype:"necrotic", e2024:{ attack:"msak", reach:5, noReachCheck:true, damage:"1d10" } },  // 2024 reworked to a melee/touch attack
  "eldritch blast": { kind:"spell", attack:"rsak", range:[120,120], damage:"1d10", dtype:"force" },

  // ── Cantrips — melee spell attacks (msak) ───────────────────────────────────
  "shocking grasp": { kind:"spell", attack:"msak", reach:5,  damage:"1d8",  dtype:"lightning" },
  "thorn whip":     { kind:"spell", attack:"msak", reach:30, damage:"1d6",  dtype:"piercing" },  // the whip reaches 30 ft
  "primal savagery":{ kind:"spell", attack:"msak", reach:5,  damage:"1d10", dtype:"acid" },

  // ── Cantrips — saving throws (save) ─────────────────────────────────────────
  "sacred flame":   { kind:"spell", attack:"save", save:"dex", range:[60,60], damage:"1d8",  dtype:"radiant" },
  "toll the dead":  { kind:"spell", attack:"save", save:"wis", range:[60,60], damage:"1d8",  dtype:"necrotic" },
  "vicious mockery":{ kind:"spell", attack:"save", save:"wis", range:[60,60], damage:"1d4",  dtype:"psychic" },
  "frostbite":      { kind:"spell", attack:"save", save:"con", range:[60,60], damage:"1d6",  dtype:"cold" },
  "mind sliver":    { kind:"spell", attack:"save", save:"int", range:[60,60], damage:"1d6",  dtype:"psychic" },
  "acid splash":    { kind:"spell", attack:"save", save:"dex", range:[60,60], damage:"1d6",  dtype:"acid" },
  "poison spray":   { kind:"spell", attack:"save", save:"con", range:[10,10], damage:"1d12", dtype:"poison", e2024:{ range:[30,30] } },
  "sword burst":    { kind:"spell", attack:"save", save:"dex", range:[5,5],   damage:"1d6",  dtype:"force" },
  "create bonfire": { kind:"spell", attack:"save", save:"dex", range:[60,60], damage:"1d8",  dtype:"fire" },
  "infestation":    { kind:"spell", attack:"save", save:"con", range:[30,30], damage:"1d6",  dtype:"poison" },

  // ── Conjuration / placement spells — melee attack, big SPELL range (skip reach)
  "spiritual weapon": { kind:"spell", attack:"msak", range:[60,60],   damage:"1d8", dtype:"force", noReachCheck:true },
  "arcane hand":      { kind:"spell", attack:"msak", range:[120,120], damage:"4d8", dtype:"force", noReachCheck:true },
  "bigby's hand":     { kind:"spell", attack:"msak", range:[120,120], damage:"4d8", dtype:"force", noReachCheck:true },
  "steel wind strike":{ kind:"spell", attack:"msak", range:[30,30],   damage:"6d10", dtype:"force", noReachCheck:true },
};

const ATK_LABEL = {
  mwak: "melee weapon attack",
  rwak: "ranged weapon attack",
  msak: "melee spell attack",
  rsak: "ranged spell attack",
  save: "saving throw",
  util: "no attack",
};
const ATTACK_TYPES = new Set(["mwak", "rwak", "msak", "rsak"]);
const MELEE_TYPES  = new Set(["mwak", "msak"]);
const GEAR_TYPES   = new Set(["weapon", "equipment", "consumable", "tool"]);

// Natural melee reach by creature size (ft). A reach weapon adds +5 on top.
export const SIZE_REACH = { grg: 20, huge: 15, lg: 10, med: 5, sm: 5, tiny: 5 };

function _norm(name) {
  return String(name ?? "")
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ")     // strip parentheticals: "Spear (Humanoid Form)" → "spear"
    .replace(/^\s*\+\d+\s+/, "")     // strip leading "+N "
    .replace(/[‘’`]/g, "'")// normalize curly apostrophes
    .replace(/\s+/g, " ")
    .trim();
}

function _kindOk(entryKind, itemType) {
  if (entryKind === "spell")  return itemType === "spell";
  if (entryKind === "weapon") return GEAR_TYPES.has(itemType);
  return true;
}

/** Look up the canonical RAW entry for an item by name + type. Returns entry or null. */
export function lookupRaw(name, itemType) {
  const n = _norm(name);
  let e = RAW[n];
  if (e && _kindOk(e.kind, itemType)) return e;
  // Magic weapons: "Longsword of Sharpness" → "longsword"
  if (GEAR_TYPES.has(itemType)) {
    const base = n.replace(/\s+of\s+.*$/, "").trim();
    if (base && base !== n) {
      e = RAW[base];
      if (e && e.kind === "weapon") return e;
    }
  }
  return null;
}

/** Apply 2024 overrides if the world runs modern rules. */
function _editionView(raw, edition) {
  return (edition === "2024" && raw.e2024) ? { ...raw, ...raw.e2024 } : raw;
}

export function attackLabel(at) { return ATK_LABEL[at] ?? at ?? "?"; }

// dnd5e 5.x save-activity ability can be a Set, an array, or a string. Normalize.
function _saveAbilities(saveActivity) {
  const a = saveActivity?.save?.ability;
  if (a instanceof Set) return [...a];
  if (Array.isArray(a)) return [...a];
  if (typeof a === "string" && a) return [a];
  return [];
}

// Best-effort: does the actor carry a feature that grants extra melee reach?
// (A literal "Reach" monster trait, "Long-Limbed", homebrew reach feats.) Heuristic —
// widens tolerance so a legitimately long-reaching creature isn't false-flagged.
function _actorHasReachFeature(actor) {
  try {
    const rx = /\breach\b|long.?limbed/i;
    for (const it of actor?.items ?? []) {
      if (it.type === "feat" && rx.test(it.name || "")) return true;
    }
  } catch (_) { /* ignore */ }
  return false;
}

/**
 * Compare one item to its canonical RAW entry. Returns a verdict
 * { field, itemVal, rawVal, issue } on a mismatch, or null when it matches RAW.
 * Pure code — no AI, no network.
 */
export function compareToRaw(item, raw, edition = "2014", actor = null) {
  const eff = _editionView(raw, edition);
  const acts = item.system?.activities?.contents ?? [];
  const attackActs = acts.filter(a => a.type === "attack");
  const sav = acts.find(a => a.type === "save");
  const itemProps = item.system?.properties ? new Set(item.system.properties) : new Set();
  const isThrown = !!eff.thrown || eff.props?.includes("thr") || itemProps.has("thr");

  const V = (field, itemVal, rawVal, issue) => ({ field, itemVal, rawVal, issue });

  // RAW expects an ATTACK ──────────────────────────────────────────────────────
  if (ATTACK_TYPES.has(eff.attack)) {
    // Pick the activity whose type matches RAW (a dagger has melee + thrown modes —
    // compare the melee one to a melee RAW type), else the first attack activity.
    const atk = attackActs.find(a => a.actionType === eff.attack) ?? attackActs[0];
    if (!atk) {
      if (sav) return V("attack vs save", `saving throw (${_saveAbilities(sav).join("/").toUpperCase() || "?"})`, attackLabel(eff.attack),
        `RAW: this is an attack (${attackLabel(eff.attack)}). The item is built as a saving throw.`);
      return null;   // no attack activity to compare against
    }
    const at = atk.actionType ?? "";

    // Attack-type check. An empty type on a known weapon is itself wrong.
    if (!at) {
      return V("attack type", "no type set", attackLabel(eff.attack),
        `RAW: ${attackLabel(eff.attack)}. This item has no melee/ranged type set.`);
    }
    if (at !== eff.attack) {
      // Thrown weapons legitimately carry BOTH a melee and a ranged (thrown) mode —
      // don't flag a melee↔ranged swap for them.
      const meleeRangedSwap = (eff.attack === "mwak" && at === "rwak") || (eff.attack === "rwak" && at === "mwak");
      if (!(isThrown && meleeRangedSwap)) {
        return V("attack type", attackLabel(at), attackLabel(eff.attack),
          `RAW: ${attackLabel(eff.attack)}. This item: ${attackLabel(at)}.`);
      }
    }

    // Reach sanity — melee only, ft units only, never for thrown weapons, and scaled
    // by the wielder's SIZE + reach property + any reach-granting feature. So a
    // longsword on a Large creature correctly reaches 10ft; a reach-feat creature is
    // accounted for; a dagger's 60ft throw range is never treated as melee reach.
    if (MELEE_TYPES.has(eff.attack) && !eff.noReachCheck && !isThrown) {
      const units = atk.range?.units ?? "";
      if (units === "ft") {   // touch / self / special ranges are not a reach error
        const r = Number(atk.range?.value) || 0;
        const size = actor?.system?.traits?.size ?? "med";
        const hasReach = eff.props?.includes("rch") || itemProps.has("rch");
        const featReach = _actorHasReachFeature(actor) ? 5 : 0;
        const expected = (SIZE_REACH[size] ?? 5) + (hasReach ? 5 : 0) + featReach;
        if (r > expected) {
          const bits = [];
          if (size !== "med") bits.push(size);
          if (hasReach) bits.push("reach weapon");
          if (featReach) bits.push("reach feature");
          const ctx = bits.length ? ` (${bits.join(", ")})` : "";
          return V("reach", `${r} ft`, `${expected} ft`,
            `RAW reach${ctx} is ${expected} ft. This item: ${r} ft — too far.`);
        }
      }
    }
    return null;   // matches RAW
  }

  // RAW expects a SAVE ─────────────────────────────────────────────────────────
  if (eff.attack === "save") {
    if (attackActs.length) return V("save vs attack", attackLabel(attackActs[0].actionType ?? ""), `saving throw (${(eff.save ?? "?").toUpperCase()})`,
      `RAW: this is a ${(eff.save ?? "?").toUpperCase()} save. The item is built as an attack.`);
    // Verify the SAVE ABILITY matches RAW (Frostbite is CON, not DEX/WIS).
    if (sav && eff.save) {
      const abil = _saveAbilities(sav);
      if (abil.length && !abil.includes(eff.save)) {
        return V("save ability", abil.join("/").toUpperCase() + " save", eff.save.toUpperCase() + " save",
          `RAW: ${eff.save.toUpperCase()} save. This item: ${abil.join("/").toUpperCase()} save.`);
      }
    }
    return null;
  }

  return null;   // util / unknown → nothing to assert
}

/** Resolve the world's rules edition for the audit. */
export function worldEdition() {
  try {
    const v = game.settings.get("dnd5e", "rulesVersion");
    return (v === "modern" || v === "2024") ? "2024" : "2014";
  } catch (_) {
    return "2014";
  }
}

/** How many canonical entries are loaded (for diagnostics / the window footer). */
export function rawEntryCount() { return Object.keys(RAW).length; }
