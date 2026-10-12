// ─── PASS OR FAIL, WHEN THE DC IS THE GM'S ──────────────────────────────────
//
// His rule, 2026-10-12: "A 20 that totals 31 against DC 13 is a success. Lucky
// does not open. The player screen and the GM screen both say pass from the roll
// that was kept. This time the player screen said fail and the GM screen
// corrected it. That split goes."
//
// ⚠️🔴 WHY THE PLAYER'S SCREEN SAID FAIL (PROVEN, his chat log, 2026-10-12 08:00:
// "Firaxis Greenbeard 20 FAIL, Lucky: rolled 7, kept 20"). A creature's DC is the
// GM's, so the one function (table-view.mjs) cuts it out of the save prompt before
// the prompt reaches the player. The player's screen then rolled, compared 31
// against a DC it did not have, and wrote FAIL; and Lucky, told to ask whenever
// the DC was missing, asked on a roll that had already succeeded.
//
// So the screen that has the DC decides. The player's screen sends the total to
// the GM's screen, privately, and the GM's screen answers with one word, pass or
// fail. The number never leaves the GM's screen, and the word is the table's to
// read anyway.
//
// ⚠️ IT ANSWERS ONLY WHAT IT MUST. The roller of that prompt, a few times per
// prompt (the roll, and the die Lucky kept), never anybody else: answering any
// total for anybody would let a player walk the DC out of it one question at a time.
// ──────────────────────────────────────────────────────────────────────────────

let MODULE_ID = "ace-qol";
let SOCKET = `module.${MODULE_ID}`;
const LOG = () => `${MODULE_ID} | verdict`;

/** Asks this screen is waiting on: requestId -> resolve. */
const _waiting = new Map();
/** Answers given per prompt and asker: `${messageId}:${userId}` -> count. */
const _answered = new Map();
const MAX_ASKS_PER_PROMPT = 4;

/** The DC on a save prompt, as THIS screen holds it, or null. */
function dcOn(messageId) {
  const f = game.messages?.get(messageId)?.flags?.[MODULE_ID] ?? null;
  const dc = Number(f?.saveDC ?? f?.dc);
  return Number.isFinite(dc) ? dc : null;
}

/**
 * Is this total a success against the save on that prompt?
 *
 * On the GM's screen it is answered here. On a player's screen it asks the GM's.
 *
 * ⚠️🔴 THE DC IN HAND COMES FIRST (his table, 2026-10-12: "The offline GM roll
 * uses the same DC the header already prints. askVerdict gets that DC, not
 * undefined."). When the player is offline the GM rolls from a prompt built in
 * memory, before any card exists. It carries the cast's DC and has no message
 * id, so looking the DC up by id found nothing, the verdict came back empty, and
 * Virric's 9 + 1 = 10 against DC 13 was read downstream as "not failed": no
 * total on the card, "All targets resisted", and no charm.
 *
 * @param {object} o
 * @param {string} [o.messageId] the save prompt the roll answers
 * @param {number} o.total
 * @param {number|null} [o.dc]   the DC the caller already holds, when it holds one
 * @param {number} [o.timeoutMs]
 * @returns {Promise<{passed: boolean}|null>}  null when nobody could say
 */
export async function askVerdict({ messageId = null, total, dc = null, timeoutMs = 8000 } = {}) {
  const inHand = (dc === null || dc === undefined || dc === "") ? NaN : Number(dc);
  const here = Number.isFinite(inHand) ? inHand : dcOn(messageId);
  if (here !== null) return { passed: Number(total) >= here };
  const gm = game.users?.activeGM ?? null;
  if (!gm) {
    console.warn(`${LOG()} | no GM is connected, so nobody can say whether ${total} passes; the card `
      + `shows the die and no word.`);
    return null;
  }
  if (gm.id === game.user?.id) {
    console.warn(`${LOG()} | this is the GM's screen and neither the roll nor `
      + `${messageId ? `the prompt ${messageId}` : "a prompt"} carries a DC here, so pass or fail `
      + `cannot be said.`);
    return null;
  }
  if (!messageId) {
    console.warn(`${LOG()} | this roll names no prompt and carries no DC, so the GM's screen cannot `
      + `be asked about it.`);
    return null;
  }
  const requestId = foundry.utils.randomID();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      _waiting.delete(requestId);
      console.warn(`${LOG()} | the GM's screen did not answer within ${Math.round(timeoutMs / 1000)} `
        + `seconds, so the card shows the die and no word.`);
      resolve(null);
    }, timeoutMs);
    _waiting.set(requestId, (answer) => { clearTimeout(timer); resolve(answer); });
    game.socket.emit(SOCKET, { type: "aceVerdictAsk", requestId, messageId, total: Number(total) },
      { recipients: [gm.id] });
  });
}

/** On the GM's screen: answer one roller's question about their own prompt. */
function answer(data, senderId) {
  if (!game.user?.isGM || game.users?.activeGM?.id !== game.user.id) return;
  const sender = game.users?.get(senderId);
  if (!sender) return;
  const reply = (passed) => game.socket.emit(SOCKET,
    { type: "aceVerdictAnswer", requestId: data.requestId, passed }, { recipients: [senderId] });

  const message = game.messages?.get(data.messageId);
  const f = message?.flags?.[MODULE_ID] ?? null;
  const actor = (game.scenes?.get(f?.sceneId)?.tokens?.get(f?.tokenDocId)?.actor)
    ?? game.actors?.get(f?.actorId) ?? null;
  if (!f || !actor) { reply(null); return; }
  if (!actor.testUserPermission?.(sender, "OWNER")) {
    console.warn(`${LOG()} | ${sender.name} asked about a save that is not theirs to roll; not answered.`);
    reply(null);
    return;
  }
  const key = `${data.messageId}:${senderId}`;
  const n = (_answered.get(key) ?? 0) + 1;
  _answered.set(key, n);
  if (n > MAX_ASKS_PER_PROMPT) {
    console.warn(`${LOG()} | ${sender.name} has asked about this save ${n} times; no more answers.`);
    reply(null);
    return;
  }
  const dc = dcOn(data.messageId);
  if (dc === null) {
    console.warn(`${LOG()} | the save prompt ${data.messageId} carries no DC on the GM's screen either, `
      + `so ${sender.name}'s roll gets no word.`);
    reply(null);
    return;
  }
  reply(Number(data.total) >= dc);
}

function onSocket(data, senderId) {
  if (data?.type === "aceVerdictAsk") return answer(data, senderId);
  if (data?.type === "aceVerdictAnswer") {
    const waiting = _waiting.get(data.requestId);
    if (!waiting) return;
    if (!game.users?.get(senderId)?.isGM) return;
    _waiting.delete(data.requestId);
    waiting(data.passed == null ? null : { passed: !!data.passed });
  }
  return undefined;
}

export const Verdict = {
  _registered: false,
  /** Register once, at init. */
  register({ moduleId = "ace-qol" } = {}) {
    if (this._registered) return;
    this._registered = true;
    MODULE_ID = moduleId;
    SOCKET = `module.${MODULE_ID}`;
    Hooks.once("ready", () => game.socket?.on(SOCKET, onSocket));
  },
};
