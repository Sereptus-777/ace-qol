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
// Rules implemented:
//   • Shillelagh — the caster's SPELLCASTING ability on a club or quarterstaff,
//     and only while the effect is actually running. It is a spell, not a
//     feature: looking for a feat by that name would hand a druid Wisdom on a
//     club forever.
//   • Martial Arts — DEXTERITY on monk weapons and unarmed strikes. The monk
//     weapon definition DIFFERS BY EDITION: 2014 is shortswords plus simple
//     melee that is neither two-handed nor heavy; 2024 is any simple melee plus
//     martial melee with the Light property.
//   • Way of the Kensei — widens what counts as a monk weapon rather than
//     granting an ability of its own. RAW: chosen weapons "count as monk
//     weapons for you", so the Dexterity still comes from Martial Arts. Heavy
//     and special weapons are excluded.
//   • 2024 — Pact of the Blade invocation: attacks with the pact weapon may
//     use CHARISMA for attack and damage rolls. (PHB 2024, Eldritch Invocations)
//   • 2014 — Hexblade's Hex Warrior feature: CHA on the chosen weapon / the
//     pact weapon. (Xanathar's) Plain 2014 Pact of the Blade does NOT grant
//     CHA on its own — edition-gated accordingly.
//
// ⚠️ ONLY WHEN IT IS BETTER, in every one of them. RAW says the character
// "can use" the other ability, never "must", and nobody at a table chooses the
// worse modifier. Below that threshold the weapon's own ability stands.
//
// ⚠️ WHICH WEAPON MATTERS AS MUCH AS WHICH FEATURE. A rule that grants
// Dexterity on a greataxe is worse than no rule at all, because it is wrong in
// the player's favour and nobody ever reports it. See
// tools/ability-rules-check.mjs — fourteen cases, and half of them assert that
// a rule does NOT apply.
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
/**
 * Is this weapon a MONK WEAPON for this character?
 *
 * ⚠️ THE DEFINITION CHANGED BETWEEN EDITIONS, and getting it wrong hands a
 * monk Dexterity on a greataxe.
 *
 *   2014 (PHB): shortswords, and any SIMPLE MELEE weapon that is not
 *               two-handed and not heavy.
 *   2024 (PHB): any SIMPLE MELEE weapon, and MARTIAL MELEE weapons with the
 *               Light property.
 *
 * ⚠️ KENSEI WIDENS THE SET, IT DOES NOT GRANT AN ABILITY. Way of the
 * Kensei says the chosen weapons "count as monk weapons for you" — the
 * Dexterity itself still comes from Martial Arts. So Kensei is handled here, by
 * admitting more weapons, rather than as a second ability rule. Kensei weapons
 * may not be heavy or special.
 *
 * ⚠️ AND WE CANNOT KNOW WHICH TWO HE CHOSE. RAW picks two weapon types at
 * 3rd level and nothing on the sheet records them. Same table rule the pact
 * weapon already uses (2026-07-09): any qualifying weapon counts, rather than
 * making the GM keep a bonding ledger. Stated out loud rather than silently
 * assumed.
 */
function _isMonkWeapon(item, { kensei = false, edition = "2014" } = {}) {
  const sys = item?.system ?? {};
  const type = String(sys.type?.value ?? "");
  const props = sys.properties ? new Set(sys.properties) : new Set();
  const base = String(sys.type?.baseItem ?? "").toLowerCase();

  const heavy = props.has("hvy");
  const twoHanded = props.has("two");
  const special = props.has("spc");

  if (type === "simpleM") {
    // 2014 excludes two-handed and heavy; 2024 admits every simple melee.
    if (edition === "2024") return true;
    return !twoHanded && !heavy;
  }
  if (type === "martialM") {
    if (base === "shortsword") return true;                 // named in both editions
    if (edition === "2024" && props.has("lgt")) return true; // 2024: martial + light
    // Kensei: a chosen martial melee weapon counts as a monk weapon, so long as
    // it is neither heavy nor special.
    if (kensei && !heavy && !special) return true;
  }
  // Unarmed strikes are monk weapons in both editions.
  if (type === "unarmed" || base === "unarmed" || /unarmed/i.test(item?.name ?? "")) return true;
  return false;
}

/**
 * Is a Shillelagh currently running on this creature?
 *
 * ⚠️ IT IS AN EFFECT, NOT A FEATURE. Pact of the Blade is permanent; a
 * Shillelagh lasts a minute. Looking for a feat item named "Shillelagh" would
 * hand a druid their Wisdom on a club forever, whether or not they cast it.
 * The ACTIVE EFFECT is the only honest signal.
 */
function _shillelaghActive(actor) {
  try {
    return (actor.effects ?? []).some(e =>
      !e.disabled && !e.isSuppressed && /shillelagh/i.test(String(e.name ?? "")));
  } catch (_) { return false; }
}

function _resolveAbilityOverride(actor, item) {
  const decline = (why) => {
    try { console.debug(`${MODULE_ID} | [ability-resolver] no override for "${item?.name}": ${why}`); } catch (_) {}
    return null;
  };
  try {
    if (!actor || item?.type !== "weapon") return null;   // not a weapon swing — silent
    // ⚠️ THE SETTING IS NAMED FOR PACT WEAPONS AND ONLY GATES THEM. Silencing
    // Shillelagh and Martial Arts with a toggle called "Pact Weapon:
    // Auto-Charisma" would be a switch that does something its label does not
    // say. Checked at the pact branch below instead.


    // NO equipped gate. Johnny's table rule (2026-07-09): ANY weapon this character
    // attacks with counts as their bonded pact weapon — sheets' equipped flags are
    // not maintained in play (his live halberd sat equipped:false while being swung).


    const edition = CombatState.getActiveEdition(actor);

    // ── SHILLELAGH ─────────────────────────────────────────────────────────
    // "You can use your spellcasting ability instead of Strength for the attack
    // and damage rolls of melee attacks using that weapon." Club and
    // quarterstaff only, and only while the spell is actually running.
    //
    // ⚠️ THE WEAPON MATTERS AS MUCH AS THE EFFECT. A druid with Shillelagh
    // up is not swinging a longsword with Wisdom.
    if (_shillelaghActive(actor)) {
      const base = String(item?.system?.type?.baseItem ?? "").toLowerCase();
      const named = /club|quarterstaff/i.test(item?.name ?? "");
      if (base === "club" || base === "quarterstaff" || named) {
        const key = String(actor.system?.attributes?.spellcasting ?? "") || null;
        const scMod = Number(actor.system?.abilities?.[key]?.mod);
        if (key && Number.isFinite(scMod)) {
          return { ability: key, mod: scMod, why: "Shillelagh" };
        }
        return decline("Shillelagh is up but this creature declares no spellcasting ability");
      }
      // Effect running, wrong weapon — say so rather than silently declining.
      return decline(`Shillelagh is up, but "${item?.name}" is not a club or quarterstaff`);
    }

    // ── MARTIAL ARTS, and KENSEI which widens what counts ──────────────────
    // "You can use Dexterity instead of Strength for the attack and damage
    // rolls of your Unarmed Strikes and Monk Weapons."
    //
    // ⚠️ dnd5e ALREADY OFFERS DEX ON A FINESSE WEAPON, so a monk's shortsword
    // was never the gap. The quarterstaff was: simple melee, not two-handed,
    // not heavy, and not finesse, so the system offers Strength alone.
    const martialArts = _findFeat(actor, "martial arts");
    if (martialArts) {
      const kensei = !!_findFeat(actor, "kensei");
      if (_isMonkWeapon(item, { kensei, edition })) {
        const dexMod = Number(actor.system?.abilities?.dex?.mod);
        if (Number.isFinite(dexMod)) {
          return { ability: "dex", mod: dexMod,
            why: kensei && String(item?.system?.type?.value ?? "") === "martialM"
              ? "Martial Arts (Kensei weapon)" : "Martial Arts" };
        }
      } else {
        return decline(`Martial Arts applies to monk weapons; "${item?.name}" is not one`);
      }
    }

    const potb = _findFeat(actor, "pact of the blade");
    const hexW = _findFeat(actor, "hex warrior");
    if (!potb && !hexW) return null;                      // no pact features at all — silent

    // Edition: the FEATURE'S edition outranks the world's. Mixed-edition worlds are
    // real — hijinx is a legacy(2014) CoS world whose PCs carry PHB-2024 features.
    // A 2024-sourced Pact of the Blade grants the CHA option wherever it's used;
    // a 2014 PotB grants CHA only via Hexblade's Hex Warrior (RAW both editions).
    const potbIs2024 = String(potb?.system?.source?.rules ?? "") === "2024";
    const worldIs2024 = edition === "2024";
    // ⚠️ THE CHA READ MOVED DOWN HERE. It used to sit above every rule and
    // bail out early, which would have refused Shillelagh and Martial Arts for
    // any creature without a Charisma modifier — a gate for one rule blocking
    // three.
    const chaMod = Number(actor.system?.abilities?.cha?.mod);
    if (!Number.isFinite(chaMod)) return decline("no CHA mod");
    try {
      if (game.settings.get(MODULE_ID, "pactWeaponCharisma") === false) {
        return decline("the Pact Weapon: Auto-Charisma setting is off");
      }
    } catch (_) { /* setting unregistered — the rule stands */ }
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

  /**
   * ⚠️ EXPOSED ON THE API so the resolver can ask without importing this
   * file. `profiles/resolver.mjs` is a leaf that benches run outside Foundry;
   * a hard import of a module that reads game settings would make it
   * untestable, so it looks this up lazily through `game.aceQol`.
   */
  static registerApi() {
    try {
      game.aceQol = game.aceQol ?? {};
      Object.assign(game.aceQol, { attackAbilityResolver: AttackAbilityResolver });
    } catch (err) {
      console.warn(`${MODULE_ID} | could not expose the attack ability resolver:`, err);
    }
  }

  static register() {
    AttackAbilityResolver.registerApi();

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
