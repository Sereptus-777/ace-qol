// ─── ACE: QOL — Opportunity-Attack transient signal ─────────────────────────
// A tiny zero-dependency module holding the set of actor IDs that are CURRENTLY
// mid opportunity-attack. It exists so two otherwise-unrelated files can share
// a synchronous in-memory flag without a circular import:
//
//   • OAPrompt.fireOAAttack (oa-prompt.mjs) adds the reactor's actor id right
//     before it fires the attack via item.use(), and removes it afterward.
//   • AttackPipeline._onPreAttackRoll (attack-pipeline.mjs) reads it and SKIPS
//     the range/reach rejection for that swing.
//
// Why: RAW, an opportunity attack "occurs right before the creature leaves your
// reach" (PHB 195). But by the time the player clicks "Take OA," the token has
// already finished its move and is sitting out of reach — so the normal range
// check would wrongly cancel the swing ("out of range — 10ft away"). The OA was
// already validated as in-reach at trigger time, so we suppress the re-check.
//
// In-memory only, per client. Both fireOAAttack and the pre-roll hook run on the
// SAME client (whoever clicked), so the flag is always visible across the bridge.
export const OA_IN_FLIGHT = new Set();
