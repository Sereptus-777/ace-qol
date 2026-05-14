// ============================================================
// ACE QOL — Concentration Widget
// Floating persistent card for concentration AoE spells
// (Moonbeam, Spirit Guardians, Cloudkill, etc.)
//
// Listens for persistent spell creation, then:
//   - Renders a floating card with spell info + current targets
//   - Tracks template movement and re-targets
//   - Detects turn changes for start/end-of-turn triggers
//   - Auto-dismisses when concentration breaks
// ============================================================

// NOTE: MODULE_ID hardcoded to avoid circular import (ace-qol.mjs imports us)
const MODULE_ID = "ace-qol";
import { TIMING, getSpellTiming } from "./spell-timing.mjs";
import { QolSettings } from "./settings.mjs";
import { DamageCalculator } from "./damage-calculator.mjs";

const TAG = `${MODULE_ID} | ConcWidget`;

export class ConcentrationWidget {

  constructor(saveEngine) {
    this._saveEngine = saveEngine;
    /** @type {Map<string, SpellTracker>} templateId → spell tracking data */
    this._activeSpells = new Map();
    this._container = null;
    this._registerHooks();
  }

  // ═══════════════════════════════════════════════════════════════
  //  Hook Registration
  // ═══════════════════════════════════════════════════════════════

  _registerHooks() {
    // Listen for persistent spells created by SaveEngine
    Hooks.on("ace-qol.persistentSpellCreated", (data) => {
      this._onPersistentSpellCreated(data);
    });

    // On reload, re-register trackers for any persistent-spell templates
    // that survived. Without this, Spike Growth / Moonbeam / etc. templates
    // remain visible on canvas but `_activeSpells` Map is empty, so
    // dragging a token through does nothing — no damage, no save card.
    //
    // Run BOTH immediately (this _registerHooks fires from the `ready`
    // hook in ace-qol.mjs, AFTER canvasReady — so the initial canvasReady
    // already fired before our listener could register, and we'd miss the
    // boot. Calling the work directly here handles boot) AND on future
    // canvasReady fires (handles scene switches).
    const _doReattach = () => {
      this._reattachTrackersFromCanvas().catch(err =>
        console.warn(`${TAG} | tracker re-attach failed:`, err)
      );
    };
    _doReattach();                            // handles initial boot
    Hooks.on("canvasReady", _doReattach);     // handles scene switches

    // Template moved — re-target
    Hooks.on("updateMeasuredTemplate", (templateDoc, changes, opts, userId) => {
      if (changes.x !== undefined || changes.y !== undefined ||
          changes.direction !== undefined || changes.distance !== undefined) {
        this._onTemplateMove(templateDoc);
      }
    });

    // Template deleted — remove widget
    Hooks.on("deleteMeasuredTemplate", (templateDoc, opts, userId) => {
      this._onTemplateDeleted(templateDoc.id);
    });

    // Turn change in combat — check for start/end-of-turn triggers
    Hooks.on("updateCombat", (combat, changes, opts, userId) => {
      if (changes.turn !== undefined || changes.round !== undefined) {
        this._onTurnChange(combat, changes);
      }
    });

    // Concentration broken — active effect removed
    Hooks.on("deleteActiveEffect", (effect, opts, userId) => {
      this._onEffectRemoved(effect);
    });

    // Note: movement-damage UNDO button wiring is registered globally in
    // ace-qol.mjs (not here) so non-GM clients also get the button hidden.
    // ConcentrationWidget is GM-only and would never run on player clients.

    // Also check for the "concentrating" status being removed
    Hooks.on("updateActiveEffect", (effect, changes, opts, userId) => {
      if (changes.disabled === true) {
        this._onEffectRemoved(effect);
      }
    });

    // v0.6.0 — Token movement triggers Phase 1 entry detection +
    // Phase 2 movement-distance damage for persistent templates.
    //
    // We use BOTH preUpdateToken (to capture old position) and
    // updateToken (to react after the move). The hook fires AFTER the
    // document has its new position applied, so we need to stash the
    // pre-move coords during preUpdateToken to compute the move vector.
    if (!this._preMovePositions) this._preMovePositions = new Map();

    Hooks.on("preUpdateToken", (tokenDoc, changes, opts, userId) => {
      if (!game.user.isGM) return;
      if (changes.x === undefined && changes.y === undefined) return;
      this._preMovePositions.set(tokenDoc.id, {
        x: tokenDoc.x,
        y: tokenDoc.y,
      });
    });

    // Dedup tracker — Foundry/dnd5e can fire updateToken multiple times for
    // a single user-driven move (preview update + final commit, animation
    // settle, dnd5e RegionMovement re-emits, etc.). Without dedup, Spike
    // Growth movement damage rolls twice for one move. Key by
    // tokenId + position-quad so a legitimate back-and-forth move (rare
    // but possible) is still processed independently.
    if (!this._recentMoveKeys) this._recentMoveKeys = new Map();

    Hooks.on("updateToken", (tokenDoc, changes, opts, userId) => {
      if (!game.user.isGM) return;
      if (changes.x === undefined && changes.y === undefined) return;

      // v0.6.4: Read NEW positions from the `changes` payload, not from
      // tokenDoc.x/y. Diagnostic showed tokenDoc.x/y was being mutated
      // by other modules (autoRotation in user's setup) between the hook
      // fire and our setTimeout(0) handler — by the time our code ran,
      // td.y had reverted to a partial / pre-move value, making our
      // hit-test miss entries. The `changes` payload is the immutable
      // intent of THIS update, so it's safe to read.
      const pre = this._preMovePositions.get(tokenDoc.id);
      this._preMovePositions.delete(tokenDoc.id);
      const newX = (changes.x !== undefined) ? changes.x : tokenDoc.x;
      const newY = (changes.y !== undefined) ? changes.y : tokenDoc.y;
      const oldX = pre?.x ?? newX;
      const oldY = pre?.y ?? newY;

      // Dedup #1 (vector-exact): same `oldXY > newXY` within 2 seconds is
      // a duplicate fire. Foundry's V13 token movement can re-emit
      // `updateToken` after animation settle, which can be 1+ seconds
      // after the initial fire. The previous 500ms window was too short
      // and missed the second tick — the bug the user pointed out (move
      // 5ft, see 2d4 roll, ~1s pause, see ANOTHER 2d4 roll).
      const moveKey = `${tokenDoc.id}:${oldX},${oldY}>${newX},${newY}`;
      const lastSeen = this._recentMoveKeys.get(moveKey);
      const now = Date.now();
      if (lastSeen && (now - lastSeen) < 2000) {
        console.log(`${TAG} | duplicate updateToken (vector-key) for ${tokenDoc.name ?? tokenDoc.id} — skipped (within 2000ms dedup window)`);
        return;
      }
      this._recentMoveKeys.set(moveKey, now);
      // Prune stale entries opportunistically (keep map small)
      if (this._recentMoveKeys.size > 64) {
        for (const [k, t] of this._recentMoveKeys) {
          if (now - t > 4000) this._recentMoveKeys.delete(k);
        }
      }

      // Dedup #2 (token-destination): if the second fire mutates `newX/Y`
      // slightly (snap-to-grid, collision adjustment) the vector key
      // misses. Belt-and-suspenders: if the same TOKEN already produced
      // movement damage within 1500ms with a destination close to the
      // current one, skip. "Close" = within 1 grid cell, which handles
      // any post-animation position correction by Foundry or modules.
      if (!this._recentDamagePos) this._recentDamagePos = new Map();
      const recent = this._recentDamagePos.get(tokenDoc.id);
      if (recent && (now - recent.t) < 1500) {
        const gridSize = canvas.grid?.size ?? 100;
        const dx = (newX - recent.x);
        const dy = (newY - recent.y);
        if ((dx * dx + dy * dy) <= (gridSize * gridSize)) {
          console.log(`${TAG} | duplicate updateToken (token-dest) for ${tokenDoc.name ?? tokenDoc.id} — skipped (Δ=${Math.round(Math.hypot(dx, dy))}px, ${now - recent.t}ms ago)`);
          return;
        }
      }
      this._recentDamagePos.set(tokenDoc.id, { x: newX, y: newY, t: now });

      // v0.6.4: Removed setTimeout deferral — caused stale-position reads
      // when other modules mutated td.x/td.y between hook fire and our
      // handler. Run synchronously now.
      this._onTokenMoved(tokenDoc, { oldX, oldY, newX, newY });
    });

    console.log(`${TAG} | Hooks registered`);
  }

  // ═══════════════════════════════════════════════════════════════
  //  Persistent Spell Registration
  // ═══════════════════════════════════════════════════════════════

  /**
   * On canvasReady (boot + scene switch), walk all persistent-spell
   * templates on the scene and re-emit `ace-qol.persistentSpellCreated`
   * for each so the tracker registers AND the Sequencer animation re-plays.
   *
   * Without this, a reload leaves Spike Growth visible on canvas (Foundry
   * persisted the template doc) but the `_activeSpells` Map is empty, so
   * dragging a token through does nothing. This walks the templates,
   * resolves the item from `flags.dnd5e.origin`, computes timing, and
   * synthesizes the persistentSpellCreated event so the normal flow runs.
   */
  async _reattachTrackersFromCanvas() {
    if (!game.user.isGM) return;
    const templates = canvas?.scene?.templates?.contents ?? [];
    if (!templates.length) return;

    let reattached = 0;
    for (const tdoc of templates) {
      try {
        // Skip if we already have a tracker for this template (e.g., the
        // canvasReady fires during a scene-switch on the same world where
        // the spell was just cast).
        if (this._activeSpells.has(tdoc.id)) continue;

        const dnd5eFlags = tdoc.flags?.dnd5e;
        const originUuid = dnd5eFlags?.origin;
        if (!originUuid) continue; // not a dnd5e-activity-placed template

        // Resolve the activity/item. dnd5e origin is the Activity UUID;
        // its parent is the Item. Some legacy templates store the Item
        // UUID directly — handle both.
        const resolved = await fromUuid(originUuid).catch(() => null);
        if (!resolved) continue;
        const item = resolved.item ?? resolved; // Activity has .item; Item is itself
        if (!item || item.documentName !== "Item") continue;
        const actor = item.actor;
        if (!actor) continue;

        // Determine timing + damage info — same path save-engine uses
        // when first detecting movement-damage spells.
        const timing = getSpellTiming(item);
        const damageParts = item.system?.damage?.parts ?? [];
        let formula = null, damageType = null;
        if (Array.isArray(damageParts) && damageParts.length > 0) {
          const p = damageParts[0];
          if (Array.isArray(p)) {
            formula    = p[0] ?? null;
            damageType = p[1] ?? null;
          } else if (p && typeof p === "object") {
            if (p.number != null && p.denomination != null) {
              formula = `${p.number}d${p.denomination}` + (p.bonus ? `+${p.bonus}` : "");
            }
            damageType = p.types?.[0] ?? null;
          }
        }
        // Description fallback (for spells that store damage in text only)
        if (!formula) {
          const descRaw = item.system?.description?.value ?? "";
          const desc = String(descRaw).replace(/<[^>]+>/g, " ").replace(/&\w+;/g, " ");
          let m = desc.match(/takes?\s+(\d+d\d+)\s+([a-zA-Z]+)\s+damage\s+(?:for\s+every|per)\s+5\s+(?:feet|ft)/i);
          if (!m) {
            m = desc.match(/\[\[\s*\/damage\s+(\d+d\d+)[^\]]*?type\s*=\s*([a-zA-Z]+)[^\]]*?\]\]\s*damage\s+(?:for\s+every|per)\s+5\s+(?:feet|ft)/i);
          }
          if (m) {
            formula    = m[1];
            damageType = m[2].toLowerCase();
          }
        }

        // Determine save data — look for any activity with a save block
        const activities = item.system?.activities?.contents ?? Array.from(item.system?.activities ?? []);
        let saveActivity = null;
        for (const act of activities) {
          if (act.save?.ability) { saveActivity = act; break; }
        }
        const saveAbility = saveActivity?.save?.ability ?? null;
        const saveDC      = saveActivity?.save?.dc?.value ?? saveActivity?.save?.dc?.calculation
                         ?? item.system?.save?.dc ?? null;
        const halfOnSave  = saveActivity?.damage?.onSave === "half"
                         || (saveActivity?.save?.onSave === "half");

        // Skip if we can't determine ANY persistent-spell metadata
        // (means it's a one-shot template like Fireball that's already
        // resolved — those shouldn't re-attach).
        if (!saveAbility && !formula) continue;

        // Emit through the same hook the live-cast path uses. The
        // _onPersistentSpellCreated handler does the rest (register
        // tracker, play Sequencer animation, render widget).
        Hooks.callAll("ace-qol.persistentSpellCreated", {
          item, actor, templateDoc: tdoc, timing,
          saveAbility, saveDC, halfOnSave,
          damageTypes: damageType ? [damageType] : [],
          damageFormula: formula,
          tokens: [],
        });
        reattached++;
      } catch (err) {
        console.warn(`${TAG} | _reattachTrackersFromCanvas: failed for template ${tdoc?.id}`, err);
      }
    }
    if (reattached > 0) {
      console.log(`${TAG} | canvasReady: re-attached ${reattached} persistent-spell tracker(s)`);
    }
  }

  _onPersistentSpellCreated(data) {
    const { item, actor, templateDoc, timing, saveAbility, saveDC,
            halfOnSave, damageTypes, damageFormula, tokens } = data;

    if (!templateDoc?.id) {
      console.warn(`${TAG} | No template for persistent spell "${item?.name}"`);
      return;
    }

    const tracker = {
      templateId: templateDoc.id,
      templateDoc,
      item,
      actor,
      timing,
      saveAbility,
      saveDC,
      halfOnSave,
      damageTypes,
      damageFormula,                  // v0.6.5: needed for Spike Growth-style movement damage
      tokens: tokens ?? [],
      createdAt: Date.now(),
    };

    this._activeSpells.set(templateDoc.id, tracker);
    const variant = saveAbility ? "save" : "movement-damage";
    console.log(`${TAG} | Registered persistent spell: ${item.name} (${timing.timing}, ${variant}) with ${tracker.tokens.length} initial targets`);

    this._renderWidgets();

    // Sequencer animation hook — owns the visual ourselves instead of
    // relying on Auto-Animations (which has leaked orphans + paused on
    // hidden flag in the user's setup). See SPELL_ANIMATIONS table below
    // for the name→Sequencer database ID mapping. The effect attaches to
    // the template, persists for its lifetime, and is cleaned up by the
    // deleteMeasuredTemplate hook in ace-qol.mjs.
    try { this._playPersistentSpellAnimation(item, templateDoc); }
    catch (err) { console.warn(`${TAG} | persistent-spell animation failed:`, err); }

    // If timing includes "enter", tokens already in the area might need to save
    // (Depends on interpretation — some GMs say "enter" means voluntarily move in)
    // We'll let the GM trigger this manually via INFLICT DAMAGE
  }

  /**
   * Spell name → Sequencer Database ID mapping. JB2A Patreon naming.
   * Add entries here to give a spell its own Sequencer animation through
   * ace-qol instead of relying on Auto-Animations.
   *
   * `opacity` is 0..1; default 1.0 (fully solid). Use lower values for
   * effects meant to be subtle (cloud-style spells, particle swirls).
   *
   * `belowTokens` true puts the effect under tokens so they walk over it
   * naturally — appropriate for ground-level effects like Spike Growth,
   * Web, Grease. false renders above (Moonbeam, Cloudkill, Fog Cloud).
   */
  static SPELL_ANIMATIONS = {
    // Spike Growth — JB2A doesn't ship a dedicated asset; user has the
    // `blfx` module which DOES, so we use that one.
    "spike growth":      { db: "blfx.spell.template.circle.nature.spike_growth1.vine_thorn.loop.color1", opacity: 1.0,  belowTokens: true  },
    // Wall of Thorns has no good JB2A or blfx asset — fall back to the
    // same blfx spike_growth animation; thematically very close (thorny vines).
    "wall of thorns":    { db: "blfx.spell.template.circle.nature.spike_growth1.vine_thorn.loop.color1", opacity: 1.0,  belowTokens: false },
    "cloud of daggers":  { db: "jb2a.cloud_of_daggers.daggers.dark_red", opacity: 0.9,  belowTokens: false },
    "moonbeam":          { db: "jb2a.moonbeam.01.loop.blue",             opacity: 0.85, belowTokens: false },
    "spirit guardians":  { db: "jb2a.spirit_guardians.blueyellow.ring",  opacity: 0.85, belowTokens: false },
    "fog cloud":         { db: "jb2a.fog_cloud.01.white",                opacity: 0.65, belowTokens: false },
    // Cloudkill has no dedicated JB2A asset — green fog_cloud_02 substitutes.
    "cloudkill":         { db: "jb2a.fog_cloud.02.green",                opacity: 0.85, belowTokens: false },
    // Stinking Cloud — same trick, saturated green fog_cloud_02 variant.
    "stinking cloud":    { db: "jb2a.fog_cloud.02.green02",              opacity: 0.85, belowTokens: false },
    // Wall of Fire — JB2A has sized rectangles (100x100, 200x100, etc.).
    // 100x100 yellow plus scaleToObject handles arbitrary template sizes.
    "wall of fire":      { db: "jb2a.wall_of_fire.100x100.yellow",       opacity: 1.0,  belowTokens: false },
    "grease":            { db: "jb2a.grease.dark_brown.loop",            opacity: 0.95, belowTokens: true  },
    // Web — no dedicated JB2A web asset in this user's library; the
    // eldritch_web variant is close enough thematically (sticky webbing).
    "web":               { db: "jb2a.shield_themed.below.eldritch_web.01.dark_green", opacity: 0.95, belowTokens: true  },
  };

  _playPersistentSpellAnimation(item, templateDoc) {
    if (!game.modules?.get?.("sequencer")?.active) return;
    const name = (item?.name ?? "").toLowerCase().trim();
    const cfg = ConcentrationWidget.SPELL_ANIMATIONS[name];
    if (!cfg) return; // no mapping — let AA (or nothing) handle it

    try {
      let chain = Sequencer.Effect.create()
        .file(cfg.db)
        .attachTo(templateDoc)
        .persist()
        .opacity(cfg.opacity ?? 1.0);

      // Circle / rectangle / cone templates: scale the animation to match
      // the template's bounding box. Ray templates need stretchTo because
      // they have a direction vector and the animation should follow it.
      if (templateDoc.t === "ray") {
        chain = chain.stretchTo(templateDoc);
      } else {
        chain = chain.scaleToObject(1.0);
      }

      if (cfg.belowTokens) chain = chain.belowTokens();
      chain.play();
      console.log(`${TAG} | Played animation "${cfg.db}" for ${item.name} (opacity ${cfg.opacity ?? 1.0}, belowTokens=${!!cfg.belowTokens})`);
    } catch (err) {
      console.warn(`${TAG} | Sequencer.Effect chain failed for ${item?.name}:`, err);
    }
  }

  // ═══════════════════════════════════════════════════════════════
  //  Template Movement — Re-target
  // ═══════════════════════════════════════════════════════════════

  async _onTemplateMove(templateDoc) {
    const tracker = this._activeSpells.get(templateDoc.id);
    if (!tracker) return;
    if (!game.user.isGM) return; // entry-trigger save is GM-only work

    // Update the template reference
    tracker.templateDoc = templateDoc;

    // Re-calculate tokens inside the template
    const newTokens = this._saveEngine.constructor._getTokensInTemplate?.(templateDoc) ?? [];
    const oldIds = new Set(tracker.tokens.map(t => t.id));
    const newIds = new Set(newTokens.map(t => t.id));

    // Find newly entered tokens
    const entered = newTokens.filter(t => !oldIds.has(t.id));
    const exited = tracker.tokens.filter(t => !newIds.has(t.id));

    tracker.tokens = newTokens;

    // Bug fix: previously we only logged + posted a notification toast for
    // entered tokens. The actual save card flow was never invoked. Now we
    // route every newly-entered token through `_onTokenEnteredTemplate`,
    // which handles NPC auto-roll vs PC prompt the same way token-entry
    // does. Also keep `tokensInside` Set in sync for both directions so
    // the token-movement path doesn't double-fire when a token is
    // already inside a template that just moved onto it.
    if (!tracker.tokensInside) tracker.tokensInside = new Set();

    if (entered.length > 0) {
      console.log(`${TAG} | template-move: ${entered.length} token(s) entered ${tracker.item.name}`);
      const timingStr = tracker.timing?.timing ?? "";
      const triggerOnEnter = timingStr.includes("enter");
      for (const tok of entered) {
        tracker.tokensInside.add(tok.id);
        if (triggerOnEnter) {
          await this._onTokenEnteredTemplate(tracker, tok);
        }
      }
    }
    if (exited.length > 0) {
      console.log(`${TAG} | template-move: ${exited.length} token(s) exited ${tracker.item.name}`);
      for (const tok of exited) {
        tracker.tokensInside.delete(tok.id);
      }
    }

    this._renderWidgets();
  }

  // ═══════════════════════════════════════════════════════════════
  //  Template Deleted — Remove Widget
  // ═══════════════════════════════════════════════════════════════

  async _onTemplateDeleted(templateId) {
    if (!this._activeSpells.has(templateId)) return;
    const tracker = this._activeSpells.get(templateId);
    console.log(`${TAG} | Template deleted for ${tracker.item?.name} — removing widget + dropping concentration`);
    this._activeSpells.delete(templateId);
    this._renderWidgets();

    // v0.6.3: Manually deleting a persistent spell's template ends the
    // concentration on that spell (no template = no spell area = no
    // ongoing effect). Drop the actor's concentration effect tied to
    // this item.
    if (game.user.isGM && tracker.actor && tracker.item) {
      await this._dropConcentrationForItem(tracker.actor, tracker.item);
    }
  }

  /**
   * v0.6.3: Find and delete the active concentration effect on `actor`
   * that's tied to `item`. dnd5e 5.x stores concentration as an active
   * effect with status "concentrating" — we match it via origin / item-
   * uuid / name. Returns true if an effect was deleted.
   */
  async _dropConcentrationForItem(actor, item) {
    if (!actor || !item) return false;
    const effects = Array.from(actor.effects?.contents ?? actor.effects ?? []);
    const itemName  = (item.name ?? "").toLowerCase();
    const itemId    = item.id ?? "";
    const itemUuid  = item.uuid ?? "";

    for (const effect of effects) {
      const isConcentration = effect.statuses?.has?.("concentrating")
                           || !!effect.flags?.dnd5e?.itemData
                           || !!effect.flags?.dnd5e?.dependents
                           || (effect.name ?? "").toLowerCase().includes("concentrating");
      if (!isConcentration) continue;

      // Match by origin path, item-uuid flag, or name substring
      const origin    = effect.origin ?? "";
      const flagUuid  = effect.flags?.dnd5e?.itemUuid
                     ?? effect.flags?.dnd5e?.dependents?.[0]?.uuid
                     ?? "";
      const effectName = (effect.name ?? "").toLowerCase();
      const matches = (itemId   && (origin.includes(itemId)   || flagUuid.includes(itemId)))
                   || (itemUuid && (origin.includes(itemUuid) || flagUuid.includes(itemUuid)))
                   || (itemName && effectName.includes(itemName));

      if (matches) {
        console.log(`${TAG} | Dropping concentration "${effect.name}" on ${actor.name}`);
        try {
          await effect.delete();
          return true;
        } catch (err) {
          console.warn(`${TAG} | Failed to delete concentration effect on ${actor.name}:`, err);
        }
      }
    }
    console.log(`${TAG} | No matching concentration effect found on ${actor.name} for item ${item.name}`);
    return false;
  }

  // ═══════════════════════════════════════════════════════════════
  //  Turn Change — Check Triggers
  // ═══════════════════════════════════════════════════════════════

  async _onTurnChange(combat, changes) {
    // v0.4.22.10: GM-only gate. The body of this function calls
    // `_triggerSaveForToken` which posts save cards via the SaveEngine.
    // Without this guard, every player client would post their own save
    // card on every relevant turn change — N players in a session would
    // produce N duplicate save cards. The hook fires on every client
    // because Foundry's `updateCombat` hook is broadcast.
    if (!game.user.isGM) return;
    if (!this._activeSpells.size) return;

    // Who just started their turn?
    const currentCombatant = combat.combatant;
    const currentToken = currentCombatant?.token;

    // Who just ended their turn? (previous combatant)
    const turns = combat.turns ?? [];
    const currentIdx = combat.turn ?? 0;
    const prevIdx = currentIdx - 1;
    const prevCombatant = prevIdx >= 0
      ? turns[prevIdx]
      : turns[turns.length - 1]; // wrapped from previous round
    const prevToken = prevCombatant?.token;

    for (const [templateId, tracker] of this._activeSpells) {
      const timing = tracker.timing.timing;
      // Check current state via the canvas template — `tracker.tokens` can
      // go stale if tokens moved without a template-move event. Using the
      // live placeable's hit-test guarantees we only fire if the
      // combatant is actually in the area right now.
      const template = canvas.scene.templates.get(templateId)?.object;
      if (!template) continue;

      // Start-of-turn check
      if (timing.includes("startOfTurn") || timing.includes("enter+startOfTurn")) {
        if (currentToken) {
          const placeable = canvas.tokens.get(currentToken.id);
          if (placeable) {
            const positions = { newX: currentToken.x, newY: currentToken.y };
            const inside = this._tokenInsideTemplate(placeable, template, positions);
            if (inside) {
              console.log(`${TAG} | ${currentToken.name} starts turn in ${tracker.item.name}`);
              // Use the same auto-roll-or-prompt routing as token entry —
              // NPC fast-resolves, PC gets prompted. Skip the cast-pacing
              // delay since this is a turn-start trigger, not a cast.
              await this._onTokenEnteredTemplate(tracker, placeable);
            }
          }
        }
      }

      // End-of-turn check
      if (timing.includes("endOfTurn") || timing.includes("enter+endOfTurn")) {
        if (prevToken) {
          const placeable = canvas.tokens.get(prevToken.id);
          if (placeable) {
            const positions = { newX: prevToken.x, newY: prevToken.y };
            const inside = this._tokenInsideTemplate(placeable, template, positions);
            if (inside) {
              console.log(`${TAG} | ${prevToken.name} ends turn in ${tracker.item.name}`);
              await this._onTokenEnteredTemplate(tracker, placeable);
            }
          }
        }
      }
    }
  }

  /**
   * Trigger a save prompt for a single token inside a persistent spell.
   * Posts a save card to the GM chat for that one creature.
   */
  async _triggerSaveForToken(tracker, tokenDoc, opts = {}) {
    // v0.4.22.10: Defense-in-depth GM gate. `_onTurnChange` already gates,
    // but if any future caller invokes this directly we still want only
    // the GM client to post the save card.
    if (!game.user.isGM) return;

    // Resolve the actual token placeable
    const token = canvas.tokens.get(tokenDoc.id) ?? canvas.tokens.placeables.find(t => t.document.id === tokenDoc.id);
    if (!token) return;

    // v0.6.0: Use the SaveEngine's public `postSaveCard` API (was calling
    // a non-existent `_postSaveCardForTargets` method, so the INFLICT
    // DAMAGE button silently did nothing). Fallback to the underscore
    // method if running against an older save engine without the alias.
    const post = this._saveEngine?.postSaveCard?.bind(this._saveEngine)
              ?? this._saveEngine?._postLiveTargetCard?.bind(this._saveEngine);
    if (typeof post === "function") {
      // v0.6.2: forward `skipDelay` so entry-trigger callers can bypass
      // the 1500ms cast-pacing pause.
      await post(tracker.item, tracker.actor, [token], {
        saveAbility: tracker.saveAbility,
        saveDC: tracker.saveDC,
        halfOnSave: tracker.halfOnSave,
        damageTypes: tracker.damageTypes,
        isSpell: true,
        isPersistent: true,
        templateId: tracker.templateId,
        skipDelay: opts.skipDelay === true,
      });
    } else {
      console.warn(`${TAG} | save engine has neither postSaveCard nor _postLiveTargetCard — INFLICT DAMAGE failed for ${tracker.item?.name}`);
    }
  }

  // ═══════════════════════════════════════════════════════════════
  //  Concentration Break — Cleanup
  // ═══════════════════════════════════════════════════════════════
  //  v0.6.0 — Phase 1 + 2 Token Movement Handlers
  // ═══════════════════════════════════════════════════════════════

  /**
   * Called after a token finishes moving. For each tracked persistent
   * template, decides whether to fire the entry trigger (Phase 1 — token
   * crossed into the area) or the movement-distance damage trigger
   * (Phase 2 — token moved within / through Spike Growth-style area).
   *
   * @param {TokenDocument} tokenDoc
   * @param {{oldX, oldY, newX, newY}} positions  Pre/post move coords.
   */
  async _onTokenMoved(tokenDoc, positions) {
    if (!this._activeSpells.size) return;

    const token = canvas.tokens.get(tokenDoc.id)
               ?? canvas.tokens.placeables.find(t => t.document.id === tokenDoc.id);
    if (!token) return;

    // Dead-actor guard. When movement damage kills a token, the death
    // pipeline relocates the token to its dead-art tile location, which
    // re-fires updateToken with new x/y. Without this guard, the cascading
    // move re-triggers spike-growth-style movement damage on a corpse —
    // double-rolling damage and posting a second chat card. The relocate
    // is also not a "voluntary movement" so RAW-wise it shouldn't trigger
    // movement damage anyway.
    const hp = token.actor?.system?.attributes?.hp?.value;
    if (typeof hp === "number" && hp <= 0) return;

    for (const [templateId, tracker] of this._activeSpells) {
      const template = canvas.scene.templates.get(templateId)?.object;
      if (!template) continue;

      const wasInside = !!tracker.tokensInside?.has?.(tokenDoc.id);
      const isInside  = this._tokenInsideTemplate(token, template, positions);
      if (!tracker.tokensInside) tracker.tokensInside = new Set();

      // ── Phase 2: Spike Growth-style movement damage ──
      // Spells with damage but NO save are continuous — apply per 5ft
      // of movement traversed inside the template area.
      const isMovementDamage = !tracker.saveAbility && !!tracker.damageTypes?.length;
      if (isMovementDamage) {
        const ft = this._distanceMovedInsideTemplate(template, positions);
        if (ft > 0) {
          await this._applyMovementDamage(tracker, token, ft);
        }
        // Movement-damage spells don't use the entry trigger flow
      }

      // ── Phase 1: Save on entry (Moonbeam, Wall of Fire, etc.) ──
      if (!isMovementDamage) {
        if (isInside && !wasInside) {
          tracker.tokensInside.add(tokenDoc.id);
          await this._onTokenEnteredTemplate(tracker, token);
        } else if (!isInside && wasInside) {
          tracker.tokensInside.delete(tokenDoc.id);
        } else if (isInside) {
          // Already inside, still inside — keep tracker fresh
          tracker.tokensInside.add(tokenDoc.id);
        }
      }
    }
  }

  /**
   * Whether a token's CENTER point is currently inside a measured-template
   * polygon. Uses Foundry's official `containsPoint` first (matches the
   * core auto-targeting logic across all template types), falling back
   * to PIXI shape geometry only if needed.
   *
   * v0.6.3: Switched to containsPoint as primary. Previous code used
   * `template.shape.contains()` which had edge-case misses on tokens at
   * the template boundary — auto-targeting could see them as "inside"
   * but our hit-test would say "outside," so the entry trigger
   * fired sporadically.
   *
   * `positions` is the pre/post move coord pair — we use the post-move
   * (new) center for "currently inside" determination.
   */
  _tokenInsideTemplate(token, template, positions) {
    if (!token || !template) return false;
    const tokenDoc = token.document;
    const w = (Number(tokenDoc.width)  > 0) ? Number(tokenDoc.width)  : 1;
    const h = (Number(tokenDoc.height) > 0) ? Number(tokenDoc.height) : 1;
    const gridSize = canvas.grid?.size ?? 100;
    const cx = positions.newX + (w * gridSize) / 2;
    const cy = positions.newY + (h * gridSize) / 2;

    // v0.6.4: Permissive hit-test. User's diagnostic showed
    // `template.containsPoint` is a function but returns `undefined`
    // (not boolean) for circle templates in their Foundry/dnd5e build —
    // my previous code took that as falsy and missed valid entries.
    // `template.shape.contains` returned reliable booleans in the same
    // diagnostic. Now: try BOTH methods, treat as inside if EITHER
    // returns a strict `true`. Either method's `false` (or non-boolean)
    // doesn't override the other's `true`.
    let containsPointResult = null;
    if (typeof template.containsPoint === "function") {
      try {
        const r = template.containsPoint({ x: cx, y: cy });
        if (typeof r === "boolean") containsPointResult = r;
      } catch (_) { /* ignore — fall through */ }
    }
    let shapeContainsResult = null;
    if (typeof template.shape?.contains === "function") {
      try {
        shapeContainsResult = template.shape.contains(cx - template.x, cy - template.y);
      } catch (_) { /* ignore — fall through */ }
    }
    if (containsPointResult === true || shapeContainsResult === true) return true;

    // Either method returned a clean false → trust it
    if (containsPointResult === false || shapeContainsResult === false) return false;

    // Both methods unavailable / threw → bounds-only fallback
    const b = template.bounds;
    if (!b) return false;
    return cx >= b.x && cx <= b.x + b.width
        && cy >= b.y && cy <= b.y + b.height;
  }

  /**
   * For Phase 2 (Spike Growth, Wall of Thorns) — measure how many feet of
   * the token's move-vector lay INSIDE the template's polygon. Uses
   * Foundry's grid distance scale (typically 5 ft per cell). Returns 0 if
   * no portion of the movement passed through the template.
   */
  _distanceMovedInsideTemplate(template, positions) {
    if (!template || !positions) return 0;
    const tokenDoc = canvas.tokens.placeables.find(t => true)?.document; // unused
    // Use token-center start/end for the move ray
    // (caller-supplied positions are token-origin; we approximate with origin
    // since we don't know token size at this point in the helper. The result
    // is stable across the full token because we're measuring a line, not
    // a swept area.)
    const start = { x: positions.oldX, y: positions.oldY };
    const end   = { x: positions.newX, y: positions.newY };

    // Sample the segment at fine increments and count how many samples
    // landed inside the template. Convert sample count → distance.
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const segPx = Math.hypot(dx, dy);
    if (segPx < 1) return 0;
    const gridSize    = canvas.grid?.size ?? 100;
    const ftPerSquare = canvas.scene?.grid?.distance ?? 5;
    const samplesPerCell = 6;
    const sampleCount = Math.max(2, Math.ceil((segPx / gridSize) * samplesPerCell));
    let insideSamples = 0;
    for (let i = 0; i <= sampleCount; i++) {
      const t = i / sampleCount;
      const x = start.x + dx * t;
      const y = start.y + dy * t;
      let inside = false;
      if (typeof template.shape?.contains === "function") {
        inside = template.shape.contains(x - template.x, y - template.y);
      } else if (typeof template.containsPoint === "function") {
        inside = template.containsPoint({ x, y });
      }
      if (inside) insideSamples += 1;
    }
    if (insideSamples === 0) return 0;
    const fracInside = insideSamples / (sampleCount + 1);
    const totalFt = (segPx / gridSize) * ftPerSquare;
    return totalFt * fracInside;
  }

  /**
   * Phase 1 entry trigger. Routes to NPC auto-save flow vs PC save-prompt
   * flow based on token ownership.
   *
   * v0.6.2: Split PC vs NPC paths. NPC fast-resolve auto-rolls and posts
   * the result. PC live-target-card asks the player to roll their own
   * save (always — PCs roll their own dice). Both pass `skipDelay: true`
   * so the save card lands immediately on entry — the cast animation
   * has already played, so the 1500ms cast-pacing doesn't apply.
   */
  async _onTokenEnteredTemplate(tracker, token) {
    const isPC = !!token.actor?.hasPlayerOwner;
    console.log(`${TAG} | ${token.name} entered ${tracker.item?.name} (${isPC ? "PC" : "NPC"})`);

    if (isPC) {
      // PC: live target card with that PC's ROLL SAVE button enabled.
      // SaveEngine already routes whisper / collapse so non-owners see a
      // collapsed row. GM also enabled via existing override.
      await this._triggerSaveForToken(tracker, token.document, { skipDelay: true });
    } else {
      // NPC: auto-roll the save. `_fastResolveSingleNpcSave` posts a
      // result card that's visible to all (so PCs can see the NPC failed),
      // and includes a ROLL DAMAGE button (for the spell caster) and an
      // INFLICT DAMAGE button (for the GM).
      await this._triggerNpcAutoSave(tracker, token, { skipDelay: true });
    }
  }

  /**
   * v0.6.2: NPC entry-trigger fast-resolve. Calls SaveEngine's existing
   * `_fastResolveSingleNpcSave` which auto-rolls the save and posts a
   * public result card. Falls back to the live-target-card path if the
   * fast method isn't available (older save engine versions).
   */
  async _triggerNpcAutoSave(tracker, token, opts = {}) {
    if (!game.user.isGM) return;
    const fastResolve = this._saveEngine?._fastResolveSingleNpcSave?.bind(this._saveEngine);
    if (typeof fastResolve === "function") {
      try {
        await fastResolve(tracker.item, tracker.actor, token, {
          saveAbility: tracker.saveAbility,
          saveDC:      tracker.saveDC,
          halfOnSave:  tracker.halfOnSave,
          damageTypes: tracker.damageTypes,
          isSpell:     true,
          timing:      tracker.timing,
          activity:    null,
          skipDelay:   opts.skipDelay === true,
        });
        return;
      } catch (err) {
        console.warn(`${TAG} | _fastResolveSingleNpcSave threw, falling back to live-target-card:`, err);
      }
    }
    // Fallback — slow path
    await this._triggerSaveForToken(tracker, token.document, opts);
  }

  /**
   * Phase 2 movement damage (Spike Growth, Wall of Thorns). Roll the
   * spell's damage formula scaled by feet traversed (e.g. Spike Growth
   * is `2d4` per 5ft; ft / 5 = number of "tickets" of damage to roll).
   */
  async _applyMovementDamage(tracker, token, ftMoved) {
    const ftPerTick = canvas.scene?.grid?.distance ?? 5;
    const ticks = Math.floor(ftMoved / ftPerTick);
    if (ticks < 1) return;

    const formulaPerTick = tracker.item?.system?.damage?.parts?.[0]?.[0]
                        ?? tracker.damageFormula
                        ?? "2d4";
    const damageType     = (tracker.damageTypes?.[0] ?? "piercing").toLowerCase();

    // Build a multi-tick formula that ACTUALLY rolls the dice per tick
    // (RAW Spike Growth: 2d4 *for every 5 feet*). Previous version used
    // `${ticks}*(${formulaPerTick})` which Foundry's Roll parses as
    // multiplication — it rolls 2d4 ONCE and multiplies the result by the
    // tick count, so 5ft and 25ft both showed only 2 dice. RAW expects
    // per-tick rolls (more dice, more variance). The chained `+` form
    // makes Foundry roll each instance independently — e.g. 5 ticks of
    // 2d4 yields a 10-die DSN animation and the correct probability
    // distribution.
    const formula = Array(ticks).fill(`(${formulaPerTick})`).join(" + ");
    try {
      const roll = new Roll(formula, tracker.actor?.getRollData?.() ?? {});
      await roll.evaluate();
      // DSN broadcast — chat message below intentionally OMITS the
      // `rolls:` field so Foundry doesn't render the `(2d4) + (2d4) + ...`
      // breakdown inline on the card (the user wants only the clean
      // "N × 2d4 = total" summary). Because there's no `rolls:` field,
      // chat-message DSN auto-fire is bypassed too — so we trigger DSN
      // manually here exactly once. Result: dice animate correctly,
      // chat card stays clean.
      try { game.dice3d?.showForRoll?.(roll, game.user, true); } catch (_) {}

      const rawTotal = roll.total;

      // ── Resistance / immunity / vulnerability via ace-qol damage calculator ──
      const tgtActor = token.actor;
      let finalDamage = rawTotal;
      let modifier = "normal";
      let modReason = null;
      try {
        // Movement-damage spells (Spike Growth, Wall of Thorns) deal
        // damage from conjured physical objects — thorns, spikes, etc.
        // RAW Iron Golem's BPS immunity reads "from nonmagical attacks";
        // these aren't even attacks, so the immunity applies. We pass
        // `treatAsNonMagical:true` so the calculator's "mgc" bypass
        // doesn't override the immunity just because the source is a
        // spell with `system.magicAvailable=true`.
        const mods = DamageCalculator.getTargetDamageModifiers(tgtActor, tracker.item, { treatAsNonMagical: true });
        const mod = mods?.[damageType];
        if (mod) {
          modifier = mod.modifier;
          modReason = mod.reason ?? null;
          switch (mod.modifier) {
            case "immune":     finalDamage = 0; break;
            case "resistant":  finalDamage = Math.floor(rawTotal / 2); break;
            case "vulnerable": finalDamage = rawTotal * 2; break;
          }
        }
      } catch (err) {
        console.warn(`${TAG} | damage modifier check failed, applying raw:`, err);
      }

      // ── Capture pre-damage HP (for UNDO) and auto-apply via dnd5e's
      // actor.applyDamage (handles temp HP, downed state, etc.). Movement
      // damage is "you walked through spikes" — the event of taking the
      // damage already happened, there's no decision point to gate on, so
      // this applies independently of the global `autoApplyDamage` setting
      // (which gates attack-damage cards where the GM may want to review).
      // The UNDO button on the chat card lets the GM reverse one-click.
      const preHP = tgtActor?.system?.attributes?.hp?.value;
      const preTempHP = tgtActor?.system?.attributes?.hp?.temp ?? 0;
      let applied = false;
      if (finalDamage > 0 && tgtActor && game.user.isGM) {
        try {
          await tgtActor.applyDamage(finalDamage);
          applied = true;
        } catch (err) {
          console.warn(`${TAG} | applyDamage failed for ${token.name}:`, err);
        }
      }

      // ── Public chat card so the table sees what happened ──
      // Badges use solid backgrounds so they read on any chat-card surface
      // (light green dnd5e cards, dark themes, etc.) — pure text-color
      // badges blend into the green dnd5e damage card the user pointed out.
      const badgeStyle = "display:inline-block;padding:1px 6px;border-radius:3px;font-weight:bold;font-size:0.85em;letter-spacing:0.5px;";
      const modBadge =
          modifier === "immune"     ? ` <span style="${badgeStyle}background:#2d5f7a;color:#cdefff">IMMUNE</span>`
        : modifier === "resistant"  ? ` <span style="${badgeStyle}background:#3a567a;color:#d0e3ff">RESIST &frac12;</span>`
        : modifier === "vulnerable" ? ` <span style="${badgeStyle}background:#7a2d2d;color:#ffd0d0">VULN &times;2</span>`
        : "";
      const reasonLine = modReason ? `<br><em style="opacity:.7">${modReason}</em>` : "";
      const appliedTag = applied
        ? ` <span style="${badgeStyle}background:#1e6b1e;color:#e8ffe8">APPLIED</span>`
        : (finalDamage === 0 ? "" : ` <span style="${badgeStyle}background:#5a5a5a;color:#ddd">NOT APPLIED</span>`);

      // Round the displayed distance to the nearest 5ft (grid increment) so
      // a 14ft inside-path reads as "15ft", 23ft as "25ft", etc. The damage
      // tick count above is already grid-aligned (`Math.floor(ftMoved/5)`);
      // this just makes the human-readable label match.
      const gridFt = canvas?.scene?.grid?.distance ?? 5;
      const displayFt = Math.round(ftMoved / gridFt) * gridFt;

      // Wrap the card body in ace-qol's dark surface so it doesn't sit on
      // dnd5e's default chat-card green/cream — matches the visual identity
      // of our other damage cards.
      const cardStyle = "background:#15161a;border:1px solid #3a3a44;border-radius:5px;padding:8px 10px;color:#dfe2ea;font-size:0.9em;line-height:1.4em;";
      const flavor = `<div style="${cardStyle}">`
                   + `<strong style="color:#d4af37">${tracker.item?.name ?? "Persistent area"}</strong>`
                   + ` &mdash; ${token.name} moved ${displayFt}ft through area${appliedTag}`
                   + `<br><em style="color:#a8aab2">${ticks} × ${formulaPerTick} ${damageType} = ${rawTotal}${modBadge}`
                   + (modifier !== "normal" ? ` → <strong style="color:#fff">${finalDamage}</strong>` : "")
                   + `</em>${reasonLine}`
                   + `</div>`;

      // UNDO button row — only shown when damage was actually applied (no
      // point offering undo on an IMMUNE-zeroed roll). The button itself is
      // disabled-on-click after firing; the `undone` flag persists across
      // page reloads so a re-render still shows the disabled state.
      const undoBtnHtml = applied
        ? `<div style="margin-top:6px;text-align:right;">
             <button type="button"
                     class="ace-qol-mvmt-undo"
                     style="padding:3px 10px;font-size:0.85em;font-weight:bold;letter-spacing:0.5px;background:#3a2727;color:#ffcdcd;border:1px solid #6a3a3a;border-radius:3px;cursor:pointer;">
               <i class="fas fa-undo"></i> UNDO
             </button>
           </div>`
        : "";

      // NOTE: `rolls` field intentionally omitted from the message — the
      // flavor text already shows the clean "N × formula = total" summary,
      // and we don't want Foundry rendering the per-die breakdown inline.
      // DSN was triggered manually above so the dice animation still
      // plays on all clients.
      await ChatMessage.create({
        speaker: ChatMessage.getSpeaker({ actor: tracker.actor }),
        content: flavor + undoBtnHtml,
        sound: CONFIG.sounds.dice,
        flags: {
          [MODULE_ID]: {
            type: "movementDamage",
            spellName: tracker.item?.name ?? "Persistent area",
            tokenDocId: token.document?.id,
            actorUuid: tgtActor?.uuid ?? null,
            sceneId: canvas.scene?.id ?? null,
            damageApplied: applied ? finalDamage : 0,
            damageFormula: formula,
            damageRawTotal: rawTotal,
            damageFinal: finalDamage,
            preHP: preHP ?? null,
            preTempHP: preTempHP,
            undone: false,
          },
        },
      });
      console.log(`${TAG} | Movement damage: ${token.name} took ${finalDamage}/${rawTotal} ${damageType} from ${tracker.item?.name} (${Math.round(ftMoved)}ft) — ${modifier}, applied=${applied}`);
    } catch (err) {
      console.error(`${TAG} | _applyMovementDamage failed:`, err);
    }
  }

  // ═══════════════════════════════════════════════════════════════
  //  Movement-Damage Chat Card — UNDO Wiring
  // ═══════════════════════════════════════════════════════════════

  /**
   * Wire the UNDO button on a movement-damage chat card. Fires on every
   * render of the message (initial post + later refreshes). Idempotent
   * via a `dataset.wired` flag on the button itself.
   *
   * GM-only behavior. Non-GM clients still see the card but the button is
   * hidden — they can't apply or undo damage anyway.
   */
  _wireMovementDamageUndo(message, html) {
    try {
      const flags = message.flags?.[MODULE_ID];
      if (flags?.type !== "movementDamage") return;

      const el = (html instanceof HTMLElement) ? html : (html?.[0] ?? html);
      if (!el?.querySelector) return;

      const btn = el.querySelector(".ace-qol-mvmt-undo");
      if (!btn) return;

      if (!game.user.isGM) {
        // Non-GMs shouldn't see the button — they have no permission to
        // restore HP and clicking would be a no-op with a console warning.
        btn.style.display = "none";
        return;
      }

      if (btn.dataset.wired === "1") return;
      btn.dataset.wired = "1";

      const setDisabled = (label) => {
        btn.disabled = true;
        btn.style.opacity = "0.55";
        btn.style.cursor = "default";
        btn.innerHTML = label;
      };

      if (flags.undone) {
        setDisabled('<i class="fas fa-check"></i> UNDONE');
        return;
      }
      if (!flags.damageApplied || flags.damageApplied <= 0) {
        setDisabled('<i class="fas fa-undo"></i> NOTHING TO UNDO');
        return;
      }

      btn.addEventListener("click", async () => {
        if (btn.disabled) return;
        btn.disabled = true; // immediate visual lock against double-click
        try {
          // Resolve the actor. Prefer the UUID we stamped at apply-time;
          // fall back to scene.token.actor lookup if the actor was deleted.
          let actor = null;
          if (flags.actorUuid) {
            try { actor = await fromUuid(flags.actorUuid); } catch (_) {}
          }
          if (!actor && flags.sceneId && flags.tokenDocId) {
            const scene = game.scenes.get(flags.sceneId);
            actor = scene?.tokens?.get(flags.tokenDocId)?.actor ?? null;
          }
          if (!actor) {
            ui.notifications?.warn?.(`${MODULE_ID}: Could not find target actor to undo damage.`);
            btn.disabled = false;
            return;
          }

          // Restore HP exactly to the pre-damage state. We persisted both
          // hp.value and hp.temp at apply-time, so temp HP that absorbed
          // part of the hit comes back correctly. Clamp value to max HP
          // to avoid setting HP above max if max changed (level-up etc).
          const update = {};
          if (typeof flags.preHP === "number") {
            const maxHP = actor.system?.attributes?.hp?.max ?? flags.preHP;
            update["system.attributes.hp.value"] = Math.min(flags.preHP, maxHP);
          }
          if (typeof flags.preTempHP === "number") {
            update["system.attributes.hp.temp"] = flags.preTempHP;
          }
          if (Object.keys(update).length) {
            await actor.update(update);
          }

          await message.setFlag(MODULE_ID, "undone", true);
          setDisabled('<i class="fas fa-check"></i> UNDONE');
          console.log(`${TAG} | UNDO: restored ${actor.name} HP to ${flags.preHP} (temp ${flags.preTempHP})`);
        } catch (err) {
          console.error(`${TAG} | UNDO failed:`, err);
          btn.disabled = false;
          btn.style.opacity = "";
          ui.notifications?.error?.(`${MODULE_ID}: Undo failed — see console.`);
        }
      });
    } catch (err) {
      console.warn(`${TAG} | _wireMovementDamageUndo threw:`, err);
    }
  }

  // ═══════════════════════════════════════════════════════════════
  //  Concentration Break — Cleanup
  // ═══════════════════════════════════════════════════════════════

  _onEffectRemoved(effect) {
    // Check if this is a concentration effect
    const statusId = effect.statuses?.first?.() ?? effect.flags?.core?.statusId ?? "";
    const isConcentrating = statusId === "concentrating"
                         || (effect.name ?? "").toLowerCase().includes("concentrating");

    if (!isConcentrating) return;

    const actor = effect.parent;
    if (!actor) return;

    // Find any active spells cast by this actor
    for (const [templateId, tracker] of this._activeSpells) {
      if (tracker.actor?.id === actor.id) {
        console.log(`${TAG} | ${actor.name} lost concentration on ${tracker.item?.name} — removing widget`);
        ui.notifications.info(`${tracker.item?.name}: Concentration broken by ${actor.name}`);
        this._activeSpells.delete(templateId);

        // v0.4.22.10: Only the GM client may delete the canvas template.
        // Otherwise every player would race to delete the same document,
        // generating N permission errors and one successful delete.
        if (game.user.isGM) {
          try {
            const template = canvas.scene.templates.get(templateId);
            if (template) {
              template.delete();
            }
          } catch (err) {
            console.warn(`${TAG} | Failed to delete template:`, err);
          }
        }
      }
    }

    this._renderWidgets();
  }

  // ═══════════════════════════════════════════════════════════════
  //  Widget Rendering
  // ═══════════════════════════════════════════════════════════════

  _ensureContainer() {
    if (this._container && document.body.contains(this._container)) return;
    this._container = document.createElement("div");
    this._container.id = "ace-qol-concentration-widgets";
    // v0.6.0: Default position is top-center (was bottom-right which got
    // hidden behind the chat panel). User-draggable via the title bar
    // (`#ace-qol-conc-drag-handle`); after a drag, position is preserved
    // for the rest of the session via internal _userPos coordinates.
    const initialLeft = this._userPos?.left ?? "50%";
    const initialTop  = this._userPos?.top  ?? "12px";
    const transform   = (this._userPos) ? "none" : "translateX(-50%)";
    this._container.style.cssText = `
      position: fixed; top: ${initialTop}; left: ${initialLeft};
      transform: ${transform}; z-index: 100;
      display: flex; flex-direction: column; gap: 8px;
      pointer-events: auto; max-height: 60vh; overflow-y: auto;
    `;
    document.body.appendChild(this._container);
    this._attachDragHandlers();
  }

  /**
   * v0.6.0 — Drag handlers for the concentration widget.
   * The widget can be moved by clicking and dragging anywhere on the
   * container that isn't a button. We capture pointerdown on the
   * container, track movement via pointermove on document, and release
   * on pointerup. The user's chosen position survives until next reload.
   */
  _attachDragHandlers() {
    if (!this._container) return;
    let dragging = false;
    let startX = 0, startY = 0;
    let originLeft = 0, originTop = 0;

    const onPointerDown = (ev) => {
      // Don't start drag if the user clicked an interactive control
      if (ev.target.closest?.("button, a, input, select, textarea")) return;
      dragging = true;
      startX = ev.clientX;
      startY = ev.clientY;
      const rect = this._container.getBoundingClientRect();
      originLeft = rect.left;
      originTop  = rect.top;
      // Drop the centering transform on first drag so subsequent
      // positions are stored in raw pixel coordinates.
      this._container.style.transform = "none";
      this._container.style.left = `${originLeft}px`;
      this._container.style.top  = `${originTop}px`;
      document.addEventListener("pointermove", onPointerMove);
      document.addEventListener("pointerup",   onPointerUp, { once: true });
      ev.preventDefault();
    };
    const onPointerMove = (ev) => {
      if (!dragging) return;
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      // Clamp to viewport so the widget can't be dragged off-screen
      const maxLeft = window.innerWidth  - 80;
      const maxTop  = window.innerHeight - 80;
      const newLeft = Math.max(0, Math.min(maxLeft, originLeft + dx));
      const newTop  = Math.max(0, Math.min(maxTop,  originTop  + dy));
      this._container.style.left = `${newLeft}px`;
      this._container.style.top  = `${newTop}px`;
    };
    const onPointerUp = () => {
      if (!dragging) return;
      dragging = false;
      document.removeEventListener("pointermove", onPointerMove);
      // Persist for the rest of this session
      this._userPos = {
        left: this._container.style.left,
        top:  this._container.style.top,
      };
    };

    this._container.style.cursor = "move";
    this._container.addEventListener("pointerdown", onPointerDown);
  }

  _renderWidgets() {
    // v0.6.1: Gate UI rendering behind the existing `concentrationWidget`
    // setting (Saves tab → "Floating Concentration Widget"). v0.6.0
    // accidentally registered a duplicate `showConcentrationWidget` that
    // wasn't in any tab — removed in v0.6.1.
    //
    // The DATA tracking (this._activeSpells Map) and entry-detection logic
    // continue to run regardless — only the visible widget is suppressed
    // when the setting is off. That way auto save-card flow still works
    // even with the widget hidden.
    let widgetEnabled = true;
    try {
      widgetEnabled = QolSettings.get?.("concentrationWidget") !== false;
    } catch (_) { /* setting not registered yet during boot */ }

    if (!widgetEnabled || !this._activeSpells.size) {
      if (this._container) {
        this._container.remove();
        this._container = null;
      }
      return;
    }

    // Filter: movement-damage variants (Spike Growth, Wall of Thorns) have
    // no save and apply damage automatically when tokens move through the
    // area — the widget's INFLICT DAMAGE button is meaningless for them,
    // and "DC null / No targets in area" looks like a bug. Keep the
    // tracker in `_activeSpells` (so movement-damage detection keeps
    // firing) but skip rendering the visible card.
    const renderable = [...this._activeSpells.values()]
      .filter(t => !!t.saveAbility);

    if (!renderable.length) {
      if (this._container) {
        this._container.remove();
        this._container = null;
      }
      return;
    }

    this._ensureContainer();
    this._container.innerHTML = "";

    for (const tracker of renderable) {
      const card = this._buildWidgetCard(tracker);
      this._container.appendChild(card);
    }
  }

  _buildWidgetCard(tracker) {
    const div = document.createElement("div");
    div.className = "ace-qol-conc-widget";
    div.dataset.templateId = tracker.templateId;

    const timingLabel = tracker.timing.timing.replace(/\+/g, " + ").replace(/([A-Z])/g, " $1").trim();

    // Target list
    const targetRows = tracker.tokens.map(t => {
      const actor = t.actor;
      const saveMod = actor?.system?.abilities?.[tracker.saveAbility]?.save ?? 0;
      const modSign = saveMod >= 0 ? "+" : "";
      return `
        <div class="ace-qol-conc-tgt-row">
          <img src="${actor?.img || t.document?.texture?.src || 'icons/svg/mystery-man.svg'}" class="ace-qol-save-tgt-img" />
          <span class="ace-qol-save-tgt-name">${t.name || actor?.name || "Unknown"}</span>
          <span class="ace-qol-save-tgt-mod">${tracker.saveAbility.toUpperCase()} ${modSign}${saveMod}</span>
        </div>
      `;
    }).join("") || '<div class="ace-qol-conc-empty">No targets in area</div>';

    div.innerHTML = `
      <div class="ace-qol-conc-header">
        <img src="${tracker.item?.img || 'icons/svg/spell.svg'}" class="ace-qol-conc-spell-img" />
        <div class="ace-qol-conc-info">
          <strong>${tracker.item?.name || "Unknown Spell"}</strong>
          <span class="ace-qol-conc-dc">DC ${tracker.saveDC} ${(tracker.saveAbility || "").toUpperCase()}</span>
        </div>
        <button class="ace-qol-conc-dismiss" title="Dismiss widget">
          <i class="fas fa-xmark"></i>
        </button>
      </div>
      <div class="ace-qol-conc-timing">
        <i class="fas fa-clock"></i> ${timingLabel}
        ${tracker.halfOnSave ? ' <span class="ace-qol-save-half-badge">HALF ON SAVE</span>' : ''}
      </div>
      <div class="ace-qol-conc-targets">
        ${targetRows}
      </div>
      <div class="ace-qol-conc-actions">
        <button class="ace-qol-btn ace-qol-btn-inflict" data-template-id="${tracker.templateId}">
          <i class="fas fa-bolt"></i> INFLICT DAMAGE
        </button>
      </div>
    `;

    // Wire dismiss button
    div.querySelector(".ace-qol-conc-dismiss")?.addEventListener("click", () => {
      this._activeSpells.delete(tracker.templateId);
      this._renderWidgets();
    });

    // Wire inflict damage button
    div.querySelector(".ace-qol-btn-inflict")?.addEventListener("click", async () => {
      if (!tracker.tokens.length) {
        ui.notifications.warn("No targets in the template area.");
        return;
      }
      await this._triggerBatchSave(tracker);
    });

    return div;
  }

  /**
   * Trigger a batch save for all tokens currently in the persistent spell's template.
   */
  async _triggerBatchSave(tracker) {
    if (this._saveEngine?._postSaveCardForTargets) {
      await this._saveEngine._postSaveCardForTargets(tracker.item, tracker.actor, tracker.tokens, {
        saveAbility: tracker.saveAbility,
        saveDC: tracker.saveDC,
        halfOnSave: tracker.halfOnSave,
        damageTypes: tracker.damageTypes,
        isSpell: true,
        isPersistent: true,
        templateId: tracker.templateId,
      });
    }
  }

  // ═══════════════════════════════════════════════════════════════
  //  Public API
  // ═══════════════════════════════════════════════════════════════

  /** Get all active persistent spells. */
  getActiveSpells() {
    return [...this._activeSpells.values()];
  }

  /** Check if a template has an active spell. */
  hasActiveSpell(templateId) {
    return this._activeSpells.has(templateId);
  }

  /** Manually dismiss all widgets. */
  dismissAll() {
    this._activeSpells.clear();
    this._renderWidgets();
  }
}
