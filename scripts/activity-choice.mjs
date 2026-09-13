// ─── ACE: QOL — Which activity does a press mean? ────────────────────────────
//
// dnd5e asks "which activity?" in its ActivityChoiceDialog whenever an item has
// more than one. ACE answers that question here, in one place, and the dialog
// hook in ace-qol.mjs only carries the answer out: it presses a button, opens
// ACE's picker, shows dnd5e's own dialog, or closes it.
//
// ⚠️🔴 A DECISION, NOT A DIALOG, SO IT CAN BE REPLAYED. This file imports
// nothing and touches no page, so tools/replay-selftest.mjs puts every item in
// his world through it before a release. The chooser broke three times in a
// fortnight (Magic Missile asking which row, Prismatic Wall taking the Blinding
// Save, Neferon's Claws asking "Attack or Save?"), and each time his table was
// the first to find out. Johnny, 2026-09-11: "We have to go through it one by
// one. When we do a sweep or something like that, all the rest of it gets
// fucking lost."
//
// (Moved here out of ace-qol.mjs on 2026-09-12, rule for rule.)
// ──────────────────────────────────────────────────────────────────────────────

const call = (v, fallback) => (typeof v === "function" ? v() : (v ?? fallback));

/**
 * @param {object} args
 * @param {object}   args.item          the item being used
 * @param {object[]|null} args.activities  every activity on it, or null when there is no dialog to read
 * @param {string[]} args.offeredIds    the activities the dialog has a button for, in its order
 * @param {(a: object) => boolean} args.isMachinery  dnd5e's own "not an action a person takes"
 * @param {Set<string>|(() => Set<string>)} args.riderIds  saves ACE asks for after a hit
 * @param {boolean|(() => boolean)} args.owns            SpellPipeline.owns(item)
 * @param {boolean|(() => boolean)} args.resolvesItself  SpellPipeline.resolvesItself(item)
 * @returns {{kind: "fire"|"ask"|"reveal"|"close", activity?: object|null, activityId?: string,
 *            choices?: object[], duplicates?: {twins: string[], clones: string[]},
 *            notes: string[], why: string}}
 */
export function decideActivityChoice({ item, activities, offeredIds, isMachinery,
                                       riderIds, owns, resolvesItself }) {
  const notes = [];
  const order = [...(offeredIds ?? [])];
  const offeredSet = new Set(order);
  const machineryTest = typeof isMachinery === "function" ? isMachinery : () => false;

  // ── GENUINE multi-activity items keep their choice (Johnny 2026-07-27) ──
  // This used to auto-click the Attack activity whenever the item had one,
  // FULL STOP. On an item that legitimately offers more than one thing —
  // the Stormforger staff (melee attack AND a spell), a wand that can be
  // swung or channelled, most artefact weapons — that silently forced the
  // melee swing every time, and the range check then refused with "out of
  // reach" while the user was only ever trying to cast. The choice was
  // stolen before they saw it.
  //
  // The suppression's real job is the BG3-HUD case: a bogus dialog raised for
  // a weapon that has exactly ONE usable activity. So only auto-pick when the
  // attack IS the only real option; otherwise reveal the dialog and let the
  // user choose. (Forge-templated items are handled by their own exception
  // below and keep working the same way.)
  if (item && activities) {
    const all = [...activities];
    const attackActs = all.filter(a => a.type === "attack");
    // Count what the dialog is ACTUALLY offering — an activity with no
    // button isn't a choice the user can make.
    const offered = all.filter(a => offeredSet.has(a.id));

    // ── ⚠️🔴 MACHINERY IS NOT A CHOICE ─────────────────────────────
    //
    // dnd5e renders a button for EVERY activity, including the internal
    // ones a spell fires at itself. Johnny's Magic Missile has four, and he
    // was being asked to pick between them every single cast:
    //
    //     Damage · Use · Magic Missile Bolt · Magic Missile Bolt: Flat
    //
    // The two "Bolt" rows carry activation type "special", which is dnd5e's
    // OWN marker for something that is not an action a person takes — it is
    // the machinery the spell uses to throw each dart. Putting them in front
    // of the caster is like asking which piston he would like to fire.
    //
    // ⚠️ ASK THE SYSTEM, DO NOT KEEP A LIST. `activityActivationTypes`
    // already marks every one of these (special, turnStart, turnEnd,
    // encounter, shortRest, longRest). A hand-maintained list here would go
    // stale the first time dnd5e adds a category.
    //
    // ⚠️ AND NEVER SWALLOW THE ACTION. If filtering leaves nothing, the
    // unfiltered list stands — a picker showing too much beats a press that
    // does nothing.
    const real = offered.filter(a => !machineryTest(a));
    const machinery = offered.filter(a => machineryTest(a));
    if (machinery.length && real.length) {
      notes.push(`"${item.name}": hid ${machinery.length} internal activit`
        + `${machinery.length === 1 ? "y" : "ies"} `
        + `(${machinery.map(a => a.name || a.type).join(", ")}) `
        + `— the spell fires those itself, they are not choices.`);
    }

    // ── ⚠️🔴 A SAVE THAT FOLLOWS A HIT IS NOT A CHOICE ─────────────────
    //
    // Johnny, 2026-09-12, pressing Neferon's Claws and being asked "Attack
    // or Save?": "I don't want that shit on our fucking attack cards if we
    // can't fucking push it and use it." The Save is the poison the target
    // resists after the claw lands, and ACE already asks for it on the
    // damage card. Pressed on its own it rolled a save with no damage in
    // it. dnd5e gives it the activation "action", so only the words say
    // what it is, and the reader that decides is the damage card's own.
    const riders = call(riderIds, new Set()) ?? new Set();
    const doable = real.filter(a => !riders.has(a.id));
    const choosable = doable.length ? doable : (real.length ? real : offered);
    if (riders.size && doable.length) {
      notes.push(`"${item.name}": not offering `
        + `${offered.filter(a => riders.has(a.id)).map(a => `"${a.name || "Save"}"`).join(", ")} `
        + `as a choice. It is the saving throw a creature makes when this hits it, and ACE `
        + `asks for it on the damage card after the hit.`);
    }

    // ── ⚠️🔴 A SPELL ACE CASTS ITSELF NEVER ASKS WHICH ROW ────────
    //
    // When the spell pipeline owns a spell it decides what the spell DOES —
    // Magic Missile throws 3 darts of 1d4+1 force, plus one per upcast, and
    // the activity the cast happened to start from changes none of that.
    // Johnny's imported copy has two activities that both cost an action and
    // both burn a slot, so he was being stopped and asked to choose between
    // "Damage" and "Use" before the spell could even begin.
    //
    // Johnny, 2026-08-25: "How the fuck is that useful to me? It's got to be
    // just like a normal thing where I consume a spell slot: what level do
    // you want to cast it at? How many darts?"
    //
    // ⚠️ PICK A REAL CAST, NOT JUST THE FIRST ROW. A "utility" activity is
    // frequently an empty stub that does nothing on its own, so it goes last;
    // anything that actually resolves comes first. Slot level, upcasting and
    // dart count are then dnd5e's usage dialog and the pipeline's job, which
    // is exactly where that decision belongs.
    if (choosable.length > 1 && call(owns, false)) {
      // ⚠️🔴 A FOLLOW-UP IS NOT A WAY TO CAST THE SPELL. Johnny, 2026-09-11:
      // Varek cast Prismatic Wall and nothing happened. Its four activities
      // are Create Wall, Create Globe, Blinding Save and Traversal Save, and
      // the rank below put "save" ahead of "utility", so it picked the
      // Blinding Save: the save a creature makes when it wanders near the
      // wall later, not the wall. dnd5e marks every such follow-up as using
      // no spell slot, and that is the test.
      const casts = choosable.filter(a => a?.consumption?.spellSlot !== false);
      // ⚠️🔴 AND WHEN THE PIPELINE HANDS THE SPELL OFF, THE ACTIVITY IS THE
      // SPELL. "The pipeline decides what the spell does either way" is true
      // for Magic Missile, which it resolves itself. For an area it hands to
      // dnd5e and the save engine, the activity chosen IS what happens: a
      // wall or a globe, a wall of fire or a ring. Two of those is a real
      // choice, so the caster makes it.
      const handsOff = !call(resolvesItself, false);
      if (handsOff && casts.length > 1) {
        notes.push(`"${item.name}" can be cast ${casts.length} different ways `
          + `(${casts.map(a => a.name || a.type).join(", ")}), and which one changes what it `
          + `does, so the caster picks.`);
      } else {
        const RANK = { attack: 0, save: 1, damage: 2, heal: 3, summon: 4, enchant: 5, check: 6, utility: 9 };
        const pool = casts.length ? casts : choosable;
        const best = [...pool].sort((a, b) =>
          (RANK[a.type] ?? 7) - (RANK[b.type] ?? 7))[0];
        if (best) {
          return { kind: "fire", activity: best, activityId: best.id, notes,
            why: `"${item.name}" is cast by ACE's spell pipeline — `
              + `not asking which activity. Using the "${best.name || best.type}" one; `
              + `${handsOff ? "it is the only way to cast it" : "the pipeline decides what the spell does either way"}.` };
        }
      }
    }

    // ── ONE REAL CHOICE IS NOT A CHOICE ────────────────────────────────
    // With the machinery gone most items have exactly one thing to do, and
    // a dialog asking a question with a single answer is a click stolen
    // from the table. Fire it and say nothing.
    if (choosable.length === 1 && offered.length > 1) {
      return { kind: "fire", activity: choosable[0], activityId: choosable[0].id, notes,
        why: `"${item.name}": one real activity after hiding internals — using it without asking.` };
    }

    if (choosable.length > 1) {
      // ⚠️ TWO IDENTICAL ABILITIES ARE A DUPLICATE. Two DIFFERENT ones are
      // an item. Johnny's imported Magic Missile carries a genuine
      // duplicate and this is how he finds it.
      //
      // ⚠️🔴 BUT THE TEST USED TO BE "both cost an action and both set
      // spellSlot", AND THAT IS NOT A DUPLICATE TEST. `consumption.spellSlot`
      // is true by default on a magic item's activities even when the item
      // spends CHARGES and no slot is involved at all, so the Stormforger's
      // four genuinely different abilities — Tornado Takedown, Aerial
      // Ascension, Aerial Descent, Thunderstorm of Misery — tripped it every
      // single cast. ACE told him, on screen, to go and delete abilities his
      // item is supposed to have (2026-09-03).
      //
      // A wrong warning is worse than none: it is a confident instruction to
      // damage his own data. The test is now whether two of them are
      // actually indistinguishable — the same name, or the same type with
      // the same cost — which is what a duplicated import looks like.
      let twins = [], clones = [];
      try {
        const sig = (a) => {
          const t = (a.consumption?.targets ?? [])[0];
          return `${a.type}|${t?.type ?? ""}|${t?.value ?? ""}|${a.activation?.type ?? ""}`;
        };
        // ⚠️🔴 DIFFERENT NAMES ARE DIFFERENT ABILITIES, WHATEVER THEY COST.
        // Johnny, 2026-09-11: Prismatic Wall's Create Wall and Create Globe
        // are both a utility costing an action, and its Blinding Save and
        // Traversal Save are both saves costing nothing, so all four were
        // called duplicates and he was told to check the item sheet. Only
        // an unnamed pair can be told apart by nothing but its cost.
        const byName = new Map(), bySig = new Map();
        for (const a of choosable) {
          const n = String(a.name ?? "").trim().toLowerCase();
          if (n) byName.set(n, (byName.get(n) ?? 0) + 1);
          else bySig.set(sig(a), (bySig.get(sig(a)) ?? 0) + 1);
        }
        twins = [...byName.entries()].filter(([, n]) => n > 1).map(([k]) => k);
        clones = [...bySig.entries()].filter(([, n]) => n > 1).map(([k]) => k);
      } catch (_) { /* diagnostics must never block the cast */ }
      return { kind: "ask", choices: choosable, duplicates: { twins, clones }, notes,
        why: `ActivityChoiceDialog offers ${choosable.length} real activities `
          + `(${choosable.map(a => a.type).join(", ")}) — showing ACE's picker` };
    }

    for (const a of attackActs) {
      if (offeredSet.has(a.id)) {
        return { kind: "fire", activity: a, activityId: a.id, notes,
          why: "Auto-selecting Attack in ActivityChoiceDialog (sole activity)" };
      }
    }
  }

  // ── ACE: Forge-templated items exception (v0.7.10) ─────────────────
  // Items wired by ACE: Forge's Item Template Library (Holy Symbol of
  // Ravenkind etc.) have LEGITIMATE multi-activity setups where the
  // user needs to pick which power to fire (Hold Vampires vs Sunlight
  // vs Turn Undead Enhanced). The original "no attack → close" logic
  // was correctly catching Divine Smite rider popups but ALSO catching
  // these legitimate user-choice dialogs. Leave Forge-templated dialogs
  // open so the user can actually pick.
  if (item?.flags?.["ace-artificer"]?.appliedTemplate) {
    return { kind: "reveal", notes,
      why: "ActivityChoiceDialog for Forge-templated item — leaving open for user choice" };
  }

  // ── Spell items handling (v0.7.21+) ────────────────────────────────
  // The "no attack → close" assumption only holds for WEAPON post-hit
  // rider dialogs (Divine Smite, Searing Smite, etc., which our rider
  // engine handles independently). For SPELL items, we want the cast
  // to proceed without an extra click.
  //
  // Strategy: auto-click the FIRST activity button. Most multi-activity
  // spells have the primary "Cast" as activity #0 and secondary options
  // are upcast variants or rarely-used "Dismiss"/"End" actions. For
  // edge cases where a user genuinely wants the second activity, they
  // can use the character sheet directly (which calls the activity by
  // ID without going through the dialog).
  if (item?.type === "spell") {
    const firstId = order[0];
    if (firstId) {
      return { kind: "fire", activityId: firstId,
        activity: [...(activities ?? [])].find(a => a.id === firstId) ?? null, notes,
        why: `Spell — auto-clicking first activity (${firstId})` };
    }
    return { kind: "reveal", notes, why: "Spell ActivityChoiceDialog with no buttons — leaving open" };
  }

  // No Attack button found. The auto-close rationale — post-hit rider dialogs
  // (Divine Smite etc.) handled by our rider engine — applies ONLY to WEAPONS.
  // Any non-weapon multi-activity item (equipment like the Holy Symbol of
  // Ravenkind: Hold Vampires / Turn Undead / Sunlight; consumables; tools;
  // feats) has a LEGITIMATE power-choice the user must make. Leave it open.
  if (item?.type !== "weapon") {
    return { kind: "reveal", notes,
      why: `Multi-activity ${item?.type ?? "item"} — leaving choice open for the user` };
  }
  return { kind: "close", notes, why: "Auto-closing post-hit ActivityChoiceDialog" };
}
