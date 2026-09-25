// ============================================================================
//  ACE QOL — Feat-Effect Riders (Polearm Master, Crusher, Slasher, Piercer)
//
//  Feat-driven post-hit effects that pair with the existing damage pipeline.
//  Each listens to `ace-qol.attackComplete` and fires per hit/miss + per crit:
//
//   • Polearm Master  — if actor wields qualifying polearm (Glaive, Halberd,
//                       Pike, Quarterstaff, Spear), post a "bonus-action
//                       butt attack" reminder. Damage = 1d4 + ability mod
//                       (same mod as primary), type bludgeoning.
//   • Crusher         — bludgeoning hit: card with "Push 5 feet" button +
//                       crit bonus: card noting "advantage on next attack
//                       vs this target until start of your next turn".
//                       Once per turn.
//   • Slasher         — slashing hit: card with "Speed -10 feet until start
//                       of your next turn" reminder + crit bonus: target
//                       has Disadvantage on attack rolls vs anyone except
//                       you. Once per turn.
//   • Piercer         — piercing hit: card noting "you may reroll one of
//                       this attack's damage dice (must use new roll)" +
//                       crit bonus: roll one additional damage die. Once
//                       per turn. Full dice-mutation automation is in a
//                       follow-up; we surface the rule via card.
//
//  Once-per-turn flags follow the existing pattern (clear on combatTurnChange
//  via ace-qol.mjs).
// ============================================================================

import { CombatState } from "./combat-state.mjs";
import { registerChatCardHandler } from "./chat-render-utils.mjs";
// The one reader for a weapon's own damage type (read-activities imports nothing).
import { weaponDamageTypes } from "./read-activities.mjs";
// "to an unoccupied space" and "no more than one size larger than you", both RAW.
import { aceSpaceFreeFor, aceSnapToGrid, aceSizeSteps } from "./geometry-utils.mjs";

const MODULE_ID = "ace-qol";
const TAG       = `${MODULE_ID} | FeatEffects`;

const POLEARM_NAMES = new Set(["glaive", "halberd", "pike", "quarterstaff", "spear"]);

export class FeatEffects {
  static _initialized = false;

  static init() {
    if (this._initialized) return;
    this._initialized = true;
    Hooks.on(`${MODULE_ID}.attackComplete`, (data) => {
      try { this._onAttackComplete(data); }
      catch (err) { console.warn(`${TAG} | attackComplete handler failed:`, err); }
    });
    // V13-SAFE: handler reads native element OR jQuery. Registered on BOTH hooks —
    // the V13 `renderChatMessageHTML` was missing, so the Crusher push button was
    // inert on V13.
    const _wireFeatCard = (message, html) => {
      if (!game.user.isGM) return;
      if (message?.flags?.[MODULE_ID]?.type !== "featEffect") return;
      const el = (html instanceof HTMLElement) ? html : (html?.[0] ?? html);
      if (!el?.querySelectorAll) return;
      el.querySelectorAll(".ace-qol-crusher-push-btn:not([data-bound])").forEach(btn => {
        btn.setAttribute("data-bound", "1");
        // ⚠️ READ THE RETURN VALUE. This said "Pushed" and greyed the button out
        // the instant it was clicked, without awaiting the push and without asking
        // whether it happened — so a push RAW forbids (no unoccupied space) still
        // reported success and burned the button.
        btn.addEventListener("click", async () => {
          if (btn.disabled) return;
          btn.disabled = true;
          try {
            const moved = await this._pushTarget5ft(btn.dataset.attackerUuid, btn.dataset.targetUuid);
            if (moved) {
              btn.innerHTML = `<i class="fas fa-check"></i> Pushed`;
            } else {
              // It refused for a reason the notification already gave. Leave the
              // button live so the GM can move somebody and try again.
              btn.disabled = false;
              btn.innerHTML = `<i class="fas fa-ban"></i> No space — try again`;
            }
          } catch (err) {
            btn.disabled = false;
            console.warn(`${TAG} | Crusher push click failed:`, err);
            ui.notifications?.warn("Crusher: the push failed — see the console.");
          }
        });
      });
    };
    // Both render hooks + a sweep of cards that were drawn before this
    // registered. See chat-render-utils — the raw hooks leave those
    // undecorated forever, which is how GM-only content reached a player.
    registerChatCardHandler(_wireFeatCard, "feat cards");
    console.log(`${TAG} | Feat-effect handlers online (Polearm Master, Crusher, Slasher, Piercer).`);
  }

  static async _onAttackComplete({ item, actor, hits, misses, subject }) {
    if (!game.user.isGM) return;
    if (!item || !actor || !hits?.length) return;

    const nameNorm = String(item.name ?? "").toLowerCase().trim();

    // ⚠️🔴 A WEAPON'S DAMAGE TYPE IS NOT IN `damage.parts` (2026-09-25, proven).
    // This read `item.system.damage.parts[0][1]`, and dnd5e 5.x weapons have no
    // such field: WeaponData's schema is `damage: { base, versatile }` and its own
    // migration lifts the old `parts[0]` into `base`. Not ONE of the 3,185 weapons
    // in hijinx carries `parts`, so this was always "" and Crusher, Slasher and
    // Piercer have never fired once — silently, because an empty string simply
    // matches none of the three tests below.
    //
    // ⚠️ AND IT IS THE PRESSED ACTIVITY THAT DEALS THE DAMAGE. `subject` is the
    // activity the attack actually used (attack-pipeline and the socket path both
    // send it); a multi-activity weapon's first ability is not necessarily it.
    const damageTypes = new Set(weaponDamageTypes(item, subject ?? null));
    const wantsRider = this._hasFeat(actor, "Crusher")
                    || this._hasFeat(actor, "Slasher")
                    || this._hasFeat(actor, "Piercer");
    // Silence is a bug: a feat holder swinging something with no declared type is
    // a real answer, and it must be possible to tell it from a broken read.
    if (wantsRider && !damageTypes.size) {
      console.log(`${TAG} | ${actor.name} has a Crusher/Slasher/Piercer feat, but `
        + `"${item.name}" declares no damage type at all (nothing on the item's base `
        + `damage and nothing on the activity used), so no rider applies.`);
    }

    // ── Polearm Master ──
    if (this._hasFeat(actor, "Polearm Master") && POLEARM_NAMES.has(nameNorm)) {
      // Use the primary attack's ability modifier (item ability or STR fallback)
      const abilKey = item.system?.ability || "str";
      const abilMod = actor.system?.abilities?.[abilKey]?.mod ?? 0;
      this._postFeatCard("polearm-master", item, actor, hits[0]?.target,
        `${actor.name} may make a <strong>Bonus Action butt attack</strong> with the ${item.name}: 1d4 + ${abilMod} bludgeoning.`,
        "#b08850", "fa-cane"
      );
    }

    // ── Dual Wielder (Enhanced Dual Wielding, 2024 XPHB) ──
    // RAW: "When you take the Attack action on your turn and attack with a
    // weapon that has the Light property, you can make one extra attack as
    // a Bonus Action later on the same turn with a different weapon, which
    // must be a Melee weapon that lacks the Two-Handed property. You don't
    // add your ability modifier to the extra attack's damage."
    // We fire on attacks made with a Light weapon by an actor with the feat.
    // Posted at most once per turn so multi-attack volleys don't spam.
    //
    // Detection paths:
    //   1. dnd5e 5.x stores the "Edit Sheet" checkbox at
    //      flags.dnd5e.enhancedDualWielding (boolean — not an item).
    //   2. DDB imports as an actual feat item named "Enhanced Dual
    //      Wielding" or "Dual Wielder".
    // We accept either source.
    const hasDualWielderFlag = actor?.getFlag?.("dnd5e", "enhancedDualWielding") === true
                            || actor?.getFlag?.("dnd5e", "dualWielder") === true;
    const hasDualWielderItem = (actor?.items ?? []).some(i =>
      /dual.?wield/i.test(String(i.name ?? ""))
    );
    const hasDualWielder = hasDualWielderFlag || hasDualWielderItem;
    if (hasDualWielder) {
      const props = item?.system?.properties ?? new Set();
      const isLight = props.has?.("lgt");
      const alreadyShown = !!actor.getFlag?.(MODULE_ID, "dualWielderReminder.shownThisTurn");
      if (isLight && !alreadyShown) {
        try { await actor.setFlag(MODULE_ID, "dualWielderReminder.shownThisTurn", true); }
        catch (_) { /* non-fatal */ }
        this._postFeatCard("dual-wielder", item, actor, hits[0]?.target,
          `${actor.name} may make a <strong>Bonus Action attack</strong> with any equipped melee weapon that isn't two-handed — <em>Light property not required</em>. (Ability modifier is NOT added to that attack's damage.)`,
          "#c08866", "fa-khanda"
        );
      }
    }

    // ── Crusher / Slasher / Piercer — once-per-turn riders by damage type ──
    for (const hit of hits) {
      const isCrit = hit?.hitResult === "critical";
      // ⚠️ THE TOKEN, NOT THE TARGET BLOCK (2026-09-19). An attack result keeps
      // the creature's token beside its `target` block (`targetToken`, from
      // CombatState.assess); the block holds only the name, picture and AC.
      // Handed the block, Crusher's push button carried no creature to push
      // and neither crit rider could mark anybody. The riders read a token:
      // its name, its document for the push, its actor for the mark.
      const target = hit?.targetToken ?? hit?.target?.token ?? null;
      // ⚠️ A WEAPON CAN DECLARE TWO TYPES, so this asks "does it deal bludgeoning",
      // not "is bludgeoning its first type". A Javelin of Lightning deals piercing
      // AND lightning, and its Piercer rider is owed either way.
      if (damageTypes.has("bludgeoning") && this._hasFeat(actor, "Crusher")) {
        await this._fireCrusher(item, actor, target, isCrit);
      }
      if (damageTypes.has("slashing") && this._hasFeat(actor, "Slasher")) {
        await this._fireSlasher(item, actor, target, isCrit);
      }
      if (damageTypes.has("piercing") && this._hasFeat(actor, "Piercer")) {
        await this._firePiercer(item, actor, target, isCrit);
      }
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  //  Crusher
  // ──────────────────────────────────────────────────────────────────────────

  static async _fireCrusher(item, actor, target, isCrit) {
    const alreadyUsed = !!actor.getFlag?.(MODULE_ID, "crusher.usedThisTurn");
    const targetName = target?.name ?? "the target";

    if (!alreadyUsed) {
      // ⚠️ RAW, BOTH EDITIONS: "provided the target is no more than one size
      // larger than you" (TCE p79) / "if the target is no more than one size
      // larger than you" (XPHB p203). The button used to be offered against
      // anything, so a Medium fighter was invited to shove a Gargantuan dragon.
      const steps = aceSizeSteps(this._sizeOf(target?.actor), this._sizeOf(actor));
      const tooBig = steps !== null && steps > 1;
      await actor.setFlag(MODULE_ID, "crusher.usedThisTurn", true);
      if (tooBig) {
        // Not a dead button: say why there is none.
        this._postFeatCard("crusher", item, actor, target,
          `${targetName} is more than one size larger than ${actor.name}, so Crusher's `
          + `push does not apply. <small style="opacity:0.7;">(RAW, both editions)</small>`,
          "#7a5a4a", "fa-hammer"
        );
        return;
      }
      const attUuid = actor.uuid;
      const tgtUuid = target?.document?.uuid ?? target?.uuid;
      this._postFeatCard("crusher", item, actor, target,
        `${actor.name} may push <strong>${targetName} 5 feet</strong> to an unoccupied space.`,
        "#b07050", "fa-hammer",
        `<div style="margin-top:6px;">
          <button class="ace-qol-btn ace-qol-crusher-push-btn"
                  data-attacker-uuid="${attUuid}"
                  data-target-uuid="${tgtUuid}"
                  style="background:#3a1a0a; color:#ffe1c8; border:1px solid #b07050; border-radius:4px; padding:4px 10px; font-size:12px;">
            <i class="fas fa-hand-back-fist"></i> Push 5 feet
          </button>
        </div>`
      );
    }

    if (isCrit) {
      // Auto-set the crit advantage flag on the TARGET. Combat-state reads
      // this when ANY attacker rolls vs this target → advantage. Cleared
      // at start of actor's (the Crusher's) next turn via combatTurnChange.
      try {
        if (target?.actor) {
          await target.actor.setFlag(MODULE_ID, "crusherCritDebuff",
            this._critWindow({ byUuid: actor.uuid }, actor));
        }
      } catch (err) { console.warn(`${TAG} | Crusher crit mark failed:`, err); }
      // ⚠️🔴 NEITHER EDITION EXCLUDES THE CRUSHER (checked word for word, 2026-09-25).
      // TCE p79: "attack rolls against that creature are made with advantage until
      // the start of your next turn." XPHB p203: "attack rolls against that creature
      // have Advantage until the start of your next turn." There is no "by other
      // creatures" in either one — that carve-out was invented here and in
      // combat-state, and it took the advantage off the Crusher's own follow-up
      // swings, which is the whole point of the feat.
      this._postFeatCard("crusher-crit", item, actor, target,
        `Attack rolls against ${targetName} have <strong>Advantage</strong> until the start of `
        + `${actor.name}'s next turn — <em>${actor.name}'s own attacks included</em>.`,
        "#d4af37", "fa-star"
      );
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  //  Slasher
  // ──────────────────────────────────────────────────────────────────────────

  static async _fireSlasher(item, actor, target, isCrit) {
    const alreadyUsed = !!actor.getFlag?.(MODULE_ID, "slasher.usedThisTurn");
    const targetName = target?.name ?? "the target";

    if (!alreadyUsed) {
      await actor.setFlag(MODULE_ID, "slasher.usedThisTurn", true);
      this._postFeatCard("slasher", item, actor, target,
        `${targetName}'s speed is reduced by <strong>10 feet</strong> until the start of ${actor.name}'s next turn.`,
        "#a02828", "fa-sword"
      );
    }

    if (isCrit) {
      // The flag lives on the creature that was wounded; combat-state reads it
      // whenever that creature attacks ANYONE and adds disadvantage. There is no
      // exception in either edition's text, so nothing is carved out here.
      try {
        if (target?.actor) {
          await target.actor.setFlag(MODULE_ID, "slasherCritDebuff",
            this._critWindow({ byUuid: actor.uuid }, actor));
        }
      } catch (err) { console.warn(`${TAG} | Slasher crit mark failed:`, err); }
      // ⚠️🔴 NEITHER EDITION EXCLUDES THE SLASHER EITHER. TCE p81: "the target has
      // disadvantage on all attack rolls." XPHB p207: "it has Disadvantage on attack
      // rolls until the start of your next turn." The "against anyone except you"
      // carve-out was invented here and in combat-state, and it handed the target a
      // clean roll against the one person who wounded it.
      this._postFeatCard("slasher-crit", item, actor, target,
        `${targetName} has <strong>Disadvantage</strong> on <em>all</em> attack rolls until `
        + `the start of ${actor.name}'s next turn — including against ${actor.name}.`,
        "#d04040", "fa-star"
      );
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  //  Piercer
  // ──────────────────────────────────────────────────────────────────────────

  static async _firePiercer(item, actor, target, isCrit) {
    const alreadyUsed = !!actor.getFlag?.(MODULE_ID, "piercer.usedThisTurn");
    const targetName = target?.name ?? "the target";

    if (!alreadyUsed) {
      await actor.setFlag(MODULE_ID, "piercer.usedThisTurn", true);
      this._postFeatCard("piercer", item, actor, target,
        `${actor.name} may <strong>reroll one of this attack's damage dice</strong> (must use the new roll).`,
        "#7090b0", "fa-bolt"
      );
    }

    if (isCrit) {
      // Set a one-shot marker the damage-calculator reads on the NEXT
      // damage roll. (For Piercer the extra die fires WITH this same crit's
      // damage roll, but our attackComplete fires AFTER the attack roll
      // resolves but BEFORE damage rolls — by setting the flag now, the
      // upcoming damage-roll picks it up.) The flag is consumed by
      // damage-calculator after one use.
      try {
        await actor.setFlag(MODULE_ID, "piercerCrit.pendingExtraDie", true);
      } catch (_) { /* non-fatal */ }
      this._postFeatCard("piercer-crit", item, actor, target,
        `On this critical hit with piercing damage, you roll <strong>one additional damage die</strong>.`,
        "#d4af37", "fa-star"
      );
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  //  Buttons
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Crusher's push: 5 feet straight away from the attacker, into a space that is
   * actually empty.
   *
   * ⚠️🔴 "TO AN UNOCCUPIED SPACE" IS PART OF THE RULE (RAW, both editions). This
   * moved the token five feet in the direction of travel and checked nothing, so
   * a push could stack the target on top of an ally, inside a wall, or off the
   * scene. The one occupancy answer lives in geometry-utils.
   *
   * ⚠️ AND A PUSH IS FORCED MOVEMENT, so it must not provoke an opportunity
   * attack. Push mastery already stamped `aceForcedMovement`; Crusher never did,
   * so every Crusher push handed the target's neighbours a free swing.
   */
  static async _pushTarget5ft(attackerUuid, targetUuid) {
    const attTokenDoc = await fromUuid(attackerUuid).catch(() => null);
    const tgtTokenDoc = await fromUuid(targetUuid).catch(() => null);
    const attTok = attTokenDoc?.documentName === "Token" ? attTokenDoc
                 : attTokenDoc?.getActiveTokens?.()[0]?.document ?? null;
    const tgtTok = tgtTokenDoc?.documentName === "Token" ? tgtTokenDoc
                 : tgtTokenDoc?.getActiveTokens?.()[0]?.document ?? null;
    if (!attTok || !tgtTok) {
      ui.notifications?.warn("Crusher: couldn't resolve the attacker or the target token.");
      console.warn(`${TAG} | Crusher push: attacker ${attTok ? "found" : "missing"}, `
        + `target ${tgtTok ? "found" : "missing"} — nothing moved.`);
      return false;
    }
    const dx = tgtTok.x - attTok.x;
    const dy = tgtTok.y - attTok.y;
    const dist = Math.hypot(dx, dy) || 1;
    const cell = canvas.grid?.size ?? 100;
    const pushPx = cell * 1; // 5 feet on a 5-feet grid
    const aim = aceSnapToGrid(Math.round(tgtTok.x + (dx / dist) * pushPx),
                              Math.round(tgtTok.y + (dy / dist) * pushPx));
    if (!aceSpaceFreeFor(tgtTok, aim.x, aim.y)) {
      ui.notifications?.warn(`Crusher: there is no unoccupied space 5 feet behind `
        + `${tgtTok.name}, so the push cannot happen.`);
      console.log(`${TAG} | Crusher push: the space behind ${tgtTok.name} is taken `
        + `or off the scene, and RAW the push needs an unoccupied one. Nothing moved.`);
      return false;
    }
    await tgtTok.update({ x: aim.x, y: aim.y }, { aceForcedMovement: true });
    console.log(`${TAG} | Crusher pushed ${tgtTok.name} 5 feet away from ${attTok.name} `
      + `(forced movement — no opportunity attack).`);
    return true;
  }

  /**
   * Every creature that could be carrying a crit mark.
   *
   * ⚠️🔴 `game.actors` DOES NOT CONTAIN AN UNLINKED TOKEN'S ACTOR (2026-09-25).
   * This sweep read `game.actors.contents`, which is the world's Actor directory:
   * a linked PC is in it, and the unlinked token actor that almost every monster
   * in a Curse of Strahd fight actually is, is NOT. So a Crusher or Slasher mark
   * placed on a goblin was never once expired by this sweep — it sat on that
   * token giving permanent advantage against it until somebody cleared the flag
   * by hand. The marks are placed on whatever the attack hit, so the sweep has to
   * look where they were put: the combatants in the fight and the tokens on the
   * canvas, as well as the directory.
   */
  static _markedActorCandidates() {
    const out = new Map();
    const add = (a) => { if (a?.uuid && !out.has(a.uuid)) out.set(a.uuid, a); };
    try { for (const c of (game.combat?.combatants?.contents ?? [])) add(c?.actor); }
    catch (err) { console.warn(`${TAG} | could not read the fight's combatants:`, err); }
    try { for (const t of (canvas?.tokens?.placeables ?? [])) add(t?.actor); }
    catch (err) { console.warn(`${TAG} | could not read the canvas tokens:`, err); }
    try { for (const a of (game.actors?.contents ?? [])) add(a); }
    catch (err) { console.warn(`${TAG} | could not read the actor directory:`, err); }
    return out.values();
  }

  /** A creature's dnd5e size key, as both profiles and the sheet spell it. */
  static _sizeOf(actor) {
    return String(actor?.system?.traits?.size ?? "").trim().toLowerCase() || null;
  }

  /**
   * The window both crit riders last for: "until the start of your next turn".
   *
   * ⚠️🔴 THAT IS THE FEAT HOLDER'S OWN TURN, NOT THE TOP OF THE NEXT ROUND. Both
   * marks used to expire on `round >= setRound + 1`, and a round begins with
   * whoever rolled highest. A Crusher acting late in the order therefore lost the
   * advantage it had just created several creatures too early — everyone who acted
   * between the top of round 2 and the Crusher's own turn rolled flat. The window
   * now names the holder's combatant and ends when that combatant's turn begins.
   *
   * `throughRound` is kept as a backstop for a holder who leaves the fight (dies,
   * is banished, is removed from the tracker) and whose turn therefore never
   * arrives — without it the mark would sit on the target forever.
   */
  static _critWindow(base, holder) {
    const combat = game.combat ?? null;
    let combatantId = null;
    try {
      combatantId = (combat?.combatants?.contents ?? combat?.combatants ?? [])
        .find(c => c?.actorId === holder?.id)?.id ?? null;
    } catch (_) { combatantId = null; }
    const round = combat?.round ?? 0;
    return {
      ...base,
      combatId: combat?.id ?? null,
      untilTurnOf: combatantId,
      setOnRound: round,
      // One full round past the mark is the longest it can possibly be owed.
      throughRound: round + 2,
    };
  }

  // ──────────────────────────────────────────────────────────────────────────
  //  Helpers
  // ──────────────────────────────────────────────────────────────────────────

  static _hasFeat(actor, featName) {
    const re = new RegExp(featName.replace(/[^a-z0-9]/gi, ".?"), "i");
    return (actor?.items ?? []).some(i =>
      i.type === "feat" && re.test(String(i.name ?? ""))
    );
  }

  static _postFeatCard(featId, item, actor, target, body, color, icon, extraHtml = "") {
    const itemName = foundry.utils.escapeHTML(item?.name ?? "");
    const label    = featId.charAt(0).toUpperCase() + featId.slice(1).replace(/-/g, " ");
    ChatMessage.create({
      content: `<div class="ace-qol-card ace-qol-feat-card"
                     style="background:#0e0e10; border:2px solid ${color}; border-radius:6px; padding:10px 12px;">
        <div style="display:flex; align-items:center; gap:10px; margin-bottom:4px;">
          <i class="fas ${icon}" style="color:${color}; font-size:18px;"></i>
          <strong style="color:${color}; font-size:14px;">${label}</strong>
          <span style="color:#888; font-size:11px; margin-left:auto;">${itemName}</span>
        </div>
        <div style="color:#e0e0e0; font-size:12px; line-height:1.45;">${body}</div>
        ${extraHtml}
      </div>`,
      speaker: ChatMessage.getSpeaker({ actor }),
      flags: { [MODULE_ID]: { type: "featEffect", feat: featId } },
    });
  }

  // ──────────────────────────────────────────────────────────────────────────
  //  Flag cleanup (called from ace-qol.mjs combatTurnChange + deleteCombat)
  // ──────────────────────────────────────────────────────────────────────────

  static async clearOncePerTurnFlags(actor) {
    if (!actor) return;
    for (const k of [
      "crusher.usedThisTurn",
      "slasher.usedThisTurn",
      "piercer.usedThisTurn",
      "dualWielderReminder.shownThisTurn",
    ]) {
      try {
        if (actor.getFlag?.(MODULE_ID, k)) await actor.unsetFlag(MODULE_ID, k);
      } catch (_) { /* non-fatal */ }
    }
  }

  /**
   * Expire Crusher/Slasher crit marks whose window has closed: the feat holder's
   * own turn has come round again, the fight is a different one, or the holder
   * left the tracker and its turn is never going to arrive.
   *
   * Called from combatTurnChange in ace-qol.mjs, which passes the combatant whose
   * turn is STARTING — a mark that reads "until the start of your next turn" ends
   * exactly there.
   */
  static async expireCritDebuffsIfDue(startingCombatantId = null) {
    const round = game.combat?.round ?? null;
    const combatId = game.combat?.id ?? null;
    if (round === null) return;
    const live = new Set();
    try {
      for (const c of (game.combat?.combatants?.contents ?? [])) if (c?.id) live.add(c.id);
    } catch (_) { /* an empty set only makes the backstop do the work */ }
    for (const a of this._markedActorCandidates()) {
      for (const flagKey of ["crusherCritDebuff", "slasherCritDebuff"]) {
        const debuff = a?.getFlag?.(MODULE_ID, flagKey);
        if (!debuff || typeof debuff !== "object") continue;
        const holder = debuff.untilTurnOf ?? null;
        const expired =
          // A different fight, or no fight at all: the mark belongs to neither.
          (debuff.combatId && debuff.combatId !== combatId)
          // The holder's own turn is beginning now. This is the RAW end.
          || (holder && startingCombatantId && holder === startingCombatantId)
          // The holder is no longer in the fight, so its turn will never start.
          || (holder && live.size && !live.has(holder))
          // Backstop for a mark written before this had a turn window, and for a
          // fight whose turn order never reaches the holder again.
          || (typeof debuff.throughRound === "number" && round >= debuff.throughRound)
          || (typeof debuff.expiresAtRound === "number" && round >= debuff.expiresAtRound);
        if (expired) {
          try { await a.unsetFlag(MODULE_ID, flagKey); }
          catch (err) { console.warn(`${TAG} | could not clear ${flagKey} on ${a.name}:`, err); }
        }
      }
    }
  }
}
