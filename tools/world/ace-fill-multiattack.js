/* ═══════════════════════════════════════════════════════════════════════════
   ACE — FILL THE MULTIATTACK FEATURES
   ═══════════════════════════════════════════════════════════════════════════

   His rule, 2026-10-10: "The Multiattack feature on the sheet is empty. The
   button just says Multiattack. Fix it on the sheet, the same way the
   spellcasting feature got its spells... Under Features, the Multiattack item
   has to say what it does, and its button has to be those attacks."

   Per creature with a Multiattack feature:
     - already has its attacks (any attack activity on it): left alone;
     - otherwise the attacks are read, in this order:
         1. the text on the Multiattack feature itself,
         2. the creature's own stat block text (its biography),
         3. the same creature in an unlocked compendium of this world,
       and matched to the attack items on the sheet, in the text's order with
       the text's counts ("one bite and two claws" is Bite once, Claw twice);
     - when no text names the counts, the attack items on the sheet are used
       once each, in the order the sheet lists them;
     - when there is nothing to read and no attack on the sheet, nothing is
       invented and the creature is listed.
   Then the list goes on the feature as text (added after what is there,
   nothing removed) and one activity per attack goes on the same feature,
   copied from the real item by ACE's own MultiattackEngine.copyAttackActivity.
   Pressing one of those hands the press to the real item, so it is the same
   swing with the same riders - one system, not two.

   Player-owned actors are left alone. World actors, unlinked tokens on every
   scene, and every UNLOCKED compendium of this world are done; system, module
   and locked packs are named and skipped. Nothing else on any sheet changes.

   Every count is read back out of the world after the write, not assumed.
   ═══════════════════════════════════════════════════════════════════════════ */
(async () => {
  const LOG = "ACE Multiattack fill";
  if (!game.user?.isGM) { ui.notifications.warn(`${LOG}: GM only.`); return; }

  // ACE's own engine, fresh from disk, so this runs before a reload too. Its
  // reader, its parser and its copy are the same code the chain uses.
  const { MultiattackEngine: ME } = await import(
    `/modules/ace-qol/scripts/multiattack-engine.mjs?v=${Date.now()}`);

  const NUM = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight",
    "nine", "ten", "eleven", "twelve"];
  const word = (n) => NUM[n] ?? String(n);
  const says = (t) => !!t && /\b(one|two|three|four|five|six|seven|eight|\d+)\b[^.]{0,40}\battacks?\b/i.test(t);
  const STOP = new Set(["melee", "ranged", "weapon", "weapons", "natural", "spell", "spells",
    "attack", "attacks", "unarmed", "strike", "strikes", "different", "any", "combination",
    "them", "it", "its", "which", "following", "target", "targets"]);
  const baseName = (s) => String(s ?? "").toLowerCase().replace(/\(.*?\)/g, "").trim();
  const sing = (s) => s.replace(/(?:es|s)$/, "");

  const report = {
    filled: [], already: [], nothing: [], unmatched: [], noCopy: [], failed: [],
    noFeature: 0, playerOwned: [], skippedPacks: [],
  };

  // ── Unlocked world compendiums: what we write to, and where step 3 reads ──
  const worldPacks = [];
  for (const pack of game.packs) {
    if (pack.documentName !== "Actor") continue;
    const kind = pack.metadata?.packageType;
    if (kind === "world" && !pack.locked) worldPacks.push(pack);
    else report.skippedPacks.push(`${pack.collection} (${kind === "world" ? "locked" : kind})`);
  }
  const packActors = new Map();
  for (const pack of worldPacks) {
    try { packActors.set(pack, await pack.getDocuments()); }
    catch (err) { report.failed.push(`${pack.collection}: could not open (${err?.message ?? err})`); }
  }

  /** Step 3: the same creature, by name, in an unlocked world compendium. */
  const fromCompendium = (actor) => {
    for (const docs of packActors.values()) {
      for (const other of docs) {
        if (other === actor || other.uuid === actor.uuid) continue;
        if (baseName(other.name) !== baseName(actor.name)) continue;
        const ma = other.items.find(i => ME.isMultiattackFeature(i));
        const text = ME._multiattackText(other, ma);
        if (says(text)) return { text, from: `${other.name} in ${other.pack}` };
      }
    }
    return null;
  };

  /** Names the text gives that are not an attack on this sheet. */
  const unmatchedIn = (text, attackItems) => {
    const found = new Set();
    const t = String(text ?? "").toLowerCase();
    const add = (raw) => {
      const words = String(raw ?? "").trim().split(/\s+/).filter(w => w && !STOP.has(w));
      if (!words.length) return;
      found.add(words.join(" "));
    };
    for (const m of t.matchAll(/with (?:its|his|her|their) ([a-z][a-z' -]{1,30}?)(?=[,.;:]|\s+(?:and|or|attacks?)\b|$)/g)) add(m[1]);
    for (const m of t.matchAll(/\b(?:one|two|three|four|five|six|seven|eight|\d+)\s+([a-z][a-z'-]+(?:\s+[a-z][a-z'-]+)?)\s+attacks?\b/g)) add(m[1]);
    const names = attackItems.map(i => sing(baseName(i.name)));
    return [...found].filter(cand => {
      const c = sing(cand);
      return !names.some(n => n && (n === c || c.includes(n) || n.includes(c)));
    });
  };

  /** One creature. `where` is how the report names it. */
  const doActor = async (actor, where) => {
    const ma = actor.items.find(i => ME.isMultiattackFeature(i));
    if (!ma) { report.noFeature++; return; }

    const acts = ma.system?.activities;
    const list = acts ? [...(acts.values?.() ?? Object.values(acts))] : [];
    if (list.some(a => a?.type === "attack" || a?.flags?.["ace-qol"]?.multiattackFrom)) {
      report.already.push(`${actor.name} (${where})`);
      return;
    }

    const attackItems = [...ME._getAttackItems(actor)].sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0));

    // Steps 1 and 2: the feature's own text, then the creature's stat block.
    const ownText = ME._plainText(ma.system?.description?.value ?? "");
    let text = ME._multiattackText(actor, ma);
    let from = says(ownText) ? "the Multiattack feature's own text"
      : (says(text) ? "the creature's stat block text" : null);
    // Step 3: the same creature in an unlocked compendium.
    if (!from) {
      const c = fromCompendium(actor);
      if (c) { text = c.text; from = c.from; }
    }

    let entries = from ? ME._parseMultiattack(text, attackItems) : null;
    if (entries) entries = [...entries].sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
    else if (attackItems.length) {
      // Each attack once, but only the ones made with an ACTION. A tail swipe
      // that costs a legendary action or a reaction is not part of Multiattack.
      const onAction = attackItems.filter(item => {
        const t = ME.mainAttackActivity(item)?.activation?.type ?? "action";
        return !t || t === "action";
      });
      entries = (onAction.length ? onAction : attackItems).map(item => ({ item, count: 1 }));
      from = from ? `${from}, which names no count, so each attack on the sheet once`
        : "no text names them, so each attack on the sheet once, in the sheet's order";
    }

    if (from && text) {
      for (const name of unmatchedIn(text, attackItems)) {
        report.unmatched.push(`${actor.name} (${where}): "${name}"`);
      }
    }

    if (!entries?.length) {
      report.nothing.push(`${actor.name} (${where})`);
      console.log(`${LOG} | ${actor.name} (${where}): nothing names its attacks and it has no attack `
        + `on its sheet, so nothing was written.`);
      return;
    }

    // One activity per attack, copied from the real item.
    const update = {};
    const made = [];
    let sort = 0;
    for (const { item, count } of entries) {
      const src = ME.mainAttackActivity(item);
      if (!src) { report.noCopy.push(`${actor.name} (${where}): ${item.name} has no attack to copy`); continue; }
      for (let n = 0; n < count; n++) {
        sort += 100000;
        const data = ME.copyAttackActivity(item, src, { sort });
        update[`system.activities.${data._id}`] = data;
        made.push(data._id);
      }
    }
    if (!made.length) {
      report.nothing.push(`${actor.name} (${where}) - its attacks have nothing to copy`);
      return;
    }

    // The list as text, after whatever is there. Nothing is removed. When the
    // feature's own text already named them, its text is already the list.
    const named = entries.filter(e => ME.mainAttackActivity(e.item));
    const total = named.reduce((n, e) => n + e.count, 0);
    const sentence = `Makes ${word(total)} attack${total === 1 ? "" : "s"}: `
      + named.map(e => `${word(e.count)} ${e.item.name}`).join(", ").replace(/, ([^,]*)$/, " and $1") + ".";
    if (!says(ownText)) {
      const had = String(ma.system?.description?.value ?? "");
      update["system.description.value"] = `${had}${had ? "\n" : ""}<p>${sentence}</p>`;
    }

    try {
      await ma.update(update);
    } catch (err) {
      report.failed.push(`${actor.name} (${where}): ${err?.message ?? err}`);
      return;
    }

    // Read it back before claiming it.
    const fresh = actor.items.get(ma.id);
    const now = fresh?.system?.activities;
    const landed = made.filter(id => now?.get?.(id) ?? now?.[id]);
    if (landed.length !== made.length) {
      report.failed.push(`${actor.name} (${where}): wrote ${made.length}, read back ${landed.length}`);
      return;
    }
    report.filled.push(`${actor.name} (${where}): ${named.map(e => `${e.item.name} x${e.count}`).join(", ")} `
      + `[from ${from}]`);
  };

  // ── World actors ──
  for (const actor of game.actors) {
    if (actor.hasPlayerOwner) { report.playerOwned.push(actor.name); continue; }
    try { await doActor(actor, "world"); }
    catch (err) { report.failed.push(`${actor.name} (world): ${err?.message ?? err}`); }
  }

  // ── Unlocked world compendiums ──
  for (const [pack, docs] of packActors) {
    for (const actor of docs) {
      if (actor.hasPlayerOwner) { report.playerOwned.push(`${actor.name} (${pack.collection})`); continue; }
      try { await doActor(actor, pack.collection); }
      catch (err) { report.failed.push(`${actor.name} (${pack.collection}): ${err?.message ?? err}`); }
    }
  }

  // ── Unlinked tokens on every scene, last, so most read their fixed base ──
  for (const scene of game.scenes) {
    for (const tok of scene.tokens) {
      if (tok.actorLink || !tok.actor) continue;
      if (tok.actor.hasPlayerOwner) continue;
      try { await doActor(tok.actor, `token on ${scene.name}`); }
      catch (err) { report.failed.push(`${tok.name} (token on ${scene.name}): ${err?.message ?? err}`); }
    }
  }

  // ── The report ──
  const lines = [];
  lines.push(`${LOG}: filled ${report.filled.length}, already had them ${report.already.length}, `
    + `nothing to read ${report.nothing.length}, failed ${report.failed.length}.`);
  const block = (title, arr) => { if (arr.length) lines.push(`\n${title} (${arr.length}):\n  ${arr.join("\n  ")}`); };
  block("FILLED", report.filled);
  block("ALREADY HAD THEIR ATTACKS", report.already);
  block("NOTHING TO READ, NOTHING INVENTED", report.nothing);
  block("NAMES IN THE TEXT THAT MATCH NO ATTACK ON THE SHEET", report.unmatched);
  block("ATTACK ITEMS WITH NO ATTACK TO COPY", report.noCopy);
  block("FAILED", report.failed);
  block("PACKS SKIPPED (system, module or locked)", report.skippedPacks);
  lines.push(`\nPlayer-owned actors left alone: ${report.playerOwned.length}. `
    + `Creatures with no Multiattack feature: ${report.noFeature}.`);
  console.log(lines.join("\n"));
  ui.notifications.info(`${LOG}: filled ${report.filled.length}, already had ${report.already.length}, `
    + `nothing to read ${report.nothing.length}. The full list is in the console (F12).`, { permanent: true });
  return report;
})();
