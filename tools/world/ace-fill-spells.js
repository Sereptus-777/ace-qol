/* ─── FILL EVERY SPELL LIST FROM THE WORDS ON THE SHEET ───────────────────────
 *
 * For every actor a token on any scene is using, the unlinked ones included:
 * read its Spellcasting or Innate Spellcasting feature, take the spells that
 * description actually names, and put them on the sheet the way it says.
 *
 *   At will              -> an at-will spell
 *   N/day, N/day each    -> innate, N uses, back on a long rest
 *   Cantrips (at will)   -> the cantrip itself
 *   Nth level (N slots)  -> the spell itself, prepared
 *
 * ⚠️ IT ADDS, AND THAT IS ALL. Nothing is removed, nothing already on the sheet
 * is touched, no multiattack, no hit points, no items, no feats, and no player
 * character is read at all. A spell the description does not name is never added.
 *
 * ⚠️ THE SPELL'S OWN LEVEL IS THE RIGHT LEVEL. The heading says which group the
 * statblock prints it under; the spell item carries its real level, which is what
 * the sheet groups by, so the level is never overwritten off a heading.
 * ────────────────────────────────────────────────────────────────────────── */
(async () => {
  if (!game.user.isGM) return ui.notifications.warn("ACE: this is a GM job.");

  const FEATURES = ["spellcasting", "innate spellcasting"];
  const filled = [];        // actors that got at least one spell
  const noSpells = [];      // the feature is there and names nothing
  const noFeature = [];     // no such feature at all
  const notFound = new Map();   // spell name -> who wanted it
  const skippedOwned = [];  // player-owned, left alone on purpose
  const failures = [];

  /* ── The words, out of the HTML ─────────────────────────────────────────── */
  const plain = (html) => String(html ?? "")
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>|<\/p>|<\/li>|<\/div>|<\/h\d>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&")
    .replace(/&ldquo;|&rdquo;|&quot;/gi, '"')
    .replace(/&rsquo;|&lsquo;/gi, "'")
    .replace(/[ \t ]+/g, " ");

  /** One spell name, cleaned of the statblock's asides. */
  const cleanName = (s) => String(s ?? "")
    .replace(/\([^)]*\)/g, " ")        // (self only), (cast as a 3rd-level spell)
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/[*†‡]/g, " ")
    .replace(/\s*\b(only|each)\b\s*$/i, " ")
    .replace(/[.;:,]+$/, "")
    .replace(/\s+/g, " ")
    .trim();

  /**
   * What the description actually says.
   * @returns {Array<{names: string[], how: "atwill"|"innate"|"spell", perDay: number|null, group: string}>}
   */
  const readGroups = (text) => {
    const out = [];
    /* Each "heading: list" run, wherever the line breaks happen to fall.
       ⚠️ THE LIST STOPS AT THE NEXT HEADING, not just at a newline. A statblock
       pasted as one long line read "thaumaturgy 3/day each: darkness" as a single
       spell name, which is a spell nobody has. */
    const HEAD = String.raw`at will|cantrips?\s*\(at will\)|cantrips?`
      + String.raw`|\d+\s*\/\s*day(?:\s+each)?|\d+(?:st|nd|rd|th)\s+level(?:\s*\([^)]*\))?`;
    const re = new RegExp(`(${HEAD})\\s*:\\s*([\\s\\S]*?)(?=(?:${HEAD})\\s*:|\\n|$)`, "gi");
    let m;
    while ((m = re.exec(text)) !== null) {
      // ⚠️ THE NUMBERS COME OUT OF THE HEADING ITSELF. The heading is one capture
      // now, so "3/day each" and "2nd level" are read back off it rather than off
      // group numbers that no longer exist.
      const head = m[1].toLowerCase();
      const perDay = Number(/^(\d+)\s*\/\s*day/.exec(head)?.[1] ?? NaN) || null;
      const lvl = Number(/^(\d+)(?:st|nd|rd|th)\s+level/.exec(head)?.[1] ?? NaN) || null;
      const names = m[2].split(/,(?![^(]*\))/).map(cleanName).filter(Boolean);
      if (!names.length) continue;
      let how = "spell";
      if (/^at will$/.test(head) || /\(at will\)/.test(head)) how = "atwill";
      else if (perDay) how = "innate";
      out.push({ names, how, perDay, group: m[1].trim(), level: lvl });
    }
    return out;
  };

  /* ── Finding a spell, once per name ─────────────────────────────────────── */
  const packs = game.packs.filter(p => p.documentName === "Item")
    .sort((a, b) => (b.metadata.id.startsWith("dnd5e") ? 1 : 0) - (a.metadata.id.startsWith("dnd5e") ? 1 : 0));
  const cache = new Map();
  const findSpell = async (name) => {
    const want = name.toLowerCase();
    if (cache.has(want)) return cache.get(want);
    let found = game.items.find(i => i.type === "spell" && i.name.toLowerCase() === want) ?? null;
    if (!found) {
      for (const pack of packs) {
        try {
          const idx = await pack.getIndex({ fields: ["type"] });
          const hit = idx.find(e => e.type === "spell" && String(e.name).toLowerCase() === want);
          if (hit) { found = await pack.getDocument(hit._id); break; }
        } catch (_) { /* a pack that will not index is not an answer */ }
      }
    }
    cache.set(want, found);
    return found;
  };

  /* ── Every actor a token is using ───────────────────────────────────────── */
  const seen = new Set();
  const targets = [];
  for (const scene of game.scenes) {
    for (const tokenDoc of scene.tokens) {
      const actor = tokenDoc.actor;
      if (!actor) continue;
      // ⚠️ AN UNLINKED TOKEN IS ITS OWN SHEET. Its actor is the token's delta, so
      // writing to it writes to that token and nothing else. Keyed on the uuid so
      // ten linked goblins are one sheet and ten unlinked ones are ten.
      const key = actor.uuid ?? `${scene.id}.${tokenDoc.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (actor.type === "character") continue;                  // never a PC
      if (actor.hasPlayerOwner) { skippedOwned.push(`${actor.name} (on "${scene.name}")`); continue; }
      targets.push({ actor, scene, tokenDoc });
    }
  }
  console.log(`ACE spells | ${targets.length} actor sheet(s) behind the tokens on `
    + `${game.scenes.size} scene(s), player characters left out.`);

  /* ── The work ───────────────────────────────────────────────────────────── */
  for (const { actor, scene } of targets) {
    const feat = actor.items.find(i => FEATURES.includes(i.name.trim().toLowerCase()));
    if (!feat) { noFeature.push(actor.name); continue; }

    const text = plain(feat.system?.description?.value ?? "");
    const groups = readGroups(text);
    if (!groups.length) { noSpells.push(`${actor.name} — "${feat.name}" (on "${scene.name}")`); continue; }

    const have = new Set(actor.items.filter(i => i.type === "spell")
      .map(i => i.name.trim().toLowerCase()));
    const batch = [];
    const added = [];
    for (const g of groups) {
      for (const name of g.names) {
        if (have.has(name.toLowerCase())) continue;     // never a duplicate
        const spell = await findSpell(name);
        if (!spell) {
          const who = notFound.get(name) ?? [];
          who.push(actor.name);
          notFound.set(name, who);
          continue;
        }
        const data = spell.toObject();
        delete data._id;
        delete data.folder;
        delete data.ownership;
        // ⚠️ `system.method` and `system.prepared` are the 5.x fields; the old
        // `preparation.mode` is deprecated and would be migrated under us.
        data.system = data.system ?? {};
        if (g.how === "atwill") {
          data.system.method = "atwill";
          data.system.prepared = 2;
        } else if (g.how === "innate") {
          data.system.method = "innate";
          data.system.prepared = 2;
          data.system.uses = { spent: 0, max: String(g.perDay),
            recovery: [{ period: "lr", type: "recoverAll" }] };
        } else {
          data.system.method = "spell";
          data.system.prepared = data.system.level === 0 ? 2 : 1;
        }
        data.flags = data.flags ?? {};
        data.flags.world = { ...(data.flags.world ?? {}),
          filledFrom: feat.name, filledAs: g.group };
        batch.push(data);
        have.add(name.toLowerCase());
        added.push(`${spell.name} (${g.how === "innate" ? `${g.perDay}/day`
          : g.how === "atwill" ? "at will" : `level ${data.system.level}`})`);
      }
    }

    if (!batch.length) {
      // The feature named spells and every one was already there, or none could
      // be found. Not the same thing as naming none, so it is said separately.
      console.log(`ACE spells | ${actor.name}: "${feat.name}" names `
        + `${groups.reduce((n, g) => n + g.names.length, 0)} spell(s) and nothing new was needed.`);
      continue;
    }
    try {
      await actor.createEmbeddedDocuments("Item", batch);
      filled.push(`${actor.name}: ${added.join(", ")}`);
      console.log(`ACE spells | ${actor.name} (+${batch.length}): ${added.join(", ")}`);
    } catch (err) {
      failures.push(`${actor.name}: ${err.message}`);
      console.error(`ACE spells | ${actor.name} could not be given its spells:`, err);
    }
  }

  /* ── The report ─────────────────────────────────────────────────────────── */
  console.log("%cACE spells | DONE", "font-weight:700;font-size:14px");
  console.log(`  filled: ${filled.length} actor(s)`);
  for (const f of filled) console.log("     " + f);
  console.log(`  the feature is there and names no spells: ${noSpells.length}`);
  for (const n of noSpells) console.log("     " + n);
  console.log(`  no Spellcasting or Innate Spellcasting feature at all: ${noFeature.length}`);
  if (notFound.size) {
    console.warn(`  named but not found in this world or any book: ${notFound.size}`);
    for (const [name, who] of notFound) console.warn(`     "${name}" — wanted by ${who.join(", ")}`);
  }
  if (skippedOwned.length) {
    console.log(`  player-owned and left alone on purpose: ${skippedOwned.length}`);
    for (const s of skippedOwned) console.log("     " + s);
  }
  if (failures.length) {
    console.error(`  could not be written: ${failures.length}`);
    for (const f of failures) console.error("     " + f);
  }

  ui.notifications.info(`ACE: filled ${filled.length} sheet(s). `
    + `${noSpells.length} feature(s) named no spells`
    + `${notFound.size ? `, ${notFound.size} spell name(s) not found` : ""}. The console has the names.`);
})();
