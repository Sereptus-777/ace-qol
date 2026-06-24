// ─── ACE: QOL — Condition RAW Enforcement Hooks ─────────────────────────────
// Some spell-applied conditions have RAW interactions that an Active Effect
// alone can't enforce — they react to *events* the GM/players don't think to
// manually trigger:
//
//   • Sleep        — "the sleeper wakes if it takes damage" (PHB 277).
//   • Charm Person — "the spell ends if the charmer harms it" (PHB 221).
//   • Suggestion   — "if the activity could harm the target, the spell ends"
//                    (PHB 280). We treat "the caster damages the target"
//                    as the closest mechanical proxy.
//   • Dominate Person / Monster — "each time the target takes damage, it
//                    makes a new save; on a success the spell ends" (PHB 235).
//   • Geas         — "the target takes 5d10 psychic damage when it acts
//                    against the geas" (PHB 244). RAW arbitrates "acted
//                    against" via the GM; we surface a one-click GM card.
//
// One `dnd5e.preApplyDamage` hook handles all of them. Walks the actor's
// effects, matches by `flags.ace-qol.conditionKey`, fires the right RAW
// reaction. Caster identity is read from the effect's `origin` UUID
// (set by SaveResolver when the spell lands).
//
// activeGM-gated — the hook fires on every client; we only want one client
// performing the state change. Matches the pattern in concentration-damage.mjs
// and the multi-GM safety audit (2026-06-15).
// ──────────────────────────────────────────────────────────────────────────────

import { MODULE_ID } from "./ace-qol.mjs";
import { QolSettings } from "./settings.mjs";

export class ConditionRawHooks {

  static init() {
    Hooks.on("dnd5e.preApplyDamage", async (actor, amount, updates, options) => {
      try {
        if (game.users?.activeGM !== game.user) return;
        if (!actor) return;
        if (!Number.isFinite(amount) || amount <= 0) return;     // skip healing / no-op hits

        // Resolve the source actor (the one dealing damage), if discoverable
        // from the dnd5e payload. dnd5e's options shape varies a little
        // across 5.x point releases — read whatever's there defensively.
        const sourceActor = ConditionRawHooks._resolveSourceActor(options);

        // Walk the actor's effects ONCE and dispatch each RAW interaction.
        // Slight defer (next tick) so the damage has already been applied to
        // HP first — feels natural to players: "you take 8 damage… and you
        // wake up from Sleep."
        const triggers = [];
        for (const effect of actor.effects ?? []) {
          if (!effect || effect.disabled) continue;
          const key = effect.flags?.[MODULE_ID]?.conditionKey;
          if (!key) continue;
          if (RAW_TRIGGERS.has(key)) {
            triggers.push({ effect, key });
          }
        }
        if (!triggers.length) return;

        setTimeout(async () => {
          for (const { effect, key } of triggers) {
            try {
              await ConditionRawHooks._dispatch(key, { actor, effect, amount, sourceActor });
            } catch (err) {
              console.warn(`${MODULE_ID} | ConditionRawHooks dispatch for "${key}" threw (non-fatal):`, err);
            }
          }
        }, 60);
      } catch (err) {
        console.warn(`${MODULE_ID} | ConditionRawHooks preApplyDamage hook failed:`, err);
      }
    });

    // ── ACE damage path ── APPLY ALL / Cleave / save-for-half route HP through
    // DamageApplicator.applyHPDamage, which writes hp via a raw actor.update and
    // therefore NEVER fires dnd5e.preApplyDamage. So the hook above never heard a
    // normal ACE attack, and a sleeping creature couldn't be woken by getting hit.
    // Listen to ACE's own damageApplied hook too. Its payload has no amount/source,
    // so it only drives the "any damage" reaction (Sleep wake) — caster-specific
    // ones (charm break, dominate re-save) stay on the dnd5e hook. (2026-06-24.)
    Hooks.on(`${MODULE_ID}.damageApplied`, (payload) => {
      try {
        if (game.users?.activeGM !== game.user) return;
        const actor = payload?.actor;
        if (!actor?.effects) return;
        const sleepEffect = [...(actor.effects ?? [])].find(e =>
          e && !e.disabled && e.flags?.[MODULE_ID]?.conditionKey === "sleep_unconscious");
        if (!sleepEffect) return;
        setTimeout(() => {
          ConditionRawHooks._wakeSleeper({ actor, effect: sleepEffect, amount: null })
            .catch(err => console.warn(`${MODULE_ID} | ACE-damage Sleep wake failed:`, err));
        }, 60);
      } catch (err) {
        console.warn(`${MODULE_ID} | ConditionRawHooks damageApplied hook failed:`, err);
      }
    });

    // ── Rider cleanup ── dnd5e auto-spawns shared rider CONDITION effects (prone,
    // incapacitated) from any status that has them — unconscious → prone+incap,
    // paralyzed/stunned → incap — on EVERY effect create. But it never links those
    // rider conditions back to the parent, so they are NOT removed when the parent
    // is deleted; they linger on the token after Sleep / Hold Person ends. When one
    // of OUR condition effects is deleted, remove the rider conditions it pulled in,
    // UNLESS another surviving effect still pulls the same rider. (2026-06-24.)
    Hooks.on("deleteActiveEffect", async (effect, _opts, _userId) => {
      try {
        if (game.users?.activeGM !== game.user) return;
        if (!effect?.flags?.[MODULE_ID]?.conditionKey) return;   // only OUR conditions
        const actor = effect.parent;
        if (!(actor instanceof Actor) || !actor.effects) return;

        // Which rider statuses did THIS effect's statuses pull in?
        const riders = new Set();
        for (const s of (effect.statuses ?? [])) {
          for (const p of (CONFIG.statusEffects?.find?.(e => e.id === s)?.riders ?? [])) riders.add(p);
        }
        if (!riders.size) return;

        const toDelete = [];
        for (const rider of riders) {
          // Justified if another SURVIVING effect still pulls this rider in
          // (e.g. a creature that's BOTH asleep and held keeps incapacitated).
          const justified = [...actor.effects].some(e => {
            if (e.id === effect.id) return false;
            for (const s2 of (e.statuses ?? [])) {
              if ((CONFIG.statusEffects?.find?.(x => x.id === s2)?.riders ?? []).includes(rider)) return true;
            }
            return false;
          });
          if (justified) continue;
          // Remove the bare single-status rider condition(s) for this status —
          // never one of our own effects.
          for (const e of actor.effects) {
            if (e.id === effect.id) continue;
            if (e.flags?.[MODULE_ID]?.conditionKey) continue;
            if (e.statuses?.size === 1 && e.statuses.has(rider)) toDelete.push(e.id);
          }
        }
        if (toDelete.length) {
          await actor.deleteEmbeddedDocuments("ActiveEffect", [...new Set(toDelete)]);
        }
      } catch (err) {
        console.warn(`${MODULE_ID} | ConditionRawHooks rider cleanup failed (non-fatal):`, err);
      }
    });

    console.debug(`${MODULE_ID} | ConditionRawHooks online — ${RAW_TRIGGERS.size} keys watched`);
  }

  // ═════════════════════════════════════════════════════════════════════════
  // DISPATCH
  // ═════════════════════════════════════════════════════════════════════════

  static async _dispatch(key, ctx) {
    switch (key) {
      case "sleep_unconscious":
        return ConditionRawHooks._wakeSleeper(ctx);
      case "charm_person":
      case "suggestion":
        return ConditionRawHooks._breakOnHarmFromCaster(ctx);
      case "dominate_person":
      case "dominate_monster":
        return ConditionRawHooks._dominateRetrySave(ctx);
      case "geas":
        // RAW arbitration is on the GM ("acting against" the geas).
        // Don't auto-trigger 5d10 psychic from damage — that would fire
        // every time a friendly heal nicked them. Skip silently for now;
        // future enhancement = GM card with a "violation? 5d10 psychic" button.
        return;
      default:
        return;
    }
  }

  // ═════════════════════════════════════════════════════════════════════════
  // SLEEP — any damage wakes the sleeper
  // ═════════════════════════════════════════════════════════════════════════

  static async _wakeSleeper({ actor, effect, amount }) {
    // PHB 277: "The spell has no effect on a creature that's already unconscious
    // […]. The spell ends for a creature if it takes damage or someone uses an
    // action to shake or slap it awake."
    try {
      // Suppress post-end concentration cascades — we're ending FOR THIS
      // creature only; if multiple creatures were caught by one Sleep cast,
      // the others stay asleep.
      await effect.setFlag(MODULE_ID, "_replacedNotEnded", true);
      await effect.delete();
      ConditionRawHooks._postCard({
        actor,
        title: "Sleep — Awakened",
        accent: "#7e9ad0",
        line: `<b>${actor.name}</b> takes${Number(amount) > 0 ? ` ${amount}` : ""} damage and snaps awake. The Sleep ends on them.`,
      });
    } catch (err) {
      console.warn(`${MODULE_ID} | Sleep wake-on-damage failed for ${actor.name}:`, err);
    }
  }

  // ═════════════════════════════════════════════════════════════════════════
  // CHARM PERSON / SUGGESTION — caster's harm breaks the effect
  // ═════════════════════════════════════════════════════════════════════════

  static async _breakOnHarmFromCaster({ actor, effect, sourceActor, amount }) {
    // RAW: the spell ends if the charmer (or anyone the charmer commands)
    // harms the target. We approximate "anyone the charmer commands" as
    // "the charmer themselves" — extending to summons/dominated minions is
    // a future enhancement (would need a charmer-allegiance check).
    try {
      const casterActorId = ConditionRawHooks._effectCasterActorId(effect);
      if (!casterActorId) return;                  // can't identify caster → can't enforce
      if (!sourceActor) return;                    // damage from environment, traps, etc. → not the caster
      if (sourceActor.id !== casterActorId) return;
      // The caster harmed the charmed target → spell ends.
      await effect.setFlag(MODULE_ID, "_replacedNotEnded", true);
      await effect.delete();
      const spellName = effect.name ?? effect.flags?.[MODULE_ID]?.conditionKey ?? "the charm";
      ConditionRawHooks._postCard({
        actor,
        title: `${spellName} — Broken`,
        accent: "#ce93d8",
        line: `The charmer (<b>${sourceActor.name}</b>) just dealt ${amount} damage to <b>${actor.name}</b>. RAW: the spell ends.`,
      });
    } catch (err) {
      console.warn(`${MODULE_ID} | charm/suggestion break-on-harm failed for ${actor.name}:`, err);
    }
  }

  // ═════════════════════════════════════════════════════════════════════════
  // DOMINATE PERSON / MONSTER — damage triggers a new save
  // ═════════════════════════════════════════════════════════════════════════

  static async _dominateRetrySave({ actor, effect, amount }) {
    // PHB 235 (Dominate Person): "Each time the target takes damage, it
    // makes a new Wisdom saving throw against the spell. If the saving
    // throw succeeds, the spell ends."
    //
    // We auto-roll the save (matches the autoRollNpcSaves convention for
    // NPCs; PCs get the standard ace-qol save prompt via save-engine if
    // we ever wire that path). Reads the save DC from the spell's origin
    // activity; falls back to the caster's spell DC or 13 (a sane floor).
    try {
      const saveAbility = "wis";
      const saveDC = ConditionRawHooks._effectSaveDC(effect) ?? 13;

      // Build the save roll using dnd5e's own rollAbilitySave if available
      // (so feats/bonuses/proficiency apply correctly). Fall back to a
      // plain 1d20 + WIS-mod build if the API isn't present.
      let total = 0;
      let formula = "";
      try {
        const roll = await actor.rollSavingThrow?.({ ability: saveAbility, fastForward: true, chatMessage: false });
        // dnd5e 5.x: rollSavingThrow returns a Roll[] in some versions,
        // a single Roll in others — accept either shape.
        const r = Array.isArray(roll) ? roll[0] : roll;
        total = Number(r?.total ?? 0);
        formula = r?.formula ?? "";
      } catch (_) { /* fall through */ }

      if (!total) {
        const mod = Number(actor.system?.abilities?.[saveAbility]?.mod ?? 0);
        const prof = Number(actor.system?.attributes?.prof ?? 0);
        const profBonus = (actor.system?.abilities?.[saveAbility]?.proficient ?? 0) > 0 ? prof : 0;
        const roll = await new Roll(`1d20 + ${mod} + ${profBonus}`).evaluate();
        total = roll.total;
        formula = roll.formula;
      }

      const passed = total >= saveDC;

      ConditionRawHooks._postCard({
        actor,
        title: passed ? "Dominate — Broken!" : "Dominate — Holds",
        accent: passed ? "#7ec97e" : "#d4af37",
        line: `<b>${actor.name}</b> takes ${amount} damage and contests the dominator's hold. Save: <b>${total}</b> vs DC <b>${saveDC}</b> (Wisdom) — <b>${passed ? "SUCCESS" : "FAIL"}</b>. ${passed ? "The spell ends on them." : ""}`,
      });

      if (passed) {
        await effect.setFlag(MODULE_ID, "_replacedNotEnded", true);
        await effect.delete();
      }
    } catch (err) {
      console.warn(`${MODULE_ID} | dominate save-on-damage failed for ${actor.name}:`, err);
    }
  }

  // ═════════════════════════════════════════════════════════════════════════
  // HELPERS
  // ═════════════════════════════════════════════════════════════════════════

  /**
   * Find who dealt damage. dnd5e's preApplyDamage payload doesn't have a
   * stable "source" field across 5.x point releases; we try a few common
   * paths and accept the first that resolves to an Actor.
   */
  static _resolveSourceActor(options) {
    if (!options) return null;
    try {
      // dnd5e 5.x sometimes passes options.source as an actor or token doc
      const direct = options.source ?? options.sourceActor ?? null;
      if (direct?.documentName === "Actor") return direct;
      if (direct?.actor?.documentName === "Actor") return direct.actor;

      // Or as a UUID we can resolve sync
      const uuid = options.sourceUuid ?? options.attacker?.uuid ?? null;
      if (uuid) {
        const resolved = fromUuidSync?.(uuid);
        if (resolved?.documentName === "Actor") return resolved;
        if (resolved?.actor) return resolved.actor;
      }

      // Last resort: read flags from the damage payload that ace-qol's own
      // damage-engine may have stamped.
      const ourSourceId = options.aceQol?.sourceActorId
        ?? options.attackerActorId
        ?? null;
      if (ourSourceId) return game.actors?.get?.(ourSourceId) ?? null;
    } catch (_) { /* fall through */ }
    return null;
  }

  /**
   * Read the casting actor's ID from an effect's origin UUID. SaveResolver
   * stamps `effect.origin = spellItem.uuid` (e.g.
   * "Actor.abc123.Item.def456"); the segment between "Actor." and ".Item"
   * is the caster's actor ID.
   */
  static _effectCasterActorId(effect) {
    try {
      const origin = String(effect?.origin ?? "");
      const m = origin.match(/Actor\.([a-zA-Z0-9]+)\.Item\./);
      return m?.[1] ?? null;
    } catch (_) { return null; }
  }

  /**
   * Read the save DC from the spell item that placed this effect.
   * Falls back to the caster's spellDC, then null.
   */
  static _effectSaveDC(effect) {
    try {
      const origin = String(effect?.origin ?? "");
      const item = fromUuidSync?.(origin);
      const realItem = item?.documentName === "Item" ? item : item?.item;
      if (realItem?.system?.activities) {
        for (const act of Object.values(realItem.system.activities)) {
          const dc = Number(act?.save?.dc?.value);
          if (Number.isFinite(dc) && dc > 0) return dc;
        }
      }
      // Caster's spell DC
      const m = origin.match(/Actor\.([a-zA-Z0-9]+)\.Item\./);
      const caster = m?.[1] ? game.actors?.get?.(m[1]) : null;
      const sdc = Number(caster?.system?.attributes?.spelldc);
      if (Number.isFinite(sdc) && sdc > 0) return sdc;
    } catch (_) { /* fall through */ }
    return null;
  }

  /**
   * Post a small purple chat card for the RAW interaction. Speaker is the
   * affected actor so players see it surface against the right combatant.
   */
  static async _postCard({ actor, title, accent, line }) {
    try {
      const content = `
<div style="background:linear-gradient(180deg,#1a1410 0%,#0f0a08 100%);
            border:2px solid ${accent};
            border-radius:6px;
            padding:10px 12px;
            color:#f0e4c0;
            font-family:'Signika','Helvetica Neue',sans-serif;">
  <div style="font-size:14px;font-weight:700;color:${accent};
              text-transform:uppercase;letter-spacing:0.6px;
              border-bottom:1px solid #4a3a28;
              padding-bottom:5px;margin-bottom:6px;">
    ${title}
  </div>
  <div style="font-size:13px;color:#e8d49a;line-height:1.5;">
    ${line}
  </div>
</div>`;
      await ChatMessage.create({
        speaker: ChatMessage.getSpeaker({ actor }),
        content,
      });
    } catch (err) {
      console.warn(`${MODULE_ID} | ConditionRawHooks._postCard threw (non-fatal):`, err);
    }
  }
}

// Cache of effect keys that need RAW handling — guards the hot path
// (the hook walks every effect on every damage event).
const RAW_TRIGGERS = new Set([
  "sleep_unconscious",
  "charm_person",
  "suggestion",
  "dominate_person",
  "dominate_monster",
  "geas",
]);
