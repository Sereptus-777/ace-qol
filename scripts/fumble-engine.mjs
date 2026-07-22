// ─── ACE: QOL — Critical Fumble (Optional Table Rule) ────────────────────────
// NOT RAW. PHB does not include a fumble table. This is a popular HOUSE RULE
// that adds consequences to natural-1 attack rolls. Off by default; enable
// via the `criticalFumbleEnabled` setting.
//
// Behavior:
//   - When an attack roll's natural d20 is 1, post a fumble chat card
//   - Roll on a 12-entry fumble table for the effect
//   - Effects vary from cosmetic (drop weapon) to mechanical (hit yourself
//     for half weapon damage, weapon breaks if non-magical, etc.)
//   - GM has final say — card describes the rolled effect, doesn't auto-apply
//     destructive effects (weapon-loss, disarm) without GM confirmation
//
// SETTINGS
//   - criticalFumbleEnabled (Boolean, default false)
// ──────────────────────────────────────────────────────────────────────────────

import { MODULE_ID } from "./ace-qol.mjs";
import { QolSettings } from "./settings.mjs";
import { CombatState } from "./combat-state.mjs";
import { safeShowForRoll } from "./damage-engine.mjs";

const FUMBLE_TABLE = [
  // 1-2: minor — clumsy stumble
  { range: [1, 2],   name: "Stumble",
    desc: "You stumble. No mechanical effect, but your stance is broken — describe a vivid miss." },
  // 3-4: drop weapon
  { range: [3, 4],   name: "Weapon Slips",
    desc: "Your weapon slips from your grasp. Drop your weapon (one free hand on next turn to retrieve)." },
  // 5: hit ally if adjacent
  { range: [5, 5],   name: "Wild Swing",
    desc: "Your strike goes wide. If an ally is adjacent, they make a DC 10 DEX save or take half your weapon's damage (no modifiers)." },
  // 6-7: standard whiff
  { range: [6, 7],   name: "Off Balance",
    desc: "Your aim is off — you take a -2 penalty to your next attack roll this combat." },
  // 8: minor self-damage
  { range: [8, 8],   name: "Self-Strike",
    desc: "You hurt yourself. Take 1d4 damage of your weapon's type (no modifiers)." },
  // 9-10: prone
  { range: [9, 10],  name: "Lose Footing",
    desc: "You fall PRONE." },
  // 11: weapon hangs up
  { range: [11, 11], name: "Weapon Stuck",
    desc: "Your weapon catches on something. You cannot use it again until you spend an Action to free it." },
  // 12 (extreme but rare on 1d12): weapon snaps if non-magical
  { range: [12, 12], name: "Weapon Damaged",
    desc: "Your weapon takes a beating. Non-magical weapons break (GM call); magical weapons unscathed." },
];

export class FumbleEngine {

  static init() {
    Hooks.on("dnd5e.rollAttackV2", async (rolls, data) => {
      try {
        const fumbleTable = QolSettings.get?.("criticalFumbleEnabled");
        const endsTurn    = QolSettings.get?.("fumbleEndsTurn");
        if (!fumbleTable && !endsTurn) return;
        const roll = Array.isArray(rolls) ? rolls[0] : rolls;
        if (!roll) return;
        // Detect a natural 1 on the KEPT die. With advantage (2d20kh) a
        // DISCARDED 1 is NOT a fumble — only the active/kept die counts.
        // results[0] read the FIRST die, so a kept 17 + discarded 1 falsely
        // fired a fumble AND would have ended the turn (Johnny 2026-07-11).
        const d20 = roll.dice?.find(d => d.faces === 20);
        if (!d20) return;
        const keptResult = (d20.results ?? []).find(r => r.active !== false)?.result
                        ?? d20.results?.[0]?.result;
        if (keptResult !== 1) return;
        // Note: dnd5e ALSO checks if the actor has the "lucky" feat or shield
        // master — those auto-reroll. By the time this hook fires the reroll
        // has already happened and the rolled result is what stands.
        const actor = data?.subject?.actor ?? data?.actor;

        // (B) END-TURN on fumble FIRST — synchronous, BEFORE the async fumble-
        //     table roll below — so the multiattack chain sees the mark + abort
        //     the instant the nat-1 lands, not after a 1d12 round-trip (Johnny
        //     2026-07-13: the pop-up raced open right after the fumble).
        if (endsTurn) FumbleEngine._endTurnOnFumble(actor);

        // (A) Fumble table card (optional, independent toggle).
        if (fumbleTable) await FumbleEngine._postFumble(actor);
      } catch (err) {
        console.warn(`${MODULE_ID} | FumbleEngine threw:`, err);
      }
    });

    console.debug(`${MODULE_ID} | FumbleEngine online`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Fumble ends the turn — hard house rule (opt-in)
  // ═══════════════════════════════════════════════════════════════════════════
  //
  //  A nat-1 on the ACTIVE combatant's OWN attack ends their turn NOW — no
  //  further attacks, bonus actions, or multiattack pop-up. Only the fumbler's
  //  OWN turn ends (an opportunity-attack fumble on someone else's turn does
  //  NOT skip that creature). Roll hooks are LOCAL to the roller, and only the
  //  GM can advance combat — so a player's fumble relays to the GM over the
  //  socket; a GM-rolled fumble advances directly.
  static _endTurnOnFumble(actor) {
    try {
      if (!actor) return;
      const combat = game.combat;

      // ── Stop the fumbler's multiattack UNCONDITIONALLY ──
      // A fumble ends their attacks, period. We do this BEFORE the turn guard so
      // an actor/token-id quirk in the tracker can never leave the pop-up
      // dangling (Johnny 2026-07-13: fumbleEndsTurn was ON but the pop-up stayed).
      // Both are harmless no-ops when there's no chain (e.g. a fumbled OA):
      //   • mark  → the roller-local chain consumes it before the NEXT offer.
      //   • abort → closes an ALREADY-open pop-up on the spot.
      CombatState.markMultiattackFumble(actor.id);
      try { Hooks.callAll(`${MODULE_ID}.multiattackAbort`, { actorId: actor.id }); } catch (_) { /* non-fatal */ }

      // Deselect the fumbler's token — a clean "you're out" cue on the roller's
      // screen (Johnny 2026-07-13). We deliberately DON'T clear the target: Johnny
      // decided the target reticle should stay up (2026-07-14). Per-client;
      // harmless if nothing is controlled.
      try { for (const t of (actor.getActiveTokens?.() ?? [])) t.release?.(); } catch (_) { /* non-fatal */ }

      // ── Advance the turn ONLY on the fumbler's OWN turn ──
      // An OA fumble on someone else's turn must NOT skip that creature.
      if (!combat?.started) return;
      const current = combat.combatant?.actor;
      if (!current || current.id !== actor.id) {
        console.debug(`${MODULE_ID} | Fumble: multiattack stopped, turn NOT advanced — active combatant is ${current?.name ?? "none"}, not the fumbler.`);
        return;
      }

      ui.notifications?.warn(`${actor.name} FUMBLED — turn ended.`);
      if (game.users?.activeGM === game.user) {
        FumbleEngine._advanceAfterFumble(actor.id);
      } else {
        try { game.socket.emit(`module.${MODULE_ID}`, { action: "fumbleEndTurn", actorId: actor.id }); }
        catch (err) { console.warn(`${MODULE_ID} | fumble socket relay failed:`, err); }
      }
    } catch (err) {
      console.warn(`${MODULE_ID} | FumbleEngine._endTurnOnFumble threw:`, err);
    }
  }

  /** activeGM-only: advance past the fumbler's turn after a short beat so the
   *  fumble card + "turn ended" toast register first. Re-checks the combatant
   *  right before advancing so nothing races the turn forward twice. */
  static _advanceAfterFumble(actorId) {
    if (game.users?.activeGM !== game.user) return;
    setTimeout(() => {
      try {
        const c = game.combat;
        if (c?.started && c.combatant?.actor?.id === actorId) c.nextTurn?.();
      } catch (err) { console.warn(`${MODULE_ID} | fumble turn-advance threw:`, err); }
    }, 750);
  }

  static async _postFumble(actor) {
    if (!actor) return;
    // Roll 1d12
    const tableRoll = new Roll("1d12");
    await tableRoll.evaluate();
    const rolled = tableRoll.total;
    const entry = FUMBLE_TABLE.find(e => rolled >= e.range[0] && rolled <= e.range[1]);
    if (!entry) return;

    // Animate the fumble die via the canonical safe helper
    safeShowForRoll(tableRoll, "fumble-table roll");

    await ChatMessage.create({
      speaker: ChatMessage.getSpeaker({ actor }),
      content: `<div class="ace-qol-fumble-card" style="background:linear-gradient(180deg,#2a0a0a 0%,#3a0e0e 100%);border:2px solid #c44;border-radius:6px;padding:10px 12px;">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:6px;">
          <i class="fas fa-skull" style="color:#c44;font-size:18px;"></i>
          <strong style="color:#ff8c8c;font-size:14px;text-transform:uppercase;letter-spacing:0.5px;">CRITICAL FUMBLE</strong>
          <span style="color:#aaa;font-size:11px;margin-left:auto;">d12 roll: ${rolled}</span>
        </div>
        <div style="color:#e0d0c0;font-size:13px;font-weight:600;">${entry.name}</div>
        <div style="color:#cfcfd0;font-size:12px;line-height:1.4;margin-top:4px;">${entry.desc}</div>
        <div style="color:#888;font-size:10px;margin-top:6px;font-style:italic;border-top:1px solid rgba(196,68,68,0.2);padding-top:5px;">
          GM may adjudicate severity — fumbles are not RAW. Disable in settings if your table doesn't use them.
        </div>
      </div>`,
      flags: { [MODULE_ID]: { type: "criticalFumble", actorId: actor.id, rolled, entryName: entry.name } },
    });
  }
}
