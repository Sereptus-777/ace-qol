// ─── ACE QOL — The Action Bar ─────────────────────────────────────────────────
//
// A second hotbar row that fills itself from whoever you have selected, sitting
// directly above Foundry's own macro bar.
//
// ═══ WHY THIS EXISTS, AND WHY IT IS NOT A BG3 HUD CLONE ══════════════════════
//
// Johnny ran BG3 Inspired Hotbar for months and dropped it on 2026-08-14 — his
// players had already abandoned it ("it doesn't show up half the time, it's very
// finicky") and were working from character sheets instead. ACE was carrying two
// separate workarounds for its bugs by then. But three of its ideas were good
// and are rebuilt here:
//
//   • A PORTRAIT, so you can tell at a glance who is selected.
//   • The selected creature's ACTIONS, without opening a sheet.
//   • An END TURN button that appears only when it is that creature's turn.
//
// ⚠️ WE DO NOT TOUCH FOUNDRY'S HOTBAR. It keeps its macros, its pages, its lock
// and its trash, and every slot in it stays exactly where Johnny put it. This
// bar renders ABOVE it. That is the whole reason the split exists: an
// auto-filling bar and a hand-arranged bar cannot be the same bar, or selecting
// a goblin wipes the row you spent an evening building. Row one follows the
// selection, row two is yours forever.
//
// ⚠️ EQUIPPED MEANS EQUIPPED. Johnny, 2026-08-14: "when they swap weapons, I want
// them to equip and unequip right on their sheet." So an item that CAN be
// equipped only appears here while it IS equipped — the sheet stays the single
// place you change a loadout, and this bar reflects it rather than competing
// with it. Anything with no equipped flag at all (monster attacks, features,
// spells) is always eligible.
//
// ⚠️ PASSIVES ARE NOT ACTIONS. Only items with at least one activity appear.
// Darkvision, Brave, Pack Tactics and the rest are facts about a creature, not
// buttons — they belong in the effects panel, and putting them here would push
// the actual attacks off the end of the row.
//
// ⚠️ MULTIATTACK IS A LABEL, NOT A SLOT. It is not something you activate; it
// tells you how to read everything to its right. It shows as a badge on the
// portrait, per Johnny's explicit instruction — "I would like it noted, but not
// in that macro".
// ──────────────────────────────────────────────────────────────────────────────

import { MODULE_ID } from "./ace-qol.mjs";

const LOG = "ace-qol | ActionBar";

/** Slots on the auto-filled row. Ten, to sit flush with Foundry's own bar. */
const SLOT_COUNT = 10;

export class ActionBar {

  static _el = null;
  static _actorId = null;
  static _renderTimer = null;

  /* ── Reading the creature ─────────────────────────────────────────────── */

  /**
   * Everything this creature can actually DO, in the order Johnny asked for:
   * attacks first on the far left, then actionable features, then spells.
   *
   * ⚠️ ASK THE ACTIVITY, NOT THE ITEM. An item is a container; what it can do
   * lives in its activities. A "weapon" with no attack activity is a club
   * sitting in a backpack, and a feat with a save activity is very much an
   * action. This is the same activity-not-item rule the attack pipeline learned
   * the hard way — reading `item.type` alone gets Breath Weapon wrong.
   */
  static _actionsFor(actor) {
    const attacks = [], features = [], spells = [];
    for (const item of (actor?.items ?? [])) {
      try {
        const activities = item.system?.activities;
        const count = activities?.size ?? activities?.length ?? 0;
        if (!count) continue;                       // passive — not a button

        // Equippable and not equipped → it is stowed. See the header.
        if (item.system?.equipped === false) continue;

        // Prepared-spell respect: an unprepared spell is not castable at will.
        //
        // ⚠️ `system.preparation` IS DEPRECATED — dnd5e 5.1 split it into
        // `system.method` and `system.prepared`, and it disappears in 6.0.
        // Reading the old shape did not just risk a future break: every access
        // logged a compatibility warning, and this runs for EVERY spell on
        // EVERY re-render. On a caster carrying a full spell list that is
        // hundreds of stack-trace writes per redraw, which is exactly the
        // "super glitchy, everything's all fucked up when I move the map"
        // Johnny reported (2026-08-14). A deprecation notice is cheap once and
        // ruinous in a render loop.
        if (item.type === "spell") {
          const sys = item.system ?? {};
          const method = sys.method ?? sys.preparation?.mode;         // 5.1+ first
          const prepared = sys.prepared ?? sys.preparation?.prepared;
          const alwaysReady = ["always", "atwill", "innate", "pact", "ritual"].includes(method);
          if (!alwaysReady && prepared === false) continue;
          spells.push(item);
          continue;
        }

        const hasAttack = !!activities?.getByType?.("attack")?.length;
        if (hasAttack) attacks.push(item);
        else features.push(item);
      } catch (err) {
        console.warn(`${LOG} | could not classify "${item?.name}":`, err);
      }
    }
    return [...attacks, ...features, ...spells];
  }

  /**
   * Does this creature have Multiattack? Returned as a label, never a slot.
   * ⚠️ Name-matched deliberately: Multiattack is a named monster feature in both
   * editions and carries no machine-readable marker of its own.
   */
  static _multiattack(actor) {
    try {
      return (actor?.items ?? []).find(i => /^multiattack$/i.test(String(i.name ?? ""))) ?? null;
    } catch (_) { return null; }
  }

  /** Conditions and auras currently on the creature, for the strip along the top. */
  static _badgesFor(actor) {
    const out = [];
    try {
      for (const e of (actor?.effects ?? [])) {
        if (e.disabled) continue;
        out.push({ name: e.name, img: e.img ?? e.icon, id: e.id });
      }
    } catch (err) {
      console.warn(`${LOG} | could not read effects for the strip:`, err);
    }
    return out;
  }

  /* ── The creature on show ─────────────────────────────────────────────── */

  /**
   * Whose bar is this? The selected token, and nothing else.
   *
   * ⚠️ DELIBERATELY NOT "the current combatant". Foundry already selects a
   * player's token when their turn begins, so selection covers that case on its
   * own — while a GM who clicks a different creature mid-turn to check something
   * expects to see THAT creature, not whoever the tracker says is up.
   */
  static _currentToken() {
    const controlled = canvas?.tokens?.controlled ?? [];
    return controlled.length === 1 ? controlled[0] : null;
  }

  /* ── Rendering ────────────────────────────────────────────────────────── */

  static _ensureElement() {
    if (ActionBar._el?.isConnected) return ActionBar._el;
    const hotbar = document.getElementById("hotbar");
    if (!hotbar?.parentElement) return null;

    const el = document.createElement("div");
    el.id = "ace-qol-action-bar";
    el.classList.add("ace-qol-ab");
    // Above Foundry's bar, never inside it — see the header.
    hotbar.parentElement.insertBefore(el, hotbar);
    ActionBar._el = el;
    return el;
  }

  static _renderDebounced() {
    if (ActionBar._renderTimer) clearTimeout(ActionBar._renderTimer);
    ActionBar._renderTimer = setTimeout(() => {
      ActionBar._renderTimer = null;
      ActionBar.render();
    }, 60);
  }

  static render() {
    try {
      const el = ActionBar._ensureElement();
      if (!el) return;

      const token = ActionBar._currentToken();
      const actor = token?.actor;
      if (!actor) {
        el.classList.remove("ace-qol-ab-visible");
        el.replaceChildren();
        ActionBar._actorId = null;
        return;
      }
      ActionBar._actorId = actor.id;
      el.classList.add("ace-qol-ab-visible");

      const esc = foundry.utils.escapeHTML;
      const actions = ActionBar._actionsFor(actor).slice(0, SLOT_COUNT);
      const badges  = ActionBar._badgesFor(actor);
      const multi   = ActionBar._multiattack(actor);
      const hp      = actor.system?.attributes?.hp ?? {};
      const ac      = actor.system?.attributes?.ac?.value ?? "—";

      const combatant = game.combat?.combatants?.find(c => c.tokenId === token.id) ?? null;
      const isMyTurn  = !!combatant && game.combat?.combatant?.id === combatant.id;
      const needsInit = !!combatant && combatant.initiative === null;

      const slotHtml = Array.from({ length: SLOT_COUNT }, (_, i) => {
        const item = actions[i];
        if (!item) return `<div class="ace-qol-ab-slot ace-qol-ab-empty"></div>`;
        const uses = item.system?.uses ?? {};
        const showUses = Number.isFinite(uses.max) && uses.max > 0;
        const spent = showUses ? `<span class="ace-qol-ab-uses">${uses.value ?? 0}/${uses.max}</span>` : "";
        const lvl = item.type === "spell" && item.system?.level > 0
          ? `<span class="ace-qol-ab-lvl">${item.system.level}</span>` : "";
        return `<div class="ace-qol-ab-slot" data-item-id="${item.id}" data-type="${esc(item.type)}"
                     data-tooltip="${esc(item.name)}">
                  <img src="${esc(item.img)}" alt="${esc(item.name)}">
                  <span class="ace-qol-ab-name">${esc(item.name)}</span>${spent}${lvl}
                </div>`;
      }).join("");

      const badgeHtml = badges.map(b =>
        `<div class="ace-qol-ab-badge" data-tooltip="${esc(b.name)}"><img src="${esc(b.img ?? "")}" alt=""></div>`
      ).join("");

      el.innerHTML = `
        <div class="ace-qol-ab-strip">${badgeHtml}</div>
        <div class="ace-qol-ab-main">
          <div class="ace-qol-ab-portrait" data-tooltip="${esc(actor.name)}">
            <img src="${esc(actor.img)}" alt="">
            <div class="ace-qol-ab-vitals">
              <span class="ace-qol-ab-hp">${hp.value ?? "—"}<span>/${hp.max ?? "—"}</span></span>
              <span class="ace-qol-ab-ac">${ac}</span>
            </div>
            ${multi ? `<div class="ace-qol-ab-multi" data-tooltip="${esc(multi.name)} — this creature attacks more than once">MULTI</div>` : ""}
            ${combatant && !needsInit
              ? `<div class="ace-qol-ab-init" data-tooltip="Initiative ${combatant.initiative}">${combatant.initiative}</div>`
              : ""}
            <div class="ace-qol-ab-dice" data-tooltip="Left-click: roll initiative &nbsp;·&nbsp; Right-click: ability &amp; skill checks">
              <i class="fas fa-dice-d20"></i>
            </div>
          </div>
          <div class="ace-qol-ab-slots">${slotHtml}</div>
          <div class="ace-qol-ab-turn">
            ${isMyTurn ? `<button type="button" class="ace-qol-ab-endturn" data-tooltip="End this creature's turn">
                            <i class="fas fa-hourglass-end"></i><span>NEXT TURN</span></button>` : ""}
          </div>
        </div>`;

      ActionBar._wire(el, actor, combatant);
    } catch (err) {
      console.error(`${LOG} | render failed:`, err);
    }
  }

  static _wire(el, actor, combatant) {
    // ── Use an action ───────────────────────────────────────────────────
    for (const slot of el.querySelectorAll(".ace-qol-ab-slot[data-item-id]")) {
      slot.addEventListener("click", async (ev) => {
        ev.preventDefault();
        const item = actor.items.get(slot.dataset.itemId);
        if (!item) return ui.notifications?.warn("That item is no longer on this creature.");
        try { await item.use(); }
        catch (err) {
          console.error(`${LOG} | using "${item.name}" failed:`, err);
          ui.notifications?.error(`${item.name} could not be used — see the console.`);
        }
      });
      // Right-click opens the sheet — the fastest route to "why is this greyed out".
      slot.addEventListener("contextmenu", (ev) => {
        ev.preventDefault();
        actor.items.get(slot.dataset.itemId)?.sheet?.render(true);
      });
    }

    // ── The dice on the portrait ────────────────────────────────────────
    // ⚠️ ALWAYS PRESENT, ALWAYS LIVE. The first cut only drew this when the
    // creature had no initiative yet, so the moment one was rolled the control
    // vanished — and Johnny's first report was "it doesn't show me initiative or
    // anything like that" (2026-08-14). A control that disappears after one use
    // is indistinguishable from a broken one. Rerolling is explicitly allowed,
    // which is what BG3 did and why its version kept working.
    const dice = el.querySelector(".ace-qol-ab-dice");
    if (dice) {
      dice.addEventListener("click", async (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        try {
          if (!game.combat) {
            ui.notifications?.warn("There is no combat running — start one first.");
            return;
          }
          // ⚠️ NAMED, NOT OPTIONAL-CHAINED. `?.()` on a method that no longer
          // exists returns undefined instead of throwing — that is exactly how
          // six dnd5e API renames hid for months (2026-08-12). If the system
          // drops this, we want a real error, not a dead button.
          if (typeof actor.rollInitiativeDialog === "function") {
            await actor.rollInitiativeDialog({ rerollInitiative: true });
          } else if (combatant && typeof combatant.rollInitiative === "function") {
            await combatant.rollInitiative();
          } else {
            throw new Error("no initiative method on this actor or combatant");
          }
        } catch (err) {
          console.error(`${LOG} | initiative roll failed for ${actor.name}:`, err);
          ui.notifications?.error(`Could not roll initiative for ${actor.name} — see the console.`);
        }
      });

      dice.addEventListener("contextmenu", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        ActionBar._openCheckMenu(el, actor);
      });
    }

    // ── End turn ────────────────────────────────────────────────────────
    el.querySelector(".ace-qol-ab-endturn")?.addEventListener("click", async (ev) => {
      ev.preventDefault();
      try { await game.combat?.nextTurn(); }
      catch (err) {
        console.error(`${LOG} | advancing the turn failed:`, err);
        ui.notifications?.error("Could not advance the turn — see the console.");
      }
    });
  }

  /**
   * The compact ability / skill list, on right-clicking the portrait dice.
   *
   * ⚠️ METHOD NAMES ARE THE 5.x ONES, DELIBERATELY SPELLED OUT. dnd5e renamed
   * `rollAbilityTest` to `rollAbilityCheck` and `rollAbilitySave` to
   * `rollSavingThrow`; calling the old names through `?.()` returns undefined
   * instead of throwing, which is how every OverTime save silently scored zero
   * for months (2026-08-12). Missing methods raise here, loudly.
   */
  static _openCheckMenu(el, actor) {
    el.querySelector(".ace-qol-ab-checks")?.remove();

    const esc = foundry.utils.escapeHTML;
    const abilities = Object.entries(CONFIG.DND5E?.abilities ?? {});
    const skills    = Object.entries(CONFIG.DND5E?.skills ?? {});

    const menu = document.createElement("div");
    menu.className = "ace-qol-ab-checks";
    menu.innerHTML = `
      <div class="ace-qol-ab-checks-col">
        <div class="ace-qol-ab-checks-head">Abilities</div>
        ${abilities.map(([k, a]) =>
          `<div class="ace-qol-ab-check" data-kind="ability" data-key="${esc(k)}">${esc(a.label ?? k)}</div>`).join("")}
      </div>
      <div class="ace-qol-ab-checks-col ace-qol-ab-checks-skills">
        <div class="ace-qol-ab-checks-head">Skills</div>
        ${skills.map(([k, s]) =>
          `<div class="ace-qol-ab-check" data-kind="skill" data-key="${esc(k)}">${esc(s.label ?? k)}</div>`).join("")}
      </div>`;
    el.appendChild(menu);

    const close = () => menu.remove();

    for (const row of menu.querySelectorAll(".ace-qol-ab-check")) {
      row.addEventListener("click", async (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        const { kind, key } = row.dataset;
        close();
        try {
          if (kind === "skill") {
            if (typeof actor.rollSkill !== "function") throw new Error("Actor#rollSkill is missing");
            await actor.rollSkill({ skill: key });
          } else {
            if (typeof actor.rollAbilityCheck !== "function") throw new Error("Actor#rollAbilityCheck is missing");
            await actor.rollAbilityCheck({ ability: key });
          }
        } catch (err) {
          console.error(`${LOG} | ${kind} check "${key}" failed for ${actor.name}:`, err);
          ui.notifications?.error(`That check could not be rolled — see the console.`);
        }
      });
    }

    // Dismiss on the next click anywhere else, and on Escape.
    setTimeout(() => {
      const away = (ev) => {
        if (menu.contains(ev.target)) return;
        close(); document.removeEventListener("mousedown", away);
      };
      document.addEventListener("mousedown", away);
      document.addEventListener("keydown", function esc2(ev) {
        if (ev.key !== "Escape") return;
        close(); document.removeEventListener("keydown", esc2);
      });
    }, 0);
  }

  /* ── Wiring ───────────────────────────────────────────────────────────── */

  static register() {
    const redraw = () => ActionBar._renderDebounced();

    Hooks.on("controlToken", redraw);
    Hooks.on("updateActor", (actor) => { if (actor.id === ActionBar._actorId) redraw(); });
    Hooks.on("updateItem",  (item)  => { if (item.parent?.id === ActionBar._actorId) redraw(); });
    Hooks.on("createItem",  (item)  => { if (item.parent?.id === ActionBar._actorId) redraw(); });
    Hooks.on("deleteItem",  (item)  => { if (item.parent?.id === ActionBar._actorId) redraw(); });
    for (const h of ["createActiveEffect", "updateActiveEffect", "deleteActiveEffect"]) {
      Hooks.on(h, (effect) => { if (effect.parent?.id === ActionBar._actorId) redraw(); });
    }
    // The end-turn button and the initiative pip both depend on combat state.
    Hooks.on("updateCombat", redraw);
    Hooks.on("deleteCombat", redraw);
    Hooks.on("canvasReady", redraw);

    // ⚠️ `Hooks.once("ready")` FROM INSIDE ready NEVER FIRES. Every ACE subsystem
    // starts from the entry file's own ready handler, so waiting on `ready` here
    // waits on an event already in progress — proven live 2026-08-12, when it
    // silently killed four features at once.
    if (game.ready) ActionBar.render();
    else Hooks.once("ready", () => ActionBar.render());

    console.log(`${LOG} | online — auto-filled action row above the macro bar`);
  }
}
