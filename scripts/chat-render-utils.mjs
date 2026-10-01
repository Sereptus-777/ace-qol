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
    registerScrollAtTheEnd();
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
   EVERY PANE, ONE PASS, AT THE END

   His table, 2026-10-01: *"The console said div.chat-scroll was at the bottom.
   The bar did not move. That element is not the thumb he drags. The last thing
   the pipeline does, after the card is in the log and the apply is finished, is
   scroll... Do it once, at the end. Not before the card. Not on a timer that
   lets go."*

   ⚠️🔴 TWICE I PICKED AN ELEMENT AND REPORTED IT AT ITS MAXIMUM WHILE HIS BAR SAT
   WHERE IT WAS. 0.75.0 took the first ancestor that scrolled, which was a wrapper
   with ninety pixels of travel. 0.76.0 took the one with the most travel and
   followed the log with observers until it went quiet, and div.chat-scroll read
   at the bottom while the thumb did not move.

   So this stops choosing, and stops holding. Every pane that could own a chat
   scrollbar is driven by name, Foundry's own is asked for its, every ancestor of
   the last card is driven too, and then the last message is brought into view —
   which is the one move that does not depend on having picked the right box,
   because the browser scrolls whatever has to move. The widest-travel pane is
   named as the thumb in the log, so a wrong answer stays visible.

   And it runs at the END: when the card is in the log, and again when ACE says an
   apply has finished. Each call does the whole job, so the last to run is the one
   that counts and nothing lets go of the bar afterwards.

   ⚠️ NOTHING HERE WAITS ON AN IMAGE or pads anything. Scrolling the last message
   into view is his own instruction of 2026-10-01 and supersedes the "no
   scroll-to-card" of the day before.
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * Every pane that could own a chat scrollbar, by every name the app has used for
 * one, plus whatever actually owns the visible thumb.
 *
 * ⚠️🔴 HIS RULE, 2026-10-01: "Set scrollTop = scrollHeight on every one of these
 * that exists: the sidebar chat, #chat-log, .chat-scroll, div.chat-scroll, the
 * popout, and the element that actually owns the visible thumb."
 *
 * Twice now I have found "the" scroller, reported it at its maximum, and left his
 * bar where it was. So this stops choosing. Every candidate is listed and every
 * one of them is driven, and the one with the most travel — which is the thumb he
 * can actually grab — is named as such in the log so a wrong answer is visible
 * rather than reported as a success.
 */
function chatPanes() {
    const panes = new Map();
    const add = (box, why) => {
        if (!box || box === document.body) return;
        if (!(box.scrollHeight > box.clientHeight + 1)) return;   // no bar on it
        if (!panes.has(box)) panes.set(box, why);
        else if (!panes.get(box).includes(why)) panes.set(box, `${panes.get(box)} + ${why}`);
    };

    // By name, everywhere, which covers the sidebar and every popped-out log.
    for (const sel of ["#chat", "#chat-log", ".chat-log", ".chat-scroll", "#sidebar #chat",
        "#chat-popout", ".chat-popout", ".chat-sidebar", "section.chat"]) {
        for (const box of document.querySelectorAll(sel)) add(box, sel);
    }
    // Whatever Foundry itself thinks it is scrolling.
    try { add(ui.chat?.element?.querySelector?.(".chat-scroll"), "ui.chat's own"); } catch (_) {}
    try { add(ui.chat?.popout?.element?.querySelector?.(".chat-scroll"), "popout's own"); } catch (_) {}
    // And the thumb: every ancestor of the last message, so nothing between the
    // card and the window is missed.
    try {
        const last = [...document.querySelectorAll("#chat-log [data-message-id], "
            + ".chat-log [data-message-id]")].pop();
        let box = last?.parentElement ?? null;
        while (box && box !== document.body) { add(box, "above the last card"); box = box.parentElement; }
    } catch (_) {}
    return panes;
}

const scrollerName = (box) => box.id ? `#${box.id}`
    : `${box.tagName.toLowerCase()}.${String(box.className || "?").trim().split(/\s+/)[0] || "?"}`;

/**
 * THE LAST THING: put every chat pane at the bottom and the last message in view.
 *
 * ⚠️ ONCE, AT THE END (his rule). Not before the card, and not on a window that
 * lets go: this is called when the card is in the log and again when ACE says an
 * apply has finished, and each call does the whole job, so the last one to run is
 * the one that counts.
 */
export function scrollChatToEnd(why) {
    try {
        const panes = chatPanes();
        if (!panes.size) {
            console.warn(`${MODULE_ID} | ${why}: no chat pane has a scrollbar, so there was nothing `
                + `to move.`);
            return;
        }
        // Widest travel = the thumb he drags. Driven like the rest, named apart.
        let thumb = null, widest = 0;
        for (const box of panes.keys()) {
            const travel = box.scrollHeight - box.clientHeight;
            if (travel > widest) { thumb = box; widest = travel; }
        }

        const lines = [];
        for (const [box, found] of panes) {
            box.scrollTop = box.scrollHeight;          // his line, every pane
            const top = Math.round(box.scrollTop);
            const travel = Math.max(0, Math.round(box.scrollHeight - box.clientHeight));
            const atMax = top >= travel - 1;
            lines.push(`${scrollerName(box)} [${found}] travel=${travel} scrollTop=${top} `
                + `${atMax ? "AT MAX" : `SHORT by ${travel - top}`}${box === thumb ? " ← the thumb" : ""}`);
        }

        // ⚠️ AND THE LAST MESSAGE INTO VIEW (his rule, 2026-10-01). It is the one
        // thing that does not depend on having picked the right box: the browser
        // scrolls whatever ancestor has to move to put that element on screen.
        try {
            const last = [...document.querySelectorAll("#chat-log [data-message-id], "
                + ".chat-log [data-message-id]")].pop();
            last?.scrollIntoView?.({ block: "end", behavior: "instant" });
        } catch (_) { /* the panes above already moved */ }

        console.log(`${MODULE_ID} | chat to the end (${why}):\n  ${lines.join("\n  ")}`);
        if (thumb) {
            const top = Math.round(thumb.scrollTop);
            const travel = Math.max(0, Math.round(thumb.scrollHeight - thumb.clientHeight));
            if (top < travel - 1) {
                console.warn(`${MODULE_ID} | the bar he drags (${scrollerName(thumb)}) is still `
                    + `${travel - top}px SHORT of the bottom. Do not read the lines above as a `
                    + `success.`);
            }
        }
    } catch (err) {
        console.warn(`${MODULE_ID} | could not take the chat to the end:`, err);
    }
}

/**
 * Kept as the name the card path calls, now that there is no window to hold.
 * One pass, here and at the end of the apply.
 */
export function followTheLog(why, _cardEl = null) {
    scrollChatToEnd(why);
}

/**
 * ⚠️ THE END OF THE PIPELINE IS A SCROLL (his rule, 2026-10-01: "The last thing
 * the pipeline does, after the card is in the log and the apply is finished, is
 * scroll."). Every landing The One Road names ends with the chat at the bottom,
 * so the card, the apply and what landed can arrive in any order and the last of
 * them is still the one that leaves the bar at the end.
 */
let _endOfPipelineWired = false;
export function registerScrollAtTheEnd() {
    if (_endOfPipelineWired) return;
    _endOfPipelineWired = true;
    for (const name of ["saveComplete", "damageApplied", "killLogged", "concentrationBroken",
        "attackResolved", "expectCard"]) {
        Hooks.on(`${MODULE_ID}.${name}`, () => scrollChatToEnd(`ACE finished ${name}`));
    }
    console.debug(`${MODULE_ID} | the chat goes to the end when an apply finishes, not before it.`);
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
