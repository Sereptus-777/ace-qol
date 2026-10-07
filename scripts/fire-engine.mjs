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
// (the template-shape reader left with the template path, 2026-10-06)
import { aceToolOrder } from "./token-tools-order.mjs";

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

/**
 * How big, asked once, because a preview cannot exist without a size.
 *
 * His ask, 2026-10-05: "as soon as I push OK, if I'm drawing the template, then
 * take me right to the template thing... just like you would if you cast a spell."
 * A spell's area comes off the spell. A fire has no sheet to read, so this is the
 * one number that has to be picked before the shape can go on his cursor, and it
 * is the only thing added to that dialog.
 *
 * ⚠️ ACROSS, NOT RADIUS. A table says "a twenty foot fire" meaning twenty feet
 * across, and that is also how many squares the brush paints at once: five feet
 * is one square, sixty feet is twelve by twelve.
 *
 * ⚠️ FIVE IS AT THE BOTTOM OF THE LIST, where he put it (2026-10-06: "The size
 * list is 5, 10, 20, 30, and 60 feet, with 5 at the bottom"). It is the precise
 * tool - one square, for a corner of a rug or the square a door stands in - and
 * it sits at the end rather than leading the row of sizes.
 */
export const AREA_SIZES = [10, 20, 30, 60, 5];

/**
 * How long a burning creature waits before it tries to beat the flames out, on
 * the wall clock, per creature.
 *
 * ⚠️ SIX SECONDS, AND IT IS EACH CREATURE'S OWN (his rule, 2026-10-06: "The wait
 * is 6 seconds of real time, not 10. The first check is 6 seconds after that
 * creature catches. The next is 6 seconds after it rolls."). It is not the ten
 * minutes a tile or a door takes to catch and burn through, which is a different
 * number for a different job and is in fire-paint.mjs.
 */
const BEAT_IT_OUT_MS = 6000;

/** Where each fuel's size starts before he changes it. */
const DEFAULT_ACROSS = { stone: 5, debris: 10, grass: 20, timber: 10, oil: 10, body: 5 };

/**
 * Where the ash art comes from.
 *
 * ⚠️🔴 THE ONE FILE HE SUPPLIED (his rule, 2026-10-06: "Stop looking for
 * soot.webp, soot.png, or anything under Assets/Fire."). This listed two files
 * under `Assets/Fire` that nobody ever made, so a burned-out body printed a line
 * telling him to drop a picture somewhere - while the picture was already sitting
 * in `Assets`, named `ash-debris`. Same stain, same file, one path in the suite.
 */
const ASH_ART = [
  `modules/${MODULE_ID}/Assets/ash-debris.png`,
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
const ASH_ART_HINT = `modules/${MODULE_ID}/Assets/ash-debris.png`;

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
  static _fileChecks = new Map();

  /**
   * Is that file actually on the server?
   *
   * ⚠️🔴 A PATH IS NOT PROOF OF A FILE (his find, 2026-10-05). `_resolveFx`
   * returned the first candidate with a slash in it, unchecked, so the database
   * key behind it was never reached: on an install with the free JB2A, or any
   * version that renamed those files, the fire asked for a webm that is not there
   * and burned with nothing drawn and nothing said. The answer is cached, because
   * the same four paths are asked for on every square of every fire.
   */
  static async _fileThere(path) {
    if (FireEngine._fileChecks.has(path)) return FireEngine._fileChecks.get(path);
    const check = (async () => {
      const dir = path.slice(0, path.lastIndexOf("/"));
      const want = decodeURIComponent(path.slice(path.lastIndexOf("/") + 1)).toLowerCase();
      const FP = foundry.applications?.apps?.FilePicker?.implementation ?? globalThis.FilePicker;
      try {
        const listed = await FP.browse("data", dir);
        const files = (listed?.files ?? []).map(f =>
          decodeURIComponent(String(f).split("/").pop()).toLowerCase());
        if (files.length) return files.includes(want);
      } catch (_) { /* a folder that will not list is not an answer either */ }
      // Last resort: ask the server for the file itself.
      try {
        const r = await fetch(path, { method: "HEAD" });
        return r.ok;
      } catch (_) { return false; }
    })();
    FireEngine._fileChecks.set(path, check);
    return check;
  }

  /**
   * The first candidate that really exists: a file that is on disk, or a database
   * entry this JB2A install has.
   */
  static async _resolveFx(candidates) {
    for (const c of candidates) {
      if (typeof c !== "string") continue;
      if (c.includes("/")) {
        // ⚠️ CHECKED NOW. A renamed or missing file falls through to the next
        // candidate instead of being handed to Sequencer as if it were there.
        if (await FireEngine._fileThere(c)) return c;
        console.log(`${LOG} | "${c}" is not in this install, so the next picture is tried.`);
        continue;
      }
      try { if (globalThis.Sequencer?.Database?.entryExists?.(c)) return c; } catch (_) { /* next */ }
    }
    console.warn(`${LOG} | NO PICTURE: none of these are in this JB2A install, so the fire will `
      + `burn with nothing drawn on it: ${candidates.join(", ")}`);
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
  static async _flamePath(big = false) {
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
  static async _smokePath() {
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
      // ⚠️ ITS OWN TEN SECONDS START HERE, not on the engine's shared window.
      FireEngine._armRealCheck(doc);
      await FireEngine._applyBurning(doc, record);
      FireEngine._drawTokenFlame(doc)
        .catch(err => console.warn(`${LOG} | could not draw the flames on ${doc?.name}:`, err));

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

  /* ⚠️🔴 THE TEMPLATE PATH IS DELETED, NOT LEFT UNUSED (his build,
     2026-10-06). `igniteTemplate`, `_armNextTemplate` and `_previewArea` turned a
     measured template into one circular fire. He replaced that with the square
     brush: "Clicking a tile does not light the whole tile... The cursor is one
     5-foot square." A circle cannot light a corner of a rug and cannot light the
     square a door stands in, which is the whole job.

     They go rather than sit here unreachable, because "if the new template is
     unused, delete it or wire it, do not leave both" is his own rule, and a dead
     second way to start a fire is exactly how this engine ended up with two
     opinions about what a fire is. `FirePaint.start` is the only way in now. */

  /* ═══ Painted squares ═══════════════════════════════════════════════════ */

  /**
   * Light these squares.
   *
   * ⚠️🔴 ONE FIRE IS A SET OF SQUARES AND ONE FLAME (his rule, 2026-10-06: "One
   * flame for the whole lit footprint, never one flame per square. When it grows,
   * that same flame is resized. It does not gain neighbours.").
   *
   * So painting into a fire that is already burning does not make a second fire;
   * it adds squares to the one that is there, the region's shape becomes the union
   * of them, and the single flame over it is redrawn at the new size. The region
   * is still the thing that answers "is this creature standing in it", which is
   * what every other part of this engine already asks.
   *
   * ⚠️ A TOKEN IN A LIT SQUARE CATCHES WHOLE. His rule: "A creature standing in a
   * lit square catches, and the whole body burns." Not a patch of it, and never
   * the square's own fuel: it goes through the body rule, so a dragon burns for an
   * hour and a rat for a minute.
   */
  static async lightSquares(squares, opts = {}, { grow = false } = {}) {
    if (!FireEngine._isActiveGM()) {
      ui.notifications?.warn("Only the acting GM can light a fire.");
      return null;
    }
    const scene = canvas?.scene;
    if (!scene || !squares?.length) return null;

    try {
      const { FirePaint } = await import("./fire-paint.mjs");
      const gs = canvas?.grid?.size ?? 100;
      const fuel = opts.fuel ?? "debris";
      const ignition = opts.ignition ?? "torch";
      const spec = FUELS[fuel] ?? FUELS.debris;
      const src = IGNITION[ignition] ?? IGNITION.torch;

      // The fire he is painting into: the most recent ACE fire on this scene whose
      // fuel and ignition match, so a second session with different choices is a
      // second fire rather than silently joining the first.
      let region = [...(scene.regions ?? [])]
        .filter(r => {
          const f = r.flags?.[FLAG_NS]?.fire;
          return f?.kind === "squares" && f.fuel === fuel && f.ignition === ignition;
        })
        .sort((a, b) => (b.flags?.[FLAG_NS]?.fire?.startedAt ?? 0)
                      - (a.flags?.[FLAG_NS]?.fire?.startedAt ?? 0))[0] ?? null;

      const have = new Set(region?.flags?.[FLAG_NS]?.fire?.squares ?? []);
      const added = [];
      for (const sq of squares) {
        const key = FirePaint.key(sq.x, sq.y);
        if (have.has(key)) continue;
        have.add(key);
        added.push(sq);
      }

      const keys = [...have];
      const shapes = keys.map(k => {
        const { x, y } = FirePaint.fromKey(k);
        return { type: "rectangle", x, y, width: gs, height: gs, rotation: 0, hole: false };
      });

      if (!region) {
        const record = {
          kind: "squares",
          fuel, ignition,
          startedAt: FireEngine.now,
          endsAt: FireEngine.now + Math.round(spec.minutes * 60),
          minutes: spec.minutes,
          damage: spec.damage,
          damageBonus: src.damageBonus,
          squares: keys,
        };
        [region] = await scene.createEmbeddedDocuments("Region", [{
          name: `ACE — Fire (${spec.label})`,
          color: "#e06010",
          shapes,
          behaviors: [],
          flags: { [FLAG_NS]: { fire: record } },
        }]);
        const until = FireEngine._describeRemaining(record);
        console.log(`${LOG} | lit ${keys.length} square${keys.length === 1 ? "" : "s"}: `
          + `${spec.label.toLowerCase()}, lit by ${src.label.toLowerCase()}, ${until}.`);
      } else if (added.length) {
        await region.update({ shapes, [`flags.${FLAG_NS}.fire.squares`]: keys });
        console.log(`${LOG} | ${added.length} more square${added.length === 1 ? "" : "s"} alight; `
          + `this fire is now ${keys.length} square${keys.length === 1 ? "" : "s"}.`);
      }

      /* ── What was standing in the squares he just lit ──────────────────────
         ⚠️ SKIPPED WHEN THE FIRE IS ONLY GROWING OVER SOMETHING THAT ALREADY
         CAUGHT. A tile that caught after ten minutes folds its squares in here so
         the one flame covers it; re-asking those squares what is in them would
         light the next tile overlapping it in the same instant, and the ten
         minutes he set would mean nothing two tiles along. */
      if (!grow) {
        for (const sq of added) {
          for (const tokenDoc of FirePaint.tokensIn(sq, scene)) {
            if (tokenDoc.flags?.[FLAG_NS]?.fire) continue;
            await FireEngine.igniteToken(tokenDoc, { ignition, fuel: "body" });
          }
          for (const tile of FirePaint.tilesIn(sq, scene)) {
            await FirePaint.catchTile(tile, { fuel, ignition }, FireEngine.now);
          }
          for (const wall of FirePaint.doorsIn(sq, scene)) {
            await FirePaint.catchDoor(wall, { fuel, ignition }, FireEngine.now);
          }
        }
      }

      await FireEngine._drawAreaFlames(region);
      FireEngine._paintTimers();
      return region;
    } catch (err) {
      console.error(`${LOG} | could not light those squares:`, err);
      ui.notifications?.error("ACE: could not light that square, see the console.");
      return null;
    }
  }

  /**
   * Put these squares out.
   *
   * His rule, 2026-10-06: "Right click puts that square out," and again under the
   * spread rule, "A right-click still puts a square out." So it is the eraser for
   * everything a square carries: the ground, the tile over it and the door in it.
   * A fire with no squares left is not a fire, so its region goes.
   */
  static async douseSquares(squares) {
    if (!FireEngine._isActiveGM()) return 0;
    const scene = canvas?.scene;
    if (!scene || !squares?.length) return 0;

    try {
      const { FirePaint } = await import("./fire-paint.mjs");
      const gs = canvas?.grid?.size ?? 100;
      const wanted = new Set(squares.map(s => FirePaint.key(s.x, s.y)));
      let cleared = 0;

      for (const region of [...(scene.regions ?? [])]) {
        const rec = region.flags?.[FLAG_NS]?.fire;
        if (rec?.kind !== "squares") continue;
        const keep = (rec.squares ?? []).filter(k => !wanted.has(k));
        if (keep.length === (rec.squares ?? []).length) continue;
        cleared += (rec.squares ?? []).length - keep.length;

        if (!keep.length) {
          await FireEngine.extinguishRegion(region);
          continue;
        }
        const shapes = keep.map(k => {
          const { x, y } = FirePaint.fromKey(k);
          return { type: "rectangle", x, y, width: gs, height: gs, rotation: 0, hole: false };
        });
        await region.update({ shapes, [`flags.${FLAG_NS}.fire.squares`]: keep });
        await FireEngine._drawAreaFlames(region);
      }

      // Whatever was burning in those squares is out too.
      for (const sq of squares) {
        for (const tile of FirePaint.tilesIn(sq, scene)) await FirePaint.douseTile(tile);
        for (const wall of FirePaint.doorsIn(sq, scene)) await FirePaint.douseDoor(wall);
        for (const tokenDoc of FirePaint.tokensIn(sq, scene)) {
          if (tokenDoc.flags?.[FLAG_NS]?.fire) await FireEngine.extinguishToken(tokenDoc, { quiet: true });
        }
      }

      FireEngine._paintTimers();
      // ⚠️ "NOTHING WAS BURNING THERE" IS AN ANSWER. A right-click on cold ground
      // must not look the same as a right-click that failed.
      console.log(cleared
        ? `${LOG} | put out ${cleared} square${cleared === 1 ? "" : "s"}.`
        : `${LOG} | nothing was burning on that square, so there was nothing to put out.`);
      return cleared;
    } catch (err) {
      console.error(`${LOG} | could not put those squares out:`, err);
      return 0;
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
   * ⚠️🔴 THE DAMAGE ONLY. BEATING IT OUT IS A CHECK AND IT IS NOT HERE (his rule,
   * 2026-10-06: "A Dexterity check against 10 puts it out. That is a check, not a
   * save, so proficiency does not apply.").
   *
   * This effect used to carry `saveDC: 10, saveAbility: "dex"`, and the OverTime
   * engine rolls that through `rollSavingThrow`, which adds save proficiency: a
   * Rogue with Dexterity save proficiency was beating out a fire on a 4. A check
   * is a different roll, and it happens at three different moments that OverTime
   * knows nothing about - the start of a turn in combat, every six seconds of real
   * time out of combat, and once inside one popup when the clock jumps. So the
   * effect does the 1d6 and `FireEngine.tryToPutOut` owns the roll, in one place,
   * for all three.
   */
  static async _applyBurning(tokenDoc, record) {
    try {
      const actor = tokenDoc?.actor;
      if (!actor) return;
      if ((actor.effects ?? []).some(e => e.flags?.[FLAG_NS]?.fireBurning)) return;

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

  /**
   * Everyone standing in a burning area catches, and the WHOLE BODY burns.
   *
   * ⚠️🔴 THE BODY, NOT THE GROUND'S FUEL (his rule, 2026-10-06: "A creature
   * standing in a lit square catches, and the whole body burns."). This used to
   * hand the creature the AREA's record, so a creature standing in three minutes
   * of burning oil burned for three minutes whatever it was, and it never got the
   * fire flag, the flame on its token, or the clock a body is supposed to have.
   * It goes through `igniteToken` now, which is the one body rule: the size
   * decides the time, a dragon for an hour and a rat for a minute.
   */
  static async _burnOccupants(region) {
    try {
      const record = region?.flags?.[FLAG_NS]?.fire;
      if (!record) return;
      for (const tokenDoc of (region.parent?.tokens ?? [])) {
        const token = tokenDoc.object;
        if (!token) continue;
        if (!FireEngine._inRegion(region, token)) continue;
        if (tokenDoc.flags?.[FLAG_NS]?.fire) continue;   // already alight
        await FireEngine.igniteToken(tokenDoc, { ignition: record.ignition, fuel: "body" });
      }
    } catch (err) {
      console.warn(`${LOG} | could not work out who is standing in the fire:`, err);
    }
  }

  /* ═══ Beating it out ═════════════════════════════════════════════════════ */

  /**
   * One Dexterity CHECK against 10 to put the fire on a creature out.
   *
   * His rule, 2026-10-06: "A Dexterity check against 10 puts it out. That is a
   * check, not a save, so proficiency does not apply."
   *
   * ⚠️ `rollAbilityCheck`, NEVER `rollSavingThrow`. They are two different rolls
   * and the difference is exactly the proficiency he called out: a creature with
   * Dexterity save proficiency was beating out a fire several points too easily.
   *
   * ⚠️ A CORPSE DOES NOT ROLL. A dead thing cannot beat out flames, and without
   * this a burning body would put itself out on its own turn, which is the whole
   * reason a corpse burns to ash in the first place.
   *
   * @param {TokenDocument} tokenDoc
   * @param {object}  opts
   * @param {boolean} opts.damageOnFail  take the 1d6 when the check fails. True
   *   outside combat, where nothing else is rolling that damage; false in combat,
   *   where the Burning effect already lands it at the start of the turn.
   * @returns {Promise<null|{total:number, passed:boolean}>}
   */
  static _rolling = new Set();

  static async tryToPutOut(tokenDoc, { damageOnFail = true, why = "" } = {}) {
    const doc = tokenDoc?.document ?? tokenDoc;
    const record = doc?.flags?.[FLAG_NS]?.fire;
    if (!record) return null;

    /* ⚠️🔴 ONE CHECK AT A TIME, PER CREATURE, AND THE NEXT ONE IS SIX SECONDS
       AFTER THIS CARD LANDS (his find, 2026-10-06: "The fire check is rolling
       again the instant it fails. Vilnius failed three times and passed on the
       fourth inside one second. A failure keeps him burning. It does not roll the
       check again. The next check is 6 real seconds after this card is on the
       screen.").

       Two things were wrong and this closes both. The window was re-armed BEFORE
       the roll, from the moment the tick started, so everything the check then
       waited on - the dice settling, the damage roll, two card posts - was spent
       inside the six seconds, and the next heartbeat found the window already
       expired. And nothing stopped a second driver, or a second heartbeat,
       entering while the first was still waiting.

       So the lock is held for the whole check, by creature, and the window is
       re-armed at the END, from the moment the card is on screen. A creature
       cannot be asked twice however many things are asking. */
    if (FireEngine._rolling.has(doc.id)) {
      console.log(`${LOG} | ${doc.name} is already rolling to beat the flames out; this ask is `
        + `dropped rather than stacked on it.`);
      return null;
    }

    /* ⚠️🔴 NOBODY ROLLS WHILE THE GAME IS PAUSED (his rule, 2026-10-06: "While the
       game is paused, nobody rolls to put a fire out. Not the 6-second check, not
       a clock jump, not the start of a turn.").
       It is refused HERE, in the one place every check goes through, rather than
       at each of the three callers: a pause is a pause whichever of them asked,
       and a guard that has to be remembered at every new call site is a guard that
       will be left off one. */
    if (game.paused) {
      console.log(`${LOG} | the game is paused, so ${doc.name} does not roll to beat the flames `
        + `out. Its six seconds are held where they are.`);
      return null;
    }
    if (FireEngine._isDead(doc)) {
      console.log(`${LOG} | ${doc.name} is dead, so it cannot beat the flames out. It burns.`);
      return null;
    }
    const actor = doc.actor;
    if (!actor) {
      console.warn(`${LOG} | ${doc.name} is on fire and has no actor, so nobody can roll to put `
        + `it out. It will burn its full time.`);
      return null;
    }

    /* ⚠️🔴 THE DIE CROSSES THE SCREEN (his rule, 2026-10-06: "The check never
       rolled. Dice So Nice did not play, and the card had no result... A 12 that
       beats 10 is a die the table watched, not a sentence.").

       `{create: false}` keeps dnd5e's own card off the log, which is right - ACE
       never posts a vanilla card - but it also means no chat message is created,
       and the 3D dice ride on that message. So the roll is handed to the suite's
       own DSN door, and the card waits for those dice to stop before it posts.
       That is the same path every other roll in the suite takes. */
    FireEngine._rolling.add(doc.id);
    try {
      return await FireEngine._runCheck(doc, actor, record, { damageOnFail, why });
    } finally {
      // The next one is six seconds from HERE: the card is on screen.
      FireEngine._rolling.delete(doc.id);
      if (doc.flags?.[FLAG_NS]?.fire) FireEngine._armRealCheck(doc);
      else FireEngine._disarmRealCheck(doc);
    }
  }

  /** The roll itself, the card, and what the result does. */
  static async _runCheck(doc, actor, record, { damageOnFail, why }) {
    let roll = null;
    try {
      const rolls = await actor.rollAbilityCheck(
        { ability: "dex", target: 10 },
        { configure: false },
        { create: false },
      );
      roll = Array.isArray(rolls) ? rolls[0] : rolls;
    } catch (err) {
      console.warn(`${LOG} | ${doc.name}'s Dexterity check would not roll through the system; `
        + `rolling it here instead:`, err);
    }
    if (!Number.isFinite(Number(roll?.total))) {
      try {
        const mod = Number(actor.system?.abilities?.dex?.mod ?? 0) || 0;
        roll = await new Roll(`1d20 + ${mod}`).evaluate();
      } catch (err) {
        console.warn(`${LOG} | ${doc.name}'s Dexterity check could not be rolled at all, so the `
          + `fire stays on it:`, err);
        return null;
      }
    }

    const total = Number(roll.total);
    const face = Number(roll.dice?.[0]?.total ?? roll.terms?.find(t => t?.faces === 20)?.total ?? NaN);
    const passed = total >= 10;


    const { safeShowForRoll, awaitDiceSettle } = await import("./dsn-utils.mjs");
    safeShowForRoll(roll, `${doc.name}'s Dexterity check against the flames`);
    await awaitDiceSettle(4000);

    console.log(`${LOG} | ${doc.name} Dex CHECK ${Number.isFinite(face) ? `d20 ${face}, ` : ""}`
      + `total ${total} vs 10 ${passed ? "PASS" : "FAIL"}`
      + `${why ? ` (${why})` : ""} — ${passed ? "the fire on it is out" : "it keeps burning"}.`);

    /* ⚠️🔴 THE DAMAGE IS ROLLED BEFORE THE CARD, AND IT IS NOT A SECOND CHECK
       (his find, 2026-10-06: "The fire check is rolling again the instant it
       fails... The damage roll is not a new check."). It goes onto the same card,
       under the check, so there is one card for one check. */
    const burn = (!passed && damageOnFail) ? await FireEngine._rollBurn(doc, record) : null;

    await FireEngine._postCheckCard(doc, { face, total, passed, burn });

    if (passed) await FireEngine.extinguishToken(doc, { quiet: true });
    return { total, passed };
  }

  /**
   * The black card for one Dexterity check: the die, the total, and the verdict.
   *
   * His rule, 2026-10-06: "the black card shows the d20 face with the number,
   * then the total against 10."
   *
   * ⚠️ THE SUITE'S OWN D20 WIDGET, not a new one. `aceD20FaceImg` is the same die
   * the save cards, the roll box, break-free and concentration all draw, and a
   * second die face invented here is exactly the drift that left two escape-card
   * builders disagreeing.
   */
  /**
   * ONE CARD PER CHECK (his rule, 2026-10-06: "One card per check... A failure
   * puts the 1d6 fire on that same card, under the check, with Apply and the
   * quarter, half, 1, and 2 buttons. Not a second card.").
   *
   * ⚠️ THE FACE IS THE ROLL, PRINTED ONCE. "The die face is the roll, and the
   * number on that face is not printed again... A 6 that is also the total does
   * not become 6, 6." So the die art carries the number, the bonus follows it by
   * name, and the total appears only when a bonus actually changed it.
   *
   * ⚠️ THE DAMAGE BLOCK IS THE SUITE'S OWN ROW, not a second layout:
   * `buildTargetRowHtml` is the row a weapon hit draws, the `damageResult` flag is
   * the gate damage-engine opens its button handler on, and the two class names
   * on the controls are the ones that hide them from players. A card missing any
   * of those three has dead buttons and leaks them to the table - that is written
   * down in fall-pipeline.mjs from the day it happened.
   */
  static async _postCheckCard(tokenDoc, { face, total, passed, burn }) {
    try {
      const { aceD20FaceImg } = await import("./dice-face.mjs");
      const { faceImg } = await import("./face.mjs");
      const { CardDoor } = await import("./road/doors.mjs");
      const { explainCheck } = await import("./roll-formula.mjs");
      const { DamageCardRenderer } = await import("./damage-card-renderer.mjs");
      const esc = foundry.utils.escapeHTML;
      const signed = (n) => `${n < 0 ? "−" : "+"}${Math.abs(n)}`;
      const colour = passed ? "#9bcc4a" : "#ff1744";

      /* ── "Dex +2 = 8 vs 10", and a bare "vs 10" when nothing was added ──
         The ability's own part is named by the ability and nothing else: the
         sheet's reader labels it "Dex 14", which is the score, and the score is
         not what was added to the die. */
      const used = Number.isFinite(face) ? total - face : null;
      let bonusText = "";
      if (used) {
        const read = explainCheck(tokenDoc.actor, { ability: "dex" });
        const named = (read.parts ?? []).filter(p => Number(p.value) !== 0).map(p => {
          const label = p.why === "ability" ? "Dex" : (p.label || "bonus");
          return `${esc(label)} ${signed(Number(p.value))}`;
        });
        // ⚠️ WHAT THE ROLL USED, NOT WHAT THE SHEET ADDS UP TO. If dnd5e added
        // something this reader cannot see, the number is still right and the
        // part that cannot be named says so instead of going missing.
        const sum = (read.parts ?? []).reduce((n, p) => n + (Number(p.value) || 0), 0);
        if (sum !== used) {
          named.push(`${signed(used - sum)} from somewhere this sheet does not name`);
          console.log(`${LOG} | ${tokenDoc.name}'s check used ${signed(used)} where the sheet adds `
            + `up to ${signed(sum)}. The card shows what the roll used.`);
        }
        bonusText = `${named.join(" ")} = ${total} `;
      }

      let damageBlock = "";
      let flags = { type: "fireCheck" };
      if (burn) {
        const hp = tokenDoc.actor?.system?.attributes?.hp ?? {};
        const row = DamageCardRenderer.buildTargetRowHtml({
          tokenDocId: tokenDoc.id,
          actorId: tokenDoc.actor?.id,
          sceneId: tokenDoc.parent?.id,
          name: tokenDoc.name,
          img: burn.img,
          currentHP: Number(hp.value ?? 0),
          maxHP: Number(hp.max ?? 0),
          totalFinal: burn.final,
          isCrit: false,
          components: burn.components,
        });
        const burnType = burn.components?.[0]?.type ?? "fire";
        /* ⚠️🔴 ONE PILL ON THE PLAYER'S HALF (his rule, 2026-10-06: "Under a
           failure, one orange-red pill, about the size of the red 2 that is there
           now: 2 fire damage. Remove the 1d6 fire. Remove the lower row with his
           portrait and the other 2 fire pill.").

           The table was reading the same number three times: the raw die beside
           "1d6 fire", then again inside the target row's own pill, with his
           portrait repeated under a card that already has his face at the top. The
           damage he took is one fact and it gets one pill.

           Nothing is deleted from the GM half, which is why the row is still built
           and still carries the switch, the quarter, half, 1 and 2, and the hit
           points: it moves inside the GM wrapper rather than off the card. The
           same markup goes to every client and the halves differ only by who is
           allowed to see which, which is the rule every other card follows. */
        damageBlock = `
          <div class="ace-qol-fire-hit">
            <span class="ace-qol-fire-hit-pill">${burn.final} ${esc(burnType)} damage</span>
          </div>
          <div class="ace-qol-fire-burn ace-qol-gm-only">
            <div class="ace-qol-fire-burn-dice">
              <span class="ace-qol-fire-burn-formula">${esc(burn.formula)} ${esc(burnType)}</span>
              <span class="ace-qol-fire-burn-face">${burn.raw}</span>
            </div>
            <div class="ace-qol-dmg-targets">${row}</div>
            <div class="ace-qol-dmg-gm-controls">
              <div class="ace-qol-dmg-actions">
                <button class="ace-qol-btn ace-qol-btn-apply" data-action="aceQolApplyDamage">
                  <i class="fas fa-heart-crack"></i> APPLY
                </button>
                <button class="ace-qol-btn ace-qol-btn-undo" data-action="aceQolUndoDamage">
                  <i class="fas fa-undo"></i> UNDO ALL
                </button>
              </div>
            </div>
          </div>`;
        flags = {
          // ⚠️ THE GATE. damage-engine only wires buttons on a card whose type is
          // in its whitelist. Without this every button here is dead AND the
          // hide-from-players pass never runs.
          type: "damageResult",
          damageResults: [{
            targetId: tokenDoc.actor?.id,
            tokenId: tokenDoc.id,
            tokenDocId: tokenDoc.id,
            sceneId: tokenDoc.parent?.id,
            isLinked: tokenDoc.actorLink ?? false,
            totalFinal: burn.final,
            currentHP: Number(hp.value ?? 0),
            maxHP: Number(hp.max ?? 0),
            name: tokenDoc.name,
            img: burn.img,
            result: "hit",
            reactionsAsked: true,
            // A Roll object does not belong in flags.
            components: burn.components.map(({ roll: _r, ...rest }) => rest),
          }],
          totalRaw: burn.raw,
          aceFire: { check: total, dc: 10 },
        };
      }

      const content = `
        <div class="ace-qol-card ace-qol-fire-card">
          <div class="ace-qol-fire-who">
            ${faceImg(tokenDoc.actor, "ace-qol-fire-face")}
            <span class="ace-qol-fire-name">${esc(tokenDoc.name ?? "")}</span>
            <span class="ace-qol-fire-what">Dexterity check</span>
          </div>
          <!-- ⚠️🔴 THE DIE IS THE TABLE'S, THE ARITHMETIC IS HIS (his rule,
               2026-10-06: "Vilnius on fire: they see his die and that he is still
               on fire, and they see 5 fire. They do not see Dex +2 or vs 10. You
               do."). One card: the face and the verdict are public, the bonus and
               the 10 it was measured against are the GM half of the same card.
               A span, not a block, so his half sits on the line beside the die
               rather than dropping below it. -->
          <!-- ⚠️🔴 THE DIE, ITS NUMBER, THEN THE VERDICT (his rule, 2026-10-06:
               "The die on the player's half is 40 by 40, with the number beside
               it. A success reads that number, then = pass... A failure reads that
               number, then = fail").

               The face is the roll and the number beside it is that same face
               written out, which is what he asked for: the table reads 6 = fail
               and learns nothing about the bonus or the 10 it was measured
               against. Those stay on the GM half of this same line, after the
               verdict, so his reading order is not disturbed by them. -->
          <div class="ace-qol-fire-roll">
            ${aceD20FaceImg(face, { size: 40 })}
            <span class="ace-qol-fire-face-num">${Number.isFinite(face) ? face : "?"}</span>
            <span class="ace-qol-fire-eq" style="color:${colour};">
              = ${passed ? "pass" : "fail"}</span>
            <span class="ace-qol-fire-sum ace-qol-gm-only">${bonusText}vs 10</span>
          </div>
          <div class="ace-qol-fire-verdict" style="color:${colour};">
            ${esc(tokenDoc.name ?? "It")} ${passed ? "beat the flames out" : "is still on fire"}.
          </div>
          ${damageBlock}
        </div>`;

      await CardDoor.post({
        content,
        flags: { [MODULE_ID]: flags },
      }, { dice: false });   // dice-ok: awaitDiceSettle above already held this card
    } catch (err) {
      console.warn(`${LOG} | the Dexterity check card could not be posted. The roll stands: `
        + `${tokenDoc?.name} rolled ${total} against 10 and ${passed ? "is out" : "keeps burning"}.`, err);
    }
  }

  /**
   * Roll the fire a failed check costs, and hand the numbers back.
   *
   * ⚠️🔴 IT ROLLS, IT DOES NOT POST AND IT DOES NOT APPLY (his rule, 2026-10-06:
   * "A failure puts the 1d6 fire on that same card, under the check, with Apply
   * and the quarter, half, 1, and 2 buttons. Not a second card.").
   *
   * This posted its own damage card an hour ago, which gave him two cards for one
   * check, and before that it took the hit points off directly, which left nothing
   * on screen to apply, halve or undo. It does one job now: roll the die, show it,
   * and give the check card what it needs to draw the damage underneath itself.
   *
   * ⚠️ `preview` IS WHAT READS RESISTANCE. The raw total and the final both go
   * back, because the row prints the reduction and APPLY needs the final.
   */
  static async _rollBurn(tokenDoc, record) {
    try {
      const actor = tokenDoc?.actor;
      if (!actor) return null;
      const dice = record?.damage ?? "1d6";
      const formula = record?.damageBonus > 0 ? `${dice} + ${record.damageBonus}` : dice;

      const roll = await new Roll(formula).evaluate();
      // ⚠️ THE DIE CROSSES THE SCREEN, and the card waits for it. His rule:
      // "Whenever a roll happens, the die crosses the screen and the result is on
      // the card."
      const { safeShowForRoll, awaitDiceSettle } = await import("./dsn-utils.mjs");
      safeShowForRoll(roll, `the fire on ${tokenDoc.name}`);
      await awaitDiceSettle(4000);

      const { HpDoor } = await import("./road/doors.mjs");
      const { faceOf } = await import("./face.mjs");
      const raw = Number(roll.total) || 0;
      const finals = HpDoor.preview(actor, [{ amount: raw, type: "fire" }]);
      const final = Number(finals?.[0]?.final ?? raw) || 0;

      console.log(`${LOG} | ${tokenDoc.name} failed and the fire rolled ${raw}`
        + `${final !== raw ? `, reduced to ${final}` : ""}. It goes on the check card; APPLY is his.`);

      return {
        raw, final, formula, img: faceOf(actor),
        components: [{
          name: "Burning", type: "fire", raw, final,
          formula: roll.formula, roll,
          modifier: finals?.[0]?.modifier ?? "normal",
        }],
      };
    } catch (err) {
      console.warn(`${LOG} | ${tokenDoc?.name} failed its check and the fire damage could not be `
        + `rolled, so the card shows the check alone:`, err);
      return null;
    }
  }

  /**
   * One line about a fire, on the black ACE card.
   *
   * ⚠️🔴 NOT A WHISPER, AND NOT FOUNDRY'S PARCHMENT (his rule, 2026-10-06). This
   * was whispered to the GMs with no card behind it, so Foundry drew it as pale
   * yellow text on its own whisper paper and the result could not be read. The
   * table is watching a creature burn; whether it beat the flames out is not a
   * secret, so the card is public and it is the suite's own black one.
   */
  static async _sayBurn(text) {
    try {
      const { CardDoor } = await import("./road/doors.mjs");
      await CardDoor.post({
        content: `<div class="ace-qol-card ace-qol-fire-line">`
          + `<i class="fas fa-fire"></i> ${foundry.utils.escapeHTML(text)}</div>`,
        flags: { [MODULE_ID]: { type: "fireLine" } },
      }, { dice: false });
    } catch (err) {
      console.warn(`${LOG} | could not post "${text}":`, err);
    }
  }

  /** Every creature on this scene that is currently alight. */
  static _burningTokens() {
    return [...(canvas?.scene?.tokens ?? [])].filter(t => t.flags?.[FLAG_NS]?.fire);
  }

  /** Is a fight running on this scene right now? */
  static _inCombat() {
    const c = game.combats?.active ?? game.combat;
    return !!(c?.started && (c.scene?.id ?? canvas?.scene?.id) === canvas?.scene?.id);
  }

  /* ── 1. In combat: the start of its own turn ───────────────────────────── */

  /**
   * ⚠️ THE DAMAGE IS NOT HERE. The Burning effect lands the 1d6 through the
   * OverTime engine at the start of the turn, which is what that engine is for.
   * This is only the check, which is why `damageOnFail` is false: rolling it here
   * too would hit the creature twice for one turn.
   */
  static async _combatTurnCheck(combat) {
    if (!FireEngine._isActiveGM()) return;
    try {
      const doc = combat?.combatant?.token;
      if (!doc?.flags?.[FLAG_NS]?.fire) return;
      await FireEngine.tryToPutOut(doc, { damageOnFail: false, why: "start of its turn" });
    } catch (err) {
      console.warn(`${LOG} | the turn-start check for a burning creature threw:`, err);
    }
  }

  /* ── 2. Out of combat: every six seconds of real time ──────────────────── */

  /**
   * His rule, 2026-10-06: "The wait is 6 seconds of real time, not 10. The first
   * check is 6 seconds after that creature catches. The next is 6 seconds after it
   * rolls." Six is a round, which is why it is six: a creature burning outside a
   * fight is beating at itself on the same beat it would inside one.
   *
   * The rest of the rule, from the same morning: "that same check happens while it
   * is still on fire. Fail, and it takes the 1d6. Succeed,
   * and the fire on it goes out. The fire on the ground keeps burning. During
   * combat, do not also ask every 6 seconds."
   *
   * ⚠️ REAL SECONDS, NOT GAME SECONDS, and that is the whole reason it is a wall
   * clock and not the world clock. Standing in a fire while nobody is counting
   * rounds should still be frightening, and the world clock does not move on its
   * own. The six seconds he is feeling are the six seconds on his watch.
   *
   * ⚠️ IT STANDS DOWN INSIDE A FIGHT. Both would otherwise run, and a creature
   * would get a turn-start check and a handful of six-second ones in the same
   * round, which is exactly what he ruled out.
   */
  static _realTimer = null;

  /**
   * ⚠️🔴 EACH CREATURE'S TEN SECONDS STARTS WHEN THAT CREATURE CAUGHT (his find,
   * 2026-10-06: "The Dexterity check is firing the moment a creature catches
   * fire. Vilnius was out before one second had passed.").
   *
   * The cause, and it is a plain one: the wait was ONE interval shared by
   * the whole scene, running since the module loaded. A creature that caught nine
   * and a half seconds into that window got its first check half a second later,
   * and the fire was out before he let go of the mouse. The window was the
   * engine's, not the creature's.
   *
   * So each burning creature carries its own due time on the wall clock, set the
   * moment it catches and pushed six seconds further every time it rolls. The
   * ticker below runs every second and asks only whose turn it is, which also
   * means a creature that catches during the lighting cannot be checked by it:
   * the earliest possible moment is ten real seconds later, by construction.
   */
  static _nextCheck = new Map();

  /**
   * What each creature had left on its six seconds when the game was paused.
   *
   * ⚠️🔴 A PAUSED GAME IS NOT TIME (his rule, 2026-10-06: "Time spent paused does
   * not count. If four seconds of the six had passed, unpausing continues the last
   * two. It does not fire every check that came due while the game was sitting
   * still, and it does not roll the moment you unpause unless the six seconds were
   * already up before the pause.").
   *
   * The wall clock does not stop for a pause, so an absolute due time kept running
   * through one: come back from lunch and every burning creature is hours overdue
   * and rolls the instant he presses play. At the pause each creature's REMAINDER
   * is kept and its due time dropped; at the unpause that remainder becomes a new
   * due time from that moment. Four seconds in gives two seconds back, and a
   * creature that was already due rolls on the first heartbeat after the unpause
   * and not before it, which is the one case he said should still fire.
   */
  static _paused = new Map();

  /** This creature's first check is six real seconds from now. */
  static _armRealCheck(tokenDoc, { from = Date.now() } = {}) {
    const id = tokenDoc?.id;
    if (!id) return;
    // Lit during a pause: it holds six whole seconds, and they start when he does.
    if (game.paused) { FireEngine._paused.set(id, BEAT_IT_OUT_MS); return; }
    FireEngine._nextCheck.set(id, from + BEAT_IT_OUT_MS);
  }

  static _disarmRealCheck(tokenDoc) {
    const id = tokenDoc?.id ?? tokenDoc;
    if (!id) return;
    FireEngine._nextCheck.delete(id);
    FireEngine._paused.delete(id);
  }

  /** The clock stops: keep what everybody had left, and stop counting. */
  static _freezeChecks() {
    const now = Date.now();
    for (const [id, due] of FireEngine._nextCheck) {
      FireEngine._paused.set(id, Math.max(0, due - now));
    }
    FireEngine._nextCheck.clear();
    const held = FireEngine._paused.size;
    if (held) {
      console.log(`${LOG} | paused, so ${held} burning creature${held === 1 ? "" : "s"} stop`
        + `${held === 1 ? "s" : ""} trying to beat the flames out. What each had left is kept.`);
    }
  }

  /** The clock starts again: everybody continues from where they stopped. */
  static _thawChecks() {
    const now = Date.now();
    for (const [id, left] of FireEngine._paused) {
      FireEngine._nextCheck.set(id, now + left);
    }
    const held = FireEngine._paused.size;
    FireEngine._paused.clear();
    if (held) {
      console.log(`${LOG} | running again; ${held} burning creature${held === 1 ? "" : "s"} pick`
        + `${held === 1 ? "s" : ""} up where the pause left off.`);
    }
  }

  static _startRealClock() {
    if (FireEngine._realTimer) return;
    // ⚠️ ONE SECOND, NOT SIX. The interval is only the heartbeat that asks whose
    // wait is up; the six seconds themselves belong to each creature.
    FireEngine._realTimer = setInterval(() => {
      FireEngine._realTick().catch(err =>
        console.warn(`${LOG} | the six second check threw:`, err));
    }, 1000);
  }

  static async _realTick() {
    if (!FireEngine._isActiveGM()) return;
    // ⚠️ PAUSED IS NOT TIME. The freeze below holds every remainder, so this does
    // not need to count anything while the game is still; it just stops.
    if (game.paused) return;
    if (FireEngine._inCombat()) return;          // the turn-start check owns it
    if (FireEngine._realBusy) return;            // a slow roll must not stack
    const burning = FireEngine._burningTokens();
    if (!burning.length) {
      if (FireEngine._nextCheck.size) FireEngine._nextCheck.clear();
      return;
    }
    const now = Date.now();
    FireEngine._realBusy = true;
    try {
      for (const doc of burning) {
        if (!doc.flags?.[FLAG_NS]?.fire) continue;   // it went out while we worked
        const due = FireEngine._nextCheck.get(doc.id);
        // No due time means it caught before this client was watching - a reload,
        // or a scene change. Its six seconds start now rather than immediately.
        if (due === undefined) { FireEngine._armRealCheck(doc, { from: now }); continue; }
        if (now < due) continue;
        /* ⚠️ THE WINDOW IS RE-ARMED BY THE CHECK ITSELF, when its card is on
           screen, not here before the dice have even been thrown. Re-arming from
           this moment is what let a check that took a second to roll and post come
           straight back round: everything it waited on was spent inside the six
           seconds it had just claimed. */
        await FireEngine.tryToPutOut(doc, { damageOnFail: true, why: "six seconds of beating at it" });
      }
    } finally {
      FireEngine._realBusy = false;
    }
  }

  /* ── 3. The clock jumping: ONE popup for the whole advance ─────────────── */

  /**
   * His rule, 2026-10-06: "Advancing the clock is separate from those 6 seconds.
   * However far the clock jumps, one popup for that advance, covering everyone
   * still on fire. Each of them gets the check once, inside that one popup. Not
   * one popup per 6 seconds of game time."
   *
   * ⚠️ ONE POPUP, ONE CHECK EACH, WHATEVER THE JUMP IS. An hour advanced is 600
   * six-second windows, and asking per window would be 600 popups and 600 rolls
   * for one button press. The advance is one event and it gets one answer.
   */
  static async _clockJumpCheck(seconds) {
    if (!FireEngine._isActiveGM()) return;
    /* ⚠️ NOT EVEN THE POPUP WHILE PAUSED (his rule, 2026-10-06: "not a clock
       jump"). The guard inside `tryToPutOut` would refuse every roll anyway, but
       a dialog that opens, lists four creatures and then does nothing to any of
       them is worse than no dialog: it reads as a broken feature. */
    if (game.paused) {
      console.log(`${LOG} | the clock moved while the game is paused, so nobody is asked to beat `
        + `the flames out. Each creature keeps whatever it had left.`);
      return;
    }
    const burning = FireEngine._burningTokens();
    if (!burning.length) return;
    if (FireEngine._jumpOpen) return;             // one popup, even if the clock moves twice
    FireEngine._jumpOpen = true;
    try {
      const esc = foundry.utils.escapeHTML;
      const mins = Math.max(1, Math.round(Math.abs(seconds) / 60));
      const rows = burning.map(d => `
        <div style="display:flex;align-items:center;gap:10px;padding:6px 10px;">
          <img src="${d.actor?.img || d.texture?.src || ""}" alt=""
               style="width:34px;height:34px;border-radius:6px;border:1px solid #5b5241;
                      object-fit:contain;background:#14120e;flex-shrink:0;">
          <span style="font-size:16px;color:#f0e4c0;">${esc(d.name)}</span>
        </div>`).join("");

      const content = `
        <div style="background:linear-gradient(180deg,#15110d 0%,#0c0a08 100%);
                    border:2px solid #d4af37;border-radius:8px;padding:16px 18px;
                    color:#f0e4c0;font-family:'Signika','Helvetica Neue',sans-serif;">
          <div style="font-size:18px;font-weight:700;color:#ff6b3d;margin-bottom:6px;">
            <i class="fas fa-fire" style="margin-right:8px;"></i>Still burning
          </div>
          <div style="font-size:14px;color:#c0b288;font-style:italic;margin-bottom:10px;
                      line-height:1.45;">
            The clock moved about ${mins} minute${mins === 1 ? "" : "s"}. Each of these rolls a
            Dexterity check against 10, once, to beat the flames out. A failure takes the fire
            damage. The fire on the ground is not affected either way.
          </div>
          <div style="border:1px solid #4a3a28;border-radius:6px;padding:4px;">${rows}</div>
        </div>`;

      const answer = await foundry.applications.api.DialogV2.wait({
        window: { title: "ACE — Still burning" },
        position: { width: 480 },
        content,
        modal: true,
        buttons: [
          { action: "roll", label: "Beat them out", icon: "fa-solid fa-hand-fist", default: true },
          { action: "skip", label: "Leave them burning" },
        ],
        rejectClose: false,
      }).catch(() => null);

      if (answer !== "roll") {
        console.log(`${LOG} | the clock moved ${mins} minute${mins === 1 ? "" : "s"} and `
          + `${burning.length} creature${burning.length === 1 ? " was" : "s were"} left burning `
          + `without a check, by his choice.`);
        return;
      }
      for (const doc of burning) {
        if (!doc.flags?.[FLAG_NS]?.fire) continue;
        await FireEngine.tryToPutOut(doc, { damageOnFail: true, why: `the clock moved ${mins} min` });
      }
    } finally {
      FireEngine._jumpOpen = false;
    }
  }

  /**
   * Is this token inside the region?
   *
   * ⚠️ ASK THE REGION, DO NOT MEASURE IT AGAIN. Foundry V13 computes region
   * membership itself and keeps it current through movement; a second geometry
   * test here would be the "two answers to one question" that made a creature
   * half inside a Moonbeam take damage on the cast and nothing walking back in.
   *
   * ⚠️🔴 AND IT SAID NOBODY WAS EVER IN THE FIRE (found 2026-10-05, same cause as
   * the missing flames). This read `region.object.testPoint(centre, elevation)`:
   * the deprecated placeable call, whose shim passes both arguments to
   * `RegionDocument#testPoint(point)`, which takes ONE elevated point. The
   * elevation was discarded, the document compared its floor against undefined,
   * and the answer was false for every creature on the map. A drawn fire set
   * nothing alight and never said so. `testInsideRegion` is Foundry's OWN reader,
   * the same call it uses to fill `region.tokens`, so this is still one definition
   * of inside and not a second geometry test.
   */
  static _inRegion(region, token) {
    const doc = token?.document ?? token;
    try {
      // It throws when the two are on different scenes, so that is asked first.
      if (typeof doc?.testInsideRegion === "function" && doc.parent === region.parent) {
        return !!doc.testInsideRegion(region);
      }
      return !!region.tokens?.has?.(doc);
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
        // It ran its clock out, so it leaves a stain. A douse does not.
        if (now >= record.endsAt) {
          await FireEngine.extinguishRegion(region, { soot: true });
          continue;
        }
        await FireEngine._spread(region);
        await FireEngine._burnOccupants(region);
      } catch (err) {
        console.warn(`${LOG} | a burning area could not be advanced:`, err);
      }
    }

    /* ── Tiles reaching what they touch, doors falling open ──────────────────
       His rule, 2026-10-06: a tile that has burned for ten minutes catches the
       next tile against its edge and any door there too, and a burning door is
       open after the same ten minutes. Driven by the clock like everything else
       in this engine, so a long rest resolves all of it in one step instead of
       leaving half-burned doors behind. */
    try {
      const { FirePaint } = await import("./fire-paint.mjs");
      await FirePaint.tickSlowBurn(now);
    } catch (err) {
      console.warn(`${LOG} | the slow burn on tiles and doors could not be advanced:`, err);
    }

    // The clock moved, so the number over every fire is now a minute out of date.
    FireEngine._paintTimers();
  }

  /** Grow a fire outward while it still has somewhere to go. */
  static async _spread(region) {
    const record = region.flags?.[FLAG_NS]?.fire;
    /* ⚠️ A PAINTED FIRE DOES NOT CREEP (his rule, 2026-10-06: "Empty floor does
       not. The painted map does not."). This grows a shape outward by feet, which
       is the old template-drawn fire. A fire made of squares grows only by
       catching a real tile or a real door, ten minutes in, and by him painting
       more squares - never by eating the floor around it. */
    if (record?.kind === "squares") return;
    if (!record?.spreadFtPerMin || !record.maxSpreadFt) return;

    const minutesBurning = (FireEngine.now - record.startedAt) / 60;
    const wanted = Math.min(record.maxSpreadFt,
      Math.round(minutesBurning * record.spreadFtPerMin / 5) * 5);
    if (!(wanted > record.spreadSoFarFt)) return;

    await region.update({
      shapes: [FireEngine._grownShape(record.baseShape, wanted)],
      [`flags.${FLAG_NS}.fire.spreadSoFarFt`]: wanted,
    });
    await FireEngine._drawAreaFlames(region);
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
        // ⚠️🔴 THE TOKEN IS NOT RESIZED OR MOVED ANY MORE. This shrank
        // every burnt body to a single 5-foot square and repositioned it from
        // its own centre — which does not land on the grid, so a Large corpse
        // became a small square sitting between lines. Johnny: "it made my
        // token a 5-foot square and not snap to grid, which is annoying... you
        // can't have it changing sizes to 5-foot squares."
        //
        // A pile of ash where a dragon lay IS dragon-sized. Nothing about
        // burning makes a thing move, and a rotation the fire never set is not
        // the fire's to clear.
        rotation: doc.rotation ?? 0,
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

      FireEngine._drawSmoke(doc)
        .catch(err => console.warn(`${LOG} | could not draw the smoke on ${doc?.name}:`, err));
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
      // Its six-second window goes out with it, so a creature lit again later
      // gets a fresh six seconds rather than one that is already overdue.
      FireEngine._disarmRealCheck(doc);
      if (!quiet) ui.notifications?.info(`${doc.name} is no longer on fire.`);
    } catch (err) {
      console.warn(`${LOG} | could not put ${doc?.name} out:`, err);
    }
  }

  static async extinguishRegion(region, { soot = false } = {}) {
    try {
      FireEngine._endFx(`${FX_PREFIX}area:${region.id}:*`);
      FireEngine._clearTimer(region.id);
      /* ⚠️ SOOT ONLY WHERE SOMETHING BURNED OUT (his rule, 2026-10-06: "What
         burned leaves soot, gray and black, so it shows on a black floor."). A
         fire he put out with a right-click or the douse button leaves nothing,
         because nothing finished burning; a fire that ran its clock out does. */
      if (soot) {
        try {
          /* ⚠️🔴 ALL OF ITS SQUARES, IN ONE CALL (his rule, 2026-10-06: "When a
             fire burns out, all of its squares are one stain, using
             ash-debris.png once... It is not three copies of the png.").
             This walked the squares and stained each one, which tiled the picture
             across the burn and read as wallpaper. The fire is painted by the
             square; the mark it leaves is one mark. */
          const { FirePaint } = await import("./fire-paint.mjs");
          const gs = canvas?.grid?.size ?? 100;
          const squares = (region.flags?.[FLAG_NS]?.fire?.squares ?? [])
            .map(key => {
              const { x, y } = FirePaint.fromKey(key);
              return { x, y, width: gs, height: gs };
            });
          await FirePaint.sootOver(squares, "the ground");
        } catch (err) {
          console.warn(`${LOG} | the fire went out and left no soot behind:`, err);
        }
      }
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


  /**
   * Add the three fire tools to a controls object.
   *
   * ⚠️ TAKES THE CONTROLS RATHER THAN REACHING FOR THEM, so the same code
   * serves the init-time hook and the after-ready injection. Two builders would
   * drift, and one of them would be the one nobody tested.
   */
  static _injectTools(controls) {
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
          order: aceToolOrder("ace-set-fire"),
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
          order: aceToolOrder("ace-douse-fire"),
          title: "ACE — Put it out",
          // ⚠️🔴 THE SAME GLYPH, WHICH IS WHAT HE ASKED FOR: "the exact same
          // icon with a slash through it, but blue." It was `fa-fire-flame-simple`,
          // a different flame that may not even exist in the Font Awesome build
          // Foundry ships — an icon that renders as nothing is a button he
          // cannot find, which is exactly what happened.
          // ⚠️🔴 A DIFFERENT GLYPH, BECAUSE THE COLOUR IS NOT ARRIVING.
          // He asked for the same flame with a blue slash, and that needs CSS
          // to land on Foundry's own markup — which it plainly is not doing:
          // "I've got two fire buttons at the bottom, and they both say Set
          // Fire... None of them are different colours." Two identical flames
          // with no colour is worse than a different icon. An extinguisher is
          // unmistakable at a glance, which is the whole job of an icon.
          icon: "fas fa-fire-extinguisher ace-douse-tool",
          button: true,
          visible: true,
          onChange: () => FireEngine.douse(),
        };

        // ⚠️ AND A WAY BACK. Reviving the token restores its art and nothing
        // else — the name, the size, the position and the LOOT are already
        // gone by then.
        const undoTool = {
          name: "ace-undo-fire",
          order: aceToolOrder("ace-undo-fire"),
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
  }

  /**
   * Put them in now, and keep putting them in on every future render.
   *
   * ⚠️ BOTH HALVES ARE NEEDED. The hook alone misses the toolbar that is
   * already on screen; the direct injection alone misses every later re-render.
   */
  /**
   * Paint the three tools after the toolbar renders.
   *
   * ⚠️🔴 THE STYLESHEET NEVER LANDED. Two attempts at CSS selectors both
   * failed, and I cannot see his DOM to find out why. Setting the colour on
   * the element is not elegant, but it depends on nothing except the class
   * being on the icon, which I control. It runs on every render because
   * Foundry rebuilds the toolbar whenever the active control changes.
   */
  static _paintTools() {
    const COLOURS = {
      "ace-fire-tool":      "#ff4d2d",
      "ace-douse-tool":     "#4db8ff",
      "ace-undo-fire-tool": "#f0c060",
    };
    try {
      for (const [cls, colour] of Object.entries(COLOURS)) {
        for (const el of document.querySelectorAll(`.${cls}`)) {
          el.style.color = colour;
        }
      }
    } catch (err) {
      console.warn(`${LOG} | could not colour the fire tools:`, err);
    }
  }

  static _injectPostReady() {
    // ⚠️ EVERY RENDER, because Foundry rebuilds the toolbar each time the
    // active control group changes, and a colour applied once is a colour lost
    // the first time he clicks anything else.
    // ⚠️ NOT ON EVERY APPLICATION RENDER. That fires for every window, every
    // sheet and every dialog in the game, and each call walked the whole DOM
    // three times to colour three icons. The toolbar is the only thing that can
    // change them, so watch the toolbar.
    Hooks.on("renderSceneControls", () => FireEngine._paintTools());

    Hooks.on("getSceneControlButtons", (controls) => {
      try { FireEngine._injectTools(controls); }
      catch (err) { console.warn(`${LOG} | could not add the fire tools:`, err); }
    });
    const now = () => {
      try {
        const ctrl = ui.controls?.controls;
        if (!ctrl) return false;
        FireEngine._injectTools(ctrl);
        try { ui.controls.render?.(); } catch (_) { /* the hook will catch the next render */ }
        return true;
      } catch (err) {
        console.warn(`${LOG} | could not add the fire tools to the open toolbar:`, err);
        return false;
      }
    };
    // ⚠️ THE TOOLBAR IS NOT ALWAYS BUILT THE INSTANT READY FIRES on a cold
    // reload, so this retries briefly rather than giving up in silence.
    if (!now()) {
      let tries = 0;
      const t = setInterval(() => {
        if (now() || ++tries > 20) clearInterval(t);
      }, 100);
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

  static async _drawTokenFlame(doc) {
    if (!FireEngine._isActiveGM()) return;
    try {
      if (typeof Sequence === "undefined" || !globalThis.Sequencer?.EffectManager) return;
      const name = `${FX_PREFIX}tok:${doc.id}`;
      if (FireEngine._alreadyPlaying(name)) return;
      const path = await FireEngine._flamePath(Math.max(doc.width, doc.height) >= 2);
      if (!path) {
        console.warn(`${LOG} | ${doc?.name} is burning and no flame picture could be found, so `
          + `nothing is drawn on it.`);
        return;
      }
      const token = doc.object;
      if (!token) {
        console.warn(`${LOG} | ${doc?.name} is burning and its token is not on the canvas yet, so `
          + `no flame was drawn. It is drawn again when the scene is ready.`);
        return;
      }
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
   * The region's own footprint, once the canvas has drawn it.
   *
   * Half a second of waiting, in frames, because the document exists before its
   * placeable does. `null` means it genuinely never arrived, and the caller says
   * so out loud rather than drawing nothing in silence.
   */
  static async _regionBounds(region, tries = 30) {
    for (let i = 0; i < tries; i++) {
      const b = region?.object?.bounds;
      if (b && (b.width || b.height)) return b;
      await new Promise(r => requestAnimationFrame(r));
    }
    return region?.object?.bounds ?? null;
  }

  /* ═══ The clock on the fire ══════════════════════════════════════════════ */

  /**
   * How much longer this one burns, on the canvas, over the fire itself.
   *
   * His ask, 2026-10-05: "it'll have a timer on it for how long it will burn."
   * The number already existed - `report()` prints it to the console and the
   * toast says it once when the fire starts - but neither of those is on the map
   * an hour later when he wants to know whether to bother walking around it.
   *
   * ⚠️ A PICTURE, NOT A DOCUMENT. This is a PIXI label held in memory per client,
   * the same way the hover distance and the flight badge are drawn. A Drawing or a
   * renamed region would write to the scene every minute and leave orphans behind
   * any fire that ended by a route that forgot to clean up; the flag on the region
   * is the fire, and this is only the reading of it.
   *
   * ⚠️ HIS ALONE. A player sees flames, not a countdown. The remaining burn time
   * is the GM's to know, the same rule as a monster's hit points.
   */
  static _timers = new Map();

  /** The time left, in the shortest true words. */
  static _timerText(record) {
    const secs = Math.max(0, Number(record?.endsAt ?? 0) - FireEngine.now);
    const mins = Math.floor(secs / 60);
    if (mins >= 60) {
      const h = Math.floor(mins / 60), m = mins % 60;
      return `${h}h${m ? ` ${m}m` : ""} left`;
    }
    if (mins >= 1) return `${mins} min left`;
    return "under a minute";
  }

  /** Font that stays readable on his 332px grid and on a 70px one. */
  static _timerFontSize() {
    const gs = canvas?.grid?.size ?? 100;
    return Math.round(Math.max(16, Math.min(44, gs * 0.13)));
  }

  static _clearTimer(id) {
    const label = FireEngine._timers.get(id);
    FireEngine._timers.delete(id);
    try { label?.destroy?.(); } catch (_) { /* already gone with the canvas */ }
  }

  /** Every label off this scene, for a scene change or an extinguish-all. */
  static clearTimers() {
    for (const id of [...FireEngine._timers.keys()]) FireEngine._clearTimer(id);
  }

  /**
   * Put a label on every burning area, update the ones that have one, and take
   * away the ones whose fire has gone out or whose region has been deleted.
   */
  static _paintTimers() {
    try {
      if (!game.user?.isGM) return;          // a local picture, so any GM, not only the acting one
      const scene = canvas?.scene;
      if (!scene) { FireEngine.clearTimers(); return; }

      const burning = new Set();
      for (const region of (scene.regions ?? [])) {
        const record = region.flags?.[FLAG_NS]?.fire;
        if (!record) continue;
        // The placeable carries the footprint, and it is built a frame or two
        // after the document. A fire with no bounds yet gets its label on the
        // next tick or on the next canvasReady, not a label at 0,0.
        const bounds = region.object?.bounds;
        if (!bounds || !(bounds.width || bounds.height)) continue;
        burning.add(region.id);

        let label = FireEngine._timers.get(region.id);
        if (!label || label.destroyed) {
          const size = FireEngine._timerFontSize();
          label = new PIXI.Text("", {
            fontSize: size,
            fontFamily: "Signika, sans-serif",
            fill: 0xffb060,
            stroke: 0x000000,
            strokeThickness: Math.max(4, Math.round(size / 5)),
            fontWeight: "bold",
            align: "center",
          });
          label.anchor.set(0.5, 0.5);
          label.eventMode = "none";          // never eat a click meant for the map
          label.zIndex = 1000;
          try { canvas.interface.addChild(label); }
          catch (_) { try { canvas.tokens.addChild(label); } catch (_) { continue; } }
          FireEngine._timers.set(region.id, label);
        }
        label.text = FireEngine._timerText(record);
        label.position.set(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
      }

      for (const id of [...FireEngine._timers.keys()]) {
        if (!burning.has(id)) FireEngine._clearTimer(id);
      }
    } catch (err) {
      console.warn(`${LOG} | could not put the clock on the fires:`, err);
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
  static async _drawAreaFlames(region) {
    if (!FireEngine._isActiveGM()) return;
    try {
      if (typeof Sequence === "undefined" || !globalThis.Sequencer?.EffectManager) return;
      const path = await FireEngine._flamePath(false);
      if (!path) {
        console.warn(`${LOG} | the area is burning and no flame picture could be found, so `
          + `nothing is drawn on it.`);
        return;
      }

      const gs = canvas?.grid?.size ?? 100;
      /* ⚠️🔴 THE REGION IS NOT ON THE CANVAS YET (his find, 2026-10-05). This
         is called the instant after `createEmbeddedDocuments`, and the placeable
         that carries the bounds is built by the layer a frame or two later. The
         old code read `region.object?.bounds`, found nothing and RETURNED WITHOUT
         A WORD, which is why "Fire started" came with no fire. It waits for the
         draw now, and if it never comes it says so. */
      const bounds = await FireEngine._regionBounds(region);
      if (!bounds) {
        console.warn(`${LOG} | the fire on "${region.name ?? region.id}" is burning, and its `
          + `region never appeared on the canvas, so no flames could be placed. They are drawn `
          + `again on the next scene load.`);
        return;
      }

      const w = Math.round(bounds.width);
      const h = Math.round(bounds.height);
      if (!(w > 0 && h > 0)) {
        console.warn(`${LOG} | the fire on "${region.name ?? region.id}" has no footprint `
          + `(${w}x${h} pixels), so there is nothing to draw a flame on.`);
        return;
      }

      /* ⚠️🔴 ONE FIRE, NOT ONE PER SQUARE (his screenshot, 2026-10-05: "it's 10 ft
         across, and it's got four fires there. I don't want four fires. I want all
         the same fire on whatever square I draw, just one animation across the
         whole thing.").

         It used to walk the bounding box square by square and start a separate
         persistent effect in each one that tested inside the shape, which is why a
         two-by-two circle came out as four identical campfires with gaps between
         them instead of one burning patch of ground. One effect, stretched over the
         whole footprint, is both what he asked for and far cheaper: a sixty-foot
         grass fire was 144 persistent effects and a visual budget to cap them.

         The size is in the NAME so a fire that has spread redraws at its new size,
         while a redraw of an unchanged fire finds it already playing and leaves it
         alone rather than restarting it, which would make every fire on the map
         blink on every tick. */
      const name = `${FX_PREFIX}area:${region.id}:${w}x${h}`;
      if (FireEngine._alreadyPlaying(name)) {
        console.log(`${LOG} | the fire on "${region.name ?? region.id}" is already drawn at `
          + `${w}x${h} pixels; nothing to do.`);
        return;
      }
      // The fire may have grown since it was drawn. The old, smaller picture goes,
      // or it sits underneath the new one for the rest of the scene.
      FireEngine._endFx(`${FX_PREFIX}area:${region.id}:*`);

      // The 10x10 foot asset has more in it to stretch; use it once the area is
      // bigger than a single square in either direction.
      const bigEnough = (w >= gs * 2) || (h >= gs * 2);
      const picture = bigEnough ? (await FireEngine._flamePath(true)) ?? path : path;

      const centre = { x: bounds.x + w / 2, y: bounds.y + h / 2 };
      /* ⚠️ NOT SWALLOWED, AND NOT REPORTED UNTIL IT STARTS. This was
         `.catch(() => {})`, so a picture Sequencer refused to play failed in total
         silence. Raced against a timer so a Sequencer that never settles cannot
         hold up a fire that is already burning in the rules. */
      /* ⚠️🔴 THE FLAME IS MASKED TO THE STAMPED SQUARES, SOFTLY (his rule,
         2026-10-07: "The flame is the Sequencer clip, masked to those squares.
         The mask uses this fade. It is not a hard cut. An unstamped square stays
         out, and a burned square stays fully on fire.").

         One picture over the bounding box, and the mask is hung on it by every
         client as the clip appears, in `_softMaskFlame` below, off Sequencer's
         own `createSequencerEffect` hook. It is not `.mask(region.uuid)` any
         more: that was a hard cut from the region's polygons, and he has ruled a
         hard cut out. Sequencer's shape masks are flat too, so the fade has to be
         a sprite with real alpha, which is what each client builds for itself. */
      const play = Promise.resolve(new Sequence().effect()
        .file(picture).atLocation(centre)
        .persist().name(name)
        .size({ width: w, height: h })
        .opacity(0.85).fadeIn(400).fadeOut(600)
        .play()).then(() => true, err => {
          console.warn(`${LOG} | the fire on "${region.name ?? region.id}" failed to play `
            + `("${picture}"):`, err);
          return false;
        });

      const started = await Promise.race([
        play,
        new Promise(r => setTimeout(() => r(null), 5000)),
      ]);

      // ⚠️ SAID OUT LOUD EVERY RUN (his rule, 2026-10-05: "Print how many flames
      // were placed. If the count is zero, say why.").
      const feet = (px) => Math.round(px / (gs / (canvas?.scene?.grid?.distance ?? 5)));
      if (started === false) {
        console.warn(`${LOG} | NO FLAMES on "${region.name ?? region.id}": 0 placed. `
          + `Sequencer refused the picture "${picture}". The area is still burning; only the `
          + `picture is missing.`);
      } else {
        console.log(`${LOG} | flames on "${region.name ?? region.id}": 1 placed, one picture `
          + `across the whole area, ${feet(w)}x${feet(h)} feet`
          + `${started == null ? " (still starting)" : ""}. Picture: ${picture}`);
      }
    } catch (err) {
      console.warn(`${LOG} | could not draw the flames on this area:`, err);
    }
  }

  /**
   * Hang the fire's soft mask on a flame clip, on this client.
   *
   * His rule, 2026-10-07: "The flame is the Sequencer clip, masked to those
   * squares. The mask uses this fade. It is not a hard cut. An unstamped square
   * stays out, and a burned square stays fully on fire. The orange time label is
   * not the flame and does not change."
   *
   * ⚠️ WHY NOT SEQUENCER'S OWN MASK. `.mask(region)` cuts hard along the region's
   * polygons, and a `.shape()` with `isMask` is a flat graphic: neither can carry
   * a fade. Its MaskFilter DOES multiply by the mask's rendered alpha, but the
   * only way in is a document, and a tile with a gradient texture would be a
   * visible white blob on the map. So the mask is a sprite built from a canvas
   * and set as a PIXI sprite mask on the effect's own sprite container, which
   * PIXI applies by alpha. Each client does this for its own copy of the clip.
   *
   * ⚠️ A FILLED BOX NEEDS NO MASK and gets none: `fireMaskCanvas` returns null
   * for it, so a sixty-foot square fire is the plain clip.
   */
  static async _softMaskFlame(effect) {
    const name = String(effect?.data?.name ?? "");
    const prefix = `${FX_PREFIX}area:`;
    if (!name.startsWith(prefix)) return;
    const regionId = name.slice(prefix.length).split(":")[0];

    // The region reaches this client by Foundry's broadcast and the clip by
    // Sequencer's; they are not ordered. A short wait is honest; a long one is a
    // flame that never got its mask, and that is said.
    let region = null;
    for (let i = 0; i < 40 && !region; i++) {
      region = canvas?.scene?.regions?.get(regionId) ?? null;
      if (!region) await new Promise(r => setTimeout(r, 50));
    }
    if (!region) {
      console.warn(`${LOG} | a flame appeared for region ${regionId} and that region never `
        + `arrived on this client, so the flame covers its whole box here.`);
      return;
    }

    const { FirePaint } = await import("./fire-paint.mjs");
    const built = FirePaint.fireMaskCanvas(region);
    if (!built) return;                           // a filled box: nothing to hide

    // The sprite container is made a frame or two after the effect; wait for it.
    let holder = null;
    for (let i = 0; i < 40 && !holder; i++) {
      holder = effect?.spriteContainer ?? null;
      if (!holder) await new Promise(r => setTimeout(r, 50));
    }
    if (!holder || holder.destroyed) {
      console.warn(`${LOG} | the flame on "${region.name ?? regionId}" has no sprite container `
        + `to mask, so it covers its whole box on this client.`);
      return;
    }

    try {
      const tex = PIXI.Texture.from(built.canvas);
      const mask = new PIXI.Sprite(tex);
      // The clip is centred on the effect and stretched to the box; the mask
      // sits over it in the same local space, corner to corner.
      mask.width = built.width;
      mask.height = built.height;
      mask.position.set(-built.width / 2, -built.height / 2);
      mask.name = `${name}:mask`;
      holder.addChild(mask);
      holder.mask = mask;
      console.log(`${LOG} | the flame on "${region.name ?? regionId}" is masked to its stamped `
        + `squares on this client (${built.width}x${built.height}px, soft).`);
    } catch (err) {
      console.warn(`${LOG} | the flame's mask could not be applied, so it covers its whole box `
        + `on this client:`, err);
    }
  }

  /** Smoke that keeps rising off a pile of ash. */
  static async _drawSmoke(doc) {
    if (!FireEngine._isActiveGM()) return;
    try {
      if (typeof Sequence === "undefined" || !globalThis.Sequencer?.EffectManager) return;
      const name = `${FX_PREFIX}ash:${doc.id}`;
      if (FireEngine._alreadyPlaying(name)) return;
      const path = await FireEngine._smokePath();
      if (!path) {
        console.warn(`${LOG} | there is ash where ${doc?.name} was and no smoke picture could be `
          + `found, so nothing is drawn on it.`);
        return;
      }
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
    /* Time moving is the only thing that puts a fire out.
       ⚠️ A JUMP IS ALSO ONE POPUP (his rule, 2026-10-06). Six seconds is a combat
       round billing itself and nobody wants a dialog for that; anything longer is
       him advancing the clock deliberately, and that gets exactly one popup for
       the whole advance however far it went. */
    Hooks.on("updateWorldTime", (_worldTime, delta) => {
      FireEngine.tick().catch(err => console.warn(`${LOG} | tick failed:`, err));
      const jumped = Math.abs(Number(delta) || 0);
      if (jumped <= 6) return;
      if (FireEngine._inCombat()) return;      // the turn-start check owns a fight
      FireEngine._clockJumpCheck(jumped)
        .catch(err => console.warn(`${LOG} | the clock-jump check threw:`, err));
    });

    // ⚠️ COMBAT ROUNDS ADVANCE THE CLOCK, BUT NOT ALWAYS BY THIS ROUTE. The
    // clock bills six seconds a round itself; this is here so a fire still
    // burns down on a table that has the clock's combat billing switched off.
    Hooks.on("updateCombat", (combat, changes) => {
      if (changes?.round === undefined && changes?.turn === undefined) return;
      FireEngine.tick().catch(err => console.warn(`${LOG} | combat tick failed:`, err));
      // The creature whose turn just began, if it is alight: one check.
      FireEngine._combatTurnCheck(combat)
        .catch(err => console.warn(`${LOG} | the turn-start check threw:`, err));
    });

    // Out of combat, the six-second wall clock. It stands itself down in a fight.
    FireEngine._startRealClock();

    /* ⚠️ THE PAUSE FREEZES THE SIX SECONDS, IT DOES NOT RESET THEM (his rule,
       2026-10-06). Everything that asks for a check is refused while paused by the
       guard inside `tryToPutOut`; this is the half that makes the pause cost
       nothing, by keeping each creature's remainder and handing it back. */
    Hooks.on("pauseGame", (paused) => {
      try {
        if (paused) FireEngine._freezeChecks();
        else FireEngine._thawChecks();
      } catch (err) {
        console.warn(`${LOG} | the pause could not be applied to the burning creatures:`, err);
      }
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
      try {
        FireEngine._endFx(`${FX_PREFIX}area:${region.id}:*`);
        FireEngine._clearTimer(region.id);
      } catch (err) {
        console.warn(`${LOG} | could not clear the flames off a deleted area:`, err);
      }
    });

    /* ⚠️ A FIRE THAT SPREAD MOVED ITS OWN MIDDLE. `_spread` rewrites the shape, so
       the label has to follow it or it ends up sitting outside the fire it belongs
       to. Every client repaints, because every GM has their own labels. */
    Hooks.on("updateRegion", (region, changes) => {
      try {
        if (!region.flags?.[FLAG_NS]?.fire && changes?.flags === undefined) return;
        FireEngine._paintTimers();
      } catch (err) {
        console.warn(`${LOG} | could not move the clock with a spreading fire:`, err);
      }
    });

    /* ⚠️ EVERY CLIENT HANGS THE FIRE'S SOFT MASK ON THE CLIP AS IT APPEARS. The
       effect is created on each screen by Sequencer's own broadcast, so the mask
       cannot be set once by the GM; each client reads the region's squares, draws
       its own mask canvas, and masks its own copy of the clip. */
    Hooks.on("createSequencerEffect", (effect) => {
      FireEngine._softMaskFlame(effect)
        .catch(err => console.warn(`${LOG} | could not mask a flame to its squares:`, err));
    });

    /* ⚠️ THE BRUSH BELONGS TO THE OLD CANVAS. Its cursor and its three listeners
       are attached to a stage that a scene change destroys, so a session left
       running across one would paint squares onto a scene he is not looking at. */
    onCanvasReady(() => {
      import("./fire-paint.mjs")
        .then(({ FirePaint }) => FirePaint.stop({ quiet: true }))
        .catch(err => console.warn(`${LOG} | could not put the fire brush away:`, err));
    });

    // Flames and smoke are drawn per client and are lost on a scene change.
    onCanvasReady( () => {
      FireEngine.redrawAll()
        .catch(err => console.warn(`${LOG} | could not redraw the fires on this scene:`, err));
    });

    // ── The button ──
    //
    // ⚠️ A BUTTON, NOT ONLY A CONSOLE COMMAND. He asked for "a button, a macro,
    // or something", and a feature reachable only by typing is a feature he will
    // not use mid-session. Both array and object tool shapes are handled because
    // Foundry changed that structure between versions and picking one would make
    // the button silently absent on the other.
    // ⚠️🔴 V13 FIRES `getSceneControlButtons` ONCE, AT INIT. This hook used
    // to be registered here, inside register(), which runs at READY — after
    // that event has already been and gone. So the three fire tools were never
    // added to the toolbar at all, and no amount of fixing their icons or their
    // order was ever going to make them appear.
    //
    // `quick-select-tools.mjs` states this in its own header and does it the
    // only way that works: register the hook at MODULE LOAD, and also inject
    // straight into the already-built controls after ready. Its buttons appear;
    // mine did not; the difference was entirely this.
    FireEngine._injectPostReady();

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

      // The size the first fuel in the list starts on, so the row he never
      // touches is already the sensible one for what he picked.
      const firstFuel = Object.keys(FUELS)
        .filter(id => burningBodies ? id === "body" : id !== "body")[0] ?? "debris";
      const sizeRows = AREA_SIZES.map(ft => `
          <label style="display:flex;gap:7px;align-items:center;padding:6px 10px;
                        border-radius:5px;cursor:pointer;">
            <input type="radio" name="ace-across" value="${ft}"
                   ${ft === (DEFAULT_ACROSS[firstFuel] ?? 20) ? "checked" : ""}>
            <span style="font-size:16px;color:#f0e4c0;">${ft} ft</span>
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
              : "Press Light it and the fire goes straight onto your cursor. Move it where you want, click to drop it, right-click to back out. What you pick here decides how long it burns and how far it runs."}
          </div>

          <div style="font-size:16px;font-weight:700;color:#d4af37;margin:6px 0 2px 0;">
            What is burning
          </div>
          <div style="border:1px solid #4a3a28;border-radius:6px;padding:4px;">${fuelRows}</div>

          <div style="font-size:16px;font-weight:700;color:#d4af37;margin:14px 0 2px 0;">
            What lit it
          </div>
          <div style="border:1px solid #4a3a28;border-radius:6px;padding:4px;">${litRows}</div>

          ${burningBodies ? "" : `
          <div style="font-size:16px;font-weight:700;color:#d4af37;margin:14px 0 2px 0;">
            How big, across
          </div>
          <div style="border:1px solid #4a3a28;border-radius:6px;padding:4px;
                      display:flex;flex-wrap:wrap;gap:4px;">${sizeRows}</div>`}

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
              const _fuel = root.querySelector('input[name="ace-fuel"]:checked')?.value ?? "debris";
              picked = {
                fuel: _fuel,
                ignition: root.querySelector('input[name="ace-lit"]:checked')?.value ?? "torch",
                acrossFt: Number(root.querySelector('input[name="ace-across"]:checked')?.value)
                  || DEFAULT_ACROSS[_fuel] || 20,
              };
              return true;
            } },
          { action: "cancel", label: "Cancel" },
        ],
        rejectClose: false,
      }).catch(() => null);

      if (!ok || ok === "cancel" || !picked) return;

      /* ⚠️🔴 A TORCH DOES NOT LIGHT STONE, NOT EVEN FOR A MOMENT (his rule,
         2026-10-06). Bare stone used to burn for two minutes off a torch because
         the fuel table gave every fuel a duration. It does not catch at all: the
         only thing that burns on bare ground is what was thrown at it, which is
         what the oil flask and the spell rows are. Refused out loud, with the
         thing to change, rather than lighting a fire that should not exist. */
      if (picked.fuel === "stone" && picked.ignition === "torch") {
        const msg = "A torch does not light bare stone. Pick an oil flask, a spell, "
          + "or a fuel that actually burns.";
        console.log(`${LOG} | refused: ${msg}`);
        ui.notifications?.warn(`ACE: ${msg}`);
        return;
      }

      if (burningBodies) {
        for (const token of targets) await FireEngine.igniteToken(token.document, picked);
        return;
      }

      /* ⚠️🔴 A SQUARE BRUSH, NOT A TEMPLATE (his rule, 2026-10-06: "Clicking a
         tile does not light the whole tile... The cursor is one 5-foot square.
         Left click lights that square. Right click puts that square out. Escape
         means done, and the sheet comes back.").

         The template preview this replaces lit one circle and ended on the first
         click, which meant a twenty-foot rug caught all at once and there was no
         way to light a corner of it, the square beside it, and then the door. The
         brush stays up until Escape and a fire is the set of squares he painted. */
      const { FirePaint } = await import("./fire-paint.mjs");
      await FirePaint.start(picked);
    } catch (err) {
      console.error(`${LOG} | the fire prompt failed:`, err);
      ui.notifications?.error("ACE: the fire dialog would not open, see the console.");
    }
  }



  /**
   * ⚠️ EVERY CLIENT DRAWS, ONLY THE GM STARTS. A player joining mid-session, or
   * anyone changing scene, has no Sequencer effects for fires that were lit
   * before they arrived — the same "cards drawn before the handler registered"
   * shape that leaked GM controls to a player on 2026-08-07.
   */
  static async redrawAll() {
    const sayNo = (what) => (err) => console.warn(`${LOG} | could not redraw ${what}:`, err);
    for (const tokenDoc of (canvas?.scene?.tokens ?? [])) {
      if (tokenDoc.flags?.[FLAG_NS]?.fire) {
        FireEngine._drawTokenFlame(tokenDoc).catch(sayNo(`the flames on ${tokenDoc.name}`));
      } else if (tokenDoc.flags?.[FLAG_NS]?.isAsh) {
        FireEngine._drawSmoke(tokenDoc).catch(sayNo(`the smoke on ${tokenDoc.name}`));
      }
    }
    /* ⚠️ AND AGAIN FROM HERE (his rule). This runs on canvasReady, by which time
       every region is drawn, so it is the second chance for a fire whose region
       was not on the canvas when it was lit. Awaited one at a time so a scene
       full of fires does not start thirty waits at once. */
    for (const region of (canvas?.scene?.regions ?? [])) {
      if (!region.flags?.[FLAG_NS]?.fire) continue;
      try { await FireEngine._drawAreaFlames(region); }
      catch (err) { console.warn(`${LOG} | could not redraw the flames on an area:`, err); }
    }
    // ⚠️ THE LABELS BELONG TO THE OLD CANVAS. A scene change destroys the
    // container they were added to, so they are rebuilt here rather than reused.
    FireEngine.clearTimers();
    FireEngine._paintTimers();
  }
}
