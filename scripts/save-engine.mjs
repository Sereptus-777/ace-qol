// ─── ACE: QOL — Save Automation Engine ────────────────────────────────────────
// Handles saving throw spells (Moonbeam, Fireball, Hold Person, etc.)
//
// Phase A: Instant AoE — template auto-targeting, live target card, split
//          NPC rolls / PC whispered prompts, redesigned results card.
// Phase B (hooks only): Persistent AoE — stores template + timing data,
//          emits ace-qol.persistentSpellCreated for concentration widget.
//
// Flow:
//   1. Detect save-based spell usage (dnd5e.useActivity)
//   2. If spell places a template → stash pending data, wait for createMeasuredTemplate
//      If no template → use game.user.targets, post live target card immediately
//   3. Live target card: NPC rows + PC rows, TARGETED/SELECTED toggle, remove buttons
//   4. GM clicks ROLL NPC SAVES → NPC saves rolled, PC whispered prompts sent
//   5. PCs click their own ROLL button → result posted publicly, GM card updated
//   6. Results card: slim rows, color-coded reasons, manual override, Apply/Undo
//
// GM ALWAYS clicks the button. No auto-rolling.
// ──────────────────────────────────────────────────────────────────────────────

import { MODULE_ID } from "./ace-qol.mjs";
import { replyIsFromTheUserWeAsked } from "./socket-authority.mjs";
import { registerChatCardHandler } from "./chat-render-utils.mjs";
import { QolSettings } from "./settings.mjs";
import { CombatState } from "./combat-state.mjs";
// ⚠️ THE ONE GATE. The pre-roll decision lives in scripts/gate/action-gate.mjs
// so every pipeline asks the same door, instead of each engine growing its own
// checks and forgetting a different one. See docs/ONE_GATE_ARCHITECTURE.md.
import { ActionGate } from "./gate/action-gate.mjs";
// THE one answer to "is this creature in that area", shared with the
// concentration tracker so cast-time and entry can never disagree.
import { isTokenInTemplate, anyOverlapCounts } from "./template-geometry.mjs";
import { DamageConstants, safeShowForRoll } from "./damage-engine.mjs";
import { awaitDiceSettle } from "./dsn-utils.mjs";
// The target-side snapshot. The save pipeline asks THIS what a creature is
// immune to, what its saves are, what conditions it carries — instead of
// reaching into the actor and guessing at data shapes. (2026-07-28)
import { buildTargetProfile } from "./profiles/target-profile.mjs";
import { Situation } from "./situation.mjs";
import { DamageApplicator } from "./damage-applicator.mjs";
import { getSpellTiming, TIMING } from "./spell-timing.mjs";
import { CoverEngine } from "./cover-engine.mjs";
import { DescriptionParser } from "./description-parser.mjs";
import { ConditionLibrary } from "./condition-library.mjs";
import { awaitDsnRoll } from "./attack-prompt.mjs";
import { PolymorphSpellPipeline } from "./polymorph-spell-pipeline.mjs";
import { DamageCalculator } from "./damage-calculator.mjs";
// Shared "why didn't that happen" reporters. why-not.mjs is a leaf that
// imports nothing, so it cannot join the static import cycles ace-qol.mjs
// sits at the centre of.
import { gateOff, cannotDo, rejectedReply } from "./why-not.mjs";
// Wait for the condition, not for the clock. See wait-for.mjs.
import { waitUntil } from "./wait-for.mjs";

// Real black d20 die art (per-face). These are the dice the GM already sees;
// we use them everywhere a save result or prompt appears instead of the flat
// Font Awesome icon. The art is black, and our cards are dark, so each die gets
// a gold radial glow + drop-shadow beneath it for contrast.
const ACE_DICE_DIR = "modules/ace-qol/Assets/Dice%20Dice/BD20";
/**
 * @param {number} face         The raw d20 result (1–20). Out-of-range → generic 20 face.
 * @param {{size?:number}} opts  Pixel size of the die (default 30).
 * @returns {string}            HTML for a glowing black d20 showing that face.
 */
export function aceD20FaceImg(face, { size = 30, glow = true } = {}) {
  const n = Number(face);
  const valid = Number.isInteger(n) && n >= 1 && n <= 20;
  const src = `${ACE_DICE_DIR}/BD20-${valid ? n : 20}_nobg.png`;
  const icon = Math.round(size * 0.74);
  const glowSpan = glow
    ? `<span style="position:absolute;width:${size}px;height:${size}px;border-radius:50%;background:radial-gradient(circle,rgba(212,175,55,0.60) 0%,rgba(212,175,55,0.22) 48%,transparent 72%);"></span>`
    : "";
  const shadow = glow ? "filter:drop-shadow(0 0 3px rgba(212,175,55,0.75));" : "";
  return `<span class="ace-qol-d20" style="position:relative;display:inline-flex;align-items:center;justify-content:center;width:${size}px;height:${size}px;flex-shrink:0;vertical-align:middle;">`
    + glowSpan
    + `<img src="${src}" alt="d20${valid ? " " + n : ""}" style="position:relative;width:${size}px;height:${size}px;object-fit:contain;${shadow}" `
    + `onerror="this.style.display='none';this.nextElementSibling.style.display='inline-block';" />`
    + `<i class="fas fa-dice-d20" style="display:none;position:relative;color:#d4af37;font-size:${icon}px;"></i>`
    + `</span>`;
}

/**
 * Inline d20 result breakdown for a live save-card row: glowing black die face
 * + "raw +mod = total", readable (not a tiny bare total). `f` is a
 * pcSaveResult-style flag bundle ({ dieResult, saveTotal, passed, autoFailSave }).
 */
function aceInlineRollBreakdown(f, passClass) {
  if (f?.autoFailSave) {
    return `<span class="${passClass}" style="font-weight:700;font-size:15px;">AUTO-FAIL</span>`;
  }
  const face = f?.dieResult ?? null;
  const mod = (typeof f?.saveTotal === "number" && face != null) ? f.saveTotal - face : null;
  if (face == null || mod == null) {
    return `<span class="${passClass}" style="font-weight:700;font-size:16px;">${f?.saveTotal ?? "?"}</span>`;
  }
  const ms = mod >= 0 ? "+" : "";
  const mp = mod === 0 ? "" : ` ${ms}${mod}`;
  return `<span style="display:inline-flex;align-items:center;gap:6px;font-family:'Signika',sans-serif;">`
    + aceD20FaceImg(face, { size: 28 })
    + `<span style="color:#fff;font-size:16px;font-weight:700;">${face}</span>`
    + `<span style="color:#b9a978;font-size:13px;">${mp} =</span>`
    + `<span class="${passClass}" style="font-weight:700;font-size:16px;">${f.saveTotal}</span>`
    + `</span>`;
}

export class SaveEngine {

  /** In-memory override cache — avoids re-render on every button click.
   *  Key: `${messageId}|${tokenDocId}` → multiplier (number)
   *  Flushed to flags only when APPLY ALL is clicked. */
  static overrideCache = new Map();

  constructor({ damageEngine } = {}) {
    this.damageEngine = damageEngine;

    /** @type {object|null} Pending save spell waiting for template placement */
    this._pendingSaveSpell = null;

    /** @type {Map<string, number>} activityId → timestamp; tracks activities
     *  we've already posted save cards for, so the createChatMessage fallback
     *  hook (v0.4.22) doesn't double-fire when the standard
     *  postCreateUsageMessage hook also processes the same cast. Entries
     *  auto-prune after 5 seconds. */
    this._processedActivityIds = new Map();

    /** @type {Map<string, Promise>} Serializes concurrent PC save result
     *  writes per save-results message. Without this, two PCs rolling in
     *  the same 200ms window both read the same stale allResults, then
     *  both write — the second write overwrites the first PC's result. */
    this._pcSaveUpdateQueue = new Map();

    /** @type {Map<string, Function>} requestId → resolver, for the player-cast
     *  target-picker socket round-trip. The GM asks the caster's own client to pick
     *  (mirrors the rider-popup pattern); the resolver fires when the player's
     *  "spellPickerChoice" socket reply comes back. */
    this._pickerRequests = new Map();

    this._registerHooks();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Hook Registration
  // ═══════════════════════════════════════════════════════════════════════════

  _registerHooks() {
    // ── Detect save-based spells/abilities ──
    // dnd5e 5.2.5 uses postCreateUsageMessage, NOT useActivity
    Hooks.on("dnd5e.postCreateUsageMessage", (activity, message) => {
      console.log(`${MODULE_ID} | postCreateUsageMessage fired:`, activity?.item?.name, "save:", activity?.save?.ability);
      this._castDetectMs  = performance.now();   // [picker-timing] fast path
      this._castDetectVia = "standard";
      this._onUseActivity(activity);
    });
    // Fallback for older dnd5e versions that might use useActivity
    Hooks.on("dnd5e.useActivity", (activity, usageConfig, dialogConfig, messageConfig) => {
      console.log(`${MODULE_ID} | useActivity fired (legacy):`, activity?.item?.name);
      this._onUseActivity(activity);
    });

    // ── CARD-INDEPENDENT SAFETY NET (2026-07-28) ──
    // Every detection path above is tied, directly or indirectly, to a chat
    // message existing. That was a hidden dependency and it bit us: as of
    // 0.7.332 ACE stops dnd5e's usage card from ever being created, and it
    // deliberately posts no ACE card for save activities either — so for a
    // save there is now NO message at all, and the createChatMessage fallback
    // below can never fire again. Detecting "a creature must make a saving
    // throw" should never have depended on a card being drawn.
    //
    // dnd5e.postUseActivity fires for every activity use regardless of cards,
    // dialogs or suppression. Dedupe is shared with the other paths, so when
    // the standard hook already handled this cast this is a no-op.
    Hooks.on("dnd5e.postUseActivity", (activity) => {
      try {
        // SILENT-OK: not the active GM; this hook fires on every client and only one may act
        if (game.users?.activeGM !== game.user) return;
        if (activity?.type !== "save" && !activity?.save?.ability) return;
        const key = activity?.uuid;
        if (!key) return;
        const prev = this._processedActivityIds.get(key);
        if (prev != null && (Date.now() - prev) < 5000) return;   // already handled this cast
        console.log(`${MODULE_ID} | save detected via postUseActivity (card-independent):`, activity?.item?.name);
        this._onUseActivity(activity);
      } catch (err) {
        console.warn(`${MODULE_ID} | postUseActivity save detection threw:`, err);
      }
    });

    // ── v0.4.22 FALLBACK: createChatMessage detection for non-standard cast paths ──
    //
    // Some cast paths skip the `dnd5e.postCreateUsageMessage` hook entirely
    // (right-click → "Display Card", certain macros, drag-and-drop). These
    // post the description card without firing our standard processing.
    //
    // Live impact: Hellfire Orb (Death Knight feat-type) and Hold Person (Chudd)
    // both hit this path during a session — description card appeared but no
    // save card. Workaround was a manual `_postLiveTargetCard` call from JS.
    //
    // This fallback hook listens to ALL chat-message creation. When a message
    // has `flags.dnd5e.activity.type === "save"` AND we haven't already
    // processed that activity ID via the standard hook (within the 5s TTL),
    // we resolve the activity from the actor+item+activityId path and run it
    // through `_onUseActivity` as if the standard hook had fired.
    //
    // Dedupe via `_processedActivityIds` Map prevents double-firing.
    Hooks.on("createChatMessage", async (message) => {
      try {
        const _fbDetectMs = performance.now();   // [picker-timing] slow path — stamped before the ~250ms of built-in waits below
        // SILENT-OK: not the active GM; this hook fires on every client and only one may act
        if (game.users?.activeGM !== game.user) return;
        const dnd5eFlag = message.flags?.dnd5e;
        const activityFlag = dnd5eFlag?.activity;
        if (activityFlag?.type !== "save") return;

        // ── v0.4.22.1 hotfix ──
        // Previous version read `activityFlag.actor` and `activityFlag.item`
        // as separate fields and bailed when they were undefined. dnd5e 5.x
        // actually stores the activity reference as a single
        // `activityFlag.uuid` of the form `Actor.X.Item.Y.Activity.Z`.
        // Use that UUID to resolve the activity directly via fromUuid().
        //
        // Also: the dedup key was `activityFlag.id` (e.g. "dnd5eactivity000")
        // which is dnd5e's default activity ID — SHARED across all items
        // that have only a single primary activity. A Hellfire Orb cast
        // would be wrongly deduped against an earlier Hold Person cast
        // because both have id "dnd5eactivity000". Now uses the FULL UUID
        // as the dedup key.

        const activityUuid = activityFlag?.uuid;
        const activityId   = activityFlag?.id;
        const dedupKey = activityUuid || activityId;
        if (!dedupKey) return;

        // Fast-bail ONLY if this exact activity was processed within the last 5s.
        // MUST be time-aware: the activity UUID is STABLE across every cast of the
        // same spell, and the age-prune lives inside _onUseActivity — which this
        // fallback bails out of reaching. So a plain has() check treats a stale stamp
        // from an EARLIER cast as "already processed" and silently kills every repeat
        // cast (the dead-second-cast bug). Only a stamp younger than the 5s race
        // window is a real same-cast dedup; an older one is stale and must NOT block.
        const _prevTs = this._processedActivityIds.get(dedupKey);
        if (_prevTs != null && (Date.now() - _prevTs) < 5000) return;

        // ── v0.4.22.2 race fix ──
        // The standard `dnd5e.postCreateUsageMessage` hook fires ~2ms after
        // `createChatMessage` for activities that go through the normal
        // path. Without yielding here, the fallback hook would race the
        // standard hook: both would call `_onUseActivity` for the same
        // cast (standard directly, fallback via setTimeout 50ms later).
        // The two calls fight over shared state (`overrideCache`, the
        // 200ms PC-save merge timeout, target sets), and the visible
        // symptom is first-cast-after-reload producing no save card.
        //
        // ⚠️🔴 WATCH FOR THE STAMP, DO NOT SLEEP THROUGH THE WINDOW.
        //
        // This used to sleep a flat 200ms and then look ONCE. That is the
        // worst of both worlds: every cast paid the full 200ms even when the
        // standard hook had already fired 2ms in, AND a table busy enough to
        // push the hook past 200ms still got the double-handling this guard
        // exists to prevent. The number was chosen on an idle machine; his
        // runs four players, Dice So Nice and a loaded scene.
        //
        // Now it watches for the stamp and stops the instant it appears —
        // usually within one 20ms step. Because waiting longer costs nothing
        // once the condition is being checked continuously, the deadline is
        // 600ms rather than 200, which survives a far busier moment.
        const _standardHookRan = () => {
          const ts = this._processedActivityIds.get(dedupKey);
          return ts != null && (Date.now() - ts) < 5000;
        };
        if (await waitUntil(_standardHookRan, {
          maxMs: 600, stepMs: 20, quiet: true,
          what: "dnd5e's own postCreateUsageMessage handler",
        })) return;   // the standard path ran; this fallback must not run too

        // Resolve the live activity. UUID path is the primary route in
        // modern dnd5e; the actor/item-id fallback handles older flag
        // shapes if they ever appear.
        let activity = null;
        if (activityUuid) {
          try { activity = await fromUuid(activityUuid); }
          catch (err) { console.warn(`${MODULE_ID} | createChatMessage fallback fromUuid failed for ${activityUuid}:`, err?.message ?? err); }
        }
        if (!activity) {
          // Legacy fallback: separate actor/item fields
          const actorId = activityFlag?.actor;
          const itemId  = activityFlag?.item;
          const actor = actorId ? game.actors.get(actorId) : null;
          const item  = (actor && itemId) ? actor.items.get(itemId) : null;
          if (actor && item && activityId) {
            const activities = item.system?.activities;
            if (activities) {
              try {
                if (typeof activities.get === "function") {
                  activity = activities.get(activityId);
                } else {
                  for (const a of activities) {
                    if (a?.id === activityId) { activity = a; break; }
                  }
                }
              } catch (_) { /* iteration shape varies */ }
            }
          }
        }

        if (!activity) {
          console.warn(`${MODULE_ID} | createChatMessage fallback: could not resolve activity for ${dedupKey}`);
          return;
        }

        const itemName = activity?.item?.name ?? "(unknown)";
        console.log(`${MODULE_ID} | createChatMessage fallback firing for ${itemName} (uuid ${activityUuid ?? "no-uuid"} skipped postCreateUsageMessage)`);

        // Mark BEFORE calling _onUseActivity so the call itself doesn't
        // re-trigger via the standard hook (race-safe)
        this._processedActivityIds.set(dedupKey, Date.now());
        this._castDetectMs  = _fbDetectMs;                 // [picker-timing] slow path
        this._castDetectVia = "fallback(+250ms)";

        // Defer one tick so the chat message finishes posting first
        setTimeout(() => {
          try {
            this._onUseActivity(activity);
          } catch (err) {
            console.warn(`${MODULE_ID} | createChatMessage fallback _onUseActivity threw:`, err);
          }
        }, 50);
      } catch (err) {
        console.warn(`${MODULE_ID} | createChatMessage fallback hook failed:`, err);
      }
    });

    // ── ENFORCE self-origin templates on the caster's own space ─────────────
    //
    // ⚠️ THE OLD "SNAP" BELOW WAS FAKE, proven 2026-08-16. It fires when the
    // PREVIEW is built, seeds its starting position — and then the user drags
    // the preview wherever they like and the drag wins. Johnny: "I can place
    // that template any way I fuckin' want, a hundred feet away." He could.
    // The log line "Snapped template origin" only ever described the preview's
    // STARTING point, not a constraint.
    //
    // THIS hook is the real one: it fires on the creating client just before
    // the document is written, so updateSource here persists for every client.
    //
    // The rule is RANGE-driven, not shape-driven (RAW): an effect with range
    // SELF is measured from the caster's space — cone (breath weapons, Burning
    // Hands), line (Lightning Bolt), even Thunderwave's cube. A ranged AoE
    // (Fireball's 150 feet sphere) places freely. For a Large or Huge creature
    // the origin may be ANY point of its occupied space — so we CLAMP the
    // placed origin into the token's rectangle: aim northeast and the origin
    // lands on the northeast face of the creature, never its centre, never
    // empty air. Direction is untouched.
    Hooks.on("preCreateMeasuredTemplate", (doc, data) => {
      try {
        const originUuid = data?.flags?.dnd5e?.origin ?? doc?.flags?.dnd5e?.origin;
        if (!originUuid) return;                       // hand-drawn GM template — free
        const resolve = foundry?.utils?.fromUuidSync
          ?? (typeof fromUuidSync === "function" ? fromUuidSync : null);
        const activity = resolve?.(originUuid);
        if (!activity) {
          console.warn(`${MODULE_ID} | self-origin clamp: could not resolve ${originUuid} - template left where placed.`);
          return;
        }
        const rangeUnits = activity.range?.units ?? activity.item?.system?.range?.units ?? null;
        if (rangeUnits !== "self" && rangeUnits !== "touch") return;   // ranged AoE - free

        const actor = activity.item?.actor ?? null;
        const casterToken = SaveEngine.casterTokenDoc(actor, { sceneId: doc.parent?.id })?.object
                         ?? SaveEngine.casterTokenDoc(actor, {})?.object;
        // ⚠️ A BREATH WEAPON THAT DOES NOT SNAP IS THIS LINE. It used to return
        // in silence, so "it is not snapping to the token" had no console trace
        // at all and looked like the feature was never written. Johnny, 2026-08-24:
        // "I asked for breath weapon to snap to the token itself... It's not
        // doing that behavior if you've already coded something in there for that."
        // It was coded. It was giving up here without saying so.
        if (!casterToken) {
          console.warn(`${MODULE_ID} | self-origin clamp: "${activity.item?.name ?? "?"}" emanates from `
            + `${actor?.name ?? "an unknown actor"}, but no token for them was found on this scene - `
            + `template left where placed.`);
          return;
        }

        // The creature's occupied rectangle in world pixels.
        const rx0 = casterToken.x, ry0 = casterToken.y;
        const rx1 = rx0 + casterToken.w, ry1 = ry0 + casterToken.h;
        const px = Number(data?.x ?? doc.x) || 0;
        const py = Number(data?.y ?? doc.y) || 0;
        let cx = Math.min(Math.max(px, rx0), rx1);
        let cy = Math.min(Math.max(py, ry0), ry1);

        // On a gridded scene, land on the nearest grid vertex so the shape
        // covers whole squares cleanly — then re-clamp so rounding cannot
        // push the origin off the creature.
        const gs = canvas?.grid?.size || 0;
        if (gs > 1) {
          cx = Math.min(Math.max(Math.round(cx / (gs / 2)) * (gs / 2), rx0), rx1);
          cy = Math.min(Math.max(Math.round(cy / (gs / 2)) * (gs / 2), ry0), ry1);
        }

        if (cx !== px || cy !== py) {
          doc.updateSource({ x: cx, y: cy });
          console.log(`${MODULE_ID} | self-origin template pulled onto ${casterToken.name}'s space ` +
            `(${Math.round(px)},${Math.round(py)}) → (${Math.round(cx)},${Math.round(cy)})`);
        }
      } catch (err) {
        console.warn(`${MODULE_ID} | self-origin template clamp failed (template left where placed):`, err);
      }
    });

    // ── Seed the PREVIEW at the caster (cosmetic — the clamp above is the law) ──
    Hooks.on("dnd5e.createActivityTemplate", (activity, templates) => {
      // SILENT-OK: GM-only handler; every client sees this hook
      if (!game.user.isGM) return;
      const casterActor = activity?.actor ?? this._pendingSaveSpell?.actor;
      if (!casterActor) return;
      // THE token that cast, not "a token with that actor". With several
      // unlinked copies of one creature the old search snapped the template to
      // whichever copy Foundry listed first. (audit F-019)
      const casterToken = SaveEngine.casterTokenDoc(casterActor, { sceneId: canvas.scene?.id })?.object;
      if (!casterToken) return;
      for (const tmpl of (templates ?? [])) {
        const doc = tmpl.document ?? tmpl;
        doc.updateSource({
          x: casterToken.center.x,
          y: casterToken.center.y,
        });
        // Also update the PIXI object position if it exists
        if (tmpl.x !== undefined) {
          tmpl.x = casterToken.center.x;
          tmpl.y = casterToken.center.y;
        }
        console.log(`${MODULE_ID} | Snapped template origin to ${casterToken.name}`);
      }
    });

    // ── Template placement — auto-target tokens inside ──
    // activeGM guard: only the primary GM processes the template, preventing
    // duplicate save cards when two GMs are connected simultaneously.
    Hooks.on("createMeasuredTemplate", (templateDoc, context, userId) => {
      // SILENT-OK: not the active GM; this hook fires on every client and only one may act
      if (game.users?.activeGM !== game.user) return;
      // Small delay to let the PIXI shape render
      setTimeout(async () => {
        try {
          await this._onTemplateCreated(templateDoc);
        } catch (err) {
          console.error(`${MODULE_ID} | _onTemplateCreated CRASHED:`, err);
        }
      }, 100);
    });

    // ── Persistent button wiring for ALL save card types ──
    // V13 uses renderChatMessageHTML (HTMLElement), V12 uses renderChatMessage (jQuery)
    const _onRenderChatMessage = (message, html) => {
      const flags = message.flags?.[MODULE_ID];
      if (!flags?.type) return;

      const el = html instanceof HTMLElement ? html : (html[0] ?? html);

      // ── Reveal GM-only controls on PUBLIC save cards ──
      // The save/results cards are public (Johnny 2026-07-11) so the whole table
      // sees the cast + result. Interactive controls (ROLL NPC SAVES, ROLL
      // DAMAGE) ship hidden via .ace-qol-gm-only { display:none } and are flipped
      // on for the GM here by stamping data-ace-gm="true". Players never see the
      // buttons and so can't trigger a message.update() they lack permission for.
      try {
        if (el?.querySelectorAll) {
          if (game.user?.isGM) {
            // Reveal the .ace-qol-gm-only blocks (ROLL NPC SAVES / APPLY).
            for (const gmEl of el.querySelectorAll(".ace-qol-gm-only")) {
              gmEl.setAttribute("data-ace-gm", "true");
            }
          } else {
            // Hide GM-only in-row controls from players — remove-target ×,
            // roll-on-behalf dice, phase-1 remove. These live inside shared
            // rows (not a .ace-qol-gm-only wrapper), so hide them per-viewer
            // here. Players roll their OWN saves via their whispered prompt.
            for (const b of el.querySelectorAll(
              "[data-action='aceQolRemoveTarget'],[data-action='aceQolGmRollPcSave'],[data-action='aceQolRemovePhase1'],[data-action='aceQolRemoveResult'],[data-action='aceQolDmgOverride'],.ace-qol-save-pc-roll-btn"
            )) { b.style.display = "none"; }
          }
          // ROLL DAMAGE gate — reveal for the GM AND the caster's owning
          // player(s) so a PC rolls their own spell damage (the dice broadcast
          // to their screen). Everyone else never sees the button.
          const _casterIds = flags.casterUserIds;
          if (game.user?.isGM || (Array.isArray(_casterIds) && _casterIds.includes(game.user?.id))) {
            for (const gate of el.querySelectorAll(".ace-qol-roll-dmg-gate")) {
              gate.setAttribute("data-ace-show", "true");
            }
          }
        }
      } catch (_) { /* cosmetic — never block card wiring */ }

      // ── Save Prompt card (legacy — still supported) ──
      if (flags.type === "savePrompt") {
        this._wireSavePromptButtons(el, message, flags);
      }

      // ── Live Target List card ──
      if (flags.type === "saveTargetList") {
        // ONE CLEAN CARD: once the results card posts this card is superseded —
        // collapse it into nothing, re-applied on EVERY render so a PC-row
        // re-render can't un-hide it (that was the "pile of cards" bug).
        if (flags.superseded) {
          const chatMsg = el.closest?.(".chat-message") ?? el;
          chatMsg?.classList?.add?.("ace-qol-save-collapsed");
        } else {
          this._wireTargetListButtons(el, message, flags);
        }
      }

      // ── PC Save Prompt card (whispered to player) ──
      if (flags.type === "pcSavePrompt") {
        // ⚠️🔴 A GM WHO ALSO PLAYS A CHARACTER STILL NEEDS THE BUTTON.
        //
        // This hid the prompt from EVERY GM, on the reasoning that a GM sees all
        // whispers and would otherwise drown in other people's cards. True for
        // other people's characters. Not true for their own.
        //
        // Johnny runs the table AND plays Jeth. So his own save prompt was
        // collapsed on the only screen he has, the die was never wired, and the
        // card sat there saying "WAITING FOR PLAYER" while the player it was
        // waiting for was him, looking at a card with nothing to press
        // (2026-08-24): "it doesn't give me a button to push to save on the
        // client side!"
        //
        // The test is not "is this person a GM". It is "is this MY character" —
        // exactly the distinction that nearly killed NPC memory and Legendary
        // Resistance when a fail-closed check asked the wrong question
        // (2026-08-19). Own the actor, get the button. Somebody else's, stay
        // collapsed and use ROLL FOR THEM on the main card as before.
        const mine = SaveEngine._promptIsMine(flags);
        if (game.user.isGM && !mine) {
          const chatMsg = el.closest?.(".chat-message") ?? el;
          chatMsg.classList.add("ace-qol-save-collapsed");
          return;
        }
        this._wirePcSaveButton(el, message, flags);
      }

      // ── PC Save Result — the roll's transport to the GM, but visually
      // redundant with the main card's row. Collapse it on EVERY client (not
      // just the GM) so it never joins the pile. The message still exists, so
      // _onPcSaveResultPosted + area-denial re-fire still work off its flags.
      if (flags.type === "pcSaveResult") {
        const chatMsg = el.closest?.(".chat-message") ?? el;
        chatMsg?.classList?.add?.("ace-qol-save-collapsed");
      }

      // ── Save Results card — phase-aware wiring ──
      if (flags.type === "saveResults") {
        if (flags.phase === 1) {
          // Phase 1: saves only — wire ROLL DAMAGE button + portrait click-to-pan
          this._wireRollDamageButton(el, message, flags);
        } else {
          // Phase 2 (or legacy cards without phase flag): wire overrides + Apply/Undo
          this._wireSaveResultButtons(el, message, flags);
        }
        // Auto-collapse the target list card above this one
        this._collapseTargetListCard(flags);
      }
    };
    // Both render hooks + a sweep of cards drawn before this registered.
    // A save card carries roll buttons that must not appear for the wrong
    // player, and an undecorated card shows all of them. See chat-render-utils.
    registerChatCardHandler(_onRenderChatMessage, "save cards");

    // ── createChatMessage — reliable hook for PC save results (fires on ALL clients) ──
    Hooks.on("createChatMessage", (message) => {
      const flags = message.flags?.[MODULE_ID];
      if (flags?.type !== "pcSaveResult" || !flags.castId) return;
      if (game.user.isGM) {
        console.log(`${MODULE_ID} | createChatMessage caught pcSaveResult for`, flags.tokenDocId, "castId:", flags.castId);
        // Small delay to let the DOM render first
        setTimeout(() => this._onPcSaveResultPosted(flags), 200);
      } else {
        // ── Player side ── Another client (the GM, or NPC auto-roll) resolved a
        // PC save. Reflect it on THIS client's copy of the target-list card so the
        // player's roll button greys out + shows the result, instead of still
        // looking rollable. (2026-06-24 — fixes GM-rolled PC saves not updating
        // the player's card.)
        setTimeout(() => { try { this._updateTargetListPcRow(flags.tokenDocId, flags); } catch (_) {} }, 250);
      }
    });

    console.debug(`${MODULE_ID} | Save engine hooks registered`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Template Auto-Targeting
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Find all tokens whose occupied grid squares overlap a measured template shape.
   * Checks every grid square the token occupies (for Large+ creatures) against the
   * template's PIXI shape in local coordinates.
   *
   * @param {MeasuredTemplateDocument} templateDoc
   * @returns {Token[]} array of Token placeables inside the template
   */
  /**
   * Wait until Foundry has actually computed the template's shape.
   *
   * ⚠️ THE SHAPE DOES NOT EXIST WHEN THE TEMPLATE IS CREATED (proven 2026-08-15).
   * Measured live on Johnny's scene: at the `createMeasuredTemplate` hook the
   * placeable exists but `shape` is null, and it is STILL null immediately after
   * the create resolves. It appears around 60ms later, once the placeable draws.
   *
   * `_getTokensInTemplate` returned an empty array for a missing shape, and the
   * caller read that as "nobody is standing in the cone" — so a Green Dragon
   * breath weapon aimed straight at a target logged "0 tokens in area — skipping
   * save card" and no save was ever rolled. Nothing errored. The geometry was
   * correct all along; we asked before the answer existed.
   *
   * @returns {Promise<boolean>} true once the shape is available
   */
  static async _awaitTemplateShape(templateDoc, maxMs = 600) {
    // ⚠️ THIS LOOP WAS RIGHT ALL ALONG, and it is now the shared one. It was
    // written here first, correctly: ask for the real condition, stop the
    // moment it holds, give up at a deadline. When the same shape was needed
    // for the two hook races on 2026-08-26 the honest move was to lift it out
    // rather than write a third copy - "built beside instead of on" is a
    // mistake this codebase has already paid for.
    return waitUntil(() => !!templateDoc?.object?.shape, {
      maxMs, stepMs: 25,
      what: `the measured template ${templateDoc?.id ?? ""} to gain its shape`.trim(),
    });
  }

  /**
   * Everyone the area actually catches.
   *
   * ⚠️🔴 THE GEOMETRY LIVES IN template-geometry.mjs NOW, because ACE
   * had two of them. This one used the half-coverage rule; the concentration
   * tracker's entry test used a single centre point. A creature standing half
   * inside a Moonbeam was therefore caught when it was CAST and took nothing
   * walking back in - the same creature, the same beam, two answers.
   *
   * Both call one function now. It is also edition-aware: 2014 wants about
   * half the square covered, 2024 counts any overlap.
   */
  static _getTokensInTemplate(templateDoc) {
    const templateObject = templateDoc.object;
    if (!templateObject?.shape) {
      // ⚠️ NEVER SILENT, AND NEVER THE SAME ANSWER AS "NOBODY IS THERE".
      // An empty array here used to be indistinguishable from a genuinely
      // empty area. Callers must await _awaitTemplateShape first; if this
      // still fires, something is wrong with the placeable, not the
      // battlefield.
      console.warn(`${MODULE_ID} | _getTokensInTemplate: template ${templateDoc?.id} has NO SHAPE yet — `
        + `this is not "no targets", it is "cannot tell". The caller should have awaited SaveEngine._awaitTemplateShape.`);
      return [];
    }

    const overlap = anyOverlapCounts(CombatState.getActiveEdition);
    return canvas.tokens.placeables.filter(
      token => isTokenInTemplate(token, templateObject, null, { anyOverlapCounts: overlap }));
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Detect Save-Based Spells/Abilities
  // ═══════════════════════════════════════════════════════════════════════════

  async _onUseActivity(activity, usageConfig, dialogConfig, messageConfig) {
    // SILENT-OK: not the active GM; this hook fires on every client and only one may act
    if (game.users?.activeGM !== game.user) return;

    const item = activity.item;
    const actor = activity.actor;
    if (!item || !actor) return;

    // ══════════════════════════════════════════════════════════════════════
    //  ⚠️ THE DEDUPE GATE — AT THE TOP, WHERE EVERY PATH ARRIVES
    //
    //  FOUR hooks funnel into this method: postCreateUsageMessage,
    //  useActivity (legacy), postUseActivity, and the createChatMessage
    //  fallback. Only two of them checked whether the cast had already been
    //  handled; postCreateUsageMessage and useActivity both called straight
    //  in with no guard at all. The marker was written PARTWAY DOWN this
    //  method, so on any dnd5e build that fires both, the entire save flow
    //  ran twice — two target scans, two save cards, two sets of prompts,
    //  and every save rolled twice. (Grok audit 2026-08-18.)
    //
    //  The dedupe belonged here from the start. A guard written inside the
    //  work it is meant to prevent cannot prevent it.
    //
    //  ⚠️🔴 KEYED ON UUID ONLY, AND THE FIRST VERSION OF THIS GATE GOT IT
    //  WRONG (Brock audit, 2026-08-19). It read the activity ID as well, which
    //  looked like belt-and-braces and was in fact a live bug: dnd5e assigns
    //  the STATIC id "dnd5eactivity000" to the activity it auto-generates when
    //  migrating any legacy item (dnd5e.mjs, Activity.INITIAL_ID = staticID
    //  ("dnd5eactivity")). Every migrated and every imported item therefore
    //  carries the SAME activity id. Reading that id meant one wizard casting
    //  Fireball silently swallowed a completely different spell cast by anyone
    //  else within the 1200 ms window — no card, no saves, no error.
    //
    //  The uuid is unique per activity per item per actor, and the duplicate
    //  hooks this gate exists to stop all describe the SAME cast, so they all
    //  carry the same uuid. Uuid alone is both sufficient and safe.
    //
    //  The id is still WRITTEN further down, because the createChatMessage
    //  fallback keys on `uuid || id` and needs a stamp for the rare flag shape
    //  that has no uuid. Writing it is harmless; READING it here was not.
    // ══════════════════════════════════════════════════════════════════════
    //  ⚠️ WINDOW: DUPLICATE HOOKS, NOT DELIBERATE RE-CASTS. Redundant hooks for
    //  ONE cast fire within the same tick — milliseconds apart; the widest is
    //  the createChatMessage fallback at +250ms. A human casting the same spell
    //  again, or a dragon breathing twice in a round, is a second apart at
    //  minimum. The existing marker used a 5s window, which would have
    //  swallowed a legitimate second cast now that this gate covers EVERY
    //  path. 1200ms is ~5x the widest real duplicate and far under any
    //  intentional re-use.
    {
      const _now = Date.now();
      const _key = activity?.uuid ?? null;
      if (_key) {
        const prev = this._processedActivityIds.get(_key);
        if (prev != null && (_now - prev) < 1200) {
          console.debug(`${MODULE_ID} | _onUseActivity: "${item.name}" already handled ${_now - prev}ms ago — ignoring duplicate hook.`);
          return;
        }
        // Claim the cast IMMEDIATELY. This method awaits later on, and a second
        // hook firing during that await would otherwise sail past a check that
        // had not yet written its marker.
        this._processedActivityIds.set(_key, _now);
      } else {
        // No uuid means nothing safe to key on — the id is shared across every
        // migrated item, so using it would suppress unrelated casts. Say so
        // rather than dedupe on a value that cannot identify this cast.
        console.debug(`${MODULE_ID} | _onUseActivity: "${item.name}" has no activity uuid — cannot dedupe this one.`);
      }
      const cutoff = _now - 5000;
      for (const [k, ts] of this._processedActivityIds) {
        if (ts < cutoff) this._processedActivityIds.delete(k);
      }
    }

    // v0.6.5: Detect movement-damage concentration spells (Spike Growth,
    // Wall of Thorns, etc.) that have a template + damage but NO save.
    // These don't fit the save-engine's save-on-entry model, but they
    // ARE persistent template spells that need movement-distance damage
    // tracking by the concentration widget. Stash a pending entry so
    // `_onTemplateCreated` can fire `ace-qol.persistentSpellCreated`
    // for them with no-save metadata.
    const save = activity.save;
    if (!save?.ability) {
      try {
        const templateType = activity?.target?.template?.type
                          ?? activity?.target?.type
                          ?? item.system?.target?.template?.type
                          ?? item.system?.target?.type
                          ?? "";
        const props = item.system?.properties ?? new Set();
        const hasConcentration = props.has?.("concentration") === true
                              || (Array.isArray(props) && props.includes("concentration"))
                              || activity?.duration?.concentration === true;

        // v0.6.5: Spike Growth-class spells have NO save and NO
        // `activity.damage.parts` — dnd5e stores them as `utility`
        // activities with damage described in the spell text only.
        // Parse the description for the standard "takes XdY <type> damage
        // for every 5 feet" pattern.
        let formula = null;
        let damageType = null;

        // Activity-level damage parts. Two known shapes:
        //   • dnd5e 5.x:   { number, denomination, bonus, types: [...] }
        //   • Legacy:      ["2d4", "piercing"]
        // (v0.6.5 originally only handled the legacy shape, so Chudd's
        // 2024 Spike Growth — which uses the new object shape — fell
        // through to the description regex, which then also failed.)
        const damageParts = activity?.damage?.parts ?? [];
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

        // Description regex fallback — covers spells where damage isn't
        // on the activity (e.g. Spike Growth before re-import). Two
        // patterns since dnd5e descriptions can use plain text OR
        // dnd5e enrichers:
        //   • Plain:    "takes 2d4 piercing damage for every 5 feet"
        //   • Enricher: "takes [[/damage 2d4 type=piercing]] damage for every 5 feet"
        if (!formula) {
          const descRaw = item.system?.description?.value ?? "";
          const desc = String(descRaw).replace(/<[^>]+>/g, " ").replace(/&\w+;/g, " ");
          // Plain-text pattern first
          let m = desc.match(/takes?\s+(\d+d\d+)\s+([a-zA-Z]+)\s+damage\s+(?:for\s+every|per)\s+5\s+(?:feet|ft)/i);
          // Enricher pattern: [[/damage 2d4 type=piercing]] ... 5 feet
          if (!m) {
            m = desc.match(/\[\[\s*\/damage\s+(\d+d\d+)[^\]]*?type\s*=\s*([a-zA-Z]+)[^\]]*?\]\]\s*damage\s+(?:for\s+every|per)\s+5\s+(?:feet|ft)/i);
          }
          if (m) {
            formula    = m[1];
            damageType = m[2].toLowerCase();
          }
        }

        if (templateType && hasConcentration && formula) {
          this._pendingMovementDamageSpell = {
            activity,
            item,
            actor,
            damageTypes: damageType ? [damageType] : CombatState._getItemDamageTypes(item, activity),
            damageFormula: formula,
            timing: getSpellTiming(item),
            activityId: activity.id,
          };
          console.log(`${MODULE_ID} | Movement-damage spell "${item.name}" detected (formula: ${formula} ${damageType ?? "?"}) — waiting for placement`);
        }
      } catch (err) {
        console.warn(`${MODULE_ID} | Movement-damage detection threw:`, err);
      }
      return; // No save flow needed for these
    }

    // ── v0.4.22 — Mark this activity as processed ──
    // The createChatMessage fallback hook (registered below) reads this Map
    // to skip activities already handled by the standard postCreateUsageMessage
    // path. Without this dedupe, both hooks would fire and post duplicate
    // save cards.
    //
    // v0.4.22.1: Mark BOTH the activity.uuid AND activity.id, because the
    // fallback hook keys on uuid (different items can share the default id
    // "dnd5eactivity000"). Marking only the id would leave the fallback
    // hook to fire spuriously for any subsequent cast that happens to share
    // the same default id.
    if (activity?.uuid) {
      this._processedActivityIds.set(activity.uuid, Date.now());
    }
    if (activity?.id) {
      this._processedActivityIds.set(activity.id, Date.now());
    }
    // Auto-prune entries older than 5 seconds
    const cutoff = Date.now() - 5000;
    for (const [k, ts] of this._processedActivityIds) {
      if (ts < cutoff) this._processedActivityIds.delete(k);
    }

    // ── Capture spell upcast level (RAW upcast scaling) ──
    // dnd5e 5.x stamps the chat message with `flags.dnd5e.use.spellLevel`
    // (the slot level the spell was actually cast at — can be > base level).
    // We thread this through to _rollSpellDamage so dnd5e's rollDamage
    // applies the proper "+ X dice per slot above base" scaling.
    //
    // Falls back to base spell level when no upcast info is available.
    // For cantrips (level 0), this stays 0 and character-level cantrip
    // scaling kicks in instead.
    let spellLevel = null;
    try {
      const useFlag = messageConfig?.data?.flags?.dnd5e?.use
                   ?? messageConfig?.flags?.dnd5e?.use
                   ?? usageConfig?.spell;
      if (useFlag) {
        spellLevel = Number(useFlag.spellLevel ?? useFlag.level ?? null);
      }
      // Fallback: use base item level
      if (!Number.isFinite(spellLevel) && item.system?.level !== undefined) {
        spellLevel = Number(item.system.level);
      }
    } catch (_) { /* non-fatal */ }

    // dnd5e 5.2.5: save.ability is a Set, not a string
    const saveAbility = (save.ability instanceof Set || save.ability instanceof Array)
      ? [...save.ability][0]
      : (typeof save.ability === "string" ? save.ability : String(save.ability));
    if (!saveAbility) return;
    let saveDC = save.dc?.value ?? save.dc ?? 0;
    // Fallback: some items (esp. bg3-hud / imported spells) leave the save DC
    // unresolved at 0. Use the caster's spell save DC so the save isn't a free
    // auto-pass (DC 0 = everyone succeeds, which silently breaks Web etc.).
    if (!(Number(saveDC) > 0)) {
      // The CASTER's spell save DC. Attacker-side, so it doesn't belong to the
      // target profile — but it IS a fact about a creature, so it comes from
      // the same single reader both profiles are built on. (2026-07-28)
      const sysDC = Situation.readCreature(actor)?.spellDC || null;
      saveDC = Number(sysDC) > 0 ? Number(sysDC) : 10;
      console.debug(`${MODULE_ID} | Save DC for "${item.name}" was 0/unset — using caster spell DC ${saveDC}`);
    }
    const isSpell = item.type === "spell";

    // Get damage info — from the ACTIVITY being used, never the whole item.
    const damageTypes = CombatState._getItemDamageTypes(item, activity);
    const halfOnSave = this._detectHalfDamage(item, activity);

    // Get spell timing classification
    const timing = getSpellTiming(item);

    // ── Check if the spell/feat places a measured template ──
    // v0.4.22.3: dnd5e 5.x stores template config on the ACTIVITY for
    // feats (and modern-shape spells), and on the ITEM for legacy-shape
    // spells. Reading only `item.system.target.template.type` missed
    // every feat-with-template (Hellfire Orb, dragon breath weapons,
    // aura-of-dread style abilities), causing the handler to fall
    // through to the `game.user.targets` branch — which is empty
    // BEFORE the template lands and auto-targets tokens. Result:
    // first-cast-after-reload produced no save card. Check activity
    // first, item second.
    const templateType = activity?.target?.template?.type
                      ?? activity?.target?.type
                      ?? item.system?.target?.template?.type
                      ?? item.system?.target?.type
                      ?? "";

    // ── Is that template type one this system can ACTUALLY place? ──
    // (2026-07-28) King's Ghostly Howl carries template type "emanation", a
    // 2024-era word that does not exist anywhere in dnd5e 5.3.1. The system
    // still tries: AbilityTemplate.fromActivity looks the type up, finds
    // nothing, and returns null — then dnd5e's own #placeTemplate does
    // `for (const t of null)` and throws "Failed to place measured template".
    // No template is ever created, so waiting for one below meant waiting
    // FOREVER: no save card, no roll, nobody frightened, and the only clue was
    // a system error that looks like somebody else's problem.
    //
    // So don't take the template type on faith. If the system has no shape for
    // it, treat the ability as template-less and fall through to the targets /
    // picker path, which is what actually resolves the save. One GM warning
    // names the bad data so it can be corrected at the source.
    let templatePlaceable = true;
    if (templateType) {
      try {
        const known = CONFIG?.DND5E?.areaTargetTypes ?? globalThis.dnd5e?.config?.areaTargetTypes ?? {};
        templatePlaceable = !!known[templateType]?.template;
      } catch (_) { templatePlaceable = true; }   // can't tell → behave as before
      if (!templatePlaceable) {
        console.warn(`${MODULE_ID} | "${item.name}" declares template type "${templateType}", which this dnd5e build cannot place — resolving the save without a template.`);
        if (game.user?.isGM) {
          ui.notifications?.warn(`${item.name}: unknown area type "${templateType}" — save resolved without a template. Fix the ability's target settings.`);
        }
      }
    }

    // ⚠️ A POOL SPELL HAS NO SAVING THROW, WHATEVER ITS SHEET CLAIMS. Colour
    // Spray is a 6d10 hit-point pool in both editions, and his own copy carries a
    // phantom Constitution save at DC 22 that an importer invented. Arming a
    // pending save here would roll that invented save at every creature in the
    // cone. area-pool.mjs owns this template instead.
    try {
      if (SaveEngine._isPoolSpell(item)) {
        console.log(`${MODULE_ID} | "${item.name}" resolves by a hit-point pool, `
          + `not a saving throw — no save card will be armed for its area.`);
        return;
      }
    } catch (err) {
      console.warn(`${MODULE_ID} | could not check whether "${item?.name}" is a `
        + `pool spell (continuing as a normal save):`, err);
    }

    if (templateType && templatePlaceable) {
      // Spell has a template — stash data, wait for createMeasuredTemplate hook
      this._pendingSaveSpell = {
        activity,
        item,
        actor,
        saveAbility,
        saveDC,
        halfOnSave,
        damageTypes,
        isSpell,
        timing,
        activityId: activity.id,
        spellLevel,
      };
      console.log(`${MODULE_ID} | Save spell "${item.name}" has template type "${templateType}" — waiting for template placement`);
      return;
    }

    // ── No template — use targets, or POP THE PICKER if none are selected ──
    // Silently returning on an empty target set (the old behaviour) meant a
    // save item fired with nothing targeted did NOTHING at all — no card, no
    // prompt. Now, with no targets, we show the same target picker that normal
    // targeted spells use, so the GM picks who it hits and the save flow runs.
    let tokens;
    // Picker-driven = nothing was pre-targeted, so we open the picker for THIS
    // cast. A picker-chosen target is TRANSIENT — it must not linger as a
    // persistent target afterward, or the NEXT cast sees it, skips the picker,
    // and silently re-hits the same creature (Johnny 2026-07-11: "the picker
    // only works once"). A creature the user PRE-targeted is kept (their intent,
    // plus the multiattack follow-up per punch #11).
    const _pickerDriven = game.user.targets.size === 0;
    if (game.user.targets.size) {
      console.log(`${MODULE_ID} | [picker-timing] SaveEngine: "${item.name}" using ${game.user.targets.size} pre-targeted token(s) — SKIPPING picker`);
      tokens = [...game.user.targets];
    } else {
      // ── Pipeline ownership guard (kills the double-picker) ──
      // Spells the unified pipeline owns target via the pipeline's OWN picker —
      // its SaveResolver opens the (purple) picker and calls postSaveCard itself.
      // The pipeline clears targets pre-cast, so this handler lands here with an
      // empty set and would open a SECOND picker. Defer to the pipeline instead.
      if (game.aceQol?.SpellPipeline?.ownsSpell?.(item)) {
        console.log(`${MODULE_ID} | [picker-timing] SaveEngine: "${item.name}" owned by SpellPipeline — deferring, no picker here`);
        return;
      }
      console.log(`${MODULE_ID} | [picker-timing] SaveEngine: "${item.name}" has no pre-targets — opening picker now`);
      let picked = [];
      try {
        const { SpellTargetPicker } = await import("./spell-target-picker.mjs");
        // ── Read the ability's OWN target count — don't blindly allow a crowd ──
        // dnd5e activities declare their targeting as structured data, so the
        // generic path reads it instead of guessing: a discrete-target ability
        // carries an "affects count" (Banish = 1 creature, a two-target gaze = 2),
        // while an area ability carries a measured template, where picking several
        // IS correct. Only fall back to "many" when the ability genuinely has
        // neither — and to the single-target case (1) when it has no template and
        // no declared count, which is the overwhelmingly common "one creature you
        // can see" shape. The GM can still add more via "+ TARGET SELECTED".
        const _tgt      = activity?.target ?? {};
        const _affects  = _tgt.affects ?? {};
        const _declared = parseInt(_affects.count);
        const _maxTargets = (_tgt.template?.type)
          ? 99
          : (Number.isFinite(_declared) && _declared > 0 ? _declared : 1);
        // Player-cast spells: this handler runs on the GM (activeGM-gated), but the
        // TARGET PICK belongs on the CASTER's own screen. _pickTargetsForCaster routes
        // the picker to the caster's client via socket (mirrors the rider popup) and
        // returns the same Actor[] the local picker would, so the resolution below is
        // unchanged. GM-cast / NPC / offline-player → it picks locally.
        picked = await this._pickTargetsForCaster({
          spellItem:   item,
          casterActor: actor,
          maxTargets:  _maxTargets,
          rangeFt:     Number(activity?.range?.value) || 30,
          allowSelf:   false,
        });
      } catch (err) {
        console.warn(`${MODULE_ID} | Save target picker failed:`, err);
      }
      if (!picked?.length) return;   // GM cancelled — nothing to do
      tokens = picked
        .map(act => act.getActiveTokens?.()?.[0] ?? canvas.tokens?.placeables.find(t => t.actor?.id === act.id))
        .filter(Boolean);
      if (!tokens.length) return;
      // Reflect the choice in game.user.targets so the card + downstream see it.
      for (const t of tokens) t.setTarget(true, { user: game.user, releaseOthers: false });
    }

    // ── Cast committed WITH a target now locked in (post-picker). Fire the
    //    caster's flourish HERE — after the pick — not back at the cast-click
    //    (which is before the picker even opens). AceFX listens for this. ──
    try { Hooks.callAll(`${MODULE_ID}.spellCommitted`, { casterActor: actor, item }); }
    catch (_) { /* purely cosmetic — must never block the save flow */ }

    // Exclude caster — same logic as the template path. See _onTemplateCreated
    // for full justification. GM can re-add via "+ TARGET SELECTED" button.
    if (QolSettings.get?.("excludeCasterFromTemplates") !== false) {
      tokens = tokens.filter(t => t.actor?.id !== actor?.id);
      if (!tokens.length) {
        console.log(`${MODULE_ID} | All targets were the caster — skipping save card`);
        return;
      }
    }

    // ── "Must hear you" gate (RAW) — Vicious Mockery / Suggestion / Command
    // class: a deafened target simply can't receive the spell. Filter them
    // out with a visible explainer instead of rolling a pointless save.
    try {
      const { HearingGate } = await import("./rules/hearing-gate.mjs");
      const gate = HearingGate.filterDeafTargets(item, tokens);
      if (gate.blocked.length) {
        await HearingGate.postBlockedCard(item, actor, gate.blocked, gate.entry);
        tokens = gate.allowed;
        console.log(`${MODULE_ID} | hearing gate: ${gate.blocked.length} deafened target(s) removed from "${item.name}"`);
        if (!tokens.length) {
          ui.notifications?.info(`${item.name}: no valid targets — the deafened can't hear you.`);
          this._releaseUserTargets();
          return;
        }
      }
    } catch (err) {
      console.warn(`${MODULE_ID} | hearing gate failed (non-blocking):`, err);
    }

    // ── Fast-path for NPC-only single-target saves ──
    // If the GM is rolling on a single NPC with no PCs in the mix, the
    // live-target-card confirmation step is unnecessary friction — the GM
    // is just going to click ROLL SAVES anyway. Skip straight to rolling
    // and posting the result card. The GM can always pre-target multiple
    // creatures or include a PC if they want the confirmation step.
    const isNpcOnlySingleTarget = tokens.length === 1
      && !SaveEngine.isPlayerCharacter(tokens[0].actor);
    if (isNpcOnlySingleTarget) {
      console.log(`${MODULE_ID} | Single NPC target detected — skipping live-target-card, rolling immediately`);
      await this._fastResolveSingleNpcSave(item, actor, tokens[0], {
        saveAbility, saveDC, halfOnSave, damageTypes, isSpell, timing,
        activity,
      });
      // TARGET-STICK (Johnny 2026-07-24): a SINGLE-creature action KEEPS its
      // target, full stop — pre-targeted OR picker-chosen. He wants to keep
      // hammering the same creature without re-picking every cast; the picker
      // is only meant to appear when NOTHING is targeted. (This used to release
      // a picker-chosen single target, which is the exact "I lose my target"
      // complaint.) Only area / multi-creature actions release — and this
      // fast-path is single-NPC by construction, so it never releases.
      return;
    }

    await this._postLiveTargetCard(item, actor, tokens, {
      saveAbility, saveDC, halfOnSave, damageTypes, isSpell, timing,
      activityId: activity.id,
      spellLevel,
    });
    // TARGET-STICK (Johnny 2026-07-24): ONLY a multi-creature action releases.
    // A single creature — pre-targeted OR picker-chosen — KEEPS its target so
    // the next action re-hits it without re-picking. (Dropped the old
    // `|| _pickerDriven` clause: it was releasing single picker-chosen targets,
    // which is the "target won't stick" bug.)
    if (tokens.length > 1) this._releaseUserTargets();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Player-cast target picker — socket round-trip (mirrors the rider popup)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Get the spell's target(s). The pick belongs on the CASTER's screen, but this
   * handler runs on the GM (activeGM-gated). So: if a connected non-GM player owns
   * the caster, ask THEIR client to open the picker over the socket and return the
   * choice (mirrors the Divine Smite rider popup). Otherwise — GM-cast, an NPC, or
   * the owning player is offline — the GM picks locally. Always returns Actor[].
   */
  async _pickTargetsForCaster({ spellItem, casterActor, maxTargets, rangeFt, allowSelf }) {
    const localPick = async () => {
      const { SpellTargetPicker } = await import("./spell-target-picker.mjs");
      return SpellTargetPicker.pick({ spellItem, casterActor, maxTargets, rangeFt, allowSelf });
    };

    const casterUser = this._casterUser(casterActor);
    if (!casterUser) {
      console.debug(`${MODULE_ID} | SaveEngine picker: no remote caster for "${spellItem?.name}" → GM picks locally`);
      return localPick();   // GM-cast / NPC / no connected owner → GM picks
    }
    console.log(`${MODULE_ID} | SaveEngine picker: routing "${spellItem?.name}" target pick to ${casterUser.name}'s client (socket)`);

    const requestId = foundry.utils.randomID();
    let resolveFn;
    const reply = new Promise(res => { resolveFn = res; });
    // ⚠️ store the addressee beside the resolver — see socket-authority.mjs
    this._pickerRequests.set(requestId, { resolve: resolveFn, askedUserId: casterUser.id });
    try {
      game.socket.emit(`module.${MODULE_ID}`, {
        action: "showSpellPicker",
        requestId,
        userId: casterUser.id,
        itemUuid: spellItem.uuid,
        casterActorUuid: casterActor.uuid,
        maxTargets, rangeFt, allowSelf,
        // [picker-timing] GM-side cost (cast detected → this emit) + which detect
        // path fired, so the caster's log shows the full breakdown from one cast.
        gmProcessMs: this._castDetectMs ? Math.round(performance.now() - this._castDetectMs) : -1,
        detectVia: this._castDetectVia ?? "?",
      });
      ui.notifications?.info(`${spellItem.name}: waiting for ${casterUser.name} to choose a target…`);

      // 60s safety timeout — a cast must never hang forever waiting on a player.
      const tokenIds = await Promise.race([
        reply,
        new Promise(res => setTimeout(() => res("__timeout__"), 60000)),
      ]);
      this._pickerRequests.delete(requestId);

      if (tokenIds === "__timeout__") {
        ui.notifications?.warn(`${spellItem.name}: ${casterUser.name} didn't respond — picking on the GM side.`);
        return localPick();
      }
      if (!Array.isArray(tokenIds)) return [];   // player cancelled
      return tokenIds.map(tid => canvas.tokens?.get(tid)?.actor).filter(Boolean);
    } catch (err) {
      this._pickerRequests.delete(requestId);
      console.warn(`${MODULE_ID} | _pickTargetsForCaster socket round-trip failed — picking locally:`, err);
      return localPick();
    }
  }

  /** The active, connected, non-GM user who controls the casting actor (whose screen
   *  the picker should open on), or null for a GM-cast / NPC / offline owner. */
  _casterUser(casterActor) {
    if (!casterActor) return null;
    try {
      const assigned = game.users?.find(u => u.active && !u.isGM && u.character?.id === casterActor.id);
      if (assigned) return assigned;
      return game.users?.find(u => u.active && !u.isGM && casterActor.testUserPermission?.(u, "OWNER")) ?? null;
    } catch (_) { return null; }
  }

  /**
   * THE player-character test — OWNERSHIP-BASED BY DESIGN. DO NOT "FIX" THIS.
   *
   * `hasPlayerOwner` is deliberate (Johnny, and he re-confirmed it 2026-07-27):
   * it is the "is a real player behind this creature" test. A creature nobody
   * owns is handled like an NPC — ACE rolls for it — which is exactly what he
   * wants when a player isn't at the table. Do NOT widen this to
   * `type === "character"`: that would force a whispered prompt for absent
   * players' characters and hang the turn waiting on someone who isn't there.
   *
   * (I widened it once on 2026-07-27 after a PC's save auto-rolled, assuming a
   * bug. It wasn't — that PC's player simply wasn't connected. Reverted.)
   *
   * Kept as ONE named helper so every decision point reads the same rule and
   * this note travels with it.
   */
  static isPlayerCharacter(actor) {
    if (!actor) return false;
    try { return actor.hasPlayerOwner === true; } catch (_) { return false; }
  }

  /**
   * WHICH PLAYERS OWN THIS CREATURE — asked, not reconstructed. (audit F-020)
   *
   * Three places built this by walking the ownership record and skipping the
   * "default" key. That misses every actor whose player access comes from the
   * DEFAULT level rather than a named entry — a party-shared character, a
   * familiar the whole table can drive. Such an actor still answers TRUE to
   * `hasPlayerOwner`, so it IS treated as a player character, but the owner list
   * came back EMPTY. In Foundry an empty whisper list means PUBLIC, so that
   * player's private "roll your save" prompt was posted to the entire table —
   * and anyone could click it.
   *
   * `testUserPermission` is the engine's own answer and honours the default
   * level, per-user entries and role-based access alike. It is already what
   * `_pcOwnerActive` and the ROLL DAMAGE gate use, so this makes all of them
   * agree. GMs are excluded: they see every whisper anyway and use the card's
   * own dice button.
   */
  static ownerUserIds(actor) {
    if (!actor) return [];
    try {
      return (game.users?.filter(u => !u.isGM && actor.testUserPermission?.(u, "OWNER")) ?? [])
        .map(u => u.id);
    } catch (err) {
      console.warn(`${MODULE_ID} | couldn't read owners of ${actor?.name}:`, err);
      return [];
    }
  }

  /**
   * THE caster's token — the exact body that acted. (audit F-019)
   *
   * ⚠️ `find(t => t.actor?.id === casterActor.id)` is NOT this. For UNLINKED
   * tokens the synthetic actor's id IS the base actor's id, so with nine goblins
   * dropped from one sidebar entry that search returns whichever Foundry lists
   * first — not the one that cast. It was deciding where a spell template landed
   * and whose line of sight cover was measured along.
   *
   * A synthetic actor knows its own TokenDocument, and that answer is exact.
   * Only fall back to searching for a linked actor, where every copy shares one
   * sheet. If several UNLINKED copies match and nothing tells them apart, return
   * null and say so — the caller then skips the position-dependent step rather
   * than doing it from the wrong body. Same principle as the exact-token rule
   * already used when applying conditions.
   */
  static casterTokenDoc(casterActor, { sceneId = null, quiet = false } = {}) {
    try {
      if (!casterActor) return null;
      // Unlinked synthetic — its own token, no ambiguity possible.
      // SILENT-OK: a success return: the unlinked token IS the answer, not a bail
      if (casterActor.token) return casterActor.token;

      const docs = casterActor.getActiveTokens?.(false, true) ?? [];
      const pool = sceneId ? docs.filter(d => d.parent?.id === sceneId) : docs;
      if (pool.length === 1) return pool[0];
      if (pool.length > 1) {
        // Linked copies share one sheet; position still differs, so say which
        // one was taken rather than pretending the question was unambiguous.
        if (!quiet) console.debug(`${MODULE_ID} | ${casterActor.name} has ${pool.length} tokens here — using the first for position.`);
        return pool[0];
      }
      return null;
    } catch (err) {
      console.warn(`${MODULE_ID} | couldn't resolve the caster's token for ${casterActor?.name}:`, err);
      return null;
    }
  }

  /**
   * The caster's token when all we were given is an ACTOR ID (the save cards
   * store ids, not object references). Prefers the exact token the card stamped
   * at cast time; falls back to a scan that REFUSES to guess between unlinked
   * copies rather than measure cover from the wrong one.
   */
  static casterTokenDocById(casterActorId, scene, stampedTokenDocId = null) {
    try {
      if (stampedTokenDocId) {
        const exact = scene?.tokens?.get(stampedTokenDocId);
        if (exact) return exact;
      }
      if (!casterActorId || !scene) return null;
      const matches = (scene.tokens?.contents ?? []).filter(t => t.actorId === casterActorId);
      if (matches.length === 1) return matches[0];
      if (matches.length > 1) {
        const linked = matches.find(t => t.actorLink);
        if (linked) return linked;
        console.debug(`${MODULE_ID} | ${matches.length} unlinked copies share caster actor ${casterActorId} and no exact token was stamped — skipping the position-dependent step rather than using the wrong one.`);
        return null;
      }
      return null;
    } catch (err) {
      console.warn(`${MODULE_ID} | caster token lookup by id failed:`, err);
      return null;
    }
  }

  /**
   * Is a PC save-target's owning player currently online (active, non-GM)?
   * Handles linked actors AND unlinked synthetic token actors.
   */
  _pcOwnerActive(tgt) {
    try {
      let a = tgt?.actorId ? game.actors.get(tgt.actorId) : null;
      if (!a && tgt?.sceneId && tgt?.tokenDocId) {
        a = game.scenes.get(tgt.sceneId)?.tokens?.get(tgt.tokenDocId)?.actor ?? null;
      }
      if (!a) return false;

      // ⚠️ "SOMEBODY MAY TOUCH THIS" IS NOT "SOMEBODY IS RESPONSIBLE FOR THIS".
      //
      // This asked `testUserPermission(u, "OWNER")`, which — as ownerUserIds
      // documents a few lines up — HONOURS THE DEFAULT OWNERSHIP LEVEL. So an
      // actor whose default is Owner is "owned" by every connected player at
      // once, none of whom is that character's player. The engine then waited
      // for a human who was never going to answer.
      //
      // Johnny hit this within an hour of my telling him to set the shared test
      // dummy's default to Owner (2026-08-14): Fireball sat waiting on Hammer,
      // who has no player at all, and on Firaxis, whose player was offline.
      // Fixing the permission created the bug — the check was always this
      // fragile, it just had not been provoked.
      //
      // Waiting is only correct when a SPECIFIC person is expected to roll:
      // their assigned character, or an EXPLICIT per-user grant. A blanket
      // default is a convenience for the table, not a promise that anyone is
      // sitting behind that sheet. Whispering still uses the broad answer —
      // showing the card to everyone who can see it is right; blocking on them
      // is not.
      const OWNER = CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER;
      return game.users?.some(u => {
        // SILENT-OK: a predicate inside some(); returning false, not exiting
        if (!u.active || u.isGM) return false;
        if (u.character?.id === a.id) return true;              // it is their character
        const explicit = a.ownership?.[u.id];                   // NOT `default`
        return Number.isFinite(explicit) && explicit >= OWNER;
      }) ?? false;
    } catch (_) { return false; }
  }

  /**
   * GM rolls a PC's save on their behalf — used when the owning player is
   * OFFLINE so the save never hangs. Mirrors the roll-on-behalf dice button's
   * fake-prompt construction, then runs the normal GM-side roll.
   */
  async _gmRollPcSaveOffline(item, actor, tgt, opts) {
    const { saveAbility, saveDC, halfOnSave, damageTypes, isSpell, castId } = opts;
    const fakeMsg = { flags: { [MODULE_ID]: {
      type: "pcSavePrompt",
      itemUuid: item?.uuid ?? null,
      itemId:   item?.id ?? null,
      saveAbility, saveDC, halfOnSave, damageTypes, isSpell,
      tokenDocId: tgt.tokenDocId, actorId: tgt.actorId, sceneId: tgt.sceneId,
      // The real caster + the exact body, so cover works on the GM-rolls-for-an-
      // absent-player path too. (audit F-019)
      casterActorId:    actor?.id ?? null,
      casterTokenDocId: SaveEngine.casterTokenDoc(actor, { sceneId: tgt.sceneId })?.id ?? null,
      targetName: tgt.name, targetImg: tgt.img,
      autoFailSave: tgt.autoFailSave, saveAdvantage: tgt.saveAdvantage, saveDisadvantage: tgt.saveDisadvantage,
      superSaver: tgt.superSaver, semiSuperSaver: tgt.semiSuperSaver,
      saveBonuses: tgt.saveBonuses, damageModifiers: tgt.damageModifiers,
      currentHP: tgt.currentHP, maxHP: tgt.maxHP, castId,
    }}};
    return await this._rollPcSave(fakeMsg);
  }

  /** Called on the GM when the caster's client replies with its target choice. */
  resolveSpellPickerChoice(requestId, tokenIds, payload = null) {
    const pending = this._pickerRequests.get(requestId);
    if (!pending) {
      cannotDo("a spell target choice", "no picker was waiting for it - it arrived late, or twice");
      return;
    }
    // Only the caster we asked may say where their own spell lands.
    if (payload && !replyIsFromTheUserWeAsked(pending.askedUserId, payload, "spellPickerChoice")) {
      rejectedReply("the spell target picker", pending.askedUserId, payload);
      return;
    }
    this._pickerRequests.delete(requestId);
    pending.resolve(tokenIds);
  }

  /**
   * Release ALL of the current user's targets once a save has been committed
   * to a card. Without this the targeting reticles "stick" on the tokens
   * after the cast resolves — a long-standing UX complaint across every
   * targeted save/spell. Safe here: the live-target card and the result card
   * each store their own target snapshot, so the downstream save rolls read
   * the card data, NOT the live game.user.targets set. The GM can still
   * re-target and use the card's "+ TARGET SELECTED" button afterwards.
   */
  _releaseUserTargets() {
    try {
      const targets = [...(game.user?.targets ?? [])];
      // SILENT-OK: nothing is targeted; releasing none is a no-op, not a failure
      if (!targets.length) return;
      // V13-correct: User#updateTokenTargets was removed, so toggle each
      // token off (snapshot first — setTarget(false) mutates the set during
      // iteration) then clear the set. Matches SpellPipeline._clearUserTargets.
      for (const t of targets) {
        t.setTarget?.(false, { user: game.user, releaseOthers: false, groupSelection: false });
      }
      game.user?.targets?.clear?.();
    } catch (err) {
      console.warn(`${MODULE_ID} | _releaseUserTargets failed:`, err);
    }
  }

  /**
   * Fast-path for single NPC target: roll the save immediately and post the
   * Phase 1 result card. Skips the live-target-card confirmation step.
   *
   * Mirrors the relevant subset of _rollNpcSavesFromTargetList — same
   * roll, same condition application, same wasted-concentration drop, same
   * Phase 1 card. Does NOT support template AOEs, multi-target, or PC
   * saves — those go through the normal flow.
   */
  async _fastResolveSingleNpcSave(item, casterActor, token, opts) {
    // v0.4.22.4: Match the pacing of `_postLiveTargetCard`. Without this
    // the fast-path NPC save card lands instantly, ahead of the spell
    // animation. Configurable via `saveCardDelayAfterCastMs`.
    //
    // v0.6.2: `opts.skipDelay === true` bypasses the pacing for
    // entry-trigger NPC saves (Moonbeam token-walked-in path).
    if (!opts?.skipDelay) {
      try {
        const delay = Number(QolSettings.get?.("saveCardDelayAfterCastMs") ?? 1500);
        if (Number.isFinite(delay) && delay > 0) {
          await new Promise(r => setTimeout(r, delay));
        }
      } catch (_) { /* setting unavailable — proceed without delay */ }
    }

    const { saveAbility, saveDC, halfOnSave, damageTypes, isSpell, timing, activity } = opts;
    const activityId = activity?.id ?? null;

    // Build the target context the way _postLiveTargetCard does so
    // _rollSingleSave gets a normalized input.
    const tActor = token.actor;
    // Save modifier via the target profile — ONE reader for a fact that was
    // being decoded seven different ways in this file alone.
    const saveMod = SaveEngine._targetProfileFor(tActor, { tokenDocId: token?.document?.id, sceneId: token?.scene?.id })?.saveMod(saveAbility) ?? 0;
    const tgt = {
      tokenId:    token.id,
      tokenDocId: token.document?.id ?? token.id,
      sceneId:    canvas.scene?.id,
      actorId:    tActor?.id,
      name:       token.name ?? tActor?.name,
      img:        tActor?.img ?? token.document?.texture?.src,
      saveAbility,
      saveAbilityUpper: saveAbility.toUpperCase(),
      saveMod,
      saveBonus: saveMod,
      // ── RAW AUTO-FAIL, ASKED NOT ASSUMED (2026-07-28) ──
      // This was hardcoded `false`. RAW: Petrified, Paralyzed, Stunned and
      // Unconscious all AUTOMATICALLY FAIL Strength and Dexterity saving
      // throws — so a petrified creature going through this path was being
      // allowed to roll, and could pass a save it cannot pass. The profile
      // knows its conditions; ask it.
      autoFailSave: SaveEngine._targetProfileFor(tActor, { tokenDocId: token?.document?.id, sceneId: token?.scene?.id })?.autoFailsSave(saveAbility) ?? false,
      superSaver: false,
      damageModifiers: tActor ? DamageCalculator.getTargetDamageModifiers(tActor, item) : {},
      // Snapshot for the card row — profile, same as every other target fact.
      currentHP: SaveEngine._targetProfileFor(tActor, { tokenDocId: token?.document?.id, sceneId: token?.scene?.id })?.hp.value ?? 0,
      maxHP:     SaveEngine._targetProfileFor(tActor, { tokenDocId: token?.document?.id, sceneId: token?.scene?.id })?.hp.max ?? 0,
    };

    // Roll the save
    const result = await this._rollSingleSave(tgt, saveAbility, saveDC, halfOnSave, casterActor?.id, {
      outcomeConditions: SaveEngine._outcomeConditionsFor(item),
      dealsDamage: Array.isArray(damageTypes) && damageTypes.some(t => t && t !== "none"),
      // The exact body that cast, for the cover check. (audit F-019)
      casterTokenDocId: SaveEngine.casterTokenDoc(casterActor, { sceneId: canvas.scene?.id })?.id ?? null,
    });

    // Emit saveComplete hook
    try {
      Hooks.callAll(`${MODULE_ID}.saveComplete`, {
        actor: tActor, tokenDocId: result.tokenDocId, saveAbility, passed: result.passed,
        itemUuid: item?.uuid ?? null,
      });
    } catch (_) { /* non-fatal */ }

    // Compute hasDamage same way the regular path does
    const hasDamage = Array.isArray(damageTypes) && damageTypes.length > 0
                   && damageTypes.some(t => t && t !== "none");

    // Apply condition if appropriate. Normally a damaging power defers its
    // conditions until after the damage card — but a "can break free" power
    // (Entangling Rope) needs its Restrained to land on the fail right away so
    // the break-free prompt has something to attach to, even though it also
    // deals damage.
    const breakFreeEnabled = item.getFlag?.(MODULE_ID, "breakFreeConfig")?.enabled === true;
    let appliedConditions = [];
    if (!hasDamage || breakFreeEnabled) {
      try {
        appliedConditions = await this._applyFailedSaveConditions(item, [result], { saveAbility, saveDC, activityId, casterActor }) ?? [];
      } catch (err) {
        console.error(`${MODULE_ID} | Fast-path condition application failed:`, err);
      }
    }

    // Drop wasted concentration if nothing landed
    if (!hasDamage && appliedConditions.length === 0) {
      try {
        await this._dropCasterConcentrationIfNoEffect(item, casterActor);
      } catch (err) {
        console.warn(`${MODULE_ID} | Fast-path wasted-concentration drop failed:`, err);
      }
    }

    // Post the result card (Phase 1 — same builder as the normal flow)
    await this._postSaveResultsPhase1(item, casterActor, [result], {
      saveAbility, saveDC, halfOnSave, damageTypes, isSpell, activityId,
      timingType: timing?.type ?? null,
      templateDocId: null,
      templateSceneId: null,
      hasDamage,
      appliedConditions,
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Template Created — Resolve Pending Save Spell
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Rebuild the pending-save payload from a template's own origin flag.
   *
   * ⚠️ MIRRORS THE postCreateUsageMessage EXTRACTION EXACTLY — same Set
   * handling for the save ability, same DC fallback to the caster's spell DC,
   * same activity-not-item damage read. If that extraction changes, change
   * this with it. Returns null for anything that is not a save activity, and
   * for hand-drawn templates, which carry no origin flag.
   */
  /**
   * Is this save prompt for a character the current user actually owns?
   *
   * ⚠️ RESOLVED FROM THE ACTOR, NOT FROM THE WHISPER LIST. A GM is whispered
   * every prompt, so "was I whispered this" answers yes for everybody's card and
   * would un-collapse the lot. Ownership of the creature being asked to save is
   * the only question that separates "my character" from "someone else's".
   */
  static _promptIsMine(flags) {
    try {
      const actor = game.actors?.get?.(flags?.actorId)
        ?? (flags?.tokenDocId && flags?.sceneId
              ? game.scenes?.get?.(flags.sceneId)?.tokens?.get?.(flags.tokenDocId)?.actor
              : null);
      if (!actor) return false;
      // OWNER, not OBSERVER: seeing a sheet is not playing the character. A GM
      // owns every actor implicitly, so ask about the explicit per-user level.
      const level = actor.ownership?.[game.user.id]
        ?? actor.ownership?.default
        ?? CONST.DOCUMENT_OWNERSHIP_LEVELS.NONE;
      return level === CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER;
    } catch (err) {
      // A GM who cannot be identified as the owner keeps the OLD behaviour:
      // collapsed, and ROLL FOR THEM still works. Never fail into a state where
      // every whisper in the log unfolds.
      console.warn(`${MODULE_ID} | could not tell whether this save prompt is the user's own:`, err);
      return false;
    }
  }

  /**
   * Does this action resolve by a hit-point pool rather than a saving throw?
   *
   * ⚠️🔴 ONE READER, BECAUSE TWO PLACES ARM A SAVE AND I ONLY GUARDED ONE.
   * Live proof, 2026-08-29: the guard at the arming site fired correctly and
   * logged "no save card will be armed for its area" - and then
   * `_pendingFromTemplate` REBUILT the pending save from the template's own
   * origin flag, because a null pending reads as "the cast happened on another
   * client". Colour Spray posted a DC 20 Constitution card, the Flameskull
   * rolled 16, failed, and was Blinded by a save the spell does not have.
   *
   * The pool had already answered correctly on the same cast: 36 hit points
   * against a Flameskull, unaffected. So the creature was both correctly spared
   * and wrongly blinded, one second apart.
   */
  static _isPoolSpell(item) {
    try {
      return game.aceQol?.SpellPipeline?._getEntry?.(item)?.shape === "template-pool";
    } catch (err) {
      // ⚠️ Unknown must not silently suppress a real save card.
      console.warn(`${MODULE_ID} | could not tell whether "${item?.name}" resolves `
        + `by a pool (treating it as a normal save):`, err);
      return false;
    }
  }

  _pendingFromTemplate(templateDoc) {
    // ⚠️🔴 EVERY GATE BELOW USED TO RETURN null IN SILENCE, and the caller
    // then returned in silence too. A breath weapon that produced no save card
    // printed exactly one line - "pending save: false" - and then nothing, so
    // there was no way to tell a hand-drawn template apart from a broken one.
    // Johnny, 2026-08-24: "the save pipeline, for some reason, is dropping it.
    // I have no idea why." Neither did I, and that is the defect: five ways to
    // fail and not one of them said which.
    //
    // "Absent" and "broken" must never print the same message. Now each gate
    // says what it looked for and what it got, once, at the moment it gives up.
    const why = (reason) => {
      console.warn(`${MODULE_ID} | no save card: ${reason} `
        + `(template ${templateDoc?.id}, origin ${templateDoc?.flags?.dnd5e?.origin ?? "none"})`);
      return null;
    };
    try {
      const originUuid = templateDoc?.flags?.dnd5e?.origin;
      // A GM template drawn by hand genuinely has no origin. That is normal and
      // silent - it is the ONLY case here that is not a problem.
      if (!originUuid) return null;

      const resolve = foundry?.utils?.fromUuidSync
        ?? (typeof fromUuidSync === "function" ? fromUuidSync : null);
      if (!resolve) return why("Foundry has no fromUuidSync to resolve the origin with");

      const activity = resolve(originUuid);
      if (!activity) return why(`the origin uuid resolved to nothing - the item may have been deleted`);
      if (activity.type !== "save") {
        return why(`the activity is type "${activity.type}", not "save" - `
          + `this ability places a template but has no saving throw on it`);
      }

      const item = activity.item ?? activity.parent?.parent ?? null;
      const actor = item?.actor ?? null;
      if (!item) return why("the activity has no parent item");
      // ⚠️ THE SAME QUESTION THE ARMING SITE ASKS. Rebuilding a pending save
      // for a pool spell is how Colour Spray blinded a creature its own pool had
      // just spared.
      if (SaveEngine._isPoolSpell(item)) {
        return why(`"${item.name}" resolves by a hit-point pool, not a saving throw`);
      }
      if (!actor) return why(`"${item.name}" is not on an actor (a compendium or sidebar item cannot cast)`);

      const save = activity.save ?? {};
      const saveAbility = (save.ability instanceof Set || save.ability instanceof Array)
        ? [...save.ability][0]
        : (typeof save.ability === "string" ? save.ability : String(save.ability ?? ""));
      if (!saveAbility) {
        return why(`"${item.name}" has a save activity with NO ability set on it - `
          + `open the item, find the save activity, and choose Dexterity/Constitution/etc.`);
      }

      let saveDC = save.dc?.value ?? save.dc ?? 0;
      if (!(Number(saveDC) > 0)) {
        const sysDC = Situation.readCreature(actor)?.spellDC || null;
        saveDC = Number(sysDC) > 0 ? Number(sysDC) : 10;
      }

      let spellLevel = null;
      try {
        if (item.type === "spell" && Number.isFinite(Number(item.system?.level))) {
          spellLevel = Number(item.system.level);
        }
      } catch (_) { /* non-fatal */ }

      return {
        activity, item, actor,
        saveAbility, saveDC,
        halfOnSave: this._detectHalfDamage(item, activity),
        damageTypes: CombatState._getItemDamageTypes(item, activity),
        isSpell: item.type === "spell",
        timing: getSpellTiming(item),
        activityId: activity.id,
        spellLevel,
      };
    } catch (err) {
      console.warn(`${MODULE_ID} | could not rebuild a pending save from template ${templateDoc?.id}:`, err);
      return null;
    }
  }

  async _onTemplateCreated(templateDoc) {
    console.log(`${MODULE_ID} | _onTemplateCreated fired, pending save:`, !!this._pendingSaveSpell, "pending movement-damage:", !!this._pendingMovementDamageSpell);

    // v0.6.5: Movement-damage spell waiting for template (Spike Growth,
    // Wall of Thorns, etc.). Fire the persistent hook with no-save
    // metadata so concentration-widget tracks it for the Phase 2
    // movement-distance damage flow.
    if (this._pendingMovementDamageSpell && !this._pendingSaveSpell) {
      const pending = this._pendingMovementDamageSpell;
      this._pendingMovementDamageSpell = null;
      Hooks.callAll("ace-qol.persistentSpellCreated", {
        item: pending.item,
        actor: pending.actor,
        templateDoc,
        timing: pending.timing,
        saveAbility: null,        // no save = movement-damage variant
        saveDC: null,
        halfOnSave: false,
        damageTypes: pending.damageTypes,
        damageFormula: pending.damageFormula,
        tokens: [],
      });
      console.log(`${MODULE_ID} | Movement-damage "${pending.item.name}" — emitted ace-qol.persistentSpellCreated (no-save variant, formula: ${pending.damageFormula})`);
      return;
    }

    // ⚠️ THE PENDING SAVE LIVES ON ONE CLIENT; THE TEMPLATE IS PROCESSED ON
    // ANOTHER. Split-brain, proven live 2026-08-15.
    //
    // `_pendingSaveSpell` is set by dnd5e's postCreateUsageMessage hook, which
    // fires ONLY on the client that performed the cast. This handler runs ONLY
    // on the activeGM's client. With one GM connected those are the same
    // machine and everything works — which is why every solo test passed. The
    // moment a second GM is connected (Johnny's idle session left open in his
    // room, or my tester account), Foundry may crown the OTHER client
    // activeGM: the caster's client holds the pending and is not allowed to
    // process; the activeGM's client processes and finds pending = null; this
    // line returned silently and the whole cast produced nothing. No save
    // card, no targets, and the template never deleted. Same disease as the
    // Ground Level two-writer bug, inverted: state on one client, authority on
    // another.
    //
    // The fix is to stop carrying state between hooks at all when we can help
    // it: dnd5e stamps the originating ACTIVITY's UUID on every template it
    // places (flags.dnd5e.origin). Whichever client processes the template can
    // rebuild everything from that — same item, same activity, same extraction
    // code as the usage-message path. A hand-drawn GM template has no origin
    // flag and is correctly ignored.
    let pending = this._pendingSaveSpell;
    this._pendingSaveSpell = null; // consume it
    if (!pending) {
      pending = this._pendingFromTemplate(templateDoc);
      if (pending) {
        console.log(`${MODULE_ID} | pending save rebuilt from the template's own origin flag (cast happened on another client).`);
      }
    }
    // ⚠️ `_pendingFromTemplate` has already said why it gave up, EXCEPT for a
    // hand-drawn template with no origin flag, which is the one legitimate case.
    // Say that one here so the log always accounts for itself.
    if (!pending) {
      if (!templateDoc?.flags?.dnd5e?.origin) {
        console.log(`${MODULE_ID} | template ${templateDoc?.id} was drawn by hand (no ability behind it) - no save card, as intended.`);
      }
      return;
    }

    // ── Primary: use game.user.targets (GM already targeted who they want) ──
    let tokens = [...game.user.targets];
    console.log(`${MODULE_ID} | game.user.targets: ${tokens.length} tokens:`, tokens.map(t => t.name));

    // ── Fallback: template geometry if GM had nothing targeted ──
    if (!tokens.length) {
      try {
        // ⚠️ WAIT FOR THE SHAPE FIRST. It does not exist yet at this point in the
        // lifecycle — see _awaitTemplateShape. Measuring immediately returns an
        // empty array that reads exactly like an empty battlefield, which is how
        // a cone aimed at a target produced "0 tokens in area — skipping save
        // card" (2026-08-15).
        const ready = await SaveEngine._awaitTemplateShape(templateDoc);
        if (!ready) {
          console.error(`${MODULE_ID} | template ${templateDoc?.id} never produced a shape — ` +
            `cannot determine who is in the area. No save card; this is a FAILURE, not an empty area.`);
          ui.notifications?.warn("ACE QOL: could not read the spell area — nobody was rolled for. See the console.");
          return;
        }
        tokens = SaveEngine._getTokensInTemplate(templateDoc);
        console.log(`${MODULE_ID} | _getTokensInTemplate found ${tokens.length} tokens:`, tokens.map(t => t.name));
      } catch (err) {
        console.error(`${MODULE_ID} | _getTokensInTemplate FAILED:`, err);
      }
    }

    // Store template reference
    pending.templateDoc = templateDoc;

    const { item, actor, saveAbility, saveDC, halfOnSave, damageTypes, isSpell, timing, activityId } = pending;

    // ── Exclude the caster from the auto-targeted list ──
    // Foundry / dnd5e auto-targets every token an AOE template touches when
    // it lands. If the caster is standing inside their own AOE (Lightning
    // Bolt line origin, Fireball self-cast, etc.) they show up in the save
    // list. RAW the caster CAN target themselves with most damage AOEs, but
    // 99% of the time the GM doesn't want it. Filter them out by default;
    // the GM can re-add via "+ TARGET SELECTED" button if intentional.
    if (QolSettings.get?.("excludeCasterFromTemplates") !== false) {
      const before = tokens.length;
      tokens = tokens.filter(t => t.actor?.id !== actor?.id);
      const after = tokens.length;
      if (before !== after) {
        console.log(`${MODULE_ID} | Excluded caster ${actor?.name} from save targets (${before} → ${after})`);
      }
    }

    // ⚠️ SAY WHO THE HEIGHT RULE TOOK OUT. The area hit-test understands
    // elevation as of 2026-08-28, and it can only ever REMOVE creatures. A flyer
    // that gets no save card looks exactly like ACE forgetting it, so the two
    // numbers that decided it go on screen. Cast time only: the same exclusion
    // happens on every walk-in and would bury the log.
    try {
      const { ElevationGate } = await import("./rules/elevation-gate.mjs");
      const outOfReach = ElevationGate.findOutOfReach(
        templateDoc, tokens, CombatState.getActiveEdition, actor);
      if (outOfReach.length) {
        await ElevationGate.postOutOfReachCard(item, actor, outOfReach);
        console.log(`${MODULE_ID} | ${outOfReach.length} creature(s) were over "${item.name}" `
          + `but outside it vertically: `
          + outOfReach.map(o => `${o.token.name} at ${o.feet} feet`).join(", "));
      }
    } catch (err) {
      console.warn(`${MODULE_ID} | out-of-reach report failed (non-blocking):`, err);
    }

    console.log(`${MODULE_ID} | Template resolved: spell="${item.name}", timing=`, timing, `isInstant=${timing?.isInstant}, tokens=${tokens.length}`);

    if (timing?.isInstant) {
      // ── Instant spell (Fireball, etc.) — post target card immediately ──
      // v0.6.1: empty-targets bail moved INSIDE this branch. For instant
      // spells, no targets = no card. For PERSISTENT spells (Moonbeam,
      // Spike Growth, etc.), an empty area at cast time is the NORMAL
      // case — they're cast on the ground waiting for tokens to enter.
      // The previous bail above this `if` was preventing
      // `persistentSpellCreated` from firing, so the concentration
      // widget never tracked persistent spells with empty initial areas.
      if (!tokens.length) {
        console.warn(`${MODULE_ID} | Instant ${item.name}: 0 tokens in area — skipping save card`);
        // ⚠️ DELETE THE TEMPLATE ANYWAY (2026-08-15). Auto-delete only ran
        // downstream of a POSTED card, so every skipped cast leaked its
        // template onto the scene — with template visuals hidden, as an
        // invisible one the GM cannot even see to clean up. An empty area
        // still consumes the template: the spell happened, it just hit nobody.
        await this._deleteInstantTemplate({
          timingType: timing?.timing ?? TIMING.INSTANT,
          templateDocId: templateDoc.id,
          templateSceneId: templateDoc.parent?.id ?? canvas.scene?.id,
        });
        return;
      }
      console.log(`${MODULE_ID} | Posting instant save card for ${item.name} → ${tokens.length} targets`);
      await this._postLiveTargetCard(item, actor, tokens, {
        saveAbility, saveDC, halfOnSave, damageTypes, isSpell, timing, activityId, templateDoc,
      });
      console.log(`${MODULE_ID} | Instant save card posted successfully`);

      // Release the auto-targeting reticles now the card owns its own target
      // snapshot. dnd5e auto-targets every token under an AOE template; without
      // this, the green/red brackets stick on the whole cube after the cast
      // resolves (Faerie Fire, Fireball, etc.). Safe: the card + every save roll
      // read the card's stored snapshot, NOT game.user.targets — same cleanup
      // the picker flow already does.
      this._releaseUserTargets();

    } else {
      // ── Persistent spell (Moonbeam, Spirit Guardians, etc.) ──
      // Emit hook for concentration widget — fires REGARDLESS of whether
      // any tokens are currently in the area. The widget needs to track
      // the spell so it can fire the entry-trigger save card later when
      // a token walks in.
      Hooks.callAll("ace-qol.persistentSpellCreated", {
        item, actor, templateDoc, timing, saveAbility, saveDC,
        halfOnSave, damageTypes, tokens,
      });

      console.log(`${MODULE_ID} | Persistent spell "${item.name}" — emitted ace-qol.persistentSpellCreated (${tokens.length} tokens initially in area)`);

      // If timing includes "enter" trigger, post initial save for tokens already in area.
      //
      // EXCEPTION: area-denial family (Stinking Cloud, Cloudkill, etc.) — these
      // are handled by the concentration widget, which auto-rolls entry saves
      // for initial-in-area tokens via _onPersistentSpellCreated. Posting the
      // manual TARGETED/SELECTED card here would be duplicate noise.
      const triggerOnEnter = timing.timing === TIMING.ENTER_START
                          || timing.timing === TIMING.ENTER_END;
      const isAreaDenial = timing?.family === "areaDenial";

      if (triggerOnEnter && tokens.length && !isAreaDenial) {
        await this._postLiveTargetCard(item, actor, tokens, {
          saveAbility, saveDC, halfOnSave, damageTypes, isSpell, timing, activityId,
          persistentInitial: true,
        });
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Detect "Half Damage on Save"
  // ═══════════════════════════════════════════════════════════════════════════

  _detectHalfDamage(item, activity) {
    // Check activity data first
    if (activity.damage?.onSave === "half") return true;

    // Check item description for common phrases
    const desc = (item.system?.description?.value ?? "").toLowerCase();
    if (desc.includes("half as much damage") || desc.includes("half damage")
     || desc.includes("takes half") || desc.includes("save for half")) {
      return true;
    }

    return false;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Live Target Card — NPC/PC split, remove buttons, roll trigger
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * v0.6.0 — Public-facing alias for `_postLiveTargetCard`. The leading
   * underscore on the original signals "internal use only," but the
   * persistent-template tracker (and any future external module) needs a
   * stable, non-underscore entry point. Both names resolve to the same
   * implementation; this alias is the recommended API for cross-module
   * callers.
   *
   * Same args/return as `_postLiveTargetCard`.
   */
  async postSaveCard(item, actor, tokens, opts) {
    return this._postLiveTargetCard(item, actor, tokens, opts);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Public cast announcement + auto-generated effect line
  // ═══════════════════════════════════════════════════════════════════════════
  //
  //  Johnny 2026-07-11: a player-cast save spell was landing SILENTLY in chat —
  //  the "who must save" card was whispered to the GM only, so the caster saw a
  //  token animation and nothing else and assumed the spell had failed. Every
  //  save card is now PUBLIC and leads with a plain-English "X casts Y on Z"
  //  banner plus a one-line summary of what a failed save costs, so the whole
  //  table always sees what was cast and on whom.

  /** "Steel Defender" · "A and B" · "A, B, and C" · "5 creatures". Dedupes by
   *  name so five identical goblins read as "5 creatures", not a wall of names. */
  _formatTargetNames(targets) {
    try {
      const names = (targets ?? [])
        .map(t => t?.name ?? t?.actor?.name ?? t?.document?.name)
        .filter(Boolean);
      const uniq = [...new Set(names)];
      if (!uniq.length) return "";
      if (uniq.length === 1) return uniq[0];
      if (uniq.length === 2) return `${uniq[0]} and ${uniq[1]}`;
      if (uniq.length === 3) return `${uniq[0]}, ${uniq[1]}, and ${uniq[2]}`;
      return `${uniq.length} creatures`;
    } catch (_) { return ""; }
  }

  /** Slim banner: "🪄 Chudd casts Frostbite on Steel Defender". Shared by the
   *  save card AND the results/damage card so the announcement survives the
   *  target-card collapse and the two cards read as one continuous story. */
  _castAnnouncementHtml(item, casterActor, targets, activityId = null) {
    const caster = casterActor?.name ?? "Someone";
    const spell  = this._abilityLabel(item, activityId);
    const tgts   = this._formatTargetNames(targets);
    return `<div class="ace-qol-save-cast-line">`
      + `<i class="fas fa-wand-magic-sparkles"></i> `
      + `<strong>${caster}</strong> casts <strong>${spell}</strong>`
      + `${tgts ? ` on <strong>${tgts}</strong>` : ""}`
      + `</div>`;
  }

  /** One concise, RAW-accurate line describing what a FAILED save costs.
   *  Hand-tuned wording for the spells that come up most; everything else
   *  auto-generates from the spell's own damage types + applied-effect names.
   *  Returns "" when we can't say anything reliable — better a clean omission
   *  than a wrong summary. Edition-neutral phrasing. */
  _effectSummaryLine(item, opts = {}) {
    try {
      const { halfOnSave, damageTypes } = opts;
      const key = String(item?.name ?? "").toLowerCase().trim();

      // Hand-tuned blurbs (read after "On a failed save: ").
      const BLURBS = {
        "frostbite":                 "cold damage, and disadvantage on its next weapon attack before its next turn",
        "ray of frost":              "cold damage, and its speed drops by 10 feet",
        "hold person":               "Paralyzed — it repeats the save at the end of each of its turns",
        "hold monster":              "Paralyzed — it repeats the save at the end of each of its turns",
        "command":                   "it obeys a one-word command on its next turn",
        "vicious mockery":           "psychic damage, and disadvantage on its next attack roll",
        "toll the dead":             "necrotic damage (a d12 if it's already wounded)",
        "sacred flame":              "radiant damage (ignores cover)",
        "tasha's hideous laughter":  "Prone and Incapacitated, laughing helplessly",
        "hideous laughter":          "Prone and Incapacitated, laughing helplessly",
        "fear":                      "it drops what it's holding and is Frightened",
        "suggestion":                "it follows a reasonable suggested course of action",
        "fireball":                  "fire damage",
        "poison spray":              "poison damage",
        "mind sliver":               "psychic damage, and subtracts 1d4 from its next save",
        "banishment":                "it is Banished to another plane",
        "blindness/deafness":        "Blinded (or Deafened)",
        "bane":                      "it subtracts 1d4 from attacks and saves",
      };
      if (BLURBS[key]) {
        return `On a failed save: ${BLURBS[key]}`
             + `${halfOnSave ? " (half as much on a success)" : ""}.`;
      }

      // Structured fallback — damage types + any condition the item's own
      // effects will apply.
      const parts = [];
      const types = [...new Set((damageTypes ?? []).filter(t => t && t !== "none"))];
      if (types.length) parts.push(`${types.join("/")} damage`);
      const condNames = [...new Set((item?.effects ?? [])
        .filter(e => e && e.disabled !== true)
        .map(e => String(e.name ?? "").trim())
        .filter(Boolean)
        .filter(n => n.toLowerCase() !== key))];
      if (condNames.length) parts.push(condNames.join(", "));
      if (!parts.length) return "";
      let line = `On a failed save: ${parts.join("; ")}`;
      if (halfOnSave && types.length) line += " (half as much on a success)";
      return line + ".";
    } catch (_) { return ""; }
  }

  async _postLiveTargetCard(item, actor, tokens, opts) {
    // ⚠️🔴 THE LAST DOOR, GUARDED BECAUSE TWO EARLIER ONES WERE NOT ENOUGH.
    // Colour Spray's phantom Constitution save got past a guard at the arming
    // site by being REBUILT from the template's origin flag. Both of those are
    // fixed, and this is the single function every save card comes through, so
    // it asks the same question one last time. A spell that resolves by a
    // hit-point pool has no saving throw to show, whatever route got here.
    if (SaveEngine._isPoolSpell(item)) {
      console.warn(`${MODULE_ID} | refused to post a save card for "${item?.name}": `
        + `it resolves by a hit-point pool and has no saving throw. Something `
        + `upstream still thinks it does — worth finding.`);
      return;
    }

    // v0.4.22.4: Pace the save card behind the spell/feat animation.
    // Without this delay the save card can land 1-2 seconds before the
    // visual effect, eating the dramatic beat. Configurable via
    // `saveCardDelayAfterCastMs` (default 1500ms; set 0 to disable).
    //
    // v0.6.2: `opts.skipDelay === true` bypasses the pacing entirely.
    // Used by entry-trigger saves (Moonbeam token-walked-in) where the
    // animation has already played; an additional 1.5s wait would feel
    // like the system stalled.
    if (!opts?.skipDelay) {
      try {
        const delay = Number(QolSettings.get?.("saveCardDelayAfterCastMs") ?? 1500);
        if (Number.isFinite(delay) && delay > 0) {
          await new Promise(r => setTimeout(r, delay));
        }
      } catch (_) { /* setting unavailable — proceed without delay */ }
    }

    const { saveAbility, saveDC, halfOnSave: rawHalfOnSave, damageTypes, isSpell, timing, activityId, spellLevel } = opts;
    const abilityLabel = CONFIG.DND5E?.abilities?.[saveAbility]?.label ?? saveAbility.toUpperCase();

    // ── Gate the HALF ON SAVE badge on actual damage presence ──
    // Some 2024 spell activities default `damage.onSave: "half"` even when
    // there are no damage parts (Hold Person, Charm Person, etc. were
    // showing a bogus "HALF ON SAVE" badge). The badge should only appear
    // when the spell ACTUALLY deals damage that gets halved.
    const hasDamage = Array.isArray(damageTypes) && damageTypes.length > 0
                   && damageTypes.some(t => t && t !== "none");
    const halfOnSave = rawHalfOnSave && hasDamage;

    // Assess all targets
    const targetData = [];
    for (const token of tokens) {
      const state = CombatState.assess(actor, token, item, {
        saveAbility, isSpell, damageTypes,
      });
      if (!state) continue;

      const isPC = SaveEngine.isPlayerCharacter(token.actor);
      // Save modifier via the target profile — ONE reader for a fact that
      // was being decoded seven different ways in this file alone.
      const saveMod = SaveEngine._targetProfileFor(token.actor, { tokenDocId: token?.document?.id, sceneId: token?.scene?.id })?.saveMod(saveAbility) ?? 0;

      // Sum numeric save bonuses (Aura of Protection, ability-specific bonus,
      // cover) into the displayed mod. Non-numeric bonuses (Bless's "+1d4")
      // stay in saveBonuses for the roll formula but don't fold into the
      // shown number — they get rendered as separate badges if the card
      // chooses to display them.
      const numericBonusTotal = (state.saveBonuses ?? []).reduce((sum, b) => {
        const raw = String(b?.value ?? "").replace(/^\+/, "").trim();
        const n = Number(raw);
        return Number.isFinite(n) ? sum + n : sum;
      }, 0);
      const effectiveMod = saveMod + numericBonusTotal;
      const modStr = effectiveMod >= 0 ? `+${effectiveMod}` : `${effectiveMod}`;

      targetData.push({
        tokenId: token.id,
        tokenDocId: token.document?.id ?? token.id,
        actorId: token.actor?.id,
        sceneId: canvas.scene?.id,
        name: state.target.name,
        img: state.target.img,
        isPC,
        saveMod: modStr,
        saveModBase: saveMod,
        saveModBonus: numericBonusTotal,
        saveAbilityUpper: saveAbility.toUpperCase(),
        autoFailSave: state.autoFailSave,
        saveAdvantage: state.saveAdvantage,
        saveDisadvantage: state.saveDisadvantage,
        superSaver: state.superSaver,
        semiSuperSaver: state.semiSuperSaver,
        saveBonuses: state.saveBonuses,
        damageModifiers: state.damageModifiers,
        currentHP: state.target.currentHP,
        maxHP: state.target.maxHP,
        // For owners — which players own this PC
        // ASK, don't reconstruct — see SaveEngine.ownerUserIds. Walking the
        // ownership record missed every actor owned through the DEFAULT level,
        // and an empty whisper list means PUBLIC. (audit F-020)
        ownerIds: isPC ? SaveEngine.ownerUserIds(token.actor) : [],
      });
    }

    if (!targetData.length) return;

    // ── Split into NPCs and PCs ──
    const npcs = targetData.filter(t => !t.isPC);
    const pcs = targetData.filter(t => t.isPC);

    // ── Helper: determine worst damage modifier for color-coding ──
    const _getDmgIndicator = (t) => {
      if (!t.damageModifiers || !damageTypes?.length) return { cls: "", tag: "" };
      // Check each spell damage type against this target's modifiers
      let hasImmune = false, hasResist = false, hasVuln = false;
      for (const dtype of damageTypes) {
        const mod = t.damageModifiers[dtype];
        if (mod?.modifier === "immune") hasImmune = true;
        else if (mod?.modifier === "resistant") hasResist = true;
        else if (mod?.modifier === "vulnerable") hasVuln = true;
      }
      // Immune takes priority, then resist, then vuln
      if (hasImmune) return { cls: "ace-qol-tgt-immune", tag: '<span class="ace-qol-tag ace-qol-tag-immune"><i class="fas fa-shield-halved"></i> IMMUNE</span>' };
      if (hasResist) return { cls: "ace-qol-tgt-resist", tag: '<span class="ace-qol-tag ace-qol-tag-resist"><i class="fas fa-shield-halved"></i> RESIST</span>' };
      if (hasVuln) return { cls: "ace-qol-tgt-vuln", tag: '<span class="ace-qol-tag ace-qol-tag-vuln"><i class="fas fa-burst"></i> VULN</span>' };
      return { cls: "", tag: "" };
    };

    // ── Helper: render save mod breakdown ──
    // Returns HTML showing base mod + each bonus as a chip with attribution.
    // Example: "DEX +0  [+3 Aura]  [+1d8 BI]"
    // Players see exactly which buffs are contributing — no hidden math.
    // Skips 0-value / empty / non-meaningful bonus entries so we don't show
    // useless chips like "0 DEX bonus".
    const _renderModBreakdown = (t) => {
      // (footnote builder lives at SaveEngine._modFootnote — see below)
      const baseStr = t.saveModBase >= 0 ? `+${t.saveModBase}` : `${t.saveModBase}`;
      const bonusChips = (t.saveBonuses ?? [])
        .filter(b => {
          const raw = String(b?.value ?? "").trim();
          if (!raw) return false;
          // Reject literal "+0" / "-0" / "0" — those add nothing
          const stripped = raw.replace(/^\+/, "").replace(/^0+(?=\d|$)/, "0");
          if (stripped === "0" || stripped === "-0" || stripped === "") return false;
          // Numeric? Skip if zero. Non-numeric (like "+1d4") always rendered.
          const n = Number(stripped);
          if (Number.isFinite(n) && n === 0) return false;
          return true;
        })
        .map(b => {
          const v = String(b?.value ?? "").trim();
          const vDisplay = v.startsWith("+") || v.startsWith("-") ? v : `+${v}`;
          const label = String(b?.label ?? "Bonus").trim();
          const shortLabel = label
            .replace(/^Aura of Protection$/i, "Aura")
            .replace(/^Aura of Warding$/i, "Warding")
            .replace(/^Bardic Inspiration$/i, "BI")
            .replace(/^Resistance$/i, "Resist")
            .replace(/^Heroes' Feast$/i, "Feast");
          return `<span class="ace-qol-save-bonus-chip" title="${label}">${vDisplay} ${shortLabel}</span>`;
        }).join("");
      return `<span class="ace-qol-save-tgt-mod">${t.saveAbilityUpper} ${baseStr}</span>${bonusChips}`;
    };

    // ── Helper: glowing black-d20 ROLL button for a PC (GM rolls on their behalf) ──
    // Lives in the LEFT column directly under the portrait. Keeps the
    // .ace-qol-save-pc-roll-btn class + data-action/data-token-doc-id so the
    // existing click wiring and post-roll DOM updates still target it.
    const _pcDiceBtn = (t) => `
      <button class="ace-qol-save-pc-roll-btn" data-action="aceQolGmRollPcSave" data-token-doc-id="${t.tokenDocId}" title="Roll save on this PC's behalf (GM)"
              style="background:none;border:none;cursor:pointer;padding:0;display:inline-flex;">
        ${aceD20FaceImg(20, { size: 40, glow: true })}
      </button>`;

    // ── Helper: status badges (auto-fail / evasion / damage indicator) ──
    const _renderBadges = (t) => {
      const di = _getDmgIndicator(t);
      const badges = [
        t.autoFailSave ? '<span class="ace-qol-tag ace-qol-tag-danger"><i class="fas fa-circle-xmark"></i> AUTO-FAIL</span>' : "",
        t.superSaver ? '<span class="ace-qol-tag ace-qol-tag-buff"><i class="fas fa-person-running"></i> EVASION</span>' : "",
        di.tag,
      ].filter(Boolean).join("");
      return badges ? `<div class="ace-qol-save-tgt-actions" style="margin-top:4px;">${badges}</div>` : "";
    };

    // ── Build NPC rows ──
    // data-pc="false" is REQUIRED for the "all rolled" reconciliation check
    // at line ~2692 (querySelector ".ace-qol-save-tgt-row[data-pc='false']").
    // Without it, NPC rows can't be counted as pending → button false-positives
    // to "ALL ROLLED" as soon as PCs are done.
    const npcRowsHtml = npcs.map(t => {
      const di = _getDmgIndicator(t);
      return `
      <div class="ace-qol-save-tgt-row ${di.cls}" data-token-id="${t.tokenId}" data-pc="false"
           style="display:flex;align-items:flex-start;gap:12px;padding:10px 12px;">
        <img src="${t.img || "icons/svg/mystery-man.svg"}" class="ace-qol-save-tgt-img"
             style="width:46px;height:46px;border-radius:8px;flex-shrink:0;border:1px solid #555;object-fit:cover;" />
        <div class="ace-qol-save-tgt-identity" style="flex:1;min-width:0;">
          <div style="display:flex;align-items:center;gap:8px;">
            <span class="ace-qol-save-tgt-name" style="flex:1;font-weight:bold;color:#fff;font-size:16px;">${t.name}</span>
            <button class="ace-qol-save-tgt-remove" data-action="aceQolRemoveTarget" data-token-id="${t.tokenId}"><i class="fas fa-xmark"></i></button>
          </div>
          <div style="margin-top:3px;">${_renderModBreakdown(t)}</div>
          ${_renderBadges(t)}
        </div>
      </div>
    `}).join("");

    // ── Build PC rows (with GM dice icon to roll on their behalf + X to remove) ──
    // data-pc="true" for symmetry + future use; the "all rolled" check uses
    // .ace-qol-save-pc-roll-btn:not([disabled]) for PC pending state.
    const pcRowsHtml = pcs.map(t => {
      const di = _getDmgIndicator(t);
      return `
      <div class="ace-qol-save-tgt-row ace-qol-save-tgt-pc ${di.cls}" data-token-id="${t.tokenId}" data-token-doc-id="${t.tokenDocId}" data-actor-id="${t.actorId}" data-pc="true"
           style="display:flex;align-items:flex-start;gap:12px;padding:10px 12px;">
        <div style="display:flex;flex-direction:column;align-items:center;gap:6px;flex-shrink:0;">
          <img src="${t.img || "icons/svg/mystery-man.svg"}" class="ace-qol-save-tgt-img"
               style="width:46px;height:46px;border-radius:8px;border:1px solid #d4af37;object-fit:cover;" />
          ${_pcDiceBtn(t)}
        </div>
        <div class="ace-qol-save-tgt-identity" style="flex:1;min-width:0;">
          <div style="display:flex;align-items:center;gap:8px;">
            <span class="ace-qol-save-tgt-name" style="flex:1;font-weight:bold;color:#fff;font-size:16px;">${t.name}</span>
            <button class="ace-qol-save-tgt-remove" data-action="aceQolRemoveTarget" data-token-id="${t.tokenId}" title="Remove this PC from the save list"><i class="fas fa-xmark"></i></button>
          </div>
          <div style="margin-top:3px;">${_renderModBreakdown(t)}</div>
          ${_renderBadges(t)}
        </div>
      </div>
    `}).join("");

    // ── Assemble card ──
    const _actName   = this._abilityLabel(item, activityId, { rawOnly: true });
    const _hasPower  = !!_actName;
    const _cardTitle = this._abilityLabel(item, activityId);
    const _effectLine = this._effectSummaryLine(item, { halfOnSave, damageTypes });
    const cardHtml = `
      <div class="ace-qol-save-card">
        ${this._castAnnouncementHtml(item, actor, tokens, activityId)}
        <div class="ace-qol-save-header">
          <img src="${item.img || "icons/svg/spell.svg"}" class="ace-qol-save-item-img" />
          <div>
            <strong class="ace-qol-save-item-name">${_cardTitle}</strong>
            ${_hasPower ? `<span class="ace-qol-save-subname" style="display:block;font-size:11px;color:#b9a978;font-weight:600;">${item.name}</span>` : ""}
            <span class="ace-qol-save-dc">DC ${saveDC} ${abilityLabel} Save</span>
          </div>
          ${halfOnSave ? '<span class="ace-qol-save-half-badge">HALF ON SAVE</span>' : ""}
        </div>
        ${_effectLine ? `<div class="ace-qol-save-effect-line"><i class="fas fa-angle-right"></i> ${_effectLine}</div>` : ""}

        ${npcs.length ? `
          <div class="ace-qol-save-tgt-section">
            ${npcRowsHtml}
          </div>
        ` : ""}

        ${pcs.length ? `
          <div class="ace-qol-save-tgt-section ace-qol-save-tgt-section-pc">
            ${pcRowsHtml}
          </div>
        ` : ""}

        ${this._modFootnote([...(npcs ?? []), ...(pcs ?? [])])}

        <div class="ace-qol-save-actions ace-qol-gm-only">
          <button class="ace-qol-btn ace-qol-btn-roll" data-action="aceQolRollNpcSaves">
            <i class="fas fa-dice-d20"></i> ${
              npcs.length > 0 && pcs.length > 0 ? "ROLL NPC SAVES + PROMPT PCs" :
              npcs.length > 0                    ? "ROLL NPC SAVES" :
                                                   "PROMPT PCs TO ROLL"
            }
          </button>
        </div>
      </div>
    `;

    // Decided BEFORE the card exists, because the claim is stamped into it.
    const _iAmActiveGM  = game.users?.activeGM === game.user;
    const _autoRollOn   = QolSettings.get?.("autoRollNpcSaves") !== false;
    const _iDriveTheCard = _autoRollOn && _iAmActiveGM;

    const targetListMsg = await ChatMessage.create({
      content: cardHtml,
      speaker: ChatMessage.getSpeaker({ actor }),
      // PUBLIC (Johnny 2026-07-11): the whole table sees who cast what on whom.
      // GM-only controls inside the card are gated with .ace-qol-gm-only; the
      // GM (message author) still owns every message.update() that fills in
      // results, so players see the card update live but can't edit it.
      flags: {
        [MODULE_ID]: {
          type: "saveTargetList",
          // THE CLAIM, STAMPED AT BIRTH (2026-07-28). This flow drives the
          // results card itself, in order, after resolving the saves it owns.
          // The claim has to live IN the message: a flag set after creation can
          // lose to this card's own render, which is precisely the kind of race
          // being removed here. The render hook stands down when it sees this,
          // and takes over only if driving fails and clears it.
          gmDrivesResults: _iDriveTheCard,
          itemId: item.id,
          itemUuid: item.uuid,
          actorId: actor.id,
          // WHICH BODY CAST IT. An actor id alone cannot pick one of nine
          // goblins apart, and cover is measured from a position. Stamped here,
          // at the cast, where the answer is still exact. (audit F-019)
          casterTokenDocId: SaveEngine.casterTokenDoc(actor, { sceneId: canvas.scene?.id })?.id ?? null,
          saveAbility,
          saveDC,
          halfOnSave,
          damageTypes,
          isSpell,
          activityId,
          spellLevel: Number.isFinite(spellLevel) ? spellLevel : null,
          timingType: timing?.timing ?? TIMING.INSTANT,
          targets: targetData,
          persistentInitial: opts.persistentInitial ?? false,
          templateDocId:   opts.templateDoc?.id ?? null,
          templateSceneId: opts.templateDoc?.parent?.id ?? null,
        }
      }
    });

    // Use target list message ID as unique cast identifier
    const castId = targetListMsg.id;

    // ── Send PC save prompts — but if a PC's owner is OFFLINE, the GM rolls it
    //    on their behalf immediately so the save never hangs (Johnny 2026-07-13:
    //    "the GM must always be able to roll for absent players, across all
    //    saves"). The manual roll-on-behalf die stays on the card for online
    //    PCs too, so the GM can still roll for a present player if they want.
    // ── NO TARGET MAY DEAD-END THE CAST (2026-07-28) ──
    // This loop was unguarded. When the offline auto-roll threw (a ReferenceError
    // that shipped in the profile conversion), the exception escaped the loop and
    // killed the REST of this method — so the save never rolled, no prompt was
    // sent, the 30s GM nudge was never armed (it's armed inside _sendPcSavePrompt),
    // and the template was never cleaned up. One bad target, whole cast dead, and
    // the card just sat on "WAITING FOR PLAYER" with nothing coming.
    //
    // Now: each target is isolated, and a failed auto-roll FALLS BACK to a prompt
    // — which arms the nudge, so the GM always gets a "ROLL FOR THEM" card. There
    // is no path from here that leaves the table with nothing to click.
    const _promptOpts = { saveAbility, saveDC, halfOnSave, damageTypes, isSpell, castId };

    // ── RESOLVE FIRST, RENDER ONCE (2026-07-28 rebuild) ──
    // The results card used to be fired independently by this card's RENDER
    // hook, while these rolls were still running. Two async paths reconciling
    // through the chat log: the card searched for results that hadn't been
    // posted yet, showed WAITING FOR PLAYER, and the answer arrived a beat
    // later. Hence a card that flickered from "waiting" to a result nobody was
    // ever actually waiting for.
    //
    // The claim is already stamped into the card (gmDrivesResults), so the
    // render hook has stood down. Resolve every save we are responsible for,
    // hand the results over DIRECTLY, and only then build the card. A save
    // nobody is waiting on is never rendered as waiting, because by the time
    // the card exists it is already answered.
    this._autoRolledSaves ??= new Set();
    if (_iDriveTheCard) this._autoRolledSaves.add(targetListMsg.id);

    const gmRolledPcResults = {};   // tokenDocId → resolved result, handed over directly
    for (const tgt of pcs) {
      try {
        // THE GATE, before a human is ever asked to pick up a die.
        const _pcVerdict = SaveEngine._verdictForTargetRow(tgt);
        if (_pcVerdict) {
          console.log(`${MODULE_ID} | GATE: ${tgt.name} (PC) — ${_pcVerdict.reason.toUpperCase()}, no prompt sent.`);
          gmRolledPcResults[tgt.tokenDocId] = SaveEngine._noRollRow(tgt, _pcVerdict, { isPC: true });
          continue;
        }
        if (_iAmActiveGM && !this._pcOwnerActive(tgt)) {
          console.log(`${MODULE_ID} | PC "${tgt.name}" owner is offline — GM rolling their save now, before the card is built.`);
          const res = await this._gmRollPcSaveOffline(item, actor, tgt, _promptOpts);
          if (res?.tokenDocId) gmRolledPcResults[res.tokenDocId] = res;
          continue;
        }
        // Owner is connected — this one legitimately waits on a human.
        await this._sendPcSavePrompt(item, actor, tgt, _promptOpts);
      } catch (err) {
        console.error(`${MODULE_ID} | PC save routing failed for "${tgt.name}" — falling back to a prompt so the cast can't dead-end:`, err);
        try {
          await this._sendPcSavePrompt(item, actor, tgt, _promptOpts);
        } catch (err2) {
          console.error(`${MODULE_ID} | Fallback prompt ALSO failed for "${tgt.name}":`, err2);
          ui.notifications?.error(`ACE: couldn't route ${tgt.name}'s save — roll it manually.`);
        }
      }
    }

    // Park them on this card too, so a reload or a re-render can rebuild the
    // results without going back to the chat log for them.
    if (Object.keys(gmRolledPcResults).length) {
      try { await targetListMsg.setFlag(MODULE_ID, "gmRolledPcResults", gmRolledPcResults); }
      catch (err) { console.warn(`${MODULE_ID} | couldn't park GM-rolled PC results on the cast card:`, err); }
    }

    // Everything we own is now answered — build the card.
    if (_iDriveTheCard) {
      try {
        await this._rollNpcSavesFromTargetList(targetListMsg, gmRolledPcResults);
        await targetListMsg.setFlag(MODULE_ID, "rolled", true);
      } catch (err) {
        console.error(`${MODULE_ID} | driving the save results card failed:`, err);
        // Hand the card BACK to the render hook rather than stranding the cast:
        // release both the in-memory claim and the stamped one, so the fallback
        // fires on the next render.
        this._autoRolledSaves.delete(targetListMsg.id);
        try { await targetListMsg.setFlag(MODULE_ID, "gmDrivesResults", false); } catch (_) { /* best effort */ }
      }
    }

    // ── Auto-delete the AOE template ──
    // Originally fired only on ROLL SAVES click — but if the GM let PCs
    // roll via individual dice icons OR the cast just sat there, the
    // template lingered indefinitely. Now fires after a 1.5s delay (gives
    // Sequencer/AA spell animations time to play through) right after
    // the target list lands. Persistent spells (Moonbeam, Spirit Guardians,
    // etc.) bail inside _deleteInstantTemplate via the timingType check.
    if (timing?.isInstant && opts.templateDoc) {
      const flagsForDelete = {
        timingType: TIMING.INSTANT,
        templateDocId: opts.templateDoc.id,
        templateSceneId: opts.templateDoc.parent?.id,
      };
      setTimeout(() => {
        this._deleteInstantTemplate(flagsForDelete).catch(err =>
          console.warn(`${MODULE_ID} | post-target-list template delete threw:`, err)
        );
      }, 1500);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Legacy Save Prompt Card (kept for backward compat)
  // ═══════════════════════════════════════════════════════════════════════════

  async _postSaveCard(item, actor, targetStates, opts) {
    const { saveAbility, saveDC, halfOnSave: rawHalfOnSave, damageTypes, isSpell, activityId = null } = opts;
    const abilityLabel = CONFIG.DND5E?.abilities?.[saveAbility]?.label ?? saveAbility.toUpperCase();
    // Same hasDamage gate as _postLiveTargetCard — suppresses bogus
    // "HALF ON SAVE" badge on save-only-condition spells (Hold Person etc.)
    const hasDamage = Array.isArray(damageTypes) && damageTypes.length > 0
                   && damageTypes.some(t => t && t !== "none");
    const halfOnSave = rawHalfOnSave && hasDamage;

    const targetRows = targetStates.map(ts => {
      const tags = [];

      // Auto-fail
      if (ts.autoFailSave) {
        tags.push({ label: "AUTO-FAIL", type: "danger", icon: "fa-circle-xmark" });
      }

      // Save advantage/disadvantage
      for (const reason of (ts.saveAdvReasons ?? [])) {
        tags.push({ label: reason, type: "buff", icon: "fa-arrow-up" });
      }
      for (const reason of (ts.saveDisadvReasons ?? [])) {
        tags.push({ label: reason, type: "debuff", icon: "fa-arrow-down" });
      }

      // Evasion
      if (ts.superSaver) {
        tags.push({ label: "EVASION \u2192 pass = 0 dmg", type: "buff", icon: "fa-person-running" });
      }

      // Legendary resistance
      if (ts.target.legendaryResistance > 0) {
        tags.push({ label: `LEG RESIST: ${ts.target.legendaryResistance}/${ts.target.legendaryResistanceMax}`, type: "legendary", icon: "fa-crown" });
      }

      // Save bonuses
      for (const bonus of (ts.saveBonuses ?? [])) {
        tags.push({ label: `+${bonus.value} (${bonus.label})`, type: "buff", icon: "fa-plus" });
      }

      // Damage modifiers
      for (const [type, mod] of Object.entries(ts.damageModifiers ?? {})) {
        if (mod.modifier === "immune") tags.push({ label: `IMMUNE: ${type}`, type: "immune", icon: "fa-shield" });
        if (mod.modifier === "resistant") tags.push({ label: `RESIST: ${type}`, type: "resistant", icon: "fa-shield-halved" });
        if (mod.modifier === "vulnerable") tags.push({ label: `VULN: ${type}`, type: "vulnerable", icon: "fa-heart-crack" });
      }

      const tagHtml = tags.map(t =>
        `<span class="ace-qol-tag ace-qol-tag-${t.type}"><i class="fas ${t.icon}"></i> ${t.label}</span>`
      ).join("");

      return `
        <div class="ace-qol-save-target">
          <div class="ace-qol-save-target-header">
            <img src="${ts.target.img || "icons/svg/mystery-man.svg"}" class="ace-qol-save-target-img" />
            <span class="ace-qol-save-target-name">${ts.target.name}</span>
            <span class="ace-qol-save-target-mod">
              ${saveAbility.toUpperCase()} save: +${SaveEngine._targetProfileFor(ts.targetActor, ts)?.saveMod(saveAbility) ?? 0}
            </span>
          </div>
          ${tagHtml ? `<div class="ace-qol-atk-tags">${tagHtml}</div>` : ""}
        </div>
      `;
    }).join("");

    const cardHtml = `
      <div class="ace-qol-save-card">
        <div class="ace-qol-save-header">
          <img src="${item.img || "icons/svg/spell.svg"}" class="ace-qol-save-item-img" />
          <div>
            <strong class="ace-qol-save-item-name">${this._abilityLabel(item, activityId)}</strong>
            <span class="ace-qol-save-dc">DC ${saveDC} ${abilityLabel} Save</span>
          </div>
          ${halfOnSave ? '<span class="ace-qol-save-half-badge">HALF ON SAVE</span>' : ""}
        </div>
        <div class="ace-qol-save-targets">
          ${targetRows}
        </div>
        <div class="ace-qol-save-actions">
          <button class="ace-qol-btn ace-qol-btn-roll" data-action="aceQolRollSaves">
            <i class="fas fa-dice-d20"></i> ROLL ALL SAVES
          </button>
        </div>
      </div>
    `;

    await ChatMessage.create({
      content: cardHtml,
      speaker: ChatMessage.getSpeaker({ actor }),
      whisper: [game.user.id],
      flags: {
        [MODULE_ID]: {
          type: "savePrompt",
          itemId: item.id,
          itemUuid: item.uuid,
          actorId: actor.id,
          saveAbility,
          saveDC,
          halfOnSave,
          damageTypes,
          isSpell,
          activityId: opts.activityId,
          targets: targetStates.map(ts => ({
            tokenId: ts.targetToken.id,
            tokenDocId: ts.targetToken.document?.id ?? ts.targetToken.id,
            actorId: ts.targetActor.id,
            sceneId: canvas.scene?.id,
            name: ts.target.name,
            img: ts.target.img,
            autoFailSave: ts.autoFailSave,
            saveAdvantage: ts.saveAdvantage,
            saveDisadvantage: ts.saveDisadvantage,
            superSaver: ts.superSaver,
            semiSuperSaver: ts.semiSuperSaver,
            saveBonuses: ts.saveBonuses,
            damageModifiers: ts.damageModifiers,
            currentHP: ts.target.currentHP,
            maxHP: ts.target.maxHP,
          })),
        }
      }
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Button Wiring — Save Prompt (legacy)
  // ═══════════════════════════════════════════════════════════════════════════

  _wireSavePromptButtons(el, message, flags) {
    const rollBtn = el.querySelector?.("[data-action='aceQolRollSaves']");

    if (rollBtn && !rollBtn.dataset.wired) {
      rollBtn.dataset.wired = "1";
      if (flags.rolled) {
        rollBtn.disabled = true;
        rollBtn.innerHTML = '<i class="fas fa-check"></i> ROLLED \u2713';
      } else {
        rollBtn.addEventListener("click", async () => {
          rollBtn.disabled = true;
          rollBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Rolling...';
          const restoreScroll = this._preserveChatScroll();
          await this._rollAllSaves(message);
          restoreScroll();
          rollBtn.innerHTML = '<i class="fas fa-check"></i> ROLLED \u2713';
          await message.setFlag(MODULE_ID, "rolled", true);
        });
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Button Wiring — Live Target List Card
  // ═══════════════════════════════════════════════════════════════════════════

  _wireTargetListButtons(el, message, flags) {
    // ── TARGETED / SELECTED toggle ──
    const modeBtns = el.querySelectorAll?.(".ace-qol-save-mode-btn");
    if (modeBtns?.length) {
      for (const btn of modeBtns) {
        if (btn.dataset.wired) continue;
        btn.dataset.wired = "1";
        btn.addEventListener("click", () => {
          for (const b of modeBtns) b.classList.remove("active");
          btn.classList.add("active");
          // Toggle between targeted tokens and selected tokens
          const mode = btn.dataset.mode;
          if (mode === "selected") {
            // Re-populate from canvas.tokens.controlled
            this._refreshTargetListFromSelection(message, el);
          }
          // "targeted" mode keeps the original list
        });
      }
    }

    // ── Click portrait/name on target list → select + pan ──
    const tgtImgs = el.querySelectorAll?.(".ace-qol-save-tgt-row .ace-qol-save-tgt-img, .ace-qol-save-tgt-row .ace-qol-save-tgt-name");
    if (tgtImgs?.length) {
      for (const elem of tgtImgs) {
        const row = elem.closest(".ace-qol-save-tgt-row");
        const tokenId = row?.dataset?.tokenId;
        if (!tokenId) continue;
        elem.style.cursor = "pointer";
        elem.addEventListener("click", () => {
          const scene = canvas.scene;
          if (!scene) return;
          const tokenDoc = scene.tokens.get(tokenId);
          const token = tokenDoc?.object;
          if (!token) {
            cannotDo("panning to that creature", "its token is not on this scene");
            return;
          }
          token.control({ releaseOthers: true });
          canvas.animatePan({ x: token.center.x, y: token.center.y, duration: 250 });
        });
      }
    }

    // ── Remove (x) buttons ──
    const removeBtns = el.querySelectorAll?.("[data-action='aceQolRemoveTarget']");
    if (removeBtns?.length) {
      for (const btn of removeBtns) {
        if (btn.dataset.wired) continue;
        btn.dataset.wired = "1";
        btn.addEventListener("click", async () => {
          const tokenId = btn.dataset.tokenId;
          if (!tokenId) return;

          // Remove the row visually
          const row = el.querySelector?.(`.ace-qol-save-tgt-row[data-token-id="${tokenId}"]`);
          if (row) row.remove();

          // Update the message flags
          const currentTargets = message.flags?.[MODULE_ID]?.targets ?? [];
          const updated = currentTargets.filter(t => t.tokenId !== tokenId);
          await message.setFlag(MODULE_ID, "targets", updated);

          // Update section counts
          this._updateSectionCounts(el, updated);
        });
      }
    }

    // ── PC dice buttons (GM rolls for PC on main card) ──
    const pcRollBtns = el.querySelectorAll?.("[data-action='aceQolGmRollPcSave']");
    if (pcRollBtns?.length) {
      // Check for existing PC results to gray out already-rolled PCs (same cast only)
      const thisCastId = message.id;
      // Scan from the cast forward, not a fixed window — see the note in
      // _rollNpcSavesFromTargetList. A result can only follow its own cast.
      const _all = game.messages.contents;
      let _from = _all.findIndex(m => m.id === thisCastId);
      if (_from < 0) _from = Math.max(0, _all.length - 200);
      const recentMsgs = _all.slice(_from);
      const rolledPcs = new Set();
      for (const m of recentMsgs) {
        const f = m.flags?.[MODULE_ID];
        if (f?.type === "pcSaveResult" && f.tokenDocId && f.castId === thisCastId) rolledPcs.add(f.tokenDocId);
      }

      for (const btn of pcRollBtns) {
        if (btn.dataset.wired) continue;
        btn.dataset.wired = "1";

        // If this PC already rolled, show result and disable
        const tokenDocId = btn.dataset.tokenDocId;
        if (rolledPcs.has(tokenDocId)) {
          const existingResult = recentMsgs.find(m => m.flags?.[MODULE_ID]?.type === "pcSaveResult" && m.flags[MODULE_ID].tokenDocId === tokenDocId && m.flags[MODULE_ID].castId === thisCastId);
          if (existingResult) {
            const f = existingResult.flags[MODULE_ID];
            const passClass = f.passed ? "ace-qol-save-pass" : "ace-qol-save-fail";
            const verdictText = f.passed ? "PASS" : "FAIL";
            btn.disabled = true;
            btn.innerHTML = `<span class="ace-qol-save-verdict ${passClass}" style="font-size:13px;font-weight:700;">${verdictText}</span>`;
            btn.style.background = "none"; btn.style.border = "none"; btn.style.padding = "0 4px";
            // Update the mod display with the FULL d20 breakdown (die face + raw +mod = total),
            // bigger + readable — not a tiny bare total.
            const row = btn.closest(".ace-qol-save-tgt-row");
            const modSpan = row?.querySelector(".ace-qol-save-tgt-mod");
            if (modSpan) modSpan.innerHTML = aceInlineRollBreakdown(f, passClass);
            continue;
          }
        }

        btn.addEventListener("click", async () => {
          const tokenDocId = btn.dataset.tokenDocId;
          if (!tokenDocId) return;

          // Check if this PC already rolled (race condition guard)
          const _a2 = game.messages.contents;
          let _f2 = _a2.findIndex(m => m.id === message.id);
          if (_f2 < 0) _f2 = Math.max(0, _a2.length - 200);
          const alreadyRolled = _a2.slice(_f2).some(m => {
            const f = m.flags?.[MODULE_ID];
            return f?.type === "pcSaveResult" && f.tokenDocId === tokenDocId && f.castId === message.id;
          });
          if (alreadyRolled) {
            ui.notifications.warn("This PC has already rolled their save.");
            btn.disabled = true;
            return;
          }

          // Find the PC target data from flags
          const targets = message.flags?.[MODULE_ID]?.targets ?? [];
          const tgt = targets.find(t => t.tokenDocId === tokenDocId);
          if (!tgt) return;

          btn.disabled = true;
          btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';

          // Build a fake pcSavePrompt message and roll it
          const flags = message.flags?.[MODULE_ID];
          const fakeMsg = { flags: { [MODULE_ID]: {
            type: "pcSavePrompt",
            // Carry the item link through — without it the saveComplete fires
            // with itemUuid:null and the Forge FX runtime can't find the item,
            // so animation+sound never play for GM-rolled PCs (the player-prompt
            // path already had it, which is why some PCs worked and some didn't).
            itemUuid: flags.itemUuid ?? null,
            itemId: flags.itemId ?? null,
            saveAbility: flags.saveAbility,
            saveDC: flags.saveDC,
            halfOnSave: flags.halfOnSave,
            damageTypes: flags.damageTypes,
            isSpell: flags.isSpell,
            tokenDocId: tgt.tokenDocId,
            actorId: tgt.actorId,
            sceneId: tgt.sceneId,
            // The cast card knows both — carry them so the GM's dice button
            // measures cover from the caster, not from the target. (F-019)
            casterActorId:    flags.actorId ?? null,
            casterTokenDocId: flags.casterTokenDocId ?? null,
            targetName: tgt.name,
            targetImg: tgt.img,
            autoFailSave: tgt.autoFailSave,
            saveAdvantage: tgt.saveAdvantage,
            saveDisadvantage: tgt.saveDisadvantage,
            superSaver: tgt.superSaver,
            semiSuperSaver: tgt.semiSuperSaver,
            saveBonuses: tgt.saveBonuses,
            damageModifiers: tgt.damageModifiers,
            currentHP: tgt.currentHP,
            maxHP: tgt.maxHP,
            castId: message.id,
          }}};

          const restoreScroll = this._preserveChatScroll();
          await this._rollPcSave(fakeMsg);
          restoreScroll();
          btn.innerHTML = '<i class="fas fa-check"></i>';
        });
      }
    }

    // ── + TARGET SELECTED button (additive: adds canvas-selected tokens) ──
    const targetSelBtn = el.querySelector?.("[data-action='aceQolTargetSelected']");
    if (targetSelBtn && !targetSelBtn.dataset.wired) {
      targetSelBtn.dataset.wired = "1";
      targetSelBtn.addEventListener("click", async () => {
        const selected = canvas.tokens?.controlled ?? [];
        if (!selected.length) {
          ui.notifications.warn("ACE QOL: No tokens selected on the canvas.");
          return;
        }
        const existingIds = new Set((flags.targets ?? []).map(t => t.tokenDocId));
        const newTokens = selected.filter(t => !existingIds.has(t.document?.id ?? t.id));
        if (!newTokens.length) {
          ui.notifications.info("ACE QOL: All selected tokens are already in the target list.");
          return;
        }
        // Additive: target each new token, keep existing user targets
        for (const tok of newTokens) {
          tok.setTarget(true, { user: game.user, releaseOthers: false });
        }
        await this._addTargetsToCard(message, newTokens);
      });
    }

    // ── ROLL NPC SAVES button ──
    const rollNpcBtn = el.querySelector?.("[data-action='aceQolRollNpcSaves']");
    if (rollNpcBtn && !rollNpcBtn.dataset.wired) {
      rollNpcBtn.dataset.wired = "1";
      if (flags.rolled) {
        rollNpcBtn.disabled = true;
        rollNpcBtn.innerHTML = '<i class="fas fa-check"></i> ROLLED \u2713';
      } else {
        rollNpcBtn.addEventListener("click", async () => {
          rollNpcBtn.disabled = true;
          rollNpcBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Rolling NPC saves...';

          const restoreScroll = this._preserveChatScroll();
          await this._rollNpcSavesFromTargetList(message);
          restoreScroll();

          rollNpcBtn.innerHTML = '<i class="fas fa-check"></i> ROLLED \u2713';
          await message.setFlag(MODULE_ID, "rolled", true);
        });

        // \u2500\u2500 Auto-roll NPC saves (setting "autoRollNpcSaves", default ON) \u2500\u2500
        // NPCs roll their own saves \u2014 no reason to make the GM click. PC targets
        // still get their whispered self-roll prompt (a separate path). Gated to
        // the primary GM + an in-flight guard + the persisted "rolled" flag, so
        // it fires exactly once across re-renders and clients.
        this._autoRolledSaves ??= new Set();
        const _autoRollNpc = QolSettings.get?.("autoRollNpcSaves") !== false;
        // STAND DOWN IF THE CAST FLOW OWNS THIS CARD (2026-07-28). Firing from
        // here in parallel with the cast's own PC rolls is what produced a
        // results card built before its results existed. The caster resolves
        // and then builds, in order; this hook is now only the fallback for
        // when that flow didn't claim the card, or claimed it and failed.
        const _castFlowOwnsThis = flags.gmDrivesResults === true && !flags.rolled;
        if (!_castFlowOwnsThis
            && _autoRollNpc && game.user === game.users?.activeGM
            && !flags.rolled && !this._autoRolledSaves.has(message.id)) {
          this._autoRolledSaves.add(message.id);
          rollNpcBtn.disabled = true;
          rollNpcBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Rolling NPC saves...';
          (async () => {
            try {
              await this._rollNpcSavesFromTargetList(message);
              rollNpcBtn.innerHTML = '<i class="fas fa-check"></i> ROLLED \u2713';
              await message.setFlag(MODULE_ID, "rolled", true);
            } catch (err) {
              console.warn(`${MODULE_ID} | auto-roll NPC saves failed:`, err);
            }
          })();
        }
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Button Wiring — PC Save Prompt (whispered to player)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Keep the GM's chat scroll position when THEY roll a save (Johnny 2026-07-11:
   * "don't jump down to the result — I have to scroll back up to find the next
   * PC I missed"). Foundry force-scrolls to the bottom whenever the message
   * AUTHOR is the current user, so a GM-rolled save always yanks the GM's view
   * down (a connected player, not the author, stays put). We snapshot the log's
   * scroll position and, if the GM had scrolled UP off the bottom, re-assert it
   * across a few frames to beat Foundry's auto-scroll. Returns a restore() fn.
   */
  _preserveChatScroll() {
    try {
      const log = document.querySelector("#chat-log")
        ?? document.querySelector("ol.chat-log")
        ?? ui.chat?.element?.querySelector?.("ol.chat-log");
      if (!log) return () => {};
      const prevTop  = log.scrollTop;
      const atBottom = (log.scrollHeight - log.scrollTop - log.clientHeight) < 40;
      return () => {
        if (atBottom) return;   // they were pinned to the bottom — leave it there
        const restore = () => { try { log.scrollTop = prevTop; } catch (_) {} };
        restore();
        // Result card + DSN reveal render async — re-assert to outlast the
        // auto-scroll without guessing a single delay.
        setTimeout(restore, 120);
        setTimeout(restore, 400);
        setTimeout(restore, 1000);
      };
    } catch (_) { return () => {}; }
  }

  _wirePcSaveButton(el, message, flags) {
    // If already rolled, collapse the entire prompt card
    if (flags.rolled) {
      const chatMsg = el.closest?.(".chat-message") ?? el;
      chatMsg.classList.add("ace-qol-save-collapsed");
      return; // No need to wire anything
    }

    const rollBtn = el.querySelector?.("[data-action='aceQolRollPcSave']");
    if (!rollBtn || rollBtn.dataset.wired) return;
    rollBtn.dataset.wired = "1";

    rollBtn.addEventListener("click", async () => {
      rollBtn.disabled = true;
      rollBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Rolling...';

      const restoreScroll = this._preserveChatScroll();
      await this._rollPcSave(message);
      restoreScroll();

      // Collapse on this client immediately (DOM only — no flag write needed)
      rollBtn.innerHTML = '<i class="fas fa-check"></i> ROLLED \u2713';
      const chatMsg = el.closest?.(".chat-message") ?? el;
      chatMsg.classList.add("ace-qol-save-collapsed");
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Auto-Collapse Target List Card
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Retire THE cast card this results card came from — and only that one.
   *
   * ⚠️ This used to take `resultsFlags`, ignore it completely, and collapse
   * EVERY `.ace-qol-save-card` in the chat log. The collapse class is a full
   * hide (max-height:0; opacity:0), and the render hook calls this on every
   * render of any results card — including the sweep over cards that were
   * already drawn. So: cast at a player and wait for them to roll, resolve
   * anything else in the meantime, and the first cast's live target card
   * vanished from every client while it was still waiting on that player. The
   * GM lost the pending list and the roll-on-behalf dice with it.
   * (audit F-018, 2026-08-07)
   *
   * Two precise rules, no sweep:
   *   • the card whose id IS this cast — that is the one being superseded;
   *   • any card whose own `superseded` flag is set — it has already retired
   *     itself and is only being re-applied because a re-render cleared the CSS.
   */
  _collapseTargetListCard(resultsFlags) {
    const chatLog = document.querySelector("#chat-log, .chat-log");
    if (!chatLog) return;
    const castId = resultsFlags?.castId ?? null;

    for (const card of chatLog.querySelectorAll(".ace-qol-save-card")) {
      const msgEl = card.closest(".chat-message");
      if (!msgEl) continue;
      const id = msgEl.dataset?.messageId;
      if (!id) continue;

      const isThisCast = !!castId && id === castId;
      const alreadyRetired = game.messages.get(id)?.flags?.[MODULE_ID]?.superseded === true;
      if (isThisCast || alreadyRetired) msgEl.classList.add("ace-qol-save-collapsed");
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Button Wiring — Phase 1 (ROLL DAMAGE + portrait click-to-pan)
  // ═══════════════════════════════════════════════════════════════════════════

  _wireRollDamageButton(el, message, flags) {
    // ── Click portrait/name → select + pan to token ──
    const rows = el.querySelectorAll?.(".ace-qol-save-result-row");
    if (rows?.length) {
      for (const row of rows) {
        const img = row.querySelector(".ace-qol-save-tgt-img");
        const name = row.querySelector(".ace-qol-save-tgt-name");
        const tokenDocId = row.dataset.tokenDocId;
        const clickHandler = () => {
          if (!tokenDocId) return;
          const scene = canvas.scene;
          if (!scene) return;
          const tokenDoc = scene.tokens.get(tokenDocId);
          const token = tokenDoc?.object;
          if (!token) {
            cannotDo("panning to that creature", "its token is not on this scene");
            return;
          }
          token.control({ releaseOthers: true });
          canvas.animatePan({ x: token.center.x, y: token.center.y, duration: 250 });
        };
        if (img) { img.style.cursor = "pointer"; img.addEventListener("click", clickHandler); }
        if (name) { name.style.cursor = "pointer"; name.addEventListener("click", clickHandler); }
      }
    }

    // ── ROLL DAMAGE button (GM + the caster's owning player) ──
    // Johnny 2026-07-11: a PC rolls their OWN spell damage ("part of the fun").
    // Wired ABOVE the GM-only guard below so the caster's click is bound too.
    // The GM rolls locally; a non-GM caster hands the roll to the GM over the
    // socket — the damage dice broadcast back to the caster's screen
    // (safeShowForRoll uses synchronize=true), so they see themselves roll.
    // Application stays GM-side.
    const rollDmgBtn = el.querySelector?.("[data-action='aceQolRollDamage']");
    if (rollDmgBtn && !rollDmgBtn.dataset.wired) {
      const _casterIds = flags.casterUserIds ?? [];
      const _mayRoll = game.user.isGM || _casterIds.includes(game.user.id);
      if (_mayRoll) {
        rollDmgBtn.dataset.wired = "1";
        rollDmgBtn.addEventListener("click", async () => {
          const stillPending = (message.flags?.[MODULE_ID]?.allResults ?? []).some(r => r.pending);
          if (stillPending) {
            ui.notifications?.warn("ACE QOL — wait for every target to roll their save before rolling damage.");
            return;
          }
          rollDmgBtn.disabled = true;
          rollDmgBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Rolling damage...';
          if (game.user.isGM) {
            await this._completeSaveResultsPhase2(message);
          } else {
            game.socket.emit(`module.${MODULE_ID}`, {
              action: "rollSaveDamage", messageId: message.id, userName: game.user.name,
            });
          }
        });
      }
    }

    // ── × Remove buttons (Phase 1 — strip target from allResults before damage) ──
    // GM-only: the handler calls message.update() which players don't have
    // permission for on GM-authored cards. Without this gate a player click
    // would remove the row from their LOCAL DOM (because row.remove() works
    // anywhere) but fail silently on the message.update — leaving them with
    // a desynced view from the GM. Discovered during the .update() audit
    // sweep (Gemini P1-3).
    // SILENT-OK: GM-only handler; every client sees this hook
    if (!game.user.isGM) return;
    const phase1RemoveBtns = el.querySelectorAll?.("[data-action='aceQolRemovePhase1']");
    if (phase1RemoveBtns?.length) {
      for (const btn of phase1RemoveBtns) {
        if (btn.dataset.wired) continue;
        btn.dataset.wired = "1";
        btn.addEventListener("click", async (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          const tokenDocId = btn.dataset.tokenDocId;
          if (!tokenDocId) return;
          const allResults = (message.flags?.[MODULE_ID]?.allResults ?? []).filter(r => r.tokenDocId !== tokenDocId);
          await message.update({
            [`flags.${MODULE_ID}.allResults`]: allResults,
          }, { render: false });
          // Remove the row from DOM and rebuild the card content for persistence
          const row = btn.closest(".ace-qol-save-result-row");
          if (row) row.remove();
          // Rebuild content so subsequent renders/updates stay correct
          try {
            const item = await fromUuid(message.flags?.[MODULE_ID]?.itemUuid)
                      ?? game.items.get(message.flags?.[MODULE_ID]?.itemId);
            if (item) {
              const cardHtml = this._buildPhase1CardHtml(item, allResults, {
                saveAbility: message.flags?.[MODULE_ID]?.saveAbility,
                saveDC:      message.flags?.[MODULE_ID]?.saveDC,
                hasDamage:   message.flags?.[MODULE_ID]?.hasDamage !== false,
                halfOnSave:  message.flags?.[MODULE_ID]?.halfOnSave === true,
                activityId:  message.flags?.[MODULE_ID]?.activityId,
                appliedConditions: message.flags?.[MODULE_ID]?.appliedConditions ?? [],
              });
              await message.update({ content: cardHtml }, { render: false });
            }
          } catch (err) {
            console.warn(`${MODULE_ID} | Phase 1 X-remove rebuild failed:`, err);
          }
        });
      }
    }

  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Button Wiring — Phase 2 / Legacy (override + Apply/Undo)
  // ═══════════════════════════════════════════════════════════════════════════

  _wireSaveResultButtons(el, message, flags) {
    // ── Click portrait/name → select + pan to token ──
    const rows = el.querySelectorAll?.(".ace-qol-save-result-row");
    if (rows?.length) {
      for (const row of rows) {
        const img = row.querySelector(".ace-qol-save-tgt-img");
        const name = row.querySelector(".ace-qol-save-tgt-name");
        const tokenDocId = row.dataset.tokenDocId;
        const clickHandler = () => {
          if (!tokenDocId) return;
          const scene = canvas.scene;
          if (!scene) return;
          const tokenDoc = scene.tokens.get(tokenDocId);
          const token = tokenDoc?.object;
          if (!token) {
            cannotDo("panning to that creature", "its token is not on this scene");
            return;
          }
          // Select the token
          token.control({ releaseOthers: true });
          // Pan camera to it
          canvas.animatePan({ x: token.center.x, y: token.center.y, duration: 250 });
        };
        if (img) { img.style.cursor = "pointer"; img.addEventListener("click", clickHandler); }
        if (name) { name.style.cursor = "pointer"; name.addEventListener("click", clickHandler); }
      }
    }

    // ── Manual damage override buttons (0, ¼, ½, 1, 2) ──
    const overrideBtns = el.querySelectorAll?.("[data-action='aceQolDmgOverride']");
    if (overrideBtns?.length) {
      for (const btn of overrideBtns) {
        if (btn.dataset.wired) continue;
        btn.dataset.wired = "1";
        btn.addEventListener("click", () => {
          const tokenDocId = btn.dataset.tokenDocId;
          const multiplier = parseFloat(btn.dataset.multiplier);
          if (!tokenDocId || isNaN(multiplier)) return;

          // Toggle active class — scoped to this row only
          const ovrLine = btn.closest(".ace-qol-save-ovr-line");
          if (ovrLine) {
            ovrLine.querySelectorAll(".ace-qol-save-ovr").forEach(b => b.classList.remove("ace-qol-save-ovr-active"));
            btn.classList.add("ace-qol-save-ovr-active");
          }

          // Store in memory cache (NO flag persist, NO re-render)
          const cacheKey = `${message.id}|${tokenDocId}`;
          SaveEngine.overrideCache.set(cacheKey, multiplier);

          // Update DOM instantly — scoped to this button's row
          const row = btn.closest(".ace-qol-save-result-row");
          if (row) this._updateRowDamageDisplay(row, tokenDocId, multiplier, flags);
        });
      }
    }

    // ── × Remove buttons — hide row and exclude from APPLY ──
    const removeBtns = el.querySelectorAll?.("[data-action='aceQolRemoveResult']");
    if (removeBtns?.length) {
      for (const btn of removeBtns) {
        if (btn.dataset.wired) continue;
        btn.dataset.wired = "1";
        btn.addEventListener("click", () => {
          const tokenDocId = btn.dataset.tokenDocId;
          const row = btn.closest(".ace-qol-save-result-row");
          if (row) {
            row.style.display = "none";
            row.dataset.removed = "1";
          }
          // Mark as removed in cache so APPLY ALL skips it
          const cacheKey = `${message.id}|${tokenDocId}`;
          SaveEngine.overrideCache.set(cacheKey, "removed");
        });
      }
    }

    // ── Apply All / Undo All ──
    const applyBtn = el.querySelector?.("[data-action='aceQolApplyDamage']");
    const undoBtn = el.querySelector?.("[data-action='aceQolUndoDamage']");

    if (applyBtn && !applyBtn.dataset.wired) {
      applyBtn.dataset.wired = "1";
      if (flags.applied) {
        applyBtn.disabled = true;
        applyBtn.textContent = "APPLIED \u2713";
        // Enable undo since damage was already applied
        if (undoBtn && !flags.undone) undoBtn.disabled = false;
      } else {
        applyBtn.addEventListener("click", async () => {
          applyBtn.disabled = true;   // prevent double-click before first await
          try {
            await this._applyAllSaveDamage(message);
            applyBtn.textContent = "APPLIED \u2713";
            await message.setFlag(MODULE_ID, "applied", true);
            if (undoBtn) { undoBtn.disabled = false; }
          } catch (err) {
            console.error(`${MODULE_ID} | _applyAllSaveDamage failed:`, err);
            applyBtn.disabled = false;   // re-enable so GM can retry
          }
        });
      }
    }

    if (undoBtn && !undoBtn.dataset.wired) {
      undoBtn.dataset.wired = "1";
      if (flags.undone) {
        undoBtn.disabled = true;
        undoBtn.textContent = "UNDONE \u2713";
      } else if (!flags.applied) {
        // Not applied yet — keep disabled (set in HTML)
      } else {
        // Was applied but not yet undone — enable it
        undoBtn.disabled = false;
        undoBtn.addEventListener("click", async () => {
          await this._undoAllSaveDamage(message);
          undoBtn.disabled = true;
          undoBtn.textContent = "UNDONE \u2713";
          await message.setFlag(MODULE_ID, "undone", true);
        });
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Refresh Target List from Canvas Selection
  // ═══════════════════════════════════════════════════════════════════════════

  async _refreshTargetListFromSelection(message, el) {
    const flags = message.flags?.[MODULE_ID];
    if (!flags) return;

    const controlled = canvas.tokens.controlled;
    if (!controlled.length) {
      ui.notifications.warn("No tokens selected on the canvas.");
      return;
    }

    // Re-assess the selected tokens
    const item = await fromUuid(flags.itemUuid) ?? game.items.get(flags.itemId);
    const casterActor = game.actors.get(flags.actorId);
    if (!item || !casterActor) return;

    const newTargets = [];
    for (const token of controlled) {
      const state = CombatState.assess(casterActor, token, item, {
        saveAbility: flags.saveAbility,
        isSpell: flags.isSpell,
        damageTypes: flags.damageTypes,
      });
      if (!state) continue;

      const isPC = SaveEngine.isPlayerCharacter(token.actor);
      // Save modifier via the target profile — ONE reader for a fact that
      // was being decoded seven different ways in this file alone.
      const saveMod = SaveEngine._targetProfileFor(token.actor, { tokenDocId: token?.document?.id, sceneId: token?.scene?.id })?.saveMod(flags.saveAbility) ?? 0;
      const numericBonusTotal2 = (state.saveBonuses ?? []).reduce((sum, b) => {
        const raw = String(b?.value ?? "").replace(/^\+/, "").trim();
        const n = Number(raw);
        return Number.isFinite(n) ? sum + n : sum;
      }, 0);
      const effectiveMod2 = saveMod + numericBonusTotal2;
      const modStr = effectiveMod2 >= 0 ? `+${effectiveMod2}` : `${effectiveMod2}`;

      newTargets.push({
        tokenId: token.id,
        tokenDocId: token.document?.id ?? token.id,
        actorId: token.actor?.id,
        sceneId: canvas.scene?.id,
        name: state.target.name,
        img: state.target.img,
        isPC,
        saveMod: modStr,
        saveModBase: saveMod,
        saveModBonus: numericBonusTotal2,
        saveAbilityUpper: flags.saveAbility.toUpperCase(),
        autoFailSave: state.autoFailSave,
        saveAdvantage: state.saveAdvantage,
        saveDisadvantage: state.saveDisadvantage,
        superSaver: state.superSaver,
        semiSuperSaver: state.semiSuperSaver,
        saveBonuses: state.saveBonuses,
        damageModifiers: state.damageModifiers,
        currentHP: state.target.currentHP,
        maxHP: state.target.maxHP,
        // ASK, don't reconstruct — see SaveEngine.ownerUserIds. (audit F-020)
        ownerIds: isPC ? SaveEngine.ownerUserIds(token.actor) : [],
      });
    }

    // Update flags
    await message.setFlag(MODULE_ID, "targets", newTargets);

    // Re-render the message to reflect new targets
    ui.chat.updateMessage(message);
  }

  /**
   * Update the NPC/PC section header counts after removing a target.
   */
  /**
   * Fold any already-posted pcSaveResult into still-pending rows, in place.
   *
   * ⚠️ WHY THIS EXISTS (2026-07-28, proven from live data). The card scans for
   * existing PC results EARLY, then waits on the dice animation before posting.
   * A GM auto-roll for an absent player lands INSIDE that gap: the scan came
   * back empty, so the card posted "WAITING FOR PLAYER" — while a result with
   * the identical castId and tokenDocId already sat in the log saying PASS.
   * Nothing ever revisited it, so it waited forever on a save already rolled.
   *
   * Scanning once and trusting the answer is the bug. Re-check late, and again
   * on render, so a result can never arrive "too early" to be seen.
   *
   * @returns {number} rows merged
   */

  static _mergePendingPcResults(results, castId, halfOnSave = false) {
    if (!castId || !Array.isArray(results)) return 0;
    // SILENT-OK: nothing is pending; a no-op, and the line already says so
    if (!results.some(r => r?.pending)) return 0;   // nothing to heal

    const byToken = new Map();
    for (const m of game.messages.contents) {
      const f = m.flags?.[MODULE_ID];
      if (f?.type === "pcSaveResult" && f.castId === castId && f.tokenDocId) {
        byToken.set(f.tokenDocId, f);
      }
    }
    if (!byToken.size) return 0;

    let merged = 0;
    for (const r of results) {
      if (!r?.pending) continue;
      const f = byToken.get(r.tokenDocId);
      if (!f) continue;

      const passed = f.passed;
      const superSaver = f.superSaver;
      let damageMultiplier;
      if (passed) damageMultiplier = superSaver ? 0 : (halfOnSave ? 0.5 : 0);
      else        damageMultiplier = superSaver ? 0.5 : 1;

      r.pending    = false;
      r.saveTotal  = f.saveTotal;
      r.dieResult  = f.dieResult ?? null;
      r.passed     = passed;
      r.resultLabel = f.resultLabel;
      r.isAutoFail = f.autoFailSave;
      r.superSaver = superSaver;
      r.damageMultiplier = damageMultiplier;
      merged++;
    }
    return merged;
  }

  _updateSectionCounts(el, targets) {
    const npcs = targets.filter(t => !t.isPC);
    const pcs = targets.filter(t => t.isPC);

    const labels = el.querySelectorAll?.(".ace-qol-save-tgt-section-label");
    if (labels?.[0] && npcs.length >= 0) labels[0].textContent = `NPCs (${npcs.length})`;
    if (labels?.[1] && pcs.length >= 0) labels[1].textContent = `PCs (${pcs.length})`;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Roll NPC Saves from Target List Card
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * @param {ChatMessage} message  the cast (target list) card
   * @param {object} [handedOver]  tokenDocId → result, resolved by the caller
   *        BEFORE this ran. Passing them in is the whole point: this method used
   *        to go looking in the chat log for results the caller was holding, and
   *        raced its own dice animation to find them.
   */
  async _rollNpcSavesFromTargetList(message, handedOver = null) {
    const flags = message.flags?.[MODULE_ID];
    if (!flags) return;

    const { saveAbility, saveDC, halfOnSave, targets, itemId, itemUuid, actorId, damageTypes, isSpell,
            timingType, templateDocId, templateSceneId, activityId } = flags;

    const item = await fromUuid(itemUuid) ?? game.items.get(itemId);
    const casterActor = game.actors.get(actorId);

    // ── Separate NPC and PC targets ──
    // Split stays on isPC: an offline PC has ALREADY been auto-rolled by
    // _postLiveTargetCard, and its result arrives here via existingPcResults.
    // Routing it into the NPC roller instead would roll a second, different
    // save and throw away the one the table already saw.
    const npcTargets = targets.filter(t => !t.isPC);
    const pcTargets = targets.filter(t => t.isPC);

    // ── Roll NPC saves ──
    // isMulti tells _rollSingleSave to use the multi-target dice pacing
    // (default 250ms per save) instead of the single-target pacing
    // (default 1000ms). Without this, a 5-target Fireball would wait
    // 5 full seconds with the per-die delay summed.
    const isMulti = npcTargets.length > 1;
    const npcResults = [];
    // What this action can actually inflict — read ONCE per cast, before any
    // die, so the Gate can answer "immune to everything this does".
    const _gateCtx = {
      outcomeConditions: SaveEngine._outcomeConditionsFor(item),
      dealsDamage: Array.isArray(damageTypes) && damageTypes.some(t => t && t !== "none"),
      // The exact body that cast, for the cover check. (audit F-019)
      casterTokenDocId: flags.casterTokenDocId ?? null,
    };
    for (const tgt of npcTargets) {
      const result = await this._rollSingleSave(tgt, saveAbility, saveDC, halfOnSave, actorId, { isMultiTarget: isMulti, ..._gateCtx });
      npcResults.push(result);
    }

    // ── POST-SAVE REACTIONS (Legendary Resistance) ──
    // Check if any NPC that failed can use Legendary Resistance.
    const reactionEng = game.aceQol?.reactionEngine;
    if (reactionEng) {
      try {
        // ── ONLY A REAL FAILED SAVE REACHES THE REACTION ENGINE (2026-08-07) ──
        // Every NPC row used to be handed over, INCLUDING the ones the Gate
        // refused. A gated row carries `passed: false` and `saveTotal: null`,
        // and the reaction engine only asks "did it fail, and was there an
        // ability and a DC" — nothing tells it no die was ever thrown. So a
        // legendary creature the Gate excused (dead, or immune to everything the
        // power does) was offered:
        //
        //   "X failed a WIS save against Hold Monster. Spend Legendary
        //    Resistance to succeed instead?"   Roll vs DC: null vs 17
        //
        // Accept it and a Legendary Resistance charge is burned on a save that
        // never happened. `_failedTheSave` is the one reader that already knows
        // the difference between pending, gated and genuinely failed — use it,
        // and carry the original index so the write-back can't drift.
        const enriched = [];
        npcResults.forEach((r, idx) => {
          if (r.noRoll) {
            console.log(`${MODULE_ID} | GATE: ${r.name} never rolled (${r.noRoll}) — no reaction offered.`);
            return;
          }
          if (r.pending) return;
          // The TOKEN's own actor, so spending Legendary Resistance on one
          // unlinked copy doesn't drain the shared sidebar actor for all of them.
          const _scene = game.scenes.get(r.sceneId) ?? canvas.scene;
          const _actor = _scene?.tokens?.get(r.tokenDocId)?.actor ?? game.actors.get(r.actorId);
          enriched.push({
            ...r,
            _idx: idx,
            actor: _actor,
            ability: saveAbility,
            dc: saveDC,
            total: r.saveTotal,
            saved: r.passed,
            sourceName: item?.name ?? null,   // names the resisted effect in the LR prompt
          });
        });

        const modified = await reactionEng.checkPostSaveReactions(enriched);
        // Apply any changes (Legendary Resistance flips saved to true)
        for (const m of (modified ?? [])) {
          const i = m?._idx;
          if (!Number.isInteger(i) || !npcResults[i]) continue;
          if (m.legendaryResistance && m.saved) {
            npcResults[i].passed = true;
            npcResults[i].legendaryResistance = true;
            npcResults[i].resultLabel = "LEGENDARY RESISTANCE";
            // Recalculate damage multiplier
            if (halfOnSave) npcResults[i].damageMultiplier = 0.5;
            else npcResults[i].damageMultiplier = 0;
          }
        }
      } catch (err) {
        console.error(`${MODULE_ID} | Post-save reaction check failed:`, err);
      }
    }

    // ── SILVERY BARBS — force reroll on successful NPC saves ──
    if (reactionEng) {
      try {
        for (let i = 0; i < npcResults.length; i++) {
          const r = npcResults[i];
          if (!r.passed) continue; // Only targets successful saves
          const targetActor = game.actors.get(r.actorId);
          const scene = game.scenes.get(r.sceneId) ?? canvas.scene;
          const targetTokenDoc = scene?.tokens?.get(r.tokenDocId);
          const targetToken = targetTokenDoc?.object;
          if (!targetActor || !targetToken) continue;

          const sbResult = await reactionEng.checkSilveryBarbs({
            actor: targetActor,
            token: targetToken,
            rollType: "save",
            total: r.saveTotal,
            dc: saveDC,
            description: `${targetActor.name}'s ${saveAbility.toUpperCase()} save`,
          });
          if (sbResult.rerolled && sbResult.newTotal !== undefined) {
            const newPassed = sbResult.newTotal >= saveDC;
            if (!newPassed) {
              npcResults[i].passed = false;
              npcResults[i].saveTotal = sbResult.newTotal;
              npcResults[i].silveryBarbsRerolled = true;
              npcResults[i].resultLabel = "SILVERY BARBS → FAILED";
              npcResults[i].damageMultiplier = 1;
            }
          }
        }
      } catch (err) {
        console.warn(`${MODULE_ID} | Silvery Barbs save check failed (non-blocking):`, err);
      }
    }

    // ── Emit saveComplete hooks for NPC saves (for duration tracker isSave expiry) ──
    for (const r of npcResults) {
      try {
        const scene = game.scenes.get(r.sceneId) ?? canvas.scene;
        const tokenDoc = scene?.tokens?.get(r.tokenDocId);
        const actor = tokenDoc?.actor ?? game.actors.get(r.actorId);
        if (actor) {
          Hooks.callAll(`${MODULE_ID}.saveComplete`, { actor, tokenDocId: r.tokenDocId, saveAbility, passed: r.passed, itemUuid: item?.uuid ?? null });
        }
      } catch (_) { /* non-fatal */ }
    }

    // ── Build PC results — check if they already rolled (same cast only) ──
    const thisCastId = message.id; // target list message ID = cast ID

    // ── SEARCH THE WHOLE CAST, NOT THE LAST 30 MESSAGES (2026-07-28) ──
    // This used to scan `contents.slice(-30)`. A save result can only exist
    // AFTER its own cast, but there's no ceiling on how much chat lands in
    // between — result cards, damage cards, nudges, other combatants' turns.
    // Push past thirty and the result scrolled out of the window, the card
    // couldn't find it, and the row sat on "WAITING FOR PLAYER" forever for a
    // save that had already been rolled. That's exactly what Johnny hit with
    // an OFFLINE player whose save the GM had auto-rolled: it was rolled, the
    // result existed, the card just wasn't looking far enough back.
    //
    // The cast's own message is the natural floor — nothing before it can
    // belong to this cast — so scan from there to the end. Bounded, and it
    // cannot miss.
    // ── 1. RESULTS WE WERE HANDED (the normal path) ──
    // The caller resolved every save it owns before calling us and passed them
    // in. Nothing to find, nothing to race. If it also parked them on the cast
    // card, read those too so a reload rebuilds identically.
    const existingPcResults = new Map();
    const handed = handedOver ?? message.flags?.[MODULE_ID]?.gmRolledPcResults ?? null;
    for (const [tokenDocId, res] of Object.entries(handed ?? {})) {
      if (tokenDocId && res) existingPcResults.set(tokenDocId, res);
    }

    // ── 2. RESULTS A PLAYER POSTED FROM THEIR OWN CLIENT ──
    // These genuinely arrive as chat messages from another client, so this is a
    // legitimate read of the log rather than us hunting for our own data. Scan
    // from the cast's own message: nothing before it can belong to this cast.
    const all = game.messages.contents;
    let from = all.findIndex(m => m.id === thisCastId);
    if (from < 0) from = Math.max(0, all.length - 200);   // card not in the log → generous fallback
    for (let i = from; i < all.length; i++) {
      const f = all[i]?.flags?.[MODULE_ID];
      if (f?.type === "pcSaveResult" && f.tokenDocId && f.castId === thisCastId) {
        if (!existingPcResults.has(f.tokenDocId)) existingPcResults.set(f.tokenDocId, f);
      }
    }

    const pcResults = pcTargets.map(tgt => {
      // ── THE GATE, player side (2026-08-06, ONE_GATE phase 0) ─────────────
      // The NPC path is gated inside _rollSingleSave, but players never go
      // through that method — they get a prompt and roll their own dice. A
      // dead character would still be asked to roll. Gate here, where the
      // prompt row is built, so the socket round-trip is untouched.
      //
      // ⚠️ A PC at 0 HP is NOT dead — they are unconscious and dying, still a
      // legal target, and still roll (auto-failing STR/DEX). isDead only
      // answers true for a player when the `dead` marker is actually set, so
      // this cannot silently stop a downed party member being affected.
      {
        const _v = SaveEngine._verdictForTargetRow(tgt);
        if (_v) {
          console.log(`${MODULE_ID} | GATE: ${tgt.name} (PC) — ${_v.reason.toUpperCase()}, no prompt sent.`);
          return SaveEngine._noRollRow(tgt, _v, { isPC: true });
        }
      }

      const existing = existingPcResults.get(tgt.tokenDocId);
      if (existing) {
        // PC already rolled — build resolved result
        const passed = existing.passed;
        const superSaver = existing.superSaver;
        let damageMultiplier;
        if (passed) {
          if (superSaver) damageMultiplier = 0;
          else if (halfOnSave) damageMultiplier = 0.5;
          else damageMultiplier = 0;
        } else {
          if (superSaver) damageMultiplier = 0.5;
          else damageMultiplier = 1;
        }
        return {
          name: tgt.name, img: tgt.img,
          tokenDocId: tgt.tokenDocId, actorId: tgt.actorId, sceneId: tgt.sceneId,
          saveTotal: existing.saveTotal, passed,
          isAutoFail: existing.autoFailSave,
          resultLabel: existing.resultLabel,
          damageMultiplier,
          roll: null, damageModifiers: tgt.damageModifiers,
          currentHP: tgt.currentHP, maxHP: tgt.maxHP,
          isPC: true, pending: false,
        };
      }
      // PC hasn't rolled yet — pending placeholder
      //
      // ⚠️ SAY WHO YOU ARE WAITING FOR, AND NEVER NAME SOMEBODY WHO ISN'T THERE.
      // Johnny hurled a flame at Hammer — a test character owned only by the GM
      // — and the card sat on "Waiting for save…" with no button he could press,
      // on any screen, before eventually rolling itself (2026-08-14). Nothing was
      // broken: with no connected owner the engine correctly falls through to a
      // GM auto-roll. The CARD was the liar. It announced a wait on a player who
      // does not exist, so a working auto-roll read as a hang.
      //
      // Same failure shape as the empty-encounter initiative message from the
      // same night: "nobody is here" and "somebody has not answered yet" are
      // different facts and must never print the same sentence.
      const _ownerOnline = this._pcOwnerActive(tgt);
      return {
        name: tgt.name, img: tgt.img,
        tokenDocId: tgt.tokenDocId, actorId: tgt.actorId, sceneId: tgt.sceneId,
        saveTotal: null, passed: null,
        isAutoFail: tgt.autoFailSave,
        ownerOnline: _ownerOnline,
        resultLabel: _ownerOnline ? "⏳ Waiting for save..."
                                  : "⏳ No player online — GM rolling…",
        damageMultiplier: null,
        roll: null, damageModifiers: tgt.damageModifiers,
        currentHP: tgt.currentHP, maxHP: tgt.maxHP,
        isPC: true, pending: true,
      };
    });

    // ── PC prompts already sent when target list card was posted ──

    // RE-CHECK LATE. The scan above ran before the dice animation; a GM
    // auto-roll for an absent player finishes during that wait, so its result
    // exists by now even though the scan missed it. Do this BEFORE conditions
    // are applied — a PC who actually failed must still get the condition.
    {
      const _healed = SaveEngine._mergePendingPcResults(pcResults, thisCastId, halfOnSave);
      if (_healed) console.log(`${MODULE_ID} | Save card: folded in ${_healed} PC result(s) that landed while the dice were rolling.`);
    }

    // ── Detect whether this spell deals damage at all ──
    // Save-or-condition spells (Hold Person, Charm Person, Sleep, Bane,
    // Hypnotic Pattern, Tasha's, Suggestion, Slow, Dominate Person, etc.)
    // have NO damage parts. For those, skip the ROLL DAMAGE button + Phase 2
    // damage card entirely and apply conditions on the spot.
    const hasDamage = Array.isArray(damageTypes) && damageTypes.length > 0
                   && damageTypes.some(t => t && t !== "none");

    // ── Apply on-fail conditions immediately for save-only-condition spells ──
    // (Damage spells defer condition application until after the damage card
    // posts, so the GM can review damage before conditions apply. Pure-condition
    // spells skip that gate — there's nothing to review.) A "can break free"
    // power is the exception: its Restrained must land on the fail right away so
    // the break-free prompt has something to attach to, even with damage.
    const breakFreeEnabled = item.getFlag?.(MODULE_ID, "breakFreeConfig")?.enabled === true;
    let appliedConditions = [];
    if (!hasDamage || breakFreeEnabled) {
      try {
        appliedConditions = await this._applyFailedSaveConditions(item, [...npcResults, ...pcResults], { saveAbility, saveDC, activityId, casterActor }) ?? [];
      } catch (err) {
        console.error(`${MODULE_ID} | Phase-1 condition application failed:`, err);
      }
    }

    // ── Drop wasted concentration ──
    // RAW: if no target ended up affected (everyone saved, all immune, etc.),
    // there's nothing to concentrate ON. The caster shouldn't be locked into
    // concentration on a no-effect Hold Person. Only drops when:
    //   - The spell required concentration
    //   - No condition was applied to anyone
    //   - All saves are resolved (no pending PCs)
    // If PCs are pending, we defer until their saves resolve (handled in
    // _handlePCSaveResult).
    const anyPending = [...npcResults, ...pcResults].some(r => r?.pending);
    if (!hasDamage && !anyPending && appliedConditions.length === 0) {
      try {
        await this._dropCasterConcentrationIfNoEffect(item, casterActor);
      } catch (err) {
        console.warn(`${MODULE_ID} | Wasted-concentration drop failed:`, err);
      }
    }

    // ── Post Phase 1 saves-only card (damage rolled separately) ──
    const allResults = [...npcResults, ...pcResults];
    await this._postSaveResultsPhase1(item, casterActor, allResults, {
      saveAbility, saveDC, halfOnSave, damageTypes, isSpell,
      timingType, templateDocId, templateSceneId,
      hasDamage,
      appliedConditions,
      // The MULTI-TARGET path forgot this while the single-target path passed
      // it, so an 11-creature storm produced a phase-1 card with no record of
      // which ability made it — and phase 2 then rolled the wrong dice and
      // printed the wrong name. (2026-07-28)
      activityId,
      // Which cast this card belongs to, so an incoming PC result can find THIS
      // card instead of whichever save card happens to be newest in the log.
      castId: thisCastId,
    });

    // ── ONE CLEAN CARD (Johnny 2026-07-11) ──
    // Now that the results card is up, retire the target-list card into it. We
    // COLLAPSE (not delete) via a persisted flag: the old CSS-only collapse was
    // wiped whenever a PC row re-rendered, leaving the "pile of 2-3 cards"
    // Johnny saw. A flag re-applied on every render survives that. Collapse
    // keeps the card in the DOM, so the PC-row reconciliation + template
    // auto-delete that read that DOM keep working — a delete would break them.
    try { await message.update({ [`flags.${MODULE_ID}.superseded`]: true }); }
    catch (err) { console.warn(`${MODULE_ID} | supersede target-list failed:`, err); }

    // ── Auto-delete the AOE template now that saves have rolled ──
    // Animation has had time to play (caster → travel → explosion).
    await this._deleteInstantTemplate({ timingType, templateDocId, templateSceneId });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Roll a Single NPC Save
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * THE GATE (2026-08-06, phase 0 of ONE_GATE_ARCHITECTURE.md)
   *
   * Read the target and answer whether a die should be thrown at all. Returns
   * null when the answer is "roll normally", or a verdict when it is not.
   *
   * This is deliberately the FIRST thing _rollSingleSave does, because that
   * method is the single door all three roll call sites come through
   * (_fastResolveSingleNpcSave, _rollNpcSavesFromTargetList, _rollAllSaves).
   * Gating here means a fourth caller added next month is gated by
   * construction rather than by somebody remembering. Phase 1 lifts this
   * shape into the real ActionGate and adds the attacker + environment scans.
   *
   * Ordering matters and mirrors the plan: legality first, then whether the
   * action can do anything at all. Stop at the first decisive answer.
   *
   * @returns {null|{reason:string, label:string, tone:string}}
   */
  static _preRollVerdict(profile, {
    outcomeConditions = [], dealsDamage = false,
    attackerToken = null, targetToken = null,
    rangeFt = null, originIsAttacker = false,
  } = {}) {
    // ⚠️ THIS BODY MOVED INTO THE GATE (Phase 1, 2026-08-28). It used to hold
    // the dead check and the immunity check as LOCAL logic, which is precisely
    // what docs/ONE_GATE_ARCHITECTURE.md was written to end: "That is one
    // pipeline deciding for itself." The checks are identical; they now live
    // where the attack, damage and heal pipelines can reach them too.
    //
    // ⚠️ AND THE ENVIRONMENT SCAN NOW RUNS FOR SAVES. It never had. Pass the
    // two tokens and the Gate measures distance, cover, light and line of
    // effect, and carries that onto the verdict whether or not it is decisive.
    // Range and line of effect only DECIDE when the caller proves they apply:
    // an area's targets are already inside the template, and RAW measures an
    // area's line of effect from its own point of origin, not from the caster.
    return ActionGate.verdictFor({
      targetProfile: profile,
      targetActor: profile?.actor ?? null,
      attackerToken, targetToken, rangeFt, originIsAttacker,
      outcomes: outcomeConditions,
      dealsDamage,
    });
  }

  /**
   * What conditions can this action actually inflict? Needed BEFORE the roll,
   * so the Gate can tell "immune to everything this does" from "roll it".
   *
   * The authoritative pre-roll source is the spell registry: the pipeline entry
   * carries the effect key the spell applies on a failed save, and
   * ConditionLibrary turns that key into the status ids it really represents.
   * Both are plain lookups — no description parsing, nothing that needs the
   * roll to have happened.
   *
   * ⚠️ Returns [] when the item isn't registry-driven, and [] deliberately
   * makes the immunity gate INERT for that item — it rolls as before. Never
   * block a save on a fact we could not read; the same principle
   * ConditionLibrary.immuneTo already states. Phase 1 widens this source to
   * the staged-chain metadata and the parsed description, which today are only
   * computed after the fact inside _applyFailedSaveConditions.
   */
  static _outcomeConditionsFor(item) {
    try {
      const key = game.aceQol?.SpellPipeline?._getEntry?.(item)?.effect?.key ?? null;
      if (!key) return [];
      return ConditionLibrary.statusesFor(key) ?? [];
    } catch (_) {
      return [];
    }
  }

  /**
   * The Gate's verdict for a target ROW (the {tokenDocId, actorId, sceneId, …}
   * shape the save engine passes around), resolving the actor for you.
   * Returns null to mean "proceed normally".
   */
  static _verdictForTargetRow(tgt, opts = {}) {
    try {
      const scene = game.scenes.get(tgt?.sceneId) ?? canvas.scene;
      const actor = scene?.tokens?.get(tgt?.tokenDocId)?.actor ?? game.actors.get(tgt?.actorId);
      return SaveEngine._preRollVerdict(SaveEngine._targetProfileFor(actor, tgt), opts);
    } catch (err) {
      // A Gate that throws must not stop the game — fail OPEN (roll normally)
      // and say so loudly, rather than silently swallowing every target the
      // way the wall checks did twice on 2026-08-06.
      console.error(`${MODULE_ID} | GATE: verdict failed for "${tgt?.name}" — proceeding with the roll:`, err);
      return null;
    }
  }

  /**
   * Build the standard no-roll result row from a verdict. One shape, so the
   * NPC path, the PC path and the late-added-targets path can't drift.
   */
  static _noRollRow(tgt, verdict, { isPC = false } = {}) {
    return {
      name: tgt.name, img: tgt.img,
      tokenDocId: tgt.tokenDocId, actorId: tgt.actorId, sceneId: tgt.sceneId,
      saveTotal: null, passed: false, isAutoFail: false,
      resultLabel: verdict.label,
      damageMultiplier: 0,
      dieResult: null, roll: null,
      damageModifiers: tgt.damageModifiers,
      currentHP: tgt.currentHP, maxHP: tgt.maxHP,
      isPC, pending: false,
      noRoll: verdict.reason, noRollLabel: verdict.label, noRollTone: verdict.tone,
    };
  }

  /**
   * Did this target actually FAIL a saving throw?
   *
   * `passed === false` is NOT the same question, and conflating them is how a
   * gated target would get consequences it never rolled for. Three distinct
   * states share that falsy value:
   *   • pending  — a PC who has not rolled yet (the Jeth/Web bug, 2026-07-27)
   *   • noRoll   — the Gate refused; no die was ever thrown (2026-08-06)
   *   • genuine  — a die was thrown and it lost
   * Only the third is a failure. ONE reader so a fifth consumer can't get it
   * wrong the way four of them nearly did.
   */
  static _failedTheSave(r) {
    return !!r && r.pending !== true && !r.noRoll && r.passed === false;
  }

  async _rollSingleSave(tgt, saveAbility, saveDC, halfOnSave, casterActorId = null, options = {}) {
    const scene = game.scenes.get(tgt.sceneId) ?? canvas.scene;
    const tokenDoc = scene?.tokens?.get(tgt.tokenDocId);
    const targetActor = tokenDoc?.actor ?? game.actors.get(tgt.actorId);

    // ── THE GATE — nothing below this line rolls without passing it ─────────
    // No roll happened, so nothing lands and nothing is dealt. A dead creature
    // taking splash damage from a fireball it never saved against would be the
    // same class of nonsense in reverse — _noRollRow zeroes the multiplier.
    const _verdict = SaveEngine._verdictForTargetRow(tgt, {
      outcomeConditions: options.outcomeConditions ?? [],
      dealsDamage: !!options.dealsDamage,
    });
    if (_verdict) {
      console.log(`${MODULE_ID} | GATE: ${tgt.name} — ${_verdict.reason.toUpperCase()}, no save rolled.`);
      return SaveEngine._noRollRow(tgt, _verdict, { isPC: false });
    }

    let saveTotal = 0;
    let passed = false;
    let rollResult = null;
    let isAutoFail = tgt.autoFailSave;

    if (isAutoFail) {
      saveTotal = 0;
      passed = false;
    } else {
      // Determine advantage/disadvantage
      let rollMode = "normal";
      if (tgt.saveAdvantage && tgt.saveDisadvantage) rollMode = "normal";
      else if (tgt.saveAdvantage) rollMode = "advantage";
      else if (tgt.saveDisadvantage) rollMode = "disadvantage";

      // Build the roll formula
      // dnd5e 5.2.5: abilities.dex.save may be a number OR an object with .value
      // Save modifier via the target profile — ONE reader for a fact that
      // was being decoded seven different ways in this file alone.
      const saveMod = SaveEngine._targetProfileFor(targetActor, tgt)?.saveMod(saveAbility) ?? 0;
      const allBonusParts = (tgt.saveBonuses ?? []).map(b => b.value);

      // ── Cover DEX save bonus (half cover +2, three-quarters +5) ──
      if (saveAbility === "dex" && tokenDoc && casterActorId) {
        try {
          if (QolSettings.get("enableCoverCalculation")) {
            // Cover is measured from a POSITION, so it needs the exact body that
            // cast — the card stamped it at cast time. The old search took the
            // first token sharing the caster's actor, which with several unlinked
            // copies is a different creature standing somewhere else. (F-019)
            const casterTokenDoc = SaveEngine.casterTokenDocById(casterActorId, scene, options.casterTokenDocId);
            if (casterTokenDoc) {
              const coverResult = CoverEngine.calculateCover(casterTokenDoc, tokenDoc);
              if (coverResult?.dexSaveBonus > 0) {
                allBonusParts.push(coverResult.dexSaveBonus);
              }
            }
          }
        } catch (_) { /* cover check non-fatal */ }
      }

      // Filter out zero / empty / null bonuses so the formula doesn't show
      // ugly tails like "1d20 + 2 + 0" when a bonus entry was a no-op.
      const bonuses = allBonusParts
        .filter(b => {
          if (b == null || b === "") return false;
          if (b === 0 || b === "0") return false;
          // Numeric strings that resolve to 0 (e.g. "+0", "-0") — strip too
          const n = Number(b);
          if (Number.isFinite(n) && n === 0) return false;
          return true;
        })
        .join(" + ");
      const formula = rollMode === "advantage" ? `2d20kh + ${saveMod}${bonuses ? ` + ${bonuses}` : ""}`
                    : rollMode === "disadvantage" ? `2d20kl + ${saveMod}${bonuses ? ` + ${bonuses}` : ""}`
                    : `1d20 + ${saveMod}${bonuses ? ` + ${bonuses}` : ""}`;

      const roll = new Roll(formula);
      await roll.evaluate();

      // ── Visible Dice So Nice animation ──
      // Players want to SEE NPC saves roll across the screen, not just have
      // a number appear. DSN auto-fires for player-rolled saves via the
      // chat-message hook, but engine-rolled NPC saves bypass that. Fire
      // the animation here, then wait for the configurable pacing delay
      // before resolving the result.
      //
      // Pacing reads from QOL settings (Damage tab):
      //   • npcSaveAnimationDelay      — single-target  (default 1000ms)
      //   • npcSaveAnimationDelayMulti — per-save in batch (default 250ms)
      // The caller passes options.isMultiTarget=true when rolling a batch
      // (Mass Suggestion, Fireball, etc.) so multi-target casts don't
      // burn the full single-target delay per die.
      try {
        // Fire-and-forget: animation runs in background, we control wait
        // time via the setting (decoupled from DSN's own throw speed).
        safeShowForRoll(roll, "NPC save roll");
        const isMulti = !!options.isMultiTarget;
        let delay = isMulti
          ? (QolSettings.get("npcSaveAnimationDelayMulti") ?? 250)
          : (QolSettings.get("npcSaveAnimationDelay") ?? 1000);
        delay = Math.max(0, Math.min(5000, Number(delay) || 0));
        if (delay > 0) {
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      } catch (err) {
        console.warn(`${MODULE_ID} | DSN/pacing failed for save roll (non-fatal):`, err);
      }

      saveTotal = roll.total;
      passed = saveTotal >= saveDC;
      rollResult = roll;
    }

    // Determine damage multiplier
    let damageMultiplier = 1;
    let resultLabel = "FAIL";
    if (passed) {
      resultLabel = "PASS";
      if (tgt.superSaver) {
        damageMultiplier = 0; // Evasion: pass = 0 damage
        resultLabel = "PASS (EVASION)";
      } else if (halfOnSave) {
        damageMultiplier = 0.5;
        resultLabel = "PASS (HALF)";
      } else {
        damageMultiplier = 0;
        resultLabel = "PASS (NO DMG)";
      }
    } else {
      if (tgt.superSaver) {
        damageMultiplier = 0.5; // Evasion: fail = half damage
        resultLabel = "FAIL (EVASION: HALF)";
      } else {
        damageMultiplier = 1;
        resultLabel = isAutoFail ? "AUTO-FAIL" : "FAIL";
      }
    }

    // Extract the d20 face value so it survives flag serialization
    const _d20Term = rollResult?.dice?.[0];
    const dieResult = _d20Term?.total ?? null;

    return {
      name: tgt.name,
      img: tgt.img,
      tokenDocId: tgt.tokenDocId,
      actorId: tgt.actorId,
      sceneId: tgt.sceneId,
      saveTotal,
      passed,
      isAutoFail,
      resultLabel,
      damageMultiplier,
      dieResult,
      roll: rollResult,
      damageModifiers: tgt.damageModifiers,
      currentHP: tgt.currentHP,
      maxHP: tgt.maxHP,
      isPC: false,
      pending: false,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Roll Spell Damage (once, shared across all targets)
  // ═══════════════════════════════════════════════════════════════════════════

  async _rollSpellDamage(item, casterActor, opts = {}) {
    const rollData = casterActor?.getRollData?.() ?? {};
    const damageComponents = [];
    const rollsToShow = []; // DSN animations to fire in parallel

    const sys = item?.system ?? {};
    const activities = sys.activities;
    if (activities) {
      let actList = (typeof activities.forEach === "function")
        ? [...(activities.values?.() ?? activities)]
        : (typeof activities === "object" ? Object.values(activities) : []);

      // ── ROLL THE ABILITY THAT WAS ACTUALLY USED (2026-07-28) ──
      // This loop takes the FIRST activity that has damage and breaks. On a
      // single-activity item that's the right answer by luck. On a multi-
      // activity magic item it is simply wrong: firing the Staff of the
      // Stormforger's Thunderstorm of Misery (8d6 lightning, activity #4)
      // rolled Tornado Takedown's 1d6 bludgeoning + 2d6 lightning instead,
      // because Tornado Takedown is activity #1 and has damage. The save was
      // correct, the targets were correct, the DC was correct — only the dice
      // were somebody else's. Johnny caught it on the card:
      // "It rolled three fucking dice. It's got the wrong formula for it."
      //
      // When the caller knows which activity was used, that is the ONLY one we
      // consider. The old first-with-damage scan stays as the fallback for
      // callers that genuinely can't say.
      const usedId = opts.activityId ?? opts.activity?.id ?? null;
      if (usedId) {
        const only = actList.filter(a => a?.id === usedId);
        if (only.length) actList = only;
        else console.warn(`${MODULE_ID} | _rollSpellDamage: activity ${usedId} not found on "${item?.name}" — falling back to first-with-damage.`);
      } else {
        const withDamage = actList.filter(a => a?.damage?.parts?.length);
        if (withDamage.length > 1) {
          console.warn(`${MODULE_ID} | _rollSpellDamage: "${item?.name}" has ${withDamage.length} damaging activities and no activityId was supplied — rolling "${withDamage[0]?.name ?? withDamage[0]?.type}". Pass opts.activityId to be exact.`);
        }
      }

      for (const activity of actList) {
        if (!activity?.damage?.parts?.length) continue;

        // ── PRIMARY PATH: dnd5e's native rollDamage ──
        // Handles cantrip scaling at L5/11/17 (character-level based) AND
        // spell upcast scaling (slot-level based) when caller passes
        // opts.spellLevel. Returns Array<DamageRoll> with proper @scale
        // resolution, magic damage tagging, versatile/two-handed handling.
        let nativeRolledOk = false;
        try {
          if (typeof activity.rollDamage === "function") {
            const rollConfig = {};
            // Thread spell upcast level if caller supplied it (Burning Hands
            // at L3 = 5d6 instead of 3d6, etc.). Falls through to base level
            // when undefined — cantrip scaling still works regardless.
            if (Number.isFinite(opts.spellLevel)) {
              rollConfig.spell = { level: Number(opts.spellLevel) };
            }
            const damageRolls = await activity.rollDamage(
              rollConfig,
              { configure: false },          // skip the modify-roll dialog
              { create: false, rollMode: CONST.DICE_ROLL_MODES?.PUBLIC ?? "publicroll" }
            );
            if (Array.isArray(damageRolls) && damageRolls.length > 0) {
              for (const roll of damageRolls) {
                const optTypes = roll.options?.types;
                const optType  = roll.options?.type;
                const type = optType
                          ?? (Array.isArray(optTypes) && optTypes.length > 0 ? optTypes[0] : "untyped");
                damageComponents.push({
                  name:    item.name,
                  formula: roll.formula,
                  total:   roll.total,
                  type,
                  roll,
                });
                rollsToShow.push(roll);
              }
              nativeRolledOk = true;
            }
          }
        } catch (err) {
          console.warn(`${MODULE_ID} | activity.rollDamage failed, falling back to manual roll:`, err);
        }

        // ── FALLBACK: manual formula construction ──
        // Used when activity.rollDamage isn't available (older dnd5e,
        // non-spell items, malformed activity). No cantrip/upcast scaling
        // here — purely the literal formula in part.number/denomination.
        if (!nativeRolledOk) {
          for (const part of activity.damage.parts) {
            const formula = part.custom?.enabled
              ? part.custom.formula
              : `${part.number ?? 1}d${part.denomination ?? 6}${part.bonus ? `+${part.bonus}` : ""}`;
            const types = part.types ? [...part.types] : ["untyped"];
            const type = types[0] ?? "untyped";

            let resolved = formula.replace(/@([a-zA-Z0-9_.]+)/g, (match, path) => {
              const val = path.split(".").reduce((o, k) => o?.[k], rollData);
              return val !== undefined ? String(val) : "0";
            });

            const roll = new Roll(resolved);
            await roll.evaluate();
            damageComponents.push({ name: item.name, formula: resolved, total: roll.total, type, roll });
            rollsToShow.push(roll);
          }
        }

        break; // Only first activity with damage
      }
    }

    // ── Radiant Soul (Celestial Warlock 6+) — direct spell damage path ──
    // RAW: "Once per turn when you deal fire or radiant damage with a spell or
    // cantrip, you can add your Charisma modifier to that damage."
    // Find the first fire/radiant component and add CHA mod. Once-per-turn
    // enforced via actor flag. The spell-source check is implicit here
    // because _rollSpellDamage is ONLY called for spell items — every path
    // through this method qualifies as "damage with a spell or cantrip".
    try {
      const radiantSoulIdx = damageComponents.findIndex(c => {
        const t = String(c.type ?? "").toLowerCase();
        return t === "radiant" || t === "fire";
      });
      if (radiantSoulIdx !== -1) {
        const targetType = damageComponents[radiantSoulIdx].type;
        const chaBonus = CombatState.getRadiantSoulBonus(casterActor, targetType);
        if (chaBonus > 0) {
          // Mutate the component's total + display formula so the bonus shows
          // inline with the spell's damage rather than as a separate line.
          // Direct spell damage is a single roll per type — adding a sibling
          // component would split the visual into two pieces of the same
          // type, which reads worse on the merge card.
          const original = damageComponents[radiantSoulIdx];
          original.total = (original.total ?? 0) + chaBonus;
          original.formula = `${original.formula} + ${chaBonus} CHA (Radiant Soul)`;
          original.radiantSoulBonus = chaBonus;
          original.featureRiders = [...(original.featureRiders ?? []), { name: "Radiant Soul", bonus: chaBonus }];
          await CombatState.markRadiantSoulUsed(casterActor);
          console.log(`${MODULE_ID} | Radiant Soul: +${chaBonus} ${targetType} added to ${casterActor.name}'s ${item.name} (direct spell path)`);
        }
      }
    } catch (err) {
      console.warn(`${MODULE_ID} | Radiant Soul direct-spell rider check failed (non-fatal):`, err);
    }

    // ── Empowered Evocation (Wizard Evoker 10+) — INT mod to one damage roll
    //    of an evocation spell. Apply to the FIRST damage component since RAW
    //    says "one damage roll" (singular).
    try {
      const empoweredBonus = CombatState.getEmpoweredEvocationBonus(casterActor, item);
      if (empoweredBonus > 0 && damageComponents.length > 0) {
        const target = damageComponents[0];
        target.total = (target.total ?? 0) + empoweredBonus;
        target.formula = `${target.formula} + ${empoweredBonus} INT (Empowered Evocation)`;
        target.featureRiders = [...(target.featureRiders ?? []), { name: "Empowered Evocation", bonus: empoweredBonus }];
        console.log(`${MODULE_ID} | Empowered Evocation: +${empoweredBonus} ${target.type} added to ${casterActor.name}'s ${item.name} (Wizard Evoker INT mod)`);
      }
    } catch (err) {
      console.warn(`${MODULE_ID} | Empowered Evocation rider check failed (non-fatal):`, err);
    }

    // ── Potent Spellcasting (Cleric Light Domain 8+ / Druid Circle of the
    //    Land 14+) — WIS mod to cantrip damage. Apply to first damage
    //    component. Per RAW: "any cleric/druid cantrip" — applies every cast.
    try {
      const potentBonus = CombatState.getPotentSpellcastingBonus(casterActor, item);
      if (potentBonus > 0 && damageComponents.length > 0) {
        const target = damageComponents[0];
        target.total = (target.total ?? 0) + potentBonus;
        target.formula = `${target.formula} + ${potentBonus} WIS (Potent Spellcasting)`;
        target.featureRiders = [...(target.featureRiders ?? []), { name: "Potent Spellcasting", bonus: potentBonus }];
        console.log(`${MODULE_ID} | Potent Spellcasting: +${potentBonus} ${target.type} added to ${casterActor.name}'s ${item.name} (WIS mod on cantrip)`);
      }
    } catch (err) {
      console.warn(`${MODULE_ID} | Potent Spellcasting rider check failed (non-fatal):`, err);
    }

    // ── Agonizing Blast (Warlock invocation) — CHA mod per Eldritch Blast
    //    beam. Applies to EACH damage component (each beam is its own roll).
    //    Note: most Eldritch Blast routes go through attack-pipeline rather
    //    than save-engine — so this save-engine block primarily covers edge
    //    cases (homebrew save-based variants). The attack path is handled by
    //    the dnd5e.rollDamageV2 hook registered in ace-qol.mjs.
    try {
      const agonizingBonus = CombatState.getAgonizingBlastBonus(casterActor, item);
      if (agonizingBonus > 0) {
        for (const target of damageComponents) {
          target.total = (target.total ?? 0) + agonizingBonus;
          target.formula = `${target.formula} + ${agonizingBonus} CHA (Agonizing Blast)`;
          target.featureRiders = [...(target.featureRiders ?? []), { name: "Agonizing Blast", bonus: agonizingBonus }];
        }
        console.log(`${MODULE_ID} | Agonizing Blast: +${agonizingBonus} per beam added to ${casterActor.name}'s Eldritch Blast (CHA mod)`);
      }
    } catch (err) {
      console.warn(`${MODULE_ID} | Agonizing Blast rider check failed (non-fatal):`, err);
    }

    // ── Visible Dice So Nice animation for spell damage ──
    // Save rolls already animate via the save-engine path. Damage rolls were
    // silently evaluated, so the merge card displayed totals without any dice
    // crossing the table. Now we fire DSN for every damage component (one
    // per damage type) in parallel, then wait a configurable pacing delay
    // before the merge card draws — same pattern as save rolls. Animation
    // is broadcast (3rd arg true) so PCs see NPC damage dice and vice versa.
    try {
      if (rollsToShow.length > 0) {
        for (const r of rollsToShow) {
          safeShowForRoll(r, "NPC damage roll");
        }
        let delay = QolSettings.get("npcDamageAnimationDelay") ?? 1500;
        delay = Math.max(0, Math.min(8000, Number(delay) || 0));
        if (delay > 0) {
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    } catch (err) {
      console.warn(`${MODULE_ID} | DSN/pacing failed for damage roll (non-fatal):`, err);
    }

    return damageComponents;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  PC Whispered Save Prompt
  // ═══════════════════════════════════════════════════════════════════════════

  async _sendPcSavePrompt(item, casterActor, tgt, opts) {
    const { saveAbility, saveDC, halfOnSave, damageTypes, isSpell, castId } = opts;
    const abilityLabel = CONFIG.DND5E?.abilities?.[saveAbility]?.label ?? saveAbility.toUpperCase();

    // Player-facing prompt — mirrors the DM-side row: pure BLACK background,
    // the creature's token icon with the glowing black d20 directly beneath it,
    // name + instruction to the right (no cropped pill button). Inline-styled
    // so it renders identically on the player's client. Keeps the data-action
    // + button classes intact so the existing click wiring still fires.
    const pcImg = tgt.img || tgt.tokenImg || item.img || "icons/svg/mystery-man.svg";
    const cardHtml = `
      <div class="ace-qol-pc-save-card" style="background:#0c0c10;border:1px solid #d4af37;border-radius:9px;overflow:hidden;font-family:'Signika',sans-serif;">
        <div style="padding:11px 15px;border-bottom:1px solid rgba(212,175,55,0.3);background:#0c0c10;">
          <div style="color:#f0e4c0;font-weight:700;font-size:19px;line-height:1.15;">${item.name}</div>
          <div style="color:#d4af37;font-size:15px;font-weight:600;margin-top:3px;">DC ${saveDC} ${abilityLabel} Save</div>
        </div>
        <div style="display:flex;align-items:center;gap:15px;padding:15px;background:#0c0c10;">
          <div style="display:flex;flex-direction:column;align-items:center;gap:8px;flex-shrink:0;">
            <img src="${pcImg}" style="width:54px;height:54px;border-radius:8px;border:1px solid #d4af37;object-fit:cover;" />
            <button class="ace-qol-btn ace-qol-btn-roll" data-action="aceQolRollPcSave" title="Roll your ${abilityLabel} save"
                    style="background:none;border:none;cursor:pointer;padding:0;display:inline-flex;">
              ${aceD20FaceImg(20, { size: 46, glow: true })}
            </button>
          </div>
          <div style="flex:1;min-width:0;">
            <div style="color:#fff;font-weight:700;font-size:18px;line-height:1.2;">${tgt.name}</div>
            <div style="color:#cdbf8f;font-size:15px;margin-top:5px;line-height:1.3;">Tap the die to roll your <b style="color:#d4af37;">${abilityLabel} save</b>.</div>
          </div>
        </div>
      </div>
    `;

    // ── WHO SEES THIS PROMPT — and it is NEVER "everyone" (audit F-020) ──
    // Whisper to the player(s) who own this creature. The GM doesn't need one;
    // they have the dice button on the cast card.
    //
    // ⚠️ AN EMPTY WHISPER LIST IS PUBLIC IN FOUNDRY. That is the whole bug: a
    // character owned through the DEFAULT level produced an empty list, so its
    // private "roll your save" card went to the whole table and anyone could
    // click it. `ownerIds` is now built by asking the engine, but this is the
    // last gate, so it re-asks the live actor and — if there is genuinely
    // nobody — falls back to the GM. A prompt meant for one person must never
    // become an open invitation just because a lookup came back empty.
    let whisperIds = (tgt.ownerIds ?? []).filter(id => !game.users.get(id)?.isGM);
    if (!whisperIds.length) {
      const scene = game.scenes.get(tgt.sceneId) ?? canvas.scene;
      const tActor = scene?.tokens?.get(tgt.tokenDocId)?.actor ?? game.actors.get(tgt.actorId);
      whisperIds = SaveEngine.ownerUserIds(tActor);
      if (whisperIds.length) {
        console.debug(`${MODULE_ID} | save prompt for ${tgt.name}: owner list was empty, re-read ${whisperIds.length} owner(s) from the actor.`);
      }
    }
    if (!whisperIds.length) {
      whisperIds = (game.users?.filter(u => u.isGM) ?? []).map(u => u.id);
      console.warn(`${MODULE_ID} | save prompt for ${tgt.name}: no player owns this creature — whispering to the GM instead of posting it publicly.`);
    }

    // Let NPC save dice settle before posting the result card.
    await awaitDsnRoll();

    await ChatMessage.create({
      content: cardHtml,
      speaker: ChatMessage.getSpeaker({ alias: tgt.name }),
      whisper: whisperIds,
      flags: {
        [MODULE_ID]: {
          type: "pcSavePrompt",
          itemId: item.id,
          itemUuid: item.uuid,
          actorId: tgt.actorId,
          tokenDocId: tgt.tokenDocId,
          sceneId: tgt.sceneId,
          // ── WHO CAST IT (audit F-019, 2026-08-07) ──
          // `casterActorId` was NEVER written on a save prompt, and the cover
          // lookup in _rollPcSave falls back to `flags.actorId` — which on this
          // message is the TARGET's own actor. So cover was measured from the
          // target to itself, always came back zero, and the DEX-save cover
          // bonus has never once applied to a player character. Write the real
          // caster, plus the exact token, because cover is about a position.
          casterActorId:    casterActor?.id ?? null,
          casterTokenDocId: SaveEngine.casterTokenDoc(casterActor, { sceneId: tgt.sceneId })?.id ?? null,
          saveAbility,
          saveDC,
          halfOnSave,
          damageTypes,
          isSpell,
          targetName: tgt.name,
          targetImg: tgt.img,
          autoFailSave: tgt.autoFailSave,
          saveAdvantage: tgt.saveAdvantage,
          saveDisadvantage: tgt.saveDisadvantage,
          superSaver: tgt.superSaver,
          semiSuperSaver: tgt.semiSuperSaver,
          saveBonuses: tgt.saveBonuses,
          damageModifiers: tgt.damageModifiers,
          currentHP: tgt.currentHP,
          maxHP: tgt.maxHP,
          castId,
        }
      }
    });

    // ── Hand back to the GM if nobody rolls (2026-07-28) ──
    // The player's dice stay theirs — we never auto-roll for someone who's
    // online. But an empty chair must not freeze the table, so after the grace
    // period the GM gets a whispered ROLL FOR THEM card. This used to exist
    // only for repeating saves; every waiting save now shares the one timer.
    try {
      const { PcSaveNudge } = await import("./pc-save-nudge.mjs");
      const ownerName = (tgt.ownerIds ?? [])
        .map(id => game.users.get(id))
        .find(u => u && !u.isGM && u.active)?.name ?? "the player";
      PcSaveNudge.arm({
        key: `${castId}:${tgt.tokenDocId}`,
        targetName: tgt.name ?? "Target",
        playerName: ownerName,
        abilityLabel,
        dc: saveDC,
        sourceName: item?.name ?? "",
        onRoll: () => this._gmRollPcSaveOffline(item, casterActor, tgt, {
          saveAbility, saveDC, halfOnSave, damageTypes, isSpell, castId,
        }),
      });
    } catch (err) {
      console.warn(`${MODULE_ID} | couldn't arm the save nudge (non-fatal):`, err);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  PC Rolls Their Own Save
  // ═══════════════════════════════════════════════════════════════════════════

  async _rollPcSave(message) {
    const flags = message.flags?.[MODULE_ID];
    if (!flags) return;

    const { saveAbility, saveDC, halfOnSave, tokenDocId, sceneId, actorId,
            autoFailSave, saveAdvantage, saveDisadvantage, superSaver,
            saveBonuses, targetName, targetImg, castId } = flags;

    const scene = game.scenes.get(sceneId) ?? canvas.scene;
    const tokenDoc = scene?.tokens?.get(tokenDocId);
    const targetActor = tokenDoc?.actor
      ?? game.actors.get(actorId)
      ?? game.user.character;  // Fallback: player's assigned character
    if (!targetActor) {
      console.error(`${MODULE_ID} | _rollPcSave: Could not find actor for ${targetName} (actorId: ${actorId})`);
      ui.notifications.error("Could not find your character to roll the save.");
      return;
    }

    const abilityLabel = CONFIG.DND5E?.abilities?.[saveAbility]?.label ?? saveAbility.toUpperCase();
    let saveTotal = 0;
    let passed = false;
    let rollResult = null;

    if (autoFailSave) {
      saveTotal = 0;
      passed = false;
    } else {
      let rollMode = "normal";
      if (saveAdvantage && saveDisadvantage) rollMode = "normal";
      else if (saveAdvantage) rollMode = "advantage";
      else if (saveDisadvantage) rollMode = "disadvantage";

      // Save modifier via the target profile — ONE reader for a fact that
      // was being decoded seven different ways in this file alone.
      //
      // ⚠️ `tgt` DID NOT EXIST IN THIS SCOPE (2026-07-28). This function takes a
      // MESSAGE, not a target row — the identifier was never declared here, so
      // every call threw a ReferenceError before it could roll. _rollPcSave is
      // the only roller both for a player's own save AND for the GM's roll on
      // behalf of an absent player, so BOTH died silently and the row sat on
      // "WAITING FOR PLAYER" forever. `node --check` cannot catch this — an
      // undefined identifier is valid syntax and only explodes at runtime.
      // Copy-pasting a line out of _rollSingleSave(tgt, …) is how it got here.
      const _row = { tokenDocId, sceneId, actorId };
      const saveMod = SaveEngine._targetProfileFor(targetActor, _row)?.saveMod(saveAbility) ?? 0;
      const allBonusParts = (saveBonuses ?? []).map(b => b.value);

      // ── Cover DEX save bonus (half cover +2, three-quarters +5) ──
      if (saveAbility === "dex" && tokenDoc) {
        try {
          if (QolSettings.get("enableCoverCalculation")) {
            // The exact caster token the cast card stamped — see the matching
            // note in _rollSingleSave. (F-019)
            const casterActorId = flags.casterActorId ?? flags.actorId;
            const casterTokenDoc = SaveEngine.casterTokenDocById(casterActorId, scene, flags.casterTokenDocId);
            if (casterTokenDoc) {
              const coverResult = CoverEngine.calculateCover(casterTokenDoc, tokenDoc);
              if (coverResult?.dexSaveBonus > 0) {
                allBonusParts.push(coverResult.dexSaveBonus);
              }
            }
          }
        } catch (_) { /* cover check non-fatal */ }
      }

      // Filter out zero / empty / null bonuses so the formula doesn't show
      // ugly tails like "1d20 + 2 + 0" when a bonus entry was a no-op.
      const bonuses = allBonusParts
        .filter(b => {
          if (b == null || b === "") return false;
          if (b === 0 || b === "0") return false;
          // Numeric strings that resolve to 0 (e.g. "+0", "-0") — strip too
          const n = Number(b);
          if (Number.isFinite(n) && n === 0) return false;
          return true;
        })
        .join(" + ");
      const formula = rollMode === "advantage" ? `2d20kh + ${saveMod}${bonuses ? ` + ${bonuses}` : ""}`
                    : rollMode === "disadvantage" ? `2d20kl + ${saveMod}${bonuses ? ` + ${bonuses}` : ""}`
                    : `1d20 + ${saveMod}${bonuses ? ` + ${bonuses}` : ""}`;

      const roll = new Roll(formula);
      await roll.evaluate();
      saveTotal = roll.total;
      passed = saveTotal >= saveDC;
      rollResult = roll;

      // Trigger Dice So Nice 3D animation — public so all players see it
      safeShowForRoll(roll, "GM-prompt save roll");
    }

    // Extract d20 face for display on the results card
    const _pcD20 = rollResult?.dice?.[0];
    const dieResult = _pcD20?.total ?? null;

    // ── HOW MUCH DAMAGE THIS SAVE EARNED — DECIDED HERE, ONCE (2026-08-07) ──
    // Computed at the roll, where `halfOnSave` is actually in scope, and stamped
    // INTO the result message below. The GM-side handler used to re-derive this
    // from the message and assumed every successful save meant half damage
    // ("most common for AoE"), which is wrong for every power that deals NOTHING
    // on a success — Word of Radiance, Thunderclap, Sword Burst, Toll the Dead.
    // A player who SAVED was taking half anyway.
    //
    // Same principle as the rest of this file's 07-28 rebuild: the roller RETURNS
    // its result and stamps its claim into the message; nobody downstream
    // re-derives a fact they don't have the inputs for.
    const _pcMultiplier = passed
      ? (superSaver ? 0 : (halfOnSave ? 0.5 : 0))
      : (superSaver ? 0.5 : 1);

    // Determine result label
    let resultLabel;
    if (passed) {
      if (superSaver) resultLabel = "PASS (EVASION)";
      else if (halfOnSave) resultLabel = "PASS (HALF)";
      else resultLabel = "PASS (NO DMG)";
    } else {
      if (superSaver) resultLabel = "FAIL (EVASION: HALF)";
      else if (autoFailSave) resultLabel = "AUTO-FAIL";
      else resultLabel = "FAIL";
    }

    const passClass = passed ? "ace-qol-save-pass" : "ace-qol-save-fail";
    const rollDisplay = autoFailSave ? "AUTO" : saveTotal;
    const reasonText = autoFailSave
      ? `AUTO-FAIL (condition)`
      : passed
        ? `Rolled ${saveTotal} \u2014 SAVED (DC ${saveDC})`
        : `Rolled ${saveTotal} \u2014 FAILED (DC ${saveDC})`;

    // Post public result — clean, matches D&D 5e card style
    const passColor = passed ? "#00e676" : "#ff1744";
    // Big, black, readable result — d20 face under the portrait + full
    // breakdown (raw +mod = total), matching the DM cards.
    const _bdMod  = (dieResult != null && typeof saveTotal === "number") ? saveTotal - dieResult : null;
    const _bdSign = (_bdMod != null && _bdMod >= 0) ? "+" : "";
    const _bdPart = (_bdMod != null && _bdMod !== 0) ? ` ${_bdSign}${_bdMod}` : "";
    const _faceHtml = autoFailSave ? "" : aceD20FaceImg(dieResult, { size: 44, glow: true });
    const resultHtml = `
      <div class="ace-qol-save-pc-result-card" style="background:#0c0c10;border:1px solid #d4af37;border-radius:9px;overflow:hidden;font-family:'Signika',sans-serif;">
        <div style="display:flex;align-items:center;gap:14px;padding:14px;">
          <div style="display:flex;flex-direction:column;align-items:center;gap:6px;flex-shrink:0;">
            <img src="${targetImg || "icons/svg/mystery-man.svg"}" style="width:50px;height:50px;border-radius:8px;border:1px solid #d4af37;object-fit:cover;" />
            ${_faceHtml}
          </div>
          <div style="flex:1;min-width:0;">
            <div style="color:#fff;font-weight:700;font-size:18px;line-height:1.2;">${targetName}</div>
            <div style="margin-top:6px;display:flex;align-items:center;gap:7px;flex-wrap:wrap;">
              ${autoFailSave
                ? `<span style="color:${passColor};font-weight:700;font-size:18px;">AUTO-FAIL</span>`
                : `<span style="color:#fff;font-size:20px;font-weight:700;">${dieResult ?? saveTotal}</span>
                   <span style="color:#b9a978;font-size:15px;">${_bdPart} =</span>
                   <span style="color:${passColor};font-size:20px;font-weight:700;">${saveTotal}</span>`}
              <span style="margin-left:4px;padding:2px 9px;border-radius:5px;background:${passed ? 'rgba(0,230,118,0.15)' : 'rgba(255,23,68,0.15)'};color:${passColor};font-weight:700;font-size:15px;">${resultLabel}</span>
            </div>
          </div>
        </div>
      </div>
    `;

    // Let PC save dice settle before posting the result card.
    await awaitDsnRoll();

    await ChatMessage.create({
      content: resultHtml,
      speaker: ChatMessage.getSpeaker({ alias: targetName }),
      flags: {
        [MODULE_ID]: {
          type: "pcSaveResult",
          tokenDocId,
          actorId,
          sceneId,
          saveTotal,
          dieResult,
          passed,
          resultLabel,
          autoFailSave,
          superSaver,
          castId,
          saveAbility,                       // needed so the GM can re-fire saveComplete
          itemUuid: flags.itemUuid ?? null,
          rolledByGm: game.user.isGM,        // so a PC's client can show "GM" + grey its button
          // THE CLAIM, STAMPED AT BIRTH. The GM reads these instead of guessing.
          halfOnSave: halfOnSave === true,
          damageMultiplier: _pcMultiplier,
        }
      }
    });

    // ── Emit saveComplete hook for PC save (duration tracker isSave expiry) ──
    try {
      if (targetActor) {
        Hooks.callAll(`${MODULE_ID}.saveComplete`, { actor: targetActor, tokenDocId, saveAbility, passed, itemUuid: flags.itemUuid ?? null });
      }
    } catch (_) { /* non-fatal */ }

    // ── Update the main save results card's pending row for this PC ──
    // Determine damage multiplier same as NPC saves
    let damageMultiplier;
    if (passed) {
      if (superSaver) damageMultiplier = 0;        // Evasion pass = 0 damage
      else if (halfOnSave) damageMultiplier = 0.5;  // Half on save
      else damageMultiplier = 0;                     // No damage on save
    } else {
      if (superSaver) damageMultiplier = 0.5;        // Evasion fail = half
      else damageMultiplier = 1;                     // Full damage
    }

    // Main card update happens via renderChatMessage hook on GM client
    // (players don't have permission to edit GM-whispered messages)

    // Collapse any PC save prompt cards for this token
    const chatLog = document.querySelector("#chat-log, .chat-log");
    if (chatLog) {
      const promptCards = chatLog.querySelectorAll(".chat-message");
      for (const card of promptCards) {
        const cardMsg = game.messages.get(card.dataset.messageId);
        const cardFlags = cardMsg?.flags?.[MODULE_ID];
        if (cardFlags?.type === "pcSavePrompt" && cardFlags.tokenDocId === tokenDocId) {
          card.classList.add("ace-qol-save-collapsed");
        }
      }
    }

    // HAND THE RESULT BACK (2026-07-28). This used to return nothing, so the
    // only way for anything else to learn the outcome was to go looking for the
    // chat message it had just posted — which is what made the results card
    // search the log, and what made it lose a race to its own dice animation.
    // A caller that is standing right here should never have to go find this.
    return {
      tokenDocId, actorId, sceneId,
      saveTotal, dieResult, passed, resultLabel,
      autoFailSave, superSaver, damageMultiplier,
      saveAbility,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  GM: Handle PC Save Result Posted (from renderChatMessage hook)
  // ═══════════════════════════════════════════════════════════════════════════

  _onPcSaveResultPosted(resultFlags) {
    console.log(`${MODULE_ID} | _onPcSaveResultPosted fired for tokenDocId:`, resultFlags.tokenDocId, "passed:", resultFlags.passed);
    const { tokenDocId, saveTotal, dieResult, passed, resultLabel, autoFailSave, superSaver } = resultFlags;

    // The player rolled — stand the GM nudge down before it ever fires, and
    // retire the card if it already did.
    try {
      import("./pc-save-nudge.mjs").then(({ PcSaveNudge }) =>
        PcSaveNudge.disarm(`${resultFlags.castId}:${tokenDocId}`, "The player rolled it themselves."));
    } catch (_) { /* non-fatal */ }

    // ── HOW MUCH DAMAGE THIS SAVE EARNED — READ, NEVER GUESSED (2026-08-07) ──
    // This block used to be:
    //     if (passed) { superSaver ? 0 : 0.5 }   // "half on save (most common for AoE)"
    // It never looked at whether the power ACTUALLY grants half damage on a
    // success. For every power that deals NOTHING on a success — Word of
    // Radiance, Thunderclap, Sword Burst, Toll the Dead — a player who SAVED
    // was handed a half-damage multiplier, and this is the LAST writer for the
    // normal case (card posts "waiting for player", player rolls). Straight
    // through Phase 2 and APPLY ALL into their hit points.
    //
    // The roller already worked this out with `halfOnSave` in scope and stamped
    // it into the message. Read that. The fallbacks below exist only for a
    // result message written before this fix, and each one still reads the real
    // flag rather than assuming a value.
    let damageMultiplier = Number(resultFlags.damageMultiplier);
    if (!Number.isFinite(damageMultiplier)) {
      let half = resultFlags.halfOnSave;
      if (typeof half !== "boolean") {
        // Older message: ask the cast card this result belongs to.
        half = SaveEngine._halfOnSaveForCast(resultFlags.castId);
      }
      damageMultiplier = passed
        ? (superSaver ? 0 : (half ? 0.5 : 0))
        : (superSaver ? 0.5 : 1);
      console.debug(`${MODULE_ID} | pcSaveResult had no stamped multiplier — derived ${damageMultiplier} (halfOnSave=${half}).`);
    }

    const pcResult = { saveTotal, dieResult: dieResult ?? null, passed, resultLabel, autoFailSave, damageMultiplier };

    // ── Re-fire saveComplete on the GM so area-denial effects land ──
    // FIRST, before the cosmetic card updates — a throw in those must never
    // block the functional restraint application (it did: a stale variable in
    // _updateTargetListPcRow aborted this whole handler, so failed PCs walked
    // free). The area-denial restraint (Web, etc.) is applied GM-side off the
    // `saveComplete` hook; when a PLAYER rolls, the original saveComplete fired
    // only on THEIR client (Hooks.callAll is local), so the GM never heard it.
    // The pcSaveResult chat message DOES reach the GM, so re-emit here on the
    // active GM. Idempotent: if the GM was the roller the pending-save queue is
    // already empty, so this second call simply no-ops.
    try {
      if (game.user === game.users?.activeGM && resultFlags.saveAbility) {
        const scene = game.scenes.get(resultFlags.sceneId) ?? canvas.scene;
        const actor = scene?.tokens?.get(tokenDocId)?.actor ?? game.actors.get(resultFlags.actorId);
        if (actor) {
          Hooks.callAll(`${MODULE_ID}.saveComplete`, {
            actor, tokenDocId, saveAbility: resultFlags.saveAbility,
            passed, itemUuid: resultFlags.itemUuid ?? null,
          });
        }
      }
    } catch (err) {
      console.warn(`${MODULE_ID} | GM saveComplete re-emit failed:`, err);
    }

    // Cosmetic card updates — each shielded so one failing can't break the rest.
    try { this._updateMainCardPcResult(tokenDocId, pcResult, resultFlags?.castId ?? null); }
    catch (err) { console.warn(`${MODULE_ID} | main-card PC result update failed:`, err); }
    try { this._updateTargetListPcRow(tokenDocId, pcResult); }
    catch (err) { console.warn(`${MODULE_ID} | target-list PC row update failed:`, err); }

    // Collapse the PC prompt card on GM side
    const chatLog = document.querySelector("#chat-log, .chat-log");
    if (chatLog) {
      for (const card of chatLog.querySelectorAll(".chat-message")) {
        const cardMsg = game.messages.get(card.dataset.messageId);
        const f = cardMsg?.flags?.[MODULE_ID];
        if (f?.type === "pcSavePrompt" && f.tokenDocId === tokenDocId) {
          card.classList.add("ace-qol-save-collapsed");
        }
      }
    }
  }

  /**
   * Does the power behind this cast deal half damage on a SUCCESSFUL save?
   *
   * Only used to rescue a `pcSaveResult` message written before the multiplier
   * was stamped at the roll. Keyed by cast, so it reads THIS cast's card and
   * never the newest one in the log. Returns false when it genuinely cannot
   * tell — a power that grants nothing on a success is the safe reading, and
   * assuming "half" is the exact bug this replaces.
   */
  static _halfOnSaveForCast(castId) {
    if (!castId) return false;
    try {
      const direct = game.messages.get(castId)?.flags?.[MODULE_ID];
      if (typeof direct?.halfOnSave === "boolean") return direct.halfOnSave;
      for (const m of game.messages.contents) {
        const f = m.flags?.[MODULE_ID];
        if (f?.castId === castId && typeof f.halfOnSave === "boolean") return f.halfOnSave;
      }
    } catch (err) {
      console.warn(`${MODULE_ID} | couldn't read halfOnSave for cast ${castId}:`, err);
    }
    return false;
  }

  /**
   * Update a PC row on the target list card with their save result (live update).
   */
  _updateTargetListPcRow(tokenDocId, pcResult) {
    console.log(`${MODULE_ID} | _updateTargetListPcRow looking for tokenDocId:`, tokenDocId);

    // Search the entire document — V13 chat containers vary
    const row = document.querySelector(`.ace-qol-save-tgt-row[data-token-doc-id="${tokenDocId}"]`);
    if (!row) { console.log(`${MODULE_ID} | Row not found in DOM`); return; }
    {

      const passClass = pcResult.passed ? "ace-qol-save-pass" : "ace-qol-save-fail";
      // ⚠️🔴 THE PC ROW THREW THE REASON AWAY. This read
      // `passed ? "PASS" : "FAIL"` and nothing else, so a player who took an
      // unexpected amount of damage got no explanation at all - while the NPC
      // path a few hundred lines up has built "FAIL (EVASION: HALF)" the whole
      // time.
      //
      // Johnny, 2026-08-27: Jet failed a Fireball save and took half. That is
      // Evasion working exactly to RAW (succeed for none, fail for half), and
      // ACE had it right - it just never said so, so it read as a bug. Being
      // right and silent is indistinguishable from being wrong.
      //
      // ⚠️ PREFER THE LABEL THE ENGINE ALREADY BUILT, and only compose one
      // if it is genuinely absent - two places deciding the same wording is how
      // they drift apart.
      const verdictText = pcResult.resultLabel
        ?? (pcResult.passed
              ? (pcResult.superSaver ? "PASS (EVASION)" : "PASS")
              : (pcResult.superSaver ? "FAIL (EVASION: HALF)" : "FAIL"));

      // Replace the dice button + mod with the FULL d20 breakdown (face + raw +mod = total)
      const modSpan = row.querySelector(".ace-qol-save-tgt-mod");
      if (modSpan) modSpan.innerHTML = aceInlineRollBreakdown(pcResult, passClass);

      const rollBtn = row.querySelector(".ace-qol-save-pc-roll-btn");
      if (rollBtn) {
        rollBtn.disabled = true;
        // If a GM rolled this PC's save (shown on the player's own client), tag
        // it "GM" so the player knows it was rolled for them and is spent.
        const gmTag = (pcResult.rolledByGm && !game.user.isGM)
          ? `<span title="Rolled by the GM" style="font-size:9px;font-weight:700;color:#8a7d68;letter-spacing:0.4px;margin-right:4px;">GM</span>`
          : "";
        rollBtn.innerHTML = `${gmTag}<span class="ace-qol-save-verdict ${passClass}" style="font-size:13px;font-weight:700;">${verdictText}</span>`;
        rollBtn.style.background = "none";
        rollBtn.style.border = "none";
        rollBtn.style.padding = "0 4px";
      }

      // ── Bottom action button reconciliation + template auto-delete ──
      // After this PC rolled, check if any PC roll buttons are still pending.
      // If no PCs left to roll AND no NPCs left to roll:
      //   1. Change bottom button to "ALL ROLLED" terminal state
      //   2. Auto-delete the AOE template (so the spell visual goes away —
      //      the existing _deleteInstantTemplate path only fires on full save
      //      completion / Phase 2, not on the "PCs roll individually" path)
      try {
        const chatEl = row.closest(".chat-message");
        const card = row.closest(".ace-qol-save-target-card") ?? chatEl;
        const pendingPcRolls = card?.querySelectorAll?.(".ace-qol-save-pc-roll-btn:not([disabled])") ?? [];
        const pendingNpcRolls = card?.querySelectorAll?.(".ace-qol-save-tgt-row[data-pc='false']:not([data-rolled])") ?? [];
        const bottomBtn = card?.querySelector?.("[data-action='aceQolRollNpcSaves']");
        if (bottomBtn && pendingPcRolls.length === 0 && pendingNpcRolls.length === 0) {
          bottomBtn.disabled = true;
          bottomBtn.innerHTML = `<i class="fas fa-check"></i> ALL ROLLED`;
          bottomBtn.classList?.add?.("ace-qol-btn-done");

          // Trigger template auto-delete (was only firing on full result-card
          // completion paths). Look up the message from the chat element's
          // data-message-id, fetch flags, hand to _deleteInstantTemplate.
          try {
            const msgId = chatEl?.dataset?.messageId;
            const msg = msgId ? game.messages.get(msgId) : null;
            const flags = msg?.flags?.[MODULE_ID];
            if (flags) this._deleteInstantTemplate(flags);
          } catch (err) {
            console.warn(`${MODULE_ID} | Template auto-delete on PC-only completion threw:`, err);
          }
        }
      } catch (err) {
        console.warn(`${MODULE_ID} | Bottom-button reconciliation threw:`, err);
      }

      console.log(`${MODULE_ID} | Updated target list PC row: ${verdictText} (${pcResult.saveTotal})`);
      return;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Update Main Save Results Card with PC Save Result
  // ═══════════════════════════════════════════════════════════════════════════

  async _updateMainCardPcResult(tokenDocId, pcResult, castId = null) {
    // ⚠️ MATCH THE CAST, NOT "THE NEWEST CARD" (2026-07-28).
    // This used to take the first saveResults card it found scanning backwards —
    // ANY cast's. Cast the same power at three creatures in a row and a result
    // lands on the wrong card: two unrelated targets sharing one card, and the
    // right card left sitting on WAITING FOR PLAYER because its own result was
    // written somewhere else.
    //
    // castId is the target-list card's id for a normal cast, and the results
    // card's OWN id for targets added to an existing card — accept either.
    // If nothing matches, write NOTHING: the pcSaveResult message still exists
    // and the card picks it up by castId when it is built. Writing into an
    // unrelated card is strictly worse than writing nowhere.
    // No window. It used to take the last 120 messages, which is just a slower
    // version of the 30-message bug: a player who rolls after a busy stretch
    // falls off the end and their result goes nowhere. Now that this is keyed
    // by cast, the whole log is the correct search space and the match is exact.
    const messages = [...game.messages.contents].reverse();
    let msg = null;
    for (const m of messages) {
      const f = m.flags?.[MODULE_ID];
      if (f?.type !== "saveResults" || !Array.isArray(f.allResults)) continue;
      if (castId) {
        if (f.castId === castId || m.id === castId) { msg = m; break; }
        continue;
      }
      // No castId to match on (legacy card) — at least require that the card
      // already knows about this target rather than grabbing a stranger's.
      if (f.allResults.some(r => r?.tokenDocId === tokenDocId)) { msg = m; break; }
    }
    if (!msg) {
      console.debug(`${MODULE_ID} | PC result for ${tokenDocId} has no matching save card yet (cast ${castId ?? "?"}) — the card will read it back by castId when built.`);
      return;
    }

    // Serialize writes per message — two PCs rolling in the same ~200ms window
    // both call this function, both read stale allResults, and the second write
    // overwrites the first PC's result. The queue ensures each write completes
    // before the next one reads flags (Foundry updates in-memory after msg.update).
    const key = msg.id;
    const prev = this._pcSaveUpdateQueue.get(key) ?? Promise.resolve();
    const next = prev.then(() =>
      this._doUpdateMainCardPcResult(msg, tokenDocId, pcResult).catch(err => {
        console.error(`${MODULE_ID} | PC save card update failed:`, err);
      })
    );
    this._pcSaveUpdateQueue.set(key, next);
    next.then(() => {
      if (this._pcSaveUpdateQueue.get(key) === next) this._pcSaveUpdateQueue.delete(key);
    });
    return next;
  }

  async _doUpdateMainCardPcResult(msg, tokenDocId, pcResult) {
    // Three cases:
    //   (a) PC entry exists as pending → update in place
    //   (b) PC entry exists already resolved → REPLACE (re-roll after X+re-add)
    //   (c) PC not in allResults at all → append as new resolved entry (late-add)
    // Read flags FRESH from msg — after a prior queued write, msg.flags has been updated.
    const flags = msg.flags?.[MODULE_ID];
    const allResults = [...(flags.allResults ?? [])];
    let idx = allResults.findIndex(r => r.tokenDocId === tokenDocId);

    if (idx < 0) {
      // Case (c): late-add — build a fresh resolved entry
      const scene = game.scenes.get(canvas.scene?.id) ?? canvas.scene;
      const tokenDoc = scene?.tokens?.get(tokenDocId);
      const actor = tokenDoc?.actor;
      allResults.push({
        name:       tokenDoc?.name ?? actor?.name ?? "Unknown",
        img:        tokenDoc?.texture?.src ?? actor?.img ?? "icons/svg/mystery-man.svg",
        tokenDocId,
        actorId:    actor?.id,
        sceneId:    scene?.id,
        saveTotal:  pcResult.saveTotal,
        passed:     pcResult.passed,
        isAutoFail: pcResult.autoFailSave,
        resultLabel: pcResult.resultLabel,
        damageMultiplier: pcResult.damageMultiplier,
        damageModifiers: {},
        // ⚠️ `r` IS IN ITS TEMPORAL DEAD ZONE HERE (2026-07-28). `const r` is
        // declared BELOW this block, so reading it here throws "Cannot access
        // 'r' before initialization" — killing the whole update for any PC not
        // already on the card. Same copy-paste class as the `tgt` bug in
        // _rollPcSave, and equally invisible to `node --check`.
        // The row is being CREATED here; key the profile off this token.
        currentHP:  SaveEngine._targetProfileFor(actor, { tokenDocId, sceneId: scene?.id })?.hp.value ?? 0,
        maxHP:      SaveEngine._targetProfileFor(actor, { tokenDocId, sceneId: scene?.id })?.hp.max ?? 0,
        isPC:       true,
        pending:    false,
      });
      idx = allResults.length - 1;
    }

    // Apply pcResult to the entry at idx (covers a, b, and c cases)
    const r = allResults[idx];
    r.pending = false;
    r.saveTotal = pcResult.saveTotal;
    r.dieResult = pcResult.dieResult ?? null;
    r.passed = pcResult.passed;
    r.resultLabel = pcResult.resultLabel;
    r.isAutoFail = pcResult.autoFailSave;
    r.damageMultiplier = pcResult.damageMultiplier;

    // Refresh live HP from the actor (PC may have taken damage since card was built)
    try {
      const scene = game.scenes.get(r.sceneId) ?? canvas.scene;
      const tokenDoc = scene?.tokens?.get(r.tokenDocId);
      const actor = tokenDoc?.actor ?? game.actors.get(r.actorId);
      // ⚠️ LIVE READ ON PURPOSE — do NOT route through the profile. This
      // deliberately refreshes HP immediately before damage is applied; a
      // cached snapshot would hand back the value from before the last hit and
      // damage would be calculated against stale HP.
      if (actor) r.currentHP = actor.system?.attributes?.hp?.value ?? r.currentHP;
    } catch (_) { /* keep cached HP if refresh fails */ }

    // ── Rebuild the card (Phase 2 if damage rolled, otherwise Phase 1) ──
    try {
      const item = await fromUuid(flags.itemUuid) ?? game.items.get(flags.itemId);
      if (!item) {
        await msg.update({ [`flags.${MODULE_ID}.allResults`]: allResults }, { render: false });
        return;
      }

      // ── Apply on-fail conditions for a PC who just failed ──
      // The NPC paths apply conditions when the save resolves, but the PC
      // result handler never did — so a PC who failed (e.g. Kasimir vs
      // Entangling Rope) never got Restrained / the break-free tag. Apply here,
      // gated like the NPC path (no-damage powers, or any power with break-free
      // enabled) and guarded so repeated card rebuilds don't double-apply.
      try {
        if (SaveEngine._failedTheSave(r) && !r._condApplied) {
          const breakFreeEnabled = item.getFlag?.(MODULE_ID, "breakFreeConfig")?.enabled === true;
          const hasDmg = Array.isArray(flags.damageTypes) && flags.damageTypes.some(t => t && t !== "none");
          if (!hasDmg || breakFreeEnabled) {
            r._condApplied = true;
            const casterActor = game.actors.get(flags.actorId) ?? null;
            await this._applyFailedSaveConditions(item, [r], {
              saveAbility: flags.saveAbility, saveDC: flags.saveDC,
              activityId: flags.activityId ?? null, casterActor,
            });
          }
        }
      } catch (err) {
        console.warn(`${MODULE_ID} | PC fail condition application failed:`, err);
      }

      const isPhase2 = flags.phase === 2 || Array.isArray(flags.damageComponentTotals);
      let cardHtml;
      if (isPhase2 && Array.isArray(flags.damageComponentTotals)) {
        const casterActor = game.actors.get(flags.actorId);
        const damageComponents = flags.damageComponentTotals.map(c => ({
          total: c.total, type: c.type, formula: c.formula ?? String(c.total),
        }));
        cardHtml = this._buildPhase2CardHtml(item, casterActor, allResults, damageComponents, {
          saveAbility: flags.saveAbility, saveDC: flags.saveDC,
          halfOnSave: flags.halfOnSave, damageTypes: flags.damageTypes,
          activityId: flags.activityId ?? null,
        });
      } else {
        cardHtml = this._buildPhase1CardHtml(item, allResults, {
          saveAbility: flags.saveAbility, saveDC: flags.saveDC,
          hasDamage: flags.hasDamage !== false,
          halfOnSave: flags.halfOnSave === true,
          activityId: flags.activityId,
          appliedConditions: flags.appliedConditions ?? [],
        });
      }

      await msg.update({
        content: cardHtml,
        [`flags.${MODULE_ID}.allResults`]: allResults,
      });
      console.log(`${MODULE_ID} | Card updated for ${r.name}: ${r.passed ? "PASS" : "FAIL"} (${r.saveTotal})`);
    } catch (err) {
      console.error(`${MODULE_ID} | Card update failed:`, err);
      // Last-ditch: at least persist the flag
      await msg.update({ [`flags.${MODULE_ID}.allResults`]: allResults }, { render: false });
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Roll All Saves — Legacy (GM Clicks the Button on old-style card)
  // ═══════════════════════════════════════════════════════════════════════════

  async _rollAllSaves(message) {
    const flags = message.flags?.[MODULE_ID];
    if (!flags) return;

    const { saveAbility, saveDC, halfOnSave, targets, itemId, itemUuid, actorId, damageTypes, isSpell } = flags;

    const item = await fromUuid(itemUuid) ?? game.items.get(itemId);
    const casterActor = game.actors.get(actorId);

    const results = [];
    // Multi-target pacing for the legacy ROLL ALL SAVES button — same logic
    // as the modern path so a Fireball through this code path doesn't burn
    // the full single-target delay per die.
    const isMultiLegacy = (targets?.length ?? 0) > 1;

    // What this action can actually inflict — read ONCE per cast, before any
    // die, so the Gate can answer "immune to everything this does".
    const _gateCtx = {
      outcomeConditions: SaveEngine._outcomeConditionsFor(item),
      dealsDamage: Array.isArray(damageTypes) && damageTypes.some(t => t && t !== "none"),
      // The exact body that cast, for the cover check. (audit F-019)
      casterTokenDocId: flags.casterTokenDocId ?? null,
    };
    for (const tgt of targets) {
      const result = await this._rollSingleSave(tgt, saveAbility, saveDC, halfOnSave, actorId, { isMultiTarget: isMultiLegacy, ..._gateCtx });
      results.push(result);

      // Emit saveComplete hook for duration tracker (isSave expiry)
      try {
        const scene = game.scenes.get(result.sceneId) ?? canvas.scene;
        const tokenDoc = scene?.tokens?.get(result.tokenDocId);
        const actor = tokenDoc?.actor ?? game.actors.get(result.actorId);
        if (actor) {
          Hooks.callAll(`${MODULE_ID}.saveComplete`, { actor, tokenDocId: result.tokenDocId, saveAbility, passed: result.passed, itemUuid: item?.uuid ?? null });
        }
      } catch (_) { /* non-fatal */ }
    }

    // ── Save-or-condition spell handling ──
    // For spells like Hold Person, Sleep, Hypnotic Pattern, Charm Person,
    // Bane, Tasha's Hideous Laughter — failed saves apply CONDITIONS
    // (paralyzed, frightened, charmed, etc.) with no damage. Until this
    // shipped, save-engine was hard-wired to damage flow only and these
    // spells silently did nothing when the save failed. Mirrors the
    // post-hit-saves.mjs pattern that handles weapon-rider conditions.
    await this._applyFailedSaveConditions(item, results, { saveAbility, saveDC, activityId: flags.activityId ?? null, casterActor });

    // Roll damage once and apply per target with multipliers
    const damageComponents = await this._rollSpellDamage(item, casterActor, {
      spellLevel: flags.spellLevel ?? null,
      activityId: flags.activityId ?? null,   // roll THIS ability's dice, not the item's first damaging one
    });
    await this._postSaveResults(item, casterActor, results, {
      saveAbility, saveDC, halfOnSave, damageTypes, isSpell,
      activityId: flags.activityId ?? null,
    }, damageComponents);
  }

  /**
   * Apply on-fail conditions to every target that failed the save.
   *
   * Reads conditions from the item description via DescriptionParser. Honors
   * `cond.requiresSave === true` so we don't apply on-hit conditions through
   * this path (those are handled elsewhere). Respects per-target condition
   * immunity — frightened-immune fey hit by Cause Fear silently skip.
   * Routes through ConditionLibrary.applyByName so exhaustion correctly
   * INCREMENTS the level counter rather than toggling.
   *
   * @param {Item} item    — the spell item (must have description)
   * @param {Array} results — per-target save results (fields: passed, tokenDocId, sceneId, actorId, name)
   * @returns {Promise<void>}
   */
  /**
   * Drop the caster's concentration on this specific spell.
   *
   * Called when a concentration spell resolved with no actual effect on any
   * target — the caster shouldn't be stuck "concentrating on nothing." RAW:
   * concentration only matters while there's an effect to maintain; if every
   * target saved or was immune, the spell ends and so does the concentration.
   *
   * Matches the concentrating Active Effect by:
   *   1. flags.dnd5e.concentration.origin includes the spell item's UUID, OR
   *   2. The effect name contains the spell name (fallback)
   * Only deletes if the spell is actually a concentration spell.
   *
   * @param {Item} item — the spell that just resolved
   * @param {Actor} caster — the caster
   * @returns {Promise<boolean>} — true if concentration was dropped
   */
  async _dropCasterConcentrationIfNoEffect(item, caster) {
    if (!item || !caster) return false;

    // Confirm the spell required concentration in the first place
    const props = item.system?.properties;
    const isConcentration = props?.has?.("concentration")
      || (Array.isArray(props) && props.includes("concentration"));
    if (!isConcentration) return false;

    // ── Persistent-AOE exception ──
    // Spells like Stinking Cloud, Cloudkill, Moonbeam etc. create a persistent
    // template that AFFECTS creatures over time — even if every creature in
    // the area at cast time saves successfully, the cloud is still there for
    // 1 minute and other creatures may enter / start their turn inside.
    // Dropping concentration here would defeat the spell.
    //
    // Heuristic: any spell whose timing is NOT instant (i.e. has a persistent
    // template / ongoing area) is exempt from "wasted concentration" drop.
    // This covers all area-denial family spells, all ENTER_START spells, and
    // all NO_SAVE_AUTO movement-damage spells in one rule.
    try {
      const timing = getSpellTiming(item);
      const isPersistent = timing?.isPersistent === true
        || (timing?.timing && timing.timing !== TIMING.INSTANT);
      // The exemption is ONLY for ongoing AREA spells — a template that keeps
      // affecting creatures over time (Stinking Cloud, Cloudkill, Web). A
      // single-target condition spell (Hold Person, Hold Monster, Dominate,
      // Tasha's) has NO template: if its one target saves, nothing lingers and
      // the concentration IS wasted. Hold Person's "at the end of each of its
      // turns, the target can make another save" clause makes the timing parser
      // tag it END_OF_TURN (persistent), which WITHOUT this template gate left
      // the caster locked, concentrating on a fully-resisted spell. (2026-06-24)
      const tgt = item.system?.target ?? {};
      const AREA = new Set(["radius", "sphere", "cube", "cone", "line", "cylinder", "wall", "square", "circle"]);
      const hasAreaTemplate = !!String(tgt.template?.type ?? "").trim()
        || AREA.has(String(tgt.type ?? "").toLowerCase().trim());
      // Registry-owned effect spells (Faerie Fire) are ONE-SHOT reveals, not
      // ongoing zones — if every creature in the cube saved, the concentration
      // genuinely IS wasted, so it must drop. Never exempt them, even if the
      // timing classifier still mislabels them persistent/area.
      let isRegistryEffectSpell = false;
      try { isRegistryEffectSpell = !!game.aceQol?.SpellPipeline?._getEntry?.(item)?.effect?.key; }
      catch (_) { /* pipeline not ready — fall through to the area heuristic */ }
      if (!isRegistryEffectSpell && isPersistent && hasAreaTemplate) {
        console.log(`${MODULE_ID} | _dropCasterConcentrationIfNoEffect: skipping for "${item.name}" — persistent AREA spell, concentration not wasted by passed initial saves`);
        return false;
      }
    } catch (err) {
      console.warn(`${MODULE_ID} | wasted-concentration spell-timing check failed (non-fatal — vanilla drop logic continues):`, err);
    }

    // Find the matching concentrating effect on the caster
    const effects = caster.effects?.contents ?? [];
    const concEffect = effects.find(e => {
      if (e.disabled) return false;
      const isConcentratingFx = e.statuses?.has?.("concentration")  // dnd5e 5.x
        || e.statuses?.has?.("concentrating")                        // dnd5e 4.x
        || e.flags?.dnd5e?.concentration;
      if (!isConcentratingFx) return false;
      // Match by spell origin
      const concOrigin = e.flags?.dnd5e?.concentration?.origin ?? "";
      if (concOrigin && item.uuid && concOrigin.includes(item.uuid)) return true;
      // Fallback: effect name contains spell name
      if (e.name && item.name && e.name.includes(item.name)) return true;
      return false;
    });

    if (!concEffect) {
      console.log(`${MODULE_ID} | _dropCasterConcentrationIfNoEffect: no matching concentration effect on ${caster.name} for ${item.name}`);
      return false;
    }

    try {
      await concEffect.delete();
      ui.notifications?.info(`${item.name}: no targets affected — concentration ended.`);
      console.log(`${MODULE_ID} | Dropped wasted concentration on ${item.name} for ${caster.name}`);
      return true;
    } catch (err) {
      console.warn(`${MODULE_ID} | Failed to drop concentration effect on ${caster.name}:`, err);
      return false;
    }
  }

  async _applyFailedSaveConditions(item, results, saveCtx = null) {
    // TEMP DIAGNOSTIC (remove once break-free Restrained is confirmed):
    // Returns an array of { targetName, conditions: [...] } per target where
    // at least one condition was successfully applied. Used by Phase 1 card
    // builder to render specific "Goblin: Paralyzed" footers instead of a
    // generic message.
    //
    // saveCtx (optional): { saveAbility, saveDC }
    //   When provided, repeating-save metadata gets stamped on the placed
    //   effect so RepeatingSaveEngine can fire end-of-turn re-saves
    //   (Hold Person, Banishment, etc.). If omitted, we try to recover the
    //   ability/DC from the item's first save activity as a fallback.
    //
    // ── NOTHING LANDS BEFORE THE DICE DO (2026-07-28) ──
    // Petrified and Restrained were appearing on the token while the d20 was
    // still tumbling — the consequence arriving before the roll that caused it.
    // Four different call sites reach this method and NONE of them waited, so
    // the guard goes HERE, at the one door they all come through, rather than
    // as four patches that the fifth caller would miss. Costs nothing when
    // there are no dice in flight (Dice So Nice off, or already settled).
    await awaitDiceSettle();

    const applied = [];

    if (!item || !results?.length) {
      console.log(`${MODULE_ID} | _applyFailedSaveConditions: no item or no results`);
      return applied;
    }

    // ── Registry-owned effect spells are AUTHORITATIVE (resolved up front) ──
    // Faerie Fire & friends carry their failed-save effect in the pipeline
    // REGISTRY, not the item description. Resolving it here, before anything
    // else, lets it bypass BOTH the area-denial early-return below (Faerie Fire
    // is a one-shot reveal, NOT a persistent area-denial zone — yet the timing
    // classifier tags it that way) AND the description parser (which false-
    // positives on flavor like "can't benefit from being invisible"). When set,
    // this key IS the effect applied to every creature that fails its save — no
    // matter how the timing classifier or the parser read the spell.
    let registryEffectKey = null;
    try { registryEffectKey = game.aceQol?.SpellPipeline?._getEntry?.(item)?.effect?.key ?? null; }
    catch (_) { /* pipeline not ready — behave exactly as before */ }

    // ── Area-denial spells own their own effect lifecycle ──────────────────
    // Web, Spike Growth, Stinking Cloud, Watery Sphere, etc. are classified
    // family "areaDenial"/"areaDenialAuto", and the concentration widget
    // applies + MANAGES their failEffect ("Restrained by Web", "Retching", …)
    // with the correct break-free tag AND cleanup when the area ends / the
    // creature breaks free. If we ALSO applied a description-parsed condition
    // here, the creature would get TWO Restrained effects — and only one would
    // clear when concentration drops (the stuck-effect bug). Defer entirely to
    // the area-denial system for these spells.
    try {
      const adTiming = getSpellTiming(item);
      if (!registryEffectKey && (adTiming?.family === "areaDenial" || adTiming?.family === "areaDenialAuto")) {
        console.log(`${MODULE_ID} | _applyFailedSaveConditions: ${item.name} is area-denial (${adTiming.family}) — effect owned + cleaned up by the concentration widget; skipping save-engine condition application.`);
        return applied;
      }
    } catch (_) { /* classification failed — fall through to the normal path */ }

    let parsed;
    try {
      parsed = DescriptionParser.parse(item);

      // ── Activity-aware condition override (multi-power items) ──────────────
      // Conditions are parsed at the ITEM level, so a magic item with several
      // save powers (e.g. Holy Symbol of Ravenkind: Hold Vampires → paralyzed,
      // Turn Undead → frightened) would otherwise stamp the SAME blanket
      // condition on every power. If the firing activity's chatFlavor names its
      // own condition, parse THAT and override — but only the conditions,
      // keeping the item-level save/duration/repeating-save data intact.
      // Opt-in: single-power spells carry no activity-level condition text, so
      // this branch never fires for them and their behaviour is unchanged.
      // Isolated try: a failure in the override must NOT discard the
      // item-level parse we already have — just fall through to it.
      try {
        const actId = saveCtx?.activityId;
        if (actId) {
          const act = item.system?.activities?.get?.(actId)
            ?? [...(item.system?.activities ?? [])].find(a => a?.id === actId);
          const flavor = String(act?.description?.chatFlavor ?? "").trim();
          if (flavor) {
            const actParsed = DescriptionParser.parse({
              name: item.name, type: item.type,
              system: { description: { value: flavor }, activities: new Map() },
            });
            if (actParsed?.conditions?.length) {
              // These come from a SAVE activity's flavor — they ARE the
              // save-failure effect, so force them save-gated even if the
              // parser's nearby-DC heuristic read the flavor conservatively.
              // (Without this, the override could downgrade a working
              // paralyzed(save) to paralyzed(no-save) → nothing applies → the
              // dreaded "apply manually" footer.)
              const conds = actParsed.conditions.map(c => ({ ...c, requiresSave: true }));
              parsed = { ...parsed, conditions: conds };
              console.log(`${MODULE_ID} | _applyFailedSaveConditions: ${item.name} — using activity-level conditions from "${act?.name ?? actId}":`,
                conds.map(c => `${c.condition}(save)`));
            }
          }
        }
      } catch (ovErr) {
        console.debug(`${MODULE_ID} | activity-level condition override skipped:`, ovErr?.message ?? ovErr);
      }
    } catch (err) {
      console.warn(`${MODULE_ID} | _applyFailedSaveConditions: parse failed for ${item.name}:`, err);
      // A registry-owned effect spell (Faerie Fire) doesn't depend on the
      // description parse for its on-fail effect — don't let a parser hiccup
      // swallow it. Continue with an empty parse so the registry effect still
      // lands; everything downstream reads `parsed` with optional chaining.
      if (!registryEffectKey) return applied;
      parsed = { conditions: [] };
    }

    // ── Resolve save ability + DC for repeating-save metadata ──
    let resolvedSaveAbility = saveCtx?.saveAbility ?? null;
    let resolvedSaveDC      = Number(saveCtx?.saveDC) || null;
    if ((!resolvedSaveAbility || !resolvedSaveDC) && item?.system?.activities) {
      try {
        const acts = [...(item.system.activities?.values?.() ?? [])];
        const saveAct = acts.find(a => a?.save?.ability);
        if (saveAct) {
          if (!resolvedSaveAbility) {
            const ab = saveAct.save.ability;
            resolvedSaveAbility = (ab instanceof Set || Array.isArray(ab)) ? [...ab][0] : String(ab);
          }
          if (!resolvedSaveDC) {
            resolvedSaveDC = Number(saveAct.save.dc?.value ?? saveAct.save.dc) || null;
          }
        }
      } catch (_) { /* best-effort fallback */ }
    }
    // Compute spell duration in seconds (for math-correct OOC cap)
    let durationSeconds = null;
    try {
      const dur = item?.system?.duration;
      if (dur) {
        const value = Number(dur.value) || 0;
        const units = String(dur.units ?? "").toLowerCase();
        switch (units) {
          case "round":   durationSeconds = value * 6; break;
          case "turn":    durationSeconds = value * 6; break;
          case "minute":  durationSeconds = value * 60; break;
          case "hour":    durationSeconds = value * 3600; break;
          case "day":     durationSeconds = value * 86400; break;
          case "instant": durationSeconds = 0; break;
          // "permanent", "special", "until dispelled" → null (no cap)
        }
      }
    } catch (_) { /* fallthrough */ }

    const repeatingSaveMeta = (parsed?.repeatingSave?.trigger && resolvedSaveAbility && resolvedSaveDC)
      ? {
          ability:         resolvedSaveAbility,
          dc:              resolvedSaveDC,
          trigger:         parsed.repeatingSave.trigger,
          castWorldTime:   game.time?.worldTime ?? 0,
          durationSeconds: durationSeconds, // null = no duration cap
        }
      : null;

    // Break-free (action-to-escape) — opt-in via the Forge "can break free"
    // toggle (flags.ace-qol.breakFreeConfig). The escape check uses the chosen
    // ability (default Strength) against the same DC as the save.
    const bfConfig = item.getFlag?.(MODULE_ID, "breakFreeConfig");
    const breakFreeMeta = (bfConfig?.enabled && resolvedSaveDC)
      ? {
          ability: String(bfConfig.ability || resolvedSaveAbility || "str").toLowerCase(),
          dc:      resolvedSaveDC,
          label:   item.name,
        }
      : null;

    // Diagnostic dump — surfaces why conditions might not be applying
    const allConds = parsed?.conditions ?? [];
    let failConditions = allConds.filter(c => c?.requiresSave);  // `let`: may be injected from the registry below

    // Break-free is self-contained: if the GM enabled "can break free" but the
    // feature never declared a save-triggered Restrained of its own, inject one
    // so the Restrained effect (carrying the break-free tag) actually lands on a
    // failed save. Without this, a damage-only feature like Entangling Rope had
    // nothing to attach the break-free prompt to.
    if (breakFreeMeta && !failConditions.some(c => /restrain/i.test(String(c.condition ?? "")))) {
      failConditions.push({ condition: "restrained", requiresSave: true, source: "breakFree" });
      console.log(`${MODULE_ID} | _applyFailedSaveConditions: ${item.name} — break-free enabled, injecting Restrained on fail.`);
    }
    console.log(`${MODULE_ID} | _applyFailedSaveConditions: ${item.name} — parsed ${allConds.length} condition(s), ${failConditions.length} marked requiresSave:`,
      allConds.map(c => `${c.condition}${c.requiresSave ? "(save)" : "(no-save)"}`));

    // ── Polymorph spell branch — MUST run BEFORE the no-conditions early return ──
    // Polymorph-class spells don't apply a tagged condition like "paralyzed" —
    // they transform the target. So `failConditions.length === 0` is EXPECTED
    // for Polymorph and the normal "NO conditions marked requiresSave" return
    // would skip our transformation routing. Branch here first.
    const isPolymorph = PolymorphSpellPipeline.isPolymorphSpell(item);
    if (isPolymorph) {
      console.log(`${MODULE_ID} | _applyFailedSaveConditions: ${item.name} — routing to Polymorph pipeline (skipping normal condition path)`);
      const activityId = saveCtx?.activityId ?? null;
      const casterActor = saveCtx?.casterActor ?? null;
      const failed = results.filter(r => SaveEngine._failedTheSave(r));
      if (!failed.length) {
        console.log(`${MODULE_ID} | ${item.name}: no failed saves — no transformation`);
        return applied;
      }
      for (const r of failed) {
        const scene = game.scenes.get(r.sceneId) ?? canvas.scene;
        const tokenDoc = scene?.tokens?.get(r.tokenDocId);
        const actor = tokenDoc?.actor ?? game.actors.get(r.actorId);
        if (!actor) continue;

        const transformed = await PolymorphSpellPipeline.tryConsumeAndTransform(activityId, actor, casterActor, tokenDoc);
        if (transformed) {
          applied.push({
            targetName: r.name ?? actor.name,
            tokenDocId: r.tokenDocId,
            conditions: ["transformed"],
          });
        } else {
          console.warn(`${MODULE_ID} | ${item.name}: Polymorph cast but no pending pick for activity ${activityId} — target ${actor.name} unaffected`);
        }
      }
      // Polymorph handled (success or no-pick) — skip the normal condition
      // application loop entirely. Polymorph doesn't apply paralyzed etc.
      return applied;
    }

    // ── Decide WHICH conditions to apply on a failed save ──
    // Registry-owned effect (Faerie Fire, resolved at the top of this method)
    // wins outright; otherwise use the description-parsed conditions. If neither
    // yields anything, there's nothing to apply (a homebrew save spell may
    // simply need its on-fail condition configured).
    if (registryEffectKey) {
      failConditions = [{ condition: registryEffectKey, requiresSave: true, fromRegistry: true }];
      console.log(`${MODULE_ID} | _applyFailedSaveConditions: ${item.name} — applying registry effect "${registryEffectKey}" to failed-save targets (template-save hand-off).`);
    } else if (!failConditions.length) {
      console.debug(`${MODULE_ID} | _applyFailedSaveConditions: ${item.name} — no description-parsed conditions + no registry effect (homebrew may need a save trigger).`);
      return applied;
    }

    // ── Staged petrification (basilisk / medusa Petrifying Gaze) ──
    // The description parser yields BOTH "restrained" AND "petrified" for a gaze,
    // and the loop below would apply BOTH the instant a save fails — skipping the
    // entire RAW middle. RAW: a failed save → restrained ("turning to stone"); the
    // creature re-saves at the END of its NEXT turn; only a SECOND failure petrifies.
    // Collapse to: apply Restrained now, carry a repeating end-of-turn save that
    // ESCALATES to petrified on failure, with one grace turn. This is the exact
    // two-stage behavior the (passive) gaze engine builds — the ACTIVE item path
    // was applying both at once (live console, 2026-07-24).
    let stagedPetrifyMeta = null;
    {
      const hasRestrained = failConditions.some(c => /restrain/i.test(String(c.condition ?? "")));
      const hasPetrified  = failConditions.some(c => /petrif/i.test(String(c.condition ?? "")));
      if (hasRestrained && hasPetrified && resolvedSaveDC) {
        failConditions = [{ condition: "restrained", requiresSave: true, staged: "petrify" }];
        stagedPetrifyMeta = {
          ability:            String(resolvedSaveAbility || "con").toLowerCase(),
          dc:                 Number(resolvedSaveDC),
          trigger:            "endOfTurn",
          spellName:          item.name,
          onFailureApply:     "petrified",
          skipFirstEndOfTurn: true,
          // THE GAZE TAG (Johnny 2026-07-27): pin the staged restraint to THIS
          // exact power + caster so escalation/cleanup can never confuse it
          // with a restraint from a net, Web, or another creature's ability.
          sourceItemUuid:     item.uuid ?? null,
          casterId:           item.actor?.id ?? null,
        };
        console.log(`${MODULE_ID} | ${item.name}: staged petrification — Restrained now; re-save at end of NEXT turn escalates to Petrified (RAW two-stage).`);
      }
    }

    const autoApply = QolSettings.get("autoApplyConditions") ?? true;
    if (!autoApply) {
      console.log(`${MODULE_ID} | autoApplyConditions OFF — skipping condition application for ${item.name}`);
      return applied;
    }

    // A result counts as "failed" ONLY when it has actually RESOLVED and
    // failed. Pending PC entries (passed === undefined, pending === true) are
    // posted into the multi-target card before the player rolls — they must
    // NOT be treated as fails here, or the condition lands the instant the
    // card posts (before any roll) and sticks even when the PC passes.
    // (Bug: Jeth passed Web's Dex save 26 vs DC 22 but was Restrained anyway.)
    // Genuine fails set passed === false; PCs get their conditions applied
    // later by the PC-result handler once their roll resolves.
    const failed = results.filter(r => SaveEngine._failedTheSave(r));
    // ── THE GAZE TAG RULE, pass side (Johnny 2026-07-27) ─────────────────────
    // A PASSED save vs this spell IS the repeat save — it ENDS this spell's
    // staged restraint on that target (only OUR tag; restrained from a net /
    // Web / anything else is untouched). This is what kills stale-stage rot:
    // a pass always cleans the tag, so an old "turning to stone" can never
    // linger through passes and instantly stone the target on a later fail
    // (Kasimir's live sequence, 2026-07-27).
    if (stagedPetrifyMeta) {
      const spellLc = String(item.name ?? "").toLowerCase();
      for (const r of (results ?? []).filter(x => x?.passed === true)) {
        try {
          const scene = game.scenes.get(r.sceneId) ?? canvas.scene;
          const tokenDoc = r.tokenDocId ? scene?.tokens?.get(r.tokenDocId) : null;
          const base = r.actorId ? game.actors.get(r.actorId) : null;
          const tActor = tokenDoc?.actor ?? (base?.prototypeToken?.actorLink ? base : null);
          if (!tActor?.effects) continue;
          const staged = (tActor.effects.contents ?? []).filter(e => {
            const rs = e.flags?.[MODULE_ID]?.repeatingSave;
            return rs?.onFailureApply === "petrified"
              && String(rs?.spellName ?? "").toLowerCase() === spellLc;
          });
          if (!staged.length) continue;
          for (const e of staged) { try { await e.delete(); } catch (_) { /* already gone */ } }
          console.log(`${MODULE_ID} | ${item.name}: ${tActor.name} PASSED while turning to stone — staged restraint ends, tag cleaned.`);
          try {
            await ChatMessage.create({
              speaker: ChatMessage.getSpeaker({ actor: tActor }),
              content: `<b>${tActor.name}</b> resists <b>${item.name}</b> — the petrification is halted and the restraint ends.`,
            });
          } catch (_) { /* informational only */ }
        } catch (err) {
          console.warn(`${MODULE_ID} | gaze pass-side tag cleanup failed (non-fatal):`, err);
        }
      }
    }

    if (!failed.length) {
      console.log(`${MODULE_ID} | ${item.name}: no resolved failed saves — no conditions to apply`);
      return applied;
    }

    for (const r of failed) {
      const scene = game.scenes.get(r.sceneId) ?? canvas.scene;
      // Resolve the TOKEN's own actor — critical for UNLINKED tokens, where
      // applying to the prototype/world actor would never show on the token.
      // Fall back to finding any token for this actor if the result is missing
      // a tokenDocId, before finally dropping to the world actor.
      let tokenDoc = r.tokenDocId ? scene?.tokens?.get(r.tokenDocId) : null;
      if (!tokenDoc && r.actorId) {
        // ── Exact-token targeting (2026-07-26) ──
        // The old fallback grabbed the FIRST scene token using this base actor.
        // With two+ UNLINKED copies of the same monster (two ogres dropped from
        // one sidebar entry) that could petrify/condition the WRONG copy. Now:
        // one match → use it; several LINKED → any (they share one sheet, the
        // write lands identically); several UNLINKED → refuse and tell the GM
        // rather than guess.
        const pool = scene?.tokens?.contents ?? canvas.tokens?.placeables.map(p => p.document) ?? [];
        const matches = pool.filter(t => t.actorId === r.actorId);
        if (matches.length === 1) tokenDoc = matches[0];
        else if (matches.length > 1) {
          const linked = matches.find(t => t.actorLink);
          if (linked) tokenDoc = linked;
          else {
            console.warn(`${MODULE_ID} | _applyFailedSaveConditions: ${item.name} — ${matches.length} unlinked "${r.name}" tokens share one base actor and no exact token reference survived; skipping condition auto-apply for this target rather than risk the wrong copy.`);
            ui.notifications?.warn(`${item.name}: couldn't tell which "${r.name}" was the target — apply the condition manually.`);
            continue;
          }
        }
      }
      // Base-actor fallback ONLY when that actor is genuinely the creature's one
      // sheet (linked prototype). Writing a condition onto the shared sidebar
      // actor of UNLINKED copies would contaminate every future drop of it.
      let actor = tokenDoc?.actor ?? null;
      if (!actor && r.actorId) {
        const base = game.actors.get(r.actorId);
        if (base?.prototypeToken?.actorLink) actor = base;
        else if (base) {
          console.warn(`${MODULE_ID} | _applyFailedSaveConditions: ${item.name} — target token for "${r.name}" is gone and its base actor is unlinked-prototype; skipping rather than contaminate the sidebar actor.`);
          continue;
        }
      }
      if (!actor) {
        console.warn(`${MODULE_ID} | _applyFailedSaveConditions: ${item.name} — could not resolve actor for failed target ${r.name} (sceneId=${r.sceneId} tokenDocId=${r.tokenDocId} actorId=${r.actorId})`);
        continue;
      }

      // ── IMMUNITY GATE — BEFORE ANY BRANCH (2026-07-28, second pass) ──
      // The first fix put the immunity check inside the per-condition loop.
      // The staged-petrification branch below sits ABOVE that loop and
      // `continue`s past it, calling ConditionLibrary.applyEffect directly —
      // which also skips the library's own guard. So an Earth Elemental that
      // is explicitly immune to Petrified got staged into "turning to stone"
      // and then escalated straight to stone on its second failure. Johnny's
      // console said it out loud: "ESCALATED straight to Petrified."
      //
      // RAW: if a creature cannot be petrified, the gaze does NOTHING to it —
      // not the stone, and not the restraint, because that restraint exists
      // ONLY as stage one of becoming stone. Gate the whole chain, at the top,
      // where no later branch can route around it.
      // ⚠️ READ THE STAGED METADATA, NOT JUST failConditions. The staging block
      // above REASSIGNS failConditions to restrained-only and moves "petrified"
      // into stagedPetrifyMeta.onFailureApply. A gate that only scans
      // failConditions sees "restrained", concludes the chain is harmless, and
      // waves the immune creature straight through to the stone. (I wrote that
      // gate first. It was wrong for exactly this reason.)
      const _tp = SaveEngine._targetProfileFor(actor, r);
      const _terminal = String(stagedPetrifyMeta?.onFailureApply ?? "").toLowerCase();
      const _chainConds = (failConditions ?? [])
        .map(c => String(c?.condition ?? "").toLowerCase()).filter(Boolean);

      // TWO DIFFERENT RULES, because a staged chain is not a list of independent
      // conditions:
      //
      //  • STAGED (gaze): RAW says the creature "begins to turn to stone and is
      //    restrained" — that restraint EXISTS ONLY as stage one of becoming
      //    stone. It is not a restraint in its own right. So immunity to the
      //    TERMINAL condition voids the entire chain. This is the Earth
      //    Elemental: immune to Petrified, NOT immune to Restrained. An
      //    every()-style test would let it be staged as "turning to stone" and
      //    then escalate — the exact bug, one step later.
      //
      //  • UNSTAGED: independent conditions. Only skip if immune to ALL of them;
      //    immunity to one must not cancel the others.
      const _voided = _terminal
        ? _tp?.immuneToCondition(_terminal)
        : (_chainConds.length && _chainConds.every(c => _tp?.immuneToCondition(c)));

      if (_voided) {
        const _names = _terminal ? [_terminal] : [...new Set(_chainConds)];
        console.log(`${MODULE_ID} | ${item.name}: ${actor.name} is IMMUNE to ${_names.join("/")} — whole chain skipped (no staging, no escalation).`);
        applied.push({
          targetName: r.name ?? actor.name,
          tokenDocId: r.tokenDocId,
          conditions: [],
          immune: _names,
        });
        continue;
      }

      // ── ASK THE TARGET PROFILE (2026-07-28) ──
      // This used to read the actor directly:
      //     (actor.system?.traits?.ci?.value ?? []).map(...)
      // which assumes an ARRAY. dnd5e stores condition immunities as a SET —
      // Situation._traitSet handles both precisely because of that — so `.map`
      // isn't a function and this set came out wrong. It also ignored the
      // free-text custom immunity box entirely. Net result: an Earth Elemental
      // explicitly immune to Petrified got petrified, and the card announced it.
      //
      // The profile answers the question instead of handing over a structure to
      // guess at: it reads the structured list AND the custom text, and knows
      // "petrification" in prose means the petrified status. One reader, every
      // shape, every pipeline.
      const tProfile = SaveEngine._targetProfileFor(actor, r);

      // ── Staged petrification: SECOND failed save = STONE, right now ──────
      // If this target is ALREADY "turning to stone" from this same gaze (it
      // carries the staged Restrained with the escalate-to-petrified re-save
      // tag), a NEW failed save doesn't restart stage one — it completes the
      // petrification immediately. RAW: a creature restrained by the gaze that
      // fails again is petrified — that repeat save normally comes at the end
      // of its turn, but another USE of the gaze forces the save early and a
      // failure means the same thing. Without this, re-casting deleted the
      // staged Restrained (same-condition dedupe) and re-applied stage one
      // forever — Kasimir's "failed his second save and still just restrained"
      // (live test 2026-07-26). Escalation mirrors the repeating-save engine:
      // staging effect deleted FIRST, then the end state applied.
      if (stagedPetrifyMeta) {
        // THE GAZE TAG RULE, fail side: escalate ONLY off a LIVE, ENABLED staged
        // restraint from THIS spell (the tag) — never off a stale/disabled scrap
        // and never off a restraint from any other source. Delete EVERY tagged
        // staging effect (belt against duplicates), then stone him.
        const spellLc = String(item.name ?? "").toLowerCase();
        const staged = (actor.effects?.contents ?? []).filter(e => {
          if (e.disabled) return false;
          const rs = e.flags?.[MODULE_ID]?.repeatingSave;
          return rs?.onFailureApply === "petrified"
            && String(rs?.spellName ?? "").toLowerCase() === spellLc;
        });
        if (staged.length) {
          try {
            for (const e of staged) { try { await e.delete(); } catch (_) { /* already gone */ } }
            // REPORT WHAT ACTUALLY HAPPENED (2026-07-28). This used to push
            // "→ Petrified" unconditionally, without looking at the return
            // value — so when the library refused the apply, the card still
            // announced the stone. The gate above means an immune creature
            // never reaches here, but a card must never claim a condition
            // landed just because we asked for it.
            const _eff = await ConditionLibrary.applyEffect(actor, "petrified", { source: item.name });
            if (_eff) {
              console.log(`${MODULE_ID} | ${item.name}: ${actor.name} was already turning to stone and FAILED AGAIN — ESCALATED straight to Petrified.`);
              applied.push({
                targetName: r.name ?? actor.name,
                tokenDocId: r.tokenDocId,
                conditions: ["petrified"],
              });
            } else {
              console.log(`${MODULE_ID} | ${item.name}: escalation REFUSED for ${actor.name} (immune) — staging cleared, no stone.`);
              applied.push({
                targetName: r.name ?? actor.name,
                tokenDocId: r.tokenDocId,
                conditions: [],
                immune: ["petrified"],
              });
            }
          } catch (err) {
            console.warn(`${MODULE_ID} | staged-petrify escalation failed for ${actor.name}:`, err);
          }
          continue;   // this target is stone — nothing further to apply
        }
      }

      const appliedForThisTarget = [];
      const immuneForThisTarget = [];   // so the card can say IMMUNE instead of lying

      for (const cond of failConditions) {
        const condKey = String(cond.condition ?? "").toLowerCase().trim();
        if (!condKey) continue;
        if (tProfile?.immuneToCondition(condKey)) {
          console.log(`${MODULE_ID} | ${actor.name} IMMUNE to ${condKey} — ${item.name} condition skipped`);
          immuneForThisTarget.push(condKey);
          continue;
        }
        try {
          // ── Concentration linkage ──
          // For concentration spells (Hold Person, Hypnotic Pattern, etc.),
          // tag the applied condition with the caster + spell name so we
          // can sweep + remove it automatically when the caster's
          // concentration ends or moves to a new cast.
          let concentrationOrigin = null;
          const isConcentration = item?.system?.properties?.has?.("concentration")
            || (Array.isArray(item?.system?.properties) && item.system.properties.includes("concentration"));
          if (isConcentration) {
            concentrationOrigin = {
              casterId:    item.actor?.id ?? null,
              spellName:   item.name,
              spellItemId: item.id,
            };
          }

          // Build options bundle for applyByName — concentration linkage AND
          // repeating-save metadata (when applicable).
          const applyOpts = {};
          if (concentrationOrigin) applyOpts.concentrationOrigin = concentrationOrigin;
          if (repeatingSaveMeta)   applyOpts.repeatingSave       = repeatingSaveMeta;
          if (stagedPetrifyMeta) {
            // ── Grace turn is PER-TARGET, not unconditional (2026-07-25) ──
            // RAW: a failed gaze save → restrained; re-save "at the END of its
            // NEXT turn." Whether the tagging turn's own end counts depends on
            // WHOSE turn it is when the target is tagged:
            //   • Tagged DURING the target's own turn (passive start-of-turn gaze)
            //     → the end of THIS turn is the grace; the save is the turn after
            //     → skipFirstEndOfTurn = true.
            //   • Tagged OUTSIDE the target's turn (ACTIVE item used on the
            //     basilisk's/GM's action) → the target's very NEXT turn-end already
            //     IS "the end of its next turn" → skipFirstEndOfTurn = false,
            //     otherwise the petrify lands a full turn late (Johnny's "not
            //     firing on the right turns", 2026-07-24).
            const _combatant = game.combat?.started ? game.combat.combatant : null;
            const _taggedOnOwnTurn = !!_combatant && (
              _combatant.actor === actor ||
              (!!tokenDoc && _combatant.tokenId === tokenDoc.id)
            );
            applyOpts.repeatingSave = { ...stagedPetrifyMeta, skipFirstEndOfTurn: _taggedOnOwnTurn };  // staged petrification wins
          }
          if (breakFreeMeta)       applyOpts.breakFree           = breakFreeMeta;

          // Area-denial family (Stinking Cloud, etc.): description-parsed
          // conditions like Poisoned need to auto-expire at end of the
          // victim's turn, otherwise they linger forever even after the
          // Retching effect clears. Stinking Cloud 2024 RAW: Poisoned
          // until start of next turn — turnEnd is one tick earlier but
          // functionally equivalent for "loses Action this turn."
          try {
            const tm = item?.flags?.["ace-qol"]?.spellTiming;
            let familyTag = tm?.family ?? null;
            if (!familyTag) {
              // Look up via the spell-timing table
              const { getSpellTiming } = await import("./spell-timing.mjs");
              const timing = getSpellTiming(item);
              familyTag = timing?.family ?? null;
            }
            if (familyTag === "areaDenial") {
              applyOpts.specialDuration = "turnEnd";
            }
          } catch (_) { /* best-effort; missing family flag = old behavior */ }

          const out = await ConditionLibrary.applyByName(actor, cond.condition,
            Object.keys(applyOpts).length ? applyOpts : undefined);
          if (out?.ok) {
            const detail = out.level !== undefined ? ` (level ${out.level})` : "";
            const tagBits = [];
            if (concentrationOrigin) tagBits.push("concentration-linked");
            if (repeatingSaveMeta)   tagBits.push(`repeating-save:${repeatingSaveMeta.trigger}`);
            const tagStr = tagBits.length ? ` [${tagBits.join(", ")}]` : "";
            console.log(`${MODULE_ID} | ${item.name}: applied "${cond.condition}"${detail} to ${actor.name} (failed save)${tagStr}`);
            appliedForThisTarget.push(cond.condition);

            // Stamp the break-free tag DIRECTLY on the applied effect from here,
            // so it never depends on condition-library's internal stamp path
            // (place-new vs re-enable, concentration vs not). The BreakFreeEngine
            // reads this flag at start of turn to prompt the escape attempt.
            if (breakFreeMeta) {
              try {
                const ck = String(cond.condition).toLowerCase();
                const eff = actor.effects?.contents?.find(e =>
                  !e.disabled && (e.statuses?.has?.(ck) || e.name?.toLowerCase() === ck));
                if (eff && !eff.flags?.[MODULE_ID]?.breakFree?.ability) {
                  await eff.update({
                    [`flags.${MODULE_ID}.breakFree`]: {
                      ability:      breakFreeMeta.ability,
                      dc:           breakFreeMeta.dc,
                      label:        breakFreeMeta.label ?? item.name,
                      itemUuid:     item.uuid,   // so break-free can end the item's persistent FX
                      appliedRound: game.combat?.round ?? null,
                      appliedTurn:  game.combat?.turn ?? null,
                      stampedAt:    Date.now(),
                    },
                  });
                  console.log(`${MODULE_ID} | Stamped break-free (${breakFreeMeta.ability} DC ${breakFreeMeta.dc}) on ${actor.name}'s ${cond.condition} [save-engine direct].`);
                }
              } catch (err) {
                console.warn(`${MODULE_ID} | Direct break-free stamp failed on ${actor.name}:`, err);
              }
            }
          } else {
            console.warn(`${MODULE_ID} | ${item.name}: applyByName returned not-ok for "${cond.condition}" on ${actor.name}:`, out);
          }
        } catch (err) {
          console.warn(`${MODULE_ID} | applyByName(${cond.condition}) failed for ${actor.name}:`, err);
        }
      }

      if (appliedForThisTarget.length) {
        applied.push({
          targetName: r.name ?? actor.name,
          tokenDocId: r.tokenDocId,
          conditions: appliedForThisTarget,
        });
      }
      // An immunity that stops a condition is a RESULT, not a silence. The card
      // said "Earth Elemental → Petrified" for a creature that cannot be
      // petrified; the table deserves "immune" instead of a lie or a blank.
      if (immuneForThisTarget.length) {
        applied.push({
          targetName: r.name ?? actor.name,
          tokenDocId: r.tokenDocId,
          conditions: [],
          immune: immuneForThisTarget,
        });
      }
    }

    return applied;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Phase 1 — Saves-Only Card (no damage yet, ROLL DAMAGE button)
  // ═══════════════════════════════════════════════════════════════════════════

  // ─────────────────────────────────────────────────────────────────────────
  //  Build Phase 1 card HTML — extracted so late PC updates can rebuild
  // ─────────────────────────────────────────────────────────────────────────
  _buildPhase1CardHtml(item, results, opts) {
    const { saveAbility, saveDC, hasDamage = true, halfOnSave = false, appliedConditions = [], activityId = null } = opts;
    const abilityLabel = CONFIG.DND5E?.abilities?.[saveAbility]?.label ?? saveAbility.toUpperCase();
    const _p1Title = this._abilityLabel(item, activityId);

    const targetRows = results.map(r => {
      const removeBtn = `<button class="ace-qol-save-phase1-remove" data-action="aceQolRemovePhase1" data-token-doc-id="${r.tokenDocId}" title="Remove this target before damage rolls"><i class="fas fa-xmark"></i></button>`;
      if (r.pending) {
        return `
          <div class="ace-qol-save-result-row ace-qol-save-result-pending" data-token-doc-id="${r.tokenDocId}">
            <div class="ace-qol-save-result-target">
              <img src="${r.img || "icons/svg/mystery-man.svg"}" class="ace-qol-save-tgt-img" />
              <span class="ace-qol-save-tgt-name">${r.name}</span>
              ${removeBtn}
              <span class="ace-qol-save-result-label ace-qol-save-pending">WAITING FOR PLAYER</span>
            </div>
          </div>
        `;
      }
      const portrait = `<img src="${r.img || "icons/svg/mystery-man.svg"}" class="ace-qol-save-tgt-img" style="width:46px;height:46px;border-radius:8px;flex-shrink:0;border:1px solid #555;object-fit:cover;" />`;

      // ── GATED — no die was thrown (2026-08-06, ONE_GATE phase 0) ──────────
      // Johnny: "I want us to be able to see it." A target the Gate refused is
      // never silently dropped from the card; it gets a row that says WHY, so
      // the GM can tell "the engine skipped this on purpose" apart from "the
      // engine forgot about this one". No d20, because no d20 was rolled —
      // showing a blank die face would be its own small lie.
      if (r.noRoll) {
        const tone = r.noRollTone === "immune"
          ? { colour: "#ffaa44", icon: "fa-shield-halved" }   // shrugged it off
          : { colour: "#9a9aa2", icon: "fa-skull" };          // dead — grey, not red
        return `
          <div class="ace-qol-save-result-row ace-qol-save-result-noroll" data-token-doc-id="${r.tokenDocId}"
               style="display:flex;align-items:center;gap:12px;padding:10px 12px;border-bottom:1px solid rgba(212,175,55,0.15);opacity:0.9;">
            <div style="display:flex;flex-direction:column;align-items:center;gap:5px;flex-shrink:0;">
              ${portrait}
            </div>
            <div style="flex:1;min-width:0;">
              <div style="display:flex;align-items:center;gap:8px;margin-bottom:3px;">
                <span class="ace-qol-save-tgt-name" style="flex:1;font-weight:bold;color:#fff;font-size:16px;line-height:1.2;white-space:nowrap;">${foundry.utils.escapeHTML(r.name ?? "")}</span>
                ${removeBtn}
              </div>
              <div style="display:flex;align-items:center;gap:8px;">
                <i class="fas ${tone.icon}" style="color:${tone.colour};font-size:13px;"></i>
                <span style="color:${tone.colour};font-weight:700;font-size:15px;letter-spacing:0.5px;">${foundry.utils.escapeHTML(r.noRollLabel ?? "")}</span>
              </div>
            </div>
          </div>
        `;
      }

      const passClass = r.passed ? "ace-qol-save-pass" : "ace-qol-save-fail";
      const verdictText = r.passed ? "PASS" : "FAIL";

      // The glowing d20 face goes UNDER the portrait (left column); the math
      // breakdown (raw +mod = total) sits to the right with the verdict.
      let d20El = "";
      let breakdownText;
      if (r.isAutoFail) {
        breakdownText = `<span class="${passClass}" style="font-weight:700;font-size:17px;">AUTO-FAIL</span>`;
      } else {
        const d20Face = r.dieResult ?? r.roll?.dice?.[0]?.total ?? null;
        const modifier = (typeof r.saveTotal === "number" && d20Face != null)
          ? r.saveTotal - d20Face : null;
        if (d20Face != null && modifier != null) {
          const modSign = modifier >= 0 ? "+" : "";
          const modPart = modifier === 0 ? "" : ` ${modSign}${modifier}`;
          d20El = aceD20FaceImg(d20Face, { size: 40 });
          breakdownText = `
            <span style="display:inline-flex;align-items:center;gap:6px;font-family:'Signika',sans-serif;">
              <span style="color:#ffffff;font-size:19px;font-weight:700;">${d20Face}</span>
              <span style="color:#b9a978;font-size:15px;">${modPart} =</span>
              <span class="${passClass}" style="font-weight:700;font-size:19px;">${r.saveTotal}</span>
            </span>`;
        } else {
          breakdownText = `<span class="${passClass}" style="font-weight:700;font-size:18px;">${r.saveTotal}</span>`;
        }
      }

      // Portrait + d20 stacked in the left column; name / breakdown / verdict right.
      return `
        <div class="ace-qol-save-result-row" data-token-doc-id="${r.tokenDocId}"
             style="display:flex;align-items:center;gap:12px;padding:10px 12px;border-bottom:1px solid rgba(212,175,55,0.15);">
          <div style="display:flex;flex-direction:column;align-items:center;gap:5px;flex-shrink:0;">
            ${portrait}
            ${d20El}
          </div>
          <div style="flex:1;min-width:0;">
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:3px;">
              <span class="ace-qol-save-tgt-name" style="flex:1;font-weight:bold;color:#fff;font-size:16px;line-height:1.2;">${r.name}</span>
              ${removeBtn}
            </div>
            <div style="display:flex;align-items:center;gap:12px;">
              <span style="flex:1;">${breakdownText}</span>
              <span class="ace-qol-save-verdict ${passClass}"
                    style="font-weight:bold;font-size:15px;letter-spacing:0.5px;">${verdictText}</span>
            </div>
          </div>
        </div>
      `;
    }).join("");

    // ROLL DAMAGE button only appears if the spell actually deals damage.
    // Save-or-condition spells (Hold Person, Charm Person, Sleep, etc.) get
    // a per-target condition footer instead. Each line shows exactly which
    // condition was applied to which target (red, e.g., "Goblin: Paralyzed")
    // so the GM/player can see at a glance what changed.
    // RAW: EVERY target resolves its save before damage is rolled. NPCs
    // auto-roll instantly, but a PC (e.g. King) hasn't clicked their save yet —
    // so hold the damage step until no target is still pending. The card
    // rebuilds as each save posts, so ROLL DAMAGE unlocks the moment the last
    // save lands — driven by the actual rolls, not a timer.
    const anyPending = results.some(r => r.pending);
    // Will ANY resolved target actually take damage? A failer always does; a
    // passer only when the power deals half-on-save. If nobody will — e.g. the
    // single target saved against Entangling Rope, which deals no damage on a
    // save — there's nothing to roll or apply, so show a clean "no damage"
    // result instead of a ROLL DAMAGE / APPLY ALL card.
    const anyWillTakeDamage = hasDamage && results.some(r => !r.pending && !r.noRoll && (!r.passed || halfOnSave));
    let actionsHtml;
    if (hasDamage && anyPending) {
      actionsHtml = `<div class="ace-qol-dmg-actions ace-qol-roll-dmg-gate">
          <button class="ace-qol-btn ace-qol-btn-roll-dmg" disabled
                  title="Waiting for every target to roll their save first.">
            <i class="fas fa-hourglass-half"></i> WAITING FOR SAVES…
          </button>
        </div>`;
    } else if (anyWillTakeDamage) {
      actionsHtml = `<div class="ace-qol-dmg-actions ace-qol-roll-dmg-gate">
          <button class="ace-qol-btn ace-qol-btn-roll-dmg" data-action="aceQolRollDamage">
            <i class="fas fa-dice-d20"></i> ROLL DAMAGE
          </button>
        </div>`;
    } else if (hasDamage) {
      // Damaging power, but every resolved target saved and it deals no damage
      // on a successful save → no damage step at all.
      const anyoneFailed = results.some(r => SaveEngine._failedTheSave(r));
      actionsHtml = `<div class="ace-qol-save-no-effect" style="padding:8px 12px;text-align:center;color:#88c878;font-size:13px;font-weight:600;">
          <i class="fas fa-shield-halved"></i> ${anyoneFailed ? "Resolved — no damage to apply" : "Saved — no damage"}
        </div>`;
    } else if (appliedConditions?.length) {
      const cap = (c) => c.charAt(0).toUpperCase() + c.slice(1).toLowerCase();
      const lines = appliedConditions.map(a => {
        // IMMUNE rows read as a shield in ORANGE, not a skull in red \u2014 the
        // creature shrugged it off, which is a different story from being hit.
        //
        // \u26a0\ufe0f TWO FIXES HERE, 2026-08-06 (ONE_GATE phase 0):
        //  \u2022 The colour was #6bcbff, a cold blue that reads as informational \u2014
        //    the same blue used for neutral hints. Immunity is a WARNING: the
        //    thing you cast did nothing. It now uses #ffaa44, the orange
        //    already in the ACE palette.
        //  \u2022 The name was breaking mid-word \u2014 "Specte / r". Cause: the IMMUNE
        //    label carried white-space:nowrap, so it refused to shrink, and the
        //    name was the only flexible box left in the row. It got crushed
        //    until the word itself broke. Fix is BOTH halves: the name gets
        //    nowrap too, and the row is allowed to wrap, so when they can't sit
        //    side by side the label drops to its own line instead of eating the
        //    name. A creature's name is never the thing that gets sacrificed.
        const nameSpan = (txt) =>
          `<span style="color:#ffffff;font-weight:700;white-space:nowrap;">${foundry.utils.escapeHTML(txt)}</span>`;
        if (a.immune?.length) {
          return `<div style="display:flex;align-items:center;flex-wrap:wrap;gap:6px;padding:2px 0;">
            <i class="fas fa-shield-halved" style="color:#ffaa44;font-size:11px;"></i>
            ${nameSpan(a.targetName)}
            <span style="color:#888;">\u2192</span>
            <span style="color:#ffaa44;font-weight:700;letter-spacing:0.5px;white-space:nowrap;">IMMUNE to ${foundry.utils.escapeHTML(a.immune.map(cap).join(", "))}</span>
          </div>`;
        }
        const condList = a.conditions.map(cap).join(", ");
        if (!condList) return "";
        return `<div style="display:flex;align-items:center;flex-wrap:wrap;gap:6px;padding:2px 0;">
          <i class="fas fa-skull-crossbones" style="color:#ff5555;font-size:11px;"></i>
          ${nameSpan(a.targetName)}
          <span style="color:#888;">\u2192</span>
          <span style="color:#ff5555;font-weight:700;letter-spacing:0.5px;">${foundry.utils.escapeHTML(condList)}</span>
        </div>`;
      }).join("");
      actionsHtml = `<div class="ace-qol-save-conditions-applied" style="padding:8px 12px;background:linear-gradient(180deg,rgba(255,85,85,0.08),rgba(255,85,85,0.03));border-top:1px solid rgba(255,85,85,0.25);font-size:12px;">
          ${lines}
        </div>`;
    } else {
      // No conditions applied. Distinguish between:
      //   (a) Everyone passed their save \u2192 green "resisted" message
      //   (b) Someone failed but no conditions to apply \u2192 silent (leave blank)
      // Otherwise we'd show a misleading "all resisted" message when in fact
      // a target failed but the parser couldn't extract the condition (e.g.,
      // homebrew description format we don't recognize yet).
      // ⚠️ A PENDING TARGET IS NEITHER PASSED NOR FAILED (2026-07-28).
      // This asked only "did anyone fail?" — so a row still sitting on WAITING
      // FOR PLAYER counted as not-failed and the card printed the green
      // "All targets resisted" underneath it. The card announced the outcome of
      // a save nobody had rolled yet. "All targets resisted" is a claim about a
      // FINISHED set; don't make it until the set is finished.
      const anyPending   = (results ?? []).some(r => r?.pending);
      const anyoneFailed = (results ?? []).some(r => SaveEngine._failedTheSave(r));
      if (anyPending) {
        const n = (results ?? []).filter(r => r?.pending).length;
        actionsHtml = `<div class="ace-qol-save-no-effect" style="padding:6px 12px;text-align:center;color:#b9a978;font-size:11px;font-style:italic;">
          <i class="fas fa-hourglass-half"></i> Waiting on ${n} save${n === 1 ? "" : "s"}…
        </div>`;
      } else if (anyoneFailed) {
        // A target failed but no condition auto-applied. For properly-wired
        // save-or-condition powers this shouldn't happen \u2014 the condition
        // applies and renders above. NEVER surface a defeatist "apply manually"
        // note: the per-target FAIL already conveys the outcome, and genuine
        // gaps are logged to console for follow-up, not shown to the table.
        actionsHtml = "";
      } else {
        actionsHtml = `<div class="ace-qol-save-no-effect" style="padding:6px 12px;text-align:center;color:#88c878;font-size:11px;font-style:italic;">
          <i class="fas fa-shield-halved"></i> All targets resisted
        </div>`;
      }
    }

    return `
      <div class="ace-qol-save-results-card" data-phase="1">
        ${this._castAnnouncementHtml(item, item.actor, results, activityId)}
        <div class="ace-qol-save-header">
          <img src="${item.img || "icons/svg/spell.svg"}" class="ace-qol-save-item-img" />
          <div>
            <strong class="ace-qol-save-item-name">${_p1Title} \u2014 Saves</strong>
            <span class="ace-qol-save-dc">DC ${saveDC} ${abilityLabel}</span>
          </div>
        </div>
        <div class="ace-qol-save-results">
          ${targetRows}
        </div>
        ${this._modFootnote(results)}
        ${actionsHtml}
      </div>
    `;
  }

  async _postSaveResultsPhase1(item, casterActor, results, opts) {
    const { saveAbility, saveDC, halfOnSave, damageTypes, isSpell,
            timingType, templateDocId, templateSceneId, hasDamage = true,
            appliedConditions = [], activityId = null } = opts;

    const cardHtml = this._buildPhase1CardHtml(item, results, opts);

    // THE DICE LAND FIRST. Never post a result before the roll that
    // produced it has visibly stopped. (feedback_chat_cards_use_the_room)
    await awaitDiceSettle();

    await ChatMessage.create({
      content: cardHtml,
      speaker: ChatMessage.getSpeaker({ actor: casterActor }),
      // PUBLIC (Johnny 2026-07-11): the save results are visible to the whole
      // table. The ROLL DAMAGE button is .ace-qol-gm-only; damage rolls +
      // application still run GM-side via the existing button handler.
      flags: {
        [MODULE_ID]: {
          type: "saveResults",
          phase: 1,
          itemId: item.id,
          itemUuid: item.uuid,
          // WHICH CAST this card belongs to (2026-07-28). Without it,
          // _updateMainCardPcResult had no way to tell one Petrifying Gaze from
          // the next and simply grabbed the newest save card in the log — so a
          // result could land on a PREVIOUS cast's card. Two different targets
          // ending up on one card was exactly this.
          castId: opts.castId ?? null,
          // WHICH ability fired. Phase 2 reads this back off the card to roll
          // the right dice and headline the right name — without it the damage
          // roller falls back to "first activity with damage" and a four-power
          // staff rolls the wrong ability's damage. (2026-07-28)
          activityId,
          actorId: casterActor?.id,
          // Owning player(s) of the caster — they see the ROLL DAMAGE button and
          // roll their OWN spell damage (Johnny 2026-07-11: "PCs always roll
          // their own damage, it's part of the fun"). Mirrors the weapon path's
          // attackerOwnerUserIds. GM always rolls too.
          casterUserIds: game.users.filter(u => !u.isGM && casterActor?.testUserPermission?.(u, "OWNER")).map(u => u.id),
          saveAbility,
          saveDC,
          halfOnSave,
          damageTypes,
          isSpell,
          hasDamage, // false for save-only-condition spells; suppresses Phase 2
          appliedConditions, // [{ targetName, conditions:[...] }] for footer rendering
          allResults: results.map(r => ({
            name: r.name,
            img: r.img,
            tokenDocId: r.tokenDocId,
            actorId: r.actorId,
            sceneId: r.sceneId,
            saveTotal: r.saveTotal,
            passed: r.passed,
            isAutoFail: r.isAutoFail,
            resultLabel: r.resultLabel,
            damageMultiplier: r.damageMultiplier,
            dieResult: r.dieResult ?? null,
            damageModifiers: r.damageModifiers,
            currentHP: r.currentHP,
            maxHP: r.maxHP,
            isPC: r.isPC,
            pending: r.pending,
            // The Gate's verdict must survive serialization, or a card rebuild
            // (a PC resolving later, "add targets", a re-render) turns a
            // "DEAD — no save" row back into a red FAIL. (2026-08-06)
            noRoll: r.noRoll ?? null,
            noRollLabel: r.noRollLabel ?? null,
            noRollTone: r.noRollTone ?? null,
          })),
          timingType:      timingType ?? null,
          templateDocId:   templateDocId ?? null,
          templateSceneId: templateSceneId ?? null,
        }
      }
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Phase 2 — Complete Save Results (roll damage, update card in-place)
  // ═══════════════════════════════════════════════════════════════════════════

  async _completeSaveResultsPhase2(message) {
    const flags = message.flags?.[MODULE_ID];
    if (!flags || flags.phase !== 1) return;

    // Save-only-condition spells (no damage parts) never produce a Phase 2.
    // Defensive — the button shouldn't render, but if a stale card from
    // before this fix or a custom hook somehow fires here, refuse to post
    // a damage card with zero damage.
    if (flags.hasDamage === false) {
      console.log(`${MODULE_ID} | Phase 2 skipped — ${flags.itemId ?? "spell"} has no damage parts`);
      return;
    }

    const { itemUuid, itemId, actorId, saveAbility, saveDC, halfOnSave,
            damageTypes, isSpell, allResults, spellLevel } = flags;

    const item = await fromUuid(itemUuid) ?? game.items.get(itemId);
    const casterActor = game.actors.get(actorId);

    if (!item) {
      ui.notifications.error("ACE QOL | Could not find spell item for damage roll.");
      return;
    }

    // ── 1. Roll damage dice (with cantrip + upcast scaling) ──
    const damageComponents = await this._rollSpellDamage(item, casterActor, {
      spellLevel: Number.isFinite(spellLevel) ? spellLevel : null,
      activityId: flags.activityId ?? null,   // roll THIS ability's dice, not the item's first damaging one
    });
    const baseDamageTotal = damageComponents.reduce((sum, c) => sum + c.total, 0);

    // Damage info is shown in the results card header — no separate roll message needed

    // ── 3. Build Phase 2 card HTML with full damage data ──
    const cardHtml = this._buildPhase2CardHtml(item, casterActor, allResults, damageComponents, {
      saveAbility, saveDC, halfOnSave, damageTypes,
      activityId: flags.activityId ?? null,
    });

    // ── 4. Compute damageResults for flag storage ──
    const damageResults = [];
    for (const r of allResults) {
      if (r.pending) continue;
      let targetDamage = 0;
      // Keep the per-TYPE split, not just the total. It costs nothing here and
      // it lets the apply step describe the damage properly to anything
      // listening (Heavy Armor Master and friends) instead of handing over one
      // anonymous lump. The parts always sum to totalFinal by construction.
      const byType = [];
      for (const c of damageComponents) {
        let dmg = Math.floor(c.total * r.damageMultiplier);
        const mod = r.damageModifiers?.[c.type];
        if (mod?.modifier === "immune") dmg = 0;
        else if (mod?.modifier === "resistant") dmg = Math.floor(dmg / 2);
        else if (mod?.modifier === "vulnerable") dmg = dmg * 2;
        targetDamage += dmg;
        if (dmg > 0) byType.push({ type: c.type, value: dmg });
      }
      damageResults.push({
        targetId: r.actorId,
        tokenDocId: r.tokenDocId,
        sceneId: r.sceneId,
        totalFinal: targetDamage,
        byType,
        currentHP: r.currentHP,
      });
    }

    // ── 5. Update existing message in one call ──
    await message.update({
      content: cardHtml,
      [`flags.${MODULE_ID}.phase`]: 2,
      [`flags.${MODULE_ID}.baseDamageTotal`]: baseDamageTotal,
      [`flags.${MODULE_ID}.damageComponentTotals`]: damageComponents.map(c => ({ total: c.total, type: c.type, formula: c.formula })),
      [`flags.${MODULE_ID}.damageResults`]: damageResults,
    });

    // ── 6. Auto-delete the AOE template if the spell is instantaneous ──
    await this._deleteInstantTemplate(message.flags?.[MODULE_ID]);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  + TARGET SELECTED — append canvas-selected tokens to an existing save card
  // ═══════════════════════════════════════════════════════════════════════════

  async _addTargetsToCard(message, newTokens) {
    const flags = message.flags?.[MODULE_ID];
    if (!flags) return;
    const item  = await fromUuid(flags.itemUuid) ?? game.items.get(flags.itemId);
    const actor = game.actors.get(flags.actorId);
    if (!item) return;

    // ── Build target data for the new tokens (mirrors _postLiveTargetCard) ──
    const newTargetData = [];
    for (const token of newTokens) {
      const state = CombatState.assess(actor, token, item, {
        saveAbility: flags.saveAbility, isSpell: flags.isSpell, damageTypes: flags.damageTypes,
      });
      if (!state) continue;
      const isPC = SaveEngine.isPlayerCharacter(token.actor);
      // Save modifier via the target profile — ONE reader for a fact that
      // was being decoded seven different ways in this file alone.
      const saveMod = SaveEngine._targetProfileFor(token.actor, { tokenDocId: token?.document?.id, sceneId: token?.scene?.id })?.saveMod(flags.saveAbility) ?? 0;
      newTargetData.push({
        tokenId:        token.id,
        tokenDocId:     token.document?.id ?? token.id,
        actorId:        token.actor?.id,
        sceneId:        canvas.scene?.id,
        name:           state.target.name,
        img:            state.target.img,
        isPC,
        saveMod:        saveMod >= 0 ? `+${saveMod}` : `${saveMod}`,
        saveAbilityUpper: flags.saveAbility.toUpperCase(),
        autoFailSave:   state.autoFailSave,
        superSaver:     state.superSaver,
        damageModifiers: state.damageModifiers,
        // ASK, don't reconstruct — see SaveEngine.ownerUserIds. (audit F-020)
        ownerIds:       isPC ? SaveEngine.ownerUserIds(token.actor) : [],
      });
    }
    if (!newTargetData.length) return;

    // ── Build damage indicator for color coding ──
    const dmgInd = (t) => {
      const dt = flags.damageTypes;
      if (!t.damageModifiers || !dt?.length) return { cls: "", tag: "" };
      let im=false, re=false, vu=false;
      for (const d of dt) {
        const m = t.damageModifiers[d];
        if (m?.modifier === "immune")     im = true;
        else if (m?.modifier === "resistant")  re = true;
        else if (m?.modifier === "vulnerable") vu = true;
      }
      if (im) return { cls: "ace-qol-tgt-immune", tag: '<span class="ace-qol-tag ace-qol-tag-immune"><i class="fas fa-shield-halved"></i> IMMUNE</span>' };
      if (re) return { cls: "ace-qol-tgt-resist", tag: '<span class="ace-qol-tag ace-qol-tag-resist"><i class="fas fa-shield-halved"></i> RESIST</span>' };
      if (vu) return { cls: "ace-qol-tgt-vuln",   tag: '<span class="ace-qol-tag ace-qol-tag-vuln"><i class="fas fa-burst"></i> VULN</span>' };
      return { cls: "", tag: "" };
    };

    // Action sub-row helper (mirrors primary builder above) — kept in sync.
    const buildActionsRow = (t, isPc) => {
      const di = dmgInd(t);
      const dice = isPc
        ? `<button class="ace-qol-save-pc-roll-btn" data-action="aceQolGmRollPcSave" data-token-doc-id="${t.tokenDocId}" title="Roll save on this PC's behalf (GM)">
             <img src="modules/ace-qol/Assets/Dice%20Dice/BD20/BD20-20_nobg.png" class="ace-qol-save-pc-dice-img" alt="d20" onerror="this.style.display='none';this.nextElementSibling.style.display='inline'" />
             <i class="fas fa-dice-d20" style="display:none"></i>
           </button>`
        : "";
      const badges = [
        t.autoFailSave ? '<span class="ace-qol-tag ace-qol-tag-danger"><i class="fas fa-circle-xmark"></i> AUTO-FAIL</span>' : "",
        t.superSaver ? '<span class="ace-qol-tag ace-qol-tag-buff"><i class="fas fa-person-running"></i> EVASION</span>' : "",
        di.tag,
      ].filter(Boolean).join("");
      return `<div class="ace-qol-save-tgt-actions">${dice}${badges}</div>`;
    };
    const buildNpcRow = (t) => {
      const di = dmgInd(t);
      return `<div class="ace-qol-save-tgt-row ${di.cls}" data-token-id="${t.tokenId}" data-pc="false">
        <img src="${t.img || "icons/svg/mystery-man.svg"}" class="ace-qol-save-tgt-img" />
        <div class="ace-qol-save-tgt-identity">
          <span class="ace-qol-save-tgt-name">${t.name}</span>
          <span class="ace-qol-save-tgt-mod">${t.saveAbilityUpper} ${t.saveMod}</span>
        </div>
        <button class="ace-qol-save-tgt-remove" data-action="aceQolRemoveTarget" data-token-id="${t.tokenId}"><i class="fas fa-xmark"></i></button>
        ${buildActionsRow(t, false)}
      </div>`;
    };
    const buildPcRow = (t) => {
      const di = dmgInd(t);
      return `<div class="ace-qol-save-tgt-row ace-qol-save-tgt-pc ${di.cls}" data-token-id="${t.tokenId}" data-token-doc-id="${t.tokenDocId}" data-actor-id="${t.actorId}" data-pc="true">
        <img src="${t.img || "icons/svg/mystery-man.svg"}" class="ace-qol-save-tgt-img" />
        <div class="ace-qol-save-tgt-identity">
          <span class="ace-qol-save-tgt-name">${t.name}</span>
          <span class="ace-qol-save-tgt-mod">${t.saveAbilityUpper} ${t.saveMod}</span>
        </div>
        <button class="ace-qol-save-tgt-remove" data-action="aceQolRemoveTarget" data-token-id="${t.tokenId}" title="Remove this PC from the save list">
          <i class="fas fa-xmark"></i>
        </button>
        ${buildActionsRow(t, true)}
      </div>`;
    };

    // ── Build the COMPLETE updated targets list (existing minus duplicates + new) ──
    // flags.targets is the authoritative source — reflects any X-removals already done.
    // Rebuilding sections from scratch avoids stale-content bugs where removed targets
    // would resurface because message.content wasn't updated alongside flag changes.
    const existingIds  = new Set((flags.targets ?? []).map(t => t.tokenDocId));
    const dedupedNew   = newTargetData.filter(t => !existingIds.has(t.tokenDocId));
    if (!dedupedNew.length) {
      ui.notifications.info("ACE QOL: All selected tokens are already in the target list.");
      return;
    }
    const updatedTargets = [...(flags.targets ?? []), ...dedupedNew];
    const allNpcs = updatedTargets.filter(t => !t.isPC);
    const allPcs  = updatedTargets.filter(t =>  t.isPC);
    const allNpcRowsHtml = allNpcs.map(buildNpcRow).join("");
    const allPcRowsHtml  = allPcs.map(buildPcRow).join("");

    // ── Replace the section contents in the parsed DOM (don't append to stale HTML) ──
    const parser = new DOMParser();
    const doc = parser.parseFromString(message.content, "text/html");
    const card = doc.querySelector(".ace-qol-save-card");
    if (!card) {
      console.warn(`${MODULE_ID} | Could not find save card to update targets`);
      return;
    }

    const ensureSection = (selector, classes) => {
      let s = card.querySelector(selector);
      if (!s) {
        s = doc.createElement("div");
        s.className = classes;
        const actions = card.querySelector(".ace-qol-save-actions");
        if (actions) actions.before(s); else card.appendChild(s);
      }
      return s;
    };
    // Remove any existing sections so we can rebuild cleanly
    card.querySelectorAll(".ace-qol-save-tgt-section").forEach(s => s.remove());
    if (allNpcRowsHtml) {
      const sec = ensureSection("__missing__", "ace-qol-save-tgt-section");
      sec.innerHTML = allNpcRowsHtml;
    }
    if (allPcRowsHtml) {
      const sec = ensureSection("__missing__", "ace-qol-save-tgt-section ace-qol-save-tgt-section-pc");
      sec.innerHTML = allPcRowsHtml;
    }

    // Update local var for the prompt loop and the success notification
    const newPcs = dedupedNew.filter(t => t.isPC);
    const newNpcs = dedupedNew.filter(t => !t.isPC);

    // ── Persist ──
    await message.update({
      content: card.outerHTML,
      [`flags.${MODULE_ID}.targets`]: updatedTargets,
    });

    // ── Clear any stale pcSaveResults for re-added PCs (so they get a fresh roll) ──
    // Use case: PC was on the list, rolled, X-removed (e.g., user wants to apply a buff),
    // then re-added via TARGET SELECTED — they should be allowed to re-roll.
    for (const tgt of newPcs) {
      try {
        const stale = game.messages.contents.filter(m => {
          const f = m.flags?.[MODULE_ID];
          return f?.type === "pcSaveResult"
              && f.tokenDocId === tgt.tokenDocId
              && f.castId === message.id;
        });
        for (const m of stale) await m.delete();
      } catch (err) {
        console.warn(`${MODULE_ID} | Failed to clear stale pcSaveResult for ${tgt.name}:`, err);
      }
    }

    // ── Send prompts to any new PCs ──
    // OFFLINE OWNERS AUTO-ROLL HERE TOO (2026-07-28). This path prompted every
    // PC unconditionally while the main cast path checked first and rolled for
    // absent players. So a save aimed at an offline character through THIS door
    // sat on "waiting for player" forever, waiting on someone who wasn't in the
    // building. Same rule, both doors — an absent player is treated like an NPC.
    const _iAmActiveGM2 = game.users?.activeGM === game.user;
    for (const tgt of newPcs) {
      try {
        // THE GATE — a target added to a live card gets the same scan as one
        // that was there from the start. Skipping it here is how "add targets"
        // would quietly become the one door with no lock on it.
        const _addVerdict = SaveEngine._verdictForTargetRow(tgt);
        if (_addVerdict) {
          console.log(`${MODULE_ID} | GATE: ${tgt.name} (PC, added) — ${_addVerdict.reason.toUpperCase()}, no prompt sent.`);
          continue;
        }
        if (_iAmActiveGM2 && !this._pcOwnerActive(tgt)) {
          console.log(`${MODULE_ID} | PC "${tgt.name}" owner is offline — GM auto-rolling their save (added target).`);
          await this._gmRollPcSaveOffline(item, actor, tgt, {
            saveAbility:  flags.saveAbility,
            saveDC:       flags.saveDC,
            halfOnSave:   flags.halfOnSave,
            damageTypes:  flags.damageTypes,
            isSpell:      flags.isSpell,
            castId:       message.id,
          });
          continue;
        }
        await this._sendPcSavePrompt(item, actor, tgt, {
          saveAbility:  flags.saveAbility,
          saveDC:       flags.saveDC,
          halfOnSave:   flags.halfOnSave,
          damageTypes:  flags.damageTypes,
          isSpell:      flags.isSpell,
          castId:       message.id,
        });
      } catch (err) {
        console.warn(`${MODULE_ID} | Failed to send prompt to new PC ${tgt.name}:`, err);
      }
    }

    const npcMsg = newNpcs.length ? ` (${newNpcs.length} NPC${newNpcs.length > 1 ? "s" : ""})` : "";
    const pcMsg  = newPcs.length  ? ` (${newPcs.length} PC${newPcs.length > 1 ? "s" : ""} prompted)` : "";
    ui.notifications.info(`ACE QOL: Added ${newTargetData.length} target${newTargetData.length > 1 ? "s" : ""}${npcMsg}${pcMsg}.`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Auto-delete instant spell templates (Fireball, Lightning Bolt, etc.)
  //  Persistent spells (Fog Cloud, Spirit Guardians) keep their template.
  // ═══════════════════════════════════════════════════════════════════════════

  async _deleteInstantTemplate(flags) {
    try {
      if (!flags) return;
      if (game.settings.get(MODULE_ID, "autoDeleteInstantTemplates") === false) {
        gateOff("instant-template cleanup", "autoDeleteInstantTemplates");
        return;
      }
      if (flags.timingType !== TIMING.INSTANT) return;
      const sceneId = flags.templateSceneId;
      const tmplId  = flags.templateDocId;
      if (!sceneId || !tmplId) return;
      const scene = game.scenes.get(sceneId);
      const tmpl  = scene?.templates?.get(tmplId);
      if (!tmpl) return;

      // ── Release anything bound to this template FIRST (2026-07-28) ──
      // Sequencer effects can be attached to a MeasuredTemplate — ours or
      // another module's (Automated Animations especially). Deleting the
      // template out from under them leaves the effect pointing at an object
      // that no longer exists, and Sequencer throws a red banner across the
      // GM's canvas: "could not find object with ID: …MeasuredTemplate…".
      // The template is ours and we chose to delete it, so cleaning up after
      // ourselves is our job, not something the GM should have to ignore.
      // ⚠️ AWAIT IT. This was fire-and-forget, so the delete below raced the
      // very cleanup meant to prevent the error. endEffects returns a promise;
      // not awaiting it means the template can vanish while Sequencer is still
      // detaching from it, which produces exactly the red banner this block
      // exists to avoid. Johnny has been dismissing that toast after every
      // single area spell.
      try {
        await globalThis.Sequencer?.EffectManager?.endEffects?.({ object: tmpl });
      } catch (_) { /* Sequencer absent or nothing attached — fine */ }

      // ⚠️ Belt and braces for the case awaiting cannot fix: the effect may
      // be owned by ANOTHER client's Sequencer (a player's, or Automated
      // Animations mid-flight), and we cannot end that one from here. Arm a
      // short, narrow window that swallows only this one message.
      try {
        const { armTemplateNoiseGuard } = await import("./template-noise.mjs");
        armTemplateNoiseGuard();
      } catch (_) { /* guard optional */ }

      await tmpl.delete();
      console.log(`${MODULE_ID} | Auto-deleted instant template ${tmplId}`);
    } catch (err) {
      console.warn(`${MODULE_ID} | Failed to auto-delete instant template:`, err);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Build Phase 2 Card HTML (extracted from _postSaveResults)
  // ═══════════════════════════════════════════════════════════════════════════

  _buildPhase2CardHtml(item, casterActor, results, damageComponents, opts) {
    const { saveAbility, saveDC, halfOnSave, damageTypes, activityId = null } = opts;
    const abilityLabel = CONFIG.DND5E?.abilities?.[saveAbility]?.label ?? saveAbility.toUpperCase();
    const baseDamageTotal = damageComponents.reduce((sum, c) => sum + c.total, 0);

    // ── Sort: highest save roll first, pending PCs at bottom ──
    const sorted = [...results].sort((a, b) => {
      // SILENT-OK: a sort comparator returning an order, not an exit
      if (a.pending && !b.pending) return 1;
      // SILENT-OK: a sort comparator returning an order, not an exit
      if (!a.pending && b.pending) return -1;
      return (b.saveTotal ?? -999) - (a.saveTotal ?? -999);
    });

    // ── Build result rows ──
    const targetRows = sorted.map(r => {
      // PC still pending
      if (r.pending) {
        return `
          <div class="ace-qol-save-result-row ace-qol-save-result-pending" data-token-doc-id="${r.tokenDocId}">
            <div class="ace-qol-save-result-target">
              <img src="${r.img || "icons/svg/mystery-man.svg"}" class="ace-qol-save-tgt-img" />
              <span class="ace-qol-save-tgt-name">${r.name}</span>
              <span class="ace-qol-save-result-label ace-qol-save-pending">WAITING FOR PLAYER</span>
            </div>
          </div>
        `;
      }

      // Gated by the Gate — carry the verdict onto the damage card too, so a
      // target that never rolled doesn't reappear here wearing a red "FAIL".
      // (2026-08-06, ONE_GATE phase 0)
      if (r.noRoll) {
        const tone = r.noRollTone === "immune"
          ? { colour: "#ffaa44", icon: "fa-shield-halved" }
          : { colour: "#9a9aa2", icon: "fa-skull" };
        return `
          <div class="ace-qol-save-result-row ace-qol-save-result-noroll" data-token-doc-id="${r.tokenDocId}" style="opacity:0.9;">
            <div class="ace-qol-save-result-target">
              <img src="${r.img || "icons/svg/mystery-man.svg"}" class="ace-qol-save-tgt-img" />
              <span class="ace-qol-save-tgt-name" style="white-space:nowrap;">${foundry.utils.escapeHTML(r.name ?? "")}</span>
              <span style="display:inline-flex;align-items:center;gap:6px;color:${tone.colour};font-weight:700;letter-spacing:0.5px;">
                <i class="fas ${tone.icon}"></i>${foundry.utils.escapeHTML(r.noRollLabel ?? "")}
              </span>
            </div>
          </div>
        `;
      }

      const passClass = r.passed ? "ace-qol-save-pass" : "ace-qol-save-fail";
      const verdictText = r.passed ? "PASS" : "FAIL";

      // Dice breakdown — d20 face large + bright, modifier muted, total pass/fail colour.
      // Uses dieResult (persisted in flags) so the Phase 2 rebuild never loses the die face.
      let rollDisplay;
      if (r.isAutoFail) {
        rollDisplay = `<span class="ace-qol-save-roll ${passClass}">AUTO</span>`;
      } else {
        const d20Face = r.dieResult ?? r.roll?.dice?.[0]?.total ?? null;
        const modifier = (typeof r.saveTotal === "number" && d20Face != null)
          ? r.saveTotal - d20Face : null;
        if (d20Face != null && modifier != null) {
          const modSign = modifier >= 0 ? "+" : "";
          const modPart = modifier === 0 ? "" : ` ${modSign}${modifier}`;
          rollDisplay = `
            <span class="ace-qol-save-roll-breakdown" style="display:inline-flex;align-items:center;gap:7px;font-family:'Signika',sans-serif;">
              ${aceD20FaceImg(d20Face, { size: 34 })}
              <span style="color:#ffffff;font-size:18px;font-weight:700;">${d20Face}</span>
              <span style="color:#b9a978;font-size:15px;">${modPart} =</span>
              <span class="${passClass}" style="font-weight:700;font-size:18px;">${r.saveTotal}</span>
            </span>`;
        } else {
          rollDisplay = `<span class="ace-qol-save-roll ${passClass}">${r.saveTotal}</span>`;
        }
      }

      // ── Calculate per-target damage ──
      let targetDamage = 0;
      const dmgReasons = [];
      const dmgParts = damageComponents.map(c => {
        let dmg = Math.floor(c.total * r.damageMultiplier);
        const mod = r.damageModifiers?.[c.type];
        if (mod?.modifier === "immune") {
          dmg = 0;
          dmgReasons.push(`IMMUNE to ${c.type}`);
        } else if (mod?.modifier === "resistant") {
          dmg = Math.floor(dmg / 2);
          dmgReasons.push(`RESIST ${c.type}`);
        } else if (mod?.modifier === "vulnerable") {
          dmg = dmg * 2;
          dmgReasons.push(`VULN ${c.type}`);
        }
        targetDamage += dmg;
        return dmg;
      });

      const newHP = Math.max(0, r.currentHP - targetDamage);
      const isDead = newHP <= 0;

      // Inline badge for immune/resist/vuln
      const inlineBadge = dmgReasons.length
        ? dmgReasons.map(dr => {
            if (dr.includes("IMMUNE")) return '<span class="ace-qol-save-inline-badge immune">IMMUNE</span>';
            if (dr.includes("RESIST")) return '<span class="ace-qol-save-inline-badge resist">\u00bd</span>';
            if (dr.includes("VULN")) return '<span class="ace-qol-save-inline-badge vuln">\u00d72</span>';
            return "";
          }).join("")
        : "";

      // Determine EFFECTIVE multiplier (save × resist/vuln) for button highlighting
      let effectiveMult = r.damageMultiplier;
      const mods = r.damageModifiers ?? {};
      for (const dtype of Object.keys(mods)) {
        if (mods[dtype]?.modifier === "immune") { effectiveMult = 0; break; }
        if (mods[dtype]?.modifier === "resistant") effectiveMult *= 0.5;
        if (mods[dtype]?.modifier === "vulnerable") effectiveMult *= 2;
      }
      // Snap to nearest button value: 0, 0.25, 0.5, 1, 2
      const snapValues = [0, 0.25, 0.5, 1, 2];
      const dm = snapValues.reduce((prev, curr) => Math.abs(curr - effectiveMult) < Math.abs(prev - effectiveMult) ? curr : prev);
      const _a = (val) => dm === val ? " ace-qol-save-ovr-active" : "";
      const dmgDisplay = targetDamage === 0 ? "0" : targetDamage.toString();

      // Color-code name to match target list (immune=red, resist=yellow, vuln=purple)
      let nameClass = "";
      if (dmgReasons.some(d => d.includes("IMMUNE"))) nameClass = "ace-qol-tgt-immune";
      else if (dmgReasons.some(d => d.includes("VULN"))) nameClass = "ace-qol-tgt-vuln";
      else if (dmgReasons.some(d => d.includes("RESIST"))) nameClass = "ace-qol-tgt-resist";

      // Two-line layout (name on top, formula/verdict below) so long names
      // don't get squished into a vertical "Dea/th/Kni/ght" stack next to
      // the dice readout.
      return `
        <div class="ace-qol-save-result-row ${nameClass}" data-token-doc-id="${r.tokenDocId}"
             style="padding:8px 10px;border-bottom:1px solid rgba(212,175,55,0.15);">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;">
            <img src="${r.img || "icons/svg/mystery-man.svg"}" class="ace-qol-save-tgt-img"
                 style="width:24px;height:24px;border-radius:50%;flex-shrink:0;border:1px solid #444;" />
            <span class="ace-qol-save-tgt-name"
                  style="flex:1;font-weight:bold;color:#fff;font-size:14px;line-height:1.2;">${r.name}</span>
            ${inlineBadge}
          </div>
          <div style="display:flex;justify-content:space-between;align-items:center;padding-left:32px;gap:8px;">
            <span style="flex:1;">${rollDisplay}</span>
            <span class="ace-qol-save-verdict ${passClass}"
                  style="font-weight:bold;font-size:14px;letter-spacing:0.5px;">${verdictText}</span>
          </div>
          <div class="ace-qol-save-ovr-line">
            <button class="ace-qol-save-ovr-x" data-action="aceQolRemoveResult" data-token-doc-id="${r.tokenDocId}">\u00d7</button>
            <button class="ace-qol-save-ovr${_a(0.25)}" data-action="aceQolDmgOverride" data-token-doc-id="${r.tokenDocId}" data-multiplier="0.25">\u00bc</button>
            <button class="ace-qol-save-ovr${_a(0.5)}" data-action="aceQolDmgOverride" data-token-doc-id="${r.tokenDocId}" data-multiplier="0.5">\u00bd</button>
            <button class="ace-qol-save-ovr${_a(1)}" data-action="aceQolDmgOverride" data-token-doc-id="${r.tokenDocId}" data-multiplier="1">1</button>
            <button class="ace-qol-save-ovr${_a(2)}" data-action="aceQolDmgOverride" data-token-doc-id="${r.tokenDocId}" data-multiplier="2">2</button>
            <span class="ace-qol-save-ovr-spacer"></span>
            <span class="ace-qol-save-result-dmg">${dmgDisplay}<span class="ace-qol-dmg-unit">DMG</span></span>${isDead ? '<span class="ace-qol-save-skull">\u2620</span>' : '<span class="ace-qol-save-skull" style="display:none">\u2620</span>'}
            <span class="ace-qol-save-result-hp">HP: <span class="ace-qol-hp-cur">${r.currentHP}</span>\u2192<span class="ace-qol-hp-new${isDead ? ' ace-qol-hp-dead' : ''}">${newHP}</span></span>
          </div>
        </div>
      `;
    }).join("");

    // ── Damage summary ──
    const dmgSummary = damageComponents.map(c => {
      const color = DamageConstants.DAMAGE_COLORS[c.type] ?? "#ccc";
      return `<span style="color:${color}">${c.formula} = ${c.total} ${c.type}</span>`;
    }).join(", ");

    return `
      <div class="ace-qol-save-results-card" data-phase="2">
        ${this._castAnnouncementHtml(item, casterActor, results, activityId)}
        <div class="ace-qol-save-header">
          <img src="${item.img || "icons/svg/spell.svg"}" class="ace-qol-save-item-img" />
          <div>
            <strong class="ace-qol-save-item-name">${this._abilityLabel(item, activityId)} \u2014 Save Results</strong>
            <span class="ace-qol-save-dc">DC ${saveDC} ${abilityLabel}</span>
          </div>
        </div>
        <div class="ace-qol-save-dmg-summary">Damage: ${dmgSummary}</div>
        <div class="ace-qol-save-results">
          ${targetRows}
        </div>
        <div class="ace-qol-dmg-actions ace-qol-gm-only">
          <button class="ace-qol-btn ace-qol-btn-apply" data-action="aceQolApplyDamage">
            <i class="fas fa-heart-crack"></i> APPLY ALL
          </button>
          <button class="ace-qol-btn ace-qol-btn-undo" data-action="aceQolUndoDamage" disabled>
            <i class="fas fa-undo"></i> UNDO ALL
          </button>
        </div>
      </div>
    `;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Save Results + Damage Card (Legacy / Direct Post)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * THE target profile for one creature in a save flow. (2026-07-28)
   *
   * First step of pointing the save pipeline at the profile layer instead of
   * reaching into the actor. The audit found the profile builders had almost no
   * consumers — the target profile had NONE — while this engine read raw actor
   * data in seventeen places and got condition immunity wrong because of it.
   *
   * Cached per resolution pass so a twelve-target storm builds each creature's
   * snapshot once, not once per question asked about it.
   */
  static _profileCache = new Map();

  static _targetProfileFor(actor, row = null) {
    if (!actor) return null;
    const key = row?.tokenDocId ?? actor.uuid ?? actor.id;
    const hit = SaveEngine._profileCache.get(key);
    if (hit) return hit;
    let profile = null;
    try {
      const scene = row?.sceneId ? game.scenes.get(row.sceneId) : canvas?.scene;
      const tokenDoc = row?.tokenDocId ? scene?.tokens?.get(row.tokenDocId) : null;
      profile = buildTargetProfile(actor, { token: tokenDoc?.object ?? tokenDoc ?? null });
    } catch (err) {
      console.warn(`${MODULE_ID} | target profile build failed for ${actor?.name}:`, err);
    }
    if (profile) {
      SaveEngine._profileCache.set(key, profile);
      // Short-lived: a creature's state changes DURING a fight, so a cached
      // snapshot must never outlive the resolution that built it.
      setTimeout(() => SaveEngine._profileCache.delete(key), 5000);
    }
    return profile;
  }

  /**
   * FOOTNOTES — where every modifier on a save card explains itself. (2026-07-28)
   *
   * A card that shows a bare "+3" makes the GM go and work out where it came
   * from. Firaxis has Constitution 2, so his save reads like it should be −4;
   * it's actually +0 (proficiency cancels the penalty) plus +3 from his own
   * Paladin Aura of Protection. Nothing on the card said so, and it took a
   * console probe to answer.
   *
   * Folding it into the formula would produce an unreadable string, so it goes
   * at the BOTTOM of the card as footnotes — one line per source, naming who it
   * applied to. Johnny 2026-07-28: "Footnotes at the bottom would be better in
   * any case. We're not looking for real estate. We have lots."
   *
   * @param {Array} rows  Target rows carrying { name, saveBonuses:[{value,label}] }
   */
  _modFootnote(rows) {
    try {
      const bySource = new Map();          // label → { value, names:Set }
      for (const r of (rows ?? [])) {
        for (const b of (r?.saveBonuses ?? [])) {
          const raw = String(b?.value ?? "").trim();
          if (!raw) continue;
          const n = Number(raw.replace(/^\+/, ""));
          if (Number.isFinite(n) && n === 0) continue;    // "+0" explains nothing
          const label = String(b?.label ?? "Bonus").trim();
          const key = `${label}|${raw}`;
          if (!bySource.has(key)) bySource.set(key, { label, value: raw, names: new Set() });
          if (r?.name) bySource.get(key).names.add(String(r.name));
        }
      }
      if (!bySource.size) return "";

      const esc = foundry.utils.escapeHTML;
      const lines = [...bySource.values()].map(s => {
        const v = s.value.startsWith("+") || s.value.startsWith("-") ? s.value : `+${s.value}`;
        const who = [...s.names];
        // Name everyone when it's a couple of creatures; collapse when it's the
        // whole room, so a 12-target storm doesn't print a paragraph.
        const whoTxt = who.length === 0 ? ""
          : who.length <= 3 ? ` — ${esc(who.join(", "))}`
          : ` — ${who.length} creatures`;
        return `<div class="ace-qol-save-note">
                  <span class="ace-qol-save-note-val">${esc(v)}</span>
                  <span class="ace-qol-save-note-label">${esc(s.label)}</span>
                  <span class="ace-qol-save-note-who">${whoTxt}</span>
                </div>`;
      });
      return `<div class="ace-qol-save-notes">
                <div class="ace-qol-save-notes-head">Modifiers applied</div>
                ${lines.join("")}
              </div>`;
    } catch (_) { return ""; }
  }

  /**
   * THE reader for what to CALL an action on a card. (2026-07-28)
   *
   * A multi-power item that headlines its own name tells the table nothing:
   * "Stormforger — Save Results" could be the storm, the tornado, or the
   * flight. Name the ABILITY — "Thunderstorm of Misery" — and let the item
   * name drop to a subtitle where the layout has room for one.
   *
   * Two half-versions of this logic already existed on two different cards,
   * which is exactly why the other four still said the item name. One reader,
   * every card.
   *
   * dnd5e leaves an activity's name blank when there's only one, falling back
   * to a generic type label; a blank or type-echo name is worthless as a title,
   * so those correctly yield the item name instead.
   *
   * @param {Item5e} item
   * @param {string} [activityId]
   * @param {object} [o]
   * @param {boolean} [o.rawOnly]  Return "" instead of the item name when the
   *                               activity has no distinct name of its own.
   */
  _abilityLabel(item, activityId = null, { rawOnly = false } = {}) {
    let name = "";
    try {
      const act = activityId ? item?.system?.activities?.get?.(activityId) : null;
      name = String(act?.name ?? "").trim();
      // A name that's just the activity type ("Save", "Attack", "Utility") is
      // dnd5e's placeholder, not a title.
      const generic = new Set(["save", "saving throw", "attack", "damage", "heal",
        "healing", "utility", "cast", "summon", "enchant", "check", "effect", "use"]);
      if (generic.has(name.toLowerCase())) name = "";
      if (name && item?.name && name === item.name) name = "";
    } catch (_) { name = ""; }
    if (rawOnly) return name;
    return name || item?.name || "Ability";
  }

  async _postSaveResults(item, casterActor, results, opts, damageComponents) {
    const { saveAbility, saveDC, halfOnSave, damageTypes, spellLevel, activityId } = opts;
    const abilityLabel = CONFIG.DND5E?.abilities?.[saveAbility]?.label ?? saveAbility.toUpperCase();

    // If damageComponents not provided, roll them (with cantrip + upcast scaling)
    if (!damageComponents) {
      damageComponents = await this._rollSpellDamage(item, casterActor, {
        spellLevel: Number.isFinite(spellLevel) ? spellLevel : null,
        activityId: activityId ?? null,   // roll THIS ability's dice, not the item's first damaging one
      });
    }

    const baseDamageTotal = damageComponents.reduce((sum, c) => sum + c.total, 0);

    // ── Build result rows ──
    const targetRows = results.map(r => {
      // ── PC still pending ──
      if (r.pending) {
        return `
          <div class="ace-qol-save-result-row ace-qol-save-result-pending" data-token-doc-id="${r.tokenDocId}">
            <div class="ace-qol-save-result-target">
              <img src="${r.img || "icons/svg/mystery-man.svg"}" class="ace-qol-save-tgt-img" />
              <span class="ace-qol-save-tgt-name">${r.name}</span>
              <span class="ace-qol-save-result-label ace-qol-save-pending">WAITING FOR PLAYER</span>
            </div>
          </div>
        `;
      }

      const passClass = r.passed ? "ace-qol-save-pass" : "ace-qol-save-fail";
      const rollDisplay = r.isAutoFail ? "AUTO" : r.saveTotal;

      // ── Calculate per-target damage with multiplier and resistance checks ──
      let targetDamage = 0;
      const dmgReasons = [];
      const dmgParts = damageComponents.map(c => {
        let dmg = Math.floor(c.total * r.damageMultiplier);
        const mod = r.damageModifiers?.[c.type];
        let modBadge = "";

        if (mod?.modifier === "immune") {
          dmg = 0;
          modBadge = '<span class="ace-qol-dmg-mod ace-qol-dmg-immune">IMMUNE</span>';
          dmgReasons.push(`\ud83d\udee1\ufe0f IMMUNE to ${c.type} \u2014 0 damage`);
        } else if (mod?.modifier === "resistant") {
          dmg = Math.floor(dmg / 2);
          modBadge = '<span class="ace-qol-dmg-mod ace-qol-dmg-resist">\u00bd</span>';
          dmgReasons.push(`\ud83d\udee1\ufe0f RESIST ${c.type} \u2014 halved`);
        } else if (mod?.modifier === "vulnerable") {
          dmg = dmg * 2;
          modBadge = '<span class="ace-qol-dmg-mod ace-qol-dmg-vuln">\u00d72</span>';
          dmgReasons.push(`\u2620\ufe0f VULN ${c.type} \u2014 doubled`);
        }

        targetDamage += dmg;
        const color = DamageConstants.DAMAGE_COLORS[c.type] ?? "#ccc";
        return `<span style="color:${color}">${dmg} ${c.type}</span>${modBadge}`;
      }).join(" ");

      const newHP = Math.max(0, r.currentHP - targetDamage);
      const isDead = newHP <= 0;

      // Store for apply
      r.totalDamage = targetDamage;
      r.newHP = newHP;

      // ── Build reason line ──
      let reasonText;
      if (r.isAutoFail) {
        reasonText = `<span class="ace-qol-save-fail">AUTO-FAIL (condition)</span>`;
      } else if (r.passed && r.resultLabel.includes("EVASION")) {
        reasonText = `<span class="ace-qol-save-pass">EVASION \u2014 SAVED \u2014 0 damage</span>`;
      } else if (r.passed) {
        reasonText = `<span class="ace-qol-save-pass">Rolled ${r.saveTotal} \u2014 SAVED (DC ${saveDC})</span>`;
      } else if (r.resultLabel.includes("EVASION")) {
        reasonText = `<span class="ace-qol-save-fail">Rolled ${r.saveTotal} \u2014 FAILED (DC ${saveDC}) \u2014 EVASION: half</span>`;
      } else {
        reasonText = `<span class="ace-qol-save-fail">Rolled ${r.saveTotal} \u2014 FAILED (DC ${saveDC})</span>`;
      }

      // Add resistance/immunity/vulnerability reasons
      const modReasonHtml = dmgReasons.length
        ? dmgReasons.map(dr => `<div class="ace-qol-save-mod-reason">${dr}</div>`).join("")
        : "";

      // Inline badge for immune/resist/vuln
      const inlineBadge = dmgReasons.length
        ? dmgReasons.map(dr => {
            if (dr.includes("IMMUNE")) return '<span class="ace-qol-save-inline-badge immune">IMMUNE</span>';
            if (dr.includes("RESIST")) return '<span class="ace-qol-save-inline-badge resist">½</span>';
            if (dr.includes("VULN")) return '<span class="ace-qol-save-inline-badge vuln">×2</span>';
            return "";
          }).join("")
        : "";

      const verdictText = r.passed ? "PASS" : "FAIL";

      // Determine EFFECTIVE multiplier (save × resist/vuln) for button highlighting
      let effectiveMult = r.damageMultiplier;
      const mods = r.damageModifiers ?? {};
      for (const dtype of Object.keys(mods)) {
        if (mods[dtype]?.modifier === "immune") { effectiveMult = 0; break; }
        if (mods[dtype]?.modifier === "resistant") effectiveMult *= 0.5;
        if (mods[dtype]?.modifier === "vulnerable") effectiveMult *= 2;
      }
      // Snap to nearest button value: 0, 0.25, 0.5, 1, 2
      const snapValues = [0, 0.25, 0.5, 1, 2];
      const dm = snapValues.reduce((prev, curr) => Math.abs(curr - effectiveMult) < Math.abs(prev - effectiveMult) ? curr : prev);
      const _a = (val) => dm === val ? " ace-qol-save-ovr-active" : "";
      const dmgDisplay = targetDamage === 0 ? "0" : targetDamage.toString();

      // Color-code name to match target list (immune=red, resist=yellow, vuln=purple)
      let nameClass = "";
      if (dmgReasons.some(d => d.includes("IMMUNE"))) nameClass = "ace-qol-tgt-immune";
      else if (dmgReasons.some(d => d.includes("VULN"))) nameClass = "ace-qol-tgt-vuln";
      else if (dmgReasons.some(d => d.includes("RESIST"))) nameClass = "ace-qol-tgt-resist";

      // Two-line layout (name on top, formula/verdict below) so long names
      // don't get squished into a vertical "Dea/th/Kni/ght" stack next to
      // the dice readout.
      return `
        <div class="ace-qol-save-result-row ${nameClass}" data-token-doc-id="${r.tokenDocId}"
             style="padding:8px 10px;border-bottom:1px solid rgba(212,175,55,0.15);">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;">
            <img src="${r.img || "icons/svg/mystery-man.svg"}" class="ace-qol-save-tgt-img"
                 style="width:24px;height:24px;border-radius:50%;flex-shrink:0;border:1px solid #444;" />
            <span class="ace-qol-save-tgt-name"
                  style="flex:1;font-weight:bold;color:#fff;font-size:14px;line-height:1.2;">${r.name}</span>
            ${inlineBadge}
          </div>
          <div style="display:flex;justify-content:space-between;align-items:center;padding-left:32px;gap:8px;">
            <span style="flex:1;">${rollDisplay}</span>
            <span class="ace-qol-save-verdict ${passClass}"
                  style="font-weight:bold;font-size:14px;letter-spacing:0.5px;">${verdictText}</span>
          </div>
          <div class="ace-qol-save-ovr-line">
            <button class="ace-qol-save-ovr-x" data-action="aceQolRemoveResult" data-token-doc-id="${r.tokenDocId}">\u00d7</button>
            <button class="ace-qol-save-ovr${_a(0.25)}" data-action="aceQolDmgOverride" data-token-doc-id="${r.tokenDocId}" data-multiplier="0.25">\u00bc</button>
            <button class="ace-qol-save-ovr${_a(0.5)}" data-action="aceQolDmgOverride" data-token-doc-id="${r.tokenDocId}" data-multiplier="0.5">\u00bd</button>
            <button class="ace-qol-save-ovr${_a(1)}" data-action="aceQolDmgOverride" data-token-doc-id="${r.tokenDocId}" data-multiplier="1">1</button>
            <button class="ace-qol-save-ovr${_a(2)}" data-action="aceQolDmgOverride" data-token-doc-id="${r.tokenDocId}" data-multiplier="2">2</button>
            <span class="ace-qol-save-ovr-spacer"></span>
            <span class="ace-qol-save-result-dmg">${dmgDisplay}<span class="ace-qol-dmg-unit">DMG</span></span>${isDead ? '<span class="ace-qol-save-skull">\u2620</span>' : '<span class="ace-qol-save-skull" style="display:none">\u2620</span>'}
            <span class="ace-qol-save-result-hp">HP: <span class="ace-qol-hp-cur">${r.currentHP}</span>\u2192<span class="ace-qol-hp-new${isDead ? ' ace-qol-hp-dead' : ''}">${newHP}</span></span>
          </div>
        </div>
      `;
    }).join("");

    // ── Damage rolled summary ──
    const dmgSummary = damageComponents.map(c => {
      const color = DamageConstants.DAMAGE_COLORS[c.type] ?? "#ccc";
      return `<span style="color:${color}">${c.formula} = ${c.total} ${c.type}</span>`;
    }).join(", ");

    const cardHtml = `
      <div class="ace-qol-save-results-card">
        ${this._castAnnouncementHtml(item, casterActor, results, activityId)}
        <div class="ace-qol-save-header">
          <img src="${item.img || "icons/svg/spell.svg"}" class="ace-qol-save-item-img" />
          <div>
            <strong class="ace-qol-save-item-name">${this._abilityLabel(item, activityId)} \u2014 Save Results</strong>
            <span class="ace-qol-save-dc">DC ${saveDC} ${abilityLabel}</span>
          </div>
        </div>
        <div class="ace-qol-save-dmg-summary">Damage: ${dmgSummary}</div>
        <div class="ace-qol-save-results">
          ${targetRows}
        </div>
        <div class="ace-qol-dmg-actions ace-qol-gm-only">
          <button class="ace-qol-btn ace-qol-btn-apply" data-action="aceQolApplyDamage">
            <i class="fas fa-heart-crack"></i> APPLY ALL
          </button>
          <button class="ace-qol-btn ace-qol-btn-undo" data-action="aceQolUndoDamage" disabled>
            <i class="fas fa-undo"></i> UNDO ALL
          </button>
        </div>
      </div>
    `;

    // THE DICE LAND FIRST. Never post a result before the roll that
    // produced it has visibly stopped. (feedback_chat_cards_use_the_room)
    await awaitDiceSettle();

    await ChatMessage.create({
      content: cardHtml,
      speaker: ChatMessage.getSpeaker({ actor: casterActor }),
      // PUBLIC (Johnny 2026-07-11): the table sees the damage + HP change. The
      // APPLY/UNDO + per-target override buttons are GM-only (hidden per-viewer
      // on render); the damage/HP readout stays visible to everyone.
      flags: {
        [MODULE_ID]: {
          type: "saveResults",
          phase: 2,
          itemId: item.id,
          itemUuid: item.uuid,
          activityId,        // survives re-renders and any later re-read
          actorId: casterActor?.id,
          saveAbility,
          saveDC,
          halfOnSave,
          damageResults: results.filter(r => !r.pending).map(r => ({
            targetId: r.actorId,
            tokenDocId: r.tokenDocId,
            sceneId: r.sceneId,
            totalFinal: r.totalDamage,
            currentHP: r.currentHP,
          })),
          // Store base damage for override recalculation
          baseDamageTotal,
          damageComponentTotals: damageComponents.map(c => ({ total: c.total, type: c.type, formula: c.formula })),
        }
      }
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Manual Damage Override (x0, x1/2, x1, x2 per row)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Update a single row's damage + HP display in the DOM. No flag writes.
   * @param {HTMLElement} rowElement  The .ace-qol-save-result-row element
   * @param {string} tokenDocId
   * @param {number} multiplier
   * @param {object} flags  The message's MODULE_ID flags (read-only)
   */
  _updateRowDamageDisplay(rowElement, tokenDocId, multiplier, flags) {
    const results = flags.damageResults ?? [];
    const result = results.find(r => r.tokenDocId === tokenDocId);
    if (!result) return;

    const baseDmg = flags.baseDamageTotal ?? 0;
    const newDamage = Math.floor(baseDmg * multiplier);
    const currentHP = result.currentHP ?? 0;

    const dmgSpan = rowElement.querySelector(".ace-qol-save-result-dmg");
    if (dmgSpan) {
      dmgSpan.textContent = newDamage.toString();
      const skullSpan = rowElement.querySelector(".ace-qol-save-skull");
      if (skullSpan) skullSpan.style.display = (Math.max(0, currentHP - newDamage) <= 0) ? "" : "none";
    }

    const hpSpan = rowElement.querySelector(".ace-qol-save-result-hp");
    if (hpSpan) {
      const newHP = Math.max(0, currentHP - newDamage);
      const deadClass = newHP <= 0 ? " ace-qol-hp-dead" : "";
      hpSpan.innerHTML = `HP: ${currentHP}\u2192<span class="ace-qol-hp-new${deadClass}">${newHP}</span>`;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Apply All Save Damage
  // ═══════════════════════════════════════════════════════════════════════════

  async _applyAllSaveDamage(message) {
    const flags = message.flags?.[MODULE_ID];
    if (!flags?.damageResults?.length) return;

    const baseDmg = flags.baseDamageTotal ?? 0;
    // What the hit points ACTUALLY moved by, per target. UNDO gives back exactly
    // this and nothing else — see _undoAllSaveDamage. (audit F-016, 2026-08-07)
    const hpDelta = { ...(flags.hpDelta ?? {}) };

    for (const r of flags.damageResults) {
      const scene = game.scenes.get(r.sceneId) ?? canvas.scene;
      const tokenDoc = scene?.tokens?.get(r.tokenDocId);
      const actor = tokenDoc?.actor ?? game.actors.get(r.targetId);
      if (!actor) continue;

      // Check override cache for this target
      const cacheKey = `${message.id}|${r.tokenDocId}`;
      const cachedValue = SaveEngine.overrideCache.get(cacheKey);

      // Skip removed targets
      if (cachedValue === "removed") {
        SaveEngine.overrideCache.delete(cacheKey);
        continue;
      }

      const overridden = (typeof cachedValue === "number");
      const damageToApply = overridden
        ? Math.floor(baseDmg * cachedValue)
        : (r.totalFinal ?? 0);

      // Describe the damage BY TYPE so a listener that cares about types can act
      // on it. The parts must sum to what is actually being applied — a mismatch
      // would let applyHPDamage's reduction check rewrite the number. When the
      // GM has overridden the multiplier the stored split no longer matches, so
      // fall back to one entry carrying the whole overridden amount.
      const _parts = (!overridden && Array.isArray(r.byType) && r.byType.length)
        ? r.byType.map(p => ({
            value: Math.max(0, Number(p.value) || 0),
            type: String(p.type ?? "none").toLowerCase(),
            properties: new Set(),
          }))
        : null;

      const _hpBefore = Number(actor?.system?.attributes?.hp?.value ?? 0);

      // Single source of truth — handles polymorph excess capture + clamp
      // Pass the spell's damage type(s) so applyHPDamage's FX chokepoint (which
      // fires ace-qol.hpApplied) can theme the impact — this is what drives the
      // auto-animation encrust on the save-for-half path.
      await DamageApplicator.applyHPDamage(actor, damageToApply, {
        label: "save-apply-all",
        types: flags.damageTypes ?? [],
        ...(_parts ? { damages: _parts } : {}),
      });

      const _hpAfter = Number(actor?.system?.attributes?.hp?.value ?? 0);
      const _moved = Math.max(0, _hpBefore - _hpAfter);
      hpDelta[r.tokenDocId] = (Number(hpDelta[r.tokenDocId]) || 0) + _moved;

      // Clear cache entry after applying
      SaveEngine.overrideCache.delete(cacheKey);
    }

    try { await message.update({ [`flags.${MODULE_ID}.hpDelta`]: hpDelta }, { render: false }); }
    catch (err) { console.warn(`${MODULE_ID} | couldn't record the applied hit-point movement (UNDO will fall back to the card total):`, err); }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Undo All Save Damage
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * UNDO GIVES BACK WHAT IT TOOK. (audit F-016, 2026-08-07)
   *
   * This used to set hit points back to `r.currentHP` — the snapshot taken when
   * the damage card was BUILT. An absolute restore, not a relative one, so
   * anything that touched the creature in between was silently erased:
   *
   *   goblin at 30 → Fireball applies 10 (now 20) → it steps in a trap for 5
   *   (now 15) → UNDO the Fireball → goblin is back at 30. The trap is gone.
   *
   * It also wrote hit points with a raw actor.update(), so the heal never
   * announced itself and Sword of Wounding couldn't refuse it — the same gap
   * cured on the damage side in 0.7.405. This is the identical bug that was
   * fixed on the ATTACK damage card the day before and missed here, which is
   * exactly what lesson_ace_damage_must_announce_itself warns about: fix the
   * chokepoint, not just the consumer that surfaced it.
   *
   * `hpDelta` is the true hit-point movement recorded at apply time — after
   * temp HP absorbed its share and after any listener reduction — so handing
   * that back is exact.
   */
  async _undoAllSaveDamage(message) {
    const flags = message.flags?.[MODULE_ID];
    if (!flags?.damageResults?.length) return;

    const hpDeltas = flags.hpDelta ?? {};
    let undone = 0;

    for (const r of flags.damageResults) {
      const scene = game.scenes.get(r.sceneId) ?? canvas.scene;
      const tokenDoc = scene?.tokens?.get(r.tokenDocId);
      const actor = tokenDoc?.actor ?? game.actors.get(r.targetId);
      if (!actor) continue;

      // Preference order: the true movement → the card's own total (cards built
      // before this fix) → nothing at all. A target whose row was × removed
      // before APPLY was never damaged, so it must NOT be "restored" to a
      // snapshot — that would heal it for damage it took elsewhere.
      let giveBack = Number(hpDeltas[r.tokenDocId]);
      let source = "true hit-point movement";
      if (!Number.isFinite(giveBack)) {
        giveBack = Number(r.totalFinal);
        source = "card total (card predates the hpDelta fix)";
      }
      if (!Number.isFinite(giveBack) || giveBack <= 0) {
        console.log(`${MODULE_ID} | UNDO: nothing was applied to ${actor.name} on this card — leaving its hit points alone.`);
        continue;
      }

      const { currentHP, newHP } = await DamageApplicator.applyHPHeal(actor, giveBack, {
        label: `UNDO save damage (${message.id})`,
        correction: true,   // rewinding the ledger, not healing — nothing may block it
      });
      console.log(`${MODULE_ID} | UNDO on ${actor.name}: gave back ${giveBack} (${source}) — ${currentHP} → ${newHP}`);
      undone++;
    }

    // The card's damage is no longer on the table; clear the tally so a second
    // UNDO (or a re-render) can't hand the same hit points back twice.
    try { await message.update({ [`flags.${MODULE_ID}.hpDelta`]: {} }, { render: false }); }
    catch (_) { /* best effort — the undone flag still gates the button */ }

    console.log(`${MODULE_ID} | UNDO ALL (save): restored ${undone} target(s).`);
  }
}
