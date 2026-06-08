// ─── ACE: QOL — Pipeline Resolver: Save ───────────────────────────────────────
// Single-target save shape (Hold Person, Disintegrate, Polymorph).
// Phase 2 will implement. For now, returning here means dnd5e default flow
// already ran by the time we got here — graceful no-op.
// ──────────────────────────────────────────────────────────────────────────────

import { MODULE_ID } from "../../ace-qol.mjs";

export class SaveResolver {
  static async runSingle(_ctx, _result) {
    console.warn(`${MODULE_ID} | SaveResolver.runSingle not yet implemented (Phase 2).`);
  }
}
