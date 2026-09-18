// ─── ACE: QOL — Does every creature actually see what it should? ────────────
//
// Johnny, 2026-09-07: *"I want every token in my sidebar to be properly set up
// and working... I want their sight working and at a proper distance and all of
// that shit."*
//
// THE PROBLEM
//     A dnd5e statblock says "darkvision 120 ft." That is a number on the
//     ACTOR. Whether the TOKEN can see 120 feet in the dark is a completely
//     separate set of fields on the prototype token, and nothing keeps the two
//     in step. An imported monster routinely has 120 feet of darkvision written
//     on its sheet and a token that sees nothing at all.
//
// ⚠️🔴 THE VISION STAMP (his table, 2026-09-18): "Neferon's token is Basic
//     Vision. The book is Truesight 120 ft." The Monster Manual's own copy of
//     the arcanaloth (and the lich, and most of the book) ships with sight
//     switched off, range 0, Basic Vision and no senses at all, while its sheet
//     says truesight 120; dragging one onto the map gave exactly that. dnd5e
//     never copies senses onto a token. So now:
//       - every token that is created is stamped from its creature's senses,
//         and so is the sidebar actor's prototype, so the next drop is right;
//       - the senses are the sheet's; when the sheet has none, the book's copy
//         of that creature ("(Legacy)" or a 2014 sheet reads the 2014 book,
//         anything else the 2024 Monster Manual) lends its own;
//       - one pass over his world actors, once; the locked premium compendiums
//         are never rewritten, only counted in the console;
//       - truesight has its own vision mode, "Truesight": it sees in the dark,
//         in colour, out to its range. Foundry has none, and "Basic Vision" was
//         what he read on a creature that has truesight.
//
// ⚠️🔴 IT REPORTS BEFORE IT WRITES, AND IT SAVES WHAT IT REPLACES.
//     On 2026-09-06 a scan I wrote to fix three icons overwrote 1,073 documents
//     and recorded none of the old values. Two hours went into recovering them
//     from a six-week-old snapshot. So: `audit()` changes nothing and hands back
//     a table; everything that writes stashes the old values under
//     `flags.ace-qol.visionBefore` on the same update, so `undo()` is always
//     available.
//
// ⚠️ FILL, NEVER LOWER. A stamp raises what is short of the senses and adds
//     what is missing. It never shortens a range, never switches a sense off and
//     never replaces a vision mode somebody chose (anything but Basic), so an
//     importer's work and his own choices stand. That is also why it can run on
//     every drop.
//
// ⚠️ AND A CREATURE WITH NO SENSES IS NOT BROKEN. Sight range zero with the
//     basic vision mode means "sees by light like everyone else", which is
//     correct for most humanoids. Reporting those would bury the real faults in
//     two thousand rows of noise.
// ──────────────────────────────────────────────────────────────────────────────

const MODULE_ID = "ace-qol";
const LOG = `${MODULE_ID} | vision`;

// dnd5e sense → what the token needs. Verified against the system and Foundry
// core rather than remembered: the ids below are the ones actually registered.
const SENSE_DETECTION = {
  blindsight:  "blindsight",   // dnd5e registers this one itself
  tremorsense: "feelTremor",
  truesight:   "seeAll",
};
const SENSES = ["darkvision", "blindsight", "tremorsense", "truesight"];

/** The one pass over his world actors: bump this when the stamp's rule changes. */
const PASS_VERSION = 1;

export class VisionAudit {

  /**
   * Feet of a sense, or 0.
   *
   * ⚠️🔴 THEY MOVED IN dnd5e 5.3. `senses.darkvision` became
   * `senses.ranges.darkvision`, and the old path still answers through a
   * compatibility shim that logs a deprecation every single time it is read.
   * Auditing two thousand actors through the shim printed four warnings per
   * creature. It worked, and it filled his console with red.
   *
   * ⚠️ THE NEW PATH FIRST, THE OLD ONE AS A FALLBACK. The shim is scheduled
   * for removal in 5e 6.1, and reading the old path first would mean going
   * through the deprecation even on a world that has already migrated. Reading
   * the new one first means a migrated world never touches the shim at all,
   * and an unmigrated one still works.
   */
  static _sense(actor, key) {
    const senses = actor?.system?.attributes?.senses;
    if (!senses) return 0;
    const raw = (senses.ranges && key in senses.ranges)
      ? senses.ranges[key]
      : senses[key];
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }

  /** All four senses from a sheet (an actor, or a compendium index entry), in feet. */
  static sheetSenses(actor) {
    return Object.fromEntries(SENSES.map(k => [k, VisionAudit._sense(actor, k)]));
  }

  static _hasAny(ranges) { return SENSES.some(k => (Number(ranges?.[k]) || 0) > 0); }

  /**
   * The vision mode these senses call for. Truesight's own mode when truesight
   * reaches farthest (it sees in the dark in colour), Darkvision when darkvision
   * does (what his importers already use on 1,092 creatures), else Basic.
   * Truesight falls back to Basic if its mode is not registered.
   */
  static modeFor(ranges) {
    const dark = Number(ranges?.darkvision) || 0, tru = Number(ranges?.truesight) || 0;
    if (tru > 0 && tru > dark) {
      return CONFIG?.Canvas?.visionModes?.truesight ? "truesight" : "basic";
    }
    return dark > 0 ? "darkvision" : "basic";
  }

  /**
   * What a token must carry for these senses: sight on; a vision range reaching
   * the farther of darkvision and truesight (truesight sees in normal and magical
   * darkness out to its range); the mode above; and a detection mode for each of
   * blindsight, tremorsense and truesight at its range.
   */
  static expectedFrom(ranges) {
    const dark = Number(ranges?.darkvision) || 0, tru = Number(ranges?.truesight) || 0;
    const modes = [];
    for (const [sense, id] of Object.entries(SENSE_DETECTION)) {
      const ft = Number(ranges?.[sense]) || 0;
      if (ft > 0) modes.push({ id, enabled: true, range: ft });
    }
    return { enabled: true, range: Math.max(dark, tru), visionMode: VisionAudit.modeFor(ranges), detectionModes: modes };
  }

  /**
   * What this creature's prototype token SHOULD carry, from its own statblock.
   * Returns null for anything the question does not apply to.
   */
  static expected(actor) {
    if (!actor || (actor.type !== "npc" && actor.type !== "character")) return null;
    return VisionAudit.expectedFrom(VisionAudit.sheetSenses(actor));
  }

  static _label(id) {
    return Object.entries(SENSE_DETECTION).find(([, v]) => v === id)?.[0] ?? id;
  }

  /**
   * What these senses need that this token does not have yet, filled in.
   * Fill, never lower: a longer range, a sense already on, or a mode somebody
   * chose (anything but Basic) is left alone. Another module's detection modes
   * are kept.
   *
   * @param {{sight?: object, detectionModes?: object[]}} current
   * @param {object} ranges  darkvision, blindsight, tremorsense, truesight in feet
   * @returns {null|{sight: object, detectionModes: object[], changes: string[]}}
   */
  static stampFor(current, ranges) {
    const want = VisionAudit.expectedFrom(ranges);
    const sight = { ...(current?.sight ?? {}) };
    const modes = (Array.isArray(current?.detectionModes) ? current.detectionModes : []).map(m => ({ ...m }));
    const changes = [];
    if (sight.enabled !== true) { sight.enabled = true; changes.push("sight switched on"); }
    const range = Number(sight.range) || 0;
    if (range < want.range) { sight.range = want.range; changes.push(`vision range ${range} to ${want.range} ft`); }
    if (want.visionMode !== "basic" && (sight.visionMode ?? "basic") === "basic") {
      sight.visionMode = want.visionMode;
      changes.push(`${want.visionMode === "truesight" ? "Truesight" : "Darkvision"} vision mode`);
    }
    for (const w of want.detectionModes) {
      const label = VisionAudit._label(w.id);
      const m = modes.find(x => x?.id === w.id);
      if (!m) { modes.push({ ...w }); changes.push(`${label} ${w.range} ft`); continue; }
      if (m.enabled === false) { m.enabled = true; changes.push(`${label} switched on`); }
      if ((Number(m.range) || 0) < w.range) { changes.push(`${label} ${m.range ?? 0} to ${w.range} ft`); m.range = w.range; }
    }
    return changes.length ? { sight, detectionModes: modes, changes } : null;
  }

  /**
   * Everything wrong with one creature's prototype token, as plain sentences.
   * The same rule as the stamp: only what is short of the sheet.
   */
  static faultsFor(actor) {
    const want = VisionAudit.expected(actor);
    if (!want) return [];
    // Nothing on the sheet to copy: the stamp leaves it alone, so does the report.
    if (!VisionAudit._hasAny(VisionAudit.sheetSenses(actor))) return [];
    const proto = actor.prototypeToken ?? {};
    const sight = proto.sight ?? {};
    const have = Array.isArray(proto.detectionModes) ? proto.detectionModes : [];
    const faults = [];

    // ⚠️ THE ONE THAT MATTERS MOST. A token with sight switched off sees
    // nothing whatever its ranges say, and it is the commonest import fault.
    if (sight.enabled !== true) faults.push("sight is switched off");

    if (want.range > 0) {
      const has = Number(sight.range ?? 0) || 0;
      if (has < want.range) {
        faults.push(`sight range is ${has} ft, the statblock says ${want.range} ft`);
      }
    }
    if (want.visionMode !== "basic" && (sight.visionMode ?? "basic") === "basic") {
      faults.push(`vision mode is "${sight.visionMode ?? "unset"}", not ${want.visionMode}`);
    }

    for (const mode of want.detectionModes) {
      const found = have.find(m => m?.id === mode.id);
      const label = VisionAudit._label(mode.id);
      if (!found) {
        faults.push(`${label} ${mode.range} ft is on the sheet but the token cannot use it`);
      } else if ((Number(found.range ?? 0) || 0) < mode.range) {
        faults.push(`${label} is set to ${found.range ?? 0} ft, the statblock says ${mode.range} ft`);
      } else if (found.enabled === false) {
        faults.push(`${label} is present but switched off`);
      }
    }
    return faults;
  }

  /* ── The book, when the sheet has nothing ─────────────────────────────── */

  /** "(Legacy)" or a 2014 sheet reads the 2014 book; anything else the 2024 one. */
  static editionOf(actor) {
    return /\(legacy\)/i.test(String(actor?.name ?? "")) || actor?.system?.source?.rules === "2014" ? "2014" : "2024";
  }

  static _norm(name) {
    return String(name ?? "").replace(/\((?:legacy|2014|2024)\)/gi, " ")
      .toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  }

  /** name -> the best book copy with senses, per edition; built once per session. */
  static _books = null;

  static _bookIndex() {
    VisionAudit._books ??= (async () => {
      const out = { "2014": new Map(), "2024": new Map() };
      for (const pack of (game.packs ?? [])) {
        if (pack?.documentName !== "Actor") continue;
        let index;
        try {
          index = await pack.getIndex({ fields: ["system.attributes.senses", "system.source.rules", "system.source.book"] });
        } catch (err) {
          console.warn(`${LOG} | could not read ${pack.collection}, so its creatures cannot lend their senses:`, err);
          continue;
        }
        for (const e of index) {
          const ranges = VisionAudit.sheetSenses(e);
          if (!VisionAudit._hasAny(ranges)) continue;       // a copy with no senses lends nothing
          const rules = e?.system?.source?.rules;
          const edition = rules === "2014" || rules === "2024" ? rules
            : (pack.collection === "dnd5e.monsters" ? "2014" : null);
          if (!edition) continue;
          // The Monster Manual itself first, then any other book's copy.
          const book = String(e?.system?.source?.book ?? "");
          const rank = (pack.collection === "dnd-monster-manual.actors" ? 3 : 0)
            + (/^(mm\b|monster manual)/i.test(book) ? 2 : 1);
          const key = VisionAudit._norm(e.name);
          const had = out[edition].get(key);
          if (!had || rank > had.rank) {
            out[edition].set(key, { ranges, rank, from: `${pack.metadata?.label ?? pack.collection} (${pack.collection})` });
          }
        }
      }
      return out;
    })();
    return VisionAudit._books;
  }

  /** The book copy's senses for a creature whose sheet has none, or null. */
  static async bookSenses(actor) {
    const edition = VisionAudit.editionOf(actor);
    const hit = (await VisionAudit._bookIndex())[edition]?.get(VisionAudit._norm(actor?.name));
    return hit ? { ranges: hit.ranges, from: `the ${edition} book's copy in ${hit.from}` } : null;
  }

  /**
   * The senses a creature's token must carry: its sheet's, and when the sheet
   * has none, its book copy's. "Sheet wins if it already has senses."
   * @returns {Promise<null|{ranges: object, from: string}>}
   */
  static async sensesFor(actor) {
    if (!actor || (actor.type !== "npc" && actor.type !== "character")) return null;
    const sheet = VisionAudit.sheetSenses(actor);
    if (VisionAudit._hasAny(sheet)) return { ranges: sheet, from: "its sheet" };
    try { return await VisionAudit.bookSenses(actor); }
    catch (err) {
      console.warn(`${LOG} | could not look ${actor.name} up in the books:`, err);
      return null;
    }
  }

  /* ── Writing ───────────────────────────────────────────────────────────── */

  /**
   * Stamp one creature's prototype token (the sidebar actor), so the next drop
   * is already right. The first record of what it was is kept, so undo() goes
   * all the way back.
   * @returns {Promise<string[]|null>} what changed, or null for nothing
   */
  static async stampPrototype(actor, senses = null) {
    senses ??= await VisionAudit.sensesFor(actor);
    if (!senses) return null;
    const proto = actor.prototypeToken ?? {};
    const stamp = VisionAudit.stampFor({ sight: proto.sight, detectionModes: proto.detectionModes }, senses.ranges);
    if (!stamp) return null;
    const update = {
      "prototypeToken.sight": stamp.sight,
      "prototypeToken.detectionModes": stamp.detectionModes,
    };
    if (!proto.flags?.[MODULE_ID]?.visionBefore) {
      update[`prototypeToken.flags.${MODULE_ID}.visionBefore`] = {
        sight: foundry.utils.deepClone(proto.sight ?? {}),
        detectionModes: foundry.utils.deepClone(proto.detectionModes ?? []),
      };
    }
    await actor.update(update);
    return stamp.changes;
  }

  /**
   * A token was just created (dropped on the map): its creature's senses go on
   * it, and on the sidebar actor's prototype too.
   */
  static async stampToken(tokenDoc) {
    const actor = tokenDoc?.actor ?? null;
    const senses = await VisionAudit.sensesFor(actor);
    if (!senses) return null;
    const src = tokenDoc._source ?? tokenDoc;
    const stamp = VisionAudit.stampFor({ sight: src.sight, detectionModes: src.detectionModes }, senses.ranges);
    if (stamp) {
      await tokenDoc.update({
        sight: stamp.sight,
        detectionModes: stamp.detectionModes,
        [`flags.${MODULE_ID}.visionBefore`]: {
          sight: foundry.utils.deepClone(src.sight ?? {}),
          detectionModes: foundry.utils.deepClone(src.detectionModes ?? []),
        },
      });
      console.log(`${LOG} | ${tokenDoc.name}: ${stamp.changes.join(", ")} (from ${senses.from}).`);
    }
    const home = tokenDoc.actorId ? game.actors?.get?.(tokenDoc.actorId) : null;
    if (home) {
      try {
        const changed = await VisionAudit.stampPrototype(home, senses);
        if (changed) console.log(`${LOG} | ${home.name}'s token in the sidebar too: ${changed.join(", ")}.`);
      } catch (err) {
        console.warn(`${LOG} | could not stamp ${home.name}'s token in the sidebar; the next drop is stamped anyway:`, err);
      }
    }
    return stamp?.changes ?? null;
  }

  /**
   * Read-only. Every creature whose token disagrees with its own statblock.
   *
   * @param {object} [opts]
   * @param {boolean} [opts.playersOnly]  only actors a player owns
   * @param {boolean} [opts.log]          print the table
   */
  static audit({ playersOnly = false, log = true } = {}) {
    const rows = [];
    let checked = 0;
    for (const actor of (game.actors ?? [])) {
      if (playersOnly && !actor.hasPlayerOwner) continue;
      if (!VisionAudit.expected(actor)) continue;
      checked++;
      const faults = VisionAudit.faultsFor(actor);
      if (faults.length) {
        rows.push({
          name: actor.name,
          type: actor.type,
          darkvision: VisionAudit._sense(actor, "darkvision") || "-",
          problems: faults.length,
          detail: faults.join("; "),
        });
      }
    }
    rows.sort((a, b) => b.problems - a.problems || a.name.localeCompare(b.name));

    if (log) {
      console.log(`%c${LOG} — ${rows.length} of ${checked} creature(s) cannot see what `
        + `their statblock says`, "color:#d4af37;font-weight:bold");
      if (rows.length) console.table(rows.map(r => ({ ...r, detail: r.detail.slice(0, 120) })));
      console.log(`${LOG} | repair with game.aceQol.VisionAudit.repair()`);
    }
    return rows;
  }

  /**
   * Stamp every world actor's prototype token from its senses (the sheet's, or
   * the book's when the sheet has none). The old values go in the same update.
   */
  static async repair({ playersOnly = false, dryRun = false, quiet = false } = {}) {
    if (!game.user?.isGM) {
      ui.notifications?.warn("Only the GM can repair token vision.");
      return { changed: 0 };
    }
    const targets = [];
    for (const actor of (game.actors ?? [])) {
      if (playersOnly && !actor.hasPlayerOwner) continue;
      const senses = await VisionAudit.sensesFor(actor);
      if (!senses) continue;
      const proto = actor.prototypeToken ?? {};
      if (!VisionAudit.stampFor({ sight: proto.sight, detectionModes: proto.detectionModes }, senses.ranges)) continue;
      targets.push({ actor, senses });
    }
    if (dryRun) {
      console.log(`${LOG} | ${targets.length} creature(s) WOULD be repaired`);
      return { changed: 0, wouldChange: targets.length };
    }

    let changed = 0, fromBook = 0;
    for (const { actor, senses } of targets) {
      try {
        if (await VisionAudit.stampPrototype(actor, senses)) {
          changed++;
          if (senses.from !== "its sheet") fromBook++;
        }
      } catch (err) {
        console.warn(`${LOG} | could not repair ${actor.name}:`, err);
      }
    }
    console.log(`${LOG} | repaired ${changed} of ${targets.length} (${fromBook} from the book, the rest from `
      + `their own sheets). Undo with game.aceQol.VisionAudit.undo()`);
    if (!quiet) ui.notifications?.info(`ACE: token vision repaired on ${changed} creature(s).`);
    return { changed, fromBook };
  }

  /**
   * Once per world (and again only when the stamp's rule changes): every world
   * actor's prototype stamped, then the locked compendiums counted.
   */
  static async pass() {
    if (!game.user?.isGM || (game.users?.activeGM && game.users.activeGM !== game.user)) return null;
    let done = 0;
    try { done = Number(game.settings.get(MODULE_ID, "visionPass")) || 0; }
    catch (err) { console.warn(`${LOG} | could not read whether the vision pass has run; running it:`, err); }
    if (done >= PASS_VERSION) return null;
    console.log(`${LOG} | one pass over the world's creatures: each token takes its creature's senses.`);
    const out = await VisionAudit.repair({ quiet: true });
    try { await game.settings.set(MODULE_ID, "visionPass", PASS_VERSION); }
    catch (err) { console.warn(`${LOG} | the vision pass ran but could not be marked done; it runs again next time:`, err); }
    await VisionAudit.logLockedPacks();
    if (out.changed) ui.notifications?.info(`ACE: ${out.changed} creature(s) in the sidebar now carry their senses on their tokens.`);
    return out;
  }

  /**
   * The locked compendiums (the premium books) are never rewritten; this only
   * says how many of their creatures would come out without their senses.
   * Each one is stamped the moment it is dropped.
   */
  static async logLockedPacks() {
    for (const pack of (game.packs ?? [])) {
      if (pack?.documentName !== "Actor" || !pack.locked) continue;
      try {
        const index = await pack.getIndex({ fields: ["system.attributes.senses", "prototypeToken.sight", "prototypeToken.detectionModes"] });
        let short = 0, total = 0;
        for (const e of index) {
          total++;
          const ranges = VisionAudit.sheetSenses(e);
          if (!VisionAudit._hasAny(ranges)) continue;
          if (VisionAudit.stampFor({ sight: e.prototypeToken?.sight, detectionModes: e.prototypeToken?.detectionModes }, ranges)) short++;
        }
        if (short) {
          console.log(`${LOG} | ${pack.metadata?.label ?? pack.collection} (${pack.collection}) is locked and is not rewritten: `
            + `${short} of ${total} creatures in it would come out without their senses. Each is stamped when it is dropped.`);
        }
      } catch (err) {
        console.warn(`${LOG} | could not count ${pack.collection}:`, err);
      }
    }
  }

  /** Put back exactly what the stamps replaced: prototypes, and tokens already placed. */
  static async undo() {
    if (!game.user?.isGM) return { restored: 0 };
    let restored = 0;
    for (const actor of (game.actors ?? [])) {
      const before = actor.prototypeToken?.flags?.[MODULE_ID]?.visionBefore;
      if (!before) continue;
      try {
        await actor.update({
          "prototypeToken.sight": before.sight ?? {},
          "prototypeToken.detectionModes": before.detectionModes ?? [],
          [`prototypeToken.flags.${MODULE_ID}.-=visionBefore`]: null,
        });
        restored++;
      } catch (err) {
        console.warn(`${LOG} | could not undo ${actor.name}:`, err);
      }
    }
    for (const scene of (game.scenes ?? [])) {
      for (const tokenDoc of (scene.tokens ?? [])) {
        const before = tokenDoc.flags?.[MODULE_ID]?.visionBefore;
        if (!before) continue;
        try {
          await tokenDoc.update({
            sight: before.sight ?? {},
            detectionModes: before.detectionModes ?? [],
            [`flags.${MODULE_ID}.-=visionBefore`]: null,
          });
          restored++;
        } catch (err) {
          console.warn(`${LOG} | could not undo ${tokenDoc.name} on ${scene.name}:`, err);
        }
      }
    }
    console.log(`${LOG} | restored ${restored} creature(s) and token(s) to how they were`);
    ui.notifications?.info(`ACE: vision restored on ${restored} creature(s) and token(s).`);
    return { restored };
  }

  /**
   * Tokens already on a map keep their own copy of all this, so stamping the
   * prototype fixes the NEXT one he drags out and nothing already placed.
   * Read-only; names what is stale.
   */
  static auditPlaced({ log = true } = {}) {
    const rows = [];
    for (const scene of (game.scenes ?? [])) {
      for (const tokenDoc of (scene.tokens ?? [])) {
        const actor = tokenDoc.actor;
        const want = VisionAudit.expected(actor);
        if (!want) continue;
        const stamp = VisionAudit.stampFor({ sight: tokenDoc.sight, detectionModes: tokenDoc.detectionModes },
          VisionAudit.sheetSenses(actor));
        if (stamp) rows.push({ token: tokenDoc.name, scene: scene.name, problems: stamp.changes.join("; ") });
      }
    }
    if (log) {
      console.log(`%c${LOG} — ${rows.length} placed token(s) disagree with their statblock`,
        "color:#d4af37;font-weight:bold");
      if (rows.length) console.table(rows.slice(0, 200));
      if (rows.length) console.log(`${LOG} | stamp them with game.aceQol.VisionAudit.stampPlaced()`);
    }
    return rows;
  }

  /** Stamp the tokens already on the maps. Only when he asks for it. */
  static async stampPlaced() {
    if (!game.user?.isGM) return { changed: 0 };
    let changed = 0;
    for (const scene of (game.scenes ?? [])) {
      for (const tokenDoc of (scene.tokens ?? [])) {
        try { if (await VisionAudit.stampToken(tokenDoc)) changed++; }
        catch (err) { console.warn(`${LOG} | could not stamp ${tokenDoc.name} on ${scene.name}:`, err); }
      }
    }
    console.log(`${LOG} | stamped ${changed} placed token(s). Undo with game.aceQol.VisionAudit.undo()`);
    ui.notifications?.info(`ACE: ${changed} placed token(s) now carry their senses.`);
    return { changed };
  }

  /* ── Startup ───────────────────────────────────────────────────────────── */

  /**
   * At init: the Truesight vision mode and the pass's marker. A vision mode
   * has to exist before the map draws its first vision.
   *
   * ⚠️ SAFE IF ACE IS EVER SWITCHED OFF. Foundry's vision source falls back to
   * Basic for a mode it does not know (point-vision-source.mjs), so a token
   * stamped Truesight keeps its range and simply renders as Basic.
   */
  static registerAtInit() {
    try {
      game.settings.register(MODULE_ID, "visionPass", { scope: "world", config: false, type: Number, default: 0 });
    } catch (err) {
      console.warn(`${LOG} | could not register the vision pass marker; the pass runs every time:`, err);
    }
    try {
      const VisionMode = foundry.canvas?.perception?.VisionMode;
      if (!VisionMode || CONFIG.Canvas?.visionModes?.truesight) return;
      const levels = VisionMode.LIGHTING_LEVELS, visibility = VisionMode.LIGHTING_VISIBILITY;
      // Darkvision's own lighting (it sees in the dark out to its range) in colour.
      CONFIG.Canvas.visionModes.truesight = new VisionMode({
        id: "truesight",
        label: "DND5E.SenseTruesight",
        lighting: {
          levels: { [levels.DIM]: levels.BRIGHT },
          background: { visibility: visibility.REQUIRED },
        },
        vision: {
          darkness: { adaptive: false },
          defaults: { attenuation: 0, contrast: 0, saturation: 0, brightness: 0 },
        },
      });
    } catch (err) {
      console.warn(`${LOG} | could not add the Truesight vision mode; truesight tokens use Basic Vision:`, err);
    }
  }

  /** At ready: the API, the drop stamp and the one pass. */
  static register() {
    try {
      if (!game.aceQol) game.aceQol = {};
      game.aceQol.VisionAudit = VisionAudit;
      Hooks.on("createToken", (tokenDoc) => {
        // One GM stamps it; a player's drop is stamped by the GM's client.
        if (game.users?.activeGM !== game.user) return;
        VisionAudit.stampToken(tokenDoc)
          .catch(err => console.warn(`${LOG} | could not stamp ${tokenDoc?.name ?? "a new token"} with its senses:`, err));
      });
      // Registered from inside ready: run it now, never on a ready hook.
      VisionAudit.pass()
        .catch(err => console.warn(`${LOG} | the one pass over the world's creatures failed:`, err));
      console.debug(`${LOG} | ready — new tokens take their creature's senses; game.aceQol.VisionAudit.audit()`);
    } catch (err) {
      console.warn(`${LOG} | could not publish the vision audit:`, err);
    }
  }
}
