// ─── Where in the chain did the aura stop? ──────────────────────────────────
//
// ⚠️🔴 WRITTEN BECAUSE I GUESSED THREE TIMES AND WAS WRONG THREE TIMES.
// Chasing this from screenshots, I blamed unlinked tokens, then the grid size,
// then a Sequencer wildcard. Each was plausible, each cost a round trip, and
// none was it. Johnny does not have round trips to spare.
//
// An aura has to survive five separate steps to appear on a creature, and every
// one of them fails silently:
//
//   1. is the source even recognised as a source
//   2. does the engine think this creature should have it
//   3. is the effect actually on the creature
//   4. is a ring currently playing for it
//   5. is the ring attached to the right token
//
// "It is not working" can mean any of those. This prints all five for every
// creature on the scene, side by side, so the answer is a fact instead of a
// theory.
//
// Run:  game.aceQol.whyNoAura()
const MODULE_ID = "ace-qol";
const FLAG_NS = "ace-qol";

import { AuraEngine } from "./aura-engine.mjs";
import { aceDistanceFt } from "./geometry-utils.mjs";

export function whyNoAura() {
  const out = [];
  const say = (s) => { out.push(s); console.log(s); };

  try {
    if (!canvas?.scene) { say("No scene."); return out; }

    // ── 1. Sources ───────────────────────────────────────────────────────
    let sources = [];
    try { sources = AuraEngine.getActiveSources() ?? []; }
    catch (err) { say(`Sources could not be read: ${err?.message ?? err}`); }

    say("");
    say(`SOURCES ON THIS SCENE: ${sources.length}`);
    for (const s of sources) {
      say(`   ${s.token?.name ?? "?"}  ${s.aura?.sourceFeatureName ?? "?"}  `
        + `range ${s.rangeFt} feet  level ${s.level}`
        + (s.suppressed ? "  SUPPRESSED (incapacitated or unconscious)" : ""));
    }
    if (!sources.length) {
      say("   Nobody on this scene projects an aura, so nothing below can appear.");
    }

    // ── 4/5. What Sequencer is actually playing ──────────────────────────
    const playing = new Map();     // name -> attached token id
    try {
      for (const e of (Sequencer?.EffectManager?.getEffects?.({ name: "ace-qol-aura:*" }) ?? [])) {
        playing.set(e?.data?.name ?? "?", e?.data?.attachTo?.active ? "attached" : "loose");
      }
    } catch (err) {
      say(`Running animations could not be read: ${err?.message ?? err}`);
    }
    say("");
    say(`AURA ANIMATIONS CURRENTLY PLAYING: ${playing.size}`);

    // ── 2/3. Per creature ────────────────────────────────────────────────
    say("");
    say("CREATURE".padEnd(24) + "NEAREST SOURCE".padEnd(22) + "SHOULD".padEnd(9)
      + "EFFECT".padEnd(9) + "RING");
    say("-".repeat(76));

    for (const t of (canvas.tokens?.placeables ?? [])) {
      if (!t.actor) { say(`${String(t.name).slice(0, 22).padEnd(24)}no readable actor`); continue; }

      // Closest source and whether the engine would give it the aura.
      let best = null;
      for (const s of sources) {
        if (s.suppressed) continue;
        const ft = (t.id === s.token.id) ? 0 : aceDistanceFt(t, s.token);
        const allies = s.aura.appliesTo !== "allies"
          || t.document.disposition === s.token.document.disposition;
        const self = t.id === s.token.id;
        const eligible = self ? s.aura.includesSource : (allies && ft <= s.rangeFt);
        if (!best || ft < best.ft) best = { s, ft, eligible, allies, self };
      }

      const has = (t.actor.effects ?? []).filter(e =>
        e.flags?.[FLAG_NS]?.auraApplied && !e.disabled).length;
      const rings = [...playing.keys()].filter(n => n.includes(`:${t.id}:`)).length;

      const where = best
        ? `${String(best.s.token.name).slice(0, 12)} ${best.ft} ft`
        : "(none)";
      const should = best
        ? (best.eligible ? "yes" : (best.self ? "self-no" : (!best.allies ? "not ally" : "too far")))
        : "no";

      // ⚠️ THE THREE COLUMNS THAT MATTER ARE SHOULD / EFFECT / RING. Any two of
      // them disagreeing names the broken step exactly:
      //   should yes, effect 0   -> the engine is not applying
      //   effect >0, ring 0      -> the drawing is not keeping up
      //   effect 0, ring >0      -> a stale ring nobody ended
      // ⚠️ "NOT APPLIED" AND "NOT APPLIED YET" ARE DIFFERENT, AND THE FIRST
      // WORDING SENT ME LOOKING FOR THE WRONG BUG. Virric showed 0 here while
      // the world database held both his effects, enabled: the diagnosis had
      // caught a moment between the move and the recompute. Run it twice.
      const flag = (should === "yes" && has === 0) ? "   <- NOT APPLIED YET (run again in a few seconds)"
                 : (has > 0 && rings === 0)        ? "   <- APPLIED BUT NOT DRAWN"
                 : (has === 0 && rings > 0)        ? "   <- STALE RING"
                 : "";

      say(String(t.name).slice(0, 22).padEnd(24) + where.padEnd(22)
        + should.padEnd(9) + String(has).padEnd(9) + String(rings) + flag);
    }

    say("");
    say("Any row with an arrow is the broken step. No arrows means the engine and");
    say("the drawing agree, and the problem is somewhere else entirely.");
    say("");
    say("⚠️ RUN IT TWICE. A row that clears on the second run was not broken, it");
    say("was late — which is a different bug in a different place.");
  } catch (err) {
    say(`The diagnosis itself failed: ${err?.message ?? err}`);
    console.error(err);
  }
  return out;
}
