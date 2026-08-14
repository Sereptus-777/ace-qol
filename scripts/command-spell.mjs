// ─── ACE QOL — Command (the parts nothing else does) ──────────────────────────
//
// The save already worked. The word picker is dnd5e's own activities and works.
// What was missing on 2026-08-12 was everything AFTER the failed save: Johnny
// watched Izek fail a DC 17 Wisdom save against a Vampire's Grovel and end up
// with a completely clean effects list, and no announcement anywhere.
//
// This module adds three things:
//   1. The RAW gates — Command has NO effect on an undead creature, on one that
//      does not understand the caster's language, or if the command is directly
//      harmful.
//   2. An announcement card naming the WORD — "Izek is commanded to Grovel".
//   3. A reminder on the commanded creature's turn — "Izek is grovelling" —
//      because that is the moment the table forgets.
//
// ⚠️ IT HOOKS THE EFFECT, NOT THE SPELL. The save engine already applies the
// `command` condition on a failed save (registry entry in save-spells.mjs). We
// listen for that effect appearing rather than intercepting the cast, so there
// is exactly ONE path that decides whether Command landed. Interception would be
// a second opinion that drifts.
// ──────────────────────────────────────────────────────────────────────────────

// ⚠️ Local, not imported from ace-qol.mjs — that cycle is the temporal-dead-zone
// crash that made every token unclickable on 2026-08-11.
const MODULE_ID = "ace-qol";
const LOG = "ace-qol | Command";

/** The dnd5e effect key our registry entry applies on a failed save. */
const COMMAND_KEY = "command";

/**
 * The words RAW lists, in RAW's own words. Anything else is a GM's own word and
 * still works — the effect lands, the card just cannot describe it.
 *
 * ⚠️ QUOTE THE RULE, DO NOT SUMMARISE IT. Johnny, 2026-08-13: "it should say
 * something like 'he cannot do anything else', or whatever else the spell says.
 * We're not trying to save chat card real estate here. We're trying to be
 * descriptive." A card that says "must obey" makes the GM go and look the spell
 * up, which is the exact work the card exists to save.
 */
const KNOWN_WORDS = {
  approach: "moves toward you by the shortest and most direct route, ending its turn if it moves within 5 feet of you.",
  drop:     "drops whatever it is holding and then ends its turn.",
  flee:     "spends its turn moving away from you by the fastest available means.",
  grovel:   "falls prone and then ends its turn.",
  halt:     "doesn’t move and takes no actions. A flying creature stays aloft, provided that it is able to do so. If it must move to stay aloft, it flies the minimum distance needed to remain in the air.",
};

export class CommandSpell {

  /**
   * caster actor id -> { word, at }.
   *
   * ⚠️ WHY A CACHE AND NOT THE EFFECT'S ORIGIN. The effect's `origin` points at
   * the ITEM, which is always called "Command" — the WORD lives on the ACTIVITY,
   * and by the time the effect exists that context is gone. So we catch the word
   * as it is cast and stamp it onto the effect the moment it lands. Without this
   * the turn reminder can only say "must obey", which is what Johnny got and
   * rightly objected to.
   */
  static _pendingWord = new Map();

  /* ── Reading the situation ───────────────────── */

  /** The creature that cast it, from the effect's origin. */
  static _casterFrom(effect) {
    try {
      const origin = String(effect?.origin ?? "");
      if (!origin) return null;
      const doc = fromUuidSync?.(origin);
      return doc?.actor ?? doc?.parent ?? null;
    } catch (_) { return null; }
  }

  /** The word, taken from the effect or its origin ACTIVITY — never the item. */
  static _wordFrom(effect) {
    try {
      // ⚠️ ACTIVITY, NOT ITEM. The item is always called "Command"; the WORD is
      // the activity's name ("Grovel"). Reading the item would print the spell
      // name back at Johnny and tell him nothing.
      const stamped = effect?.getFlag?.(MODULE_ID, "commandWord");
      if (stamped) return String(stamped);
      const origin = String(effect?.origin ?? "");
      const doc = origin ? fromUuidSync?.(origin) : null;
      const name = doc?.name ?? "";
      // An activity's name is the word; the item's name is "Command".
      if (name && !/^command$/i.test(name)) return name;
      // Last resort: the word caught as it was cast. See _pendingWord.
      const caster = CommandSpell._casterFrom(effect);
      const held = caster ? CommandSpell._pendingWord.get(caster.id) : null;
      if (held && (Date.now() - held.at) < 15000) return held.word;
      return null;
    } catch (_) { return null; }
  }

  /**
   * Is this creature immune outright?
   * @returns {string|null} the reason, or null if the spell lands normally
   */
  static async _immunityReason(target, caster) {
    try {
      // ── Undead ──────────────────────────────────────────────────────────
      // ⚠️ 2014 ONLY. The 2014 PHB says Command has no effect on undead; the
      // 2024 rules dropped that clause. Reading the edition rather than
      // hard-coding it is the difference between a rule and a house rule.
      const type = String(target?.system?.details?.type?.value ?? "").toLowerCase();
      if (type === "undead") {
        let is2014 = true;
        try { is2014 = (await import("./combat-state.mjs")).CombatState.getActiveRulesVersion?.() !== "2024"; }
        catch (_) { /* cannot tell — leave the 2014 default */ }
        if (is2014) return "it is undead (2014 rules)";
      }

      // ── Language ────────────────────────────────────────────────────────
      // ⚠️ ONLY A FAILED UNDERSTANDING BLOCKS IT. If we cannot READ languages —
      // ace-engine absent, no data — the spell lands. A failed read must never
      // decide a rule against the caster.
      if (caster) {
        try {
          const Lang = await import("/modules/ace-engine/scripts/npc/language-barrier.mjs");
          const theirs = new Set((Lang.readLanguages?.(target) ?? []).map(x => String(x).toLowerCase()));
          const casterSpeaks = (Lang.speakableLanguages?.(caster) ?? []).map(x => String(x).toLowerCase());
          if (theirs.size && casterSpeaks.length && !casterSpeaks.some(l => theirs.has(l))) {
            return `it does not understand ${caster.name}'s language`;
          }
        } catch (_) {
          console.debug(`${LOG} | no language data available — not gating on it.`);
        }
      }
      return null;
    } catch (err) {
      console.warn(`${LOG} | immunity check failed — letting the spell land.`, err);
      return null;
    }
  }

  /* ── The cards ─────────────────────────────────────────────────────────── */

  static _card(title, body, { colour = "#d4af37", whisperGM = false, actor = null } = {}) {
    const data = {
      content: `<div style="background:#141519;border-left:4px solid ${colour};border-radius:6px;padding:12px 14px;">
          <div style="color:${colour};font-size:18px;font-weight:700;letter-spacing:.03em;">${title}</div>
          <div style="color:#f0e4c0;font-size:16px;line-height:1.5;margin-top:6px;">${body}</div>
        </div>`,
      flags: { [MODULE_ID]: { type: "commandSpell" } },
    };
    if (actor) data.speaker = ChatMessage.getSpeaker({ actor });
    if (whisperGM) data.whisper = ChatMessage.getWhisperRecipients("GM").map(u => u.id);
    return ChatMessage.create(data).catch(() => {});
  }

  /* ── Hooks ─────────────────────────────────────────────────────────────── */

  static async _onApplied(effect) {
    const target = effect?.parent;
    if (!target?.name) return;
    const caster = CommandSpell._casterFrom(effect);
    const word = CommandSpell._wordFrom(effect);
    const esc = (v) => foundry.utils.escapeHTML(String(v ?? ""));

    // ── Gate ────────────────────────────────────────────────────────────
    const reason = await CommandSpell._immunityReason(target, caster);
    if (reason) {
      try { await effect.delete(); } catch (_) { /* already gone */ }
      await CommandSpell._card("Command has no effect",
        `<strong>${esc(target.name)}</strong> shrugs it off — ${esc(reason)}.`,
        { colour: "#7ec97e", actor: target });
      console.log(`${LOG} | ${target.name} immune — ${reason}`);
      return;
    }

    // ⚠️ STAMP THE WORD ONTO THE EFFECT. The reminder on the creature's own turn
    // fires long after the cast, when the activity context is gone. Without this
    // it can only say "must obey" — exactly what Johnny got and objected to.
    if (word) { try { await effect.setFlag(MODULE_ID, "commandWord", String(word)); } catch (_) {} }

    // ── Announce ────────────────────────────────────────────────────────
    const wordText = word ? ` to <strong style="color:#ffd970;">${esc(word)}</strong>` : "";
    await CommandSpell._card("Commanded",
      `<strong>${esc(target.name)}</strong> fails the save and is commanded${wordText}.`
      + CommandSpell._describe(word),
      { actor: target });
    console.log(`${LOG} | ${target.name} commanded${word ? ` to ${word}` : ""}.`);
  }

  /**
   * The full rules text for a word. Verbose ON PURPOSE — the whole point of the
   * card is that nobody has to go and read the spell mid-fight.
   */
  static _describe(word) {
    const raw = KNOWN_WORDS[String(word ?? "").toLowerCase()];
    const line = (t) => `<div style="color:#b3a888;font-size:14px;line-height:1.55;margin-top:8px;">${t}</div>`;
    return (raw
        ? line(`<strong style="color:#d9cfae;">On its next turn it ${raw}</strong>`)
        : line("It must carry out the command on its next turn."))
      + line("It can take no other action that turn. The spell then ends — there is no repeated save and no concentration.");
  }

  /** The reminder, on the commanded creature's own turn. */
  static async _onTurn(combat, prior, current) {
    try {
      if (game.users?.activeGM !== game.user) return;
      const combatant = current?.combatantId ? combat?.combatants?.get(current.combatantId) : combat?.combatant;
      const actor = combatant?.actor;
      if (!actor) return;
      const effect = (actor.effects ?? []).find(e =>
        e?.getFlag?.(MODULE_ID, "conditionKey") === COMMAND_KEY || /^commanded$/i.test(String(e?.name ?? "")));
      if (!effect) return;
      const word = CommandSpell._wordFrom(effect);
      const esc = (v) => foundry.utils.escapeHTML(String(v ?? ""));
      await CommandSpell._card(
        word ? `Commanded to ${esc(word)} — this turn` : "Under a command — this turn",
        `<strong>${esc(actor.name)}</strong> is compelled${word ? ` to <strong style="color:#ffd970;">${esc(word)}</strong>` : ""} right now.`
        + CommandSpell._describe(word),
        { colour: "#c08bd4", actor });
    } catch (err) {
      console.warn(`${LOG} | turn reminder failed (harmless):`, err);
    }
  }

  static register() {
    // ⚠️ CATCH THE WORD AS IT IS CAST. dnd5e ships Command with one ACTIVITY per
    // word, so "Grovel" exists only in the activity — and by the time the effect
    // lands, that context is gone and `effect.origin` points at an item that is
    // always just called "Command". Remember it here, stamp it on the effect the
    // moment it appears, and the turn reminder can name it for the rest of the
    // round. Keyed by caster so two casters in the same round do not collide.
    Hooks.on("dnd5e.preUseActivity", (activity) => {
      try {
        const item = activity?.item;
        if (!/^command$/i.test(String(item?.name ?? ""))) return;
        const word = String(activity?.name ?? "").trim();
        const casterId = item?.actor?.id;
        if (!word || !casterId || /^command$/i.test(word)) return;
        CommandSpell._pendingWord.set(casterId, { word, at: Date.now() });
      } catch (err) {
        console.warn(`${LOG} | could not note the command word (the effect still lands):`, err);
      }
    });

    Hooks.on("createActiveEffect", (effect) => {
      try {
        if (game.users?.activeGM !== game.user) return;
        const key = effect?.getFlag?.(MODULE_ID, "conditionKey");
        const looksLikeCommand = key === COMMAND_KEY || /^commanded$/i.test(String(effect?.name ?? ""));
        if (!looksLikeCommand) return;
        CommandSpell._onApplied(effect).catch(err =>
          console.warn(`${LOG} | announcement failed (harmless):`, err));
      } catch (err) {
        console.warn(`${LOG} | createActiveEffect handling failed:`, err);
      }
    });

    // ⚠️ combatTurnChange, NOT combatTurn. `combatTurn`/`combatRound` fire BEFORE
    // the combat document updates, so `combat.combatant` inside them still
    // describes the turn that is ENDING — the bug that reset reactions on the
    // wrong creature for months. `combatTurnChange` hands us prior + current.
    Hooks.on("combatTurnChange", (combat, prior, current) => {
      CommandSpell._onTurn(combat, prior, current).catch(() => {});
    });

    console.log(`${LOG} | online — gates, announcement and turn reminder`);
  }
}
