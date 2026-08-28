// ─── THE ONE GATE — one door, three scans, a verdict before every die ────────
//
// Spec: docs/ONE_GATE_ARCHITECTURE.md. Phase 1.
//
// ⚠️🔴 WHY THIS FILE EXISTS AT ALL. Five pipelines (attack, save, damage, spell,
// heal) each decided for themselves what to check before rolling, and the save
// engine's own numbers were: 4 of ~25 target fields read, attacker profile 0,
// environment 0, canAct 0. A dead Specter rolled two saves against Petrifying
// Gaze and was then told it was immune to the outcome.
//
// ⚠️ THE FAILURE THIS REPLACES IS NOT "A MISSING CHECK". It is every engine
// being free to forget one. Fixing the engine that surfaced the bug leaves the
// next engine free to forget the same thing, which is how it comes back. So the
// checks move to ONE place that every engine has to ask.
//
// ⚠️ AND A GATE NOBODY CALLS IS THE SAME BUG WEARING A HAT. This has already
// happened twice in this codebase: `buildEnvironmentProfile` has exactly one
// caller in the whole suite and its result is never handed to the resolver, and
// `resolveAttack` is called twice with attacker and attack only, no environment
// and no target. BUILDING A PROFILE AND CONSULTING IT ARE DIFFERENT THINGS.
// This file ships wired into the save engine in the same commit for that reason.
//
// ⚠️ IT FAILS OPEN, ALWAYS. Every unknown, every throw, every missing profile
// means "roll normally", said out loud. A gate that fails closed silently
// deletes saving throws, the same shape as the wall checks that returned "no
// wall" out of a catch block twice on 2026-08-06.
import { buildTargetProfile }      from "../profiles/target-profile.mjs";
import { buildAttackerProfile }    from "../profiles/attacker-profile.mjs";
import { buildEnvironmentProfile } from "../profiles/environment-profile.mjs";

const TAG = "ace-qol | ActionGate";

export class ActionGate {

  /**
   * One verdict for one target. Null means "nothing stops it — roll".
   *
   * @param {object}   p
   * @param {Actor}    [p.attacker]        the acting creature
   * @param {Token}    [p.attackerToken]
   * @param {Actor}    p.targetActor
   * @param {Token}    [p.targetToken]
   * @param {object}   [p.targetProfile]   pass one in if you already built it
   * @param {string[]} [p.outcomes]        condition ids this action can inflict
   * @param {boolean}  [p.dealsDamage]     a save still earns half damage
   * @param {number}   [p.rangeFt]         ONLY pass when there is a real range to
   *                                       enforce. Omitted means the range scan
   *                                       does not run, which is correct for an
   *                                       area whose targets are already inside
   *                                       the template by construction.
   * @param {boolean}  [p.originIsAttacker] true for a single-target action, so
   *                                       line of effect may be measured from
   *                                       the caster. FALSE for an area: RAW
   *                                       measures line of effect from the
   *                                       template's own point of origin, and
   *                                       measuring from the caster would drop a
   *                                       creature round a corner from the
   *                                       wizard and squarely inside the blast.
   * @returns {{reason:string,label:string,tone:string,environment?:object}|null}
   */
  static verdictFor(p = {}) {
    try {
      // ⚠️ A PROFILE IS ENOUGH ON ITS OWN, AND THE GUARD HERE ALMOST SHIPPED
      // WRONG. The first version demanded `targetActor` before doing anything.
      // The target profile carries `actorId` and `actorUuid` and NOT `actor`,
      // so every caller passing a ready-made profile would have fallen straight
      // out of this function returning null, which reads as "nothing stops it,
      // roll" — silently re-enabling the dead Specter this whole document
      // exists to kill. Take whichever of the two the caller actually has.
      const tProfile = p.targetProfile
        ?? (p.targetActor ? buildTargetProfile(p.targetActor, { token: p.targetToken }) : null);
      if (!tProfile) return null;                     // genuinely unknown -> roll

      // Step 1 of the ordering rule: is this a legal target at all?
      // ⚠️ A PC AT 0 HP IS NOT DEAD. Unconscious and dying is still a legal
      // target that still rolls, auto-failing STR and DEX. Only the `dead`
      // marker gates a player, and `isDead` already encodes that distinction.
      if (tProfile.isDead) {
        return { reason: "dead", label: "DEAD — no save", tone: "dead" };
      }

      // ── SCAN 2: ENVIRONMENT ──────────────────────────────────────────────
      // Built for EVERY verdict, decisive or not, because the card and every
      // downstream consumer should be able to see where this happened. This is
      // the scan the save engine had never run even once.
      let env = null;
      if (p.attackerToken && p.targetToken) {
        try { env = buildEnvironmentProfile(p.attackerToken, p.targetToken); }
        catch (err) { console.warn(`${TAG} | environment scan failed, rolling anyway:`, err); }
      }

      // Out of range, only when a range was supplied AND the distance measured.
      if (env && Number.isFinite(p.rangeFt) && p.rangeFt > 0
          && Number.isFinite(env.distanceFt) && env.distanceFt > p.rangeFt) {
        return { reason: "out-of-range", environment: env, tone: "range",
          label: `OUT OF RANGE (${Math.round(env.distanceFt)} of ${Math.round(p.rangeFt)} feet)` };
      }

      // No line of effect. Single-target actions only, see originIsAttacker.
      // ⚠️ `effectBlocked` is null when it COULD NOT BE TESTED, which is not the
      // same as false. Only an explicit true blocks anything.
      if (env && p.originIsAttacker === true && env.effectBlocked === true) {
        return { reason: "no-line-of-effect", environment: env, tone: "blocked",
          label: "NO LINE OF EFFECT — wall" };
      }

      // ── SCAN 3: CAN THE ACTION DO ANYTHING AT ALL? ───────────────────────
      // ⚠️ Immunity is decisive only when nothing else is left to resolve. If
      // the action also deals damage the save still earns half on a success, so
      // it rolls and the card notes the immunity instead of eating the die.
      const outcomes = p.outcomes ?? [];
      if (!p.dealsDamage && outcomes.length) {
        const immune = outcomes.filter(c => tProfile.immuneToCondition?.(c));
        if (immune.length === outcomes.length) {
          const names = [...new Set(immune)].map(c => c.charAt(0).toUpperCase() + c.slice(1));
          return { reason: "immune", environment: env, tone: "immune",
            label: `IMMUNE to ${names.join(", ")} — no save` };
        }
      }

      return null;   // nothing decisive: roll
    } catch (err) {
      // ⚠️ FAIL OPEN AND SAY SO. The Gate must never be the invisible reason a
      // die was not thrown.
      console.error(`${TAG} | threw while judging a target, rolling normally:`, err);
      return null;
    }
  }

  /**
   * What the surroundings do to the roll, when the roll still happens.
   *
   * ⚠️ THE VERDICT IS ONLY HALF THE GATE'S JOB. Deciding that a die IS thrown
   * and then saying nothing about the gale blowing across the archer's line is
   * the same silence as never scanning at all. The architecture doc lists
   * `modifiers: {advantage, disadvantage, sources}` on the verdict for exactly
   * this, and it had never been produced.
   *
   * ⚠️ RANGED *WEAPON* ATTACKS ONLY, FOR THE WIND. The DMG gives strong wind
   * disadvantage on ranged weapon attack rolls. It says nothing about spell
   * attacks and nothing about melee, and widening it because it feels right
   * would quietly rewrite every druid's fight in a storm.
   *
   * @param {object} p
   * @param {object} p.environment  a built environment profile
   * @param {string} [p.resolution] "attack" | "save"
   * @param {boolean} [p.rangedWeapon] this is a ranged attack with a weapon
   * @returns {{advantage:boolean, disadvantage:boolean, sources:string[]}}
   */
  static modifiersFor({ environment: env, resolution = "attack", rangedWeapon = false } = {}) {
    const sources = [];
    let advantage = false, disadvantage = false;
    try {
      if (!env) return { advantage, disadvantage, sources };

      const w = env.weather;
      if (w?.known && rangedWeapon && w.effects?.rangedWeaponDisadvantage) {
        disadvantage = true;
        sources.push(`strong wind (${w.summary})`);
      }

      // Total cover is not a modifier, it is a refusal, and the range and
      // line-of-effect scans above already speak for it. Half and three-quarters
      // cover are an AC bonus rather than disadvantage, so they are reported
      // for the card and deliberately not folded in here.
      if (env.coverLevel && env.coverLevel !== "No Cover" && resolution === "attack") {
        sources.push(`${env.coverLevel} (+${env.coverAcBonus} AC)`);
      }

      // A target you cannot see is attacked at disadvantage; an attacker nobody
      // can see attacks at advantage. Both are real and both are already
      // measured on the profile.
      if (resolution === "attack" && env.heavilyObscuredAtTarget) {
        disadvantage = true;
        sources.push("the target is heavily obscured");
      }
      return { advantage, disadvantage, sources };
    } catch (err) {
      console.warn(`${TAG} | could not work out the modifiers (rolling straight):`, err);
      return { advantage: false, disadvantage: false, sources };
    }
  }

  /**
   * Verdicts for a whole target list — the shape the architecture doc specifies,
   * and what the attack, damage and heal pipelines call in Phase 2.
   */
  static open(p = {}) {
    const targets = p.targets ?? [];
    let attackerProfile = null;
    try {
      attackerProfile = buildAttackerProfile(p.actor, {
        token: p.token, item: p.item, activity: p.activity });
    } catch (err) {
      console.warn(`${TAG} | attacker scan failed, rolling anyway:`, err);
    }

    return targets.map(t => {
      const tok = t?.object ?? t;
      const actor = t?.actor ?? tok?.actor ?? null;
      const verdict = ActionGate.verdictFor({
        ...p,
        attacker: p.actor,
        attackerToken: p.token,
        targetActor: actor,
        targetToken: tok,
      });
      return { target: t, attackerProfile, verdict, outcome: verdict ? "no-roll" : "roll" };
    });
  }
}
