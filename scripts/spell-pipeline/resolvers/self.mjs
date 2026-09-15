// ─── ACE: QOL — Pipeline Resolver: Self ───────────────────────────────────────
// Self spells put their effect on the caster directly, with no picker: Mage
// Armor, Shield, Mirror Image, Blur, Foresight, Fly and the rest the registry
// shapes as "self".
//
// THE ONE ROAD, PHASE 4 (2026-09-15): what goes on is the recipe's own effect,
// found on the spell's book entry or the item, and it goes on through the
// condition door (the 2024 Mage Armor's "Mage Armor", eight hours). A spell whose
// recipe names no effect of its own (the book's Shield has none) gets the
// registry's library effect, through the same door, and the console says which.
// The card goes through the card door.
//
// ⚠️ ONLY THE RECIPE'S OWN EFFECTS, NEVER A CONDITION READ FROM ITS WORDS. The
// 2024 Mirror Image's recipe reads "blinded" out of its text (the duplicates are
// not fooled by a creature that cannot see), and landing that on the caster would
// blind the wizard who cast it.
// ──────────────────────────────────────────────────────────────────────────────

import { MODULE_ID } from "../../ace-qol.mjs";
import { ConditionDoor, CardDoor } from "../../road/doors.mjs";

const SECONDS = { round: 6, turn: 6, minute: 60, hour: 3600, day: 86400 };

export class SelfResolver {

  /**
   * Run a self-shape spell: its effect on the caster.
   * @param {object} ctx - { entry, item, actor, activity, castLevel, ... }
   */
  static async run(ctx) {
    const { entry, item, actor, activity, castLevel } = ctx;
    if (!actor) return;

    let rows = [];
    try {
      rows = await SelfResolver._ownEffects(item, activity, actor, castLevel);
    } catch (err) {
      console.warn(`${MODULE_ID} | SelfResolver: could not read "${item.name}"'s own effects, so the registry's is used:`, err);
    }

    const landed = [];
    if (rows.length) {
      for (const fx of rows) {
        const res = await ConditionDoor.applyItemEffect(item, actor, fx, {
          outcome: "success", caster: actor, castLevel, durationSeconds: SelfResolver._durationSeconds(item),
        });
        if (res.ok) landed.push(fx.name);
        else console.warn(`${MODULE_ID} | SelfResolver: "${fx.name}" did not go on ${actor.name}: ${res.error}`);
      }
    } else {
      const effectKey = entry.effect?.key;
      if (effectKey) {
        // The registry's own, through the same door: its recipe names no effect.
        const out = await ConditionDoor.apply(actor, effectKey, { castLevel, spellItem: item, spellLevel: castLevel });
        if (out?.ok) landed.push(item.name);
        console.log(`${MODULE_ID} | SelfResolver: "${item.name}" names no effect of its own, so ACE's "${effectKey}" `
          + `${out?.ok ? "went on" : "did not go on"} ${actor.name}.`);
      } else {
        console.warn(`${MODULE_ID} | SelfResolver: "${item.name}" names no effect of its own and its registry entry has `
          + `none either; nothing was put on ${actor.name}.`);
      }
    }

    await SelfResolver._postChatCard(item, actor, castLevel, entry, landed);
  }

  /** The effects the recipe names for this cast, found on the book's entry or the item. */
  static async _ownEffects(item, activity, actor, castLevel) {
    const { recipeForActivity, loadBookFor } = await import("../../inference/recipe.mjs");
    await loadBookFor(item, { actor });
    const recipe = recipeForActivity(item, activity, { actor })?.recipe ?? null;
    const named = (recipe?.onSuccess ?? []).filter(o => o?.kind === "effect");
    if (!named.length) return [];
    const { SaveEngine } = await import("../../save-engine.mjs");
    // Any activity's effects, not only a save's: a self buff's is a utility.
    const found = SaveEngine._effectRowsFor(recipe, item, castLevel, { types: null });
    return named.map(o => found.here.get(String(o.condition?.key ?? ""))).filter(Boolean);
  }

  /** The spell's duration in seconds, for an effect that states none of its own. */
  static _durationSeconds(item) {
    const d = item?.system?.duration ?? {};
    const per = SECONDS[String(d.units ?? "").toLowerCase()];
    const n = Number(d.value) || 0;
    return per && n > 0 ? per * n : null;
  }

  static async _postChatCard(item, actor, castLevel, entry, landed) {
    const accent = "#c9a76b";
    const esc = (s) => foundry.utils.escapeHTML(String(s ?? ""));
    const flavor = landed.length
      ? (entry.flavorOnConfirm || `${actor.name} casts ${item.name} on themselves.`)
      : `${item.name}: nothing went on ${actor.name}. The console has why.`;
    const html = `
      <div style="background:linear-gradient(180deg,#1a1410 0%,#0f0a08 100%);
                  border:2px solid ${accent};
                  border-radius:6px;
                  padding:12px 14px;
                  color:#f0e4c0;
                  font-family:'Signika','Helvetica Neue',sans-serif;">
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;
                    font-size:15px;font-weight:700;color:${accent};
                    text-transform:uppercase;letter-spacing:0.6px;
                    border-bottom:1px solid #4a3a28;
                    padding-bottom:6px;margin-bottom:8px;">
          <img src="${item.img || "icons/svg/spell.svg"}" style="width:24px;height:24px;border-radius:3px;object-fit:cover;" />
          <span style="overflow-wrap:anywhere;">${esc(item.name.toUpperCase())}${castLevel > (item.system?.level ?? 1) ? ` (L${castLevel})` : ""}</span>
        </div>
        <div style="font-size:15px;line-height:1.5;color:#f0e4c0;">
          <strong style="color:#e8d49a;">${esc(actor.name)}</strong> ${esc(flavor.replace(`${actor.name}`, "").trim() || "is affected.")}
        </div>
      </div>
    `;
    try {
      await CardDoor.post({ speaker: ChatMessage.getSpeaker({ actor }), content: html, flavor });
    } catch (err) {
      console.warn(`${MODULE_ID} | SelfResolver: the card could not be posted; the effect still went on:`, err);
    }
  }
}
