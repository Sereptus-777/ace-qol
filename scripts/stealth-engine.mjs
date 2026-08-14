// ─── ACE: QOL — Stealth / Hide / Surprise ────────────────────────────────────
// RAW (PHB 192-194 + 175):
//   - SURPRISE: at combat start, GM compares each side's Stealth (active hide)
//     to opposing side's passive Perception. Anyone who didn't notice an enemy
//     is surprised — can't move or take an action on their first turn.
//   - HIDE ACTION: take the Hide action → DEX(Stealth) check. The result is
//     contested by passive Perception (or active Search). Hidden = enemies
//     can't see you for targeting.
//   - ATTACK FROM HIDDEN: advantage on the attack roll. After the attack hits
//     or misses, you're no longer hidden (the attack reveals you).
//   - HIDE BROKEN: if you move into open with no cover, your hide breaks.
//
// SCOPE
//   - Surprise prompt at combat start (Foundry combatStart hook)
//   - Hide action via game.aceQol.hide(token) API + macro / token-toolbar btn
//   - Attack-from-hidden auto-grants advantage in attack pipeline
//   - Hide cleared on attack roll + on damage taken
//
// TOKEN-LEVEL STATE
//   tokenDoc.flags["ace-qol"].hidden = { stealthDC: 17, hiddenAt: ts }
//   tokenDoc.flags["ace-qol"].surprised = true | false (cleared at end of round 1)
//
// SETTINGS
//   - autoSurpriseCheck   (Boolean, default true)
//   - hideActionEnabled   (Boolean, default true)
//   - hideRevealsOnAttack (Boolean, default true)
//   - hideRevealsOnDamage (Boolean, default true)
// ──────────────────────────────────────────────────────────────────────────────

import { MODULE_ID } from "./ace-qol.mjs";
import { QolSettings } from "./settings.mjs";
import { CombatState } from "./combat-state.mjs";

// Hardcoded literal — using MODULE_ID at module-eval time triggers a TDZ
// circular-import error because stealth-engine is imported BY ace-qol.mjs.
// Same pattern as custom-polymorph.mjs.
const FLAG_NS = "ace-qol";
const FLAG_HIDDEN    = "hidden";
const FLAG_SURPRISED = "surprised";

export class StealthEngine {

  static init() {
    // ── Pre-start surprise detection (preferred path) ──
    // Runs BEFORE initiative is rolled so the standard "surprised" status is
    // in place when dnd5e rolls initiative. On 2024 worlds the dnd5e system
    // wires the surprised status into its initiative-disadvantage set
    // (dnd5e.mjs ~line 47284), so applying the status here makes the system
    // roll initiative with disadvantage automatically. On 2014 worlds the
    // system removes that wiring (~50250), so the status is a marker for
    // ACE QOL's own turn-skip + Assassinate detection.
    Hooks.on("preUpdateCombat", async (combat, changes /*, opts, userId */) => {
      try {
        if (game.users?.activeGM !== game.user) return;
        if (!QolSettings.get?.("autoSurpriseCheck")) return;
        if (changes?.started !== true) return; // only fires on the start transition
        if (combat?.started) return; // already started — don't re-run
        await StealthEngine._runSurpriseCheck(combat);
      } catch (err) {
        console.warn(`${MODULE_ID} | Surprise check (preUpdateCombat) threw:`, err);
      }
    });

    // ── Fallback: run at combatStart if preUpdateCombat didn't catch ──
    // Guards against the possibility of an older Foundry version or a
    // module load order that misses the preUpdateCombat hook.
    Hooks.on("combatStart", async (combat) => {
      try {
        if (game.users?.activeGM !== game.user) return;
        if (!QolSettings.get?.("autoSurpriseCheck")) return;
        // Skip if any combatant already has the ACE QOL surprised flag —
        // means the preUpdateCombat path already ran.
        const alreadyChecked = (combat?.combatants?.contents ?? []).some(c =>
          c?.token?.getFlag?.(FLAG_NS, FLAG_SURPRISED) !== undefined
        );
        if (alreadyChecked) return;
        await StealthEngine._runSurpriseCheck(combat);
      } catch (err) {
        console.warn(`${MODULE_ID} | Surprise check (combatStart) threw:`, err);
      }
    });

    // ── 2014 turn-skip: surprised combatants skip their first turn ──
    // On round 1, when a surprised combatant's turn comes up, auto-advance
    // past them with a chat note. 2024 RAW does NOT skip turns (surprise
    // becomes init-disadvantage instead), so this only fires on 2014 worlds.
    Hooks.on("combatTurnChange", async (combat /*, prev, current */) => {
      try {
        if (game.users?.activeGM !== game.user) return;  // activeGM: nextTurn() must only fire once
        if ((combat?.round ?? 0) !== 1) return;
        const currentCombatant = combat?.combatant;
        if (!currentCombatant?.token) return;
        const isSurprised = currentCombatant.token.getFlag?.(FLAG_NS, FLAG_SURPRISED) === true;
        if (!isSurprised) return;
        // Edition check — 2014 only.
        const edition = CombatState.getActiveEdition(currentCombatant.actor);
        if (edition !== "2014") return;
        await ChatMessage.create({
          content: `<div class="ace-qol-surprise-card" style="border-left:3px solid #d4af37;padding:6px 10px;">
            <strong>⚠️ ${currentCombatant.name}</strong> is surprised — turn skipped. <small style="opacity:0.7;">(2014 RAW)</small>
          </div>`,
          speaker: ChatMessage.getSpeaker({ actor: currentCombatant.actor }),
        });
        await combat.nextTurn?.();
      } catch (err) {
        console.warn(`${MODULE_ID} | Surprise turn-skip threw:`, err);
      }
    });

    // ── Round 2: clear surprised flags and the standard surprised status ──
    //
    // ⚠️ READ THE ROUND WE ARE MOVING *INTO*. Foundry fires combatRound BEFORE
    // it applies the update (client/documents/combat.mjs:235), so `combat.round`
    // inside this handler is still the round that is ENDING. Advancing into
    // round 2 read "1" and bailed; surprise only cleared on the way into round
    // THREE — a surprised creature stayed surprised for a whole extra round.
    // `updateData.round` is the round being entered. (audit F-022, 2026-08-07)
    Hooks.on("combatRound", async (combat, updateData) => {
      try {
        if (game.users?.activeGM !== game.user) return;
        const enteringRound = Number(updateData?.round ?? combat?.round ?? 0);
        if (enteringRound < 2) return;
        for (const c of combat.combatants ?? []) {
          const td = c.token;
          if (!td) continue;
          if (td.getFlag?.(FLAG_NS, FLAG_SURPRISED)) {
            await td.unsetFlag?.(FLAG_NS, FLAG_SURPRISED);
          }
          // Also clear the standard surprised status that the surprise check
          // applies. RAW: surprise lasts only the first round, then the
          // creature is no longer surprised.
          try {
            if (c.actor?.statuses?.has?.("surprised") && c.actor?.toggleStatusEffect) {
              await c.actor.toggleStatusEffect("surprised", { active: false });
            }
          } catch (_) { /* non-fatal */ }
        }
      } catch (err) {
        console.warn(`${MODULE_ID} | Surprise reset threw:`, err);
      }
    });

    // ── Hide cleared on attack ──
    Hooks.on(`${MODULE_ID}.preAttackRoll`, async (data) => {
      try {
        if (!QolSettings.get?.("hideRevealsOnAttack")) return;
        const tokenDoc = data?.attackerToken?.document ?? data?.tokenDoc;
        if (!tokenDoc) return;
        if (tokenDoc.getFlag?.(FLAG_NS, FLAG_HIDDEN)) {
          await tokenDoc.unsetFlag?.(FLAG_NS, FLAG_HIDDEN);
          console.log(`${MODULE_ID} | ${tokenDoc.name} revealed by attacking`);
        }
      } catch (err) { /* non-fatal */ }
    });

    // ── Hide cleared on damage taken ──
    Hooks.on("dnd5e.preApplyDamage", async (actor, amount) => {
      try {
        if (!QolSettings.get?.("hideRevealsOnDamage")) return;
        if (!Number.isFinite(amount) || amount <= 0) return;
        const tokens = actor.getActiveTokens?.() ?? [];
        for (const t of tokens) {
          const td = t.document;
          if (td.getFlag?.(FLAG_NS, FLAG_HIDDEN)) {
            await td.unsetFlag?.(FLAG_NS, FLAG_HIDDEN);
            console.log(`${MODULE_ID} | ${td.name} revealed by taking damage`);
          }
        }
      } catch (err) { /* non-fatal */ }
    });

    console.debug(`${MODULE_ID} | StealthEngine online`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Public API
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Take the Hide action for the given token. Rolls DEX(Stealth), stores
   * the result on the token as the hide DC. Posts a chat card.
   * @param {Token|TokenDocument} tokenOrDoc
   * @returns {Promise<{ rolled:number, hidden:boolean }|null>}
   */
  static async hide(tokenOrDoc) {
    if (!QolSettings.get?.("hideActionEnabled")) {
      ui.notifications?.warn("Hide action is disabled in module settings.");
      return null;
    }
    const td = tokenOrDoc?.document ?? tokenOrDoc;
    const actor = td?.actor;
    if (!actor) {
      ui.notifications?.error("Hide: no actor on this token.");
      return null;
    }

    // ── Roll DEX (Stealth). ────────────────────────────────────────────────
    // ⚠️ 🔴 THIS ROLLED A BARE d20 FOR MONTHS. Found in the 2026-08-12 audit.
    // The old line was:
    //     actor.rollSkillV2?.({skill:"ste"}, …) ?? actor.rollSkill?.("ste", …)
    // `rollSkillV2` does not exist in dnd5e 5.x — nor anywhere in Foundry — so
    // the optional-call returned undefined and `??` handed off to the second
    // one, which is the **4.x** signature. In 5.x the first argument is a
    // CONFIG OBJECT and the method reads `config.skill`; given the string
    // "ste", `config.skill` is undefined, no skill resolves, and no ability
    // resolves either. A rogue with +11 Stealth was hiding on a flat d20 — and
    // the Hide DC written to the token was that flat number.
    //
    // `{configure:false}` is what suppresses the dialog in 5.x — `fastForward`
    // is the 4.x spelling and does nothing. `{create:false}` keeps dnd5e's own
    // card out of the log so ours is the only one.
    let stealthRoll;
    try {
      const rolls = await actor.rollSkill(
        { skill: "ste" },
        { configure: false },
        { create: false },
      );
      stealthRoll = Array.isArray(rolls) ? rolls[0] : (rolls?.rolls?.[0] ?? rolls);
    } catch (err) {
      console.warn(`${MODULE_ID} | Hide: stealth roll failed`, err);
      return null;
    }
    const total = Number(stealthRoll?.total ?? NaN);
    if (!Number.isFinite(total)) {
      // ⚠️ Do NOT stamp a 0 hide DC — that is a creature that everything sees,
      // reported as a successful hide. Say so and take no action.
      console.warn(`${MODULE_ID} | Hide: no usable Stealth total for ${actor.name} — not hiding.`);
      ui.notifications?.error(`ACE could not roll ${actor.name}'s Stealth — Hide cancelled.`);
      return null;
    }

    // Stamp the hide on the token
    await td.setFlag?.(FLAG_NS, FLAG_HIDDEN, {
      stealthDC: total,
      hiddenAt:  game.time?.worldTime ?? 0,
      stamp:     Date.now(),
    });

    // Post a chat card
    await ChatMessage.create({
      speaker: ChatMessage.getSpeaker({ actor }),
      content: `<div class="ace-qol-hide-card">
        <strong>🕵️ ${actor.name} hides</strong><br/>
        Stealth: <strong>${total}</strong> (passive Perception below this won't see them)
      </div>`,
      flags: { [MODULE_ID]: { type: "hideAction", actorId: actor.id, dc: total } },
    });

    return { rolled: total, hidden: true };
  }

  /**
   * Clear the hidden state on a token (manual reveal).
   */
  static async reveal(tokenOrDoc) {
    const td = tokenOrDoc?.document ?? tokenOrDoc;
    if (!td) return;
    if (td.getFlag?.(FLAG_NS, FLAG_HIDDEN)) {
      await td.unsetFlag?.(FLAG_NS, FLAG_HIDDEN);
    }
  }

  /**
   * Check if the attacker has advantage from being hidden vs the target.
   * Called from attack-pipeline to grant advantage.
   * @returns {boolean}
   */
  static attackerHiddenFromTarget(attackerToken, targetToken) {
    if (!attackerToken || !targetToken) return false;
    const attDoc = attackerToken.document ?? attackerToken;
    const tgtActor = targetToken.actor;
    const hideData = attDoc.getFlag?.(FLAG_NS, FLAG_HIDDEN);
    if (!hideData) return false;
    const passivePerception = Number(tgtActor?.system?.skills?.prc?.passive ?? 10);
    return Number(hideData.stealthDC ?? 0) > passivePerception;
  }

  /**
   * Returns true if the given combatant is surprised (skipping first turn).
   */
  static isSurprised(tokenDocOrCombatant) {
    const td = tokenDocOrCombatant?.token ?? tokenDocOrCombatant;
    return !!td?.getFlag?.(FLAG_NS, FLAG_SURPRISED);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Internal — Surprise check at combat start
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * For each combatant, compare its passive Perception to every opposing
   * side's stealth (rolled Hide flag if present, else 1d20 + Stealth mod).
   * If passive Perception fails to notice ALL opposing combatants, that
   * combatant is surprised.
   *
   * "Sides" here are simple: PC owners are one side, NPCs are the other.
   * GM can manually adjust by clearing `surprised` flags on individual
   * combatants if a faction is mixed.
   */
  static async _runSurpriseCheck(combat) {
    const combatants = combat?.combatants?.contents ?? [];
    const pcSide  = combatants.filter(c => c.actor?.hasPlayerOwner);
    const npcSide = combatants.filter(c => c.actor && !c.actor.hasPlayerOwner);
    if (!pcSide.length || !npcSide.length) return; // need both sides

    const surprised = [];

    for (const me of combatants) {
      const opposing = me.actor?.hasPlayerOwner ? npcSide : pcSide;
      const myPP = Number(me.actor?.system?.skills?.prc?.passive ?? 10);
      // Did I notice at least ONE enemy?
      let noticedAtLeastOne = false;
      for (const enemy of opposing) {
        const enemyTd = enemy.token;
        if (!enemyTd) continue;
        // Use rolled hide if present, else passive (10 + Stealth mod)
        const hideData = enemyTd.getFlag?.(FLAG_NS, FLAG_HIDDEN);
        const enemyStealth = hideData?.stealthDC
                          ?? Number(10 + (enemy.actor?.system?.skills?.ste?.mod ?? 0));
        if (myPP >= enemyStealth) {
          noticedAtLeastOne = true;
          break;
        }
      }
      if (!noticedAtLeastOne && me.token) {
        surprised.push(me);
        await me.token.setFlag?.(FLAG_NS, FLAG_SURPRISED, true);
        // Also apply the standard "surprised" status so:
        //   • In 2024 mode the dnd5e system applies init-disadvantage automatically.
        //   • In 2014 mode the Assassinate auto-crit gate sees the status.
        //   • Either way, downstream automation that watches the standard status
        //     (cross-module, macros, other QOL features) stays in sync.
        try {
          if (me.actor?.toggleStatusEffect) {
            await me.actor.toggleStatusEffect("surprised", { active: true });
          }
        } catch (_) { /* non-fatal */ }
      }
    }

    if (surprised.length > 0) {
      const names = surprised.map(c => c.name).join(", ");
      // Edition-aware card text. Derive the edition from the first surprised
      // actor — in a homogeneous world every combatant resolves to the same
      // edition via the dnd5e rulesVersion setting.
      const edition = CombatState.getActiveEdition(surprised[0]?.actor);
      const bodyText = edition === "2014"
        ? `${names} ${surprised.length === 1 ? "is" : "are"} surprised — turn skipped on round 1, no reactions until that turn ends. <small style="opacity:0.7;">(2014 RAW)</small>`
        : `${names} ${surprised.length === 1 ? "is" : "are"} surprised — initiative rolled with disadvantage. <small style="opacity:0.7;">(2024 RAW — handled by dnd5e system)</small>`;
      await ChatMessage.create({
        content: `<div class="ace-qol-surprise-card">
          <strong>⚠️ SURPRISE</strong><br/>
          ${bodyText}
        </div>`,
        flags: { [MODULE_ID]: { type: "surprise", surprised: surprised.map(c => c.id), edition } },
      });
    }
  }
}
