// ─── ACE: QOL — Pipeline Resolver: Multi-Buff ─────────────────────────────────
// Apply an ActiveEffect (from extended-effects key registry) to each selected
// target. Bless, Bane, Faerie Fire, Aid, Beacon of Hope. Phase 2 will implement.
// ──────────────────────────────────────────────────────────────────────────────

import { MODULE_ID } from "../../ace-qol.mjs";

export class BuffResolver {
  static async runMulti(_ctx, _result) {
    console.warn(`${MODULE_ID} | BuffResolver.runMulti not yet implemented (Phase 2).`);
  }
}
