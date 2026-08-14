// ─── ACE: QOL — Situational Awareness Engine (the spine) ──────────────────────
//
// "An engine that can read everything and continue to read everything." At every
// moment that can change an answer — a creature acts, moves, a turn begins or ends,
// or any state changes — this reads the FULL situation (the acting creature, the
// target, the space between them, the environment, and the moment), reasons from the
// universal RAW ruleset, and NARRATES what it saw. Specific behaviours (invisibility,
// senses, cover, immunities, movement) fall OUT of this read — they are never
// per-case patches.
//
// Design (see memory: situational-engine-architecture.md):
//   • Side-effect-free reads. `Situation.read()` only LOOKS; it never mutates.
//   • Reuse the proven engines (CombatState for adv/dis, DamageCalculator for
//     resistance, geometry-utils for distance/cover, CombatContext for can-act +
//     immunity). This module is the unifying READER + the gaps (senses, environment,
//     movement) + the NARRATOR.
//   • NEVER false-block / false-penalise. Uncertain detection → default to the
//     permissive answer (you CAN see / you CAN act).
//   • Edition-aware (2014 "legacy" / 2024 "modern").
//
// Phase 1 (this build): CreatureRead + the canSee senses sub-engine + the Narrator,
// wired into the invisibility advantage/disadvantage so See Invisibility / Truesight /
// Blindsight correctly cancel it. Environment + movement reads are Phase 2/3 — the
// framework here is built to extend into them.
// ──────────────────────────────────────────────────────────────────────────────

import { MODULE_ID } from "./ace-qol.mjs";
import { aceDistanceFt } from "./geometry-utils.mjs";

// Conditions, grouped so the reader + reasoner can talk about them in plain terms.
const CANT_ACT = ["incapacitated", "paralyzed", "stunned", "unconscious", "petrified"];
const ATTACK_DISADV_SELF = ["prone", "poisoned", "restrained", "blinded", "frightened"];

export class Situation {

  /**
   * A sense's range in feet, read from EITHER dnd5e shape.
   *
   * ⚠️ 🔴 dnd5e 5.3 MOVED these to `senses.ranges.*`, and touching the old path
   * fires a deprecation warning on EVERY read. `readCreature` runs on every
   * damage event, so one fight filled Johnny's console with 251 issues
   * (2026-08-13) — noise that buries the errors that actually matter.
   *
   * ⚠️ AND IT IS A REAL DEADLINE, not just noise: dnd5e 6.1 REMOVES the old
   * path. On that day every darkvision, blindsight, tremorsense and truesight
   * read in ACE would silently return 0 — every creature suddenly blind in the
   * dark, with nothing thrown and nothing logged.
   *
   * New shape first so the deprecated getter is never touched when 5.3+ is
   * running; the old path stays as the fallback for older dnd5e.
   */
  static senseRange(senses, key) {
    try {
      const modern = senses?.ranges?.[key];
      if (modern !== undefined && modern !== null) return Number(modern) || 0;
      return Number(senses?.[key]) || 0;
    } catch (_) { return 0; }
  }

  static edition() {
    try {
      // Honor the ACE QOL gameRulesEdition master override before the dnd5e
      // system setting. Inlined rather than importing CombatState — combat-state
      // imports THIS module, so importing it back would form a load-time cycle.
      const ov = game.settings.get(MODULE_ID, "gameRulesEdition");
      if (ov === "2014") return "legacy";
      if (ov === "2024") return "modern";
      return game.settings.get("dnd5e", "rulesVersion") === "modern" ? "modern" : "legacy";
    } catch (_) { return "legacy"; }
  }

  // ════════════════════════════════════════════════════════════════════════
  //  CreatureRead — the complete snapshot of one creature
  // ════════════════════════════════════════════════════════════════════════

  /**
   * Read everything that matters about one creature, RIGHT NOW. Pure / read-only.
   * @returns {object} a structured CreatureRead (see fields below). Null-safe.
   */
  /**
   * THE status reader (Rule #1 convergence, 2026-07-27). Union of the actor's
   * own status set AND the statuses carried by its live, ENABLED effects —
   * belt-and-braces, because `actor.statuses` can lag or miss a status that an
   * active effect plainly carries (the robustness combat-state had privately;
   * now everyone gets it). Every ACE flow — attack, save, watchdog, profiles —
   * reads conditions through this one function.
   */
  static readStatuses(actor) {
    const out = new Set();
    try {
      for (const s of (actor?.statuses ?? [])) out.add(s);
      for (const effect of (actor?.effects ?? [])) {
        if (effect.disabled) continue;
        for (const s of (effect.statuses ?? [])) out.add(s);
      }
    } catch (_) { /* null-safe by contract */ }
    return out;
  }

  static readCreature(actor, token = null) {
    if (!actor) return null;
    const sys = actor.system ?? {};
    const statuses = Situation.readStatuses(actor);
    const senses = sys.attributes?.senses ?? {};
    const traits = sys.traits ?? {};

    const has = (c) => statuses.has(c);
    const blocking = CANT_ACT.find(has) ?? null;

    return {
      ref: actor,
      token: token ?? actor.token ?? actor.getActiveTokens?.()?.[0] ?? null,
      name: token?.name ?? actor.name ?? "Creature",

      // ── identity ──
      type: String(sys.details?.type?.value ?? "").toLowerCase(),
      size: String(sys.traits?.size ?? "med").toLowerCase(),

      // ── conditions ──
      statuses,
      conditions: [...statuses],
      canAct: !blocking,
      cantActBecause: blocking,
      prone: has("prone"),
      invisible: has("invisible"),
      blinded: has("blinded"),
      restrained: has("restrained"),
      grappled: has("grappled"),   // NOTE: grappled ≠ restrained for attack adv/dis
      dodging: has("dodging") || has("dodge"),
      selfAttackDisadv: ATTACK_DISADV_SELF.some(has),

      // ── senses (ranges in ft; 0/undefined = none) ──
      senses: {
        darkvision:  Situation.senseRange(senses, "darkvision"),
        blindsight:  Situation.senseRange(senses, "blindsight"),
        tremorsense: Situation.senseRange(senses, "tremorsense"),
        truesight:   Situation.senseRange(senses, "truesight"),
        special:     String(senses.special ?? ""),
      },
      seeInvisibility: Situation._hasSeeInvisibility(actor, senses),
      devilsSight: Situation._hasDevilsSight(actor, senses),

      // ── speeds / posture ──
      speeds: sys.attributes?.movement ?? {},
      canHover: !!sys.attributes?.movement?.hover,

      // ── defences (read-only summary; DamageCalculator remains the math) ──
      di: Situation._traitSet(traits.di),
      dr: Situation._traitSet(traits.dr),
      dv: Situation._traitSet(traits.dv),
      ci: Situation._traitSet(traits.ci),
      // Comprehensive: printed sheet FEATURE + effect-name + trait field. The
      // feature check was missing here too (Rule #1 sweep, 2026-07-27).
      magicResistance: Situation.hasFeature(actor, "Magic Resistance")
        || !!(traits.dm?.amount || actor.appliedEffects?.some?.(e => /magic\s+resistance/i.test(e.name ?? ""))),
      legendaryResistance: Number(sys.resources?.legres?.value ?? 0),

      // ── resources (Phase 1 essentials; extend in later phases) ──
      concentrating: !!(actor.appliedEffects ?? actor.effects ?? []).find?.(e =>
        e.statuses?.has?.("concentration") || e.flags?.dnd5e?.concentration),

      // ── features (COMPREHENSIVE roster — Rule #1, 2026-07-27) ──
      // EVERY feat / class / subclass item on the sheet, name-indexed, so any
      // engine — attacker side or target side — asks "does it have X" through
      // ONE reader (Situation.hasFeature) instead of ad-hoc item greps. Both
      // profiles carry this automatically via the creature snapshot.
      features: Situation._featureList(actor),

      // ── THE PLAIN NUMBERS (2026-07-28) ──
      // Added because combat-state was reading these off the actor in 25
      // places — ability mods a dozen times, proficiency four times, HP five,
      // exhaustion, armour proficiency. Every one of those is a fact about the
      // creature, so it belongs in the creature snapshot and both profiles get
      // it for free. Anything the engines ask about a creature lives HERE.
      abilities: Object.fromEntries(
        Object.entries(sys.abilities ?? {}).map(([k, a]) => [k, {
          mod:   Number(a?.mod ?? 0) || 0,
          score: Number(a?.value ?? 10) || 10,
          save:  Number(a?.save?.value ?? a?.save ?? a?.mod ?? 0) || 0,
        }])
      ),
      prof: Number(sys.attributes?.prof ?? 0) || 0,
      exhaustion: Number(sys.attributes?.exhaustion ?? 0) || 0,
      hp: {
        value: Number(sys.attributes?.hp?.value ?? 0) || 0,
        max:   Number(sys.attributes?.hp?.max ?? 0) || 0,
        temp:  Number(sys.attributes?.hp?.temp ?? 0) || 0,
      },
      armorProf: Situation._traitSet(traits.armorProf),

      // Defense + caster facts the spell pipeline and damage engine ask for.
      // Same rule as the block above: it's a fact about the creature, so it
      // lives in the creature snapshot, not re-derived at each call site.
      ac: Number(sys.attributes?.ac?.value ?? 10) || 10,
      subtype: String(sys.details?.type?.subtype ?? ""),
      /** Character level for a PC; CR-derived caster level for an NPC. */
      level: Number(
        sys.details?.level
        ?? sys.details?.spellLevel
        ?? sys.attributes?.spell?.level
        ?? 0
      ) || 0,
      /** The creature's spellcasting ability key ("int"|"wis"|"cha"|…). */
      spellcasting: String(sys.attributes?.spellcasting ?? "") || null,
      /** The creature's spell save DC as the system computes it. */
      spellDC: Number(sys.attributes?.spelldc ?? sys.attributes?.spell?.dc ?? 0) || 0,
      /** Spellcasting modifier — the system's own value wins, else the ability. */
      spellMod: Number(
        sys.attributes?.spellmod
        ?? sys.abilities?.[sys.attributes?.spellcasting ?? "int"]?.mod
        ?? 0
      ) || 0,
    };
  }

  /** Full feature roster: every feat / class / subclass item on the sheet. */
  static _featureList(actor) {
    try {
      return (actor.items?.contents ?? actor.items ?? [])
        .filter(i => i.type === "feat" || i.type === "class" || i.type === "subclass")
        .map(i => ({ name: i.name ?? "", nameLc: String(i.name ?? "").toLowerCase() }));
    } catch (_) { return []; }
  }

  /**
   * THE feature reader (Rule #1 convergence, 2026-07-27). Accepts a live Actor
   * OR a readCreature snapshot (or a profile's `creature`). Substring match,
   * case-insensitive — identical semantics to the old ad-hoc checks, so every
   * delegated caller behaves exactly as before, from one source of truth.
   */
  static hasFeature(subject, name) {
    const lower = String(name ?? "").toLowerCase();
    if (!lower) return false;
    try {
      if (Array.isArray(subject?.features)) {
        return subject.features.some(f => f.nameLc.includes(lower));
      }
      const actor = subject?.ref ?? subject;
      return actor?.items?.some?.(i =>
        (i.type === "feat" || i.type === "class" || i.type === "subclass")
        && i.name?.toLowerCase().includes(lower)
      ) ?? false;
    } catch (_) { return false; }
  }

  static _traitSet(t) {
    try {
      if (t?.value instanceof Set) return new Set([...t.value].map(x => String(x).toLowerCase()));
      if (Array.isArray(t?.value)) return new Set(t.value.map(x => String(x).toLowerCase()));
    } catch (_) { /* fall through */ }
    return new Set();
  }

  /** True if this creature has Devil's Sight — sees normally in darkness, BOTH
   *  magical and nonmagical, out to 120 ft. Warlock PCs carry it as an
   *  INVOCATION (a feat-type item), not a senses note — the senses.special
   *  string alone missed Syrax entirely (2026-07-09). Read all three homes:
   *  the senses string, feat/class items, and active effects. */
  static _hasDevilsSight(actor, senses = null) {
    try {
      senses ??= actor?.system?.attributes?.senses ?? {};
      const re = /devil'?s?\s+sight/i;
      if (re.test(String(senses.special ?? ""))) return true;
      const fx = actor?.appliedEffects ?? actor?.effects ?? [];
      if ([...fx].some(e => re.test(e.name ?? ""))) return true;
      if ((actor?.items ?? []).some(i => (i.type === "feat" || i.type === "class") && re.test(i.name ?? ""))) return true;
    } catch (_) { /* non-fatal */ }
    return false;
  }

  /** True if this creature can see invisible creatures at all (truesight or a See Invisibility effect). */
  static _hasSeeInvisibility(actor, senses = null) {
    try {
      senses ??= actor?.system?.attributes?.senses ?? {};
      if (Situation.senseRange(senses, "truesight") > 0) return true;
      if (/see\s+invis|truesight/i.test(String(senses.special ?? ""))) return true;
      if (actor?.flags?.[MODULE_ID]?.seeInvisible === true) return true;
      const re = /see\s+invisibility|truesight/i;
      const fx = actor?.appliedEffects ?? actor?.effects ?? [];
      if ([...fx].some(e => re.test(e.name ?? ""))) return true;
      if ((actor?.items ?? []).some(i => re.test(i.name ?? ""))) return true;
    } catch (_) { /* non-fatal */ }
    return false;
  }

  // ════════════════════════════════════════════════════════════════════════
  //  canSee — the "can these two actually see each other?" sub-engine
  // ════════════════════════════════════════════════════════════════════════

  /**
   * Can `viewer` see `subject` right now? Returns { canSee, why }. Conservative:
   * when we can't determine something, we default to CAN see (never falsely
   * penalise). Phase 1 handles invisibility + blindness via senses; darkness /
   * magical-darkness / obscurement are Phase 2 (EnvironmentRead).
   *
   * @param {Actor} viewer
   * @param {Actor} subject
   * @param {object} opts  { viewerToken, subjectToken, distanceFt }
   */
  static canSee(viewer, subject, opts = {}) {
    try {
      if (!viewer || !subject) return { canSee: true, why: "unknown — assume visible" };

      const vToken = opts.viewerToken  ?? viewer.getActiveTokens?.()?.[0] ?? null;
      const sToken = opts.subjectToken ?? subject.getActiveTokens?.()?.[0] ?? null;
      let dist = opts.distanceFt;
      if (dist == null && vToken && sToken) {
        try { dist = aceDistanceFt(vToken, sToken); } catch (_) { dist = null; }
      }
      // Unknown distance → treat as "within range" so range-limited senses still
      // help (we never want to falsely say "can't see" and over-penalise).
      const inRange = (rangeFt) => rangeFt > 0 && (dist == null || dist <= rangeFt);

      const vStatuses = viewer.statuses instanceof Set ? viewer.statuses : new Set();
      const senses = viewer.system?.attributes?.senses ?? {};
      const blindsightOK  = inRange(Situation.senseRange(senses, "blindsight"));
      const tremorsenseOK = inRange(Situation.senseRange(senses, "tremorsense"));

      // A BLINDED viewer perceives nothing by sight — only via blindsight/tremorsense.
      if (vStatuses.has("blinded")) {
        if (blindsightOK)  return { canSee: true,  why: "blinded but has blindsight" };
        if (tremorsenseOK && !Situation._isAirborne(sToken)) return { canSee: true, why: "blinded but has tremorsense" };
        return { canSee: false, why: "viewer is blinded" };
      }

      // ── PHASE 2 (2026-07-09): darkness / heavy obscurement along the sight line ──
      // Obscurement is a property of SPACE, evaluated per sight-line at action
      // time — never a condition stamped on a creature. The sight line is
      // sampled through every rules-engine space region; a heavy-obscurement
      // space anywhere along it blocks sight UNLESS one of the viewer's senses
      // pierces that space's KIND (Devil's Sight and truesight cut magical
      // darkness; blindsight perceives through everything in its radius;
      // darkvision cuts NEITHER — that absence is load-bearing RAW).
      // Checked BEFORE invisibility: See Invisibility still needs a clear
      // sight line — piercing invisibility doesn't pierce a wall of darkness.
      const obscured = Situation._sightLineObscured(viewer, { vToken, sToken, dist, senses });
      if (obscured.blocked) {
        if (tremorsenseOK && !Situation._isAirborne(sToken)) {
          return { canSee: true, why: `tremorsense (through ${obscured.kindLabel})` };
        }
        return { canSee: false, why: obscured.why };
      }

      // INVISIBLE subject — needs a sense that pierces invisibility.
      const sStatuses = subject.statuses instanceof Set ? subject.statuses : new Set();
      if (sStatuses.has("invisible")) {
        if (inRange(Situation.senseRange(senses, "truesight"))) return { canSee: true, why: "truesight" };
        if (Situation._hasSeeInvisibility(viewer, senses)) return { canSee: true, why: "see invisibility" };
        if (blindsightOK)  return { canSee: true, why: "blindsight" };
        if (tremorsenseOK && !Situation._isAirborne(sToken)) return { canSee: true, why: "tremorsense" };
        return { canSee: false, why: "subject is invisible" };
      }

      // Plain sight. If a sense had to cut through obscurement to see the
      // subject, `pierced` carries HOW — callers use it to explain a withheld
      // advantage ("Demogorgon sees you through the darkness via truesight").
      return { canSee: true, why: "in plain sight", pierced: obscured.pierced ?? null };
    } catch (err) {
      console.warn(`${MODULE_ID} | Situation.canSee threw (defaulting to visible):`, err);
      return { canSee: true, why: "error — assume visible" };
    }
  }

  /**
   * PURE sense-vs-space decision: can a viewer with these senses see through
   * a space of this kind? No canvas, no documents — fully testable, and the
   * self-test harness runs a decision table through it every run.
   *
   * The load-bearing RAW encoded here:
   *   • blindsight (in radius) perceives through EVERYTHING — always pierces.
   *   • truesight pierces only kinds that list it (magical darkness yes; RAW
   *     fog no — it isn't darkness, invisibility, or illusion).
   *   • darkvision pierces only kinds that list it (PLAIN darkness yes;
   *     magical darkness and fog NEVER).
   *   • Devil's Sight pierces listed kinds out to 120 ft.
   *
   * @param {object} space   { pierceBy: [...] } from a rules entry / region flag
   * @param {object} senses  { darkvision, blindsight, truesight, devilsSight, dist }
   * @returns {{ pierced: boolean, how: string|null }}
   */
  static canPierce(space, { darkvision = 0, blindsight = 0, truesight = 0, devilsSight = false, dist = null } = {}) {
    const inRange = (r) => Number(r) > 0 && (dist == null || dist <= Number(r));
    if (inRange(blindsight)) return { pierced: true, how: "blindsight" };
    const pierce = new Set(space?.pierceBy ?? []);
    if (pierce.has("truesight") && inRange(truesight)) return { pierced: true, how: "truesight" };
    if (pierce.has("darkvision") && inRange(darkvision)) return { pierced: true, how: "darkvision" };
    if (pierce.has("devilsSight") && devilsSight && (dist == null || dist <= 120)) return { pierced: true, how: "devil's sight" };
    return { pierced: false, how: null };
  }

  // ════════════════════════════════════════════════════════════════════════
  //  Sight line vs obscured spaces (Phase 2)
  // ════════════════════════════════════════════════════════════════════════

  /**
   * Is the straight line between viewer and subject interrupted by a
   * heavy-obscurement space the viewer can't pierce? Samples the segment at
   * half-grid steps against every rules-engine space region on the scene
   * (their flags carry the machine-readable properties space-effects wrote).
   *
   * Permissive by construction: no tokens / no regions / any read failure →
   * NOT blocked. Light obscurement (Web's webs) never blocks attacks — it's a
   * Perception penalty, not a sight wall.
   *
   * @returns {{ blocked:boolean, why:string, kindLabel:string }}
   */
  static _sightLineObscured(viewer, { vToken, sToken, dist, senses } = {}) {
    const clear = { blocked: false, why: "", kindLabel: "" };
    try {
      const vDoc = vToken?.document ?? vToken;
      const sDoc = sToken?.document ?? sToken;
      const scene = vDoc?.parent ?? sDoc?.parent ?? canvas?.scene;
      if (!scene || !vToken || !sToken) return clear;

      // Collect heavy-obscurement spaces once. None on scene → nothing to do.
      const spaces = [];
      for (const region of (scene.regions ?? [])) {
        const space = region.getFlag?.(MODULE_ID, "space");
        if (space?.obscurement === "heavy") spaces.push({ region, space });
      }
      if (!spaces.length) return clear;

      // Segment endpoints (token centers) + linear elevation between them.
      const vObj = vToken.center ? vToken : vDoc?.object;
      const sObj = sToken.center ? sToken : sDoc?.object;
      const a = vObj?.center, b = sObj?.center;
      if (!a || !b) return clear;
      const eA = Number(vDoc?.elevation ?? 0), eB = Number(sDoc?.elevation ?? 0);

      const step = Math.max(20, (canvas?.grid?.size ?? 100) / 2);
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      const n = Math.min(80, Math.max(1, Math.ceil(len / step)));

      senses ??= viewer?.system?.attributes?.senses ?? {};
      const inRange = (r) => Number(r) > 0 && (dist == null || dist <= Number(r));

      let piercedInfo = null;   // first sense that cut through an obscuring space
      for (const { region, space } of spaces) {
        // RAW (2026-07-10, v2): a region the VIEWER is standing in never
        // blinds the viewer — you see OUT of the obscurement you occupy
        // (your darkness hides you from others, not others from you). The
        // body-radius exclusion missed diagonal exits from the 5-ft cube
        // (live-fire 06:49 — the goblin's own cube still read as blocking);
        // occupancy is the correct and simpler test. Regions BETWEEN the two
        // still block, and a SUBJECT inside a region is still unseeable
        // (the region isn't skipped for the outside viewer).
        try {
          if (region.testPoint?.({ x: a.x, y: a.y, elevation: eA })) continue;
        } catch (_) {
          try { if (region.object?.testPoint?.(a, eA)) continue; } catch (_) {}
        }

        // Does the sight line pass through this space at all?
        let crosses = false;
        for (let i = 0; i <= n && !crosses; i++) {
          const t = i / n;
          const p = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
          const elev = eA + (eB - eA) * t;
          try {
            crosses = region.testPoint?.({ x: p.x, y: p.y, elevation: elev }) ?? false;
          } catch (_) {
            try { crosses = region.object?.testPoint?.(p, elev) ?? false; } catch (_) {}
          }
        }
        if (!crosses) continue;

        // It does — can the viewer pierce THIS space's kind? (Pure decision
        // function — the self-test harness runs a full table through it.)
        const kind = space.kind ?? "obscurement";
        const kindLabel = kind === "magicalDarkness" ? "magical darkness"
                        : kind === "fog" ? "fog" : `heavy obscurement (${kind})`;
        const verdict = Situation.canPierce(space, {
          darkvision: Situation.senseRange(senses, "darkvision"),
          blindsight: Situation.senseRange(senses, "blindsight"),
          truesight: Situation.senseRange(senses, "truesight"),
          devilsSight: Situation._hasDevilsSight(viewer, senses),
          dist,
        });
        if (verdict.pierced) {
          // Saw through it — remember HOW (the first pierce is enough to
          // explain a withheld advantage on the card) and keep scanning the
          // remaining spaces in case a later one genuinely blocks.
          piercedInfo ??= { how: verdict.how, kind, kindLabel, spell: space.spell ?? null };
          continue;
        }

        return {
          blocked: true,
          kindLabel,
          why: `sight line through ${kindLabel}${space.spell ? ` (${space.spell})` : ""}`,
        };
      }
      // Nothing blocked. If a sense cut through obscurement to get here, carry
      // that up so callers can explain a NORMAL-instead-of-advantage outcome.
      return { blocked: false, why: "", kindLabel: "", pierced: piercedInfo };
    } catch (err) {
      console.debug(`${MODULE_ID} | _sightLineObscured failed (permissive — not blocked):`, err);
      return clear;
    }
  }

  static _isAirborne(token) {
    try { return Number(token?.document?.elevation ?? token?.elevation ?? 0) > 0; }
    catch (_) { return false; }
  }

  // ════════════════════════════════════════════════════════════════════════
  //  Narrator — show the work ("at least throw me a clue")
  // ════════════════════════════════════════════════════════════════════════

  /** Surface a list of plain-language situational notes per the user's setting. */
  static narrate(lines, { context = "" } = {}) {
    if (!lines?.length) return;
    let mode = "off";
    try { mode = game.settings.get(MODULE_ID, "situationalNarration") ?? "off"; } catch (_) { /* not registered */ }
    if (mode === "off") return;
    const text = lines.filter(Boolean).join("  |  ");
    if (!text) return;
    if (mode === "debug") console.log(`%c${MODULE_ID} | SITUATION${context ? ` (${context})` : ""}: ${text}`, "color:#c9a76b");
    else if (mode === "chat") {
      try {
        ChatMessage.create({
          whisper: ChatMessage.getWhisperRecipients?.("GM") ?? [],
          content: `<div style="font-size:12px;color:#c9a76b;"><i class="fas fa-eye"></i> ${foundry.utils.escapeHTML(text)}</div>`,
          flags: { [MODULE_ID]: { situational: true } },
        });
      } catch (_) { /* non-fatal */ }
    }
    // "tooltip" mode is surfaced inline on the attack/save card by the pipelines (Phase 4).
  }
}
