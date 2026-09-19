// ─── ACE: QOL — The ding. A box that waits on somebody makes a sound ─────────
//
// 2026-09-18, Johnny: "we need some sort of sound associated with all pop-ups
// ... even I miss pop-ups that come over on the client screen, and I'm sitting
// there looking at my screen." He has not chosen the sound yet, so this plays
// Foundry's own notification ping (the one a whisper makes), on the interface
// channel, which every player already turns up or down with the Interface
// volume in Foundry's own audio settings. No ACE setting is needed for it.
//
// WHO HEARS IT: only the person who has to answer, on their own screen. A box
// somebody else is being asked is not a reason to ding at the rest of the table.
//
// WHICH BOXES: the ones that arrive without the person pressing anything for
// them - a reaction, an opportunity attack, a save or a check somebody else
// asked them to roll, a Smite after their hit, a Lucky or Bardic Inspiration
// offer. A picker that opens because they just pressed a spell is not in the
// list: they are already looking at it.
//
// ⚠️ IT IMPORTS NOTHING, ON PURPOSE. It is called from deep in the reaction and
// save engines, and a shared leaf that imports a sibling is how an import cycle
// kills the module at load (see is-down.mjs).
// ──────────────────────────────────────────────────────────────────────────────

const MODULE_ID = "ace-qol";

/** Chat cards that ask their recipient to do something. */
export const PROMPT_CARD_TYPES = Object.freeze(["pcSavePrompt", "oaPrompt", "breakFreePrompt", "concentrationPrompt"]);

/** Several boxes arriving together are one ding, not a drum roll. */
const BURST_MS = 1500;
let lastDing = 0;

/**
 * Play the ding on THIS client only.
 *
 * @param {string} why  what popped up, for the console if it cannot play
 * @returns {boolean} whether it played
 */
export function popupDing(why = "a box") {
  try {
    const now = Date.now();
    if (now - lastDing < BURST_MS) return false;
    const helper = globalThis.foundry?.audio?.AudioHelper;
    if (typeof helper?.play !== "function") {
      console.warn(`${MODULE_ID} | no ding for ${why}: Foundry's audio helper is not there.`);
      return false;
    }
    lastDing = now;
    const src = globalThis.CONFIG?.sounds?.notification ?? "sounds/notify.wav";
    checkDingFile(src);
    // false: this client only. Every other client decides for itself.
    const p = helper.play({ src, volume: 0.6, loop: false, channel: "interface" }, false);
    if (p && typeof p.then === "function") {
      p.then(sound => {
        if (sound?.failed) console.warn(`${MODULE_ID} | the ding for ${why} did not play: "${src}" could not be loaded.`);
      }).catch(err => console.warn(`${MODULE_ID} | the ding for ${why} did not play ("${src}"):`, err));
    }
    return true;
  } catch (err) {
    console.warn(`${MODULE_ID} | the ding for ${why} could not play:`, err);
    return false;
  }
}

/**
 * ⚠️ IF THE FILE IS MISSING, SAY SO (his rule, 2026-09-19). The ding is
 * Foundry's own notification sound until he picks one; a sound file that is not
 * there plays nothing and says nothing, which reads exactly like a box that
 * never asked. Checked once per sound, the first time it would play: the
 * console says it, and the GM gets one notice.
 */
const _checked = new Set();
function checkDingFile(src) {
  if (_checked.has(src)) return;
  _checked.add(src);
  try {
    const url = globalThis.foundry?.utils?.getRoute ? globalThis.foundry.utils.getRoute(src) : src;
    globalThis.fetch?.(url, { method: "HEAD" }).then(res => {
      if (res?.ok) return;
      const msg = `ACE: the pop-up sound "${src}" is missing (${res?.status ?? "no answer"}), so pop-ups make no sound.`;
      console.warn(`${MODULE_ID} | ${msg}`);
      if (globalThis.game?.user?.isGM) globalThis.ui?.notifications?.warn?.(msg);
    }).catch(err => console.warn(`${MODULE_ID} | could not check the pop-up sound "${src}":`, err));
  } catch (err) {
    console.warn(`${MODULE_ID} | could not check the pop-up sound "${src}":`, err);
  }
}

/**
 * Is this user the one a prompt card is waiting on?
 *
 * The card's whisper list says who may see it. When a player is on that list,
 * the player answers it and the GMs beside them are only watching; when no
 * player is (an NPC's card, or an owner who is offline), a GM answers it.
 *
 * @param {ChatMessage} message
 * @param {User} [user]
 * @returns {boolean}
 */
export function answersCard(message, user = globalThis.game?.user) {
  if (!message || !user) return false;
  if (!PROMPT_CARD_TYPES.includes(message.flags?.[MODULE_ID]?.type)) return false;
  const whisper = Array.from(message.whisper ?? []);
  if (!whisper.includes(user.id)) return false;
  if (!user.isGM) return true;
  const users = globalThis.game?.users;
  const aPlayerIsOnIt = whisper.some(id => {
    const u = users?.get?.(id);
    return !!u && !u.isGM;
  });
  return !aPlayerIsOnIt;
}

/** Ding when a prompt card arrives for the one who answers it. */
export function registerPromptCardDing() {
  Hooks.on("createChatMessage", (message) => {
    try {
      if (!answersCard(message)) return;
      popupDing(`the ${message.flags[MODULE_ID].type} card`);
    } catch (err) {
      console.warn(`${MODULE_ID} | could not decide whether to ding for a new card:`, err);
    }
  });
}
