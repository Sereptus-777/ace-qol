// ─── ACE: QOL — Pipeline Resolver: Template ───────────────────────────────────
// Template-save (Fireball), template-trigger (Spike Growth — handled today by
// concentration-widget), aura (Spirit Guardians — handled today by spell-auras).
// Phase 2 will integrate these into the pipeline.
// ──────────────────────────────────────────────────────────────────────────────

import { MODULE_ID } from "../../ace-qol.mjs";

export class TemplateResolver {
  static async runSave(_ctx) {
    console.warn(`${MODULE_ID} | TemplateResolver.runSave not yet implemented (Phase 2).`);
  }
  static async runTrigger(_ctx) {
    console.warn(`${MODULE_ID} | TemplateResolver.runTrigger not yet implemented (Phase 2).`);
  }
  static async runAura(_ctx) {
    console.warn(`${MODULE_ID} | TemplateResolver.runAura not yet implemented (Phase 2).`);
  }
}
