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

/**
 * Prompt cards answered in the roll box (roll-popout.mjs). The card itself is
 * never shown, so it does not ding: the box dings when it is drawn.
 *
 * ⚠️ WHY (his table, 2026-09-19: "Popout opened with no sound. Other ACE sounds
 * work ... If that call is skipped on this box, fix the call."). It was
 * skipped. The hidden card's ding went off first, a moment before the box
 * opened, and the one-ding-per-burst rule below then dropped the box's own
 * ding. The reaction boxes he hears ding once, from the box, as it is drawn;
 * the roll box now does exactly that.
 */
export const BOX_PROMPT_TYPES = Object.freeze(["pcSavePrompt", "concentrationPrompt"]);

/** Several boxes arriving together are one ding, not a drum roll. */
const BURST_MS = 1500;
let lastDing = 0;
let lastWhy = "";

/**
 * Play the ding on THIS client only. Every outcome is said in the console, so
 * a box that opened without a sound can be told apart from one that dinged.
 *
 * @param {string} why  what popped up
 * @returns {boolean} whether a ding was started
 */
export function popupDing(why = "a box") {
  try {
    const now = Date.now();
    if (now - lastDing < BURST_MS) {
      console.log(`${MODULE_ID} | ding for ${why}: the one for ${lastWhy} sounded ${now - lastDing} ms ago, `
        + `so this is the same ding.`);
      return false;
    }
    const src = globalThis.CONFIG?.sounds?.notification ?? "sounds/notify.wav";
    checkDingFile(src);
    const started = playDing(src, why);
    // The window only closes behind a ding that actually started.
    if (started) { lastDing = now; lastWhy = why; }
    return started;
  } catch (err) {
    console.warn(`${MODULE_ID} | the ding for ${why} could not play:`, err);
    return false;
  }
}

/** The same sound every ACE prompt uses, on this client's interface channel. */
function playDing(src, why) {
  // ⚠️ FOUNDRY DROPS A SOUND ASKED FOR BEFORE THIS SCREEN'S FIRST CLICK OR KEY.
  // Read from Foundry V13 (client/audio): its interface channel is only made
  // on the first pointer or key press after the page loads, and a sound
  // created before that is made with no channel and never plays, even after
  // the click. So while Foundry's audio is still locked, the ding goes to the
  // browser itself: a browser that allows sound on this page plays it (the
  // Foundry app does, and so does a browser on a site it knows well); one that
  // does not says so below.
  if (globalThis.game?.audio?.locked) return playThroughBrowser(src, why);
  const helper = globalThis.foundry?.audio?.AudioHelper;
  if (typeof helper?.play !== "function") {
    console.warn(`${MODULE_ID} | no ding for ${why}: Foundry's audio helper is not there.`);
    return false;
  }
  // false: this client only. Every other client decides for itself.
  const p = helper.play({ src, volume: 0.6, loop: false, channel: "interface" }, false);
  if (p && typeof p.then === "function") {
    p.then(sound => {
      if (sound?.failed) console.warn(`${MODULE_ID} | the ding for ${why} did not play: "${src}" could not be loaded.`);
      else console.log(`${MODULE_ID} | ding for ${why}: played.`);
    }).catch(err => console.warn(`${MODULE_ID} | the ding for ${why} did not play ("${src}"):`, err));
  }
  return true;
}

/** While Foundry's audio waits for a first click: the browser's own player, at the interface volume. */
function playThroughBrowser(src, why) {
  try {
    const Player = globalThis.Audio;
    if (typeof Player !== "function") {
      console.warn(`${MODULE_ID} | no ding for ${why}: this screen has not been clicked since it loaded, `
        + `so Foundry's sound is locked, and there is no browser player to try.`);
      return false;
    }
    const url = globalThis.foundry?.utils?.getRoute ? globalThis.foundry.utils.getRoute(src) : src;
    const el = new Player(url);
    let level = 0.5;
    try { level = Number(globalThis.game?.settings?.get?.("core", "globalInterfaceVolume")); } catch (_) { level = 0.5; }
    el.volume = Math.max(0, Math.min(1, (Number.isFinite(level) ? level : 0.5) * 0.6));
    const p = el.play?.();
    if (p && typeof p.then === "function") {
      p.then(() => console.log(`${MODULE_ID} | ding for ${why}: played by the browser (Foundry's own sound `
        + `waits for this screen's first click or key).`))
        .catch(err => console.warn(`${MODULE_ID} | ding for ${why}: no sound. This screen has not been clicked `
          + `since it loaded, and the browser will not play sound before that (${err?.name ?? err}).`));
    }
    return true;
  } catch (err) {
    console.warn(`${MODULE_ID} | the ding for ${why} could not play through the browser:`, err);
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
      // Answered in the roll box, which dings as it is drawn (BOX_PROMPT_TYPES).
      if (BOX_PROMPT_TYPES.includes(message.flags[MODULE_ID].type)) return;
      popupDing(`the ${message.flags[MODULE_ID].type} card`);
    } catch (err) {
      console.warn(`${MODULE_ID} | could not decide whether to ding for a new card:`, err);
    }
  });
}
