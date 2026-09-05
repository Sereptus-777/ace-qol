// ─── ACE: QOL — Pipeline Resolver: Template ───────────────────────────────────
// Template-save (Fireball / Lightning Bolt / Cone of Cold / Ice Storm…),
// template-trigger (Spike Growth / Web / Wall of Fire…), and aura
// (Spirit Guardians / Aura of Vitality…).
//
// IMPORTANT: the runtime mechanics for these spells were built into other
// engines BEFORE the pipeline existed and have been battle-tested through
// many sessions:
//
//   • Instant template-save damage → save-engine.postSaveCard reads the
//     activity's damage parts and posts the save card with auto-damage.
//     spell-timing.mjs SPELL_TABLE drives the save ability + onSave behavior.
//   • Persistent template-trigger damage (entry / start-of-turn / exit) →
//     concentration-widget.mjs's area-denial + trigger pipeline.
//   • Aura emanations (caster-anchored / per-turn re-eval / disposition-
//     filtered) → aura-engine.mjs.
//
// These resolvers therefore deliberately DO NOTHING at runtime. Their value
// is structural — by registering Fireball / Spirit Guardians / Web / etc.
// in the pipeline (via the matching registry files), the spells benefit
// from the pipeline's CROSS-CUTTING SERVICES without touching their
// mechanics:
//
//   1. Slot deferral — cancel = no slot lost (e.g., user aborts template
//      placement; dnd5e still consumed the slot under the old flow).
//   2. Counterspell barrier — the v0.7.21 cast-barrier promise that gates
//      every shape; previously only attack/save/buff/heal/distribute
//      spells benefited.
//   3. Stale-target clearing — the pre-cast targets-clear (relevant for
//      AA-using template spells whose animation aims at the LAST target,
//      not the template).
//   4. Cast-level cache + dedup — unified per-cast bookkeeping.
//
// If a future phase needs to pull a template-shape spell INTO the resolver
// (e.g. unify the Fireball save card under the pipeline so it can be
// customised independently of the generic save-engine), that's a Phase 4
// migration. For now these resolvers are intentional no-ops.
// ──────────────────────────────────────────────────────────────────────────────

import { MODULE_ID } from "../../ace-qol.mjs";

export class TemplateResolver {

  /**
   * Template-save shape (Fireball, Lightning Bolt, Cone of Cold, …).
   * No-op — save-engine + spell-timing handle the save card + damage scaling.
   * Returning silently lets SpellPipeline._commitSlotIfDeferred run.
   */
  static async runSave(ctx) {
    if (ctx?.entry?._debug) {
      console.debug(`${MODULE_ID} | TemplateResolver.runSave: ${ctx.item?.name} no-op (handled by save-engine + spell-timing)`);
    }
  }

  /**
   * Template-trigger shape (Spike Growth, Web, Wall of Fire, Moonbeam, …).
   * No-op — concentration-widget handles entry / start-of-turn / exit saves
   * + Lingering Nausea + difficult-terrain regions.
   */
  static async runTrigger(ctx) {
    if (ctx?.entry?._debug) {
      console.debug(`${MODULE_ID} | TemplateResolver.runTrigger: ${ctx.item?.name} no-op (handled by concentration-widget)`);
    }
  }

  /**
   * Template-heal shape: place the area, then choose from who is inside it.
   *
   * ⚠️🔴 THE AREA IS PART OF THE RULE, NOT DECORATION. Mass Cure Wounds is "up
   * to six creatures in a 30-foot-radius Sphere centered on a point you choose
   * within range". ACE resolved it as a bare picker, which quietly dropped both
   * halves of that sentence: no 60-foot limit on where the wave lands, and no
   * requirement that the six be standing together. A cleric could heal six
   * people scattered across the whole battlefield.
   *
   * ⚠️ AND THE PICK STAYS. Johnny asked whether it could be automatic and
   * answered himself: it cannot, because "choose up to six creatures" is a
   * decision the caster makes. RAW says creatures, not allies — healing an enemy
   * is legal, and sometimes deliberate — so the picker offers everyone inside
   * and the human decides. Seven allies in the sphere is exactly the case an
   * automatic version would get wrong.
   *
   * ⚠️ THE TEMPLATE IS dnd5e's. The sheet already declares the sphere, so this
   * waits for the placement rather than drawing its own — the same reason the
   * other template shapes here do nothing. Two things placing one area is how
   * the animation, the geometry and the GM's view of the spell all came apart.
   */
  static async runHeal(ctx) {
    const { item, actor, entry } = ctx ?? {};
    const name = item?.name ?? "this spell";

    let templateDoc = null;
    try {
      templateDoc = await TemplateResolver._awaitPlacedTemplate(item, actor);
    } catch (err) {
      console.warn(`${MODULE_ID} | ${name}: could not wait for its area:`, err);
    }
    if (!templateDoc) {
      // ⚠️ CANCELLED AND BROKEN MUST NOT LOOK THE SAME. Walking away from the
      // placement is a normal thing to do and costs nothing.
      console.log(`${MODULE_ID} | ${name}: no area was placed, so nobody was healed.`);
      return;
    }

    // ── Where it landed, versus how far the spell reaches ──
    try {
      const { SaveEngine } = await import("../../save-engine.mjs");
      const casterToken = actor?.getActiveTokens?.()?.[0] ?? null;
      const reach = Number(entry?.range);
      if (casterToken && Number.isFinite(reach) && reach > 0) {
        const g = canvas?.grid;
        const perFt = (g?.size ?? 100) / (g?.distance ?? 5);
        const { aceMeasuredCenter } = await import("../../geometry-utils.mjs");
        const from = aceMeasuredCenter(casterToken);
        const ft = Math.round(Math.hypot(templateDoc.x - from.x, templateDoc.y - from.y) / perFt);
        // ⚠️ REPORTED, NOT REFUSED. The GM may have a reason — a readied cast, a
        // homebrew rod, a bigger version of the spell — and ACE blocking a
        // placed area mid-combat is worse than telling him it is long. Same
        // stance the space discrepancy check takes.
        if (ft > reach) {
          console.warn(`${MODULE_ID} | ${name} was placed ${ft} feet away and its range is `
            + `${reach} feet. The cast stands; this is a note, not a refusal.`);
          ui.notifications?.warn(`${name}: that point is ${ft} feet away, and the spell reaches ${reach}.`);
        }
      }

      // ── Who is inside it ──
      await SaveEngine._awaitTemplateShape?.(templateDoc);
      const inside = SaveEngine._getTokensInTemplate(templateDoc) ?? [];
      const caster = actor;

      // ⚠️ 2014 EXCLUDES UNDEAD AND CONSTRUCTS; 2024 DROPPED THAT CLAUSE. The
      // entry says which, per edition, and the excluded ones are not offered at
      // all rather than offered and silently healed for nothing.
      const barred = new Set((entry?.heal?.excludeTypes ?? []).map(t => String(t).toLowerCase()));
      const eligible = inside.filter(t => {
        const type = String(t?.actor?.system?.details?.type?.value ?? "").toLowerCase();
        return !barred.has(type);
      });
      const refused = inside.length - eligible.length;
      if (refused > 0) {
        console.log(`${MODULE_ID} | ${name}: ${refused} creature(s) inside the area cannot be `
          + `healed by it (${[...barred].join(", ")}).`);
      }

      if (!eligible.length) {
        ui.notifications?.info(`${name}: nobody inside that area can be healed by it.`);
        return;
      }

      // ── Choose, then heal ──
      const { SpellTargetPicker } = await import("../../spell-target-picker.mjs");
      const chosen = await SpellTargetPicker.pick({
        spellItem: item,
        casterActor: caster,
        maxTargets: entry?.countResolver?.(ctx.castLevel, 0) ?? 6,
        allowSelf: entry?.picker?.allowSelf !== false,
        only: eligible,
        verb: "Heal",
        icon: "fa-solid fa-heart",
      });
      if (!chosen?.length) {
        console.log(`${MODULE_ID} | ${name}: the area was placed but nobody was chosen.`);
        return;
      }

      const targets = chosen.map(a => {
        const token = a.getActiveTokens?.()?.[0]
          ?? canvas.tokens?.placeables.find(t => t.actor?.id === a.id) ?? null;
        return { actor: a, token, tokenId: token?.id ?? null,
                 name: token?.name ?? a.name,
                 img: token?.document?.texture?.src ?? a.img };
      }).filter(t => t.token);
      if (!targets.length) return;

      const { HealResolver } = await import("./heal.mjs");
      await HealResolver.runMulti(ctx, { targets });
    } catch (err) {
      console.error(`${MODULE_ID} | ${name}: the area landed but the heal failed:`, err);
      ui.notifications?.error(`${name} placed its area but could not heal — see the console.`);
    }
  }

  /**
   * Wait for the area this cast places, or give up saying so.
   *
   * ⚠️ MATCHED TO THE CAST, NOT TO THE NEWEST TEMPLATE. "Whatever appeared last"
   * is a race the moment two things are placed close together, and the chat log
   * is not a database. dnd5e stamps the origin activity onto the template, so
   * this waits for one carrying THIS item's uuid.
   */
  static _awaitPlacedTemplate(item, actor, timeoutMs = 60000) {
    return new Promise((resolve) => {
      let hookId = null;
      let timer = null;
      const done = (doc) => {
        if (hookId != null) { try { Hooks.off("createMeasuredTemplate", hookId); } catch (_) {} hookId = null; }
        if (timer) { clearTimeout(timer); timer = null; }
        resolve(doc ?? null);
      };
      try {
        hookId = Hooks.on("createMeasuredTemplate", (doc) => {
          try {
            const origin = String(doc?.flags?.dnd5e?.origin ?? "");
            if (item?.uuid && origin && !origin.startsWith(item.uuid)) return;
            if (doc?.author?.id && doc.author.id !== game.user.id) return;
            done(doc);
          } catch (_) { done(doc); }
        });
      } catch (err) {
        console.warn(`${MODULE_ID} | could not listen for ${item?.name}'s area:`, err);
        return done(null);
      }
      // A placement nobody completes must not hang the cast forever.
      timer = setTimeout(() => done(null), timeoutMs);
    });
  }

  /**
   * Aura shape (Spirit Guardians, Aura of Vitality, Crusader's Mantle, …).
   * No-op — aura-engine handles emanation re-evaluation + disposition
   * filtering + per-turn damage.
   */
  static async runAura(ctx) {
    // ⚠️🔴 THIS NO-OP SAID IT WAS "handled by aura-engine" AND FOR
    // SPIRIT GUARDIANS THAT WAS NOT TRUE.
    //
    // aura-engine.mjs knows exactly five things, and all five are paladin
    // CLASS FEATURES: Aura of Protection, Warding, Courage, Hate and The
    // Guardian. It has never heard of a SPELL. So a spell tagged shape
    // "aura" dispatched here, this did nothing, and the engine it named did
    // nothing either - three layers each certain another one had it.
    //
    // Johnny, 2026-08-27: "Spirit Guardians did absolutely nothing: no
    // animation, nothing."
    //
    // ⚠️ A COMMENT THAT NAMES ITS SUCCESSOR MUST BE CHECKABLE. The other
    // two no-ops in this file are honest - save-engine really does own
    // template-save, and concentration-widget really does own
    // template-trigger. This one named an owner that could not accept it, and
    // nothing anywhere would ever have said so. Now it asks.
    const name = ctx?.item?.name ?? "this spell";
    let owned = false;
    try {
      const { AuraEngine } = await import("../../aura-engine.mjs");
      owned = !!AuraEngine?.knowsAura?.(ctx?.item);
    } catch (err) {
      console.warn(`${MODULE_ID} | could not ask the aura engine about "${name}":`, err);
      return;
    }

    if (owned) {
      if (ctx?.entry?._debug) {
        console.debug(`${MODULE_ID} | TemplateResolver.runAura: ${name} - aura-engine owns it`);
      }
      return;
    }

    console.warn(`${MODULE_ID} | "${name}" is registered with shape "aura", which hands it to `
      + `the aura engine - and the aura engine only knows paladin class-feature auras, not `
      + `spells. Nothing is going to resolve this cast. If it places a template and deals `
      + `damage on a save, its shape should be "template-trigger" (like Moonbeam), which `
      + `the concentration tracker already drives.`);
  }
}
