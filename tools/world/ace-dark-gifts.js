/* ─── THE AMBER TEMPLE'S DARK GIFTS, AS ITEMS ─────────────────────────────────
 *
 * Every gift your world's own journal names (the sarcophagus handouts), built
 * as a supernatural gift item in an Items folder called "Dark Gifts". Drag one
 * onto a character and the power and the price both apply.
 *
 * Read from YOUR data, not from memory of the book: the twenty entries below
 * come from Handout 41-02 Sarcophagus 1-6, 41-03 Sarcophagus 1-9 and 41-04
 * Sarcophagus 1, 3, 5, 6 and Vampyr. 41-04 Sarcophagus 2 is the shattered one
 * and offers nothing. There is no 41-04 Sarcophagus 4 page in your world.
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
      power: "The power of evasion. While it lasts, the bearer carries an amulet of proof against detection and location and a ring of evasion: a made Dexterity save takes nothing at all.",
      price: "The bearer becomes twitchy and nervous.",
      flaw: "I can't give a straight answer to any question put to me.",
      days: 10,
      effects: [["Evasion — Vaund's Gift", `${ICON}silhouette-evil-horned.webp`,
        [ch("flags.ace-qol.superSaver.dex", M.OVERRIDE, "1")], 10 * DAY,
        "A made Dexterity saving throw takes no damage; a failed one takes half."]],
      manual: ["Proof against detection and location is no field on a sheet: divination and location magic that targets them simply fails, which is yours to rule."] },

    { from: "41-02 / 2", vestige: "Norganas, the Finger of Oblivion", img: `${ICON}hand-fire-skeleton-pink.webp`,
      power: "The power to turn life into undeath. Finger of death, as an action, three times.",
      price: "The bearer's blood turns pitch black and viscid, like tar. When the gift vanishes, a DC 15 Constitution saving throw or they drop to 0 hit points.",
      uses: 3, spell: "Finger of Death",
      manual: ["The Constitution save when the third use is spent is yours to call for: nothing here will roll it."] },

    { from: "41-02 / 3", vestige: "Seriach, the Hell Hound Whisperer", img: "icons/creatures/abilities/wolf-howl-moon-purple.webp",
      power: "The power to summon and control hell hounds. As an action, two hell hounds, once, and the gift vanishes when they die. The bearer speaks and understands Infernal.",
      price: "Sulfurous smoke issues from the bearer's pores whenever they speak Infernal.",
      uses: 1,
      effects: [["Infernal — Seriach's Gift", "icons/creatures/abilities/wolf-howl-moon-purple.webp",
        [ch("system.traits.languages.value", M.ADD, "infernal")], null,
        "Speaks and understands Infernal. The hounds understand nothing else."]],
      manual: ["Putting the two hell hounds on the board is yours: drop them and give them to the player."] },

    { from: "41-02 / 4", vestige: "Great Taar Haak, the Five-Headed Destroyer", img: "icons/magic/control/buff-strength-muscle-damage-red.webp",
      power: "Great strength. While it lasts, the bearer has the benefit of a belt of fire giant strength: Strength becomes 25.",
      price: "Nothing visible.", flaw: "I like to bully others and make them feel weak and inferior.",
      days: 10,
      effects: [["Fire Giant Strength — Taar Haak's Gift", "icons/magic/control/buff-strength-muscle-damage-red.webp",
        [ch("system.abilities.str.value", M.UPGRADE, "25")], 10 * DAY,
        "Strength 25 while the gift lasts. It never lowers a higher score."]] },

    { from: "41-02 / 5", vestige: "Yrrga, the Eye of Shadows", img: "icons/magic/perception/eye-ringed-glow-angry-purple.webp",
      power: "The power of true seeing. Truesight out to 60 feet while it lasts.",
      price: "The bearer's eyes become starry voids until the gift vanishes.",
      flaw: "I believe that all life is pointless and look forward to death when it finally comes.",
      days: 30,
      effects: [["Truesight 60 — Yrrga's Gift", "icons/magic/perception/eye-ringed-glow-angry-purple.webp",
        [ch("system.attributes.senses.ranges.truesight", M.UPGRADE, "60"),
         ch("system.attributes.senses.truesight", M.UPGRADE, "60")], 30 * DAY,
        "Truesight 60 feet. Both field names are written because 5.3 moved it, and it never lowers a longer range."]] },

    { from: "41-02 / 6", vestige: "Yog the Invincible", img: "icons/magic/life/heart-cross-strong-flame-purple-orange.webp",
      power: "Physical resilience. The bearer's hit point maximum goes up by 30 while it lasts.",
      price: "Oily black fur covers the bearer's face and body.",
      days: 10,
      effects: [["+30 Hit Points — Yog's Gift", "icons/magic/life/heart-cross-strong-flame-purple-orange.webp",
        [ch("system.attributes.hp.bonuses.overall", M.ADD, "30")], 10 * DAY,
        "Maximum hit points +30 while the gift lasts."]] },

    { from: "41-03 / 1", vestige: "Drizlash, the Nine-Eyed Spider", img: "icons/creatures/invertebrates/spider-web-black.webp",
      power: "The power to walk on walls and ceilings. The bearer climbs difficult surfaces, upside down on ceilings included, with no ability check.",
      price: "An extra eye grows somewhere on the bearer's body. It is blind and never closes.",
      effects: [["Wall Walker — Drizlash's Gift", "icons/creatures/invertebrates/spider-web-black.webp",
        [ch("system.attributes.movement.climb", M.OVERRIDE, "@attributes.movement.walk")], null,
        "Climbs at its walking speed, no check, ceilings included."]] },

    { from: "41-03 / 2", vestige: "Dahlver-Nar, He of the Many Teeth", img: "icons/magic/death/skull-horned-goat-pentagram-red.webp",
      power: "The power to live many lives. The bearer reincarnates the instant they die, as the reincarnate spell, in a new body within 10 feet of the old one. Three times.",
      price: "The bearer loses all of their teeth until the third and final reincarnation.",
      uses: 3,
      manual: ["The reincarnation itself is yours to run: nothing here watches for the death or builds the new body."] },

    { from: "41-03 / 3", vestige: "Zantras, the Kingmaker", img: "icons/equipment/head/crown-gold-blue.webp",
      power: "Power that comes from great presence and force of personality. Charisma +4, to a maximum of 22.",
      price: "Nothing visible.", flaw: "I won't take no for an answer.",
      effects: [["Charisma +4 — Zantras's Gift", "icons/equipment/head/crown-gold-blue.webp",
        [ch("system.abilities.cha.value", M.ADD, "4"), ch("system.abilities.cha.max", M.UPGRADE, "22")], null,
        "Charisma +4, capped at 22 by the score's own maximum."]] },

    { from: "41-03 / 4", vestige: "Shami-Amourae, the Lady of Delights", img: "icons/magic/control/hypnosis-mesmerism-pink.webp",
      power: "The power of persuasion. Suggestion, as an action, three times, and saving throws against it are made with disadvantage.",
      price: "An extra finger grows on each of the bearer's hands.",
      flaw: "I can't get enough pleasure. I desire others to create beauty for me at all times.",
      uses: 3, spell: "Suggestion",
      flags: { saveDisadvantage: true },
      manual: ["The disadvantage on the save is on the item and in its words; ACE does not yet bend another creature's save off a gift, so apply it on the roll."] },

    { from: "41-03 / 5", vestige: "Tarakamedes, the Grave Wyrm", img: "icons/creatures/abilities/wing-bat-leather-purple.webp",
      power: "The power of flight. Skeletal wings, and a flying speed of 50 feet.",
      price: "The bearer must eat bones or grave dirt to live. At dawn, if they have not eaten at least a pound of it in the last 24 hours, they die.",
      effects: [["Skeletal Wings — Tarakamedes's Gift", "icons/creatures/abilities/wing-bat-leather-purple.webp",
        [ch("system.attributes.movement.fly", M.UPGRADE, "50")], null,
        "Flying speed 50 feet. ACE asks for an elevation when the gift is used."]],
      manual: ["The bone hunger is not automated: a dawn hook that kills a player character on a bug is not something to ship unseen."] },

    { from: "41-03 / 6", vestige: "Savnok the Inscrutable", img: "icons/magic/perception/third-eye-blue-red.webp",
      power: "The power to shield the mind. Mind blank, cast on the bearer, lasting a year.",
      price: "The bearer's eyes melt away, leaving empty sockets that can still see.",
      days: 365,
      effects: [["Mind Blank — Savnok's Gift", "icons/magic/perception/third-eye-blue-red.webp",
        [ch("system.traits.di.value", M.ADD, "psychic"), ch("system.traits.ci.value", M.ADD, "charmed")],
        365 * DAY, "Immune to psychic damage and to being charmed. Divination cannot find or read them."],
       ["Hollow Sockets — Savnok's Price", "icons/magic/perception/third-eye-blue-red.webp",
        [ch("system.traits.ci.value", M.ADD, "blinded")], null,
        "The eyes are gone and still see. Nothing can blind what is not there."]] },

    { from: "41-03 / 7", vestige: "Fekre, Queen of Poxes", img: "icons/magic/death/hand-withered-gray.webp",
      power: "The power to spread disease. Contagion, as an action, three times.",
      price: "The entry names none.",
      uses: 3, spell: "Contagion" },

    { from: "41-03 / 8", vestige: "Sykane, the Soul Hungerer", img: "icons/magic/death/hand-undead-skeleton-fire-green.webp",
      power: "The power to raise the recently dead. Raise dead, as an action, three times.",
      price: "The bearer's eyes glow a sickly yellow until the gift vanishes.",
      flaw: "If I help someone, I expect payment in return.",
      uses: 3, spell: "Raise Dead" },

    { from: "41-03 / 9", vestige: "Zrin-Hala, the Howling Storm", img: "icons/magic/lightning/bolt-strike-blue.webp",
      power: "The power to create lightning. Lightning bolt, as an action, three times.",
      price: "One side of the bearer's face sags and loses all feeling.",
      uses: 3, spell: "Lightning Bolt" },

    { from: "41-04 / 1", vestige: "Delban, the Star of Ice and Hate", img: "icons/magic/water/snowflake-ice-blue-white.webp",
      power: "The power to unleash deadly cold. Cone of cold, as an action, seven times. Until it vanishes the bearer also has the benefit of a ring of warmth.",
      price: "Nothing visible.", flaw: "Fire terrifies me.",
      uses: 7, spell: "Cone of Cold",
      effects: [["Ring of Warmth — Delban's Gift", "icons/magic/water/snowflake-ice-blue-white.webp",
        [ch("system.traits.dr.value", M.ADD, "cold")], null,
        "Resistance to cold damage, and the bearer suffers no harm from temperatures down to -50 degrees."]] },

    { from: "41-04 / 3", vestige: "Khirad, the Star of Secrets", img: "icons/magic/perception/orb-crystal-ball-scrying-blue.webp",
      power: "The power of divination. Scrying, as an action, three times.",
      price: "The bearer's voice becomes a low whisper, and their smile turns cruel and evil.",
      uses: 3, spell: "Scrying" },

    { from: "41-04 / 5", vestige: "Tenebrous", img: "icons/magic/death/skull-horned-worn-fire-blue.webp",
      power: "The secret of lichdom, offered only to an evil humanoid who can cast 9th-level wizard spells. The bearer learns to craft a phylactery that will hold their soul, and to brew a potion that turns them into a lich.",
      price: "Ten days to build the phylactery, three to brew the potion, and the two cannot be made at once. Drinking it turns them into a lich under the GM's control.",
      flaw: "All I care about is acquiring new magic and arcane knowledge.",
      manual: ["Nothing here checks the alignment or the 9th-level spells, and nothing turns anybody into a lich. This item is the knowledge and the clock."] },

    { from: "41-04 / 6", vestige: "Zhudun, the Corpse Star", img: "icons/magic/death/hand-dirt-undead-zombie.webp",
      power: "The power to raise the ancient dead. As an action, touch a dead creature's remains and restore it to life exactly as the resurrection spell does, however long it has been dead. Once.",
      price: "The bearer takes on a corpselike appearance and is easily mistaken for undead.",
      uses: 1, spell: "Resurrection",
      manual: ["The spell's own time limit does not apply to this gift, so the cast will not refuse an ancient corpse. Ignore what the spell's words say about a decade."] },

    { from: "41-04 / Vampyr", vestige: "the Vampyr", img: "icons/magic/death/mouth-bite-fangs-vampire-red.webp",
      power: "The immortality of undeath, offered to any evil humanoid who touches the sarcophagus. Nothing happens until two conditions are met, and the bearer only learns them after accepting: they must slay a humanoid who loves or reveres them and drink its blood within the hour, and then die a violent death at the hands of creatures that hate them.",
      price: "When both are met they become a vampire under the GM's control.",
      flaw: "I am surrounded by hidden enemies that seek to destroy me. I can't trust anyone.",
      manual: ["Neither condition is watched for and nothing turns them into a vampire. This item is the bargain, written down where the player can see it."] },
  ];

  // ── Build ─────────────────────────────────────────────────────────────────
  const made = [];
  const updated = [];
  for (const g of GIFTS) {
    const name = `Dark Gift of ${g.vestige}`;
    const bits = [`<p><em>${g.power}</em></p>`,
      `<p><strong>The price.</strong> ${g.price}</p>`];
    if (g.flaw) bits.push(`<p><strong>Flaw.</strong> &ldquo;${g.flaw}&rdquo;</p>`);
    if (g.days) bits.push(`<p><strong>It lasts ${g.days === 365 ? "a year" : `${g.days} days`}</strong>, then the gift vanishes.</p>`);
    if (g.uses) bits.push(`<p><strong>${g.uses} use${g.uses === 1 ? "" : "s"}</strong>, then the gift vanishes.</p>`);
    for (const m of (g.manual ?? [])) bits.push(`<p class="ace-gift-gm"><em>GM: ${m}</em></p>`);
    bits.push(`<p style="opacity:.7"><em>Amber Temple, sarcophagus ${g.from}.</em></p>`);

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
