// ─── ACE: QOL — Opportunity Attack Prompt ────────────────────────────────────
// PHB 195: "You can make an opportunity attack when a hostile creature that
// you can see moves out of your reach. To make the opportunity attack, you
// use your reaction to make one melee attack against the provoking creature."
//
// Detection:
//   - Hook updateToken (position changes during a token move).
//   - For each token-on-canvas: if it is hostile to the moving token AND
//     was within reach BEFORE the move AND is no longer within reach AFTER,
//     they get an OA prompt.
//   - Skip if mover has Disengaged this turn (CombatActions flag).
//   - Skip if reactor has used reaction this round (ReactionEngine).
//   - Skip if reactor is incapacitated/can't see.
//
// Result:
//   - GM sees a chat-card prompt: "[Reactor] can make an OA against [Mover]?"
//   - Click "Take OA" → marks reaction used, fires the configured ace-qol
//     opportunityAttack hook (other systems / macros consume it).
//   - Click "Pass" → no action.
//
// SETTINGS
//   - opportunityAttackPrompt (Boolean, default true)
//   - opportunityAttackReach  (Number, default 5 — feet, override for reach
//     weapons but most actors use 5)
// ──────────────────────────────────────────────────────────────────────────────

import { MODULE_ID } from "./ace-qol.mjs";
import { QolSettings } from "./settings.mjs";
import { CombatState } from "./combat-state.mjs";
import { OA_IN_FLIGHT } from "./oa-transient.mjs";
import { aceEdgeGapFt } from "./geometry-utils.mjs";

// Hardcoded literal — TDZ-safe (see stealth-engine.mjs comment)
const FLAG_NS = "ace-qol";

// ── Polearm Master enter-reach qualifying weapons (edition-aware) ──
// 2014 RAW (Tasha's expanded): Glaive, Halberd, Pike, Quarterstaff, Spear.
// 2024 RAW (Reactive Strike): Glaive, Halberd, Pike, Quarterstaff (Spear dropped).
const POLEARM_NAMES_2014 = ["glaive", "halberd", "pike", "quarterstaff", "spear"];
const POLEARM_NAMES_2024 = ["glaive", "halberd", "pike", "quarterstaff"];

export class OAPrompt {

  static init() {
    Hooks.on("updateToken", async (tokenDoc, changes, opts /*, userId */) => {
      try {
        if (!game.user.isGM) return;
        if (!QolSettings.get?.("opportunityAttackPrompt")) return;
        const movedX = changes.x !== undefined;
        const movedY = changes.y !== undefined;
        if (!movedX && !movedY) return;
        // ── Skip OA detection on FORCED movement ──────────────────────────
        // RAW: opportunity attacks trigger only when a creature USES its own
        // movement to leave reach. Forced movement (Push mastery, Telekinesis,
        // shove, repelling spells, etc.) is NOT voluntary, so it does NOT
        // provoke. Callers signal forced movement by passing { aceForcedMovement: true }
        // to token.update(). This guard sees the flag and skips the OA check.
        if (opts?.aceForcedMovement === true) return;
        await OAPrompt._checkProvocations(tokenDoc, changes);
      } catch (err) {
        console.warn(`${MODULE_ID} | OA detection threw:`, err);
      }
    });

    console.debug(`${MODULE_ID} | OAPrompt online`);
  }

  static async _checkProvocations(moverDoc, changes) {
    const moverActor = moverDoc?.actor;
    if (!moverActor) return;

    // ── Mover-state guards: skip OA detection entirely ──
    // Dead / unconscious / petrified / 0-HP creatures don't provoke OAs
    // when the GM drags their corpse around the map. RAW: an OA triggers
    // when a hostile creature MOVES out of reach — corpses aren't moving
    // willingly. Same for incapacitated / paralyzed / stunned (can't take
    // actions, but the body still being shoved doesn't provoke an OA in
    // any reasonable interpretation).
    const skipStatuses = ["dead", "unconscious", "petrified", "incapacitated",
                          "paralyzed", "stunned"];
    const moverStatuses = moverActor.statuses ?? new Set();
    for (const s of skipStatuses) {
      if (moverStatuses.has?.(s)) return;
    }
    // 0-HP guard: dnd5e doesn't always set "dead" status when HP = 0
    // (especially for NPCs whose death-pipeline removed the token but
    // left a synthetic actor). Belt-and-suspenders: skip on 0 HP.
    const hp = Number(moverActor.system?.attributes?.hp?.value ?? 0);
    if (hp <= 0) return;

    // Disengage skips OAs entirely
    const hasDisengage = (moverActor.effects?.contents ?? []).some(e =>
      e?.flags?.[FLAG_NS]?.disengage === true && !e.disabled
    );
    if (hasDisengage) return;

    // Compute pre/post positions
    const fromX = (moverDoc.x ?? 0);
    const fromY = (moverDoc.y ?? 0);
    const toX   = (changes.x ?? fromX);
    const toY   = (changes.y ?? fromY);

    const gridSize  = canvas.scene?.grid?.size ?? 100;
    const ftPerGrid = canvas.scene?.grid?.distance ?? 5;
    // Mover footprint (px) + cube height + before/after elevation (for 3D reach).
    const moverW = (moverDoc.width  ?? 1) * gridSize;
    const moverH = (moverDoc.height ?? 1) * gridSize;
    const moverHgtFt    = Math.max(moverDoc.width ?? 1, moverDoc.height ?? 1) * ftPerGrid;
    const moverElevFrom = Number(moverDoc.elevation ?? 0) || 0;
    const moverElevTo   = Number(changes.elevation ?? moverElevFrom) || 0;

    const moverDisp = moverDoc.disposition ?? 0;
    const placeables = canvas.tokens?.placeables ?? [];
    const reachFt = Number(QolSettings.get?.("opportunityAttackReach") ?? 5);
    // Reach is measured EDGE-TO-EDGE (size-aware) — the way D&D actually works,
    // and the way our range check already does. NOT center-to-center, which
    // mis-reads reach for any non-Medium token: Tiny/Small tokens read as "out
    // of reach" even when adjacent (the bug), and diagonals + Large tokens broke
    // too. A creature is "in reach" when the footprint gap is under its reach;
    // the 0.5-ft margin makes the exact one-square boundary read as "out" so a
    // step away cleanly triggers the leave-reach check. v0.7.26.
    const reachThresholdFt = reachFt - 0.5;

    for (const t of placeables) {
      if (!t.actor) continue;
      if (t.id === moverDoc.id) continue;
      const td = t.document;
      // Hostile to mover (opposite disposition, NOT neutral 0)
      if (td.disposition === moverDisp) continue;
      if (td.disposition === 0) continue;

      // Reactor can't make OAs if dead, incapacitated, blinded, etc.
      // "dead" + 0-HP guards added v0.7.22 — mirror of the mover-side guard
      // above. Without them, killing a ghost and walking away from its
      // corpse offered the DEAD ghost an opportunity attack. dnd5e doesn't
      // always stamp the "dead" status when HP hits 0 (especially NPCs),
      // so the HP check is the belt-and-suspenders.
      if (t.actor.statuses?.has?.("dead") || t.actor.statuses?.has?.("incapacitated")
       || t.actor.statuses?.has?.("unconscious") || t.actor.statuses?.has?.("paralyzed")
       || t.actor.statuses?.has?.("petrified") || t.actor.statuses?.has?.("stunned")
       || t.actor.statuses?.has?.("blinded")) continue;
      const reactorHP = Number(t.actor.system?.attributes?.hp?.value ?? 0);
      if (reactorHP <= 0) continue;

      // Reactor's reach already used? (reaction-engine flag)
      if (t.actor.getFlag?.(FLAG_NS, "reactionUsed") === true) continue;

      // Charmed by the mover? RAW: a charmed creature can't attack its
      // charmer. Best-effort — only suppresses when the charm effect's
      // origin positively ties to the mover; an unsourced charm doesn't
      // suppress (the GM can still decline). v0.7.22.
      if (OAPrompt._isCharmedByMover(t.actor, moverActor)) continue;

      // Nothing to swing = no opportunity attack. With the unarmed-strike
      // fallback (Tier 3) almost every creature qualifies; this only skips a
      // creature that has no weapon, no natural attack, AND no unarmed-strike
      // item at all (e.g. a bare token with no attack items). v0.7.23.
      if (OAPrompt._getOAWeapons(t.actor).tier === "none") continue;

      const reactorW = (td.width  ?? 1) * gridSize;
      const reactorH = (td.height ?? 1) * gridSize;
      const reactorRect = {
        x: td.x, y: td.y, w: reactorW, h: reactorH,
        elev:  Number(td.elevation ?? 0) || 0,
        hgtFt: Math.max(td.width ?? 1, td.height ?? 1) * ftPerGrid,
      };
      // Edge-to-edge gap (ft) from the mover's BEFORE and AFTER positions to the
      // reactor's footprint — nearest-edge, size-aware, and 3D (a flyer passing
      // overhead is out of reach). Shared canonical math (geometry-utils), so a
      // Tiny/Small reactor adjacent to the mover reads gap≈0 (in reach) instead
      // of being lost the way center-to-center did.
      const gapBeforeFt = aceEdgeGapFt(
        { x: fromX, y: fromY, w: moverW, h: moverH, elev: moverElevFrom, hgtFt: moverHgtFt },
        reactorRect);
      const gapAfterFt = aceEdgeGapFt(
        { x: toX, y: toY, w: moverW, h: moverH, elev: moverElevTo, hgtFt: moverHgtFt },
        reactorRect);

      // Was within reach AND now isn't = standard leave-reach OA (PHB 195).
      if (gapBeforeFt <= reachThresholdFt && gapAfterFt > reachThresholdFt) {
        await OAPrompt._postPromptCard(t.actor, moverActor, td, moverDoc);
      }

      // ── Polearm Master enter-reach OA (2014 + 2024) ──
      // 2014 Polearm Master (Tasha's expanded list): an enemy entering your
      // reach while you wield a qualifying polearm provokes an OA.
      // 2024 Polearm Master "Reactive Strike": same trigger, narrower weapon
      // list (no Spear). Reach pulled from the weapon (10 ft for reach-property
      // weapons, 5 ft otherwise). Mover must have been OUTSIDE the polearm's
      // reach before and INSIDE it after.
      const polearmData = OAPrompt._getPolearmReachData(t.actor);
      if (polearmData) {
        const polearmThresholdFt = polearmData.reachFt - 0.5;
        if (gapBeforeFt > polearmThresholdFt && gapAfterFt <= polearmThresholdFt) {
          // Use the TOKEN name (which has disambiguators like "Assassin 1",
          // "Assassin 2") rather than the actor name (which would just say
          // "Assassin" for every duplicate). Falls back to actor name if
          // the token doc somehow lacks a name.
          const moverDisplayName = moverDoc?.name ?? moverActor.name;
          const reasonText = `can make an OA against <strong>${moverDisplayName}</strong> entering polearm reach (${polearmData.weaponName}, ${polearmData.reachFt} ft, ${polearmData.edition} RAW).`;
          await OAPrompt._postPromptCard(t.actor, moverActor, td, moverDoc, { reasonText });
        }
      }
    }
  }

  /**
   * If the reactor has Polearm Master AND a qualifying polearm equipped,
   * return the polearm's reach in feet plus the weapon name and the active
   * edition. Returns null otherwise.
   *
   * Edition-aware qualifying weapon list:
   *   2014 (Tasha's expanded): Glaive, Halberd, Pike, Quarterstaff, Spear.
   *   2024 (Reactive Strike):  Glaive, Halberd, Pike, Quarterstaff.
   *
   * Reach: weapons carrying the "rch" property = 10 ft total reach;
   * otherwise 5 ft. Pulled per-weapon rather than from a single setting so
   * Glaive/Halberd/Pike fire at 10 ft and Quarterstaff/Spear fire at 5 ft.
   *
   * @param {Actor} reactorActor
   * @returns {{ reachFt: number, weaponName: string, edition: string } | null}
   */
  static _getPolearmReachData(reactorActor) {
    if (!reactorActor) return null;
    const hasPM = (reactorActor.items ?? []).some(i =>
      (i.type === "feat" || i.type === "class") &&
      i.name?.toLowerCase().includes("polearm master")
    );
    if (!hasPM) return null;

    const edition = CombatState.getActiveEdition(reactorActor);
    const validNames = edition === "2024" ? POLEARM_NAMES_2024 : POLEARM_NAMES_2014;

    for (const it of reactorActor.items ?? []) {
      if (it.type !== "weapon") continue;
      if (!it.system?.equipped) continue;
      const nameNorm = String(it.name ?? "").toLowerCase().trim();
      if (!validNames.some(p => nameNorm.includes(p))) continue;
      const props = it.system?.properties;
      const hasReachProp = props?.has?.("rch") || props?.rch === true;
      const reachFt = hasReachProp ? 10 : 5;
      return { reachFt, weaponName: it.name, edition };
    }
    return null;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Eligibility helpers + attack execution (v0.7.22 / v0.7.23)
  // ═══════════════════════════════════════════════════════════════════════════

  /** Does an item carry a non-ranged (melee or unspecified) attack activity? */
  static _isMeleeCapable(it) {
    const acts = it?.system?.activities;
    if (!acts) return false;
    const iter = (typeof acts.values === "function") ? acts.values() : Object.values(acts);
    for (const a of iter) {
      if (a?.type !== "attack") continue;
      const at = String(a?.attack?.type?.value ?? a?.actionType ?? "").toLowerCase();
      const isRanged = at === "ranged" || at === "rwak" || at === "rsak";
      if (!isRanged) return true; // melee or unspecified → counts
    }
    return false;
  }

  /** Is this weapon a natural weapon (claws / bite / slam / a ghost's touch)? */
  static _isNaturalWeapon(it) {
    return String(it?.system?.type?.value ?? "").toLowerCase() === "natural";
  }

  /** Is this item an unarmed strike? */
  static _isUnarmedStrike(it) {
    const id = String(it?.system?.identifier ?? it?.system?.type?.baseItem ?? "").toLowerCase();
    return id === "unarmedstrike" || id === "unarmed" || /^unarmed strike$/i.test(String(it?.name ?? ""));
  }

  /**
   * Resolve which weapon(s) a creature can realistically make an opportunity
   * attack with, in strict RAW priority. A token can only swing what's in its
   * hands or part of its body — never gear stowed in a bag of holding / portable
   * hole, never a sheathed (unequipped) backup.
   *
   *   Tier 1 "equipped"  — manufactured weapons marked equipped (in hand), not
   *                        natural, not unarmed, not inside a container.
   *   Tier 2 "natural"   — natural weapons (always available, part of the body).
   *   Tier 3 "unarmed"   — the unarmed-strike fallback; everyone can punch.
   *
   * Higher tiers win: a creature holding a sword swings the sword, not its fists.
   * Returns { tier, items } — one item → auto-swing; many → the picker.
   * @param {Actor} actor
   * @returns {{ tier: "equipped"|"natural"|"unarmed"|"none", items: Item5e[] }}
   */
  static _getOAWeapons(actor) {
    if (!actor) return { tier: "none", items: [] };
    const isPC = actor.type === "character";
    const weapons = (actor.items ?? []).filter(it => it.type === "weapon");
    const inContainer = (it) => !!it.system?.container;

    // Tier 1 — manufactured weapons in hand.
    //   PC : strictly EQUIPPED (this is the bag-of-holding fix — a character
    //        can only swing what's actually in hand).
    //   NPC: any non-container manufactured melee weapon. Monster stat blocks
    //        don't reliably set the equipped flag and don't stow gear in bags,
    //        so their listed weapons ARE their available attacks.
    const tier1 = weapons.filter(it => {
      if (inContainer(it)) return false;
      if (OAPrompt._isNaturalWeapon(it) || OAPrompt._isUnarmedStrike(it)) return false;
      if (!OAPrompt._isMeleeCapable(it)) return false;
      return isPC ? (it.system?.equipped === true) : true;
    });
    if (tier1.length) return { tier: isPC ? "equipped" : "weapon", items: tier1 };

    // Tier 2 — natural weapons (the creature's body).
    const natural = weapons.filter(it =>
      !inContainer(it) &&
      OAPrompt._isNaturalWeapon(it) &&
      OAPrompt._isMeleeCapable(it)
    );
    if (natural.length) return { tier: "natural", items: natural };

    // Tier 3 — unarmed strike (last resort, everyone can punch).
    const unarmed = weapons.filter(it => OAPrompt._isUnarmedStrike(it));
    if (unarmed.length) return { tier: "unarmed", items: [unarmed[0]] };

    return { tier: "none", items: [] };
  }

  /**
   * Best-effort "is the reactor charmed BY the mover?" check. Only returns
   * true when a charm-flavored effect's origin positively resolves to the
   * mover actor — an unsourced charm does not suppress the prompt.
   * @param {Actor} reactorActor
   * @param {Actor} moverActor
   * @returns {boolean}
   */
  static _isCharmedByMover(reactorActor, moverActor) {
    if (!reactorActor?.statuses?.has?.("charmed")) return false;
    if (!moverActor) return false;
    const moverUuid = moverActor.uuid;
    for (const eff of reactorActor.effects ?? []) {
      if (eff.disabled) continue;
      const statuses = eff.statuses ?? new Set();
      const isCharm = statuses.has?.("charmed") || /charm/i.test(String(eff.name ?? ""));
      if (!isCharm) continue;
      const origin = String(eff.origin ?? "");
      if (origin && (origin === moverUuid || (moverActor.id && origin.includes(moverActor.id)))) return true;
    }
    return false;
  }

  /**
   * Resolve the mover's canvas token from the stored card flags — prefer the
   * exact token id, fall back to the first token of the mover actor.
   * @param {object} flags - the oaPrompt flags block
   * @returns {Token|null}
   */
  static _resolveMoverToken(flags) {
    const byId = flags?.moverTokenId ? (canvas.tokens?.get(flags.moverTokenId) ?? null) : null;
    if (byId) return byId;
    if (flags?.moverId) {
      return canvas.tokens?.placeables.find(t => t.actor?.id === flags.moverId) ?? null;
    }
    return null;
  }

  /**
   * When the reactor has more than one melee attack option, ask which to
   * swing. Dark-wrapped per the ACE contrast rules (Foundry's default dialog
   * body is light parchment). Returns the chosen Item5e, or null if cancelled.
   * @param {Item5e[]} items
   * @param {Actor} reactorActor
   * @returns {Promise<Item5e|null>}
   */
  static async _pickWeapon(items, reactorActor) {
    const DialogV2 = foundry.applications?.api?.DialogV2;
    if (!DialogV2) return items[0] ?? null;  // very old core — just auto-pick
    const content = `
      <div style="background:linear-gradient(180deg,#1a1416 0%,#241a1d 100%);border:2px solid #d4af37;border-radius:6px;padding:12px 14px;color:#f0e4c0;">
        <div style="font-size:16px;color:#ffd87a;font-weight:600;margin-bottom:6px;">
          <i class="fas fa-bolt"></i> Opportunity Attack — Choose Weapon
        </div>
        <div style="font-size:14px;color:#cfcfd0;line-height:1.4;">
          <strong>${reactorActor?.name ?? "Reactor"}</strong> has more than one melee attack. Pick the one to swing.
        </div>
      </div>`;
    const buttons = items.map(it => ({ action: it.id, label: it.name }));
    buttons.push({ action: "__cancel", label: "Cancel" });
    let result = null;
    try {
      result = await DialogV2.wait({
        window: { title: "Opportunity Attack" },
        content,
        buttons,
        rejectClose: false,
      });
    } catch (_) { result = null; }
    if (!result || result === "__cancel") return null;
    return items.find(it => it.id === result) ?? null;
  }

  /**
   * Fire a REAL opportunity attack on THIS client (the clicker). Sets the
   * clicker's target to the mover token, fires the reactor's melee attack via
   * the dnd5e use flow (fast-forward, same pattern as SpeedRolls), then
   * restores the clicker's prior targets. The attack flows through the normal
   * AttackPipeline hooks — hit/miss card, damage card, Divine Smite popup
   * (routed to the clicker), and the mover's Shield / Mirror Image reactions
   * all fire automatically. Returns false if cancelled or no weapon resolved.
   * @param {Actor} reactorActor
   * @param {Token} moverToken
   * @returns {Promise<boolean>}
   */
  static async fireOAAttack(reactorActor, moverToken) {
    if (!reactorActor) return false;
    const { tier, items } = OAPrompt._getOAWeapons(reactorActor);
    if (!items.length) {
      ui.notifications?.warn(`ACE QOL: ${reactorActor.name} has no weapon, natural attack, or unarmed strike for the opportunity attack.`);
      return false;
    }
    if (!moverToken) {
      ui.notifications?.warn("ACE QOL: Could not resolve the moving token for the opportunity attack.");
      return false;
    }

    // Resolve which weapon to swing. One option (a single equipped weapon, a
    // lone natural attack, or unarmed) → auto-swing, no dialog. Only a genuine
    // ambiguity (dual-wielding, or a multi-natural monster) shows the picker.
    let item = items[0];
    if (items.length > 1) {
      const picked = await OAPrompt._pickWeapon(items, reactorActor);
      if (!picked) return false;  // cancelled — leave the card pending
      item = picked;
    }
    console.log(`${MODULE_ID} | OA: ${reactorActor.name} swings ${item.name} (tier=${tier})`);

    // Target ONLY the mover and fire. We deliberately do NOT save-and-restore
    // the GM's previous targets: the post-roll resolution (_onAttackRoll) reads
    // game.user.targets AFTER item.use() resolves, so restoring in a finally
    // raced ahead and wiped the target → "No targets selected — skipping attack
    // resolution" (the OA rolled but never produced a hit/damage card). Leaving
    // the mover targeted is the correct, race-free end state — it's the creature
    // you just swung at. (v0.7.24 fix.)
    // V13: the old game.user.updateTokenTargets() helper is gone — per-token
    // setTarget is the path. releaseOthers:true clears any prior targets so the
    // OA hits ONLY the mover (a stray second target would trip the melee
    // multi-target lockout and block the swing).
    OA_IN_FLIGHT.add(reactorActor.id);
    try {
      moverToken.setTarget(true, { user: game.user, releaseOthers: true, groupSelection: false });

      // Fast-forward use — shiftKey skips the activity-choice dialog; our
      // pipeline handles hit/miss/damage against the mover.
      await item.use({ event: { shiftKey: true, target: document.body } }, {}, {});
    } catch (err) {
      console.error(`${MODULE_ID} | OA attack fire failed:`, err);
      ui.notifications?.error("ACE QOL: Opportunity attack roll failed — see console.");
      return false;
    } finally {
      OA_IN_FLIGHT.delete(reactorActor.id);
    }
    return true;
  }

  static async _postPromptCard(reactorActor, moverActor, reactorTokenDoc, moverTokenDoc, opts = {}) {
    const reactorId = reactorActor.id;
    const moverId   = moverActor.id;
    // Token ids — needed so "Take OA" can target the EXACT mover token (not
    // just the first token of the mover actor, which matters for duplicate
    // NPCs like "Goblin 1 / Goblin 2"). v0.7.22.
    const reactorTokenId = reactorTokenDoc?.id ?? null;
    const moverTokenId   = moverTokenDoc?.id ?? null;
    // Prefer the TOKEN name (auto-disambiguated like "Assassin 1") over the
    // actor name (which collapses duplicates into a single ambiguous name).
    // Stored in flags so resolveOAPrompt can re-render with the right name
    // later without re-resolving tokens.
    const reactorName = reactorTokenDoc?.name ?? reactorActor.name;
    const moverName   = moverTokenDoc?.name   ?? moverActor.name;
    const reasonText = opts.reasonText ?? null;
    const html = OAPrompt._renderCardHtml(reactorName, moverName, reactorId, moverId, "pending", reasonText);

    // Whisper recipients: GM(s) + the reactor's player owner (if any).
    // For GM-controlled NPCs, only the GM sees the prompt. PCs reactors
    // include their owner so the player can decide. This prevents the
    // table's other players from seeing irrelevant OA prompts.
    const recipients = new Set();
    for (const u of game.users) if (u.isGM) recipients.add(u.id);
    if (reactorActor.hasPlayerOwner) {
      for (const [uid, level] of Object.entries(reactorActor.ownership ?? {})) {
        if (uid === "default") continue;
        if (level >= 3) recipients.add(uid); // 3 = OWNER
      }
    }
    await ChatMessage.create({
      content: html,
      speaker: ChatMessage.getSpeaker({ actor: reactorActor }),
      whisper: [...recipients],
      flags: { [MODULE_ID]: { type: "oaPrompt", reactorId, moverId, reactorTokenId, moverTokenId, reactorName, moverName, status: "pending", reasonText } },
    });
  }

  /**
   * Single source of truth for OA card HTML.
   * status: "pending" | "taken" | "passed"
   * reasonText (optional): custom body line. Falls back to the standard
   * leave-reach phrasing when null. Used by the Polearm Master enter-reach
   * branch to clarify the trigger condition.
   */
  static _renderCardHtml(reactorName, moverName, reactorId, moverId, status, reasonText = null) {
    const isPending = status === "pending";
    const verdictHtml = status === "taken"
      ? `<div style="color:#d4af37;font-weight:600;font-size:12px;margin-top:8px;"><i class="fas fa-bolt"></i> Reaction used</div>`
      : status === "passed"
      ? `<div style="color:#888;font-weight:600;font-size:12px;margin-top:8px;font-style:italic;">Passed — no action</div>`
      : "";
    const buttonsHtml = isPending ? `
      <div style="display:flex;gap:6px;margin-top:8px;">
        <button type="button" class="ace-qol-btn"
                data-action="aceQolTakeOA"
                data-reactor-id="${reactorId}"
                data-mover-id="${moverId}"
                style="background:#3a2010;color:#ffd87a;border:1px solid #d4af37;padding:4px 10px;border-radius:3px;cursor:pointer;font-size:12px;font-weight:600;">
          <i class="fas fa-bolt"></i> Take OA
        </button>
        <button type="button" class="ace-qol-btn"
                data-action="aceQolPassOA"
                data-reactor-id="${reactorId}"
                data-mover-id="${moverId}"
                style="background:#1a1a1f;color:#aaa;border:1px solid #555;padding:4px 10px;border-radius:3px;cursor:pointer;font-size:12px;">
          Pass
        </button>
      </div>` : "";
    return `
      <div class="ace-qol-oa-card" style="background:linear-gradient(180deg,#1a1416 0%,#241a1d 100%);border:2px solid #d4af37;border-radius:6px;padding:10px 12px;">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:6px;">
          <i class="fas fa-bolt" style="color:#d4af37;font-size:18px;"></i>
          <strong style="color:#ffd87a;font-size:13px;text-transform:uppercase;letter-spacing:0.5px;">Opportunity Attack</strong>
        </div>
        <div style="color:#cfcfd0;font-size:12px;line-height:1.4;">
          <strong>${reactorName}</strong> ${reasonText ?? `can make an OA against <strong>${moverName}</strong>.`}
        </div>
        ${verdictHtml}
        ${buttonsHtml}
      </div>
    `;
  }

  /**
   * Resolve an OA prompt — updates the chat MESSAGE itself (so all clients
   * re-render with the resolved state) AND fires the appropriate side
   * effects (mark reaction used, fire cross-module hook).
   * @param {string} messageId
   * @param {"taken"|"passed"} status
   */
  static async resolveOAPrompt(messageId, status) {
    const msg = game.messages?.get?.(messageId);
    if (!msg) return;
    const flags = msg.flags?.[MODULE_ID];
    if (flags?.type !== "oaPrompt") return;
    if (flags?.status && flags.status !== "pending") return; // already resolved

    const reactorId = flags.reactorId;
    const moverId   = flags.moverId;
    const reactor   = game.actors.get(reactorId);
    const mover     = game.actors.get(moverId);
    // Prefer the token names that were captured when the card was posted
    // (they include disambiguators like "Assassin 1"). Fall back to actor
    // name, then to a generic placeholder so old cards still render.
    const reactorName = flags.reactorName ?? reactor?.name ?? "Reactor";
    const moverName   = flags.moverName   ?? mover?.name   ?? "Target";

    if (status === "taken" && reactor) {
      // Mark reaction used + fire cross-module hook (reaction-engine, etc.)
      try {
        await reactor.setFlag?.(MODULE_ID, "reactionUsed", true);
        Hooks.callAll(`${MODULE_ID}.opportunityAttack`, reactor.id);
      } catch (_) { /* non-fatal */ }
    }

    // Re-render the card content with the resolved state. ALL clients with
    // visibility see this update via the standard chat-message render flow.
    // Preserve the original reasonText (set by the polearm enter-reach branch)
    // so the resolved card keeps its trigger explanation.
    const reasonText = flags.reasonText ?? null;
    const newHtml = OAPrompt._renderCardHtml(reactorName, moverName, reactorId, moverId, status, reasonText);
    try {
      await msg.update({
        content: newHtml,
        [`flags.${MODULE_ID}.status`]: status,
        [`flags.${MODULE_ID}.resolvedAt`]: Date.now(),
      });
    } catch (err) {
      console.warn(`${MODULE_ID} | OA prompt resolve update failed:`, err);
    }
  }
}

// ── Bind click handlers via renderChatMessage / renderChatMessageHTML ────────
// "Take OA" now fires a REAL attack through the pipeline (v0.7.22). The
// clicker's machine rolls the reactor's melee attack against the mover; the
// attack pipeline handles hit/miss, damage, the Divine Smite popup (routed to
// the clicker), and the mover's Shield / Mirror Image. Message + reaction-flag
// writes happen GM-side, so a player clicking their OWN character's OA fires
// the attack locally and sockets the message-resolution to the GM.
//
// Permission gate: the GM always; the reactor's owner may resolve their own.
const _bindOAButtons = (message, html) => {
  try {
    const root = html instanceof HTMLElement ? html : (html?.[0] ?? html);
    if (!root || typeof root.querySelectorAll !== "function") return;
    const handleClick = async (ev, status) => {
      ev.preventDefault();
      const btn = ev.currentTarget;
      const chatEl = btn.closest?.(".chat-message");
      const msgId = message?.id ?? chatEl?.dataset?.messageId;
      if (!msgId) {
        console.warn(`${MODULE_ID} | OA resolve: could not find messageId`);
        return;
      }

      const msg = game.messages?.get?.(msgId);
      const flags = msg?.flags?.[MODULE_ID];
      if (!flags || flags.type !== "oaPrompt") return;
      if (flags.status && flags.status !== "pending") return; // already resolved

      const reactor = game.actors.get(flags.reactorId);

      // Permission: GM always; otherwise the reactor's owner may take/pass
      // their OWN opportunity attack.
      const isOwner = reactor?.testUserPermission?.(game.user, "OWNER") ?? false;
      if (!game.user.isGM && !isOwner) {
        ui.notifications?.warn("Only the GM or the reacting character's owner can resolve this opportunity attack.");
        return;
      }

      btn.disabled = true; // immediate local feedback

      try {
        const { OAPrompt } = await import("/modules/ace-qol/scripts/oa-prompt.mjs");

        if (status === "taken") {
          // Fire the real attack on THIS client (the clicker). If the weapon
          // picker is cancelled or no weapon resolves, leave the card pending.
          const moverToken = OAPrompt._resolveMoverToken(flags);
          const fired = await OAPrompt.fireOAAttack(reactor, moverToken);
          if (!fired) { btn.disabled = false; return; }
        }

        // Resolve the message (flip card + mark reaction used). Message and
        // flag writes are GM-side — if a player clicked their own OA, socket
        // the resolution to the GM.
        if (game.user.isGM) {
          await OAPrompt.resolveOAPrompt(msgId, status);
        } else {
          game.socket.emit(`module.${MODULE_ID}`, { action: "oaResolve", messageId: msgId, status });
        }
      } catch (err) {
        console.warn(`${MODULE_ID} | OA resolve threw:`, err);
        btn.disabled = false;
      }
    };
    for (const btn of root.querySelectorAll("[data-action='aceQolTakeOA']")) {
      if (btn.dataset.aceQolBound === "1") continue;
      btn.dataset.aceQolBound = "1";
      btn.addEventListener("click", (ev) => handleClick(ev, "taken"));
    }
    for (const btn of root.querySelectorAll("[data-action='aceQolPassOA']")) {
      if (btn.dataset.aceQolBound === "1") continue;
      btn.dataset.aceQolBound = "1";
      btn.addEventListener("click", (ev) => handleClick(ev, "passed"));
    }
  } catch (err) { /* non-fatal */ }
};

Hooks.on("renderChatMessage",     _bindOAButtons); // V12
Hooks.on("renderChatMessageHTML", _bindOAButtons); // V13
