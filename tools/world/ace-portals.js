/* ─── THE THREE VORTEX ACTORS, AND NOTHING ELSE ───────────────────────────────
 *
 * Red Portal, Yellow Portal, Portal Round and Portal Opening already exist in
 * the world: this run does not create, update or delete a single table or macro.
 * It creates three vehicle actors in the Actor folder named "1. MONSTERS", then
 * reads them back out of that folder and prints FOUND or MISSING for each.
 *
 * ⚠️🔴 WHY THE LAST RUN DIED: an actor's `img` is an IMAGE field, and the JB2A
 * portal loops are .webm. "img: does not have a valid file extension" was the
 * whole of it. The actor's picture is a still now; the TOKEN keeps the video,
 * because a token's texture accepts both. If the token rejects it too, the still
 * goes on the token as well and this says so.
 * ────────────────────────────────────────────────────────────────────────── */
(async () => {
  if (!game.user.isGM) return ui.notifications.warn("ACE: the portals are a GM build.");

  const NS = "world";
  const log = [];
  const say = (s) => { log.push(s); console.log("ACE portals | " + s); };
  const fail = (s) => { log.push("FAILED: " + s); console.error("ACE portals | FAILED: " + s); };

  /* ── THE FOLDER, OR NOTHING ─────────────────────────────────────────────── */
  const FOLDER_NAME = "1. MONSTERS";
  const flat = (s) => String(s ?? "").replace(/\s+/g, "").toLowerCase();
  const actorFolders = game.folders.filter(f => f.type === "Actor");
  const folder = actorFolders.find(f => f.name === FOLDER_NAME)
              ?? actorFolders.find(f => flat(f.name) === flat(FOLDER_NAME))
              ?? null;
  if (!folder) {
    const near = actorFolders.map(f => f.name).sort();
    console.error(`ACE portals | there is no Actor folder named "${FOLDER_NAME}", so nothing was `
      + `built and no folder was created. The Actor folders in this world are:\n  `
      + near.join("\n  "));
    return ui.notifications.error(`ACE: no Actor folder named "${FOLDER_NAME}". Nothing was built.`);
  }
  say(`the folder is "${folder.name}" (id ${folder.id}). No folder was created.`);

  /* ── THE THREE PORTALS ──────────────────────────────────────────────────── */
  // The token wears the JB2A loop. The sheet wears a still of the right colour,
  // all three shipped with Foundry so they are always on disk.
  const loop = (n) =>
    `ALL ASSETS/artwork/08-misc/portal/Portal_1_Vortex_Complete_LOOP_COLOR_${n}_1200x1200.webm`;

  const PORTALS = [
    { key: "blue",   name: "Blue Vortex",   colour: 1, disposition: 1,
      still: "icons/magic/air/wind-vortex-swirl-blue.webp" },
    { key: "red",    name: "Red Vortex",    colour: 2, disposition: -1,
      still: "icons/magic/air/wind-vortex-swirl-red.webp" },
    { key: "yellow", name: "Yellow Vortex", colour: 3, disposition: 1,
      still: "icons/magic/light/explosion-glow-spiral-yellow.webp" },
  ];

  const build = (p, tokenSrc) => ({
    name: p.name,
    type: "vehicle",
    img: p.still,                 // an IMAGE field: never the .webm
    folder: folder.id,
    system: {
      attributes: {
        hp: { value: 500, max: 500, temp: null, tempmax: null, dt: null, mt: null },
        ac: { flat: 18, calc: "flat" },
      },
      traits: { size: "grg" },
    },
    prototypeToken: {
      name: p.name,
      width: 5,
      height: 5,
      texture: { src: tokenSrc },
      disposition: p.disposition,
      actorLink: false,
      locked: true,
      lockRotation: true,
      bar1: { attribute: "attributes.hp" },
    },
    // The flag is how Portal Round finds a portal. Never by its name.
    flags: { [NS]: { portal: p.key } },
  });

  for (const p of PORTALS) {
    let made = null;
    let tokenArt = loop(p.colour);
    try {
      made = await Actor.create(build(p, tokenArt));
      if (!made) throw new Error("Actor.create returned nothing");
    } catch (err) {
      /* ⚠️ IF THE TOKEN REFUSES THE VIDEO, SAY SO AND USE THE STILL. One retry,
         and the message says which picture it ended up with. */
      fail(`"${p.name}" with the video on its token: ${err.message}`);
      console.error(err);
      tokenArt = p.still;
      try {
        made = await Actor.create(build(p, tokenArt));
        if (!made) throw new Error("Actor.create returned nothing on the retry either");
        say(`"${p.name}" was made with the STILL on its token instead of the loop, because the `
          + `token field refused the video.`);
      } catch (err2) {
        fail(`"${p.name}" was not created at all: ${err2.message}`);
        console.error(err2);
        continue;
      }
    }
    const hp = made.system.attributes.hp;
    say(`created "${made.name}": vehicle, ${hp.value}/${hp.max} HP, `
      + `AC ${made.system.attributes.ac.flat}, `
      + `damage threshold ${hp.dt ?? "empty"}, mishap threshold ${hp.mt ?? "empty"}, `
      + `token ${made.prototypeToken.width}x${made.prototypeToken.height}, `
      + `${made.prototypeToken.disposition === -1 ? "hostile" : "friendly"}, `
      + `${made.prototypeToken.actorLink ? "LINKED" : "unlinked"}, `
      + `${made.prototypeToken.locked ? "locked" : "NOT LOCKED"}.`);
    say(`   sheet picture: ${made.img}`);
    say(`   token picture: ${made.prototypeToken.texture.src}`);
  }

  /* ── READ THEM BACK OUT OF THE FOLDER ───────────────────────────────────── */
  // ⚠️ THE ONLY PROOF. Everything above can print success and leave nothing.
  const inFolder = game.actors.filter(a => a.folder?.id === folder.id);
  const want = PORTALS.map(p => p.name);
  const found = [];
  console.log("%cACE portals | READ BACK FROM " + folder.name, "font-weight:700;font-size:14px");
  console.log(`  ${inFolder.length} actor(s) in that folder. The three portals:`);
  for (const n of want) {
    const a = inFolder.find(x => x.name === n);
    if (a) found.push(n);
    console.log(`     ${a ? "FOUND  " : "MISSING"} ${n}`
      + (a ? `  id ${a.id}, ${a.type}, `
           + `${a.system.attributes.hp.value}/${a.system.attributes.hp.max} HP, `
           + `AC ${a.system.attributes.ac.flat}, `
           + `dt ${a.system.attributes.hp.dt ?? "empty"}, mt ${a.system.attributes.hp.mt ?? "empty"}, `
           + `token ${a.prototypeToken.width}x${a.prototypeToken.height}, `
           + `disposition ${a.prototypeToken.disposition}, `
           + `${a.prototypeToken.locked ? "locked" : "not locked"}, `
           + `${a.prototypeToken.actorLink ? "linked" : "unlinked"}, `
           + `portal flag "${a.getFlag(NS, "portal")}", token art ${a.prototypeToken.texture.src}`
         : ""));
  }

  // Said out loud, so there is no doubt about what this run did NOT touch.
  const tables = ["Red Portal", "Yellow Portal"].map(n =>
    `${n}: ${game.tables.find(t => t.name === n) ? "already in the world, untouched" : "NOT FOUND"}`);
  const macs = ["Portal Round", "Portal Opening"].map(n =>
    `${n}: ${game.macros.find(m => m.name === n) ? "already in the world, untouched" : "NOT FOUND"}`);
  console.log("  tables and macros, none of them created or changed by this run:");
  for (const s of [...tables, ...macs]) console.log("     " + s);
  if (game.tables.find(t => t.name === "Blue Portal")) {
    console.log("     Blue Portal: a table by that name EXISTS and should not. Nothing here made it.");
  }

  const ok = found.length === 3;
  console.log(ok ? "%cACE portals | ALL THREE ARE IN THE FOLDER."
    : "%cACE portals | THE RUN FAILED. Missing: " + want.filter(n => !found.includes(n)).join(", "),
    "font-weight:700;font-size:14px;color:" + (ok ? "#9bcc4a" : "#ff1744"));
  for (const l of log) console.log("  " + l);

  if (ok) {
    ui.notifications.info(`ACE: Blue, Red and Yellow Vortex are in "${folder.name}". `
      + `No table or macro was touched.`);
  } else {
    ui.notifications.error("ACE: the portal build FAILED. Missing: "
      + want.filter(n => !found.includes(n)).join(", ") + ". The console says why.");
  }
})();
