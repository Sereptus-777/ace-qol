// ─── ACE: QOL — THE GATE: the one place a press is refused ────────────────────
//
// The One Road, section 9 (frozen): "when the gate refuses, it says why in plain
// words. The GM, and only the GM, gets Do it anyway: the action continues on the
// same road with the same dice, card and damage, and the card notes ACE was
// overruled and what it thought was in the way. Every override is logged. An
// override is never learned unless you pin it. A player's refused press goes to
// you to approve. Things ACE cannot tell, such as whether a hand is free, never
// block; they go through with a note."
//
// PHASE 2 (2026-09-14). Before this, six handlers each cancelled a press on
// their own, each with its own toast: can't act, armor, the bonus-action spell
// rule, the Holy Symbol, the engagement gate and the revive lock. Nobody could
// overrule any of them, and a heal skipped the armor, bonus-action and
// engagement checks because the heal pipeline took it over before they ran.
// They are deleted. Their questions are the named rules in press-rules.mjs, and
// this file is the only place a press is refused.
//
// A refused press: the presser gets one notice in plain words, and the GMs get a
// whispered card naming each rule and why, with Do it anyway on it. The press is
// kept on the presser's client. When a GM overrules it, the card is marked
// overruled by that GM; the presser's client sees the mark, checks that a GM
// made it, and presses again, once, with a pass for exactly the rules that were
// overruled. That press carries the overrule on its usage message, and when it
// is used the refusal card says so.
//
// ⚠️ SECOND IN THE CHAIN, STRAIGHT AFTER THE READING. The One Road runs
// reading, then gate. The reading registers at init so it sees every press
// before anything may cancel it (2026-09-05); the gate registers right behind
// it, so it speaks before every other handler, all of which register at ready.
//
// ⚠️ A PASS LASTS UNTIL THE PRESS IS USED, NOT UNTIL THE NEXT PRESS. The use
// prompt and the form picker cancel a press and press it again themselves; a
// pass spent on the first of those presses would refuse the second. A pass that
// is never used (the cast dialog was closed) runs out after two minutes.
//
// ⚠️ MODULE_ID IS HARDCODED (import cycle, 2026-08-28).
// ──────────────────────────────────────────────────────────────────────────────

import { pressRules } from "./press-rules.mjs";
import { CardDoor } from "../road/doors.mjs";
import { registerChatCardHandler } from "../chat-render-utils.mjs";

const MODULE_ID = "ace-qol";
const LOG = "ace-qol | gate";
const PASS_MS = 120000;

function esc(s) { return foundry.utils.escapeHTML(String(s ?? "")); }
function gmIds() { return (game.users?.filter?.(u => u.isGM) ?? []).map(u => u.id); }
/** A reason as a sentence: some checks end theirs without a full stop, and the notice joins several. */
function sentence(s) {
  const t = String(s ?? "").trim();
  return !t || /[.!?]$/.test(t) ? t : `${t}.`;
}

/** A step that goes along with a press. One that fails is logged; it never breaks the press. */
function runStep(label, fn) {
  try {
    const out = fn();
    if (out && typeof out.catch === "function") out.catch(err => console.error(`${LOG} | ${label} failed:`, err));
  } catch (err) {
    console.error(`${LOG} | ${label} failed:`, err);
  }
}

export class PressGate {
  /** activity uuid → { rules: Set of rule ids, override, expires }: a press already answered. */
  static _passes = new Map();
  /** activity uuid → the activity, on the presser's client, while a GM decides. */
  static _pending = new Map();
  /** Refusal cards this client has already pressed again. */
  static _handled = new Set();
  /** The gate's one handler on dnd5e.preUseActivity. */
  static _pressHandler = null;

  static register() {
    PressGate._pressHandler = (activity, usageConfig, dialogConfig, messageConfig) =>
      PressGate.onPress(activity, usageConfig, dialogConfig, messageConfig);
    Hooks.on("dnd5e.preUseActivity", PressGate._pressHandler);
    Hooks.on("dnd5e.postUseActivity", (activity, usageConfig) => { PressGate.onUsed(activity, usageConfig); });
    Hooks.on("updateChatMessage", (message, changes, options, userId) => {
      PressGate._onCardUpdated(message, changes, options, userId);
    });
    registerChatCardHandler((message, html) => PressGate._decorate(message, html), "gate refusal cards");
    console.log(`${LOG} | online: every press is judged here, after the reading and before anything else may cancel it`);
  }

  /** What the rules read: the press, its item and creature, and who it is aimed at. */
  static contextFor(activity, usageConfig = {}) {
    const item = activity?.item;
    if (!item) return null;
    return { activity, item, actor: activity.actor ?? item.actor ?? null,
      targets: [...(game.user?.targets ?? [])], user: game.user ?? null, usageConfig };
  }

  /**
   * Every rule's verdict on this press, skipping the rules a pass has already
   * answered. Nothing happens here; the rules only read.
   */
  static judge(ctx, pass = null) {
    const said = [];
    for (const rule of pressRules()) {
      if (pass?.rules?.has(rule.id)) continue;
      let verdict = null;
      try { verdict = rule.test(ctx); }
      catch (err) {
        console.warn(`${LOG} | the ${rule.name} rule could not read ${ctx?.item?.name ?? "this press"}; it says nothing this time:`, err);
        continue;
      }
      if (verdict) said.push({ rule, verdict });
    }
    return said;
  }

  /** The press. False stops it here; anything else lets it go on down the road. */
  static onPress(activity, usageConfig, dialogConfig, messageConfig) {
    try {
      const ctx = PressGate.contextFor(activity, usageConfig);
      if (!ctx) return undefined;
      const pass = PressGate._passFor(activity.uuid);
      const said = PressGate.judge(ctx, pass);

      const refused = said.filter(s => s.verdict.refuse);
      if (refused.length) {
        PressGate._refuse(ctx, refused);
        return false;
      }
      const asked = said.find(s => typeof s.verdict.ask === "function");
      if (asked) {
        PressGate._ask(ctx, asked);
        return false;
      }
      for (const { rule, verdict } of said) {
        if (verdict.note) PressGate._note(ctx, rule, verdict.note);
        if (typeof verdict.onAllowed === "function") runStep(`${rule.name} on ${ctx.item.name}`, verdict.onAllowed);
      }
      if (pass?.override) PressGate._stampOverrule(messageConfig, pass.override, ctx);
    } catch (err) {
      // ⚠️ FAIL OPEN, AND SAY SO. A broken gate must not cost the table a turn.
      console.error(`${LOG} | could not judge ${activity?.item?.name ?? "a press"}; it goes ahead unjudged:`, err);
    }
    return undefined;
  }

  /* ── Refused ──────────────────────────────────────────────────────────── */

  /** One notice to the presser, and the card to the GMs. Returns the card's promise. */
  static _refuse(ctx, refused) {
    const { activity, item, actor, user } = ctx;
    const rules = refused.map(({ rule, verdict }) => ({
      id: rule.id, name: verdict.name ?? rule.name, why: sentence(verdict.refuse), data: verdict.data ?? {},
    }));
    if (activity?.uuid) PressGate._pending.set(activity.uuid, activity);
    const gate = {
      activityUuid: activity?.uuid ?? null, itemName: item.name, activityName: activity?.name || "",
      actorName: actor?.name ?? "", userId: user?.id ?? null, userName: user?.name ?? "someone",
      byGM: !!user?.isGM, rules, status: "refused", at: Date.now(),
    };
    const why = rules.map(r => r.why).join(" ");
    ui.notifications?.warn(`${item.name} was not used. ${why} `
      + (user?.isGM ? "Do it anyway is on the card in chat." : "It has gone to the GM to approve."));
    console.log(`${LOG} | refused ${item.name} for ${actor?.name ?? "nobody"}, pressed by ${gate.userName}: `
      + rules.map(r => `${r.name}: ${r.why}`).join("; "));
    return CardDoor.post({
      speaker: ChatMessage.getSpeaker?.({ actor }) ?? {},
      whisper: gmIds(),
      content: PressGate._cardHtml(gate),
      flags: { [MODULE_ID]: { type: "gateRefusal", gate } },
    }).catch(err => console.error(`${LOG} | the refusal card for ${item.name} could not be posted; the press was still refused:`, err));
  }

  /** The refusal card, in each of its three states: refused, overruled, used. */
  static _cardHtml(gate) {
    const overruled = gate.status !== "refused";
    const act = gate.activityName && gate.activityName !== gate.itemName ? `: ${esc(gate.activityName)}` : "";
    const title = overruled ? `ACE was overruled on ${esc(gate.itemName)}${act}` : `ACE stopped ${esc(gate.itemName)}${act}`;
    const rows = (gate.rules ?? []).map(r =>
      `<div style="font-size:16px;line-height:1.4;margin:4px 0;"><strong style="color:#f0c674;">${esc(r.name)}.</strong> ${esc(r.why)}</div>`).join("");
    const status = gate.status === "used" ? `Overruled by ${esc(gate.overruledByName)}, and used as pressed.`
      : gate.status === "overruled" ? `Overruled by ${esc(gate.overruledByName)}. It goes back to ${esc(gate.userName)} to go through as pressed.`
      : gate.byGM ? "Not used. Do it anyway sends it through as pressed."
      : `Not used. Waiting for the GM to approve ${esc(gate.userName)}'s press.`;
    // ⚠️ NO display IN THIS STYLE: the stylesheet hides .ace-qol-gm-only until
    // the GM's client stamps it, and an inline display would show it to players.
    const button = gate.status === "refused"
      ? `<div class="ace-qol-gm-only" style="gap:8px;flex-wrap:wrap;margin-top:10px;">
          <button type="button" data-action="aceQolGateAnyway" style="flex:1 1 auto;font-size:16px;line-height:1.3;padding:6px 12px;background:#2b2140;border:1px solid #d4af37;border-radius:4px;color:#ffd87a;font-weight:700;cursor:pointer;white-space:normal;">Do it anyway</button>
        </div>` : "";
    return `<div class="ace-qol-gate-card" style="background:#16131d;border:1px solid #6b4fa8;border-radius:6px;padding:10px 12px;color:#ece6f7;">
      <div style="font-size:18px;font-weight:700;line-height:1.3;">${title}</div>
      <div style="font-size:14px;color:#b8acd6;margin:2px 0 6px;">${esc(gate.actorName)}, pressed by ${esc(gate.userName)}</div>
      ${overruled ? `<div style="font-size:14px;color:#b8acd6;">What ACE thought was in the way:</div>` : ""}
      ${rows}
      <div style="font-size:14px;color:#cfc4ea;margin-top:6px;">${status}</div>
      ${button}
    </div>`;
  }

  /** The GM's view: the button shows and works. A player's view: it stays hidden. */
  static _decorate(message, html) {
    const gate = message?.flags?.[MODULE_ID]?.gate;
    if (message?.flags?.[MODULE_ID]?.type !== "gateRefusal" || !gate) return;
    const el = html instanceof HTMLElement ? html : html?.[0];
    if (!el?.querySelectorAll || !game.user?.isGM) return;
    for (const g of el.querySelectorAll(".ace-qol-gm-only")) g.setAttribute("data-ace-gm", "true");
    const button = el.querySelector("[data-action='aceQolGateAnyway']");
    if (!button || button.dataset.aceWired) return;
    button.dataset.aceWired = "1";
    button.addEventListener("click", async (ev) => {
      ev.preventDefault();
      button.disabled = true;
      const done = await PressGate.doItAnyway(message);
      if (!done) button.disabled = false;
    });
  }

  /* ── Do it anyway ─────────────────────────────────────────────────────── */

  /** The GM overrules the refusal on this card. True when it was overruled. */
  static async doItAnyway(message) {
    if (!game.user?.isGM) {
      ui.notifications?.warn("Only the GM can overrule ACE.");
      return false;
    }
    const gate = message?.flags?.[MODULE_ID]?.gate;
    if (!gate || gate.status !== "refused") {
      ui.notifications?.info("That press was already decided.");
      return false;
    }
    for (const r of gate.rules ?? []) {
      const rule = pressRules().find(x => x.id === r.id);
      if (typeof rule?.onOverride !== "function") continue;
      try { await rule.onOverride(r.data ?? {}); }
      catch (err) { console.error(`${LOG} | overruling ${r.name} on ${gate.itemName}: its own step failed; the press still goes back:`, err); }
    }
    const next = { ...gate, status: "overruled", overruledBy: game.user.id, overruledByName: game.user.name, overruledAt: Date.now() };
    // ⚠️ EVERY OVERRIDE IS LOGGED: here, on the card itself, and again when it is used.
    console.log(`${LOG} | OVERRULED by ${game.user.name}: ${gate.itemName} for ${gate.actorName}, pressed by ${gate.userName}. `
      + `ACE thought: ${(gate.rules ?? []).map(r => `${r.name}: ${r.why}`).join("; ")}`);
    await CardDoor.update(message, { content: PressGate._cardHtml(next), flags: { [MODULE_ID]: { gate: next } } });
    return true;
  }

  /** On the presser's client: a GM marked this press overruled, so press it again, once. */
  static _onCardUpdated(message, changes, _options, userId) {
    try {
      const changed = changes?.flags?.[MODULE_ID]?.gate;
      if (!changed || changed.status !== "overruled") return undefined;
      const gate = message?.flags?.[MODULE_ID]?.gate;
      if (!gate || gate.status !== "overruled" || gate.userId !== game.user?.id) return undefined;
      // ⚠️ THE UPDATER, NOT THE CARD. A card's flags are whatever its author
      // wrote, and the author is the presser. Foundry itself names who made
      // this update, so only a GM's mark counts.
      const by = game.users?.get?.(userId) ?? null;
      if (!by?.isGM) {
        console.warn(`${LOG} | ${gate.itemName}: marked overruled by ${by?.name ?? "an unknown user"}, who is not a GM; nothing was pressed.`);
        return undefined;
      }
      if (PressGate._handled.has(message.id)) return undefined;
      PressGate._handled.add(message.id);
      return PressGate._pressAgain(message, gate, by);
    } catch (err) {
      console.error(`${LOG} | could not act on the GM's overrule:`, err);
      return undefined;
    }
  }

  static async _pressAgain(message, gate, by) {
    const override = { by: by.id, byName: by.name, messageId: message.id,
      rules: (gate.rules ?? []).map(r => ({ id: r.id, name: r.name, why: r.why })) };
    PressGate._grant(gate.activityUuid, { rules: override.rules.map(r => r.id), override });
    const activity = PressGate._pending.get(gate.activityUuid)
      ?? await Promise.resolve(gate.activityUuid ? fromUuid(gate.activityUuid) : null).catch(() => null);
    PressGate._pending.delete(gate.activityUuid);
    console.log(`${LOG} | ${by.name} overruled ACE on ${gate.itemName}; pressing it again, once, as pressed.`);
    if (typeof activity?.use !== "function") {
      ui.notifications?.warn(`${by.name} approved ${gate.itemName}, but it could not be pressed again from here. Press it once more and it will go through.`);
      return null;
    }
    return activity.use();
  }

  /* ── Passes ───────────────────────────────────────────────────────────── */

  static _grant(uuid, { rules = [], override = null } = {}) {
    if (!uuid) return;
    const cur = PressGate._passFor(uuid);
    PressGate._passes.set(uuid, { rules: new Set([...(cur?.rules ?? []), ...rules]),
      override: override ?? cur?.override ?? null, expires: Date.now() + PASS_MS });
  }

  static _passFor(uuid) {
    const pass = uuid ? PressGate._passes.get(uuid) : null;
    if (!pass) return null;
    if (pass.expires < Date.now()) {
      PressGate._passes.delete(uuid);
      console.log(`${LOG} | a pass for ${uuid} ran out unused; this press is judged afresh.`);
      return null;
    }
    return pass;
  }

  /* ── Asked, noted, overruled, used ────────────────────────────────────── */

  /** A question for the presser (the target picker, breaking concentration). Yes presses again. */
  static _ask(ctx, { rule, verdict }) {
    const { activity, item } = ctx;
    Promise.resolve()
      .then(() => verdict.ask())
      .then(yes => {
        if (!yes) return null;
        PressGate._grant(activity.uuid, { rules: [rule.id] });
        return activity.use();
      })
      .catch(err => console.error(`${LOG} | ${rule.name} on ${item.name}: the question failed, so it was not pressed:`, err));
  }

  static _note(ctx, rule, note) {
    ui.notifications?.warn(`${ctx.item.name}: ${note}`);
    console.log(`${LOG} | ${rule.name} on ${ctx.item.name}: ${note}`);
  }

  /** The press goes through as pressed, and its usage message says who overruled ACE and what ACE thought. */
  static _stampOverrule(messageConfig, override, ctx) {
    if (!messageConfig) return;
    const data = (messageConfig.data ??= {});
    const flags = (data.flags ??= {});
    const mine = (flags[MODULE_ID] ??= {});
    mine.gateOverruled = { by: override.by, byName: override.byName, rules: override.rules };
    const line = `ACE was overruled by ${override.byName}. It thought: `
      + override.rules.map(r => `${r.name}: ${r.why}`).join(" ");
    data.flavor = [data.flavor, `<span class="ace-qol-gate-overruled">${esc(line)}</span>`].filter(Boolean).join(" ");
    console.log(`${LOG} | ${ctx.item.name} goes through as pressed, overruled by ${override.byName}.`);
  }

  /** The press was used: its pass is spent, the rules note it, and an overruled card says so. */
  static onUsed(activity, usageConfig) {
    try {
      const ctx = PressGate.contextFor(activity, usageConfig);
      if (!ctx) return null;
      const pass = PressGate._passes.get(activity.uuid) ?? null;
      PressGate._passes.delete(activity.uuid);
      for (const rule of pressRules()) {
        if (typeof rule.afterUse === "function") runStep(`${rule.name} noting ${ctx.item.name}`, () => rule.afterUse(ctx));
      }
      if (pass?.override?.messageId) return PressGate._markUsed(pass.override, ctx);
    } catch (err) {
      console.error(`${LOG} | could not close the press of ${activity?.item?.name ?? "an item"}:`, err);
    }
    return null;
  }

  static async _markUsed(override, ctx) {
    const message = game.messages?.get?.(override.messageId) ?? null;
    const gate = message?.flags?.[MODULE_ID]?.gate;
    if (!gate || gate.status !== "overruled") return null;
    const next = { ...gate, status: "used", usedAt: Date.now() };
    console.log(`${LOG} | ${ctx.item.name} was used, as ${override.byName} ruled.`);
    return CardDoor.update(message, { content: PressGate._cardHtml(next), flags: { [MODULE_ID]: { gate: next } } })
      .catch(err => console.warn(`${LOG} | the card for ${ctx.item.name} could not be marked used:`, err));
  }
}
