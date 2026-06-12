// ─── ACE: QOL — Banishment (RAW visuals) ─────────────────────────────────────
// When a creature fails its save vs Banishment, the "Banished" effect lands
// (incapacitated, can't be targeted). This layer adds the RAW visuals on top,
// driven by the EFFECT lifecycle so it works whether Banishment is cast as a
// spell OR used as a monster feature later:
//
//   • On banish   → hide the token from PLAYERS only (the eye toggle — the GM
//                   still sees it, greyed) + a GM-only chat card.
//   • On return   → un-hide it IN PLACE. RAW: when the spell ends early
//                   (concentration broken / dispelled) the creature reappears
//                   in the space it left.
//   • Full minute → RAW: if the spell runs its full duration the target is
//                   banished PERMANENTLY — it does NOT return; the token stays
//                   hidden and the GM is told (they can delete it).
//
// Detection: the effect ConditionLibrary applies carries
// flags.ace-qol.conditionKey === "banishment" (display name "Banished").
// ──────────────────────────────────────────────────────────────────────────────

import { MODULE_ID } from "./ace-qol.mjs";

const RETURN_FLAG = "banishReturn";   // remembers WE hid the token (so return restores exactly)

export const Banishment = {
  init() {
    Hooks.on("createActiveEffect", (effect) => {
      try { if (Banishment._isBanish(effect)) Banishment._onBanish(effect); }
      catch (err) { console.warn(`${MODULE_ID} | Banishment._onBanish threw:`, err); }
    });
    Hooks.on("deleteActiveEffect", (effect) => {
      try { if (Banishment._isBanish(effect)) Banishment._onReturn(effect); }
      catch (err) { console.warn(`${MODULE_ID} | Banishment._onReturn threw:`, err); }
    });
  },

  _isBanish(effect) {
    if (!effect) return false;
    if (effect.getFlag?.(MODULE_ID, "conditionKey") === "banishment") return true;
    return /^banished$/i.test(String(effect.name ?? "").trim());
  },

  /** Resolve the placeable token(s) carrying this effect's actor. */
  _tokensForEffect(effect) {
    const actor = effect?.parent;
    if (!actor) return [];
    if (actor.token?.object) return [actor.token.object];   // unlinked synthetic actor → its token
    return actor.getActiveTokens?.() ?? [];                 // linked actor → all its tokens
  },

  async _onBanish(effect) {
    if (game.users?.activeGM !== game.user) return;         // one client mutates + posts
    const actor  = effect?.parent;
    const tokens = Banishment._tokensForEffect(effect);
    for (const t of tokens) {
      const td = t.document;
      if (!td) continue;
      try {
        // Record whether WE hid it (vs the GM already having it hidden), so the
        // return restores exactly and never un-hides something the GM hid.
        await td.setFlag(MODULE_ID, RETURN_FLAG, { weHid: td.hidden !== true });
        if (td.hidden !== true) await td.update({ hidden: true });
      } catch (_) { /* non-fatal */ }
    }
    await Banishment._postCard(actor, tokens[0], "banished");
  },

  async _onReturn(effect) {
    if (game.users?.activeGM !== game.user) return;
    // Re-cast replacement (SaveResolver deletes the old effect before applying a
    // fresh one) — NOT a real return; skip so the token doesn't flicker.
    if (effect.getFlag?.(MODULE_ID, "_replacedNotEnded")) return;

    const actor  = effect?.parent;
    const tokens = Banishment._tokensForEffect(effect);

    // RAW: a spell that ran its FULL duration banishes permanently — no return.
    // We detect that as "no time remaining" at the moment it ends; anything
    // ending early (concentration broken, dispel, manual) returns the creature.
    const rem = effect?.duration?.remaining;
    const permanent = (rem != null && rem <= 0);

    if (permanent) {
      for (const t of tokens) { try { await t.document?.unsetFlag(MODULE_ID, RETURN_FLAG); } catch (_) {} }
      await Banishment._postCard(actor, tokens[0], "permanent");
      return;   // leave the token hidden — GM decides whether to delete it
    }

    for (const t of tokens) {
      const td = t.document;
      if (!td) continue;
      try {
        const mark = td.getFlag(MODULE_ID, RETURN_FLAG);
        if (mark?.weHid && td.hidden === true) await td.update({ hidden: false });
        await td.unsetFlag(MODULE_ID, RETURN_FLAG);
      } catch (_) { /* non-fatal */ }
    }
    await Banishment._postCard(actor, tokens[0], "returned");
  },

  async _postCard(actor, token, phase) {
    try {
      const name = token?.name ?? actor?.name ?? "The target";
      const cfg = {
        banished:  { icon: "🌀", title: "Banished",
                     line: `<b>${name}</b> is banished to a harmless demiplane — incapacitated and out of reach until the spell ends.` },
        returned:  { icon: "✨", title: "Returned",
                     line: `<b>${name}</b> snaps back into the space it left as the banishment ends.` },
        permanent: { icon: "⛓️", title: "Banished — Permanently",
                     line: `The banishment held for the full minute. <b>${name}</b> does not return (RAW). Its token is left hidden — delete it when you're ready.` },
      }[phase];
      if (!cfg) return;
      const content = `
<div style="background:#15101c;border:1px solid #ab47bc;border-radius:8px;padding:11px 13px;color:#f0e6f7;font-size:15px;line-height:1.5;">
  <div style="display:flex;align-items:center;gap:9px;border-bottom:1px solid #6a3a78;padding-bottom:7px;margin-bottom:7px;">
    <span style="font-size:22px;line-height:1;">${cfg.icon}</span>
    <div style="font-weight:700;color:#e0a9f0;font-size:16px;">${cfg.title}</div>
  </div>
  <div>${cfg.line}</div>
  <div style="font-size:12px;color:#a98ab8;margin-top:7px;">GM only · players don't see the banished token.</div>
</div>`;
      await ChatMessage.create({
        content,
        speaker: ChatMessage.getSpeaker({ actor }),
        whisper: ChatMessage.getWhisperRecipients("GM"),
      });
    } catch (err) {
      console.warn(`${MODULE_ID} | Banishment._postCard threw:`, err);
    }
  },
};
