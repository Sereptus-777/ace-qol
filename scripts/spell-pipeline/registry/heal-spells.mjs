// ─── ACE: QOL — Spell Registry: Heal Shapes (touch + multi-heal) ─────────────
// Cure Wounds (touch), Healing Word (single, ranged), Mass Cure Wounds (multi),
// Mass Healing Word (multi), Heal (single).
//
// formula is a function (castLvl, spellMod) → dice string. Caller (HealResolver)
// rolls per target, applies HP. Most heal spells RAW are per-target rolls (each
// target gets their own dice).
// ──────────────────────────────────────────────────────────────────────────────

export const HEAL_SPELLS = {

  "cure wounds": {
    shape: "touch",
    range: 5,
    heal: {
      formula: (castLvl, spellMod) => `${castLvl}d8 + ${spellMod}`,
    },
    picker: { allowSelf: true, preHighlightSelf: true, requiresAdjacent: true, excludeDead: false },
    flavorOnConfirm: "A touch heals 1d8 + spellcasting modifier (+1d8 per upcast).",
  },

  "healing word": {
    shape: "touch",  // single-target, ranged — touch-pattern picker (single-adjacent filter is bypassed by range > 5)
    range: 60,
    heal: {
      formula: (castLvl, spellMod) => `${castLvl}d4 + ${spellMod}`,
    },
    picker: { allowSelf: true, preHighlightSelf: true, requiresAdjacent: false, excludeDead: false },
    flavorOnConfirm: "A word of healing restores 1d4 + spellcasting modifier (+1d4 per upcast).",
  },

  "mass cure wounds": {
    shape: "multi-heal",
    range: 60,
    countResolver: () => 6,  // up to 6 creatures within 30ft of point
    heal: {
      formula: (castLvl, spellMod) => `${3 + Math.max(0, castLvl - 5)}d8 + ${spellMod}`,
    },
    picker: { allowSelf: true, preHighlightSelf: false, excludeDead: false },
    flavorOnConfirm: "Up to six creatures heal 3d8 + spellcasting modifier (+1d8 per upcast above 5th).",
  },

  "mass healing word": {
    shape: "multi-heal",
    range: 60,
    countResolver: () => 6,  // up to 6 creatures
    heal: {
      formula: (castLvl, spellMod) => `${1 + Math.max(0, castLvl - 3)}d4 + ${spellMod}`,
    },
    picker: { allowSelf: true, preHighlightSelf: false, excludeDead: false },
    flavorOnConfirm: "Up to six creatures heal 1d4 + spellcasting modifier (+1d4 per upcast above 3rd).",
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
      // No HP — clears one condition. Use 0d0 formula for "no heal" + chat-card explains.
      formula: () => "0",
    },
    picker: { allowSelf: true, preHighlightSelf: true, requiresAdjacent: true, excludeDead: false },
    flavorOnConfirm: "End one effect on target: exhaustion (1 level), charmed, petrified, cursed, or one reduction to ability score / max HP.",
  },

  "lesser restoration": {
    shape: "touch",
    range: 5,
    heal: {
      formula: () => "0",
    },
    picker: { allowSelf: true, preHighlightSelf: true, requiresAdjacent: true, excludeDead: false },
    flavorOnConfirm: "End one disease or one condition on target: blinded, deafened, paralyzed, or poisoned.",
  },

  "spare the dying": {
    shape: "touch",
    range: 5,
    heal: {
      formula: () => "0",  // Stabilizes — no HP healed
    },
    picker: { allowSelf: false, preHighlightSelf: false, requiresAdjacent: true, excludeDead: true },
    flavorOnConfirm: "Stabilize a creature with 0 HP. They become stable but stay unconscious.",
  },

  "revivify": {
    shape: "touch",
    range: 5,
    heal: {
      formula: () => "1",  // Comes back at 1 HP
    },
    picker: { allowSelf: false, preHighlightSelf: false, requiresAdjacent: true, excludeDead: true },
    flavorOnConfirm: "Return a creature who died within the last minute to life at 1 HP. Requires diamond worth 300 gp.",
  },

  "raise dead": {
    shape: "touch",
    range: 5,
    heal: {
      formula: (castLvl, spellMod) => `${castLvl * 4 + spellMod}`,  // approximation; actually returns with all HP but takes 10 days
    },
    picker: { allowSelf: false, preHighlightSelf: false, requiresAdjacent: true, excludeDead: true },
    flavorOnConfirm: "Return a creature dead up to 10 days to life. They have -4 penalty to attacks/saves/checks for several days.",
  },

  "healing word group": {
    aliases: ["mass healing word group"],
    shape: "multi-heal",
    range: 60,
    countResolver: () => 6,
    heal: {
      formula: (castLvl, spellMod) => `${1 + Math.max(0, castLvl - 3)}d4 + ${spellMod}`,
    },
    picker: { allowSelf: true, preHighlightSelf: false, excludeDead: false },
    flavorOnConfirm: "Up to six creatures heal 1d4 + spellcasting modifier (+1d4 per upcast).",
  },
};

