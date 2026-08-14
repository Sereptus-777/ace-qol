// ─── ACE QOL — Food, water, and going without ─────────────────────────────────
//
// Feeding the party between adventures, and the consequences of failing to.
//
// ═══ THE ONE RULE THAT IS NOT A SETTING ═══════════════════════════════════════
//
// ⚠️ ONLY BEASTS CAN BE HARVESTED FOR MEAT. Humanoids never can — no toggle, no
// default-off setting, no GM override, no "advanced" checkbox. The exclusion
// lives HERE, in code, where nobody can flip it.
//
// Johnny, 2026-08-09, deciding this: "I don't want the option to ever harvest a
// humanoid… I don't want to encourage any kind of sick camp of cannibalism.
// There are some pretty sick people out there."
//
// He is right, and the reasoning is worth keeping next to the code: a setting is
// an invitation, and "we shipped it disabled" is not a defence for shipping it.
// No prompt appears over a dead bandit — not a greyed-out one, not a GM-only
// one. Nothing.
//
// 5e types bullywugs, goblins, orcs and bandits all as `humanoid`, so all of
// them are excluded by the same line. That is deliberate. The moment this code
// starts ranking which thinking creatures are acceptable to eat, it is making a
// judgement it has no business making. Beast or nothing.
//
// ⚠️ If you are here to add `allowHumanoidRations`, the answer is no. Read above.
// ══════════════════════════════════════════════════════════════════════════════
//
// LEAF MODULE — imports nothing, so every rule below is testable outside Foundry.
// ──────────────────────────────────────────────────────────────────────────────

/** The only creature type a corpse may be harvested from. */
export const HARVESTABLE_TYPES = new Set(["beast"]);

/**
 * Types that can NEVER be harvested, whatever else changes.
 * Kept as its own set so the refusal is explicit rather than a side effect of
 * `HARVESTABLE_TYPES` happening not to list them.
 */
export const NEVER_HARVESTABLE = new Set([
  "humanoid",   // goblins, orcs, bandits, bullywugs, kobolds — all of them
]);

/**
 * Meat yielded by a carcass, in person-days, by creature size.
 * A doubling ladder: one Medium beast (a deer) feeds a party of four for a day.
 */
export const YIELD_BY_SIZE = {
  tiny: 0.5,      // a rabbit is a light meal for one, not nothing
  sm:   1,
  med:  4,        // a deer feeds a party of four for a day
  lg:   8,
  huge: 16,
  grg:  32,
};

/**
 * How long butchering takes, in minutes, by size.
 *
 * Johnny, 2026-08-09: "How long does it take to harvest a deer compared to
 * harvesting a rabbit? Harvesting a rabbit just probably means throwing it in
 * your backpack for later."
 *
 * Exactly right, and that is why this is not one flat number. Small game costs
 * almost nothing — you gut it and bag it. Field-dressing a deer is genuinely
 * about half an hour's work. A mammoth is most of a morning.
 */
export const HARVEST_MINUTES_BY_SIZE = {
  tiny: 5,        // gut it, bag it, walk on
  sm:   15,
  med:  30,       // field-dressing a deer
  lg:   60,
  huge: 180,
  grg:  360,
};

/**
 * ⚠️ MEAT IS HEAVY, AND THE PARTY HAS A BACK.
 * A Gargantuan carcass is 32 person-days of food and several tonnes of animal.
 * Yield must be capped by what they can actually carry away, or hunting one
 * mammoth ends food scarcity for the rest of the campaign. Roughly 10 lb per
 * person-day of meat.
 */
export const POUNDS_PER_SERVING = 10;

/**
 * RAW sustenance for one person for one day:
 *   Food  — one ration.
 *   Water — one gallon, or two in hot weather.
 * A waterskin holds four pints, which is half a gallon — so a full skin is
 * HALF a day's water. That is not a mistake; it is why parties must find water
 * rather than carry it.
 */
export const WATER_GALLONS_PER_DAY = 1;
export const WATER_GALLONS_PER_HOT_DAY = 2;

/**
 * Items recognised as food or water with no tagging required, so the system
 * works out of the box on a standard dnd5e sheet.
 * `servings` is in person-days.
 */
export const DEFAULT_SUSTENANCE = [
  { match: /\brations?\b/i,                    kind: "food",  servings: 1 },
  { match: /\bwaterskin\b/i,                   kind: "water", servings: 0.5 },
  { match: /\bgoodberr(y|ies)\b/i,             kind: "food",  servings: 0.1 },
  { match: /\b(ale|wine|beer|mead)\b/i,        kind: "water", servings: 0.25 },
  { match: /\bfresh meat\b|\bmeat,? fresh\b/i, kind: "food",  servings: 1 },
  { match: /\bsalted\b.*\bmeat\b|\bjerky\b/i,  kind: "food",  servings: 1 },
];

/* ─── Harvesting ─────────────────────────────────────────────────────────── */

/** Read a creature's type, which dnd5e stores either flat or nested. */
export function creatureType(actor) {
  const raw = actor?.system?.details?.type;
  return String(typeof raw === "string" ? raw : (raw?.value ?? "")).toLowerCase().trim();
}

/**
 * May this carcass be harvested for meat?
 * @returns {{ok: boolean, reason: string, silent: boolean}}
 *   `silent` means: show the user NOTHING. Not a refusal, not a disabled button.
 *   The question should never have been visible in the first place.
 */
export function canHarvest(actor) {
  const type = creatureType(actor);

  // ⚠️ The hard line. Silent by design — see the header.
  if (NEVER_HARVESTABLE.has(type)) {
    return { ok: false, reason: "", silent: true };
  }

  if (!HARVESTABLE_TYPES.has(type)) {
    // Not offensive, just not food — a construct, an ooze, an undead. Say so
    // plainly if asked, but never volunteer a prompt.
    return { ok: false, reason: `a ${type || "creature"} yields nothing worth eating`, silent: true };
  }

  return { ok: true, reason: "", silent: false };
}

/** Person-days of meat on a carcass, before any skill check. */
export function harvestYield(actor) {
  if (!canHarvest(actor).ok) return 0;
  const size = String(actor?.system?.traits?.size ?? "med").toLowerCase();
  return YIELD_BY_SIZE[size] ?? 0;
}

/** How long butchering this carcass takes, in minutes. */
export function harvestMinutes(actor) {
  if (!canHarvest(actor).ok) return 0;
  const size = String(actor?.system?.traits?.size ?? "med").toLowerCase();
  return HARVEST_MINUTES_BY_SIZE[size] ?? 30;
}

/**
 * What the party can actually walk away with.
 * @param {object} actor
 * @param {number} carryPounds  spare capacity across the party, in pounds
 * @returns {{servings, minutes, left, capped}}
 */
export function harvestHaul(actor, carryPounds = Infinity) {
  const full = harvestYield(actor);
  if (full <= 0) return { servings: 0, minutes: 0, left: 0, capped: false };

  const canCarry = Math.floor(Number(carryPounds) / POUNDS_PER_SERVING);
  const servings = Math.max(0, Math.min(full, Number.isFinite(canCarry) ? canCarry : full));

  // Butchering only what you can carry takes proportionally less time — you
  // stop once the packs are full.
  const fullMinutes = harvestMinutes(actor);
  const minutes = full > 0 ? Math.max(5, Math.round(fullMinutes * (servings / full))) : 0;

  return {
    servings,
    minutes: servings > 0 ? minutes : 0,
    left: Math.round((full - servings) * 100) / 100,
    capped: servings < full,
  };
}

/* ─── Reading the larder ─────────────────────────────────────────────────── */

/**
 * What, if anything, does this item contribute?
 * An explicit `ace-qol.sustenance` flag always wins over name matching, so a GM
 * can tag anything — a haunch of venison, a wheel of cheese — and be obeyed.
 */
export function sustenanceOf(item, moduleId = "ace-qol") {
  if (!item) return null;

  const flagged = item.flags?.[moduleId]?.sustenance;
  if (flagged && (flagged.kind || flagged.type)) {
    const servings = Number(flagged.servings);
    return {
      kind: String(flagged.kind ?? flagged.type).toLowerCase(),
      servings: Number.isFinite(servings) ? servings : 1,
    };
  }

  const name = String(item.name ?? "");
  if (!name) return null;
  for (const rule of DEFAULT_SUSTENANCE) {
    if (rule.match.test(name)) return { kind: rule.kind, servings: rule.servings };
  }
  return null;
}

/**
 * Add up everything the whole party is carrying, as ONE shared pile.
 *
 * ⚠️ POOLED ON PURPOSE. Checking each character's own pack would starve the PC
 * standing next to the party's pack mule — the food is right there, and every
 * table hands it over without narrating it. The pool's failure mode (a genuinely
 * separated PC counted as fed) is rarer and visible; per-character's failure
 * mode is the system lying to the GM, which is how a feature gets switched off.
 */
export function partyPool(actors, moduleId = "ace-qol") {
  const pool = { food: 0, water: 0, sources: [] };
  for (const actor of actors ?? []) {
    for (const item of actor?.items?.contents ?? actor?.items ?? []) {
      const s = sustenanceOf(item, moduleId);
      if (!s) continue;
      const qty = Number(item.system?.quantity ?? 1) || 0;
      if (qty <= 0) continue;
      const total = s.servings * qty;
      if (s.kind === "food")  pool.food  += total;
      if (s.kind === "water") pool.water += total;
      if (s.kind === "both") { pool.food += total; pool.water += total; }
      pool.sources.push({ actor: actor.name, item: item.name, kind: s.kind, servings: total });
    }
  }
  pool.food  = Math.round(pool.food  * 100) / 100;
  pool.water = Math.round(pool.water * 100) / 100;
  return pool;
}

/* ─── Going without ──────────────────────────────────────────────────────── */

/**
 * RAW: "a character can go without food for a number of days equal to
 * 3 + his or her Constitution modifier (minimum 1)". Only AFTER that does
 * exhaustion begin, and then it is automatic — no save.
 */
export function daysWithoutFood(conMod) {
  return Math.max(1, 3 + (Number(conMod) || 0));
}

/**
 * Resolve a day's eating for the party against the shared pool.
 *
 * @param {object} pool        from `partyPool`
 * @param {Array}  eaters      [{name, conMod, daysHungry, daysThirsty}]
 * @param {object} [opts]
 * @param {boolean} [opts.hot] hot weather doubles water need
 */
export function feedParty(pool, eaters, { hot = false } = {}) {
  const need = eaters?.length ?? 0;
  const waterNeed = need * (hot ? WATER_GALLONS_PER_HOT_DAY : WATER_GALLONS_PER_DAY);

  const foodEaten  = Math.min(pool.food,  need);
  const waterDrunk = Math.min(pool.water, waterNeed);

  // Whole rations only — half a ration does not feed half a person for a day.
  const fedCount     = Math.floor(foodEaten);
  const wateredCount = hot ? Math.floor(waterDrunk / 2) : Math.floor(waterDrunk);

  const results = (eaters ?? []).map((e, i) => {
    const ate   = i < fedCount;
    const drank = i < wateredCount;
    const daysHungry  = ate   ? 0 : (Number(e.daysHungry)  || 0) + 1;
    const daysThirsty = drank ? 0 : (Number(e.daysThirsty) || 0) + 1;
    const limit = daysWithoutFood(e.conMod);

    // Food: exhaustion only once past the limit. Water: RAW is far harsher —
    // one day without gives a level, and a second gives two.
    let exhaustion = 0;
    const reasons = [];
    if (!ate && daysHungry > limit) {
      exhaustion += 1;
      reasons.push(`${daysHungry} days without food (limit ${limit})`);
    }
    if (!drank) {
      exhaustion += (daysThirsty >= 2) ? 2 : 1;
      reasons.push(`${daysThirsty} day${daysThirsty === 1 ? "" : "s"} without water`);
    }

    return { name: e.name, ate, drank, daysHungry, daysThirsty, exhaustion, reasons };
  });

  return {
    fed: fedCount, watered: wateredCount, need,
    foodEaten, waterDrunk,
    shortFood:  Math.max(0, need - fedCount),
    shortWater: Math.max(0, need - wateredCount),
    remaining: {
      food:  Math.round((pool.food  - foodEaten)  * 100) / 100,
      water: Math.round((pool.water - waterDrunk) * 100) / 100,
    },
    results,
  };
}
