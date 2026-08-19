// ─── ACE QOL — keep Foundry's hook tracer switched off ───────────────────────
//
// ⚠️🔴 TEN MINUTES TO LOAD, AND IT WAS ONE LINE IN ANOTHER MODULE.
// `CONFIG.debug.hooks = true` makes Foundry log the NAME AND FULL ARGUMENTS of
// every hook it fires. Foundry fires tens of thousands during startup — one per
// wall refresh, one per token draw, one per light source, per frame — and each
// one serialises a live document into devtools. The console does not just fill
// up, it becomes the bottleneck: a hard reload went from seconds to ~10 minutes
// on Johnny's world (2026-08-19), and the real warnings we print were buried in
// the middle of it. The falling bug the same night had been printing its exact
// cause since the 13th and nobody could see it.
//
// `chat-images/chat-images.js:2201` sets it unconditionally, from its own init
// hook. Almost certainly a debugging line that shipped.
//
// ⚠️ WHY THIS IS A PROPERTY GUARD AND NOT A CLEANUP.
// ace-engine already had `if (CONFIG.debug?.hooks) CONFIG.debug.hooks = false`
// and it did nothing useful, for two reasons worth remembering:
//   1. it ran at `ready`, which is AFTER canvas draw, token draw, wall refresh
//      and lighting — i.e. after the entire flood had already been paid for.
//   2. it sat behind that module's enabled check, so disabling Engine disabled
//      the cleanup too.
// Turning a flag off after the damage is done is not a fix. A setter that
// refuses the write does not care who runs first, or when.
//
// ⚠️ IT IS NOT SILENT. Blocking another module's write and saying nothing is
// the kind of invisible behaviour this codebase has been burned by. It names
// the module that tried, once, and tells you how to override it.

const MODULE_ID = "ace-qol";

let _installed = false;
let _value     = false;
let _announced = false;

/** Which module does this stack trace come from? */
function _blame() {
  try {
    const stack = new Error().stack ?? "";
    // Skip our own frames; find the first module path that is not us.
    for (const line of stack.split("\n").slice(2)) {
      const m = /\/modules\/([\w.-]+)\//.exec(line);
      if (m && m[1] !== MODULE_ID) return m[1];
    }
  } catch (_) { /* naming is a courtesy, never a requirement */ }
  return null;
}

/**
 * Install the guard. Call as EARLY as possible — `init` at file scope.
 * Safe to call twice.
 */
export function installHookDebugGuard() {
  if (_installed) return;
  try {
    const dbg = CONFIG?.debug;
    if (!dbg) return;

    // Whatever it is right now, it is off. Something may have set it already.
    _value = false;
    _installed = true;

    Object.defineProperty(dbg, "hooks", {
      configurable: true,
      enumerable: true,
      get: () => _value,
      set: (v) => {
        if (!v) { _value = false; return; }
        const who = _blame();
        if (!_announced) {
          _announced = true;
          console.warn(
            `${MODULE_ID} | Refused to switch on Foundry's hook tracer` +
            (who ? ` for "${who}"` : "") + `. ` +
            `CONFIG.debug.hooks logs every hook and its arguments — tens of thousands ` +
            `during startup — which is what turns a reload into a ten-minute wait and ` +
            `buries every real warning. If you actually want it, run ` +
            `game.aceQol.debugHooks(true).`);
        }
        _value = false;   // refuse
      },
    });
  } catch (err) {
    console.warn(`${MODULE_ID} | Could not guard CONFIG.debug.hooks:`, err);
  }
}

/**
 * The escape hatch. A real human debugging real hooks can still have it.
 * @param {boolean} on
 */
export function setHookDebug(on) {
  _value = !!on;
  console.log(`${MODULE_ID} | Foundry hook tracing is now ${_value ? "ON — expect a flood" : "off"}.`);
  return _value;
}
