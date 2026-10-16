// ─── HIS PORTAL FIGHT ARMS ITSELF ────────────────────────────────────────────
//
// The Amber Temple portal fight (tools/world/ace-portals-engine.js, built
// 2026-10-05) armed its hooks only when "Portal Spawn" or "Portal Opening" was
// pressed. Johnny always hard-reloads, so after every reload the three vortexes
// spawned nothing, posted no hit cards and cracked no thunder until somebody
// remembered a button, and "Portal Opening" also speaks the opening he has
// replaced with ACE Engine's saved narrations (his words, 2026-10-15: "Fuck what
// was in there before").
//
// Now ACE loads the same engine file when the world starts, on a GM's screen,
// and only in a world that has a portal actor (one tagged red, yellow or blue).
// There is still ONE copy of the engine: the file. The two macros keep working
// as buttons, and the engine's own armed flag stops a press from arming twice.
// ──────────────────────────────────────────────────────────────────────────────

const MODULE_ID = "ace-qol";

/** The world's portal actors, by the tag the portal engine reads. */
export function portalActorsIn(actors) {
  return [...(actors ?? [])].filter(a => ["red", "yellow", "blue"].includes(a?.flags?.world?.portal));
}

export async function armWorldPortals() {
  // SILENT-OK: the portal fight runs on a GM's screen, exactly as its macros always did
  if (!game.user?.isGM) return;
  const portals = portalActorsIn(game.actors);
  // SILENT-OK: this world has no portal fight to arm
  if (!portals.length) return;
  if (globalThis.AcePortals?._armed) {
    console.log(`${MODULE_ID} | the portal fight was already armed on this screen.`);
    return;
  }
  try {
    await import("../tools/world/ace-portals-engine.js");
    if (!globalThis.AcePortals?._armed) throw new Error("the engine loaded but did not arm itself");
    console.log(`${MODULE_ID} | the portal fight armed itself on load (${portals.map(a => a.name).join(", ")}): `
      + "spawns every round, hit cards and the crack, no button needed.");
  } catch (err) {
    console.error(`${MODULE_ID} | the portal fight could not arm itself:`, err);
    ui.notifications?.error("ACE: the portal fight did not switch itself on. Press the Portal Spawn macro once; the console says why.");
  }
}
