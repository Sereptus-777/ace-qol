/* ─── THE AMBER TEMPLE'S DARK GIFTS, AS ITEMS ─────────────────────────────────
 *
 * Every gift your world's own journal names (the sarcophagus handouts), built
 * as a supernatural gift item in an Items folder called "Dark Gifts". Drag one
 * onto a character and the power and the price both apply.
 *
 * The twenty entries below are the gifts in Handout 41-02 Sarcophagus 1-6,
 * 41-03 Sarcophagus 1-9 and 41-04 Sarcophagus 1, 3, 5, 6 and Vampyr. 41-04
 * Sarcophagus 2 is the shattered one and offers nothing. There is no 41-04
 * Sarcophagus 4 page in your world.
 *
 * ⚠️ MECHANICS ONLY. This repository is public and the book's own sentences
 * (each power, each price, each flaw) are Curse of Strahd's text, so they are
 * not in this file (2026-10-11). Each item carries the rule in plain terms and
 * points at the handout in the world, which has the words.
 *
 * Run it as often as you like: it updates the items in place by name rather
 * than making a second set.
 * ────────────────────────────────────────────────────────────────────────── */
(async () => {
  if (!game.user.isGM) return ui.notifications.warn("ACE: dark gifts are a GM build.");
  const NS = "ace-qol";
  const M = CONST.ACTIVE_EFFECT_MODES;
  const DAY = 86400;
  const ICON = "icons/magic/unholy/";

  // ── The folder ─────────────────────────────────────────────────────────────
  let folder = game.folders.find(f => f.type === "Item" && f.name === "Dark Gifts");
  if (!folder) folder = await Folder.create({ name: "Dark Gifts", type: "Item", color: "#5b2d8e" });

  // ── A spell, found by name in whatever books you have ──────────────────────
  // ⚠️ NAMED, NOT ASSUMED. A hard-coded compendium id that is not installed is a
  // dead button; this looks the spell up and says so when it cannot find one.
  const packs = game.packs.filter(p => p.documentName === "Item")
    .sort((a, b) => (b.metadata.id.startsWith("dnd5e") ? 1 : 0) - (a.metadata.id.startsWith("dnd5e") ? 1 : 0));
  const missing = [];
  const findSpell = async (name) => {
    const want = name.toLowerCase();
    const world = game.items.find(i => i.type === "spell" && i.name.toLowerCase() === want);
    if (world) return world.uuid;
    for (const pack of packs) {
      try {
        const idx = await pack.getIndex({ fields: ["type"] });
        const hit = idx.find(e => e.type === "spell" && String(e.name).toLowerCase() === want);
        if (hit) return hit.uuid ?? `Compendium.${pack.collection}.Item.${hit._id}`;
      } catch (_) { /* a pack that will not index is not an answer */ }
    }
    missing.push(name);
    return null;
  };

  const fx = (name, img, changes, seconds = null, description = "") => ({
    name, img, changes, transfer: true, disabled: false,
    description, duration: seconds ? { seconds } : {},
    flags: { [NS]: { darkGiftEffect: true } },
  });
  const ch = (key, mode, value, priority = 20) => ({ key, mode, value, priority });

  // ── The gifts, in sarcophagus order ───────────────────────────────────────
  const GIFTS = [
    { from: "41-02 / 1", vestige: "Vaund the Evasive", img: `${ICON}silhouette-evil-horned.webp`,
      rule: "Evasion, and the benefits of an amulet of proof against detection and location. 10 days.",
      days: 10,
      effects: [["Evasion — Vaund's Gift", `${ICON}silhouette-evil-horned.webp`,
        [ch("flags.ace-qol.superSaver.dex", M.OVERRIDE, "1")], 10 * DAY,
        "A made Dexterity saving throw takes no damage; a failed one takes half."]],
      manual: ["Proof against detection and location is no field on a sheet: divination and location magic that targets them simply fails, which is yours to rule."] },

    { from: "41-02 / 2", vestige: "Norganas, the Finger of Oblivion", img: `${ICON}hand-fire-skeleton-pink.webp`,
      cost: "When the gift ends: DC 15 Constitution save or drop to 0 hit points.",
      rule: "Finger of death, as an action, 3 uses.",
      uses: 3, spell: "Finger of Death",
      manual: ["The Constitution save when the third use is spent is yours to call for: nothing here will roll it."] },

    { from: "41-02 / 3", vestige: "Seriach, the Hell Hound Whisperer", img: "icons/creatures/abilities/wolf-howl-moon-purple.webp",
      rule: "Summon two hell hounds under the bearer's control, as an action, 1 use; the gift ends when both die. Speaks Infernal.",
      uses: 1,
      effects: [["Infernal — Seriach's Gift", "icons/creatures/abilities/wolf-howl-moon-purple.webp",
        [ch("system.traits.languages.value", M.ADD, "infernal")], null,
        "Speaks and understands Infernal. The hounds understand nothing else."]],
      manual: ["Putting the two hell hounds on the board is yours: drop them and give them to the player."] },

    { from: "41-02 / 4", vestige: "Great Taar Haak, the Five-Headed Destroyer", img: "icons/magic/control/buff-strength-muscle-damage-red.webp",
      rule: "Strength 25 (as a belt of fire giant strength). 10 days.",
      days: 10,
      effects: [["Fire Giant Strength — Taar Haak's Gift", "icons/magic/control/buff-strength-muscle-damage-red.webp",
        [ch("system.abilities.str.value", M.UPGRADE, "25")], 10 * DAY,
        "Strength 25 while the gift lasts. It never lowers a higher score."]] },

    { from: "41-02 / 5", vestige: "Yrrga, the Eye of Shadows", img: "icons/magic/perception/eye-ringed-glow-angry-purple.webp",
      rule: "Truesight 60 feet. 30 days.",
      days: 30,
      effects: [["Truesight 60 — Yrrga's Gift", "icons/magic/perception/eye-ringed-glow-angry-purple.webp",
        [ch("system.attributes.senses.ranges.truesight", M.UPGRADE, "60"),
         ch("system.attributes.senses.truesight", M.UPGRADE, "60")], 30 * DAY,
        "Truesight 60 feet. Both field names are written because 5.3 moved it, and it never lowers a longer range."]] },

    { from: "41-02 / 6", vestige: "Yog the Invincible", img: "icons/magic/life/heart-cross-strong-flame-purple-orange.webp",
      rule: "Hit point maximum +30. 10 days.",
      days: 10,
      effects: [["+30 Hit Points — Yog's Gift", "icons/magic/life/heart-cross-strong-flame-purple-orange.webp",
        [ch("system.attributes.hp.bonuses.overall", M.ADD, "30")], 10 * DAY,
        "Maximum hit points +30 while the gift lasts."]] },

    { from: "41-03 / 1", vestige: "Drizlash, the Nine-Eyed Spider", img: "icons/creatures/invertebrates/spider-web-black.webp",
      rule: "Climb speed equal to walking speed, no check, ceilings included.",
      effects: [["Wall Walker — Drizlash's Gift", "icons/creatures/invertebrates/spider-web-black.webp",
        [ch("system.attributes.movement.climb", M.OVERRIDE, "@attributes.movement.walk")], null,
        "Climbs at its walking speed, no check, ceilings included."]] },

    { from: "41-03 / 2", vestige: "Dahlver-Nar, He of the Many Teeth", img: "icons/magic/death/skull-horned-goat-pentagram-red.webp",
      rule: "On death, the bearer reincarnates (as reincarnate) within 10 feet, 3 uses.",
      uses: 3,
      manual: ["The reincarnation itself is yours to run: nothing here watches for the death or builds the new body."] },

    { from: "41-03 / 3", vestige: "Zantras, the Kingmaker", img: "icons/equipment/head/crown-gold-blue.webp",
      rule: "Charisma +4, to a maximum of 22.",
      effects: [["Charisma +4 — Zantras's Gift", "icons/equipment/head/crown-gold-blue.webp",
        [ch("system.abilities.cha.value", M.ADD, "4"), ch("system.abilities.cha.max", M.UPGRADE, "22")], null,
        "Charisma +4, capped at 22 by the score's own maximum."]] },

    { from: "41-03 / 4", vestige: "Shami-Amourae, the Lady of Delights", img: "icons/magic/control/hypnosis-mesmerism-pink.webp",
      rule: "Suggestion, as an action, 3 uses; the target saves at disadvantage.",
      uses: 3, spell: "Suggestion",
      flags: { saveDisadvantage: true },
      manual: ["The disadvantage on the save is on the item and in its words; ACE does not yet bend another creature's save off a gift, so apply it on the roll."] },

    { from: "41-03 / 5", vestige: "Tarakamedes, the Grave Wyrm", img: "icons/creatures/abilities/wing-bat-leather-purple.webp",
      cost: "A pound of bone or grave soil each day; a day without it means death at the next dawn.",
      rule: "Flying speed 50 feet.",
      effects: [["Skeletal Wings — Tarakamedes's Gift", "icons/creatures/abilities/wing-bat-leather-purple.webp",
        [ch("system.attributes.movement.fly", M.UPGRADE, "50")], null,
        "Flying speed 50 feet. ACE asks for an elevation when the gift is used."]],
      manual: ["The bone hunger is not automated: a dawn hook that kills a player character on a bug is not something to ship unseen."] },

    { from: "41-03 / 6", vestige: "Savnok the Inscrutable", img: "icons/magic/perception/third-eye-blue-red.webp",
      cost: "Cannot be blinded.",
      rule: "Mind blank on the bearer, 1 year.",
      days: 365,
      effects: [["Mind Blank — Savnok's Gift", "icons/magic/perception/third-eye-blue-red.webp",
        [ch("system.traits.di.value", M.ADD, "psychic"), ch("system.traits.ci.value", M.ADD, "charmed")],
        365 * DAY, "Immune to psychic damage and to being charmed. Divination cannot find or read them."],
       ["Hollow Sockets — Savnok's Price", "icons/magic/perception/third-eye-blue-red.webp",
        [ch("system.traits.ci.value", M.ADD, "blinded")], null,
        "The eyes are gone and still see. Nothing can blind what is not there."]] },

    { from: "41-03 / 7", vestige: "Fekre, Queen of Poxes", img: "icons/magic/death/hand-withered-gray.webp",
      rule: "Contagion, as an action, 3 uses.",
      uses: 3, spell: "Contagion" },

    { from: "41-03 / 8", vestige: "Sykane, the Soul Hungerer", img: "icons/magic/death/hand-undead-skeleton-fire-green.webp",
      rule: "Raise dead, as an action, 3 uses.",
      uses: 3, spell: "Raise Dead" },

    { from: "41-03 / 9", vestige: "Zrin-Hala, the Howling Storm", img: "icons/magic/lightning/bolt-strike-blue.webp",
      rule: "Lightning bolt, as an action, 3 uses.",
      uses: 3, spell: "Lightning Bolt" },

    { from: "41-04 / 1", vestige: "Delban, the Star of Ice and Hate", img: "icons/magic/water/snowflake-ice-blue-white.webp",
      rule: "Cone of cold, as an action, 7 uses; the benefits of a ring of warmth until the gift ends.",
      uses: 7, spell: "Cone of Cold",
      effects: [["Ring of Warmth — Delban's Gift", "icons/magic/water/snowflake-ice-blue-white.webp",
        [ch("system.traits.dr.value", M.ADD, "cold")], null,
        "Resistance to cold damage, and the bearer suffers no harm from temperatures down to -50 degrees."]] },

    { from: "41-04 / 3", vestige: "Khirad, the Star of Secrets", img: "icons/magic/perception/orb-crystal-ball-scrying-blue.webp",
      rule: "Scrying, as an action, 3 uses.",
      uses: 3, spell: "Scrying" },

    { from: "41-04 / 5", vestige: "Tenebrous", img: "icons/magic/death/skull-horned-worn-fire-blue.webp",
      cost: "Phylactery 10 days, potion 3 days, not at the same time. The new lich is the GM's.",
      rule: "Lichdom: an evil humanoid able to cast 9th-level wizard spells learns to make a phylactery and the potion that completes the change.",
      manual: ["Nothing here checks the alignment or the 9th-level spells, and nothing turns anybody into a lich. This item is the knowledge and the clock."] },

    { from: "41-04 / 6", vestige: "Zhudun, the Corpse Star", img: "icons/magic/death/hand-dirt-undead-zombie.webp",
      rule: "Resurrection by touch, as an action, 1 use, however old the remains.",
      uses: 1, spell: "Resurrection",
      manual: ["The spell's own time limit does not apply to this gift, so the cast will not refuse an ancient corpse. Ignore what the spell's words say about a decade."] },

    { from: "41-04 / Vampyr", vestige: "the Vampyr", img: "icons/magic/death/mouth-bite-fangs-vampire-red.webp",
      cost: "The new vampire is the GM's.",
      rule: "Vampirism, for an evil humanoid, once two conditions the GM reveals after acceptance are both met.",
      manual: ["Neither condition is watched for and nothing turns them into a vampire. This item is the bargain, written down where the player can see it."] },
  ];

  // ── Build ─────────────────────────────────────────────────────────────────
  const made = [];
  const updated = [];
  for (const g of GIFTS) {
    const name = `Dark Gift of ${g.vestige}`;
    const bits = [`<p><em>${g.rule}</em></p>`];
    if (g.cost) bits.push(`<p><strong>The price.</strong> ${g.cost}</p>`);
    if (g.days) bits.push(`<p><strong>It lasts ${g.days === 365 ? "a year" : `${g.days} days`}</strong>, then the gift vanishes.</p>`);
    if (g.uses) bits.push(`<p><strong>${g.uses} use${g.uses === 1 ? "" : "s"}</strong>, then the gift vanishes.</p>`);
    for (const m of (g.manual ?? [])) bits.push(`<p class="ace-gift-gm"><em>GM: ${m}</em></p>`);
    bits.push(`<p style="opacity:.7"><em>Amber Temple, sarcophagus ${g.from}. The handout has the gift's own words, its price and any flaw.</em></p>`);

    const data = {
      name, type: "feat", img: g.img, folder: folder.id,
      system: {
        type: { value: "supernaturalGift", subtype: "charm" },
        description: { value: bits.join("\n") },
        ...(g.uses ? { uses: { spent: 0, max: String(g.uses), recovery: [] } } : {}),
      },
      effects: (g.effects ?? []).map(e => fx(e[0], e[1], e[2], e[3] ?? null, e[4] ?? "")),
      flags: { [NS]: { darkGift: { vestige: g.vestige, sarcophagus: g.from,
        days: g.days ?? null, uses: g.uses ?? null, ...(g.flags ?? {}) } } },
    };

    if (g.spell) {
      const uuid = await findSpell(g.spell);
      if (uuid) {
        const id = foundry.utils.randomID();
        data.system.activities = { [id]: {
          _id: id, type: "cast", name: `Cast ${g.spell}`,
          activation: { type: "action", value: 1 },
          consumption: { targets: [{ type: "itemUses", target: "", value: "1",
            scaling: { mode: "", formula: "" } }], scaling: { allowed: false, max: "" } },
          spell: { uuid, spellbook: true },
        } };
      }
    }

    const existing = game.items.find(i => i.name === name && i.folder?.id === folder.id);
    if (existing) { await existing.update(data, { diff: false, recursive: false }); updated.push(name); }
    else { await Item.create(data); made.push(name); }
  }

  // ── Say what happened, all of it ──────────────────────────────────────────
  console.log(`%cACE | The Amber Temple's dark gifts`, "font-weight:700;font-size:14px");
  console.log(`  Folder: Items / ${folder.name}`);
  console.log(`  Created: ${made.length}`, made);
  console.log(`  Updated in place: ${updated.length}`, updated);
  if (missing.length) {
    console.warn(`  SPELLS NOT FOUND in any book you have, so those gifts have no cast button `
      + `(their words still carry the rule): ${[...new Set(missing)].join(", ")}`);
  } else {
    console.log("  Every spell a gift casts was found and wired to a cast button.");
  }
  console.log("  Gifts whose power is yours to run by hand are marked GM: in their own description.");
  ui.notifications.info(`ACE: ${made.length} dark gift(s) created, ${updated.length} updated, in Items / Dark Gifts.`
    + (missing.length ? ` ${new Set(missing).size} spell(s) not found; see the console.` : ""));
})();
