/* ─── THE REST OF THEM: THE WHOLE WORLD, AND YOUR OWN COMPENDIUMS ─────────────
 *
 * The first pass walked the tokens on scenes. This one does every actor in the
 * world directory, and then every ACTOR compendium that belongs to this world and
 * is unlocked. A pack that is the system's or a module's, or that is locked, is
 * named and left alone.
 *
 * ⚠️🔴 THE PARSER IS NOT COPIED AND NOT CHANGED (his rule, 2026-10-05: "Reuse the
 * same parser. Do not change it."). It is lifted out of ace-fill-spells.js at run
 * time, text and all, so there is exactly one definition of how a statblock is
 * read. If that file ever stops carrying it, this one stops and says so rather
 * than quietly reading the words a second, slightly different way.
 *
 * Same rules throughout: player characters are never read, only the spells the
 * words name are added, nothing is removed, nothing already on the sheet is
 * touched, and no multiattack, hit point, item or feat is written.
 * ────────────────────────────────────────────────────────────────────────── */
(async () => {
  if (!game.user.isGM) return ui.notifications.warn("ACE: this is a GM job.");

  /* ── THE PARSER, OUT OF THE FILE THAT OWNS IT ───────────────────────────── */
  let parser = null;
  try {
    const r = await fetch(`/modules/ace-qol/tools/world/ace-fill-spells.js?v=${Date.now()}`);
    if (!r.ok) throw new Error(`the server answered ${r.status} for /ace-fill-spells.js`);
    const src = await r.text();

    const slice = (startsWith, endsWith) => {
      const i = src.indexOf(startsWith);
      if (i < 0) throw new Error(`"${startsWith.slice(0, 30)}…" is not in that file any more`);
      const j = src.indexOf(endsWith, i);
      if (j < 0) throw new Error(`the end of "${startsWith.slice(0, 30)}…" could not be found`);
      return src.slice(i, j + endsWith.length);
    };

    // The three readers, exactly as they are written there.
    const readers = slice("const plain = (html)", "return out;\n  };");
    // And the lookup, so a spell is found the same way in both passes.
    const lookup = slice("const packs = game.packs.filter(p => p.documentName === \"Item\")",
      "return found;\n  };");
    // eslint-disable-next-line no-new-func
    parser = new Function(`${readers}\n${lookup}\nreturn { plain, readGroups, findSpell };`)();
    if (typeof parser.readGroups !== "function" || typeof parser.findSpell !== "function") {
      throw new Error("the pieces came out of that file but are not functions");
    }
    console.log(`ACE spells | the parser was lifted out of ace-fill-spells.js `
      + `(${readers.length + lookup.length} characters). It is not copied and not changed.`);
  } catch (err) {
    console.error("ACE spells | the parser could not be taken from ace-fill-spells.js, so nothing "
      + "was read and nothing was written:", err);
    return ui.notifications.error("ACE: could not reuse the parser from ace-fill-spells.js. "
      + "Nothing was changed. The console says why.");
  }
  const { plain, readGroups, findSpell } = parser;

  const FEATURES = ["spellcasting", "innate spellcasting"];
  const worldFilled = [];
  const packFilled = [];
  const noSpells = [];
  const noFeature = [];
  const skippedOwned = [];
  const notFound = new Map();
  const failures = [];
  const packsSkipped = [];
  const packsDone = [];

  /** The spell data for one named spell in one group, shaped as the first pass shapes it. */
  const shape = async (name, g, who) => {
    const spell = await findSpell(name);
    if (!spell) {
      const list = notFound.get(name) ?? [];
      list.push(who);
      notFound.set(name, list);
      return null;
    }
    const data = spell.toObject();
    delete data._id;
    delete data.folder;
    delete data.ownership;
    // `system.method` and `system.prepared` are the 5.x fields; the old
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
    data.flags.world = { ...(data.flags.world ?? {}), filledFrom: g.featName, filledAs: g.group };
    return { data, label: `${spell.name} (${g.how === "innate" ? `${g.perDay}/day`
      : g.how === "atwill" ? "at will" : `level ${data.system.level}`})` };
  };

  /**
   * One sheet. Returns what it added, or why it did not.
   * @returns {Promise<{added: string[], why: string|null}>}
   */
  const fill = async (actor, where) => {
    if (actor.type === "character") return { added: [], why: null };
    if (actor.hasPlayerOwner) { skippedOwned.push(`${actor.name} (${where})`); return { added: [], why: null }; }

    const feat = actor.items.find(i => FEATURES.includes(i.name.trim().toLowerCase()));
    if (!feat) { noFeature.push(actor.name); return { added: [], why: null }; }

    const groups = readGroups(plain(feat.system?.description?.value ?? ""));
    if (!groups.length) {
      noSpells.push(`${actor.name} — "${feat.name}" (${where})`);
      return { added: [], why: "the feature names no spells" };
    }

    const have = new Set(actor.items.filter(i => i.type === "spell")
      .map(i => i.name.trim().toLowerCase()));
    const batch = [];
    const added = [];
    for (const g of groups) {
      for (const name of g.names) {
        if (have.has(name.toLowerCase())) continue;      // never a duplicate
        const made = await shape(name, { ...g, featName: feat.name }, actor.name);
        if (!made) continue;
        batch.push(made.data);
        have.add(name.toLowerCase());
        added.push(made.label);
      }
    }
    if (!batch.length) return { added: [], why: "every spell it names was already there" };
    try {
      await actor.createEmbeddedDocuments("Item", batch);
      return { added, why: null };
    } catch (err) {
      failures.push(`${actor.name} (${where}): ${err.message}`);
      console.error(`ACE spells | ${actor.name} could not be given its spells:`, err);
      return { added: [], why: err.message };
    }
  };

  /* ── 1. EVERY ACTOR IN THE WORLD ────────────────────────────────────────── */
  console.log(`ACE spells | the world directory holds ${game.actors.size} actor(s).`);
  for (const actor of game.actors) {
    const out = await fill(actor, "world");
    if (out.added.length) {
      worldFilled.push(`${actor.name}: ${out.added.join(", ")}`);
      console.log(`ACE spells | ${actor.name} (+${out.added.length}): ${out.added.join(", ")}`);
    }
  }

  /* ── 2. YOUR OWN ACTOR COMPENDIUMS, THE UNLOCKED ONES ───────────────────── */
  for (const pack of game.packs.filter(p => p.documentName === "Actor")) {
    const id = pack.collection;
    const kind = pack.metadata?.packageType ?? "unknown";
    // ⚠️ THE SYSTEM'S AND THE MODULES' BOOKS ARE NOT OURS TO EDIT, and a locked
    // pack is locked for a reason. Both are named, not silently passed over.
    if (kind !== "world") {
      packsSkipped.push(`${pack.metadata.label} (${id}) — ${kind} book${pack.locked ? ", locked" : ""}`);
      continue;
    }
    if (pack.locked) {
      packsSkipped.push(`${pack.metadata.label} (${id}) — locked`);
      continue;
    }

    let docs = [];
    try { docs = await pack.getDocuments(); }
    catch (err) {
      packsSkipped.push(`${pack.metadata.label} (${id}) — could not be read: ${err.message}`);
      console.error(err);
      continue;
    }
    let touched = 0;
    for (const actor of docs) {
      const out = await fill(actor, `pack ${id}`);
      if (out.added.length) {
        touched++;
        packFilled.push(`${actor.name} [${id}]: ${out.added.join(", ")}`);
        console.log(`ACE spells | [${id}] ${actor.name} (+${out.added.length}): ${out.added.join(", ")}`);
      }
    }
    packsDone.push(`${pack.metadata.label} (${id}) — ${docs.length} sheet(s), ${touched} filled`);
  }

  /* ── THE COUNTS, FROM THIS RUN ──────────────────────────────────────────── */
  console.log("%cACE spells | THE REST OF THEM — DONE", "font-weight:700;font-size:14px");
  console.log(`  world sheets filled: ${worldFilled.length}`);
  for (const f of worldFilled) console.log("     " + f);
  console.log(`  compendium sheets filled: ${packFilled.length}`);
  for (const f of packFilled) console.log("     " + f);
  console.log(`  compendiums written to: ${packsDone.length}`);
  for (const p of packsDone) console.log("     " + p);
  console.log(`  compendiums skipped: ${packsSkipped.length}`);
  for (const p of packsSkipped) console.log("     " + p);
  console.log(`  the feature is there and names no spells: ${noSpells.length}`);
  for (const n of noSpells) console.log("     " + n);
  console.log(`  no Spellcasting or Innate Spellcasting feature at all: ${noFeature.length}`);
  if (notFound.size) {
    console.warn(`  named but not found in this world or any book: ${notFound.size}`);
    for (const [name, who] of notFound) {
      console.warn(`     "${name}" — wanted by ${[...new Set(who)].join(", ")}`);
    }
  }
  if (skippedOwned.length) {
    console.log(`  player-owned and left alone on purpose: ${skippedOwned.length}`);
    for (const s of skippedOwned) console.log("     " + s);
  }
  if (failures.length) {
    console.error(`  could not be written: ${failures.length}`);
    for (const f of failures) console.error("     " + f);
  }

  ui.notifications.info(`ACE: ${worldFilled.length} world sheet(s) and ${packFilled.length} `
    + `compendium sheet(s) filled. ${noSpells.length} named no spells`
    + `${notFound.size ? `, ${notFound.size} spell name(s) not found` : ""}. `
    + `${packsSkipped.length} compendium(s) skipped. The console has every name.`);
})();
