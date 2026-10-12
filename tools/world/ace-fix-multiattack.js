/* ═══════════════════════════════════════════════════════════════════════════
   ACE — CORRECT THE MULTIATTACK FILL (only what that run wrote)
   ═══════════════════════════════════════════════════════════════════════════

   His rules, 2026-10-10, after the first fill:

     "Do not run the fill again... Correct only the ones that run wrote. The
      original text is still on the feature. Read it again and replace the
      buttons you added. Leave the 31 that already had attacks before this run.
      1. A number in the text wins... on every copy of that creature.
      2. The word 'or' is a choice, not a pile... the first option only.
      3. If the text gives no number, take the buttons off again and write
         nothing... Log the creature.
      An attack whose name says it is only for a form stays out of the chain
      unless every attack in that chain is the same form.
      Do not touch a chain that came from a real count and has no 'or' in it."

   WHAT IT TOUCHES: only Multiattack features carrying activities the fill
   wrote, which are the ones marked `flags["ace-qol"].multiattackFrom`. A
   feature with attacks and no mark was there before the fill and is not read.

   WHAT IT READS: the feature's own text with the fill's sentence taken off,
   then the creature's stat block, then the same creature on any other copy
   (world, compendium, token) whose text gives a number - so three tentacles
   is three on every copy - then an unlocked compendium of this world. The
   reading is ACE's own `MultiattackEngine.readChain`, the same reader the
   chain pop-up uses, so the buttons and the pop-up cannot disagree.

   PER FEATURE:
     - the chain it should have is the chain it has: left alone;
     - it should have a different chain: the fill's buttons and sentence come
       off and the right ones go on;
     - the text gives no number: the fill's buttons and sentence come off and
       nothing is written; the creature is logged.
   Nothing else on any sheet changes. Every result is read back.
   ═══════════════════════════════════════════════════════════════════════════ */
(async () => {
  const LOG = "ACE Multiattack correction";
  if (!game.user?.isGM) { ui.notifications.warn(`${LOG}: GM only.`); return; }

  const { MultiattackEngine: ME } = await import(
    `/modules/ace-qol/scripts/multiattack-engine.mjs?v=${Date.now()}`);

  const NUM = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight",
    "nine", "ten", "eleven", "twelve"];
  const word = (n) => NUM[n] ?? String(n);
  const baseName = (s) => String(s ?? "").toLowerCase().replace(/\(.*?\)/g, "").trim();
  // The sentence the fill appended, and only that: the last paragraph, in the
  // exact shape the fill wrote it.
  const FILL_SENTENCE = /\n?<p>Makes [a-z0-9]+ attacks?: [\s\S]*?<\/p>\s*$/i;

  const flaggedOn = (ma) => {
    const acts = ma?.system?.activities;
    const list = acts ? [...(acts.values?.() ?? Object.values(acts))] : [];
    return list.filter(a => a?.flags?.["ace-qol"]?.multiattackFrom)
      .sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0));
  };

  /** The text this copy carries, with the fill's sentence taken off. */
  const ownTexts = (actor, ma) => {
    const original = String(ma?.system?.description?.value ?? "").replace(FILL_SENTENCE, "");
    const fake = { system: { description: { value: original } } };
    return { original, text: ME._multiattackText(actor, fake) };
  };

  // ── Every copy of every creature, so the counts agree across copies ──
  const copies = [];
  for (const a of game.actors) if (!a.hasPlayerOwner) copies.push({ actor: a, where: "world" });
  const packs = [];
  const skippedPacks = [];
  for (const pack of game.packs) {
    if (pack.documentName !== "Actor") continue;
    const kind = pack.metadata?.packageType;
    if (kind === "world" && !pack.locked) packs.push(pack);
    else skippedPacks.push(`${pack.collection} (${kind === "world" ? "locked" : kind})`);
  }
  for (const pack of packs) {
    try {
      for (const a of await pack.getDocuments()) if (!a.hasPlayerOwner) copies.push({ actor: a, where: pack.collection });
    } catch (err) { console.warn(`${LOG} | could not open ${pack.collection}:`, err); }
  }
  const tokenCopies = [];
  for (const scene of game.scenes) {
    for (const tok of scene.tokens) {
      if (tok.actorLink || !tok.actor || tok.actor.hasPlayerOwner) continue;
      // The token, not its actor: a synthetic actor is rebuilt when its base
      // changes, so it is looked up again at the moment it is corrected.
      tokenCopies.push({ tok, where: `token on ${scene.name}` });
    }
  }

  // The best text per creature: the first copy whose text gives a number.
  const bestText = new Map();
  for (const c of [...copies, ...tokenCopies]) {
    const actor = c.actor ?? c.tok?.actor;
    if (!actor) continue;
    const key = baseName(actor.name);
    if (bestText.has(key)) continue;
    const ma = actor.items.find(i => ME.isMultiattackFeature(i));
    if (!ma) continue;
    const { text } = ownTexts(actor, ma);
    if (ME.readChain(text, ME._getAttackItems(actor)).entries) bestText.set(key, text);
  }

  const report = { rewrote: [], cleared: [], left: [], failed: [], orKept: [], formOut: [] };

  const fix = async ({ actor, where }) => {
    const ma = actor.items.find(i => ME.isMultiattackFeature(i));
    if (!ma) return;
    const mine = flaggedOn(ma);
    if (!mine.length) return;          // not written by the fill: never read

    const items = ME._getAttackItems(actor);
    const { original, text } = ownTexts(actor, ma);
    let reading = ME.readChain(text, items);
    let from = "its own text";
    if (!reading.entries) {
      const shared = bestText.get(baseName(actor.name));
      if (shared) {
        const r = ME.readChain(shared, items);
        if (r.entries) { reading = r; from = "another copy of the same creature"; }
      }
    }

    const label = `${actor.name} (${where})`;
    const current = mine.map(a => a.flags["ace-qol"].multiattackFrom.itemId);

    // Rule 3: no number, no chain. Buttons and sentence off, nothing written.
    if (!reading.entries) {
      const update = Object.fromEntries(mine.map(a => [`system.activities.-=${a.id}`, null]));
      update["system.description.value"] = original;
      try { await ma.update(update); }
      catch (err) { report.failed.push(`${label}: ${err?.message ?? err}`); return; }
      const still = flaggedOn(actor.items.get(ma.id));
      if (still.length) { report.failed.push(`${label}: ${still.length} buttons would not come off`); return; }
      report.cleared.push(label);
      console.log(`${LOG} | ${label}: its text gives no number for any attack, so its buttons were `
        + `taken off and nothing was written.`);
      return;
    }

    const wanted = [];
    for (const e of reading.entries) for (let n = 0; n < e.count; n++) wanted.push(e);
    const same = wanted.length === current.length && wanted.every((e, i) => e.item.id === current[i]);
    // Already right. With an "or" in it, the option it kept is still said.
    if (same) {
      report.left.push(label);
      if (reading.kept) report.orKept.push(`${label}: kept "${reading.kept}", left out "${reading.dropped}" (already so)`);
      return;
    }

    // Rewrite: the fill's buttons off, the right ones on, one update.
    const update = Object.fromEntries(mine.map(a => [`system.activities.-=${a.id}`, null]));
    const made = [];
    let sort = 0;
    for (const e of wanted) {
      const src = ME.mainAttackActivity(e.item);
      if (!src) continue;
      sort += 100000;
      const data = ME.copyAttackActivity(e.item, src, { sort });
      update[`system.activities.${data._id}`] = data;
      made.push(data._id);
    }
    const total = reading.entries.reduce((n, e) => n + e.count, 0);
    const sentence = `Makes ${word(total)} attack${total === 1 ? "" : "s"}: `
      + reading.entries.map(e => `${word(e.count)} ${e.item.name}`).join(", ").replace(/, ([^,]*)$/, " and $1") + ".";
    update["system.description.value"] = `${original}${original ? "\n" : ""}<p>${sentence}</p>`;

    try { await ma.update(update); }
    catch (err) { report.failed.push(`${label}: ${err?.message ?? err}`); return; }
    const fresh = actor.items.get(ma.id);
    const now = fresh?.system?.activities;
    const landed = made.filter(id => now?.get?.(id) ?? now?.[id]);
    const stale = flaggedOn(fresh).filter(a => !made.includes(a.id));
    if (landed.length !== made.length || stale.length) {
      report.failed.push(`${label}: wrote ${made.length}, read back ${landed.length}, ${stale.length} old left`);
      return;
    }
    const chain = reading.entries.map(e => `${e.item.name} x${e.count}`).join(", ");
    report.rewrote.push(`${label}: ${chain} [from ${from}]`);
    if (reading.kept) report.orKept.push(`${label}: kept "${reading.kept}", left out "${reading.dropped}"`);
    if (reading.formDropped.length) report.formOut.push(`${label}: kept out ${reading.formDropped.join(", ")}`);
  };

  // World and compendium first, tokens last so they read their corrected base.
  for (const c of copies) {
    try { await fix(c); } catch (err) { report.failed.push(`${c.actor.name} (${c.where}): ${err?.message ?? err}`); }
  }
  for (const c of tokenCopies) {
    const actor = c.tok?.actor;
    if (!actor) continue;
    try { await fix({ actor, where: c.where }); }
    catch (err) { report.failed.push(`${actor.name} (${c.where}): ${err?.message ?? err}`); }
  }

  const lines = [];
  lines.push(`${LOG}: rewrote ${report.rewrote.length}, cleared (no number) ${report.cleared.length}, `
    + `left alone ${report.left.length}, failed ${report.failed.length}.`);
  const block = (title, arr) => { if (arr.length) lines.push(`\n${title} (${arr.length}):\n  ${arr.join("\n  ")}`); };
  block("REWROTE, AND WHAT THEY ARE NOW", report.rewrote);
  block("'OR': THE OPTION KEPT", report.orKept);
  block("FORM-ONLY ATTACKS KEPT OUT", report.formOut);
  block("CLEARED: THE TEXT GIVES NO NUMBER", report.cleared);
  block("FAILED", report.failed);
  lines.push(`\nLeft alone (already the right chain): ${report.left.length}. `
    + `Features the fill did not write were not read at all.`);
  block("PACKS SKIPPED", skippedPacks);
  console.log(lines.join("\n"));
  ui.notifications.info(`${LOG}: rewrote ${report.rewrote.length}, cleared ${report.cleared.length}, `
    + `left alone ${report.left.length}. The full list is in the console (F12).`, { permanent: true });
  return report;
})();
