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

    // ── DELETE: template gone → cascade our region, UNLESS it has its own clock ──
    //
    // ⚠️🔴 THE TEMPLATE IS THE AIMING DEVICE. THE REGION IS THE SPACE.
    //
    // Johnny, 2026-09-03, on Thunderstorm of Misery: "It still did not persist."
    // The picture drew correctly and the region was created correctly, and then
    // twenty-six seconds later this ran and took both away. Straight from his
    // log:
    //
    //     Auto-deleted instant template ImL2yyPXv6UJeDIX
    //     removed 1 space region(s) for deleted template ImL2yyPXv6UJeDIX
    //
    // The save engine is RIGHT to delete that template. The staff's damage is a
    // one-shot: 1d6 bludgeoning and 2d6 lightning, rolled once, and leaving the
    // circle on the map afterwards litters the scene with an invisible template
    // the GM cannot even see to clean up. What is wrong is treating the tidying
    // away of the aiming circle as the end of the storm.
    //
    // ⚠️ SO THE TEST IS "DOES THIS SPACE KNOW WHEN IT ENDS", not "is its template
    // still there". A space with `expiresAt` in the future already has an owner
    // for its own death — the sweeper below — and does not need this one. A
    // concentration space has no clock, ends when concentration does, and its
    // template going away IS that signal, so it still cascades here.
    //
    // ⚠️ AND AN INSTANT SPELL IS NOT THE SAME AS AN INSTANT SPACE. Those are two
    // different questions about one cast, and answering the first was standing
    // in for the second. Nothing here changes the damage timing.
    Hooks.on("deleteMeasuredTemplate", (templateDoc) => {
      if (game.users?.activeGM !== game.user) return;
      try {
        const scene = templateDoc?.parent ?? canvas?.scene;
        const mine = scene?.regions
          ?.filter?.(r => r.getFlag?.(MODULE_ID, "spaceFor") === templateDoc.id) ?? [];

        const now = Number(game.time?.worldTime ?? 0);
        const ids = [];
        for (const r of mine) {
          const left = SpaceEffects.timeLeft(r.getFlag?.(MODULE_ID, "expiresAt"), now);
          if (left == null) { ids.push(r.id); continue; }
          console.log(`${TAG} "${r.name}" outlives its template — it ends on its own clock `
            + `in ${Math.round(left)} seconds of game time.`);
        }

        if (ids.length) {
          scene.deleteEmbeddedDocuments("Region", ids)
            .then(() => console.log(`${TAG} removed ${ids.length} space region(s) for deleted template ${templateDoc.id}`))
            .catch(err => console.warn(`${TAG} region cleanup failed:`, err));
        }
      } catch (err) {
        console.warn(`${TAG} region cleanup threw:`, err);
      }
    });

    // ── EXPIRY (2026-07-28) ──
    // A space used to have exactly ONE way to end: someone deletes its template.
    // For a concentration spell that's fine — dropping concentration removes the
    // template and the region follows. But a TIMED, non-concentration space
    // (Thunderstorm of Misery, Grease, Tricksy) had no such trigger, so every
    // cast left its template AND its region on the scene permanently.
    //
    // That is not a cosmetic leak. Foundry gives each overlapping region its own
    // terrain effect and they MULTIPLY, so a few repeat casts turned a 15-ft walk
    // into hundreds of feet and made the map impassable. Spaces now carry their
    // own expiry in world-time and clear themselves the moment it passes —
    // in combat or out, since advancing a turn advances world time.
    Hooks.on("updateWorldTime", () => {
      if (game.users?.activeGM !== game.user) return;
      SpaceEffects.sweepExpired().catch(err => console.warn(`${TAG} expiry sweep failed:`, err));
    });
    // Catch anything that expired while the world was closed.
    //
    // ⚠️ 🔴 THIS NEVER RAN (fixed 2026-08-12). `register()` is called from
    // inside ace-qol's own ready handler, so a bare `Hooks.once("ready", …)`
    // here waits on an event that has ALREADY fired. Result: spell-space regions
    // — Darkness, Web, Silence, Fog Cloud — that ran out while the world was
    // shut stayed on the map forever, and nothing said so. Same trap that left
    // 13 condition ghosts unswept the same day.
    const sweep = () => {
      if (game.users?.activeGM !== game.user) return;
      SpaceEffects.sweepExpired().catch(() => {});
    };
    if (game.ready) sweep();
    else Hooks.once("ready", sweep);

    // ── Region dies (any path) → its stamps come off everyone ──
    // ⚠️ THE PICTURE COMES DOWN ON EVERY CLIENT, not only the GM's — a
    // persistent Sequencer effect is stored on the scene and outlives a reload,
    // so a storm nobody ended would still be raining tomorrow.
    Hooks.on("deleteRegion", (regionDoc) => SpaceEffects._endSpaceFx(regionDoc?.id));
    Hooks.on("canvasReady", () => {
      try { SpaceEffects.redrawSpaceFx(); }
      catch (err) { console.warn(`${TAG} could not redraw the spaces on this scene:`, err); }
    });

    Hooks.on("deleteRegion", (regionDoc) => {
      if (game.users?.activeGM !== game.user) return;
      // ⚠️🔴 EVERY KIND OF MARK, NOT JUST THE FIRST ONE WRITTEN. This tested
      // `stampInside` alone, so the day a space started imposing disadvantage
      // instead of a condition, its marks would have survived the storm and
      // stayed on every creature permanently. A new field added beside an old
      // gate that still reads the old field is the same bug every time.
      const sp = regionDoc?.getFlag?.(MODULE_ID, "space");
      if (!sp?.stampInside?.length && !sp?.disadvantage) return;
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

  /* ── What a space LOOKS like ──────────────────────────────────────────── */

  /**
   * A persistent effect for the whole life of a space.
   *
   * ⚠️🔴 IT DID NOT STAY, AND IT SAT ON TOP OF PEOPLE. Johnny, 2026-09-03, on
   * Thunderstorm of Misery: "it's not persistent, which it should be for however
   * long it's supposed to go for. It should always be beneath the tokens' feet."
   *
   * What he was seeing was a one-shot fired at the moment of casting, which is
   * all an animation hung off a chat card can be. A space that lasts a minute
   * needs an effect that lasts a minute, and the only thing that knows how long
   * that is, is the region.
   *
   * ⚠️ SO THE REGION OWNS IT. Created with the region, ended when the region is
   * deleted, redrawn on every client that loads the scene. The region already
   * carries the expiry and already has a sweeper; hanging the picture on
   * anything else would be a second thing to keep in step.
   *
   * ⚠️ AND IT IS THE LOOPING FILE. JB2A ships each circular template twice,
   * `_Complete` and `_Loop`. The Complete one plays through and stops, which is
   * what makes a storm read as "solid circles that appear and sit there" — his
   * words were that the lightning looked fake. The Loop is the one that keeps
   * moving underfoot.
   */
  static _spaceFxName(regionId) { return `ace-qol-space:${regionId}`; }

  /**
   * What a space of this kind looks like, as a SEQUENCER DATABASE KEY.
   *
   * ⚠️ THE DATABASE, NOT A FILE PATH. Johnny picked this one out of JB2A's own
   * viewer and named it: "jb2a.whirlwind.bluegrey ... that is pretty much
   * perfect right there ... It should call this animation from JB2A from the
   * sequencer database, and that's what should play." (2026-09-03.)
   *
   * A key is also the safer thing to hold. A hardcoded path breaks the day JB2A
   * renames a file or he switches between the free and Patreon collections, and
   * it breaks SILENTLY — a 404 texture draws nothing at all. The key resolves
   * against whichever library is installed, and `entryExists` gives a true
   * answer before anything is played.
   *
   * The raw path is kept only as the fallback for an install with the files but
   * no Sequencer database registered.
   */
  static _spaceFxAsset(kind) {
    const byKind = {
      storm: {
        key: "jb2a.whirlwind.bluegrey",
        files: [
          "modules/jb2a_patreon/Library/7th_Level/Whirlwind/Whirlwind_01_BlueGrey_01_400x400.webm",
          "modules/JB2A_DnD5e/Library/7th_Level/Whirlwind/Whirlwind_01_BlueGrey_01_400x400.webm",
        ],
      },
    };
    const want = byKind[kind];
    if (!want) return null;

    try {
      if (globalThis.Sequencer?.Database?.entryExists?.(want.key)) {
        return { asset: want.key, how: `the Sequencer database entry ${want.key}` };
      }
    } catch (_) { /* no database -> fall through to the files */ }

    const file = want.files.find(f => {
      try { return !!game.modules.get(f.split("/")[1])?.active; } catch (_) { return false; }
    });
    if (file) return { asset: file, how: `the file ${file} (no Sequencer database entry for ${want.key})` };

    // ⚠️ NAMED, NOT SILENT. "no animation configured" and "every path is wrong"
    // look identical on screen, and both of them look like a deleted feature.
    console.warn(`${TAG} nothing installed to draw a "${kind}" space, so it will have no `
      + `picture. The rules are unaffected. Wanted ${want.key}, or one of: ${want.files.join(", ")}`);
    return null;
  }

  /**
   * Where the space is and how big, read from the REGION'S OWN SHAPE.
   *
   * ⚠️ NOT `region.object.bounds`. That is the rendered placeable, and it does
   * not exist yet on the beat the region is created, nor on any client that has
   * not drawn this scene — which made the picture depend on whether the canvas
   * happened to be ready, and fail without a word when it was not. The shape is
   * data and is always there.
   */
  static _spaceFxGeometry(region) {
    const shape = region?.shapes?.[0];
    if (shape) {
      // ⚠️ A CIRCLE IS USUALLY A POLYGON. On a gridded scene Foundry snaps a
      // circular template to the grid and hands back PIXI.Polygon points rather
      // than a radius, so the polygon branch is the NORMAL case for a 50-foot
      // storm, not an exotic one. Checking radius first and giving up would have
      // meant no picture on every gridded map — which is every map he uses.
      const pts = shape.points;
      if (Array.isArray(pts) && pts.length >= 6) {
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (let i = 0; i + 1 < pts.length; i += 2) {
          const px = Number(pts[i]), py = Number(pts[i + 1]);
          if (!Number.isFinite(px) || !Number.isFinite(py)) continue;
          if (px < minX) minX = px;
          if (px > maxX) maxX = px;
          if (py < minY) minY = py;
          if (py > maxY) maxY = py;
        }
        if (Number.isFinite(minX) && maxX > minX) {
          return { x: (minX + maxX) / 2, y: (minY + maxY) / 2,
                   size: Math.max(maxX - minX, maxY - minY) };
        }
      }

      const x = Number(shape.x), y = Number(shape.y);
      if (Number.isFinite(x) && Number.isFinite(y)) {
        // A circle's x/y is its CENTRE; a rectangle's is its top-left corner.
        if (Number.isFinite(Number(shape.radius)) && Number(shape.radius) > 0) {
          return { x, y, size: Number(shape.radius) * 2 };
        }
        if (Number.isFinite(Number(shape.radiusX)) && Number(shape.radiusX) > 0) {
          return { x, y, size: Number(shape.radiusX) * 2 };
        }
        const w = Number(shape.width), h = Number(shape.height);
        if (Number.isFinite(w) && w > 0 && Number.isFinite(h) && h > 0) {
          return { x: x + w / 2, y: y + h / 2, size: Math.max(w, h) };
        }
      }
    }
    const b = region?.object?.bounds;
    if (b?.width) return { x: b.x + b.width / 2, y: b.y + b.height / 2, size: Math.max(b.width, b.height) };
    console.warn(`${TAG} could not work out where "${region?.name ?? "this space"}" is, so it has no picture.`);
    return null;
  }

  static _drawSpaceFx(region) {
    try {
      if (typeof Sequence === "undefined" || !globalThis.Sequencer?.EffectManager) return;
      const space = region?.flags?.[MODULE_ID]?.space;
      if (!space?.kind) return;

      const name = SpaceEffects._spaceFxName(region.id);
      // ⚠️ NEVER TWICE. `play()` returns before Sequencer registers the effect,
      // so a second draw in the same beat stacks a duplicate — seventeen aura
      // rings on one token is what that looks like at scale (2026-09-02).
      try {
        const live = Sequencer.EffectManager.getEffects({ name }) ?? [];
        if (live.length) return;
      } catch (_) { /* unreadable -> fall through and draw once */ }

      const pick = SpaceEffects._spaceFxAsset(space.kind);
      if (!pick) return;                       // already said why, out loud
      const where = SpaceEffects._spaceFxGeometry(region);
      if (!where) return;                      // already said why, out loud

      // ⚠️ NO WALL-CLOCK TIMER. Johnny asked for "a timer for one minute", and
      // the minute that matters is a minute of GAME time: ten rounds, however
      // long the table takes over them. The region already holds `expiresAt` in
      // world seconds and already has a sweeper that deletes it — so the picture
      // simply persists and dies with the region. A `.duration()` here would cut
      // the storm off mid-combat after sixty real-world seconds.
      const expiresAt = Number(region.flags?.[MODULE_ID]?.expiresAt);
      const left = Number.isFinite(expiresAt)
        ? Math.max(0, expiresAt - Number(game.time?.worldTime ?? 0)) : null;

      new Sequence().effect()
        .file(pick.asset)
        .atLocation({ x: where.x, y: where.y })
        .size({ width: where.size, height: where.size })
        // ⚠️ UNDER THE ART. "It should always be beneath the tokens' feet."
        // A storm drawn over the tokens hides the creatures standing in it,
        // which is the one thing the GM needs to see.
        .belowTokens()
        .opacity(0.8)
        .fadeIn(800).fadeOut(1200)
        .persist()
        .name(name)
        .play()
        .catch(err => console.warn(`${TAG} space effect failed to play:`, err));

      console.log(`${TAG} "${region.name}" is drawn with ${pick.how}, under the tokens, `
        + (left == null ? "until it is removed." : `for ${left} seconds of game time.`));
    } catch (err) {
      console.warn(`${TAG} could not draw this space:`, err);
    }
  }

  static _endSpaceFx(regionId) {
    try { Sequencer?.EffectManager?.endEffects?.({ name: SpaceEffects._spaceFxName(regionId) }); }
    catch (err) { console.warn(`${TAG} could not end a space effect:`, err); }
  }

  /**
   * ⚠️ EVERY CLIENT DRAWS. A player who joins mid-storm, or anyone changing
   * scene, has no effect for a region that was created before they arrived —
   * the same shape as chat cards drawn before their handler registered.
   */
  static redrawSpaceFx() {
    for (const region of (canvas?.scene?.regions ?? [])) {
      if (region.flags?.[MODULE_ID]?.space) SpaceEffects._drawSpaceFx(region);
    }
  }

  static _announceCrossings(tokenDoc) {
    try {
      const tok = tokenDoc?.object;
      if (!tok || tok.destroyed) return;
      // ⚠️🔴 EVERY SPACE, NOT THE TWO THIS WAS WRITTEN FOR.
      //
      // This filtered to `obscurement === "heavy" || silence` — correct on the
      // day it was written, when the only job here was whispering about darkness
      // and Silence. Everything added since hangs off this same walk: stamping a
      // condition on entry, taking it off on exit, and now imposing disadvantage.
      // All of it was gated behind a filter that predates all of it.
      //
      // Johnny, 2026-09-03: he moved the Lich and a wizard into Thunderstorm of
      // Misery and got "absolutely nothing". The storm is LIGHTLY obscured and
      // not silent, so it was dropped on this line before anything could happen
      // to anybody standing in it. Fog Cloud, Grease, Spike Growth and every
      // other lightly-obscured or difficult-terrain space had the same hole.
      //
      // ⚠️ AND IT ALSO BROKE LEAVING. `_lastSpaces` was fed from this filtered
      // list, so a space that never got in could never be recorded as left, and
      // `_unstamp` was never called for it. The marks would have outlived the
      // space.
      //
      // The filter now lives where it belongs: a space that has nothing to SAY
      // simply produces no line, below, while still being tracked and still
      // applying whatever it applies.
      const inside = SpaceEffects.spacesAtToken(tok);
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
        // A space can also make something HARDER without inflicting a condition.
        if (space.disadvantage) SpaceEffects._hinder(tok, region, space.disadvantage).catch(() => {});
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
        // ⚠️🔴 SAY A PENALTY ONCE. Light obscurement's whole mechanical effect is
        // disadvantage on SIGHT Perception. This storm ALSO declares disadvantage
        // on Perception outright, because the staff's text extends it to hearing
        // as well. Those are one penalty of different widths, and I announced
        // both on 2026-09-03: "LIGHTLY OBSCURED — disadvantage on sight
        // Perception" immediately followed by "DISADVANTAGE on Perception checks
        // while inside".
        //
        // Johnny saw it before I did. On screen that reads as two stacking
        // penalties, and disadvantage does not stack — one source and ten
        // sources roll the same two dice. Only ONE effect was ever applied; the
        // card was lying about the count.
        //
        // ⚠️ THE WIDER ONE WINS AND ABSORBS THE OTHER. Never print both.
        const wideSkills = space.disadvantage?.skills ?? [];
        const coversPerception = wideSkills.includes("prc");
        const skillNames = (ks) => ks.map(k => CONFIG.DND5E?.skills?.[k]?.label ?? k).join(" and ");

        if (space.obscurement === "light") {
          bits.push(coversPerception
            ? "LIGHTLY OBSCURED — disadvantage on ALL Perception checks inside, sight and hearing alike; it does not hide anyone by itself"
            : "LIGHTLY OBSCURED — disadvantage on sight Perception; it does not hide anyone by itself");
        } else if (coversPerception || wideSkills.length) {
          bits.push(`DISADVANTAGE on ${skillNames(wideSkills)} checks while inside`);
        }
        if (space.silence) bits.push("in SILENCE — no verbal casting");
        if (Number(space.difficultTerrain) > 1) {
          bits.push(`DIFFICULT TERRAIN ×${Number(space.difficultTerrain)}`);
        }
        // Anything the obscurement line did not already absorb.
        const leftover = space.obscurement === "light"
          ? wideSkills.filter(k => k !== "prc") : [];
        if (leftover.length) bits.push(`DISADVANTAGE on ${skillNames(leftover)} checks while inside`);
        if (space.stampInside?.length) bits.push(`${space.stampInside.join(" + ").toUpperCase()} while inside`);
        // (the disadvantage line is built above, where it can absorb the
        // obscurement's overlapping half instead of repeating it)
        // A space with nothing to say is still tracked; it just gets no line.
        if (!bits.length) continue;
        // ⚠️ BACKSTOP. The logic above is what stops a penalty being said twice;
        // this only catches a future line that slips through word-for-word.
        const said = [...new Set(bits)];
        lines.push(`<b>${foundry.utils.escapeHTML(tok.name)}</b> entered <b>${foundry.utils.escapeHTML(region.name)}</b>: ${said.join("; ")}.`);
      }
      for (const regionId of left) {
        // ⚠️ NAME WHAT THEY LEFT. "left the obscured/silenced area" was written
        // when there were only two kinds; with several spaces overlapping, a
        // creature stepping out of one and staying in another needs to know
        // WHICH one let go of it.
        const name = canvas?.scene?.regions?.get?.(regionId)?.name ?? "an ACE space";
        lines.push(`<b>${foundry.utils.escapeHTML(tok.name)}</b> left <b>${foundry.utils.escapeHTML(name)}</b>.`);
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
      `${TAG} template ${templateDoc.id} (${templateDoc.t}/${templateDoc.distance} feet) `
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
        system: { difficulties: SpaceEffects._terrainDifficulties(Number(space.difficultTerrain) || 2, space.terrainModes) },
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
          // When this space ends on its own, in world-time seconds. Null for
          // spaces that genuinely last until dispelled (Plant Growth) and for
          // concentration spells, which end when concentration does.
          expiresAt: Number(entry?.durationSeconds) > 0
            ? Number(game.time?.worldTime ?? 0) + Number(entry.durationSeconds)
            : null,
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
            // ⚠️ EXPLICIT, LIKE EVERY FIELD HERE. A value added to the table and
            // not added to this list is dropped in transit: the entry is right,
            // the reader is right, and the value never arrives.
            disadvantage: space.disadvantage ?? null,
            casterActorId: item.actor?.id ?? null,
          },
        },
      },
    };

    try {
      const created = await scene.createEmbeddedDocuments("Region", [regionData]);
      console.log(`${TAG} "${item.name}" [${edition}] → live space region ${created?.[0]?.id} (${props.join(", ") || "properties only"})`);
      // The picture lasts as long as the space does. See _drawSpaceFx.
      // No delay: the geometry comes from the region's shape, not its sprite.
      if (created?.[0]) SpaceEffects._drawSpaceFx(created[0]);
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
          `${TAG} DISCREPANCY: "${item.name}" placed a ${actualT} template of ${actualSize} feet, `
          + `but the rules say ${exp.type} of ${exp.size} feet. The placed template stands; `
          + `check the item's target configuration.`
        );
      }
    } catch (_) { /* report-only — never blocks */ }
  }

  /**
   * Difficulty multipliers per movement action — mirror of the proven
   * concentration-widget builder (kept in both places deliberately: the legacy
   * path still owns spells without rules entries).
   *
   * ⚠️ FLYING (fixed 2026-07-27). The old version applied the multiplier to
   * EVERY non-derived action and the comment claimed fly was "derived". It
   * isn't: Foundry V13 defines nine actions and only crawl, climb, jump, blink
   * and displace carry `deriveTerrainDifficulty` — walk, fly, swim and burrow
   * all got charged. So a creature flying 35 feet above a patch of grease or a
   * storm's slippery ground paid double movement for terrain it never touched,
   * which is not RAW: ground-based difficult terrain doesn't reach a flier.
   *
   * `modes` names the movement types the terrain actually impedes, defaulting
   * to ground travel. A volume-filling effect (Web, Hunger of Hadar, Wall of
   * Thorns, Insect Plague) declares `["walk","fly"]` because flying THROUGH it
   * is just as slow. Everything not listed is pinned to 1 — unaffected.
   *
   * The derived actions resolve themselves afterwards from what we set here:
   * crawl and climb follow walk, jump takes max(walk, fly).
   */
  static _terrainDifficulties(mult, modes = null) {
    const want = new Set(Array.isArray(modes) && modes.length ? modes : ["walk"]);
    const out = {};
    try {
      const actions = CONFIG?.Token?.movement?.actions ?? {};
      for (const [key, cfg] of Object.entries(actions)) {
        if (cfg?.deriveTerrainDifficulty) continue;   // crawl/climb/jump/blink/displace derive
        out[key] = want.has(key) ? mult : 1;
      }
    } catch (_) { /* fall through */ }
    if (!Object.keys(out).length) out.walk = mult;
    return out;
  }

  // ────────────────────────────────────────────────────────────────────────────
  //  Lifecycle — spaces end on their own, and the GM can always end them early
  // ────────────────────────────────────────────────────────────────────────────

  /** Delete every ACE space whose duration has run out. Returns the count. */
  /**
   * How much game time a space has left, or null when it has no clock of its
   * own and must be ended by whatever created it.
   *
   * ⚠️ PURE, BECAUSE GETTING IT WRONG COSTS A FEATURE. This one comparison
   * decides whether a space survives the tidying-away of its template, and it
   * has three genuinely different answers hiding in it: a clock with time on it,
   * a clock that has run out, and no clock at all. A concentration space has no
   * `expiresAt` and MUST still die with its template.
   */
  static timeLeft(expiresAt, now) {
    const until = (expiresAt === null || expiresAt === undefined || expiresAt === "")
      ? NaN : Number(expiresAt);
    if (!Number.isFinite(until)) return null;      // no clock -> not ours to keep
    const left = until - (Number(now) || 0);
    return left > 0 ? left : null;                 // already run out -> let it go
  }

  static async sweepExpired() {
    const now = Number(game.time?.worldTime ?? 0);
    let removed = 0;
    for (const sc of (game.scenes ?? [])) {
      const dead = [...(sc.regions ?? [])].filter(r => {
        const exp = r.getFlag?.(MODULE_ID, "expiresAt");
        return typeof exp === "number" && now >= exp;
      });
      if (!dead.length) continue;
      removed += await SpaceEffects._deleteSpaces(sc, dead);
    }
    if (removed) console.log(`${TAG} expired ${removed} space(s)`);
    return removed;
  }

  /**
   * The GM's off-switch. Clears ACE-created spaces — the regions AND the
   * templates that spawned them — so a scene can always be put back to normal
   * without hunting through the region layer by hand.
   *
   *   game.aceQol.clearSpaces()              → this scene
   *   game.aceQol.clearSpaces({ all: true }) → every scene in the world
   */
  static async clearSpaces({ scene = null, all = false, quiet = false } = {}) {
    if (!game.user?.isGM) {
      ui.notifications?.warn("Only the GM can clear spell spaces.");
      return 0;
    }
    const scenes = all ? [...(game.scenes ?? [])] : [scene ?? canvas?.scene].filter(Boolean);
    let removed = 0;
    for (const sc of scenes) {
      // BOTH creators. ACE has two paths that write terrain regions and they
      // use different flags: the rules engine stamps `spaceFor`/`space`, while
      // the older concentration-widget creator stamps `difficultTerrainFor`.
      // Sweeping only the first left the legacy ones behind still multiplying
      // movement cost, which is exactly the "I cleared it but it's still wrong"
      // trap. Anything ACE created, this clears.
      const mine = [...(sc.regions ?? [])].filter(r =>
        r.getFlag?.(MODULE_ID, "space")
        || r.getFlag?.(MODULE_ID, "spaceFor")
        || r.getFlag?.(MODULE_ID, "difficultTerrainFor"));
      if (mine.length) removed += await SpaceEffects._deleteSpaces(sc, mine);
    }
    if (!quiet) {
      ui.notifications?.info(removed
        ? `Cleared ${removed} spell space${removed === 1 ? "" : "s"}${all ? " (all scenes)" : ""}.`
        : "No ACE spell spaces to clear.");
    }
    console.log(`${TAG} GM cleared ${removed} space(s)`);
    return removed;
  }

  /**
   * Wipe banked movement history.
   *
   * Deleting a bad terrain region does NOT retroactively fix distances already
   * recorded while it was live — Foundry banks the cost of each step in the
   * token's movement history, so a creature that walked through a stack of
   * runaway regions keeps showing hundreds of feet used even after the regions
   * are gone. Clearing the regions fixes the FUTURE; this fixes the PAST.
   * (Found the hard way 2026-07-28: Chudd stayed broken until his history was
   * wiped by hand.)
   *
   * Deliberately NOT automatic inside clearSpaces — wiping history mid-turn
   * hands a creature its movement back, which is a real ruling, not cleanup.
   *
   *   game.aceQol.clearMovementHistory()             → every token on this scene
   *   game.aceQol.clearMovementHistory(token)        → just that one
   */
  static async clearMovementHistory(target = null) {
    if (!game.user?.isGM) {
      ui.notifications?.warn("Only the GM can clear movement history.");
      return 0;
    }
    const docs = target
      ? [target.document ?? target].filter(Boolean)
      : [...(canvas?.scene?.tokens ?? [])];
    let done = 0;
    for (const doc of docs) {
      try {
        if (typeof doc.clearMovementHistory === "function") {
          await doc.clearMovementHistory();
          done++;
        }
      } catch (err) {
        console.warn(`${TAG} movement-history clear failed for ${doc?.name}:`, err);
      }
    }
    ui.notifications?.info(`Cleared movement history on ${done} token${done === 1 ? "" : "s"}.`);
    console.log(`${TAG} cleared movement history on ${done} token(s)`);
    return done;
  }

  /** Remove regions + the templates that spawned them. Templates first: the
   *  template-delete hook cascades to its region, so this stays consistent even
   *  if one of the two deletes fails. */
  static async _deleteSpaces(scene, regions) {
    if (!scene || !regions?.length) return 0;
    try {
      const tplIds = [...new Set(regions
        .map(r => r.getFlag?.(MODULE_ID, "spaceFor"))
        .filter(id => id && scene.templates?.get?.(id)))];
      if (tplIds.length) {
        await scene.deleteEmbeddedDocuments("MeasuredTemplate", tplIds).catch(() => {});
      }
      // Anything the cascade didn't take (template already gone) goes now.
      const ids = regions.map(r => r.id).filter(id => scene.regions?.get?.(id));
      if (ids.length) await scene.deleteEmbeddedDocuments("Region", ids).catch(() => {});
      return regions.length;
    } catch (err) {
      console.warn(`${TAG} space delete failed:`, err);
      return 0;
    }
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

  /**
   * Plain English: which ACE spaces is this token standing in, and if none,
   * how far outside each one is it?
   *
   * ⚠️ BECAUSE "NOTHING HAPPENED" HAS TWO CAUSES AND THEY LOOK IDENTICAL.
   * Either the space did not act on a creature inside it, or the creature was
   * never inside. Johnny hit the first on 2026-09-03 and there was no way to
   * rule out the second without arithmetic on log coordinates. Containment is
   * v1 CENTRE-BASED: a big creature half in the circle is out.
   */
  static describeSpacesAt(token = null) {
    const tok = token ?? canvas?.tokens?.controlled?.[0];
    if (!tok) return "Select a token first.";
    const doc = tok.document ?? tok;
    const centre = tok.center ?? {
      x: (doc.x ?? 0) + ((doc.width ?? 1) * (canvas?.grid?.size ?? 100)) / 2,
      y: (doc.y ?? 0) + ((doc.height ?? 1) * (canvas?.grid?.size ?? 100)) / 2,
    };
    const perFt = (canvas?.grid?.size ?? 100) / (canvas?.grid?.distance ?? 5);
    const rows = [];
    for (const region of (doc.parent?.regions ?? canvas?.scene?.regions ?? [])) {
      const space = region.getFlag?.(MODULE_ID, "space");
      if (!space) continue;
      let inside = false;
      try { inside = region.testPoint?.({ ...centre, elevation: Number(doc.elevation ?? 0) }) ?? false; }
      catch (_) { /* reported as not inside, and the distance below still tells him why */ }
      const g = SpaceEffects._spaceFxGeometry(region);
      const away = g ? Math.round(Math.hypot(centre.x - g.x, centre.y - g.y) / perFt) : null;
      const across = g ? Math.round((g.size / 2) / perFt) : null;
      rows.push(`${inside ? "INSIDE" : "outside"} "${region.name}"`
        + (away == null ? "" : ` — its centre is ${away} ft from the middle of a space that reaches ${across} ft`)
        + ` [${space.kind ?? "space"}${space.disadvantage?.skills?.length
            ? `, disadvantage on ${space.disadvantage.skills.join("/")}` : ""}`
        + `${Number(space.difficultTerrain) > 1 ? `, difficult terrain ×${space.difficultTerrain}` : ""}]`);
    }
    if (!rows.length) return `There are no ACE spaces on this scene, so ${tok.name} cannot be in one.`;
    return `${tok.name} (elevation ${Number(doc.elevation ?? 0)} ft):\n  ` + rows.join("\n  ");
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

  /**
   * Make something HARDER while inside, without inflicting a condition.
   *
   * ⚠️🔴 WHY THIS IS NOT JUST ANOTHER STAMP. Thunderstorm of Misery stamped
   * `deafened` to model "hard to hear", and deafened is a much bigger hammer
   * than the staff swings: RAW it auto-fails every check that needs hearing.
   * The item says disadvantage on Perception. There was no way to express that,
   * so the nearest condition was used instead, and the nearest condition was
   * wrong.
   *
   * ⚠️ THE SYSTEM'S OWN FIELD, NOT A MADE-UP FLAG. dnd5e 5.x models this as
   * `system.skills.<key>.roll.mode`, where -1 is disadvantage, and `AdvantageModeField`
   * counts SOURCES rather than overwriting: mode ADD registers one more source,
   * so this stacks correctly with anything else and unwinds correctly when the
   * storm lifts. Passive Perception drops by 5 on its own, because the system
   * computes the passive score from that same mode. Nothing here re-implements
   * a rule the system already has.
   *
   * ⚠️ AND IT CARRIES THE SAME `spaceStamp` FLAG as a condition stamp, so
   * `_unstamp` removes it on the way out with no second cleanup path to keep in
   * step.
   */
  static async _hinder(token, region, spec) {
    try {
      const actor = token?.actor;
      if (!actor || !spec) return;

      // Already marked by THIS region? (re-entry within the same region)
      if (actor.effects.some(e => e.getFlag?.(MODULE_ID, "spaceHinder") === region.id)) return;

      const changes = [];
      const named = [];
      for (const key of (spec.skills ?? [])) {
        const id = String(key).toLowerCase();
        // ⚠️ A TYPO MUST NOT BE SILENT. An unknown skill key writes a change
        // nothing reads, which looks exactly like a working feature.
        if (!CONFIG.DND5E?.skills?.[id]) {
          console.warn(`${TAG} "${region.name}" wants disadvantage on skill "${id}", `
            + `which this system does not have. Skipping it. Known keys: `
            + Object.keys(CONFIG.DND5E?.skills ?? {}).join(", "));
          continue;
        }
        changes.push({
          key: `system.skills.${id}.roll.mode`,
          mode: CONST.ACTIVE_EFFECT_MODES.ADD,
          value: "-1",
          priority: 20,
        });
        named.push(CONFIG.DND5E.skills[id].label ?? id);
      }
      if (!changes.length) return;

      await actor.createEmbeddedDocuments("ActiveEffect", [{
        name: `${named.join(" + ")} disadvantage (${region.name})`,
        img: "icons/svg/downgrade.svg",
        changes,
        flags: { [MODULE_ID]: { spaceStamp: region.id, spaceHinder: region.id } },
      }]);
      console.log(`${TAG} ${token.name} has disadvantage on ${named.join(" and ")} `
        + `while inside ${region.name}.`);
    } catch (err) {
      console.warn(`${TAG} could not apply this space's disadvantage:`, err);
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
