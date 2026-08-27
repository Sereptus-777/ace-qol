// ─── ACE: QOL — Pipeline Resolver: Template ───────────────────────────────────
// Template-save (Fireball / Lightning Bolt / Cone of Cold / Ice Storm…),
// template-trigger (Spike Growth / Web / Wall of Fire…), and aura
// (Spirit Guardians / Aura of Vitality…).
//
// IMPORTANT: the runtime mechanics for these spells were built into other
// engines BEFORE the pipeline existed and have been battle-tested through
// many sessions:
//
//   • Instant template-save damage → save-engine.postSaveCard reads the
//     activity's damage parts and posts the save card with auto-damage.
//     spell-timing.mjs SPELL_TABLE drives the save ability + onSave behavior.
//   • Persistent template-trigger damage (entry / start-of-turn / exit) →
//     concentration-widget.mjs's area-denial + trigger pipeline.
//   • Aura emanations (caster-anchored / per-turn re-eval / disposition-
//     filtered) → aura-engine.mjs.
//
// These resolvers therefore deliberately DO NOTHING at runtime. Their value
// is structural — by registering Fireball / Spirit Guardians / Web / etc.
// in the pipeline (via the matching registry files), the spells benefit
// from the pipeline's CROSS-CUTTING SERVICES without touching their
// mechanics:
//
//   1. Slot deferral — cancel = no slot lost (e.g., user aborts template
//      placement; dnd5e still consumed the slot under the old flow).
//   2. Counterspell barrier — the v0.7.21 cast-barrier promise that gates
//      every shape; previously only attack/save/buff/heal/distribute
//      spells benefited.
//   3. Stale-target clearing — the pre-cast targets-clear (relevant for
//      AA-using template spells whose animation aims at the LAST target,
//      not the template).
//   4. Cast-level cache + dedup — unified per-cast bookkeeping.
//
// If a future phase needs to pull a template-shape spell INTO the resolver
// (e.g. unify the Fireball save card under the pipeline so it can be
// customised independently of the generic save-engine), that's a Phase 4
// migration. For now these resolvers are intentional no-ops.
// ──────────────────────────────────────────────────────────────────────────────

import { MODULE_ID } from "../../ace-qol.mjs";

export class TemplateResolver {

  /**
   * Template-save shape (Fireball, Lightning Bolt, Cone of Cold, …).
   * No-op — save-engine + spell-timing handle the save card + damage scaling.
   * Returning silently lets SpellPipeline._commitSlotIfDeferred run.
   */
  static async runSave(ctx) {
    if (ctx?.entry?._debug) {
      console.debug(`${MODULE_ID} | TemplateResolver.runSave: ${ctx.item?.name} no-op (handled by save-engine + spell-timing)`);
    }
  }

  /**
   * Template-trigger shape (Spike Growth, Web, Wall of Fire, Moonbeam, …).
   * No-op — concentration-widget handles entry / start-of-turn / exit saves
   * + Lingering Nausea + difficult-terrain regions.
   */
  static async runTrigger(ctx) {
    if (ctx?.entry?._debug) {
      console.debug(`${MODULE_ID} | TemplateResolver.runTrigger: ${ctx.item?.name} no-op (handled by concentration-widget)`);
    }
  }

  /**
   * Aura shape (Spirit Guardians, Aura of Vitality, Crusader's Mantle, …).
   * No-op — aura-engine handles emanation re-evaluation + disposition
   * filtering + per-turn damage.
   */
  static async runAura(ctx) {
    // ⚠️🔴 THIS NO-OP SAID IT WAS "handled by aura-engine" AND FOR
    // SPIRIT GUARDIANS THAT WAS NOT TRUE.
    //
    // aura-engine.mjs knows exactly five things, and all five are paladin
    // CLASS FEATURES: Aura of Protection, Warding, Courage, Hate and The
    // Guardian. It has never heard of a SPELL. So a spell tagged shape
    // "aura" dispatched here, this did nothing, and the engine it named did
    // nothing either - three layers each certain another one had it.
    //
    // Johnny, 2026-08-27: "Spirit Guardians did absolutely nothing: no
    // animation, nothing."
    //
    // ⚠️ A COMMENT THAT NAMES ITS SUCCESSOR MUST BE CHECKABLE. The other
    // two no-ops in this file are honest - save-engine really does own
    // template-save, and concentration-widget really does own
    // template-trigger. This one named an owner that could not accept it, and
    // nothing anywhere would ever have said so. Now it asks.
    const name = ctx?.item?.name ?? "this spell";
    let owned = false;
    try {
      const { AuraEngine } = await import("../../aura-engine.mjs");
      owned = !!AuraEngine?.knowsAura?.(ctx?.item);
    } catch (err) {
      console.warn(`${MODULE_ID} | could not ask the aura engine about "${name}":`, err);
      return;
    }

    if (owned) {
      if (ctx?.entry?._debug) {
        console.debug(`${MODULE_ID} | TemplateResolver.runAura: ${name} - aura-engine owns it`);
      }
      return;
    }

    console.warn(`${MODULE_ID} | "${name}" is registered with shape "aura", which hands it to `
      + `the aura engine - and the aura engine only knows paladin class-feature auras, not `
      + `spells. Nothing is going to resolve this cast. If it places a template and deals `
      + `damage on a save, its shape should be "template-trigger" (like Moonbeam), which `
      + `the concentration tracker already drives.`);
  }
}
