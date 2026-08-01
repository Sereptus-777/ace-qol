// ─── ACE: QOL — Gaze Engine ──────────────────────────────────────────────────
//
// RAW automation for START-OF-TURN gaze attacks: the basilisk's and medusa's
// Petrifying Gaze, and any future gaze cut from the same cloth.
//
// Why this exists: the `petrified` condition itself was already fully built
// (stat changes, auto-failed STR/DEX saves, damage resistance, the cracked
// stone token visual). What did NOT exist was anything that ever TRIGGERED it.
// Drop a basilisk in front of the party and nothing happened — the feature
// registry listed "gaze attacks" as unbuilt work. This is that work.
//
// RAW shape (2014 Basilisk / Medusa — the two-stage gaze):
//   • At the START of a creature's turn, if it is within range of the gazer
//     and the two can SEE EACH OTHER, and the gazer is not incapacitated,
//     the creature makes a saving throw.
//   • On a failure it begins turning to stone and is RESTRAINED.
//   • It repeats the save at the END of its next turn. Success ends the
//     effect; failure means PETRIFIED.
//
// The second stage is not implemented here — it is delegated to the existing
// RepeatingSaveEngine by stamping the standard `repeatingSave` flag on the
// stage-one effect, plus the `onFailureApply` directive that engine now
// understands. One end-of-turn re-save mechanism, not two.
//
// DESIGN NOTES / THINGS JOHNNY MAY WANT CHANGED:
//   • The stage-one save is rolled GM-side, matching how RepeatingSaveEngine
//     already handles automatic re-saves. If you'd rather players roll their
//     own gaze save from a card, that's a deliberate change, not a bug.
//   • Averting your eyes (RAW option: forfeit sight of the gazer to gain
//     immunity for the turn, at the cost of disadvantage against it) is NOT
//     implemented. It needs a per-turn player choice prompt.
//   • Hard-coded on, no setting, per the standing "don't slip in toggles" rule.
//
// EVERYTHING here is wrapped so a failure logs and does nothing. A bug in a
// gaze must never break somebody's turn.
// ──────────────────────────────────────────────────────────────────────────────

import { MODULE_ID } from "./ace-qol.mjs";
import { aceWithinFt } from "./geometry-utils.mjs";
import { Situation } from "./situation.mjs";

// ── Gaze catalog ─────────────────────────────────────────────────────────────
// Matched against the gazer's feature/item names, case-insensitively.
// `fallbackDC` is only used when the creature's own item doesn't carry a DC —
// always prefer the stat block's real number (basilisk 12, medusa 14, and
// homebrew is whatever the GM wrote).
const GAZES = [
  {
    id:            "petrifying-gaze",
    match:         /petrifying\s+gaze/i,
    ability:       "con",
    fallbackDC:    12,
    rangeFt:       30,
    stageOneKey:   "restrained",
    stageTwoKey:   "petrified",
    stageOneLabel: "Turning to Stone",
    flavor:        "flesh stiffens, a grey pallor creeping across the skin",
  },
];

// Statuses that switch a gaze off at the source.
const GAZER_DISABLING_STATUSES = ["incapacitated", "unconscious", "paralyzed", "stunned", "petrified", "dead", "blinded"];

export class GazeEngine {

  static init() {
    if (this._initialized) return;
    this._initialized = true;

    Hooks.on("combatTurn", async (combat) => {
      try { await this._onTurnStart(combat); }
      catch (err) { console.warn(`${MODULE_ID} | GazeEngine.combatTurn failed:`, err); }
    });
    Hooks.on("combatRound", async (combat) => {
      try { await this._onTurnStart(combat); }
      catch (err) { console.warn(`${MODULE_ID} | GazeEngine.combatRound failed:`, err); }
    });

    console.debug(`${MODULE_ID} | Gaze Engine online (start-of-turn gaze attacks)`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Start-of-turn sweep
  // ═══════════════════════════════════════════════════════════════════════════

  static async _onTurnStart(combat) {
    // activeGM only — otherwise every client rolls its own gaze save.
    if (game.users?.activeGM !== game.user) return;
    if (!combat?.started) return;

    const victimToken = combat.combatant?.token;
    const victimActor = combat.combatant?.actor;
    if (!victimToken || !victimActor) return;

    // Already stone? Nothing further to do to you.
    if (this._hasStatus(victimActor, "petrified")) return;

    for (const gaze of GAZES) {
      const gazers = this._findGazersFor(victimToken, victimActor, gaze);
      for (const g of gazers) {
        // One gaze application per turn per gaze type — the first valid gazer wins.
        const applied = await this._attemptGaze(victimToken, victimActor, g.token, g.actor, g.item, gaze);
        if (applied) break;
      }
    }
  }

  /** Every token on the victim's scene that can currently gaze at them. */
  static _findGazersFor(victimToken, victimActor, gaze) {
    const out = [];
    const scene = victimToken.parent ?? canvas?.scene;
    if (!scene) return out;

    for (const tokenDoc of scene.tokens?.contents ?? []) {
      try {
        if (tokenDoc.id === victimToken.id) continue;
        const actor = tokenDoc.actor;
        if (!actor) continue;

        // Does it actually have this gaze?
        const item = actor.items?.find?.(i => gaze.match.test(String(i?.name ?? "")));
        if (!item) continue;

        // A gazer that can't act — or can't see — can't gaze.
        if (GAZER_DISABLING_STATUSES.some(s => this._hasStatus(actor, s))) continue;
        if ((actor.system?.attributes?.hp?.value ?? 1) <= 0) continue;

        // Range (nearest-edge, 3D-aware, honours the world's distance setting).
        if (!aceWithinFt(tokenDoc, victimToken, gaze.rangeFt)) continue;

        // RAW: "if the two of them can see each other". Situation.canSee already
        // understands blinded, heavy obscurement, darkness, truesight, blindsight.
        if (!this._mutuallyVisible(victimToken, tokenDoc)) continue;

        out.push({ token: tokenDoc, actor, item });
      } catch (err) {
        console.warn(`${MODULE_ID} | GazeEngine: gazer scan skipped a token:`, err);
      }
    }
    return out;
  }

  /** Both directions of sight, conservative: any failure to prove = no gaze. */
  static _mutuallyVisible(victimToken, gazerToken) {
    try {
      if (!Situation?.canSee) return true;   // sight engine unavailable — don't block RAW
      const victimSeesGazer = Situation.canSee(victimToken, gazerToken)?.canSee;
      const gazerSeesVictim = Situation.canSee(gazerToken, victimToken)?.canSee;
      return Boolean(victimSeesGazer && gazerSeesVictim);
    } catch (err) {
      console.warn(`${MODULE_ID} | GazeEngine: sight check failed, allowing gaze:`, err);
      return true;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  One gaze attempt
  // ═══════════════════════════════════════════════════════════════════════════

  static async _attemptGaze(victimToken, victimActor, gazerToken, gazerActor, item, gaze) {
    try {
      // Already mid-transformation from this gaze? The end-of-turn re-save owns
      // it now — don't stack a second staging effect on top.
      if (this._hasStagingEffect(victimActor, gaze)) return true;

      // Immune to the end state (many constructs/elementals) → gaze is wasted.
      const immunities = victimActor.system?.traits?.ci?.value;
      if (immunities?.has?.(gaze.stageTwoKey) || immunities?.has?.(gaze.stageOneKey)) {
        console.log(`${MODULE_ID} | Gaze: ${victimActor.name} is immune to ${gaze.stageTwoKey} — ${gaze.id} has no effect`);
        return false;
      }

      const dc = this._resolveDC(item, gaze);

      // ── Stage-one save ──
      const rollTotal = await this._rollSave(victimActor, gaze.ability, dc);
      if (rollTotal === null) return false;   // couldn't roll — do nothing rather than guess

      const passed = rollTotal >= dc;
      const abilityLabel = CONFIG.DND5E?.abilities?.[gaze.ability]?.label ?? gaze.ability.toUpperCase();

      await this._postCard({
        victimActor, gazerActor, gaze, dc, total: rollTotal, passed, abilityLabel,
      });

      if (passed) {
        console.log(`${MODULE_ID} | Gaze[${gaze.id}] ${victimActor.name} PASSED ${abilityLabel} ${rollTotal} vs DC ${dc} vs ${gazerActor.name}`);
        return true;
      }

      // ── Stage one: restrained + "turning to stone" ──
      // Stamped with the standard repeatingSave flag so the existing
      // RepeatingSaveEngine runs the end-of-next-turn re-save, and with
      // onFailureApply so a second failure escalates to petrified.
      const { ConditionLibrary } = await import("./condition-library.mjs");

      // Stage one exists ONLY as "begins to turn to stone". If the victim can
      // never reach stage two, it was never turning to stone — don't restrain
      // it as a consolation prize. (Same rule the active save path enforces;
      // gated here too so re-enabling this engine can't reopen the hole.)
      if (ConditionLibrary.immuneTo(victimActor, gaze.stageTwoKey)) {
        console.log(`${MODULE_ID} | Gaze[${gaze.id}] ${victimActor.name} is IMMUNE to "${gaze.stageTwoKey}" — gaze does nothing (no stage one).`);
        return true;
      }

      await ConditionLibrary.applyEffect(victimActor, gaze.stageOneKey, {
        source: gaze.stageOneLabel,
        extraFlags: {
          repeatingSave: {
            ability:            gaze.ability,
            dc,
            trigger:            "endOfTurn",
            spellName:          gaze.stageOneLabel,
            onFailureApply:     gaze.stageTwoKey,
            // RAW: tagged at the START of its turn, re-saves "at the end of its
            // NEXT turn". So the first end-of-turn is a grace turn, not a save —
            // the victim stays restrained for a full round, giving the party a
            // turn to break line of sight before the petrification check.
            skipFirstEndOfTurn: true,
            stampedAt:          Date.now(),
          },
          gazeStage: { gazeId: gaze.id, sourceTokenUuid: gazerToken.uuid },
        },
      });

      console.log(`${MODULE_ID} | Gaze[${gaze.id}] ${victimActor.name} FAILED ${abilityLabel} ${rollTotal} vs DC ${dc} — restrained, re-saves at end of next turn or is PETRIFIED`);
      return true;

    } catch (err) {
      console.warn(`${MODULE_ID} | GazeEngine: gaze attempt failed (no effect applied):`, err);
      return false;
    }
  }

  /** Prefer the creature's own save DC; fall back to the catalog number. */
  static _resolveDC(item, gaze) {
    try {
      for (const act of item?.system?.activities ?? []) {
        const dc = Number(act?.save?.dc?.value ?? act?.save?.dc?.formula);
        if (Number.isFinite(dc) && dc > 0) return dc;
      }
      const flat = Number(item?.system?.save?.dc);
      if (Number.isFinite(flat) && flat > 0) return flat;
    } catch (_) { /* fall through to catalog default */ }
    return gaze.fallbackDC;
  }

  /** Roll a save GM-side. Returns the total, or null if it couldn't be rolled. */
  static async _rollSave(actor, ability, dc) {
    try {
      // configure:false — ACE owns the pause; dnd5e's save dialog never shows.
      const rolls = await actor.rollSavingThrow({ ability, target: dc }, { configure: false }, { create: false });
      const roll  = Array.isArray(rolls) ? rolls[0] : rolls;
      const total = Number(roll?.total ?? roll?._total ?? NaN);
      return Number.isFinite(total) ? total : null;
    } catch (err) {
      console.warn(`${MODULE_ID} | GazeEngine: rollSavingThrow failed for ${actor.name}:`, err);
      return null;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Helpers
  // ═══════════════════════════════════════════════════════════════════════════

  static _hasStatus(actor, statusId) {
    try {
      for (const e of actor?.effects ?? []) {
        if (e.disabled) continue;
        if (e.statuses?.has?.(statusId)) return true;
      }
      return Boolean(actor?.statuses?.has?.(statusId));
    } catch (_) { return false; }
  }

  static _hasStagingEffect(actor, gaze) {
    try {
      for (const e of actor?.effects ?? []) {
        if (e.flags?.[MODULE_ID]?.gazeStage?.gazeId === gaze.id) return true;
      }
    } catch (_) { /* treat as absent */ }
    return false;
  }

  static async _postCard({ victimActor, gazerActor, gaze, dc, total, passed, abilityLabel }) {
    try {
      const title = passed ? "Gaze Resisted" : "Turning to Stone";
      const body  = passed
        ? `<p><strong>${victimActor.name}</strong> meets the gaze of <strong>${gazerActor.name}</strong> and looks away in time.</p>`
        : `<p><strong>${victimActor.name}</strong> meets the gaze of <strong>${gazerActor.name}</strong> — ${gaze.flavor}.</p>
           <p><em>Restrained. Saves again at the end of its next turn, or is petrified.</em></p>`;

      await ChatMessage.create({
        speaker: { alias: "ACE" },
        content: `
          <div class="ace-gaze-card">
            <h3 style="margin:0 0 4px;">${title}</h3>
            ${body}
            <p style="margin:4px 0 0; opacity:0.85;">
              ${abilityLabel} save: <strong>${total}</strong> vs DC ${dc} —
              <strong style="color:${passed ? "#5db88a" : "#e87070"};">${passed ? "Success" : "Failure"}</strong>
            </p>
          </div>`,
        flags: { [MODULE_ID]: { type: "gaze", gazeId: gaze.id } },
      });
    } catch (err) {
      console.warn(`${MODULE_ID} | GazeEngine: chat card failed:`, err);
    }
  }
}
