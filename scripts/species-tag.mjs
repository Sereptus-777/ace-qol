// ─── ACE: QOL — Species Tag ─────────────────────────────────────────────────
// Permanent creature-identity stamp on every NPC token (Johnny's architecture
// call, 2026-07-26): dnd5e has a CATEGORY field (giant/undead/beast) but NO
// species field — by convention "what creature is this" IS the sheet name,
// which is why renames (manual or otherwise) can blind every engine that needs
// to know "this is an Ogre". The tag records the species AT DROP TIME — before
// any flavor, rename, or AI touches anything — so downstream consumers (token
// art matching, save/condition engines, envoy naming) can always recover the
// true creature no matter what the names say later.
//
//   flags["ace-suite"].species = {
//     name:       "Ogre"                      // canonical creature name at drop
//     type:       "giant"                     // dnd5e category field
//     subtype:    ""                          // dnd5e subtype field
//     sourceUuid: "Compendium.….Actor.xyz"    // compendium origin when known
//   }
//
// Read via speciesOf(target) — resolution order: token's stamp → base-actor
// name → live actor name. Exposed as game.aceQol.speciesOf.
//
// Namespaced under "ace-suite" (like the companion-link flag) so every ACE
// module can read it without depending on ace-qol being the writer. Written
// with plain updates — setFlag validates scope against module ids and
// "ace-suite" is deliberately cross-module.
// ──────────────────────────────────────────────────────────────────────────────

import { MODULE_ID } from "./ace-qol.mjs";

/** Strip Foundry's duplicate suffixes: "Ogre (1)" / "Ogre 2" → "Ogre". */
function _canonicalName(raw) {
  return String(raw ?? "")
    .replace(/\s*\(\d+\)\s*$/, "")
    .replace(/\s+\d+\s*$/, "")
    .trim();
}

function _buildStamp(tokenDoc) {
  const actor = tokenDoc?.actor;
  if (!actor) return null;
  const base = game.actors.get(tokenDoc.actorId);
  // The BASE (sidebar) actor's name is the truest species label available —
  // per-token renames and numbering never touch it. Fall back sanely.
  const name = _canonicalName(base?.name) || _canonicalName(actor.name) || _canonicalName(tokenDoc.name);
  if (!name) return null;
  return {
    name,
    type:       actor.system?.details?.type?.value    ?? "",
    subtype:    actor.system?.details?.type?.subtype  ?? "",
    sourceUuid: actor._stats?.compendiumSource ?? actor.flags?.core?.sourceId ?? base?._stats?.compendiumSource ?? "",
  };
}

export class SpeciesTag {

  static init() {
    // Stamp on drop — one client writes (the active GM), everyone reads.
    Hooks.on("createToken", async (tokenDoc, _options, _userId) => {
      try {
        if (game.users?.activeGM !== game.user) return;
        await SpeciesTag.stamp(tokenDoc);
      } catch (err) {
        console.warn(`${MODULE_ID} | species stamp on create failed (non-fatal):`, err);
      }
    });

    // Backfill existing scenes — tokens dropped before this feature get their
    // stamp from the best truth still available (base actor name). One batched
    // write per scene; scenes with nothing missing cost nothing. Runs on every
    // scene switch AND once right now — init happens at `ready`, which is AFTER
    // the first canvasReady, so without the immediate call the loaded scene
    // would wait for a scene switch to get stamped.
    Hooks.on("canvasReady", () => { SpeciesTag._backfillScene(); });
    if (canvas?.ready) SpeciesTag._backfillScene();

    console.debug(`${MODULE_ID} | Species Tag online — creature identity stamped at drop`);
  }

  /** Stamp every unstamped NPC token on the current scene (one batched write). */
  static async _backfillScene() {
    try {
      if (game.users?.activeGM !== game.user) return;
      const scene = canvas?.scene;
      if (!scene) return;
      const updates = [];
      for (const t of scene.tokens ?? []) {
        if (t.actor?.type !== "npc") continue;
        if (t.flags?.["ace-suite"]?.species?.name) continue;   // already stamped
        const stamp = _buildStamp(t);
        if (stamp) updates.push({ _id: t.id, "flags.ace-suite.species": stamp });
      }
      if (updates.length) {
        await scene.updateEmbeddedDocuments("Token", updates);
        console.log(`${MODULE_ID} | species tag backfilled on ${updates.length} token(s) (${scene.name})`);
      }
    } catch (err) {
      console.warn(`${MODULE_ID} | species backfill failed (non-fatal):`, err);
    }
  }

  /** Stamp one token (idempotent — an existing stamp is never overwritten,
   *  so the drop-time truth survives everything that happens later). */
  static async stamp(tokenDoc) {
    if (tokenDoc?.actor?.type !== "npc") return;
    if (tokenDoc.flags?.["ace-suite"]?.species?.name) return;
    const stamp = _buildStamp(tokenDoc);
    if (!stamp) return;
    await tokenDoc.update({ "flags.ace-suite.species": stamp });
  }

  /**
   * The creature's true identity, regardless of any rename or flavor.
   * Accepts a Token, TokenDocument, or Actor.
   * @returns {{name: string, type: string, subtype: string, sourceUuid: string}}
   */
  static speciesOf(target) {
    try {
      const tokenDoc = target?.document ?? (target?.documentName === "Token" ? target : null);
      const actor    = tokenDoc?.actor ?? (target?.documentName === "Actor" ? target : target?.actor) ?? null;

      const stamped = tokenDoc?.flags?.["ace-suite"]?.species
                   ?? actor?.token?.flags?.["ace-suite"]?.species;   // synthetic actor → its token
      if (stamped?.name) return { subtype: "", sourceUuid: "", type: "", ...stamped };

      const base = tokenDoc ? game.actors.get(tokenDoc.actorId) : null;
      const name = _canonicalName(base?.name) || _canonicalName(actor?.name) || _canonicalName(tokenDoc?.name);
      return {
        name,
        type:       actor?.system?.details?.type?.value   ?? "",
        subtype:    actor?.system?.details?.type?.subtype ?? "",
        sourceUuid: actor?._stats?.compendiumSource ?? "",
      };
    } catch (_) {
      return { name: "", type: "", subtype: "", sourceUuid: "" };
    }
  }
}
