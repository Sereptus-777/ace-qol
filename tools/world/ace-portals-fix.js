/* ─── SOUTH, THE RIGHT ANIMATION, AND A DOUBLE-ARM BUG ────────────────────────
 *
 * Creates nothing. No actor, no table, no macro, no folder. It edits three
 * things that already exist:
 *
 *   1. the token texture on the three vortex actors, and on any of their tokens
 *      already standing on a scene, to the three files you named,
 *   2. the placement inside the engine that Portal Round already carries, so
 *      spawns come out SOUTH of the portal,
 *   3. the arming guard in that same engine, because every press of the macro
 *      re-ran the engine and registered the round hook AGAIN. Three presses, three
 *      spawn rounds on the next round change. That is fixed in the same edit.
 *
 * The actor portraits are not touched: they stay the stills.
 * ────────────────────────────────────────────────────────────────────────── */
(async () => {
  if (!game.user.isGM) return ui.notifications.warn("ACE: this is a GM fix.");

  const NS = "world";
  const log = [];
  const say = (s) => { log.push(s); console.log("ACE portals fix | " + s); };
  const fail = (s) => { log.push("FAILED: " + s); console.error("ACE portals fix | FAILED: " + s); };

  const ART = {
    "Blue Vortex":   "modules/jb2a_patreon/Library/Generic/Template/Circle/Vortex_01_Regular_Blue_600x600.webm",
    "Red Vortex":    "modules/jb2a_patreon/Library/Generic/Template/Circle/Vortex_01_Regular_Red_600x600.webm",
    "Yellow Vortex": "modules/jb2a_patreon/Library/Generic/Template/Circle/Vortex_01_Regular_Yellow_600x600.webm",
  };

  /* ── 1. THE TOKEN ART ───────────────────────────────────────────────────── */
  const FOLDER_NAME = "1. MONSTERS";
  const flat = (s) => String(s ?? "").replace(/\s+/g, "").toLowerCase();
  const folder = game.folders.find(f => f.type === "Actor" && f.name === FOLDER_NAME)
              ?? game.folders.find(f => f.type === "Actor" && flat(f.name) === flat(FOLDER_NAME));
  if (!folder) return ui.notifications.error(`ACE: no Actor folder named "${FOLDER_NAME}".`);

  for (const [name, src] of Object.entries(ART)) {
    const actor = game.actors.find(a => a.name === name && a.folder?.id === folder.id)
               ?? game.actors.find(a => a.name === name);
    if (!actor) { fail(`"${name}" is not in this world, so nothing was changed for it.`); continue; }

    // The prototype, so every token dropped from now on is right.
    try {
      await actor.update({ "prototypeToken.texture.src": src });
      say(`"${name}" token art is now ${src}`);
    } catch (err) {
      fail(`"${name}" token art could not be set: ${err.message}`);
      console.error(err);
      continue;
    }
    // ⚠️ AND THE ONE ALREADY ON THE MAP. A placed token copied the old picture
    // when it was dropped; changing the prototype alone leaves it wrong.
    let moved = 0;
    for (const scene of game.scenes) {
      const toks = scene.tokens.filter(t => t.actorId === actor.id || t.actor?.id === actor.id);
      for (const t of toks) {
        try { await t.update({ "texture.src": src }); moved++; }
        catch (err) { fail(`a "${name}" token on "${scene.name}" kept its old art: ${err.message}`); }
      }
    }
    say(`   ${moved} token(s) already on a scene were repainted. The portrait was left alone `
      + `(${actor.img}).`);
  }

  /* ── 2 and 3. THE ENGINE INSIDE THE MACROS ──────────────────────────────── */
  let engine = "";
  try {
    const r = await fetch(`/modules/ace-qol/tools/world/ace-portals-engine.js?v=${Date.now()}`);
    if (!r.ok) throw new Error(`the server answered ${r.status}`);
    engine = await r.text();
    if (!engine.includes("spotSouthOf") || !engine.includes("const wasArmed")
        || !engine.includes("const spawnCard")) {
      throw new Error("that file is not the fixed engine");
    }
    say(`the fixed engine was read: ${engine.length} characters.`);
  } catch (err) {
    fail(`the engine could not be read, so the macros were left alone: ${err.message}`);
    console.error(err);
  }

  if (engine) {
    for (const name of ["Portal Round", "Portal Opening"]) {
      const macro = game.macros.find(m => m.name === name);
      if (!macro) { fail(`the macro "${name}" is not in this world.`); continue; }
      const old = macro.command ?? "";
      // Keep whatever tail that macro ends with: the engine is everything up to
      // the final call, and only the engine is replaced.
      const marker = "})();";
      const cut = old.lastIndexOf(marker);
      const tail = cut >= 0 ? old.slice(cut + marker.length) : "";
      const next = engine + tail;
      try {
        await macro.update({ command: next });
        say(`"${name}" now carries the fixed engine: ${old.length} characters became ${next.length}, `
          + `and its own last line was kept (${tail.trim() || "none"}).`);
      } catch (err) {
        fail(`"${name}" could not be updated: ${err.message}`);
        console.error(err);
      }
    }

    // Make tonight's session use it without waiting for a press.
    try {
      // eslint-disable-next-line no-eval
      eval(engine);
      say("the live engine on this client is the fixed one; the hooks were not armed twice.");
    } catch (err) {
      fail(`the live engine could not be reloaded (${err.message}); press Portal Round once.`);
      console.error(err);
    }
  }

  /* ── READ IT BACK ───────────────────────────────────────────────────────── */
  console.log("%cACE portals fix | READ BACK", "font-weight:700;font-size:14px");
  let ok = true;
  for (const [name, src] of Object.entries(ART)) {
    const a = game.actors.find(x => x.name === name);
    const right = a?.prototypeToken?.texture?.src === src;
    if (!a || !right) ok = false;
    console.log(`     ${a ? (right ? "OK     " : "WRONG  ") : "MISSING"} ${name}`
      + (a ? `  token ${a.prototypeToken.texture.src}  portrait ${a.img}` : ""));
    for (const scene of (game.scenes ?? [])) {
      for (const t of scene.tokens.filter(t => t.actorId === a?.id)) {
        const tr = t.texture?.src === src;
        if (!tr) ok = false;
        console.log(`        ${tr ? "OK     " : "WRONG  "} on "${scene.name}": ${t.texture?.src}`);
      }
    }
  }
  for (const name of ["Portal Round", "Portal Opening"]) {
    const m = game.macros.find(x => x.name === name);
    const south = !!m && m.command.includes("spotSouthOf");
    const armed = !!m && m.command.includes("const wasArmed");
    const rows = !!m && m.command.includes("const spawnCard");
    const good = south && armed && rows;
    if (!m || !good) ok = false;
    console.log(`     ${m ? (good ? "OK     " : "WRONG  ") : "MISSING"} ${name}`
      + (m ? `  south placement: ${south ? "yes" : "NO"}, safe re-arm: ${armed ? "yes" : "NO"}, `
           + `two-row spawn card: ${rows ? "yes" : "NO"}, ${m.command.length} chars` : ""));
  }
  console.log(ok ? "%cACE portals fix | everything reads back correct."
    : "%cACE portals fix | SOMETHING IS WRONG above.",
    "font-weight:700;font-size:14px;color:" + (ok ? "#9bcc4a" : "#ff1744"));
  for (const l of log) console.log("  " + l);

  if (ok) ui.notifications.info("ACE: south placement, the right vortex art, and the double-arm bug fixed.");
  else ui.notifications.error("ACE: the fix did not fully land. The console says which part.");
})();
