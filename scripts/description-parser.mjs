// ─── ACE: QOL — Item Description Parser ───────────────────────────────────────
// Parses D&D 5e item/spell descriptions to extract structured combat data:
//   - Bonus damage (extra dice + type)
//   - Saving throws (DC, ability, success/failure effects)
//   - Condition applications (prone, grappled, restrained, etc.)
//   - Effect tables (roll d6 for result)
//   - Creature type triggers ("when you hit a Giant")
//
// Pure regex/string parsing — zero AI. Works because D&D 5e descriptions
// follow consistent templated language patterns.
// ──────────────────────────────────────────────────────────────────────────────

const MODULE_ID = "ace-qol";

/** All D&D 5e conditions we can detect and apply */
const CONDITIONS = [
  "blinded", "charmed", "deafened", "frightened", "grappled",
  "incapacitated", "invisible", "paralyzed", "petrified", "poisoned",
  "prone", "restrained", "stunned", "unconscious", "exhaustion",
];

/** Ability name mapping (handles abbreviations + full names) */
const ABILITY_MAP = {
  str: "str", strength: "str",
  dex: "dex", dexterity: "dex",
  con: "con", constitution: "con",
  int: "int", intelligence: "int",
  wis: "wis", wisdom: "wis",
  cha: "cha", charisma: "cha",
};

/** D&D 5e damage types */
const DAMAGE_TYPES = [
  "acid", "bludgeoning", "cold", "fire", "force", "lightning",
  "necrotic", "piercing", "poison", "psychic", "radiant",
  "slashing", "thunder",
];

/** Creature types for slayer-style effects */
const CREATURE_TYPES = [
  "aberration", "beast", "celestial", "construct", "dragon",
  "elemental", "fey", "fiend", "giant", "humanoid",
  "monstrosity", "ooze", "plant", "undead",
];

export class DescriptionParser {

  /**
   * Parse an item's description and return all structured combat effects.
   *
   * @param {Item} item — The D&D 5e Item document
   * @returns {ParsedEffects}
   */
  static parse(item) {
    const rawHtml = item?.system?.description?.value ?? "";
    if (!rawHtml) return DescriptionParser._empty();

    // Keep the raw HTML for Foundry enriched text patterns ([[/save]], [[/damage]], etc.)
    const html = rawHtml.replace(/\s+/g, " ").trim();
    // Strip HTML tags for plain English patterns
    const text = rawHtml.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
    const lower = text.toLowerCase();

    const result = {
      /** Saving throws required on hit */
      saves: DescriptionParser._parseSaves(text, lower),

      /** Bonus damage formulas (extra dice beyond base weapon damage) */
      bonusDamage: DescriptionParser._parseBonusDamage(text, lower),

      /** Conditions applied on hit or on failed save */
      conditions: DescriptionParser._parseConditions(text, lower),

      /** Creature type triggers ("when you hit a Giant") */
      creatureTrigger: DescriptionParser._parseCreatureTrigger(text, lower),

      /** Effect tables (roll d6: 1-2 = X, 3-4 = Y, etc.) */
      effectTable: DescriptionParser._parseEffectTable(text, lower),

      /** Half damage on successful save */
      halfOnSave: DescriptionParser._parseHalfOnSave(lower),

      /** Raw text for reference */
      rawText: text,
    };

    return result;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Save Parsing
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Extract saving throw requirements from description.
   * Patterns:
   *   "DC 14 Dexterity saving throw"
   *   "succeed on a DC 15 Strength saving throw"
   *   "make a DC 12 Constitution save"
   */
  static _parseSaves(text, lower) {
    const saves = [];
    const seen = new Set();

    // ── Foundry enriched format: [[/save dex 14 format=long]] ──
    const enrichedPattern = /\[\[\/save\s+(\w+)\s+(\d+)(?:\s+[^\]]*?)?\]\]/gi;
    let match;
    while ((match = enrichedPattern.exec(text)) !== null) {
      const abilityRaw = match[1].toLowerCase();
      const dc = parseInt(match[2]);
      const ability = ABILITY_MAP[abilityRaw];
      if (ability && dc > 0 && !seen.has(`${ability}-${dc}`)) {
        seen.add(`${ability}-${dc}`);
        const afterText = text.slice(match.index + match[0].length, match.index + match[0].length + 300).toLowerCase();
        saves.push({
          dc, ability,
          abilityLabel: abilityRaw.charAt(0).toUpperCase() + abilityRaw.slice(1),
          failEffect: DescriptionParser._parseFailEffect(afterText),
          perHit: lower.includes("must succeed") || lower.includes("target must"),
        });
      }
    }

    // ── Plain English: DC 14 Dexterity saving throw ──
    const dcPattern = /DC\s*(\d+)\s+(\w+)\s+sav(?:ing\s+throw|e)/gi;
    while ((match = dcPattern.exec(text)) !== null) {
      const dc = parseInt(match[1]);
      const abilityRaw = match[2].toLowerCase();
      const ability = ABILITY_MAP[abilityRaw];
      if (ability && dc > 0 && !seen.has(`${ability}-${dc}`)) {
        seen.add(`${ability}-${dc}`);
        const afterText = text.slice(match.index + match[0].length, match.index + match[0].length + 300).toLowerCase();
        saves.push({
          dc, ability,
          abilityLabel: match[2],
          failEffect: DescriptionParser._parseFailEffect(afterText),
          perHit: lower.includes("must succeed") || lower.includes("target must"),
        });
      }
    }

    return saves;
  }

  /**
   * Parse what happens on a failed save from the text following the save description.
   */
  static _parseFailEffect(afterText) {
    const effects = [];

    // "or be [condition]" / "or have the [condition] condition"
    for (const cond of CONDITIONS) {
      if (afterText.includes(cond)) {
        effects.push({ type: "condition", condition: cond });
      }
    }

    // "takes X (YdZ) [type] damage" after save
    const dmgPattern = /takes?\s+\d+\s*\((\d+d\d+(?:\s*[+\-]\s*\d+)?)\)\s*(\w+)\s*damage/i;
    const dmgMatch = afterText.match(dmgPattern);
    if (dmgMatch) {
      const dmgType = dmgMatch[2].toLowerCase();
      if (DAMAGE_TYPES.includes(dmgType)) {
        effects.push({ type: "damage", formula: dmgMatch[1], damageType: dmgType });
      }
    }

    return effects;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Bonus Damage Parsing
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Extract bonus damage formulas.
   * Patterns:
   *   "extra 7 (2d6) damage of the weapon's type"
   *   "takes an extra 7 (2d6) [type] damage"
   *   "additional 2d6 fire damage"
   *   "plus 1d6 cold damage"
   *   "deals an extra 1d8 radiant damage to undead"
   */
  static _parseBonusDamage(text, lower) {
    const bonuses = [];
    const seen = new Set();

    // ── Foundry enriched format: [[/damage 2d6 + @abilities.dex.mod type=piercing average=true]] ──
    const enrichedPattern = /\[\[\/damage\s+([^\]]+?)\]\]/gi;
    let match;
    while ((match = enrichedPattern.exec(text)) !== null) {
      const inner = match[1];
      // Extract formula (everything before type= or average=)
      const formulaMatch = inner.match(/^(.+?)(?:\s+type=|\s+average=|$)/i);
      let formula = formulaMatch?.[1]?.trim() ?? inner.trim();

      // Extract damage type
      const typeMatch = inner.match(/type=(\w+)/i);
      const damageType = typeMatch?.[1]?.toLowerCase() ?? "weapon";

      // Clean formula: remove @references for display, keep dice + numbers
      const displayFormula = formula
        .replace(/@abilities\.\w+\.mod/g, "MOD")
        .replace(/@[a-zA-Z0-9_.]+/g, "")
        .replace(/\s*\+\s*\+/g, "+")
        .replace(/^\s*\+\s*/, "")
        .replace(/\s*\+\s*$/, "")
        .trim();

      // Check if this is the base weapon damage (first [[/damage]] in an attack block)
      // or bonus damage (appears after save text or with "extra"/"additional" prefix)
      const beforeMatch = text.slice(Math.max(0, match.index - 100), match.index).toLowerCase();
      const isBonus = beforeMatch.includes("extra") || beforeMatch.includes("additional")
                   || beforeMatch.includes("takes") || beforeMatch.includes("plus")
                   || beforeMatch.includes("also") || beforeMatch.includes("save");

      if (isBonus && displayFormula) {
        const key = `${formula}|${damageType}`;
        if (!seen.has(key)) {
          seen.add(key);
          bonuses.push({ formula, displayFormula, damageType });
        }
      }
    }

    // ── Plain English patterns ──
    const plainPatterns = [
      /(?:extra|additional|plus)\s+\d+\s*\((\d+d\d+(?:\s*[+\-]\s*\d+)?)\)\s*(?:(\w+)\s+)?damage/gi,
      /takes?\s+\d+\s*\((\d+d\d+(?:\s*[+\-]\s*\d+)?)\)\s+(\w+)\s+damage/gi,
      /(?:extra|additional|plus)\s+(\d+d\d+(?:\s*[+\-]\s*\d+)?)\s+(\w+)\s+damage/gi,
      /deals?\s+(?:an?\s+extra\s+)?(\d+d\d+(?:\s*[+\-]\s*\d+)?)\s+(\w+)\s+damage/gi,
    ];

    for (const pattern of plainPatterns) {
      while ((match = pattern.exec(text)) !== null) {
        const formula = match[1];
        const typeRaw = (match[2] ?? "").toLowerCase();
        const damageType = DAMAGE_TYPES.includes(typeRaw) ? typeRaw : "weapon";
        const key = `${formula}|${damageType}`;
        if (!seen.has(key)) {
          seen.add(key);
          bonuses.push({ formula, displayFormula: formula, damageType });
        }
      }
    }

    return bonuses;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Condition Parsing
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Extract conditions applied by the item.
   * Patterns:
   *   "or have the Prone condition"
   *   "target is knocked prone"
   *   "the target is grappled"
   *   "the creature is poisoned"
   *   "target becomes restrained"
   */
  static _parseConditions(text, lower) {
    const found = [];
    const seen = new Set();

    // ── Foundry enriched format: &Reference[grappled]{grappled} or &amp;Reference[prone]{prone} ──
    const refPattern = /(?:&amp;|&)?Reference\[(\w+)\]\{(\w+)\}/gi;
    let match;
    while ((match = refPattern.exec(text)) !== null) {
      const cond = match[1].toLowerCase();
      if (CONDITIONS.includes(cond) && !seen.has(cond)) {
        seen.add(cond);
        const nearbyText = text.slice(Math.max(0, match.index - 200), match.index).toLowerCase();
        const requiresSave = /dc\s*\d+/.test(nearbyText) || /\[\[\/save/.test(nearbyText);
        found.push({ condition: cond, requiresSave });
      }
    }

    // ── Plain English patterns ──
    for (const cond of CONDITIONS) {
      if (seen.has(cond)) continue;

      const patterns = [
        new RegExp(`(?:is|are|be|become[s]?|have\\s+the)\\s+(?:knocked\\s+)?${cond}`, "i"),
        new RegExp(`have\\s+the\\s+${cond}\\s+condition`, "i"),
        new RegExp(`applies?\\s+(?:the\\s+)?${cond}`, "i"),
        new RegExp(`(?:knocked|pushed|forced)\\s+${cond}`, "i"),
      ];

      for (const pattern of patterns) {
        if (pattern.test(text) && !seen.has(cond)) {
          seen.add(cond);
          const condIdx = lower.indexOf(cond);
          const nearbyText = lower.slice(Math.max(0, condIdx - 200), condIdx);
          const requiresSave = /dc\s*\d+/.test(nearbyText) || /\[\[\/save/.test(nearbyText);
          found.push({ condition: cond, requiresSave });
        }
      }
    }

    return found;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Creature Type Trigger
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Detect creature-type-specific triggers.
   * Patterns:
   *   "When you hit a Giant with this weapon"
   *   "extra damage to undead"
   *   "against fiends and undead"
   */
  static _parseCreatureTrigger(text, lower) {
    for (const type of CREATURE_TYPES) {
      const patterns = [
        new RegExp(`(?:hit|strike|attack)\\s+(?:a|an)\\s+${type}`, "i"),
        new RegExp(`(?:extra|additional|bonus)\\s+.*damage\\s+(?:to|against)\\s+(?:a\\s+)?${type}`, "i"),
        new RegExp(`against\\s+(?:a\\s+)?${type}s?`, "i"),
        new RegExp(`when\\s+you\\s+hit\\s+(?:a\\s+)?${type}`, "i"),
      ];

      for (const pattern of patterns) {
        if (pattern.test(text)) {
          const rawMatch = text.match(pattern)?.[0] ?? "";

          // Extract bonus damage formula from the same sentence context
          // e.g., "extra 1d8 radiant damage to undead", "deals an additional 2d6 fire damage against fiends"
          let bonusFormula = null;
          let bonusType = null;
          const formulaPatterns = [
            new RegExp(`(\\d+d\\d+(?:\\s*[+\\-]\\s*\\d+)?)\\s+(\\w+)\\s+damage\\s+(?:to|against)\\s+(?:a\\s+)?${type}`, "i"),
            new RegExp(`(?:hit|strike|attack)\\s+(?:a|an)\\s+${type}[^.]*?(\\d+d\\d+(?:\\s*[+\\-]\\s*\\d+)?)\\s+(\\w+)\\s+damage`, "i"),
            new RegExp(`(?:extra|additional)\\s+(\\d+d\\d+(?:\\s*[+\\-]\\s*\\d+)?)\\s+(\\w+)\\s+damage`, "i"),
          ];

          for (const fp of formulaPatterns) {
            const fm = text.match(fp);
            if (fm) {
              bonusFormula = fm[1];
              const candidateType = fm[2]?.toLowerCase();
              if (DAMAGE_TYPES.includes(candidateType)) bonusType = candidateType;
              break;
            }
          }

          return { creatureType: type, rawMatch, bonusFormula, bonusType };
        }
      }
    }

    return null;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Effect Table Parsing
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Parse effect tables like "roll a d6: 1-2: Decay, 3-4: Grapple, 5-6: Topple"
   * Patterns:
   *   "choose one or roll a d6:"
   *   "roll 1d4 to determine"
   *   "1-2: Effect. Description..."
   *   "1–2: Effect. Description..."
   */
  static _parseEffectTable(text, lower) {
    // Detect table die
    const dieMatch = lower.match(/(?:roll\s+(?:a\s+)?)?(\d*d\d+)(?:\s*(?:to|for|:))/);
    if (!dieMatch && !lower.match(/\d+[\-–]\d+\s*[:\.]/)) return null;

    const die = dieMatch?.[1] ?? "d6";

    // Strip Foundry enriched references BEFORE parsing so "5-6: &amp;Reference[topple]{Topple}"
    // becomes "5-6: Topple" — allowing the regex to find entry names cleanly
    const textForParsing = text
      .replace(/\n/g, " ")
      .replace(/&amp;Reference\[\w+\]\{([^}]+)\}/g, "$1")   // &amp;Reference[x]{Label} → Label
      .replace(/&Reference\[\w+\]\{([^}]+)\}/g, "$1")        // &Reference[x]{Label} → Label
      // Convert [[/damage 4d10 type=necrotic ...]] → "4d10 necrotic damage" so entry parser can find it
      .replace(/\[\[\/damage\s+(\d+d\d+(?:\s*[+\-]\s*\d+)?)(?:\s+type=(\w+))?[^\]]*\]\]/gi,
        (_, formula, type) => `${formula} ${type ?? ""} damage`)
      .replace(/\[\[\/[^\]]+\]\]/g, "");                      // [[/save ...]] and other tags → empty

    // ── Step 1: Find all range-entry start positions ──
    const startPattern = /(\d+)\s*[\-–]\s*(\d+)\s*[:\.]?\s*([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)[.\s,]?/g;
    const starts = [];
    let startMatch;
    while ((startMatch = startPattern.exec(textForParsing)) !== null) {
      starts.push({
        index: startMatch.index,
        endIndex: startMatch.index + startMatch[0].length,
        rangeStart: parseInt(startMatch[1]),
        rangeEnd: parseInt(startMatch[2]),
        name: startMatch[3].trim(),
      });
    }

    if (!starts.length) return null;

    // ── Step 2: Extract description text between each entry ──
    const entries = [];
    for (let i = 0; i < starts.length; i++) {
      const s = starts[i];
      const descStart = s.endIndex;
      const descEnd = (i + 1 < starts.length) ? starts[i + 1].index : textForParsing.length;
      const description = textForParsing.slice(descStart, descEnd).trim();

      // Parse what this entry does
      const entryLower = description.toLowerCase();
      const entryEffects = [];

      // Check for damage in this entry (enriched + plain)
      const enrichedDmg = description.match(/\[\[\/damage\s+(\d+d\d+)(?:\s+type=(\w+))?/i);
      const plainDmg = description.match(/(\d+d\d+(?:\s*[+\-]\s*\d+)?)\)?\s*(\w+)\s*damage/i);
      const dmgMatch = enrichedDmg || plainDmg;
      if (dmgMatch) {
        const formula = dmgMatch[1];
        const dmgType = (dmgMatch[2] ?? "").toLowerCase();
        if (DAMAGE_TYPES.includes(dmgType)) {
          entryEffects.push({ type: "damage", formula, damageType: dmgType });
        }
      }

      // Check for conditions (enriched Reference[] + plain text)
      const refPattern = /(?:&amp;|&)?Reference\[(\w+)\]/gi;
      let refMatch;
      while ((refMatch = refPattern.exec(description)) !== null) {
        const cond = refMatch[1].toLowerCase();
        if (CONDITIONS.includes(cond)) {
          entryEffects.push({ type: "condition", condition: cond });
        }
      }
      // Plain text conditions
      for (const cond of CONDITIONS) {
        if (entryLower.includes(cond) && !entryEffects.some(e => e.condition === cond)) {
          entryEffects.push({ type: "condition", condition: cond });
        }
      }

      entries.push({
        range: [s.rangeStart, s.rangeEnd],
        name: s.name,
        description: description.slice(0, 150),
        effects: entryEffects,
      });
    }

    if (!entries.length) return null;

    return { die, entries };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Half Damage on Save
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Detect "half damage on successful save" patterns.
   */
  static _parseHalfOnSave(lower) {
    return lower.includes("half as much damage") ||
           lower.includes("half damage") ||
           lower.includes("takes half") ||
           lower.includes("on a successful save") ||
           lower.includes("success: half");
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Utility
  // ═══════════════════════════════════════════════════════════════════════════

  static _empty() {
    return {
      saves: [],
      bonusDamage: [],
      conditions: [],
      creatureTrigger: null,
      effectTable: null,
      halfOnSave: false,
      rawText: "",
    };
  }

  /**
   * Quick check: does this item have any parseable combat effects?
   */
  static hasEffects(item) {
    const parsed = DescriptionParser.parse(item);
    return parsed.saves.length > 0
        || parsed.bonusDamage.length > 0
        || parsed.conditions.length > 0
        || parsed.creatureTrigger !== null
        || parsed.effectTable !== null;
  }

  /**
   * Debug: log parsed results for an item.
   */
  static debug(item) {
    const parsed = DescriptionParser.parse(item);
    console.log(`${MODULE_ID} | PARSER | ${item.name}:`, parsed);
    return parsed;
  }
}
