// ─── ACE: QOL — Hearing Gate ──────────────────────────────────────────────────
// RAW: some spells only work on a target that can HEAR the caster. A deafened
// creature simply can't receive them — no save, no effect, cast wasted. This
// module is the ONE list of those spells plus the pure check, consumed by:
//
//   • save-engine._onUseActivity  — the native save flow (Vicious Mockery,
//     Command, Dissonant Whispers cast through dnd5e)
//   • SpellPipeline._pickTargets  — pipeline-owned shapes (Suggestion et al.);
//     all targets deaf → picker returns null → the deferred slot REFUNDS
//   • the nullification registry  — a "Deafened" entry mirrors this list as
//     spellImmune so the damage-shape resolvers respect it uniformly
//
// Only spells with an EXPLICIT hearing clause in the text are listed —
// deterministic, defensible at the table. Power Word spells are deliberately
// absent (no "can hear you" clause in 2014 or 2024 text).
// ──────────────────────────────────────────────────────────────────────────────

import { MODULE_ID } from "../ace-qol.mjs";

/** Spell name (normalized) → the RAW clause that gates it. */
export const HEARING_CLAUSE_SPELLS = {
  "vicious mockery":    { clause: "…if the target can hear you (though it need not understand you)", source: "PHB — Vicious Mockery" },
  "dissonant whispers": { clause: "…a discordant melody that only one creature of your choice can hear", source: "PHB — Dissonant Whispers" },
  "suggestion":         { clause: "…a creature you can see that can hear and understand you", source: "PHB — Suggestion" },
  "mass suggestion":    { clause: "…creatures you can see that can hear and understand you", source: "PHB — Mass Suggestion" },
  "compulsion":         { clause: "…creatures of your choice that you can see and that can hear you", source: "PHB — Compulsion" },
  "enthrall":           { clause: "…all creatures of your choice that you can see and that can hear you", source: "PHB — Enthrall" },
  // Command has no literal "can hear" sentence, but "You speak a one-word
  // command" + the no-effect-if-it-doesn't-understand clause make hearing a
  // prerequisite; Sage Advice confirms a deafened target is unaffected.
  "command":            { clause: "You speak a one-word command… no effect if it doesn't understand your language", source: "PHB — Command (+ Sage Advice)" },
};

export class HearingGate {

  /** Normalize a spell name the same way the rules brain does — lowercase,
   *  decorations like "(1/Day)" or "[Legacy]" stripped. */
  static normalizeName(name) {
    return String(name ?? "")
      .replace(/\([^)]*\)/g, " ")
      .replace(/\[[^\]]*\]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  }

  /** The hearing-clause entry for this item, or null when hearing is irrelevant. */
  static requiresTargetHearing(item) {
    if (!item?.name) return null;
    return HEARING_CLAUSE_SPELLS[HearingGate.normalizeName(item.name)] ?? null;
  }

  /** Can this creature hear? (deafened status = no.) Pure — token or actor. */
  static isDeafened(actorOrToken) {
    const actor = actorOrToken?.actor ?? actorOrToken;
    const statuses = actor?.statuses;
    if (statuses instanceof Set) return statuses.has("deafened") || statuses.has("deaf");
    return false;
  }

  /**
   * Split a token list into { allowed, blocked, entry } for this spell.
   * When the spell has no hearing clause, everything is allowed (entry null).
   */
  static filterDeafTargets(item, tokens) {
    const entry = HearingGate.requiresTargetHearing(item);
    if (!entry) return { allowed: tokens ?? [], blocked: [], entry: null };
    const allowed = [], blocked = [];
    for (const t of tokens ?? []) {
      if (HearingGate.isDeafened(t)) blocked.push({ token: t, name: t?.name ?? t?.actor?.name ?? "target" });
      else allowed.push(t);
    }
    return { allowed, blocked, entry };
  }

  /** Dark explainer card: WHO couldn't hear the spell and the RAW clause why. */
  static async postBlockedCard(item, caster, blocked, entry) {
    if (!blocked?.length) return;
    const grey = "#9aa4ad";
    const rows = blocked.map(b => `
      <div style="display:flex;align-items:center;gap:10px;padding:6px 8px;background:rgba(154,164,173,0.08);border-radius:4px;margin-bottom:4px;">
        <i class="fas fa-ear-deaf" style="color:${grey};font-size:14px;"></i>
        <div style="flex:1;">
          <strong style="color:#e8d49a;">${foundry.utils.escapeHTML(b.name)}</strong>
          <span style="color:#c0b288;font-size:13px;"> — deafened; can't hear the caster</span>
        </div>
      </div>`).join("");

    const html = `
      <div style="background:linear-gradient(180deg,#1a1410 0%,#0f0a08 100%);
                  border:2px solid ${grey};border-radius:6px;padding:12px 14px;
                  color:#f0e4c0;font-family:'Signika','Helvetica Neue',sans-serif;
                  box-shadow:0 0 10px ${grey}33;">
        <div style="display:flex;align-items:center;gap:10px;font-size:15px;font-weight:700;
                    color:${grey};text-transform:uppercase;letter-spacing:0.6px;
                    border-bottom:1px solid #4a3a28;padding-bottom:6px;margin-bottom:8px;">
          <i class="fas fa-ear-deaf" style="font-size:16px;"></i>
          <span>${foundry.utils.escapeHTML(item.name)} — unheard</span>
        </div>
        <div style="font-size:13px;color:#c0b288;margin-bottom:8px;font-style:italic;">
          "${entry?.clause ?? "the target must be able to hear you"}" <span style="color:#8a7a5a;">(${entry?.source ?? "RAW"})</span>
        </div>
        ${rows}
      </div>`;

    try {
      await ChatMessage.create({
        speaker: ChatMessage.getSpeaker({ actor: caster }),
        content: html,
        flavor: `${item.name}: ${blocked.length} target${blocked.length === 1 ? "" : "s"} can't hear the caster`,
      });
    } catch (err) {
      console.warn(`${MODULE_ID} | hearing-gate card post failed:`, err);
    }
  }
}
