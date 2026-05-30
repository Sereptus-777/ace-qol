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

      /** Secondary-roll sever rider (Sword of Sharpness, Vorpal Sword).
       *  Item name is also checked — any weapon with "vorpal" in its name
       *  is treated as RAW Vorpal regardless of how the description reads. */
      severRider: DescriptionParser._parseSeverRider(text, lower, item?.name),

      /** Repeating save trigger (Hold Person, Banishment, Tasha's, etc.)
       *  Returns { trigger: "endOfTurn"|"onDamage"|"endOfTurn|onDamage" }
       *  or null if no repeating save phrasing detected. */
      repeatingSave: DescriptionParser._parseRepeatingSave(text, lower),

      /** HP-threshold rider (Mace of Disruption, Mace of Smiting).
       *  Pattern: "If the target has X hit points or fewer [after taking
       *  this damage], it must succeed on a DC Y [ABILITY] save or be
       *  [destroyed/stunned/etc]."
       *  Returns null or { threshold:int, dc:int, ability:str, effect:str,
       *                    requireType?:str (e.g. "construct", "fiend|undead") } */
      hpThresholdRider: DescriptionParser._parseHpThresholdRider(text, lower),

      /** On-kill rider — attacker reward when this attack reduces target to 0 HP.
       *  Pattern: "Reducing a target to zero hitpoints grants 2d6 temporary hitpoints"
       *  (Blood Halberd), "When you reduce a creature to 0 HP you regain Xd6 hit
       *   points" (Demonblade-style life-leech weapons), "Killing a creature with
       *   this weapon grants Xd6 temp HP", etc.
       *  Returns null or { formula:str, reward:"tempHP"|"hp", target:"attacker" } */
      onKillRider: DescriptionParser._parseOnKillRider(text, lower),

      /** Raw text for reference */
      rawText: text,
    };

    // ── Cross-link bonusDamage entries with creatureTrigger sentence ──
    // If a bonus damage match sits in the SAME sentence as the creature
    // trigger phrase, that bonus is creature-gated. Mark it so the damage
    // engine can skip it on non-matching targets.
    //
    // Example — Holy Avenger: "When you attack a fiend or undead, target takes
    // extra 2d10 radiant damage." The bonus and the trigger are in the same
    // sentence → bonus only fires vs fiend/undead.
    //
    // Counter-example — Mace of Smiting: "+3 when you use the weapon to attack
    // a Construct. When you roll a 20 ... extra 7 Bludgeoning damage..." The
    // trigger is in sentence 1 (+3 bonus context); the rider is in sentence 2.
    // The rider stays UNGATED (fires on any crit), so Goblins still take it.
    if (result.creatureTrigger && Array.isArray(result.bonusDamage) && result.bonusDamage.length > 0) {
      const triggerStart = result.creatureTrigger.matchIndex;
      const triggerEnd   = result.creatureTrigger.sentenceEnd;
      const allowedTypes = result.creatureTrigger.creatureTypes
                        ?? (result.creatureTrigger.creatureType ? [result.creatureTrigger.creatureType] : []);
      for (const bd of result.bonusDamage) {
        if (typeof bd.matchIndex !== "number") continue;
        if (bd.matchIndex >= triggerStart && bd.matchIndex <= triggerEnd) {
          bd.requiresCreatureTypes = allowedTypes;
        }
      }
    }

    // ── Per-bonus "if it's a/an X" conditional detection ──
    // Mace of Smiting style: "extra 7 Bludgeoning damage, OR 14 Bludgeoning
    // damage IF IT'S A CONSTRUCT." The second entry (14) is construct-gated;
    // mark it so non-construct targets don't get the 14 on top of the 7.
    if (Array.isArray(result.bonusDamage)) {
      const conditionalRegexes = [
        /if\s+it'?s\s+(?:an?\s+)?(\w+)/i,
        /if\s+the\s+target\s+is\s+(?:an?\s+)?(\w+)/i,
      ];
      for (const bd of result.bonusDamage) {
        if (bd.requiresCreatureTypes) continue;  // already marked by sentence gating
        if (typeof bd.matchIndex !== "number") continue;
        const afterMatch = text.slice(bd.matchIndex, Math.min(text.length, bd.matchIndex + 200));
        for (const cre of conditionalRegexes) {
          const m = afterMatch.match(cre);
          if (m) {
            const candidate = m[1]?.toLowerCase();
            if (candidate && CREATURE_TYPES.includes(candidate)) {
              bd.requiresCreatureTypes = [candidate];
              break;
            }
          }
        }
      }
    }

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
        const requiredCreatureType = DescriptionParser._detectCreatureTypeQualifier(text, match.index);
        saves.push({
          dc, ability,
          abilityLabel: abilityRaw.charAt(0).toUpperCase() + abilityRaw.slice(1),
          failEffect: DescriptionParser._parseFailEffect(afterText),
          perHit: lower.includes("must succeed") || lower.includes("target must"),
          requiredCreatureType,
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
        const requiredCreatureType = DescriptionParser._detectCreatureTypeQualifier(text, match.index);
        saves.push({
          dc, ability,
          abilityLabel: match[2],
          failEffect: DescriptionParser._parseFailEffect(afterText),
          perHit: lower.includes("must succeed") || lower.includes("target must"),
          requiredCreatureType,
        });
      }
    }

    return saves;
  }

  /**
   * Detect whether a save match is gated to a specific creature type.
   *
   * Slayer-style weapons describe their save effects inside conditional
   * sentences like:
   *   "On a hit against a Giant, the target must make a DC 15 Strength save..."
   *   "If you hit a fiend, it must succeed on a DC 14 Wisdom saving throw..."
   *   "Whenever this weapon damages a Dragon, it makes a DC 13 CON save..."
   *
   * If we don't track the qualifier, the save fires against every hit creature
   * — which is the bug we just patched (Giant Slayer Spear forcing a STR save
   * on a Wolf). Looks ~250 chars before AND ~150 chars after the save match
   * for any creature-type word; returns the matched type (lowercase) or null.
   *
   * @param {string} fullText - Full description text
   * @param {number} matchIdx - Character index where the save pattern matched
   * @returns {string|null} matched creature type (e.g. "giant"), or null if unconditional
   */
  static _detectCreatureTypeQualifier(fullText, matchIdx) {
    if (!fullText || typeof matchIdx !== "number") return null;
    const before = fullText.slice(Math.max(0, matchIdx - 250), matchIdx).toLowerCase();
    const after  = fullText.slice(matchIdx, matchIdx + 150).toLowerCase();
    const window = before + " " + after;

    // Patterns that scope a save to a creature type. Looks for any of the
    // standard 5e types preceded by a conditional/qualifier phrase.
    for (const type of CREATURE_TYPES) {
      const patterns = [
        new RegExp(`(?:against|hit|hits|hitting|strike|strikes|striking|attack|attacks|attacking|damage|damages|damaging)\\s+(?:a|an|the)?\\s*${type}s?\\b`, "i"),
        new RegExp(`if\\s+(?:the\\s+)?target\\s+is\\s+(?:a|an|the)?\\s*${type}s?\\b`, "i"),
        new RegExp(`when\\s+(?:you\\s+)?(?:hit|strike|attack|damage)\\s+(?:a|an|the)?\\s*${type}s?\\b`, "i"),
        new RegExp(`whenever\\s+(?:this\\s+weapon\\s+)?(?:hits|damages|strikes)\\s+(?:a|an|the)?\\s*${type}s?\\b`, "i"),
        new RegExp(`vs\\.?\\s+(?:a|an|the)?\\s*${type}s?\\b`, "i"),
      ];
      if (patterns.some(p => p.test(window))) return type;
    }
    return null;
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
        const triggersOnCrit = DescriptionParser._detectCritOnlyQualifier(text, match.index);
        const key = `${formula}|${damageType}|${triggersOnCrit ? "crit" : "any"}`;
        if (!seen.has(key)) {
          seen.add(key);
          bonuses.push({ formula, displayFormula, damageType, triggersOnCrit, matchIndex: match.index });
        }
      }
    }

    // ── Plain English patterns ──
    //
    // The type-word capture is OPTIONAL in patterns that take "extra Xd Y damage".
    // Why: Vicious-line weapons and other crit-rider items use phrasing like
    // "extra 2d6 damage of the weapon's type" with NO type word between the
    // dice and "damage". The previous required-type-word patterns silently
    // missed these. When type is missing, damageType falls back to "weapon"
    // which the damage engine resolves at apply-time to the weapon's primary
    // damage type (piercing for a blowgun, slashing for a sword, etc.).
    const plainPatterns = [
      // Dice-notation patterns (Xd Y) — covers 2014 PHB phrasing
      /(?:extra|additional|plus)\s+\d+\s*\((\d+d\d+(?:\s*[+\-]\s*\d+)?)\)\s*(?:(\w+)\s+)?damage/gi,
      /takes?\s+\d+\s*\((\d+d\d+(?:\s*[+\-]\s*\d+)?)\)\s+(?:(\w+)\s+)?damage/gi,
      /(?:extra|additional|plus)\s+(\d+d\d+(?:\s*[+\-]\s*\d+)?)\s+(?:(\w+)\s+)?damage/gi,
      /deals?\s+(?:an?\s+extra\s+)?(\d+d\d+(?:\s*[+\-]\s*\d+)?)\s+(?:(\w+)\s+)?damage/gi,
    ];

    for (const pattern of plainPatterns) {
      while ((match = pattern.exec(text)) !== null) {
        const formula = match[1];
        const typeRaw = (match[2] ?? "").toLowerCase();
        const damageType = DAMAGE_TYPES.includes(typeRaw) ? typeRaw : "weapon";
        const triggersOnCrit = DescriptionParser._detectCritOnlyQualifier(text, match.index);
        const key = `${formula}|${damageType}|${triggersOnCrit ? "crit" : "any"}`;
        if (!seen.has(key)) {
          seen.add(key);
          bonuses.push({ formula, displayFormula: formula, damageType, triggersOnCrit, matchIndex: match.index });
        }
      }
    }

    // ── Flat-integer bonus damage patterns (dnd5e 5.x / 2024 PHB style) ──
    // The 2024 PHB and dnd5e 5.x compendium use flat numbers instead of dice
    // for NPC/item bonus damage: "extra 7 Bludgeoning damage" instead of
    // "extra 2d6 bludgeoning damage". Our regex needs to handle both.
    //
    // The negative lookahead `(?!\s+rolls?)` prevents matching phrases like
    // "+1 bonus to damage rolls" or "your damage rolls made with..." — those
    // are item-property bonuses, not bonus damage we want to add separately.
    //
    // Type word is optional (same reasoning as the dice patterns above).
    // When matched, formula is just the integer string (e.g., "7"), which
    // the damage engine rolls as a fixed value.
    const flatIntPatterns = [
      /(?:extra|additional|plus)\s+(\d+)\s+(?:(\w+)\s+)?damage(?!\s+rolls?)/gi,
      /takes?\s+(?:an?\s+extra\s+)?(\d+)\s+(?:(\w+)\s+)?damage(?!\s+rolls?)/gi,
      /deals?\s+(?:an?\s+extra\s+)?(\d+)\s+(?:(\w+)\s+)?damage(?!\s+rolls?)/gi,
      // "or Y damage if it's a Construct" — the conditional override variant.
      // Captures the integer; the conditional creature-type gate is handled at
      // apply-time (currently both this and the base bonus may fire, which
      // over-damages by the smaller — acceptable until conditional gating ships).
      /,?\s*or\s+(\d+)\s+(?:(\w+)\s+)?damage(?!\s+rolls?)/gi,
    ];

    for (const pattern of flatIntPatterns) {
      while ((match = pattern.exec(text)) !== null) {
        const flat = match[1];
        // Skip very small numbers that are likely false positives (counters,
        // page refs, distances). Real bonus damage is almost always >= 3.
        if (Number(flat) < 2) continue;
        const typeRaw = (match[2] ?? "").toLowerCase();
        const damageType = DAMAGE_TYPES.includes(typeRaw) ? typeRaw : "weapon";
        const triggersOnCrit = DescriptionParser._detectCritOnlyQualifier(text, match.index);
        const key = `${flat}|${damageType}|${triggersOnCrit ? "crit" : "any"}`;
        if (!seen.has(key)) {
          seen.add(key);
          bonuses.push({ formula: flat, displayFormula: flat, damageType, triggersOnCrit, isFlat: true, matchIndex: match.index });
        }
      }
    }

    return bonuses;
  }

  /**
   * Detect whether a bonus-damage match is gated on rolling a critical hit.
   *
   * Vicious-line weapons + Sword of Sharpness, Mace of Smiting, Sword of Life
   * Stealing, Nine Lives Stealer all have phrasing like "When you score a
   * critical hit with this weapon, the target takes an extra ..." or
   * "When you roll a 20 on the attack...". Without gating, the bonus rolls on
   * every hit — a Vicious longsword would do +2d6 on every swing rather than
   * only on crits, which is silently game-breaking.
   *
   * Looks at ~250 chars before the bonus-damage match for crit-trigger
   * phrasing. Returns true if found, false otherwise.
   *
   * @param {string} fullText
   * @param {number} matchIdx
   * @returns {boolean}
   */
  static _detectCritOnlyQualifier(fullText, matchIdx) {
    if (!fullText || typeof matchIdx !== "number") return false;
    const before = fullText.slice(Math.max(0, matchIdx - 250), matchIdx).toLowerCase();
    // Common crit-gate phrasings in published 5e and DDB-formatted descriptions.
    const critPatterns = [
      /\bcritical\s+hit\b/i,
      /\bscore\s+a\s+critical\b/i,
      /\bon\s+a\s+critical\b/i,
      /\bif\s+you\s+score\s+a\s+critical\b/i,
      /\bwhen\s+you\s+score\s+a\s+critical\b/i,
      /\broll\s+a\s+20\b/i,
      /\brolled\s+a\s+20\b/i,
      /\b(?:rolling|roll)\s+a\s+20\b/i,
      /\bnatural\s+20\b/i,
      /\bnatural\s+roll\s+of\s+20\b/i,
    ];
    return critPatterns.some(p => p.test(before));
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

    // ── Foundry enriched format ──
    // Multiple variants seen in practice:
    //   &Reference[grappled]{grappled}                      (older 2014 PHB)
    //   &amp;Reference[prone]{prone}                          (HTML-encoded ampersand)
    //   &Reference[paralyzed apply=false]                   (2024 PHB — Hold Person, etc.)
    //   &Reference[charmed type=enchantment apply=false]    (modifier args, no {label})
    // The OLD regex required the closing bracket to come right after `\w+` and
    // ALSO required a `{label}` block. Both assumptions break for 2024 spells
    // that include `apply=false` modifiers and omit the label. The result was
    // Hold Person's paralyzed never being extracted — silent failure.
    // New pattern: the first word inside the brackets is the condition; any
    // additional space-separated modifier args are ignored; the {label} is
    // also optional.
    const refPattern = /(?:&amp;|&)?Reference\[(\w+)(?:[^\]]*)?\](?:\{[^}]*\})?/gi;
    let match;
    while ((match = refPattern.exec(text)) !== null) {
      const cond = match[1].toLowerCase();
      if (CONDITIONS.includes(cond) && !seen.has(cond)) {
        seen.add(cond);
        const nearbyText = text.slice(Math.max(0, match.index - 200), match.index).toLowerCase();
        // requiresSave: condition is gated by a save the target must make.
        // The OLD test only matched the literal phrase "DC 17" or the enriched
        // [[/save tag. Hold Person's text says "must succeed on a Wisdom saving
        // throw" with no inline DC — so paralyzed wasn't detected as save-gated
        // and was silently skipped. Loosened to match standard 5e save-trigger
        // phrasings: "saving throw", "save or", "must succeed".
        const requiresSave = /dc\s*\d+/.test(nearbyText)
                          || /\[\[\/save/.test(nearbyText)
                          || /sav(?:ing\s+throw|e)/i.test(nearbyText)
                          || /must\s+succeed\s+on/i.test(nearbyText);
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
          // requiresSave: condition is gated by a save the target must make.
        // The OLD test only matched the literal phrase "DC 17" or the enriched
        // [[/save tag. Hold Person's text says "must succeed on a Wisdom saving
        // throw" with no inline DC — so paralyzed wasn't detected as save-gated
        // and was silently skipped. Loosened to match standard 5e save-trigger
        // phrasings: "saving throw", "save or", "must succeed".
        const requiresSave = /dc\s*\d+/.test(nearbyText)
                          || /\[\[\/save/.test(nearbyText)
                          || /sav(?:ing\s+throw|e)/i.test(nearbyText)
                          || /must\s+succeed\s+on/i.test(nearbyText);
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
    // Collect ALL matching creature types and their match positions. Some
    // items target multiple types (Holy Avenger: "fiend or undead", Sun Blade:
    // "undead", Demon Slayer: "fiend"). We want to capture all of them so the
    // damage system can fire the bonus when target matches ANY of them.
    const allMatches = [];

    for (const type of CREATURE_TYPES) {
      const patterns = [
        new RegExp(`(?:hit|strike|attack)\\s+(?:a|an)\\s+${type}`, "i"),
        new RegExp(`(?:extra|additional|bonus)\\s+.*damage\\s+(?:to|against)\\s+(?:a\\s+)?${type}`, "i"),
        new RegExp(`against\\s+(?:a\\s+)?${type}s?`, "i"),
        new RegExp(`when\\s+you\\s+hit\\s+(?:a\\s+)?${type}`, "i"),
        // Multi-type variant: "attack a fiend or undead", "fiend or undead"
        new RegExp(`(?:a|an)\\s+\\w+\\s+or\\s+${type}`, "i"),
        new RegExp(`${type}\\s+or\\s+\\w+`, "i"),
      ];

      let matchInfo = null;
      for (const pattern of patterns) {
        const m = text.match(pattern);
        if (m) {
          matchInfo = { rawMatch: m[0], matchIndex: m.index };
          break;
        }
      }
      if (matchInfo) {
        allMatches.push({ type, ...matchInfo });
      }
    }

    if (allMatches.length === 0) return null;

    // Sort by match index — the EARLIEST trigger position is the "primary".
    // Multiple types within ~30 chars are treated as a multi-type trigger.
    allMatches.sort((a, b) => a.matchIndex - b.matchIndex);
    const primary = allMatches[0];
    const grouped = allMatches.filter(m => Math.abs(m.matchIndex - primary.matchIndex) < 30);
    const creatureTypes = grouped.map(g => g.type);

    // Formula extraction — look for dice or flat-int bonus damage in the SAME
    // sentence as the primary trigger (between matchIndex and the next period).
    let bonusFormula = null;
    let bonusType    = null;
    const sentenceEnd = (() => {
      const dot = text.indexOf(".", primary.matchIndex);
      return dot < 0 ? text.length : dot;
    })();
    const sentence = text.slice(primary.matchIndex, sentenceEnd + 1);
    const formulaPatterns = [
      // Dice patterns
      new RegExp(`(\\d+d\\d+(?:\\s*[+\\-]\\s*\\d+)?)\\s+(?:(\\w+)\\s+)?damage`, "i"),
      // Flat-int (2024 PHB style)
      new RegExp(`(?:extra|additional|plus|takes?|deals?)\\s+(?:an?\\s+extra\\s+)?(\\d+)\\s+(?:(\\w+)\\s+)?damage(?!\\s+rolls?)`, "i"),
    ];
    for (const fp of formulaPatterns) {
      const fm = sentence.match(fp);
      if (fm) {
        bonusFormula = fm[1];
        const candidateType = fm[2]?.toLowerCase();
        if (DAMAGE_TYPES.includes(candidateType)) bonusType = candidateType;
        break;
      }
    }

    return {
      creatureType:  primary.type,         // primary single type (back-compat)
      creatureTypes,                       // all types in the trigger phrase
      rawMatch:      primary.rawMatch,
      matchIndex:    primary.matchIndex,
      sentenceEnd,
      bonusFormula,
      bonusType,
    };
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
  //  Target Type Restriction (creature-type filter for spell targets)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Detect creature-type restrictions on a spell's targeting.
   *
   * Examples:
   *   Hold Person:    "Choose a Humanoid that you can see within range"
   *   Charm Person:   "Choose a Humanoid you can see within range"
   *   Charm Monster:  "Choose a Humanoid, Beast, Fey, Giant, or Plant"
   *   Conjure Animals (target a beast): "Choose a Beast you can see"
   *
   * Returns null when no restriction is detected (most spells — they
   * accept any creature type). Otherwise returns:
   *   { allowed: ["humanoid"] } / { allowed: ["humanoid", "beast", "fey", "giant", "plant"] }
   *
   * The EngagementGate uses this to BLOCK casts on invalid targets BEFORE
   * the slot is consumed. RAW: Hold Person doesn't merely fail on a wolf,
   * the wolf isn't a legal target at all — the spell shouldn't be cast.
   *
   * @param {string} text — full description text (HTML stripped or raw)
   * @returns {{ allowed: string[] }|null}
   */
  static _parseTargetTypeRestriction(text) {
    if (!text) return null;
    // Strip HTML for cleaner regex
    const plain = String(text).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    const lower = plain.toLowerCase();

    // ── First: find a "choose / target a [type]" anchor phrase ──
    // Capture the index so we can scan the immediately-following text for
    // additional types (Charm Monster's "Humanoid, Beast, Fey, Giant, or Plant").
    const typeAlternation = CREATURE_TYPES.join("|");
    const anchorRegex = new RegExp(
      `(?:choose|target)\\s+(?:a|an|one|any\\s+number\\s+of)\\s+(?:[a-z]+\\s+)?(${typeAlternation})s?\\b`,
      "i"
    );
    const anchor = lower.match(anchorRegex);
    if (!anchor) return null;

    const found = new Set([anchor[1].toLowerCase()]);

    // ── Scan the following ~200 chars for additional types in a comma list ──
    // Charm Monster: "Choose a Humanoid, Beast, Fey, Giant, or Plant"
    // The list ENDS at the first sentence break (period, "you can see", etc.)
    const listStart = anchor.index + anchor[0].length;
    const listWindow = lower.slice(listStart, listStart + 200);
    // Stop scanning at the first period or the phrase "you can see" which
    // marks the end of the targeting clause in 5e wording.
    const stopIdx = listWindow.search(/[.;]|\byou can see\b|\bwithin range\b/);
    const scan = stopIdx >= 0 ? listWindow.slice(0, stopIdx) : listWindow;
    // Match every standalone creature-type word in this window
    const followRegex = new RegExp(`\\b(${typeAlternation})s?\\b`, "gi");
    let m;
    while ((m = followRegex.exec(scan)) !== null) {
      found.add(m[1].toLowerCase());
    }

    return { allowed: [...found] };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Half Damage on Save
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Detect "half damage on successful save" patterns.
   *
   * The previous version returned true on the bare phrase "on a successful
   * save" — but that text appears in nearly every save-or-condition spell
   * (Hold Person says the target re-saves and "on a successful save" the
   * paralysis ends, NOT that damage is halved). The result was Hold Person,
   * Charm Person, Dominate, Suggestion etc. all getting a bogus "HALF ON
   * SAVE" label and triggering the damage-card UI even though they have
   * zero damage parts.
   *
   * Tightened to require "damage" or "takes half" near the success phrase,
   * and accepts the standard 5e half-damage idioms.
   */
  static _parseHalfOnSave(lower) {
    if (!lower) return false;
    // Direct half-damage phrasings (always true)
    if (lower.includes("half as much damage")) return true;
    if (lower.includes("half damage")) return true;
    if (lower.includes("takes half")) return true;
    if (lower.includes("success: half")) return true;
    // "on a successful save" — only treat as half-damage if "damage" appears
    // within ~120 chars (same sentence/clause).
    const idx = lower.indexOf("on a successful save");
    if (idx >= 0) {
      const window = lower.slice(idx, idx + 120);
      if (window.includes("damage") && (window.includes("half") || window.includes("only"))) {
        return true;
      }
    }
    return false;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  HP-threshold rider — Mace of Disruption, Mace of Smiting, etc.
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Detect HP-threshold rider:
   *   "If the target has 25 hit points or fewer after taking this damage, it
   *    must succeed on a DC 15 Wisdom saving throw or be destroyed."
   *   "If the target is a construct and has 25 hit points or fewer, it must
   *    succeed on a DC 15 Strength saving throw or be destroyed."
   *
   * Returns null if no HP-threshold rider is detected, otherwise:
   *   {
   *     threshold: 25,         // HP at-or-below for the trigger to fire
   *     dc: 15,                // Save DC
   *     ability: "wis",        // Save ability (lowercase 3-letter code)
   *     effect: "destroyed",   // What happens on save fail (text)
   *     requireType: "construct", // Optional creature-type gate, lowercase
   *     onlyOnCrit: false,     // Mace of Smiting requires nat 20 to even check
   *   }
   *
   * Returns null when:
   *   - No "X hit points or fewer" pattern is present
   *   - No save DC adjacent to the threshold
   */
  static _parseHpThresholdRider(text, lower) {
    if (!text || !lower) return null;

    // Quick reject — no HP-threshold language at all
    if (!/\b\d+\s+hit\s+points?\s+or\s+fewer\b/i.test(text)) return null;

    // Match the canonical phrase. Captures:
    //   1: threshold number
    //   2: save DC number
    //   3: ability label
    //   4: effect (until period)
    const re = /\b(\d+)\s+hit\s+points?\s+or\s+fewer\b[^.]{0,80}?(?:succeed\s+on\s+a\s+)?DC\s+(\d+)\s+(strength|dexterity|constitution|intelligence|wisdom|charisma)\s+(?:saving\s+throw|save)\s+or\s+(?:be\s+|become\s+)?([a-z\-]+)/i;
    const m = text.match(re);
    if (!m) return null;

    const threshold = Number(m[1]);
    const dc        = Number(m[2]);
    const abilityFull = m[3].toLowerCase();
    const ability   = ({ strength: "str", dexterity: "dex", constitution: "con",
                        intelligence: "int", wisdom: "wis", charisma: "cha" })[abilityFull];
    const effect    = m[4].toLowerCase();

    if (!Number.isFinite(threshold) || !Number.isFinite(dc) || !ability) return null;

    // Look back ~150 chars for a creature-type gate ("a construct", "a fiend
    // or an undead", etc.)
    const before = text.slice(Math.max(0, m.index - 200), m.index).toLowerCase();
    let requireType = null;
    const typeMatch = before.match(/\b(?:if|when)\s+(?:the\s+target\s+is\s+)?an?\s+(construct|fiend|undead|aberration|beast|celestial|dragon|elemental|fey|giant|humanoid|monstrosity|ooze|plant)/i);
    if (typeMatch) {
      requireType = typeMatch[1].toLowerCase();
    } else {
      // Pattern "a fiend or an undead"
      const orMatch = before.match(/\b(?:hit\s+)?an?\s+(\w+)\s+or\s+an?\s+(\w+)\b/i);
      if (orMatch) {
        const [_, t1, t2] = orMatch;
        const validTypes = ["construct","fiend","undead","aberration","beast","celestial","dragon","elemental","fey","giant","humanoid","monstrosity","ooze","plant"];
        const types = [t1, t2].map(t => t.toLowerCase()).filter(t => validTypes.includes(t));
        if (types.length > 0) requireType = types.join("|");
      }
    }

    // Detect "on a 20 attack roll" gate (Mace of Smiting requires a crit)
    const onlyOnCrit = /\bnat(?:ural)?\s+20\b|\broll\s+a\s+20\b/i.test(before);

    return { threshold, dc, ability, effect, requireType, onlyOnCrit };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  On-Kill Rider — attacker reward when reducing target to 0 HP
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Detect on-kill riders that grant the ATTACKER something (temp HP, healing,
   * etc.) when this attack reduces a target to 0 hit points.
   *
   * Examples:
   *   Blood Halberd: "Reducing a target to zero hitpoints grants 2d6 temporary
   *                   hitpoints"
   *   Demon-life weapons: "When you reduce a creature to 0 HP, you regain
   *                        1d10 hit points"
   *   Soul-drinker: "Killing a creature with this weapon grants 3d6 temp HP"
   *
   * Returns null when no kill-trigger pattern is detected, otherwise:
   *   {
   *     formula: "2d6"        // dice formula to roll (no spaces)
   *     reward:  "tempHP" | "hp"
   *     target:  "attacker"   // always — riders that benefit the target on
   *                            //  kill make no semantic sense, leave room
   *                            //  for future expansion
   *     phrase:  "<excerpt>"   // matched text for debugging
   *   }
   *
   * Detection is permissive — multiple phrasings of the same RAW pattern.
   * False positives are filtered by the kill-trigger keyword reject up front.
   */
  static _parseOnKillRider(text, lower) {
    if (!text || !lower) return null;

    // Quick reject — no kill-trigger language anywhere
    // Covers: "reducing... to 0/zero", "kills/killing", "drops to 0/zero"
    const triggerProbe = /\b(?:reducing|reduce|kills?|killing|drop(?:s|ped)?\s+to\s+(?:0|zero))\b/i;
    if (!triggerProbe.test(text)) return null;

    // ── TEMP HP variants ──
    // Match flexible phrasings of "<kill phrase> grants/gives Xd6 temp HP".
    // The {0,80} allows for filler text between the kill phrase and the reward
    // (e.g., "...to 0 hit points grants the wielder 2d6 temp hp").
    const tempHpPatterns = [
      // "Reducing a target to zero hitpoints grants 2d6 temporary hitpoints"
      // "Reducing a creature to 0 hit points grants Xd6 temp hp"
      /(?:reducing|reduce|killing|kills)\s+(?:an?\s+|the\s+)?(?:target|creature|enemy|foe)?[^.]{0,80}?(?:grants?|gives?|gains?|regain)\s+(?:you\s+|the\s+wielder\s+)?(\d+d\d+(?:\s*\+\s*\d+)?)\s+(?:temp(?:orary)?\s+(?:hit\s*)?points?|temp\s+hp)/i,
      // "When you reduce a creature to 0 HP, you gain Xd6 temp HP"
      /(?:when|if)\s+(?:you|this\s+attack)\s+(?:reduces?|kills?)\s+(?:an?\s+|the\s+)?(?:target|creature|enemy|foe)[^.]{0,80}?(?:grants?|gives?|gains?|regain)\s+(?:you\s+)?(\d+d\d+(?:\s*\+\s*\d+)?)\s+(?:temp(?:orary)?\s+(?:hit\s*)?points?|temp\s+hp)/i,
      // "Drops to 0, attacker gains Xd6 temp HP"
      /drops?\s+to\s+(?:0|zero)[^.]{0,80}?(?:attacker|wielder|you)\s+(?:gains?|grants?|regain)\s+(\d+d\d+(?:\s*\+\s*\d+)?)\s+(?:temp(?:orary)?\s+(?:hit\s*)?points?|temp\s+hp)/i,
    ];

    for (const re of tempHpPatterns) {
      const m = text.match(re);
      if (m) {
        const formula = m[1].trim().replace(/\s+/g, "");
        if (DescriptionParser._isValidDiceFormula(formula)) {
          return {
            formula,
            reward: "tempHP",
            target: "attacker",
            phrase: m[0].slice(0, 120),
          };
        }
      }
    }

    // ── SELF-HEAL (HP regain) variants ──
    // Distinct from temp HP. Must NOT include the word "temp" anywhere in the
    // matched phrase, otherwise we'd misclassify temp-HP rewards as healing.
    // Verb alternation is broader than temp HP because heal phrasings have
    // more variety in natural English: "regain", "heal", "restore", plus
    // "gain", "grants", "gives" (each in singular/plural). The runtime
    // !temp check below catches any temp-HP false positives.
    const healPatterns = [
      // "Reducing a target to 0 HP, you regain 1d10 hit points"
      /(?:reducing|reduce|killing|kills)\s+(?:an?\s+|the\s+)?(?:target|creature|enemy|foe)?[^.]{0,80}?(?:regain|heal|restore|gains?|grants?|gives?)\s+(?:you\s+|the\s+wielder\s+)?(\d+d\d+(?:\s*\+\s*\d+)?)\s+(?:hit\s*points?|hp)\b(?!\s*as\s*temp)/i,
      // "When you kill a creature, you regain Xd6 hit points"
      /(?:when|if)\s+(?:you|this\s+attack)\s+(?:reduces?|kills?)\s+(?:an?\s+|the\s+)?(?:target|creature|enemy|foe)[^.]{0,80}?(?:regain|heal|restore|gains?|grants?|gives?)\s+(?:you\s+)?(\d+d\d+(?:\s*\+\s*\d+)?)\s+(?:hit\s*points?|hp)\b(?!\s*as\s*temp)/i,
    ];

    for (const re of healPatterns) {
      const m = text.match(re);
      if (m && !/\btemp(?:orary)?\b/i.test(m[0])) {
        const formula = m[1].trim().replace(/\s+/g, "");
        if (DescriptionParser._isValidDiceFormula(formula)) {
          return {
            formula,
            reward: "hp",
            target: "attacker",
            phrase: m[0].slice(0, 120),
          };
        }
      }
    }

    return null;
  }

  /**
   * Lightweight dice-formula sanity check. We don't need full Roll-engine
   * validation — just verify the matched substring looks like a real formula
   * before treating it as authoritative. Catches regex false-positives where
   * the dice-formula capture got something silly like "0d0" or "999d999".
   */
  static _isValidDiceFormula(formula) {
    if (!formula) return false;
    const m = formula.match(/^(\d+)d(\d+)(?:\+(\d+))?$/);
    if (!m) return false;
    const num = parseInt(m[1]);
    const die = parseInt(m[2]);
    if (!Number.isFinite(num) || !Number.isFinite(die)) return false;
    if (num < 1 || num > 20) return false;     // reasonable upper bound
    if (![4,6,8,10,12,20,100].includes(die)) return false;  // standard dice only
    return true;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Sever Rider — secondary-roll mechanic (Sword of Sharpness, Vorpal Sword)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Detect a secondary-roll sever rider:
   *   "Then roll another d20. If you roll a 20, you lop off one of the
   *    target's limbs..."
   *   "...if you roll another 20, you sever the head..."
   *
   * Returns null if no sever pattern is detected, otherwise:
   *   {
   *     triggerOn: "crit",            // always — these riders all chain off a nat 20 attack
   *     secondaryDie: "d20",          // always d20 in 5e RAW
   *     secondaryThreshold: 20,       // value needed on the second roll
   *     severType: "limb" | "head" | "body",
   *     description: "<excerpt>"      // what to flavor the result with
   *   }
   *
   * The secondary roll only happens on a NATURAL 20 attack roll (not on
   * expanded crit ranges) — that's RAW for both weapons, and it's the only
   * sane reading of "Then roll another d20" since the trigger sentence
   * starts with "and roll a 20 on the attack roll".
   */
  // ═══════════════════════════════════════════════════════════════════════════
  //  Repeating Save Trigger
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Detect spells that allow the affected creature to re-roll the save on a
   * recurring trigger — RAW for Hold Person, Hold Monster, Banishment,
   * Dominate Person/Monster, Tasha's Hideous Laughter, etc.
   *
   * Three trigger types in 5e:
   *   - "endOfTurn"             — Hold Person, Hold Monster, Banishment
   *   - "onDamage"              — Dominate Person/Monster
   *   - "endOfTurn|onDamage"    — Tasha's Hideous Laughter (both)
   *
   * Returns an object like { trigger: "endOfTurn" } or null if no repeating
   * save phrasing detected. Detection is permissive — multiple phrasings of
   * the same RAW rule:
   *   "at the end of each of its turns"
   *   "at the end of each of the target's turns"
   *   "at the end of each of the creature's turns"
   *   "each time it takes damage"
   *   "each time the target takes damage"
   *   "after taking damage"  (rare phrasing)
   *
   * The save details (ability, DC) are NOT extracted here — those come from
   * the activity itself (caller passes saveAbility + saveDC). This function
   * only answers: "does the spell allow recurring re-saves, and if so, when?"
   */
  static _parseRepeatingSave(text, lower) {
    if (!text) return null;

    const ENDOFTURN_PATTERNS = [
      /at\s+the\s+end\s+of\s+each\s+of\s+(?:its|the\s+target'?s|the\s+creature'?s|the\s+target's|the\s+creature's)\s+turns?/i,
      /at\s+the\s+end\s+of\s+(?:its|the\s+target'?s|the\s+creature'?s)\s+turns?/i,
      /(?:can|may|repeats?)\s+(?:make\s+)?another\s+(?:\w+\s+)?saving\s+throw\s+at\s+the\s+end\s+of\s+(?:its|the\s+target'?s|each)/i,
      /repeat(?:s)?\s+(?:the\s+)?save\s+(?:at\s+)?(?:the\s+)?end\s+of\s+(?:each\s+of\s+)?(?:its|the\s+target'?s)?\s*turns?/i,
    ];

    const ONDAMAGE_PATTERNS = [
      /each\s+time\s+(?:it|the\s+target|the\s+creature)\s+takes\s+damage/i,
      /(?:when|whenever)\s+(?:it|the\s+target|the\s+creature)\s+takes\s+damage/i,
      /each\s+time\s+(?:the\s+)?(?:target|creature)\s+takes\s+damage/i,
    ];

    const hasEndOfTurn = ENDOFTURN_PATTERNS.some(p => p.test(text));
    const hasOnDamage  = ONDAMAGE_PATTERNS.some(p => p.test(text));

    if (!hasEndOfTurn && !hasOnDamage) return null;

    let trigger;
    if (hasEndOfTurn && hasOnDamage) trigger = "endOfTurn|onDamage";
    else if (hasEndOfTurn)            trigger = "endOfTurn";
    else                              trigger = "onDamage";

    return { trigger };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Sever Rider
  // ═══════════════════════════════════════════════════════════════════════════

  static _parseSeverRider(text, lower, itemName = "") {
    // ── Door 1: NAME-BASED detection (most reliable, RAW-fallback) ──
    // Any weapon with "vorpal" in its name is treated as a full RAW Vorpal
    // Sword regardless of how the description reads. This catches:
    //   - Homebrew with non-RAW wording ("severs the head" instead of "cut off")
    //   - Renamed variants ("Vorpal Scimitar", "Vorpal Greatsword", "the Vorpal")
    //   - Items whose description was lost or replaced
    // Going to market with this safety net so production users don't lose
    // the iconic Vorpal head-lop when descriptions drift from the book.
    const name = String(itemName ?? "").toLowerCase();
    if (/\bvorpal\b/i.test(name)) {
      return {
        triggerOn:         "crit",
        secondaryDie:      "d20",
        secondaryThreshold: 20,
        severType:         "head",
        // Critical: Vorpal triggers off the ORIGINAL nat-20 attack roll, NOT
        // a separate secondary d20. Skipping the secondary roll makes the
        // runner treat the nat 20 as an automatic sever (RAW).
        skipSecondaryRoll: true,
        description:       "Vorpal — on a natural 20 attack, the target's head is cut off (RAW).",
        matchedBy:         "name",
      };
    }

    if (!text) return null;

    // ── Door 2: DESCRIPTION-BASED detection ──
    // Quick reject: no sever-action verbs anywhere → not a sever rider.
    // "cut off" added so RAW Vorpal Sword text ("you cut off one of the
    // creature's heads") is recognized.
    if (!/\b(?:lop\s+off|cut\s+off|cuts?\s+off|sever|amputate|severs?|severed)\b/i.test(text)) return null;

    // Must be paired with a trigger pattern. Two flavors:
    //   (a) Sharpness-style — explicit secondary d20 roll
    //   (b) Vorpal-style — triggers directly off the original nat-20 attack,
    //       no secondary roll. RAW Vorpal phrasing: "and roll a 20 on the
    //       attack roll, you cut off…"
    const sharpnessTriggers = [
      /\bthen\s+roll\s+another\s+d?20\b/i,
      /\broll\s+another\s+d?20\b/i,
      /\broll\s+a\s+second\s+d?20\b/i,
      /\bif\s+you\s+roll\s+(?:a|another)\s+20\b/i,
    ];
    const vorpalTriggers = [
      /\broll\s+a\s+20\s+on\s+the\s+attack\s+roll\b/i,
      /\bnatural\s+20\s+on\s+the\s+attack\s+roll\b/i,
      /\bon\s+a\s+(?:natural\s+)?20\b/i,
    ];

    const hasSharpnessTrigger = sharpnessTriggers.some(p => p.test(text));
    const hasVorpalTrigger    = vorpalTriggers.some(p => p.test(text));

    if (!hasSharpnessTrigger && !hasVorpalTrigger) return null;

    // Determine WHAT gets severed (limb / head / body part)
    let severType = "limb"; // default — Sword of Sharpness lops a limb
    if (/\bsever(?:s|ed)?\s+(?:the\s+)?head\b/i.test(text)
        || /\b(?:lop|cut)s?\s+off\s+(?:one\s+of\s+)?(?:the\s+)?(?:creature'?s\s+)?heads?\b/i.test(text)
        || /\b(?:lop|cut)\s+off\s+(?:the\s+)?head\b/i.test(text)) {
      severType = "head"; // Vorpal Sword
    } else if (/\bportion\s+of\s+(?:its\s+)?body\b/i.test(text) || /\bsever\s+(?:a\s+)?body/i.test(text)) {
      severType = "body";
    }

    // Capture a short excerpt for the chat card flavor
    const m = text.match(/(roll\s+another\s+d?20[^.]*\.\s*if\s+you\s+roll[^.]*\.[^.]*)/i)
           ?? text.match(/(if\s+you\s+roll\s+(?:a|another)\s+20[^.]*\.[^.]*)/i)
           ?? text.match(/(roll\s+a\s+20\s+on\s+the\s+attack\s+roll[^.]*\.[^.]*)/i);
    const description = m ? stripExcerpt(m[1])
                          : (hasVorpalTrigger ? "On a natural 20 attack roll, the target's head is cut off."
                                              : "Roll another d20 — on a 20, the limb is severed.");

    function stripExcerpt(s) {
      return String(s).replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim().slice(0, 280);
    }

    return {
      triggerOn:         "crit",
      secondaryDie:      "d20",
      secondaryThreshold: 20,
      severType,
      // Vorpal-style descriptions trigger on the primary nat-20 only, no
      // secondary d20. Sharpness-style explicitly requires the second roll.
      skipSecondaryRoll: hasVorpalTrigger && !hasSharpnessTrigger,
      description,
      matchedBy:         "description",
    };
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
      severRider: null,
      repeatingSave: null,
      hpThresholdRider: null,
      onKillRider: null,
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
        || parsed.effectTable !== null
        || parsed.severRider !== null
        || parsed.repeatingSave !== null
        || parsed.hpThresholdRider !== null
        || parsed.onKillRider !== null;
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
