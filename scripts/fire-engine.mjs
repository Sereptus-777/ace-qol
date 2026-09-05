// ─── ACE: QOL — Fire ─────────────────────────────────────────────────────────
//
// Johnny, 2026-09-02: "I want a button, a macro, or something where I could set
// shit on fire, and not necessarily a tile. I want to be able to draw an area
// and have it on fire, or burn the dragon token... since time goes by in our
// world, I want a timer on how long it takes, depending on how big the fire is
// and what it has for fuel to burn."
//
// His four answers, which are the whole specification:
//   • it should hurt
//   • it should spread
//   • he picks the fuel when he draws the area
//   • a burned body leaves a smoking pile of ash, not a corpse
//
// ═══ THIS IS ASSEMBLY, NOT INVENTION ═════════════════════════════════════════
//
// ⚠️ EVERY MOVING PART OF THIS ALREADY EXISTED, AND BUILDING A SECOND ONE OF ANY
// OF THEM IS THE MISTAKE HE CAUGHT ME MAKING ON 2026-08-11: "we're just doing a
// band-aid fix for everything... We have a damage pipeline. Why did you have to
// build a whole new chat card?"
//
//   the clock          world time, GM-only writes, socket-guarded  -> when it ends
//   overtime engine    per-round damage + a save to end            -> it hurts
//   regions            a drawn footprint with flags and lifecycle  -> the area
//   geometry-utils     template -> region shape                    -> the drawing
//   death pipeline     texture swap + flags on a token             -> the ash
//   Sequencer + JB2A   campfire, bonfire, fumes                    -> the look
//
// So the only genuinely new thing here is the FUEL MODEL: how long a given
// thing burns, and how fast the fire eats outward. Everything else is a call.
//
// ⚠️ WORLD TIME, NEVER A WALL CLOCK. A fire started before a long rest must be
// out when the party wakes, and a fire lit in combat must burn round by round.
// Both fall out of anchoring to `game.time.worldTime`, and neither works if
// this counts real seconds. The clock is also why the GM rewinding time puts a
// fire back — that is correct, not a bug.
//
// ⚠️ ONE CLIENT WRITES. Scene and actor writes are activeGM-gated, exactly like
// the aura engine and space effects. Two GMs connected must not double-apply
// burning damage, which is the split-brain that cost a day on 2026-08-15.
const MODULE_ID = "ace-qol";
const FLAG_NS = "ace-qol";

import { TheClock } from "./the-clock.mjs";
import { onCanvasReady } from "./ready-utils.mjs";
import { buildRegionShapeFromTemplate } from "./geometry-utils.mjs";

const LOG = `${MODULE_ID} | Fire`;

/** Every Sequencer effect this engine places is named with this prefix. */
const FX_PREFIX = "ace-qol-fire:";

/**
 * How long things burn, and how fast the fire eats outward.
 *
 * ⚠️ MINUTES, BECAUSE THAT IS THE UNIT HE THINKS IN. "Rock isn't going to burn
 * too long, but it should be maybe a couple minutes, depending on what's used to
 * start the fire." Stored as minutes here and converted to world seconds once,
 * at ignition, so nothing downstream has to remember which unit it is holding.
 *
 * ⚠️ `spreadFtPerMin` IS ZERO FOR THINGS THAT CANNOT CARRY A FIRE. Bare stone
 * and a puddle of oil both burn out where they are. Grass runs. This is the
 * whole of the spread model and it is deliberately that small: a fire that
 * crawls square by square across a battlemap needs a fuel map of the scene,
 * and ACE cannot read one out of a background image without guessing.
 */
export const FUELS = {
  stone: {
    label: "Bare stone or earth",
    hint: "Nothing here really burns. Only what you threw at it.",
    minutes: 2, spreadFtPerMin: 0, maxSpreadFt: 0, damage: "1d6",
  },
  debris: {
    label: "Scattered debris",
    hint: "Bones, rags, splintered wood. Burns out fairly quickly.",
    minutes: 5, spreadFtPerMin: 5, maxSpreadFt: 15, damage: "1d6",
  },
  grass: {
    label: "Dry grass or undergrowth",
    hint: "Runs fast and wide, then leaves nothing.",
    minutes: 10, spreadFtPerMin: 15, maxSpreadFt: 60, damage: "1d6",
  },
  timber: {
    label: "Timber, furniture, a cart",
    hint: "Slow to spread, but it burns for a long time and burns hot.",
    minutes: 30, spreadFtPerMin: 5, maxSpreadFt: 20, damage: "2d6",
  },
  oil: {
    label: "A pool of oil",
    hint: "Short and vicious. Goes no further than the pool.",
    minutes: 3, spreadFtPerMin: 0, maxSpreadFt: 0, damage: "2d6",
  },
  body: {
    label: "A body",
    hint: "How long depends on how big it is.",
    minutes: 5, spreadFtPerMin: 0, maxSpreadFt: 0, damage: "1d6",
  },
};

/**
 * A body burns by size, because the body IS the fuel.
 *
 * ⚠️ HIS SHADOW DRAGON IS HUGE, SO HALF AN HOUR. These are the numbers I put to
 * him and he did not push back on any of them; they are here as one table so
 * changing his mind is one edit rather than a hunt.
 */
const BODY_MINUTES = { tiny: 1, sm: 3, med: 5, lg: 15, huge: 30, grg: 60 };

/**
 * What lit it changes how hard it hits, NOT how long it lasts.
 *
 * ⚠️ THE DISTINCTION MATTERS AND IT IS EASY TO GET BACKWARDS. A Fireball does
 * not make a corpse burn longer than a torch does; the corpse is the same amount
 * of fuel either way. It makes the first minutes fiercer, and it lights
 * everything at once instead of one square.
 */
export const IGNITION = {
  torch:      { label: "A torch or tinder",        damageBonus: 0, spreadBonusFt: 0,  headStartFt: 0 },
  oilFlask:   { label: "Oil flask or alchemist's fire", damageBonus: 1, spreadBonusFt: 5, headStartFt: 5 },
  spell:      { label: "Fireball or a dragon's breath", damageBonus: 2, spreadBonusFt: 10, headStartFt: 10 },
};

/** Where the ash art comes from, his own file first. */
const ASH_ART = [
  `modules/${MODULE_ID}/Assets/Fire/ash.webp`,
  `modules/${MODULE_ID}/Assets/Fire/ash.png`,
];

// ⚠️🔴 NO FOUNDRY STOCK ART ON HIS TOKENS. The fallback used to be
// `icons/environment/settlement/building-rubble.webp`, so a body that burned
// out turned into a core Foundry pile of rubble. Johnny, seeing it: "I don't
// like whatever fucking picture you have underneath it. It should take the
// token and just do the fire."
//
// So the token now KEEPS ITS OWN ART unless he has supplied a file above. It
// is still renamed, still flagged as ash, still holds the loot — only the
// picture is left alone. A missing asset must not mean a picture he never
// chose.
const ASH_ART_HINT = `modules/${MODULE_ID}/Assets/Fire/ash.webp`;

export class FireEngine {

  /* ═══ Small shared readers ═══════════════════════════════════════════════ */

  /**
   * ⚠️ THROUGH THE CLOCK, NOT PAST IT. `TheClock.now` is the suite's one reader
   * of world time. Reading `game.time.worldTime` here as well would be a second
   * answer to the same question, which is how the cast-time and entry checks
   * came to disagree about who was standing in a Moonbeam.
   */
  static get now() { return TheClock.now; }

  static _isActiveGM() { return game.users?.activeGM === game.user; }

  /**
   * The first of these Sequencer entries this JB2A install actually has.
   *
   * ⚠️ NAMED, NEVER SILENT. A missing asset and a disabled Sequencer must not
   * look the same in the console — that lesson cost a day on the aura rings,
   * where "nothing is playing" could have meant either.
   */
  static _resolveFx(candidates) {
    for (const c of candidates) {
      // ⚠️ A PLAIN FILE PATH IS A VALID ANSWER. Database keys get renamed
      // between JB2A releases; the file on disk does not. Anything with a slash
      // is taken as a path and used as-is, so a renamed key still leaves a
      // working picture instead of a warning nobody reads.
      if (typeof c === "string" && c.includes("/")) return c;
      try { if (globalThis.Sequencer?.Database?.entryExists?.(c)) return c; } catch (_) { /* next */ }
    }
    console.warn(`${LOG} | none of these fire effects are in this JB2A install, so `
      + `the fire will burn without a picture: ${candidates.join(", ")}`);
    return null;
  }

  /**
   * The flame that sits on a burning token or square.
   *
   * ⚠️🔴 A CAMPFIRE ASSET DRAWS A CAMPFIRE. This asked for
   * `jb2a.campfire.01.orange` first, and that effect is not "fire" — it is a
   * hearth, logs and a ring of stones included. So every burning corpse on his
   * map had a campfire painted under it. Johnny: "The first one's got a
   * campfire, for fuck's sake... It should take the token and just do the
   * fire."
   *
   * The Flames03 set is what he actually wants: bare flame, authored at 5x5 and
   * 10x10 feet, nothing underneath it. Paths are used rather than database keys
   * because these were read off his own install and a renamed key would put the
   * campfire back.
   */
  static _flamePath(big = false) {
    const F = "modules/jb2a_patreon/Library/Generic/Fire/Flame";
    return FireEngine._resolveFx(big
      ? [`${F}/Flames03_01_Regular_Orange_10x10ft_400x400.webm`,
         `${F}/Flames03_02_Regular_Orange_10x10ft_400x400.webm`,
         "jb2a.flames.01.orange"]
      : [`${F}/Flames03_01_Regular_Orange_05x05ft_300x300.webm`,
         `${F}/Flames03_02_Regular_Orange_05x05ft_300x300.webm`,
         "jb2a.flames.01.orange"]);
  }

  /** The smoke left behind on the ash. */
  static _smokePath() {
    return FireEngine._resolveFx([
      "jb2a.smoke.puff.centered.grey.0",
      "jb2a.fumes.04.loop.grey",
      "jb2a.fumes.steam.white",
      "jb2a.fumes.fire.orange",
    ]);
  }

  /** The first ash image that exists, or the last candidate as a last resort. */
  static async _ashArt() {
    const FP = foundry.applications?.apps?.FilePicker?.implementation ?? globalThis.FilePicker;
    for (const path of ASH_ART) {
      try {
        const dir = path.slice(0, path.lastIndexOf("/"));
        const res = await FP.browse("data", dir);
        if ((res.files ?? []).some(f => decodeURIComponent(f) === decodeURIComponent(path))) return path;
      } catch (_) { /* that folder does not exist; try the next */ }
    }
    // ⚠️ NULL MEANS "LEAVE HIS TOKEN ALONE", and that is the right answer
    // when he has not chosen a picture. Substituting core Foundry art put a
    // pile of rubble on his map that he never picked.
    console.log(`${LOG} | no ash art supplied, so burnt-out tokens keep their own `
      + `picture. Drop one at ${ASH_ART_HINT} and it will be used instead.`);
    return null;
  }

  /* ═══ Igniting ═══════════════════════════════════════════════════════════ */

  /**
   * Set a creature alight.
   *
   * ⚠️ THE FUEL IS THE BODY, SO THE SIZE DECIDES THE TIME. A rat and a dragon
   * lit by the same torch do not burn for the same length, and a single flat
   * duration would have made the whole feature feel arbitrary.
   */
  static async igniteToken(tokenDoc, { ignition = "torch", fuel = "body" } = {}) {
    if (!FireEngine._isActiveGM()) return null;
    try {
      const doc = tokenDoc?.document ?? tokenDoc;
      if (!doc) return null;

      if (doc.flags?.[FLAG_NS]?.fire) {
        console.log(`${LOG} | ${doc.name} is already burning.`);
        return null;
      }

      const size = doc.actor?.system?.traits?.size ?? "med";
      const spec = FUELS[fuel] ?? FUELS.body;
      const minutes = fuel === "body" ? (BODY_MINUTES[size] ?? 5) : spec.minutes;
      // ⚠️ SAY WHY IT BURNS THAT LONG. Johnny lit a body and it burned for
      // one minute; a body's clock comes from its SIZE, and one minute is the
      // Tiny row. Without this line the only way to tell a wrong size from a
      // wrong table is to read the source.
      if (fuel === "body") {
        console.log(`${LOG} | ${doc.name} is size "${size}", so its body burns for `
          + `${minutes} minute${minutes === 1 ? "" : "s"} `
          + `(tiny 1 · small 3 · medium 5 · large 15 · huge 30 · gargantuan 60).`);
      }
      const src = IGNITION[ignition] ?? IGNITION.torch;

      const record = {
        kind: "token",
        fuel, ignition,
        startedAt: FireEngine.now,
        endsAt: FireEngine.now + Math.round(minutes * 60),
        minutes,
        damage: spec.damage,
        damageBonus: src.damageBonus,
      };

      await doc.update({ [`flags.${FLAG_NS}.fire`]: record });
      await FireEngine._applyBurning(doc, record);
      FireEngine._drawTokenFlame(doc);

      const until = FireEngine._describeRemaining(record);
      console.log(`${LOG} | ${doc.name} is on fire: ${spec.label.toLowerCase()}, `
        + `lit by ${src.label.toLowerCase()}, ${until}.`);
      ui.notifications?.info(`${doc.name} is on fire. ${until}.`);
      return record;
    } catch (err) {
      console.error(`${LOG} | could not set that creature on fire:`, err);
      ui.notifications?.error("ACE: could not set that creature on fire, see the console.");
      return null;
    }
  }

  /**
   * Set a drawn area alight, from a measured template the GM has just placed.
   *
   * ⚠️ THE TEMPLATE IS THE DRAWING, THE REGION IS THE FIRE. A template is a
   * transient aiming aid; a region persists, carries flags, and is what every
   * later question ("is this creature standing in it") already knows how to
   * ask. Space effects reached the same conclusion for spells and this reuses
   * its shape reader rather than measuring a second time.
   */
  static async igniteTemplate(templateDoc, { fuel = "debris", ignition = "torch" } = {}) {
    if (!FireEngine._isActiveGM()) return null;
    try {
      const scene = templateDoc?.parent ?? canvas?.scene;
      if (!scene) return null;

      const shape = buildRegionShapeFromTemplate(templateDoc);
      if (!shape) {
        // ⚠️ "COULD NOT READ THE SHAPE" IS NOT "NOTHING WAS DRAWN".
        console.warn(`${LOG} | that template's footprint could not be read, so no fire `
          + `was started. Nothing has been changed.`);
        ui.notifications?.warn("ACE: could not read that shape, so nothing was set alight.");
        return null;
      }

      const spec = FUELS[fuel] ?? FUELS.debris;
      const src = IGNITION[ignition] ?? IGNITION.torch;

      const record = {
        kind: "area",
        fuel, ignition,
        startedAt: FireEngine.now,
        endsAt: FireEngine.now + Math.round(spec.minutes * 60),
        minutes: spec.minutes,
        damage: spec.damage,
        damageBonus: src.damageBonus,
        // Spread is measured from where it started, so a fire cannot creep
        // forever by accumulating rounding.
        spreadFtPerMin: spec.spreadFtPerMin + (spec.spreadFtPerMin > 0 ? src.spreadBonusFt : 0),
        maxSpreadFt: spec.maxSpreadFt > 0 ? spec.maxSpreadFt + src.headStartFt : 0,
        spreadSoFarFt: spec.maxSpreadFt > 0 ? src.headStartFt : 0,
        baseShape: shape,
      };

      const [region] = await scene.createEmbeddedDocuments("Region", [{
        name: `ACE — Fire (${spec.label})`,
        color: "#e06010",
        shapes: [FireEngine._grownShape(shape, record.spreadSoFarFt)],
        behaviors: [],
        flags: { [FLAG_NS]: { fire: record } },
      }]);

      FireEngine._drawAreaFlames(region);
      await FireEngine._burnOccupants(region);

      const until = FireEngine._describeRemaining(record);
      console.log(`${LOG} | area alight: ${spec.label.toLowerCase()}, lit by `
        + `${src.label.toLowerCase()}, ${until}.`);
      ui.notifications?.info(`Fire started: ${spec.label.toLowerCase()}. ${until}.`);

      // The template was the aiming aid. The region is the fire.
      try { await templateDoc.delete(); } catch (_) { /* he can delete it himself */ }
      return region;
    } catch (err) {
      console.error(`${LOG} | could not set that area on fire:`, err);
      ui.notifications?.error("ACE: could not set that area on fire, see the console.");
      return null;
    }
  }

  /**
   * The same shape, grown outward by a number of feet.
   *
   * ⚠️ GROWN FROM THE ORIGINAL EVERY TIME, NEVER FROM THE LAST ONE. Compounding
   * a grow step onto an already-grown shape turns a rounding error into a fire
   * that quietly eats the map, and it cannot be undone once written.
   */
  static _grownShape(base, ft) {
    const grid = canvas?.grid;
    const px = (Number(ft) || 0) * ((grid?.size ?? 100) / (canvas?.scene?.grid?.distance ?? 5));
    if (!(px > 0)) return foundry.utils.deepClone(base);

    if (base.type === "circle") {
      return { ...base, radius: base.radius + px };
    }
    if (base.type === "rectangle") {
      return { ...base, x: base.x - px, y: base.y - px,
               width: base.width + px * 2, height: base.height + px * 2 };
    }
    if (base.type === "polygon" && Array.isArray(base.points)) {
      // Push every vertex away from the centroid. Crude next to a real offset
      // polygon, and correct enough for a fire edge nobody measures to the inch.
      const pts = base.points;
      let cx = 0, cy = 0;
      for (let i = 0; i < pts.length; i += 2) { cx += pts[i]; cy += pts[i + 1]; }
      const n = pts.length / 2;
      cx /= n; cy /= n;
      const out = [];
      for (let i = 0; i < pts.length; i += 2) {
        const dx = pts[i] - cx, dy = pts[i + 1] - cy;
        const len = Math.hypot(dx, dy) || 1;
        out.push(pts[i] + (dx / len) * px, pts[i + 1] + (dy / len) * px);
      }
      return { ...base, points: out };
    }
    return foundry.utils.deepClone(base);
  }

  /* ═══ It hurts ═══════════════════════════════════════════════════════════ */

  /**
   * Put Burning on a creature, as an OverTime effect.
   *
   * ⚠️ THROUGH THE OVERTIME ENGINE, NOT A SECOND DAMAGE TICKER. That engine
   * already rolls at the right point in the turn, already posts a card with
   * apply and dismiss, already handles a save to end and already understands
   * fire. A private loop here would be a parallel implementation of the exact
   * thing the suite was told off for on 2026-08-11.
   *
   * ⚠️ DEX DC 10 TO BEAT IT OUT, which is alchemist's fire's own rule and the
   * closest thing 5e has to a general "you are on fire" precedent in either
   * edition. A creature that is DEAD gets no save, because a corpse cannot roll
   * around on the floor — and without that exception a burning body would put
   * itself out on its own turn.
   */
  static async _applyBurning(tokenDoc, record) {
    try {
      const actor = tokenDoc?.actor;
      if (!actor) return;
      if ((actor.effects ?? []).some(e => e.flags?.[FLAG_NS]?.fireBurning)) return;

      const dead = FireEngine._isDead(tokenDoc);
      const dice = record.damage ?? "1d6";
      const formula = record.damageBonus > 0 ? `${dice} + ${record.damageBonus}` : dice;

      await actor.createEmbeddedDocuments("ActiveEffect", [{
        name: "Burning",
        img: "icons/magic/fire/flame-burning-hand-orange.webp",
        origin: tokenDoc.uuid,
        duration: { seconds: Math.max(6, record.endsAt - FireEngine.now) },
        flags: {
          [FLAG_NS]: {
            fireBurning: true,
            OverTime: {
              turn: "start",
              damageRoll: formula,
              damageType: "fire",
              label: "Burning",
              // A corpse cannot beat out the flames.
              ...(dead ? {} : {
                saveDC: 10, saveAbility: "dex",
                saveRemove: true, allowRepeatSave: true,
              }),
            },
          },
        },
      }]);
    } catch (err) {
      // ⚠️ NAMED. "It is on fire but takes no damage" and "the effect threw"
      // must never look the same from the console.
      console.warn(`${LOG} | ${tokenDoc?.name} is alight but the Burning effect `
        + `could not be applied, so it will take no damage:`, err);
    }
  }

  /** Everyone standing in a burning area catches. */
  static async _burnOccupants(region) {
    try {
      const record = region?.flags?.[FLAG_NS]?.fire;
      if (!record) return;
      for (const tokenDoc of (region.parent?.tokens ?? [])) {
        const token = tokenDoc.object;
        if (!token) continue;
        if (!FireEngine._inRegion(region, token)) continue;
        if (tokenDoc.flags?.[FLAG_NS]?.fire) continue;   // already alight
        await FireEngine._applyBurning(tokenDoc, record);
      }
    } catch (err) {
      console.warn(`${LOG} | could not work out who is standing in the fire:`, err);
    }
  }

  /**
   * Is this token inside the region?
   *
   * ⚠️ ASK THE REGION, DO NOT MEASURE IT AGAIN. Foundry V13 computes region
   * membership itself and keeps it current through movement; a second geometry
   * test here would be the "two answers to one question" that made a creature
   * half inside a Moonbeam take damage on the cast and nothing walking back in.
   */
  static _inRegion(region, token) {
    try {
      if (region.object?.testPoint) {
        return region.object.testPoint(token.center, token.document.elevation ?? 0);
      }
      return !!region.tokens?.has?.(token.document);
    } catch (err) {
      console.warn(`${LOG} | could not test who is inside the fire, so nobody was `
        + `set alight by it:`, err);
      return false;
    }
  }

  /* ═══ Time passing ═══════════════════════════════════════════════════════ */

  /**
   * Burn everything down by however much time just passed.
   *
   * ⚠️ DRIVEN BY WORLD TIME, WHICH MEANS A LONG REST PUTS FIRES OUT. Eight hours
   * advance in one step, every fire's end time is in the past, and they all
   * finish in that step rather than surviving into the morning because nobody
   * was watching. That is the whole reason for anchoring to the clock instead of
   * counting rounds.
   */
  static async tick() {
    if (!FireEngine._isActiveGM()) return;
    if (!canvas?.scene) return;
    const now = FireEngine.now;

    // ── Burning creatures ──
    for (const tokenDoc of (canvas.scene.tokens ?? [])) {
      const record = tokenDoc.flags?.[FLAG_NS]?.fire;
      if (!record) continue;
      if (now < record.endsAt) continue;
      try { await FireEngine.burnOut(tokenDoc); }
      catch (err) { console.warn(`${LOG} | ${tokenDoc.name} could not finish burning:`, err); }
    }

    // ── Burning ground ──
    for (const region of (canvas.scene.regions ?? [])) {
      const record = region.flags?.[FLAG_NS]?.fire;
      if (!record) continue;
      try {
        if (now >= record.endsAt) { await FireEngine.extinguishRegion(region); continue; }
        await FireEngine._spread(region);
        await FireEngine._burnOccupants(region);
      } catch (err) {
        console.warn(`${LOG} | a burning area could not be advanced:`, err);
      }
    }
  }

  /** Grow a fire outward while it still has somewhere to go. */
  static async _spread(region) {
    const record = region.flags?.[FLAG_NS]?.fire;
    if (!record?.spreadFtPerMin || !record.maxSpreadFt) return;

    const minutesBurning = (FireEngine.now - record.startedAt) / 60;
    const wanted = Math.min(record.maxSpreadFt,
      Math.round(minutesBurning * record.spreadFtPerMin / 5) * 5);
    if (!(wanted > record.spreadSoFarFt)) return;

    await region.update({
      shapes: [FireEngine._grownShape(record.baseShape, wanted)],
      [`flags.${FLAG_NS}.fire.spreadSoFarFt`]: wanted,
    });
    FireEngine._drawAreaFlames(region);
    console.log(`${LOG} | the fire has spread to ${wanted} feet beyond where it started.`);
  }

  /* ═══ Going out ══════════════════════════════════════════════════════════ */

  /**
   * A body finishes burning.
   *
   * ⚠️ ASH ONLY IF IT WAS ALREADY DEAD. Turning a living creature into a pile of
   * ash because a fire ran its course would kill a player character outright
   * with no death saves and no decision, which is not a thing a quality-of-life
   * module gets to do. A living creature that survives simply stops burning.
   */
  static async burnOut(tokenDoc) {
    const doc = tokenDoc?.document ?? tokenDoc;
    const wasDead = FireEngine._isDead(doc);
    await FireEngine.extinguishToken(doc, { quiet: true });

    if (!wasDead) {
      ui.notifications?.info(`${doc.name} stops burning.`);
      return;
    }
    await FireEngine._toAsh(doc);
  }

  /**
   * Replace a burned corpse with a smoking pile of ash.
   *
   * Johnny: "I just want ash, a pitcher of ash left... I don't want it to look
   * exactly like the body did, but ash. Smoking would be better, like actively
   * animated smoking."
   *
   * ⚠️ THE LOOT GOES WITH IT, AND THAT IS THE POINT OF BURNING A BODY. A pile of
   * ash that still hands out a greatsword would make the whole feature a lie.
   * ⚠️ AND IT SHRINKS TO ONE SQUARE. A Huge dragon leaves a pile a man can step
   * over, not a dragon-shaped smear of rubble.
   */
  static async _toAsh(doc) {
    try {
      const art = await FireEngine._ashArt();   // null = keep his own picture
      const centreX = doc.x + (doc.width * (canvas?.grid?.size ?? 100)) / 2;
      const centreY = doc.y + (doc.height * (canvas?.grid?.size ?? 100)) / 2;
      const gs = canvas?.grid?.size ?? 100;

      // ⚠️🔴 TAKE THE "BEFORE" OR THERE IS NOTHING TO UNDO. Turning a body
      // to ash renames it, shrinks it to one square, moves it, drops its
      // rotation and CLEARS THE LOOT SNAPSHOT. None of that can be worked out
      // afterwards. Johnny asked for an undo button and the only way to have
      // one is to save this here, before any of it is thrown away.
      const before = {
        name: doc.name,
        textureSrc: doc.texture?.src ?? null,
        width: doc.width, height: doc.height,
        x: doc.x, y: doc.y, rotation: doc.rotation ?? 0,
        flags: foundry.utils.deepClone(doc.flags?.[FLAG_NS] ?? {}),
      };

      await doc.update({
        [`flags.${FLAG_NS}.preAsh`]: before,
        name: `Ashes of ${doc.flags?.[FLAG_NS]?.originalName ?? doc.name}`,
        ...(art ? { "texture.src": art } : {}),
        width: 1, height: 1,
        x: Math.round(centreX - gs / 2),
        y: Math.round(centreY - gs / 2),
        rotation: 0,
        [`flags.${FLAG_NS}.isAsh`]: true,
        // ⚠️🔴 CLEARING THE SNAPSHOT ALONE WOULD HAND THE LOOT STRAIGHT BACK.
        // Caught auditing this the hour it was written. The loot reader takes
        // the snapshot when there is one and FALLS BACK TO THE LIVE ACTOR when
        // there is not — so removing only the snapshot would have left an ash
        // pile still flagged as a dead token, reading a sheet that still owns
        // everything, and offering the dragon's whole hoard out of a pile of
        // cinders. The corpse flags go too, and the reader has its own guard.
        [`flags.${FLAG_NS}.-=lootSnapshot`]: null,
        [`flags.${FLAG_NS}.-=lootClaimed`]: null,
        [`flags.${FLAG_NS}.-=isDeadLootable`]: null,
        [`flags.${FLAG_NS}.-=isDeadToken`]: null,
        [`flags.${FLAG_NS}.-=originalActorId`]: null,
      });

      FireEngine._drawSmoke(doc);
      ui.notifications?.info(`${doc.name} has burned to ash.`);
      console.log(`${LOG} | ${doc.name} burned away. Its loot went with it.`);
    } catch (err) {
      console.error(`${LOG} | the body finished burning but could not be turned to ash:`, err);
    }
  }

  static async extinguishToken(tokenDoc, { quiet = false } = {}) {
    const doc = tokenDoc?.document ?? tokenDoc;
    try {
      await doc.update({ [`flags.${FLAG_NS}.-=fire`]: null });
      const burning = (doc.actor?.effects ?? []).filter(e => e.flags?.[FLAG_NS]?.fireBurning);
      for (const e of burning) { try { await e.delete(); } catch (_) { /* already gone */ } }
      FireEngine._endFx(`${FX_PREFIX}tok:${doc.id}`);
      if (!quiet) ui.notifications?.info(`${doc.name} is no longer on fire.`);
    } catch (err) {
      console.warn(`${LOG} | could not put ${doc?.name} out:`, err);
    }
  }

  static async extinguishRegion(region) {
    try {
      FireEngine._endFx(`${FX_PREFIX}area:${region.id}:*`);
      console.log(`${LOG} | a burning area has gone out.`);
      await region.delete();
    } catch (err) {
      console.warn(`${LOG} | could not put a burning area out:`, err);
    }
  }

  /** Every fire on this scene, out, now. */
  /**
   * Put out what he has selected — or everything, if he has selected nothing.
   *
   * ⚠️🔴 UNTIL NOW THE ONLY WAY A FIRE ENDED WAS ITS OWN TIMER. Johnny
   * found that out the hard way: "pushing the fire button again does not
   * extinguish it. Just the timer does. I need a button that extinguishes it."
   * A thirty-minute timber fire lit by accident had to be waited out.
   *
   * ⚠️ SELECTION IS THE SCOPE, and it says which it did. Putting out the
   * whole map when he meant one corpse is not something he can undo.
   */
  static async douse() {
    if (!FireEngine._isActiveGM()) {
      ui.notifications?.warn("Only the acting GM can put fires out.");
      return;
    }
    const picked = canvas?.tokens?.controlled ?? [];
    if (!picked.length) return FireEngine.extinguishAll();

    let n = 0;
    const names = [];
    for (const t of picked) {
      const doc = t.document ?? t;
      if (!doc?.flags?.[FLAG_NS]?.fire) continue;
      await FireEngine.extinguishToken(doc, { quiet: true });
      names.push(doc.name);
      n++;
    }
    ui.notifications?.info(n
      ? `Put out: ${names.join(", ")}.`
      : `Nothing you have selected is on fire. Select nothing and press it again `
        + `to put out every fire on the scene.`);
  }

  static async extinguishAll() {
    if (!FireEngine._isActiveGM()) {
      ui.notifications?.warn("Only the acting GM can put fires out.");
      return;
    }
    let n = 0;
    for (const tokenDoc of (canvas?.scene?.tokens ?? [])) {
      if (!tokenDoc.flags?.[FLAG_NS]?.fire) continue;
      await FireEngine.extinguishToken(tokenDoc, { quiet: true });
      n++;
    }
    for (const region of [...(canvas?.scene?.regions ?? [])]) {
      if (!region.flags?.[FLAG_NS]?.fire) continue;
      await FireEngine.extinguishRegion(region);
      n++;
    }
    ui.notifications?.info(n ? `${n} fire(s) put out.` : "Nothing was burning.");
  }

  /**
   * Put back what the fire took — the picture, the name, the size, the loot.
   *
   * ⚠️🔴 REVIVING THE TOKEN IS NOT AN UNDO. That is what he had to do
   * instead: "I brought it back to life, which brought back the icon." It
   * restores the art because the death pipeline owns that, but the ash step
   * had already renamed the token, shrunk it to one square, moved it and
   * DELETED ITS LOOT SNAPSHOT — a dragon's hoard, gone, with no way back.
   *
   * ⚠️ RESTORES ONLY WHAT IT SAVED, AND SAYS SO WHEN IT CANNOT. Ash made
   * before this shipped has no snapshot, and inventing plausible values for a
   * token's size and position is how you quietly move somebody's dragon.
   */
  static async undo() {
    if (!FireEngine._isActiveGM()) {
      ui.notifications?.warn("Only the acting GM can undo a fire.");
      return;
    }
    const picked = (canvas?.tokens?.controlled ?? []).map(t => t.document ?? t);
    const pool = picked.length ? picked : [...(canvas?.scene?.tokens ?? [])];

    const restored = [], noSnapshot = [];
    for (const doc of pool) {
      const f = doc.flags?.[FLAG_NS] ?? {};
      if (!f.isAsh && !f.fire) continue;
      const before = f.preAsh;
      if (!before) { noSnapshot.push(doc.name); continue; }

      FireEngine._endFx(`${FX_PREFIX}ash:${doc.id}`);
      FireEngine._endFx(`${FX_PREFIX}tok:${doc.id}`);
      try {
        await doc.update({
          name: before.name,
          ...(before.textureSrc ? { "texture.src": before.textureSrc } : {}),
          width: before.width, height: before.height,
          x: before.x, y: before.y, rotation: before.rotation ?? 0,
          [`flags.${FLAG_NS}`]: before.flags ?? {},
          [`flags.${FLAG_NS}.-=isAsh`]: null,
          [`flags.${FLAG_NS}.-=preAsh`]: null,
          [`flags.${FLAG_NS}.-=fire`]: null,
        });
        const burning = (doc.actor?.effects ?? []).filter(e => e.flags?.[FLAG_NS]?.fireBurning);
        for (const e of burning) { try { await e.delete(); } catch (_) { /* already gone */ } }
        restored.push(before.name);
      } catch (err) {
        console.error(`${LOG} | could not undo the fire on ${doc.name}:`, err);
      }
    }

    if (restored.length) ui.notifications?.info(`Put back: ${restored.join(", ")}.`);
    if (noSnapshot.length) {
      // ⚠️ NAMED, NOT SWALLOWED. He needs to know WHICH ones cannot come back.
      console.warn(`${LOG} | no "before" was saved for: ${noSnapshot.join(", ")} — they `
        + `burned before undo existed, so nothing was changed.`);
      ui.notifications?.warn(`${noSnapshot.length} of these burned before undo existed, so `
        + `ACE has no record of what they were. Left untouched — see the console.`);
    }
    if (!restored.length && !noSnapshot.length) {
      ui.notifications?.info(picked.length
        ? "Nothing you have selected has been burned."
        : "Nothing on this scene has been burned.");
    }
  }

  /* ═══ The look ═══════════════════════════════════════════════════════════ */

  static _endFx(name) {
    try { globalThis.Sequencer?.EffectManager?.endEffects?.({ name }); }
    catch (err) { console.warn(`${LOG} | could not end "${name}":`, err); }
  }

  /**
   * ⚠️ DIFFED, NEVER REDRAWN, AND NEVER STARTED TWICE. The aura layer stacked
   * seventeen copies of one ring on a token by asking Sequencer what was running
   * and starting anything missing, while `play()` had not registered yet
   * (2026-09-02). Same trap here, same guard: check before starting.
   */
  static _alreadyPlaying(name) {
    try {
      const live = globalThis.Sequencer?.EffectManager?.getEffects?.({ name }) ?? [];
      return live.length > 0;
    } catch (_) { return false; }
  }

  static _drawTokenFlame(doc) {
    if (!FireEngine._isActiveGM()) return;
    try {
      if (typeof Sequence === "undefined" || !globalThis.Sequencer?.EffectManager) return;
      const name = `${FX_PREFIX}tok:${doc.id}`;
      if (FireEngine._alreadyPlaying(name)) return;
      const path = FireEngine._flamePath(Math.max(doc.width, doc.height) >= 2);
      if (!path) return;
      const token = doc.object;
      if (!token) return;
      new Sequence().effect()
        .file(path).attachTo(token, { bindAlpha: false })
        .persist().name(name)
        .scaleToObject(1.1).opacity(0.9).fadeIn(400).fadeOut(600)
        .play().catch(err => console.warn(`${LOG} | flame failed to play:`, err));
    } catch (err) {
      console.warn(`${LOG} | could not draw the flames on ${doc?.name}:`, err);
    }
  }

  /**
   * Flames across a burning area.
   *
   * ⚠️ ONE PER SQUARE, CAPPED. A 60 foot grass fire is 144 squares, and a
   * persistent Sequencer effect in each would put the scene on its knees. The
   * cap is a visual budget, and it says out loud when it stops rather than
   * quietly drawing part of a fire.
   */
  static _drawAreaFlames(region) {
    if (!FireEngine._isActiveGM()) return;
    try {
      if (typeof Sequence === "undefined" || !globalThis.Sequencer?.EffectManager) return;
      const path = FireEngine._flamePath(false);
      if (!path) return;

      const gs = canvas?.grid?.size ?? 100;
      const bounds = region.object?.bounds;
      if (!bounds) return;

      const MAX = 60;
      let placed = 0, skipped = 0;
      for (let x = bounds.x; x < bounds.x + bounds.width; x += gs) {
        for (let y = bounds.y; y < bounds.y + bounds.height; y += gs) {
          const centre = { x: x + gs / 2, y: y + gs / 2 };
          if (region.object?.testPoint && !region.object.testPoint(centre, 0)) continue;
          if (placed >= MAX) { skipped++; continue; }
          const name = `${FX_PREFIX}area:${region.id}:${Math.round(centre.x)}:${Math.round(centre.y)}`;
          if (FireEngine._alreadyPlaying(name)) { placed++; continue; }
          new Sequence().effect()
            .file(path).atLocation(centre)
            .persist().name(name)
            .size({ width: gs * 1.2, height: gs * 1.2 })
            .opacity(0.85).fadeIn(400).fadeOut(600)
            .play().catch(() => {});
          placed++;
        }
      }
      if (skipped) {
        console.warn(`${LOG} | this fire covers more than ${MAX} squares, so ${skipped} `
          + `of them are burning without a flame drawn on them. The rules do not care; `
          + `the picture is the only thing short.`);
      }
    } catch (err) {
      console.warn(`${LOG} | could not draw the flames on this area:`, err);
    }
  }

  /** Smoke that keeps rising off a pile of ash. */
  static _drawSmoke(doc) {
    if (!FireEngine._isActiveGM()) return;
    try {
      if (typeof Sequence === "undefined" || !globalThis.Sequencer?.EffectManager) return;
      const name = `${FX_PREFIX}ash:${doc.id}`;
      if (FireEngine._alreadyPlaying(name)) return;
      const path = FireEngine._smokePath();
      if (!path) return;
      const token = doc.object;
      if (!token) return;
      new Sequence().effect()
        .file(path).attachTo(token, { bindAlpha: false })
        .persist().name(name)
        .scaleToObject(1.4).opacity(0.55).fadeIn(1200)
        .play().catch(err => console.warn(`${LOG} | smoke failed to play:`, err));
    } catch (err) {
      console.warn(`${LOG} | could not draw the smoke on the ashes:`, err);
    }
  }

  /* ═══ Bits and pieces ════════════════════════════════════════════════════ */

  /**
   * ⚠️ THE FLAG AND THE HIT POINTS, NEVER THE `dead` STATUS. The death pipeline
   * removes that status on purpose so the skull does not stack on the corpse
   * art, so it is the one signal guaranteed absent on an actual corpse.
   */
  static _isDead(tokenDoc) {
    try {
      const doc = tokenDoc?.document ?? tokenDoc;
      if (doc?.flags?.[FLAG_NS]?.isDead) return true;
      const hp = Number(doc?.actor?.system?.attributes?.hp?.value);
      if (!Number.isFinite(hp)) return false;
      return hp <= 0;
    } catch (_) { return false; }
  }

  static _describeRemaining(record) {
    const secs = Math.max(0, record.endsAt - FireEngine.now);
    const mins = Math.round(secs / 60);
    if (mins >= 60) {
      const h = Math.floor(mins / 60), m = mins % 60;
      return `it will burn for about ${h} hour${h === 1 ? "" : "s"}${m ? ` ${m} minutes` : ""}`;
    }
    if (mins >= 1) return `it will burn for about ${mins} minute${mins === 1 ? "" : "s"}`;
    return `it will burn out within the minute`;
  }

  /** What is burning right now, and for how much longer. */
  static report() {
    const lines = [];
    for (const tokenDoc of (canvas?.scene?.tokens ?? [])) {
      const f = tokenDoc.flags?.[FLAG_NS]?.fire;
      if (f) lines.push(`   ${tokenDoc.name}: ${FireEngine._describeRemaining(f)}`);
    }
    for (const region of (canvas?.scene?.regions ?? [])) {
      const f = region.flags?.[FLAG_NS]?.fire;
      if (f) {
        lines.push(`   ${region.name}: ${FireEngine._describeRemaining(f)}`
          + (f.maxSpreadFt ? `, spread ${f.spreadSoFarFt} of ${f.maxSpreadFt} ft` : ""));
      }
    }
    // ⚠️ "NOTHING IS BURNING" IS AN ANSWER, AND IT HAS TO BE SAID OUT LOUD. A
    // report that prints nothing is indistinguishable from a report that failed.
    console.log(lines.length
      ? `${LOG} | burning on this scene:\n${lines.join("\n")}`
      : `${LOG} | nothing is burning on this scene.`);
    return lines;
  }

  /* ═══ Wiring ═════════════════════════════════════════════════════════════ */

  /**
   * ⚠️ `Hooks.once("ready")` FROM INSIDE `ready` NEVER FIRES. Every ACE
   * subsystem starts from the entry file's own ready handler, so waiting on
   * `ready` here would wait on an event already in progress (2026-08-12).
   */
  static register() {
    // Time moving is the only thing that puts a fire out.
    Hooks.on("updateWorldTime", () => {
      FireEngine.tick().catch(err => console.warn(`${LOG} | tick failed:`, err));
    });

    // ⚠️ COMBAT ROUNDS ADVANCE THE CLOCK, BUT NOT ALWAYS BY THIS ROUTE. The
    // clock bills six seconds a round itself; this is here so a fire still
    // burns down on a table that has the clock's combat billing switched off.
    Hooks.on("updateCombat", (_combat, changes) => {
      if (changes?.round === undefined && changes?.turn === undefined) return;
      FireEngine.tick().catch(err => console.warn(`${LOG} | combat tick failed:`, err));
    });

    // A creature walking into a burning area catches.
    Hooks.on("updateToken", (tokenDoc, changes) => {
      try {
        if (changes?.x === undefined && changes?.y === undefined
            && changes?.elevation === undefined) return;
        if (!FireEngine._isActiveGM()) return;
        for (const region of (tokenDoc.parent?.regions ?? [])) {
          if (!region.flags?.[FLAG_NS]?.fire) continue;
          FireEngine._burnOccupants(region)
            .catch(err => console.warn(`${LOG} | could not catch the walker alight:`, err));
        }
      } catch (err) {
        console.warn(`${LOG} | the movement watcher threw:`, err);
      }
    });

    // ⚠️🔴 A DELETED THING LEAVES ITS FIRE BURNING ON AN EMPTY SQUARE.
    // A persistent Sequencer effect is stored on the SCENE, not on the token it
    // was attached to, so deleting a burning corpse or dragging a fire region to
    // the bin leaves flames turning over nothing — and they survive a reload,
    // because that is what persistent means. Found auditing this, not in play.
    Hooks.on("deleteToken", (tokenDoc) => {
      try {
        FireEngine._endFx(`${FX_PREFIX}tok:${tokenDoc.id}`);
        FireEngine._endFx(`${FX_PREFIX}ash:${tokenDoc.id}`);
      } catch (err) {
        console.warn(`${LOG} | could not clear the flames off a deleted token:`, err);
      }
    });
    Hooks.on("deleteRegion", (region) => {
      try { FireEngine._endFx(`${FX_PREFIX}area:${region.id}:*`); }
      catch (err) { console.warn(`${LOG} | could not clear the flames off a deleted area:`, err); }
    });

    // Flames and smoke are drawn per client and are lost on a scene change.
    onCanvasReady( () => {
      try { FireEngine.redrawAll(); }
      catch (err) { console.warn(`${LOG} | could not redraw the fires on this scene:`, err); }
    });

    // ── The button ──
    //
    // ⚠️ A BUTTON, NOT ONLY A CONSOLE COMMAND. He asked for "a button, a macro,
    // or something", and a feature reachable only by typing is a feature he will
    // not use mid-session. Both array and object tool shapes are handled because
    // Foundry changed that structure between versions and picking one would make
    // the button silently absent on the other.
    Hooks.on("getSceneControlButtons", (controls) => {
      try {
        if (!game.user?.isGM) return;
        const grp = Array.isArray(controls)
          ? controls.find(c => c?.name === "token" || c?.name === "tokens")
          : (controls?.tokens ?? controls?.token);
        if (!grp) return;
        // ⚠️ TWO BUTTONS, AND THEY LOOK LIKE WHAT THEY DO. Johnny: "I want
        // the fire button icon to be red-coloured, and the extinguish button to
        // be blue. It should be the exact same icon with a slash through it."
        // Foundry's toolbar does not colour tool icons, so the colour is set on
        // the rendered element by the pass below rather than left to chance.
        // ⚠️🔴 AN `order` IS NOT OPTIONAL IN V13. The other ACE tools all
        // carry one and appear; these three did not, and Johnny could not find
        // the douse or undo buttons at all. High numbers so they sort after
        // every other module's tools, the same trick quick-select-tools uses.
        const tool = {
          name: "ace-set-fire",
          order: 99010,
          title: "ACE — Set fire",
          icon: "fas fa-fire ace-fire-tool",
          button: true,
          visible: true,
          // ⚠️🔴 ONE HANDLER, NOT TWO. Foundry V13 fires BOTH `onClick` and
          // `onChange` for a scene-control button, so having both opened the
          // dialog twice, stacked, on every single press. Johnny: "I get two
          // pop-ups that are exactly the same."
          onChange: () => FireEngine.prompt(),
        };
        // ⚠️🔴 PUSHING "SET FIRE" AGAIN DOES NOT PUT IT OUT, and he found
        // that out by trying. Only the timer ended a fire, so a fire lit by
        // mistake had to be waited out. This is its own button.
        const douse = {
          name: "ace-douse-fire",
          order: 99011,
          title: "ACE — Put it out",
          icon: "fas fa-fire-flame-simple ace-douse-tool",
          button: true,
          visible: true,
          onChange: () => FireEngine.douse(),
        };

        // ⚠️ AND A WAY BACK. Reviving the token restores its art and nothing
        // else — the name, the size, the position and the LOOT are already
        // gone by then.
        const undoTool = {
          name: "ace-undo-fire",
          order: 99012,
          title: "ACE — Undo the fire",
          icon: "fas fa-rotate-left ace-undo-fire-tool",
          button: true,
          visible: true,
          onChange: () => FireEngine.undo(),
        };

        for (const t of [tool, douse, undoTool]) {
          if (Array.isArray(grp.tools)) {
            if (!grp.tools.some(x => x?.name === t.name)) grp.tools.push(t);
          } else if (grp.tools && typeof grp.tools === "object") {
            grp.tools[t.name] = t;
          }
        }
      } catch (err) {
        console.warn(`${LOG} | the fire button could not be added to the toolbar, so `
          + `game.aceQol.setFire() is the only way in:`, err);
      }
    });

    const expose = () => {
      game.aceQol = game.aceQol ?? {};
      Object.assign(game.aceQol, {
        fire: FireEngine,
        setFire: (opts) => FireEngine.prompt(opts),
        fireReport: () => FireEngine.report(),
        extinguishAll: () => FireEngine.extinguishAll(),
        douse: () => FireEngine.douse(),
        undoFire: () => FireEngine.undo(),
      });
    };
    if (game.ready) expose(); else Hooks.once("ready", expose);

    console.log(`${LOG} | online. game.aceQol.setFire() to light something.`);
  }

  /* ═══ The button ═════════════════════════════════════════════════════════ */

  /**
   * Ask what is burning and what lit it, then do it.
   *
   * ⚠️ A DARK ACE WRAPPER. Foundry's dialog is light parchment and ACE's own
   * colours vanish on it — a standing rule in this suite that every dialog which
   * ignored it had to be redone for. Body 16px, headings 18px.
   *
   * ⚠️ THE ANSWER TO "WHERE" IS WHAT IS SELECTED. Tokens selected means burn
   * those; nothing selected means the next area he draws. Asking him to choose
   * between them in the dialog would be a menu, and a menu is a question he has
   * already answered with his mouse.
   */
  static async prompt() {
    if (!FireEngine._isActiveGM()) {
      ui.notifications?.warn("Only the acting GM can start a fire.");
      return;
    }
    try {
      const targets = canvas?.tokens?.controlled ?? [];
      const burningBodies = targets.length > 0;
      const esc = foundry.utils.escapeHTML;

      const who = burningBodies
        ? targets.map(t => esc(t.name)).join(", ")
        : "an area you are about to draw";

      const fuelRows = Object.entries(FUELS)
        // A body is not something you pick for a patch of ground, and ground
        // fuel is not something you pick for a corpse.
        .filter(([id]) => burningBodies ? id === "body" : id !== "body")
        .map(([id, f], i) => `
          <label style="display:flex;gap:10px;align-items:flex-start;padding:8px 10px;
                        border-radius:5px;cursor:pointer;">
            <input type="radio" name="ace-fuel" value="${id}" ${i === 0 ? "checked" : ""}
                   style="margin-top:4px;">
            <span>
              <span style="font-size:16px;font-weight:700;color:#f0d98a;">${esc(f.label)}</span>
              <span style="font-size:14px;color:#c0b288;display:block;line-height:1.4;">
                ${esc(f.hint)}${id === "body" ? "" : ` About ${f.minutes} minute${f.minutes === 1 ? "" : "s"}.`}
              </span>
            </span>
          </label>`).join("");

      const litRows = Object.entries(IGNITION).map(([id, s], i) => `
          <label style="display:flex;gap:10px;align-items:center;padding:7px 10px;
                        border-radius:5px;cursor:pointer;">
            <input type="radio" name="ace-lit" value="${id}" ${i === 0 ? "checked" : ""}>
            <span style="font-size:16px;color:#f0e4c0;">${esc(s.label)}</span>
          </label>`).join("");

      const content = `
        <div style="background:linear-gradient(180deg,#15110d 0%,#0c0a08 100%);
                    border:2px solid #d4af37;border-radius:8px;padding:16px 18px;
                    color:#f0e4c0;font-family:'Signika','Helvetica Neue',sans-serif;">
          <div style="font-size:18px;font-weight:700;color:#ff6b3d;letter-spacing:.5px;
                      margin-bottom:4px;">
            <i class="fas fa-fire" style="margin-right:8px;"></i>Set fire to ${who}
          </div>
          <div style="font-size:14px;color:#c0b288;font-style:italic;margin-bottom:12px;
                      line-height:1.45;">
            ${burningBodies
              ? "How long a body burns depends on how big it is. Anything still alive can beat the flames out; a corpse cannot, and burns to ash."
              : "Draw the area after you press Light it. What you pick here decides how long it burns and how far it runs."}
          </div>

          <div style="font-size:16px;font-weight:700;color:#d4af37;margin:6px 0 2px 0;">
            What is burning
          </div>
          <div style="border:1px solid #4a3a28;border-radius:6px;padding:4px;">${fuelRows}</div>

          <div style="font-size:16px;font-weight:700;color:#d4af37;margin:14px 0 2px 0;">
            What lit it
          </div>
          <div style="border:1px solid #4a3a28;border-radius:6px;padding:4px;">${litRows}</div>

          <div style="font-size:14px;color:#c0b288;font-style:italic;margin-top:12px;
                      line-height:1.45;">
            What lit it makes the first minutes fiercer and pushes the edge out further.
            It does not make anything burn for longer.
          </div>
        </div>`;

      let picked = null;
      const ok = await foundry.applications.api.DialogV2.wait({
        window: { title: "ACE — Set fire" },
        position: { width: 560 },
        content,
        modal: true,
        buttons: [
          { action: "light", label: "Light it", icon: "fa-solid fa-fire", default: true,
            callback: (_ev, _btn, dialog) => {
              const root = dialog.element;
              picked = {
                fuel: root.querySelector('input[name="ace-fuel"]:checked')?.value ?? "debris",
                ignition: root.querySelector('input[name="ace-lit"]:checked')?.value ?? "torch",
              };
              return true;
            } },
          { action: "cancel", label: "Cancel" },
        ],
        rejectClose: false,
      }).catch(() => null);

      if (!ok || ok === "cancel" || !picked) return;

      if (burningBodies) {
        for (const token of targets) await FireEngine.igniteToken(token.document, picked);
        return;
      }
      FireEngine._armNextTemplate(picked);
    } catch (err) {
      console.error(`${LOG} | the fire prompt failed:`, err);
      ui.notifications?.error("ACE: the fire dialog would not open, see the console.");
    }
  }

  /**
   * The next measured template placed becomes a fire.
   *
   * ⚠️ ONE SHOT, AND IT TIMES OUT. An armed listener that never disarms turns
   * every template he draws for the rest of the session into a fire, including
   * a Fireball he is only measuring. Sixty seconds is long enough to place a
   * shape and short enough that a forgotten arm cannot ambush him.
   */
  static _armNextTemplate(opts) {
    if (FireEngine._armed) {
      Hooks.off("createMeasuredTemplate", FireEngine._armed);
      clearTimeout(FireEngine._armedTimer);
    }
    const handler = (templateDoc) => {
      Hooks.off("createMeasuredTemplate", handler);
      clearTimeout(FireEngine._armedTimer);
      FireEngine._armed = null;
      FireEngine.igniteTemplate(templateDoc, opts)
        .catch(err => console.error(`${LOG} | could not light the drawn area:`, err));
    };
    FireEngine._armed = handler;
    Hooks.on("createMeasuredTemplate", handler);
    FireEngine._armedTimer = setTimeout(() => {
      if (FireEngine._armed !== handler) return;
      Hooks.off("createMeasuredTemplate", handler);
      FireEngine._armed = null;
      // ⚠️ SAY THAT IT LAPSED. Silence here reads as "the fire feature is
      // broken" the next time he draws a shape and nothing burns.
      ui.notifications?.info("ACE: nothing was drawn, so no fire was started.");
    }, 60000);

    ui.notifications?.info("Draw the area now with any template tool. It will catch fire.");
  }

  /**
   * ⚠️ EVERY CLIENT DRAWS, ONLY THE GM STARTS. A player joining mid-session, or
   * anyone changing scene, has no Sequencer effects for fires that were lit
   * before they arrived — the same "cards drawn before the handler registered"
   * shape that leaked GM controls to a player on 2026-08-07.
   */
  static redrawAll() {
    for (const tokenDoc of (canvas?.scene?.tokens ?? [])) {
      if (tokenDoc.flags?.[FLAG_NS]?.fire) FireEngine._drawTokenFlame(tokenDoc);
      else if (tokenDoc.flags?.[FLAG_NS]?.isAsh) FireEngine._drawSmoke(tokenDoc);
    }
    for (const region of (canvas?.scene?.regions ?? [])) {
      if (region.flags?.[FLAG_NS]?.fire) FireEngine._drawAreaFlames(region);
    }
  }
}
