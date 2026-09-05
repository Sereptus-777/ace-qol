// ─── ACE: QOL — Spell Registry: Heal Shapes (touch + multi-heal) ─────────────
// Cure Wounds (touch), Healing Word (single, ranged), Mass Cure Wounds (multi),
// Mass Healing Word (multi), Heal (single).
//
// formula is a function (castLvl, spellMod) → dice string. Caller (HealResolver)
// rolls per target, applies HP. Most heal spells RAW are per-target rolls (each
// target gets their own dice).
// ──────────────────────────────────────────────────────────────────────────────

export const HEAL_SPELLS = {

  // ⚠️🔴 2024 DOUBLED THE DICE AND THIS ENTRY KEPT 2014's. Found by
  // `game.aceQol.auditSpellRules()` against his own sheets on 2026-09-04, which
  // is the only reason it was ever found: the spell resolved, posted a card and
  // healed half, and nothing anywhere disagreed with itself.
  "cure wounds": {
    shape: "touch",
    range: 5,
    heal: {
      // ⚠️ THE UPCAST IS INFERRED, NOT READ. The audit proved the base is 2d8;
      // his Healing Word text proved 2024 doubled BOTH the base and the per-level
      // step there (2d4 base, +2d4 per level), and Cure Wounds is the same pair of
      // changes. If his copy says +1d8 per level instead, this line is the one to
      // change and nothing else moves.
      formula: (castLvl, spellMod) => `${2 * Math.max(1, castLvl)}d8 + ${spellMod}`,
    },
    picker: { allowSelf: true, preHighlightSelf: true, requiresAdjacent: true, excludeDead: false },
    byEdition: {
      "2014": {
        heal: { formula: (castLvl, spellMod) => `${castLvl}d8 + ${spellMod}` },
        flavorOnConfirm: "A touch heals 1d8 + spellcasting modifier (+1d8 per upcast).",
      },
    },
    flavorOnConfirm: "A touch heals 2d8 + spellcasting modifier (+2d8 per upcast).",
  },

  // ⚠️🔴 2024 IS 2d4 AND UPCASTS AT 2d4, NOT 1d4 AT EITHER. Straight off his
  // own copy: "regains Hit Points equal to 2d4 plus your spellcasting ability
  // modifier ... The healing increases by 2d4 for each spell slot level above
  // 1." The entry had 1d4 for both, so a 2024 cleric was healing half and
  // upcasting at half again.
  "healing word": {
    shape: "touch",  // single-target, ranged — touch-pattern picker (single-adjacent filter is bypassed by range > 5)
    range: 60,
    heal: {
      formula: (castLvl, spellMod) => `${2 * Math.max(1, castLvl)}d4 + ${spellMod}`,
    },
    picker: { allowSelf: true, preHighlightSelf: true, requiresAdjacent: false, excludeDead: false },
    byEdition: {
      "2014": {
        heal: { formula: (castLvl, spellMod) => `${castLvl}d4 + ${spellMod}` },
        flavorOnConfirm: "A word of healing restores 1d4 + spellcasting modifier (+1d4 per upcast).",
      },
    },
    flavorOnConfirm: "A word of healing restores 2d4 + spellcasting modifier (+2d4 per upcast).",
  },

  // ── Mass Cure Wounds (5th) ────────────────────────────────────────────────
  // ⚠️🔴 IT WAS A BARE PICKER, AND THAT DROPPED BOTH HALVES OF THE SPELL.
  // "Choose up to six creatures in a 30-foot-radius Sphere centered on a point
  // you choose within range" — so there is a 60-foot limit on where the wave
  // lands AND a requirement that the six be standing together. A picker enforces
  // neither: a cleric could heal six people scattered across the battlefield.
  //
  // ⚠️ THE PICK ITSELF IS RAW AND STAYS. Johnny asked whether it could be
  // automatic and answered it himself: seven allies in the sphere and only six
  // heals. Choosing is the caster's decision, and RAW says creatures rather than
  // allies, so an enemy in the sphere is offered too.
  //
  // ⚠️ THE EDITIONS DIFFER IN BOTH DICE AND SCOPE. 2014 is 3d8 and has no effect
  // on undead or constructs; 2024 is 5d8 and dropped that clause. His own copy
  // is the 2024 one, and the engine reads the item, so a 2014 caster at the same
  // table still gets 2014.
  "mass cure wounds": {
    shape: "template-heal",
    range: 60,
    expectedArea: { type: "sphere", size: 30 },
    countResolver: () => 6,
    heal: {
      // 2024 baseline. `byEdition` below carries the legacy one.
      formula: (castLvl, spellMod) => `${5 + Math.max(0, castLvl - 5)}d8 + ${spellMod}`,
      // "Each target regains Hit Points equal to 5d8 plus your modifier" — one
      // wave, one roll, applied to all of them.
      rollOnce: true,
    },
    picker: { allowSelf: true, preHighlightSelf: false, excludeDead: false },
    byEdition: {
      "2014": {
        heal: {
          formula: (castLvl, spellMod) => `${3 + Math.max(0, castLvl - 5)}d8 + ${spellMod}`,
          excludeTypes: ["undead", "construct"],
          rollOnce: true,
        },
        flavorOnConfirm: "Up to six creatures in the sphere heal 3d8 + spellcasting modifier "
          + "(+1d8 per upcast above 5th). No effect on undead or constructs.",
      },
    },
    flavorOnConfirm: "Up to six creatures in the sphere heal 5d8 + spellcasting modifier "
      + "(+1d8 per upcast above 5th).",
  },

  // ⚠️ "each of them regains hit points equal to 1d4 + your spellcasting ability
  // modifier" — one roll for the whole word, not one per creature.
  "mass healing word": {
    shape: "multi-heal",
    range: 60,
    countResolver: () => 6,  // up to 6 creatures
    heal: {
      // ⚠️🔴 2024 IS 2d4, AND THIS WAS SHIPPING 1d4 TO 2024 CASTERS: half the
      // healing, every cast. Read straight off his own copy: "regain Hit Points
      // equal to 2d4 plus your spellcasting ability modifier ... increases by
      // 1d4 for each spell slot level above 3." 2014 is the 1d4 version and is
      // kept below rather than lost.
      formula: (castLvl, spellMod) => `${2 + Math.max(0, castLvl - 3)}d4 + ${spellMod}`,
      rollOnce: true,
    },
    picker: { allowSelf: true, preHighlightSelf: false, excludeDead: false },
    byEdition: {
      "2014": {
        heal: {
          formula: (castLvl, spellMod) => `${1 + Math.max(0, castLvl - 3)}d4 + ${spellMod}`,
          rollOnce: true,
        },
        flavorOnConfirm: "Up to six creatures heal 1d4 + spellcasting modifier (+1d4 per upcast above 3rd).",
      },
    },
    flavorOnConfirm: "Up to six creatures heal 2d4 + spellcasting modifier (+1d4 per upcast above 3rd).",
  },

  "heal": {
    shape: "touch",
    range: 60,
    heal: {
      formula: (castLvl) => `${70 + (castLvl - 6) * 10}`,  // 70 HP base, +10 per upcast
    },
    picker: { allowSelf: true, preHighlightSelf: true, requiresAdjacent: false, excludeDead: false },
    flavorOnConfirm: "Channel divine energy to restore 70 HP and end blindness, deafness, and any disease (+10 HP per upcast).",
  },

  // ─── Phase 3.A additions ───

  "greater restoration": {
    shape: "touch",
    range: 5,
    heal: {
      // No HP — clears conditions. Resolver auto-clears any present from the list.
      formula: () => "0",
      clearStatuses: ["charmed", "petrified", "paralyzed", "cursed", "exhaustion", "incapacitated"],
    },
    picker: { allowSelf: true, preHighlightSelf: true, requiresAdjacent: true, excludeDead: false },
    flavorOnConfirm: "End one effect on target: exhaustion (1 level), charmed, petrified, cursed, or one reduction to ability score / max HP.",
  },

  "lesser restoration": {
    shape: "touch",
    range: 5,
    heal: {
      formula: () => "0",
      clearStatuses: ["blinded", "deafened", "paralyzed", "poisoned", "diseased"],
    },
    picker: { allowSelf: true, preHighlightSelf: true, requiresAdjacent: true, excludeDead: false },
    flavorOnConfirm: "End one disease or one condition on target: blinded, deafened, paralyzed, or poisoned.",
  },

  // v0.7.74 AUDIT FIX — Spare the Dying, Revivify, Raise Dead all had
  // `excludeDead: true` in their pickers. The picker filters `HP <= 0` —
  // which is EXACTLY the target each of these spells exists to fix. Net
  // effect: the picker showed an empty grid and the spell was uncastable
  // through the pipeline. Set excludeDead: false so the dying / dead
  // creature is actually selectable. (revivesDead / stabilizes flags still
  // drive the resolver's restore logic; HealResolver checks them.)
  // ⚠️🔴 I CALLED HIS ITEM WRONG AND IT WAS RIGHT. The audit reported ACE at
  // 5 feet against an item at 120, and I wrote "120 is not a number this spell
  // has ever had". It is. 2024 Spare the Dying is a cantrip whose range DOUBLES
  // at 5th, 11th and 17th level: 15, 30, 60, 120. Akra is a Cleric 17, so 120
  // was correct, and the several copies at different ranges across his sheets
  // were the scaling, not duplicates. I read a mess in his data that was in my
  // own head, and told him to change items that were already right.
  //
  // ⚠️ SO THE ENTRY HOLDS NO RANGE AT ALL. A spell whose reach depends on the
  // caster's level cannot be one number in a table. Omitting it makes the picker
  // read the ITEM's range, which is where the right answer already lives and
  // where it stays right as the character levels. The same is true of any
  // scaling cantrip, which is why this is not a special case for one spell.
  "spare the dying": {
    shape: "touch",
    // range: deliberately absent — read off the item. See above.
    heal: {
      formula: () => "0",
      stabilizes: true,  // Clears death saves but doesn't restore HP
    },
    picker: { allowSelf: false, preHighlightSelf: false, requiresAdjacent: true, excludeDead: false },
    flavorOnConfirm: "Stabilize a creature with 0 HP. They become stable but stay unconscious.",
  },

  "revivify": {
    shape: "touch",
    range: 5,
    heal: {
      formula: () => "1",  // Comes back at 1 HP
      revivesDead: true,   // Clears "dead" status pre-heal so HP applies
    },
    picker: { allowSelf: false, preHighlightSelf: false, requiresAdjacent: true, excludeDead: false },
    flavorOnConfirm: "Return a creature who died within the last minute to life at 1 HP. Requires diamond worth 300 gp.",
  },

  "raise dead": {
    shape: "touch",
    range: 5,
    heal: {
      // RAW: target returns with ALL hit points restored. Computing full HP here.
      // Caller can pass castLvl higher for upcast — no upcast effect on HP for this spell.
      formula: () => "999",  // Heal everything; resolver caps at maxHP
      revivesDead: true,
    },
    picker: { allowSelf: false, preHighlightSelf: false, requiresAdjacent: true, excludeDead: false },
    flavorOnConfirm: "Return a creature dead up to 10 days to life with all HP restored. They have -4 penalty to attacks/saves/checks for 4 long rests.",
  },

  // Same spell under another name; the same one-roll rule applies.
  "healing word group": {
    aliases: ["mass healing word group"],
    shape: "multi-heal",
    range: 60,
    countResolver: () => 6,
    heal: {
      formula: (castLvl, spellMod) => `${2 + Math.max(0, castLvl - 3)}d4 + ${spellMod}`,
      rollOnce: true,
    },
    picker: { allowSelf: true, preHighlightSelf: false, excludeDead: false },
    byEdition: {
      "2014": {
        heal: {
          formula: (castLvl, spellMod) => `${1 + Math.max(0, castLvl - 3)}d4 + ${spellMod}`,
          rollOnce: true,
        },
        flavorOnConfirm: "Up to six creatures heal 1d4 + spellcasting modifier (+1d4 per upcast).",
      },
    },
    flavorOnConfirm: "Up to six creatures heal 2d4 + spellcasting modifier (+1d4 per upcast above 3rd).",
  },
};

