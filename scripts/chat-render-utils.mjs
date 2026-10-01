// ─── ACE QOL — register a chat-card handler that ALSO catches old cards ─────
//
// 🔴 THE BUG THIS EXISTS TO PREVENT (found live 2026-08-07)
//
// Johnny's PLAYER client was showing an Ogre's ROLL DAMAGE button and a damage
// card's APPLY ALL / UNDO ALL controls — all three GM-only. The proof was one
// line: the button carried no `wired` stamp, so the handler that hides those
// controls had never touched that card, while 33 and 27 handlers sat happily
// registered on the two chat render hooks.
//
// Foundry paints the existing chat log ONCE and never re-renders those
// messages. Every ACE engine registers its render handler inside ace-qol's
// `ready` hook, so any card already in the log at that moment is decorated by
// nobody — permanently. That is not a rare edge case. It is EVERY card above
// the fold for any player who refreshes mid-session, which is the single most
// common thing a player does during a game.
//
// It survived this long because it is invisible from the GM's chair: the GM is
// allowed to see all of those controls, so the GM's client always looks right.
//
// ⚠️ USE THIS INSTEAD OF Hooks.on("renderChatMessage"/"renderChatMessageHTML")
// FOR ANY ACE CHAT CARD. Registering the raw hooks reintroduces the hole.

const MODULE_ID = "ace-qol";

/**
 * Register a chat-card render handler on both the V12 and V13 hooks, and run it
 * over every ACE card already on screen.
 *
 * The handler must be idempotent — it will be called again for a card it has
 * already decorated (on a chat-log re-render, a sidebar popout, a tab switch).
 * Every ACE handler already guards with dataset stamps, which is exactly the
 * property that makes this safe.
 *
 * @param {(message: ChatMessage, element: HTMLElement) => void} handler
 * @param {string} label  short name for the log line, e.g. "damage cards"
 * @param {object}  [opts]
 * @param {boolean} [opts.sweepAll]    sweep every card, not just ACE-flagged ones
 * @param {string}  [opts.namespace]   which module's flag marks "our" cards.
 *        Defaults to ace-qol. The sibling ACE modules post their own flagged
 *        cards and have exactly the same hole, so they pass their own id and
 *        share this one implementation rather than each carrying a copy that
 *        drifts. Reached through `game.aceQol.registerChatCardHandler`.
 */
export function registerChatCardHandler(handler, label = "chat cards", { sweepAll = false, namespace = MODULE_ID } = {}) {
    if (typeof handler !== "function") {
        console.warn(`${MODULE_ID} | registerChatCardHandler was given no handler for "${label}" — nothing registered.`);
        return;
    }

    // ⚠️🔴 REGISTERING THE V12 HOOK ON V13 IS TWO BUGS, NOT ONE.
    //
    // Core V13 fires `renderChatMessageHTML`, and then checks whether anything
    // is listening on the old `renderChatMessage` and fires that too:
    //
    //     if ( "renderChatMessage" in Hooks.events ) { logCompatibilityWarning(...) }
    //
    // So registering both meant (a) a deprecation warning on Johnny's console
    // for every session, and (b) EVERY handler that came through this helper
    // running TWICE on every card. This is the shared entry point for all four
    // ACE modules, so both problems were suite-wide. The double-fire is the
    // same shape as the 2026-08-16 double-damage bug, which was cured at one
    // consumer and left in the helper that caused it.
    //
    // Read the generation, not `isNewerVersion(game.version, "13")` — that
    // comparison is FALSE on a hypothetical 13.0 and would silently drop us
    // back to the V12 name on the very version this is guarding.
    const generation = game.release?.generation ?? parseInt(game.version) ?? 0;
    if (generation >= 13) Hooks.on("renderChatMessageHTML", handler);
    else Hooks.on("renderChatMessage", handler);

    sweepDrawnCards(handler, { label, sweepAll, namespace });
}

/**
 * Run a render handler over the cards ALREADY on screen, now and on every later
 * chat-log re-render. This is the half of the fix that matters — registering a
 * hook only ever catches FUTURE renders.
 *
 * Split out so a sibling module that already registers its own render hooks can
 * close the same hole without registering them a second time. ace-engine does
 * exactly that: hooking twice would wire every card's buttons twice.
 *
 * @param {(message: ChatMessage, element: HTMLElement) => void} handler
 * @param {object}  [opts]
 * @param {string}  [opts.label]      short name for the log line
 * @param {boolean} [opts.sweepAll]   sweep every card, not just flagged ones
 * @param {string}  [opts.namespace]  which module's flag marks "our" cards
 */
export function sweepDrawnCards(handler, { label = "chat cards", sweepAll = false, namespace = MODULE_ID } = {}) {
    if (typeof handler !== "function") {
        console.warn(`${MODULE_ID} | sweepDrawnCards was given no handler for "${label}" — nothing swept.`);
        return;
    }

    const sweep = (reason) => {
        try {
            const nodes = document.querySelectorAll("#chat-log [data-message-id], .chat-log [data-message-id]");
            if (!nodes.length) return;
            let touched = 0;
            for (const node of nodes) {
                const msg = game.messages?.get(node.dataset.messageId);
                if (!msg) continue;
                // sweepAll is for the handlers that deliberately target OTHER
                // people's cards — hiding third-party "Bloodied — Applied to X"
                // spam, collapsing dnd5e system cards. Those have exactly the
                // same hole: one that loaded before registration stays visible
                // forever. Restricting the sweep to ACE-flagged messages would
                // silently exclude the only messages they care about.
                if (!sweepAll && !msg.flags?.[namespace]) continue;
                handler(msg, node);
                touched++;
            }
            if (touched) {
                console.log(`${MODULE_ID} | Swept ${touched} already-drawn ${label} (${reason}). ` +
                    `Cards drawn before a handler registers are decorated by nobody, which leaves GM-only controls visible to players.`);
            }
        } catch (err) {
            console.warn(`${MODULE_ID} | Could not sweep already-rendered ${label}:`, err);
        }
    };

    // Once now for the log painted during load, and again whenever the chat log
    // itself re-renders — popping it out, switching sidebar tabs, or Foundry
    // rebuilding the list all produce fresh, undecorated nodes.
    Hooks.on("renderChatLog", () => sweep("chat log rendered"));
    if (game.ready) sweep("registered after the log was drawn");
    else Hooks.once("ready", () => sweep("ready"));
}

/**
 * Same as registerChatCardHandler, for the handlers that deliberately decorate
 * OTHER people's cards — hiding third-party "Bloodied — Applied to X" spam, or
 * collapsing dnd5e's own system cards.
 *
 * They have exactly the same hole as ACE's own handlers: one of those cards
 * loaded before registration is never touched, so the spam this is meant to
 * suppress sits there for the rest of the session. The only difference is that
 * the sweep must NOT filter to ACE-flagged messages, since those are precisely
 * the messages these handlers ignore.
 */
export function registerForeignChatCardHandler(handler, label = "third-party cards") {
    return registerChatCardHandler(handler, label, { sweepAll: true });
}

/* ═══════════════════════════════════════════════════════════════════════════
   A DC IS SHOWN ON THE ROLL THAT NEEDS IT (ACE-ONE-ROAD.md § 13.2)

     "A player sees the DC on a roll they are making. The GM always sees every
      DC. Hide a DC only when it is not on a roll that player is making
      (unrevealed sheet, unsprung trap, someone else's save)."

   ⚠️🔴 THIS REPLACES WHAT 0.58 SHIPPED. I built it round the wrong question:
   "who SET this number". By that reading Lamia's DC 13 belonged to Lamia, so it
   was hidden from Jeth, who is the one rolling against it. His correction:
   "Do not hide Lamia's DC 13 on Jeth's Charm card. He is rolling against it."
   The number belongs to the ROLL, and the person making the roll may read it.

   So the wrapper names the ROLLER:

       <span class="ace-qol-dc" data-dc-roller="${actorId}">DC 14 Dexterity</span>

   and several rollers share one line, because one save card asks the same DC of
   everybody on it:

       data-dc-roller="abc123 def456"

   Revealed to the GM always, and to a player who owns ANY of the rollers named.
   NO roller named means nobody is rolling against it yet — an unrevealed sheet,
   an unsprung trap — so it stays the GM's alone. That is what `.ace-qol-save-dc`
   means, and it is now the narrow case rather than the default.

   ⚠️ DECIDED PER SCREEN. A chat card is built ONCE, by the GM, and rendered on
   every client, so a card that made this choice while it was being written would
   make it for the whole table at once.

   ⚠️ IT RUNS FOR EVERY ACE CARD, not for every handler. Registered once, here,
   so a module that never thinks about DCs still cannot leak one.
   `tools/dc-check.mjs` fails the release if a DC reaches a card unwrapped.
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * Whether this screen may read a DC being rolled against by `rollers`.
 *
 * @param {string|null} rollers  one actor id, or several separated by spaces
 */
export function maySeeDC(rollers) {
    try {
        if (game.user?.isGM) return true;
        const ids = String(rollers ?? "").split(/\s+/).filter(Boolean);
        if (!ids.length) return false;          // nobody is rolling it yet
        return ids.some(id => !!game.actors?.get(id)?.isOwner);
    } catch (_) {
        return false;                           // unreadable: not this screen's
    }
}

/**
 * The wrapper every card puts a DC in.
 *
 * @param {string|number} text        e.g. "DC 14 Dexterity"
 * @param {string|string[]|null} rollers  the creature(s) rolling against it
 * @param {string} [extraClass]       any styling class the card already used
 */
export function dcSpan(text, rollers = null, extraClass = "") {
    const esc = (v) => String(v ?? "")
        .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    const ids = (Array.isArray(rollers) ? rollers : [rollers]).filter(Boolean).join(" ");
    return `<span class="ace-qol-dc${extraClass ? ` ${extraClass}` : ""}"`
        + `${ids ? ` data-dc-roller="${esc(ids)}"` : ""}>${esc(text)}</span>`;
}

/**
 * Reveal, on THIS screen, the DCs this viewer is rolling against.
 *
 * ⚠️ TWO CLASSES, ONE PASS. `.ace-qol-dc` names the roller(s) and is revealed to
 * their owner as well as to the GM. `.ace-qol-save-dc` names nobody: it is a
 * number no player is rolling against yet, so it is the GM's alone.
 */
export function revealOwnDCs(root) {
    let shown = 0, hidden = 0;
    const decide = (el, rollers) => {
        if (maySeeDC(rollers)) { el.dataset.aceDc = "show"; shown++; }
        else { delete el.dataset.aceDc; hidden++; }
    };
    try {
        for (const el of (root?.querySelectorAll?.(".ace-qol-dc") ?? [])) {
            decide(el, el.dataset?.dcRoller ?? null);
        }
        for (const el of (root?.querySelectorAll?.(".ace-qol-save-dc") ?? [])) {
            decide(el, null);
        }
    } catch (err) {
        console.warn(`${MODULE_ID} | could not decide which DCs this screen may see, so none of `
            + `them are shown here:`, err);
    }
    return { shown, hidden };
}

/** Kept as the name the entry file already calls; the chrome pass does both. */
export function registerDCVisibility() {
    registerAceChrome();
}

/* ═══════════════════════════════════════════════════════════════════════════
   NO SPEAKER STRIP ON AN ACE CARD (ACE-ONE-ROAD.md § 13.1)

     "Every ACE chat card hides Foundry's speaker strip (the manila
      'Name / DUNGEON MASTER' bar). ⋮ stays. This is every ACE card: save,
      attack, damage, heal, reaction, refusal. Not only saves."

   ⚠️🔴 IT WAS THE SAVE CARD ONLY. 0.55 stamped the flag from the save card's
   own content, so the attack card, the damage card, the heal card and every
   refusal kept the manila bar. The rule is about ACE's cards, so the stamp reads
   the MESSAGE's flags: any of the four modules owns it, it loses the strip.
   Other chat is untouched, which is the point — nothing here is global.

   ⚠️ ONLY THE SENDER AND THE TIME ARE HIDDEN, never the header itself. The ⋮
   lives in there and its markup has moved between Foundry generations, so
   hiding the whole bar is how you lose the ability to delete a message. The
   stylesheet does that part; this only says which messages are ACE's.
   ══════════════════════════════════════════════════════════════════════════ */

/** Every module whose cards are ACE's. */
export const ACE_NAMESPACES = Object.freeze(["ace-qol", "ace-artificer", "ace-engine", "ace-envoy"]);

/** Whether this message is a card one of the ACE modules posted. */
export function isAceCard(message, el = null) {
    try {
        const flags = message?.flags ?? {};
        if (ACE_NAMESPACES.some(ns => flags[ns] && Object.keys(flags[ns]).length)) return true;
        // A card posted before its module stamped a flag, and the shells that
        // already marked themselves in their own content.
        if (el?.querySelector?.("[data-ace-save-shell], .ace-qol-save-shell, .ace-qol-card")) return true;
    } catch (_) { /* fall through */ }
    return false;
}

/** Stamp this message as ACE's, so the stylesheet can take its speaker strip off. */
export function stampAceCard(message, el) {
    try {
        if (!el?.setAttribute) return false;
        if (!isAceCard(message, el)) return false;
        el.setAttribute("data-ace-card", "1");
        return true;
    } catch (err) {
        console.warn(`${MODULE_ID} | could not stamp a card as ACE's, so it keeps Foundry's `
            + `speaker strip:`, err);
        return false;
    }
}

/**
 * The chrome pass: one registration for the two things every ACE card needs on
 * every screen. No speaker strip (§ 13.1), and a DC only on a roll this screen
 * is making (§ 13.2).
 */
export function registerAceChrome() {
    registerChatCardHandler((message, el) => {
        stampAceCard(message, el);
        revealOwnDCs(el);
        revealOwnACs(el);
        takeLogToNewCard(message, el);
    }, "ACE card chrome", { sweepAll: true });
    registerAceCardScroll();
    console.log(`${MODULE_ID} | ACE cards drop Foundry's speaker strip and keep the ⋮; a DC `
        + `shows for the GM, and for a player on a roll they are making.`);
}

/* ═══════════════════════════════════════════════════════════════════════════
   A NEW ACE CARD TAKES THE LOG TO IT

     His rule, 2026-09-30: *"A new ACE card must scroll the log to that card."*

   ⚠️🔴 FOUNDRY ONLY SCROLLS FOR TWO PEOPLE. Its own handler is:

       if ( this.isAtBottom || (message.author.id === game.user.id) )
         this.scrollBottom({ waitImages: true });

   So the log follows a new message only when this screen was already parked at
   the bottom, or when the message is YOURS. An ACE card is neither for the
   people who most need to read it: ACE writes a card as the creature it is
   about, so on the roller's screen the author is not them; and one glance back
   up the log to check what a monster rolled leaves `isAtBottom` false for the
   rest of the fight. The card he was waiting to be asked for lands off-screen
   and nothing says so.

   ⚠️ THE BOTTOM OF THE LOG, AND NOTHING CLEVERER (his rule, 2026-09-30: "Do not
   scroll-to-card. Do not wait on images. Do not add padding. Bottom of the
   log."). 0.67.0 waited on images and then measured the card, and waiting on
   images means waiting for every picture in the WHOLE log, which arrives late
   enough to read as not scrolling at all.

   ⚠️ A CREATE, NOT A RENDER. An ACE card is written once and then updated in
   place (the card door), and a redraw is not a new card: scrolling on every
   update would drag the log away from whatever he was reading each time a save
   result landed. So `createChatMessage` marks the card as new and the render
   pass, which sees the element, is what scrolls.

   ⚠️🔴 AND NEITHER HOOK IS "AFTER THE CARD IS IN THE DOM" (his correction,
   2026-09-30: "Fix the hook so it runs after the card is in the DOM"). Foundry's
   own order, in ChatLog##postOne, is:

       const html = await this.constructor.renderMessage(message);   // the hook
       log.append(html);                                             // the DOM

   `renderChatMessageHTML` fires INSIDE renderMessage, so the element is still
   detached, and `createChatMessage` is earlier still. Scrolling from either one
   scrolls to the bottom of a log the new card is not in yet, which lands on the
   card BEFORE it and looks exactly like not scrolling. A microtask is no better:
   the append is the continuation of that `await`, so anything queued during the
   hook runs first.

   So the scroll waits on a CONDITION, not a delay: `el.isConnected`, checked once
   a frame. One animation frame runs after every microtask, which is after the
   append. Bounded, and it says so if the card never arrives.
   ══════════════════════════════════════════════════════════════════════════ */

let _scrollRegistered = false;
/** Cards created in this session that have not yet had the log taken to them. */
const _newCards = new Set();

export function registerAceCardScroll() {
    if (_scrollRegistered) return;
    _scrollRegistered = true;
    Hooks.on("createChatMessage", (message) => {
        try {
            if (!isAceCard(message)) return;
            // Whispered past this screen: there is nothing here to scroll to.
            if (message.visible === false) return;
            _newCards.add(message.id);
        } catch (err) {
            console.warn(`${MODULE_ID} | could not mark a new ACE card for scrolling:`, err);
        }
    });
}

/**
 * Take the log to this card, if it is one created in this session.
 *
 * Called from the chrome pass, so it runs for every ACE card on every screen and
 * no module has to remember it. A swept or re-rendered card is not in the set,
 * so it never moves the log.
 */
export function takeLogToNewCard(message, el) {
    try {
        if (!message?.id || !_newCards.has(message.id)) return;
        _newCards.delete(message.id);

        // ⚠️ WAIT FOR THE CARD TO BE IN THE LOG FIRST. The render hook fires
        // inside ChatMessage#renderHTML, which ChatLog##postOne awaits BEFORE it
        // appends — so at this moment the card is still detached and the bottom
        // of the log is not where it is going to be. `inTheLog` is the condition,
        // checked once a frame, and the follower below then keeps the bar there
        // while the rest of the cast is still writing.
        let frames = 0;
        const inTheLog = () => !!el?.closest?.("#chat-log, .chat-log");
        const whenInTheDom = () => {
            if (inTheLog()) { followTheLog(`a new ACE card (${message.id})`, el); return; }
            if (++frames > 30) {
                console.warn(`${MODULE_ID} | a new ACE card never reached the chat log, so the bar `
                    + `was not moved (message ${message.id}).`);
                return;
            }
            requestAnimationFrame(whenInTheDom);
        };
        requestAnimationFrame(whenInTheDom);
    } catch (err) {
        console.warn(`${MODULE_ID} | could not take the chat log to a new ACE card, so it may `
            + `have landed off-screen:`, err);
    }
}

/* ═══════════════════════════════════════════════════════════════════════════
   THE BAR FOLLOWS THE LOG UNTIL THE LOG STOPS GROWING

   His table, 2026-10-01, reading his own console back to me:

     "div.chat-scroll scrollTop=3687 scrollHeight=4804 clientHeight=1117
      travel=3687. That element was at its max. The GM's bar was not at the
      bottom, because the Charm card, the apply, and the condition art all
      logged AFTER the 100ms scroll."

   ⚠️🔴 SO THE SCROLL WAS RIGHT AND THE MOMENT WAS WRONG. Three pins and a
   fourth after Foundry's own scroll all happen while a cast is still resolving:
   the save card goes up, then the apply, then what landed, then the condition
   art, each its own write and each one taller than the last. Pinning the bar
   before the last of them is pinning it to a log that is about to grow.

   A card cannot know when it is the last thing in the log, so this stops
   guessing and WATCHES instead:

     · a MutationObserver on every chat log — anything added or removed
     · a ResizeObserver on the logs' own content — a card that grows after it
       was drawn, which is every ACE card that fills itself in
     · every signal The One Road names, so the end of an apply is a pin too

   and it keeps following until the log has been still for a moment, with a hard
   ceiling so it can never hold the bar hostage while he reads.

   ⚠️ IT PINS EVERY LOG, NAMED. `div.chat-scroll` is the pane in his console, and
   the bar he drags is whichever ancestor of the card has the most travel. Both
   are pinned and both are named, because when they differ that difference is the
   bug (0.75.0 pinned one of them and reported success).

   ⚠️ NOTHING HERE WAITS ON AN IMAGE, pads anything, or scrolls to the card.
   ══════════════════════════════════════════════════════════════════════════ */

/** How long the log must be still before the bar is let go, and the ceiling. */
const FOLLOW_QUIET_MS = 400;
const FOLLOW_MAX_MS = 4000;

let _following = null;

/** Every pane that could own a chat scrollbar right now. */
function chatScrollers(cardEl = null) {
    const seen = new Map();
    const add = (box, why) => {
        if (!box || box === document.body || !(box.scrollHeight > box.clientHeight + 1)) return;
        if (!seen.has(box)) seen.set(box, why);
    };
    // The pane Foundry scrolls, in the sidebar and in every popped-out log.
    for (const box of document.querySelectorAll(".chat-scroll")) add(box, "chat-scroll");
    // And the bar he actually drags: the ancestor of the card with the most
    // travel. They are usually the same element; when they are not, that is
    // exactly what went wrong last time, so both get pinned.
    for (const node of document.querySelectorAll(".chat-message, [data-message-id]")) {
        if (cardEl && node !== cardEl && !node.contains?.(cardEl)) continue;
        let box = node.parentElement, best = null, bestTravel = 0;
        while (box && box !== document.body) {
            const travel = box.scrollHeight - box.clientHeight;
            if (travel > bestTravel) { best = box; bestTravel = travel; }
            box = box.parentElement;
        }
        add(best, "most travel above the card");
        break;
    }
    return seen;
}

const scrollerName = (box) => box.id ? `#${box.id}`
    : `${box.tagName.toLowerCase()}.${String(box.className || "?").trim().split(/\s+/)[0]}`;

/**
 * Put every chat scrollbar at its maximum, and say what happened.
 *
 * @returns {boolean} whether every bar it found is now at the bottom
 */
function pinChatToBottom(why, cardEl = null, { quiet = false } = {}) {
    const boxes = chatScrollers(cardEl);
    if (!boxes.size) {
        if (!quiet) {
            console.warn(`${MODULE_ID} | ${why}: nothing in the chat has a scrollbar, so there was `
                + `nothing to move.`);
        }
        return true;
    }
    let allDown = true;
    for (const [box, found] of boxes) {
        box.scrollTop = box.scrollHeight - box.clientHeight;
        const top = Math.round(box.scrollTop);
        const h = Math.round(box.scrollHeight);
        const vis = Math.round(box.clientHeight);
        const travel = Math.max(0, h - vis);
        const down = top >= travel - 1;
        if (!down) allDown = false;
        if (quiet && down) continue;
        const line = `${scrollerName(box)} (${found}) scrollTop=${top} scrollHeight=${h} `
            + `clientHeight=${vis} travel=${travel}`;
        if (!down) {
            console.warn(`${MODULE_ID} | ${why}: ${line} — ${travel - top}px SHORT of the bottom. `
                + `Something is holding that bar.`);
        } else {
            console.log(`${MODULE_ID} | ${why}: ${line} — at the bottom.`);
        }
    }
    return allDown;
}

/**
 * Follow the log to the bottom until it stops growing.
 *
 * Called for a new ACE card, and safe to call again while one is already being
 * followed: the later call extends the window rather than starting a second
 * watcher.
 */
export function followTheLog(why, cardEl = null) {
    // Already following: just extend it and pin now.
    if (_following) {
        _following.until = Math.max(_following.until, performance.now() + FOLLOW_QUIET_MS);
        _following.card = cardEl ?? _following.card;
        pinChatToBottom(`${why} while already following`, _following.card, { quiet: true });
        return;
    }

    const started = performance.now();
    const state = { until: started + FOLLOW_QUIET_MS, card: cardEl, pins: 0 };
    _following = state;

    const pin = (what, { quiet = false } = {}) => {
        state.pins++;
        // Anything that moves the log keeps the window open: the apply, the card
        // filling itself in, the condition art. This is the whole fix — the bar
        // is pinned after the LAST write, not before it.
        state.until = Math.max(state.until, performance.now() + FOLLOW_QUIET_MS);
        return pinChatToBottom(what, state.card, { quiet });
    };

    // ── What we watch ───────────────────────────────────────────────────────
    const observers = [];
    try {
        const logs = document.querySelectorAll("#chat-log, .chat-log, .chat-scroll");
        const mo = new MutationObserver(() => pin("a message was added to the log", { quiet: true }));
        for (const log of logs) mo.observe(log, { childList: true, subtree: true });
        observers.push(mo);
    } catch (err) {
        console.debug(`${MODULE_ID} | could not watch the chat log for new messages:`, err?.message ?? err);
    }
    try {
        if (typeof ResizeObserver === "function") {
            const ro = new ResizeObserver(() => pin("a card changed height", { quiet: true }));
            for (const log of document.querySelectorAll("#chat-log, .chat-log")) ro.observe(log);
            if (cardEl) ro.observe(cardEl);
            observers.push(ro);
        }
    } catch (err) {
        console.debug(`${MODULE_ID} | could not watch the cards for a height change:`, err?.message ?? err);
    }
    // Every landing The One Road names: the end of an apply is a pin.
    const signals = ["saveComplete", "damageApplied", "killLogged", "reactionUsed",
        "concentrationBroken", "attackResolved", "attackCancelled", "expectCard"];
    const hooked = signals.map(name => {
        const fn = () => pin(`ACE finished ${name}`, { quiet: true });
        Hooks.on(`${MODULE_ID}.${name}`, fn);
        return [name, fn];
    });

    // ── The pins he asked for, and then whatever the log does ───────────────
    pin("the card is in the log");
    requestAnimationFrame(() => pin("next frame", { quiet: true }));
    setTimeout(() => pin("100ms later", { quiet: true }), 100);
    // After Foundry's own scroll, so its write cannot put the bar back. That one
    // waits for pictures; ours never do, and by then they have all run.
    Promise.resolve(ui.chat?.scrollBottom?.({ waitImages: true, popout: true }))
        .then(() => pin("after Foundry's own scroll", { quiet: true }))
        .catch(() => { /* its scroll is a nicety */ });

    // ── Letting go, and only then the verdict ───────────────────────────────
    const tick = () => {
        const now = performance.now();
        if (now < state.until && (now - started) < FOLLOW_MAX_MS) {
            setTimeout(tick, 60);
            return;
        }
        for (const o of observers) { try { o.disconnect(); } catch (_) {} }
        for (const [name, fn] of hooked) { try { Hooks.off(`${MODULE_ID}.${name}`, fn); } catch (_) {} }
        _following = null;
        // ⚠️ THE VERDICT IS READ HERE, AFTER THE CARD AND EVERYTHING THAT CAME
        // WITH IT IS ON SCREEN (his rule: "Log after the Charm card is on screen,
        // not before"). Every pin above is quiet unless it found a bar short;
        // this is the line that says where the thumb actually ended up.
        const down = pinChatToBottom(`${why}: the log has been still for ${FOLLOW_QUIET_MS}ms`
            + ` after ${state.pins} pin(s)`, state.card);
        if (!down) {
            console.warn(`${MODULE_ID} | the chat bar is still not at the bottom after the log went `
                + `quiet. Do not take the lines above as a success.`);
        }
        if ((now - started) >= FOLLOW_MAX_MS) {
            console.log(`${MODULE_ID} | stopped following the chat log after ${FOLLOW_MAX_MS}ms — it `
                + `was still changing, and holding his scrollbar longer than that is worse than `
                + `letting go of it.`);
        }
    };
    setTimeout(tick, 60);
}

/* ═══════════════════════════════════════════════════════════════════════════
   A MONSTER'S AC IS NOT ON A CARD (ACE-ONE-ROAD.md § 13.3)

     "Do not put a monster's AC on any card. AC is not a save DC."

   ⚠️ AND IT DOES NOT FOLLOW THE DC RULE. A DC is shown to the person rolling
   against it, because they are the one who needs it. AC is the opposite: the
   attacker rolling against it is exactly the person who must not learn it. So
   this asks whose SHEET the number is on, which is the question the DC rule was
   wrongly built round — right here, wrong there.

       <span class="ace-qol-ac" data-ac-actor="${targetActorId}">AC 15</span>

   Revealed to the GM always, and to a player who owns that creature, because
   their own AC is on their own sheet.
   ══════════════════════════════════════════════════════════════════════════ */

/** The wrapper every card puts an AC in. `whose` is the creature it belongs to. */
export function acSpan(text, whose = null, extraClass = "") {
    const esc = (v) => String(v ?? "")
        .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    return `<span class="ace-qol-ac${extraClass ? ` ${extraClass}` : ""}"`
        + `${whose ? ` data-ac-actor="${esc(whose)}"` : ""}>${esc(text)}</span>`;
}

/** Reveal, on THIS screen, the ACs this viewer is entitled to. */
export function revealOwnACs(root) {
    try {
        for (const el of (root?.querySelectorAll?.(".ace-qol-ac") ?? [])) {
            const id = el.dataset?.acActor ?? null;
            const mine = game.user?.isGM || (!!id && !!game.actors?.get(id)?.isOwner);
            if (mine) el.dataset.aceAc = "show";
            else delete el.dataset.aceAc;
        }
    } catch (err) {
        console.warn(`${MODULE_ID} | could not decide which ACs this screen may see, so none of `
            + `them are shown here:`, err);
    }
}
