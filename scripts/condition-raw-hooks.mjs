// ─── ACE: QOL — Condition RAW Enforcement Hooks ─────────────────────────────
// Some spell-applied conditions have RAW interactions that an Active Effect
// alone can't enforce — they react to *events* the GM/players don't think to
// manually trigger:
//
//   • Sleep        — "the sleeper wakes if it takes damage" (PHB 277).
//   • Charm Person — the spell ends when the caster OR THE CASTER'S SIDE harms
//                    the target. 2014: "you or your companions do anything
//                    harmful"; 2024: "you or your allies damage it". Read off the
//                    ITEM, and damage is the harm a hook can see.
//   • Suggestion   — the same door and that spell's own text: it ends on damage
//                    from the caster or their companions.
//   • Command      — NOT this rule. It is not in the dispatch and must not be.
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
import { onCanvasReady } from "./ready-utils.mjs";
import { readActivities } from "./read-activities.mjs";
import { QolSettings } from "./settings.mjs";
import { saveBonus } from "./rolldata-utils.mjs";

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

    // ── ACE'S OWN DAMAGE PATH DRIVES ALL OF THEM (2026-09-30) ──────────────
    //
    // APPLY ALL, Cleave and save-for-half route hit points through
    // DamageApplicator.applyHPDamage, which writes hp with a raw actor.update and
    // therefore NEVER fires `dnd5e.preApplyDamage`. So the hook above never hears a
    // normal ACE attack.
    //
    // ⚠️🔴 AND ONLY THE SLEEP WAKE WAS MOVED ACROSS. The note here said the payload
    // "has no amount/source, so it only drives the any-damage reaction — caster-
    // specific ones stay on the dnd5e hook". That stopped being true when the
    // hit-point door was built: `damageApplied` carries `sourceActor` and `total`.
    // The note stayed, so Lamia could hit Escher all day and her Charm never broke,
    // because every drop of ACE damage came down the one path this hook ignored.
    // (His table, 2026-09-30: "Lamia hitting Escher drops her Charm the moment
    // damage lands.")
    //
    // It is the same dispatch as the dnd5e hook now, so there is one set of rules
    // and not two. The two paths are disjoint — a raw actor.update does not fire
    // dnd5e's hook — and a reaction whose effect has already gone simply finds
    // nothing to do.
    Hooks.on(`${MODULE_ID}.damageApplied`, (payload) => {
      try {
        if (game.users?.activeGM !== game.user) return;
        const actor = payload?.actor;
        if (!actor?.effects) return;
        const amount = Number(payload?.hpDelta ?? payload?.total ?? 0);
        if (!Number.isFinite(amount) || amount <= 0) return;      // a heal is not harm
        const sourceActor = payload?.sourceActor ?? null;
        const sourceItem = payload?.sourceItem ?? null;
        // A beat, so the hit points and the card have settled before an effect goes.
        setTimeout(() => {
          for (const effect of [...(actor.effects ?? [])]) {
            const key = effect?.flags?.[MODULE_ID]?.conditionKey;
            if (!effect || effect.disabled || !key) continue;
            ConditionRawHooks._dispatch(key, { actor, effect, sourceActor, sourceItem, amount })
              ?.catch?.(err => console.warn(`${MODULE_ID} | the "${key}" reaction to ACE damage `
                + `on ${actor?.name} failed:`, err));
          }
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
    /* ⚠️🔴 THE STATUS IS HANDED ON, NOT LOST WITH ITS CARRIER.
     *
     * A second source's copy is created WITHOUT the status, because a status is
     * one flag on a creature and asking dnd5e for its fixed-id record twice is
     * what collided and re-read the actor (his audit, 2026-10-01). The other half
     * of that rule is this: when the copy that WAS carrying it ends — its hour
     * runs out, or the caster's side harms the target — the creature must not
     * stop being charmed while another caster's charm is still running.
     *
     * So the status goes to the oldest remaining copy. Only the status: its
     * duration, its anchor and its flags are its own and are not touched, which
     * is the rule that took four versions to get right.
     */
    Hooks.on("deleteActiveEffect", async (effect, _opts, _userId) => {
      try {
        if (game.users?.activeGM !== game.user) return;
        const key = effect?.flags?.[MODULE_ID]?.conditionKey ?? null;
        if (!key) return;                                        // only OUR conditions
        const actor = effect.parent;
        if (!(actor instanceof Actor) || !actor.effects) return;

        const gone = [...(effect.statuses ?? [])].map(x => String(x).toLowerCase());
        if (gone.length) {
          const others = (actor.effects.contents ?? []).filter(e =>
            e.id !== effect.id && !e.disabled && e.flags?.[MODULE_ID]?.conditionKey === key);
          const stillHeld = new Set();
          for (const e of others) {
            for (const x of (e.statuses ?? [])) stillHeld.add(String(x).toLowerCase());
          }
          const orphaned = gone.filter(st => !stillHeld.has(st));
          if (orphaned.length && others.length) {
            const heir = others[0];
            try {
              await heir.update({ statuses: [...new Set([...(heir.statuses ?? []), ...orphaned])] });
              console.log(`${MODULE_ID} | "${effect.name}" was carrying ${orphaned.join(", ")} for `
                + `${actor.name} and has ended, but "${heir.name}" is still running — so the status `
                + `goes to it. Its own duration and clock are untouched.`);
            } catch (err) {
              console.warn(`${MODULE_ID} | could not hand ${orphaned.join(", ")} on to `
                + `"${heir.name}" on ${actor.name}, so that creature may have stopped being it while `
                + `a second source is still running:`, err);
            }
          }
        }

        // Which rider statuses did THIS effect's statuses pull in?
        const riders = new Set();
        for (const s of (effect.statuses ?? [])) {
          for (const p of (RIDER_MAP[s] ?? [])) riders.add(p);
        }
        if (!riders.size) return;

        const toDelete = [];
        for (const rider of riders) {
          // Justified if another SURVIVING effect still pulls this rider in
          // (e.g. a creature that's BOTH asleep and held keeps incapacitated).
          const justified = [...actor.effects].some(e => {
            if (e.id === effect.id) return false;
            for (const s2 of (e.statuses ?? [])) {
              if ((RIDER_MAP[s2] ?? []).includes(rider)) return true;
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

    // ── Strip dnd5e's DUPLICATE generic condition effects ──
    // dnd5e separately spawns its own canonical condition effects ("Unconscious",
    // "Prone", "Incapacitated", "Paralyzed"…) that mirror statuses OUR labeled
    // condition already carries. They have no conditionKey, so the
    // createRiderConditions patch can't catch them (it only guards OUR effects),
    // and the live diagnostic confirmed the result: a token shows "Sleep" PLUS
    // three generic unlabeled rows that ALSO linger after ours ends. This removes
    // any non-ACE condition effect whose statuses are FULLY owned by one of our
    // active ACE conditions — handling both orders (a generic lands after ours;
    // ours lands on top of pre-existing generics). The dependentOn guards make
    // sure we never delete an effect OUR condition cascades from (the dnd5e
    // concentration link sets dependentOn on the applied effect).
    // activeGM-gated; one client deletes, the change syncs to all. (2026-06-25)
    Hooks.on("createActiveEffect", async (effect, _opts, _userId) => {
      try {
        if (game.users?.activeGM !== game.user) return;
        const actor = effect.parent;
        if (!(actor instanceof Actor) || !actor.effects) return;

        const _dep = (e) => {
          const d = e?.flags?.dnd5e?.dependentOn;
          return Array.isArray(d) ? d : (d ? [d] : []);
        };

        if (effect.flags?.[MODULE_ID]?.conditionKey) {
          // OUR condition just landed → strip any pre-existing generic duplicates it owns.
          const owned = new Set([...(effect.statuses ?? [])]);
          if (!owned.size) return;
          const cascadesFrom = _dep(effect);                      // never delete what we depend on
          const dupes = [];
          for (const e of actor.effects) {
            if (e.id === effect.id) continue;
            if (e.flags?.[MODULE_ID]?.conditionKey) continue;     // never our own labeled condition
            if (cascadesFrom.includes(e.uuid)) continue;
            const s = [...(e.statuses ?? [])];
            if (s.length && s.every(x => owned.has(x))) dupes.push(e.id);
          }
          if (dupes.length) await actor.deleteEmbeddedDocuments("ActiveEffect", [...new Set(dupes)]);
        } else {
          // A generic condition/rider just landed → drop it if one of OUR conditions
          // already owns ALL of its statuses (and nothing of ours cascades from it).
          const s = [...(effect.statuses ?? [])];
          if (!s.length) return;
          const ownedByAce = [...actor.effects].some(e =>
            e.id !== effect.id &&
            e.flags?.[MODULE_ID]?.conditionKey &&
            s.every(x => e.statuses?.has?.(x)));
          if (!ownedByAce) return;
          const dependedOnByOurs = [...actor.effects].some(e =>
            e.flags?.[MODULE_ID]?.conditionKey && _dep(e).includes(effect.uuid));
          if (dependedOnByOurs) return;
          await effect.delete();
        }
      } catch (err) {
        console.warn(`${MODULE_ID} | ConditionRawHooks duplicate-condition strip failed (non-fatal):`, err);
      }
    });

    // ── RAW: incapacitation breaks concentration (2026-07-27) ──────────────
    // PHB (2014 + 2024): concentration ends when you become INCAPACITATED or
    // die — not just on the damage save. Nothing enforced this: dnd5e only
    // breaks concentration on the damage CON save or a manual click, so a
    // concentrating wizard turned to stone (or paralyzed, stunned, knocked
    // unconscious, killed) kept his spell running. When any effect lands (or
    // is re-enabled) carrying an incapacitating status on a CONCENTRATING
    // creature, end all their concentration with a chat line saying why.
    // Found while answering "can a restrained creature concentrate?" — the
    // Rule-#1 sweep of the class. activeGM-gated; one client acts.
    const INCAPACITATING = new Set(["incapacitated", "petrified", "paralyzed", "stunned", "unconscious", "dead"]);
    const _breakConcIfIncapacitated = async (effect) => {
      try {
        if (game.users?.activeGM !== game.user) return;
        if (effect?.disabled) return;
        const actor = effect?.parent instanceof Actor ? effect.parent
          : (effect?.parent?.parent instanceof Actor ? effect.parent.parent : null);
        if (!actor) return;
        const statuses = [...(effect.statuses ?? [])];
        const trigger = statuses.find(s => INCAPACITATING.has(s));
        if (!trigger) return;
        const concEffects = actor.concentration?.effects;
        if (!concEffects?.size) return;                       // not concentrating — nothing to break
        const spellNames = [...concEffects].map(e =>
          e.getFlag?.("dnd5e", "item")?.name ?? e.name ?? "a spell");
        await actor.endConcentration();                        // no arg = end ALL (RAW)
        console.log(`${MODULE_ID} | Concentration RAW: ${actor.name} became ${trigger} — concentration broken (${spellNames.join(", ")}).`);
        try {
          await ChatMessage.create({
            speaker: ChatMessage.getSpeaker({ actor }),
            content: `<b>${actor.name}</b> is ${trigger === "dead" ? "slain" : trigger} — concentration on <b>${spellNames.join("</b>, <b>")}</b> is broken.`,
          });
        } catch (_) { /* informational only */ }
      } catch (err) {
        console.warn(`${MODULE_ID} | incapacitation concentration-break failed (non-fatal):`, err);
      }
    };
    Hooks.on("createActiveEffect", (effect) => { _breakConcIfIncapacitated(effect); });
    Hooks.on("updateActiveEffect", (effect, changes) => {
      // Covers a disabled incapacitating effect being switched back ON.
      if (changes?.disabled === false) _breakConcIfIncapacitated(effect);
    });

    // Heal desynced condition "ghosts" on load and on every scene switch — see
    // reconcileConditionGhosts() below. Cheap: only writes when a ghost exists.
    onCanvasReady( () => { ConditionRawHooks.reconcileConditionGhosts(); });

    console.debug(`${MODULE_ID} | ConditionRawHooks online — ${RAW_TRIGGERS.size} keys watched`);
  }

  // ═════════════════════════════════════════════════════════════════════════
  // GHOST RECONCILE — heal desynced dnd5e static-ID rider effects
  // ═════════════════════════════════════════════════════════════════════════

  /**
   * On an UNLINKED token, a dnd5e static-ID rider effect (dnd5eincapacitat,
   * dnd5epetrified…) can end up STORED in the ActorDelta yet MISSING from the
   * synthetic actor's live effects map — a desync. While it's desynced it:
   *   (a) doesn't render on the character sheet,
   *   (b) can't be toggled from the sheet or token HUD, and
   *   (c) makes the next attempt to (re)create that condition throw a keepId
   *       "already exists within ActorDelta … effects" collision.
   * It can also linger as a plain live DUPLICATE of a status one of OUR labeled
   * conditions already owns (a bare "incapacitated" sitting under a Petrified).
   *
   * On canvas load / scene switch we re-mirror any token that has such a ghost
   * (DataModel#reset surfaces the stored record back into the live map) and drop
   * the bare rider duplicates our conditions own — never a standalone condition
   * nothing of ours owns. activeGM-gated; one client writes, the change syncs.
   * (2026-07-25 — root fix for the "petrified but not on the sheet / can't
   * toggle incapacitated" report.)
   */
  static async reconcileConditionGhosts() {
    try {
      if (game.users?.activeGM !== game.user) return;
      const scene = canvas?.scene;
      if (!scene) return;

      for (const token of scene.tokens ?? []) {
        try {
          if (token.actorLink) continue;            // linked actors have no per-token delta ghosts
          const actor = token.actor;
          if (!actor?.effects) continue;

          // A desynced ghost = a stored dnd5e static-ID effect absent from the live map.
          const srcEffects = token.delta?._source?.effects ?? [];
          const hasGhost = srcEffects.some(e =>
            typeof e?._id === "string" && e._id.startsWith("dnd5e") && !actor.effects.has(e._id));
          if (hasGhost) {
            try { actor.reset(); } catch (_) { /* best-effort surface into the live map */ }
          }

          // Drop any bare dnd5e static-ID rider effect whose EVERY status is already
          // owned by one of OUR live labeled conditions (leftover incapacitated under
          // a Petrified, etc.). A standalone condition nothing of ours owns is kept.
          const aceConds = [...actor.effects].filter(e => e.flags?.[MODULE_ID]?.conditionKey);
          if (aceConds.length) {
            const toDelete = [];
            for (const e of actor.effects) {
              if (!(typeof e.id === "string" && e.id.startsWith("dnd5e"))) continue;
              if (e.flags?.[MODULE_ID]?.conditionKey) continue;   // never one of ours
              const s = [...(e.statuses ?? [])];
              if (!s.length) continue;
              if (aceConds.some(a => s.every(x => a.statuses?.has?.(x)))) toDelete.push(e.id);
            }
            if (toDelete.length) {
              await actor.deleteEmbeddedDocuments("ActiveEffect", [...new Set(toDelete)]);
              console.log(`${MODULE_ID} | Reconciled ${toDelete.length} orphaned rider condition(s) on ${token.name}.`);
            }
          }
        } catch (err) {
          console.warn(`${MODULE_ID} | condition-ghost reconcile failed for ${token?.name} (non-fatal):`, err);
        }
      }
    } catch (err) {
      console.warn(`${MODULE_ID} | reconcileConditionGhosts failed (non-fatal):`, err);
    }
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

  /**
   * WHETHER THIS DAMAGER IS ON THE CASTER'S SIDE (2026-09-30).
   *
   * His rule: "When the caster of that Charm, or that caster's allies, deal damage
   * to that target, that caster's Charm ends immediately." RAW says the same in
   * both editions, in different words: 2014 "you or your companions", 2024 "you or
   * your allies".
   *
   * A side is a token's disposition, which is the only thing Foundry actually
   * knows about allegiance. Same disposition as the caster's own token means the
   * same side. A creature with no token on this scene cannot be placed, so the
   * answer is NO and the console says why: ending a charm on a guess is worse than
   * leaving the GM to end it himself.
   */
  static _onCasterSide(sourceActor, casterActorId) {
    try {
      if (!sourceActor || !casterActorId) return false;
      if (sourceActor.id === casterActorId) return true;          // the caster themselves
      const tokenOf = (a) => a?.getActiveTokens?.()?.[0]?.document
        ?? canvas?.tokens?.placeables?.find(t => t.actor?.id === a?.id)?.document ?? null;
      const caster = game.actors?.get(casterActorId) ?? null;
      const mine = tokenOf(sourceActor);
      const theirs = tokenOf(caster);
      if (!mine || !theirs) {
        console.log(`${MODULE_ID} | cannot tell whether ${sourceActor?.name} is on `
          + `${caster?.name ?? "the charmer"}'s side: one of them has no token on this scene, `
          + `so the charm is left for the GM to end.`);
        return false;
      }
      const same = mine.disposition === theirs.disposition;
      if (same) {
        console.log(`${MODULE_ID} | ${sourceActor.name} is on ${caster?.name}'s side `
          + `(both disposition ${mine.disposition}), so its damage ends that charm.`);
      }
      return same;
    } catch (err) {
      console.warn(`${MODULE_ID} | could not work out whose side ${sourceActor?.name} is on, `
        + `so the charm stands:`, err);
      return false;
    }
  }

  static async _breakOnHarmFromCaster({ actor, effect, sourceActor, sourceItem = null, amount }) {
    try {
      const casterActorId = ConditionRawHooks._effectCasterActorId(effect);
      if (!casterActorId) return;                  // can't identify caster → can't enforce
      if (!sourceActor) return;                    // a trap, the environment: not the caster
      // \u26a0\ufe0f THE CASTER OR THE CASTER'S SIDE (2026-09-30). This was the caster
      // alone, with a comment calling allies "a future enhancement"; RAW has said
      // "you or your companions" since 2014.
      if (!ConditionRawHooks._onCasterSide(sourceActor, casterActorId)) return;

      // \u26a0\ufe0f THE EDITION IS READ OFF THE ITEM, never off the world setting: the
      // item is what is being cast (CLAUDE.md, 2026-08-29). The two editions differ
      // in BREADTH, not in whether damage counts \u2014 2014's "anything harmful" is wider
      // than 2024's "damage it" \u2014 and damage is the only harm a hook can see, so the
      // wider one is only partly enforced and says so rather than pretending.
      let edition = null;
      try {
        const item = sourceItem ?? (typeof fromUuidSync === "function"
          ? (fromUuidSync(effect.origin)?.item ?? fromUuidSync(effect.origin)) : null);
        edition = String(item?.system?.source?.rules ?? "").trim() || null;
      } catch (_) { /* the break does not depend on knowing */ }
      if (edition === "2014") {
        console.log(`${MODULE_ID} | ${effect.name}: 2014 ends on "you or your companions do `
          + `anything harmful", which is wider than damage. ACE ends it on damage, which is `
          + `the part a hook can see; other harm is still the GM's call.`);
      } else if (edition === "2024") {
        console.log(`${MODULE_ID} | ${effect.name}: 2024 ends on "you or your allies damage it", `
          + `which is exactly what just happened.`);
      }

      // The caster's side harmed the charmed target, so the spell ends. No save:
      // his rule, 2026-09-30, "No extra save."
      await effect.setFlag(MODULE_ID, "_replacedNotEnded", true);
      await effect.delete();
      const spellName = effect.name ?? effect.flags?.[MODULE_ID]?.conditionKey ?? "the charm";
      const who = sourceActor.id === casterActorId
        ? `The charmer (<b>${sourceActor.name}</b>)`
        : `<b>${sourceActor.name}</b>, on the charmer's side,`;
      ConditionRawHooks._postCard({
        actor,
        title: `${spellName} — Broken`,
        accent: "#ce93d8",
        line: `${who} just dealt ${amount} damage to <b>${actor.name}</b>. The spell ends.`,
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

      // Build the save roll through dnd5e's own roller so feats, bonuses and
      // proficiency apply. Fall back to a plain 1d20 + WIS build if it fails.
      //
      // ⚠️ 2026-08-12 audit. The options here were the dnd5e **4.x** spelling:
      // `fastForward` does not suppress the dialog in 5.x (`{configure:false}`
      // in the SECOND argument does), and `chatMessage:false` in the config
      // position does not suppress the card (`{create:false}` in the THIRD
      // does). So every time a dominated creature took damage, a save dialog
      // popped and dnd5e printed its own card beside ours.
      let total = 0;
      let formula = "";
      let saveRoll = null;
      try {
        const roll = await actor.rollSavingThrow(
          { ability: saveAbility, target: saveDC },
          { configure: false },
          { create: false },
        );
        // dnd5e 5.x returns a Roll[]; older builds returned a single Roll.
        const r = Array.isArray(roll) ? roll[0] : roll;
        total = Number(r?.total ?? 0);
        formula = r?.formula ?? "";
        saveRoll = r ?? null;
      } catch (err) {
        console.warn(`${MODULE_ID} | Dominate re-save: system roller failed for ${actor?.name} — rolling manually.`, err);
      }

      if (!total) {
        // The creature's real save bonus, resolved through the shared reader —
        // in dnd5e 5.x the save value is an OBJECT, and interpolating it raw
        // produced "1d20 + [object Object]" and an Unresolved StringTerm throw.
        // This also beats rebuilding mod + proficiency by hand, which missed
        // every bonus a feat or item contributes.
        const bonus = saveBonus(actor?.getRollData?.() ?? {}, saveAbility);
        const { withHalflingLuck } = await import("./luck.mjs");
        const roll = await new Roll(withHalflingLuck(`1d20 + ${bonus}`, actor)).evaluate();
        total = roll.total;
        formula = roll.formula;
        saveRoll = roll;
      }

      // LUCKY (2014): a save about to fail, before the hold is kept (luck.mjs).
      try {
        const { againstDC } = await import("./luck.mjs");
        const lk = await againstDC({ actor, kind: "save", what: `Wisdom save against Dominate (DC ${saveDC})`,
          roll: saveRoll, total, dc: saveDC, dice: "show" });
        if (lk.spent) total = lk.total;
      } catch (err) {
        console.warn(`${MODULE_ID} | Dominate re-save: Lucky could not be offered on ${actor?.name}'s save; it stands as rolled:`, err);
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
        // ⚠️ Object.values on a Collection is always empty; this loop never ran.
        for (const act of readActivities(realItem)) {
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

// Explicit RAW sub-conditions ("riders") for each status. We hard-code these
// instead of reading dnd5e's CONFIG.statusEffects[x].riders because that config
// is INCOMPLETE — unconscious lists only "prone" there, omitting incapacitated,
// so the rider cleanup left "incapacitated" stuck. (2026-06-24.)
const RIDER_MAP = {
  unconscious: ["prone", "incapacitated"],
  paralyzed:   ["incapacitated"],
  stunned:     ["incapacitated"],
  petrified:   ["incapacitated"],
};
