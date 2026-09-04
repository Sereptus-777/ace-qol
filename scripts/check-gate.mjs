// ─── ACE: QOL — one door for every check and save a person clicks ────────────
//
// Johnny, 2026-09-04, after the action bar got ACE's pause and ACE's card:
// "now do the same for all things rolled right?"
//
// ⚠️🔴 THE ANSWER WAS NO, AND THE REASON IS THE POINT. The action bar had been
// fixed by editing the action bar. Clicking the same skill on the CHARACTER
// SHEET still opened dnd5e's dialog and posted dnd5e's card, because that is a
// different caller, and so did a macro, and so did a chat button. Fixing one
// caller is fixing the instance that surfaced; there are always more doors.
//
// ⚠️ SO IT HOOKS THE ROLL, NOT THE BUTTON. Every d20 test in dnd5e 5.x passes
// through `dnd5e.preRollD20TestV2` — skill checks, ability checks, saving
// throws and attacks all list "d20Test" in their hookNames. One listener there
// covers every origin that exists and every origin anyone adds later.
//
// ⚠️ WHAT IT DELIBERATELY DOES NOT TAKE:
//
//   • ATTACKS. ACE's attack pipeline already owns those end to end, with its
//     own pause, its own volley and its own card. Taking them here would be two
//     owners of one roll.
//   • AN ENGINE'S OWN ROLL. Every internal roll in the suite is made with
//     `{configure:false}` and `{create:false}` — no dialog, no card — because
//     the engine is posting its own. Something that has asked for neither is
//     not a person clicking, and must pass through untouched. That is also what
//     stops this gate re-entering itself: ACE's own re-roll is made the same way.
//   • DEATH SAVES, CONCENTRATION, HIT DICE and RECHARGE. None of them list
//     "d20Test", so none of them arrive here. They have their own shapes — a
//     death save's card carries the success and failure pips — and pretending
//     they are ordinary checks would lose that.
//
// ⚠️ A SHIFT-CLICK IS STILL A PERSON. Foundry's keybinds set `configure:false`
// to skip the dialog, and only that. The test is both flags together, so a
// hurried roll still gets a card; the pause is what is skipped, not the record.
// ──────────────────────────────────────────────────────────────────────────────

// Hardcoded rather than imported: an imported const at the top level of a module
// caught in an import cycle throws at load and takes the whole module with it.
const MODULE_ID = "ace-qol";
const LOG = "ace-qol | CheckGate";

export class CheckGate {

  static register() {
    Hooks.on("dnd5e.preRollD20TestV2", (config, dialog, message) => {
      try {
        return CheckGate._intercept(config, dialog, message);
      } catch (err) {
        // ⚠️ NEVER BLOCK A ROLL ON OUR OWN FAULT. A gate that throws must let
        // the die through, or one bad read stops the table rolling anything.
        console.error(`${LOG} | gate threw — letting dnd5e roll this itself:`, err);
        return undefined;
      }
    });
    console.debug(`${LOG} | online — every check and save a person clicks gets ACE's pause and ACE's card`);
  }

  /**
   * Which of the three shapes is this, or null when it is not ours.
   *
   * ⚠️🔴 MATCHED WITHOUT CASE, BECAUSE dnd5e SPELLS THEM BOTH WAYS. A skill
   * roll builds `["skill", "abilityCheck", "d20Test"]`, all lower camel. A
   * direct ability check or saving throw builds `[name, "d20Test"]` where the
   * name is "AbilityCheck" or "SavingThrow", capitalised. A case-sensitive
   * match therefore caught skill checks and silently ignored every ability
   * check and every saving throw in the game — the gate would have looked like
   * it worked, because the one thing anybody tests first is a skill.
   *
   * Caught by the self-test before it shipped, which is the only reason this
   * comment is not a bug report.
   */
  static _shapeOf(config) {
    const names = new Set((config?.hookNames ?? []).map(n => String(n).toLowerCase()));
    if (names.has("attack")) return null;                 // the attack pipeline owns it
    if (names.has("skill")) return { kind: "skill", key: config.skill };
    if (names.has("tool")) return null;                   // no ACE card for tools yet
    if (names.has("savingthrow")) return { kind: "save", key: config.ability };
    if (names.has("abilitycheck")) return { kind: "ability", key: config.ability };
    return null;
  }

  static _intercept(config, dialog, message) {
    const shape = CheckGate._shapeOf(config);
    if (!shape?.key) return undefined;

    // An engine rolling for itself: no dialog AND no card asked for.
    if (dialog?.configure === false && message?.create === false) return undefined;

    const actor = config?.subject;
    if (!actor?.name) return undefined;                   // not something we can card

    // ⚠️ SAY WHO TOOK IT. A roll that vanishes from dnd5e and reappears as an
    // ACE card is confusing if the console is silent about the hand-off.
    console.log(`${LOG} | taking ${actor.name}'s ${shape.kind} "${shape.key}" — ACE will prompt and card it.`);

    // Cancel dnd5e's roll and run ours. Deliberately not awaited: a preRoll hook
    // is synchronous and returning a promise would be read as truthy, which
    // would let dnd5e roll it as well and produce two of everything.
    CheckGate.run(actor, shape.kind, shape.key, { dc: Number(config?.target) })
      .catch(err => console.error(`${LOG} | ${shape.kind} "${shape.key}" failed for ${actor.name}:`, err));
    return false;
  }

  /* ── Reading what ACE already knows ──────────────────────────────────── */

  /**
   * Where dnd5e keeps the resolved advantage state.
   *
   * ⚠️ THE SYSTEM ALREADY WORKED IT OUT. `AdvantageModeField` counts every
   * source that touches these paths and resolves them to -1, 0 or 1, and the
   * passive score is computed from the same number. Deriving it again here
   * would be a second answer that disagrees with the sheet the first time
   * anything unusual applied.
   */
  static modePathFor(kind, key) {
    if (kind === "skill") return `system.skills.${key}.roll.mode`;
    if (kind === "save")  return `system.abilities.${key}.save.roll.mode`;
    return `system.abilities.${key}.check.roll.mode`;
  }

  /** ACE's answer for this roll: the mode, its modifier, and what argued for it. */
  static read(actor, kind, key) {
    const out = { mode: 0, reasons: [], modifier: null, label: key };
    try {
      if (kind === "skill") {
        const sk = actor.system?.skills?.[key];
        out.mode = Number(sk?.roll?.mode ?? 0) || 0;
        out.modifier = Number.isFinite(Number(sk?.total)) ? Number(sk.total) : null;
        out.label = `${CONFIG.DND5E?.skills?.[key]?.label ?? key} check`;
      } else if (kind === "save") {
        const ab = actor.system?.abilities?.[key];
        out.mode = Number(ab?.save?.roll?.mode ?? 0) || 0;
        out.modifier = Number.isFinite(Number(ab?.save?.value)) ? Number(ab.save.value)
                     : (Number.isFinite(Number(ab?.save)) ? Number(ab.save) : null);
        out.label = `${CONFIG.DND5E?.abilities?.[key]?.label ?? key} saving throw`;
      } else {
        const ab = actor.system?.abilities?.[key];
        out.mode = Number(ab?.check?.roll?.mode ?? 0) || 0;
        out.modifier = Number.isFinite(Number(ab?.mod)) ? Number(ab.mod) : null;
        out.label = `${CONFIG.DND5E?.abilities?.[key]?.label ?? key} check`;
      }
    } catch (_) { /* the prompt still opens, just with no suggestion */ }

    // ⚠️ NAME WHAT DID IT. "ACE suggests disadvantage" with nothing beside it
    // cannot be told apart from a bug.
    // ⚠️ AND READ THE ABILITY PATH TOO for a skill: a skill check is also an
    // ability check, so an effect on Wisdom checks reaches Perception, and
    // reading only the skill path would show a suggestion with no reason.
    const wanted = new Set([CheckGate.modePathFor(kind, key)]);
    if (kind === "skill") {
      const ability = actor.system?.skills?.[key]?.ability ?? CONFIG.DND5E?.skills?.[key]?.ability;
      if (ability) wanted.add(`system.abilities.${ability}.check.roll.mode`);
    }
    try {
      for (const e of (actor.effects ?? [])) {
        if (e.disabled) continue;
        for (const c of (e.changes ?? [])) {
          if (!wanted.has(c.key)) continue;
          const v = Number(c.value);
          if (v !== -1 && v !== 1) continue;
          out.reasons.push({ reason: `${e.name}: ${v === 1 ? "advantage" : "disadvantage"}` });
        }
      }
    } catch (_) { /* reasons are a courtesy; the mode still stands */ }
    return out;
  }

  /* ── The roll ────────────────────────────────────────────────────────── */

  /**
   * One check, save or ability roll, ACE's way: our pause, our dice, our card.
   *
   * ⚠️🔴 THE CHOICE IS FORCED, NOT REQUESTED. Passing `{advantage:true}` does
   * NOT override an effect that already imposes disadvantage — dnd5e nets the
   * two — so asking for "normal" while an effect says disadvantage would leave
   * the disadvantage standing and two of the three buttons would quietly do
   * nothing. Proven from the system source: dnd5e's own dialog does not use
   * those flags either, it writes `advantageMode` onto the roll after
   * configuration in `_finalizeRolls`. This does the same at the same moment,
   * through the documented `dnd5e.postRollConfiguration` hook.
   */
  static async run(actor, kind, key, { dc = null } = {}) {
    const fn = kind === "skill" ? "rollSkill"
             : kind === "save" ? "rollSavingThrow" : "rollAbilityCheck";
    if (typeof actor[fn] !== "function") {
      console.error(`${LOG} | Actor#${fn} is missing on this dnd5e build — nothing rolled.`);
      ui.notifications?.error(`ACE cannot roll that on this system version — see the console.`);
      return;
    }

    const read = CheckGate.read(actor, kind, key);
    const suggested = read.mode > 0 ? "advantage" : read.mode < 0 ? "disadvantage" : "normal";

    const { showCheckPrompt } = await import("./attack-prompt.mjs");
    const choice = await showCheckPrompt({
      creature: actor.name,
      checkLabel: Number.isFinite(dc) ? `${read.label} vs DC ${dc}` : read.label,
      suggested,
      reasons: read.reasons,
      modifier: read.modifier,
      isPC: actor.hasPlayerOwner === true,
    });
    if (!choice) return;                                  // cancelled — nothing rolls

    const MODE = { advantage: 1, normal: 0, disadvantage: -1 }[choice] ?? 0;

    // ⚠️ SCOPED TO THIS ACTOR AND REMOVED EITHER WAY. A listener left behind
    // would silently rewrite the next roll anybody made.
    const force = (rolls, cfg) => {
      try {
        if (cfg?.subject !== actor) return;
        for (const r of (rolls ?? [])) {
          r.options.advantageMode = MODE;
          r.configureModifiers?.();
        }
      } catch (err) {
        console.warn(`${LOG} | could not force ${choice}:`, err);
      }
    };

    let rolls = null;
    Hooks.on("dnd5e.postRollConfiguration", force);
    try {
      const { aceArmDiceWatch } = await import("./dsn-utils.mjs");
      aceArmDiceWatch();
      const cfg = kind === "skill" ? { skill: key } : { ability: key };
      if (kind === "save" && Number.isFinite(dc)) cfg.target = dc;
      // create:false so dnd5e posts nothing — ACE throws the dice and cards it.
      // These two flags are also what tells the gate above to let this through
      // rather than intercepting our own re-roll.
      rolls = await actor[fn](cfg, { configure: false }, { create: false });
    } finally {
      Hooks.off("dnd5e.postRollConfiguration", force);
    }

    const roll = (Array.isArray(rolls) ? rolls[0] : rolls) ?? null;
    console.log(`${LOG} | ${actor.name} rolled ${read.label} at ${choice}`
      + (Number.isFinite(Number(roll?.total)) ? ` = ${roll.total}` : " (no roll came back)")
      + (read.reasons.length ? ` (${read.reasons.map(r => r.reason).join("; ")})` : ""));

    // ⚠️ "CANCELLED" AND "BROKEN" MUST NOT LOOK THE SAME.
    if (!roll) {
      ui.notifications?.warn(`${actor.name}'s ${read.label} did not roll — see the console.`);
      return;
    }
    await CheckGate.postCard(actor, read, choice, roll, dc);
  }

  /* ── The card ────────────────────────────────────────────────────────── */

  /**
   * ACE's card for a check or a save.
   *
   * ⚠️ EVERY DIE IS SHOWN, INCLUDING THE ONE THAT LOST. On advantage or
   * disadvantage two d20s are rolled and one is discarded; showing only the
   * survivor hides the whole reason the pause existed. The loser is struck
   * through and dimmed and keeps its full width — a struck number squeezed into
   * a narrow column is how a 10 once read as a 1 over a 0.
   *
   * ⚠️ AND IT WAITS FOR THE DICE. Nothing else is animating this roll, so ACE
   * throws the dice itself and holds the card until they stop. A card that
   * beats its own dice is a spoiler.
   *
   * ⚠️ PUBLIC. The table needs to see a check; that is the entire point of it.
   * Foundry's core roll mode is a sticky global and must not get a vote.
   */
  static async postCard(actor, read, choice, roll, dc = null) {
    try {
      const { safeShowForRoll, awaitDiceSettle } = await import("./dsn-utils.mjs");
      safeShowForRoll(roll, `${actor.name} ${read.label}`);
      await awaitDiceSettle(undefined, { useArmed: true });

      const { DamageConstants } = await import("./damage-engine.mjs");
      const esc = foundry.utils.escapeHTML;

      const dice = [];
      for (const term of (roll.terms ?? [])) {
        if (!term.faces) continue;
        for (const r of (term.results ?? [])) {
          const dropped = r.active === false || r.discarded === true;
          const img = DamageConstants.getDiceImagePath(term.faces, r.result);
          const icon = DamageConstants.DIE_ICONS?.[term.faces] ?? "fa-dice";
          dice.push(
            `<span class="ace-qol-die" style="${dropped ? "opacity:0.45;" : ""}">`
            + `<img class="ace-qol-die-img" src="${img}" alt="d${term.faces}"`
            + ` onerror="this.style.display='none';this.nextElementSibling.style.display='inline'">`
            + `<i class="fas ${icon} ace-qol-die-fallback" style="display:none"></i>`
            + `<span class="ace-qol-die-result" style="font-size:18px;font-weight:700;`
            + `${dropped ? "text-decoration:line-through;" : ""}">${r.result}</span>`
            + `</span>`);
        }
      }

      const badge = choice === "advantage"
        ? `<span style="color:#7ee081;font-weight:700;font-size:14px;letter-spacing:0.5px;">ADVANTAGE</span>`
        : choice === "disadvantage"
        ? `<span style="color:#e08b7e;font-weight:700;font-size:14px;letter-spacing:0.5px;">DISADVANTAGE</span>`
        : "";

      // Only a save has something to pass or fail against. A check has no DC
      // until somebody sets one, and inventing a verdict for it would be a lie.
      let verdict = "";
      if (Number.isFinite(dc) && Number.isFinite(Number(roll.total))) {
        const made = Number(roll.total) >= Number(dc);
        verdict = `<span style="font-size:16px;font-weight:700;color:${made ? "#7ee081" : "#e08b7e"};">`
          + `${made ? "SUCCESS" : "FAILURE"} vs DC ${esc(String(dc))}</span>`;
      }

      const why = read.reasons.length
        ? `<div style="font-size:14px;opacity:0.85;margin-top:6px;line-height:1.35;">`
          + `${esc(read.reasons.map(r => r.reason).join(" • "))}</div>`
        : "";

      const mod = Number.isFinite(Number(read.modifier))
        ? `<span style="opacity:0.8;">${Number(read.modifier) >= 0 ? "+" : ""}${Number(read.modifier)}</span>` : "";

      await ChatMessage.create({
        speaker: ChatMessage.getSpeaker({ actor }),
        rollMode: CONST.DICE_ROLL_MODES.PUBLIC,
        // ⚠️ NO `rolls` ARRAY. The dice were thrown above; handing them to the
        // message as well makes Dice So Nice animate the same roll a second
        // time, after the card is already on screen showing the answer.
        content:
          `<div style="background:#141118;border:1px solid #c9a76b55;border-left:3px solid #c9a76b;`
          + `border-radius:4px;padding:9px 11px;color:#e8dcc3;">`
          + `<div style="font-size:18px;font-weight:700;line-height:1.3;">${esc(actor.name)}</div>`
          + `<div style="font-size:16px;margin-top:2px;display:flex;flex-wrap:wrap;gap:8px;align-items:baseline;">`
          +   `<span>${esc(read.label)} ${mod}</span>${badge}</div>`
          + `<div style="display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin-top:8px;">`
          +   dice.join("")
          +   `<span style="font-size:30px;font-weight:700;margin-left:auto;">${esc(String(roll.total ?? "?"))}</span>`
          + `</div>`
          + (verdict ? `<div style="margin-top:6px;">${verdict}</div>` : "")
          + why
          + `</div>`,
        flags: { [MODULE_ID]: { checkCard: true } },
      });
    } catch (err) {
      console.error(`${LOG} | could not post the card for ${read.label}:`, err);
      ui.notifications?.warn(`${actor.name}'s ${read.label} rolled ${roll?.total ?? "?"}, but no card could be posted.`);
    }
  }
}
