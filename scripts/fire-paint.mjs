/* ═══════════════════════════════════════════════════════════════════════════
   FIRE, PAINTED BY THE SQUARE
   ═══════════════════════════════════════════════════════════════════════════

   His build, 2026-10-06:

     "Clicking a tile does not light the whole tile, and a tile is never a body.
      A rug, a crate, a barrel, a cart, and a vortex are tiles. The fire button
      gets the open sheet out of the way, the way placing Lightning Bolt does.
      The cursor is one 5-foot square. Left click lights that square. Right click
      puts that square out. Escape means done, and the sheet comes back. This
      works on a tile and on the open floor. One flame covers the squares that
      are lit."

   ⚠️🔴 A FIRE IS A SET OF SQUARES, NOT A CIRCLE. Until now an area fire was one
   region shaped like the template that made it, and clicking a twenty-foot rug
   set the whole rug alight. Fire does not work that way at a table: a corner of
   the rug catches. So the fire is a set of five-foot squares he paints, the
   region is the union of them, and ONE flame covers the lot however many there
   are. A square is the unit for everything: what catches, what spreads, and what
   a right-click puts out.

   ⚠️ IT DOES NOT GUESS WHAT ANYTHING IS MADE OF. His rule: "It does not guess
   what the next tile is made of... Do not try to tell wood walls from stone
   walls. Foundry does not know, and this build does not teach it." A tile is a
   tile, a door is a door, and the painted map is not fuel. The only thing that
   decides how a fire behaves is the fuel HE picked in the dialog.

   The engine's rules live in fire-engine.mjs and are reached through dynamic
   imports, never a top-level one: these two files need each other and a cyclic
   binding read at load is what killed a whole module on 2026-09-06.
   ═══════════════════════════════════════════════════════════════════════════ */

const MODULE_ID = "ace-qol";
const FLAG_NS = "ace-qol";
const LOG = `${MODULE_ID} | Fire`;

/**
 * How long a burning tile takes to reach what it is touching, and how long a
 * burning door takes to fall open.
 *
 * His rule, 2026-10-06: "A tile that has been burning for 10 minutes catches the
 * next tile touching its edge... The square a door sits in lights that door. It
 * burns for 10 minutes, then opens and stays open." One number, both jobs, and
 * it is the same ten minutes whether the door was lit directly or caught from a
 * neighbour: "A door that caught from a neighbouring tile uses that same 10
 * minutes, starting when it caught."
 */
export const CATCH_SECONDS = 10 * 60;

/**
 * The soot picture. His file, by name, found on disk.
 *
 * ⚠️🔴 THIS IS THE PICTURE, NOT A GUESS AT ONE (his rule, 2026-10-06: "The file
 * sitting loose in the ace-qol assets folder, named ash-debris, is the picture.
 * Find that file. Do not invent a path, and do not keep looking for soot.webp").
 * The previous code looked for two files called soot that nobody had ever made,
 * found neither, and drew a flat grey rectangle instead - which is how his burned
 * squares came out as grey boxes.
 */
const SOOT_ART = `modules/${MODULE_ID}/Assets/ash-debris.png`;

/* ═══ Squares ══════════════════════════════════════════════════════════════ */

export class FirePaint {

  static get _gs() { return canvas?.grid?.size ?? 100; }

  static get _ftPerSquare() { return Number(canvas?.scene?.grid?.distance) || 5; }

  /** The one spelling of a square, so two readers can never disagree about it. */
  static key(x, y) { return `${Math.round(x)},${Math.round(y)}`; }

  static fromKey(k) {
    const [x, y] = String(k).split(",").map(Number);
    return { x, y };
  }

  /** The square a point falls in, as its top-left corner. */
  static snap(point) {
    const tl = canvas?.grid?.getTopLeftPoint?.({ x: point.x, y: point.y });
    if (tl) return { x: Math.round(tl.x), y: Math.round(tl.y) };
    const gs = FirePaint._gs;
    return { x: Math.floor(point.x / gs) * gs, y: Math.floor(point.y / gs) * gs };
  }

  /**
   * The block of squares under the cursor, CENTRED on it.
   *
   * ⚠️ CENTRED, NOT ANCHORED TOP-LEFT. At five feet the two are the same square,
   * which is the case he cares about; at sixty feet an anchored block hangs down
   * and to the right of the pointer and there is no way to aim it.
   */
  static blockAt(point, acrossFt) {
    const gs = FirePaint._gs;
    const n = Math.max(1, Math.round((Number(acrossFt) || 5) / FirePaint._ftPerSquare));
    const anchor = FirePaint.snap(point);
    const back = Math.floor((n - 1) / 2);
    const out = [];
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        out.push({ x: anchor.x + (i - back) * gs, y: anchor.y + (j - back) * gs });
      }
    }
    return out;
  }

  /** The rectangle one square covers. */
  static rectOf(square) {
    const gs = FirePaint._gs;
    return { x: square.x, y: square.y, width: gs, height: gs };
  }

  /**
   * Every square a rectangle touches.
   *
   * ⚠️ THIS IS HOW A CAUGHT TILE JOINS THE FIRE THAT LIT IT, and it is the whole
   * reason the fire does not gain neighbours: the tile's squares are added to the
   * one region, so the one flame over it is simply redrawn bigger. A second effect
   * on the new tile would be exactly the "neighbours" he has now ruled out twice.
   */
  static squaresOf(rect) {
    const gs = FirePaint._gs;
    const out = [];
    if (!(rect?.width > 0 && rect?.height > 0)) return out;
    const first = FirePaint.snap({ x: rect.x, y: rect.y });
    const last = FirePaint.snap({ x: rect.x + rect.width - 1, y: rect.y + rect.height - 1 });
    // A tile the size of a map is not a reason to write ten thousand shapes into
    // one region; past this it is the bounding block and the console says so.
    const cols = Math.round((last.x - first.x) / gs) + 1;
    const rows = Math.round((last.y - first.y) / gs) + 1;
    if (cols * rows > 400) {
      console.warn(`${LOG} | that burning thing covers ${cols}x${rows} squares, which is more `
        + `than this will put into one fire. Its outer block is used instead.`);
    }
    for (let x = first.x; x <= last.x; x += gs) {
      for (let y = first.y; y <= last.y; y += gs) {
        out.push({ x, y });
        if (out.length >= 400) return out;
      }
    }
    return out;
  }

  /** Do these two rectangles touch at all? */
  static _overlaps(a, b) {
    return (a.x < b.x + b.width) && (a.x + a.width > b.x)
        && (a.y < b.y + b.height) && (a.y + a.height > b.y);
  }

  /* ═══ What is standing in a square ═══════════════════════════════════════ */

  /**
   * ⚠️ A CREATURE IS A CREATURE BECAUSE IT IS A TOKEN (his rule, 2026-10-06:
   * "A creature is a creature because it is a token. Choosing one and lighting it
   * burns the whole body. Do not put the square cursor on it."). So a token found
   * under a painted square is handed to the body rule whole, never treated as a
   * patch of ground.
   */
  static tokensIn(square, scene = null) {
    const sc = scene ?? canvas?.scene;
    const rect = FirePaint.rectOf(square);
    const out = [];
    for (const doc of (sc?.tokens ?? [])) {
      const gs = FirePaint._gs;
      const box = { x: doc.x, y: doc.y, width: (doc.width ?? 1) * gs, height: (doc.height ?? 1) * gs };
      if (FirePaint._overlaps(rect, box)) out.push(doc);
    }
    return out;
  }

  /** Every tile this square touches. A rug, a crate, a barrel, a cart, a vortex. */
  static tilesIn(square, scene = null) {
    const sc = scene ?? canvas?.scene;
    const rect = FirePaint.rectOf(square);
    const out = [];
    for (const doc of (sc?.tiles ?? [])) {
      const box = { x: doc.x, y: doc.y, width: doc.width, height: doc.height };
      if (FirePaint._overlaps(rect, box)) out.push(doc);
    }
    return out;
  }

  /**
   * Every door whose line passes through this square.
   *
   * ⚠️ DOORS ONLY, NEVER WALLS (his rule: "Do not use the wall tool. Do not treat
   * any door as sturdy. Do not try to tell wood walls from stone walls."). A wall
   * is scenery this build has no opinion about; a door is a thing that can swing
   * open, which is the only reason it is here.
   */
  static doorsIn(square, scene = null) {
    const sc = scene ?? canvas?.scene;
    const rect = FirePaint.rectOf(square);
    const out = [];
    for (const doc of (sc?.walls ?? [])) {
      if (!doc.door) continue;                          // 0 is not a door
      const [x1, y1, x2, y2] = doc.c ?? [];
      if (![x1, y1, x2, y2].every(Number.isFinite)) continue;
      // The segment's own box first, which is cheap and rejects almost everything.
      const seg = {
        x: Math.min(x1, x2), y: Math.min(y1, y2),
        width: Math.abs(x2 - x1) || 1, height: Math.abs(y2 - y1) || 1,
      };
      if (!FirePaint._overlaps(rect, seg)) continue;
      // Then the line itself, sampled, so a long diagonal door does not catch
      // every square of its bounding box.
      const n = 24;
      let inside = false;
      for (let i = 0; i <= n && !inside; i++) {
        const t = i / n;
        const px = x1 + (x2 - x1) * t;
        const py = y1 + (y2 - y1) * t;
        inside = px >= rect.x && px <= rect.x + rect.width
              && py >= rect.y && py <= rect.y + rect.height;
      }
      if (inside) out.push(doc);
    }
    return out;
  }

  /* ═══ The brush ════════════════════════════════════════════════════════════ */

  static _live = null;

  /**
   * The square cursor.
   *
   * His rule, 2026-10-06: "The fire button gets the open sheet out of the way,
   * the way placing Lightning Bolt does. The cursor is one 5-foot square. Left
   * click lights that square. Right click puts that square out. Escape means
   * done, and the sheet comes back."
   *
   * ⚠️ IT STAYS UP UNTIL ESCAPE. A template preview ends on the first click,
   * which is right for a spell and wrong for painting: he is lighting a corner of
   * a rug, then the next square, then the door beside it. One session, as many
   * clicks as he likes, and the only thing that ends it is Escape.
   */
  static async start(opts = {}) {
    FirePaint.stop({ quiet: true });
    if (!canvas?.ready) {
      ui.notifications?.warn("ACE: no scene is open, so there is nothing to set alight.");
      return false;
    }

    const acrossFt = Number(opts.acrossFt) || 5;
    const gs = FirePaint._gs;
    const n = Math.max(1, Math.round(acrossFt / FirePaint._ftPerSquare));

    // ── The sheet gets out of the way, the way a template does ──
    const minimised = [];
    for (const app of Object.values(ui.windows ?? {})) {
      try {
        if (app?._minimized) continue;
        if (!(app?.document?.documentName === "Actor" || app?.actor || app?.object?.actor)) continue;
        await app.minimize?.();
        minimised.push(app);
      } catch (_) { /* a window that will not minimise is not a reason to stop */ }
    }
    for (const app of foundry.applications?.instances?.values?.() ?? []) {
      try {
        if (app?.minimized || app?._minimized) continue;
        if (!(app?.document?.documentName === "Actor" || app?.actor)) continue;
        await app.minimize?.();
        minimised.push(app);
      } catch (_) { /* same */ }
    }

    // ── The cursor itself ──
    const cursor = new PIXI.Graphics();
    cursor.eventMode = "none";
    cursor.zIndex = 1200;
    const paint = (ok = true) => {
      cursor.clear();
      cursor.lineStyle(3, ok ? 0xff6b3d : 0x9a9aa2, 0.95);
      cursor.beginFill(ok ? 0xe06010 : 0x55555e, 0.22);
      cursor.drawRect(0, 0, gs * n, gs * n);
      cursor.endFill();
    };
    paint(true);
    try { canvas.interface.addChild(cursor); }
    catch (_) { try { canvas.tokens.addChild(cursor); } catch (_) { /* no layer */ } }

    const place = (point) => {
      const block = FirePaint.blockAt(point, acrossFt);
      const minX = Math.min(...block.map(s => s.x));
      const minY = Math.min(...block.map(s => s.y));
      cursor.position.set(minX, minY);
    };

    const onMove = (event) => {
      try { place(event.data.getLocalPosition(canvas.stage)); }
      catch (_) { /* a move with no position is nothing to draw */ }
    };
    const onUp = (event) => {
      const button = event?.data?.originalEvent?.button;
      if (button !== 0) return;                       // left only; right is the menu
      event.stopPropagation?.();
      const point = event.data.getLocalPosition(canvas.stage);
      FirePaint._lightAt(point, acrossFt, opts)
        .catch(err => console.error(`${LOG} | could not light that square:`, err));
    };
    const onRight = (event) => {
      event.preventDefault?.();
      event.stopPropagation?.();
      const point = canvas.mousePosition ?? FirePaint._live?.last ?? null;
      if (!point) return false;
      FirePaint._douseAt(point, acrossFt)
        .catch(err => console.error(`${LOG} | could not put that square out:`, err));
      return false;
    };
    const onKey = (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      FirePaint.stop();
    };

    // ⚠️ THE POINTER IS READ FROM THE CANVAS FOR A RIGHT-CLICK, because a
    // contextmenu event on the view element carries page coordinates, not scene
    // ones, and converting them by hand is a second answer to a question
    // `canvas.mousePosition` already answers.
    canvas.stage.on("mousemove", onMove);
    canvas.stage.on("mouseup", onUp);
    const priorContext = canvas.app.view.oncontextmenu;
    canvas.app.view.oncontextmenu = onRight;
    window.addEventListener("keydown", onKey, true);

    FirePaint._live = { cursor, onMove, onUp, onRight, onKey, priorContext, minimised, opts, acrossFt };

    const word = n === 1 ? "square" : `${acrossFt} foot block`;
    ui.notifications?.info(`Fire brush on: left click lights a ${word}, right click puts it out, `
      + `Escape when you are done.`, { permanent: false });
    console.log(`${LOG} | the brush is up: ${acrossFt} ft (${n}x${n} squares), `
      + `fuel "${opts.fuel}", lit by "${opts.ignition}".`);
    return true;
  }

  /** Put the brush away and give him his sheet back. */
  static stop({ quiet = false } = {}) {
    const live = FirePaint._live;
    FirePaint._live = null;
    if (!live) return;
    try { canvas?.stage?.off?.("mousemove", live.onMove); } catch (_) { /* gone with the canvas */ }
    try { canvas?.stage?.off?.("mouseup", live.onUp); } catch (_) { /* same */ }
    try { if (canvas?.app?.view) canvas.app.view.oncontextmenu = live.priorContext ?? null; }
    catch (_) { /* same */ }
    try { window.removeEventListener("keydown", live.onKey, true); } catch (_) { /* same */ }
    try { live.cursor?.destroy?.(); } catch (_) { /* same */ }
    for (const app of (live.minimised ?? [])) {
      try { app.maximize?.(); } catch (_) { /* he can restore it himself */ }
    }
    if (!quiet) {
      console.log(`${LOG} | the brush is down.`);
      ui.notifications?.info("Fire brush off.");
    }
  }

  static get running() { return !!FirePaint._live; }

  static async _lightAt(point, acrossFt, opts) {
    const { FireEngine } = await import("./fire-engine.mjs");
    await FireEngine.lightSquares(FirePaint.blockAt(point, acrossFt), opts);
  }

  static async _douseAt(point, acrossFt) {
    const { FireEngine } = await import("./fire-engine.mjs");
    await FireEngine.douseSquares(FirePaint.blockAt(point, acrossFt));
  }

  /* ═══ The slow burn: tiles reaching what they touch, doors falling open ════ */

  /**
   * Ten minutes on, a burning tile reaches whatever its edge is against.
   *
   * His rule, 2026-10-06: "A tile that has been burning for 10 minutes catches
   * the next tile touching its edge. Anything else touching that edge, including
   * a door, catches then too. Empty floor does not. The painted map does not."
   *
   * ⚠️ FLOOR IS NOT FUEL. A fire does not creep across bare ground here, and the
   * scene's background image is a picture, not a thing. Only a real document - a
   * tile or a door - can catch, which is also why this cannot run away across a
   * map: it is limited by what somebody actually placed.
   */
  static async tickSlowBurn(now) {
    const scene = canvas?.scene;
    if (!scene) return;

    for (const tile of [...(scene.tiles ?? [])]) {
      const rec = tile.flags?.[FLAG_NS]?.fire;
      if (!rec?.caughtAt) continue;
      if (rec.spread) continue;                          // it has already reached out
      if (now - rec.caughtAt < CATCH_SECONDS) continue;

      try {
        await tile.update({ [`flags.${FLAG_NS}.fire.spread`]: true });
        const caught = await FirePaint._reachOut(tile, rec, now);
        console.log(`${LOG} | the fire on "${tile.texture?.src ?? tile.id}" has been burning for `
          + `ten minutes and reached ${caught.length
            ? caught.join(", ")
            : "nothing - there is no other tile or door against its edge"}.`);
        /* ⚠️ TEN MINUTES IS WHAT IT HAD. The tile has burned: it leaves the stain,
           its own fire ends, and what it reached carries the fire on from there.
           His rule: "What burned leaves soot... The tile stays." So the stain goes
           OVER it and nothing is deleted. */
        await FirePaint.soot({ x: tile.x, y: tile.y, width: tile.width, height: tile.height },
          "a tile");
        await tile.update({ [`flags.${FLAG_NS}.-=fire`]: null });
      } catch (err) {
        console.warn(`${LOG} | a burning tile could not reach what it is touching:`, err);
      }
    }

    for (const wall of [...(scene.walls ?? [])]) {
      const rec = wall.flags?.[FLAG_NS]?.fire;
      if (!rec?.caughtAt || rec.burnedThrough) continue;
      if (now - rec.caughtAt < CATCH_SECONDS) continue;
      try {
        await wall.update({
          ds: CONST.WALL_DOOR_STATES.OPEN,
          [`flags.${FLAG_NS}.fire.burnedThrough`]: true,
        });
        // ⚠️ SAID OUT LOUD, IN THE CHAT, because a door quietly opening on its
        // own is indistinguishable from a player opening it.
        console.log(`${LOG} | a door has burned through after ten minutes and is open.`);
        await FirePaint._say("A door has burned through. It is open, and it is staying open.");
        await FirePaint.soot(FirePaint._wallRect(wall), "a door");
      } catch (err) {
        console.warn(`${LOG} | a burning door could not burn through:`, err);
      }
    }
  }

  /** Everything whose edge this tile is against, set alight. */
  static async _reachOut(tile, rec, now) {
    const scene = tile.parent ?? canvas?.scene;
    const pad = Math.max(2, Math.round(FirePaint._gs * 0.05));
    const box = {
      x: tile.x - pad, y: tile.y - pad,
      width: tile.width + pad * 2, height: tile.height + pad * 2,
    };
    const names = [];

    for (const other of (scene?.tiles ?? [])) {
      if (other.id === tile.id) continue;
      if (other.flags?.[FLAG_NS]?.fire?.caughtAt) continue;
      const theirs = { x: other.x, y: other.y, width: other.width, height: other.height };
      if (!FirePaint._overlaps(box, theirs)) continue;
      await FirePaint.catchTile(other, rec, now, { join: true });
      names.push("a tile");
    }

    for (const wall of (scene?.walls ?? [])) {
      if (!wall.door) continue;
      if (wall.flags?.[FLAG_NS]?.fire?.caughtAt) continue;
      const seg = FirePaint._wallRect(wall);
      if (!FirePaint._overlaps(box, seg)) continue;
      await FirePaint.catchDoor(wall, rec, now, { join: true });
      names.push("a door");
    }

    return names;
  }

  static _wallRect(wall) {
    const [x1, y1, x2, y2] = wall.c ?? [0, 0, 0, 0];
    return {
      x: Math.min(x1, x2), y: Math.min(y1, y2),
      width: Math.abs(x2 - x1) || 4, height: Math.abs(y2 - y1) || 4,
    };
  }

  /**
   * A tile is alight: it burns, and in ten minutes it reaches its neighbours.
   *
   * @param {boolean} [join]  add the tile's squares to the fire, so the one flame
   *   grows over it. True when the fire reached it on its own; false when he
   *   painted the square that lit it, because that square is already in the fire.
   */
  static async catchTile(tile, opts, now, { join = false } = {}) {
    if (tile.flags?.[FLAG_NS]?.fire?.caughtAt) return false;
    await tile.update({
      [`flags.${FLAG_NS}.fire`]: {
        caughtAt: now,
        fuel: opts?.fuel ?? "debris",
        ignition: opts?.ignition ?? "torch",
        spread: false,
      },
    });
    if (join) {
      await FirePaint._join({ x: tile.x, y: tile.y, width: tile.width, height: tile.height }, opts);
    }
    return true;
  }

  /** A door is alight: ten minutes from now it falls open and stays open. */
  static async catchDoor(wall, opts, now, { join = false } = {}) {
    if (wall.flags?.[FLAG_NS]?.fire?.caughtAt) return false;
    await wall.update({
      [`flags.${FLAG_NS}.fire`]: {
        caughtAt: now,
        fuel: opts?.fuel ?? "debris",
        ignition: opts?.ignition ?? "torch",
        burnedThrough: false,
      },
    });
    if (join) await FirePaint._join(FirePaint._wallRect(wall), opts);
    console.log(`${LOG} | a door has caught. It burns through in ten minutes.`);
    return true;
  }

  /**
   * The squares of something that just caught, folded into the fire that lit it.
   *
   * ⚠️ `grow: true` MEANS THE SQUARES AND NOTHING ELSE. Going back through the
   * full lighting path would re-ask every square what is standing in it, so a
   * third tile overlapping the second would catch the same instant instead of ten
   * minutes later, and the chain would cross a room in one tick.
   */
  static async _join(rect, opts) {
    try {
      const squares = FirePaint.squaresOf(rect);
      if (!squares.length) return;
      const { FireEngine } = await import("./fire-engine.mjs");
      await FireEngine.lightSquares(squares, opts, { grow: true });
    } catch (err) {
      console.warn(`${LOG} | what just caught could not join the fire that lit it, so the `
        + `flame does not cover it:`, err);
    }
  }

  /** A tile or a door that is out again. */
  static async douseTile(tile) {
    if (!tile.flags?.[FLAG_NS]?.fire) return false;
    await tile.update({ [`flags.${FLAG_NS}.-=fire`]: null });
    return true;
  }

  static async douseDoor(wall) {
    if (!wall.flags?.[FLAG_NS]?.fire) return false;
    await wall.update({ [`flags.${FLAG_NS}.-=fire`]: null });
    return true;
  }

  /* ═══ Soot ═════════════════════════════════════════════════════════════════ */

  /**
   * What burned leaves a stain.
   *
   * His rule, 2026-10-06: "What burned leaves soot, gray and black, so it shows
   * on a black floor. The same stain for a chair, a door, or a tile. The tile
   * stays."
   *
   * ⚠️ THE TILE STAYS. The stain goes OVER what burned; nothing is deleted. A
   * burned rug is a burned rug, still on the floor, and deleting his scenery to
   * represent fire damage is not a thing this build gets to do.
   *
   * ⚠️ HIS PICTURE OR NOTHING. `ash-debris.png`, the file he put in the assets
   * folder, is the stain. When it is not on disk nothing is placed and the console
   * says which path is missing: a flat grey rectangle standing in for a picture is
   * what he was looking at on his map, and inventing a shape on his scenery is
   * worse than leaving the square clean.
   */
  static async soot(rect, what = "something") {
    return FirePaint.sootOver([rect], what);
  }

  /**
   * ONE STAIN FOR THE WHOLE FIRE.
   *
   * His rule, 2026-10-06: "When a fire burns out, all of its squares are one
   * stain, using ash-debris.png once. A filled square of any size, 5 feet or 60,
   * is one tile and that one picture stretched to fit. Nothing is cut. Any other
   * shape is still one tile, sized to the box around the burned squares, with that
   * same picture stretched across the whole box. A square inside the box that
   * never burned is left transparent, so the floor shows... It is not three copies
   * of the png."
   *
   * ⚠️🔴 THE FIRE IS PAINTED BY THE SQUARE. THE ASH IS NOT. The first version
   * dropped one copy of the picture on each burned square, which tiles the image
   * over and over and reads as wallpaper rather than a burn. A fire is one event
   * and it leaves one mark.
   *
   * ⚠️ TWO PATHS, AND THE COMMON ONE WRITES NOTHING. When the burned squares fill
   * their own bounding box - which every rectangle does, from one square to a
   * sixty-foot block - the picture needs no holes, so it is used straight from the
   * module folder, stretched by Foundry's own `fit: "fill"`. Only a ragged shape
   * needs the corners cut, and only then is an image composed and written.
   *
   * ⚠️ WHY A FILE AND NOT A DATA URL: `TextureData`'s `src` is a `FilePathField`
   * and that field's `base64` option defaults to false, which `TextureData` does
   * not override. Foundry rejects an inline image outright, so the cut-out has to
   * exist on disk to be a tile at all. It goes in the WORLD's folder, never the
   * module's, because the module folder is a git repository and his scenery is not
   * ACE's to commit.
   */
  static async sootOver(rects, what = "something") {
    try {
      if (!canvas?.scene) return null;
      const boxes = (rects ?? []).filter(r => r?.width > 0 && r?.height > 0);
      if (!boxes.length) return null;

      const x = Math.round(Math.min(...boxes.map(r => r.x)));
      const y = Math.round(Math.min(...boxes.map(r => r.y)));
      const right = Math.round(Math.max(...boxes.map(r => r.x + r.width)));
      const bottom = Math.round(Math.max(...boxes.map(r => r.y + r.height)));
      const width = right - x;
      const height = bottom - y;
      if (!(width > 0 && height > 0)) return null;

      /* ⚠️🔴 NOTHING ASKS PERMISSION TO PLACE THE STAIN (his find,
         2026-10-06: "The ash file is modules/ace-qol/Assets/ash-debris.png. It is
         there. A HEAD request returned 200. The burn-out is looking somewhere
         else, so nothing is placed.").

         There was a check here that asked whether the picture existed first. It
         called `_sootArtThere`, a helper the rewrite above it had deleted in the
         same edit, so every burn-out threw a TypeError into the catch at the
         bottom of this function and he got a warning and no stain. A caller left
         behind by its own callee, and the swallow is what hid it.

         It is not coming back as a working check either. The picture SHIPS WITH
         THE MODULE at the one path above; if it is ever missing that is a broken
         install, and Foundry's own texture loader says so on the canvas. A gate
         that can answer "no" is a gate that can refuse a fire its stain for a
         reason he cannot see from the table. */

      // Already stained, corner to corner: a reload mid-burn must not double it.
      const already = (canvas.scene.tiles ?? []).some(t => t.flags?.[FLAG_NS]?.soot
        && Math.round(t.x) === x && Math.round(t.y) === y
        && Math.round(t.width) === width && Math.round(t.height) === height);
      if (already) return null;

      // Does the burned ground fill its own box? Then no holes are needed.
      // ⚠️ ROUNDED LIKE THE BOX. A tile at x 10.4 and width 100.3 summed to an
      // area a few pixels short of its own rounded box and was sent through the
      // cut-out as a one-square shape with no hole, which wrote an all-255 png
      // for nothing (found by the adversarial pass, 2026-10-07).
      const area = boxes.reduce((n, r) => n + (Math.round(r.width) * Math.round(r.height)), 0);
      const filled = Math.abs(area - (width * height)) < 1;
      const src = filled
        ? SOOT_ART
        : (await FirePaint._cutOut(boxes, { x, y, width, height })) ?? SOOT_ART;

      /* ⚠️ AN ORDINARY TILE (his rule: "The tile tool selects it, and Delete
         removes the whole stain. No new button."). Unlocked and visible are
         Foundry's own defaults and are written out anyway, because the whole point
         is that he can click it and press Delete without ACE being involved.
         `fit: "fill"` is the stretch: the picture covers the box exactly and
         nothing is cropped off it. */
      const [tile] = await canvas.scene.createEmbeddedDocuments("Tile", [{
        texture: { src, fit: "fill" },
        x, y, width, height,
        rotation: 0, alpha: 1, hidden: false, locked: false, sort: -5,
        flags: { [FLAG_NS]: { soot: true } },
      }]);
      const ft = (px) => Math.round(px / ((canvas?.grid?.size ?? 100)
        / (canvas?.scene?.grid?.distance ?? 5)));
      console.log(`${LOG} | ${what} burned: one stain, ${ft(width)}x${ft(height)} feet`
        + `${filled ? "" : `, with ${boxes.length} burned square${boxes.length === 1 ? "" : "s"} `
          + `and the rest of the box cut out`}. It is an ordinary tile - select it with the `
        + `tile tool and press Delete to clear the whole stain.`);
      return tile;
    } catch (err) {
      console.warn(`${LOG} | could not leave soot where ${what} burned:`, err);
      return null;
    }
  }

  /**
   * The per-pixel mask for a ragged burn: 1 shows the picture, 0 is gone, and
   * the values between are the fade. Pure, so a self-test can run it in Node and
   * pin his L of three squares without a browser.
   *
   * His rule, 2026-10-07, shared by the ash and the fire: a burned square stays
   * solid; an empty square is a four-by-four, row 0 north and column 0 west; a
   * side that touches a burned square is fade on that whole edge; two touching
   * sides also turn on the one cell diagonally in from their corner, (1,1) for
   * north and west, (1,2) north and east, (2,1) south and west, (2,2) south and
   * east; all four sides are the outer ring only, the inner four stay gone; one
   * side alone is just that edge; gone is transparent.
   *
   * Then the two part company, and that is the `mode`:
   *
   *   "ash"  - handed to `ashMask`, which has no cells in it: a hard-zero hole a
   *            third of a square from the ash, and the straight-line distance
   *            from that hole as the climb (his rule of 2026-10-07).
   *
   *   "fire" - the four-by-four above, with "50 pixels across every fade cell,
   *            solid against the burned square and gone at the clear." Every
   *            fade pixel's alpha is its distance from the nearest gone pixel,
   *            in cells, so the whole cell is the ramp.
   *
   * ⚠️ ONE SQUARE IS THE SCENE GRID. On his 200px grid a fire cell is 50, so the
   * fire's ramp is one whole cell. `scale` is what the output was shrunk by when
   * a huge burn was capped, so the pixel numbers stay true on the map.
   *
   * @param {object} o
   * @param {Set<string>} o.burned  "c,r" keys of the burned squares in the box
   * @param {number} o.cols        squares across the box
   * @param {number} o.rows        squares down the box
   * @param {number} o.sq          one square, in output pixels (the scene grid, scaled)
   * @param {number} o.W           output width in pixels
   * @param {number} o.H           output height in pixels
   * @param {"ash"|"fire"} [o.mode]
   * @param {number} [o.scale]     output pixels per scene pixel (1 unless capped)
   * @returns {Float32Array} W*H values in [0, 1]
   */
  static sootMask({ burned, cols, rows, sq, W, H, mode = "ash", scale = 1, band = true }) {
    /* ⚠️🔴 THE ASH IS ONE DISTANCE RULE NOW (his correction, 2026-10-07: "The
       soot alpha is the straight-line distance to the nearest empty pixel. One
       rule for a square hole and for an L... If the empty shape changes, do not
       special-case it."). The four-by-four with its 40 and 20 is the fire's rule
       only; the ash goes to `ashMask`, which has no cells in it at all. */
    if (mode === "ash") return FirePaint.ashMask({ burned, sq, W, H, band });

    const isBurned = (c, r) => burned.has(`${c},${r}`);
    const cell = sq / 4;
    const ASH_EDGE = 40 * scale;                  // (unused by the fire; kept for the ramp's shape)
    const ASH_INNER = 20 * scale;
    const ramp = (d, L) => Math.max(0, Math.min(1, 1 - d / L));

    const mask = new Float32Array(W * H);
    // Paint a rectangle through a function of the pixel centre, keeping the
    // larger value where two writes meet (a corner cell on two touching edges).
    const paint = (x0, y0, w, h, fn) => {
      const xa = Math.max(0, Math.floor(x0)), ya = Math.max(0, Math.floor(y0));
      const xb = Math.min(W, Math.ceil(x0 + w)), yb = Math.min(H, Math.ceil(y0 + h));
      for (let y = ya; y < yb; y++) {
        const row = y * W;
        for (let x = xa; x < xb; x++) {
          const v = fn(x + 0.5, y + 0.5);
          if (v > mask[row + x]) mask[row + x] = v;
        }
      }
    };

    for (let c = 0; c < cols; c++) {
      for (let r = 0; r < rows; r++) {
        const ox = c * sq, oy = r * sq;
        if (isBurned(c, r)) { paint(ox, oy, sq, sq, () => 1); continue; }

        // The 4x4 cells of an empty square, row 0 north, column 0 west.
        const n = isBurned(c, r - 1), sth = isBurned(c, r + 1);
        const w = isBurned(c - 1, r), e = isBurned(c + 1, r);
        const on = Array.from({ length: 4 }, () => [false, false, false, false]);
        if (n)   for (let i = 0; i < 4; i++) on[0][i] = true;
        if (sth) for (let i = 0; i < 4; i++) on[3][i] = true;
        if (w)   for (let i = 0; i < 4; i++) on[i][0] = true;
        if (e)   for (let i = 0; i < 4; i++) on[i][3] = true;
        const sides = [n, sth, w, e].filter(Boolean).length;
        if (sides !== 4) {
          // Two touching sides that meet at a corner turn on the cell
          // diagonally in from that corner. All four is the ring alone.
          if (n && w)   on[1][1] = true;
          if (n && e)   on[1][2] = true;
          if (sth && w) on[2][1] = true;
          if (sth && e) on[2][2] = true;
        }

        for (let cr = 0; cr < 4; cr++) {
          for (let cc = 0; cc < 4; cc++) {
            if (!on[cr][cc]) continue;
            const cx = ox + cc * cell, cy = oy + cr * cell;
            if (mode !== "ash") { paint(cx, cy, cell, cell, () => 1); continue; }

            // ── ASH: anchored at the ash ─────────────────────────────────
            // An edge cell measures from the SQUARE's edge that touches the ash;
            // a cell on two touching edges takes the nearer. The rest is gone.
            const edges = [];
            if (cr === 0 && n)   edges.push((px, py) => py - oy);
            if (cr === 3 && sth) edges.push((px, py) => (oy + sq) - py);
            if (cc === 0 && w)   edges.push((px) => px - ox);
            if (cc === 3 && e)   edges.push((px) => (ox + sq) - px);
            if (edges.length) {
              paint(cx, cy, cell, cell, (px, py) =>
                Math.max(...edges.map(d => ramp(d(px, py), ASH_EDGE))));
              continue;
            }
            // The one inner cell: it does not touch the ash, so it measures
            // from its own two sides that face it, and thins across 20.
            const faces = [];
            if (cr === 1) faces.push((px, py) => py - cy);               // north face
            if (cr === 2) faces.push((px, py) => (cy + cell) - py);      // south face
            if (cc === 1) faces.push((px) => px - cx);                   // west face
            if (cc === 2) faces.push((px) => (cx + cell) - px);          // east face
            paint(cx, cy, cell, cell, (px, py) =>
              Math.max(...faces.map(d => ramp(d(px, py), ASH_INNER))));
          }
        }
      }
    }

    if (mode === "ash") return mask;              // measured from the ash; done

    /* ── FIRE: the whole cell is the ramp, solid at the burned square and gone
       at the clear. Every fade pixel's alpha is its distance from the nearest
       gone pixel, in cells: a two-pass chamfer transform, orthogonal steps 1 and
       diagonal steps root 2, forward then backward over the image. Within a few
       percent of the true distance, one pass each way. Burned squares are set
       back to solid afterwards and are never faded. */
    const INF = 1e9;
    const SQRT2 = Math.SQRT2;
    const dist = new Float32Array(W * H);
    for (let i = 0; i < dist.length; i++) dist[i] = mask[i] > 0 ? INF : 0;

    for (let y = 0; y < H; y++) {                 // forward
      const row = y * W, up = (y - 1) * W;
      for (let x = 0; x < W; x++) {
        let d = dist[row + x];
        if (d === 0) continue;
        if (x > 0) d = Math.min(d, dist[row + x - 1] + 1);
        if (y > 0) {
          d = Math.min(d, dist[up + x] + 1);
          if (x > 0) d = Math.min(d, dist[up + x - 1] + SQRT2);
          if (x < W - 1) d = Math.min(d, dist[up + x + 1] + SQRT2);
        }
        dist[row + x] = d;
      }
    }
    for (let y = H - 1; y >= 0; y--) {            // backward
      const row = y * W, down = (y + 1) * W;
      for (let x = W - 1; x >= 0; x--) {
        let d = dist[row + x];
        if (d === 0) continue;
        if (x < W - 1) d = Math.min(d, dist[row + x + 1] + 1);
        if (y < H - 1) {
          d = Math.min(d, dist[down + x] + 1);
          if (x < W - 1) d = Math.min(d, dist[down + x + 1] + SQRT2);
          if (x > 0) d = Math.min(d, dist[down + x - 1] + SQRT2);
        }
        dist[row + x] = d;
      }
    }

    const blurred = new Float32Array(W * H);
    for (let i = 0; i < blurred.length; i++) {
      blurred[i] = mask[i] > 0 ? Math.min(1, dist[i] / cell) : 0;
    }
    for (const key of burned) {                   // never fade a burned square
      const [c, r] = key.split(",").map(Number);
      const xa = Math.floor(c * sq), ya = Math.floor(r * sq);
      const xb = Math.min(W, Math.ceil((c + 1) * sq)), yb = Math.min(H, Math.ceil((r + 1) * sq));
      for (let y = ya; y < yb; y++) {
        const row = y * W;
        for (let x = xa; x < xb; x++) blurred[row + x] = 1;
      }
    }
    return blurred;
  }

  /**
   * The ash's alpha: the straight-line distance to the nearest empty pixel.
   *
   * His rule, 2026-10-07, in full:
   *
   *   "The soot alpha is the straight-line distance to the nearest empty pixel.
   *    One rule for a square hole and for an L. Do not blur a hard mask. Do not
   *    feather with a box blur. A pixel inside the empty region is 0, all the way
   *    to the edge of that region. The edge itself is 0. From there, alpha
   *    climbs to 255 over one cell and no further. One cell is the image width
   *    divided by 9. Distance is the straight line, so a side climbs straight out
   *    and a corner climbs on the diagonal. Past that distance the pixel is 255.
   *    No second band. Make the empty part a hard 0 first, then fade outward. If
   *    the empty shape changes, do not special-case it. The same distance covers
   *    a square, an L, and a corner. A straight side reads about 127. An outside
   *    corner reads about 188. A cell touched by empty on two sides reads about
   *    84, and that 84 is correct."
   *
   * ⚠️ WHERE THE HOLE IS. His two tables fix it: on the 15-foot room it is the
   * centre cell of the empty square, on the 10-foot L the far three-by-three
   * block. The one rule that gives both is "farther than a third of a square
   * from every burned square". It is measured as a SQUARE distance, not a round
   * one, because that is what keeps every edge of the hole straight and every
   * corner sharp - a round erosion would put an arc on an inside corner and that
   * cell would read 67, not his 84. The hole is the empty ground eroded by a
   * square a third of a grid square across, done as two one-dimensional passes.
   *
   * ⚠️ THE CLIMB IS THE STRAIGHT LINE, exactly. From the hole outward the alpha
   * is the Euclidean distance to the nearest hole pixel, from Felzenszwalb's
   * exact transform, over one cell of W/9. A side climbs straight out and reads
   * 127; an outside corner climbs on the diagonal and reads 188; an inside corner
   * sees the hole on two sides, takes the nearer, and reads 84. One formula.
   *
   * ⚠️ DRAWN AT THREE TIMES THE SIZE AND AVERAGED DOWN. The hole's edges sit at
   * thirds of a pixel (a third of a 200 square is 66.67), and a pixel-sized
   * decision lands them a third of a pixel out on one axis and two thirds on
   * the other, which is what put 123 beside 129 on two sides that should read
   * the same. At three times the resolution those thirds are whole pixels, the
   * edges are exact, and each final pixel is the true average of its nine.
   *
   * ⚠️ 255 IS 255, UNTIL THE BAND. Past one cell the alpha is exactly 1, and a
   * burned square is 1 whatever the distance says. Then one more band, his rule
   * of the same day: every 255 within one further cell of the fade, square
   * step, and every 255 in the outside cell of the image, becomes 220. Nothing
   * under 255 is touched by it. Step 5 below.
   *
   * @param {boolean} [o.band]  false leaves the 220 band off (the self-test
   *   compares the two to prove the fade is untouched)
   * @returns {Float32Array} W*H values in [0, 1]
   */
  static ashMask({ burned, sq, W, H, band = true }) {
    // Supersample while it stays under about four million pixels.
    const S = Math.max(1, Math.min(3, Math.floor(Math.sqrt(4e6 / (W * H)))));
    const Ws = W * S, Hs = H * S, sqS = sq * S;
    const n = Ws * Hs;

    // 1. The ash.
    const ash = new Uint8Array(n);
    for (const key of burned) {
      const [c, r] = key.split(",").map(Number);
      const xa = Math.max(0, Math.round(c * sqS)), ya = Math.max(0, Math.round(r * sqS));
      const xb = Math.min(Ws, Math.round((c + 1) * sqS)), yb = Math.min(Hs, Math.round((r + 1) * sqS));
      for (let y = ya; y < yb; y++) { const row = y * Ws; for (let x = xa; x < xb; x++) ash[row + x] = 1; }
    }

    // 2. The hole: the empty ground farther than a third of a square from any
    //    ash, as a square distance. "Farther than b" between pixel edges is
    //    "no ash pixel within b" of the index, so a square erosion by b, done as
    //    a row pass then a column pass with prefix counts.
    /* A pixel is in the hole when its CENTRE is farther than the band from the
       ash's edge: p + 0.5 - E > band, so p >= E + ceil(band - 0.5). With the
       last ash pixel at E - 1, "no ash within b" needs b = ceil(band - 0.5): 200
       at three times, 67 at full size. floor() put the edge a third of a pixel
       early at full size and the last empty pixel read 0.98, not 1. */
    const b = Math.ceil(sqS / 3 - 0.5);
    const rowClear = new Uint8Array(n);
    const prefix = new Int32Array(Math.max(Ws, Hs) + 1);
    for (let y = 0; y < Hs; y++) {
      const row = y * Ws;
      prefix[0] = 0;
      for (let x = 0; x < Ws; x++) prefix[x + 1] = prefix[x] + ash[row + x];
      for (let x = 0; x < Ws; x++) {
        const lo = Math.max(0, x - b), hi = Math.min(Ws, x + b + 1);
        rowClear[row + x] = (prefix[hi] - prefix[lo]) === 0 ? 1 : 0;
      }
    }
    const hole = new Uint8Array(n);
    for (let x = 0; x < Ws; x++) {
      prefix[0] = 0;
      for (let y = 0; y < Hs; y++) prefix[y + 1] = prefix[y] + (rowClear[y * Ws + x] ? 0 : 1);
      for (let y = 0; y < Hs; y++) {
        const lo = Math.max(0, y - b), hi = Math.min(Hs, y + b + 1);
        hole[y * Ws + x] = (prefix[hi] - prefix[lo]) === 0 && !ash[y * Ws + x] ? 1 : 0;
      }
    }

    /* 3. The climb: the straight-line distance from the hole, one cell to 255.
       The transform measures centre to centre; half a pixel off that is the
       distance to the hole's edge, which is where the climb starts at 0.

       ⚠️🔴 ONE CELL IS W/9, AND NEVER LONGER THAN THE BAND (found by the
       adversarial pass, 2026-10-07). His spec names the cell as the image width
       over nine, and his two tables are two and three squares wide, where W/9
       is at or under a third of a square. On a wider box W/9 is LONGER than the
       band between the hole and the ash, so the climb hit the ash at 189 on a
       four-square box, 151 on five, 125 on six, and the next pixel was forced to
       255: a one-pixel hard edge at every burned square, which is the thing this
       whole rule exists to remove, reproduced at exactly those numbers.

       So the cell is the smaller of W/9 and a third of a square. On the 600 and
       the 400 that is W/9 and both tables are untouched; on anything wider the
       climb reaches 255 exactly at the ash, as "climbs to 255 over one cell and
       no further" says it must. ASSUMED, not his words: he named W/9 and did not
       say what happens past three squares. If he wants the ash to take the fade
       instead, this one line is where that changes. */
    const cell = Math.min(Ws / 9, sqS / 3);
    const fromHole = FirePaint.edt(hole, Ws, Hs);
    const fine = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      if (hole[i]) { fine[i] = 0; continue; }
      if (ash[i]) { fine[i] = 1; continue; }
      fine[i] = Math.min(1, Math.max(0, fromHole[i] - 0.5) / cell);
    }

    // 4. Down to the image: each pixel is the mean of its S by S.
    let out = fine;
    if (S !== 1) {
      out = new Float32Array(W * H);
      const inv = 1 / (S * S);
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          let sum = 0;
          for (let yy = 0; yy < S; yy++) {
            const row = (y * S + yy) * Ws + x * S;
            for (let xx = 0; xx < S; xx++) sum += fine[row + xx];
          }
          out[y * W + x] = sum * inv;
        }
      }
    }
    if (!band) return out;

    /* 5. THE 220 BAND, on the 255s only.
       His rule, 2026-10-07: "Any pixel that is already under 255 stays exactly
       as it is. The zeros stay 0... Do not redraw the hole and do not run the
       distance transform again. A pixel that is 255 becomes 220 when either of
       these is true: 1. It is inside one cell of a pixel that is not 255. One
       cell is the image width divided by 9. Count the diagonal, so a 255 that
       only meets the fade at a corner still becomes 220. Use a square step, not
       a circle, so the whole cell reads 220 and not a mix. 2. It sits in the
       outside cell of the image. The world past the edge counts as not 255. The
       outer cell is 220 all the way around, on every side. A 255 that only
       touches other 255s, and is not on that outside cell, stays 255."

       ⚠️ MEASURED FROM THE HOLE, TWO CELLS, AS A SQUARE. The fade's own corner
       is a quarter-disc (a straight-line climb), so "one cell from any pixel
       under 255" taken pixel by pixel would leave the diagonal cell a mix of
       220 and 255, and his tables say that cell is 220 whole. The fade stands
       one cell out from the hole; one cell more with a square step is two cells
       out from the hole with a square step, which is identical on every straight
       side and whole on every diagonal. That is a square dilation of the hole,
       the same prefix-sum filter the hole was cut with, and no transform.

       ⚠️ DECIDED PER FINAL PIXEL, BY ITS CENTRE, so a pixel is 220 or 255 and
       never a mix: the band's edge lands on a whole pixel, and the 9 by 9 reads
       220 and 255, not 231. The climb's cell (capped at the band on a wide box)
       plus W/9 is the reach; on his 600 and 400 that is two W/9 cells. */
    const bandS = (Ws / 9);                        // "one cell is the image width divided by 9"
    const reach = Math.floor(cell + bandS + 0.5);  // index distance from the hole, square step
    const nearS = new Uint8Array(n);               // within reach of the hole, at S
    for (let y = 0; y < Hs; y++) {                 // rows: any hole within reach, horizontally
      const row = y * Ws;
      prefix[0] = 0;
      for (let x = 0; x < Ws; x++) prefix[x + 1] = prefix[x] + hole[row + x];
      for (let x = 0; x < Ws; x++) {
        const lo = Math.max(0, x - reach), hi = Math.min(Ws, x + reach + 1);
        nearS[row + x] = (prefix[hi] - prefix[lo]) > 0 ? 1 : 0;
      }
    }
    for (let x = 0; x < Ws; x++) {                 // columns: any of those within reach, vertically
      prefix[0] = 0;
      for (let y = 0; y < Hs; y++) prefix[y + 1] = prefix[y] + nearS[y * Ws + x];
      for (let y = 0; y < Hs; y++) {
        const lo = Math.max(0, y - reach), hi = Math.min(Hs, y + reach + 1);
        // written back into the same column after it has been read above
        rowClear[y * Ws + x] = (prefix[hi] - prefix[lo]) > 0 ? 1 : 0;
      }
    }
    const near = rowClear;                         // reused buffer: 1 = within reach of the hole

    const BAND = 220 / 255;
    const edge = W / 9;                            // the outside cell, one W/9 on every side
    const half = Math.floor(S / 2);                // the centre sub-pixel of a final pixel
    for (let y = 0; y < H; y++) {
      const outer = (y + 0.5) < edge || (y + 0.5) > H - edge;
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        if (out[i] < 1) continue;                  // under 255 stays exactly as it is
        if (outer || (x + 0.5) < edge || (x + 0.5) > W - edge) { out[i] = BAND; continue; }
        if (near[(y * S + half) * Ws + (x * S + half)]) out[i] = BAND;
      }
    }
    return out;
  }

  /**
   * Exact Euclidean distance, in pixels, from every pixel to the nearest pixel
   * where `src` is 1. Felzenszwalb and Huttenlocher's method: a one-dimensional
   * squared-distance transform by lower envelope of parabolas, run down the
   * columns and then along the rows. Linear time, and exact rather than a
   * chamfer's approximation. A pixel in `src` is at distance 0. If `src` is empty
   * every distance is effectively infinite.
   *
   * @returns {Float32Array} distances, W*H
   */
  static edt(src, W, H) {
    const INF = 1e12;                             // far larger than any d², exact in a double
    const f = new Float64Array(Math.max(W, H));
    const d = new Float64Array(Math.max(W, H));
    const v = new Int32Array(Math.max(W, H));
    const z = new Float64Array(Math.max(W, H) + 1);
    const d2 = new Float64Array(W * H);           // squared distance, built in place

    const edt1d = (len) => {
      let k = 0;
      v[0] = 0; z[0] = -INF; z[1] = INF;
      for (let q = 1; q < len; q++) {
        let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
        while (s <= z[k]) {
          k--;
          s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
        }
        k++; v[k] = q; z[k] = s; z[k + 1] = INF;
      }
      k = 0;
      for (let q = 0; q < len; q++) {
        while (z[k + 1] < q) k++;
        d[q] = (q - v[k]) * (q - v[k]) + f[v[k]];
      }
    };

    for (let x = 0; x < W; x++) {                 // down each column
      for (let y = 0; y < H; y++) f[y] = src[y * W + x] ? 0 : INF;
      edt1d(H);
      for (let y = 0; y < H; y++) d2[y * W + x] = d[y];
    }
    for (let y = 0; y < H; y++) {                 // then along each row
      const row = y * W;
      for (let x = 0; x < W; x++) f[x] = d2[row + x];
      edt1d(W);
      for (let x = 0; x < W; x++) d2[row + x] = d[x];
    }
    const out = new Float32Array(W * H);
    for (let i = 0; i < out.length; i++) out[i] = Math.sqrt(d2[i]);
    return out;
  }

  /**
   * His check: the alpha averaged on a 9 by 9, each number 0..255. Row 0 is the
   * north, column 0 the west, printed one row per line so the console shows the
   * same table he reads off the file.
   */
  static nineByNine(mask, W, H) {
    /* ⚠️🔴 THE CELL EDGES ARE EXACT NINTHS, NOT WHOLE PIXELS (found by the
       adversarial pass, 2026-10-07). This cut each cell at floor(c*W/9), so on
       the 600 the cells were 66, 67 and 67 pixels wide against his 66.67, and
       the pixel straddling a hole's edge was handed to one side and not the
       other. A mask that is symmetric to the last digit printed 129 on its north
       and 127 on its south, and the L's straight side printed 124 beside a row
       that printed 130: numbers that by his own criterion condemn a mask that is
       right. Each pixel now counts by how much of it lies inside the cell, and
       the reader prints his tables as he wrote them. */
    const grid = [];
    const weight = (lo, hi, p) => Math.max(0, Math.min(hi, p + 1) - Math.max(lo, p));
    for (let r = 0; r < 9; r++) {
      const line = [];
      const ya = r * H / 9, yb = (r + 1) * H / 9;
      for (let c = 0; c < 9; c++) {
        const xa = c * W / 9, xb = (c + 1) * W / 9;
        let sum = 0, area = 0;
        for (let y = Math.floor(ya); y < Math.ceil(yb); y++) {
          const wy = weight(ya, yb, y);
          if (wy <= 0) continue;
          const row = y * W;
          for (let x = Math.floor(xa); x < Math.ceil(xb); x++) {
            const wx = weight(xa, xb, x);
            if (wx <= 0) continue;
            sum += mask[row + x] * wx * wy;
            area += wx * wy;
          }
        }
        line.push(area ? Math.round(255 * sum / area) : 0);
      }
      grid.push(line);
    }
    return grid;
  }

  static nineByNineText(grid) {
    return grid.map(line => line.map(v => String(v).padStart(3)).join("  ")).join("\n");
  }

  /**
   * The fire's soft mask for a ragged burn, as a canvas the clip can be masked
   * with, built on whichever client is drawing the flame.
   *
   * His rule, 2026-10-07: "The flame is the Sequencer clip, masked to those
   * squares. The mask uses this fade. It is not a hard cut. An unstamped square
   * stays out, and a burned square stays fully on fire."
   *
   * ⚠️ NO FILE. Unlike the ash this never touches the disk: it is a canvas each
   * client draws for itself from the region's squares, white where the fire
   * shows and transparent where it does not, with the fire's own fade between.
   * The ash writes a file because a Tile's texture must be one; a mask on a
   * sprite does not.
   *
   * @returns {{canvas: HTMLCanvasElement, x:number, y:number, width:number,
   *   height:number}|null} null when every square of the box is stamped, which
   *   is a plain rectangle and needs no mask at all
   */
  static fireMaskCanvas(region) {
    try {
      const keys = region?.flags?.[FLAG_NS]?.fire?.squares ?? [];
      if (!keys.length) return null;
      const gs = FirePaint._gs;
      const squares = keys.map(k => FirePaint.fromKey(k));
      const x = Math.min(...squares.map(s => s.x));
      const y = Math.min(...squares.map(s => s.y));
      const right = Math.max(...squares.map(s => s.x)) + gs;
      const bottom = Math.max(...squares.map(s => s.y)) + gs;
      const width = right - x, height = bottom - y;
      const cols = Math.round(width / gs), rows = Math.round(height / gs);
      if (squares.length >= cols * rows) return null;   // a filled box: no mask

      const scale = Math.min(1, 2048 / Math.max(width, height));
      const W = Math.max(1, Math.round(width * scale));
      const H = Math.max(1, Math.round(height * scale));
      const burned = new Set(squares.map(s =>
        `${Math.round((s.x - x) / gs)},${Math.round((s.y - y) / gs)}`));
      const mask = FirePaint.sootMask({ burned, cols, rows, sq: gs * scale, W, H, mode: "fire", scale });

      const cv = document.createElement("canvas");
      cv.width = W;
      cv.height = H;
      const ctx = cv.getContext("2d");
      const image = ctx.createImageData(W, H);
      const px = image.data;
      for (let i = 0, m = 0; i < px.length; i += 4, m++) {
        px[i] = 255; px[i + 1] = 255; px[i + 2] = 255;
        px[i + 3] = Math.round(255 * mask[m]);
      }
      ctx.putImageData(image, 0, 0);
      return { canvas: cv, x, y, width, height };
    } catch (err) {
      console.warn(`${LOG} | the flame's mask could not be built, so the flame covers its whole `
        + `box:`, err);
      return null;
    }
  }

  /**
   * The picture stretched across the box, with the empty ground faded out by his
   * rule, written to the world folder and handed back as a path.
   *
   * The rule itself is `ashMask`: a hard-zero hole where the ground is farther
   * than a third of a square from the ash, and from its edge a straight-line
   * climb to 255 over one cell. No cells inside the empty square, no blur, no
   * feather: the alpha is a distance and nothing else.
   *
   * ⚠️ PER PIXEL, ON THE ALPHA CHANNEL, NEVER ON THE COLOUR. The picture is drawn
   * once and then only its alpha is multiplied by the mask, so a faded pixel is
   * the same ash lighter and not a different colour.
   *
   * ⚠️ IT CHECKS ITS OWN WORK, in his order: decode, draw, read a burned pixel,
   * mask, print the 9 by 9, read a burned pixel and a clear pixel, and refuse to
   * save an empty canvas. Every refusal says why.
   *
   * @returns {Promise<string|null>} the uploaded path, or null when the stain
   *   must be placed as the whole box instead
   */
  static async _cutOut(boxes, box) {
    try {
      const FP = foundry.applications?.apps?.FilePicker?.implementation ?? globalThis.FilePicker;
      // ⚠️ ONE SQUARE IS THE SCENE'S GRID SIZE, NOT 200. A 10-foot box on his
      // 200px grid is 400 pixels across; on a 100px grid it is 200.
      const gs = FirePaint._gs;
      const cols = Math.max(1, Math.round(box.width / gs));
      const rows = Math.max(1, Math.round(box.height / gs));

      // The output is the box at scene resolution, capped so a huge ragged burn
      // does not become a texture the GPU refuses.
      const scale = Math.min(1, 2048 / Math.max(box.width, box.height));
      const W = Math.max(1, Math.round(box.width * scale));
      const H = Math.max(1, Math.round(box.height * scale));
      const sq = gs * scale;                        // one square, in output pixels

      // Which squares of the box burned, by column and row from the north-west.
      const burned = new Set();
      for (const r of boxes) {
        const c0 = Math.round((r.x - box.x) / gs), r0 = Math.round((r.y - box.y) / gs);
        const cw = Math.max(1, Math.round(r.width / gs)), rh = Math.max(1, Math.round(r.height / gs));
        for (let c = c0; c < c0 + cw; c++) for (let rr = r0; rr < r0 + rh; rr++) burned.add(`${c},${rr}`);
      }
      // Every square burned is a plain box: the picture itself, no file.
      if (burned.size >= cols * rows) {
        console.log(`${LOG} | every square of this ${cols}x${rows} box burned, so the stain is the `
          + `picture as it is and nothing is written.`);
        return null;
      }

      // ── 1. Load and DECODE, then draw ──────────────────────────────────────
      const img = new Image();
      img.src = SOOT_ART;
      await img.decode();                           // resolves only once it is drawable

      const cv = document.createElement("canvas");
      cv.width = W;
      cv.height = H;
      const ctx = cv.getContext("2d", { willReadFrequently: true });
      ctx.clearRect(0, 0, W, H);
      ctx.drawImage(img, 0, 0, W, H);

      // ── 2. Read a burned pixel: did the picture actually land? ─────────────
      const firstBurned = [...burned][0].split(",").map(Number);
      const probe = (c, r) => ({
        x: Math.min(W - 1, Math.floor((c + 0.5) * sq)),
        y: Math.min(H - 1, Math.floor((r + 0.5) * sq)),
      });
      const alphaAt = (pt) => ctx.getImageData(pt.x, pt.y, 1, 1).data[3];
      const drawnProbe = probe(firstBurned[0], firstBurned[1]);
      const drawnAlpha = alphaAt(drawnProbe);
      if (drawnAlpha === 0) {
        console.warn(`${LOG} | the ash picture drew nothing: the centre of a burned square is `
          + `transparent straight after drawImage (${SOOT_ART} at ${W}x${H}). The cut-out is `
          + `abandoned and the stain is placed as the whole box.`);
        return null;
      }

      // ── 3 and 4. The mask: the straight-line distance from the hole ────────
      // Pure arithmetic, pinned by tools/soot-mask-selftest.mjs against his tables.
      const mask = FirePaint.sootMask({ burned, cols, rows, sq, W, H, mode: "ash", scale });

      // ── 5. Apply it to the alpha channel only; the colour is untouched ─────
      const image = ctx.getImageData(0, 0, W, H);
      const px = image.data;
      let anyOpaque = false;
      for (let i = 0, m = 0; i < px.length; i += 4, m++) {
        const a = Math.round(px[i + 3] * mask[m]);
        px[i + 3] = a;
        if (a > 0) anyOpaque = true;
      }
      ctx.putImageData(image, 0, 0);

      // His check, before it is called done: the alpha averaged on a 9 by 9.
      console.log(`${LOG} | the stain's alpha, averaged on a 9 by 9 (north at the top):\n`
        + FirePaint.nineByNineText(FirePaint.nineByNine(mask, W, H)));

      // ── 6. Read it back: burned opaque, clear transparent, canvas not empty ─
      const burnedAfter = alphaAt(drawnProbe);
      if (burnedAfter !== drawnAlpha) {
        console.warn(`${LOG} | the cut-out changed a burned pixel (alpha ${drawnAlpha} became `
          + `${burnedAfter}). The mask must not touch a burned square; the stain is placed as `
          + `the whole box instead.`);
        return null;
      }
      let clearProbe = null;
      for (let m = 0; m < mask.length && !clearProbe; m++) {
        if (mask[m] === 0) clearProbe = { x: m % W, y: Math.floor(m / W) };
      }
      if (clearProbe) {
        const clearAfter = alphaAt(clearProbe);
        if (clearAfter !== 0) {
          console.warn(`${LOG} | the cut-out left a clear pixel opaque (alpha ${clearAfter} at `
            + `${clearProbe.x},${clearProbe.y}). The stain is placed as the whole box instead.`);
          return null;
        }
      } else {
        console.log(`${LOG} | every cell of this shape is fade or burned, so there is no clear `
          + `pixel to check.`);
      }
      if (!anyOpaque) {
        console.warn(`${LOG} | the cut-out canvas is empty: every pixel is transparent. It is `
          + `not saved, and the stain is placed as the whole box instead.`);
        return null;
      }

      // ── 7. Write it where his scenery lives, never in the module ───────────
      const blob = await new Promise(res => cv.toBlob(res, "image/png"));
      if (!blob) throw new Error("the browser would not encode the png");
      const dir = `worlds/${game.world.id}/ace-soot`;
      try { await FP.createDirectory("data", dir); }
      catch (err) {
        // "already exists" is the usual answer and is not an error here.
        if (!/exist/i.test(String(err?.message ?? err))) {
          console.warn(`${LOG} | could not create ${dir}:`, err);
        }
      }
      const name = `soot-${Date.now().toString(36)}-${Math.round(box.width)}x${Math.round(box.height)}.png`;
      const out = await FP.upload("data", dir, new File([blob], name, { type: "image/png" }),
        {}, { notify: false });
      const path = out?.path ?? null;
      if (!path) throw new Error("the upload returned no path");
      console.log(`${LOG} | cut-out written: ${path} (${W}x${H}, ${burned.size} burned of `
        + `${cols * rows} squares, burned pixel alpha ${burnedAfter}, one cell of fade = ${(W / 9).toFixed(2)}px).`);
      return path;
    } catch (err) {
      console.warn(`${LOG} | the burned shape could not have its empty squares cut out, so the `
        + `stain is placed as the whole box:`, err);
      return null;
    }
  }

  /**
   * One line in the chat, for a door that opened by itself.
   *
   * ⚠️ THE BLACK ACE CARD, AND NOT A WHISPER (his rule, 2026-10-06). A door
   * swinging open on its own is something the whole table is looking at, and a
   * whispered pale line on Foundry's parchment is not a card.
   */
  static async _say(text) {
    try {
      const { CardDoor } = await import("./road/doors.mjs");
      await CardDoor.post({
        content: `<div class="ace-qol-card ace-qol-fire-line">`
          + `<i class="fas fa-fire"></i> ${foundry.utils.escapeHTML(text)}</div>`,
        flags: { [MODULE_ID]: { type: "fireLine" } },
      }, { dice: false });
    } catch (err) {
      console.warn(`${LOG} | could not post the fire line, so it is here instead: ${text}`, err);
    }
  }
}
