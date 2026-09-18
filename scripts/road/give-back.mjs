// ─── ACE: QOL — WHAT A PRESS SPENT, GIVEN BACK WHEN NOTHING HAPPENED ─────────
//
// dnd5e takes what a press costs BEFORE any of ACE runs: a daily use, a
// recharge, a legendary action, a charge, hit dice, an item used up. It writes
// down exactly what it took on the usage message (`system.deltas`), and it does
// so even when ACE has stopped that card being created: the payload the usage
// hook hands over carries the same record. Its own `activity.refund` puts every
// one of those back, which is all the Refund button on its card ever did,
// before clearing the record so it cannot be given back twice.
//
// ⚠️🔴 ACE STOPS THAT CARD, AND THE REFUND BUTTON WENT WITH IT. So when the spell
// pipeline abandoned a cast - the picker closed, the area never placed, a spell
// ACE cannot resolve - it kept the slot it had held back and left everything
// else spent, with no way back but the sheet. His world, 2026-09-18: 1,361 items
// the pipeline owns spend something on the press. Vistana Spy's Curse (once a
// long rest), a Gray Slaad's Fly (twice a day) and Akra's free Command were each
// cancelled at the picker and stayed spent, under a toast that said "slot not
// consumed".
//
// Written for the Teleport hop in 0.34.60 and moved here so that every way a
// cast is abandoned gives back through this one helper.
//
// ⚠️ IMPORTS NOTHING, so the spell pipeline and Teleport can both read it with
// no import cycle (a binding read at load inside a cycle kills the module).
// ──────────────────────────────────────────────────────────────────────────────

const LOG = "ace-qol | give back";

/** How many separate things dnd5e's record says a press spent. */
export function spentCount(deltas) {
  if (!deltas || typeof deltas !== "object") return 0;
  const list = (v) => (Array.isArray(v) ? v.length : 0);
  return list(deltas.actor)
    + Object.values(deltas.item ?? {}).reduce((n, changes) => n + list(changes), 0)
    + list(deltas.created) + list(deltas.deleted);
}

/**
 * What dnd5e's record says a press spent, in words for a toast and a log line:
 * "a use of Curse", "Cold Breath's recharge", "a legendary action".
 */
export function describeSpent(deltas, actor = null) {
  const words = [];
  const many = (n, one, lots) => (n === 1 ? one : `${n} ${lots}`);
  for (const { keyPath, delta } of (Array.isArray(deltas?.actor) ? deltas.actor : [])) {
    const n = Math.abs(Number(delta) || 0);
    const slot = /^system\.spells\.spell(\d)\.value$/.exec(String(keyPath ?? ""));
    if (keyPath === "system.resources.legact.spent") words.push(many(n, "a legendary action", "legendary actions"));
    else if (slot) words.push(many(n, `a level ${slot[1]} slot`, `level ${slot[1]} slots`));
    else if (keyPath === "system.spells.pact.value") words.push(many(n, "a pact slot", "pact slots"));
    else if (/^system\.attributes\.hp\./.test(String(keyPath ?? ""))) words.push(`${n} hit points`);
    else words.push(`what it took from ${String(keyPath ?? "the sheet").replace(/^system\./, "")}`);
  }
  for (const [id, changes] of Object.entries(deltas?.item ?? {})) {
    const item = actor?.items?.get?.(id) ?? null;
    const name = item?.name ?? "an item";
    for (const { keyPath, delta } of (Array.isArray(changes) ? changes : [])) {
      const n = Math.abs(Number(delta) || 0);
      const own = keyPath === "system.uses.spent";
      if (own || /^system\.activities\.[^.]+\.uses\.spent$/.test(String(keyPath ?? ""))) {
        const recharges = own && (item?.system?.uses?.recovery ?? []).some(r => r?.period === "recharge");
        words.push(recharges ? `${name}'s recharge` : many(n, `a use of ${name}`, `uses of ${name}`));
      } else if (keyPath === "system.quantity") words.push(many(n, `one ${name}`, `of ${name}`));
      else if (keyPath === "system.hd.spent") words.push(many(n, "a hit die", "hit dice"));
      else words.push(name);
    }
  }
  for (const data of (Array.isArray(deltas?.deleted) ? deltas.deleted : [])) words.push(data?.name ?? "an item it used up");
  const made = Array.isArray(deltas?.created) ? deltas.created.length : 0;
  if (made) words.push(made === 1 ? "the item it made" : `the ${made} items it made`);
  const said = [...new Set(words)];
  if (!said.length) return "what it spent";
  return said.length === 1 ? said[0] : `${said.slice(0, -1).join(", ")} and ${said[said.length - 1]}`;
}

/**
 * Nothing happened, so give back what pressing it spent, through dnd5e's own
 * refund. A slot the spell pipeline held back was never taken, so it is not in
 * the record to be given back twice.
 *
 * @param {{activity?: object, message?: object, actor?: object, item?: object}} ctx
 *   the cast: its activity (the one dnd5e used), the usage message or the
 *   payload dnd5e handed over in its place, and who pressed what
 * @param {string} why  what happened instead, for the log line
 * @returns {Promise<{spent: number, given: boolean, what: string, failed?: boolean}>}
 */
export async function giveBack(ctx, why) {
  const actor = ctx?.actor ?? ctx?.item?.actor ?? null;
  const who = actor?.name ?? "That creature";
  const pressed = ctx?.item?.name ?? "it";
  const message = ctx?.message ?? null;
  const deltas = message?.system?.deltas ?? null;
  const spent = spentCount(deltas);
  if (!spent) {
    console.log(`${LOG} | ${who}: ${why}; pressing ${pressed} spent nothing that needs giving back.`);
    return { spent: 0, given: false, what: "" };
  }
  const what = describeSpent(deltas, actor);
  // A card that exists still has dnd5e's own Refund on it; the payload handed
  // over in place of a card has none, and the sheet is the only way back.
  const onCard = typeof message?.update === "function";
  const byHand = onCard ? "use Refund on its card" : "put it back on the sheet by hand";
  if (typeof ctx?.activity?.refund !== "function") {
    console.warn(`${LOG} | ${who}: ${why}, but ${what} cannot be given back from here; ${byHand}.`);
    return { spent, given: false, what, failed: true };
  }
  try {
    await ctx.activity.refund(deltas);
  } catch (err) {
    console.warn(`${LOG} | ${who}: ${why}, and giving back ${what} failed; ${byHand}:`, err);
    return { spent, given: false, what, failed: true };
  }
  // As dnd5e's own Refund does: the record is cleared, so neither the card nor
  // a second way out of the same cast can give it back again.
  try {
    if (onCard) await message.update({ "system.deltas": null });
    else if (message?.system) message.system.deltas = null;
  } catch (err) {
    console.warn(`${LOG} | ${who}: ${what} is given back, but the card's record of it could not be `
      + `cleared, so its Refund button would give it back a second time:`, err);
  }
  console.log(`${LOG} | ${who}: ${why}, so ${what} is given back.`);
  return { spent, given: true, what };
}
