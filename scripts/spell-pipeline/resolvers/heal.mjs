// ─── ACE: QOL — Pipeline Resolver: Heal ───────────────────────────────────────
// Touch heal (Cure Wounds), single-target ranged heal (Healing Word),
// multi-target heal (Mass Cure Wounds). Phase 2 will implement.
// ──────────────────────────────────────────────────────────────────────────────

import { MODULE_ID } from "../../ace-qol.mjs";

export class HealResolver {
  static async runSingle(_ctx, _result) {
    console.warn(`${MODULE_ID} | HealResolver.runSingle not yet implemented (Phase 2).`);
  }
  static async runMulti(_ctx, _result) {
    console.warn(`${MODULE_ID} | HealResolver.runMulti not yet implemented (Phase 2).`);
  }
}
