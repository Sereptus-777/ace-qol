// ─── ACE QOL — stop apologising for a template we deleted on purpose ────────
//
// Johnny, 2026-08-21: "We have it set so that the template is automatically
// deleted after the cast of a spell. I always get a red pop-up toast saying I
// can't find the template. Can we please get rid of that, because we both know
// why I can't find the template: because it's not back in there anymore?"
//
// He is right, and it is our mess. ACE deletes an instant area template the
// moment the spell resolves. If a Sequencer effect was attached to it — ours,
// or Automated Animations', or anything else — Sequencer then looks for an
// object that no longer exists and throws a red banner across the GM's canvas.
// Nothing is wrong. The effect had already finished. The GM dismisses a scary
// red error after every single area spell for no reason at all.
//
// ⚠️ THE REAL FIX IS UPSTREAM AND IS ALREADY DONE: save-engine now AWAITS
// Sequencer's endEffects before deleting, which it previously did not, so the
// delete no longer races the cleanup meant to prevent this. This file exists
// for the case awaiting cannot reach — an effect owned by a DIFFERENT client's
// Sequencer, which we cannot end from here.
//
// ⚠️ SUPPRESSION IS THE MOST DANGEROUS THING IN THIS CODEBASE. A filter that is
// slightly too wide hides a real failure and makes it unfindable, which is the
// exact class of bug that has cost days on this project. So this one is:
//
//   NARROW  — one message pattern, naming MeasuredTemplate specifically.
//   TIMED   — only within a few seconds of US deleting a template. Outside
//             that window nothing is touched, so the identical error from an
//             unrelated cause still reaches the screen.
//   LOUD    — every swallowed message is written to the console, so it is
//             hidden from the toast, never from an investigation.

const LOG = "ace-qol | Templates";

// The one message. Sequencer's own wording, with the object type pinned so a
// missing TOKEN or TILE never matches.
const SEQUENCER_LOST_TEMPLATE =
  /Sequencer.*EffectManager.*could not find object with ID.*MeasuredTemplate/i;

let _until = 0;
let _installed = false;
let _swallowed = 0;

/**
 * Open the window. Called immediately before ACE deletes a template it owns.
 * @param {number} [ms] how long to stay armed
 */
export function armTemplateNoiseGuard(ms = 4000) {
  _until = Date.now() + ms;
}

function _shouldSwallow(args) {
  if (Date.now() > _until) return false;          // not our doing
  const text = args.map(a => {
    if (a instanceof Error) return `${a.message} ${a.stack ?? ""}`;
    if (typeof a === "string") return a;
    try { return JSON.stringify(a); } catch (_) { return String(a); }
  }).join(" ");
  return SEQUENCER_LOST_TEMPLATE.test(text);
}

export function installTemplateNoiseGuard() {
  if (_installed) return;
  const n = globalThis.ui?.notifications;
  if (!n) return;
  _installed = true;

  for (const level of ["error", "warn"]) {
    const original = n[level]?.bind(n);
    if (typeof original !== "function") continue;
    n[level] = (...args) => {
      if (_shouldSwallow(args)) {
        _swallowed++;
        // ⚠️ Say it somewhere. Hidden from the GM's screen, never from a log.
        console.debug(`${LOG} | suppressed a Sequencer "missing template" ${level} ` +
                      `right after ACE deleted an instant template (${_swallowed} so far this session).`);
        return null;
      }
      return original(...args);
    };
  }
  console.debug(`${LOG} | instant-template cleanup noise will be kept off screen`);
}
