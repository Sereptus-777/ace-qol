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
//
// ⚠️ THROUGH THE DOORS (2026-09-19, his rule for this family: "That trigger runs
// with no button"). The damage went straight onto the attacker with
// applyDamage and the card was a plain chat message: no reactions asked (an
// Absorb Elements against the salamander's fire), no damage-applied signal, no
// UNDO. It lands through the hit-point door now, and the card through the card
// door once the dice are down, the same as every other damage in ACE.
// ───────────────────────────────────────────────────────────────────────────

import { MODULE_ID } from "./ace-qol.mjs";
import { aceWithinFt } from "./geometry-utils.mjs";
import { safeShowForRoll, awaitDiceSettle } from "./dsn-utils.mjs";

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

        // ⚠️ NOTHING LANDS BEFORE THE DICE (Johnny's rule): the damage came off the
        // attacker before these dice were even thrown (the card carrying them was
        // posted after). ACE throws them, they land, then the damage.
        safeShowForRoll(roll, `${ret.source} retaliation`);
        await awaitDiceSettle();

        // The attacker's resistances and immunities, then its reactions, then the door.
        const { HpDoor } = await import("./road/doors.mjs");
        let finals = HpDoor.preview(attacker, [{ amount: dealt, type: ret.type }], { item: feat });
        try {
          const { DamageApplicator } = await import("./damage-applicator.mjs");
          finals = await DamageApplicator._askDamageReactions(attacker, finals, {
            token: attackerToken ?? null, source: target, item: feat,
            where: `${ret.source} (${target.name})`,
          });
        } catch (err) {
          console.warn(`${MODULE_ID} | could not ask ${attacker.name}'s reactions about ${ret.source}, so it lands in full:`, err);
        }
        const landed = await HpDoor.damage(attacker, finals, {
          dice: true, item: feat, source: target, label: ret.source,
          tokenDocId: attackerToken?.document?.id ?? attackerToken?.id ?? null,
        });
        await RetaliationEngine._postCard(attacker, target, ret, roll, finals, landed);
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

  static async _postCard(attacker, target, ret, roll, finals = null, landed = null) {
    try {
      const color = TYPE_COLORS[ret.type] ?? "#d4af37";
      // What it came to on the attacker, after its resistances (the door's own sums).
      const took = Array.isArray(finals) ? finals.reduce((n, f) => n + (Number(f?.final) || 0), 0) : roll.total;
      const note = Array.isArray(finals)
        ? finals.map(f => f?.modifier === "immune" ? "immune" : f?.modifier === "resistant" ? "resisted"
          : f?.modifier === "vulnerable" ? "vulnerable" : "").filter(Boolean).join(", ")
        : "";
      const content = `
        <div style="border:1px solid ${color}55;border-left:3px solid ${color};border-radius:7px;
                    background:linear-gradient(160deg,#1a1410,#0d0a07);padding:9px 12px;color:#e9ddc1;">
          <div style="font-weight:700;color:${color};font-size:14px;letter-spacing:.3px;">
            <i class="fas fa-fire-flame-curved"></i> ${foundry.utils.escapeHTML(ret.source)}
          </div>
          <div style="font-size:16px;line-height:1.4;margin-top:3px;">
            <b>${foundry.utils.escapeHTML(attacker.name)}</b> takes
            <b style="color:${color};">${took} ${ret.type}</b> damage from
            <b>${foundry.utils.escapeHTML(target.name)}</b> (${ret.formula} = ${roll.total}${note ? `, ${note}` : ""}).
          </div>
          ${landed && landed.applied === false && took > 0
            ? `<div style="font-size:14px;color:#c0b288;margin-top:3px;">Nothing was taken off: only the GM's screen can change its hit points.</div>`
            : ""}
        </div>`;
      const { CardDoor } = await import("./road/doors.mjs");
      await CardDoor.post({
        content,
        speaker: ChatMessage.getSpeaker({ alias: target.name }),
        flags: { [MODULE_ID]: { type: "retaliation" } },
      }, { dice: true });
    } catch (err) {
      console.warn(`${MODULE_ID} | the ${ret?.source ?? "retaliation"} card could not be posted (the damage already landed):`, err);
    }
  }
}
