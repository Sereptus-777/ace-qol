// ─── ACE: QOL — Spell Registry: Self Shape ────────────────────────────────────
// No picker — effect applies to caster directly via ConditionLibrary.applyEffect.
// Effect keys come from condition-library.mjs (or extended-effects).
// ──────────────────────────────────────────────────────────────────────────────

export const SELF_SPELLS = {

  // Migrated from the legacy SPELL_AUTO_APPLY table (2026-06-25). Fire Shield is
  // self-only; its melee retaliation is read from the effect's description by
  // RetaliationEngine on each hit. No 2014/2024 split. Pipeline now owns it.
  "fire shield": {
    shape: "self",
    range: 0,
    effect: { key: "fire_shield", duration: { rounds: 100 } },  // 10 minutes
    flavorOnConfirm: "Flames wreathe you for 10 minutes — you gain resistance to cold or fire, and a creature within 5 ft that hits you in melee takes 2d8 of the opposite damage.",
  },

  // ── Smite spells (migrated from SPELL_AUTO_APPLY 2026-06-25) ──────────────────
  // Cast applies the named concentration buff to the CASTER; the rider-engine
  // detects it and offers the discharge on the next melee weapon hit (the existing,
  // proven smite flow). Behaviour-preserving vs the legacy table — same effect keys.
  // Durations are 2014 (concentration); the 2024 non-concentration variants are a
  // separate edition-aware pass on the condition-library defs themselves.
  "searing smite": {
    shape: "self", range: 0,
    effect: { key: "searing_smite", duration: "concentration" },
    // 2024: smites are no longer concentration — flat 1-minute duration.
    byEdition: { modern: { effect: { key: "searing_smite", duration: { minutes: 1 } } } },
    flavorOnConfirm: "Your weapon flares white-hot — your next hit deals +1d6 fire and sets the target alight (1d6 fire at the start of each of its turns; CON save to end).",
  },
  "wrathful smite": {
    shape: "self", range: 0,
    effect: { key: "wrathful_smite", duration: "concentration" },
    // 2024: smites are no longer concentration — flat 1-minute duration.
    byEdition: { modern: { effect: { key: "wrathful_smite", duration: { minutes: 1 } } } },
    flavorOnConfirm: "Your weapon thrums with dark energy — your next hit deals +1d6 psychic and frightens the target (WIS save to end).",
  },
  "thunderous smite": {
    shape: "self", range: 0,
    effect: { key: "thunderous_smite", duration: "concentration" },
    // 2024: smites are no longer concentration — flat 1-minute duration.
    byEdition: { modern: { effect: { key: "thunderous_smite", duration: { minutes: 1 } } } },
    flavorOnConfirm: "Your weapon rings with thunder — your next hit deals +2d6 thunder; the target makes a STR save or is pushed 10 ft and knocked prone.",
  },
  "blinding smite": {
    shape: "self", range: 0,
    effect: { key: "blinding_smite", duration: "concentration" },
    // 2024: smites are no longer concentration — flat 1-minute duration.
    byEdition: { modern: { effect: { key: "blinding_smite", duration: { minutes: 1 } } } },
    flavorOnConfirm: "Your weapon blazes with light — your next hit deals +3d8 radiant and blinds the target (CON save each turn to end).",
  },
  "staggering smite": {
    shape: "self", range: 0,
    effect: { key: "staggering_smite", duration: "concentration" },
    // 2024: smites are no longer concentration — flat 1-minute duration.
    byEdition: { modern: { effect: { key: "staggering_smite", duration: { minutes: 1 } } } },
    flavorOnConfirm: "Your weapon disrupts mind and body — your next hit deals +4d6 psychic; on a failed WIS save the target has disadvantage on attacks and ability checks until your next turn.",
  },
  "banishing smite": {
    shape: "self", range: 0,
    effect: { key: "banishing_smite", duration: "concentration" },
    // 2024: smites are no longer concentration — flat 1-minute duration.
    byEdition: { modern: { effect: { key: "banishing_smite", duration: { minutes: 1 } } } },
    flavorOnConfirm: "Your weapon crackles with force — your next hit deals +5d10 force; if it drops the target to 50 HP or fewer, the target is banished.",
  },

  // Divine Favor — self buff. 2014 concentration (2024 no-concentration = separate
  // def edition pass). Migrated from SPELL_AUTO_APPLY 2026-06-25.
  "divine favor": {
    shape: "self", range: 0,
    effect: { key: "divine_favor", duration: "concentration" },
    // 2024: Divine Favor is no longer concentration — flat 1-minute duration.
    byEdition: { modern: { effect: { key: "divine_favor", duration: { minutes: 1 } } } },
    flavorOnConfirm: "Your weapon shines with divine radiance — your weapon hits deal an extra 1d4 radiant damage.",
  },

  "mage armor": {
    shape: "self",
    range: 0,
    effect: { key: "mage_armor", duration: { minutes: 480 } },  // 8 hours
    flavorOnConfirm: "A protective magical force surrounds you, granting AC 13 + Dex mod.",
  },

  "shield": {
    shape: "self",
    range: 0,
    effect: { key: "shield", duration: { rounds: 1 } },  // until start of next turn
    flavorOnConfirm: "An invisible barrier of magical force snaps into place — +5 AC and immunity to magic missile until your next turn.",
  },

  "mirror image": {
    shape: "self",
    range: 0,
    effect: { key: "mirror_image", duration: { minutes: 1 } },  // 1 minute
    flavorOnConfirm: "Three illusory duplicates of yourself appear in your space.",
  },

  // v0.7.74 — Stoneskin RAW is "touch a willing creature." Moved from
  // self-shape (caster only) to multi-buff/touch so the cleric / wizard can
  // cast it on the party tank as RAW intends. Pre-highlight self for the
  // common case where the caster does target themselves.
  "stoneskin": {
    shape: "multi-buff",
    range: 5,
    countResolver: () => 1,
    effect: { key: "stoneskin", duration: { hours: 1 } },
    picker: { allowSelf: true, preHighlightSelf: true, requiresAdjacent: true, excludeDead: true },
    flavorOnConfirm: "A willing creature you touch gains resistance to nonmagical bludgeoning, piercing, and slashing damage.",
  },

  "blur": {
    shape: "self",
    range: 0,
    effect: { key: "blur", duration: { minutes: 1 } },
    flavorOnConfirm: "Your body becomes blurred and indistinct — attackers have disadvantage against you.",
  },

  // v0.7.74 — Greater Invisibility RAW is "touch a creature" — wizard
  // commonly casts it on the rogue / striker, not always self. Moved.
  "greater invisibility": {
    shape: "multi-buff",
    range: 5,
    countResolver: () => 1,
    // duration MUST be the "concentration" signal (not a fixed {minutes:1}) or the
    // buff resolver never wires the concentration link → the invisibility never
    // ends when the caster drops concentration. (Audit 2026-06-27, P0.)
    effect: { key: "greater_invisibility", duration: "concentration" },
    picker: { allowSelf: true, preHighlightSelf: true, requiresAdjacent: true, excludeDead: true },
    flavorOnConfirm: "A creature you touch becomes invisible and remains so even when it attacks or casts spells.",
  },

  // v0.7.74 — Foresight RAW is "touch a willing creature." 9th-level slot
  // almost never goes on the caster themselves — it's the iconic "buff your
  // melee god" spell. Was self-only, now touch single. (flavor text
  // updated to match the new semantics; previously inconsistent.)
  "foresight": {
    shape: "multi-buff",
    range: 5,
    countResolver: () => 1,
    effect: { key: "foresight", duration: { minutes: 480 } },  // 8 hours
    picker: { allowSelf: true, preHighlightSelf: false, requiresAdjacent: true, excludeDead: true },
    flavorOnConfirm: "You touch a willing creature, granting them advantage on attack rolls, ability checks, and saves; attackers have disadvantage against them.",
  },

  "fly": {
    // ⚠️ WAS shape:"self" — you could not Fly the fighter (Grok 2026-08-18).
    // RAW, both editions: "You touch a willing creature. The target gains a
    // flying speed of 60 feet for the duration. When you cast this spell using
    // a spell slot of 4th level or higher, you can target one additional
    // creature for each slot level above 3rd."
    //
    // Self-only made it a personal mobility spell, which is not what it is and
    // not why anyone prepares it — the whole point is getting the melee out of
    // a pit or over a chasm. Same touch-buff pattern as Foresight above.
    shape: "multi-buff",
    range: 5,
    countResolver: (castLevel) => 1 + Math.max(0, (Number(castLevel) || 3) - 3),
    effect: { key: "fly", duration: { minutes: 10 } },
    picker: { allowSelf: true, preHighlightSelf: true, requiresAdjacent: true, excludeDead: true },
    flavorOnConfirm: "You touch a willing creature, granting it a flying speed of 60 feet for the duration.",
  },

  // ─── Phase 3.A additions — utility / movement / cantrip self-buffs ───

  "true strike": {
    // ⚠️ TWO COMPLETELY DIFFERENT SPELLS SHARING A NAME (Grok 2026-08-18).
    // The old entry — shape:"self", a flag on the caster — matched NEITHER.
    //
    //   2014: a targeting cantrip. You point at a creature; on your NEXT turn
    //         you have advantage on your FIRST attack roll against THAT
    //         creature. Concentration, 1 round. The target matters — advantage
    //         against the goblin is worthless if you swing at the ogre — and
    //         the old self-flag recorded no target at all.
    //
    //   2024: not a buff in any sense. It IS an attack: you make a weapon
    //         attack using your spellcasting ability, with bonus radiant
    //         damage scaling at 5/11/17. dnd5e resolves that natively through
    //         its own attack activity.
    //
    // So 2024 is deliberately NOT registered as a pipeline shape — automating
    // it would mean applying a phantom buff on top of an attack the system
    // already runs correctly. Doing nothing is the correct behaviour, and the
    // pipeline only claims spells it can actually resolve.
    shape: "attack-single",
    range: 5,
    flavorOnConfirm: "You attack with the weapon you are holding, using your spellcasting ability, adding radiant damage on a hit.",
    byEdition: {
      legacy: {
        // 2014: mark the TARGET so the advantage is against that creature.
        shape: "multi-buff",
        range: 30,
        countResolver: () => 1,
        effect: { key: "true_strike", duration: { rounds: 1 } },
        picker: { allowSelf: false, excludeDead: true },
        flavorOnConfirm: "You point at a creature. On your next turn you have advantage on your first attack roll against it.",
      },
    },
  },

  "detect magic": {
    shape: "self",
    range: 0,
    effect: { key: "detect_magic", duration: { minutes: 10 } },
    flavorOnConfirm: "You sense the presence of magic within 30 feet.",
  },

  "detect evil and good": {
    shape: "self",
    range: 0,
    effect: { key: "detect_evil_and_good", duration: { minutes: 10 } },
    flavorOnConfirm: "You know if any aberration, celestial, elemental, fey, fiend, or undead is within 30 feet.",
  },

  "see invisibility": {
    shape: "self",
    range: 0,
    effect: { key: "see_invisibility", duration: { hours: 1 } },
    flavorOnConfirm: "You see invisible creatures and objects as if they were visible.",
  },

  "comprehend languages": {
    shape: "self",
    range: 0,
    effect: { key: "comprehend_languages", duration: { hours: 1 } },
    flavorOnConfirm: "You understand the literal meaning of any spoken language you hear.",
  },

  "disguise self": {
    shape: "self",
    range: 0,
    effect: { key: "disguise_self", duration: { hours: 1 } },
    flavorOnConfirm: "Your appearance changes — equipment, voice, and physical form alter to fit your wishes.",
  },

  "longstrider": {
    shape: "self",
    range: 5,
    effect: { key: "longstrider", duration: { hours: 1 } },
    flavorOnConfirm: "Your speed increases by 10 feet for the duration.",
  },

  "spider climb": {
    shape: "self",
    range: 5,
    effect: { key: "spider_climb", duration: { hours: 1 } },
    flavorOnConfirm: "You gain a climbing speed equal to your walking speed and can climb difficult surfaces.",
  },

  "misty step": {
    shape: "self",
    range: 30,
    effect: { key: "misty_step", duration: "instantaneous" },
    flavorOnConfirm: "You teleport up to 30 feet to an unoccupied space you can see.",
  },

  "dimension door": {
    shape: "self",
    range: 500,
    effect: { key: "dimension_door", duration: "instantaneous" },
    flavorOnConfirm: "You teleport up to 500 feet to a location you can describe.",
  },

  // v0.7.74 — Death Ward RAW is "touch a creature." This is THE canonical
  // "save your tank" spell — almost never self-cast. Was routing through
  // SelfResolver which dumped it on the cleric instead of the fighter
  // they were trying to ward. Moved to touch single.
  "death ward": {
    shape: "multi-buff",
    range: 5,
    countResolver: () => 1,
    effect: { key: "death_ward", duration: { hours: 8 } },
    picker: { allowSelf: true, preHighlightSelf: false, requiresAdjacent: true, excludeDead: true },
    flavorOnConfirm: "A creature you touch is warded — the next time it would drop to 0 HP it drops to 1 HP instead. Spell ends after triggering.",
  },

  // v0.7.74 — Mind Blank RAW is "touch a willing creature." Iconic anti-
  // scrying buff cast on the party diplomat / mage, not the caster.
  // Moved from self-only to touch single.
  "mind blank": {
    shape: "multi-buff",
    range: 5,
    countResolver: () => 1,
    effect: { key: "mind_blank", duration: { hours: 24 } },
    picker: { allowSelf: true, preHighlightSelf: false, requiresAdjacent: true, excludeDead: true },
    flavorOnConfirm: "A willing creature becomes immune to psychic damage, charmed, and all attempts to read their thoughts or locate them.",
  },

  "etherealness": {
    shape: "self",
    range: 0,
    effect: { key: "etherealness", duration: { hours: 8 } },
    flavorOnConfirm: "You step into the Ethereal Plane and can move freely through solid objects.",
  },

  "time stop": {
    shape: "self",
    range: 0,
    effect: { key: "time_stop", duration: { rounds: 5 } },
    flavorOnConfirm: "You take 1d4+1 additional turns in a row. Spells affecting others end the effect early.",
  },
};

