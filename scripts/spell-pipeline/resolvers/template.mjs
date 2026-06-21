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
    if (ctx?.entry?._debug) {
      console.debug(`${MODULE_ID} | TemplateResolver.runAura: ${ctx.item?.name} no-op (handled by aura-engine)`);
    }
  }
}
