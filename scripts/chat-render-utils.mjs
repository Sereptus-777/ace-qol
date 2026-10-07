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
/**
 * Is this creature one of the party?
 *
 * ⚠️ OWNED BY A PLAYER, WHICH IS THE ONLY HONEST TEST. Not "is it a character"
 * and not a folder name: a sidekick, a familiar and a player's own summon are all
 * the party's, and a creature nobody at the table owns is his. Used wherever a
 * number is the party's to read out loud rather than the GM's to keep.
 */
export function isPartyActor(actorId) {
    try {
        const actor = actorId ? game.actors?.get(actorId) : null;
        if (!actor) return false;
        return (game.users ?? []).some(u => !u.isGM && actor.testUserPermission(u, "OWNER"));
    } catch (_) {
        return false;
    }
}

/**
 * Whether this screen may read a DC being rolled against by `rollers`.
 *
 * @param {string|null} rollers  one actor id, or several separated by spaces
 * @param {string|null} whose    the creature the DC belongs to, when it is known
 */
export function maySeeDC(rollers, whose = null) {
    try {
        if (game.user?.isGM) return true;
        /* ⚠️ A PARTY MEMBER'S OWN DC IS THE TABLE'S (his rule, 2026-10-06: "If one
           of the party cast it, the table also sees his formula and his DC.
           Firaxis casts Fireball: 8d6 fire, DC 13..."). The roller test below is
           about a number somebody is rolling AGAINST; this is about a number one
           of them set, which the whole table is entitled to hear. */
        if (whose && isPartyActor(whose)) return true;
        const ids = String(rollers ?? "").split(/\s+/).filter(Boolean);
        if (!ids.length) return false;          // nobody is rolling it yet
        return ids.some(id => !!game.actors?.get(id)?.isOwner);
    } catch (_) {
        return false;                           // unreadable: not this screen's
    }
}

/**
 * The wrapper for a bonus that belongs to one creature: a to-hit bonus, a check
 * bonus, the arithmetic behind a roll.
 *
 * His rule, 2026-10-06: "A creature's attack: they see the die, Hit or Miss, and
 * the damage if it hit. They do not see the bonus" — and the other way for the
 * party: "A character saving against a creature: they see his die, his own bonus,
 * Failed or Saved".
 *
 * ⚠️ WHOSE, NOT WHO IS LOOKING. A party member's bonus is public to the whole
 * table, not only to the player who owns him, because it is read out at the table
 * anyway. A creature's is the GM's alone.
 */
export function bonusSpan(text, whose = null, extraClass = "") {
    const esc = (v) => String(v ?? "")
        .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    return `<span class="ace-qol-bonus${extraClass ? ` ${extraClass}` : ""}"`
        + `${whose ? ` data-bonus-actor="${esc(whose)}"` : ""}>${text}</span>`;
}

/** Reveal, on THIS screen, the bonuses this viewer is entitled to. */
export function revealOwnBonuses(root, message = null) {
    try {
        /* ⚠️🔴 A MODIFIER CHIP IS A BONUS (his rule, 2026-10-06: "On the
           player's half of a damage card, hide ace-qol-mod-labeled. That is the
           +4 STR... It does not see a creature's strength, or any other bonus.
           The GM half still shows the +4 STR. Same rule for every creature bonus
           on every card, not only this fist.").

           `.ace-qol-mod-labeled` is the chip the whole suite paints a named
           modifier with - the ability, proficiency, a magic weapon, a named buff -
           on the damage card, the attack card and the merge card alike. Reading it
           by its own class is what makes this one rule rather than a wrapper that
           has to be remembered at every emission site; the next card that paints a
           modifier gets the rule for free, and a site that forgets it leaks
           nothing because the class ships hidden.

           Whose bonus it is comes from the chip if it says, and otherwise from the
           creature whose roll the card is about. A party member's own chip stays
           public, because his numbers are read out at the table anyway. */
        const ofCard = message?.flags?.[MODULE_ID]?.actorId ?? null;
        const decide = (el, id) => {
            const mine = game.user?.isGM || isPartyActor(id);
            if (mine) el.dataset.aceBonus = "show";
            else delete el.dataset.aceBonus;
        };
        for (const el of (root?.querySelectorAll?.(".ace-qol-bonus") ?? [])) {
            decide(el, el.dataset?.bonusActor ?? null);
        }
        for (const el of (root?.querySelectorAll?.(".ace-qol-mod-labeled") ?? [])) {
            /* Whose it is, in order: the chip itself, then the wrapper it sits in
               (the attack card puts its whole arithmetic inside one that names the
               attacker), then the creature whose roll the card is about. Without
               the middle step a party member's own chips would be hidden from his
               own table on the one card that already knew the answer. */
            const owner = el.dataset?.bonusActor
                ?? el.closest?.(".ace-qol-bonus[data-bonus-actor]")?.dataset?.bonusActor
                ?? ofCard;
            decide(el, owner);
        }
    } catch (err) {
        console.warn(`${MODULE_ID} | could not decide which bonuses this screen may see, so none `
            + `of them are shown here:`, err);
    }
}

/**
 * The wrapper every card puts a DC in.
 *
 * @param {string|number} text        e.g. "DC 14 Dexterity"
 * @param {string|string[]|null} rollers  the creature(s) rolling against it
 * @param {string} [extraClass]       any styling class the card already used
 */
export function dcSpan(text, rollers = null, extraClass = "", { whose = null } = {}) {
    const esc = (v) => String(v ?? "")
        .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    const ids = (Array.isArray(rollers) ? rollers : [rollers]).filter(Boolean).join(" ");
    return `<span class="ace-qol-dc${extraClass ? ` ${extraClass}` : ""}"`
        + `${ids ? ` data-dc-roller="${esc(ids)}"` : ""}`
        + `${whose ? ` data-dc-owner="${esc(whose)}"` : ""}>${esc(text)}</span>`;
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
    const decide = (el, rollers, whose = null) => {
        if (maySeeDC(rollers, whose)) { el.dataset.aceDc = "show"; shown++; }
        else { delete el.dataset.aceDc; hidden++; }
    };
    try {
        for (const el of (root?.querySelectorAll?.(".ace-qol-dc") ?? [])) {
            decide(el, el.dataset?.dcRoller ?? null, el.dataset?.dcOwner ?? null);
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

/* ═══════════════════════════════════════════════════════════════════════════
   THE SYSTEM'S OWN CARDS WEAR ACE'S CHROME

     His ask, 2026-10-01: *"for short rest, long rest, initiative, and any of
     the dice that I roll off of (the dice that are underneath the chat card), I
     want them to look like ours. With our black background, only 1px wide."*

   These four are dnd5e's and Foundry's, not ACE's, and ACE does not post a card
   in their place, so they sat in the log as manila parchment beside every ACE
   card. This does not rebuild them: it dresses them.

   ⚠️ IT IS A SKIN, NOT A STAMP AS AN ACE CARD. `data-ace-card` hides the whole
   speaker strip, flavor text included (§ 13.1), and on a rest card the flavor IS
   the card's title: "Long Rest (8 hours, new day)". Stamping these would have
   thrown away the one line that says what happened. A second marker,
   `data-ace-skin`, changes the dressing and keeps every word.

   ⚠️ THE PLATFORM'S OWN DARK SWITCH DOES THE READING. dnd5e draws its cards
   from `--dnd5e-*` colour variables and Foundry from `--color-text-*`, and both
   define a full dark set behind `.themed.theme-dark`. Repainting the background
   black and leaving the text on its light-theme values would have left dark grey
   on black; moving the message to the dark theme is one class and the system
   recolours its own card. `theme-light` comes off first, or both sets apply and
   which one wins is whichever happens to be defined later.
 */
const ACE_SKIN = "data-ace-skin";

/** A rest card, an initiative roll, or anything with dice under it. */
function wantsAceSkin(message, el) {
    try {
        // Not ACE's own cards: those have their own frame and their own look.
        if (el?.getAttribute?.("data-ace-card") === "1") return false;
        const type = String(message?.type ?? message?.system?.constructor?.metadata?.type ?? "");
        // ⚠️ TWO TESTS FOR THE REST CARD. The data model's type is dnd5e's own
        // answer, and the class is the one the template actually draws; a rename
        // in either place leaves the other still working.
        if (type === "dnd5e.rest" || el?.querySelector?.(".rest-card")) return true;
        if (message?.flags?.core?.initiativeRoll === true
            || message?.getFlag?.("core", "initiativeRoll") === true) return true;
        // "any of the dice that I roll off of (the dice that are underneath the
        // chat card)" — every roll panel, whoever posted it.
        if (el?.querySelector?.(".dice-roll")) return true;
        return false;
    } catch (err) {
        console.warn(`${MODULE_ID} | could not tell whether this card wants ACE's dressing, `
            + `so it keeps Foundry's:`, err);
        return false;
    }
}

/**
 * Dress one of the system's cards in ACE's chrome.
 * @returns {boolean} whether it was dressed
 */
export function skinSystemCard(message, el) {
    try {
        if (!el?.setAttribute) return false;
        if (!wantsAceSkin(message, el)) return false;
        el.setAttribute(ACE_SKIN, "1");
        el.classList?.remove?.("theme-light");
        el.classList?.add?.("themed", "theme-dark");
        return true;
    } catch (err) {
        console.warn(`${MODULE_ID} | could not dress a system card in ACE's chrome, so it `
            + `keeps Foundry's parchment:`, err);
        return false;
    }
}

/**
 * The chrome pass: one registration for the two things every ACE card needs on
 * every screen. No speaker strip (§ 13.1), and a DC only on a roll this screen
 * is making (§ 13.2).
 */
/**
 * The GM half of an ACE card, revealed on the GM's screen and nowhere else.
 *
 * ⚠️🔴 ONE CARD, TWO HALVES (his rule, 2026-10-06: "Every card that reaches a
 * player follows one rule. The hidden half is the gm-only part of the same black
 * card. Do not whisper the card away, and do not leave the hidden numbers in the
 * public half.").
 *
 * `.ace-qol-gm-only` ships hidden by the stylesheet and is turned on here by
 * stamping `data-ace-gm`. That stamp used to live inside the SAVE engine's own
 * render handler, so it reached save cards and nothing else: every other card in
 * the suite either leaked its GM half or whispered itself away from the table.
 * It is in the one pass now, beside the DC and the AC, which is the same
 * correction those two already carry in their own comments.
 *
 * @returns {{shown:number}} how many blocks this screen was allowed to see
 */
export function revealGmHalf(root) {
    let shown = 0;
    try {
        if (!game.user?.isGM) return { shown: 0 };
        for (const el of (root?.querySelectorAll?.(".ace-qol-gm-only") ?? [])) {
            el.setAttribute("data-ace-gm", "true");
            shown++;
        }
    } catch (err) {
        console.warn(`${MODULE_ID} | could not reveal the GM half of a card, so it stays hidden `
            + `on this screen:`, err);
    }
    return { shown };
}

export function registerAceChrome() {
    registerChatCardHandler((message, el) => {
        stampAceCard(message, el);
        skinSystemCard(message, el);   // after the stamp: an ACE card is never skinned
        revealOwnDCs(el);
        revealOwnACs(el);
        revealOwnBonuses(el, message);
        revealGmHalf(el);
        takeLogToNewCard(message, el);
    }, "ACE card chrome", { sweepAll: true });
    registerAceCardScroll();
    registerScrollAtTheEnd();
    console.log(`${MODULE_ID} | ACE cards drop Foundry's speaker strip and keep the ⋮; a DC `
        + `shows for the GM, and for a player on a roll they are making. Rest, initiative `
        + `and any card with dice under it take ACE's black and a 1px frame.`);
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
/**
 * The last chat message on screen, however the log is built this generation.
 *
 * ⚠️ NOT "inside #chat-log". That is what blinded the scan: the messages were
 * found through `#chat-log [data-message-id]`, and if the log element is not
 * called that here, `last` was undefined, the ancestor walk never ran, and the
 * only candidates left were the named selectors.
 */
function inTheNotifications(el) {
    try { return !!el?.closest?.("#chat-notifications, .chat-notifications"); }
    catch (_) { return false; }
}

/**
 * The REAL copy of a message, and the pane whose bar he drags.
 *
 * ⚠️🔴 HIS AUDIT, 2026-10-01, and he read it out of the DOM himself: "That node
 * is in a 733px ol.chat-log. Its div.chat-scroll is 1117/1117 and has no
 * overflowed class. The bar is the other one, div.chat-scroll.overflowed...
 * lastChatMessage() is returning the notification copy."
 *
 * Exactly right, and Foundry's own source says so twice over. `_toggleNotifications`
 * builds a SECOND `.chat-log` inside `#chat-notifications` holding copies of
 * recent messages — the same message id in two places — and `#setOverflowing`
 * toggles `.overflowed` on the real `.chat-scroll` when its content is taller
 * than it is. So the notification copy is indistinguishable by id and the real
 * pane announces itself by class. My scan walked the last `[data-message-id]`
 * anywhere in the document, which is the notification copy, measured its
 * container at 1117/1117, and reported that nothing scrolls.
 *
 * @param {string} id  the message id
 * @returns {{li: Element, box: Element|null, why: string, candidates: string[]}|null}
 */
export function realLogCopyOf(id) {
    if (!id) return null;
    const all = [...document.querySelectorAll(`[data-message-id="${id}"]`)];
    const seen = [];
    let best = null;
    for (const li of all) {
        const box = li.closest?.(".chat-scroll") ?? null;
        const notif = inTheNotifications(li);
        const overflowed = !!box?.classList?.contains?.("overflowed");
        const travel = box ? Math.max(0, box.scrollHeight - box.clientHeight) : 0;
        seen.push(`${notif ? "notification copy" : "log copy"}`
            + ` in ${box ? `${box.tagName.toLowerCase()}.${String(box.className).trim().split(/\s+/).join(".")}`
                : "no .chat-scroll"}`
            + ` ${box ? `${box.scrollHeight}/${box.clientHeight}` : ""}`
            + `${overflowed ? " [overflowed]" : ""} travel=${travel}`);
        if (notif) continue;                      // never the notification strip
        // The one Foundry marked as overflowing is the bar; failing that, the
        // one with travel; failing that, keep the first real log copy so there
        // is always something to report.
        const rank = (overflowed ? 2 : 0) + (travel > 1 ? 1 : 0);
        if (!best || rank > best.rank) best = { li, box, rank, overflowed, travel };
    }
    if (!best) return null;
    return {
        li: best.li, box: best.box, candidates: seen,
        why: best.overflowed ? ".chat-scroll.overflowed"
            : best.travel > 1 ? "the real log copy, which has travel"
            : "the real log copy, which does NOT scroll",
    };
}

/**
 * The last message in the REAL log, never the notification strip.
 */
function lastChatMessage() {
    const all = [...document.querySelectorAll("li.chat-message[data-message-id], "
        + "[data-message-id]")].filter(el => !inTheNotifications(el));
    return all.length ? all[all.length - 1] : null;
}

/**
 * Measure every candidate pane, whether or not it turns out to scroll.
 *
 * ⚠️🔴 HIS RULE, 2026-10-01, after the scan reported "no chat pane has a
 * scrollbar" while the log was visibly cut off: "The scan is blind. Log every
 * candidate: tag, id, class, scrollHeight, clientHeight, overflow... If none
 * qualify, say so and name what you measured. Do not claim there was nothing to
 * move."
 *
 * He is right twice over. A scan that only reports what passed its own filter
 * cannot be debugged, and "nothing to move" was a conclusion about the chat drawn
 * from a list that may never have contained the chat at all. So this measures
 * first and decides second, and the measurements are the log.
 *
 * @returns {{el: Element, why: string, tag: string, id: string, cls: string,
 *            scrollHeight: number, clientHeight: number, overflow: string,
 *            travel: number, scrolls: boolean}[]}
 */
function measureChatPanes() {
    const seen = new Map();
    const look = (el, why) => {
        if (!el || !(el instanceof Element) || el === document.body) return;
        if (seen.has(el)) {
            if (!seen.get(el).why.includes(why)) seen.get(el).why += ` + ${why}`;
            return;
        }
        let overflow = "?";
        try {
            const cs = getComputedStyle(el);
            overflow = `${cs.overflow}/${cs.overflowY}`;
        } catch (_) { /* detached or cross-document */ }
        const scrollHeight = Math.round(el.scrollHeight);
        const clientHeight = Math.round(el.clientHeight);
        seen.set(el, {
            el, why,
            tag: el.tagName.toLowerCase(),
            id: el.id || "",
            cls: String(el.className || "").trim(),
            scrollHeight, clientHeight, overflow,
            travel: Math.max(0, scrollHeight - clientHeight),
            scrolls: scrollHeight > clientHeight + 1,
        });
    };

    // His list, by name, everywhere it exists.
    // ⚠️ `.chat-scroll.overflowed` is listed in its own right: Foundry's
    // `#setOverflowing` puts that class on the pane whose content is taller than
    // it is, which is the one definition of "the bar he drags" the app itself
    // provides. The notification strip is measured too, and named, so a copy
    // found there is visible in the log instead of mistaken for the chat.
    for (const sel of ["#chat", "#chat-log", ".chat-log", ".chat-scroll", ".chat-scroll.overflowed",
        "#sidebar", "#sidebar #chat", "#chat-popout", ".chat-popout", ".chat-sidebar",
        "section.chat", "#chat-notifications", ".chat-notifications"]) {
        for (const el of document.querySelectorAll(sel)) look(el, sel);
    }
    // Whatever Foundry itself holds, sidebar and popout.
    try { look(ui.chat?.element, "ui.chat.element"); } catch (_) {}
    try { look(ui.chat?.element?.querySelector?.(".chat-scroll"), "ui.chat's .chat-scroll"); } catch (_) {}
    try { look(ui.chat?.popout?.element, "popout element"); } catch (_) {}
    try { look(ui.chat?.popout?.element?.querySelector?.(".chat-scroll"), "popout .chat-scroll"); } catch (_) {}
    // And every parent of the last message, which is the only path that cannot
    // miss the element actually holding the bar.
    let box = lastChatMessage()?.parentElement ?? null;
    let depth = 0;
    while (box && box !== document.body && depth++ < 20) {
        look(box, `parent ${depth} of the last message`);
        box = box.parentElement;
    }
    return [...seen.values()];
}

/**
 * THE LAST THING: the last message into view, and every pane that scrolls put at
 * the bottom. Measured out loud, every time.
 *
 * ⚠️ ONCE, AT THE END (his rule). Called when the card is in the log and again
 * when ACE says an apply has finished, so the last one to run is the one that
 * counts and nothing lets go of the bar afterwards.
 */
export function scrollChatToEnd(why) {
    try {
        const panes = measureChatPanes();

        // ⚠️ THE LAST MESSAGE FIRST, because it is the one move that does not
        // depend on having identified the right box: the browser scrolls whatever
        // ancestor has to move to put that element on screen.
        const last = lastChatMessage();
        try { last?.scrollIntoView?.({ block: "end", behavior: "instant" }); }
        catch (_) { /* the panes below still get driven */ }

        const scrollers = panes.filter(p => p.scrolls);
        // Drive every one of them, then read each back.
        for (const p of scrollers) p.el.scrollTop = p.el.scrollHeight;

        const line = (p) => {
            const top = Math.round(p.el.scrollTop);
            const travel = Math.max(0, Math.round(p.el.scrollHeight - p.el.clientHeight));
            const at = p.scrolls ? (top >= travel - 1 ? "AT MAX" : `SHORT by ${travel - top}`)
                : "does not scroll";
            return `${p.tag}${p.id ? `#${p.id}` : ""}${p.cls ? `.${p.cls.split(/\s+/).join(".")}` : ""}`
                + ` [${p.why}] scrollHeight=${p.scrollHeight} clientHeight=${p.clientHeight}`
                + ` overflow=${p.overflow} travel=${p.travel} → ${at}`;
        };

        console.log(`${MODULE_ID} | chat to the end (${why}) — ${panes.length} candidate(s) measured, `
            + `${scrollers.length} scroll:\n  ${panes.map(line).join("\n  ")}`
            + `\n  last message: ${last ? `${last.tagName.toLowerCase()}`
                + `[data-message-id="${last.dataset?.messageId ?? "?"}"] brought into view`
                : "NONE FOUND — nothing matched li.chat-message or [data-message-id]"}`);

        if (!scrollers.length) {
            // ⚠️ NOT "nothing to move". That was a claim about the chat; this is a
            // report of what was measured and found wanting.
            console.warn(`${MODULE_ID} | none of those ${panes.length} candidates has a scrollbar `
                + `(scrollHeight greater than clientHeight). The measurements are above — if the log `
                + `is cut off, the element holding it is not in that list and its name is what is `
                + `needed next.`);
            return;
        }
        // The widest travel is the thumb he drags; say so when it is still short.
        const thumb = scrollers.reduce((a, b) => (b.travel > a.travel ? b : a));
        const top = Math.round(thumb.el.scrollTop);
        const travel = Math.max(0, Math.round(thumb.el.scrollHeight - thumb.el.clientHeight));
        if (top < travel - 1) {
            console.warn(`${MODULE_ID} | the bar he drags (${thumb.tag}${thumb.id ? `#${thumb.id}` : ""}`
                + `${thumb.cls ? `.${thumb.cls.split(/\s+/)[0]}` : ""}) is still ${travel - top}px SHORT `
                + `of the bottom. Do not read the lines above as a success.`);
        }
    } catch (err) {
        console.warn(`${MODULE_ID} | could not take the chat to the end:`, err);
    }
}

/**
 * Take the pane that holds THIS message to the bottom.
 *
 * ⚠️🔴 HIS RULE, 2026-10-01: "Find every li with the save message id. Keep the one
 * inside the div.chat-scroll that has the overflowed class... then set that
 * element's scrollTop to its scrollHeight. If you still measure 1117/1117, you
 * still have the notification copy. Say so."
 *
 * @param {string} id   the message whose pane to move
 * @param {string} why  for the log
 * @returns {boolean}   whether that pane ended at its bottom
 */
export function takeTheRealLogToBottom(id, why) {
    try {
        const found = realLogCopyOf(id);
        if (!found) {
            console.warn(`${MODULE_ID} | ${why}: no copy of message ${id} is in the chat log at all `
                + `(only the notification strip, or none).`);
            return false;
        }
        const box = found.box;
        if (!box) {
            console.warn(`${MODULE_ID} | ${why}: the log copy of ${id} has no .chat-scroll above it. `
                + `Candidates: ${found.candidates.join(" | ")}`);
            return false;
        }
        const h = Math.round(box.scrollHeight);
        const vis = Math.round(box.clientHeight);
        const travel = Math.max(0, h - vis);
        const name = `${box.tagName.toLowerCase()}.${String(box.className).trim().split(/\s+/).join(".")}`;
        if (travel <= 1) {
            // ⚠️ HIS OWN TEST FOR IT. A pane as tall as its content is not the bar.
            console.warn(`${MODULE_ID} | ${why}: ${name} measures ${h}/${vis} — no travel, so this is `
                + `NOT the bar he drags and is very likely still the notification copy. `
                + `Candidates: ${found.candidates.join(" | ")}`);
            return false;
        }
        box.scrollTop = box.scrollHeight;
        const top = Math.round(box.scrollTop);
        const down = top >= travel - 1;
        console.log(`${MODULE_ID} | ${why}: ${name} (${found.why}) ${h}/${vis} travel=${travel} `
            + `scrollTop=${top} → ${down ? "AT MAX" : `SHORT by ${travel - top}`}`);
        if (!down) {
            console.warn(`${MODULE_ID} | that bar is still ${travel - top}px short. Do not read the `
                + `line above as a success.`);
        }
        return down;
    } catch (err) {
        console.warn(`${MODULE_ID} | could not take the log to message ${id}:`, err);
        return false;
    }
}

/**
 * Kept as the name the card path calls. One pass, here and at the end of the
 * apply.
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
