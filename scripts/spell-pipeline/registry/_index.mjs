// ─── ACE: QOL — Spell Registry Index ──────────────────────────────────────────
// Merged registry. Add new shape files here and they'll auto-merge.
// Lookup is case-insensitive by spell name (handled in pipeline.mjs).
// ──────────────────────────────────────────────────────────────────────────────

import { SELF_SPELLS }       from "./self-spells.mjs";
import { DISTRIBUTE_SPELLS } from "./distribute-spells.mjs";
import { BUFF_SPELLS }       from "./buff-spells.mjs";
import { HEAL_SPELLS }       from "./heal-spells.mjs";
import { SAVE_SPELLS }       from "./save-spells.mjs";
import { TEMPLATE_SPELLS }   from "./template-spells.mjs";
import { TRIGGER_SPELLS }    from "./trigger-spells.mjs";
import { AURA_SPELLS }       from "./aura-spells.mjs";
import { CHAIN_SPELLS }      from "./chain-spells.mjs";
import { SUMMON_SPELLS }     from "./summon-spells.mjs";

export const SPELL_REGISTRY = {
  ...SELF_SPELLS,
  ...DISTRIBUTE_SPELLS,
  ...BUFF_SPELLS,
  ...HEAL_SPELLS,
  ...SAVE_SPELLS,
  ...TEMPLATE_SPELLS,
  ...TRIGGER_SPELLS,
  ...AURA_SPELLS,
  ...CHAIN_SPELLS,
  ...SUMMON_SPELLS,
};
