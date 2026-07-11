// ─── ACE: QOL — Space Effects Executor (Phase 1 of the rules engine) ──────────
//
// Turns rules-data SPACE declarations into live scene mechanics. When any
// caster — PC, NPC, or a SUMMONED creature (the Summon Fey's own Darkness) —
// places a spell template, this looks the spell up in the rules brain and, if
// its entry declares space properties, creates a Foundry V13 Region matching
// the template's exact footprint:
//
//   • flags carry the MACHINE-READABLE space properties (obscurement kind,
//     pierce list, silence, terrain, light) — the single source of truth the
//     sight evaluator (Phase 2) and the casting gates (live NOW) read.
//   • native behaviors where Foundry provides them:
//       difficultTerrain → modifyMovementCost   (the proven Web pattern)
//       light            → adjustDarknessLevel  (real darkness inside the area)
//
// Lifecycle is anchored to the TEMPLATE — the one chokepoint every end path
// already flows through (manual delete, duration end, concentration break all
// delete the template; dnd5e handles that; we cascade). activeGM-gated: scene
// writes run exactly once regardless of who cast.
//
// CONVERGENCE: spells whose rules entry declares space properties get their
// region HERE. The concentration-widget's legacy difficult-terrain creator
// defers to us for those spells (guard added 2026-07-09) and keeps handling
// spells with timing-model terrain but no rules entry yet (Spike Growth,
// Grease) until their entries are authored.
//
// DISCREPANCY REPORTING (the "item disagrees with the book" signal): when the
// entry declares an expectedArea and the placed template differs materially in
// type or size, we log it — the fey's 5-ft Darkness CUBE vs the book's 15-ft
// SPHERE surfaces the moment it happens.
// ──────────────────────────────────────────────────────────────────────────────

import { MODULE_ID } from "../ace-qol.mjs";
import { QolSettings } from "../settings.mjs";
import { RulesBrain } from "./rules-brain.mjs";
import { SpaceDrafter } from "./space-drafter.mjs";
import { Situation } from "../situation.mjs";
import { buildRegionShapeFromTemplate } from "../geometry-utils.mjs";

const TAG = "ace-qol | [space-effects]";

export class SpaceEffects {

  static register() {
    // ── CREATE: template placed → space region (activeGM writes once) ──
    Hooks.on("createMeasuredTemplate", (templateDoc) => {
      if (game.users?.activeGM !== game.user) return;
      // Small delay lets dnd5e finish stamping flags.dnd5e.* and lets the
      // placeable compute its shape (same proven pattern as save-engine).
      setTimeout(() => {
        SpaceEffects._onTemplateCreated(templateDoc)
          .catch(err => console.warn(`${TAG} region create failed (non-fatal):`, err));
      }, 150);
    });

    // ── DELETE: template gone (any end path) → cascade our region ──
    Hooks.on("deleteMeasuredTemplate", (templateDoc) => {
      if (game.users?.activeGM !== game.user) return;
      try {
        const scene = templateDoc?.parent ?? canvas?.scene;
        const ids = scene?.regions
          ?.filter?.(r => r.getFlag?.(MODULE_ID, "spaceFor") === templateDoc.id)
          ?.map?.(r => r.id) ?? [];
        if (ids.length) {
          scene.deleteEmbeddedDocuments("Region", ids)
            .then(() => console.log(`${TAG} removed ${ids.length} space region(s) for deleted template ${templateDoc.id}`))
            .catch(err => console.warn(`${TAG} region cleanup failed:`, err));
        }
      } catch (err) {
        console.warn(`${TAG} region cleanup threw:`, err);
      }
    });

    // ── Region dies (any path) → its stamps come off everyone ──
    Hooks.on("deleteRegion", (regionDoc) => {
      if (game.users?.activeGM !== game.user) return;
      if (!regionDoc?.getFlag?.(MODULE_ID, "space")?.stampInside) return;
      const scene = regionDoc.parent ?? canvas?.scene;
      for (const tokDoc of (scene?.tokens ?? [])) {
        const tok = tokDoc.object;
        if (tok) SpaceEffects._unstamp(tok, regionDoc.id).catch(() => {});
        SpaceEffects._lastSpaces.get(tokDoc.id)?.delete?.(regionDoc.id);
      }
    });

    // ── CROSSING AWARENESS (2026-07-10 05:24) ──
    // The sight math fires at ATTACK time and is invisible until then —
    // which reads as "nothing happened" when a token steps into darkness.
    // Announce meaningful crossings (heavy obscurement, silence) the moment
    // they happen: one small GM whisper naming what the engine now knows.
    Hooks.on("updateToken", (tokenDoc, changes) => {
      try {
        if (game.users?.activeGM !== game.user) return;
        if (changes?.x === undefined && changes?.y === undefined) return;
        setTimeout(() => SpaceEffects._announceCrossings(tokenDoc), 200);
      } catch (_) {}
    });
    Hooks.on("deleteToken", (tokenDoc) => SpaceEffects._lastSpaces.delete(tokenDoc.id));

    console.log(`${MODULE_ID} | SpaceEffects online — rules-data spaces (regions from spell templates)`);
  }

  /** tokenDocId → Set(regionIds) the token was inside at last check. */
  static _lastSpaces = new Map();

  static _announceCrossings(tokenDoc) {
    try {
      const tok = tokenDoc?.object;
      if (!tok || tok.destroyed) return;
      const inside = SpaceEffects.spacesAtToken(tok)
        .filter(s => s.space?.obscurement === "heavy" || s.space?.silence);
      const nowIds = new Set(inside.map(s => s.region.id));
      const prev = SpaceEffects._lastSpaces.get(tokenDoc.id) ?? new Set();
      SpaceEffects._lastSpaces.set(tokenDoc.id, nowIds);

      const entered = inside.filter(s => !prev.has(s.region.id));
      const left = [...prev].filter(id => !nowIds.has(id));
      if (!entered.length && !left.length) return;

      // ── STAMPING (2026-07-10): conditions worn while inside a space.
      // Silence deafens; Hunger of Hadar's void blinds. Applied on entry as
      // an ACE-tagged effect (statuses drive dnd5e + the body visuals),
      // removed on exit and when the region dies. v1 center-based.
      for (const { region, space } of entered) {
        for (const cond of (space.stampInside ?? [])) {
          SpaceEffects._stamp(tok, region, cond).catch(() => {});
        }
      }
      for (const regionId of left) {
        SpaceEffects._unstamp(tok, regionId).catch(() => {});
      }

      const lines = [];
      for (const { region, space } of entered) {
        const bits = [];
        if (space.obscurement === "heavy") {
          // What does THIS creature's own senses make of it? (Same pure
          // decision function the sight evaluator uses — one brain.)
          let verdict = { pierced: false, how: null };
          try {
            const read = Situation.readCreature(tok.actor, tok);
            if (read) {
              verdict = Situation.canPierce(space, {
                darkvision: read.senses?.darkvision, blindsight: read.senses?.blindsight,
                truesight: read.senses?.truesight, devilsSight: read.devilsSight, dist: 0,
              });
            }
          } catch (_) {}
          // RAW consequences at the edge: the occupant is UNSEEN from outside
          // (attacks against it: disadvantage; its own attacks out: advantage
          // as an unseen attacker) — it still sees OUT normally unless deeper
          // obscurement lies between (the viewer's own square doesn't blind it).
          bits.push(verdict.pierced
            ? `sees normally inside (${verdict.how})`
            : `UNSEEN from outside — its attacks out gain ADVANTAGE; attacks into the dark at DISADVANTAGE (it still sees out from the edge)`);
        }
        if (space.silence) bits.push("in SILENCE — no verbal casting");
        if (space.stampInside?.length) bits.push(`${space.stampInside.join(" + ").toUpperCase()} while inside`);
        lines.push(`<b>${foundry.utils.escapeHTML(tok.name)}</b> entered <b>${foundry.utils.escapeHTML(region.name)}</b>: ${bits.join("; ")}.`);
      }
      if (left.length && !entered.length) {
        lines.push(`<b>${foundry.utils.escapeHTML(tok.name)}</b> left the obscured/silenced area.`);
      }
      if (!lines.length) return;

      // Dark wrapper ALWAYS — gold on a light chat theme is unreadable
      // (contrast rule violated 2026-07-10 06:40; never naked-text again).
      ChatMessage.create({
        whisper: ChatMessage.getWhisperRecipients?.("GM") ?? [],
        content: `<div style="background:#141118;border:1px solid #c9a76b55;border-left:3px solid #c9a76b;border-radius:4px;padding:5px 8px;font-size:13px;color:#e8dcc3;"><i class="fas fa-eye" style="color:#c9a76b;"></i> ${lines.join("<br>")}</div>`,
        flags: { [MODULE_ID]: { spaceCrossing: true } },
      }).catch(() => {});
    } catch (err) {
      console.debug(`${TAG} crossing announce failed (non-fatal):`, err);
    }
  }

  // ────────────────────────────────────────────────────────────────────────────
  //  Creation
  // ────────────────────────────────────────────────────────────────────────────

  static async _onTemplateCreated(templateDoc) {
    const scene = templateDoc?.parent ?? canvas?.scene;
    if (!scene) return;

    // Resolve the ORIGIN item — dnd5e stamps the origin uuid on templates it
    // creates (an Activity uuid or an Item uuid). Works for ANY caster,
    // including summoned creatures — no pending-stash needed.
    const origin = templateDoc?.flags?.dnd5e?.origin ?? null;
    const item = await SpaceEffects._resolveOriginItem(templateDoc);

    // ── FIELD DIAGNOSTIC (2026-07-09, the fey-Darkness miss) ──
    // ONE info line per spell template, always, naming exactly what the engine
    // saw. When a spell that should make a space doesn't, this line says WHY —
    // no more silent misses that need a debugging session to explain.
    let hit = item ? RulesBrain.spaceEntry(item, { actor: item.actor }) : null;
    console.log(
      `${TAG} template ${templateDoc.id} (${templateDoc.t}/${templateDoc.distance}ft) `
      + `origin=${origin ? "yes" : "NONE"} `
      + `item=${item ? `"${item.name}" → key "${RulesBrain.normalizeName(item.name)}"` : "UNRESOLVED"} `
      + `space-entry=${hit ? "YES" : "no"}`
    );

    // ── PHASE 4 (2026-07-10): no entry → the engine READS THE ITEM ITSELF ──
    // Deterministic pattern-reading of the item's own rules text; on an
    // unambiguous space signal it drafts + persists the entry (item flag —
    // the lookup path already honors it) and whispers the GM a receipt.
    // Ambiguous text stays hands-off. The Tricksy class of problem —
    // unknown monster features that make darkness/fog/silence/terrain —
    // self-serves from here on.
    if (item && !hit) {
      const drafted = await SpaceDrafter.draftForItem(item);
      if (drafted?.space) {
        hit = { entry: drafted, edition: RulesBrain.resolveEdition(item, item.actor), name: RulesBrain.normalizeName(item.name) };
      }
    }

    if (!item || !hit) return;              // not a spell template / no signal → hands off
    const { entry, edition } = hit;
    const space = entry.space;

    // ── Which properties are LIVE for this cast? ──
    // difficultTerrain honors the existing table setting (GM's choice on auto
    // movement costs). Obscurement / silence / light are what the spell IS —
    // ungated.
    let terrainLive = false;
    try { terrainLive = !!space.difficultTerrain && QolSettings.get("spellDifficultTerrain") === true; } catch (_) {}
    const anythingLive = terrainLive || space.obscurement || space.silence || space.light;
    if (!anythingLive) return;              // nothing to enforce → no region clutter

    // ── Dedup — canvasReady re-fires create hooks on reconnect ──
    if (scene.regions?.find?.(r => r.getFlag?.(MODULE_ID, "spaceFor") === templateDoc.id)) return;

    // ── Trace the ACTUAL template footprint (retry briefly — fresh placeables
    //     take a beat to compute their shape) ──
    let shape = buildRegionShapeFromTemplate(templateDoc);
    for (let i = 0; i < 4 && !shape; i++) {
      await new Promise(r => setTimeout(r, 150));
      shape = buildRegionShapeFromTemplate(templateDoc);
    }
    if (!shape) {
      console.warn(`${TAG} could not derive a region shape for "${item.name}" (template type ${templateDoc.t})`);
      return;
    }

    // Template may have died while we waited; another client may have raced us.
    if (!scene.templates?.get?.(templateDoc.id)) return;
    if (scene.regions?.find?.(r => r.getFlag?.(MODULE_ID, "spaceFor") === templateDoc.id)) return;

    // ── Discrepancy check — does the placed template match the book? ──
    SpaceEffects._checkAreaDiscrepancy(item, entry, templateDoc);

    // ── Native behaviors ──
    const behaviors = [];
    if (terrainLive) {
      behaviors.push({
        type: "modifyMovementCost",
        name: "Difficult Terrain",
        system: { difficulties: SpaceEffects._terrainDifficulties(Number(space.difficultTerrain) || 2) },
      });
    }
    if (space.light?.mode === "override") {
      // adjustDarknessLevel override — REAL darkness inside the footprint.
      // Mode enum resolved defensively; if the behavior type is unavailable we
      // still create the region (properties are the machine truth; visuals are
      // a bonus).
      try {
        const MODES = foundry.data?.regionBehaviors?.AdjustDarknessLevelRegionBehaviorType?.MODES;
        behaviors.push({
          type: "adjustDarknessLevel",
          name: "Magical Darkness",
          system: { mode: MODES?.OVERRIDE ?? 0, modifier: Number(space.light.level) },
        });
      } catch (err) {
        console.warn(`${TAG} adjustDarknessLevel behavior unavailable — region created without light change:`, err);
      }
    }

    // ── The region — machine-readable space properties in the flags ──
    const props = [];
    if (space.obscurement) props.push(`${space.obscurement === "heavy" ? "heavily" : "lightly"} obscured (${space.kind ?? "?"})`);
    if (space.silence) props.push("silence");
    if (terrainLive) props.push(`difficult terrain ×${space.difficultTerrain}`);
    if (space.light) props.push("darkness");

    const regionData = {
      name: `ACE — ${item.name}`,
      color: space.kind === "magicalDarkness" ? "#1a1a2e" : space.silence ? "#7b6ba8" : "#9aa0b5",
      shapes: [shape],
      behaviors,
      flags: {
        [MODULE_ID]: {
          spaceFor: templateDoc.id,
          space: {
            spell: RulesBrain.normalizeName(item.name),
            edition,
            obscurement: space.obscurement ?? null,
            kind: space.kind ?? null,
            pierceBy: space.pierceBy ?? [],
            silence: !!space.silence,
            difficultTerrain: terrainLive ? Number(space.difficultTerrain) : null,
            light: space.light ?? null,
            stampInside: Array.isArray(space.stampInside) && space.stampInside.length ? space.stampInside : null,
            casterActorId: item.actor?.id ?? null,
          },
        },
      },
    };

    try {
      const created = await scene.createEmbeddedDocuments("Region", [regionData]);
      console.log(`${TAG} "${item.name}" [${edition}] → live space region ${created?.[0]?.id} (${props.join(", ") || "properties only"})`);
      // Tokens ALREADY standing where the space appeared (cast on top of
      // someone) get their crossing processed immediately — stamps and
      // whispers apply at cast time, not only on the next move.
      setTimeout(() => {
        try {
          for (const tokDoc of (scene.tokens ?? [])) SpaceEffects._announceCrossings(tokDoc);
        } catch (_) {}
      }, 250);
    } catch (err) {
      // A rejected BEHAVIOR payload (e.g. a core version quibbling over the
      // adjustDarknessLevel data shape) must not cost us the region itself —
      // the flags are the machine truth every later phase reads. Retry bare.
      console.warn(`${TAG} region create failed for "${item.name}" — retrying without behaviors:`, err);
      try {
        const bare = { ...regionData, behaviors: [] };
        const created = await scene.createEmbeddedDocuments("Region", [bare]);
        console.log(`${TAG} "${item.name}" [${edition}] → space region ${created?.[0]?.id} (properties only — behaviors rejected)`);
      } catch (err2) {
        console.warn(`${TAG} bare region create ALSO failed for "${item.name}":`, err2);
      }
    }
  }

  /**
   * Resolve the item that created this template from the dnd5e origin stamp.
   * The origin may be an Activity uuid (take its item) or an Item uuid.
   */
  static async _resolveOriginItem(templateDoc) {
    try {
      const origin = templateDoc?.flags?.dnd5e?.origin;
      if (!origin) return null;
      const doc = await fromUuid(String(origin)).catch(() => null);
      if (!doc) return null;
      if (doc.item) return doc.item;                        // Activity → its item
      if (doc.documentName === "Item" || doc.type) return doc; // already an Item
      return null;
    } catch (_) { return null; }
  }

  /**
   * Compare the placed template against the entry's expectedArea; log a
   * discrepancy when they materially differ. This is the "Foundry item
   * disagrees with the printed rules" surfacing — report-only in Phase 1
   * (the GM keeps whatever they placed; we just say what the book says).
   */
  static _checkAreaDiscrepancy(item, entry, templateDoc) {
    try {
      const exp = entry.expectedArea;
      if (!exp?.type) return;
      // dnd5e template types: circle (sphere/radius), rect (cube), cone, ray (line)
      const typeMap = { sphere: "circle", radius: "circle", cylinder: "circle", cube: "rect", square: "rect", cone: "cone", line: "ray", wall: "ray" };
      const expectedT = typeMap[String(exp.type).toLowerCase()] ?? null;
      const actualT = String(templateDoc.t ?? "");
      const actualSize = Number(templateDoc.distance ?? 0);
      const typeOff = expectedT && actualT && expectedT !== actualT;
      const sizeOff = Number(exp.size) > 0 && actualSize > 0 && Math.abs(actualSize - Number(exp.size)) > 0.5
        // Upcast-friendly: larger-than-book is legal for spells that scale
        // (Fog Cloud); flag only SMALLER-than-book, or any mismatch when the
        // shape is also wrong.
        && (actualSize < Number(exp.size) || typeOff);
      if (typeOff || sizeOff) {
        console.warn(
          `${TAG} DISCREPANCY: "${item.name}" placed a ${actualT} template of ${actualSize} ft, `
          + `but the rules say ${exp.type} of ${exp.size} ft. The placed template stands; `
          + `check the item's target configuration.`
        );
      }
    } catch (_) { /* report-only — never blocks */ }
  }

  /**
   * Difficulty multipliers for every non-derived movement action — mirror of
   * the proven concentration-widget builder (kept in both places deliberately:
   * the legacy path still owns spells without rules entries).
   */
  static _terrainDifficulties(mult) {
    const out = {};
    try {
      const actions = CONFIG?.Token?.movement?.actions ?? {};
      for (const [key, cfg] of Object.entries(actions)) {
        if (cfg?.deriveTerrainDifficulty) continue;   // derived (e.g. fly) — leave to derive
        out[key] = mult;
      }
    } catch (_) { /* fall through */ }
    if (!Object.keys(out).length) out.walk = mult;
    return out;
  }

  // ────────────────────────────────────────────────────────────────────────────
  //  Query layer — what the rest of the engine reads (Phase 2 sight, casting
  //  gates NOW). Pure reads, permissive on failure (never false-block).
  // ────────────────────────────────────────────────────────────────────────────

  /** All ACE space-property records whose region contains this point. */
  static spacesAtPoint(point, { scene = null, elevation = 0 } = {}) {
    const out = [];
    try {
      const sc = scene ?? canvas?.scene;
      for (const region of (sc?.regions ?? [])) {
        const space = region.getFlag?.(MODULE_ID, "space");
        if (!space) continue;
        let inside = false;
        try {
          inside = region.testPoint?.({ x: point.x, y: point.y, elevation }) ?? false;
        } catch (_) {
          try { inside = region.object?.testPoint?.({ x: point.x, y: point.y }, elevation) ?? false; } catch (_) {}
        }
        if (inside) out.push({ region, space });
      }
    } catch (err) {
      console.debug(`${TAG} spacesAtPoint failed (returning none — permissive):`, err);
    }
    return out;
  }

  /** All ACE space records containing this token's center. */
  static spacesAtToken(token) {
    try {
      const doc = token?.document ?? token;
      const obj = token?.center ? token : doc?.object;
      const center = obj?.center ?? {
        x: (doc?.x ?? 0) + ((doc?.width ?? 1) * (canvas?.grid?.size ?? 100)) / 2,
        y: (doc?.y ?? 0) + ((doc?.height ?? 1) * (canvas?.grid?.size ?? 100)) / 2,
      };
      const elevation = Number(doc?.elevation ?? 0);
      return SpaceEffects.spacesAtPoint(center, { scene: doc?.parent, elevation });
    } catch (_) { return []; }
  }

  /** Is this token standing inside a Silence space? (The verbal-casting gate reads this.) */
  static tokenInSilence(token) {
    return SpaceEffects.spacesAtToken(token).some(s => s.space?.silence === true);
  }

  // ────────────────────────────────────────────────────────────────────────────
  //  Stamping — conditions worn while inside a space (Silence → deafened,
  //  Hunger of Hadar → blinded). ACE-tagged effects: applied on entry,
  //  removed on exit and on region death. GM-side only (callers gate).
  // ────────────────────────────────────────────────────────────────────────────

  static async _stamp(token, region, condId) {
    try {
      const actor = token?.actor;
      if (!actor) return;
      const id = String(condId).toLowerCase();
      // Already stamped by THIS region? (re-entry within the same region)
      if (actor.effects.some(e => e.getFlag?.(MODULE_ID, "spaceStamp") === region.id
                                && e.statuses?.has?.(id))) return;
      // Condition immunity is a hard gate.
      const ci = new Set((actor.system?.traits?.ci?.value ?? []).map(s => String(s).toLowerCase()));
      if (ci.has(id)) return;

      const cfg = CONFIG.statusEffects?.find?.(s => s.id === id);
      await actor.createEmbeddedDocuments("ActiveEffect", [{
        name: `${cfg?.name ? game.i18n?.localize?.(cfg.name) ?? cfg.name : condId} (${region.name})`,
        img: cfg?.img ?? cfg?.icon ?? "icons/svg/downgrade.svg",
        statuses: [id],
        flags: { [MODULE_ID]: { spaceStamp: region.id } },
      }]);
      console.log(`${TAG} stamped ${id} on ${token.name} (inside ${region.name})`);
    } catch (err) {
      console.warn(`${TAG} stamp failed (non-fatal):`, err);
    }
  }

  static async _unstamp(token, regionId) {
    try {
      const actor = token?.actor;
      if (!actor) return;
      const ids = actor.effects
        .filter(e => e.getFlag?.(MODULE_ID, "spaceStamp") === regionId)
        .map(e => e.id);
      if (!ids.length) return;
      await actor.deleteEmbeddedDocuments("ActiveEffect", ids);
      console.log(`${TAG} unstamped ${ids.length} effect(s) from ${token.name} (left region ${regionId})`);
    } catch (err) {
      console.warn(`${TAG} unstamp failed (non-fatal):`, err);
    }
  }
}
