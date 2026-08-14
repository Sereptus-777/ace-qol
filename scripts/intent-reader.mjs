// ─── ACE QOL — The Intent Reader ──────────────────────────────────────────────
//
// ONE reader. Every button. Nothing downstream ever guesses again.
//
// ═══ WHY THIS EXISTS ═════════════════════════════════════════════════════════
//
// Johnny, 2026-08-14, after a poison breath weapon played a fire animation:
//
//   "Why isn't our pipeline reading this shit like it's supposed to? Then we
//    don't have to go back to every fucking spell and do every spell."
//
// He was right, and the diagnosis is worse than the symptom. ACE's FX layer
// matched a library of 2,339 hand-curated NAME PATTERNS imported from Automated
// Animations — a name-matching engine by design. Every gap in that library is
// manual work forever, which is not a product, it is a treadmill.
//
// Meanwhile the answer was sitting on the item the whole time. dnd5e already
// stores the damage type, the template shape and size, the save ability and DC,
// the range, the activation cost and the creature's own species as STRUCTURED
// FIELDS. "Green dragonborn means poison" never needed to be inferred: the
// activity says poison, and it says cone.
//
// ═══ WHAT THIS PRODUCES ══════════════════════════════════════════════════════
//
// One `Intent` per button press, describing what is about to happen. Templates,
// targeting, animation, sound, damage and the save card all read the SAME
// object, so they can no longer disagree with each other.
//
// ═══ THREE TIERS, IN ORDER OF TRUST ══════════════════════════════════════════
//
//   A. STRUCTURED   activity + item + actor fields. Exact. Always trusted.
//   B. IDENTITY     DDB race options, species flags, class/subclass origin.
//                   Confirms A and names the family (a Dragonborn breath).
//   C. PROSE        the description. NEVER the sole authority — but it does two
//                   jobs nothing else can:
//                     • fills gaps when a bad import left A empty
//                     • DISAGREES OUT LOUD, so a template that says line while
//                       the text says cone gets reported instead of silently
//                       animating the wrong shape.
//
// ⚠️ PROSE IS CORROBORATION, NOT TRUTH. I argued against reading it at all;
// Johnny overruled me and he is right that a second signal is worth having.
// But it is localised, homebrewers rewrite it, and DDB mangles it — so it may
// RAISE confidence, FILL a hole, or RAISE A FLAG. It may never overrule a
// structured field that is present.
// ──────────────────────────────────────────────────────────────────────────────

const MODULE_ID = "ace-qol";
const LOG = "ace-qol | Intent";

/** Damage types that carry a visual identity, mapped to their JB2A family. */
export const ELEMENT_COLOUR = {
  acid:      { effect: "Acid",      colour: "Green"  },
  cold:      { effect: "Cold",      colour: "Blue"   },
  fire:      { effect: "Fire",      colour: "Orange" },
  lightning: { effect: "Lightning", colour: "Blue"   },
  poison:    { effect: "Poison",    colour: "Green"  },
  necrotic:  { effect: "Necrotic",  colour: "Purple" },
  radiant:   { effect: "Holy",      colour: "Yellow" },
  psychic:   { effect: "Arcana",    colour: "Purple" },
  thunder:   { effect: "Thunder",   colour: "Blue"   },
  force:     { effect: "Arcana",    colour: "Blue"   },
};

/** Physical types never drive an elemental flourish — they are the weapon. */
const PHYSICAL = new Set(["bludgeoning", "piercing", "slashing"]);

/** Template shapes dnd5e can store, normalised to what JB2A actually ships. */
const SHAPE_ALIASES = {
  cone: "cone", ray: "line", line: "line", rect: "line",
  circle: "circle", sphere: "circle", radius: "circle", cylinder: "circle",
  square: "square", wall: "line",
};

export class Intent {

  /**
   * Read a button press completely.
   *
   * @param {Item5e} item
   * @param {object} [activity]  the specific activity used; defaults to the first
   * @param {Actor5e} [actor]    defaults to the item's own parent
   * @returns {object} the Intent
   */
  static read(item, activity = null, actor = null) {
    const src = [];                       // every field that contributed
    const flags = [];                     // disagreements worth telling the GM
    const a = actor ?? item?.parent ?? null;
    const act = activity ?? Intent._firstActivity(item);

    const damage   = Intent._damage(act, src);
    const element  = Intent._element(damage, src);
    const shape    = Intent._shape(act, src);
    const save     = Intent._save(act, src);
    const attack   = Intent._attack(act, src);
    const identity = Intent._identity(item, a, src);
    const prose    = Intent._prose(item, src);

    // ── Tier C reconciliation ───────────────────────────────────────────
    // Prose may FILL a hole or RAISE A FLAG. It may never overrule Tier A.
    let finalElement = element;
    if (!finalElement && prose.element) {
      finalElement = prose.element;
      src.push("description:element");
      flags.push(`No damage type on the activity — took "${prose.element}" from the description.`);
    } else if (finalElement && prose.element && prose.element !== finalElement) {
      flags.push(`Damage type says ${finalElement} but the description says ${prose.element}. Using ${finalElement}.`);
    }

    let finalShape = shape;
    if (!finalShape.type && prose.shape) {
      finalShape = { type: prose.shape, size: prose.size ?? null, units: "ft", fromProse: true };
      src.push("description:shape");
      flags.push(`No template on the activity — took a ${prose.shape}${prose.size ? ` of ${prose.size} ft` : ""} from the description.`);
    } else if (finalShape.type && prose.shape && prose.shape !== finalShape.type) {
      flags.push(`Template is a ${finalShape.type} but the description says ${prose.shape}.`);
    }

    const palette = finalElement ? ELEMENT_COLOUR[finalElement] ?? null : null;

    return {
      itemName: item?.name ?? "(unknown)",
      itemType: item?.type ?? null,
      actorName: a?.name ?? null,
      kind: Intent._kind(act, save, attack, damage),

      damage,
      element: finalElement,              // the type that should drive flavour
      effect: palette?.effect ?? null,    // JB2A family, e.g. "Poison"
      colour: palette?.colour ?? null,    // JB2A colour, e.g. "Green"

      shape: finalShape,
      save,
      attack,
      range: Intent._range(act, src),
      identity,

      // Confidence is the count of INDEPENDENT signals that agreed.
      confidence: Intent._confidence(src, flags),
      sources: src,
      flags,
    };
  }

  /* ── Tier A — structured ─────────────────────────────────────────────── */

  static _firstActivity(item) {
    try {
      const acts = item?.system?.activities;
      if (!acts) return null;
      if (typeof acts.contents !== "undefined") return acts.contents[0] ?? null;
      let first = null;
      acts.forEach?.(x => { first ??= x; });
      return first;
    } catch (_) { return null; }
  }

  static _damage(act, src) {
    const out = [];
    try {
      for (const part of (act?.damage?.parts ?? [])) {
        const types = [];
        const t = part?.types;
        if (t && typeof t.forEach === "function") t.forEach(x => types.push(String(x).toLowerCase()));
        out.push({
          number: part?.number ?? null,
          denomination: part?.denomination ?? null,
          bonus: part?.bonus ?? "",
          types,
          formula: part?.formula ?? null,
        });
      }
      if (out.length) src.push("activity.damage.parts");
    } catch (err) {
      console.warn(`${LOG} | could not read damage:`, err);
    }
    return out;
  }

  /**
   * The ONE damage type that should drive colour and animation.
   * ⚠️ Physical types are skipped: a Burning Hammer is bludgeoning AND fire,
   * and the fire is what anyone watching actually sees.
   */
  static _element(damage, src) {
    const all = damage.flatMap(d => d.types);
    const elemental = all.find(t => !PHYSICAL.has(t) && ELEMENT_COLOUR[t]);
    if (elemental) { src.push("damage.type:elemental"); return elemental; }
    const anyPhysical = all.find(t => PHYSICAL.has(t));
    if (anyPhysical) { src.push("damage.type:physical"); return anyPhysical; }
    return null;
  }

  static _shape(act, src) {
    try {
      const t = act?.target?.template;
      if (!t?.type) return { type: null, size: null, units: null };
      const type = SHAPE_ALIASES[String(t.type).toLowerCase()] ?? String(t.type).toLowerCase();
      src.push("activity.target.template");
      return {
        type,
        raw: t.type,
        size: Number(t.size) || null,
        width: Number(t.width) || null,
        height: Number(t.height) || null,
        units: t.units ?? "ft",
      };
    } catch (_) { return { type: null, size: null, units: null }; }
  }

  static _save(act, src) {
    try {
      if (act?.type !== "save" && !act?.save) return null;
      const ab = act?.save?.ability;
      const abilities = [];
      if (ab && typeof ab.forEach === "function") ab.forEach(x => abilities.push(String(x)));
      else if (ab) abilities.push(String(ab));
      const dc = act?.save?.dc ?? {};
      src.push("activity.save");
      return {
        abilities,
        dcValue: dc.value ?? null,
        dcCalculation: dc.calculation ?? null,
        onSave: act?.damage?.onSave ?? null,   // "half" | "none" | "full"
      };
    } catch (_) { return null; }
  }

  static _attack(act, src) {
    try {
      if (act?.type !== "attack" && !act?.attack) return null;
      src.push("activity.attack");
      return {
        ability: act?.attack?.ability ?? null,
        bonus: act?.attack?.bonus ?? "",
        classification: act?.attack?.type?.classification ?? null,  // weapon | spell | unarmed
        melee: act?.attack?.type?.value === "melee",
      };
    } catch (_) { return null; }
  }

  static _range(act, src) {
    try {
      const r = act?.range;
      if (!r) return null;
      src.push("activity.range");
      return { value: r.value ?? null, long: r.long ?? null, units: r.units ?? null, reach: r.reach ?? null };
    } catch (_) { return null; }
  }

  static _kind(act, save, attack, damage) {
    if (attack) return "attack";
    if (save) return "save";
    if (act?.type === "heal") return "heal";
    if (damage.length) return "damage";
    return act?.type ?? "utility";
  }

  /* ── Tier B — identity ───────────────────────────────────────────────── */

  /**
   * Who is doing this, and what family does it belong to?
   *
   * ⚠️ DDB stores the dragonborn ancestry as DATA — the race option is literally
   * labelled "Green Dragon" on the item. That is a Tier B confirmation of the
   * poison we already read from Tier A, not a substitute for it.
   */
  static _identity(item, actor, src) {
    const out = { family: null, ancestry: null, creatureType: null, species: null };
    try {
      const ddb = item?.flags?.ddbimporter;
      const choice = ddb?.dndbeyond?.choice;
      if (choice?.label) { out.ancestry = choice.label; src.push("ddb.choice"); }
      if (ddb?.baseName) { out.family = String(ddb.baseName).toLowerCase(); src.push("ddb.baseName"); }
      const sp = item?.flags?.species ?? ddb?.species;
      if (sp?.fullRaceName) { out.species = sp.fullRaceName; src.push("flags.species"); }

      out.creatureType = actor?.system?.details?.type?.value ?? null;
      if (out.creatureType) src.push("actor.details.type");

      // Fall back to the item name for a family when nothing structured says it.
      if (!out.family && item?.name) {
        out.family = String(item.name).toLowerCase().replace(/\s*[:(].*$/, "").trim();
      }
    } catch (err) {
      console.warn(`${LOG} | identity read failed:`, err);
    }
    return out;
  }

  /* ── Tier C — prose ──────────────────────────────────────────────────── */

  /**
   * Read the description for corroboration.
   *
   * ⚠️ NEVER THE AUTHORITY. Everything here is a second opinion. It fills a gap
   * or raises a flag; it does not overrule a field that exists.
   */
  static _prose(item, src) {
    const out = { element: null, shape: null, size: null, saveAbility: null, halfOnSave: false };
    try {
      const raw = item?.system?.description?.value ?? "";
      if (!raw) return out;
      const text = String(raw).replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").toLowerCase();

      for (const t of Object.keys(ELEMENT_COLOUR)) {
        if (new RegExp(`\\b${t}\\s+damage\\b`).test(text)) { out.element = t; break; }
      }
      const shapeM = /\b(\d+)[\s-]*(?:foot|ft\.?|-foot)[\s-]*(cone|line|radius|sphere|cube|square|cylinder)\b/.exec(text);
      if (shapeM) {
        out.size = Number(shapeM[1]);
        out.shape = SHAPE_ALIASES[shapeM[2]] ?? shapeM[2];
      } else {
        const bare = /\b(cone|line|sphere|radius|cube|cylinder)\b/.exec(text);
        if (bare) out.shape = SHAPE_ALIASES[bare[1]] ?? bare[1];
      }
      const saveM = /\b(strength|dexterity|constitution|intelligence|wisdom|charisma)\s+saving throw\b/.exec(text);
      if (saveM) out.saveAbility = saveM[1].slice(0, 3);
      out.halfOnSave = /half as much damage|half damage on a success/.test(text);

      if (out.element || out.shape || out.saveAbility) src.push("description");
    } catch (err) {
      console.warn(`${LOG} | prose read failed (harmless):`, err);
    }
    return out;
  }

  /* ── Confidence ──────────────────────────────────────────────────────── */

  /**
   * How sure are we? Independent agreeing signals raise it; disagreements
   * lower it. Reported so a caller can decide to ask rather than assume, and
   * so the GM can be TOLD when something looks wrong instead of it being
   * silently guessed at.
   */
  static _confidence(src, flags) {
    const structural = src.filter(s => s.startsWith("activity.") || s.startsWith("damage.")).length;
    const identity   = src.filter(s => s.startsWith("ddb.") || s.startsWith("flags.") || s.startsWith("actor.")).length;
    const prose      = src.filter(s => s.startsWith("description")).length;
    let score = Math.min(1, structural * 0.25 + identity * 0.1 + prose * 0.1);
    if (flags.length) score = Math.max(0.2, score - 0.25 * flags.length);
    return Number(score.toFixed(2));
  }

  /** Plain-English explanation, for the GM and for debugging. */
  static explain(item, activity = null, actor = null) {
    const i = Intent.read(item, activity, actor);
    const out = [
      `${i.itemName}${i.actorName ? ` — ${i.actorName}` : ""}`,
      `Kind: ${i.kind}`,
      `Element: ${i.element ?? "none"}${i.effect ? ` (JB2A ${i.effect}/${i.colour})` : ""}`,
      `Shape: ${i.shape.type ? `${i.shape.type}${i.shape.size ? ` ${i.shape.size} ${i.shape.units}` : ""}` : "none"}`,
      i.save ? `Save: ${i.save.abilities.join("/")} DC ${i.save.dcValue ?? "?"}${i.save.onSave ? ` (${i.save.onSave} on save)` : ""}` : null,
      i.attack ? `Attack: ${i.attack.classification ?? "?"}${i.attack.melee ? " melee" : ""}` : null,
      i.identity.ancestry ? `Ancestry: ${i.identity.ancestry}` : null,
      `Confidence: ${i.confidence}  [${i.sources.join(", ")}]`,
      ...i.flags.map(f => `⚠ ${f}`),
    ].filter(Boolean);
    return out;
  }
}
