// ─── ACE: QOL — Combat Context (the shared "read everything" engine) ──────────
//
// THE single brain that BOTH weapon attacks AND spell casts funnel through. It
// reads the four things that matter the instant any token acts — the ACTOR, the
// ACTION (weapon/spell), the TARGET, and the ENVIRONMENT — and answers the three
// moments of every action:
//
//   1. CAN they take it?        → canAct()        (hard gates; block with a reason)
//   2. Does it COME OFF?        → attackAdvantage()(net advantage/disadvantage)
//   3. What EFFECT does it have? → conditionImmune(), magicWeaponResisted(), …
//
// Design rules (see memory: combat_resolution_engine_spec.md):
//   • ONE brain — add a rule here once and weapons + spells both obey it. (The
//     "incapacitated blocks attacks but not spells" bug came from two separate
//     checkers; this module is the cure.)
//   • NEVER false-block a legitimate action. A missing gate is a minor miss; a
//     false block breaks play. When detection is uncertain (free hands, Subtle
//     Spell), DEFAULT TO ALLOW and only block on high confidence.
//   • Edition-aware (2014 "legacy" / 2024 "modern") throughout.
//   • Reuse existing proven pieces (geometry-utils distance, damage-calculator
//     resistance, etc.) rather than re-deriving them.
//
// This file is built out rule-by-rule against the spec checklist. Stubs that
// need deeper positional/inventory reads are clearly marked TODO so an audit can
// see exactly what is and isn't enforced yet.
// ──────────────────────────────────────────────────────────────────────────────

import { MODULE_ID } from "./ace-qol.mjs";
import { CombatState } from "./combat-state.mjs";
import { Situation } from "./situation.mjs";
// Rules-engine space query (Phase 1, 2026-07-09): the verbal-casting gate
// reads live Silence spaces. Function-time reads only — import cycle inert.
import { SpaceEffects } from "./rules/space-effects.mjs";

// Conditions that fully prevent taking actions. RAW: Paralyzed, Stunned,
// Unconscious, and Petrified each INCLUDE the Incapacitated condition, and an
// Incapacitated creature "can't take actions, bonus actions, or reactions"
// (2024 wording; 2014 says actions + reactions — bonus actions blocked by Sage
// Advice). Same list both editions.
const CANT_ACT = ["incapacitated", "paralyzed", "stunned", "unconscious", "petrified"];

// Activation costs that the can't-act gate applies to — the per-turn / per-round
// action economy. Passive / "special" / "none" / out-of-combat casts are NOT
// gated (a creature can still be the target of a passive effect while down).
const ACTION_ECONOMY = new Set(["action", "bonus", "reaction", "legendary", "lair", "mythic", "crew"]);

// Conditions on the ATTACKER that impose disadvantage on its attack rolls.
// (Frightened is conditional on the fear source being visible — handled below.)
const ATTACKER_DISADV = ["prone", "poisoned", "restrained", "blinded"];

// Conditions on the TARGET that grant advantage to attacks against it.
const TARGET_GIVES_ADV = ["blinded", "paralyzed", "restrained", "stunned", "unconscious", "petrified"];

export class CombatContext {

  // ════════════════════════════════════════════════════════════════════════
  //  Helpers
  // ════════════════════════════════════════════════════════════════════════

  /** "legacy" (2014) | "modern" (2024). */
  static edition() {
    return CombatState.getActiveRulesVersion();  // honors ACE gameRulesEdition override
  }

  static _name(actor) {
    return actor?.token?.name ?? actor?.name ?? "Creature";
  }

  static _statuses(actor) {
    // THE status reader (Rule #1 convergence, 2026-07-27). This is the HARD
    // can-act gate's condition source — it read `actor.statuses` alone, so a
    // status carried by a live effect but missing from that set (desync) could
    // let an incapacitated creature act. Same reader as the attack + save
    // flows now, so a gate can never disagree with an engine.
    return Situation.readStatuses(actor);
  }

  /** Spell component flags, reading both the 5.x `properties` Set and legacy `components`. */
  static _components(item) {
    const p = item?.system?.properties;
    const has = (k) => (p?.has?.(k)) || (Array.isArray(p) && p.includes(k));
    const c = item?.system?.components ?? {};
    return {
      v: has("vocal")    || c.vocal    === true,
      s: has("somatic")  || c.somatic  === true,
      m: has("material") || c.material === true,
    };
  }

  /** Does this actor KNOW Subtle Spell (metamagic that drops V + S)? If so we must
   *  not hard-block their casting on Silence / no-free-hand — they may be using it. */
  static _knowsSubtle(actor) {
    try {
      return (actor?.items ?? []).some(i =>
        i.type === "feat" && /subtle\s*spell/i.test(i.name ?? ""));
    } catch (_) { return false; }
  }

  /** Component-free caster? Monster innate spellcasting + actors flagged as such
   *  cast without V/S/M, so the component gates don't apply. Conservative: treat
   *  any non-character (NPC) innate-style caster as exempt unless we can prove
   *  components are required. */
  static _isInnateCaster(actor, item) {
    try {
      // ⚠️ NEW FIELD FIRST. dnd5e 5.1 split preparation into `method` and
      // `prepared`, and reading the old name logs a compatibility warning that
      // builds a full stack trace EVERY time. With `??` the right-hand side is
      // only evaluated when the left is missing, so this order costs nothing on
      // 5.1+ and still works on 5.0. Written the other way round it fired on
      // every spell of every caster — action-bar.mjs was fixed for exactly this
      // and these two were left behind. Removed outright in dnd5e 6.0.
      const mode = item?.system?.method ?? item?.system?.preparation?.mode;
      if (mode === "innate" || mode === "atwill") return true;
    } catch (_) { /* fall through */ }
    return false;
  }

  /** Can the actor make sound (for Verbal components)? Blocked by Silenced status,
   *  a Silence flag on the actor, or — LIVE via the rules engine (Phase 1) —
   *  standing inside a Silence spell's space. Conservative by construction:
   *  the space check only blocks when the token's position provably sits
   *  inside a silence region; any uncertainty answers "can speak". */
  static _canSpeak(actor, statuses) {
    if (statuses.has("silenced") || statuses.has("silence")) return false;
    if (actor?.flags?.[MODULE_ID]?.silenced) return false;
    try {
      const token = actor?.getActiveTokens?.()?.[0] ?? null;
      if (token && SpaceEffects.tokenInSilence(token)) return false;
    } catch (_) { /* permissive — never false-block a cast */ }
    return true;
  }

  // ════════════════════════════════════════════════════════════════════════
  //  MOMENT 1 — CAN THEY TAKE THE ACTION?  (hard gates)
  // ════════════════════════════════════════════════════════════════════════

  /**
   * The shared hard gate. Returns { ok:true } or { ok:false, reason, condition }.
   * Both the attack pipeline and the spell pipeline call this — one brain.
   *
   * @param {Actor5e} actor
   * @param {object}  opts
   * @param {string}  opts.activationType  "action"|"bonus"|"reaction"|… (gates only the action economy)
   * @param {boolean} opts.isSpell
   * @param {Item5e}  opts.item            the weapon or spell
   * @param {string}  opts.verb            display verb ("attack"|"cast"|…)
   */
  static canAct(actor, { activationType = "action", isSpell = false, item = null, verb } = {}) {
    if (!actor) return { ok: true };
    verb ??= isSpell ? "cast" : "act";

    // Only gate the action economy; free / passive / out-of-combat uses pass.
    if (activationType && !ACTION_ECONOMY.has(activationType)) return { ok: true };

    const statuses = this._statuses(actor);

    // (a) Incapacitating conditions — block EVERYTHING (RAW, both editions).
    const blocking = CANT_ACT.find(c => statuses.has(c));
    if (blocking) {
      return { ok: false, condition: blocking, reason: `${this._name(actor)} is ${blocking.toUpperCase()} — cannot ${verb}.` };
    }

    // (b) Spell-only magical lockouts.
    if (isSpell && item) {
      const lock = this._spellLockout(actor, item, statuses);
      if (lock) return { ok: false, reason: lock };
    }

    return { ok: true };
  }

  /**
   * Magical / component lockouts for SPELLS. Returns a reason string, or null to
   * allow. Conservative by construction — only blocks when we're confident the
   * caster genuinely can't cast (never false-blocks Subtle Spell / innate casters).
   */
  static _spellLockout(actor, item, statuses) {
    // Antimagic Field — no spell of any kind functions inside.
    if (statuses.has("antimagic") || actor?.flags?.[MODULE_ID]?.antimagic) {
      return `${this._name(actor)} is in an Antimagic Field — cannot cast.`;
    }

    // Feeblemind / mind-broken (INT or CHA = 1) — flagged by the effect that sets it.
    if (actor?.flags?.[MODULE_ID]?.cantCast) {
      return `${this._name(actor)} can't form a spell right now.`;
    }

    // Verbal component vs Silence. Skip if the caster could be using Subtle Spell
    // or is an innate/component-free caster — never false-block them.
    const comps = this._components(item);
    if (comps.v && !this._knowsSubtle(actor) && !this._isInnateCaster(actor, item)) {
      if (!this._canSpeak(actor, statuses)) {
        return `${this._name(actor)} can't speak (Silenced) — cannot cast a verbal spell.`;
      }
    }

    // NOTE (TODO, spec READ 1A): Somatic/Material free-hand gating is deliberately
    // NOT enforced yet — reliable free-hand detection needs equipped-item/2-hand
    // analysis, and a wrong read here would false-block legitimate casts. Tracked.
    return null;
  }

  // ════════════════════════════════════════════════════════════════════════
  //  MOMENT 2 — DOES IT COME OFF?  (net advantage / disadvantage)
  // ════════════════════════════════════════════════════════════════════════

  /**
   * Aggregate every source of advantage / disadvantage on an attack roll, from
   * the attacker's conditions, the target's conditions, and positioning. RAW:
   * any number of advantage sources is still just ADVANTAGE; any number of
   * disadvantage sources is still just DISADVANTAGE; one of each = a straight
   * roll. We collect both sides with reasons and net them.
   *
   * Returns { advantage:bool, disadvantage:bool, net:"adv"|"dis"|"normal", reasons:string[] }.
   *
   * (Read layer — wiring this into the actual d20 happens at the attack-roll hook;
   * kept pure so it's trivially testable and auditable.)
   */
  static attackAdvantage({ attacker, target, isRanged = false } = {}) {
    const adv = [];
    const dis = [];

    const aSt = this._statuses(attacker);
    const tSt = this._statuses(target);

    // ── Attacker's own conditions ──
    if (attacker?.statuses) {
      if (aSt.has("invisible")) adv.push("attacker is invisible/unseen");
      for (const c of ATTACKER_DISADV) if (aSt.has(c)) dis.push(`attacker is ${c}`);
      // Frightened imposes disadvantage only while the fear source is in sight;
      // in practice during combat it is, so we apply it (over-applying disadvantage
      // is far less harmful than a false block). Refine with a line-of-sight read.
      if (aSt.has("frightened")) dis.push("attacker is frightened");
    }

    // ── Target's conditions (attacks AGAINST it) ──
    if (target?.statuses) {
      for (const c of TARGET_GIVES_ADV) if (tSt.has(c)) adv.push(`target is ${c}`);
      if (tSt.has("invisible")) dis.push("target is invisible/unseen");
      if (tSt.has("dodging")) dis.push("target is dodging");
      // Prone is directional: melee gets advantage, ranged gets disadvantage.
      if (tSt.has("prone")) {
        if (isRanged) dis.push("target is prone (ranged)");
        else adv.push("target is prone (melee)");
      }
    }

    const advantage = adv.length > 0;
    const disadvantage = dis.length > 0;
    const net = advantage && disadvantage ? "normal" : advantage ? "adv" : disadvantage ? "dis" : "normal";
    return { advantage, disadvantage, net, reasons: [...adv.map(r => `ADV: ${r}`), ...dis.map(r => `DIS: ${r}`)] };
  }

  // ════════════════════════════════════════════════════════════════════════
  //  MOMENT 3 — WHAT EFFECT DOES IT HAVE?  (defense reads)
  // ════════════════════════════════════════════════════════════════════════

  /**
   * Is the target immune to a given condition? RAW: don't apply Charmed to a
   * construct, Poisoned to an undead, etc. Reads dnd5e condition-immunity traits.
   * `conditionId` is a dnd5e status id ("charmed","poisoned","frightened","paralyzed",…).
   */
  static conditionImmune(target, conditionId) {
    try {
      const ci = target?.system?.traits?.ci;
      if (!ci) return false;
      const id = String(conditionId ?? "").toLowerCase();
      if (ci.value?.has?.(id)) return true;
      if (Array.isArray(ci.value) && ci.value.includes(id)) return true;
      // Custom free-text immunities (best-effort substring match).
      const custom = String(ci.custom ?? "").toLowerCase();
      if (custom && id && custom.includes(id)) return true;
    } catch (_) { /* fall through */ }
    return false;
  }

  /**
   * Does the target resist/ignore this weapon because it isn't magical? The classic
   * "resistance to bludgeoning/piercing/slashing from nonmagical attacks" line.
   * Returns true when the weapon is NONmagical AND the target has that resistance.
   */
  static magicWeaponResisted(target, weapon) {
    try {
      const isMagic = weapon?.system?.properties?.has?.("mgc") === true
        || Number(weapon?.system?.magicalBonus ?? 0) > 0;
      if (isMagic) return false;
      const dr = target?.system?.traits?.dr;
      const custom = String(dr?.custom ?? "").toLowerCase();
      // dnd5e flags this via a bypass set; the canonical phrasing lives in custom.
      const phys = dr?.bypasses?.has?.("mgc") || /nonmagical/.test(custom);
      return !!phys;
    } catch (_) { return false; }
  }

  // ════════════════════════════════════════════════════════════════════════
  //  Wiring — both pipelines funnel through canAct() here.
  // ════════════════════════════════════════════════════════════════════════

  static init() {
    // SPELLS + FEATURES — gate any non-weapon activity use. Weapon attacks are
    // gated inside the attack pipeline (same canAct() brain) so they don't
    // double-fire here. RAW: an incapacitated creature can't cast or use an
    // action-cost feature. Returning false cancels the use.
    Hooks.on("dnd5e.preUseActivity", (activity, usageConfig) => {
      try {
        const item = activity?.item;
        if (!item || item.type === "weapon") return;     // weapons handled in attack-pipeline
        const actor = activity?.actor ?? item.actor;
        const gate = CombatContext.canAct(actor, {
          isSpell: item.type === "spell",
          item,
          activationType: activity?.activation?.type ?? "action",
          verb: item.type === "spell" ? "cast" : "use that",
        });
        if (!gate.ok) {
          ui.notifications?.warn(`ACE QOL: ${gate.reason}`);
          return false;
        }
      } catch (err) {
        console.warn(`${MODULE_ID} | CombatContext preUseActivity gate threw (non-fatal):`, err);
      }
    });

    console.debug(`${MODULE_ID} | CombatContext online — shared combat engine (edition: ${CombatContext.edition()})`);
  }
}
