// ─── ACE: QOL — Polymorph Spell Pipeline ──────────────────────────────────────
// Detects Polymorph / True Polymorph / Mass Polymorph spell casts, shows a
// form-picker dialog at cast-time, then routes the failed-save outcome to
// TransformationEngine. Mirrors engagement-gate's sync-cancel + async-refire
// pattern to keep the picker async without breaking dnd5e's hook flow.
//
// RAW notes baked in per spell:
//   Polymorph:        4th-level, beast only, CR ≤ target's level, conc 1 hr,
//                     0 HP → revert, no voluntary revert
//   True Polymorph:   9th-level, ANY creature/object, CR ≤ caster level,
//                     conc 1 hr, BECOMES PERMANENT after 1 hr (no revert),
//                     voluntary revert OK, 0 HP → spell ends differently
//   Mass Polymorph:   single-target pipeline called per target (Wish only)
//
// Beast catalog source: prefers ACE Forge's "ACE: Forge — Beasts" folder if
// the user has it installed, falls back to scanning game.actors for type
// "npc" with system.details.type.value === "beast".
// ──────────────────────────────────────────────────────────────────────────────

import { MODULE_ID } from "./ace-qol.mjs";
import { TransformationEngine, TRANSFORM_SOURCE } from "./transformation-engine.mjs";

const FORGE_BEAST_FOLDER = "ACE: Forge — Beasts";

/** Spell-name patterns mapped to TransformationEngine config presets. */
const POLYMORPH_PATTERNS = [
  {
    pattern:  /^polymorph$/i,
    source:   TRANSFORM_SOURCE.SPELL_POLYMORPH,
    spellName: "Polymorph",
    durationSeconds: 3600,
    voluntaryRevertOK: false,
    revertOnZeroHP: true,
    permanentAfterDuration: false,
    formType: "beast",
  },
  {
    pattern:  /^true polymorph$/i,
    source:   TRANSFORM_SOURCE.SPELL_TRUE_POLYMORPH,
    spellName: "True Polymorph",
    durationSeconds: 3600,
    voluntaryRevertOK: true,
    revertOnZeroHP: false, // RAW: spell ends differently on 0 HP
    permanentAfterDuration: true,
    formType: "any",
  },
  {
    pattern:  /^mass polymorph$/i,
    source:   TRANSFORM_SOURCE.SPELL_MASS_POLYMORPH,
    spellName: "Mass Polymorph",
    durationSeconds: 3600,
    voluntaryRevertOK: false,
    revertOnZeroHP: true,
    permanentAfterDuration: false,
    formType: "beast",
  },
];

/** Stash of caster's picks during the brief window between picker close and
 *  save resolution. Keyed by activity.id. */
const PENDING_PICKS = new Map();

/** Activity IDs that just completed the picker step. Set BEFORE the re-fire
 *  call to activity.use(); the hook sees the entry on re-entry and lets the
 *  cast pass through. Module-scope (not on activity instance) because dnd5e's
 *  activity.use() resolves a fresh Activity reference each call — properties
 *  attached to the original instance don't survive. */
const REFIRE_MARKERS = new Set();


export class PolymorphSpellPipeline {

  // ═══════════════════════════════════════════════════════════════════════════
  //  Init
  // ═══════════════════════════════════════════════════════════════════════════

  static init() {
    if (this._initialized) return;
    this._initialized = true;

    Hooks.on("dnd5e.preUseActivity", (activity /*, usageConfig, dialogConfig, messageConfig */) => {
      try {
        const item = activity?.item;
        if (!item) {
          return;
        }
        if (item.type !== "spell") {
          return;
        }

        const cfg = PolymorphSpellPipeline._matchPolymorph(item);
        if (!cfg) {
          return;
        }

        console.log(`${MODULE_ID} | [polymorph-pipeline] preUseActivity matched "${item.name}" (activityId=${activity.id}) — entering pipeline`);

        // Re-fire path: marker is set after picker closes — let it through
        if (REFIRE_MARKERS.has(activity.id)) {
          REFIRE_MARKERS.delete(activity.id); // one-shot
          console.log(`${MODULE_ID} | [polymorph-pipeline] re-fire marker present (activityId=${activity.id}) — passing through to dnd5e default flow`);
          return;
        }

        // Resolve targets — try game.user.targets first, fall back to controlled
        const targets = [...(game.user.targets ?? [])];
        console.log(`${MODULE_ID} | [polymorph-pipeline] targets at preUseActivity: ${targets.length} (${targets.map(t => t.name).join(", ") || "none"})`);
        if (!targets.length) {
          console.warn(`${MODULE_ID} | [polymorph-pipeline] No targets at cast time — picker NOT shown. Cast will proceed without transformation.`);
          return;
        }

        // Cancel synchronously, kick off async picker + re-fire
        console.log(`${MODULE_ID} | [polymorph-pipeline] cancelling default cast, opening picker...`);
        PolymorphSpellPipeline._handlePolymorphAsync(activity, item, cfg, targets).catch(err => {
          console.warn(`${MODULE_ID} | Polymorph async handler unhandled error:`, err);
        });
        return false;
      } catch (err) {
        console.error(`${MODULE_ID} | PolymorphSpellPipeline hook threw — fail-open:`, err);
      }
    });

    console.log(`${MODULE_ID} | Polymorph spell pipeline online (Polymorph / True Polymorph / Mass Polymorph)`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Public API (consumed by save-engine on failed save)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * If the given activity has a pending Polymorph pick, transform the target
   * and clear the pick. Returns true if a transform was applied (so save-engine
   * can skip the normal condition application path).
   *
   * Called from save-engine._applyFailedSaveConditions for each failed target.
   */
  static async tryConsumeAndTransform(activityId, targetActor, casterActor, targetTokenDoc = null) {
    const pick = PENDING_PICKS.get(activityId);
    if (!pick) return false;
    if (!targetActor) return false;

    try {
      // Resolve the caster's Concentrating effect for dependent linkage
      let concEffectUuid = null;
      const caster = casterActor ?? game.actors.get(pick.casterId);
      if (caster) {
        const conc = caster.effects?.contents?.find(e =>
          e.statuses?.has?.("concentrating")
          && (String(e.name ?? "").toLowerCase().includes(pick.spellName.toLowerCase())
              || (e.flags?.dnd5e?.concentration?.item === pick.itemId))
        );
        concEffectUuid = conc?.uuid ?? null;
      }

      await TransformationEngine.transform(targetActor, pick.beastActor, {
        source:                 pick.config.source,
        spellName:              pick.config.spellName,
        casterId:               pick.casterId,
        casterUuid:             pick.casterUuid,
        concEffectUuid,
        durationSeconds:        pick.config.durationSeconds,
        permanentAfterDuration: pick.config.permanentAfterDuration,
        revertOnZeroHP:         pick.config.revertOnZeroHP,
        voluntaryRevertOK:      pick.config.voluntaryRevertOK,
        // CRITICAL: pass the specific token doc so transform() updates ONLY
        // this token, not all tokens that share the actor's prototype id.
        // Two unlinked NPC tokens of the same prototype (e.g. two Priests)
        // share actorId — without this, both tokens would visually polymorph
        // even though only one took the failed save.
        targetTokenId:          targetTokenDoc?.id ?? null,
        targetTokenUuid:        targetTokenDoc?.uuid ?? null,
      });

      PENDING_PICKS.delete(activityId);
      return true;
    } catch (err) {
      console.warn(`${MODULE_ID} | tryConsumeAndTransform failed:`, err);
      return false;
    }
  }

  /**
   * Public: does the given item name look like a Polymorph spell?
   * Used by save-engine to skip the normal condition path even if no pending
   * pick is registered (e.g. picker was cancelled).
   */
  static isPolymorphSpell(item) {
    return !!this._matchPolymorph(item);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Internal — polymorph detection
  // ═══════════════════════════════════════════════════════════════════════════

  static _matchPolymorph(item) {
    const name = String(item?.name ?? "");
    return POLYMORPH_PATTERNS.find(p => p.pattern.test(name)) ?? null;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Internal — async picker + re-fire
  // ═══════════════════════════════════════════════════════════════════════════

  static async _handlePolymorphAsync(activity, item, cfg, targets) {
    const target = targets[0]?.actor;
    if (!target) {
      console.warn(`${MODULE_ID} | [polymorph-pipeline] async: no target actor on selected token — bailing`);
      return;
    }

    // CR limit per RAW
    const crLimit = PolymorphSpellPipeline._getCRLimit(item, target, cfg);
    console.log(`${MODULE_ID} | [polymorph-pipeline] CR limit for ${target.name}: ${crLimit}`);

    const entries = await PolymorphSpellPipeline._getBeastCatalog(crLimit, cfg.formType);

    if (!entries.length) {
      ui.notifications?.warn(`Polymorph: no eligible forms found (CR ≤ ${crLimit}). Install ddb-importer or open a beast compendium.`);
      console.warn(`${MODULE_ID} | [polymorph-pipeline] no eligible beast entries — picker NOT shown`);
      return;
    }

    console.log(`${MODULE_ID} | [polymorph-pipeline] showing picker with ${entries.length} eligible entries`);
    const pickedEntry = await PolymorphSpellPipeline._showFormPicker({
      entries,
      spellName: cfg.spellName,
      targetName: target.name,
      crLimit,
      formType: cfg.formType,
    });
    if (!pickedEntry) {
      console.log(`${MODULE_ID} | [polymorph-pipeline] picker cancelled — no cast`);
      return;
    }

    // Resolve the picked entry to an actual Actor document (compendium or world)
    const beastActor = await PolymorphSpellPipeline._resolveBeastActor(pickedEntry);
    if (!beastActor) {
      ui.notifications?.error(`Polymorph: failed to load beast "${pickedEntry.name}" from ${pickedEntry.source}`);
      return;
    }
    console.log(`${MODULE_ID} | [polymorph-pipeline] picker resolved: ${beastActor.name} (CR ${pickedEntry.cr}) from ${pickedEntry.source}`);

    // Stash the pick BEFORE re-firing
    PENDING_PICKS.set(activity.id, {
      beastActor,
      config:      cfg,
      casterId:    item.actor?.id ?? null,
      casterUuid:  item.actor?.uuid ?? null,
      spellName:   item.name,
      itemId:      item.id,
      stampedAt:   Date.now(),
    });

    // Re-fire with module-scope marker so this hook lets it pass through.
    // The Set is one-shot — the hook deletes the marker on re-entry.
    REFIRE_MARKERS.add(activity.id);
    try {
      await activity.use();
    } catch (err) {
      console.error(`${MODULE_ID} | Polymorph re-fire failed:`, err);
      ui.notifications?.error(`Re-cast of ${item.name} failed — try again from the sheet.`);
      PENDING_PICKS.delete(activity.id);
      REFIRE_MARKERS.delete(activity.id); // belt-and-braces
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Internal — CR limit per RAW
  // ═══════════════════════════════════════════════════════════════════════════

  static _getCRLimit(item, target, cfg) {
    // True Polymorph: caster's level
    // Polymorph: target's level (PCs) or CR (monsters)
    if (cfg.spellName === "True Polymorph") {
      const casterLevel = item.actor?.system?.details?.level ?? 0;
      return casterLevel || 20;
    }
    // Polymorph / Mass Polymorph: target's level or CR
    const targetLevel = target?.system?.details?.level;
    if (Number.isFinite(targetLevel)) return targetLevel;
    const targetCR = target?.system?.details?.cr;
    if (Number.isFinite(targetCR)) return targetCR;
    return 0;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Internal — beast catalog
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Returns lightweight beast entries eligible for polymorph.
   * Each entry: { id, uuid, name, img, cr, type, source }
   *
   * Catalog source priority (first non-empty wins):
   *   1. Pack labeled "DDB Monsters" (user's primary catalog under D&D Beyond folder)
   *   2. Any other DDB Importer compendium (ddb-importer.*)
   *   3. dnd5e SRD monsters compendium
   *   4. ANY world compendium with beast-type entries
   *   5. ACE Forge's "ACE: Forge — Beasts" actor folder
   *   6. Any actor folder named /beast/i
   *   7. All NPC actors in world with type === "beast"
   *
   * Loading lazily — we only pull index data here. Full Actor documents
   * are loaded by `_resolveBeastActor()` when the user picks one.
   */
  static async _getBeastCatalog(crLimit, formType = "beast") {
    const isBeastEntry = (sysType) => {
      const t = String(sysType ?? "").toLowerCase();
      if (formType === "any") return true; // True Polymorph allows any creature
      return t === "beast";
    };

    const crOf = (sysCr) => {
      // CR can be a number, a string ("1/4"), or undefined
      if (sysCr === undefined || sysCr === null) return 0;
      if (typeof sysCr === "number") return sysCr;
      const s = String(sysCr).trim();
      if (s.includes("/")) {
        const [num, den] = s.split("/").map(Number);
        return num / den;
      }
      const n = Number(s);
      return Number.isFinite(n) ? n : 0;
    };

    const tryCompendium = async (pack) => {
      try {
        const index = await pack.getIndex({ fields: ["system.details.type.value", "system.details.cr", "img"] });
        const filtered = [];
        for (const entry of index) {
          const sysType = entry.system?.details?.type?.value;
          if (!isBeastEntry(sysType)) continue;
          const cr = crOf(entry.system?.details?.cr);
          if (cr > crLimit) continue;
          filtered.push({
            id:    entry._id,
            uuid:  `Compendium.${pack.collection}.Actor.${entry._id}`,
            name:  entry.name,
            img:   entry.img,
            cr,
            type:  sysType,
            source: pack.metadata.label,
          });
        }
        return filtered;
      } catch (err) {
        console.warn(`${MODULE_ID} | failed to read compendium ${pack.collection}:`, err);
        return [];
      }
    };

    // ── Path 1: pack labeled "DDB Monsters" (user's preferred catalog) ──
    // Matches the pack the user keeps under their "D&D Beyond" folder/group.
    // Tried first regardless of which module owns it. Label-based match is
    // tolerant: "DDB Monsters", "DDB Monster", "ddb-monsters" all hit.
    const ddbLabelMatch = /^ddb[\s_-]?monsters?$/i;
    const labeledDDBPack = (game.packs?.contents ?? []).find(p =>
      p.documentName === "Actor" && ddbLabelMatch.test(String(p.metadata?.label ?? ""))
    );
    if (labeledDDBPack) {
      const entries = await tryCompendium(labeledDDBPack);
      if (entries.length) {
        console.log(`${MODULE_ID} | [polymorph-pipeline] catalog source: "${labeledDDBPack.metadata.label}" (${labeledDDBPack.collection}), ${entries.length} eligible — preferred DDB pack`);
        return PolymorphSpellPipeline._sortCatalog(entries);
      }
      console.log(`${MODULE_ID} | [polymorph-pipeline] preferred DDB pack "${labeledDDBPack.metadata.label}" had 0 eligible — falling through`);
    }

    // ── Path 2: any other DDB Importer compendium ──
    const ddbPacks = (game.packs?.contents ?? []).filter(p =>
      p.documentName === "Actor"
      && p !== labeledDDBPack
      && p.collection.startsWith("ddb-importer.")
    );
    if (ddbPacks.length) {
      const all = [];
      for (const pack of ddbPacks) {
        const entries = await tryCompendium(pack);
        all.push(...entries);
      }
      if (all.length) {
        console.log(`${MODULE_ID} | [polymorph-pipeline] catalog source: ${ddbPacks.length} DDB Importer pack(s), ${all.length} eligible entries`);
        return PolymorphSpellPipeline._sortCatalog(all);
      }
    }

    // ── Path 3: dnd5e SRD monsters compendium ──
    const dnd5ePack = game.packs?.get?.("dnd5e.monsters");
    if (dnd5ePack) {
      const entries = await tryCompendium(dnd5ePack);
      if (entries.length) {
        console.log(`${MODULE_ID} | [polymorph-pipeline] catalog source: dnd5e.monsters, ${entries.length} eligible`);
        return PolymorphSpellPipeline._sortCatalog(entries);
      }
    }

    // ── Path 4: any Actor compendium with beast-type entries ──
    const allActorPacks = (game.packs?.contents ?? []).filter(p => p.documentName === "Actor");
    for (const pack of allActorPacks) {
      const entries = await tryCompendium(pack);
      if (entries.length) {
        console.log(`${MODULE_ID} | [polymorph-pipeline] catalog source: ${pack.collection}, ${entries.length} eligible`);
        return PolymorphSpellPipeline._sortCatalog(entries);
      }
    }

    // ── Path 5: Forge folder ──
    const forgeFolder = game.folders?.find?.(f =>
      f.type === "Actor" && f.name === FORGE_BEAST_FOLDER
    );
    if (forgeFolder) {
      const entries = forgeFolder.contents
        .filter(a => a.type === "npc" && isBeastEntry(a.system?.details?.type?.value))
        .map(a => ({
          id: a.id, uuid: a.uuid, name: a.name, img: a.img,
          cr: crOf(a.system?.details?.cr), type: a.system?.details?.type?.value,
          source: `Folder: ${forgeFolder.name}`,
        }))
        .filter(e => e.cr <= crLimit);
      if (entries.length) {
        console.log(`${MODULE_ID} | [polymorph-pipeline] catalog source: ${forgeFolder.name} folder, ${entries.length} eligible`);
        return PolymorphSpellPipeline._sortCatalog(entries);
      }
    }

    // ── Path 6: any beast-named folder ──
    const anyBeastFolder = game.folders?.find?.(f =>
      f.type === "Actor" && /beast/i.test(f.name ?? "")
    );
    if (anyBeastFolder) {
      const entries = anyBeastFolder.contents
        .filter(a => a.type === "npc" && isBeastEntry(a.system?.details?.type?.value))
        .map(a => ({
          id: a.id, uuid: a.uuid, name: a.name, img: a.img,
          cr: crOf(a.system?.details?.cr), type: a.system?.details?.type?.value,
          source: `Folder: ${anyBeastFolder.name}`,
        }))
        .filter(e => e.cr <= crLimit);
      if (entries.length) {
        console.log(`${MODULE_ID} | [polymorph-pipeline] catalog source: ${anyBeastFolder.name} folder, ${entries.length} eligible`);
        return PolymorphSpellPipeline._sortCatalog(entries);
      }
    }

    // ── Path 7: world actor scan ──
    const worldEntries = (game.actors?.contents ?? [])
      .filter(a => a.type === "npc" && isBeastEntry(a.system?.details?.type?.value))
      .map(a => ({
        id: a.id, uuid: a.uuid, name: a.name, img: a.img,
        cr: crOf(a.system?.details?.cr), type: a.system?.details?.type?.value,
        source: "World actors",
      }))
      .filter(e => e.cr <= crLimit);
    if (worldEntries.length) {
      console.log(`${MODULE_ID} | [polymorph-pipeline] catalog source: world actors, ${worldEntries.length} eligible`);
      return PolymorphSpellPipeline._sortCatalog(worldEntries);
    }

    console.warn(`${MODULE_ID} | [polymorph-pipeline] NO beast catalog found across compendiums + folders + world actors`);
    return [];
  }

  static _sortCatalog(entries) {
    // ── Dedupe ──
    // Compendiums (especially DDB Monsters) often contain duplicate stat
    // blocks: 2014 vs 2024 editions, sometimes one tagged "(Legacy)" and
    // sometimes both with the exact same name but different actor IDs.
    // Picker UX is much cleaner with one entry per creature.
    //
    // Strategy:
    //   1. Compute a canonical name for each entry (strip "(Legacy)",
    //      "(2014)", "(Old)", trailing whitespace, lowercase).
    //   2. For duplicates with the same canonical name, prefer the
    //      non-Legacy entry; if all are legacy or all are non-legacy,
    //      first-seen wins.
    const canonical = (name) => String(name ?? "")
      .replace(/\s*\((legacy|2014|old|original)\)\s*$/i, "")
      .trim()
      .toLowerCase();
    const isLegacy = (name) => /\((legacy|2014|old|original)\)/i.test(String(name ?? ""));

    const byCanonical = new Map();
    for (const e of entries) {
      const key = canonical(e.name);
      const existing = byCanonical.get(key);
      if (!existing) {
        byCanonical.set(key, e);
        continue;
      }
      // Prefer non-Legacy over Legacy
      if (isLegacy(existing.name) && !isLegacy(e.name)) {
        byCanonical.set(key, e);
      }
      // Otherwise keep first-seen (existing)
    }

    // ── Sort: CR ascending, then name alphabetic ──
    return [...byCanonical.values()].sort((a, b) => {
      if (a.cr !== b.cr) return a.cr - b.cr;
      return String(a.name).localeCompare(String(b.name));
    });
  }

  /** Resolve a catalog entry back to a full Actor document for transformInto. */
  static async _resolveBeastActor(entry) {
    if (!entry?.uuid) return null;
    try {
      return await fromUuid(entry.uuid);
    } catch (err) {
      console.warn(`${MODULE_ID} | _resolveBeastActor: failed to load ${entry.uuid}:`, err);
      return null;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Internal — picker dialog
  // ═══════════════════════════════════════════════════════════════════════════

  static async _showFormPicker({ entries, spellName, targetName, crLimit, formType }) {
    return new Promise(async (resolve) => {
      let resolved = false;
      const safeResolve = (val) => {
        if (resolved) return;
        resolved = true;
        resolve(val);
      };

      const formTypeLabel = formType === "any" ? "any creature" : "beast";
      const fmtCr = (cr) => {
        if (!Number.isFinite(cr) || cr === 0) return "0";
        if (cr < 1) return `1/${Math.round(1 / cr)}`;
        return String(cr);
      };

      const escapeHtml = (s) => String(s ?? "")
        .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

      const cards = entries.map((e, i) => {
        const img = e.img || "icons/svg/mystery-man.svg";
        return `
          <div class="ace-qol-poly-card" data-entry-idx="${i}">
            <img src="${escapeHtml(img)}" alt="${escapeHtml(e.name)}" />
            <div class="ace-qol-poly-name">${escapeHtml(e.name)}</div>
            <div class="ace-qol-poly-cr">CR ${fmtCr(e.cr)}</div>
          </div>`;
      }).join("");

      const html = `
        <div class="ace-qol-poly-picker">
          <div class="ace-qol-poly-header">
            <strong>${escapeHtml(spellName)}</strong> — choose a form for <strong>${escapeHtml(targetName)}</strong>
            <div class="ace-qol-poly-sub">Pick a ${formTypeLabel} of CR ≤ ${crLimit} (${entries.length} option${entries.length === 1 ? "" : "s"}).</div>
          </div>
          <div class="ace-qol-poly-grid">
            ${cards}
          </div>
        </div>
      `;

      // We track the picked entry in a closure variable. The dialog's close
      // lifecycle (override of _onClose) reads it and resolves the promise.
      // This is more robust than patching dlg.close() because it works for
      // EVERY close path: X button, ESC key, Cancel button, our card click,
      // even a forced `dlg.close()` from elsewhere.
      let pickedEntry = null;
      let dlg;
      try {
        dlg = new foundry.applications.api.DialogV2({
          window: { title: `${spellName} — Form Picker`, icon: "fas fa-paw" },
          content: html,
          buttons: [
            { action: "cancel", label: "Cancel", default: false, callback: () => null },
          ],
          rejectClose: false,
          modal: true,
          position: { width: 720 },
        });
      } catch (err) {
        console.error(`${MODULE_ID} | [polymorph-pipeline] DialogV2 construct failed:`, err);
        return safeResolve(null);
      }

      // Override the lifecycle close — fires on ANY close path
      const origOnClose = dlg._onClose?.bind(dlg);
      dlg._onClose = function(options) {
        try { if (origOnClose) origOnClose(options); } catch (_) {}
        safeResolve(pickedEntry); // null if user cancelled, entry if they clicked a card
      };

      try {
        await dlg.render({ force: true });
      } catch (err) {
        console.error(`${MODULE_ID} | [polymorph-pipeline] picker render failed:`, err);
        return safeResolve(null);
      }

      const root = dlg.element;
      if (!root) {
        console.warn(`${MODULE_ID} | [polymorph-pipeline] picker rendered but element is null`);
        return safeResolve(null);
      }
      const cardEls = root.querySelectorAll(".ace-qol-poly-card");
      console.log(`${MODULE_ID} | [polymorph-pipeline] picker dialog rendered with ${cardEls.length} cards`);
      cardEls.forEach(card => {
        card.addEventListener("click", () => {
          const idx = Number(card.dataset.entryIdx);
          const entry = entries[idx];
          if (!entry) return;
          // Stash the pick so _onClose can resolve with it, then close.
          pickedEntry = entry;
          console.log(`${MODULE_ID} | [polymorph-pipeline] card clicked: ${entry.name} (idx=${idx}) — closing dialog`);
          dlg.close().catch(err => {
            console.warn(`${MODULE_ID} | [polymorph-pipeline] dlg.close() rejected:`, err);
            // Force the resolution even if close throws
            safeResolve(entry);
          });
        });
      });
    });
  }
}
