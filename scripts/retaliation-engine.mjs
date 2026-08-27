// ─── ACE: QOL — Reactive Retaliation Traits ────────────────────────────────
// "Hit me in melee and you take damage" — Heated Body, Fire Shield, spiked
// armor, a fire elemental's body, a fire snake's Heated Body, etc.
//
// We deliberately do NOT match trait NAMES (homebrew renames them — your
// salamander's was "Heated Body", another's might be "Burning Fury" or "Molten
// Hide"). Instead we READ each feature's DESCRIPTION for the retaliation INTENT
// ("…hits it with a melee attack … takes N damage" / "a creature that touches
// it … takes N damage") and its damage, then apply that back to the attacker on
// a melee hit. Structured activity damage is preferred; we fall back to parsing
// the stat-block text. The attacker's own resistances/immunities are honoured
// (a fire-immune attacker takes 0 from Heated Body). (2026-06-24)
// ───────────────────────────────────────────────────────────────────────────

import { MODULE_ID } from "./ace-qol.mjs";
import { aceWithinFt } from "./geometry-utils.mjs";

const TYPE_COLORS = {
  fire: "#ff6b35", cold: "#7ec8ff", lightning: "#ffe066", acid: "#9ae66e",
  poison: "#9ae66e", necrotic: "#7d5fff", radiant: "#ffe9a8", psychic: "#ff6bd6",
  force: "#c0a0ff", thunder: "#ffb066", piercing: "#d0d0d0", slashing: "#d0d0d0",
  bludgeoning: "#d0d0d0",
};

export class RetaliationEngine {

  /**
   * Called once per HIT creature on a melee attack. If that creature has a
   * reactive "hit me → you take damage" trait, roll it and apply to the attacker.
   */
  static async checkOnHit({ attacker, attackerToken, target, targetToken, isMelee }) {
    try {
      if (!isMelee) return;                            // melee / touch retaliation only
      if (game.users?.activeGM !== game.user) return;  // single owner does the apply
      if (!attacker || !target) return;

      const seen = new Set();
      for (const feat of target.items ?? []) {
        if (feat.type !== "feat") continue;
        const ret = RetaliationEngine._parse(feat);
        if (!ret || seen.has(ret.source)) continue;
        seen.add(ret.source);

        // Range gate — RAW retaliation is "within N ft" (default 5). A reach
        // attacker standing outside that ring does NOT trigger it.
        if (attackerToken && targetToken && !aceWithinFt(attackerToken, targetToken, ret.range)) continue;

        let roll;
        try { roll = await new Roll(ret.formula).evaluate(); }
        catch (_) { continue; }                        // unparseable formula — skip safely
        const dealt = Math.max(0, Math.round(roll.total));
        if (dealt <= 0) continue;

        // applyDamage([{value,type}]) honours the ATTACKER's resistance/immunity.
        await attacker.applyDamage?.([{ value: dealt, type: ret.type }]);
        await RetaliationEngine._postCard(attacker, target, ret, roll);
      }
    } catch (err) {
      console.warn(`${MODULE_ID} | RetaliationEngine.checkOnHit failed (non-fatal):`, err);
    }
  }

  /**
   * Read a feature for a retaliation trait. Returns { formula, type, range, source }
   * or null. Reads the INTENT from the description; never the name.
   */
  static _parse(feat) {
    const desc = String(feat.system?.description?.value ?? "")
      .replace(/<[^>]+>/g, " ").replace(/&[a-z]+;/gi, " ").replace(/\s+/g, " ").trim();
    if (!desc) return null;

    // ── Retaliation INTENT ──
    const meleeHit = /hits?\s+(it|you|them|the\s+[\w'-]+)\b[^.]*\bwith\s+a\s+melee\s+(?:weapon\s+)?attack/i.test(desc);
    const touches  = /(?:a\s+creature\s+(?:that\s+)?)?touch(?:es|ing)?\b[^.]*\btakes?\b[^.]*\bdamage/i.test(desc);
    const dealsDmg = /\btakes?\b[^.]*\bdamage\b/i.test(desc);
    if (!(dealsDmg && (meleeHit || touches))) return null;

    // ── Damage — prefer STRUCTURED activity damage, then text ──
    let formula = null, type = null;
    for (const a of (feat.system?.activities ?? [])) {   // dnd5e activities Collection yields the activity objects directly
      const part = a?.damage?.parts?.[0];
      if (!part) continue;
      let f = part.formula;
      if (!f && part.number && part.denomination) {
        f = `${part.number}d${part.denomination}${part.bonus ? ` + ${part.bonus}` : ""}`;
      }
      if (!f && Array.isArray(part)) f = part[0];
      if (f) {
        formula = String(f);
        const t = part.types ?? part.type ?? (Array.isArray(part) ? part[1] : null);
        type = t ? (t instanceof Set ? [...t][0] : Array.isArray(t) ? t[0] : t) : null;
        break;
      }
    }
    if (!formula) {
      // e.g. "takes 7 (2d6) fire damage" → grab the (2d6) + "fire"
      const m = desc.match(/\(?(\d+\s*d\s*\d+(?:\s*\+\s*\d+)?)\)?\s*([a-z]+)\s+damage/i);
      if (m) { formula = m[1].replace(/\s+/g, ""); type = m[2].toLowerCase(); }
    }
    if (!formula) return null;

    // ── Range (default 5 feet) ──
    const rm = desc.match(/within\s+(\d+)\s*(?:ft|feet|foot)/i);
    return { formula, type: String(type ?? "fire").toLowerCase(), range: rm ? Number(rm[1]) : 5, source: feat.name };
  }

  static async _postCard(attacker, target, ret, roll) {
    try {
      const color = TYPE_COLORS[ret.type] ?? "#d4af37";
      const content = `
        <div style="border:1px solid ${color}55;border-left:3px solid ${color};border-radius:7px;
                    background:linear-gradient(160deg,#1a1410,#0d0a07);padding:9px 12px;color:#e9ddc1;">
          <div style="font-weight:700;color:${color};font-size:14px;letter-spacing:.3px;">
            <i class="fas fa-fire-flame-curved"></i> ${foundry.utils.escapeHTML(ret.source)}
          </div>
          <div style="font-size:13px;margin-top:3px;">
            <b>${foundry.utils.escapeHTML(attacker.name)}</b> takes
            <b style="color:${color};">${roll.total} ${ret.type}</b> damage from
            <b>${foundry.utils.escapeHTML(target.name)}</b> (${ret.formula}).
          </div>
        </div>`;
      await ChatMessage.create({
        content,
        speaker: ChatMessage.getSpeaker({ alias: target.name }),
        rolls: [roll],
        flags: { [MODULE_ID]: { type: "retaliation" } },
      });
    } catch (_) { /* non-fatal */ }
  }
}
