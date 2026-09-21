// ─── ACE: QOL — What an effect leaves behind goes with it ────────────────────
//
// Johnny, 2026-09-21, dumping Aryel after a fight:
//   "statuses empty. Shield effect still on the actor, disabled, not deleted.
//    Absorb Elements (fire) still enabled. One Sequencer clip still playing:
//    persistent bubble ... origin is that Absorb Elements effect. ace-qol flags
//    still have absorbElementsBonus fire 3d6 and reactionUsed true."
//
//   "RULE. When a condition or spell effect is removed or disabled, end every
//    Sequencer clip whose origin is that effect. Delete the effect. Do not
//    leave it disabled. Clear the matching ACE flag... Same rule for Frightened
//    and for Shield. A GM clearing the condition on the token must take the
//    ring and the clip with it. No leftover only on Aryel. Any token."
//
// ⚠️ ONE SWEEPER, NOT A CLEAN-UP PER FEATURE. Absorb Elements, Shield,
// Frightened and everything after them leave the same three things behind: a
// picture somebody else is playing, a record on the sheet, and a flag ACE
// wrote. Each engine cleaning up after itself is how three of them were missed;
// this listens where every effect ends, whoever ended it — ACE, dnd5e, the
// effects panel, the GM's right-click, another module.
//
// ⚠️ DISABLED IS NOT GONE. A disabled effect keeps its row on the sheet, keeps
// its persistent clip on the canvas (whoever is playing it sees an effect that
// still exists), and for a dnd5e condition it blocks that condition from ever
// being applied again, because the fixed id is still taken. So a disable is
// turned into a delete.
//
// ⚠️ AND IT NEVER TOUCHES TOKEN OUTLINES (his rule): rings ACE draws for
// conditions are refreshed, the outline module's own work is left alone.
// ──────────────────────────────────────────────────────────────────────────────

const MODULE_ID = "ace-qol";
const LOG = "ace-qol | leftovers";

/** The ACE flags an effect can be holding on its creature. */
const ABSORB_FLAG = "absorbElementsBonus";
const REACTION_FLAG = "reactionUsed";

const nameOf = (e) => String(e?.name ?? "").toLowerCase();

export class EffectSweeper {

  static init() {
    if (this._initialized) return;
    this._initialized = true;

    Hooks.on("deleteActiveEffect", (effect, options = {}) => {
      EffectSweeper.sweep(effect, { why: "it was removed", replacing: !!options?.aceReplacing })
        .catch(err => console.warn(`${LOG} | could not clear up after "${effect?.name}":`, err));
    });

    Hooks.on("updateActiveEffect", (effect, changes = {}) => {
      if (changes?.disabled !== true) return;
      EffectSweeper.sweep(effect, { why: "it was switched off", disable: true })
        .catch(err => console.warn(`${LOG} | could not clear up after "${effect?.name}":`, err));
    });

    console.debug(`${LOG} | online: an effect that ends takes its clip, its record and its flag with it.`);
  }

  /**
   * Everything this effect was holding, let go in the same tick.
   *
   * @param {ActiveEffect} effect
   * @param {object} o  `{ why, disable, replacing }`
   */
  static async sweep(effect, { why = "it ended", disable = false, replacing = false } = {}) {
    const actor = effect?.parent ?? null;
    if (!actor?.uuid) return;

    // The clip goes whether or not this client is the GM: Sequencer plays per
    // client, so each one ends what it is playing.
    const ended = EffectSweeper.endClips(effect);

    // ⚠️ A REPLACEMENT KEEPS ITS FLAGS. The condition door deletes the old copy
    // before placing a fresh one; taking the creature's bonus off between the
    // two would lose it (2026-09-20, the same trap the presence immunity hit).
    if (replacing) {
      if (ended) console.log(`${LOG} | ${actor.name}: "${effect.name}" was replaced; ${ended} clip(s) ended with the old copy.`);
      return;
    }

    if (game.users?.activeGM === game.user) {
      await EffectSweeper.clearFlags(actor, effect);
      // ⚠️ AND IT DOES NOT STAY ON THE SHEET SWITCHED OFF.
      if (disable) {
        try {
          await effect.delete();
          console.log(`${LOG} | ${actor.name}: "${effect.name}" was switched off, so it was removed `
            + `rather than left disabled (a disabled condition blocks that condition forever).`);
        } catch (err) {
          if (!/does not exist/i.test(String(err?.message ?? err))) {
            console.warn(`${LOG} | "${effect.name}" was switched off and could not be removed:`, err);
          }
        }
      }
    }

    EffectSweeper.refreshRing(actor);
    if (ended || disable) {
      console.log(`${LOG} | ${actor.name}: "${effect.name}" ${why}; ${ended} clip(s) of its own ended.`);
    }
  }

  /**
   * End every Sequencer clip whose origin is this effect.
   *
   * Automated Animations plays an effect's picture as a PERSISTENT clip keyed
   * to the effect's uuid, which is why Aryel's bubble was still on her after
   * the effect had gone quiet. Sequencer ends them by origin; the token sweep
   * below catches anything filed under the effect's id instead.
   *
   * @returns {number} how many were ended
   */
  static endClips(effect) {
    try {
      const mgr = globalThis.Sequencer?.EffectManager;
      if (!mgr?.endEffects) return 0;
      const uuid = effect?.uuid ?? null;
      const id = effect?.id ?? null;
      let n = 0;

      for (const origin of [uuid, id].filter(Boolean)) {
        try {
          const living = mgr.getEffects?.({ origin }) ?? [];
          if (living.length) {
            mgr.endEffects({ origin });
            n += living.length;
          }
        } catch (err) {
          console.debug(`${LOG} | could not end clips by origin "${origin}":`, err?.message ?? err);
        }
      }

      // Belt and braces: anything on this creature's own tokens that names the
      // effect in its origin, which is how some packs file a persistent clip.
      try {
        const tokens = effect?.parent?.getActiveTokens?.() ?? [];
        for (const tok of tokens) {
          const here = mgr.getEffects?.({ object: tok }) ?? [];
          for (const fx of here) {
            const org = String(fx?.data?.origin ?? "");
            const mine = (!!uuid && org === uuid) || (!!id && org.includes(id));
            if (!mine) continue;
            mgr.endEffects({ object: tok, origin: fx.data.origin });
            n++;
          }
        }
      } catch (err) {
        console.debug(`${LOG} | the token sweep for leftover clips failed:`, err?.message ?? err);
      }
      return n;
    } catch (err) {
      console.warn(`${LOG} | could not end the clips for "${effect?.name}":`, err);
      return 0;
    }
  }

  /**
   * The ACE flags this effect was the reason for.
   *
   * ⚠️ ONLY WHAT BELONGS TO IT. A creature can hold an absorb of cold and an
   * absorb of fire; the bonus only goes when the effect that granted it does.
   */
  static async clearFlags(actor, effect) {
    const mine = effect?.flags?.[MODULE_ID] ?? {};
    const name = nameOf(effect);
    const isAbsorb = /absorb elements/.test(name) || mine.absorbElements != null
      || String(mine.reactionSpell ?? "").toLowerCase() === "absorb elements";
    const isReactionEffect = mine.type === "reactionEffect" || isAbsorb || /^shield\b/.test(name);

    try {
      if (isAbsorb) {
        const held = actor.getFlag?.(MODULE_ID, ABSORB_FLAG) ?? null;
        // Another absorb still standing keeps its own bonus.
        const another = (actor.effects?.contents ?? []).some(e => e.id !== effect.id && !e.disabled
          && /absorb elements/.test(nameOf(e)));
        if (held && !another) {
          await actor.unsetFlag?.(MODULE_ID, ABSORB_FLAG);
          console.log(`${LOG} | ${actor.name}: the absorbed ${held.type ?? ""} bonus (${held.formula ?? "?"}) `
            + `went with the effect that granted it.`);
        }
      }
      // ⚠️ THE REACTION WINDOW HAS PASSED (his rule). What a reaction left is
      // gone, so the reaction that made it is no longer being spent; a fresh
      // one is claimed the moment the next box opens.
      if (isReactionEffect && actor.getFlag?.(MODULE_ID, REACTION_FLAG) === true) {
        const stillReacting = (actor.effects?.contents ?? []).some(e => e.id !== effect.id && !e.disabled
          && e.flags?.[MODULE_ID]?.type === "reactionEffect");
        if (!stillReacting) {
          await actor.unsetFlag?.(MODULE_ID, REACTION_FLAG);
          console.log(`${LOG} | ${actor.name}: its spent-reaction mark came off with "${effect.name}".`);
        }
      }
    } catch (err) {
      console.warn(`${LOG} | could not clear ${actor?.name}'s flags for "${effect?.name}":`, err);
    }
  }

  /**
   * ACE's own condition ring, redrawn now that the effect is gone.
   * ⚠️ TOKEN OUTLINES ARE NOT OURS (his rule): only ACE's own visuals are asked.
   */
  static refreshRing(actor) {
    try {
      // ACE's condition visuals redraw on Foundry's own `refreshToken`, so the
      // token is asked to refresh rather than reaching into that engine. The
      // outline module's own filters are untouched by this.
      for (const tok of actor?.getActiveTokens?.() ?? []) {
        if (tok?.renderFlags?.set) tok.renderFlags.set({ refreshEffects: true, refreshState: true });
        else tok?.refresh?.();
      }
    } catch (err) {
      console.debug(`${LOG} | the condition ring could not be refreshed:`, err?.message ?? err);
    }
  }
}
