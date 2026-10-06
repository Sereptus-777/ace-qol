/* ─── TWO NARRATION BUTTONS ────────────────────────────────────────────────────
 *
 * Updates "Portal Opening" in place and adds "The Temple". It does not go near
 * the portals, the tables or Portal Round.
 *
 * Both read through ACE Engine's narrator, and both use the earthquake the
 * narration panel's own button uses. No file is named for it, because there is
 * no file: that button is a procedural rumble in ace-engine/scripts/sfx.mjs. The
 * macros call the same path the button does, so whatever it plays, they play.
 *
 *   Portal Opening — the text, then the boom four seconds later, full force.
 *   The Temple     — the quieter rumble as the text starts, no screen shake.
 * ────────────────────────────────────────────────────────────────────────── */
(async () => {
  if (!game.user.isGM) return ui.notifications.warn("ACE: these are GM buttons.");

  const OPENING = "The Shield Guardian is finished. In the quiet after it, Jeth is already moving. "
    + "He slips across the hall to the double doors, head cocked, like a man who heard something the "
    + "rest of you did not.\n\n"
    + "Then the boom.\n\n"
    + "The doors blow inward. Jeth is thrown back and hits the floor. Stunned. Prone. He looks at "
    + "you, wild and amazed, and then he looks back at what the doors have opened onto.";

  const TEMPLE = "The doors have opened on a temple.\n\n"
    + "Four columns of black marble hold a vaulted ceiling. Amber coats the walls, honey poured over "
    + "stone and left to set. At the far end stands a statue forty feet tall. A cowled figure. "
    + "Flowing robes. Both hands raised, caught halfway through a spell. Where its face should be, "
    + "there is nothing. Not a shadow. A hole.\n\n"
    + "Black marble balconies flank it. One has broken and lies in a heap before an open doorway. "
    + "Smaller statues of wizards stand about the floor, staffs that were gold and are peeling. The "
    + "one to the northeast has fallen and is in pieces.\n\n"
    + "The air is cold and does not move. High in the walls, slits that the amber makes hard to "
    + "see.\n\n"
    + "Across that floor, where the faceless thing can see all of it, three vortexes are burning. "
    + "Blue. Red. Yellow. Two dragons are already tearing at each other. The gold one has put herself "
    + "between the red and the doorway you are standing in. She looks at you. Not at the fight. The "
    + "look says go.";

  /* The body both macros share: speak, and shake. */
  const BODY = (text, { quiet, delayMs }) => `
(async () => {
  const TEXT = ${JSON.stringify(text)};
  const QUIET = ${quiet ? "true" : "false"};
  const DELAY = ${delayMs};
  const eng = game.modules.get("ace-engine");
  const api = eng?.api ?? null;

  /* ⚠️ THE NARRATOR, AND IT SAYS WHEN IT CANNOT SPEAK. api.narrate asks the
     panel; the panel's own method is _narrateText. Both are tried, because one
     of them was broken for a long time without a word. */
  const speak = async () => {
    try {
      const out = api?.narrate?.(TEXT);
      if (out !== undefined) { await out; return "api.narrate"; }
    } catch (err) { console.warn("ACE | api.narrate threw:", err); }
    const panel = ui.windows ? Object.values(ui.windows).find(w => typeof w?._narrateText === "function")
      : null;
    const direct = panel ?? Object.values(globalThis.ui?.windows ?? {})
      .find(w => typeof w?._narrateText === "function");
    if (direct) { await direct._narrateText(TEXT); return "the panel's _narrateText"; }
    // Nothing to speak through: the words still reach the table.
    await ChatMessage.create({
      content: '<div style="background:#14100c;border-left:4px solid #c6a15a;border-radius:4px;'
        + 'padding:10px 12px;color:#f3ead7;font-size:16px;line-height:1.6;white-space:pre-wrap;">'
        + foundry.utils.escapeHTML(TEXT) + '</div>',
      flags: { world: { narration: true } },
    });
    ui.notifications?.warn("ACE: the narration panel is not open, so the text was posted to chat "
      + "instead. Open ACE Engine and press again for the narrator.");
    return "a chat card, because no narrator was open";
  };

  /* ⚠️ THE SAME EARTHQUAKE THE PANEL'S BUTTON USES. No file: that button is a
     procedural rumble. "earthquakeQuiet" is the same rumble turned down with no
     screen shake, for reading a room rather than kicking a door in. */
  const boom = () => {
    const effect = QUIET ? "earthquakeQuiet" : "earthquake";
    if (typeof api?.triggerSfx !== "function") {
      console.warn("ACE | ace-engine's triggerSfx is not on its API, so no rumble played. "
        + "The text still ran.");
      return;
    }
    try { api.triggerSfx(effect); }
    catch (err) { console.warn("ACE | the rumble would not play:", err); }
  };

  if (DELAY > 0) {
    const how = await speak();
    console.log("ACE | narration through " + how + "; the boom lands in " + (DELAY / 1000) + "s.");
    setTimeout(boom, DELAY);
  } else {
    boom();
    const how = await speak();
    console.log("ACE | the quiet rumble started, and the narration went through " + how + ".");
  }
})();
`;

  const MACROS = [
    { name: "Portal Opening", img: "icons/magic/light/explosion-star-glow-silhouette.webp",
      command: BODY(OPENING, { quiet: false, delayMs: 4000 }) },
    { name: "The Temple", img: "icons/environment/wilderness/statue-hooded.webp",
      command: BODY(TEMPLE, { quiet: true, delayMs: 0 }) },
  ];

  const report = [];
  for (const m of MACROS) {
    const found = game.macros.find(x => x.name === m.name);
    try {
      if (found) {
        // Updated in place: same document, same id, same hotbar slot.
        await found.update({ command: m.command, img: m.img, type: "script", scope: "global" });
        report.push(`"${m.name}" updated in place (id ${found.id}, ${m.command.length} chars).`);
      } else {
        const made = await Macro.create({ name: m.name, type: "script", scope: "global",
          img: m.img, command: m.command, flags: { world: { narration: true } } });
        report.push(`"${m.name}" created (id ${made.id}, ${m.command.length} chars).`);
      }
    } catch (err) {
      report.push(`FAILED on "${m.name}": ${err.message}`);
      console.error(err);
    }
  }

  // Read them back: the only proof.
  console.log("%cACE | the two narration buttons", "font-weight:700;font-size:14px");
  for (const r of report) console.log("  " + r);
  let ok = true;
  for (const m of MACROS) {
    const live = game.macros.find(x => x.name === m.name);
    const right = !!live && live.command.includes("earthquake");
    if (!right) ok = false;
    console.log(`     ${live ? (right ? "FOUND  " : "WRONG  ") : "MISSING"} ${m.name}`
      + (live ? `  ${live.command.length} chars, quiet rumble: `
        + `${live.command.includes("QUIET = true") ? "yes" : "no"}, `
        + `delay: ${/DELAY = (\d+)/.exec(live.command)?.[1] ?? "?"}ms` : ""));
  }
  console.log("  The portals, the tables and Portal Round were not touched.");
  if (ok) ui.notifications.info("ACE: Portal Opening updated and The Temple added.");
  else ui.notifications.error("ACE: one of the narration macros did not land. The console says which.");
})();
