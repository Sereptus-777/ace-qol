// ─── What ACE has worked out, remembered ────────────────────────────────────
//
// Johnny, 2026-08-28: "It should also memorize that and make a preset for that
// particular attack spell or whatever feature trait... it's almost just like a
// memory store, right?"
//
// The classifier can work out a plan for an item nobody ever registered. This is
// where that plan is written down, so the second time the button is pushed the
// answer is instant, and so the same creature resolves the same way twice.
//
// ⚠️ CONSISTENCY IS THE REAL REASON, NOT SPEED. Re-deriving on every cast is
// cheap. What is not acceptable is a spell resolving one way at the start of a
// fight and another way at the end because an item was edited mid-session or a
// description was tweaked. A remembered plan is a plan the table can rely on.
//
// ⚠️ A HUMAN CORRECTION IS PERMANENT AND OUTRANKS EVERYTHING. When Johnny fixes
// what ACE guessed, that fix must survive the next boot, the next re-read and
// the next version of the classifier. An engine that quietly re-guesses over a
// correction teaches you never to correct it.
//
// ⚠️ THE FINGERPRINT IS THE POINT. Remembering by name alone means editing a
// spell leaves ACE acting on the old reading forever, which is the worst kind of
// stale: invisible, and only wrong sometimes. The key carries a hash of the
// facts that produced the plan, so changing the item produces a different key
// and a fresh reading, while a human correction is stored against the NAME and
// therefore survives edits on purpose.
//
// ⚠️ WORLD-SCOPED AND GM-WRITTEN. Every client has to agree on the rules or two
// players see different outcomes for one action, and world settings are pushed
// to everybody. Only the active GM writes, for the same reason only one client
// rolls a save.
// ⚠️ MODULE_ID IS HARDCODED, MATCHING THE CONVENTION ALREADY IN THIS
// CODEBASE. ace-qol.mjs imports this file, so importing MODULE_ID back out of
// it is a cycle: ES modules evaluate the imported file's body FIRST, and the
// const is still in its temporal dead zone. concentration-widget.mjs,
// blade-cantrips.mjs, death-pipeline.mjs and diagnostics.mjs all do exactly
// this, one of them with the comment "hardcoded to avoid circular import".
// The first version of this file imported it and threw at load, which in
// Foundry is the entry file failing and the whole module going dark.
const MODULE_ID = "ace-qol";

const SETTING = "learnedShapes";

const TAG = () => `${MODULE_ID} | learned`;

/** Keep the store from growing without bound in a long-lived world. */
const MAX_ENTRIES = 4000;

const _norm = (s) => String(s ?? "").toLowerCase()
  .replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();

/**
 * A short, stable hash of the facts that produced a plan.
 *
 * ⚠️ NOT A CRYPTOGRAPHIC HASH AND DOES NOT NEED TO BE. It only has to change
 * when the item changes. A collision costs one stale reading until the next
 * edit, which is the same cost as not fingerprinting at all.
 */
function fingerprint(facts) {
  try {
    const f = facts ?? {};
    const bits = [
      f.itemType, f.trigger?.kind, f.cost?.action, f.cost?.slotLevel,
      f.scope?.kind, f.scope?.count, f.delivery?.kind, f.delivery?.rangeFt,
      f.delivery?.template?.shape, f.delivery?.template?.size,
      f.resolution?.kind, f.resolution?.saveAbility, f.resolution?.attacks,
      f.change?.damage?.map(d => d.formula).join("+"),
      f.change?.heals, f.change?.summons, f.change?.conditions?.join(","),
      f.duration?.kind, f.duration?.value, f.duration?.units,
    ].join("|");
    let h = 0;
    for (let i = 0; i < bits.length; i++) { h = ((h << 5) - h + bits.charCodeAt(i)) | 0; }
    return (h >>> 0).toString(36);
  } catch (_) { return "nofp"; }
}

export class LearnedStore {

  /** Everything remembered, as a plain object. Never throws. */
  static all() {
    try { return game.settings.get(MODULE_ID, SETTING) ?? {}; }
    catch (err) {
      // ⚠️ "COULD NOT READ THE STORE" IS NOT "NOTHING IS REMEMBERED", and the
      // difference matters: the second silently re-learns everything and can
      // overwrite corrections. Say it, and refuse to write this session.
      console.warn(`${TAG()} | could not read what ACE has learned; `
        + `nothing will be remembered this session:`, err);
      return null;
    }
  }

  static _key(item) { return _norm(item?.name) + "::" + (item?.type ?? "?"); }

  /**
   * The remembered plan for this item, or null.
   *
   * @param {Item}   item
   * @param {object} [facts]  the current reading, to check the item has not changed
   */
  static get(item, facts = null) {
    const store = LearnedStore.all();
    if (!store) return null;
    const rec = store[LearnedStore._key(item)];
    if (!rec) return null;

    // ⚠️ A CORRECTION IGNORES THE FINGERPRINT ON PURPOSE. Johnny fixing a shape
    // is a statement about the SPELL, not about one revision of its data. If he
    // edits the description afterwards, his ruling still stands.
    if (rec.correctedByHuman) return rec;

    if (facts && rec.fingerprint && rec.fingerprint !== fingerprint(facts)) {
      console.log(`${TAG()} | "${item?.name}" has changed since ACE last read it — reading again`);
      return null;
    }
    return rec;
  }

  /**
   * Remember a plan ACE worked out.
   *
   * ⚠️ NEVER OVERWRITES A HUMAN CORRECTION, and never writes from a client that
   * is not the acting GM.
   */
  static async remember(item, result) {
    try {
      if (game.users?.activeGM !== game.user) return false;
      if (!result?.shape) return false;
      const store = LearnedStore.all();
      if (!store) return false;

      const key = LearnedStore._key(item);
      if (store[key]?.correctedByHuman) return false;

      const next = { ...store };
      if (Object.keys(next).length >= MAX_ENTRIES && !next[key]) {
        // Drop the oldest machine-written entry. Corrections are never dropped.
        const oldest = Object.entries(next)
          .filter(([, v]) => !v.correctedByHuman)
          .sort((a, b) => (a[1].learnedAt ?? 0) - (b[1].learnedAt ?? 0))[0];
        if (oldest) delete next[oldest[0]];
      }

      next[key] = {
        name: item?.name ?? null,
        shape: result.shape,
        entry: result.entry ?? null,
        confidence: result.confidence ?? null,
        evidence: (result.evidence ?? []).slice(0, 12),
        fingerprint: fingerprint(result.facts),
        learnedAt: Date.now(),
        correctedByHuman: false,
      };
      await game.settings.set(MODULE_ID, SETTING, next);
      console.log(`${TAG()} | remembered "${item?.name}" as ${result.shape}`);
      return true;
    } catch (err) {
      console.warn(`${TAG()} | could not remember "${item?.name}":`, err);
      return false;
    }
  }

  /** A human says the shape is this. Permanent, and outranks the classifier. */
  static async correct(item, shape, entry = null) {
    try {
      if (!game.user?.isGM) return false;
      const store = LearnedStore.all();
      if (!store) return false;
      const key = LearnedStore._key(item);
      const next = { ...store };
      next[key] = {
        ...(next[key] ?? {}),
        name: item?.name ?? null,
        shape, entry: entry ?? next[key]?.entry ?? null,
        confidence: "corrected",
        correctedByHuman: true,
        correctedAt: Date.now(),
      };
      await game.settings.set(MODULE_ID, SETTING, next);
      console.log(`${TAG()} | "${item?.name}" corrected to ${shape} by ${game.user.name}`);
      return true;
    } catch (err) {
      console.warn(`${TAG()} | could not record the correction for "${item?.name}":`, err);
      return false;
    }
  }

  /** Forget one item, or everything the machine worked out. */
  static async forget(item = null, { keepCorrections = true } = {}) {
    try {
      if (!game.user?.isGM) return false;
      const store = LearnedStore.all();
      if (!store) return false;
      if (item) {
        const next = { ...store };
        delete next[LearnedStore._key(item)];
        await game.settings.set(MODULE_ID, SETTING, next);
        return true;
      }
      const next = keepCorrections
        ? Object.fromEntries(Object.entries(store).filter(([, v]) => v.correctedByHuman))
        : {};
      await game.settings.set(MODULE_ID, SETTING, next);
      console.log(`${TAG()} | forgot everything ACE worked out`
        + (keepCorrections ? ", keeping your corrections" : ", corrections included"));
      return true;
    } catch (err) {
      console.warn(`${TAG()} | could not forget:`, err);
      return false;
    }
  }

  /** Counts for the review screen and the boot line. */
  static summary() {
    const store = LearnedStore.all();
    if (!store) return { total: 0, corrected: 0, unreadable: true };
    const rows = Object.values(store);
    return {
      total: rows.length,
      corrected: rows.filter(r => r.correctedByHuman).length,
      byShape: rows.reduce((m, r) => { m[r.shape] = (m[r.shape] ?? 0) + 1; return m; }, {}),
      unreadable: false,
    };
  }
}
