// ─── ACE: QOL — Hex / Hexblade's Curse Death Watch ────────────────────────────
// Punch-list #4 (live game 2026-06-28): when the hexed / cursed creature dies,
// the rules give the caster something — and ACE gave nothing.
//
// RAW, and they differ (the punch item lumped them together — they're not):
//   • HEX: "If the target dies while you're hexed, you can use a bonus action
//     on a subsequent turn of yours to curse a new creature." → we whisper the
//     caster a MOVE HEX card; the button opens the purple picker and re-applies
//     the hex to the new creature (CombatState.applyHex replaces = the move).
//   • HEXBLADE'S CURSE: the curse ENDS when the target dies and the warlock
//     "regains hit points equal to your warlock level + your Charisma modifier"
//     — no move. We auto-heal + announce, and clear the curse flag.
//
// Listens to ace-qol.npcDeath (activeGM client — the hook's own gate), whispers
// to the caster's owner + GM. Buttons are flag-wired (V13 renderChatMessage +
// renderChatMessageHTML both) and survive reloads.
// ──────────────────────────────────────────────────────────────────────────────

import { MODULE_ID } from "./ace-qol.mjs";
import { CombatState } from "./combat-state.mjs";

const GOLD = "#c9a76b";
const HEX_BLUE = "#88c0d0";
const CURSE_PURPLE = "#b388ff";

export class HexDeathWatch {

  static register() {
    Hooks.on(`${MODULE_ID}.npcDeath`, ({ actor, tokenDoc }) => {
      HexDeathWatch._onDeath(actor, tokenDoc).catch(err =>
        console.warn(`${MODULE_ID} | HexDeathWatch failed (non-fatal):`, err));
    });

    const wire = (message, html) => {
      try {
        const flags = message?.flags?.[MODULE_ID];
        if (flags?.type !== "hexMovePrompt") return;
        HexDeathWatch._wireMoveCard(message, html instanceof HTMLElement ? html : html?.[0]);
      } catch (_) { /* non-fatal */ }
    };
    Hooks.on("renderChatMessage", wire);       // V12
    Hooks.on("renderChatMessageHTML", wire);   // V13

    console.debug(`${MODULE_ID} | HexDeathWatch online — Hex moves, Hexblade's Curse heals, on target death`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Death handler (runs on the activeGM client via the npcDeath gate)
  // ═══════════════════════════════════════════════════════════════════════════

  static async _onDeath(deadActor, tokenDoc) {
    const deadUuid = tokenDoc?.uuid ?? null;
    if (!deadUuid) return;
    const deadName = tokenDoc?.name ?? deadActor?.name ?? "the target";

    for (const caster of game.actors) {
      // ── Hex: offer the RAW bonus-action move ──
      try {
        if (CombatState.getHexedTargetUuid(caster) === deadUuid) {
          await HexDeathWatch._postMovePrompt(caster, deadName);
        }
      } catch (err) {
        console.warn(`${MODULE_ID} | hex death check failed for ${caster.name}:`, err);
      }

      // ── Hexblade's Curse: auto-end + heal (RAW — no move exists) ──
      try {
        const cursedUuid = CombatState.getCursedTargetUuid?.(caster);
        if (cursedUuid && cursedUuid === deadUuid) {
          await HexDeathWatch._resolveCurseDeath(caster, deadName);
        }
      } catch (err) {
        console.warn(`${MODULE_ID} | hexblade-curse death check failed for ${caster.name}:`, err);
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Hexblade's Curse — end + regain HP (warlock level + CHA mod)
  // ═══════════════════════════════════════════════════════════════════════════

  static async _resolveCurseDeath(caster, deadName) {
    const warlockLevels = caster.items?.find(i => i.type === "class" && /warlock/i.test(i.name ?? ""))?.system?.levels ?? 0;
    const chaMod = Number(caster.system?.abilities?.cha?.mod ?? 0);
    const regain = Math.max(0, warlockLevels + chaMod);

    let healedTo = null;
    if (regain > 0) {
      const hp = caster.system?.attributes?.hp ?? {};
      const cur = Number(hp.value ?? 0), max = Number(hp.max ?? 0);
      healedTo = Math.min(max, cur + regain);
      try { await caster.update({ "system.attributes.hp.value": healedTo }); }
      catch (err) { console.warn(`${MODULE_ID} | curse-death heal failed:`, err); healedTo = null; }
    }

    try { await caster.unsetFlag(MODULE_ID, "hexbladeCurse"); } catch (_) { /* non-fatal */ }

    const casterName = foundry.utils.escapeHTML(caster.name);
    const tgt = foundry.utils.escapeHTML(deadName);
    await ChatMessage.create({
      speaker: ChatMessage.getSpeaker({ actor: caster }),
      content: `
        <div style="background:linear-gradient(180deg,#160a1e 0%,#0c0612 100%);border:2px solid ${CURSE_PURPLE};border-radius:6px;padding:10px 12px;color:#e8dff2;font-family:'Signika',sans-serif;">
          <div style="display:flex;align-items:center;gap:10px;font-weight:700;color:${CURSE_PURPLE};text-transform:uppercase;letter-spacing:0.5px;border-bottom:1px solid #3a2a4a;padding-bottom:5px;margin-bottom:6px;">
            <i class="fas fa-skull"></i><span>Hexblade's Curse — target slain</span>
          </div>
          <div style="font-size:14px;">
            <strong>${tgt}</strong> died under <strong>${casterName}</strong>'s curse. The curse ends
            ${healedTo != null
              ? `and ${casterName} <strong style="color:#8fe3a0;">regains ${regain} HP</strong> (warlock level + CHA).`
              : `(no hit points regained).`}
          </div>
        </div>`,
    });
    console.log(`${MODULE_ID} | Hexblade's Curse resolved on target death: ${caster.name} +${regain} HP`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Hex — the MOVE prompt card
  // ═══════════════════════════════════════════════════════════════════════════

  static async _postMovePrompt(caster, deadName) {
    const ownerIds = game.users
      .filter(u => u.isGM || caster.testUserPermission?.(u, "OWNER"))
      .map(u => u.id);

    const casterName = foundry.utils.escapeHTML(caster.name);
    const tgt = foundry.utils.escapeHTML(deadName);
    await ChatMessage.create({
      speaker: ChatMessage.getSpeaker({ actor: caster }),
      whisper: ownerIds,
      flags: { [MODULE_ID]: { type: "hexMovePrompt", casterActorId: caster.id, resolved: false } },
      content: `
        <div class="ace-qol-hex-move" style="background:linear-gradient(180deg,#0a141a 0%,#060d12 100%);border:2px solid ${HEX_BLUE};border-radius:6px;padding:10px 12px;color:#d8e4ec;font-family:'Signika',sans-serif;">
          <div style="display:flex;align-items:center;gap:10px;font-weight:700;color:${HEX_BLUE};text-transform:uppercase;letter-spacing:0.5px;border-bottom:1px solid #2a3a44;padding-bottom:5px;margin-bottom:6px;">
            <i class="fas fa-spider"></i><span>Hex — target slain</span>
          </div>
          <div style="font-size:14px;margin-bottom:8px;">
            <strong>${tgt}</strong> died while hexed. <strong>${casterName}</strong> can use a
            <strong>bonus action on a later turn</strong> to move the hex to a new creature
            (concentration must still be holding).
          </div>
          <div style="display:flex;gap:8px;">
            <button type="button" data-action="aceHexMove" style="flex:1;background:#12303a;border:1px solid ${HEX_BLUE};border-radius:4px;color:#d8f0fa;font-weight:700;padding:6px 8px;cursor:pointer;">
              <i class="fas fa-arrows-turn-to-dots"></i> Move Hex
            </button>
            <button type="button" data-action="aceHexEnd" style="flex:1;background:#241416;border:1px solid #7a4a4a;border-radius:4px;color:#e8c8c8;font-weight:700;padding:6px 8px;cursor:pointer;">
              <i class="fas fa-xmark"></i> Let It End
            </button>
          </div>
        </div>`,
    });
    console.log(`${MODULE_ID} | Hex move prompt posted for ${caster.name} (target died: ${deadName})`);
  }

  static _wireMoveCard(message, el) {
    if (!el?.querySelector) return;
    const flags = message.flags?.[MODULE_ID] ?? {};
    const moveBtn = el.querySelector('[data-action="aceHexMove"]');
    const endBtn = el.querySelector('[data-action="aceHexEnd"]');
    if (!moveBtn && !endBtn) return;

    const caster = game.actors.get(flags.casterActorId);
    const mayAct = game.user.isGM || (caster && caster.testUserPermission?.(game.user, "OWNER"));

    const markDone = (label) => {
      for (const b of [moveBtn, endBtn]) {
        if (!b) continue;
        b.disabled = true;
        b.style.opacity = "0.45";
        b.style.cursor = "default";
      }
      if (moveBtn) moveBtn.innerHTML = label;
    };

    if (flags.resolved) { markDone(`<i class="fas fa-check"></i> ${foundry.utils.escapeHTML(flags.resolvedLabel ?? "Resolved")}`); return; }
    if (!mayAct) { for (const b of [moveBtn, endBtn]) if (b) b.disabled = true; return; }

    moveBtn?.addEventListener("click", async (ev) => {
      ev.preventDefault(); ev.stopPropagation();
      try {
        if (!caster) return;
        // Hex's own flag may already be gone (concentration dropped) — honest gate.
        if (!CombatState.getHexedTargetUuid(caster)) {
          ui.notifications?.warn("The hex has already ended (concentration dropped) — nothing to move.");
          await message.update({ [`flags.${MODULE_ID}.resolved`]: true, [`flags.${MODULE_ID}.resolvedLabel`]: "Hex already ended" });
          return;
        }
        const { SpellTargetPicker } = await import("./spell-target-picker.mjs");
        const hexItem = caster.items?.find(i => i.type === "spell" && /^hex$/i.test((i.name ?? "").trim())) ?? null;
        const picked = await SpellTargetPicker.pick({
          spellItem: hexItem,
          casterActor: caster,
          maxTargets: 1,
          rangeFt: 90,          // Hex's cast range — RAW is silent on the move; sane default
          allowSelf: false,
        });
        const newActor = picked?.[0];
        if (!newActor) return;   // cancelled — card stays live
        const newToken = newActor.getActiveTokens?.()?.[0]
          ?? canvas.tokens?.placeables.find(t => t.actor?.id === newActor.id);
        if (!newToken) { ui.notifications?.warn("That creature has no token on this scene."); return; }
        const ok = await CombatState.applyHex(caster, newToken);   // replace = the move
        if (ok) {
          await message.update({ [`flags.${MODULE_ID}.resolved`]: true, [`flags.${MODULE_ID}.resolvedLabel`]: `Moved to ${newToken.name}` });
        }
      } catch (err) {
        console.error(`${MODULE_ID} | hex move failed:`, err);
        ui.notifications?.error("ACE QOL: hex move failed — see console.");
      }
    });

    endBtn?.addEventListener("click", async (ev) => {
      ev.preventDefault(); ev.stopPropagation();
      try {
        if (caster) await CombatState.removeHex(caster, { reason: "target died — caster let it end" });
        await message.update({ [`flags.${MODULE_ID}.resolved`]: true, [`flags.${MODULE_ID}.resolvedLabel`]: "Hex ended" });
      } catch (err) {
        console.warn(`${MODULE_ID} | hex end failed:`, err);
      }
    });
  }
}
