// ─── ACE: QOL — Pipeline Resolver: Damage ─────────────────────────────────────
// Builds the damage card for distribute / chained / single-target damage shapes.
// Uses the existing DamageCardRenderer.postDamageButton entry point.
// ──────────────────────────────────────────────────────────────────────────────

import { MODULE_ID } from "../../ace-qol.mjs";
import { DamageCalculator } from "../../damage-calculator.mjs";
import { DamageCardRenderer } from "../../damage-card-renderer.mjs";
import { TargetState } from "../../target-state.mjs";
import { CombatState } from "../../combat-state.mjs";
import { Situation } from "../../situation.mjs";   // ⚠️ WAS NEVER IMPORTED — see below
import { safeShowForRoll, awaitDiceSettle } from "../../dsn-utils.mjs";
import { AnimationHelper } from "../animation.mjs";

// ─── Creature snapshot access (2026-07-28) ───────────────────────────────────
// Facts about a creature come from the ONE reader, never from actor.system —
// the audit found every pipeline reaching into raw data and getting shapes
// wrong. Cached briefly; expired fast because state changes mid-fight.
const _aceCreatureCache = new Map();
function _aceCreature(actor, token = null) {
  if (!actor) return {};
  const key = actor.uuid ?? actor.id;
  const hit = _aceCreatureCache.get(key);
  if (hit) return hit;
  let c = {};
  // ⚠️ `Situation` WAS NEVER IMPORTED INTO THIS FILE (found 2026-07-28 by a
  // no-undef lint pass). Every call threw a ReferenceError, the swallow-catch
  // below turned it into an empty object, and this resolver has been reading a
  // BLANK creature snapshot ever since the profile conversion — silently, with
  // the conversion reported as done. A catch that discards the error hides a
  // missing import just as well as it hides a bad actor.
  try { c = Situation.readCreature(actor, token) ?? {}; }
  catch (err) { console.warn(`${MODULE_ID} | damage resolver: creature read failed for ${actor?.name}:`, err); c = {}; }
  _aceCreatureCache.set(key, c);
  setTimeout(() => _aceCreatureCache.delete(key), 3000);
  return c;
}


export class DamageResolver {

  /**
   * Distribute shape — Magic Missile, Scorching Ray.
   * Builds per-target hits array with N units of damage each (e.g. dart count).
   *
   * @param {object} ctx - { entry, item, actor, castLevel, ... }
   * @param {object} result - { distribution: Map<Actor, number> }
   */
  static async runDistribute(ctx, result) {
    const { entry, item, actor } = ctx;
    const distribution = result?.distribution;
    if (!(distribution instanceof Map) || distribution.size === 0) {
      console.warn(`${MODULE_ID} | DamageResolver.runDistribute: empty distribution`);
      return;
    }

    const unitFormula = entry.unit?.formula;
    const unitType    = entry.unit?.type ?? "force";
    if (!unitFormula) {
      console.error(`${MODULE_ID} | DamageResolver.runDistribute: registry entry missing unit.formula`);
      return;
    }

    const spellName = String(item.name ?? "").toLowerCase().trim();

    // ── PASSIVE NULLIFICATION SWEEP (v0.7.18) ──
    // Walk TargetState.assess() per target to check for:
    //   • Active Shield effect → MM immunity (RAW: "no damage from magic missile")
    //   • Brooch of Shielding equipped → MM immunity
    //   • Spell-name immunity registry entries
    //   • Damage type immunity for the unit's damage type
    // Filter these targets out of the distribution BEFORE prompting for Shield
    // (no point prompting someone who's already immune) AND post chat notes
    // explaining WHY each excluded target took no damage.
    let filteredDistribution = new Map();
    const nullifiedNotes = [];
    for (const [targetActor, darts] of distribution.entries()) {
      if (!targetActor || darts <= 0) continue;
      const token = targetActor.getActiveTokens?.()?.[0]
                 ?? canvas.tokens?.placeables.find(t => t.actor?.id === targetActor.id);
      if (!token) { filteredDistribution.set(targetActor, darts); continue; }

      let state = null;
      try { state = TargetState.assess(token, actor, item, [unitType], { isSpell: true }); }
      catch (err) { console.warn(`${MODULE_ID} | TargetState.assess threw (non-blocking):`, err); }

      // (1) Spell-by-name immunity (Shield→MM, Brooch→MM, future Globe→sub-5th, etc.)
      const spellImmune = state?.nullifications?.spellImmune ?? [];
      if (spellImmune.includes(spellName)) {
        const sources = state.nullifications?.spellImmuneSources?.[spellName] ?? ["spell immunity"];
        const reason = sources.join(", ");
        nullifiedNotes.push({ name: token.name ?? targetActor.name, reason, type: "spell-immune" });
        console.log(`${MODULE_ID} | DamageResolver: ${targetActor.name} immune to ${spellName} via [${reason}] — ${darts} unit(s) nullified silently`);
        // Visual flash on the absorbing token — soft blue burst (JB2A free with PIXI fallback)
        AnimationHelper.flashNullification(token).catch(() => {});
        continue;  // do NOT add to filteredDistribution
      }

      // (2) Damage-type immunity (Force immunity vs MM, Fire immunity vs Fireball, etc.)
      const dmgMod = state?.damageModifiers?.[unitType]?.modifier;
      if (dmgMod === "immune") {
        const reason = state.damageModifiers[unitType]?.reason ?? `immune to ${unitType}`;
        nullifiedNotes.push({ name: token.name ?? targetActor.name, reason, type: "damage-immune" });
        console.log(`${MODULE_ID} | DamageResolver: ${targetActor.name} immune to ${unitType} via [${reason}] — units nullified`);
        AnimationHelper.flashNullification(token).catch(() => {});
        continue;
      }

      // Made it through — they take damage (possibly reduced by resistance, applied at card)
      filteredDistribution.set(targetActor, darts);
    }

    if (filteredDistribution.size === 0 && nullifiedNotes.length) {
      await DamageResolver._postNullificationCard(item, actor, nullifiedNotes);
      ui.notifications?.info(`${item.name}: all targets are immune — no damage applied.`);
      return;
    }

    // ── Shield-CAST reaction prompt (existing v0.7.17 behavior) ──
    // Now ONLY prompts targets that aren't already passively immune above.
    try {
      const reactionEng = game.aceQol?.reactionEngine;
      if (reactionEng?.checkMagicMissileShield) {
        filteredDistribution = await reactionEng.checkMagicMissileShield(filteredDistribution, actor, item);
        if (!filteredDistribution || filteredDistribution.size === 0) {
          if (nullifiedNotes.length) await DamageResolver._postNullificationCard(item, actor, nullifiedNotes);
          ui.notifications?.info(`${item.name}: all targets used Shield — no damage applied.`);
          console.log(`${MODULE_ID} | DamageResolver.runDistribute: all targets shielded — aborted`);
          return;
        }
      }
    } catch (err) {
      console.warn(`${MODULE_ID} | DamageResolver: Shield check failed (non-blocking):`, err);
    }

    // ── If any targets were nullified silently, post the explainer card ──
    if (nullifiedNotes.length) {
      await DamageResolver._postNullificationCard(item, actor, nullifiedNotes);
    }

    // ── Build hits[] ──
    const hits = [];
    let firstHit = true;
    for (const [targetActor, units] of filteredDistribution.entries()) {
      if (!targetActor || units <= 0) continue;
      const token = targetActor.getActiveTokens?.()?.[0]
                 ?? canvas.tokens?.placeables.find(t => t.actor?.id === targetActor.id);
      if (!token) continue;

      const combinedFormula = DamageResolver._scaleFormulaToUnits(unitFormula, units);

      hits.push({
        target: {
          name:      token.name ?? targetActor.name,
          img:       targetActor.img ?? token.document?.texture?.src,
          currentHP: _aceCreature(targetActor)?.hp?.value ?? 0,
          maxHP:     _aceCreature(targetActor)?.hp?.max ?? 0,
        },
        targetActor,
        targetToken: token,
        hitResult:   "hit",
        d20Result:   null,
        isCritRoll:  false,
        damageModifiers: DamageCalculator.getTargetDamageModifiers(targetActor, item),
        name: token.name ?? targetActor.name,
        img:  targetActor.img ?? token.document?.texture?.src,
        ac:   _aceCreature(targetActor)?.ac ?? 0,
        // The DamageCalculator looks for this magicMissileOverride field.
        // Reusing the same field name keeps backward compatibility with
        // the v0.7.17 fork; future "distribute" spells (Scorching Ray) can
        // route through the same shape.
        magicMissileOverride: {
          formula: combinedFormula,
          type:    unitType,
          darts:   units,
        },
        // Empowered Evocation (Wizard Evocation 10+): one damage roll of
        // any wizard evocation spell adds spellcasting mod. Apply to the
        // FIRST hit; override widget on the damage card lets player change.
        applyEmpoweredEvocation: firstHit,
      });
      firstHit = false;
    }

    if (!hits.length) {
      console.warn(`${MODULE_ID} | DamageResolver.runDistribute: distribution had entries but no tokens resolved`);
      return;
    }

    // ── Post the damage card ──
    await DamageCardRenderer.postDamageButton(item, actor, hits, []);
    console.debug(`${MODULE_ID} | DamageResolver.runDistribute: posted damage card for ${item.name} (${hits.length} targets)`);
  }

  /**
   * Attack-multi shape — Eldritch Blast beams, Scorching Ray rays (the Phase 4
   * promise, built 2026-07-10). Each unit is its OWN ranged spell attack roll
   * against its target's AC; hits (crits bake double dice) flow into the
   * normal per-target damage card. A volley card shows every to-hit first —
   * nothing resolves invisibly.
   *
   * Design notes:
   *   • Units roll their own d20s (to-hit derived from dnd5e's labels, with a
   *     computed spellcasting fallback) instead of activity.rollAttack — this
   *     keeps the attack-hook engines (merge cards, fumble, multiattack,
   *     speed-rolls) quiet BY CONSTRUCTION. The pipeline owns its spells
   *     end-to-end, same as Magic Missile's darts.
   *   • Advantage/disadvantage per TARGET from CombatState.assess — darkness,
   *     devil's sight, prone, invisibility all apply, and cancellation shows.
   *   • Nat 20 = hit + crit (extra unit dice, RAW). Nat 1 = miss, always.
   *   • Agonizing Blast: +CHA per Eldritch Blast beam that HITS, carried as a
   *     labeled extra component ("+5 CHA / Agonizing Blast") per target.
   *
   * @param {object} ctx - { entry, item, actor, activity, castLevel }
   * @param {object} result - { distribution: Map<Actor, number> }
   */
  static async runAttackMulti(ctx, result) {
    const { entry, item, actor, activity } = ctx;
    let distribution = result?.distribution;
    if (!(distribution instanceof Map) || distribution.size === 0) {
      // Purple-picker path: an ordered target list, not a counter map.
      // Round-robin the units across the picks — one target gets them all,
      // two targets split them front-loaded on the first pick, etc.
      const picked = (result?.targets ?? []).map(t => t?.actor).filter(Boolean);
      if (picked.length) {
        const charLevel = _aceCreature(actor)?.level
          ?? 1;
        const N = entry.countResolver?.(ctx.castLevel, charLevel) ?? picked.length;
        distribution = DamageResolver._distributeUnits(picked, N);
      }
    }
    if (!(distribution instanceof Map) || distribution.size === 0) {
      console.warn(`${MODULE_ID} | DamageResolver.runAttackMulti: no targets resolved`);
      return;
    }

    const unitFormula = entry.unit?.formula;
    const unitType    = entry.unit?.type ?? "force";
    const noun        = entry.unitNoun ?? "beam";
    if (!unitFormula) {
      console.error(`${MODULE_ID} | DamageResolver.runAttackMulti: registry entry missing unit.formula`);
      return;
    }

    const spellName = String(item.name ?? "").toLowerCase().trim();

    // ── Passive nullification sweep (same as distribute — don't roll d20s
    //    at creatures the spell can't touch; explain why instead) ──
    let filtered = new Map();
    const nullifiedNotes = [];
    for (const [targetActor, units] of distribution.entries()) {
      if (!targetActor || units <= 0) continue;
      const token = targetActor.getActiveTokens?.()?.[0]
                 ?? canvas.tokens?.placeables.find(t => t.actor?.id === targetActor.id);
      if (!token) { filtered.set(targetActor, units); continue; }

      let state = null;
      try { state = TargetState.assess(token, actor, item, [unitType], { isSpell: true }); }
      catch (err) { console.warn(`${MODULE_ID} | TargetState.assess threw (non-blocking):`, err); }

      const spellImmune = state?.nullifications?.spellImmune ?? [];
      if (spellImmune.includes(spellName)) {
        const sources = state.nullifications?.spellImmuneSources?.[spellName] ?? ["spell immunity"];
        nullifiedNotes.push({ name: token.name ?? targetActor.name, reason: sources.join(", "), type: "spell-immune" });
        AnimationHelper.flashNullification(token).catch(() => {});
        continue;
      }
      const dmgMod = state?.damageModifiers?.[unitType]?.modifier;
      if (dmgMod === "immune") {
        const reason = state.damageModifiers[unitType]?.reason ?? `immune to ${unitType}`;
        nullifiedNotes.push({ name: token.name ?? targetActor.name, reason, type: "damage-immune" });
        AnimationHelper.flashNullification(token).catch(() => {});
        continue;
      }
      filtered.set(targetActor, units);
    }

    if (nullifiedNotes.length) await DamageResolver._postNullificationCard(item, actor, nullifiedNotes);
    if (filtered.size === 0) {
      ui.notifications?.info(`${item.name}: all targets are immune — no ${noun}s rolled.`);
      return;
    }

    // ── Agonizing Blast (Eldritch Blast only): +CHA per beam that hits ──
    let agonizingPerUnit = 0;
    try {
      if (/eldritch\s*blast/i.test(item.name ?? "")) {
        // The live helper requires the spell item (it verifies the spell IS
        // Eldritch Blast); calling it with only the actor returned 0 forever,
        // so every beam silently lost +CHA. (Audit, 2026-07-27.)
        agonizingPerUnit = CombatState.getAgonizingBlastBonus?.(actor, item) ?? 0;
      }
    } catch (_) { agonizingPerUnit = 0; }

    // ── Roll the volley: one d20 per unit vs its target's AC ──
    const volleyRows = [];
    const hits = [];
    let firstHit = true;
    let unitNo = 0;

    for (const [targetActor, units] of filtered.entries()) {
      const token = targetActor.getActiveTokens?.()?.[0]
                 ?? canvas.tokens?.placeables.find(t => t.actor?.id === targetActor.id);
      if (!token) continue;
      const ac = _aceCreature(targetActor)?.ac ?? 10;
      const targetName = token.name ?? targetActor.name;

      // Situational brain — the SAME assess the weapon pipeline uses, so
      // darkness / devil's sight / prone / invisibility all shape the volley.
      let advantage = false, disadvantage = false;
      let situNote = "";
      try {
        const state = CombatState.assess(actor, token, item, { isSpell: true });
        const advS = state?.advantageSources ?? [];
        const disS = state?.disadvantageSources ?? [];
        if (advS.length && !disS.length) {
          advantage = true;
          situNote = `ADV — ${advS.map(s => s.reason).join("; ")}`;
        } else if (disS.length && !advS.length) {
          disadvantage = true;
          situNote = `DIS — ${disS.map(s => s.reason).join("; ")}`;
        } else if (advS.length && disS.length) {
          situNote = "adv/dis cancel — straight roll (RAW)";
        }
      } catch (err) {
        console.warn(`${MODULE_ID} | runAttackMulti: assess failed for ${targetName} (rolling straight):`, err);
      }

      let unitHits = 0, unitCrits = 0;
      for (let b = 0; b < units; b++) {
        unitNo++;
        const roll = await DamageResolver._rollUnitAttack(activity, item, actor, { advantage, disadvantage });
        if (!roll) { volleyRows.push({ target: targetName, n: unitNo, error: true, ac }); continue; }

        const d20die = roll.dice?.find(d => d.faces === 20);
        const kept = d20die?.results?.find(r => r.active !== false)?.result
                  ?? d20die?.total ?? null;
        const isCrit = kept === 20;
        const isFumble = kept === 1;
        const hit = !isFumble && (isCrit || roll.total >= ac);
        if (hit) { unitHits++; if (isCrit) unitCrits++; }

        volleyRows.push({ target: targetName, n: unitNo, d20: kept, total: roll.total, ac, hit, crit: isCrit, fumble: isFumble, situNote });
        // 3D dice — fire-and-forget; awaiting external modules is how we hang.
        // Through safeShowForRoll so the animation is REGISTERED: a raw call
        // here left awaitDiceSettle with nothing to wait on, and the volley
        // card could post while these dice were still in the air.
        safeShowForRoll(roll, "volley attack");
      }

      if (!unitHits) continue;

      // Crit units roll their dice twice (RAW) — baked as extra units so the
      // one combined roll per target stays honest. Flat parts don't double.
      const effectiveUnits = unitHits + unitCrits;
      const combinedFormula = DamageResolver._scaleFormulaToUnits(unitFormula, effectiveUnits);

      const extraComponents = [];
      if (agonizingPerUnit > 0) {
        extraComponents.push({
          name: "Agonizing Blast",
          flat: agonizingPerUnit * unitHits,
          ability: "CHA",
          type: unitType,
        });
      }

      hits.push({
        target: {
          name:      targetName,
          img:       targetActor.img ?? token.document?.texture?.src,
          currentHP: _aceCreature(targetActor)?.hp?.value ?? 0,
          maxHP:     _aceCreature(targetActor)?.hp?.max ?? 0,
        },
        targetActor,
        targetToken: token,
        hitResult:   "hit",
        d20Result:   null,
        isCritRoll:  false,   // crit dice pre-baked above — do NOT double again
        damageModifiers: DamageCalculator.getTargetDamageModifiers(targetActor, item),
        name: targetName,
        img:  targetActor.img ?? token.document?.texture?.src,
        ac,
        magicMissileOverride: {
          formula: combinedFormula,
          type:    unitType,
          darts:   unitHits,
          extraComponents,
        },
        applyEmpoweredEvocation: firstHit,
      });
      firstHit = false;
    }

    // ── ⚠️🔴 LET THE DICE LAND. THIS IS THE HALF THAT WAS NEVER DONE.
    //
    // The comment forty lines up says it outright: a raw dice call "left
    // awaitDiceSettle with nothing to wait on, and the volley card could post
    // while these dice were still in the air." Whoever wrote that fixed the
    // REGISTERING half — the roll goes through safeShowForRoll so the animation
    // is tracked — and never added the wait it was registered FOR. So every
    // beam's d20 was dutifully recorded as in flight, and then the card posted
    // immediately anyway.
    //
    // Johnny has been reporting this for months: "the dice still doesn't stop
    // rolling before the card comes up." The damage card learned to wait on
    // 2026-07-13. The ATTACK card never did.
    //
    // ⚠️ THIS WAITS ON THE REAL ANIMATIONS, NOT A DURATION. It resolves the
    // moment the last die reports landing, and has its own backstop for a
    // renderer that breaks mid-tumble.
    await awaitDiceSettle();

    // ── The volley card — every to-hit on the table, misses included ──
    await DamageResolver._postVolleyCard(item, actor, volleyRows, noun);

    if (!hits.length) {
      ui.notifications?.info(`${item.name}: every ${noun} missed.`);
      console.log(`${MODULE_ID} | runAttackMulti: ${item.name} — full miss (${volleyRows.length} ${noun}s)`);
      return;
    }

    await DamageCardRenderer.postDamageButton(item, actor, hits, []);
    console.debug(`${MODULE_ID} | runAttackMulti: ${item.name} — ${hits.length} target(s) hit, damage card posted`);
  }

  /**
   * Round-robin N units across an ordered actor list → Map<Actor, count>.
   * [A] × 3 → A:3.  [A,B] × 3 → A:2, B:1.  [A,B,C] × 2 → A:1, B:1.
   * Pure — the volley self-test proves these laws.
   */
  static _distributeUnits(actors, n) {
    const map = new Map();
    const list = (actors ?? []).filter(Boolean);
    const total = Math.max(0, Number(n) || 0);
    if (!list.length || !total) return map;
    for (let i = 0; i < total; i++) {
      const a = list[i % list.length];
      map.set(a, (map.get(a) ?? 0) + 1);
    }
    return map;
  }

  /**
   * One unit's ranged spell attack roll. To-hit comes from dnd5e's own labels
   * (activity first, item fallback) so item bonuses ride along; when labels
   * are absent (rare NPC data), compute spellcasting mod + proficiency.
   * Advantage/disadvantage = 2d20kh/kl per RAW.
   */
  static async _rollUnitAttack(activity, item, actor, { advantage, disadvantage }) {
    try {
      let bonus = NaN;
      const label = activity?.labels?.toHit ?? item?.labels?.toHit ?? null;
      if (label != null) bonus = parseInt(String(label).replace(/\s/g, ""), 10);
      if (!Number.isFinite(bonus)) {
        const _c = _aceCreature(actor);
        const mod = _c?.spellMod ?? 0;
        const prof = _c?.prof ?? 0;
        bonus = mod + prof;
      }
      const die = advantage ? "2d20kh" : disadvantage ? "2d20kl" : "1d20";
      const roll = new Roll(`${die} + ${bonus}`);
      await roll.evaluate();
      return roll;
    } catch (err) {
      console.warn(`${MODULE_ID} | _rollUnitAttack failed:`, err);
      return null;
    }
  }

  /**
   * The volley card: one row per unit — d20 face, total vs AC, verdict.
   * Grouped by target with the situational note (why ADV/DIS) under the name.
   */
  static async _postVolleyCard(item, caster, rows, noun) {
    if (!rows?.length) return;
    const gold = "#c9a76b";
    let lastTarget = null;
    const body = rows.map(r => {
      let header = "";
      if (r.target !== lastTarget) {
        lastTarget = r.target;
        header = `
          <div style="margin-top:8px;font-weight:700;color:#e8d49a;font-size:15px;">
            <i class="fas fa-bullseye" style="color:${gold};font-size:12px;margin-right:5px;"></i>${r.target}
            <span style="color:#8a7a5a;font-weight:400;font-size:12px;">AC ${r.ac}</span>
          </div>
          ${r.situNote ? `<div style="font-size:12px;color:#a8935f;font-style:italic;margin:1px 0 2px 20px;">${r.situNote}</div>` : ""}`;
      }
      if (r.error) {
        return `${header}<div style="margin-left:20px;font-size:13px;color:#d44;">${noun} ${r.n}: roll failed</div>`;
      }
      const verdict = r.fumble
        ? `<span style="color:#9a9a9a;font-weight:700;">NAT 1 — MISS</span>`
        : r.crit
          ? `<span style="color:#ffd45e;font-weight:800;text-shadow:0 0 6px rgba(255,180,60,0.55);">CRIT!</span>`
          : r.hit
            ? `<span style="color:#7ec97e;font-weight:700;">HIT</span>`
            : `<span style="color:#d47c7c;font-weight:700;">MISS</span>`;
      return `${header}
        <div style="display:flex;align-items:center;gap:8px;margin:2px 0 2px 20px;font-size:14px;color:#f0e4c0;">
          <span style="color:#b0a070;min-width:52px;">${noun} ${r.n}</span>
          <span style="background:#241c12;border:1px solid #4a3a28;border-radius:4px;padding:1px 7px;font-weight:700;">
            <i class="fas fa-dice-d20" style="color:${gold};font-size:12px;margin-right:3px;"></i>${r.d20 ?? "?"}
          </span>
          <span style="font-weight:700;color:#fff;">= ${r.total}</span>
          <span style="color:#6b5230;">vs ${r.ac}</span>
          ${verdict}
        </div>`;
    }).join("");

    const html = `
      <div style="background:linear-gradient(180deg,#1a1410 0%,#0f0a08 100%);
                  border:2px solid ${gold};border-radius:6px;padding:12px 14px;
                  color:#f0e4c0;font-family:'Signika','Helvetica Neue',sans-serif;
                  box-shadow:0 0 10px ${gold}33;">
        <div style="display:flex;align-items:center;gap:10px;font-size:15px;font-weight:700;
                    color:${gold};text-transform:uppercase;letter-spacing:0.6px;
                    border-bottom:1px solid #4a3a28;padding-bottom:6px;">
          <i class="fas fa-burst" style="font-size:16px;"></i>
          <span>${item.name} — ${noun} volley</span>
        </div>
        ${body}
      </div>`;

    try {
      await ChatMessage.create({
        speaker: ChatMessage.getSpeaker({ actor: caster }),
        content: html,
        flavor: `${item.name}: ${rows.length} ${noun}${rows.length === 1 ? "" : "s"}`,
      });
    } catch (err) {
      console.warn(`${MODULE_ID} | volley card post failed:`, err);
    }
  }

  /**
   * Single-target damage shape (Vampiric Touch, future). NOT IMPLEMENTED.
   *
   * ⚠️ AN UNIMPLEMENTED RESOLVER MUST NOT RETURN QUIETLY (2026-08-19).
   * These were `console.warn` and nothing else, so a spell routed here would
   * consume its slot, post no card, roll no damage, and leave a line in a
   * console the GM is not reading. From the table it looks like the spell
   * fizzled for no reason — the single most confusing failure a rules engine
   * can produce.
   *
   * Nothing currently routes here: neither Vampiric Touch nor Chain Lightning
   * is in the registry (Chain Lightning is commented out awaiting a real
   * ChainResolver), so both fall through to the generic save path and work,
   * minus the chaining. This is the guard for the day somebody registers one.
   *
   * Refuses loudly, tells the GM in plain language, and refunds the slot —
   * a spell that did nothing must not also cost a resource.
   */
  static async runSingle(ctx, _result) {
    return DamageResolver._notImplemented(ctx, "single-target damage");
  }

  /**
   * Chained shape (Chain Lightning). NOT IMPLEMENTED — see runSingle.
   */
  static async runChained(ctx, _result) {
    return DamageResolver._notImplemented(ctx, "chained damage");
  }

  /** Shared refusal: say it, show it, and give the slot back. */
  static async _notImplemented(ctx, shapeLabel) {
    const name = ctx?.item?.name ?? "This spell";
    console.error(`${MODULE_ID} | DamageResolver: "${name}" routed to the ${shapeLabel} shape, ` +
      `which is not implemented. NOTHING was resolved — no damage, no card. Slot refunded.`);
    ui.notifications?.error(
      `ACE: "${name}" uses a spell shape ACE cannot resolve yet. Nothing was applied — resolve it manually.`,
      { permanent: true });
    // ⚠️ LAZY IMPORT, DELIBERATELY. pipeline.mjs imports THIS file, so a static
    // `import { SpellPipeline }` here would close a module-scope cycle — the
    // exact shape that made every token on the canvas unclickable on
    // 2026-08-11. Resolved at call time, long after both modules have loaded.
    try {
      const { SpellPipeline } = await import("../pipeline.mjs");
      await SpellPipeline._refundSlotIfDeferred(ctx?.activity);
    } catch (err) {
      console.warn(`${MODULE_ID} | could not refund the slot for "${name}":`, err);
    }
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  /**
   * Scale a per-unit formula by N units.
   * "1d4 + 1" × 3 → "3d4 + 3"
   * Handles dice expressions, flat numbers, and additive combinations.
   * Falls back to "(formula) * N" if structure is unrecognizable.
   */
  static _scaleFormulaToUnits(unitFormula, units) {
    if (!units || units <= 0) return "0";
    if (units === 1) return unitFormula;

    // Parse "NdX" pieces — multiply count
    // Parse flat numbers — multiply
    // Anything else — wrap in (formula) * N
    const cleaned = String(unitFormula ?? "").trim();
    const pattern = /^(\d+)?d(\d+)\s*([+\-]\s*\d+)?$/i;
    const m = cleaned.match(pattern);
    if (m) {
      const baseCount = parseInt(m[1] ?? "1", 10);
      const dieSize   = m[2];
      const modifier  = m[3] ? m[3].replace(/\s/g, "") : "";
      const newCount  = baseCount * units;
      const newMod    = modifier
        ? ` ${modifier[0]} ${parseInt(modifier.slice(1), 10) * units}`
        : "";
      return `${newCount}d${dieSize}${newMod}`;
    }

    // Pure number
    if (/^\d+$/.test(cleaned)) {
      return String(parseInt(cleaned, 10) * units);
    }

    // Fallback — defensive
    return `(${cleaned}) * ${units}`;
  }

  /**
   * Post a chat card explaining why specific targets took zero damage from a
   * spell. Dark ACE wrapper, blue accent matching our other nullification cards.
   */
  static async _postNullificationCard(item, caster, notes) {
    if (!notes?.length) return;
    const accent = "#8ab4d8";
    const rows = notes.map(n => `
      <div style="display:flex;align-items:center;gap:10px;padding:6px 8px;background:rgba(138,180,216,0.08);border-radius:4px;margin-bottom:4px;">
        <i class="fas fa-shield-halved" style="color:${accent};font-size:14px;"></i>
        <div style="flex:1;">
          <strong style="color:#e8d49a;">${n.name}</strong>
          <span style="color:#c0b288;font-size:13px;"> — nullified by ${n.reason}</span>
        </div>
      </div>
    `).join("");

    const html = `
      <div style="background:linear-gradient(180deg,#1a1410 0%,#0f0a08 100%);
                  border:2px solid ${accent};
                  border-radius:6px;
                  padding:12px 14px;
                  color:#f0e4c0;
                  font-family:'Signika','Helvetica Neue',sans-serif;
                  box-shadow:0 0 10px ${accent}33;">
        <div style="display:flex;align-items:center;gap:10px;
                    font-size:15px;font-weight:700;color:${accent};
                    text-transform:uppercase;letter-spacing:0.6px;
                    border-bottom:1px solid #4a3a28;
                    padding-bottom:6px;margin-bottom:8px;">
          <i class="fas fa-shield-halved" style="font-size:16px;color:${accent};"></i>
          <span>${item.name.toUpperCase()} — NULLIFIED</span>
        </div>
        <div style="font-size:13px;color:#c0b288;margin-bottom:8px;font-style:italic;">
          The following ${notes.length === 1 ? "target was" : "targets were"} immune via active defenses:
        </div>
        ${rows}
      </div>
    `;
    try {
      await ChatMessage.create({
        speaker: ChatMessage.getSpeaker({ actor: caster }),
        content: html,
        flavor: `${item.name} nullified for ${notes.length} target${notes.length === 1 ? "" : "s"}`,
      });
    } catch (err) {
      console.warn(`${MODULE_ID} | DamageResolver: nullification card post failed:`, err);
    }
  }
}
