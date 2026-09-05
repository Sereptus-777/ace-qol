// ─── ACE: QOL — an emanation that heals, offered again each turn ─────────────
//
// ⚠️🔴 AURA OF VITALITY DID NOTHING AT ALL. Its registry entry said
// `shape: "aura"`, which dispatches to the aura engine — and the aura engine
// knows exactly five things, all of them paladin CLASS FEATURES: Protection,
// Warding, Courage, Hate and the Guardian. It has never heard of a spell. So the
// cast reached an owner that could not accept it, nothing resolved, and the only
// trace was one console warning nobody reads.
//
// I told Johnny on 2026-09-04 that the aura engine measured its thirty feet.
// That was wrong, and it was wrong in the direction that matters: I reported a
// dead spell as working.
//
// ⚠️ AN EMANATION IS NOT A TEMPLATE. It is centred on the caster and moves with
// them, so there is nothing to place and nothing to leave behind. Measuring the
// radius from the caster at the moment it is used is the whole of the geometry.
//
// ⚠️ AND IT IS OFFERED, NEVER TAKEN. The spell says the caster restores hit
// points to one creature in it — which one, and whether to bother this turn, is
// their decision. So ACE posts a button and waits, the same way it pauses for a
// check rather than deciding one.
// ──────────────────────────────────────────────────────────────────────────────

const MODULE_ID = "ace-qol";
const LOG = "ace-qol | Emanation";

/** Flag written on the caster while an emanation is live. */
const FLAG = "emanationHeal";

export class EmanationResolver {

  /**
   * Cast: mark the caster, and offer the first use straight away.
   *
   * ⚠️ THE FIRST OFFER IS PART OF THE RULE IN 2024. "When you create it and at
   * the start of each of your turns" — so the cast itself is a use, and a
   * version that only offered it from the next turn would quietly cost the
   * caster one heal every time.
   */
  static async runHeal(ctx) {
    const { item, actor, entry, castLevel, spellMod } = ctx ?? {};
    if (!actor || !item) return;

    const radius = Number(entry?.emanation?.radiusFt) || 30;
    const formula = entry?.heal?.formula?.(castLevel, spellMod) ?? "2d6";

    try {
      await actor.setFlag(MODULE_ID, FLAG, {
        itemUuid: item.uuid,
        name: item.name,
        radius,
        formula,
        // ⚠️ WHEN IT IS OFFERED DIFFERS BY EDITION. 2014 spends a BONUS ACTION
        // on a later turn; 2024 gives it at creation and at the start of each of
        // your turns. Both end up as "offer it once a turn", but the card says
        // which so the player knows what it costs them.
        cost: entry?.emanation?.cost ?? "bonus action",
        startedAt: Number(game.time?.worldTime ?? 0),
      });
    } catch (err) {
      console.error(`${LOG} | could not mark ${actor.name} as carrying ${item.name}:`, err);
      ui.notifications?.error(`${item.name} could not start — see the console.`);
      return;
    }

    console.log(`${LOG} | ${actor.name} is radiating ${item.name}: ${radius} ft, ${formula} per use, `
      + `${entry?.emanation?.cost ?? "bonus action"}.`);
    await EmanationResolver.offer(actor);
  }

  /** Post the "heal someone in it" card for this caster. */
  static async offer(actor) {
    try {
      const live = actor?.getFlag?.(MODULE_ID, FLAG);
      if (!live) return;
      const esc = foundry.utils.escapeHTML;
      await ChatMessage.create({
        speaker: ChatMessage.getSpeaker({ actor }),
        whisper: EmanationResolver._whisperTo(actor),
        content:
          `<div style="background:#141118;border:1px solid #c9a76b55;border-left:3px solid #c9a76b;`
          + `border-radius:4px;padding:9px 11px;color:#e8dcc3;">`
          + `<div style="font-size:18px;font-weight:700;line-height:1.3;">${esc(actor.name)}</div>`
          + `<div style="font-size:16px;margin-top:2px;">${esc(live.name)} — `
          + `${esc(String(live.radius))} ft emanation</div>`
          + `<div style="font-size:14px;opacity:0.85;margin-top:4px;line-height:1.35;">`
          + `Restore ${esc(live.formula)} hit points to one creature in it `
          + `(${esc(live.cost)}).</div>`
          + `<button type="button" data-ace-emanation="${esc(actor.id)}" `
          + `style="margin-top:8px;width:100%;font-size:16px;padding:6px 8px;">`
          + `<i class="fa-solid fa-heart"></i> Heal someone in it</button>`
          + `</div>`,
        flags: { [MODULE_ID]: { emanationOffer: true, actorId: actor.id } },
      });
    } catch (err) {
      console.error(`${LOG} | could not offer ${actor?.name}'s emanation:`, err);
    }
  }

  /**
   * ⚠️ WHISPERED TO WHOEVER OWNS THE CREATURE, not to the table. It is a button
   * only one person can press, and a public one every round is noise.
   */
  static _whisperTo(actor) {
    try {
      const ids = game.users
        .filter(u => u.active && (u.isGM || actor.testUserPermission?.(u, "OWNER")))
        .map(u => u.id);
      return ids.length ? ids : [game.user.id];
    } catch (_) { return [game.user.id]; }
  }

  /** The button: pick one creature inside the emanation, heal them. */
  static async use(actor) {
    const live = actor?.getFlag?.(MODULE_ID, FLAG);
    if (!live) {
      ui.notifications?.info(`${actor?.name ?? "That creature"} is not radiating anything.`);
      return;
    }

    const casterToken = actor.getActiveTokens?.()?.[0]
      ?? canvas.tokens?.placeables.find(t => t.actor?.id === actor.id) ?? null;
    if (!casterToken) {
      ui.notifications?.warn(`${actor.name} has no token on this scene, so the emanation `
        + `has no centre to measure from.`);
      return;
    }

    // ⚠️ MEASURED WITH THE SUITE'S OWN READER. `aceWithinFt` knows about token
    // size, elevation and the document lagging its own move; a plain centre-to-
    // centre distance here would disagree with every other range in ACE.
    let inside = [];
    try {
      const { aceWithinFt } = await import("../../geometry-utils.mjs");
      inside = (canvas.tokens?.placeables ?? [])
        .filter(t => t?.actor && aceWithinFt(casterToken, t, live.radius));
    } catch (err) {
      console.error(`${LOG} | could not measure the emanation:`, err);
      ui.notifications?.error(`${live.name}: could not work out who is inside it.`);
      return;
    }
    if (!inside.length) {
      ui.notifications?.info(`${live.name}: nobody is inside it.`);
      return;
    }

    const item = await fromUuid(live.itemUuid).catch(() => null);
    let chosen = [];
    try {
      const { SpellTargetPicker } = await import("../../spell-target-picker.mjs");
      chosen = await SpellTargetPicker.pick({
        spellItem: item ?? { name: live.name },
        casterActor: actor,
        maxTargets: 1,
        allowSelf: true,
        only: inside,
        verb: "Heal",
        icon: "fa-solid fa-heart",
      });
    } catch (err) {
      console.error(`${LOG} | ${live.name}: the picker failed:`, err);
      return;
    }
    if (!chosen?.length) return;                 // cancelled — nothing spent

    const target = chosen[0];
    try {
      const roll = await new Roll(live.formula, actor.getRollData?.() ?? {}).evaluate();
      const { safeShowForRoll, awaitDiceSettle } = await import("../../dsn-utils.mjs");
      safeShowForRoll(roll, `${actor.name} ${live.name}`);
      await awaitDiceSettle();

      const hp = target.system?.attributes?.hp ?? {};
      const before = Number(hp.value) || 0;
      const max = Number(hp.max) || 0;
      const healed = Math.max(0, Math.min(max, before + roll.total) - before);
      await target.update({ "system.attributes.hp.value": before + healed });

      const esc = foundry.utils.escapeHTML;
      const { CheckGate } = await import("../../check-gate.mjs");
      await CheckGate._postCard({
        actor, roll, flag: "emanationHeal", label: live.name,
        title: live.name,
        subtitle: `<span>${esc(live.name)} &rarr; ${esc(target.name)}</span>`,
        // ⚠️ THE HEALING, NOT THE ROLL. Six hit points rolled on a creature one
        // below full restores one, and saying eight would be a lie the table
        // could act on.
        extra: `<div style="font-size:16px;margin-top:6px;color:#7ee081;font-weight:700;">`
          + `${esc(target.name)} regains ${esc(String(healed))}`
          + (healed !== roll.total ? ` <span style="opacity:0.8;font-weight:400;">`
              + `(capped at full hit points)</span>` : "")
          + `</div>`,
      });
      console.log(`${LOG} | ${actor.name} healed ${target.name} for ${healed} with ${live.name}.`);
    } catch (err) {
      console.error(`${LOG} | ${live.name}: the heal failed:`, err);
      ui.notifications?.error(`${live.name} could not heal — see the console.`);
    }
  }

  /** Stop radiating: concentration dropped, duration over, or the effect removed. */
  static async end(actor, why = "it ended") {
    try {
      if (!actor?.getFlag?.(MODULE_ID, FLAG)) return;
      const live = actor.getFlag(MODULE_ID, FLAG);
      await actor.unsetFlag(MODULE_ID, FLAG);
      console.log(`${LOG} | ${actor.name} stops radiating ${live?.name ?? "an emanation"} (${why}).`);
    } catch (err) {
      console.warn(`${LOG} | could not stop ${actor?.name}'s emanation:`, err);
    }
  }

  static register() {
    // ── Offer it again at the start of the caster's turn ──
    //
    // ⚠️ `combatTurnChange` GIVES THE NEW TURN; `combatTurn` DOES NOT. Foundry
    // calls combatTurn BEFORE the update, so combat.combatant there still
    // describes the turn that is ENDING — six ACE listeners once acted on the
    // wrong creature that way.
    Hooks.on("combatTurnChange", (combat, prior, current) => {
      try {
        if (game.users?.activeGM !== game.user) return;
        const id = current?.combatantId ?? combat?.combatant?.id;
        const actor = combat?.combatants?.get?.(id)?.actor;
        if (!actor?.getFlag?.(MODULE_ID, FLAG)) return;
        EmanationResolver.offer(actor)
          .catch(err => console.warn(`${LOG} | turn offer failed:`, err));
      } catch (err) {
        console.warn(`${LOG} | turn hook failed:`, err);
      }
    });

    // ── The button ──
    // Registered through ACE's own chat handler, which also SWEEPS cards that
    // were already drawn. A plain renderChatMessage listener leaves every card
    // above the fold decorated by nobody, forever.
    import("../../chat-render-utils.mjs")
      .then(({ registerChatCardHandler }) => {
        registerChatCardHandler((message, html) => {
          try {
            const root = html instanceof HTMLElement ? html : html?.[0];
            for (const btn of (root?.querySelectorAll?.("[data-ace-emanation]") ?? [])) {
              if (btn.dataset.aceWired === "1") continue;
              btn.dataset.aceWired = "1";
              btn.addEventListener("click", async (ev) => {
                ev.preventDefault();
                const actor = game.actors.get(btn.dataset.aceEmanation);
                if (!actor) return;
                await EmanationResolver.use(actor);
              });
            }
          } catch (err) {
            console.warn(`${LOG} | could not wire an emanation button:`, err);
          }
        }, "emanation offers", { sweepAll: true });
      })
      .catch(err => console.error(`${LOG} | could not register the emanation button:`, err));

    // ── It ends when its concentration does ──
    Hooks.on("deleteActiveEffect", (effect) => {
      try {
        if (game.users?.activeGM !== game.user) return;
        const actor = effect?.parent;
        if (!actor?.getFlag?.(MODULE_ID, FLAG)) return;
        const live = actor.getFlag(MODULE_ID, FLAG);
        const name = String(effect?.name ?? "").toLowerCase();
        const isConc = !!effect?.statuses?.has?.("concentrating");
        if (!isConc && !name.includes(String(live?.name ?? "").toLowerCase())) return;
        EmanationResolver.end(actor, "concentration ended").catch(() => {});
      } catch (err) {
        console.warn(`${LOG} | end hook failed:`, err);
      }
    });

    console.debug(`${LOG} | online — emanations offer their use each turn`);
  }
}
