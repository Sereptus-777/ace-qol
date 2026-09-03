// ─── ACE: QOL — Multiattack / Extra-Attack Chain Engine ──────────────────────
// When a creature with "Multiattack" — or a PC with "Extra Attack" — makes its
// FIRST weapon attack of the turn, ACE pops a reactive dialog that drives the
// REST of the attack sequence as square pushbuttons: one per attack type, each
// badged with its remaining count. Clicking a button fires that weapon through
// the normal attack pipeline (hit / miss / damage / riders all flow) and ticks
// the count down. When the chain is spent the dialog closes itself.
//
// SAFETY PRINCIPLE — the engine NEVER auto-fires. Every swing is an explicit
// click. So even if a stat block's Multiattack text is mis-parsed, the worst
// case is badge counts that are slightly off — the GM/player simply clicks the
// attacks they actually want. A parse error can never force a wrong attack.
//
// Two modes:
//   • PARSED   — the Multiattack description names specific attacks ("two claws
//                and one bite") and those names match the actor's weapons →
//                one badged button per named attack.
//   • FALLBACK — the description is generic ("makes two attacks"), or it's a
//                PC's Extra Attack → "Attack X of N" with every available
//                weapon as a free pick each time.
//
// Works for NPCs (Multiattack feature) and PCs (Extra Attack). Dark/gold
// reactive-dialog styling to match the Counterspell / Legendary Resistance
// prompts. Setting: `multiattackChain` (default ON).
// ──────────────────────────────────────────────────────────────────────────────

import { MODULE_ID } from "./ace-qol.mjs";
import { CombatState } from "./combat-state.mjs";

const NUM_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8 };
const ACCENT = "#ffd54f";

export class MultiattackEngine {
  static _seenRolls = new WeakSet();   // dual-hook dedupe (rollAttackV2 + rollAttack share a Roll)
  static _inFlight  = new Set();       // actorIds whose chain is FIRING an attack — suppresses re-trigger
  static _chained   = new Set();       // actorIds who already opened a chain this turn
  static _activeChains = new Set();    // actorIds with a chain loop RUNNING right now (stale-gate healing)
  static _openPrompts  = new Map();    // actorId → the OPEN chain Dialog (front it instead of silent-suppressing)

  static init() {
    try {
      game.settings.register(MODULE_ID, "multiattackChain", {
        name: "Multiattack / Extra-Attack Chain Pop-up",
        hint: "When a creature with Multiattack — or a PC with Extra Attack — makes its first attack of the turn, show a pop-up that drives the remaining attacks as one-click weapon buttons (badged with their counts). It NEVER auto-attacks — you click each swing. Default ON.",
        scope: "world", config: true, type: Boolean, default: true,
      });
    } catch (_) { /* already registered */ }

    const trigger = (rolls, data) => {
      // Bulletproof off-hand signal (Johnny 2026-07-12): dnd5e stamps a
      // two-weapon off-hand swing with roll.options.attackMode === "offhand".
      // Reading it here — instead of relying only on the pop-up's kind flag —
      // catches BOTH a native off-hand attack AND our own pop-up swing (which
      // now fires with the tag). The damage calc + combat-state read the mark to
      // strip the RAW off-hand ability mod. Fires on the roller's client, right
      // before the damage build → no TTL race.
      try {
        const roll = Array.isArray(rolls) ? rolls[0] : rolls;
        if (roll?.options?.attackMode === "offhand") {
          const uuid = data?.subject?.item?.uuid ?? data?.subject?.parent?.uuid ?? null;
          if (uuid) CombatState.markOffhandSwing(uuid);
        }
      } catch (e) { console.warn(`${MODULE_ID} | off-hand attackMode mark failed:`, e); }
      try { MultiattackEngine._onAttack(rolls, data); }
      catch (e) { console.warn(`${MODULE_ID} | MultiattackEngine trigger failed:`, e); }
    };
    Hooks.on("dnd5e.rollAttackV2", trigger);
    Hooks.on("dnd5e.rollAttack",   trigger);

    // Per-turn gating reset
    // ⚠️ `combatTurnChange`, not `combatTurn`. Foundry fires combatTurn BEFORE
    // it applies the update, so `game.combat.combatant` there is still the
    // creature whose turn is ENDING — this closed the pop-up belonging to the
    // creature about to act and left open the one that just finished.
    // (audit F-022, 2026-08-07)
    Hooks.on("combatTurnChange",  (combat, prior, current) => {
      MultiattackEngine._chained.clear();
      // Close any open chain pop-up for an actor who is no longer the active
      // combatant — covers fumble-ends-turn + GM manual skip (2026-07-10).
      try {
        const _cur = current?.combatantId
          ? combat?.combatants?.get(current.combatantId)
          : game.combat?.combatant;
        const curId = _cur?.actor?.id;
        for (const [aid, dlg] of MultiattackEngine._openPrompts) {
          if (aid !== curId) { try { dlg?.close?.(); } catch (_) {} }
        }
      } catch (_) { /* non-fatal */ }
    });
    Hooks.on("combatRound", () => MultiattackEngine._chained.clear());
    Hooks.on("deleteCombat", () => { MultiattackEngine._chained.clear(); MultiattackEngine._inFlight.clear(); MultiattackEngine._activeChains.clear(); });

    // Immediate chain abort (Johnny 2026-07-13): fumbleEndsTurn fires this the
    // instant a nat-1 ends the turn, so an OPEN multiattack pop-up closes RIGHT
    // AWAY instead of lingering until the 750ms turn-advance lands. Closing the
    // dialog settles _promptOne(null) → the chain loop breaks → its finally resets.
    Hooks.on(`${MODULE_ID}.multiattackAbort`, (p) => {
      try {
        const dlg = MultiattackEngine._openPrompts.get(p?.actorId);
        if (dlg) { try { dlg.close(); } catch (_) { /* window gone */ } }
      } catch (_) { /* non-fatal */ }
    });

    console.debug(`${MODULE_ID} | MultiattackEngine online.`);
  }

  static _enabled() {
    try { return game.settings.get(MODULE_ID, "multiattackChain") !== false; } catch (_) { return true; }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Trigger
  // ═══════════════════════════════════════════════════════════════════════════

  static _onAttack(rolls, data) {
    if (!this._enabled()) return;

    // Dual-hook dedupe — rollAttackV2 + rollAttack fire with the same Roll.
    const rollRef = rolls?.[0];
    if (rollRef && typeof rollRef === "object") {
      if (this._seenRolls.has(rollRef)) return;
      this._seenRolls.add(rollRef);
    }

    const subject = data?.subject;
    const item  = subject?.item;
    const actor = subject?.actor;
    if (!actor || !item) return;

    // Chain-fired attacks must NOT re-trigger the prompt.
    if (this._inFlight.has(actor.id)) return;
    // Only a real weapon/attack swing counts.
    if (!this._isAttackItem(item)) return;
    // Suppress a new offer ONLY while a chain for this actor is genuinely
    // pending or running. A COMPLETED chain resets immediately — in combat
    // or out (Johnny 2026-07-10 17:34: "the second swing was a second
    // swing — that's it, reset"). The engine never auto-fires, so re-offering
    // is a convenience, not an action-economy violation — enforcing turn
    // economy is the GM's call, and the turn/round hooks still clear
    // leftovers each turn as a belt.
    if (this._chained.has(actor.id)) {
      if (this._activeChains.has(actor.id)) {
        // A chain for this actor is genuinely open — NEVER silently swallow
        // the swing (indistinguishable from a bug; 2026-07-10 17:36). Front
        // the open pop-up if there is one and say so out loud.
        const open = this._openPrompts.get(actor.id);
        try { open?.bringToTop?.(); } catch (_) { /* window gone — toast still fires */ }
        ui.notifications?.info(`${actor.name}: a multiattack pop-up is already open — pick the next swing there, or hit End Attacks to reset.`);
        console.log(`${MODULE_ID} | [chain] swing while chain open for ${actor.name} — fronted the existing pop-up`);
        return;
      }
      console.log(`${MODULE_ID} | [chain] stale gate for ${actor.name} (no chain running) — cleared, offering fresh chain`);
      this._chained.delete(actor.id);
    }

    // Show on the client that ROLLED the swing — this hook only fires there,
    // so hook locality IS the routing. The old owner-preference logic sent a
    // GM-rolled swing's pop-up to the owning player's client, which never saw
    // the roll hook at all → pop-up NOWHERE the moment a player window was
    // connected (live-fire 2026-07-10 17:04, Syrax/Phyraxis). A player rolling
    // their own attack still gets their own pop-up — their client is the one
    // firing this hook.

    // Build the plan. Null → this actor has no Multiattack / Extra Attack, or the
    // multiattack was a single swing with nothing left to chain.
    const plan = this._buildPlan(actor, item);
    if (!plan) return;

    this._chained.add(actor.id);
    this._activeChains.add(actor.id);   // pending from THIS moment (trigger → pop-up gap included)
    // Snapshot swing 1's target(s) NOW — while the roll still has them locked.
    // ACE flows auto-release targets after damage resolves, and the pipeline
    // reads game.user.targets at roll time: firing a chain swing with an
    // empty set makes it skip resolution silently — the "nothing happens"
    // bug (live-fire 2026-07-10 11:15; same lesson as the OA v0.7.24 fix).
    const initialTargetIds = [...(game.user.targets ?? [])].map(t => t.id);
    // Enter the chain only AFTER swing 1 fully resolves (Johnny 2026-07-10,
    // the exact spec): a MISS resolves the instant the verdict lands; a HIT
    // resolves when the damage card is created (= Roll Damage was pushed).
    // HOOK-DRIVEN — timers never open a prompt (v0.7.189 rebuild; the old 8s
    // safety net WAS the flow on paths that missed a signal — the "it's on a
    // timer" bug).
    this._awaitSwingResolved(actor).then(() => {
      this._runChain(actor, plan, initialTargetIds).catch(e => console.warn(`${MODULE_ID} | Multiattack chain failed:`, e));
    });
  }

  /**
   * Resolve when THIS actor's current swing has fully resolved (the Johnny
   * 2026-07-10 spec, exactly):
   *   • MISS → resolve IMMEDIATELY. Two signals cover it: the attackComplete
   *     verdict with zero hits (local) and the attackResolved signal (socket-
   *     relayed to every client, so the player-side prompt gets it too).
   *   • HIT  → resolve when the damage-RESULT card is created — i.e. the
   *     moment Roll Damage was pushed and finished. Chat messages replicate
   *     to all clients, so this works wherever the prompt lives.
   * The timeout is a LAST-RESORT abandonment backstop, NOT a flow driver — a HIT
   * waits for Roll Damage however long the player/GM takes (Johnny 2026-07-14:
   * "either Roll Damage is pushed, or the pop-up doesn't come up"). It's set very
   * long so it only fires when a swing is genuinely walked away from. A MISS still
   * resolves instantly via its own signal, so the long timeout never delays one.
   * @param {Actor}  actor
   * @param {number} [timeoutMs=1800000]  30 min — abandonment backstop only
   * @returns {Promise<string>} why: "miss" | "damage" | "resolved" | "timeout"
   */
  /**
   * @param {string[]} [targetIds]  Token ids this swing was aimed at. When
   *   given, only damage applied to ONE OF THESE releases the chain.
   *
   * ⚠️ WITHOUT THIS IT UNLOCKS ON ANY DAMAGE ANYWHERE (Johnny, 2026-08-21).
   * A table applying damage from something unrelated - a trap, a second
   * creature's card still sitting in chat, a player tidying up an earlier hit -
   * would release the multiattack early, which is the same wrong-target class
   * of bug this gate exists to prevent.
   */
  static _awaitSwingResolved(actor, timeoutMs = 1800000, targetIds = null) {
    const t0 = performance.now?.() ?? 0;
    return new Promise((resolve) => {
      let done = false;
      let net = null;
      const finish = (why) => {
        if (done) return;
        done = true;
        try {
          const secs = ((performance.now?.() ?? 0) - t0) / 1000;
          console.log(`${MODULE_ID} | [chain] swing resolved via "${why}" after ${secs.toFixed(1)}s for ${actor.name}`);
        } catch (_) { /* logging only */ }
        try { Hooks.off(`${MODULE_ID}.damageApplied`, appliedHook); } catch (_) { /* non-fatal */ }
        try { Hooks.off(`${MODULE_ID}.hpApplied`, hpHook); } catch (_) { /* non-fatal */ }
        try { Hooks.off(`${MODULE_ID}.attackResolved`, sigHook); } catch (_) { /* non-fatal */ }
        try { Hooks.off(`${MODULE_ID}.attackComplete`, verdictHook); } catch (_) { /* non-fatal */ }
        if (net) clearTimeout(net);
        resolve(why);
      };
      // Verdict, local path: a whole-swing MISS never rolls damage — resolve now.
      // (Hits keep waiting for the damage card below.)
      const verdictHook = Hooks.on(`${MODULE_ID}.attackComplete`, (p) => {
        try {
          const aid = p?.actor?.id ?? p?.actorId ?? p?.actor;
          if (aid !== actor.id) return;
          // A whole-swing MISS never rolls damage — resolve now. A HIT keeps
          // waiting for the damage card (Roll Damage), with only the long
          // abandonment backstop behind it, so the pop-up never jumps ahead of
          // Roll Damage. NOTE: attackComplete is LOCAL to the PROCESSOR (the GM
          // for a player-rolled swing), which is exactly why the 15s alarm used to
          // fire on the roller — so the roller's chain leans on the BROADCAST
          // attackResolved (sigHook) for the miss + the replicated damage card.
          if ((p?.hits?.length ?? 0) === 0) setTimeout(() => finish("miss"), 100);
        } catch (_) { /* non-fatal */ }
      });
      // ⚠️🔴 HIT RESOLVES WHEN THE DAMAGE IS *APPLIED*, NOT WHEN IT IS ROLLED
      // (Johnny, 2026-08-21). This used to finish the moment the damage-RESULT
      // card was created - i.e. the instant Roll Damage was pushed - and the
      // comment below the loop said so plainly: "the next pop-up comes up while
      // the GM applies the damage". That is the muddle: swing two is being
      // offered while swing one's hit points have not moved, so the target's HP,
      // its bloodied state, whether it is even still standing, and every
      // reaction that keys off damage are all still pending when the next attack
      // is chosen.
      //
      // Everything now halts on APPLY. The pop-up still opens immediately - it
      // just waits, and says why (see _promptOne).
      const wanted = Array.isArray(targetIds) && targetIds.length ? new Set(targetIds) : null;
      const isOurTarget = (p) => {
        if (!wanted) return true;                       // no targets known: accept any
        const id = p?.tokenDocId ?? p?.tokenId ?? p?.token?.id;
        return id ? wanted.has(id) : false;             // unknown id: not ours
      };
      const appliedHook = Hooks.on(`${MODULE_ID}.damageApplied`, (p) => {
        try {
          // SILENT-OK: not one of our targets; this hook sees every token
          if (!isOurTarget(p)) return;
          // Remember HOW it landed. The next pop-up reads this to warn that the
          // blow did nothing, or that the target is down.
          MultiattackEngine._lastOutcome = {
            absorbed: !!p?.absorbed,
            dead: !!p?.dead,
            types: Array.isArray(p?.types) ? p.types : [],
            name: p?.actor?.name ?? "the target",
          };
          setTimeout(() => finish("applied"), 100);
        } catch (_) { /* non-fatal */ }
      });
      const hpHook = Hooks.on(`${MODULE_ID}.hpApplied`, (p) => {
        try { if (isOurTarget(p)) setTimeout(() => finish("applied"), 100); }
        catch (_) { /* non-fatal */ }
      });
      // Clean-miss signal — socket-relayed everywhere (player-side prompts).
      const sigHook = Hooks.on(`${MODULE_ID}.attackResolved`, (p) => {
        if (p?.actorId === actor.id) setTimeout(() => finish("resolved"), 100);
      });
      // ABANDONMENT BACKSTOP, not flow: only fires if a swing is walked away from
      // (Roll Damage never pushed for ~30 min). A hit waits for the damage card; a
      // miss resolves via its own signal — so this never jumps ahead of Roll Damage.
      net = setTimeout(() => {
        console.warn(`${MODULE_ID} | Multiattack: ${actor.name} — no resolution in ${Math.round(timeoutMs / 60000)} min; releasing the abandoned chain.`);
        finish("timeout");
      }, timeoutMs);
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Detection / plan building
  // ═══════════════════════════════════════════════════════════════════════════

  /** True if the item can make an attack (weapon type, or has an attack activity). */
  static _isAttackItem(item) {
    if (!item) return false;
    if (item.type === "weapon") return true;
    try {
      const acts = item.system?.activities;
      const list = acts ? (typeof acts.values === "function" ? [...acts.values()] : Object.values(acts)) : [];
      return list.some(a => a?.type === "attack");
    } catch (_) { return false; }
  }

  /** The actor's available attack options (buttons + parse targets). */
  static _getAttackItems(actor) {
    const out = [];
    for (const it of actor.items ?? []) {
      if (!this._isAttackItem(it)) continue;
      // RAW: Extra Attack / Multiattack swings are WEAPON (or unarmed/natural)
      // attacks — casting a cantrip is the Cast a Spell action, a different
      // action entirely. Fire Bolt does not belong on the swing list.
      // (Live-fire 2026-07-10 16:45 — Virick's pop-up offered Fire Bolt.)
      if (it.type === "spell") continue;
      // For PCs, skip unequipped carried weapons (don't surface backpack daggers).
      if (it.type === "weapon" && actor.hasPlayerOwner && it.system?.equipped === false) continue;
      // MAIN weapon list only: a bonus-action-ONLY attack (Polearm Master butt-
      // end, Crossbow Expert's bonus shot, Flurry of Blows) is NOT a main Attack-
      // action weapon — it belongs in the blue BONUS row (_getBonusAttacks), not
      // the "pick a weapon" list. (Johnny 2026-07-13: "Polearm Master shouldn't
      // be in the weapon list — it's a feature, not a weapon.")
      if (!this._hasMainActionAttack(it)) continue;
      out.push(it);
    }
    return out;
  }

  /**
   * True if the item can attack with the ATTACK ACTION (not bonus-only).
   * A weapon with no attack-activity data is a normal Attack-action weapon.
   * A feat/feature whose ONLY attack activity is bonus-action (Polearm Master
   * butt-end etc.) returns false — it lives in the bonus row, not the main list.
   */
  static _hasMainActionAttack(item) {
    if (!item) return false;
    const acts = item.system?.activities;
    const list = acts ? (typeof acts.values === "function" ? [...acts.values()] : Object.values(acts)) : [];
    const attackActs = list.filter(a => a?.type === "attack");
    if (item.type === "weapon" && !attackActs.length) return true;
    return attackActs.some(a => (a?.activation?.type ?? "action") !== "bonus");
  }

  // (retired 2026-07-10: the pop-up is roller-local now — dnd5e roll hooks
  // fire only on the rolling client, so ownership routing sent pop-ups to
  // clients that never saw the trigger. See _onAttack.)

  /**
   * @returns {null | {mode:"parsed", entries:[{item,count}], attackItems}
   *                 | {mode:"fallback", total:number, remaining:number, attackItems}}
   */
  /**
   * HOW MANY ATTACKS, AND WHICH — for anything that wants to SHOW it.
   *
   * ⚠️🔴 THE NUMBER EXISTED AND NOTHING PUT IT ON SCREEN. Johnny, 2026-09-02:
   * "There is a number that each creature has for what attacks it can make in
   * multi-attack, and anywhere that I see multi-attack, I want to see that
   * number." This engine has parsed that number since it was written, and used
   * it only to badge the buttons inside its own pop-up. Every other place
   * Multiattack appears showed the imported description, which on his shadow
   * dragon reads "The Shadow Dragon (Huge) uses Multiattack."
   *
   * ⚠️ IT REPORTS HOW IT KNOWS. `exact` is true when the creature's own text
   * named a count, and false when this fell back to the usual two. A number
   * presented with the same confidence either way is the kind of quiet guess
   * that makes a GM trust a tool once and stop trusting it afterwards.
   *
   * @returns {null|{total:number, exact:boolean, entries:Array, label:string}}
   */
  /**
   * The text that actually describes this creature's Multiattack.
   *
   * ⚠️🔴 THE ITEM'S DESCRIPTION IS USUALLY WORTHLESS AND THE CREATURE'S IS NOT.
   * Johnny, 2026-09-02: "Its description is one sentence with no number in it.
   * That's almost all of them. You understand? That's almost all of them."
   *
   * Importers routinely write the Multiattack feat as "The Shadow Dragon (Huge)
   * uses Multiattack." while the real line - "makes three attacks: one with its
   * bite and two with its claws" - sits in the CREATURE's stat block text,
   * because that is where it lived in the source book. Reading only the item
   * and giving up is reading the one copy that was thrown away.
   *
   * So: the item first when it says something useful, then the creature's own
   * biography, taking the passage that follows the word Multiattack rather than
   * the whole page - a stat block is full of numbers and "three attacks" could
   * as easily come from a legendary action further down.
   */
  static _multiattackText(actor, maFeature) {
    const saysSomething = (t) => !!t && /\b(one|two|three|four|five|six|seven|eight|\d+)\b[^.]{0,40}\battacks?\b/i.test(t);

    const fromItem = this._plainText(maFeature?.system?.description?.value ?? "");
    if (saysSomething(fromItem)) return fromItem;

    // ⚠️ EVERY PLACE dnd5e KEEPS CREATURE PROSE, because importers disagree
    // about which one they fill in and an empty field is not evidence.
    const d = actor?.system?.details ?? {};
    const sources = [
      d.biography?.value, d.biography?.public,
      d.description?.value, d.description?.full, d.source?.custom,
    ];

    for (const raw of sources) {
      const text = this._plainText(raw ?? "");
      if (!text) continue;
      const at = text.search(/multi[\s-]?attack/i);
      if (at < 0) continue;
      // ⚠️🔴 STOP AT THE NEXT ABILITY, OR THE COUNT IS THE WHOLE PAGE.
      // A flat 400-character window ran a lich's Multiattack straight into its
      // Legendary Actions and read "two attacks with its paralyzing touch" plus
      // "five attacks with its staff" as seven. Caught by the self-test, which
      // is the only reason it is not in his game. `_plainText` flattens the
      // paragraph breaks away, so the section HEADING is what marks the edge.
      let slice = text.slice(at, at + 400);
      const nextSection = slice.slice(1).search(
        /\b(?:legendary|lair|mythic|villain|regional)\s+action|\breactions?\b|\bbonus\s+actions?\b/i);
      if (nextSection > 0) slice = slice.slice(0, nextSection + 1);
      if (saysSomething(slice)) return slice;
    }

    // ⚠️ RETURN THE ITEM TEXT, NOT NOTHING. The caller still wants whatever
    // there was so it can say it could not find a count, rather than behaving
    // as though the creature has no Multiattack at all.
    return fromItem;
  }

  static summaryFor(actor) {
    try {
      const maFeature = actor?.items?.find(i => /multiattack/i.test(i.name ?? ""));
      if (!maFeature) return null;

      const text = this._multiattackText(actor, maFeature);
      const attackItems = this._getAttackItems(actor) ?? [];

      // ⚠️🔴 HAND BACK THE SENTENCE, NOT ONLY THE NUMBER. Johnny, 2026-09-03,
      // looking at a Cloud Giant tooltip reading "The Cloud Giant (Legacy) uses
      // Multiattack": "I want the full description on every freaking
      // multi-attack I ever see for that creature."
      //
      // The real line — "the giant makes two attacks, using Thunderous Mace or
      // Thundercloud in any combination" — is in the creature's stat block text,
      // which `_multiattackText` already goes and finds. It was being read for
      // its number and then thrown away.
      //
      // ⚠️ NULL WHEN IT IS THE IMPORTER'S USELESS SENTENCE. "X uses Multiattack"
      // is not a description; showing it instead of the item's own text would
      // trade one worthless line for the same worthless line.
      const useless = /^\s*the\s+.{0,60}?\s+uses\s+multi[\s-]?attack\.?\s*$/i;
      const passage = (text && !useless.test(text)) ? text.trim() : null;

      // Best case: the text names the weapons, so we can say "2 claws, 1 bite".
      const parsed = this._parseMultiattack(text, attackItems);
      if (parsed?.length) {
        const total = parsed.reduce((sum, e) => sum + e.count, 0);
        if (total > 0) {
          const parts = parsed.map(e => `${e.count} ${e.item?.name ?? "attack"}`);
          return { total, exact: true, entries: parsed, text: passage,
                   label: `${total} attacks: ${parts.join(", ")}` };
        }
      }

      // Next: the text gives a bare count without naming weapons.
      const m = text.match(/\b(one|two|three|four|five|six|seven|eight|\d+)\b\s+(?:\w+\s+){0,2}attacks?\b/i);
      if (m) {
        const v = NUM_WORDS[m[1].toLowerCase()] ?? parseInt(m[1], 10);
        if (v >= 1 && v <= 10) {
          return { total: v, exact: true, entries: [], text: passage,
                   label: `${v} attack${v === 1 ? "" : "s"}` };
        }
      }

      // ⚠️ NOTHING IN THE TEXT SAYS A NUMBER, AND THAT IS THE COMMON CASE ON
      // HIS SHEETS. Say two, and say that it is assumed, rather than printing a
      // confident 2 that came from nowhere.
      return { total: 2, exact: false, entries: [], text: passage,
               label: "2 attacks (assumed — this creature's Multiattack text does not say)" };
    } catch (err) {
      console.warn(`${MODULE_ID} | could not work out this creature's attack count:`, err);
      return null;
    }
  }

  static _buildPlan(actor, triggerItem) {
    const attackItems = this._getAttackItems(actor);
    if (!attackItems.length) return null;

    const isPC = actor.hasPlayerOwner;
    const maFeature   = actor.items?.find(i => /multiattack/i.test(i.name ?? ""));
    const extraAttack = isPC && actor.items?.find(i =>
      /extra attack/i.test(i.name ?? "")
      // Identifier survives renames/translation — SRD Extra Attack slugs to "extra-attack".
      || (i.identifier ?? i.system?.identifier ?? "") === "extra-attack"
      // 2024 blade-lock: Thirsting Blade invocation = "attack twice with your
      // pact weapon" — Extra Attack in all but name (Syrax, warlock 6).
      || /thirsting blade/i.test(i.name ?? ""));
    if (!maFeature && !extraAttack) {
      // No Extra Attack / Multiattack — but a bonus-action attack (off-hand
      // pair, Pole Strike) still deserves the pop-up after swing 1 (Jex:
      // Dual Wielder rogue, 2026-07-10 18:11). Zero main swings remain;
      // the pop-up offers ONLY the blue bonus row.
      if (this._getBonusAttacks(actor).length) {
        return { mode: "fallback", total: 1, remaining: 0, attackItems, bonusOnly: true };
      }
      return null;   // truly nothing to chain
    }

    // ── PARSED mode (NPC Multiattack naming specific attacks) ──
    if (maFeature) {
      // ⚠️ THE SAME READER THE LABEL USES. Two functions reaching for the
      // creature's attack count in different places is how the badge and the
      // pop-up come to disagree in front of a table.
      const text = this._multiattackText(actor, maFeature);
      const parsed = this._parseMultiattack(text, attackItems);
      if (parsed && parsed.length) {
        this._decrementTrigger(parsed, triggerItem);   // the first swing already happened
        const total = parsed.reduce((s, e) => s + e.count, 0);
        if (total <= 0) return null;                    // single-swing multiattack, nothing left
        return { mode: "parsed", entries: parsed, attackItems };
      }
    }

    // ── FALLBACK mode (generic text or PC Extra Attack) ──
    let n = 2;   // covers most Extra Attack + generic "two attacks"
    if (maFeature) {
      const t = this._multiattackText(actor, maFeature);
      const m = t.match(/\b(one|two|three|four|five|six|seven|eight|\d+)\b\s+(?:\w+\s+){0,2}attacks?\b/i);
      if (m) {
        const v = NUM_WORDS[m[1].toLowerCase()] ?? parseInt(m[1], 10);
        if (v >= 1 && v <= 10) n = v;
      }
    } else if (extraAttack) {
      // PC Extra Attack — base 2; only Fighter scales further (3 @ L11, 4 @ L20).
      const fl = actor.items?.find(i => i.type === "class" && /fighter/i.test(i.name ?? ""))?.system?.levels ?? 0;
      n = fl >= 20 ? 4 : fl >= 11 ? 3 : 2;
    }
    const remaining = Math.max(1, n - 1);   // the triggering attack was #1
    return { mode: "fallback", total: n, remaining, attackItems };
  }

  /** Parse "two claws and one bite" → [{item:Claw,count:2},{item:Bite,count:1}]. */
  static _parseMultiattack(text, attackItems) {
    if (!text) return null;
    const lower = text.toLowerCase();
    const entries = [];
    for (const item of attackItems) {
      // Strip parenthetical qualifiers so "Bite (Hybrid Form)" / "Claws (Bear
      // Form)" (lycanthropes, Wild Shape) still match "...two bites..." in the
      // Multiattack text. Common in Curse of Strahd stat blocks.
      const base = (item.name ?? "").toLowerCase().replace(/\(.*?\)/g, "").trim();
      if (!base) continue;
      const esc = base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      // <count> within ~3 words before the (optionally pluralized) weapon name.
      const re = new RegExp(`\\b(one|two|three|four|five|six|seven|eight|\\d+)\\b(?:\\s+\\w+){0,3}?\\s+${esc}s?\\b`, "i");
      const m = lower.match(re);
      if (m) {
        const cnt = NUM_WORDS[m[1].toLowerCase()] ?? parseInt(m[1], 10);
        if (cnt >= 1 && cnt <= 12) entries.push({ item, count: cnt });
      }
    }
    return entries.length ? entries : null;
  }

  static _decrementTrigger(entries, triggerItem) {
    const e = entries.find(en => en.item?.id === triggerItem?.id)
           ?? entries.find(en => this._nameMatch(en.item?.name, triggerItem?.name));
    if (e && e.count > 0) e.count -= 1;
  }

  static _plainText(html) {
    return String(html ?? "")
      .replace(/<[^>]+>/g, " ")
      .replace(/&[a-z]+;/gi, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  static _nameMatch(a, b) {
    const norm = s => String(s ?? "").toLowerCase().replace(/s\b/g, "").trim();
    return !!a && !!b && norm(a) === norm(b);
  }

  /** A one-handed melee weapon (no Two-Handed property) — Dual Wielder pairs. */
  static _isMeleeOneHanded(item) {
    try {
      const p = item.system?.properties;
      const two = (p?.has?.("two")) || (Array.isArray(p) && p.includes("two"));
      const wtype = String(item.system?.type?.value ?? "");
      const melee = /M$/.test(wtype) || wtype === "natural" || wtype === "improv";
      return melee && !two;
    } catch (_) { return false; }
  }

  /** A light melee weapon — for off-hand two-weapon-fighting detection. */
  static _isLightMelee(item) {
    try {
      const p = item.system?.properties;
      const light = (p?.has?.("lgt")) || (Array.isArray(p) && p.includes("lgt"));
      const wtype = String(item.system?.type?.value ?? "");
      const melee = /M$/.test(wtype) || wtype === "natural" || wtype === "improv";
      return !!light && melee;
    } catch (_) { return false; }
  }

  /**
   * Bonus-action attacks to surface as a SEPARATE, clearly-labelled row:
   *   • kind "bonus"   — an attack activity whose activation type is "bonus"
   *                      (Polearm Master, Crossbow Expert, Flurry of Blows, …).
   *                      Data-driven: reads the activity's action cost, so no
   *                      name-matching and it catches well-built homebrew too.
   *   • kind "offhand" — a SECOND equipped light melee weapon (two-weapon
   *                      fighting). Heuristic, since TWF isn't a discrete activity.
   * @returns {Array<{id,name,img,activityId:string|null,kind:"bonus"|"offhand"}>}
   */
  static _getBonusAttacks(actor) {
    const out = [];
    const seen = new Set();

    // (a) attack activities flagged as bonus-action.
    for (const it of actor.items ?? []) {
      if (!this._isAttackItem(it)) continue;
      const acts = it.system?.activities;
      const list = acts ? (typeof acts.values === "function" ? [...acts.values()] : Object.values(acts)) : [];
      const bonusAct = list.find(a => a?.type === "attack" && a?.activation?.type === "bonus");
      if (bonusAct) {
        out.push({ id: it.id, name: it.name, img: it.img, activityId: bonusAct.id, kind: "bonus" });
        seen.add(it.id);
      }
    }

    // (b) off-hand two-weapon fighting — RAW: a second equipped LIGHT melee
    //     weapon. The DUAL WIELDER feat drops the Light requirement (any
    //     pair of one-handed melee weapons — rapier + scimitar, Jex
    //     2026-07-10). Off-hand damage takes NO ability mod RAW unless the
    //     Two-Weapon Fighting style applies — mod handling is the pipeline's
    //     follow-up (punch list); the OFFER is what lives here.
    const hasDualWielder = (actor.items ?? []).some(i =>
      i.type === "feat" && /dual\s*wielder/i.test(i.name ?? ""));
    const pairable = (actor.items ?? []).filter(it =>
      it.type === "weapon" && it.system?.equipped && this._isAttackItem(it)
      && (hasDualWielder ? this._isMeleeOneHanded(it) : this._isLightMelee(it)));
    if (pairable.length >= 2) {
      // Off-hand = the Light one when exactly one of the pair is Light
      // (main the rapier, off-hand the scimitar); otherwise the second listed.
      const lights = pairable.filter(w => this._isLightMelee(w));
      const offhand = (lights.length === 1 && pairable.length === 2) ? lights[0] : pairable[1];
      if (offhand && !seen.has(offhand.id)) {
        out.push({ id: offhand.id, name: offhand.name, img: offhand.img, activityId: null, kind: "offhand" });
        seen.add(offhand.id);
      }
    }

    return out;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Dialog
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * THE CHAIN (Johnny 2026-07-10 spec, verbatim):
   *   1. Swing 1 happens normally and RESOLVES (miss → verdict; hit → after
   *      Roll Damage). Only then does the first pop-up appear.
   *   2. The pop-up offers the remaining attacks. Clicking a weapon CLOSES
   *      the pop-up instantly — no Done-button ceremony — and fires the swing.
   *   3. That swing resolves the same way (miss → next pop-up immediately;
   *      hit → next pop-up right after Roll Damage), and the next one-shot
   *      pop-up appears. Repeat until the attacks are spent.
   *   "End Attacks" (or closing the window) bails out of the chain early.
   */
  static async _runChain(actor, plan, initialTargetIds = []) {
    // Mutable in-memory state (we never re-read the stat block mid-chain).
    const state = plan.mode === "parsed"
      ? { mode: "parsed", entries: plan.entries.map(e => ({ id: e.item.id, name: e.item.name, img: e.item.img, count: e.count })) }
      : { mode: "fallback", total: plan.total, remaining: plan.remaining,
          weapons: plan.attackItems.map(it => ({ id: it.id, name: it.name, img: it.img })) };
    state.bonusUsed = false;
    const bonusAttacks = MultiattackEngine._getBonusAttacks(actor);

    const remainingCount = () => state.mode === "parsed"
      ? state.entries.reduce((s, e) => s + e.count, 0)
      : state.remaining;

    const itemById = (id) => actor.items?.get?.(id) ?? actor.items?.find?.(i => i.id === id);

    // The last known living target(s) — refreshed from live targets each
    // swing so re-targeting mid-chain (splitting attacks) is honored.
    let lastTargetIds = [...initialTargetIds];

    try {
    let pendingGate = null;   // previous swing's resolution; locks the next pop-up
    while (remainingCount() > 0 || (bonusAttacks.length && !state.bonusUsed)) {
      // Turn ended out from under us (fumble-ends-turn, GM skip)? Stop offering —
      // no more swings once it isn't this actor's turn (2026-07-10).
      if (game.combat?.started && game.combat.combatant?.actor?.id !== actor.id) {
        console.log(`${MODULE_ID} | [chain] ${actor.name} is no longer the active combatant — ending chain`);
        break;
      }
      // Fumble ended the turn (Johnny's table rule): the fumble-engine marked
      // this actor when a swing came up a natural 1 with "Fumble Ends the Turn"
      // on. It marks SYNCHRONOUSLY (the turn-advance itself runs on a short beat),
      // so we consume the one-shot mark here and stop BEFORE opening the next
      // pop-up — that's what stops an attack sneaking through during that beat.
      // The turn-end toast is posted by the fumble-engine, so we stay quiet here.
      if (CombatState.consumeMultiattackFumble(actor.id)) {
        console.log(`${MODULE_ID} | [chain] ${actor.name} fumbled — turn ending, chain stopped.`);
        break;
      }
      // ⚠️ THE POP-UP OPENS NOW, GATED - it does not wait to appear. `pendingGate`
      // is the previous swing's resolution, started but never awaited here, so
      // the window is up immediately saying what it is waiting for while the GM
      // applies the damage. Awaiting BEFORE opening is what made the second
      // attack feel like it had gone missing.
      const choice = await this._promptOne(actor, state, bonusAttacks, pendingGate);
      pendingGate = null;
      if (!choice) break;   // End Attacks / window closed → chain over

      // A chain swing must never fire target-less — the pipeline would skip
      // resolution silently. Live targets win; an empty set re-asserts the
      // last known living target; nothing left → re-open the pop-up.
      if (!this._ensureTargets(lastTargetIds)) {
        ui.notifications?.warn(`${actor.name}: no living target — click a target on the canvas, then pick the attack again.`);
        continue;   // nothing consumed, nothing fired; the pop-up returns
      }
      lastTargetIds = [...(game.user.targets ?? [])].map(t => t.id);

      const item = itemById(choice.itemId);
      const activity = (choice.activityId && item)
        ? (item.system?.activities?.get?.(choice.activityId) ?? null)
        : null;
      console.log(`${MODULE_ID} | [chain] resolved choice: item=${item?.name ?? "MISSING (" + choice.itemId + ")"} targets=${game.user.targets?.size ?? 0}`);

      if (!item) {
        // A dead swing must be VISIBLE, never silent (live-fire 2026-07-10 16:34).
        ui.notifications?.error(`ACE Multiattack: couldn't find that weapon on ${actor.name} — see console (F12).`);
        continue;
      }

      try {
        await this._fireAttack(actor, item, activity, choice.kind === "offhand");
      } catch (e) {
        console.error(`${MODULE_ID} | [chain] Multiattack fire FAILED:`, e);
        ui.notifications?.error(`ACE Multiattack: the swing failed to fire — see console (F12).`);
        continue;   // don't burn the attack count on a failed fire
      }

      // Log the swing against the plan FIRST — this is what makes it "the
      // second attack" instead of a mystery roll (Johnny 2026-07-10 17:26).
      if (choice.bonus) {
        state.bonusUsed = true;            // soft guard — one bonus action per turn
      } else if (state.mode === "parsed") {
        const e = state.entries.find(en => en.id === choice.itemId);
        if (e && e.count > 0) e.count -= 1;
      } else {
        state.remaining = Math.max(0, state.remaining - 1);
      }

      // THE RESET: when nothing more will be offered (mains spent AND the
      // bonus row used or absent), the chain is OVER the instant this swing
      // fires — never await the final swing (the zombie-chain lesson,
      // live-fire 17:26/17:28).
      const moreToOffer = remainingCount() > 0 || (bonusAttacks.length && !state.bonusUsed);
      if (!moreToOffer) break;

      // More to offer → START this swing's resolution, but do NOT await it here.
      // The next pass opens the pop-up immediately and locks it on this promise.
      //   Miss → resolves the moment the verdict lands, so the buttons are live
      //          almost at once.
      //   Hit  → resolves when the damage is APPLIED, so nothing can be swung
      //          again until the target's hit points have actually moved.
      pendingGate = this._awaitSwingResolved(actor, 1800000, lastTargetIds);
    }

    } finally {
      // GUARANTEED full reset — even if a swing throws. The chain ending IS
      // the reset, in combat or out: the very next attack with this actor
      // is a fresh "first swing" and re-offers a fresh chain.
      MultiattackEngine._activeChains.delete(actor.id);
      MultiattackEngine._chained.delete(actor.id);
    }
  }

  /**
   * Make sure the chain swing has a target. Live targets are honored as-is
   * (the user may have re-targeted between pop-ups); an EMPTY set re-asserts
   * the last known target(s), skipping dead/removed tokens (V13-correct
   * per-token setTarget). Returns false when nothing living can be targeted.
   */
  static _ensureTargets(lastTargetIds) {
    // SILENT-OK: a success return: targets are already set, nothing to assert
    if ((game.user.targets?.size ?? 0) > 0) return true;
    let asserted = false;
    for (const tid of (lastTargetIds ?? [])) {
      const tok = canvas.tokens?.get?.(tid);
      const hp = Number(tok?.actor?.system?.attributes?.hp?.value ?? 0);
      if (tok && !tok.destroyed && hp > 0) {
        try {
          tok.setTarget(true, { user: game.user, releaseOthers: false, groupSelection: false });
          asserted = true;
        } catch (_) { /* token gone mid-chain — try the next */ }
      }
    }
    if (asserted) console.log(`${MODULE_ID} | Multiattack: re-asserted the previous target for the next swing (auto-release had cleared it)`);
    return asserted;
  }

  /**
   * ONE one-shot prompt: the square-button grid (badged counts / weapon picks
   * + the blue bonus-action row). Clicking ANY attack button resolves the
   * choice and closes the dialog INSTANTLY. Resolves null on End Attacks / X.
   * @returns {Promise<null | { itemId, activityId: string|null, bonus: boolean }>}
   */
  /**
   * @param {Promise|null} gate  While this is pending the pop-up is OPEN but
   *   every attack button is locked, and it says why. Johnny, 2026-08-21: "I
   *   want everything to pause until the damage is applied... I want their
   *   pop-up to come up, but it should say waiting for GM to apply damage."
   *   Opening it locked rather than withholding it is the point - a pop-up that
   *   simply does not appear is indistinguishable from a broken chain, which is
   *   what made this feel muddled.
   */
  /** How the last blow was shrugged off, in words that fit the damage. */
  static _absorbedLine(types = []) {
    const t = String(types[0] ?? "").toLowerCase();
    const lines = {
      fire:        "The flames wash over it and die without a mark.",
      cold:        "The cold rolls off it as if it were never there.",
      lightning:   "The lightning earths itself harmlessly across its hide.",
      thunder:     "The sound breaks against it and scatters.",
      acid:        "The acid beads up and runs off, leaving nothing behind.",
      poison:      "The poison finds nothing in it to poison.",
      necrotic:    "The withering passes straight through it.",
      radiant:     "The light breaks over it and fades.",
      psychic:     "The assault finds no mind to take hold of.",
      force:       "The force splashes away without purchase.",
      bludgeoning: "The blow lands solidly and barely marks it.",
      slashing:    "The edge skates off without biting.",
      piercing:    "The point turns aside without finding a way in.",
    };
    return lines[t] ?? "The blow lands, and does nothing at all.";
  }

  static _lastOutcome = null;

  static _promptOne(actor, state, bonusAttacks, gate = null) {
    const portrait = actor.img ?? actor.prototypeToken?.texture?.src ?? "icons/svg/mystery-man.svg";
    const BONUS_ACCENT = "#6fa8dc";

    const remainingCount = () => state.mode === "parsed"
      ? state.entries.reduce((s, e) => s + e.count, 0)
      : state.remaining;

    const squareBtn = (id, name, img, badge) => `
      <button type="button" class="ace-ma-btn" data-item-id="${id}" title="${name}"
        style="position:relative;width:84px;height:84px;display:flex;flex-direction:column;align-items:center;justify-content:flex-start;gap:3px;padding:6px 4px;background:linear-gradient(180deg,#241a0c 0%,#140d05 100%);border:2px solid ${ACCENT}55;border-radius:8px;cursor:pointer;color:#f0e4c0;transition:border-color 0.15s,box-shadow 0.15s;">
        <img src="${img || "icons/svg/sword.svg"}" style="width:42px;height:42px;object-fit:contain;border-radius:4px;pointer-events:none;" />
        <span style="font-size:10px;line-height:1.1;text-align:center;max-width:78px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;pointer-events:none;">${name}</span>
        ${badge > 1 ? `<span style="position:absolute;top:-8px;right:-8px;min-width:22px;height:22px;padding:0 5px;display:flex;align-items:center;justify-content:center;background:${ACCENT};color:#1a1208;font-weight:800;font-size:13px;border-radius:11px;border:2px solid #140d05;pointer-events:none;">${badge}</span>` : ""}
      </button>`;

    const bonusBtn = (b) => {
      const dim = state.bonusUsed ? "opacity:0.4;pointer-events:none;filter:grayscale(0.6);" : "";
      const label = b.kind === "offhand" ? `Off-hand: ${b.name}` : b.name;
      return `
        <button type="button" class="ace-ma-bonus-btn" data-item-id="${b.id}" data-activity-id="${b.activityId ?? ""}" data-kind="${b.kind ?? ""}" title="${label} (Bonus Action)"
          style="position:relative;width:84px;height:84px;display:flex;flex-direction:column;align-items:center;justify-content:flex-start;gap:3px;padding:6px 4px;background:linear-gradient(180deg,#0c1822 0%,#060d14 100%);border:2px solid ${BONUS_ACCENT}66;border-radius:8px;cursor:pointer;color:#dfeaf5;transition:border-color 0.15s,box-shadow 0.15s;${dim}">
          <img src="${b.img || "icons/svg/sword.svg"}" style="width:42px;height:42px;object-fit:contain;border-radius:4px;pointer-events:none;" />
          <span style="font-size:10px;line-height:1.1;text-align:center;max-width:78px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;pointer-events:none;">${label}</span>
          <span style="position:absolute;top:-8px;left:-8px;padding:0 5px;height:18px;display:flex;align-items:center;justify-content:center;background:${BONUS_ACCENT};color:#06121c;font-weight:800;font-size:10px;border-radius:9px;border:2px solid #060d14;pointer-events:none;">BA</span>
        </button>`;
    };

    const buttons = state.mode === "parsed"
      ? state.entries.filter(e => e.count > 0).map(e => squareBtn(e.id, e.name, e.img, e.count)).join("")
      : (state.remaining > 0 ? state.weapons.map(w => squareBtn(w.id, w.name, w.img, 1)).join("") : "");

    const mainsSpent = state.mode === "parsed"
      ? state.entries.every(e => e.count <= 0)
      : state.remaining <= 0;
    const subhead = mainsSpent
      ? `Bonus action available — the blue attack below. The pop-up closes on click.`
      : state.mode === "parsed"
        ? `Remaining attacks — click one to swing at your current target. The pop-up closes on click.`
        : `Attack ${state.total - state.remaining + 1} of ${state.total} — pick a weapon. The pop-up closes on click.`;

    const content = `
      <div class="ace-ma-prompt" style="background:linear-gradient(180deg,#1a1410 0%,#0f0a08 100%);border:2px solid ${ACCENT};border-radius:6px;padding:12px 14px;color:#f0e4c0;font-family:'Signika','Helvetica Neue',sans-serif;">
        <div style="display:flex;align-items:center;gap:10px;border-bottom:1px solid #4a3a28;padding-bottom:6px;margin-bottom:10px;">
          <img src="${portrait}" style="width:40px;height:40px;border-radius:50%;object-fit:cover;border:2px solid ${ACCENT};flex-shrink:0;" />
          <div style="display:flex;flex-direction:column;min-width:0;">
            <span style="font-weight:700;font-size:15px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${actor.name}</span>
            <span style="font-size:13px;font-weight:700;color:${ACCENT};text-transform:uppercase;letter-spacing:0.5px;"><i class="fas fa-burst"></i> <i class="fas fa-hand-fist"></i> Multiattack</span>
          </div>
        </div>
        <div style="font-size:13px;color:#c0b288;margin-bottom:10px;">${subhead}</div>
        <div class="ace-ma-note" style="display:none;align-items:center;gap:8px;margin:0 0 10px;padding:8px 10px;background:#241a12;border:1px solid #e08a7a;border-radius:5px;font-size:14px;line-height:1.45;color:#f0e4c0;"></div>
        <div class="ace-ma-wait" style="display:${gate ? "flex" : "none"};align-items:center;gap:8px;margin:0 0 10px;padding:8px 10px;background:#2a1f0a;border:1px solid ${ACCENT}66;border-radius:5px;font-size:14px;color:#f0e4c0;">
          <i class="fas fa-hourglass-half" style="color:${ACCENT};"></i>
          <span>Waiting for the GM to apply damage before carrying on…</span>
        </div>
        <div class="ace-ma-grid" style="display:flex;flex-wrap:wrap;gap:8px;justify-content:flex-start;">${buttons}</div>
        ${bonusAttacks.length ? `
        <div style="border-top:1px dashed #3a4a5a;margin-top:12px;padding-top:9px;">
          <div style="font-size:12px;font-weight:700;color:${BONUS_ACCENT};text-transform:uppercase;letter-spacing:0.5px;margin-bottom:7px;">
            <i class="fas fa-bolt"></i> Bonus Action${state.bonusUsed ? ` <span style="color:#a06a4f;font-weight:600;text-transform:none;letter-spacing:0;">— used this turn</span>` : ``}
          </div>
          <div class="ace-ma-bonus-grid" style="display:flex;flex-wrap:wrap;gap:8px;justify-content:flex-start;">${bonusAttacks.map(bonusBtn).join("")}</div>
        </div>` : ``}
      </div>`;

    return new Promise((resolve) => {
      let settled = false;
      const settle = (v) => {
        if (settled) return;
        settled = true;
        MultiattackEngine._openPrompts.delete(actor.id);
        resolve(v);
      };

      const dialog = new Dialog({
        title: `Multiattack — ${actor.name}`,
        content,
        buttons: {
          done: {
            icon: '<i class="fas fa-flag-checkered"></i>',
            label: "End Attacks",
            callback: () => settle(null),
          },
        },
        default: "done",
        render: (jq) => {
          const root = jq?.[0] ?? jq;
          const node = root?.querySelector?.(".ace-ma-prompt") ?? root;
          if (!node) return;

          // ⚠️ LOCKED, NOT HIDDEN. Every attack button is unclickable and dimmed
          // while the previous swing's damage is still unapplied. When the gate
          // opens the banner goes and the buttons come alive - no re-render, so
          // nothing flickers and no listener is lost.
          const grids = () => [...node.querySelectorAll(".ace-ma-btn, .ace-ma-bonus-btn")];
          const waitBar = node.querySelector(".ace-ma-wait");
          if (gate) {
            grids().forEach(b => {
              b.style.pointerEvents = "none";
              b.style.opacity = "0.35";
              b.style.filter = "grayscale(0.7)";
            });
            Promise.resolve(gate).then(() => {
              if (settled) return;
              if (waitBar) waitBar.style.display = "none";
              // ⚠️ A HIT THAT DID NOTHING MUST NOT LOOK LIKE A HIT THAT LANDED.
              // Johnny, 2026-08-21: if the target shrugged it off, the player
              // needs to know before choosing the next swing - otherwise they
              // spend the whole turn hitting something that cannot be hurt this
              // way. Same for a target that just died: the next attack needs a
              // new one.
              const out = MultiattackEngine._lastOutcome;
              MultiattackEngine._lastOutcome = null;
              const note = node.querySelector(".ace-ma-note");
              if (out && note && (out.absorbed || out.dead)) {
                note.style.display = "flex";
                if (out.dead) {
                  note.style.borderColor = "#7fc98b";
                  note.innerHTML = `<i class="fas fa-skull" style="color:#7fc98b;"></i>` +
                    `<span><strong>${out.name} is down.</strong> Pick a new target on the canvas before your next attack.</span>`;
                } else {
                  note.style.borderColor = "#e08a7a";
                  note.innerHTML = `<i class="fas fa-shield-halved" style="color:#e08a7a;"></i>` +
                    `<span><strong>No damage got through.</strong> ${MultiattackEngine._absorbedLine(out.types)} ` +
                    `Try a different damage type, a different ability, or another target.</span>`;
                }
              }
              grids().forEach(b => {
                b.style.pointerEvents = "";
                b.style.opacity = "";
                b.style.filter = state.bonusUsed && b.classList.contains("ace-ma-bonus-btn") ? "grayscale(0.6)" : "";
              });
            }).catch(() => { /* a failed gate must never leave it locked */
              if (waitBar) waitBar.style.display = "none";
              grids().forEach(b => { b.style.pointerEvents = ""; b.style.opacity = ""; b.style.filter = ""; });
            });
          }
          node.querySelectorAll(".ace-ma-btn").forEach(b => {
            b.addEventListener("mouseenter", () => { b.style.borderColor = ACCENT; b.style.boxShadow = `0 0 8px ${ACCENT}88`; });
            b.addEventListener("mouseleave", () => { b.style.borderColor = `${ACCENT}55`; b.style.boxShadow = "none"; });
            b.addEventListener("click", (ev) => {
              ev.preventDefault();
              console.log(`${MODULE_ID} | [chain] weapon button clicked: ${b.title} (${b.getAttribute("data-item-id")})`);
              // The whole point: choice made → pop-up GONE, instantly.
              settle({ itemId: b.getAttribute("data-item-id"), activityId: null, bonus: false });
              dialog.close();
            });
          });
          node.querySelectorAll(".ace-ma-bonus-btn").forEach(b => {
            b.addEventListener("mouseenter", () => { if (!state.bonusUsed) { b.style.borderColor = BONUS_ACCENT; b.style.boxShadow = `0 0 8px ${BONUS_ACCENT}88`; } });
            b.addEventListener("mouseleave", () => { b.style.borderColor = `${BONUS_ACCENT}66`; b.style.boxShadow = "none"; });
            b.addEventListener("click", (ev) => {
              ev.preventDefault();
              if (state.bonusUsed) return;
              settle({ itemId: b.getAttribute("data-item-id"), activityId: b.getAttribute("data-activity-id") || null, bonus: true, kind: b.getAttribute("data-kind") || null });
              dialog.close();
            });
          });
        },
        // X / Escape / programmatic close — if no choice was made, end chain.
        close: () => settle(null),
      }, { width: 360 });
      dialog.render(true);
      MultiattackEngine._openPrompts.set(actor.id, dialog);
    });
  }

  /**
   * Fire one real attack with the given weapon through the dnd5e use flow
   * (fast-forward, same pattern as the OA engine). The `_inFlight` guard keeps
   * the attack the chain fires from re-triggering this very prompt. The swing
   * targets whatever the user currently has targeted, and flows through the
   * normal AttackPipeline (hit/miss/damage/riders).
   */
  static async _fireAttack(actor, item, activity = null, isOffhand = false) {
    this._inFlight.add(actor.id);
    // Two-weapon OFF-HAND: flag this swing so the damage calculator strips the
    // base ability mod (RAW: off-hand damage gets none) and combat-state restores
    // it only for the Two-Weapon Fighting fighting style (both editions), or the
    // Dual Wielder house-rule toggle. A NON-off-hand swing of the same weapon
    // clears any stale flag, so a main-hand swing right after an off-hand one
    // keeps its mod.
    if (item?.uuid) {
      if (isOffhand) CombatState.markOffhandSwing(item.uuid);
      else CombatState.clearOffhandSwing(item.uuid);
    }
    // A fake event dnd5e can safely poke at — if the system calls
    // preventDefault/stopPropagation on a bare POJO it throws INSIDE use()
    // and the whole swing dies silently. These no-ops make that impossible.
    const fakeEvent = {
      shiftKey: true, altKey: false, ctrlKey: false, metaKey: false,
      target: document.body, currentTarget: document.body, type: "click",
      preventDefault: () => {}, stopPropagation: () => {}, stopImmediatePropagation: () => {},
    };
    try {
      // ── PROVEN against his dnd5e 5.3.1 bundle (2026-07-10 17:18) ──
      // The use() auto-roll path dies inside D20Roll.buildPost:
      //   config.event?.target.closest("[data-message-id]")
      // — any synthetic event that isn't DOM-perfect crashes the roll, and
      // the crash is an unhandled promise (silent to the user). The fix is
      // structural: roll the attack DIRECTLY with NO event and an explicit
      // dialog skip (applyKeybindings uses ??=, so explicit false wins).
      // Every piece of ACE machinery (ability resolver, advantage prompt,
      // merge card, damage flow) rides the roll hooks and still runs.
      // Trade-off: usage card + consumption are skipped — right for weapon
      // swings (the table suppresses vanilla cards); ammo tracking on chain
      // crossbow shots is the one known soft spot.
      let fireVia = null;
      const acts = item.system?.activities;
      const list = acts ? (typeof acts.values === "function" ? [...acts.values()] : Object.values(acts)) : [];
      const atk = activity ?? list.find(a => a?.type === "attack");
      if (atk && typeof atk.rollAttack === "function") {
        // Tag an off-hand swing so dnd5e sets roll.options.attackMode = "offhand"
        // (proven: without this it defaults to "oneHanded"). The rollAttackV2
        // trigger reads that tag to strip the RAW off-hand damage mod — robust
        // across the pop-up path AND any native two-weapon attack.
        const _atkCfg = isOffhand ? { attackMode: "offhand" } : {};
        fireVia = ["rollAttack direct (no event, dialog skipped)", () => atk.rollAttack(_atkCfg, { configure: false }, {})];
      } else if (activity && typeof activity.use === "function") {
        fireVia = ["explicit activity use", () => activity.use({ event: fakeEvent }, {}, {})];
      } else if (typeof item.use === "function") {
        fireVia = ["item.use (legacy)", () => item.use({ event: fakeEvent }, {}, {})];
      }
      if (!fireVia) {
        throw new Error(`"${item.name}" has no usable attack activity and no use() — item data problem`);
      }
      console.log(`${MODULE_ID} | [chain] firing ${item.name} via ${fireVia[0]}`);
      const result = await fireVia[1]();
      console.log(`${MODULE_ID} | [chain] ${item.name} use() returned ${result ? "OK" : String(result) + " (dnd5e declined the use — a gate/dialog cancelled it?)"}`);
    } finally {
      // Hold the guard a beat past use() so BOTH dual hooks for this swing are
      // covered, then release.
      setTimeout(() => this._inFlight.delete(actor.id), 250);
    }
  }
}
