// ─── ACE: QOL — Put back the rules a spell's effect lost ────────────────────
//
// ⚠️🔴 111 SPELLS ON 18 CREATURES IN HIS WORLD CARRIED EFFECTS WITH NOTHING IN
// THEM. Johnny, 2026-09-11: Ray of Enfeeblement did nothing to Neferon. One
// cause was ACE, which never put a spell's own effect on anybody. The other was
// the spell: Varek Thalor's copy of "Enervated" had none of the six rules the
// book gives it (minus 1d8 on damage, disadvantage on Strength) and no one-minute
// duration. Measured across the hijinx world, 111 spells on 18 creatures were
// the same, 74 of them Varek's; Shield, Bless, Mage Armor and Barkskin on the
// rest. The books ship them whole: the Monster Manual's own Archmage has a
// working Mage Armor and the one in his world did not.
//
// Not proven: what emptied them. 62 were created in the same minute on
// 2026-05-05, most carry a Scene Packer stamp, and the pack they came from is
// not installed any more, so its own copy cannot be checked.
//
// This refills them from the book the spell came from, and nothing else:
//   - only an effect with NO rules whose original in the book HAS rules
//   - matched by the effect's own id AND the spell's name, never the id alone
//     (a Ranger's "Roving" shares an effect id with a spell in the books)
//   - only the rules and the missing duration are written; the name, statuses,
//     description, flags and everything else on the creature are left alone
//   - what it replaced is saved on the effect in the same write, so it undoes
//
//     game.aceQol.refillSpellEffects()                 look first: writes nothing
//     game.aceQol.refillSpellEffects({ apply: true })  refill them
//     game.aceQol.refillSpellEffects({ undo: true })   put every one back
//
// ⚠️ GM ONLY, AND NEVER ON ITS OWN. A tool that writes to a world runs because
// the GM asked it to, with a list of exactly what it did. On 2026-09-06 a sweep
// that ran unasked overwrote 1,073 documents with no way back.
//
// ⚠️ MODULE_ID IS WRITTEN OUT, NOT IMPORTED. This is reached from the entry
// file, and importing it back would be a cycle that throws at load.
// ──────────────────────────────────────────────────────────────────────────────

const MODULE_ID = "ace-qol";
const LOG = `${MODULE_ID} | refillSpellEffects`;

/** The books a spell can have come from, oldest first. */
const BOOKS = ["dnd5e.spells", "dnd5e.spells24", "dnd-players-handbook.spells"];
/** The only duration fields this ever fills, and only where his copy has none. */
const DURATION_KEYS = ["seconds", "rounds", "turns"];

const norm = (n) => String(n ?? "").toLowerCase()
  .replace(/\s*\((legacy|2014|2024)\)\s*$/, "")
  .replace(/[^a-z0-9]+/g, " ").trim();

/**
 * Refill, preview, or undo.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.apply]  write the refills (default: only list them)
 * @param {boolean} [opts.undo]   put back everything a refill changed
 * @returns {Promise<object|null>}
 */
export async function refillSpellEffects({ apply = false, undo = false } = {}) {
  if (!game.user?.isGM) {
    ui.notifications?.warn("Only a GM can refill spell effects.");
    return null;
  }
  if (undo) return undoRefill();

  const index = await bookIndex();
  if (!index.size) {
    console.warn(`${LOG} | none of the books (${BOOKS.join(", ")}) could be read, so there is `
      + `nothing to refill from. Nothing was written.`);
    return { found: 0, written: 0 };
  }

  const cache = new Map();
  const rows = [];
  for (const holder of collectHolders()) {
    for (const item of holder.items) {
      if (item?.type !== "spell") continue;
      const hollow = (item.effects?.contents ?? []).filter(e => !(e.changes?.length));
      if (!hollow.length) continue;
      const book = await findBookSpell(item, hollow, index, cache);
      if (!book) continue;
      for (const e of hollow) {
        const original = book.effects?.get?.(e.id);
        const originalRules = original?.toObject?.().changes ?? original?.changes ?? [];
        if (!original || !originalRules.length) continue;
        const have = e.toObject?.().duration ?? {};
        const want = original.toObject?.().duration ?? original.duration ?? {};
        const filled = {};
        for (const k of DURATION_KEYS) {
          if ((have[k] === null || have[k] === undefined) && want[k] !== null && want[k] !== undefined) {
            filled[k] = want[k];
          }
        }
        const update = { _id: e.id, changes: foundry.utils.deepClone(originalRules) };
        for (const [k, v] of Object.entries(filled)) update[`duration.${k}`] = v;
        // ⚠️ WHAT IT REPLACED TRAVELS IN THE SAME WRITE, so undo never depends on
        // a list kept somewhere else.
        update[`flags.${MODULE_ID}.refilled`] = {
          at: Date.now(), from: book.uuid,
          before: { changes: [], duration: Object.fromEntries(Object.keys(filled).map(k => [k, null])) },
        };
        rows.push({ holder: holder.label, holderKey: holder.key ?? holder.label, item, effect: e,
                    rules: originalRules.length,
                    filled: Object.keys(filled), from: book.uuid, update });
      }
    }
  }

  // ⚠️ KEYED BY THE CREATURE, NOT ITS NAME. Two creatures in his world are both
  // called "Empyrean" and two "Empyrean Iota"; counting by name merged them and
  // reported 16 creatures for 18.
  const byHolder = new Map();
  for (const r of rows) {
    if (!byHolder.has(r.holderKey)) byHolder.set(r.holderKey, { label: r.holder, spells: new Set() });
    byHolder.get(r.holderKey).spells.add(r.item.name);
  }
  const spellCount = [...byHolder.values()].reduce((n, h) => n + h.spells.size, 0);

  console.log(`${LOG} | ${rows.length} empty effect(s) in ${spellCount} spell(s) on `
    + `${byHolder.size} creature(s) can be refilled from the books.`);
  console.table(rows.map(r => ({ creature: r.holder, spell: r.item.name, effect: r.effect.name,
    rules: r.rules, duration: r.filled.join(", ") || "-", from: r.from })));

  if (!apply) {
    console.log(`${LOG} | nothing was written. Run it again with { apply: true } to refill them.`);
    return { found: rows.length, spells: spellCount, creatures: byHolder.size, written: 0 };
  }

  let written = 0;
  const failed = [];
  const byItem = new Map();
  for (const r of rows) {
    if (!byItem.has(r.item)) byItem.set(r.item, []);
    byItem.get(r.item).push(r);
  }
  for (const [item, list] of byItem) {
    try {
      await item.updateEmbeddedDocuments("ActiveEffect", list.map(r => r.update));
      written += list.length;
    } catch (err) {
      console.warn(`${LOG} | could not refill "${item.name}" on ${list[0]?.holder}:`, err);
      failed.push(`${item.name} on ${list[0]?.holder}`);
    }
  }
  console.log(`${LOG} | refilled ${written} of ${rows.length} effect(s).`
    + `${failed.length ? ` These did not take: ${failed.join("; ")}.` : ""}`);
  await postCard(byHolder, written, rows.length, failed);
  return { found: rows.length, spells: spellCount, creatures: byHolder.size, written, failed };
}

/** Put back every effect a refill changed, from what the refill saved on it. */
async function undoRefill() {
  let restored = 0;
  const failed = [];
  for (const holder of collectHolders()) {
    for (const item of holder.items) {
      const marked = (item.effects?.contents ?? []).filter(e => e.flags?.[MODULE_ID]?.refilled);
      if (!marked.length) continue;
      const updates = marked.map(e => {
        const before = e.flags[MODULE_ID].refilled.before ?? {};
        const u = { _id: e.id, changes: before.changes ?? [], [`flags.${MODULE_ID}.-=refilled`]: null };
        for (const [k, v] of Object.entries(before.duration ?? {})) u[`duration.${k}`] = v;
        return u;
      });
      try {
        await item.updateEmbeddedDocuments("ActiveEffect", updates);
        restored += updates.length;
      } catch (err) {
        console.warn(`${LOG} | could not undo "${item.name}" on ${holder.label}:`, err);
        failed.push(`${item.name} on ${holder.label}`);
      }
    }
  }
  console.log(`${LOG} | put back ${restored} effect(s) as they were before the refill.`
    + `${failed.length ? ` These did not take: ${failed.join("; ")}.` : ""}`);
  ui.notifications?.info(`Put back ${restored} spell effect(s) as they were.`);
  return { restored, failed };
}

/**
 * Everything that holds spells in the world: every actor in the sidebar, plus
 * any token that carries its own copy of an item (an unlinked token whose sheet
 * was edited on the map keeps its own items, and fixing the sidebar actor would
 * not reach them).
 */
function collectHolders() {
  const out = [];
  for (const actor of (game.actors?.contents ?? [])) {
    out.push({ key: actor.id ?? actor.name, label: actor.name, items: actor.items?.contents ?? [] });
  }
  for (const scene of (game.scenes?.contents ?? [])) {
    for (const td of (scene.tokens?.contents ?? [])) {
      if (td.actorLink) continue;
      const own = td.delta?.items;
      const ids = own ? [...(own.keys?.() ?? [])] : [];
      if (!ids.length || !td.actor) continue;
      const items = ids.map(id => td.actor.items?.get?.(id)).filter(Boolean);
      if (items.length) {
        out.push({ key: td.uuid ?? `${scene.id}.${td.id}`, label: `${td.name} (token on ${scene.name})`, items });
      }
    }
  }
  return out;
}

/** Name → the book copies of that spell, from every book that is installed. */
async function bookIndex() {
  const index = new Map();
  for (const id of BOOKS) {
    const pack = game.packs?.get?.(id);
    if (!pack) continue;
    try {
      const entries = await pack.getIndex({ fields: ["type", "system.source.rules"] });
      for (const e of entries) {
        if (e.type && e.type !== "spell") continue;
        const key = norm(e.name);
        if (!index.has(key)) index.set(key, []);
        index.get(key).push({ pack, id: e._id, rules: e.system?.source?.rules ?? null });
      }
    } catch (err) {
      console.warn(`${LOG} | could not read the book ${id}:`, err);
    }
  }
  return index;
}

/**
 * The book copy of this spell. Where the spell says where it came from, that
 * wins; otherwise the same name in a book, the same edition first.
 */
async function findBookSpell(item, hollow, index, cache) {
  const load = async (uuid) => {
    if (!uuid) return null;
    if (cache.has(uuid)) return cache.get(uuid);
    let doc = null;
    try { doc = await fromUuid(uuid); } catch (_) { doc = null; }
    cache.set(uuid, doc);
    return doc;
  };
  const same = (doc) => doc && doc.type === "spell" && norm(doc.name) === norm(item.name);
  // ⚠️🔴 WHERE A SPELL SAYS IT CAME FROM CAN BE EMPTY TOO. The Monster Manual
  // ships its Night Hag's Phantasmal Killer with no rules in it, and a copy that
  // names that creature as its source was being "refilled" from it: found,
  // matched, and left exactly as empty. A source only counts if it actually has
  // the rules this copy is missing; otherwise the spell books are asked.
  const hasRules = (doc) => hollow.some(e => {
    const o = doc?.effects?.get?.(e.id);
    return !!(o && (o.toObject?.().changes ?? o.changes ?? []).length);
  });

  const claimed = [
    ...hollow.map(e => String(e.origin ?? "")),
    String(item._stats?.compendiumSource ?? ""),
    String(item.flags?.core?.sourceId ?? ""),
  ].filter(u => u.startsWith("Compendium.") && u.includes(".Item."))
   .map(u => u.replace(/\.ActiveEffect\..*$/, ""));
  for (const uuid of [...new Set(claimed)]) {
    const doc = await load(uuid);
    if (same(doc) && hasRules(doc)) return doc;
  }

  const rules = String(item.system?.source?.rules ?? "");
  const hits = [...(index.get(norm(item.name)) ?? [])]
    .sort((a, b) => (String(b.rules) === rules) - (String(a.rules) === rules));
  for (const h of hits) {
    const uuid = `Compendium.${h.pack.collection}.Item.${h.id}`;
    const doc = await load(uuid);
    if (!same(doc)) continue;
    // ⚠️ THE BOOK COPY HAS TO BE THE SAME SPELL, NOT JUST THE SAME NAME. Its
    // effects must carry the ids his copy's effects carry, with rules in them.
    if (hasRules(doc)) return doc;
  }
  return null;
}

/** One card for the GM saying what changed, creature by creature. */
async function postCard(byHolder, written, total, failed) {
  const esc = (t) => foundry.utils.escapeHTML(String(t ?? ""));
  const list = [...byHolder.values()].sort((a, b) => b.spells.size - a.spells.size).map(({ label: who, spells }) => `
      <div style="display:flex;flex-wrap:wrap;gap:4px 8px;padding:4px 0;border-bottom:1px solid rgba(212,175,55,0.15);">
        <strong style="color:#e8d49a;white-space:nowrap;">${esc(who)}</strong>
        <span style="flex:1 1 12em;min-width:0;color:#c0b288;">${esc([...spells].sort().join(", "))}</span>
      </div>`).join("");
  const content = `
    <div style="background:linear-gradient(180deg,#141821 0%,#0b0e14 100%);border:1px solid #d4af37;
                border-radius:6px;padding:10px 12px;color:#f0e4c0;font-size:14px;line-height:1.4;">
      <div style="font-size:18px;font-weight:700;color:#d4af37;margin-bottom:6px;">Spell effects refilled</div>
      <div style="margin-bottom:8px;">${written} of ${total} empty effect(s) got back the rules their book
        gives them. Each keeps a record of what it had before, so this can be undone.</div>
      ${list}
      ${failed.length ? `<div style="margin-top:8px;color:#ffaa44;">These did not take: ${esc(failed.join("; "))}.</div>` : ""}
    </div>`;
  try {
    await ChatMessage.create({ content, whisper: game.users.filter(u => u.isGM).map(u => u.id),
                               speaker: { alias: "ACE" } });
  } catch (err) {
    console.warn(`${LOG} | the summary card did not post (the refill itself stands):`, err);
  }
}
