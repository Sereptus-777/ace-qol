/* ─── THE PORTAL ENGINE ───────────────────────────────────────────────────────
 *
 * Defines globalThis.AcePortals and arms its hooks once. Both macros carry this
 * text, so pressing either one re-arms everything after a reload.
 *
 * It never places a player's creature, never rolls for a player, never touches a
 * dragon, and never starts a turn for the table.
 * ────────────────────────────────────────────────────────────────────────── */
(() => {
  const NS = "world";
  const CAP = 4;

  /* ⚠️🔴 TEN THRESHOLDS, AND THEY REPLACE THE HALF AND DEAD LINES (his rule,
     2026-10-05). Half of 500 is 250, which is one line in a fight that is going
     to take nine hundred points of damage across three portals; he wants the
     table watching a gate come apart. Crossing several at once says the LOWEST
     one only, and every one it passed is marked so it can never fire later. */
  const THRESHOLDS = [450, 400, 350, 300, 250, 200, 150, 100, 50, 0];
  const LINES = {
    blue: {
      450: "The blue vortex flinches. The courtyard beyond it ripples.",
      400: "A crack runs through the blue light. The doorway shudders, and holds.",
      350: "The blue vortex pulls inward, then pushes back. The court on the other side is farther away.",
      300: "The opening stutters. For a moment the courtyard is gone, and then it is there again.",
      250: "The blue light thins. The doorway is failing.",
      200: "Wind pours out of the blue vortex and dies. The court beyond is dim.",
      150: "It is no longer a gate so much as a wound.",
      100: "The blue vortex gives a low scream, and the floor around it groans.",
      50: "Barely a doorway. One more blow and the way is gone.",
      0: "The blue vortex collapses in on itself. The way to the courtyard is gone.",
    },
    red: {
      450: "The red vortex bucks. Something on the far side snarls.",
      400: "A crack splits the red light. Fewer shapes press against it.",
      350: "The red vortex flares, angry, and the flare does not last.",
      300: "The opening gutters. The things beyond it are slower reaching the mouth.",
      250: "The red light is torn. The gate is failing, and it knows it.",
      200: "A howl comes through the red vortex and is cut short.",
      150: "The vortex cinches. What is trying to climb out has less room.",
      100: "The red vortex folds around its own edges. The far side is going dark.",
      50: "One mouthful of light left.",
      0: "The red vortex dies. Nothing else is coming through.",
    },
    yellow: {
      450: "The yellow vortex wavers. The light on the far side looks back.",
      400: "A crack crosses the gold light. Help is still coming, slower.",
      350: "The yellow vortex steadies, and it costs it.",
      300: "The opening dims. The figures on the other side are farther off.",
      250: "The gold light is thin. Reinforcements are no longer certain.",
      200: "The vortex flickers out and back. A shout on the far side does not arrive.",
      150: "It is pulling shut. Fewer of them will make it.",
      100: "The yellow vortex gutters like a candle in a fist.",
      50: "Almost nothing. The far side is a slit.",
      0: "The yellow vortex goes out. No more help is coming.",
    },
  };

  const OPENING = "Two dragons are tearing the hall apart. The gold one has put herself between you "
    + "and the red, and she is losing ground. Behind her, a blue vortex opens onto a stone courtyard. "
    + "A red vortex on the far side is pouring things out. A yellow one answers with light. The gold "
    + "dragon looks at you, not at the fight, and the look says go.";

  const DOT = { red: "#d93a3a", yellow: "#e2b43a", blue: "#4aa3ff" };

  /* ⚠️ ONE CRACK SOUND HE ALREADY HAS, and the file is CHECKED (his rule: "If
     you cannot find one, say so in the console and still post the card. Do not
     invent a path."). Both of these are on his disk today; the second is ACE's
     own, so it answers even if that module is ever removed. */
  const CRACKS = [
    "modules/fvtt-sonniss-gdc-audio/assets/audio/bluezone-bc0278-ice-crack-break-002.ogg",
    "modules/ace-qol/Assets/Sounds/thunder-crack.mp3",
  ];
  let _crack;            // undefined = not looked for yet, null = there is none
  const crackSound = async () => {
    if (_crack !== undefined) return _crack;
    for (const src of CRACKS) {
      try {
        const r = await fetch(src, { method: "HEAD" });
        if (r.ok) { _crack = src; return _crack; }
      } catch (_) { /* try the next one */ }
    }
    _crack = null;
    console.warn("ACE portals | no crack sound could be found on this install, so the card is "
      + "posted without one. Looked for: " + CRACKS.join(", "));
    return _crack;
  };

  /** Louder the lower it gets: a nick at 450, a death rattle at 0. */
  const playCrack = async (now, max) => {
    const src = await crackSound();
    if (!src) return;
    const left = Math.max(0, Math.min(1, max > 0 ? now / max : 0));
    const volume = Math.round((0.30 + (1 - left) * 0.65) * 100) / 100;
    try {
      const helper = foundry.audio?.AudioHelper ?? globalThis.AudioHelper;
      await helper.play({ src, volume, autoplay: true, loop: false }, true);
    } catch (err) {
      console.warn("ACE portals | the crack sound would not play:", err);
    }
  };

  /**
   * The damage card: black, the dot, the name, and the hit points large.
   *
   * ⚠️ THE TABLE SEES THIS ONE. It is not whispered: they are watching the gate
   * they have to get through come apart.
   */
  const hitCard = (key, name, now, max, line) => {
    const esc = (v) => foundry.utils.escapeHTML(String(v ?? ""));
    const colour = DOT[key] ?? "#c6a15a";
    return ChatMessage.create({
      content: `<div class="ace-portal-hit" style="background:#14100c;border-left:4px solid ${colour};`
        + `border-radius:4px;padding:10px 12px;color:#f3ead7;">`
        + `<div style="display:flex;align-items:center;flex-wrap:wrap;gap:10px;min-height:38px;">`
        + `<span style="flex:0 0 auto;width:14px;height:14px;border-radius:50%;background:${colour};`
        + `box-shadow:inset 0 0 0 1px rgba(0,0,0,.5);"></span>`
        + `<span style="font-size:17px;font-weight:700;color:${colour};">${esc(name)}</span>`
        + `<span style="flex:1 1 20px;"></span>`
        + `<span style="font-size:30px;font-weight:800;line-height:1.1;">${esc(now)}`
        + `<span style="font-size:18px;color:#c6a15a;font-weight:700;"> / ${esc(max)}</span></span>`
        + `</div>`
        + (line ? `<p style="margin:9px 0 0;font-size:16px;line-height:1.5;">${esc(line)}</p>` : "")
        + `</div>`,
      flags: { [NS]: { portals: "hit", portal: key, hp: now } },
    });
  };

  const gmIds = () => game.users.filter(u => u.isGM).map(u => u.id);
  const whisper = (text) => ChatMessage.create({
    content: `<div style="background:#14100c;border-left:4px solid #c6a15a;border-radius:4px;`
      + `padding:9px 12px;color:#f3ead7;font-size:16px;line-height:1.5">${text}</div>`,
    whisper: gmIds(),
    flags: { [NS]: { portals: true } },
  });

  /**
   * The spawn card: one black card, one row per portal, red row first.
   *
   * ⚠️🔴 NOT ONE SENTENCE (his rule, 2026-10-05): "Portals — red: Bone Devil
   * yellow: Couatl" ran the two portals together and showed nothing of what came
   * out. A row is a coloured dot, the creature's own portrait, then its name. A
   * portal that produced nothing is the dot and the word Nothing, with no
   * portrait beside it.
   *
   * @param {Array<{key:string, creatures:Array<{name:string,img:string,init:any}>}>} rows
   */
  const spawnCard = (rows) => {
    const esc = (s) => foundry.utils.escapeHTML(String(s ?? ""));
    const dot = (key) => `<span style="flex:0 0 auto;width:12px;height:12px;border-radius:50%;`
      + `background:${DOT[key] ?? "#888"};box-shadow:inset 0 0 0 1px rgba(0,0,0,.5);"></span>`;
    const body = rows.map(r => {
      const who = r.creatures.length
        ? r.creatures.map(c => `<span style="display:inline-flex;align-items:center;gap:7px;">`
            + (c.img ? `<img src="${esc(c.img)}" alt="" style="width:36px;height:36px;`
              + `object-fit:cover;border:1px solid #c6a15a;border-radius:2px;background:#0c0e0a;">` : "")
            + `<span>${esc(c.name)}${c.init != null ? ` <span style="color:#c6a15a;">on `
              + `${esc(c.init)}</span>` : ""}</span></span>`).join(
            `<span style="color:#7a6a4a;">&middot;</span>`)
        // Nothing: the dot and the word, and no picture.
        : `<span style="color:#c6a15a;">${esc(r.note ?? "Nothing")}</span>`;
      return `<div style="display:flex;align-items:center;flex-wrap:wrap;gap:9px;`
        + `padding:4px 0;min-height:40px;">${dot(r.key)}${who}</div>`;
    }).join("");
    return ChatMessage.create({
      content: `<div style="background:#14100c;border-left:4px solid #c6a15a;border-radius:4px;`
        + `padding:9px 12px;color:#f3ead7;font-size:16px;line-height:1.45">${body}</div>`,
      whisper: gmIds(),
      flags: { [NS]: { portals: "spawn" } },
    });
  };

  /** Every portal token of this colour on the viewed scene. */
  const portalTokens = (key) => (canvas.scene?.tokens?.contents ?? [])
    .filter(t => t.actor?.getFlag?.(NS, "portal") === key);

  /** A portal is alive while its hit points are above zero. */
  const alive = (tokenDoc) => Number(tokenDoc?.actor?.system?.attributes?.hp?.value ?? 0) > 0;

  /** Its living spawns on this scene. */
  const spawnsOf = (key) => (canvas.scene?.tokens?.contents ?? []).filter(t =>
    t.getFlag?.(NS, "portalSpawn") === key
    && Number(t.actor?.system?.attributes?.hp?.value ?? 0) > 0
    && !t.actor?.statuses?.has?.("dead"));

  /**
   * A free square SOUTH of the portal.
   *
   * ⚠️🔴 SOUTH, AND IT STEPS FURTHER SOUTH (his rule, 2026-10-05). The first
   * version walked a ring and happened to list the northern squares first, so
   * everything came out on the far side of the portal from the party. Now: the
   * row immediately south, from the middle of the portal outwards; if that whole
   * row is blocked, the next row south; and so on. North is only ever used when
   * the entire south side has nothing free, and the log says when that happens.
   */
  const SOUTH_ROWS = 10;
  const spotSouthOf = (portalDoc, w = 1, h = 1) => {
    const gs = canvas.grid.size;
    const taken = (x, y) => (canvas.scene.tokens.contents ?? []).some(t =>
      x < t.x + t.width * gs && x + w * gs > t.x
      && y < t.y + t.height * gs && y + h * gs > t.y);
    const px = portalDoc.x, py = portalDoc.y;
    const pw = portalDoc.width * gs, ph = portalDoc.height * gs;

    // Inside the scene if we can tell where that is; a square off the canvas is
    // not a square.
    const rect = canvas.dimensions?.sceneRect ?? null;
    const inScene = (x, y) => !rect
      || (x >= rect.x && y >= rect.y && x + w * gs <= rect.x + rect.width
          && y + h * gs <= rect.y + rect.height);

    // Columns across the portal's own width, from the middle outwards, then one
    // square past each corner.
    const cols = [];
    const mid = Math.floor(portalDoc.width / 2);
    for (let step = 0; step <= portalDoc.width; step++) {
      for (const i of (step === 0 ? [mid] : [mid - step, mid + step])) {
        if (i >= 0 && i < portalDoc.width) cols.push(px + i * gs);
      }
    }
    cols.push(px - w * gs, px + pw);

    for (let row = 0; row < SOUTH_ROWS; row++) {
      const y = py + ph + row * gs;
      for (const x of cols) {
        if (inScene(x, y) && !taken(x, y)) return { x, y, where: `south, row ${row + 1}` };
      }
    }

    // Nothing south at all. Try the rest of the ring, and say so out loud.
    console.warn("ACE portals | the whole south side of " + portalDoc.name + " is blocked for "
      + SOUTH_ROWS + " rows, so the next free square anywhere around it is used instead.");
    const ring = [];
    for (let i = -1; i <= portalDoc.width; i++) ring.push([px + i * gs, py - h * gs]);
    for (let j = -1; j <= portalDoc.height; j++) {
      ring.push([px - w * gs, py + j * gs]);
      ring.push([px + pw, py + j * gs]);
    }
    for (const [x, y] of ring) {
      if (inScene(x, y) && !taken(x, y)) return { x, y, where: "no free square to the south" };
    }
    return { x: px, y: py, where: "nowhere free at all, so on top of the portal" };
  };

  /** One creature out of a portal, placed and rolled into the fight. */
  const spawn = async (key, actor, portalDoc) => {
    /* ⚠️🔴 NOT EVERY ACTOR HAS `getTokenDocument` (his table, 2026-10-05:
       "actor.getTokenDocument is not a function"). A compendium actor, and an
       actor on some versions, does not carry it, and the throw took the whole
       round with it. This is what ace-artificer/scripts/summon-pipeline.mjs has
       always done: use it when it is there, and build the token off the
       prototype when it is not. */
    let data;
    if (typeof actor.getTokenDocument === "function") {
      const proto = await actor.getTokenDocument({
        actorLink: false,
        disposition: key === "red" ? -1 : 1,
        flags: { [NS]: { portalSpawn: key } },
      });
      data = proto.toObject();
    } else {
      data = foundry.utils.mergeObject(actor.prototypeToken.toObject(), {
        actorId: actor.id,
        actorLink: false,
        disposition: key === "red" ? -1 : 1,
      });
      data.flags = foundry.utils.mergeObject(data.flags ?? {}, { [NS]: { portalSpawn: key } });
      console.log(`ACE portals | ${actor.name} has no getTokenDocument, so its token was built `
        + `from its prototype.`);
    }
    // Said twice on purpose: whichever branch built it, these are not optional.
    data.actorId = actor.id;
    data.actorLink = false;
    data.hidden = false;
    data.disposition = key === "red" ? -1 : 1;

    const at = spotSouthOf(portalDoc, data.width ?? 1, data.height ?? 1);
    data.x = at.x;
    data.y = at.y;
    const [tok] = await canvas.scene.createEmbeddedDocuments("Token", [data]);
    if (!tok) return null;
    console.log(`ACE portals | ${actor.name} placed ${at.where} of ${portalDoc.name}.`);

    // The card wants the creature's own portrait, so it travels with the name.
    const out = { name: actor.name, img: actor.img ?? tok.texture?.src ?? "", init: null };
    if (game.combat) {
      let c = game.combat.combatants.find(x => x.tokenId === tok.id);
      if (!c) {
        const [madeC] = await game.combat.createEmbeddedDocuments("Combatant", [{
          tokenId: tok.id, sceneId: canvas.scene.id, actorId: actor.id, hidden: !!tok.hidden,
        }]);
        c = madeC;
      }
      // ⚠️ ONE COMBATANT. No PC, no bystander, and no turn started for the table.
      if (c && c.initiative === null) {
        try { await c.rollInitiative(); }
        catch (err) { console.error("ACE portals | initiative failed for " + actor.name, err); }
      }
      out.init = c?.initiative ?? null;
    }
    return out;
  };

  /**
   * One portal's turn of the round.
   *
   * ⚠️ IT HANDS BACK A ROW, NOT A SENTENCE: { key, creatures: [...], note }. The
   * card draws the dot, the portrait and the name off that, and a row with no
   * creatures is the dot and one word.
   */
  const runPortal = async (key, tableName) => {
    const row = (note, creatures = []) => ({ key, note, creatures });
    const toks = portalTokens(key).filter(alive);
    if (!toks.length) return row("Nothing (no living vortex on this scene)");
    const here = spawnsOf(key).length;
    if (here >= CAP) return row(`Nothing (held at its cap of ${CAP}, ${here} alive)`);

    const table = game.tables.find(t => t.name === tableName);
    if (!table) return row(`Nothing (its table "${tableName}" is missing)`);

    const drawn = await table.draw({ displayChat: false });
    const res = drawn?.results?.[0];
    if (!res) return row("Nothing (the table gave nothing back)");
    const text = res.text ?? res.name ?? "";
    if (/^nothing$/i.test(text)) return row("Nothing");

    // A document row is that actor once; a text row may carry a count.
    let actor = null;
    let count = 1;
    if (res.documentCollection === "Actor" && res.documentId) actor = game.actors.get(res.documentId);
    if (!actor && (res.documentUuid ?? res.uuid)) {
      try { actor = await fromUuid(res.documentUuid ?? res.uuid); } catch (_) { actor = null; }
    }
    /* ⚠️ "TWO SPECTERS" IS TWO OF THE ACTOR NAMED SPECTER. A table row cannot
       carry a count, so the words do: the number comes off the front and the
       plural comes off the end, and what is left is the actor's own name. */
    let wanted = text;
    if (!actor) {
      const m = /^(two|three)\s+(.+?)s?$/i.exec(text);
      wanted = m ? m[2] : text;
      const want = wanted.toLowerCase();
      count = m ? (m[1].toLowerCase() === "three" ? 3 : 2) : 1;
      actor = game.actors.find(a => a.name.toLowerCase() === want)
           ?? game.actors.find(a => a.name.toLowerCase().startsWith(want));
    }
    if (!actor) {
      // Named, not shrugged at: "Specter" is what to go looking for, not "Two Specters".
      console.warn(`ACE portals | the ${key} table rolled "${text}" and there is no actor named `
        + `"${wanted}" in this world, so nothing came through.`);
      return row(`Nothing (no actor named "${wanted}")`);
    }
    if (actor.type === "character" || actor.hasPlayerOwner) {
      return row(`Nothing ("${actor.name}" is a player's creature, so it was NOT placed)`);
    }

    const room = Math.max(0, CAP - here);
    const put = Math.min(count, room);
    const creatures = [];
    const trouble = [];
    for (let i = 0; i < put; i++) {
      /* ⚠️ ONE CREATURE FAILING IS NOT THE ROUND FAILING (his rule, 2026-10-05).
         A throw on the second of two specters used to take the yellow portal's
         whole turn with it. Each one is its own attempt, and what went wrong is
         said and carried onto the card. */
      try {
        const one = await spawn(key, actor, toks[0]);
        if (one) creatures.push(one);
        else trouble.push(`${actor.name} could not be placed`);
      } catch (err) {
        trouble.push(`${actor.name}: ${err.message}`);
        console.error(`ACE portals | ${actor.name} could not be placed from the ${key} vortex:`, err);
      }
    }
    if (put < count) {
      console.log(`ACE portals | the cap of ${CAP} stopped ${count - put} more ${actor.name}.`);
    }
    if (creatures.length) {
      if (trouble.length) console.warn(`ACE portals | ${key}: ${trouble.join("; ")}`);
      return row(null, creatures);
    }
    return row(`Nothing (${trouble.join("; ") || "nothing could be placed"})`);
  };

  /* ⚠️🔴 EVERY PRESS OF THE MACRO RUNS THIS WHOLE FILE AGAIN, and the old version
     reassigned the object below before it checked the armed flag, so the flag
     came back undefined and the hooks were registered a SECOND time. Three
     presses meant three spawn rounds on the next round change. The flag is read
     BEFORE the object is replaced now, and carried over. */
  const wasArmed = globalThis.AcePortals?._armed === true;

  globalThis.AcePortals = {
    CAP,
    LINES,
    async round(why = "the button") {
      if (!game.user.isGM) return;
      // Red first, yellow second: his order, and the card keeps it.
      const rows = [await runPortal("red", "Red Portal"),
                    await runPortal("yellow", "Yellow Portal")];
      console.log(`ACE portals | round (${why}): ` + rows.map(r =>
        `${r.key}: ${r.creatures.length
          ? r.creatures.map(c => `${c.name}${c.init != null ? ` on ${c.init}` : ""}`).join(", ")
          : r.note}`).join(" | "));
      await spawnCard(rows);
      return rows;
    },
    opening() {
      // One chat message. Not a popup, and not whispered: the table hears this.
      return ChatMessage.create({
        content: `<div style="font-size:16px;line-height:1.5">${OPENING}</div>`,
        flags: { [NS]: { portals: "opening" } },
      });
    },
  };

  /* ── The live hooks, armed once per client ──────────────────────────────── */
  if (wasArmed) {
    globalThis.AcePortals._armed = true;
    console.log("ACE portals | the engine was reloaded; the hooks were already armed, so they were "
      + "left exactly as they are. The new code is live.");
    return;
  }
  globalThis.AcePortals._armed = true;

  /* ⚠️ ONCE PER ROUND, NOT PER TURN. `combatRound` fires on the round change, and
     the guard makes sure of it. */
  Hooks.on("combatRound", (combat, changed) => {
    if (game.users.activeGM !== game.user) return;
    if (changed?.round === undefined) return;
    globalThis.AcePortals.round(`round ${changed.round}`).catch(err => console.error(err));
  });

  /* ⚠️ A VORTEX DOES NOT HEAL. An increase to its hit points is dropped before it
     is written, and the console says so. */
  Hooks.on("preUpdateActor", (actor, changes) => {
    if (!actor.getFlag?.(NS, "portal")) return;
    const next = foundry.utils.getProperty(changes, "system.attributes.hp.value");
    if (next === undefined) return;
    const now = Number(actor.system?.attributes?.hp?.value ?? 0);
    if (Number(next) > now) {
      console.log(`ACE portals | ${actor.name} does not heal: ${now} to ${next} refused.`);
      delete changes.system.attributes.hp.value;
    }
  });

  /* Half, then dead: one line each, once each, and the token goes at zero. */
  Hooks.on("updateActor", async (actor, changes) => {
    if (game.users.activeGM !== game.user) return;
    const key = actor.getFlag?.(NS, "portal");
    if (!key || !LINES[key]) return;
    if (foundry.utils.getProperty(changes, "system.attributes.hp.value") === undefined) return;

    const hp = actor.system.attributes.hp ?? {};
    const now = Number(hp.value ?? 0);
    const max = Number(hp.max ?? 0) || 500;

    /* ⚠️ NO "BEFORE" IS NEEDED, AND THAT IS THE POINT. `updateActor` does not
       carry the old value, and a stash written in preUpdateActor only exists on
       the client that made the change. Instead: every threshold at or above the
       number we are now at, that has not been said yet, has been crossed. The
       lowest is the line; all of them are marked, so none can fire later. It is
       the same answer after a reload, and on a second GM client. */
    const said = new Set((actor.getFlag(NS, "portalSaid") ?? []).map(Number));
    const crossed = THRESHOLDS.filter(t => now <= t && !said.has(t));
    const lowest = crossed.length ? Math.min(...crossed) : null;
    const line = lowest === null ? null : LINES[key][lowest];

    if (crossed.length) {
      try { await actor.setFlag(NS, "portalSaid", [...said, ...crossed]); }
      catch (err) {
        console.error("ACE portals | could not write down which thresholds have been said, so one "
          + "may come round again:", err);
      }
    }

    // One card, every hit, whether a threshold went or not.
    try { await hitCard(key, actor.name, now, max, line); }
    catch (err) { console.error(`ACE portals | the ${key} vortex's card would not post:`, err); }
    if (line) {
      await playCrack(now, max);
      console.log(`ACE portals | ${actor.name} at ${now}/${max}: crossed `
        + `${crossed.sort((a, b) => b - a).join(", ")} and said the ${lowest} line.`);
    }

    if (now <= 0 && !actor.getFlag(NS, "portalDown")) {
      await actor.setFlag(NS, "portalDown", true);
      // Hidden, not deleted: the wreck stays on the board for you to remove.
      for (const t of portalTokens(key)) {
        try { await t.update({ hidden: true }); }
        catch (err) { console.warn(`ACE portals | could not hide ${t.name}:`, err); }
      }
      console.log(`ACE portals | the ${key} vortex is at 0: its token is hidden and it spawns `
        + `nothing more.`);
    }
  });

  console.log("ACE portals | armed: one roll per ROUND, no healing, a card the table can see on "
    + "every hit with the ten threshold lines, and the token hides at zero.");
})();
