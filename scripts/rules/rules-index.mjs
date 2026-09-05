// ─── ACE: QOL — The Rules Index: what do the BOOKS say about this? ───────────
//
// Johnny, 2026-09-05, after an hour of working out why three heal spells were
// dead: "It has to compare it to the actual written rules, the 2014 and the
// 2024. I should be able to push a Pathfinder spell that accidentally got put
// in here, and it should work."
//
// ⚠️🔴 HE ASKED FOR THIS IN JUNE AND GOT A HAND-WRITTEN TABLE INSTEAD.
// `item-validator.mjs` carries his idea, dated 2026-06-28: "why can't the
// engine just CHECK that everything is built right?" Its own header promises
// "PHASE 2 (next): a curated RAW reference (2014 + 2024) so we validate against
// canonical book values". What got built was `raw-reference.mjs` — 58 entries,
// typed by hand. Fifty-eight, against a world of thousands of items. A written
// list can never win that race: every gap gets closed by writing entry 59, and
// the 60th button he presses still does nothing.
//
// ⚠️ THE BOOKS ARE ALREADY ON HIS DISK. dnd5e 5.3.3 ships TWENTY-TWO
// compendiums, and it keeps the two editions APART, which is the exact
// distinction I keep getting wrong:
//
//     dnd5e.spells             dnd5e.spells24
//     dnd5e.classfeatures      dnd5e.classes24
//     dnd5e.monsterfeatures    dnd5e.monsterfeatures24
//     dnd5e.items              dnd5e.equipment24
//
// Full mechanics and full text, no network, no licensing question, indexed once
// at boot. That is the source of truth this file reads. `raw-reference.mjs`
// stops being the library and becomes what it should always have been: a small
// override for the handful of things the SRD does not carry.
//
// ⚠️ NOT FINDING SOMETHING IS A REAL ANSWER, NOT A FAILURE. The SRD is a
// subset. A homebrew item, a third-party spell, a Pathfinder spell dropped in
// by accident: none of them are in these packs, and none of them are broken.
// They come back "no rules entry", the engine reads the item itself, and the
// button works. A lookup that invented a match would be far worse — it would
// compare his spell to a different spell with a similar name and then report a
// disagreement that does not exist. So an ambiguous match SAYS it is ambiguous
// and compares nothing.
//
// This file only FINDS the book entry. Comparing it to his item is the next
// step and lives elsewhere, because two readers of one thing drift apart.
// ──────────────────────────────────────────────────────────────────────────────

// ⚠️ HARDCODED, NOT IMPORTED. `MODULE_ID` lives in the entry file, which
// imports this one. Importing it back makes a cycle, and an imported const read
// at top level inside a cycle throws at load and takes the whole module with
// it (2026-08-28). Five other files hardcode it for the same reason.
const MODULE_ID = "ace-qol";
const LOG = `${MODULE_ID} | RulesIndex`;

/**
 * Which shipped compendiums belong to which edition.
 *
 * ⚠️ THE "24" SUFFIX IS THE SYSTEM'S OWN CONVENTION, not a guess: every 2024
 * pack in dnd5e 5.3.3 ends in it. Anything else that ships with the system is
 * 2014. Read off `system.json`, not from memory.
 *
 * ⚠️ ITEM PACKS ONLY. A button is an Item — a spell, a feat, a weapon, a piece
 * of equipment. Actor packs (monsters, heroes, actors24) hold stat blocks whose
 * FEATURES are already published separately in the monsterfeatures packs, so
 * indexing actors would cost seconds at boot and add nothing a button lookup
 * can use.
 */
const IS_2024_PACK = (packName) => /24$/.test(String(packName ?? ""));

/** Packs that are not rules at all — indexing them would pollute every lookup. */
const NEVER_INDEX = new Set([
  "dnd5e.tradegoods",       // commodities, no mechanics
]);

export class RulesIndex {

  /** edition -> Map(normalised name -> [hit, ...]) */
  static _byEdition = null;

  /** uuid -> loaded document, so a repeat press costs nothing. */
  static _docs = new Map();

  /** What happened at boot, for the report and for honest failure messages. */
  static _status = { built: false, packs: [], failed: [], counts: {}, startedAt: null };

  /* ── Boot ──────────────────────────────────────────────────────────────── */

  /**
   * Index every rules compendium. Idempotent.
   *
   * ⚠️ `game.ready` IS CHECKED, NOT WAITED ON. Every ACE subsystem starts from
   * inside the entry file's own ready handler, so `Hooks.once("ready")` from in
   * here would wait on an event already in progress and never fire — silently,
   * with nothing thrown and nothing logged (2026-08-12, thirteen condition
   * ghosts survived every load that way).
   */
  static async build() {
    if (RulesIndex._status.built) return RulesIndex._status;
    if (!game?.ready) {
      return new Promise((resolve) => {
        Hooks.once("ready", () => resolve(RulesIndex.build()));
      });
    }
    return RulesIndex._build();
  }

  static async _build() {
    RulesIndex._status.startedAt = Date.now();
    const byEdition = { "2014": new Map(), "2024": new Map() };
    const packs = [];
    const failed = [];

    for (const pack of (game.packs ?? [])) {
      try {
        if (pack.documentName !== "Item") continue;
        if (NEVER_INDEX.has(pack.collection)) continue;

        const index = await pack.getIndex();
        const isSystem = pack.metadata?.packageType === "system";

        // ⚠️ A WORLD OR MODULE PACK GOES IN BOTH EDITIONS ON PURPOSE. His
        // DDB-imported content is not shipped by the system and carries its own
        // edition ON EACH ITEM, so filing the whole pack under one edition
        // would hide half his library from half his items.
        const editions = isSystem
          ? [IS_2024_PACK(pack.collection) ? "2024" : "2014"]
          : ["2014", "2024"];

        let added = 0;
        for (const entry of index) {
          const key = RulesIndex.bookName(entry.name);
          if (!key) continue;
          const hit = {
            name: entry.name,
            type: entry.type,
            uuid: entry.uuid ?? `Compendium.${pack.collection}.${entry._id}`,
            pack: pack.collection,
            packLabel: pack.metadata?.label ?? pack.collection,
            official: isSystem,
          };
          for (const ed of editions) {
            const list = byEdition[ed].get(key);
            if (list) list.push(hit); else byEdition[ed].set(key, [hit]);
          }
          added++;
        }
        packs.push({ id: pack.collection, label: pack.metadata?.label, count: added,
                     editions: editions.join("+"), official: isSystem });
      } catch (err) {
        // ⚠️ A PACK THAT WILL NOT OPEN MUST NOT LOOK LIKE A PACK WITH NOTHING
        // IN IT. "Absent" and "broken" must never print the same message.
        failed.push({ id: pack?.collection ?? "?", reason: String(err?.message ?? err) });
        console.warn(`${LOG} | could not index "${pack?.collection}":`, err);
      }
    }

    RulesIndex._byEdition = byEdition;
    RulesIndex._status = {
      built: true,
      packs,
      failed,
      counts: { "2014": byEdition["2014"].size, "2024": byEdition["2024"].size },
      ms: Date.now() - RulesIndex._status.startedAt,
      startedAt: RulesIndex._status.startedAt,
    };

    const s = RulesIndex._status;
    console.log(`${LOG} | indexed ${packs.length} item compendium(s) in ${s.ms}ms — `
      + `${s.counts["2014"]} names under 2014, ${s.counts["2024"]} under 2024`
      + (failed.length ? ` — ${failed.length} pack(s) FAILED to open, see warnings above` : ""));

    // ⚠️ AN EMPTY INDEX IS A BROKEN FEATURE, NOT A QUIET ONE. Every comparison
    // downstream would silently report "no rules entry" for the entire game.
    if (!s.counts["2014"] && !s.counts["2024"]) {
      console.error(`${LOG} | NOTHING was indexed. Every rules comparison will come back `
        + `"no rules entry" for every item in the game. Check that the dnd5e system's `
        + `compendiums are present and not disabled.`);
      ui.notifications?.error("ACE could not read any rules compendium. Rules checking is off — see the console.");
    }
    return s;
  }

  /* ── Names ─────────────────────────────────────────────────────────────── */

  /**
   * An item's name as the BOOK would print it.
   *
   * Built on `RulesBrain.normalizeName`'s rules (lowercase, drop parentheticals
   * and brackets, collapse space) so "Aura of Vitality (Legacy)" finds "Aura of
   * Vitality" — but NOT by importing it, because this file is loaded by the
   * entry file and that import is a cycle.
   *
   * ⚠️ THE MAGIC BONUS COMES OFF, AND ONLY HERE. "Rapier +3" is a rapier as far
   * as the book is concerned; the +3 lives on his item and the item always wins
   * for the roll. That stripping is deliberately NOT in `normalizeName`, which
   * the curated registry keys off: a registry entry is allowed to be about a
   * specific magic weapon, and silently collapsing those would be a different
   * bug in a place nobody would look.
   */
  static bookName(name) {
    const base = String(name ?? "")
      .toLowerCase()
      .replace(/\s*\([^)]*\)\s*/g, " ")     // "(Legacy)", "(1/day)"
      .replace(/\s*\[[^\]]*\]\s*/g, " ")    // "[2024]"
      .replace(/[‘’]/g, "'")      // curly apostrophes: "Bigby's"
      .replace(/\s+/g, " ")
      .trim();
    return base;
  }

  /** "rapier +3" -> "rapier". Returns null when there is nothing to strip. */
  static _withoutBonus(key) {
    const stripped = String(key).replace(/\s*[+-]\d+\s*$/, "").trim();
    return stripped && stripped !== key ? stripped : null;
  }

  /* ── Lookup ────────────────────────────────────────────────────────────── */

  /**
   * What do the books say about this name?
   *
   * @param {string} name        the item's name, as printed on his sheet
   * @param {object} opts
   * @param {"2014"|"2024"} opts.edition   which book to open
   * @param {string} [opts.type]  "spell" | "weapon" | "feat" | ... narrows an
   *                              ambiguous name to the right kind of thing
   * @returns {{status, hits, key, edition, note}}
   *   status "found"      exactly one entry, safe to compare
   *          "ambiguous"  several entries and no way to choose — compare NOTHING
   *          "none"       not in the books; read the item itself
   *          "unbuilt"    the index never got built; this is OUR fault, not his data
   */
  static lookup(name, { edition = "2014", type = null } = {}) {
    const ed = edition === "2024" ? "2024" : "2014";

    // ⚠️ "NOT BUILT" AND "NOT FOUND" MUST NOT READ THE SAME. One means his
    // homebrew is fine and the engine will read the item; the other means every
    // comparison in the game is dead and somebody should be told.
    if (!RulesIndex._byEdition) {
      return { status: "unbuilt", hits: [], key: null, edition: ed,
               note: "the rules index has not been built yet" };
    }

    const map = RulesIndex._byEdition[ed];
    const key = RulesIndex.bookName(name);
    if (!key) return { status: "none", hits: [], key, edition: ed, note: "no name to look up" };

    let hits = map.get(key) ?? [];
    let usedKey = key;

    // A magic weapon is its base weapon in the book.
    if (!hits.length) {
      const bare = RulesIndex._withoutBonus(key);
      if (bare) {
        const alt = map.get(bare) ?? [];
        if (alt.length) { hits = alt; usedKey = bare; }
      }
    }

    if (!hits.length) {
      return { status: "none", hits: [], key: usedKey, edition: ed,
               note: `"${name}" is not in the ${ed} books — the engine reads the item itself` };
    }

    // Narrow by kind when we were told one. A feat and a spell can share a name.
    let narrowed = type ? hits.filter(h => h.type === type) : hits;
    if (!narrowed.length) narrowed = hits;

    // ⚠️ OFFICIAL BEATS A COPY OF ITSELF. His world almost certainly holds
    // imported duplicates of SRD spells. Two hits that are the same spell from
    // two places is not a real ambiguity, so prefer the system's own and only
    // call it ambiguous when the shipped books genuinely disagree.
    const official = narrowed.filter(h => h.official);
    if (official.length) narrowed = official;

    if (narrowed.length > 1) {
      return { status: "ambiguous", hits: narrowed, key: usedKey, edition: ed,
               note: `"${name}" matches ${narrowed.length} entries in the ${ed} books `
                   + `(${narrowed.map(h => h.packLabel).join(", ")}) — nothing compared` };
    }
    return { status: "found", hits: narrowed, key: usedKey, edition: ed, note: null };
  }

  /**
   * Load the full book entry behind a hit. Cached, so a second press is free.
   *
   * ⚠️ RETURNS null AND SAYS WHY. A hit that will not load is a different thing
   * from a name that is not in the books, and a caller that cannot tell them
   * apart will report the wrong one to him.
   */
  static async document(hit) {
    if (!hit?.uuid) return null;
    if (RulesIndex._docs.has(hit.uuid)) return RulesIndex._docs.get(hit.uuid);
    try {
      const doc = await fromUuid(hit.uuid);
      RulesIndex._docs.set(hit.uuid, doc ?? null);
      if (!doc) console.warn(`${LOG} | "${hit.name}" is in the index but would not load (${hit.uuid}).`);
      return doc ?? null;
    } catch (err) {
      console.warn(`${LOG} | could not load "${hit.name}" from ${hit.pack}:`, err);
      RulesIndex._docs.set(hit.uuid, null);
      return null;
    }
  }

  /** One call that does both, for the common case. */
  static async find(name, opts = {}) {
    const res = RulesIndex.lookup(name, opts);
    if (res.status !== "found") return { ...res, doc: null };
    return { ...res, doc: await RulesIndex.document(res.hits[0]) };
  }

  /* ── Report ────────────────────────────────────────────────────────────── */

  /** What got indexed, printed as a table. `game.aceQol.rulesIndexReport()`. */
  static report() {
    const s = RulesIndex._status;
    if (!s.built) { console.log(`${LOG} | not built yet.`); return s; }
    console.log(`${LOG} | ${s.packs.length} compendium(s), ${s.counts["2014"]} names under `
      + `2014 and ${s.counts["2024"]} under 2024, built in ${s.ms}ms`);
    console.table(s.packs);
    if (s.failed.length) { console.warn(`${LOG} | packs that would not open:`); console.table(s.failed); }
    return s;
  }
}
