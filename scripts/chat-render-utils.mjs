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

import { fillRendered, isParty } from "./road/table-view.mjs";
import { onRenderChatMessage } from "./foundry-compat.mjs";

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
    // The one helper picks the hook (foundry-compat.mjs, Foundry 13 and 14).
    onRenderChatMessage(handler);

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
    // ⚠️ ONE TEST (2026-10-11): the one function cuts by it before a card is sent
    // (road/table-view.mjs), and this pass shows by it. Two copies of the
    // question would leave a number in a player's copy and hidden.
    return isParty(actorId);
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

/**
 * A save's own named sum, " + 1 WIS = 7": the roller's to read.
 *
 * ⚠️🔴 A PARTY MEMBER'S OWN SAVE IS THE TABLE'S (His rule, 2026-10-12: "The GM card prints '6 + 1 = 7'. The +1 is not named.
 * It has to say where it came from: 6 + 1 WIS = 7... The player card prints the
 * die, the word FAIL... No formula and no total. This is his own save. He knows
 * his own bonus, and the other players are allowed to see it... Name every bonus
 * that way, on both cards, in capitals... One bare +1 is not an answer... A
 * creature's bonus stays off the player card.")
 *
 * So it is not `ace-qol-bonus`, which is a d20's arithmetic and the GM's for
 * everybody (an attack's included). This one belongs to the creature named on it:
 * the one function (road/table-view.mjs, CHIP_CLASSES) keeps it on every copy of
 * the card when that creature is a party member's and cuts it to the GM's when it
 * is a creature's, and revealOwnBonuses shows it on the same test.
 */
export function saveBonusSpan(text, whose = null) {
    const esc = (v) => String(v ?? "")
        .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    return `<span class="ace-qol-save-bonus"${whose ? ` data-bonus-actor="${esc(whose)}"` : ""}>${text}</span>`;
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
        // The same chain the one function cut the chip by (road/table-view.mjs
        // cardActorOf): any ACE module's own actorId, then the speaker.
        const ofCard = ["ace-qol", "ace-artificer", "ace-engine", "ace-envoy"]
            .map(ns => message?.flags?.[ns]?.actorId).find(Boolean)
            ?? message?.speaker?.actor ?? null;
        const decide = (el, id) => {
            const mine = game.user?.isGM || isPartyActor(id);
            if (mine) el.dataset.aceBonus = "show";
            else delete el.dataset.aceBonus;
        };
        // ⚠️ A d20's arithmetic is the GM's, a party member's included (his rule,
        // 2026-10-11: "A party member's save row is the die and PASS or FAIL...
        // That is not the spell."). road/table-view.mjs cuts it from every
        // player's copy; this only shows it on the GM's screen.
        for (const el of (root?.querySelectorAll?.(".ace-qol-bonus") ?? [])) {
            if (game.user?.isGM) el.dataset.aceBonus = "show";
            else delete el.dataset.aceBonus;
        }
        // A save's own named sum: the GM's, and a party member's own on every
        // screen (his rule, 2026-10-12: "Do not hide Virric's Wisdom from Virric").
        for (const el of (root?.querySelectorAll?.(".ace-qol-save-bonus") ?? [])) {
            decide(el, el.dataset?.bonusActor ?? ofCard);
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
        // ⚠️ ON BLACK NOW, SO IN THE DARK THEME (his rule, 2026-10-12: "The cream
        // frame around the outside goes"). The card's margin is the skinned roll
        // card's black with dnd5e's slate in it; anything the system draws inside
        // reads its dark-theme colours, the way the skin above moves a roll card.
        el.classList?.remove?.("theme-light");
        el.classList?.add?.("themed", "theme-dark");
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
        // ⚠️🔴 AND BOTH WERE ASKED WRONG (his finding, 2026-10-11: "It stays
        // parchment because the skin never lands."). dnd5e posts the message as
        // type "rest" (PROVEN, dnd5e.mjs: `type: "rest"`), not "dnd5e.rest"; and
        // the class is on the card element itself, which querySelector never
        // matches because it only looks inside. Both are asked as they are now.
        const restType = type === "rest" || type === "dnd5e.rest";
        const restClass = !!(el?.classList?.contains?.("rest-card") || el?.matches?.(".rest-card")
            || el?.querySelector?.(".rest-card"));
        if (restType || restClass) return true;
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
        // The damage row's GM controls are the same half by another name; the
        // stylesheet hides both until this marks them (2026-10-11).
        // Forge's GM half is the same half again, on Forge's cards (2026-10-11).
        for (const el of (root?.querySelectorAll?.(".ace-qol-gm-only, .ace-qol-dmg-gm-controls, .forge-gm-only") ?? [])) {
            el.setAttribute("data-ace-gm", "true");
            shown++;
        }
        // The other way round: what is written for the table in words (an
        // attack's sentence) steps aside on the GM's screen, whose card keeps the
        // math (his rule, 2026-10-11).
        for (const el of (root?.querySelectorAll?.(".ace-qol-table-only") ?? [])) {
            el.setAttribute("data-ace-gm", "true");
        }
    } catch (err) {
        console.warn(`${MODULE_ID} | could not reveal the GM half of a card, so it stays hidden `
            + `on this screen:`, err);
    }
    return { shown };
}

/* ═══════════════════════════════════════════════════════════════════════════
   A CARD NEVER SHOWS A PICTURE THAT IS NOT THERE

     His rule, 2026-10-12: *"A card never shows an image whose file is not
     there. The header uses Charm Person's own icon, a file that exists. A
     missing portrait is left out and the missing path is said in the console.
     The cast is not stopped and nothing asks him."*

   The Lamia's portrait points at "Lamia 03.png", which the server answers with
   a 404, so every Charm Person card she cast drew a broken picture in its header
   and asked for the file again on every redraw. One pass, here, for every ACE
   card on every screen: a picture that fails is swapped for the fallback its
   card named (`data-ace-fallback`), or else taken off the card. The path is said
   once per session, and a path already known to be missing is taken off before
   it is asked for again.

   ⚠️ A PICTURE WITH ITS OWN onerror IS LEFT TO IT. The d20 face (dice-face.mjs)
   already swaps itself for an icon; taking it away first would lose that.
   ═══════════════════════════════════════════════════════════════════════════ */

/** Picture paths this screen has found missing, this session. */
const _missingImages = new Set();

function _pictureMissing(img, src, cardWhat) {
    try {
        if (!_missingImages.has(src)) {
            _missingImages.add(src);
            let shown = src;
            try { shown = decodeURI(src); } catch (_) { /* shown as it is */ }
            console.warn(`${MODULE_ID} | the picture "${shown}" is not there (the server has no such `
                + `file), so it is left off ${cardWhat}. Nothing else changes.`);
        }
        const fallback = img.getAttribute("data-ace-fallback");
        img.removeAttribute("data-ace-fallback");
        if (fallback && fallback !== src && !_missingImages.has(fallback)) {
            console.log(`${MODULE_ID} | ${cardWhat} shows its fallback picture instead: "${fallback}".`);
            img.addEventListener("error", () => _pictureMissing(img, fallback, cardWhat), { once: true });
            img.setAttribute("src", fallback);
            return;
        }
        img.remove();
    } catch (err) {
        console.warn(`${MODULE_ID} | could not take a missing picture off ${cardWhat}:`, err);
    }
}

/** Swap or remove every picture on this card whose file is not there. */
export function guardCardImages(message, el) {
    try {
        if (!el?.querySelectorAll) return 0;
        if (!isAceCard(message, el) && el.getAttribute?.(ACE_SKIN) !== "1") return 0;
        const cardWhat = `the card ${message?.id ?? ""}`.trim();
        let known = 0;
        for (const img of el.querySelectorAll("img")) {
            if (img.dataset.aceImgGuard === "1" || img.hasAttribute("onerror")) continue;
            const src = img.getAttribute("src") ?? "";
            if (!src || src.startsWith("data:")) continue;
            img.dataset.aceImgGuard = "1";
            if (_missingImages.has(src)) { _pictureMissing(img, src, cardWhat); known++; continue; }
            img.addEventListener("error", () => _pictureMissing(img, src, cardWhat), { once: true });
            // A picture that already failed before anybody was listening.
            if (img.complete && img.naturalWidth === 0 && img.currentSrc) _pictureMissing(img, src, cardWhat);
        }
        return known;
    } catch (err) {
        console.warn(`${MODULE_ID} | could not check the pictures on a card, so a missing one may `
            + `show as broken:`, err);
        return 0;
    }
}

export function registerAceChrome() {
    registerChatCardHandler((message, el) => {
        // First: the numbers this screen is entitled to, put back where they were
        // cut (road/table-view.mjs). Everything after reads a whole card.
        fillRendered(message, el);
        stampAceCard(message, el);
        skinSystemCard(message, el);   // after the stamp: an ACE card is never skinned
        guardCardImages(message, el);
        revealOwnDCs(el);
        revealOwnACs(el);
        revealOwnBonuses(el, message);
        revealGmHalf(el);
        dressACsAndDCs(el);
    }, "ACE card chrome", { sweepAll: true });
    registerChatScroll();
    registerScrollAtTheEnd();
    console.log(`${MODULE_ID} | ACE cards drop Foundry's speaker strip and keep the ⋮; a DC `
        + `shows for the GM, and for a player on a roll they are making. Rest, initiative `
        + `and any card with dice under it take ACE's black and a 1px frame.`);
}

/* ═══════════════════════════════════════════════════════════════════════════
   EVERY CARD TAKES THE CHAT TO THE BOTTOM, EVERY TIME

     His rule, 2026-10-12: *"Every card, every time. A message posted to chat
     calls ui.chat.scrollBottom({ popout: true, waitImages: true }) after that
     card is in the log. The next card calls it again. Not the first card of a
     session, not ACE cards only, not once. Sidebar and popout both. Do not set
     scrollTop. Do not walk the nine candidates. If the card is not in the log on
     that frame, call it again when it is."*

   ⚠️🔴 THIS REPLACES EVERYTHING THAT WAS HERE. ACE cards only, a set of cards
   "created in this session", every candidate pane measured and its scrollTop
   set, the last message pulled into view: each of those was a rule of its day
   (09-30, 10-01) and each was a way for some card to be left below the fold.
   One call, Foundry's own, for every message on every screen that shows it.

   PROVEN FROM FOUNDRY V13 (ChatLog#scrollBottom): it puts the sidebar log's own
   .chat-scroll at the bottom, after that log's pictures have loaded when asked
   to wait for them, and with `popout: true` asks the popped-out chat to do the
   same. Its own #postOne scrolls only when the log was already at the bottom or
   the message is yours; this is the call for everyone else.

   ⚠️ AFTER THE APPEND. #postOne awaits the render (where every render hook
   fires) and only then appends, so the card is not in the log during
   createChatMessage or the render hook. The call is made on the next frame and
   made again on the first frame the card is found in the log.
   ══════════════════════════════════════════════════════════════════════════ */

let _scrollRegistered = false;

/** A frame in a browser, a tick in a harness (the replay runs headless). */
const _nextFrame = (fn) => (typeof requestAnimationFrame === "function"
    ? requestAnimationFrame(fn) : setTimeout(fn, 16));

/** Is this message in the chat log, sidebar or popout? Never the notification strip. */
function _inTheLog(id) {
    const sel = `.chat-log [data-message-id="${id}"]`;
    try {
        return !!(ui.chat?.element?.querySelector?.(sel)
            ?? ui.chat?.popout?.element?.querySelector?.(sel));
    } catch (_) { return false; }
}

/**
 * Every message posted to this screen's chat, ACE's or not, mine or not, takes
 * the chat to the bottom once it is in the log.
 */
export function registerChatScroll() {
    if (_scrollRegistered) return;
    _scrollRegistered = true;
    Hooks.on("createChatMessage", (message) => {
        try {
            // Whispered past this screen: it is never put in this log.
            if (message?.visible === false) return;
            scrollWhenInTheLog(message.id);
        } catch (err) {
            console.warn(`${MODULE_ID} | could not take the chat to a new card:`, err);
        }
    });
}

/**
 * Foundry's own scroll on the next frame, and again on the frame the card is in
 * the log. Bounded, and it says so if the card never arrives.
 */
export function scrollWhenInTheLog(id, why = "a new card") {
    let frames = 0;
    let called = false;
    const look = () => {
        const there = _inTheLog(id);
        if (there || !called) scrollChatToEnd(`${why} (${id})${there ? "" : ", not in the log yet"}`);
        called = true;
        if (there) return;
        if (++frames > 180) {
            console.warn(`${MODULE_ID} | message ${id} never reached the chat log, so the chat was `
                + `not taken to it.`);
            return;
        }
        _nextFrame(look);
    };
    _nextFrame(look);
}

/**
 * The chat to the bottom: Foundry's own call, sidebar and popout, after the
 * pictures. Every other ACE moment that ends with a card calls this too.
 */
export function scrollChatToEnd(why) {
    try {
        if (typeof ui.chat?.scrollBottom !== "function") {
            console.warn(`${MODULE_ID} | the chat log has no scrollBottom here, so it was not moved (${why}).`);
            return;
        }
        Promise.resolve(ui.chat.scrollBottom({ popout: true, waitImages: true }))
            .catch(err => console.warn(`${MODULE_ID} | the chat did not go to the bottom (${why}):`, err));
        console.debug(`${MODULE_ID} | chat to the bottom: ${why}`);
    } catch (err) {
        console.warn(`${MODULE_ID} | could not take the chat to the bottom (${why}):`, err);
    }
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

   ⚠️ 2026-10-11: THE GM'S ALONE, A PARTY MEMBER'S INCLUDED. His rule: "A player
   character's AC and hit points stay on my screen, same as a creature's." The
   one function (road/table-view.mjs) cuts every AC from every player's copy
   before the card is sent; this only shows it on the GM's screen.
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * What the table reads of an attack: the die, and what it did, in words.
 *
 * His rule, 2026-10-11, from the live test: "Fist shows a die reading 18 and
 * HIT, so the table reads it as a total and says 18 cannot hit. The die stays.
 * Beside it, in the left three quarters, the words are 'Rolled an 18 and hit.'
 * HIT, MISS, or CRIT stays on the right, same word as the sentence. 18 is the
 * die. It is not the total, and the total is not added to that side. My card
 * stays the math."
 *
 * So it is marked `.ace-qol-table-only`: on every screen but the GM's. The GM's
 * card keeps the die, the bonus, the total and the AC, and no sentence.
 *
 * ⚠️ THE YELLOW NUMBER MOVES INTO THE SENTENCE (his rule, the same afternoon:
 * "Switch the 13s. The yellow 13 beside the die moves into the sentence and
 * keeps its size and its yellow. The 13 beside the die is deleted. Do not
 * shrink it to the size of the words."). It keeps the die number's own class.
 *
 * @param {number} d20       the face the attack used
 * @param {object[]} results the attack's rows, each with its hitResult
 */
export function attackSentenceHtml(d20, results) {
    const face = Number(d20);
    if (!Number.isFinite(face)) return "";
    // The row's own word, said as a verb: HIT, MISS, CRIT!, FUMBLE.
    const said = (r) => r?.hitResult === "critical" ? "crit"
        : r?.hitResult === "hit" ? "hit"
        : r?.hitResult === "fumble" ? "fumbled"
        : "missed";
    const words = new Set((results ?? []).map(said));
    const article = [8, 11, 18].includes(face) ? "an" : "a";
    // One roll against targets that came out differently names no word: each
    // row's own word says it.
    const tail = words.size === 1 ? ` and ${[...words][0]}` : "";
    return `<span class="ace-qol-atk-table-line ace-qol-table-only">Rolled ${article} `
        + `<span class="ace-qol-atk-d20-result">${face}</span>${tail}.</span>`;
}

/* ═══════════════════════════════════════════════════════════════════════════
   EVERY AC AND EVERY DC: "vs AC 17", "vs DC 16", IN ORANGE

     His rule, 2026-10-13: *"Every AC and every DC, on every card, is bright
     orange, more orange than yellow. Not blue. A small 'vs' sits in front of it:
     vs AC 17, vs DC 16. The 'vs' is smaller than the number."*

   Every card already marks its AC and DC with one of three wrappers (.ace-qol-ac,
   .ace-qol-dc, .ace-qol-save-dc), which is how each screen is shown only the
   numbers it may see. The words inside them had drifted card by card: "DC 13",
   "vs DC 13", "(DC 13)", "· DC 17 Constitution", "AC 19 +2". This pass, in the
   chrome every ACE card goes through on every screen, says each one the same
   way: a small "vs", then the number. What follows the number stays ("vs DC 17
   Constitution", "vs AC 19 +2").

   ⚠️ ONLY WHAT A CARD MARKED. A DC written into a sentence ("makes a DC 10
   Constitution save") is not wrapped and is not touched: "makes a vs DC 10" is
   not English.
   ═══════════════════════════════════════════════════════════════════════════ */
const _AC_DC = /(?:\bvs\.?\s*)?\b(AC|DC)\s*(\d+)/i;
export function dressACsAndDCs(root) {
    let dressed = 0;
    try {
        for (const el of (root?.querySelectorAll?.(".ace-qol-ac, .ace-qol-dc, .ace-qol-save-dc") ?? [])) {
            if (el.dataset.aceVs === "1") continue;
            // A wrapper holding another: the inner one carries the number.
            if (el.querySelector(".ace-qol-ac, .ace-qol-dc, .ace-qol-save-dc")) continue;
            const text = el.textContent ?? "";
            const m = text.match(_AC_DC);
            if (!m) continue;
            const before = text.slice(0, m.index).replace(/[\s·(]+$/, "");
            const after = text.slice(m.index + m[0].length).replace(/^\s*\)/, "");
            // A marked DC inside a sentence ("must make a DC 15 Wisdom save") keeps
            // its orange and takes no "vs": "make a vs DC 15" is not English.
            const lead = `${el.previousSibling?.textContent ?? ""}${before}`;
            const inSentence = /\b(a|an|the)\s*$/i.test(lead);
            const vs = document.createElement("span");
            vs.className = "ace-qol-vs";
            vs.textContent = "vs";
            const num = document.createElement("span");
            num.className = "ace-qol-num";
            num.textContent = `${m[1].toUpperCase()} ${m[2]}`;
            el.textContent = "";
            if (before.trim()) el.append(`${before} `);
            else if (/^\s/.test(text)) el.append(" ");     // the space the wrapper carried in
            if (inSentence) el.append(num);
            else el.append(vs, " ", num);
            if (after.trim()) el.append(after.replace(/[\s.]+$/, (t) => (t.includes(".") ? "." : "")));
            else if (/\s$/.test(text)) el.append(" ");      // the space the wrapper carried out
            el.dataset.aceVs = "1";
            dressed++;
        }
    } catch (err) {
        console.warn(`${MODULE_ID} | could not dress the ACs and DCs on a card; they read as written:`, err);
    }
    return dressed;
}

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
            const mine = !!game.user?.isGM;
            if (mine) el.dataset.aceAc = "show";
            else delete el.dataset.aceAc;
        }
    } catch (err) {
        console.warn(`${MODULE_ID} | could not decide which ACs this screen may see, so none of `
            + `them are shown here:`, err);
    }
}
