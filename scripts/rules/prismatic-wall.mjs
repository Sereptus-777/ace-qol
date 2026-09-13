// ─── ACE: QOL — Prismatic Wall, read from the item ──────────────────────────
//
// Johnny, 2026-09-13: ACE rolls the wall's saves by itself. When a creature
// that can see the wall comes within 20 feet of it or starts its turn there, a
// Constitution save against a minute of blindness. When one goes through it,
// all seven layers in order, one Dexterity save each.
//
// ⚠️ THE ITEM SAYS HOW HARD, THE BOOK SAYS IN WHAT ORDER. The dice come from
// the spell's own traversal save (12d6 on his 2024 copies, 10d6 in the 2014
// book), the DC from that save, the 20 feet and the minute of blindness from
// its own words. The seven colours, and the damage each deals, are the spell's
// printed table and are the same in both books (checked 2026-09-13): red fire,
// orange acid, yellow lightning, green poison, blue cold, then indigo's
// restraint and violet's blindness. Varek's copy prints the table in its text
// and it is read from there; the Lich's and Zanna's embed it from a compendium
// table, so for them the printed order stands.
//
// ⚠️ BOTH EDITIONS, AND THEY DIFFER. 2014 ships ONE save activity (Dexterity,
// 10d6, no damage types at all) and nothing for the blinding light; 2024 ships
// four activities. The reader takes what each has and says what it could not
// find, rather than inventing it.
//
// ⚠️ INDIGO'S "THE SPELL ENDS" (2014). Read literally, one creature shaking off
// the restraint three times would take down a ninth-level wall. ACE ends the
// RESTRAINT, which is what 2024 says in so many words: "the condition ends".
//
// ⚠️ IMPORTS NOTHING.
// ──────────────────────────────────────────────────────────────────────────────

export const PRISMATIC_LAYERS = Object.freeze([
  Object.freeze({ n: 1, key: "red",    label: "Red",    kind: "damage", type: "fire" }),
  Object.freeze({ n: 2, key: "orange", label: "Orange", kind: "damage", type: "acid" }),
  Object.freeze({ n: 3, key: "yellow", label: "Yellow", kind: "damage", type: "lightning" }),
  Object.freeze({ n: 4, key: "green",  label: "Green",  kind: "damage", type: "poison" }),
  Object.freeze({ n: 5, key: "blue",   label: "Blue",   kind: "damage", type: "cold" }),
  Object.freeze({ n: 6, key: "indigo", label: "Indigo", kind: "restrained",
                  saveAbility: "con", need: 3, escalatesTo: "petrified" }),
  Object.freeze({ n: 7, key: "violet", label: "Violet", kind: "blinded",
                  saveAbility: "wis", when: "startOfCasterTurn" }),
]);

const DAMAGE_TYPES = new Set(["acid", "bludgeoning", "cold", "fire", "force", "lightning",
  "necrotic", "piercing", "poison", "psychic", "radiant", "slashing", "thunder"]);

/** Is this item Prismatic Wall, in either edition, whatever suffix his copy carries? */
export function isPrismaticWall(item) {
  if (!item) return false;
  const id = String(item?.system?.identifier ?? "").trim().toLowerCase();
  if (id === "prismatic-wall") return true;
  return /^prismatic wall\b/i.test(String(item?.name ?? "").trim());
}

function activitiesOf(item) {
  const a = item?.system?.activities;
  if (!a) return [];
  if (Array.isArray(a)) return a;
  if (Array.isArray(a.contents)) return a.contents;
  if (typeof a.values === "function") return [...a.values()];
  return Object.values(a);
}

// ⚠️ A SET LIVE, AN ARRAY IN JSON (2026-09-07). Both are read the same.
function abilitiesOf(act) {
  const a = act?.save?.ability;
  const list = a instanceof Set ? [...a] : (Array.isArray(a) ? a : (a ? [a] : []));
  return list.map(s => String(s).toLowerCase());
}

function partFormula(p) {
  if (!p) return null;
  if (p.custom?.enabled && String(p.custom?.formula ?? "").trim()) return String(p.custom.formula).trim();
  const n = Number(p.number), d = Number(p.denomination);
  if (!(n > 0 && d > 0)) return null;
  const bonus = String(p.bonus ?? "").trim();
  return `${n}d${d}${bonus ? ` + ${bonus}` : ""}`;
}

function plainText(html) {
  return String(html ?? "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&").replace(/&nbsp;/g, " ").replace(/&rsquo;|&#8217;/g, "'")
    .replace(/\s+/g, " ");
}

function secondsOf(duration) {
  const v = Number(duration?.value);
  if (!(v > 0)) return null;
  const per = { round: 6, turn: 6, minute: 60, hour: 3600, day: 86400 }[String(duration?.units ?? "").toLowerCase()];
  return per ? v * per : null;
}

/**
 * Everything ACE needs to run the wall, read from the item.
 *
 * @returns {{ok:boolean, dc:number|null, bandFt:number, blindSeconds:number,
 *   durationSeconds:number|null, edition:string|null,
 *   traversalActivityId:string|null, blindingActivityId:string|null,
 *   layers:Array<object>, problems:string[]}}
 */
export function readPrismaticWall(item) {
  const problems = [];
  const saves = activitiesOf(item).filter(a => a?.type === "save");
  const traversal = saves.find(a => abilitiesOf(a).includes("dex") && (a.damage?.parts?.length ?? 0) > 0)
    ?? saves.find(a => abilitiesOf(a).includes("dex")) ?? null;
  const blinding = saves.find(a => abilitiesOf(a).includes("con")) ?? null;
  const text = plainText(item?.system?.description?.value);

  const dcOf = (a) => { const v = Number(a?.save?.dc?.value); return Number.isFinite(v) && v > 0 ? v : null; };
  let dc = dcOf(traversal) ?? dcOf(blinding);
  if (!dc) {
    const v = Number(item?.actor?.system?.attributes?.spell?.dc);
    if (Number.isFinite(v) && v > 0) dc = v;
  }
  if (!dc) problems.push("no save DC on the spell's saves or its caster");

  const part = traversal?.damage?.parts?.[0] ?? null;
  const partDice = partFormula(part);
  const partTypes = new Set([...(part?.types ?? [])].map(t => String(t).toLowerCase()));

  const layers = PRISMATIC_LAYERS.map(L => {
    if (L.kind !== "damage") return { ...L };
    const m = text.match(new RegExp(
      `\\b${L.label}\\.\\s*(?:Failed Save:\\s*)?(?:The creature takes\\s*)?(\\d+d\\d+)\\s+([a-z]+)\\s+damage`, "i"));
    const textDice = m ? m[1].toLowerCase() : null;
    const textType = m && DAMAGE_TYPES.has(m[2].toLowerCase()) ? m[2].toLowerCase() : null;
    const type = textType ?? L.type;
    const formula = partDice ?? textDice;
    if (!formula) problems.push(`no dice for the ${L.key} layer`);
    if (partDice && textDice && partDice.replace(/\s+/g, "") !== textDice) {
      problems.push(`the ${L.key} layer's text says ${textDice} and its save rolls ${partDice}; ACE rolls the save's`);
    }
    if (partTypes.size && !partTypes.has(type)) {
      problems.push(`the ${L.key} layer deals ${type}, which the spell's save does not list`);
    }
    return { ...L, type, formula, typeFrom: textType ? "its text" : "the printed table",
             diceFrom: partDice ? "its save" : (textDice ? "its text" : null) };
  });

  const band = text.match(/within\s+(\d+)\s+(?:feet|ft\.?)\s+of\s+it\b/i);
  const bandFt = band ? Number(band[1]) : 20;
  if (!band) problems.push("its text does not say how near is too near; 20 feet, as printed");

  const blind = text.match(/blinded[^.]*?\bfor\s+(\d+)\s+minutes?/i);
  const blindSeconds = blind ? Number(blind[1]) * 60 : 60;
  if (!blind) problems.push("its text does not say how long the blindness lasts; 1 minute, as printed");

  return {
    ok: !!dc && layers.every(l => l.kind !== "damage" || !!l.formula),
    dc, bandFt, blindSeconds,
    durationSeconds: secondsOf(item?.system?.duration),
    edition: String(item?.system?.source?.rules ?? "").trim() || null,
    traversalActivityId: traversal?.id ?? traversal?._id ?? null,
    blindingActivityId: blinding?.id ?? blinding?._id ?? null,
    layers, problems,
  };
}
