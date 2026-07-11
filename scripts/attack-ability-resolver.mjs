// ─── ACE: QOL — Attack Ability Resolver ──────────────────────────────────────
// THE character-level rule for WHICH ability a weapon swing rolls with.
//
// This is deliberately NOT an item stamp. Stamping "use CHA" onto a weapon's
// data rots the moment the character picks up a new weapon (the Blood Halberd
// bug, 2026-07-09: warlock/paladin with CHA 20 swinging at +1 STR because the
// new halberd came in with the default ability). Instead, at ROLL TIME we read
// the ATTACKER — features, edition — and swap the ability modifier into the
// roll config when a character rule grants a better one. One rule, every
// weapon the character will ever hold, no per-item bookkeeping.
//
// Rules implemented (first wave):
//   • 2024 — Pact of the Blade invocation: attacks with the pact weapon may
//     use CHARISMA for attack and damage rolls. (PHB 2024, Eldritch Invocations)
//   • 2014 — Hexblade's Hex Warrior feature: CHA on the chosen weapon / the
//     pact weapon. (Xanathar's) Plain 2014 Pact of the Blade does NOT grant
//     CHA on its own — edition-gated accordingly.
//
// TABLE RULE (Johnny, 2026-07-09): the EQUIPPED weapon *is* the bonded pact
// weapon — no bonding bookkeeping, no prompt on weapon swaps. RAW nuance
// (bond one weapon, re-bond on a rest; 2014 Hex Warrior wants non-two-handed
// unless it's the pact weapon) is intentionally collapsed to "equipped".
//
// Mechanics: we mutate `roll.data.mod` inside dnd5e's preRollAttackV2 /
// preRollDamageV2 configs (the "@mod" term every weapon attack + base damage
// part references). The swap only happens when CHA is STRICTLY better — RAW
// says "can use", and no player chooses the worse die. Rolls whose parts
// don't reference @mod (rider dice like the Blood Halberd's 2d6) are
// untouched by construction.
// ──────────────────────────────────────────────────────────────────────────────

import { MODULE_ID } from "./ace-qol.mjs";
import { CombatState } from "./combat-state.mjs";

/** Does the actor have a feat/class item whose name contains `name`? */
function _hasFeat(actor, name) {
  const lower = name.toLowerCase();
  try {
    return actor.items?.some(i =>
      (i.type === "feat" || i.type === "class") && i.name?.toLowerCase().includes(lower)
    ) ?? false;
  } catch (_) { return false; }
}

/** Find a feat/class item whose name contains `name` (returns the item or undefined). */
function _findFeat(actor, name) {
  const lower = name.toLowerCase();
  try {
    return actor.items?.find(i =>
      (i.type === "feat" || i.type === "class") && i.name?.toLowerCase().includes(lower)
    );
  } catch (_) { return undefined; }
}

/**
 * The rule: should this actor's swing with this weapon use a different ability?
 * Returns { ability, mod, why } or null when the default stands. Declines are
 * console.debug'd with the reason — a silent gate cost us a live-fire morning
 * (2026-07-09: three gates failed invisibly and the fix took a console probe).
 */
function _resolveAbilityOverride(actor, item) {
  const decline = (why) => {
    try { console.debug(`${MODULE_ID} | [ability-resolver] no override for "${item?.name}": ${why}`); } catch (_) {}
    return null;
  };
  try {
    if (!actor || item?.type !== "weapon") return null;   // not a weapon swing — silent
    try { if (game.settings.get(MODULE_ID, "pactWeaponCharisma") === false) return decline("setting off"); } catch (_) {}

    // NO equipped gate. Johnny's table rule (2026-07-09): ANY weapon this character
    // attacks with counts as their bonded pact weapon — sheets' equipped flags are
    // not maintained in play (his live halberd sat equipped:false while being swung).

    const chaMod = Number(actor.system?.abilities?.cha?.mod);
    if (!Number.isFinite(chaMod)) return decline("no CHA mod");

    const potb = _findFeat(actor, "pact of the blade");
    const hexW = _findFeat(actor, "hex warrior");
    if (!potb && !hexW) return null;                      // no pact features at all — silent

    // Edition: the FEATURE'S edition outranks the world's. Mixed-edition worlds are
    // real — hijinx is a legacy(2014) CoS world whose PCs carry PHB-2024 features.
    // A 2024-sourced Pact of the Blade grants the CHA option wherever it's used;
    // a 2014 PotB grants CHA only via Hexblade's Hex Warrior (RAW both editions).
    const potbIs2024 = String(potb?.system?.source?.rules ?? "") === "2024";
    const worldIs2024 = CombatState.getActiveEdition(actor) === "2024";
    if (hexW) return { ability: "cha", mod: chaMod, why: "Hex Warrior" };
    if (potb && (potbIs2024 || worldIs2024)) {
      return { ability: "cha", mod: chaMod, why: `Pact of the Blade (${potbIs2024 ? "2024 feature" : "2024 rules"})` };
    }
    return decline("2014 Pact of the Blade grants no CHA without Hex Warrior (RAW)");
  } catch (_) { return null; }
}

/**
 * Swap @mod on ONE built roll when the rule grants a better ability. Idempotent —
 * a second pass sees the raised mod and no-ops. Skips rolls whose parts don't
 * reference @mod (e.g. off-hand attacks where dnd5e RAW-correctly excluded it).
 */
function _applyToRoll(roll, actor, item, kind) {
  try {
    if (!roll || !item || !actor) return;
    const override = _resolveAbilityOverride(actor, item);
    if (!override) return;
    const cur = Number(roll?.data?.mod);
    if (!Number.isFinite(cur)) return;               // roll carries no ability mod
    if (override.mod <= cur) return;                 // default already as good — RAW "can", not "must"
    if (Array.isArray(roll.parts) && !roll.parts.some(p => String(p).includes("@mod"))) return;
    roll.data.mod = override.mod;
    console.log(
      `${MODULE_ID} | [ability-resolver] ${actor.name}: "${item.name}" ${kind} uses CHA `
      + `${override.mod >= 0 ? "+" : ""}${override.mod} (was ${cur >= 0 ? "+" : ""}${cur}) — ${override.why}`
    );
  } catch (err) {
    console.warn(`${MODULE_ID} | attack-ability-resolver ${kind} swap failed (non-fatal):`, err);
  }
}

/** Apply across a whole preRoll process config (works when data is pre-populated, e.g. damage). */
function _applyToRollConfig(config, kind) {
  try {
    const subject = config?.subject;
    const item = subject?.item;
    const actor = subject?.actor;
    if (!item || !actor) return;
    for (const roll of (config.rolls ?? [])) _applyToRoll(roll, actor, item, kind);
  } catch (err) {
    console.warn(`${MODULE_ID} | attack-ability-resolver ${kind} config pass failed (non-fatal):`, err);
  }
}

export class AttackAbilityResolver {

  /**
   * Public lookup for card renderers: the ability override (if any) this
   * actor gets on this weapon. Returns { ability, mod, why } or null.
   * Keeps the attack-card breakdown honest — "+5 CHA", not "+1 STR +4 BONUS".
   */
  static getOverride(actor, item) {
    return _resolveAbilityOverride(actor, item);
  }

  static register() {
    // Table toggle — some tables want strict RAW bonding bookkeeping instead.
    try {
      game.settings.register(MODULE_ID, "pactWeaponCharisma", {
        name: "Pact Weapon: Auto-Charisma",
        hint: "Warlocks with Pact of the Blade (2024) or Hex Warrior (2014) automatically attack "
            + "and damage with Charisma when it's better, on any EQUIPPED weapon — the equipped "
            + "weapon is treated as their bonded pact weapon. Turn off to manage weapon abilities by hand.",
        scope: "world", config: true, type: Boolean, default: true,
      });
    } catch (_) { /* already registered */ }

    // All hooks fire on the ROLLING client (GM or player), so the swap lands no
    // matter which side clicks — no socket work needed.
    //
    // ANCHOR POINT (proven live 2026-07-09): on the fast-forward path (ACE always
    // shift-skips weapon dialogs) the ATTACK roll's parts/data are built by dnd5e's
    // per-roll buildConfig AFTER preRollAttackV2 fires — at preRoll time
    // `rolls[0].data.mod` is UNDEFINED and there is nothing to swap. The per-roll
    // `dnd5e.postBuild<Type>RollConfig` hook fires right AFTER the build, before the
    // dice — that's where the swap must live. The preRoll passes stay as belt-and-
    // suspenders for paths that pre-populate data (idempotent: second pass no-ops).
    Hooks.on("dnd5e.postBuildAttackRollConfig", (config, roll) => {
      const s = config?.subject; _applyToRoll(roll, s?.actor, s?.item, "attack");
    });
    Hooks.on("dnd5e.postBuildDamageRollConfig", (config, roll) => {
      const s = config?.subject; _applyToRoll(roll, s?.actor, s?.item, "damage");
    });
    Hooks.on("dnd5e.preRollAttackV2", (config) => _applyToRollConfig(config, "attack"));
    Hooks.on("dnd5e.preRollDamageV2", (config) => _applyToRollConfig(config, "damage"));

    console.log(`${MODULE_ID} | AttackAbilityResolver online — character-rule ability resolution (Pact of the Blade / Hex Warrior → CHA)`);
  }
}
