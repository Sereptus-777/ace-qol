// ─── ACE: QOL — Invisibility Breaker (RAW) ───────────────────────────────────
// When a creature with the Invisibility spell active makes an attack or casts
// a spell, the spell ends per RAW. This module enforces that rule.
//
// Editions covered:
//   2014: "The spell ends for a target that attacks or casts a spell."
//   2024: "The spell ends on a target that makes an attack roll, deals damage,
//          or casts a spell."
//
// Greater Invisibility (4th level) does NOT end on attack or cast — that's
// the entire point of the spell. We explicitly skip it.
//
// Natural invisibility (Will-o'-Wisp's Invisibility trait, Invisible Stalker's
// Invisibility trait, etc.) is NOT touched — those persist by design. We
// detect this by requiring the ActiveEffect's origin to resolve to a SPELL
// item, not a feature/trait item.
//
// Wire-up:
//   - attack-pipeline.mjs calls `InvisibilityBreaker.breakOnAttack(actor)`
//     after every successful attack roll posts results
//   - This module's `register()` installs a global `dnd5e.useActivity` hook
//     that fires `breakOnSpellCast` for every spell cast (except Invisibility
//     / Greater Invisibility being cast itself — casting it ON yourself
//     shouldn't immediately break the just-cast spell)
//
// Setting: `autoBreakInvisibility` (default ON). Tables that prefer manual
// rulings can flip it OFF.
// ──────────────────────────────────────────────────────────────────────────────

import { MODULE_ID } from "./ace-qol.mjs";
import { CombatState } from "./combat-state.mjs";

export class InvisibilityBreaker {

  /**
   * Install global hooks. Called once from ace-qol.mjs ready hook.
   */
  static register() {
    // ── Spell-cast trigger: every spell cast ends Invisibility ──
    // Fires AFTER the user picks slot / confirms cast (not preUseActivity,
    // which fires before commit — we want only committed casts to count).
    // ⚠️🔴 THIS WAS ON `dnd5e.useActivity`, WHICH dnd5e DOES NOT EMIT.
    // 5.3.3 fires `preUseActivity` and `postUseActivity` and nothing between
    // them, so this listener registered without complaint and never once ran:
    // casting a spell has never broken Invisibility. Nothing threw, nothing
    // warned, and the only other hooks in this file watch effects being added
    // and removed, so there was no second path to cover it.
    //
    // Found 2026-09-05 by `tools/hook-check.py`, which exists because of it.
    // `postUseActivity` is what the comment above always meant: after the slot
    // is picked and the cast is committed.
    Hooks.on("dnd5e.postUseActivity", (activity, _usageConfig) => {
      try {
        if (activity?.item?.type !== "spell") return;
        const actor = activity?.actor || activity?.item?.actor;
        if (!actor) return;

        // Don't break the spell that's BEING cast right now — that's nonsense.
        // (E.g. casting Invisibility on yourself shouldn't immediately end it.)
        const castSpellName = String(activity.item.name ?? "").toLowerCase().trim();
        if (castSpellName === "invisibility" || castSpellName === "greater invisibility") return;

        InvisibilityBreaker.breakOnSpellCast(actor).catch(err =>
          console.warn(`${MODULE_ID} | InvisibilityBreaker spell-cast handler threw:`, err)
        );
      } catch (err) {
        console.warn(`${MODULE_ID} | InvisibilityBreaker.useActivity hook threw:`, err);
      }
    });

    // ── Visual-hide trigger: when an Invisibility effect is APPLIED, also
    //    set the token's `hidden` flag so it visually disappears from the
    //    map (same as clicking the eye icon). Tag the token doc with
    //    `flags.ace-qol.invisibilityHidden = true` so we know WE hid it
    //    and don't accidentally unhide GM-hidden tokens later.
    //
    //    Covers BOTH Invisibility and Greater Invisibility — both should
    //    make the target visually disappear. The breaker only removes
    //    the regular Invisibility on attack/cast; Greater Invisibility
    //    persists until concentration ends.
    Hooks.on("createActiveEffect", (effect, _options, userId) => {
      try {
        // Only the user that created the effect handles the visual change.
        // Avoids 4 GMs all racing to hide the same token.
        if (userId !== game.user.id) return;
        if (!InvisibilityBreaker._isInvisibilityEffect(effect, /* includeGreater */ true)) return;
        const actor = effect.parent;
        if (!actor || actor.documentName !== "Actor") return;
        InvisibilityBreaker._hideTokensForInvisibility(actor).catch(err =>
          console.warn(`${MODULE_ID} | _hideTokensForInvisibility threw:`, err)
        );
      } catch (err) {
        console.warn(`${MODULE_ID} | createActiveEffect (invis) handler threw:`, err);
      }
    });

    // ── Visual-unhide trigger: when an Invisibility effect is REMOVED
    //    (by our breaker, by concentration ending, by manual deletion),
    //    check if any OTHER invisibility effect remains on the actor.
    //    If not, unhide tokens that WE hid (via the flag check).
    Hooks.on("deleteActiveEffect", (effect, _options, userId) => {
      try {
        if (userId !== game.user.id) return;
        if (!InvisibilityBreaker._isInvisibilityEffect(effect, /* includeGreater */ true)) return;
        const actor = effect.parent;
        if (!actor || actor.documentName !== "Actor") return;

        // Check for OTHER active invisibility effects (excluding the one
        // being deleted right now — at this hook time it's still in the
        // collection, so we filter by id).
        const stillInvisible = (actor.effects ?? []).some(e =>
          e.id !== effect.id &&
          !e.disabled &&
          InvisibilityBreaker._isInvisibilityEffect(e, /* includeGreater */ true)
        );
        if (stillInvisible) {
          console.debug(`${MODULE_ID} | Invisibility effect removed, but actor still has another → keeping tokens hidden`);
          return;
        }

        InvisibilityBreaker._unhideTokensForInvisibility(actor).catch(err =>
          console.warn(`${MODULE_ID} | _unhideTokensForInvisibility threw:`, err)
        );
      } catch (err) {
        console.warn(`${MODULE_ID} | deleteActiveEffect (invis) handler threw:`, err);
      }
    });

    console.debug(`${MODULE_ID} | InvisibilityBreaker registered (RAW invisibility ends on attack/cast + visual hide/unhide)`);
  }

  // ─── Token visual hide/unhide ──────────────────────────────────────────────

  /**
   * Hide all of an actor's tokens by setting document.hidden = true.
   * Tags each hidden token with `flags.ace-qol.invisibilityHidden` so we
   * know WE hid it (and won't accidentally unhide GM-pre-hidden tokens).
   * Skips tokens already hidden by the GM (no flag tag added in that case).
   */
  static async _hideTokensForInvisibility(actor) {
    const tokens = actor.getActiveTokens?.(true) ?? [];
    for (const tk of tokens) {
      try {
        // If the token was already hidden (by the GM via eye icon, or by
        // another module), leave it alone — don't tag it, don't touch it.
        if (tk.document.hidden) continue;
        await tk.document.update({
          hidden: true,
          [`flags.${MODULE_ID}.invisibilityHidden`]: true,
        });
      } catch (err) {
        console.warn(`${MODULE_ID} | Hide failed for ${tk.name}:`, err);
      }
    }
  }

  /**
   * Unhide tokens that WE hid (via the invisibilityHidden flag).
   * Leaves GM-hidden tokens (those without the flag) untouched.
   */
  static async _unhideTokensForInvisibility(actor) {
    const tokens = actor.getActiveTokens?.(true) ?? [];
    for (const tk of tokens) {
      try {
        const wasHiddenByUs = tk.document.getFlag?.(MODULE_ID, "invisibilityHidden") === true;
        if (!wasHiddenByUs) continue;
        await tk.document.update({
          hidden: false,
          [`flags.${MODULE_ID}.-=invisibilityHidden`]: null,
        });
      } catch (err) {
        console.warn(`${MODULE_ID} | Unhide failed for ${tk.name}:`, err);
      }
    }
  }

  // ─── Public API ────────────────────────────────────────────────────────────

  /**
   * Called by attack-pipeline.mjs after every committed attack roll.
   * 2014 + 2024 RAW: making an attack ends the Invisibility spell.
   */
  static breakOnAttack(actor) {
    return InvisibilityBreaker._breakInternal(actor, "made an attack");
  }

  /**
   * Called by the dnd5e.useActivity hook installed in register().
   * 2014 + 2024 RAW: casting a spell ends the Invisibility spell.
   */
  static breakOnSpellCast(actor) {
    return InvisibilityBreaker._breakInternal(actor, "cast a spell");
  }

  /**
   * 2024 RAW only: dealing damage ends the Invisibility spell.
   * Reserved for future wire-up from damage-engine when damage applies and
   * the source is invisible (covers Spike Growth, triggered Sneak Attack, etc.
   * that don't go through the normal attack pipeline).
   *
   * For v1.0 launch, attack + spell-cast triggers cover ~95% of cases. The
   * remaining 5% (passive damage triggered by movement, reactions outside
   * attack rolls) is a tracked TODO.
   */
  static breakOnDamage(actor) {
    const edition = CombatState.getActiveEdition(actor);
    if (edition !== "2024") return Promise.resolve(false);
    return InvisibilityBreaker._breakInternal(actor, "dealt damage");
  }

  // ─── Internals ─────────────────────────────────────────────────────────────

  /**
   * Core break-the-spell flow. Idempotent — if no Invisibility effect is
   * present (or only Greater Invisibility), returns false silently.
   */
  static async _breakInternal(actor, reasonText) {
    if (!actor) return false;

    // ── Setting gate ──
    try {
      if (game.settings.get(MODULE_ID, "autoBreakInvisibility") === false) return false;
    } catch (_) { return false; /* setting not yet registered */ }

    // ── Find the breakable Invisibility effect ──
    const effect = InvisibilityBreaker._findBreakableInvisibility(actor);
    if (!effect) return false;

    // ── Owner-permission gate ──
    // The user running this code must OWN the actor to delete its effects.
    // For NPCs that means GM. For PCs that means the player who owns the
    // character. dnd5e.useActivity always runs on the casting user's client,
    // and attack pipelines run on the attacking user's client, so OWNER
    // permission is the normal case. If we somehow run as a non-owner (e.g.
    // a Help-action ally triggering damage on a hidden attacker), bail
    // silently — let the actual owner handle it on their next action.
    if (!actor.isOwner) {
      console.debug(`${MODULE_ID} | InvisibilityBreaker: non-owner, deferring to owner client (${actor.name})`);
      return false;
    }

    // ── Remove the effect + end concentration ──
    try {
      // dnd5e ties concentration to the casting actor's concentration item.
      // Deleting the linked ActiveEffect also ends concentration on it, but
      // for defense-in-depth we check the concentration registry and remove
      // any concentrating effect tied to Invisibility too.
      const conc = actor.concentration;
      if (conc?.effects?.size) {
        for (const ce of conc.effects) {
          if (InvisibilityBreaker._isInvisibilityEffect(ce, /* includeGreater */ false)) {
            try { await ce.delete(); } catch (_) { /* may already be gone */ }
          }
        }
      }

      // Belt-and-suspenders: delete the matched effect directly if it still
      // exists (the concentration loop above may have already nuked it).
      if (effect.id && actor.effects.get(effect.id)) {
        try { await effect.delete(); } catch (_) { /* race with concentration cleanup */ }
      }
    } catch (err) {
      console.warn(`${MODULE_ID} | InvisibilityBreaker: effect removal threw`, err);
      return false;
    }

    // ── Remove the base "invisible" status if no other effect grants it ──
    // (E.g. if Pass Without Trace + Invisibility were both active, removing
    // Invisibility leaves Pass Without Trace which doesn't grant invisible.
    // If a monster trait still grants invisible, leave the status on.)
    try {
      const stillInvisibleFromOther = (actor.effects ?? []).some(e =>
        (e.statuses instanceof Set ? e.statuses.has("invisible") : false) &&
        !e.disabled && e.id !== effect.id
      );
      if (!stillInvisibleFromOther) {
        for (const t of actor.getActiveTokens(true)) {
          if (t.actor?.statuses?.has("invisible")) {
            try { await t.actor.toggleStatusEffect("invisible", { active: false }); }
            catch (_) { /* non-fatal */ }
          }
        }
      }
    } catch (_) { /* non-fatal */ }

    // ── Post chat caption ──
    await InvisibilityBreaker._postBreakChat(actor, reasonText);

    return true;
  }

  /**
   * Find a breakable Invisibility ActiveEffect on the actor.
   * Returns the effect, or null if none / only Greater Invisibility.
   */
  static _findBreakableInvisibility(actor) {
    if (!actor?.effects) return null;
    for (const e of actor.effects) {
      if (InvisibilityBreaker._isInvisibilityEffect(e, /* includeGreater */ false)) {
        return e;
      }
    }
    return null;
  }

  /**
   * Returns true if the effect is the BREAKABLE Invisibility spell.
   * False for:
   *   - Greater Invisibility (unless includeGreater=true)
   *   - Disabled effects
   *   - Effects whose origin resolves to a non-spell item (monster traits)
   */
  static _isInvisibilityEffect(effect, includeGreater = false) {
    if (!effect) return false;
    if (effect.disabled) return false;

    // ── NEVER match the concentration MARKER (the caster-bleed root cause) ────
    // dnd5e creates a "Concentrating: Greater Invisibility" effect on the CASTER
    // when concentration begins. Its name CONTAINS "greater invisibility", so the
    // substring match below returned true for it — and the createActiveEffect
    // hook then HID THE CASTER'S TOKEN the instant they cast. That was the
    // multi-day caster-bleed, confirmed by stack trace 2026-06-27 (beginConcentrating
    // → createActiveEffect → _isInvisibilityEffect → _hideTokensForInvisibility).
    // The marker carries the "concentration" status, NEVER "invisible", so exclude
    // it explicitly (status check + name-prefix belt-and-braces). The real
    // invisibility buffs (status "invisible") still match and still hide.
    const statuses = effect.statuses;
    if (statuses?.has?.("concentration") || statuses?.has?.("concentrating")) return false;

    const name = String(effect.name ?? "").toLowerCase().trim();
    if (name.startsWith("concentrat")) return false;

    // Greater Invisibility — only match if explicitly requested
    if (name.includes("greater invisibility") || name === "greater invisibility") {
      return includeGreater;
    }

    // Match by name — accept "Invisibility" or "Invisible"
    if (name !== "invisibility" && name !== "invisible") return false;

    // Confirm origin is a SPELL (not a monster trait / racial feature).
    // Origin format: "Actor.<id>.Item.<id>" or full UUID variants.
    const origin = effect.origin ?? "";
    if (!origin || !origin.includes("Item.")) {
      // No origin → likely manually applied (macro / DM action). Allow.
      return true;
    }

    try {
      const resolved = fromUuidSync(origin);
      // dnd5e 5.x: an effect's origin is the ACTIVITY uuid, so fromUuidSync
      // returns an Activity whose `.type` is none of spell/feat/race. Resolve
      // THROUGH to the parent item before the type check, or a monster/feat
      // invisibility wrongly breaks on attack. (Audit 2026-06-27.)
      const item = resolved?.item ?? resolved;
      if (!item) return true; // Origin unresolvable → allow (defensive)
      // Spell items break on attack. Feature/race items do NOT.
      if (item.type === "spell") return true;
      if (item.type === "feat" || item.type === "race") return false;
      // Unknown type → conservative: allow (better to over-break than leave stale)
      return true;
    } catch (_) {
      return true;
    }
  }

  /**
   * Post a styled chat card noting the spell ended and why.
   * Dark ACE-branded wrapper, blue accent for Invisibility theme.
   */
  static async _postBreakChat(actor, reasonText) {
    const speakerName = (() => {
      try {
        const tok = canvas.tokens?.controlled?.find(t => t.actor?.id === actor.id);
        return tok?.name ?? actor.token?.name ?? actor.name ?? "Creature";
      } catch (_) { return actor.name ?? "Creature"; }
    })();

    const accent = "#8ab4d8"; // soft blue — matches our Mirror Image caption tone

    const html = `
      <div style="background:linear-gradient(180deg,#1a1410 0%,#0f0a08 100%);
                  border:2px solid ${accent};
                  border-radius:6px;
                  padding:12px 14px;
                  color:#f0e4c0;
                  font-family:'Signika','Helvetica Neue',sans-serif;
                  box-shadow:0 0 10px ${accent}33;">
        <div style="display:flex;align-items:center;gap:10px;
                    font-size:15px;font-weight:700;color:${accent};
                    text-transform:uppercase;letter-spacing:0.6px;
                    border-bottom:1px solid #4a3a28;
                    padding-bottom:6px;margin-bottom:8px;">
          <i class="fas fa-eye" style="font-size:16px;color:${accent};"></i>
          <span>INVISIBILITY ENDS</span>
        </div>
        <div style="font-size:15px;line-height:1.45;color:#f0e4c0;font-weight:500;">
          <strong>${speakerName}</strong> ${reasonText} — the
          <em style="color:${accent};">Invisibility</em> spell ends and they become visible.
        </div>
      </div>
    `;

    try {
      await ChatMessage.create({
        speaker: ChatMessage.getSpeaker({ actor }),
        content: html,
        flavor: `${speakerName} ${reasonText} — Invisibility ends`,
      });
    } catch (err) {
      console.warn(`${MODULE_ID} | InvisibilityBreaker: chat post failed`, err);
    }
  }
}
