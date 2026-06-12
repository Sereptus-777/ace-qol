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
  // "Banish" legendary-action in-flight state — armed when the feature is used,
  // consumed by the next failed save (the feature is single-target).
  _banishArmed: null,

  init() {
    Hooks.on("createActiveEffect", (effect) => {
      try { if (Banishment._isBanish(effect)) Banishment._onBanish(effect); }
      catch (err) { console.warn(`${MODULE_ID} | Banishment._onBanish threw:`, err); }
    });
    Hooks.on("deleteActiveEffect", (effect) => {
      try { if (Banishment._isBanish(effect)) Banishment._onReturn(effect); }
      catch (err) { console.warn(`${MODULE_ID} | Banishment._onReturn threw:`, err); }
    });

    // ── The "Banish" legendary action (≠ the Banishment spell) ──
    // It deals 3d6 force + a SHORT banish until the start of the user's next
    // turn. The save + damage ride the generic save path; we add the banish
    // visuals by arming on use and applying a short Banished effect to whoever
    // fails the save, then returning them when the user's turn comes around.
    Hooks.on("dnd5e.postCreateUsageMessage", (activity) => {
      try { Banishment._armBanishFeature(activity); }
      catch (err) { console.warn(`${MODULE_ID} | Banishment._armBanishFeature threw:`, err); }
    });
    Hooks.on(`${MODULE_ID}.saveComplete`, (payload) => {
      try { Banishment._onBanishFeatureSave(payload); }
      catch (err) { console.warn(`${MODULE_ID} | Banishment._onBanishFeatureSave threw:`, err); }
    });
    Hooks.on("updateCombat", (combat, changed) => {
      try { if (("turn" in changed) || ("round" in changed)) Banishment._returnShortBanishOnUserTurn(combat); }
      catch (err) { console.warn(`${MODULE_ID} | Banishment._returnShortBanishOnUserTurn threw:`, err); }
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

    // RAW: a SPELL that ran its FULL duration banishes permanently — no return.
    // We detect that as "no time remaining" when it ends; anything ending early
    // (concentration broken, dispel, manual) returns the creature. The "Banish"
    // legendary action (banishShort) ALWAYS returns — never permanent.
    const isShort = effect.getFlag?.(MODULE_ID, "banishShort") === true;
    const rem = effect?.duration?.remaining;
    const permanent = !isShort && (rem != null && rem <= 0);

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

  // ── "Banish" legendary action: short banish on a failed save ─────────────────

  /** Arm when the "Banish" FEATURE is used (the spell "Banishment" is the pipeline's). */
  _armBanishFeature(activity) {
    if (game.users?.activeGM !== game.user) return;
    const item = activity?.item;
    if (!item || item.type !== "feat") return;
    const nm = String(item.name ?? "");
    // \bbanish\b matches "Banish" / "Banish (Recharge 5-6)" but NOT "Banishment".
    if (!/\bbanish\b/i.test(nm) || /banishment/i.test(nm)) return;
    const userActor = item.actor;
    const userToken = userActor?.token?.object ?? userActor?.getActiveTokens?.()?.[0] ?? null;
    let targetIds = [];
    try { targetIds = [...(game.user?.targets ?? [])].map(t => t.document?.id ?? t.id).filter(Boolean); } catch (_) {}
    Banishment._banishArmed = {
      userActorId: userActor?.id ?? null,
      userTokenId: userToken?.document?.id ?? userToken?.id ?? null,
      targetIds,
      until: Date.now() + 12000,   // 12s window — the NPC save auto-rolls right after
    };
  },

  /** A save just resolved — if a Banish is armed and this one FAILED, banish them. */
  async _onBanishFeatureSave(payload) {
    if (game.users?.activeGM !== game.user) return;
    const armed = Banishment._banishArmed;
    if (!armed) return;
    if (Date.now() > armed.until) { Banishment._banishArmed = null; return; }
    if (payload?.passed !== false) return;                 // only a FAILED save banishes
    const targetActor = payload.actor;
    const tokenDocId  = payload.tokenDocId;
    if (!targetActor || !tokenDocId) return;
    if (armed.targetIds?.length && !armed.targetIds.includes(tokenDocId)) return; // wrong target
    Banishment._banishArmed = null;                        // single-target: consume the arm
    await Banishment._applyShortBanish(targetActor, armed);
  },

  /** Apply the short Banished effect — reuses the effect-lifecycle visuals. */
  async _applyShortBanish(targetActor, armed) {
    try {
      if (targetActor.effects?.some(e => e.getFlag?.(MODULE_ID, "banishShort"))) return; // already banished
      await targetActor.createEmbeddedDocuments("ActiveEffect", [{
        name: "Banished",
        img: "icons/magic/movement/portal-vortex-orange.webp",
        statuses: ["incapacitated"],
        duration: { rounds: 2 },               // fallback expiry if the banisher dies before its turn
        flags: { [MODULE_ID]: {
          conditionKey: "banishment",          // → _onBanish hides the token + posts the card
          banishShort: true,                   // returns on the user's next turn; never permanent
          banishUserTokenId: armed.userTokenId,
          banishUserActorId: armed.userActorId,
        } },
      }]);
    } catch (err) { console.warn(`${MODULE_ID} | Banishment._applyShortBanish threw:`, err); }
  },

  /** At the start of the BANISHING creature's next turn, its victims return. */
  _returnShortBanishOnUserTurn(combat) {
    if (game.users?.activeGM !== game.user) return;
    const cur = combat?.combatant;
    if (!cur) return;
    const curTokenId = cur.tokenId ?? cur.token?.id ?? null;
    const curActorId = cur.actor?.id ?? null;
    for (const t of (canvas.tokens?.placeables ?? [])) {
      const eff = t.actor?.effects?.find?.(e => e.getFlag?.(MODULE_ID, "banishShort"));
      if (!eff) continue;
      const uTok = eff.getFlag(MODULE_ID, "banishUserTokenId");
      const uAct = eff.getFlag(MODULE_ID, "banishUserActorId");
      if ((uTok && uTok === curTokenId) || (uAct && uAct === curActorId)) {
        // The user's turn has started → remove the effect → _onReturn un-hides
        // it in place (banishShort has no duration → never the "permanent" path).
        eff.delete().catch(() => {});
      }
    }
  },
};
