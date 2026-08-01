// ─── ACE: QOL — Condition Sheet Integration ─────────────────────────────────
// Makes the dnd5e character / NPC sheet recognize ACE's labeled condition
// effects, so the GM can see and toggle them from the sheet like any condition.
//
// THE PROBLEM (proven from dnd5e source, 2026-07-25):
//   dnd5e keys its condition PIPS entirely off a deterministic effect id —
//   `actor.effects.get(staticID("dnd5e"+condition))` — for BOTH:
//     • the lit/unlit display  (BaseActorSheet#_prepareEffectsContext, which sets
//       `disabled: existing ? existing.disabled : true`), and
//     • the click-to-toggle    (EffectsElement#_onToggleCondition, which deletes
//       the static-id effect if present, else CREATES one).
//   ACE's condition effects carry the real status (so the creature genuinely IS
//   petrified/incapacitated and `actor.statuses` knows it) but use their OWN
//   random id + a single labeled row — so dnd5e never sees them as "the
//   condition":
//     • the pip shows OFF even while the creature is petrified, and
//     • clicking the pip creates dnd5e's own static-id effect, which ACE's
//       condition dedupe immediately strips → the on/off/on/off flicker Johnny
//       hit (2026-07-25).
//
// THE FIX — two small, defensive wraps that teach the sheet to see ACE:
//   1. DISPLAY: after dnd5e builds its conditions list, light any pip whose
//      status the actor actually has (`actor.statuses`). Covers ACE-provided
//      statuses AND their riders (petrified → incapacitated) in one shot.
//   2. TOGGLE: when a pip is active via an ACE labeled effect (no dnd5e static
//      effect, but `actor.statuses` has it), clicking it removes that ACE effect
//      — a clean toggle OFF — instead of creating a duplicate ACE will strip.
//
// No change to ACE's condition CREATION (zero risk to the condition engine), and
// the clean single labeled row is preserved. This is sheet-local display /
// interaction, so it runs on whoever is looking (no activeGM gate).
// ──────────────────────────────────────────────────────────────────────────────

import { MODULE_ID } from "./ace-qol.mjs";

export class ConditionSheetIntegration {

  static init() {
    // dnd5e's sheet classes + custom elements are all defined by `ready`. init()
    // is itself called from ACE's ready hook, so patch immediately when ready is
    // already up (a fresh `once("ready")` here would never fire); otherwise defer.
    // The `_ace*Patched` guards make a repeat init a no-op.
    const doPatch = () => {
      try { this._patchToggle(); }
      catch (err) { console.warn(`${MODULE_ID} | condition pip TOGGLE patch failed (non-fatal):`, err); }
      try { this._patchDisplay(); }
      catch (err) { console.warn(`${MODULE_ID} | condition pip DISPLAY patch failed (non-fatal):`, err); }
    };
    if (game.ready) doPatch();
    else Hooks.once("ready", doPatch);
  }

  // ── 1. Toggle: EffectsElement#_onToggleCondition ──────────────────────────
  static _patchToggle() {
    const El = customElements.get("dnd5e-effects");
    if (!El?.prototype?._onToggleCondition) {
      console.warn(`${MODULE_ID} | condition pip toggle: dnd5e-effects element not found (dnd5e layout changed?)`);
      return;
    }
    if (El.prototype._aceCondTogglePatched) return;
    const orig = El.prototype._onToggleCondition;
    El.prototype._onToggleCondition = async function (conditionId) {
      try {
        const doc = this.document;   // the Actor
        // Active via an ACE labeled effect (owns the status, but not through a
        // dnd5e static-id effect) → toggle OFF by removing that effect. Removing
        // the owner also clears its riders — deleting ACE's "Petrified" clears the
        // Incapacitated it carries, which is exactly right.
        if (doc?.statuses?.has?.(conditionId)) {
          const owners = doc.effects.filter(e =>
            e?.flags?.[MODULE_ID]?.conditionKey && e?.statuses?.has?.(conditionId));
          if (owners.length) return await Promise.all(owners.map(e => e.delete()));
        }
      } catch (err) {
        console.warn(`${MODULE_ID} | ACE condition toggle-off failed — falling back to dnd5e default:`, err);
      }
      return orig.call(this, conditionId);
    };
    El.prototype._aceCondTogglePatched = true;
    console.log(`${MODULE_ID} | condition pip TOGGLE patched — ACE conditions toggle from the sheet`);
  }

  // ── 2. Display: light a pip whenever the actor actually has that status ────
  static _patchDisplay() {
    const protos = this._findEffectsContextProtos();
    if (!protos.length) {
      console.warn(`${MODULE_ID} | condition pip display: no _prepareEffectsContext owner found (dnd5e sheet layout changed?)`);
      return;
    }
    let n = 0;
    for (const proto of protos) {
      if (proto._aceCondDisplayPatched) continue;
      const orig = proto._prepareEffectsContext;
      proto._prepareEffectsContext = async function (context, options) {
        const result = await orig.call(this, context, options);
        try {
          const st = this.actor?.statuses;
          // dnd5e builds context.conditions in place; result is usually the same
          // object. cond.id is the condition key (e.g. "petrified").
          const conds = context?.conditions ?? result?.conditions;
          if (st && Array.isArray(conds)) {
            for (const cond of conds) {
              if (cond?.disabled && st.has?.(cond.id)) cond.disabled = false;
            }
          }
        } catch (_) { /* display nicety — never break the sheet */ }
        return result;
      };
      proto._aceCondDisplayPatched = true;
      n++;
    }
    if (n) console.log(`${MODULE_ID} | condition pip DISPLAY patched (${n} sheet class[es]) — ACE conditions light up`);
  }

  // Find every distinct prototype that OWNS _prepareEffectsContext across the
  // registered actor sheet classes (character + NPC may share the base or each
  // override it). Version-agnostic: no dependency on dnd5e's export path.
  static _findEffectsContextProtos() {
    const found = new Set();
    try {
      const reg = CONFIG.Actor?.sheetClasses ?? {};
      for (const byType of Object.values(reg)) {
        for (const entry of Object.values(byType ?? {})) {
          let proto = entry?.cls?.prototype;
          while (proto && proto !== Object.prototype) {
            if (Object.prototype.hasOwnProperty.call(proto, "_prepareEffectsContext")) {
              found.add(proto);
              break;
            }
            proto = Object.getPrototypeOf(proto);
          }
        }
      }
    } catch (err) {
      console.warn(`${MODULE_ID} | condition pip display: sheet discovery failed:`, err);
    }
    return [...found];
  }
}
