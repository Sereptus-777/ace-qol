// ─── ACE: QOL — Pipeline Resolver: Self ───────────────────────────────────────
// Apply an ActiveEffect to the caster directly — no picker.
// Mage Armor, Shield, Mirror Image, Stoneskin, Blur, Foresight.
// Phase 2 will implement. For now, falls through to dnd5e default flow.
// ──────────────────────────────────────────────────────────────────────────────

import { MODULE_ID } from "../../ace-qol.mjs";

export class SelfResolver {
  static async run(_ctx) {
    console.warn(`${MODULE_ID} | SelfResolver.run not yet implemented (Phase 2).`);
  }
}
