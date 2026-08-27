// ─── ACE: QOL — Rules Watchdog ────────────────────────────────────────────────
// The surveillance layer. The profiles PHOTOGRAPH creature state; the watchdog
// INSPECTS those photographs against declared "this must always be true" rules
// and shouts when reality disagrees.
//
// WHY (Johnny's idea, 2026-07-27): every bug this week was a rules invariant
// silently being false — a petrified wizard still concentrating; a Petrified
// creature missing its Incapacitated rider (the half-applied ActorDelta
// collision); a creature "turning to stone" carrying no re-save tag (stale
// staging that later insta-petrified him); two unlinked tokens wearing the same
// display name (Grulgar). Each was found DAYS later, by Johnny, at the table.
// The watchdog makes that silence impossible: the moment an invariant breaks it
// says so, in a GM toast + a console line naming the creature and the rule.
//
// DESIGN CONTRACT
//   • READ-ONLY. It NEVER fixes anything — it reports. (An auto-fixer that
//     guesses wrong is worse than a bug you can see. Repairs stay explicit,
//     in the engines that own them.)
//   • CHEAP + EVENT-DRIVEN. Runs on turn change and on condition create/delete/
//     enable — never on a frame loop. A check is a handful of field reads.
//   • GM-ONLY, DE-DUPED. Players never see engine chatter. The same violation
//     on the same creature toasts once per encounter-ish window, never spams.
//   • FAIL-SOFT. A throwing rule is caught + logged; it can never break a turn.
//   • GROWS. Every time we touch a condition or ship a RAW rule, add its
//     invariant here — that's the Rule #1 discipline made mechanical.
//
// Public API: game.aceQol.watchdog.check(actor?) / .checkAll() / .report()
// ──────────────────────────────────────────────────────────────────────────────

import { MODULE_ID } from "./ace-qol.mjs";
import { Situation } from "./situation.mjs";

/** Statuses that RAW make a creature incapacitated (concentration-breaking). */
const INCAPACITATING = ["incapacitated", "petrified", "paralyzed", "stunned", "unconscious"];

/**
 * THE INVARIANT LIST — each entry is one RAW truth that must hold for a single
 * creature. `test(c)` receives a creature snapshot (Situation.readCreature +
 * the live actor as `c.ref`) and returns a violation message string, or null
 * when the rule holds.
 */
const INVARIANTS = [
  {
    // THE SPECTER INVARIANT (2026-08-06, ONE_GATE phase 0). A creature that is
    // dead must not be carrying an ACE effect that only exists as stage one of
    // something still resolving — a corpse mid-way through turning to stone
    // means a save pipeline ran against a target the Gate should have refused.
    // The Gate now refuses it, so this rule should never fire again; it is here
    // precisely so we FIND OUT if it does, instead of a player noticing first.
    id: "dead-with-pending-resolution",
    label: "The dead hold no pending saves",
    test: (c) => {
      const dead = c.statuses?.has?.("dead")
        || (c.ref?.type !== "character" && (Number(c.ref?.system?.attributes?.hp?.value ?? 1) || 0) <= 0);
      if (!dead) return null;
      const pending = (c.ref?.effects?.contents ?? []).filter(e =>
        !e.disabled && e.flags?.[MODULE_ID]?.repeatingSave);
      return pending.length
        ? `is DEAD but still holds ${pending.length} pending save effect(s) — "${pending[0]?.name}". A dead creature should never have reached a save.`
        : null;
    },
  },
  {
    id: "conc-while-incapacitated",
    label: "Concentration survives incapacitation",
    test: (c) => {
      if (!c.concentrating) return null;
      const s = INCAPACITATING.find(x => c.statuses?.has?.(x));
      return s ? `is ${s} but is STILL CONCENTRATING — RAW: incapacitation ends concentration` : null;
    },
  },
  {
    id: "petrified-without-incapacitated",
    label: "Petrified carries Incapacitated",
    test: (c) => (c.statuses?.has?.("petrified") && !c.statuses?.has?.("incapacitated"))
      ? "is Petrified but NOT Incapacitated — the condition landed half-applied"
      : null,
  },
  {
    id: "unconscious-without-riders",
    label: "Unconscious carries Prone + Incapacitated",
    test: (c) => {
      if (!c.statuses?.has?.("unconscious")) return null;
      const missing = ["prone", "incapacitated"].filter(s => !c.statuses.has(s));
      return missing.length ? `is Unconscious but missing ${missing.join(" + ")} — half-applied` : null;
    },
  },
  {
    id: "paralyzed-or-stunned-without-incapacitated",
    label: "Paralyzed / Stunned carry Incapacitated",
    test: (c) => {
      const s = ["paralyzed", "stunned"].find(x => c.statuses?.has?.(x));
      if (!s) return null;
      return c.statuses.has("incapacitated") ? null
        : `is ${s} but NOT Incapacitated — half-applied`;
    },
  },
  {
    id: "staged-restraint-without-tag",
    label: "A staged (turning-to-stone) restraint carries its re-save tag",
    test: (c) => {
      const staged = (c.ref?.effects?.contents ?? []).filter(e =>
        !e.disabled && /turning to stone|petrif/i.test(e.name ?? "")
        && e.statuses?.has?.("restrained"));
      if (!staged.length) return null;
      const tagged = staged.some(e => e.flags?.[MODULE_ID]?.repeatingSave?.onFailureApply === "petrified");
      return tagged ? null
        : "carries a turning-to-stone restraint with NO re-save tag — it will never progress or clear (stale staging)";
    },
  },
  {
    id: "repeating-save-without-dc",
    label: "A repeating-save tag is complete",
    test: (c) => {
      const bad = (c.ref?.effects?.contents ?? []).find(e => {
        const rs = e.flags?.[MODULE_ID]?.repeatingSave;
        return rs?.trigger && (!rs.ability || !Number.isFinite(rs.dc));
      });
      return bad ? `has an incomplete repeating-save tag on "${bad.name}" (missing ability or DC) — it can never roll` : null;
    },
  },
  {
    id: "dead-with-conditions-acting",
    label: "A dead creature isn't still taking turns",
    test: (c) => {
      if (!c.statuses?.has?.("dead")) return null;
      const combatant = game.combat?.combatants?.find(cb => cb.actor?.id === c.ref?.id);
      return (combatant && game.combat?.combatant?.id === combatant.id)
        ? "is DEAD but it is currently their turn in the tracker" : null;
    },
  },
  {
    id: "restrained-speed",
    label: "Restrained means speed 0",
    test: (c) => {
      if (!c.statuses?.has?.("restrained")) return null;
      const walk = Number(c.speeds?.walk ?? 0);
      return walk > 0 ? `is Restrained but still has ${walk} feet walk speed — RAW: restrained speed is 0` : null;
    },
  },
];

export class RulesWatchdog {

  /** violationKey → timestamp, so the same problem toasts once per window. */
  static _seen = new Map();
  static DEDUPE_MS = 5 * 60 * 1000;
  /** Every violation seen this session (for .report()). */
  static _log = [];

  static init() {
    // Turn change — the natural heartbeat. Checks the creature whose turn just
    // began plus the one whose turn ended (the two most likely to have drifted).
    Hooks.on("combatTurnChange", (combat, prior, current) => {
      try {
        if (game.users?.activeGM !== game.user) return;
        // Whole-combat sanity first — a combatant on another map explains
        // every downstream oddity and is invisible to the per-creature rules.
        RulesWatchdog.checkCombat(combat);
        for (const id of [current?.combatantId, prior?.combatantId]) {
          const actor = id ? combat?.combatants?.get(id)?.actor : null;
          if (actor) RulesWatchdog.check(actor);
        }
      } catch (_) { /* never break a turn */ }
    });

    // Catch it at the START, before a whole fight is played on bad data.
    // Also on scene change: walking to another map with a live unlinked combat
    // is the exact move that creates the problem.
    Hooks.on("combatStart", (combat) => {
      try {
        if (game.users?.activeGM !== game.user) return;
        setTimeout(() => RulesWatchdog.checkCombat(combat), 250);
      } catch (_) { /* non-fatal */ }
    });
    Hooks.on("canvasReady", () => {
      try {
        if (game.users?.activeGM !== game.user) return;
        if (!game.combat?.started) return;
        setTimeout(() => RulesWatchdog.checkCombat(game.combat), 800);
      } catch (_) { /* non-fatal */ }
    });

    // Condition churn — check the creature right after its state changes.
    const onEffect = (effect) => {
      try {
        if (game.users?.activeGM !== game.user) return;
        const actor = effect?.parent instanceof Actor ? effect.parent
          : (effect?.parent?.parent instanceof Actor ? effect.parent.parent : null);
        if (!actor) return;
        // Defer a tick: riders and cascades land in the same breath, and we want
        // the SETTLED state, not a mid-write snapshot (false alarms otherwise).
        setTimeout(() => RulesWatchdog.check(actor), 120);
      } catch (_) { /* non-fatal */ }
    };
    Hooks.on("createActiveEffect", onEffect);
    Hooks.on("deleteActiveEffect", onEffect);
    Hooks.on("updateActiveEffect", onEffect);

    // ── Toolbar button (Johnny 2026-07-27: "I want a button for it") ──
    // Sits in the left scene-controls stack under the ACE brain, same
    // <li><button class="control ui-control"> pattern ace-engine injects with,
    // so Foundry's own styling applies and the two read as one family.
    Hooks.on("renderSceneControls", () => RulesWatchdog._injectButton());
    if (ui.controls?.rendered) RulesWatchdog._injectButton();

    console.log(`${MODULE_ID} | Rules Watchdog online — ${INVARIANTS.length} invariants watched`);
  }

  static _injectButton() {
    try {
      if (!game.user?.isGM) return;
      if (document.querySelector("[data-ace-watchdog-control]")) return;   // never double-inject
      const menu =
        document.querySelector("#scene-controls-layers")           ??
        document.querySelector("#scene-controls menu:first-child") ??
        document.querySelector("#scene-controls ol")               ??
        document.querySelector("#controls .main-controls")         ??
        document.querySelector(".main-controls")                   ?? null;
      if (!menu) return;

      const li = document.createElement("li");
      li.setAttribute("data-ace-watchdog-control", "1");

      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "control ui-control";
      const tip = "ACE Rules Check — scan the scene for rules violations";
      btn.setAttribute("data-tooltip", tip);
      btn.setAttribute("aria-label", "ACE Rules Check");
      btn.title = tip;
      btn.style.cssText = "display:flex;align-items:center;justify-content:center;cursor:pointer;padding:0;width:100%;height:100%;";

      const icon = document.createElement("i");
      icon.className = "fas fa-shield-halved";
      icon.style.cssText = "font-size:26px;color:#c9a84c;pointer-events:none;display:block;";
      btn.appendChild(icon);
      li.appendChild(btn);

      btn.addEventListener("click", (ev) => {
        ev.preventDefault(); ev.stopPropagation();
        RulesWatchdog.runSceneCheck(icon);
      });

      menu.appendChild(li);
      console.debug(`${MODULE_ID} | Rules Watchdog toolbar button injected`);
    } catch (err) {
      console.warn(`${MODULE_ID} | watchdog button injection failed (non-fatal):`, err);
    }
  }

  /**
   * Button action: sweep the scene and SAY something either way — a clean scene
   * must confirm itself, not sit silent (silence is what hid every bug this
   * week). Violations bypass the toast de-dupe: an explicit check always
   * reports everything it finds, right now.
   */
  static runSceneCheck(iconEl = null) {
    try {
      RulesWatchdog._seen.clear();                     // explicit check = report everything
      const found = RulesWatchdog.checkAll();
      if (iconEl) {                                    // brief visual ack on the button
        const original = iconEl.style.color;
        iconEl.style.color = found.length ? "#ff6b6b" : "#5cf28a";
        setTimeout(() => { iconEl.style.color = original; }, 1200);
      }
      if (!found.length) {
        ui.notifications?.info("ACE Rules Check — scene clean, no violations.");
      } else {
        ui.notifications?.warn(`ACE Rules Check — ${found.length} violation${found.length === 1 ? "" : "s"} found (see console).`);
        console.warn(`${MODULE_ID} | Rules Check found ${found.length}:\n • ${found.join("\n • ")}`);
      }
      return found;
    } catch (err) {
      console.warn(`${MODULE_ID} | runSceneCheck failed:`, err);
      return [];
    }
  }

  /**
   * Check one creature against every invariant. Reports violations; fixes none.
   * @returns {string[]} violation messages found (also toasted + logged)
   */
  static check(actor) {
    const found = [];
    try {
      if (!actor?.id) return found;
      const c = Situation.readCreature(actor);
      if (!c) return found;
      c.ref = actor;

      for (const rule of INVARIANTS) {
        let msg = null;
        try { msg = rule.test(c); }
        catch (err) {
          console.warn(`${MODULE_ID} | watchdog rule "${rule.id}" threw (skipped):`, err);
          continue;
        }
        if (!msg) continue;
        found.push(`${c.name}: ${msg}`);
        RulesWatchdog._report(actor, rule, `${c.name} ${msg}`);
      }
    } catch (err) {
      console.warn(`${MODULE_ID} | watchdog check failed (non-fatal):`, err);
    }
    return found;
  }

  /**
   * COMBAT INTEGRITY — a whole-combat invariant, not a per-creature one.
   *
   * ⚠️ WHY THIS EXISTS (Johnny, 2026-08-01). A combat left running for days
   * ended up with three combatants on one scene and one on another, with the
   * combat itself UNLINKED — so it followed him from map to map. The symptom he
   * actually noticed was the turn marker "not selecting the next person any
   * more": auto-select asks the canvas for the combatant's token, the token
   * isn't on this scene, and it silently gives up. It looked like a code
   * regression for two days and was bad combat data all along.
   *
   * Everything that resolves a combatant to a token hits the same wall — save
   * prompts, condition visuals, turn-end re-saves. So this is worth shouting
   * about the moment it happens rather than the next time something looks odd.
   *
   * READS ONLY. Never deletes or repairs a combat — ending a fight is the GM's
   * call, always.
   */
  static checkCombat(combat = game.combat) {
    const found = [];
    try {
      if (!combat?.started) return found;

      const sceneIds = new Set();
      const unreachable = [];

      for (const cb of combat.combatants ?? []) {
        if (cb.sceneId) sceneIds.add(cb.sceneId);
        const onCanvas = !!canvas?.tokens?.get?.(cb.tokenId);
        const inCombatScene = combat.scene ? !!combat.scene.tokens?.get?.(cb.tokenId) : false;
        if (!onCanvas && !inCombatScene) unreachable.push(cb.name ?? "(unnamed)");
      }

      // The decisive one: a single fight cannot span two maps.
      if (sceneIds.size > 1) {
        found.push(`Combat spans ${sceneIds.size} scenes — combatants are on different maps. Turn auto-select, save prompts and condition visuals will all fail for the ones that aren't here.`);
      }

      // The one that actually breaks the turn marker.
      if (unreachable.length) {
        const names = unreachable.slice(0, 4).join(", ") + (unreachable.length > 4 ? `, +${unreachable.length - 4} more` : "");
        found.push(`${unreachable.length} combatant(s) have no token on this scene: ${names}. Their turns will not select or pan.`);
      }

      // Context, not an alarm on its own — an unlinked combat is legal Foundry,
      // it's just what lets a stale fight follow you to the next map.
      if (!combat.scene && (sceneIds.size > 1 || unreachable.length)) {
        found.push("This combat is UNLINKED (tied to no scene), which is why it followed you between maps. Ending it and rolling fresh on this scene is the clean fix.");
      }

      for (const msg of found) RulesWatchdog._reportCombat(combat, msg);
    } catch (err) {
      console.warn(`${MODULE_ID} | watchdog checkCombat failed (non-fatal):`, err);
    }
    return found;
  }

  /** Combat-level report — dedupes per combat + message, same as the creature path. */
  static _reportCombat(combat, msg) {
    try {
      const key = `combat:${combat?.id}|${msg.slice(0, 40)}`;
      const now = Date.now();
      const last = RulesWatchdog._seen.get(key) ?? 0;
      RulesWatchdog._log.push({ when: new Date(now).toLocaleTimeString(), rule: "combat-integrity", detail: msg });
      if (now - last < RulesWatchdog.DEDUPE_MS) return;
      RulesWatchdog._seen.set(key, now);
      console.warn(`${MODULE_ID} | ⚠ RULES WATCHDOG [combat-integrity] ${msg}`);
      try { ui.notifications?.warn(`ACE combat check — ${msg}`); } catch (_) { /* no UI */ }
    } catch (_) { /* never break a turn */ }
  }

  /** Sweep every token on the current scene (manual / diagnostic). */
  static checkAll() {
    const all = [];
    try {
      // Combat integrity first — it explains failures the per-creature rules
      // can't see, and a broken combat makes the rest of the sweep misleading.
      all.push(...RulesWatchdog.checkCombat());

      for (const t of canvas?.scene?.tokens ?? []) {
        if (t.actor) all.push(...RulesWatchdog.check(t.actor));
      }
      if (!all.length) console.log(`${MODULE_ID} | watchdog: scene clean — no invariant violations`);
    } catch (err) {
      console.warn(`${MODULE_ID} | watchdog checkAll failed:`, err);
    }
    return all;
  }

  /** Everything seen this session. */
  static report() {
    console.table(RulesWatchdog._log.map(l => ({ when: l.when, rule: l.rule, detail: l.detail })));
    return RulesWatchdog._log;
  }

  static _report(actor, rule, detail) {
    const key = `${actor.id}|${rule.id}`;
    const now = Date.now();
    const last = RulesWatchdog._seen.get(key) ?? 0;
    RulesWatchdog._log.push({ when: new Date(now).toLocaleTimeString(), rule: rule.id, detail });
    if (now - last < RulesWatchdog.DEDUPE_MS) return;   // already shouted recently
    RulesWatchdog._seen.set(key, now);
    console.warn(`${MODULE_ID} | ⚠ RULES WATCHDOG [${rule.id}] ${detail}`);
    try { ui.notifications?.warn(`ACE rules check — ${detail}`); } catch (_) { /* no UI */ }
  }
}
