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
// ⚠️🔴 IT REPORTS BEFORE IT WRITES, AND IT SAVES WHAT IT REPLACES.
//     On 2026-09-06 a scan I wrote to fix three icons overwrote 1,073 documents
//     and recorded none of the old values. Two hours went into recovering them
//     from a six-week-old snapshot. So: `audit()` changes nothing and hands back
//     a table; `repair()` is separate, and every field it changes is stashed
//     under `flags.ace-qol.visionBefore` on the same update, so `undo()` is
//     always available.
//
// ⚠️ THE STATBLOCK IS THE TRUTH, THE TOKEN IS THE COPY. Where they disagree the
//     sheet wins, because that is what the book says and what he reads at the
//     table. This never invents a sense that is not on the actor.
//
// ⚠️ AND A CREATURE WITH NO DARKVISION IS NOT BROKEN. Sight range zero with the
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

export class VisionAudit {

  /** Feet of a sense, or 0. dnd5e stores these as numbers on the actor. */
  static _sense(actor, key) {
    const raw = actor?.system?.attributes?.senses?.[key];
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }

  /**
   * What this creature's prototype token SHOULD say, from its own statblock.
   * Returns null for anything the question does not apply to.
   */
  static expected(actor) {
    if (!actor || (actor.type !== "npc" && actor.type !== "character")) return null;
    const dark = VisionAudit._sense(actor, "darkvision");
    const modes = [];
    for (const [sense, id] of Object.entries(SENSE_DETECTION)) {
      const ft = VisionAudit._sense(actor, sense);
      if (ft > 0) modes.push({ id, enabled: true, range: ft });
    }
    return {
      enabled: true,
      range: dark,
      visionMode: dark > 0 ? "darkvision" : "basic",
      detectionModes: modes,
    };
  }

  /**
   * Everything wrong with one creature's prototype token, as plain sentences.
   */
  static faultsFor(actor) {
    const want = VisionAudit.expected(actor);
    if (!want) return [];
    const proto = actor.prototypeToken ?? {};
    const sight = proto.sight ?? {};
    const have = Array.isArray(proto.detectionModes) ? proto.detectionModes : [];
    const faults = [];

    // ⚠️ THE ONE THAT MATTERS MOST. A token with sight switched off sees
    // nothing whatever its ranges say, and it is the commonest import fault.
    if (sight.enabled !== true) faults.push("sight is switched off");

    if (want.range > 0) {
      const has = Number(sight.range ?? 0) || 0;
      if (has !== want.range) {
        faults.push(`sight range is ${has} ft, the statblock says ${want.range} ft`);
      }
      if (sight.visionMode !== "darkvision") {
        faults.push(`vision mode is "${sight.visionMode ?? "unset"}", not darkvision`);
      }
    }

    for (const mode of want.detectionModes) {
      const found = have.find(m => m?.id === mode.id);
      const label = Object.entries(SENSE_DETECTION).find(([, id]) => id === mode.id)?.[0] ?? mode.id;
      if (!found) {
        faults.push(`${label} ${mode.range} ft is on the sheet but the token cannot use it`);
      } else if (Number(found.range ?? 0) !== mode.range) {
        faults.push(`${label} is set to ${found.range ?? 0} ft, the statblock says ${mode.range} ft`);
      } else if (found.enabled === false) {
        faults.push(`${label} is present but switched off`);
      }
    }
    return faults;
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
   * Write the statblock's own numbers onto the prototype token.
   *
   * ⚠️ THE OLD VALUES GO IN THE SAME UPDATE. Not a second write that could fail
   * on its own, and not a file somewhere. `undo()` reads them straight back.
   */
  static async repair({ playersOnly = false, dryRun = false } = {}) {
    if (!game.user?.isGM) {
      ui.notifications?.warn("Only the GM can repair token vision.");
      return { changed: 0 };
    }
    const targets = [];
    for (const actor of (game.actors ?? [])) {
      if (playersOnly && !actor.hasPlayerOwner) continue;
      const want = VisionAudit.expected(actor);
      if (!want) continue;
      if (!VisionAudit.faultsFor(actor).length) continue;
      targets.push({ actor, want });
    }
    if (dryRun) {
      console.log(`${LOG} | ${targets.length} creature(s) WOULD be repaired`);
      return { changed: 0, wouldChange: targets.length };
    }

    let changed = 0;
    for (const { actor, want } of targets) {
      const proto = actor.prototypeToken ?? {};
      const before = {
        sight: foundry.utils.deepClone(proto.sight ?? {}),
        detectionModes: foundry.utils.deepClone(proto.detectionModes ?? []),
      };
      // Keep every detection mode we do not own, so a module that added its own
      // is not quietly deleted.
      const ours = new Set(Object.values(SENSE_DETECTION));
      const keep = (proto.detectionModes ?? []).filter(m => !ours.has(m?.id));
      try {
        await actor.update({
          "prototypeToken.sight.enabled": true,
          "prototypeToken.sight.range": want.range,
          "prototypeToken.sight.visionMode": want.visionMode,
          "prototypeToken.detectionModes": [...keep, ...want.detectionModes],
          [`prototypeToken.flags.${MODULE_ID}.visionBefore`]: before,
        });
        changed++;
      } catch (err) {
        console.warn(`${LOG} | could not repair ${actor.name}:`, err);
      }
    }
    console.log(`${LOG} | repaired ${changed} of ${targets.length}. `
      + `Undo with game.aceQol.VisionAudit.undo()`);
    ui.notifications?.info(`ACE: token vision repaired on ${changed} creature(s).`);
    return { changed };
  }

  /** Put back exactly what repair() replaced. */
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
    console.log(`${LOG} | restored ${restored} creature(s) to how they were`);
    ui.notifications?.info(`ACE: vision restored on ${restored} creature(s).`);
    return { restored };
  }

  /**
   * Tokens already on a map keep their own copy of all this, so repairing the
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
        const sight = tokenDoc.sight ?? {};
        const problems = [];
        if (sight.enabled !== true) problems.push("sight off");
        if (want.range > 0 && (Number(sight.range ?? 0) || 0) !== want.range) {
          problems.push(`range ${sight.range ?? 0} vs ${want.range}`);
        }
        if (problems.length) {
          rows.push({ token: tokenDoc.name, scene: scene.name, problems: problems.join("; ") });
        }
      }
    }
    if (log) {
      console.log(`%c${LOG} — ${rows.length} placed token(s) disagree with their statblock`,
        "color:#d4af37;font-weight:bold");
      if (rows.length) console.table(rows.slice(0, 200));
    }
    return rows;
  }

  static register() {
    try {
      if (!game.aceQol) game.aceQol = {};
      game.aceQol.VisionAudit = VisionAudit;
      console.debug(`${LOG} | ready — game.aceQol.VisionAudit.audit()`);
    } catch (err) {
      console.warn(`${LOG} | could not publish the vision audit:`, err);
    }
  }
}
