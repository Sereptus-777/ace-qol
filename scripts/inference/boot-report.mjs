// ─── What the engine did, said once, at boot ────────────────────────────────
//
// ⚠️ AN ENGINE THAT WORKS SILENTLY IS INDISTINGUISHABLE FROM ONE THAT IS OFF.
// This suite has lost whole sessions to that: 80 silent early returns, a boot
// API check that only ever ran when typed by hand, thirteen condition ghosts
// that survived every load without a word. The inference engine changes how
// unregistered items resolve, so it says so, once, to the GM.
//
// ⚠️ `Hooks.once("ready")` FROM INSIDE `ready` NEVER FIRES. Every ACE subsystem
// starts from the entry file's own ready handler, so waiting on `ready` here
// would wait on an event already in progress: nothing throws, nothing logs, and
// the report silently never runs. `if (game.ready) run(); else once(...)`.
const MODULE_ID = "ace-qol";

import { LearnedStore } from "./learned-store.mjs";

function report() {
  try {
    if (!game.user?.isGM) return;

    const on = game.settings.get(MODULE_ID, "inferenceEngine") !== false;
    const s = LearnedStore.summary();

    if (!on) {
      console.log(`${MODULE_ID} | the inference engine is OFF. Only hand-written `
        + `entries are used; everything else runs through the generic engine.`);
      return;
    }
    if (s.unreadable) {
      // ⚠️ "COULD NOT READ IT" AND "NOTHING IS THERE" MUST NEVER PRINT THE SAME.
      console.warn(`${MODULE_ID} | the inference engine is on, but what it has `
        + `learned could not be read. It will work things out again this session `
        + `and may not be able to remember them.`);
      return;
    }
    const shapes = Object.entries(s.byShape ?? {})
      .sort((a, b) => b[1] - a[1]).map(([k, v]) => `${v} ${k}`).join(", ");
    console.log(`${MODULE_ID} | inference engine on. `
      + (s.total
        ? `${s.total} item(s) worked out and remembered${s.corrected ? `, ${s.corrected} corrected by you` : ""}`
          + (shapes ? ` (${shapes})` : "")
        : "nothing worked out yet; it reads items as they are first used")
      + `. game.aceQol.reviewInference() lists them with the reasons.`);
  } catch (err) {
    console.warn(`${MODULE_ID} | the inference engine's boot report failed `
      + `(the engine itself is unaffected):`, err);
  }
}

export function registerInferenceBootReport() {
  if (game.ready) report();
  else Hooks.once("ready", report);
}
