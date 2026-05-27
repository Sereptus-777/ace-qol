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
        if (!QolSettings.get?.("criticalFumbleEnabled")) return;
        const roll = Array.isArray(rolls) ? rolls[0] : rolls;
        if (!roll) return;
        // Detect natural 1: the d20 die's first result === 1
        const d20 = roll.dice?.find(d => d.faces === 20);
        if (!d20) return;
        const result = d20.results?.[0]?.result;
        if (result !== 1) return;
        // Note: dnd5e ALSO checks if the actor has the "lucky" feat or shield
        // master — those auto-reroll. By the time this hook fires the reroll
        // has already happened and the rolled result is what stands.
        await FumbleEngine._postFumble(data?.subject?.actor ?? data?.actor);
      } catch (err) {
        console.warn(`${MODULE_ID} | FumbleEngine threw:`, err);
      }
    });

    console.debug(`${MODULE_ID} | FumbleEngine online`);
  }

  static async _postFumble(actor) {
    if (!actor) return;
    // Roll 1d12
    const tableRoll = new Roll("1d12");
    await tableRoll.evaluate();
    const rolled = tableRoll.total;
    const entry = FUMBLE_TABLE.find(e => rolled >= e.range[0] && rolled <= e.range[1]);
    if (!entry) return;

    // Animate the fumble die
    // Full optional-chain protects against half-broken DSN state (renderer
    // exists but .showForRoll is undefined / non-thenable). Grok audit catch.
    try {
      game.dice3d?.showForRoll?.(tableRoll, game.user, true)?.catch?.(err => console.warn(`${MODULE_ID} | DSN fumble-table rejected (non-fatal):`, err?.message ?? err));
    } catch (_) {}

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
