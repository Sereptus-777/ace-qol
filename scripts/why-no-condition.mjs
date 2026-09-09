// ─── ACE: QOL — "It failed the save and nothing happened to it" ─────────────
//
// Johnny, 2026-09-08: *"I cast Fear on the specter who is not immune to Fear,
// and it failed. Does not have the Fear effect on him."*
//
// ⚠️🔴 THE ANSWER WAS ALREADY BEING PRINTED, INTO A CONSOLE NOBODY WAS WATCHING.
// `_applyFailedSaveConditions` can decline for eight different reasons and
// every one of them logs a line saying which. That is no use to him at the
// table: by the time he notices the creature is unaffected, the cast is three
// messages back and the console has moved on.
//
// So this asks the question on purpose, at any time, against the creature he
// has selected:
//
//     game.aceQol.whyNoCondition("Fear")
//
// ⚠️ IT RUNS THE REAL FUNCTION, WITH A DRY-RUN FLAG. A read-only copy of that
// decision chain would be two answers to one question, which is the exact fault
// this engine has spent a week having rebuilt out of it. Same code, same gates,
// same order, nothing written.
//
// ⚠️ MODULE_ID HARDCODED, matching the convention here: this file is reached
// from the entry file, so importing it back is a cycle that throws at load.
// ──────────────────────────────────────────────────────────────────────────────

const MODULE_ID = "ace-qol";
const LOG = `${MODULE_ID} | whyNoCondition`;

import { resolveItem } from "./inference/snapshot.mjs";

/**
 * Why would this spell's on-fail condition not land on the selected creature?
 *
 * @param {string|object} what      a spell name, a uuid, or the item itself
 * @param {object} [opts]
 * @param {object} [opts.victim]    a token to test against; defaults to the
 *                                  first SELECTED token, then the first TARGET
 * @returns {Promise<object|null>}
 */
export async function whyNoCondition(what, { victim = null } = {}) {
  const engine = globalThis.game?.aceQol?.saveEngine ?? null;
  if (!engine?._applyFailedSaveConditions) {
    console.warn(`${LOG} | the save engine is not up yet.`);
    return null;
  }

  // ── Which spell ──
  const found = resolveItem(what, { lastPress: null });
  if (!found.item) { console.warn(`${LOG} | ${found.note}`); return null; }
  const item = found.item;

  // ── Which creature ──
  // ⚠️ SELECTED FIRST, THEN TARGETED. He selects the thing he is asking about;
  // targets are usually left over from the cast that just failed him.
  const token = victim
    ?? globalThis.canvas?.tokens?.controlled?.[0]
    ?? [...(globalThis.game?.user?.targets ?? [])][0]
    ?? null;
  if (!token?.actor) {
    console.warn(`${LOG} | select the creature you want to test first, then run `
      + `this again. Nothing is selected and nothing is targeted.`);
    return null;
  }

  // ── The save it would have failed ──
  // Read from the item so the answer is about the real spell, not a guess.
  let saveAbility = null, saveDC = null, activityId = null;
  try {
    const acts = [...(item.system?.activities?.values?.() ?? [])];
    const act = acts.find(a => a?.save?.ability) ?? acts[0] ?? null;
    activityId = act?.id ?? null;
    const ab = act?.save?.ability;
    saveAbility = (ab instanceof Set || Array.isArray(ab)) ? [...ab][0] : (ab ? String(ab) : null);
    saveDC = Number(act?.save?.dc?.value ?? act?.save?.dc) || null;
  } catch (_) { /* the applier has its own fallback for both */ }

  // A result shaped exactly like a genuinely failed save.
  const result = {
    name: token.name,
    tokenDocId: token.document?.id ?? token.id,
    actorId: token.actor?.id ?? null,
    sceneId: globalThis.canvas?.scene?.id ?? null,
    passed: false,
    pending: false,
  };

  console.log(`${LOG} | asking what "${item.name}" would do to ${token.name} on a `
    + `failed ${saveAbility ? saveAbility.toUpperCase() : "?"} save`
    + `${saveDC ? ` (DC ${saveDC})` : ""}. Nothing will be written.`);

  let applied = [];
  try {
    applied = await engine._applyFailedSaveConditions(item, [result], {
      saveAbility, saveDC, activityId,
      casterActor: item.actor ?? null,
      dryRun: true,
    }) ?? [];
  } catch (err) {
    console.error(`${LOG} | the decision chain threw, which is itself the answer:`, err);
    return { item: item.name, target: token.name, threw: String(err?.message ?? err) };
  }

  const mine = applied.find(a => a?.tokenDocId === result.tokenDocId) ?? applied[0] ?? null;

  // ⚠️ SAY WHICH OF THE THREE OUTCOMES IT WAS, IN WORDS. "Nothing applied" and
  // "immune" and "it would have worked" must never read the same.
  if (mine?.conditions?.length) {
    console.log(`${LOG} | ✅ it WOULD land: ${mine.conditions.join(", ")} on ${token.name}. `
      + `If the real cast left nothing on it, the failure is downstream of this `
      + `decision — in the condition library or the effect write.`);
  } else if (mine?.immune?.length) {
    console.log(`${LOG} | \U0001f6d1 ${token.name} is IMMUNE to ${mine.immune.join("/")}, `
      + `so the whole chain is skipped. That is the answer.`);
  } else {
    console.log(`${LOG} | ❌ nothing would be applied. The reason was printed by the `
      + `decision itself, in the line or two directly above this one.`);
  }

  return { item: item.name, target: token.name, saveAbility, saveDC, applied };
}
