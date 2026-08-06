// ─── ACE: QOL — Party Transfer ("the Hand") ──────────────────────────────────
// Moving a party between scenes, properly.
//
// In Foundry a Token is a PER-SCENE document. A character standing on twelve
// maps is twelve TokenDocuments pointing at one Actor, and nothing in core
// knows which one the party is actually standing on. Teleporters CREATE a
// token rather than MOVE one, so returning somewhere gives you duplicates;
// nothing cleans up behind you; and combat holds a token id that quietly stops
// resolving the moment you change scenes.
//
// This module makes a creature exist ONCE.
//
//   Transfer — lift chosen tokens off this scene into the Hand
//   Place    — take them out of the Hand and land them on another scene
//
// ⚠️ THE DURABILITY RULE: never let a creature exist only inside our data
// structure. Linked tokens are safe by construction (the Actor is the truth,
// the token is a puppet). UNLINKED tokens carry their whole state — HP,
// conditions, items, effects — in the token's own delta, on the scene. Delete
// that token and the only copy of a half-dead goblin is whatever we wrote
// down. So Transfer ALSO creates a real Actor in an "ACE — In Transit" folder
// for every unlinked token: a first-class document that participates in
// Foundry's own backups and exports, is visible in the sidebar, and can be
// dragged back onto a map by hand if our manifest is ever lost.
//
// On a crash the folder is the truth and the manifest is rebuilt from it.
//
// See docs/PARTY_TRANSFER_SPEC.md for the full design.
// ──────────────────────────────────────────────────────────────────────────────

import { MODULE_ID } from "./ace-qol.mjs";
import { Situation } from "./situation.mjs";

const HAND_KEY            = "partyHand";
const TRANSIT_FOLDER_NAME = "ACE — In Transit";
const HAND_VERSION        = 1;

// Statuses that mean "cannot walk through the door under its own power".
// PRONE IS IN THIS LIST DELIBERATELY (Johnny, 2026-08-01): a prone character
// is not crawling to another map. Either somebody drags them or they get left
// behind, and being left behind must never happen silently.
const CARRY_STATUSES = [
  "unconscious", "paralyzed", "petrified", "stunned",
  "incapacitated", "restrained", "grappled", "prone", "sleeping",
];

const DISPOSITION_ROWS = [
  { key: "friendly", value:  1, label: "Friendly", icon: "fa-solid fa-handshake" },
  { key: "neutral",  value:  0, label: "Neutral",  icon: "fa-solid fa-circle-half-stroke" },
  { key: "hostile",  value: -1, label: "Hostile",  icon: "fa-solid fa-fire" },
  { key: "secret",   value: -2, label: "Secret",   icon: "fa-solid fa-user-secret" },
];

// Live drag payload. Held in module scope rather than in dataTransfer because
// Foundry's own board drop handler reads dataTransfer and would try to parse
// ours as a document drop.
let _dragPayload = null;

// ─── Settings + toolbar registration ─────────────────────────────────────────
// Registered at module-load time so the init hook is in place before Foundry
// builds the scene controls (V13 fires getSceneControlButtons once, early).

Hooks.once("init", () => {
  try { PartyTransfer.registerSettings(); }
  catch (err) { console.error(`${MODULE_ID} | Party Transfer settings registration failed:`, err); }
});

Hooks.on("getSceneControlButtons", (controls) => {
  try { PartyTransfer._injectIntoControls(controls); }
  catch (err) { console.error(`${MODULE_ID} | Party Transfer toolbar injection failed:`, err); }
});

// ⚠️ V13 renders tools in object-key insertion order, and other modules insert
// theirs at unpredictable times — so our buttons drift up and down the list
// between renders. The only way to pin them is to physically move the rendered
// nodes to the end of their container after EVERY render. This file is imported
// after quick-select-tools.mjs, so this listener runs after that module's own
// reorder and our two buttons finish at the very bottom, every time.
Hooks.on("renderSceneControls", (_app, htmlOrJq) => {
  try {
    if (!game.user?.isGM) return;
    const root = htmlOrJq?.[0] ?? htmlOrJq;
    if (!root?.querySelector) return;
    for (const name of ["ace-party-transfer", "ace-party-place"]) {
      const el = root.querySelector(`[data-tool="${name}"], [data-name="${name}"], [name="${name}"]`);
      if (el?.parentNode) el.parentNode.appendChild(el);
    }
  } catch (err) {
    console.warn(`${MODULE_ID} | Party Transfer toolbar pin failed (non-fatal):`, err);
  }
});

export class PartyTransfer {

  static _dropInstalled = false;
  static _container     = null;
  static _lastPlaced    = [];
  static _placing       = false;   // re-entrancy lock — see _placeAt
  static _crowded       = 0;       // how many had to stack this placement
  static _wallWarned    = false;   // one-shot guard on the wall-API warning
  static _aim           = null;    // live crosshair session — see beginAim
  static _selected      = new Set(); // panel selection; survives re-renders
  static _aimInstalled  = false;
  static _layer         = null;    // PIXI container holding the crosshair + ghosts
  static _transferDlgs  = new Set(); // EVERY live Transfer window — see _closeTransferDialog
  static _transferOpen  = false;     // re-entrancy guard — see openTransfer

  // ═══════════════════════════════════════════════════════════════════════════
  //  Registration
  // ═══════════════════════════════════════════════════════════════════════════

  static registerSettings() {
    const s = (key, opts) => game.settings.register(MODULE_ID, key, opts);

    // The manifest itself — the Hand. Hidden from the settings UI; this is
    // data, not a preference. World-scoped so it survives reloads and crashes.
    s(HAND_KEY, {
      scope: "world",
      config: false,
      type: Object,
      default: { version: HAND_VERSION, entries: [] },
    });

    s("partyTransferExcludeDead", {
      name: "Party Transfer — exclude dead by default",
      hint: "Dead creatures start unticked in the Transfer window. You can always tick them by hand when the body comes too.",
      scope: "world", config: true, type: Boolean, default: true,
    });

    s("partyTransferHostilesHidden", {
      name: "Party Transfer — hostiles arrive hidden",
      hint: "Hostile and Secret tokens land invisible so you can set up an ambush, then spring it with the Reveal button.",
      scope: "world", config: true, type: Boolean, default: true,
    });

    s("partyTransferRemoveCopies", {
      name: "Party Transfer — remove existing copies on arrival",
      hint: "Before a creature lands, delete any copy of it already standing on the destination scene. This is the whole point of the feature — turning it off brings the duplicates back.",
      scope: "world", config: true, type: Boolean, default: true,
    });

    s("partyTransferKeepIds", {
      name: "Party Transfer — preserve token identity",
      hint: "Land each token with the id it had before. Everything that points at that token — combat, animations, our own flags — keeps working across the scene change.",
      scope: "world", config: true, type: Boolean, default: true,
    });

    // Default OFF (2026-08-05). Reproducing the old arrangement reads as random
    // placement — someone standing across the room on the last map lands across
    // the room on this one. A tight bunch around the crosshair is what you
    // actually want on arrival; you spread out from there.
    s("partyTransferFormation", {
      name: "Party Transfer — remember formation",
      hint: "Land the group in the same relative arrangement it was picked up in. Off by default: arriving as a tight group around the crosshair is more predictable.",
      scope: "world", config: true, type: Boolean, default: false,
    });

    // Internal, not a preference — tracks one-time behaviour migrations.
    s("partyTransferSchema", {
      scope: "world", config: false, type: Number, default: 0,
    });

    s("partyTransferFollowCombat", {
      name: "Party Transfer — combat follows the party",
      hint: "If a fight is running and everyone in it moves to the new scene, move the combat too. Without this the turn marker silently stops advancing.",
      scope: "world", config: true, type: Boolean, default: true,
    });
  }

  static init() {
    if (!game.user?.isGM) return;
    this._injectCSS();
    this._refreshIndicator();
    this._startupCheck();
    this._postReadyInject();
    this._migrate();
    console.log(`${MODULE_ID} | Party Transfer online (v${game.modules.get(MODULE_ID)?.version ?? "?"}) — ${this.count()} creature(s) in hand`);
  }

  /**
   * ⚠️ The hook above is NOT enough on its own.
   *
   * V13 fires `getSceneControlButtons` ONCE, during init — before this module
   * is running. By the time we're ready the toolbar is already built and
   * rendered, so a hook-only registration silently shows nothing until some
   * unrelated thing re-renders the controls. That's the "works on the second
   * load" bug the 2026-06-09 audit called out; Quick Select solves it the same
   * way. Poll until the controls exist, mutate them directly, re-render.
   */
  static _postReadyInject(attempt = 0) {
    const MAX = 50;
    if (!ui.controls?.controls) {
      if (attempt >= MAX) {
        console.warn(`${MODULE_ID} | Party Transfer: scene controls never became available after ${MAX * 100}ms — toolbar buttons unavailable. Use game.aceQol.partyTransfer.openTransfer().`);
        return;
      }
      setTimeout(() => this._postReadyInject(attempt + 1), 100);
      return;
    }
    try {
      this._injectIntoControls(ui.controls.controls);
      ui.controls.render?.();
      const group = ui.controls.controls?.tokens ?? ui.controls.controls?.token;
      const ours  = group?.tools
        ? Object.keys(group.tools).filter(k => k.startsWith("ace-party-"))
        : [];
      console.debug(`${MODULE_ID} | Party Transfer toolbar: [${ours.join(", ") || "NONE — check the token control group"}]`);
    } catch (err) {
      console.error(`${MODULE_ID} | Party Transfer toolbar inject failed:`, err);
    }
  }

  /**
   * One-time behaviour migrations. A changed `default:` only affects worlds that
   * have never stored a value — an existing world keeps whatever it already had,
   * so a default flip silently does nothing where it matters most.
   */
  static async _migrate() {
    try {
      const v = Number(game.settings.get(MODULE_ID, "partyTransferSchema")) || 0;
      if (v >= 1) return;
      await game.settings.set(MODULE_ID, "partyTransferFormation", false);
      await game.settings.set(MODULE_ID, "partyTransferSchema", 1);
      console.log(`${MODULE_ID} | Party Transfer — formation memory switched off; arrivals now bunch around the crosshair.`);
    } catch (err) {
      console.warn(`${MODULE_ID} | Party Transfer migration failed (non-fatal):`, err);
    }
  }

  static _injectIntoControls(controls) {
    if (!controls || !game.user?.isGM) return;

    let tokenGroup;
    if (Array.isArray(controls)) tokenGroup = controls.find(c => c.name === "token" || c.name === "tokens");
    else if (typeof controls === "object") tokenGroup = controls.tokens ?? controls.token;
    if (!tokenGroup) return;

    const tools = [
      {
        name: "ace-party-transfer",
        title: "Transfer party off this scene (pick up into the Hand)",
        icon: "fa-solid fa-people-arrows",
        button: true, visible: true, order: 99007,
        onClick:  () => PartyTransfer.openTransfer(),
        onChange: () => PartyTransfer.openTransfer(),
      },
      {
        name: "ace-party-place",
        title: "Place held creatures onto this scene",
        icon: "fa-solid fa-hand-holding-hand",
        button: true, visible: true, order: 99008,
        onClick:  () => PartyTransfer.openPlace(),
        onChange: () => PartyTransfer.openPlace(),
      },
    ];

    if (Array.isArray(tokenGroup.tools)) {
      tokenGroup.tools = tokenGroup.tools.filter(t => !t?.name?.startsWith?.("ace-party-"));
      tokenGroup.tools.push(...tools);
    } else if (tokenGroup.tools && typeof tokenGroup.tools === "object") {
      for (const tool of tools) if (tool.name in tokenGroup.tools) delete tokenGroup.tools[tool.name];
      for (const tool of tools) tokenGroup.tools[tool.name] = tool;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  The Hand — manifest accessors
  // ═══════════════════════════════════════════════════════════════════════════

  static hand() {
    try {
      const raw = game.settings.get(MODULE_ID, HAND_KEY);
      if (!raw || typeof raw !== "object") return { version: HAND_VERSION, entries: [] };
      if (!Array.isArray(raw.entries)) return { version: HAND_VERSION, entries: [] };
      return raw;
    } catch (_) {
      return { version: HAND_VERSION, entries: [] };
    }
  }

  static async _setHand(hand) {
    await game.settings.set(MODULE_ID, HAND_KEY, hand);
    this._refreshIndicator();
    try { if (this._container?.rendered) this._container.render({ force: false }); }
    catch (_) { /* container may have closed underneath us */ }
  }

  /** Entries still waiting to be put down. */
  static held() {
    return this.hand().entries.filter(e => !e.placed);
  }

  static count() {
    return this.held().length;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Creature reading — status, death, who needs carrying
  // ═══════════════════════════════════════════════════════════════════════════

  static _statuses(actor) {
    try { return Situation.readStatuses(actor); }
    catch (_) { return new Set(); }
  }

  static _isDead(tokenDoc) {
    const actor = tokenDoc?.actor;
    if (!actor) return false;
    if (this._statuses(actor).has("dead")) return true;
    const hp = Number(actor.system?.attributes?.hp?.value);
    if (!Number.isFinite(hp) || hp > 0) return false;
    // A downed player character is dying, not dead — the body is still a person.
    return actor.type !== "character";
  }

  /**
   * Why this creature cannot walk to the next scene under its own power, or
   * null if it can. Returns the status name so the UI can say WHY rather than
   * just refusing.
   */
  static _carryReason(tokenDoc) {
    const actor = tokenDoc?.actor;
    if (!actor) return null;
    const st = this._statuses(actor);
    for (const s of CARRY_STATUSES) if (st.has(s)) return s;
    const hp = Number(actor.system?.attributes?.hp?.value);
    if (Number.isFinite(hp) && hp <= 0) return "unconscious";
    return null;
  }

  static _hpLabel(tokenDoc) {
    const hp = tokenDoc?.actor?.system?.attributes?.hp;
    if (!hp) return "";
    const v = Number(hp.value), m = Number(hp.max);
    if (!Number.isFinite(v) || !Number.isFinite(m)) return "";
    return `${v}/${m}`;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Transit folder + transit Actors (the second, redundant layer)
  // ═══════════════════════════════════════════════════════════════════════════

  static transitFolder() {
    return game.folders?.find(f => f.type === "Actor" && f.name === TRANSIT_FOLDER_NAME) ?? null;
  }

  static async _ensureTransitFolder() {
    const existing = this.transitFolder();
    if (existing) return existing;
    try {
      return await Folder.create({ name: TRANSIT_FOLDER_NAME, type: "Actor", color: "#c9a227" });
    } catch (err) {
      console.error(`${MODULE_ID} | Could not create the "${TRANSIT_FOLDER_NAME}" folder:`, err);
      return null;
    }
  }

  /**
   * Snapshot an unlinked token's live creature into a real Actor, so it exists
   * as a first-class document while it is in transit. This is the safety net
   * unlinked tokens have never had.
   */
  static async _createTransitActor(tokenDoc) {
    try {
      const src = tokenDoc.actor;
      if (!src) return null;
      const folder = await this._ensureTransitFolder();
      const data = src.toObject();
      delete data._id;
      data.folder = folder?.id ?? null;
      data.name   = `${src.name} (in transit)`;
      data.flags  = data.flags ?? {};
      data.flags[MODULE_ID] = Object.assign({}, data.flags[MODULE_ID], {
        transit: {
          originSceneId:   tokenDoc.parent?.id ?? null,
          originSceneName: tokenDoc.parent?.name ?? "",
          tokenId:         tokenDoc.id,
          baseActorId:     src.id ?? null,
        },
      });
      const created = await Actor.create(data);
      return created?.id ?? null;
    } catch (err) {
      console.error(`${MODULE_ID} | Transit actor creation failed for "${tokenDoc?.name}":`, err);
      return null;
    }
  }

  static async _deleteTransitActor(actorId) {
    if (!actorId) return;
    try { await game.actors?.get(actorId)?.delete(); }
    catch (err) { console.warn(`${MODULE_ID} | Could not clear transit actor ${actorId}:`, err); }
  }

  /**
   * On load: say what is still in hand, and reconcile the manifest against the
   * transit folder. A stray is EVIDENCE, not litter — we report, never delete.
   */
  static _startupCheck() {
    try {
      const held = this.held();
      const folder = this.transitFolder();
      const strays = (folder?.contents ?? []).filter(a => {
        const tid = a.getFlag?.(MODULE_ID, "transit")?.tokenId;
        return !held.some(e => e.id === tid);
      });

      if (held.length) {
        const hand = this.hand();
        ui.notifications?.warn(
          `ACE — ${held.length} creature${held.length === 1 ? " is" : "s are"} still in hand from ` +
          `${hand.originSceneName ? `"${hand.originSceneName}"` : "a previous session"}. ` +
          `Use the Place button on the token toolbar to put them down.`
        );
      }
      if (strays.length) {
        console.warn(`${MODULE_ID} | Party Transfer — ${strays.length} actor(s) in "${TRANSIT_FOLDER_NAME}" not referenced by the Hand:`,
          strays.map(a => a.name));
        ui.notifications?.warn(
          `ACE — ${strays.length} creature${strays.length === 1 ? "" : "s"} left in the "${TRANSIT_FOLDER_NAME}" folder ` +
          `with no matching entry in the Hand. They have NOT been deleted — drag them onto a map to recover them.`
        );
      }
    } catch (err) {
      console.warn(`${MODULE_ID} | Party Transfer startup check failed:`, err);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  TRANSFER — picking up
  // ═══════════════════════════════════════════════════════════════════════════

  static async openTransfer() {
    if (!game.user?.isGM) return void ui.notifications?.warn("ACE — Party Transfer is a GM tool.");
    if (!canvas?.scene) return void ui.notifications?.warn("ACE — No scene is active.");

    // ⚠️ RE-ENTRANCY GUARD. The toolbar tool registers BOTH onClick and onChange
    // for V12/V13 compatibility, so one press can call this TWICE and stack two
    // dialogs. You act on the front one, it closes, and the second is revealed —
    // built from the scene as it was BEFORE the lift, so it shows creatures that
    // no longer exist there. Exactly one Transfer window, ever.
    if (this._transferOpen) {
      console.debug(`${MODULE_ID} | Party Transfer — Transfer window already open; ignoring the duplicate open.`);
      return;
    }

    // Opening Transfer means "I'm choosing who travels" — the container and any
    // live crosshair belong to the other half of the loop. Clear them.
    this.cancelAim(true);
    this._closeTransferDialog();
    this._transferOpen = true;
    try {
      return await this._openTransferInner();
    } finally {
      this._transferOpen = false;
      this._closeTransferDialog();   // nothing survives this call, ever
    }
  }

  static async _openTransferInner() {

    if (this.count()) {
      const proceed = await foundry.applications.api.DialogV2.confirm({
        window: { title: "Something is already in hand" },
        content: `<div class="ace-party-warn"><p><strong>${this.count()} creature${this.count() === 1 ? " is" : "s are"} still in hand.</strong></p>
          <p>Picking up more will add to the same handful. Put the current ones down first if you didn't mean to.</p></div>`,
        rejectClose: false, modal: true,
      });
      if (!proceed) return;
    }

    const tokens = (canvas.scene.tokens?.contents ?? []).slice()
      .sort((a, b) => (b.disposition - a.disposition) || String(a.name).localeCompare(String(b.name)));

    if (!tokens.length) return void ui.notifications?.info("ACE — There are no tokens on this scene to transfer.");

    const rows = tokens.map(t => ({
      id:          t.id,
      name:        t.name ?? t.actor?.name ?? "Unnamed",
      img:         t.texture?.src ?? t.actor?.img ?? "icons/svg/mystery-man.svg",
      disposition: Number(t.disposition ?? 0),
      dead:        this._isDead(t),
      carryReason: this._carryReason(t),
      hp:          this._hpLabel(t),
      linked:      !!t.actorLink,
      hidden:      !!t.hidden,
    }));

    const excludeDead = game.settings.get(MODULE_ID, "partyTransferExcludeDead");
    const content = this._transferHtml(rows, excludeDead);

    const result = await foundry.applications.api.DialogV2.wait({
      window: { title: `Transfer party off "${canvas.scene.name}"`, resizable: true },
      classes: ["ace-party-dialog"],
      position: { width: 620 },
      content,
      rejectClose: false,
      buttons: [
        {
          action: "transfer", label: "Pick Up", icon: "fa-solid fa-hand-holding-hand", default: true,
          callback: (_ev, _btn, dialog) => this._readTransferForm(dialog?.element),
        },
        { action: "cancel", label: "Cancel", icon: "fa-solid fa-xmark" },
      ],
      render: (_ev, dialog) => {
        if (dialog) this._transferDlgs.add(dialog);
        this._wireTransferForm(dialog?.element, rows);
      },
    });
    this._closeTransferDialog();

    if (!result || result === "cancel" || !result.ids?.length) return;
    await this._lift(result.ids, result.bearers);
  }

  static _transferHtml(rows, excludeDead) {
    const esc = (v) => foundry.utils.escapeHTML(String(v ?? ""));

    const bulk = DISPOSITION_ROWS.map(d => {
      const n = rows.filter(r => r.disposition === d.value).length;
      if (!n) return "";
      return `<button type="button" class="ace-party-bulk" data-disp="${d.value}">
        <i class="${d.icon}"></i> ${d.label} <span class="ace-party-count">${n}</span></button>`;
    }).join("");

    const groups = DISPOSITION_ROWS.map(d => {
      const mine = rows.filter(r => r.disposition === d.value);
      if (!mine.length) return "";

      const items = mine.map(r => {
        // It's PARTY Transfer. Only the people travelling with you start
        // ticked — Friendly and Neutral. Hostiles and Secret tokens are
        // scenery you're walking away from, not luggage. The disposition
        // buttons above bring them along in one click when you do mean to.
        const travels = r.disposition === 1 || r.disposition === 0;
        const checked = (travels && !(r.dead && excludeDead)) ? "checked" : "";
        const chips = [];
        if (r.dead)           chips.push(`<span class="ace-party-chip ace-party-chip-dead">DEAD</span>`);
        if (r.carryReason)    chips.push(`<span class="ace-party-chip ace-party-chip-carry">${esc(r.carryReason)}</span>`);
        if (r.hidden)         chips.push(`<span class="ace-party-chip">hidden</span>`);
        if (!r.linked)        chips.push(`<span class="ace-party-chip ace-party-chip-unlinked">unlinked</span>`);

        return `<li class="ace-party-row" data-id="${esc(r.id)}" data-disp="${r.disposition}"
                    data-carry="${r.carryReason ? "1" : "0"}" data-dead="${r.dead ? "1" : "0"}">
          <label class="ace-party-pick">
            <input type="checkbox" class="ace-party-check" data-id="${esc(r.id)}" ${checked}>
            <img src="${esc(r.img)}" alt="" class="ace-party-portrait">
            <span class="ace-party-name">${esc(r.name)}</span>
            ${r.hp ? `<span class="ace-party-hp">${esc(r.hp)}</span>` : ""}
            <span class="ace-party-chips">${chips.join("")}</span>
          </label>
          <div class="ace-party-bearer" data-for="${esc(r.id)}" hidden>
            <i class="fa-solid fa-person-carry-box"></i>
            <span>Carried by</span>
            <select class="ace-party-bearer-select" data-for="${esc(r.id)}">
              <option value="">— nobody —</option>
            </select>
          </div>
        </li>`;
      }).join("");

      return `<details class="ace-party-group" open>
        <summary><i class="${d.icon}"></i> ${d.label} <span class="ace-party-count">${mine.length}</span></summary>
        <ul class="ace-party-list">${items}</ul>
      </details>`;
    }).join("");

    return `<div class="ace-party-transfer">
      <p class="ace-party-lede">
        Everything you tick is <strong>lifted off this scene</strong> and held until you place it.
        The scene is left clean behind you. Hostiles start unticked — bring them with the buttons below.
      </p>
      <div class="ace-party-bulkbar">
        <span class="ace-party-bulklabel">Tick all:</span>
        ${bulk}
        <span class="ace-party-spacer"></span>
        <button type="button" class="ace-party-bulk ace-party-none" data-disp="none"><i class="fa-solid fa-eraser"></i> None</button>
      </div>
      ${groups}
      <div class="ace-party-summary"></div>
    </div>`;
  }

  static _wireTransferForm(root, rows) {
    if (!root) return;
    const byId = new Map(rows.map(r => [r.id, r]));

    const checks    = () => Array.from(root.querySelectorAll(".ace-party-check"));
    const checkedIds = () => checks().filter(c => c.checked).map(c => c.dataset.id);

    // Refresh which rows demand a bearer, and who is eligible to be one.
    const refresh = () => {
      const picked = checkedIds();
      const pickedSet = new Set(picked);

      // A bearer must be coming along, must not be dead, and must not itself
      // be a burden.
      const eligible = picked
        .map(id => byId.get(id))
        .filter(r => r && !r.dead && !r.carryReason);

      for (const row of root.querySelectorAll(".ace-party-row")) {
        const id     = row.dataset.id;
        const rec    = byId.get(id);
        const holder = row.querySelector(".ace-party-bearer");
        const select = row.querySelector(".ace-party-bearer-select");
        if (!rec || !holder || !select) continue;

        const needs = pickedSet.has(id) && (!!rec.carryReason || rec.dead);
        holder.hidden = !needs;
        if (!needs) { select.value = ""; row.classList.remove("ace-party-needs"); continue; }

        const keep = select.value;
        const opts = [`<option value="">— nobody —</option>`]
          .concat(eligible.filter(e => e.id !== id).map(e =>
            `<option value="${foundry.utils.escapeHTML(e.id)}">${foundry.utils.escapeHTML(e.name)}</option>`));
        select.innerHTML = opts.join("");
        if (keep && eligible.some(e => e.id === keep)) select.value = keep;

        row.classList.toggle("ace-party-needs", !select.value);
      }

      // Summary + confirm gating
      const unresolved = Array.from(root.querySelectorAll(".ace-party-row.ace-party-needs"))
        .map(r => byId.get(r.dataset.id)?.name).filter(Boolean);

      const summary = root.querySelector(".ace-party-summary");
      if (summary) {
        if (!picked.length) {
          summary.className = "ace-party-summary ace-party-summary-warn";
          summary.textContent = "Nothing ticked — nobody will be moved.";
        } else if (unresolved.length) {
          const verb = unresolved.length === 1 ? "has" : "have";
          summary.className = "ace-party-summary ace-party-summary-block";
          summary.innerHTML = `<i class="fa-solid fa-triangle-exclamation"></i> ` +
            `<strong>${foundry.utils.escapeHTML(unresolved.join(", "))}</strong> ` +
            `can't reach the next scene alone, and ${verb} nobody carrying them. ` +
            `Assign a bearer — or untick them and they stay behind.`;
        } else {
          summary.className = "ace-party-summary ace-party-summary-ok";
          const carried = Array.from(root.querySelectorAll(".ace-party-bearer:not([hidden])")).length;
          summary.innerHTML = `<i class="fa-solid fa-check"></i> ${picked.length} creature${picked.length === 1 ? "" : "s"} ready to travel` +
            (carried ? ` — ${carried} being carried.` : ".");
        }
      }

      // The Pick Up button lives in the dialog footer, outside our content root.
      const footer = root.closest?.(".application")?.querySelector?.('button[data-action="transfer"]')
        ?? root.parentElement?.querySelector?.('button[data-action="transfer"]');
      if (footer) footer.disabled = !picked.length || unresolved.length > 0;
    };

    root.addEventListener("change", (ev) => {
      if (ev.target?.classList?.contains("ace-party-check") ||
          ev.target?.classList?.contains("ace-party-bearer-select")) refresh();
    });

    root.addEventListener("click", (ev) => {
      const btn = ev.target?.closest?.(".ace-party-bulk");
      if (!btn) return;
      ev.preventDefault();
      const disp = btn.dataset.disp;
      if (disp === "none") {
        for (const c of checks()) c.checked = false;
      } else {
        const want = Number(disp);
        for (const c of checks()) {
          const row = c.closest(".ace-party-row");
          if (Number(row?.dataset.disp) === want) c.checked = true;
        }
      }
      refresh();
    });

    refresh();
  }

  static _readTransferForm(root) {
    if (!root) return null;
    const ids = Array.from(root.querySelectorAll(".ace-party-check"))
      .filter(c => c.checked).map(c => c.dataset.id);
    const bearers = {};
    for (const sel of root.querySelectorAll(".ace-party-bearer-select")) {
      const holder = sel.closest(".ace-party-bearer");
      if (holder?.hidden) continue;
      if (sel.value) bearers[sel.dataset.for] = sel.value;
    }
    return { ids, bearers };
  }

  /**
   * Lift the chosen tokens off the current scene into the Hand.
   *
   * DELETE ON TRANSFER, not on place. The whole complaint is leftovers —
   * leaving ghosts behind until placement defeats the purpose. Safe because of
   * the two-layer storage above and Undo below.
   */
  static async _lift(ids, bearers = {}) {
    // The pick is made — the Transfer window's job is over. Close it BEFORE
    // anything else so it can never linger behind the container showing a list
    // of creatures that are about to stop existing on this scene.
    this._closeTransferDialog();

    const scene = canvas.scene;
    if (!scene) return;

    const docs = ids.map(id => scene.tokens.get(id)).filter(Boolean);
    if (!docs.length) return void ui.notifications?.warn("ACE — Those tokens are no longer on this scene.");

    const entries = [];
    let transitCount = 0;

    for (const doc of docs) {
      let transitActorId = null;
      if (!doc.actorLink) {
        transitActorId = await this._createTransitActor(doc);
        if (transitActorId) transitCount++;
        else {
          // The safety net failed. Do NOT delete the only copy of this creature.
          ui.notifications?.error(
            `ACE — Could not create a transit record for "${doc.name}". It has been LEFT ON THE SCENE rather than risk losing it.`
          );
          continue;
        }
      }

      // Stamp a stable identity that survives an id reassignment. Matching a
      // copy on token id alone breaks the moment a landing has to mint a fresh
      // id (collision on the destination) — the next placement then can't find
      // the copy it should be clearing, and you get a duplicate.
      const _data = doc.toObject();
      _data.flags = _data.flags ?? {};
      _data.flags[MODULE_ID] = Object.assign({}, _data.flags[MODULE_ID], { transferKey: doc.id });

      entries.push({
        id:             doc.id,
        name:           doc.name ?? doc.actor?.name ?? "Unnamed",
        img:            doc.texture?.src ?? doc.actor?.img ?? "icons/svg/mystery-man.svg",
        actorId:        doc.actorId ?? null,
        actorLink:      !!doc.actorLink,
        disposition:    Number(doc.disposition ?? 0),
        wasHidden:      !!doc.hidden,
        originX:        Number(doc.x) || 0,
        originY:        Number(doc.y) || 0,
        elevation:      Number(doc.elevation) || 0,
        bearerId:       bearers[doc.id] ?? null,
        transitActorId,
        tokenData:      _data,
        placed:         false,
      });
    }

    if (!entries.length) return;

    const hand = this.hand();
    const merged = {
      version:         HAND_VERSION,
      originSceneId:   scene.id,
      originSceneName: scene.name,
      liftedAt:        Number(game.time?.worldTime ?? 0),
      entries:         (hand.entries ?? []).filter(e => !e.placed).concat(entries),
    };

    // Write the manifest BEFORE deleting anything. If the world dies between
    // these two lines the tokens are still on the scene and the manifest is
    // merely optimistic — recoverable. The other order loses creatures.
    await this._setHand(merged);

    try {
      await scene.deleteEmbeddedDocuments("Token", entries.map(e => e.id));
    } catch (err) {
      console.error(`${MODULE_ID} | Party Transfer — lift delete failed:`, err);
      ui.notifications?.error("ACE — Could not clear the tokens off the scene. They are recorded in the Hand; check the console.");
    }

    this._refreshIndicator();
    ui.notifications?.info(
      `ACE — Picked up ${entries.length} creature${entries.length === 1 ? "" : "s"}` +
      (transitCount ? ` (${transitCount} unlinked, backed up to "${TRANSIT_FOLDER_NAME}")` : "") + "."
    );
    this.openPlace();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  UNDO — put everyone back exactly where they were
  // ═══════════════════════════════════════════════════════════════════════════

  static async undoTransfer() {
    const hand = this.hand();
    const pending = (hand.entries ?? []).filter(e => !e.placed);
    if (!pending.length) return void ui.notifications?.info("ACE — Nothing to undo.");

    const scene = game.scenes?.get(hand.originSceneId);
    if (!scene) return void ui.notifications?.error("ACE — The scene these creatures came from no longer exists. Place them somewhere instead.");

    const confirmed = await foundry.applications.api.DialogV2.confirm({
      window: { title: "Undo Transfer" },
      content: `<div class="ace-party-warn"><p>Put all <strong>${pending.length}</strong> held creature${pending.length === 1 ? "" : "s"}
        back on <strong>${foundry.utils.escapeHTML(scene.name)}</strong>, in their original positions?</p></div>`,
      rejectClose: false, modal: true,
    });
    if (!confirmed) return;

    const data = pending.map(e => {
      const d = foundry.utils.deepClone(e.tokenData);
      d.x = e.originX; d.y = e.originY;
      return d;
    });

    try {
      await scene.createEmbeddedDocuments("Token", data, { keepId: true });
    } catch (err) {
      console.warn(`${MODULE_ID} | Undo with preserved ids failed, retrying without:`, err);
      for (const d of data) delete d._id;
      await scene.createEmbeddedDocuments("Token", data);
    }

    for (const e of pending) await this._deleteTransitActor(e.transitActorId);

    await this._setHand({ version: HAND_VERSION, entries: [] });
    this._closeContainer();
    ui.notifications?.info(`ACE — Returned ${pending.length} creature${pending.length === 1 ? "" : "s"} to "${scene.name}".`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  PLACE — putting down
  // ═══════════════════════════════════════════════════════════════════════════

  static async openPlace() {
    if (!game.user?.isGM) return;
    if (!this.count()) return void ui.notifications?.info("ACE — Nothing in hand. Use Transfer to pick creatures up first.");
    this._closeTransferDialog();   // these two windows are never both correct
    this._injectCSS();
    this._installCanvasDrop();
    const Cls = this._containerClass();
    if (this._container?.rendered) { this._container.render({ force: false }); this._container.bringToFront?.(); return; }
    this._container = new Cls();
    this._container.render(true);
  }

  static _closeContainer() {
    try { this._container?.close?.(); } catch (_) { /* already gone */ }
    this._container = null;
  }

  /**
   * Force the Transfer window shut.
   *
   * Transfer and the container are MUTUALLY EXCLUSIVE — one is "choose who
   * travels", the other is "put them down", and they describe different moments.
   * Leaving Transfer sitting behind the container shows the GM a stale list of
   * creatures that are no longer even on the scene. Never rely on the dialog
   * closing itself; close it explicitly at every hand-off point.
   */
  static _closeTransferDialog() {
    // Close EVERY one we know about, then sweep the DOM for any we don't.
    // Tracking a single reference was the flaw: when two dialogs existed, the
    // reference held only the newest and the older one stayed on screen showing
    // a list of creatures from before the lift.
    for (const dlg of Array.from(this._transferDlgs)) {
      try { dlg.close({ force: true }); } catch (_) { /* already gone */ }
    }
    this._transferDlgs.clear();

    try {
      for (const el of document.querySelectorAll(".ace-party-dialog")) {
        const app = foundry.applications?.instances?.get?.(el.id);
        if (app) { try { app.close({ force: true }); } catch (_) { /* gone */ } }
        else el.remove();   // orphaned node with no app behind it
      }
    } catch (err) {
      console.warn(`${MODULE_ID} | Party Transfer — dialog sweep failed (non-fatal):`, err);
    }
  }

  /**
   * Built lazily on first use — ApplicationV2 is not guaranteed to exist at
   * module-import time, which is why the config panel is lazily imported too.
   */
  static _containerClass() {
    if (this._ContainerCls) return this._ContainerCls;
    const { ApplicationV2 } = foundry.applications.api;
    const self = this;

    class PartyContainer extends ApplicationV2 {
      static DEFAULT_OPTIONS = {
        id: "ace-party-container",
        classes: ["ace-party-container-app"],
        window: { title: "ACE — In Hand", icon: "fa-solid fa-hand-holding-hand", resizable: true },
        position: { width: 470, height: "auto" },
      };

      async _renderHTML() { return self._containerHtml(); }

      _replaceHTML(result, content) {
        content.innerHTML = result;
        self._wireContainer(content);
        return content;
      }

      async close(options) {
        if (self._container === this) self._container = null;
        // A crosshair must never outlive the panel that armed it.
        self.cancelAim(true);
        return super.close(options);
      }
    }

    this._ContainerCls = PartyContainer;
    return PartyContainer;
  }

  static _containerHtml() {
    const esc = (v) => foundry.utils.escapeHTML(String(v ?? ""));
    const held = this.held();
    const hand = this.hand();

    if (!held.length) {
      return `<div class="ace-party-container">
        <p class="ace-party-empty"><i class="fa-solid fa-hands"></i><br>Your hands are empty.</p>
      </div>`;
    }

    const nameOf = new Map(held.map(e => [e.id, e.name]));

    const leaderId = this._aim?.leaderId ?? null;

    const cards = held.map(e => {
      const carried = e.bearerId ? nameOf.get(e.bearerId) : null;
      const isLeader = e.id === leaderId;
      return `<div class="ace-party-card ${e.bearerId ? "ace-party-card-carried" : ""} ${isLeader ? "ace-party-card-leader" : ""}"
                   data-id="${esc(e.id)}" draggable="${e.bearerId ? "false" : "true"}"
                   title="${esc(e.name)}${carried ? ` — carried by ${esc(carried)}` : ""}${isLeader ? " — lands on the crosshair" : ""}">
        <img src="${esc(e.img)}" alt="">
        ${isLeader ? `<span class="ace-party-leader-pip" title="Lands on the crosshair"><i class="fa-solid fa-crosshairs"></i></span>` : ""}
        <span class="ace-party-card-name">${esc(e.name)}</span>
        ${carried ? `<span class="ace-party-card-carry"><i class="fa-solid fa-person-carry-box"></i> ${esc(carried)}</span>` : ""}
      </div>`;
    }).join("");

    const canReveal = this._lastPlaced.length > 0;

    // The armed banner sits ABOVE everything, so there is never a doubt that a
    // click on the map is about to put creatures down.
    const armed = this._aim
      ? `<div class="ace-party-armed">
           <i class="fa-solid fa-crosshairs"></i>
           <span>ON THE CROSSHAIR: <strong>${esc(nameOf.get(leaderId) ?? "leader")}</strong></span>
           <span class="ace-party-armed-sub">Click the map to place &middot; <strong>Esc</strong> to cancel</span>
         </div>`
      : "";

    return `<div class="ace-party-container">
      ${armed}
      <h2 class="ace-party-title">SELECT WHICH TOKENS</h2>
      <p class="ace-party-from">From <strong>${esc(hand.originSceneName || "elsewhere")}</strong> — ${held.length} held</p>
      <p class="ace-party-hint"><strong>The first one you click is the leader</strong> — they land on the crosshair,
        the rest form around them. Shift-click to add more. Carried creatures follow their bearer.</p>
      <div class="ace-party-grid">${cards}</div>
      <div class="ace-party-actions">
        <button type="button" data-act="place-selected"><i class="fa-solid fa-hand-pointer"></i> Place Selected</button>
        <button type="button" data-act="place-all"><i class="fa-solid fa-users"></i> Place All</button>
        <button type="button" data-act="reveal" ${canReveal ? "" : "disabled"}
                title="Hostiles land hidden so you can set up an ambush — this springs it."><i class="fa-solid fa-eye"></i> Reveal Placed</button>
        <button type="button" data-act="undo" class="ace-party-danger"><i class="fa-solid fa-rotate-left"></i> Undo Transfer</button>
      </div>
    </div>`;
  }

  static _wireContainer(root) {
    if (!root) return;
    // ⚠️ Selection lives on the CLASS, not in this closure. Arming the crosshair
    // re-renders the panel, which rebuilds this element and would otherwise
    // silently drop everything the GM had just picked.
    const selected = this._selected;
    // Drop anything that has since been placed.
    const live = new Set(this.held().map(e => e.id));
    for (const id of Array.from(selected)) if (!live.has(id)) selected.delete(id);

    const cards = () => Array.from(root.querySelectorAll(".ace-party-card"));
    const syncSel = () => {
      for (const c of cards()) c.classList.toggle("ace-party-selected", selected.has(c.dataset.id));
    };

    // Moving off the panel with a selection arms the crosshair. No extra click,
    // no mode button — picking who to place and aiming where are one gesture.
    const armIfSelected = () => {
      if (!selected.size || this._aim) return;
      this.beginAim(Array.from(selected));
    };
    // ⚠️ WIRE ONCE. ApplicationV2 reuses this element and only replaces its
    // innerHTML, so listeners added here SURVIVE a re-render — adding them again
    // stacks a second copy. Two click handlers means a card gets selected by the
    // first and immediately deselected by the second, and nothing highlights
    // ever again after the first placement. Delegation from the persistent
    // element is what makes wiring once correct.
    if (root.__aceWired) { syncSel(); return; }
    root.__aceWired = true;

    root.addEventListener("mouseleave", armIfSelected);
    root.closest?.(".application")?.addEventListener?.("mouseleave", armIfSelected);

    root.addEventListener("click", async (ev) => {
      const card = ev.target?.closest?.(".ace-party-card");
      if (card) {
        const id = card.dataset.id;
        if (ev.shiftKey) selected.has(id) ? selected.delete(id) : selected.add(id);
        else { const only = !selected.has(id) || selected.size > 1; selected.clear(); if (only) selected.add(id); }
        this.cancelAim(true);   // selection changed — re-aim from scratch
        syncSel();
        return;
      }

      const btn = ev.target?.closest?.("button[data-act]");
      if (!btn) return;
      ev.preventDefault();

      switch (btn.dataset.act) {
        case "place-selected": {
          const ids = selected.size ? Array.from(selected) : [];
          if (!ids.length) return void ui.notifications?.warn("ACE — Click a creature in the container first.");
          this.beginAim(ids);
          ui.notifications?.info("ACE — Move onto the map and click to place. Escape cancels.");
          break;
        }
        case "place-all":
          for (const e of this.held()) selected.add(e.id);
          syncSel();
          this.beginAim(this.held().map(e => e.id));
          ui.notifications?.info("ACE — Move onto the map and click to place the party. Escape cancels.");
          break;
        case "reveal":
          await this.revealPlaced();
          break;
        case "undo":
          await this.undoTransfer();
          break;
      }
    });

    root.addEventListener("dragstart", (ev) => {
      const card = ev.target?.closest?.(".ace-party-card");
      if (!card) return;
      this.cancelAim(true);   // a drag and a crosshair must never both be live
      const id = card.dataset.id;
      const ids = selected.has(id) && selected.size > 1 ? Array.from(selected) : [id];
      _dragPayload = ids;
      try {
        ev.dataTransfer.effectAllowed = "move";
        // Foundry's board handler parses dataTransfer; give it something inert.
        ev.dataTransfer.setData("text/plain", "ace-party-place");
      } catch (_) { /* some browsers restrict this */ }
    });

    // ⚠️ NO dragend listener on `root` — this element is destroyed and replaced
    // every time the Hand changes (see _replaceHTML). A listener bound here dies
    // with it, the payload is never cleared, and from then on EVERY html5 drop on
    // the canvas gets hijacked by our handler. The clear-down lives on `document`
    // in _installCanvasDrop, which survives re-renders.
    syncSel();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  AIMING — the crosshair
  //
  //  Select in the panel, move onto the canvas, and a crosshair shows exactly
  //  where everyone lands before you commit to it. The LEADER sits under the
  //  crosshair; the rest form around them. Click places. Escape puts everything
  //  back in the panel — nothing is ever placed by accident.
  //
  //  Gridded maps snap to the square. Gridless maps drop free at the point,
  //  spaced by the scene's own distance unit — not every map has squares.
  // ═══════════════════════════════════════════════════════════════════════════

  static _gridless() {
    try { return canvas.grid?.type === CONST.GRID_TYPES.GRIDLESS; }
    catch (_) { return false; }
  }

  static beginAim(ids) {
    const held = this.held();
    // ⚠️ Preserve the ORDER THEY WERE CLICKED IN — filtering the hand would
    // silently re-sort it and make the leader look arbitrary. The panel's
    // selection is a Set, and Sets keep insertion order, so ids[0] is genuinely
    // the first card the GM clicked.
    const byId = new Map(held.map(e => [e.id, e]));
    const wanted = ids.map(id => byId.get(id)).filter(Boolean);
    if (!wanted.length) return;
    this._aim = { ids: wanted.map(e => e.id), leaderId: wanted[0].id, point: null };
    this._installAimHandlers();
    this._paintCursor(true);
    try { this._container?.render({ force: false }); } catch (_) { /* fine */ }
  }

  static cancelAim(quiet = false) {
    if (!this._aim) return;
    this._aim = null;
    this._clearAimLayer();
    this._paintCursor(false);
    if (!quiet) ui.notifications?.info("ACE — Placement cancelled. Still in hand.");
    try { if (this._container?.rendered) this._container.render({ force: false }); } catch (_) { /* fine */ }
  }

  static _paintCursor(on) {
    try { document.getElementById("board")?.classList?.toggle("ace-party-aiming", !!on); }
    catch (_) { /* cosmetic only */ }
  }

  static _aimLayer() {
    try {
      const host = canvas.controls ?? canvas.stage;
      // ⚠️ Check the layer is attached to the CURRENT canvas, not merely that it
      // has some parent. After a scene change the old parent still reads as set
      // but is torn down, and the crosshair silently draws into nothing.
      if (this._layer && !this._layer.destroyed && this._layer.parent === host) return this._layer;
      try { this._layer?.destroy({ children: true }); } catch (_) { /* already gone */ }
      this._layer = null;
      const layer = new PIXI.Container();
      layer.eventMode = "none";           // never steal a canvas interaction
      layer.interactiveChildren = false;
      layer.zIndex = 10000;
      (canvas.controls ?? canvas.stage).addChild(layer);
      this._layer = layer;
      return layer;
    } catch (err) {
      console.warn(`${MODULE_ID} | Party Transfer — could not build the aim layer:`, err);
      return null;
    }
  }

  static _clearAimLayer() {
    try {
      const l = this._layer;
      if (!l) return;
      l.removeChildren().forEach(c => { try { c.destroy({ children: true }); } catch (_) { /* already gone */ } });
    } catch (_) { /* nothing to clear */ }
  }

  /** Where would everyone land if we committed right now? */
  static _aimPreview(point) {
    const aim = this._aim;
    if (!aim) return [];
    const held = this.held();
    const wanted = new Set(aim.ids);
    for (const e of held) if (e.bearerId && wanted.has(e.bearerId)) wanted.add(e.id);
    for (const e of held) if (e.bearerId && wanted.has(e.id)) wanted.add(e.bearerId);

    const entries = held.filter(e => wanted.has(e.id));
    entries.sort((a, b) => {
      if (a.id === aim.leaderId) return -1;
      if (b.id === aim.leaderId) return 1;
      return (a.bearerId ? 1 : 0) - (b.bearerId ? 1 : 0);
    });

    const taken = this._occupiedSquares(canvas.scene);
    const pts = this._landingPoints(entries, point, taken, aim.leaderId);
    return entries.map((e, i) => ({ entry: e, pt: pts[i] }));
  }

  static _drawAim(point) {
    const layer = this._aimLayer();
    if (!layer) return;
    this._clearAimLayer();

    const g = Number(canvas.grid?.size) || 100;
    const gridless = this._gridless();
    const preview = this._aimPreview(point);

    const gfx = new PIXI.Graphics();

    // Ghost footprints — where each creature actually lands.
    for (const { entry, pt } of preview) {
      const isLeader = entry.id === this._aim?.leaderId;
      const w = Math.max(1, Number(entry.tokenData?.width) || 1) * g;
      const h = Math.max(1, Number(entry.tokenData?.height) || 1) * g;
      gfx.beginFill(isLeader ? 0xf0d98a : 0x6fc36f, isLeader ? 0.3 : 0.2);
      gfx.lineStyle(isLeader ? 3 : 2, isLeader ? 0xf0d98a : 0x6fc36f, 0.95);
      if (gridless) gfx.drawCircle(pt.x + w / 2, pt.y + h / 2, Math.max(w, h) / 2);
      else gfx.drawRoundedRect(pt.x + 2, pt.y + 2, w - 4, h - 4, 6);
      gfx.endFill();
    }

    // The crosshair itself, dead centre on the leader's square.
    const lead = preview[0]?.pt ?? this._snap(point.x - g / 2, point.y - g / 2);
    const cx = lead.x + g / 2, cy = lead.y + g / 2;
    const arm = g * 0.75;
    gfx.lineStyle(3, 0x000000, 0.55);
    gfx.moveTo(cx - arm, cy).lineTo(cx + arm, cy).moveTo(cx, cy - arm).lineTo(cx, cy + arm);
    gfx.lineStyle(2, 0xf0d98a, 1);
    gfx.moveTo(cx - arm, cy).lineTo(cx + arm, cy).moveTo(cx, cy - arm).lineTo(cx, cy + arm);
    gfx.drawCircle(cx, cy, g * 0.22);
    layer.addChild(gfx);

    // Name each ghost so a 9-creature drop is readable before you commit.
    const size = Math.max(12, Math.round(g * 0.22));
    for (const { entry, pt } of preview) {
      try {
        const isLeader = entry.id === this._aim?.leaderId;
        const label = new PIXI.Text(isLeader ? `◆ ${entry.name}` : entry.name, {
          fontFamily: "Signika, sans-serif", fontSize: size,
          fill: isLeader ? 0xffe9a8 : 0xffffff,
          stroke: 0x000000, strokeThickness: 4, align: "center",
        });
        label.anchor.set(0.5, 1);
        label.position.set(pt.x + g / 2, pt.y - 2);
        layer.addChild(label);
      } catch (_) { /* a missing font must never break placement */ }
    }
  }

  static _installAimHandlers() {
    if (this._aimInstalled) return;
    this._aimInstalled = true;

    const onBoard = (ev) => {
      const board = document.getElementById("board");
      return !!board && (ev.target === board || board.contains(ev.target));
    };

    document.addEventListener("pointermove", (ev) => {
      if (!this._aim) return;
      if (!onBoard(ev)) { this._clearAimLayer(); this._aim.point = null; return; }
      const p = this._clientToCanvas(ev.clientX, ev.clientY);
      this._aim.point = p;
      this._drawAim(p);
    }, true);

    // Commit on left click. Capture phase + stop so the canvas doesn't also
    // treat this as a deselect-everything click.
    document.addEventListener("pointerdown", (ev) => {
      if (!this._aim || !onBoard(ev)) return;
      if (ev.button === 2) { ev.preventDefault(); ev.stopPropagation(); this.cancelAim(); return; }
      if (ev.button !== 0) return;
      ev.preventDefault();
      ev.stopPropagation();
      const p = this._clientToCanvas(ev.clientX, ev.clientY);
      const ids = this._aim.ids.slice();
      const leaderId = this._aim.leaderId;
      this.cancelAim(true);
      this._placeAt(ids, p, leaderId).catch(err =>
        console.error(`${MODULE_ID} | Party Transfer — placement failed:`, err));
    }, true);

    document.addEventListener("keydown", (ev) => {
      if (!this._aim || ev.key !== "Escape") return;
      ev.preventDefault();
      ev.stopPropagation();
      this.cancelAim();
    }, true);

    // Never leave a crosshair armed across a scene change or a closed panel.
    Hooks.on("canvasReady", () => this.cancelAim(true));
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Canvas drop — drag out of the container onto the map
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Is our drag genuinely live right now?
   *
   * ⚠️ A stale payload is CATASTROPHIC, not cosmetic: this handler runs in the
   * capture phase and calls stopPropagation, so while it thinks a drag is in
   * flight it EATS every html5 drop on the canvas — including dragging an actor
   * out of the sidebar — and places Hand creatures instead. That is how "I moved
   * a token and got another copy of him" happens. Three independent guards:
   * the container must be open, the Hand must be non-empty, and the payload
   * must be fresh.
   */
  static _dragIsLive() {
    if (!_dragPayload) return false;
    if (!this._container?.rendered) { _dragPayload = null; return false; }
    if (!this.count()) { _dragPayload = null; return false; }
    return true;
  }

  static _installCanvasDrop() {
    if (this._dropInstalled) return;
    this._dropInstalled = true;

    // Clear-down lives on `document` so it survives the container re-rendering
    // mid-drag. dragend fires whether the drop landed, missed, or was cancelled.
    document.addEventListener("dragend", () => { _dragPayload = null; }, true);

    document.addEventListener("dragover", (ev) => {
      if (!this._dragIsLive()) return;
      ev.preventDefault();
      try { ev.dataTransfer.dropEffect = "move"; } catch (_) { /* optional */ }
    }, true);

    document.addEventListener("drop", (ev) => {
      if (!this._dragIsLive()) return;

      // Whatever happens next, this drag is over. Clearing BEFORE the board
      // test is the point — a drop that misses the map must still disarm us.
      const ids = _dragPayload;
      _dragPayload = null;

      const board = document.getElementById("board");
      if (!board || !(ev.target === board || board.contains(ev.target))) return;

      // Capture phase + stopPropagation so Foundry's own drop handler never
      // sees a payload it would try to read as a document.
      ev.preventDefault();
      ev.stopPropagation();

      const point = this._clientToCanvas(ev.clientX, ev.clientY);
      this._placeAt(ids, point).catch(err =>
        console.error(`${MODULE_ID} | Party Transfer — drop placement failed:`, err));
    }, true);
  }

  static _clientToCanvas(clientX, clientY) {
    try {
      const p = canvas.canvasCoordinatesFromClient?.({ x: clientX, y: clientY });
      if (p && Number.isFinite(p.x)) return p;
    } catch (_) { /* fall through to manual maths */ }
    const t = canvas.stage?.worldTransform;
    const s = canvas.stage?.scale;
    if (!t || !s) return { x: 0, y: 0 };
    return { x: (clientX - t.tx) / s.x, y: (clientY - t.ty) / s.y };
  }

  static _viewCentre() {
    const c = canvas.stage?.pivot;
    if (c && Number.isFinite(c.x)) return { x: c.x, y: c.y };
    const d = canvas.dimensions;
    return { x: (d?.width ?? 1000) / 2, y: (d?.height ?? 1000) / 2 };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Landing
  // ═══════════════════════════════════════════════════════════════════════════

  static _snap(x, y) {
    try {
      const p = canvas.grid?.getTopLeftPoint?.({ x, y });
      if (p && Number.isFinite(p.x)) return { x: p.x, y: p.y };
    } catch (_) { /* gridless or older API */ }
    const g = Number(canvas.grid?.size) || 100;
    return { x: Math.floor(x / g) * g, y: Math.floor(y / g) * g };
  }

  /** Grid offsets spiralling out from the drop point, so nobody stacks. */
  static _spiralOffsets(limit) {
    const out = [[0, 0]];
    for (let r = 1; out.length < limit && r < 20; r++) {
      for (let dx = -r; dx <= r; dx++) {
        for (let dy = -r; dy <= r; dy++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          out.push([dx, dy]);
          if (out.length >= limit) break;
        }
        if (out.length >= limit) break;
      }
    }
    return out;
  }

  /**
   * Mark every square a token of this size standing at (x,y) covers.
   *
   * ⚠️ Reading only the top-left square is wrong and it shows: a Huge creature
   * covers nine squares but would claim one, so the next arrival lands INSIDE
   * him. That is how a small token ends up underneath a large one.
   */
  static _markFootprint(taken, x, y, w = 1, h = 1) {
    const g = Number(canvas.grid?.size) || 100;
    const cols = Math.max(1, Math.ceil(Number(w) || 1));
    const rows = Math.max(1, Math.ceil(Number(h) || 1));
    for (let i = 0; i < cols; i++) {
      for (let j = 0; j < rows; j++) {
        taken.add(`${Math.round(x + i * g)},${Math.round(y + j * g)}`);
      }
    }
  }

  /** Is every square this footprint needs currently free? */
  static _footprintFree(taken, x, y, w = 1, h = 1) {
    const g = Number(canvas.grid?.size) || 100;
    const cols = Math.max(1, Math.ceil(Number(w) || 1));
    const rows = Math.max(1, Math.ceil(Number(h) || 1));
    for (let i = 0; i < cols; i++) {
      for (let j = 0; j < rows; j++) {
        if (taken.has(`${Math.round(x + i * g)},${Math.round(y + j * g)}`)) return false;
      }
    }
    return true;
  }

  /** The squares already spoken for on this scene, as a mutable claim set. */
  static _occupiedSquares(scene) {
    const taken = new Set();
    for (const t of (scene?.tokens ?? [])) {
      const s = this._snap(Number(t.x) || 0, Number(t.y) || 0);
      this._markFootprint(taken, s.x, s.y, t.width, t.height);
    }
    return taken;
  }

  /**
   * Can you actually walk from `from` to `to` without crossing a wall?
   *
   * ⚠️ Without this the landing spiral steps straight THROUGH walls looking for
   * an empty square and drops people outside the room, in the black. Fails OPEN
   * (returns true) if the collision API isn't where we expect — a geometry
   * check that throws must never block a placement.
   */
  static _wallBlocked(from, to) {
    try {
      // ⚠️ V13 signature is checkCollision(DESTINATION, {origin, type, mode}) —
      // NOT checkCollision(ray, {...}). And `Ray` is no longer a global; it moved
      // to foundry.canvas.geometry.Ray. Building one the old way threw a
      // ReferenceError that this function's own catch swallowed, so it silently
      // reported "no wall" for every single test and creatures landed inside
      // walls and doorways. Never let a geometry helper fail open in silence.
      const walls = canvas?.walls;
      if (typeof walls?.checkCollision !== "function") {
        this._warnNoWallApi();
        return false;
      }
      return !!walls.checkCollision(
        { x: to.x, y: to.y },
        { origin: { x: from.x, y: from.y }, type: "move", mode: "any" }
      );
    } catch (err) {
      this._warnNoWallApi(err);
      return false;
    }
  }

  /** Say it ONCE, loudly. A silent wall check is worse than none. */
  static _warnNoWallApi(err) {
    if (this._wallWarned) return;
    this._wallWarned = true;
    console.error(`${MODULE_ID} | Party Transfer — WALL CHECKING IS OFF: canvas.walls.checkCollision is unavailable or threw. Creatures may land through walls.`, err ?? "");
    ui.notifications?.warn("ACE — Wall checking is unavailable; placement can't avoid walls. Check the console.");
  }

  /**
   * Claim the first free square at or near `want`, walking outward. Mutates
   * `taken`, so every caller in a placement batch stays out of everyone
   * else's way — including creatures placed later in the same batch.
   *
   * `origin` is where the GM actually dropped. Candidate squares that would put
   * a creature through a wall from there are skipped, so a party dropped inside
   * a room stays inside it.
   */
  /**
   * Find this creature a square.
   *
   * ⚠️ THE RULE (Johnny, 2026-08-06): a wall is NEVER crossed. If the room is
   * too small, people stand shoulder to shoulder — stacked on the same square —
   * rather than one of them being flung through a wall into the next room with
   * whatever is waiting in there. Crowding is a nuisance you fix by opening a
   * door; a lone party member on the wrong side of a wall is a disaster.
   *
   * So: wall-blocked is a HARD refusal, and already-occupied is the acceptable
   * fallback — the exact opposite of the first implementation.
   */
  static _claimSquare(want, taken, origin = null, w = 1, h = 1) {
    const g = Number(canvas.grid?.size) || 100;
    // Aim the wall test at the middle of THIS creature's footprint, so a big
    // token isn't judged by a corner that happens to sit the wrong side of a wall.
    const cx = (Math.max(1, Number(w) || 1) * g) / 2;
    const cy = (Math.max(1, Number(h) || 1) * g) / 2;
    let stackHere = null;   // nearest reachable square, even though it's occupied

    for (const [dx, dy] of this._spiralOffsets(400)) {
      const x = want.x + dx * g, y = want.y + dy * g;
      if (!this._inBounds(x + cx, y + cy)) continue;
      // A wall between the drop point and this square disqualifies it outright.
      if (origin && this._wallBlocked(origin, { x: x + cx, y: y + cy })) continue;

      if (!this._footprintFree(taken, x, y, w, h)) {
        // Reachable but taken — remember the closest one to stack on.
        if (!stackHere) stackHere = { x, y };
        continue;
      }
      this._markFootprint(taken, x, y, w, h);
      return { x, y };
    }

    // Room is full. Stand them shoulder to shoulder on the nearest reachable
    // square rather than pushing anyone through a wall.
    if (stackHere) {
      this._crowded++;
      return { x: stackHere.x, y: stackHere.y };
    }

    // Degenerate: nothing on this side of the wall is reachable at all — the
    // drop landed inside solid geometry. Put them on the point itself and say so.
    this._crowded++;
    return want;
  }

  /**
   * Work out where each creature wants to land. With formation memory on the
   * group keeps its relative arrangement — marching order survives the door.
   *
   * ⚠️ `taken` is threaded through rather than rebuilt here: a burden is
   * seated next to its bearer AFTER this runs, and the two must not fight
   * over the same square.
   */
  /** Is this point inside the playable area of the scene? */
  static _inBounds(x, y) {
    const r = canvas.dimensions?.sceneRect ?? canvas.dimensions?.rect;
    if (!r || !Number.isFinite(r.x)) return true;   // unknown bounds → don't block
    return x >= r.x && y >= r.y && x <= (r.x + r.width) && y <= (r.y + r.height);
  }

  static _landingPoints(entries, centre, taken, leaderId = null) {
    const g = Number(canvas.grid?.size) || 100;
    const anchor = this._snap(centre.x - g / 2, centre.y - g / 2);
    const leader = entries.find(e => e.id === leaderId) ?? entries[0];
    let wanted;

    // Formation memory means MARCHING ORDER, not "reproduce a sprawl". A party
    // scattered over half a battlefield would otherwise arrive scattered over
    // half the new one — or off the edge of it. Past a sane span, close up.
    let useFormation = game.settings.get(MODULE_ID, "partyTransferFormation") && entries.length > 1;
    const FORMATION_MAX_SQUARES = 12;
    if (useFormation) {
      const xs = entries.map(e => Number(e.originX) || 0);
      const ys = entries.map(e => Number(e.originY) || 0);
      const spanX = (Math.max(...xs) - Math.min(...xs)) / g;
      const spanY = (Math.max(...ys) - Math.min(...ys)) / g;
      if (spanX > FORMATION_MAX_SQUARES || spanY > FORMATION_MAX_SQUARES) {
        useFormation = false;
        console.debug(`${MODULE_ID} | Party Transfer — original spread was ${Math.round(spanX)}×${Math.round(spanY)} squares; closing the group up instead of reproducing it.`);
      }
    }

    if (useFormation) {
      // Anchor the formation on the LEADER, not on the top-left of the group —
      // the crosshair is a promise about where one specific creature lands, and
      // everyone else arranges around them.
      const lx = Number(leader?.originX) || 0;
      const ly = Number(leader?.originY) || 0;
      wanted = entries.map(e => ({
        x: anchor.x + Math.round(((Number(e.originX) || 0) - lx) / g) * g,
        y: anchor.y + Math.round(((Number(e.originY) || 0) - ly) / g) * g,
      }));
    } else {
      const offs = this._spiralOffsets(entries.length);
      wanted = entries.map((_e, i) => ({
        x: anchor.x + (offs[i]?.[0] ?? 0) * g,
        y: anchor.y + (offs[i]?.[1] ?? 0) * g,
      }));
    }

    return wanted.map((w, i) => this._claimSquare(
      w, taken, centre,
      entries[i]?.tokenData?.width  ?? 1,
      entries[i]?.tokenData?.height ?? 1
    ));
  }

  static async _placeAt(ids, centre, leaderId = null) {
    const scene = canvas.scene;
    if (!scene) return void ui.notifications?.warn("ACE — No scene is active.");

    // Missing the map is a mis-drop, not an instruction. Keep them in hand.
    if (!this._inBounds(centre.x, centre.y)) {
      return void ui.notifications?.warn("ACE — That's off the edge of the map. Nothing was placed; they're still in hand.");
    }

    // ⚠️ Re-entrancy lock. Two overlapping calls each read the Hand before
    // either has written it back, so both see the same entries and both create
    // them — a guaranteed duplicate from one stray double-click.
    if (this._placing) {
      console.warn(`${MODULE_ID} | Party Transfer — placement already in progress; ignoring the second request.`);
      return;
    }
    this._placing = true;
    try {
      return await this._placeAtInner(ids, centre, scene, leaderId);
    } finally {
      this._placing = false;
    }
  }

  static async _placeAtInner(ids, centre, scene, leaderId = null) {

    const hand = this.hand();
    const pending = hand.entries.filter(e => !e.placed);
    const wanted = new Set(ids);

    // A bearer and its burden are ONE unit and are never separable — grabbing
    // either end brings the other. Pull in both directions.
    for (const e of pending) if (e.bearerId && wanted.has(e.bearerId)) wanted.add(e.id);
    for (const e of pending) if (e.bearerId && wanted.has(e.id)) wanted.add(e.bearerId);

    const entries = pending.filter(e => wanted.has(e.id));
    if (!entries.length) return;

    // Leader first — they land on the crosshair and everyone forms around them.
    // Burdens last, so each can be seated beside a bearer already down.
    entries.sort((a, b) => {
      if (a.id === leaderId) return -1;
      if (b.id === leaderId) return 1;
      return (a.bearerId ? 1 : 0) - (b.bearerId ? 1 : 0);
    });

    const removeCopies = game.settings.get(MODULE_ID, "partyTransferRemoveCopies");
    const keepIds      = game.settings.get(MODULE_ID, "partyTransferKeepIds");
    const hideHostiles = game.settings.get(MODULE_ID, "partyTransferHostilesHidden");

    // Clear stale copies BEFORE measuring the map, so the arriving party
    // doesn't arrange itself around ghosts that are about to vanish.
    if (removeCopies) for (const e of entries) await this._removeExistingCopies(scene, e);

    this._crowded = 0;
    const taken  = this._occupiedSquares(scene);
    const points = this._landingPoints(entries, centre, taken, leaderId);

    const created = [];
    const placedIds = [];
    const landedAt = new Map();

    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      let pt = points[i];

      // A carried creature is set down beside whoever brought it. Same claim
      // set, so it can never land on top of its own bearer.
      if (e.bearerId && landedAt.has(e.bearerId)) {
        const g = Number(canvas.grid?.size) || 100;
        const b = landedAt.get(e.bearerId);
        // Search out from the BEARER, not the drop point — a burden set down
        // beside its carrier must end up on the carrier's side of any wall.
        pt = this._claimSquare({ x: b.x + g, y: b.y }, taken, { x: b.x + g / 2, y: b.y + g / 2 },
          e.tokenData?.width ?? 1, e.tokenData?.height ?? 1);
      }

      const data = foundry.utils.deepClone(e.tokenData);
      data.x = pt.x;
      data.y = pt.y;
      if (!keepIds) delete data._id;

      // Everyone arrives facing the same way. Whatever they happened to be
      // looking at on the last map is meaningless here, and a group that is
      // already uniform can be turned to face a threat in one drag.
      data.rotation = 0;

      // Visibility: never override a creature that was already hidden.
      if (!e.wasHidden) {
        data.hidden = hideHostiles && (e.disposition === -1 || e.disposition === -2);
      }

      created.push(data);
      placedIds.push(e.id);
      landedAt.set(e.id, pt);
    }

    // ⚠️ NEVER retry a failed batch create. The old code caught the error and
    // re-created the whole batch without ids — but a create that throws AFTER
    // partly succeeding (a downstream createToken hook, of which this suite has
    // nine) leaves those tokens on the map, and the retry made a second copy of
    // every one. Instead: remove the only thing that can legitimately fail
    // up-front — an id already present on this scene — then create exactly once.
    if (keepIds) {
      for (const d of created) {
        if (d._id && scene.tokens.has(d._id)) {
          console.warn(`${MODULE_ID} | Party Transfer — id ${d._id} is already on "${scene.name}"; landing "${d.name}" with a fresh id.`);
          delete d._id;
        }
      }
    }

    let madeDocs = [];
    try {
      madeDocs = await scene.createEmbeddedDocuments("Token", created, { keepId: keepIds });
    } catch (err) {
      console.error(`${MODULE_ID} | Party Transfer — placement FAILED:`, err);
      ui.notifications?.error("ACE — Could not place those creatures. Check the console; they are still in hand and nothing was lost.");
      return;
    }

    // Only now that they are genuinely on the map do they leave the Hand.
    const next = foundry.utils.deepClone(hand);
    for (const e of next.entries) {
      if (!placedIds.includes(e.id)) continue;
      e.placed = true;
      await this._deleteTransitActor(e.transitActorId);
    }
    next.entries = next.entries.filter(e => !e.placed);
    await this._setHand(next);

    this._lastPlaced = (madeDocs ?? []).map(d => d.id).filter(Boolean);
    await this._followCombat(scene, this._lastPlaced);
    this._selectPlaced(this._lastPlaced);

    ui.notifications?.info(`ACE — Placed ${placedIds.length} creature${placedIds.length === 1 ? "" : "s"} on "${scene.name}".`);
    if (this._crowded) {
      // Say it out loud. Silently stacking people is how a GM loses track of
      // where somebody actually is.
      ui.notifications?.warn(
        `ACE — Tight fit: ${this._crowded} creature${this._crowded === 1 ? " is" : "s are"} standing on an occupied square. ` +
        `Nobody was pushed through a wall — spread them out when you have room.`
      );
    }
    if (!this.count()) {
      this._closeContainer();
      ui.notifications?.info("ACE — Hands empty. Everyone is where they should be.");
    }
    this._refreshIndicator();
  }

  /**
   * Clear any copy of this creature already standing on the destination.
   *
   * ⚠️ Linked and unlinked are NOT symmetric. A linked actor means one actor,
   * one token — removing every token of that actor is correct. Unlinked tokens
   * SHARE an actor (twelve goblins, one goblin sheet), so matching on actor
   * would delete eleven innocent goblins. Unlinked matches on token id only,
   * which is exactly the case we care about: a copy WE placed here before.
   */
  static async _removeExistingCopies(scene, entry) {
    try {
      let doomed;
      if (entry.actorLink && entry.actorId) {
        doomed = scene.tokens.filter(t => t.actorId === entry.actorId).map(t => t.id);
      } else {
        // Match the token id OR our own stamped transfer key. The key is what
        // makes this survive a landing that had to mint a fresh id — without it
        // the copy goes unfound and you end up with two of the same creature.
        doomed = scene.tokens.filter(t =>
          t.id === entry.id ||
          t.flags?.[MODULE_ID]?.transferKey === entry.id
        ).map(t => t.id);
      }
      if (!doomed.length) return;
      await scene.deleteEmbeddedDocuments("Token", doomed);
      console.debug(`${MODULE_ID} | Party Transfer — cleared ${doomed.length} existing copy/copies of "${entry.name}" from "${scene.name}"`);
    } catch (err) {
      console.warn(`${MODULE_ID} | Party Transfer — could not clear existing copies of "${entry.name}":`, err);
    }
  }

  /**
   * A fight should follow the party through the door. If a combat is running
   * and every one of its combatants now resolves on THIS scene, move the
   * combat here. Without this the turn marker silently stops advancing —
   * exactly the bug that started this whole feature.
   */
  static async _followCombat(scene, placedTokenIds) {
    try {
      if (!game.settings.get(MODULE_ID, "partyTransferFollowCombat")) return;
      if (!placedTokenIds?.length) return;

      // Find the combat by the creatures we just moved — never by guessing
      // which encounter is "the" active one.
      const placed = new Set(placedTokenIds);
      const combat = (game.combats?.contents ?? []).find(c =>
        (c.started || c.active) &&
        (c.combatants?.contents ?? []).some(cb => placed.has(cb.tokenId)));
      if (!combat || combat.scene?.id === scene.id) return;

      const combatants = combat.combatants?.contents ?? [];
      if (!combatants.length) return;

      const allHere = combatants.every(c => !c.tokenId || scene.tokens.has(c.tokenId));
      if (!allHere) {
        const missing = combatants.filter(c => c.tokenId && !scene.tokens.has(c.tokenId)).length;
        ui.notifications?.warn(
          `ACE — The running combat still has ${missing} combatant${missing === 1 ? "" : "s"} on another scene, ` +
          `so it has been left where it is. Bring everyone across and the fight will follow.`
        );
        return;
      }

      await combat.update({ scene: scene.id });
      ui.notifications?.info(`ACE — The combat moved to "${scene.name}" with the party.`);
    } catch (err) {
      console.warn(`${MODULE_ID} | Party Transfer — combat follow failed (non-fatal):`, err);
    }
  }

  /**
   * Leave the group selected on arrival, so the very next thing you can do is
   * drag-rotate the whole party to face wherever they're looking.
   *
   * The placeables may not be drawn the instant the documents resolve, so this
   * retries briefly rather than silently selecting nothing.
   */
  static _selectPlaced(ids, attempt = 0) {
    try {
      if (!ids?.length || !canvas?.tokens) return;
      const objs = ids.map(id => canvas.tokens.get(id)).filter(Boolean);
      if (!objs.length && attempt < 10) {
        setTimeout(() => this._selectPlaced(ids, attempt + 1), 60);
        return;
      }
      canvas.tokens.releaseAll();
      for (const t of objs) {
        try { t.control({ releaseOthers: false }); } catch (_) { /* not controllable */ }
      }
    } catch (err) {
      console.warn(`${MODULE_ID} | Party Transfer — could not select the arrivals (non-fatal):`, err);
    }
  }

  static async revealPlaced() {
    const ids = this._lastPlaced ?? [];
    if (!ids.length) return void ui.notifications?.info("ACE — Nothing recently placed to reveal.");
    const scene = canvas.scene;
    const updates = ids
      .filter(id => scene?.tokens?.get(id)?.hidden)
      .map(id => ({ _id: id, hidden: false }));
    if (!updates.length) return void ui.notifications?.info("ACE — Those are already visible.");
    await scene.updateEmbeddedDocuments("Token", updates);
    ui.notifications?.info(`ACE — Revealed ${updates.length} creature${updates.length === 1 ? "" : "s"}.`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  The Hand indicator — a persistent reminder that you are carrying something
  // ═══════════════════════════════════════════════════════════════════════════

  static _refreshIndicator() {
    try {
      if (!game.user?.isGM) return;
      const n = this.count();
      let el = document.getElementById("ace-party-hand-pill");

      if (!n) { el?.remove(); return; }

      if (!el) {
        this._injectCSS();
        el = document.createElement("div");
        el.id = "ace-party-hand-pill";
        el.title = "Open the container and place these creatures";
        el.addEventListener("click", () => PartyTransfer.openPlace());
        document.body.appendChild(el);
      }
      el.innerHTML = `<i class="fa-solid fa-hand-holding-hand"></i> <span>${n} in hand</span>`;
    } catch (err) {
      console.warn(`${MODULE_ID} | Party Transfer indicator failed:`, err);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Styling
  // ═══════════════════════════════════════════════════════════════════════════

  static _injectCSS() {
    if (document.getElementById("ace-party-transfer-css")) return;
    const style = document.createElement("style");
    style.id = "ace-party-transfer-css";
    style.textContent = `
/* ── ACE Party Transfer ─────────────────────────────────────────────────────
   Foundry's dialog body is LIGHT parchment, so every ACE panel that pops over
   it wraps itself in a dark container and uses light text inside that. Body
   text stays at 16px minimum — this sits on top of Foundry's chrome. */
.ace-party-transfer, .ace-party-container, .ace-party-warn {
  background: linear-gradient(160deg, #14140f 0%, #0c0c09 100%);
  border: 1px solid #6b5a24; border-radius: 6px;
  padding: 12px; color: #efe6cf;
  font-size: 16px; line-height: 1.45;
}
.ace-party-warn p { margin: 0 0 8px; }
.ace-party-warn p:last-child { margin-bottom: 0; }
.ace-party-lede { margin: 0 0 10px; font-size: 15px; color: #cdbf9a; }
.ace-party-lede strong { color: #f0d98a; }

.ace-party-bulkbar {
  display: flex; flex-wrap: wrap; gap: 6px; align-items: center;
  padding: 8px; margin-bottom: 10px;
  background: rgba(0,0,0,.35); border: 1px solid #3a3324; border-radius: 4px;
}
.ace-party-bulklabel { font-size: 14px; color: #a89a75; text-transform: uppercase; letter-spacing: .05em; }
.ace-party-spacer { flex: 1 1 auto; }
.ace-party-bulk {
  background: #22201a; color: #efe6cf; border: 1px solid #6b5a24;
  border-radius: 4px; padding: 4px 10px; font-size: 14px; cursor: pointer;
  display: inline-flex; align-items: center; gap: 6px; width: auto; line-height: 1.4;
}
.ace-party-bulk:hover { background: #35301f; border-color: #c9a227; box-shadow: 0 0 6px rgba(201,162,39,.4); }
.ace-party-none:hover { border-color: #a05252; box-shadow: 0 0 6px rgba(160,82,82,.4); }
.ace-party-count {
  background: #c9a227; color: #17150e; border-radius: 8px;
  padding: 0 6px; font-size: 12px; font-weight: 700;
}

.ace-party-group { margin-bottom: 8px; border: 1px solid #3a3324; border-radius: 4px; }
.ace-party-group > summary {
  cursor: pointer; padding: 6px 10px; font-size: 15px; font-weight: 600;
  color: #f0d98a; background: rgba(0,0,0,.3); list-style-position: inside;
  display: flex; align-items: center; gap: 8px;
}
/* display:flex on <summary> eats the native disclosure triangle, so draw our own. */
.ace-party-group > summary::-webkit-details-marker { display: none; }
.ace-party-group > summary::after {
  content: "\\f078"; font-family: "Font Awesome 6 Free"; font-weight: 900;
  margin-left: auto; font-size: 11px; opacity: .65;
}
.ace-party-group:not([open]) > summary::after { content: "\\f054"; }
.ace-party-list { list-style: none; margin: 0; padding: 4px; max-height: 260px; overflow-y: auto; }

.ace-party-row { border-radius: 4px; padding: 2px 4px; }
.ace-party-row:hover { background: rgba(201,162,39,.08); }
.ace-party-row.ace-party-needs { background: rgba(160,60,60,.18); outline: 1px solid #a03c3c; }
.ace-party-pick { display: flex; align-items: center; gap: 8px; cursor: pointer; padding: 3px 0; }
.ace-party-check { flex: 0 0 auto; width: 16px; height: 16px; cursor: pointer; }
.ace-party-portrait {
  width: 32px; height: 32px; object-fit: cover; border: 1px solid #6b5a24;
  border-radius: 3px; background: #000; flex: 0 0 auto;
}
.ace-party-name { flex: 1 1 auto; font-size: 15px; color: #efe6cf; }
.ace-party-hp { font-size: 13px; color: #9fb08a; font-variant-numeric: tabular-nums; }
.ace-party-chips { display: inline-flex; gap: 4px; flex-wrap: wrap; }
.ace-party-chip {
  font-size: 11px; text-transform: uppercase; letter-spacing: .04em;
  padding: 1px 5px; border-radius: 3px; background: #2b2820; color: #b9ac88; border: 1px solid #4a422c;
}
.ace-party-chip-dead { background: #3a1414; color: #e59a9a; border-color: #7a2b2b; }
.ace-party-chip-carry { background: #3a2f14; color: #e8c86a; border-color: #7a642b; }
.ace-party-chip-unlinked { background: #14262e; color: #8fc4d8; border-color: #2b5f7a; }

.ace-party-bearer {
  display: flex; align-items: center; gap: 6px;
  margin: 2px 0 6px 42px; font-size: 14px; color: #e8c86a;
}
.ace-party-bearer-select {
  background: #1a1812; color: #efe6cf; border: 1px solid #6b5a24;
  border-radius: 3px; font-size: 14px; padding: 2px 4px; flex: 1 1 auto; height: auto;
}

.ace-party-summary { margin-top: 10px; padding: 8px 10px; border-radius: 4px; font-size: 15px; }
.ace-party-summary-ok    { background: rgba(60,110,60,.22); border: 1px solid #4a7a4a; color: #b7dcb7; }
.ace-party-summary-warn  { background: rgba(110,100,50,.2); border: 1px solid #7a6b2b; color: #ddcf9a; }
.ace-party-summary-block { background: rgba(120,45,45,.25); border: 1px solid #a03c3c; color: #f0b8b8; }

/* ── The container ───────────────────────────────────────────────────────── */
.ace-party-container-app .window-content { padding: 0; background: transparent; }
.ace-party-title {
  margin: 0 0 6px; font-size: 22px; font-weight: 700; letter-spacing: .09em;
  color: #f0d98a; text-align: center; border: 0;
  text-shadow: 0 1px 2px rgba(0,0,0,.8);
}
.ace-party-from  { margin: 0 0 6px; font-size: 16px; color: #f0d98a; text-align: center; }
.ace-party-hint  { margin: 0 0 12px; font-size: 15px; color: #cdbf9a; line-height: 1.4; }
.ace-party-hint strong { color: #f0d98a; }
.ace-party-empty { text-align: center; font-size: 17px; color: #a89a75; padding: 20px 0; }
.ace-party-empty i { font-size: 34px; opacity: .5; }

/* Armed banner — the loudest thing in the panel, because a click on the map
   is about to put real creatures down. */
.ace-party-armed {
  display: flex; flex-direction: column; align-items: center; gap: 2px;
  margin: 0 0 10px; padding: 9px 12px; border-radius: 5px;
  background: linear-gradient(180deg, rgba(201,162,39,.30), rgba(201,162,39,.14));
  border: 2px solid #f0d98a; color: #fff3c9;
  font-size: 17px; font-weight: 700; letter-spacing: .04em; text-align: center;
  box-shadow: 0 0 14px rgba(240,217,138,.4);
}
.ace-party-armed i { font-size: 20px; }
.ace-party-armed strong { color: #fff; }
.ace-party-armed-sub { font-size: 13px; font-weight: 400; color: #e6d5a4; letter-spacing: .02em; }

.ace-party-grid {
  display: grid; grid-template-columns: repeat(auto-fill, minmax(112px, 1fr));
  gap: 10px; max-height: 420px; overflow-y: auto; padding: 4px;
}
.ace-party-card {
  display: flex; flex-direction: column; align-items: center; gap: 3px;
  padding: 6px 4px; border: 1px solid #4a422c; border-radius: 5px;
  background: rgba(0,0,0,.35); cursor: grab; text-align: center;
}
.ace-party-card:hover { border-color: #c9a227; background: rgba(201,162,39,.1); }
.ace-party-card.ace-party-selected {
  border-color: #f0d98a; box-shadow: 0 0 8px rgba(240,217,138,.55); background: rgba(201,162,39,.18);
}
.ace-party-card img {
  width: 78px; height: 78px; object-fit: cover; border-radius: 5px;
  border: 1px solid #6b5a24; background: #000;
}
.ace-party-card-name { font-size: 15px; color: #efe6cf; word-break: break-word; line-height: 1.25; }
.ace-party-card-carry { font-size: 12px; color: #e8c86a; }
.ace-party-card-carried { cursor: not-allowed; opacity: .8; }
.ace-party-card { position: relative; }
.ace-party-card-leader { border-color: #f0d98a; background: rgba(240,217,138,.16); }
.ace-party-leader-pip {
  position: absolute; top: 3px; right: 4px; font-size: 12px; color: #17150e;
  background: #f0d98a; border-radius: 50%; width: 18px; height: 18px;
  display: flex; align-items: center; justify-content: center;
  box-shadow: 0 0 6px rgba(240,217,138,.8);
}
.ace-party-aimhint { color: #f0d98a; }
.ace-party-aimhint strong { color: #fff3c9; }
/* Armed: the canvas cursor becomes a crosshair so it's obvious a click will place. */
#board.ace-party-aiming { cursor: crosshair !important; }

.ace-party-actions { display: flex; flex-direction: column; gap: 6px; margin-top: 12px; }
.ace-party-actions button {
  background: #22201a; color: #efe6cf; border: 1px solid #6b5a24;
  border-radius: 4px; padding: 9px 12px; font-size: 17px; cursor: pointer;
  display: flex; align-items: center; justify-content: center; gap: 8px; line-height: 1.4;
}
.ace-party-actions button:hover:not(:disabled) {
  background: #35301f; border-color: #c9a227; box-shadow: 0 0 6px rgba(201,162,39,.4);
}
.ace-party-actions button:disabled { opacity: .4; cursor: default; }
.ace-party-danger:hover:not(:disabled) { border-color: #a03c3c !important; box-shadow: 0 0 6px rgba(160,60,60,.5) !important; }

/* ── The Hand indicator ──────────────────────────────────────────────────── */
#ace-party-hand-pill {
  position: fixed; right: 16px; bottom: 96px; z-index: 70;
  display: flex; align-items: center; gap: 8px;
  padding: 7px 14px; border-radius: 18px; cursor: pointer;
  background: linear-gradient(160deg, #23200f 0%, #14120a 100%);
  border: 1px solid #c9a227; color: #f0d98a;
  font-size: 15px; font-weight: 600;
  box-shadow: 0 2px 10px rgba(0,0,0,.6), 0 0 12px rgba(201,162,39,.25);
}
#ace-party-hand-pill:hover { border-color: #f0d98a; box-shadow: 0 2px 10px rgba(0,0,0,.6), 0 0 16px rgba(240,217,138,.5); }
`;
    document.head.appendChild(style);
  }
}
