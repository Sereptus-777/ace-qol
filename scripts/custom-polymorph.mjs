// ─── ACE: QOL — Custom Polymorph Implementation ────────────────────────────
// A from-scratch RAW implementation of Polymorph that doesn't rely on dnd5e's
// `transformInto` / `revertOriginalForm`. Trade-off: faster (~3 database
// writes vs dozens) at the cost of having to manually replicate every RAW
// rule the system normally handles.
//
// Why this exists: dnd5e's transformInto creates a brand-new world Actor
// with the beast's full stat block, then re-points the token at it. On a
// hosted Foundry server, every embedded item/effect creation is a network
// round-trip, and every active module hook fires per write. Polymorphs end
// up taking 60-120 seconds. Our path uses ONE Active Effect with stat
// overrides + ONE token update + ONE flag stamp ≈ 3 round-trips total.
//
// RAW coverage (Tier 3 — comprehensive):
//   - HP: replaced with beast's max HP (current set to max). Damage carries
//         over to original on revert if beast hits 0.
//   - AC, speed (all movement modes), senses, size: replaced
//   - STR/DEX/CON: replaced. INT/WIS/CHA: KEPT from original (RAW).
//   - Save proficiencies: replaced with beast's
//   - Skill proficiencies: replaced with beast's
//   - Damage immunities/resistances/vulnerabilities: replaced
//   - Condition immunities: replaced
//   - Beast attacks/items: copied onto target with `polymorphAdded` flag
//   - Original weapons/spells: suppressed via `polymorphSuppressed` flag
//   - Equipment: stays on actor but suppressed (RAW: "merges into form")
// ──────────────────────────────────────────────────────────────────────────────

import { MODULE_ID } from "./ace-qol.mjs";

// Use a string literal here, NOT MODULE_ID — this constant evaluates at
// module-load time, and the circular import (custom-polymorph → ace-qol →
// transformation-engine → custom-polymorph) leaves MODULE_ID in TDZ.
// Inside functions MODULE_ID is fine because it resolves at runtime.
const FLAG_NS = "ace-qol";
const POLYMORPH_EFFECT_NAME = "Polymorph (ace-qol)";

/** Active Effect modes (Foundry CONST). 5 = OVERRIDE. */
const M_OVERRIDE = 5;

/**
 * The fields we treat as "polymorph-replaceable" — everything that should
 * change to the beast's values when the spell hits. Each is a `getter`
 * function pulling a value from the source actor (the beast).
 *
 * Key = Active Effect change.key. Value = function returning string-coerced value.
 */
const STAT_OVERRIDES = [
  // HP — set both max and value to beast's max HP (RAW: starts at full beast HP)
  ["system.attributes.hp.max",       (s) => Number(s.system?.attributes?.hp?.max  ?? 0)],
  ["system.attributes.hp.value",     (s) => Number(s.system?.attributes?.hp?.max  ?? 0)],

  // AC — flat override
  ["system.attributes.ac.flat",      (s) => Number(s.system?.attributes?.ac?.value ?? 10)],

  // Movement — all modes
  ["system.attributes.movement.walk",   (s) => Number(s.system?.attributes?.movement?.walk   ?? 0)],
  ["system.attributes.movement.fly",    (s) => Number(s.system?.attributes?.movement?.fly    ?? 0)],
  ["system.attributes.movement.swim",   (s) => Number(s.system?.attributes?.movement?.swim   ?? 0)],
  ["system.attributes.movement.climb",  (s) => Number(s.system?.attributes?.movement?.climb  ?? 0)],
  ["system.attributes.movement.burrow", (s) => Number(s.system?.attributes?.movement?.burrow ?? 0)],
  ["system.attributes.movement.hover",  (s) => Boolean(s.system?.attributes?.movement?.hover) ? "1" : "0"],

  // Senses
  ["system.attributes.senses.darkvision",  (s) => Number(s.system?.attributes?.senses?.darkvision  ?? 0)],
  ["system.attributes.senses.blindsight",  (s) => Number(s.system?.attributes?.senses?.blindsight  ?? 0)],
  ["system.attributes.senses.tremorsense", (s) => Number(s.system?.attributes?.senses?.tremorsense ?? 0)],
  ["system.attributes.senses.truesight",   (s) => Number(s.system?.attributes?.senses?.truesight   ?? 0)],

  // STR/DEX/CON only — INT/WIS/CHA preserved per RAW
  ["system.abilities.str.value",       (s) => Number(s.system?.abilities?.str?.value ?? 10)],
  ["system.abilities.dex.value",       (s) => Number(s.system?.abilities?.dex?.value ?? 10)],
  ["system.abilities.con.value",       (s) => Number(s.system?.abilities?.con?.value ?? 10)],

  // Save proficiencies — all 6 abilities. Beast's profs replace original's.
  ["system.abilities.str.proficient",  (s) => Number(s.system?.abilities?.str?.proficient ?? 0)],
  ["system.abilities.dex.proficient",  (s) => Number(s.system?.abilities?.dex?.proficient ?? 0)],
  ["system.abilities.con.proficient",  (s) => Number(s.system?.abilities?.con?.proficient ?? 0)],
  ["system.abilities.int.proficient",  (s) => Number(s.system?.abilities?.int?.proficient ?? 0)],
  ["system.abilities.wis.proficient",  (s) => Number(s.system?.abilities?.wis?.proficient ?? 0)],
  ["system.abilities.cha.proficient",  (s) => Number(s.system?.abilities?.cha?.proficient ?? 0)],

  // Size
  ["system.traits.size",               (s) => String(s.system?.traits?.size ?? "med")],
];

/** Skill keys in dnd5e 5.x — used to override skill proficiencies. */
const SKILL_KEYS = [
  "acr","ani","arc","ath","dec","his","ins","itm","inv",
  "med","nat","prc","prf","per","rel","slt","ste","sur",
];


export class CustomPolymorph {

  // ═══════════════════════════════════════════════════════════════════════════
  //  TRANSFORM
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Apply RAW polymorph to `target`, transforming it into the form of
   * `sourceActor`. Returns the polymorph state object (or null on failure).
   *
   * @param {Actor} target — actor being transformed
   * @param {Actor} sourceActor — beast/creature whose stat block becomes the new form
   * @param {object} opts — optional context (passed through to caller for stamping)
   * @returns {Promise<{success: boolean, originalSnapshot: object, effectId: string|null, addedItemIds: string[], suppressedItemIds: string[]}|null>}
   */
  static async transform(target, sourceActor, opts = {}) {
    if (!target || !sourceActor) {
      console.warn(`${MODULE_ID} | CustomPolymorph: missing target or sourceActor`);
      return null;
    }

    // ── Snapshot original data we'll need to restore ──
    const originalSnapshot = {
      hpValue:           Number(target.system?.attributes?.hp?.value ?? 0),
      hpMax:             Number(target.system?.attributes?.hp?.max ?? 0),
      tokenTextureSrc:   target.prototypeToken?.texture?.src ?? null,
      tokenWidth:        target.prototypeToken?.width ?? 1,
      tokenHeight:       target.prototypeToken?.height ?? 1,
      tokenScaleX:       target.prototypeToken?.texture?.scaleX ?? 1,
      tokenScaleY:       target.prototypeToken?.texture?.scaleY ?? 1,
      tokenName:         target.prototypeToken?.name ?? target.name,
      placedTokens:      [], // populated below
    };

    // Capture the SPECIFIC target token's pre-transform state for revert.
    // We require the caller (polymorph spell pipeline) to pass the exact
    // tokenId — this is the only reliable way to identify a single token
    // when multiple unlinked NPC tokens share an actor prototype id (e.g.
    // two Priest tokens both with actorId=PVD5wR but different per-token
    // synthetic actors). Reference equality on actor isn't sufficient
    // because Foundry's actor delta system may share actor instances under
    // some V13 conditions.
    if (canvas?.scene) {
      if (opts.targetTokenId) {
        const t = canvas.scene.tokens?.get?.(opts.targetTokenId);
        if (t) {
          originalSnapshot.placedTokens.push({
            tokenId:    t.id,
            textureSrc: t.texture?.src ?? null,
            width:      t.width,
            height:     t.height,
            scaleX:     t.texture?.scaleX ?? 1,
            scaleY:     t.texture?.scaleY ?? 1,
            name:       t.name,
          });
        }
      } else {
        // Fallback when caller didn't provide a token id (e.g. trap-driven
        // polymorph that operates on a known synthetic). Use reference
        // equality only — strict match, not by .id.
        for (const t of canvas.scene.tokens?.contents ?? []) {
          if (t.actor !== target) continue;
          originalSnapshot.placedTokens.push({
            tokenId:    t.id,
            textureSrc: t.texture?.src ?? null,
            width:      t.width,
            height:     t.height,
            scaleX:     t.texture?.scaleX ?? 1,
            scaleY:     t.texture?.scaleY ?? 1,
            name:       t.name,
          });
        }
      }
    }

    // ── Build the polymorph Active Effect with stat overrides ──
    const changes = [];

    // Core stat overrides
    for (const [key, getter] of STAT_OVERRIDES) {
      try {
        const value = getter(sourceActor);
        changes.push({ key, mode: M_OVERRIDE, value: String(value), priority: 100 });
      } catch (_) { /* skip on failure */ }
    }

    // Skill proficiencies
    for (const skillKey of SKILL_KEYS) {
      const profValue = Number(sourceActor.system?.skills?.[skillKey]?.value ?? 0);
      changes.push({
        key:      `system.skills.${skillKey}.value`,
        mode:     M_OVERRIDE,
        value:    String(profValue),
        priority: 100,
      });
    }

    // Traits — damage immunities / resistances / vulnerabilities / condition immunities
    // These are stored as Sets in dnd5e 5.x; we pass arrays as Active Effect changes.
    for (const traitKey of ["di", "dr", "dv", "ci"]) {
      const sourceValue = sourceActor.system?.traits?.[traitKey]?.value;
      if (sourceValue) {
        // Convert Set/Array to comma-separated string for the override
        const arr = sourceValue instanceof Set ? [...sourceValue] : (Array.isArray(sourceValue) ? sourceValue : []);
        if (arr.length) {
          changes.push({
            key:      `system.traits.${traitKey}.value`,
            mode:     M_OVERRIDE,
            value:    arr.join(","),
            priority: 100,
          });
        }
      }
    }

    // ── Suppress original items (RAW: weapons/spells unusable in beast form) ──
    const suppressedItemIds = [];
    const itemSuppressUpdates = [];
    for (const item of target.items?.contents ?? []) {
      // Skip our own previously-added beast items if any
      if (item.flags?.[FLAG_NS]?.polymorphAdded) continue;
      // Don't suppress passive features (skills, languages aren't items, but
      // class/race features might add useful things — RAW says they're lost
      // in beast form anyway)
      if (item.type === "weapon" || item.type === "spell" || item.type === "feat" || item.type === "consumable") {
        suppressedItemIds.push(item.id);
        itemSuppressUpdates.push({
          _id: item.id,
          [`flags.${FLAG_NS}.polymorphSuppressed`]: true,
        });
      }
    }

    // ── Copy the beast's attack items onto the target ──
    // Beast attacks are typically `feat` or `weapon` type items (e.g., "Bite"
    // on a Wolf). We copy these and tag them with `polymorphAdded` so revert
    // can clean them up. INT/WIS/CHA-based items might rely on stats we
    // didn't change, but core beast actions usually use STR/DEX (which we
    // DID override).
    const beastAttackItemData = [];
    for (const item of sourceActor.items?.contents ?? []) {
      if (item.type === "weapon" || item.type === "feat") {
        const itemObj = item.toObject();
        delete itemObj._id;
        foundry.utils.setProperty(itemObj, `flags.${FLAG_NS}.polymorphAdded`, true);
        beastAttackItemData.push(itemObj);
      }
    }

    // ── Apply all changes in a single batch where possible ──
    let createdEffect = null;
    let addedItemIds = [];
    try {
      // 1. Create the polymorph Active Effect
      // The token's TEXTURE swaps to the beast (handled separately by the
      // transformation engine). The Active Effect carries the stat overrides
      // and item-suppression metadata but NO token-overlay visual — the
      // texture swap is the visual indicator. The small "polymorphed" status
      // badge in the token corner provides a hover-readable confirmation.
      const polyIcon = sourceActor.img
                    || sourceActor.prototypeToken?.texture?.src
                    || "icons/svg/aura.svg";
      const effData = {
        name:    POLYMORPH_EFFECT_NAME,
        icon:    polyIcon,
        img:     polyIcon,
        origin:  opts.casterUuid ?? null,
        duration: {
          seconds:   opts.durationSeconds ?? null,
          startTime: game.time?.worldTime ?? 0,
        },
        changes,
        statuses: ["polymorphed"],
        flags: {
          [FLAG_NS]: {
            polymorphEffect:   true,
            sourceActorUuid:   sourceActor.uuid,
            sourceActorName:   sourceActor.name,
            originalActorName: target.name,
            stampedAt:         Date.now(),
          },
        },
      };
      const created = await target.createEmbeddedDocuments("ActiveEffect", [effData]);
      createdEffect = created?.[0] ?? null;

      // 2. Mark original items as suppressed (single update batch)
      if (itemSuppressUpdates.length) {
        await target.updateEmbeddedDocuments("Item", itemSuppressUpdates);
      }

      // 3. Add beast attack items (single create batch)
      if (beastAttackItemData.length) {
        const addedItems = await target.createEmbeddedDocuments("Item", beastAttackItemData);
        addedItemIds = (addedItems ?? []).map(i => i.id);
      }

      // 4. Update placed tokens to use beast's image/size
      if (canvas?.scene && originalSnapshot.placedTokens.length) {
        const tokenUpdates = originalSnapshot.placedTokens.map(snap => ({
          _id: snap.tokenId,
          "texture.src":    sourceActor.prototypeToken?.texture?.src ?? snap.textureSrc,
          "texture.scaleX": sourceActor.prototypeToken?.texture?.scaleX ?? 1,
          "texture.scaleY": sourceActor.prototypeToken?.texture?.scaleY ?? 1,
          "width":          sourceActor.prototypeToken?.width  ?? 1,
          "height":         sourceActor.prototypeToken?.height ?? 1,
          "name":           `${snap.name} (${sourceActor.name})`,
        }));
        await canvas.scene.updateEmbeddedDocuments("Token", tokenUpdates);
      }
    } catch (err) {
      console.error(`${MODULE_ID} | CustomPolymorph.transform failed:`, err);
      // Best-effort rollback if we partially applied
      try {
        if (createdEffect) await createdEffect.delete();
        if (addedItemIds.length) await target.deleteEmbeddedDocuments("Item", addedItemIds);
        if (itemSuppressUpdates.length) {
          await target.updateEmbeddedDocuments("Item", itemSuppressUpdates.map(u => ({
            _id: u._id, [`flags.${FLAG_NS}.-=polymorphSuppressed`]: null,
          })));
        }
      } catch (_) { /* ignore rollback errors */ }
      return null;
    }

    return {
      success:           true,
      originalSnapshot,
      effectId:          createdEffect?.id ?? null,
      addedItemIds,
      suppressedItemIds,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  REVERT
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Reverse a custom polymorph. Reads the snapshot from `polymorphRecord`
   * (returned by `transform()`), undoes everything.
   *
   * @param {Actor} target
   * @param {object} polymorphRecord — what `transform()` returned
   * @param {object} [opts]
   *   @param {number} [opts.excessDamage] — for ZERO_HP carryover
   * @returns {Promise<boolean>}
   */
  static async revert(target, polymorphRecord, opts = {}) {
    if (!target || !polymorphRecord) return false;
    const snap = polymorphRecord.originalSnapshot ?? {};

    // ── Suppress benign cleanup-race notifications ──
    // When excess damage from polymorph carryover drops the original form to
    // 0 HP, the death pipeline races our cleanup: it starts deleting the
    // token while we're still tearing down polymorph artifacts. Foundry's
    // CRUD methods fire ui.notifications.error("X does not exist in the
    // EmbeddedCollection") BEFORE throwing — our try/catches swallow the
    // throw but the red toast already fired. Same known pattern as
    // ace-engine's permission-warning suppression.
    //
    // We monkey-patch ui.notifications.error + console.error briefly,
    // restoring them in finally. Filter is narrow: only "does not exist in
    // the EmbeddedCollection" — everything else passes through.
    const filterRE = /does not exist in the EmbeddedCollection/i;
    const origNotifError   = ui.notifications?.error?.bind(ui.notifications);
    const origConsoleError = console.error?.bind(console);
    if (origNotifError) {
      ui.notifications.error = function(msg, ...args) {
        if (typeof msg === "string" && filterRE.test(msg)) return;
        return origNotifError(msg, ...args);
      };
    }
    if (origConsoleError) {
      console.error = function(...args) {
        try {
          const text = args.map(a => typeof a === "string" ? a : (a?.message ?? "")).join(" ");
          if (filterRE.test(text)) return; // benign cleanup race
        } catch (_) { /* fall through */ }
        return origConsoleError(...args);
      };
    }

    try {
      // 1. Delete the polymorph Active Effect
      if (polymorphRecord.effectId) {
        const eff = target.effects?.get?.(polymorphRecord.effectId);
        if (eff) {
          try { await eff.delete(); } catch (_) {}
        }
      }
      // Belt-and-suspenders: also delete any stray polymorph effects we own
      const strayEffects = (target.effects?.contents ?? []).filter(e =>
        e.flags?.[FLAG_NS]?.polymorphEffect === true
      );
      for (const e of strayEffects) {
        try { await e.delete(); } catch (_) {}
      }

      // 2. Delete the beast attack items we added
      const allAddedItemIds = (target.items?.contents ?? [])
        .filter(i => i.flags?.[FLAG_NS]?.polymorphAdded === true)
        .map(i => i.id);
      if (allAddedItemIds.length) {
        try { await target.deleteEmbeddedDocuments("Item", allAddedItemIds); } catch (_) {}
      }

      // 3. Clear suppressed flag from original items
      const suppressedItems = (target.items?.contents ?? [])
        .filter(i => i.flags?.[FLAG_NS]?.polymorphSuppressed === true);
      if (suppressedItems.length) {
        try {
          await target.updateEmbeddedDocuments("Item", suppressedItems.map(i => ({
            _id: i.id,
            [`flags.${FLAG_NS}.-=polymorphSuppressed`]: null,
          })));
        } catch (_) {}
      }

      // 4. Restore placed tokens to original appearance
      if (canvas?.scene && Array.isArray(snap.placedTokens) && snap.placedTokens.length) {
        const tokenRestores = [];
        for (const tokenSnap of snap.placedTokens) {
          // Only restore tokens that still exist
          const tokenDoc = canvas.scene.tokens?.get?.(tokenSnap.tokenId);
          if (!tokenDoc) continue;
          tokenRestores.push({
            _id: tokenSnap.tokenId,
            "texture.src":    tokenSnap.textureSrc,
            "texture.scaleX": tokenSnap.scaleX ?? 1,
            "texture.scaleY": tokenSnap.scaleY ?? 1,
            "width":          tokenSnap.width  ?? 1,
            "height":         tokenSnap.height ?? 1,
            "name":           tokenSnap.name,
          });
        }
        if (tokenRestores.length) {
          try { await canvas.scene.updateEmbeddedDocuments("Token", tokenRestores); } catch (_) {}
        }
      }

      // 5. Apply HP carryover (ZERO_HP revert)
      // RAW: damage that took beast form to 0 HP carries over to the original
      // form's HP. We do this AFTER the polymorph effect is gone so the HP
      // override doesn't fight us.
      if (Number.isFinite(opts.excessDamage) && opts.excessDamage > 0) {
        const restoredHpValue = Math.max(0, Number(snap.hpValue ?? 0) - Number(opts.excessDamage));
        try {
          await target.update({ "system.attributes.hp.value": restoredHpValue });
        } catch (err) {
          // Use the ORIGINAL console.error so this real error isn't filtered
          if (origConsoleError) origConsoleError(`${MODULE_ID} | CustomPolymorph: HP carryover failed:`, err);
          else console.warn(`${MODULE_ID} | CustomPolymorph: HP carryover failed:`, err);
        }
      }
      // Brief settle delay so any cascading deletes from the death-pipeline
      // (triggered if excess damage zeroed the original form) emit their
      // benign "does not exist" notifications BEFORE we restore the
      // suppression. ~200ms is enough on hosted; cheaper than a long wait
      // and short enough that real errors after this still surface normally.
      await new Promise(r => setTimeout(r, 200));
    } catch (err) {
      if (origConsoleError) origConsoleError(`${MODULE_ID} | CustomPolymorph.revert failed:`, err);
      else console.error(`${MODULE_ID} | CustomPolymorph.revert failed:`, err);
      return false;
    } finally {
      // Restore notification handlers
      if (origNotifError)   ui.notifications.error = origNotifError;
      if (origConsoleError) console.error          = origConsoleError;
    }
    return true;
  }
}
